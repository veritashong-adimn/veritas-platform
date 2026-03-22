import { useState, useCallback, useEffect } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const api = (path: string) => `${BASE}${path}`;

type Role = "customer" | "translator" | "admin";
type User = { id: number; email: string; role: Role };
type Project = {
  id: number; userId: number; title: string;
  fileUrl: string | null; status: string; createdAt: string;
};
type Task = {
  id: number; projectId: number; translatorId: number;
  status: string; createdAt: string;
  projectTitle: string | null; projectStatus: string | null;
};
type PaymentPanel = { projectId: number; paymentId: number; amount: number } | null;

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

const STATUS_LABEL: Record<string, string> = {
  created: "접수됨", quoted: "견적 발송", approved: "견적 승인",
  paid: "결제 완료", matched: "번역사 배정", in_progress: "번역 중",
  completed: "완료", waiting: "대기", assigned: "배정됨",
  working: "작업 중", done: "완료",
};

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  created:     { background: "#f3f4f6", color: "#6b7280" },
  quoted:      { background: "#eff6ff", color: "#2563eb" },
  approved:    { background: "#f0fdf4", color: "#16a34a" },
  paid:        { background: "#ecfeff", color: "#0891b2" },
  matched:     { background: "#faf5ff", color: "#9333ea" },
  in_progress: { background: "#fffbeb", color: "#d97706" },
  completed:   { background: "#f0fdf4", color: "#059669" },
  waiting:     { background: "#f3f4f6", color: "#6b7280" },
  assigned:    { background: "#eff6ff", color: "#2563eb" },
  working:     { background: "#fffbeb", color: "#d97706" },
  done:        { background: "#f0fdf4", color: "#059669" },
  pending:     { background: "#fffbeb", color: "#d97706" },
  failed:      { background: "#fef2f2", color: "#dc2626" },
};

const ROLE_STYLE: Record<Role, React.CSSProperties> = {
  customer:   { background: "#eff6ff", color: "#2563eb" },
  translator: { background: "#faf5ff", color: "#7c3aed" },
  admin:      { background: "#fef2f2", color: "#dc2626" },
};

const ROLE_LABEL: Record<Role, string> = {
  customer: "고객", translator: "번역사", admin: "관리자",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? { background: "#f3f4f6", color: "#6b7280" };
  return (
    <span style={{
      ...style, padding: "3px 10px", borderRadius: 20,
      fontSize: 12, fontWeight: 600, display: "inline-block",
    }}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <span style={{
      ...ROLE_STYLE[role], padding: "3px 10px",
      borderRadius: 20, fontSize: 12, fontWeight: 600,
    }}>
      {ROLE_LABEL[role]}
    </span>
  );
}

function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  if (!msg) return null;
  const isErr = msg.startsWith("오류") || msg.startsWith("실패");
  return (
    <div style={{
      position: "fixed", top: 72, right: 24, zIndex: 100,
      padding: "12px 18px", borderRadius: 8, maxWidth: 360,
      background: isErr ? "#fef2f2" : "#f0fdf4",
      border: `1px solid ${isErr ? "#fca5a5" : "#86efac"}`,
      color: isErr ? "#dc2626" : "#15803d",
      boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
      display: "flex", alignItems: "flex-start", gap: 10, fontSize: 14,
    }}>
      <span style={{ flex: 1 }}>{msg}</span>
      <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "inherit", lineHeight: 1 }}>×</button>
    </div>
  );
}

function Navbar({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <nav style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 50,
      height: 56, background: "#fff",
      borderBottom: "1px solid #e5e7eb",
      display: "flex", alignItems: "center",
      padding: "0 24px", gap: 16,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
        <div style={{
          width: 28, height: 28, background: "#2563eb", borderRadius: 6,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontWeight: 800, fontSize: 13,
        }}>T</div>
        <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>통번역 플랫폼</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <RoleBadge role={user.role} />
        <span style={{ fontSize: 13, color: "#6b7280" }}>{user.email}</span>
        <button onClick={onLogout} style={{
          padding: "6px 14px", borderRadius: 6, border: "1px solid #e5e7eb",
          background: "#fff", color: "#374151", fontSize: 13,
          cursor: "pointer", fontWeight: 500,
        }}>로그아웃</button>
      </div>
    </nav>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb",
      padding: "20px 24px", ...style,
    }}>
      {children}
    </div>
  );
}

function PrimaryBtn({ children, onClick, disabled, style }: {
  children: React.ReactNode; onClick?: () => void;
  disabled?: boolean; style?: React.CSSProperties;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: disabled ? "#93c5fd" : "#2563eb", color: "#fff",
      border: "none", borderRadius: 8, padding: "9px 18px",
      fontSize: 14, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      transition: "background 0.15s", ...style,
    }}>{children}</button>
  );
}

function GhostBtn({ children, onClick, disabled, color = "#374151", style }: {
  children: React.ReactNode; onClick?: () => void;
  disabled?: boolean; color?: string; style?: React.CSSProperties;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: "none", color: disabled ? "#9ca3af" : color,
      border: `1px solid ${disabled ? "#e5e7eb" : color === "#374151" ? "#d1d5db" : color}`,
      borderRadius: 8, padding: "7px 16px", fontSize: 13,
      fontWeight: 500, cursor: disabled ? "not-allowed" : "pointer", ...style,
    }}>{children}</button>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600,
  color: "#374151", marginBottom: 6,
};

function AuthPage({ onAuth }: { onAuth: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"customer" | "translator">("customer");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { setMsg("이메일과 비밀번호를 입력해주세요."); return; }
    setLoading(true); setMsg("");
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login" ? { email, password } : { email, password, role };
      const res = await fetch(api(endpoint), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? "오류가 발생했습니다."); return; }
      onAuth(data.token, data.user);
    } catch { setMsg("서버에 연결할 수 없습니다."); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#f9fafb",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif",
    }}>
      <div style={{ width: "100%", maxWidth: 420, padding: "0 16px" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 48, height: 48, background: "#2563eb", borderRadius: 12,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 12px", color: "#fff", fontWeight: 800, fontSize: 22,
          }}>T</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#111827" }}>통번역 플랫폼</h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "#6b7280" }}>전문 번역 서비스</p>
        </div>

        <Card>
          <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: 24 }}>
            {(["login", "register"] as const).map((m) => (
              <button key={m} onClick={() => { setMode(m); setMsg(""); }} style={{
                flex: 1, padding: "10px 0", background: "none", border: "none",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
                color: mode === m ? "#2563eb" : "#6b7280",
                borderBottom: mode === m ? "2px solid #2563eb" : "2px solid transparent",
                marginBottom: -1, transition: "color 0.15s",
              }}>
                {m === "login" ? "로그인" : "회원가입"}
              </button>
            ))}
          </div>

          {msg && (
            <div style={{
              padding: "10px 14px", borderRadius: 8, marginBottom: 16,
              background: "#fef2f2", border: "1px solid #fca5a5",
              color: "#dc2626", fontSize: 13,
            }}>{msg}</div>
          )}

          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <label style={labelStyle}>이메일</label>
              <input style={inputStyle} type="email" value={email}
                onChange={e => setEmail(e.target.value)} placeholder="example@email.com" />
            </div>
            <div>
              <label style={labelStyle}>비밀번호</label>
              <input style={inputStyle} type="password" value={password}
                onChange={e => setPassword(e.target.value)} placeholder="최소 6자" />
            </div>
            {mode === "register" && (
              <div>
                <label style={labelStyle}>역할</label>
                <select style={{ ...inputStyle, cursor: "pointer" }}
                  value={role} onChange={e => setRole(e.target.value as typeof role)}>
                  <option value="customer">고객 — 번역 의뢰</option>
                  <option value="translator">번역사 — 번역 작업</option>
                </select>
              </div>
            )}
            <PrimaryBtn style={{ width: "100%", padding: "11px", marginTop: 4 }} disabled={loading}>
              {loading ? "처리중..." : mode === "login" ? "로그인" : "회원가입"}
            </PrimaryBtn>
          </form>
        </Card>
      </div>
    </div>
  );
}

function ProjectCard({
  project, token,
  onPaymentRequest,
}: {
  project: Project;
  token: string;
  onPaymentRequest: (projectId: number) => void;
}) {
  const isApproved = project.status === "approved";

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>
            #{project.id} · {new Date(project.createdAt).toLocaleDateString("ko-KR")}
          </p>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
            {project.title}
          </h3>
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {project.fileUrl && (
          <a href={project.fileUrl} target="_blank" rel="noreferrer" style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "6px 12px", borderRadius: 8,
            border: "1px solid #d1d5db", background: "#f9fafb",
            color: "#374151", fontSize: 13, textDecoration: "none", fontWeight: 500,
          }}>
            <span>📎</span> 첨부파일 다운로드
          </a>
        )}
        {isApproved && (
          <button onClick={() => onPaymentRequest(project.id)} style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "7px 14px", borderRadius: 8,
            border: "none", background: "#0891b2",
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>
            💳 결제하기
          </button>
        )}
      </div>
    </Card>
  );
}

function PaymentModal({
  panel, onConfirm, onClose, acting,
}: {
  panel: NonNullable<PaymentPanel>;
  onConfirm: (success: boolean) => void;
  onClose: () => void;
  acting: boolean;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <Card style={{ width: "100%", maxWidth: 420, margin: "0 16px" }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 700, color: "#111827" }}>결제</h2>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6b7280" }}>
          프로젝트 #{panel.projectId}
        </p>
        <div style={{
          background: "#f9fafb", borderRadius: 10, padding: "20px",
          textAlign: "center", marginBottom: 20,
        }}>
          <p style={{ margin: "0 0 4px", fontSize: 13, color: "#6b7280" }}>결제 금액</p>
          <p style={{ margin: 0, fontSize: 28, fontWeight: 800, color: "#0891b2" }}>
            {panel.amount.toLocaleString()}
            <span style={{ fontSize: 16, marginLeft: 4 }}>원</span>
          </p>
        </div>
        <div style={{ background: "#fffbeb", borderRadius: 8, padding: "10px 14px", marginBottom: 20 }}>
          <p style={{ margin: 0, fontSize: 12, color: "#92400e" }}>
            테스트 환경 — 아래 버튼으로 결제 성공/실패를 시뮬레이션합니다.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => onConfirm(true)} disabled={acting} style={{
            flex: 1, padding: "11px", borderRadius: 8, border: "none",
            background: acting ? "#86efac" : "#16a34a", color: "#fff",
            fontSize: 14, fontWeight: 700, cursor: acting ? "not-allowed" : "pointer",
          }}>
            {acting ? "처리중..." : "결제 완료"}
          </button>
          <GhostBtn onClick={() => onConfirm(false)} disabled={acting} color="#dc2626">
            결제 실패
          </GhostBtn>
          <GhostBtn onClick={onClose} disabled={acting}>취소</GhostBtn>
        </div>
      </Card>
    </div>
  );
}

function TaskCard({
  task, token, onAction,
}: {
  task: Task;
  token: string;
  onAction: (taskId: number, action: "start" | "complete") => void;
}) {
  const canStart = task.status === "waiting" || task.status === "assigned";
  const canComplete = task.status === "working";
  const isDone = task.status === "done";

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>
            작업 #{task.id} · 프로젝트 #{task.projectId}
          </p>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
            {task.projectTitle ?? `프로젝트 #${task.projectId}`}
          </h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <StatusBadge status={task.status} />
          {task.projectStatus && task.projectStatus !== task.status && (
            <StatusBadge status={task.projectStatus} />
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {canStart && (
          <PrimaryBtn onClick={() => onAction(task.id, "start")} style={{ background: "#d97706" }}>
            작업 시작
          </PrimaryBtn>
        )}
        {canComplete && (
          <PrimaryBtn onClick={() => onAction(task.id, "complete")} style={{ background: "#059669" }}>
            작업 완료
          </PrimaryBtn>
        )}
        {isDone && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            color: "#059669", fontWeight: 600, fontSize: 14,
          }}>
            <span style={{ fontSize: 18 }}>✓</span> 완료됨
          </div>
        )}
      </div>
    </Card>
  );
}

function CustomerDashboard({ user, token }: { user: User; token: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [toast, setToast] = useState("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paymentPanel, setPaymentPanel] = useState<PaymentPanel>(null);
  const [payActing, setPayActing] = useState(false);

  const authJson = { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/projects?userId=${user.id}`));
      const data = await res.json();
      setProjects(Array.isArray(data) ? data.sort((a: Project, b: Project) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) : []);
    } catch { setToast("오류: 프로젝트 목록을 불러올 수 없습니다."); }
    finally { setLoading(false); }
  }, [user.id]);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { setToast("오류: 제목을 입력해주세요."); return; }
    setCreating(true);
    let fileUrl: string | undefined;

    if (file) {
      const formData = new FormData();
      formData.append("file", file);
      try {
        const upRes = await fetch(api("/api/upload"), {
          method: "POST", headers: { "Authorization": `Bearer ${token}` }, body: formData,
        });
        const upData = await upRes.json();
        if (!upRes.ok) { setToast(`오류: 파일 업로드 실패 — ${upData.error}`); setCreating(false); return; }
        fileUrl = upData.fileUrl as string;
      } catch { setToast("오류: 파일 업로드 실패"); setCreating(false); return; }
    }

    try {
      const res = await fetch(api("/api/projects"), {
        method: "POST", headers: authJson,
        body: JSON.stringify({ title, ...(fileUrl ? { fileUrl } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("프로젝트가 등록되었습니다.");
      setTitle(""); setFile(null);
      await fetchProjects();
    } catch { setToast("오류: 프로젝트 생성 실패"); }
    finally { setCreating(false); }
  };

  const requestPayment = async (projectId: number) => {
    try {
      const res = await fetch(api("/api/payments/request"), {
        method: "POST", headers: authJson, body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setPaymentPanel({ projectId, paymentId: data.paymentId, amount: data.amount });
    } catch { setToast("오류: 결제 요청 실패"); }
  };

  const confirmPayment = async (success: boolean) => {
    if (!paymentPanel) return;
    setPayActing(true);
    try {
      const res = await fetch(api("/api/payments/confirm"), {
        method: "POST", headers: authJson,
        body: JSON.stringify({ paymentId: paymentPanel.paymentId, success }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(success
        ? `결제가 완료되었습니다. (${paymentPanel.amount.toLocaleString()}원)`
        : "결제가 실패 처리되었습니다.");
      setPaymentPanel(null);
      await fetchProjects();
    } catch { setToast("오류: 결제 처리 실패"); }
    finally { setPayActing(false); }
  };

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />
      {paymentPanel && (
        <PaymentModal panel={paymentPanel} onConfirm={confirmPayment}
          onClose={() => setPaymentPanel(null)} acting={payActing} />
      )}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 300px", minWidth: 280 }}>
          <Card>
            <h2 style={{ margin: "0 0 18px", fontSize: 16, fontWeight: 700, color: "#111827" }}>
              새 번역 의뢰
            </h2>
            <form onSubmit={createProject} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle}>프로젝트 제목 *</label>
                <input style={inputStyle} value={title}
                  onChange={e => setTitle(e.target.value)} placeholder="예: 영한 번역 요청" />
              </div>
              <div>
                <label style={labelStyle}>
                  번역 파일 첨부{" "}
                  <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>
                    선택 · 최대 10MB
                  </span>
                </label>
                <input type="file" style={{ ...inputStyle, padding: "7px 10px", cursor: "pointer" }}
                  accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png,.gif,.zip"
                  onChange={e => setFile(e.target.files?.[0] ?? null)} />
                {file && (
                  <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>
                    {file.name} ({(file.size / 1024).toFixed(0)} KB)
                  </p>
                )}
              </div>
              <PrimaryBtn disabled={creating} style={{ alignSelf: "flex-start" }}>
                {creating ? "등록 중..." : "의뢰 등록"}
              </PrimaryBtn>
            </form>
          </Card>
        </div>

        <div style={{ flex: "2 1 420px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
              내 프로젝트 <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 14 }}>({projects.length})</span>
            </h2>
            <GhostBtn onClick={fetchProjects} disabled={loading}>
              {loading ? "로딩 중..." : "새로고침"}
            </GhostBtn>
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 14 }}>
              불러오는 중...
            </div>
          ) : projects.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "40px 24px", color: "#9ca3af" }}>
              <p style={{ margin: 0, fontSize: 32 }}>📂</p>
              <p style={{ margin: "10px 0 0", fontSize: 14 }}>아직 등록된 프로젝트가 없습니다.</p>
            </Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {projects.map(p => (
                <ProjectCard key={p.id} project={p} token={token}
                  onPaymentRequest={requestPayment} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function TranslatorDashboard({ user, token }: { user: User; token: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<number | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/tasks?translatorId=${user.id}`));
      const data = await res.json();
      setTasks(Array.isArray(data) ? data.sort((a: Task, b: Task) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) : []);
    } catch { setToast("오류: 작업 목록을 불러올 수 없습니다."); }
    finally { setLoading(false); }
  }, [user.id]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const doAction = async (taskId: number, action: "start" | "complete") => {
    setActing(taskId);
    try {
      const res = await fetch(api(`/api/tasks/${taskId}/${action}`), {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(action === "start" ? "작업을 시작했습니다." : "작업을 완료했습니다.");
      await fetchTasks();
    } catch { setToast("오류: 상태 변경 실패"); }
    finally { setActing(null); }
  };

  const active = tasks.filter(t => t.status !== "done");
  const completed = tasks.filter(t => t.status === "done");

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
          배정된 작업 <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 14 }}>({tasks.length})</span>
        </h2>
        <GhostBtn onClick={fetchTasks} disabled={loading}>
          {loading ? "로딩 중..." : "새로고침"}
        </GhostBtn>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 14 }}>
          불러오는 중...
        </div>
      ) : tasks.length === 0 ? (
        <Card style={{ textAlign: "center", padding: "40px 24px", color: "#9ca3af" }}>
          <p style={{ margin: 0, fontSize: 32 }}>📋</p>
          <p style={{ margin: "10px 0 0", fontSize: 14 }}>배정된 작업이 없습니다.</p>
        </Card>
      ) : (
        <>
          {active.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                진행 중 ({active.length})
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {active.map(t => (
                  <TaskCard key={t.id} task={t} token={token}
                    onAction={(id, act) => !acting && doAction(id, act)} />
                ))}
              </div>
            </div>
          )}
          {completed.length > 0 && (
            <div>
              <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                완료 ({completed.length})
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {completed.map(t => (
                  <TaskCard key={t.id} task={t} token={token}
                    onAction={(id, act) => !acting && doAction(id, act)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
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
    saveSession(t, u); setToken(t); setUser(u);
  };

  const handleLogout = () => {
    clearSession(); setToken(null); setUser(null);
  };

  if (!token || !user) return <AuthPage onAuth={handleAuth} />;

  return (
    <div style={{
      minHeight: "100vh", background: "#f9fafb",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif",
    }}>
      <Navbar user={user} onLogout={handleLogout} />

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "80px 24px 48px" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#111827" }}>
            {user.role === "customer" ? "번역 의뢰 관리" : "번역 작업 관리"}
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: "#6b7280" }}>
            {user.role === "customer"
              ? "번역 프로젝트를 등록하고 진행 상황을 확인하세요."
              : "배정된 번역 작업을 확인하고 진행해주세요."}
          </p>
        </div>

        {user.role === "customer" && <CustomerDashboard user={user} token={token} />}
        {user.role === "translator" && <TranslatorDashboard user={user} token={token} />}
        {user.role === "admin" && (
          <Card style={{ textAlign: "center", padding: "48px 24px", color: "#6b7280" }}>
            <p style={{ margin: 0, fontSize: 32 }}>🔧</p>
            <p style={{ margin: "12px 0 0", fontSize: 15, fontWeight: 600, color: "#374151" }}>관리자 대시보드</p>
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>관리자 화면은 추후 구현 예정입니다.</p>
          </Card>
        )}
      </main>
    </div>
  );
}
