import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ADMIN_NAV_GROUPS, ADMIN_PAGE_TITLE, STAFF_DEFAULT_PERMS } from '../config/adminNav';
import {
  api, User, AdminProject, AdminPayment, AdminTask, AdminSettlement, AdminUser,
  AdminCustomer, AdminContact, Company, Contact, Product, ProductOption, BoardPost, TranslatorProfile,
  TranslatorListItem, TranslatorRate, NoteEntry, Communication,
  STATUS_LABEL, FEEDBACK_TAGS, COMM_TYPE_LABEL, COMM_TYPE_COLOR,
  PROJECT_STATUS_TRANSITIONS, getActionLabel, BOARD_CATEGORY_LABEL, AVAILABILITY_LABEL,
  ALL_PROJECT_STATUSES, ALL_FINANCIAL_STATUSES, ALL_PAYMENT_STATUSES, ALL_SETTLEMENT_STATUSES,
  PRODUCT_MAIN_CATEGORIES, PRODUCT_SUB_CATEGORIES, PRODUCT_UNITS, PRODUCT_OPTION_TYPES,
  FINANCIAL_STATUS_LABEL, FINANCIAL_STATUS_STYLE,
  VENDOR_TYPE_LABELS, VENDOR_TYPE_OPTIONS,
} from '../lib/constants';
import { StatusBadge, RoleBadge, Toast, Card, PrimaryBtn, GhostBtn, FilterPill, ClickSelect } from '../components/ui';
import { formatPhone } from '../lib/utils';
import { LogModal } from '../components/admin/LogModal';
import { DraggableModal } from '../components/admin/DraggableModal';
import { ContactDetailModal } from '../components/admin/ContactDetailModal';
import { CustomerDetailModal } from '../components/admin/CustomerDetailModal';
import { TranslatorProfileModal } from '../components/admin/TranslatorProfileModal';
import { TranslatorDetailModal } from '../components/admin/TranslatorDetailModal';
import { TranslatorCreateModal } from '../components/admin/TranslatorCreateModal';
import { ProjectDetailModal } from '../components/admin/ProjectDetailModal';
import { PrepaidLedgerModal } from '../components/admin/PrepaidLedgerModal';
import { ProductManagementTab } from '../components/admin/ProductManagementTab';
import { ProjectManagementTab } from '../components/admin/ProjectManagementTab';
import { CompanyManagementTab } from '../components/admin/CompanyManagementTab';
import { DataLayerTab } from '../components/admin/DataLayerTab';
import { LanguageServiceDataTab } from '../components/admin/LanguageServiceDataTab';
import { InsightManagementTab } from '../components/admin/InsightManagementTab';
import { InsightAnalyticsTab } from '../components/admin/InsightAnalyticsTab';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6,
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

type SSItem = { id: number; label: string; sub?: string };
/**
 * SearchableSelect — 검색형 드롭다운
 * 동작: 클릭/포커스로 열림, 외부 mousedown·ESC·선택 완료 시만 닫힘
 * 키보드: ↑/↓ 탐색, Enter 선택, ESC 닫기
 */
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

  // 외부 클릭(mousedown) 시에만 닫힘 — blur 이벤트로 닫히지 않음
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
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

  // 하이라이트 항목 자동 스크롤
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
    <div ref={containerRef} style={{ position: "relative" }}>
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
          onMouseDown={e => e.stopPropagation()}
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

export function AdminDashboard({ user, token, permissions = [], onLogout }: { user: User; token: string; permissions?: string[]; onLogout?: () => void }) {
  // RBAC: admin without roleId = full access (backward compat)
  // staff without roleId = STAFF_DEFAULT_PERMS + 서버에서 받은 permissions
  const hasPerm = (key: string | undefined): boolean => {
    if (!key) return true;
    if (user.role === "admin" && !user.roleId) return true;
    if (user.role === "staff" && !user.roleId && STAFF_DEFAULT_PERMS.includes(key)) return true;
    return permissions.includes(key);
  };

  const [adminTab, setAdminTab] = useState<"dashboard"|"projects"|"payments"|"tasks"|"settlements"|"users"|"customers"|"companies"|"contacts"|"products"|"board"|"translators"|"test"|"prepaid"|"billing"|"roles"|"permissions"|"settings"|"data-layer"|"language-service"|"insight-management"|"insight-analytics">("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // 섹션 기본 열림/닫힘 정책: customer·project는 기본 열림, 나머지 기본 닫힘
  const SIDEBAR_DEFAULT_OPEN: Record<string, boolean> = {
    customer: true, project: true,
    resource: false, finance: false, data: false, system: false,
  };
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try {
      // v2: 버전 키로 구버전 기본값(전체 열림) 무효화
      const ver = localStorage.getItem("admin_sidebar_sections_ver");
      const saved = localStorage.getItem("admin_sidebar_sections");
      if (ver === "2" && saved) return JSON.parse(saved);
    } catch {}
    // 첫 방문 또는 구버전: 새 기본값 적용
    return SIDEBAR_DEFAULT_OPEN;
  });
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [settlements, setSettlements] = useState<AdminSettlement[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);

  // 접속 통계
  type ActivityStats = { summary: { today: number; week: number; month: number; year: number; currentlyOnline: number }; loginCount: number; uniqueUsers: number; byRole: { roleType: string; count: number }[] };
  const [activityStats, setActivityStats] = useState<ActivityStats | null>(null);
  const [activityPeriod, setActivityPeriod] = useState<"today"|"week"|"month"|"year">("today");
  type UserStat = { userId: number; loginCount: number; totalActiveMinutes: number; lastLoginAt: string | null; user: { name: string | null; email: string; role: string } | null };
  const [userStats, setUserStats] = useState<UserStat[]>([]);
  const [showActivityStats, setShowActivityStats] = useState(false);
  const [customersLoading, setCustomersLoading] = useState(false);


  // 선입금 계정 (원장 방식)
  type PrepaidAccount = { id: number; companyId: number; companyName: string; initialAmount: number; currentBalance: number; status: string; note: string | null; depositDate: string | null; createdAt: string };
  const [prepaidAccounts, setPrepaidAccounts] = useState<PrepaidAccount[]>([]);
  const [prepaidLoading, setPrepaidLoading] = useState(false);
  const [selectedPrepaidAccountId, setSelectedPrepaidAccountId] = useState<number | null>(null);
  const [showCreatePrepaidForm, setShowCreatePrepaidForm] = useState(false);
  const [createPrepaidForm, setCreatePrepaidForm] = useState({ companyId: "", initialAmount: "", note: "", depositDate: new Date().toISOString().slice(0, 10) });
  const [savingPrepaid, setSavingPrepaid] = useState(false);
  const [prepaidCompanyFilter, setPrepaidCompanyFilter] = useState("");

  // 누적 청구 탭
  type BillingBatch = { id: number; companyId: number; companyName: string | null; periodStart: string | null; periodEnd: string | null; status: string; totalAmount: number; quoteId: number | null; quoteStatus: string | null; itemCount: number; createdAt: string };
  const [billingBatches, setBillingBatches] = useState<BillingBatch[]>([]);
  const [billingBatchesLoading, setBillingBatchesLoading] = useState(false);
  const [billingBatchStatusFilter, setBillingBatchStatusFilter] = useState<string>("all");

  // other filters
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  const [settlementFilter, setSettlementFilter] = useState<string>("all");
  const [settlementMonthFilter, setSettlementMonthFilter] = useState<string>("all");
  const [paidDateFrom, setPaidDateFrom] = useState<string>("");
  const [paidDateTo, setPaidDateTo] = useState<string>("");

  // customer management
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerModal, setCustomerModal] = useState<number | null>(null);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ companyName: "", contactName: "", email: "", phone: "" });
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  // user management
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<string>("all");
  const [roleChanging, setRoleChanging] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [resetPwUserId, setResetPwUserId] = useState<number | null>(null);
  const [resetPwInput, setResetPwInput] = useState("");
  const [resetPwLoading, setResetPwLoading] = useState(false);

  // 내부 직원 등록
  const [showCreateStaff, setShowCreateStaff] = useState(false);
  const [newStaff, setNewStaff] = useState({ name: "", email: "", password: "", department: "", jobTitle: "", role: "staff" as "admin" | "staff", isActive: true });
  const [creatingStaff, setCreatingStaff] = useState(false);

  // ── RBAC role management state ──────────────────────────────
  type RbacRole = { id: number; name: string; description: string | null; isSystem: boolean; createdAt: string; permissionCount: number; permissions: string[] };
  type RbacPerm = { key: string; name: string; category: "menu" | "action" };
  const [rbacRoles, setRbacRoles] = useState<RbacRole[]>([]);
  const [rbacAllPerms, setRbacAllPerms] = useState<RbacPerm[]>([]);
  const [rbacSelectedRole, setRbacSelectedRole] = useState<RbacRole | null>(null);
  const [rbacRolePerms, setRbacRolePerms] = useState<Set<string>>(new Set());
  const [rbacRoleName, setRbacRoleName] = useState("");
  const [rbacRoleDesc, setRbacRoleDesc] = useState("");
  const [rbacCreating, setRbacCreating] = useState(false);
  const [rbacSaving, setRbacSaving] = useState(false);
  const [rbacUserRoleMap, setRbacUserRoleMap] = useState<Map<number, number | null>>(new Map());

  // companies state (contacts 탭의 거래처 검색 드롭다운에 사용)
  const [companies, setCompanies] = useState<Company[]>([]);


  const [boardPosts, setBoardPosts] = useState<BoardPost[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardCategory, setBoardCategory] = useState<string>("all");
  const [boardPostModal, setBoardPostModal] = useState<BoardPost | null>(null);
  const [showBoardForm, setShowBoardForm] = useState(false);
  const [boardForm, setBoardForm] = useState({ category: "notice", title: "", content: "", pinned: false, visibleToAll: false });
  const [savingBoard, setSavingBoard] = useState(false);

  // translator profile modal
  const [translatorProfileModal, setTranslatorProfileModal] = useState<{ userId: number; email: string } | null>(null);

  // contacts tab state
  const [contacts, setContacts] = useState<AdminContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contactModal, setContactModal] = useState<number | null>(null);
  const [showCreateContactModal, setShowCreateContactModal] = useState(false);
  const emptyNewContactForm = { companyId: null as number | null, name: "", mobile: "", email: "", department: "", position: "", officePhone: "", memo: "", isPrimary: false, isQuoteContact: false, isBillingContact: false, isActive: true };
  const [newContactForm, setNewContactForm] = useState(emptyNewContactForm);
  const [newContactErrors, setNewContactErrors] = useState<Record<string, string>>({});
  const [savingNewContact, setSavingNewContact] = useState(false);
  const [companySearchQuery, setCompanySearchQuery] = useState("");

  // translators tab state
  const [translatorList, setTranslatorList] = useState<TranslatorListItem[]>([]);
  const [translatorsLoading, setTranslatorsLoading] = useState(false);
  const [translatorSearch, setTranslatorSearch] = useState("");
  const [translatorLangFilter, setTranslatorLangFilter] = useState("");
  const [translatorStatusFilter, setTranslatorStatusFilter] = useState("all");
  const [translatorGradeFilter, setTranslatorGradeFilter] = useState("all");
  const [translatorRatingFilter, setTranslatorRatingFilter] = useState("");
  const [translatorDetailModal, setTranslatorDetailModal] = useState<{ userId: number; email: string } | null>(null);
  const [showTranslatorCreateModal, setShowTranslatorCreateModal] = useState(false);

  // 운영 테스트 시나리오
  type ScenarioStep = { step: number; name: string; status: "ok"|"error"|"skipped"; detail: string; data?: Record<string, unknown> };
  type ScenarioResult = { projectId: number|null; startedAt: string; finishedAt: string; steps: ScenarioStep[]; summary: { total: number; ok: number; error: number; skipped: number } };
  const [scenarioRunning, setScenarioRunning] = useState(false);
  const [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null);
  const [scenarioAmount, setScenarioAmount] = useState("500000");
  const [scenarioRatio, setScenarioRatio] = useState("0.6");
  const [scenarioHistory, setScenarioHistory] = useState<Array<{ id: number; title: string; status: string; createdAt: string }>>([]);
  const [scenarioHistoryLoading, setScenarioHistoryLoading] = useState(false);
  // 실제 운영 데이터 셀렉터
  const [realData, setRealData] = useState<{ companies: {id:number;name:string}[]; contacts: {id:number;name:string;companyId:number|null}[]; translators: {id:number;email:string}[] } | null>(null);
  const [scenarioCompanyId, setScenarioCompanyId] = useState<string>("");
  const [scenarioContactId, setScenarioContactId] = useState<string>("");
  // UX 피드백
  const FEEDBACK_TAGS = [
    { value: "general", label: "일반", color: "#6b7280", bg: "#f3f4f6" },
    { value: "bug", label: "🐛 버그", color: "#991b1b", bg: "#fef2f2" },
    { value: "ux", label: "🎨 UX", color: "#1d4ed8", bg: "#eff6ff" },
    { value: "idea", label: "💡 아이디어", color: "#065f46", bg: "#f0fdf4" },
    { value: "urgent", label: "🔥 긴급", color: "#92400e", bg: "#fffbeb" },
  ] as const;
  type FeedbackTag = "general" | "bug" | "ux" | "idea" | "urgent";
  const [feedbackList, setFeedbackList] = useState<Array<{ id: number; content: string; tag: string | null; createdAt: string; adminEmail: string | null }>>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackInput, setFeedbackInput] = useState("");
  const [feedbackTag, setFeedbackTag] = useState<FeedbackTag>("general");
  const [feedbackTagFilter, setFeedbackTagFilter] = useState<string>("all");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);


  // modals
  type DetailModalState = { id: number; initialSection?: "info"|"finance"|"work"|"settlement"|"history" };
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);
  const openDetail = (id: number, initialSection?: DetailModalState["initialSection"]) => setDetailModal({ id, initialSection });
  const [paying, setPaying] = useState<number | null>(null);
  const [approving, setApproving] = useState<number | null>(null);
  const [selectedSettlements, setSelectedSettlements] = useState<Set<number>>(new Set());
  const [batchPaying, setBatchPaying] = useState(false);
  const [editingMemo, setEditingMemo] = useState<{ id: number; value: string } | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, pmRes, tRes, sRes, auRes] = await Promise.all([
        fetch(api("/api/admin/projects"), { headers: authHeaders }),
        fetch(api("/api/admin/payments"), { headers: authHeaders }),
        fetch(api("/api/admin/tasks"), { headers: authHeaders }),
        fetch(api("/api/admin/settlements"), { headers: authHeaders }),
        fetch(api("/api/admin/users?role=admin"), { headers: authHeaders }),
      ]);
      const [pData, pmData, tData, sData, auData] = await Promise.all([pRes.json(), pmRes.json(), tRes.json(), sRes.json(), auRes.json()]);
      if (pRes.ok) setProjects(Array.isArray(pData) ? pData : []);
      if (pmRes.ok) setPayments(Array.isArray(pmData) ? pmData : []);
      if (tRes.ok) setTasks(Array.isArray(tData) ? tData : []);
      if (sRes.ok) setSettlements(Array.isArray(sData) ? sData : []);
      if (auRes.ok) setAdminUsers(Array.isArray(auData) ? auData : []);
    } catch { setToast("오류: 데이터 불러오기 실패"); }
    finally { setLoading(false); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchPrepaidAccounts = useCallback(async () => {
    setPrepaidLoading(true);
    try {
      const res = await fetch(api("/api/admin/prepaid-accounts"), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setPrepaidAccounts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 선입금 계정 조회 실패"); }
    finally { setPrepaidLoading(false); }
  }, [token]);

  const handleCreatePrepaidAccount = async () => {
    const amt = Number(createPrepaidForm.initialAmount.replace(/,/g, ""));
    if (!createPrepaidForm.companyId || !amt || amt <= 0) { setToast("거래처와 입금액을 확인하세요."); return; }
    setSavingPrepaid(true);
    try {
      const res = await fetch(api("/api/admin/prepaid-accounts"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: Number(createPrepaidForm.companyId), initialAmount: amt, note: createPrepaidForm.note || undefined, depositDate: createPrepaidForm.depositDate }),
      });
      if (res.ok) {
        setShowCreatePrepaidForm(false);
        setCreatePrepaidForm({ companyId: "", initialAmount: "", note: "", depositDate: new Date().toISOString().slice(0, 10) });
        setToast("선입금 계정이 생성되었습니다.");
        await fetchPrepaidAccounts();
      } else {
        const d = await res.json();
        setToast(`오류: ${d.error ?? "생성 실패"}`);
      }
    } finally { setSavingPrepaid(false); }
  };

  const fetchBillingBatches = useCallback(async () => {
    setBillingBatchesLoading(true);
    try {
      const params = new URLSearchParams();
      if (billingBatchStatusFilter !== "all") params.set("status", billingBatchStatusFilter);
      const res = await fetch(api(`/api/admin/billing-batches${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setBillingBatches(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 누적 청구 조회 실패"); }
    finally { setBillingBatchesLoading(false); }
  }, [token, billingBatchStatusFilter]);

  const fetchUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const params = new URLSearchParams();
      if (userSearch.trim()) params.set("search", userSearch.trim());
      if (userRoleFilter !== "all") params.set("roleType", userRoleFilter);
      const res = await fetch(api(`/api/admin/users${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setUsers(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 사용자 조회 실패"); }
    finally { setUsersLoading(false); }
  }, [token, userSearch, userRoleFilter]);

  const fetchCustomers = useCallback(async () => {
    setCustomersLoading(true);
    try {
      const params = new URLSearchParams();
      if (customerSearch.trim()) params.set("search", customerSearch.trim());
      const res = await fetch(api(`/api/admin/customers${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setCustomers(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 고객 조회 실패"); }
    finally { setCustomersLoading(false); }
  }, [token, customerSearch]);

  const handleCreateCustomer = async () => {
    if (!newCustomer.companyName.trim() || !newCustomer.contactName.trim() || !newCustomer.email.trim()) {
      setToast("회사명, 담당자명, 이메일은 필수입니다."); return;
    }
    setCreatingCustomer(true);
    try {
      const res = await fetch(api("/api/admin/customers"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(newCustomer),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("고객이 등록되었습니다.");
      setNewCustomer({ companyName: "", contactName: "", email: "", phone: "" });
      setShowCreateCustomer(false);
      await fetchCustomers();
    } catch { setToast("오류: 고객 등록 실패"); }
    finally { setCreatingCustomer(false); }
  };

  const fetchCompanies = useCallback(async () => {
    try {
      const res = await fetch(api("/api/admin/companies"), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setCompanies(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 거래처 조회 실패"); }
  }, [token]);


  const fetchBoard = useCallback(async () => {
    setBoardLoading(true);
    try {
      const params = new URLSearchParams();
      if (boardCategory !== "all") params.set("category", boardCategory);
      const res = await fetch(api(`/api/admin/board${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setBoardPosts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 게시판 조회 실패"); }
    finally { setBoardLoading(false); }
  }, [token, boardCategory]);

  const fetchContacts = useCallback(async () => {
    setContactsLoading(true);
    try {
      const params = new URLSearchParams();
      if (contactSearch.trim()) params.set("keyword", contactSearch.trim());
      const res = await fetch(api(`/api/admin/contacts${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setContacts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 담당자 조회 실패"); }
    finally { setContactsLoading(false); }
  }, [token, contactSearch]);

  const handleCreateContact = async () => {
    const errs: Record<string, string> = {};
    if (!newContactForm.companyId) errs.companyId = "거래처를 선택해주세요.";
    if (!newContactForm.name.trim()) errs.name = "담당자명은 필수입니다.";
    if (!newContactForm.mobile.trim() && !newContactForm.email.trim()) errs.mobile = "휴대폰 또는 이메일 중 하나 이상 입력해주세요.";
    if (newContactForm.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newContactForm.email.trim())) errs.email = "이메일 형식이 올바르지 않습니다.";
    setNewContactErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSavingNewContact(true);
    try {
      const res = await fetch(api("/api/admin/contacts"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(newContactForm),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setShowCreateContactModal(false);
      setNewContactForm(emptyNewContactForm);
      setNewContactErrors({});
      setCompanySearchQuery("");
      await fetchContacts();
      setToast("담당자가 등록되었습니다.");
    } catch { setToast("오류: 담당자 등록 실패"); }
    finally { setSavingNewContact(false); }
  };

  const fetchTranslators = useCallback(async () => {
    setTranslatorsLoading(true);
    try {
      const params = new URLSearchParams();
      if (translatorSearch.trim()) params.set("search", translatorSearch.trim());
      if (translatorLangFilter.trim()) params.set("languagePair", translatorLangFilter.trim());
      if (translatorStatusFilter !== "all") params.set("status", translatorStatusFilter);
      if (translatorGradeFilter !== "all") params.set("grade", translatorGradeFilter);
      if (translatorRatingFilter.trim()) params.set("minRating", translatorRatingFilter.trim());
      const res = await fetch(api(`/api/admin/translators${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setTranslatorList(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 통번역사 조회 실패"); }
    finally { setTranslatorsLoading(false); }
  }, [token, translatorSearch, translatorLangFilter, translatorStatusFilter, translatorGradeFilter, translatorRatingFilter]);

  const handleSaveBoardPost = async () => {
    if (!boardForm.title.trim() || !boardForm.content.trim()) { setToast("제목과 내용을 입력하세요."); return; }
    setSavingBoard(true);
    try {
      const res = await fetch(api("/api/admin/board"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(boardForm),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("게시물이 등록되었습니다.");
      setBoardForm({ category: "notice", title: "", content: "", pinned: false, visibleToAll: false });
      setShowBoardForm(false);
      await fetchBoard();
    } catch { setToast("오류: 게시물 등록 실패"); }
    finally { setSavingBoard(false); }
  };

  const handleDeleteBoardPost = async (id: number) => {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    try {
      const res = await fetch(api(`/api/admin/board/${id}`), { method: "DELETE", headers: authHeaders });
      if (!res.ok) { setToast("오류: 삭제 실패"); return; }
      setToast("게시물이 삭제되었습니다.");
      setBoardPostModal(null);
      await fetchBoard();
    } catch { setToast("오류: 삭제 실패"); }
  };

  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const isCurrentlyOpen = prev[key] !== false;
      return { ...prev, [key]: !isCurrentlyOpen };
    });
  };

  const handleExportCSV = async (type: "projects" | "settlements") => {
    try {
      const res = await fetch(api(`/api/admin/export/${type}`), { headers: authHeaders });
      if (!res.ok) { setToast("오류: CSV 내보내기 실패"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${type}_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch { setToast("오류: CSV 내보내기 실패"); }
  };

  const handleExportFilteredCSV = () => {
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const STYPE_KO: Record<string, string> = {
        WITHHOLDING_3_3: "원천세3.3%", VAT_INVOICE: "세금계산서",
        OVERSEAS_REMITTANCE: "해외송금", OTHER_REVIEW: "기타검토",
      };
      const SSTATUS_KO: Record<string, string> = {
        pending: "대기", ready: "지급 준비", paid: "지급 완료",
        draft: "정보 부족", pending_review: "검토 필요",
      };
      const headers = [
        "거래처명", "프로젝트명", "통번역사",
        "원금액", "원천세", "부가세", "실지급액",
        "정산 유형", "지급 예정일",
        "정산 상태", "검토 사유", "자동 생성",
        "생성일", "지급 완료일", "메모",
      ];
      const rows = filteredSettlements.map(s => {
        return [
          esc(s.companyName  ?? ""),
          esc(s.projectTitle ?? `프로젝트 #${s.projectId}`),
          esc(s.translatorName || s.translatorEmail || `#${s.translatorId}`),
          Math.round(Number(s.grossAmount ?? s.totalAmount)),
          Math.round(Number(s.withholdingAmount ?? 0)),
          Math.round(Number(s.vatAmount ?? 0)),
          Math.round(Number(s.netAmount ?? s.translatorAmount)),
          esc(STYPE_KO[s.settlementType ?? ""] ?? (s.settlementType ?? "")),
          esc(s.payoutDueDate ?? ""),
          esc(SSTATUS_KO[s.status] ?? s.status),
          esc(s.reviewReason ?? ""),
          s.isAutoGenerated ? "Y" : "N",
          new Date(s.createdAt).toLocaleDateString("ko-KR"),
          s.paidDate ? new Date(s.paidDate).toLocaleDateString("ko-KR") : "",
          esc(s.paymentMemo ?? ""),
        ].join(",");
      });
      const csv  = [headers.join(","), ...rows].join("\r\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url  = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href  = url;
      link.setAttribute("download", `정산내역_${dateStr}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setToast(`정산 내역 ${filteredSettlements.length}건을 다운로드했습니다.`);
    } catch { setToast("오류: CSV 내보내기 실패"); }
  };

  // ── Heartbeat: 3분마다 마지막 활동 시간 갱신 ────────────────────────────
  useEffect(() => {
    const sendHeartbeat = () => {
      if (!token) return;
      fetch(api("/api/auth/heartbeat"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, [token]);

  // ── 접속 통계 조회 ────────────────────────────────────────────────────────
  const fetchActivityStats = useCallback(async (period: string = "today") => {
    if (!token) return;
    try {
      const [statsRes, userStatsRes] = await Promise.all([
        fetch(api(`/api/admin/activity/stats?period=${period}`), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(api("/api/admin/activity/user-stats?limit=20"), { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (statsRes.ok) setActivityStats(await statsRes.json());
      if (userStatsRes.ok) setUserStats(await userStatsRes.json());
    } catch {}
  }, [token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { if (adminTab === "users") { fetchUsers(); fetchActivityStats(activityPeriod); } }, [adminTab, fetchUsers, fetchActivityStats, activityPeriod]);
  useEffect(() => { if (adminTab === "customers") fetchCustomers(); }, [adminTab, fetchCustomers]);
  useEffect(() => { if (adminTab === "companies") fetchCompanies(); }, [adminTab, fetchCompanies]);
  useEffect(() => { if (adminTab === "contacts") { fetchContacts(); if (companies.length === 0) fetchCompanies(); } }, [adminTab, fetchContacts]);
  useEffect(() => { if (adminTab === "board") fetchBoard(); }, [adminTab, fetchBoard]);
  useEffect(() => { if (adminTab === "translators") fetchTranslators(); }, [adminTab, fetchTranslators]);
  useEffect(() => { if (adminTab === "prepaid") fetchPrepaidAccounts(); }, [adminTab, fetchPrepaidAccounts]);
  useEffect(() => { if (adminTab === "billing") fetchBillingBatches(); }, [adminTab, fetchBillingBatches]);

  // ── 환경설정 상태 ─────────────────────────────────────────────────────────
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"company"|"bank"|"document"|"payment"|"settlement"|"insight">("company");
  const [settingsForm, setSettingsForm] = useState({
    // 공급자 정보
    companyName: "", businessNumber: "", ceoName: "", address: "", email: "", phone: "",
    // 입금 계좌
    bankName: "", accountNumber: "", accountHolder: "",
    // 문서 설정
    quoteValidityDays: "14", taxRate: "10", quoteNotes: "", signatureImageUrl: "",
    // 결제 설정
    defaultBillingType: "postpaid_per_project", paymentDueDays: "7", allowPartialPayment: false,
    // 정산 설정
    settlementRatio: "70", settlementCycle: "monthly", applyWithholdingTax: true,
    // 인사이트 자동 게시
    autoPublishEnabled: false, autoPublishThreshold: "80", autoPublishDryRun: false,
  });
  const fetchSettings = async () => {
    const res = await fetch(api("/api/admin/settings"), { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const d = await res.json();
      setSettingsForm({
        companyName:     d.companyName     ?? "",
        businessNumber:  d.businessNumber  ?? "",
        ceoName:         d.ceoName         ?? "",
        address:         d.address         ?? "",
        email:           d.email           ?? "",
        phone:           d.phone           ?? "",
        bankName:        d.bankName        ?? "",
        accountNumber:   d.accountNumber   ?? "",
        accountHolder:   d.accountHolder   ?? "",
        quoteValidityDays: String(d.quoteValidityDays ?? "14"),
        taxRate:           String(d.taxRate            ?? "10"),
        quoteNotes:        d.quoteNotes         ?? "",
        signatureImageUrl: d.signatureImageUrl  ?? "",
        defaultBillingType:  d.defaultBillingType  ?? "postpaid_per_project",
        paymentDueDays:      String(d.paymentDueDays ?? "7"),
        allowPartialPayment: Boolean(d.allowPartialPayment ?? false),
        settlementRatio:     String(d.settlementRatio  ?? "70"),
        settlementCycle:     d.settlementCycle     ?? "monthly",
        applyWithholdingTax: Boolean(d.applyWithholdingTax ?? true),
        autoPublishEnabled:   Boolean(d.autoPublishEnabled   ?? false),
        autoPublishThreshold: String(d.autoPublishThreshold  ?? "80"),
        autoPublishDryRun:    Boolean(d.autoPublishDryRun    ?? false),
      });
    }
  };
  useEffect(() => { if (adminTab === "settings") fetchSettings(); }, [adminTab]);

  // 아코디언 상태 localStorage 저장 (v2 버전 키 포함)
  useEffect(() => {
    try {
      localStorage.setItem("admin_sidebar_sections", JSON.stringify(openSections));
      localStorage.setItem("admin_sidebar_sections_ver", "2");
    } catch {}
  }, [openSections]);

  // 현재 탭이 속한 섹션 자동 펼침 (닫혀있어도 항상 강제 열기)
  useEffect(() => {
    const activeGroup = ADMIN_NAV_GROUPS.find(g => g.items.some(item => item.id === adminTab));
    if (activeGroup && !activeGroup.isDashboard) {
      setOpenSections(prev => ({ ...prev, [activeGroup.key]: true }));
    }
  }, [adminTab]);
  useEffect(() => {
    if (adminTab !== "roles" && adminTab !== "users") return;
    const authH = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(api("/api/admin/roles"), { headers: authH }).then(r => r.ok ? r.json() : []),
      adminTab === "roles"
        ? fetch(api("/api/admin/permissions"), { headers: authH }).then(r => r.ok ? r.json() : [])
        : Promise.resolve(null),
    ]).then(([roles, perms]) => {
      setRbacRoles(Array.isArray(roles) ? roles : []);
      if (perms !== null) setRbacAllPerms(Array.isArray(perms) ? perms : []);
    }).catch(() => setToast("역할 목록 조회 실패"));
    if (users.length === 0) fetchUsers();
  }, [adminTab, token]);

  const fetchScenarioHistory = async () => {
    setScenarioHistoryLoading(true);
    try {
      const res = await fetch(api("/api/admin/test/scenarios"), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setScenarioHistory(await res.json());
    } catch { /* ignore */ }
    finally { setScenarioHistoryLoading(false); }
  };
  const fetchFeedback = async () => {
    setFeedbackLoading(true);
    try {
      const res = await fetch(api("/api/admin/feedback"), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setFeedbackList(await res.json());
    } catch { /* ignore */ }
    finally { setFeedbackLoading(false); }
  };
  const fetchRealData = async () => {
    try {
      const res = await fetch(api("/api/admin/test/real-data"), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setRealData(await res.json());
    } catch { /* ignore */ }
  };
  useEffect(() => {
    if (adminTab === "test") { fetchScenarioHistory(); fetchFeedback(); fetchRealData(); }
  }, [adminTab]);

  const runScenario = async () => {
    if (scenarioRunning) return;
    setScenarioRunning(true);
    setScenarioResult(null);
    try {
      const body: Record<string, unknown> = {
        quoteAmount: Number(scenarioAmount) || 500000,
        translatorRatio: Number(scenarioRatio) || 0.6,
      };
      if (scenarioCompanyId) body.companyId = Number(scenarioCompanyId);
      if (scenarioContactId) body.contactId = Number(scenarioContactId);
      const res = await fetch(api("/api/admin/test/run-scenario"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setScenarioResult(data);
      fetchScenarioHistory();
    } catch { setToast("시나리오 실행 오류"); }
    finally { setScenarioRunning(false); }
  };

  const submitFeedback = async () => {
    if (!feedbackInput.trim() || feedbackSubmitting) return;
    setFeedbackSubmitting(true);
    try {
      const res = await fetch(api("/api/admin/feedback"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: feedbackInput.trim(), tag: feedbackTag }),
      });
      if (res.ok) { setFeedbackInput(""); fetchFeedback(); setToast("피드백이 저장되었습니다."); }
      else { const d = await res.json(); setToast(`오류: ${d.error}`); }
    } catch { setToast("피드백 저장 실패"); }
    finally { setFeedbackSubmitting(false); }
  };

  const deleteFeedback = async (id: number) => {
    try {
      await fetch(api(`/api/admin/feedback/${id}`), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      setFeedbackList(prev => prev.filter(f => f.id !== id));
    } catch { setToast("삭제 실패"); }
  };


  const runSettlementApprove = async (settlementId: number) => {
    setApproving(settlementId);
    try {
      const res = await fetch(api(`/api/admin/settlements/${settlementId}/approve`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(`정산 #${settlementId} 지급 준비로 승인되었습니다.`);
      await fetchAll();
    } catch { setToast("오류: 승인 처리 실패"); }
    finally { setApproving(null); }
  };

  const runSettlementPay = async (settlementId: number, paymentMemo?: string) => {
    setPaying(settlementId);
    try {
      const res = await fetch(api(`/api/admin/settlements/${settlementId}/pay`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMemo: paymentMemo ?? null }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setEditingMemo(null);
      setToast(`정산 #${settlementId} 완료 처리되었습니다.`);
      await fetchAll();
    } catch { setToast("오류: 정산 처리 실패"); }
    finally { setPaying(null); }
  };

  const runBatchPay = async () => {
    const ids = Array.from(selectedSettlements);
    if (ids.length === 0) return;
    setBatchPaying(true);
    try {
      const res = await fetch(api("/api/admin/settlements/bulk-pay"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ settlementIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(`${data.updated}건 지급 완료 처리되었습니다.${data.skipped > 0 ? ` (${data.skipped}건 스킵)` : ""}`);
      setSelectedSettlements(new Set());
      await fetchAll();
    } catch { setToast("오류: 일괄 정산 처리 실패"); }
    finally { setBatchPaying(false); }
  };

  const handlePaymentExport = () => {
    const ids = Array.from(selectedSettlements);
    if (ids.length === 0) return;
    const token = localStorage.getItem("token");
    const idsParam = ids.join(",");
    const url = api(`/api/admin/settlements/export?ids=${idsParam}`);
    const a = document.createElement("a");
    a.href = url;
    a.setAttribute("download", `payment_${new Date().toISOString().slice(0, 10)}.csv`);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    fetch(url, { headers })
      .then(r => r.blob())
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        a.href = blobUrl;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      })
      .catch(() => setToast("오류: 지급 파일 다운로드 실패"));
  };

  const handleRoleChange = async (userId: number, newRole: string) => {
    setRoleChanging(userId);
    try {
      const res = await fetch(api(`/api/admin/users/${userId}/role`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: data.role } : u));
      setToast("역할이 변경되었습니다.");
    } catch { setToast("오류: 역할 변경 실패"); }
    finally { setRoleChanging(null); }
  };

  const handleCreateStaff = async () => {
    if (!newStaff.name.trim()) { setToast("오류: 이름은 필수입니다."); return; }
    if (!newStaff.email.trim()) { setToast("오류: 이메일은 필수입니다."); return; }
    if (newStaff.password.length < 6) { setToast("오류: 비밀번호는 최소 6자 이상입니다."); return; }
    setCreatingStaff(true);
    try {
      const res = await fetch(api("/api/admin/users/internal"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newStaff.name.trim(),
          email: newStaff.email.trim().toLowerCase(),
          password: newStaff.password,
          role: newStaff.role,
          department: newStaff.department.trim() || undefined,
          jobTitle: newStaff.jobTitle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setShowCreateStaff(false);
      setNewStaff({ name: "", email: "", password: "", department: "", jobTitle: "", role: "staff", isActive: true });
      setToast("내부 직원이 등록되었습니다.");
      fetchUsers();
    } catch { setToast("오류: 직원 등록 실패"); }
    finally { setCreatingStaff(false); }
  };

  const handleToggleActive = async (userId: number) => {
    setToggling(userId);
    try {
      const res = await fetch(api(`/api/admin/users/${userId}/deactivate`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, isActive: data.isActive } : u));
      setToast(data.isActive ? "계정이 활성화되었습니다." : "계정이 비활성화되었습니다.");
    } catch { setToast("오류: 계정 상태 변경 실패"); }
    finally { setToggling(null); }
  };

  const handleResetPassword = async () => {
    if (!resetPwUserId || !resetPwInput.trim() || resetPwInput.length < 6) {
      setToast("오류: 새 비밀번호는 최소 6자 이상이어야 합니다."); return;
    }
    setResetPwLoading(true);
    try {
      const res = await fetch(api(`/api/admin/users/${resetPwUserId}/reset-password`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: resetPwInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("비밀번호가 재설정되었습니다.");
      setResetPwUserId(null); setResetPwInput("");
    } catch { setToast("오류: 비밀번호 재설정 실패"); }
    finally { setResetPwLoading(false); }
  };

  const filteredPayments = paymentFilter === "all" ? payments : payments.filter(p => p.status === paymentFilter);

  // ── 정산 탭 useMemo ──────────────────────────────────────────────────────────
  const settlementMonths = useMemo(() => {
    const monthSet = new Set<string>();
    settlements.forEach(s => {
      const m = s.createdAt.slice(0, 7);
      monthSet.add(m);
    });
    return Array.from(monthSet).sort((a, b) => b.localeCompare(a));
  }, [settlements]);

  const filteredSettlements = useMemo(() => {
    const statusOrder = ["pending_review", "ready", "draft", "pending", "paid"];
    return settlements
      .filter(s => {
        if (settlementFilter !== "all" && s.status !== settlementFilter) return false;
        if (settlementMonthFilter !== "all" && s.createdAt.slice(0, 7) !== settlementMonthFilter) return false;
        if (paidDateFrom || paidDateTo) {
          if (!s.paidDate) return false;
          const pd = new Date(s.paidDate);
          if (paidDateFrom && pd < new Date(paidDateFrom)) return false;
          if (paidDateTo) {
            const toEnd = new Date(paidDateTo);
            toEnd.setHours(23, 59, 59, 999);
            if (pd > toEnd) return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const si = statusOrder.indexOf(a.status ?? "pending");
        const sj = statusOrder.indexOf(b.status ?? "pending");
        if (si !== sj) return si - sj;
        const da = a.payoutDueDate ?? "9999-12-31";
        const db = b.payoutDueDate ?? "9999-12-31";
        if (da !== db) return da.localeCompare(db);
        const na = (a.translatorName ?? a.translatorEmail ?? "").toLowerCase();
        const nb = (b.translatorName ?? b.translatorEmail ?? "").toLowerCase();
        return na.localeCompare(nb, "ko");
      });
  }, [settlements, settlementFilter, settlementMonthFilter, paidDateFrom, paidDateTo]);

  const settlementStats = useMemo(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const thisMonth = today.slice(0, 7);
    // 실지급액 기준 (netAmount > translatorAmount > 0)
    const net = (s: AdminSettlement) => Number(s.netAmount ?? s.translatorAmount ?? 0);
    const readyList = settlements.filter(s => s.status === "ready");
    const unpaidTotal = readyList.reduce((sum, s) => sum + net(s), 0);
    const unpaidCount = readyList.length;
    const pendingReviewCount = settlements.filter(s => s.status === "pending_review").length;
    const thisMonthUnpaid = readyList
      .filter(s => s.createdAt.slice(0, 7) === thisMonth)
      .reduce((sum, s) => sum + net(s), 0);
    const paidTotal = settlements
      .filter(s => s.status === "paid")
      .reduce((sum, s) => sum + net(s), 0);
    const dueTodayCount = settlements
      .filter(s => s.payoutDueDate === today && s.status !== "paid").length;
    const overdueCount = settlements
      .filter(s => s.payoutDueDate && s.payoutDueDate < today && s.status !== "paid").length;
    return { unpaidTotal, unpaidCount, pendingReviewCount, thisMonthUnpaid, paidTotal, dueTodayCount, overdueCount };
  }, [settlements]);

  const tableTh: React.CSSProperties = {
    padding: "10px 12px", textAlign: "left", fontSize: 12,
    fontWeight: 600, color: "#6b7280", background: "#f9fafb",
    borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
  };
  const tableTd: React.CSSProperties = {
    padding: "9px 12px", fontSize: 13, color: "#374151",
    borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
  };

  const SIDEBAR_GROUPS = ADMIN_NAV_GROUPS.map(group => ({
    ...group,
    items: group.items.filter(item => hasPerm(item.perm)),
  })).filter(group => group.items.length > 0);

  const PAGE_TITLE = ADMIN_PAGE_TITLE;

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />
      {contactModal !== null && (
        <ContactDetailModal
          contactId={contactModal}
          token={token}
          onClose={() => setContactModal(null)}
          onToast={setToast}
          onOpenProject={(id) => { setContactModal(null); openDetail(id); }}
        />
      )}
      {translatorDetailModal !== null && (
        <TranslatorDetailModal
          userId={translatorDetailModal.userId}
          userEmail={translatorDetailModal.email}
          token={token}
          permissions={permissions}
          onClose={() => setTranslatorDetailModal(null)}
          onToast={setToast}
          onDeleted={() => { setTranslatorDetailModal(null); fetchTranslators(); }}
        />
      )}
      {showTranslatorCreateModal && (
        <TranslatorCreateModal
          token={token}
          permissions={permissions}
          onClose={() => setShowTranslatorCreateModal(false)}
          onCreated={(newT) => {
            setTranslatorList(prev => [newT, ...prev]);
          }}
          onToast={setToast}
        />
      )}
      {translatorProfileModal !== null && (
        <TranslatorProfileModal
          userId={translatorProfileModal.userId}
          userEmail={translatorProfileModal.email}
          token={token}
          onClose={() => setTranslatorProfileModal(null)}
          onToast={setToast}
        />
      )}
      {boardPostModal !== null && (
        <DraggableModal
          title={boardPostModal.title}
          subtitle={`${boardPostModal.authorEmail} · ${new Date(boardPostModal.createdAt).toLocaleDateString("ko-KR")}`}
          onClose={() => setBoardPostModal(null)}
          width={680}
          zIndex={300}
          bodyPadding="20px 28px"
          headerExtra={
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {boardPostModal.pinned && <span style={{ background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>📌 고정</span>}
              <span style={{ background: "#eff6ff", color: "#2563eb", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{BOARD_CATEGORY_LABEL[boardPostModal.category] ?? boardPostModal.category}</span>
              {boardPostModal.visibleToAll && <span style={{ background: "#f0fdf4", color: "#059669", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>공개</span>}
            </div>
          }
        >
          <div style={{ background: "#f9fafb", borderRadius: 10, padding: "16px 18px", fontSize: 14, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: 16, border: "1px solid #e5e7eb" }}>
            {boardPostModal.content ?? "내용 없음"}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => handleDeleteBoardPost(boardPostModal.id)} style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>삭제</button>
          </div>
        </DraggableModal>
      )}
      {resetPwUserId !== null && (
        <DraggableModal
          title="비밀번호 재설정"
          subtitle={`사용자 #${resetPwUserId}의 비밀번호를 재설정합니다.`}
          onClose={() => { setResetPwUserId(null); setResetPwInput(""); }}
          width={400}
          zIndex={400}
          bodyPadding="20px 28px"
        >
          <input
            type="password"
            value={resetPwInput}
            onChange={e => setResetPwInput(e.target.value)}
            placeholder="새 비밀번호 (최소 6자)"
            onKeyDown={e => e.key === "Enter" && handleResetPassword()}
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 14 }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <GhostBtn onClick={() => { setResetPwUserId(null); setResetPwInput(""); }}>취소</GhostBtn>
            <PrimaryBtn onClick={handleResetPassword} disabled={resetPwLoading || resetPwInput.length < 6} style={{ padding: "8px 18px" }}>
              {resetPwLoading ? "처리 중..." : "재설정"}
            </PrimaryBtn>
          </div>
        </DraggableModal>
      )}
      {detailModal !== null && (
        <ProjectDetailModal
          projectId={detailModal.id} token={token}
          onClose={() => setDetailModal(null)}
          onRefresh={fetchAll}
          onToast={setToast}
          adminList={adminUsers}
          initialSection={detailModal.initialSection}
        />
      )}
      {customerModal !== null && (
        <CustomerDetailModal
          customerId={customerModal} token={token}
          onClose={() => setCustomerModal(null)}
          onToast={setToast}
          onOpenProject={(id) => { setCustomerModal(null); openDetail(id); }}
        />
      )}

      {/* ── 풀스크린 사이드바 레이아웃 ───────────────────────── */}
      <div style={{ display: "flex", position: "fixed", inset: 0, overflow: "hidden", zIndex: 1 }}>

        {/* ── 사이드바 ──────────────────────────────────────── */}
        <aside style={{
          width: sidebarCollapsed ? 0 : 220,
          minWidth: sidebarCollapsed ? 0 : 220,
          background: "#1e2433",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          transition: "width 0.22s ease, min-width 0.22s ease",
          flexShrink: 0,
        }}>
          {/* 로고 영역 */}
          <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid #2d3547", flexShrink: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", letterSpacing: "-0.3px", whiteSpace: "nowrap" }}>
              🔤 통번역 플랫폼
            </div>
            <div style={{ fontSize: 11, color: "#8892a4", marginTop: 3, whiteSpace: "nowrap" }}>관리자 CRM</div>
          </div>

          {/* 메뉴 그룹 (아코디언) */}
          <nav style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {SIDEBAR_GROUPS.map((group, gi) => {
              const isOpen = group.isDashboard || openSections[group.key] !== false;
              // 필터 전 전체 아이템 기준으로 active 여부 판단 (perm 필터와 무관하게 일관성 보장)
              const rawGroup = ADMIN_NAV_GROUPS.find(g => g.key === group.key);
              const hasActiveItem = (rawGroup ?? group).items.some(item => item.id === adminTab);
              return (
                <div key={group.key} style={{ marginBottom: group.isDashboard ? 4 : 1 }}>
                  {/* 섹션 헤더 (대시보드 제외) */}
                  {!group.isDashboard && (
                    <button
                      onClick={() => toggleSection(group.key)}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        width: "100%", border: "none", cursor: "pointer",
                        padding: "9px 14px 4px 16px",
                        background: "transparent",
                        borderLeft: `3px solid ${hasActiveItem ? group.accentColor : "#2d3547"}`,
                        marginTop: gi > 0 ? 4 : 0,
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#252d3f"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                    >
                      <span style={{
                        fontSize: 9, fontWeight: 700,
                        color: hasActiveItem ? group.accentColor : "#6b7a95",
                        textTransform: "uppercase", letterSpacing: "0.9px", whiteSpace: "nowrap",
                        transition: "color 0.12s",
                      }}>
                        {group.label}
                      </span>
                      <span style={{
                        fontSize: 9, color: hasActiveItem ? group.accentColor : "#4a5568",
                        transition: "transform 0.18s, color 0.12s",
                        display: "inline-block",
                        transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                      }}>▶</span>
                    </button>
                  )}
                  {/* 메뉴 아이템 (섹션이 열려 있을 때만) */}
                  {isOpen && group.items.map(item => {
                    const isActive = adminTab === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setAdminTab(item.id as typeof adminTab)}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          width: "100%", padding: "9px 20px 9px 22px", border: "none", cursor: "pointer",
                          background: isActive ? group.accentColor : "transparent",
                          color: isActive ? "#fff" : "#c1c8d4",
                          fontSize: 13, fontWeight: isActive ? 600 : 400,
                          textAlign: "left", whiteSpace: "nowrap",
                          borderRadius: 0, transition: "background 0.15s, color 0.12s",
                        }}
                        onMouseEnter={e => { if (!isActive) { (e.currentTarget as HTMLButtonElement).style.background = "#2d3547"; } }}
                        onMouseLeave={e => { if (!isActive) { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; } }}
                      >
                        <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>
                          {item.icon}
                        </span>
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          {/* 사용자 정보 + 로그아웃 */}
          <div style={{ padding: "14px 20px", borderTop: "1px solid #2d3547", flexShrink: 0 }}>
            <div style={{ fontSize: 12, color: "#8892a4", marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {user.email}
            </div>
            <div style={{ fontSize: 10, color: "#5a6478", marginBottom: 10 }}>관리자</div>
            {onLogout && (
              <button onClick={onLogout} style={{
                width: "100%", padding: "7px 0", background: "transparent",
                border: "1px solid #3d4558", borderRadius: 6, color: "#8892a4",
                fontSize: 12, cursor: "pointer", transition: "all 0.12s",
              }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = "#fff"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#6b7280"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = "#8892a4"; (e.currentTarget as HTMLButtonElement).style.borderColor = "#3d4558"; }}
              >
                로그아웃
              </button>
            )}
          </div>
        </aside>

        {/* ── 메인 컨텐츠 영역 ──────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

          {/* 상단 바 */}
          <div style={{
            height: 54, background: "#fff", borderBottom: "1px solid #e5e7eb",
            display: "flex", alignItems: "center", gap: 12, padding: "0 24px",
            flexShrink: 0,
          }}>
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "6px 8px", borderRadius: 6, color: "#6b7280", fontSize: 18, lineHeight: 1, flexShrink: 0 }}
              title={sidebarCollapsed ? "메뉴 펼치기" : "메뉴 접기"}
            >
              ☰
            </button>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#111827", flex: 1 }}>
              {PAGE_TITLE[adminTab] ?? "관리자"}
            </span>
            <GhostBtn onClick={fetchAll} disabled={loading} style={{ fontSize: 12, padding: "5px 12px" }}>
              {loading ? "로딩..." : "새로고침"}
            </GhostBtn>
          </div>

          {/* 스크롤 컨텐츠 */}
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px", background: "#f9fafb" }}>

          {/* 대시보드 탭 */}
          {adminTab === "dashboard" && (() => {
            const now = new Date();
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const startOfWeek  = new Date(startOfToday); startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

            const paidPayments = payments.filter(p => p.status === "paid");
            const unpaidPayments = payments.filter(p => ["pending","unpaid","overdue"].includes(p.status));
            const pendingSettlements = settlements.filter(s => s.status === "ready");

            const revenueToday = paidPayments.filter(p => new Date(p.createdAt) >= startOfToday).reduce((acc, p) => acc + Number(p.amount), 0);
            const revenueWeek  = paidPayments.filter(p => new Date(p.createdAt) >= startOfWeek).reduce((acc, p) => acc + Number(p.amount), 0);
            const revenueMonth = paidPayments.filter(p => new Date(p.createdAt) >= startOfMonth).reduce((acc, p) => acc + Number(p.amount), 0);
            const unpaidTotal  = unpaidPayments.reduce((acc, p) => acc + Number(p.amount), 0);

            const inProgressTasks = tasks.filter(t => t.status !== "done");
            const delayedProjects = projects.filter(p => {
              const terminal = ["completed","rejected","cancelled"];
              if (terminal.includes(p.status)) return false;
              const age = (now.getTime() - new Date(p.createdAt).getTime()) / (1000 * 60 * 60 * 24);
              return age > 30 || p.financialStatus === "overdue";
            });

            const kpi = [
              {
                label: "진행 중 작업",
                value: inProgressTasks.length,
                sub: "현재 번역·통역 중",
                color: "#2563eb", bg: "#eff6ff",
                onClick: () => setAdminTab("tasks"),
              },
              {
                label: "정산 대기",
                value: pendingSettlements.length,
                sub: pendingSettlements.length > 0 ? "⚠ 즉시 처리 필요" : "처리 대기 없음",
                color: pendingSettlements.length > 0 ? "#dc2626" : "#6b7280",
                bg: pendingSettlements.length > 0 ? "#fef2f2" : "#f9fafb",
                alert: pendingSettlements.length > 0,
                onClick: () => setAdminTab("settlements"),
              },
              {
                label: "이번달 매출",
                value: `${revenueMonth.toLocaleString()}원`,
                sub: `오늘 ${revenueToday.toLocaleString()}원 / 이번주 ${revenueWeek.toLocaleString()}원`,
                color: "#059669", bg: "#f0fdf4",
                onClick: () => setAdminTab("payments"),
              },
              {
                label: "미결제 금액",
                value: `${unpaidTotal.toLocaleString()}원`,
                sub: unpaidPayments.length > 0 ? `${unpaidPayments.length}건 미수금` : "미수금 없음",
                color: unpaidPayments.length > 0 ? "#d97706" : "#6b7280",
                bg: unpaidPayments.length > 0 ? "#fffbeb" : "#f9fafb",
                alert: unpaidPayments.length > 0,
                onClick: () => setAdminTab("payments"),
              },
            ];

            const alerts = [
              pendingSettlements.length > 0 && {
                icon: "🔴", label: `정산 대기 ${pendingSettlements.length}건`,
                desc: "미지급 정산이 쌓여 있습니다. 지금 처리하세요.",
                actionLabel: "정산 처리하기", action: () => setAdminTab("settlements"),
                border: "#fecaca", bg: "#fef2f2", color: "#dc2626",
              },
              unpaidPayments.length > 0 && {
                icon: "🟡", label: `미결제 ${unpaidPayments.length}건 · ${unpaidTotal.toLocaleString()}원`,
                desc: "입금 확인이 필요한 결제 건이 있습니다.",
                actionLabel: "결제 관리", action: () => setAdminTab("payments"),
                border: "#fde68a", bg: "#fffbeb", color: "#d97706",
              },
              delayedProjects.length > 0 && {
                icon: "🟠", label: `지연 의심 프로젝트 ${delayedProjects.length}건`,
                desc: "30일 이상 미완료 또는 연체 상태 프로젝트입니다.",
                actionLabel: "프로젝트 보기", action: () => setAdminTab("projects"),
                border: "#fed7aa", bg: "#fff7ed", color: "#ea580c",
              },
            ].filter(Boolean) as { icon: string; label: string; desc: string; actionLabel: string; action: () => void; border: string; bg: string; color: string }[];

            const PROJECT_STATUS_BADGE: Record<string, { bg: string; color: string; label: string }> = {
              pending:     { bg: "#f3f4f6", color: "#6b7280", label: "대기" },
              in_progress: { bg: "#dbeafe", color: "#1d4ed8", label: "진행 중" },
              review:      { bg: "#fef9c3", color: "#92400e", label: "검토" },
              completed:   { bg: "#d1fae5", color: "#065f46", label: "완료" },
              rejected:    { bg: "#fee2e2", color: "#991b1b", label: "반려" },
              cancelled:   { bg: "#f3f4f6", color: "#9ca3af", label: "취소" },
              delayed:     { bg: "#ffedd5", color: "#9a3412", label: "지연" },
            };
            const getProjectBadge = (p: AdminProject) => {
              const base = PROJECT_STATUS_BADGE[p.status] ?? { bg: "#f3f4f6", color: "#6b7280", label: p.status };
              const isDelayed = delayedProjects.some(d => d.id === p.id);
              return isDelayed ? PROJECT_STATUS_BADGE.delayed : base;
            };

            return (
              <div>
                {/* 헤더 */}
                <div style={{ marginBottom: 22 }}>
                  <h2 style={{ margin: "0 0 3px", fontSize: 18, fontWeight: 800, color: "#111827" }}>컨트롤 타워</h2>
                  <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>운영 현황을 한눈에 파악하고 즉시 행동하세요.</p>
                </div>

                {/* KPI 카드 4개 */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 20 }}>
                  {kpi.map(k => (
                    <div key={k.label} onClick={k.onClick} style={{
                      background: k.bg, border: `1.5px solid ${"alert" in k && k.alert ? k.color + "44" : "#e5e7eb"}`,
                      borderRadius: 14, padding: "18px 20px", cursor: "pointer",
                      position: "relative", overflow: "hidden",
                      transition: "box-shadow 0.15s, transform 0.1s",
                      boxShadow: "alert" in k && k.alert ? `0 0 0 3px ${k.color}18` : "none",
                    }}
                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = `0 6px 18px ${k.color}22`; (e.currentTarget as HTMLDivElement).style.transform = "translateY(-1px)"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "alert" in k && k.alert ? `0 0 0 3px ${k.color}18` : "none"; (e.currentTarget as HTMLDivElement).style.transform = "none"; }}
                    >
                      {"alert" in k && k.alert && (
                        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: k.color }} />
                      )}
                      <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: k.color, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k.label}</p>
                      <p style={{ margin: "0 0 5px", fontSize: 26, fontWeight: 800, color: k.color, lineHeight: 1, wordBreak: "break-all" }}>{k.value}</p>
                      <p style={{ margin: 0, fontSize: 11, color: `${k.color}bb` }}>{k.sub}</p>
                    </div>
                  ))}
                </div>

                {/* 운영 알림 */}
                {alerts.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#111827" }}>⚡ 운영 알림</h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {alerts.map(a => (
                        <div key={a.label} style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          background: a.bg, border: `1px solid ${a.border}`, borderRadius: 10,
                          padding: "12px 16px", gap: 12,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                            <span style={{ fontSize: 18, flexShrink: 0 }}>{a.icon}</span>
                            <div style={{ minWidth: 0 }}>
                              <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 700, color: a.color }}>{a.label}</p>
                              <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>{a.desc}</p>
                            </div>
                          </div>
                          <button onClick={a.action} style={{
                            padding: "7px 14px", background: a.color, color: "#fff",
                            border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700,
                            cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap",
                          }}>
                            {a.actionLabel}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 매출 요약 + 하단 패널 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

                  {/* 최근 프로젝트 */}
                  <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "18px 20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>최근 프로젝트</h3>
                      <button onClick={() => setAdminTab("projects")} style={{ background: "none", border: "none", fontSize: 12, color: "#2563eb", cursor: "pointer", padding: 0, fontWeight: 600 }}>전체 보기 →</button>
                    </div>
                    {projects.length === 0 ? (
                      <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>프로젝트가 없습니다.</p>
                    ) : projects.slice(0, 6).map(p => {
                      const badge = getProjectBadge(p);
                      return (
                        <div key={p.id} onClick={() => openDetail(p.id)} style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "7px 0", borderBottom: "1px solid #f3f4f6",
                          cursor: "pointer", gap: 8,
                        }}
                          onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"}
                          onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = "transparent"}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ margin: 0, fontSize: 13, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</p>
                            {p.companyName && <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>{p.companyName}</p>}
                          </div>
                          <span style={{
                            padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                            background: badge.bg, color: badge.color, flexShrink: 0, whiteSpace: "nowrap",
                          }}>{badge.label}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* 우측: 매출 요약 + 최근 정산 */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {/* 매출 요약 */}
                    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "18px 20px" }}>
                      <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>💰 매출 요약</h3>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                        {[
                          { label: "오늘", value: revenueToday, color: "#7c3aed" },
                          { label: "이번주", value: revenueWeek,  color: "#0891b2" },
                          { label: "이번달", value: revenueMonth, color: "#059669" },
                        ].map(r => (
                          <div key={r.label} style={{ textAlign: "center", padding: "10px 6px", background: "#f9fafb", borderRadius: 8 }}>
                            <p style={{ margin: "0 0 3px", fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" }}>{r.label}</p>
                            <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: r.color }}>{r.value.toLocaleString()}원</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 최근 정산 */}
                    <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "18px 20px", flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>최근 정산</h3>
                        <button onClick={() => setAdminTab("settlements")} style={{ background: "none", border: "none", fontSize: 12, color: "#2563eb", cursor: "pointer", padding: 0, fontWeight: 600 }}>전체 보기 →</button>
                      </div>
                      {settlements.length === 0 ? (
                        <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>정산 내역이 없습니다.</p>
                      ) : settlements.slice(0, 5).map(s => {
                        const isPending = s.status === "ready";
                        const name = (s as any).translatorName as string | null | undefined;
                        const email = s.translatorEmail;
                        return (
                          <div key={s.id} style={{
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                            padding: "8px 0", borderBottom: "1px solid #f3f4f6",
                            background: isPending ? "#fef9f9" : "transparent",
                          }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: isPending ? "#dc2626" : "#111827" }}>
                                  {name || email || `통번역사 #${s.translatorId}`}
                                </span>
                                {isPending && (
                                  <span style={{ fontSize: 10, background: "#fee2e2", color: "#dc2626", borderRadius: 4, padding: "1px 5px", fontWeight: 700, flexShrink: 0 }}>
                                    미지급
                                  </span>
                                )}
                              </div>
                              {name && email && (
                                <p style={{ margin: 0, fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {email}
                                </p>
                              )}
                            </div>
                            <span style={{ fontSize: 13, fontWeight: 700, color: isPending ? "#dc2626" : "#111827", flexShrink: 0, marginLeft: 8 }}>
                              {Number(s.translatorAmount).toLocaleString()}원
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

      {/* ── 프로젝트 탭 ── */}
      {adminTab === "projects" && (
        <ProjectManagementTab
          token={token}
          user={user}
          hasPerm={hasPerm}
          setToast={setToast}
          authHeaders={authHeaders}
          adminUsers={adminUsers}
          openDetail={openDetail}
          onProjectCreated={fetchAll}
        />
      )}

      {/* ── 결제 탭 ── */}
      {adminTab === "payments" && (
        <Section
          title={`결제 현황 (${filteredPayments.length})`}
          action={
            <div style={{ display: "flex", gap: 6 }}>
              <FilterPill label="전체" active={paymentFilter === "all"} onClick={() => setPaymentFilter("all")} />
              {ALL_PAYMENT_STATUSES.map(s => (
                <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                  active={paymentFilter === s} onClick={() => setPaymentFilter(s)} />
              ))}
            </div>
          }
        >
          {loading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : filteredPayments.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>결제 내역이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","프로젝트","결제 금액","결제 상태","프로젝트 상태","생성일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {filteredPayments.map(pm => (
                      <tr key={pm.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{pm.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{pm.projectTitle ?? `프로젝트 #${pm.projectId}`}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#0891b2" }}>{Number(pm.amount).toLocaleString()}원</td>
                        <td style={tableTd}><StatusBadge status={pm.status} /></td>
                        <td style={tableTd}>{pm.projectStatus ? <StatusBadge status={pm.projectStatus} /> : "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(pm.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 작업 탭 ── */}
      {adminTab === "tasks" && (
        <Section title={`작업 현황 (${tasks.length})`}>
          {loading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : tasks.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>작업이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","프로젝트","통번역사","작업 상태","프로젝트 상태","생성일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {tasks.map(t => (
                      <tr key={t.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{t.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{t.projectTitle ?? `프로젝트 #${t.projectId}`}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>
                          {(t as any).translatorName || t.translatorEmail || `통번역사 #${t.translatorId}`}
                          {(t as any).translatorName && t.translatorEmail && <span style={{ color: "#9ca3af", fontSize: 11 }}> ({t.translatorEmail})</span>}
                        </td>
                        <td style={tableTd}><StatusBadge status={t.status} /></td>
                        <td style={tableTd}>{t.projectStatus ? <StatusBadge status={t.projectStatus} /> : "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 정산 탭 ── */}
      {adminTab === "settlements" && (() => {
        const readyIds = filteredSettlements.filter(s => s.status === "ready").map(s => s.id);
        const allReadySelected = readyIds.length > 0 && readyIds.every(id => selectedSettlements.has(id));
        const someSelected = selectedSettlements.size > 0;
        const toggleAll = () => {
          setSelectedSettlements(prev => {
            const currentlyAll = readyIds.length > 0 && readyIds.every(id => prev.has(id));
            const next = new Set(prev);
            if (currentlyAll) { readyIds.forEach(id => next.delete(id)); }
            else { readyIds.forEach(id => next.add(id)); }
            return next;
          });
        };
        const selectedTotal = filteredSettlements
          .filter(s => selectedSettlements.has(s.id))
          .reduce((sum, s) => sum + (parseFloat(String(s.netAmount ?? "0")) || 0), 0);

        return (
          <Section
            title={`정산 현황 (${filteredSettlements.length})`}
            action={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <GhostBtn onClick={() => handleExportCSV("settlements")} style={{ fontSize: 12, padding: "6px 12px" }}>⬇ 전체 CSV</GhostBtn>
                <FilterPill label="전체" active={settlementFilter === "all"} onClick={() => setSettlementFilter("all")} />
                {ALL_SETTLEMENT_STATUSES.map(s => {
                  const SETTLEMENT_LABEL: Record<string, string> = {
                    pending_review: "검토 필요", ready: "지급 준비",
                    pending: "대기", draft: "정보 부족", paid: "지급 완료",
                  };
                  return (
                    <FilterPill key={s} label={SETTLEMENT_LABEL[s] ?? STATUS_LABEL[s] ?? s}
                      active={settlementFilter === s} onClick={() => setSettlementFilter(s)} />
                  );
                })}
              </div>
            }
          >
            {/* ── 선택 액션 바 ── */}
            {someSelected && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
                background: "linear-gradient(135deg, #eff6ff, #dbeafe)",
                border: "1px solid #93c5fd", borderRadius: 10, marginBottom: 16,
                flexWrap: "wrap",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 200 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#1d4ed8" }}>
                    {selectedSettlements.size}건 선택됨
                  </span>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>|</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
                    합계 ₩{selectedTotal.toLocaleString()}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={handlePaymentExport} style={{
                    padding: "7px 14px", fontSize: 12, borderRadius: 8, fontWeight: 600, cursor: "pointer",
                    background: "#fff", border: "1px solid #3b82f6", color: "#2563eb", whiteSpace: "nowrap",
                  }}>
                    ⬇ 지급 파일 다운로드
                  </button>
                  <button type="button" onClick={runBatchPay} disabled={batchPaying} style={{
                    padding: "7px 14px", fontSize: 12, borderRadius: 8, fontWeight: 700,
                    cursor: batchPaying ? "not-allowed" : "pointer",
                    background: batchPaying ? "#86efac" : "#059669", border: "none", color: "#fff", whiteSpace: "nowrap",
                  }}>
                    {batchPaying ? "처리 중..." : "선택 지급 완료"}
                  </button>
                  <button type="button" onClick={() => setSelectedSettlements(new Set())} style={{
                    padding: "7px 12px", fontSize: 12, borderRadius: 8, fontWeight: 600, cursor: "pointer",
                    background: "#f3f4f6", border: "1px solid #e5e7eb", color: "#6b7280", whiteSpace: "nowrap",
                  }}>
                    ✕ 선택 취소
                  </button>
                </div>
              </div>
            )}

            {/* ── 통계 카드 4종 ── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
              {/* 오늘 지급 예정 */}
              <div style={{ background: "#fff", border: `1px solid ${settlementStats.dueTodayCount > 0 ? "#fecaca" : "#e5e7eb"}`, borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #ef4444, #f87171)" }} />
                <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.05em" }}>오늘 지급 예정</p>
                <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{settlementStats.dueTodayCount}건</p>
                {settlementStats.overdueCount > 0 && <p style={{ margin: 0, fontSize: 11, color: "#ef4444", fontWeight: 600 }}>⚠ 초과 {settlementStats.overdueCount}건</p>}
                {settlementStats.overdueCount === 0 && <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>오늘 기준</p>}
              </div>
              {/* 지급 준비 */}
              <div style={{ background: "#fff", border: `1px solid ${settlementStats.unpaidCount > 0 ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #059669, #34d399)" }} />
                <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#059669", textTransform: "uppercase", letterSpacing: "0.05em" }}>지급 준비</p>
                <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{settlementStats.unpaidCount}건</p>
                <p style={{ margin: 0, fontSize: 11, color: "#6b7280" }}>실지급 {Math.round(settlementStats.unpaidTotal).toLocaleString()}원</p>
              </div>
              {/* 검토 필요 */}
              <div style={{ background: "#fff", border: `1px solid ${settlementStats.pendingReviewCount > 0 ? "#fde68a" : "#e5e7eb"}`, borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #f59e0b, #fbbf24)" }} />
                <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#b45309", textTransform: "uppercase", letterSpacing: "0.05em" }}>검토 필요</p>
                <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{settlementStats.pendingReviewCount}건</p>
                <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>승인 후 지급 가능</p>
              </div>
              {/* 지급 완료 */}
              <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "14px 18px", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #6b7280, #9ca3af)" }} />
                <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>이번달 지급 예정액</p>
                <p style={{ margin: "0 0 2px", fontSize: 22, fontWeight: 800, color: "#111827" }}>{Math.round(settlementStats.thisMonthUnpaid).toLocaleString()}원</p>
                <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>누적 완료 {Math.round(settlementStats.paidTotal).toLocaleString()}원</p>
              </div>
            </div>

            {/* ── 월별 필터 ── */}
            {settlementMonths.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginRight: 2, whiteSpace: "nowrap" }}>월별</span>
                <button onClick={() => setSettlementMonthFilter("all")}
                  style={{ padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: settlementMonthFilter === "all" ? 700 : 500, cursor: "pointer",
                    background: settlementMonthFilter === "all" ? "#374151" : "#f3f4f6",
                    color: settlementMonthFilter === "all" ? "#fff" : "#374151", border: "none" }}>
                  전체
                </button>
                {settlementMonths.map(m => {
                  const [y, mo] = m.split("-");
                  const isActive = settlementMonthFilter === m;
                  return (
                    <button key={m} onClick={() => setSettlementMonthFilter(m)}
                      style={{ padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: isActive ? 700 : 500, cursor: "pointer",
                        background: isActive ? "#1d4ed8" : "#f3f4f6", color: isActive ? "#fff" : "#374151", border: "none" }}>
                      {y}.{mo}
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── 지급 완료일 기간 필터 + 다운로드 ── */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
                padding: "10px 14px", background: "#f9fafb", borderRadius: 10, border: "1px solid #e5e7eb" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", whiteSpace: "nowrap" }}>지급일</span>
                <input
                  type="date"
                  value={paidDateFrom}
                  onChange={e => setPaidDateFrom(e.target.value)}
                  max={paidDateTo || undefined}
                  style={{ ...inputStyle, fontSize: 12, padding: "5px 8px", width: 140 }}
                />
                <span style={{ fontSize: 12, color: "#9ca3af" }}>~</span>
                <input
                  type="date"
                  value={paidDateTo}
                  onChange={e => setPaidDateTo(e.target.value)}
                  min={paidDateFrom || undefined}
                  style={{ ...inputStyle, fontSize: 12, padding: "5px 8px", width: 140 }}
                />
                {(paidDateFrom || paidDateTo) && (
                  <button type="button" onClick={() => { setPaidDateFrom(""); setPaidDateTo(""); }}
                    style={{ padding: "5px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                      background: "#fff", border: "1px solid #e5e7eb", color: "#6b7280", fontWeight: 500, whiteSpace: "nowrap" }}>
                    초기화
                  </button>
                )}
                <button type="button" onClick={handleExportFilteredCSV}
                  style={{ ...inputStyle, padding: "5px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
                    background: "#1d4ed8", border: "1px solid #1d4ed8", color: "#fff", fontWeight: 600,
                    whiteSpace: "nowrap", marginLeft: "auto" }}>
                  📥 내역 다운로드
                </button>
              </div>
              {/* ── 동적 안내 문구 ── */}
              {(() => {
                const isFiltered = settlementFilter !== "all" || settlementMonthFilter !== "all" || !!paidDateFrom || !!paidDateTo;
                return (
                  <p style={{ margin: "6px 0 0", fontSize: 12,
                    color: isFiltered ? "#1d4ed8" : "#9ca3af", fontWeight: isFiltered ? 600 : 400 }}>
                    {isFiltered
                      ? `총 ${filteredSettlements.length}건의 정산 내역이 필터링되었습니다.`
                      : `전체 ${filteredSettlements.length}건 표시 중`}
                  </p>
                );
              })()}
            </div>

            {/* ── 목록 ── */}
            {loading ? (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
            ) : filteredSettlements.length === 0 ? (
              <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>정산 내역이 없습니다.</Card>
            ) : (
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ ...tableTh, width: 36, textAlign: "center" as const }}>
                          <input type="checkbox" checked={allReadySelected} onChange={toggleAll}
                            disabled={readyIds.length === 0}
                            title={readyIds.length === 0 ? "선택 가능한 미지급 건 없음" : "ready 전체 선택"}
                            style={{ cursor: readyIds.length === 0 ? "not-allowed" : "pointer" }} />
                        </th>
                        {["프로젝트","통번역사","납품일","지급 예정일","원금액","원천세","실지급액","정산 유형","상태","액션"].map(h => <th key={h} style={tableTh}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSettlements.map(s => {
                        const isChecked = selectedSettlements.has(s.id);
                        const isEditing = editingMemo?.id === s.id;
                        const gross = Number(s.grossAmount ?? s.totalAmount ?? 0);
                        const net = Number(s.netAmount ?? s.translatorAmount ?? 0);
                        const withholding = Number(s.withholdingAmount ?? 0);
                        const today = new Date().toISOString().slice(0, 10);
                        const isOverdue = s.payoutDueDate && s.payoutDueDate < today && s.status !== "paid";
                        const isDueToday = s.payoutDueDate === today && s.status !== "paid";
                        const STYPE_KO: Record<string, string> = {
                          WITHHOLDING_3_3: "원천세 3.3%",
                          VAT_INVOICE: "세금계산서",
                          OVERSEAS_REMITTANCE: "해외송금",
                          OTHER_REVIEW: "기타",
                        };
                        return (
                          <tr key={s.id}
                            onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                            onMouseLeave={e => (e.currentTarget.style.background = isChecked ? "#f0fdf4" : "transparent")}
                            style={{ background: isChecked ? "#f0fdf4" : "transparent" }}>
                            <td style={{ ...tableTd, textAlign: "center" as const, width: 36 }}>
                              {s.status === "ready" ? (
                                <input type="checkbox" checked={isChecked}
                                  onChange={() => setSelectedSettlements(prev => {
                                    const next = new Set(prev);
                                    isChecked ? next.delete(s.id) : next.add(s.id);
                                    return next;
                                  })}
                                  style={{ cursor: "pointer" }} />
                              ) : (
                                <span style={{ color: "#d1d5db", fontSize: 10 }}>—</span>
                              )}
                            </td>
                            {/* 프로젝트 */}
                            <td style={{ ...tableTd, fontWeight: 600, color: "#111827", maxWidth: 150 }}>
                              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.projectTitle ?? `프로젝트 #${s.projectId}`}</div>
                              {s.companyName && <div style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.companyName}</div>}
                            </td>
                            {/* 통번역사 */}
                            <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>
                              {(s.translatorName || s.translatorEmail)
                                ? <>
                                    <div style={{ fontWeight: 600 }}>{s.translatorName || s.translatorEmail}</div>
                                    {s.translatorName && s.translatorEmail && (
                                      <div style={{ color: "#9ca3af", fontSize: 11 }}>{s.translatorEmail}</div>
                                    )}
                                  </>
                                : <span style={{ color: "#d1d5db", fontSize: 12 }}>정보 없음</span>
                              }
                            </td>
                            {/* 납품일 */}
                            <td style={{ ...tableTd, fontSize: 12, whiteSpace: "nowrap" }}>
                              {s.createdAt
                                ? <div>
                                    <div style={{ fontWeight: 500, color: "#374151" }}>
                                      {s.createdAt.slice(5, 10).replace("-", ".")}
                                    </div>
                                    {s.isAutoGenerated && (
                                      <div style={{ fontSize: 10, color: "#7c3aed", fontWeight: 600, marginTop: 1 }}>🤖 자동</div>
                                    )}
                                  </div>
                                : <span style={{ color: "#d1d5db" }}>—</span>
                              }
                            </td>
                            {/* 지급 예정일 */}
                            <td style={{ ...tableTd, fontSize: 12, whiteSpace: "nowrap" }}>
                              {s.payoutDueDate
                                ? <div>
                                    <span style={{ fontWeight: 600, color: isOverdue ? "#dc2626" : isDueToday ? "#d97706" : "#111827" }}>
                                      {s.payoutDueDate}
                                    </span>
                                    {isOverdue && (
                                      <div style={{ marginTop: 2 }}>
                                        <span style={{ padding: "1px 5px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#fee2e2", color: "#dc2626" }}>지연</span>
                                      </div>
                                    )}
                                    {isDueToday && (
                                      <div style={{ marginTop: 2 }}>
                                        <span style={{ padding: "1px 5px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#fef3c7", color: "#d97706" }}>오늘</span>
                                      </div>
                                    )}
                                  </div>
                                : <span style={{ color: "#d1d5db" }}>—</span>}
                            </td>
                            {/* 원금액 */}
                            <td style={{ ...tableTd, fontWeight: 700, color: "#0891b2", whiteSpace: "nowrap" }}>
                              {Math.round(gross).toLocaleString()}원
                            </td>
                            {/* 원천세 */}
                            <td style={{ ...tableTd, fontSize: 12, color: "#b45309", whiteSpace: "nowrap" }}>
                              {withholding > 0
                                ? <><div>{Math.round(withholding).toLocaleString()}원</div><div style={{ fontSize: 10, color: "#9ca3af" }}>3.3%</div></>
                                : <span style={{ color: "#d1d5db" }}>—</span>}
                            </td>
                            {/* 실지급액 */}
                            <td style={{ ...tableTd, fontWeight: 700, color: "#059669", whiteSpace: "nowrap" }}>
                              {Math.round(net).toLocaleString()}원
                            </td>
                            {/* 정산 유형 */}
                            <td style={{ ...tableTd, fontSize: 12 }}>
                              {s.settlementType
                                ? <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                                    background: s.settlementType === "WITHHOLDING_3_3" ? "#ede9fe" : s.settlementType === "VAT_INVOICE" ? "#dbeafe" : s.settlementType === "OVERSEAS_REMITTANCE" ? "#fef3c7" : "#f3f4f6",
                                    color: s.settlementType === "WITHHOLDING_3_3" ? "#7c3aed" : s.settlementType === "VAT_INVOICE" ? "#2563eb" : s.settlementType === "OVERSEAS_REMITTANCE" ? "#b45309" : "#6b7280",
                                  }}>{STYPE_KO[s.settlementType] ?? s.settlementType}</span>
                                : <span style={{ color: "#d1d5db" }}>—</span>}
                            </td>
                            {/* 상태 */}
                            <td style={tableTd}>
                              <StatusBadge status={s.status} />
                              {s.status === "pending_review" && s.reviewReason && (
                                <div style={{ fontSize: 10, color: "#b45309", marginTop: 3, maxWidth: 120, lineHeight: 1.3 }} title={s.reviewReason}>
                                  {s.reviewReason.length > 30 ? s.reviewReason.slice(0, 30) + "…" : s.reviewReason}
                                </div>
                              )}
                            </td>
                            {/* 액션 */}
                            <td style={{ ...tableTd, minWidth: 180 }}>
                              {s.status === "pending_review" && (
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                  <button type="button"
                                    onClick={() => runSettlementApprove(s.id)}
                                    disabled={approving === s.id}
                                    style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, border: "none", cursor: approving === s.id ? "not-allowed" : "pointer",
                                      background: approving === s.id ? "#fde68a" : "#f59e0b", color: "#fff", whiteSpace: "nowrap" }}>
                                    {approving === s.id ? "처리 중..." : "✓ 승인"}
                                  </button>
                                </div>
                              )}
                              {s.status === "ready" && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  {isEditing ? (
                                    <input autoFocus value={editingMemo!.value}
                                      onChange={e => setEditingMemo({ id: s.id, value: e.target.value })}
                                      onKeyDown={e => {
                                        if (e.key === "Enter") runSettlementPay(s.id, editingMemo!.value);
                                        if (e.key === "Escape") setEditingMemo(null);
                                      }}
                                      placeholder="지급 메모 (Enter 확인)"
                                      style={{ ...inputStyle, fontSize: 12, padding: "4px 8px", width: "100%", boxSizing: "border-box" as const }}
                                    />
                                  ) : (
                                    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                                      <button type="button" onClick={() => setEditingMemo({ id: s.id, value: s.paymentMemo ?? "" })} style={{
                                        padding: "4px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer",
                                        background: "#f3f4f6", border: "1px solid #e5e7eb", color: "#374151", whiteSpace: "nowrap" }}>메모</button>
                                      <button type="button" onClick={() => runSettlementPay(s.id, s.paymentMemo ?? undefined)} disabled={paying === s.id} style={{
                                        padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, border: "none", whiteSpace: "nowrap",
                                        cursor: paying === s.id ? "not-allowed" : "pointer",
                                        background: paying === s.id ? "#86efac" : "#059669", color: "#fff" }}>
                                        {paying === s.id ? "처리 중..." : "지급 완료"}
                                      </button>
                                    </div>
                                  )}
                                  {s.paymentMemo && !isEditing && (
                                    <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }} title={s.paymentMemo}>{s.paymentMemo}</div>
                                  )}
                                </div>
                              )}
                              {s.status === "paid" && (
                                <div>
                                  <span style={{ color: "#059669", fontSize: 12, fontWeight: 600 }}>✓ 완료</span>
                                  {(s.paidAt ?? s.paidDate) && <div style={{ fontSize: 10, color: "#9ca3af" }}>{new Date(s.paidAt ?? s.paidDate!).toLocaleDateString("ko-KR")}</div>}
                                  {s.paymentMemo && <div style={{ fontSize: 11, color: "#9ca3af", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.paymentMemo}>{s.paymentMemo}</div>}
                                </div>
                              )}
                              {(s.status === "pending" || s.status === "draft") && (
                                <span style={{ color: "#9ca3af", fontSize: 12 }}>대기 중</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </Section>
        );
      })()}

      {/* ── 사용자 관리 탭 ── */}
      {adminTab === "users" && (
        <Section title={`사용자 관리 (${users.length}명${userRoleFilter !== "all" ? ` · ${{"admin":"관리자","staff":"직원","client":"고객","linguist":"통번역사"}[userRoleFilter] ?? userRoleFilter}` : ""})`} action={
          <PrimaryBtn
            onClick={() => { setShowCreateStaff(v => !v); }}
            style={{ fontSize: 13, padding: "7px 14px", background: showCreateStaff ? "#6b7280" : "#1d4ed8" }}>
            {showCreateStaff ? "✕ 닫기" : "+ 직원 등록"}
          </PrimaryBtn>
        }>

          {/* ── 내부 직원 등록 폼 ── */}
          {showCreateStaff && (
            <Card style={{ marginBottom: 18, padding: "20px 24px", border: "2px solid #dbeafe", background: "#f8faff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#1d4ed8" }}>내부 직원 등록</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
                  background: "#dbeafe", color: "#1d4ed8",
                }}>내부 전용 — 고객/통번역사 등록과 별개입니다</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px" }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>이름 *</label>
                  <input
                    value={newStaff.name}
                    onChange={e => setNewStaff(f => ({ ...f, name: e.target.value }))}
                    placeholder="홍길동"
                    style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", width: "100%", boxSizing: "border-box" as const }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>이메일 *</label>
                  <input
                    value={newStaff.email}
                    onChange={e => setNewStaff(f => ({ ...f, email: e.target.value }))}
                    placeholder="hong@company.com"
                    type="email"
                    style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", width: "100%", boxSizing: "border-box" as const }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>초기 비밀번호 * (6자 이상)</label>
                  <input
                    value={newStaff.password}
                    onChange={e => setNewStaff(f => ({ ...f, password: e.target.value }))}
                    placeholder="••••••••"
                    type="password"
                    style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", width: "100%", boxSizing: "border-box" as const }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>역할 *</label>
                  <ClickSelect
                    value={newStaff.role}
                    onChange={v => setNewStaff(f => ({ ...f, role: v as "admin" | "staff" }))}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 13, padding: "8px 10px", borderRadius: 8 }}
                    options={[
                      { value: "staff", label: "직원 (staff)" },
                      { value: "admin", label: "관리자 (admin)" },
                    ]}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>부서</label>
                  <input
                    value={newStaff.department}
                    onChange={e => setNewStaff(f => ({ ...f, department: e.target.value }))}
                    placeholder="예: 운영팀, PM팀, 영업팀"
                    style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", width: "100%", boxSizing: "border-box" as const }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>직책</label>
                  <input
                    value={newStaff.jobTitle}
                    onChange={e => setNewStaff(f => ({ ...f, jobTitle: e.target.value }))}
                    placeholder="예: PM, 운영담당, 정산담당"
                    style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", width: "100%", boxSizing: "border-box" as const }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
                <PrimaryBtn onClick={handleCreateStaff} disabled={creatingStaff} style={{ fontSize: 13, padding: "9px 20px" }}>
                  {creatingStaff ? "등록 중..." : "직원 등록"}
                </PrimaryBtn>
                <GhostBtn onClick={() => { setShowCreateStaff(false); setNewStaff({ name: "", email: "", password: "", department: "", jobTitle: "", role: "staff", isActive: true }); }} style={{ fontSize: 13, padding: "9px 14px" }}>
                  취소
                </GhostBtn>
                <span style={{ fontSize: 12, color: "#9ca3af", marginLeft: 8 }}>* 등록 후 사용자 목록에 즉시 반영됩니다</span>
              </div>
            </Card>
          )}

          {/* ── 접속 통계 패널 ── */}
          {(() => {
            const PERIOD_LABELS: Record<string,string> = { today: "오늘", week: "이번 주", month: "이번 달", year: "올해" };
            const ROLE_COLORS: Record<string,string> = { admin: "#7c3aed", staff: "#0891b2", client: "#059669", linguist: "#d97706", customer: "#059669", translator: "#d97706" };
            const ROLE_NAMES: Record<string,string> = { admin: "관리자", staff: "직원", client: "고객", linguist: "통번역사", customer: "고객", translator: "통번역사" };
            return (
              <div style={{ marginBottom: 18 }}>
                {/* 상단: 요약 카드 + 통계 토글 버튼 */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  {/* 현재 온라인 */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: "8px 14px" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 4px #22c55e" }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#166534" }}>현재 온라인</span>
                    <span style={{ fontSize: 16, fontWeight: 800, color: "#16a34a" }}>{activityStats?.summary.currentlyOnline ?? users.filter(u => u.isOnline).length}명</span>
                  </div>
                  {/* 기간별 요약 */}
                  {(["today","week","month","year"] as const).map(p => (
                    <div key={p} style={{
                      background: activityPeriod === p ? "#eff6ff" : "#f9fafb",
                      border: `1px solid ${activityPeriod === p ? "#93c5fd" : "#e5e7eb"}`,
                      borderRadius: 10, padding: "8px 14px", cursor: "pointer",
                      transition: "all 0.12s",
                    }} onClick={() => { setActivityPeriod(p); fetchActivityStats(p); }}>
                      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>{PERIOD_LABELS[p]} 접속자</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: activityPeriod === p ? "#1d4ed8" : "#374151" }}>
                        {activityStats?.summary[p] ?? "—"}명
                      </div>
                    </div>
                  ))}
                  <button
                    onClick={() => setShowActivityStats(v => !v)}
                    style={{ marginLeft: "auto", padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: showActivityStats ? "#f3f4f6" : "#fff", fontSize: 12, color: "#374151", cursor: "pointer", fontWeight: 600 }}>
                    {showActivityStats ? "▲ 통계 접기" : "▼ 상세 통계"}
                  </button>
                </div>

                {/* 상세 통계 패널 */}
                {showActivityStats && (
                  <Card style={{ marginBottom: 14, padding: "16px 20px", background: "#fafafa", border: "1px solid #e5e7eb" }}>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                      {/* 역할별 접속 분포 */}
                      <div style={{ flex: "1 1 200px" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>역할별 접속 분포 ({PERIOD_LABELS[activityPeriod]})</div>
                        {(activityStats?.byRole ?? []).length === 0
                          ? <div style={{ fontSize: 12, color: "#9ca3af" }}>데이터 없음</div>
                          : (activityStats?.byRole ?? []).map(r => (
                            <div key={r.roleType} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: ROLE_COLORS[r.roleType] + "22", color: ROLE_COLORS[r.roleType] ?? "#374151" }}>
                                {ROLE_NAMES[r.roleType] ?? r.roleType}
                              </span>
                              <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{r.count}명</span>
                            </div>
                          ))
                        }
                      </div>
                      {/* 사용자별 이용 현황 */}
                      <div style={{ flex: "2 1 320px" }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>사용자별 누적 이용 현황 (TOP 20)</div>
                        {userStats.length === 0
                          ? <div style={{ fontSize: 12, color: "#9ca3af" }}>데이터 없음 (로그인 후 집계됩니다)</div>
                          : (
                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                                <thead>
                                  <tr style={{ background: "#f3f4f6" }}>
                                    {["사용자","역할","로그인 횟수","총 이용시간","마지막 로그인"].map(h => (
                                      <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: 700, color: "#374151", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {userStats.map(s => (
                                    <tr key={s.userId} style={{ borderTop: "1px solid #f3f4f6" }}>
                                      <td style={{ padding: "5px 10px", whiteSpace: "nowrap" }}>
                                        <div style={{ fontWeight: 600, color: "#111827" }}>{s.user?.name ?? "—"}</div>
                                        <div style={{ fontSize: 11, color: "#9ca3af" }}>{s.user?.email}</div>
                                      </td>
                                      <td style={{ padding: "5px 10px" }}>
                                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: ROLE_COLORS[s.user?.role ?? ""] + "22", color: ROLE_COLORS[s.user?.role ?? ""] ?? "#374151" }}>
                                          {ROLE_NAMES[s.user?.role ?? ""] ?? s.user?.role}
                                        </span>
                                      </td>
                                      <td style={{ padding: "5px 10px", fontWeight: 700, color: "#1d4ed8" }}>{s.loginCount}회</td>
                                      <td style={{ padding: "5px 10px", color: "#374151" }}>
                                        {s.totalActiveMinutes >= 60
                                          ? `${Math.floor(s.totalActiveMinutes/60)}시간 ${s.totalActiveMinutes%60}분`
                                          : `${s.totalActiveMinutes}분`
                                        }
                                      </td>
                                      <td style={{ padding: "5px 10px", color: "#6b7280", whiteSpace: "nowrap" }}>
                                        {s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString("ko-KR", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )
                        }
                      </div>
                    </div>
                  </Card>
                )}
              </div>
            );
          })()}

          {/* ── 사용자 유형 필터 탭 ── */}
          {(() => {
            const ROLE_TABS: { value: string; label: string; color: string; bg: string; activeBg: string }[] = [
              { value: "all",      label: "전체",    color: "#374151", bg: "#f3f4f6", activeBg: "#1d4ed8" },
              { value: "admin",    label: "관리자",  color: "#374151", bg: "#f3f4f6", activeBg: "#7c3aed" },
              { value: "staff",    label: "직원",    color: "#374151", bg: "#f3f4f6", activeBg: "#0891b2" },
              { value: "client",   label: "고객",    color: "#374151", bg: "#f3f4f6", activeBg: "#059669" },
              { value: "linguist", label: "통번역사", color: "#374151", bg: "#f3f4f6", activeBg: "#d97706" },
            ];
            return (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", marginRight: 4, whiteSpace: "nowrap" }}>사용자 유형</span>
                  {ROLE_TABS.map(tab => {
                    const isActive = userRoleFilter === tab.value;
                    return (
                      <button
                        key={tab.value}
                        onClick={() => setUserRoleFilter(tab.value)}
                        style={{
                          padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: isActive ? 700 : 500,
                          border: isActive ? `2px solid ${tab.activeBg}` : "2px solid #e5e7eb",
                          background: isActive ? tab.activeBg : "#fff",
                          color: isActive ? "#fff" : "#374151",
                          cursor: "pointer", transition: "all 0.12s", whiteSpace: "nowrap",
                        }}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    value={userSearch} onChange={e => setUserSearch(e.target.value)}
                    placeholder="이름·이메일·부서·직책 검색..."
                    onKeyDown={e => e.key === "Enter" && fetchUsers()}
                    style={{
                      flex: "1 1 200px", maxWidth: 300, padding: "8px 12px", borderRadius: 8,
                      border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
                      outline: "none", boxSizing: "border-box" as const, background: "#fff",
                    }}
                  />
                  <PrimaryBtn onClick={fetchUsers} disabled={usersLoading} style={{ padding: "8px 18px", fontSize: 13 }}>
                    {usersLoading ? "검색 중..." : "검색"}
                  </PrimaryBtn>
                  {(userSearch.trim() || userRoleFilter !== "all") && (
                    <button
                      onClick={() => { setUserSearch(""); setUserRoleFilter("all"); }}
                      style={{
                        background: "none", border: "1px solid #d1d5db", borderRadius: 8,
                        padding: "7px 12px", fontSize: 12, color: "#6b7280", cursor: "pointer",
                      }}>
                      초기화
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {usersLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : users.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>사용자가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","이메일/이름","유형","부서/직책","상태","접속","마지막 로그인","마지막 활동","가입일","시스템 권한(RBAC)","역할 변경","계정 상태","비밀번호","프로필"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{u.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>
                          {u.name && <div style={{ fontWeight: 700, marginBottom: 2 }}>{u.name}</div>}
                          <div style={{ fontSize: 12, color: u.name ? "#6b7280" : "#111827" }}>{u.email}</div>
                        </td>
                        <td style={tableTd}><RoleBadge role={u.role} /></td>
                        <td style={tableTd}>
                          {(u.role === "admin" || u.role === "staff") ? (
                            <div style={{ fontSize: 12 }}>
                              {u.department && <div style={{ fontWeight: 600, color: "#374151" }}>{u.department}</div>}
                              {u.jobTitle && <div style={{ color: "#6b7280" }}>{u.jobTitle}</div>}
                              {!u.department && !u.jobTitle && <span style={{ color: "#d1d5db" }}>—</span>}
                            </div>
                          ) : (
                            <span style={{ fontSize: 11, color: "#d1d5db" }}>—</span>
                          )}
                        </td>
                        <td style={tableTd}>
                          <span style={{
                            padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                            background: u.isActive ? "#f0fdf4" : "#fef2f2",
                            color: u.isActive ? "#059669" : "#dc2626",
                          }}>
                            {u.isActive ? "활성" : "비활성"}
                          </span>
                        </td>
                        {/* 접속 상태 */}
                        <td style={{ ...tableTd, textAlign: "center" }}>
                          {u.isOnline ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 20, background: "#f0fdf4", border: "1px solid #86efac", fontSize: 11, fontWeight: 700, color: "#16a34a" }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 3px #22c55e" }} />온라인
                            </span>
                          ) : (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 20, background: "#f3f4f6", border: "1px solid #e5e7eb", fontSize: 11, fontWeight: 600, color: "#9ca3af" }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d1d5db" }} />오프라인
                            </span>
                          )}
                        </td>
                        {/* 마지막 로그인 */}
                        <td style={{ ...tableTd, fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>
                          {u.lastLoginAt ? (() => {
                            const d = new Date(u.lastLoginAt);
                            const now = new Date();
                            const diff = now.getTime() - d.getTime();
                            const mins = Math.floor(diff / 60000);
                            const hours = Math.floor(mins / 60);
                            const days = Math.floor(hours / 24);
                            if (mins < 1) return "방금";
                            if (mins < 60) return `${mins}분 전`;
                            if (hours < 24) return `오늘 ${d.toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" })}`;
                            if (days < 7) return `${days}일 전`;
                            return d.toLocaleDateString("ko-KR", { month:"2-digit", day:"2-digit" });
                          })() : <span style={{ color: "#d1d5db" }}>—</span>}
                        </td>
                        {/* 마지막 활동 */}
                        <td style={{ ...tableTd, fontSize: 11, color: "#6b7280", whiteSpace: "nowrap" }}>
                          {u.lastActivityAt ? (() => {
                            const d = new Date(u.lastActivityAt);
                            const diff = Date.now() - d.getTime();
                            const mins = Math.floor(diff / 60000);
                            const hours = Math.floor(mins / 60);
                            if (mins < 1) return "방금";
                            if (mins < 60) return `${mins}분 전`;
                            if (hours < 24) return `${hours}시간 전`;
                            return d.toLocaleDateString("ko-KR", { month:"2-digit", day:"2-digit" });
                          })() : <span style={{ color: "#d1d5db" }}>—</span>}
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {new Date(u.createdAt).toLocaleDateString("ko-KR")}
                        </td>
                        {/* 시스템 권한(RBAC) — admin/staff에만 표시 */}
                        <td style={tableTd}>
                          {(u.role === "admin" || u.role === "staff") ? (
                            <ClickSelect
                              disabled={roleChanging === u.id}
                              value={String(u.roleId ?? "")}
                              onChange={async (val) => {
                                setRoleChanging(u.id);
                                try {
                                  const rid = val ? Number(val) : null;
                                  const res = await fetch(api(`/api/admin/users/${u.id}/rbac-role`), {
                                    method: "PATCH",
                                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                                    body: JSON.stringify({ roleId: rid }),
                                  });
                                  if (!res.ok) { setToast("권한 지정 실패"); return; }
                                  setUsers(prev => prev.map(x => x.id === u.id ? { ...x, roleId: rid } as AdminUser : x));
                                  setToast("RBAC 권한이 변경되었습니다.");
                                } finally { setRoleChanging(null); }
                              }}
                              options={[
                                { value: "", label: u.role === "admin" && !u.roleId ? "전체 권한" : "권한 선택" },
                                ...rbacRoles.map(r => ({ value: String(r.id), label: r.name, sub: r.description ?? undefined })),
                              ]}
                              triggerStyle={{ border: "1px solid #e9d5ff", background: "#faf5ff", color: "#7c3aed", fontWeight: 700, fontSize: 12 }}
                            />
                          ) : (
                            <span style={{ fontSize: 11, color: "#d1d5db" }}>—</span>
                          )}
                        </td>
                        <td style={tableTd}>
                          {u.id !== user.id ? (
                            <ClickSelect
                              disabled={roleChanging === u.id}
                              value={u.role}
                              onChange={val => handleRoleChange(u.id, val)}
                              options={[
                                { value: "admin", label: "관리자" },
                                { value: "staff", label: "직원" },
                                { value: "client", label: "고객" },
                                { value: "linguist", label: "통번역사" },
                              ]}
                              triggerStyle={{ fontSize: 12 }}
                            />
                          ) : (
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>본인 계정</span>
                          )}
                        </td>
                        <td style={tableTd}>
                          {u.id !== user.id ? (
                            <button
                              onClick={() => handleToggleActive(u.id)}
                              disabled={toggling === u.id}
                              style={{
                                padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600,
                                cursor: toggling === u.id ? "not-allowed" : "pointer",
                                background: u.isActive ? "#fef2f2" : "#f0fdf4",
                                color: u.isActive ? "#dc2626" : "#059669",
                                border: `1px solid ${u.isActive ? "#fca5a5" : "#86efac"}`,
                              }}>
                              {toggling === u.id ? "처리 중..." : u.isActive ? "비활성화" : "활성화"}
                            </button>
                          ) : (
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>본인</span>
                          )}
                        </td>
                        <td style={tableTd}>
                          <button
                            onClick={() => { setResetPwUserId(u.id); setResetPwInput(""); }}
                            style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, fontWeight: 600, cursor: "pointer", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                            재설정
                          </button>
                        </td>
                        <td style={tableTd}>
                          {u.role === "translator" ? (
                            <button onClick={() => setTranslatorProfileModal({ userId: u.id, email: u.email })}
                              style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, cursor: "pointer", background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe" }}>
                              프로필
                            </button>
                          ) : <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 고객 관리 탭 ── */}
      {adminTab === "customers" && (
        <Section title={`고객 관리 (${customers.length})`} action={
          <PrimaryBtn onClick={() => setShowCreateCustomer(v => !v)} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showCreateCustomer ? "취소" : "+ 고객 등록"}
          </PrimaryBtn>
        }>
          {/* 고객 등록 폼 */}
          {showCreateCustomer && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>새 고객 등록</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                {([
                  ["companyName", "회사명 *"],
                  ["contactName", "담당자명 *"],
                  ["email", "이메일 *"],
                  ["phone", "전화번호"],
                ] as const).map(([field, label]) => (
                  <div key={field}>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{label}</label>
                    <input
                      value={newCustomer[field]}
                      onChange={e => setNewCustomer(f => ({ ...f, [field]: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                      placeholder={label.replace(" *", "")}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryBtn onClick={handleCreateCustomer} disabled={creatingCustomer} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {creatingCustomer ? "등록 중..." : "등록"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowCreateCustomer(false)} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}

          {/* 검색 */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input
              value={customerSearch} onChange={e => setCustomerSearch(e.target.value)}
              placeholder="회사명, 담당자명, 이메일 검색..."
              style={{ ...inputStyle, maxWidth: 300, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchCustomers()}
            />
            <PrimaryBtn onClick={fetchCustomers} disabled={customersLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {customersLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>

          {customersLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : customers.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
              고객이 없습니다. 상단의 "+ 고객 등록" 버튼으로 추가하세요.
            </Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      {["ID","고객사","등급","프로젝트 현황","총 매출","미수금","최근 거래","등록일"].map(h => (
                        <th key={h} style={{ ...tableTh, background: "transparent", fontSize: 11, letterSpacing: "0.2px" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map(c => {
                      const grade = c.projectCount === 0
                        ? { label: "신규", bg: "#f0fdf4", color: "#16a34a", border: "#86efac" }
                        : (Number(c.totalPayment) >= 3000000 || c.projectCount >= 5)
                          ? { label: "VIP", bg: "#fdf4ff", color: "#9333ea", border: "#d8b4fe" }
                          : { label: "일반", bg: "#f8fafc", color: "#64748b", border: "#cbd5e1" };
                      const lastDate = c.lastTransactionAt
                        ? new Date(c.lastTransactionAt).toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\. /g, ".").replace(/\.$/, "")
                        : null;
                      return (
                        <tr key={c.id}
                          onClick={() => setCustomerModal(c.id)}
                          style={{ cursor: "pointer", transition: "background 0.1s" }}
                          onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
                          onMouseLeave={e => (e.currentTarget.style.background = "")}>

                          {/* ID */}
                          <td style={{ ...tableTd, color: "#d1d5db", fontSize: 11, width: 40 }}>#{c.id}</td>

                          {/* 고객사 + 담당자 · 연락처 */}
                          <td style={{ ...tableTd, maxWidth: 200 }}>
                            <div style={{ fontWeight: 600, fontSize: 13, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.companyName}</div>
                            <div style={{ fontSize: 11, color: "#c0c8d4", marginTop: 1 }}>
                              {c.contactName}
                              {c.phone && <span style={{ marginLeft: 6 }}>{c.phone}</span>}
                            </div>
                          </td>

                          {/* 등급 */}
                          <td style={{ ...tableTd, width: 64 }}>
                            <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, lineHeight: "18px", background: grade.bg, color: grade.color, border: `1px solid ${grade.border}` }}>
                              {grade.label}
                            </span>
                          </td>

                          {/* 프로젝트 현황 */}
                          <td style={{ ...tableTd, minWidth: 110 }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              <span style={{ fontSize: 12, color: "#374151", fontWeight: 500 }}>전체 {c.projectCount}건</span>
                              {c.inProgressCount > 0 && (
                                <span style={{ fontSize: 11, color: "#7c3aed", fontWeight: 600 }}>진행 중 {c.inProgressCount}건</span>
                              )}
                            </div>
                          </td>

                          {/* 총 매출 */}
                          <td style={{ ...tableTd, fontWeight: 600, color: "#059669", whiteSpace: "nowrap", fontSize: 12 }}>
                            {Number(c.totalPayment).toLocaleString()}원
                          </td>

                          {/* 미수금 */}
                          <td style={{ ...tableTd, width: 90 }}>
                            {Number(c.unpaidAmount) > 0
                              ? <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, lineHeight: "18px", background: "transparent", border: "1px solid #fcd34d", color: "#92400e", whiteSpace: "nowrap" }}>{Number(c.unpaidAmount).toLocaleString()}원</span>
                              : <span style={{ color: "#d1d5db", fontSize: 11 }}>-</span>}
                          </td>

                          {/* 최근 거래 */}
                          <td style={{ ...tableTd, fontSize: 11, color: lastDate ? "#6b7280" : "#d1d5db", whiteSpace: "nowrap" }}>
                            {lastDate ?? "-"}
                          </td>

                          {/* 등록일 */}
                          <td style={{ ...tableTd, fontSize: 11, color: "#c0c8d4", whiteSpace: "nowrap" }}>
                            {new Date(c.createdAt).toLocaleDateString("ko-KR")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 거래처 탭 ── */}
      {adminTab === "companies" && (
        <CompanyManagementTab
          token={token}
          onToast={setToast}
          onOpenProject={(id) => openDetail(id)}
          hasPerm={hasPerm}
        />
      )}

      {/* ── 담당자 탭 ── */}
      {adminTab === "contacts" && (
        <Section title={`담당자 관리 (${contacts.length})`} action={
          <PrimaryBtn onClick={() => { setShowCreateContactModal(true); setNewContactForm(emptyNewContactForm); setNewContactErrors({}); setCompanySearchQuery(""); }} style={{ fontSize: 13, padding: "7px 14px" }}>
            + 담당자 등록
          </PrimaryBtn>
        }>
          {/* ── 담당자 등록 모달 ── */}
          {showCreateContactModal && (
            <DraggableModal
              title="담당자 등록"
              subtitle="하나의 거래처에 여러 명의 담당자를 등록할 수 있습니다."
              onClose={() => setShowCreateContactModal(false)}
              width={560}
              zIndex={1000}
              bodyPadding="20px 24px"
            >
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {/* 거래처 선택 */}
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 6 }}>
                      거래처 선택 <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <input value={companySearchQuery}
                      onChange={e => { setCompanySearchQuery(e.target.value); setNewContactForm(p => ({ ...p, companyId: null })); }}
                      placeholder="회사명, 브랜드명 검색..."
                      style={{ ...inputStyle, fontSize: 13, padding: "8px 12px", marginBottom: 6, borderColor: newContactErrors.companyId ? "#fca5a5" : undefined }} />
                    {newContactErrors.companyId && <p style={{ margin: "0 0 6px", fontSize: 11, color: "#dc2626" }}>{newContactErrors.companyId}</p>}
                    {companySearchQuery.trim() && newContactForm.companyId === null && (
                      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, maxHeight: 180, overflowY: "auto", background: "#fff", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
                        {(() => {
                          const q = companySearchQuery.toLowerCase();
                          const filtered = companies.filter(c =>
                            c.name.toLowerCase().includes(q) ||
                            (c.divisionNames ?? []).some(d => d.toLowerCase().includes(q)) ||
                            (c.businessNumber ?? "").replace(/-/g,"").includes(q.replace(/-/g,""))
                          ).slice(0, 10);
                          if (filtered.length === 0) return <p style={{ padding: "12px 14px", color: "#9ca3af", fontSize: 13, margin: 0 }}>검색 결과가 없습니다.</p>;
                          return filtered.map(c => {
                            const matchedDiv = (c.divisionNames ?? []).find(d => d.toLowerCase().includes(q));
                            return (
                              <div key={c.id}
                                onClick={() => { setNewContactForm(p => ({ ...p, companyId: c.id })); setCompanySearchQuery(c.name); }}
                                style={{ padding: "9px 14px", cursor: "pointer", fontSize: 13, color: "#111827", borderBottom: "1px solid #f9fafb" }}
                                onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                                <span style={{ fontWeight: 600 }}>{c.name}</span>
                                {matchedDiv && <span style={{ color: "#7c3aed", fontWeight: 700, marginLeft: 4 }}>({matchedDiv})</span>}
                                {c.businessNumber && <span style={{ color: "#9ca3af", marginLeft: 8, fontSize: 12 }}>{c.businessNumber}</span>}
                              </div>
                            );
                          });
                        })()}
                      </div>
                    )}
                    {newContactForm.companyId !== null && (
                      <div style={{ padding: "8px 12px", background: "#eff6ff", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
                        <span style={{ color: "#1d4ed8", fontWeight: 600 }}>✓ {companySearchQuery}</span>
                        <button onClick={() => { setNewContactForm(p => ({ ...p, companyId: null })); setCompanySearchQuery(""); }}
                          style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 12 }}>변경</button>
                      </div>
                    )}
                  </div>

                  {/* 기본정보 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                    <div style={{ gridColumn: "1/-1" }}>
                      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>
                        담당자명 <span style={{ color: "#dc2626" }}>*</span>
                      </label>
                      <input value={newContactForm.name} onChange={e => setNewContactForm(p => ({ ...p, name: e.target.value }))}
                        placeholder="예: 홍길동"
                        style={{ ...inputStyle, fontSize: 13, padding: "8px 12px", borderColor: newContactErrors.name ? "#fca5a5" : undefined }} />
                      {newContactErrors.name && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{newContactErrors.name}</p>}
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>
                        부서
                      </label>
                      <input value={newContactForm.department} onChange={e => setNewContactForm(p => ({ ...p, department: e.target.value }))}
                        placeholder="예: 마케팅팀"
                        style={{ ...inputStyle, fontSize: 13, padding: "8px 12px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>
                        직책
                      </label>
                      <input value={newContactForm.position} onChange={e => setNewContactForm(p => ({ ...p, position: e.target.value }))}
                        placeholder="예: 과장"
                        style={{ ...inputStyle, fontSize: 13, padding: "8px 12px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>
                        휴대폰 <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>(권장)</span>
                      </label>
                      <input value={newContactForm.mobile} onChange={e => setNewContactForm(p => ({ ...p, mobile: e.target.value }))}
                        placeholder="예: 010-1234-5678"
                        style={{ ...inputStyle, fontSize: 13, padding: "8px 12px", borderColor: newContactErrors.mobile ? "#fca5a5" : undefined }} />
                      {newContactErrors.mobile && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{newContactErrors.mobile}</p>}
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>
                        이메일 <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>(권장)</span>
                      </label>
                      <input value={newContactForm.email} onChange={e => setNewContactForm(p => ({ ...p, email: e.target.value }))}
                        placeholder="예: hong@example.com"
                        style={{ ...inputStyle, fontSize: 13, padding: "8px 12px", borderColor: newContactErrors.email ? "#fca5a5" : undefined }} />
                      {newContactErrors.email && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{newContactErrors.email}</p>}
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>직장전화</label>
                      <input value={newContactForm.officePhone} onChange={e => setNewContactForm(p => ({ ...p, officePhone: e.target.value }))}
                        placeholder="예: 02-1234-5678"
                        style={{ ...inputStyle, fontSize: 13, padding: "8px 12px" }} />
                    </div>
                    <div style={{ gridColumn: "1/-1" }}>
                      <label style={{ fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4 }}>메모</label>
                      <textarea value={newContactForm.memo} onChange={e => setNewContactForm(p => ({ ...p, memo: e.target.value }))}
                        rows={2} placeholder="특이사항 등"
                        style={{ ...inputStyle, fontSize: 13, padding: "8px 12px", resize: "vertical" }} />
                    </div>
                  </div>

                  {/* 역할 체크박스 */}
                  <div style={{ background: "#f9fafb", borderRadius: 10, padding: "12px 16px" }}>
                    <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280" }}>역할 설정</p>
                    <p style={{ margin: "0 0 10px", fontSize: 11, color: "#9ca3af" }}>기본 담당자는 거래처별 1명만 지정됩니다. 견적/청구 담당자는 중복 지정 가능합니다.</p>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                      {([["isPrimary","기본 담당자","기본 연락처로 지정"],["isQuoteContact","견적 담당자","견적 발송 담당"],["isBillingContact","청구 담당자","청구 처리 담당"],["isActive","활성 상태","비활성 시 목록에서 숨김"]] as const).map(([key, label, desc]) => (
                        <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                          <input type="checkbox" checked={newContactForm[key]} onChange={e => setNewContactForm(p => ({ ...p, [key]: e.target.checked }))}
                            style={{ marginTop: 2 }} />
                          <div>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>{label}</span>
                            <p style={{ margin: "1px 0 0", fontSize: 11, color: "#9ca3af" }}>{desc}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* 저장/취소 */}
                  <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
                    <PrimaryBtn onClick={handleCreateContact} disabled={savingNewContact} style={{ flex: 1, fontSize: 14, padding: "10px" }}>
                      {savingNewContact ? "등록 중..." : "담당자 등록"}
                    </PrimaryBtn>
                    <GhostBtn onClick={() => setShowCreateContactModal(false)} style={{ fontSize: 14, padding: "10px 20px" }}>취소</GhostBtn>
                  </div>
                </div>
            </DraggableModal>
          )}

          <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 12px" }}>
            하나의 거래처에 여러 명의 담당자를 등록할 수 있습니다. 기본 담당자는 거래처별 1명만 지정됩니다.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input value={contactSearch} onChange={e => setContactSearch(e.target.value)}
              placeholder="이름, 이메일, 휴대폰, 거래처 검색..."
              style={{ ...inputStyle, maxWidth: 340, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchContacts()} />
            <PrimaryBtn onClick={fetchContacts} disabled={contactsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {contactsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {contactsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : contacts.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 담당자가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","거래처","담당자명","부서/직책","휴대폰","이메일","역할","상태","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {contacts.map(c => (
                      <tr key={c.id} onClick={() => setContactModal(c.id)} style={{ cursor: "pointer", opacity: (c as any).isActive !== false ? 1 : 0.6 }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.companyName ?? "-"}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{c.name}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>
                          {[c.department, c.position].filter(Boolean).join(" / ") || "-"}
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{(c as any).mobile ?? c.phone ?? "-"}</td>
                        <td style={{ ...tableTd, color: "#2563eb", fontSize: 12 }}>{c.email ?? "-"}</td>
                        <td style={{ ...tableTd }}>
                          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                            {(c as any).isPrimary && <span style={{ fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>기본</span>}
                            {(c as any).isQuoteContact && <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>견적</span>}
                            {(c as any).isBillingContact && <span style={{ fontSize: 10, background: "#ede9fe", color: "#5b21b6", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>청구</span>}
                          </div>
                        </td>
                        <td style={{ ...tableTd, fontSize: 12 }}>
                          <span style={{ background: (c as any).isActive !== false ? "#d1fae5" : "#f3f4f6", color: (c as any).isActive !== false ? "#065f46" : "#9ca3af", borderRadius: 4, padding: "2px 7px", fontSize: 11, fontWeight: 600 }}>
                            {(c as any).isActive !== false ? "활성" : "비활성"}
                          </span>
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(c.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 상품/단가 탭 ── */}
      {adminTab === "products" && (
        <ProductManagementTab
          token={token}
          user={user}
          hasPerm={hasPerm}
          setToast={setToast}
          authHeaders={authHeaders}
        />
      )}

      {/* ── 게시판 탭 ── */}
      {adminTab === "board" && (
        <Section title={`게시판 (${boardPosts.length})`} action={
          <PrimaryBtn onClick={() => setShowBoardForm(v => !v)} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showBoardForm ? "취소" : "+ 글 작성"}
          </PrimaryBtn>
        }>
          {showBoardForm && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>게시물 작성</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>카테고리</label>
                  <ClickSelect
                    value={boardForm.category}
                    onChange={v => setBoardForm(p => ({ ...p, category: v }))}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[
                      { value: "notice", label: "공지" },
                      { value: "reference", label: "통역자료" },
                      { value: "manual", label: "내부매뉴얼" },
                    ]}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>제목 *</label>
                  <input value={boardForm.title} onChange={e => setBoardForm(p => ({ ...p, title: e.target.value }))}
                    style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px" }} />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>내용 *</label>
                <textarea value={boardForm.content} onChange={e => setBoardForm(p => ({ ...p, content: e.target.value }))}
                  rows={5} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
              </div>
              <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={boardForm.pinned} onChange={e => setBoardForm(p => ({ ...p, pinned: e.target.checked }))} />
                  상단 고정
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={boardForm.visibleToAll} onChange={e => setBoardForm(p => ({ ...p, visibleToAll: e.target.checked }))} />
                  통번역사에게 공개
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryBtn onClick={handleSaveBoardPost} disabled={savingBoard} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {savingBoard ? "등록 중..." : "등록"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowBoardForm(false)} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            {[{ v: "all", l: "전체" }, { v: "notice", l: "공지" }, { v: "reference", l: "통역자료" }, { v: "manual", l: "내부매뉴얼" }].map(({ v, l }) => (
              <button key={v} onClick={() => setBoardCategory(v)}
                style={{ padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                  background: boardCategory === v ? "#2563eb" : "#f3f4f6", color: boardCategory === v ? "#fff" : "#374151" }}>
                {l}
              </button>
            ))}
          </div>

          {boardLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : boardPosts.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>게시물이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["","분류","제목","작성자","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {boardPosts.map(post => (
                      <tr key={post.id} onClick={() => setBoardPostModal(post)} style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, width: 30 }}>
                          {post.pinned && <span style={{ fontSize: 14 }}>📌</span>}
                        </td>
                        <td style={tableTd}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, background: "#eff6ff", color: "#2563eb", fontSize: 11, fontWeight: 700 }}>
                              {BOARD_CATEGORY_LABEL[post.category] ?? post.category}
                            </span>
                            {post.visibleToAll && <span style={{ padding: "2px 8px", borderRadius: 10, background: "#f0fdf4", color: "#059669", fontSize: 11, fontWeight: 700 }}>공개</span>}
                          </div>
                        </td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{post.title}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{post.authorEmail ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(post.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 통번역사 탭 ── */}
      {adminTab === "translators" && (
        <Section title={`통번역사 관리 (${translatorList.length})`} action={
          <PrimaryBtn onClick={() => setShowTranslatorCreateModal(true)} style={{ padding: "8px 16px", fontSize: 13 }}>
            + 통번역사 등록
          </PrimaryBtn>
        }>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input value={translatorSearch} onChange={e => setTranslatorSearch(e.target.value)}
              placeholder="이름, 이메일, 언어쌍, 지역 검색..."
              style={{ ...inputStyle, maxWidth: 240, flex: "1 1 180px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchTranslators()} />
            <input value={translatorLangFilter} onChange={e => setTranslatorLangFilter(e.target.value)}
              placeholder="언어쌍 (예: 한→영)"
              style={{ ...inputStyle, maxWidth: 150, padding: "8px 12px", fontSize: 13 }} />
            <ClickSelect
              value={translatorGradeFilter}
              onChange={setTranslatorGradeFilter}
              triggerStyle={{ fontSize: 13, padding: "8px 12px", minWidth: 90, borderRadius: 8 }}
              options={[{ value: "all", label: "전체 등급" }, ...["S","A","B","C"].map(g => ({ value: g, label: `${g}등급` }))]}
            />
            <ClickSelect
              value={translatorStatusFilter}
              onChange={setTranslatorStatusFilter}
              triggerStyle={{ fontSize: 13, padding: "8px 12px", minWidth: 100, borderRadius: 8 }}
              options={[
                { value: "all", label: "전체 상태" }, { value: "available", label: "가능" },
                { value: "busy", label: "바쁨" }, { value: "unavailable", label: "불가" },
              ]}
            />
            <input value={translatorRatingFilter} onChange={e => setTranslatorRatingFilter(e.target.value)}
              placeholder="최소 평점"
              style={{ ...inputStyle, maxWidth: 100, padding: "8px 12px", fontSize: 13 }} />
            <PrimaryBtn onClick={fetchTranslators} disabled={translatorsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {translatorsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {translatorsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : translatorList.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "40px 32px" }}>
              <div style={{ color: "#9ca3af", fontSize: 14, marginBottom: 12 }}>등록된 통번역사가 없습니다.</div>
              <PrimaryBtn onClick={() => setShowTranslatorCreateModal(true)} style={{ fontSize: 13, padding: "8px 20px" }}>
                + 첫 통번역사 등록
              </PrimaryBtn>
            </Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","이름 / 이메일","등급","언어쌍","전문분야","지역","대표 단가","평점","상태","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {translatorList.map(t => {
                      const statusColor = t.availabilityStatus === "available" ? "#059669" : t.availabilityStatus === "busy" ? "#d97706" : "#dc2626";
                      const statusBg = t.availabilityStatus === "available" ? "#f0fdf4" : t.availabilityStatus === "busy" ? "#fffbeb" : "#fef2f2";
                      const gradeColor: Record<string, { bg: string; color: string }> = {
                        S: { bg: "#fef3c7", color: "#92400e" },
                        A: { bg: "#ede9fe", color: "#5b21b6" },
                        B: { bg: "#dbeafe", color: "#1e40af" },
                        C: { bg: "#f3f4f6", color: "#374151" },
                      };
                      const gc = t.grade && gradeColor[t.grade] ? gradeColor[t.grade] : null;
                      return (
                        <tr key={t.id} onClick={() => setTranslatorDetailModal({ userId: t.id, email: t.email })} style={{ cursor: "pointer" }}
                          onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          <td style={{ ...tableTd, color: "#9ca3af", whiteSpace: "nowrap" }}>#{t.id}</td>
                          <td style={{ ...tableTd, minWidth: 130 }}>
                            {t.name
                              ? <><span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>{t.name}</span><br /><span style={{ color: "#6b7280", fontSize: 11 }}>{t.email}</span></>
                              : <span style={{ fontSize: 13, color: "#374151" }}>{t.email}</span>}
                            {t.phone && <div style={{ fontSize: 11, color: "#9ca3af" }}>{t.phone}</div>}
                          </td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            {gc
                              ? <span style={{ padding: "2px 9px", borderRadius: 10, background: gc.bg, color: gc.color, fontSize: 11, fontWeight: 800 }}>{t.grade}</span>
                              : <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#374151", maxWidth: 160, whiteSpace: "normal" }}>
                            {t.languagePairs ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                                {t.languagePairs.split(",").map((lp, i) => (
                                  <span key={i} style={{ background: "#eff6ff", color: "#1d4ed8", borderRadius: 4, padding: "1px 6px", fontSize: 11, whiteSpace: "nowrap" }}>{lp.trim()}</span>
                                ))}
                              </div>
                            ) : <span style={{ color: "#d1d5db" }}>-</span>}
                            {t.education && (
                              <div style={{ marginTop: 3, fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                🎓 {t.education}
                              </div>
                            )}
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280", maxWidth: 140, whiteSpace: "normal" }}>
                            {t.specializations
                              ? <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden" }}>{t.specializations}</span>
                              : <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280", whiteSpace: "nowrap" }}>{t.region ?? "-"}</td>
                          <td style={{ ...tableTd, fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>
                            {t.ratePerWord != null
                              ? <span style={{ fontWeight: 700, color: "#059669" }}>{Number(t.ratePerWord).toLocaleString()}원<span style={{ fontWeight: 400, color: "#9ca3af" }}>/어절</span></span>
                              : t.ratePerPage != null
                                ? <span style={{ fontWeight: 700, color: "#059669" }}>{Number(t.ratePerPage).toLocaleString()}원<span style={{ fontWeight: 400, color: "#9ca3af" }}>/pg</span></span>
                                : <span style={{ color: "#d1d5db" }}>미설정</span>}
                          </td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            {t.rating != null ? <span style={{ fontWeight: 700, color: "#d97706" }}>★ {Number(t.rating).toFixed(1)}</span> : <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          <td style={{ ...tableTd, textAlign: "center", whiteSpace: "nowrap" }}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, background: statusBg, color: statusColor, fontSize: 11, fontWeight: 700 }}>
                              {AVAILABILITY_LABEL[t.availabilityStatus ?? "available"] ?? t.availabilityStatus}
                            </span>
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 환경설정 탭 ── */}
      {adminTab === "settings" && (() => {
        const sf = settingsForm;
        const set = (k: string) => (v: string | boolean) => setSettingsForm(f => ({ ...f, [k]: v }));
        const field = (label: string, key: string, placeholder = "", type = "text") => (
          <div key={key}>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>{label}</div>
            <input type={type} value={(sf as any)[key]} onChange={e => set(key)(e.target.value)}
              placeholder={placeholder} style={{ ...inputStyle, fontSize: 13 }} />
          </div>
        );
        const saveBtn = (
          <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
            <button onClick={async () => {
              setSettingsSaving(true);
              try {
                const res = await fetch(api("/api/admin/settings"), {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify(settingsForm),
                });
                if (res.ok) { setToast("설정이 저장되었습니다."); }
                else { const d = await res.json(); setToast(d.error ?? "저장 실패"); }
              } finally { setSettingsSaving(false); }
            }} disabled={settingsSaving}
              style={{ padding: "9px 24px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: settingsSaving ? 0.7 : 1 }}>
              {settingsSaving ? "저장 중…" : "💾 저장"}
            </button>
          </div>
        );
        const STABS = [
          { id: "company",    label: "🏢 공급자 정보" },
          { id: "bank",       label: "🏦 입금 계좌" },
          { id: "document",   label: "📄 문서 설정" },
          { id: "payment",    label: "💳 결제 설정" },
          { id: "settlement", label: "🧾 정산 설정" },
          { id: "insight",    label: "🤖 자동 게시" },
        ] as const;
        return (
          <Section title="환경설정">
            {/* 설정 탭 바 */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "2px solid #e5e7eb", paddingBottom: 0 }}>
              {STABS.map(t => (
                <button key={t.id} onClick={() => setSettingsTab(t.id)}
                  style={{ padding: "8px 16px", border: "none", background: "none", cursor: "pointer", fontSize: 13, fontWeight: settingsTab === t.id ? 700 : 500, color: settingsTab === t.id ? "#2563eb" : "#6b7280", borderBottom: settingsTab === t.id ? "2px solid #2563eb" : "2px solid transparent", marginBottom: -2, borderRadius: 0, whiteSpace: "nowrap" }}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* 공급자 정보 */}
            {settingsTab === "company" && (
              <Card style={{ padding: "22px 24px", maxWidth: 560 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>🏢 공급자 정보</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {field("상호명", "companyName", "예) ㈜베리타스")}
                  {field("사업자등록번호", "businessNumber", "예) 123-45-67890")}
                  {field("대표자명", "ceoName", "예) 최향미")}
                  {field("이메일", "email", "예) service@veritasco.co.kr")}
                  {field("연락처", "phone", "예) 1600-1736")}
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>주소</div>
                    <textarea value={sf.address} onChange={e => set("address")(e.target.value)}
                      placeholder="예) 인천광역시 연수구 인천타워대로 323, B동 2406호"
                      rows={2} style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
                  </div>
                </div>
                {saveBtn}
              </Card>
            )}

            {/* 입금 계좌 */}
            {settingsTab === "bank" && (
              <Card style={{ padding: "22px 24px", maxWidth: 480 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>🏦 입금 계좌</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {field("은행명", "bankName", "예) 국민은행")}
                  {field("계좌번호", "accountNumber", "예) 420401-04-111464")}
                  {field("예금주", "accountHolder", "예) ㈜베리타스")}
                </div>
                <div style={{ marginTop: 16, padding: "12px 14px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
                    💡 입금 계좌 정보는 견적서·거래명세서 PDF에 자동으로 표시됩니다.<br />
                    비워두면 계좌 정보 섹션이 PDF에서 생략됩니다.
                  </div>
                </div>
                {saveBtn}
              </Card>
            )}

            {/* 문서 설정 */}
            {settingsTab === "document" && (
              <Card style={{ padding: "22px 24px", maxWidth: 560 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>📄 문서 설정</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {field("견적 유효기간 기본값 (일)", "quoteValidityDays", "예) 14", "number")}
                  {field("기본 세율 (%)", "taxRate", "예) 10", "number")}
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>견적서 안내문</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>모든 견적서 하단에 자동 출력됩니다.</div>
                    <textarea value={sf.quoteNotes} onChange={e => set("quoteNotes")(e.target.value)}
                      placeholder={"예) 본 견적서는 발행일로부터 14일간 유효합니다.\n문의: service@veritasco.co.kr"}
                      rows={4} style={{ ...inputStyle, fontSize: 13, resize: "vertical" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>서명 이미지 URL</div>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>Object Storage에 업로드된 서명 이미지 주소를 입력하세요.</div>
                    <input value={sf.signatureImageUrl} onChange={e => set("signatureImageUrl")(e.target.value)}
                      placeholder="예) https://storage.example.com/signature.png"
                      style={{ ...inputStyle, fontSize: 13 }} />
                    {sf.signatureImageUrl && (
                      <div style={{ marginTop: 8, padding: 8, background: "#f8fafc", borderRadius: 6, border: "1px solid #e2e8f0", textAlign: "center" }}>
                        <img src={sf.signatureImageUrl} alt="서명 미리보기" style={{ maxHeight: 60, maxWidth: "100%", objectFit: "contain" }}
                          onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      </div>
                    )}
                  </div>
                </div>
                {saveBtn}
              </Card>
            )}

            {/* 결제 설정 */}
            {settingsTab === "payment" && (
              <Card style={{ padding: "22px 24px", maxWidth: 480 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>💳 결제 설정</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>기본 결제 방식</div>
                    <ClickSelect
                      value={sf.defaultBillingType}
                      onChange={v => set("defaultBillingType")(v)}
                      triggerStyle={{ fontSize: 13, borderRadius: 8 }}
                      options={[
                        { value: "postpaid_per_project", label: "건별 후불" },
                        { value: "prepaid_wallet", label: "선입금" },
                        { value: "monthly_billing", label: "누적 청구 (월정산)" },
                      ]}
                    />
                  </div>
                  {field("결제 기한 (일)", "paymentDueDays", "예) 7", "number")}
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>부분입금 허용</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                      <input type="checkbox" checked={sf.allowPartialPayment}
                        onChange={e => set("allowPartialPayment")(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: "pointer" }} />
                      <span>부분입금을 허용합니다 (미수금 처리 가능)</span>
                    </label>
                    <div style={{ marginTop: 6, fontSize: 11, color: "#9ca3af" }}>
                      활성화 시 총액보다 적은 금액으로도 결제 처리가 가능합니다.
                    </div>
                  </div>
                </div>
                {saveBtn}
              </Card>
            )}

            {/* 정산 설정 */}
            {settingsTab === "settlement" && (
              <Card style={{ padding: "22px 24px", maxWidth: 480 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>🧾 정산 설정</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {field("정산 비율 (%)", "settlementRatio", "예) 70", "number")}
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 3 }}>정산 주기</div>
                    <ClickSelect
                      value={sf.settlementCycle}
                      onChange={v => set("settlementCycle")(v)}
                      triggerStyle={{ fontSize: 13, borderRadius: 8 }}
                      options={[
                        { value: "weekly", label: "주간 (매주)" },
                        { value: "biweekly", label: "격주" },
                        { value: "monthly", label: "월간 (매월)" },
                      ]}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>3.3% 원천세 적용</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                      <input type="checkbox" checked={sf.applyWithholdingTax}
                        onChange={e => set("applyWithholdingTax")(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: "pointer" }} />
                      <span>3.3% 원천세를 정산 금액에서 공제합니다</span>
                    </label>
                    <div style={{ marginTop: 6, padding: "10px 12px", background: "#fefce8", borderRadius: 6, border: "1px solid #fde68a" }}>
                      <div style={{ fontSize: 11, color: "#92400e", lineHeight: 1.6 }}>
                        ⚠️ 원천세 적용 시 정산 금액 = 지급액 × 정산비율 × (1 − 3.3%)<br />
                        프리랜서(개인 사업자가 아닌 통번역사)에게 지급 시 원천징수 의무가 발생합니다.
                      </div>
                    </div>
                  </div>
                </div>
                {saveBtn}
              </Card>
            )}

            {/* 자동 게시 설정 */}
            {settingsTab === "insight" && (
              <Card style={{ padding: "22px 24px", maxWidth: 560 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827", marginBottom: 4, paddingBottom: 10, borderBottom: "1px solid #f0f0f0" }}>
                  🤖 인사이트 자동 게시 설정
                </div>
                <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
                  조건을 충족한 인사이트를 운영자 개입 없이 자동으로 게시합니다.<br />
                  처음에는 <strong>드라이런</strong> 모드로 테스트한 뒤, 실제 게시로 전환하세요.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

                  {/* 자동 게시 활성화 */}
                  <div style={{ padding: "14px 16px", background: sf.autoPublishEnabled ? "#f0fdf4" : "#f9fafb", borderRadius: 10, border: `1.5px solid ${sf.autoPublishEnabled ? "#bbf7d0" : "#e5e7eb"}` }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                      <input type="checkbox" checked={sf.autoPublishEnabled}
                        onChange={e => set("autoPublishEnabled")(e.target.checked)}
                        style={{ width: 18, height: 18, cursor: "pointer", accentColor: "#059669" }} />
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: sf.autoPublishEnabled ? "#059669" : "#374151" }}>
                          자동 게시 활성화
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                          조건 충족 인사이트를 자동으로 published 상태로 전환
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* 임계값 */}
                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6, fontWeight: 600 }}>
                      AEO 점수 기준 (autoPublishThreshold)
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <input type="number" min="0" max="100" value={sf.autoPublishThreshold}
                        onChange={e => set("autoPublishThreshold")(e.target.value)}
                        style={{ ...inputStyle, fontSize: 13, width: 90 }} />
                      <span style={{ fontSize: 12, color: "#6b7280" }}>점 이상일 때 자동 게시 (기본값: 80)</span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: "#9ca3af", lineHeight: 1.6 }}>
                      추가 필수 조건: FAQ ≥ 3개, 관련 인사이트 ≥ 2개, shortAnswer 존재, classification ≠ drop
                    </div>
                  </div>

                  {/* 드라이런 */}
                  <div style={{ padding: "14px 16px", background: sf.autoPublishDryRun ? "#fffbeb" : "#f9fafb", borderRadius: 10, border: `1.5px solid ${sf.autoPublishDryRun ? "#fde68a" : "#e5e7eb"}` }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                      <input type="checkbox" checked={sf.autoPublishDryRun}
                        onChange={e => set("autoPublishDryRun")(e.target.checked)}
                        style={{ width: 18, height: 18, cursor: "pointer", accentColor: "#d97706" }} />
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: sf.autoPublishDryRun ? "#d97706" : "#374151" }}>
                          드라이런 모드 (Dry Run)
                        </div>
                        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                          실제 게시하지 않고 로그만 기록 — 테스트 시 사용
                        </div>
                      </div>
                    </label>
                  </div>

                  {/* 현재 상태 요약 */}
                  <div style={{ padding: "12px 14px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12, color: "#374151", lineHeight: 1.8 }}>
                    <strong>현재 설정 요약:</strong><br />
                    자동 게시: <strong style={{ color: sf.autoPublishEnabled ? "#059669" : "#dc2626" }}>{sf.autoPublishEnabled ? "활성화" : "비활성화"}</strong>
                    {" · "}기준 점수: <strong>{sf.autoPublishThreshold}점</strong>
                    {" · "}드라이런: <strong style={{ color: sf.autoPublishDryRun ? "#d97706" : "#6b7280" }}>{sf.autoPublishDryRun ? "ON (로그만)" : "OFF (실제 게시)"}</strong>
                  </div>
                </div>
                {saveBtn}
              </Card>
            )}
          </Section>
        );
      })()}

      {/* ── 운영 테스트 탭 ── */}
      {adminTab === "test" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>

          {/* 시나리오 실행 패널 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#111827" }}>🧪 운영 시나리오 자동 실행</h3>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280" }}>프로젝트 생성 → 견적 → 승인 → 결제 → 통번역사 배정 → 진행 → 완료 → 정산까지 순차 실행합니다.</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#374151", display: "block", marginBottom: 3 }}>견적 금액 (원)</label>
                  <input value={scenarioAmount} onChange={e => setScenarioAmount(e.target.value)} type="number" min="10000"
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#374151", display: "block", marginBottom: 3 }}>통번역사 수익 비율 (0~1)</label>
                  <input value={scenarioRatio} onChange={e => setScenarioRatio(e.target.value)} type="number" min="0" max="1" step="0.1"
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box" as const }} />
                </div>
              </div>

              {/* 실제 거래처/담당자 연결 (선택) */}
              <div style={{ background: "#f0f9ff", borderRadius: 8, padding: "10px 12px", marginBottom: 12, border: "1px solid #bae6fd" }}>
                <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#0369a1" }}>실제 거래처 연결 (선택 — 미선택 시 테스트 데이터로 생성)</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "#374151", display: "block", marginBottom: 2 }}>거래처</label>
                    <ClickSelect
                      value={scenarioCompanyId}
                      onChange={v => { setScenarioCompanyId(v); setScenarioContactId(""); }}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 12, padding: "6px 8px", borderRadius: 6 }}
                      options={[
                        { value: "", label: "— 테스트 거래처 —" },
                        ...(realData?.companies ?? []).map(c => ({ value: String(c.id), label: c.name })),
                      ]}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#374151", display: "block", marginBottom: 2 }}>담당자</label>
                    <ClickSelect
                      value={scenarioContactId}
                      onChange={setScenarioContactId}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 12, padding: "6px 8px", borderRadius: 6 }}
                      options={[
                        { value: "", label: "— 담당자 없음 —" },
                        ...(realData?.contacts ?? [])
                          .filter(ct => !scenarioCompanyId || ct.companyId === Number(scenarioCompanyId))
                          .map(ct => ({ value: String(ct.id), label: ct.name })),
                      ]}
                    />
                  </div>
                </div>
                {scenarioCompanyId && (
                  <p style={{ margin: "6px 0 0", fontSize: 11, color: "#0369a1" }}>
                    ✅ 실제 거래처 데이터로 프로젝트가 생성됩니다. 최소 입력 항목: 거래처 선택 완료.
                  </p>
                )}
              </div>

              <button onClick={runScenario} disabled={scenarioRunning}
                style={{ width: "100%", padding: "11px 0", background: scenarioRunning ? "#9ca3af" : "#1e3a8a", color: "#fff", border: "none", borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: scenarioRunning ? "not-allowed" : "pointer" }}>
                {scenarioRunning ? "⏳ 실행 중..." : "▶ 시나리오 실행"}
              </button>

              {/* 실제 운영 데이터 최소 입력 안내 */}
              <div style={{ marginTop: 12, padding: "10px 12px", background: "#f9fafb", borderRadius: 8, fontSize: 11, color: "#374151", lineHeight: 1.8 }}>
                <strong style={{ color: "#111827" }}>실제 프로젝트 1건 테스트 최소 요건:</strong><br/>
                ① 거래처 등록 (거래처 탭) ② 담당자 등록 (담당자 탭) ③ 통번역사 계정 + 프로필 등록 (통번역사 탭) ④ 제품 마스터 등록 (제품 탭) ⑤ 여기서 거래처/담당자 선택 후 실행
              </div>
            </div>

            {/* 실행 결과 */}
            {scenarioResult && (
              <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#111827" }}>
                    실행 결과 {scenarioResult.projectId ? `— #${scenarioResult.projectId}` : ""}
                  </h4>
                  <div style={{ display: "flex", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, background: "#f0fdf4", color: "#166534", borderRadius: 6, padding: "2px 8px" }}>✅ {scenarioResult.summary.ok}</span>
                    {scenarioResult.summary.error > 0 && <span style={{ fontSize: 12, fontWeight: 700, background: "#fef2f2", color: "#991b1b", borderRadius: 6, padding: "2px 8px" }}>❌ {scenarioResult.summary.error}</span>}
                    {scenarioResult.summary.skipped > 0 && <span style={{ fontSize: 12, fontWeight: 700, background: "#f3f4f6", color: "#6b7280", borderRadius: 6, padding: "2px 8px" }}>⏭ {scenarioResult.summary.skipped}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {scenarioResult.steps.map(s => (
                    <div key={s.step} style={{
                      display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px",
                      borderRadius: 8,
                      background: s.status === "ok" ? "#f0fdf4" : s.status === "error" ? "#fef2f2" : "#f9fafb",
                      border: `1px solid ${s.status === "ok" ? "#bbf7d0" : s.status === "error" ? "#fecaca" : "#e5e7eb"}`,
                    }}>
                      <span style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}>
                        {s.status === "ok" ? "✅" : s.status === "error" ? "❌" : "⏭"}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af" }}>Step {s.step}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{s.name}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 12, color: s.status === "error" ? "#991b1b" : "#374151", wordBreak: "break-all" }}>{s.detail}</p>
                        {s.data?.logs ? (
                          <details style={{ marginTop: 4 }}>
                            <summary style={{ fontSize: 11, color: "#6b7280", cursor: "pointer" }}>로그 보기</summary>
                            <pre style={{ margin: "4px 0 0", fontSize: 10, color: "#374151", background: "#f9fafb", borderRadius: 4, padding: "6px 8px", overflowX: "auto" }}>{JSON.stringify(s.data.logs, null, 2)}</pre>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                <p style={{ margin: "10px 0 0", fontSize: 11, color: "#9ca3af" }}>
                  {new Date(scenarioResult.startedAt).toLocaleString("ko-KR")} → {new Date(scenarioResult.finishedAt).toLocaleString("ko-KR")}
                </p>
              </div>
            )}

            {/* 시나리오 실행 이력 */}
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#111827" }}>시나리오 이력 ({scenarioHistory.length})</h4>
                <button onClick={fetchScenarioHistory} disabled={scenarioHistoryLoading}
                  style={{ fontSize: 12, color: "#2563eb", background: "none", border: "none", cursor: "pointer" }}>
                  {scenarioHistoryLoading ? "로딩..." : "새로고침"}
                </button>
              </div>
              {scenarioHistory.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>아직 실행된 시나리오가 없습니다.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {scenarioHistory.slice(0, 10).map(h => (
                    <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", background: "#f9fafb", borderRadius: 7, fontSize: 12 }}>
                      <span style={{ color: "#111827", fontWeight: 600 }}>#{h.id} {h.title.replace("[테스트] 시나리오 ", "")}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ color: "#6b7280", fontSize: 11 }}>{h.status}</span>
                        <span style={{ color: "#9ca3af", fontSize: 11 }}>{new Date(h.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* UX 피드백 패널 */}
          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#111827" }}>💬 불편한 점 메모</h3>
              <p style={{ margin: "0 0 10px", fontSize: 13, color: "#6b7280" }}>운영 테스트 중 발견한 UX 문제나 개선 아이디어를 유형별로 기록하세요.</p>
              {/* 유형 선택 */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                {FEEDBACK_TAGS.map(t => (
                  <button key={t.value} onClick={() => setFeedbackTag(t.value as FeedbackTag)}
                    style={{ padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 20, border: "1.5px solid",
                      borderColor: feedbackTag === t.value ? t.color : "#e5e7eb",
                      background: feedbackTag === t.value ? t.bg : "#fff",
                      color: feedbackTag === t.value ? t.color : "#9ca3af",
                      cursor: "pointer" }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <textarea
                value={feedbackInput} onChange={e => setFeedbackInput(e.target.value)}
                placeholder="예) 프로젝트 목록에서 상태 필터 초기화 버튼이 눈에 잘 안 띕니다..."
                rows={4}
                style={{ width: "100%", boxSizing: "border-box" as const, border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px", fontSize: 13, resize: "vertical", fontFamily: "inherit", color: "#111", outline: "none" }}
                onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitFeedback(); }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <span style={{ fontSize: 11, color: "#9ca3af" }}>Ctrl+Enter 또는 버튼으로 저장</span>
                <button onClick={submitFeedback} disabled={feedbackSubmitting || !feedbackInput.trim()}
                  style={{ padding: "7px 18px", background: feedbackSubmitting || !feedbackInput.trim() ? "#e5e7eb" : "#1e3a8a", color: feedbackSubmitting || !feedbackInput.trim() ? "#9ca3af" : "#fff", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: feedbackSubmitting || !feedbackInput.trim() ? "not-allowed" : "pointer" }}>
                  {feedbackSubmitting ? "저장 중..." : "저장"}
                </button>
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#374151" }}>
                  피드백 목록 ({feedbackList.filter(f => feedbackTagFilter === "all" || f.tag === feedbackTagFilter).length})
                </h4>
                <button onClick={fetchFeedback} disabled={feedbackLoading}
                  style={{ fontSize: 12, color: "#2563eb", background: "none", border: "none", cursor: "pointer" }}>
                  {feedbackLoading ? "로딩..." : "새로고침"}
                </button>
              </div>
              {/* 태그 필터 */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                <button onClick={() => setFeedbackTagFilter("all")}
                  style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 20, border: "1.5px solid", borderColor: feedbackTagFilter === "all" ? "#374151" : "#e5e7eb", background: feedbackTagFilter === "all" ? "#f3f4f6" : "#fff", color: feedbackTagFilter === "all" ? "#374151" : "#9ca3af", cursor: "pointer" }}>
                  전체 ({feedbackList.length})
                </button>
                {FEEDBACK_TAGS.map(t => {
                  const cnt = feedbackList.filter(f => f.tag === t.value).length;
                  if (cnt === 0) return null;
                  return (
                    <button key={t.value} onClick={() => setFeedbackTagFilter(t.value)}
                      style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 20, border: "1.5px solid",
                        borderColor: feedbackTagFilter === t.value ? t.color : "#e5e7eb",
                        background: feedbackTagFilter === t.value ? t.bg : "#fff",
                        color: feedbackTagFilter === t.value ? t.color : "#9ca3af",
                        cursor: "pointer" }}>
                      {t.label} ({cnt})
                    </button>
                  );
                })}
              </div>
              {feedbackList.filter(f => feedbackTagFilter === "all" || f.tag === feedbackTagFilter).length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>아직 저장된 피드백이 없습니다.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 520, overflowY: "auto" }}>
                  {feedbackList.filter(f => feedbackTagFilter === "all" || f.tag === feedbackTagFilter).map(f => {
                    const tagInfo = FEEDBACK_TAGS.find(t => t.value === (f.tag ?? "general")) ?? FEEDBACK_TAGS[0];
                    return (
                      <div key={f.id} style={{ background: tagInfo.bg, border: `1px solid`, borderColor: tagInfo.color + "44", borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 5 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: tagInfo.color, background: "#fff", border: `1px solid ${tagInfo.color}33`, borderRadius: 10, padding: "1px 7px" }}>{tagInfo.label}</span>
                            <span style={{ fontSize: 11, color: "#374151", fontWeight: 600 }}>{f.adminEmail ?? "관리자"}</span>
                            <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(f.createdAt).toLocaleString("ko-KR")}</span>
                          </div>
                          <button onClick={() => deleteFeedback(f.id)}
                            style={{ fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer", padding: 0 }}>삭제</button>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: "#111827", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{f.content}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 선입금 계정 원장 탭 ── */}
      {adminTab === "prepaid" && (
        <Section title="선입금 계정 원장"
          action={
            <div style={{ display: "flex", gap: 8 }}>
              <GhostBtn onClick={fetchPrepaidAccounts} style={{ fontSize: 12, padding: "6px 14px" }}>새로고침</GhostBtn>
              <PrimaryBtn onClick={() => setShowCreatePrepaidForm(true)} style={{ fontSize: 12, padding: "6px 14px" }}>
                + 선입금 계정 등록
              </PrimaryBtn>
            </div>
          }>

          {/* 신규 선입금 계정 생성 폼 */}
          {showCreatePrepaidForm && (
            <Card style={{ border: "2px solid #3b82f6", marginBottom: 20, background: "#eff6ff" }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: "#1e40af", marginBottom: 16 }}>신규 선입금 계정 등록</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>거래처 ID *</label>
                  <input value={createPrepaidForm.companyId} onChange={e => setCreatePrepaidForm(p => ({ ...p, companyId: e.target.value }))}
                    placeholder="거래처 ID (숫자)"
                    style={{ ...inputStyle, background: "#fff" }} />
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>거래처 탭에서 거래처 ID를 확인하세요</div>
                </div>
                <div>
                  <label style={labelStyle}>최초 입금액 (원) *</label>
                  <input value={createPrepaidForm.initialAmount} onChange={e => setCreatePrepaidForm(p => ({ ...p, initialAmount: e.target.value }))}
                    placeholder="예: 1000000"
                    style={{ ...inputStyle, background: "#fff" }} />
                </div>
                <div>
                  <label style={labelStyle}>입금일</label>
                  <input type="date" value={createPrepaidForm.depositDate} onChange={e => setCreatePrepaidForm(p => ({ ...p, depositDate: e.target.value }))}
                    style={{ ...inputStyle, background: "#fff" }} />
                </div>
                <div>
                  <label style={labelStyle}>메모 (선택)</label>
                  <input value={createPrepaidForm.note} onChange={e => setCreatePrepaidForm(p => ({ ...p, note: e.target.value }))}
                    placeholder="예: 2026년 1분기 선입금"
                    style={{ ...inputStyle, background: "#fff" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryBtn onClick={handleCreatePrepaidAccount} disabled={savingPrepaid}>
                  {savingPrepaid ? "저장 중..." : "계정 생성"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowCreatePrepaidForm(false)}>취소</GhostBtn>
              </div>
            </Card>
          )}

          {/* 요약 통계 */}
          {prepaidAccounts.length > 0 && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
              {[
                { label: "총 계정 수", value: `${prepaidAccounts.length}개`, color: "#2563eb", bg: "#eff6ff" },
                { label: "잔액 합계", value: `${prepaidAccounts.reduce((s, a) => s + a.currentBalance, 0).toLocaleString()}원`, color: "#15803d", bg: "#dcfce7" },
                { label: "잔액 있는 계정", value: `${prepaidAccounts.filter(a => a.currentBalance > 0).length}개`, color: "#d97706", bg: "#fef3c7" },
                { label: "총 입금 누계", value: `${prepaidAccounts.reduce((s, a) => s + a.initialAmount, 0).toLocaleString()}원`, color: "#7c3aed", bg: "#ede9fe" },
              ].map(stat => (
                <div key={stat.label} style={{ background: stat.bg, borderRadius: 10, padding: "14px 20px", minWidth: 155, flex: "1 1 155px" }}>
                  <div style={{ fontSize: 12, color: stat.color, fontWeight: 700, marginBottom: 4 }}>{stat.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* 검색 필터 */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <input value={prepaidCompanyFilter} onChange={e => setPrepaidCompanyFilter(e.target.value)}
              placeholder="거래처명 검색..." style={{ ...inputStyle, maxWidth: 280 }} />
          </div>

          {/* 계정 목록 */}
          {prepaidLoading ? (
            <div style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : prepaidAccounts.length === 0 ? (
            <Card style={{ textAlign: "center", padding: 40, color: "#9ca3af" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>💼</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>선입금 계정이 없습니다</div>
              <div style={{ fontSize: 13 }}>위의 "선입금 계정 등록" 버튼을 눌러 첫 번째 계정을 만드세요.</div>
            </Card>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
              {prepaidAccounts.filter(a => !prepaidCompanyFilter || a.companyName.toLowerCase().includes(prepaidCompanyFilter.toLowerCase())).map(account => {
                const usedAmount = account.initialAmount - account.currentBalance;
                const usagePercent = account.initialAmount > 0 ? Math.min(100, (usedAmount / account.initialAmount) * 100) : 0;
                const hasBalance = account.currentBalance > 0;
                return (
                  <div key={account.id} onClick={() => setSelectedPrepaidAccountId(account.id)}
                    style={{ background: "#fff", border: hasBalance ? "1px solid #bfdbfe" : "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", cursor: "pointer", transition: "box-shadow 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}
                    onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 4px 16px rgba(37,99,235,0.12)")}
                    onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.06)")}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15, color: "#1e40af" }}>{account.companyName}</div>
                        {account.depositDate && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>입금일: {account.depositDate}</div>}
                        {account.note && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 1 }}>{account.note}</div>}
                      </div>
                      <span style={{ background: hasBalance ? "#dcfce7" : "#f3f4f6", color: hasBalance ? "#15803d" : "#6b7280", borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>
                        {hasBalance ? "잔액 있음" : "소진"}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                      <div style={{ background: "#f0fdf4", borderRadius: 8, padding: "8px 12px" }}>
                        <div style={{ fontSize: 10, color: "#15803d", fontWeight: 600 }}>현재 잔액</div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: hasBalance ? "#15803d" : "#dc2626" }}>{account.currentBalance.toLocaleString()}원</div>
                      </div>
                      <div style={{ background: "#fef2f2", borderRadius: 8, padding: "8px 12px" }}>
                        <div style={{ fontSize: 10, color: "#dc2626", fontWeight: 600 }}>사용 금액</div>
                        <div style={{ fontSize: 17, fontWeight: 800, color: "#dc2626" }}>{usedAmount.toLocaleString()}원</div>
                      </div>
                    </div>
                    {/* 사용률 바 */}
                    <div style={{ height: 6, background: "#e5e7eb", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                      <div style={{ height: "100%", width: `${usagePercent}%`, background: usagePercent > 90 ? "#dc2626" : usagePercent > 60 ? "#f59e0b" : "#22c55e", borderRadius: 4, transition: "width 0.3s" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>최초: {account.initialAmount.toLocaleString()}원 · 사용률 {usagePercent.toFixed(0)}%</div>
                      <div style={{ fontSize: 11, color: "#2563eb", fontWeight: 600 }}>원장 보기 →</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* 선입금 원장 모달 */}
      {selectedPrepaidAccountId !== null && (
        <PrepaidLedgerModal
          accountId={selectedPrepaidAccountId}
          authHeaders={authHeaders}
          onClose={() => setSelectedPrepaidAccountId(null)}
          onUpdate={fetchPrepaidAccounts}
        />
      )}

      {/* ── 누적 청구 탭 ── */}
      {adminTab === "billing" && (
        <Section title="누적 청구 관리">
          {/* 상태 필터 */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
            {[
              { id: "all", label: "전체" },
              { id: "draft", label: "초안" },
              { id: "sent", label: "발송" },
              { id: "approved", label: "승인" },
              { id: "paid", label: "완료" },
            ].map(f => (
              <button key={f.id} onClick={() => { setBillingBatchStatusFilter(f.id); fetchBillingBatches(); }}
                style={{ padding: "6px 14px", borderRadius: 16, border: "1px solid", cursor: "pointer", fontSize: 12, fontWeight: 500,
                  background: billingBatchStatusFilter === f.id ? "#2563eb" : "#fff",
                  borderColor: billingBatchStatusFilter === f.id ? "#2563eb" : "#d1d5db",
                  color: billingBatchStatusFilter === f.id ? "#fff" : "#374151" }}>
                {f.label}
              </button>
            ))}
            <GhostBtn onClick={fetchBillingBatches} style={{ padding: "6px 14px", fontSize: 12, marginLeft: "auto" }}>새로고침</GhostBtn>
          </div>

          {billingBatchesLoading ? (
            <div style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : billingBatches.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
              누적 청구 내역이 없습니다.
            </Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["ID","거래처","청구 기간","건수","합계금액","배치상태","견적상태","생성일"].map(h => (
                        <th key={h} style={tableTh}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {billingBatches.map(b => {
                      const statusColor: Record<string, { bg: string; color: string; label: string }> = {
                        draft:    { bg: "#f3f4f6", color: "#374151", label: "초안" },
                        sent:     { bg: "#eff6ff", color: "#1d4ed8", label: "발송" },
                        approved: { bg: "#fef3c7", color: "#92400e", label: "승인" },
                        paid:     { bg: "#dcfce7", color: "#15803d", label: "완료" },
                      };
                      const sc = statusColor[b.status] ?? { bg: "#f3f4f6", color: "#374151", label: b.status };
                      const qsc = b.quoteStatus ? (statusColor[b.quoteStatus] ?? { bg: "#f3f4f6", color: "#374151", label: b.quoteStatus }) : null;
                      return (
                        <tr key={b.id}
                          onClick={() => { setAdminTab("projects"); }}
                          style={{ cursor: "pointer" }}
                          onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          <td style={{ ...tableTd, color: "#9ca3af" }}>#{b.id}</td>
                          <td style={{ ...tableTd, fontWeight: 700, color: "#2563eb" }}>{b.companyName ?? "-"}</td>
                          <td style={{ ...tableTd, fontSize: 12 }}>
                            {b.periodStart ? new Date(b.periodStart).toLocaleDateString("ko-KR") : "?"} ~{" "}
                            {b.periodEnd ? new Date(b.periodEnd).toLocaleDateString("ko-KR") : "?"}
                          </td>
                          <td style={{ ...tableTd, textAlign: "right" }}>{b.itemCount}건</td>
                          <td style={{ ...tableTd, fontWeight: 700, textAlign: "right" }}>{b.totalAmount.toLocaleString()}원</td>
                          <td style={tableTd}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>{sc.label}</span>
                          </td>
                          <td style={tableTd}>
                            {qsc ? (
                              <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: qsc.bg, color: qsc.color }}>{qsc.label}</span>
                            ) : <span style={{ color: "#d1d5db", fontSize: 11 }}>미발행</span>}
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af" }}>
                            {new Date(b.createdAt).toLocaleDateString("ko-KR")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 역할 관리 탭 ─────────────────────────────────────────────────── */}
      {adminTab === "roles" && (
        <Section title="역할 및 권한 관리">
          <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20, alignItems: "start" }}>
            {/* 좌: 역할 목록 */}
            <div>
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "14px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>역할 목록</span>
                  <button onClick={() => { setRbacCreating(v => !v); setRbacRoleName(""); setRbacRoleDesc(""); }}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: rbacCreating ? "#fef2f2" : "#f9fafb", fontSize: 12, fontWeight: 600, cursor: "pointer", color: rbacCreating ? "#dc2626" : "#374151" }}>
                    {rbacCreating ? "취소" : "+ 신규"}
                  </button>
                </div>
                {rbacCreating && (
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0", background: "#f8fafc" }}>
                    <input value={rbacRoleName} onChange={e => setRbacRoleName(e.target.value)} placeholder="역할명 *"
                      style={{ ...inputStyle, marginBottom: 6, fontSize: 13 }} />
                    <input value={rbacRoleDesc} onChange={e => setRbacRoleDesc(e.target.value)} placeholder="설명 (선택)"
                      style={{ ...inputStyle, marginBottom: 8, fontSize: 13 }} />
                    <button onClick={async () => {
                      if (!rbacRoleName.trim()) { setToast("역할명을 입력하세요."); return; }
                      const res = await fetch(api("/api/admin/roles"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: rbacRoleName.trim(), description: rbacRoleDesc.trim() || undefined }) });
                      const d = await res.json();
                      if (!res.ok) { setToast(d.error ?? "역할 생성 실패"); return; }
                      setRbacRoles(prev => [...prev, { ...d, permissionCount: 0, permissions: [] }]);
                      setRbacCreating(false); setRbacRoleName(""); setRbacRoleDesc(""); setToast("역할이 생성되었습니다.");
                    }} style={{ width: "100%", padding: "6px 0", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>저장</button>
                  </div>
                )}
                <div>
                  {rbacRoles.map(r => (
                    <div key={r.id} onClick={() => {
                      setRbacSelectedRole(r);
                      setRbacRolePerms(new Set(r.permissions));
                      fetch(api(`/api/admin/roles/${r.id}/permissions`), { headers: { Authorization: `Bearer ${token}` } })
                        .then(res => res.json()).then(keys => setRbacRolePerms(new Set(Array.isArray(keys) ? keys : [])));
                    }}
                      style={{ padding: "12px 16px", cursor: "pointer", borderBottom: "1px solid #f9fafb", background: rbacSelectedRole?.id === r.id ? "#eff6ff" : "#fff",
                        borderLeft: rbacSelectedRole?.id === r.id ? "3px solid #2563eb" : "3px solid transparent", transition: "all 0.1s" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontWeight: 600, fontSize: 13, color: rbacSelectedRole?.id === r.id ? "#1d4ed8" : "#111827" }}>{r.name}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {r.isSystem && <span style={{ fontSize: 10, padding: "1px 6px", background: "#e0e7ff", color: "#3730a3", borderRadius: 4, fontWeight: 600 }}>시스템</span>}
                          {!r.isSystem && (
                            <button onClick={async e => {
                              e.stopPropagation();
                              if (!confirm(`"${r.name}" 역할을 삭제하시겠습니까?`)) return;
                              const res = await fetch(api(`/api/admin/roles/${r.id}`), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
                              const d = await res.json();
                              if (!res.ok) { setToast(d.error ?? "삭제 실패"); return; }
                              setRbacRoles(prev => prev.filter(x => x.id !== r.id));
                              if (rbacSelectedRole?.id === r.id) setRbacSelectedRole(null);
                              setToast("역할이 삭제되었습니다.");
                            }} style={{ padding: "2px 6px", border: "1px solid #fca5a5", borderRadius: 4, background: "#fff", color: "#dc2626", fontSize: 11, cursor: "pointer" }}>삭제</button>
                          )}
                        </div>
                      </div>
                      {r.description && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#6b7280" }}>{r.description}</p>}
                      <p style={{ margin: "3px 0 0", fontSize: 11, color: "#9ca3af" }}>권한 {r.permissionCount}개</p>
                    </div>
                  ))}
                  {rbacRoles.length === 0 && <p style={{ padding: "20px 16px", color: "#9ca3af", fontSize: 13, textAlign: "center" }}>역할이 없습니다.</p>}
                </div>
              </Card>

              {/* 사용자 역할 지정 */}
              {users.length > 0 && rbacRoles.length > 0 && (
                <Card style={{ marginTop: 16, padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0" }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>사용자 역할 지정</span>
                  </div>
                  <div style={{ maxHeight: 280, overflowY: "auto" }}>
                    {users.filter(u => u.role === "admin").map(u => (
                      <div key={u.id} style={{ padding: "8px 16px", borderBottom: "1px solid #f9fafb", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <div>
                          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#374151" }}>{u.name || u.email}</p>
                          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>{u.email}</p>
                        </div>
                        <ClickSelect
                          value={String((u as any).roleId ?? "")}
                          onChange={async v => {
                            const rid = v ? Number(v) : null;
                            const res = await fetch(api(`/api/admin/users/${u.id}/rbac-role`), { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ roleId: rid }) });
                            if (!res.ok) { setToast("역할 지정 실패"); return; }
                            setToast(`${u.email} 역할 지정 완료`);
                          }}
                          triggerStyle={{ fontSize: 12, padding: "4px 8px", minWidth: 100, borderRadius: 7 }}
                          options={[
                            { value: "", label: "전체 권한" },
                            ...rbacRoles.map(r => ({ value: String(r.id), label: r.name, sub: r.description ?? undefined })),
                          ]}
                        />
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>

            {/* 우: 권한 설정 패널 */}
            <div>
              {rbacSelectedRole ? (
                <Card style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ padding: "14px 20px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f8fafc" }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>"{rbacSelectedRole.name}" 권한 설정</span>
                      {rbacSelectedRole.description && <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>{rbacSelectedRole.description}</p>}
                    </div>
                    <button onClick={async () => {
                      setRbacSaving(true);
                      try {
                        const res = await fetch(api(`/api/admin/roles/${rbacSelectedRole.id}/permissions`), { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ keys: Array.from(rbacRolePerms) }) });
                        const d = await res.json();
                        if (!res.ok) { setToast(d.error ?? "저장 실패"); return; }
                        setRbacRoles(prev => prev.map(r => r.id === rbacSelectedRole.id ? { ...r, permissionCount: d.count, permissions: Array.from(rbacRolePerms) } : r));
                        setToast("권한 설정이 저장되었습니다.");
                      } finally { setRbacSaving(false); }
                    }} disabled={rbacSaving}
                      style={{ padding: "8px 20px", background: rbacSaving ? "#93c5fd" : "#2563eb", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                      {rbacSaving ? "저장 중..." : "권한 저장"}
                    </button>
                  </div>
                  <div style={{ padding: 20 }}>
                    {/* 메뉴 권한 */}
                    <div style={{ marginBottom: 24 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#374151" }}>메뉴 접근 권한</h4>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => {
                            const menuKeys = rbacAllPerms.filter(p => p.category === "menu").map(p => p.key);
                            setRbacRolePerms(prev => { const n = new Set(prev); menuKeys.forEach(k => n.add(k)); return n; });
                          }} style={{ padding: "3px 10px", fontSize: 11, fontWeight: 600, border: "1px solid #d1d5db", borderRadius: 6, background: "#f9fafb", cursor: "pointer", color: "#374151" }}>전체 선택</button>
                          <button onClick={() => {
                            const menuKeys = new Set(rbacAllPerms.filter(p => p.category === "menu").map(p => p.key));
                            setRbacRolePerms(prev => { const n = new Set(prev); menuKeys.forEach(k => n.delete(k)); return n; });
                          }} style={{ padding: "3px 10px", fontSize: 11, fontWeight: 600, border: "1px solid #d1d5db", borderRadius: 6, background: "#f9fafb", cursor: "pointer", color: "#374151" }}>전체 해제</button>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
                        {rbacAllPerms.filter(p => p.category === "menu").map(p => (
                          <label key={p.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1px solid ${rbacRolePerms.has(p.key) ? "#3b82f6" : "#e5e7eb"}`, borderRadius: 8, cursor: "pointer", background: rbacRolePerms.has(p.key) ? "#eff6ff" : "#fff", transition: "all 0.1s" }}>
                            <input type="checkbox" checked={rbacRolePerms.has(p.key)} onChange={e => {
                              setRbacRolePerms(prev => { const n = new Set(prev); e.target.checked ? n.add(p.key) : n.delete(p.key); return n; });
                            }} style={{ width: 15, height: 15, cursor: "pointer" }} />
                            <span style={{ fontSize: 13, fontWeight: rbacRolePerms.has(p.key) ? 600 : 400, color: rbacRolePerms.has(p.key) ? "#1d4ed8" : "#374151" }}>{p.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    {/* 기능 권한 */}
                    <div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#374151" }}>기능 실행 권한</h4>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => {
                            const actionKeys = rbacAllPerms.filter(p => p.category === "action").map(p => p.key);
                            setRbacRolePerms(prev => { const n = new Set(prev); actionKeys.forEach(k => n.add(k)); return n; });
                          }} style={{ padding: "3px 10px", fontSize: 11, fontWeight: 600, border: "1px solid #d1d5db", borderRadius: 6, background: "#f9fafb", cursor: "pointer", color: "#374151" }}>전체 선택</button>
                          <button onClick={() => {
                            const actionKeys = new Set(rbacAllPerms.filter(p => p.category === "action").map(p => p.key));
                            setRbacRolePerms(prev => { const n = new Set(prev); actionKeys.forEach(k => n.delete(k)); return n; });
                          }} style={{ padding: "3px 10px", fontSize: 11, fontWeight: 600, border: "1px solid #d1d5db", borderRadius: 6, background: "#f9fafb", cursor: "pointer", color: "#374151" }}>전체 해제</button>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
                        {rbacAllPerms.filter(p => p.category === "action").map(p => (
                          <label key={p.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1px solid ${rbacRolePerms.has(p.key) ? "#10b981" : "#e5e7eb"}`, borderRadius: 8, cursor: "pointer", background: rbacRolePerms.has(p.key) ? "#f0fdf4" : "#fff", transition: "all 0.1s" }}>
                            <input type="checkbox" checked={rbacRolePerms.has(p.key)} onChange={e => {
                              setRbacRolePerms(prev => { const n = new Set(prev); e.target.checked ? n.add(p.key) : n.delete(p.key); return n; });
                            }} style={{ width: 15, height: 15, cursor: "pointer" }} />
                            <div>
                              <p style={{ margin: 0, fontSize: 12, fontWeight: rbacRolePerms.has(p.key) ? 600 : 400, color: rbacRolePerms.has(p.key) ? "#065f46" : "#374151" }}>{p.name}</p>
                              <p style={{ margin: 0, fontSize: 10, color: "#9ca3af" }}>{p.key}</p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </Card>
              ) : (
                <Card style={{ padding: "48px 24px", textAlign: "center" }}>
                  <p style={{ margin: 0, fontSize: 32 }}>🔑</p>
                  <p style={{ margin: "12px 0 0", fontSize: 14, color: "#6b7280" }}>좌측에서 역할을 선택하면<br />권한 설정 화면이 표시됩니다.</p>
                </Card>
              )}
            </div>
          </div>
        </Section>
      )}

      {/* ── 번역 데이터 탭 ─────────────────────────────────────────────────────── */}
      {adminTab === "data-layer" && (
        <DataLayerTab token={token} setToast={setToast} />
      )}

      {/* ── 언어 서비스 데이터 탭 ──────────────────────────────────────────────── */}
      {adminTab === "language-service" && (
        <LanguageServiceDataTab token={token} setToast={setToast} />
      )}

      {/* ── 인사이트 관리 탭 ────────────────────────────────────────────────────── */}
      {adminTab === "insight-management" && (
        <InsightManagementTab token={token} setToast={setToast} />
      )}

      {/* ── 인사이트 성과분석 탭 ─────────────────────────────────────────────────── */}
      {adminTab === "insight-analytics" && (
        <InsightAnalyticsTab token={token} setToast={setToast} />
      )}

          </div>{/* /스크롤 컨텐츠 */}
        </div>{/* /메인 컨텐츠 */}
      </div>{/* /풀스크린 레이아웃 */}
    </>
  );
}

