/**
 * quoteItemStatus — 견적 행의 단가 상태(price_status)·통역 인원 확정 여부(interpreter_count_confirmed) 검증.
 *
 *  · priceStatus: unset(단가 미입력, unit_price=0으로 저장) | set(입력, unit_price≠0) | free(무상 확정, unit_price=0)
 *    보내지 않은 클라이언트(구버전)는 NULL(기존 자료와 같은 의미) — 기존 API 호환. 할인 행은 대상 아님(NULL).
 *  · interpreterCountConfirmed: true/false, 보내지 않으면 NULL.
 * DB CHECK(quote_items_price_status_check)와 같은 규칙을 저장 전에 검사해 명확한 오류 메시지를 준다.
 */
export const PRICE_STATUSES = ["unset", "set", "free"] as const;
export type PriceStatus = typeof PRICE_STATUSES[number];

export interface StatusInput { productName?: string; unitPrice?: number; itemType?: string; priceStatus?: unknown; interpreterCountConfirmed?: unknown }

/** 행별 저장값. 규칙 위반이면 error. */
export function validateItemStatuses(items: StatusInput[]): { error: string } | { values: Array<{ priceStatus: PriceStatus | null; interpreterCountConfirmed: boolean | null }> } {
  const values: Array<{ priceStatus: PriceStatus | null; interpreterCountConfirmed: boolean | null }> = [];
  for (const [i, it] of items.entries()) {
    const label = `${i + 1}행(${it.productName || "상품"})`;
    let ps: PriceStatus | null = null;
    if (it.priceStatus != null && it.priceStatus !== "") {
      if (!PRICE_STATUSES.includes(it.priceStatus as PriceStatus)) return { error: `${label}: 단가 상태 값이 올바르지 않습니다(unset/set/free).` };
      if (it.itemType === "discount") return { error: `${label}: 할인 행에는 단가 상태를 지정하지 않습니다.` };
      ps = it.priceStatus as PriceStatus;
      const price = Number(it.unitPrice ?? 0);
      if ((ps === "unset" || ps === "free") && price !== 0) return { error: `${label}: ${ps === "unset" ? "단가 미입력" : "무상"} 행의 단가는 0이어야 합니다.` };
      if (ps === "set" && price === 0) return { error: `${label}: 단가가 0원이면 '무상(0원 확정)' 또는 '단가 미입력'으로 지정해야 합니다.` };
    }
    const ic = it.interpreterCountConfirmed;
    values.push({ priceStatus: ps, interpreterCountConfirmed: typeof ic === "boolean" ? ic : null });
  }
  return { values };
}
