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

// 기타 서비스 세부 선택지(복수 선택). '직접 입력'은 화면에서 자유 입력란으로 처리.
export const OTHER_SERVICE_PRESETS = ["감수", "편집", "공증"] as const;

// 서비스 유형 목록 — 신규 복수 선택(serviceTypes) 우선, 없으면 기존 단일 serviceType 1개(과거 데이터 호환).
export function inquiryServiceTypes(d: { serviceType?: string | null; serviceTypes?: string[] | null }): string[] {
  if (Array.isArray(d.serviceTypes) && d.serviceTypes.length) return d.serviceTypes;
  return d.serviceType ? [d.serviceType] : [];
}
// 표시 문자열 — 예: "통역 · 장비 · 감수 · 공증"(기타 세부 서비스가 있으면 '기타' 대신 세부 항목 표시).
export function inquiryServiceLabel(d: { serviceType?: string | null; serviceTypes?: string[] | null; otherServices?: string[] | null }): string {
  const types = inquiryServiceTypes(d);
  const others = Array.isArray(d.otherServices) ? d.otherServices.filter(Boolean) : [];
  const parts = types.flatMap(t => (t === "other" && others.length ? others : [SERVICE_LABEL[t] ?? t]));
  return parts.join(" · ");
}

// 통역장비/장비 단독 — 복수 장비행. 견적 장비항목(constants EQUIPMENT_ITEMS/단위) 재사용.
export interface EquipmentRow {
  kind: string;      // 장비 종류 (EQUIPMENT_KINDS)
  quantity: string;  // 수량 (자유입력 숫자)
  unit: string;      // 단위 (EQUIPMENT_UNITS)
  location: string;  // 사용 장소
  note: string;      // 설치/운영·기타 요청사항
  days?: string;     // 대여일수(장비 수량과 별개). equipmentJson 에 함께 저장 — 기존 행(없음)도 그대로 호환
  // 원본 견적서(Veritas 발행 견적 등)의 단가·공급가액(숫자만) — 참고정보. 견적 화면에서 담당자가 [적용]할 때만 단가로 쓴다.
  refUnitPrice?: string;
  refAmount?: string;
}
export function emptyEquipmentRow(): EquipmentRow {
  return { kind: "", quantity: "1", unit: "세트", location: "", note: "", days: "" };
}
// 견적관리 장비 카탈로그/단위 재사용
export { EQUIPMENT_ITEMS as EQUIPMENT_KINDS, EQUIPMENT_QUANTITY_UNITS as EQUIPMENT_UNITS } from "./constants";
import { EQUIPMENT_ITEMS as _EQ_KINDS, EQUIPMENT_QUANTITY_UNITS as _EQ_UNITS } from "./constants";

/**
 * AI 장비 행 → 등록 화면 장비 행. 장비 종류·단위는 기존 선택 목록에 있는 값만 쓰고(목록 추가·임의 매칭 없음),
 * 목록에 없는 장비명·단위는 '기타 직접입력' + 비고에 원문 표기로 보존한다. 원문에 없는 수량·단위는 채우지 않는다.
 */
export function aiEquipmentToRow(r: { kind?: string; quantity?: string; unit?: string; location?: string; note?: string; sourceName?: string; days?: string; unitPrice?: string; amount?: string }): EquipmentRow {
  const norm = (v: string) => v.replace(/\s+/g, "").toLowerCase();
  const name = (r.sourceName || r.kind || "").trim();
  // 서버가 목록·동의어로 고른 장비 종류(목록에 있는 값만) — 없으면 원문 장비명이 목록과 같을 때만, 그 외 기타 직접입력
  const kind = (r.kind && _EQ_KINDS.includes(r.kind) ? r.kind : undefined)
    ?? _EQ_KINDS.find(k => k !== "기타 직접입력" && norm(k) === norm(name)) ?? (name ? "기타 직접입력" : "");
  const rawUnit = (r.unit || "").trim();
  const unitMap: Array<[RegExp, string]> = [[/^(?:set|sets|세트)$/i, "세트"], [/^(?:ea|개)$/i, "개"], [/^부스$/, "부스"], [/^건$/, "건"]];
  const unit = unitMap.find(([re]) => re.test(rawUnit))?.[1] ?? (( _EQ_UNITS as readonly string[]).includes(rawUnit) ? rawUnit : "");
  const notes = [
    // 원문 장비명이 선택된 종류와 다르면(기타 직접입력·동의어 매칭) 원문 표기를 남긴다
    name && norm(name) !== norm(kind) ? `원문 장비명: ${name}` : "",
    rawUnit && !unit ? `단위: ${rawUnit}` : "",
    (r.note || "").trim(),
  ].filter(Boolean);
  const digits = (v?: string) => (v || "").replace(/[^\d]/g, "");
  return {
    kind, quantity: (r.quantity || "").trim(), unit, location: (r.location || "").trim(), note: notes.join(" / "), days: (r.days || "").trim(),
    // 원본 단가·공급가액 — 분석 결과에 있을 때만 보존(없으면 키를 만들지 않음)
    ...(digits(r.unitPrice) ? { refUnitPrice: digits(r.unitPrice) } : {}),
    ...(digits(r.amount) ? { refAmount: digits(r.amount) } : {}),
  };
}

// 통역 형태 — 기존 VERITAS 통역 카테고리(constants.ts PRODUCT_MAIN_CATEGORIES 통역 서브셋) 재사용.
// 별도 enum을 만들지 않고 동일 라벨 문자열을 text로 저장한다.
export const INTERPRET_TYPES = [
  "동시통역", "순차통역", "위스퍼링통역", "수행통역", "VIP수행통역",
  "가이드통역", "미팅통역", "전시회통역", "화상통역", "전화통역", "기타통역",
] as const;

// 원문서 형태 (번역, 복수 선택) — 저장값은 "Word, HWP" 처럼 쉼표 구분 문자열(기존 단일값 "Word" 그대로 호환)
export const DOCUMENT_TYPES = ["Word", "HWP", "PDF", "Excel", "PPT", "이미지", "기타"] as const;
// 이전 항목명·흔한 표기 → 현재 항목
const DOCUMENT_TYPE_ALIASES: Array<[RegExp, string]> = [
  [/^(?:ms\s*)?word$|^docx?$|^워드$/i, "Word"],
  [/^hwpx?$|^한글$|^아래\s*한글$/i, "HWP"],
  [/^pdf$/i, "PDF"],
  [/^excel$|^xlsx?$|^엑셀$/i, "Excel"],
  [/^ppt$|^pptx$|^powerpoint$|^파워\s*포인트$/i, "PPT"],
];
/** 저장 문자열 → 선택 항목 배열. 목록에 없는 값도 지우지 않고 그대로 둔다(기존 데이터 보존). */
export function parseDocumentTypes(v: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(v ?? "").split(/\s*,\s*/).map(t => t.trim()).filter(Boolean)) {
    const t = DOCUMENT_TYPE_ALIASES.find(([re]) => re.test(raw))?.[1] ?? raw;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
/** 선택 항목 배열 → 저장 문자열(고정 항목 순서, 목록 밖 값은 뒤에). */
export function formatDocumentTypes(list: string[]): string {
  const known = DOCUMENT_TYPES.filter(t => list.includes(t));
  return [...known, ...list.filter(t => !(DOCUMENT_TYPES as readonly string[]).includes(t))].join(", ");
}

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
