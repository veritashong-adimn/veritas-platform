export type NavItem = {
  id: string;
  label: string;
  icon: string;
  perm?: string;
  /** 하위 메뉴 (1단계 중첩). 부모는 페이지가 아니라 펼침 전용. */
  children?: NavItem[];
};

export type NavGroup = {
  key: string;
  label: string;
  accentColor: string;
  isDashboard?: boolean;
  perm?: string;
  items: NavItem[];
};

/**
 * staff(roleId 미할당) 기본 노출 권한.
 * 실무 수행에 필요한 메뉴만 포함. admin 전용 메뉴 제외.
 */
export const STAFF_DEFAULT_PERMS: string[] = [
  "menu.project",
  "menu.company",
  "menu.contact",
  "menu.customer",
  "menu.translator",
  "menu.product",
  "menu.board",
];

/**
 * 재무·정산 메뉴는 별도 권한 부여 시에만 노출 (선택적).
 * admin 전용: menu.user, menu.permission, menu.settings
 *
 * 업무 흐름 기준 정렬:
 * 고객/거래처 → 프로젝트 → 리소스 → 재무·정산 → 데이터 자산 → 시스템
 */

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
    key: "project",
    label: "영업관리",
    accentColor: "#3b82f6",
    perm: "menu.project",
    items: [
      // 견적 ERP 마스터: 목록 / 등록. 부모는 펼침 전용.
      //  · 개별 휴지통 메뉴는 사이드바 하단 「통합 휴지통」으로 일원화(진입점 제거). 내부 view='trash'·API는 유지.
      { id: "quotes-catalog", label: "견적관리", icon: "📄", perm: "menu.project", children: [
        { id: "quotes",         label: "견적서 목록", icon: "📄", perm: "menu.project" },
        { id: "quote-register", label: "견적서 등록", icon: "➕", perm: "menu.project" },
      ] },
      { id: "projects", label: "판매관리", icon: "📋", perm: "menu.project" },
    ],
  },
  {
    key: "resource",
    label: "리소스",
    accentColor: "#f59e0b",
    perm: "menu.translator",
    items: [
      // 통번역사 ERP 마스터: 목록 / 등록. 상세는 목록에서 진입하는 하위 페이지(메뉴 미노출).
      //  · 개별 휴지통 메뉴는 향후 플랫폼 통합 휴지통으로 정리 예정 → 여기서 추가하지 않음.
      { id: "translator-catalog", label: "통번역사", icon: "🌐", perm: "menu.translator", children: [
        { id: "translators",         label: "통번역사 목록", icon: "🌐", perm: "menu.translator" },
        { id: "translator-register", label: "통번역사 등록", icon: "➕", perm: "menu.translator" },
      ] },
      // 상품 개별 휴지통 메뉴도 「통합 휴지통」으로 일원화(진입점 제거). ProductTrashTab·API는 유지.
      { id: "products-catalog", label: "상품관리", icon: "🏷️", perm: "menu.product", children: [
        { id: "products",         label: "상품목록", icon: "🏷️", perm: "menu.product" },
        { id: "product-register", label: "상품등록", icon: "➕",  perm: "menu.product" },
      ] },
    ],
  },
  {
    key: "finance",
    label: "재무·정산",
    accentColor: "#10b981",
    perm: "menu.payment",
    items: [
      // [지급] 정산 — 회사 → 통번역사/외주 지급.
      { id: "settlement-catalog", label: "정산", icon: "📊", perm: "menu.settlement", children: [
        { id: "settlements",          label: "지급회차 관리",     icon: "📊", perm: "menu.settlement" },
        { id: "settlement-statement", label: "지급명세서",        icon: "📄", perm: "menu.settlement" },
        { id: "settlement-tax",       label: "세무자료",          icon: "🧾", perm: "menu.settlement" },
      ] },
      // [수입] 수금관리 — 고객/거래처 → 회사 수금. 하위 화면의 기존 id·route·API·DB 는 그대로 재사용(위치만 이동).
      //  · 그룹은 perm 미지정(항상 통과) → 하위 각 항목의 개별 perm 으로 노출 제어 → 기존 접근권한 보존.
      { id: "revenue-catalog", label: "수금관리", icon: "💵", children: [
        { id: "payments",  label: "수금 현황",   icon: "💳", perm: "menu.payment" },
        { id: "billing",   label: "누적 청구",   icon: "📑", perm: "menu.settlement" },
        { id: "prepaid",   label: "선입금 관리", icon: "💰", perm: "menu.settlement" },
      ] },
    ],
  },
  {
    key: "data",
    label: "데이터 자산",
    accentColor: "#0ea5e9",
    perm: "menu.user",
    items: [
      { id: "data-layer",         label: "번역 데이터",        icon: "🗃️", perm: "menu.user" },
      { id: "language-service",   label: "언어 서비스 데이터",  icon: "📊", perm: "menu.user" },
      { id: "insight-management", label: "인사이트 관리",       icon: "💡", perm: "menu.user" },
      { id: "insight-analytics",  label: "인사이트 성과분석",   icon: "📈", perm: "menu.user" },
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
      { id: "settings", label: "환경설정",   icon: "⚙️", perm: "menu.settings" },
      { id: "test",     label: "운영 테스트", icon: "🧪", perm: "menu.user" },
    ],
  },
  {
    // 사이드바 하단 독립 메뉴 — 5개 영역(견적/거래처/담당자/상품/통번역사) 통합 휴지통.
    //  · 개별 휴지통(견적/상품 사이드바, 거래처/담당자 토글)은 병행 유지 → 안정화 후 별도 단계에서 정리.
    //  · perm 미지정: admin 대시보드를 보는 사용자에게 노출(복원/완전삭제는 서버가 영역별로 재검증).
    key: "trash",
    label: "휴지통",
    accentColor: "#6b7280",
    items: [
      { id: "trash", label: "휴지통", icon: "🗑" },
    ],
  },
];

export const ADMIN_PAGE_TITLE: Record<string, string> = {
  dashboard:   "대시보드",
  quotes:      "견적서 목록",
  "quote-register": "견적서 등록",
  "quote-trash":    "휴지통",
  projects:    "판매관리",
  tasks:       "작업",
  payments:    "수금 현황",
  settlements: "지급회차 관리",
  "settlement-statement": "지급명세서",
  "settlement-tax":       "세무자료",
  billing:     "누적 청구",
  prepaid:     "선입금 관리",
  companies:   "거래처",
  contacts:    "담당자",
  customers:   "고객관리",
  translators: "통번역사 목록",
  "translator-register": "통번역사 등록",
  "translator-detail": "통번역사 상세",
  products:    "상품목록",
  "product-register": "상품등록",
  "product-trash":    "휴지통",
  users:       "사용자관리",
  roles:       "역할관리",
  permissions: "권한설정",
  board:       "게시판",
  settings:    "환경설정",
  test:        "운영 테스트",
  "data-layer":           "번역 데이터",
  "language-service":     "언어 서비스 데이터",
  "insight-management":   "인사이트 관리",
  "insight-analytics":    "인사이트 성과분석",
  trash:                  "통합 휴지통",
};
