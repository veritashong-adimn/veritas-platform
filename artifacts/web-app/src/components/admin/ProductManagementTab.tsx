import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  api, Product, ProductOption,
  PRODUCT_TYPES_META, MAIN_CATEGORIES_BY_TYPE, SUB_CATEGORIES_BY_MAIN,
  LANGUAGE_CODES, UNITS_BY_PRODUCT_TYPE, PRODUCT_OPTION_TYPES,
  EQUIPMENT_QUANTITY_UNITS, EQUIPMENT_USAGE_PERIODS, INTERPRETATION_DIRECTIONS,
} from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect, NumericInput } from '../ui';
import { LanguageSearchSelect, LangCustomInput, isLangCustom } from './LanguageSearchSelect';
import { LazyProductPanel } from './LazyProductPanel';
import { getZhExcludeCodes, normalizeZhForType } from '../../lib/zhLangPolicy';
import ImportPreviewPanel, {
  type ImportPreviewData,
  type ImportResult,
  type ReviewSessionMeta,
  type RowOverride,
  loadReviewSession,
  saveReviewSession,
  clearReviewSession,
} from './ImportPreviewPanel';

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
  combined:       { bg: "#eef2ff", color: "#4338ca", icon: "🌐" },
  proofreading:   { bg: "#f0fdf4", color: "#16a34a", icon: "✏️" },
  media:          { bg: "#fff1f2", color: "#be123c", icon: "🎬" },
  equipment:      { bg: "#fff7ed", color: "#c2410c", icon: "🔧" },
  editing:        { bg: "#fdf4ff", color: "#9333ea", icon: "🖨️" },
  operations:     { bg: "#f0fdfa", color: "#0f766e", icon: "🏃" },
  project:        { bg: "#f8fafc", color: "#334155", icon: "📋" },
  transport:      { bg: "#fafafa", color: "#525252", icon: "🚌" },
  meal:           { bg: "#fffbeb", color: "#d97706", icon: "🍽️" },
  accommodation:  { bg: "#f0f9ff", color: "#0369a1", icon: "🏨" },
  other_cost:     { bg: "#f9fafb", color: "#6b7280", icon: "🧾" },
  expense:        { bg: "#fefce8", color: "#b45309", icon: "💰" },
};

// ─── 장비 대분류별 기본 수량단위 ─────────────────────────────────────────────
const EQUIP_UNIT_BY_MAIN: Record<string, string> = {
  "동시통역장비": "대",
  "가이드장비":   "대",
  "위스퍼링장비": "대",
  "마이크장비":   "대",
  "음향장비":     "대",
  "부스장비":     "일",
  "운영장비":     "건",
  "기타장비":     "건",
};

// ─── 코드 미리보기 생성 ──────────────────────────────────────────────────────
function previewCode(productType: string, mainCategory: string): string {
  const typeInfo = PRODUCT_TYPES_META[productType];
  if (!typeInfo) return "?";
  const mainCats = MAIN_CATEGORIES_BY_TYPE[productType] ?? [];
  const mainCode = mainCats.find(c => c.label === mainCategory)?.code ?? "GEN";
  return `${typeInfo.code}-${mainCode}-###`;
}

// ─── 폼 타입 ────────────────────────────────────────────────────────────────
type ProductFormType = {
  productType: string;
  sourceLanguage: string;
  sourceLanguageCustom: string;
  targetLanguage: string;
  targetLanguageCustom: string;
  equipmentItem: string;
  equipmentItemCustom: string;
  mainCategory: string;
  subCategory: string;
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
  equipmentItem: "", equipmentItemCustom: "",
  mainCategory: "번역", subCategory: "",
  name: "", unit: "페이지", quantityUnit: "개", usagePeriod: "1일", usagePeriodCustom: "", interpretationDirection: "양방향",
  basePrice: "", description: "",
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
  const productImportRef = useRef<HTMLInputElement>(null);

  const [showLazyPanel, setShowLazyPanel] = useState(false);

  // ─── Import Preview state (managed by ImportPreviewPanel) ────────────────
  const [importPreviewData, setImportPreviewData] = useState<ImportPreviewData | null>(null);
  const [importInitialData, setImportInitialData] = useState<{
    rowOverrides: Record<number, RowOverride>;
    session: ReviewSessionMeta;
    restored: boolean;
  } | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

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
  const [filterMainCategory, setFilterMainCategory] = useState("");
  const [filterActiveOnly, setFilterActiveOnly] = useState<"" | "true" | "false">("");

  const [deletingRequestId, setDeletingRequestId] = useState<number | null>(null);
  const [deletingRequestInProgress, setDeletingRequestInProgress] = useState(false);

  // 기타 상태
  const [deactivatingProductId, setDeactivatingProductId] = useState<number | null>(null);
  const [deactivationReason, setDeactivationReason] = useState("");
  const [productDupeWarning, setProductDupeWarning] = useState<{ existing: { id: number; code: string; name: string }[] } | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<{ id: number; code: string; name: string } | null>(null);
  const [purging, setPurging] = useState(false);
  const [productNameCustom, setProductNameCustom] = useState(false);

  // ─── 자동 상품명 생성 ────────────────────────────────────────────────────
  function autoName(f: ProductFormType): string {
    const typeLabel = PRODUCT_TYPES_META[f.productType]?.label ?? f.productType;
    const hasLang = PRODUCT_TYPES_META[f.productType]?.hasLanguage ?? false;

    // 통역장비: 중분류(subCategory) → 대분류(mainCategory) 기반
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
    const isInterpType = f.productType === "interpretation" || f.productType === "combined";
    if (hasLang && srcLabel && tgtLabel) {
      // 비통역(번역/감수/미디어 등): 하이픈(-) 구분자. 방향성 없는 서비스이므로 화살표 사용 안 함.
      // 통역/통번역: 방향 표시 유지 (→ / ↔)
      let sep = isInterpType ? "→" : "-";
      let aLabel = srcLabel;
      let bLabel = tgtLabel;
      if (isInterpType) {
        const dir = f.interpretationDirection || "양방향";
        if (dir === "양방향") { sep = "↔"; }
        else if (dir === "B→A") { aLabel = tgtLabel; bLabel = srcLabel; sep = "→"; }
      }
      return subLabel
        ? `${aLabel}${sep}${bLabel} ${subLabel} ${typeLabel}`
        : (mainLabel ? `${aLabel}${sep}${bLabel} ${mainLabel}` : `${aLabel}${sep}${bLabel} ${typeLabel}`);
    }
    return mainLabel ? `${mainLabel}` : typeLabel;
  }

  // ─── productType 변경 시 연관 필드 초기화 ───────────────────────────────
  function handleProductTypeChange(newType: string, setter: React.Dispatch<React.SetStateAction<ProductFormType>>) {
    const hasLang = PRODUCT_TYPES_META[newType]?.hasLanguage ?? false;
    const isEquip = newType === "equipment";
    const mainCats = MAIN_CATEGORIES_BY_TYPE[newType] ?? [];
    const defMain = mainCats[0]?.label ?? "";
    const defUnit = (UNITS_BY_PRODUCT_TYPE[newType] ?? ["건"])[0];
    setter(prev => {
      const rawSrc = hasLang ? (prev.sourceLanguage || "ko") : "";
      const rawTgt = hasLang ? (prev.targetLanguage || "en") : "";
      const updated = {
        ...prev,
        productType: newType,
        mainCategory: defMain,
        subCategory: "",
        unit: defUnit,
        sourceLanguage: hasLang ? normalizeZhForType(rawSrc, newType) : "",
        targetLanguage: hasLang ? normalizeZhForType(rawTgt, newType) : "",
        equipmentItem: isEquip ? prev.equipmentItem : "",
        equipmentItemCustom: isEquip ? prev.equipmentItemCustom : "",
        quantityUnit: isEquip ? (EQUIP_UNIT_BY_MAIN[defMain] ?? "개") : "",
        usagePeriod: isEquip ? "1일" : "",
        usagePeriodCustom: "",
        interpretationDirection: (newType === "interpretation" || newType === "combined") ? "양방향" : "",
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
      if (filterProductType) params.set("productType", filterProductType);
      if (filterMainCategory) params.set("mainCategory", filterMainCategory);
      if (filterActiveOnly) params.set("activeOnly", filterActiveOnly);

      if (productSearch.trim()) params.set("search", productSearch.trim());

      const res = await fetch(api(`/api/admin/products${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setProducts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 상품 조회 실패"); }
    finally { setProductsLoading(false); }
  }, [token, productSearch, filterProductType, filterMainCategory, filterActiveOnly]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── 마운트 시 이전 세션 복원 ───────────────────────────────────────────────
  useEffect(() => {
    const saved = loadReviewSession();
    if (saved) {
      setImportPreviewData(saved.importPreview);
      setImportInitialData({ rowOverrides: saved.rowOverrides, session: saved.session, restored: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 상품 저장 ──────────────────────────────────────────────────────────
  const handleSaveProduct = async () => {
    const effectiveName = productNameCustom ? productForm.name.trim() : autoName(productForm);
    if (!effectiveName) {
      setToast("상품명은 필수입니다."); return;
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

    const isEquipForm = productForm.productType === "equipment";
    const effectiveUnit = isEquipForm ? (productForm.quantityUnit || "개") : productForm.unit;
    const effectiveUsagePeriod = isEquipForm
      ? (productForm.usagePeriod === "직접입력" ? (productForm.usagePeriodCustom.trim() || null) : productForm.usagePeriod || null)
      : null;
    setSavingProduct(true);
    try {
      const payload = editingProduct
        ? {
          name: effectiveName,
          mainCategory: productForm.mainCategory || null,
          subCategory: productForm.subCategory || null,
          unit: effectiveUnit,
          basePrice: productForm.basePrice !== "" ? Number(productForm.basePrice) : null,
          description: productForm.description || null,
          interpretationDuration: productForm.interpretationDuration.trim() || null,
          overtimePrice: productForm.overtimePrice ? Number(productForm.overtimePrice) : null,
          options: productForm.options.filter(o => o.optionType.trim() && o.optionValue.trim()),
          quantityUnit: isEquipForm ? (productForm.quantityUnit || null) : null,
          usagePeriod: effectiveUsagePeriod,
          interpretationDirection: productForm.interpretationDirection || null,
        }
        : {
          productType: productForm.productType,
          sourceLanguage: hasLang ? resolveLanguage(productForm.sourceLanguage, productForm.sourceLanguageCustom) : null,
          targetLanguage: hasLang ? resolveLanguage(productForm.targetLanguage, productForm.targetLanguageCustom) : null,
          mainCategory: productForm.mainCategory,
          subCategory: productForm.subCategory || null,
          name: effectiveName,
          unit: effectiveUnit,
          basePrice: productForm.basePrice !== "" ? Number(productForm.basePrice) : null,
          description: productForm.description || null,
          interpretationDuration: productForm.interpretationDuration.trim() || null,
          overtimePrice: productForm.overtimePrice ? Number(productForm.overtimePrice) : null,
          options: productForm.options.filter(o => o.optionType.trim() && o.optionValue.trim()),
          quantityUnit: isEquipForm ? (productForm.quantityUnit || null) : null,
          usagePeriod: effectiveUsagePeriod,
          interpretationDirection: productForm.interpretationDirection || null,
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
    if (!effectiveName) {
      setToast("상품명은 필수입니다."); return;
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

  const handleDeleteRequest = async () => {
    if (deletingRequestId === null) return;
    const targetId = deletingRequestId;
    setDeletingRequestInProgress(true);
    try {
      const res = await fetch(api(`/api/admin/product-requests/${targetId}`), {
        method: "DELETE", headers: authHeaders,
      });
      if (!res.ok) { const d = await res.json(); setToast(`삭제 실패: ${d.error}`); return; }
      setDeletingRequestId(null);
      setToast("요청이 삭제되었습니다.");
      await fetchProductRequests();
    } catch { setToast("오류: 삭제 실패"); }
    finally { setDeletingRequestInProgress(false); }
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
    clearReviewSession();
    setImportPreviewData(null);
    setImportInitialData(null);
    setImportResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(api("/api/admin/products/import/preview"), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const data = await res.json();
      if (!res.ok) { setToast(data.error ?? "미리보기 실패"); return; }
      const resolvedFileName = file.name || data.fileName;
      const previewWithCorrectName = { ...data, fileName: resolvedFileName };
      const newSession: ReviewSessionMeta = {
        sessionId: `rs_${Date.now()}`,
        fileName: resolvedFileName,
        uploadedAt: new Date().toISOString(),
        totalRows: data.summary?.total ?? 0,
      };
      saveReviewSession({ session: newSession, importPreview: previewWithCorrectName, rowOverrides: {} });
      setImportInitialData({ rowOverrides: {}, session: newSession, restored: false });
      setImportPreviewData(previewWithCorrectName);
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

  // ─── 상품 완전삭제 ───────────────────────────────────────────────────────
  const handlePurgeProduct = async () => {
    if (!deletingProduct) return;
    setPurging(true);
    try {
      const res = await fetch(api(`/api/admin/products/${deletingProduct.id}/purge`), {
        method: "DELETE", headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(`오류: ${data.error}`);
        setDeletingProduct(null);
        return;
      }
      setToast(`상품 "${deletingProduct.name}" (${deletingProduct.code})이 완전삭제되었습니다.`);
      setDeletingProduct(null);
      await fetchProducts();
    } catch { setToast("오류: 완전삭제 실패"); }
    finally { setPurging(false); }
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
    const isEquip = form.productType === "equipment";
    const codePrev = previewCode(form.productType, form.mainCategory);

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
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>
                  {isInterp ? "언어 A" : "출발언어"} <span style={{ color: "#dc2626" }}>*</span>
                </label>
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
                  placeholder={isInterp ? "언어 A 선택..." : "출발언어 선택..."}
                  triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  excludeCodes={zhExcludeCodes}
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
                  {isInterp ? "언어 B" : "도착언어"} <span style={{ color: "#dc2626" }}>*</span>
                </label>
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
                  placeholder={isInterp ? "언어 B 선택..." : "도착언어 선택..."}
                  triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  excludeCodes={zhExcludeCodes}
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
                        if (!productNameCustom) updated.name = autoName(updated);
                        return updated;
                      })}
                      style={{ padding: "4px 14px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                        border: `1px solid ${form.interpretationDirection === dir ? "#1d4ed8" : "#bfdbfe"}`,
                        background: form.interpretationDirection === dir ? "#dbeafe" : "#f0f7ff",
                        color: form.interpretationDirection === dir ? "#1d4ed8" : "#6b7280",
                        fontWeight: form.interpretationDirection === dir ? 700 : 400 }}>
                      {dir === "양방향" ? "↔ 양방향" : dir === "A→B" ? "→ A→B" : "← B→A"}
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
                  const updated = { ...p, mainCategory: v, subCategory: "" };
                  if (p.productType === "equipment") {
                    updated.quantityUnit = EQUIP_UNIT_BY_MAIN[v] ?? p.quantityUnit;
                  }
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
        <div style={{ display: "grid", gridTemplateColumns: isEquip ? "1fr" : "1fr 1fr", gap: 12, marginBottom: 12 }}>
          {!isEquip && (
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
          )}
          <div>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>기본단가 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(선택)</span></label>
            <NumericInput value={form.basePrice} onChange={raw => setForm(p => ({ ...p, basePrice: raw }))}
              placeholder="미입력 시 견적에서 결정" suffix="원"
              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
          </div>
        </div>

        {/* 통역장비 전용: 수량단위 / 사용기간 */}
        {isEquip && (
          <div style={{ background: "#fff7ed", borderRadius: 8, padding: "10px 14px", border: "1px solid #fed7aa", marginBottom: 12 }}>
            <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#c2410c" }}>장비 구성</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: "#c2410c", display: "block", marginBottom: 4 }}>수량단위</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {EQUIPMENT_QUANTITY_UNITS.map(u => (
                    <button key={u} type="button" data-testid={`qty-unit-${u}`}
                      onClick={() => setForm(prev => ({ ...prev, quantityUnit: u }))}
                      style={{ padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                        border: `1px solid ${form.quantityUnit === u ? "#c2410c" : "#e5e7eb"}`,
                        background: form.quantityUnit === u ? "#fff7ed" : "#f9fafb",
                        color: form.quantityUnit === u ? "#c2410c" : "#6b7280",
                        fontWeight: form.quantityUnit === u ? 700 : 400 }}>
                      {u}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#c2410c", display: "block", marginBottom: 4 }}>사용기간</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: form.usagePeriod === "직접입력" ? 4 : 0 }}>
                  {([...EQUIPMENT_USAGE_PERIODS, "직접입력"] as string[]).map(period => (
                    <button key={period} type="button" data-testid={`usage-period-${period}`}
                      onClick={() => setForm(prev => ({ ...prev, usagePeriod: period, usagePeriodCustom: period !== "직접입력" ? "" : prev.usagePeriodCustom }))}
                      style={{ padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                        border: `1px solid ${form.usagePeriod === period ? "#c2410c" : "#e5e7eb"}`,
                        background: form.usagePeriod === period ? "#fff7ed" : "#f9fafb",
                        color: form.usagePeriod === period ? "#c2410c" : "#6b7280",
                        fontWeight: form.usagePeriod === period ? 700 : 400 }}>
                      {period}
                    </button>
                  ))}
                </div>
                {form.usagePeriod === "직접입력" && (
                  <input value={form.usagePeriodCustom}
                    onChange={e => setForm(prev => ({ ...prev, usagePeriodCustom: e.target.value }))}
                    placeholder="예: 4일, 1주일"
                    style={{ ...inputStyle, fontSize: 12, padding: "5px 8px" }} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* 통역 전용: 기본진행시간 / 초과단가 */}
        {isInterp && (
          <div style={{ background: "#faf5ff", borderRadius: 8, padding: "10px 14px", border: "1px solid #e9d5ff", marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 3 }}>기본 진행시간</label>
                <div style={{ display: "flex", gap: 4, marginBottom: 5 }}>
                  {([["2h","2시간"],["4h","반일(4h)"],["8h","종일(8h)"]] as [string,string][]).map(([val,lbl]) => (
                    <button key={val} type="button"
                      onClick={() => setForm(p => ({ ...p, interpretationDuration: val }))}
                      style={{ padding: "3px 10px", fontSize: 11, borderRadius: 5, cursor: "pointer",
                        border: `1px solid ${form.interpretationDuration === val ? "#7c3aed" : "#e9d5ff"}`,
                        background: form.interpretationDuration === val ? "#ede9fe" : "#f5f3ff",
                        color: form.interpretationDuration === val ? "#7c3aed" : "#9ca3af",
                        fontWeight: form.interpretationDuration === val ? 700 : 400 }}>
                      {lbl}
                    </button>
                  ))}
                </div>
                <input value={form.interpretationDuration} onChange={e => setForm(p => ({ ...p, interpretationDuration: e.target.value }))}
                  placeholder="예: 4h, 반일, 종일"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 3 }}>초과 단가 (1시간당)</label>
                <NumericInput value={form.overtimePrice} onChange={raw => setForm(p => ({ ...p, overtimePrice: raw }))}
                  placeholder="초과 시 적용 단가 (선택)" suffix="원"
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
                  {(p.productType === "interpretation" || p.productType === "combined")
                    ? (p.interpretationDirection === "B→A"
                        ? `${tgtLabel} → ${srcLabel}`
                        : p.interpretationDirection === "A→B"
                          ? `${srcLabel} → ${tgtLabel}`
                          : `${srcLabel} ↔ ${tgtLabel}`)
                    : `${srcLabel} → ${tgtLabel}`
                  }
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
              <span style={{ fontSize: 11, background: p.basePrice != null ? "#f0fdf4" : "#f9fafb", color: p.basePrice != null ? "#059669" : "#9ca3af", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                {p.productType === "equipment"
                  ? `${p.basePrice != null ? Number(p.basePrice).toLocaleString() + "원" : "미설정"} / ${p.quantityUnit || p.unit}${p.usagePeriod ? ` / ${p.usagePeriod}` : ""}`
                  : p.basePrice != null ? `${Number(p.basePrice).toLocaleString()}원 / ${p.unit}` : `미설정 / ${p.unit}`
                }
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
          <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "flex-start" }}>
            {hasPerm("product.manage") && (
              <button onClick={() => {
                setEditingProduct(p.id);
                setProductForm({
                  productType: p.productType,
                  sourceLanguage: p.sourceLanguage ?? "",
                  sourceLanguageCustom: "",
                  targetLanguage: p.targetLanguage ?? "",
                  targetLanguageCustom: "",
                  equipmentItem: "",
                  equipmentItemCustom: "",
                  mainCategory: p.mainCategory ?? "",
                  subCategory: p.subCategory ?? "",
                  name: p.name,
                  unit: p.unit,
                  quantityUnit: p.quantityUnit || (p.productType === "equipment" ? "개" : ""),
                  usagePeriod: p.usagePeriod || (p.productType === "equipment" ? "1일" : ""),
                  usagePeriodCustom: "",
                  interpretationDirection: p.interpretationDirection || ((p.productType === "interpretation" || p.productType === "combined") ? "양방향" : ""),
                  basePrice: p.basePrice != null ? String(p.basePrice) : "",
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
            {user?.role === "admin" && (
              <button onClick={() => setDeletingProduct({ id: p.id, code: p.code, name: p.name })}
                aria-label="상품 완전삭제"
                title="완전삭제 (복구 불가)"
                style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#1f2937", color: "#f9fafb", border: "none", fontWeight: 600 }}>
                삭제
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
            {productImporting ? "분석 중..." : "⬆ Import 미리보기"}
            <input ref={productImportRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleProductImport(f); }} />
          </label>
          <button
            onClick={() => setShowLazyPanel(v => !v)}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${showLazyPanel ? "#fcd34d" : "#e5e7eb"}`,
              background: showLazyPanel ? "#fffbeb" : "#fff",
              color: showLazyPanel ? "#92400e" : "#6b7280" }}>
            ⚡ 빠른 생성
          </button>
          {hasPerm("product.manage") && (
            <PrimaryBtn onClick={() => {
              setShowProductForm(v => !v);
              setEditingProduct(null);
              setProductForm(emptyProductForm);
              setImportPreviewData(null);
              setImportInitialData(null);
              setImportResult(null);
              setProductNameCustom(false);
              setProductDupeWarning(null);
            }} style={{ fontSize: 13, padding: "7px 14px" }}>
              {showProductForm && !editingProduct ? "취소" : "+ 상품 등록"}
            </PrimaryBtn>
          )}
        </div>
      }>
        {/* Lazy Product Generation 패널 */}
        {showLazyPanel && (
          <LazyProductPanel
            token={token}
            authHeaders={authHeaders}
            setToast={setToast}
            onProductCreated={fetchProducts}
          />
        )}

        {/* Import 등록 결과 */}
        {importResult && (
          <div style={{ background: importResult.errors.length === 0 ? "#f0fdf4" : "#fffbeb", border: `1px solid ${importResult.errors.length === 0 ? "#bbf7d0" : "#fde68a"}`, borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>✅ 신규 등록: {importResult.created}건</span>
              {importResult.errors.length > 0 && <span style={{ fontSize: 13, fontWeight: 700, color: "#dc2626" }}>⚠ 오류: {importResult.errors.length}건</span>}
            </div>
            <button onClick={() => setImportResult(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 18, lineHeight: 1 }}>×</button>
          </div>
        )}

        {/* Import Preview 패널 */}
        {importPreviewData && importInitialData && (
          <ImportPreviewPanel
            key={importInitialData.session.sessionId}
            preview={importPreviewData}
            initialRowOverrides={importInitialData.rowOverrides}
            initialSession={importInitialData.session}
            sessionRestored={importInitialData.restored}
            token={token}
            authHeaders={authHeaders}
            setToast={setToast}
            onImportSuccess={(result) => {
              setImportResult(result);
              setImportPreviewData(null);
              setImportInitialData(null);
              fetchProducts();
            }}
            onRequestClose={() => {
              setImportPreviewData(null);
              setImportInitialData(null);
            }}
          />
        )}

        {/* 등록/수정 폼 */}
        <div style={{ overflow: "hidden", maxHeight: showProductForm ? "900px" : "0", transition: "max-height 320ms cubic-bezier(0.22, 1, 0.36, 1)" }}>
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
        </div>{/* /showProductForm */}

        {/* 필터 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "flex-start" }}>
          <input value={productSearch} onChange={e => setProductSearch(e.target.value)}
            placeholder="상품명, 코드 검색..."
            style={{ ...inputStyle, maxWidth: 200, flex: "1 1 140px", padding: "8px 12px", fontSize: 13 }}
            onKeyDown={e => e.key === "Enter" && fetchProducts()} />
          <ClickSelect
            value={filterProductType}
            onChange={v => setFilterProductType(v)}
            placeholder="전체 유형"
            options={[
              { value: "", label: "전체 유형" },
              ...Object.entries(PRODUCT_TYPES_META).map(([k, v]) => ({
                value: k,
                label: `${TYPE_COLORS[k]?.icon ?? ""} ${v.label}`,
              })),
            ]}
            style={{ minWidth: 110 }}
            triggerStyle={{ padding: "8px 10px", fontSize: 13, width: "100%" }}
          />
          <select value={filterActiveOnly} onChange={e => setFilterActiveOnly(e.target.value as "" | "true" | "false")}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 100 }}>
            <option value="">전체 상태</option>
            <option value="true">✅ 활성만</option>
            <option value="false">🔴 비활성만</option>
          </select>
          <PrimaryBtn onClick={fetchProducts} disabled={productsLoading} style={{ padding: "8px 14px", fontSize: 13 }}>
            {productsLoading ? "검색 중..." : "검색"}
          </PrimaryBtn>
          {(productSearch || filterProductType || filterMainCategory || filterActiveOnly) && (
            <button onClick={() => {
              setProductSearch(""); setFilterProductType("");
              setFilterMainCategory(""); setFilterActiveOnly("");
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#d1d5db"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#6b7280"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "#e5e7eb"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#9ca3af"; }}
              style={{ padding: "8px 14px", fontSize: 13, fontWeight: 500, borderRadius: 7, border: "1px solid #9ca3af", background: "#e5e7eb", color: "#374151", cursor: "pointer", transition: "background 0.15s, border-color 0.15s" }}>
              ✕ 필터 초기화
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
        <div style={{ overflow: "hidden", maxHeight: showRequestForm ? "900px" : "0", transition: "max-height 320ms cubic-bezier(0.22, 1, 0.36, 1)" }}>
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
        </div>{/* /showRequestForm */}

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
                    {user?.role === "admin" && (
                      <div style={{ display: "flex", gap: 6, flexShrink: 0, flexDirection: "column" }}>
                        {req.status === "pending" && (
                          <>
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
                          </>
                        )}
                        <button onClick={() => setDeletingRequestId(req.id)}
                          aria-label="등록요청 삭제"
                          style={{ padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", background: "#f3f4f6", color: "#6b7280", border: "1px solid #e5e7eb", fontWeight: 600 }}>
                          🗑 요청삭제
                        </button>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      {/* 상품 등록 요청 삭제 확인 모달 */}
      {deletingRequestId !== null && (
        <div role="dialog" aria-modal="true" aria-label="상품 등록 요청 삭제 확인"
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 420, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🗑</div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>상품 등록 요청 삭제</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>삭제 후 복구 불가</p>
              </div>
            </div>
            <p style={{ margin: "0 0 6px", fontSize: 13, color: "#374151" }}>이 상품 등록 요청을 삭제하시겠습니까?</p>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
              삭제 후 복구할 수 없습니다.<br />
              이미 승인된 요청의 경우 실제 생성된 상품은 삭제되지 않습니다.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button aria-label="요청 삭제 확인" onClick={handleDeleteRequest} disabled={deletingRequestInProgress}
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: deletingRequestInProgress ? "not-allowed" : "pointer", background: deletingRequestInProgress ? "#9ca3af" : "#dc2626", color: "#fff", border: "none", fontWeight: 700 }}>
                {deletingRequestInProgress ? "삭제 중..." : "삭제 확인"}
              </button>
              <GhostBtn onClick={() => setDeletingRequestId(null)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}

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

      {/* 완전삭제 확인 모달 */}
      {deletingProduct && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 420, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#fee2e2", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🗑</div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>상품 완전삭제</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>삭제 후 복구 불가</p>
              </div>
            </div>
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 16px", marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>
                <span style={{ fontFamily: "monospace", background: "#e5e7eb", padding: "1px 6px", borderRadius: 4, marginRight: 6 }}>{deletingProduct.code}</span>
                <strong>{deletingProduct.name}</strong>
              </p>
            </div>
            <p style={{ margin: "0 0 6px", fontSize: 13, color: "#dc2626", fontWeight: 600 }}>⚠ 주의사항</p>
            <ul style={{ margin: "0 0 20px", paddingLeft: 18, fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
              <li>견적/프로젝트에 사용된 상품은 삭제할 수 없습니다.</li>
              <li>상품 코드는 삭제 후에도 재사용되지 않습니다.</li>
              <li>통번역사 단가 설정이 함께 삭제됩니다.</li>
            </ul>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handlePurgeProduct} disabled={purging}
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: purging ? "not-allowed" : "pointer", background: purging ? "#9ca3af" : "#dc2626", color: "#fff", border: "none", fontWeight: 700 }}>
                {purging ? "삭제 중..." : "완전삭제"}
              </button>
              <GhostBtn onClick={() => setDeletingProduct(null)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
