import { useState, useCallback } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const api = (path: string) => `${BASE}${path}`;

type User = { id: number; email: string; role: "customer" | "translator" | "admin" };
type Project = { id: number; userId: number; title: string; status: string; createdAt: string };
type Task = {
  id: number;
  projectId: number;
  translatorId: number;
  status: string;
  createdAt: string;
  projectTitle: string | null;
  projectStatus: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  created: "#6b7280",
  quoted: "#2563eb",
  approved: "#16a34a",
  matched: "#9333ea",
  in_progress: "#f59e0b",
  completed: "#059669",
  waiting: "#6b7280",
  assigned: "#2563eb",
  working: "#f59e0b",
  done: "#059669",
};

function Badge({ status }: { status: string }) {
  return (
    <span style={{
      background: STATUS_COLOR[status] ?? "#6b7280",
      color: "#fff",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 600,
      whiteSpace: "nowrap",
    }}>
      {status}
    </span>
  );
}

function Msg({ text }: { text: string }) {
  if (!text) return null;
  const isErr = text.startsWith("오류") || text.startsWith("실패");
  return (
    <div style={{
      padding: "8px 12px",
      marginBottom: 12,
      background: isErr ? "#fee2e2" : "#dcfce7",
      border: `1px solid ${isErr ? "#f87171" : "#86efac"}`,
      borderRadius: 4,
      fontSize: 13,
    }}>
      {text}
    </div>
  );
}

function btn(bg: string, small = false): React.CSSProperties {
  return {
    background: bg, color: "#fff", border: "none",
    padding: small ? "4px 10px" : "8px 16px",
    borderRadius: 4, cursor: "pointer",
    fontFamily: "monospace", fontSize: small ? 12 : 14,
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

function CustomerView({ user }: { user: User }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [msg, setMsg] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, title }),
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
              p.id,
              p.title,
              <Badge status={p.status} />,
              new Date(p.createdAt).toLocaleString("ko-KR"),
            ])}
          />
        }
      </section>
    </div>
  );
}

function TranslatorView({ user }: { user: User }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<number | null>(null);

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
      const res = await fetch(endpoint, { method: "PATCH" });
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
                {t.status === "waiting" || t.status === "assigned"
                  ? <button
                    style={btn("#f59e0b", true)}
                    onClick={() => doAction(t.id, "start")}
                    disabled={acting === t.id}
                  >
                    작업 시작
                  </button>
                  : null}
                {t.status === "working"
                  ? <button
                    style={btn("#059669", true)}
                    onClick={() => doAction(t.id, "complete")}
                    disabled={acting === t.id}
                  >
                    작업 완료
                  </button>
                  : null}
                {t.status === "done"
                  ? <span style={{ color: "#059669", fontSize: 12, fontWeight: 600 }}>✓ 완료</span>
                  : null}
              </div>,
            ])}
          />
        }
      </section>
    </div>
  );
}

const section: React.CSSProperties = {
  border: "1px solid #e5e7eb", borderRadius: 6,
  padding: 16, marginBottom: 20,
};
const h3: React.CSSProperties = { fontSize: "1rem", marginBottom: 12 };

export default function App() {
  const [userIdInput, setUserIdInput] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [lookupMsg, setLookupMsg] = useState("");
  const [looking, setLooking] = useState(false);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = Number(userIdInput);
    if (!id || id <= 0) { setLookupMsg("오류: 유효한 User ID를 입력해주세요."); return; }
    setLooking(true); setLookupMsg("");
    try {
      const res = await fetch(api(`/api/users/${id}`));
      if (!res.ok) { setLookupMsg("오류: 해당 사용자를 찾을 수 없습니다."); return; }
      setUser(await res.json());
    } catch { setLookupMsg("오류: 사용자 조회 실패"); }
    finally { setLooking(false); }
  };

  return (
    <div style={{ fontFamily: "monospace", maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <h1 style={{ borderBottom: "2px solid #000", paddingBottom: 8, marginBottom: 20 }}>
        통번역 플랫폼 — 테스트 대시보드
      </h1>

      <section style={{ ...section, marginBottom: 24, maxWidth: 400 }}>
        <h3 style={h3}>사용자 선택 (User ID 입력)</h3>
        <Msg text={lookupMsg} />
        <form onSubmit={lookup} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <label style={{ flex: 1 }}>
            User ID
            <input
              style={input}
              type="number"
              value={userIdInput}
              onChange={e => setUserIdInput(e.target.value)}
              placeholder="예: 1"
              min={1}
            />
          </label>
          <button type="submit" style={btn("#111")} disabled={looking}>
            {looking ? "조회중..." : "확인"}
          </button>
        </form>
        {user && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <strong>현재 사용자:</strong> {user.email} &nbsp;
            <Badge status={user.role} />
            &nbsp;
            <button
              style={{ ...btn("#6b7280", true), marginLeft: 8 }}
              onClick={() => { setUser(null); setUserIdInput(""); }}
            >
              변경
            </button>
          </div>
        )}
      </section>

      {user?.role === "customer" && <CustomerView user={user} />}
      {user?.role === "translator" && <TranslatorView user={user} />}
      {user?.role === "admin" && (
        <div style={{ ...section, color: "#374151" }}>
          <strong>관리자 계정입니다.</strong>
          <p style={{ marginTop: 8, fontSize: 13 }}>관리자 화면은 추후 구현 예정입니다.</p>
        </div>
      )}
      {!user && (
        <div style={{ ...section, color: "#6b7280", textAlign: "center" }}>
          위에서 User ID를 입력하면 역할에 맞는 화면이 표시됩니다.
          <br />
          <small style={{ marginTop: 6, display: "block" }}>
            고객(customer) / 번역사(translator) / 관리자(admin)
          </small>
        </div>
      )}
    </div>
  );
}
