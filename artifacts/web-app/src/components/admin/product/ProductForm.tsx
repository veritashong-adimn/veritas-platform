import React from 'react';
import {
  PRODUCT_TYPES_META, MAIN_CATEGORIES_BY_TYPE, SUB_CATEGORIES_BY_MAIN,
  INTERPRETATION_DIRECTIONS,
} from '../../../lib/constants';
import { ClickSelect } from '../../ui';
import { LanguageSearchSelect, LangCustomInput, isLangCustom } from '../LanguageSearchSelect';
import { getZhExcludeCodes, normalizeZhForType } from '../../../lib/zhLangPolicy';
import {
  type ProductFormType,
  inputStyle, LANG_LABEL, TYPE_COLORS, EQUIP_UNIT_BY_MAIN,
  filterSubCats, isCustomItem, customItemPlaceholder, previewCode, autoName,
} from './productShared';

type DupeWarning = { existing: { id: number; code: string; name: string }[] } | null;

interface ProductFormProps {
  form: ProductFormType;
  setForm: React.Dispatch<React.SetStateAction<ProductFormType>>;
  isEdit: boolean;
  nameCustom: boolean;
  setNameCustom: React.Dispatch<React.SetStateAction<boolean>>;
  dupeWarning: DupeWarning;
  /** productType 변경 시 중복경고 초기화 등 후처리 (선택) */
  onTypeChanged?: () => void;
}

/**
 * 상품 등록/수정/등록요청 폼 (제어형). 기존 renderProductForm() 을 그대로 컴포넌트화.
 * 데이터/API 로직은 부모(페이지)가 담당하고, 이 컴포넌트는 폼 입력만 담당한다.
 */
export function ProductForm({ form, setForm, isEdit, nameCustom, setNameCustom, dupeWarning, onTypeChanged }: ProductFormProps) {
  // ─── productType 변경 시 연관 필드 초기화 ───────────────────────────────
  function handleProductTypeChange(newType: string) {
    const hasLang  = PRODUCT_TYPES_META[newType]?.hasLanguage ?? false;
    const langOpt  = PRODUCT_TYPES_META[newType]?.languageOptional ?? false;
    const isEquip  = newType === "equipment";
    const mainCats = MAIN_CATEGORIES_BY_TYPE[newType] ?? [];
    const defMain  = mainCats[0]?.label ?? "";
    setForm(prev => {
      const rawSrc = (hasLang && !langOpt) ? (prev.sourceLanguage || "ko") : "";
      const rawTgt = (hasLang && !langOpt) ? (prev.targetLanguage || "en") : "";
      const updated = {
        ...prev,
        productType: newType,
        mainCategory: defMain,
        subCategory: "",
        customItemName: "",
        sourceLanguage: (hasLang && !langOpt) ? normalizeZhForType(rawSrc, newType) : "",
        targetLanguage: (hasLang && !langOpt) ? normalizeZhForType(rawTgt, newType) : "",
        equipmentItem: isEquip ? prev.equipmentItem : "",
        equipmentItemCustom: isEquip ? prev.equipmentItemCustom : "",
        quantityUnit: isEquip ? (EQUIP_UNIT_BY_MAIN[defMain] ?? "개") : "",
        usagePeriod: isEquip ? "1일" : "",
        usagePeriodCustom: "",
        interpretationDirection: (newType === "interpretation" || newType === "combined") ? "양방향" : "",
      };
      if (!nameCustom) updated.name = autoName(updated);
      return updated;
    });
    onTypeChanged?.();
  }

  const typeInfo  = PRODUCT_TYPES_META[form.productType];
  const hasLang   = typeInfo?.hasLanguage ?? false;
  const langOpt   = typeInfo?.languageOptional ?? false;
  const mainCats  = MAIN_CATEGORIES_BY_TYPE[form.productType] ?? [];
  const rawSubCats = SUB_CATEGORIES_BY_MAIN[form.mainCategory] ?? [];
  const subCats   = form.productType === "operations"
    ? rawSubCats
    : filterSubCats(rawSubCats, form.mainCategory);
  const isInterp  = form.productType === "interpretation" || form.productType === "combined";
  const codePrev = previewCode(form.productType, form.mainCategory);
  const interpSrcLabel = form.sourceLanguage === "custom"
    ? (form.sourceLanguageCustom || "기타")
    : (form.sourceLanguage ? (LANG_LABEL[form.sourceLanguage] ?? form.sourceLanguage) : "");
  const interpTgtLabel = form.targetLanguage === "custom"
    ? (form.targetLanguageCustom || "기타")
    : (form.targetLanguage ? (LANG_LABEL[form.targetLanguage] ?? form.targetLanguage) : "");

  const zhExcludeCodes = getZhExcludeCodes(form.productType);

  return (
    <>
      {/* 상품유형 선택 */}
      {!isEdit && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 6, fontWeight: 600 }}>
            상품유형 <span style={{ color: "#dc2626" }}>*</span>
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(PRODUCT_TYPES_META).map(([k, v]) => {
              const tc = TYPE_COLORS[k] ?? { bg: "#f9fafb", color: "#374151", icon: "📦" };
              return (
                <button key={k} type="button"
                  onClick={() => handleProductTypeChange(k)}
                  style={{
                    padding: "6px 12px", fontSize: 12, borderRadius: 8, cursor: "pointer", fontWeight: 700,
                    border: `2px solid ${form.productType === k ? tc.color : "#e5e7eb"}`,
                    background: form.productType === k ? tc.bg : "#f9fafb",
                    color: form.productType === k ? tc.color : "#9ca3af",
                  }}>
                  {tc.icon} {v.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 언어 선택 (언어형 상품만) */}
      {!isEdit && hasLang && (
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "12px 16px", marginBottom: 12 }}>
          <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#1d4ed8" }}>
            언어 설정{langOpt ? <span style={{ fontWeight: 400, color: "#6b7280", marginLeft: 4 }}>(선택)</span> : null}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>
                {isInterp ? "언어 A" : (langOpt ? "원본 언어" : "출발언어")}
                {!langOpt && <span style={{ color: "#dc2626" }}> *</span>}
              </label>
              <LanguageSearchSelect
                value={form.sourceLanguage}
                onChange={v => {
                  setForm(p => {
                    const updated = { ...p, sourceLanguage: v, sourceLanguageCustom: "" };
                    if (!nameCustom) updated.name = autoName(updated);
                    return updated;
                  });
                }}
                mode="code"
                placeholder={isInterp ? "언어 A 선택..." : (langOpt ? "선택 안 함 가능" : "출발언어 선택...")}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                excludeCodes={zhExcludeCodes}
                allowEmpty={langOpt}
              />
              {isLangCustom(form.sourceLanguage, "code") && (
                <LangCustomInput
                  value={form.sourceLanguageCustom}
                  onChange={v => setForm(p => ({ ...p, sourceLanguageCustom: v }))}
                  label={isInterp ? "직접 입력 언어 A" : "직접 입력 출발언어"}
                />
              )}
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>
                {isInterp ? "언어 B" : (langOpt ? "출력 언어" : "도착언어")}
                {!langOpt && <span style={{ color: "#dc2626" }}> *</span>}
              </label>
              <LanguageSearchSelect
                value={form.targetLanguage}
                onChange={v => {
                  setForm(p => {
                    const updated = { ...p, targetLanguage: v, targetLanguageCustom: "" };
                    if (!nameCustom) updated.name = autoName(updated);
                    return updated;
                  });
                }}
                mode="code"
                placeholder={isInterp ? "언어 B 선택..." : (langOpt ? "선택 안 함 가능" : "도착언어 선택...")}
                triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                excludeCodes={zhExcludeCodes}
                allowEmpty={langOpt}
              />
              {isLangCustom(form.targetLanguage, "code") && (
                <LangCustomInput
                  value={form.targetLanguageCustom}
                  onChange={v => setForm(p => ({ ...p, targetLanguageCustom: v }))}
                  label={isInterp ? "직접 입력 언어 B" : "직접 입력 도착언어"}
                />
              )}
            </div>
          </div>
          {isInterp && (
            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 12, color: "#1d4ed8", display: "block", marginBottom: 4, fontWeight: 600 }}>통역방향</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {INTERPRETATION_DIRECTIONS.map(dir => (
                  <button key={dir} type="button" data-testid={`interp-dir-${dir}`}
                    onClick={() => setForm(prev => {
                      const updated = { ...prev, interpretationDirection: dir };
                      if (!nameCustom) updated.name = autoName(updated);
                      return updated;
                    })}
                    style={{ padding: "4px 14px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                      border: `1px solid ${form.interpretationDirection === dir ? "#1d4ed8" : "#bfdbfe"}`,
                      background: form.interpretationDirection === dir ? "#dbeafe" : "#f0f7ff",
                      color: form.interpretationDirection === dir ? "#1d4ed8" : "#6b7280",
                      fontWeight: form.interpretationDirection === dir ? 700 : 400 }}>
                    {dir === "양방향"
                      ? "↔ 양방향"
                      : interpSrcLabel && interpTgtLabel
                        ? dir === "A→B"
                          ? `${interpSrcLabel} → ${interpTgtLabel}`
                          : `${interpTgtLabel} → ${interpSrcLabel}`
                        : dir === "A→B" ? "언어 선택 필요" : "언어 선택 필요"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 대분류 / 중분류 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>
            대분류
            <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 400, marginLeft: 5 }}>
              ({!isEdit ? "선택사항 · 상품유형에 따라 자동 변경" : "선택사항"})
            </span>
          </label>
          <ClickSelect
            value={form.mainCategory}
            onChange={v => {
              setForm(p => {
                const updated = { ...p, mainCategory: v, subCategory: "", customItemName: "" };
                if (p.productType === "equipment") {
                  updated.quantityUnit = EQUIP_UNIT_BY_MAIN[v] ?? p.quantityUnit;
                }
                if (!nameCustom) updated.name = autoName(updated);
                return updated;
              });
            }}
            options={[{ value: "", label: "선택" }, ...mainCats.map(c => ({ value: c.label, label: c.label }))]}
            style={{ width: "100%" }}
            triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>
            중분류
            {subCats.length === 0 && <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>(해당 없음)</span>}
          </label>
          <ClickSelect
            value={form.subCategory}
            onChange={v => {
              setForm(p => {
                const updated = { ...p, subCategory: v, customItemName: "" };
                if (!nameCustom) updated.name = autoName(updated);
                return updated;
              });
            }}
            style={{ width: "100%", opacity: subCats.length === 0 ? 0.4 : 1, pointerEvents: subCats.length === 0 ? "none" : undefined }}
            triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
            options={[{ value: "", label: "선택" }, ...subCats.map(s => ({
              value: s.label,
              label: s.description ? `${s.label} (${s.description})` : s.label,
            }))]}
          />
        </div>
      </div>

      {/* 기타 직접 입력 (신규 등록만, equipment 제외) */}
      {!isEdit && form.productType !== "equipment" &&
        (isCustomItem(form.mainCategory) || isCustomItem(form.subCategory)) && (
        <div style={{ background: "#fefce8", border: "1px solid #fde047", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: "#92400e", display: "block", marginBottom: 6 }}>
            기타 내용 입력 <span style={{ color: "#dc2626" }}>*</span>
          </label>
          <input
            value={form.customItemName}
            onChange={e => {
              const val = e.target.value;
              setForm(p => {
                const updated = { ...p, customItemName: val };
                if (!nameCustom) updated.name = autoName(updated);
                return updated;
              });
            }}
            placeholder={customItemPlaceholder(form.mainCategory, form.subCategory)}
            style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
            aria-label="기타 항목 직접 입력"
          />
        </div>
      )}

      {/* 코드 미리보기 (신규 등록만) */}
      {!isEdit && (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "8px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, color: "#6b7280" }}>코드 미리보기:</span>
          <code style={{ fontSize: 13, fontWeight: 700, color: "#059669", background: "#dcfce7", padding: "2px 8px", borderRadius: 4 }}>
            {codePrev}
          </code>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>(### = 자동 번호)</span>
        </div>
      )}

      {/* 상품명 */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
          <label style={{ fontSize: 12, color: "#6b7280" }}>상품명 <span style={{ color: "#dc2626" }}>*</span></label>
          {!isEdit && (
            <button type="button"
              onClick={() => {
                if (nameCustom) {
                  setForm(p => ({ ...p, name: autoName(p) }));
                }
                setNameCustom(v => !v);
              }}
              style={{ fontSize: 11, color: nameCustom ? "#9ca3af" : "#2563eb", background: "none", border: "none", cursor: "pointer", padding: "0 2px", textDecoration: "underline" }}>
              {nameCustom ? "↩ 자동 생성으로" : "✏ 이름 직접 입력"}
            </button>
          )}
        </div>
        {!isEdit && !nameCustom ? (
          <div style={{ padding: "9px 12px", borderRadius: 8, background: "#f3f4f6", border: "1px solid #e5e7eb", fontSize: 13, color: "#111827", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>자동</span>
            {autoName(form)}
          </div>
        ) : (
          <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            placeholder="예: 한영 법률번역" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
        )}
      </div>

      {/* 중복 경고 */}
      {dupeWarning && (
        <div style={{ marginTop: 10, background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px" }}>
          <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, color: "#92400e" }}>⚠ 동일한 상품이 이미 존재합니다</p>
          {dupeWarning.existing.map(ex => (
            <p key={ex.id} style={{ margin: "2px 0", fontSize: 12, color: "#92400e" }}>
              기존 상품: <code style={{ background: "#fde68a", padding: "1px 5px", borderRadius: 3 }}>{ex.code}</code> — {ex.name}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
