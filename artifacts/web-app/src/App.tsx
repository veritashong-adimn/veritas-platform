import { useState, useCallback, useEffect } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const api = (path: string) => `${BASE}${path}`;

type Role = "customer" | "translator" | "admin";
type User = { id: number; email: string; role: Role };
type Project = { id: number; userId: number; title: string; status: string; createdAt: string };
type Task = {
  id: number; projectId: number; translatorId: number;
  status: string; createdAt: string;
  projectTitle: string | null; projectStatus: string | null;
};

const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";

function saveSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
function loadSession(): { token: string; user: User } | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const raw = localStorage.getItem(USER_KEY);
  if (!token || !raw) return null;
  try { return { token, user: JSON.parse(raw) as User }; } catch { return null; }
}

const STATUS_COLOR: Record<string, string> = {
  created: "#6b7280", quoted: "#2563eb", approved: "#16a34a",
  matched: "#9333ea", in_progress: "#f59e0b", completed: "#059669",
  waiting: "#6b7280", assigned: "#2563eb", working: "#f59e0b", done: "#059669",
  customer: "#1d4ed8", translator: "#7c3aed", admin: "#dc2626",
};

function Badge({ status }: { status: string }) {
  return (
    <span style={{
      background: STATUS_COLOR[status] ?? "#6b7280", color: "#fff",
      padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
    }}>{status}</span>
  );
}

function Msg({ text }: { text: string }) {
  if (!text) return null;
  const isErr = text.startsWith("오류") || text.startsWith("실패");
  return (
    <div style={{
      padding: "8px 12px", marginBottom: 12,
      background: isErr ? "#fee2e2" : "#dcfce7",
      border: `1px solid ${isErr ? "#f87171" : "#86efac"}`,
      borderRadius: 4, fontSize: 13,
    }}>{text}</div>
  );
}

function btn(bg: string, small = false): React.CSSProperties {
  return {
    background: bg, color: "#fff", border: "none",
    padding: small ? "4px 10px" : "8px 16px",
    borderRadius: 4, cursor: "pointer", fontFamily: "monospace",
    fontSize: small ? 12 : 14,
  };
}

const input: React.CSSProperties = {
  display: "block", width: "100%", padding: "6px 8px", marginTop: 4,
  border: "1px solid #d1d5db", borderRadius: 4, fontFamily: "monospace",
  fontSize: 14, boxSizing: "border-box",
};

const th: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontWeight: 700,
  borderBottom: "2px solid #d1d5db", background: "#f3f4f6", whiteSpace: "nowrap",
};
const td: React.CSSProperties = { padding: "8px 12px", verticalAlign: "middle" };
const section: React.CSSProperties = {
  border: "1px solid #e5e7eb", borderRadius: 6, padding: 16, marginBottom: 20,
};
const h3: React.CSSProperties = { fontSize: "1rem", marginBottom: 12 };

function Table({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr>{headers.map(h => <th key={h} style={th}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ borderBottom: "1px solid #e5e7eb" }}>
            {row.map((cell, j) => <td key={j} style={td}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuthForm({ onAuth }: { onAuth: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("customer");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { setMsg("오류: 이메일과 비밀번호를 입력해주세요."); return; }
    setLoading(true); setMsg("");
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login"
        ? { email, password }
        : { email, password, role };
      const res = await fetch(api(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(`오류: ${data.error}`); return; }
      onAuth(data.token, data.user);
    } catch { setMsg("오류: 서버 연결 실패"); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ maxWidth: 400, margin: "60px auto", fontFamily: "monospace" }}>
      <h1 style={{ borderBottom: "2px solid #000", paddingBottom: 8, marginBottom: 24 }}>
        통번역 플랫폼
      </h1>
      <div style={section}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            style={{ ...btn(mode === "login" ? "#1d4ed8" : "#e5e7eb"), color: mode === "login" ? "#fff" : "#374151" }}
            onClick={() => { setMode("login"); setMsg(""); }}
          >로그인</button>
          <button
            style={{ ...btn(mode === "register" ? "#1d4ed8" : "#e5e7eb"), color: mode === "register" ? "#fff" : "#374151" }}
            onClick={() => { setMode("register"); setMsg(""); }}
          >회원가입</button>
        </div>
        <Msg text={msg} />
        <form onSubmit={submit}>
          <label>
            이메일
            <input style={input} type="email" value={email}
              onChange={e => setEmail(e.target.value)} placeholder="example@email.com" />
          </label>
          <label style={{ marginTop: 10, display: "block" }}>
            비밀번호
            <input style={input} type="password" value={password}
              onChange={e => setPassword(e.target.value)} placeholder="최소 6자" />
          </label>
          {mode === "register" && (
            <label style={{ marginTop: 10, display: "block" }}>
              역할
              <select style={{ ...input, marginTop: 4 }} value={role}
                onChange={e => setRole(e.target.value as Role)}>
                <option value="customer">고객 (customer)</option>
                <option value="translator">번역사 (translator)</option>
              </select>
            </label>
          )}
          <button type="submit" style={{ ...btn("#111"), marginTop: 16, width: "100%" }} disabled={loading}>
            {loading ? "처리중..." : mode === "login" ? "로그인" : "회원가입"}
          </button>
        </form>
        {mode === "login" && (
          <div style={{ marginTop: 16, fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
            <strong>테스트 계정 (기존 DB 비밀번호 없음 → 회원가입 필요)</strong><br />
            먼저 회원가입으로 새 계정을 만들어 테스트하세요.
          </div>
        )}
      </div>
    </div>
  );
}

function CustomerView({ user, token }: { user: User; token: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [msg, setMsg] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);

  const authHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };

  const fetchProjects = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const res = await fetch(api(`/api/projects?userId=${user.id}`));
      setProjects(await res.json());
    } catch { setMsg("오류: 프로젝트 조회 실패"); }
    finally { setLoading(false); }
  }, [user.id]);

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setMsg("오류: 제목을 입력해주세요."); return; }
    setMsg("");
    try {
      const res = await fetch(api("/api/projects"), {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(`오류: ${data.error}`); return; }
      setMsg(`프로젝트 생성 완료 (id: ${data.id})`);
      setTitle("");
      await fetchProjects();
    } catch { setMsg("오류: 프로젝트 생성 실패"); }
  };

  return (
    <div>
      <h2 style={{ marginBottom: 16, color: "#1d4ed8" }}>고객 대시보드</h2>
      <Msg text={msg} />
      <section style={section}>
        <h3 style={h3}>새 프로젝트 생성</h3>
        <form onSubmit={createProject} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ flex: 1, minWidth: 200 }}>
            프로젝트 제목
            <input style={input} value={title} onChange={e => setTitle(e.target.value)}
              placeholder="예: 영한 번역 요청" />
          </label>
          <button type="submit" style={btn("#2563eb")}>생성</button>
        </form>
      </section>
      <section style={section}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h3 style={{ ...h3, margin: 0 }}>내 프로젝트 목록</h3>
          <button onClick={fetchProjects} style={btn("#374151")} disabled={loading}>
            {loading ? "로딩중..." : "새로고침"}
          </button>
        </div>
        {projects.length === 0
          ? <p style={{ color: "#6b7280", fontSize: 13 }}>새로고침을 눌러 프로젝트를 불러오세요.</p>
          : <Table
            headers={["ID", "제목", "상태", "생성일시"]}
            rows={projects.map(p => [
              p.id, p.title,
              <Badge status={p.status} />,
              new Date(p.createdAt).toLocaleString("ko-KR"),
            ])}
          />}
      </section>
    </div>
  );
}

function TranslatorView({ user, token }: { user: User; token: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<number | null>(null);

  const authHeaders = {
    "Authorization": `Bearer ${token}`,
  };

  const fetchTasks = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const res = await fetch(api(`/api/tasks?translatorId=${user.id}`));
      setTasks(await res.json());
    } catch { setMsg("오류: 작업 조회 실패"); }
    finally { setLoading(false); }
  }, [user.id]);

  const doAction = async (taskId: number, action: "start" | "complete") => {
    setActing(taskId); setMsg("");
    try {
      const endpoint = action === "start"
        ? api(`/api/tasks/${taskId}/start`)
        : api(`/api/tasks/${taskId}/complete`);
      const res = await fetch(endpoint, { method: "PATCH", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) { setMsg(`오류: ${data.error}`); return; }
      setMsg(action === "start" ? `작업 #${taskId} 시작됨` : `작업 #${taskId} 완료됨`);
      await fetchTasks();
    } catch { setMsg("오류: 작업 상태 변경 실패"); }
    finally { setActing(null); }
  };

  return (
    <div>
      <h2 style={{ marginBottom: 16, color: "#7c3aed" }}>번역사 대시보드</h2>
      <Msg text={msg} />
      <section style={section}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h3 style={{ ...h3, margin: 0 }}>배정된 작업 목록</h3>
          <button onClick={fetchTasks} style={btn("#374151")} disabled={loading}>
            {loading ? "로딩중..." : "새로고침"}
          </button>
        </div>
        {tasks.length === 0
          ? <p style={{ color: "#6b7280", fontSize: 13 }}>새로고침을 눌러 배정된 작업을 확인하세요.</p>
          : <Table
            headers={["Task ID", "프로젝트", "Task 상태", "프로젝트 상태", "액션"]}
            rows={tasks.map(t => [
              t.id,
              t.projectTitle ?? `#${t.projectId}`,
              <Badge status={t.status} />,
              t.projectStatus ? <Badge status={t.projectStatus} /> : "-",
              <div style={{ display: "flex", gap: 6 }}>
                {(t.status === "waiting" || t.status === "assigned")
                  ? <button style={btn("#f59e0b", true)} onClick={() => doAction(t.id, "start")} disabled={acting === t.id}>작업 시작</button>
                  : null}
                {t.status === "working"
                  ? <button style={btn("#059669", true)} onClick={() => doAction(t.id, "complete")} disabled={acting === t.id}>작업 완료</button>
                  : null}
                {t.status === "done"
                  ? <span style={{ color: "#059669", fontSize: 12, fontWeight: 600 }}>✓ 완료</span>
                  : null}
              </div>,
            ])}
          />}
      </section>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const session = loadSession();
    if (session) { setToken(session.token); setUser(session.user); }
  }, []);

  const handleAuth = (t: string, u: User) => {
    saveSession(t, u);
    setToken(t); setUser(u);
  };

  const handleLogout = () => {
    clearSession();
    setToken(null); setUser(null);
  };

  if (!token || !user) return <AuthForm onAuth={handleAuth} />;

  return (
    <div style={{ fontFamily: "monospace", maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "2px solid #000", paddingBottom: 8, marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>통번역 플랫폼</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
          <span>{user.email}</span>
          <Badge status={user.role} />
          <button style={btn("#6b7280", true)} onClick={handleLogout}>로그아웃</button>
        </div>
      </div>

      {user.role === "customer" && <CustomerView user={user} token={token} />}
      {user.role === "translator" && <TranslatorView user={user} token={token} />}
      {user.role === "admin" && (
        <div style={{ ...section, color: "#374151" }}>
          <strong>관리자 계정입니다.</strong>
          <p style={{ marginTop: 8, fontSize: 13 }}>관리자 화면은 추후 구현 예정입니다.</p>
        </div>
      )}
    </div>
  );
}
