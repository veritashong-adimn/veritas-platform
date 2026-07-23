/**
 * adminNav — 라우터 라이브러리 없이 pushState 기반 클라이언트 네비게이션을 제공하는 공통 헬퍼.
 *
 * 관리자 화면은 App.tsx 가 모든 경로에서 AdminDashboard 를 렌더하므로, window.history 로
 * URL 을 동기화하면 사이드바/헤더 유지 + 새로고침 복원 + 브라우저 뒤로/앞으로가 모두 동작한다.
 * (기존 AdminDashboard 의 /sales/:id 처리 방식을 일반화·재사용한 것)
 *
 * 향후 담당자·프로젝트·견적·판매 등 다른 관리 화면도 동일한 목록/등록/수정 URL 패턴을
 * 이 헬퍼로 확장할 수 있도록 설계했다. (parseCompanyRoute 를 참고해 parseXxxRoute 를 추가)
 */
import { useEffect, useState } from "react";

/** pushState 는 popstate 를 발생시키지 않으므로, 앱 내 이동을 알리는 커스텀 이벤트를 함께 쓴다. */
const NAV_EVENT = "admin:navigate";

/**
 * URL 을 바꾸고(히스토리 push) 구독 중인 컴포넌트에 알린다. 같은 경로면 히스토리를 건드리지 않는다.
 * @param opts.replace 뒤로가기 스택에 남기지 않고 현재 항목을 치환한다.
 */
export function navigate(path: string, opts?: { replace?: boolean }): void {
  if (window.location.pathname !== path) {
    if (opts?.replace) window.history.replaceState({}, "", path);
    else window.history.pushState({}, "", path);
  }
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** 현재 pathname 을 구독한다. navigate()·뒤로/앞으로(popstate) 시 자동 리렌더된다. */
export function usePathname(): string {
  const [pathname, setPathname] = useState<string>(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);
  return pathname;
}

// ─── 거래처(Company) 라우트 ──────────────────────────────────────────────────

/** 거래처 화면 라우트: 목록 / 신규 등록 / 수정 */
export type CompanyRoute =
  | { view: "list" }
  | { view: "new" }
  | { view: "edit"; id: number };

/** 거래처 URL 경로 상수/빌더 — 화면·모달 어디서든 이 값만 사용한다. */
export const companyPaths = {
  list: "/admin/companies",
  new: "/admin/companies/new",
  edit: (id: number) => `/admin/companies/${id}/edit`,
} as const;

/** pathname 이 거래처 화면 경로면 해당 라우트를, 아니면 null 을 반환한다. */
export function parseCompanyRoute(pathname: string): CompanyRoute | null {
  if (pathname === companyPaths.list || pathname === companyPaths.list + "/") return { view: "list" };
  if (pathname === companyPaths.new) return { view: "new" };
  const m = pathname.match(/^\/admin\/companies\/(\d+)\/edit$/);
  if (m) return { view: "edit", id: Number(m[1]) };
  return null;
}

/** pathname 이 거래처 화면 경로 중 하나인지(목록·신규·수정) 여부 */
export function isCompanyPath(pathname: string): boolean {
  return parseCompanyRoute(pathname) !== null;
}
