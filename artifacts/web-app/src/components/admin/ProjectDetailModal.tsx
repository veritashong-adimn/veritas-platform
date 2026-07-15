import React, { useState, useEffect, useRef } from 'react';
import { api, ProjectDetail, MatchCandidate, getActionLabel, COMM_TYPE_LABEL, COMM_TYPE_COLOR, STATUS_LABEL, PROJECT_STATUS_TRANSITIONS, ALL_FINANCIAL_STATUSES, FINANCIAL_STATUS_LABEL, FINANCIAL_STATUS_STYLE, AdminUser, BOARD_CATEGORY_LABEL, Product } from '../../lib/constants';
import { StatusBadge, PrimaryBtn, GhostBtn, ClickSelect, NumericInput } from '../ui';
import { ReviewMemoPanel } from './ReviewMemoPanel';
import { DraggableModal } from './DraggableModal';
import { QuoteEditorWorkspace } from './QuoteEditorWorkspace';
import TransactionStatementModal from './TransactionStatementModal';
import { buildQuotePdfData, type QuoteDetail } from '../../lib/quotePdf';

/* ────── SearchableSelect (거래처 검색용 공통 컴포넌트) ────── */
type SSItem = { id: number; label: string; sub?: string };
function BillingSearchableSelect({ items, value, onChange, placeholder, accentBorder = "#6366f1" }: {
  items: SSItem[]; value: number | null; onChange: (id: number | null) => void;
  placeholder?: string; accentBorder?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [debounced, setDebounced] = React.useState("");
  const [highlightIdx, setHighlightIdx] = React.useState(-1);
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { const t = setTimeout(() => setDebounced(query), 200); return () => clearTimeout(t); }, [query]);
  React.useEffect(() => { const h = () => setOpen(false); document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const selected = value != null ? items.find(i => i.id === value) : null;
  const q = debounced.toLowerCase();
  const filtered = (q ? items.filter(i => i.label.toLowerCase().includes(q) || (i.sub ?? "").toLowerCase().includes(q)) : items).slice(0, 30);
  const displayValue = open ? query : (selected?.label ?? "");
  React.useEffect(() => { if (!open || highlightIdx < 0 || !listRef.current) return; (listRef.current.children[highlightIdx] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" }); }, [highlightIdx, open]);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlightIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") { e.preventDefault(); if (highlightIdx >= 0 && highlightIdx < filtered.length) { onChange(filtered[highlightIdx].id); setQuery(""); setOpen(false); setHighlightIdx(-1); } }
  };
  return (
    <div style={{ position: "relative" }} onMouseDown={e => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", border: `1px solid ${open ? accentBorder : "#d1d5db"}`, borderRadius: 7, background: "#fff", transition: "border-color 0.12s" }}>
        <input value={displayValue} onChange={e => { setQuery(e.target.value); setOpen(true); setHighlightIdx(-1); }}
          onFocus={() => { setOpen(true); if (selected) setQuery(""); }} onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "이름으로 검색..."}
          style={{ flex: 1, padding: "6px 10px", fontSize: 12, border: "none", outline: "none", background: "transparent", borderRadius: 7, minWidth: 0 }} />
        {value != null && (
          <button type="button" onClick={() => { onChange(null); setQuery(""); setOpen(false); }}
            style={{ padding: "0 8px", fontSize: 15, lineHeight: 1, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>×</button>
        )}
        <span onClick={() => setOpen(o => !o)} style={{ padding: "0 8px", color: "#94a3b8", fontSize: 9, flexShrink: 0, userSelect: "none", cursor: "pointer" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div ref={listRef} style={{ position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 7, boxShadow: "0 4px 18px rgba(0,0,0,0.1)", zIndex: 700, maxHeight: 200, overflowY: "auto", scrollbarWidth: "thin" }}>
          {items.length === 0
            ? <p style={{ margin: 0, padding: "7px 10px", fontSize: 12, color: "#94a3b8" }}>등록된 거래처가 없습니다</p>
            : filtered.length === 0
              ? <p style={{ margin: 0, padding: "7px 10px", fontSize: 12, color: "#94a3b8" }}>검색 결과 없음</p>
              : filtered.map((item, idx) => {
                  const isHighlit = idx === highlightIdx;
                  return (
                    <button key={item.id} type="button" onMouseEnter={() => setHighlightIdx(idx)} onMouseLeave={() => setHighlightIdx(-1)}
                      onClick={() => { onChange(item.id); setQuery(""); setOpen(false); setHighlightIdx(-1); }}
                      style={{ display: "block", width: "100%", textAlign: "left", padding: "5px 10px", fontSize: 12, color: "#111827", background: isHighlit ? "#eff6ff" : item.id === value ? "#f0f9ff" : "transparent", border: "none", borderBottom: "1px solid #f8fafc", cursor: "pointer" }}>
                      <span style={{ fontWeight: 600 }}>{item.label}</span>
                      {item.sub && <span style={{ marginLeft: 6, fontSize: 10, color: "#94a3b8" }}>{item.sub}</span>}
                    </button>
                  );
                })
          }
        </div>
      )}
    </div>
  );
}

/* ────── 상태 변경 검증 ────── */
function getStatusTransitionBlock(
  targetStatus: string,
  detail: ProjectDetail,
): { blocked: boolean; reason?: string } {
  const hasAssignedTranslator = (detail.tasks ?? []).length > 0;

  if ((targetStatus === "matched" || targetStatus === "in_progress" || targetStatus === "completed") && !hasAssignedTranslator) {
    return {
      blocked: true,
      reason: "배정된 통번역사가 없습니다. '통번역사' 탭에서 통번역사를 배정한 뒤 상태를 변경해주세요.",
    };
  }
  return { blocked: false };
}

/* 현재 상태별 안내 */
const STATUS_NEXT_HINT: Record<string, { text: string; color: string; bg: string }> = {
  created:     { text: "좌측 '견적서' 메뉴에서 견적을 작성·승인하면 이 프로젝트와 자동으로 연결됩니다.",  color: "#2563eb", bg: "#eff6ff" },
  quoted:      { text: "견적이 발송되었습니다. 고객 회신을 대기 중입니다.",              color: "#7c3aed", bg: "#faf5ff" },
  approved:    { text: "의뢰가 미확정 상태입니다. '진행' 탭에서 통번역사를 배정하세요.", color: "#9333ea", bg: "#fdf4ff" },
  paid:        { text: "결제가 확정되었습니다. '진행' 탭에서 통번역사를 배정하세요.",      color: "#0369a1", bg: "#eff6ff" },
  matched:     { text: "통번역사가 배정되었습니다. '진행' 탭에서 작업 현황을 관리하세요.", color: "#0891b2", bg: "#ecfeff" },
  in_progress: { text: "진행 중인 의뢰입니다. '진행' 탭에서 작업 현황을 확인하세요.",     color: "#059669", bg: "#f0fdf4" },
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const sectionHd: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: '#6b7280',
  textTransform: 'uppercase', letterSpacing: '0.06em',
  margin: '16px 0 8px', paddingBottom: 4, borderBottom: '1px solid #f3f4f6',
};

export function ProjectDetailModal({ projectId, token, onClose, onRefresh, onToast, adminList, initialSection, isAdmin }: {
  projectId: number; token: string; onClose: () => void;
  onRefresh: () => void; onToast: (msg: string) => void;
  adminList?: AdminUser[];
  initialSection?: "info"|"quote"|"progress"|"payment"|"settlement"|"history"|"finance"|"work"|"control-tower";
  isAdmin?: boolean;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [statusTarget, setStatusTarget] = useState("");
  const serverStatusRef = useRef<string>("");   // 서버에서 확인된 마지막 상태
  const [changingStatus, setChangingStatus] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const [financialStatusTarget, setFinancialStatusTarget] = useState("");
  const [changingFinancialStatus, setChangingFinancialStatus] = useState(false);
  const [commType, setCommType] = useState<"email"|"phone"|"message">("message");
  const [commContent, setCommContent] = useState("");
  const [addingComm, setAddingComm] = useState(false);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [showCandidates, setShowCandidates] = useState(false);
  const [expandedCandidate, setExpandedCandidate] = useState<number | null>(null);
  const [expandedSearchResult, setExpandedSearchResult] = useState<number | null>(null);
  const [expandedQuotes, setExpandedQuotes] = useState<Record<number, boolean>>({});
  // 거래명세서 (판매 확정 건만 출력)
  const [stmtData, setStmtData] = useState<{ data: ReturnType<typeof buildQuotePdfData>; title: string } | null>(null);
  const [stmtLoading, setStmtLoading] = useState<number | null>(null);
  const [translatorSearch, setTranslatorSearch] = useState("");
  const [translatorSearchResults, setTranslatorSearchResults] = useState<any[]>([]);
  const [searchingTranslator, setSearchingTranslator] = useState(false);
  // 구버전 initialSection 값 정규화 (하위 호환)
  const normalizeSection = (s?: string): "info"|"quote"|"progress"|"payment"|"settlement"|"history" => {
    if (s === "finance" || s === "control-tower") return "quote";
    if (s === "work") return "progress";
    if (s === "quote" || s === "progress" || s === "payment" || s === "settlement" || s === "history") return s;
    return "info";
  };
  const [activeSection, setActiveSection] = useState<"info"|"quote"|"progress"|"payment"|"settlement"|"history">(normalizeSection(initialSection));

  type ProjectFile = { id: number; fileType: string; fileName: string; objectPath: string; fileSize: number | null; mimeType: string | null; createdAt: string; uploaderName: string | null; uploaderEmail: string | null };
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadFileType, setUploadFileType] = useState<"source"|"translated"|"attachment">("attachment");
  const [uploadProgress, setUploadProgress] = useState<string>("");

  // 기본정보 인라인 편집
  const [editingInfo, setEditingInfo] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editCompanyId, setEditCompanyId] = useState<number | null>(null);
  const [editContactId, setEditContactId] = useState<number | null>(null);
  const [editDivisionId, setEditDivisionId] = useState<number | null>(null);
  const [editBillingCompanyId, setEditBillingCompanyId] = useState<number | null>(null);
  const [editPayerCompanyId, setEditPayerCompanyId] = useState<number | null>(null);
  const [billingWarnConfirmed, setBillingWarnConfirmed] = useState(false);
  const [editDivisionsList, setEditDivisionsList] = useState<{id: number; name: string; type: string | null}[]>([]);
  // 정정 절차 폼
  const [showCorrectionForm, setShowCorrectionForm] = useState(false);
  const [correctionBillingId, setCorrectionBillingId] = useState<number | null>(null);
  const [correctionPayerId, setCorrectionPayerId] = useState<number | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionMemo, setCorrectionMemo] = useState("");
  const [submittingCorrection, setSubmittingCorrection] = useState(false);
  const [savingInfo, setSavingInfo] = useState(false);
  const [companiesList, setCompaniesList] = useState<{id: number; name: string}[]>([]);
  const [contactsList, setContactsList] = useState<{id: number; name: string; companyId: number | null}[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  // 완료 상태 수정 확인 모달
  const [completedConfirmShow, setCompletedConfirmShow] = useState(false);
  const [completedConfirmAction, setCompletedConfirmAction] = useState<(() => void) | null>(null);
  const [completedEditForce, setCompletedEditForce] = useState(false);

  const [showQuoteEditorModal, setShowQuoteEditorModal] = useState(false);
  const [showBillingCardEdit, setShowBillingCardEdit] = useState(false);
  const [billingCardMode, setBillingCardMode] = useState<"same_as_request"|"other_company"|"other_division">("same_as_request");
  const [billingCardCompanyId, setBillingCardCompanyId] = useState<number|null>(null);
  const [billingCardDivisionId, setBillingCardDivisionId] = useState<number|null>(null);
  const [billingCardDivisions, setBillingCardDivisions] = useState<{id:number;name:string;type:string|null}[]>([]);
  const [payerCardMode, setPayerCardMode] = useState<"same_as_billing"|"same_as_request"|"other_company"|"other_division">("same_as_billing");
  const [payerCardCompanyId, setPayerCardCompanyId] = useState<number|null>(null);
  const [payerCardDivisionId, setPayerCardDivisionId] = useState<number|null>(null);
  const [payerCardDivisions, setPayerCardDivisions] = useState<{id:number;name:string;type:string|null}[]>([]);
  const [savingBillingCard, setSavingBillingCard] = useState(false);
  const _dateDefault = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().split("T")[0]; };
  const [quotePaymentDueDate, setQuotePaymentDueDate] = useState(() => _dateDefault(30));
  // 선입금 차감 - 거래처 계정 원장
  type CompPrepaidAcct = { id: number; initialAmount: number; currentBalance: number; note: string | null; depositDate: string | null; status: string };
  type LedgerEntry = { id: number; accountId?: number; type: string; amount: number; balanceBefore: number | null; balanceAfter: number; description: string | null; projectId: number | null; projectTitle: string | null; transactionDate: string | null; createdAt: string | null; supplyAmount: number | null; taxAmount: number | null };
  const [compPrepaidAccounts, setCompPrepaidAccounts] = useState<CompPrepaidAcct[]>([]);
  const [loadingCompPrepaid, setLoadingCompPrepaid] = useState(false);
  const [selectedPrepaidAcctId, setSelectedPrepaidAcctId] = useState<number | null>(null);
  const [acctLedger, setAcctLedger] = useState<LedgerEntry[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [quickPrepaidAmount, setQuickPrepaidAmount] = useState("");
  const [quickPrepaidNote, setQuickPrepaidNote] = useState("");
  const [registeringPrepaid, setRegisteringPrepaid] = useState(false);

  // ── 입금 등록 모달 ──────────────────────────────────────────────────────────
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositDate, setDepositDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [depositMemo, setDepositMemo] = useState("");
  const [depositTargetAcctId, setDepositTargetAcctId] = useState<number | null>(null);
  const [depositSubmitting, setDepositSubmitting] = useState(false);

  // ── 이력 보기 모달 ──────────────────────────────────────────────────────────
  const [showLedgerModal, setShowLedgerModal] = useState(false);
  const [ledgerModalData, setLedgerModalData] = useState<LedgerEntry[]>([]);
  const [ledgerModalLoading, setLedgerModalLoading] = useState(false);

  // 누적 배치 (건별 누적 방식)
  type ActiveBatchItem = { id: number; projectId: number; projectTitle: string; amount: number; serviceName: string | null; createdAt: string };
  type WorkItem = { id: number; batchId: number; sortOrder: number; workDate: string | null; projectName: string | null; language: string | null; description: string | null; quantity: number; unitPrice: number; amount: number };
  type ActiveBatch = { id: number; companyId: number; status: string; totalAmount: number; note: string | null; periodStart: string; periodEnd: string; items: ActiveBatchItem[]; workItems: WorkItem[] };
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null | "loading">(null);
  const [activeBatchOp, setActiveBatchOp] = useState(false);
  const [issueDateBatch, setIssueDateBatch] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentDueDateBatch, setPaymentDueDateBatch] = useState("");
  // 작업 항목 인라인 추가 폼
  type NewWorkItemForm = { workDate: string; projectName: string; language: string; description: string; quantity: string; unitPrice: string; amount: string };
  const emptyNewWI = (): NewWorkItemForm => ({ workDate: new Date().toISOString().slice(0, 10), projectName: detail?.title ?? "", language: "", description: "", quantity: "1", unitPrice: "", amount: "" });
  const [showAddWI, setShowAddWI] = useState(false);
  const [newWI, setNewWI] = useState<NewWorkItemForm>(emptyNewWI);
  const [editingWIId, setEditingWIId] = useState<number | null>(null);
  const [editWI, setEditWI] = useState<NewWorkItemForm>(emptyNewWI);

  // 결제 등록
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [creatingPayment, setCreatingPayment] = useState(false);
  // 정산 수동 생성
  const [creatingSettlement, setCreatingSettlement] = useState(false);

  const authH = { Authorization: `Bearer ${token}` };

  // 거래명세서 — 저장된 견적 데이터를 그대로 사용 (레이아웃·계산 무수정, 견적서와 동일 파이프라인)
  const handleStatement = async (quoteId: number, title: string) => {
    setStmtLoading(quoteId);
    try {
      const res = await fetch(api(`/api/admin/quotes/${quoteId}`), { headers: authH });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        onToast(`거래명세서 생성 실패: ${errData.error ?? res.status}`);
        return;
      }
      const qDetail = await res.json() as QuoteDetail;
      if (!qDetail.items || qDetail.items.length === 0) {
        onToast('견적 품목이 없습니다.');
        return;
      }
      setStmtData({ data: buildQuotePdfData(qDetail), title });
    } catch {
      onToast('거래명세서 생성에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setStmtLoading(null);
    }
  };

  // ── 커스텀 상품 등록 요청 상태 ───────────────────────────────────────────
  const [registerRequestIdx, setRegisterRequestIdx] = useState<number | null>(null);
  const [registerRequestForm, setRegisterRequestForm] = useState<{
    name: string; serviceType: string; languagePair: string; unit: string; unitPrice: string; description: string; usagePeriod: string;
  }>({ name: "", serviceType: "translation", languagePair: "", unit: "페이지", unitPrice: "", description: "", usagePeriod: "1일" });
  const [registerSubmitting, setRegisterSubmitting] = useState(false);
  const [registerDoneIdxs, setRegisterDoneIdxs] = useState<number[]>([]);
  const handleSubmitRegisterRequest = async () => {
    if (!registerRequestForm.name.trim()) return;
    setRegisterSubmitting(true);
    try {
      await fetch(api("/api/admin/product-registration-requests"), {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ ...registerRequestForm, sourceProjectId: detail?.project?.id ?? null }),
      });
      setRegisterDoneIdxs(prev => [...prev, registerRequestIdx!]);
      setRegisterRequestIdx(null);
    } catch(e) {} finally { setRegisterSubmitting(false); }
  };

  const [quoteProducts, setQuoteProducts] = useState<Product[]>([]);
  useEffect(() => {
    fetch(api("/api/admin/products"), { headers: authH })
      .then(r => r.ok ? r.json() : [])
      .then(d => setQuoteProducts(Array.isArray(d) ? d.filter((p: Product) => p.active) : []))
      .catch(() => {});
  }, [token]);


  // ── 활성 누적 배치 로드 ────────────────────────────────────────────────────
  const loadActiveBatch = async (companyId: number) => {
    setActiveBatch("loading");
    try {
      const res = await fetch(api(`/api/admin/billing-batches/active?companyId=${companyId}`), { headers: authH });
      const data = await res.json();
      setActiveBatch(res.ok ? (data ?? null) : null);
    } catch { setActiveBatch(null); }
  };

  const loadCompPrepaidAccounts = async (companyId: number) => {
    setLoadingCompPrepaid(true);
    try {
      const res = await fetch(api(`/api/admin/prepaid-accounts?companyId=${companyId}&_t=${Date.now()}`), { headers: authH, cache: "no-store" });
      if (res.ok) {
        const accounts = await res.json();
        const active = accounts.filter((a: CompPrepaidAcct) => a.status === "active");
        setCompPrepaidAccounts(active);
        // 항상 첫 번째 계정으로 선택 (클로저 캡처 문제 방지)
        if (active.length > 0) setSelectedPrepaidAcctId(active[0].id);
      }
    } finally { setLoadingCompPrepaid(false); }
  };

  const loadAcctLedger = async (acctId: number) => {
    setLoadingLedger(true);
    try {
      const res = await fetch(api(`/api/admin/prepaid-accounts/${acctId}?_t=${Date.now()}`), { headers: authH, cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setAcctLedger(data.ledger ?? []);
        // 계정 잔액도 최신 값으로 동기화
        setCompPrepaidAccounts(prev => prev.map(a => a.id === acctId ? { ...a, currentBalance: Number(data.currentBalance) } : a));
      }
    } finally { setLoadingLedger(false); }
  };

  const createNewBatch = async (companyId: number) => {
    setActiveBatchOp(true);
    try {
      const res = await fetch(api("/api/admin/billing-batches"), { method: "POST", headers: { ...authH, "Content-Type": "application/json" }, body: JSON.stringify({ companyId }) });
      const data = await res.json();
      if (!res.ok) { onToast(data.error ?? "배치 생성 실패"); return; }
      setActiveBatch(data);
      onToast("새 누적 배치가 시작되었습니다.");
    } finally { setActiveBatchOp(false); }
  };

  const addToActiveBatch = async (batchId: number) => {
    setActiveBatchOp(true);
    try {
      const res = await fetch(api(`/api/admin/billing-batches/${batchId}/items`), { method: "POST", headers: { ...authH, "Content-Type": "application/json" }, body: JSON.stringify({ projectId }) });
      const data = await res.json();
      if (!res.ok) { onToast(data.error ?? "추가 실패"); return; }
      // 전체 배치 다시 로드
      await loadActiveBatch((activeBatch as ActiveBatch).companyId);
      onToast("이 프로젝트가 누적 배치에 추가되었습니다.");
    } finally { setActiveBatchOp(false); }
  };

  const removeFromActiveBatch = async (batchId: number, itemId: number) => {
    setActiveBatchOp(true);
    try {
      const res = await fetch(api(`/api/admin/billing-batches/${batchId}/items/${itemId}`), { method: "DELETE", headers: authH });
      if (!res.ok) { onToast("제거 실패"); return; }
      await loadActiveBatch((activeBatch as ActiveBatch).companyId);
    } finally { setActiveBatchOp(false); }
  };

  const issueBatch = async (batchId: number) => {
    setActiveBatchOp(true);
    try {
      const res = await fetch(api(`/api/admin/billing-batches/${batchId}/issue`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, issueDate: issueDateBatch, paymentDueDate: paymentDueDateBatch || undefined, taxDocumentType: "tax_invoice" }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(data.error ?? "발행 실패"); return; }
      onToast("누적 견적서가 발행되었습니다.");
      await loadDetail();
    } finally { setActiveBatchOp(false); }
  };

  // ── 작업 항목 추가 ─────────────────────────────────────────────────────────
  const addWorkItem = async (batchId: number, form: { workDate: string; projectName: string; language: string; description: string; quantity: string; unitPrice: string; amount: string }) => {
    setActiveBatchOp(true);
    try {
      const qty = parseFloat(form.quantity) || 1;
      const price = parseFloat(form.unitPrice) || 0;
      const amt = form.amount !== "" ? parseFloat(form.amount) : qty * price;
      const res = await fetch(api(`/api/admin/billing-batches/${batchId}/work-items`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ workDate: form.workDate || null, projectName: form.projectName || null, language: form.language || null, description: form.description || null, quantity: qty, unitPrice: price, amount: amt }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(data.error ?? "항목 추가 실패"); return; }
      setShowAddWI(false);
      setNewWI(emptyNewWI());
      await loadActiveBatch((activeBatch as ActiveBatch).companyId);
    } finally { setActiveBatchOp(false); }
  };

  const saveWorkItem = async (batchId: number, itemId: number, form: { workDate: string; projectName: string; language: string; description: string; quantity: string; unitPrice: string; amount: string }) => {
    setActiveBatchOp(true);
    try {
      const qty = parseFloat(form.quantity) || 1;
      const price = parseFloat(form.unitPrice) || 0;
      const amt = form.amount !== "" ? parseFloat(form.amount) : qty * price;
      const res = await fetch(api(`/api/admin/billing-batches/${batchId}/work-items/${itemId}`), {
        method: "PUT", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ workDate: form.workDate || null, projectName: form.projectName || null, language: form.language || null, description: form.description || null, quantity: qty, unitPrice: price, amount: amt }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(data.error ?? "항목 수정 실패"); return; }
      setEditingWIId(null);
      await loadActiveBatch((activeBatch as ActiveBatch).companyId);
    } finally { setActiveBatchOp(false); }
  };

  const deleteWorkItem = async (batchId: number, itemId: number) => {
    if (!confirm("이 작업 항목을 삭제하시겠습니까?")) return;
    setActiveBatchOp(true);
    try {
      const res = await fetch(api(`/api/admin/billing-batches/${batchId}/work-items/${itemId}`), { method: "DELETE", headers: authH });
      if (!res.ok) { onToast("삭제 실패"); return; }
      await loadActiveBatch((activeBatch as ActiveBatch).companyId);
    } finally { setActiveBatchOp(false); }
  };

  const loadDetail = async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}`), { headers: authH });
      const data = await res.json();
      if (res.ok) {
        setDetail(data);
        // 서버 상태가 실제로 변경됐을 때만 드롭다운 리셋 (사용자 선택 유지)
        if (serverStatusRef.current !== data.status) {
          serverStatusRef.current = data.status;
          setStatusTarget(data.status);
        }
        setFinancialStatusTarget(data.financialStatus ?? "unbilled");
      } else if (res.status === 401) {
        onToast("세션이 만료되었습니다. 다시 로그인해 주세요.");
        onClose();
      } else {
        setErr(data.error ?? "조회 실패");
      }
    } catch { setErr("서버 연결 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadDetail(); }, [projectId]);

  const loadCandidates = async () => {
    setLoadingCandidates(true);
    setShowCandidates(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/match-candidates`), { headers: authH });
      const data = await res.json();
      if (res.ok) setCandidates(Array.isArray(data) ? data : []);
      else onToast(`오류: ${data.error}`);
    } catch { onToast("오류: 후보 조회 실패"); }
    finally { setLoadingCandidates(false); }
  };

  const handleAssignTranslator = async (translatorId: number) => {
    setAssigning(translatorId);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/assign-translator`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ translatorId }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`통번역사 배정 완료 → ${data.translatorEmail}`);
      setShowCandidates(false);
      setTranslatorSearch("");
      setTranslatorSearchResults([]);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 배정 실패"); }
    finally { setAssigning(null); }
  };

  useEffect(() => {
    if (!translatorSearch.trim()) { setTranslatorSearchResults([]); return; }
    const t = setTimeout(async () => {
      setSearchingTranslator(true);
      try {
        const res = await fetch(api(`/api/admin/translators?search=${encodeURIComponent(translatorSearch.trim())}`), { headers: authH });
        if (res.ok) setTranslatorSearchResults(await res.json());
      } catch { /* silent */ }
      finally { setSearchingTranslator(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [translatorSearch]);

  const fetchFiles = async () => {
    setFilesLoading(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/files`), { headers: authH });
      if (res.ok) setProjectFiles(await res.json());
    } catch { /* silent */ }
    finally { setFilesLoading(false); }
  };

  useEffect(() => { if (activeSection === "history") fetchFiles(); }, [activeSection]);
  useEffect(() => {
    if (selectedPrepaidAcctId) {
      loadAcctLedger(selectedPrepaidAcctId);
    } else {
      setAcctLedger([]);
    }
  }, [selectedPrepaidAcctId]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploadingFile(true);
    setUploadProgress("presigned URL 요청 중...");
    try {
      const urlRes = await fetch(api("/api/storage/uploads/request-url"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.ok) { onToast("오류: 업로드 URL 발급 실패"); return; }
      const { uploadURL, objectPath } = await urlRes.json();

      setUploadProgress("파일 업로드 중...");
      const putRes = await fetch(uploadURL, {
        method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
      });
      if (!putRes.ok) { onToast("오류: GCS 업로드 실패"); return; }

      setUploadProgress("파일 정보 저장 중...");
      const regRes = await fetch(api(`/api/admin/projects/${projectId}/files`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ fileType: uploadFileType, fileName: file.name, objectPath, fileSize: file.size, mimeType: file.type }),
      });
      if (!regRes.ok) { onToast("오류: 파일 정보 저장 실패"); return; }
      onToast(`"${file.name}" 업로드 완료`);
      await fetchFiles();
    } catch { onToast("오류: 파일 업로드 중 오류 발생"); }
    finally { setUploadingFile(false); setUploadProgress(""); }
  };

  const handleFileDelete = async (fileId: number, fileName: string) => {
    if (!confirm(`"${fileName}"을(를) 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/files/${fileId}`), { method: "DELETE", headers: authH });
      if (!res.ok) { onToast("오류: 파일 삭제 실패"); return; }
      onToast("파일이 삭제되었습니다.");
      await fetchFiles();
    } catch { onToast("오류: 파일 삭제 실패"); }
  };

  const handleStatusChange = async () => {
    if (!statusTarget || statusTarget === detail?.status) return;
    setChangingStatus(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/status`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusTarget }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      if (data.settlementCreated) {
        onToast(`업무 상태가 "완료"로 변경되었습니다. 정산이 자동 생성되었습니다.`);
      } else {
        onToast(`업무 상태가 "${STATUS_LABEL[statusTarget] ?? statusTarget}"로 변경되었습니다.`);
      }
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 상태 변경 실패"); }
    finally { setChangingStatus(false); }
  };

  const applyStatus = async (newStatus: string) => {
    if (!newStatus || newStatus === detail?.status) return;
    setChangingStatus(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/status`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      if (data.settlementCreated) {
        onToast(`상태가 "완료"로 변경되었습니다. 정산이 자동 생성되었습니다.`);
      } else {
        onToast(`상태가 "${STATUS_LABEL[newStatus] ?? newStatus}"로 변경되었습니다.`);
      }
      setStatusTarget(newStatus);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 상태 변경 실패"); }
    finally { setChangingStatus(false); }
  };

  const handleFinancialStatusChange = async () => {
    if (!financialStatusTarget || financialStatusTarget === detail?.financialStatus) return;
    setChangingFinancialStatus(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/financial-status`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ financialStatus: financialStatusTarget }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`재무 상태가 "${FINANCIAL_STATUS_LABEL[financialStatusTarget] ?? financialStatusTarget}"로 변경되었습니다.`);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 재무 상태 변경 실패"); }
    finally { setChangingFinancialStatus(false); }
  };

  const handleCancel = async () => {
    if (!confirm("이 프로젝트를 취소하시겠습니까?")) return;
    setCancelling(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/cancel`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("프로젝트가 취소되었습니다.");
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 취소 실패"); }
    finally { setCancelling(false); }
  };

  const loadMeta = async () => {
    if (companiesList.length > 0) return;
    setLoadingMeta(true);
    try {
      const [cRes, coRes] = await Promise.all([
        fetch(api("/api/admin/companies"), { headers: authH }),
        fetch(api("/api/admin/contacts"), { headers: authH }),
      ]);
      if (cRes.ok) setCompaniesList((await cRes.json()).map((c: any) => ({ id: c.id, name: c.name })));
      if (coRes.ok) setContactsList((await coRes.json()).map((c: any) => ({ id: c.id, name: c.name, companyId: c.companyId })));
    } catch { /* ignore */ }
    finally { setLoadingMeta(false); }
  };

  const startEditInfo = async () => {
    if (!detail) return;
    // 완료 상태에서는 confirm modal 먼저
    if (detail.status === "completed") {
      setCompletedConfirmAction(() => () => _doStartEditInfo());
      setCompletedConfirmShow(true);
      return;
    }
    await _doStartEditInfo();
  };

  const _doStartEditInfo = async () => {
    if (!detail) return;
    await loadMeta();
    setEditTitle(detail.title);
    const cid = detail.company?.id ?? (detail as any).companyId ?? null;
    setEditCompanyId(cid);
    setEditContactId(detail.contact?.id ?? (detail as any).contactId ?? null);
    setEditDivisionId((detail as any).requestingDivisionId ?? null);
    setEditBillingCompanyId((detail as any).billingCompanyId ?? null);
    setEditPayerCompanyId((detail as any).payerCompanyId ?? null);
    setBillingWarnConfirmed(false);
    setShowCorrectionForm(false);
    setCorrectionReason(""); setCorrectionMemo("");
    // 선택된 거래처의 divisions 로드
    if (cid) {
      try {
        const res = await fetch(api(`/api/admin/companies/${cid}/divisions`), { headers: authH });
        if (res.ok) setEditDivisionsList(await res.json());
        else setEditDivisionsList([]);
      } catch { setEditDivisionsList([]); }
    } else {
      setEditDivisionsList([]);
    }
    setEditingInfo(true);
  };

  const handleSaveInfo = async () => {
    if (!editTitle.trim()) return;
    setSavingInfo(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/info`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          companyId: editCompanyId,
          contactId: editContactId,
          requestingDivisionId: editDivisionId,
          billingCompanyId: editBillingCompanyId,
          payerCompanyId: editPayerCompanyId,
          forceEdit: completedEditForce || undefined,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "completed_confirm_required") {
        // 백엔드에서 완료 상태 확인 요청 — 모달 표시
        setCompletedConfirmAction(() => () => { setCompletedEditForce(true); handleSaveInfo(); });
        setCompletedConfirmShow(true);
        return;
      }
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(completedEditForce ? "기본정보가 수정되었습니다. (상태: 진행 중으로 변경)" : "기본정보가 수정되었습니다.");
      setEditingInfo(false); setCompletedEditForce(false);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 저장 실패"); }
    finally { setSavingInfo(false); }
  };

  const handleBillingCorrection = async () => {
    if (!correctionReason.trim()) { onToast("정정 사유를 선택해주세요."); return; }
    if (!correctionMemo.trim()) { onToast("상세 메모를 입력해주세요."); return; }
    setSubmittingCorrection(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/billing-correction`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          billingCompanyId: correctionBillingId,
          payerCompanyId: correctionPayerId,
          reason: correctionReason.trim(),
          memo: correctionMemo.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("청구/납부 정보가 정정되었습니다.");
      setShowCorrectionForm(false);
      setCorrectionReason(""); setCorrectionMemo("");
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 정정 처리 실패"); }
    finally { setSubmittingCorrection(false); }
  };


  // 프로젝트 모달 내 선입금 계정 빠른 등록
  const handleQuickRegisterPrepaid = async () => {
    const amt = Number(quickPrepaidAmount.replace(/,/g, ""));
    if (!amt || amt <= 0) { onToast("입금액을 입력하세요."); return; }
    const compId = detail?.companyId;
    if (!compId) { onToast("이 프로젝트에 거래처가 연결되어 있지 않습니다."); return; }
    setRegisteringPrepaid(true);
    try {
      const res = await fetch(api("/api/admin/prepaid-accounts"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: compId, initialAmount: amt,
          note: quickPrepaidNote || null, depositDate: new Date().toISOString().slice(0, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("선입금 계정이 등록되었습니다. 이제 차감 금액을 입력하세요.");
      setQuickPrepaidAmount(""); setQuickPrepaidNote("");
      // 계정 목록 갱신 후 자동 선택
      const listRes = await fetch(api(`/api/admin/prepaid-accounts?companyId=${compId}`), { headers: authH });
      if (listRes.ok) {
        const list = await listRes.json();
        const active = list.filter((a: CompPrepaidAcct) => a.status === "active");
        setCompPrepaidAccounts(active);
        if (active.length > 0) setSelectedPrepaidAcctId(active[0].id);
      }
    } catch { onToast("오류: 선입금 계정 등록 실패"); }
    finally { setRegisteringPrepaid(false); }
  };

  // ── 입금 등록 제출 핸들러 ──────────────────────────────────────────────────
  const handleDepositSubmit = async () => {
    const compId = detail?.companyId;
    if (!compId) { onToast("거래처가 없습니다."); return; }
    const rawAmt = Number(depositAmount.replace(/,/g, ""));
    if (!rawAmt || rawAmt <= 0) { onToast("입금 금액을 입력하세요."); return; }
    if (!depositDate) { onToast("입금일을 입력하세요."); return; }
    setDepositSubmitting(true);
    try {
      const res = await fetch(api("/api/prepaid/deposit"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: compId,
          accountId: depositTargetAcctId ?? undefined,
          amount: rawAmt,
          note: depositMemo || null,
          depositDate,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`입금 완료: ${rawAmt.toLocaleString()}원`);
      setShowDepositModal(false);
      setDepositAmount(""); setDepositMemo("");
      setDepositDate(new Date().toISOString().slice(0, 10));
      // 계정 목록 갱신
      const listRes = await fetch(api(`/api/admin/prepaid-accounts?companyId=${compId}&_t=${Date.now()}`), { headers: authH });
      if (listRes.ok) {
        const list = await listRes.json();
        const active = list.filter((a: CompPrepaidAcct) => a.status === "active");
        setCompPrepaidAccounts(active);
        if (active.length > 0 && !selectedPrepaidAcctId) setSelectedPrepaidAcctId(active[0].id);
      }
      // 원장도 갱신
      if (selectedPrepaidAcctId || data.account?.id) {
        const acctId = selectedPrepaidAcctId ?? data.account.id;
        const txRes = await fetch(api(`/api/prepaid/transactions?companyId=${compId}&_t=${Date.now()}`), { headers: authH });
        if (txRes.ok) setAcctLedger(await txRes.json());
      }
    } catch { onToast("입금 처리 중 오류가 발생했습니다."); }
    finally { setDepositSubmitting(false); }
  };

  // ── 이력 보기 모달 오픈 핸들러 ────────────────────────────────────────────
  const handleOpenLedgerModal = async () => {
    const compId = detail?.companyId;
    if (!compId) return;
    setShowLedgerModal(true);
    setLedgerModalLoading(true);
    try {
      const res = await fetch(api(`/api/prepaid/transactions?companyId=${compId}&limit=200&_t=${Date.now()}`), { headers: authH });
      if (res.ok) setLedgerModalData(await res.json());
    } catch { /* ignore */ }
    finally { setLedgerModalLoading(false); }
  };

  const handleCreatePayment = async () => {
    const amt = Number(paymentAmount.replace(/,/g, ""));
    if (!amt || amt <= 0) { onToast("유효한 금액을 입력하세요."); return; }
    if (!paymentDate) { onToast("결제일을 입력하세요."); return; }
    setCreatingPayment(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/payment`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          paymentDate,
          paymentDueDate: quotePaymentDueDate || undefined,
          paymentMethod: paymentMethod || undefined,
          paymentNote: paymentNote || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`결제 등록 완료 — ${amt.toLocaleString()}원`);
      setPaymentAmount("");
      setPaymentDate(new Date().toISOString().slice(0, 10));
      setPaymentMethod("");
      setPaymentNote("");
      setShowPaymentForm(false);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 결제 등록 실패"); }
    finally { setCreatingPayment(false); }
  };

  const handleCreateSettlement = async () => {
    setCreatingSettlement(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/settlement`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("정산이 생성되었습니다.");
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 정산 생성 실패"); }
    finally { setCreatingSettlement(false); }
  };

  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/notes`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ content: noteInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, notes: [...(prev.notes ?? []), data] } : prev);
      setNoteInput("");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const handleAddComm = async () => {
    if (!commContent.trim() || !detail) return;
    setAddingComm(true);
    try {
      const res = await fetch(api("/api/admin/communications"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: detail.projectCustomerId, projectId, type: commType, content: commContent.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, communications: [data, ...(prev.communications ?? [])] } : prev);
      setCommContent("");
      onToast("커뮤니케이션 기록이 추가되었습니다.");
    } catch { onToast("오류: 추가 실패"); }
    finally { setAddingComm(false); }
  };

  const AVAIL_STYLE: Record<string, { label: string; color: string }> = {
    available: { label: "가능", color: "#059669" },
    busy:      { label: "바쁨", color: "#d97706" },
    unavailable: { label: "불가", color: "#dc2626" },
  };

  const sectionHd: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#5a6270",
    textTransform: "uppercase", letterSpacing: "0.07em",
    margin: "16px 0 8px", paddingBottom: 5, borderBottom: "1px solid #e9ecef",
  };
  const dl: React.CSSProperties = { display: "flex", gap: 6, fontSize: 13, marginBottom: 5, alignItems: "flex-start" };
  const dt: React.CSSProperties = { color: "#b0b8c6", minWidth: 72, flexShrink: 0 };
  const Empty = ({ label = "미입력" }: { label?: string }) => (
    <span style={{ color: "#d1d5db", fontStyle: "italic", fontSize: 12 }}>{label}</span>
  );
  const Req = () => <span style={{ color: "#dc2626", fontSize: 10, fontWeight: 700, marginLeft: 3 }}>필수</span>;
  const Opt = () => <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 3 }}>(선택)</span>;
  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "5px 13px", fontSize: 12, fontWeight: active ? 700 : 400, borderRadius: 7, cursor: "pointer",
    border: active ? "1px solid #c7d9f8" : "1px solid transparent",
    background: active ? "#ffffff" : "transparent",
    color: active ? "#1e3a8a" : "#9ca3af",
    boxShadow: active ? "0 1px 4px rgba(37,99,235,0.14), 0 0 0 1px rgba(37,99,235,0.06)" : "none",
    transition: "background 0.1s, color 0.1s, box-shadow 0.1s",
    whiteSpace: "nowrap",
  });

  const sections: Array<{ key: typeof activeSection; label: string }> = [
    { key: "info", label: "기본정보" },
    { key: "quote", label: "견적" },
    { key: "progress", label: "진행" },
    { key: "payment", label: "결제" },
    { key: "settlement", label: "정산" },
    { key: "history", label: `기록${projectFiles.length > 0 ? ` (📎${projectFiles.length})` : ""}` },
  ];

  return (
    <>
    <DraggableModal
      title={`프로젝트 #${projectId} 상세`}
      onClose={onClose}
      width={820}
      height="88vh"
      zIndex={300}
      bodyPadding="0"
      resizable
      headerExtra={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {detail && <StatusBadge status={detail.status} />}
        </div>
      }
    >
        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 28px" }}>불러오는 중...</p>
        ) : err ? (
          <p style={{ color: "#dc2626", padding: "16px 28px" }}>{err}</p>
        ) : detail && (
          <>
            {/* ── 고정 상단 영역: ReviewMemo + 액션바 + 탭 내비 ── */}
            <div style={{ position: "sticky", top: 0, zIndex: 5, background: "#fff", padding: "20px 28px 0", borderBottom: "1px solid #f0f2f5" }}>
            <ReviewMemoPanel storageKey={`project_${projectId}`} label="이 프로젝트 검수 메모" />
            {/* 액션 바 */}
            <div style={{ background: "#f9fafb", borderRadius: 10, padding: "10px 12px", marginBottom: 14, border: "1px solid #e5e7eb" }}>
              {/* ── Progress Step Bar ──────────────────────────────────────────────── */}
              {/* 아래 STEPS 배열만 수정하면 단계 추가/변경/제거가 가능합니다.          */}
              {/* 향후 목표 단계: 접수 → 견적 → 미확정 → 확정 → 배정 → 진행 → 납품 → 완료 */}
              {(() => {
                // ── 단계 정의 (추가/변경 시 이 배열만 수정) ──────────────────────
                const STEPS: Array<{ key: string; label: string; assignStep?: boolean }> = [
                  { key: "created",     label: "접수" },
                  { key: "quoted",      label: "견적" },
                  { key: "approved",    label: "미확정" },
                  { key: "paid",        label: "확정" },
                  { key: "matched",     label: "배정", assignStep: true },
                  { key: "in_progress", label: "진행" },
                  { key: "completed",   label: "완료" },
                ];
                // ─────────────────────────────────────────────────────────────────

                const isCancelled = detail.status === "cancelled";
                const currentIdx = isCancelled ? -1 : STEPS.findIndex(s => s.key === detail.status);
                const hasTranslator = (detail.tasks ?? []).length > 0;
                const transitions = PROJECT_STATUS_TRANSITIONS[detail.status] ?? [];

                const elements: React.ReactNode[] = [];
                STEPS.forEach(({ key: stepKey, label: stepLabel, assignStep }, idx) => {
                  const isDone = !isCancelled && idx < currentIdx;
                  const isCurrent = !isCancelled && idx === currentIdx;
                  const canTransition = !isCurrent && transitions.includes(stepKey);
                  const isClickable = canTransition && !changingStatus;

                  const circleBg = isDone ? "#16a34a" : isCurrent ? "#2563eb" : "#f3f4f6";
                  const circleBorder = isDone ? "#16a34a" : isCurrent ? "#2563eb" : "#d1d5db";
                  const circleText = (isDone || isCurrent) ? "#fff" : "#9ca3af";

                  if (idx > 0) {
                    elements.push(
                      <div key={`ln-${idx}`} style={{
                        flex: 1, height: 2, minWidth: 8,
                        background: isDone ? "#bbf7d0" : "#e5e7eb",
                        alignSelf: "flex-start", marginTop: 14,
                      }} />
                    );
                  }
                  elements.push(
                    <div key={stepKey}
                      onClick={() => {
                        if (!isClickable) return;
                        if (assignStep && !hasTranslator) { loadCandidates(); return; }
                        applyStatus(stepKey);
                      }}
                      title={isClickable
                        ? (assignStep && !hasTranslator ? "통번역사 배정하기" : `"${stepLabel}"로 변경`)
                        : undefined}
                      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0, cursor: isClickable ? "pointer" : "default" }}
                    >
                      <div style={{
                        width: 28, height: 28, borderRadius: "50%",
                        border: `2px solid ${circleBorder}`,
                        background: circleBg,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, fontWeight: 800, color: circleText,
                        boxShadow: isCurrent ? "0 0 0 3px #bfdbfe" : undefined,
                      }}>
                        {isDone ? "✓" : idx + 1}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                        <span style={{
                          fontSize: 10, textAlign: "center", whiteSpace: "nowrap", lineHeight: 1.3,
                          fontWeight: (isCurrent || isDone) ? 700 : 400,
                          color: isDone ? "#15803d" : isCurrent ? "#1d4ed8" : "#9ca3af",
                        }}>
                          {stepLabel}
                        </span>
                        {isCurrent && (
                          <span style={{ fontSize: 9, fontWeight: 700, color: "#2563eb", background: "#dbeafe", borderRadius: 3, padding: "1px 4px", whiteSpace: "nowrap" }}>현재</span>
                        )}
                        {assignStep && !hasTranslator && !isCancelled && (
                          <span style={{ fontSize: 9, fontWeight: 600, whiteSpace: "nowrap", color: "#d97706" }}>(필요)</span>
                        )}
                      </div>
                    </div>
                  );
                });

                return (
                  <div style={{ marginBottom: 0, paddingBottom: 4 }}>
                    {isCancelled && (
                      <div style={{ marginBottom: 6, display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: "#fee2e2", borderRadius: 6, fontSize: 11, fontWeight: 700, color: "#dc2626" }}>
                        🚫 취소된 의뢰
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "flex-start", overflowX: "auto", paddingBottom: 2 }}>
                      {elements}
                    </div>
                  </div>
                );
              })()}
              {/* ── 재무 상태 — 읽기 전용 요약 배지 (상세 수정은 결제 탭에서) ── */}
              {(() => {
                const fs = detail.financialStatus ?? "unbilled";
                const fStyle = FINANCIAL_STATUS_STYLE[fs] ?? { background: "#f3f4f6", color: "#6b7280" };
                const quotePrice = detail.quotes.length > 0
                  ? Number((detail.quotes[0] as any).price ?? (detail.quotes[0] as any).amount ?? 0)
                  : null;
                const paidAmount = detail.payments
                  .filter((pm: any) => pm.status === "paid")
                  .reduce((s: number, pm: any) => s + Number(pm.amount ?? 0), 0);
                const unpaid = quotePrice != null ? quotePrice - paidAmount : null;
                return (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10, paddingTop: 6, paddingBottom: 8, borderBottom: "1px dashed #e5e7eb" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "#b0b8c6", letterSpacing: "0.04em", flexShrink: 0 }}>재무</span>
                    {quotePrice != null && (
                      <span style={{ fontSize: 11, color: "#374151" }}>
                        견적금액 <strong style={{ color: "#1e3a5f" }}>{quotePrice.toLocaleString()}원</strong>
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: "#d1d5db" }}>|</span>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, fontWeight: 700, background: fStyle.background as string, color: fStyle.color as string }}>
                      {FINANCIAL_STATUS_LABEL[fs]}
                    </span>
                    {unpaid != null && unpaid > 0 && (
                      <>
                        <span style={{ fontSize: 10, color: "#d1d5db" }}>|</span>
                        <span style={{ fontSize: 11, color: "#dc2626" }}>
                          미수금 <strong>{unpaid.toLocaleString()}원</strong>
                        </span>
                      </>
                    )}
                    {paidAmount > 0 && unpaid != null && unpaid <= 0 && (
                      <>
                        <span style={{ fontSize: 10, color: "#d1d5db" }}>|</span>
                        <span style={{ fontSize: 11, color: "#059669", fontWeight: 600 }}>입금 완료</span>
                      </>
                    )}
                    <button
                      onClick={() => setActiveSection("payment")}
                      style={{ marginLeft: "auto", fontSize: 10, color: "#6b7280", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                      결제 탭에서 관리 →
                    </button>
                  </div>
                );
              })()}
              {/* 현재 상태 안내 */}
              {(() => {
                const noTranslatorBlock = ["approved", "matched", "in_progress"].includes(detail.status) && (detail.tasks ?? []).length === 0;
                if (noTranslatorBlock) {
                  return (
                    <div style={{
                      display: "flex", alignItems: "flex-start", gap: 10,
                      background: "#fdf4ff", border: "1px solid #d8b4fe",
                      borderRadius: 7, padding: "10px 12px", marginBottom: 8,
                    }}>
                      <span style={{ fontSize: 15, lineHeight: 1.2, flexShrink: 0 }}>ℹ️</span>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 12, color: "#7c3aed", lineHeight: 1.6 }}>
                          아직 통번역사가 배정되지 않았습니다.<br />
                          아래 <strong>'통번역사 배정하기'</strong> 버튼으로 배정하면 상태가 자동으로 변경됩니다.
                        </span>
                        <div style={{ marginTop: 8 }}>
                          <GhostBtn onClick={loadCandidates} disabled={loadingCandidates} color="#7c3aed"
                            style={{ fontSize: 12, padding: "6px 14px", fontWeight: 700, background: "#f3e8ff" }}>
                            {loadingCandidates ? "조회 중..." : "통번역사 배정하기"}
                          </GhostBtn>
                        </div>
                      </div>
                    </div>
                  );
                }
                if (!STATUS_NEXT_HINT[detail.status]) return null;
                return (
                  <div style={{
                    display: "flex", alignItems: "flex-start", gap: 6,
                    background: STATUS_NEXT_HINT[detail.status].bg,
                    border: `1px solid ${STATUS_NEXT_HINT[detail.status].color}30`,
                    borderRadius: 7, padding: "6px 10px", marginBottom: 8,
                  }}>
                    <span style={{ fontSize: 12, color: STATUS_NEXT_HINT[detail.status].color, lineHeight: 1.5, whiteSpace: "pre-line" }}>
                      💡 {STATUS_NEXT_HINT[detail.status].text}
                    </span>
                  </div>
                );
              })()}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {/* 통번역사 추천 — 이미 배정된 경우 재배정용으로만 표시 (미배정 시 위 통합 경고에 표시됨) */}
                {["approved", "matched", "in_progress"].includes(detail.status) && (detail.tasks ?? []).length > 0 && (
                  <GhostBtn onClick={loadCandidates} disabled={loadingCandidates} color="#7c3aed" style={{ fontSize: 12, padding: "6px 12px" }}>
                    {loadingCandidates ? "조회 중..." : "통번역사 추천"}
                  </GhostBtn>
                )}
                {/* 프로젝트 취소 */}
                {!["cancelled", "completed"].includes(detail.status) && (
                  <GhostBtn onClick={handleCancel} disabled={cancelling} color="#dc2626" style={{ fontSize: 12, padding: "6px 12px", marginLeft: "auto" }}>
                    {cancelling ? "취소 중..." : "프로젝트 취소"}
                  </GhostBtn>
                )}
              </div>
            </div>

            {/* 통번역사 추천 후보 */}
            {showCandidates && (
              <div style={{ marginBottom: 14, padding: "12px 14px", background: "#faf5ff", borderRadius: 10, border: "1px solid #e9d5ff" }}>
                {["in_progress", "completed"].includes(detail.status) && (
                  <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6, padding: "7px 10px", marginBottom: 10, fontSize: 12, color: "#92400e", display: "flex", alignItems: "center", gap: 6 }}>
                    ⚠️ 이 변경은 현재 상태를 되돌립니다 (프로젝트: 견적승인 / 배정: 대기)
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>추천 통번역사 (상위 3명)</p>
                  <button onClick={() => { setShowCandidates(false); setTranslatorSearch(""); setTranslatorSearchResults([]); setExpandedCandidate(null); setExpandedSearchResult(null); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 }}>×</button>
                </div>
                {loadingCandidates ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center" }}>조회 중...</p>
                ) : candidates.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13 }}>조건에 맞는 통번역사가 없습니다.</p>
                ) : candidates.map((c, i) => {
                  const av = AVAIL_STYLE[c.profile?.availabilityStatus ?? ""] ?? AVAIL_STYLE.unavailable;
                  const isExpanded = expandedCandidate === c.id;
                  const hasDetail = !!(c.profile?.education || c.profile?.major || c.profile?.region || c.profile?.grade || c.profile?.bio);
                  return (
                    <div key={c.id} style={{ background: "#fff", borderRadius: 8, marginBottom: 6, border: "1px solid #e9d5ff", overflow: "hidden" }}>
                      {/* 기본 정보 행 */}
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px" }}>
                        <span style={{ fontWeight: 800, color: "#7c3aed", fontSize: 15, minWidth: 24, paddingTop: 1 }}>#{i + 1}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {/* 이름 + 가용상태 */}
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
                              {c.name ?? "(이름 미설정)"}
                            </span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: av.color }}>{av.label}</span>
                          </div>
                          {/* 전화 + 이메일 */}
                          <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>
                            {c.profile?.phone && <span style={{ marginRight: 8 }}>📞 {c.profile.phone}</span>}
                            <span>✉ {c.email}</span>
                          </div>
                          {/* 언어 + 전문분야 + 점수 */}
                          <div style={{ fontSize: 11, color: "#6b7280" }}>
                            {c.profile?.languagePairs ?? "가능언어 미설정"}
                            {c.profile?.specializations && ` · ${c.profile.specializations}`}
                            {c.profile?.rating != null && <span style={{ color: "#d97706", marginLeft: 6 }}>⭐ {c.profile.rating.toFixed(1)}</span>}
                            <span style={{ color: "#9ca3af", marginLeft: 6 }}>점수 {c.score.toFixed(1)}</span>
                          </div>
                        </div>
                        {/* 버튼 영역 */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                          <PrimaryBtn
                            onClick={() => handleAssignTranslator(c.id)}
                            disabled={assigning === c.id}
                            style={{ fontSize: 12, padding: "5px 14px" }}>
                            {assigning === c.id ? "배정 중..." : "배정"}
                          </PrimaryBtn>
                          {hasDetail && (
                            <button
                              onClick={() => setExpandedCandidate(isExpanded ? null : c.id)}
                              style={{ fontSize: 11, padding: "3px 8px", border: "1px solid #d8b4fe", borderRadius: 6, background: isExpanded ? "#f5f3ff" : "#fff", color: "#7c3aed", cursor: "pointer", fontWeight: 600 }}>
                              {isExpanded ? "접기 ▲" : "상세 ▼"}
                            </button>
                          )}
                        </div>
                      </div>
                      {/* 상세정보 펼침 */}
                      {isExpanded && (
                        <div style={{ padding: "8px 12px 10px 46px", borderTop: "1px solid #f3e8ff", background: "#faf5ff", fontSize: 12, color: "#4b5563" }}>
                          {(c.profile?.education || c.profile?.major || c.profile?.graduationYear) && (
                            <div style={{ marginBottom: 3 }}>
                              🎓 {[c.profile.education, c.profile.major, c.profile.graduationYear && `${c.profile.graduationYear}년 졸`].filter(Boolean).join(" · ")}
                            </div>
                          )}
                          {c.profile?.region && (
                            <div style={{ marginBottom: 3 }}>📍 {c.profile.region}</div>
                          )}
                          {c.profile?.grade && (
                            <div style={{ marginBottom: 3 }}>🏅 등급: {c.profile.grade}</div>
                          )}
                          {c.profile?.bio && (
                            <div style={{ color: "#6b7280", fontStyle: "italic", lineHeight: 1.5 }}>{c.profile.bio}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* ── 통번역사 직접 검색 ── */}
                <div style={{ marginTop: 12, borderTop: "1px solid #e9d5ff", paddingTop: 10 }}>
                  <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>🔍 통번역사 검색</p>
                  <input
                    type="text"
                    placeholder="이름, 이메일, 전화번호로 검색"
                    value={translatorSearch}
                    onChange={e => setTranslatorSearch(e.target.value)}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 7, border: "1px solid #d8b4fe", fontSize: 13, outline: "none", boxSizing: "border-box" }}
                  />
                  {translatorSearch.trim() && (
                    <div style={{ marginTop: 6 }}>
                      {searchingTranslator ? (
                        <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", margin: "6px 0" }}>검색 중...</p>
                      ) : translatorSearchResults.length === 0 ? (
                        <p style={{ color: "#9ca3af", fontSize: 13, margin: "6px 0" }}>검색 결과가 없습니다.</p>
                      ) : translatorSearchResults.map(t => {
                        const av = AVAIL_STYLE[t.availabilityStatus ?? ""] ?? AVAIL_STYLE.unavailable;
                        const isExpanded = expandedSearchResult === t.id;
                        const hasDetail = !!(t.education || t.major || t.region || t.grade || t.bio);
                        return (
                          <div key={t.id} style={{ background: "#fff", borderRadius: 8, marginBottom: 5, border: "1px solid #e9d5ff", overflow: "hidden" }}>
                            {/* 기본 정보 행 */}
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px" }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                {/* 이름 + 가용상태 */}
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
                                    {t.name ?? "(이름 미설정)"}
                                  </span>
                                  <span style={{ fontSize: 10, fontWeight: 600, color: av.color }}>{av.label}</span>
                                </div>
                                {/* 전화 + 이메일 */}
                                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>
                                  {t.phone && <span style={{ marginRight: 8 }}>📞 {t.phone}</span>}
                                  <span>✉ {t.email}</span>
                                </div>
                                {/* 언어 + 전문분야 + 평점 */}
                                <div style={{ fontSize: 11, color: "#6b7280" }}>
                                  {t.languagePairs ?? "가능언어 미설정"}
                                  {t.specializations && ` · ${t.specializations}`}
                                  {t.rating != null && <span style={{ color: "#d97706", marginLeft: 6 }}>⭐ {Number(t.rating).toFixed(1)}</span>}
                                </div>
                              </div>
                              {/* 버튼 영역 */}
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
                                <PrimaryBtn
                                  onClick={() => handleAssignTranslator(t.id)}
                                  disabled={assigning === t.id}
                                  style={{ fontSize: 12, padding: "5px 14px" }}>
                                  {assigning === t.id ? "배정 중..." : "배정"}
                                </PrimaryBtn>
                                {hasDetail && (
                                  <button
                                    onClick={() => setExpandedSearchResult(isExpanded ? null : t.id)}
                                    style={{ fontSize: 11, padding: "3px 8px", border: "1px solid #d8b4fe", borderRadius: 6, background: isExpanded ? "#f5f3ff" : "#fff", color: "#7c3aed", cursor: "pointer", fontWeight: 600 }}>
                                    {isExpanded ? "접기 ▲" : "상세 ▼"}
                                  </button>
                                )}
                              </div>
                            </div>
                            {/* 상세정보 펼침 */}
                            {isExpanded && (
                              <div style={{ padding: "8px 12px 10px 12px", borderTop: "1px solid #f3e8ff", background: "#faf5ff", fontSize: 12, color: "#4b5563" }}>
                                {(t.education || t.major || t.graduationYear) && (
                                  <div style={{ marginBottom: 3 }}>
                                    🎓 {[t.education, t.major, t.graduationYear && `${t.graduationYear}년 졸`].filter(Boolean).join(" · ")}
                                  </div>
                                )}
                                {t.region && <div style={{ marginBottom: 3 }}>📍 {t.region}</div>}
                                {t.grade && <div style={{ marginBottom: 3 }}>🏅 등급: {t.grade}</div>}
                                {t.bio && <div style={{ color: "#6b7280", fontStyle: "italic", lineHeight: 1.5 }}>{t.bio}</div>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 탭 내비 */}
            <div style={{ display: "flex", gap: 2, flexWrap: "wrap", marginTop: 8, marginBottom: 0, background: "#f0f2f6", borderRadius: 10, padding: "3px 4px", border: "1px solid #e2e6ef", alignItems: "center" }}>
              {sections.map(s => (
                <button key={s.key} onClick={() => setActiveSection(s.key)} style={tabBtnStyle(activeSection === s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            </div>{/* ── /고정 상단 영역 ── */}

            {/* ── 탭 콘텐츠 영역 (내부 스크롤 없이 고정 높이 모달 내에서 흐름) ── */}
            <div style={{ padding: "16px 28px 24px", minHeight: 320 }}>

            {/* 기본정보 탭 */}
            {activeSection === "info" && (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {["의뢰처", "담당자", "등록 정보", "상태"].map(k => (
                    <span key={k} style={{ fontSize: 10, fontWeight: 600, background: "#f1f5f9", color: "#64748b", borderRadius: 5, padding: "2px 8px" }}>{k}</span>
                  ))}
                </div>
                {!editingInfo ? (
                  <>
                    <div style={{ background: "#fcfcfd", borderRadius: 8, padding: "10px 12px", border: "1px solid #f0f2f5", marginBottom: 2 }}>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
                      <div style={{ gridColumn: "span 2", marginBottom: 4, paddingBottom: 10, borderBottom: "1px solid #e5e9ef" }}>
                        <span style={{ fontSize: 11, color: "#b0b8c6", display: "block", marginBottom: 3 }}>프로젝트명 <Req /></span>
                        <strong style={{ color: "#111827", fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.3, display: "block" }}>{detail.title}</strong>
                      </div>
                      <div style={dl}>
                        <span style={dt}>고객</span>
                        {detail.customerEmail ? <span style={{ color: "#374151" }}>{detail.customerEmail}</span> : <Empty label="미연결" />}
                      </div>
                      <div style={dl}>
                        <span style={dt}>상태</span>
                        <StatusBadge status={detail.status} />
                      </div>
                      <div style={dl}>
                        <span style={dt}>등록일</span>
                        <span style={{ color: "#374151" }}>{new Date(detail.createdAt).toLocaleString("ko-KR")}</span>
                      </div>
                      <div style={dl}>
                        <span style={dt}>거래처 (의뢰처)<Opt /></span>
                        {(detail.company?.name ?? (detail as any).companyName)
                          ? <span style={{ color: "#374151" }}>{detail.company?.name ?? (detail as any).companyName}</span>
                          : <span style={{ color: "#f59e0b", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>⚠ 미연결</span>}
                      </div>
                      <div style={dl}>
                        <span style={dt}>담당자<Opt /></span>
                        {(detail.contact?.name ?? (detail as any).contactName)
                          ? <span style={{ color: "#374151" }}>{detail.contact?.name ?? (detail as any).contactName}</span>
                          : <span style={{ color: "#f59e0b", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>⚠ 미연결</span>}
                      </div>
                      {(detail as any).divisionName && (
                        <div style={dl}>
                          <span style={dt}>브랜드 / 부서</span>
                          <span style={{ color: "#7c3aed", fontWeight: 600, fontSize: 12 }}>{(detail as any).divisionName}</span>
                        </div>
                      )}
                      {(detail as any).billingCompanyName && (detail as any).billingCompanyName !== (detail.company?.name ?? (detail as any).companyName) && (
                        <div style={dl}>
                          <span style={dt}>청구처</span>
                          <span style={{ color: "#0369a1", fontWeight: 600, fontSize: 12 }}>{(detail as any).billingCompanyName}</span>
                        </div>
                      )}
                      {detail.fileUrl && (
                        <div style={{ ...dl, gridColumn: "span 2" }}>
                          <span style={dt}>첨부파일</span>
                          <a href={detail.fileUrl} target="_blank" rel="noreferrer" style={{ color: "#2563eb", fontSize: 13 }}>📎 다운로드</a>
                        </div>
                      )}
                    </div>
                    </div>{/* /background wrap */}
                    <div style={{ marginTop: 10 }}>
                      <GhostBtn onClick={startEditInfo} disabled={loadingMeta} color="#6b7280" style={{ fontSize: 12, padding: "5px 12px" }}>
                        {loadingMeta ? "불러오는 중..." : "✏️ 기본정보 수정"}
                      </GhostBtn>
                    </div>
                  </>
                ) : (
                  <div style={{ background: "#f0f9ff", borderRadius: 10, padding: "14px 16px", border: "1px solid #bae6fd" }}>
                    <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 700, color: "#0369a1" }}>기본정보 수정</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>제목 *</label>
                        <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                          style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} placeholder="프로젝트 제목" />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                          <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>거래처 (의뢰처)</label>
                          <ClickSelect
                            value={String(editCompanyId ?? "")}
                            onChange={async v => {
                              const cid = v ? Number(v) : null;
                              setEditCompanyId(cid); setEditContactId(null); setEditDivisionId(null);
                              if (cid) {
                                try {
                                  const res = await fetch(api(`/api/admin/companies/${cid}/divisions`), { headers: authH });
                                  if (res.ok) setEditDivisionsList(await res.json());
                                  else setEditDivisionsList([]);
                                } catch { setEditDivisionsList([]); }
                              } else { setEditDivisionsList([]); }
                            }}
                            style={{ width: "100%" }}
                            triggerStyle={{ width: "100%", fontSize: 13, borderRadius: 8 }}
                            options={[
                              { value: "", label: "미연결" },
                              ...companiesList.map(c => ({ value: String(c.id), label: c.name })),
                            ]}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>담당자</label>
                          <ClickSelect
                            value={String(editContactId ?? "")}
                            onChange={v => setEditContactId(v ? Number(v) : null)}
                            style={{ width: "100%" }}
                            triggerStyle={{ width: "100%", fontSize: 13, borderRadius: 8 }}
                            options={[
                              { value: "", label: "미연결" },
                              ...contactsList
                                .filter(c => !editCompanyId || c.companyId === editCompanyId)
                                .map(c => ({ value: String(c.id), label: c.name })),
                            ]}
                          />
                        </div>
                      </div>
                      {/* 브랜드/부서 선택 */}
                      {editDivisionsList.length > 0 && (
                        <div>
                          <label style={{ fontSize: 12, color: "#7c3aed", fontWeight: 600, display: "block", marginBottom: 4 }}>브랜드 / 부서</label>
                          <ClickSelect
                            value={String(editDivisionId ?? "")}
                            onChange={v => setEditDivisionId(v ? Number(v) : null)}
                            style={{ width: "100%" }}
                            triggerStyle={{ width: "100%", fontSize: 13, borderRadius: 8, border: "1px solid #e9d5ff", background: "#faf5ff", color: "#7c3aed" }}
                            options={[
                              { value: "", label: "전체 (부서 없음)" },
                              ...editDivisionsList.map(d => ({ value: String(d.id), label: d.name + (d.type ? ` (${d.type})` : "") })),
                            ]}
                          />
                        </div>
                      )}
                      {/* 청구 대상 / 납부 주체 */}
                      {(() => {
                        const payments = detail?.payments ?? [];
                        const settlements = detail?.settlements ?? [];
                        const quotes = detail?.quotes ?? [];
                        const financialStatus = (detail as any)?.financialStatus ?? "unbilled";
                        // 4단계 조건 판별
                        const isFullyLocked = settlements.some((s: any) => s.status === "paid");
                        const isCorrection = !isFullyLocked && (
                          payments.length > 0 ||
                          ["billed", "receivable", "paid"].includes(financialStatus) ||
                          settlements.length > 0
                        );
                        const isWarn = !isFullyLocked && !isCorrection && quotes.length > 0;
                        const reqCompanyName = editCompanyId
                          ? (companiesList.find(c => c.id === editCompanyId)?.name ?? "요청 거래처")
                          : "요청 거래처";
                        const billingName = editBillingCompanyId
                          ? (companiesList.find(c => c.id === editBillingCompanyId)?.name ?? "-")
                          : reqCompanyName;
                        const payerName = editPayerCompanyId
                          ? (companiesList.find(c => c.id === editPayerCompanyId)?.name ?? "-")
                          : billingName;
                        // 정정 폼용 현재값 이름
                        const corrBillingName = correctionBillingId !== null
                          ? (companiesList.find(c => c.id === correctionBillingId)?.name ?? "-")
                          : billingName;
                        const corrPayerName = correctionPayerId !== null
                          ? (companiesList.find(c => c.id === correctionPayerId)?.name ?? "-")
                          : payerName;
                        return (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {/* ── Level 4: 완전 잠금 ── */}
                            {isFullyLocked && (
                              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px" }}>
                                <p style={{ margin: 0, fontSize: 12, color: "#dc2626", fontWeight: 700 }}>🔒 청구/납부 정보 변경 완전 잠금</p>
                                <p style={{ margin: "4px 0 8px", fontSize: 11, color: "#b91c1c" }}>정산이 최종 완료된 프로젝트입니다. 청구/납부 정보를 변경할 수 없습니다.</p>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                                  <div style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 6, padding: "6px 10px" }}>
                                    <p style={{ margin: 0, fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>청구 대상</p>
                                    <p style={{ margin: "2px 0 0", fontSize: 13, fontWeight: 700, color: "#374151" }}>{billingName}</p>
                                  </div>
                                  <div style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 6, padding: "6px 10px" }}>
                                    <p style={{ margin: 0, fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>💰 납부 주체</p>
                                    <p style={{ margin: "2px 0 0", fontSize: 13, fontWeight: 700, color: "#374151" }}>{payerName}</p>
                                  </div>
                                </div>
                              </div>
                            )}
                            {/* ── Level 3: 정정 절차 ── */}
                            {isCorrection && (
                              <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "10px 14px" }}>
                                <p style={{ margin: 0, fontSize: 12, color: "#c2410c", fontWeight: 700 }}>📋 청구/납부 정보 — 정정 절차 필요</p>
                                <p style={{ margin: "3px 0 8px", fontSize: 11, color: "#9a3412" }}>입금·정산·세금계산서 발행 이력이 있습니다. 직접 수정 대신 정정 절차를 통해 변경하세요.</p>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
                                  <div style={{ background: "#fff", border: "1px solid #fed7aa", borderRadius: 6, padding: "6px 10px" }}>
                                    <p style={{ margin: 0, fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>현재 청구 대상</p>
                                    <p style={{ margin: "2px 0 0", fontSize: 13, fontWeight: 700, color: "#374151" }}>{billingName}</p>
                                  </div>
                                  <div style={{ background: "#fff", border: "1px solid #fed7aa", borderRadius: 6, padding: "6px 10px" }}>
                                    <p style={{ margin: 0, fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>현재 💰 납부 주체</p>
                                    <p style={{ margin: "2px 0 0", fontSize: 13, fontWeight: 700, color: "#374151" }}>{payerName}</p>
                                  </div>
                                </div>
                                {!showCorrectionForm ? (
                                  <button type="button"
                                    onClick={() => {
                                      setCorrectionBillingId(editBillingCompanyId);
                                      setCorrectionPayerId(editPayerCompanyId);
                                      setCorrectionReason(""); setCorrectionMemo("");
                                      setShowCorrectionForm(true);
                                    }}
                                    style={{ fontSize: 11, fontWeight: 700, color: "#c2410c", background: "#ffedd5", border: "1px solid #fed7aa", borderRadius: 5, padding: "4px 12px", cursor: "pointer" }}>
                                    청구/납부 정보 정정 신청
                                  </button>
                                ) : (
                                  <div style={{ background: "#fff", border: "1px solid #fed7aa", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                                    <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#c2410c" }}>정정 신청서</p>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                      <div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                          <label style={{ fontSize: 11, color: "#0369a1", fontWeight: 700 }}>변경할 청구 대상</label>
                                          <span style={{ fontSize: 9, color: "#0369a1", background: "#e0f2fe", borderRadius: 3, padding: "1px 4px", fontWeight: 600 }}>세금계산서 기준</span>
                                        </div>
                                        <ClickSelect
                                          value={String(correctionBillingId ?? "")}
                                          onChange={v => setCorrectionBillingId(v ? Number(v) : null)}
                                          style={{ width: "100%" }}
                                          triggerStyle={{ width: "100%", fontSize: 12, borderRadius: 7, border: "1px solid #bae6fd" }}
                                          options={[
                                            { value: "", label: "— 요청 거래처와 동일 —" },
                                            ...companiesList.map(c => ({ value: String(c.id), label: c.name })),
                                          ]}
                                        />
                                        <p style={{ margin: "3px 0 0", fontSize: 10, color: "#6b7280" }}>현재: {billingName} → {corrBillingName}</p>
                                      </div>
                                      <div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                          <label style={{ fontSize: 11, color: "#059669", fontWeight: 700 }}>💰 변경할 납부 주체</label>
                                          <span style={{ fontSize: 9, color: "#059669", background: "#d1fae5", borderRadius: 3, padding: "1px 4px", fontWeight: 600 }}>입금 기준</span>
                                        </div>
                                        <ClickSelect
                                          value={String(correctionPayerId ?? "")}
                                          onChange={v => setCorrectionPayerId(v ? Number(v) : null)}
                                          style={{ width: "100%" }}
                                          triggerStyle={{ width: "100%", fontSize: 12, borderRadius: 7, border: "1px solid #a7f3d0" }}
                                          options={[
                                            { value: "", label: "— 청구 대상과 동일 —" },
                                            ...companiesList.map(c => ({ value: String(c.id), label: c.name })),
                                          ]}
                                        />
                                        <p style={{ margin: "3px 0 0", fontSize: 10, color: "#6b7280" }}>현재: {payerName} → {corrPayerName}</p>
                                      </div>
                                    </div>
                                    <div>
                                      <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>정정 사유 <span style={{ color: "#dc2626" }}>*</span></label>
                                      <ClickSelect
                                        value={correctionReason}
                                        onChange={setCorrectionReason}
                                        style={{ width: "100%" }}
                                        triggerStyle={{ width: "100%", fontSize: 12, borderRadius: 7 }}
                                        options={[
                                          { value: "", label: "— 사유를 선택하세요 —" },
                                          { value: "고객 요청", label: "고객 요청" },
                                          { value: "오입력 정정", label: "오입력 정정" },
                                          { value: "계열사 변경", label: "계열사 변경" },
                                          { value: "계약 변경", label: "계약 변경" },
                                          { value: "부분 입금 정정", label: "부분 입금 정정" },
                                          { value: "환불 처리", label: "환불 처리" },
                                          { value: "기타", label: "기타" },
                                        ]}
                                      />
                                    </div>
                                    <div>
                                      <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>상세 메모 <span style={{ color: "#dc2626" }}>*</span></label>
                                      <textarea value={correctionMemo} onChange={e => setCorrectionMemo(e.target.value)}
                                        placeholder="정정 사유 및 관련 상황을 상세히 입력하세요."
                                        rows={3}
                                        style={{ ...inputStyle, resize: "vertical", fontSize: 12 }} />
                                    </div>
                                    <div style={{ display: "flex", gap: 8 }}>
                                      <button type="button" onClick={handleBillingCorrection} disabled={submittingCorrection || !correctionReason || !correctionMemo.trim()}
                                        style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: correctionReason && correctionMemo.trim() ? "#ea580c" : "#d1d5db", border: "none", borderRadius: 5, padding: "5px 14px", cursor: correctionReason && correctionMemo.trim() ? "pointer" : "not-allowed" }}>
                                        {submittingCorrection ? "처리 중..." : "정정 제출"}
                                      </button>
                                      <button type="button" onClick={() => setShowCorrectionForm(false)}
                                        style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 5, padding: "5px 12px", cursor: "pointer" }}>
                                        취소
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                            {/* ── Level 2: 경고 후 수정 ── */}
                            {isWarn && !billingWarnConfirmed && (
                              <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "8px 12px" }}>
                                <p style={{ margin: 0, fontSize: 12, color: "#92400e", fontWeight: 600 }}>⚠️ 견적서/거래명세서 발행 이력이 있습니다</p>
                                <p style={{ margin: "3px 0 6px", fontSize: 11, color: "#78350f" }}>기존 견적서/거래명세서 내용과 달라질 수 있습니다. 계속 수정하시겠습니까?</p>
                                <button type="button" onClick={() => setBillingWarnConfirmed(true)}
                                  style={{ fontSize: 11, fontWeight: 700, color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 5, padding: "3px 10px", cursor: "pointer" }}>
                                  확인 후 수정
                                </button>
                              </div>
                            )}
                            {/* ── Level 1: 자유 수정 (Level 2 경고 확인 후 포함) ── */}
                            {!isFullyLocked && !isCorrection && (isWarn ? billingWarnConfirmed : true) && (
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: "10px 12px", background: "#f0f9ff", borderRadius: 8, border: "1px solid #bae6fd" }}>
                                <div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                    <label style={{ fontSize: 11, color: "#0369a1", fontWeight: 700 }}>청구 대상</label>
                                    <span style={{ fontSize: 9, color: "#0369a1", background: "#e0f2fe", borderRadius: 3, padding: "1px 4px", fontWeight: 600 }}>세금계산서 기준</span>
                                  </div>
                                  <ClickSelect
                                    value={String(editBillingCompanyId ?? "")}
                                    onChange={v => setEditBillingCompanyId(v ? Number(v) : null)}
                                    style={{ width: "100%" }}
                                    triggerStyle={{ width: "100%", fontSize: 12, borderRadius: 7, border: "1px solid #bae6fd" }}
                                    options={[
                                      { value: "", label: "— 요청 거래처와 동일 —" },
                                      ...companiesList.map(c => ({ value: String(c.id), label: c.name })),
                                    ]}
                                  />
                                </div>
                                <div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                    <label style={{ fontSize: 11, color: "#059669", fontWeight: 700 }}>💰 납부 주체</label>
                                    <span style={{ fontSize: 9, color: "#059669", background: "#d1fae5", borderRadius: 3, padding: "1px 4px", fontWeight: 600 }}>입금 기준</span>
                                  </div>
                                  <ClickSelect
                                    value={String(editPayerCompanyId ?? "")}
                                    onChange={v => setEditPayerCompanyId(v ? Number(v) : null)}
                                    style={{ width: "100%" }}
                                    triggerStyle={{ width: "100%", fontSize: 12, borderRadius: 7, border: "1px solid #a7f3d0" }}
                                    options={[
                                      { value: "", label: "— 청구 대상과 동일 —" },
                                      ...companiesList.map(c => ({ value: String(c.id), label: c.name })),
                                    ]}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <PrimaryBtn onClick={handleSaveInfo} disabled={savingInfo || !editTitle.trim()} style={{ fontSize: 12, padding: "6px 16px" }}>
                        {savingInfo ? "저장 중..." : "저장"}
                      </PrimaryBtn>
                      <GhostBtn onClick={() => setEditingInfo(false)} style={{ fontSize: 12, padding: "6px 12px" }}>취소</GhostBtn>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 관계 정보 — 거래처 + 담당자 2컬럼 */}
            {activeSection === "info" && (
              <div style={{ marginTop: 12, borderTop: "1px solid #e5e9ef" }}>
                <div style={{ marginTop: 10, background: "#fafbfc", borderRadius: 8, padding: "12px 14px", border: "1px solid #f0f2f5" }}>
                  <p style={{ ...sectionHd, margin: "0 0 10px", color: "#4b5563", borderBottomColor: "#e5e9ef" }}>관계 정보</p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
                    {/* 거래처 컬럼 */}
                    <div>
                      <p style={{ ...sectionHd, margin: "0 0 6px", fontSize: 11 }}>거래처 <Opt /></p>
                      {detail.company ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px", background: "#ffffff", borderRadius: 7, border: "1px solid #e8ecf0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                          <div style={dl}><span style={dt}>회사명</span>
                            <span style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                              <strong style={{ color: "#1f2937" }}>{detail.company.name}</strong>
                              {(detail as any).divisionName && <span style={{ fontSize: 11, background: "#ede9fe", color: "#7c3aed", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>{(detail as any).divisionName}</span>}
                            </span>
                          </div>
                          <div style={dl}><span style={dt}>업종</span>{detail.company.industry ? <span style={{ color: "#1f2937" }}>{detail.company.industry}</span> : <Empty />}</div>
                          <div style={dl}><span style={dt}>대표자</span>{detail.company.representativeName ? <span style={{ color: "#1f2937" }}>{detail.company.representativeName}</span> : <Empty />}</div>
                          <div style={dl}><span style={dt}>이메일</span>{detail.company.email ? <span style={{ color: "#1f2937" }}>{detail.company.email}</span> : <Empty />}</div>
                          <div style={dl}><span style={dt}>전화</span>{detail.company.phone ? <span style={{ color: "#1f2937" }}>{detail.company.phone}</span> : <Empty />}</div>
                        </div>
                      ) : (
                        <div style={{ background: "#fffbeb", borderRadius: 7, padding: "10px 12px", border: "1px solid #fde68a", display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 13 }}>⚠</span>
                          <span style={{ fontSize: 11, color: "#92400e" }}>거래처 미연결. '기본정보 수정'에서 연결하세요.</span>
                        </div>
                      )}
                    </div>
                    {/* 담당자 컬럼 */}
                    <div>
                      <p style={{ ...sectionHd, margin: "0 0 6px", fontSize: 11 }}>담당자 <Opt /></p>
                      {detail.contact ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 12px", background: "#ffffff", borderRadius: 7, border: "1px solid #e8ecf0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                          <div style={dl}><span style={dt}>이름</span><strong style={{ color: "#1f2937" }}>{detail.contact.name}</strong></div>
                          <div style={dl}><span style={dt}>부서</span>{detail.contact.department ? <span style={{ color: "#1f2937" }}>{detail.contact.department}</span> : <Empty />}</div>
                          <div style={dl}><span style={dt}>직책</span>{detail.contact.position ? <span style={{ color: "#1f2937" }}>{detail.contact.position}</span> : <Empty />}</div>
                          <div style={dl}><span style={dt}>이메일</span>{detail.contact.email ? <span style={{ color: "#1f2937" }}>{detail.contact.email}</span> : <Empty />}</div>
                          <div style={dl}><span style={dt}>전화</span>{detail.contact.phone ? <span style={{ color: "#1f2937" }}>{detail.contact.phone}</span> : <Empty />}</div>
                        </div>
                      ) : (
                        <div style={{ background: "#fffbeb", borderRadius: 7, padding: "10px 12px", border: "1px solid #fde68a", display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 13 }}>⚠</span>
                          <span style={{ fontSize: 11, color: "#92400e" }}>담당자 미연결. '기본정보 수정'에서 연결하세요.</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 진행 탭 (통번역사 배정 / 작업 관리) */}
            {activeSection === "progress" && (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {["통번역사 배정", "작업 현황", "일정", "납품"].map(k => (
                    <span key={k} style={{ fontSize: 10, fontWeight: 600, background: "#f1f5f9", color: "#64748b", borderRadius: 5, padding: "2px 8px" }}>{k}</span>
                  ))}
                </div>
                <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>배정</p>
                {detail.tasks.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "20px 0", color: "#9ca3af", background: "#fafafa", borderRadius: 8, border: "1px dashed #e5e7eb" }}>
                    <p style={{ margin: 0, fontSize: 13 }}>배정된 통번역사가 없습니다.</p>
                    <p style={{ margin: "6px 0 0", fontSize: 12 }}>상단 '통번역사 추천/배정' 버튼으로 배정하세요.</p>
                  </div>
                ) : detail.tasks.map(t => {
                  const avStyle = AVAIL_STYLE[t.translatorProfile?.availabilityStatus ?? ""] ?? AVAIL_STYLE.unavailable;
                  return (
                    <div key={t.id} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{t.translatorEmail ?? `#${t.translatorId}`}</span>
                        <StatusBadge status={t.status} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: avStyle.color }}>가용: {avStyle.label}</span>
                        <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                      {t.translatorProfile && (
                        <div style={{ padding: "10px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px" }}>
                          <div style={dl}><span style={dt}>가능언어</span><span>{t.translatorProfile.languagePairs ?? "-"}</span></div>
                          <div style={dl}><span style={dt}>전문분야</span><span>{t.translatorProfile.specializations ?? "-"}</span></div>
                          {t.translatorProfile.rating != null && (
                            <div style={dl}><span style={dt}>평점</span><span style={{ color: "#d97706", fontWeight: 600 }}>⭐ {t.translatorProfile.rating.toFixed(1)}</span></div>
                          )}
                          {t.translatorProfile.bio && (
                            <div style={{ ...dl, gridColumn: "span 2" }}><span style={dt}>소개</span><span style={{ color: "#374151" }}>{t.translatorProfile.bio}</span></div>
                          )}
                        </div>
                      )}
                      {t.translatorRates.length > 0 && (
                        <>
                          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" }}>단가표</p>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {t.translatorRates.map(r => (
                              <div key={r.id} style={{ display: "flex", gap: 10, fontSize: 12, padding: "5px 10px", background: "#f9fafb", borderRadius: 6 }}>
                                <span style={{ color: "#374151", fontWeight: 600 }}>{r.serviceType}</span>
                                <span style={{ color: "#6b7280" }}>{r.languagePair}</span>
                                <span style={{ color: "#059669", fontWeight: 600, marginLeft: "auto" }}>{Number(r.rate).toLocaleString()}원/{r.unit === "word" || r.unit === "eojeol" ? "어절" : r.unit === "char" ? "글자" : r.unit === "page" ? "페이지" : r.unit === "hour" ? "시간" : r.unit}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {/* 견적 탭 */}
            {activeSection === "quote" && (
              <>
                {/* ── 탭 제목 칩 ── */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                  {["연결된 견적서", "견적 이력", "보기/다운로드"].map(k => (
                    <span key={k} style={{ fontSize: 10, fontWeight: 600, background: "#f5f3ff", color: "#6d28d9", borderRadius: 5, padding: "2px 8px" }}>{k}</span>
                  ))}
                </div>

                {/* ── 견적 목록 헤더 ── */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid #ede9fe" }}>
                  <p style={{ ...sectionHd, margin: 0, paddingBottom: 0, borderBottom: "none", color: "#5b21b6", letterSpacing: "0.04em", borderLeft: "3px solid #8b5cf6", paddingLeft: 8 }}>
                    연결된 견적서 ({detail.quotes.length})
                  </p>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {!["cancelled"].includes(detail.status) && (
                      <button
                        onClick={() => setShowQuoteEditorModal(true)}
                        style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #d8b4fe", borderRadius: 6, padding: "4px 11px", cursor: "pointer" }}>
                        {detail.quotes.length > 0 ? "📋 새 버전 생성" : "📋 견적 작성"}
                      </button>
                    )}
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>
                      새 견적서는 좌측 '견적서' 메뉴에서 작성
                    </span>
                  </div>
                </div>

                {/* ── 견적 없음 안내 ── */}
                {detail.quotes.length === 0 ? (
                  <div style={{ padding: "20px 16px", background: "#faf5ff", borderRadius: 10, border: "1px dashed #c4b5fd", textAlign: "center" }}>
                    <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600, color: "#7c3aed" }}>연결된 견적서가 없습니다</p>
                    <p style={{ margin: 0, fontSize: 12, color: "#9ca3af", lineHeight: 1.6 }}>
                      좌측 <strong style={{ color: "#7c3aed" }}>'견적서'</strong> 메뉴에서 견적을 작성하고<br/>
                      승인(approved) 하면 이 프로젝트에 자동으로 연결됩니다.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {detail.quotes.map((q, qIdx) => {
                      const taxDocLabel: Record<string, string> = { tax_invoice: "세금계산서", zero_tax_invoice: "세금계산서(영세율)", bill: "계산서" };
                      const taxCatLabel: Record<string, string> = { normal: "일반", zero_rated: "영세율", consignment: "위수탁", consignment_zero_rated: "위수탁영세율" };
                      const qtLabel: Record<string, [string, string, string]> = {
                        b2b_standard:      ["일반 견적", "#eff6ff", "#1d4ed8"],
                        b2c_prepaid:       ["차감 견적", "#fef3c7", "#92400e"],
                        prepaid_deduction: ["차감 견적", "#fdf4ff", "#7c3aed"],
                        accumulated_batch: ["누적 견적", "#ecfdf5", "#065f46"],
                      };
                      const btLabelMap: Record<string, string> = {
                        postpaid_per_project: "건별 후불", monthly_billing: "누적 청구",
                        prepaid_wallet: "선입금 차감", prepay_upfront: "선결제",
                      };
                      const pmLabel: Record<string, string> = { card: "카드", cash: "현금", bank: "계좌이체" };
                      const qt = (q as any).quoteType ?? "b2b_standard";
                      const bt = (q as any).billingType ?? "postpaid_per_project";
                      const pm = (q as any).paymentMethod ?? null;
                      const tdt = (q as any).taxDocumentType ?? "tax_invoice";
                      const tc = (q as any).taxCategory ?? "normal";
                      const [qtText, qtBg, qtColor] = qtLabel[qt] ?? ["기본", "#f8fafc", "#374151"];
                      const btText = bt === "prepay_upfront" && pm ? `선결제(${pmLabel[pm] ?? pm})` : (btLabelMap[bt] ?? bt);
                      const quoteNum = (q as any).quoteNumber ?? null;
                      const quoteTitle = (q as any).title ?? null;
                      const issueDate = (q as any).issueDate ?? null;
                      const items = Array.isArray((q as any).items) ? (q as any).items : [];
                      const expanded = expandedQuotes[q.id] ?? false;
                      // 견적 승인으로 확정된 판매건(승인 이상)만 거래명세서 출력 가능 — 취소/견적단계 제외
                      const saleConfirmed = ["approved", "paid", "matched", "in_progress", "completed"].includes(detail.status);

                      return (
                        <div key={q.id} style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #e5e7eb", overflow: "hidden" }}>
                          {/* ── 견적 요약 행 ── */}
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 14px" }}>
                            {/* 견적번호 */}
                            <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700, color: "#6d28d9", background: "#f5f3ff", borderRadius: 4, padding: "2px 7px" }}>
                              {quoteNum ?? `#${q.id}`}
                            </span>
                            {/* 견적서명 */}
                            {quoteTitle && (
                              <span style={{ fontSize: 12, fontWeight: 600, color: "#111827", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {quoteTitle}
                              </span>
                            )}
                            {/* 견적금액 */}
                            <span style={{ fontWeight: 800, color: "#0891b2", fontSize: 14, marginLeft: quoteTitle ? 0 : 4 }}>
                              {Number((q as any).price ?? (q as any).amount).toLocaleString()}원
                            </span>
                            {/* 견적상태 */}
                            <StatusBadge status={q.status} />
                            {/* 유형 배지 */}
                            <span style={{ fontSize: 10, padding: "1px 8px", borderRadius: 4, background: qtBg, color: qtColor, border: `1px solid ${qtColor}33`, fontWeight: 800 }}>
                              {qtText}
                            </span>
                            {/* 청구방식 */}
                            <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, background: "#f8fafc", color: "#374151", border: "1px solid #e2e8f0", fontWeight: 600 }}>
                              {btText}
                            </span>
                            {/* 세무 구분 */}
                            <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, background: tdt === "bill" ? "#fef3c7" : "#eff6ff", color: tdt === "bill" ? "#92400e" : "#1d4ed8", border: `1px solid ${tdt === "bill" ? "#fde68a" : "#bfdbfe"}`, fontWeight: 700 }}>
                              {taxDocLabel[tdt] ?? tdt}
                            </span>
                            {/* 발행일 */}
                            <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto", whiteSpace: "nowrap" }}>
                              {issueDate ?? new Date(q.createdAt).toLocaleDateString("ko-KR")}
                            </span>
                          </div>

                          {/* ── 견적서명 (quoteTitle 없을 때 구 프로젝트 제목으로 표시) ── */}
                          {!quoteTitle && detail.title && (
                            <div style={{ padding: "0 14px 6px", fontSize: 11, color: "#9ca3af" }}>
                              의뢰명: {detail.title}
                            </div>
                          )}

                          {/* ── 비고 ── */}
                          {(q as any).note && (
                            <div style={{ padding: "0 14px 8px", fontSize: 12, color: "#6b7280" }}>
                              📝 {(q as any).note}
                            </div>
                          )}

                          {/* ── 액션 버튼 + 품목 토글 ── */}
                          <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 14px", borderTop: "1px solid #f1f5f9", background: "#f8fafc" }}>
                            <button
                              type="button"
                              onClick={() => setExpandedQuotes(prev => ({ ...prev, [q.id]: !(prev[q.id] ?? false) }))}
                              style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: "1px solid #e2e8f0", background: expanded ? "#ede9fe" : "#fff", color: expanded ? "#7c3aed" : "#374151", cursor: "pointer", fontWeight: 600 }}>
                              {expanded ? "▲ 접기" : "▼ 품목 보기"}
                              {items.length > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: "#9ca3af" }}>({items.length}건)</span>}
                            </button>
                            {/* 거래명세서 — 판매 확정 건만 출력 가능 */}
                            <button
                              type="button"
                              onClick={() => handleStatement(q.id, quoteTitle ?? quoteNum ?? `견적 #${q.id}`)}
                              disabled={!saleConfirmed || stmtLoading === q.id}
                              title={saleConfirmed ? "거래명세서 미리보기 / PDF 출력" : "판매 확정 후 출력할 수 있습니다."}
                              style={{
                                fontSize: 11, padding: "3px 10px", borderRadius: 5,
                                border: `1px solid ${saleConfirmed ? "#bbf7d0" : "#e5e7eb"}`,
                                background: saleConfirmed ? "#f0fdf4" : "#f9fafb",
                                color: saleConfirmed ? "#15803d" : "#9ca3af",
                                cursor: saleConfirmed ? "pointer" : "not-allowed",
                                fontWeight: 600,
                                opacity: stmtLoading === q.id ? 0.5 : 1,
                              }}
                              data-testid={`btn-statement-${q.id}`}
                              aria-label={`${quoteNum ?? q.id} 거래명세서`}
                            >
                              {stmtLoading === q.id ? "…" : "📋 거래명세서"}
                            </button>
                            <span style={{ flex: 1 }} />
                            <span style={{ fontSize: 10, color: "#d1d5db" }}>견적 #{q.id} · 등록 {new Date(q.createdAt).toLocaleDateString("ko-KR")}</span>
                          </div>

                          {/* ── 품목 목록 (토글) ── */}
                          {expanded && items.length > 0 && (
                            <div style={{ padding: "10px 14px 12px", borderTop: "1px solid #ede9fe", background: "#fdf8ff" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead>
                                  <tr style={{ background: "#f5f3ff" }}>
                                    {["상품명", "언어", "수량", "단가", "공급가", "세액", "합계"].map(h => (
                                      <th key={h} style={{ padding: "5px 8px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#6d28d9", borderBottom: "1px solid #d8b4fe", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {items.map((it: any, ii: number) => (
                                    <tr key={ii} style={{ borderBottom: "1px solid #ede9fe" }}>
                                      <td style={{ padding: "5px 8px", color: "#111827", fontWeight: 600 }}>{it.productName}</td>
                                      <td style={{ padding: "5px 8px", color: "#6b7280", fontSize: 11 }}>{it.languagePair ?? "—"}</td>
                                      <td style={{ padding: "5px 8px", color: "#374151" }}>{it.quantity}{it.unit ? ` ${it.unit}` : ""}</td>
                                      <td style={{ padding: "5px 8px", color: "#374151", textAlign: "right" }}>{Number(it.unitPrice).toLocaleString()}</td>
                                      <td style={{ padding: "5px 8px", color: "#374151", textAlign: "right" }}>{Number(it.supplyAmount ?? 0).toLocaleString()}</td>
                                      <td style={{ padding: "5px 8px", color: "#7c3aed", textAlign: "right" }}>{Number(it.taxAmount ?? 0).toLocaleString()}</td>
                                      <td style={{ padding: "5px 8px", color: "#0891b2", fontWeight: 700, textAlign: "right" }}>{Number(it.totalAmount ?? 0).toLocaleString()}</td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr style={{ background: "#f5f3ff" }}>
                                    <td colSpan={5} style={{ padding: "6px 8px", fontSize: 11, color: "#6d28d9", fontWeight: 700, textAlign: "right" }}>합계</td>
                                    <td style={{ padding: "6px 8px", color: "#7c3aed", fontWeight: 700, textAlign: "right" }}>
                                      {items.reduce((s: number, it: any) => s + Number(it.taxAmount ?? 0), 0).toLocaleString()}
                                    </td>
                                    <td style={{ padding: "6px 8px", color: "#0891b2", fontWeight: 800, textAlign: "right" }}>
                                      {items.reduce((s: number, it: any) => s + Number(it.totalAmount ?? 0), 0).toLocaleString()}
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                              {(q as any).note && (
                                <p style={{ margin: "8px 0 0", fontSize: 11, color: "#6b7280" }}>📝 {(q as any).note}</p>
                              )}
                            </div>
                          )}
                          {expanded && items.length === 0 && (
                            <div style={{ padding: "10px 14px", fontSize: 12, color: "#9ca3af", borderTop: "1px solid #ede9fe" }}>
                              등록된 견적 항목이 없습니다.
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* 결제 탭 */}
            {activeSection === "payment" && (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {["고객 결제", "입금 확인", "결제 등록"].map(k => (
                    <span key={k} style={{ fontSize: 10, fontWeight: 600, background: "#f0fdf4", color: "#059669", borderRadius: 5, padding: "2px 8px" }}>{k}</span>
                  ))}
                </div>
                {(() => {
                  const paidPayments = detail.payments.filter((pm: any) => pm.status === "paid");
                  const canPay = detail.status === "approved";
                  const hasPayment = paidPayments.length > 0;
                  const payFormVisible = canPay && (showPaymentForm || !hasPayment);

                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, marginBottom: 4 }}>
                        <p style={{ ...sectionHd, margin: 0 }}>결제 ({detail.payments.length})</p>
                        {canPay && hasPayment && (
                          <button onClick={() => setShowPaymentForm(v => !v)}
                            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: showPaymentForm ? "#f3f4f6" : "#fff", cursor: "pointer", color: "#374151" }}>
                            {showPaymentForm ? "✕ 닫기" : "✏️ 수정 등록"}
                          </button>
                        )}
                      </div>

                      {/* 견적 승인됨 → 결제 등록 유도 메시지 */}
                      {canPay && !hasPayment && !payFormVisible && (
                        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 10 }}>
                          <p style={{ margin: 0, fontSize: 12, color: "#92400e", fontWeight: 600 }}>💳 견적이 승인되었습니다. 결제를 등록해주세요.</p>
                        </div>
                      )}

                      {/* 결제 등록 폼 */}
                      {payFormVisible && (
                        <div style={{ background: "#f0fdf4", borderRadius: 10, padding: "14px 16px", marginBottom: 14, border: "1px solid #bbf7d0" }}>
                          <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#059669" }}>
                            {hasPayment ? "✏️ 결제 재등록" : "💳 결제 등록"}
                          </p>
                          {/* 금액 + 결제일 + 입금예정일 */}
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                            <div>
                              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>금액 (원) *</label>
                              <NumericInput value={paymentAmount} onChange={raw => setPaymentAmount(raw)}
                                placeholder="예: 500000" suffix="원"
                                style={{ ...inputStyle, width: "100%", fontSize: 13, padding: "7px 10px", boxSizing: "border-box" }} />
                            </div>
                            <div>
                              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>결제일 *</label>
                              <input type="date" value={paymentDate}
                                onChange={e => setPaymentDate(e.target.value)}
                                style={{ ...inputStyle, width: "100%", fontSize: 13, padding: "7px 10px", boxSizing: "border-box" }} />
                            </div>
                            <div>
                              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>입금예정일 (선택)</label>
                              <input type="date" value={quotePaymentDueDate}
                                onChange={e => setQuotePaymentDueDate(e.target.value)}
                                style={{ ...inputStyle, width: "100%", fontSize: 13, padding: "7px 10px", boxSizing: "border-box" }} />
                            </div>
                          </div>
                          {/* 결제 수단 (선택) */}
                          <div style={{ marginBottom: 8 }}>
                            <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>결제 수단 (선택)</label>
                            <ClickSelect
                              value={paymentMethod}
                              onChange={setPaymentMethod}
                              style={{ width: "100%" }}
                              triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                              options={[
                                { value: "", label: "— 선택 안 함 —" },
                                { value: "bank_transfer", label: "계좌이체" }, { value: "card", label: "신용/체크카드" },
                                { value: "cash", label: "현금" }, { value: "virtual_account", label: "가상계좌" },
                                { value: "other", label: "기타" },
                              ]}
                            />
                          </div>
                          {/* 비고 (선택) */}
                          <div style={{ marginBottom: 10 }}>
                            <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>비고 (선택)</label>
                            <input type="text" value={paymentNote}
                              onChange={e => setPaymentNote(e.target.value)}
                              placeholder="메모 또는 참고 사항"
                              style={{ ...inputStyle, width: "100%", fontSize: 13, padding: "7px 10px", boxSizing: "border-box" }} />
                          </div>
                          {detail.quotes.length > 0 && (
                            <p style={{ margin: "0 0 8px", fontSize: 11, color: "#6b7280" }}>
                              📋 견적 금액: {Number((detail.quotes[0] as any).price ?? (detail.quotes[0] as any).amount).toLocaleString()}원
                            </p>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <PrimaryBtn onClick={handleCreatePayment} disabled={creatingPayment || !paymentAmount || !paymentDate}
                              style={{ fontSize: 12, padding: "7px 18px", background: "#059669", border: "none" }}>
                              {creatingPayment ? "처리 중..." : hasPayment ? "재등록" : "결제 등록"}
                            </PrimaryBtn>
                            {hasPayment && (
                              <button onClick={() => setShowPaymentForm(false)}
                                style={{ fontSize: 12, padding: "7px 14px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
                                취소
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 결제 목록 */}
                      {detail.payments.length === 0 ? (
                        <p style={{ color: "#9ca3af", fontSize: 13, paddingBottom: 8 }}>등록된 결제가 없습니다.</p>
                      ) : detail.payments.map((pm: any) => {
                        const methodLabel: Record<string, string> = {
                          bank_transfer: "계좌이체", card: "카드", cash: "현금",
                          virtual_account: "가상계좌", other: "기타",
                        };
                        return (
                          <div key={pm.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 14px", marginBottom: 8, fontSize: 13, border: "1px solid #e5e7eb" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                              <span style={{ color: "#9ca3af", fontSize: 11 }}>#{pm.id}</span>
                              <span style={{ fontWeight: 700, color: "#0891b2", fontSize: 15 }}>{Number(pm.amount).toLocaleString()}원</span>
                              <StatusBadge status={pm.status} />
                              {pm.paymentMethod && (
                                <span style={{ fontSize: 11, background: "#e0f2fe", color: "#0369a1", borderRadius: 4, padding: "2px 7px" }}>
                                  {methodLabel[pm.paymentMethod] ?? pm.paymentMethod}
                                </span>
                              )}
                              <span style={{ color: "#9ca3af", fontSize: 11, marginLeft: "auto" }}>
                                {pm.paymentDate ? new Date(pm.paymentDate).toLocaleDateString("ko-KR") : new Date(pm.createdAt).toLocaleDateString("ko-KR")}
                              </span>
                            </div>
                            {pm.paymentNote && (
                              <p style={{ margin: "5px 0 0", fontSize: 12, color: "#6b7280" }}>📝 {pm.paymentNote}</p>
                            )}
                          </div>
                        );
                      })}
                    </>
                  );
                })()}

                {/* ── 견적 Version 이력 ── */}
                {(() => {
                  const versions = (detail as any).quoteVersions as Array<{
                    id: number; version: number; isCurrent: boolean;
                    versionReason: string | null; price: string;
                    status: string; quoteNumber: string | null;
                    quoteType: string | null; createdAt: string;
                  }> | undefined;
                  if (!versions || versions.length <= 1) return null;
                  const statusLabel: Record<string, string> = { pending: "대기", sent: "발송", approved: "승인", rejected: "반려" };
                  return (
                    <div style={{ marginTop: 18, marginBottom: 4 }}>
                      <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#374151", borderLeft: "3px solid #d1d5db", paddingLeft: 8 }}>
                        견적 Version 이력
                      </p>
                      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                        {versions.map((v, idx) => (
                          <div key={v.id} style={{
                            display: "flex", alignItems: "flex-start", gap: 10,
                            padding: "8px 0", borderBottom: idx < versions.length - 1 ? "1px dashed #e5e7eb" : "none",
                          }}>
                            {/* 버전 뱃지 */}
                            <div style={{ flexShrink: 0, width: 32, textAlign: "center" }}>
                              <span style={{
                                fontSize: 11, fontWeight: 800,
                                color: v.isCurrent ? "#7c3aed" : "#9ca3af",
                                background: v.isCurrent ? "#f5f3ff" : "#f3f4f6",
                                border: `1px solid ${v.isCurrent ? "#d8b4fe" : "#e5e7eb"}`,
                                borderRadius: 6, padding: "2px 5px",
                              }}>V{v.version}</span>
                            </div>
                            {/* 내용 */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: v.isCurrent ? "#111827" : "#6b7280" }}>
                                  {v.versionReason || "—"}
                                </span>
                                {v.isCurrent && (
                                  <span style={{ fontSize: 10, fontWeight: 700, background: "#7c3aed", color: "#fff", borderRadius: 4, padding: "1px 5px" }}>현재</span>
                                )}
                                <span style={{ fontSize: 10, color: "#9ca3af" }}>
                                  {statusLabel[v.status] ?? v.status}
                                </span>
                              </div>
                              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                                {Number(v.price).toLocaleString("ko-KR")}원
                                {v.quoteNumber && <span style={{ marginLeft: 6 }}>{v.quoteNumber}</span>}
                                <span style={{ marginLeft: 6 }}>
                                  {new Date(v.createdAt).toLocaleDateString("ko-KR")}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* 청구 / 결제 요약 + 문서 출력 */}
                {(() => {
                  const q0 = (detail.quotes ?? [])[0] as any;
                  const compName = (detail.company as any)?.name ?? (detail as any).companyName ?? "-";
                  const bCompName = (detail as any).billingCompanyName;
                  const bDivName = (detail as any).billingDivisionName;
                  const pCompName = (detail as any).payerCompanyName;
                  const pDivName = (detail as any).payerDivisionName;
                  const billingDisplay = bCompName
                    ? (bDivName ? `${bCompName} / ${bDivName}` : bCompName)
                    : compName;
                  const billingEffective = bCompName ?? compName;
                  const payerDisplay = pCompName
                    ? (pDivName ? `${pCompName} / ${pDivName}` : pCompName)
                    : billingEffective;
                  const taxDocLabel: Record<string, string> = { tax_invoice: "세금계산서", zero_tax_invoice: "세금계산서(영세율)", bill: "계산서" };
                  const btLabelMap: Record<string, string> = { postpaid_per_project: "건별 후불", monthly_billing: "누적 청구", prepaid_wallet: "선입금 차감", prepay_upfront: "선결제" };
                  const tdt = q0?.taxDocumentType;
                  const bt = q0?.billingType ?? (detail.company as any)?.billingType;
                  const fmtDate = (v: string | null | undefined) => v ? new Date(v).toLocaleDateString("ko-KR") : "-";

                  const loadBillingDivisions = async (cid: number) => {
                    try {
                      const r = await fetch(api(`/api/admin/companies/${cid}/divisions`), { headers: authH });
                      setBillingCardDivisions(r.ok ? await r.json() : []);
                    } catch { setBillingCardDivisions([]); }
                  };
                  const loadPayerDivisions = async (cid: number) => {
                    try {
                      const r = await fetch(api(`/api/admin/companies/${cid}/divisions`), { headers: authH });
                      setPayerCardDivisions(r.ok ? await r.json() : []);
                    } catch { setPayerCardDivisions([]); }
                  };

                  const handleOpenEdit = async () => {
                    if (showBillingCardEdit) { setShowBillingCardEdit(false); return; }
                    await loadMeta();
                    const bCid = (detail as any).billingCompanyId ?? null;
                    const bDid = (detail as any).billingDivisionId ?? null;
                    const pCid = (detail as any).payerCompanyId ?? null;
                    const pDid = (detail as any).payerDivisionId ?? null;
                    const reqCid = detail.company?.id ?? (detail as any).companyId ?? null;
                    const bMode: typeof billingCardMode = bCid === null ? "same_as_request" : bDid !== null ? "other_division" : "other_company";
                    const pMode: typeof payerCardMode = pCid === null ? "same_as_billing" : (pCid === reqCid && pDid === null) ? "same_as_request" : pDid !== null ? "other_division" : "other_company";
                    setBillingCardMode(bMode);
                    setBillingCardCompanyId(bCid);
                    setBillingCardDivisionId(bDid);
                    setBillingCardDivisions([]);
                    setPayerCardMode(pMode);
                    setPayerCardCompanyId(pCid);
                    setPayerCardDivisionId(pDid);
                    setPayerCardDivisions([]);
                    if (bCid && bDid !== null) loadBillingDivisions(bCid);
                    if (pCid && pDid !== null) loadPayerDivisions(pCid);
                    setShowBillingCardEdit(true);
                  };

                  const handleSaveBillingCard = async () => {
                    setSavingBillingCard(true);
                    try {
                      const reqCid = detail.company?.id ?? (detail as any).companyId ?? null;
                      let billingCompanyId: number | null;
                      let billingDivisionId: number | null;
                      if (billingCardMode === "same_as_request") { billingCompanyId = null; billingDivisionId = null; }
                      else if (billingCardMode === "other_company") { billingCompanyId = billingCardCompanyId; billingDivisionId = null; }
                      else { billingCompanyId = billingCardCompanyId; billingDivisionId = billingCardDivisionId; }
                      let payerCompanyId: number | null;
                      let payerDivisionId: number | null;
                      if (payerCardMode === "same_as_billing") { payerCompanyId = null; payerDivisionId = null; }
                      else if (payerCardMode === "same_as_request") { payerCompanyId = reqCid; payerDivisionId = null; }
                      else if (payerCardMode === "other_company") { payerCompanyId = payerCardCompanyId; payerDivisionId = null; }
                      else { payerCompanyId = payerCardCompanyId; payerDivisionId = payerCardDivisionId; }
                      const res = await fetch(api(`/api/admin/projects/${projectId}/info`), {
                        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
                        body: JSON.stringify({ billingCompanyId, billingDivisionId, payerCompanyId, payerDivisionId }),
                      });
                      if (res.ok) { setShowBillingCardEdit(false); await loadDetail(); onRefresh(); }
                      else { const d = await res.json(); alert(d.error ?? "저장 실패"); }
                    } finally { setSavingBillingCard(false); }
                  };

                  const rdoStyle = (active: boolean): React.CSSProperties => ({
                    display: "flex", alignItems: "center", gap: 5, cursor: "pointer",
                    fontSize: 11, fontWeight: active ? 700 : 400, color: active ? "#1e40af" : "#374151",
                    background: active ? "#eff6ff" : "transparent",
                    border: active ? "1.5px solid #93c5fd" : "1.5px solid #e5e7eb",
                    borderRadius: 6, padding: "4px 10px", userSelect: "none",
                  });

                  const summaryItems = [
                    { label: "청구방식", value: bt ? (btLabelMap[bt] ?? bt) : "-" },
                    { label: "청구 대상", value: billingDisplay, color: "#0369a1" },
                    { label: "정산 주체", value: payerDisplay, color: "#059669" },
                    { label: "문서구분", value: tdt ? (taxDocLabel[tdt] ?? tdt) : "-" },
                    { label: "견적일", value: fmtDate(q0?.issueDate) },
                    { label: "입금예정일", value: fmtDate(q0?.paymentDueDate) },
                  ];

                  return (
                    <>
                      {/* compact summary strip */}
                      <div style={{ background: "#f3f7fc", borderRadius: 8, padding: "8px 12px", marginTop: 12, border: "1px solid #dce8f5" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ flex: 1, display: "flex", alignItems: "center", flexWrap: "wrap", gap: "3px 0", minWidth: 0 }}>
                            {!showBillingCardEdit ? summaryItems.map((item, idx, arr) => (
                              <span key={item.label} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12 }}>
                                <span style={{ color: "#94a3b8", fontSize: 11 }}>{item.label}</span>
                                <span style={{ color: (item as any).color ?? "#374151", fontWeight: 600 }}>{item.value}</span>
                                {idx < arr.length - 1 && <span style={{ color: "#d1d5db", margin: "0 5px" }}>·</span>}
                              </span>
                            )) : (
                              <span style={{ fontSize: 12, color: "#9ca3af" }}>청구/결제 정보 수정 중</span>
                            )}
                          </div>
                          <button onClick={handleOpenEdit}
                            style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: showBillingCardEdit ? "#f3f4f6" : "#fdf4ff", border: "1px solid #d8b4fe", borderRadius: 6, padding: "3px 10px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>
                            {showBillingCardEdit ? "✕ 닫기" : "✏️ 수정"}
                          </button>
                        </div>

                        {showBillingCardEdit && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e5e7eb" }}>
                            <p style={{ margin: "0 0 8px", fontSize: 11, color: "#6b7280" }}>문서 구분·청구 방식 등은 견적 생성/수정 시 변경됩니다.</p>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                              {/* ── 청구 대상 ── */}
                              <div>
                                <p style={{ margin: "0 0 5px", fontSize: 11, fontWeight: 700, color: "#0369a1" }}>청구 대상</p>
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                                  {(["same_as_request", "other_company", "other_division"] as const).map(mode => (
                                    <button key={mode} type="button"
                                      onClick={() => { setBillingCardMode(mode); setBillingCardCompanyId(null); setBillingCardDivisionId(null); setBillingCardDivisions([]); }}
                                      style={rdoStyle(billingCardMode === mode)}>
                                      {mode === "same_as_request" ? "의뢰처와 동일" : mode === "other_company" ? "다른 거래처" : "다른 브랜드/부서"}
                                    </button>
                                  ))}
                                </div>
                                {billingCardMode === "other_company" && (
                                  <BillingSearchableSelect
                                    items={companiesList.map(c => ({ id: c.id, label: c.name }))}
                                    value={billingCardCompanyId}
                                    onChange={setBillingCardCompanyId}
                                    placeholder="회사명으로 검색..."
                                    accentBorder="#93c5fd"
                                  />
                                )}
                                {billingCardMode === "other_division" && (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                    <BillingSearchableSelect
                                      items={companiesList.map(c => ({ id: c.id, label: c.name }))}
                                      value={billingCardCompanyId}
                                      onChange={cid => {
                                        setBillingCardCompanyId(cid); setBillingCardDivisionId(null);
                                        if (cid) loadBillingDivisions(cid); else setBillingCardDivisions([]);
                                      }}
                                      placeholder="거래처 검색..."
                                      accentBorder="#93c5fd"
                                    />
                                    {billingCardCompanyId && (
                                      <BillingSearchableSelect
                                        items={billingCardDivisions.map(d => ({ id: d.id, label: d.name + (d.type ? ` (${d.type})` : "") }))}
                                        value={billingCardDivisionId}
                                        onChange={setBillingCardDivisionId}
                                        placeholder={billingCardDivisions.length === 0 ? "브랜드/부서 없음" : "브랜드/부서 검색..."}
                                        accentBorder="#67e8f9"
                                      />
                                    )}
                                  </div>
                                )}
                              </div>
                              {/* ── 정산 주체 ── */}
                              <div>
                                <p style={{ margin: "0 0 5px", fontSize: 11, fontWeight: 700, color: "#059669" }}>정산 주체</p>
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
                                  {(["same_as_billing", "same_as_request", "other_company", "other_division"] as const).map(mode => (
                                    <button key={mode} type="button"
                                      onClick={() => { setPayerCardMode(mode); setPayerCardCompanyId(null); setPayerCardDivisionId(null); setPayerCardDivisions([]); }}
                                      style={rdoStyle(payerCardMode === mode)}>
                                      {mode === "same_as_billing" ? "청구처와 동일" : mode === "same_as_request" ? "의뢰처와 동일" : mode === "other_company" ? "다른 거래처" : "다른 브랜드/부서"}
                                    </button>
                                  ))}
                                </div>
                                {payerCardMode === "other_company" && (
                                  <BillingSearchableSelect
                                    items={companiesList.map(c => ({ id: c.id, label: c.name }))}
                                    value={payerCardCompanyId}
                                    onChange={setPayerCardCompanyId}
                                    placeholder="회사명으로 검색..."
                                    accentBorder="#6ee7b7"
                                  />
                                )}
                                {payerCardMode === "other_division" && (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                    <BillingSearchableSelect
                                      items={companiesList.map(c => ({ id: c.id, label: c.name }))}
                                      value={payerCardCompanyId}
                                      onChange={cid => {
                                        setPayerCardCompanyId(cid); setPayerCardDivisionId(null);
                                        if (cid) loadPayerDivisions(cid); else setPayerCardDivisions([]);
                                      }}
                                      placeholder="거래처 검색..."
                                      accentBorder="#6ee7b7"
                                    />
                                    {payerCardCompanyId && (
                                      <BillingSearchableSelect
                                        items={payerCardDivisions.map(d => ({ id: d.id, label: d.name + (d.type ? ` (${d.type})` : "") }))}
                                        value={payerCardDivisionId}
                                        onChange={setPayerCardDivisionId}
                                        placeholder={payerCardDivisions.length === 0 ? "브랜드/부서 없음" : "브랜드/부서 검색..."}
                                        accentBorder="#67e8f9"
                                      />
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                              <PrimaryBtn onClick={handleSaveBillingCard} disabled={savingBillingCard}
                                style={{ fontSize: 12, padding: "6px 16px", background: "#7c3aed", border: "none" }}>
                                {savingBillingCard ? "저장 중..." : "저장"}
                              </PrimaryBtn>
                              <button onClick={() => setShowBillingCardEdit(false)}
                                style={{ fontSize: 12, padding: "6px 14px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>취소</button>
                            </div>
                          </div>
                        )}
                      </div>

                    </>
                  );
                })()}

                {/* 정산 요약 카드 (견적/결제 탭 하단) */}
                {(() => {
                  const hasPaid = detail.payments.some((pm: any) => pm.status === "paid");
                  const hasSettlement = detail.settlements.length > 0;
                  return (
                    <div style={{ background: hasSettlement ? "#f0fdf4" : "#f9fafb", border: `1px solid ${hasSettlement ? "#bbf7d0" : "#e9edf3"}`, borderRadius: 8, padding: "10px 14px", marginTop: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: hasSettlement ? 8 : 0 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: hasSettlement ? "#065f46" : "#6b7280" }}>
                          📊 정산 {hasSettlement ? `(${detail.settlements.length}건)` : "— 미생성"}
                        </span>
                        <button onClick={() => setActiveSection("settlement")}
                          style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid #059669", background: "#fff", cursor: "pointer", color: "#059669", fontWeight: 600 }}>
                          정산 탭으로 →
                        </button>
                      </div>
                      {hasSettlement && detail.settlements.map((s: any) => (
                        <div key={s.id} style={{ fontSize: 12, color: "#374151", display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <span style={{ color: "#0891b2", fontWeight: 700 }}>총 {Number(s.totalAmount).toLocaleString()}원</span>
                          <StatusBadge status={s.status} />
                        </div>
                      ))}
                      {!hasSettlement && hasPaid && (
                        <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>결제 완료 후 정산 생성 가능</p>
                      )}
                    </div>
                  );
                })()}
              </>
            )}

            {/* 정산 탭 */}
            {activeSection === "settlement" && (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {["통번역사 지급", "정산 내역", "지급 관리"].map(k => (
                    <span key={k} style={{ fontSize: 10, fontWeight: 600, background: "#ecfeff", color: "#0891b2", borderRadius: 5, padding: "2px 8px" }}>{k}</span>
                  ))}
                </div>
                {(() => {
                  const hasPaid = detail.payments.some((pm: any) => pm.status === "paid");
                  const hasSettlement = detail.settlements.length > 0;
                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <p style={{ ...sectionHd, margin: 0 }}>정산 ({detail.settlements.length})</p>
                        {hasPaid && !hasSettlement && (
                          <button onClick={handleCreateSettlement} disabled={creatingSettlement}
                            style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid #059669", background: "#f0fdf4", cursor: "pointer", color: "#059669", fontWeight: 600 }}>
                            {creatingSettlement ? "생성 중..." : "＋ 정산 생성"}
                          </button>
                        )}
                      </div>
                      {!hasSettlement ? (
                        <p style={{ color: "#9ca3af", fontSize: 13, paddingBottom: 4 }}>
                          {hasPaid ? "정산이 아직 생성되지 않았습니다. 위 버튼으로 수동 생성하거나, 상태를 '완료'로 변경하면 자동 생성됩니다." : "등록된 정산이 없습니다."}
                        </p>
                      ) : detail.settlements.map((s: any) => (
                        <div key={s.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 14px", marginBottom: 6, fontSize: 13, border: "1px solid #e5e7eb" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            <span style={{ color: "#9ca3af", fontSize: 11 }}>#{s.id}</span>
                            <span style={{ color: "#0891b2", fontWeight: 600 }}>총 {Number(s.totalAmount).toLocaleString()}원</span>
                            <span style={{ color: "#059669", fontWeight: 600 }}>통번역사 {Number(s.translatorAmount).toLocaleString()}원</span>
                            <span style={{ color: "#6b7280", fontSize: 11 }}>플랫폼 수수료 {Number(s.platformFee).toLocaleString()}원</span>
                            <StatusBadge status={s.status} />
                          </div>
                        </div>
                      ))}
                      <div style={{ marginTop: 12 }}>
                        <button onClick={() => setActiveSection("payment")}
                          style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", cursor: "pointer", color: "#6b7280" }}>
                          ← 결제 탭으로
                        </button>
                      </div>
                    </>
                  );
                })()}
              </>
            )}

            {/* 기록 탭 (파일 / 메모 / 이벤트 로그) */}
            {activeSection === "history" && (
              <>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                  {["파일", "메모", "이벤트 로그", "변경 이력"].map(k => (
                    <span key={k} style={{ fontSize: 10, fontWeight: 600, background: "#f1f5f9", color: "#64748b", borderRadius: 5, padding: "2px 8px" }}>{k}</span>
                  ))}
                </div>
                {/* 업로드 영역 */}
                <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
                  <p style={sectionHd}>파일 업로드</p>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <ClickSelect
                      value={uploadFileType}
                      onChange={v => setUploadFileType(v as "source"|"translated"|"attachment")}
                      triggerStyle={{ fontSize: 13, padding: "7px 10px" }}
                      options={[
                        { value: "source", label: "📄 원본 파일" },
                        { value: "translated", label: "✅ 번역본" },
                        { value: "attachment", label: "📎 기타 첨부" },
                      ]}
                    />
                    <label style={{
                      display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px",
                      background: uploadingFile ? "#e5e7eb" : "#2563eb", color: uploadingFile ? "#9ca3af" : "#fff",
                      borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: uploadingFile ? "not-allowed" : "pointer",
                      transition: "background 0.12s",
                    }}>
                      {uploadingFile ? (uploadProgress || "업로드 중...") : "📁 파일 선택"}
                      <input type="file" disabled={uploadingFile} onChange={handleFileUpload}
                        accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png,.gif,.zip,.xls,.xlsx,.ppt,.pptx,.hwp,.csv"
                        style={{ display: "none" }} />
                    </label>
                    <span style={{ fontSize: 12, color: "#9ca3af" }}>최대 10MB · PDF, Word, Excel, 이미지, ZIP 등</span>
                  </div>
                </div>

                {/* 파일 목록 */}
                {filesLoading ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "24px 0" }}>불러오는 중...</p>
                ) : projectFiles.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af" }}>
                    <p style={{ fontSize: 32, margin: "0 0 8px" }}>📂</p>
                    <p style={{ fontSize: 13, margin: 0 }}>등록된 파일이 없습니다.</p>
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["유형", "파일명", "크기", "업로드자", "업로드일", ""].map(h => (
                          <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#6b7280", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {projectFiles.map(f => {
                        const typeInfo = f.fileType === "source" ? { label: "원본", color: "#2563eb", bg: "#eff6ff" }
                          : f.fileType === "translated" ? { label: "번역본", color: "#059669", bg: "#f0fdf4" }
                          : { label: "첨부", color: "#6b7280", bg: "#f3f4f6" };
                        const sizeStr = f.fileSize ? (f.fileSize < 1024 * 1024 ? `${(f.fileSize / 1024).toFixed(1)}KB` : `${(f.fileSize / 1024 / 1024).toFixed(1)}MB`) : "-";
                        const downloadUrl = api(`/api/admin/projects/${projectId}/files/${f.id}/download`);
                        return (
                          <tr key={f.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                            <td style={{ padding: "10px 10px", verticalAlign: "middle" }}>
                              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: typeInfo.color, background: typeInfo.bg }}>
                                {typeInfo.label}
                              </span>
                            </td>
                            <td style={{ padding: "10px 10px", fontSize: 13, color: "#111827", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" }}>
                              {f.fileName}
                            </td>
                            <td style={{ padding: "10px 10px", fontSize: 12, color: "#6b7280", whiteSpace: "nowrap", verticalAlign: "middle" }}>{sizeStr}</td>
                            <td style={{ padding: "10px 10px", fontSize: 12, color: "#374151", verticalAlign: "middle" }}>{f.uploaderName ?? f.uploaderEmail ?? "-"}</td>
                            <td style={{ padding: "10px 10px", fontSize: 12, color: "#6b7280", whiteSpace: "nowrap", verticalAlign: "middle" }}>
                              {new Date(f.createdAt).toLocaleDateString("ko-KR")}
                            </td>
                            <td style={{ padding: "10px 10px", verticalAlign: "middle" }}>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button onClick={async () => {
                                  try {
                                    const r = await fetch(downloadUrl, { headers: authH });
                                    if (!r.ok) { onToast("오류: 다운로드 실패"); return; }
                                    const blob = await r.blob();
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a"); a.href = url; a.download = f.fileName;
                                    document.body.appendChild(a); a.click();
                                    document.body.removeChild(a); URL.revokeObjectURL(url);
                                  } catch { onToast("오류: 다운로드 실패"); }
                                }}
                                  style={{ fontSize: 12, color: "#2563eb", padding: "4px 10px", border: "1px solid #2563eb", borderRadius: 6, background: "none", cursor: "pointer" }}>
                                  ⬇ 다운로드
                                </button>
                                <button onClick={() => handleFileDelete(f.id, f.fileName)}
                                  style={{ fontSize: 12, color: "#dc2626", padding: "4px 8px", border: "1px solid #dc2626", borderRadius: 6, background: "none", cursor: "pointer" }}>
                                  삭제
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* 커뮤니케이션 */}
                <p style={{ ...sectionHd, marginTop: 20 }}>커뮤니케이션</p>
                {detail.projectCustomerId ? (
                  <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                    <ClickSelect
                      value={commType}
                      onChange={v => setCommType(v as "email"|"phone"|"message")}
                      triggerStyle={{ fontSize: 13, padding: "7px 10px" }}
                      options={[
                        { value: "message", label: "메시지" },
                        { value: "email", label: "이메일" },
                        { value: "phone", label: "전화" },
                      ]}
                    />
                    <input
                      value={commContent} onChange={e => setCommContent(e.target.value)}
                      placeholder="내용 입력..."
                      style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "8px 10px", minWidth: 180 }}
                      onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleAddComm()}
                    />
                    <PrimaryBtn onClick={handleAddComm} disabled={addingComm || !commContent.trim()} style={{ padding: "8px 16px", fontSize: 13 }}>
                      {addingComm ? "추가 중..." : "기록 추가"}
                    </PrimaryBtn>
                  </div>
                ) : (
                  <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 8 }}>고객이 연결된 프로젝트에서만 커뮤니케이션 기록을 추가할 수 있습니다.</p>
                )}
                {(detail.communications ?? []).length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>커뮤니케이션 기록이 없습니다.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>
                    {(detail.communications ?? []).map(c => (
                      <div key={c.id} style={{ padding: "9px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, alignItems: "center" }}>
                          <span style={{
                            padding: "2px 9px", borderRadius: 12, fontSize: 11, fontWeight: 700,
                            background: `${COMM_TYPE_COLOR[c.type]}18`, color: COMM_TYPE_COLOR[c.type],
                          }}>{COMM_TYPE_LABEL[c.type]}</span>
                          <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(c.createdAt).toLocaleString("ko-KR")}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{c.content}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* 메모 */}
                <p style={{ ...sectionHd, marginTop: 16 }}>메모</p>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input
                    value={noteInput} onChange={e => setNoteInput(e.target.value)}
                    placeholder="메모 내용 입력..."
                    style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "8px 10px" }}
                    onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleAddNote()}
                  />
                  <PrimaryBtn onClick={handleAddNote} disabled={addingNote || !noteInput.trim()} style={{ padding: "8px 16px", fontSize: 13 }}>
                    {addingNote ? "추가 중..." : "추가"}
                  </PrimaryBtn>
                </div>
                {(detail.notes ?? []).length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>메모가 없습니다.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto", marginBottom: 8 }}>
                    {(detail.notes ?? []).map(n => (
                      <div key={n.id} style={{ padding: "10px 12px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 11, color: "#92400e", fontWeight: 600 }}>{n.adminEmail ?? "관리자"}</span>
                          <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(n.createdAt).toLocaleString("ko-KR")}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{n.content}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* 이벤트 로그 */}
                <p style={{ ...sectionHd, marginTop: 16 }}>이벤트 로그</p>
                {detail.logs.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "16px 0" }}>아직 이벤트 로그가 없습니다.</p>
                ) : (
                  <div style={{ maxHeight: 320, overflowY: "auto", padding: "4px 0" }}>
                    {[...detail.logs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((log, idx, arr) => {
                      const info = getActionLabel(log.action);
                      const isLast = idx === arr.length - 1;
                      let metaObj: Record<string, string> | null = null;
                      try { if (log.metadata) metaObj = JSON.parse(log.metadata); } catch { /* noop */ }
                      return (
                        <div key={log.id} style={{ display: "flex", gap: 0, position: "relative" }}>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 38, flexShrink: 0 }}>
                            <div style={{
                              width: 30, height: 30, borderRadius: "50%",
                              background: info.color + "18", border: `2px solid ${info.color}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 14, zIndex: 1, flexShrink: 0,
                            }}>{info.dot}</div>
                            {!isLast && <div style={{ width: 2, flex: 1, minHeight: 16, background: "#e5e7eb" }} />}
                          </div>
                          <div style={{ flex: 1, paddingLeft: 10, paddingBottom: isLast ? 0 : 16, paddingTop: 4 }}>
                            <p style={{ margin: "0 0 3px", fontSize: 13, fontWeight: 600, color: info.color }}>{info.ko}</p>
                            {metaObj?.fileName && (
                              <p style={{ margin: "0 0 3px", fontSize: 12, color: "#374151", background: "#f9fafb", borderRadius: 4, padding: "2px 7px", display: "inline-block" }}>
                                📄 {metaObj.fileName}
                              </p>
                            )}
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(log.createdAt).toLocaleString("ko-KR")}</span>
                              {log.performedByEmail && (
                                <span style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", borderRadius: 4, padding: "1px 7px" }}>
                                  👤 {log.performedByEmail}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            </div>{/* ── /탭 콘텐츠 영역 ── */}
          </>
        )}
      {/* ── 선입금 입금 등록 모달 ─────────────────────────────────────────────── */}
      {showDepositModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10100, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setShowDepositModal(false); }}
        >
          <div style={{ background: "#fff", borderRadius: 14, padding: "26px 28px", width: 380, maxWidth: "90vw", boxShadow: "0 12px 40px rgba(0,0,0,0.22)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#15803d" }}>선입금 입금 등록</div>
                <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                  {compPrepaidAccounts.find(a => a.id === depositTargetAcctId)?.note ?? "계정에 입금을 추가합니다"}
                </div>
              </div>
              <button onClick={() => setShowDepositModal(false)}
                style={{ background: "none", border: "none", fontSize: 20, color: "#9ca3af", cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
            </div>

            {/* 여러 계정일 때 계정 선택 */}
            {compPrepaidAccounts.length > 1 && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>입금 대상 계정</label>
                <select value={depositTargetAcctId ?? ""} onChange={e => setDepositTargetAcctId(Number(e.target.value))}
                  style={{ width: "100%", padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 7, fontSize: 12 }}>
                  {compPrepaidAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.depositDate ?? "-"}{a.note ? ` · ${a.note}` : ""} — 잔액 {a.currentBalance.toLocaleString()}원
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 입금 금액 */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>입금 금액 (원) *</label>
              <input
                value={depositAmount}
                onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ""); setDepositAmount(raw ? Number(raw).toLocaleString() : ""); }}
                placeholder="예: 5,000,000"
                style={{ width: "100%", padding: "9px 12px", border: "1px solid #86efac", borderRadius: 8, fontSize: 14, fontWeight: 700, color: "#15803d", boxSizing: "border-box" }}
              />
              {depositAmount && Number(depositAmount.replace(/,/g, "")) > 0 && (
                <div style={{ fontSize: 11, color: "#15803d", marginTop: 3, fontWeight: 600 }}>
                  입금 후 잔액: {((compPrepaidAccounts.find(a => a.id === depositTargetAcctId)?.currentBalance ?? 0) + Number(depositAmount.replace(/,/g, ""))).toLocaleString()}원
                </div>
              )}
            </div>

            {/* 입금일 */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>입금일 *</label>
              <input type="date" value={depositDate} onChange={e => setDepositDate(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 7, fontSize: 13, boxSizing: "border-box" }} />
            </div>

            {/* 메모 */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>메모 (선택)</label>
              <input value={depositMemo} onChange={e => setDepositMemo(e.target.value)}
                placeholder="예: 1차 계약금, 추가 입금 등"
                style={{ width: "100%", padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 7, fontSize: 13, boxSizing: "border-box" }} />
            </div>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setShowDepositModal(false)}
                style={{ padding: "9px 20px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, cursor: "pointer", color: "#374151" }}>
                취소
              </button>
              <button onClick={handleDepositSubmit} disabled={depositSubmitting || !depositAmount || !depositDate}
                style={{ padding: "9px 20px", borderRadius: 7, border: "none", background: depositSubmitting || !depositAmount ? "#9ca3af" : "#16a34a", fontSize: 13, fontWeight: 700, cursor: depositSubmitting || !depositAmount ? "not-allowed" : "pointer", color: "#fff" }}>
                {depositSubmitting ? "등록 중..." : "등록"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 선입금 이력 보기 모달 ─────────────────────────────────────────────── */}
      {showLedgerModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10100, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={e => { if (e.target === e.currentTarget) setShowLedgerModal(false); }}
        >
          <div style={{ background: "#fff", borderRadius: 14, width: 740, maxWidth: "95vw", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,0.22)" }}>
            {/* 헤더 */}
            <div style={{ padding: "20px 24px 14px", borderBottom: "1px solid #f3f4f6", flexShrink: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#7c3aed" }}>선입금 거래 이력</div>
                  <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                    {compPrepaidAccounts.find(a => a.id === selectedPrepaidAcctId)
                      ? `잔액: ${compPrepaidAccounts.find(a => a.id === selectedPrepaidAcctId)!.currentBalance.toLocaleString()}원`
                      : "모든 계정의 거래 내역"}
                  </div>
                </div>
                <button onClick={() => setShowLedgerModal(false)}
                  style={{ background: "none", border: "none", fontSize: 22, color: "#9ca3af", cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
              </div>
            </div>

            {/* 테이블 */}
            <div style={{ overflowY: "auto", flex: 1, padding: "12px 16px" }}>
              {ledgerModalLoading ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 13 }}>이력 불러오는 중...</div>
              ) : ledgerModalData.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 13 }}>거래 내역이 없습니다.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "#f5f3ff", zIndex: 1 }}>
                    <tr>
                      {[
                        { h: "날짜", w: 88 },
                        { h: "유형", w: 56 },
                        { h: "금액", w: 100, right: true },
                        { h: "전 잔액", w: 100, right: true },
                        { h: "후 잔액", w: 100, right: true },
                        { h: "프로젝트", w: undefined },
                        { h: "메모", w: undefined },
                      ].map(({ h, w, right }) => (
                        <th key={h} style={{ padding: "7px 10px", fontWeight: 700, color: "#4b5563", borderBottom: "2px solid #d8b4fe", whiteSpace: "nowrap", textAlign: right ? "right" : "left", fontSize: 11, width: w }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerModalData.map((tx, idx) => {
                      const isDeposit = tx.type === "deposit";
                      const isDeduct = tx.type === "deduction";
                      const typeLabel = isDeposit ? "입금" : isDeduct ? "차감" : "조정";
                      const typeColor = isDeposit ? "#15803d" : isDeduct ? "#dc2626" : "#374151";
                      const typeBg = isDeposit ? "#dcfce7" : isDeduct ? "#fee2e2" : "#f3f4f6";
                      const rowBg = idx % 2 === 0 ? "#fff" : "#fafafa";
                      const dateStr = tx.transactionDate ? tx.transactionDate.slice(0, 10) : (tx.createdAt ? tx.createdAt.slice(0, 10) : "-");
                      const amtPrefix = isDeposit ? "+" : isDeduct ? "−" : "";
                      const balBefore = tx.balanceBefore != null ? Number(tx.balanceBefore) : null;
                      const tdSt: React.CSSProperties = { padding: "7px 10px", borderBottom: "1px solid #f3f4f6" };
                      return (
                        <tr key={tx.id} style={{ background: rowBg }}>
                          <td style={{ ...tdSt, color: "#6b7280", fontFamily: "monospace", fontSize: 11 }}>{dateStr}</td>
                          <td style={{ ...tdSt, textAlign: "center" }}>
                            <span style={{ background: typeBg, color: typeColor, fontWeight: 700, fontSize: 10, borderRadius: 4, padding: "2px 7px" }}>{typeLabel}</span>
                          </td>
                          <td style={{ ...tdSt, textAlign: "right", fontWeight: 800, color: typeColor, fontFamily: "monospace" }}>
                            {amtPrefix}{tx.amount.toLocaleString()}원
                          </td>
                          <td style={{ ...tdSt, textAlign: "right", color: "#6b7280", fontFamily: "monospace", fontSize: 11 }}>
                            {balBefore != null ? balBefore.toLocaleString() + "원" : "-"}
                          </td>
                          <td style={{ ...tdSt, textAlign: "right", fontWeight: 600, color: "#374151", fontFamily: "monospace", fontSize: 11 }}>
                            {tx.balanceAfter.toLocaleString()}원
                          </td>
                          <td style={{ ...tdSt, color: "#374151", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {tx.projectTitle ?? <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          <td style={{ ...tdSt, color: "#6b7280", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {tx.description ?? <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* 푸터 요약 */}
            {!ledgerModalLoading && ledgerModalData.length > 0 && (() => {
              const totalDep = ledgerModalData.filter(t => t.type === "deposit").reduce((s, t) => s + t.amount, 0);
              const totalDed = ledgerModalData.filter(t => t.type === "deduction").reduce((s, t) => s + t.amount, 0);
              return (
                <div style={{ padding: "12px 24px", borderTop: "1px solid #f3f4f6", display: "flex", gap: 20, background: "#fafafa", borderRadius: "0 0 14px 14px", flexShrink: 0 }}>
                  <span style={{ fontSize: 12, color: "#15803d" }}>총 입금: <b>{totalDep.toLocaleString()}원</b></span>
                  <span style={{ fontSize: 12, color: "#dc2626" }}>총 차감: <b>{totalDed.toLocaleString()}원</b></span>
                  <span style={{ fontSize: 12, color: "#374151", marginLeft: "auto" }}>{ledgerModalData.length}건</span>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* 완료 상태 수정 확인 모달 */}
      {completedConfirmShow && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: "24px 28px", maxWidth: 380, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
            <p style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "#111827" }}>⚠️ 완료된 프로젝트 수정</p>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
              이 변경은 현재 상태를 되돌립니다.<br />
              프로젝트 상태가 <strong>진행 중</strong>으로 변경됩니다.<br />
              계속하시겠습니까?
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setCompletedConfirmShow(false)}
                style={{ padding: "8px 18px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, cursor: "pointer", color: "#374151" }}>
                취소
              </button>
              <button onClick={() => {
                setCompletedConfirmShow(false);
                if (completedConfirmAction) { completedConfirmAction(); setCompletedConfirmAction(null); }
              }}
                style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: "#dc2626", fontSize: 13, cursor: "pointer", color: "#fff", fontWeight: 600 }}>
                확인 (수정 진행)
              </button>
            </div>
          </div>
        </div>
      )}
    </DraggableModal>

    {showQuoteEditorModal && detail && (
      <QuoteEditorWorkspace
        token={token}
        projectId={projectId}
        initialCompanyId={(detail as any).companyId ?? null}
        initialContactId={(detail as any).contactId ?? null}
        initialTitle={detail.title}
        onClose={() => setShowQuoteEditorModal(false)}
        onSaved={() => {
          setShowQuoteEditorModal(false);
          loadDetail();
          onRefresh?.();
        }}
        onToast={onToast}
        adminList={adminList}
      />
    )}

    {/* 거래명세서 모달 (판매 확정 건) */}
    {stmtData && (
      <TransactionStatementModal
        data={stmtData.data}
        quoteTitle={stmtData.title}
        onClose={() => setStmtData(null)}
      />
    )}
    </>
  );
}
