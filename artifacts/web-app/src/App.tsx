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
  completed: "완료", cancelled: "취소됨", waiting: "대기", assigned: "배정됨",
  working: "작업 중", done: "완료",
  pending: "대기", ready: "정산 가능",
};

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  created:     { background: "#f3f4f6", color: "#6b7280" },
  quoted:      { background: "#eff6ff", color: "#2563eb" },
  approved:    { background: "#f0fdf4", color: "#16a34a" },
  paid:        { background: "#ecfeff", color: "#0891b2" },
  matched:     { background: "#faf5ff", color: "#9333ea" },
  in_progress: { background: "#fffbeb", color: "#d97706" },
  completed:   { background: "#f0fdf4", color: "#059669" },
  cancelled:   { background: "#fef2f2", color: "#dc2626" },
  waiting:     { background: "#f3f4f6", color: "#6b7280" },
  assigned:    { background: "#eff6ff", color: "#2563eb" },
  working:     { background: "#fffbeb", color: "#d97706" },
  done:        { background: "#f0fdf4", color: "#059669" },
  pending:     { background: "#f3f4f6", color: "#6b7280" },
  ready:       { background: "#fffbeb", color: "#d97706" },
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

type NavPage = "dashboard" | "admin";

function ChangePasswordModal({ token, onClose, onSuccess }: {
  token: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!current || !next || !confirm) { setErr("모든 항목을 입력해주세요."); return; }
    if (next !== confirm) { setErr("새 비밀번호와 확인이 일치하지 않습니다."); return; }
    if (next.length < 6) { setErr("새 비밀번호는 최소 6자 이상이어야 합니다."); return; }
    setLoading(true);
    try {
      const res = await fetch(api("/api/auth/change-password"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? "비밀번호 변경 실패"); return; }
      onSuccess();
    } catch { setErr("서버 연결 실패"); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <Card style={{ width: "100%", maxWidth: 400, margin: "0 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#111827" }}>비밀번호 변경</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 }}>×</button>
        </div>

        {err && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, marginBottom: 16,
            background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", fontSize: 13,
          }}>{err}</div>
        )}

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>현재 비밀번호</label>
            <input type="password" style={inputStyle} value={current}
              onChange={e => setCurrent(e.target.value)} placeholder="현재 비밀번호" autoComplete="current-password" />
          </div>
          <div>
            <label style={labelStyle}>새 비밀번호</label>
            <input type="password" style={inputStyle} value={next}
              onChange={e => setNext(e.target.value)} placeholder="최소 6자" autoComplete="new-password" />
          </div>
          <div>
            <label style={labelStyle}>새 비밀번호 확인</label>
            <input type="password" style={inputStyle} value={confirm}
              onChange={e => setConfirm(e.target.value)} placeholder="동일하게 입력" autoComplete="new-password" />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <PrimaryBtn disabled={loading} style={{ flex: 1 }}>
              {loading ? "변경 중..." : "비밀번호 변경"}
            </PrimaryBtn>
            <GhostBtn onClick={onClose} disabled={loading}>취소</GhostBtn>
          </div>
        </form>
        <p style={{ margin: "14px 0 0", fontSize: 12, color: "#9ca3af", textAlign: "center" }}>
          변경 완료 후 자동으로 로그아웃됩니다.
        </p>
      </Card>
    </div>
  );
}

function ChangeEmailModal({ token, currentEmail, onClose, onSuccess }: {
  token: string;
  currentEmail: string;
  onClose: () => void;
  onSuccess: (newEmail: string) => void;
}) {
  const [newEmail, setNewEmail] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) { setErr("새 이메일을 입력해주세요."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) { setErr("올바른 이메일 형식을 입력해주세요."); return; }
    if (trimmed === currentEmail.toLowerCase()) { setErr("현재 이메일과 동일합니다."); return; }
    setLoading(true);
    try {
      const res = await fetch(api("/api/admin/update-email"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newEmail: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? "이메일 변경 실패"); return; }
      onSuccess(data.email as string);
    } catch { setErr("서버 연결 실패"); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
    }}>
      <Card style={{ width: "100%", maxWidth: 420, margin: "0 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#111827" }}>관리자 이메일 변경</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 }}>×</button>
        </div>

        <div style={{
          padding: "10px 14px", borderRadius: 8, marginBottom: 16,
          background: "#f8fafc", border: "1px solid #e2e8f0", color: "#64748b", fontSize: 13,
        }}>
          현재 이메일: <strong style={{ color: "#374151" }}>{currentEmail}</strong>
        </div>

        {err && (
          <div style={{
            padding: "10px 14px", borderRadius: 8, marginBottom: 16,
            background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", fontSize: 13,
          }}>{err}</div>
        )}

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>새 이메일</label>
            <input type="email" style={inputStyle} value={newEmail}
              onChange={e => setNewEmail(e.target.value)} placeholder="example@domain.com"
              autoComplete="email" autoFocus />
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <PrimaryBtn disabled={loading} style={{ flex: 1 }}>
              {loading ? "변경 중..." : "이메일 변경"}
            </PrimaryBtn>
            <GhostBtn onClick={onClose} disabled={loading}>취소</GhostBtn>
          </div>
        </form>
        <p style={{ margin: "14px 0 0", fontSize: 12, color: "#9ca3af", textAlign: "center" }}>
          변경 후 다음 로그인부터 새 이메일로 사용됩니다.
        </p>
      </Card>
    </div>
  );
}

function Navbar({
  user, page, onPageChange, onLogout, token, onEmailChange,
}: {
  user: User;
  page: NavPage;
  onPageChange: (p: NavPage) => void;
  onLogout: () => void;
  token: string;
  onEmailChange?: (newEmail: string) => void;
}) {
  const [showPwModal, setShowPwModal] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState("");

  const handlePwSuccess = () => {
    setShowPwModal(false);
    setPwSuccess(true);
    setTimeout(() => onLogout(), 1800);
  };

  const handleEmailSuccess = (newEmail: string) => {
    setShowEmailModal(false);
    setEmailSuccess(newEmail);
    onEmailChange?.(newEmail);
    setTimeout(() => setEmailSuccess(""), 3000);
  };

  const navLink = (label: string, target: NavPage, active: boolean) => (
    <button onClick={() => onPageChange(target)} style={{
      background: "none", border: "none", cursor: "pointer",
      padding: "0 12px", height: 56, fontSize: 14, fontWeight: 600,
      color: active ? "#2563eb" : "#6b7280",
      borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
      transition: "color 0.15s, border-color 0.15s",
    }}>{label}</button>
  );

  return (
    <>
      {showPwModal && (
        <ChangePasswordModal
          token={token}
          onClose={() => setShowPwModal(false)}
          onSuccess={handlePwSuccess}
        />
      )}
      {showEmailModal && (
        <ChangeEmailModal
          token={token}
          currentEmail={user.email}
          onClose={() => setShowEmailModal(false)}
          onSuccess={handleEmailSuccess}
        />
      )}

      {pwSuccess && (
        <div style={{
          position: "fixed", top: 72, right: 24, zIndex: 300,
          padding: "12px 18px", borderRadius: 8, maxWidth: 320,
          background: "#f0fdf4", border: "1px solid #86efac",
          color: "#15803d", boxShadow: "0 4px 12px rgba(0,0,0,0.1)", fontSize: 14,
        }}>
          ✓ 비밀번호가 변경되었습니다. 잠시 후 로그아웃됩니다.
        </div>
      )}
      {emailSuccess && (
        <div style={{
          position: "fixed", top: 72, right: 24, zIndex: 300,
          padding: "12px 18px", borderRadius: 8, maxWidth: 320,
          background: "#eff6ff", border: "1px solid #93c5fd",
          color: "#1d4ed8", boxShadow: "0 4px 12px rgba(0,0,0,0.1)", fontSize: 14,
        }}>
          ✓ 이메일이 <strong>{emailSuccess}</strong>으로 변경되었습니다.
        </div>
      )}

      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 50,
        height: 56, background: "#fff",
        borderBottom: "1px solid #e5e7eb",
        display: "flex", alignItems: "center",
        padding: "0 24px", gap: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 24 }}>
          <div style={{
            width: 28, height: 28, background: "#2563eb", borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 800, fontSize: 13,
          }}>T</div>
          <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>통번역 플랫폼</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", flex: 1 }}>
          {user.role === "customer" && navLink("내 프로젝트", "dashboard", page === "dashboard")}
          {user.role === "translator" && navLink("내 작업", "dashboard", page === "dashboard")}
          {user.role === "admin" && navLink("관리자 대시보드", "admin", page === "admin")}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {user.role === "admin" && (
            <div style={{
              background: "#fef2f2", border: "1px solid #fca5a5",
              borderRadius: 8, padding: "3px 9px",
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", letterSpacing: "0.05em" }}>ADMIN</span>
            </div>
          )}
          <RoleBadge role={user.role} />
          <span style={{ fontSize: 13, color: "#6b7280", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.email}
          </span>
          {user.role === "admin" && (
            <button onClick={() => setShowEmailModal(true)} title="이메일 변경" style={{
              background: "none", border: "1px solid #e5e7eb", borderRadius: 6,
              width: 32, height: 32, cursor: "pointer", fontSize: 14,
              display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280",
            }}>✉</button>
          )}
          <button onClick={() => setShowPwModal(true)} title="비밀번호 변경" style={{
            background: "none", border: "1px solid #e5e7eb", borderRadius: 6,
            width: 32, height: 32, cursor: "pointer", fontSize: 15,
            display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280",
          }}>⚙</button>
          <button onClick={onLogout} style={{
            padding: "6px 14px", borderRadius: 6, border: "1px solid #e5e7eb",
            background: "#fff", color: "#374151", fontSize: 13,
            cursor: "pointer", fontWeight: 500,
          }}>로그아웃</button>
        </div>
      </nav>
    </>
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

type AdminSettlement = {
  id: number; projectId: number; translatorId: number; paymentId: number | null;
  totalAmount: string; translatorAmount: string; platformFee: string;
  status: string; createdAt: string;
  projectTitle: string | null; translatorEmail: string | null;
};
type MySettlement = {
  id: number; projectId: number;
  totalAmount: string; translatorAmount: string; platformFee: string;
  status: string; createdAt: string; projectTitle: string | null;
};

const ALL_SETTLEMENT_STATUSES = ["pending", "ready", "paid"] as const;

type AdminProject = {
  id: number; title: string; status: string; fileUrl: string | null;
  createdAt: string; customerEmail: string | null; customerId: number | null;
};
type AdminPayment = {
  id: number; projectId: number; amount: number; status: string;
  createdAt: string; projectTitle: string | null; projectStatus: string | null;
};
type AdminTask = {
  id: number; projectId: number; translatorId: number; status: string;
  createdAt: string; projectTitle: string | null; projectStatus: string | null;
  translatorEmail: string | null;
};
type LogEntry = { id: number; entityType: string; entityId: number; action: string; createdAt: string };
type NoteEntry = { id: number; content: string; createdAt: string; adminEmail: string | null };
type AdminUser = { id: number; email: string; role: Role; isActive: boolean; createdAt: string };
type ProjectDetail = AdminProject & {
  quotes: Array<{ id: number; amount: number; status: string; createdAt: string }>;
  payments: Array<{ id: number; amount: number; status: string; createdAt: string }>;
  tasks: Array<{ id: number; translatorId: number; status: string; createdAt: string; translatorEmail: string | null }>;
  settlements: Array<{ id: number; totalAmount: number; translatorAmount: number; platformFee: number; status: string; createdAt: string }>;
  logs: LogEntry[];
};

const ALL_PROJECT_STATUSES = ["created","quoted","approved","paid","matched","in_progress","completed","cancelled"] as const;
const ALL_PAYMENT_STATUSES = ["pending","paid","failed"] as const;

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid",
      background: active ? "#2563eb" : "#fff",
      color: active ? "#fff" : "#6b7280",
      borderColor: active ? "#2563eb" : "#d1d5db",
      transition: "all 0.12s",
    }}>{label}</button>
  );
}

function LogModal({ projectId, token, onClose }: { projectId: number; token: string; onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/logs/${projectId}`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? "로그 조회 실패"); return; }
        setLogs(Array.isArray(data) ? data : []);
      } catch { setErr("서버 연결 실패"); }
      finally { setLoading(false); }
    })();
  }, [projectId, token]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300,
    }}>
      <Card style={{ width: "100%", maxWidth: 520, margin: "0 16px", maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
            프로젝트 #{projectId} 이벤트 로그
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {loading ? (
            <p style={{ textAlign: "center", color: "#9ca3af", padding: "24px 0" }}>로딩 중...</p>
          ) : err ? (
            <p style={{ color: "#dc2626", fontSize: 13 }}>{err}</p>
          ) : logs.length === 0 ? (
            <p style={{ textAlign: "center", color: "#9ca3af", padding: "24px 0", fontSize: 14 }}>로그가 없습니다.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {logs.map((log) => (
                <div key={log.id} style={{
                  display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 12px",
                  background: "#f9fafb", borderRadius: 8,
                }}>
                  <span style={{ fontSize: 11, color: "#9ca3af", minWidth: 130, marginTop: 1 }}>
                    {new Date(log.createdAt).toLocaleString("ko-KR")}
                  </span>
                  <div style={{ flex: 1 }}>
                    <span style={{
                      background: "#eff6ff", color: "#2563eb",
                      borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600, marginRight: 8,
                    }}>{log.entityType}</span>
                    <span style={{ fontSize: 13, color: "#374151" }}>{log.action}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function ProjectDetailModal({ projectId, token, onClose, onRefresh, onToast }: {
  projectId: number; token: string; onClose: () => void;
  onRefresh: () => void; onToast: (msg: string) => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [statusTarget, setStatusTarget] = useState("");
  const [changingStatus, setChangingStatus] = useState(false);
  const [rematching, setRematching] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const authH = { Authorization: `Bearer ${token}` };

  const loadDetail = async () => {
    try {
      const [dRes, nRes] = await Promise.all([
        fetch(api(`/api/admin/projects/${projectId}`), { headers: authH }),
        fetch(api(`/api/admin/projects/${projectId}/notes`), { headers: authH }),
      ]);
      const [dData, nData] = await Promise.all([dRes.json(), nRes.json()]);
      if (dRes.ok) { setDetail(dData); setStatusTarget(dData.status); }
      else { setErr(dData.error ?? "조회 실패"); }
      if (nRes.ok) setNotes(Array.isArray(nData) ? nData : []);
    } catch { setErr("서버 연결 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadDetail(); }, [projectId]);

  const handleStatusChange = async () => {
    if (!statusTarget || statusTarget === detail?.status) return;
    setChangingStatus(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/status`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusTarget }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`상태가 "${STATUS_LABEL[statusTarget] ?? statusTarget}"로 변경되었습니다.`);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 상태 변경 실패"); }
    finally { setChangingStatus(false); }
  };

  const handleRematch = async () => {
    setRematching(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/rematch`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`재매칭 완료 → ${data.translatorEmail ?? "번역사 배정됨"}`);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 재매칭 실패"); }
    finally { setRematching(false); }
  };

  const handleCancel = async () => {
    if (!confirm("이 프로젝트를 취소하시겠습니까?")) return;
    setCancelling(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/cancel`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("프로젝트가 취소되었습니다.");
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 취소 실패"); }
    finally { setCancelling(false); }
  };

  const handleAddNote = async () => {
    if (!noteInput.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/notes`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ content: noteInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setNotes(prev => [...prev, data]);
      setNoteInput("");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const sectionHd: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
  };
  const dl: React.CSSProperties = { display: "flex", gap: 4, fontSize: 13, marginBottom: 6 };
  const dt: React.CSSProperties = { color: "#9ca3af", minWidth: 80 };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 300, overflowY: "auto", padding: "20px 16px",
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb",
        width: "100%", maxWidth: 720, padding: "24px 28px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>
            프로젝트 #{projectId} 상세
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
        ) : err ? (
          <p style={{ color: "#dc2626", padding: "16px 0" }}>{err}</p>
        ) : detail && (
          <>
            {/* 기본 정보 */}
            <p style={sectionHd}>기본 정보</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
              <div style={dl}><span style={dt}>제목</span><strong style={{ color: "#111827" }}>{detail.title}</strong></div>
              <div style={dl}><span style={dt}>고객</span><span style={{ color: "#374151" }}>{detail.customerEmail ?? "-"}</span></div>
              <div style={dl}><span style={dt}>상태</span><StatusBadge status={detail.status} /></div>
              <div style={dl}><span style={dt}>등록일</span><span style={{ color: "#374151" }}>{new Date(detail.createdAt).toLocaleString("ko-KR")}</span></div>
              {detail.fileUrl && (
                <div style={dl}>
                  <span style={dt}>첨부파일</span>
                  <a href={detail.fileUrl} target="_blank" rel="noreferrer" style={{ color: "#2563eb", fontSize: 13 }}>📎 다운로드</a>
                </div>
              )}
            </div>

            {/* 액션 버튼 */}
            <p style={sectionHd}>관리 액션</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <select value={statusTarget} onChange={e => setStatusTarget(e.target.value)}
                style={{ ...inputStyle, width: "auto", padding: "7px 10px", fontSize: 13 }}>
                {ALL_PROJECT_STATUSES.map(s => (
                  <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                ))}
              </select>
              <GhostBtn onClick={handleStatusChange} disabled={changingStatus || statusTarget === detail.status} color="#2563eb">
                {changingStatus ? "변경 중..." : "상태 변경"}
              </GhostBtn>
              <GhostBtn onClick={handleRematch} disabled={rematching} color="#7c3aed">
                {rematching ? "재매칭 중..." : "번역사 재매칭"}
              </GhostBtn>
              {detail.status !== "cancelled" && (
                <GhostBtn onClick={handleCancel} disabled={cancelling} color="#dc2626">
                  {cancelling ? "취소 중..." : "프로젝트 취소"}
                </GhostBtn>
              )}
            </div>

            {/* 견적 */}
            {detail.quotes.length > 0 && (
              <>
                <p style={sectionHd}>견적 ({detail.quotes.length})</p>
                {detail.quotes.map(q => (
                  <div key={q.id} style={{ display: "flex", gap: 16, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 13 }}>
                    <span style={{ color: "#9ca3af" }}>#{q.id}</span>
                    <span style={{ fontWeight: 700, color: "#0891b2" }}>{Number(q.amount).toLocaleString()}원</span>
                    <StatusBadge status={q.status} />
                    <span style={{ color: "#9ca3af", marginLeft: "auto" }}>{new Date(q.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </>
            )}

            {/* 결제 */}
            {detail.payments.length > 0 && (
              <>
                <p style={sectionHd}>결제 ({detail.payments.length})</p>
                {detail.payments.map(pm => (
                  <div key={pm.id} style={{ display: "flex", gap: 16, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 13 }}>
                    <span style={{ color: "#9ca3af" }}>#{pm.id}</span>
                    <span style={{ fontWeight: 700, color: "#0891b2" }}>{Number(pm.amount).toLocaleString()}원</span>
                    <StatusBadge status={pm.status} />
                    <span style={{ color: "#9ca3af", marginLeft: "auto" }}>{new Date(pm.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </>
            )}

            {/* 작업 */}
            {detail.tasks.length > 0 && (
              <>
                <p style={sectionHd}>배정된 번역사 ({detail.tasks.length})</p>
                {detail.tasks.map(t => (
                  <div key={t.id} style={{ display: "flex", gap: 16, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 13, flexWrap: "wrap" }}>
                    <span style={{ color: "#9ca3af" }}>작업#{t.id}</span>
                    <span style={{ color: "#374151" }}>{t.translatorEmail ?? `번역사 #${t.translatorId}`}</span>
                    <StatusBadge status={t.status} />
                    <span style={{ color: "#9ca3af", marginLeft: "auto" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </>
            )}

            {/* 정산 */}
            {detail.settlements.length > 0 && (
              <>
                <p style={sectionHd}>정산 ({detail.settlements.length})</p>
                {detail.settlements.map(s => (
                  <div key={s.id} style={{ display: "flex", gap: 16, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 13, flexWrap: "wrap" }}>
                    <span style={{ color: "#9ca3af" }}>#{s.id}</span>
                    <span style={{ color: "#0891b2", fontWeight: 600 }}>총 {Number(s.totalAmount).toLocaleString()}원</span>
                    <span style={{ color: "#059669", fontWeight: 600 }}>번역사 {Number(s.translatorAmount).toLocaleString()}원</span>
                    <StatusBadge status={s.status} />
                  </div>
                ))}
              </>
            )}

            {/* 이벤트 로그 */}
            {detail.logs.length > 0 && (
              <>
                <p style={sectionHd}>이벤트 로그 ({detail.logs.length})</p>
                <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                  {detail.logs.map(log => (
                    <div key={log.id} style={{ display: "flex", gap: 12, padding: "7px 10px", background: "#f9fafb", borderRadius: 6, fontSize: 12 }}>
                      <span style={{ color: "#9ca3af", minWidth: 120 }}>{new Date(log.createdAt).toLocaleString("ko-KR")}</span>
                      <span style={{ color: "#374151" }}>{log.action}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* 관리자 메모 */}
            <p style={sectionHd}>관리자 메모 ({notes.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input
                value={noteInput} onChange={e => setNoteInput(e.target.value)}
                placeholder="메모 내용 입력..."
                style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "8px 10px" }}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleAddNote()}
              />
              <PrimaryBtn onClick={handleAddNote} disabled={addingNote || !noteInput.trim()} style={{ padding: "8px 16px", fontSize: 13 }}>
                {addingNote ? "추가 중..." : "추가"}
              </PrimaryBtn>
            </div>
            {notes.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "12px 0" }}>메모가 없습니다.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
                {notes.map(n => (
                  <div key={n.id} style={{ padding: "10px 12px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "#92400e", fontWeight: 600 }}>{n.adminEmail ?? "관리자"}</span>
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(n.createdAt).toLocaleString("ko-KR")}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{n.content}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AdminDashboard({ user, token }: { user: User; token: string }) {
  const [adminTab, setAdminTab] = useState<"projects"|"payments"|"tasks"|"settlements"|"users">("projects");
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [settlements, setSettlements] = useState<AdminSettlement[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);

  // project filters
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [projectSearch, setProjectSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // other filters
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  const [settlementFilter, setSettlementFilter] = useState<string>("all");

  // user management
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<string>("all");
  const [roleChanging, setRoleChanging] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);

  // modals
  const [detailModal, setDetailModal] = useState<number | null>(null);
  const [paying, setPaying] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (projectSearch.trim()) params.set("search", projectSearch.trim());
      if (projectFilter !== "all") params.set("status", projectFilter);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const pUrl = `/api/admin/projects${params.toString() ? "?" + params.toString() : ""}`;

      const [pRes, pmRes, tRes, sRes] = await Promise.all([
        fetch(api(pUrl), { headers: authHeaders }),
        fetch(api("/api/admin/payments"), { headers: authHeaders }),
        fetch(api("/api/admin/tasks"), { headers: authHeaders }),
        fetch(api("/api/admin/settlements"), { headers: authHeaders }),
      ]);
      const [pData, pmData, tData, sData] = await Promise.all([pRes.json(), pmRes.json(), tRes.json(), sRes.json()]);
      if (pRes.ok) setProjects(Array.isArray(pData) ? pData : []);
      if (pmRes.ok) setPayments(Array.isArray(pmData) ? pmData : []);
      if (tRes.ok) setTasks(Array.isArray(tData) ? tData : []);
      if (sRes.ok) setSettlements(Array.isArray(sData) ? sData : []);
    } catch { setToast("오류: 데이터 불러오기 실패"); }
    finally { setLoading(false); }
  }, [token, projectSearch, projectFilter, dateFrom, dateTo]);

  const fetchUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const params = new URLSearchParams();
      if (userSearch.trim()) params.set("search", userSearch.trim());
      if (userRoleFilter !== "all") params.set("role", userRoleFilter);
      const res = await fetch(api(`/api/admin/users${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setUsers(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 사용자 조회 실패"); }
    finally { setUsersLoading(false); }
  }, [token, userSearch, userRoleFilter]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { if (adminTab === "users") fetchUsers(); }, [adminTab, fetchUsers]);

  const runSettlementPay = async (settlementId: number) => {
    setPaying(settlementId);
    try {
      const res = await fetch(api(`/api/admin/settlements/${settlementId}/pay`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(`정산 #${settlementId} 완료 처리되었습니다.`);
      await fetchAll();
    } catch { setToast("오류: 정산 처리 실패"); }
    finally { setPaying(null); }
  };

  const handleRoleChange = async (userId: number, newRole: string) => {
    setRoleChanging(userId);
    try {
      const res = await fetch(api(`/api/admin/users/${userId}/role`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: data.role } : u));
      setToast("역할이 변경되었습니다.");
    } catch { setToast("오류: 역할 변경 실패"); }
    finally { setRoleChanging(null); }
  };

  const handleToggleActive = async (userId: number) => {
    setToggling(userId);
    try {
      const res = await fetch(api(`/api/admin/users/${userId}/deactivate`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, isActive: data.isActive } : u));
      setToast(data.isActive ? "계정이 활성화되었습니다." : "계정이 비활성화되었습니다.");
    } catch { setToast("오류: 계정 상태 변경 실패"); }
    finally { setToggling(null); }
  };

  const filteredPayments = paymentFilter === "all" ? payments : payments.filter(p => p.status === paymentFilter);

  const tableTh: React.CSSProperties = {
    padding: "10px 12px", textAlign: "left", fontSize: 12,
    fontWeight: 600, color: "#6b7280", background: "#f9fafb",
    borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
  };
  const tableTd: React.CSSProperties = {
    padding: "11px 12px", fontSize: 13, color: "#374151",
    borderBottom: "1px solid #f3f4f6", verticalAlign: "middle",
  };

  const TABS = [
    { id: "projects", label: "프로젝트" },
    { id: "payments", label: "결제" },
    { id: "tasks", label: "작업" },
    { id: "settlements", label: "정산" },
    { id: "users", label: "사용자 관리" },
  ] as const;

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />
      {detailModal !== null && (
        <ProjectDetailModal
          projectId={detailModal} token={token}
          onClose={() => setDetailModal(null)}
          onRefresh={fetchAll}
          onToast={setToast}
        />
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#111827" }}>관리자 대시보드</h1>
          <p style={{ margin: 0, fontSize: 14, color: "#6b7280" }}>전체 현황을 조회하고 개입합니다.</p>
        </div>
        <GhostBtn onClick={fetchAll} disabled={loading}>{loading ? "로딩..." : "전체 새로고침"}</GhostBtn>
      </div>

      {/* 통계 카드 */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 24 }}>
        {[
          { label: "전체 프로젝트", value: projects.length, color: "#2563eb", bg: "#eff6ff" },
          { label: "결제 완료", value: payments.filter(p => p.status === "paid").length, color: "#059669", bg: "#f0fdf4" },
          { label: "진행 중 작업", value: tasks.filter(t => t.status !== "done").length, color: "#d97706", bg: "#fffbeb" },
          { label: "완료된 작업", value: tasks.filter(t => t.status === "done").length, color: "#9333ea", bg: "#faf5ff" },
        ].map(s => (
          <div key={s.label} style={{
            background: s.bg, border: `1px solid ${s.color}22`,
            borderRadius: 10, padding: "14px 20px", minWidth: 140, flex: "1 1 120px",
          }}>
            <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600, color: s.color }}>{s.label}</p>
            <p style={{ margin: 0, fontSize: 26, fontWeight: 800, color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* 탭 바 */}
      <div style={{ display: "flex", borderBottom: "2px solid #e5e7eb", marginBottom: 24, gap: 0 }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setAdminTab(tab.id)} style={{
            background: "none", border: "none", padding: "10px 18px", fontSize: 14,
            fontWeight: 600, cursor: "pointer",
            color: adminTab === tab.id ? "#2563eb" : "#6b7280",
            borderBottom: adminTab === tab.id ? "2px solid #2563eb" : "2px solid transparent",
            marginBottom: -2, transition: "all 0.12s",
          }}>{tab.label}</button>
        ))}
      </div>

      {/* ── 프로젝트 탭 ── */}
      {adminTab === "projects" && (
        <Section title={`전체 프로젝트 (${projects.length})`}>
          {/* 검색 + 필터 */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input
              value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
              placeholder="제목 또는 고객 이메일 검색..."
              style={{ ...inputStyle, maxWidth: 280, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
            />
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13 }} />
            <span style={{ color: "#9ca3af", fontSize: 13 }}>~</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13 }} />
            <PrimaryBtn onClick={fetchAll} disabled={loading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {loading ? "검색 중..." : "검색"}
            </PrimaryBtn>
            {(projectSearch || dateFrom || dateTo) && (
              <GhostBtn onClick={() => { setProjectSearch(""); setDateFrom(""); setDateTo(""); }} style={{ padding: "8px 12px", fontSize: 13 }}>
                초기화
              </GhostBtn>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            <FilterPill label="전체" active={projectFilter === "all"} onClick={() => setProjectFilter("all")} />
            {ALL_PROJECT_STATUSES.map(s => (
              <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                active={projectFilter === s} onClick={() => setProjectFilter(s)} />
            ))}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : projects.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
              해당 조건의 프로젝트가 없습니다.
            </Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["ID","제목","고객","상태","생성일","첨부"].map(h => (
                        <th key={h} style={tableTh}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map(p => (
                      <tr key={p.id}
                        onClick={() => setDetailModal(p.id)}
                        style={{ cursor: "pointer", transition: "background 0.1s" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f0f9ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{p.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#2563eb", maxWidth: 200 }}>
                          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{p.customerEmail ?? "-"}</td>
                        <td style={tableTd}><StatusBadge status={p.status} /></td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {new Date(p.createdAt).toLocaleDateString("ko-KR")}
                        </td>
                        <td style={tableTd}>
                          {p.fileUrl ? (
                            <a href={p.fileUrl} target="_blank" rel="noreferrer"
                              onClick={e => e.stopPropagation()}
                              style={{ color: "#2563eb", fontSize: 12, textDecoration: "none" }}>📎 파일</a>
                          ) : <span style={{ color: "#d1d5db", fontSize: 12 }}>-</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 결제 탭 ── */}
      {adminTab === "payments" && (
        <Section
          title={`결제 현황 (${filteredPayments.length})`}
          action={
            <div style={{ display: "flex", gap: 6 }}>
              <FilterPill label="전체" active={paymentFilter === "all"} onClick={() => setPaymentFilter("all")} />
              {ALL_PAYMENT_STATUSES.map(s => (
                <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                  active={paymentFilter === s} onClick={() => setPaymentFilter(s)} />
              ))}
            </div>
          }
        >
          {loading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : filteredPayments.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>결제 내역이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","프로젝트","결제 금액","결제 상태","프로젝트 상태","생성일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {filteredPayments.map(pm => (
                      <tr key={pm.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{pm.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{pm.projectTitle ?? `프로젝트 #${pm.projectId}`}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#0891b2" }}>{Number(pm.amount).toLocaleString()}원</td>
                        <td style={tableTd}><StatusBadge status={pm.status} /></td>
                        <td style={tableTd}>{pm.projectStatus ? <StatusBadge status={pm.projectStatus} /> : "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(pm.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 작업 탭 ── */}
      {adminTab === "tasks" && (
        <Section title={`작업 현황 (${tasks.length})`}>
          {loading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : tasks.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>작업이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","프로젝트","번역사","작업 상태","프로젝트 상태","생성일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {tasks.map(t => (
                      <tr key={t.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{t.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{t.projectTitle ?? `프로젝트 #${t.projectId}`}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{t.translatorEmail ?? `번역사 #${t.translatorId}`}</td>
                        <td style={tableTd}><StatusBadge status={t.status} /></td>
                        <td style={tableTd}>{t.projectStatus ? <StatusBadge status={t.projectStatus} /> : "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 정산 탭 ── */}
      {adminTab === "settlements" && (() => {
        const filtered = settlementFilter === "all" ? settlements : settlements.filter(s => s.status === settlementFilter);
        return (
          <Section
            title={`정산 현황 (${filtered.length})`}
            action={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <FilterPill label="전체" active={settlementFilter === "all"} onClick={() => setSettlementFilter("all")} />
                {ALL_SETTLEMENT_STATUSES.map(s => (
                  <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                    active={settlementFilter === s} onClick={() => setSettlementFilter(s)} />
                ))}
              </div>
            }
          >
            {loading ? (
              <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
            ) : filtered.length === 0 ? (
              <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>정산 내역이 없습니다.</Card>
            ) : (
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>{["ID","프로젝트","번역사","총 결제금액","번역사 지급액","플랫폼 수수료","상태","생성일","액션"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {filtered.map(s => (
                        <tr key={s.id}
                          onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          <td style={{ ...tableTd, color: "#9ca3af" }}>#{s.id}</td>
                          <td style={{ ...tableTd, fontWeight: 600, color: "#111827", maxWidth: 160 }}>
                            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.projectTitle ?? `프로젝트 #${s.projectId}`}</div>
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{s.translatorEmail ?? `번역사 #${s.translatorId}`}</td>
                          <td style={{ ...tableTd, fontWeight: 700, color: "#0891b2", whiteSpace: "nowrap" }}>{Number(s.totalAmount).toLocaleString()}원</td>
                          <td style={{ ...tableTd, fontWeight: 700, color: "#059669", whiteSpace: "nowrap" }}>{Number(s.translatorAmount).toLocaleString()}원</td>
                          <td style={{ ...tableTd, color: "#9333ea", whiteSpace: "nowrap" }}>{Number(s.platformFee).toLocaleString()}원</td>
                          <td style={tableTd}><StatusBadge status={s.status} /></td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(s.createdAt).toLocaleDateString("ko-KR")}</td>
                          <td style={tableTd}>
                            {s.status === "ready" && (
                              <button onClick={() => runSettlementPay(s.id)} disabled={paying === s.id} style={{
                                padding: "4px 10px", fontSize: 12, borderRadius: 6,
                                cursor: paying === s.id ? "not-allowed" : "pointer",
                                background: paying === s.id ? "#86efac" : "#059669",
                                border: "none", color: "#fff", fontWeight: 600, whiteSpace: "nowrap",
                              }}>
                                {paying === s.id ? "처리 중..." : "정산 완료 처리"}
                              </button>
                            )}
                            {s.status === "paid" && <span style={{ color: "#059669", fontSize: 12, fontWeight: 600 }}>✓ 완료</span>}
                            {s.status === "pending" && <span style={{ color: "#9ca3af", fontSize: 12 }}>대기 중</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </Section>
        );
      })()}

      {/* ── 사용자 관리 탭 ── */}
      {adminTab === "users" && (
        <Section title={`사용자 관리 (${users.length})`}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input
              value={userSearch} onChange={e => setUserSearch(e.target.value)}
              placeholder="이메일 검색..."
              style={{ ...inputStyle, maxWidth: 260, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
            />
            <select value={userRoleFilter} onChange={e => setUserRoleFilter(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13, cursor: "pointer" }}>
              <option value="all">전체 역할</option>
              <option value="customer">고객</option>
              <option value="translator">번역사</option>
              <option value="admin">관리자</option>
            </select>
            <PrimaryBtn onClick={fetchUsers} disabled={usersLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {usersLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>

          {usersLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : users.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>사용자가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","이메일","역할","상태","가입일","역할 변경","계정 상태"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {users.map(u => (
                      <tr key={u.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{u.id}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{u.email}</td>
                        <td style={tableTd}><RoleBadge role={u.role} /></td>
                        <td style={tableTd}>
                          <span style={{
                            padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
                            background: u.isActive ? "#f0fdf4" : "#fef2f2",
                            color: u.isActive ? "#059669" : "#dc2626",
                          }}>
                            {u.isActive ? "활성" : "비활성"}
                          </span>
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {new Date(u.createdAt).toLocaleDateString("ko-KR")}
                        </td>
                        <td style={tableTd}>
                          {u.role !== "admin" ? (
                            <select
                              value={u.role}
                              disabled={roleChanging === u.id}
                              onChange={e => handleRoleChange(u.id, e.target.value)}
                              style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, cursor: "pointer", background: "#fff" }}>
                              <option value="customer">고객</option>
                              <option value="translator">번역사</option>
                            </select>
                          ) : (
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>변경 불가</span>
                          )}
                        </td>
                        <td style={tableTd}>
                          {u.role !== "admin" ? (
                            <button
                              onClick={() => handleToggleActive(u.id)}
                              disabled={toggling === u.id}
                              style={{
                                padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600,
                                cursor: toggling === u.id ? "not-allowed" : "pointer",
                                background: u.isActive ? "#fef2f2" : "#f0fdf4",
                                color: u.isActive ? "#dc2626" : "#059669",
                                border: `1px solid ${u.isActive ? "#fca5a5" : "#86efac"}`,
                              }}>
                              {toggling === u.id ? "처리 중..." : u.isActive ? "비활성화" : "활성화"}
                            </button>
                          ) : (
                            <span style={{ fontSize: 12, color: "#9ca3af" }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}
    </>
  );
}

function TranslatorDashboard({ user, token }: { user: User; token: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settlements, setSettlements] = useState<MySettlement[]>([]);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch(api(`/api/tasks?translatorId=${user.id}`)),
        fetch(api("/api/settlements/my"), { headers: authHeaders }),
      ]);
      const [tData, sData] = await Promise.all([tRes.json(), sRes.json()]);
      if (tRes.ok) setTasks(Array.isArray(tData) ? tData.sort((a: Task, b: Task) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) : []);
      if (sRes.ok) setSettlements(Array.isArray(sData) ? sData : []);
    } catch { setToast("오류: 데이터를 불러올 수 없습니다."); }
    finally { setLoading(false); }
  }, [user.id, token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const doAction = async (taskId: number, action: "start" | "complete") => {
    setActing(taskId);
    try {
      const res = await fetch(api(`/api/tasks/${taskId}/${action}`), {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(action === "start" ? "작업을 시작했습니다." : "작업을 완료했습니다. 정산이 자동 생성됩니다.");
      await fetchAll();
    } catch { setToast("오류: 상태 변경 실패"); }
    finally { setActing(null); }
  };

  const active = tasks.filter(t => t.status !== "done");
  const completed = tasks.filter(t => t.status === "done");

  const SETTLEMENT_STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
    pending: { label: "대기", color: "#6b7280", bg: "#f3f4f6" },
    ready:   { label: "정산 가능", color: "#d97706", bg: "#fffbeb" },
    paid:    { label: "지급 완료", color: "#059669", bg: "#f0fdf4" },
  };

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>
          배정된 작업 <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 14 }}>({tasks.length})</span>
        </h2>
        <GhostBtn onClick={fetchAll} disabled={loading}>
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
            <div style={{ marginBottom: 24 }}>
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

      <div style={{ marginTop: 36 }}>
        <h2 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 700, color: "#111827" }}>
          정산 내역 <span style={{ color: "#6b7280", fontWeight: 400, fontSize: 14 }}>({settlements.length})</span>
        </h2>
        {settlements.length === 0 ? (
          <Card style={{ textAlign: "center", padding: "32px 24px", color: "#9ca3af" }}>
            <p style={{ margin: 0, fontSize: 28 }}>💰</p>
            <p style={{ margin: "8px 0 0", fontSize: 14 }}>아직 정산 내역이 없습니다.</p>
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {settlements.map(s => {
              const style = SETTLEMENT_STATUS_STYLE[s.status] ?? SETTLEMENT_STATUS_STYLE.pending;
              return (
                <Card key={s.id} style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <p style={{ margin: "0 0 3px", fontSize: 11, color: "#9ca3af" }}>
                      #{s.id} · {new Date(s.createdAt).toLocaleDateString("ko-KR")}
                    </p>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: "#111827" }}>
                      {s.projectTitle ?? `프로젝트 #${s.projectId}`}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ margin: "0 0 2px", fontSize: 11, color: "#9ca3af" }}>지급 예정 금액</p>
                    <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#059669" }}>
                      {Number(s.translatorAmount).toLocaleString()}
                      <span style={{ fontSize: 13, marginLeft: 3 }}>원</span>
                    </p>
                    <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>
                      총 결제 {Number(s.totalAmount).toLocaleString()}원의 70%
                    </p>
                  </div>
                  <div style={{ minWidth: 90, textAlign: "right" }}>
                    <span style={{
                      background: style.bg, color: style.color,
                      padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700,
                    }}>
                      {style.label}
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function getDefaultPage(role: Role): NavPage {
  return role === "admin" ? "admin" : "dashboard";
}

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
  const [page, setPage] = useState<NavPage>("dashboard");

  useEffect(() => {
    const session = loadSession();
    if (session) {
      setToken(session.token);
      setUser(session.user);
      setPage(getDefaultPage(session.user.role));
    }
  }, []);

  const handleAuth = (t: string, u: User) => {
    saveSession(t, u);
    setToken(t);
    setUser(u);
    setPage(getDefaultPage(u.role));
  };

  const handleLogout = () => {
    clearSession();
    setToken(null);
    setUser(null);
    setPage("dashboard");
  };

  const handleEmailChange = (newEmail: string) => {
    if (!user || !token) return;
    const updated = { ...user, email: newEmail };
    setUser(updated);
    saveSession(token, updated);
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
        {isAdmin && <AdminDashboard user={user} token={token} />}
      </main>
    </div>
  );
}
