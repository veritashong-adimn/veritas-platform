import React from 'react';
import {
  PRODUCT_TYPES_META, MAIN_CATEGORIES_BY_TYPE, LANGUAGE_CODES,
} from '../../../lib/constants';

// ─── 폼 타입 ────────────────────────────────────────────────────────────────
export type ProductFormType = {
  productType: string;
  sourceLanguage: string;
  sourceLanguageCustom: string;
  targetLanguage: string;
  targetLanguageCustom: string;
  equipmentItem: string;
  equipmentItemCustom: string;
  mainCategory: string;
  subCategory: string;
  customItemName: string;   // "기타" 계열 대/중분류 선택 시 직접 입력값
  name: string;
  unit: string;
  quantityUnit: string;
  usagePeriod: string;
  usagePeriodCustom: string;
  interpretationDirection: string;
  basePrice: string;
  description: string;
  interpretationDuration: string;
  overtimePrice: string;
  options: { optionType: string; optionValue: string }[];
};

export type ProductRequest = {
  id: number; productType: string;
  sourceLanguage: string | null; targetLanguage: string | null;
  mainCategory: string | null; subCategory: string | null;
  name: string; unit: string | null; description: string | null;
  requestedByEmail: string | null; status: "pending" | "approved" | "rejected";
  approvedProductId: number | null; rejectionReason: string | null; createdAt: string;
};

export const emptyProductForm: ProductFormType = {
  productType: "translation", sourceLanguage: "ko", sourceLanguageCustom: "", targetLanguage: "en", targetLanguageCustom: "",
  equipmentItem: "", equipmentItemCustom: "",
  mainCategory: "번역", subCategory: "", customItemName: "",
  name: "", unit: "페이지", quantityUnit: "개", usagePeriod: "1일", usagePeriodCustom: "", interpretationDirection: "양방향",
  basePrice: "", description: "",
  interpretationDuration: "", overtimePrice: "", options: [],
};

export const DEACTIVATION_REASONS = ["중복 상품 정리", "사용 중단", "코드 재정비", "기타"];

export const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};

// ─── 언어 코드 레이블 ────────────────────────────────────────────────────────
export const LANG_LABEL: Record<string, string> = Object.fromEntries(LANGUAGE_CODES.map(l => [l.code, l.label]));

// ─── 상품유형별 색상 ─────────────────────────────────────────────────────────
export const TYPE_COLORS: Record<string, { bg: string; color: string; icon: string }> = {
  translation:    { bg: "#eff6ff", color: "#2563eb", icon: "📄" },
  interpretation: { bg: "#f5f3ff", color: "#7c3aed", icon: "🎤" },
  combined:       { bg: "#eef2ff", color: "#4338ca", icon: "🌐" },
  proofreading:   { bg: "#f0fdf4", color: "#16a34a", icon: "✏️" },
  media:          { bg: "#fff1f2", color: "#be123c", icon: "🎬" },
  equipment:      { bg: "#fff7ed", color: "#c2410c", icon: "🔧" },
  editing:        { bg: "#fdf4ff", color: "#9333ea", icon: "🖨️" },
  operations:     { bg: "#f0fdfa", color: "#0f766e", icon: "🏃" },
  project:        { bg: "#f8fafc", color: "#334155", icon: "📋" },
};

// ─── 장비 대분류별 기본 수량단위 ─────────────────────────────────────────────
export const EQUIP_UNIT_BY_MAIN: Record<string, string> = {
  "동시통역장비": "대",
  "가이드장비":   "대",
  "위스퍼링장비": "대",
  "마이크장비":   "대",
  "음향장비":     "대",
  "부스장비":     "일",
  "운영장비":     "건",
  "기타장비":     "건",
};

/** 대분류와 동일한 label을 가진 중분류 옵션 제거 (표시 중복 방지) */
export function filterSubCats<T extends { label: string }>(cats: T[], mainCategoryLabel: string): T[] {
  if (!mainCategoryLabel) return cats;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
  const key = norm(mainCategoryLabel);
  return cats.filter(s => norm(s.label) !== key);
}

/** "기타" 계열 label 선택 시 직접 입력 활성화 여부 */
export function isCustomItem(label: string): boolean {
  return label.startsWith("기타");
}

/** "기타" 직접 입력 placeholder */
export function customItemPlaceholder(mainCat: string, subCat: string): string {
  const target = subCat || mainCat;
  if (target === "기타식대") return "예: 카페, 편의점, 간식비";
  if (target === "기타숙박") return "예: 에어비앤비, 펜션, 게스트하우스";
  if (target === "기타실비") return "예: 공증서류 발송비, 복사비, 소모품";
  return "예: 항목명 직접 입력";
}

// ─── 코드 미리보기 생성 ──────────────────────────────────────────────────────
export function previewCode(productType: string, mainCategory: string): string {
  const typeInfo = PRODUCT_TYPES_META[productType];
  if (!typeInfo) return "?";
  const mainCats = MAIN_CATEGORIES_BY_TYPE[productType] ?? [];
  const mainCode = mainCats.find(c => c.label === mainCategory)?.code ?? "GEN";
  return `${typeInfo.code}-${mainCode}-###`;
}

// ─── 자동 상품명 생성 ────────────────────────────────────────────────────────
export function autoName(f: ProductFormType): string {
  const typeLabel = PRODUCT_TYPES_META[f.productType]?.label ?? f.productType;
  const hasLang = PRODUCT_TYPES_META[f.productType]?.hasLanguage ?? false;
  const langOpt = PRODUCT_TYPES_META[f.productType]?.languageOptional ?? false;

  // 통역장비: 중분류 → 상품명, 없으면 대분류
  if (f.productType === "equipment") {
    const sub = f.subCategory?.trim();
    const main = f.mainCategory?.trim();
    return sub || main || "통역장비";
  }

  const srcLabel = hasLang && f.sourceLanguage
    ? (f.sourceLanguage === "custom" ? (f.sourceLanguageCustom || "기타") : (LANG_LABEL[f.sourceLanguage] ?? f.sourceLanguage))
    : "";
  const tgtLabel = hasLang && f.targetLanguage
    ? (f.targetLanguage === "custom" ? (f.targetLanguageCustom || "기타") : (LANG_LABEL[f.targetLanguage] ?? f.targetLanguage))
    : "";
  const mainLabel = f.mainCategory;
  const subLabel = f.subCategory;

  // 미디어: 언어 유무에 따라 3가지 패턴
  if (langOpt) {
    const svcLabel = subLabel?.trim() || mainLabel?.trim() || typeLabel;
    if (srcLabel && tgtLabel) return `${srcLabel}-${tgtLabel} ${svcLabel}`;
    if (srcLabel) return `${srcLabel} ${svcLabel}`;
    if (tgtLabel) return `${tgtLabel} ${svcLabel}`;
    return svcLabel;
  }

  const isInterpType = f.productType === "interpretation" || f.productType === "combined";
  if (hasLang && srcLabel && tgtLabel) {
    // 비통역(번역/감수 등): 하이픈(-) 구분자. 통역/통번역: 방향 표시 유지 (→ / ↔)
    let sep = isInterpType ? "→" : "-";
    let aLabel = srcLabel;
    let bLabel = tgtLabel;
    if (isInterpType) {
      const dir = f.interpretationDirection || "양방향";
      if (dir === "양방향") { sep = "↔"; }
      else if (dir === "B→A") { aLabel = tgtLabel; bLabel = srcLabel; sep = "→"; }
    }
    return subLabel
      ? `${aLabel}${sep}${bLabel} ${subLabel}`
      : (mainLabel ? `${aLabel}${sep}${bLabel} ${mainLabel}` : `${aLabel}${sep}${bLabel} ${typeLabel}`);
  }
  // 비언어형 기타 선택 시 직접 입력값을 상품명으로 사용 (equipment 제외)
  if (f.productType !== "equipment" && (isCustomItem(subLabel ?? "") || isCustomItem(mainLabel ?? ""))) {
    return f.customItemName?.trim() || subLabel || mainLabel || typeLabel;
  }
  return mainLabel ? `${mainLabel}` : typeLabel;
}

// ─── 선택 카드 공통 스타일 ───────────────────────────────────────────────────
// 선택 시 카드 크기/위치가 흔들리지 않도록 테두리 폭은 1px 고정, 색상만 변경.
// (Card 기본 테두리도 1px 이므로 미선택↔선택 간 레이아웃 이동 없음)
export function selectedCardStyle(selected: boolean): React.CSSProperties {
  return selected
    ? { border: "1px solid #bfdbfe", background: "#eff6ff" } // 옅은 파란 테두리 + 매우 옅은 파란 배경
    : {};
}

// ─── 일괄 관리 버튼 공통 스타일 ──────────────────────────────────────────────
// 비활성 시에도 명칭·형태가 식별되도록 opacity 대신 neutral 색상값으로 표현.
export function bulkBtnStyle(
  enabled: boolean, color: string, bg: string, border: string, extra?: React.CSSProperties,
): React.CSSProperties {
  return {
    fontSize: 12, borderRadius: 7, fontWeight: 700,
    cursor: enabled ? "pointer" : "not-allowed",
    border: `1px solid ${enabled ? border : "#d1d5db"}`,
    background: enabled ? bg : "#f3f4f6",
    color: enabled ? color : "#9ca3af",
    ...extra,
  };
}

// ─── 페이지네이션 이전/다음 버튼 공통 스타일 ─────────────────────────────────
export function pageNavBtnStyle(enabled: boolean): React.CSSProperties {
  return {
    fontSize: 12, padding: "6px 12px", borderRadius: 7, fontWeight: 600,
    cursor: enabled ? "pointer" : "not-allowed",
    border: `1px solid ${enabled ? "#e5e7eb" : "#d1d5db"}`,
    background: enabled ? "#fff" : "#f3f4f6",
    color: enabled ? "#374151" : "#9ca3af",
  };
}

// ─── 섹션 래퍼 ───────────────────────────────────────────────────────────────
export function Section({ title, sub, children, action }: {
  title: string; sub?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: sub ? 4 : 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
        {action}
      </div>
      {sub && <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280" }}>{sub}</p>}
      {children}
    </div>
  );
}
