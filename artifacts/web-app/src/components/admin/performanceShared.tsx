// ─────────────────────────────────────────────────────────────────────────────
// 수행정보 공용 모듈 — 타입·옵션·계산 미러·배지. Section/DetailPanel/ProfitSummary 공유.
//  · 금액 계산은 서버(@workspace/db calc*)를 미러링한 "미리보기" — 최종은 서버 재계산(§31·§37).
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { C, TYPO } from '../../lib/ds';

// ── 옵션 ──────────────────────────────────────────────────────────────────────
// 상위 구분(집계·필터 기준). 표시명은 개인→통번역사로 단순화(§5·§10).
export const CATEGORY_OPTS = [
  { value: 'individual', label: '통번역사' },
  { value: 'vendor', label: '외주업체' },
  { value: 'expense', label: '경비' },
];
// 통합 구분 드롭다운(§2·§4) — 구분+세부구분을 하나로. 화면값 1개 = (상위유형 category + 세부라벨 lineCategory).
//   내부 DB 구조(performerCategory + lineCategory)는 유지 — 선택 시 두 필드로 분해 저장(§9).
export const PERFORMER_TYPE_OPTS = [
  { value: 'translator',            label: '통번역사',     category: 'individual', lineCategory: '통번역사' },
  { value: 'translation_vendor',    label: '번역업체',     category: 'vendor',     lineCategory: '번역업체' },
  { value: 'interpretation_vendor', label: '통역업체',     category: 'vendor',     lineCategory: '통역업체' },
  { value: 'equipment_vendor',      label: '장비업체',     category: 'vendor',     lineCategory: '장비업체' },
  { value: 'dtp_vendor',            label: 'DTP업체',      category: 'vendor',     lineCategory: 'DTP업체' },
  { value: 'media_vendor',          label: '미디어업체',   category: 'vendor',     lineCategory: '미디어업체' },
  { value: 'general_vendor',        label: '일반 외주업체', category: 'vendor',     lineCategory: '외주업체' },
  { value: 'expense',               label: '경비',         category: 'expense',    lineCategory: '경비' },
  { value: 'etc',                   label: '기타',         category: 'expense',    lineCategory: '기타' },
] as const;

// 레거시·현행 lineCategory → 통합 드롭다운 key (기존 데이터 호환 §9)
const LEGACY_LINE_TO_KEY: Record<string, string> = {
  '개인 통번역사': 'translator', '통번역사': 'translator', '개인사업자': 'translator', '내부인력': 'translator',
  '번역업체': 'translation_vendor', '통역업체': 'interpretation_vendor',
  '장비업체': 'equipment_vendor', 'DTP업체': 'dtp_vendor', '미디어업체': 'media_vendor',
  '외주업체': 'general_vendor', '일반 외주업체': 'general_vendor',
  '경비': 'expense', '기타': 'etc',
};
// (performerCategory + lineCategory) → 통합 드롭다운 값. 미지정·레거시도 안전 폴백.
export function resolvePerformerType(r: { performerCategory?: string | null; lineCategory?: string | null }): string {
  const lc = (r.lineCategory ?? '').trim();
  if (lc && LEGACY_LINE_TO_KEY[lc]) return LEGACY_LINE_TO_KEY[lc];
  const cat = r.performerCategory ?? 'individual';
  if (cat === 'vendor') return 'general_vendor';
  if (cat === 'expense') return lc === '기타' ? 'etc' : 'expense';
  return 'translator';
}
export function performerTypeLabel(r: { performerCategory?: string | null; lineCategory?: string | null }): string {
  const key = resolvePerformerType(r);
  return PERFORMER_TYPE_OPTS.find(o => o.value === key)?.label ?? '통번역사';
}
// 선택된 통합값을 표준 lineCategory 로 정규화(저장 시 레거시 라벨을 신규 라벨로 지연 이관)
export function canonicalLineCategory(r: { performerCategory?: string | null; lineCategory?: string | null }): string {
  const key = resolvePerformerType(r);
  return PERFORMER_TYPE_OPTS.find(o => o.value === key)?.lineCategory ?? (r.lineCategory ?? '');
}
export const STATUS_OPTS = [
  { value: 'unassigned', label: '미배정' },
  { value: 'assigned', label: '배정완료' },
  { value: 'in_progress', label: '수행중' },
  { value: 'completed', label: '수행완료' },
  { value: 'payout_pending', label: '지급대기' },
  { value: 'paid', label: '지급완료' },
  { value: 'cancelled', label: '취소' },
];
// §12-1 정산상태
export const SETTLEMENT_STATUS_OPTS = [
  { value: 'unsettled', label: '미정산' },
  { value: 'settlement_waiting', label: '정산대기' },
  { value: 'reviewing', label: '검토중' },
  { value: 'settlement_hold', label: '정산보류' },
  { value: 'settlement_confirmed', label: '정산확정' },
];
// §12-2 지급상태
export const PAYMENT_STATUS_OPTS = [
  { value: 'unpaid', label: '미지급' },
  { value: 'payment_waiting', label: '지급대기' },
  { value: 'payment_scheduled', label: '지급예정' },
  { value: 'partial', label: '일부지급' },
  { value: 'paid', label: '지급완료' },
  { value: 'payment_hold', label: '지급보류' },
];
// §12-3 지급명세서 상태
export const PAY_STATEMENT_STATUS_OPTS = [
  { value: 'not_created', label: '미생성' },
  { value: 'created', label: '생성완료' },
  { value: 'sent', label: '발송완료' },
  { value: 'revised', label: '수정본 발행' },
];
// §9-2 단위
export const UNIT_OPTS = ['일', '시간', '건', '페이지', '단어', '자', '식', '세트', '대', '개', '월', '기타']
  .map(v => ({ value: v, label: v }));
// §10 추가비용 구분
export const EXPENSE_TYPE_OPTS = ['교통비', '출장비', '숙박비', '식비', '장비비', '기타비용'].map(v => ({ value: v, label: v }));
// §10 차감 구분
export const DEDUCTION_TYPE_OPTS = ['선지급금 차감', '과지급금 회수', '계약상 차감', '기타 조정'].map(v => ({ value: v, label: v }));

export const RESIDENCY_OPTS = [
  { value: 'domestic_resident', label: '국내 거주자' },
  { value: 'overseas_or_nonresident', label: '해외 거주자·비거주자' },
];
export const TREATMENT_OPTS = [
  { value: 'domestic_3_3', label: '국내 거주자 3.3%' },
  { value: 'exempt', label: '원천징수 제외' },
  { value: 'nonresident_custom', label: '비거주자 별도 원천징수' },
  { value: 'treaty_reduction_or_exemption', label: '조세조약 감면·면제' },
  { value: 'tax_review_required', label: '세무 확인 필요' },
];
export const EVIDENCE_OPTS = [
  { value: 'tax_invoice', label: '세금계산서' },
  { value: 'invoice', label: '계산서' },
  { value: 'zero_rate_tax_invoice', label: '영세율 세금계산서' },
  { value: 'other', label: '기타 증빙' },
  { value: 'none', label: '미발행' },
];
export const FEE_FIELDS: { key: keyof Row; label: string }[] = [
  { key: 'baseFee', label: '수행료' },
  { key: 'transportationFee', label: '교통비' },
  { key: 'businessTripFee', label: '출장비' },
  { key: 'copyrightFee', label: '저작권료' },
  { key: 'travelDayCompensation', label: '이동일 보상비' },
  { key: 'cancellationCompensation', label: '취소보상비' },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORY_OPTS.map(o => [o.value, o.label]));
export const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUS_OPTS.map(o => [o.value, o.label]));
export const SETTLEMENT_STATUS_LABEL: Record<string, string> = Object.fromEntries(SETTLEMENT_STATUS_OPTS.map(o => [o.value, o.label]));
export const PAYMENT_STATUS_LABEL: Record<string, string> = Object.fromEntries(PAYMENT_STATUS_OPTS.map(o => [o.value, o.label]));
export const PAY_STATEMENT_STATUS_LABEL: Record<string, string> = Object.fromEntries(PAY_STATEMENT_STATUS_OPTS.map(o => [o.value, o.label]));
export const SERVICE_LABEL: Record<string, string> = {
  translation: '번역', interpretation: '통역', equipment: '장비', expense: '기타',
  proofreading: '감수', editing: '편집/DTP', media: '미디어', operations: '운영/실비', combined: '통번역',
};
export const VENDOR_TYPE_LABEL: Record<string, string> = {
  interpretation_equipment: '장비', editing: '편집/자막', translation_agency: '통번역업체',
  cleaning: '청소', water_supply: '상수도', etc: '기타',
};

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────
export const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString();
export const num = (v: unknown) => Number(v ?? 0) || 0;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const dateVal = (s?: string | null) => (s ? String(s).slice(0, 10) : '');

// ── 하위행 타입 ───────────────────────────────────────────────────────────────
export interface ExpenseRow {
  id?: number;
  expenseType: string;
  amount?: string | number | null;
  incurredDate?: string | null;
  includedInPayout?: boolean;
  evidenceUrl?: string | null;
  evidenceFileName?: string | null;
  memo?: string | null;
}
export interface DeductionRow {
  id?: number;
  deductionType: string;
  amount?: string | number | null;
  reason?: string | null;
}

// ── 편집 행 모델 ──────────────────────────────────────────────────────────────
export interface Row {
  id?: number;
  saleItemId?: number | null;
  performerCategory: string;
  lineCategory?: string | null;
  status: string;
  serviceType?: string | null;
  productNameSnapshot?: string | null;
  serviceDetailSnapshot?: any;          // 서비스 유형별 판매 상세 스냅샷(§6·§10)
  languageOrServiceSnapshot?: string | null;
  performanceStartDate?: string | null;
  performanceEndDate?: string | null;
  deliveryDate?: string | null;
  deliveryDateAuto?: string | null;
  deliveryDateManual?: boolean;
  deliveryConfirmed?: boolean;
  deliveryConfirmedBy?: number | null;
  deliveryConfirmedAt?: string | null;
  expectedPaymentDate?: string | null;
  expectedPaymentDateAuto?: string | null;
  payDateManual?: boolean;
  payDateChangeReason?: string | null;
  memo?: string | null;
  // 계약단가·수량 (§7·§9)
  contractUnitPrice?: string | number | null;
  quantity?: string | number | null;
  unit?: string | null;
  isDirectAmount?: boolean;
  directAmount?: string | number | null;
  // 원가 합계 (서버 계산값, 표시)
  basePerformanceFee?: string | number | null;
  expenseTotal?: string | number | null;
  deductionTotal?: string | number | null;
  costTotal?: string | number | null;
  // 정산·지급·명세서 상태 (§12)
  settlementStatus?: string | null;
  paymentStatus?: string | null;
  payStatementStatus?: string | null;
  actualPaymentAmount?: string | number | null;
  payoutRoundId?: number | null;      // 지급회차(삭제 차단 판정)
  payStatementId?: number | null;     // 지급명세서(삭제 차단 판정)
  // 개인 통번역사
  individualUserId?: number | null;
  performerNameSnapshot?: string | null;
  identifierSnapshotMasked?: string | null;
  residenceCountrySnapshot?: string | null;
  residencyType?: string | null;
  serviceCountry?: string | null;
  withholdingTreatment?: string | null;
  withholdingRate?: string | number | null;
  baseFee?: string | number | null;
  transportationFee?: string | number | null;
  businessTripFee?: string | number | null;
  copyrightFee?: string | number | null;
  travelDayCompensation?: string | number | null;
  cancellationCompensation?: string | number | null;
  // 외주업체
  vendorCompanyId?: number | null;
  vendorTypeSnapshot?: string | null;
  purchaseEvidenceType?: string | null;
  purchaseInvoiceDate?: string | null;
  actualPaymentDate?: string | null;
  // 정산요약(읽기전용)
  grossPayment?: string | number | null;
  withholdingTax?: string | number | null;
  netPayment?: string | number | null;
  supplyAmount?: string | number | null;
  vatAmount?: string | number | null;
  totalPurchaseAmount?: string | number | null;
  // 하위 다건
  expenses?: ExpenseRow[];
  deductions?: DeductionRow[];
}

export const toRow = (p: any): Row => ({
  id: p.id, saleItemId: p.saleItemId,
  performerCategory: p.performerCategory ?? 'individual',
  lineCategory: p.lineCategory,
  status: p.status ?? 'unassigned',
  serviceType: p.serviceType, productNameSnapshot: p.productNameSnapshot,
  serviceDetailSnapshot: p.serviceDetailSnapshot,
  languageOrServiceSnapshot: p.languageOrServiceSnapshot,
  performanceStartDate: p.performanceStartDate, performanceEndDate: p.performanceEndDate,
  deliveryDate: p.deliveryDate,
  deliveryDateAuto: p.deliveryDateAuto,
  deliveryDateManual: p.deliveryDateManual ?? false,
  deliveryConfirmed: p.deliveryConfirmed ?? false,
  deliveryConfirmedBy: p.deliveryConfirmedBy, deliveryConfirmedAt: p.deliveryConfirmedAt,
  expectedPaymentDate: p.expectedPaymentDate, expectedPaymentDateAuto: p.expectedPaymentDateAuto,
  payDateManual: p.payDateManual ?? false,
  payDateChangeReason: p.payDateChangeReason, memo: p.memo,
  contractUnitPrice: p.contractUnitPrice, quantity: p.quantity, unit: p.unit,
  isDirectAmount: p.isDirectAmount ?? false, directAmount: p.basePerformanceFee,
  basePerformanceFee: p.basePerformanceFee, expenseTotal: p.expenseTotal,
  deductionTotal: p.deductionTotal, costTotal: p.costTotal,
  settlementStatus: p.settlementStatus ?? 'unsettled',
  paymentStatus: p.paymentStatus ?? 'unpaid',
  payStatementStatus: p.payStatementStatus ?? 'not_created',
  actualPaymentAmount: p.actualPaymentAmount,
  payoutRoundId: p.payoutRoundId, payStatementId: p.payStatementId,
  individualUserId: p.individualUserId, performerNameSnapshot: p.performerNameSnapshot,
  identifierSnapshotMasked: p.identifierSnapshotMasked, residenceCountrySnapshot: p.residenceCountrySnapshot,
  residencyType: p.residencyType, serviceCountry: p.serviceCountry,
  withholdingTreatment: p.withholdingTreatment, withholdingRate: p.withholdingRate,
  baseFee: p.baseFee, transportationFee: p.transportationFee, businessTripFee: p.businessTripFee,
  copyrightFee: p.copyrightFee, travelDayCompensation: p.travelDayCompensation, cancellationCompensation: p.cancellationCompensation,
  vendorCompanyId: p.vendorCompanyId, vendorTypeSnapshot: p.vendorTypeSnapshot,
  purchaseEvidenceType: p.purchaseEvidenceType, purchaseInvoiceDate: p.purchaseInvoiceDate, actualPaymentDate: p.actualPaymentDate,
  grossPayment: p.grossPayment, withholdingTax: p.withholdingTax, netPayment: p.netPayment,
  supplyAmount: p.supplyAmount, vatAmount: p.vatAmount, totalPurchaseAmount: p.totalPurchaseAmount,
  expenses: Array.isArray(p.expenses) ? p.expenses.map((e: any) => ({
    id: e.id, expenseType: e.expenseType, amount: e.amount, incurredDate: e.incurredDate,
    includedInPayout: e.includedInPayout ?? true, evidenceUrl: e.evidenceUrl, evidenceFileName: e.evidenceFileName, memo: e.memo,
  })) : [],
  deductions: Array.isArray(p.deductions) ? p.deductions.map((d: any) => ({
    id: d.id, deductionType: d.deductionType, amount: d.amount, reason: d.reason,
  })) : [],
});

// ── 계산 미러 (서버 @workspace/db 미러링) ─────────────────────────────────────
// 지급예정일 자동계산: 1~15일→월말, 16~말일→익월15
export function calcExpectedPaymentDate(deliveryDate?: string | null): string | null {
  if (!deliveryDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(deliveryDate);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const p2 = (n: number) => String(n).padStart(2, '0');
  if (day <= 15) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${p2(month)}-${p2(lastDay)}`;
  }
  let ny = year, nm = month + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return `${ny}-${p2(nm)}-15`;
}

// ── 영업일(주말·공휴일) 조정 미러 (서버 @workspace/db previousBusinessDay 와 동일 규칙 §7) ──
//  · "YYYY-MM-DD" 문자열 전용. 요일은 UTC 순수연산 → 타임존 밀림 없음(§15).
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
export function dayOfWeekKST(dateStr?: string | null): number {
  const m = dateStr ? DATE_RE.exec(dateStr) : null;
  if (!m) return -1;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}
export function addDaysStr(dateStr: string, delta: number): string {
  const m = DATE_RE.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
export function isWeekend(dateStr?: string | null): boolean {
  const w = dayOfWeekKST(dateStr);
  return w === 0 || w === 6;
}
// 직전 영업일 — 주말·공휴일이면 영업일 나올 때까지 하루씩 이전으로(연속 연휴 포함).
export function previousBusinessDay(dateStr?: string | null, isHoliday: (d: string) => boolean = () => false): string | null {
  if (!dateStr) return null;
  let d = String(dateStr).slice(0, 10);
  let guard = 0;
  while ((isWeekend(d) || isHoliday(d)) && guard < 60) { d = addDaysStr(d, -1); guard += 1; }
  return d;
}
// 납품일 → 최종 지급일(기준일 → 직전 영업일). 서버와 동일 규칙.
export function calcPaymentDate(deliveryDate?: string | null, isHoliday: (d: string) => boolean = () => false): string | null {
  const base = calcExpectedPaymentDate(deliveryDate);
  if (!base) return null;
  return previousBusinessDay(base, isHoliday);
}

// 기본수행료 = 직접금액 or 계약단가×수량 (구분별). 원가합계 = 기본수행료 + Σ지급대상추가비용 − Σ차감
export function calcRowCostPreview(r: Row): { base: number; expenseTotal: number; deductionTotal: number; costTotal: number } {
  let base: number;
  if (r.performerCategory === 'vendor') base = round2(num(r.supplyAmount));
  else if (r.performerCategory === 'expense') base = round2(num(r.directAmount));
  else if (r.isDirectAmount) base = round2(num(r.directAmount));
  else if (r.contractUnitPrice != null && r.contractUnitPrice !== '' && r.quantity != null && r.quantity !== '')
    base = round2(num(r.contractUnitPrice) * num(r.quantity));
  else base = round2(num(r.baseFee));
  const expenseTotal = round2((r.expenses ?? []).filter(e => e.includedInPayout !== false).reduce((s, e) => s + num(e.amount), 0));
  const deductionTotal = round2((r.deductions ?? []).reduce((s, d) => s + num(d.amount), 0));
  return { base, expenseTotal, deductionTotal, costTotal: round2(base + expenseTotal - deductionTotal) };
}

export function calcVendorPreview(r: Row): { supply: number; vat: number; total: number } {
  const supply = round2(num(r.supplyAmount));
  let vat = 0;
  switch (r.purchaseEvidenceType) {
    case 'tax_invoice': vat = round2(supply * 0.1); break;
    case 'invoice':
    case 'zero_rate_tax_invoice': vat = 0; break;
    default: vat = round2(num(r.vatAmount)); break;
  }
  return { supply, vat, total: round2(supply + vat) };
}

export function calcIndivPreview(r: Row): { gross: number; rate: number; tax: number; net: number; confirmed: boolean } {
  const gross = round2(num(r.baseFee) + num(r.transportationFee) + num(r.businessTripFee) +
    num(r.copyrightFee) + num(r.travelDayCompensation) + num(r.cancellationCompensation));
  let rate = 0, confirmed = true;
  switch (r.withholdingTreatment) {
    case 'domestic_3_3': rate = 3.3; break;
    case 'exempt': rate = 0; break;
    case 'nonresident_custom':
    case 'treaty_reduction_or_exemption': rate = num(r.withholdingRate); break;
    default: rate = 0; confirmed = false; break;
  }
  const tax = confirmed ? round2(gross * (rate / 100)) : 0;
  return { gross, rate, tax, net: round2(gross - tax), confirmed };
}

// ── 상태 배지 (기존 시스템과 동일 인라인 배지 스타일 §19) ────────────────────────
type Tone = 'gray' | 'blue' | 'green' | 'amber' | 'red';
const TONE: Record<Tone, { bg: string; fg: string }> = {
  gray:  { bg: C.g100, fg: C.g600 },
  blue:  { bg: C.primaryBg, fg: C.primaryText },
  green: { bg: C.successBg, fg: C.successText },
  amber: { bg: '#fef3c7', fg: '#b45309' },
  red:   { bg: C.dangerBg, fg: C.dangerText },
};
const SETTLEMENT_TONE: Record<string, Tone> = {
  unsettled: 'gray', settlement_waiting: 'blue', reviewing: 'amber', settlement_hold: 'red', settlement_confirmed: 'green',
};
const PAYMENT_TONE: Record<string, Tone> = {
  unpaid: 'gray', payment_waiting: 'blue', payment_scheduled: 'blue', partial: 'amber', paid: 'green', payment_hold: 'red',
};

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  const t = TONE[tone];
  return (
    <span style={{ ...TYPO.badge, display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}
export const SettlementBadge = ({ value }: { value?: string | null }) =>
  <Badge label={SETTLEMENT_STATUS_LABEL[value ?? 'unsettled'] ?? '미정산'} tone={SETTLEMENT_TONE[value ?? 'unsettled'] ?? 'gray'} />;
export const PaymentBadge = ({ value }: { value?: string | null }) =>
  <Badge label={PAYMENT_STATUS_LABEL[value ?? 'unpaid'] ?? '미지급'} tone={PAYMENT_TONE[value ?? 'unpaid'] ?? 'gray'} />;
