/**
 * inquiryMeta — 의뢰건 접수 공통 라벨/옵션 (프론트 표시용)
 * 서버 값(코드)과 표시 라벨을 한 곳에서 관리한다.
 */

// 접수 경로
export const INQUIRY_CHANNELS = [
  { value: "phone", label: "전화" },
  { value: "email", label: "이메일" },
  { value: "homepage", label: "홈페이지" },
  { value: "kakao", label: "카카오" },
  { value: "other", label: "기타" },
] as const;
export const CHANNEL_LABEL: Record<string, string> = Object.fromEntries(INQUIRY_CHANNELS.map(c => [c.value, c.label]));

// 서비스 유형 (견적 quote_items.itemType 과 동일 체계 재사용)
//  · 「실비(expense)」는 통역·장비의 부대비용(교통/숙박/항공)이므로 의뢰 접수 유형에서는 제외.
//    → 견적/판매의 실비 처리는 별개(변경하지 않음). serviceType 은 text 컬럼이라 enum 마이그레이션 불필요.
//  · 드롭다운은 통역/번역/장비/기타 4종만 노출.
export const INQUIRY_SERVICE_TYPES = [
  { value: "interpretation", label: "통역" },
  { value: "translation", label: "번역" },
  { value: "equipment", label: "장비" },
  { value: "other", label: "기타" },
] as const;
// 표시 라벨 맵 — 과거 데이터(expense 등) 호환을 위해 구 값도 유지.
export const SERVICE_LABEL: Record<string, string> = {
  interpretation: "통역",
  translation: "번역",
  equipment: "장비",
  other: "기타",
  expense: "실비", // legacy 데이터 표시용 (신규 접수에서는 선택 불가)
};

// 통역장비/장비 단독 — 복수 장비행. 견적 장비항목(constants EQUIPMENT_ITEMS/단위) 재사용.
export interface EquipmentRow {
  kind: string;      // 장비 종류 (EQUIPMENT_KINDS)
  quantity: string;  // 수량 (자유입력 숫자)
  unit: string;      // 단위 (EQUIPMENT_UNITS)
  location: string;  // 사용 장소
  note: string;      // 설치/운영·기타 요청사항
}
export function emptyEquipmentRow(): EquipmentRow {
  return { kind: "", quantity: "1", unit: "세트", location: "", note: "" };
}
// 견적관리 장비 카탈로그/단위 재사용
export { EQUIPMENT_ITEMS as EQUIPMENT_KINDS, EQUIPMENT_QUANTITY_UNITS as EQUIPMENT_UNITS } from "./constants";

// 통역 형태 — 기존 VERITAS 통역 카테고리(constants.ts PRODUCT_MAIN_CATEGORIES 통역 서브셋) 재사용.
// 별도 enum을 만들지 않고 동일 라벨 문자열을 text로 저장한다.
export const INTERPRET_TYPES = [
  "동시통역", "순차통역", "위스퍼링통역", "수행통역", "VIP수행통역",
  "가이드통역", "미팅통역", "전시회통역", "화상통역", "전화통역", "기타통역",
] as const;

// 원문서 형태 (번역)
export const DOCUMENT_TYPES = ["Word", "Excel", "PowerPoint", "PDF", "한글", "이미지", "기타"] as const;

// 처리상태 (서버 파생 processingStatus)
export const PROCESSING_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  new:             { label: "신규접수",     color: "#b45309", bg: "#fffbeb", border: "#fde68a" },
  reviewing:       { label: "확인중",       color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
  quoting:         { label: "견적작성중",   color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  quote_sent:      { label: "견적발송",     color: "#059669", bg: "#ecfdf5", border: "#a7f3d0" },
  closed_no_quote: { label: "견적없이 종결", color: "#6b7280", bg: "#f3f4f6", border: "#e5e7eb" },
};

// 견적 진행상태 (서버 파생 quoteProgress)
export const QUOTE_PROGRESS_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  none:            { label: "미견적",       color: "#9ca3af", bg: "#f9fafb", border: "#e5e7eb" },
  drafting:        { label: "견적작성중",   color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  sent:            { label: "견적발송",     color: "#059669", bg: "#ecfdf5", border: "#a7f3d0" },
  closed_no_quote: { label: "견적없이 종결", color: "#6b7280", bg: "#f3f4f6", border: "#e5e7eb" },
};

// 견적 없이 종결 사유 (서버 CLOSE_CODES 와 동기화)
export const INQUIRY_CLOSE_REASONS = [
  { value: "customer_cancel",   label: "고객 취소" },
  { value: "schedule_mismatch", label: "일정/조건 불일치" },
  { value: "no_resource",       label: "인력 섭외 불가" },
  { value: "out_of_scope",      label: "서비스 제공 범위 외" },
  { value: "budget_mismatch",   label: "예산 불일치" },
  { value: "simple_inquiry",    label: "단순 문의" },
  { value: "duplicate",         label: "중복 접수" },
  { value: "competitor",        label: "타 업체 진행" },
  { value: "other",             label: "기타" },
] as const;
export const CLOSE_REASON_LABEL: Record<string, string> = Object.fromEntries(INQUIRY_CLOSE_REASONS.map(r => [r.value, r.label]));

/** KST 기준 오늘 날짜 문자열 (YYYY-MM-DD) — 일자 선택 기본값 */
export function kstTodayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}
