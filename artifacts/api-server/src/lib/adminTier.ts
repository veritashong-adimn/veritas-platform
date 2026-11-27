// 관리자 등급 판정(공통 기준) — 최고관리자·일반 관리자 = users.role 'admin' 또는 RBAC 역할 'admin'.
//   PM·일반 직원·재무 담당자·게스트·열람 계정(users.role 'staff' + 그 외 역할)과 외부 계정은 관리자 아님.
//   사용처: 미사용 자동 로그아웃 시간(lib/idlePolicy) · Excel·CSV 출력/다운로드 허용(middlewares/auth requireAdminExport)
export function isAdminAccount(role: string | null | undefined, roleName?: string | null): boolean {
  return role === "admin" || roleName === "admin";
}
