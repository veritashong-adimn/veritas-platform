// 미사용 자동 로그아웃 — 화면 계산(순수 함수, 외부 의존 없음 · 회귀 테스트: api-server/src/test-idle-session.ts)
//  · 시간 기준은 항상 '실제 경과시간'(Date.now 차이) — 절전·백그라운드 탭에서 타이머가 멈췄다 재개돼도 복귀 즉시 만료를 판정한다.
//  · 마지막 활동 시각은 같은 로그인 세션의 모든 탭이 localStorage 로 공유한다(sessionGuard).
export const IDLE_WARNING_MS = 2 * 60_000;            // 만료 2분 전 안내(관리자 58분·직원 28분 경과 시)
export const ACTIVITY_REPORT_INTERVAL_MS = 2 * 60_000;   // 서버 활동 보고(heartbeat) 최소 간격 — 활동이 있을 때만
export const ACTIVITY_WRITE_THROTTLE_MS = 1_000;      // 활동 시각 기록 최소 간격(마우스 이동 등 연속 이벤트)
// 화면 버전 표시 — 로그인 요청 헤더(서버 routes/auth.ts CLIENT_PROTOCOL 과 같은 값). 내부 계정은 이 화면에서만 로그인할 수 있다.
export const CLIENT_PROTOCOL_HEADER = "X-Veritas-Client";
export const CLIENT_PROTOCOL = "idle-v1";

export type IdlePhase = "active" | "warning" | "expired";

export function idlePhase(now: number, lastActivity: number, timeoutMs: number): { phase: IdlePhase; remainingMs: number } {
  const remainingMs = Math.max(0, lastActivity + timeoutMs - now);
  if (remainingMs <= 0) return { phase: "expired", remainingMs: 0 };
  if (remainingMs <= IDLE_WARNING_MS) return { phase: "warning", remainingMs };
  return { phase: "active", remainingMs };
}

/** 서버 활동 보고 필요 여부 — 마지막 보고 이후 실제 활동이 있었고, 최소 간격이 지났을 때만(불필요한 API·DB 호출 방지) */
export function shouldReportActivity(now: number, lastActivity: number, lastReportAt: number, intervalMs = ACTIVITY_REPORT_INTERVAL_MS): boolean {
  return lastActivity > lastReportAt && now - lastReportAt >= intervalMs;
}

/** 서버 값(/auth/permissions·로그인 응답)이 오기 전 사용할 기본값 — 서버 정책(api-server lib/idlePolicy)과 같다. */
export function fallbackIdleMinutes(role: string | null | undefined): number | null {
  if (role === "admin") return 60;
  if (role === "staff") return 30;
  return null;
}

export function formatCountdown(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** JWT 의 sessionId(서명 검증 없이 표시·키 용도로만) — 없으면 토큰 끝 24자. 탭 간 공유 키에 사용. */
export function sessionKeyOf(token: string): string {
  try {
    const part = token.split(".")[1] ?? "";
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof json?.sessionId === "string" && json.sessionId) return json.sessionId;
  } catch { /* 형식 오류 — 아래 대체 키 */ }
  return token.slice(-24);
}
