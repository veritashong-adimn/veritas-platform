// ─── 지급상태 표시 기준(화면 공통, 2026-11-25) ─────────────────────────────────────────────
//  지급준비점검·지급대상별 요약·건별 상세내역이 같은 6개 표시 상태를 쓴다. 저장값(payment_status 등)·지급 판정은 바꾸지 않는다 — 표시만.
//    paid      지급완료      — 지급완료 판정(플랫폼 지급완료 / 과거 CRM 지급완료 규칙)
//    free      무료 제공     — 정상 무료 제공으로 확인된 0원 건만(지급일별 대표 확인 목록 · 베리타스 명의 0원 기록). 외화·금액 미입력 건은 해당 없음.
//    hold      지급보류      — 플랫폼 수행정보 지급보류
//    review    지급확인 필요 — 과거 지급 여부 미확인·중복 의심·지급금액 미입력(원화 0원 / 외화 금액 없음)·지급일 없음
//    unpaid    미지급        — 지급일(지급예정일)이 지났는데 지급완료가 아닌 건
//    scheduled 지급예정      — 지급일이 오늘(KST) 또는 이후인 미지급 건
export type PayStatusKey = "scheduled" | "unpaid" | "paid" | "free" | "hold" | "review";
export const PAY_STATUS_LABEL: Record<PayStatusKey, string> = {
  scheduled: "지급예정", unpaid: "미지급", paid: "지급완료", free: "무료 제공", hold: "지급보류", review: "지급확인 필요",
};
export const PAY_STATUS_ORDER: PayStatusKey[] = ["scheduled", "unpaid", "paid", "free", "hold", "review"];

export function payStatusOf(x: {
  paid: boolean; free: boolean; hold: boolean; review: boolean;
  /** 원화 지급액 0원(외화 지급 아님) 또는 외화 지급인데 외화 금액 없음 */
  amountMissing: boolean;
  payoutDate: string | null | undefined; today: string;
}): PayStatusKey {
  if (x.paid) return "paid";
  if (x.free) return "free";
  if (x.hold) return "hold";
  if (x.review || x.amountMissing || !x.payoutDate) return "review";
  return x.payoutDate < x.today ? "unpaid" : "scheduled";
}

/** 지급금액 미입력 — 외화 지급은 외화 금액 기준, 원화 지급은 원화 지급액 기준 */
export function isAmountMissing(pretax: number, payCurrency: string | null | undefined, foreignAmount: number | null | undefined): boolean {
  const fx = !!payCurrency && payCurrency !== "KRW";
  return fx ? !(foreignAmount != null && foreignAmount > 0) : !(pretax > 0);
}

export function emptyStatusCounts(): Record<PayStatusKey, number> {
  return { scheduled: 0, unpaid: 0, paid: 0, free: 0, hold: 0, review: 0 };
}
