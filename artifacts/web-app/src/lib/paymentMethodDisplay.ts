// ─── 결제방법 사용자 표시명(수금/고객 입금 문맥) ────────────────────────────────
// 저장/비교값(canonical '외화송금')과 DB enum/API 값은 그대로 두고, 고객으로부터 '입금'을 받는
// 수금 문맥의 화면·Excel 표시만 '외화입금'으로 보여준다(§5). PaymentInfoSection 의 METHOD_DISPLAY 와 동일 규칙.
//  · '외화송금'은 회사가 보내는 '송금'이 아니라 고객이 보내오는 '입금'이므로 수금 관점에서 '외화입금'이 정확.
//  · 매핑에 없는 값은 원본 그대로 통과(세금계산서/카드/현금/기타 등).
const PAYMENT_METHOD_DISPLAY: Record<string, string> = { '외화송금': '외화입금' };

/** 결제방법 표시명 — 저장값은 불변, 표시만 매핑. 빈 값이면 ''. */
export function displayPaymentMethod(v?: string | null): string {
  const s = (v ?? '').trim();
  return s ? (PAYMENT_METHOD_DISPLAY[s] ?? s) : '';
}
