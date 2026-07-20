import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ADMIN_NAV_GROUPS, ADMIN_PAGE_TITLE, STAFF_DEFAULT_PERMS } from '../config/adminNav';
import {
  api, User, AdminProject, AdminPayment, AdminTask, AdminSettlement, AdminUser,
  AdminCustomer, AdminContact, Company, Contact, Division, Product, ProductOption, BoardPost, TranslatorProfile,
  TranslatorListItem, TranslatorRate, NoteEntry, Communication,
  normalizeLanguages,
  STATUS_LABEL, FEEDBACK_TAGS, COMM_TYPE_LABEL, COMM_TYPE_COLOR,
  PROJECT_STATUS_TRANSITIONS, getActionLabel, BOARD_CATEGORY_LABEL, AVAILABILITY_LABEL,
  ALL_PROJECT_STATUSES, ALL_FINANCIAL_STATUSES, ALL_PAYMENT_STATUSES, ALL_SETTLEMENT_STATUSES,
  PRODUCT_MAIN_CATEGORIES, PRODUCT_SUB_CATEGORIES, PRODUCT_UNITS, PRODUCT_OPTION_TYPES,
  FINANCIAL_STATUS_LABEL, FINANCIAL_STATUS_STYLE,
  VENDOR_TYPE_LABELS, VENDOR_TYPE_OPTIONS,
} from '../lib/constants';
import { StatusBadge, RoleBadge, Toast, Card, PrimaryBtn, GhostBtn, FilterPill, ClickSelect } from '../components/ui';
import { ADMIN_SCROLL_PADDING_TOP, ADMIN_SCROLL_PADDING_X } from '../lib/ds';
import { formatPhoneDisplay } from '../lib/utils';
import { LogModal } from '../components/admin/LogModal';
import { DraggableModal } from '../components/admin/DraggableModal';
import { ContactDetailModal } from '../components/admin/ContactDetailModal';
import { ContactFormModal } from '../components/admin/ContactFormModal';
import { CustomerDetailModal } from '../components/admin/CustomerDetailModal';
import { TranslatorProfileModal } from '../components/admin/TranslatorProfileModal';
import { TranslatorDetailModal } from '../components/admin/TranslatorDetailModal';
import { TranslatorCreateModal } from '../components/admin/TranslatorCreateModal';
import { ProjectDetailModal } from '../components/admin/ProjectDetailModal';
import { PrepaidLedgerModal } from '../components/admin/PrepaidLedgerModal';
import { ProductManagementTab } from '../components/admin/ProductManagementTab';
import { ProjectManagementTab } from '../components/admin/ProjectManagementTab';
import { SalesDetailPage } from './SalesDetailPage';
import { QuoteListTab } from '../components/admin/QuoteListTab';
import { CompanyManagementTab } from '../components/admin/CompanyManagementTab';
import { DataLayerTab } from '../components/admin/DataLayerTab';
import { LanguageServiceDataTab } from '../components/admin/LanguageServiceDataTab';
import { InsightManagementTab } from '../components/admin/InsightManagementTab';
import { InsightAnalyticsTab } from '../components/admin/InsightAnalyticsTab';
import { SettlementManagementTab } from '../components/admin/SettlementManagementTab';
import { SettingsTab } from '../components/admin/SettingsTab';
import { BillingManagementTab } from '../components/admin/BillingManagementTab';
import { StaffManagementTab } from '../components/admin/StaffManagementTab';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6,
};
const RATE_UNIT_LABELS: Record<string, string> = {
  word: "단어", eojeol: "어절", char: "글자", page: "페이지", item: "건",
  "1h": "1시간", "2h": "2시간", "4h": "4시간", "6h": "6시간", "8h": "8시간",
  extra: "추가시간", day: "일", hour: "시간",
};
const getRateUnitLabel = (unit: string) => RATE_UNIT_LABELS[unit] ?? unit;

const formatRegionDisplay = (region: string | null | undefined): string => {
  if (!region) return "-";
  if (region.startsWith("대한민국 / ")) return region.slice("대한민국 / ".length);
  if (region === "대한민국") return "-";
  return region;
};

const EDUCATION_LABEL_MAP: Record<string, string> = {
  "한국외국어대학교 통번역대학원":      "한국외대 통번역대학원",
  "서울외국어대학원대학교 통번역대학원": "서울외대 통번역대학원",
  "이화여자대학교 통역번역대학원":       "이화여대 통번역대학원",
  "중앙대학교 국제대학원":              "중앙대 국제대학원",
  "부산외국어대학교 통번역대학원":       "부산외대 통번역대학원",
  "제주대학교 통번역대학원":            "제주대 통번역대학원",
  "선문대학교 통번역대학원":            "선문대 통번역대학원",
  "계명대학교 통번역대학원":            "계명대 통번역대학원",
  "Middlebury Institute of International Studies at Monterey": "Monterey Institute (MIIS)",
  "Monterey Institute of International Studies":               "Monterey Institute (MIIS)",
  "Macquarie University - Translation & Interpreting":         "Macquarie University",
};
const getEducationLabel = (v: string | null | undefined) => (v && EDUCATION_LABEL_MAP[v]) ? EDUCATION_LABEL_MAP[v] : (v ?? "");


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
type ExcelRow = {
  rowNum: number; email: string; name: string; phone: string;
  region: string; grade: string;
  specializations: string; career: string; status: string;
  education: string; major: string; graduationYear: string;
  rating: string; availabilityStatus: string; bio: string;
  residentNumber: string; bankName: string; bankAccount: string; accountHolder: string;
  languages: string; workType: string; subType: string;
  rowStatus: "ok" | "duplicate" | "review" | "error";
  validationErrors: string[];
  reviewWarnings: string[];
  duplicateReasons: string[];
};
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

  const [adminTab, setAdminTab] = useState<"dashboard"|"quotes"|"projects"|"payments"|"tasks"|"settlements"|"users"|"customers"|"companies"|"contacts"|"products"|"board"|"translators"|"test"|"prepaid"|"billing"|"roles"|"permissions"|"settings"|"data-layer"|"language-service"|"insight-management"|"insight-analytics">("dashboard");
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
  const [quoteTick, setQuoteTick] = useState(0);
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

  // other filters
  const [paymentFilter, setPaymentFilter] = useState<string>("all");

  // customer management
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerModal, setCustomerModal] = useState<number | null>(null);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ companyName: "", contactName: "", email: "", phone: "" });
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  // user management (password reset modal state stays here, modal renders in AdminDashboard)
  const [resetPwUserId, setResetPwUserId] = useState<number | null>(null);
  const [resetPwInput, setResetPwInput] = useState("");
  const [resetPwLoading, setResetPwLoading] = useState(false);

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
  const [showInactiveContacts, setShowInactiveContacts] = useState(false);
  const [contactModal, setContactModal] = useState<number | null>(null);
  const [showCreateContactModal, setShowCreateContactModal] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const [deleteConfirmContact, setDeleteConfirmContact] = useState<{ id: number; name: string } | null>(null);
  const [deletingContact, setDeletingContact] = useState<number | null>(null);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [primaryMergeId, setPrimaryMergeId] = useState<number | null>(null);
  const [merging, setMerging] = useState(false);

  // translators tab state
  const [translatorList, setTranslatorList] = useState<TranslatorListItem[]>([]);
  const [translatorsLoading, setTranslatorsLoading] = useState(false);
  const [translatorSearch, setTranslatorSearch] = useState("");
  const [translatorLangFilter, setTranslatorLangFilter] = useState("");
  const [translatorStatusFilter, setTranslatorStatusFilter] = useState("all");
  const [translatorGradeFilter, setTranslatorGradeFilter] = useState("all");
  const [translatorRatingFilter, setTranslatorRatingFilter] = useState("");
  const [translatorSvcFilter, setTranslatorSvcFilter] = useState("all");
  const [showInactiveTranslators, setShowInactiveTranslators] = useState(false);
  const [translatorDetailModal, setTranslatorDetailModal] = useState<{ userId: number; email: string } | null>(null);
  const [expandedSubtypeRows, setExpandedSubtypeRows] = useState<Set<number>>(new Set());
  const [showTranslatorCreateModal, setShowTranslatorCreateModal] = useState(false);
  // 엑셀 대량 업로드 상태
  const [showExcelModal, setShowExcelModal] = useState(false);
  const [excelParsing, setExcelParsing] = useState(false);
  const [excelDragOver, setExcelDragOver] = useState(false);
  const excelFileInputRef = useRef<HTMLInputElement>(null);
  // 엑셀 모달 드래그/리사이즈
  const [excelModalPos, setExcelModalPos] = useState<{ x: number; y: number } | null>(null);
  const excelModalElRef = useRef<HTMLDivElement>(null);
  const excelModalDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [excelPreview, setExcelPreview] = useState<{
    rows: ExcelRow[];
    summary: { total: number; ok: number; duplicate: number; review: number; error: number; missingRequired: number; formatError: number };
  } | null>(null);
  const [excelBulkLoading, setExcelBulkLoading] = useState(false);
  const [excelBulkResult, setExcelBulkResult] = useState<{ created: number; failed: number; results: { email: string; status: string; error?: string }[] } | null>(null);

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
  type DetailModalState = { id: number; initialSection?: "info"|"quote"|"progress"|"payment"|"settlement"|"history" };
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);
  const openDetail = (id: number, initialSection?: DetailModalState["initialSection"]) => setDetailModal({ id, initialSection });

  // ── 판매 상세 독립 페이지 (URL: /sales/:id) ────────────────────────────────
  // 판매관리 목록 → 판매건 클릭 시 모달 대신 전체 페이지로 이동.
  // 관리자는 App.tsx가 모든 경로에서 AdminDashboard를 렌더하므로, 여기서
  // history.pushState 로 URL 을 동기화하면 사이드바/헤더 유지 + 새로고침 복원이 된다.
  const parseSalesId = (): number | null => {
    const m = window.location.pathname.match(/^\/sales\/(\d+)$/);
    return m ? Number(m[1]) : null;
  };
  const [salesDetailId, setSalesDetailId] = useState<number | null>(parseSalesId);
  const openSalesDetail = (id: number) => {
    if (window.location.pathname !== `/sales/${id}`) {
      window.history.pushState({}, "", `/sales/${id}`);
    }
    setAdminTab("projects");
    setSalesDetailId(id);
  };
  const closeSalesDetail = () => {
    if (parseSalesId() !== null) window.history.pushState({}, "", "/");
    setSalesDetailId(null);
  };
  // 사이드바 관리자 메뉴 공통 이동 — 판매 상세(/sales/:id)에 있던 경우 함께 닫는다.
  // (closeSalesDetail 이 URL(/sales/:id → /)과 salesDetailId 초기화를 담당하므로 중복 없음)
  const navigateToAdminTab = (tabId: typeof adminTab) => {
    closeSalesDetail();
    setAdminTab(tabId);
  };
  // 브라우저 뒤로/앞으로 → URL 기준으로 판매 상세 열림/닫힘 동기화
  useEffect(() => {
    const onPop = () => setSalesDetailId(parseSalesId());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
      setQuoteTick(t => t + 1);
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
      if (showInactiveContacts) params.set("includeInactive", "true");
      const res = await fetch(api(`/api/admin/contacts${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setContacts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 담당자 조회 실패"); }
    finally { setContactsLoading(false); }
  }, [token, contactSearch, showInactiveContacts]);

  // 비활성 필터 토글 시 선택 초기화
  useEffect(() => { setSelectedContactIds(new Set()); }, [showInactiveContacts]);

  const handleDeleteContact = async (contactId: number) => {
    setDeletingContact(contactId);
    try {
      const res = await fetch(api(`/api/admin/contacts/${contactId}`), {
        method: "DELETE", headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setDeleteConfirmContact(null);
      setSelectedContactIds(prev => { const n = new Set(prev); n.delete(contactId); return n; });
      await fetchContacts();
      setToast("담당자가 삭제(비활성) 처리되었습니다.");
    } catch { setToast("오류: 담당자 삭제 실패"); }
    finally { setDeletingContact(null); }
  };

  const handleMergeContacts = async () => {
    if (!primaryMergeId) { setToast("대표 담당자를 선택해주세요."); return; }
    const mergeIds = Array.from(selectedContactIds).filter(id => id !== primaryMergeId);
    setMerging(true);
    try {
      const res = await fetch(api("/api/admin/contacts/merge"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ primaryContactId: primaryMergeId, mergeContactIds: mergeIds }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setShowMergeModal(false);
      setSelectedContactIds(new Set());
      setPrimaryMergeId(null);
      await fetchContacts();
      setToast(`담당자 통합 완료: ${data.mergedNames?.join(", ")} → 대표 담당자로 통합됨`);
    } catch { setToast("오류: 담당자 통합 실패"); }
    finally { setMerging(false); }
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
      if (translatorSvcFilter !== "all") params.set("svc", translatorSvcFilter);
      if (showInactiveTranslators) params.set("includeInactive", "true");
      const res = await fetch(api(`/api/admin/translators${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setTranslatorList(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 통번역사 조회 실패"); }
    finally { setTranslatorsLoading(false); }
  }, [token, translatorSearch, translatorLangFilter, translatorStatusFilter, translatorGradeFilter, translatorRatingFilter, translatorSvcFilter, showInactiveTranslators]);

  const handleExcelUpload = async (file: File) => {
    console.log("[ExcelUpload] 파일 선택됨:", file.name, file.size, "bytes");
    setExcelParsing(true);
    setExcelPreview(null);
    setExcelBulkResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      console.log("[ExcelUpload] API 호출 시작:", api("/api/admin/translators/upload-excel"));
      const res = await fetch(api("/api/admin/translators/upload-excel"), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
      const data = await res.json();
      console.log("[ExcelUpload] API 응답 status:", res.status, "ok:", res.ok);
      console.log("[ExcelUpload] API 응답 data:", data);
      console.log("[ExcelUpload] data.rows 존재?", Array.isArray(data.rows), "/ data.summary 존재?", !!data.summary);
      console.log("[ExcelUpload] (구버전 체크) data.valid 존재?", Array.isArray(data.valid));
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setExcelPreview(data);
      console.log("[ExcelUpload] setExcelPreview 호출 완료, rows 길이:", data.rows?.length);
    } catch (err) {
      console.error("[ExcelUpload] catch 오류:", err);
      setToast("오류: 엑셀 파싱 실패");
    }
    finally { setExcelParsing(false); }
  };

  const closeExcelModal = () => {
    setShowExcelModal(false);
    setExcelPreview(null);
    setExcelBulkResult(null);
    setExcelModalPos(null);
  };

  const handleBulkCreate = async () => {
    const okRows = excelPreview?.rows.filter(r => r.rowStatus === "ok") ?? [];
    if (okRows.length === 0) { setToast("등록할 정상 행이 없습니다."); return; }
    setExcelBulkLoading(true);
    try {
      const res = await fetch(api("/api/admin/translators/bulk-create"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ rows: okRows }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setExcelBulkResult(data);
      await fetchTranslators();
      setToast(`통번역사 ${data.created}명 등록 완료 (실패 ${data.failed}명)`);
    } catch { setToast("오류: 대량 등록 실패"); }
    finally { setExcelBulkLoading(false); }
  };

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


  // ── 엑셀 모달 드래그 리스너 ─────────────────────────────────────────────
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!excelModalDragRef.current || !excelModalElRef.current) return;
      const { startX, startY, origX, origY } = excelModalDragRef.current;
      const rect = excelModalElRef.current.getBoundingClientRect();
      const newX = Math.max(0, Math.min(window.innerWidth  - rect.width,  origX + e.clientX - startX));
      const newY = Math.max(0, Math.min(window.innerHeight - rect.height, origY + e.clientY - startY));
      setExcelModalPos({ x: newX, y: newY });
    };
    const onMouseUp = () => {
      if (!excelModalDragRef.current) return;
      excelModalDragRef.current = null;
      document.body.style.userSelect = "";
      if (excelModalElRef.current) excelModalElRef.current.style.cursor = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup",   onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup",   onMouseUp);
    };
  }, []);

  // ── Heartbeat: 3분마다 마지막 활동 시간 갱신 ────────────────────────────
  useEffect(() => {
    const sendHeartbeat = async () => {
      if (!token) return;
      try {
        const res = await fetch(api("/api/auth/heartbeat"), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          setToast("세션이 만료되었습니다. 다시 로그인해 주세요.");
          setTimeout(() => onLogout(), 1500);
        }
      } catch {}
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, [token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { if (adminTab === "customers") fetchCustomers(); }, [adminTab, fetchCustomers]);
  useEffect(() => { if (adminTab === "companies") fetchCompanies(); }, [adminTab, fetchCompanies]);
  useEffect(() => { if (adminTab === "contacts") { fetchContacts(); if (companies.length === 0) fetchCompanies(); } }, [adminTab, fetchContacts]);
  useEffect(() => { if (adminTab === "board") fetchBoard(); }, [adminTab, fetchBoard]);
  useEffect(() => { if (adminTab === "translators") fetchTranslators(); }, [adminTab, fetchTranslators]);
  useEffect(() => { if (adminTab === "prepaid") fetchPrepaidAccounts(); }, [adminTab, fetchPrepaidAccounts]);

  // ── 환경설정 상태 ─────────────────────────────────────────────────────────

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
    if (adminTab !== "roles") return;
    const authH = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(api("/api/admin/roles"), { headers: authH }).then(r => r.ok ? r.json() : []),
      fetch(api("/api/admin/permissions"), { headers: authH }).then(r => r.ok ? r.json() : []),
    ]).then(([roles, perms]) => {
      setRbacRoles(Array.isArray(roles) ? roles : []);
      setRbacAllPerms(Array.isArray(perms) ? perms : []);
      if (users.length === 0) {
        fetch(api("/api/admin/users"), { headers: authH })
          .then(r => r.ok ? r.json() : [])
          .then(data => setUsers(Array.isArray(data) ? data : []));
      }
    }).catch(() => setToast("역할 목록 조회 실패"));
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
          onRefreshList={fetchContacts}
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
          onSaved={() => fetchTranslators()}
          onDeleted={() => { setTranslatorDetailModal(null); fetchTranslators(); }}
        />
      )}
      {showTranslatorCreateModal && (
        <TranslatorCreateModal
          token={token}
          permissions={permissions}
          onClose={() => setShowTranslatorCreateModal(false)}
          onCreated={() => {
            fetchTranslators();
          }}
          onToast={setToast}
        />
      )}
      {/* ── 엑셀 대량 등록 모달 (드래그·리사이즈 가능) ── */}
      {showExcelModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.5)" }}>
          {console.log("[ExcelModal] 모달 렌더됨 — excelPreview:", excelPreview, "excelBulkResult:", excelBulkResult) as unknown as null}
          <div
            ref={excelModalElRef}
            style={{
              position: "fixed",
              ...(excelModalPos
                ? { left: excelModalPos.x, top: excelModalPos.y }
                : { left: "50%", top: "50%", transform: "translate(-50%,-50%)" }),
              background: "#fff", borderRadius: 16,
              boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
              resize: "both", overflow: "hidden",
              minWidth: 620, minHeight: 420,
              width: "min(920px, 96vw)", height: "min(700px, 92vh)",
              maxWidth: "99vw", maxHeight: "98vh",
              display: "flex", flexDirection: "column",
            }}
          >
            {/* ── 드래그 핸들 타이틀바 ── */}
            <div
              onMouseDown={e => {
                if ((e.target as HTMLElement).closest("button")) return;
                const rect = excelModalElRef.current!.getBoundingClientRect();
                excelModalDragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
                document.body.style.userSelect = "none";
                excelModalElRef.current!.style.cursor = "grabbing";
              }}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "14px 20px 10px", flexShrink: 0,
                borderBottom: "1px solid #f0f0f0",
                cursor: "grab", background: "#fff", borderRadius: "16px 16px 0 0",
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, pointerEvents: "none" }}>통번역사 엑셀 대량 등록</h2>
                <p style={{ fontSize: 12, color: "#9ca3af", margin: "2px 0 0", pointerEvents: "none" }}>
                  정상 행만 등록됩니다. 중복가능성·오류 행은 자동 제외됩니다.
                </p>
              </div>
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={closeExcelModal}
                style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#6b7280", flexShrink: 0, marginLeft: 12 }}
              >×</button>
            </div>
            {/* ── 스크롤 가능 콘텐츠 영역 ── */}
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "16px 24px 20px" }}>

            {/* 파일 업로드 드롭존 */}
            {!excelPreview && !excelBulkResult && (
              <>
                {/* hidden file input — ref로 명시적 제어 */}
                <input
                  ref={excelFileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  style={{ display: "none" }}
                  disabled={excelParsing}
                  onChange={e => {
                    console.log("[ExcelUpload] onChange 트리거, files:", e.target.files?.length);
                    const f = e.target.files?.[0];
                    if (f) handleExcelUpload(f);
                    e.target.value = "";
                  }}
                />
                {/* 드롭존 — onDrop + onDragOver + onClick 명시 연결 */}
                <div
                  onClick={() => { if (!excelParsing) { console.log("[ExcelUpload] 드롭존 클릭 → input 열기"); excelFileInputRef.current?.click(); } }}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (!excelDragOver) setExcelDragOver(true); }}
                  onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setExcelDragOver(true); }}
                  onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setExcelDragOver(false); }}
                  onDrop={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    setExcelDragOver(false);
                    if (excelParsing) return;
                    const f = e.dataTransfer.files?.[0];
                    console.log("[ExcelUpload] 드롭 이벤트, file:", f?.name);
                    if (f) handleExcelUpload(f);
                  }}
                  style={{
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                    border: `2px dashed ${excelDragOver ? "#2563eb" : "#d1d5db"}`,
                    borderRadius: 12, padding: "36px 24px",
                    cursor: excelParsing ? "default" : "pointer",
                    background: excelDragOver ? "#eff6ff" : "#f9fafb",
                    marginBottom: 12,
                    transition: "border-color 0.15s, background 0.15s",
                    userSelect: "none",
                  }}
                >
                  <div style={{ fontSize: 32, marginBottom: 8 }}>{excelDragOver ? "📥" : "📂"}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: excelDragOver ? "#2563eb" : "#374151", marginBottom: 4 }}>
                    {excelDragOver ? "여기에 놓으세요" : "엑셀 파일을 선택하거나 여기에 드롭하세요"}
                  </div>
                  <div style={{ fontSize: 12, color: "#9ca3af" }}>.xlsx / .xls 파일 · 최대 5MB</div>
                  {excelParsing && <div style={{ marginTop: 12, color: "#6b7280", fontSize: 13 }}>파싱 및 중복 확인 중...</div>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <a href={api("/api/admin/translators/sample-excel")}
                    style={{ fontSize: 12, color: "#2563eb", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                    onClick={e => {
                      e.preventDefault();
                      fetch(api("/api/admin/translators/sample-excel"), { headers: authHeaders })
                        .then(r => r.blob()).then(b => { const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "translators_sample.xlsx"; a.click(); URL.revokeObjectURL(u); });
                    }}>
                    샘플 엑셀 다운로드
                  </a>
                </div>
              </>
            )}

            {/* 파싱 결과 Preview */}
            {excelPreview && !excelBulkResult && (() => {
              console.log("[ExcelPreview] IIFE 진입 — excelPreview:", excelPreview);
              console.log("[ExcelPreview] rows 타입:", typeof excelPreview.rows, Array.isArray(excelPreview.rows));
              console.log("[ExcelPreview] summary:", excelPreview.summary);
              const { rows, summary } = excelPreview;
              console.log("[ExcelPreview] rows 길이:", rows?.length, "/ summary.ok:", summary?.ok);
              const okRows = rows.filter(r => r.rowStatus === "ok");
              const dupRows = rows.filter(r => r.rowStatus === "duplicate");
              const reviewRows = rows.filter(r => r.rowStatus === "review");
              const errorRows = rows.filter(r => r.rowStatus === "error");

              const STATUS_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
                ok:        { label: "정상",       color: "#065f46", bg: "#ecfdf5", border: "#6ee7b7" },
                duplicate: { label: "중복가능성", color: "#92400e", bg: "#fffbeb", border: "#fcd34d" },
                review:    { label: "검토필요",   color: "#5b21b6", bg: "#f5f3ff", border: "#c4b5fd" },
                error:     { label: "오류",       color: "#991b1b", bg: "#fef2f2", border: "#fca5a5" },
              };

              console.log("[ExcelPreview] return JSX 직전 — okRows:", okRows.length, "dupRows:", dupRows.length, "reviewRows:", reviewRows.length, "errorRows:", errorRows.length);
              return (
                <>
                  {/* 요약 카드 5종 */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 16 }}>
                    {[
                      { label: "전체 행", value: summary.total, color: "#374151", bg: "#f9fafb", border: "#e5e7eb" },
                      { label: "신규 등록 가능", value: summary.ok, color: "#065f46", bg: "#ecfdf5", border: "#6ee7b7" },
                      { label: "중복 가능성", value: summary.duplicate, color: "#92400e", bg: "#fffbeb", border: "#fcd34d" },
                      { label: "필수값 누락", value: summary.missingRequired, color: "#991b1b", bg: "#fef2f2", border: "#fca5a5" },
                      { label: "형식 오류", value: summary.formatError, color: "#b45309", bg: "#fff7ed", border: "#fdba74" },
                    ].map(c => (
                      <div key={c.label} style={{ border: `1px solid ${c.border}`, borderRadius: 10, padding: "10px 12px", background: c.bg, textAlign: "center" }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: c.color }}>{c.value}</div>
                        <div style={{ fontSize: 11, color: c.color, marginTop: 2 }}>{c.label}</div>
                      </div>
                    ))}
                  </div>

                  {/* 안내 */}
                  {(summary.review > 0 || summary.duplicate > 0 || summary.error > 0) && (
                    <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 14px", marginBottom: 12, fontSize: 12, color: "#6b7280" }}>
                      {summary.review > 0 && <div>• 검토필요 {summary.review}행: 가능언어/업무유형 미입력 — 등록 제외됩니다. 엑셀 보완 후 재업로드하거나 개별 등록하세요.</div>}
                      {summary.duplicate > 0 && <div>• 중복가능성 {summary.duplicate}행: 이메일·휴대폰·주민번호 일치 — 등록 제외됩니다.</div>}
                      {summary.error > 0 && <div>• 오류 {summary.error}행: 필수값 누락 또는 형식 오류 — 등록 제외됩니다.</div>}
                    </div>
                  )}

                  {/* 행 테이블 (전체) */}
                  <div style={{ overflowX: "auto", maxHeight: 360, border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 14 }}>
                    <table style={{ width: "100%", minWidth: 1156, borderCollapse: "collapse", fontSize: 12, tableLayout: "fixed" }}>
                      {/* ── 컬럼 폭 정의 ──
                          좁음: 행(36) 상태(72) 주민번호(114) 지역(58)
                          중간: 이름(84) 휴대폰(108) 학력(96) 가능언어(112)
                          넓음: 이메일(160) 상세정보(156) 비고(160)
                          합계: 1156px
                      */}
                      <colgroup>
                        <col style={{ width: 36 }} />
                        <col style={{ width: 72 }} />
                        <col style={{ width: 84 }} />
                        <col style={{ width: 114 }} />
                        <col style={{ width: 160 }} />
                        <col style={{ width: 108 }} />
                        <col style={{ width: 96 }} />
                        <col style={{ width: 112 }} />
                        <col style={{ width: 156 }} />
                        <col style={{ width: 58 }} />
                        <col style={{ width: 160 }} />
                      </colgroup>
                      <thead style={{ background: "#f9fafb", position: "sticky", top: 0, zIndex: 1 }}>
                        <tr>
                          {["행","상태","이름","주민번호","이메일","휴대폰","학력","가능언어","상세정보","지역","비고"].map(h => (
                            <th key={h} style={{ padding: "6px 8px", textAlign: "left", fontWeight: 600, color: "#374151", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => {
                          const sm = STATUS_META[r.rowStatus];
                          const remarks = [
                            ...r.validationErrors,
                            ...r.duplicateReasons,
                            ...r.reviewWarnings,
                          ].join(" · ");
                          const tdBase: React.CSSProperties = { padding: "5px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
                          return (
                            <tr key={r.rowNum} style={{ borderBottom: "1px solid #f3f4f6", background: r.rowStatus === "ok" ? "#fff" : sm.bg }}>
                              {/* 행 */}
                              <td style={{ ...tdBase, color: "#9ca3af", fontFamily: "monospace", textAlign: "right" }}>{r.rowNum}</td>
                              {/* 상태 */}
                              <td style={{ ...tdBase }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: sm.color, background: sm.bg, border: `1px solid ${sm.border}`, borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>{sm.label}</span>
                              </td>
                              {/* 이름 */}
                              <td style={{ ...tdBase, fontWeight: 600, color: r.name ? "#111827" : "#d1d5db" }}>{r.name || "—"}</td>
                              {/* 주민번호 */}
                              <td style={{ ...tdBase, fontFamily: "monospace", fontSize: 11, color: r.residentNumber ? "#374151" : "#d1d5db" }}>
                                {r.residentNumber || "—"}
                              </td>
                              {/* 이메일 */}
                              <td style={{ ...tdBase, color: "#3b82f6" }} title={r.email || undefined}>{r.email || <span style={{ color: "#d1d5db" }}>—</span>}</td>
                              {/* 휴대폰 */}
                              <td style={{ ...tdBase }}>{r.phone ? formatPhoneDisplay(r.phone) : <span style={{ color: "#d1d5db" }}>—</span>}</td>
                              {/* 학력 */}
                              <td style={{ ...tdBase, color: r.education ? "#374151" : "#d1d5db" }} title={r.education ? getEducationLabel(r.education) : undefined}>
                                {r.education ? getEducationLabel(r.education) : "—"}
                              </td>
                              {/* 가능언어 */}
                              <td style={{ ...tdBase }} title={r.languages || undefined}>
                                {r.languages || <span style={{ color: "#d1d5db" }}>—</span>}
                              </td>
                              {/* 상세정보 — ellipsis + hover tooltip */}
                              <td style={{ ...tdBase, color: r.bio ? "#374151" : "#d1d5db" }} title={r.bio || undefined}>
                                {r.bio || "—"}
                              </td>
                              {/* 지역 */}
                              <td style={{ ...tdBase }}>{r.region || "—"}</td>
                              {/* 비고 — 검증 결과 */}
                              <td style={{ ...tdBase, color: r.rowStatus === "error" ? "#dc2626" : r.rowStatus === "duplicate" ? "#92400e" : "#9ca3af", fontSize: 11 }}
                                title={remarks}>{remarks || ""}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* 각 상태별 소계 */}
                  <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 14, display: "flex", gap: 14, flexWrap: "wrap" }}>
                    <span>정상 <strong style={{ color: "#065f46" }}>{okRows.length}</strong></span>
                    {dupRows.length > 0 && <span>중복가능성 <strong style={{ color: "#92400e" }}>{dupRows.length}</strong></span>}
                    {reviewRows.length > 0 && <span>검토필요 <strong style={{ color: "#5b21b6" }}>{reviewRows.length}</strong></span>}
                    {errorRows.length > 0 && <span>오류 <strong style={{ color: "#991b1b" }}>{errorRows.length}</strong></span>}
                  </div>

                  <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    <button onClick={() => setExcelPreview(null)}
                      style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer", color: "#374151" }}>
                      다시 선택
                    </button>
                    <PrimaryBtn
                      onClick={handleBulkCreate}
                      disabled={excelBulkLoading || okRows.length === 0}
                      style={{ padding: "8px 20px", fontSize: 13 }}>
                      {excelBulkLoading ? "등록 중..." : `정상 ${okRows.length}명 등록`}
                    </PrimaryBtn>
                  </div>
                </>
              );
            })()}

            {/* 등록 결과 */}
            {excelBulkResult && (
              <div>
                <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                  <div style={{ background: "#ecfdf5", borderRadius: 8, padding: "10px 18px", fontSize: 14, color: "#065f46", fontWeight: 700 }}>등록 성공 {excelBulkResult.created}명</div>
                  {excelBulkResult.failed > 0 && (
                    <div style={{ background: "#fef2f2", borderRadius: 8, padding: "10px 18px", fontSize: 14, color: "#991b1b", fontWeight: 700 }}>실패 {excelBulkResult.failed}명</div>
                  )}
                </div>
                {excelBulkResult.failed > 0 && (
                  <div style={{ overflowX: "auto", maxHeight: 200, border: "1px solid #fecaca", borderRadius: 8, background: "#fef2f2", marginBottom: 14 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr>{["이메일","오류"].map(h => (<th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, color: "#991b1b", borderBottom: "1px solid #fecaca" }}>{h}</th>))}</tr>
                      </thead>
                      <tbody>
                        {excelBulkResult.results.filter(r => r.status === "error").map((r, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #fecaca" }}>
                            <td style={{ padding: "5px 10px" }}>{r.email}</td>
                            <td style={{ padding: "5px 10px", color: "#dc2626" }}>{r.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <PrimaryBtn onClick={closeExcelModal} style={{ padding: "8px 20px", fontSize: 13 }}>
                    닫기
                  </PrimaryBtn>
                </div>
              </div>
            )}
            </div>
          </div>
        </div>
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
          isAdmin={user.role === "admin"}
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
          {/* 로고 영역 — VERITAS OS */}
          <div style={{ padding: "20px 22px 16px", borderBottom: "1px solid #2d3547", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* V Symbol — clean geometric, gradient fill */}
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
                <defs>
                  <linearGradient id="vg_s" x1="2" y1="4" x2="30" y2="29" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#6366f1"/>
                    <stop offset="100%" stopColor="#22d3ee"/>
                  </linearGradient>
                </defs>
                <path fillRule="evenodd" d="M2,4 L30,4 L16,29 Z M10,4 L22,4 L16,24 Z" fill="url(#vg_s)"/>
              </svg>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0", letterSpacing: "0.06em", lineHeight: 1.25, whiteSpace: "nowrap" }}>
                  VERITAS <span style={{ fontWeight: 700, color: "#60a5fa" }}>OS</span>
                </div>
                <div style={{ fontSize: 10, fontWeight: 400, color: "#8b97a6", letterSpacing: "0.05em", marginTop: 2, whiteSpace: "nowrap" }}>
                  AI Platform
                </div>
              </div>
            </div>
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
                        onClick={() => navigateToAdminTab(item.id as typeof adminTab)}
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
          <div style={{ flex: 1, overflowY: "auto", padding: `${ADMIN_SCROLL_PADDING_TOP}px ${ADMIN_SCROLL_PADDING_X}px`, background: "#f9fafb" }}>

          {salesDetailId !== null ? (
            <SalesDetailPage
              saleId={salesDetailId}
              token={token}
              adminUsers={adminUsers}
              onBack={closeSalesDetail}
            />
          ) : (<>

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

      {/* ── 견적서 탭 ── */}
      {adminTab === "quotes" && (
        <QuoteListTab
          token={token}
          onToast={setToast}
          adminUsers={adminUsers}
          refreshTick={quoteTick}
          isAdmin={user.role === "admin"}
          onNavigateToSales={() => setAdminTab("projects")}
        />
      )}

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
          onOpenSalesDetail={openSalesDetail}
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
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{pm.projectTitle ?? "(제목 없음)"}</td>
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
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{t.projectTitle ?? "(제목 없음)"}</td>
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
      {adminTab === "settlements" && (
        <SettlementManagementTab
          settlements={settlements}
          loading={loading}
          token={token ?? ""}
          onToast={setToast}
          onRefresh={fetchAll}
        />
      )}

      {/* ── 사용자 관리 탭 ── */}
      {adminTab === "users" && (
        <StaffManagementTab
          token={token}
          currentUser={user}
          users={users}
          setUsers={setUsers}
          rbacRoles={rbacRoles}
          onToast={setToast}
          onResetPassword={(userId) => { setResetPwUserId(userId); setResetPwInput(""); }}
          onTranslatorProfile={(userId, email) => setTranslatorProfileModal({ userId, email })}
        />
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
          onOpenTranslator={(userId, email) => { setAdminTab("translators"); setTranslatorDetailModal({ userId, email }); }}
          hasPerm={hasPerm}
        />
      )}

      {/* ── 담당자 탭 ── */}
      {adminTab === "contacts" && (
        <Section title={`담당자 관리 (${contacts.length})`} action={
          <PrimaryBtn onClick={() => setShowCreateContactModal(true)} style={{ fontSize: 13, padding: "7px 14px" }}>
            + 담당자 등록
          </PrimaryBtn>
        }>
          {/* ── 담당자 등록 모달 ── */}
          {showCreateContactModal && (
            <ContactFormModal
              mode="create"
              token={token}
              companies={companies}
              onClose={() => setShowCreateContactModal(false)}
              onSuccess={async () => { await fetchContacts(); }}
              onToast={setToast}
            />
          )}

          <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 12px" }}>
            하나의 거래처에 여러 명의 담당자를 등록할 수 있습니다. 기본 담당자는 거래처별 1명만 지정됩니다.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            <input value={contactSearch} onChange={e => setContactSearch(e.target.value)}
              placeholder="이름, 이메일, 휴대폰, 거래처 검색..."
              style={{ ...inputStyle, maxWidth: 340, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchContacts()} />
            <PrimaryBtn onClick={fetchContacts} disabled={contactsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {contactsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6b7280", cursor: "pointer", userSelect: "none", padding: "6px 0" }}>
              <input
                type="checkbox"
                checked={showInactiveContacts}
                onChange={e => setShowInactiveContacts(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: "#6b7280", cursor: "pointer" }}
              />
              비활성 포함
            </label>
          </div>
          {/* 선택 시 통합 툴바 */}
          {selectedContactIds.size >= 2 && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "10px 16px", marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#1d4ed8" }}>{selectedContactIds.size}명 선택됨</span>
              <button
                onClick={() => { setShowMergeModal(true); setPrimaryMergeId(null); }}
                style={{ fontSize: 13, fontWeight: 700, padding: "7px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" }}>
                선택 담당자 통합
              </button>
              <button
                onClick={() => setSelectedContactIds(new Set())}
                style={{ fontSize: 12, padding: "6px 12px", background: "transparent", color: "#6b7280", border: "1px solid #d1d5db", borderRadius: 7, cursor: "pointer" }}>
                선택 해제
              </button>
            </div>
          )}

          {contactsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : contacts.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 담당자가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ ...tableTh, width: 36 }}>
                        <input type="checkbox"
                          checked={selectedContactIds.size === contacts.length && contacts.length > 0}
                          onChange={e => setSelectedContactIds(e.target.checked ? new Set(contacts.map(c => c.id)) : new Set())}
                          title="전체 선택"
                        />
                      </th>
                      {["ID","거래처","담당자명","부서/직책","휴대폰","이메일","역할","상태","등록일","작업"].map(h => <th key={h} style={tableTh}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map(c => {
                      const isSelected = selectedContactIds.has(c.id);
                      return (
                        <tr key={c.id}
                          style={{ cursor: "pointer", opacity: (c as any).isActive !== false ? 1 : 0.6, background: isSelected ? "#eff6ff" : undefined }}
                          onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#f9fafb"; }}
                          onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
                          <td style={{ ...tableTd, textAlign: "center" }} onClick={e => e.stopPropagation()}>
                            <input type="checkbox"
                              checked={isSelected}
                              onChange={e => {
                                e.stopPropagation();
                                setSelectedContactIds(prev => {
                                  const n = new Set(prev);
                                  e.target.checked ? n.add(c.id) : n.delete(c.id);
                                  return n;
                                });
                              }}
                            />
                          </td>
                          <td style={{ ...tableTd, color: "#9ca3af" }} onClick={() => setContactModal(c.id)}>#{c.id}</td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }} onClick={() => setContactModal(c.id)}>
                            <div>{c.companyName ?? "-"}</div>
                            {c.divisionName && <div style={{ color: "#7c3aed", fontWeight: 600, fontSize: 11, marginTop: 1 }}>↳ {c.divisionName}</div>}
                          </td>
                          <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }} onClick={() => setContactModal(c.id)}>{c.name}</td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }} onClick={() => setContactModal(c.id)}>
                            {[c.department, c.position].filter(Boolean).join(" / ") || "-"}
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#374151" }} onClick={() => setContactModal(c.id)}>{formatPhoneDisplay((c as any).mobile ?? c.phone)}</td>
                          <td style={{ ...tableTd, color: "#2563eb", fontSize: 12 }} onClick={() => setContactModal(c.id)}>{c.email ?? "-"}</td>
                          <td style={{ ...tableTd }} onClick={() => setContactModal(c.id)}>
                            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                              {(c as any).isPrimary && <span style={{ fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>기본</span>}
                              {(c as any).isQuoteContact && <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>견적</span>}
                              {(c as any).isBillingContact && <span style={{ fontSize: 10, background: "#ede9fe", color: "#5b21b6", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>청구</span>}
                            </div>
                          </td>
                          <td style={{ ...tableTd, fontSize: 12 }} onClick={() => setContactModal(c.id)}>
                            <span style={{ background: (c as any).isActive !== false ? "#d1fae5" : "#f3f4f6", color: (c as any).isActive !== false ? "#065f46" : "#9ca3af", borderRadius: 4, padding: "2px 7px", fontSize: 11, fontWeight: 600 }}>
                              {(c as any).isActive !== false ? "활성" : "비활성"}
                            </span>
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }} onClick={() => setContactModal(c.id)}>{new Date(c.createdAt).toLocaleDateString("ko-KR")}</td>
                          <td style={{ ...tableTd }} onClick={e => e.stopPropagation()}>
                            {(c as any).isActive !== false && (
                              <button
                                onClick={() => setDeleteConfirmContact({ id: c.id, name: c.name })}
                                disabled={deletingContact === c.id}
                                style={{ fontSize: 11, padding: "3px 9px", background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 5, cursor: "pointer", fontWeight: 600 }}>
                                삭제
                              </button>
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

          {/* ── 삭제 확인 모달 ── */}
          {deleteConfirmContact && (
            <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ background: "#fff", borderRadius: 14, padding: "28px 32px", width: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
                <h3 style={{ margin: "0 0 10px", fontSize: 16, fontWeight: 800, color: "#111827" }}>담당자 삭제</h3>
                <p style={{ margin: "0 0 6px", fontSize: 14, color: "#374151" }}>
                  <strong>{deleteConfirmContact.name}</strong> 담당자를 삭제하시겠습니까?
                </p>
                <p style={{ margin: "0 0 20px", fontSize: 12, color: "#9ca3af" }}>삭제된 담당자는 목록에서 숨김 처리됩니다.</p>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button onClick={() => setDeleteConfirmContact(null)} disabled={!!deletingContact}
                    style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                    취소
                  </button>
                  <button onClick={() => handleDeleteContact(deleteConfirmContact.id)} disabled={!!deletingContact}
                    style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                    {deletingContact ? "삭제 중..." : "삭제"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── 담당자 통합 모달 ── */}
          {showMergeModal && (() => {
            const selectedContacts = contacts.filter(c => selectedContactIds.has(c.id));
            return (
              <DraggableModal title="중복 담당자 통합" onClose={() => setShowMergeModal(false)} width={680} zIndex={400} bodyPadding="20px 28px">
                <p style={{ margin: "0 0 6px", fontSize: 13, color: "#374151" }}>대표 담당자를 선택하세요.</p>
                <p style={{ margin: "0 0 16px", fontSize: 12, color: "#9ca3af" }}>통합 후 나머지 담당자는 비활성 처리됩니다. 기존 프로젝트 이력은 대표 담당자로 연결됩니다.</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                  {selectedContacts.map(c => (
                    <label key={c.id} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", borderRadius: 10, border: `2px solid ${primaryMergeId === c.id ? "#2563eb" : "#e5e7eb"}`, background: primaryMergeId === c.id ? "#eff6ff" : "#fff", cursor: "pointer" }}>
                      <input type="radio" name="primaryContact" value={c.id}
                        checked={primaryMergeId === c.id}
                        onChange={() => setPrimaryMergeId(c.id)}
                        style={{ marginTop: 2, accentColor: "#2563eb" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                          <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{c.name}</span>
                          {primaryMergeId === c.id && <span style={{ fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>대표</span>}
                          {(c as any).isPrimary && <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>기본담당자</span>}
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px", fontSize: 12, color: "#6b7280" }}>
                          <span>거래처: {c.companyName ?? "-"}</span>
                          <span>부서/직책: {[c.department, c.position].filter(Boolean).join(" / ") || "-"}</span>
                          <span>휴대폰: {(c as any).mobile ?? c.phone ?? "-"}</span>
                          <span>이메일: {c.email ?? "-"}</span>
                          <span>등록일: {new Date(c.createdAt).toLocaleDateString("ko-KR")}</span>
                          <span>ID: #{c.id}</span>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
                {!primaryMergeId && (
                  <p style={{ margin: "0 0 12px", fontSize: 12, color: "#dc2626", fontWeight: 600 }}>대표 담당자를 선택해주세요.</p>
                )}
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  <button onClick={() => setShowMergeModal(false)}
                    style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                    취소
                  </button>
                  <button onClick={handleMergeContacts} disabled={!primaryMergeId || merging}
                    style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: primaryMergeId ? "#2563eb" : "#93c5fd", color: "#fff", fontSize: 13, fontWeight: 700, cursor: primaryMergeId ? "pointer" : "not-allowed" }}>
                    {merging ? "통합 중..." : `${selectedContactIds.size}명 통합`}
                  </button>
                </div>
              </DraggableModal>
            );
          })()}
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
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={async () => {
              const res = await fetch(api("/api/admin/translators/sample-excel"), { headers: authHeaders });
              if (!res.ok) { setToast("샘플 다운로드 실패"); return; }
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a"); a.href = url; a.download = "translators_sample.xlsx"; a.click(); URL.revokeObjectURL(url);
            }} style={{ padding: "8px 14px", fontSize: 12, borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer", fontWeight: 600 }}>
              샘플 다운로드
            </button>
            <button onClick={() => { setShowExcelModal(true); setExcelPreview(null); setExcelBulkResult(null); }}
              style={{ padding: "8px 14px", fontSize: 12, borderRadius: 8, border: "1px solid #10b981", background: "#ecfdf5", color: "#065f46", cursor: "pointer", fontWeight: 600 }}>
              📥 엑셀 대량 등록
            </button>
            <PrimaryBtn onClick={() => setShowTranslatorCreateModal(true)} style={{ padding: "8px 16px", fontSize: 13 }}>
              + 통번역사 등록
            </PrimaryBtn>
          </div>
        }>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input value={translatorSearch} onChange={e => setTranslatorSearch(e.target.value)}
              placeholder="이름, 이메일, 가능언어, 학력, 지역 검색..."
              style={{ ...inputStyle, maxWidth: 240, flex: "1 1 180px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchTranslators()} />
            <input value={translatorLangFilter} onChange={e => setTranslatorLangFilter(e.target.value)}
              placeholder="가능언어 검색..."
              style={{ ...inputStyle, maxWidth: 150, padding: "8px 12px", fontSize: 13 }} />
            <ClickSelect
              value={translatorSvcFilter}
              onChange={setTranslatorSvcFilter}
              triggerStyle={{ fontSize: 13, padding: "8px 12px", minWidth: 100, borderRadius: 8 }}
              options={[
                { value: "all", label: "전체 업무" },
                ...["번역","통역","감수","편집","미디어","DTP","행사운영"].map(s => ({ value: s, label: s })),
              ]}
            />
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
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#6b7280", cursor: "pointer", userSelect: "none", padding: "6px 0" }}>
              <input
                type="checkbox"
                checked={showInactiveTranslators}
                onChange={e => setShowInactiveTranslators(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: "#6b7280", cursor: "pointer" }}
              />
              비활성 포함
            </label>
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
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1180 }}>
                  <colgroup>
                    {/* 이름(12%) 주민번호(6%) 가능언어(8%) 학력(8%) 업무유형(6%) 세부유형(8%) 전문분야(8%) 상세정보(13%) 평점(5%) 지역(8%·말줄임) 가용상태(6%·고정) 운영상태(7%·고정) 등록일(5%) */}
                    <col style={{ width: "12%" }} />
                    <col style={{ width: "6%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "6%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "13%" }} />
                    <col style={{ width: "5%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "6%" }} />
                    <col style={{ width: "7%" }} />
                    <col style={{ width: "5%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {([
                        ["이름","left"], ["주민번호","center"], ["가능언어","left"],
                        ["학력","left"], ["업무유형","left"], ["세부유형","left"],
                        ["전문분야","left"], ["상세정보","left"], ["평점","center"],
                        ["지역","center"], ["가용상태","center"], ["운영상태","center"], ["등록일","center"],
                      ] as [string, React.CSSProperties["textAlign"]][]).map(([h, align]) => (
                        <th key={h} style={{ ...tableTh, textAlign: align }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {translatorList.map(t => {
                      const inactive = t.isActive === false;
                      const statusColor = inactive ? "#9ca3af" : t.availabilityStatus === "available" ? "#059669" : t.availabilityStatus === "busy" ? "#d97706" : "#dc2626";
                      const statusBg = inactive ? "#f3f4f6" : t.availabilityStatus === "available" ? "#f0fdf4" : t.availabilityStatus === "busy" ? "#fffbeb" : "#fef2f2";
                      return (
                        <tr key={t.id} onClick={() => setTranslatorDetailModal({ userId: t.id, email: t.email })} style={{ cursor: "pointer", opacity: inactive ? 0.6 : 1 }}
                          onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          {/* 이름 / 이메일 / 휴대폰 */}
                          <td style={{ ...tableTd }}>
                            <div>
                              {t.name
                                ? <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>{t.name}</span>
                                : <span style={{ fontSize: 13, color: "#374151" }}>{t.email}</span>}
                            </div>
                            {t.name && <div style={{ color: "#6b7280", fontSize: 11 }}>{t.email}</div>}
                            {t.phone && <div style={{ fontSize: 11, color: "#9ca3af" }}>{formatPhoneDisplay(t.phone)}</div>}
                          </td>
                          {/* 주민번호 (서버사이드 마스킹) */}
                          <td style={{ ...tableTd, fontSize: 11, textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace", color: t.residentNumber ? "#374151" : "#d1d5db" }}>
                            {t.residentNumber ?? "-"}
                          </td>
                          {/* 가능언어 */}
                          <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>
                            {t.languagePairs ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                                {normalizeLanguages(t.languagePairs).split(",").map((lp, i) => (
                                  <span key={i} style={{ background: "#eff6ff", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px", fontSize: 11, whiteSpace: "nowrap" }}>{lp.trim()}</span>
                                ))}
                              </div>
                            ) : <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          {/* 학력 */}
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>
                            {t.education
                              ? <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden", whiteSpace: "normal" }}>{getEducationLabel(t.education)}</span>
                              : <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          {/* 업무유형 — 프로필 우선, 없으면 단가 기반 */}
                          <td style={{ ...tableTd, fontSize: 12 }}>
                            {(() => {
                              const profileWTs = (t.profileWorkTypes ?? "").split(",").map(s => s.trim()).filter(Boolean);
                              const display = profileWTs.length > 0 ? profileWTs : (t.workTypes ?? []);
                              return display.length > 0
                                ? <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                                    {display.map((w, i) => (
                                      <span key={i} style={{ background: "#f3e8ff", color: "#7c3aed", borderRadius: 4, padding: "1px 5px", fontSize: 11, whiteSpace: "nowrap" }}>{w}</span>
                                    ))}
                                  </div>
                                : <span style={{ color: "#d1d5db" }}>-</span>;
                            })()}
                          </td>
                          {/* 세부유형 — 프로필 우선, 없으면 단가 기반 */}
                          <td style={{ ...tableTd, fontSize: 12 }}>
                            {(() => {
                              const profileSTs = (t.profileSubTypes ?? "").split(",").map(s => s.trim()).filter(Boolean);
                              const display = profileSTs.length > 0 ? profileSTs : (t.subTypes ?? []);
                              if (display.length === 0) return <span style={{ color: "#d1d5db" }}>-</span>;
                              const LIMIT = 2;
                              const isExpanded = expandedSubtypeRows.has(t.id);
                              const visible = isExpanded ? display : display.slice(0, LIMIT);
                              const hiddenCount = display.length - LIMIT;
                              const toggle = (e: React.MouseEvent) => {
                                e.stopPropagation();
                                setExpandedSubtypeRows(prev => {
                                  const next = new Set(prev);
                                  isExpanded ? next.delete(t.id) : next.add(t.id);
                                  return next;
                                });
                              };
                              return (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
                                  {visible.map((s, i) => (
                                    <span key={i} style={{ background: "#f0fdf4", color: "#065f46", borderRadius: 4, padding: "1px 5px", fontSize: 11, whiteSpace: "nowrap" }}>{s}</span>
                                  ))}
                                  {!isExpanded && hiddenCount > 0 && (
                                    <button onClick={toggle} style={{ background: "none", border: "none", padding: "0 2px", fontSize: 11, color: "#9ca3af", cursor: "pointer", whiteSpace: "nowrap", lineHeight: "inherit" }}>
                                      +{hiddenCount}
                                    </button>
                                  )}
                                  {isExpanded && (
                                    <button onClick={toggle} style={{ background: "none", border: "none", padding: "0 2px", fontSize: 11, color: "#9ca3af", cursor: "pointer", whiteSpace: "nowrap", lineHeight: "inherit", textDecoration: "underline" }}>
                                      접기
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          {/* 전문분야 — chip 렌더링, 3개 이상 +N */}
                          <td style={{ ...tableTd, fontSize: 12 }}>
                            {(() => {
                              const items = (t.specializations ?? "").split(",").map(s => s.trim()).filter(Boolean);
                              if (items.length === 0) return <span style={{ color: "#d1d5db" }}>-</span>;
                              const LIMIT = 2;
                              const visible = items.slice(0, LIMIT);
                              const hiddenCount = items.length - LIMIT;
                              return (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
                                  {visible.map((s, i) => (
                                    <span key={i} style={{ background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "1px 5px", fontSize: 11, whiteSpace: "nowrap" }}>{s}</span>
                                  ))}
                                  {hiddenCount > 0 && (
                                    <span style={{ fontSize: 11, color: "#9ca3af", whiteSpace: "nowrap" }}>+{hiddenCount}</span>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          {/* 상세정보 */}
                          <td style={{ ...tableTd, fontSize: 11, color: "#6b7280" }}>
                            {t.bio
                              ? <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as any, overflow: "hidden", whiteSpace: "normal" }}>{t.bio}</span>
                              : <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          {/* 평점 */}
                          <td style={{ ...tableTd, textAlign: "center", overflow: "hidden", whiteSpace: "nowrap" }}>
                            {t.rating != null ? <span style={{ fontWeight: 700, color: "#d97706" }}>★ {Number(t.rating).toFixed(1)}</span> : <span style={{ color: "#d1d5db" }}>-</span>}
                          </td>
                          {/* 지역 — 국내(대한민국)는 국가명 생략, 해외는 국가 포함 표시 */}
                          <td
                            title={t.region ?? undefined}
                            style={{
                              ...tableTd, fontSize: 12, color: "#6b7280", textAlign: "center",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 0,
                            }}
                          >
                            {formatRegionDisplay(t.region)}
                          </td>
                          {/* 가용상태 — 고정폭 유지, 지역 등 인접 컬럼 텍스트 침범 방지용 overflow hidden */}
                          <td style={{ ...tableTd, padding: "9px 4px", overflow: "hidden" }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <span style={{ padding: "2px 7px", borderRadius: 10, background: statusBg, color: statusColor, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                                {inactive ? "불가" : (AVAILABILITY_LABEL[t.availabilityStatus ?? "available"] ?? t.availabilityStatus)}
                              </span>
                            </div>
                          </td>
                          {/* 운영상태 */}
                          <td style={{ ...tableTd, padding: "9px 4px", overflow: "hidden" }}>
                            {(() => {
                              if (inactive) {
                                return (
                                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    <span style={{ padding: "2px 7px", borderRadius: 10, background: "#f3f4f6", color: "#9ca3af", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                                      비활성
                                    </span>
                                  </div>
                                );
                              }
                              const os = t.operationalStatus ?? "normal";
                              const osMeta: Record<string, { label: string; bg: string; color: string }> = {
                                normal:   { label: "정상",  bg: "#f0fdf4", color: "#059669" },
                                warning:  { label: "주의",  bg: "#fffbeb", color: "#b45309" },
                                hold:     { label: "보류",  bg: "#fff7ed", color: "#c2410c" },
                                excluded: { label: "제외",  bg: "#fef2f2", color: "#dc2626" },
                              };
                              const m = osMeta[os] ?? osMeta.normal;
                              return (
                                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                  <span style={{ padding: "2px 7px", borderRadius: 10, background: m.bg, color: m.color, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                                    {m.label}
                                  </span>
                                  {t.reassignmentAllowed === false && (
                                    <span style={{ fontSize: 10, color: "#dc2626", whiteSpace: "nowrap" }}>재배정불가</span>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          {/* 등록일 */}
                          <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap", overflow: "hidden", textAlign: "center" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</td>
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
      {adminTab === "settings" && (
        <SettingsTab token={token} onToast={setToast} />
      )}

      {/* ── 운영 테스트 탭 ── */}
      {adminTab === "test" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>

          {/* 시나리오 실행 패널 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#111827" }}>🧪 운영 시나리오 자동 실행</h3>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280" }}>견적 작성 → 판매전환 → 통번역사 배정 → 진행 → 납품 → 완료까지 순차 실행합니다.</p>
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
                    ✅ 실제 거래처 데이터로 판매건이 생성됩니다. 최소 입력 항목: 거래처 선택 완료.
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
        <BillingManagementTab
          token={token}
          onToast={setToast}
          onNavigateToProjects={() => setAdminTab("projects")}
        />
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

          </>)}
          </div>{/* /스크롤 컨텐츠 */}
        </div>{/* /메인 컨텐츠 */}
      </div>{/* /풀스크린 레이아웃 */}
    </>
  );
}

