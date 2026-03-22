import { useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Project = {
  id: number;
  userId: number;
  title: string;
  status: string;
  createdAt: string;
};

type Log = {
  id: number;
  entityType: string;
  entityId: number;
  action: string;
  createdAt: string;
};

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [message, setMessage] = useState("");

  const [userId, setUserId] = useState("1");
  const [title, setTitle] = useState("");

  const fetchProjects = async () => {
    setLoadingProjects(true);
    setMessage("");
    try {
      const res = await fetch(`${BASE}/api/projects`);
      const data = await res.json();
      setProjects(data);
    } catch {
      setMessage("프로젝트 조회 실패");
    } finally {
      setLoadingProjects(false);
    }
  };

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const res = await fetch(`${BASE}/api/logs`);
      const data = await res.json();
      setLogs(data);
    } catch {
      setMessage("로그 조회 실패");
    } finally {
      setLoadingLogs(false);
    }
  };

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    if (!title.trim()) {
      setMessage("제목을 입력해주세요.");
      return;
    }
    try {
      const res = await fetch(`${BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: Number(userId), title }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`오류: ${data.error}`);
        return;
      }
      setMessage(`프로젝트 생성 완료 (id: ${data.id})`);
      setTitle("");
      await fetchProjects();
    } catch {
      setMessage("프로젝트 생성 실패");
    }
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      created: "#6b7280",
      quoted: "#2563eb",
      approved: "#16a34a",
      matched: "#9333ea",
      in_progress: "#f59e0b",
      completed: "#059669",
    };
    return (
      <span style={{
        background: colors[status] ?? "#6b7280",
        color: "#fff",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 600,
      }}>
        {status}
      </span>
    );
  };

  return (
    <div style={{ fontFamily: "monospace", maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1 style={{ borderBottom: "2px solid #000", paddingBottom: 8 }}>
        통번역 플랫폼 — 테스트 대시보드
      </h1>

      {message && (
        <div style={{
          padding: "8px 12px",
          marginBottom: 16,
          background: message.startsWith("오류") ? "#fee2e2" : "#dcfce7",
          border: `1px solid ${message.startsWith("오류") ? "#f87171" : "#86efac"}`,
          borderRadius: 4,
        }}>
          {message}
        </div>
      )}

      <section style={{ marginBottom: 32 }}>
        <h2>프로젝트 생성</h2>
        <form onSubmit={createProject} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 400 }}>
          <label>
            User ID
            <input
              type="number"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              style={inputStyle}
              min={1}
            />
          </label>
          <label>
            프로젝트 제목
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 영한 번역 요청"
              style={inputStyle}
            />
          </label>
          <button type="submit" style={btnStyle("#2563eb")}>
            프로젝트 생성
          </button>
        </form>
      </section>

      <section style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>프로젝트 목록</h2>
          <button onClick={fetchProjects} style={btnStyle("#374151")} disabled={loadingProjects}>
            {loadingProjects ? "로딩중..." : "조회"}
          </button>
        </div>

        {projects.length === 0 ? (
          <p style={{ color: "#6b7280" }}>조회 버튼을 눌러주세요.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                {["ID", "제목", "Status", "생성일시"].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                  <td style={tdStyle}>{p.id}</td>
                  <td style={tdStyle}>{p.title}</td>
                  <td style={tdStyle}>{statusBadge(p.status)}</td>
                  <td style={tdStyle}>{new Date(p.createdAt).toLocaleString("ko-KR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>이벤트 로그</h2>
          <button onClick={fetchLogs} style={btnStyle("#374151")} disabled={loadingLogs}>
            {loadingLogs ? "로딩중..." : "조회"}
          </button>
        </div>

        {logs.length === 0 ? (
          <p style={{ color: "#6b7280" }}>조회 버튼을 눌러주세요.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: "#f3f4f6" }}>
                {["ID", "Entity", "Entity ID", "Action", "시간"].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                  <td style={tdStyle}>{log.id}</td>
                  <td style={tdStyle}>{log.entityType}</td>
                  <td style={tdStyle}>{log.entityId}</td>
                  <td style={tdStyle}>
                    <code style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>
                      {log.action}
                    </code>
                  </td>
                  <td style={tdStyle}>{new Date(log.createdAt).toLocaleString("ko-KR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 8px",
  marginTop: 4,
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontFamily: "monospace",
  fontSize: 14,
  boxSizing: "border-box",
};

const btnStyle = (bg: string): React.CSSProperties => ({
  background: bg,
  color: "#fff",
  border: "none",
  padding: "8px 16px",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 14,
});

const thStyle: React.CSSProperties = {
  padding: "8px 12px",
  textAlign: "left",
  fontWeight: 700,
  borderBottom: "2px solid #d1d5db",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  verticalAlign: "middle",
};

export default App;
