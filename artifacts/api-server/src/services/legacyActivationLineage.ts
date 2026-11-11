// 과거 CRM 판매 전환 계보(import_row_sources) 조회 — 수행정보 저장 경로에서 쓰는 가벼운 판정만 둔다(라우트 순환 import 방지).
import { sql } from "drizzle-orm";

export const ACTIVATION_MODULE = "legacy_sale_activation";
const SRC = "old_crm";
const ENTITY = "sale";

// 활성(취소 안 된) 운영 판매로 전환된 판매번호 — 판매목록·수행이력 중복 제외 공용 조건(SQL 조각).
//   saleNoExpr: 판매번호 SQL 표현식(예: legacy_archive_rows.source_raw->>'판매번호').
export function activatedSaleExists(saleNoExpr: any) {
  return sql`EXISTS (SELECT 1 FROM legacy_master_mappings lsm JOIN projects lsp ON lsp.id = lsm.entity_id AND lsp.status <> 'cancelled'
    WHERE lsm.source_system = ${SRC} AND lsm.entity_type = ${ENTITY} AND lsm.status = 'active' AND lsm.legacy_id = ${saleNoExpr})`;
}


// '과거 지급 확인 필요'(관리자 확인 전) 수행정보인지 — 이 건의 지급보류는 일반 수정으로 해제할 수 없다.
export async function isPendingPayoutReview(dbx: any, assignmentId: number): Promise<boolean> {
  const r = (await dbx.execute(sql`SELECT 1 FROM import_row_sources WHERE module = ${ACTIVATION_MODULE} AND row_key LIKE 'progress:%'
    AND entity_id = ${assignmentId} AND status = 'payout_review' LIMIT 1`)).rows as any[];
  return r.length > 0;
}

const legacyNum = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ── 과거 CRM 원본 세전·세후로 원천징수 근거 판정(전환 매핑용) ─────────────────────────
//   원본 진행관리 행의 지급액(세전)·지급액(세후)(원본 헤더 오타 '지금액(세후)' 포함)으로만 판단한다.
//   과거 CRM 은 세후를 10원(초기 자료는 100원) 단위로 절사했으므로, 세후가 '세전×(1−세율)' 이하이고
//   그 차이가 100원 미만이면 해당 세율로 본다(예: 85,000 → 82,195 → 82,190).
//   · 3.3% / 2.2% 확인 → kind w33 / w22 (treatment domestic_3_3 / domestic_2_2)
//   · 세후 = 세전 → no_withholding: 세금계산서·원천징수 예외를 구분할 근거가 없어 유형을 정하지 않는다(treatment null)
//   · 지급 없음·세후 없음·그 외 비율 → unknown(treatment null)
export type LegacyWithholdingKind = "w33" | "w22" | "no_withholding" | "no_payout" | "unknown";
export function legacyWithholdingEvidence(raw: Record<string, unknown> | null | undefined): {
  kind: LegacyWithholdingKind; treatment: "domestic_3_3" | "domestic_2_2" | null; pre: number | null; post: number | null;
} {
  const pre = raw ? legacyNum(raw["지급액(세전)"]) : null;
  const post = raw ? legacyNum(raw["지급액(세후)"] ?? raw["지금액(세후)"]) : null;
  if (pre == null || pre <= 0) return { kind: "no_payout", treatment: null, pre, post };
  if (post == null || post <= 0) return { kind: "unknown", treatment: null, pre, post };
  if (Math.abs(post - pre) < 1) return { kind: "no_withholding", treatment: null, pre, post };
  const within = (rate: number) => { const exact = pre * (1 - rate); return post <= exact + 1 && exact - post < 100; };
  if (within(0.033)) return { kind: "w33", treatment: "domestic_3_3", pre, post };
  if (within(0.022)) return { kind: "w22", treatment: "domestic_2_2", pre, post };
  return { kind: "unknown", treatment: null, pre, post };
}
/** @deprecated 호환용 — legacyWithholdingEvidence(raw).treatment 와 동일 */
export function legacyWithholdingFromRaw(raw: Record<string, unknown> | null | undefined): "domestic_3_3" | "domestic_2_2" | null {
  return legacyWithholdingEvidence(raw).treatment;
}

// ── 전환 시 원천세 결정(우선순위) ───────────────────────────────────────────────
//   1순위 CRM 행에 기록된 원천세율 — 원본 Excel 에 해당 칸이 없어 해당 없음
//   2순위 CRM 세전·세후로 확인된 세율(위 판정)
//   3순위 통번역사 Master 지급방식(translator_sensitive.payment_method) — 기존 신규 판매와 같은 매핑
//   4순위 판단 불가 → null('원천세 확인 필요'). Master 지급방식이 없다는 이유로 0%·세금계산서로 두지 않는다.
export type LegacyWithholdingBasis = "crm_pre_post" | "master" | "review_required";
export function masterTreatmentOf(paymentMethod: string | null | undefined): string | null {
  switch (paymentMethod) {
    case "domestic_withholding": return "domestic_3_3";
    case "domestic_withholding_2_2": return "domestic_2_2";
    case "domestic_withholding_exempt": return "exempt";
    case "domestic_business": return "tax_review_required";          // 사업자(세금계산서)
    case "overseas_paypal": case "overseas_bank": return "tax_review_required";
    default: return null;                                             // 미등록
  }
}
export function decideLegacyWithholding(raw: Record<string, unknown> | null | undefined, masterPaymentMethod: string | null | undefined) {
  const ev = legacyWithholdingEvidence(raw);
  if (ev.treatment) return { treatment: ev.treatment as string | null, basis: "crm_pre_post" as LegacyWithholdingBasis, evidence: ev };
  const m = masterTreatmentOf(masterPaymentMethod);
  if (m) return { treatment: m, basis: "master" as LegacyWithholdingBasis, evidence: ev };
  return { treatment: null, basis: "review_required" as LegacyWithholdingBasis, evidence: ev };
}

// CRM 세후와 플랫폼 세후(기존 원천징수·원 단위 규칙) 비교 — 보정하지 않고 상태만 표시한다.
//   match: 1원 이내 / crm_truncation: CRM 이 10·100원 단위로 절사한 차이(CRM 이 0~100원 적음) / mismatch: 그 외(원본 지급액 불일치)
export function comparePostTax(crmPost: number | null, platformPost: number | null): { status: "match" | "crm_truncation" | "mismatch" | "n/a"; diff: number | null } {
  if (crmPost == null || platformPost == null) return { status: "n/a", diff: null };
  const diff = Math.round((crmPost - platformPost) * 100) / 100;
  if (Math.abs(diff) <= 1) return { status: "match", diff };
  if (diff < 0 && -diff < 100) return { status: "crm_truncation", diff };
  return { status: "mismatch", diff };
}

// ── 과거 CRM 전환 수행행의 판매 공급가액(수익률 분모) — 조회 전용 ────────────────────────
//   전환 시 판매 상품행은 원본 판매목록 총액(부가세 포함)만 공급가로 들어가 수행행 스냅샷에 saleSupplyAmount 가 없다.
//   원본 진행관리 행의 공급가액+부가세가 연결된 판매 상품행 총액과 일치(1원 이내)할 때만 원본 공급가액을 돌려준다.
//   일치하지 않거나 값이 없으면 넣지 않는다(임의 금액으로 수익률 계산 금지). DB는 변경하지 않는다.
export async function legacySaleSupplyByAssignment(dbx: any, assignmentIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!assignmentIds.length) return out;
  const r = (await dbx.execute(sql`SELECT l.entity_id AS aid, la.source_raw->>'공급가액' AS sup, la.source_raw->>'부가세' AS vat, qi.total_amount AS item_total
    FROM import_row_sources l
    JOIN legacy_archive_rows la ON la.id::text = l.legacy_id
    JOIN performance_assignments pa ON pa.id = l.entity_id
    LEFT JOIN quote_items qi ON qi.id = pa.sale_item_id
    WHERE l.module = ${ACTIVATION_MODULE} AND l.row_key LIKE 'progress:%'
      AND l.entity_id IN (${sql.join(assignmentIds.map(i => sql`${i}`), sql`, `)})`)).rows as any[];
  for (const x of r) {
    const sup = verifiedCrmSupply(legacyNum(x.sup), legacyNum(x.vat), legacyNum(x.item_total));
    if (sup != null) out.set(Number(x.aid), sup);
  }
  return out;
}

// CRM 원본 공급가액 검증 공통 규칙 — 공급가액+부가세 = 판매 총액(1원 이내)이고, 부가세가 0원 또는 공급가액×10%(1원 이내)일 때만.
//   그 외 비율·불일치는 확인 대상(null) — 임의 계산 금지.
export function verifiedCrmSupply(sup: number | null, vat: number | null, total: number | null): number | null {
  if (sup == null || sup <= 0 || total == null) return null;
  const v = vat ?? 0;
  if (Math.abs(sup + v - total) > 1) return null;
  if (!(v === 0 || Math.abs(v - sup * 0.1) <= 1)) return null;
  return sup;
}

// ── 과거 CRM 전환 판매의 손익 요약용 공급가액(조회 전용) ─────────────────────────────
//   전환 시 공급가·부가세를 나누지 못한(품목 부가세 0) 판매만 대상. 전환 계보의 원본 진행관리 행들의 (공급가액, 부가세)가
//   단일 값이고 위 검증 규칙을 통과하면 원본 공급가액을 돌려준다. 아니면 null(기존 품목 공급가액 그대로 사용).
export async function legacyVerifiedSaleSupply(dbx: any, projectId: number, itemsTotal: number, itemsTax: number): Promise<{ supply: number | null; isLegacy: boolean }> {
  const r = (await dbx.execute(sql`SELECT DISTINCT la.source_raw->>'공급가액' AS sup, la.source_raw->>'부가세' AS vat
    FROM legacy_master_mappings m
    JOIN projects p ON p.id = m.entity_id
    JOIN import_row_sources l ON l.batch_id = m.import_batch_id AND l.module = ${ACTIVATION_MODULE} AND l.row_key LIKE 'progress:%'
    JOIN legacy_archive_rows la ON la.id::text = l.legacy_id
    WHERE m.source_system = ${SRC} AND m.entity_type = ${ENTITY} AND m.status = 'active' AND m.entity_id = ${projectId}`)).rows as any[];
  const [mapped] = (await dbx.execute(sql`SELECT 1 FROM legacy_master_mappings WHERE source_system = ${SRC} AND entity_type = ${ENTITY} AND status = 'active' AND entity_id = ${projectId} LIMIT 1`)).rows as any[];
  if (!mapped) return { supply: null, isLegacy: false };
  if (Math.abs(itemsTax) > 0.5 || r.length !== 1) return { supply: null, isLegacy: true };   // 이미 분리됐거나 원본 값이 여럿 → 사용 안 함
  return { supply: verifiedCrmSupply(legacyNum(r[0].sup), legacyNum(r[0].vat), itemsTotal), isLegacy: true };
}
