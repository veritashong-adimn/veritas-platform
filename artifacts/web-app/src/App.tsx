import { useState, useEffect } from "react";
import { User, NavPage, saveSession, clearSession, loadSession, getDefaultPage } from "./lib/constants";
import { Card, GhostBtn } from "./components/ui";
import { Navbar } from "./components/shared/Navbar";
import { AuthPage } from "./pages/AuthPage";
import { CustomerDashboard } from "./pages/CustomerDashboard";
import { TranslatorDashboard } from "./pages/TranslatorDashboard";
import { AdminDashboard } from "./pages/AdminDashboard";

function AccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <Card style={{ textAlign: "center", padding: "60px 24px" }}>
      <p style={{ margin: 0, fontSize: 40 }}>🚫</p>
      <h2 style={{ margin: "12px 0 6px", fontSize: 18, fontWeight: 700, color: "#111827" }}>
        접근 권한이 없습니다
      </h2>
      <p style={{ margin: "0 0 20px", fontSize: 14, color: "#6b7280" }}>
        관리자 계정만 접근할 수 있는 페이지입니다.
      </p>
      <GhostBtn onClick={onBack}>홈으로 돌아가기</GhostBtn>
    </Card>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [page, setPage] = useState<NavPage>("dashboard");

  useEffect(() => {
    const session = loadSession();
    if (session) {
      setToken(session.token);
      setUser(session.user);
      setPermissions(session.permissions);
      setPage(getDefaultPage(session.user.role));
    }
  }, []);

  const handleAuth = (t: string, u: User, perms?: string[]) => {
    const p = perms ?? u.permissions ?? [];
    saveSession(t, u, p);
    setToken(t);
    setUser(u);
    setPermissions(p);
    setPage(getDefaultPage(u.role));
  };

  const handleLogout = () => {
    clearSession();
    setToken(null);
    setUser(null);
    setPermissions([]);
    setPage("dashboard");
  };

  const handleEmailChange = (newEmail: string) => {
    if (!user || !token) return;
    const updated = { ...user, email: newEmail };
    setUser(updated);
    saveSession(token, updated, permissions);
  };

  const handlePageChange = (p: NavPage) => {
    if (p === "admin" && user?.role !== "admin") return;
    setPage(p);
  };

  if (!token || !user) return <AuthPage onAuth={handleAuth} />;

  const isAdmin = user.role === "admin";
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

        {user.role === "customer" && <CustomerDashboard user={user} token={token} />}
        {user.role === "translator" && <TranslatorDashboard user={user} token={token} />}
      </main>
    </div>
  );
}
