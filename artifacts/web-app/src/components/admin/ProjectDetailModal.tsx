import React, { useState, useEffect } from 'react';
import { api, ProjectDetail, MatchCandidate, getActionLabel, COMM_TYPE_LABEL, COMM_TYPE_COLOR, STATUS_LABEL, PROJECT_STATUS_TRANSITIONS, ALL_FINANCIAL_STATUSES, FINANCIAL_STATUS_LABEL, FINANCIAL_STATUS_STYLE, AdminUser, BOARD_CATEGORY_LABEL, Product } from '../../lib/constants';
import { StatusBadge, PrimaryBtn, GhostBtn } from '../ui';
import { ReviewMemoPanel } from './ReviewMemoPanel';
import { DraggableModal } from './DraggableModal';

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

/* 현재 상태별 다음 단계 안내 */
const STATUS_NEXT_HINT: Record<string, { text: string; color: string; bg: string }> = {
  created:     { text: "견적을 생성한 뒤 '견적 발송' 상태로 변경하세요.",                color: "#2563eb", bg: "#eff6ff" },
  quoted:      { text: "고객 확인 후 '견적 승인' 상태로 변경하세요.",                   color: "#7c3aed", bg: "#faf5ff" },
  approved:    { text: "통번역사가 배정되었습니다. '배정됨' 상태로 변경하세요.",              color: "#9333ea", bg: "#fdf4ff" },
  matched:     { text: "통번역사가 작업을 시작하면 '진행 중' 상태로 변경하세요.",          color: "#0891b2", bg: "#ecfeff" },
  in_progress: { text: "작업 완료 후 '완료' 상태로 변경하세요.",                        color: "#059669", bg: "#f0fdf4" },
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

export function ProjectDetailModal({ projectId, token, onClose, onRefresh, onToast, adminList, initialSection }: {
  projectId: number; token: string; onClose: () => void;
  onRefresh: () => void; onToast: (msg: string) => void;
  adminList?: AdminUser[];
  initialSection?: "info"|"finance"|"work"|"settlement"|"history";
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [statusTarget, setStatusTarget] = useState("");
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
  const [activeSection, setActiveSection] = useState<"info"|"finance"|"work"|"settlement"|"history">(initialSection ?? "info");

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

  // 견적 생성
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteNote, setQuoteNote] = useState("");
  const [quoteTaxDocType, setQuoteTaxDocType] = useState<"tax_invoice" | "zero_tax_invoice" | "bill">("tax_invoice");
  const [quoteTaxCategory, setQuoteTaxCategory] = useState<"normal" | "zero_rated" | "consignment" | "consignment_zero_rated">("normal");
  const [quoteType, setQuoteType] = useState<"b2b_standard" | "b2c_prepaid" | "prepaid_deduction" | "accumulated_batch">("b2b_standard");
  const [quoteBillingType, setQuoteBillingType] = useState<string>("postpaid_per_project");
  const [quotePaymentMethod, setQuotePaymentMethod] = useState<string>("card");
  const changeQuoteType = (val: typeof quoteType) => {
    setQuoteType(val);
    if (val === "accumulated_batch") setQuoteBillingType("monthly_billing");
    else if (val === "prepaid_deduction") setQuoteBillingType("prepaid_wallet");
  };
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [creatingQuote, setCreatingQuote] = useState(false);
  type QuoteItemForm = { productId: number | null; productName: string; languagePair: string; unit: string; quantity: string; unitPrice: string; taxRate: "0" | "0.1" };
  const defaultItem = (): QuoteItemForm => ({ productId: null, productName: "", languagePair: "", unit: "건", quantity: "1", unitPrice: "", taxRate: "0" });
  const [quoteMode, setQuoteMode] = useState<"simple" | "items">("items");
  const [quoteItemForms, setQuoteItemForms] = useState<QuoteItemForm[]>([defaultItem()]);
  const calcItemTotal = (it: QuoteItemForm) => {
    const supply = Math.round(Number(it.quantity || 1) * Number(it.unitPrice || 0));
    const tax = Math.round(supply * Number(it.taxRate));
    return { supply, tax, total: supply + tax };
  };
  const quoteItemsGrandTotal = quoteItemForms.reduce((s, it) => s + calcItemTotal(it).total, 0);
  // quote_type별 추가 필드
  const _dateDefault = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().split("T")[0]; };
  const [quoteValidUntil, setQuoteValidUntil] = useState(() => _dateDefault(15));
  const [quoteIssueDate, setQuoteIssueDate] = useState(() => _dateDefault(0));
  const [quoteInvoiceDueDate, setQuoteInvoiceDueDate] = useState("");
  const [quotePaymentDueDate, setQuotePaymentDueDate] = useState(() => _dateDefault(30));
  const [quotePrepaidUsage, setQuotePrepaidUsage] = useState("");
  // 선입금 차감 - 거래처 계정 원장
  type CompPrepaidAcct = { id: number; initialAmount: number; currentBalance: number; note: string | null; depositDate: string | null; status: string };
  type LedgerEntry = { id: number; type: string; amount: number; balanceAfter: number; description: string | null; projectId: number | null; projectTitle: string | null; transactionDate: string | null; createdAt: string | null; supplyAmount: number | null; taxAmount: number | null };
  const [compPrepaidAccounts, setCompPrepaidAccounts] = useState<CompPrepaidAcct[]>([]);
  const [loadingCompPrepaid, setLoadingCompPrepaid] = useState(false);
  const [selectedPrepaidAcctId, setSelectedPrepaidAcctId] = useState<number | null>(null);
  const [acctLedger, setAcctLedger] = useState<LedgerEntry[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);
  const [quickPrepaidAmount, setQuickPrepaidAmount] = useState("");
  const [quickPrepaidNote, setQuickPrepaidNote] = useState("");
  const [registeringPrepaid, setRegisteringPrepaid] = useState(false);
  const [quoteBatchStart, setQuoteBatchStart] = useState("");
  const [quoteBatchEnd, setQuoteBatchEnd] = useState("");
  // 누적 견적 후보 조회 상태
  type BatchCandidate = {
    projectId: number; title: string; status: string; createdAt: string;
    quoteId: number | null; quotePrice: number | null; quoteStatus: string | null; serviceName: string;
  };
  const [batchCandidates, setBatchCandidates] = useState<BatchCandidate[]>([]);
  const [batchSelected, setBatchSelected] = useState<Set<number>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchQueried, setBatchQueried] = useState(false);

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

  const [quoteProducts, setQuoteProducts] = useState<Product[]>([]);
  useEffect(() => {
    fetch(api("/api/admin/products"), { headers: authH })
      .then(r => r.ok ? r.json() : [])
      .then(d => setQuoteProducts(Array.isArray(d) ? d.filter((p: Product) => p.active) : []))
      .catch(() => {});
  }, [token]);

  const loadBatchCandidates = async () => {
    const companyId = detail?.companyId;
    if (!companyId) { onToast("거래처 정보가 없습니다. 프로젝트에 거래처를 먼저 설정하세요."); return; }
    if (!quoteBatchStart || !quoteBatchEnd) { onToast("대상기간 시작·종료를 모두 입력하세요."); return; }
    if (quoteBatchStart > quoteBatchEnd) { onToast("시작일이 종료일보다 늦을 수 없습니다."); return; }
    setBatchLoading(true);
    setBatchQueried(false);
    setBatchCandidates([]);
    setBatchSelected(new Set());
    try {
      const res = await fetch(api(`/api/admin/billing-candidates?companyId=${companyId}&start=${quoteBatchStart}&end=${quoteBatchEnd}`), { headers: authH });
      const data = await res.json();
      if (!res.ok) { onToast(`조회 실패: ${data.error}`); return; }
      setBatchCandidates(data);
      const autoSelect = new Set<number>((data as { projectId: number; quotePrice: number | null }[])
        .filter(c => c.quotePrice != null).map(c => c.projectId));
      setBatchSelected(autoSelect);
      setBatchQueried(true);
    } catch { onToast("조회 중 오류가 발생했습니다."); }
    finally { setBatchLoading(false); }
  };

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
        body: JSON.stringify({ projectId, issueDate: issueDateBatch, paymentDueDate: paymentDueDateBatch || undefined, taxDocumentType: quoteTaxDocType }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(data.error ?? "발행 실패"); return; }
      onToast("누적 견적서가 발행되었습니다.");
      await loadDetail();
      setShowQuoteForm(false);
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
        setStatusTarget(data.status);
        setFinancialStatusTarget(data.financialStatus ?? "unbilled");
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
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 배정 실패"); }
    finally { setAssigning(null); }
  };

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
    if (quoteType === "accumulated_batch" && detail?.companyId) {
      loadActiveBatch(detail.companyId);
    }
  }, [quoteType, detail?.companyId]);
  useEffect(() => {
    if (quoteType === "prepaid_deduction" && detail?.companyId) {
      setCompPrepaidAccounts([]);
      setSelectedPrepaidAcctId(null);
      setAcctLedger([]);
      loadCompPrepaidAccounts(detail.companyId);
    }
  }, [quoteType, detail?.companyId]);

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
      onToast(`업무 상태가 "${STATUS_LABEL[statusTarget] ?? statusTarget}"로 변경되었습니다.`);
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

  const handleCreateQuote = async () => {
    setCreatingQuote(true);
    try {
      let body: Record<string, unknown>;

      if (quoteType === "accumulated_batch") {
        onToast("누적 견적서는 배치 발행 버튼을 사용하세요.");
        setCreatingQuote(false);
        return;
      } else if (quoteType === "prepaid_deduction") {
        const validItems = quoteItemForms.filter(it => it.productName.trim() && Number(it.unitPrice) > 0);
        if (validItems.length === 0) { onToast("품목명과 단가를 입력하세요."); return; }
        const usageAmt = validItems.reduce((s, it) => s + calcItemTotal(it).total, 0);
        if (!selectedPrepaidAcctId) { onToast("차감할 선입금 계정을 선택하세요."); return; }
        const acct = compPrepaidAccounts.find(a => a.id === selectedPrepaidAcctId);
        if (!acct || acct.currentBalance < usageAmt) { onToast(`잔액 부족: 현재 잔액 ${acct?.currentBalance.toLocaleString() ?? 0}원`); return; }
        body = {
          items: validItems.map(it => ({
            productId: it.productId ?? undefined,
            productName: it.productName.trim(),
            languagePair: it.languagePair.trim() || undefined,
            unit: it.unit || "건",
            quantity: Number(it.quantity) || 1,
            unitPrice: Number(it.unitPrice),
            taxRate: Number(it.taxRate) as 0 | 0.1,
          })),
          prepaidAccountId: selectedPrepaidAcctId,
        };
      } else {
        const validItems = quoteItemForms.filter(it => it.productName.trim() && Number(it.unitPrice) > 0);
        const isRegenerate = (detail?.quotes?.length ?? 0) > 0;
        if (!isRegenerate && validItems.length === 0) { onToast("품목명과 단가를 입력하세요."); return; }
        body = {
          items: validItems.map(it => ({
            productId: it.productId ?? undefined,
            productName: it.productName.trim(),
            languagePair: it.languagePair.trim() || undefined,
            unit: it.unit || "건",
            quantity: Number(it.quantity) || 1,
            unitPrice: Number(it.unitPrice),
            taxRate: Number(it.taxRate) as 0 | 0.1,
          })),
        };
      }

      if (quoteNote.trim()) body.note = quoteNote.trim();
      body.taxDocumentType = quoteTaxDocType;
      body.taxCategory = quoteTaxCategory;
      body.quoteType = quoteType;
      body.billingType = quoteBillingType || companyBillingType;
      if ((quoteBillingType || companyBillingType) === "prepay_upfront") {
        body.paymentMethod = quotePaymentMethod;
      }
      // 공통 날짜 필드
      if (quoteValidUntil) body.validUntil = quoteValidUntil;
      if (quoteIssueDate) body.issueDate = quoteIssueDate;
      if (quoteInvoiceDueDate) body.invoiceDueDate = quoteInvoiceDueDate;
      if (quotePaymentDueDate) body.paymentDueDate = quotePaymentDueDate;
      // 배치 기간 (필요시 본문에 추가)
      if (quoteBatchStart) body.batchPeriodStart = quoteBatchStart;
      if (quoteBatchEnd) body.batchPeriodEnd = quoteBatchEnd;
      const res = await fetch(api(`/api/admin/projects/${projectId}/quote`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      // 선입금 차감 시 원장에 자동 연동
      if (quoteType === "prepaid_deduction" && selectedPrepaidAcctId) {
        const usageAmt = quoteItemForms.filter(it => it.productName.trim() && Number(it.unitPrice) > 0)
          .reduce((s, it) => s + calcItemTotal(it).total, 0);
        await fetch(api(`/api/admin/prepaid-accounts/${selectedPrepaidAcctId}/transactions`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "deduction", amount: usageAmt,
            description: `프로젝트: ${detail?.title ?? `#${projectId}`}`,
            projectId, transactionDate: new Date().toISOString().slice(0, 10),
          }),
        });
        // 원장 내역 즉시 갱신
        await loadAcctLedger(selectedPrepaidAcctId);
        // 계정 잔액도 갱신
        await loadCompPrepaidAccounts(detail?.companyId ?? 0);
      }
      onToast(`견적 생성 완료`);
      setQuoteAmount(""); setQuoteNote(""); setQuoteItemForms([defaultItem()]); setShowQuoteForm(false);
      setQuoteValidUntil(_dateDefault(15)); setQuoteIssueDate(_dateDefault(0)); setQuoteInvoiceDueDate(""); setQuotePaymentDueDate(_dateDefault(30));
      setQuotePrepaidUsage(""); setSelectedPrepaidAcctId(null); setCompPrepaidAccounts([]); setAcctLedger([]);
      setQuoteBatchStart(""); setQuoteBatchEnd(""); setBatchCandidates([]); setBatchSelected(new Set()); setBatchQueried(false);
      setQuoteBillingType("postpaid_per_project"); setQuotePaymentMethod("card");
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 견적 생성 실패"); }
    finally { setCreatingQuote(false); }
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
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "16px 0 8px", paddingBottom: 5, borderBottom: "1px solid #f3f4f6",
  };
  const dl: React.CSSProperties = { display: "flex", gap: 6, fontSize: 13, marginBottom: 5, alignItems: "flex-start" };
  const dt: React.CSSProperties = { color: "#9ca3af", minWidth: 72, flexShrink: 0 };
  const Empty = ({ label = "미입력" }: { label?: string }) => (
    <span style={{ color: "#d1d5db", fontStyle: "italic", fontSize: 12 }}>{label}</span>
  );
  const Req = () => <span style={{ color: "#dc2626", fontSize: 10, fontWeight: 700, marginLeft: 3 }}>필수</span>;
  const Opt = () => <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 3 }}>(선택)</span>;
  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px", fontSize: 12, fontWeight: active ? 700 : 500, borderRadius: 20, cursor: "pointer",
    border: "1px solid", borderColor: active ? "#2563eb" : "#e5e7eb",
    background: active ? "#eff6ff" : "#fff", color: active ? "#2563eb" : "#6b7280",
  });

  const sections: Array<{ key: typeof activeSection; label: string }> = [
    { key: "info", label: "기본정보" },
    { key: "finance", label: "견적/결제" },
    { key: "work", label: "작업" },
    { key: "settlement", label: "정산" },
    { key: "history", label: `기록${projectFiles.length > 0 ? ` (📎${projectFiles.length})` : ""}` },
  ];

  return (
    <DraggableModal
      title={`프로젝트 #${projectId} 상세`}
      onClose={onClose}
      width={820}
      zIndex={300}
      bodyPadding="20px 28px"
      headerExtra={detail ? <StatusBadge status={detail.status} /> : undefined}
    >
        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
        ) : err ? (
          <p style={{ color: "#dc2626", padding: "16px 0" }}>{err}</p>
        ) : detail && (
          <>
            <ReviewMemoPanel storageKey={`project_${projectId}`} label="이 프로젝트 검수 메모" />
            {/* 액션 바 */}
            <div style={{ background: "#f9fafb", borderRadius: 10, padding: "10px 12px", marginBottom: 14, border: "1px solid #e5e7eb" }}>
              {/* 현재 상태 다음 단계 힌트 */}
              {(() => {
                const noTranslatorBlock = ["approved", "matched", "in_progress"].includes(detail.status) && (detail.tasks ?? []).length === 0;
                if (noTranslatorBlock) {
                  return (
                    <div style={{
                      display: "flex", alignItems: "flex-start", gap: 10,
                      background: "#fdf4ff", border: "1px solid #d8b4fe",
                      borderRadius: 7, padding: "10px 12px", marginBottom: 8,
                    }}>
                      <span style={{ fontSize: 15, lineHeight: 1.2, flexShrink: 0 }}>⚠️</span>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 12, color: "#7c3aed", lineHeight: 1.6 }}>
                          배정된 통번역사가 없습니다. 먼저 <strong>'통번역사 추천'</strong>에서 통번역사를 배정한 후 상태를 변경하세요.
                        </span>
                        <div style={{ marginTop: 8 }}>
                          <GhostBtn onClick={loadCandidates} disabled={loadingCandidates} color="#7c3aed"
                            style={{ fontSize: 12, padding: "6px 14px", fontWeight: 700, background: "#f3e8ff" }}>
                            {loadingCandidates ? "조회 중..." : "통번역사 추천/배정"}
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
                    <span style={{ fontSize: 12, color: STATUS_NEXT_HINT[detail.status].color, lineHeight: 1.5 }}>
                      💡 {STATUS_NEXT_HINT[detail.status].text}
                    </span>
                  </div>
                );
              })()}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {/* 상태 변경 */}
                {(PROJECT_STATUS_TRANSITIONS[detail.status] ?? []).length > 0 && (() => {
                  const block = statusTarget !== detail.status
                    ? getStatusTransitionBlock(statusTarget, detail)
                    : { blocked: false };
                  const isBlocked = block.blocked;
                  return (
                    <>
                      <select value={statusTarget} onChange={e => setStatusTarget(e.target.value)}
                        style={{ ...inputStyle, width: "auto", padding: "6px 10px", fontSize: 12 }}>
                        <option value={detail.status}>{STATUS_LABEL[detail.status] ?? detail.status} (현재)</option>
                        {(PROJECT_STATUS_TRANSITIONS[detail.status] ?? []).map(s => (
                          <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                        ))}
                      </select>
                      <GhostBtn
                        onClick={handleStatusChange}
                        disabled={changingStatus || statusTarget === detail.status || isBlocked}
                        color={isBlocked ? "#9ca3af" : "#2563eb"}
                        style={{ fontSize: 12, padding: "6px 12px" }}
                      >
                        {changingStatus ? "변경 중..." : "상태 변경 적용"}
                      </GhostBtn>
                      <span style={{ color: "#d1d5db", fontSize: 14 }}>|</span>
                      {/* 검증 실패 경고 메시지 */}
                      {block.blocked && block.reason && (
                        <div style={{
                          width: "100%", marginTop: 6,
                          display: "flex", gap: 6, alignItems: "flex-start",
                          background: "#fef2f2", border: "1px solid #fca5a5",
                          borderRadius: 7, padding: "7px 10px",
                        }}>
                          <span style={{ fontSize: 16, lineHeight: 1 }}>⚠️</span>
                          <span style={{ fontSize: 12, color: "#991b1b", lineHeight: 1.5 }}>{block.reason}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
                {/* 재무 상태 변경 */}
                <div style={{ width: "100%", marginTop: 10, paddingTop: 10, borderTop: "1px dashed #e5e7eb" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>재무 상태</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {ALL_FINANCIAL_STATUSES.map(fs => {
                      const isActive = (detail.financialStatus ?? "unbilled") === fs;
                      const target = financialStatusTarget === fs;
                      const fStyle = FINANCIAL_STATUS_STYLE[fs] ?? { background: "#f3f4f6", color: "#6b7280" };
                      return (
                        <button key={fs} onClick={() => setFinancialStatusTarget(fs)}
                          style={{ padding: "4px 12px", borderRadius: 8, border: `2px solid ${target ? (fStyle.color as string) : "#e5e7eb"}`,
                            fontWeight: target || isActive ? 700 : 400, fontSize: 12, cursor: "pointer",
                            background: target ? (fStyle.background as string) : isActive ? "#f9fafb" : "#fff",
                            color: target || isActive ? (fStyle.color as string) : "#6b7280" }}>
                          {FINANCIAL_STATUS_LABEL[fs]}
                          {isActive && " ✓"}
                        </button>
                      );
                    })}
                    <GhostBtn onClick={handleFinancialStatusChange}
                      disabled={changingFinancialStatus || financialStatusTarget === (detail.financialStatus ?? "unbilled")}
                      color="#059669" style={{ fontSize: 12, padding: "4px 12px" }}>
                      {changingFinancialStatus ? "변경 중..." : "재무 상태 적용"}
                    </GhostBtn>
                  </div>
                </div>

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
                  <button onClick={() => setShowCandidates(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 }}>×</button>
                </div>
                {loadingCandidates ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center" }}>조회 중...</p>
                ) : candidates.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13 }}>조건에 맞는 통번역사가 없습니다.</p>
                ) : candidates.map((c, i) => {
                  const av = AVAIL_STYLE[c.profile?.availabilityStatus ?? ""] ?? AVAIL_STYLE.unavailable;
                  return (
                    <div key={c.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 10px", background: "#fff", borderRadius: 8, marginBottom: 6, border: "1px solid #e9d5ff" }}>
                      <span style={{ fontWeight: 700, color: "#7c3aed", fontSize: 16, minWidth: 24 }}>#{i + 1}</span>
                      <div style={{ flex: 1 }}>
                        <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: "#111827" }}>{c.email}</p>
                        <p style={{ margin: 0, fontSize: 11, color: "#6b7280" }}>
                          {c.profile?.languagePairs ?? "언어쌍 미설정"} · {c.profile?.specializations ?? "분야 미설정"}
                          {c.profile?.rating != null && ` · ⭐ ${c.profile.rating.toFixed(1)}`}
                        </p>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: av.color, minWidth: 32 }}>{av.label}</span>
                      <span style={{ fontSize: 11, color: "#6b7280" }}>점수 {c.score}</span>
                      <PrimaryBtn
                        onClick={() => handleAssignTranslator(c.id)}
                        disabled={assigning === c.id}
                        style={{ fontSize: 12, padding: "5px 12px" }}>
                        {assigning === c.id ? "배정 중..." : "배정"}
                      </PrimaryBtn>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 탭 내비 */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {sections.map(s => (
                <button key={s.key} onClick={() => setActiveSection(s.key)} style={tabBtnStyle(activeSection === s.key)}>
                  {s.label}
                </button>
              ))}
            </div>

            {/* 기본 정보 */}
            {activeSection === "info" && (
              <>
                {!editingInfo ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
                      <div style={dl}>
                        <span style={dt}>제목<Req /></span>
                        <strong style={{ color: "#111827", fontSize: 14 }}>{detail.title}</strong>
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
                    <div style={{ marginTop: 14 }}>
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
                          <select value={editCompanyId ?? ""} onChange={async e => {
                            const cid = e.target.value ? Number(e.target.value) : null;
                            setEditCompanyId(cid); setEditContactId(null); setEditDivisionId(null);
                            if (cid) {
                              try {
                                const res = await fetch(api(`/api/admin/companies/${cid}/divisions`), { headers: authH });
                                if (res.ok) setEditDivisionsList(await res.json());
                                else setEditDivisionsList([]);
                              } catch { setEditDivisionsList([]); }
                            } else { setEditDivisionsList([]); }
                          }} style={{ ...inputStyle, width: "100%" }}>
                            <option value="">미연결</option>
                            {companiesList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>담당자</label>
                          <select value={editContactId ?? ""} onChange={e => setEditContactId(e.target.value ? Number(e.target.value) : null)}
                            style={{ ...inputStyle, width: "100%" }}>
                            <option value="">미연결</option>
                            {contactsList
                              .filter(c => !editCompanyId || c.companyId === editCompanyId)
                              .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </div>
                      </div>
                      {/* 브랜드/부서 선택 */}
                      {editDivisionsList.length > 0 && (
                        <div>
                          <label style={{ fontSize: 12, color: "#7c3aed", fontWeight: 600, display: "block", marginBottom: 4 }}>브랜드 / 부서</label>
                          <select value={editDivisionId ?? ""} onChange={e => setEditDivisionId(e.target.value ? Number(e.target.value) : null)}
                            style={{ ...inputStyle, width: "100%", borderColor: "#e9d5ff" }}>
                            <option value="">전체 (부서 없음)</option>
                            {editDivisionsList.map(d => <option key={d.id} value={d.id}>{d.name}{d.type ? ` (${d.type})` : ""}</option>)}
                          </select>
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
                                        <select value={correctionBillingId ?? ""}
                                          onChange={e => setCorrectionBillingId(e.target.value ? Number(e.target.value) : null)}
                                          style={{ ...inputStyle, fontSize: 12, borderColor: "#bae6fd" }}>
                                          <option value="">— 요청 거래처와 동일 —</option>
                                          {companiesList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                        </select>
                                        <p style={{ margin: "3px 0 0", fontSize: 10, color: "#6b7280" }}>현재: {billingName} → {corrBillingName}</p>
                                      </div>
                                      <div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                          <label style={{ fontSize: 11, color: "#059669", fontWeight: 700 }}>💰 변경할 납부 주체</label>
                                          <span style={{ fontSize: 9, color: "#059669", background: "#d1fae5", borderRadius: 3, padding: "1px 4px", fontWeight: 600 }}>입금 기준</span>
                                        </div>
                                        <select value={correctionPayerId ?? ""}
                                          onChange={e => setCorrectionPayerId(e.target.value ? Number(e.target.value) : null)}
                                          style={{ ...inputStyle, fontSize: 12, borderColor: "#a7f3d0" }}>
                                          <option value="">— 청구 대상과 동일 —</option>
                                          {companiesList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                        </select>
                                        <p style={{ margin: "3px 0 0", fontSize: 10, color: "#6b7280" }}>현재: {payerName} → {corrPayerName}</p>
                                      </div>
                                    </div>
                                    <div>
                                      <label style={{ fontSize: 11, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>정정 사유 <span style={{ color: "#dc2626" }}>*</span></label>
                                      <select value={correctionReason} onChange={e => setCorrectionReason(e.target.value)}
                                        style={{ ...inputStyle, fontSize: 12 }}>
                                        <option value="">— 사유를 선택하세요 —</option>
                                        <option value="고객 요청">고객 요청</option>
                                        <option value="오입력 정정">오입력 정정</option>
                                        <option value="계열사 변경">계열사 변경</option>
                                        <option value="계약 변경">계약 변경</option>
                                        <option value="부분 입금 정정">부분 입금 정정</option>
                                        <option value="환불 처리">환불 처리</option>
                                        <option value="기타">기타</option>
                                      </select>
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
                                  <select value={editBillingCompanyId ?? ""} onChange={e => setEditBillingCompanyId(e.target.value ? Number(e.target.value) : null)}
                                    style={{ ...inputStyle, width: "100%", fontSize: 12, borderColor: "#bae6fd" }}>
                                    <option value="">— 요청 거래처와 동일 —</option>
                                    {companiesList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                  </select>
                                </div>
                                <div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                                    <label style={{ fontSize: 11, color: "#059669", fontWeight: 700 }}>💰 납부 주체</label>
                                    <span style={{ fontSize: 9, color: "#059669", background: "#d1fae5", borderRadius: 3, padding: "1px 4px", fontWeight: 600 }}>입금 기준</span>
                                  </div>
                                  <select value={editPayerCompanyId ?? ""} onChange={e => setEditPayerCompanyId(e.target.value ? Number(e.target.value) : null)}
                                    style={{ ...inputStyle, width: "100%", fontSize: 12, borderColor: "#a7f3d0" }}>
                                    <option value="">— 청구 대상과 동일 —</option>
                                    {companiesList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                  </select>
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

            {/* 거래처 / 담당자 — 기본정보 탭 하단에 함께 표시 */}
            {activeSection === "info" && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <p style={sectionHd}>거래처 정보 <Opt /></p>
                </div>
                {detail.company ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px", padding: "12px", background: "#f9fafb", borderRadius: 8, marginBottom: 12 }}>
                    <div style={dl}><span style={dt}>회사명</span><strong>{detail.company.name}</strong></div>
                    <div style={dl}><span style={dt}>업종</span>{detail.company.industry ? <span>{detail.company.industry}</span> : <Empty />}</div>
                    <div style={dl}><span style={dt}>대표자</span>{detail.company.representativeName ? <span>{detail.company.representativeName}</span> : <Empty />}</div>
                    <div style={dl}><span style={dt}>이메일</span>{detail.company.email ? <span>{detail.company.email}</span> : <Empty />}</div>
                    <div style={dl}><span style={dt}>전화</span>{detail.company.phone ? <span>{detail.company.phone}</span> : <Empty />}</div>
                  </div>
                ) : (
                  <div style={{ background: "#fffbeb", borderRadius: 8, padding: "10px 14px", marginBottom: 12, border: "1px solid #fde68a", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 15 }}>⚠</span>
                    <span style={{ fontSize: 12, color: "#92400e" }}>연결된 거래처가 없습니다. '기본정보 수정'에서 거래처를 연결하세요.</span>
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <p style={sectionHd}>담당자 정보 <Opt /></p>
                </div>
                {detail.contact ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px", padding: "12px", background: "#f9fafb", borderRadius: 8 }}>
                    <div style={dl}><span style={dt}>이름</span><strong>{detail.contact.name}</strong></div>
                    <div style={dl}><span style={dt}>부서</span>{detail.contact.department ? <span>{detail.contact.department}</span> : <Empty />}</div>
                    <div style={dl}><span style={dt}>직책</span>{detail.contact.position ? <span>{detail.contact.position}</span> : <Empty />}</div>
                    <div style={dl}><span style={dt}>이메일</span>{detail.contact.email ? <span>{detail.contact.email}</span> : <Empty />}</div>
                    <div style={dl}><span style={dt}>전화</span>{detail.contact.phone ? <span>{detail.contact.phone}</span> : <Empty />}</div>
                  </div>
                ) : (
                  <div style={{ background: "#fffbeb", borderRadius: 8, padding: "10px 14px", border: "1px solid #fde68a", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 15 }}>⚠</span>
                    <span style={{ fontSize: 12, color: "#92400e" }}>연결된 담당자가 없습니다. '기본정보 수정'에서 담당자를 연결하세요.</span>
                  </div>
                )}
              </>
            )}

            {/* 작업 (통번역사 배정 / 작업 관리) */}
            {activeSection === "work" && (
              <>
                {detail.tasks.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af" }}>
                    <p style={{ margin: 0 }}>배정된 통번역사가 없습니다.</p>
                    <p style={{ margin: "6px 0 0", fontSize: 12 }}>상단 '통번역사 추천/배정' 버튼으로 통번역사를 배정하세요.</p>
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
                          <div style={dl}><span style={dt}>언어쌍</span><span>{t.translatorProfile.languagePairs ?? "-"}</span></div>
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
                                <span style={{ color: "#059669", fontWeight: 600, marginLeft: "auto" }}>{Number(r.rate).toLocaleString()}원/{r.unit === "word" ? "단어" : r.unit === "page" ? "페이지" : "시간"}</span>
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

            {/* 견적/결제 탭 */}
            {activeSection === "finance" && (
              <>
                {/* 문서 출력 */}
                <div style={{ background: "#f8fafc", borderRadius: 10, padding: "12px 14px", marginBottom: 16, border: "1px solid #e2e8f0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginRight: 4 }}>문서 출력</span>
                  <button
                    onClick={() => {
                      const url = api(`/api/admin/projects/${projectId}/pdf/quote?token=${encodeURIComponent(token)}`);
                      window.open(url, "_blank", "noopener");
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 5, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    🖨 견적서 PDF
                  </button>
                  <button
                    onClick={() => {
                      const url = api(`/api/admin/projects/${projectId}/pdf/statement?token=${encodeURIComponent(token)}`);
                      window.open(url, "_blank", "noopener");
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 5, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    🖨 거래명세서 PDF
                  </button>
                  <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 4 }}>새 창에서 열린 후 Ctrl+P 또는 인쇄 버튼으로 PDF 저장</span>
                </div>

                {/* 견적 섹션 */}
                {(() => {
                  const canQuote = detail.status === "created" || detail.status === "quoted";
                  const hasQuotes = detail.quotes.length > 0;
                  const formVisible = canQuote && (showQuoteForm || !hasQuotes);
                  const companyBillingType = (detail.company as any)?.billingType ?? "postpaid_per_project";

                  // 공통 인라인 스타일 (컴포넌트 정의 금지 — 매 렌더마다 새 참조가 생기면 React가 remount)
                  const qfIs = { ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box" as const, borderColor: "#d8b4fe" };
                  const qfLbl = (txt: string) => (
                    <label style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", display: "block", marginBottom: 3 }}>{txt}</label>
                  );

                  // 견적 유형별 추가 입력 필드 (JSX 변수 — 컴포넌트 아님)
                  const quoteTypeExtraJsx = (() => {
                    if (quoteType === "b2c_prepaid") return (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                        <div>
                          {qfLbl("견적유효기간 (선택)")}
                          <input type="date" value={quoteValidUntil} onChange={e => setQuoteValidUntil(e.target.value)} style={qfIs} />
                        </div>
                        <div>
                          {qfLbl("입금 기한 (선택)")}
                          <input type="date" value={quotePaymentDueDate} onChange={e => setQuotePaymentDueDate(e.target.value)} style={qfIs} />
                        </div>
                      </div>
                    );
                    if (quoteType === "b2b_standard") return (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
                        <div>
                          {qfLbl("견적유효기간 (선택)")}
                          <input type="date" value={quoteValidUntil} onChange={e => setQuoteValidUntil(e.target.value)} style={qfIs} />
                        </div>
                        <div>
                          {qfLbl("발행 예정일 (선택)")}
                          <input type="date" value={quoteIssueDate} onChange={e => setQuoteIssueDate(e.target.value)} style={qfIs} />
                        </div>
                        <div>
                          {qfLbl("입금 예정일 (선택)")}
                          <input type="date" value={quotePaymentDueDate} onChange={e => setQuotePaymentDueDate(e.target.value)} style={qfIs} />
                        </div>
                      </div>
                    );
                    if (quoteType === "prepaid_deduction") {
                      // ── 선입금 계정 원장 방식 (B2B 전용) ────────────────────────────────────
                      const selectedAcct = compPrepaidAccounts.find(a => a.id === selectedPrepaidAcctId) ?? null;
                      const curBalance = selectedAcct?.currentBalance ?? 0;
                      const usageNum = quoteItemsGrandTotal;
                      const afterBalance = selectedAcct ? curBalance - usageNum : null;
                      const isInsufficient = selectedAcct != null && usageNum > 0 && usageNum > curBalance;
                      const shortageAmount = isInsufficient ? usageNum - curBalance : 0;

                      // ─── Case A-0: 프로젝트에 거래처가 없음 ──────────────────────────
                      if (!detail.companyId) {
                        return (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 14px" }}>
                              <div style={{ fontSize: 10, fontWeight: 800, color: "#dc2626", marginBottom: 8 }}>선입금 차감 — 거래처 없음</div>
                              <div style={{ fontSize: 12, color: "#dc2626" }}>
                                ⚠️ 이 프로젝트에 거래처가 연결되어 있지 않습니다.<br/>
                                <span style={{ fontWeight: 400, color: "#374151" }}>프로젝트 기본 정보에서 거래처를 먼저 설정하세요.</span>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      // ─── Case A: 이 거래처의 선입금 계정이 없음 → 인라인 빠른 등록 ───
                      if (!loadingCompPrepaid && compPrepaidAccounts.length === 0) {
                        return (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ background: "#fef9eb", border: "1px solid #fde68a", borderRadius: 8, padding: "12px 14px" }}>
                              <div style={{ fontSize: 10, fontWeight: 800, color: "#92400e", marginBottom: 8 }}>선입금 차감 — 계정 없음</div>
                              <div style={{ padding: "8px 12px", background: "#fffbeb", borderRadius: 6, border: "1px solid #fde68a", fontSize: 12, color: "#92400e", marginBottom: 12 }}>
                                ⚠️ 이 거래처에 등록된 선입금 계정이 없습니다. 아래에서 바로 등록할 수 있습니다.
                              </div>
                              <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 8 }}>선입금 계정 빠른 등록</div>
                              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                                <div>
                                  {qfLbl("최초 입금액 (원) *")}
                                  <input
                                    type="number" min="0" value={quickPrepaidAmount} placeholder="0"
                                    onChange={e => setQuickPrepaidAmount(e.target.value)}
                                    style={{ ...qfIs, borderColor: "#fde68a" }}
                                  />
                                </div>
                                <div>
                                  {qfLbl("메모 (선택)")}
                                  <input
                                    type="text" value={quickPrepaidNote} placeholder="예: 1분기 선입금"
                                    onChange={e => setQuickPrepaidNote(e.target.value)}
                                    style={{ ...qfIs, borderColor: "#fde68a" }}
                                  />
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); handleQuickRegisterPrepaid(); }}
                                disabled={registeringPrepaid || !quickPrepaidAmount}
                                style={{ padding: "7px 14px", background: registeringPrepaid || !quickPrepaidAmount ? "#9ca3af" : "#d97706", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: registeringPrepaid || !quickPrepaidAmount ? "not-allowed" : "pointer" }}
                              >
                                {registeringPrepaid ? "등록 중..." : "선입금 계정 등록 후 차감 진행"}
                              </button>
                            </div>
                          </div>
                        );
                      }

                      // ─── 로딩 중 ───────────────────────────────────────────────────────────
                      if (loadingCompPrepaid) {
                        return <div style={{ padding: "12px 0", fontSize: 12, color: "#9ca3af" }}>선입금 계정 불러오는 중...</div>;
                      }

                      // ─── Case B / C: 계정 있음 ─────────────────────────────────────────────
                      return (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ background: "#fdf4ff", border: `1px solid ${isInsufficient ? "#f87171" : "#d8b4fe"}`, borderRadius: 8, padding: "12px 14px" }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: "#7c3aed", marginBottom: 10 }}>
                              B2B 선입금 차감
                            </div>

                            {/* 계정 선택 (여러 계정 있을 때) */}
                            {compPrepaidAccounts.length > 1 && (
                              <div style={{ marginBottom: 10 }}>
                                {qfLbl("차감할 선입금 계정 선택")}
                                <select value={selectedPrepaidAcctId ?? ""} onChange={e => setSelectedPrepaidAcctId(Number(e.target.value))} style={{ ...qfIs }}>
                                  {compPrepaidAccounts.map(a => (
                                    <option key={a.id} value={a.id}>
                                      {a.depositDate ?? "-"}{a.note ? ` · ${a.note}` : ""} — 잔액 {a.currentBalance.toLocaleString()}원
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}

                            {/* 잔액 요약 */}
                            {selectedAcct && (
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, padding: "10px 12px", background: "#f5f3ff", borderRadius: 7, border: "1px solid #ede9fe" }}>
                                {[
                                  { label: "최초 입금액", value: `${selectedAcct.initialAmount.toLocaleString()}원`, color: "#7c3aed" },
                                  { label: "사용 누계", value: `${(selectedAcct.initialAmount - selectedAcct.currentBalance).toLocaleString()}원`, color: "#6b7280" },
                                  { label: "현재 잔액", value: `${selectedAcct.currentBalance.toLocaleString()}원`, color: selectedAcct.currentBalance > 0 ? "#15803d" : "#dc2626", bold: true },
                                ].map(s => (
                                  <div key={s.label} style={{ flex: "1 1 120px", minWidth: 110 }}>
                                    <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", marginBottom: 2 }}>{s.label}</div>
                                    <div style={{ fontSize: 14, fontWeight: s.bold ? 800 : 600, color: s.color }}>{s.value}</div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Case B: 잔액 0원 */}
                            {selectedAcct && selectedAcct.currentBalance === 0 && (
                              <div style={{ padding: "8px 12px", background: "#fef2f2", borderRadius: 6, border: "1px solid #fca5a5", fontSize: 12, color: "#dc2626", fontWeight: 600 }}>
                                ⚠️ 현재 선입금 잔액이 <strong>0원</strong>입니다. 선입금 현황 탭에서 추가 입금 후 차감하세요.
                              </div>
                            )}

                            {/* Case C: 잔액 있음 — 항목 합계로 자동 차감 */}
                            {selectedAcct && selectedAcct.currentBalance > 0 && (
                              <div>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                                  <div>
                                    {qfLbl("현재 잔액 (원)")}
                                    <div style={{ ...qfIs, background: "#f0fdf4", color: "#15803d", cursor: "not-allowed", display: "flex", alignItems: "center", fontWeight: 700, border: "1px solid #86efac" }}>
                                      {curBalance.toLocaleString()}
                                    </div>
                                  </div>
                                  <div>
                                    {qfLbl("이번 차감 금액 (아래 항목 합계)")}
                                    <div style={{ ...qfIs, background: usageNum > 0 ? "#fdf4ff" : "#f8fafc", color: usageNum > 0 ? "#7c3aed" : "#9ca3af", border: `1px solid ${isInsufficient ? "#f87171" : usageNum > 0 ? "#d8b4fe" : "#e2e8f0"}`, display: "flex", alignItems: "center", fontWeight: 700, cursor: "default" }}>
                                      {usageNum > 0 ? usageNum.toLocaleString() : <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>아래 항목 입력 시 자동</span>}
                                    </div>
                                  </div>
                                  <div>
                                    {qfLbl("차감 후 잔액 (원)")}
                                    <div style={{ ...qfIs, background: isInsufficient ? "#fef2f2" : "#f5f3ff", color: isInsufficient ? "#dc2626" : "#374151", cursor: "not-allowed", display: "flex", alignItems: "center", fontWeight: isInsufficient ? 700 : 500 }}>
                                      {afterBalance != null ? afterBalance.toLocaleString() : <span style={{ color: "#9ca3af" }}>-</span>}
                                    </div>
                                  </div>
                                </div>

                                {/* 잔액 부족 경고 */}
                                {isInsufficient && (
                                  <div style={{ marginTop: 8, padding: "10px 12px", background: "#fef2f2", borderRadius: 6, border: "1px solid #fca5a5" }}>
                                    <div style={{ fontSize: 12, color: "#dc2626", fontWeight: 700, marginBottom: 6 }}>⚠️ 잔액 부족 — 견적 생성 불가</div>
                                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                                      {[
                                        { label: "차감 요청 금액", value: `${usageNum.toLocaleString()}원`, color: "#dc2626" },
                                        { label: "현재 잔액", value: `${curBalance.toLocaleString()}원`, color: "#374151" },
                                        { label: "부족 금액", value: `${shortageAmount.toLocaleString()}원`, color: "#b45309", bold: true },
                                      ].map(item => (
                                        <div key={item.label}>
                                          <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af" }}>{item.label}</div>
                                          <div style={{ fontSize: 13, fontWeight: item.bold ? 800 : 600, color: item.color }}>{item.value}</div>
                                        </div>
                                      ))}
                                    </div>
                                    <div style={{ marginTop: 8, fontSize: 11, color: "#92400e", background: "#fef3c7", borderRadius: 5, padding: "5px 10px", border: "1px solid #fde68a" }}>
                                      💡 선입금 현황 탭에서 이 거래처의 선입금 계정에 {shortageAmount.toLocaleString()}원 이상 추가 입금하세요.
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            {/* ─── 누적 거래 내역 테이블 ─── */}
                            {acctLedger.length > 0 && (
                              <div style={{ marginTop: 12, borderTop: "1px solid #ede9fe", paddingTop: 10 }}>
                                <div style={{ fontSize: 10, fontWeight: 800, color: "#6d28d9", marginBottom: 6, letterSpacing: "0.5px" }}>
                                  거래 내역 ({acctLedger.length}건)
                                </div>
                                <div style={{ overflowX: "auto" }}>
                                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                    <thead>
                                      <tr style={{ background: "#f5f3ff" }}>
                                        {[
                                          { h: "날짜", align: "left" as const },
                                          { h: "구분", align: "center" as const },
                                          { h: "내용 / 프로젝트", align: "left" as const },
                                          { h: "공급가", align: "right" as const },
                                          { h: "부가세", align: "right" as const },
                                          { h: "합계", align: "right" as const },
                                          { h: "잔액", align: "right" as const },
                                        ].map(({ h, align }) => (
                                          <th key={h} style={{ padding: "5px 8px", fontWeight: 700, color: "#4b5563", borderBottom: "2px solid #d8b4fe", whiteSpace: "nowrap", textAlign: align, fontSize: 10 }}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {acctLedger.map((tx, idx) => {
                                        const dateStr = tx.transactionDate ? tx.transactionDate.slice(0, 10) : (tx.createdAt ? tx.createdAt.slice(0, 10) : "-");
                                        const desc = tx.projectTitle ? `${tx.projectTitle}${tx.description ? " · " + tx.description : ""}` : (tx.description || "-");
                                        const typeLabel = tx.type === "deposit" ? "입금" : tx.type === "deduction" ? "차감" : "조정";
                                        const typeColor = tx.type === "deposit" ? "#166534" : tx.type === "deduction" ? "#7c3aed" : "#374151";
                                        const bgColor = tx.type === "deduction" ? (idx % 2 === 0 ? "#fdf4ff" : "#f5f0ff") : (idx % 2 === 0 ? "#fff" : "#f9fafb");
                                        const isDeduct = tx.type === "deduction";
                                        const tdBase: React.CSSProperties = { padding: "5px 8px", borderBottom: "1px solid #f0e7ff", whiteSpace: "nowrap" };
                                        return (
                                          <tr key={tx.id} style={{ background: bgColor }}>
                                            <td style={{ ...tdBase, color: "#6b7280" }}>{dateStr}</td>
                                            <td style={{ ...tdBase, textAlign: "center" }}>
                                              <span style={{ background: isDeduct ? "#ede9fe" : tx.type === "deposit" ? "#dcfce7" : "#f3f4f6", color: typeColor, fontWeight: 700, fontSize: 10, borderRadius: 4, padding: "1px 6px" }}>{typeLabel}</span>
                                            </td>
                                            <td style={{ ...tdBase, color: "#374151", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{desc}</td>
                                            {/* 공급가 */}
                                            <td style={{ ...tdBase, textAlign: "right", color: "#374151" }}>
                                              {isDeduct && tx.supplyAmount != null ? tx.supplyAmount.toLocaleString() : <span style={{ color: "#d1d5db" }}>-</span>}
                                            </td>
                                            {/* 부가세 */}
                                            <td style={{ ...tdBase, textAlign: "right", color: isDeduct && tx.taxAmount != null && tx.taxAmount > 0 ? "#7c3aed" : "#374151" }}>
                                              {isDeduct && tx.taxAmount != null ? (tx.taxAmount > 0 ? tx.taxAmount.toLocaleString() : "0") : <span style={{ color: "#d1d5db" }}>-</span>}
                                            </td>
                                            {/* 합계 */}
                                            <td style={{ ...tdBase, textAlign: "right", fontWeight: 800, color: typeColor }}>
                                              {tx.type === "deposit" ? "+" : tx.type === "deduction" ? "-" : "±"}{tx.amount.toLocaleString()}
                                            </td>
                                            {/* 잔액 */}
                                            <td style={{ ...tdBase, textAlign: "right", fontWeight: 700, color: tx.balanceAfter < 0 ? "#dc2626" : "#15803d" }}>
                                              {tx.balanceAfter.toLocaleString()}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                            {loadingLedger && (
                              <div style={{ marginTop: 10, fontSize: 11, color: "#9ca3af" }}>거래 내역 불러오는 중...</div>
                            )}
                          </div>
                        </div>
                      );
                    }
                    if (quoteType === "accumulated_batch") {
                      const companyId = detail.companyId;
                      const batchData = activeBatch === "loading" ? null : activeBatch;
                      const isLoading = activeBatch === "loading";
                      const wis = batchData?.workItems ?? [];
                      const wiTotal = wis.reduce((s, w) => s + w.amount, 0);
                      const thSt = { padding: "4px 6px", textAlign: "left" as const, color: "#065f46", borderBottom: "1px solid #6ee7b7", fontSize: 10, fontWeight: 700 };
                      const tdSt = { padding: "4px 5px", fontSize: 11, verticalAlign: "middle" as const };
                      const inpSt = { width: "100%", fontSize: 11, padding: "2px 4px", border: "1px solid #6ee7b7", borderRadius: 4, boxSizing: "border-box" as const };
                      return (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 8, padding: "12px 14px" }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: "#065f46", marginBottom: 10 }}>🗂️ 누적 청구 배치</div>

                            {!companyId && (
                              <div style={{ padding: "8px 10px", background: "#fef3c7", borderRadius: 6, border: "1px solid #fcd34d", fontSize: 12, color: "#92400e", marginBottom: 8 }}>
                                ⚠️ 이 프로젝트에 거래처를 먼저 설정해야 누적 배치를 사용할 수 있습니다.
                              </div>
                            )}

                            {isLoading && (
                              <div style={{ textAlign: "center", fontSize: 12, color: "#6b7280", padding: "12px 0" }}>배치 정보 로딩 중...</div>
                            )}

                            {!isLoading && batchData === null && companyId && (
                              <div>
                                <div style={{ padding: "10px 12px", background: "#f0fdf4", borderRadius: 6, border: "1px solid #bbf7d0", fontSize: 12, color: "#065f46", marginBottom: 10 }}>
                                  진행 중인 누적 배치가 없습니다. 새 배치를 시작하여 작업 항목을 건별로 입력하고 월말에 합산 발행하세요.
                                </div>
                                <button type="button" onClick={() => createNewBatch(companyId)} disabled={activeBatchOp}
                                  style={{ padding: "7px 16px", background: "#065f46", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                                  {activeBatchOp ? "생성 중..." : "🆕 새 누적 배치 시작"}
                                </button>
                              </div>
                            )}

                            {!isLoading && batchData != null && (
                              <div>
                                {/* 배치 헤더 */}
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, padding: "7px 10px", background: "#d1fae5", borderRadius: 6 }}>
                                  <div>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: "#065f46" }}>배치 #{batchData.id}</span>
                                    <span style={{ fontSize: 10, color: "#6b7280", marginLeft: 8 }}>{batchData.periodStart?.slice(0, 10)} ~ {batchData.periodEnd?.slice(0, 10)}</span>
                                  </div>
                                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "#065f46", color: "#fff", fontWeight: 700 }}>진행 중</span>
                                    <span style={{ fontSize: 12, fontWeight: 800, color: "#065f46" }}>{wiTotal.toLocaleString()}원</span>
                                  </div>
                                </div>

                                {/* 작업 항목 테이블 */}
                                <div style={{ overflowX: "auto", marginBottom: 6 }}>
                                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                                    <thead>
                                      <tr style={{ background: "#d1fae5" }}>
                                        <th style={{ ...thSt, width: 86 }}>작업일</th>
                                        <th style={{ ...thSt }}>프로젝트명</th>
                                        <th style={{ ...thSt, width: 80 }}>언어</th>
                                        <th style={{ ...thSt }}>내용</th>
                                        <th style={{ ...thSt, width: 50, textAlign: "right" }}>수량</th>
                                        <th style={{ ...thSt, width: 80, textAlign: "right" }}>단가</th>
                                        <th style={{ ...thSt, width: 80, textAlign: "right" }}>금액</th>
                                        <th style={{ ...thSt, width: 48, textAlign: "center" }}></th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {wis.length === 0 && !showAddWI && (
                                        <tr>
                                          <td colSpan={8} style={{ textAlign: "center", fontSize: 12, color: "#9ca3af", padding: "12px 0" }}>
                                            아직 작업 항목이 없습니다. 아래 버튼으로 추가하세요.
                                          </td>
                                        </tr>
                                      )}
                                      {wis.map((w, i) => {
                                        const isEditing = editingWIId === w.id;
                                        if (isEditing) {
                                          return (
                                            <tr key={w.id} style={{ background: "#fefce8" }}>
                                              <td style={tdSt}><input type="date" value={editWI.workDate} onChange={e => setEditWI(p => ({ ...p, workDate: e.target.value }))} style={inpSt} /></td>
                                              <td style={tdSt}><input value={editWI.projectName} onChange={e => setEditWI(p => ({ ...p, projectName: e.target.value }))} style={inpSt} placeholder="프로젝트명" /></td>
                                              <td style={tdSt}><input value={editWI.language} onChange={e => setEditWI(p => ({ ...p, language: e.target.value }))} style={inpSt} placeholder="KO→EN" /></td>
                                              <td style={tdSt}><input value={editWI.description} onChange={e => setEditWI(p => ({ ...p, description: e.target.value }))} style={inpSt} placeholder="내용" /></td>
                                              <td style={{ ...tdSt, textAlign: "right" }}><input type="number" value={editWI.quantity} onChange={e => {
                                                const qty = parseFloat(e.target.value) || 0;
                                                const price = parseFloat(editWI.unitPrice) || 0;
                                                setEditWI(p => ({ ...p, quantity: e.target.value, amount: qty && price ? String(Math.round(qty * price)) : p.amount }));
                                              }} style={{ ...inpSt, textAlign: "right" }} /></td>
                                              <td style={{ ...tdSt, textAlign: "right" }}><input type="number" value={editWI.unitPrice} onChange={e => {
                                                const price = parseFloat(e.target.value) || 0;
                                                const qty = parseFloat(editWI.quantity) || 0;
                                                setEditWI(p => ({ ...p, unitPrice: e.target.value, amount: qty && price ? String(Math.round(qty * price)) : p.amount }));
                                              }} style={{ ...inpSt, textAlign: "right" }} /></td>
                                              <td style={{ ...tdSt, textAlign: "right" }}><input type="number" value={editWI.amount} onChange={e => setEditWI(p => ({ ...p, amount: e.target.value }))} style={{ ...inpSt, textAlign: "right" }} placeholder="자동" /></td>
                                              <td style={{ ...tdSt, textAlign: "center" }}>
                                                <button type="button" onClick={() => saveWorkItem(batchData.id, w.id, editWI)} disabled={activeBatchOp}
                                                  style={{ fontSize: 10, padding: "2px 6px", background: "#065f46", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", marginBottom: 2, display: "block", width: "100%" }}>저장</button>
                                                <button type="button" onClick={() => setEditingWIId(null)}
                                                  style={{ fontSize: 10, padding: "2px 6px", background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", borderRadius: 3, cursor: "pointer", display: "block", width: "100%" }}>취소</button>
                                              </td>
                                            </tr>
                                          );
                                        }
                                        return (
                                          <tr key={w.id} style={{ background: i % 2 === 0 ? "#fff" : "#f0fdf4" }}>
                                            <td style={{ ...tdSt, color: "#6b7280" }}>{w.workDate || "-"}</td>
                                            <td style={{ ...tdSt, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={w.projectName ?? ""}>{w.projectName || "-"}</td>
                                            <td style={{ ...tdSt, color: "#6b7280" }}>{w.language || "-"}</td>
                                            <td style={{ ...tdSt, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={w.description ?? ""}>{w.description || "-"}</td>
                                            <td style={{ ...tdSt, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{w.quantity}</td>
                                            <td style={{ ...tdSt, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{w.unitPrice > 0 ? w.unitPrice.toLocaleString() : "-"}</td>
                                            <td style={{ ...tdSt, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{w.amount.toLocaleString()}원</td>
                                            <td style={{ ...tdSt, textAlign: "center" }}>
                                              <button type="button" disabled={activeBatchOp}
                                                onClick={() => { setEditingWIId(w.id); setEditWI({ workDate: w.workDate ?? "", projectName: w.projectName ?? "", language: w.language ?? "", description: w.description ?? "", quantity: String(w.quantity), unitPrice: String(w.unitPrice), amount: String(w.amount) }); }}
                                                style={{ fontSize: 10, padding: "1px 5px", background: "#e0f2fe", color: "#0369a1", border: "1px solid #7dd3fc", borderRadius: 3, cursor: "pointer", marginBottom: 2, display: "block", width: "100%" }}>수정</button>
                                              <button type="button" disabled={activeBatchOp} onClick={() => deleteWorkItem(batchData.id, w.id)}
                                                style={{ fontSize: 10, padding: "1px 5px", background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 3, cursor: "pointer", display: "block", width: "100%" }}>삭제</button>
                                            </td>
                                          </tr>
                                        );
                                      })}

                                      {/* 항목 추가 폼 행 */}
                                      {showAddWI && (
                                        <tr style={{ background: "#f0fdf4" }}>
                                          <td style={tdSt}><input type="date" value={newWI.workDate} onChange={e => setNewWI(p => ({ ...p, workDate: e.target.value }))} style={inpSt} /></td>
                                          <td style={tdSt}><input value={newWI.projectName} onChange={e => setNewWI(p => ({ ...p, projectName: e.target.value }))} style={inpSt} placeholder="프로젝트명" /></td>
                                          <td style={tdSt}><input value={newWI.language} onChange={e => setNewWI(p => ({ ...p, language: e.target.value }))} style={inpSt} placeholder="KO→EN" /></td>
                                          <td style={tdSt}><input value={newWI.description} onChange={e => setNewWI(p => ({ ...p, description: e.target.value }))} style={inpSt} placeholder="내용" /></td>
                                          <td style={{ ...tdSt }}><input type="number" value={newWI.quantity} onChange={e => {
                                            const qty = parseFloat(e.target.value) || 0;
                                            const price = parseFloat(newWI.unitPrice) || 0;
                                            setNewWI(p => ({ ...p, quantity: e.target.value, amount: qty && price ? String(Math.round(qty * price)) : p.amount }));
                                          }} style={{ ...inpSt, textAlign: "right" }} /></td>
                                          <td style={{ ...tdSt }}><input type="number" value={newWI.unitPrice} onChange={e => {
                                            const price = parseFloat(e.target.value) || 0;
                                            const qty = parseFloat(newWI.quantity) || 0;
                                            setNewWI(p => ({ ...p, unitPrice: e.target.value, amount: qty && price ? String(Math.round(qty * price)) : p.amount }));
                                          }} style={{ ...inpSt, textAlign: "right" }} placeholder="단가" /></td>
                                          <td style={{ ...tdSt }}><input type="number" value={newWI.amount} onChange={e => setNewWI(p => ({ ...p, amount: e.target.value }))} style={{ ...inpSt, textAlign: "right" }} placeholder="(수량×단가)" /></td>
                                          <td style={{ ...tdSt, textAlign: "center" }}>
                                            <button type="button" onClick={() => addWorkItem(batchData.id, newWI)} disabled={activeBatchOp}
                                              style={{ fontSize: 10, padding: "2px 6px", background: "#065f46", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", marginBottom: 2, display: "block", width: "100%" }}>추가</button>
                                            <button type="button" onClick={() => { setShowAddWI(false); setNewWI(emptyNewWI()); }}
                                              style={{ fontSize: 10, padding: "2px 6px", background: "#f3f4f6", color: "#374151", border: "1px solid #d1d5db", borderRadius: 3, cursor: "pointer", display: "block", width: "100%" }}>취소</button>
                                          </td>
                                        </tr>
                                      )}
                                    </tbody>
                                    {wis.length > 0 && (
                                      <tfoot>
                                        <tr style={{ background: "#065f46" }}>
                                          <td colSpan={6} style={{ padding: "5px 6px", color: "#d1fae5", fontSize: 11, fontWeight: 700 }}>합계 ({wis.length}건)</td>
                                          <td style={{ padding: "5px 6px", textAlign: "right", color: "#fff", fontSize: 12, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{wiTotal.toLocaleString()}원</td>
                                          <td></td>
                                        </tr>
                                      </tfoot>
                                    )}
                                  </table>
                                </div>

                                {/* 항목 추가 버튼 */}
                                {!showAddWI && (
                                  <button type="button" onClick={() => { setShowAddWI(true); setNewWI(emptyNewWI()); }} disabled={activeBatchOp}
                                    style={{ fontSize: 11, padding: "4px 12px", background: "#f0fdf4", color: "#065f46", border: "1px solid #6ee7b7", borderRadius: 5, cursor: "pointer", fontWeight: 600, marginBottom: 8 }}>
                                    ➕ 작업 항목 추가
                                  </button>
                                )}

                                {/* 발행 영역 */}
                                {wis.length > 0 && (
                                  <div style={{ marginTop: 8, padding: "10px 12px", background: "#f0fdf4", borderRadius: 7, border: "1px solid #6ee7b7" }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: "#065f46", marginBottom: 8 }}>📄 세금계산서 발행 (배치 확정)</div>
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                                      <div>
                                        {qfLbl("발행일 *")}
                                        <input type="date" value={issueDateBatch} onChange={e => setIssueDateBatch(e.target.value)} style={{ ...qfIs, borderColor: "#6ee7b7", width: 130 }} />
                                      </div>
                                      <div>
                                        {qfLbl("입금 예정일")}
                                        <input type="date" value={paymentDueDateBatch} onChange={e => setPaymentDueDateBatch(e.target.value)} style={{ ...qfIs, borderColor: "#6ee7b7", width: 130 }} />
                                      </div>
                                      <button type="button" onClick={() => issueBatch(batchData.id)} disabled={activeBatchOp || !issueDateBatch}
                                        style={{ padding: "7px 16px", background: activeBatchOp ? "#9ca3af" : "#065f46", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 1 }}>
                                        {activeBatchOp ? "발행 중..." : `🧾 ${wis.length}건 합산 세금계산서 발행`}
                                      </button>
                                    </div>
                                    <div style={{ marginTop: 6, fontSize: 10, color: "#6b7280" }}>
                                      ⚠️ 발행 후 배치가 확정되며, 이 프로젝트에 누적 견적서가 생성됩니다. 발행 후 항목 수정은 불가능합니다.
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })();

                  // 견적 폼 JSX (컴포넌트 아님 — IIFE로 즉시 계산)
                  const quoteFormJsx = (
                    <div style={{ background: "#fdf4ff", borderRadius: 10, padding: "14px 16px", marginBottom: 12, border: "1px solid #e9d5ff" }}>
                      {/* 헤더 */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>
                            {hasQuotes ? "✏️ 견적 수정/재생성" : "📋 견적 생성"}
                          </p>
                          {hasQuotes && <span style={{ fontSize: 11, color: "#9ca3af" }}>기존 견적이 대체됩니다</span>}
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          {hasQuotes && (
                            <button onClick={() => setShowQuoteForm(false)}
                              style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>×</button>
                          )}
                        </div>
                      </div>

                      {/* 상태 롤백 경고 배너 */}
                      {hasQuotes && ["approved", "matched", "in_progress", "completed"].includes(detail.status) && (
                        <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6, padding: "7px 10px", marginBottom: 10, fontSize: 12, color: "#92400e", display: "flex", alignItems: "center", gap: 6 }}>
                          ⚠️ 이 변경은 현재 상태를 되돌립니다 (프로젝트: 견적발송 / 견적: 검토대기)
                        </div>
                      )}

                      {/* 견적서 유형 선택 */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#1e3a8a", display: "block", marginBottom: 3 }}>견적서 유형 *</label>
                          <select value={quoteType} onChange={e => changeQuoteType(e.target.value as typeof quoteType)}
                            style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", borderColor: "#93c5fd", background: "#eff6ff" }}>
                            <option value="b2b_standard">B2B 일반 견적서</option>
                            <option value="b2c_prepaid">B2C 선입금 견적서</option>
                            <option value="prepaid_deduction">선입금 차감 견적서</option>
                            <option value="accumulated_batch">누적 견적서</option>
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", display: "block", marginBottom: 3 }}>
                            청구 방식 (거래처 기본: <span style={{ color: "#1d4ed8" }}>{companyBillingType === "prepaid_wallet" ? "선입금 차감" : companyBillingType === "monthly_billing" ? "누적 청구" : companyBillingType === "prepay_upfront" ? "선결제(카드/현금)" : "건별 후불"}</span>)
                          </label>
                          {quoteType === "accumulated_batch" ? (
                            <div style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box" as const, background: "#ecfdf5", borderColor: "#6ee7b7", color: "#065f46", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                              🗂️ 누적 청구 <span style={{ fontSize: 9, color: "#6b7280", fontWeight: 400 }}>(누적 견적 고정)</span>
                            </div>
                          ) : (
                            <select value={quoteBillingType || companyBillingType} onChange={e => setQuoteBillingType(e.target.value)}
                              style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", borderColor: "#e2e8f0" }}>
                              <option value="postpaid_per_project">건별 후불</option>
                              <option value="monthly_billing">누적 청구</option>
                              <option value="prepaid_wallet">선입금 차감</option>
                              <option value="prepay_upfront">선결제(카드/현금)</option>
                            </select>
                          )}
                        </div>
                      </div>

                      {/* 결제수단 — 선결제(prepay_upfront) 선택 시만 노출 */}
                      {(quoteBillingType || companyBillingType) === "prepay_upfront" && (
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#059669", display: "block", marginBottom: 3 }}>결제수단 *</label>
                          <select value={quotePaymentMethod} onChange={e => setQuotePaymentMethod(e.target.value)}
                            style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box" as const, borderColor: "#6ee7b7" }}>
                            <option value="card">카드</option>
                            <option value="cash">현금</option>
                            <option value="bank">계좌이체</option>
                          </select>
                        </div>
                      )}

                      {/* 세무/발행 구분 선택 */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", display: "block", marginBottom: 3 }}>문서 구분 *</label>
                          <select value={quoteTaxDocType} onChange={e => setQuoteTaxDocType(e.target.value as "tax_invoice" | "zero_tax_invoice" | "bill")}
                            style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", borderColor: "#d8b4fe" }}>
                            <option value="tax_invoice">세금계산서</option>
                            <option value="zero_tax_invoice">세금계산서(영세율)</option>
                            <option value="bill">계산서</option>
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", display: "block", marginBottom: 3 }}>발행 유형 *</label>
                          <select value={quoteTaxCategory} onChange={e => setQuoteTaxCategory(e.target.value as "normal" | "zero_rated" | "consignment" | "consignment_zero_rated")}
                            style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", borderColor: "#d8b4fe" }}>
                            <option value="normal">일반</option>
                            <option value="zero_rated">영세율</option>
                            <option value="consignment">위수탁</option>
                            <option value="consignment_zero_rated">위수탁영세율</option>
                          </select>
                        </div>
                      </div>

                      {/* 유형별 추가 입력 필드 */}
                      {quoteTypeExtraJsx}

                      {/* 항목 입력 그리드 — 누적 배치 제외 모든 유형 공통 */}
                      {quoteType !== "accumulated_batch" && (
                        <div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 76px 40px 52px 80px 44px 76px 76px 24px", gap: 4, marginBottom: 4 }}>
                            {["항목명", "언어쌍", "단위", "수량", "단가(원)", "세율", "부가세(원)", "합계(원)", ""].map(h => (
                              <div key={h} style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", padding: "0 2px" }}>{h}</div>
                            ))}
                          </div>
                          {quoteItemForms.map((it, idx) => {
                            const { supply, tax, total } = calcItemTotal(it);
                            const roSt: React.CSSProperties = { ...inputStyle, fontSize: 12, padding: "6px 5px", textAlign: "right", background: "#f8fafc", cursor: "default" };
                            return (
                              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 76px 40px 52px 80px 44px 76px 76px 24px", gap: 4, marginBottom: 6, alignItems: "center" }}>
                                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                  <select
                                    value={it.productId ?? ""}
                                    onChange={e => {
                                      const pid = e.target.value ? Number(e.target.value) : null;
                                      if (pid) {
                                        const prod = quoteProducts.find(p => p.id === pid);
                                        if (prod) {
                                          setQuoteItemForms(prev => prev.map((p, i) => i === idx ? {
                                            ...p,
                                            productId: prod.id,
                                            productName: prod.name,
                                            unit: prod.unit,
                                            unitPrice: String(prod.basePrice),
                                          } : p));
                                          return;
                                        }
                                      }
                                      setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, productId: null } : p));
                                    }}
                                    style={{ ...inputStyle, fontSize: 11, padding: "5px 4px", color: it.productId ? "#1e40af" : "#9ca3af" }}
                                  >
                                    <option value="">상품 선택...</option>
                                    {quoteProducts.map(p => (
                                      <option key={p.id} value={p.id}>
                                        {p.mainCategory ? `[${p.mainCategory}] ` : ""}{p.name} — {Number(p.basePrice).toLocaleString()}원/{p.unit}
                                      </option>
                                    ))}
                                  </select>
                                  <input value={it.productName} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, productName: e.target.value } : p))}
                                    placeholder="항목명 직접 입력" style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }} />
                                </div>
                                <input value={it.languagePair} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, languagePair: e.target.value } : p))}
                                  placeholder="EN→KO" style={{ ...inputStyle, fontSize: 11, padding: "6px 4px", textAlign: "center" }} />
                                <input value={it.unit} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, unit: e.target.value } : p))}
                                  placeholder="건" style={{ ...inputStyle, fontSize: 12, padding: "6px 4px", textAlign: "center" }} />
                                <input type="number" value={it.quantity} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, quantity: e.target.value } : p))}
                                  min="0" style={{ ...inputStyle, fontSize: 12, padding: "6px 4px", textAlign: "right" }} />
                                <input type="number" value={it.unitPrice} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, unitPrice: e.target.value } : p))}
                                  placeholder="0" min="0" style={{ ...inputStyle, fontSize: 12, padding: "6px 5px", textAlign: "right" }} />
                                <select value={it.taxRate} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, taxRate: e.target.value as "0"|"0.1" } : p))}
                                  style={{ ...inputStyle, fontSize: 11, padding: "6px 2px" }}>
                                  <option value="0">면세</option>
                                  <option value="0.1">10%</option>
                                </select>
                                <input readOnly value={supply > 0 && it.taxRate !== "0" ? tax.toLocaleString() : supply > 0 ? "면세" : ""}
                                  placeholder="자동"
                                  style={{ ...roSt, color: tax > 0 ? "#7c3aed" : "#9ca3af", fontWeight: tax > 0 ? 700 : 400 }} />
                                <input readOnly value={supply > 0 ? total.toLocaleString() : ""}
                                  placeholder="자동"
                                  style={{ ...roSt, color: supply > 0 ? "#065f46" : "#9ca3af", fontWeight: supply > 0 ? 800 : 400, borderColor: supply > 0 ? "#6ee7b7" : undefined }} />
                                <button onClick={() => setQuoteItemForms(prev => prev.filter((_, i) => i !== idx))} disabled={quoteItemForms.length <= 1}
                                  style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                              </div>
                            );
                          })}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 8 }}>
                            <button onClick={() => setQuoteItemForms(prev => [...prev, defaultItem()])}
                              style={{ fontSize: 12, color: "#7c3aed", background: "none", border: "1px dashed #d8b4fe", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>
                              + 항목 추가
                            </button>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              {quoteItemsGrandTotal > 0 && (
                                <span style={{ fontSize: 12, fontWeight: 700, color: "#065f46" }}>
                                  총합계: {quoteItemsGrandTotal.toLocaleString()}원
                                </span>
                              )}
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                            <input
                              value={quoteNote}
                              onChange={e => setQuoteNote(e.target.value)}
                              placeholder="비고/메모 (선택)"
                              style={{ ...inputStyle, fontSize: 12, padding: "6px 10px" }}
                            />
                            {(() => {
                              let cannotCreate = false;
                              if (quoteType === "prepaid_deduction") {
                                const selAcct = compPrepaidAccounts.find(a => a.id === selectedPrepaidAcctId) ?? null;
                                const noAcct = compPrepaidAccounts.length === 0;
                                const zeroBalance2 = selAcct !== null && selAcct.currentBalance === 0;
                                const isInsuff2 = selAcct != null && quoteItemsGrandTotal > 0 && quoteItemsGrandTotal > selAcct.currentBalance;
                                cannotCreate = noAcct || zeroBalance2 || isInsuff2;
                              }
                              return (
                                <PrimaryBtn onClick={handleCreateQuote}
                                  disabled={creatingQuote || cannotCreate || (!hasQuotes && quoteItemsGrandTotal === 0)}
                                  style={{ fontSize: 12, padding: "7px 14px", background: (cannotCreate || (!hasQuotes && quoteItemsGrandTotal === 0)) ? "#9ca3af" : "#7c3aed", border: "none", alignSelf: "flex-end" }}>
                                  {creatingQuote ? "생성 중..." : hasQuotes ? "견적 재생성" : "견적 생성"}
                                </PrimaryBtn>
                              );
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  );

                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: formVisible ? 6 : 8 }}>
                        <p style={sectionHd}>견적 ({detail.quotes.length})</p>
                        {canQuote && hasQuotes && !showQuoteForm && (
                          <button onClick={() => {
                            const doOpen = () => {
                              const eq0 = detail.quotes[0] as any;
                              if (eq0?.quoteType) changeQuoteType(eq0.quoteType as typeof quoteType);
                              if (eq0?.billingType) setQuoteBillingType(eq0.billingType);
                              if (eq0?.taxDocumentType) setQuoteTaxDocType(eq0.taxDocumentType as typeof quoteTaxDocType);
                              if (eq0?.taxCategory) setQuoteTaxCategory(eq0.taxCategory as typeof quoteTaxCategory);
                              if (eq0?.paymentMethod) setQuotePaymentMethod(eq0.paymentMethod);
                              if (eq0?.validUntil) setQuoteValidUntil(eq0.validUntil);
                              if (eq0?.issueDate) setQuoteIssueDate(eq0.issueDate);
                              if (eq0?.invoiceDueDate) setQuoteInvoiceDueDate(eq0.invoiceDueDate);
                              if (eq0?.paymentDueDate) setQuotePaymentDueDate(eq0.paymentDueDate);
                              if (eq0?.batchPeriodStart) setQuoteBatchStart(eq0.batchPeriodStart);
                              if (eq0?.batchPeriodEnd) setQuoteBatchEnd(eq0.batchPeriodEnd);
                              if (Array.isArray(eq0?.items) && eq0.items.length > 0) {
                                setQuoteItemForms(eq0.items.map((it: any) => ({
                                  productId: it.productId ?? null,
                                  productName: it.productName ?? "",
                                  languagePair: it.languagePair ?? "",
                                  unit: it.unit ?? "건",
                                  quantity: String(it.quantity ?? "1"),
                                  unitPrice: String(it.unitPrice ?? ""),
                                  taxRate: (Number(it.taxAmount) > 0 ? "0.1" : "0") as "0" | "0.1",
                                })));
                              }
                              setShowQuoteForm(true);
                            };
                            if (detail.status === "completed") {
                              setCompletedConfirmAction(() => doOpen);
                              setCompletedConfirmShow(true);
                            } else {
                              doOpen();
                            }
                          }}
                            style={{ fontSize: 11, fontWeight: 600, color: "#7c3aed", background: "#fdf4ff", border: "1px solid #d8b4fe", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
                            ✏️ 수정/재생성
                          </button>
                        )}
                      </div>
                      {formVisible && quoteFormJsx}
                      {hasQuotes ? detail.quotes.map(q => {
                        const taxDocLabel: Record<string, string> = { tax_invoice: "세금계산서", zero_tax_invoice: "세금계산서(영세율)", bill: "계산서" };
                        const taxCatLabel: Record<string, string> = { normal: "일반", zero_rated: "영세율", consignment: "위수탁", consignment_zero_rated: "위수탁영세율" };
                        const qtLabel: Record<string, [string, string, string]> = {
                          b2b_standard:      ["B2B 일반", "#eff6ff", "#1d4ed8"],
                          b2c_prepaid:       ["B2C 선입금", "#fef3c7", "#92400e"],
                          prepaid_deduction: ["선입금 차감", "#fdf4ff", "#7c3aed"],
                          accumulated_batch: ["누적 견적", "#ecfdf5", "#065f46"],
                        };
                        const pmLabel: Record<string, string> = { card: "카드", cash: "현금", bank: "계좌이체" };
                        const btLabelMap: Record<string, string> = {
                          postpaid_per_project: "건별 후불", monthly_billing: "누적 청구",
                          prepaid_wallet: "선입금 차감", prepay_upfront: "선결제",
                        };
                        const tdt = (q as any).taxDocumentType ?? "tax_invoice";
                        const tc = (q as any).taxCategory ?? "normal";
                        const qt = (q as any).quoteType ?? "b2b_standard";
                        const bt = (q as any).billingType ?? "postpaid_per_project";
                        const pm = (q as any).paymentMethod ?? null;
                        const [qtText, qtBg, qtColor] = qtLabel[qt] ?? ["기본", "#f8fafc", "#374151"];
                        const btText = bt === "prepay_upfront" && pm ? `선결제(${pmLabel[pm] ?? pm})` : (btLabelMap[bt] ?? bt);
                        return (
                        <div key={q.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 12px", marginBottom: 6, fontSize: 13, border: "1px solid #e5e7eb" }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <span style={{ color: "#9ca3af", fontSize: 11 }}>#{q.id}</span>
                            <span style={{ fontWeight: 700, color: "#0891b2", fontSize: 14 }}>{Number((q as any).price ?? (q as any).amount).toLocaleString()}원</span>
                            <StatusBadge status={q.status} />
                            <span style={{ fontSize: 10, padding: "1px 8px", borderRadius: 4, background: qtBg, color: qtColor, border: `1px solid ${qtColor}33`, fontWeight: 800 }}>
                              {qtText}
                            </span>
                            <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, background: bt === "prepay_upfront" ? "#ecfdf5" : "#f8fafc", color: bt === "prepay_upfront" ? "#065f46" : "#374151", border: "1px solid #d1fae5", fontWeight: 700 }}>
                              {btText}
                            </span>
                            <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, background: tdt === "bill" ? "#fef3c7" : "#eff6ff", color: tdt === "bill" ? "#92400e" : "#1d4ed8", border: `1px solid ${tdt === "bill" ? "#fde68a" : "#bfdbfe"}`, fontWeight: 700 }}>
                              {taxDocLabel[tdt] ?? tdt}
                            </span>
                            <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 4, background: tc === "zero_rated" || tc === "consignment_zero_rated" ? "#f0fdf4" : tc === "consignment" ? "#fdf4ff" : "#f8fafc", color: tc === "zero_rated" || tc === "consignment_zero_rated" ? "#166534" : tc === "consignment" ? "#7c3aed" : "#374151", border: "1px solid #e2e8f0" }}>
                              {taxCatLabel[tc] ?? tc}
                            </span>
                            <span style={{ color: "#9ca3af", fontSize: 11, marginLeft: "auto" }}>{new Date(q.createdAt).toLocaleDateString("ko-KR")}</span>
                          </div>
                          {(q as any).note && <p style={{ margin: "5px 0 0", fontSize: 12, color: "#6b7280" }}>📝 {(q as any).note}</p>}
                        </div>
                        );
                      }) : !formVisible ? (
                        <p style={{ color: "#9ca3af", fontSize: 13, paddingBottom: 8 }}>등록된 견적이 없습니다.</p>
                      ) : null}
                    </>
                  );
                })()}

                {/* 결제 섹션 */}
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
                          {/* 금액 + 결제일 (필수) */}
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                            <div>
                              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>금액 (원) *</label>
                              <input type="number" min="0" value={paymentAmount}
                                onChange={e => setPaymentAmount(e.target.value)}
                                placeholder="예: 500000"
                                style={{ ...inputStyle, width: "100%", fontSize: 13, padding: "7px 10px", boxSizing: "border-box" }} />
                            </div>
                            <div>
                              <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>결제일 *</label>
                              <input type="date" value={paymentDate}
                                onChange={e => setPaymentDate(e.target.value)}
                                style={{ ...inputStyle, width: "100%", fontSize: 13, padding: "7px 10px", boxSizing: "border-box" }} />
                            </div>
                          </div>
                          {/* 결제 수단 (선택) */}
                          <div style={{ marginBottom: 8 }}>
                            <label style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 3 }}>결제 수단 (선택)</label>
                            <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}
                              style={{ ...inputStyle, width: "100%", fontSize: 13, padding: "7px 10px", boxSizing: "border-box" }}>
                              <option value="">— 선택 안 함 —</option>
                              <option value="bank_transfer">계좌이체</option>
                              <option value="card">신용/체크카드</option>
                              <option value="cash">현금</option>
                              <option value="virtual_account">가상계좌</option>
                              <option value="other">기타</option>
                            </select>
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

                {/* 정산 요약 카드 (견적/결제 탭 하단) */}
                {(() => {
                  const hasPaid = detail.payments.some((pm: any) => pm.status === "paid");
                  const hasSettlement = detail.settlements.length > 0;
                  return (
                    <div style={{ background: hasSettlement ? "#f0fdf4" : "#f9fafb", border: `1px solid ${hasSettlement ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 10, padding: "12px 16px", marginTop: 16 }}>
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
                        <button onClick={() => setActiveSection("finance")}
                          style={{ fontSize: 11, padding: "4px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", cursor: "pointer", color: "#6b7280" }}>
                          ← 견적/결제 탭으로
                        </button>
                      </div>
                    </>
                  );
                })()}
              </>
            )}

            {/* 기록 탭 (파일 / 커뮤니케이션 / 메모 / 이벤트 로그) */}
            {activeSection === "history" && (
              <>
                {/* 업로드 영역 */}
                <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
                  <p style={sectionHd}>파일 업로드</p>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <select value={uploadFileType} onChange={e => setUploadFileType(e.target.value as "source"|"translated"|"attachment")}
                      style={{ ...inputStyle, width: "auto", padding: "7px 10px", fontSize: 13 }}>
                      <option value="source">📄 원본 파일</option>
                      <option value="translated">✅ 번역본</option>
                      <option value="attachment">📎 기타 첨부</option>
                    </select>
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
                    <select value={commType} onChange={e => setCommType(e.target.value as "email"|"phone"|"message")}
                      style={{ ...inputStyle, width: "auto", padding: "7px 10px", fontSize: 13 }}>
                      <option value="message">메시지</option>
                      <option value="email">이메일</option>
                      <option value="phone">전화</option>
                    </select>
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
          </>
        )}
      {/* 완료 상태 수정 확인 모달 */}
      {completedConfirmShow && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setCompletedConfirmShow(false)}>
          <div style={{ background: "#fff", borderRadius: 12, padding: "24px 28px", maxWidth: 380, width: "90%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
            onClick={e => e.stopPropagation()}>
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
  );
}
