// ─── 과거 CRM 판매관리 고객 담당자 복원 ─────────────────────────────────────────────
//
// 1) 판매↔진행관리표 연결 보정(late_progress_key_v1)
//    기존 연결 규칙(planNewSaleLinks 와 같은 키: 판매 '거래처|상품|총액|판매일' = 진행 '거래처명|상품명|총액|체결일')으로,
//    판매보다 늦게 올라와 연결되지 못한 진행행만 연결한다. 같은 키의 판매가 2건 이상이면 연결하지 않는다.
//    다른 판매에 이미 연결된 진행행은 쓰지 않는다. 기존 연결은 삭제·변경하지 않는다(재업로드 시 carry_over 로 유지됨).
// 2) 고객 담당자명 복원 — 저장하지 않는다. 연결된 진행행의 '고객명'에서 조회 시 계산한다(판매관리 목록·상세 공통).
//    A: 고객명 1명 / B: 연결키가 같은 판매 복수(의뢰건 식별 불확실) / C: 고객명 없음·무효.
// 3) 담당자 Master 자동 연결(auto_name_phone) — 같은 거래처 + 같은 이름 1명 + 진행관리표 연락처가 그 담당자 연락처와 일치할 때만.
//    legacy_master_mappings('sale_contact') 에 저장(수동 보완과 같은 구조, match_method 로 구분). 이미 연결된 판매는 건드리지 않는다.
//    담당자 Master 신규 등록 없음.
// 4) 이름 기준 전체 자동 연결(auto_name / auto_name_created) — 같은 거래처 + 같은 이름이면 같은 담당자.
//    전화·이메일 일치는 요구하지 않는다. 동명 Master 1명 → 연결, 0명 → (거래처, 이름)당 1명 신규 등록 후 연결,
//    동명 2명 이상·거래처 미확정·고객명 없음/복수·기존 연결 충돌·운영 전환 판매는 예외(확인 필요)로 남긴다. planNameLinks / applyNameLinks.
// 실행 기록·근거: import_batches(module=legacy_contact_restore) + import_row_sources. 배치 단위 되돌리기 지원.
import { sql } from "drizzle-orm";
import { saleLinkKey } from "./legacyArchiveSync";
import { normalizeCompanyName } from "../lib/normalizeCompany";

export const RESTORE_MODULE = "legacy_contact_restore";
export const LATE_LINK_METHOD = "late_progress_key_v1";
export const AUTO_CONTACT_METHOD = "auto_name_phone";
// 같은 거래처에 동명 Master 가 여러 명일 때 원본 개인번호(공용번호 제외)로 1명이 식별된 자동 연결
export const AUTO_CONTACT_MULTI_METHOD = "auto_samename_phone";
// 이름 기준 자동 연결 — 기존 동명 Master 1명에 연결 / 이번 실행이 신규 등록한 Master 에 연결
export const AUTO_NAME_METHOD = "auto_name";
export const AUTO_NAME_CREATED_METHOD = "auto_name_created";
const AUTO_METHODS = [AUTO_CONTACT_METHOD, AUTO_CONTACT_MULTI_METHOD, AUTO_NAME_METHOD, AUTO_NAME_CREATED_METHOD];

type Dbx = { execute: (q: any) => Promise<{ rows: unknown[]; rowCount?: number | null }> };
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];

// 고객명 비교키 — 공백 제거, 끝의 직함·존칭만 제거(표시는 원문 유지)
const TITLE_RE = /(대표이사|대표|부사장|사장|전무|상무|이사|본부장|센터장|원장|소장|국장|부장|차장|과장|팀장|실장|대리|주임|사원|연구원|선임|책임|수석|선생|교수|박사|매니저|위원|담당)?님?$/;
export function personKey(raw: unknown): string {
  let s = String(raw ?? "").replace(/\s+/g, "").toLowerCase();
  for (let i = 0; i < 2; i++) { const t = s.replace(TITLE_RE, ""); if (t.length >= 2) s = t; }
  return s;
}
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
/** 전화번호 비교키 — 숫자만, 국제형식 국내번호(82…)는 0… 으로(형식 변환만, 값 생성 없음) */
export function normPhone(v: unknown): string {
  const d = digits(v);
  return /^82(1[016789]|[2-6]|70)\d{6,9}$/.test(d) ? "0" + d.slice(2) : d;
}
export type PhoneType = "mobile" | "landline" | "rep" | "unknown";
export function phoneType(d: string): PhoneType {
  if (/^01[016789]\d{7,8}$/.test(d)) return "mobile";
  if (/^(02\d{7,8}|0[3-6][1-5]\d{7,8}|070\d{8}|050\d{8,9})$/.test(d)) return "landline";
  if (/^1[5-9]\d{6}$/.test(d)) return "rep";
  return "unknown";
}
/** 공용번호 판정 — company_rep: 그 거래처 대표번호 / shared_in_company: 같은 거래처에서 고객명 2명 이상이 쓴 번호 / shared_cross_company: 다른 거래처에서도 쓰인 번호 */
export type SharedKind = "company_rep" | "shared_in_company" | "shared_cross_company" | null;
export async function loadPhoneIndex(dbx: Dbx, tels?: string[]) {
  const namesByCoTel = new Map<string, Set<string>>(); const cosByTel = new Map<string, Set<string>>();
  const filter = tels?.length ? sql`AND regexp_replace(coalesce(p.source_raw->>'연락처',''), '[^0-9]', '', 'g') = ANY(${sql.raw(`ARRAY[${[...new Set(tels.flatMap(t => [t, t.startsWith("0") ? "82" + t.slice(1) : t]))].map(t => `'${t.replace(/\D/g, "")}'`).join(",")}]::text[]`)})` : sql``;
  for (const p of await rows(dbx, sql`SELECT p.source_raw->>'거래처명' co, p.source_raw->>'고객명' cust, p.source_raw->>'연락처' tel
      FROM legacy_archive_rows p WHERE p.source_type = 'progress' AND p.is_effective ${filter}`)) {
    const t = normPhone(p.tel); if (t.length < 7) continue;
    const ck = normalizeCompanyName(p.co ?? "");
    (namesByCoTel.get(ck + "|" + t) ?? namesByCoTel.set(ck + "|" + t, new Set()).get(ck + "|" + t)!).add(personKey(p.cust));
    (cosByTel.get(t) ?? cosByTel.set(t, new Set()).get(t)!).add(ck);
  }
  return (company: string | null, t: string, companyPhone?: string | null): SharedKind =>
    companyPhone && normPhone(companyPhone) === t ? "company_rep"
      : (namesByCoTel.get(normalizeCompanyName(company ?? "") + "|" + t)?.size ?? 0) > 1 ? "shared_in_company"
      : (cosByTel.get(t)?.size ?? 0) > 1 ? "shared_cross_company" : null;
}
// 고객명으로 쓸 수 없는 값(빈값·숫자만·전화번호·인사말 등)
export function invalidCustomerName(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return "빈값";
  if (!/[가-힣A-Za-z]/.test(s)) return "문자 없음";
  if (digits(s).length >= 7) return "전화번호 형태";
  if (/^(med venlig hilsen|best regards|regards|미정|없음|고객|담당자)$/i.test(s)) return "이름 아님";
  return null;
}

// 판매일 — 판매관리 목록과 같은 규칙(record_date → 판매번호 날짜 → 세금계산서발행(예정)일)
const SALE_DATE = sql`coalesce(to_char(s.record_date,'YYYY-MM-DD'), substring(s.source_raw->>'판매번호' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'), substring(s.source_raw->>'세금계산서발행(예정)일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'))`;

async function loadSales(dbx: Dbx) {
  return rows(dbx, sql`SELECT s.id, s.source_raw->>'판매번호' sale_no, s.company_name, s.product_name, s.total_amount, ${SALE_DATE} sale_date,
    nullif(btrim(s.source_raw->>'영업담당자'),'') pm FROM legacy_archive_rows s WHERE s.source_type = 'sales_list' AND s.is_effective`);
}

export interface LateLink { saleRowId: number; saleNo: string | null; progressRowId: number; key: string; method: string }

/** 연결 보정 대상 — 유효 진행행 중 유효 판매에 연결되지 않은 행을, 같은 키의 유효 판매가 정확히 1건일 때만 */
export async function planLateLinks(dbx: Dbx, opts: { progressIds?: number[] } = {}): Promise<{ links: LateLink[]; collisions: Map<string, number[]> }> {
  const sales = await loadSales(dbx);
  const salesByKey = new Map<string, any[]>();
  for (const s of sales) { const k = saleLinkKey(s.company_name, s.product_name, s.total_amount, s.sale_date); if (!k) continue; (salesByKey.get(k.key) ?? salesByKey.set(k.key, []).get(k.key)!).push(s); }
  const only = opts.progressIds?.length ? sql`AND p.id IN (${sql.join(opts.progressIds.map(i => sql`${i}`), sql`, `)})` : sql``;
  const prog = await rows(dbx, sql`SELECT p.id, p.source_raw->>'거래처명' c, p.source_raw->>'상품명' pr, p.source_raw->>'총액' a, p.source_raw->>'체결일' d
    FROM legacy_archive_rows p WHERE p.source_type = 'progress' AND p.is_effective ${only}
      AND NOT EXISTS (SELECT 1 FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id AND s.is_effective
        WHERE l.progress_row_id = p.id AND l.decision = 'confirmed')`);
  const links: LateLink[] = []; const collisions = new Map<string, number[]>();
  for (const p of prog) {
    const k = saleLinkKey(p.c, p.pr, p.a, p.d); if (!k) continue;
    const ss = salesByKey.get(k.key) ?? [];
    if (ss.length === 1) links.push({ saleRowId: Number(ss[0].id), saleNo: ss[0].sale_no ?? null, progressRowId: Number(p.id), key: k.key, method: k.method });
    else if (ss.length > 1) collisions.set(k.key, ss.map(s => Number(s.id)));
  }
  return { links, collisions };
}

export type ContactClass = "A" | "B" | "C";
export interface SaleContactResult {
  saleRowId: number; saleNo: string | null; company: string | null; product: string | null; total: number | null; saleDate: string | null;
  cls: ContactClass; reason: string;
  customerName?: string; tels?: string[];                                  // A
  candidates?: string[]; keyShared?: number;                               // B
  master?: "exact" | "uncertain" | "none"; masterWhy?: string; contactId?: number; companyId?: number | null;
  basis?: "single" | "single_intl" | "multi";                            // exact 근거: 동명 1명 / 동명 1명(국제형식 정규화) / 동명 복수 중 개인번호 식별
  candidateContactId?: number;                                             // 동명 1명이지만 번호로 확인되지 않은 연결 후보(자동 연결 안 함)
  alreadyLinked?: "supplement" | "auto" | "project" | null;
  // 이름 기준 연결용(추가 필드) — 같은 거래처 동명 활성 Master id / 비활성 동명 수 / 원본 개인번호(공용 제외) / 운영 전환 여부 / 기존 연결 담당자
  sameNameIds?: number[]; inactiveSameName?: number; personalTels?: string[];
  converted?: boolean; linkedContactId?: number | null;
}

/** 전체 판매건 분류(읽기 전용) — 연결 보정 이후 상태 기준 */
export async function classifySales(dbx: Dbx): Promise<SaleContactResult[]> {
  const sales = await loadSales(dbx);
  const links = await rows(dbx, sql`SELECT l.sale_row_id, p.source_raw->>'고객명' cust, p.source_raw->>'연락처' tel
    FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective WHERE l.decision = 'confirmed'`);
  const bySale = new Map<number, any[]>();
  for (const l of links) (bySale.get(Number(l.sale_row_id)) ?? bySale.set(Number(l.sale_row_id), []).get(Number(l.sale_row_id))!).push(l);
  // 같은 키의 판매 복수(B) — 연결 없는 판매의 후보 진행행
  const salesByKey = new Map<string, number>();
  for (const s of sales) { const k = saleLinkKey(s.company_name, s.product_name, s.total_amount, s.sale_date); if (k) salesByKey.set(k.key, (salesByKey.get(k.key) ?? 0) + 1); }
  const progByKey = new Map<string, any[]>();
  for (const p of await rows(dbx, sql`SELECT p.id, p.source_raw->>'거래처명' c, p.source_raw->>'상품명' pr, p.source_raw->>'총액' a, p.source_raw->>'체결일' d, p.source_raw->>'고객명' cust
      FROM legacy_archive_rows p WHERE p.source_type = 'progress' AND p.is_effective`)) {
    const k = saleLinkKey(p.c, p.pr, p.a, p.d); if (k) (progByKey.get(k.key) ?? progByKey.set(k.key, []).get(k.key)!).push(p);
  }
  // 기존 연결(수동·자동 보완, 전환 판매의 담당자)
  const mapRows = await rows(dbx, sql`SELECT legacy_id, entity_id, match_method FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale_contact' AND status = 'active'`);
  const maps = new Map(mapRows.map(m => [String(m.legacy_id), AUTO_METHODS.includes(m.match_method) ? "auto" : "supplement"] as const));
  const mapContact = new Map(mapRows.map(m => [String(m.legacy_id), Number(m.entity_id)]));
  const acts = new Map((await rows(dbx, sql`SELECT m.legacy_id, p.company_id, p.contact_id FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id
      WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active'`)).map(a => [String(a.legacy_id), a]));
  const contacts = await rows(dbx, sql`SELECT id, company_id, name, phone, mobile, office_phone FROM contacts WHERE deleted_at IS NULL AND is_active`);
  const inactiveByCo = new Map<number, any[]>();
  for (const c of await rows(dbx, sql`SELECT id, company_id, name FROM contacts WHERE deleted_at IS NULL AND NOT is_active`))
    (inactiveByCo.get(Number(c.company_id)) ?? inactiveByCo.set(Number(c.company_id), []).get(Number(c.company_id))!).push(c);
  const sharedOf = await loadPhoneIndex(dbx);
  const companyPhone = new Map((await rows(dbx, sql`SELECT id, phone FROM companies WHERE deleted_at IS NULL`)).map(c => [Number(c.id), c.phone as string | null]));
  const byCo = new Map<number, any[]>();
  for (const c of contacts) (byCo.get(Number(c.company_id)) ?? byCo.set(Number(c.company_id), []).get(Number(c.company_id))!).push(c);
  // 거래처 Master 판정 — 전환 미리보기(matchCompany)와 같은 규칙: 정규화 거래처명·별칭이 정확히 1곳일 때만
  const coIndex = new Map<string, Set<number>>();
  const addCo = (k: string, id: number) => { if (k) (coIndex.get(k) ?? coIndex.set(k, new Set()).get(k)!).add(id); };
  for (const c of await rows(dbx, sql`SELECT id, name FROM companies WHERE deleted_at IS NULL`)) addCo(normalizeCompanyName(c.name), Number(c.id));
  for (const a of await rows(dbx, sql`SELECT ca.company_id id, ca.normalized_alias k FROM company_aliases ca JOIN companies c ON c.id = ca.company_id AND c.deleted_at IS NULL`)) addCo(String(a.k ?? ""), Number(a.id));

  const out: SaleContactResult[] = [];
  for (const s of sales) {
    const base = { saleRowId: Number(s.id), saleNo: s.sale_no ?? null, company: s.company_name ?? null, product: s.product_name ?? null,
      total: s.total_amount != null ? Number(s.total_amount) : null, saleDate: s.sale_date ?? null };
    const act = s.sale_no ? acts.get(String(s.sale_no)) : undefined;
    const alreadyLinked = (s.sale_no && maps.get(String(s.sale_no))) || (act?.contact_id ? "project" : null);
    const linkFields = { converted: !!act, linkedContactId: act ? (act.contact_id ? Number(act.contact_id) : null) : (s.sale_no ? mapContact.get(String(s.sale_no)) ?? null : null) };
    const ls = bySale.get(Number(s.id)) ?? [];
    if (!ls.length) {
      const k = saleLinkKey(s.company_name, s.product_name, s.total_amount, s.sale_date);
      const cand = k ? progByKey.get(k.key) ?? [] : [];
      const shared = k ? salesByKey.get(k.key) ?? 0 : 0;
      if (cand.length && shared > 1) {
        const names = [...new Set(cand.map(p => String(p.cust ?? "").trim()).filter(n => n && !invalidCustomerName(n)))];
        out.push({ ...base, ...linkFields, cls: "B", candidates: names, keyShared: shared, alreadyLinked,
          reason: `연결키(거래처·상품·총액·판매일)가 같은 판매 ${shared}건 — 의뢰건 식별 불확실` });
      } else out.push({ ...base, ...linkFields, cls: "C", alreadyLinked, reason: cand.length ? "진행관리표 후보 연결 불가" : "연결된 진행관리표 행 없음" });
      continue;
    }
    const names = new Map<string, { raw: string; tels: Set<string> }>(); const invalid: string[] = [];
    for (const l of ls) {
      const why = invalidCustomerName(l.cust);
      if (why) { if (why !== "빈값") invalid.push(`${String(l.cust).trim()}(${why})`); continue; }
      const k = personKey(l.cust);
      if (s.pm && k === personKey(s.pm)) { invalid.push(`${String(l.cust).trim()}(영업담당자와 같음)`); continue; }   // 내부 PM 은 고객 담당자가 아니다
      const e = names.get(k) ?? { raw: String(l.cust).trim(), tels: new Set<string>() };
      if (digits(l.tel).length >= 7) e.tels.add(digits(l.tel));
      names.set(k, e);
    }
    if (!names.size) { out.push({ ...base, ...linkFields, cls: "C", alreadyLinked, reason: invalid.length ? `고객명 무효: ${[...new Set(invalid)].join(", ")}` : "연결 진행행에 고객명 없음" }); continue; }
    if (names.size > 1) { out.push({ ...base, ...linkFields, cls: "B", candidates: [...names.values()].map(n => n.raw), alreadyLinked, reason: `연결 진행행의 고객명 ${names.size}명` }); continue; }
    const [nk, nv] = [...names.entries()][0];
    const r: SaleContactResult = { ...base, ...linkFields, cls: "A", reason: "연결 진행행 고객명 1명", customerName: nv.raw, tels: [...nv.tels], alreadyLinked };
    // 담당자 Master 판정 — 거래처와 담당자를 한 세트로 검증
    let coId: number | null = act?.company_id ? Number(act.company_id) : null;
    if (!coId) {
      const hit = coIndex.get(normalizeCompanyName(s.company_name ?? ""));
      if (hit?.size === 1) coId = [...hit][0]; else { r.master = "uncertain"; r.masterWhy = hit && hit.size > 1 ? "거래처 후보 복수" : "거래처 Master 없음"; out.push(r); continue; }
    }
    r.companyId = coId;
    const pool = byCo.get(coId) ?? [];
    const telOf = (c: any) => [c.phone, c.mobile, c.office_phone].map(digits).filter(t => t.length >= 7);
    const nTelOf = (c: any) => [c.phone, c.mobile, c.office_phone].map(normPhone).filter(t => t.length >= 7);
    const same = pool.filter(c => personKey(c.name) === nk);
    const telHit = (c: any) => telOf(c).some(t => nv.tels.has(t));
    const nTels = new Set([...nv.tels].map(normPhone));
    const nTelHit = (c: any) => nTelOf(c).some(t => nTels.has(t));
    // 개인번호 = 원본 번호 중 공용번호(대표번호·같은 거래처 여러 고객명·다른 거래처 사용)가 아닌 것
    const personal = new Set([...nTels].filter(t => !sharedOf(s.company_name, t, companyPhone.get(coId!))));
    r.sameNameIds = same.map(c => Number(c.id));
    r.inactiveSameName = (inactiveByCo.get(coId) ?? []).filter(c => personKey(c.name) === nk).length;
    r.personalTels = [...personal];
    if (same.length === 1 && telHit(same[0])) { r.master = "exact"; r.basis = "single"; r.masterWhy = "같은 거래처 동명 1명 + 연락처 일치"; r.contactId = Number(same[0].id); }
    else if (same.length === 1 && nTelHit(same[0])) { r.master = "exact"; r.basis = "single_intl"; r.masterWhy = "같은 거래처 동명 1명 + 연락처 일치(국제형식 정규화)"; r.contactId = Number(same[0].id); }
    else if (same.length === 1) { r.master = "uncertain"; r.candidateContactId = Number(same[0].id); r.masterWhy = nv.tels.size && telOf(same[0]).length ? "동명 1명 — 연락처 불일치" : "동명 1명 — 대조할 연락처 없음"; }
    else if (same.length > 1) {
      const hits = same.filter(c => nTelOf(c).some(t => personal.has(t)));
      if (hits.length === 1) { r.master = "exact"; r.basis = "multi"; r.masterWhy = `같은 거래처 동명 ${same.length}명 중 원본 개인번호 일치 1명`; r.contactId = Number(hits[0].id); }
      else { r.master = "uncertain"; r.masterWhy = `동명 ${same.length}명(동명이인 가능)`; }
    }
    else { r.master = "none"; r.masterWhy = pool.some(telHit) ? "동명 없음 — 같은 번호의 다른 이름 담당자" : "거래처에 동명 담당자 없음"; }
    out.push(r);
  }
  return out;
}

export function summarize(list: SaleContactResult[]) {
  const n = (f: (r: SaleContactResult) => boolean) => list.filter(f).length;
  return {
    total: list.length, A: n(r => r.cls === "A"), B: n(r => r.cls === "B"), C: n(r => r.cls === "C"),
    masterExact: n(r => r.cls === "A" && r.master === "exact"),
    masterExactLinkable: n(r => r.cls === "A" && r.master === "exact" && !r.alreadyLinked),
    nameOnly: n(r => r.cls === "A" && r.master !== "exact"),
    alreadyLinked: n(r => !!r.alreadyLinked),
    exactByBasis: { single: n(r => r.master === "exact" && r.basis === "single"), singleIntl: n(r => r.master === "exact" && r.basis === "single_intl"), multi: n(r => r.master === "exact" && r.basis === "multi") },
    candidates: n(r => r.cls === "A" && r.master === "uncertain" && !!r.candidateContactId),
  };
}

/**
 * 복원 실행(같은 트랜잭션). saleNos 를 주면 그 판매건만(소규모 표본 검증). 재실행 안전:
 *  · 연결 보정은 (sale_row_id, progress_row_id) 고유키로 중복 없음
 *  · 자동 연결은 판매번호당 sale_contact 1건(고유키) — 이미 있으면(수동·자동 모두) 건드리지 않음
 */
export async function applyRestore(tx: Dbx, opts: { userId: number | null; saleNos?: string[]; bases?: Array<"single" | "single_intl" | "multi"> }) {
  // 자동 연결에 쓸 근거 — 기본은 기존 기준(single)과 승인된 동명 복수 식별(multi). 국제형식 정규화 일치(single_intl)는 별도 승인 시에만.
  const bases = new Set(opts.bases?.length ? opts.bases : ["single", "multi"]);
  const only = opts.saleNos?.length ? new Set(opts.saleNos) : null;
  const [batch] = await rows(tx, sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
    VALUES (${RESTORE_MODULE}, 'contact_restore', ${only ? `표본 ${only.size}건` : "전체"}, 0, 0, 'running', ${opts.userId}, 'old_crm', false) RETURNING id`);
  const batchId = Number(batch.id);
  const lineage: any[] = [];

  // 1) 연결 보정
  const { links } = await planLateLinks(tx);
  let lateLinks = 0;
  for (const l of links) {
    if (only && !(l.saleNo && only.has(l.saleNo))) continue;
    const [ins] = await rows(tx, sql`INSERT INTO legacy_sales_progress_links (sale_row_id, progress_row_id, sale_no, match_key, match_method, decision)
      VALUES (${l.saleRowId}, ${l.progressRowId}, ${l.saleNo}, ${l.key}, ${LATE_LINK_METHOD}, 'confirmed') ON CONFLICT (sale_row_id, progress_row_id) DO NOTHING RETURNING id`);
    if (ins) { lateLinks++; lineage.push({ entityId: Number(ins.id), rowKey: `link:${ins.id}`, status: "late_link", legacyId: l.saleNo, sourceRaw: { saleRowId: l.saleRowId, progressRowId: l.progressRowId, key: l.key, keyMethod: l.method } }); }
  }

  // 2) 분류 + 3) 담당자 Master 자동 연결(정확 일치만)
  const all = await classifySales(tx);
  const list = only ? all.filter(r => r.saleNo && only.has(r.saleNo)) : all;
  let masterLinked = 0;
  for (const r of list) {
    if (r.cls === "A" && r.master === "exact" && r.basis && bases.has(r.basis) && !r.alreadyLinked && r.saleNo && r.contactId) {
      const [ins] = await rows(tx, sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, import_batch_id, match_method, status, created_by)
        VALUES ('old_crm', 'sale_contact', ${r.saleNo}, ${r.contactId}, ${batchId}, ${r.basis === "multi" ? AUTO_CONTACT_MULTI_METHOD : AUTO_CONTACT_METHOD}, 'active', ${opts.userId})
        ON CONFLICT (source_system, entity_type, legacy_id) DO NOTHING RETURNING id`);
      if (ins) { masterLinked++; lineage.push({ entityId: Number(ins.id), rowKey: `sale_contact:${r.saleNo}`, status: "master_linked", legacyId: r.saleNo,
        sourceRaw: { saleRowId: r.saleRowId, contactId: r.contactId, companyId: r.companyId, customerName: r.customerName, basis: r.masterWhy, basisCode: r.basis } }); }
    } else if (r.cls === "B") {
      lineage.push({ entityId: r.saleRowId, rowKey: `sale:${r.saleNo}`, status: "review", legacyId: r.saleNo, sourceRaw: { reason: r.reason, candidates: r.candidates ?? [], keyShared: r.keyShared ?? null } });
    } else if (r.cls === "C") {
      lineage.push({ entityId: r.saleRowId, rowKey: `sale:${r.saleNo}`, status: "unverified", legacyId: r.saleNo, sourceRaw: { reason: r.reason } });
    }
  }
  for (let i = 0; i < lineage.length; i += 500) {
    const chunk = lineage.slice(i, i + 500);
    await tx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw) VALUES
      ${sql.join(chunk.map(x => sql`(${batchId}, ${RESTORE_MODULE}, ${x.entityId}, ${x.rowKey}, ${x.status}, 'old_crm', ${x.legacyId}, ${JSON.stringify(x.sourceRaw)}::jsonb)`), sql`, `)}`);
  }
  // 확인 필요·미확인 목록은 최신 전체 실행 배치를 기준으로 본다(표본 실행은 기준 배치를 바꾸지 않음)
  if (!only) await tx.execute(sql`UPDATE import_batches SET is_current = (id = ${batchId}) WHERE module = ${RESTORE_MODULE}`);
  const summary = { ...summarize(list), lateLinks, masterLinked, bases: [...bases] };
  await tx.execute(sql`UPDATE import_batches SET total_rows = ${list.length}, success_rows = ${lateLinks + masterLinked}, status = 'completed', headers_json = ${JSON.stringify(summary)}::jsonb WHERE id = ${batchId}`);
  return { batchId, ...summary };
}

/** 되돌리기 — 이 배치가 만든 연결 보정·자동 담당자 연결만 제거(수동 보완·기존 연결은 그대로) */
export async function rollbackRestore(tx: Dbx, batchId: number) {
  const linkIds = (await rows(tx, sql`SELECT entity_id FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${RESTORE_MODULE} AND status = 'late_link'`)).map(r => Number(r.entity_id));
  const delLinks = linkIds.length ? await tx.execute(sql`DELETE FROM legacy_sales_progress_links WHERE match_method = ${LATE_LINK_METHOD} AND id IN (${sql.join(linkIds.map(i => sql`${i}`), sql`, `)})`) : { rowCount: 0 };
  const delMaps = await tx.execute(sql`DELETE FROM legacy_master_mappings WHERE entity_type = 'sale_contact' AND match_method IN (${sql.join(AUTO_METHODS.map(m => sql`${m}`), sql`, `)}) AND import_batch_id = ${batchId}`);
  // 이 배치가 신규 등록한 담당자 — 다른 곳(수동 연결·판매·견적·의뢰·입금)에서 쓰이지 않을 때만 삭제, 쓰이면 남기고 보고
  const created = (await rows(tx, sql`SELECT entity_id FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${RESTORE_MODULE} AND status = 'contact_created'`)).map(r => Number(r.entity_id));
  const kept: number[] = []; let contactsRemoved = 0;
  for (const id of created) {
    const [used] = await rows(tx, sql`SELECT (EXISTS (SELECT 1 FROM legacy_master_mappings WHERE entity_type IN ('sale_contact') AND entity_id = ${id})
      OR EXISTS (SELECT 1 FROM projects WHERE contact_id = ${id}) OR EXISTS (SELECT 1 FROM quotes WHERE derived_contact_id = ${id})
      OR EXISTS (SELECT 1 FROM inquiries WHERE contact_id = ${id}) OR EXISTS (SELECT 1 FROM project_payments WHERE billing_contact_id = ${id})) used`);
    if (used?.used) { kept.push(id); continue; }
    contactsRemoved += (await tx.execute(sql`DELETE FROM contacts WHERE id = ${id}`)).rowCount ?? 0;
  }
  await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back', is_current = false WHERE id = ${batchId} AND module = ${RESTORE_MODULE}`);
  return { batchId, linksRemoved: delLinks.rowCount ?? 0, mappingsRemoved: delMaps.rowCount ?? 0, contactsRemoved, contactsKept: kept };
}

// ─── 이름 기준 전체 자동 연결 ─────────────────────────────────────────────────────
export type NameLinkException = "no_name" | "multiple_names" | "company_unresolved" | "duplicate_master" | "inactive_master" | "linked_conflict" | "converted_unlinked";
export const NAME_LINK_EXCEPTION_LABEL: Record<NameLinkException, string> = {
  no_name: "고객명 없음·무효", multiple_names: "고객명 복수 또는 의뢰건 식별 불확실", company_unresolved: "거래처 Master 미확정(없음·후보 복수)",
  duplicate_master: "같은 거래처 동명 담당자 Master 2명 이상", inactive_master: "같은 거래처 동명 담당자가 비활성 상태로만 존재",
  linked_conflict: "기존 연결 담당자 이름이 원본 고객명과 다름", converted_unlinked: "운영 판매로 전환된 건(담당자 미지정) — 운영 데이터라 자동 변경 제외",
};
export interface NameLinkPlan {
  existing: Array<{ saleNo: string; saleRowId: number; contactId: number; companyId: number }>;           // 동명 Master 1명(또는 개인번호로 1명 식별)에 연결
  creates: Array<{ key: string; companyId: number; name: string; phone: { mobile: string | null; phone: string | null }; phoneConflict: string[]; sales: Array<{ saleNo: string; saleRowId: number }> }>;
  exceptions: Array<{ saleNo: string | null; saleRowId: number; company: string | null; companyId: number | null; customerName: string | null; reason: NameLinkException; detail: string; linkedContactId: number | null }>;
  alreadyLinkedOk: number; total: number;
  individualNoContact: number;   // 개인 고객 거래처(INDIVIDUAL) — 기존 구조처럼 담당자를 만들지 않고 거래처 연결만으로 둔다
}
// 저장할 이름 — 원문에서 끝의 직함·존칭만 뗀다(대소문자·띄어쓰기 유지)
const TITLE_TAIL_RE = /\s*(대표이사|대표|부사장|사장|전무|상무|이사|본부장|센터장|원장|소장|국장|부장|차장|과장|팀장|실장|대리|주임|사원|연구원|선임|책임|수석|선생|교수|박사|매니저|위원|담당)?\s*님?$/;
export function displayName(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 2; i++) { const t = s.replace(TITLE_TAIL_RE, "").trim(); if (t.replace(/\s/g, "").length >= 2) s = t; }
  return s;
}

/** 이름 기준 연결 계획(읽기 전용) — 판매건 고유 판매번호 기준, 진행관리표 행은 근거로만 쓴다 */
export async function planNameLinks(dbx: Dbx): Promise<NameLinkPlan> {
  const list = await classifySales(dbx);
  const linkedNames = new Map((await rows(dbx, sql`SELECT id, name, deleted_at FROM contacts`)).map(c => [Number(c.id), c]));
  const plan: NameLinkPlan = { existing: [], creates: [], exceptions: [], alreadyLinkedOk: 0, total: list.length, individualNoContact: 0 };
  const individualCos = new Set((await rows(dbx, sql`SELECT id FROM companies WHERE customer_type = 'INDIVIDUAL' AND deleted_at IS NULL`)).map(c => Number(c.id)));
  const groups = new Map<string, NameLinkPlan["creates"][number] & { names: Map<string, number>; tels: Set<string> }>();
  const ex = (r: SaleContactResult, reason: NameLinkException, detail: string) => plan.exceptions.push({ saleNo: r.saleNo, saleRowId: r.saleRowId, company: r.company,
    companyId: r.companyId ?? null, customerName: r.customerName ?? null, reason, detail, linkedContactId: r.linkedContactId ?? null });
  for (const r of list) {
    if (r.alreadyLinked) {
      // 기존 연결은 그대로 둔다. 원본 고객명과 다른 이름의 담당자에 연결돼 있으면 충돌로만 보고한다.
      const c = r.linkedContactId ? linkedNames.get(r.linkedContactId) : null;
      if (r.cls === "A" && r.customerName && (!c || c.deleted_at || personKey(c.name) !== personKey(r.customerName)))
        ex(r, "linked_conflict", `연결 담당자 ${c ? `'${c.name}'(#${c.id})${c.deleted_at ? " 삭제됨" : ""}` : "없음"} ↔ 원본 '${r.customerName}'`);
      else plan.alreadyLinkedOk++;
      continue;
    }
    if (r.converted) { ex(r, "converted_unlinked", "운영 판매(projects)의 담당자는 판매 상세에서 지정"); continue; }
    if (r.cls === "C") { ex(r, "no_name", r.reason); continue; }
    if (r.cls === "B") { ex(r, "multiple_names", `${r.reason}${r.candidates?.length ? ` (${r.candidates.join(", ")})` : ""}`); continue; }
    if (!r.saleNo) { ex(r, "no_name", "판매번호 없음"); continue; }
    if (!r.companyId) { ex(r, "company_unresolved", r.masterWhy ?? "거래처 Master 없음"); continue; }
    const same = r.sameNameIds ?? [];
    // 동명 1명 → 연결(번호 불일치·번호 없음 무관). 동명 복수 중 원본 개인번호로 1명 식별된 기존 규칙(exact/multi)도 연결.
    const target = same.length === 1 ? same[0] : r.master === "exact" && r.contactId ? r.contactId : null;
    if (target) { plan.existing.push({ saleNo: r.saleNo, saleRowId: r.saleRowId, contactId: target, companyId: r.companyId }); continue; }
    if (same.length > 1) { ex(r, "duplicate_master", `동명 담당자 #${same.join(", #")}`); continue; }
    if (individualCos.has(r.companyId)) { plan.individualNoContact++; continue; }
    if (r.inactiveSameName) { ex(r, "inactive_master", `비활성 동명 담당자 ${r.inactiveSameName}명 — 재활성 또는 신규 등록 판단 필요`); continue; }
    const key = `${r.companyId}|${personKey(r.customerName)}`;
    const g = groups.get(key) ?? groups.set(key, { key, companyId: r.companyId, name: "", phone: { mobile: null, phone: null }, phoneConflict: [], sales: [], names: new Map(), tels: new Set() }).get(key)!;
    g.sales.push({ saleNo: r.saleNo, saleRowId: r.saleRowId });
    const dn = displayName(r.customerName!); g.names.set(dn, (g.names.get(dn) ?? 0) + 1);
    for (const t of r.personalTels ?? []) if (phoneType(t) !== "unknown" && phoneType(t) !== "rep") g.tels.add(t);
  }
  for (const g of groups.values()) {
    // 이름: 가장 많이 쓰인 표기(동률이면 먼저 나온 표기)
    g.name = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // 연락처: 원본 개인번호가 휴대·일반 각각 1개로 일치할 때만 채운다. 여러 개면 비우고 충돌로 기록(임의 선택 안 함)
    const mobiles = [...g.tels].filter(t => phoneType(t) === "mobile"); const lands = [...g.tels].filter(t => phoneType(t) === "landline");
    g.phone = { mobile: mobiles.length === 1 ? mobiles[0] : null, phone: lands.length === 1 ? lands[0] : null };
    g.phoneConflict = [...(mobiles.length > 1 ? mobiles : []), ...(lands.length > 1 ? lands : [])];
    const { names: _n, tels: _t, ...out } = g;
    plan.creates.push(out);
  }
  return plan;
}

export function summarizeNameLinks(p: NameLinkPlan) {
  const byReason: Record<string, number> = {};
  for (const e of p.exceptions) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  return {
    individualNoContact: p.individualNoContact,
    total: p.total, alreadyLinked: p.alreadyLinkedOk + p.exceptions.filter(e => e.reason === "linked_conflict").length,
    linkExisting: p.existing.length, newContacts: p.creates.length, linkNew: p.creates.reduce((n, g) => n + g.sales.length, 0),
    newContactsWithPhoneConflict: p.creates.filter(g => g.phoneConflict.length).length,
    exceptions: p.exceptions.length, byReason,
  };
}

/**
 * 이름 기준 전체 자동 연결 실행(한 트랜잭션 — 오류 시 전체 롤백, 재실행 가능).
 *  · 모듈 잠금으로 동시 실행 방지. 실행 직전 계획을 다시 계산한다(재실행 시 이미 연결된 건·이미 등록된 담당자는 기존 연결로 처리 → 중복 없음).
 *  · 기존 연결·담당자·거래처·원본은 수정하지 않는다. 새로 쓰는 것은 contacts(신규 담당자)와 legacy_master_mappings(sale_contact)뿐.
 *  · 예외는 import_row_sources(review/unverified)로 남겨 판매관리 '확인 필요' 표시와 검토 목록에 쓰인다.
 */
export async function applyNameLinks(tx: Dbx, opts: { userId: number | null }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RESTORE_MODULE + ":name_link"}))`);
  const plan = await planNameLinks(tx);
  const [batch] = await rows(tx, sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
    VALUES (${RESTORE_MODULE}, 'contact_name_link', '전체(이름 기준)', 0, 0, 'running', ${opts.userId}, 'old_crm', false) RETURNING id`);
  const batchId = Number(batch.id);
  const lineage: any[] = [];
  const link = async (saleNo: string, contactId: number, method: string) => (await rows(tx, sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, import_batch_id, match_method, status, created_by)
    VALUES ('old_crm', 'sale_contact', ${saleNo}, ${contactId}, ${batchId}, ${method}, 'active', ${opts.userId}) ON CONFLICT (source_system, entity_type, legacy_id) DO NOTHING RETURNING id`))[0];
  let linkedExisting = 0, linkedNew = 0, contactsCreated = 0;
  for (const e of plan.existing) {
    const ins = await link(e.saleNo, e.contactId, AUTO_NAME_METHOD);
    if (ins) { linkedExisting++; lineage.push({ entityId: Number(ins.id), rowKey: `sale_contact:${e.saleNo}`, status: "master_linked", legacyId: e.saleNo,
      sourceRaw: { saleRowId: e.saleRowId, contactId: e.contactId, companyId: e.companyId, created: false } }); }
  }
  for (const g of plan.creates) {
    const memo = `과거 CRM 자동 등록(이름 기준, 판매 ${g.sales.length}건)${g.phoneConflict.length ? ` — 원본 연락처 복수: ${g.phoneConflict.join(", ")}` : ""}`;
    const [c] = await rows(tx, sql`INSERT INTO contacts (company_id, name, phone, mobile, memo) VALUES (${g.companyId}, ${g.name}, ${g.phone.phone}, ${g.phone.mobile}, ${memo}) RETURNING id`);
    contactsCreated++;
    lineage.push({ entityId: Number(c.id), rowKey: `contact:${g.key}`, status: "contact_created", legacyId: null,
      sourceRaw: { companyId: g.companyId, name: g.name, phone: g.phone, phoneConflict: g.phoneConflict, saleNos: g.sales.map(x => x.saleNo) } });
    for (const s of g.sales) {
      const ins = await link(s.saleNo, Number(c.id), AUTO_NAME_CREATED_METHOD);
      if (ins) { linkedNew++; lineage.push({ entityId: Number(ins.id), rowKey: `sale_contact:${s.saleNo}`, status: "master_linked", legacyId: s.saleNo,
        sourceRaw: { saleRowId: s.saleRowId, contactId: Number(c.id), companyId: g.companyId, created: true } }); }
    }
  }
  for (const e of plan.exceptions) lineage.push({ entityId: e.saleRowId, rowKey: `sale:${e.saleNo}`, status: e.reason === "no_name" ? "unverified" : "review", legacyId: e.saleNo,
    sourceRaw: { reason: NAME_LINK_EXCEPTION_LABEL[e.reason], reasonCode: e.reason, detail: e.detail, companyId: e.companyId, customerName: e.customerName, linkedContactId: e.linkedContactId } });
  for (let i = 0; i < lineage.length; i += 500) {
    const chunk = lineage.slice(i, i + 500);
    await tx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw) VALUES
      ${sql.join(chunk.map(x => sql`(${batchId}, ${RESTORE_MODULE}, ${x.entityId}, ${x.rowKey}, ${x.status}, 'old_crm', ${x.legacyId}, ${JSON.stringify(x.sourceRaw)}::jsonb)`), sql`, `)}`);
  }
  // 확인 필요·미확인 목록과 판매관리 '확인 필요' 표시는 이 배치를 기준으로 본다
  await tx.execute(sql`UPDATE import_batches SET is_current = (id = ${batchId}) WHERE module = ${RESTORE_MODULE}`);
  const summary = { ...summarizeNameLinks(plan), linkedExisting, linkedNew, contactsCreated };
  await tx.execute(sql`UPDATE import_batches SET total_rows = ${plan.total}, success_rows = ${linkedExisting + linkedNew}, status = 'completed', headers_json = ${JSON.stringify(summary)}::jsonb WHERE id = ${batchId}`);
  return { batchId, ...summary };
}

// ─── 조회용 SQL 조각(판매관리 목록·현재 탭·판매 상세 공통) ─────────────────────────────
// 판매목록 행(alias.id)에 확정 연결된 유효 진행행의 '고객명'이 정확히 1명일 때 그 이름. 무효값·영업담당자 이름은 제외.
export function restoredCustomerNameOfSaleRow(saleRowId: any) {
  return sql<string | null>`(SELECT CASE WHEN count(DISTINCT x.n) = 1 THEN max(x.n) END FROM (
      SELECT btrim(lp.source_raw->>'고객명') n FROM legacy_sales_progress_links ll
        JOIN legacy_archive_rows lp ON lp.id = ll.progress_row_id AND lp.is_effective
        JOIN legacy_archive_rows ls ON ls.id = ll.sale_row_id
      WHERE ll.sale_row_id = ${saleRowId} AND ll.decision = 'confirmed'
        AND btrim(coalesce(lp.source_raw->>'고객명', '')) ~ '[가-힣A-Za-z]'
        AND length(regexp_replace(coalesce(lp.source_raw->>'고객명', ''), '[^0-9]', '', 'g')) < 7
        AND replace(btrim(lp.source_raw->>'고객명'), ' ', '') <> replace(coalesce(ls.source_raw->>'영업담당자', ''), ' ', '')) x)`;
}
// 과거 CRM 에서 전환된 운영 판매(projects.id)의 복원 고객명
export function restoredCustomerNameOfProject(projectId: any) {
  return sql<string | null>`(SELECT ${restoredCustomerNameOfSaleRow(sql`rs.id`)} FROM legacy_master_mappings rm
      JOIN legacy_archive_rows rs ON rs.source_type = 'sales_list' AND rs.is_effective AND rs.source_raw->>'판매번호' = rm.legacy_id
    WHERE rm.source_system = 'old_crm' AND rm.entity_type = 'sale' AND rm.status = 'active' AND rm.entity_id = ${projectId} LIMIT 1)`;
}
// 판매번호에 연결된 담당자 Master(수동 보완·정확 일치 자동 연결) 이름
export function linkedContactNameOfSaleNo(saleNo: any) {
  return sql<string | null>`(SELECT c.name FROM legacy_master_mappings cm JOIN contacts c ON c.id = cm.entity_id AND c.deleted_at IS NULL
    WHERE cm.source_system = 'old_crm' AND cm.entity_type = 'sale_contact' AND cm.status = 'active' AND cm.legacy_id = ${saleNo})`;
}
// 담당자 확인 필요(B) — 최신 전체 복원 배치 기준
export function reviewNeededOfSaleRow(saleRowId: any) {
  return sql`EXISTS (SELECT 1 FROM import_row_sources rr JOIN import_batches rb ON rb.id = rr.batch_id AND rb.is_current AND rb.module = ${RESTORE_MODULE}
    WHERE rr.module = ${RESTORE_MODULE} AND rr.status = 'review' AND rr.entity_id = ${saleRowId})`;
}

// ─── 판매건 1건의 고객 담당자 연락처(출처 구분) ─────────────────────────────────────
//   원본(판매 당시): 확정 연결된 유효 진행행 중 '복원 고객명'과 같은 사람의 행에서만 연락처를 가져온다(다른 사람 번호와 섞지 않음).
//   현재 Master: 이 판매에 연결된 담당자 Master(수동·자동·전환 판매 담당자)의 전화·휴대·사무실·이메일 — 값은 Master 그대로.
//   둘이 달라도 어느 쪽도 덮어쓰거나 지우지 않는다. 연결 후보(같은 거래처 동명 1명, 번호 미확인)는 직원 확인용으로만 준다.
export interface SourcePhone { raw: string; number: string; type: PhoneType; shared: SharedKind }
export async function saleContactInfo(dbx: Dbx, saleNo: string, ctx: { companyId: number | null; companyName: string | null; linkedContactId: number | null; linkVia: string | null }) {
  const ev = await rows(dbx, sql`SELECT btrim(p.source_raw->>'고객명') cust, btrim(p.source_raw->>'연락처') tel, p.source_raw->>'비고' memo, s.source_raw->>'영업담당자' pm
    FROM legacy_archive_rows s JOIN legacy_sales_progress_links l ON l.sale_row_id = s.id AND l.decision = 'confirmed'
    JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
    WHERE s.source_type = 'sales_list' AND s.is_effective AND s.source_raw->>'판매번호' = ${saleNo}`);
  const valid = ev.filter(e => !invalidCustomerName(e.cust) && !(e.pm && personKey(e.cust) === personKey(e.pm)));
  const keys = [...new Set(valid.map(e => personKey(e.cust)))];
  const restoredName = keys.length === 1 ? String(valid[0].cust) : null;
  const rawTels = restoredName ? [...new Set(valid.map(e => String(e.tel ?? "").trim()).filter(t => digits(t).length >= 7))] : [];
  const [co] = ctx.companyId ? await rows(dbx, sql`SELECT phone, email FROM companies WHERE id = ${ctx.companyId}`) : [];
  // 원본 이메일 — 진행관리표에 이메일 칸은 없고, 비고에 '복원 고객명'과 함께 적힌 이메일만 고객 이메일로 본다(통번역사 정보 문구 제외)
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const sourceEmails = restoredName ? [...new Set(valid.filter(e => e.memo && EMAIL_RE.test(e.memo) && String(e.memo).replace(/\s/g, "").includes(restoredName.replace(/\s/g, ""))
    && !/(페이팔|paypal|메일변경|원천세)/i.test(e.memo)).map(e => String(e.memo).match(EMAIL_RE)![0].toLowerCase()))] : [];
  const sharedOf = rawTels.length ? await loadPhoneIndex(dbx, rawTels.map(normPhone)) : () => null;
  const sourcePhones: SourcePhone[] = rawTels.map(raw => { const n = normPhone(raw); return { raw, number: n, type: phoneType(n), shared: sharedOf(ctx.companyName, n, co?.phone ?? null) }; });
  const cols = sql`c.id, c.name, c.position, c.department, c.phone, c.mobile, c.office_phone "officePhone", c.email`;
  const [linked] = ctx.linkedContactId ? await rows(dbx, sql`SELECT ${cols} FROM contacts c WHERE c.id = ${ctx.linkedContactId}`) : [];
  let candidate: any = null;
  if (!linked && restoredName && ctx.companyId) {
    const same = (await rows(dbx, sql`SELECT ${cols} FROM contacts c WHERE c.company_id = ${ctx.companyId} AND c.deleted_at IS NULL AND c.is_active`))
      .filter(c => personKey(c.name) === personKey(restoredName));
    if (same.length === 1) candidate = same[0];
  }
  // 조합 검증: 연결된 Master 이름이 복원 고객명과 다르면 표시(오연결 의심 — 자동 수정하지 않음)
  const nameMismatch = !!(linked && restoredName && personKey(linked.name) !== personKey(restoredName));
  const masterNumbers = linked ? [linked.phone, linked.mobile, linked.officePhone].map(normPhone).filter((t: string) => t.length >= 7) : [];
  // 업무 화면·새 문서에 쓸 담당자 연락처 자동 결정(저장된 원본·Master·거래처 값은 그대로 두고 표시용으로만 고른다)
  //   이메일: 담당자 Master → 과거 CRM 원본(비고) → 거래처 Master. 공유·대표 이메일도 업무용으로 그대로 사용.
  //   연락처: 담당자 Master 휴대·일반 → 원본 개인번호 → 원본 대표·공용번호.
  const nz = (v: unknown) => (v != null && String(v).trim() ? String(v).trim() : null);
  const companyEmail = nz(co?.email);
  const effectiveEmail = nz(linked?.email) ?? sourceEmails[0] ?? companyEmail;
  const effectiveEmailFrom = nz(linked?.email) ? "master" : sourceEmails[0] ? "source" : companyEmail ? "company" : null;
  const ownPhone = sourcePhones.find(p => !p.shared && p.type !== "unknown") ?? null;
  const effectivePhone = nz(linked?.mobile) ?? nz(linked?.phone) ?? nz(linked?.officePhone) ?? ownPhone?.raw ?? sourcePhones[0]?.raw ?? null;
  const effectivePhoneFrom = nz(linked?.mobile) || nz(linked?.phone) || nz(linked?.officePhone) ? "master" : sourcePhones.length ? "source" : null;
  return {
    effectiveEmail, effectiveEmailFrom, effectivePhone, effectivePhoneFrom,
    restoredName, sourcePhones, sourceEmails, companyEmail,   // 거래처 이메일 — 담당자 개인 이메일로 확정하지 않고 출처를 나눠 표시
    linked: linked ?? null, linkVia: linked ? ctx.linkVia : null, candidate, nameMismatch,
    phoneMatchesMaster: linked ? sourcePhones.some(p => masterNumbers.includes(p.number)) : null,
  };
}
