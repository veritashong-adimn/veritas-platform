export type NavItem = {
  id: string;
  label: string;
  icon: string;
  iconColor?: string;
  perm?: string;
};

export type NavGroup = {
  key: string;
  label: string;
  accentColor: string;
  isDashboard?: boolean;
  perm?: string;
  items: NavItem[];
};

export const ADMIN_NAV_GROUPS: NavGroup[] = [
  {
    key: "dashboard",
    label: "대시보드",
    accentColor: "#2563eb",
    isDashboard: true,
    items: [
      { id: "dashboard", label: "대시보드", icon: "◉" },
    ],
  },
  {
    key: "project",
    label: "프로젝트 관리",
    accentColor: "#3b82f6",
    perm: "menu.project",
    items: [
      { id: "projects",    label: "프로젝트", icon: "📋", perm: "menu.project" },
      { id: "tasks",       label: "작업",     icon: "⚙️", perm: "menu.project" },
    ],
  },
  {
    key: "finance",
    label: "재무·정산",
    accentColor: "#10b981",
    perm: "menu.settlement",
    items: [
      { id: "payments",    label: "결제",       icon: "💳", iconColor: "#10b981", perm: "menu.payment" },
      { id: "settlements", label: "정산",       icon: "📊", iconColor: "#10b981", perm: "menu.settlement" },
      { id: "billing",     label: "누적 청구",  icon: "📑", iconColor: "#10b981", perm: "menu.settlement" },
      { id: "prepaid",     label: "선입금 관리", icon: "💰", iconColor: "#10b981", perm: "menu.settlement" },
    ],
  },
  {
    key: "customer",
    label: "고객·거래처",
    accentColor: "#8b5cf6",
    perm: "menu.company",
    items: [
      { id: "companies", label: "거래처",   icon: "🏢", perm: "menu.company" },
      { id: "contacts",  label: "담당자",   icon: "📇", perm: "menu.contact" },
      { id: "customers", label: "고객관리", icon: "🏠", perm: "menu.customer" },
    ],
  },
  {
    key: "resource",
    label: "리소스",
    accentColor: "#f59e0b",
    perm: "menu.translator",
    items: [
      { id: "translators", label: "통번역사", icon: "🌐", perm: "menu.translator" },
      { id: "products",    label: "상품/단가", icon: "🏷️", perm: "menu.product" },
    ],
  },
  {
    key: "system",
    label: "시스템",
    accentColor: "#6b7280",
    perm: "menu.user",
    items: [
      { id: "users",    label: "사용자관리", icon: "👤", perm: "menu.user" },
      { id: "roles",    label: "역할관리",   icon: "🔑", perm: "menu.permission" },
      { id: "board",    label: "게시판",     icon: "📌", perm: "menu.board" },
      { id: "settings", label: "환경설정",   icon: "⚙️" },
      { id: "test",     label: "운영 테스트", icon: "🧪", perm: "menu.user" },
    ],
  },
];

export const ADMIN_PAGE_TITLE: Record<string, string> = {
  dashboard:   "대시보드",
  projects:    "프로젝트",
  tasks:       "작업",
  payments:    "결제",
  settlements: "정산",
  billing:     "누적 청구",
  prepaid:     "선입금 관리",
  companies:   "거래처",
  contacts:    "담당자",
  customers:   "고객관리",
  translators: "통번역사",
  products:    "상품/단가",
  users:       "사용자관리",
  roles:       "역할관리",
  permissions: "권한설정",
  board:       "게시판",
  settings:    "환경설정",
  test:        "운영 테스트",
};
