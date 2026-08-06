import { useState, useCallback, useEffect, type CSSProperties } from 'react';
import { api, PRODUCT_TYPES_META } from '../../../lib/constants';
import { Card, GhostBtn } from '../../ui';
import { ProductForm } from './ProductForm';
import {
  type ProductFormType, type ProductRequest,
  Section, emptyProductForm, inputStyle, TYPE_COLORS, LANG_LABEL, autoName,
  selectedCardStyle, bulkBtnStyle, pageNavBtnStyle,
} from './productShared';
import { stickyBulkBarStyle } from '../bulkListShared';

interface Props {
  token: string;
  user: { role: string } | null;
  setToast: (msg: string) => void;
  authHeaders: Record<string, string>;
  onProductCreated?: () => void;
}

type StatusFilter = "all" | "pending" | "approved" | "rejected";
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const EMPTY_COUNTS = { all: 0, pending: 0, approved: 0, rejected: 0 };

/**
 * 상품 등록 요청 관리 — 선택 기반 일괄 승인/거절/삭제 + 페이지네이션.
 * 승인/거절/삭제 API·권한·상태 로직은 기존 그대로 사용한다(승인·거절은 대기 상태만 가능).
 */
export function ProductRequestSection({ token, user, setToast, authHeaders, onProductCreated }: Props) {
  const isAdmin = user?.role === "admin";

  const [requests, setRequests] = useState<ProductRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [counts, setCounts] = useState(EMPTY_COUNTS);

  // 페이지네이션
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // 등록 요청 폼
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestForm, setRequestForm] = useState<ProductFormType>({ ...emptyProductForm });
  const [requestNameCustom, setRequestNameCustom] = useState(false);
  const [submittingRequest, setSubmittingRequest] = useState(false);

  // 선택 & 일괄 처리
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkApproveOpen, setBulkApproveOpen] = useState(false);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [bulkRejecting, setBulkRejecting] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // 상세 모달
  const [detailReq, setDetailReq] = useState<ProductRequest | null>(null);

  const selectedCount = selectedIds.size;
  const selectedReqs = requests.filter(r => selectedIds.has(r.id)); // 현재 페이지 기준
  const allSelected = requests.length > 0 && requests.every(r => selectedIds.has(r.id));

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setSelectedIds(new Set()); // 페이지/필터 변경 시 선택 초기화
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(api(`/api/admin/product-requests?${params}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        if (data && Array.isArray(data.items)) {
          setRequests(data.items);
          setTotal(data.total ?? data.items.length);
          setTotalPages(data.totalPages ?? 1);
          setCounts(data.counts ?? EMPTY_COUNTS);
          if (typeof data.page === "number" && data.page !== page) setPage(data.page);
        } else if (Array.isArray(data)) {
          setRequests(data); setTotal(data.length); setTotalPages(1);
        }
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [token, statusFilter, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // ─── 선택 ────────────────────────────────────────────────────────────────
  const toggleSelect = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelectedIds(allSelected ? new Set() : new Set(requests.map(r => r.id)));

  // ─── 상품 등록 요청 제출 ─────────────────────────────────────────────────
  const handleSubmitRequest = async () => {
    const effectiveName = autoName(requestForm);
    if (!effectiveName) { setToast("상품명은 필수입니다."); return; }
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
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      const dupMsg = data.hasDuplicate ? " (중복 상품 있음 — 관리자 검토 필요)" : "";
      setToast(`요청이 제출되었습니다.${dupMsg}`);
      setRequestForm({ ...emptyProductForm });
      setRequestNameCustom(false);
      setShowRequestForm(false);
      setPage(1);
      fetchRequests();
    } catch { setToast("오류: 요청 제출 실패"); }
    finally { setSubmittingRequest(false); }
  };

  // ─── 일괄 승인 (대기 상태만) ─────────────────────────────────────────────
  const openBulkApprove = () => {
    if (selectedCount === 0) return;
    if (selectedReqs.some(r => r.status !== "pending")) {
      setToast("선택한 요청 중 승인할 수 없는 상태가 포함되어 있습니다. (대기 상태만 승인 가능)"); return;
    }
    setBulkApproveOpen(true);
  };
  const handleBulkApprove = async () => {
    const targets = selectedReqs.filter(r => r.status === "pending");
    setBulkApproving(true);
    try {
      const results = await Promise.all(targets.map(async r => {
        try {
          const res = await fetch(api(`/api/admin/product-requests/${r.id}/approve`), {
            method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
          });
          const d = await res.json().catch(() => null);
          return { r, ok: res.ok, error: d?.error as string | undefined };
        } catch { return { r, ok: false, error: "네트워크 오류" }; }
      }));
      const okCount = results.filter(x => x.ok).length;
      const fails = results.filter(x => !x.ok);
      setBulkApproveOpen(false);
      let msg = `${okCount}건 승인 완료.`;
      if (fails.length) msg += ` ${fails.length}건 실패 — ` + fails.map(f => `${f.r.name}: ${f.error ?? "실패"}`).join(" / ");
      setToast(msg);
      onProductCreated?.();
      await fetchRequests();
    } finally { setBulkApproving(false); }
  };

  // ─── 일괄 거절 (대기 상태만, 사유 필수) ──────────────────────────────────
  const openBulkReject = () => {
    if (selectedCount === 0) return;
    if (selectedReqs.some(r => r.status !== "pending")) {
      setToast("선택한 요청 중 거절할 수 없는 상태가 포함되어 있습니다. (대기 상태만 거절 가능)"); return;
    }
    setRejectReason("");
    setBulkRejectOpen(true);
  };
  const handleBulkReject = async () => {
    if (!rejectReason.trim()) { setToast("거절 사유를 입력하세요."); return; }
    const targets = selectedReqs.filter(r => r.status === "pending");
    setBulkRejecting(true);
    try {
      const reason = rejectReason.trim();
      const results = await Promise.all(targets.map(r =>
        fetch(api(`/api/admin/product-requests/${r.id}/reject`), {
          method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
        }).then(x => x.ok).catch(() => false)));
      const ok = results.filter(Boolean).length;
      setBulkRejectOpen(false);
      setRejectReason("");
      setToast(`${ok}건 거절되었습니다.${ok < targets.length ? ` (${targets.length - ok}건 실패)` : ""}`);
      await fetchRequests();
    } finally { setBulkRejecting(false); }
  };

  // ─── 선택삭제 (상태 무관 — 기존 삭제 API·권한) ──────────────────────────
  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    try {
      const results = await Promise.all(ids.map(id =>
        fetch(api(`/api/admin/product-requests/${id}`), { method: "DELETE", headers: authHeaders })
          .then(x => x.ok).catch(() => false)));
      const ok = results.filter(Boolean).length;
      setBulkDeleteOpen(false);
      setToast(`${ok}건의 상품등록 요청을 삭제했습니다.${ok < ids.length ? ` (${ids.length - ok}건 실패)` : ""}`);
      await fetchRequests();
    } finally { setBulkDeleting(false); }
  };

  // ─── 스타일 헬퍼 (공통) ──────────────────────────────────────────────────
  const bulkBtn = (enabled: boolean, color: string, bg: string, border: string): CSSProperties =>
    bulkBtnStyle(enabled, color, bg, border, { padding: "5px 12px" });
  const navBtn = pageNavBtnStyle;
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
  const countOf = (s: StatusFilter) => s === "all" ? counts.all : s === "pending" ? counts.pending : s === "approved" ? counts.approved : counts.rejected;

  return (
    <>
      <Section
        title={`상품 등록 요청 (${counts.pending}건 대기)`}
        action={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {(["all", "pending", "approved", "rejected"] as const).map(s => (
              <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }}
                style={{
                  fontSize: 12, padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontWeight: 600, border: "none",
                  background: statusFilter === s ? (s === "pending" ? "#fef3c7" : s === "approved" ? "#dcfce7" : s === "rejected" ? "#fee2e2" : "#1d4ed8") : "#f3f4f6",
                  color: statusFilter === s ? (s === "pending" ? "#92400e" : s === "approved" ? "#166534" : s === "rejected" ? "#991b1b" : "#fff") : "#6b7280",
                }}>
                {s === "all" ? "전체" : s === "pending" ? "⏳ 대기" : s === "approved" ? "✅ 승인" : "❌ 거절"} {countOf(s)}
              </button>
            ))}
            <button onClick={() => { setShowRequestForm(v => !v); setRequestForm({ ...emptyProductForm }); setRequestNameCustom(false); }}
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
            <ProductForm form={requestForm} setForm={setRequestForm} isEdit={false}
              nameCustom={requestNameCustom} setNameCustom={setRequestNameCustom} dupeWarning={null} />
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

        {/* 선택 기반 일괄 관리 바 (관리자) */}
        {isAdmin && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, padding: "9px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, ...stickyBulkBarStyle }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#374151", cursor: "pointer", fontWeight: 600 }}>
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                aria-label="현재 페이지 전체 선택" data-testid="req-select-all"
                style={{ width: 16, height: 16, cursor: "pointer" }} />
              현재 페이지 전체선택
            </label>
            <span data-testid="req-selected-count" style={{ fontSize: 13, fontWeight: 700, color: selectedCount > 0 ? "#2563eb" : "#9ca3af" }}>
              선택 {selectedCount}건
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={openBulkApprove} disabled={selectedCount < 1} data-testid="req-bulk-approve"
              style={bulkBtn(selectedCount >= 1, "#166534", "#dcfce7", "#bbf7d0")}>✅ 승인</button>
            <button onClick={openBulkReject} disabled={selectedCount < 1} data-testid="req-bulk-reject"
              style={bulkBtn(selectedCount >= 1, "#991b1b", "#fee2e2", "#fecaca")}>❌ 거절</button>
            <button onClick={() => setBulkDeleteOpen(true)} disabled={selectedCount < 1} data-testid="req-bulk-delete"
              style={bulkBtn(selectedCount >= 1, "#6b7280", "#f3f4f6", "#d1d5db")}>🗑 선택삭제</button>
          </div>
        )}

        {/* 요청 목록 */}
        {loading ? (
          <div style={{ textAlign: "center", padding: "20px 0", color: "#9ca3af", fontSize: 13 }}>불러오는 중...</div>
        ) : requests.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "24px", color: "#9ca3af", fontSize: 13 }}>요청이 없습니다.</Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {requests.map(req => {
              const tc = TYPE_COLORS[req.productType] ?? { bg: "#f9fafb", color: "#374151", icon: "📦" };
              const typeLabel = PRODUCT_TYPES_META[req.productType]?.label ?? req.productType;
              const srcLabel = req.sourceLanguage ? (LANG_LABEL[req.sourceLanguage] ?? req.sourceLanguage) : null;
              const tgtLabel = req.targetLanguage ? (LANG_LABEL[req.targetLanguage] ?? req.targetLanguage) : null;
              const selected = selectedIds.has(req.id);
              return (
                <div key={req.id} data-testid={`req-card-${req.id}`}
                  onClick={() => setDetailReq(req)}
                  style={{ display: "flex", alignItems: "stretch", gap: 10, cursor: "pointer" }}>
                  {isAdmin && (
                    <div onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", paddingLeft: 2 }}>
                      <input type="checkbox" checked={selected} onChange={() => toggleSelect(req.id)}
                        aria-label={`요청 선택: ${req.name}`} data-testid={`req-select-${req.id}`}
                        style={{ width: 16, height: 16, cursor: "pointer" }} />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Card style={{ padding: "10px 16px", background: (req.status === "pending" ? "#fffbeb" : req.status === "approved" ? "#f0fdf4" : "#fef2f2"), ...selectedCardStyle(selected) }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 2 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>{req.name}</span>
                        <span style={{ fontSize: 11, borderRadius: 4, padding: "1px 7px", fontWeight: 700, background: tc.bg, color: tc.color }}>
                          {tc.icon} {typeLabel}
                        </span>
                        {srcLabel && tgtLabel && (
                          <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 7px", fontWeight: 600 }}>
                            {srcLabel} → {tgtLabel}
                          </span>
                        )}
                        {req.mainCategory && (
                          <span style={{ fontSize: 11, background: "#ede9fe", color: "#5b21b6", borderRadius: 4, padding: "1px 7px" }}>
                            {req.mainCategory}{req.subCategory ? ` / ${req.subCategory}` : ""}
                          </span>
                        )}
                        <span style={{ fontSize: 11, borderRadius: 4, padding: "1px 7px", fontWeight: 700, background: req.status === "pending" ? "#fef3c7" : req.status === "approved" ? "#dcfce7" : "#fee2e2", color: req.status === "pending" ? "#92400e" : req.status === "approved" ? "#166534" : "#991b1b" }}>
                          {req.status === "pending" ? "⏳ 대기" : req.status === "approved" ? "✅ 승인" : "❌ 거절"}
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: 11, color: "#6b7280" }}>
                        요청자: {req.requestedByEmail ?? "-"} · {new Date(req.createdAt).toLocaleDateString("ko-KR")}
                        {req.description && ` · ${req.description}`}
                      </p>
                      {req.status === "rejected" && req.rejectionReason && (
                        <p style={{ margin: "2px 0 0", fontSize: 11, color: "#991b1b" }}>거절 사유: {req.rejectionReason}</p>
                      )}
                    </Card>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 페이지네이션 */}
        {total > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
            <span data-testid="req-pagination-info" style={{ fontSize: 13, color: "#6b7280" }}>
              전체 {total}건 중 {rangeStart}–{rangeEnd}건 표시
              <span style={{ marginLeft: 8, color: "#9ca3af" }}>({total}건 / {totalPages}페이지)</span>
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                aria-label="페이지당 표시 수" data-testid="req-page-size"
                style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, width: "auto", minWidth: 110 }}>
                {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>페이지당 {n}건</option>)}
              </select>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button data-testid="req-page-prev" disabled={page <= 1}
                  onClick={() => { if (page > 1) setPage(page - 1); }} style={navBtn(page > 1)}>이전</button>
                {pageNumbers().map(n => (
                  <button key={n} data-testid={`req-page-${n}`} onClick={() => setPage(n)}
                    style={{
                      fontSize: 12, minWidth: 32, padding: "6px 10px", borderRadius: 7, cursor: "pointer", fontWeight: n === page ? 700 : 500,
                      border: `1px solid ${n === page ? "#2563eb" : "#e5e7eb"}`,
                      background: n === page ? "#2563eb" : "#fff",
                      color: n === page ? "#fff" : "#374151",
                    }}>
                    {n}
                  </button>
                ))}
                <button data-testid="req-page-next" disabled={page >= totalPages}
                  onClick={() => { if (page < totalPages) setPage(page + 1); }} style={navBtn(page < totalPages)}>다음</button>
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* 요청 상세 모달 */}
      {detailReq && (
        <div role="dialog" aria-modal="true" aria-label="상품 등록 요청 상세"
          onClick={() => setDetailReq(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 460, padding: "24px 28px" }}>
            <div onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>{detailReq.name}</p>
                <span style={{ fontSize: 12, borderRadius: 5, padding: "2px 10px", fontWeight: 700, background: detailReq.status === "pending" ? "#fef3c7" : detailReq.status === "approved" ? "#dcfce7" : "#fee2e2", color: detailReq.status === "pending" ? "#92400e" : detailReq.status === "approved" ? "#166534" : "#991b1b" }}>
                  {detailReq.status === "pending" ? "⏳ 대기" : detailReq.status === "approved" ? "✅ 승인" : "❌ 거절"}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.9 }}>
                <div>유형: {PRODUCT_TYPES_META[detailReq.productType]?.label ?? detailReq.productType}</div>
                {(detailReq.sourceLanguage || detailReq.targetLanguage) && (
                  <div>언어: {(LANG_LABEL[detailReq.sourceLanguage ?? ""] ?? detailReq.sourceLanguage ?? "-")} → {(LANG_LABEL[detailReq.targetLanguage ?? ""] ?? detailReq.targetLanguage ?? "-")}</div>
                )}
                {detailReq.mainCategory && <div>분류: {detailReq.mainCategory}{detailReq.subCategory ? ` / ${detailReq.subCategory}` : ""}</div>}
                <div>요청자: {detailReq.requestedByEmail ?? "-"}</div>
                <div>요청일: {new Date(detailReq.createdAt).toLocaleString("ko-KR")}</div>
                {detailReq.description && <div>설명: {detailReq.description}</div>}
                {detailReq.status === "rejected" && detailReq.rejectionReason && (
                  <div style={{ color: "#991b1b" }}>거절 사유: {detailReq.rejectionReason}</div>
                )}
                {detailReq.status === "approved" && detailReq.approvedProductId && (
                  <div style={{ color: "#166534" }}>생성된 상품 ID: {detailReq.approvedProductId}</div>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
                <GhostBtn onClick={() => setDetailReq(null)} style={{ fontSize: 13, padding: "8px 18px" }}>닫기</GhostBtn>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* 일괄 승인 확인 모달 */}
      {bulkApproveOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 420, padding: "28px 32px" }}>
            <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 16, color: "#111827" }}>상품등록 요청 일괄 승인</p>
            <p style={{ margin: "0 0 20px", fontSize: 14, color: "#374151" }}>선택한 {selectedCount}건의 상품등록 요청을 승인하시겠습니까?</p>
            <p style={{ margin: "0 0 18px", fontSize: 12, color: "#6b7280" }}>승인 시 상품이 생성됩니다. 중복 등 승인 불가한 요청은 실패 사유가 표시됩니다.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleBulkApprove} disabled={bulkApproving}
                data-testid="confirm-bulk-approve"
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: bulkApproving ? "not-allowed" : "pointer", background: bulkApproving ? "#9ca3af" : "#16a34a", color: "#fff", border: "none", fontWeight: 700 }}>
                {bulkApproving ? "승인 중..." : "승인"}
              </button>
              <GhostBtn onClick={() => setBulkApproveOpen(false)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}

      {/* 일괄 거절 사유 모달 */}
      {bulkRejectOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1001 }}>
          <Card style={{ width: 420, padding: "28px 32px" }}>
            <p style={{ margin: "0 0 8px", fontWeight: 700, fontSize: 16, color: "#111827" }}>상품등록 요청 일괄 거절</p>
            <p style={{ margin: "0 0 12px", fontSize: 14, color: "#374151" }}>선택한 {selectedCount}건을 거절하시겠습니까?</p>
            <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 6 }}>거절 사유 <span style={{ color: "#dc2626" }}>*</span> (선택 요청 전체에 동일 적용)</label>
            <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
              placeholder="거절 사유를 입력하세요"
              style={{ ...inputStyle, marginBottom: 16 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleBulkReject} disabled={bulkRejecting}
                data-testid="confirm-bulk-reject"
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: bulkRejecting ? "not-allowed" : "pointer", background: bulkRejecting ? "#9ca3af" : "#dc2626", color: "#fff", border: "none", fontWeight: 700 }}>
                {bulkRejecting ? "거절 중..." : "거절확정"}
              </button>
              <GhostBtn onClick={() => setBulkRejectOpen(false)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}

      {/* 선택삭제 확인 모달 */}
      {bulkDeleteOpen && (
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
            <p style={{ margin: "0 0 6px", fontSize: 14, color: "#374151" }}>선택한 {selectedCount}건의 상품등록 요청을 삭제하시겠습니까?</p>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
              삭제 후 복구할 수 없습니다.<br />
              이미 승인된 요청의 경우 실제 생성된 상품은 삭제되지 않습니다.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button aria-label="요청 삭제 확인" onClick={handleBulkDelete} disabled={bulkDeleting}
                data-testid="confirm-bulk-delete-req"
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: bulkDeleting ? "not-allowed" : "pointer", background: bulkDeleting ? "#9ca3af" : "#dc2626", color: "#fff", border: "none", fontWeight: 700 }}>
                {bulkDeleting ? "삭제 중..." : "삭제"}
              </button>
              <GhostBtn onClick={() => setBulkDeleteOpen(false)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
