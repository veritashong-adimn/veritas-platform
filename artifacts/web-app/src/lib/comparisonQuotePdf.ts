/**
 * comparisonQuotePdf — 비교견적(고객 제출용 보조 문서) PDF 데이터 빌더.
 *
 * 매우 중요(§8): 이 파일은 settings(회사정보) 를 절대 조회/참조하지 않는다.
 * VERITAS 상호/사업자번호/주소/전화/이메일/계좌/로고를 fallback 으로도 넣지 않는다.
 * 오직 사용자가 입력한 비교업체 정보만 사용하며, 빈 값은 PDF 에서 표시하지 않는다.
 */

export interface ComparisonQuoteItemData {
  description: string;
  languagePair?: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  memo?: string | null;
}

export interface ComparisonQuotePdfData {
  company: {
    name: string;
    representativeName?: string | null;
    businessNumber?: string | null;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    contactName?: string | null;
    logoUrl?: string | null;
  };
  // 수신처(고객) 스냅샷 — 생성 시점 원본 견적의 거래처/담당자. 비었으면 PDF 에 표시하지 않는다.
  customer: {
    companyName?: string | null;
    representativeName?: string | null;
    contactName?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  displayNumber?: string | null;
  quoteDate?: string | null;
  vatMode: 'vat_10' | 'none';
  memo?: string | null;
  items: ComparisonQuoteItemData[];
  totals: { supply: number; tax: number; total: number };
}

export function computeComparisonTotals(
  items: { amount: number }[],
  vatMode: 'vat_10' | 'none',
): { supply: number; tax: number; total: number } {
  const supply = items.reduce((a, it) => a + (Number(it.amount) || 0), 0);
  const tax = vatMode === 'vat_10' ? Math.round(supply * 0.1) : 0;
  return { supply, tax, total: supply + tax };
}

/** API GET /admin/comparison-quotes/:id 응답(cq + items[]) → PDF 데이터. */
export function buildComparisonQuotePdfData(cq: {
  companyName: string;
  representativeName?: string | null;
  businessNumber?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  contactName?: string | null;
  logoUrl?: string | null;
  customerCompanyName?: string | null;
  customerRepresentativeName?: string | null;
  customerContactName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  displayNumber?: string | null;
  quoteDate?: string | null;
  vatMode?: string | null;
  memo?: string | null;
  items?: Array<Record<string, unknown>>;
}): ComparisonQuotePdfData {
  const items: ComparisonQuoteItemData[] = (cq.items ?? []).map((it) => ({
    description: String(it.description ?? ''),
    languagePair: (it.languagePair as string | null) ?? null,
    quantity: Number(it.quantity) || 0,
    unit: String(it.unit ?? '건'),
    unitPrice: Number(it.unitPrice) || 0,
    amount: Number(it.amount) || 0,
    memo: (it.memo as string | null) ?? null,
  }));
  const vatMode: 'vat_10' | 'none' = cq.vatMode === 'none' ? 'none' : 'vat_10';
  return {
    company: {
      name: cq.companyName,
      representativeName: cq.representativeName ?? null,
      businessNumber: cq.businessNumber ?? null,
      address: cq.address ?? null,
      phone: cq.phone ?? null,
      email: cq.email ?? null,
      website: cq.website ?? null,
      contactName: cq.contactName ?? null,
      logoUrl: cq.logoUrl ?? null,
    },
    customer: {
      companyName: cq.customerCompanyName ?? null,
      representativeName: cq.customerRepresentativeName ?? null,
      contactName: cq.customerContactName ?? null,
      phone: cq.customerPhone ?? null,
      email: cq.customerEmail ?? null,
    },
    displayNumber: cq.displayNumber ?? null,
    quoteDate: cq.quoteDate ?? null,
    vatMode,
    memo: cq.memo ?? null,
    items,
    totals: computeComparisonTotals(items, vatMode),
  };
}

/** 비교견적 PDF 파일명 — VERITAS 접두어를 절대 붙이지 않는다. */
export function buildComparisonFileName(companyName: string, quoteDate?: string | null): string {
  const safe = (companyName || '비교견적').replace(/[\\/:*?"<>|]/g, '_').trim();
  const d = (quoteDate ?? '').replace(/-/g, '');
  return `비교견적_${safe}${d ? '_' + d : ''}`;
}
