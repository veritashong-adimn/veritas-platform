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
  { value: '이동일보상', label: '이동일 보상비' },
  { value: '취소보상', label: '취소보상비' },
];
// 통역 부대비용 전용 컬럼(추가통역료·출장비·교통비) — expenses[]의 특정 expenseType 행에 바인딩한다.
//   원가 SSOT는 그대로 expenses[] → expenseTotal → costTotal(= 통역료85 + Σ부대비용). 별도 컬럼·공식 추가 없음.
//   '추가통역료'는 데이터 호환을 위해 저장값 '수가통역료' 유지(라벨만 '추가통역료').
export const INTERP_ADD_FEE_TYPE = '수가통역료';
export const INTERP_BIZTRIP_TYPE = '출장비';
export const INTERP_TRANSPORT_TYPE = '교통비';
export const INTERP_DEDICATED_EXPENSE_TYPES = [INTERP_ADD_FEE_TYPE, INTERP_BIZTRIP_TYPE, INTERP_TRANSPORT_TYPE];
// 기타비용(통역) 팝업 신규 추가 시 기본 항목 — 전용 3종을 제외한 나머지(저작권료 등).
export const INTERP_ETC_DEFAULT_TYPE = '저작권료';
// ── 동적 기타비용 컬럼(§기타비용동적) — 전용3종(추가통역료·출장비·교통비) 외 기타비용을 개별 테이블 컬럼으로 표시. ──
//   저장구조 재사용: 각 컬럼 = expenses[] 의 특정 expenseType. 신규 DB 필드·스키마 변경 없음(§10).
//   선택기 옵션 — 전용3종 제외. label 은 EXPENSE_TYPE_OPTS 와 동일(저장값=value).
export const ETC_SELECTABLE_TYPES = EXPENSE_TYPE_OPTS.filter(o => !INTERP_DEDICATED_EXPENSE_TYPES.includes(o.value));
// 알려진 기타비용 컬럼의 고정 표시순서(저장값 기준). 데이터 유래 컬럼(재조회) 정렬에 사용 — 행마다 순서 동일(§5).
export const ETC_KNOWN_ORDER = ETC_SELECTABLE_TYPES.map(o => o.value);
// expenseType(저장값) → 표시 라벨. 커스텀(직접입력) 항목은 항목명 그대로.
export function etcColLabel(type: string): string {
  return EXPENSE_TYPE_OPTS.find(o => o.value === type)?.label ?? type;
}
// 데이터셋 전 행의 동적 기타비용 컬럼 합집합(§5) — 전용3종 제외. pinned(사용자 선택 빈컬럼, 삽입순)를 앞에, 데이터 유래는 고정순서 뒤에.
export function computeEtcCols(data: Row[], pinned: string[] = []): string[] {
  const dedicated = new Set(INTERP_DEDICATED_EXPENSE_TYPES as string[]);
  const result: string[] = [];
  const push = (t?: string | null) => { if (t && !dedicated.has(t) && !result.includes(t)) result.push(t); };
  for (const t of pinned) push(t);                                   // 사용자 선택(삽입 순서 유지 §3)
  const dataTypes = new Set<string>();
  for (const r of data) for (const e of (r.expenses ?? [])) if (e.expenseType && !dedicated.has(e.expenseType)) dataTypes.add(e.expenseType);
  const rest = [...dataTypes].filter(t => !result.includes(t));
  for (const t of ETC_KNOWN_ORDER) if (rest.includes(t)) push(t);   // 알려진 항목 고정 순서
  for (const t of rest.filter(t => !ETC_KNOWN_ORDER.includes(t)).sort()) push(t);  // 커스텀 알파벳
  return result;
}
// 특정 동적 컬럼(type)을 실제 사용(항목 존재)하는 행이 하나도 없으면 true → 컬럼 완전 제거 가능(§8).
export function etcColIsEmpty(data: Row[], type: string): boolean {
  return !data.some(r => (r.expenses ?? []).some(e => e.expenseType === type));
}

// ── 비용항목 지급률(§비용지급률) — 기준금액 × 지급률(%) = 실제 지급액(amount). 정산·계산은 amount 그대로 사용. ──
// 항목별 기본 지급률(%) — 신규 입력 시 기본값. 사용자가 수정 가능(강제 아님 §3·§6).
//   85% 기본: 추가통역료(수가통역료)·출장비·저작권료·이동일보상·취소보상. 그 외(교통비·숙박비·식비·직접입력) = 100%(§7·§8).
const DEFAULT_85_TYPES = new Set(['수가통역료', '출장비', '저작권료', '이동일보상', '취소보상']);
export function defaultPayoutRate(expenseType: string): number {
  return DEFAULT_85_TYPES.has(expenseType) ? 85 : 100;
}
// 저장된 지급률(없으면 100%). 값이 있으면 그대로.
export function effectivePayoutRate(e: { payoutRate?: string | number | null }): number {
  return e.payoutRate == null || e.payoutRate === '' ? 100 : num(e.payoutRate);
}
// 표시용 기준금액 — baseAmount 우선, 없으면 amount(실제=기준으로 간주, 기존 데이터 호환).
export function expenseBase(e: { baseAmount?: string | number | null; amount?: string | number | null }): number {
  return e.baseAmount != null && e.baseAmount !== '' ? num(e.baseAmount) : num(e.amount);
}
// 실제 지급액 = round(기준금액 × 지급률/100).
export function actualPayout(base: number, ratePct: number): number {
  return round2(base * ratePct / 100);
}
// 실비성 비용 — 항상 100% 지급, 지급률 변경 불가(§4·§5). 팝업에 지급률 UI를 숨기고 100% 고정 처리.
export const FIXED_100_TYPES = new Set(['교통비', '숙박비', '식비']);
export function isFixed100Type(expenseType: string): boolean {
  return FIXED_100_TYPES.has(expenseType);
}
// 화면 표시용 지급률(%) — 실비성은 항상 100, 그 외는 저장값(없으면 100 §11). 셀 배지·팝업에서 공용.
export function displayPayoutRate(expenseType: string, e?: { payoutRate?: string | number | null }): number {
  if (isFixed100Type(expenseType)) return 100;
  return e && e.payoutRate != null && e.payoutRate !== '' ? num(e.payoutRate) : 100;
}

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
  amount?: string | number | null;          // 실제 지급액(지급률 적용 후) — 정산·계산 기준
  baseAmount?: string | number | null;       // 기준금액(§비용지급률). null=amount와 동일 취급
  payoutRate?: string | number | null;       // 지급률(%) 예: 85 / 100. null=100% 취급
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
  // 번역 자동매칭 dirty 마커(§11·§12) — 직전 자동입력된 수량/단위/단가 서명. 클라이언트 전용(저장 payload 미포함).
  //   현재값이 이 서명과 같으면 "사용자 미수정"으로 보고 재매칭을 허용, 다르면 사용자 수정으로 보고 보존한다.
  _autoRateSig?: string;
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
  // directAmount(기준금액 입력값) — 신규는 별도 저장된 directAmount 사용, 기존행(null)은 basePerformanceFee로 fallback(§통역료85 재조회 복원).
  isDirectAmount: p.isDirectAmount ?? false, directAmount: p.directAmount ?? p.basePerformanceFee,
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
    id: e.id, expenseType: e.expenseType, amount: e.amount, baseAmount: e.baseAmount, payoutRate: e.payoutRate, incurredDate: e.incurredDate,
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

// 1인분 정규화 — 수행정보 1행 = 통번역사 1명 원칙. 통역 상세 스냅샷의 인원수(interpreterCount)를 1로 정규화한다.
//   판매 공급가액 = 수행일수 × 인원수 × 계약단가(quote_items 규약)이므로, 인원=1이면
//   기본수행료 = 계약단가 × 수행일수 = 공급가액 / 인원수 = 1인분 기본수행료가 된다.
//   불러오기·복사에서 동일하게 사용하는 단일 로직. 원본 판매정보(quote_items)·기타 스냅샷 필드(공급가액·수량 등)는 보존한다.
export function perPersonSnapshot(snap: any): any {
  if (!snap || typeof snap !== 'object') return snap;
  return snap.interpreterCount != null ? { ...snap, interpreterCount: 1 } : snap;
}

// 계약단가 초기값 — 저장값이 있으면 그대로, 없으면 공란(null)으로 시작한다.
//   판매 공급단가(saleUnitPrice)를 초기값/폴백으로 사용하지 않는다: 판매금액과 통번역사 지급금액은
//   별개 재무 데이터이므로 판매단가를 계약단가 기본값으로 복사하지 않는다('미입력'과 '0원'은 구분).
export function initialContractUnitPrice(p: any): string | number | null {
  return (p.contractUnitPrice != null && p.contractUnitPrice !== '') ? p.contractUnitPrice : null;
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

// 번역 자동매칭 dirty 보호(§11·§12) ─────────────────────────────────────────────
// 자동입력 서명 — 수량/단위/단가 3필드의 정규화 문자열. 사용자 직접수정 감지에 사용한다.
export function autoRateSig(r: Row): string {
  const q = r.quantity == null || r.quantity === '' ? '' : String(num(r.quantity));
  const u = r.unit ?? '';
  const p = r.contractUnitPrice == null || r.contractUnitPrice === '' ? '' : String(num(r.contractUnitPrice));
  return `${q}|${u}|${p}`;
}
// 자동입력 덮어쓰기 허용 여부(§11·§12) — 자동입력 이력이 없으면 3필드가 모두 공란일 때만(최초 매칭),
//   이력이 있으면 현재값이 직전 자동입력 서명과 동일할 때만(사용자 미수정) true. 하나라도 사용자가 수정했으면 false.
//   → 번역사 변경 시에도 사용자가 손댄 값은 자동 덮어쓰지 않는다.
export function isAutoRateOverwritable(r: Row): boolean {
  if (r._autoRateSig == null) {
    const emptyQ = r.quantity == null || r.quantity === '';
    const emptyU = !r.unit;
    const emptyP = r.contractUnitPrice == null || r.contractUnitPrice === '';
    return emptyQ && emptyU && emptyP;
  }
  return autoRateSig(r) === r._autoRateSig;
}

// 통역료(85%) 지급률(§통역료85) — 통역료(85%) 입력금액은 85% 적용 전 '기준금액'. 실제 세전 반영액 = 입력금액 × 0.85.
//   화면 셀은 입력값(기준금액) 그대로 표시하고, 지급액(세전) 계산에서만 0.85를 곱한다(§1·§8). 번역 요금(100%)·경비에는 적용하지 않는다(§5).
export const INTERP_FEE_RATE = 0.85;

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
  // 직접금액(base) — 번역 요금(100%)=directAmount는 그대로, 통역 통역료(85%)=directAmount는 ×0.85 적용(§1·§2·§5).
  else if (r.isDirectAmount) base = round2(num(r.directAmount) * (isInterpretationKind(r) ? INTERP_FEE_RATE : 1));
  else if (isTranslationKind(r)) {
    // 번역 지급액 = 수량 × 단가 — 단위 종류(단어/글자/페이지/회/분/시간/일)와 무관(§단위확장). 사용자가 수량·단가 입력 시 적용.
    //   §14 호환: 기존 저장행은 계약단가(contractUnitPrice)가 없어(판매단가 자동복사 안 함) 이 분기를 타지 않고,
    //   기존 작업량(단어/글자 스냅샷)/기본수행료를 그대로 유지 → 값 불변. (unit은 라벨/기록용, 계산에 사용하지 않음)
    if (hasUnitPrice && hasQty) {
      base = round2(num(r.contractUnitPrice) * num(r.quantity));
    } else {
      const work = translationWorkAmount((r.serviceDetailSnapshot ?? {}) as any);
      base = (hasUnitPrice && work)
        ? round2(num(r.contractUnitPrice) * work.amount)
        : round2(num(r.baseFee));
    }
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

// ── 지급액 세전/세후 + 수익률(§지급액분리·§수익률) ────────────────────────────────
// 소수 1자리 반올림(수익률 표시용).
export const round1 = (n: number) => Math.round(n * 10) / 10;

// 원천세율(%) — 세금처리(withholdingTreatment) SSOT. 세전 지급액에 적용할 세율.
//   3.3%/2.2%/원천징수 예외(0)/세금계산서(0). 미선택은 0으로 간주(임의 3.3% 강제 안 함 §2).
//   effectiveTreatment 재사용 — 외주업체 미설정 시 세금계산서(0) 기본.
export function withholdingRatePct(r: { withholdingTreatment?: string | null; performerCategory?: string | null }): number {
  switch (normalizeTreatment(effectiveTreatment(r))) {
    case 'domestic_3_3': return 3.3;
    case 'domestic_2_2': return 2.2;
    default: return 0;   // exempt·세금계산서·미선택 — 원천세 0(미공제)
  }
}
// 지급액(세후) — 세전 × (1 − 세율/100). 세율 0(미선택·예외·세금계산서)이면 세전과 동일.
export function afterTaxPayout(before: number, r: { withholdingTreatment?: string | null; performerCategory?: string | null }): number {
  return round2(before * (1 - withholdingRatePct(r) / 100));
}

// 수행행 수익률(%) — 판매 공급가액 대비 세전 수행원가 마진율(§수익률). 세후 사용 금지(§6, 세전만).
//   saleSupply: 판매상품 공급가액(구조화 SSOT). sumCostBefore: 같은 판매상품에 연결된 수행행들의 세전 지급액 합계(§8).
//   반환 null = 계산불가(공급가액 NULL/0 — 0으로 나누지 않음 §10). 음수 허용(§12).
export function profitRatePct(saleSupply: number, sumCostBefore: number): number | null {
  if (!(saleSupply > 0)) return null;
  return round1((saleSupply - sumCostBefore) / saleSupply * 100);
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
