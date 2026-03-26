import React, { useState, useCallback, useEffect } from 'react';
import {
  api, User, AdminProject, AdminPayment, AdminTask, AdminSettlement, AdminUser,
  AdminCustomer, AdminContact, Company, Contact, Product, BoardPost, TranslatorProfile,
  TranslatorListItem, TranslatorRate, NoteEntry, Communication,
  STATUS_LABEL, FEEDBACK_TAGS, COMM_TYPE_LABEL, COMM_TYPE_COLOR,
  PROJECT_STATUS_TRANSITIONS, getActionLabel, BOARD_CATEGORY_LABEL, AVAILABILITY_LABEL,
  ALL_PROJECT_STATUSES, ALL_PAYMENT_STATUSES, ALL_SETTLEMENT_STATUSES,
} from '../lib/constants';
import { StatusBadge, RoleBadge, Toast, Card, PrimaryBtn, GhostBtn, FilterPill } from '../components/ui';
import { LogModal } from '../components/admin/LogModal';
import { CompanyDetailModal } from '../components/admin/CompanyDetailModal';
import { ContactDetailModal } from '../components/admin/ContactDetailModal';
import { CustomerDetailModal } from '../components/admin/CustomerDetailModal';
import { TranslatorProfileModal } from '../components/admin/TranslatorProfileModal';
import { TranslatorDetailModal } from '../components/admin/TranslatorDetailModal';
import { ProjectDetailModal } from '../components/admin/ProjectDetailModal';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6,
};

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export function AdminDashboard({ user, token, onLogout }: { user: User; token: string; onLogout?: () => void }) {
  const [adminTab, setAdminTab] = useState<"dashboard"|"projects"|"payments"|"tasks"|"settlements"|"users"|"customers"|"companies"|"contacts"|"products"|"board"|"translators"|"test">("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const [customersLoading, setCustomersLoading] = useState(false);

  // project filters + pagination
  const PROJECT_PAGE_SIZE = 20;
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [projectSearch, setProjectSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [assignedAdminFilter, setAssignedAdminFilter] = useState<string>("all");
  const [projectPage, setProjectPage] = useState(1);

  // other filters
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  const [settlementFilter, setSettlementFilter] = useState<string>("all");

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

  // companies / products / board state
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [companyModal, setCompanyModal] = useState<number | null>(null);
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [companyForm, setCompanyForm] = useState({ name: "", businessNumber: "", industry: "", address: "", website: "", notes: "" });
  const [savingCompany, setSavingCompany] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [showProductForm, setShowProductForm] = useState(false);
  const [productForm, setProductForm] = useState({ code: "", name: "", category: "", unit: "건", basePrice: "", languagePair: "", field: "" });
  const [editingProduct, setEditingProduct] = useState<number | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);

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

  // translators tab state
  const [translatorList, setTranslatorList] = useState<TranslatorListItem[]>([]);
  const [translatorsLoading, setTranslatorsLoading] = useState(false);
  const [translatorSearch, setTranslatorSearch] = useState("");
  const [translatorLangFilter, setTranslatorLangFilter] = useState("");
  const [translatorStatusFilter, setTranslatorStatusFilter] = useState("all");
  const [translatorRatingFilter, setTranslatorRatingFilter] = useState("");
  const [translatorDetailModal, setTranslatorDetailModal] = useState<{ userId: number; email: string } | null>(null);

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

  // 관리자 프로젝트 생성 모달
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectCustomerId, setNewProjectCustomerId] = useState<number | null>(null);
  const [newProjectCompanyId, setNewProjectCompanyId] = useState<number | null>(null);
  const [newProjectContactId, setNewProjectContactId] = useState<number | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

  // modals
  type DetailModalState = { id: number; initialSection?: "info"|"company"|"translator"|"settlement"|"comms"|"notes"|"log"|"files" };
  const [detailModal, setDetailModal] = useState<DetailModalState | null>(null);
  const openDetail = (id: number, initialSection?: DetailModalState["initialSection"]) => setDetailModal({ id, initialSection });
  const [paying, setPaying] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (projectSearch.trim()) params.set("search", projectSearch.trim());
      if (projectFilter !== "all") params.set("status", projectFilter);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (assignedAdminFilter !== "all") params.set("assignedAdminId", assignedAdminFilter);
      const pUrl = `/api/admin/projects${params.toString() ? "?" + params.toString() : ""}`;

      const [pRes, pmRes, tRes, sRes, auRes] = await Promise.all([
        fetch(api(pUrl), { headers: authHeaders }),
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
  }, [token, projectSearch, projectFilter, dateFrom, dateTo, assignedAdminFilter]);

  const fetchUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const params = new URLSearchParams();
      if (userSearch.trim()) params.set("search", userSearch.trim());
      if (userRoleFilter !== "all") params.set("role", userRoleFilter);
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
    setCompaniesLoading(true);
    try {
      const params = new URLSearchParams();
      if (companySearch.trim()) params.set("search", companySearch.trim());
      const res = await fetch(api(`/api/admin/companies${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setCompanies(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 거래처 조회 실패"); }
    finally { setCompaniesLoading(false); }
  }, [token, companySearch]);

  const fetchProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const params = new URLSearchParams();
      if (productSearch.trim()) params.set("search", productSearch.trim());
      const res = await fetch(api(`/api/admin/products${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setProducts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 상품 조회 실패"); }
    finally { setProductsLoading(false); }
  }, [token, productSearch]);

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
      if (contactSearch.trim()) params.set("search", contactSearch.trim());
      const res = await fetch(api(`/api/admin/contacts${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setContacts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 담당자 조회 실패"); }
    finally { setContactsLoading(false); }
  }, [token, contactSearch]);

  const fetchTranslators = useCallback(async () => {
    setTranslatorsLoading(true);
    try {
      const params = new URLSearchParams();
      if (translatorSearch.trim()) params.set("search", translatorSearch.trim());
      if (translatorLangFilter.trim()) params.set("languagePair", translatorLangFilter.trim());
      if (translatorStatusFilter !== "all") params.set("status", translatorStatusFilter);
      if (translatorRatingFilter.trim()) params.set("minRating", translatorRatingFilter.trim());
      const res = await fetch(api(`/api/admin/translators${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setTranslatorList(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 번역사 조회 실패"); }
    finally { setTranslatorsLoading(false); }
  }, [token, translatorSearch, translatorLangFilter, translatorStatusFilter, translatorRatingFilter]);

  const handleCreateCompany = async () => {
    if (!companyForm.name.trim()) { setToast("회사명을 입력하세요."); return; }
    setSavingCompany(true);
    try {
      const res = await fetch(api("/api/admin/companies"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(companyForm),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("거래처가 등록되었습니다.");
      setCompanyForm({ name: "", businessNumber: "", industry: "", address: "", website: "", notes: "" });
      setShowCompanyForm(false);
      await fetchCompanies();
    } catch { setToast("오류: 거래처 등록 실패"); }
    finally { setSavingCompany(false); }
  };

  const handleSaveProduct = async () => {
    if (!productForm.code.trim() || !productForm.name.trim() || !productForm.basePrice) {
      setToast("코드, 상품명, 기본단가는 필수입니다."); return;
    }
    setSavingProduct(true);
    try {
      const payload = { ...productForm, basePrice: Number(productForm.basePrice) };
      const url = editingProduct ? `/api/admin/products/${editingProduct}` : "/api/admin/products";
      const method = editingProduct ? "PATCH" : "POST";
      const res = await fetch(api(url), {
        method, headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(editingProduct ? "상품이 수정되었습니다." : "상품이 등록되었습니다.");
      setProductForm({ code: "", name: "", category: "", unit: "건", basePrice: "", languagePair: "", field: "" });
      setEditingProduct(null);
      setShowProductForm(false);
      await fetchProducts();
    } catch { setToast("오류: 상품 저장 실패"); }
    finally { setSavingProduct(false); }
  };

  const handleToggleProduct = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/products/${id}/toggle`), { method: "PATCH", headers: authHeaders });
      if (!res.ok) { setToast("오류: 상태 변경 실패"); return; }
      await fetchProducts();
    } catch { setToast("오류: 상태 변경 실패"); }
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

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { if (adminTab === "users") fetchUsers(); }, [adminTab, fetchUsers]);
  useEffect(() => { if (adminTab === "customers") fetchCustomers(); }, [adminTab, fetchCustomers]);
  useEffect(() => { if (adminTab === "companies") fetchCompanies(); }, [adminTab, fetchCompanies]);
  useEffect(() => { if (adminTab === "contacts") fetchContacts(); }, [adminTab, fetchContacts]);
  useEffect(() => { if (adminTab === "products") fetchProducts(); }, [adminTab, fetchProducts]);
  useEffect(() => { if (adminTab === "board") fetchBoard(); }, [adminTab, fetchBoard]);
  useEffect(() => { if (adminTab === "translators") fetchTranslators(); }, [adminTab, fetchTranslators]);

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

  const handleCreateAdminProject = async () => {
    if (!newProjectTitle.trim()) { setToast("프로젝트 제목을 입력하세요."); return; }
    setCreatingProject(true);
    try {
      const res = await fetch(api("/api/admin/projects"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newProjectTitle.trim(),
          customerId: newProjectCustomerId ?? undefined,
          companyId: newProjectCompanyId ?? undefined,
          contactId: newProjectContactId ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(`프로젝트 #${data.id} 생성 완료`);
      setShowCreateProject(false);
      setNewProjectTitle(""); setNewProjectCustomerId(null); setNewProjectCompanyId(null); setNewProjectContactId(null);
      await fetchAll();
      openDetail(data.id);
    } catch { setToast("오류: 프로젝트 생성 실패"); }
    finally { setCreatingProject(false); }
  };

  const runSettlementPay = async (settlementId: number) => {
    setPaying(settlementId);
    try {
      const res = await fetch(api(`/api/admin/settlements/${settlementId}/pay`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(`정산 #${settlementId} 완료 처리되었습니다.`);
      await fetchAll();
    } catch { setToast("오류: 정산 처리 실패"); }
    finally { setPaying(null); }
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

  const tableTh: React.CSSProperties = {
    padding: "10px 12px", textAlign: "left", fontSize: 12,
    fontWeight: 600, color: "#6b7280", background: "#f9fafb",
    borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
  };
  const tableTd: React.CSSProperties = {
    padding: "11px 12px", fontSize: 13, color: "#374151",
    borderBottom: "1px solid #f3f4f6", verticalAlign: "middle",
  };

  const SIDEBAR_GROUPS = [
    {
      label: "운영관리",
      items: [
        { id: "dashboard", label: "대시보드", icon: "◉" },
        { id: "projects", label: "프로젝트", icon: "📋" },
        { id: "payments", label: "결제", icon: "💳" },
        { id: "tasks", label: "작업", icon: "⚙️" },
        { id: "settlements", label: "정산", icon: "📊" },
      ],
    },
    {
      label: "사용자/고객",
      items: [
        { id: "users", label: "사용자관리", icon: "👤" },
        { id: "customers", label: "고객관리", icon: "🏠" },
        { id: "companies", label: "거래처", icon: "🏢" },
        { id: "contacts", label: "담당자", icon: "📇" },
      ],
    },
    {
      label: "번역/단가",
      items: [
        { id: "translators", label: "번역사", icon: "🌐" },
        { id: "products", label: "상품/단가", icon: "💰" },
      ],
    },
    {
      label: "기타",
      items: [
        { id: "board", label: "게시판", icon: "📌" },
        { id: "test", label: "운영 테스트", icon: "🧪" },
      ],
    },
  ] as const;

  const PAGE_TITLE: Record<string, string> = {
    dashboard: "대시보드",
    projects: "프로젝트",
    payments: "결제",
    tasks: "작업",
    settlements: "정산",
    users: "사용자관리",
    customers: "고객관리",
    companies: "거래처",
    contacts: "담당자",
    translators: "번역사",
    products: "상품/단가",
    board: "게시판",
    test: "운영 테스트",
  };

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />
      {companyModal !== null && (
        <CompanyDetailModal
          companyId={companyModal}
          token={token}
          onClose={() => setCompanyModal(null)}
          onToast={setToast}
          onOpenProject={(id) => { setCompanyModal(null); openDetail(id); }}
        />
      )}
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
          onClose={() => setTranslatorDetailModal(null)}
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
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", width: "100%", maxWidth: 680, padding: "24px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  {boardPostModal.pinned && <span style={{ background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>📌 고정</span>}
                  <span style={{ background: "#eff6ff", color: "#2563eb", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{BOARD_CATEGORY_LABEL[boardPostModal.category] ?? boardPostModal.category}</span>
                  {boardPostModal.visibleToAll && <span style={{ background: "#f0fdf4", color: "#059669", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>공개</span>}
                </div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>{boardPostModal.title}</h2>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "#9ca3af" }}>{boardPostModal.authorEmail} · {new Date(boardPostModal.createdAt).toLocaleDateString("ko-KR")}</p>
              </div>
              <button onClick={() => setBoardPostModal(null)} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af" }}>×</button>
            </div>
            <div style={{ background: "#f9fafb", borderRadius: 10, padding: "16px 18px", fontSize: 14, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: 16, border: "1px solid #e5e7eb" }}>
              {boardPostModal.content ?? "내용 없음"}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => handleDeleteBoardPost(boardPostModal.id)} style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>삭제</button>
            </div>
          </div>
        </div>
      )}
      {resetPwUserId !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400 }}>
          <div style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 400, padding: "28px 32px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#111827" }}>비밀번호 재설정</h3>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280" }}>
              사용자 #{resetPwUserId}의 비밀번호를 재설정합니다.
            </p>
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
          </div>
        </div>
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

          {/* 메뉴 그룹 */}
          <nav style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
            {SIDEBAR_GROUPS.map(group => (
              <div key={group.label}>
                <div style={{ padding: "8px 20px 4px", fontSize: 10, fontWeight: 700, color: "#5a6478", textTransform: "uppercase", letterSpacing: "0.8px", whiteSpace: "nowrap" }}>
                  {group.label}
                </div>
                {group.items.map(item => {
                  const isActive = adminTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setAdminTab(item.id as typeof adminTab)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        width: "100%", padding: "8px 20px", border: "none", cursor: "pointer",
                        background: isActive ? "#2563eb" : "transparent",
                        color: isActive ? "#fff" : "#c1c8d4",
                        fontSize: 13, fontWeight: isActive ? 600 : 400,
                        textAlign: "left", whiteSpace: "nowrap",
                        borderRadius: 0, transition: "background 0.12s, color 0.12s",
                      }}
                      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "#2d3547"; }}
                      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                    >
                      <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{item.icon}</span>
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
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
          {adminTab === "dashboard" && (
            <div>
              <div style={{ marginBottom: 24 }}>
                <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: "#111827" }}>전체 현황</h2>
                <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>통번역 플랫폼 운영 현황을 한눈에 확인합니다.</p>
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 32 }}>
                {[
                  { label: "전체 프로젝트", value: projects.length, color: "#2563eb", bg: "#eff6ff", sub: "총 등록 건수", onClick: () => setAdminTab("projects") },
                  { label: "결제 완료", value: payments.filter(p => p.status === "paid").length, color: "#059669", bg: "#f0fdf4", sub: "결제 확인 완료", onClick: () => setAdminTab("payments") },
                  { label: "진행 중 작업", value: tasks.filter(t => t.status !== "done").length, color: "#d97706", bg: "#fffbeb", sub: "번역 진행 중", onClick: () => setAdminTab("tasks") },
                  { label: "완료된 작업", value: tasks.filter(t => t.status === "done").length, color: "#9333ea", bg: "#faf5ff", sub: "번역 완료", onClick: () => setAdminTab("tasks") },
                  { label: "정산 대기", value: settlements.filter(s => s.status === "ready").length, color: "#dc2626", bg: "#fef2f2", sub: "정산 처리 필요", onClick: () => setAdminTab("settlements") },
                ].map(s => (
                  <div key={s.label} onClick={s.onClick} style={{
                    background: s.bg, border: `1px solid ${s.color}22`,
                    borderRadius: 12, padding: "20px 24px", minWidth: 160, flex: "1 1 140px",
                    cursor: "pointer", transition: "box-shadow 0.12s",
                  }}
                    onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.boxShadow = `0 4px 12px ${s.color}22`}
                    onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.boxShadow = "none"}
                  >
                    <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: s.color }}>{s.label}</p>
                    <p style={{ margin: "0 0 4px", fontSize: 30, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</p>
                    <p style={{ margin: 0, fontSize: 11, color: `${s.color}99` }}>{s.sub}</p>
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "20px 22px" }}>
                  <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#111827" }}>최근 프로젝트</h3>
                  {projects.slice(0, 5).map(p => (
                    <div key={p.id} onClick={() => openDetail(p.id)} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f3f4f6", cursor: "pointer" }}>
                      <span style={{ fontSize: 13, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                      <StatusBadge status={p.status} />
                    </div>
                  ))}
                  {projects.length === 0 && <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>프로젝트가 없습니다.</p>}
                </div>
                <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", padding: "20px 22px" }}>
                  <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#111827" }}>최근 정산</h3>
                  {settlements.slice(0, 5).map(s => (
                    <div key={s.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f3f4f6" }}>
                      <span style={{ fontSize: 13, color: "#374151" }}>{(s as any).translatorName ?? s.translatorId}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{Number(s.translatorAmount).toLocaleString()}원</span>
                    </div>
                  ))}
                  {settlements.length === 0 && <p style={{ fontSize: 13, color: "#9ca3af", margin: 0 }}>정산 내역이 없습니다.</p>}
                </div>
              </div>
            </div>
          )}

      {/* 관리자 프로젝트 생성 모달 */}
      {showCreateProject && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400 }}>
          <div style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 480, padding: "28px 32px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 18px", fontSize: 17, fontWeight: 800, color: "#111827" }}>프로젝트 직접 등록</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>제목 *</label>
                <input value={newProjectTitle} onChange={e => setNewProjectTitle(e.target.value)}
                  placeholder="프로젝트 제목" autoFocus
                  style={{ width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, outline: "none" }}
                  onKeyDown={e => e.key === "Enter" && handleCreateAdminProject()} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>고객 (선택)</label>
                <select value={newProjectCustomerId ?? ""} onChange={e => setNewProjectCustomerId(e.target.value ? Number(e.target.value) : null)}
                  style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, background: "#fff" }}>
                  <option value="">— 고객 없이 등록 —</option>
                  {customers.map(c => <option key={c.id} value={c.id}>{c.contactName} ({c.email})</option>)}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>거래처 (선택)</label>
                  <select value={newProjectCompanyId ?? ""} onChange={e => { setNewProjectCompanyId(e.target.value ? Number(e.target.value) : null); setNewProjectContactId(null); }}
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, background: "#fff" }}>
                    <option value="">— 없음 —</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>담당자 (선택)</label>
                  <select value={newProjectContactId ?? ""} onChange={e => setNewProjectContactId(e.target.value ? Number(e.target.value) : null)}
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, background: "#fff" }}>
                    <option value="">— 없음 —</option>
                    {contacts
                      .filter((c: any) => !newProjectCompanyId || c.companyId === newProjectCompanyId)
                      .map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <GhostBtn onClick={() => { setShowCreateProject(false); setNewProjectTitle(""); }}>취소</GhostBtn>
              <PrimaryBtn onClick={handleCreateAdminProject} disabled={creatingProject || !newProjectTitle.trim()} style={{ padding: "9px 20px" }}>
                {creatingProject ? "생성 중..." : "프로젝트 등록"}
              </PrimaryBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── 프로젝트 탭 ── */}
      {adminTab === "projects" && (
        <Section title={`전체 프로젝트 (${projects.length})`} action={
          <div style={{ display: "flex", gap: 8 }}>
            <PrimaryBtn onClick={() => { fetchCustomers(); fetchCompanies(); fetchContacts(); setShowCreateProject(true); }} style={{ fontSize: 13, padding: "7px 14px" }}>+ 프로젝트 등록</PrimaryBtn>
            <GhostBtn onClick={() => handleExportCSV("projects")} style={{ fontSize: 13, padding: "7px 14px" }}>⬇ CSV 내보내기</GhostBtn>
          </div>
        }>
          {/* 검색 + 필터 */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
            <input
              value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
              placeholder="제목, 이메일, 거래처, 담당자 검색..."
              style={{ ...inputStyle, maxWidth: 280, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchAll()}
            />
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13 }} />
            <span style={{ color: "#9ca3af", fontSize: 13 }}>~</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13 }} />
            <select value={assignedAdminFilter} onChange={e => setAssignedAdminFilter(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13, cursor: "pointer" }}>
              <option value="all">전체 담당자</option>
              {adminUsers.map(a => <option key={a.id} value={String(a.id)}>{a.email}</option>)}
            </select>
            <PrimaryBtn onClick={fetchAll} disabled={loading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {loading ? "검색 중..." : "검색"}
            </PrimaryBtn>
            {(projectSearch || dateFrom || dateTo || assignedAdminFilter !== "all" || projectFilter !== "all") && (
              <GhostBtn onClick={() => { setProjectSearch(""); setDateFrom(""); setDateTo(""); setAssignedAdminFilter("all"); setProjectFilter("all"); setProjectPage(1); }} style={{ padding: "8px 12px", fontSize: 13 }}>
                초기화
              </GhostBtn>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            <FilterPill label="전체" active={projectFilter === "all"} onClick={() => { setProjectFilter("all"); setProjectPage(1); }} />
            {ALL_PROJECT_STATUSES.map(s => (
              <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                active={projectFilter === s} onClick={() => { setProjectFilter(s); setProjectPage(1); }} />
            ))}
          </div>

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
                <Card style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          {["ID","제목","고객","거래처","담당자","상태","생성일","빠른액션"].map(h => (
                            <th key={h} style={tableTh}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedProjects.map(p => {
                          type SectionKey = "info"|"company"|"translator"|"settlement"|"comms"|"notes"|"log"|"files";
                          const ACTION_MAP: Record<string, { label: string; section: SectionKey; primary?: boolean; green?: boolean }> = {
                            created:     { label: "견적 생성",   section: "settlement", primary: true },
                            quoted:      { label: "견적 확인",   section: "settlement", primary: true },
                            approved:    { label: "결제 등록",   section: "settlement", primary: true },
                            paid:        { label: "번역사 배정", section: "translator", primary: true },
                            matched:     { label: "작업 관리",   section: "translator" },
                            in_progress: { label: "작업 관리",   section: "translator" },
                            completed:   { label: "정산 확인",   section: "settlement", green: true },
                            cancelled:   { label: "내용 보기",   section: "info" },
                          };
                          const action = ACTION_MAP[p.status] ?? { label: "상세보기", section: "info" as SectionKey };
                          const primaryBtnStyle: React.CSSProperties = { background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "4px 9px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
                          const secondaryBtnStyle: React.CSSProperties = { background: "#eff6ff", color: "#2563eb", border: "none", borderRadius: 6, padding: "4px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" };
                          const greenBtnStyle: React.CSSProperties = { background: "#dcfce7", color: "#15803d", border: "none", borderRadius: 6, padding: "4px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" };
                          const dangerBtnStyle: React.CSSProperties = { background: "#fef2f2", color: "#dc2626", border: "none", borderRadius: 6, padding: "4px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" };
                          return (
                            <tr key={p.id}
                              onClick={() => openDetail(p.id)}
                              style={{ cursor: "pointer", transition: "background 0.1s" }}
                              onMouseEnter={e => (e.currentTarget.style.background = "#f0f9ff")}
                              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                              <td style={{ ...tableTd, color: "#9ca3af" }}>#{p.id}</td>
                              <td style={{ ...tableTd, fontWeight: 600, color: "#2563eb", maxWidth: 200 }}>
                                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                              </td>
                              <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{p.customerEmail ?? "-"}</td>
                              <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.companyName ?? "-"}</td>
                              <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.contactName ?? "-"}</td>
                              <td style={tableTd}><StatusBadge status={p.status} /></td>
                              <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                                {new Date(p.createdAt).toLocaleDateString("ko-KR")}
                              </td>
                              <td style={{ ...tableTd }} onClick={e => e.stopPropagation()}>
                                <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "nowrap" }}>
                                  <button
                                    onClick={() => openDetail(p.id, action.section)}
                                    style={action.primary ? primaryBtnStyle : action.green ? greenBtnStyle : secondaryBtnStyle}>
                                    {action.label}
                                  </button>
                                  <button
                                    onClick={() => openDetail(p.id)}
                                    style={{ ...secondaryBtnStyle, background: "#f3f4f6", color: "#6b7280" }}>
                                    보기
                                  </button>
                                  {p.status !== "cancelled" && p.status !== "completed" && (
                                    <button
                                      onClick={async () => {
                                        if (!confirm(`프로젝트 #${p.id}를 취소하시겠습니까?`)) return;
                                        const res = await fetch(api(`/api/admin/projects/${p.id}/cancel`), {
                                          method: "PATCH",
                                          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                                        });
                                        if (res.ok) { setToast("프로젝트가 취소되었습니다."); fetchAll(); }
                                        else { const d = await res.json(); setToast(`오류: ${d.error}`); }
                                      }}
                                      style={dangerBtnStyle}>
                                      취소
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
                </Card>
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
                    <tr>{["ID","프로젝트","번역사","작업 상태","프로젝트 상태","생성일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {tasks.map(t => (
                      <tr key={t.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{t.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{t.projectTitle ?? `프로젝트 #${t.projectId}`}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>
                          {(t as any).translatorName || t.translatorEmail || `번역사 #${t.translatorId}`}
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
        const filtered = settlementFilter === "all" ? settlements : settlements.filter(s => s.status === settlementFilter);
        return (
          <Section
            title={`정산 현황 (${filtered.length})`}
            action={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <GhostBtn onClick={() => handleExportCSV("settlements")} style={{ fontSize: 12, padding: "6px 12px" }}>⬇ CSV</GhostBtn>
                <FilterPill label="전체" active={settlementFilter === "all"} onClick={() => setSettlementFilter("all")} />
                {ALL_SETTLEMENT_STATUSES.map(s => (
                  <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                    active={settlementFilter === s} onClick={() => setSettlementFilter(s)} />
                ))}
              </div>
            }
          >
            {loading ? (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
            ) : filtered.length === 0 ? (
              <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>정산 내역이 없습니다.</Card>
            ) : (
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>{["ID","프로젝트","번역사","총 결제금액","번역사 지급액","플랫폼 수수료","상태","생성일","액션"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {filtered.map(s => (
                        <tr key={s.id}
                          onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          <td style={{ ...tableTd, color: "#9ca3af" }}>#{s.id}</td>
                          <td style={{ ...tableTd, fontWeight: 600, color: "#111827", maxWidth: 160 }}>
                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.projectTitle ?? `프로젝트 #${s.projectId}`}</div>
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>
                            {(s as any).translatorName || s.translatorEmail || `번역사 #${s.translatorId}`}
                            {(s as any).translatorName && s.translatorEmail && <div style={{ color: "#9ca3af", fontSize: 11 }}>{s.translatorEmail}</div>}
                          </td>
                          <td style={{ ...tableTd, fontWeight: 700, color: "#0891b2", whiteSpace: "nowrap" }}>{Number(s.totalAmount).toLocaleString()}원</td>
                          <td style={{ ...tableTd, fontWeight: 700, color: "#059669", whiteSpace: "nowrap" }}>{Number(s.translatorAmount).toLocaleString()}원</td>
                          <td style={{ ...tableTd, color: "#9333ea", whiteSpace: "nowrap" }}>{Number(s.platformFee).toLocaleString()}원</td>
                          <td style={tableTd}><StatusBadge status={s.status} /></td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(s.createdAt).toLocaleDateString("ko-KR")}</td>
                          <td style={tableTd}>
                            {s.status === "ready" && (
                              <button onClick={() => runSettlementPay(s.id)} disabled={paying === s.id} style={{
                                padding: "4px 10px", fontSize: 12, borderRadius: 6,
                                cursor: paying === s.id ? "not-allowed" : "pointer",
                                background: paying === s.id ? "#86efac" : "#059669",
                                border: "none", color: "#fff", fontWeight: 600, whiteSpace: "nowrap",
                              }}>
                                {paying === s.id ? "처리 중..." : "정산 완료 처리"}
                              </button>
                            )}
                            {s.status === "paid" && <span style={{ color: "#059669", fontSize: 12, fontWeight: 600 }}>✓ 완료</span>}
                            {s.status === "pending" && <span style={{ color: "#9ca3af", fontSize: 12 }}>대기 중</span>}
                          </td>
                        </tr>
                      ))}
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
        <Section title={`사용자 관리 (${users.length})`}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input
              value={userSearch} onChange={e => setUserSearch(e.target.value)}
              placeholder="이메일 검색..."
              style={{ ...inputStyle, maxWidth: 260, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
            />
            <select value={userRoleFilter} onChange={e => setUserRoleFilter(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13, cursor: "pointer" }}>
              <option value="all">전체 역할</option>
              <option value="customer">고객</option>
              <option value="translator">번역사</option>
              <option value="admin">관리자</option>
            </select>
            <PrimaryBtn onClick={fetchUsers} disabled={usersLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {usersLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>

          {usersLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : users.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>사용자가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","이메일","역할","상태","가입일","역할 변경","계정 상태","비밀번호","프로필"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{u.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>
                          {(u as any).name && <div style={{ fontWeight: 700, marginBottom: 2 }}>{(u as any).name}</div>}
                          <div style={{ fontSize: 12, color: (u as any).name ? "#6b7280" : "#111827" }}>{u.email}</div>
                        </td>
                        <td style={tableTd}><RoleBadge role={u.role} /></td>
                        <td style={tableTd}>
                          <span style={{
                            padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                            background: u.isActive ? "#f0fdf4" : "#fef2f2",
                            color: u.isActive ? "#059669" : "#dc2626",
                          }}>
                            {u.isActive ? "활성" : "비활성"}
                          </span>
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {new Date(u.createdAt).toLocaleDateString("ko-KR")}
                        </td>
                        <td style={tableTd}>
                          {u.role !== "admin" ? (
                            <select
                              value={u.role}
                              disabled={roleChanging === u.id}
                              onChange={e => handleRoleChange(u.id, e.target.value)}
                              style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, cursor: "pointer", background: "#fff" }}>
                              <option value="customer">고객</option>
                              <option value="translator">번역사</option>
                            </select>
                          ) : (
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>변경 불가</span>
                          )}
                        </td>
                        <td style={tableTd}>
                          {u.role !== "admin" ? (
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
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>—</span>
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
                    <tr>{["ID","회사명","담당자","이메일","전화","프로젝트","총 결제","등록일"].map(h => (
                      <th key={h} style={tableTh}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {customers.map(c => (
                      <tr key={c.id}
                        onClick={() => setCustomerModal(c.id)}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{c.companyName}</td>
                        <td style={tableTd}>{c.contactName}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{c.email}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.phone ?? "-"}</td>
                        <td style={{ ...tableTd, textAlign: "center" }}>
                          <span style={{ padding: "2px 10px", borderRadius: 12, background: "#eff6ff", color: "#2563eb", fontSize: 12, fontWeight: 600 }}>
                            {c.projectCount}건
                          </span>
                        </td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#059669", whiteSpace: "nowrap" }}>
                          {Number(c.totalPayment).toLocaleString()}원
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {new Date(c.createdAt).toLocaleDateString("ko-KR")}
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

      {/* ── 거래처 탭 ── */}
      {adminTab === "companies" && (
        <Section title={`거래처 관리 (${companies.length})`} action={
          <PrimaryBtn onClick={() => setShowCompanyForm(v => !v)} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showCompanyForm ? "취소" : "+ 거래처 등록"}
          </PrimaryBtn>
        }>
          {showCompanyForm && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>새 거래처 등록</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                {([["name","회사명 *"],["businessNumber","사업자번호"],["industry","업종"],["address","주소"],["website","웹사이트"]] as const).map(([f, l]) => (
                  <div key={f}>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>{l}</label>
                    <input value={companyForm[f]} onChange={e => setCompanyForm(p => ({ ...p, [f]: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
                  </div>
                ))}
                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>메모</label>
                  <textarea value={companyForm.notes} onChange={e => setCompanyForm(p => ({ ...p, notes: e.target.value }))}
                    rows={2} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px", resize: "vertical" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryBtn onClick={handleCreateCompany} disabled={savingCompany} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {savingCompany ? "등록 중..." : "등록"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowCompanyForm(false)} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input value={companySearch} onChange={e => setCompanySearch(e.target.value)}
              placeholder="회사명, 사업자번호 검색..."
              style={{ ...inputStyle, maxWidth: 300, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchCompanies()} />
            <PrimaryBtn onClick={fetchCompanies} disabled={companiesLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {companiesLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {companiesLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : companies.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 거래처가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","회사명","업종","담당자","프로젝트","총 결제","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {companies.map(c => (
                      <tr key={c.id} onClick={() => setCompanyModal(c.id)} style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{c.name}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.industry ?? "-"}</td>
                        <td style={{ ...tableTd, textAlign: "center" }}>
                          <span style={{ padding: "2px 8px", borderRadius: 10, background: "#f3f4f6", color: "#374151", fontSize: 12 }}>{c.contactCount}명</span>
                        </td>
                        <td style={{ ...tableTd, textAlign: "center" }}>
                          <span style={{ padding: "2px 8px", borderRadius: 10, background: "#eff6ff", color: "#2563eb", fontSize: 12, fontWeight: 600 }}>{c.projectCount}건</span>
                        </td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#059669", whiteSpace: "nowrap" }}>{Number(c.totalPayment).toLocaleString()}원</td>
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

      {/* ── 담당자 탭 ── */}
      {adminTab === "contacts" && (
        <Section title={`담당자 관리 (${contacts.length})`}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input value={contactSearch} onChange={e => setContactSearch(e.target.value)}
              placeholder="이름, 이메일, 부서, 거래처 검색..."
              style={{ ...inputStyle, maxWidth: 320, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
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
                    <tr>{["ID","이름","부서/직책","이메일","전화","거래처","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {contacts.map(c => (
                      <tr key={c.id} onClick={() => setContactModal(c.id)} style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{c.name}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>
                          {[c.department, c.position].filter(Boolean).join(" / ") || "-"}
                        </td>
                        <td style={{ ...tableTd, color: "#2563eb", fontSize: 12 }}>{c.email ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{c.phone ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.companyName ?? "-"}</td>
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
        <Section title={`상품/단가 관리 (${products.length})`} action={
          <PrimaryBtn onClick={() => { setShowProductForm(v => !v); setEditingProduct(null); setProductForm({ code: "", name: "", category: "", unit: "건", basePrice: "", languagePair: "", field: "" }); }} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showProductForm && !editingProduct ? "취소" : "+ 상품 등록"}
          </PrimaryBtn>
        }>
          {showProductForm && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>{editingProduct ? "상품 수정" : "새 상품 등록"}</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                {([["code","상품 코드 *"],["name","상품명 *"],["category","분류"],["unit","단위"],["basePrice","기본단가 *"],["languagePair","언어 조합"],["field","전문 분야"]] as const).map(([f, l]) => (
                  <div key={f}>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>{l}</label>
                    <input value={productForm[f]} onChange={e => setProductForm(p => ({ ...p, [f]: e.target.value }))}
                      type={f === "basePrice" ? "number" : "text"}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryBtn onClick={handleSaveProduct} disabled={savingProduct} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {savingProduct ? "저장 중..." : "저장"}
                </PrimaryBtn>
                <GhostBtn onClick={() => { setShowProductForm(false); setEditingProduct(null); }} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input value={productSearch} onChange={e => setProductSearch(e.target.value)}
              placeholder="상품명, 코드 검색..."
              style={{ ...inputStyle, maxWidth: 300, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchProducts()} />
            <PrimaryBtn onClick={fetchProducts} disabled={productsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {productsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {productsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : products.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 상품이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["코드","상품명","분류","단위","기본단가","언어조합","분야","상태","관리"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {products.map(p => (
                      <tr key={p.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, fontFamily: "monospace", fontSize: 12, color: "#6b7280" }}>{p.code}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{p.name}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.category ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12 }}>{p.unit}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#2563eb", whiteSpace: "nowrap" }}>{Number(p.basePrice).toLocaleString()}원</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.languagePair ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.field ?? "-"}</td>
                        <td style={tableTd}>
                          <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12, fontWeight: 600, background: p.active ? "#f0fdf4" : "#f3f4f6", color: p.active ? "#059669" : "#9ca3af" }}>
                            {p.active ? "활성" : "비활성"}
                          </span>
                        </td>
                        <td style={{ ...tableTd, whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => { setEditingProduct(p.id); setProductForm({ code: p.code, name: p.name, category: p.category ?? "", unit: p.unit, basePrice: String(p.basePrice), languagePair: p.languagePair ?? "", field: p.field ?? "" }); setShowProductForm(true); }}
                              style={{ padding: "3px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer", background: "#eff6ff", color: "#2563eb", border: "none", fontWeight: 600 }}>수정</button>
                            <button onClick={() => handleToggleProduct(p.id)}
                              style={{ padding: "3px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer", background: p.active ? "#fef2f2" : "#f0fdf4", color: p.active ? "#dc2626" : "#059669", border: "none", fontWeight: 600 }}>
                              {p.active ? "비활성" : "활성"}
                            </button>
                          </div>
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
                  <select value={boardForm.category} onChange={e => setBoardForm(p => ({ ...p, category: e.target.value }))}
                    style={{ ...inputStyle, width: "100%", padding: "7px 10px", fontSize: 13 }}>
                    <option value="notice">공지</option>
                    <option value="reference">통역자료</option>
                    <option value="manual">내부매뉴얼</option>
                  </select>
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
                  번역사에게 공개
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

      {/* ── 번역사 탭 ── */}
      {adminTab === "translators" && (
        <Section title={`번역사 관리 (${translatorList.length})`}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input value={translatorSearch} onChange={e => setTranslatorSearch(e.target.value)}
              placeholder="이메일, 언어쌍, 지역 검색..."
              style={{ ...inputStyle, maxWidth: 260, flex: "1 1 180px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchTranslators()} />
            <input value={translatorLangFilter} onChange={e => setTranslatorLangFilter(e.target.value)}
              placeholder="언어쌍 (예: 한→영)"
              style={{ ...inputStyle, maxWidth: 160, padding: "8px 12px", fontSize: 13 }} />
            <input value={translatorRatingFilter} onChange={e => setTranslatorRatingFilter(e.target.value)}
              placeholder="최소 평점 (1~5)"
              style={{ ...inputStyle, maxWidth: 130, padding: "8px 12px", fontSize: 13 }} />
            <select value={translatorStatusFilter} onChange={e => setTranslatorStatusFilter(e.target.value)}
              style={{ ...inputStyle, padding: "8px 12px", fontSize: 13, minWidth: 100 }}>
              <option value="all">전체 상태</option>
              <option value="available">가능</option>
              <option value="busy">바쁨</option>
              <option value="unavailable">불가</option>
            </select>
            <PrimaryBtn onClick={fetchTranslators} disabled={translatorsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {translatorsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {translatorsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : translatorList.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 번역사가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","이름","언어쌍","분야","지역","평점","상태","단가(어절)","활성","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {translatorList.map(t => {
                      const statusColor = t.availabilityStatus === "available" ? "#059669" : t.availabilityStatus === "busy" ? "#d97706" : "#dc2626";
                      const statusBg = t.availabilityStatus === "available" ? "#f0fdf4" : t.availabilityStatus === "busy" ? "#fffbeb" : "#fef2f2";
                      return (
                        <tr key={t.id} onClick={() => setTranslatorDetailModal({ userId: t.id, email: t.email })} style={{ cursor: "pointer" }}
                          onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          <td style={{ ...tableTd, color: "#9ca3af" }}>#{t.id}</td>
                          <td style={{ ...tableTd, fontWeight: 600, color: "#111827", fontSize: 12 }}>
                            {(t as any).name ? <><span style={{ fontWeight: 700 }}>{(t as any).name}</span><br /><span style={{ color: "#6b7280", fontSize: 11 }}>{t.email}</span></> : t.email}
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{t.languagePairs ?? "-"}</td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{t.specializations ?? "-"}</td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{t.region ?? "-"}</td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            {t.rating != null ? <span style={{ fontWeight: 700, color: "#d97706" }}>★ {t.rating.toFixed(1)}</span> : <span style={{ color: "#9ca3af" }}>-</span>}
                          </td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, background: statusBg, color: statusColor, fontSize: 11, fontWeight: 700 }}>
                              {AVAILABILITY_LABEL[t.availabilityStatus ?? "available"] ?? t.availabilityStatus}
                            </span>
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#374151", textAlign: "right" }}>
                            {t.ratePerWord != null ? `${t.ratePerWord.toFixed(1)}원` : "-"}
                          </td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            <span style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: t.isActive ? "#059669" : "#d1d5db" }} />
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

      {/* ── 운영 테스트 탭 ── */}
      {adminTab === "test" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>

          {/* 시나리오 실행 패널 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#111827" }}>🧪 운영 시나리오 자동 실행</h3>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280" }}>프로젝트 생성 → 견적 → 승인 → 결제 → 번역사 배정 → 진행 → 완료 → 정산까지 순차 실행합니다.</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#374151", display: "block", marginBottom: 3 }}>견적 금액 (원)</label>
                  <input value={scenarioAmount} onChange={e => setScenarioAmount(e.target.value)} type="number" min="10000"
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#374151", display: "block", marginBottom: 3 }}>번역사 수익 비율 (0~1)</label>
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
                    <select value={scenarioCompanyId} onChange={e => { setScenarioCompanyId(e.target.value); setScenarioContactId(""); }}
                      style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, boxSizing: "border-box" as const }}>
                      <option value="">— 테스트 거래처 —</option>
                      {(realData?.companies ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#374151", display: "block", marginBottom: 2 }}>담당자</label>
                    <select value={scenarioContactId} onChange={e => setScenarioContactId(e.target.value)}
                      style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, boxSizing: "border-box" as const }}>
                      <option value="">— 담당자 없음 —</option>
                      {(realData?.contacts ?? [])
                        .filter(ct => !scenarioCompanyId || ct.companyId === Number(scenarioCompanyId))
                        .map(ct => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
                    </select>
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
                ① 거래처 등록 (거래처 탭) ② 담당자 등록 (담당자 탭) ③ 번역사 계정 + 프로필 등록 (번역사 탭) ④ 제품 마스터 등록 (제품 탭) ⑤ 여기서 거래처/담당자 선택 후 실행
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

          </div>{/* /스크롤 컨텐츠 */}
        </div>{/* /메인 컨텐츠 */}
      </div>{/* /풀스크린 레이아웃 */}
    </>
  );
}

