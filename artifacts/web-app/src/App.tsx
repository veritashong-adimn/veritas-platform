import { useState, useEffect, useCallback } from "react";
import { User, NavPage, saveSession, clearSession, loadSession, getDefaultPage, api, TOKEN_KEY, saveIdleMinutes, loadIdleMinutes } from "./lib/constants";
import { IdleLogoutGuard } from "./components/shared/IdleLogoutGuard";
import { fallbackIdleMinutes, idlePhase, sessionKeyOf } from "./lib/idleTimer";
import { idleStore, SESSION_ENDED_EVENT } from "./lib/sessionGuard";
import { Card, GhostBtn } from "./components/ui";
import { ConfirmHost } from "./components/ui/confirmDialog";
import { Navbar } from "./components/shared/Navbar";
import { ForcePasswordChangePage } from "./components/shared/MyAccount";
import { AuthPage } from "./pages/AuthPage";
import { CustomerDashboard } from "./pages/CustomerDashboard";
import { TranslatorDashboard } from "./pages/TranslatorDashboard";
import { AdminDashboard } from "./pages/AdminDashboard";
import { SetPasswordPage } from "./pages/SetPasswordPage";
import { InsightsListPage } from "./pages/InsightsListPage";
import { InsightDetailPage } from "./pages/InsightDetailPage";

// 로그아웃(수동·미사용 만료·서버 세션 종료) — 서버 세션 종료 기록 → 토큰·사용자 정보·권한·활동 기록·메모리 캐시 제거 →
//   첫 화면으로 다시 불러온다(전체 새로고침: 화면·메모리에 남은 이전 사용자 업무자료 제거, 다른 탭은 storage 이벤트로 함께 로그아웃).
const LOGOUT_REASON_KEY = "veritas_logout_reason";
function endSession(reason: "manual" | "idle" | "expired", tokenOverride?: string) {
  const token = tokenOverride ?? localStorage.getItem(TOKEN_KEY);
  if (token && reason !== "expired") {
    try { void fetch(api("/api/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {}); } catch { /* 무시 */ }
  }
  clearSession();
  try {
    if (reason !== "manual") {
      sessionStorage.setItem(LOGOUT_REASON_KEY, reason);
      // 같은 세션의 다른 탭(storage 이벤트로 다시 불러옴)에도 안내 — 10초 안에 읽은 탭만 표시
      localStorage.setItem(LOGOUT_REASON_KEY, JSON.stringify({ reason, at: Date.now() }));
    }
  } catch { /* 무시 */ }
  window.location.replace("/");
}
export function takeLogoutReason(): string | null {
  try {
    const own = sessionStorage.getItem(LOGOUT_REASON_KEY); sessionStorage.removeItem(LOGOUT_REASON_KEY);
    if (own) return own;
    const shared = JSON.parse(localStorage.getItem(LOGOUT_REASON_KEY) ?? "null") as { reason?: string; at?: number } | null;
    if (shared?.reason && typeof shared.at === "number" && Date.now() - shared.at < 10_000) return shared.reason;
    return null;
  } catch { return null; }
}

function AccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <Card style={{ textAlign: "center", padding: "60px 24px" }}>
      <p style={{ margin: 0, fontSize: 40 }}>🚫</p>
      <h2 style={{ margin: "12px 0 6px", fontSize: 18, fontWeight: 700, color: "#111827" }}>
        접근 권한이 없습니다
      </h2>
      <p style={{ margin: "0 0 20px", fontSize: 14, color: "#6b7280" }}>
        내부 운영자(관리자/직원) 계정만 접근할 수 있는 페이지입니다.
      </p>
      <GhostBtn onClick={onBack}>홈으로 돌아가기</GhostBtn>
    </Card>
  );
}


// 공통 확인/입력/경고 모달 호스트를 라우트와 무관하게 항상 1회 마운트(전역 window.confirm/alert/prompt 대체).
export default function App() {
  return (
    <>
      <AppInner />
      <ConfirmHost />
    </>
  );
}

function AppInner() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [page, setPage] = useState<NavPage>("dashboard");
  // 미사용 자동 로그아웃 시간(분) — 서버 값 우선(관리자 60·직원 30), 받기 전에는 역할 기본값
  const [idleMinutes, setIdleMinutes] = useState<number | null>(null);
  const [logoutNotice] = useState(() => takeLogoutReason());   // 자동 로그아웃 직후 로그인 화면 안내(1회)

  // 최신 권한·역할을 서버에서 새로고침 — 역할관리에서 권한을 바꾸거나 사용자에게 역할을 지정한 뒤
  //   재로그인 없이도 화면에 반영되도록 최초 로드 + 창으로 돌아올 때(visibility) 다시 확인한다.
  //   401이면 토큰 만료·계정 차단 → 자동 로그아웃.
  const refreshPermissions = useCallback(() => {
    const session = loadSession();
    if (!session) return;
    fetch(api("/api/auth/permissions"), {
      headers: { Authorization: `Bearer ${session.token}` },
    })
      .then(r => {
        if (r.status === 401) {
          clearSession();
          setToken(null);
          setUser(null);
          setPermissions([]);
          setPage("dashboard");
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(d => {
        if (!d?.permissions) return;
        const current = loadSession();
        if (!current || current.token !== session.token) return; // 그 사이 로그아웃·재로그인된 경우 무시
        const mustChanged = typeof d.mustChangePassword === "boolean" && d.mustChangePassword !== !!current.user.mustChangePassword;
        const roleChanged = mustChanged || (typeof d.role === "string" && (d.role !== current.user.role || (d.roleId ?? null) !== (current.user.roleId ?? null)));
        const nextUser = roleChanged ? { ...current.user, role: d.role ?? current.user.role, roleId: d.roleId ?? null,
          ...(typeof d.mustChangePassword === "boolean" ? { mustChangePassword: d.mustChangePassword } : {}) } : current.user;
        setPermissions(d.permissions);
        if (roleChanged) setUser(nextUser);
        saveSession(current.token, nextUser, d.permissions);
        if (d.idleTimeoutMinutes !== undefined) { saveIdleMinutes(d.idleTimeoutMinutes); setIdleMinutes(d.idleTimeoutMinutes ?? null); }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const session = loadSession();
    // 새로고침·재방문 시 이미 미사용 시간이 지난 세션은 화면을 열기 전에 로그아웃(절전·탭 종료 후 복귀 포함)
    if (session) {
      const min = loadIdleMinutes() ?? fallbackIdleMinutes(session.user.role);
      const last = idleStore.getLast(sessionKeyOf(session.token));
      if (min && last != null && idlePhase(Date.now(), last, min * 60_000).phase === "expired") { endSession("idle", session.token); return; }
    }
    if (session) {
      setIdleMinutes(loadIdleMinutes() ?? fallbackIdleMinutes(session.user.role));
      setToken(session.token);
      setUser(session.user);
      setPermissions(session.permissions);
      setPage(getDefaultPage(session.user.role));
      refreshPermissions();
    }
    const onVisible = () => { if (document.visibilityState === "visible") refreshPermissions(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshPermissions]);

  const handleAuth = (t: string, u: User, perms?: string[], idleMin?: number | null) => {
    const p = perms ?? u.permissions ?? [];
    clearSession();   // 이전 계정의 세션 흔적(활동 기록·캐시) 제거 후 새 계정 저장
    try { localStorage.removeItem(LOGOUT_REASON_KEY); } catch { /* 무시 */ }
    saveSession(t, u, p);
    const min = idleMin !== undefined ? idleMin : fallbackIdleMinutes(u.role);
    saveIdleMinutes(min); setIdleMinutes(min ?? null);
    setToken(t);
    setUser(u);
    setPermissions(p);
    setPage(getDefaultPage(u.role));
  };

  const handleLogout = useCallback(() => endSession("manual"), []);

  // 세션 만료(서버 401 세션 코드) — 즉시 로그아웃
  useEffect(() => {
    const onEnded = () => endSession("expired");
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);
  // 다른 탭의 로그아웃·계정 변경 — 이 탭도 화면을 다시 불러 이전 사용자 자료를 메모리에서 제거
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== TOKEN_KEY) return;
      if (/^\/(insights|set-password)(\/|$)/.test(window.location.pathname)) return;   // 로그인과 무관한 공개 화면
      if (e.key === null || e.newValue !== token) window.location.replace("/");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [token]);
  // 뒤로가기 캐시(bfcache)로 복원된 화면 — 로그인 상태가 바뀌었으면 다시 불러온다(로그아웃 후 이전 업무화면 노출 방지)
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted && localStorage.getItem(TOKEN_KEY) !== token) window.location.reload(); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [token]);

  const handleEmailChange = (newEmail: string) => {
    if (!user || !token) return;
    const updated = { ...user, email: newEmail };
    setUser(updated);
    saveSession(token, updated, permissions);
  };

  const isInternalUser = (role: string) => role === "admin" || role === "staff";

  const handlePageChange = (p: NavPage) => {
    if (p === "admin" && !isInternalUser(user?.role ?? "")) return;
    setPage(p);
  };

  // set-password 초대 링크 처리: 로그인 없이 접근 가능
  if (window.location.pathname === "/set-password") {
    return <SetPasswordPage />;
  }

  // 공개 인사이트 페이지: 로그인 없이 접근 가능
  if (window.location.pathname === "/insights" || window.location.pathname === "/insights/") {
    return <InsightsListPage />;
  }
  const insightDetailMatch = window.location.pathname.match(/^\/insights\/(.+)$/);
  if (insightDetailMatch) {
    return <InsightDetailPage slug={insightDetailMatch[1]} />;
  }

  if (!token || !user) return (
    <>
      {logoutNotice && (
        <div role="status" data-testid="auto-logout-notice" style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 1000,
          padding: "10px 18px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, color: "#92400e", fontSize: 13, fontWeight: 600, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
          {logoutNotice === "idle" ? "장시간 사용하지 않아 자동 로그아웃되었습니다. 다시 로그인해 주세요." : "로그인 세션이 종료되었습니다. 다시 로그인해 주세요."}
        </div>
      )}
      <AuthPage onAuth={handleAuth} />
    </>
  );

  // 내부 사용자(관리자·직원) — 미사용 자동 로그아웃 감시(관리자 60분·직원 30분)
  const idleGuard = isInternalUser(user.role) && idleMinutes
    ? <IdleLogoutGuard key={token} token={token} timeoutMinutes={idleMinutes} onLogout={(r) => endSession(r === "idle" ? "idle" : "manual")} />
    : null;

  // 임시 비밀번호 계정 — 본인 비밀번호 변경 전에는 변경 화면만(서버도 다른 API 를 403 으로 막는다)
  if (user.mustChangePassword) {
    return <>{idleGuard}<ForcePasswordChangePage user={user} token={token} onLogout={handleLogout} /></>;
  }

  const isAdmin = isInternalUser(user.role);
  const showAdminPage = page === "admin";

  if (showAdminPage && !isAdmin) {
    return (
      <div style={{
        minHeight: "100vh", background: "#f9fafb",
        fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif",
      }}>
        <Navbar user={user} page={page} onPageChange={handlePageChange} onLogout={handleLogout} token={token} onEmailChange={handleEmailChange} />
        <main style={{ maxWidth: 1100, margin: "0 auto", padding: "80px 24px 48px" }}>
          <AccessDenied onBack={() => setPage("dashboard")} />
        </main>
      </div>
    );
  }

  const PAGE_META: Record<string, { title: string; desc: string }> = {
    customer_dashboard: { title: "번역 의뢰 관리", desc: "번역 프로젝트를 등록하고 진행 상황을 확인하세요." },
    translator_dashboard: { title: "번역 작업 관리", desc: "배정된 번역 작업을 확인하고 진행해주세요." },
  };
  const metaKey = `${user.role}_${page}`;
  const meta = PAGE_META[metaKey];

  if (isAdmin) {
    return (
      <div style={{ fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif" }}>
        <AdminDashboard user={user} token={token} permissions={permissions} onLogout={handleLogout} />
        {idleGuard}
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#f9fafb",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif",
    }}>
      <Navbar user={user} page={page} onPageChange={handlePageChange} onLogout={handleLogout} token={token} onEmailChange={handleEmailChange} />

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "80px 24px 48px" }}>
        {meta && (
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#111827" }}>
              {meta.title}
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: "#6b7280" }}>{meta.desc}</p>
          </div>
        )}

        {(user.role === "customer" || user.role === "client") && <CustomerDashboard user={user} token={token} />}
        {user.role === "translator" && <TranslatorDashboard user={user} token={token} />}
      </main>
    </div>
  );
}
