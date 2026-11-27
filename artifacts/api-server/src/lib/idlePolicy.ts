// 계정별 미사용 자동 로그아웃 정책(서버 기준) — 순수 함수(외부 의존 없음, 단위 테스트 대상: src/test-idle-session.ts)
//  · 관리자(users.role='admin' 또는 RBAC 역할 'admin'): 60분 / 내부 직원(users.role='staff' — PM·재무·열람 등): 30분
//  · 고객·통번역사 등 외부 계정: 이번 정책 대상 아님(null — 미사용 만료 검사 없음, 로그아웃 세션 차단은 공통 적용)
//  · 미사용 시간 = 마지막 '실제 사용자 활동'(화면 활동 보고 heartbeat) 이후 경과시간. 일반 API 호출(백그라운드 조회)은 활동으로 보지 않는다.
export const ADMIN_IDLE_MINUTES = 60;
export const STAFF_IDLE_MINUTES = 30;
export const IDLE_WARNING_MINUTES = 2;   // 만료 2분 전 안내(화면)
// 화면이 보고하는 '마지막 활동 이후 경과시간' 허용 범위 — 화면은 최대 2분 간격으로 보고하므로 넉넉히 10분까지만 반영(그 이상은 10분으로 제한)
export const MAX_REPORTED_IDLE_MS = 10 * 60_000;

export function idleTimeoutMinutes(role: string | null | undefined, roleName?: string | null): number | null {
  if (role === "admin" || roleName === "admin") return ADMIN_IDLE_MINUTES;
  if (role === "staff") return STAFF_IDLE_MINUTES;
  return null;
}

export type SessionCheck = "active" | "missing" | "logged_out" | "expired";

/** 세션 상태 판정. timeoutMin=null 이면 미사용 만료 검사 없음(로그아웃·누락만 판정). */
export function checkSession(s: { exists: boolean; logoutAt: Date | null; lastActivityAt: Date | null }, timeoutMin: number | null, now: number): SessionCheck {
  if (!s.exists) return "missing";
  if (s.logoutAt) return "logged_out";
  if (timeoutMin != null && s.lastActivityAt && now - s.lastActivityAt.getTime() >= timeoutMin * 60_000) return "expired";
  return "active";
}

/** 화면이 보고한 미사용 경과(ms) → 서버 기준 마지막 활동 시각. 잘못된 값은 0(지금)으로, 상한은 MAX_REPORTED_IDLE_MS. */
export function activityTimeFromReport(now: number, reportedIdleMs: unknown): Date {
  const n = typeof reportedIdleMs === "number" && Number.isFinite(reportedIdleMs) ? reportedIdleMs : 0;
  return new Date(now - Math.min(Math.max(0, n), MAX_REPORTED_IDLE_MS));
}
