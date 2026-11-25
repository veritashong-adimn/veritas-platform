// ─── 외화 지급 판정(공용, 2026-11-25) ────────────────────────────────────────────────
//  외화 지급 = 수행정보 지급통화(contract_currency)가 KRW 가 아니고
//    개인 수행자(개인 외화 지급) 또는 외주업체 해외송금 정산(vendor_settlement_type='overseas')인 건.
//  외화 지급금액 = 수행정보 contract_amount_foreign(계약통화 단위). 원화 지급액(cost_total)은 0원일 수 있다(외화·원화 합산 금지).
//  지급준비점검(services/payoutReadiness)의 payCurrency 판정과 같은 기준 — 화면·명세서·지급완료 확인이 이 규칙 하나를 쓴다.
//  ※ 외화 지급 건은 원화 지급액이 0원이어도 '0원 수행건'이 아니다.
export type ForeignPayInput = {
  performerCategory?: string | null; vendorSettlementType?: string | null;
  contractCurrency?: string | null; contractAmountForeign?: string | number | null;
};
export type ForeignPay = { currency: string; amount: number | null };

export function foreignPayOf(a: ForeignPayInput | null | undefined): ForeignPay | null {
  if (!a) return null;
  const cur = String(a.contractCurrency ?? "").trim().toUpperCase();
  if (!cur || cur === "KRW") return null;
  if (!(a.performerCategory === "individual" || (a.performerCategory === "vendor" && a.vendorSettlementType === "overseas"))) return null;
  const n = a.contractAmountForeign == null || a.contractAmountForeign === "" ? null : Number(a.contractAmountForeign);
  return { currency: cur, amount: n != null && Number.isFinite(n) ? n : null };
}

/** 외화 지급 판정 SQL(별칭 a 의 수행정보 컬럼) — 위 foreignPayOf 와 같은 기준 */
export const FOREIGN_PAY_SQL_COND = (alias: string) =>
  `(coalesce(upper(nullif(btrim(${alias}.contract_currency), '')), 'KRW') <> 'KRW'
    AND (${alias}.performer_category = 'individual' OR (${alias}.performer_category = 'vendor' AND ${alias}.vendor_settlement_type = 'overseas')))`;

/**
 * 지급완료 확인 금액 검증 — 외화 지급 건은 지급통화·외화 지급금액으로 확인한다.
 *   · 외화: 입력 통화 = 수행정보 지급통화, 입력 금액 = 수행정보 외화 지급금액(기존 값 보존 — 다르면 수행정보를 먼저 정정).
 *           원화 실제 지급액(actual_payment_amount, 원화 단위)은 환산 기록이 없으므로 비워 둔다(외화 금액은 수행정보에 그대로).
 *   · 원화: 통화 KRW, 금액 > 0 (zeroAllowed 이면 0원 허용 — 호출측이 0원 수행건 조건을 확인).
 * 반환: 저장할 원화 실제 지급액(문자열|null) + 외화 확인값(감사로그용) | 오류 메시지
 */
export function checkPaidAmount(a: ForeignPayInput, paid: { actualPaymentAmount: number; actualPaymentCurrency?: string | null }, zeroAllowed = false):
  { krw: string | null; foreign: ForeignPay | null } | { error: string } {
  const fp = foreignPayOf(a);
  const inCur = String(paid.actualPaymentCurrency ?? "KRW").trim().toUpperCase() || "KRW";
  if (fp) {
    if (fp.amount == null || !(fp.amount > 0)) return { error: `외화 지급(${fp.currency}) 금액이 수행정보에 없습니다. 수행정보에 외화 지급금액을 먼저 입력하세요.` };
    if (inCur !== fp.currency) return { error: `이 수행건은 외화 지급(${fp.currency}) 건입니다. ${fp.currency} 금액으로 지급완료 확인하세요.` };
    if (Math.abs(paid.actualPaymentAmount - fp.amount) >= 0.005)
      return { error: `실제 지급액(${fp.currency} ${paid.actualPaymentAmount.toLocaleString("ko-KR")})이 수행정보 외화 지급금액(${fp.currency} ${fp.amount.toLocaleString("ko-KR")})과 다릅니다. 수행정보 외화 지급금액을 먼저 정정하세요.` };
    return { krw: null, foreign: { currency: fp.currency, amount: fp.amount } };
  }
  if (inCur !== "KRW") return { error: "원화 지급 건입니다. 원화 실제 지급액으로 확인하세요." };
  if (!(paid.actualPaymentAmount > 0) && !(zeroAllowed && paid.actualPaymentAmount === 0)) return { error: "실제 지급액을 입력하세요." };
  return { krw: String(paid.actualPaymentAmount), foreign: null };
}
