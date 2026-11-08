// ─── 과거 CRM(진행관리표) 통번역사 지급완료 판정 규칙 — 단일 기준(SSOT) ─────────────────
//
// [확정 근거]
//   · 대표가 2026-10-07 다운로드한 기존 CRM 진행관리표를 대조한 결과, 납품일 2026-09-15까지 납품 완료된
//     과거 CRM 건은 실제 지급이 완료된 자료임을 확인(대표 확인). → 이 cutoff 만 지급완료 근거로 인정한다.
//
// [오류 정정 — 2026-11 전수조사]
//   · 진행관리표의 '입금일'·'입금내역' 열은 "고객(거래처) → 베리타스" 수금 기록이다(예: "국민 11,000,000",
//     "9/18- 1,732,500" = 판매총액의 50% 선금). 통번역사 지급 증빙이 아니다.
//     과거에는 이 값을 지급완료 증빙으로 해석해, 지급예정일이 미래인 건까지 '지급완료'로 표시되었다.
//     → 입금일/입금내역은 지급완료 판정에 사용하지 않는다(수금 정보로만 유지).
//   · '통번역사지급일' 열은 지급"예정"일이다. 값이 존재한다는 사실만으로 지급완료로 보지 않는다.
//   · 납품일 2026-09-16 이후 건은 실제 지급확정 기록(신규 플랫폼 지급회차 [지급완료])이 없으면
//     지급예정(지급일 미래) 또는 지급확인 필요(지급일 경과/미상)로 둔다. 임의 지급완료 금지.
//
// [2026-11-08 추가 — 지급회차 지급일 경과 자동 지급완료(대표 확정)]
//   · 과거 CRM 통번역사 지급은 베리타스가 별도 지급파일을 만들어 송금한다. 따라서 과거 CRM 지급건에 한해
//     지급회차 지급일('통번역사지급일')이 지나면(KST 기준 지급일 다음 날부터) 지급완료로 본다. 지급일 당일은 지급예정.
//   · 조회 시점 날짜로 매번 계산한다(엑셀 재업로드·DB 갱신 없이 자동 전환).
//   · 이 표시는 '별도 지급파일로 처리된 지급상태'이며 VERITAS OS 가 송금을 실행했다는 기록이 아니다.
//   · 신규 VERITAS OS 지급건(performance_assignments)에는 적용하지 않는다 — 기존 지급확정·지급처리 절차만 사용.
//   · 기존 근거(납품일 ≤ 2026-09-15 대표 확인)는 그대로 유지(지급일 누락 행 포함).
export const LEGACY_PAID_DELIVERY_CUTOFF = "2026-09-15";
export const LEGACY_PAID_BY_ROUND_BASIS = "과거 CRM 지급회차 지급일 경과(별도 지급파일 처리분 · VERITAS OS 송금 아님)";
export const LEGACY_PAID_BASIS = "대표 확인 · 2026-10-07 CRM 자료 기준(납품일 ≤ 2026-09-15)";

/** 과거 CRM 진행 행이 '실제 지급완료'로 확인된 자료인지. 납품일(YYYY-MM-DD…) 누락·무효 → false. */
export function isLegacyConfirmedPaid(deliveryDate: string | null | undefined): boolean {
  const m = String(deliveryDate ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return !!m && m[1] <= LEGACY_PAID_DELIVERY_CUTOFF;
}

/** 오늘(KST) YYYY-MM-DD. */
export function todayKst(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
/** 과거 CRM 지급회차 지급일이 경과했는지(지급일 < 오늘 KST). 지급일 당일·미래·누락 → false. */
export function isLegacyRoundElapsed(payDate: string | null | undefined, today: string = todayKst()): boolean {
  const m = String(payDate ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return !!m && m[1] < today;
}
/** 과거 CRM 진행 행 지급완료 여부(조회용) = 대표 확인 cutoff 또는 지급회차 지급일 경과. */
export function isLegacyPaidForDisplay(deliveryDate: string | null | undefined, payDate: string | null | undefined, today: string = todayKst()): boolean {
  return isLegacyConfirmedPaid(deliveryDate) || isLegacyRoundElapsed(payDate, today);
}
