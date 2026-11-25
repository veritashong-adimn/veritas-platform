// ─── 지급일별 대표 확인 결정(2026-11-25 대표 확인) — 지급준비점검·지급회차 통합 조회 공용 ─────────────────
//   (services/payoutReadiness 에서 이동 — 값·적용 범위 그대로)
// 지급일별 대표 확인 결정(2026-11-25 대표 확인) — 해당 지급일 점검(화면·엑셀 2종)에만 적용. 운영 데이터·다른 지급일·전체 기간 점검은 그대로.
//   exclude      : 지급일 점검 대상에서 제외(sourceKey → 사유). 판매·수행이력·CRM 원본 보존, 지급기록 생성 없음.
//   freeService  : 무료 제공으로 확인된 0원 건(sourceKey) — '지급액 미입력'·과거 지급 여부 확인 경고 대신 '지급액 없음'(정상 0원, 송금 대상 아님). 다른 0원 건에는 적용하지 않는다.
//   excludeNoPayoutDate : 지급예정일 미기재 건(후보 no_payout_date)을 이 지급일 점검에서 제외(전체 기간 점검에는 유지, 날짜 임의 입력 없음).
export const DATE_DECISIONS: Record<string, { exclude: Map<string, string>; freeService: Set<string>; excludeNoPayoutDate: boolean }> = {
  "2026-11-30": {
    exclude: new Map([
      // 사단법인한국법학원 — 2026-11-04-0005 건에서 11/13 일괄 지급 완료(대표 확인). 플랫폼 4건 + CRM 원본 3건.
      ...["current:412", "current:413", "current:414", "current:383", "legacy:44155", "legacy:44159", "legacy:44827"]
        .map(k => [k, "한국법학원 11/13 지급완료(대표 확인)"] as [string, string]),
    ]),
    // 코리아미디어 리시버 100개 이하 무료 제공(대표 확인)
    freeService: new Set(["current:221", "current:201", "current:220", "current:206", "legacy:44354"]),
    excludeNoPayoutDate: true,
  },
};

/** 정상 무료 제공으로 확인된 0원 건(해당 지급일 결정 목록) — 표시 상태 '무료 제공' 판정용 */
export function isConfirmedFreeService(payoutDate: string | null | undefined, sourceKey: string): boolean {
  return !!payoutDate && !!DATE_DECISIONS[payoutDate]?.freeService.has(sourceKey);
}
