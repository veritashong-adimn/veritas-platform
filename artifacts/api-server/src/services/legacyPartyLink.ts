// ─── 과거 CRM 판매 거래처·고객 담당자 공통 연결 규칙(전체 판매 공통) ─────────────────────────────
//
// 저장 구조는 기존 그대로 쓴다(스키마 변경 없음).
//   · 거래처: company_aliases(과거 CRM 거래처 표기 → 거래처 Master). 판매관리·담당자 복원·운영 전환이 이 별칭으로 거래처를 인식한다.
//   · 고객 담당자: legacy_master_mappings('sale_contact', 판매번호 → contacts.id). 판매목록·판매상세·전환 시 담당자로 쓰인다.
//   · 운영 전환 판매(projects)는 운영 데이터이므로 자동 변경하지 않고 검토 목록으로만 남긴다.
//
// 거래처 연결
//   1) 기존 규칙: 정규화 거래처명(normalizeCompanyName)·별칭이 Master 1곳과 일치
//   2) (추가) 개인고객 표기: '고제이슨(개인고객)'·'개인고객(오은숙)'·'개인(유경희)' 의 고객유형 표기만 비교에서 떼고,
//      남은 이름이 개인고객 유형(INDIVIDUAL) Master 1곳과 정확히 같을 때만 연결. 원본 표기는 별칭으로 보존(새 거래처 생성 없음).
//      같은 이름의 개인고객 Master 가 2곳 이상이거나 원본 연락처가 그 Master 연락처와 다르면 검토.
// 담당자 연결(같은 거래처 소속 Master 만 — 다른 거래처 동명이인은 후보로도 쓰지 않음)
//   1순위 이름 + 이메일 일치  2순위 이름 + 연락처(개인번호) 일치  3순위 같은 이름이 1명이고 연락처·이메일 충돌 없음
//   · 이름: 공백·끝 직함·존칭만 비교에서 제외(personKey). 원본 이름은 바꾸지 않는다.
//   · 전화: 숫자만 비교(국제형식 82→0). 거래처 대표번호·같은 거래처 여러 고객이 쓴 번호·다른 거래처에서도 쓴 번호는 개인 식별에 쓰지 않는다.
//   · 이메일: 소문자·앞뒤 공백 정리. 거래처 대표 이메일·같은 거래처 담당자 여러 명이 쓰는 이메일·대표 계정(info@ 등)은 개인 식별에 쓰지 않는다.
//   · 충돌: 양쪽 모두 개인번호가 있는데 겹치지 않음 / 양쪽 모두 개인 이메일이 있는데 다름 → 연결하지 않고 검토.
//   · Master 에 같은 이름이 없으면 신규 등록 후보로만 분류(자동 생성 없음). 기존 Master 값(이메일 등)은 덮어쓰지 않는다.
// 기존 연결은 그대로 둔다(평가만: 확인된 연결 / 이름 일치·충돌 없음 / 충돌).
import { sql } from "drizzle-orm";
import { normalizeCompanyName as N } from "../lib/normalizeCompany";
import { classifySales, loadPhoneIndex, loadSaleMemos, sourceEmailOf, personKey, normPhone, type SaleContactResult } from "./legacyContactRestore";

export const PARTY_LINK_MODULE = "legacy_party_link";
type Dbx = { execute: (q: any) => Promise<{ rows: unknown[]; rowCount?: number | null }> };
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];

// ── 개인고객 표기 ─────────────────────────────────────────────────────────────
const IND_LABEL = "(개인고객|개인 고객|개인)";
const PREFIX_RE = new RegExp(`^\\s*${IND_LABEL}\\s*[(（]\\s*(.+?)\\s*[)）]\\s*$`);
const SUFFIX_RE = new RegExp(`^\\s*(.+?)\\s*[(（]\\s*${IND_LABEL}\\s*[)）]\\s*$`);
/** 개인고객 표기에서 고객 이름만 꺼낸다(비교용). 표기가 없거나 이름이 없으면 null. 원본은 바꾸지 않는다. */
export function individualNameOf(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const m = PREFIX_RE.exec(s);
  const name = m ? m[2] : SUFFIX_RE.exec(s)?.[1] ?? null;
  if (!name) return null;
  const n = name.replace(/\s*(고객님|고객|님)$/, "").trim();
  return /[가-힣A-Za-z]/.test(n) && !/(개인|고객)$/.test(n) ? n : null;
}

// ── 비교 키 ─────────────────────────────────────────────────────────────────
const emailKey = (v: unknown) => { const s = String(v ?? "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };
const GENERIC_MAILBOX = /^(info|admin|office|contact|help|support|sales|master|webmaster|hr|biz|mail|service|cs|kor|korea|team|account|accounts?|tax|invoice|billing)[.\-_]?\d*@/i;
const phonesOf = (c: any) => [c.phone, c.mobile, c.office_phone].map(normPhone).filter((t: string) => t.length >= 7);

export type SaleCategory = "A" | "B" | "C" | "F" | "G" | "H";
export const CATEGORY_LABEL: Record<SaleCategory | "D" | "E" | "I" | "J", string> = {
  A: "기존 정상 연결", B: "거래처·담당자 모두 자동 연결 가능", C: "거래처만 연결 가능(담당자 연결 불가)", D: "연결 담당자 Master 에 이메일·전화 누락",
  E: "원본에 정보가 있어 보완 가능(Master 값 없음)", F: "개인고객 표기 차이로 미연결 — 개인고객 Master 연결 가능", G: "동명이인·연락처 충돌·거래처 후보 복수(검토)",
  H: "거래처 Master 미등록", I: "담당자 Master 미등록(신규 등록 후보)", J: "근거 부족(고객명 없음·복수 등)",
};

export interface PartyLinkRow {
  saleRowId: number; saleNo: string | null; rawCompany: string | null; converted: boolean;
  saleDate: string | null; product: string | null; total: number | null;   // 표시·검색용(원본 판매목록 값)
  category: SaleCategory; issues: Array<"D" | "E" | "G" | "I" | "J">; detail: string;
  company: { id: number | null; name: string | null; via: "existing" | "individual_label" | "project" | null; candidates?: number[] };
  customerName: string | null; sourcePhones: string[]; sourceEmail: string | null;
  linked: { contactId: number; name: string; via: string; check: "verified" | "name_only" | "conflict"; why?: string } | null;
  proposal: { contactId: number; name: string; basis: "name_email" | "name_phone" | "name_unique"; why: string } | null;
  alias: { companyId: number; alias: string } | null;                                 // 개인고객 표기 → 별칭 추가 제안
  supplement: { contactId: number; field: "email" | "phone"; value: string } | null;   // Master 보완 후보(자동 적용 없음)
}

export async function planPartyLinks(dbx: Dbx, opts: { saleNos?: string[] } = {}): Promise<PartyLinkRow[]> {
  const all = await classifySales(dbx);
  const list = opts.saleNos?.length ? all.filter(r => r.saleNo && opts.saleNos!.includes(r.saleNo)) : all;
  const companies = await rows(dbx, sql`SELECT id, name, customer_type, phone, mobile, email FROM companies WHERE deleted_at IS NULL`);
  const coById = new Map(companies.map(c => [Number(c.id), c]));
  const idx = new Map<string, Set<number>>();
  const add = (k: string, id: number) => { if (k) (idx.get(k) ?? idx.set(k, new Set()).get(k)!).add(id); };
  for (const c of companies) add(N(c.name), Number(c.id));
  for (const a of await rows(dbx, sql`SELECT ca.company_id, ca.normalized_alias FROM company_aliases ca JOIN companies c ON c.id = ca.company_id AND c.deleted_at IS NULL`)) add(String(a.normalized_alias ?? ""), Number(a.company_id));
  const contacts = await rows(dbx, sql`SELECT id, company_id, name, email, phone, mobile, office_phone, is_active, deleted_at FROM contacts`);
  const ctById = new Map(contacts.map(c => [Number(c.id), c]));
  const ctByCo = new Map<number, any[]>();
  for (const c of contacts) if (!c.deleted_at && c.is_active) (ctByCo.get(Number(c.company_id)) ?? ctByCo.set(Number(c.company_id), []).get(Number(c.company_id))!).push(c);
  const emailCount = new Map<string, number>();   // 거래처별 이메일 사용 인원
  for (const c of contacts) { const e = emailKey(c.email); if (e && !c.deleted_at) emailCount.set(`${c.company_id}|${e}`, (emailCount.get(`${c.company_id}|${e}`) ?? 0) + 1); }
  const sharedEmail = (coId: number, e: string) => GENERIC_MAILBOX.test(e) || (emailCount.get(`${coId}|${e}`) ?? 0) > 1 || emailKey(coById.get(coId)?.email) === e;
  const sharedOf = await loadPhoneIndex(dbx);
  const memos = await loadSaleMemos(dbx);
  const maps = new Map((await rows(dbx, sql`SELECT legacy_id, entity_id, match_method FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale_contact' AND status='active'`)).map(m => [String(m.legacy_id), m]));
  const acts = new Map((await rows(dbx, sql`SELECT m.legacy_id, p.company_id, p.contact_id FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id
    WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active'`)).map(a => [String(a.legacy_id), a]));

  const out: PartyLinkRow[] = [];
  for (const r of list) {
    const act = r.saleNo ? acts.get(r.saleNo) : undefined;
    const name = r.cls === "A" ? r.customerName ?? null : null;
    const row: PartyLinkRow = { saleRowId: r.saleRowId, saleNo: r.saleNo, rawCompany: r.company, converted: !!act, saleDate: r.saleDate, product: r.product, total: r.total, category: "H", issues: [], detail: "",
      company: { id: null, name: null, via: null }, customerName: name,
      // 원본 연락처(표시·검색용) — 거래처가 확정되면 아래에서 공용번호를 뺀 개인번호로 다시 계산한다
      sourcePhones: name ? [...new Set((r.tels ?? []).map(normPhone))].filter(t => t.length >= 7) : [], sourceEmail: null, linked: null, proposal: null, alias: null, supplement: null };
    out.push(row);

    // ── 거래처 ──
    if (act?.company_id) row.company = { id: Number(act.company_id), name: coById.get(Number(act.company_id))?.name ?? null, via: "project" };
    else {
      const hit = idx.get(N(r.company ?? ""));
      if (hit?.size === 1) { const id = [...hit][0]; row.company = { id, name: coById.get(id)?.name ?? null, via: "existing" }; }
      else if (hit && hit.size > 1) { row.category = "G"; row.issues.push("G"); row.company.candidates = [...hit]; row.detail = `거래처 후보 ${hit.size}곳`; continue; }
      else {
        const ind = individualNameOf(r.company);
        if (!ind) {
          // 이름 없는 '개인고객' 묶음 표기는 개인을 특정할 수 없다(근거 부족). 그 외는 거래처 Master 미등록.
          const bare = /^(개인|개인고객|개인 고객)$/.test(String(r.company ?? "").trim());
          row.category = "H"; row.detail = bare ? "고객 이름 없는 '개인고객' 표기 — 개인 특정 불가" : "일치하는 거래처 Master 없음(신규 등록 후보)";
          if (bare) row.issues.push("J");
          continue;
        }
        const cands = [...(idx.get(N(ind)) ?? [])].filter(id => coById.get(id)?.customer_type === "INDIVIDUAL");
        const others = [...(idx.get(N(ind)) ?? [])].filter(id => coById.get(id)?.customer_type !== "INDIVIDUAL");
        if (cands.length > 1) { row.category = "G"; row.issues.push("G"); row.company.candidates = cands; row.detail = `같은 이름 개인고객 Master ${cands.length}곳(동명이인)`; continue; }
        if (!cands.length) { row.category = "H"; row.detail = others.length ? `개인고객 '${ind}' — 같은 이름의 개인고객 Master 없음(법인 거래처 ${others.length}곳과만 이름 일치 — 연결하지 않음)` : `개인고객 '${ind}' Master 미등록(신규 등록 후보)`; continue; }
        // 개인고객 Master 연락처와 원본 연락처가 모두 있는데 다르면 충돌
        const co = coById.get(cands[0])!;
        const srcTels = (r.tels ?? []).map(normPhone);
        const coTels = [co.phone, co.mobile].map(normPhone).filter((t: string) => t.length >= 7);
        if (srcTels.length && coTels.length && !srcTels.some(t => coTels.includes(t))) { row.category = "G"; row.issues.push("G"); row.company.candidates = cands; row.detail = `개인고객 '${ind}' Master 연락처가 원본 연락처와 다름`; continue; }
        row.company = { id: cands[0], name: co.name, via: "individual_label" };
        row.alias = { companyId: cands[0], alias: String(r.company) };
      }
    }
    const coId = row.company.id!;
    const isIndividual = coById.get(coId)?.customer_type === "INDIVIDUAL";
    // 원본 개인번호·이메일(같은 고객명 행만)
    row.sourcePhones = name ? [...new Set((r.tels ?? []).map(normPhone))].filter(t => t.length >= 7 && !sharedOf(r.company, t, coById.get(coId)?.phone ?? null)) : [];
    const se = name ? sourceEmailOf(memos.get(r.saleRowId) ?? [], name) : [];
    row.sourceEmail = se.length === 1 ? se[0] : null;
    const personalEmail = row.sourceEmail && !sharedEmail(coId, row.sourceEmail) ? row.sourceEmail : null;

    // 개인고객: 담당자를 따로 두지 않는다(기존 구조) — 거래처 연결로 완료
    if (isIndividual) { row.category = row.company.via === "individual_label" ? "F" : "A"; row.detail = row.company.via === "individual_label" ? `개인고객 표기 '${r.company}' → 개인고객 Master '${row.company.name}'` : "개인고객 거래처 연결"; continue; }

    const check = (c: any): { check: "verified" | "name_only" | "conflict"; why: string } => {
      if (!c || c.deleted_at) return { check: "conflict", why: "연결 담당자가 삭제됨" };
      if (name && personKey(c.name) !== personKey(name)) return { check: "conflict", why: `연결 담당자 '${c.name}' ≠ 원본 고객명 '${name}'` };
      const mp = phonesOf(c), me = emailKey(c.email);
      const telHit = row.sourcePhones.some(t => mp.includes(t)), mailHit = !!personalEmail && me === personalEmail;
      if (telHit || mailHit) return { check: "verified", why: mailHit ? "이름+이메일 일치" : "이름+연락처 일치" };
      const masterPersonal = mp.filter(t => !sharedOf(r.company, t, coById.get(coId)?.phone ?? null));
      if (row.sourcePhones.length && masterPersonal.length) return { check: "conflict", why: `원본 연락처 ${row.sourcePhones.join("/")} ≠ Master ${masterPersonal.join("/")}` };
      if (personalEmail && me && !sharedEmail(coId, me) && me !== personalEmail) return { check: "conflict", why: `원본 이메일 ≠ Master 이메일` };
      return { check: "name_only", why: name ? "이름 일치(연락처·이메일로 확인할 값 없음, 충돌 없음)" : "원본 고객명 없음" };
    };
    const supplementOf = (c: any) => {
      if (personalEmail && !emailKey(c.email)) row.supplement = { contactId: Number(c.id), field: "email", value: personalEmail };
      else if (row.sourcePhones.length && !phonesOf(c).length) row.supplement = { contactId: Number(c.id), field: "phone", value: row.sourcePhones[0] };
      if (row.supplement) row.issues.push("E");
      if (!emailKey(c.email) || !phonesOf(c).length) row.issues.push("D");
    };

    // ── 기존 연결 평가(변경 없음) ──
    const linkedId = act ? (act.contact_id ? Number(act.contact_id) : null) : (r.saleNo ? Number(maps.get(r.saleNo)?.entity_id ?? 0) || null : null);
    if (linkedId) {
      const c = ctById.get(linkedId); const ck = check(c);
      row.linked = { contactId: linkedId, name: c?.name ?? "?", via: act ? "project" : String(maps.get(r.saleNo!)?.match_method ?? ""), ...ck };
      if (ck.check === "conflict") { row.category = "G"; row.issues.push("G"); row.detail = ck.why; } else { row.category = "A"; row.detail = ck.why; }
      if (c && !c.deleted_at) supplementOf(c);
      continue;
    }
    if (act) { row.category = "C"; row.issues.push(name ? "I" : "J"); row.detail = "운영 전환 판매 — 담당자는 판매상세에서 지정(자동 변경 제외)"; continue; }
    if (!name) { row.category = "C"; row.issues.push("J"); row.detail = r.reason; continue; }

    // ── 새 연결 후보(같은 거래처만) ──
    const pool = ctByCo.get(coId) ?? [];
    const same = pool.filter(c => personKey(c.name) === personKey(name));
    const byMail = personalEmail ? same.filter(c => emailKey(c.email) === personalEmail) : [];
    const byTel = same.filter(c => phonesOf(c).some((t: string) => row.sourcePhones.includes(t)));
    let pick: any = null; let basis: "name_email" | "name_phone" | "name_unique" | null = null; let why = "";
    if (byMail.length === 1) { pick = byMail[0]; basis = "name_email"; why = "같은 거래처 + 이름 + 이메일 일치"; }
    else if (byTel.length === 1) { pick = byTel[0]; basis = "name_phone"; why = "같은 거래처 + 이름 + 연락처 일치"; }
    else if (same.length === 1) {
      const ck = check(same[0]);
      if (ck.check === "conflict") { row.category = "G"; row.issues.push("G"); row.detail = `동명 1명이나 ${ck.why}`; continue; }
      pick = same[0]; basis = "name_unique"; why = "같은 거래처에 같은 이름 1명 · 연락처·이메일 충돌 없음";
    }
    if (pick) { row.proposal = { contactId: Number(pick.id), name: pick.name, basis: basis!, why }; row.category = "B"; row.detail = why; supplementOf(pick); continue; }
    if (same.length > 1) { row.category = "G"; row.issues.push("G"); row.detail = `같은 거래처 동명 ${same.length}명 — 이메일·연락처로 1명 확정 불가`; continue; }
    row.category = "C"; row.issues.push("I"); row.detail = `거래처 '${row.company.name}'에 '${name}' 담당자 Master 없음(신규 등록 후보 — 자동 생성 안 함)`;
  }
  return out;
}

export function summarizePartyLinks(list: PartyLinkRow[]) {
  const by = (f: (r: PartyLinkRow) => boolean) => list.filter(f).length;
  const cat: Record<string, number> = {}; for (const r of list) cat[r.category] = (cat[r.category] ?? 0) + 1;
  const iss: Record<string, number> = {}; for (const r of list) for (const i of new Set(r.issues)) iss[i] = (iss[i] ?? 0) + 1;
  return {
    total: list.length, converted: by(r => r.converted), byCategory: cat, byIssue: iss,
    autoApplicable: { companyAliases: new Set(list.filter(r => r.alias).map(r => `${r.alias!.companyId}|${N(r.alias!.alias)}`)).size,
      salesViaAlias: by(r => !!r.alias), contactLinks: by(r => !!r.proposal),
      contactLinksByBasis: list.filter(r => r.proposal).reduce((a: any, r) => { a[r.proposal!.basis] = (a[r.proposal!.basis] ?? 0) + 1; return a; }, {}) },
    existingLinkCheck: list.filter(r => r.linked).reduce((a: any, r) => { a[r.linked!.check] = (a[r.linked!.check] ?? 0) + 1; return a; }, {}),
    supplementCandidates: by(r => !!r.supplement),
  };
}

/**
 * 확실한 연결만 적용(승인 후, 한 트랜잭션): 개인고객 표기 별칭 추가 + 담당자 연결(sale_contact).
 *  · 기존 연결·Master 값은 바꾸지 않는다(ON CONFLICT DO NOTHING). 운영 전환 판매는 대상 아님.
 *  · bases 로 담당자 연결 근거를 고를 수 있다(기본: 이메일·연락처 일치만 — 이름 유일 연결은 명시할 때만).
 *  · 근거·전후는 import_row_sources(module=legacy_party_link), 되돌리기는 rollbackPartyLinks(batchId).
 */
export async function applyPartyLinks(tx: Dbx, opts: { userId: number | null; saleNos?: string[]; bases?: Array<"name_email" | "name_phone" | "name_unique">; reason?: string }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${PARTY_LINK_MODULE}))`);
  const bases = new Set(opts.bases?.length ? opts.bases : ["name_email", "name_phone"]);
  const plan = await planPartyLinks(tx, { saleNos: opts.saleNos });
  const [batch] = await rows(tx, sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
    VALUES (${PARTY_LINK_MODULE}, 'party_link', ${opts.reason ?? "과거 CRM 거래처·담당자 연결"}, ${plan.length}, 0, 'running', ${opts.userId}, 'old_crm', false) RETURNING id`);
  const batchId = Number(batch.id); const lineage: any[] = []; let aliases = 0, links = 0;
  const done = new Set<string>();
  for (const r of plan) {
    if (r.converted) continue;
    if (r.alias && !done.has(`${r.alias.companyId}|${N(r.alias.alias)}`)) {
      done.add(`${r.alias.companyId}|${N(r.alias.alias)}`);
      const [a] = await rows(tx, sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary) VALUES (${r.alias.companyId}, ${r.alias.alias}, ${N(r.alias.alias)}, false)
        ON CONFLICT (company_id, normalized_alias) DO NOTHING RETURNING id`);
      if (a) { aliases++; lineage.push({ entityId: Number(a.id), rowKey: `alias:${a.id}`, status: "alias_added", legacyId: r.saleNo,
        sourceRaw: { companyId: r.alias.companyId, alias: r.alias.alias, basis: "individual_label", saleRowId: r.saleRowId } }); }
    }
    if (r.proposal && bases.has(r.proposal.basis) && r.saleNo) {
      const [m] = await rows(tx, sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, import_batch_id, match_method, status, created_by)
        VALUES ('old_crm', 'sale_contact', ${r.saleNo}, ${r.proposal.contactId}, ${batchId}, ${`party_${r.proposal.basis}`}, 'active', ${opts.userId})
        ON CONFLICT (source_system, entity_type, legacy_id) DO NOTHING RETURNING id`);
      if (m) { links++; lineage.push({ entityId: Number(m.id), rowKey: `sale_contact:${r.saleNo}`, status: "contact_linked", legacyId: r.saleNo,
        sourceRaw: { saleRowId: r.saleRowId, before: null, after: { contactId: r.proposal.contactId, name: r.proposal.name }, basis: r.proposal.basis, why: r.proposal.why,
          companyId: r.company.id, customerName: r.customerName, sourcePhones: r.sourcePhones, sourceEmail: r.sourceEmail } }); }
    }
  }
  for (let i = 0; i < lineage.length; i += 500)
    await tx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw) VALUES
      ${sql.join(lineage.slice(i, i + 500).map(x => sql`(${batchId}, ${PARTY_LINK_MODULE}, ${x.entityId}, ${x.rowKey}, ${x.status}, 'old_crm', ${x.legacyId}, ${JSON.stringify(x.sourceRaw)}::jsonb)`), sql`, `)}`);
  await tx.execute(sql`UPDATE import_batches SET success_rows = ${aliases + links}, status = 'completed', headers_json = ${JSON.stringify({ aliases, links, bases: [...bases] })}::jsonb WHERE id = ${batchId}`);
  return { batchId, aliases, links };
}

/** 되돌리기 — 이 배치가 추가한 별칭·담당자 연결만 삭제(그 뒤 직원이 바꾼 연결은 match_method 가 달라 건드리지 않음) */
export async function rollbackPartyLinks(tx: Dbx, batchId: number) {
  const recs = await rows(tx, sql`SELECT entity_id, status FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${PARTY_LINK_MODULE}`);
  const aliasIds = recs.filter(r => r.status === "alias_added").map(r => Number(r.entity_id));
  const mapIds = recs.filter(r => r.status === "contact_linked").map(r => Number(r.entity_id));
  const L = (xs: number[]) => sql.join(xs.map(x => sql`${x}`), sql`, `);
  const a = aliasIds.length ? (await tx.execute(sql`DELETE FROM company_aliases WHERE id IN (${L(aliasIds)}) AND is_primary = false`)).rowCount ?? 0 : 0;
  const m = mapIds.length ? (await tx.execute(sql`DELETE FROM legacy_master_mappings WHERE id IN (${L(mapIds)}) AND import_batch_id = ${batchId} AND match_method LIKE 'party_%'`)).rowCount ?? 0 : 0;
  await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back' WHERE id = ${batchId} AND module = ${PARTY_LINK_MODULE}`);
  return { batchId, aliasesRemoved: a, linksRemoved: m };
}
