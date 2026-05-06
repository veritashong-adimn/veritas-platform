import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  api, Product, ProductOption,
  PRODUCT_TYPES_META, MAIN_CATEGORIES_BY_TYPE, SUB_CATEGORIES_BY_MAIN,
  LANGUAGE_CODES, UNITS_BY_PRODUCT_TYPE, PRODUCT_OPTION_TYPES,
} from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';
import { LanguageSearchSelect, LangCustomInput, isLangCustom } from './LanguageSearchSelect';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};

function Section({ title, sub, children, action }: {
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

// ─── 언어 코드 레이블 ────────────────────────────────────────────────────────
const LANG_LABEL: Record<string, string> = Object.fromEntries(LANGUAGE_CODES.map(l => [l.code, l.label]));

// ─── 상품유형별 색상 ─────────────────────────────────────────────────────────
const TYPE_COLORS: Record<string, { bg: string; color: string; icon: string }> = {
  translation:    { bg: "#eff6ff", color: "#2563eb", icon: "📄" },
  interpretation: { bg: "#f5f3ff", color: "#7c3aed", icon: "🎤" },
  combined:       { bg: "#fdf4ff", color: "#9333ea", icon: "🔗" },
  equipment:      { bg: "#fff7ed", color: "#c2410c", icon: "🎧" },
  project:        { bg: "#f0fdf4", color: "#059669", icon: "📋" },
  transport:      { bg: "#fefce8", color: "#d97706", icon: "🚗" },
  meal:           { bg: "#fff1f2", color: "#e11d48", icon: "🍱" },
  accommodation:  { bg: "#f0f9ff", color: "#0369a1", icon: "🏨" },
  other_cost:     { bg: "#f9fafb", color: "#6b7280", icon: "💼" },
};

// ─── 코드 미리보기 생성 ──────────────────────────────────────────────────────
function previewCode(
  productType: string,
  sourceLanguage: string,
  targetLanguage: string,
  mainCategory: string,
  subCategory: string,
): string {
  const typeInfo = PRODUCT_TYPES_META[productType];
  if (!typeInfo) return "?";
  const typeCode = typeInfo.code;
  const hasLang = typeInfo.hasLanguage;

  const mainCats = MAIN_CATEGORIES_BY_TYPE[productType] ?? [];
  const mainCode = mainCats.find(c => c.label === mainCategory)?.code ?? "GEN";
  const subCats = SUB_CATEGORIES_BY_MAIN[mainCategory] ?? [];
  const subCode = subCategory ? (subCats.find(c => c.label === subCategory)?.code ?? "") : "";
  const catCode = subCode || mainCode;

  if (hasLang && sourceLanguage && targetLanguage) {
    const srcCode = sourceLanguage === "custom" ? "ETC" : sourceLanguage.toUpperCase();
    const tgtCode = targetLanguage === "custom" ? "ETC" : targetLanguage.toUpperCase();
    return `${typeCode}-${srcCode}-${tgtCode}-${catCode}-###`;
  }
  return `${typeCode}-${catCode}-###`;
}

// ─── 폼 타입 ────────────────────────────────────────────────────────────────
type ProductFormType = {
  productType: string;
  sourceLanguage: string;
  sourceLanguageCustom: string;
  targetLanguage: string;
  targetLanguageCustom: string;
  mainCategory: string;
  subCategory: string;
  name: string;
  unit: string;
  basePrice: string;
  description: string;
  interpretationDuration: string;
  overtimePrice: string;
  options: { optionType: string; optionValue: string }[];
};

type ProductRequest = {
  id: number; productType: string;
  sourceLanguage: string | null; targetLanguage: string | null;
  mainCategory: string | null; subCategory: string | null;
  name: string; unit: string | null; description: string | null;
  requestedByEmail: string | null; status: "pending" | "approved" | "rejected";
  approvedProductId: number | null; rejectionReason: string | null; createdAt: string;
};

const emptyProductForm: ProductFormType = {
  productType: "translation", sourceLanguage: "ko", sourceLanguageCustom: "", targetLanguage: "en", targetLanguageCustom: "",
  mainCategory: "일반번역", subCategory: "",
  name: "", unit: "어절", basePrice: "", description: "",
  interpretationDuration: "", overtimePrice: "", options: [],
};

const DEACTIVATION_REASONS = ["중복 상품 정리", "사용 중단", "코드 재정비", "기타"];

interface Props {
  token: string;
  user: { role: string } | null;
  hasPerm: (perm: string) => boolean;
  setToast: (msg: string) => void;
  authHeaders: Record<string, string>;
}

export function ProductManagementTab({ token, user, hasPerm, setToast, authHeaders }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [showProductForm, setShowProductForm] = useState(false);
  const [productForm, setProductForm] = useState<ProductFormType>(emptyProductForm);
  const [editingProduct, setEditingProduct] = useState<number | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [productImporting, setProductImporting] = useState(false);
  const [productImportResult, setProductImportResult] = useState<{
    created: number; skipped: number; errors: { row: number; message: string }[];
  } | null>(null);
  const productImportRef = useRef<HTMLInputElement>(null);
  const [productRequests, setProductRequests] = useState<ProductRequest[]>([]);
  const [productRequestsLoading, setProductRequestsLoading] = useState(false);
  const [productRequestStatusFilter, setProductRequestStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">("all");
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestForm, setRequestForm] = useState<ProductFormType>({ ...emptyProductForm });
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [rejectingRequestId, setRejectingRequestId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // 필터
  const [filterProductType, setFilterProductType] = useState("");
  const [filterSourceLang, setFilterSourceLang] = useState("");
  const [filterSourceLangCustom, setFilterSourceLangCustom] = useState("");
  const [filterTargetLang, setFilterTargetLang] = useState("");
  const [filterTargetLangCustom, setFilterTargetLangCustom] = useState("");
  const [filterMainCategory, setFilterMainCategory] = useState("");
  const [filterActiveOnly, setFilterActiveOnly] = useState<"" | "true" | "false">("");

  // 기타 상태
  const [deactivatingProductId, setDeactivatingProductId] = useState<number | null>(null);
  const [deactivationReason, setDeactivationReason] = useState("");
  const [productDupeWarning, setProductDupeWarning] = useState<{ existing: { id: number; code: string; name: string }[] } | null>(null);
  const [productNameCustom, setProductNameCustom] = useState(false);

  // ─── 자동 상품명 생성 ────────────────────────────────────────────────────
  function autoName(f: ProductFormType): string {
    const typeLabel = PRODUCT_TYPES_META[f.productType]?.label ?? f.productType;
    const hasLang = PRODUCT_TYPES_META[f.productType]?.hasLanguage ?? false;
    const srcLabel = hasLang && f.sourceLanguage
      ? (f.sourceLanguage === "custom" ? (f.sourceLanguageCustom || "기타") : (LANG_LABEL[f.sourceLanguage] ?? f.sourceLanguage))
      : "";
    const tgtLabel = hasLang && f.targetLanguage
      ? (f.targetLanguage === "custom" ? (f.targetLanguageCustom || "기타") : (LANG_LABEL[f.targetLanguage] ?? f.targetLanguage))
      : "";
    const mainLabel = f.mainCategory;
    const subLabel = f.subCategory;
    if (hasLang && srcLabel && tgtLabel) {
      return subLabel
        ? `${srcLabel}→${tgtLabel} ${subLabel} ${typeLabel}`
        : (mainLabel ? `${srcLabel}→${tgtLabel} ${mainLabel}` : `${srcLabel}→${tgtLabel} ${typeLabel}`);
    }
    return mainLabel ? `${mainLabel}` : typeLabel;
  }

  // ─── productType 변경 시 연관 필드 초기화 ───────────────────────────────
  function handleProductTypeChange(newType: string, setter: React.Dispatch<React.SetStateAction<ProductFormType>>) {
    const hasLang = PRODUCT_TYPES_META[newType]?.hasLanguage ?? false;
    const mainCats = MAIN_CATEGORIES_BY_TYPE[newType] ?? [];
    const defMain = mainCats[0]?.label ?? "";
    const defUnit = (UNITS_BY_PRODUCT_TYPE[newType] ?? ["건"])[0];
    setter(prev => {
      const updated = {
        ...prev,
        productType: newType,
        mainCategory: defMain,
        subCategory: "",
        unit: defUnit,
        sourceLanguage: hasLang ? (prev.sourceLanguage || "ko") : "",
        targetLanguage: hasLang ? (prev.targetLanguage || "en") : "",
      };
      if (!productNameCustom) updated.name = autoName(updated);
      return updated;
    });
    setProductDupeWarning(null);
  }

  // ─── 데이터 fetching ─────────────────────────────────────────────────────
  const fetchProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const params = new URLSearchParams();
      if (productSearch.trim()) params.set("search", productSearch.trim());
      if (filterProductType) params.set("productType", filterProductType);
      // custom 언어: 실제 입력값을 그대로 API에 전달 (저장 시 실제 텍스트로 변환되어 있음)
      const effectiveSrcLang = filterSourceLang === "custom"
        ? filterSourceLangCustom.trim()
        : filterSourceLang;
      const effectiveTgtLang = filterTargetLang === "custom"
        ? filterTargetLangCustom.trim()
        : filterTargetLang;
      if (effectiveSrcLang) params.set("sourceLanguage", effectiveSrcLang);
      if (effectiveTgtLang) params.set("targetLanguage", effectiveTgtLang);
      if (filterMainCategory) params.set("mainCategory", filterMainCategory);
      if (filterActiveOnly) params.set("activeOnly", filterActiveOnly);
      const res = await fetch(api(`/api/admin/products${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setProducts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 상품 조회 실패"); }
    finally { setProductsLoading(false); }
  }, [token, productSearch, filterProductType, filterSourceLang, filterSourceLangCustom, filterTargetLang, filterTargetLangCustom, filterMainCategory, filterActiveOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchProductRequests = useCallback(async () => {
    setProductRequestsLoading(true);
    try {
      const params = new URLSearchParams();
      if (productRequestStatusFilter !== "all") params.set("status", productRequestStatusFilter);
      const res = await fetch(api(`/api/admin/product-requests?${params}`), { headers: authHeaders });
      if (res.ok) setProductRequests(await res.json());
    } catch { /* ignore */ }
    finally { setProductRequestsLoading(false); }
  }, [token, productRequestStatusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchProducts();
    fetchProductRequests();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchProductRequests(); }, [productRequestStatusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 상품 저장 ──────────────────────────────────────────────────────────
  const handleSaveProduct = async () => {
    const effectiveName = productNameCustom ? productForm.name.trim() : autoName(productForm);
    if (!effectiveName || !productForm.basePrice) {
      setToast("상품명과 기본단가는 필수입니다."); return;
    }
    if (!editingProduct && !productForm.mainCategory) {
      setToast("대분류는 필수입니다."); return;
    }
    const hasLang = PRODUCT_TYPES_META[productForm.productType]?.hasLanguage ?? false;
    if (!editingProduct && hasLang && (!productForm.sourceLanguage || !productForm.targetLanguage)) {
      setToast("출발언어와 도착언어는 필수입니다."); return;
    }
    if (!editingProduct && hasLang && productForm.sourceLanguage === "custom" && !productForm.sourceLanguageCustom.trim()) {
      setToast("출발언어 직접 입력을 입력해 주세요."); return;
    }
    if (!editingProduct && hasLang && productForm.targetLanguage === "custom" && !productForm.targetLanguageCustom.trim()) {
      setToast("도착언어 직접 입력을 입력해 주세요."); return;
    }

    // "custom" 선택 시 실제 입력값으로 대체해서 저장
    const resolveLanguage = (code: string, custom: string) =>
      code === "custom" ? (custom.trim() || "custom") : code;

    setSavingProduct(true);
    try {
      const payload = editingProduct
        ? {
          name: effectiveName,
          mainCategory: productForm.mainCategory || null,
          subCategory: productForm.subCategory || null,
          unit: productForm.unit,
          basePrice: Number(productForm.basePrice),
          description: productForm.description || null,
          interpretationDuration: productForm.interpretationDuration.trim() || null,
          overtimePrice: productForm.overtimePrice ? Number(productForm.overtimePrice) : null,
          options: productForm.options.filter(o => o.optionType.trim() && o.optionValue.trim()),
        }
        : {
          productType: productForm.productType,
          sourceLanguage: hasLang ? resolveLanguage(productForm.sourceLanguage, productForm.sourceLanguageCustom) : null,
          targetLanguage: hasLang ? resolveLanguage(productForm.targetLanguage, productForm.targetLanguageCustom) : null,
          mainCategory: productForm.mainCategory,
          subCategory: productForm.subCategory || null,
          name: effectiveName,
          unit: productForm.unit,
          basePrice: Number(productForm.basePrice),
          description: productForm.description || null,
          interpretationDuration: productForm.interpretationDuration.trim() || null,
          overtimePrice: productForm.overtimePrice ? Number(productForm.overtimePrice) : null,
          options: productForm.options.filter(o => o.optionType.trim() && o.optionValue.trim()),
        };

      const url = editingProduct ? `/api/admin/products/${editingProduct}` : "/api/admin/products";
      const method = editingProduct ? "PATCH" : "POST";
      const res = await fetch(api(url), {
        method, headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.isDuplicate) {
          setProductDupeWarning({ existing: data.existing ?? [] });
          setToast("중복: 이미 같은 상품이 존재합니다.");
        } else {
          setToast(`오류: ${data.error}`);
        }
        return;
      }
      setProductDupeWarning(null);
      setToast(editingProduct ? "상품이 수정되었습니다." : `상품 등록 완료 (코드: ${data.code})`);
      setProductForm(emptyProductForm);
      setEditingProduct(null);
      setShowProductForm(false);
      setProductNameCustom(false);
      await fetchProducts();
    } catch { setToast("오류: 상품 저장 실패"); }
    finally { setSavingProduct(false); }
  };

  // ─── 상품 등록 요청 제출 ─────────────────────────────────────────────────
  const handleSubmitRequest = async () => {
    const effectiveName = autoName(requestForm);
    if (!requestForm.mainCategory || !effectiveName) {
      setToast("대분류와 상품명은 필수입니다."); return;
    }
    setSubmittingRequest(true);
    try {
      const hasLang = PRODUCT_TYPES_META[requestForm.productType]?.hasLanguage ?? false;
      const res = await fetch(api("/api/admin/product-requests"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          productType: requestForm.productType,
          sourceLanguage: hasLang ? requestForm.sourceLanguage : null,
          targetLanguage: hasLang ? requestForm.targetLanguage : null,
          mainCategory: requestForm.mainCategory,
          subCategory: requestForm.subCategory || null,
          name: effectiveName,
          unit: requestForm.unit || "건",
          description: requestForm.description.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      const dupMsg = data.hasDuplicate ? " (중복 상품 있음 — 관리자 검토 필요)" : "";
      setToast(`요청이 제출되었습니다.${dupMsg}`);
      setRequestForm({ ...emptyProductForm });
      setShowRequestForm(false);
      fetchProductRequests();
    } catch { setToast("오류: 요청 제출 실패"); }
    finally { setSubmittingRequest(false); }
  };

  // ─── 요청 승인/거절 ──────────────────────────────────────────────────────
  const handleApproveRequest = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/product-requests/${id}/approve`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`승인 실패: ${data.error}`); return; }
      setToast(`승인 완료. 상품 코드: ${data.product?.code}`);
      fetchProductRequests();
      fetchProducts();
    } catch { setToast("오류: 승인 실패"); }
  };

  const handleRejectRequest = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/product-requests/${id}/reject`), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason.trim() || null }),
      });
      if (!res.ok) { const d = await res.json(); setToast(`거절 실패: ${d.error}`); return; }
      setToast("요청이 거절되었습니다.");
      setRejectingRequestId(null);
      setRejectReason("");
      fetchProductRequests();
    } catch { setToast("오류: 거절 처리 실패"); }
  };

  // ─── 엑셀 다운로드 ──────────────────────────────────────────────────────
  const handleProductExcelDownload = async (type: "template" | "export") => {
    const res = await fetch(api(`/api/admin/products/${type}`), { headers: authHeaders });
    if (!res.ok) { setToast("다운로드 실패"); return; }
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = type === "template" ? "상품_템플릿.xlsx" : `상품목록_${new Date().toISOString().slice(0, 10)}.xlsx`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  // ─── 엑셀 업로드 ────────────────────────────────────────────────────────
  const handleProductImport = async (file: File) => {
    setProductImporting(true);
    setProductImportResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(api("/api/admin/products/import"), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const data = await res.json();
      if (!res.ok) { setToast(data.error ?? "업로드 실패"); return; }
      setProductImportResult(data);
      if (data.created > 0) await fetchProducts();
    } finally {
      setProductImporting(false);
      if (productImportRef.current) productImportRef.current.value = "";
    }
  };

  // ─── 상품 활성/비활성 토글 ───────────────────────────────────────────────
  const handleToggleProduct = async (id: number) => {
    const product = products.find(p => p.id === id);
    if (product?.active) {
      setDeactivatingProductId(id);
      setDeactivationReason("");
      return;
    }
    try {
      const res = await fetch(api(`/api/admin/products/${id}/toggle`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) { const d = await res.json(); setToast(`오류: ${d.error}`); return; }
      await fetchProducts();
    } catch { setToast("오류: 상태 변경 실패"); }
  };

  const handleConfirmDeactivate = async () => {
    if (!deactivatingProductId) return;
    if (!deactivationReason.trim()) { setToast("비활성화 사유를 입력하세요."); return; }
    try {
      const res = await fetch(api(`/api/admin/products/${deactivatingProductId}/toggle`), {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: deactivationReason.trim() }),
      });
      const d = await res.json();
      if (!res.ok) { setToast(`오류: ${d.error}`); return; }
      setDeactivatingProductId(null);
      setDeactivationReason("");
      await fetchProducts();
      setToast("상품이 비활성화되었습니다.");
    } catch { setToast("오류: 비활성화 실패"); }
  };

  // ─── 상품 폼 렌더링 ─────────────────────────────────────────────────────
  function renderProductForm(
    form: ProductFormType,
    setForm: React.Dispatch<React.SetStateAction<ProductFormType>>,
    isEdit: boolean,
    isRequest: boolean = false,
  ) {
    const typeInfo = PRODUCT_TYPES_META[form.productType];
    const hasLang = typeInfo?.hasLanguage ?? false;
    const mainCats = MAIN_CATEGORIES_BY_TYPE[form.productType] ?? [];
    const subCats = SUB_CATEGORIES_BY_MAIN[form.mainCategory] ?? [];
    const units = UNITS_BY_PRODUCT_TYPE[form.productType] ?? ["건"];
    const typeColor = TYPE_COLORS[form.productType] ?? { bg: "#f9fafb", color: "#374151", icon: "📦" };
    const isInterp = form.productType === "interpretation" || form.productType === "combined";
    const codePrev = previewCode(form.productType, form.sourceLanguage, form.targetLanguage, form.mainCategory, form.subCategory);

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
                    onClick={() => handleProductTypeChange(k, setForm)}
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
            <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#1d4ed8" }}>언어 설정</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>출발언어 <span style={{ color: "#dc2626" }}>*</span></label>
                <LanguageSearchSelect
                  value={form.sourceLanguage}
                  onChange={v => {
                    setForm(p => {
                      const updated = { ...p, sourceLanguage: v, sourceLanguageCustom: "" };
                      if (!productNameCustom) updated.name = autoName(updated);
                      return updated;
                    });
                  }}
                  mode="code"
                  placeholder="출발언어 선택..."
                  triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                />
                {isLangCustom(form.sourceLanguage, "code") && (
                  <LangCustomInput
                    value={form.sourceLanguageCustom}
                    onChange={v => setForm(p => ({ ...p, sourceLanguageCustom: v }))}
                    label="직접 입력 출발언어"
                  />
                )}
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>도착언어 <span style={{ color: "#dc2626" }}>*</span></label>
                <LanguageSearchSelect
                  value={form.targetLanguage}
                  onChange={v => {
                    setForm(p => {
                      const updated = { ...p, targetLanguage: v, targetLanguageCustom: "" };
                      if (!productNameCustom) updated.name = autoName(updated);
                      return updated;
                    });
                  }}
                  mode="code"
                  placeholder="도착언어 선택..."
                  triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                />
                {isLangCustom(form.targetLanguage, "code") && (
                  <LangCustomInput
                    value={form.targetLanguageCustom}
                    onChange={v => setForm(p => ({ ...p, targetLanguageCustom: v }))}
                    label="직접 입력 도착언어"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* 대분류 / 중분류 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>
              대분류 <span style={{ color: "#dc2626" }}>*</span>
              {!isEdit && <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>(상품유형에 따라 자동 변경)</span>}
            </label>
            <ClickSelect
              value={form.mainCategory}
              onChange={v => {
                setForm(p => {
                  const updated = { ...p, mainCategory: v, subCategory: "" };
                  if (!productNameCustom) updated.name = autoName(updated);
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
                  const updated = { ...p, subCategory: v };
                  if (!productNameCustom) updated.name = autoName(updated);
                  return updated;
                });
              }}
              style={{ width: "100%", opacity: subCats.length === 0 ? 0.4 : 1, pointerEvents: subCats.length === 0 ? "none" : undefined }}
              triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
              options={[{ value: "", label: "선택" }, ...subCats.map(s => ({ value: s.label, label: s.label }))]}
            />
          </div>
        </div>

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
                  if (productNameCustom) {
                    setForm(p => ({ ...p, name: autoName(p) }));
                  }
                  setProductNameCustom(v => !v);
                }}
                style={{ fontSize: 11, color: productNameCustom ? "#9ca3af" : "#2563eb", background: "none", border: "none", cursor: "pointer", padding: "0 2px", textDecoration: "underline" }}>
                {productNameCustom ? "↩ 자동 생성으로" : "✏ 이름 직접 입력"}
              </button>
            )}
          </div>
          {!isEdit && !productNameCustom ? (
            <div style={{ padding: "9px 12px", borderRadius: 8, background: "#f3f4f6", border: "1px solid #e5e7eb", fontSize: 13, color: "#111827", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>자동</span>
              {autoName(form)}
            </div>
          ) : (
            <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              placeholder="예: 한영 법률번역" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
          )}
        </div>

        {/* 단위 / 기본단가 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>
              단위 <span style={{ fontSize: 11, color: "#9ca3af" }}>(상품유형에 따라 자동 변경)</span>
            </label>
            <ClickSelect
              value={form.unit}
              onChange={v => setForm(p => ({ ...p, unit: v }))}
              options={units.map(u => ({ value: u, label: u }))}
              style={{ width: "100%" }}
              triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>기본단가 <span style={{ color: "#dc2626" }}>*</span></label>
            <input value={form.basePrice} onChange={e => setForm(p => ({ ...p, basePrice: e.target.value }))}
              type="number" min="0" placeholder="0"
              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
          </div>
        </div>

        {/* 통역 전용: 기본진행시간 / 초과단가 */}
        {isInterp && (
          <div style={{ background: "#faf5ff", borderRadius: 8, padding: "10px 14px", border: "1px solid #e9d5ff", marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 3 }}>기본 진행시간 (예: 4h)</label>
                <input value={form.interpretationDuration} onChange={e => setForm(p => ({ ...p, interpretationDuration: e.target.value }))}
                  placeholder="예: 4h, 반일, 종일"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 3 }}>초과 단가 (1시간당)</label>
                <input value={form.overtimePrice} onChange={e => setForm(p => ({ ...p, overtimePrice: e.target.value }))}
                  type="number" min="0" placeholder="초과 시 적용 단가 (선택)"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
            </div>
          </div>
        )}

        {/* 설명 */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>설명 (선택)</label>
          <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
            placeholder="상품에 대한 간단한 설명"
            style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
        </div>

        {/* 옵션 (요청 폼 제외) */}
        {!isRequest && (
          <div style={{ background: "#f9fafb", borderRadius: 10, padding: "14px 16px", border: "1px solid #e5e7eb" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#374151" }}>옵션 설정 <span style={{ fontWeight: 400, color: "#9ca3af", fontSize: 12 }}>(언어, 방식, 시간 등)</span></p>
              <button onClick={() => setForm(p => ({ ...p, options: [...p.options, { optionType: "언어", optionValue: "" }] }))}
                style={{ fontSize: 12, color: "#2563eb", background: "none", border: "1px solid #bfdbfe", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontWeight: 600 }}>
                + 옵션 추가
              </button>
            </div>
            {form.options.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: "#9ca3af", textAlign: "center" }}>옵션이 없습니다.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {form.options.map((opt, idx) => (
                  <div key={idx} style={{ display: "grid", gridTemplateColumns: "140px 1fr 32px", gap: 8, alignItems: "center" }}>
                    <ClickSelect
                      value={opt.optionType}
                      onChange={v => setForm(p => ({ ...p, options: p.options.map((o, i) => i === idx ? { ...o, optionType: v } : o) }))}
                      triggerStyle={{ fontSize: 13, padding: "6px 8px", borderRadius: 7, width: "100%" }}
                      options={PRODUCT_OPTION_TYPES.map(t => ({ value: t, label: t }))}
                    />
                    <input value={opt.optionValue} onChange={e => setForm(p => ({ ...p, options: p.options.map((o, i) => i === idx ? { ...o, optionValue: e.target.value } : o) }))}
                      placeholder="예: 한→영"
                      style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                    <button onClick={() => setForm(p => ({ ...p, options: p.options.filter((_, i) => i !== idx) }))}
                      style={{ background: "none", border: "1px solid #fca5a5", borderRadius: 6, width: 32, height: 32, cursor: "pointer", color: "#ef4444", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 중복 경고 */}
        {productDupeWarning && (
          <div style={{ marginTop: 10, background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px" }}>
            <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, color: "#92400e" }}>⚠ 동일한 상품이 이미 존재합니다</p>
            {productDupeWarning.existing.map(ex => (
              <p key={ex.id} style={{ margin: "2px 0", fontSize: 12, color: "#92400e" }}>
                기존 상품: <code style={{ background: "#fde68a", padding: "1px 5px", borderRadius: 3 }}>{ex.code}</code> — {ex.name}
              </p>
            ))}
          </div>
        )}
      </>
    );
  }

  // ─── 상품 카드 렌더링 ────────────────────────────────────────────────────
  function renderProductCard(p: Product) {
    const typeInfo = PRODUCT_TYPES_META[p.productType];
    const tc = TYPE_COLORS[p.productType] ?? { bg: "#f9fafb", color: "#374151", icon: "📦" };
    const srcLabel = p.sourceLanguage ? (LANG_LABEL[p.sourceLanguage] ?? p.sourceLanguage) : null;
    const tgtLabel = p.targetLanguage ? (LANG_LABEL[p.targetLanguage] ?? p.targetLanguage) : null;
    const hasLang = typeInfo?.hasLanguage ?? false;

    return (
      <Card key={p.id} style={{ padding: "14px 18px", opacity: p.active ? 1 : 0.6 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#9ca3af", background: "#f3f4f6", padding: "1px 6px", borderRadius: 4 }}>{p.code}</span>
              <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{p.name}</span>
              <span style={{ fontSize: 11, borderRadius: 5, padding: "2px 8px", fontWeight: 700, background: tc.bg, color: tc.color }}>
                {tc.icon} {typeInfo?.label ?? p.productType}
              </span>
              {!p.active && <span style={{ fontSize: 11, background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>비활성</span>}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
              {hasLang && srcLabel && tgtLabel && (
                <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                  {srcLabel} → {tgtLabel}
                </span>
              )}
              {p.mainCategory && (
                <span style={{ fontSize: 11, background: "#ede9fe", color: "#5b21b6", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                  {p.mainCategory}
                </span>
              )}
              {p.subCategory && (
                <span style={{ fontSize: 11, background: "#f5f3ff", color: "#7c3aed", borderRadius: 5, padding: "2px 8px" }}>
                  {p.subCategory}
                </span>
              )}
              <span style={{ fontSize: 11, background: "#f0fdf4", color: "#059669", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                {Number(p.basePrice).toLocaleString()}원 / {p.unit}
              </span>
              {p.interpretationDuration && (
                <span style={{ fontSize: 11, background: "#faf5ff", color: "#7c3aed", borderRadius: 5, padding: "2px 8px" }}>기본 {p.interpretationDuration}</span>
              )}
              {p.overtimePrice != null && (
                <span style={{ fontSize: 11, background: "#fff7ed", color: "#c2410c", borderRadius: 5, padding: "2px 8px" }}>초과 {Number(p.overtimePrice).toLocaleString()}원/h</span>
              )}
              {!p.active && p.deactivationReason && (
                <span style={{ fontSize: 11, background: "#fef2f2", color: "#991b1b", borderRadius: 5, padding: "2px 8px" }}>사유: {p.deactivationReason}</span>
              )}
            </div>
            {p.description && <p style={{ margin: "0 0 6px", fontSize: 12, color: "#6b7280" }}>{p.description}</p>}
            {p.options && p.options.length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {p.options.map((o: ProductOption) => (
                  <span key={o.id} style={{ fontSize: 11, background: "#eff6ff", color: "#1d4ed8", borderRadius: 5, padding: "2px 8px", border: "1px solid #bfdbfe" }}>
                    {o.optionType}: {o.optionValue}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {hasPerm("product.manage") && (
              <button onClick={() => {
                setEditingProduct(p.id);
                setProductForm({
                  productType: p.productType,
                  sourceLanguage: p.sourceLanguage ?? "",
                  targetLanguage: p.targetLanguage ?? "",
                  mainCategory: p.mainCategory ?? "",
                  subCategory: p.subCategory ?? "",
                  name: p.name,
                  unit: p.unit,
                  basePrice: String(p.basePrice),
                  description: p.description ?? "",
                  interpretationDuration: p.interpretationDuration ?? "",
                  overtimePrice: p.overtimePrice != null ? String(p.overtimePrice) : "",
                  options: (p.options ?? []).map((o: ProductOption) => ({ optionType: o.optionType, optionValue: o.optionValue })),
                });
                setProductNameCustom(true);
                setShowProductForm(true);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
                style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#eff6ff", color: "#2563eb", border: "none", fontWeight: 600 }}>
                수정
              </button>
            )}
            {hasPerm("product.manage") && (
              <button onClick={() => handleToggleProduct(p.id)}
                style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: p.active ? "#fef2f2" : "#f0fdf4", color: p.active ? "#dc2626" : "#059669", border: "none", fontWeight: 600 }}>
                {p.active ? "비활성" : "활성"}
              </button>
            )}
          </div>
        </div>
      </Card>
    );
  }

  // ─── 메인 렌더링 ────────────────────────────────────────────────────────
  return (
    <>
      <Section title={`상품/단가 관리 (${products.length})`} action={
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => handleProductExcelDownload("template")}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: "pointer", fontWeight: 600 }}>
            📋 템플릿
          </button>
          <button onClick={() => handleProductExcelDownload("export")}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#059669", cursor: "pointer", fontWeight: 600 }}>
            ⬇ 엑셀 내보내기
          </button>
          <label style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#2563eb", cursor: productImporting ? "not-allowed" : "pointer", fontWeight: 600, opacity: productImporting ? 0.6 : 1 }}>
            {productImporting ? "처리 중..." : "⬆ 엑셀 업로드"}
            <input ref={productImportRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleProductImport(f); }} />
          </label>
          {hasPerm("product.manage") && (
            <PrimaryBtn onClick={() => {
              setShowProductForm(v => !v);
              setEditingProduct(null);
              setProductForm(emptyProductForm);
              setProductImportResult(null);
              setProductNameCustom(false);
              setProductDupeWarning(null);
            }} style={{ fontSize: 13, padding: "7px 14px" }}>
              {showProductForm && !editingProduct ? "취소" : "+ 상품 등록"}
            </PrimaryBtn>
          )}
        </div>
      }>
        {/* 엑셀 업로드 결과 */}
        {productImportResult && (
          <div style={{ background: productImportResult.errors.length === 0 ? "#f0fdf4" : "#fffbeb", border: `1px solid ${productImportResult.errors.length === 0 ? "#bbf7d0" : "#fde68a"}`, borderRadius: 10, padding: "14px 18px", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: productImportResult.errors.length > 0 ? 10 : 0 }}>
              <div style={{ display: "flex", gap: 16 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>✅ 신규 등록: {productImportResult.created}건</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#9ca3af" }}>⏭ 중복 스킵: {productImportResult.skipped}건</span>
                {productImportResult.errors.length > 0 && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#dc2626" }}>⚠ 오류: {productImportResult.errors.length}건</span>
                )}
              </div>
              <button onClick={() => setProductImportResult(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 18 }}>×</button>
            </div>
            {productImportResult.errors.length > 0 && (
              <div style={{ maxHeight: 130, overflowY: "auto", background: "#fff8f0", borderRadius: 6, padding: "8px 12px" }}>
                {productImportResult.errors.map((e, i) => (
                  <p key={i} style={{ margin: "2px 0", fontSize: 12, color: "#92400e" }}>
                    <strong>{e.row}행:</strong> {e.message}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 등록/수정 폼 */}
        {showProductForm && (
          <Card style={{ marginBottom: 16, padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>
                {editingProduct ? "상품 수정" : "새 상품 등록 (코드 자동 생성)"}
              </p>
              {editingProduct && (
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6b7280", background: "#f3f4f6", padding: "3px 8px", borderRadius: 5 }}>
                  {products.find(p => p.id === editingProduct)?.code ?? ""}
                </span>
              )}
            </div>
            {renderProductForm(productForm, setProductForm, !!editingProduct)}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <PrimaryBtn onClick={handleSaveProduct} disabled={savingProduct} style={{ fontSize: 13, padding: "8px 18px" }}>
                {savingProduct ? "저장 중..." : "저장"}
              </PrimaryBtn>
              <GhostBtn onClick={() => {
                setShowProductForm(false); setEditingProduct(null);
                setProductForm(emptyProductForm); setProductDupeWarning(null);
                setProductNameCustom(false);
              }} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
            </div>
          </Card>
        )}

        {/* 필터 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "flex-start" }}>
          <input value={productSearch} onChange={e => setProductSearch(e.target.value)}
            placeholder="상품명, 코드 검색..."
            style={{ ...inputStyle, maxWidth: 200, flex: "1 1 140px", padding: "8px 12px", fontSize: 13 }}
            onKeyDown={e => e.key === "Enter" && fetchProducts()} />
          <select value={filterProductType} onChange={e => setFilterProductType(e.target.value)}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 110 }}>
            <option value="">전체 유형</option>
            {Object.entries(PRODUCT_TYPES_META).map(([k, v]) => (
              <option key={k} value={k}>{TYPE_COLORS[k]?.icon} {v.label}</option>
            ))}
          </select>
          {/* 출발언어 필터 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <LanguageSearchSelect
              value={filterSourceLang}
              onChange={v => { setFilterSourceLang(v); setFilterSourceLangCustom(""); }}
              mode="code"
              placeholder="출발언어 전체"
              style={{ minWidth: 130 }}
              triggerStyle={{ padding: "8px 10px", fontSize: 13, borderRadius: 7 }}
            />
            {filterSourceLang === "custom" && (
              <div>
                <label style={{ fontSize: 10, color: "#6b7280", display: "block", marginBottom: 2 }}>직접 입력 출발언어</label>
                <input
                  autoFocus
                  value={filterSourceLangCustom}
                  onChange={e => setFilterSourceLangCustom(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && fetchProducts()}
                  placeholder="예: 카자흐어, 세르비아어..."
                  style={{
                    width: "100%", padding: "5px 8px", fontSize: 12,
                    border: "1px solid #a5b4fc", borderRadius: 6, outline: "none",
                    color: "#111827", background: "#faf5ff", boxSizing: "border-box",
                  }}
                />
              </div>
            )}
          </div>
          {/* 도착언어 필터 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <LanguageSearchSelect
              value={filterTargetLang}
              onChange={v => { setFilterTargetLang(v); setFilterTargetLangCustom(""); }}
              mode="code"
              placeholder="도착언어 전체"
              style={{ minWidth: 130 }}
              triggerStyle={{ padding: "8px 10px", fontSize: 13, borderRadius: 7 }}
            />
            {filterTargetLang === "custom" && (
              <div>
                <label style={{ fontSize: 10, color: "#6b7280", display: "block", marginBottom: 2 }}>직접 입력 도착언어</label>
                <input
                  autoFocus
                  value={filterTargetLangCustom}
                  onChange={e => setFilterTargetLangCustom(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && fetchProducts()}
                  placeholder="예: 카자흐어, 세르비아어..."
                  style={{
                    width: "100%", padding: "5px 8px", fontSize: 12,
                    border: "1px solid #a5b4fc", borderRadius: 6, outline: "none",
                    color: "#111827", background: "#faf5ff", boxSizing: "border-box",
                  }}
                />
              </div>
            )}
          </div>
          <select value={filterActiveOnly} onChange={e => setFilterActiveOnly(e.target.value as "" | "true" | "false")}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 100 }}>
            <option value="">전체 상태</option>
            <option value="true">✅ 활성만</option>
            <option value="false">🔴 비활성만</option>
          </select>
          <PrimaryBtn onClick={fetchProducts} disabled={productsLoading} style={{ padding: "8px 14px", fontSize: 13 }}>
            {productsLoading ? "검색 중..." : "검색"}
          </PrimaryBtn>
          {(productSearch || filterProductType || filterSourceLang || filterSourceLangCustom || filterTargetLang || filterTargetLangCustom || filterMainCategory || filterActiveOnly) && (
            <button onClick={() => {
              setProductSearch(""); setFilterProductType("");
              setFilterSourceLang(""); setFilterSourceLangCustom("");
              setFilterTargetLang(""); setFilterTargetLangCustom("");
              setFilterMainCategory(""); setFilterActiveOnly("");
            }}
              style={{ padding: "8px 12px", fontSize: 12, borderRadius: 7, border: "1px solid #e5e7eb", background: "#f3f4f6", color: "#6b7280", cursor: "pointer" }}>
              필터 초기화
            </button>
          )}
        </div>

        {/* 상품 목록 */}
        {productsLoading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
        ) : products.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 상품이 없습니다.</Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {products.map(p => renderProductCard(p))}
          </div>
        )}
      </Section>

      {/* 상품 등록 요청 섹션 */}
      <Section
        title={`상품 등록 요청 (${productRequests.filter(r => r.status === "pending").length}건 대기)`}
        action={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["all", "pending", "approved", "rejected"] as const).map(s => (
              <button key={s} onClick={() => setProductRequestStatusFilter(s)}
                style={{
                  fontSize: 12, padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontWeight: 600, border: "none",
                  background: productRequestStatusFilter === s ? (s === "pending" ? "#fef3c7" : s === "approved" ? "#dcfce7" : s === "rejected" ? "#fee2e2" : "#1d4ed8") : "#f3f4f6",
                  color: productRequestStatusFilter === s ? (s === "pending" ? "#92400e" : s === "approved" ? "#166534" : s === "rejected" ? "#991b1b" : "#fff") : "#6b7280",
                }}>
                {s === "all" ? "전체" : s === "pending" ? "⏳ 대기" : s === "approved" ? "✅ 승인" : "❌ 거절"}
              </button>
            ))}
            <button onClick={() => { setShowRequestForm(v => !v); setRequestForm({ ...emptyProductForm }); }}
              style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontWeight: 700, background: showRequestForm ? "#f3f4f6" : "#faf5ff", color: showRequestForm ? "#6b7280" : "#7c3aed", border: "1px solid #e9d5ff" }}>
              {showRequestForm ? "취소" : "+ 등록 요청"}
            </button>
          </div>
        }>

        {/* 요청 폼 */}
        {showRequestForm && (
          <Card style={{ marginBottom: 14, padding: "18px 22px", border: "1px solid #e9d5ff", background: "#faf5ff" }}>
            <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#6d28d9" }}>
              상품 등록 요청 <span style={{ fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>— 관리자 승인 후 자동 코드 부여</span>
            </p>
            {renderProductForm(requestForm, setRequestForm, false, true)}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={handleSubmitRequest} disabled={submittingRequest}
                style={{ padding: "8px 18px", fontSize: 13, borderRadius: 8, cursor: "pointer", fontWeight: 700, background: "#7c3aed", color: "#fff", border: "none", opacity: submittingRequest ? 0.7 : 1 }}>
                {submittingRequest ? "제출 중..." : "요청 제출"}
              </button>
              <GhostBtn onClick={() => setShowRequestForm(false)} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
            </div>
          </Card>
        )}

        {/* 요청 목록 */}
        {productRequestsLoading ? (
          <div style={{ textAlign: "center", padding: "20px 0", color: "#9ca3af", fontSize: 13 }}>불러오는 중...</div>
        ) : productRequests.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "24px", color: "#9ca3af", fontSize: 13 }}>요청이 없습니다.</Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {productRequests.map(req => {
              const tc = TYPE_COLORS[req.productType] ?? { bg: "#f9fafb", color: "#374151", icon: "📦" };
              const typeLabel = PRODUCT_TYPES_META[req.productType]?.label ?? req.productType;
              const srcLabel = req.sourceLanguage ? (LANG_LABEL[req.sourceLanguage] ?? req.sourceLanguage) : null;
              const tgtLabel = req.targetLanguage ? (LANG_LABEL[req.targetLanguage] ?? req.targetLanguage) : null;
              return (
                <Card key={req.id} style={{ padding: "14px 18px", background: req.status === "pending" ? "#fffbeb" : req.status === "approved" ? "#f0fdf4" : "#fef2f2" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{req.name}</span>
                        <span style={{ fontSize: 11, borderRadius: 5, padding: "2px 8px", fontWeight: 700, background: tc.bg, color: tc.color }}>
                          {tc.icon} {typeLabel}
                        </span>
                        {srcLabel && tgtLabel && (
                          <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                            {srcLabel} → {tgtLabel}
                          </span>
                        )}
                        {req.mainCategory && (
                          <span style={{ fontSize: 11, background: "#ede9fe", color: "#5b21b6", borderRadius: 5, padding: "2px 8px" }}>
                            {req.mainCategory}{req.subCategory ? ` / ${req.subCategory}` : ""}
                          </span>
                        )}
                        <span style={{ fontSize: 11, borderRadius: 5, padding: "2px 8px", fontWeight: 700, background: req.status === "pending" ? "#fef3c7" : req.status === "approved" ? "#dcfce7" : "#fee2e2", color: req.status === "pending" ? "#92400e" : req.status === "approved" ? "#166534" : "#991b1b" }}>
                          {req.status === "pending" ? "⏳ 대기" : req.status === "approved" ? "✅ 승인" : "❌ 거절"}
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>
                        요청자: {req.requestedByEmail ?? "-"} · {new Date(req.createdAt).toLocaleDateString("ko-KR")}
                        {req.description && ` · ${req.description}`}
                      </p>
                      {req.status === "rejected" && req.rejectionReason && (
                        <p style={{ margin: "4px 0 0", fontSize: 12, color: "#991b1b" }}>거절 사유: {req.rejectionReason}</p>
                      )}
                    </div>
                    {req.status === "pending" && user?.role === "admin" && (
                      <div style={{ display: "flex", gap: 6, flexShrink: 0, flexDirection: "column" }}>
                        <button onClick={() => handleApproveRequest(req.id)}
                          style={{ padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#dcfce7", color: "#166534", border: "none", fontWeight: 700 }}>
                          ✅ 승인
                        </button>
                        {rejectingRequestId === req.id ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                              placeholder="거절 사유 (선택)"
                              style={{ ...inputStyle, fontSize: 12, padding: "4px 8px", width: 160 }} />
                            <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => handleRejectRequest(req.id)}
                                style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#fee2e2", color: "#991b1b", border: "none", fontWeight: 700 }}>
                                확인
                              </button>
                              <button onClick={() => setRejectingRequestId(null)}
                                style={{ padding: "4px 8px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#f3f4f6", color: "#6b7280", border: "none" }}>
                                취소
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => { setRejectingRequestId(req.id); setRejectReason(""); }}
                            style={{ padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#fee2e2", color: "#991b1b", border: "none", fontWeight: 700 }}>
                            ❌ 거절
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {/* 비활성화 사유 모달 */}
      {deactivatingProductId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <Card style={{ width: 400, padding: "24px 28px" }}>
            <p style={{ margin: "0 0 12px", fontWeight: 700, fontSize: 15 }}>비활성화 사유를 입력하세요</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {DEACTIVATION_REASONS.map(r => (
                <button key={r} onClick={() => setDeactivationReason(r)}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, border: `1px solid ${deactivationReason === r ? "#2563eb" : "#e5e7eb"}`, background: deactivationReason === r ? "#eff6ff" : "#f9fafb", color: deactivationReason === r ? "#2563eb" : "#374151", cursor: "pointer" }}>
                  {r}
                </button>
              ))}
            </div>
            <input value={deactivationReason} onChange={e => setDeactivationReason(e.target.value)}
              placeholder="직접 입력..."
              style={{ ...inputStyle, marginBottom: 14 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <PrimaryBtn onClick={handleConfirmDeactivate} style={{ fontSize: 13 }}>비활성화</PrimaryBtn>
              <GhostBtn onClick={() => setDeactivatingProductId(null)} style={{ fontSize: 13 }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
