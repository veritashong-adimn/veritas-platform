import React, { useState, useEffect } from 'react';
import { api, ProjectDetail, MatchCandidate, getActionLabel, COMM_TYPE_LABEL, COMM_TYPE_COLOR, STATUS_LABEL, PROJECT_STATUS_TRANSITIONS, AdminUser, BOARD_CATEGORY_LABEL } from '../../lib/constants';
import { StatusBadge, PrimaryBtn, GhostBtn } from '../ui';
import { ReviewMemoPanel } from './ReviewMemoPanel';

/* ────── 상태 변경 검증 ────── */
function getStatusTransitionBlock(
  targetStatus: string,
  detail: ProjectDetail,
): { blocked: boolean; reason?: string } {
  const hasPaidPayment = detail.payments?.some((p: any) => p.status === "paid");
  const hasAssignedTranslator = (detail.tasks ?? []).length > 0;

  if (targetStatus === "paid" && !hasPaidPayment) {
    return {
      blocked: true,
      reason: "결제 기록이 없습니다. '견적·결제·정산' 탭에서 먼저 결제를 등록한 뒤 상태를 변경해주세요.",
    };
  }
  if ((targetStatus === "matched" || targetStatus === "in_progress") && !hasAssignedTranslator) {
    return {
      blocked: true,
      reason: "배정된 번역사가 없습니다. '번역사' 탭에서 번역사를 배정한 뒤 상태를 변경해주세요.",
    };
  }
  return { blocked: false };
}

/* 현재 상태별 다음 단계 안내 */
const STATUS_NEXT_HINT: Record<string, { text: string; color: string; bg: string }> = {
  created:     { text: "견적을 생성한 뒤 '견적됨' 상태로 변경하세요.",               color: "#2563eb", bg: "#eff6ff" },
  quoted:      { text: "고객 확인 후 '견적 승인됨' 상태로 변경하세요.",               color: "#7c3aed", bg: "#faf5ff" },
  approved:    { text: "'견적·결제·정산' 탭에서 결제를 등록하면 자동으로 변경됩니다.", color: "#d97706", bg: "#fffbeb" },
  paid:        { text: "'번역사' 탭에서 번역사를 배정한 뒤 '매칭됨' 으로 변경하세요.", color: "#9333ea", bg: "#fdf4ff" },
  matched:     { text: "번역사가 작업을 시작하면 '작업중' 상태로 변경하세요.",          color: "#0891b2", bg: "#ecfeff" },
  in_progress: { text: "번역 완료 후 '완료' 상태로 변경하세요.",                      color: "#059669", bg: "#f0fdf4" },
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
  initialSection?: "info"|"company"|"translator"|"settlement"|"comms"|"notes"|"log"|"files";
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [statusTarget, setStatusTarget] = useState("");
  const [changingStatus, setChangingStatus] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [commType, setCommType] = useState<"email"|"phone"|"message">("message");
  const [commContent, setCommContent] = useState("");
  const [addingComm, setAddingComm] = useState(false);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [showCandidates, setShowCandidates] = useState(false);
  const [activeSection, setActiveSection] = useState<"info"|"company"|"translator"|"settlement"|"comms"|"notes"|"log"|"files">(initialSection ?? "info");

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
  const [savingInfo, setSavingInfo] = useState(false);
  const [companiesList, setCompaniesList] = useState<{id: number; name: string}[]>([]);
  const [contactsList, setContactsList] = useState<{id: number; name: string; companyId: number | null}[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);

  // 견적 생성
  const [quoteAmount, setQuoteAmount] = useState("");
  const [quoteNote, setQuoteNote] = useState("");
  const [quoteTaxDocType, setQuoteTaxDocType] = useState<"tax_invoice" | "bill">("tax_invoice");
  const [quoteTaxCategory, setQuoteTaxCategory] = useState<"normal" | "zero_rated" | "consignment" | "consignment_zero_rated">("normal");
  const [quoteType, setQuoteType] = useState<"b2b_standard" | "b2c_prepaid" | "prepaid_deduction" | "accumulated_batch">("b2b_standard");
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [creatingQuote, setCreatingQuote] = useState(false);
  type QuoteItemForm = { productName: string; unit: string; quantity: string; unitPrice: string; taxRate: "0" | "0.1" };
  const defaultItem = (): QuoteItemForm => ({ productName: "", unit: "건", quantity: "1", unitPrice: "", taxRate: "0" });
  const [quoteMode, setQuoteMode] = useState<"simple" | "items">("simple");
  const [quoteItemForms, setQuoteItemForms] = useState<QuoteItemForm[]>([defaultItem()]);
  const calcItemTotal = (it: QuoteItemForm) => {
    const supply = Math.round(Number(it.quantity || 1) * Number(it.unitPrice || 0));
    const tax = Math.round(supply * Number(it.taxRate));
    return { supply, tax, total: supply + tax };
  };
  const quoteItemsGrandTotal = quoteItemForms.reduce((s, it) => s + calcItemTotal(it).total, 0);
  // quote_type별 추가 필드
  const [quoteValidUntil, setQuoteValidUntil] = useState("");
  const [quoteIssueDate, setQuoteIssueDate] = useState("");
  const [quoteInvoiceDueDate, setQuoteInvoiceDueDate] = useState("");
  const [quotePaymentDueDate, setQuotePaymentDueDate] = useState("");
  const [quotePrepaidUsage, setQuotePrepaidUsage] = useState("");
  // 선입금 차감 - 거래처 계정 원장
  type CompPrepaidAcct = { id: number; initialAmount: number; currentBalance: number; note: string | null; depositDate: string | null; status: string };
  const [compPrepaidAccounts, setCompPrepaidAccounts] = useState<CompPrepaidAcct[]>([]);
  const [loadingCompPrepaid, setLoadingCompPrepaid] = useState(false);
  const [selectedPrepaidAcctId, setSelectedPrepaidAcctId] = useState<number | null>(null);
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
  type ActiveBatch = { id: number; companyId: number; status: string; totalAmount: number; note: string | null; periodStart: string; periodEnd: string; items: ActiveBatchItem[] };
  const [activeBatch, setActiveBatch] = useState<ActiveBatch | null | "loading">(null);
  const [activeBatchOp, setActiveBatchOp] = useState(false); // add/remove/issue 중
  const [issueDateBatch, setIssueDateBatch] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentDueDateBatch, setPaymentDueDateBatch] = useState("");

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
      const res = await fetch(api(`/api/admin/prepaid-accounts?companyId=${companyId}`), { headers: authH });
      if (res.ok) {
        const accounts = await res.json();
        const active = accounts.filter((a: CompPrepaidAcct) => a.status === "active");
        setCompPrepaidAccounts(active);
        if (active.length > 0 && !selectedPrepaidAcctId) setSelectedPrepaidAcctId(active[0].id);
      }
    } finally { setLoadingCompPrepaid(false); }
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

  const loadDetail = async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}`), { headers: authH });
      const data = await res.json();
      if (res.ok) {
        setDetail(data);
        setStatusTarget(data.status);
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
      onToast(`번역사 배정 완료 → ${data.translatorEmail}`);
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

  useEffect(() => { if (activeSection === "files") fetchFiles(); }, [activeSection]);
  useEffect(() => {
    if (quoteType === "accumulated_batch" && detail?.companyId) {
      loadActiveBatch(detail.companyId);
    }
  }, [quoteType, detail?.companyId]);
  useEffect(() => {
    if (quoteType === "prepaid_deduction" && detail?.companyId) {
      setCompPrepaidAccounts([]);
      setSelectedPrepaidAcctId(null);
      loadCompPrepaidAccounts(detail.companyId);
    }
  }, [quoteType, detail?.companyId]);

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
      onToast(`상태가 "${STATUS_LABEL[statusTarget] ?? statusTarget}"로 변경되었습니다.`);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 상태 변경 실패"); }
    finally { setChangingStatus(false); }
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
    await loadMeta();
    setEditTitle(detail.title);
    setEditCompanyId(detail.company?.id ?? (detail as any).companyId ?? null);
    setEditContactId(detail.contact?.id ?? (detail as any).contactId ?? null);
    setEditingInfo(true);
  };

  const handleSaveInfo = async () => {
    if (!editTitle.trim()) return;
    setSavingInfo(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/info`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle.trim(), companyId: editCompanyId, contactId: editContactId }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("기본정보가 수정되었습니다.");
      setEditingInfo(false);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 저장 실패"); }
    finally { setSavingInfo(false); }
  };

  const handleCreateQuote = async () => {
    setCreatingQuote(true);
    try {
      let body: Record<string, unknown>;

      if (quoteType === "prepaid_deduction") {
        const usageAmt = Number(quotePrepaidUsage.replace(/,/g, ""));
        if (!usageAmt || usageAmt <= 0) { onToast("이번 사용 금액을 입력하세요."); return; }
        if (!selectedPrepaidAcctId) { onToast("차감할 선입금 계정을 선택하세요."); return; }
        const acct = compPrepaidAccounts.find(a => a.id === selectedPrepaidAcctId);
        if (!acct || acct.currentBalance < usageAmt) { onToast(`잔액 부족: 현재 잔액 ${acct?.currentBalance.toLocaleString() ?? 0}원`); return; }
        body = { prepaidUsageAmount: usageAmt };
      } else if (quoteType === "accumulated_batch") {
        // 누적 견적: 배치 UI의 "세금계산서 발행" 버튼을 사용
        onToast("누적 견적서는 배치 발행 버튼을 사용하세요.");
        setCreatingQuote(false);
        return;
      } else if (quoteMode === "items") {
        const validItems = quoteItemForms.filter(it => it.productName.trim() && Number(it.unitPrice) > 0);
        if (validItems.length === 0) { onToast("품목명과 단가를 입력하세요."); return; }
        body = {
          items: validItems.map(it => ({
            productName: it.productName.trim(),
            unit: it.unit || "건",
            quantity: Number(it.quantity) || 1,
            unitPrice: Number(it.unitPrice),
            taxRate: Number(it.taxRate) as 0 | 0.1,
          })),
        };
      } else {
        const amt = Number(quoteAmount.replace(/,/g, ""));
        if (!amt || amt <= 0) { onToast("유효한 금액을 입력하세요."); return; }
        body = { amount: amt };
      }

      if (quoteNote.trim()) body.note = quoteNote.trim();
      body.taxDocumentType = quoteTaxDocType;
      body.taxCategory = quoteTaxCategory;
      body.quoteType = quoteType;
      // 공통 날짜 필드
      if (quoteValidUntil) body.validUntil = quoteValidUntil;
      if (quoteIssueDate) body.issueDate = quoteIssueDate;
      if (quoteInvoiceDueDate) body.invoiceDueDate = quoteInvoiceDueDate;
      if (quotePaymentDueDate) body.paymentDueDate = quotePaymentDueDate;
      // 누적 견적 전용 필드
      if (quoteType === "accumulated_batch") {
        if (quoteBatchStart) body.batchPeriodStart = quoteBatchStart;
        if (quoteBatchEnd) body.batchPeriodEnd = quoteBatchEnd;
      }
      const res = await fetch(api(`/api/admin/projects/${projectId}/quote`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      // 선입금 차감 시 원장에 자동 연동
      if (quoteType === "prepaid_deduction" && selectedPrepaidAcctId) {
        const usageAmt = Number(quotePrepaidUsage.replace(/,/g, ""));
        await fetch(api(`/api/admin/prepaid-accounts/${selectedPrepaidAcctId}/transactions`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "deduction", amount: usageAmt,
            description: `프로젝트: ${detail?.title ?? `#${projectId}`}`,
            projectId, transactionDate: new Date().toISOString().slice(0, 10),
          }),
        });
      }
      onToast(`견적 생성 완료`);
      setQuoteAmount(""); setQuoteNote(""); setQuoteItemForms([defaultItem()]); setShowQuoteForm(false);
      setQuoteValidUntil(""); setQuoteIssueDate(""); setQuoteInvoiceDueDate(""); setQuotePaymentDueDate("");
      setQuotePrepaidUsage(""); setSelectedPrepaidAcctId(null); setCompPrepaidAccounts([]);
      setQuoteBatchStart(""); setQuoteBatchEnd(""); setBatchCandidates([]); setBatchSelected(new Set()); setBatchQueried(false);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 견적 생성 실패"); }
    finally { setCreatingQuote(false); }
  };

  // 프로젝트 모달 내 선입금 계정 빠른 등록
  const handleQuickRegisterPrepaid = async () => {
    const amt = Number(quickPrepaidAmount.replace(/,/g, ""));
    if (!amt || amt <= 0) { onToast("입금액을 입력하세요."); return; }
    if (!detail?.company?.id) { onToast("거래처 정보가 없습니다."); return; }
    setRegisteringPrepaid(true);
    try {
      const res = await fetch(api("/api/admin/prepaid-accounts"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: detail.company.id, initialAmount: amt,
          note: quickPrepaidNote || null, depositDate: new Date().toISOString().slice(0, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("선입금 계정이 등록되었습니다. 이제 차감 금액을 입력하세요.");
      setQuickPrepaidAmount(""); setQuickPrepaidNote("");
      // 계정 목록 갱신 후 자동 선택
      const listRes = await fetch(api(`/api/admin/prepaid-accounts?companyId=${detail.company.id}`), { headers: authH });
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
    { key: "info", label: "기본 정보" },
    { key: "settlement", label: "견적/결제/정산" },
    { key: "translator", label: "번역사" },
    { key: "company", label: "거래처/담당자" },
    { key: "files", label: `📎 파일 (${projectFiles.length})` },
    { key: "comms", label: "커뮤니케이션" },
    { key: "notes", label: "메모" },
    { key: "log", label: "이벤트 로그" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 300, overflowY: "auto", padding: "20px 16px",
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb",
        width: "100%", maxWidth: 780, padding: "24px 28px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: "0 0 2px", fontSize: 18, fontWeight: 800, color: "#111827" }}>
              프로젝트 #{projectId} 상세
            </h2>
            {detail && <StatusBadge status={detail.status} />}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 4 }}>×</button>
        </div>

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
              {STATUS_NEXT_HINT[detail.status] && (
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
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {/* 상태 변경 */}
                {(PROJECT_STATUS_TRANSITIONS[detail.status] ?? []).length > 0 && (() => {
                  const block = statusTarget !== detail.status
                    ? getStatusTransitionBlock(statusTarget, detail)
                    : { blocked: false };
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
                        disabled={changingStatus || statusTarget === detail.status || block.blocked}
                        color={block.blocked ? "#9ca3af" : "#2563eb"}
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
                {/* 번역사 추천 — 배정이 필요한 상태일 때만 */}
                {["paid", "matched", "in_progress"].includes(detail.status) && (
                  <GhostBtn onClick={loadCandidates} disabled={loadingCandidates} color="#7c3aed" style={{ fontSize: 12, padding: "6px 12px" }}>
                    {loadingCandidates ? "조회 중..." : "번역사 추천"}
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

            {/* 번역사 추천 후보 */}
            {showCandidates && (
              <div style={{ marginBottom: 14, padding: "12px 14px", background: "#faf5ff", borderRadius: 10, border: "1px solid #e9d5ff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>추천 번역사 (상위 3명)</p>
                  <button onClick={() => setShowCandidates(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 }}>×</button>
                </div>
                {loadingCandidates ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center" }}>조회 중...</p>
                ) : candidates.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13 }}>조건에 맞는 번역사가 없습니다.</p>
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
                        <span style={dt}>거래처<Opt /></span>
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
                          <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>거래처</label>
                          <select value={editCompanyId ?? ""} onChange={e => { setEditCompanyId(e.target.value ? Number(e.target.value) : null); setEditContactId(null); }}
                            style={{ ...inputStyle, width: "100%" }}>
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

            {/* 거래처 / 담당자 */}
            {activeSection === "company" && (
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

            {/* 번역사 정보 */}
            {activeSection === "translator" && (
              <>
                {detail.tasks.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af" }}>
                    <p style={{ margin: 0 }}>배정된 번역사가 없습니다.</p>
                    <p style={{ margin: "6px 0 0", fontSize: 12 }}>위 「번역사 추천」 버튼으로 후보를 확인하고 배정하세요.</p>
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

            {/* 견적/결제/정산 */}
            {activeSection === "settlement" && (
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
                          {qfLbl("유효기간 (선택)")}
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
                          {qfLbl("유효기간 (선택)")}
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
                      const usageNum = Number(quotePrepaidUsage.replace(/,/g, "") || 0);
                      const afterBalance = selectedAcct ? curBalance - usageNum : null;
                      const isInsufficient = selectedAcct != null && usageNum > 0 && usageNum > curBalance;
                      const shortageAmount = isInsufficient ? usageNum - curBalance : 0;

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
                                onClick={handleQuickRegisterPrepaid}
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

                            {/* Case C: 잔액 있음 — 차감 입력 */}
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
                                    {qfLbl("이번 차감 금액 (원) *")}
                                    <input
                                      type="number" min="0" value={quotePrepaidUsage} placeholder="0"
                                      onChange={e => setQuotePrepaidUsage(e.target.value)}
                                      style={{ ...qfIs, borderColor: isInsufficient ? "#f87171" : "#d8b4fe" }}
                                    />
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
                          </div>
                        </div>
                      );
                    }
                    if (quoteType === "accumulated_batch") {
                      const companyId = detail.companyId;
                      const batchData = activeBatch === "loading" ? null : activeBatch;
                      const isLoading = activeBatch === "loading";
                      const isInBatch = batchData != null && batchData.items.some(i => i.projectId === projectId);
                      const myBatchItem = batchData?.items.find(i => i.projectId === projectId);

                      return (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 8, padding: "12px 14px" }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: "#065f46", marginBottom: 10 }}>
                              🗂️ 누적 청구 배치
                            </div>

                            {/* 거래처 없음 경고 */}
                            {!companyId && (
                              <div style={{ padding: "8px 10px", background: "#fef3c7", borderRadius: 6, border: "1px solid #fcd34d", fontSize: 12, color: "#92400e", marginBottom: 8 }}>
                                ⚠️ 이 프로젝트에 거래처를 먼저 설정해야 누적 배치를 사용할 수 있습니다.
                              </div>
                            )}

                            {/* 로딩 */}
                            {isLoading && (
                              <div style={{ textAlign: "center", fontSize: 12, color: "#6b7280", padding: "12px 0" }}>배치 정보 로딩 중...</div>
                            )}

                            {/* 진행 중인 배치 없음 */}
                            {!isLoading && batchData === null && companyId && (
                              <div>
                                <div style={{ padding: "10px 12px", background: "#f0fdf4", borderRadius: 6, border: "1px solid #bbf7d0", fontSize: 12, color: "#065f46", marginBottom: 10 }}>
                                  진행 중인 누적 배치가 없습니다. 새 배치를 시작하면 이 거래처의 여러 번역 건을 월말에 한꺼번에 청구할 수 있습니다.
                                </div>
                                <button
                                  type="button"
                                  onClick={() => createNewBatch(companyId)}
                                  disabled={activeBatchOp}
                                  style={{ padding: "7px 16px", background: "#065f46", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                                  {activeBatchOp ? "생성 중..." : "🆕 새 누적 배치 시작"}
                                </button>
                              </div>
                            )}

                            {/* 진행 중인 배치 있음 */}
                            {!isLoading && batchData != null && (
                              <div>
                                {/* 배치 요약 헤더 */}
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, padding: "8px 10px", background: "#d1fae5", borderRadius: 6 }}>
                                  <div>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: "#065f46" }}>배치 #{batchData.id}</span>
                                    <span style={{ fontSize: 10, color: "#6b7280", marginLeft: 8 }}>
                                      {batchData.periodStart?.slice(0, 10)} ~ {batchData.periodEnd?.slice(0, 10)}
                                    </span>
                                  </div>
                                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "#065f46", color: "#fff", fontWeight: 700 }}>진행 중</span>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: "#065f46" }}>{batchData.totalAmount.toLocaleString()}원</span>
                                  </div>
                                </div>

                                {/* 이 프로젝트 배치 포함 여부 */}
                                {isInBatch ? (
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", background: "#f0fdf4", borderRadius: 6, border: "1px solid #6ee7b7", marginBottom: 8, fontSize: 12 }}>
                                    <span style={{ color: "#065f46", fontWeight: 600 }}>✅ 이 프로젝트가 배치에 포함되어 있습니다 ({myBatchItem!.amount.toLocaleString()}원)</span>
                                    <button type="button" onClick={() => removeFromActiveBatch(batchData.id, myBatchItem!.id)} disabled={activeBatchOp}
                                      style={{ fontSize: 11, padding: "3px 10px", background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 5, cursor: "pointer" }}>
                                      {activeBatchOp ? "..." : "배치에서 제거"}
                                    </button>
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", background: "#fefce8", borderRadius: 6, border: "1px solid #fde68a", marginBottom: 8, fontSize: 12 }}>
                                    <span style={{ color: "#92400e" }}>이 프로젝트가 아직 배치에 포함되지 않았습니다.</span>
                                    <button type="button" onClick={() => addToActiveBatch(batchData.id)} disabled={activeBatchOp}
                                      style={{ fontSize: 11, padding: "3px 10px", background: "#065f46", color: "#fff", border: "none", borderRadius: 5, cursor: "pointer", fontWeight: 700 }}>
                                      {activeBatchOp ? "..." : "➕ 이 프로젝트 배치에 추가"}
                                    </button>
                                  </div>
                                )}

                                {/* 누적 항목 테이블 */}
                                {batchData.items.length === 0 ? (
                                  <div style={{ textAlign: "center", fontSize: 12, color: "#9ca3af", padding: "10px 0" }}>아직 추가된 건이 없습니다.</div>
                                ) : (
                                  <div style={{ overflowX: "auto", maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                      <thead>
                                        <tr style={{ background: "#d1fae5", position: "sticky", top: 0 }}>
                                          <th style={{ padding: "4px 6px", textAlign: "left", color: "#065f46", borderBottom: "1px solid #6ee7b7" }}>추가일</th>
                                          <th style={{ padding: "4px 6px", textAlign: "left", color: "#065f46", borderBottom: "1px solid #6ee7b7" }}>프로젝트명</th>
                                          <th style={{ padding: "4px 6px", textAlign: "left", color: "#065f46", borderBottom: "1px solid #6ee7b7" }}>서비스</th>
                                          <th style={{ padding: "4px 6px", textAlign: "right", color: "#065f46", borderBottom: "1px solid #6ee7b7" }}>금액</th>
                                          <th style={{ padding: "4px 6px", textAlign: "center", borderBottom: "1px solid #6ee7b7" }}></th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {batchData.items.map((item, i) => (
                                          <tr key={item.id} style={{ background: item.projectId === projectId ? "#f0fdf4" : i % 2 === 0 ? "#fff" : "#f9fafb" }}>
                                            <td style={{ padding: "4px 6px", whiteSpace: "nowrap", color: "#6b7280" }}>{item.createdAt?.slice(0, 10)}</td>
                                            <td style={{ padding: "4px 6px", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: item.projectId === projectId ? 700 : 400 }} title={item.projectTitle}>
                                              {item.projectTitle}
                                              {item.projectId === projectId && <span style={{ marginLeft: 4, fontSize: 9, background: "#065f46", color: "#fff", borderRadius: 3, padding: "1px 4px" }}>현재</span>}
                                            </td>
                                            <td style={{ padding: "4px 6px", color: "#6b7280", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.serviceName || "-"}</td>
                                            <td style={{ padding: "4px 6px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{item.amount.toLocaleString()}원</td>
                                            <td style={{ padding: "4px 6px", textAlign: "center" }}>
                                              <button type="button" onClick={() => removeFromActiveBatch(batchData.id, item.id)} disabled={activeBatchOp}
                                                style={{ fontSize: 10, padding: "1px 6px", background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 4, cursor: "pointer" }}>✕</button>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                      <tfoot>
                                        <tr style={{ background: "#065f46" }}>
                                          <td colSpan={3} style={{ padding: "5px 6px", color: "#d1fae5", fontSize: 11, fontWeight: 700 }}>합계 ({batchData.items.length}건)</td>
                                          <td style={{ padding: "5px 6px", textAlign: "right", color: "#fff", fontSize: 12, fontWeight: 800 }}>{batchData.totalAmount.toLocaleString()}원</td>
                                          <td></td>
                                        </tr>
                                      </tfoot>
                                    </table>
                                  </div>
                                )}

                                {/* 발행 영역 */}
                                {batchData.items.length > 0 && (
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
                                      <button
                                        type="button"
                                        onClick={() => issueBatch(batchData.id)}
                                        disabled={activeBatchOp || !issueDateBatch}
                                        style={{ padding: "7px 16px", background: activeBatchOp ? "#9ca3af" : "#065f46", color: "#fff", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 1 }}>
                                        {activeBatchOp ? "발행 중..." : `🧾 ${batchData.items.length}건 합산 세금계산서 발행`}
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
                          {/* 선입금 차감·누적 배치 유형은 단순/품목 모드 불필요 */}
                          {quoteType !== "prepaid_deduction" && quoteType !== "accumulated_batch" && (
                            <div style={{ display: "flex", gap: 0, borderRadius: 6, overflow: "hidden", border: "1px solid #d8b4fe" }}>
                              {(["simple", "items"] as const).map(m => (
                                <button key={m} onClick={() => setQuoteMode(m)}
                                  style={{ padding: "4px 10px", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
                                    background: quoteMode === m ? "#7c3aed" : "#fdf4ff", color: quoteMode === m ? "#fff" : "#7c3aed" }}>
                                  {m === "simple" ? "단순 금액" : "품목 입력"}
                                </button>
                              ))}
                            </div>
                          )}
                          {hasQuotes && (
                            <button onClick={() => setShowQuoteForm(false)}
                              style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>×</button>
                          )}
                        </div>
                      </div>

                      {/* 견적서 유형 선택 */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#1e3a8a", display: "block", marginBottom: 3 }}>견적서 유형 *</label>
                          <select value={quoteType} onChange={e => setQuoteType(e.target.value as typeof quoteType)}
                            style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", borderColor: "#93c5fd", background: "#eff6ff" }}>
                            <option value="b2b_standard">B2B 일반 견적서</option>
                            <option value="b2c_prepaid">B2C 선입금 견적서</option>
                            <option value="prepaid_deduction">선입금 차감 견적서</option>
                            <option value="accumulated_batch">누적 견적서</option>
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", display: "block", marginBottom: 3 }}>
                            청구 방식 (거래처 기본: <span style={{ color: "#1d4ed8" }}>{companyBillingType === "prepaid_wallet" ? "선입금 차감" : companyBillingType === "monthly_billing" ? "월 청구" : "건별 후불"}</span>)
                          </label>
                          <select defaultValue={companyBillingType}
                            style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", borderColor: "#e2e8f0" }}>
                            <option value="postpaid_per_project">건별 후불</option>
                            <option value="prepaid_wallet">선입금 차감</option>
                            <option value="monthly_billing">월 청구</option>
                          </select>
                        </div>
                      </div>

                      {/* 세무/발행 구분 선택 */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                        <div>
                          <label style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", display: "block", marginBottom: 3 }}>문서 구분 *</label>
                          <select value={quoteTaxDocType} onChange={e => setQuoteTaxDocType(e.target.value as "tax_invoice" | "bill")}
                            style={{ ...inputStyle, width: "100%", fontSize: 12, padding: "6px 8px", boxSizing: "border-box", borderColor: "#d8b4fe" }}>
                            <option value="tax_invoice">세금계산서</option>
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

                      {/* 선입금 차감: 비고 + 생성 버튼만 / 누적 배치: 발행 버튼 내장 → 숨김 */}
                      {quoteType === "accumulated_batch" ? null : quoteType === "prepaid_deduction" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
                              const usageNum2 = Number(quotePrepaidUsage.replace(/,/g, "") || 0);
                              const noAcct = compPrepaidAccounts.length === 0;
                              const zeroBalance2 = selAcct !== null && selAcct.currentBalance === 0;
                              const isInsuff2 = selAcct != null && usageNum2 > 0 && usageNum2 > selAcct.currentBalance;
                              cannotCreate = noAcct || zeroBalance2 || isInsuff2;
                            }
                            return (
                              <PrimaryBtn onClick={handleCreateQuote}
                                disabled={creatingQuote || (quoteType === "prepaid_deduction" && !quotePrepaidUsage) || cannotCreate}
                                style={{ fontSize: 12, padding: "7px 14px", background: cannotCreate ? "#9ca3af" : "#7c3aed", border: "none", alignSelf: "flex-end" }}>
                                {creatingQuote ? "생성 중..." : hasQuotes ? "견적 재생성" : "견적 생성"}
                              </PrimaryBtn>
                            );
                          })()}
                        </div>
                      ) : quoteMode === "simple" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              type="number" min="0"
                              value={quoteAmount}
                              onChange={e => setQuoteAmount(e.target.value)}
                              placeholder="견적 금액 (원) *"
                              style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
                              onKeyDown={e => e.key === "Enter" && handleCreateQuote()} />
                            <PrimaryBtn onClick={handleCreateQuote} disabled={creatingQuote || !quoteAmount}
                              style={{ fontSize: 12, padding: "7px 14px", background: "#7c3aed", border: "none", whiteSpace: "nowrap" }}>
                              {creatingQuote ? "생성 중..." : hasQuotes ? "견적 재생성" : "견적 생성"}
                            </PrimaryBtn>
                          </div>
                          <input
                            value={quoteNote}
                            onChange={e => setQuoteNote(e.target.value)}
                            placeholder="비고/메모 (선택)"
                            style={{ ...inputStyle, fontSize: 12, padding: "6px 10px" }}
                          />
                        </div>
                      ) : (
                        <div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 48px 64px 88px 72px 28px", gap: 4, marginBottom: 4 }}>
                            {["품목명", "단위", "수량", "단가(원)", "부가세", ""].map(h => (
                              <div key={h} style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", padding: "0 2px" }}>{h}</div>
                            ))}
                          </div>
                          {quoteItemForms.map((it, idx) => {
                            const { supply, tax, total } = calcItemTotal(it);
                            return (
                              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 48px 64px 88px 72px 28px", gap: 4, marginBottom: 4, alignItems: "center" }}>
                                <input value={it.productName} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, productName: e.target.value } : p))}
                                  placeholder="예: 영→한 번역" style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }} />
                                <input value={it.unit} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, unit: e.target.value } : p))}
                                  placeholder="건" style={{ ...inputStyle, fontSize: 12, padding: "6px 6px", textAlign: "center" }} />
                                <input type="number" value={it.quantity} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, quantity: e.target.value } : p))}
                                  min="0" style={{ ...inputStyle, fontSize: 12, padding: "6px 6px", textAlign: "right" }} />
                                <input type="number" value={it.unitPrice} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, unitPrice: e.target.value } : p))}
                                  placeholder="0" min="0" style={{ ...inputStyle, fontSize: 12, padding: "6px 6px", textAlign: "right" }} />
                                <select value={it.taxRate} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, taxRate: e.target.value as "0"|"0.1" } : p))}
                                  style={{ ...inputStyle, fontSize: 11, padding: "6px 4px" }}>
                                  <option value="0">면세</option>
                                  <option value="0.1">10%</option>
                                </select>
                                <button onClick={() => setQuoteItemForms(prev => prev.filter((_, i) => i !== idx))} disabled={quoteItemForms.length <= 1}
                                  style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                                {(supply > 0 || tax > 0) && (
                                  <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, fontSize: 11, color: "#6b7280", paddingLeft: 4, paddingBottom: 2 }}>
                                    <span>공급가액 {supply.toLocaleString()}원</span>
                                    {tax > 0 && <span>세액 {tax.toLocaleString()}원</span>}
                                    <span style={{ fontWeight: 700, color: "#7c3aed" }}>합계 {total.toLocaleString()}원</span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 8 }}>
                            <button onClick={() => setQuoteItemForms(prev => [...prev, defaultItem()])}
                              style={{ fontSize: 12, color: "#7c3aed", background: "none", border: "1px dashed #d8b4fe", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>
                              + 품목 추가
                            </button>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              {quoteItemsGrandTotal > 0 && (
                                <span style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>
                                  합계: {quoteItemsGrandTotal.toLocaleString()}원
                                </span>
                              )}
                              <PrimaryBtn onClick={handleCreateQuote} disabled={creatingQuote}
                                style={{ fontSize: 12, padding: "7px 14px", background: "#7c3aed", border: "none" }}>
                                {creatingQuote ? "생성 중..." : hasQuotes ? "견적 재생성" : "견적 생성"}
                              </PrimaryBtn>
                            </div>
                          </div>
                          <input
                            value={quoteNote}
                            onChange={e => setQuoteNote(e.target.value)}
                            placeholder="비고/메모 (선택)"
                            style={{ ...inputStyle, fontSize: 12, padding: "6px 10px", marginTop: 8 }}
                          />
                        </div>
                      )}
                    </div>
                  );

                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: formVisible ? 6 : 8 }}>
                        <p style={sectionHd}>견적 ({detail.quotes.length})</p>
                        {canQuote && hasQuotes && !showQuoteForm && (
                          <button onClick={() => setShowQuoteForm(true)}
                            style={{ fontSize: 11, fontWeight: 600, color: "#7c3aed", background: "#fdf4ff", border: "1px solid #d8b4fe", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
                            ✏️ 수정/재생성
                          </button>
                        )}
                      </div>
                      {formVisible && quoteFormJsx}
                      {hasQuotes ? detail.quotes.map(q => {
                        const taxDocLabel: Record<string, string> = { tax_invoice: "세금계산서", bill: "계산서" };
                        const taxCatLabel: Record<string, string> = { normal: "일반", zero_rated: "영세율", consignment: "위수탁", consignment_zero_rated: "위수탁영세율" };
                        const qtLabel: Record<string, [string, string, string]> = {
                          b2b_standard:      ["B2B 일반", "#eff6ff", "#1d4ed8"],
                          b2c_prepaid:       ["B2C 선입금", "#fef3c7", "#92400e"],
                          prepaid_deduction: ["선입금 차감", "#fdf4ff", "#7c3aed"],
                          accumulated_batch: ["누적 견적", "#ecfdf5", "#065f46"],
                        };
                        const tdt = (q as any).taxDocumentType ?? "tax_invoice";
                        const tc = (q as any).taxCategory ?? "normal";
                        const qt = (q as any).quoteType ?? "b2b_standard";
                        const [qtText, qtBg, qtColor] = qtLabel[qt] ?? ["기본", "#f8fafc", "#374151"];
                        return (
                        <div key={q.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 12px", marginBottom: 6, fontSize: 13, border: "1px solid #e5e7eb" }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <span style={{ color: "#9ca3af", fontSize: 11 }}>#{q.id}</span>
                            <span style={{ fontWeight: 700, color: "#0891b2", fontSize: 14 }}>{Number((q as any).price ?? (q as any).amount).toLocaleString()}원</span>
                            <StatusBadge status={q.status} />
                            <span style={{ fontSize: 10, padding: "1px 8px", borderRadius: 4, background: qtBg, color: qtColor, border: `1px solid ${qtColor}33`, fontWeight: 800 }}>
                              {qtText}
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

                {/* 정산 섹션 */}
                {(() => {
                  const hasPaid = detail.payments.some((pm: any) => pm.status === "paid");
                  const hasSettlement = detail.settlements.length > 0;
                  return (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, marginBottom: 4 }}>
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
                            <span style={{ color: "#059669", fontWeight: 600 }}>번역사 {Number(s.translatorAmount).toLocaleString()}원</span>
                            <span style={{ color: "#6b7280", fontSize: 11 }}>플랫폼 수수료 {Number(s.platformFee).toLocaleString()}원</span>
                            <StatusBadge status={s.status} />
                          </div>
                        </div>
                      ))}
                    </>
                  );
                })()}
              </>
            )}

            {/* 파일 관리 */}
            {activeSection === "files" && (
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
              </>
            )}

            {/* 커뮤니케이션 */}
            {activeSection === "comms" && (
              <>
                {detail.projectCustomerId ? (
                  <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
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
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "16px 0" }}>커뮤니케이션 기록이 없습니다.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
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
              </>
            )}

            {/* 메모 */}
            {activeSection === "notes" && (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
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
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "16px 0" }}>메모가 없습니다.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
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
              </>
            )}

            {/* 이벤트 로그 */}
            {activeSection === "log" && (
              <>
                {detail.logs.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "24px 0" }}>아직 이벤트 로그가 없습니다.</p>
                ) : (
                  <div style={{ maxHeight: 420, overflowY: "auto", padding: "4px 0" }}>
                    {[...detail.logs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((log, idx, arr) => {
                      const info = getActionLabel(log.action);
                      const isLast = idx === arr.length - 1;
                      let metaObj: Record<string, string> | null = null;
                      try { if (log.metadata) metaObj = JSON.parse(log.metadata); } catch { /* noop */ }
                      return (
                        <div key={log.id} style={{ display: "flex", gap: 0, position: "relative" }}>
                          {/* 세로선 + 아이콘 */}
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 38, flexShrink: 0 }}>
                            <div style={{
                              width: 30, height: 30, borderRadius: "50%",
                              background: info.color + "18", border: `2px solid ${info.color}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 14, zIndex: 1, flexShrink: 0,
                            }}>{info.dot}</div>
                            {!isLast && <div style={{ width: 2, flex: 1, minHeight: 16, background: "#e5e7eb" }} />}
                          </div>
                          {/* 내용 */}
                          <div style={{ flex: 1, paddingLeft: 10, paddingBottom: isLast ? 0 : 16, paddingTop: 4 }}>
                            <p style={{ margin: "0 0 3px", fontSize: 13, fontWeight: 600, color: info.color }}>{info.ko}</p>
                            {/* 메타데이터 (파일명 등) */}
                            {metaObj?.fileName && (
                              <p style={{ margin: "0 0 3px", fontSize: 12, color: "#374151", background: "#f9fafb", borderRadius: 4, padding: "2px 7px", display: "inline-block" }}>
                                📄 {metaObj.fileName}
                              </p>
                            )}
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                                {new Date(log.createdAt).toLocaleString("ko-KR")}
                              </span>
                              {log.performedByEmail && (
                                <span style={{
                                  fontSize: 11, color: "#6b7280",
                                  background: "#f3f4f6", borderRadius: 4, padding: "1px 7px",
                                }}>
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
      </div>
    </div>
  );
}
