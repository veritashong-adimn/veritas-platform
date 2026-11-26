// ─── 마이너스 발행(청구 감액 세금계산서) — 청구정보·수금관리·고객관리 공통 규칙(스키마 변경 없음) ─────────────
//  저장: payment_type 'other' + deposit_item '마이너스발행:{원청구회차 id}' · 금액(공급가·부가세·청구금액) 음수 · 발행일 필수.
//  계산:
//   · 총 청구금액 = 청구행 금액 합계(마이너스 행 포함 → 순 청구금액).
//   · 원청구회차 미수금 = max(청구금액 + 연결된 마이너스 합계 − 입금액, 0). 입금상태도 (청구금액 + 마이너스 합계) 기준.
//   · 마이너스 행 자체 = 입금 0 · 미수금 0 · 입금거래 등록 불가. 입금액·환불(음수 입금)과 무관.
export const MINUS_ITEM = "마이너스발행";
export const isMinusItem = (depositItem: unknown): boolean => String(depositItem ?? "").startsWith(MINUS_ITEM);
/** '마이너스발행:123' → 123 (형식이 아니면 null) */
export function minusSourceOf(depositItem: unknown): number | null {
  const m = String(depositItem ?? "").match(/^마이너스발행:(\d+)$/);
  return m ? Number(m[1]) : null;
}
/** 원청구회차 id → 연결된 마이너스 금액 합계(음수). rows 는 같은 조회 범위의 청구행. */
export function minusSumBySource(rows: { amount: unknown; depositItem?: unknown; deposit_item?: unknown }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows) {
    const src = minusSourceOf(r.depositItem ?? r.deposit_item);
    if (src != null) out.set(src, (out.get(src) ?? 0) + Number(r.amount ?? 0));
  }
  return out;
}
