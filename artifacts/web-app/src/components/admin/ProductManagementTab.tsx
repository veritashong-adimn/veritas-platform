import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  api, Product, ProductOption,
  PRODUCT_TYPES_META, MAIN_CATEGORIES_BY_TYPE, SUB_CATEGORIES_BY_MAIN,
  LANGUAGE_CODES, UNITS_BY_PRODUCT_TYPE, PRODUCT_OPTION_TYPES,
  EQUIPMENT_QUANTITY_UNITS, EQUIPMENT_USAGE_PERIODS, INTERPRETATION_DIRECTIONS,
} from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect, NumericInput } from '../ui';
import { LanguageSearchSelect, LangCustomInput, isLangCustom } from './LanguageSearchSelect';

// ─── Review Persistence 모듈 레벨 타입 ─────────────────────────────────────
type ImportPreviewItem = {
  rowNum: number; name: string; productType: string; mainCategory: string;
  subCategory: string; sourceLanguage: string | null; targetLanguage: string | null;
  unit: string; basePrice: number | null; description: string | null;
  status: "new" | "duplicate" | "conflict" | "review";
  issues: string[]; suggestedType: string;
  duplicateOf: { code: string; name: string }[];
  analysis: { productCandidate: string; langPair: string; direction: string; difficulty: string; industry: string; industry2: string; isOptionCandidate: boolean; confidenceScore: number; reviewReasons: string[] };
};

type RowOverride = {
  reviewStatus: "pending" | "approved" | "rejected";
  rejectReason: string;
  overriddenCandidate: string | undefined;
  originalCandidate: string;
  reviewedAt?: string;
  reviewedBy?: string;
};

type ReviewSessionMeta = {
  sessionId: string;
  fileName: string;
  uploadedAt: string;
  totalRows: number;
};

type PersistedReviewSession = {
  session: ReviewSessionMeta;
  importPreview: {
    summary: { total: number; new: number; duplicate: number; conflict: number; review: number };
    items: ImportPreviewItem[];
    fileName: string;
  };
  rowOverrides: Record<number, RowOverride>;
};

// ─── localStorage 헬퍼 ────────────────────────────────────────────────────
const REVIEW_SESSION_KEY = "veritas_review_session_v1";

function loadReviewSession(): PersistedReviewSession | null {
  try {
    const raw = localStorage.getItem(REVIEW_SESSION_KEY);
    return raw ? (JSON.parse(raw) as PersistedReviewSession) : null;
  } catch { return null; }
}

function saveReviewSession(data: PersistedReviewSession): void {
  try { localStorage.setItem(REVIEW_SESSION_KEY, JSON.stringify(data)); } catch { /* storage quota */ }
}

function clearReviewSession(): void {
  try { localStorage.removeItem(REVIEW_SESSION_KEY); } catch { /* ignore */ }
}

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
  equipment:      { bg: "#fff7ed", color: "#c2410c", icon: "🔧" },
  expense:        { bg: "#fefce8", color: "#b45309", icon: "💰" },
};

// ─── 장비 대분류별 기본 수량단위 ─────────────────────────────────────────────
const EQUIP_UNIT_BY_MAIN: Record<string, string> = {
  "FM 장비":     "세트",
  "적외선 장비": "세트",
  "부스":        "부스",
  "리시버":      "개",
  "엔지니어":    "건",
  "설치/철수":   "건",
  "장비 연장":   "건",
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

  const [importPreview, setImportPreview] = useState<{
    summary: { total: number; new: number; duplicate: number; conflict: number; review: number };
    items: ImportPreviewItem[];
    fileName: string;
  } | null>(null);
  const [importPreviewFilter, setImportPreviewFilter] = useState<"all" | "new" | "duplicate" | "conflict" | "review">("all");
  const [importExecuting, setImportExecuting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; errors: { row: number; message: string }[] } | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [importPreviewSort, setImportPreviewSort] = useState<"conf_asc" | "conf_desc">("conf_asc");
  const [importQualFilter, setImportQualFilter] = useState<"all" | "review_only" | "safe_only" | "low_conf">("all");
  const [importConfirmModal, setImportConfirmModal] = useState<{ mode: "selected" | "safe" | "all"; rows: ImportPreviewItem[] } | null>(null);
  // ─── Review Workflow / Persistence 상태 ───────────────────────────────────
  const [rowOverrides, setRowOverrides] = useState<Record<number, RowOverride>>({});
  const [reviewSession, setReviewSession] = useState<ReviewSessionMeta | null>(null);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [editingRowNum, setEditingRowNum] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [importReviewFilter, setImportReviewFilter] = useState<"all" | "approved" | "rejected" | "pending" | "modified">("all");
  const [bulkConfirmModal, setBulkConfirmModal] = useState<{
    action: "approve" | "reject" | "override";
    rows: ImportPreviewItem[];
  } | null>(null);
  const [bulkRejectReason, setBulkRejectReason] = useState("");
  const [bulkOverrideValue, setBulkOverrideValue] = useState("");
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
      let sep = "→";
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
      const updated = {
        ...prev,
        productType: newType,
        mainCategory: defMain,
        subCategory: "",
        unit: defUnit,
        sourceLanguage: hasLang ? (prev.sourceLanguage || "ko") : "",
        targetLanguage: hasLang ? (prev.targetLanguage || "en") : "",
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
      setImportPreview(saved.importPreview);
      setRowOverrides(saved.rowOverrides);
      setReviewSession(saved.session);
      setSessionRestored(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── rowOverrides / importPreview 변경 시 자동 저장 ────────────────────────
  useEffect(() => {
    if (!reviewSession || !importPreview) return;
    saveReviewSession({ session: reviewSession, importPreview, rowOverrides });
  }, [reviewSession, importPreview, rowOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Bulk Review 핸들러 ─────────────────────────────────────────────────
  const executeBulkApprove = (rows: ImportPreviewItem[]) => {
    const now = new Date().toISOString();
    setRowOverrides(prev => {
      const next = { ...prev };
      rows.forEach(item => {
        const base = next[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: item.analysis?.productCandidate ?? "" };
        next[item.rowNum] = { ...base, reviewStatus: "approved", reviewedAt: now };
      });
      return next;
    });
    setBulkConfirmModal(null);
    setSelectedRows(new Set());
  };

  const executeBulkReject = (rows: ImportPreviewItem[], reason: string) => {
    const now = new Date().toISOString();
    setRowOverrides(prev => {
      const next = { ...prev };
      rows.forEach(item => {
        const base = next[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: item.analysis?.productCandidate ?? "" };
        next[item.rowNum] = { ...base, reviewStatus: "rejected", rejectReason: reason, reviewedAt: now };
      });
      return next;
    });
    setBulkConfirmModal(null);
    setBulkRejectReason("");
    setSelectedRows(new Set());
  };

  const executeBulkOverride = (rows: ImportPreviewItem[], candidate: string) => {
    setRowOverrides(prev => {
      const next = { ...prev };
      rows.forEach(item => {
        const aiOriginal = item.analysis?.productCandidate ?? "";
        const ex = next[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: aiOriginal };
        next[item.rowNum] = { ...ex, overriddenCandidate: candidate, originalCandidate: ex.originalCandidate || aiOriginal };
      });
      return next;
    });
    setBulkConfirmModal(null);
    setBulkOverrideValue("");
    setSelectedRows(new Set());
  };

  // ─── 상품 저장 ──────────────────────────────────────────────────────────
  const handleSaveProduct = async () => {
    const effectiveName = productNameCustom ? productForm.name.trim() : autoName(productForm);
    if (!effectiveName) {
      setToast("상품명은 필수입니다."); return;
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
    setImportPreview(null);
    setImportResult(null);
    setImportPreviewFilter("all");
    setSelectedRows(new Set());
    setImportPreviewSort("conf_asc");
    setImportQualFilter("all");
    setImportConfirmModal(null);
    setRowOverrides({});
    setEditingRowNum(null);
    setEditingValue("");
    setImportReviewFilter("all");
    setReviewSession(null);
    setSessionRestored(false);
    clearReviewSession();
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(api("/api/admin/products/import/preview"), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const data = await res.json();
      if (!res.ok) { setToast(data.error ?? "미리보기 실패"); return; }
      const newSession: ReviewSessionMeta = {
        sessionId: `rs_${Date.now()}`,
        fileName: data.fileName ?? file.name,
        uploadedAt: new Date().toISOString(),
        totalRows: data.summary?.total ?? 0,
      };
      setReviewSession(newSession);
      setImportPreview(data);
      saveReviewSession({ session: newSession, importPreview: data, rowOverrides: {} });
    } finally {
      setProductImporting(false);
      if (productImportRef.current) productImportRef.current.value = "";
    }
  };

  const handleProductImportExecute = async (rows: ImportPreviewItem[]) => {
    if (!importPreview || rows.length === 0) { setToast("등록 대상 항목이 없습니다."); return; }
    setImportExecuting(true);
    try {
      const res = await fetch(api("/api/admin/products/import/execute"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ rows, fileName: importPreview.fileName }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(data.error ?? "등록 실패"); return; }
      setImportResult(data);
      setImportPreview(null);
      setImportConfirmModal(null);
      setSelectedRows(new Set());
      clearReviewSession();
      setReviewSession(null);
      setSessionRestored(false);
      setRowOverrides({});
      if (data.created > 0) await fetchProducts();
      setToast(`✅ ${data.created}건 등록 완료${data.errors?.length ? ` (오류 ${data.errors.length}건)` : ""}`);
    } finally {
      setImportExecuting(false);
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
              대분류 <span style={{ color: "#dc2626" }}>*</span>
              {!isEdit && <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>(상품유형에 따라 자동 변경)</span>}
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
          {hasPerm("product.manage") && (
            <PrimaryBtn onClick={() => {
              setShowProductForm(v => !v);
              setEditingProduct(null);
              setProductForm(emptyProductForm);
              setImportPreview(null);
              setImportResult(null);
              setProductNameCustom(false);
              setProductDupeWarning(null);
            }} style={{ fontSize: 13, padding: "7px 14px" }}>
              {showProductForm && !editingProduct ? "취소" : "+ 상품 등록"}
            </PrimaryBtn>
          )}
        </div>
      }>
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
        {importPreview && (() => {
          const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
            new:       { label: "신규 등록", color: "#059669", bg: "#f0fdf4" },
            duplicate: { label: "유사 중복", color: "#d97706", bg: "#fffbeb" },
            conflict:  { label: "코드 충돌", color: "#dc2626", bg: "#fef2f2" },
            review:    { label: "검토 필요", color: "#7c3aed", bg: "#f5f3ff" },
          };
          const s = importPreview.summary;

          // 안전한 항목 판별 (status=new + reviewReasons 없음 + confidence≥60 + product확인 + 단일산업)
          const isSafe = (item: ImportPreviewItem) =>
            item.status === "new" &&
            (item.analysis?.reviewReasons ?? []).length === 0 &&
            (item.analysis?.confidenceScore ?? 0) >= 60 &&
            !item.analysis?.industry2 &&
            (item.analysis?.productCandidate ?? "") !== "";

          // 검토 워크플로우 헬퍼
          const REJECT_REASONS = ["프로젝트명", "내부업무", "Product 아님", "설명형 텍스트", "중복 의미", "운영성 항목"];
          const REVIEW_STATUS_META = {
            pending:  { label: "보류", color: "#6b7280", bg: "#f3f4f6", border: "#d1d5db" },
            approved: { label: "승인", color: "#059669", bg: "#f0fdf4", border: "#bbf7d0" },
            rejected: { label: "제외", color: "#dc2626", bg: "#fef2f2", border: "#fca5a5" },
          };
          const getReviewStatus = (item: ImportPreviewItem): "pending" | "approved" | "rejected" =>
            rowOverrides[item.rowNum]?.reviewStatus ?? "pending";
          const getEffectiveCandidate = (item: ImportPreviewItem): string => {
            const ov = rowOverrides[item.rowNum];
            return ov?.overriddenCandidate !== undefined ? ov.overriddenCandidate : (item.analysis?.productCandidate ?? "");
          };
          const setRowReviewStatus = (rowNum: number, status: "pending" | "approved" | "rejected") =>
            setRowOverrides(prev => {
              const base = prev[rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: "" };
              return { ...prev, [rowNum]: { ...base, reviewStatus: status } };
            });
          const setRowRejectReason = (rowNum: number, reason: string) =>
            setRowOverrides(prev => {
              const base = prev[rowNum] ?? { reviewStatus: "rejected" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: "" };
              return { ...prev, [rowNum]: { ...base, rejectReason: reason } };
            });
          const setRowOverrideCandidate = (rowNum: number, value: string, aiOriginal: string) =>
            setRowOverrides(prev => {
              const ex = prev[rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: aiOriginal };
              return { ...prev, [rowNum]: { ...ex, overriddenCandidate: value, originalCandidate: ex.originalCandidate || aiOriginal } };
            });

          const safeRows = importPreview.items.filter(isSafe);
          const safeAndNotRejected = importPreview.items.filter(x => isSafe(x) && getReviewStatus(x) !== "rejected");
          const allNewRows = importPreview.items.filter(x => x.status === "new");
          const allNewNotRejected = importPreview.items.filter(x => x.status === "new" && getReviewStatus(x) !== "rejected");
          const approvedCount = importPreview.items.filter(x => getReviewStatus(x) === "approved").length;
          const rejectedCount = importPreview.items.filter(x => getReviewStatus(x) === "rejected").length;
          const modifiedCount = importPreview.items.filter(x => {
            const ov = rowOverrides[x.rowNum];
            return ov?.overriddenCandidate !== undefined && ov.overriddenCandidate !== (x.analysis?.productCandidate ?? "");
          }).length;

          // 상태 탭 필터
          let filtered = importPreviewFilter === "all"
            ? importPreview.items
            : importPreview.items.filter(x => x.status === importPreviewFilter);

          // 품질 필터
          if (importQualFilter === "review_only") filtered = filtered.filter(x => !isSafe(x));
          else if (importQualFilter === "safe_only") filtered = filtered.filter(isSafe);
          else if (importQualFilter === "low_conf") filtered = filtered.filter(x => (x.analysis?.confidenceScore ?? 0) < 80);

          // 검토 상태 필터
          if (importReviewFilter === "approved") filtered = filtered.filter(x => getReviewStatus(x) === "approved");
          else if (importReviewFilter === "rejected") filtered = filtered.filter(x => getReviewStatus(x) === "rejected");
          else if (importReviewFilter === "pending") filtered = filtered.filter(x => getReviewStatus(x) === "pending");
          else if (importReviewFilter === "modified") filtered = filtered.filter(x => {
            const ov = rowOverrides[x.rowNum];
            return ov?.overriddenCandidate !== undefined && ov.overriddenCandidate !== (x.analysis?.productCandidate ?? "");
          });

          // 정렬 (기본: 낮은 confidence 먼저)
          filtered = [...filtered].sort((a, b) => {
            const ca = a.analysis?.confidenceScore ?? 0;
            const cb = b.analysis?.confidenceScore ?? 0;
            return importPreviewSort === "conf_asc" ? ca - cb : cb - ca;
          });

          const TAB_LABELS: [typeof importPreviewFilter, string, number][] = [
            ["all",       `전체 ${s.total}`,          s.total],
            ["new",       `신규 ${s.new}`,             s.new],
            ["duplicate", `유사중복 ${s.duplicate}`,   s.duplicate],
            ["conflict",  `충돌 ${s.conflict}`,        s.conflict],
            ["review",    `검토필요 ${s.review}`,      s.review],
          ];

          const allFilteredSelected = filtered.length > 0 && filtered.every(x => selectedRows.has(x.rowNum));
          const thStyle: React.CSSProperties = { position: "sticky", top: 0, zIndex: 5, padding: "6px 8px", textAlign: "left", color: "#9ca3af", fontWeight: 600, background: "#f9fafb", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap", fontSize: 11 };
          const qualBtnStyle = (k: string): React.CSSProperties => ({
            fontSize: 11, padding: "3px 9px", borderRadius: 5, border: `1px solid ${importQualFilter === k ? "#2563eb" : "#e5e7eb"}`,
            background: importQualFilter === k ? "#eff6ff" : "#fff", color: importQualFilter === k ? "#2563eb" : "#6b7280", cursor: "pointer", fontWeight: importQualFilter === k ? 700 : 400,
          });
          const sortBtnStyle = (k: string): React.CSSProperties => ({
            fontSize: 11, padding: "3px 9px", borderRadius: 5, border: `1px solid ${importPreviewSort === k ? "#7c3aed" : "#e5e7eb"}`,
            background: importPreviewSort === k ? "#f5f3ff" : "#fff", color: importPreviewSort === k ? "#7c3aed" : "#6b7280", cursor: "pointer", fontWeight: importPreviewSort === k ? 700 : 400,
          });
          const rvFilterBtnStyle = (k: string): React.CSSProperties => ({
            fontSize: 11, padding: "3px 9px", borderRadius: 5,
            border: `1px solid ${importReviewFilter === k ? "#0369a1" : "#e5e7eb"}`,
            background: importReviewFilter === k ? "#f0f9ff" : "#fff",
            color: importReviewFilter === k ? "#0369a1" : "#6b7280",
            cursor: "pointer", fontWeight: importReviewFilter === k ? 700 : 400,
          });

          return (
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 16, overflow: "hidden" }}>
              {/* 헤더 */}
              <div style={{ background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>📋 Import 미리보기</span>
                  <span style={{ fontSize: 11, color: "#6b7280", background: "#e5e7eb", borderRadius: 5, padding: "2px 7px" }}>{importPreview.fileName}</span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {/* 선택 항목만 등록 */}
                  <button
                    disabled={selectedRows.size === 0 || importExecuting}
                    onClick={() => {
                      const rows = importPreview.items.filter(x => selectedRows.has(x.rowNum));
                      if (rows.length > 0) setImportConfirmModal({ mode: "selected", rows });
                    }}
                    style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, border: "none", background: selectedRows.size > 0 ? "#2563eb" : "#e5e7eb", color: selectedRows.size > 0 ? "#fff" : "#9ca3af", cursor: selectedRows.size > 0 ? "pointer" : "not-allowed", fontWeight: 700 }}>
                    선택 {selectedRows.size}건 등록
                  </button>
                  {/* 검토필요 제외하고 등록 (제외 처리된 항목 자동 제외) */}
                  <button
                    disabled={safeAndNotRejected.length === 0 || importExecuting}
                    onClick={() => { if (safeAndNotRejected.length > 0) setImportConfirmModal({ mode: "safe", rows: safeAndNotRejected }); }}
                    style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, border: "1px solid #059669", background: safeAndNotRejected.length > 0 ? "#f0fdf4" : "#f9fafb", color: safeAndNotRejected.length > 0 ? "#059669" : "#9ca3af", cursor: safeAndNotRejected.length > 0 ? "pointer" : "not-allowed", fontWeight: 700 }}>
                    검토필요 제외 {safeAndNotRejected.length}건 등록
                  </button>
                  {/* 전체 등록 — 보조 버튼 스타일 (제외 처리된 항목 자동 제외) */}
                  <button
                    disabled={allNewNotRejected.length === 0 || importExecuting}
                    onClick={() => { if (allNewNotRejected.length > 0) setImportConfirmModal({ mode: "all", rows: allNewNotRejected }); }}
                    style={{ fontSize: 11, padding: "5px 10px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", color: allNewNotRejected.length > 0 ? "#6b7280" : "#9ca3af", cursor: allNewNotRejected.length > 0 ? "pointer" : "not-allowed", fontWeight: 500 }}>
                    전체 {allNewNotRejected.length}건
                  </button>
                  <button onClick={() => { setImportPreview(null); setSelectedRows(new Set()); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 20, lineHeight: 1, padding: "0 4px" }}>×</button>
                </div>
              </div>

              {/* 세션 복원/진행 바 */}
              {(sessionRestored || reviewSession) && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 16px", background: sessionRestored ? "#fffbeb" : "#f0f9ff", borderBottom: "1px solid #e5e7eb", fontSize: 11, gap: 8, flexWrap: "wrap" }}>
                  <span style={{ color: sessionRestored ? "#92400e" : "#0369a1" }}>
                    {sessionRestored
                      ? `📂 이전 세션 복원됨 — ${reviewSession?.fileName ?? ""} · ${reviewSession?.uploadedAt ? new Date(reviewSession.uploadedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""} · 승인 ${approvedCount} / 제외 ${rejectedCount} / 수정 ${modifiedCount}`
                      : `💾 세션 자동 저장 중 — ${reviewSession?.fileName ?? ""}`}
                  </span>
                  <button
                    onClick={() => {
                      clearReviewSession();
                      setReviewSession(null);
                      setSessionRestored(false);
                      setRowOverrides({});
                      setImportPreview(null);
                      setSelectedRows(new Set());
                    }}
                    style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid #d97706", background: "#fffbeb", color: "#92400e", cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>
                    초기화
                  </button>
                </div>
              )}

              {/* Bulk Review Toolbar — 선택 항목 있을 때만 표시 */}
              {selectedRows.size > 0 && (() => {
                const selItems = importPreview.items.filter(x => selectedRows.has(x.rowNum));
                const selApproved = selItems.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "approved").length;
                const selRejected = selItems.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "rejected").length;
                const selPending = selItems.length - selApproved - selRejected;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#1d4ed8", flexShrink: 0 }}>
                      선택 {selectedRows.size}건
                    </span>
                    <span style={{ fontSize: 11, color: "#6b7280", paddingRight: 8, borderRight: "1px solid #bfdbfe" }}>
                      승인 {selApproved} · 제외 {selRejected} · 보류 {selPending}
                    </span>
                    <button
                      onClick={() => setBulkConfirmModal({ action: "approve", rows: selItems })}
                      style={{ fontSize: 11, padding: "4px 11px", borderRadius: 5, border: "none", background: "#059669", color: "#fff", cursor: "pointer", fontWeight: 700 }}>
                      ✅ 일괄 승인
                    </button>
                    <button
                      onClick={() => { setBulkRejectReason(""); setBulkConfirmModal({ action: "reject", rows: selItems }); }}
                      style={{ fontSize: 11, padding: "4px 11px", borderRadius: 5, border: "none", background: "#dc2626", color: "#fff", cursor: "pointer", fontWeight: 700 }}>
                      🚫 일괄 제외
                    </button>
                    <button
                      onClick={() => { setBulkOverrideValue(""); setBulkConfirmModal({ action: "override", rows: selItems }); }}
                      style={{ fontSize: 11, padding: "4px 11px", borderRadius: 5, border: "1px solid #7c3aed", background: "#f5f3ff", color: "#7c3aed", cursor: "pointer", fontWeight: 700 }}>
                      ✏️ Product 일괄 수정
                    </button>
                    <button onClick={() => setSelectedRows(new Set())}
                      style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid #d1d5db", background: "#fff", color: "#9ca3af", cursor: "pointer", marginLeft: "auto" }}>
                      ✕ 선택 해제
                    </button>
                  </div>
                );
              })()}

              {/* 카운트 바 */}
              <div style={{ display: "flex", gap: 14, padding: "6px 16px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb", fontSize: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ color: "#374151" }}>신규 <strong style={{ color: "#059669" }}>{s.new}</strong></span>
                <span style={{ color: "#374151" }}>중복 <strong style={{ color: "#d97706" }}>{s.duplicate}</strong></span>
                <span style={{ color: "#374151" }}>충돌 <strong style={{ color: "#dc2626" }}>{s.conflict}</strong></span>
                <span style={{ color: "#374151" }}>검토필요 <strong style={{ color: "#7c3aed" }}>{s.review}</strong></span>
                <span style={{ color: "#374151" }}>등록가능 <strong style={{ color: "#059669" }}>{safeAndNotRejected.length}</strong></span>
                <span style={{ color: "#6b7280", fontSize: 11 }}>|</span>
                {approvedCount > 0 && <span style={{ color: "#374151" }}>승인 <strong style={{ color: "#059669" }}>{approvedCount}</strong></span>}
                {rejectedCount > 0 && <span style={{ color: "#374151" }}>제외 <strong style={{ color: "#dc2626" }}>{rejectedCount}</strong></span>}
                {modifiedCount > 0 && <span style={{ color: "#374151" }}>수정됨 <strong style={{ color: "#7c3aed" }}>{modifiedCount}</strong></span>}
                {selectedRows.size > 0 && (
                  <span style={{ color: "#374151" }}>선택됨 <strong style={{ color: "#2563eb" }}>{selectedRows.size}</strong>
                    <button onClick={() => setSelectedRows(new Set())} style={{ marginLeft: 4, fontSize: 10, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: 0 }}>✕ 해제</button>
                  </span>
                )}
              </div>

              {/* 상태 탭 */}
              <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #e5e7eb", background: "#fff", overflowX: "auto" }}>
                {TAB_LABELS.map(([key, label, count]) => count > 0 || key === "all" ? (
                  <button key={key} onClick={() => setImportPreviewFilter(key)}
                    style={{ padding: "7px 14px", fontSize: 12, fontWeight: importPreviewFilter === key ? 700 : 500, border: "none", background: "none", cursor: "pointer", color: importPreviewFilter === key ? "#2563eb" : "#6b7280", borderBottom: importPreviewFilter === key ? "2px solid #2563eb" : "2px solid transparent", whiteSpace: "nowrap" }}>
                    {label}
                  </button>
                ) : null)}
              </div>

              {/* 품질 필터 + 정렬 */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f0", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginRight: 2 }}>품질:</span>
                {(["all", "review_only", "safe_only", "low_conf"] as const).map(k => (
                  <button key={k} onClick={() => setImportQualFilter(k)} style={qualBtnStyle(k)}>
                    {k === "all" ? "전체" : k === "review_only" ? "검토필요만" : k === "safe_only" ? "등록가능만" : "신뢰도 80미만"}
                  </button>
                ))}
                <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginLeft: 8, marginRight: 2 }}>정렬:</span>
                {(["conf_asc", "conf_desc"] as const).map(k => (
                  <button key={k} onClick={() => setImportPreviewSort(k)} style={sortBtnStyle(k)}>
                    {k === "conf_asc" ? "낮은신뢰도순" : "높은신뢰도순"}
                  </button>
                ))}
              </div>
              {/* 검토 상태 필터 */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 14px", background: "#f5f7fa", borderBottom: "1px solid #eaecf0", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginRight: 2 }}>검토:</span>
                {([
                  ["all",      "전체"],
                  ["pending",  `보류${importReviewFilter === "pending" ? "" : rejectedCount + approvedCount > 0 ? ` (${importPreview.items.length - approvedCount - rejectedCount})` : ""}`],
                  ["approved", `승인${approvedCount > 0 ? ` ${approvedCount}` : ""}`],
                  ["rejected", `제외${rejectedCount > 0 ? ` ${rejectedCount}` : ""}`],
                  ["modified", `수정됨${modifiedCount > 0 ? ` ${modifiedCount}` : ""}`],
                ] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setImportReviewFilter(k)} style={rvFilterBtnStyle(k)}>{label}</button>
                ))}
              </div>

              {/* 미리보기 테이블 — 단일 scroll 컨테이너 (sticky 정상 동작) */}
              <div style={{ maxHeight: 320, overflowY: "auto", overflowX: "auto" }}>
                {filtered.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "24px 0", fontSize: 13, color: "#9ca3af" }}>해당 항목 없음</div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1200 }}>
                    <thead>
                      <tr>
                        {/* 체크박스 헤더 */}
                        <th style={{ ...thStyle, width: 32, textAlign: "center" }}>
                          <input type="checkbox" checked={allFilteredSelected}
                            onChange={e => {
                              if (e.target.checked) {
                                setSelectedRows(prev => new Set([...prev, ...filtered.map(x => x.rowNum)]));
                              } else {
                                setSelectedRows(prev => { const n = new Set(prev); filtered.forEach(x => n.delete(x.rowNum)); return n; });
                              }
                            }} />
                        </th>
                        {["행", "원본 상품명", "Product 후보", "언어쌍", "방향", "난이도", "산업", "유형", "단위", "단가", "상태", "이슈", "검토"].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((item, idx) => {
                        const sm = STATUS_META[item.status] ?? STATUS_META.review;
                        const an = item.analysis ?? { productCandidate: "", langPair: "", direction: "", difficulty: "", industry: "", industry2: "", isOptionCandidate: false, confidenceScore: 0, reviewReasons: [] };
                        const isBidir = an.direction === "bidirectional";
                        const isSelected = selectedRows.has(item.rowNum);
                        return (
                          <tr key={idx} style={{ borderBottom: "1px solid #f3f4f6", background: isSelected ? "#eff6ff" : (idx % 2 === 0 ? "#fff" : "#fafafa") }}>
                            {/* 체크박스 */}
                            <td style={{ padding: "4px 8px", textAlign: "center" }}>
                              <input type="checkbox" checked={isSelected}
                                onChange={e => setSelectedRows(prev => { const n = new Set(prev); if (e.target.checked) n.add(item.rowNum); else n.delete(item.rowNum); return n; })} />
                            </td>
                            <td style={{ padding: "4px 8px", color: "#c4c4c4", fontFamily: "monospace", fontSize: 11 }}>{item.rowNum}</td>
                            <td style={{ padding: "4px 8px", color: "#374151", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</td>
                            {/* Product 후보 — 클릭하여 inline 수정 가능 */}
                            <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                              {editingRowNum === item.rowNum ? (
                                <input
                                  autoFocus
                                  value={editingValue}
                                  onChange={e => setEditingValue(e.target.value)}
                                  onBlur={() => { setRowOverrideCandidate(item.rowNum, editingValue, an.productCandidate); setEditingRowNum(null); }}
                                  onKeyDown={e => {
                                    if (e.key === "Enter") { setRowOverrideCandidate(item.rowNum, editingValue, an.productCandidate); setEditingRowNum(null); }
                                    if (e.key === "Escape") setEditingRowNum(null);
                                  }}
                                  style={{ fontSize: 11, padding: "1px 5px", border: "1px solid #2563eb", borderRadius: 3, outline: "none", width: 90, color: "#111827" }}
                                />
                              ) : (() => {
                                const eff = getEffectiveCandidate(item);
                                const isOverridden = rowOverrides[item.rowNum]?.overriddenCandidate !== undefined;
                                return (
                                  <>
                                    <span
                                      title={isOverridden
                                        ? `AI 추천: ${an.productCandidate} → 수정: ${eff} (클릭하여 재수정)`
                                        : `AI 분석 추천값 — 클릭하여 수정`}
                                      onClick={() => { setEditingRowNum(item.rowNum); setEditingValue(eff); }}
                                      style={{
                                        fontSize: 11, cursor: "text",
                                        color: isOverridden ? "#7c3aed" : "#374151",
                                        fontWeight: isOverridden ? 700 : 500,
                                        background: isOverridden ? "#f5f3ff" : "#f3f4f6",
                                        borderRadius: 3, padding: "1px 6px",
                                        border: `1px solid ${isOverridden ? "#c4b5fd" : "#e5e7eb"}`,
                                      }}>
                                      {eff || <span style={{ color: "#c4c4c4" }}>—</span>}
                                    </span>
                                    {isOverridden && rowOverrides[item.rowNum]?.originalCandidate && rowOverrides[item.rowNum].originalCandidate !== eff && (
                                      <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1, textDecoration: "line-through", lineHeight: "13px" }}>
                                        {rowOverrides[item.rowNum].originalCandidate}
                                      </div>
                                    )}
                                  </>
                                );
                              })()}
                              {an.isOptionCandidate && (
                                <span title="동일 서비스가 여러 언어쌍/산업으로 반복 — 옵션화 가능" style={{ marginLeft: 4, fontSize: 10, color: "#6d28d9", background: "#ede9fe", borderRadius: 3, padding: "1px 4px", fontWeight: 600, cursor: "default" }}>옵션화 가능</span>
                              )}
                            </td>
                            {/* 언어쌍 */}
                            <td style={{ padding: "4px 8px", color: "#374151", whiteSpace: "nowrap", fontSize: 12 }}>{an.langPair || ""}</td>
                            {/* 방향 */}
                            <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                              {an.direction ? (
                                <span style={{ fontFamily: "monospace", fontSize: 11, color: isBidir ? "#059669" : "#6b7280", background: isBidir ? "#f0fdf4" : "#f9fafb", border: `1px solid ${isBidir ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 3, padding: "1px 5px" }}>
                                  {isBidir ? "↔" : an.direction}
                                </span>
                              ) : ""}
                            </td>
                            {/* 난이도 */}
                            <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                              {an.difficulty ? (
                                <span style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", borderRadius: 3, padding: "1px 5px" }}>{an.difficulty}</span>
                              ) : ""}
                            </td>
                            {/* 산업 */}
                            <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                              {an.industry ? (
                                <span style={{ fontSize: 11, color: "#0369a1", background: "#f0f9ff", borderRadius: 3, padding: "1px 5px" }}>{an.industry}</span>
                              ) : ""}
                              {an.industry2 ? (
                                <span title="추가 산업 감지" style={{ marginLeft: 3, fontSize: 10, color: "#64748b", background: "#f1f5f9", borderRadius: 3, padding: "1px 4px" }}>{an.industry2}</span>
                              ) : ""}
                            </td>
                            {/* 유형 */}
                            <td style={{ padding: "4px 8px", color: "#374151", whiteSpace: "nowrap", fontSize: 11 }}>
                              {item.productType}
                              {item.suggestedType && item.suggestedType !== item.productType && (
                                <span style={{ marginLeft: 3, fontSize: 10, color: "#a78bfa" }}>→{item.suggestedType}</span>
                              )}
                            </td>
                            <td style={{ padding: "4px 8px", color: "#6b7280", fontSize: 11 }}>{item.unit}</td>
                            <td style={{ padding: "4px 8px", color: "#374151", textAlign: "right", fontSize: 11 }}>{item.basePrice != null ? item.basePrice.toLocaleString() : ""}</td>
                            {/* 상태 + confidence */}
                            <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg, borderRadius: 4, padding: "1px 6px" }}>{sm.label}</span>
                              {typeof an.confidenceScore === "number" && (
                                <span title={`분석 신뢰도 ${an.confidenceScore}점`} style={{ marginLeft: 4, fontSize: 10, color: an.confidenceScore >= 80 ? "#059669" : an.confidenceScore >= 60 ? "#d97706" : "#dc2626", cursor: "default" }}>
                                  {an.confidenceScore}
                                </span>
                              )}
                            </td>
                            {/* 이슈 + 검토 사유 chip */}
                            <td style={{ padding: "4px 8px", maxWidth: 200, fontSize: 11 }}>
                              {(an.reviewReasons ?? []).map((r, i) => (
                                <span key={i} style={{ display: "inline-block", marginRight: 3, marginBottom: 2, fontSize: 10, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 3, padding: "1px 4px" }}>{r}</span>
                              ))}
                              {item.issues.filter(s => s.startsWith("유사 중복") || s.startsWith("taxonomy") || s.startsWith("단가") || s.startsWith("단위")).map((s, i) => (
                                <span key={`iss-${i}`} style={{ display: "inline-block", marginRight: 3, color: "#9ca3af" }}>{s}</span>
                              ))}
                            </td>
                            {/* 검토 상태 — 승인/보류/제외 + Reject Reason */}
                            <td style={{ padding: "4px 6px", whiteSpace: "nowrap", verticalAlign: "top" }}>
                              {(() => {
                                const rv = getReviewStatus(item);
                                const ov = rowOverrides[item.rowNum];
                                return (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                    <div style={{ display: "flex", gap: 2 }}>
                                      {(["approved", "pending", "rejected"] as const).map(st => {
                                        const meta = REVIEW_STATUS_META[st];
                                        const active = rv === st;
                                        return (
                                          <button key={st}
                                            onClick={() => setRowReviewStatus(item.rowNum, st)}
                                            style={{
                                              fontSize: 10, padding: "2px 6px", borderRadius: 4,
                                              border: `1px solid ${active ? meta.border : "#e5e7eb"}`,
                                              background: active ? meta.bg : "#fff",
                                              color: active ? meta.color : "#9ca3af",
                                              cursor: "pointer", fontWeight: active ? 700 : 400, lineHeight: "15px",
                                            }}>
                                            {meta.label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                    {rv === "rejected" && (
                                      <select
                                        value={ov?.rejectReason ?? ""}
                                        onChange={e => setRowRejectReason(item.rowNum, e.target.value)}
                                        style={{ fontSize: 10, padding: "1px 3px", border: "1px solid #fca5a5", borderRadius: 3, color: "#dc2626", background: "#fef2f2", maxWidth: 105 }}>
                                        <option value="">사유 선택</option>
                                        {REJECT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                                      </select>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          );
        })()}

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

      {/* Import 등록 확인 모달 */}
      {importConfirmModal && importPreview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1010 }}>
          <Card style={{ width: 480, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: importConfirmModal.mode === "all" ? "#fee2e2" : "#fef3c7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
                {importConfirmModal.mode === "all" ? "⚠" : "📋"}
              </div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>
                  {importConfirmModal.mode === "selected" ? "선택 항목 등록 확인" : importConfirmModal.mode === "safe" ? "검토필요 제외 등록 확인" : "전체 등록 확인"}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>등록 후 되돌리기 어렵습니다</p>
              </div>
            </div>

            {/* 통계 */}
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 16px", marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>총 Preview 항목</span>
                <strong>{importPreview.summary.total}건</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>실제 등록 대상</span>
                <strong style={{ color: "#2563eb" }}>{importConfirmModal.rows.length}건</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>제외 항목</span>
                <strong style={{ color: "#7c3aed" }}>{importPreview.summary.total - importConfirmModal.rows.length}건</strong>
              </div>
              {importConfirmModal.rows.some(x => (x.analysis?.reviewReasons ?? []).length > 0) && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626", fontWeight: 600, background: "#fef2f2", borderRadius: 6, padding: "6px 10px" }}>
                  ⚠ 등록 대상에 검토 사유가 있는 항목이 포함되어 있습니다.
                </div>
              )}
            </div>

            {/* 전체 등록 강한 경고 */}
            {importConfirmModal.mode === "all" && (
              <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                <p style={{ margin: 0, fontSize: 13, color: "#dc2626", fontWeight: 700 }}>
                  검토필요 항목까지 포함하여 전체 등록됩니다.
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "#ef4444" }}>
                  실제 운영 상품 마스터에 반영되므로 신중히 확인하세요.
                </p>
              </div>
            )}

            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
              등록 후 개별 비활성화는 가능하지만 일괄 복구는 어렵습니다.<br />
              계속 진행하시겠습니까?
            </p>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => handleProductImportExecute(importConfirmModal.rows)}
                disabled={importExecuting}
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: importExecuting ? "not-allowed" : "pointer", background: importExecuting ? "#9ca3af" : importConfirmModal.mode === "all" ? "#dc2626" : "#2563eb", color: "#fff", border: "none", fontWeight: 700 }}>
                {importExecuting ? "등록 중..." : `${importConfirmModal.rows.length}건 등록 확인`}
              </button>
              <GhostBtn onClick={() => setImportConfirmModal(null)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}

      {/* Bulk Review 확인 모달 */}
      {bulkConfirmModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1015 }}>
          <Card style={{ width: 460, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, background: bulkConfirmModal.action === "approve" ? "#dcfce7" : bulkConfirmModal.action === "reject" ? "#fee2e2" : "#f5f3ff" }}>
                {bulkConfirmModal.action === "approve" ? "✅" : bulkConfirmModal.action === "reject" ? "🚫" : "✏️"}
              </div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>
                  {bulkConfirmModal.action === "approve" ? "일괄 승인 확인" : bulkConfirmModal.action === "reject" ? "일괄 제외 확인" : "Product 일괄 수정 확인"}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>선택된 {bulkConfirmModal.rows.length}건에 적용됩니다</p>
              </div>
            </div>

            {/* 통계 */}
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>대상 항목</span>
                <strong style={{ color: bulkConfirmModal.action === "approve" ? "#059669" : bulkConfirmModal.action === "reject" ? "#dc2626" : "#7c3aed" }}>
                  {bulkConfirmModal.rows.length}건
                </strong>
              </div>
              {bulkConfirmModal.action !== "override" && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                    <span style={{ color: "#9ca3af" }}>현재 승인됨</span>
                    <span>{bulkConfirmModal.rows.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "approved").length}건</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: "#9ca3af" }}>현재 제외됨</span>
                    <span>{bulkConfirmModal.rows.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "rejected").length}건</span>
                  </div>
                </>
              )}
              {bulkConfirmModal.action === "override" && (
                <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>
                  선택된 {bulkConfirmModal.rows.length}건의 Product 후보가 아래 입력값으로 일괄 변경됩니다.<br />
                  기존 AI 추천값은 취소선으로 보존됩니다.
                </p>
              )}
            </div>

            {/* Reject: 사유 선택 (필수) */}
            {bulkConfirmModal.action === "reject" && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ margin: "0 0 7px", fontSize: 13, fontWeight: 700, color: "#dc2626" }}>⚠ 제외 사유 선택 (필수)</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {["프로젝트명", "내부업무", "Product 아님", "설명형 텍스트", "중복 의미", "운영성 항목"].map(r => (
                    <button key={r} onClick={() => setBulkRejectReason(r)}
                      style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontWeight: bulkRejectReason === r ? 700 : 400, background: bulkRejectReason === r ? "#fee2e2" : "#f9fafb", color: bulkRejectReason === r ? "#dc2626" : "#374151", border: `1px solid ${bulkRejectReason === r ? "#fca5a5" : "#e5e7eb"}` }}>
                      {r}
                    </button>
                  ))}
                </div>
                {!bulkRejectReason && (
                  <p style={{ margin: "5px 0 0", fontSize: 11, color: "#9ca3af" }}>사유를 선택해야 제외 실행이 가능합니다.</p>
                )}
              </div>
            )}

            {/* Override: 새 후보명 입력 (필수) */}
            {bulkConfirmModal.action === "override" && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>새 Product 후보명 (필수)</p>
                <input
                  autoFocus
                  value={bulkOverrideValue}
                  onChange={e => setBulkOverrideValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && bulkOverrideValue.trim()) executeBulkOverride(bulkConfirmModal.rows, bulkOverrideValue.trim());
                  }}
                  placeholder="예: 번역, 통역, 영문 교정..."
                  style={{ ...inputStyle, fontSize: 13, padding: "8px 12px", border: "1px solid #c4b5fd" }}
                />
                {!bulkOverrideValue.trim() && (
                  <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>값을 입력해야 일괄 수정이 가능합니다.</p>
                )}
              </div>
            )}

            {/* Reject 경고 */}
            {bulkConfirmModal.action === "reject" && bulkRejectReason && (
              <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 12px", marginBottom: 14 }}>
                <p style={{ margin: 0, fontSize: 12, color: "#dc2626", fontWeight: 700 }}>
                  제외된 항목은 등록 안전장치에서 자동으로 제외됩니다.
                </p>
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={
                  (bulkConfirmModal.action === "reject" && !bulkRejectReason) ||
                  (bulkConfirmModal.action === "override" && !bulkOverrideValue.trim())
                }
                onClick={() => {
                  if (bulkConfirmModal.action === "approve") executeBulkApprove(bulkConfirmModal.rows);
                  else if (bulkConfirmModal.action === "reject") executeBulkReject(bulkConfirmModal.rows, bulkRejectReason);
                  else if (bulkConfirmModal.action === "override") executeBulkOverride(bulkConfirmModal.rows, bulkOverrideValue.trim());
                }}
                style={{
                  flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, fontWeight: 700, border: "none",
                  color: "#fff",
                  cursor: (bulkConfirmModal.action === "reject" && !bulkRejectReason) || (bulkConfirmModal.action === "override" && !bulkOverrideValue.trim()) ? "not-allowed" : "pointer",
                  background: (bulkConfirmModal.action === "reject" && !bulkRejectReason) || (bulkConfirmModal.action === "override" && !bulkOverrideValue.trim())
                    ? "#9ca3af"
                    : bulkConfirmModal.action === "approve" ? "#059669" : bulkConfirmModal.action === "reject" ? "#dc2626" : "#7c3aed",
                }}>
                {bulkConfirmModal.action === "approve"
                  ? `${bulkConfirmModal.rows.length}건 승인`
                  : bulkConfirmModal.action === "reject"
                  ? `${bulkConfirmModal.rows.length}건 제외`
                  : `${bulkConfirmModal.rows.length}건 수정`}
              </button>
              <GhostBtn onClick={() => setBulkConfirmModal(null)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
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
