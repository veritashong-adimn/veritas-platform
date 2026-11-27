// 로그인 세션 보호 — 미사용 자동 로그아웃 보조(main.tsx 에서 1회 설치)
//  ① 탭 간 공유 활동 시각(localStorage, 세션별 키) — 실제 사용자 활동만 기록(IdleLogoutGuard)
//  ② 미저장 입력 감지 — 입력칸에 사용자가 입력한 뒤 저장성 요청(GET/HEAD 외)이 성공하기 전까지 '미저장'으로 본다.
//     자동 로그아웃 안내창의 경고 표시용일 뿐 — 자료를 저장·확정하지 않는다.
//  ③ 세션 종료 감지 — 인증 API 가 세션 만료·로그아웃·토큰 무효(401 + 세션 코드)를 응답하면 'veritas:session-ended' 이벤트로 알린다
//     (App 이 즉시 로그아웃 처리 → 만료 토큰으로 화면이 계속 쓰이지 않게).

const LAST_KEY = (sid: string) => `veritas_idle_last:${sid}`;
const REPORT_KEY = (sid: string) => `veritas_idle_report:${sid}`;
const KEY_PREFIXES = ["veritas_idle_last:", "veritas_idle_report:"];

const readNum = (k: string): number | null => { try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } };
const writeNum = (k: string, v: number) => { try { localStorage.setItem(k, String(Math.round(v))); } catch { /* 저장 불가 — 탭 내 값만 사용 */ } };

export const idleStore = {
  lastKey: LAST_KEY,
  getLast: (sid: string) => readNum(LAST_KEY(sid)),
  setLast: (sid: string, t: number) => writeNum(LAST_KEY(sid), t),
  getReport: (sid: string) => readNum(REPORT_KEY(sid)),
  setReport: (sid: string, t: number) => writeNum(REPORT_KEY(sid), t),
};

/** 로그아웃·계정 변경 시 모든 세션의 활동 기록 제거 */
export function clearIdleKeys(): void {
  try {
    const ks: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && KEY_PREFIXES.some(p => k.startsWith(p))) ks.push(k); }
    ks.forEach(k => localStorage.removeItem(k));
  } catch { /* 무시 */ }
}

// ── 미저장 입력 ──
let dirty = false;
const isEditable = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "submit", "reset", "file", "image", "hidden", "search"].includes(el.type);
  return el.isContentEditable;
};
/** 미저장 입력 여부 — 저장 이후 사용자 입력이 있었고, 화면에 저장·등록 버튼이 열려 있을 때(검색칸 입력 등 오탐 축소) */
export function hasUnsavedInput(): boolean {
  if (!dirty) return false;
  return [...document.querySelectorAll("button")].some(b => !b.disabled && b.offsetParent !== null && /저장|등록/.test(b.textContent ?? ""));
}

export const SESSION_ENDED_EVENT = "veritas:session-ended";
const SESSION_END_CODES = new Set(["SESSION_EXPIRED", "SESSION_ENDED", "SESSION_INVALID", "TOKEN_REVOKED", "ACCOUNT_BLOCKED"]);

let installed = false;
export function installSessionGuard(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const mark = (e: Event) => { if (e.isTrusted && isEditable(e.target)) dirty = true; };
  document.addEventListener("input", mark, true);
  document.addEventListener("change", mark, true);

  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    try {
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const isAuthPing = /\/api\/auth\/(heartbeat|logout|permissions)/.test(url);
      if (res.ok && method !== "GET" && method !== "HEAD" && !isAuthPing) dirty = false;   // 저장 성공 → 미저장 해제
      if (res.status === 401) {
        const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (h.get("Authorization")?.startsWith("Bearer ")) {
          const body = await res.clone().json().catch(() => null) as { code?: string } | null;
          if (body?.code && SESSION_END_CODES.has(body.code)) window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code: body.code } }));
        }
      }
    } catch { /* 감지 실패는 무시 — 응답은 그대로 전달 */ }
    return res;
  };
}
