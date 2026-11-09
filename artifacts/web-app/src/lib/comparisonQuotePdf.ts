/**
 * comparisonQuotePdf — 비교견적(고객 제출용 보조 문서) PDF 데이터 빌더.
 *
 * 매우 중요(§8): 이 파일은 settings(회사정보) 를 절대 조회/참조하지 않는다.
 * VERITAS 상호/사업자번호/주소/전화/이메일/계좌/로고를 fallback 으로도 넣지 않는다.
 * 오직 사용자가 입력한 비교업체 정보만 사용하며, 빈 값은 PDF 에서 표시하지 않는다.
 *
 * v2: 발행 구분(실제 업체 견적 / 내부 비교용), 견적 조건, 디자인 설정, 실제 등록된 로고·직인(data URI)을 포함.
 *     품목 설명은 고객용으로 정리(내부 관리 문구 제거)해 출력한다 — 저장 데이터(memo)는 변경하지 않는다.
 */
import { toCustomerFacingNote, toLanguageDirectionLabel } from './comparisonItemName';

export type ComparisonIssueType = 'vendor_confirmed' | 'internal_simulation';
export const COMPARISON_TERM_FIELDS = [
  { key: 'validity', label: '견적 유효기간', placeholder: '예: 발행일로부터 30일' },
  { key: 'schedule', label: '작업 기간 및 납품예정일', placeholder: '예: 착수 후 영업일 기준 7일' },
  { key: 'deliveryMethod', label: '납품 방식', placeholder: '예: 이메일 납품 (Word/PDF)' },
  { key: 'scope', label: '작업 범위', placeholder: '예: 번역 및 1차 감수 포함' },
  { key: 'revisionTerms', label: '추가 작업 및 수정 조건', placeholder: '예: 납품 후 7일 이내 오역 수정 무상' },
  { key: 'paymentTerms', label: '결제 조건', placeholder: '예: 납품 후 30일 이내 계좌이체' },
  { key: 'otherNotes', label: '기타 안내사항', placeholder: '' },
] as const;
export type ComparisonTermKey = typeof COMPARISON_TERM_FIELDS[number]['key'];
export type ComparisonTerms = Partial<Record<ComparisonTermKey, string>>;
export const DEFAULT_COMPARISON_ACCENT = '#0f766e';
export const DEFAULT_COMPARISON_DOC_TITLE = '견 적 서';

export interface ComparisonQuoteItemData {
  description: string;
  languageLabel?: string | null; // "영어 → 한국어" — 품목명에서 확실히 해석될 때만
  note?: string | null;          // 고객용 설명(내부 관리 문구 제거본)
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
  // v2
  issueType: ComparisonIssueType;   // 실효 발행 구분 — 미지정(NULL)은 내부 비교용으로 취급
  issueTypeUnset: boolean;          // 저장값이 미지정인지(화면 안내용)
  issueDate?: string | null;        // 표시 발행일 = quoteDate, 없으면 생성일(표시 전용, 저장하지 않음)
  terms: ComparisonTerms;
  design: { accentColor: string; docTitle: string };
  logoDataUrl?: string | null;      // 실제 등록 이미지만
  stampDataUrl?: string | null;
}

const kstDate = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
};

/** 입력된 조건만 남긴다(공백 제거). */
export function cleanTerms(t: unknown): ComparisonTerms {
  const out: ComparisonTerms = {};
  if (!t || typeof t !== 'object') return out;
  for (const f of COMPARISON_TERM_FIELDS) {
    const v = (t as Record<string, unknown>)[f.key];
    if (typeof v === 'string' && v.trim()) out[f.key] = v.trim();
  }
  return out;
}

export function normalizeDesign(d: unknown): { accentColor: string; docTitle: string } {
  const src = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const c = typeof src.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.accentColor) ? src.accentColor : DEFAULT_COMPARISON_ACCENT;
  const t = typeof src.docTitle === 'string' && src.docTitle.trim() ? src.docTitle.trim() : DEFAULT_COMPARISON_DOC_TITLE;
  return { accentColor: c, docTitle: t };
}

/** 품목 → PDF 행(고객용 설명·언어 방향 부여). */
export function toPdfItem(it: { description: string; languagePair?: string | null; quantity: number; unit: string; unitPrice: number; amount: number; memo?: string | null }): ComparisonQuoteItemData {
  return {
    ...it,
    languageLabel: toLanguageDirectionLabel(it.description),
    note: toCustomerFacingNote(it.memo) || null,
  };
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
  issueType?: string | null;
  terms?: unknown;
  designSettings?: unknown;
  logoDataUrl?: string | null;
  stampDataUrl?: string | null;
  createdAt?: string | null;
}): ComparisonQuotePdfData {
  const items: ComparisonQuoteItemData[] = (cq.items ?? []).map((it) => toPdfItem({
    description: String(it.description ?? ''),
    languagePair: (it.languagePair as string | null) ?? null,
    quantity: Number(it.quantity) || 0,
    unit: String(it.unit ?? '건'),
    unitPrice: Number(it.unitPrice) || 0,
    amount: Number(it.amount) || 0,
    memo: (it.memo as string | null) ?? null,
  }));
  const issueTypeUnset = cq.issueType !== 'vendor_confirmed' && cq.issueType !== 'internal_simulation';
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
    issueType: cq.issueType === 'vendor_confirmed' ? 'vendor_confirmed' : 'internal_simulation',
    issueTypeUnset,
    issueDate: cq.quoteDate || kstDate(cq.createdAt) || null,
    terms: cleanTerms(cq.terms),
    design: normalizeDesign(cq.designSettings),
    logoDataUrl: cq.logoDataUrl ?? null,
    stampDataUrl: cq.stampDataUrl ?? null,
  };
}

/** 비교견적 PDF 파일명 — VERITAS 접두어를 절대 붙이지 않는다. */
export function buildComparisonFileName(companyName: string, quoteDate?: string | null, issueType?: ComparisonIssueType): string {
  const safe = (companyName || '비교견적').replace(/[\\/:*?"<>|]/g, '_').trim();
  const d = (quoteDate ?? '').replace(/-/g, '');
  // 내부 비교용은 파일명에서도 구분(외부 발행 문서로 오인 방지)
  return `${issueType === 'internal_simulation' ? '내부비교용_' : ''}비교견적_${safe}${d ? '_' + d : ''}`;
}
