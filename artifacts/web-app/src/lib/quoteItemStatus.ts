/**
 * quoteItemStatus — 견적 행의 단가 상태·통역 인원 확정 여부(화면 ↔ API).
 *  · 단가: 입력란이 비어 있으면 'unset'(단가 미입력, 저장 시 0원으로 기록되지만 실제 0원이 아님),
 *          직원이 0을 직접 입력하면 'free'(무상 확정), 그 외 'set'. 할인 행은 대상 아님.
 *  · 인원: 통역 행의 인원 입력란이 비어 있으면 미확정(false) — 계산은 기존 정책대로 1명 기준, 화면에는 '인원 미확정'.
 * 서버는 같은 규칙을 검증한다(services/quoteItemStatus.ts, DB CHECK).
 */
export type PriceStatus = 'unset' | 'set' | 'free';

const num = (v: string) => Number(String(v ?? '').replace(/,/g, '') || 0);
export const isPriceBlank = (unitPrice: string): boolean => String(unitPrice ?? '').trim() === '';
export function priceStatusOf(unitPrice: string): PriceStatus {
  if (isPriceBlank(unitPrice)) return 'unset';
  return num(unitPrice) === 0 ? 'free' : 'set';
}
export const isHeadcountBlank = (interpreterCount: string): boolean => String(interpreterCount ?? '').trim() === '';
