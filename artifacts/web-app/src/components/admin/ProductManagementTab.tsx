import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  api, Product, ProductOption,
  PRODUCT_MAIN_CATEGORIES, PRODUCT_SUB_CATEGORIES, PRODUCT_OPTION_TYPES,
} from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};

function Section({ title, sub, children, action }: { title: string; sub?: string; children: React.ReactNode; action?: React.ReactNode }) {
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

type ProductFormType = {
  serviceType: string; languagePair: string; category: string; name: string;
  mainCategory: string; subCategory: string; unit: string; basePrice: string;
  description: string; productType: string; interpretationDuration: string;
  overtimePrice: string; options: { optionType: string; optionValue: string }[];
};

type ProductRequest = {
  id: number; serviceType: string; languagePair: string; category: string;
  name: string; unit: string | null; description: string | null;
  requestedByEmail: string | null; status: "pending" | "approved" | "rejected";
  approvedProductId: number | null; rejectionReason: string | null; createdAt: string;
};

const emptyProductForm: ProductFormType = {
  serviceType: "TR", languagePair: "KOEN", category: "GEN", name: "",
  mainCategory: "", subCategory: "", unit: "건", basePrice: "", description: "",
  productType: "translation", interpretationDuration: "", overtimePrice: "", options: [],
};

const emptyRequestForm = { serviceType: "TR", languagePair: "KOEN", category: "GEN", name: "", unit: "건", description: "" };

const LANG_PAIR_OPTIONS = [
  { value: "KOEN", label: "한→영 (KOEN)" },
  { value: "ENKO", label: "영→한 (ENKO)" },
  { value: "KOCN", label: "한→중 (KOCN)" },
  { value: "KOJA", label: "한→일 (KOJA)" },
];
const CATEGORY_OPTIONS_TR = [
  { value: "GEN", label: "일반번역 (GEN)" },
  { value: "TECH", label: "기술번역 (TECH)" },
  { value: "MED", label: "의료번역 (MED)" },
  { value: "LAW", label: "법률번역 (LAW)" },
];
const CATEGORY_OPTIONS_IN = [
  { value: "SIM", label: "동시통역 (SIM)" },
  { value: "CON", label: "순차통역 (CON)" },
  { value: "MIT", label: "미팅통역 (MIT)" },
  { value: "EXH", label: "전시통역 (EXH)" },
];
const LANG_PAIR_LABEL: Record<string, string> = { KOEN: "한영", ENKO: "영한", KOCN: "한중", KOJA: "한일" };
const CATEGORY_LABEL_TR: Record<string, string> = { GEN: "일반번역", TECH: "기술번역", MED: "의료번역", LAW: "법률번역" };
const CATEGORY_LABEL_IN: Record<string, string> = { SIM: "동시통역", CON: "순차통역", MIT: "미팅통역", EXH: "전시통역" };
const DEACTIVATION_REASON_OPTIONS = ["중복 상품 정리", "사용 중단", "코드 재정비", "기타"];

function autoProductName(svc: string, lang: string, cat: string) {
  const langLabel = LANG_PAIR_LABEL[lang] ?? lang;
  if (svc === "IN") return `${langLabel} ${CATEGORY_LABEL_IN[cat] ?? cat + "통역"}`;
  return `${langLabel} ${CATEGORY_LABEL_TR[cat] ?? cat + "번역"}`;
}

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
  const [productImportResult, setProductImportResult] = useState<{ created: number; skipped: number; updated?: number; errors: { row: number; message: string }[] } | null>(null);
  const productImportRef = useRef<HTMLInputElement>(null);
  const [productRequests, setProductRequests] = useState<ProductRequest[]>([]);
  const [productRequestsLoading, setProductRequestsLoading] = useState(false);
  const [productRequestStatusFilter, setProductRequestStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">("all");
  const [requestForm, setRequestForm] = useState(emptyRequestForm);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [rejectingRequestId, setRejectingRequestId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [productServiceFilter, setProductServiceFilter] = useState<"" | "TR" | "IN">("");
  const [productLangFilter, setProductLangFilter] = useState("");
  const [productCategoryFilter, setProductCategoryFilter] = useState("");
  const [productActiveFilter, setProductActiveFilter] = useState<"" | "true" | "false">("");
  const [deactivatingProductId, setDeactivatingProductId] = useState<number | null>(null);
  const [deactivationReason, setDeactivationReason] = useState("");
  const [productDupeWarning, setProductDupeWarning] = useState<{ existing: {id: number; code: string; name: string}[] } | null>(null);

  const fetchProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const params = new URLSearchParams();
      if (productSearch.trim()) params.set("search", productSearch.trim());
      if (productServiceFilter) params.set("serviceType", productServiceFilter);
      if (productLangFilter) params.set("languagePair", productLangFilter);
      if (productCategoryFilter) params.set("category", productCategoryFilter);
      if (productActiveFilter) params.set("activeOnly", productActiveFilter);
      const res = await fetch(api(`/api/admin/products${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setProducts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 상품 조회 실패"); }
    finally { setProductsLoading(false); }
  }, [token, productSearch, productServiceFilter, productLangFilter, productCategoryFilter, productActiveFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    fetchProductRequests();
  }, [productRequestStatusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveProduct = async () => {
    if (editingProduct) {
      if (!productForm.name.trim() || !productForm.basePrice) {
        setToast("상품명, 기본단가는 필수입니다."); return;
      }
    } else {
      if (!productForm.serviceType.trim() || !productForm.languagePair.trim() || !productForm.category.trim() || !productForm.name.trim() || !productForm.basePrice) {
        setToast("서비스유형, 언어쌍, 카테고리, 상품명, 기본단가는 필수입니다."); return;
      }
    }
    setSavingProduct(true);
    try {
      const payload = editingProduct
        ? {
          name: productForm.name.trim(),
          mainCategory: productForm.mainCategory || null,
          subCategory: productForm.subCategory || null,
          unit: productForm.productType === "interpretation" ? "시간" : productForm.unit,
          basePrice: Number(productForm.basePrice),
          description: productForm.description || null,
          interpretationDuration: productForm.interpretationDuration.trim() || null,
          overtimePrice: productForm.overtimePrice ? Number(productForm.overtimePrice) : null,
          options: productForm.options.filter(o => o.optionType.trim() && o.optionValue.trim()),
        }
        : {
          serviceType: productForm.serviceType.trim().toUpperCase(),
          languagePair: productForm.languagePair.trim().toUpperCase(),
          category: productForm.category.trim().toUpperCase(),
          name: productForm.name.trim(),
          mainCategory: productForm.mainCategory || null,
          subCategory: productForm.subCategory || null,
          unit: productForm.productType === "interpretation" ? "시간" : productForm.unit,
          basePrice: Number(productForm.basePrice),
          description: productForm.description || null,
          productType: productForm.productType,
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
          setToast(`중복: 이미 같은 서비스/언어/카테고리 상품이 있습니다.`);
        } else {
          setToast(`오류: ${data.error}`);
        }
        return;
      }
      setProductDupeWarning(null);
      setToast(editingProduct ? "상품이 수정되었습니다." : `상품이 등록되었습니다. (코드: ${data.code})`);
      setProductForm(emptyProductForm);
      setEditingProduct(null);
      setShowProductForm(false);
      await fetchProducts();
    } catch { setToast("오류: 상품 저장 실패"); }
    finally { setSavingProduct(false); }
  };

  const handleSubmitRequest = async () => {
    if (!requestForm.serviceType.trim() || !requestForm.languagePair.trim() || !requestForm.category.trim() || !requestForm.name.trim()) {
      setToast("서비스유형, 언어쌍, 카테고리, 상품명은 필수입니다."); return;
    }
    setSubmittingRequest(true);
    try {
      const res = await fetch(api("/api/admin/product-requests"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: requestForm.serviceType.trim().toUpperCase(),
          languagePair: requestForm.languagePair.trim().toUpperCase(),
          category: requestForm.category.trim().toUpperCase(),
          name: requestForm.name.trim(),
          unit: requestForm.unit || "건",
          description: requestForm.description.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      const dupMsg = data.hasDuplicate ? " (중복 상품 있음 — 관리자 검토 필요)" : "";
      setToast(`상품 등록 요청이 제출되었습니다.${dupMsg}`);
      setRequestForm(emptyRequestForm);
      setShowRequestForm(false);
      fetchProductRequests();
    } catch { setToast("오류: 요청 제출 실패"); }
    finally { setSubmittingRequest(false); }
  };

  const handleApproveRequest = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/product-requests/${id}/approve`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(`승인 실패: ${data.error}`); return;
      }
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

  const handleProductExcelDownload = async (type: "template" | "export") => {
    const url = api(`/api/admin/products/${type}`);
    const res = await fetch(url, { headers: authHeaders });
    if (!res.ok) { setToast("다운로드 실패"); return; }
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = type === "template" ? "상품_템플릿.xlsx" : `상품목록_${new Date().toISOString().slice(0,10)}.xlsx`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

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
      if (data.created > 0 || data.updated > 0) await fetchProducts();
    } finally {
      setProductImporting(false);
      if (productImportRef.current) productImportRef.current.value = "";
    }
  };

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

  return (
    <>
      <Section title={`상품/단가 관리 (${products.length})`} action={
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => handleProductExcelDownload("template")}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
            📋 템플릿
          </button>
          <button onClick={() => handleProductExcelDownload("export")}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#059669", cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
            ⬇ 엑셀 내보내기
          </button>
          <label style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, border: "1px solid #bfdbfe", background: "#eff6ff", color: "#2563eb", cursor: productImporting ? "not-allowed" : "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 4, opacity: productImporting ? 0.6 : 1 }}>
            {productImporting ? "처리 중..." : "⬆ 엑셀 업로드"}
            <input ref={productImportRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleProductImport(f); }} />
          </label>
          {hasPerm("product.manage") && (
            <PrimaryBtn onClick={() => { setShowProductForm(v => !v); setEditingProduct(null); setProductForm(emptyProductForm); setProductImportResult(null); }} style={{ fontSize: 13, padding: "7px 14px" }}>
              {showProductForm && !editingProduct ? "취소" : "+ 상품 등록"}
            </PrimaryBtn>
          )}
        </div>
      }>
        {/* ── 엑셀 업로드 결과 ── */}
        {productImportResult && (
          <div style={{ background: productImportResult.errors.length === 0 ? "#f0fdf4" : "#fffbeb", border: `1px solid ${productImportResult.errors.length === 0 ? "#bbf7d0" : "#fde68a"}`, borderRadius: 10, padding: "14px 18px", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: productImportResult.errors.length > 0 ? 10 : 0 }}>
              <div style={{ display: "flex", gap: 16 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>✅ 신규 등록: {productImportResult.created}건</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#9ca3af" }}>⏭ 중복 스킵: {productImportResult.skipped ?? productImportResult.updated ?? 0}건</span>
                {productImportResult.errors.length > 0 && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#dc2626" }}>⚠ 오류: {productImportResult.errors.length}건</span>
                )}
              </div>
              <button onClick={() => setProductImportResult(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 18, lineHeight: 1 }}>×</button>
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

        {/* ── 등록/수정 폼 ── */}
        {showProductForm && (
          <Card style={{ marginBottom: 16, padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>{editingProduct ? "상품 수정" : "새 상품 등록 (코드 자동 생성)"}</p>
              {editingProduct && (
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6b7280", background: "#f3f4f6", padding: "3px 8px", borderRadius: 5 }}>
                  {products.find(p => p.id === editingProduct)?.code ?? ""}
                </span>
              )}
            </div>

            {/* 신규 상품: 서비스유형 / 언어쌍 / 카테고리 */}
            {!editingProduct && (
              <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "12px 16px", marginBottom: 12 }}>
                <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#1d4ed8" }}>코드 자동 생성 정보 <span style={{ fontWeight: 400, color: "#6b7280" }}>(등록 시 [서비스]-[언어]-[카테고리]-[번호] 형식으로 자동 부여)</span></p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>서비스 유형 <span style={{ color: "#dc2626" }}>*</span></label>
                    <select value={productForm.serviceType}
                      onChange={e => {
                        const svc = e.target.value;
                        const defCat = svc === "IN" ? "SIM" : "GEN";
                        const defUnit = svc === "IN" ? "시간" : "어절";
                        const newProdType = svc === "IN" ? "interpretation" : "translation";
                        const autoName = autoProductName(svc, productForm.languagePair, defCat);
                        setProductForm(p => ({ ...p, serviceType: svc, category: defCat, unit: defUnit, productType: newProdType, name: p.name || autoName }));
                        setProductDupeWarning(null);
                      }}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                      <option value="TR">TR — 번역</option>
                      <option value="IN">IN — 통역</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>언어쌍 <span style={{ color: "#dc2626" }}>*</span></label>
                    <select value={productForm.languagePair}
                      onChange={e => {
                        const lang = e.target.value;
                        const autoName = autoProductName(productForm.serviceType, lang, productForm.category);
                        setProductForm(p => ({ ...p, languagePair: lang, name: p.name || autoName }));
                        setProductDupeWarning(null);
                      }}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                      {LANG_PAIR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>카테고리 <span style={{ color: "#dc2626" }}>*</span></label>
                    <select value={productForm.category}
                      onChange={e => {
                        const cat = e.target.value;
                        const autoName = autoProductName(productForm.serviceType, productForm.languagePair, cat);
                        setProductForm(p => ({ ...p, category: cat, name: p.name || autoName }));
                        setProductDupeWarning(null);
                      }}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                      {(productForm.serviceType === "IN" ? CATEGORY_OPTIONS_IN : CATEGORY_OPTIONS_TR).map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {/* 중복 경고 */}
                {productDupeWarning && (
                  <div style={{ marginTop: 10, background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px" }}>
                    <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 700, color: "#92400e" }}>⚠ 동일 서비스/언어/카테고리 상품이 이미 존재합니다</p>
                    {productDupeWarning.existing.map(ex => (
                      <p key={ex.id} style={{ margin: "2px 0", fontSize: 12, color: "#92400e" }}>
                        기존 상품: <code style={{ background: "#fde68a", padding: "1px 5px", borderRadius: 3 }}>{ex.code}</code> — {ex.name}
                      </p>
                    ))}
                    <p style={{ margin: "6px 0 0", fontSize: 11, color: "#92400e" }}>다른 조합으로 변경하거나, 상품 등록 요청으로 제출하세요.</p>
                  </div>
                )}
                <p style={{ margin: "6px 0 0", fontSize: 11, color: "#6b7280" }}>
                  예) TR + KOEN + GEN → <code style={{ background: "#dbeafe", padding: "1px 4px", borderRadius: 3 }}>TR-KOEN-GEN-001</code>
                </p>
              </div>
            )}

            {/* 상품명 */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>상품명 <span style={{ color: "#dc2626" }}>*</span></label>
              <input value={productForm.name} onChange={e => setProductForm(p => ({ ...p, name: e.target.value }))}
                placeholder="예: 동시통역 서비스" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
            </div>

            {/* 상품 유형 */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 6 }}>상품 유형</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {[{ v: "translation", label: "📄 번역 (TR)", color: "#2563eb", bg: "#eff6ff" }, { v: "interpretation", label: "🎤 통역 (IN)", color: "#7c3aed", bg: "#f5f3ff" }].map(({ v, label, color, bg }) => (
                  <div key={v} style={{ padding: "6px 18px", fontSize: 13, fontWeight: 700, borderRadius: 8,
                    border: `2px solid ${productForm.productType === v ? color : "#e5e7eb"}`,
                    background: productForm.productType === v ? bg : "#f9fafb",
                    color: productForm.productType === v ? color : "#9ca3af" }}>
                    {label}
                  </div>
                ))}
                {!editingProduct && <span style={{ fontSize: 11, color: "#9ca3af" }}>← 서비스유형 선택으로 자동 결정</span>}
              </div>
            </div>

            {/* 대분류 / 중분류 / 단위 or 기본기간 / 기본단가 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0 12px", marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>대분류</label>
                <ClickSelect
                  value={productForm.mainCategory}
                  onChange={v => setProductForm(p => ({ ...p, mainCategory: v, subCategory: "" }))}
                  style={{ width: "100%" }}
                  triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  options={[{ value: "", label: "선택" }, ...PRODUCT_MAIN_CATEGORIES.map(c => ({ value: c, label: c }))]}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>중분류</label>
                <ClickSelect
                  value={productForm.subCategory}
                  onChange={v => setProductForm(p => ({ ...p, subCategory: v }))}
                  style={{ width: "100%", opacity: productForm.mainCategory ? 1 : 0.5, pointerEvents: productForm.mainCategory ? undefined : "none" }}
                  triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  options={[{ value: "", label: "선택" }, ...(PRODUCT_SUB_CATEGORIES[productForm.mainCategory] ?? []).map(s => ({ value: s, label: s }))]}
                />
              </div>
              {productForm.productType === "interpretation" ? (
                <div>
                  <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 3 }}>기본 진행시간 (예: 4h)</label>
                  <input value={productForm.interpretationDuration} onChange={e => setProductForm(p => ({ ...p, interpretationDuration: e.target.value }))}
                    placeholder="예: 4h, 반일, 종일"
                    style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
                </div>
              ) : (
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>단위</label>
                  <select value={productForm.unit}
                    onChange={e => setProductForm(p => ({ ...p, unit: e.target.value }))}
                    style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                    {(productForm.serviceType === "IN" ? ["시간"] : ["어절", "글자", "페이지", "건"]).map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>기본단가 <span style={{ color: "#dc2626" }}>*</span></label>
                <input value={productForm.basePrice} onChange={e => setProductForm(p => ({ ...p, basePrice: e.target.value }))}
                  type="number" min="0" placeholder="0"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
              </div>
            </div>

            {/* 초과 단가 (통역 전용) */}
            {productForm.productType === "interpretation" && (
              <div style={{ marginBottom: 12, background: "#faf5ff", borderRadius: 8, padding: "10px 14px", border: "1px solid #e9d5ff" }}>
                <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 3 }}>초과 단가 (1시간당)</label>
                <input value={productForm.overtimePrice} onChange={e => setProductForm(p => ({ ...p, overtimePrice: e.target.value }))}
                  type="number" min="0" placeholder="기본 시간 초과 시 적용 단가 (선택)"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
              </div>
            )}

            {/* 설명 */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>설명 (선택)</label>
              <input value={productForm.description} onChange={e => setProductForm(p => ({ ...p, description: e.target.value }))}
                placeholder="상품에 대한 간단한 설명" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
            </div>

            {/* 옵션 섹션 */}
            <div style={{ background: "#f9fafb", borderRadius: 10, padding: "14px 16px", border: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#374151" }}>옵션 설정 <span style={{ fontWeight: 400, color: "#9ca3af", fontSize: 12 }}>(언어, 방식, 시간 등)</span></p>
                <button onClick={() => setProductForm(p => ({ ...p, options: [...p.options, { optionType: "언어", optionValue: "" }] }))}
                  style={{ fontSize: 12, color: "#2563eb", background: "none", border: "1px solid #bfdbfe", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontWeight: 600 }}>
                  + 옵션 추가
                </button>
              </div>
              {productForm.options.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "#9ca3af", textAlign: "center" }}>옵션이 없습니다. 필요 시 추가하세요.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {productForm.options.map((opt, idx) => (
                    <div key={idx} style={{ display: "grid", gridTemplateColumns: "140px 1fr 32px", gap: 8, alignItems: "center" }}>
                      <ClickSelect
                        value={opt.optionType}
                        onChange={v => setProductForm(p => ({ ...p, options: p.options.map((o, i) => i === idx ? { ...o, optionType: v } : o) }))}
                        triggerStyle={{ fontSize: 13, padding: "6px 8px", borderRadius: 7, width: "100%" }}
                        options={PRODUCT_OPTION_TYPES.map(t => ({ value: t, label: t }))}
                      />
                      <input value={opt.optionValue} onChange={e => setProductForm(p => ({ ...p, options: p.options.map((o, i) => i === idx ? { ...o, optionValue: e.target.value } : o) }))}
                        placeholder={opt.optionType === "언어" ? "예: 한→영, 한→일" : opt.optionType === "방식" ? "예: 동시, 순차" : "예: 4시간, 8시간"}
                        style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                      <button onClick={() => setProductForm(p => ({ ...p, options: p.options.filter((_, i) => i !== idx) }))}
                        style={{ background: "none", border: "1px solid #fca5a5", borderRadius: 6, width: 32, height: 32, cursor: "pointer", color: "#ef4444", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <PrimaryBtn onClick={handleSaveProduct} disabled={savingProduct} style={{ fontSize: 13, padding: "8px 18px" }}>
                {savingProduct ? "저장 중..." : "저장"}
              </PrimaryBtn>
              <GhostBtn onClick={() => { setShowProductForm(false); setEditingProduct(null); setProductForm(emptyProductForm); }} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
            </div>
          </Card>
        )}

        {/* ── 검색 + 필터 ── */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
          <input value={productSearch} onChange={e => setProductSearch(e.target.value)}
            placeholder="상품명, 코드 검색..."
            style={{ ...inputStyle, maxWidth: 220, flex: "1 1 160px", padding: "8px 12px", fontSize: 13 }}
            onKeyDown={e => e.key === "Enter" && fetchProducts()} />
          <select value={productServiceFilter} onChange={e => setProductServiceFilter(e.target.value as "" | "TR" | "IN")}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 110 }}>
            <option value="">전체 유형</option>
            <option value="TR">📄 번역 (TR)</option>
            <option value="IN">🎤 통역 (IN)</option>
          </select>
          <select value={productLangFilter} onChange={e => setProductLangFilter(e.target.value)}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 130 }}>
            <option value="">전체 언어</option>
            {LANG_PAIR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={productCategoryFilter} onChange={e => setProductCategoryFilter(e.target.value)}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 130 }}>
            <option value="">전체 카테고리</option>
            <optgroup label="번역">
              {CATEGORY_OPTIONS_TR.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
            <optgroup label="통역">
              {CATEGORY_OPTIONS_IN.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          </select>
          <select value={productActiveFilter} onChange={e => setProductActiveFilter(e.target.value as "" | "true" | "false")}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 110 }}>
            <option value="">전체 상태</option>
            <option value="true">✅ 활성만</option>
            <option value="false">🔴 비활성만</option>
          </select>
          <PrimaryBtn onClick={fetchProducts} disabled={productsLoading} style={{ padding: "8px 14px", fontSize: 13 }}>
            {productsLoading ? "검색 중..." : "검색"}
          </PrimaryBtn>
          {(productSearch || productServiceFilter || productLangFilter || productCategoryFilter || productActiveFilter) && (
            <button onClick={() => { setProductSearch(""); setProductServiceFilter(""); setProductLangFilter(""); setProductCategoryFilter(""); setProductActiveFilter(""); }}
              style={{ padding: "8px 12px", fontSize: 12, borderRadius: 7, border: "1px solid #e5e7eb", background: "#f3f4f6", color: "#6b7280", cursor: "pointer" }}>
              필터 초기화
            </button>
          )}
        </div>

        {/* ── 상품 목록 ── */}
        {productsLoading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
        ) : products.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 상품이 없습니다.</Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {products.map(p => (
              <Card key={p.id} style={{ padding: "14px 18px", opacity: p.active ? 1 : 0.6 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "#9ca3af", background: "#f3f4f6", padding: "1px 6px", borderRadius: 4 }}>{p.code}</span>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{p.name}</span>
                      <span style={{ fontSize: 11, borderRadius: 5, padding: "2px 8px", fontWeight: 700, background: p.productType === "interpretation" ? "#f5f3ff" : "#eff6ff", color: p.productType === "interpretation" ? "#7c3aed" : "#2563eb" }}>
                        {p.productType === "interpretation" ? "🎤 통역" : "📄 번역"}
                      </span>
                      {!p.active && <span style={{ fontSize: 11, background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>비활성</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                      {p.languagePair && (
                        <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                          {LANG_PAIR_LABEL[p.languagePair] ?? p.languagePair}
                        </span>
                      )}
                      {p.category && (
                        <span style={{ fontSize: 11, background: "#ede9fe", color: "#5b21b6", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                          {(p.productType === "interpretation" ? CATEGORY_LABEL_IN : CATEGORY_LABEL_TR)[p.category] ?? p.category}
                        </span>
                      )}
                      <span style={{ fontSize: 11, background: "#f0fdf4", color: "#059669", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                        {Number(p.basePrice).toLocaleString()}원 / {p.unit}
                      </span>
                      {p.productType === "interpretation" && p.interpretationDuration && (
                        <span style={{ fontSize: 11, background: "#faf5ff", color: "#7c3aed", borderRadius: 5, padding: "2px 8px" }}>기본 {p.interpretationDuration}</span>
                      )}
                      {p.productType === "interpretation" && p.overtimePrice != null && (
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
                          serviceType: "TR", languagePair: "KOEN", category: "GEN",
                          name: p.name,
                          mainCategory: p.mainCategory ?? "",
                          subCategory: p.subCategory ?? "",
                          unit: p.unit, basePrice: String(p.basePrice),
                          description: p.description ?? "",
                          productType: p.productType ?? "translation",
                          interpretationDuration: p.interpretationDuration ?? "",
                          overtimePrice: p.overtimePrice != null ? String(p.overtimePrice) : "",
                          options: (p.options ?? []).map((o: ProductOption) => ({ optionType: o.optionType, optionValue: o.optionValue })),
                        });
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
            ))}
          </div>
        )}
      </Section>

      {/* ── 상품 등록 요청 섹션 ── */}
      <Section
        title={`상품 등록 요청 (${productRequests.filter(r => r.status === "pending").length}건 대기)`}
        action={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["all","pending","approved","rejected"] as const).map(s => (
              <button key={s} onClick={() => setProductRequestStatusFilter(s)}
                style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontWeight: 600, border: "none",
                  background: productRequestStatusFilter === s ? (s === "pending" ? "#fef3c7" : s === "approved" ? "#dcfce7" : s === "rejected" ? "#fee2e2" : "#1d4ed8") : "#f3f4f6",
                  color: productRequestStatusFilter === s ? (s === "pending" ? "#92400e" : s === "approved" ? "#166534" : s === "rejected" ? "#991b1b" : "#fff") : "#6b7280",
                }}>
                {s === "all" ? "전체" : s === "pending" ? "⏳ 대기" : s === "approved" ? "✅ 승인" : "❌ 거절"}
              </button>
            ))}
            <button onClick={() => { setShowRequestForm(v => !v); setRequestForm(emptyRequestForm); }}
              style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontWeight: 700,
                background: showRequestForm ? "#f3f4f6" : "#faf5ff", color: showRequestForm ? "#6b7280" : "#7c3aed",
                border: "1px solid #e9d5ff" }}>
              {showRequestForm ? "취소" : "+ 등록 요청"}
            </button>
          </div>
        }>

        {/* ── 요청 폼 ── */}
        {showRequestForm && (
          <Card style={{ marginBottom: 14, padding: "18px 22px", border: "1px solid #e9d5ff", background: "#faf5ff" }}>
            <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#6d28d9" }}>상품 등록 요청 <span style={{ fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>— 관리자 승인 후 자동 코드 부여</span></p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px", marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>서비스 유형 <span style={{ color: "#dc2626" }}>*</span></label>
                <select value={requestForm.serviceType}
                  onChange={e => {
                    const svc = e.target.value;
                    const defCat = svc === "IN" ? "SIM" : "GEN";
                    const defUnit = svc === "IN" ? "시간" : "어절";
                    const autoName = autoProductName(svc, requestForm.languagePair, defCat);
                    setRequestForm(p => ({ ...p, serviceType: svc, category: defCat, unit: defUnit, name: p.name || autoName }));
                  }}
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                  <option value="TR">TR — 번역</option>
                  <option value="IN">IN — 통역</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>언어쌍 <span style={{ color: "#dc2626" }}>*</span></label>
                <select value={requestForm.languagePair}
                  onChange={e => {
                    const lang = e.target.value;
                    const autoName = autoProductName(requestForm.serviceType, lang, requestForm.category);
                    setRequestForm(p => ({ ...p, languagePair: lang, name: p.name || autoName }));
                  }}
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                  {LANG_PAIR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>카테고리 <span style={{ color: "#dc2626" }}>*</span></label>
                <select value={requestForm.category}
                  onChange={e => {
                    const cat = e.target.value;
                    const autoName = autoProductName(requestForm.serviceType, requestForm.languagePair, cat);
                    setRequestForm(p => ({ ...p, category: cat, name: p.name || autoName }));
                  }}
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                  {(requestForm.serviceType === "IN" ? CATEGORY_OPTIONS_IN : CATEGORY_OPTIONS_TR).map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ background: "#f5f3ff", borderRadius: 8, padding: "8px 12px", marginBottom: 10, fontSize: 12, color: "#5b21b6" }}>
              예상 코드: <code style={{ fontFamily: "monospace", fontWeight: 700, background: "#ede9fe", padding: "2px 6px", borderRadius: 3 }}>
                {requestForm.serviceType}-{requestForm.languagePair}-{requestForm.category}-???
              </code>
              <span style={{ color: "#9ca3af" }}> (승인 시 자동 부여)</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0 12px", marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>상품명 <span style={{ color: "#dc2626" }}>*</span></label>
                <input value={requestForm.name} onChange={e => setRequestForm(p => ({ ...p, name: e.target.value }))}
                  placeholder={`예: ${autoProductName(requestForm.serviceType, requestForm.languagePair, requestForm.category)}`}
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>단위</label>
                <select value={requestForm.unit}
                  onChange={e => setRequestForm(p => ({ ...p, unit: e.target.value }))}
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                  {(requestForm.serviceType === "IN" ? ["시간"] : ["어절", "글자", "페이지", "건"]).map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 3 }}>요청 사유 / 설명 (선택)</label>
              <input value={requestForm.description} onChange={e => setRequestForm(p => ({ ...p, description: e.target.value }))}
                placeholder="신규 상품이 필요한 이유나 설명을 입력하세요"
                style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleSubmitRequest} disabled={submittingRequest}
                style={{ padding: "7px 18px", fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: submittingRequest ? "not-allowed" : "pointer",
                  background: "#7c3aed", color: "#fff", border: "none", opacity: submittingRequest ? 0.6 : 1 }}>
                {submittingRequest ? "제출 중..." : "요청 제출"}
              </button>
              <button onClick={() => { setShowRequestForm(false); setRequestForm(emptyRequestForm); }}
                style={{ padding: "7px 14px", fontSize: 13, borderRadius: 8, cursor: "pointer", background: "none", border: "1px solid #d1d5db", color: "#6b7280" }}>
                취소
              </button>
            </div>
          </Card>
        )}

        {/* ── 요청 목록 ── */}
        {productRequestsLoading ? (
          <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
        ) : productRequests.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "24px", color: "#9ca3af", fontSize: 14 }}>
            {productRequestStatusFilter === "pending" ? "대기 중인 요청이 없습니다." : "상품 등록 요청이 없습니다."}
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {productRequests.map(req => (
              <Card key={req.id} style={{ padding: "14px 18px", borderLeft: `4px solid ${req.status === "pending" ? "#f59e0b" : req.status === "approved" ? "#10b981" : "#ef4444"}` }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                        background: req.status === "pending" ? "#fef3c7" : req.status === "approved" ? "#dcfce7" : "#fee2e2",
                        color: req.status === "pending" ? "#92400e" : req.status === "approved" ? "#166534" : "#991b1b" }}>
                        {req.status === "pending" ? "⏳ 대기" : req.status === "approved" ? "✅ 승인" : "❌ 거절"}
                      </span>
                      <code style={{ fontFamily: "monospace", fontSize: 12, color: "#7c3aed", background: "#f5f3ff", padding: "2px 7px", borderRadius: 4 }}>
                        {req.serviceType}-{req.languagePair}-{req.category}-???
                      </code>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{req.name}</span>
                      {req.unit && <span style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", padding: "1px 6px", borderRadius: 4 }}>/{req.unit}</span>}
                    </div>
                    {req.description && (
                      <p style={{ margin: "0 0 4px", fontSize: 12, color: "#6b7280" }}>{req.description}</p>
                    )}
                    <div style={{ display: "flex", gap: 10, fontSize: 11, color: "#9ca3af" }}>
                      <span>요청자: {req.requestedByEmail ?? "알 수 없음"}</span>
                      <span>·</span>
                      <span>{new Date(req.createdAt).toLocaleDateString("ko-KR")}</span>
                      {req.status === "approved" && req.approvedProductId && (
                        <span style={{ color: "#059669", fontWeight: 600 }}>· 상품 #{req.approvedProductId} 생성됨</span>
                      )}
                      {req.status === "rejected" && req.rejectionReason && (
                        <span style={{ color: "#dc2626" }}>· 거절 사유: {req.rejectionReason}</span>
                      )}
                    </div>
                  </div>

                  {user?.role === "admin" && req.status === "pending" && (
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <button onClick={() => handleApproveRequest(req.id)}
                        style={{ padding: "5px 12px", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer",
                          background: "#dcfce7", color: "#166534", border: "none" }}>
                        승인
                      </button>
                      <button onClick={() => { setRejectingRequestId(req.id); setRejectReason(""); }}
                        style={{ padding: "5px 12px", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer",
                          background: "#fee2e2", color: "#991b1b", border: "none" }}>
                        거절
                      </button>
                    </div>
                  )}
                </div>

                {rejectingRequestId === req.id && (
                  <div style={{ marginTop: 10, padding: "10px 14px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8 }}>
                    <label style={{ fontSize: 12, color: "#92400e", display: "block", marginBottom: 4 }}>거절 사유 (선택)</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                        placeholder="거절 사유를 입력하세요 (생략 가능)"
                        style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "6px 10px" }} />
                      <button onClick={() => handleRejectRequest(req.id)}
                        style={{ padding: "6px 14px", fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer",
                          background: "#ef4444", color: "#fff", border: "none", whiteSpace: "nowrap" }}>
                        거절 확정
                      </button>
                      <button onClick={() => setRejectingRequestId(null)}
                        style={{ padding: "6px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                          background: "none", border: "1px solid #d1d5db", color: "#6b7280" }}>
                        취소
                      </button>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      {/* ── 비활성화 사유 모달 ── */}
      {deactivatingProductId !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 16, padding: "28px 32px", width: 420, maxWidth: "94vw", boxShadow: "0 16px 48px rgba(0,0,0,0.22)" }}>
            <p style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, color: "#111827" }}>상품 비활성화</p>
            <p style={{ margin: "0 0 18px", fontSize: 13, color: "#6b7280" }}>
              비활성화 사유를 선택하거나 직접 입력하세요. 이 정보는 상품 카드에 표시됩니다.
            </p>
            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 6, fontWeight: 600 }}>비활성화 사유 <span style={{ color: "#dc2626" }}>*</span></label>
            <select value={DEACTIVATION_REASON_OPTIONS.includes(deactivationReason) ? deactivationReason : (deactivationReason ? "__custom__" : "")}
              onChange={e => {
                if (e.target.value === "__custom__") {
                  setDeactivationReason("");
                } else {
                  setDeactivationReason(e.target.value);
                }
              }}
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, color: "#111827", outline: "none", boxSizing: "border-box", marginBottom: 10 }}>
              <option value="">사유를 선택하세요</option>
              {DEACTIVATION_REASON_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
              <option value="__custom__">직접 입력...</option>
            </select>
            {(!DEACTIVATION_REASON_OPTIONS.includes(deactivationReason) || deactivationReason === "") && (
              <input value={deactivationReason}
                onChange={e => setDeactivationReason(e.target.value)}
                placeholder="직접 입력 (예: 가격 재조정 필요)"
                style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 16 }} />
            )}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => { setDeactivatingProductId(null); setDeactivationReason(""); }}
                style={{ padding: "9px 18px", fontSize: 13, borderRadius: 8, cursor: "pointer", background: "none", border: "1px solid #d1d5db", color: "#6b7280" }}>
                취소
              </button>
              <button onClick={handleConfirmDeactivate}
                style={{ padding: "9px 20px", fontSize: 13, fontWeight: 700, borderRadius: 8, cursor: "pointer", background: "#dc2626", color: "#fff", border: "none" }}>
                비활성화 확인
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
