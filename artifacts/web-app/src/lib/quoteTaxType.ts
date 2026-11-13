// ─────────────────────────────────────────────────────────────────────────────
// quoteTaxType — 견적·판매 세금 유형(부가세 구분) 공용 규칙
//
//  · 세금 유형의 저장 기준은 quote_items.tax_type ("taxable" | "zero_rate" | "exempt") — 영세율·면세는 서로 다른 값.
//  · 견적서 유형(일반·차감·누적)과 별개로 관리한다.
//  · 'unknown'(확인 필요)은 저장값이 아니라 화면 판정값이다:
//      과세(taxable)로 저장돼 있는데 공급가액이 있고 부가세가 0원인 품목(과거 CRM 총액 이관 등), 또는 품목마다 유형이 섞인 견적.
//    이 상태에서는 저장된 금액을 그대로 유지하고 10%를 임의로 재계산하지 않는다(직원이 유형을 직접 선택할 때만 재계산).
// ─────────────────────────────────────────────────────────────────────────────

export type TaxKind = 'taxable' | 'zero_rate' | 'exempt';
export type VatMode = TaxKind | 'unknown';

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

export const normalizeTaxKind = (v: string | null | undefined): TaxKind =>
  v === 'zero_rate' || v === 'exempt' ? v : 'taxable';

/** 편집 화면 부가세 선택 라벨 */
export const VAT_MODE_LABEL: Record<VatMode, string> = {
  taxable: '일반과세 (10%)', zero_rate: '영세율 (0%)', exempt: '면세', unknown: '확인 필요',
};
/** 금액 요약·PDF 부가세 행 라벨 */
export const VAT_ROW_LABEL: Record<VatMode, string> = {
  taxable: '부가세 (10%)', zero_rate: '부가세 (영세율 0%)', exempt: '부가세 (면세)', unknown: '부가세',
};
/** 견적서 PDF 상단 총액 라벨 */
export const QUOTE_TOTAL_LABEL: Record<VatMode, string> = {
  taxable: '총 견적금액 (VAT 포함)', zero_rate: '총 견적금액 (영세율 0%)', exempt: '총 견적금액 (면세)', unknown: '총 견적금액',
};
/** 견적 세금 유형 → 발행 문서 유형(quotes.tax_document_type) */
export const TAX_DOCUMENT_TYPE_BY_KIND: Record<TaxKind, string> = {
  taxable: 'tax_invoice', zero_rate: 'zero_rate_tax_invoice', exempt: 'invoice',
};
/** 세금 유형 → 청구정보 기본 결제·발행 유형(project_payments.payment_method) */
export const BILLING_METHOD_BY_KIND: Record<TaxKind, string> = {
  taxable: '세금계산서', zero_rate: '영세율 계산서', exempt: '면세 계산서',
};

/** 과세로 저장됐지만 공급가액이 있는데 부가세가 0원 — 세금 유형 근거 확인 대상(과거 CRM 총액 이관 등) */
export function isTaxUnconfirmed(taxType: string | null | undefined, supplyAmount: unknown, taxAmount: unknown): boolean {
  return normalizeTaxKind(taxType) === 'taxable' && Math.abs(num(supplyAmount)) >= 0.5 && Math.abs(num(taxAmount)) < 0.5;
}

/** 저장된 품목들로 견적 세금 유형 판정 — 할인 행 제외. 품목이 없으면 일반과세. */
export function deriveVatMode(items: Array<{ taxType?: string | null; supplyAmount?: unknown; taxAmount?: unknown; itemType?: string | null; productType?: string | null }>): VatMode {
  const body = items.filter(it => (it.itemType ?? it.productType) !== 'discount');
  if (body.length === 0) return 'taxable';
  if (body.some(it => isTaxUnconfirmed(it.taxType, it.supplyAmount, it.taxAmount))) return 'unknown';
  const kinds = new Set(body.map(it => normalizeTaxKind(it.taxType)));
  return kinds.size === 1 ? [...kinds][0] : 'unknown';
}

// ─── 거래처 기본 세금 유형 ─────────────────────────────────────────────────────
//  companies.default_tax_type: NULL = 미확인. 추천용일 뿐 기존 견적에는 반영하지 않는다.
export const COMPANY_TAX_TYPE_OPTIONS: Array<{ value: TaxKind | ''; label: string }> = [
  { value: '', label: '미확인' },
  { value: 'taxable', label: '일반과세' },
  { value: 'zero_rate', label: '영세율' },
  { value: 'exempt', label: '면세' },
];
export const companyTaxTypeLabel = (v: string | null | undefined) =>
  COMPANY_TAX_TYPE_OPTIONS.find(o => o.value === (v ?? ''))?.label ?? '미확인';
