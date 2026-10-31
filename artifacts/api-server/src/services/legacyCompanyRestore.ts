// ─── 과거 CRM 판매 거래처 Master 복원(거래처명 → 거래처 Master) ─────────────────────────────
//
// 과거 CRM 판매목록의 거래처명이 거래처 Master(정규화 이름·별칭)와 정확히 1곳 일치하지 않는 판매를 대상으로 한다.
// 연결은 기존 매핑 구조인 company_aliases(거래처 별칭)로 저장한다 — 판매 원본·거래처 확정 정보는 바꾸지 않는다.
// 별칭이 생기면 판매관리·담당자 연결(classifySales/matchCompany)이 그 거래처로 인식한다.
//
// 판정(그룹 = 정규화 거래처명; 판매 여러 건이어도 거래처 1곳). 위에서부터 먼저 걸리는 규칙을 쓴다.
//  A. 자동 연결(link)
//    confirmed        관리자가 확인한 연결(CONFIRMED_COMPANY_DECISIONS) — 대상 거래처가 살아 있을 때만
//    annotation       과거 CRM 표기 = Master 이름 + 영문 약칭·영문 병기(괄호 등)       예) 한국개발연구원(KDI)
//    master_annotation Master 표기 = 과거 CRM 이름 + 영문 병기                         예) (주)루닛 ↔ (주)루닛 (Lunit Inc.)
//    transliteration  영문 약어를 한글 글자 이름으로 읽은 표기가 Master 1곳과 정확히 같음 예) KT&G ↔ (주)케이티앤지, SK쉴더스 ↔ 에스케이쉴더스
//  B. 관리자 확인(review) — 자동 연결하지 않음
//    part_brand       부분 일치하지만 나머지가 한글 브랜드·행사·지점명 등
//    similar          포함 관계(2글자 이상)·한 글자 차이(오기)·약칭(글자 순서 포함) 후보 — 유사할 뿐 동일성 미확인
//    multi_candidate  일치 Master 2곳 이상 / deleted_master 삭제 거래처와만 일치 / new_overlap 신규끼리 포함 관계
//    generic          '개인고객' 등 여러 고객을 묶은 이름 / no_name 거래처명 없음 / confirmed_missing 확인된 대상 거래처가 없음
//  C. 신규 등록(create) — 후보 없음. 유형: individual(고객명=거래처명 근거) · overseas(해외 법인표기·해외 전화 근거) · domestic · latin_unknown
// 과거 CRM 판매목록·진행관리표에는 사업자등록번호가 없어 번호 기준 판정은 하지 않는다(번호 충돌 판정 대상 없음).
// 별칭의 관계 유형(표기·약칭·영문·과거 상호·합병·오기)은 company_aliases 에 칸이 없어 import_row_sources 근거에 남긴다.
// 실행 기록·근거: import_batches(module=legacy_company_restore) + import_row_sources. 배치 단위 되돌리기 지원.
import { sql } from "drizzle-orm";
import { normalizeCompanyName as N } from "../lib/normalizeCompany";
import { personKey } from "./legacyContactRestore";

export const COMPANY_RESTORE_MODULE = "legacy_company_restore";
type Dbx = { execute: (q: any) => Promise<{ rows: unknown[]; rowCount?: number | null }> };
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];

export type AliasRelation = "notation" | "abbreviation" | "english" | "former_name" | "renamed" | "merger" | "misspelling" | "business_unit";
export const ALIAS_RELATION_LABEL: Record<AliasRelation, string> = {
  notation: "표기 차이", abbreviation: "약칭", english: "영문 명칭", former_name: "과거 상호", renamed: "상호 변경", merger: "합병 관계", misspelling: "오기",
  business_unit: "사업부·지점(세금계산서 발행 사업자)",
};
// 대상 거래처는 DB id 가 아니라 사업자등록번호(+확인용 이름)로 지정한다 — 개발·운영 DB 의 id 가 서로 달라도 같은 법인을 찾도록.
//   실행 시 대상 DB 에서 사업자번호로 살아 있는 거래처를 찾고, 정확히 1곳이며 이름도 확인되면 그 DB 의 id 를 쓴다(resolveConfirmedTarget).
type ConfirmedDecision =
  | { target: { brn: string; name: string }; relation: AliasRelation; note?: string }
  | { create: "individual" | "overseas"; note?: string }
  | { hold: true; note: string };   // 관리자 추가 확인 — 자동 규칙이 연결하더라도 보류
/**
 * 관리자 확인 결정(2026-10-29 샘플 10건 검토). 정규화 거래처명이 정확히 같은 그룹에만 적용한다 — 비슷한 이름으로 넓히지 않는다.
 * 합병·상호 변경은 확인된 관계만 여기에 둔다(법인 병합 아님: 과거 상호를 현재 거래처의 별칭으로 추적).
 */
export const CONFIRMED_COMPANY_DECISIONS: Record<string, ConfirmedDecision> = {
  [N("(주)루닛")]: { target: { brn: "314-86-50626", name: "(주)루닛 (Lunit Inc.)" }, relation: "notation", note: "Master 표기 '(주)루닛 (Lunit Inc.)'" },
  [N("(주)에이디티캡스")]: { target: { brn: "120-86-07747", name: "에스케이쉴더스(주)" }, relation: "merger", note: "과거 상호(에이디티캡스) — 합병 후 에스케이쉴더스(주). 법인 병합 아님" },
  [N("SK쉴더스(주)")]: { target: { brn: "120-86-07747", name: "에스케이쉴더스(주)" }, relation: "english", note: "SK ↔ 에스케이" },
  [N("주한 덴마크 대사관")]: { target: { brn: "106-83-04869", name: "주한덴마아크 대사관" }, relation: "misspelling", note: "Master 표기 '주한덴마아크 대사관'" },
  [N("수협중앙회")]: { target: { brn: "219-82-01220", name: "수산업협동조합중앙회" }, relation: "abbreviation", note: "공식 명칭 수산업협동조합중앙회" },
  [N("KT&G")]: { target: { brn: "306-81-30866", name: "(주)케이티앤지" }, relation: "english", note: "공식 명칭 (주)케이티앤지" },
  [N("이향숙")]: { create: "individual" },
  [N("한영애")]: { create: "individual" },
  [N("김학성")]: { create: "individual" },
  [N("Clyde & CoClasisSingapore Pte. Ltd.")]: { create: "overseas", note: "견적서(2019-07-26) 담당자 Loke Jolie · +6562406162 · jolie.loke@clydeco.com · 170,000원" },
  // 2026-10-29 관리자 확인 — 롯데백화점(잠실점·본점·온라인 등) 거래의 세금계산서 발행 사업자는 롯데쇼핑.
  //   진행관리표 비고에도 '롯데쇼핑으로 계산서 발행'. 롯데백화점 표기는 별칭(사업부·지점 관계)으로 보존, 원본·지점 정보 불변.
  [N("롯데백화점")]: { target: { brn: "104-81-26067", name: "롯데쇼핑(주)" }, relation: "business_unit", note: "롯데백화점 → 발행 사업자 롯데쇼핑(관리자 확인)" },
  // 다른 롯데 계열은 '롯데'라는 이름만으로 통합하지 않는다. 기존 법인과 같은지 확인 전까지 신규 등록도 하지 않고 보류(중복 거래처 방지).
  [N("롯데제과")]: { hold: true, note: "2023년 롯데웰푸드(주)로 상호 변경된 같은 법인일 가능성 — 롯데웰푸드(주) 연결 여부 확인" },
  [N("롯데호텔")]: { hold: true, note: "법인명 (주)호텔롯데의 사업장일 가능성 — 호텔롯데 연결 여부 확인" },
  [N("롯데월드")]: { hold: true, note: "(주)호텔롯데 롯데월드 사업부일 가능성 — 호텔롯데 연결 여부 확인" },
  [N("롯데MCC")]: { hold: true, note: "롯데엠시시(주)와 같은 법인일 가능성 — 연결 여부 확인" },
  [N("롯데인재개발원")]: { hold: true, note: "롯데 계열 교육기관 — 세금계산서 발행 사업자 확인 필요" },
  // 2026-10-29 실행 승인 시 보류 지시 — EMP BELSTAR 가 다른 거래처(이엠피벨스타 #1760)일 수 있음
  [N("(주)한국초저온(EMP BELSTAR)")]: { hold: true, note: "영문 병기 'EMP BELSTAR' 가 이엠피벨스타(주) #1760 일 수 있음 — 관리자 추가 확인" },
};

export type CompanyReviewReason = "admin_hold" | "part_brand" | "similar" | "multi_candidate" | "deleted_master" | "new_overlap" | "generic" | "no_name" | "confirmed_missing";
export const COMPANY_REVIEW_LABEL: Record<CompanyReviewReason, string> = {
  admin_hold: "관리자 추가 확인 보류",
  part_brand: "부분 일치 — 브랜드·행사·지점명 포함(동일 법인 확인 필요)", similar: "유사 거래처 후보(동일성 미확인)",
  multi_candidate: "일치 거래처 Master 2곳 이상", deleted_master: "삭제된 거래처와만 일치", new_overlap: "신규 등록 대상끼리 이름 포함 관계(중복 등록 위험)",
  generic: "여러 고객을 묶은 이름(개인고객 등)", no_name: "거래처명 없음", confirmed_missing: "관리자 확인 대상 거래처를 이 DB 에서 확정할 수 없음(사업자번호·이름 불일치·없음·복수)",
};
export type LinkBasis = "confirmed" | "annotation" | "master_annotation" | "transliteration";
export const LINK_BASIS_LABEL: Record<LinkBasis, string> = {
  confirmed: "관리자 확인", annotation: "과거 CRM 표기에 영문 약칭 병기", master_annotation: "Master 표기에 영문 병기", transliteration: "영문 약어 ↔ 한글 표기 동일",
};
export type CreateKind = "individual" | "overseas" | "domestic" | "latin_unknown";
export const CREATE_KIND_LABEL: Record<CreateKind, string> = {
  individual: "개인 고객(추정 근거 있음)", overseas: "해외 거래처(추정 근거 있음)", domestic: "국내 법인·기관", latin_unknown: "영문명(국내/해외 미확인)",
};
export interface CompanyGroup {
  key: string; name: string; raws: string[]; saleRowIds: number[];
  decision: "link" | "create" | "review";
  companyId?: number; companyName?: string; basis?: LinkBasis; relation?: AliasRelation;           // link
  kind?: CreateKind; customerType?: "CORPORATE" | "INDIVIDUAL";                                 // create
  reason?: CompanyReviewReason; candidates?: Array<{ id: number; name: string; match?: string }>; // review
  detail?: string;
}

const GENERIC = /^(개인|개인고객|개인의뢰|일반고객|기타|미정|없음|고객|미상|테스트|test)$/i;
const ANNOTATION = /^[A-Za-z0-9&.,'\s-]+$/;   // 영문 약칭·영문 표기(예: KDI, LG CNS, Lunit Inc.)
const PARTS_RE = /[\/()（）\[\],]+/;
// 괄호를 나누면 남는 법인표기 조각((주)→'주' 등)은 부분으로 보지 않는다
const LEGAL_FRAGMENT = /^(주|유|사|재|합|복지|의|학|사단|재단|주식회사|유한회사|사단법인|재단법인)$/;
const splitParts = (name: string) => name.split(PARTS_RE).map(p => p.trim()).filter(p => p && !LEGAL_FRAGMENT.test(p));
// 해외에서만 쓰는 법인표기(국내 기업도 영문명에 Co., Ltd.·Inc. 를 쓰므로 그것만으로는 해외로 보지 않는다)
const FOREIGN_LEGAL = /\b(pte|gmbh|plc|s\.?r\.?l|s\.?p\.?a|b\.?v|k\.?k|hk|sdn\.? bhd|pty)\b/i;
const ORG_TAIL = /(청|처|부|원|원장|공단|공사|협회|조합|재단|센터|위원회|학교|대학|병원|의원|은행|회사|그룹|코리아|산업|기획|디자인|전자|화학|제약|물산|건설|증권|보험|협|소|관|국|사|실|팀|시|군|구)$/;
const LETTER: Record<string, string> = { A: "에이", B: "비", C: "씨", D: "디", E: "이", F: "에프", G: "지", H: "에이치", I: "아이", J: "제이", K: "케이", L: "엘", M: "엠",
  N: "엔", O: "오", P: "피", Q: "큐", R: "알", S: "에스", T: "티", U: "유", V: "브이", W: "더블유", X: "엑스", Y: "와이", Z: "제트" };
/** 영문 약어(대문자 2~5자, & 포함)를 한글 글자 이름으로 읽는다 — KT&G → 케이티앤지, SK쉴더스 → 에스케이쉴더스. 약어가 없으면 null */
export function transliterateAcronyms(raw: string): string | null {
  let changed = false;
  const out = raw.replace(/[A-Z&]{2,6}/g, tok => {
    if (!/^[A-Z]+(&[A-Z]+)*$/.test(tok) || tok.replace(/&/g, "").length > 5) return tok;
    changed = true;
    return [...tok].map(ch => (ch === "&" ? "앤" : LETTER[ch])).join("");
  });
  return changed ? out : null;
}
// 편집 거리 ≤ 1 (오기 1글자)
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return diff + (la - i) + (lb - j) <= 1;
}
// 약칭: 짧은 이름의 글자가 긴 이름에 순서대로 모두 있고, 첫 글자·끝 2글자가 같음(수협중앙회 ↔ 수산업협동조합중앙회)
function abbreviationOf(short: string, long: string): boolean {
  if (short.length < 3 || long.length < short.length + 2 || long.length > short.length * 3) return false;
  if (short[0] !== long[0] || short.slice(-2) !== long.slice(-2)) return false;
  let j = 0; for (const ch of long) if (ch === short[j]) j++;
  return j === short.length;
}

const brnKey = (v: unknown) => String(v ?? "").replace(/\D/g, "");
/**
 * 관리자 확인 대상 거래처를 현재 DB 에서 찾는다 — ① 사업자번호 정확 일치 ② (번호로 못 찾으면) 정규화 이름·별칭 정확 일치.
 * 정확히 1곳이고, 번호로 찾았다면 이름(정규화·별칭)도 확인 이름과 맞을 때만 그 id. 아니면 이유와 함께 null(자동 연결 안 함).
 */
export function resolveConfirmedTarget(target: { brn: string; name: string }, live: Array<{ id: number; name: string; brn: string }>, idx: Map<string, Set<number>>):
  { id: number | null; why: string } {
  const byBrn = live.filter(c => c.brn && c.brn === brnKey(target.brn));
  const nameIds = idx.get(N(target.name)) ?? new Set<number>();
  if (byBrn.length > 1) return { id: null, why: `사업자번호 ${target.brn} 거래처 ${byBrn.length}곳` };
  if (byBrn.length === 1) {
    const c = byBrn[0];
    return nameIds.has(c.id) || N(c.name) === N(target.name) ? { id: c.id, why: "사업자번호·이름 일치" }
      : { id: null, why: `사업자번호 ${target.brn} 거래처 이름이 다름('${c.name}')` };
  }
  if (nameIds.size === 1) return { id: [...nameIds][0], why: "사업자번호 미등록 — 이름 정확 일치" };
  return { id: null, why: nameIds.size > 1 ? `'${target.name}' 일치 거래처 ${nameIds.size}곳` : `'${target.name}'(${target.brn}) 거래처 없음` };
}

/** 거래처 미확정 판매 그룹 계획(읽기 전용) */
export async function planCompanyLinks(dbx: Dbx): Promise<CompanyGroup[]> {
  const live = await rows(dbx, sql`SELECT id, name, business_number FROM companies WHERE deleted_at IS NULL`);
  const liveBrn = live.map(c => ({ id: Number(c.id), name: String(c.name), brn: brnKey(c.business_number) }));
  const nameOf = new Map(live.map(c => [Number(c.id), String(c.name)]));
  const idx = new Map<string, Set<number>>();
  const add = (m: Map<string, Set<number>>, k: string, id: number) => { if (k) (m.get(k) ?? m.set(k, new Set()).get(k)!).add(id); };
  for (const c of live) add(idx, N(c.name), Number(c.id));
  for (const a of await rows(dbx, sql`SELECT ca.company_id, ca.normalized_alias FROM company_aliases ca JOIN companies c ON c.id = ca.company_id AND c.deleted_at IS NULL`)) add(idx, String(a.normalized_alias ?? ""), Number(a.company_id));
  // Master 표기의 부분(괄호·영문 병기 분리) — 나머지가 영문 병기뿐인 부분만 '영문 병기' 색인, 그 외 부분은 후보 색인
  const masterAnn = new Map<string, Set<number>>(); const masterPart = new Map<string, Set<number>>();
  // 영문 약어 한글 읽기 색인(Master 쪽도 약어가 있으면 같은 방식으로 읽어 둔다)
  const translit = new Map<string, Set<number>>();
  for (const c of live) {
    const parts = splitParts(String(c.name));
    if (parts.length > 1) for (const p of parts) {
      const k = N(p); if (k.length < 2) continue;
      const rest = parts.filter(x => x !== p);
      add(rest.every(x => ANNOTATION.test(x)) ? masterAnn : masterPart, k, Number(c.id));
    }
    const t = transliterateAcronyms(String(c.name)); if (t) add(translit, N(t), Number(c.id));
    add(translit, N(c.name), Number(c.id));
  }
  const dead = new Map<string, number[]>();
  for (const c of await rows(dbx, sql`SELECT id, name FROM companies WHERE deleted_at IS NOT NULL`)) { const k = N(c.name); if (k && !idx.has(k)) (dead.get(k) ?? dead.set(k, []).get(k)!).push(Number(c.id)); }
  const keys = [...idx.keys()].filter(k => k.length >= 2);

  // 대상: 유효 판매 중 운영 전환되지 않았고 거래처명이 Master 1곳과 정확히 일치하지 않는 것
  const sales = await rows(dbx, sql`SELECT s.id, btrim(coalesce(s.company_name, '')) co FROM legacy_archive_rows s
    WHERE s.source_type = 'sales_list' AND s.is_effective
      AND NOT EXISTS (SELECT 1 FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.legacy_id = s.source_raw->>'판매번호')`);
  const groups = new Map<string, CompanyGroup & { rawCount: Map<string, number> }>();
  for (const s of sales) {
    const key = N(s.co);
    if (key && idx.get(key)?.size === 1) continue;   // 이미 확정
    const g = groups.get(key) ?? groups.set(key, { key, name: "", raws: [], saleRowIds: [], decision: "review", rawCount: new Map() }).get(key)!;
    g.saleRowIds.push(Number(s.id)); g.rawCount.set(s.co, (g.rawCount.get(s.co) ?? 0) + 1);
  }
  // 개인·해외 판정 근거 — 판매에 확정 연결된 진행행의 고객명·연락처
  const evid = new Map<number, Array<{ cust: string; tel: string }>>();
  const ids = [...groups.values()].flatMap(g => g.saleRowIds);
  for (let i = 0; i < ids.length; i += 2000) {
    const chunk = ids.slice(i, i + 2000);
    for (const r of await rows(dbx, sql`SELECT l.sale_row_id sid, btrim(coalesce(p.source_raw->>'고객명', '')) cust, btrim(coalesce(p.source_raw->>'연락처', '')) tel
        FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
        WHERE l.decision = 'confirmed' AND l.sale_row_id IN (${sql.join(chunk.map(x => sql`${x}`), sql`, `)})`))
      (evid.get(Number(r.sid)) ?? evid.set(Number(r.sid), []).get(Number(r.sid))!).push({ cust: r.cust, tel: r.tel });
  }

  const out: CompanyGroup[] = [];
  const cand = (ids: Iterable<number>, match: string) => [...ids].map(id => ({ id, name: nameOf.get(id) ?? "", match }));
  const review = (g: CompanyGroup, reason: CompanyReviewReason, candidates: CompanyGroup["candidates"] = [], detail?: string) =>
    Object.assign(g, { decision: "review" as const, reason, candidates: candidates.slice(0, 8), detail: detail ?? (candidates.length > 8 ? `후보 ${candidates.length}곳(상위 8곳 표시)` : undefined) });
  const link = (g: CompanyGroup, id: number, basis: LinkBasis, relation: AliasRelation, detail?: string) =>
    Object.assign(g, { decision: "link" as const, companyId: id, companyName: nameOf.get(id), basis, relation, detail });
  for (const { rawCount, ...g } of groups.values()) {
    g.raws = [...rawCount.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    g.name = g.raws[0];   // 가장 많이 쓰인 원문 표기(원문 보존 — 영문 법인표기 포함)
    out.push(g);
    // A-1 관리자 확인 결정
    const conf = CONFIRMED_COMPANY_DECISIONS[g.key];
    if (conf && "target" in conf) {
      const t = resolveConfirmedTarget(conf.target, liveBrn, idx);
      if (t.id != null) link(g, t.id, "confirmed", conf.relation, `${conf.note ?? ""} · ${t.why}`.replace(/^ · /, ""));
      else review(g, "confirmed_missing", [], t.why);
      continue;
    }
    if (conf && "hold" in conf) { review(g, "admin_hold", [], conf.note); continue; }
    if (conf && "create" in conf) {
      Object.assign(g, { decision: "create" as const, kind: conf.create, customerType: conf.create === "individual" ? "INDIVIDUAL" : "CORPORATE", detail: `관리자 확인${conf.note ? ` — ${conf.note}` : ""}` });
      continue;
    }
    if (!g.key) { review(g, "no_name"); continue; }
    const hit = idx.get(g.key);
    if (hit && hit.size > 1) { review(g, "multi_candidate", cand(hit, "정확 일치")); continue; }
    if (GENERIC.test(g.key)) { review(g, "generic"); continue; }
    if (dead.has(g.key)) { review(g, "deleted_master", [], `삭제된 거래처 #${dead.get(g.key)!.join(", #")}`); continue; }
    // A-2 과거 CRM 표기 = Master 이름 + 영문 병기(모든 표기에서 같은 1곳)
    const partHits = new Set<number>(); let allAnnotation = true;
    for (const raw of g.raws) {
      const parts = splitParts(raw);
      const matched = parts.filter(p => (idx.get(N(p))?.size ?? 0) > 0);
      for (const p of matched) for (const id of idx.get(N(p))!) partHits.add(id);
      // '/' 는 법인/브랜드 나열(리치몬트코리아/IWC)이라 병기로 보지 않는다
      if (!matched.length || raw.includes("/") || parts.filter(p => !matched.includes(p)).some(p => !ANNOTATION.test(p))) allAnnotation = false;
    }
    if (partHits.size === 1 && allAnnotation) { link(g, [...partHits][0], "annotation", "notation"); continue; }
    // A-3 Master 표기 = 과거 CRM 이름 + 영문 병기
    const ma = masterAnn.get(g.key);
    if (!partHits.size && ma?.size === 1) { link(g, [...ma][0], "master_annotation", "notation"); continue; }
    // A-4 영문 약어 한글 읽기가 Master 1곳과 정확히 같음
    const tr = g.raws.map(transliterateAcronyms).filter((x): x is string => !!x).map(N);
    const trHits = new Set(tr.flatMap(k => [...(translit.get(k) ?? [])]));
    if (!partHits.size && trHits.size === 1) { link(g, [...trHits][0], "transliteration", "english"); continue; }
    // B 후보 — 자동 연결하지 않는다
    if (partHits.size >= 1) { review(g, "part_brand", cand(partHits, "부분 일치")); continue; }
    const sim = new Map<number, string>();
    for (const id of ma ?? []) sim.set(id, "Master 영문 병기(후보 복수)");
    for (const id of masterPart.get(g.key) ?? []) if (!sim.has(id)) sim.set(id, "Master 괄호 안 명칭");
    for (const id of trHits) if (!sim.has(id)) sim.set(id, "영문 약어 한글 표기(후보 복수)");
    for (const k of keys) {
      if (k === g.key) continue;
      const m = (g.key.length >= 2 && k.length >= 2 && (k.includes(g.key) || g.key.includes(k)) && Math.min(k.length, g.key.length) >= (Math.max(k.length, g.key.length) >= 6 ? 3 : 2)) ? "이름 포함"
        : (g.key.length >= 4 && within1(g.key, k)) ? "한 글자 차이(오기 가능)"
        : (abbreviationOf(g.key, k) || abbreviationOf(k, g.key)) ? "약칭 가능" : null;
      if (m) for (const id of idx.get(k)!) if (!sim.has(id)) sim.set(id, m);
    }
    if (sim.size) { review(g, "similar", [...sim.entries()].map(([id, m]) => ({ id, name: nameOf.get(id) ?? "", match: m }))); continue; }
    // C 신규 등록 — 유형 판정(근거가 있을 때만 개인·해외로 분류, 확정 정보로 저장하지 않음)
    const ev = g.saleRowIds.flatMap(id => evid.get(id) ?? []);
    const named = g.saleRowIds.filter(id => (evid.get(id) ?? []).some(e => e.cust));
    const selfNamed = g.saleRowIds.filter(id => (evid.get(id) ?? []).some(e => e.cust && personKey(e.cust) === personKey(g.name)));
    const hangulName = /^[가-힣]{2,4}$/.test(g.name.replace(/\s/g, "")) && !ORG_TAIL.test(g.name.trim());
    const foreignTel = ev.some(e => /^\+(?!82)/.test(e.tel.replace(/\s/g, "")) || /^00(?!82)/.test(e.tel.replace(/\D/g, "")));
    const latinOnly = !/[가-힣]/.test(g.name);
    if (hangulName && named.length && selfNamed.length * 2 >= named.length) {
      Object.assign(g, { decision: "create" as const, kind: "individual" as const, customerType: "INDIVIDUAL" as const, detail: `고객명=거래처명 판매 ${selfNamed.length}/${named.length}건` });
    } else if (latinOnly && !/korea/i.test(g.name) && (FOREIGN_LEGAL.test(g.name) || foreignTel)) {
      Object.assign(g, { decision: "create" as const, kind: "overseas" as const, customerType: "CORPORATE" as const, detail: [FOREIGN_LEGAL.test(g.name) ? "해외 법인표기" : "", foreignTel ? "해외 전화번호" : ""].filter(Boolean).join(" · ") });
    } else {
      Object.assign(g, { decision: "create" as const, kind: latinOnly ? "latin_unknown" as const : "domestic" as const, customerType: "CORPORATE" as const,
        detail: hangulName ? "사람 이름 형태지만 고객명 근거 없음 — 법인·기관으로 분류" : undefined });
    }
  }
  // 신규 등록 대상끼리 포함 관계(3글자 이상)면 둘 다 확인 대상으로 — 같은 거래처를 2곳 만들지 않기 위해(관리자 확인 결정은 제외)
  //  영문 약어 한글 읽기가 다른 미확정 그룹과 같아도(JP성형외과 ↔ 제이피성형외과) 함께 확인 — 재실행 시 결과가 달라지지 않도록
  const creates = out.filter(g => g.decision === "create" && g.key.length >= 3 && !CONFIRMED_COMPANY_DECISIONS[g.key]);
  const trKeys = new Map(out.filter(g => g.decision !== "link").map(g => [g, new Set([g.key, ...g.raws.map(transliterateAcronyms).filter((x): x is string => !!x).map(N)])]));
  const createSet = new Set(creates);
  const flagged = creates.map(a => {
    const ta = trKeys.get(a)!;
    return [a, out.filter(b => b !== a && b.decision !== "link" && b.key && (
      (createSet.has(b) && (b.key.includes(a.key) || a.key.includes(b.key))) || [...trKeys.get(b)!].some(k => ta.has(k))))] as const;
  });
  for (const [a, others] of flagged)   // 판정을 모두 끝낸 뒤 바꾼다(처리 순서에 따라 결과가 달라지지 않게)
    if (others.length) Object.assign(a, { decision: "review" as const, reason: "new_overlap" as const, kind: undefined, customerType: undefined, candidates: [], detail: `함께 확인: ${others.map(o => o.name).join(", ")}` });
  return out;
}

export function summarizeCompanyLinks(groups: CompanyGroup[]) {
  const n = (f: (g: CompanyGroup) => boolean) => ({ groups: groups.filter(f).length, sales: groups.filter(f).reduce((s, g) => s + g.saleRowIds.length, 0) });
  const byReason: Record<string, { groups: number; sales: number }> = {};
  for (const r of Object.keys(COMPANY_REVIEW_LABEL)) { const v = n(g => g.reason === r); if (v.groups) byReason[r] = v; }
  const byBasis: Record<string, { groups: number; sales: number }> = {};
  for (const b of Object.keys(LINK_BASIS_LABEL)) { const v = n(g => g.decision === "link" && g.basis === b); if (v.groups) byBasis[b] = v; }
  const byKind: Record<string, { groups: number; sales: number }> = {};
  for (const k of Object.keys(CREATE_KIND_LABEL)) { const v = n(g => g.decision === "create" && g.kind === k); if (v.groups) byKind[k] = v; }
  return { total: n(() => true), linkExisting: n(g => g.decision === "link"), create: n(g => g.decision === "create"), review: n(g => g.decision === "review"), byBasis, byKind, byReason };
}

/**
 * 실행(한 트랜잭션 — 오류 시 전체 롤백). 재실행 안전: 실행 직전 다시 계획하므로 이미 별칭·거래처가 생긴 그룹은 '이미 확정'으로 빠진다.
 *  · 기존 거래처: company_aliases 에 원문 표기 추가(거래처 확정 정보·다른 별칭은 그대로)
 *  · 신규 거래처: companies 1곳(이름만, customer) + 원문 표기 별칭. 출처는 notes 와 import_row_sources 에 남긴다.
 *  · 판매 원본·진행관리표·담당자는 건드리지 않는다(담당자 연결은 applyNameLinks 로 이어서 한다).
 */
// onlyKeys: 시범 실행 — 지정한 거래처명 그룹(정규화 키)만 처리한다. 확인 필요 목록·is_current 는 건드리지 않는다.
export async function applyCompanyLinks(tx: Dbx, opts: { userId: number | null; onlyKeys?: string[] }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${COMPANY_RESTORE_MODULE}))`);
  const scope = opts.onlyKeys ? new Set(opts.onlyKeys) : null;
  const groups = (await planCompanyLinks(tx)).filter(g => !scope || (scope.has(g.key) && g.decision !== "review"));
  const [batch] = await rows(tx, sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
    VALUES (${COMPANY_RESTORE_MODULE}, ${scope ? "company_link_pilot" : "company_link"}, ${scope ? `시범(거래처 ${scope.size}그룹)` : "전체(거래처명 기준)"}, 0, 0, 'running', ${opts.userId}, 'old_crm', false) RETURNING id`);
  const batchId = Number(batch.id);
  const lineage: any[] = [];
  let aliasesAdded = 0, companiesCreated = 0, salesLinked = 0;
  const addAliases = async (companyId: number, g: CompanyGroup) => {
    for (const raw of g.raws) {
      const [a] = await rows(tx, sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary)
        VALUES (${companyId}, ${raw}, ${N(raw)}, false) ON CONFLICT (company_id, normalized_alias) DO NOTHING RETURNING id`);
      if (a) { aliasesAdded++; lineage.push({ entityId: Number(a.id), rowKey: `alias:${a.id}`, status: "alias_added",
        sourceRaw: { companyId, alias: raw, key: g.key, saleRowIds: g.saleRowIds, basis: g.basis ?? "created", relation: g.relation ?? null, relationLabel: g.relation ? ALIAS_RELATION_LABEL[g.relation] : null, detail: g.detail ?? null } }); }
    }
  };
  for (const g of groups) {
    if (g.decision === "link") {
      await addAliases(g.companyId!, g); salesLinked += g.saleRowIds.length;
    } else if (g.decision === "create") {
      // 유형: 개인 고객만 INDIVIDUAL(근거 있음). 해외·영문명은 국가 칸이 없어 근거를 메모로만 남긴다(추정값을 확정 정보로 저장하지 않음).
      const notes = `과거 CRM 판매 거래처 자동 등록(판매 ${g.saleRowIds.length}건, 배치 ${batchId}) · ${CREATE_KIND_LABEL[g.kind!]}${g.detail ? ` — ${g.detail}` : ""}`;
      const [c] = await rows(tx, sql`INSERT INTO companies (name, notes, is_customer, customer_type) VALUES (${g.name}, ${notes}, true, ${g.customerType ?? "CORPORATE"}) RETURNING id`);
      companiesCreated++;
      lineage.push({ entityId: Number(c.id), rowKey: `company:${g.key}`, status: "company_created", sourceRaw: { name: g.name, raws: g.raws, saleRowIds: g.saleRowIds, kind: g.kind, customerType: g.customerType, detail: g.detail ?? null } });
      // 공식명 기본 별칭(거래처 등록 공통 규칙) + 원문 표기
      await tx.execute(sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary) VALUES (${Number(c.id)}, ${g.name}, ${N(g.name)}, true) ON CONFLICT DO NOTHING`);
      await addAliases(Number(c.id), { ...g, raws: g.raws.filter(r => N(r) !== N(g.name)) });
      salesLinked += g.saleRowIds.length;
    } else {
      lineage.push({ entityId: g.saleRowIds[0] ?? 0, rowKey: `company_review:${g.key}`, status: "review",
        sourceRaw: { name: g.name, raws: g.raws, sales: g.saleRowIds.length, saleRowIds: g.saleRowIds, reason: COMPANY_REVIEW_LABEL[g.reason!], reasonCode: g.reason, candidates: g.candidates ?? [], detail: g.detail ?? null } });
    }
  }
  for (let i = 0; i < lineage.length; i += 500) {
    const chunk = lineage.slice(i, i + 500);
    await tx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw) VALUES
      ${sql.join(chunk.map(x => sql`(${batchId}, ${COMPANY_RESTORE_MODULE}, ${x.entityId}, ${x.rowKey}, ${x.status}, 'old_crm', NULL, ${JSON.stringify(x.sourceRaw)}::jsonb)`), sql`, `)}`);
  }
  if (!scope) await tx.execute(sql`UPDATE import_batches SET is_current = (id = ${batchId}) WHERE module = ${COMPANY_RESTORE_MODULE}`);
  const summary = { ...summarizeCompanyLinks(groups), aliasesAdded, companiesCreated, salesLinked };
  await tx.execute(sql`UPDATE import_batches SET total_rows = ${groups.length}, success_rows = ${salesLinked}, status = 'completed', headers_json = ${JSON.stringify(summary)}::jsonb WHERE id = ${batchId}`);
  return { batchId, ...summary };
}

/**
 * 되돌리기 — 이 배치가 추가한 별칭 삭제, 신규 등록 거래처는 다른 데이터(담당자·판매·견적·의뢰 등)가 없을 때만 삭제.
 * 담당자 연결 배치(applyNameLinks)를 이어서 실행했다면 그 배치를 먼저 되돌린다.
 */
export async function rollbackCompanyLinks(tx: Dbx, batchId: number) {
  const src = await rows(tx, sql`SELECT entity_id, status FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${COMPANY_RESTORE_MODULE}`);
  let aliasesRemoved = 0, companiesRemoved = 0; const kept: number[] = [];
  for (const r of src.filter(r => r.status === "alias_added")) aliasesRemoved += (await tx.execute(sql`DELETE FROM company_aliases WHERE id = ${Number(r.entity_id)}`)).rowCount ?? 0;
  for (const r of src.filter(r => r.status === "company_created")) {
    const id = Number(r.entity_id);
    // company_id 를 가진 모든 테이블(별칭 제외) — 하나라도 쓰이면 삭제하지 않는다
    const refTables = ["contacts", "projects", "inquiries", "divisions", "billing_batches", "prepaid_accounts", "users", "vendor_documents",
      "company_sensitive", "company_vendor_profiles", "company_change_history", "company_name_history"];
    const [u] = await rows(tx, sql`SELECT (${sql.join(refTables.map(t => sql`EXISTS (SELECT 1 FROM ${sql.identifier(t)} WHERE company_id = ${id})`), sql` OR `)}) used`);
    if (u?.used) { kept.push(id); continue; }
    // 별칭을 먼저 명시적으로 지운다(FK CASCADE 에만 기대지 않음 — 이 거래처는 이 배치가 만든 것이라 별칭도 모두 이 배치 소산)
    await tx.execute(sql`DELETE FROM company_aliases WHERE company_id = ${id}`);
    companiesRemoved += (await tx.execute(sql`DELETE FROM companies WHERE id = ${id}`)).rowCount ?? 0;
  }
  await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back', is_current = false WHERE id = ${batchId} AND module = ${COMPANY_RESTORE_MODULE}`);
  return { batchId, aliasesRemoved, companiesRemoved, companiesKept: kept };
}
