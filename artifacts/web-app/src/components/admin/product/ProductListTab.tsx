import { useState, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { api, Product, ProductOption, PRODUCT_TYPES_META } from '../../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../../ui';
import { ProductReviewPanel } from '../ProductReviewPanel';
import ImportPreviewPanel, {
  type ImportPreviewData,
  type ImportResult,
  type ReviewSessionMeta,
  type RowOverride,
  loadReviewSession,
  saveReviewSession,
  clearReviewSession,
} from '../ImportPreviewPanel';
import { ProductForm } from './ProductForm';
import { ProductCard } from './ProductCard';
import {
  type ProductFormType,
  Section, emptyProductForm, inputStyle, TYPE_COLORS, DEACTIVATION_REASONS,
  bulkBtnStyle, pageNavBtnStyle,
} from './productShared';
import { stickyBulkBarStyle } from '../bulkListShared';

interface Props {
  token: string;
  hasPerm: (perm: string) => boolean;
  setToast: (msg: string) => void;
  authHeaders: Record<string, string>;
  onNavigate: (tab: "products" | "product-register" | "product-trash") => void;
}

const PAGE_SIZE_OPTIONS = [20, 50, 100];

/** 상품목록 — 서버 페이지네이션 + 선택 기반 일괄 관리(수정/활성/비활성/선택삭제). */
export function ProductListTab({ token, hasPerm, setToast, authHeaders, onNavigate }: Props) {
  const canManage = hasPerm("product.manage");

  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productSearch, setProductSearch] = useState("");   // 입력값
  const [appliedSearch, setAppliedSearch] = useState("");   // 실제 조회에 적용된 검색어
  const [showEditForm, setShowEditForm] = useState(false);
  const [productForm, setProductForm] = useState<ProductFormType>(emptyProductForm);
  const [editingProduct, setEditingProduct] = useState<number | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [productNameCustom, setProductNameCustom] = useState(false);
  const [productDupeWarning, setProductDupeWarning] = useState<{ existing: { id: number; code: string; name: string }[] } | null>(null);
  const [productImporting, setProductImporting] = useState(false);
  const productImportRef = useRef<HTMLInputElement>(null);

  const [showReviewPanel, setShowReviewPanel] = useState(false);

  const [importPreviewData, setImportPreviewData] = useState<ImportPreviewData | null>(null);
  const [importInitialData, setImportInitialData] = useState<{
    rowOverrides: Record<number, RowOverride>;
    session: ReviewSessionMeta;
    restored: boolean;
  } | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // 필터
  const [filterProductType, setFilterProductType] = useState("");
  const [filterMainCategory, setFilterMainCategory] = useState("");
  const [filterActiveOnly, setFilterActiveOnly] = useState<"" | "true" | "false">("");

  // 페이지네이션
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // ─── 선택 기반 일괄 관리 상태 ────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkActivating, setBulkActivating] = useState(false);
  const [bulkDeactivateOpen, setBulkDeactivateOpen] = useState(false);
  const [deactivationReason, setDeactivationReason] = useState("");
  const [bulkDeactivating, setBulkDeactivating] = useState(false);
  const [bulkTrashOpen, setBulkTrashOpen] = useState(false);
  const [bulkTrashing, setBulkTrashing] = useState(false);

  const selectedCount = selectedIds.size;
  const allSelected = products.length > 0 && products.every(p => selectedIds.has(p.id)); // 현재 페이지 기준

  const fetchProducts = useCallback(async () => {
    setProductsLoading(true);
    setSelectedIds(new Set()); // 페이지/검색/필터 변경 시 선택 초기화
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (filterProductType) params.set("productType", filterProductType);
      if (filterMainCategory) params.set("mainCategory", filterMainCategory);
      if (filterActiveOnly) params.set("activeOnly", filterActiveOnly);
      if (appliedSearch) params.set("search", appliedSearch);
      const res = await fetch(api(`/api/admin/products?${params}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        if (data && Array.isArray(data.items)) {
          setProducts(data.items);
          setTotal(data.total ?? data.items.length);
          setTotalPages(data.totalPages ?? 1);
          // 서버가 page를 clamp(예: 삭제로 빈 페이지)했으면 동기화 → 자동으로 이전 페이지로
          if (typeof data.page === "number" && data.page !== page) setPage(data.page);
        } else if (Array.isArray(data)) {
          setProducts(data); setTotal(data.length); setTotalPages(1);
        }
      }
    } catch { setToast("오류: 상품 조회 실패"); }
    finally { setProductsLoading(false); }
  }, [token, appliedSearch, filterProductType, filterMainCategory, filterActiveOnly, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // page/pageSize/필터/적용검색어가 바뀌면 재조회
  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  // 마운트 시 이전 Import 세션 복원
  useEffect(() => {
    const saved = loadReviewSession();
    if (saved) {
      setImportPreviewData(saved.importPreview);
      setImportInitialData({ rowOverrides: saved.rowOverrides, session: saved.session, restored: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 검색/필터 변경 → 1페이지로 ──────────────────────────────────────────
  const applySearch = () => { setAppliedSearch(productSearch.trim()); setPage(1); };
  const resetFilters = () => {
    setProductSearch(""); setAppliedSearch("");
    setFilterProductType(""); setFilterMainCategory(""); setFilterActiveOnly("");
    setPage(1);
  };

  // ─── 선택 토글 ───────────────────────────────────────────────────────────
  const toggleSelect = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(products.map(p => p.id)));

  // ─── 상품 수정 저장 (수정 전용 — 신규 등록은 상품등록 화면에서 처리) ──────
  const handleSaveProduct = async () => {
    if (!editingProduct) return;
    const effectiveName = productForm.name.trim();
    if (!effectiveName) { setToast("상품명은 필수입니다."); return; }
    setSavingProduct(true);
    try {
      const payload = {
        name: effectiveName,
        mainCategory: productForm.mainCategory || null,
        subCategory: productForm.subCategory || null,
      };
      const res = await fetch(api(`/api/admin/products/${editingProduct}`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
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
      setToast("상품이 수정되었습니다.");
      setProductForm(emptyProductForm);
      setEditingProduct(null);
      setShowEditForm(false);
      setProductNameCustom(false);
      await fetchProducts();
    } catch { setToast("오류: 상품 저장 실패"); }
    finally { setSavingProduct(false); }
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

  // ─── 카드 클릭 → 인라인 편집 폼 채우기 ──────────────────────────────────
  const openEdit = (p: Product) => {
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
      customItemName: "",
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
    setProductDupeWarning(null);
    setShowEditForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // 상단 "수정" — 1건 선택 시에만
  const handleEditSelected = () => {
    if (selectedCount !== 1) return;
    const p = products.find(pr => selectedIds.has(pr.id));
    if (p) openEdit(p);
  };

  // ─── 일괄 활성 (선택 중 비활성 상품만 활성화) ────────────────────────────
  const handleBulkActivate = async () => {
    const targets = products.filter(p => selectedIds.has(p.id) && !p.active);
    if (targets.length === 0) { setToast("선택한 상품이 모두 활성 상태입니다."); return; }
    setBulkActivating(true);
    try {
      const results = await Promise.all(targets.map(p =>
        fetch(api(`/api/admin/products/${p.id}/toggle`), {
          method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({}),
        }).then(r => r.ok).catch(() => false)));
      const ok = results.filter(Boolean).length;
      setToast(`${ok}건 활성화되었습니다.${ok < targets.length ? ` (${targets.length - ok}건 실패)` : ""}`);
      await fetchProducts();
    } finally { setBulkActivating(false); }
  };

  // ─── 일괄 비활성 (선택 중 활성 상품만 비활성화, 사유 1회 입력) ───────────
  const handleConfirmBulkDeactivate = async () => {
    if (!deactivationReason.trim()) { setToast("비활성화 사유를 입력하세요."); return; }
    const targets = products.filter(p => selectedIds.has(p.id) && p.active);
    if (targets.length === 0) { setToast("선택한 상품이 모두 비활성 상태입니다."); setBulkDeactivateOpen(false); return; }
    setBulkDeactivating(true);
    try {
      const reason = deactivationReason.trim();
      const results = await Promise.all(targets.map(p =>
        fetch(api(`/api/admin/products/${p.id}/toggle`), {
          method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
        }).then(r => r.ok).catch(() => false)));
      const ok = results.filter(Boolean).length;
      setBulkDeactivateOpen(false);
      setDeactivationReason("");
      setToast(`${ok}건 비활성화되었습니다.${ok < targets.length ? ` (${targets.length - ok}건 실패)` : ""}`);
      await fetchProducts();
    } finally { setBulkDeactivating(false); }
  };

  // ─── 선택삭제 (일괄 휴지통 이동) ─────────────────────────────────────────
  const handleBulkTrash = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkTrashing(true);
    try {
      const results = await Promise.all(ids.map(id =>
        fetch(api(`/api/admin/products/${id}`), { method: "DELETE", headers: authHeaders })
          .then(r => r.ok).catch(() => false)));
      const ok = results.filter(Boolean).length;
      setBulkTrashOpen(false);
      setToast(`${ok}개 상품을 휴지통으로 이동했습니다.${ok < ids.length ? ` (${ids.length - ok}건 실패)` : ""}`);
      // 재조회 시 서버가 page를 clamp → 빈 페이지면 자동으로 이전 페이지로 이동
      await fetchProducts();
    } finally { setBulkTrashing(false); }
  };

  // 일괄 관리 버튼 스타일 (공통)
  const bulkBtn = (enabled: boolean, color: string, bg: string, border: string): CSSProperties =>
    bulkBtnStyle(enabled, color, bg, border, { padding: "6px 14px" });

  // 페이지 번호 윈도우 (최대 7개)
  const pageNumbers = (): number[] => {
    const maxButtons = 7;
    if (totalPages <= maxButtons) return Array.from({ length: totalPages }, (_, i) => i + 1);
    let start = Math.max(1, page - 3);
    const end = Math.min(totalPages, start + maxButtons - 1);
    start = Math.max(1, end - maxButtons + 1);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  };
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);

  const navBtn = pageNavBtnStyle;

  return (
    <>
      <Section title={`상품목록 (${total})`} action={
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
            onClick={() => setShowReviewPanel(v => !v)}
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${showReviewPanel ? "#a5b4fc" : "#e5e7eb"}`,
              background: showReviewPanel ? "#eef2ff" : "#fff",
              color: showReviewPanel ? "#4338ca" : "#6b7280" }}>
            🔍 검수 리포트
          </button>
          <button
            onClick={() => onNavigate("product-trash")}
            aria-label="휴지통"
            data-testid="product-trash-nav"
            style={{ fontSize: 12, padding: "6px 12px", borderRadius: 7, fontWeight: 600, cursor: "pointer",
              border: "1px solid #e5e7eb", background: "#fff", color: "#6b7280" }}>
            🗑 휴지통
          </button>
          {canManage && (
            <PrimaryBtn onClick={() => onNavigate("product-register")} style={{ fontSize: 13, padding: "7px 14px" }}>
              + 상품 등록
            </PrimaryBtn>
          )}
        </div>
      }>
        {/* 검수 리포트 패널 */}
        {showReviewPanel && (
          <div style={{ marginBottom: 16, padding: "12px 16px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10 }}>
            <ProductReviewPanel products={products} />
          </div>
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

        {/* 수정 폼 (인라인) */}
        <div style={{ overflow: "hidden", maxHeight: showEditForm ? "900px" : "0", transition: "max-height 320ms cubic-bezier(0.22, 1, 0.36, 1)" }}>
        {showEditForm && (
          <Card style={{ marginBottom: 16, padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>상품 수정</p>
              {editingProduct && (
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6b7280", background: "#f3f4f6", padding: "3px 8px", borderRadius: 5 }}>
                  {products.find(p => p.id === editingProduct)?.code ?? ""}
                </span>
              )}
            </div>
            <ProductForm form={productForm} setForm={setProductForm} isEdit={true}
              nameCustom={productNameCustom} setNameCustom={setProductNameCustom}
              dupeWarning={productDupeWarning} onTypeChanged={() => setProductDupeWarning(null)} />
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <PrimaryBtn onClick={handleSaveProduct} disabled={savingProduct} style={{ fontSize: 13, padding: "8px 18px" }}>
                {savingProduct ? "저장 중..." : "저장"}
              </PrimaryBtn>
              <GhostBtn onClick={() => {
                setShowEditForm(false); setEditingProduct(null);
                setProductForm(emptyProductForm); setProductDupeWarning(null);
                setProductNameCustom(false);
              }} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
            </div>
          </Card>
        )}
        </div>{/* /showEditForm */}

        {/* 필터 */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "flex-start" }}>
          <input value={productSearch} onChange={e => setProductSearch(e.target.value)}
            placeholder="상품명, 코드 검색..."
            style={{ ...inputStyle, maxWidth: 200, flex: "1 1 140px", padding: "8px 12px", fontSize: 13 }}
            onKeyDown={e => e.key === "Enter" && applySearch()} />
          <ClickSelect
            value={filterProductType}
            onChange={v => { setFilterProductType(v); setPage(1); }}
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
          <select value={filterActiveOnly} onChange={e => { setFilterActiveOnly(e.target.value as "" | "true" | "false"); setPage(1); }}
            style={{ ...inputStyle, padding: "8px 10px", fontSize: 13, minWidth: 100 }}>
            <option value="">전체 상태</option>
            <option value="true">✅ 활성만</option>
            <option value="false">🔴 비활성만</option>
          </select>
          <PrimaryBtn onClick={applySearch} disabled={productsLoading} style={{ padding: "8px 14px", fontSize: 13 }}>
            {productsLoading ? "검색 중..." : "검색"}
          </PrimaryBtn>
          {(productSearch || filterProductType || filterMainCategory || filterActiveOnly) && (
            <button onClick={resetFilters}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#d1d5db"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#6b7280"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "#e5e7eb"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#9ca3af"; }}
              style={{ padding: "8px 14px", fontSize: 13, fontWeight: 500, borderRadius: 7, border: "1px solid #9ca3af", background: "#e5e7eb", color: "#374151", cursor: "pointer", transition: "background 0.15s, border-color 0.15s" }}>
              ✕ 필터 초기화
            </button>
          )}
        </div>

        {/* 선택 기반 일괄 관리 바 */}
        {canManage && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, padding: "10px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, ...stickyBulkBarStyle }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151", cursor: "pointer", fontWeight: 600 }}>
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                aria-label="현재 페이지 전체 선택" data-testid="select-all"
                style={{ width: 16, height: 16, cursor: "pointer" }} />
              현재 페이지 전체선택
            </label>
            <span data-testid="selected-count" style={{ fontSize: 13, fontWeight: 700, color: selectedCount > 0 ? "#2563eb" : "#9ca3af" }}>
              선택 {selectedCount}건
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={handleEditSelected}
              disabled={selectedCount !== 1}
              title={selectedCount >= 2 ? "수정은 하나의 상품만 선택 가능합니다." : undefined}
              data-testid="bulk-edit"
              style={bulkBtn(selectedCount === 1, "#2563eb", "#eff6ff", "#bfdbfe")}>
              수정
            </button>
            <button
              onClick={handleBulkActivate}
              disabled={selectedCount < 1 || bulkActivating}
              data-testid="bulk-activate"
              style={bulkBtn(selectedCount >= 1 && !bulkActivating, "#059669", "#f0fdf4", "#bbf7d0")}>
              {bulkActivating ? "처리 중..." : "활성"}
            </button>
            <button
              onClick={() => { setDeactivationReason(""); setBulkDeactivateOpen(true); }}
              disabled={selectedCount < 1}
              data-testid="bulk-deactivate"
              style={bulkBtn(selectedCount >= 1, "#c2410c", "#fff7ed", "#fed7aa")}>
              비활성
            </button>
            <button
              onClick={() => setBulkTrashOpen(true)}
              disabled={selectedCount < 1}
              data-testid="bulk-trash"
              style={bulkBtn(selectedCount >= 1, "#dc2626", "#fef2f2", "#fecaca")}>
              선택삭제
            </button>
          </div>
        )}

        {/* 상품 목록 */}
        {productsLoading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
        ) : products.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 상품이 없습니다.</Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {products.map(p => (
              <ProductCard key={p.id} p={p} selectable={canManage}
                selected={selectedIds.has(p.id)} onToggleSelect={toggleSelect} onOpen={openEdit} />
            ))}
          </div>
        )}

        {/* 페이지네이션 */}
        {total > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
            <span data-testid="pagination-info" style={{ fontSize: 13, color: "#6b7280" }}>
              전체 {total}건 중 {rangeStart}–{rangeEnd}건 표시
              <span style={{ marginLeft: 8, color: "#9ca3af" }}>({total}건 / {totalPages}페이지)</span>
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                aria-label="페이지당 표시 수" data-testid="page-size"
                style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, width: "auto", minWidth: 110 }}>
                {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>페이지당 {n}건</option>)}
              </select>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button data-testid="page-prev" disabled={page <= 1}
                  onClick={() => { if (page > 1) setPage(page - 1); }} style={navBtn(page > 1)}>이전</button>
                {pageNumbers().map(n => (
                  <button key={n} data-testid={`page-${n}`} onClick={() => setPage(n)}
                    style={{
                      fontSize: 12, minWidth: 32, padding: "6px 10px", borderRadius: 7, cursor: "pointer", fontWeight: n === page ? 700 : 500,
                      border: `1px solid ${n === page ? "#2563eb" : "#e5e7eb"}`,
                      background: n === page ? "#2563eb" : "#fff",
                      color: n === page ? "#fff" : "#374151",
                    }}>
                    {n}
                  </button>
                ))}
                <button data-testid="page-next" disabled={page >= totalPages}
                  onClick={() => { if (page < totalPages) setPage(page + 1); }} style={navBtn(page < totalPages)}>다음</button>
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* 일괄 비활성화 사유 모달 */}
      {bulkDeactivateOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <Card style={{ width: 400, padding: "24px 28px" }}>
            <p style={{ margin: "0 0 4px", fontWeight: 700, fontSize: 15 }}>비활성화 사유를 입력하세요</p>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280" }}>선택한 {selectedCount}건 중 활성 상품이 일괄 비활성화됩니다.</p>
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
              <PrimaryBtn onClick={handleConfirmBulkDeactivate} disabled={bulkDeactivating} style={{ fontSize: 13 }}>
                {bulkDeactivating ? "처리 중..." : "비활성화"}
              </PrimaryBtn>
              <GhostBtn onClick={() => setBulkDeactivateOpen(false)} style={{ fontSize: 13 }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}

      {/* 선택삭제(휴지통 이동) 확인 모달 */}
      {bulkTrashOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 420, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>🗑</div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>휴지통으로 이동</p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>휴지통에서 복원할 수 있습니다</p>
              </div>
            </div>
            <p style={{ margin: "0 0 20px", fontSize: 14, color: "#374151" }}>선택한 {selectedCount}개 상품을 휴지통으로 이동하시겠습니까?</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleBulkTrash} disabled={bulkTrashing}
                data-testid="confirm-bulk-trash"
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: bulkTrashing ? "not-allowed" : "pointer", background: bulkTrashing ? "#9ca3af" : "#1f2937", color: "#fff", border: "none", fontWeight: 700 }}>
                {bulkTrashing ? "이동 중..." : "삭제"}
              </button>
              <GhostBtn onClick={() => setBulkTrashOpen(false)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
