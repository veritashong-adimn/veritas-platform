// 통번역사 Master 수동 통합 — "읽기 전용" 비교/미리보기 산출(§4·§5·§8). DB 미변경.
//  · 선택한 Master들의 비교정보 + 동일인 참고신호 + (대표 지정 시) 통합 후 미리보기(수행이력 record-id 기준 중복제거).
//  · 주민번호 원문은 응답/로그에 출력하지 않는다(보유여부 + YYMMDD-******* 마스킹만). 동일 판정은 서버 내부 비교.
//  · 진행관리표/판매목록 원본(legacy_archive_rows)은 조회만 — 절대 변경하지 않는다.
//  · 이름만 일치(주민번호·전화·이메일 공유 없음)로 연결된 과거이력은 ambiguous=true(동명이인 구분불가 → 확인필요)로 표시.
import { sql } from "drizzle-orm";
import { decrypt } from "../lib/encrypt";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { normalizePhone, normalizeEmail } from "../lib/hometaxExcel";
import { isLegacyPlaceholderEmail } from "../lib/mailer";

const BATCH = 182;
const rrn13 = (s: unknown) => { const d = String(s ?? "").replace(/[^0-9]/g, ""); return d.length === 13 ? d : null; };
const maskRrn = (r: string | null) => (r ? `${r.slice(0, 6)}-*******` : null);

export interface MergeMasterInfo {
  id: number; name: string; isNew: boolean; source: string;
  operationalStatus: string | null; createdAt: string | null;
  hasResidentNumber: boolean; residentNumberMasked: string | null;
  phones: string[]; emails: string[];
  languagePairs: string | null; education: string | null; specializations: string | null; workTypes: string[];
  crmLegacyIds: string[];
  history: { count: number; basis: "rrn" | "name" | "none"; ambiguous: boolean };
  sales: { count: number; basis: "rrn" | "name" | "none" };
  // 지급·정산(§7): 실제 지급 테이블 기준. totalPaid=payout_transfers.amount(실지급 누적), settlementAmount=settlements.translator_amount 합.
  payout: { settlementCount: number; settlementAmount: number; payoutItemCount: number; transferCount: number; totalPaid: number };
  direct: { tasks: number; performance: number };
}

export interface MergePreview {
  masters: MergeMasterInfo[];
  signals: {
    allSameName: boolean;
    nameMismatch: boolean;       // 서로 다른 이름 포함 → 경고(차단 아님). 대표의 동일인 확인으로 진행 가능(§1·§2·§5)
    distinctValidRrnCount: number;
    rrnConflict: boolean;        // 서로 다른 유효 주민번호 2개 이상 → 명백한 신원 충돌, 통합 차단(§2)
    sharedRrn: boolean; sharedPhone: boolean; sharedEmail: boolean;
  };
  // blocked=하드 차단(명백한 신원 충돌·구조적 오류)만. warnings=진행은 가능하나 주의가 필요한 신호.
  guard: { blocked: boolean; reasons: string[]; warnings: string[] };
  preview: null | {
    representativeId: number;
    mergedMasterIds: number[];
    finalHistoryCount: number;   // 진행관리표 수행이력 record-id 기준 중복제거(§6·§8)
    finalSalesCount: number;     // 판매목록 연결 record-id 기준 중복제거
    settlementCount: number; settlementAmount: number; payoutTransferCount: number; totalPaid: number;
    ambiguousHistory: boolean;   // 이름기반 연결 포함 → 확인필요
  };
}

type Dbx = any;
const rows = (q: any) => (q as any).rows as any[];
const anyArr = (ids: number[]) => sql.raw(`ARRAY[${ids.length ? ids.join(",") : "-1"}]::int[]`);
const txtArr = (ss: string[]) => sql.raw(`ARRAY[${ss.length ? ss.map((s) => `'${s.replace(/'/g, "''")}'`).join(",") : "''"}]::text[]`);

// 진행관리표/판매목록 원본에서 (rrn|name) 매칭되는 record-id 집합을 구한다(원본 불변, 조회만).
async function legacyRowIds(dbx: Dbx, sourceType: string, rrns: string[], names: string[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (rrns.length) {
    for (const r of rows(await dbx.execute(sql`
      SELECT id FROM legacy_archive_rows
      WHERE source_type=${sourceType} AND is_effective=true
        AND substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) = ANY(${txtArr(rrns)})`))) out.add(Number(r.id));
  }
  if (names.length) {
    // 이름은 JS 정규화 기준이므로 후보를 넉넉히 가져와 정규화 비교
    for (const r of rows(await dbx.execute(sql`
      SELECT id, nullif(btrim(source_raw->>'통번역사명'),'') nm FROM legacy_archive_rows
      WHERE source_type=${sourceType} AND is_effective=true AND source_raw->>'통번역사명' IS NOT NULL`))) {
      const nn = normalizeCompanyName(String(r.nm ?? ""));
      if (nn && names.includes(nn)) out.add(Number(r.id));
    }
  }
  return out;
}

export async function buildMergePreview(dbx: Dbx, masterIds: number[], representativeId?: number): Promise<MergePreview> {
  const ids = [...new Set(masterIds.map(Number).filter((n) => n > 0))];
  const A = anyArr(ids);
  // 대상: role=translator, 미삭제(871 비활성화·3 물리삭제 제외 — §2)
  const urows = rows(await dbx.execute(sql`SELECT id, name, created_at, is_active FROM users WHERE id = ANY(${A}) AND role='translator' AND deleted_at IS NULL`));
  const foundIds = new Set(urows.map((u) => Number(u.id)));

  const newIds = new Set<number>(rows(await dbx.execute(sql`SELECT entity_id FROM import_row_sources WHERE batch_id=${BATCH} AND entity_id = ANY(${A})`)).map((r) => Number(r.entity_id)));
  const profs = new Map<number, any>();
  for (const p of rows(await dbx.execute(sql`SELECT user_id uid, phone, language_pairs, education, specializations, operational_status FROM translator_profiles WHERE user_id = ANY(${A})`))) profs.set(Number(p.uid), p);
  const emailsBy = new Map<number, Set<string>>();
  const addEmail = (id: number, raw: any) => { if (!raw || isLegacyPlaceholderEmail(raw)) return; const e = normalizeEmail(raw); if (e) { const s = emailsBy.get(id) ?? new Set(); s.add(e); emailsBy.set(id, s); } };
  for (const u of urows) { /* users.email */ }
  for (const e of rows(await dbx.execute(sql`SELECT translator_id tid, email FROM translator_emails WHERE translator_id = ANY(${A})`))) addEmail(Number(e.tid), e.email);
  for (const u of rows(await dbx.execute(sql`SELECT id, email FROM users WHERE id = ANY(${A})`))) addEmail(Number(u.id), u.email);
  const rrnBy = new Map<number, string | null>();
  for (const s of rows(await dbx.execute(sql`SELECT translator_id tid, resident_number rn FROM translator_sensitive WHERE translator_id = ANY(${A})`))) {
    let v: string | null = null; try { if (s.rn) v = rrn13(decrypt(String(s.rn).trim())); } catch { v = null; }
    rrnBy.set(Number(s.tid), v);
  }
  const crmBy = new Map<number, string[]>();
  for (const m of rows(await dbx.execute(sql`SELECT entity_id eid, btrim(legacy_id) lid FROM legacy_master_mappings WHERE entity_type='translator' AND status<>'rolled_back' AND entity_id = ANY(${A})`))) { const a = crmBy.get(Number(m.eid)) ?? []; if (m.lid) a.push(String(m.lid)); crmBy.set(Number(m.eid), a); }
  const workBy = new Map<number, string[]>();
  for (const r of rows(await dbx.execute(sql`SELECT translator_id tid, service_type st FROM translator_rates WHERE translator_id = ANY(${A}) AND service_type IS NOT NULL`))) { const a = workBy.get(Number(r.tid)) ?? []; if (!a.includes(r.st)) a.push(r.st); workBy.set(Number(r.tid), a); }
  // 직접참조 건수
  const cntMap = async (q: any) => { const m = new Map<number, number>(); for (const r of rows(await dbx.execute(q))) m.set(Number(r.id), Number(r.c)); return m; };
  const taskC = await cntMap(sql`SELECT translator_id id, count(*) c FROM tasks WHERE translator_id = ANY(${A}) GROUP BY translator_id`);
  const perfC = await cntMap(sql`SELECT individual_user_id id, count(*) c FROM performance_assignments WHERE individual_user_id = ANY(${A}) AND deleted_at IS NULL GROUP BY individual_user_id`);
  const setlC = await cntMap(sql`SELECT translator_id id, count(*) c FROM settlements WHERE translator_id = ANY(${A}) GROUP BY translator_id`);
  const poiC = await cntMap(sql`SELECT payee_id id, count(*) c FROM payout_round_items WHERE payee_type='individual' AND payee_id = ANY(${A}) GROUP BY payee_id`);
  const trC = await cntMap(sql`SELECT payee_id id, count(*) c FROM payout_transfers WHERE payee_type='individual' AND payee_id = ANY(${A}) GROUP BY payee_id`);
  const paidMap = new Map<number, number>();   // 실지급 누적(payout_transfers.amount) — §7
  for (const r of rows(await dbx.execute(sql`SELECT payee_id id, coalesce(sum(amount),0) s FROM payout_transfers WHERE payee_type='individual' AND payee_id = ANY(${A}) GROUP BY payee_id`))) paidMap.set(Number(r.id), Number(r.s) || 0);
  const setlAmtMap = new Map<number, number>();   // 정산액(settlements.translator_amount)
  for (const r of rows(await dbx.execute(sql`SELECT translator_id id, coalesce(sum(translator_amount),0) s FROM settlements WHERE translator_id = ANY(${A}) GROUP BY translator_id`))) setlAmtMap.set(Number(r.id), Number(r.s) || 0);

  const masters: MergeMasterInfo[] = [];
  for (const u of urows) {
    const id = Number(u.id); const p = profs.get(id) ?? {};
    const rrn = rrnBy.get(id) ?? null;
    const nn = normalizeCompanyName(u.name ?? "");
    const hist = await legacyRowIds(dbx, "progress", rrn ? [rrn] : [], nn ? [nn] : []);
    const sales = await legacyRowIds(dbx, "sales_list", rrn ? [rrn] : [], nn ? [nn] : []);
    const histBasis: "rrn" | "name" | "none" = hist.size === 0 ? "none" : rrn ? "rrn" : "name";
    masters.push({
      id, name: u.name ?? "", isNew: newIds.has(id), source: newIds.has(id) ? `신규(batch${BATCH})` : "기존",
      operationalStatus: p.operational_status ?? null, createdAt: u.created_at ? String(u.created_at) : null,
      hasResidentNumber: !!rrn, residentNumberMasked: maskRrn(rrn),
      phones: [...new Set([normalizePhone(p.phone)].filter(Boolean))] as string[],
      emails: [...(emailsBy.get(id) ?? [])],
      languagePairs: p.language_pairs ?? null, education: p.education ?? null, specializations: p.specializations ?? null,
      workTypes: workBy.get(id) ?? [],
      crmLegacyIds: crmBy.get(id) ?? [],
      history: { count: hist.size, basis: histBasis, ambiguous: histBasis === "name" },
      sales: { count: sales.size, basis: sales.size === 0 ? "none" : rrn ? "rrn" : "name" },
      payout: { settlementCount: setlC.get(id) ?? 0, settlementAmount: setlAmtMap.get(id) ?? 0, payoutItemCount: poiC.get(id) ?? 0, transferCount: trC.get(id) ?? 0, totalPaid: paidMap.get(id) ?? 0 },
      direct: { tasks: taskC.get(id) ?? 0, performance: perfC.get(id) ?? 0 },
    });
  }

  // ── §5 동일인 참고신호 ──
  const norms = new Set(masters.map((m) => normalizeCompanyName(m.name)));
  const validRrns = new Set(masters.map((m) => rrnBy.get(m.id)).filter(Boolean) as string[]);
  const phoneCount = new Map<string, number>(); for (const m of masters) for (const p of m.phones) phoneCount.set(p, (phoneCount.get(p) ?? 0) + 1);
  const emailCount = new Map<string, number>(); for (const m of masters) for (const e of m.emails) emailCount.set(e, (emailCount.get(e) ?? 0) + 1);
  const signals = {
    allSameName: norms.size <= 1,
    nameMismatch: norms.size > 1,
    distinctValidRrnCount: validRrns.size,
    rrnConflict: validRrns.size >= 2,
    sharedRrn: validRrns.size === 1 && masters.filter((m) => rrnBy.get(m.id)).length >= 2,
    sharedPhone: [...phoneCount.values()].some((c) => c >= 2),
    sharedEmail: [...emailCount.values()].some((c) => c >= 2),
  };

  // ── 가드 ──
  //  · blocked(하드 차단): 구조적 오류 + "명백한 신원 충돌"(서로 다른 유효 주민번호)만. (§2)
  //  · 식별정보(주민번호·전화·이메일) '없음'은 차단 사유가 아니다 — 대표의 동일인 확인으로 진행한다. (§1·§2)
  //  · 이름 불일치는 경고(warning)로만 표시 — 대표가 직접 동일인을 지정·확인하면 진행 가능. (§5)
  const reasons: string[] = [];
  const warnings: string[] = [];
  const missing = ids.filter((i) => !foundIds.has(i));
  if (missing.length) reasons.push(`대상 아님/비활성/삭제됨: [${missing.join(", ")}] — 재검증 필요`);
  if (masters.length < 2) reasons.push("통합은 2개 이상의 Master가 필요합니다");
  if (signals.rrnConflict) reasons.push(`서로 다른 유효 주민번호 ${signals.distinctValidRrnCount}개 — 명백한 신원 충돌, 통합 차단(별도 확인 대상)`);
  if (signals.nameMismatch) warnings.push("서로 다른 이름의 Master가 포함됨 — 동일인 여부를 대표가 직접 확인해야 합니다");
  if (!signals.sharedRrn && !signals.sharedPhone && !signals.sharedEmail) warnings.push("공유 식별자(주민번호·전화·이메일)가 없음 — '실제 동일인임을 확인합니다' 체크로 진행합니다");
  const blocked = reasons.length > 0;

  // ── §8 통합 후 미리보기(대표 지정 시, record-id 기준 중복제거) ──
  let preview: MergePreview["preview"] = null;
  if (representativeId && foundIds.has(Number(representativeId)) && !blocked) {
    const repId = Number(representativeId);
    const allRrns = [...validRrns];
    const allNames = [...norms].filter(Boolean) as string[];
    const histIds = await legacyRowIds(dbx, "progress", allRrns, allNames);
    const salesIds = await legacyRowIds(dbx, "sales_list", allRrns, allNames);
    const settlementCount = masters.reduce((a, m) => a + m.payout.settlementCount, 0);
    const settlementAmount = masters.reduce((a, m) => a + m.payout.settlementAmount, 0);
    const payoutTransferCount = masters.reduce((a, m) => a + m.payout.transferCount, 0);
    const totalPaid = masters.reduce((a, m) => a + m.payout.totalPaid, 0);
    preview = {
      representativeId: repId,
      mergedMasterIds: masters.map((m) => m.id).filter((i) => i !== repId),
      finalHistoryCount: histIds.size,
      finalSalesCount: salesIds.size,
      settlementCount, settlementAmount, payoutTransferCount, totalPaid,
      ambiguousHistory: masters.some((m) => m.history.ambiguous),
    };
  }

  return { masters, signals, guard: { blocked, reasons, warnings }, preview };
}
