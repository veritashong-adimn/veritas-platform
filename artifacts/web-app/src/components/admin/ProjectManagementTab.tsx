import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  api, User, AdminProject, AdminUser, AdminCustomer, Company, Contact,
  STATUS_LABEL, ALL_PROJECT_STATUSES, FINANCIAL_STATUS_LABEL, FINANCIAL_STATUS_STYLE,
} from '../../lib/constants';
import { StatusBadge, Card, PrimaryBtn, GhostBtn, FilterPill, ClickSelect } from '../ui';
import { DraggableModal } from './DraggableModal';

// ─── 인라인 스타일 ────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const tableTh: React.CSSProperties = {
  padding: "10px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};
const tableTd: React.CSSProperties = {
  padding: "9px 12px", fontSize: 13, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};

const PROJECT_PAGE_SIZE = 20;

// ─── Section 헬퍼 ─────────────────────────────────────────────────────────────
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

// ─── Props ────────────────────────────────────────────────────────────────────
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

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
export function ProjectManagementTab({ token, user, hasPerm, setToast, authHeaders, adminUsers, openDetail, onProjectCreated }: Props) {

  // ── 프로젝트 목록 ────────────────────────────────────────────────────────
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 프로젝트 완전 삭제 (admin 전용) ─────────────────────────────────────
  const [deleteConfirmProject, setDeleteConfirmProject] = useState<{ id: number; title: string } | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleting, setDeleting] = useState(false);

  // ── 필터 state ───────────────────────────────────────────────────────────
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [projectSearch, setProjectSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [assignedAdminFilter, setAssignedAdminFilter] = useState<string>("all");
  const [projectPage, setProjectPage] = useState(1);
  const [projectFinancialFilter, setProjectFinancialFilter] = useState<string>("all");
  const [projectQuickFilter, setProjectQuickFilter] = useState<string>("all");
  const [projectQuoteTypeFilter, setProjectQuoteTypeFilter] = useState<string>("all");
  const [projectBillingTypeFilter, setProjectBillingTypeFilter] = useState<string>("all");
  const [projectPaymentDueDateFrom, setProjectPaymentDueDateFrom] = useState("");
  const [projectPaymentDueDateTo, setProjectPaymentDueDateTo] = useState("");
  const [projectCompanyIdFilter, setProjectCompanyIdFilter] = useState<string>("");
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false);

  // ── 프로젝트 생성 모달 state ─────────────────────────────────────────────
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
  // 초대 후 생성된 프로젝트 ID를 임시 보관 (프로젝트 생성 → 초대 링크)
  const [pendingInviteProjectId, setPendingInviteProjectId] = useState<number | null>(null);

  // ── 모달용 데이터 ────────────────────────────────────────────────────────
  const [companies, setCompanies] = useState<Company[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [platformUsers, setPlatformUsers] = useState<{id:number;name:string|null;email:string}[]>([]);

  // ── 프로젝트 조회 ────────────────────────────────────────────────────────
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
      if (projectQuoteTypeFilter !== "all") params.set("quoteType", projectQuoteTypeFilter);
      if (projectBillingTypeFilter !== "all") params.set("billingType", projectBillingTypeFilter);
      if (projectPaymentDueDateFrom) params.set("paymentDueDateFrom", projectPaymentDueDateFrom);
      if (projectPaymentDueDateTo) params.set("paymentDueDateTo", projectPaymentDueDateTo);
      if (projectCompanyIdFilter) params.set("companyId", projectCompanyIdFilter);
      const res = await fetch(api(`/api/admin/projects${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setProjects(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 프로젝트 조회 실패"); }
    finally { setLoading(false); }
  }, [token, projectSearch, projectFilter, dateFrom, dateTo, assignedAdminFilter, projectFinancialFilter, projectQuickFilter, projectQuoteTypeFilter, projectBillingTypeFilter, projectPaymentDueDateFrom, projectPaymentDueDateTo, projectCompanyIdFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── 프로젝트 완전 삭제 실행 ─────────────────────────────────────────────
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

  // ── 프로젝트 CSV 내보내기 ────────────────────────────────────────────────
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

  // ── 프로젝트 생성 ────────────────────────────────────────────────────────
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

      // 기존 플랫폼 계정 연결 시 알림 발송
      if (newProjectCustomerUserId && data.id) {
        try {
          await fetch(api("/api/notifications/project-created"), {
            method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({ userId: newProjectCustomerUserId, projectId: data.id }),
          });
        } catch { /* 알림 실패는 무시 */ }
      }

      // 초대 이메일이 입력된 경우 → 초대 발송
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

  // ── 초대 폼 확인 (실제 API 호출은 프로젝트 등록 시) ─────────────────────
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

  // ── JSX ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── 프로젝트 완전 삭제 확인 모달 (admin 전용) ── */}
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
              <button
                onClick={() => { setDeleteConfirmProject(null); setDeleteConfirmInput(""); }}
                disabled={deleting}
                style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                취소
              </button>
              <button
                onClick={handleDeleteProject}
                disabled={deleteConfirmInput !== "삭제" || deleting}
                style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: deleteConfirmInput === "삭제" ? "#dc2626" : "#fca5a5", color: "#fff", fontSize: 13, fontWeight: 700, cursor: deleteConfirmInput === "삭제" ? "pointer" : "not-allowed", transition: "background 0.15s" }}>
                {deleting ? "삭제 중..." : "최종 삭제"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 프로젝트 생성 모달 ── */}
      {showCreateProject && (
        <DraggableModal
          title="프로젝트 직접 등록"
          subtitle="거래처, 담당자, 의뢰/청구/납부 주체를 지정하여 프로젝트를 직접 등록합니다."
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
                    title={"로그인하여 프로젝트 조회, 견적 확인, 결제를 할 수 있는 고객 계정입니다.\n선택하면 고객이 직접 프로젝트를 확인하고 진행할 수 있습니다.\n선택하지 않으면 내부에서만 관리되는 프로젝트로 등록됩니다."}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 15, height: 15, borderRadius: "50%", background: "#e5e7eb", color: "#6b7280", fontSize: 10, fontWeight: 700, cursor: "help", flexShrink: 0 }}
                  >?</span>
                </label>

                {/* 기존 계정 선택 셀렉트 */}
                <SearchableSelect
                  items={platformUsers.map(u => ({ id: u.id, label: u.name ?? u.email, sub: u.name ? u.email : undefined }))}
                  value={inviteEmail ? null : newProjectCustomerUserId}
                  placeholder="기존 계정 검색..."
                  accentBorder="#374151"
                  onChange={id => {
                    // 초대 예정이 있으면 제거하고 기존 계정 선택
                    if (inviteEmail) { setInviteEmail(""); setInviteName(""); }
                    setNewProjectCustomerUserId(id);
                  }}
                />

                {/* 선택된 기존 계정 표시 */}
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

                {/* 초대 예정 배지 */}
                {inviteEmail && (
                  <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", background: "#eff6ff", borderRadius: 6, border: "1px solid #bfdbfe" }}>
                    <span style={{ fontSize: 13, color: "#2563eb" }}>✉</span>
                    <span style={{ fontSize: 12, color: "#1d4ed8", flex: 1 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, background: "#dbeafe", color: "#1e40af", borderRadius: 4, padding: "1px 5px", marginRight: 5 }}>초대 예정</span>
                      <strong>{inviteName || inviteEmail}</strong>
                      {inviteName ? <span style={{ color: "#6b7280" }}> ({inviteEmail})</span> : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setInviteEmail(""); setInviteName(""); setInviteError(""); }}
                      style={{ fontSize: 12, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 4, lineHeight: 1 }}
                      title="초대 예정 취소"
                    >✕</button>
                    <button
                      type="button"
                      onClick={() => { setInviteError(""); setShowInviteModal(true); }}
                      style={{ fontSize: 11, color: "#2563eb", background: "none", border: "none", cursor: "pointer", padding: "2px 6px", fontWeight: 600, borderRadius: 4, textDecoration: "underline" }}
                    >수정</button>
                  </div>
                )}

                {/* + 고객 계정 초대 버튼 — 항상 표시 */}
                <div style={{ marginTop: 8, borderTop: "1px dashed #e5e7eb", paddingTop: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      // 기존 계정 선택 해제 후 초대 모달 열기
                      setNewProjectCustomerUserId(null);
                      setInviteError("");
                      setShowInviteModal(true);
                    }}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      fontSize: 13, fontWeight: 700, color: "#2563eb",
                      background: "#eff6ff", border: "1.5px solid #bfdbfe",
                      borderRadius: 8, cursor: "pointer", padding: "7px 14px",
                      transition: "background 0.15s",
                    }}
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
        <div style={{
          position: "fixed", inset: 0, zIndex: 500,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.35)",
        }} onClick={e => { if (e.target === e.currentTarget) setShowInviteModal(false); }}>
          <div style={{
            background: "#fff", borderRadius: 14, padding: "28px 28px 24px",
            width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
          }}>
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
                <input
                  value={inviteName}
                  onChange={e => setInviteName(e.target.value)}
                  placeholder="고객 이름"
                  style={{ ...inputStyle }}
                />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>
                  이메일 <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="customer@example.com"
                  style={{ ...inputStyle }}
                  onKeyDown={e => e.key === "Enter" && handleInviteFormConfirm()}
                />
              </div>
              {inviteError && (
                <p style={{ margin: 0, fontSize: 12, color: "#dc2626", background: "#fef2f2", padding: "7px 10px", borderRadius: 6 }}>
                  {inviteError}
                </p>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <GhostBtn onClick={() => { setShowInviteModal(false); setInviteError(""); }}>취소</GhostBtn>
              <PrimaryBtn onClick={handleInviteFormConfirm} style={{ padding: "9px 20px" }}>
                초대 추가
              </PrimaryBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── 프로젝트 탭 ── */}
      <Section title={`전체 프로젝트 (${projects.length})`} action={
        <div style={{ display: "flex", gap: 8 }}>
          {hasPerm("project.create") && <PrimaryBtn onClick={() => { fetchModalData(); setShowCreateProject(true); }} style={{ fontSize: 13, padding: "7px 14px" }}>+ 프로젝트 등록</PrimaryBtn>}
          <GhostBtn onClick={handleExportProjects} style={{ fontSize: 13, padding: "7px 14px" }}>⬇ CSV 내보내기</GhostBtn>
        </div>
      }>
        {/* ══════════════════════════════════════════
             필터 영역 (sticky)
        ══════════════════════════════════════════ */}
        <div style={{ position: "sticky", top: 0, zIndex: 30, background: "#fff", paddingBottom: 8, marginBottom: 18 }}>

          {/* ── 검색 바 ── */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
            <input
              value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
              placeholder="제목, 이메일, 거래처, 담당자 검색..."
              style={{ ...inputStyle, maxWidth: 320, flex: "1 1 180px", padding: "7px 11px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchProjects()}
            />
            <PrimaryBtn onClick={fetchProjects} disabled={loading} style={{ padding: "7px 14px", fontSize: 13 }}>
              {loading ? "검색 중..." : "검색"}
            </PrimaryBtn>
            {(projectSearch || dateFrom || dateTo || assignedAdminFilter !== "all" || projectFilter !== "all" || projectFinancialFilter !== "all" || projectQuickFilter !== "all" || projectQuoteTypeFilter !== "all" || projectBillingTypeFilter !== "all" || projectPaymentDueDateFrom || projectPaymentDueDateTo || projectCompanyIdFilter) && (
              <button
                onClick={() => { setProjectSearch(""); setDateFrom(""); setDateTo(""); setAssignedAdminFilter("all"); setProjectFilter("all"); setProjectFinancialFilter("all"); setProjectQuickFilter("all"); setProjectQuoteTypeFilter("all"); setProjectBillingTypeFilter("all"); setProjectPaymentDueDateFrom(""); setProjectPaymentDueDateTo(""); setProjectCompanyIdFilter(""); setProjectPage(1); }}
                style={{ padding: "7px 12px", fontSize: 12, fontWeight: 700, background: "#fef2f2", color: "#dc2626", border: "1.5px solid #fca5a5", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                ✕ 필터 초기화
              </button>
            )}
            <GhostBtn onClick={() => setShowAdvancedFilter(v => !v)} style={{ marginLeft: "auto", padding: "7px 12px", fontSize: 12 }}>
              {showAdvancedFilter ? "상세필터 접기 ▲" : "⚙ 상세필터 ▼"}
            </GhostBtn>
          </div>

          {/* ── 업무 상태 필터 카드 ── */}
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "7px 12px", marginBottom: 5 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", letterSpacing: "0.3px", minWidth: 44, marginRight: 2 }}>업무 상태</span>
              <div style={{ width: 1, height: 14, background: "#d1d5db", marginRight: 4 }} />
              <FilterPill label="전체" active={projectFilter === "all"} onClick={() => { setProjectFilter("all"); setProjectPage(1); }} />
              {ALL_PROJECT_STATUSES.map(s => (
                <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                  active={projectFilter === s} onClick={() => { setProjectFilter(s); setProjectPage(1); }} />
              ))}
            </div>
          </div>

          {/* ── 상세 필터 패널 ── */}
          <div style={{ overflow: "hidden", maxHeight: showAdvancedFilter ? "400px" : "0", transition: "max-height 320ms cubic-bezier(0.22, 1, 0.36, 1)" }}>
          {showAdvancedFilter && (
            <div style={{ marginTop: 4, borderTop: "1px solid #f0f0f0", paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
              {/* 3열 그리드: 담당 / 거래처 / 재무 상태 / 견적 유형 / 청구 방식 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {/* [담당] */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#9ca3af", marginBottom: 4 }}>담당</div>
                  <ClickSelect
                    value={assignedAdminFilter}
                    onChange={setAssignedAdminFilter}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 11 }}
                    options={[
                      { value: "all", label: "전체 담당자" },
                      ...adminUsers.map(a => ({ value: String(a.id), label: a.email })),
                    ]}
                  />
                </div>
                {/* [거래처] */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#9ca3af", marginBottom: 4 }}>거래처</div>
                  <ClickSelect
                    value={projectCompanyIdFilter}
                    onChange={v => { setProjectCompanyIdFilter(v); setProjectPage(1); }}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 11 }}
                    options={[
                      { value: "", label: "전체 거래처" },
                      ...companies.map(c => ({ value: String(c.id), label: c.name })),
                    ]}
                  />
                </div>
                {/* [재무 상태] */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#9ca3af", marginBottom: 4 }}>재무 상태</div>
                  <ClickSelect
                    value={
                      projectQuickFilter === "prepaid_deduction" ? "prepaid_used" :
                      projectQuickFilter === "has_prepaid_balance" ? "balance" :
                      projectQuickFilter === "accumulated_in_progress" ? "ongoing" :
                      projectFinancialFilter
                    }
                    onChange={v => {
                      if (v === "prepaid_used") { setProjectQuickFilter("prepaid_deduction"); setProjectFinancialFilter("all"); setProjectPage(1); }
                      else if (v === "balance") { setProjectQuickFilter("has_prepaid_balance"); setProjectFinancialFilter("all"); setProjectPage(1); }
                      else if (v === "ongoing") { setProjectQuickFilter("accumulated_in_progress"); setProjectFinancialFilter("all"); setProjectPage(1); }
                      else { setProjectFinancialFilter(v); setProjectQuickFilter("all"); setProjectPage(1); }
                    }}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 11 }}
                    options={[
                      { value: "all", label: "전체" }, { value: "unbilled", label: "미청구" },
                      { value: "billed", label: "청구 완료" }, { value: "receivable", label: "미수금" },
                      { value: "paid", label: "입금 완료" }, { value: "prepaid_used", label: "선입금 차감" },
                      { value: "balance", label: "잔액 남음" }, { value: "ongoing", label: "누적 진행중" },
                    ]}
                  />
                </div>
                {/* [견적 유형] */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#9ca3af", marginBottom: 4 }}>견적 유형</div>
                  <ClickSelect
                    value={projectQuoteTypeFilter}
                    onChange={v => { setProjectQuoteTypeFilter(v); setProjectPage(1); }}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 11 }}
                    options={[
                      { value: "all", label: "전체" }, { value: "b2b_standard", label: "B2B 표준" },
                      { value: "b2c_prepaid", label: "선입금" }, { value: "prepaid_deduction", label: "선입금 차감" },
                      { value: "accumulated_batch", label: "누적 견적" },
                    ]}
                  />
                </div>
                {/* [청구 방식] */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#9ca3af", marginBottom: 4 }}>청구 방식</div>
                  <ClickSelect
                    value={projectBillingTypeFilter}
                    onChange={v => { setProjectBillingTypeFilter(v); setProjectPage(1); }}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 11 }}
                    options={[
                      { value: "all", label: "전체" }, { value: "postpaid_per_project", label: "건별 후불" },
                      { value: "monthly_billing", label: "누적 청구" }, { value: "prepaid_wallet", label: "선입금 차감" },
                      { value: "prepay_upfront", label: "선결제(카드/현금)" },
                    ]}
                  />
                </div>
              </div>
              {/* 날짜 행: 생성일 / 입금 예정일 */}
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#9ca3af", marginBottom: 4 }}>생성일</div>
                  <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: "3px 6px", fontSize: 11 }} />
                    <span style={{ color: "#d1d5db", fontSize: 10 }}>~</span>
                    <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                      style={{ ...inputStyle, flex: 1, padding: "3px 6px", fontSize: 11 }} />
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 500, color: "#9ca3af", marginBottom: 4 }}>입금 예정일</div>
                  <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                    <input type="date" value={projectPaymentDueDateFrom} onChange={e => { setProjectPaymentDueDateFrom(e.target.value); setProjectPage(1); }}
                      style={{ ...inputStyle, flex: 1, padding: "3px 6px", fontSize: 11 }} />
                    <span style={{ color: "#d1d5db", fontSize: 10 }}>~</span>
                    <input type="date" value={projectPaymentDueDateTo} onChange={e => { setProjectPaymentDueDateTo(e.target.value); setProjectPage(1); }}
                      style={{ ...inputStyle, flex: 1, padding: "3px 6px", fontSize: 11 }} />
                  </div>
                </div>
              </div>
            </div>
          )}
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
          return (
            <>
              <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "#f8fafc" }}>
                        {["ID","프로젝트","거래처 · 담당자","상태 / 재무","등록일","액션"].map(h => (
                          <th key={h} style={{ ...tableTh, background: "transparent", fontSize: 11, letterSpacing: "0.2px" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pagedProjects.map(p => {
                        type SectionKey = "info"|"finance"|"work"|"settlement"|"history";
                        const ACTION_MAP: Record<string, { label: string; section: SectionKey; color: string; bg: string }> = {
                          created:     { label: "견적 생성",     section: "finance",    color: "#fff",    bg: "#2563eb" },
                          quoted:      { label: "견적 확인",     section: "finance",    color: "#fff",    bg: "#2563eb" },
                          approved:    { label: "통번역사 배정", section: "work",       color: "#fff",    bg: "#7c3aed" },
                          matched:     { label: "배정 관리",    section: "work",       color: "#fff",    bg: "#7c3aed" },
                          in_progress: { label: "작업 보기",     section: "work",       color: "#fff",    bg: "#6d28d9" },
                          completed:   { label: "정산 확인",     section: "settlement", color: "#fff",    bg: "#059669" },
                          cancelled:   { label: "상세보기",      section: "info",       color: "#6b7280", bg: "#f3f4f6" },
                        };
                        const action = ACTION_MAP[p.status] ?? { label: "상세보기", section: "info" as SectionKey, color: "#6b7280", bg: "#f3f4f6" };
                        const qt = (p as any).quoteType as string | undefined;
                        const QUOTE_STYLE: Record<string, { label: string; bg: string; color: string }> = {
                          b2b_standard:     { label: "B2B",  bg: "#f1f5f9", color: "#475569" },
                          b2c_prepaid:      { label: "선입금", bg: "#fef3c7", color: "#92400e" },
                          prepaid_deduction:{ label: "차감",  bg: "#ede9fe", color: "#5b21b6" },
                          accumulated_batch:{ label: "누적",  bg: "#dbeafe", color: "#1e40af" },
                        };
                        const qs = qt ? QUOTE_STYLE[qt] : null;
                        const chipStyle = (borderColor: string, color: string): React.CSSProperties => ({
                          display: "inline-block", padding: "2px 7px", borderRadius: 10,
                          fontSize: 11, fontWeight: 500, lineHeight: "18px",
                          whiteSpace: "nowrap", background: "transparent",
                          border: `1px solid ${borderColor}`, color,
                        });
                        return (
                          <tr key={p.id}
                            onClick={() => openDetail(p.id)}
                            style={{ cursor: "pointer", transition: "background 0.1s" }}
                            onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
                            onMouseLeave={e => (e.currentTarget.style.background = "")}>

                            {/* ID */}
                            <td style={{ ...tableTd, color: "#d1d5db", fontSize: 11, width: 40 }}>#{p.id}</td>

                            {/* 프로젝트 제목 + 이메일 */}
                            <td style={{ ...tableTd, maxWidth: 240 }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 600, color: "#111827" }}>{p.title}</div>
                              {p.customerEmail && <div style={{ fontSize: 11, color: "#c0c8d4", marginTop: 1 }}>{p.customerEmail}</div>}
                            </td>

                            {/* 의뢰/청구/납부 구조 조건부 표시 */}
                            {(() => {
                              const pp = p as any;
                              const reqId = pp.requestingCompanyId ?? p.companyId;
                              const billId = pp.billingCompanyId ?? reqId;
                              const payId = pp.payerCompanyId ?? reqId;
                              const isComplex = (billId && billId !== reqId) || (payId && payId !== reqId);

                              const reqName = pp.requestingCompanyName ?? p.companyName;
                              const billName = pp.billingCompanyName ?? reqName;
                              const payName = pp.payerCompanyName ?? reqName;
                              const contact = pp.contactName as string | null;

                              if (!isComplex) {
                                const baseName = reqName ?? p.companyName ?? "-";
                                return (
                                  <td style={{ ...tableTd, fontSize: 12, maxWidth: 180 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", overflow: "hidden" }}>
                                      <span style={{ color: "#4b5563", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{baseName}</span>
                                      {pp.divisionName && (
                                        <span style={{ flexShrink: 0, background: "#ede9fe", color: "#7c3aed", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                                          {pp.divisionName}
                                        </span>
                                      )}
                                    </div>
                                    {contact && (
                                      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {contact}
                                      </div>
                                    )}
                                  </td>
                                );
                              }

                              const reqDisplay = pp.divisionName
                                ? <><span style={{ fontWeight: 500, color: "#374151" }}>{reqName}</span><span style={{ marginLeft: 4, background: "#ede9fe", color: "#7c3aed", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>{pp.divisionName}</span></>
                                : <span style={{ fontWeight: 500, color: "#374151" }}>{reqName ?? "-"}</span>;

                              return (
                                <td style={{ ...tableTd, fontSize: 11, maxWidth: 200 }}>
                                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {reqDisplay}
                                  </div>
                                  {contact && (
                                    <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {contact}
                                    </div>
                                  )}
                                  {billId && billId !== reqId && (
                                    <div style={{ fontSize: 10, color: "#0369a1", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      청구: {billName}
                                    </div>
                                  )}
                                  {payId && payId !== reqId && (
                                    <div style={{ fontSize: 10, color: "#059669", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      납부: {payName}
                                    </div>
                                  )}
                                </td>
                              );
                            })()}

                            {/* 업무 상태 / 재무 상태 */}
                            <td style={{ ...tableTd, minWidth: 200 }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                                  <StatusBadge status={p.status} />
                                  {qs && <span style={chipStyle(qs.color + "66", qs.color)}>{qs.label}</span>}
                                </div>
                                {(() => {
                                  const fs = (p as any).financialStatus as string ?? "unbilled";
                                  const fStyle = FINANCIAL_STATUS_STYLE[fs] ?? { background: "#f3f4f6", color: "#6b7280" };
                                  const fLabel = FINANCIAL_STATUS_LABEL[fs] ?? fs;
                                  return (
                                    <span style={{ ...fStyle, fontSize: 10, fontWeight: 700, borderRadius: 6, padding: "2px 7px", display: "inline-block", width: "fit-content" }}>
                                      {fLabel}
                                    </span>
                                  );
                                })()}
                              </div>
                            </td>

                            {/* 등록일 */}
                            <td style={{ ...tableTd, fontSize: 11, color: "#c0c8d4", whiteSpace: "nowrap" }}>
                              {new Date(p.createdAt).toLocaleDateString("ko-KR")}
                            </td>

                            {/* 액션 */}
                            <td style={{ ...tableTd, width: 155 }} onClick={e => e.stopPropagation()}>
                              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                <button
                                  title="컨트롤타워 — 판매·수행·결제 종합"
                                  onClick={() => openDetail(p.id, "control-tower")}
                                  style={{ background: "#eef2ff", color: "#4f46e5", border: "1px solid #c7d2fe", borderRadius: 6, padding: "4px 8px", fontSize: 13, cursor: "pointer", lineHeight: 1 }}>
                                  🗼
                                </button>
                                <button
                                  onClick={() => openDetail(p.id, action.section)}
                                  style={{ background: action.bg, color: action.color, border: "none", borderRadius: 6, padding: "4px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
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
                                    style={{ background: "transparent", color: "#ef4444", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }}>
                                    취소
                                  </button>
                                )}
                                {user.role === "admin" && (
                                  <button
                                    onClick={() => { setDeleteConfirmProject({ id: p.id, title: p.title }); setDeleteConfirmInput(""); }}
                                    style={{ background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer", fontWeight: 700, whiteSpace: "nowrap" }}>
                                    완전 삭제
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
