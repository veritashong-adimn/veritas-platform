// ─── 지급대상별 요약 Excel 정렬 그룹(2026-11) — 표시·정렬 전용. 세금처리·지급금액 계산과 무관(읽기만). ─────────────
//  1 국내 통번역사(3.3% 등 국내 원천징수) · 2 해외 통번역사 중 국내 송금 · 3 해외 통번역사 중 해외 송금 · 4 외주업체
//  판정 근거 — 통번역사 명부(translator_sensitive) 지급방식·통화·계좌 + 수행정보(세금처리·거주 구분·지급통화). 이름 기준 판정 없음.
//   · 외주업체 → 4
//   · 외화 지급 건이 있으면 기본 해외송금(3). 단 명부에 그 통화의 국내 수취 정보(국내 계좌 + 명부 통화 = 지급통화, 해외 지급방식 아님)가 있으면 국내 송금(2).
//   · 원화만 지급: 해외 통번역사 표시가 있으면 — 명부 해외 지급방식(해외 은행·PayPal)이거나 국내 계좌 없이 해외 계좌만 있으면 3, 그 외 국내 송금 2.
//     해외 통번역사 표시 = 명부 지급방식 해외 은행·PayPal·원천세 신고 제외, 또는 수행 거주 구분 해외·비거주, 또는 세금처리 비거주자·조세조약.
//   · 그 외 개인 → 1(국내 원천징수 대상. 세무 확인 필요 건·명부 지급방식 미등록이 섞여도 국내로 본다)
export type RemitGroup = 1 | 2 | 3 | 4;
export interface RemitRegistry { paymentMethod: string | null; currency: string | null; baseCurrency: string | null; domesticAccount: boolean; overseasAccount: boolean }
export interface RemitRow { payCurrency?: string | null; withholdingTreatment?: string | null; residencyType?: string | null }
const OVERSEAS_PM = new Set(["overseas_bank", "overseas_paypal"]);
const NONRESIDENT_TREATMENT = new Set(["nonresident_custom", "treaty_reduction_or_exemption"]);
const up = (v: unknown) => String(v ?? "").trim().toUpperCase();

export function remitGroupOf(payeeType: string | null | undefined, rows: RemitRow[], reg: RemitRegistry | null): { group: RemitGroup; reason: string } {
  if (payeeType === "vendor") return { group: 4, reason: "외주업체" };
  const pm = reg?.paymentMethod ?? null;
  const overseasRemit = (pm != null && OVERSEAS_PM.has(pm)) || (!!reg?.overseasAccount && !reg?.domesticAccount);
  const overseasPayee = overseasRemit || pm === "domestic_withholding_exempt"
    || rows.some(r => r.residencyType === "overseas_or_nonresident" || NONRESIDENT_TREATMENT.has(String(r.withholdingTreatment ?? "")));
  const fx = [...new Set(rows.map(r => up(r.payCurrency)).filter(c => c && c !== "KRW"))];
  if (fx.length) {
    const domesticFx = !!reg?.domesticAccount && !overseasRemit && fx.every(c => up(reg?.currency) === c || up(reg?.baseCurrency) === c);
    return domesticFx ? { group: 2, reason: `외화 지급(${fx.join("·")}) · 명부 국내 외화 수취계좌` } : { group: 3, reason: `외화 지급(${fx.join("·")}) — 해외송금` };
  }
  if (overseasPayee) return overseasRemit ? { group: 3, reason: "해외 통번역사 · 명부 해외 송금" } : { group: 2, reason: "해외 통번역사 · 국내 계좌 송금" };
  return { group: 1, reason: "국내 통번역사" };
}
