export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const api = (path: string) => `${BASE}${path}`;

export const TOKEN_KEY = "auth_token";
export const USER_KEY = "auth_user";

export type Role = "customer" | "translator" | "admin";
export type User = { id: number; email: string; role: Role };
export type NavPage = "dashboard" | "admin";

export type Project = {
  id: number; userId: number; title: string;
  fileUrl: string | null; status: string; createdAt: string;
};
export type Task = {
  id: number; projectId: number; translatorId: number;
  status: string; createdAt: string;
  projectTitle: string | null; projectStatus: string | null;
};
export type PaymentPanel = { projectId: number; paymentId: number; amount: number } | null;
export type AdminSettlement = {
  id: number; projectId: number; translatorId: number; paymentId: number | null;
  totalAmount: string; translatorAmount: string; platformFee: string;
  status: string; createdAt: string;
  projectTitle: string | null; translatorEmail: string | null;
};
export type MySettlement = {
  id: number; projectId: number;
  totalAmount: string; translatorAmount: string; platformFee: string;
  status: string; createdAt: string; projectTitle: string | null;
};
export type AdminProject = {
  id: number; title: string; status: string; fileUrl: string | null;
  createdAt: string; customerEmail: string | null; customerId: number | null;
  projectCustomerId: number | null; adminId: number | null;
  contactId: number | null; companyId: number | null;
  contactName: string | null; companyName: string | null;
};
export type AdminPayment = {
  id: number; projectId: number; amount: number; status: string;
  createdAt: string; projectTitle: string | null; projectStatus: string | null;
};
export type AdminTask = {
  id: number; projectId: number; translatorId: number; status: string;
  createdAt: string; projectTitle: string | null; projectStatus: string | null;
  translatorEmail: string | null;
};
export type LogEntry = { id: number; entityType: string; entityId: number; action: string; performedByEmail: string | null; metadata: string | null; createdAt: string };
export type NoteEntry = { id: number; content: string; createdAt: string; adminEmail: string | null };
export type AdminUser = { id: number; email: string; role: Role; isActive: boolean; createdAt: string };
export type AdminCustomer = {
  id: number; companyName: string; contactName: string; email: string;
  phone: string | null; createdAt: string;
  projectCount: number; totalPayment: number;
  unpaidAmount: number; lastTransactionAt: string | null; inProgressCount: number;
};
export type CustomerProjectItem = { id: number; title: string; status: string; createdAt: string };
export type CustomerDetail = AdminCustomer & {
  projects: CustomerProjectItem[];
  totalSettlement: number;
};
export type Communication = {
  id: number; customerId: number; projectId: number | null;
  type: "email" | "phone" | "message"; content: string; createdAt: string;
  companyName?: string | null; contactName?: string | null;
};
export type ProjectTaskDetail = {
  id: number; translatorId: number; status: string; createdAt: string;
  translatorEmail: string | null;
  translatorProfile: {
    languagePairs: string | null; specializations: string | null;
    rating: number | null; availabilityStatus: string; bio: string | null;
  } | null;
  translatorRates: TranslatorRate[];
};
export type MatchCandidate = {
  id: number; email: string; score: number;
  profile: {
    languagePairs: string | null; specializations: string | null;
    rating: number | null; availabilityStatus: string; bio: string | null;
  } | null;
  rates: TranslatorRate[];
};
export type ProjectDetail = AdminProject & {
  quotes: Array<{ id: number; price: string | number; amount?: number; status: string; createdAt: string }>;
  payments: Array<{ id: number; amount: number; status: string; createdAt: string }>;
  tasks: ProjectTaskDetail[];
  settlements: Array<{ id: number; totalAmount: number; translatorAmount: number; platformFee: number; status: string; createdAt: string }>;
  logs: LogEntry[];
  notes: NoteEntry[];
  communications: Communication[];
  company: { id: number; name: string; representativeName: string | null; email: string | null; phone: string | null; industry: string | null } | null;
  contact: { id: number; name: string; department: string | null; position: string | null; email: string | null; phone: string | null } | null;
};
export type Company = {
  id: number; name: string; businessNumber: string | null; industry: string | null;
  address: string | null; website: string | null; notes: string | null;
  representativeName: string | null; email: string | null; phone: string | null;
  createdAt: string; contactCount: number; projectCount: number; totalPayment: number;
};
export type Division = {
  id: number; companyId: number; name: string; type: string | null; createdAt: string;
  projectCount?: number; totalPayment?: number; contactCount?: number;
};
export type Contact = {
  id: number; companyId: number; divisionId: number | null; name: string; department: string | null; position: string | null;
  email: string | null; phone: string | null; notes: string | null; createdAt: string;
};
export type AdminContact = {
  id: number; companyId: number; companyName: string | null;
  name: string; department: string | null; position: string | null;
  email: string | null; phone: string | null; notes: string | null; createdAt: string;
};
export type TranslatorRate = {
  id: number; translatorId: number; serviceType: string; languagePair: string;
  unit: string; rate: number; createdAt: string;
};
export type TranslatorListItem = {
  id: number; email: string; isActive: boolean; createdAt: string;
  profileId: number | null; languagePairs: string | null; specializations: string | null;
  region: string | null; rating: number | null; availabilityStatus: string | null;
  bio: string | null; ratePerWord: number | null; ratePerPage: number | null;
};
export type ContactDetail = {
  id: number; companyId: number; companyName: string | null;
  name: string; department: string | null; position: string | null;
  email: string | null; phone: string | null; notes: string | null; createdAt: string;
  projects: Array<{ id: number; title: string; status: string; createdAt: string }>;
  communications: Array<{ id: number; type: string; content: string; projectId: number | null; createdAt: string }>;
};
export type CompanyDetail = Company & {
  contacts: Contact[];
  divisions: Division[];
  projects: Array<{ id: number; title: string; status: string; createdAt: string; requestingDivisionId?: number | null }>;
  totalQuote: number; totalSettlement: number;
};
export type Product = {
  id: number; code: string; name: string; category: string | null;
  unit: string; basePrice: number; languagePair: string | null;
  field: string | null; active: boolean; createdAt: string;
};
export type BoardPost = {
  id: number; category: string; title: string; content?: string;
  pinned: boolean; visibleToAll: boolean;
  createdAt: string; updatedAt: string;
  authorId: number; authorEmail: string | null;
};
export type TranslatorProfile = {
  id?: number; userId: number;
  languagePairs?: string | null; specializations?: string | null;
  education?: string | null; major?: string | null;
  graduationYear?: number | null; region?: string | null;
  rating?: number | null; availabilityStatus?: string;
  bio?: string | null; ratePerWord?: number | null; ratePerPage?: number | null;
};

export function saveSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
export function loadSession(): { token: string; user: User } | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const raw = localStorage.getItem(USER_KEY);
  if (!token || !raw) return null;
  try { return { token, user: JSON.parse(raw) as User }; } catch { return null; }
}
export function getDefaultPage(role: Role): NavPage {
  return role === "admin" ? "admin" : "dashboard";
}

export const STATUS_LABEL: Record<string, string> = {
  created: "접수됨", quoted: "견적 발송", approved: "견적 승인",
  paid: "결제 완료", matched: "통번역사 배정", in_progress: "번역 중",
  completed: "완료", cancelled: "취소됨", waiting: "대기", assigned: "배정됨",
  working: "작업 중", done: "완료",
  pending: "대기", ready: "정산 가능",
};
export const STATUS_STYLE: Record<string, React.CSSProperties> = {
  created:     { background: "#f3f4f6", color: "#6b7280" },
  quoted:      { background: "#eff6ff", color: "#2563eb" },
  approved:    { background: "#f0fdf4", color: "#16a34a" },
  paid:        { background: "#ecfeff", color: "#0891b2" },
  matched:     { background: "#faf5ff", color: "#9333ea" },
  in_progress: { background: "#fffbeb", color: "#d97706" },
  completed:   { background: "#f0fdf4", color: "#059669" },
  cancelled:   { background: "#fef2f2", color: "#dc2626" },
  waiting:     { background: "#f3f4f6", color: "#6b7280" },
  assigned:    { background: "#eff6ff", color: "#2563eb" },
  working:     { background: "#fffbeb", color: "#d97706" },
  done:        { background: "#f0fdf4", color: "#059669" },
  pending:     { background: "#f3f4f6", color: "#6b7280" },
  ready:       { background: "#fffbeb", color: "#d97706" },
  failed:      { background: "#fef2f2", color: "#dc2626" },
};
export const ROLE_STYLE: Record<Role, React.CSSProperties> = {
  customer:   { background: "#eff6ff", color: "#2563eb" },
  translator: { background: "#faf5ff", color: "#7c3aed" },
  admin:      { background: "#fef2f2", color: "#dc2626" },
};
export const ROLE_LABEL: Record<Role, string> = {
  customer: "고객", translator: "통번역사", admin: "관리자",
};
export const BOARD_CATEGORY_LABEL: Record<string, string> = { notice: "공지", reference: "통역자료", manual: "내부매뉴얼" };
export const AVAILABILITY_LABEL: Record<string, string> = { available: "가능", busy: "바쁨", unavailable: "불가" };
export const ALL_PROJECT_STATUSES = ["created","quoted","approved","paid","matched","in_progress","completed","cancelled"] as const;
export const ALL_PAYMENT_STATUSES = ["pending","paid","failed"] as const;
export const ALL_SETTLEMENT_STATUSES = ["pending", "ready", "paid"] as const;
export const PROJECT_STATUS_TRANSITIONS: Record<string, string[]> = {
  created:     ["quoted", "cancelled"],
  quoted:      ["approved", "cancelled"],
  approved:    ["paid", "cancelled"],
  paid:        ["matched", "cancelled"],
  matched:     ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed:   [],
  cancelled:   [],
};
export const ACTION_LABEL: Record<string, { ko: string; color: string; dot: string }> = {
  project_created:                  { ko: "프로젝트 접수",         color: "#2563eb", dot: "🗂️" },
  quote_created:                    { ko: "견적 생성",              color: "#7c3aed", dot: "📋" },
  quote_updated:                    { ko: "견적 수정",              color: "#7c3aed", dot: "📝" },
  quote_approved:                   { ko: "견적 승인",              color: "#16a34a", dot: "✅" },
  payment_requested:                { ko: "결제 요청",              color: "#d97706", dot: "💳" },
  payment_paid:                     { ko: "결제 완료",              color: "#0891b2", dot: "💰" },
  payment_failed:                   { ko: "결제 실패",              color: "#dc2626", dot: "❌" },
  payment_received:                 { ko: "결제 확인",              color: "#059669", dot: "💰" },
  project_matched:                  { ko: "통번역사 매칭",            color: "#9333ea", dot: "🔗" },
  task_assigned:                    { ko: "통번역사 배정",            color: "#9333ea", dot: "👤" },
  task_started:                     { ko: "작업 시작",              color: "#d97706", dot: "▶️" },
  task_completed:                   { ko: "작업 완료",              color: "#059669", dot: "🎉" },
  settlement_created:               { ko: "정산 생성",              color: "#7c3aed", dot: "📊" },
  settlement_paid:                  { ko: "정산 완료",              color: "#059669", dot: "💸" },
  project_cancelled:                { ko: "프로젝트 취소",          color: "#dc2626", dot: "🚫" },
  admin_project_cancelled:          { ko: "관리자 취소",             color: "#dc2626", dot: "🚫" },
  admin_info_updated:               { ko: "기본정보 수정",           color: "#6b7280", dot: "✏️" },
  admin_rematch:                    { ko: "통번역사 재매칭",           color: "#9333ea", dot: "🔄" },
  note_added:                       { ko: "메모 추가",               color: "#92400e", dot: "📝" },
  file_uploaded_source:             { ko: "원본 파일 업로드",        color: "#0369a1", dot: "📁" },
  file_uploaded_translated:         { ko: "번역본 파일 업로드",      color: "#15803d", dot: "📁" },
  file_uploaded_attachment:         { ko: "첨부 파일 업로드",        color: "#6b7280", dot: "📎" },
  file_deleted:                     { ko: "파일 삭제",               color: "#dc2626", dot: "🗑️" },
  communication_added_email:        { ko: "이메일 커뮤니케이션 기록", color: "#2563eb", dot: "📧" },
  communication_added_phone:        { ko: "전화 커뮤니케이션 기록",  color: "#059669", dot: "📞" },
  communication_added_message:      { ko: "메시지 커뮤니케이션 기록", color: "#7c3aed", dot: "💬" },
};
export function getActionLabel(action: string): { ko: string; color: string; dot: string } {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  if (action.startsWith("admin_forced_status_to_")) {
    const s = action.replace("admin_forced_status_to_", "");
    return { ko: `관리자 강제변경 → ${STATUS_LABEL[s] ?? s}`, color: "#dc2626", dot: "⚡" };
  }
  if (action.startsWith("admin_status_changed_to_")) {
    const s = action.replace("admin_status_changed_to_", "");
    return { ko: `관리자 상태변경 → ${STATUS_LABEL[s] ?? s}`, color: "#6b7280", dot: "🔄" };
  }
  if (action.startsWith("admin_assigned_translator_")) {
    return { ko: "통번역사 직접 배정", color: "#9333ea", dot: "👤" };
  }
  if (action.startsWith("담당자 ")) {
    return { ko: action, color: "#6b7280", dot: "👤" };
  }
  return { ko: action, color: "#6b7280", dot: "•" };
}
export const COMM_TYPE_LABEL: Record<string, string> = { email: "이메일", phone: "전화", message: "메시지" };
export const COMM_TYPE_COLOR: Record<string, string> = { email: "#2563eb", phone: "#059669", message: "#7c3aed" };
export const PROJECT_STEPS = [
  { key: "created", label: "접수" },
  { key: "quoted", label: "견적" },
  { key: "approved", label: "승인" },
  { key: "paid", label: "결제" },
  { key: "matched", label: "통번역사 배정" },
  { key: "in_progress", label: "번역 중" },
  { key: "completed", label: "완료" },
] as const;
export const PROJECT_STEP_KEYS = PROJECT_STEPS.map(s => s.key);
export const FEEDBACK_TAGS = [
  { value: "general", label: "일반", color: "#6b7280", bg: "#f3f4f6" },
  { value: "bug", label: "🐛 버그", color: "#991b1b", bg: "#fef2f2" },
  { value: "ux", label: "🎨 UX", color: "#1d4ed8", bg: "#eff6ff" },
  { value: "idea", label: "💡 아이디어", color: "#065f46", bg: "#f0fdf4" },
  { value: "urgent", label: "🔥 긴급", color: "#92400e", bg: "#fffbeb" },
] as const;
export type FeedbackTag = "general" | "bug" | "ux" | "idea" | "urgent";
