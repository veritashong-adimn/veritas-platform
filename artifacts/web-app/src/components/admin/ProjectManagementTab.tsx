import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  api, User, AdminProject, AdminUser, AdminCustomer, Company, Contact,
  STATUS_LABEL, FINANCIAL_STATUS_LABEL, FINANCIAL_STATUS_STYLE,
} from '../../lib/constants';
import { StatusBadge, Card, PrimaryBtn, GhostBtn, FilterPill, ClickSelect } from '../ui';
import { DraggableModal } from './DraggableModal';

// ─── 인라인 스타일 ─────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const tableTh: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontSize: 11,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tableTd: React.CSSProperties = {
  padding: "8px 10px", fontSize: 12, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};

const PROJECT_PAGE_SIZE = 20;

// ─── 워크플로우 필터 정의 ──────────────────────────────────────────────────────
type WorkflowFilter =
  | { type: "status"; value: string; label: string }
  | { type: "quick"; value: string; label: string };

const WORKFLOW_FILTERS: WorkflowFilter[] = [
  { type: "status", value: "all",                  label: "전체" },
  { type: "status", value: "created",              label: "접수" },
  { type: "status", value: "quoted",               label: "견적중" },
  { type: "status", value: "approved",             label: "미확정" },
  { type: "status", value: "paid",                 label: "확정" },
  { type: "quick",  value: "needs_assignment",     label: "배정필요" },
  { type: "status", value: "in_progress,matched",  label: "진행중" },
  { type: "quick",  value: "delivered",            label: "납품" },
  { type: "status", value: "completed",            label: "완료" },
  { type: "status", value: "cancelled",            label: "취소" },
];

// ─── "다음 해야 할 일" 계산 ────────────────────────────────────────────────────
function getNextAction(p: AdminProject): { text: string; color: string; bg: string } {
  const urgentStyle = { color: "#dc2626", bg: "#fef2f2" };
  const warningStyle = { color: "#b45309", bg: "#fef3c7" };
  const infoStyle = { color: "#2563eb", bg: "#eff6ff" };
  const neutralStyle = { color: "#6b7280", bg: "#f3f4f6" };
  const doneStyle = { color: "#059669", bg: "#f0fdf4" };

  switch (p.status) {
    case "created":
      return p.hasQuote
        ? { text: "견적 발송 필요", ...warningStyle }
        : { text: "견적 생성 필요", ...urgentStyle };
    case "quoted":
      return { text: "고객 회신 대기", ...infoStyle };
    case "approved":
      return (p.taskCount ?? 0) === 0
        ? { text: "통번역사 배정 필요", ...urgentStyle }
        : { text: "작업 준비 중", ...neutralStyle };
    case "paid":
      return (p.taskCount ?? 0) === 0
        ? { text: "통번역사 배정 필요", ...urgentStyle }
        : { text: "작업 준비 중", ...neutralStyle };
    case "matched":
      return { text: "작업 시작 대기", ...warningStyle };
    case "in_progress":
      return { text: "납품 대기", ...infoStyle };
    case "completed":
      if (p.financialStatus === "receivable") return { text: "결제 확인 필요", ...urgentStyle };
      if (p.financialStatus === "unbilled")   return { text: "청구 필요", ...warningStyle };
      if (p.financialStatus === "billed")     return { text: "입금 대기", ...infoStyle };
      return { text: "정산 처리 필요", ...neutralStyle };
    case "cancelled":
      return { text: "—", ...neutralStyle };
    default:
      return { text: "—", ...neutralStyle };
  }
}

// ─── 견적금액 포맷 ─────────────────────────────────────────────────────────────
function fmtPrice(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(n)) return "—";
  return n.toLocaleString("ko-KR") + "원";
}

// ─── Section 헬퍼 ──────────────────────────────────────────────────────────────
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

// ─── SearchableSelect ──────────────────────────────────────────────────────────
type SSItem = { id: number; label: string; sub?: string };

function SearchableSelect({ items, value, onChange, placeholder, accentBorder = "#6366f1", maxResults = 20 }: {
  items: SSItem[]; value: number | null; onChange: (id: number | null) => void;
  placeholder?: string; accentBorder?: string; maxResults?: number;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(query), 250); return () => clearTimeout(t); }, [query]);

  useEffect(() => {
    const h = () => setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const selected = value != null ? items.find(i => i.id === value) : null;
  const q = debounced.toLowerCase();
  const filtered = (q
    ? items.filter(i => i.label.toLowerCase().includes(q) || (i.sub ?? "").toLowerCase().includes(q))
    : items
  ).slice(0, maxResults);
  const displayValue = open ? query : (selected?.label ?? "");

  useEffect(() => {
    if (!open || highlightIdx < 0 || !listRef.current) return;
    const item = listRef.current.children[highlightIdx] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx, open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlightIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < filtered.length) {
        onChange(filtered[highlightIdx].id);
        setQuery(""); setOpen(false); setHighlightIdx(-1);
      }
    }
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", border: `1px solid ${open ? accentBorder : "#d1d5db"}`, borderRadius: 7, background: "#fff", transition: "border-color 0.12s" }}>
        <input
          value={displayValue}
          onChange={e => { setQuery(e.target.value); setOpen(true); setHighlightIdx(-1); }}
          onFocus={() => { setOpen(true); if (selected) setQuery(""); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "이름으로 검색..."}
          style={{ flex: 1, padding: "7px 10px", fontSize: 13, border: "none", outline: "none", background: "transparent", borderRadius: 7, minWidth: 0 }}
        />
        {value != null && (
          <button type="button" onClick={() => { onChange(null); setQuery(""); setOpen(false); }}
            style={{ padding: "0 8px", fontSize: 15, lineHeight: 1, color: "#94a3b8", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>×</button>
        )}
        <span onClick={() => setOpen(o => !o)}
          style={{ padding: "0 8px", color: "#94a3b8", fontSize: 9, flexShrink: 0, userSelect: "none", cursor: "pointer" }}>
          {open ? "▲" : "▼"}
        </span>
      </div>
      {open && (
        <div ref={listRef}
          style={{ position: "absolute", top: "calc(100% + 2px)", left: 0, right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 7, boxShadow: "0 4px 18px rgba(0,0,0,0.1)", zIndex: 600, maxHeight: 208, overflowY: "auto", scrollbarWidth: "thin" }}
        >
          {filtered.length === 0
            ? <p style={{ margin: 0, padding: "7px 10px", fontSize: 12, color: "#94a3b8" }}>검색 결과 없음</p>
            : filtered.map((item, idx) => {
                const isHighlit = idx === highlightIdx;
                return (
                  <button key={item.id} type="button"
                    onMouseEnter={() => setHighlightIdx(idx)}
                    onMouseLeave={() => setHighlightIdx(-1)}
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

// ─── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  token: string;
  user: User;
  hasPerm: (perm?: string) => boolean;
  setToast: (msg: string) => void;
  authHeaders: Record<string, string>;
  adminUsers: AdminUser[];
  openDetail: (id: number, section?: string) => void;
  onProjectCreated?: () => void;
}

// ─── 컴포넌트 ──────────────────────────────────────────────────────────────────
export function ProjectManagementTab({ token, user, hasPerm, setToast, authHeaders, adminUsers, openDetail, onProjectCreated }: Props) {

  // ── 프로젝트 목록 ──────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 삭제 확인 모달 ─────────────────────────────────────────────────────────
  const [deleteConfirmProject, setDeleteConfirmProject] = useState<{ id: number; title: string } | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleting, setDeleting] = useState(false);

  // ── 필터 state ────────────────────────────────────────────────────────────
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [projectSearch, setProjectSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [assignedAdminFilter, setAssignedAdminFilter] = useState<string>("all");
  const [projectPage, setProjectPage] = useState(1);
  const [projectFinancialFilter, setProjectFinancialFilter] = useState<string>("all");
  const [projectQuickFilter, setProjectQuickFilter] = useState<string>("all");
  const [projectBillingTypeFilter, setProjectBillingTypeFilter] = useState<string>("all");
  const [projectPaymentDueDateFrom, setProjectPaymentDueDateFrom] = useState("");
  const [projectPaymentDueDateTo, setProjectPaymentDueDateTo] = useState("");
  const [projectCompanyIdFilter, setProjectCompanyIdFilter] = useState<string>("");
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false);

  // 상세필터 드래프트 — 패널 내부 변경은 드래프트에만 반영, "적용" 클릭 시 실제 상태로 복사
  const [draftFinancial,    setDraftFinancial]    = useState("all");
  const [draftBillingType,  setDraftBillingType]  = useState("all");
  const [draftDateFrom,     setDraftDateFrom]     = useState("");
  const [draftDateTo,       setDraftDateTo]       = useState("");
  const [draftPaymentFrom,  setDraftPaymentFrom]  = useState("");
  const [draftPaymentTo,    setDraftPaymentTo]    = useState("");
  const [fetchTrigger,      setFetchTrigger]      = useState(0);

  // ── 진입 선택 모달 state ──────────────────────────────────────────────────

  // ── 프로젝트 직접 등록 모달 state ─────────────────────────────────────────
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectCustomerId, setNewProjectCustomerId] = useState<number | null>(null);
  const [newProjectCustomerUserId, setNewProjectCustomerUserId] = useState<number | null>(null);
  const [newProjectCompanyId, setNewProjectCompanyId] = useState<number | null>(null);
  const [newProjectContactId, setNewProjectContactId] = useState<number | null>(null);
  const [newProjectDivisionId, setNewProjectDivisionId] = useState<number | null>(null);
  const [newProjectBillingCompanyId, setNewProjectBillingCompanyId] = useState<number | null>(null);
  const [newProjectPayerCompanyId, setNewProjectPayerCompanyId] = useState<number | null>(null);
  const [showBillingOverride, setShowBillingOverride] = useState(false);
  const [showPayerOverride, setShowPayerOverride] = useState(false);
  const [companyDivisions, setCompanyDivisions] = useState<{id:number;name:string;type:string|null}[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);

  // ── 초대 모달 state ───────────────────────────────────────────────────────
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [pendingInviteProjectId, setPendingInviteProjectId] = useState<number | null>(null);

  // ── 모달용 데이터 ─────────────────────────────────────────────────────────
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [platformUsers, setPlatformUsers] = useState<{id:number;name:string|null;email:string}[]>([]);

  // ── 현재 활성 워크플로우 필터 계산 ────────────────────────────────────────
  const activeWorkflowLabel = (() => {
    for (const wf of WORKFLOW_FILTERS) {
      if (wf.type === "quick" && projectQuickFilter === wf.value) return wf.label;
      if (wf.type === "status" && projectQuickFilter === "all" && projectFilter === wf.value) return wf.label;
    }
    return "전체";
  })();

  // ── 워크플로우 필터 클릭 핸들러 ───────────────────────────────────────────
  const handleWorkflowFilter = (wf: WorkflowFilter) => {
    setProjectPage(1);
    if (wf.type === "quick") {
      setProjectFilter("all");
      setProjectQuickFilter(wf.value);
    } else {
      setProjectFilter(wf.value);
      setProjectQuickFilter("all");
    }
  };

  // ── 상세필터 헬퍼 ─────────────────────────────────────────────────────────
  const getFinancialValue = () => {
    if (projectQuickFilter === "prepaid_deduction")      return "prepaid_used";
    if (projectQuickFilter === "has_prepaid_balance")    return "balance";
    if (projectQuickFilter === "accumulated_in_progress") return "ongoing";
    return projectFinancialFilter;
  };

  // 패널 열릴 때 현재 실제 값을 드래프트에 동기화
  useEffect(() => {
    if (showAdvancedFilter) {
      setDraftFinancial(getFinancialValue());
      setDraftBillingType(projectBillingTypeFilter);
      setDraftDateFrom(dateFrom);
      setDraftDateTo(dateTo);
      setDraftPaymentFrom(projectPaymentDueDateFrom);
      setDraftPaymentTo(projectPaymentDueDateTo);
    }
  }, [showAdvancedFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // 드래프트 → 실제 상태 적용. setFetchTrigger 증가 → 아래 useEffect가 새 fetchProjects(최신 클로저) 호출
  const applyAdvancedFilter = () => {
    if (draftFinancial === "prepaid_used")  { setProjectQuickFilter("prepaid_deduction");       setProjectFinancialFilter("all"); }
    else if (draftFinancial === "balance")  { setProjectQuickFilter("has_prepaid_balance");      setProjectFinancialFilter("all"); }
    else if (draftFinancial === "ongoing")  { setProjectQuickFilter("accumulated_in_progress");  setProjectFinancialFilter("all"); }
    else                                    { setProjectFinancialFilter(draftFinancial);          setProjectQuickFilter("all"); }
    setProjectBillingTypeFilter(draftBillingType);
    setDateFrom(draftDateFrom);
    setDateTo(draftDateTo);
    setProjectPaymentDueDateFrom(draftPaymentFrom);
    setProjectPaymentDueDateTo(draftPaymentTo);
    setProjectPage(1);
    setShowAdvancedFilter(false);
    setFetchTrigger(t => t + 1);
  };

  const resetAdvancedFilter = () => {
    setDraftFinancial("all"); setDraftBillingType("all");
    setDraftDateFrom(""); setDraftDateTo("");
    setDraftPaymentFrom(""); setDraftPaymentTo("");
    setProjectFinancialFilter("all"); setProjectQuickFilter("all");
    setProjectBillingTypeFilter("all");
    setDateFrom(""); setDateTo("");
    setProjectPaymentDueDateFrom(""); setProjectPaymentDueDateTo("");
    setProjectPage(1);
    setFetchTrigger(t => t + 1);
  };

  // ── 프로젝트 조회 ─────────────────────────────────────────────────────────
  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (projectSearch.trim()) params.set("search", projectSearch.trim());
      if (projectFilter !== "all") params.set("status", projectFilter);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (assignedAdminFilter !== "all") params.set("assignedAdminId", assignedAdminFilter);
      if (projectFinancialFilter !== "all") params.set("financialStatus", projectFinancialFilter);
      if (projectQuickFilter !== "all") params.set("quickFilter", projectQuickFilter);
      if (projectBillingTypeFilter !== "all") params.set("billingType", projectBillingTypeFilter);
      if (projectPaymentDueDateFrom) params.set("paymentDueDateFrom", projectPaymentDueDateFrom);
      if (projectPaymentDueDateTo) params.set("paymentDueDateTo", projectPaymentDueDateTo);
      if (projectCompanyIdFilter) params.set("companyId", projectCompanyIdFilter);
      const res = await fetch(api(`/api/admin/projects${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setProjects(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 프로젝트 조회 실패"); }
    finally { setLoading(false); }
  }, [token, projectSearch, projectFilter, dateFrom, dateTo, assignedAdminFilter, projectFinancialFilter, projectQuickFilter, projectBillingTypeFilter, projectPaymentDueDateFrom, projectPaymentDueDateTo, projectCompanyIdFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 거래처/담당자/고객 데이터 로드 (모달용) ──────────────────────────────
  const fetchModalData = useCallback(async () => {
    try {
      const [cRes, coRes, cuRes, puRes] = await Promise.all([
        fetch(api("/api/admin/companies"), { headers: authHeaders }),
        fetch(api("/api/admin/contacts"), { headers: authHeaders }),
        fetch(api("/api/admin/customers"), { headers: authHeaders }),
        fetch(api("/api/admin/platform-users"), { headers: authHeaders }),
      ]);
      if (cRes.ok) setCompanies(await cRes.json());
      if (coRes.ok) setContacts(await coRes.json());
      if (cuRes.ok) setCustomers(await cuRes.json());
      if (puRes.ok) setPlatformUsers(await puRes.json());
    } catch { /* ignore */ }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchProjects();
    fetchModalData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // applyAdvancedFilter / resetAdvancedFilter 에서 증가 → 최신 fetchProjects(새 클로저) 호출
  useEffect(() => {
    if (fetchTrigger > 0) fetchProjects();
  }, [fetchTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 삭제 실행 ─────────────────────────────────────────────────────────────
  const handleDeleteProject = async () => {
    if (!deleteConfirmProject) return;
    setDeleting(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${deleteConfirmProject.id}`), {
        method: "DELETE",
        headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("프로젝트가 완전히 삭제되었습니다.");
      setDeleteConfirmProject(null);
      setDeleteConfirmInput("");
      fetchProjects();
    } catch { setToast("오류: 삭제 요청에 실패했습니다."); }
    finally { setDeleting(false); }
  };

  // ── CSV 내보내기 ──────────────────────────────────────────────────────────
  const handleExportProjects = async () => {
    try {
      const res = await fetch(api("/api/admin/export/projects"), { headers: authHeaders });
      if (!res.ok) { setToast("오류: CSV 내보내기 실패"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `projects_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch { setToast("오류: CSV 내보내기 실패"); }
  };

  // ── 프로젝트 직접 등록 ────────────────────────────────────────────────────
  const handleCreateAdminProject = async () => {
    if (!newProjectTitle.trim()) { setToast("프로젝트 제목을 입력하세요."); return; }
    setCreatingProject(true);
    try {
      const res = await fetch(api("/api/admin/projects"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newProjectTitle.trim(),
          customerId: newProjectCustomerId ?? undefined,
          customerUserId: newProjectCustomerUserId ?? undefined,
          companyId: newProjectCompanyId ?? undefined,
          contactId: newProjectContactId ?? undefined,
          requestingDivisionId: newProjectDivisionId ?? undefined,
          billingCompanyId: showBillingOverride ? (newProjectBillingCompanyId ?? undefined) : undefined,
          payerCompanyId: showPayerOverride ? (newProjectPayerCompanyId ?? undefined) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }

      if (newProjectCustomerUserId && data.id) {
        try {
          await fetch(api("/api/notifications/project-created"), {
            method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ userId: newProjectCustomerUserId, projectId: data.id }),
          });
        } catch { /* 알림 실패는 무시 */ }
      }

      if (inviteEmail.trim() && data.id) {
        try {
          const invRes = await fetch(api("/api/invitations"), {
            method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ name: inviteName.trim() || undefined, email: inviteEmail.trim(), projectId: data.id }),
          });
          const invData = await invRes.json();
          if (invRes.ok) {
            setToast(invData.mode === "linked" ? `프로젝트 #${data.id} 생성 + 기존 계정 연결됨` : `프로젝트 #${data.id} 생성 + 초대 이메일 발송됨`);
          } else {
            setToast(`프로젝트 #${data.id} 생성됨 (초대 실패: ${invData.error})`);
          }
        } catch {
          setToast(`프로젝트 #${data.id} 생성됨 (초대 발송 오류)`);
        }
      } else {
        setToast(`프로젝트 #${data.id} 생성 완료`);
      }
      resetCreateModal();
      await fetchProjects();
      openDetail(data.id);
      onProjectCreated?.();
    } catch { setToast("오류: 프로젝트 생성 실패"); }
    finally { setCreatingProject(false); }
  };

  const handleInviteFormConfirm = () => {
    if (!inviteEmail.trim()) { setInviteError("이메일을 입력하세요."); return; }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail.trim())) { setInviteError("올바른 이메일 주소를 입력하세요."); return; }
    setShowInviteModal(false);
    setInviteError("");
  };

  const resetCreateModal = () => {
    setShowCreateProject(false); setNewProjectTitle("");
    setShowBillingOverride(false); setShowPayerOverride(false);
    setNewProjectCustomerId(null); setNewProjectCustomerUserId(null);
    setNewProjectCompanyId(null); setNewProjectContactId(null);
    setNewProjectDivisionId(null); setNewProjectBillingCompanyId(null);
    setNewProjectPayerCompanyId(null); setCompanyDivisions([]);
    setInviteName(""); setInviteEmail(""); setInviteError("");
    setPendingInviteProjectId(null); setShowInviteModal(false);
  };

  // ── 담당PM 이름 조회 ──────────────────────────────────────────────────────
  const getPmLabel = (adminId: number | null): string => {
    if (!adminId) return "—";
    const u = adminUsers.find(a => a.id === adminId);
    if (!u) return `#${adminId}`;
    return u.name ?? u.email.split("@")[0];
  };

  // ── JSX ──────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── 삭제 확인 모달 ── */}
      {deleteConfirmProject && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 32px", width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 800, color: "#dc2626" }}>⚠ 프로젝트 완전 삭제</h2>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "#374151", lineHeight: 1.6 }}>
              이 작업은 <strong>되돌릴 수 없습니다.</strong><br />
              프로젝트, 관련 견적, 견적 항목, 로그 등 모든 연결 데이터가 영구 삭제됩니다.
            </p>
            <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 18 }}>
              <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, color: "#991b1b" }}>삭제 대상 프로젝트</p>
              <p style={{ margin: 0, fontSize: 13, color: "#7f1d1d" }}>
                #{deleteConfirmProject.id} — {deleteConfirmProject.title || "(제목 없음)"}
              </p>
            </div>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
              아래 입력란에 <code style={{ background: "#fee2e2", color: "#dc2626", padding: "1px 6px", borderRadius: 4 }}>삭제</code>를 정확히 입력하면 최종 삭제가 활성화됩니다.
            </label>
            <input
              value={deleteConfirmInput}
              onChange={e => setDeleteConfirmInput(e.target.value)}
              placeholder="삭제"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #fca5a5", fontSize: 14, boxSizing: "border-box", outline: "none", marginBottom: 18 }}
            />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => { setDeleteConfirmProject(null); setDeleteConfirmInput(""); }} disabled={deleting}
                style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                취소
              </button>
              <button onClick={handleDeleteProject} disabled={deleteConfirmInput !== "삭제" || deleting}
                style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: deleteConfirmInput === "삭제" ? "#dc2626" : "#fca5a5", color: "#fff", fontSize: 13, fontWeight: 700, cursor: deleteConfirmInput === "삭제" ? "pointer" : "not-allowed", transition: "background 0.15s" }}>
                {deleting ? "삭제 중..." : "최종 삭제"}
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ── 프로젝트 직접 등록 모달 ── */}
      {showCreateProject && (
        <DraggableModal
          title="프로젝트 직접 등록"
          subtitle="내부 업무 또는 예외 업무용 — 거래처, 담당자, 의뢰/청구/납부 주체를 지정하여 프로젝트를 직접 등록합니다."
          onClose={resetCreateModal}
          width={520}
          zIndex={400}
          bodyPadding="20px 28px"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>제목 *</label>
              <input value={newProjectTitle} onChange={e => setNewProjectTitle(e.target.value)}
                placeholder="프로젝트 제목" autoFocus
                style={{ width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, outline: "none" }}
                onKeyDown={e => e.key === "Enter" && handleCreateAdminProject()} />
            </div>
            {/* ── 요청 주체 ── */}
            <div style={{ borderRadius: 10, border: "1px solid #e5e7eb", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, background: "#fafafa" }}>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>요청 주체</p>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>거래처</label>
                <SearchableSelect
                  items={companies.map(c => ({ id: c.id, label: c.name, sub: (c.divisionNames?.length ?? 0) > 0 ? c.divisionNames!.slice(0, 3).join(" · ") : undefined }))}
                  value={newProjectCompanyId}
                  placeholder="회사명, 브랜드명으로 검색..."
                  accentBorder="#6366f1"
                  onChange={async (cid) => {
                    setNewProjectCompanyId(cid);
                    setNewProjectContactId(null);
                    setNewProjectDivisionId(null);
                    setNewProjectBillingCompanyId(null);
                    setNewProjectPayerCompanyId(null);
                    setShowBillingOverride(false);
                    setShowPayerOverride(false);
                    setCompanyDivisions([]);
                    if (cid) {
                      const res = await fetch(api(`/api/admin/companies/${cid}/divisions`), { headers: authHeaders });
                      if (res.ok) setCompanyDivisions(await res.json());
                    }
                  }}
                />
              </div>
              {companyDivisions.length > 0 && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#7c3aed", display: "block", marginBottom: 4 }}>브랜드 / 부서</label>
                  <ClickSelect
                    value={String(newProjectDivisionId ?? "")}
                    onChange={val => setNewProjectDivisionId(val ? Number(val) : null)}
                    options={[
                      { value: "", label: "— 본사 직접 의뢰 —" },
                      ...companyDivisions.map(d => ({ value: String(d.id), label: d.name + (d.type ? ` (${d.type})` : "") })),
                    ]}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", border: "1px solid #e9d5ff", background: "#faf5ff", color: "#7c3aed", fontWeight: 600, fontSize: 14, padding: "9px 12px" }}
                    menuStyle={{ minWidth: "100%" }}
                  />
                </div>
              )}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>담당자</label>
                <SearchableSelect
                  items={(contacts as Contact[])
                    .filter(c => !newProjectCompanyId || c.companyId === newProjectCompanyId)
                    .filter(c => !newProjectDivisionId || c.divisionId === newProjectDivisionId || c.divisionId === null)
                    .map(c => {
                      const divName = c.divisionId ? companyDivisions.find(d => d.id === c.divisionId)?.name : null;
                      const subParts = [divName ? `📌 ${divName}` : null, c.email, c.phone].filter(Boolean) as string[];
                      return { id: c.id, label: c.name, sub: subParts.join(" · ") || undefined };
                    })}
                  value={newProjectContactId}
                  placeholder="이름 · 이메일 · 전화번호 검색..."
                  accentBorder="#6366f1"
                  onChange={setNewProjectContactId}
                />
              </div>
            </div>

            {/* ── 고객 로그인 계정 ── */}
            <div style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fafafa" }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                고객 로그인 계정
                <span style={{ fontWeight: 400, color: "#9ca3af" }}>(선택)</span>
                <span
                  title={"로그인하여 프로젝트 조회, 견적 확인, 결제를 할 수 있는 고객 계정입니다."}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, borderRadius: "50%", background: "#e5e7eb", color: "#6b7280", fontSize: 10, fontWeight: 700, cursor: "help", flexShrink: 0 }}
                >?</span>
              </label>

              <SearchableSelect
                items={platformUsers.map(u => ({ id: u.id, label: u.name ?? u.email, sub: u.name ? u.email : undefined }))}
                value={inviteEmail ? null : newProjectCustomerUserId}
                placeholder="기존 계정 검색..."
                accentBorder="#374151"
                onChange={id => {
                  if (inviteEmail) { setInviteEmail(""); setInviteName(""); }
                  setNewProjectCustomerUserId(id);
                }}
              />

              {newProjectCustomerUserId && !inviteEmail && (() => {
                const u = platformUsers.find(p => p.id === newProjectCustomerUserId);
                return u ? (
                  <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: "#f0fdf4", borderRadius: 6, border: "1px solid #bbf7d0" }}>
                    <span style={{ fontSize: 12 }}>✓</span>
                    <span style={{ fontSize: 12, color: "#065f46", flex: 1 }}>
                      <strong>{u.name ?? u.email}</strong>{u.name ? ` (${u.email})` : ""} — 등록 시 알림 발송
                    </span>
                  </div>
                ) : null;
              })()}

              {inviteEmail && (
                <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", background: "#eff6ff", borderRadius: 6, border: "1px solid #bfdbfe" }}>
                  <span style={{ fontSize: 13, color: "#2563eb" }}>✉</span>
                  <span style={{ fontSize: 12, color: "#1d4ed8", flex: 1 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, background: "#dbeafe", color: "#1e40af", borderRadius: 4, padding: "1px 5px", marginRight: 5 }}>초대 예정</span>
                    <strong>{inviteName || inviteEmail}</strong>
                    {inviteName ? <span style={{ color: "#6b7280" }}> ({inviteEmail})</span> : ""}
                  </span>
                  <button type="button" onClick={() => { setInviteEmail(""); setInviteName(""); setInviteError(""); }}
                    style={{ fontSize: 12, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 4, lineHeight: 1 }} title="초대 예정 취소">✕</button>
                  <button type="button" onClick={() => { setInviteError(""); setShowInviteModal(true); }}
                    style={{ fontSize: 11, color: "#2563eb", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", fontWeight: 600, borderRadius: 4, textDecoration: "underline" }}>수정</button>
                </div>
              )}

              <div style={{ marginTop: 8, borderTop: "1px dashed #e5e7eb", paddingTop: 8 }}>
                <button type="button"
                  onClick={() => { setNewProjectCustomerUserId(null); setInviteError(""); setShowInviteModal(true); }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: "#2563eb", background: "#eff6ff", border: "1.5px solid #bfdbfe", borderRadius: 8, cursor: "pointer", padding: "7px 14px", transition: "background 0.15s" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#dbeafe")}
                  onMouseLeave={e => (e.currentTarget.style.background = "#eff6ff")}
                >
                  <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
                  고객 계정 초대
                </button>
                <p style={{ margin: "5px 0 0", fontSize: 11, color: "#9ca3af" }}>
                  기존 계정이 없는 경우 이메일로 초대 링크를 발송합니다
                </p>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
            <GhostBtn onClick={resetCreateModal}>취소</GhostBtn>
            <PrimaryBtn onClick={handleCreateAdminProject} disabled={creatingProject || !newProjectTitle.trim()} style={{ padding: "9px 20px" }}>
              {creatingProject ? "생성 중..." : "프로젝트 등록"}
            </PrimaryBtn>
          </div>
        </DraggableModal>
      )}

      {/* ── 고객 초대 미니 모달 ── */}
      {showInviteModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
          onClick={e => { if (e.target === e.currentTarget) setShowInviteModal(false); }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 28px 24px", width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
            <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#111827" }}>고객 계정 초대</p>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280" }}>
              이 이메일로 로그인 계정을 초대합니다.<br />
              기존 계정이 있으면 해당 계정에 연결되고,<br />
              없으면 프로젝트 등록 완료 시 초대 이메일이 발송됩니다.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>
                  이름 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(선택)</span>
                </label>
                <input value={inviteName} onChange={e => setInviteName(e.target.value)} placeholder="고객 이름" style={{ ...inputStyle }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>
                  이메일 <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                  placeholder="customer@example.com" style={{ ...inputStyle }}
                  onKeyDown={e => e.key === "Enter" && handleInviteFormConfirm()} />
              </div>
              {inviteError && (
                <p style={{ margin: 0, fontSize: 12, color: "#dc2626", background: "#fef2f2", padding: "7px 10px", borderRadius: 6 }}>{inviteError}</p>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <GhostBtn onClick={() => { setShowInviteModal(false); setInviteError(""); }}>취소</GhostBtn>
              <PrimaryBtn onClick={handleInviteFormConfirm} style={{ padding: "9px 20px" }}>초대 추가</PrimaryBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── 프로젝트 탭 ── */}
      <Section title={`전체 판매건 (${projects.length})`} action={
        <div style={{ display: "flex", gap: 8 }}>
          <GhostBtn onClick={handleExportProjects} style={{ fontSize: 13, padding: "7px 14px" }}>⬇ CSV 내보내기</GhostBtn>
        </div>
      }>
        {/* 필터 영역 (sticky) */}
        <div style={{ position: "sticky", top: 0, zIndex: 30, background: "#fff", paddingBottom: 8, marginBottom: 18 }}>

          {/* 검색 바 */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
            <input
              value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
              placeholder="판매번호 · 판매명 · 거래처 · 고객명 · 담당PM 검색"
              style={{ ...inputStyle, maxWidth: 320, flex: "1 1 180px", padding: "7px 11px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchProjects()}
            />
            <PrimaryBtn onClick={fetchProjects} disabled={loading} style={{ padding: "7px 14px", fontSize: 13 }}>
              {loading ? "검색 중..." : "검색"}
            </PrimaryBtn>
            {(projectSearch || dateFrom || dateTo || assignedAdminFilter !== "all" || projectFilter !== "all" || projectFinancialFilter !== "all" || projectQuickFilter !== "all" || projectBillingTypeFilter !== "all" || projectPaymentDueDateFrom || projectPaymentDueDateTo || projectCompanyIdFilter) && (
              <button
                onClick={() => { setProjectSearch(""); setDateFrom(""); setDateTo(""); setAssignedAdminFilter("all"); setProjectFilter("all"); setProjectFinancialFilter("all"); setProjectQuickFilter("all"); setProjectBillingTypeFilter("all"); setProjectPaymentDueDateFrom(""); setProjectPaymentDueDateTo(""); setProjectCompanyIdFilter(""); setProjectPage(1); }}
                style={{ padding: "7px 12px", fontSize: 12, fontWeight: 700, background: "#fef2f2", color: "#dc2626", border: "1.5px solid #fca5a5", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                ✕ 필터 초기화
              </button>
            )}
            <GhostBtn onClick={() => setShowAdvancedFilter(v => !v)} style={{ marginLeft: "auto", padding: "7px 12px", fontSize: 12 }}>
              {showAdvancedFilter ? "상세필터 접기 ▲" : "⚙ 상세필터 ▼"}
            </GhostBtn>
          </div>

          {/* 업무 흐름 기준 상태 필터 */}
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 12px", marginBottom: 5 }}>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", letterSpacing: "0.3px", minWidth: 44, marginRight: 2 }}>업무 흐름</span>
              <div style={{ width: 1, height: 14, background: "#d1d5db", marginRight: 4 }} />
              {WORKFLOW_FILTERS.map(wf => {
                const isActive = wf.label === activeWorkflowLabel;
                return (
                  <FilterPill
                    key={wf.label}
                    label={wf.label}
                    active={isActive}
                    onClick={() => { handleWorkflowFilter(wf); fetchProjects(); }}
                  />
                );
              })}
            </div>
          </div>

          {/* 상세 필터 패널 */}
          <div style={{
            overflow: "hidden",
            maxHeight: showAdvancedFilter ? "520px" : "0",
            opacity: showAdvancedFilter ? 1 : 0,
            marginTop: showAdvancedFilter ? 10 : 0,
            transition: "max-height 0.25s cubic-bezier(0.22,1,0.36,1), opacity 0.2s ease, margin-top 0.2s ease",
          }}>
            <div style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              padding: "16px 18px 14px",
            }}>
              {/* 패널 제목 */}
              <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 14, display: "flex", alignItems: "center", gap: 5 }}>
                🔍 상세 검색 조건
              </div>

              {/* 드롭다운 필터 2열 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 5 }}>재무 상태</div>
                  <ClickSelect
                    value={draftFinancial}
                    onChange={setDraftFinancial}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 12 }}
                    options={[
                      { value: "all", label: "전체" }, { value: "unbilled", label: "미청구" },
                      { value: "billed", label: "청구 완료" }, { value: "receivable", label: "미수금" },
                      { value: "paid", label: "입금 완료" }, { value: "prepaid_used", label: "선입금 차감" },
                      { value: "balance", label: "잔액 남음" }, { value: "ongoing", label: "누적 진행중" },
                    ]}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 5 }}>청구 방식</div>
                  <ClickSelect
                    value={draftBillingType}
                    onChange={setDraftBillingType}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 12 }}
                    options={[
                      { value: "all", label: "전체" }, { value: "postpaid_per_project", label: "건별 후불" },
                      { value: "monthly_billing", label: "누적 청구" }, { value: "prepaid_wallet", label: "선입금 차감" },
                      { value: "prepay_upfront", label: "선결제(카드/현금)" },
                    ]}
                  />
                </div>
              </div>

              {/* 날짜 범위 2열 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 5 }}>등록일</div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <input type="date" value={draftDateFrom} onChange={e => setDraftDateFrom(e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: "5px 7px", fontSize: 12 }} />
                    <span style={{ color: "#d1d5db", fontSize: 11 }}>~</span>
                    <input type="date" value={draftDateTo} onChange={e => setDraftDateTo(e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: "5px 7px", fontSize: 12 }} />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#6b7280", marginBottom: 5 }}>입금 예정일</div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <input type="date" value={draftPaymentFrom} onChange={e => setDraftPaymentFrom(e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: "5px 7px", fontSize: 12 }} />
                    <span style={{ color: "#d1d5db", fontSize: 11 }}>~</span>
                    <input type="date" value={draftPaymentTo} onChange={e => setDraftPaymentTo(e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: "5px 7px", fontSize: 12 }} />
                  </div>
                </div>
              </div>

              {/* 하단 버튼 */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, paddingTop: 12, borderTop: "1px solid #e5e7eb" }}>
                <button
                  onClick={resetAdvancedFilter}
                  style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600, background: "#fff", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: 7, cursor: "pointer" }}
                >
                  초기화
                </button>
                <button
                  onClick={applyAdvancedFilter}
                  style={{ padding: "6px 18px", fontSize: 12, fontWeight: 700, background: "#2563eb", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer" }}
                >
                  적용
                </button>
              </div>
            </div>
          </div>
        </div>
        {/* 필터 영역 끝 */}

        {loading ? (
          <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
        ) : projects.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
            해당 조건의 프로젝트가 없습니다.
          </Card>
        ) : (() => {
          const totalPages = Math.ceil(projects.length / PROJECT_PAGE_SIZE);
          const safePage = Math.min(projectPage, totalPages);
          const pagedProjects = projects.slice((safePage - 1) * PROJECT_PAGE_SIZE, safePage * PROJECT_PAGE_SIZE);

          const QUOTE_TYPE_LABEL: Record<string, string> = {
            b2b_standard: "B2B",
            b2c_prepaid: "차감 견적",
            prepaid_deduction: "차감 견적",
            accumulated_batch: "누적",
          };

          return (
            <>
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {[
                          { label: "ID",           w: 44  },
                          { label: "프로젝트명",    w: 200 },
                          { label: "거래처",        w: 130 },
                          { label: "담당자",        w: 90  },
                          { label: "유형",          w: 64  },
                          { label: "견적금액",      w: 90  },
                          { label: "입금현황",      w: 72  },
                          { label: "현재상태",      w: 72  },
                          { label: "담당PM",        w: 80  },
                          { label: "다음 해야 할 일", w: 150 },
                          { label: "등록일",        w: 76  },
                          { label: "액션",          w: 120 },
                        ].map(h => (
                          <th key={h.label} style={{ ...tableTh, minWidth: h.w }}>{h.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pagedProjects.map(p => {
                        const pp = p as any;
                        const reqName = pp.requestingCompanyName ?? p.companyName ?? "—";
                        const nextAction = getNextAction(p);

                        // 액션 버튼 매핑
                        type SectionKey = "info"|"quote"|"progress"|"payment"|"settlement"|"history";
                        const ACTION_MAP: Record<string, { label: string; section: SectionKey; color: string; bg: string }> = {
                          created:     { label: "견적 생성",     section: "quote",      color: "#fff",    bg: "#2563eb" },
                          quoted:      { label: "견적 확인",     section: "quote",      color: "#fff",    bg: "#2563eb" },
                          approved:    { label: "통번역사 배정", section: "progress",   color: "#fff",    bg: "#7c3aed" },
                          paid:        { label: "배정 관리",    section: "progress",   color: "#fff",    bg: "#7c3aed" },
                          matched:     { label: "배정 관리",    section: "progress",   color: "#fff",    bg: "#7c3aed" },
                          in_progress: { label: "진행 보기",     section: "progress",   color: "#fff",    bg: "#6d28d9" },
                          completed:   { label: "정산 확인",     section: "settlement", color: "#fff",    bg: "#059669" },
                          cancelled:   { label: "상세보기",      section: "info",       color: "#6b7280", bg: "#f3f4f6" },
                        };
                        const action = ACTION_MAP[p.status] ?? { label: "상세보기", section: "info" as SectionKey, color: "#6b7280", bg: "#f3f4f6" };

                        return (
                          <tr key={p.id}
                            onClick={() => openDetail(p.id)}
                            style={{ cursor: "pointer", transition: "background 0.1s" }}
                            onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
                            onMouseLeave={e => (e.currentTarget.style.background = "")}>

                            {/* ID */}
                            <td style={{ ...tableTd, color: "#c0c8d4", fontSize: 11 }}>#{p.id}</td>

                            {/* 프로젝트명 */}
                            <td style={{ ...tableTd, maxWidth: 200 }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600, color: "#111827" }}>{p.title}</div>
                              {p.customerEmail && <div style={{ fontSize: 11, color: "#c0c8d4", marginTop: 1 }}>{p.customerEmail}</div>}
                            </td>

                            {/* 거래처 */}
                            <td style={{ ...tableTd, maxWidth: 130 }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500, color: "#374151" }}>
                                {reqName}
                              </div>
                              {pp.divisionName && (
                                <span style={{ background: "#ede9fe", color: "#7c3aed", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap" }}>
                                  {pp.divisionName}
                                </span>
                              )}
                            </td>

                            {/* 담당자 */}
                            <td style={{ ...tableTd, maxWidth: 90 }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "#6b7280" }}>
                                {p.contactName ?? "—"}
                              </div>
                            </td>

                            {/* 유형 (quoteType) */}
                            <td style={{ ...tableTd }}>
                              {p.quoteType ? (
                                <span style={{ fontSize: 10, fontWeight: 700, background: "#f1f5f9", color: "#475569", borderRadius: 5, padding: "2px 6px", whiteSpace: "nowrap" }}>
                                  {QUOTE_TYPE_LABEL[p.quoteType] ?? p.quoteType}
                                </span>
                              ) : <span style={{ color: "#d1d5db", fontSize: 11 }}>—</span>}
                            </td>

                            {/* 견적금액 */}
                            <td style={{ ...tableTd, whiteSpace: "nowrap", fontWeight: 500, color: "#1e3a5f", fontSize: 12 }}>
                              {fmtPrice(p.quotePrice)}
                            </td>

                            {/* 입금현황 */}
                            <td style={{ ...tableTd }}>
                              {(() => {
                                const fs = p.financialStatus ?? "unbilled";
                                const fStyle = FINANCIAL_STATUS_STYLE[fs] ?? { background: "#f3f4f6", color: "#6b7280" };
                                return (
                                  <span style={{ ...fStyle, fontSize: 10, fontWeight: 700, borderRadius: 6, padding: "2px 6px", display: "inline-block" }}>
                                    {FINANCIAL_STATUS_LABEL[fs] ?? fs}
                                  </span>
                                );
                              })()}
                            </td>

                            {/* 현재상태 */}
                            <td style={{ ...tableTd }}>
                              <StatusBadge status={p.status} />
                            </td>

                            {/* 담당PM */}
                            <td style={{ ...tableTd, maxWidth: 80 }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "#6b7280" }}>
                                {getPmLabel(p.adminId)}
                              </div>
                            </td>

                            {/* 다음 해야 할 일 */}
                            <td style={{ ...tableTd, maxWidth: 150 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 6, background: nextAction.bg, color: nextAction.color, whiteSpace: "nowrap" }}>
                                {nextAction.text}
                              </span>
                            </td>

                            {/* 등록일 */}
                            <td style={{ ...tableTd, fontSize: 11, color: "#c0c8d4", whiteSpace: "nowrap" }}>
                              {new Date(p.createdAt).toLocaleDateString("ko-KR")}
                            </td>

                            {/* 액션 */}
                            <td style={{ ...tableTd }} onClick={e => e.stopPropagation()}>
                              <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "nowrap" }}>
                                <button
                                  onClick={() => openDetail(p.id, action.section)}
                                  style={{ background: action.bg, color: action.color, border: "none", borderRadius: 6, padding: "4px 9px", fontSize: 10, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                                  {action.label}
                                </button>
                                {p.status !== "cancelled" && p.status !== "completed" && (
                                  <button
                                    onClick={async () => {
                                      if (!confirm(`프로젝트 #${p.id}를 취소하시겠습니까?`)) return;
                                      const res = await fetch(api(`/api/admin/projects/${p.id}/cancel`), {
                                        method: "PATCH",
                                        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                                      });
                                      if (res.ok) { setToast("프로젝트가 취소되었습니다."); fetchProjects(); }
                                      else { const d = await res.json(); setToast(`오류: ${d.error}`); }
                                    }}
                                    style={{ background: "transparent", color: "#ef4444", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 7px", fontSize: 10, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>
                                    취소
                                  </button>
                                )}
                                {user.role === "admin" && (
                                  <button
                                    onClick={() => { setDeleteConfirmProject({ id: p.id, title: p.title }); setDeleteConfirmInput(""); }}
                                    style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 7px", fontSize: 10, cursor: "pointer", fontWeight: 700, whiteSpace: "nowrap" }}>
                                    삭제
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 페이지네이션 */}
              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12 }}>
                  <button
                    onClick={() => setProjectPage(p => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    style={{ background: safePage <= 1 ? "#f3f4f6" : "#fff", border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: safePage <= 1 ? "default" : "pointer", color: safePage <= 1 ? "#9ca3af" : "#374151" }}>
                    이전
                  </button>
                  <span style={{ fontSize: 13, color: "#6b7280" }}>
                    {safePage} / {totalPages} 페이지
                    <span style={{ marginLeft: 6, color: "#9ca3af" }}>({projects.length}건)</span>
                  </span>
                  <button
                    onClick={() => setProjectPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    style={{ background: safePage >= totalPages ? "#f3f4f6" : "#fff", border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: safePage >= totalPages ? "default" : "pointer", color: safePage >= totalPages ? "#9ca3af" : "#374151" }}>
                    다음
                  </button>
                </div>
              )}
            </>
          );
        })()}
      </Section>
    </>
  );
}
