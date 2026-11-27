// ─── 판매목록 조회 결과 메모리 캐시 ────────────────────────────────────────────
// 목적: 다른 메뉴에서 판매관리로 돌아올 때 직전 조회 결과를 즉시 보여 주고, 같은 조건의 최신 자료를 백그라운드로 다시 조회해 교체한다.
// 원칙
//  · 메모리(현재 탭의 JS 변수)에만 둔다 — localStorage·sessionStorage 등 영구 저장소에 판매자료를 저장하지 않는다(새로고침·탭 종료 시 사라짐).
//  · 키 = 로그인 토큰(사용자·세션 구분) + 조회 경로 전체(자료범위·검색어·필터·날짜·정렬·페이지·페이지당).
//  · 캐시는 '표시용'일 뿐 — 화면에 보이는 즉시 같은 조건으로 최신 조회를 다시 하며, 실패하면 화면에 '이전 조회 결과'임을 표시한다.
//  · 무효화: 이 화면(브라우저 탭)에서 저장·수정·삭제 요청(GET/HEAD 이외)이 나가면 즉시 전체 삭제(요청 시작·완료 시점 모두),
//    로그아웃·세션 만료(clearSession) 시 전체 삭제. 다른 직원이 수정한 자료는 재진입 시 최신 조회로 반영된다.
//  · 세대(generation) 번호: 저장 요청 이전에 시작된 조회의 응답이 저장 이후에 도착해도 캐시에 다시 넣지 않는다.

type Entry = { data: unknown; at: number };
const MAX_ENTRIES = 40;
const TTL_MS = 10 * 60_000;   // 10분이 지난 결과는 즉시 표시에도 쓰지 않는다(최신 조회만)
const store = new Map<string, Entry>();
let generation = 0;

export function salesCacheKey(authHeaders: Record<string, string>, path: string): string {
  return `${authHeaders.Authorization ?? ""}\n${path}`;
}
export function salesCacheGeneration(): number { return generation; }
export function getSalesCache<T>(key: string): { data: T; at: number } | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { store.delete(key); return null; }
  return e as { data: T; at: number };
}
// gen = 조회 시작 시점의 세대. 그 사이 무효화가 있었으면 저장하지 않는다.
export function setSalesCache(key: string, data: unknown, gen: number): void {
  if (gen !== generation) return;
  store.delete(key);
  store.set(key, { data, at: Date.now() });
  while (store.size > MAX_ENTRIES) { const k = store.keys().next().value; if (k === undefined) break; store.delete(k); }
}
export function clearSalesCache(): void { store.clear(); generation++; }

// 저장성 요청 감지 — 앱의 모든 fetch 를 한 번 감싸 GET/HEAD 이외 요청이면 캐시를 비운다(과잉 무효화는 안전: 다음 표시가 최신 조회).
//  활동 기록(heartbeat)처럼 판매자료를 바꾸지 않는 주기 요청은 제외.
const NON_MUTATING = ["/api/auth/heartbeat"];
let installed = false;
export function installSalesCacheInvalidation(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const mutating = method !== "GET" && method !== "HEAD" && !NON_MUTATING.some(p => url.includes(p));
    if (mutating) clearSalesCache();
    try { return await orig(input, init); }
    finally { if (mutating) clearSalesCache(); }
  };
}

// 캐시 표시 상태 문구 — 목록 상단 표시용
export function cacheStateText(s: { refreshing: boolean; failedAt?: number | null; shownAt?: number | null }): string | null {
  const hm = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (s.failedAt && s.shownAt) return `최신 자료를 불러오지 못했습니다 — 아래 목록은 ${hm(s.shownAt)} 조회 결과입니다`;
  if (s.refreshing) return "최신 자료 확인 중…";
  return null;
}
