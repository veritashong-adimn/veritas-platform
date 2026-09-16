// ─── 세금처리(원천/부가세) 표시명 SSOT (10차 §4·§6) ─────────────────────────────
// DB enum/값은 그대로 두고, 지급명세서·세무자료 Excel의 '세금처리' 표시 문구만 중앙화한다.
//   기존 컴포넌트(PayoutRoundsTab·PayoutStatementModal·performanceShared·PerformanceSection)의
//   중복 라벨은 이번 작업에서 건드리지 않으며(회귀 방지), 신규/변경 Excel에서만 이 함수를 사용한다.
//
// 판정 우선순위:
//   1) 외주(사업자) = payeeType 'vendor' 또는 VAT 포함 → 매입증빙(purchaseEvidenceType) 기준.
//      개인 원천징수 방식으로 계산/표시하지 않는다(§2·§4).
//   2) 개인(individual) = withholdingTreatment 기준(3.3%/2.2%/예외/비거주자/조세조약/검토필요).
//   calcPayoutWithholding 의 실제 계산과 의미가 일치하도록 매핑한다(표시만, 재계산 없음).

export interface TaxTreatmentInput {
  payeeType?: string | null;              // 'individual' | 'vendor' | 'none'
  withholdingTreatment?: string | null;   // performance_withholding_treatment enum
  withholdingRate?: number | string | null;
  purchaseEvidenceType?: string | null;   // 'tax_invoice' | 'zero_rate_tax_invoice' | 'invoice' | 'other' | 'none'
  vatIncluded?: boolean | null;
}

export function formatTaxTreatment(i: TaxTreatmentInput): string {
  const pe = String(i.purchaseEvidenceType ?? '');
  const rate = Number(i.withholdingRate);
  const hasRate = Number.isFinite(rate) && rate > 0;

  // 1) 외주(사업자)/VAT 대상 — 세금계산서(부가세별도) 등 매입증빙 표시. 개인 원천징수와 구분(§2·§4).
  if (i.payeeType === 'vendor' || i.vatIncluded) {
    if (pe === 'tax_invoice' || i.vatIncluded) return '세금계산서(부가세별도)';
    if (pe === 'zero_rate_tax_invoice') return '영세율 세금계산서';
    if (pe === 'invoice') return '계산서';
    return '외주(원천징수 없음)';
  }

  // 2) 개인 원천징수
  switch (i.withholdingTreatment) {
    case 'domestic_3_3': return '3.3%';
    case 'domestic_2_2': return '2.2%';
    case 'exempt': return '원천징수 예외';
    case 'nonresident_custom': return hasRate ? `비거주자 ${rate}%` : '비거주자 원천징수';
    case 'treaty_reduction_or_exemption': return hasRate ? `조세조약 ${rate}%` : '조세조약 감면·면제';
    case 'tax_review_required': return '검토필요';
    default: return '';
  }
}
