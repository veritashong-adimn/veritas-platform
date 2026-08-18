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
// §12-2 지급상태 — 수행정보 상태는 지급상태로 단일화(정산상태 제거)
//  · 3단계 표준화(미지급·지급보류·지급완료). 구 값(지급대기·지급예정·일부지급)은 미지급으로 일괄 변환(마이그레이션 참조).
export const PAYMENT_STATUS_OPTS = [
  { value: 'unpaid', label: '미지급' },
  { value: 'payment_hold', label: '지급보류' },
  { value: 'paid', label: '지급완료' },
];
// 수행정보 화면에서 사용자가 직접 선택 가능한 지급상태 — 미지급·지급보류만.
//  지급완료(paid)는 정산 > 지급회차 [지급완료] 처리로만 자동 변경되며, 여기서 직접 선택할 수 없다.
export const PAYMENT_STATUS_SELECTABLE_OPTS = PAYMENT_STATUS_OPTS.filter(o => o.value !== 'paid');
// §9-2 단위
export const UNIT_OPTS = ['일', '시간', '건', '페이지', '단어', '자', '식', '세트', '대', '개', '월', '기타']
  .map(v => ({ value: v, label: v }));
// §10 조정항목(추가비용) — 추가항목(+) 구분. 기본수행료 외 모든 추가비용. 이후 항목 자유 확장 가능.
//  · '수가통역료'는 표시명 오타 → '추가통역료'로 수정. value는 데이터 호환을 위해 그대로 유지(라벨만 변경).
export const EXPENSE_TYPE_OPTS = [
  { value: '교통비', label: '교통비' },
  { value: '출장비', label: '출장비' },
  { value: '숙박비', label: '숙박비' },
  { value: '식비', label: '식비' },
  { value: '수가통역료', label: '추가통역료' },
  { value: '저작권료', label: '저작권료' },
  { value: '이동일보상', label: '이동일보상' },
  { value: '취소보상', label: '취소보상' },
];
// 직접입력 센티넬 — 목록에서 선택 시 텍스트 입력창으로 전환(항목명 자유 입력). 실제 저장은 입력한 항목명 문자열이 expenseType에 그대로 들어감(DB 컬럼·계산 로직 불변).
export const CUSTOM_EXPENSE_VALUE = '__custom__';
export const EXPENSE_TYPE_SELECT_OPTS = [...EXPENSE_TYPE_OPTS, { value: CUSTOM_EXPENSE_VALUE, label: '직접입력' }];
// 사전 정의된 추가비용 value 집합 — 이 집합에 없는 expenseType은 '직접입력'(사용자 항목명)으로 간주해 텍스트 입력창으로 표시.
export const PREDEFINED_EXPENSE_VALUES = new Set(EXPENSE_TYPE_OPTS.map(o => o.value));
// §10 조정항목 — 차감항목(-) 구분. 순서 고정: 패널티·환수·선지급 차감·직접입력.
//  · 추가항목과 동일 UX: '직접입력' 선택 시 첫 칸이 텍스트 입력으로 전환되어 항목명을 deductionType에 그대로 저장(별도 사유칸 없음).
export const DEDUCTION_TYPE_OPTS = ['패널티', '환수', '선지급 차감'].map(v => ({ value: v, label: v }));
export const CUSTOM_DEDUCTION_VALUE = '__custom__';
export const DEDUCTION_TYPE_SELECT_OPTS = [...DEDUCTION_TYPE_OPTS, { value: CUSTOM_DEDUCTION_VALUE, label: '직접입력' }];
// 사전 정의된 차감 value 집합 — 이 집합에 없는 deductionType은 '직접입력'(사용자 항목명)으로 간주해 텍스트 입력창으로 표시.
export const PREDEFINED_DEDUCTION_VALUES = new Set(DEDUCTION_TYPE_OPTS.map(o => o.value));

export const RESIDENCY_OPTS = [
  { value: 'domestic_resident', label: '국내 거주자' },
  { value: 'overseas_or_nonresident', label: '해외 거주자·비거주자' },
];
// 세금처리(구 '원천징수') 선택지 — 3개 고정. DB enum은 그대로 재사용(스키마 변경 없음), UI 명칭만 매핑.
//  · 3.3% = domestic_3_3 / 원천징수 예외 = exempt / 세금계산서 = tax_review_required(사업자 지급·원천세 없음).
//  · 직접입력·세율 입력·별도 입력칸은 없음(드롭다운 하나).
export const TREATMENT_OPTS = [
  { value: 'domestic_3_3', label: '3.3%' },
  { value: 'domestic_2_2', label: '2.2%' },
  { value: 'exempt', label: '원천징수 예외' },
  { value: 'tax_review_required', label: '세금계산서' },
];
// 표시·저장용 정규화 — 레거시 값을 신규 옵션으로 매핑. 저장 enum은 그대로 사용.
//  · 미사용 레거시(비거주자·조세조약·기타 직접입력 = nonresident_custom/treaty)는 '원천징수 예외'(exempt)로 통합.
export const normalizeTreatment = (v?: string | null) => {
  if (v === 'domestic_3_3' || v === 'domestic_2_2' || v === 'exempt' || v === 'tax_review_required') return v;
  if (v === 'nonresident_custom' || v === 'treaty_reduction_or_exemption') return 'exempt';
  return v ?? '';
};
// 세금처리 유효값 — 외주업체(vendor)는 미설정 시 기본 '세금계산서'(tax_review_required). 방안 A: 기록용, 지급액 계산 불변.
export const effectiveTreatment = (r: { withholdingTreatment?: string | null; performerCategory?: string | null }) => {
  const t = normalizeTreatment(r.withholdingTreatment);
  if (!t && r.performerCategory === 'vendor') return 'tax_review_required';
  return t;
};
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
export const PAYMENT_STATUS_LABEL: Record<string, string> = Object.fromEntries(PAYMENT_STATUS_OPTS.map(o => [o.value, o.label]));
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
// 표시용: 수량·분량의 불필요한 소수점 0만 제거(정수→소수점 없음, 1.5·2.25 등 실소수는 유지). 저장값은 숫자 그대로.
export const trimNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// 금액 표시용: 소수점 없이 천 단위 콤마(입력 중 자동 적용). 콤마 포함 문자열도 정상 처리.
export const commafy = (v: unknown): string => {
  if (v == null || v === '') return '';
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '';
};
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
  remark?: string | null;               // 비고 — 사용자 자유입력 운영 메모(우측 끝 컬럼)
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
  // 지급 상태 (§12) — 정산상태·지급명세서 상태 제거, 지급상태로 단일화
  paymentStatus?: string | null;
  actualPaymentAmount?: string | number | null;
  payoutRoundId?: number | null;      // 지급회차(삭제 차단 판정)
  payStatementId?: number | null;     // 지급명세서 ID(향후 지급관리 모듈) — 수행정보에서 편집하지 않음
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
  payDateChangeReason: p.payDateChangeReason, memo: p.memo, remark: p.remark,
  contractUnitPrice: initialContractUnitPrice(p), quantity: trimNum(p.quantity), unit: p.unit,
  isDirectAmount: p.isDirectAmount ?? false, directAmount: p.basePerformanceFee,
  basePerformanceFee: p.basePerformanceFee, expenseTotal: p.expenseTotal,
  deductionTotal: p.deductionTotal, costTotal: p.costTotal,
  paymentStatus: p.paymentStatus ?? 'unpaid',
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

// 번역 계열(번역·감수·교정·DTP·영상/자막) 판별 — performanceServiceDetail svcKind 'translation' 과 동일 기준(단일 출처).
//   번역 수행원가는 페이지수가 아닌 작업량(단어/글자) 기준으로 계산하므로, 그 대상 행을 이 술어로 판정한다.
export function isTranslationKind(r: Row): boolean {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const t = String(r.serviceType || snap.itemType || '').toLowerCase();
  const ck = String(snap.canonicalKey || '').toLowerCase();
  const pt = String(snap.productType || '').toLowerCase();
  return /translat|번역|proofread|감수|교정|dtp|media|영상|미디어|subtitle|자막/.test(t)
    || ck.startsWith('tr:') || ck.startsWith('dt:') || /translat/.test(pt);
}

// 통역 계열 판별 — performanceServiceDetail svcKind 'interpretation' 과 동일 기준(단일 출처).
//   통역 수행원가 = 계약단가 × 수행일수 × 인원 이므로, 그 대상 행을 이 술어로 판정한다.
export function isInterpretationKind(r: Row): boolean {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const t = String(r.serviceType || snap.itemType || '').toLowerCase();
  const ck = String(snap.canonicalKey || '').toLowerCase();
  const pt = String(snap.productType || '').toLowerCase();
  return /interpret|통역/.test(t) || ck.startsWith('in:') || ck.startsWith('co:') || /interpret/.test(pt);
}

// 장비 계열 판별(§계약단가통일) — 서버 classifyPerformer 장비 토큰과 동일 기준(음향·부스·수신기 등 포함).
//   장비는 외주(vendor)로 분류되지만, 원가는 계약단가 × 수량으로 산정하므로 이 술어로 대상을 판정한다.
export function isEquipmentKind(r: Row): boolean {
  const snap = (r.serviceDetailSnapshot ?? {}) as any;
  const t = String(r.serviceType || snap.itemType || '').toLowerCase();
  const ck = String(snap.canonicalKey || '').toLowerCase();
  const pt = String(snap.productType || '').toLowerCase();
  return /equip|장비|rental|렌탈|렌털|음향|수신기|송신기|부스|헤드셋|헤드폰|이어폰|마이크|스피커|앰프/.test(t)
    || ck.startsWith('eq:') || /equip/.test(pt);
}

// 통역 수행인원(§계약단가통일) — 계약단가는 '통역사 1인 × 1일' 단가이므로 인원을 곱한다. 미지정 시 1명.
export function interpreterHeadcount(snap: any): number {
  const n = num(snap?.interpreterCount);
  return n > 0 ? n : 1;
}

// §5·§6 계약단가 초기값 — 저장값이 있으면 그대로, 없으면 판매 공급단가(saleUnitPrice)를 초기 표시값으로 사용한다.
//   번역은 제외: 번역 계약단가는 단어/글자 기준이라 페이지 기준 판매 공급단가와 단위가 달라 초기복사 시 오계산됨.
export function initialContractUnitPrice(p: any): string | number | null {
  if (p.contractUnitPrice != null && p.contractUnitPrice !== '') return p.contractUnitPrice;
  if (isTranslationKind(p as Row)) return p.contractUnitPrice ?? null;
  const snap = (p.serviceDetailSnapshot ?? {}) as any;
  return snap.saleUnitPrice != null && snap.saleUnitPrice !== '' ? String(snap.saleUnitPrice) : (p.contractUnitPrice ?? null);
}

// 번역 원가·정산 작업량(§작업량통일) — wordCount 우선, 없으면 charCount, 둘 다 없으면 null(계산 불가).
//   페이지수(pageCount·판매 quantity)는 번역 원가에 사용하지 않는다(판매정보 참고값으로만 유지).
export function translationWorkAmount(snap: any): { amount: number; basis: 'word' | 'char' } | null {
  if (!snap) return null;
  const w = num(snap.wordCount);
  if (w > 0) return { amount: w, basis: 'word' };
  const c = num(snap.charCount);
  if (c > 0) return { amount: c, basis: 'char' };
  return null;
}

// 기본수행료 = 직접금액 or 계약단가×작업량 (구분별). 원가합계 = 기본수행료 + Σ지급대상추가비용 − Σ차감
//   · 번역 계열: 계약단가 × 단어수/글자수(§작업량통일). 페이지수는 사용하지 않으며, 작업량이 없으면 자동계산하지 않는다.
//   · 통역 계열: 계약단가 × 수행일수(quantity) × 인원(interpreterCount). 계약단가는 1인·1일 단가.
//   · 장비 등: 계약단가 × 수량(기존 로직 유지 — 일수 기준 장비는 quantity에 사용일수가 반영됨).
export function calcRowCostPreview(r: Row): { base: number; expenseTotal: number; deductionTotal: number; costTotal: number } {
  const hasUnitPrice = r.contractUnitPrice != null && r.contractUnitPrice !== '';
  const hasQty = r.quantity != null && r.quantity !== '';
  let base: number;
  if (isEquipmentKind(r)) {
    // 장비 원가 = 계약단가 × 수량(§계약단가통일). 계약단가가 없으면 기존 공급가액을 유지(자동 재계산 안 함).
    //   (장비는 외주로 분류되므로 vendor 분기보다 먼저 판정한다. 부가세는 서버에서 공급가액 기준으로 별도 계산 — 불변.)
    base = (hasUnitPrice && hasQty)
      ? round2(num(r.contractUnitPrice) * num(r.quantity))
      : round2(num(r.supplyAmount));
  }
  else if (r.performerCategory === 'vendor') base = round2(num(r.supplyAmount));
  else if (r.performerCategory === 'expense') base = round2(num(r.directAmount));
  else if (r.isDirectAmount) base = round2(num(r.directAmount));
  else if (isTranslationKind(r)) {
    // 번역 원가 = 계약단가 × 작업량(단어/글자). 페이지수(quantity) 미사용.
    //   작업량이 없으면 페이지로 자동계산하지 않고 기존 기본수행료를 유지(계산 불가 → 임의 재계산 금지).
    const work = translationWorkAmount((r.serviceDetailSnapshot ?? {}) as any);
    base = (hasUnitPrice && work)
      ? round2(num(r.contractUnitPrice) * work.amount)
      : round2(num(r.baseFee));
  }
  else if (isInterpretationKind(r)) {
    // 통역 원가 = 계약단가(1인·1일) × 수행일수(quantity) × 인원(interpreterCount, 없으면 1).
    const persons = interpreterHeadcount((r.serviceDetailSnapshot ?? {}) as any);
    base = (hasUnitPrice && hasQty)
      ? round2(num(r.contractUnitPrice) * num(r.quantity) * persons)
      : round2(num(r.baseFee));
  }
  else if (hasUnitPrice && hasQty)
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
  // 세금처리(구 원천징수) — 3.3%만 원천세 발생, 원천징수 예외·세금계산서는 원천세 0(실지급=지급금액).
  switch (normalizeTreatment(r.withholdingTreatment)) {
    case 'domestic_3_3': rate = 3.3; break;
    case 'domestic_2_2': rate = 2.2; break;
    case 'exempt': rate = 0; break;
    case 'tax_review_required': rate = 0; break;   // 세금계산서 — 사업자 지급, 원천세 없음
    default: rate = 0; confirmed = false; break;   // 미선택(빈값)
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
const PAYMENT_TONE: Record<string, Tone> = {
  unpaid: 'gray', payment_hold: 'red', paid: 'green',
};

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  const t = TONE[tone];
  return (
    <span style={{ ...TYPO.badge, display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}
export const PaymentBadge = ({ value }: { value?: string | null }) =>
  <Badge label={PAYMENT_STATUS_LABEL[value ?? 'unpaid'] ?? '미지급'} tone={PAYMENT_TONE[value ?? 'unpaid'] ?? 'gray'} />;
