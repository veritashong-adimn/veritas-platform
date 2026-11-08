export type NavItem = {
  id: string;
  label: string;
  icon: string;
  perm?: string;
  /** 지정 시 이 중 하나라도 보유하면 노출(perm 대신 사용) — 예: 자료 관리설정(관리자·승인권자) */
  permAny?: string[];
  /** 메뉴에 없는 화면이지만 이 메뉴가 선택된 것으로 표시할 탭 id (예: 전체 자료 ← 자료 등록 화면) */
  activeAlso?: string[];
  /** 하위 메뉴 (1단계 중첩). 부모는 페이지가 아니라 펼침 전용. */
  children?: NavItem[];
};

/** 현재 탭이 이 메뉴(또는 activeAlso 화면)에 해당하는지 — 사이드바 선택 표시·자동 펼침용 */
export function navItemMatches(item: Pick<NavItem, "id" | "activeAlso">, tab: string): boolean {
  return item.id === tab || !!item.activeAlso?.includes(tab);
}

/** 메뉴 노출 판정 — perm 단일 키 또는 permAny(하나 이상 보유) */
export function navItemVisible(item: Pick<NavItem, "perm" | "permAny">, hasPerm: (key: string | undefined) => boolean): boolean {
  return item.permAny?.length ? item.permAny.some(k => hasPerm(k)) : hasPerm(item.perm);
}

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
      // 의뢰건 접수(pre-sales): 견적 이전 단계. 견적관리보다 위에 배치.
      { id: "inquiry-catalog", label: "의뢰건 접수", icon: "📥", perm: "menu.project", children: [
        { id: "inquiries",        label: "의뢰건 목록", icon: "📥", perm: "menu.project" },
        { id: "inquiry-register", label: "의뢰건 등록", icon: "➕", perm: "menu.project" },
      ] },
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
      // Master별로 「목록 → 등록」 순서 유지: 통번역사(목록·등록) → 외주업체(목록·등록).
      { id: "translator-catalog", label: "통번역사·외주업체", icon: "🌐", perm: "menu.translator", children: [
        { id: "translators",         label: "통번역사 목록", icon: "🌐", perm: "menu.translator" },
        { id: "translator-register", label: "통번역사 등록", icon: "➕", perm: "menu.translator" },
        { id: "vendors",             label: "외주업체 목록", icon: "🏭", perm: "menu.translator" },
        { id: "vendor-register",     label: "외주업체 등록", icon: "➕", perm: "menu.translator" },
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
        // 「과거 지급 재현(검증)」은 별도 사이드바 항목이 아니라 '지급회차 관리' 화면의 상단 하위탭으로 통합(§3).
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
      { id: "legacy-crm-archive", label: "과거 CRM 자료",      icon: "🗂️", perm: "menu.user" },
      { id: "data-layer",         label: "번역 데이터",        icon: "🗃️", perm: "menu.user" },
      { id: "language-service",   label: "언어 서비스 데이터",  icon: "📊", perm: "menu.user" },
      { id: "insight-management", label: "인사이트 관리",       icon: "💡", perm: "menu.user" },
      { id: "insight-analytics",  label: "인사이트 성과분석",   icon: "📈", perm: "menu.user" },
      // 회사 자료보관함 — 하나의 통합 저장소를 3개 메뉴(전체 자료·자료 등록·자료 관리설정)로 이용. menu.archive 보유자에게만 노출.
      //  · 그룹(data) perm 은 사이드바 필터에 쓰이지 않으므로 기존 5개 항목의 노출 범위는 그대로다.
      //  · 세부 자료 권한은 서버(자료보관함 ACL)가 강제한다.
      { id: "archive-catalog", label: "회사 자료보관함", icon: "🗄️", perm: "menu.archive", children: [
        // 2개 메뉴로 통합: 자료 현황 → 전체 자료 상단 통계, 승인 관리 → 자료 관리설정 내부 탭,
        //   자료 등록 → 전체 자료의 '+ 자료 등록' 버튼으로 진입(archive-import 화면·경로는 그대로, 메뉴 선택은 '전체 자료').
        //   기존 경로(archive-overview·archive-approvals·archive-import·archive-forms·archive-work·archive-ai)는 화면 호환을 위해 그대로 동작.
        { id: "archive-all",        label: "전체 자료",           icon: "🗂️", perm: "menu.archive", activeAlso: ["archive-import"] },
        // 관리자 전용: 자료보관함 관리자(archive.admin) 또는 승인권자(archive.approve) — 승인 관리 탭을 위해 승인권자 포함
        { id: "archive-settings",   label: "자료 관리설정",       icon: "⚙️", permAny: ["archive.admin", "archive.approve"] },
      ] },
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
    // 사이드바 하단 독립 메뉴 — 의뢰건/견적/거래처/담당자/상품/통번역사/사용자 통합 휴지통.
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
  inquiries:        "의뢰건 목록",
  "inquiry-register": "의뢰건 등록",
  "inquiry-detail":   "의뢰건 상세",
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
  vendors: "외주업체 목록",
  "vendor-register": "외주업체 등록",
  products:    "상품목록",
  "product-register": "상품등록",
  "product-trash":    "휴지통",
  users:       "사용자관리",
  roles:       "역할관리",
  permissions: "권한설정",
  board:       "게시판",
  settings:    "환경설정",
  test:        "운영 테스트",
  "legacy-crm-archive":   "과거 CRM 자료",
  "data-layer":           "번역 데이터",
  "language-service":     "언어 서비스 데이터",
  "insight-management":   "인사이트 관리",
  "insight-analytics":    "인사이트 성과분석",
  trash:                  "통합 휴지통",
  "archive-overview":     "회사 자료보관함 · 자료 현황",
  "archive-all":          "회사 자료보관함 · 전체 자료",
  "archive-forms":        "회사 자료보관함 · 서류양식 관리",
  "archive-work":         "회사 자료보관함 · 업무자료 관리",
  // 구 경로(호환) — 진입 즉시 archive-work 로 전환되지만 전환 전 제목도 동일하게 표시
  "archive-manuals":      "회사 자료보관함 · 업무자료 관리",
  "archive-contracts":    "회사 자료보관함 · 업무자료 관리",
  "archive-records":      "회사 자료보관함 · 업무자료 관리",
  "archive-hr":           "회사 자료보관함 · 업무자료 관리",
  "archive-management":   "회사 자료보관함 · 업무자료 관리",
  "archive-import":       "회사 자료보관함 · 자료 등록",
  "archive-ai":           "회사 자료보관함 · AI 지식관리",
  "archive-approvals":    "회사 자료보관함 · 승인 관리",
  "archive-settings":     "회사 자료보관함 · 자료 관리설정",
};
