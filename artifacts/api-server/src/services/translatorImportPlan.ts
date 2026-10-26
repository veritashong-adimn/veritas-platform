// ─── 통번역사 대량등록 통합 판정·승인·실행 — VERITAS OS ─────────────────────────────
// 일반 대량등록과 Master 재구축 분석의 판정 기준을 하나로 통합한다. 실제 등록은 이 판정 결과만 사용한다.
//
// 판정 5유형: SAME(기존 동일) · UPDATE(정보 보완) · NEW(신규) · HOLD(등록 보류) · MANUAL(수동 확인)
// 원칙:
//   · 기존 Master 우선: 동일인이면 신규 생성 없이 기존 Master ID 유지(수행이력·판매·정산 연결 보존).
//   · 통합된 Master 와 동일인 → 대표 Master 로 연결. 그 외 제외 Master 와 일치 → 수동 확인(재활성화·재생성 금지).
//   · 동일인 식별: 주민·외국인등록번호(강) → 실제 이메일·휴대폰(보조). 성명 호환이 함께 필요. 이름만 같으면 자동 연결 금지.
//   · 식별정보 충돌(복수 후보·다른 이름 소유·주민번호 상이) → 수동 확인.
//   · 정보 보완은 기존 공란만 채운다(fill-only). 기존 값은 덮어쓰지 않는다(차이는 표시만).
//   · 이메일: 가짜 이메일 생성 금지. 이메일 없는 신규 → 보류. 다른 계정 사용 이메일 → 신규·보완 모두 금지(수동 확인).
//     계정 이메일 고유 제약 충돌은 사전 검증으로 걸러 전체 배치 실패를 막는다.
//   · 등록 자격(신규): 진행관리표 수행이력(이름 또는 주민번호) 또는 주민번호 보유. 미충족 → 보류.
//   · 주민번호 원문은 서버 내부 비교에만 사용(응답·로그·변경이력 미포함).
import crypto from "node:crypto";
import { sql, eq, and } from "drizzle-orm";
import {
  usersTable, translatorProfilesTable, translatorEmailsTable, translatorAliasesTable, translatorSensitiveTable,
  importBatchesTable, importRowSourcesTable,
} from "@workspace/db";
import {
  parseWorkbook, buildColumnMap, getCell, isBlankRow, normalizeName, normalizeEmail, normalizePhone, isValidEmail,
  TRANSLATOR_COLUMN_SYNONYMS,
} from "../lib/hometaxExcel";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { isLegacyPlaceholderEmail } from "../lib/mailer";
import { decrypt, encrypt } from "../lib/encrypt";
import { buildTranslatorAliasValues } from "../lib/translatorAlias";

export const PLAN_ALGO_VERSION = "tplan-v2";
const MARK_STATUS = "tplan_batch";
export type PlanCategory = "SAME" | "UPDATE" | "NEW" | "HOLD" | "MANUAL";
export const PLAN_CATEGORIES: PlanCategory[] = ["SAME", "UPDATE", "NEW", "HOLD", "MANUAL"];

export const REASON_LABEL: Record<string, string> = {
  match_rrn: "주민·외국인번호 일치", match_email: "실제 이메일 일치", match_phone: "휴대폰 일치",
  match_merged_rep: "통합된 Master → 대표 Master 연결",
  invalid_name: "성명 누락 — 동일인 판단 불가", file_duplicate: "파일 내 동일인 중복행(첫 행과 동일 판정·중복 생성 안 함)",
  not_eligible: "등록 제외(주민번호·수행이력 모두 없음)",
  history_linked_to_other_master: "수행이력이 이미 다른 기존 Master 에 연결됨 — 본인 이력 확인 필요",
  history_name_only: "주민번호 없음·수행이력 성명만 일치 — 본인 이력 확인 필요(자동 확정 안 함)",
  rrn_name_mismatch: "주민번호 일치·성명 상이(개명·표기 확인)", multi_candidate: "동일인 후보 복수",
  excluded_identity: "통합·제외 Master 와 식별정보 일치(재활성화·재생성 금지)",
  rrn_conflict_same_name: "동명 Master 와 주민번호 상이", id_owned_by_other: "식별정보를 다른 이름의 Master 가 보유",
  same_name_alive: "동명 기존 Master 존재·식별정보 미일치", same_name_excluded: "통합·제외 Master 와 동명",
  history_rrn_mismatch: "수행이력 주민번호와 불일치", email_in_use: "이메일이 다른 계정에서 사용 중",
  rrn_in_use: "주민번호가 다른 계정에 등록됨",
  new_rrn: "신규 등록 가능(A: 주민번호 보유)", new_history: "신규 등록 가능(B: 진행관리표 본인 수행이력 확인)",
};

interface ProfileLite {
  phone: string | null; region: string | null; languagePairs: string | null; profileWorkTypes: string | null; specializations: string | null;
  education: string | null; major: string | null; graduationYear: number | null; grade: string | null; bio: string | null;
}
interface MasterLite { id: number; name: string; email: string; alive: boolean; active: boolean; profile: ProfileLite | null; rrn: string | null }
export interface FieldChange { field: string; label: string; before: string | null; after: string | null }
export interface Candidate { id: number; name: string; alive: boolean; basis: string; viaMergedId?: number }

export interface PlanRow {
  rowNumber: number; name: string;
  category: PlanCategory; reasonCode: string; reason: string;
  masterId: number | null; masterName: string | null; viaMergedId: number | null;
  fills: FieldChange[]; diffs: FieldChange[];
  candidates: Candidate[];
  allowNew: boolean; allowLinkIds: number[];
  eligibility: { history: boolean; rrn: boolean };
  email: string; phone: string; hasRrn: boolean;
  firstRowOfDuplicate?: number;
  basis: string[];                 // 인원별 판정 근거(사람이 읽는 문장)
  personKey: string;               // 수동 판정 보존 키(성명·식별정보 HMAC — 원문 미보관)
  allowOwnHistory: boolean;        // '다른 사람 + 본인 수행이력 확인' 으로 신규 재판정 가능
  rrnConflictIds: number[];        // 주민번호가 서로 다른 후보(연결 금지)
  creatable: boolean;              // 실제 계정 생성 가능 여부(신규) — 이메일 없음은 제외 사유가 아니지만 현재 DB 구조상 생성 불가
}

interface ExcelRow {
  rowNumber: number; name: string; nameNorm: string; email: string; emailRaw: string; phone: string; phoneRaw: string; rrn: string | null;
  englishName: string; region: string; languages: string; services: string; specializations: string;
  education: string; major: string; graduationYear: string; grade: string; availabilityStatus: string; bio: string;
}

function rrn13(s: string | null | undefined): string | null { const d = String(s ?? "").replace(/\D/g, ""); return d.length === 13 ? d : null; }
function gradYear(s: string | null | undefined): number | null {
  const m = String(s ?? "").match(/\d{4}/); if (!m) return null;
  const n = Number(m[0]); return n >= 1900 && n <= 2100 ? n : null;
}
const blank = (v: unknown) => v == null || String(v).trim() === "";

// 수동 판정 보존 키 — 성명·주민번호·이메일·휴대폰의 HMAC(원문 미보관). 식별정보가 바뀌면 새 사람으로 보고 다시 확인.
const PERSON_KEY_SECRET = process.env.SENSITIVE_ENCRYPT_KEY ?? "dev-fallback-key-change-in-prod-!!";
function personKeyOf(r: { nameNorm: string; rrn: string | null; email: string; phone: string }): string {
  return crypto.createHmac("sha256", PERSON_KEY_SECRET).update(`${r.nameNorm}|${r.rrn ?? ""}|${r.email}|${r.phone}`).digest("hex").slice(0, 32);
}

export function parseTranslatorExcel(buffer: Buffer): ExcelRow[] {
  const parsed = parseWorkbook(buffer, TRANSLATOR_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, TRANSLATOR_COLUMN_SYNONYMS);
  const out: ExcelRow[] = [];
  parsed.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const cell = (k: string) => normalizeName(getCell(raw, colMap, k));
    const name = cell("name");
    const emailRaw = cell("email");
    out.push({
      rowNumber: parsed.headerRowIndex + 2 + i, name, nameNorm: normalizeCompanyName(name),
      emailRaw, email: isLegacyPlaceholderEmail(emailRaw) ? "" : normalizeEmail(emailRaw),
      phoneRaw: cell("phone"), phone: normalizePhone(getCell(raw, colMap, "phone")), rrn: rrn13(cell("residentNumber")),
      englishName: cell("englishName"), region: cell("region"), languages: cell("languages"), services: cell("services"),
      specializations: cell("specializations"), education: cell("education"), major: cell("major"),
      graduationYear: cell("graduationYear"), grade: cell("grade"), availabilityStatus: cell("availabilityStatus"),
      bio: (getCell(raw, colMap, "bio") ?? "").toString().trim(),
    });
  });
  return out;
}

// ─── 기준 데이터 색인(읽기 전용) ─────────────────────────────────────────────────
interface Index {
  masters: Map<number, MasterLite>;
  nameIdx: Map<string, Set<number>>;        // 정규화 성명/별칭 → 통번역사 id(유효+제외)
  rrnIdx: Map<string, Set<number>>;         // 주민번호 → 통번역사 id(유효+제외)
  emailIdx: Map<string, Set<number>>;       // 실제 이메일 → 통번역사 id(users.email + translator_emails)
  phoneIdx: Map<string, Set<number>>;       // 휴대폰 → 통번역사 id
  anyEmailOwner: Map<string, number>;       // 전체 계정(역할·삭제 무관) 이메일 사용 수 — 고유 제약 사전검증
  anyRrnOwner: Set<string>;                 // translator_sensitive 전체 주민번호
  repOf: Map<number, number>;               // 통합(merged) → 대표
  progNames: Set<string>; progRrn: Set<string>; progNameToRrns: Map<string, Set<string>>;
  progNameMapped: Map<string, Set<number>>;  // 진행관리표 수행자명 → 이미 연결된 Master(legacy_master_mappings)
}
const add = (m: Map<string, Set<number>>, k: string | null | undefined, id: number) => { if (!k) return; const s = m.get(k) ?? new Set<number>(); s.add(id); m.set(k, s); };

async function loadIndex(dbx: any): Promise<Index> {
  const us = (await dbx.execute(sql`SELECT id, name, email, deleted_at IS NULL AS alive, is_active AS active FROM users WHERE role = 'translator'`)).rows as any[];
  const masters = new Map<number, MasterLite>();
  for (const u of us) masters.set(Number(u.id), { id: Number(u.id), name: u.name ?? "", email: u.email ?? "", alive: !!u.alive, active: !!u.active, profile: null, rrn: null });
  const prof = await dbx.select({
    userId: translatorProfilesTable.userId, phone: translatorProfilesTable.phone, region: translatorProfilesTable.region, languagePairs: translatorProfilesTable.languagePairs,
    profileWorkTypes: translatorProfilesTable.profileWorkTypes, specializations: translatorProfilesTable.specializations, education: translatorProfilesTable.education,
    major: translatorProfilesTable.major, graduationYear: translatorProfilesTable.graduationYear, grade: translatorProfilesTable.grade, bio: translatorProfilesTable.bio,
  }).from(translatorProfilesTable);
  const idx: Index = { masters, nameIdx: new Map(), rrnIdx: new Map(), emailIdx: new Map(), phoneIdx: new Map(), anyEmailOwner: new Map(), anyRrnOwner: new Set(), repOf: new Map(), progNames: new Set(), progRrn: new Set(), progNameToRrns: new Map(), progNameMapped: new Map() };
  for (const p of prof) { const m = masters.get(p.userId); if (m) { m.profile = p as ProfileLite; add(idx.phoneIdx, normalizePhone(p.phone), m.id); } }
  for (const m of masters.values()) {
    add(idx.nameIdx, normalizeCompanyName(m.name), m.id);
    if (m.email && !isLegacyPlaceholderEmail(m.email)) add(idx.emailIdx, normalizeEmail(m.email), m.id);
  }
  const al = await dbx.select({ id: translatorAliasesTable.translatorId, n: translatorAliasesTable.normalizedAlias }).from(translatorAliasesTable);
  for (const a of al) if (masters.has(a.id)) add(idx.nameIdx, a.n, a.id);
  const te = await dbx.select({ id: translatorEmailsTable.translatorId, e: translatorEmailsTable.email }).from(translatorEmailsTable);
  for (const t of te) {
    const e = normalizeEmail(t.e); if (!e) continue;
    if (masters.has(t.id) && !isLegacyPlaceholderEmail(t.e)) add(idx.emailIdx, e, t.id);
  }
  // 계정 이메일 고유성(users 전체 — 역할·삭제 무관) + translator_emails 전체
  const allEmails = (await dbx.execute(sql`SELECT lower(btrim(email)) AS e FROM users UNION ALL SELECT lower(btrim(email)) FROM translator_emails`)).rows as any[];
  for (const r of allEmails) if (r.e) idx.anyEmailOwner.set(r.e, (idx.anyEmailOwner.get(r.e) ?? 0) + 1);
  const sens = await dbx.select({ id: translatorSensitiveTable.translatorId, rn: translatorSensitiveTable.residentNumber }).from(translatorSensitiveTable);
  for (const s of sens) {
    if (!s.rn) continue;
    let k: string | null = null; try { k = rrn13(decrypt(String(s.rn))); } catch { k = null; }
    if (!k) continue;
    idx.anyRrnOwner.add(k);
    const m = masters.get(s.id); if (m) { add(idx.rrnIdx, k, m.id); if (!m.rrn) m.rrn = k; }
  }
  const mg = (await dbx.execute(sql`SELECT merged_master_id AS m, representative_master_id AS r FROM translator_merges WHERE status = 'active'`)).rows as any[];
  for (const r of mg) idx.repOf.set(Number(r.m), Number(r.r));
  const prog = (await dbx.execute(sql`
    SELECT nullif(btrim(source_raw->>'통번역사명'),'') AS nm, substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) AS rrn
    FROM legacy_archive_rows WHERE source_type = 'progress' AND is_effective = true`)).rows as any[];
  for (const r of prog) {
    const nn = r.nm ? normalizeCompanyName(String(r.nm)) : "";
    const rr = r.rrn && String(r.rrn).length === 13 ? String(r.rrn) : "";
    if (nn) idx.progNames.add(nn);
    if (rr) idx.progRrn.add(rr);
    if (nn && rr) { const s = idx.progNameToRrns.get(nn) ?? new Set<string>(); s.add(rr); idx.progNameToRrns.set(nn, s); }
  }
  const lm = (await dbx.execute(sql`SELECT btrim(legacy_id) AS nm, entity_id AS id FROM legacy_master_mappings WHERE entity_type = 'translator' AND status <> 'rolled_back'`)).rows as any[];
  for (const r of lm) add(idx.progNameMapped, normalizeCompanyName(String(r.nm ?? "")), Number(r.id));
  return idx;
}

// 통합 체인을 따라 살아 있는 대표 Master 로 해석(없으면 null).
function resolveAlive(idx: Index, id: number): { id: number; via: number | null } | null {
  const m = idx.masters.get(id);
  if (m?.alive) return { id, via: null };
  let cur = id;
  for (let i = 0; i < 5; i++) {
    const r = idx.repOf.get(cur); if (r == null) return null;
    if (idx.masters.get(r)?.alive) return { id: r, via: id };
    cur = r;
  }
  return null;
}

const FIELD_DEFS: { field: keyof ProfileLite | "email"; label: string; excel: (r: ExcelRow) => string; db: (m: MasterLite) => string | null; cmp?: (s: string) => string }[] = [
  { field: "email", label: "이메일", excel: r => r.email, db: m => (m.email && !isLegacyPlaceholderEmail(m.email) ? m.email : null), cmp: s => normalizeEmail(s) },
  { field: "phone", label: "휴대폰", excel: r => r.phoneRaw, db: m => m.profile?.phone ?? null, cmp: s => normalizePhone(s) },
  { field: "languagePairs", label: "언어", excel: r => r.languages, db: m => m.profile?.languagePairs ?? null },
  { field: "profileWorkTypes", label: "가능서비스", excel: r => r.services, db: m => m.profile?.profileWorkTypes ?? null },
  { field: "specializations", label: "전문분야", excel: r => r.specializations, db: m => m.profile?.specializations ?? null },
  { field: "grade", label: "인력등급", excel: r => r.grade, db: m => m.profile?.grade ?? null },
  { field: "region", label: "활동지역", excel: r => r.region, db: m => m.profile?.region ?? null },
  { field: "education", label: "학력", excel: r => r.education, db: m => m.profile?.education ?? null },
  { field: "major", label: "전공", excel: r => r.major, db: m => m.profile?.major ?? null },
  { field: "graduationYear", label: "졸업년도", excel: r => (gradYear(r.graduationYear) != null ? String(gradYear(r.graduationYear)) : ""), db: m => (m.profile?.graduationYear != null ? String(m.profile.graduationYear) : null) },
  { field: "bio", label: "상세정보", excel: r => r.bio, db: m => m.profile?.bio ?? null },
];

// 기존 Master 대비 보완(fill: 기존 공란 + 엑셀 값)·차이(diff: 기존 값 유지) 계산.
function diffAgainst(idx: Index, m: MasterLite, r: ExcelRow): { fills: FieldChange[]; diffs: FieldChange[] } {
  const fills: FieldChange[] = [], diffs: FieldChange[] = [];
  for (const d of FIELD_DEFS) {
    const ex = (d.excel(r) ?? "").trim();
    if (!ex) continue;                                  // 엑셀 공란 → 기존 보존
    const cur = d.db(m);
    const cmp = d.cmp ?? ((s: string) => s.trim());
    if (!blank(cur) && cmp(String(cur)) === cmp(ex)) continue;
    if (d.field === "email" && idx.emailIdx.get(normalizeEmail(ex))?.has(m.id)) continue;   // 이미 이 Master 의 보조 이메일
    if (blank(cur) && d.field !== "email" && !m.profile) { diffs.push({ field: d.field, label: `${d.label}(프로필 없음·보완 안 함)`, before: null, after: ex }); continue; }
    if (blank(cur)) {
      // 이메일·휴대폰 보완은 다른 계정·Master 가 쓰지 않을 때만(자동 덮어쓰기·중복 방지).
      if (d.field === "email" && ((idx.anyEmailOwner.get(normalizeEmail(ex)) ?? 0) > 0 || !isValidEmail(ex))) { diffs.push({ field: d.field, label: `${d.label}(다른 계정 사용·보완 안 함)`, before: cur ?? null, after: ex }); continue; }
      if (d.field === "phone" && [...(idx.phoneIdx.get(normalizePhone(ex)) ?? [])].some(id => id !== m.id)) { diffs.push({ field: d.field, label: `${d.label}(다른 Master 사용·보완 안 함)`, before: cur ?? null, after: ex }); continue; }
      fills.push({ field: d.field, label: d.label, before: cur ?? null, after: ex });
    } else {
      diffs.push({ field: d.field, label: d.label, before: String(cur), after: ex });
    }
  }
  return { fills, diffs };
}

export interface ImportPlan {
  fileHash: string; fingerprint: string; planToken: string; rows: PlanRow[];
  counts: Record<PlanCategory, number>; byReason: Record<string, number>;
  totals: { rows: number; reconciled: boolean; aliveMastersBefore: number; excludedMasters: number; expectedNew: number; expectedUpdate: number; expectedAliveAfter: number; newWithoutEmail: number; duplicateRows: number; persons: number };
  checks: { newRowsMatchingExisting: number; newRowsEmailCollision: number; newRowsRrnCollision: number; newDuplicateEmailInBatch: number };
}

async function fingerprint(dbx: any): Promise<string> {
  const r = (await dbx.execute(sql`SELECT
    (SELECT md5(coalesce(string_agg(id||':'||coalesce(email,'')||':'||coalesce(name,'')||':'||coalesce(deleted_at::text,'')||':'||is_active, ',' ORDER BY id),'')) FROM users WHERE role='translator') u,
    (SELECT count(*)||':'||coalesce(max(id),0) FROM users) ua,
    (SELECT md5(coalesce(string_agg(user_id||':'||coalesce(updated_at::text,''), ',' ORDER BY user_id),'')) FROM translator_profiles) p,
    (SELECT count(*)||':'||coalesce(max(id),0) FROM translator_sensitive) s,
    (SELECT count(*)||':'||coalesce(max(id),0) FROM translator_emails) e,
    (SELECT count(*)||':'||coalesce(max(id),0) FROM translator_aliases) a,
    (SELECT md5(coalesce(string_agg(id||':'||status, ',' ORDER BY id),'')) FROM translator_merges) m,
    (SELECT count(*)||':'||coalesce(max(id),0) FROM legacy_master_mappings) l`)).rows[0] as any;
  return [r.u, r.ua, r.p, r.s, r.e, r.a, r.m, r.l].join("|");
}

export async function buildImportPlan(dbx: any, buffer: Buffer): Promise<ImportPlan> {
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const excel = parseTranslatorExcel(buffer);
  const idx = await loadIndex(dbx);
  const fp = await fingerprint(dbx);
  const rows: PlanRow[] = [];
  const seenKey = new Map<string, number>();

  for (const r of excel) {
    const base: PlanRow = {
      rowNumber: r.rowNumber, name: r.name, category: "HOLD", reasonCode: "", reason: "", masterId: null, masterName: null, viaMergedId: null,
      fills: [], diffs: [], candidates: [], allowNew: false, allowLinkIds: [],
      eligibility: { history: (!!r.rrn && idx.progRrn.has(r.rrn)) || idx.progNames.has(r.nameNorm), rrn: !!r.rrn },
      email: r.email, phone: r.phone, hasRrn: !!r.rrn, basis: [], creatable: false,
      personKey: personKeyOf(r), allowOwnHistory: false, rrnConflictIds: [],
    };
    // 판정 근거 문장(식별정보 보유·수행이력·이메일 상태 공통)
    const histByRrn = !!r.rrn && idx.progRrn.has(r.rrn);
    const histByName = idx.progNames.has(r.nameNorm);
    base.basis.push(`식별정보: 주민번호 ${r.rrn ? "있음" : "없음"} · 이메일 ${r.email ? "있음" : r.emailRaw ? "임시/형식오류" : "없음"} · 휴대폰 ${r.phone ? "있음" : "없음"}`);
    base.basis.push(`진행관리표 수행이력: ${histByRrn ? "주민번호로 확인" : histByName ? "성명으로 확인" : "없음"}`);
    const set = (category: PlanCategory, code: string, extra: Partial<PlanRow> = {}, why?: string) => {
      rows.push({ ...base, basis: why ? [...base.basis, why] : base.basis, category, reasonCode: code, reason: REASON_LABEL[code] ?? code, ...extra });
    };
    if (!r.name) { set("MANUAL", "invalid_name"); continue; }
    // 파일 내 동일인 중복행(강·보조 식별자 기준) — 첫 행과 같은 판정, 중복 생성·중복 보완 없음.
    const idKey = r.rrn ? `r:${r.rrn}` : r.email ? `e:${r.email}` : r.phone ? `p:${r.phone}` : "";
    if (idKey && seenKey.has(idKey)) {
      const first = rows.find(x => x.rowNumber === seenKey.get(idKey))!;
      rows.push({ ...first, rowNumber: r.rowNumber, name: r.name, firstRowOfDuplicate: first.rowNumber, fills: [], allowNew: false, allowLinkIds: [], creatable: false,
        reason: `${first.reason} · ${REASON_LABEL.file_duplicate}`, basis: [...first.basis, `파일 내 ${first.rowNumber}행과 같은 ${idKey.startsWith("r:") ? "주민번호" : idKey.startsWith("e:") ? "이메일" : "휴대폰"} → 같은 사람(1회만 처리)`] });
      continue;
    }
    if (idKey) seenKey.set(idKey, r.rowNumber);

    const nameIds = idx.nameIdx.get(r.nameNorm) ?? new Set<number>();
    const nameCompat = (id: number) => nameIds.has(id);
    const cand = (id: number, basis: string): Candidate => { const m = idx.masters.get(id)!; return { id, name: m.name, alive: m.alive, basis }; };
    const match = (targetId: number, code: string, via: number | null) => {
      const m = idx.masters.get(targetId)!;
      const { fills, diffs } = diffAgainst(idx, m, r);
      set(fills.length ? "UPDATE" : "SAME", via != null ? "match_merged_rep" : code, { masterId: targetId, masterName: m.name, viaMergedId: via, fills, diffs },
        `기존 Master #${targetId}(${m.name})와 동일인 — ${REASON_LABEL[code]}${via != null ? `(통합된 #${via} 경유)` : ""} · 성명 호환${fills.length ? ` · 공란 보완 ${fills.map(f => f.label).join("·")}` : " · 보완할 공란 없음"}${diffs.length ? ` · 기존 값 유지 ${diffs.length}개 항목` : ""}`);
    };
    // 수동 확인 후보로 연결 가능한 살아 있는 Master
    const manual = (code: string, cands: Candidate[], allowNew = false, allowOwnHistory = false) => {
      const resolvedIds = [...new Set(cands.map(c => resolveAlive(idx, c.id)?.id).filter((x): x is number => x != null))];
      // 주민번호가 서로 다른 후보로는 연결 금지(자동·수동 통합 모두 차단)
      const rrnConflictIds = r.rrn ? resolvedIds.filter(id => idx.masters.get(id)?.rrn && idx.masters.get(id)!.rrn !== r.rrn) : [];
      const linkIds = resolvedIds.filter(id => !rrnConflictIds.includes(id));
      set("MANUAL", code, { candidates: cands, allowLinkIds: linkIds, allowNew, allowOwnHistory, rrnConflictIds },
        `${REASON_LABEL[code] ?? code}${cands.length ? ` — 후보 ${cands.slice(0, 4).map(c => `#${c.id}${c.alive ? "" : "(제외)"}`).join(", ")}` : ""} → 자동 연결·등록 안 함`);
    };

    // ① 강한 식별: 주민·외국인번호
    const rrnOwners = r.rrn ? [...(idx.rrnIdx.get(r.rrn) ?? [])] : [];
    if (rrnOwners.length) {
      const resolved = rrnOwners.map(id => ({ id, res: resolveAlive(idx, id) }));
      const aliveTargets = [...new Set(resolved.filter(x => x.res).map(x => x.res!.id))];
      const unresolved = resolved.filter(x => !x.res).map(x => x.id);
      if (aliveTargets.length === 1 && unresolved.length === 0) {
        const t = aliveTargets[0];
        const via = resolved.find(x => x.res?.id === t && x.res.via != null)?.res?.via ?? null;
        const compat = nameCompat(t) || (via != null && nameCompat(via));
        if (compat) { match(t, "match_rrn", via); continue; }
        manual("rrn_name_mismatch", rrnOwners.map(id => cand(id, "rrn"))); continue;
      }
      if (aliveTargets.length > 1) { manual("multi_candidate", rrnOwners.map(id => cand(id, "rrn"))); continue; }
      manual("excluded_identity", rrnOwners.map(id => cand(id, "rrn"))); continue;
    }

    // ② 동명 Master 의 주민번호와 상이 → 충돌
    if (r.rrn && [...nameIds].some(id => idx.masters.get(id)?.alive && idx.masters.get(id)?.rrn && idx.masters.get(id)!.rrn !== r.rrn)) {
      manual("rrn_conflict_same_name", [...nameIds].map(id => cand(id, "name"))); continue;
    }

    // ③ 보조 식별: 실제 이메일·휴대폰
    const owners = new Map<number, Set<string>>();
    for (const id of (r.email ? idx.emailIdx.get(r.email) ?? [] : [])) { const s = owners.get(id) ?? new Set(); s.add("email"); owners.set(id, s); }
    for (const id of (r.phone ? idx.phoneIdx.get(r.phone) ?? [] : [])) { const s = owners.get(id) ?? new Set(); s.add("phone"); owners.set(id, s); }
    const compatOwners = [...owners.keys()].filter(nameCompat);
    const otherOwners = [...owners.keys()].filter(id => !nameCompat(id));
    const compatResolved = compatOwners.map(id => ({ id, res: resolveAlive(idx, id) }));
    const aliveCompat = [...new Set(compatResolved.filter(x => x.res).map(x => x.res!.id))];
    if (aliveCompat.length === 1 && otherOwners.length === 0) {
      const t = aliveCompat[0];
      const m = idx.masters.get(t)!;
      if (r.rrn && m.rrn && m.rrn !== r.rrn) { manual("rrn_conflict_same_name", [cand(t, "email/phone")]); continue; }
      const via = compatResolved.find(x => x.res?.id === t && x.res.via != null)?.res?.via ?? null;
      const basis = [...(owners.get(via ?? t) ?? owners.get(t) ?? [])][0] ?? "email";
      match(t, basis === "phone" ? "match_phone" : "match_email", via); continue;
    }
    if (aliveCompat.length > 1) { manual("multi_candidate", compatOwners.map(id => cand(id, [...owners.get(id)!].join("/")))); continue; }
    if (otherOwners.length) { manual("id_owned_by_other", [...owners.keys()].map(id => cand(id, [...owners.get(id)!].join("/")))); continue; }
    if (compatOwners.length) { manual("excluded_identity", compatOwners.map(id => cand(id, [...owners.get(id)!].join("/")))); continue; }

    // ④ 신규 판단 준비 — 등록 자격(A 주민번호 | B 본인 수행이력)·이메일 상태(제외 사유 아님)
    const emailState = !r.email ? "none" : !isValidEmail(r.email) ? "invalid" : (idx.anyEmailOwner.get(r.email) ?? 0) > 0 ? "in_use" : "ok";
    const progRrns = idx.progNameToRrns.get(r.nameNorm);
    const historyMismatch = !histByRrn && histByName && !!r.rrn && !!progRrns && progRrns.size > 0 && !progRrns.has(r.rrn);
    const mappedMasters = [...(idx.progNameMapped.get(r.nameNorm) ?? [])].filter(id => idx.masters.has(id));
    const eligible = !!r.rrn || histByRrn;            // 자동 자격: A(주민번호). B(본인 수행이력)는 성명만 일치 시 관리자 확인 필요
    const nameOnlyHistory = !r.rrn && histByName;
    const rrnFree = !r.rrn || !idx.anyRrnOwner.has(r.rrn);
    const creatable = emailState === "ok";      // 계정 이메일 필수(NOT NULL·UNIQUE) 구조 — 가짜 이메일 생성 금지
    const newPossible = eligible && rrnFree && !historyMismatch && creatable;
    const ownHistoryPossible = nameOnlyHistory && creatable;   // 관리자가 본인 이력 확인 시 신규 가능

    // ⑤ 이름만 일치 → 자동 연결·자동 신규 모두 금지(동일인 수동 확인)
    const aliveNamesakes = [...nameIds].filter(id => idx.masters.get(id)?.alive);
    const excludedNamesakes = [...nameIds].filter(id => !idx.masters.get(id)?.alive);
    if (aliveNamesakes.length) { manual("same_name_alive", [...nameIds].map(id => cand(id, "name")), newPossible, ownHistoryPossible); continue; }
    if (excludedNamesakes.length) { manual("same_name_excluded", excludedNamesakes.map(id => cand(id, "name"))); continue; }

    // ⑥ 기존 Master 에 없는 사람 → 등록 자격 판단
    if (!r.rrn && mappedMasters.length) { manual("history_linked_to_other_master", mappedMasters.map(id => cand(id, "history")), false, false); continue; }
    if (nameOnlyHistory) { manual("history_name_only", [], false, ownHistoryPossible); continue; }
    if (!eligible) { set("HOLD", "not_eligible", {}, "기존 Master 없음 · 주민번호 없음 · 진행관리표 수행이력 없음 → 등록 제외"); continue; }
    if (historyMismatch) { manual("history_rrn_mismatch", []); continue; }
    if (!rrnFree) { manual("rrn_in_use", []); continue; }
    if (emailState === "in_use") { manual("email_in_use", []); continue; }
    const code = histByRrn && !r.rrn ? "new_history" : "new_rrn";
    set("NEW", code, { allowNew: creatable, creatable },
      `기존 Master(유효·통합·제외) 동명·식별정보 일치 없음 → ${REASON_LABEL[code]}${creatable ? "" : ` · 이메일 ${emailState === "invalid" ? "형식 오류" : "없음"}: 제외 사유 아님(가짜 이메일 미생성) — 현재 계정 이메일 필수 구조라 생성 보류`}`);
  }

  const counts = { SAME: 0, UPDATE: 0, NEW: 0, HOLD: 0, MANUAL: 0 } as Record<PlanCategory, number>;
  const byReason: Record<string, number> = {};
  for (const p of rows) { counts[p.category]++; byReason[`${p.category}:${p.reasonCode}`] = (byReason[`${p.category}:${p.reasonCode}`] ?? 0) + 1; }
  const newRows = rows.filter(p => p.category === "NEW" && !p.firstRowOfDuplicate);
  const newEmails = new Map<string, number>(); for (const p of newRows) if (p.creatable) newEmails.set(p.email, (newEmails.get(p.email) ?? 0) + 1);
  const aliveBefore = [...idx.masters.values()].filter(m => m.alive).length;
  const updMasters = new Set(rows.filter(p => p.category === "UPDATE").map(p => p.masterId));
  return {
    fileHash, fingerprint: fp, planToken: crypto.createHash("sha256").update(`${PLAN_ALGO_VERSION}|${fileHash}|${fp}`).digest("hex").slice(0, 32),
    rows, counts, byReason,
    totals: { rows: rows.length, reconciled: Object.values(counts).reduce((a, b) => a + b, 0) === rows.length, aliveMastersBefore: aliveBefore, excludedMasters: idx.masters.size - aliveBefore,
      expectedNew: newRows.filter(p => p.creatable).length, expectedUpdate: updMasters.size, expectedAliveAfter: aliveBefore + newRows.filter(p => p.creatable).length,
      newWithoutEmail: newRows.filter(p => !p.creatable && !p.firstRowOfDuplicate).length, duplicateRows: rows.filter(p => p.firstRowOfDuplicate).length,
      persons: rows.filter(p => !p.firstRowOfDuplicate).length },
    checks: {
      newRowsMatchingExisting: newRows.filter(p => (idx.nameIdx.get(normalizeCompanyName(p.name))?.size ?? 0) > 0).length,
      newRowsEmailCollision: newRows.filter(p => p.creatable && (idx.anyEmailOwner.get(p.email) ?? 0) > 0).length,
      newRowsRrnCollision: 0,
      newDuplicateEmailInBatch: [...newEmails.values()].filter(n => n > 1).length,
    },
  };
}

// ─── 미리보기 페이지 ─────────────────────────────────────────────────────────────
export function planSummary(p: ImportPlan) {
  const personCounts = { SAME: 0, UPDATE: 0, NEW: 0, HOLD: 0, MANUAL: 0 } as Record<PlanCategory, number>;
  const byReasonPersons: Record<string, number> = {};
  for (const r of p.rows) if (!r.firstRowOfDuplicate) { personCounts[r.category]++; byReasonPersons[`${r.category}:${r.reasonCode}`] = (byReasonPersons[`${r.category}:${r.reasonCode}`] ?? 0) + 1; }
  return { planToken: p.planToken, algorithm: PLAN_ALGO_VERSION, counts: p.counts, personCounts, byReason: byReasonPersons, byReasonRows: p.byReason, totals: p.totals, checks: p.checks };
}
export function planPage(p: ImportPlan, cat: PlanCategory | "ALL", page: number, pageSize: number, q?: string) {
  const size = Math.min(200, Math.max(10, pageSize || 50));
  const term = (q ?? "").trim().toLowerCase();
  const list = p.rows.filter(r => (cat === "ALL" || r.category === cat) && (!term || r.name.toLowerCase().includes(term) || String(r.masterId ?? "").includes(term) || String(r.rowNumber) === term));
  const pg = Math.max(1, page || 1);
  return { cat, page: pg, pageSize: size, total: list.length, rows: list.slice((pg - 1) * size, pg * size) };
}

// ─── 실행(대표 승인 후) ─────────────────────────────────────────────────────────
// 신규 재판정 금지 사유(제외 Master 와 식별정보 일치·다른 계정 식별정보·주민번호 충돌 등)
const NO_NEW_CODES = new Set(["excluded_identity", "same_name_excluded", "id_owned_by_other", "rrn_name_mismatch", "rrn_conflict_same_name", "multi_candidate", "email_in_use", "rrn_in_use", "history_rrn_mismatch", "invalid_name"]);

export class PlanError extends Error {
  code: string; status: number;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; }
}
// 관리자 수동 판정: 기존 ID 연결 | 다른 사람(자격 재판정) | 다른 사람 + 본인 수행이력 확인 | 보류
export type ManualDecision = "hold" | "new" | "different" | "different_own_history" | `link:${number}`;

export async function executeImportPlan(dbx: any, opts: {
  buffer: Buffer; fileName: string; snapshotId: string; planToken: string; decisions: Record<string, ManualDecision>; performerId: number | null;
}) {
  const plan = await buildImportPlan(dbx, opts.buffer);
  if (!opts.planToken || opts.planToken !== plan.planToken) throw new PlanError("PLAN_CHANGED", 409, "미리보기 이후 Master 자료가 바뀌었거나 승인 토큰이 일치하지 않습니다. 미리보기를 다시 실행해 확인한 뒤 승인하세요.");
  const idx = await loadIndex(dbx);
  const excelByRow = new Map(parseTranslatorExcel(opts.buffer).map(r => [r.rowNumber, r]));
  const saved = await loadSavedDecisions(dbx);

  // 최종 대상 확정: 자동(NEW·UPDATE) + 수동 승인분. 승인하지 않은 수동 확인·보류 행은 등록하지 않는다.
  type Act = { kind: "new" | "update"; row: PlanRow; masterId?: number; fills?: FieldChange[]; source: "auto" | "manual" };
  const acts: Act[] = [];
  let manualApproved = 0, manualHeld = 0;
  for (const p of plan.rows) {
    if (p.category === "NEW") { if (p.creatable && !p.firstRowOfDuplicate) acts.push({ kind: "new", row: p, source: "auto" }); continue; }
    if (p.category === "UPDATE" && !p.firstRowOfDuplicate) { acts.push({ kind: "update", row: p, masterId: p.masterId!, fills: p.fills, source: "auto" }); continue; }
    if (p.category !== "MANUAL" || p.firstRowOfDuplicate) continue;
    const d = opts.decisions[String(p.rowNumber)] ?? saved.get(p.personKey)?.decision ?? "hold";
    // 다른 사람 → 신규 자격 재판정: A(주민번호) 이거나 관리자가 본인 수행이력을 확인한 경우만 신규. 이메일·주민번호 고유성 필수.
    const ex0 = excelByRow.get(p.rowNumber)!;
    const createOk = !!ex0.email && isValidEmail(ex0.email) && (idx.anyEmailOwner.get(ex0.email) ?? 0) === 0 && (!ex0.rrn || !idx.anyRrnOwner.has(ex0.rrn));
    if ((d === "new" || d === "different") && createOk && (p.allowNew || !!ex0.rrn) && !NO_NEW_CODES.has(p.reasonCode)) { acts.push({ kind: "new", row: p, source: "manual" }); manualApproved++; continue; }
    if (d === "different_own_history" && createOk && (p.allowOwnHistory || p.allowNew) && !NO_NEW_CODES.has(p.reasonCode)) { acts.push({ kind: "new", row: p, source: "manual" }); manualApproved++; continue; }
    if (typeof d === "string" && d.startsWith("link:")) {
      const id = Number(d.slice(5));
      if (p.allowLinkIds.includes(id) && idx.masters.get(id)?.alive) {
        const { fills } = diffAgainst(idx, idx.masters.get(id)!, excelByRow.get(p.rowNumber)!);
        if (fills.length) acts.push({ kind: "update", row: p, masterId: id, fills, source: "manual" });
        manualApproved++; continue;
      }
    }
    manualHeld++;
  }

  // 사전 검증 — 계정 이메일·주민번호 고유성(배치 내부 포함). 충돌 시 전체 중단(부분 저장 없음).
  const batchEmails = new Set<string>(), batchRrn = new Set<string>();
  for (const a of acts.filter(a => a.kind === "new")) {
    const ex = excelByRow.get(a.row.rowNumber)!;
    if (!ex.email || (idx.anyEmailOwner.get(ex.email) ?? 0) > 0 || batchEmails.has(ex.email)) throw new PlanError("EMAIL_CONFLICT", 409, `행 ${a.row.rowNumber}: 이메일 중복·누락 — 실행을 중단했습니다(변경 없음).`);
    batchEmails.add(ex.email);
    if (ex.rrn) { if (idx.anyRrnOwner.has(ex.rrn) || batchRrn.has(ex.rrn)) throw new PlanError("RRN_CONFLICT", 409, `행 ${a.row.rowNumber}: 주민번호 중복 — 실행을 중단했습니다(변경 없음).`); batchRrn.add(ex.rrn); }
  }
  const emailFills = new Set<string>();
  for (const a of acts.filter(a => a.kind === "update")) for (const f of a.fills!) if (f.field === "email") {
    const e = normalizeEmail(f.after ?? "");
    if ((idx.anyEmailOwner.get(e) ?? 0) > 0 || batchEmails.has(e) || emailFills.has(e)) throw new PlanError("EMAIL_CONFLICT", 409, `행 ${a.row.rowNumber}: 보완 이메일 중복 — 실행을 중단했습니다(변경 없음).`);
    emailFills.add(e);
  }

  const aliveBefore = Number(((await dbx.execute(sql`SELECT count(*)::int n FROM users WHERE role='translator' AND deleted_at IS NULL`)).rows[0] as any).n);
  const excludedFpBefore = ((await dbx.execute(sql`SELECT md5(coalesce(string_agg(u.id||':'||coalesce(u.email,'')||':'||u.deleted_at||':'||u.is_active||':'||coalesce(p.updated_at::text,''), ',' ORDER BY u.id),'')) h FROM users u LEFT JOIN translator_profiles p ON p.user_id=u.id WHERE u.role='translator' AND u.deleted_at IS NOT NULL`)).rows[0] as any).h;
  if (acts.length === 0) {
    return { mode: "no_change", batchId: null, created: 0, updated: 0, manualApproved, manualHeld, counts: plan.counts, aliveBefore, aliveAfter: aliveBefore };
  }

  const [batch] = await dbx.insert(importBatchesTable).values({
    module: "translator", importType: "import_plan", originalFilename: opts.fileName || null, sheetName: null,
    totalRows: plan.rows.length, successRows: 0, warningRows: 0, errorRows: 0, skippedRows: plan.rows.length - acts.length,
    status: "analyzed", createdBy: opts.performerId, sourceSystem: "crm_translator_list", fileHash: plan.fileHash, isCurrent: false,
  }).returning({ id: importBatchesTable.id });
  const logs: any[] = [{ batchId: batch.id, module: "translator", entityId: null, sourceFile: opts.fileName || null, rowKey: "batch", status: MARK_STATUS,
    sourceRaw: { algorithm: PLAN_ALGO_VERSION, snapshotId: opts.snapshotId, planToken: plan.planToken, counts: plan.counts, manualApproved, manualHeld } }];

  // 신규 Master 생성(실제 이메일만, 주민번호는 암호문)
  let created = 0;
  for (const a of acts.filter(a => a.kind === "new")) {
    const ex = excelByRow.get(a.row.rowNumber)!;
    const [u] = await dbx.insert(usersTable).values({ email: ex.email, password: null, name: ex.name, role: "translator", isActive: true }).returning({ id: usersTable.id });
    await dbx.insert(translatorProfilesTable).values({
      userId: u.id, phone: ex.phoneRaw || null, region: ex.region || null, languagePairs: ex.languages || null, profileWorkTypes: ex.services || null,
      specializations: ex.specializations || null, education: ex.education || null, major: ex.major || null, graduationYear: gradYear(ex.graduationYear),
      grade: ex.grade || null, availabilityStatus: ex.availabilityStatus || "available", bio: ex.bio || null,
    });
    await dbx.insert(translatorEmailsTable).values({ translatorId: u.id, email: ex.email, isPrimary: true });
    const aliases = [buildTranslatorAliasValues(u.id, ex.name, true)];
    if (ex.englishName) aliases.push(buildTranslatorAliasValues(u.id, ex.englishName, false));
    await dbx.insert(translatorAliasesTable).values(aliases.filter(x => x.normalizedAlias)).onConflictDoNothing();
    if (ex.rrn) await dbx.insert(translatorSensitiveTable).values({ translatorId: u.id, residentNumber: encrypt(ex.rrn) });
    logs.push({ batchId: batch.id, module: "translator", entityId: u.id, sourceFile: opts.fileName || null, sourceRow: a.row.rowNumber, rowKey: `new:${u.id}`, status: "new",
      sourceRaw: { rowNumber: a.row.rowNumber, source: a.source, reasonCode: a.row.reasonCode, rrnStored: !!ex.rrn } });
    created++;
  }

  // 정보 보완(기존 공란만). 같은 Master 를 여러 행이 가리키면 먼저 채운 값 우선.
  let updated = 0;
  const filledByMaster = new Map<number, Set<string>>();
  for (const a of acts.filter(a => a.kind === "update")) {
    const m = idx.masters.get(a.masterId!)!;
    if (!m.alive) throw new PlanError("TARGET_NOT_ALIVE", 409, `Master #${a.masterId} 는 유효하지 않습니다.`);
    const done = filledByMaster.get(m.id) ?? new Set<string>();
    const applied: FieldChange[] = [];
    const profUpd: Record<string, unknown> = {};
    for (const f of a.fills!) {
      if (done.has(f.field)) continue;
      if (f.field === "email") {
        const e = normalizeEmail(f.after!);
        const r1 = await dbx.update(usersTable).set({ email: e }).where(and(eq(usersTable.id, m.id), sql`(${usersTable.email} = ${m.email})`)).returning({ id: usersTable.id });
        if (r1.length !== 1) throw new PlanError("TARGET_CHANGED", 409, `Master #${m.id} 이메일이 미리보기 이후 바뀌었습니다.`);
        await dbx.insert(translatorEmailsTable).values({ translatorId: m.id, email: e, isPrimary: false }).onConflictDoNothing();
        applied.push({ ...f, before: m.email || null, after: e });
      } else {
        profUpd[f.field] = f.field === "graduationYear" ? Number(f.after) : f.after;
        applied.push(f);
      }
      done.add(f.field);
    }
    if (Object.keys(profUpd).length) {
      // 기존 공란 조건을 SQL 로 재확인(미리보기 이후 값이 생겼으면 덮어쓰지 않음)
      const conds = Object.keys(profUpd).map(k => sql`(${sql.raw(`"${k.replace(/[A-Z]/g, c => "_" + c.toLowerCase())}"`)} IS NULL OR btrim(${sql.raw(`"${k.replace(/[A-Z]/g, c => "_" + c.toLowerCase())}"`)}::text) = '')`);
      const r2 = await dbx.update(translatorProfilesTable).set({ ...profUpd, updatedAt: new Date() })
        .where(and(eq(translatorProfilesTable.userId, m.id), ...conds)).returning({ id: translatorProfilesTable.id });
      if (r2.length !== 1) throw new PlanError("TARGET_CHANGED", 409, `Master #${m.id} 정보가 미리보기 이후 바뀌었습니다.`);
    }
    filledByMaster.set(m.id, done);
    if (applied.length) {
      updated++;
      logs.push({ batchId: batch.id, module: "translator", entityId: m.id, sourceFile: opts.fileName || null, sourceRow: a.row.rowNumber, rowKey: `update:${m.id}:${a.row.rowNumber}`, status: "update",
        sourceRaw: { rowNumber: a.row.rowNumber, source: a.source, fields: applied } });
    }
  }
  for (let i = 0; i < logs.length; i += 500) await dbx.insert(importRowSourcesTable).values(logs.slice(i, i + 500));
  await dbx.update(importBatchesTable).set({ status: "completed", successRows: created + updated }).where(eq(importBatchesTable.id, batch.id));

  // 사후 검증: Master 수 = 이전 + 신규, 제외 Master 불변
  const aliveAfter = Number(((await dbx.execute(sql`SELECT count(*)::int n FROM users WHERE role='translator' AND deleted_at IS NULL`)).rows[0] as any).n);
  if (aliveAfter !== aliveBefore + created) throw new Error(`Master 수 검증 실패: ${aliveBefore}+${created} ≠ ${aliveAfter}. 롤백합니다.`);
  const excludedFpAfter = ((await dbx.execute(sql`SELECT md5(coalesce(string_agg(u.id||':'||coalesce(u.email,'')||':'||u.deleted_at||':'||u.is_active||':'||coalesce(p.updated_at::text,''), ',' ORDER BY u.id),'')) h FROM users u LEFT JOIN translator_profiles p ON p.user_id=u.id WHERE u.role='translator' AND u.deleted_at IS NOT NULL`)).rows[0] as any).h;
  if (excludedFpAfter !== excludedFpBefore) throw new Error("통합·제외 Master 변경 감지. 롤백합니다.");
  return { mode: "applied", batchId: batch.id, created, updated, manualApproved, manualHeld, counts: plan.counts, aliveBefore, aliveAfter };
}

// ─── 배치 되돌리기 ──────────────────────────────────────────────────────────────
// · 신규: 이후 연결(수행·정산·작업·매핑·통합·서류·단가)이 없을 때만 소프트 삭제(deleted_at) — 행 삭제 없음.
// · 보완: 현재 값이 이 배치가 넣은 값 그대로일 때만 이전 값(공란)으로 복원. 이후 바뀐 값은 보존.
export async function planImportRollback(dbx: any, batchId: number) {
  const [b] = await dbx.select().from(importBatchesTable).where(eq(importBatchesTable.id, batchId)).limit(1);
  const res = { ok: false, reason: "", batchId, createdTotal: 0, createdRollbackable: 0, createdKept: [] as { id: number; reason: string }[], updatedRows: 0, fieldsRestorable: 0, fieldsKept: 0 };
  if (!b || b.module !== "translator") return { ...res, reason: "통번역사 등록 배치가 아닙니다." };
  if (b.status === "rolled_back") return { ...res, reason: "이미 되돌린 배치입니다." };
  const mark = (await dbx.execute(sql`SELECT count(*)::int n FROM import_row_sources WHERE batch_id = ${batchId} AND status = ${MARK_STATUS}`)).rows[0] as any;
  if (!mark.n) return { ...res, reason: "통합 승인 경로로 등록된 배치만 되돌릴 수 있습니다." };
  const logs = (await dbx.execute(sql`SELECT entity_id, status, source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND status IN ('new','update')`)).rows as any[];
  const created = logs.filter(l => l.status === "new").map(l => Number(l.entity_id));
  for (const id of created) {
    const dep = (await dbx.execute(sql`SELECT
      (SELECT count(*) FROM performance_assignments WHERE individual_user_id = ${id}) + (SELECT count(*) FROM tasks WHERE translator_id = ${id}) +
      (SELECT count(*) FROM settlements WHERE translator_id = ${id}) + (SELECT count(*) FROM legacy_master_mappings WHERE entity_type='translator' AND entity_id = ${id}) +
      (SELECT count(*) FROM translator_merges WHERE merged_master_id = ${id} OR representative_master_id = ${id}) + (SELECT count(*) FROM translator_documents WHERE translator_id = ${id}) +
      (SELECT count(*) FROM translator_rates WHERE translator_id = ${id}) + (SELECT count(*) FROM payout_round_items WHERE payee_id = ${id}) AS n,
      (SELECT deleted_at IS NOT NULL FROM users WHERE id = ${id}) AS del`)).rows[0] as any;
    if (dep.del) res.createdKept.push({ id, reason: "이미 삭제·통합됨" });
    else if (Number(dep.n) > 0) res.createdKept.push({ id, reason: "이후 수행·정산·매핑 등 연결 발생 — 보존" });
    else res.createdRollbackable++;
  }
  res.createdTotal = created.length;
  for (const l of logs.filter(l => l.status === "update")) {
    res.updatedRows++;
    for (const f of (l.source_raw?.fields ?? [])) {
      const cur = await currentValue(dbx, Number(l.entity_id), f.field);
      if (cur === (f.after ?? null)) res.fieldsRestorable++; else res.fieldsKept++;
    }
  }
  return { ...res, ok: true, reason: res.createdKept.length || res.fieldsKept ? "되돌리기 가능(이후 변경·연결된 항목은 보존)" : "되돌리기 가능" };
}

async function currentValue(dbx: any, userId: number, field: string): Promise<string | null> {
  if (field === "email") return ((await dbx.execute(sql`SELECT email FROM users WHERE id = ${userId}`)).rows[0] as any)?.email ?? null;
  const col = field.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
  const v = ((await dbx.execute(sql`SELECT ${sql.raw(`"${col}"`)}::text AS v FROM translator_profiles WHERE user_id = ${userId}`)).rows[0] as any)?.v ?? null;
  return v;
}

export async function executeImportRollback(dbx: any, batchId: number, performerId: number | null) {
  const plan = await planImportRollback(dbx, batchId);
  if (!plan.ok) throw new PlanError("ROLLBACK_NOT_ALLOWED", 409, plan.reason);
  const keep = new Set(plan.createdKept.map(k => k.id));
  const logs = (await dbx.execute(sql`SELECT entity_id, status, source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND status IN ('new','update') ORDER BY id DESC`)).rows as any[];
  let softDeleted = 0, restored = 0, kept = 0;
  for (const l of logs) {
    const id = Number(l.entity_id);
    if (l.status === "new") {
      if (keep.has(id)) continue;
      const r = await dbx.update(usersTable).set({ deletedAt: new Date(), isActive: false }).where(and(eq(usersTable.id, id), sql`${usersTable.deletedAt} IS NULL`)).returning({ id: usersTable.id });
      softDeleted += r.length;
      continue;
    }
    for (const f of (l.source_raw?.fields ?? [])) {
      const cur = await currentValue(dbx, id, f.field);
      if (cur !== (f.after ?? null)) { kept++; continue; }
      if (f.field === "email") {
        await dbx.update(usersTable).set({ email: f.before }).where(eq(usersTable.id, id));
        await dbx.execute(sql`DELETE FROM translator_emails WHERE translator_id = ${id} AND lower(email) = lower(${f.after}) AND is_primary = false`);
      } else {
        const col = f.field.replace(/[A-Z]/g, (c: string) => "_" + c.toLowerCase());
        await dbx.execute(sql`UPDATE translator_profiles SET ${sql.raw(`"${col}"`)} = NULL, updated_at = now() WHERE user_id = ${id}`);
      }
      restored++;
    }
  }
  await dbx.update(importBatchesTable).set({ status: "rolled_back" }).where(eq(importBatchesTable.id, batchId));
  await dbx.insert(importRowSourcesTable).values({ batchId, module: "translator", entityId: null, rowKey: "rollback", status: "rolled_back",
    sourceRaw: { performerId, softDeleted, restored, kept, createdKept: plan.createdKept, at: new Date().toISOString() } });
  return { ...plan, softDeleted, restored, kept };
}

export async function listImportBatches(dbx: any) {
  return (await dbx.execute(sql`
    SELECT b.id, b.original_filename, b.total_rows, b.success_rows, b.status, b.created_at,
      (SELECT count(*)::int FROM import_row_sources s WHERE s.batch_id = b.id AND s.status = 'new') AS created,
      (SELECT count(*)::int FROM import_row_sources s WHERE s.batch_id = b.id AND s.status = 'update') AS updated
    FROM import_batches b WHERE b.module = 'translator' AND EXISTS (SELECT 1 FROM import_row_sources s WHERE s.batch_id = b.id AND s.status = ${MARK_STATUS})
    ORDER BY b.id DESC LIMIT 30`)).rows;
}

// ─── 동일인 수동 확인: 판정 보존(감사로그) · 비교 상세 ─────────────────────────────
// 판정은 import_batches(module='translator_review') 원장 아래 import_row_sources 로 누적 기록한다(DB 구조 변경 없음).
//   · 같은 사람(personKey)의 최신 판정이 재분석·새 파일 업로드 시에도 자동 적용된다(실행 시 다시 검증).
//   · 기록 항목: 판정·대상 Master·사유 메모·엑셀 행·스냅샷·처리자·시각. 주민번호·이메일 원문 미기록.
const REVIEW_MODULE = "translator_review";
export interface SavedDecision { decision: ManualDecision; candidateId: number | null; at: string; performerId: number | null; note: string | null }

export async function loadSavedDecisions(dbx: any): Promise<Map<string, SavedDecision>> {
  const rows = (await dbx.execute(sql`
    SELECT s.row_key, s.source_raw FROM import_row_sources s JOIN import_batches b ON b.id = s.batch_id
    WHERE b.module = ${REVIEW_MODULE} AND s.status = 'review_decision' ORDER BY s.id ASC`)).rows as any[];
  const m = new Map<string, SavedDecision>();
  for (const r of rows) { const k = String(r.row_key ?? "").replace(/^pk:/, ""); if (k && r.source_raw?.decision) m.set(k, r.source_raw as SavedDecision); }
  return m;
}

export async function saveReviewDecision(dbx: any, opts: { plan: ImportPlan; rowNumber: number; decision: ManualDecision; note?: string | null; snapshotId: string; performerId: number | null }) {
  const row = opts.plan.rows.find(r => r.rowNumber === opts.rowNumber);
  if (!row || row.category !== "MANUAL" || row.firstRowOfDuplicate) throw new PlanError("NOT_MANUAL", 400, "동일인 수동 확인 대상 행이 아닙니다.");
  let candidateId: number | null = null;
  if (opts.decision.startsWith("link:")) {
    candidateId = Number(opts.decision.slice(5));
    if (row.rrnConflictIds.includes(candidateId)) throw new PlanError("RRN_CONFLICT", 409, "주민번호가 서로 다른 Master 와는 연결할 수 없습니다.");
    if (!row.allowLinkIds.includes(candidateId)) throw new PlanError("INVALID_CANDIDATE", 400, "연결 가능한 후보 Master 가 아닙니다.");
  } else if (!["hold", "different", "different_own_history"].includes(opts.decision)) {
    throw new PlanError("INVALID_DECISION", 400, "판정 값이 올바르지 않습니다.");
  }
  if (opts.decision === "different_own_history" && !row.allowOwnHistory) throw new PlanError("OWN_HISTORY_NOT_ALLOWED", 400, "본인 수행이력 확인으로 신규 판정할 수 없는 행입니다(주민번호·이메일·이력 조건 확인).");
  let ledger = ((await dbx.execute(sql`SELECT id FROM import_batches WHERE module = ${REVIEW_MODULE} ORDER BY id DESC LIMIT 1`)).rows[0] as any)?.id as number | undefined;
  if (!ledger) {
    const [b] = await dbx.insert(importBatchesTable).values({ module: REVIEW_MODULE, importType: "manual_review", originalFilename: null, totalRows: 0, successRows: 0, status: "open", createdBy: opts.performerId, sourceSystem: "crm_translator_list", isCurrent: false }).returning({ id: importBatchesTable.id });
    ledger = b.id;
  }
  const rec: SavedDecision & Record<string, unknown> = { decision: opts.decision, candidateId, at: new Date().toISOString(), performerId: opts.performerId, note: opts.note?.slice(0, 500) ?? null,
    rowNumber: row.rowNumber, snapshotId: opts.snapshotId, reasonCode: row.reasonCode, name: row.name, candidates: row.candidates.map(c => c.id) };
  await dbx.insert(importRowSourcesTable).values({ batchId: ledger, module: REVIEW_MODULE, entityId: candidateId, sourceRow: row.rowNumber, rowKey: `pk:${row.personKey}`, status: "review_decision", sourceRaw: rec });
  return rec;
}

// 한 사람(행)과 후보 Master 의 비교 상세 — 업로드 자료 / 기존 Master 등록정보 / 수행이력 / 통합·제외 관계 / 판정 근거·충돌.
export async function buildReviewDetail(dbx: any, buffer: Buffer, plan: ImportPlan, rowNumber: number) {
  const row = plan.rows.find(r => r.rowNumber === rowNumber);
  if (!row) throw new PlanError("ROW_NOT_FOUND", 404, "해당 행이 없습니다.");
  const ex = parseTranslatorExcel(buffer).find(r => r.rowNumber === rowNumber)!;
  const idx = await loadIndex(dbx);
  const saved = (await loadSavedDecisions(dbx)).get(row.personKey) ?? null;
  // 업로드 성명 기준 진행관리표 수행이력(성명 일치 — 본인 여부는 관리자 확인)
  const histByName = ((await dbx.execute(sql`
    SELECT count(*)::int n, min(record_date)::text first, max(record_date)::text last, count(DISTINCT company_name)::int companies,
      count(*) FILTER (WHERE nullif(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g'),'') IS NOT NULL)::int with_rrn
    FROM legacy_archive_rows WHERE source_type = 'progress' AND is_effective AND btrim(translator_name) = btrim(${ex.name})`)).rows[0]) as any;
  const histByRrn = ex.rrn ? Number(((await dbx.execute(sql`
    SELECT count(*)::int n FROM legacy_archive_rows WHERE source_type = 'progress' AND is_effective
      AND substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) = ${ex.rrn}`)).rows[0] as any).n) : 0;
  const ids = [...new Set([...row.candidates.map(c => c.id), ...(row.masterId ? [row.masterId] : [])])];
  const candidates = [];
  for (const id of ids) {
    const m = idx.masters.get(id); if (!m) continue;
    const rep = resolveAlive(idx, id);
    const mergedFrom = [...idx.repOf.entries()].filter(([, r]) => r === id).map(([mm]) => mm);
    const mapped = (await dbx.execute(sql`SELECT btrim(legacy_id) nm FROM legacy_master_mappings WHERE entity_type='translator' AND status <> 'rolled_back' AND entity_id = ${id}`)).rows as any[];
    const hist = mapped.length ? ((await dbx.execute(sql`
      SELECT count(*)::int n, min(record_date)::text first, max(record_date)::text last FROM legacy_archive_rows
      WHERE source_type = 'progress' AND is_effective AND btrim(translator_name) = ANY(${sql.raw(`ARRAY[${mapped.map(x => `'${String(x.nm).replace(/'/g, "''")}'`).join(",")}]::text[]`)})`)).rows[0] as any) : { n: 0, first: null, last: null };
    const conflicts: string[] = [], agreements: string[] = [];
    if (ex.rrn && m.rrn) (ex.rrn === m.rrn ? agreements : conflicts).push(ex.rrn === m.rrn ? "주민번호 일치" : "주민번호 불일치(자동·수동 통합 금지)");
    else if (ex.rrn && !m.rrn) agreements.push("Master 주민번호 미등록(비교 불가)");
    const mEmail = m.email && !isLegacyPlaceholderEmail(m.email) ? m.email : "";
    if (ex.email && mEmail) (normalizeEmail(mEmail) === ex.email || idx.emailIdx.get(ex.email)?.has(id) ? agreements : conflicts).push(normalizeEmail(mEmail) === ex.email || idx.emailIdx.get(ex.email)?.has(id) ? "이메일 일치" : "이메일 상이");
    const mPhone = normalizePhone(m.profile?.phone ?? "");
    if (ex.phone && mPhone) (mPhone === ex.phone ? agreements : conflicts).push(mPhone === ex.phone ? "휴대폰 일치" : "휴대폰 상이");
    if ((idx.nameIdx.get(ex.nameNorm) ?? new Set()).has(id)) agreements.push("성명(별칭 포함) 일치"); else conflicts.push("성명 상이");
    candidates.push({
      id, name: m.name, alive: m.alive, active: m.active, linkable: row.allowLinkIds.includes(id) || (rep != null && row.allowLinkIds.includes(rep.id)),
      status: m.alive ? (m.active ? "유효" : "비활성") : rep ? `통합됨 → 대표 #${rep.id}` : "제외(삭제)",
      mergedFrom, representativeId: rep && rep.id !== id ? rep.id : null,
      email: mEmail || null, phone: m.profile?.phone ?? null, languages: m.profile?.languagePairs ?? null, region: m.profile?.region ?? null,
      education: m.profile?.education ?? null, bio: m.profile?.bio ? String(m.profile.bio).slice(0, 300) : null, hasRrn: !!m.rrn,
      history: { legacyNames: mapped.map(x => x.nm), rows: hist.n, first: hist.first, last: hist.last },
      agreements, conflicts, rrnConflict: row.rrnConflictIds.includes(id),
    });
  }
  return {
    rowNumber, category: row.category, reason: row.reason, basis: row.basis, personKey: row.personKey, savedDecision: saved,
    allowLinkIds: row.allowLinkIds, allowNew: row.allowNew, allowOwnHistory: row.allowOwnHistory, rrnConflictIds: row.rrnConflictIds,
    upload: { name: ex.name, englishName: ex.englishName || null, hasRrn: !!ex.rrn, email: ex.email || null, phone: ex.phoneRaw || null, languages: ex.languages || null,
      services: ex.services || null, region: ex.region || null, education: ex.education || null, career: ex.bio ? ex.bio.slice(0, 300) : null },
    history: { byName: histByName, byRrn: histByRrn, note: "성명 일치 수행이력은 본인 이력으로 자동 확정하지 않습니다(주민번호 일치만 자동 확정)." },
    candidates,
  };
}
