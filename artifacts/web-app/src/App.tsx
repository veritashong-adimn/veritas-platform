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

const PROJECT_STEPS = [
  { key: "created", label: "접수" },
  { key: "quoted", label: "견적" },
  { key: "approved", label: "승인" },
  { key: "paid", label: "결제" },
  { key: "matched", label: "번역사 배정" },
  { key: "in_progress", label: "번역 중" },
  { key: "completed", label: "완료" },
] as const;

const PROJECT_STEP_KEYS = PROJECT_STEPS.map(s => s.key);

function ProjectStatusStepper({ status }: { status: string }) {
  if (status === "cancelled") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: "#dc2626", fontWeight: 600 }}>✗ 취소됨</span>
      </div>
    );
  }
  const currentIdx = PROJECT_STEP_KEYS.indexOf(status as typeof PROJECT_STEP_KEYS[number]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, overflowX: "auto", paddingBottom: 2 }}>
      {PROJECT_STEPS.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <div key={step.key} style={{ display: "flex", alignItems: "center" }}>
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            }}>
              <div style={{
                width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, fontWeight: 700,
                background: done ? "#2563eb" : active ? "#2563eb" : "#e5e7eb",
                color: (done || active) ? "#fff" : "#9ca3af",
                border: active ? "2px solid #1d4ed8" : "2px solid transparent",
                boxShadow: active ? "0 0 0 3px #bfdbfe" : "none",
              }}>
                {done ? "✓" : i + 1}
              </div>
              <span style={{
                fontSize: 9, fontWeight: active ? 700 : 500,
                color: (done || active) ? "#2563eb" : "#9ca3af",
                whiteSpace: "nowrap",
              }}>
                {step.label}
              </span>
            </div>
            {i < PROJECT_STEPS.length - 1 && (
              <div style={{
                width: 20, height: 2, marginBottom: 12,
                background: done ? "#2563eb" : "#e5e7eb",
                flexShrink: 0,
              }} />
            )}
          </div>
        );
      })}
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
  const isCancelled = project.status === "cancelled";

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

      {!isCancelled && (
        <div style={{ paddingTop: 4 }}>
          <ProjectStatusStepper status={project.status} />
        </div>
      )}

      {isCancelled && (
        <div style={{ padding: "8px 12px", background: "#fef2f2", borderRadius: 8, fontSize: 12, color: "#dc2626" }}>
          이 프로젝트는 취소되었습니다.
        </div>
      )}

      {isApproved && (
        <div style={{ padding: "8px 12px", background: "#eff6ff", borderRadius: 8, fontSize: 12, color: "#2563eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>견적이 승인되었습니다. 결제를 진행해 주세요.</span>
        </div>
      )}

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
  projectCustomerId: number | null; adminId: number | null;
  contactId: number | null; companyId: number | null;
  contactName: string | null; companyName: string | null;
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
type AdminCustomer = {
  id: number; companyName: string; contactName: string; email: string;
  phone: string | null; createdAt: string;
  projectCount: number; totalPayment: number;
};
type CustomerProjectItem = { id: number; title: string; status: string; createdAt: string };
type CustomerDetail = AdminCustomer & {
  projects: CustomerProjectItem[];
  totalSettlement: number;
};
type Communication = {
  id: number; customerId: number; projectId: number | null;
  type: "email" | "phone" | "message"; content: string; createdAt: string;
  companyName?: string | null; contactName?: string | null;
};
type ProjectTaskDetail = {
  id: number; translatorId: number; status: string; createdAt: string;
  translatorEmail: string | null;
  translatorProfile: {
    languagePairs: string | null; specializations: string | null;
    rating: number | null; availabilityStatus: string; bio: string | null;
  } | null;
  translatorRates: TranslatorRate[];
};
type MatchCandidate = {
  id: number; email: string; score: number;
  profile: {
    languagePairs: string | null; specializations: string | null;
    rating: number | null; availabilityStatus: string; bio: string | null;
  } | null;
  rates: TranslatorRate[];
};
type ProjectDetail = AdminProject & {
  quotes: Array<{ id: number; amount: number; status: string; createdAt: string }>;
  payments: Array<{ id: number; amount: number; status: string; createdAt: string }>;
  tasks: ProjectTaskDetail[];
  settlements: Array<{ id: number; totalAmount: number; translatorAmount: number; platformFee: number; status: string; createdAt: string }>;
  logs: LogEntry[];
  notes: NoteEntry[];
  communications: Communication[];
  company: { id: number; name: string; representativeName: string | null; email: string | null; phone: string | null; industry: string | null } | null;
  contact: { id: number; name: string; department: string | null; position: string | null; email: string | null; phone: string | null } | null;
};

type Company = {
  id: number; name: string; businessNumber: string | null; industry: string | null;
  address: string | null; website: string | null; notes: string | null;
  representativeName: string | null; email: string | null; phone: string | null;
  createdAt: string; contactCount: number; projectCount: number; totalPayment: number;
};
type Contact = {
  id: number; companyId: number; name: string; department: string | null; position: string | null;
  email: string | null; phone: string | null; notes: string | null; createdAt: string;
};
type AdminContact = {
  id: number; companyId: number; companyName: string | null;
  name: string; department: string | null; position: string | null;
  email: string | null; phone: string | null; notes: string | null; createdAt: string;
};
type TranslatorRate = {
  id: number; translatorId: number; serviceType: string; languagePair: string;
  unit: string; rate: number; createdAt: string;
};
type TranslatorListItem = {
  id: number; email: string; isActive: boolean; createdAt: string;
  profileId: number | null; languagePairs: string | null; specializations: string | null;
  region: string | null; rating: number | null; availabilityStatus: string | null;
  bio: string | null; ratePerWord: number | null; ratePerPage: number | null;
};
type ContactDetail = {
  id: number; companyId: number; companyName: string | null;
  name: string; department: string | null; position: string | null;
  email: string | null; phone: string | null; notes: string | null; createdAt: string;
  projects: Array<{ id: number; title: string; status: string; createdAt: string }>;
  communications: Array<{ id: number; type: string; content: string; projectId: number | null; createdAt: string }>;
};
type CompanyDetail = Company & {
  contacts: Contact[];
  projects: Array<{ id: number; title: string; status: string; createdAt: string }>;
  totalQuote: number; totalSettlement: number;
};
type Product = {
  id: number; code: string; name: string; category: string | null;
  unit: string; basePrice: number; languagePair: string | null;
  field: string | null; active: boolean; createdAt: string;
};
type BoardPost = {
  id: number; category: string; title: string; content?: string;
  pinned: boolean; visibleToAll: boolean;
  createdAt: string; updatedAt: string;
  authorId: number; authorEmail: string | null;
};
type TranslatorProfile = {
  id?: number; userId: number;
  languagePairs?: string | null; specializations?: string | null;
  education?: string | null; major?: string | null;
  graduationYear?: number | null; region?: string | null;
  rating?: number | null; availabilityStatus?: string;
  bio?: string | null; ratePerWord?: number | null; ratePerPage?: number | null;
};

const BOARD_CATEGORY_LABEL: Record<string, string> = { notice: "공지", reference: "통역자료", manual: "내부매뉴얼" };
const AVAILABILITY_LABEL: Record<string, string> = { available: "가능", busy: "바쁨", unavailable: "불가" };

const ALL_PROJECT_STATUSES = ["created","quoted","approved","paid","matched","in_progress","completed","cancelled"] as const;
const ALL_PAYMENT_STATUSES = ["pending","paid","failed"] as const;

const PROJECT_STATUS_TRANSITIONS: Record<string, string[]> = {
  created:     ["quoted", "cancelled"],
  quoted:      ["approved", "cancelled"],
  approved:    ["paid", "cancelled"],
  paid:        ["matched", "cancelled"],
  matched:     ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed:   [],
  cancelled:   [],
};

const ACTION_LABEL: Record<string, { ko: string; color: string; dot: string }> = {
  project_created:             { ko: "프로젝트 접수",      color: "#2563eb", dot: "🗂️" },
  quote_created:               { ko: "견적 생성",           color: "#7c3aed", dot: "📋" },
  quote_approved:              { ko: "견적 승인",           color: "#16a34a", dot: "✅" },
  payment_requested:           { ko: "결제 요청",           color: "#d97706", dot: "💳" },
  payment_paid:                { ko: "결제 완료",           color: "#0891b2", dot: "💰" },
  payment_failed:              { ko: "결제 실패",           color: "#dc2626", dot: "❌" },
  project_matched:             { ko: "번역사 매칭",         color: "#9333ea", dot: "🔗" },
  task_assigned:               { ko: "번역사 배정",         color: "#9333ea", dot: "👤" },
  task_started:                { ko: "작업 시작",           color: "#d97706", dot: "▶️" },
  task_completed:              { ko: "작업 완료",           color: "#059669", dot: "🎉" },
  settlement_created:          { ko: "정산 생성",           color: "#7c3aed", dot: "📊" },
  settlement_paid:             { ko: "정산 완료",           color: "#059669", dot: "💸" },
  project_cancelled:           { ko: "프로젝트 취소",       color: "#dc2626", dot: "🚫" },
  admin_project_cancelled:     { ko: "관리자 취소",          color: "#dc2626", dot: "🚫" },
  payment_received:            { ko: "결제 확인",            color: "#059669", dot: "💰" },
  admin_info_updated:          { ko: "기본정보 수정",         color: "#6b7280", dot: "✏️" },
};

function getActionLabel(action: string): { ko: string; color: string; dot: string } {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  if (action.startsWith("admin_forced_status_to_")) {
    const s = action.replace("admin_forced_status_to_", "");
    return { ko: `관리자 강제변경 → ${STATUS_LABEL[s] ?? s}`, color: "#dc2626", dot: "⚡" };
  }
  if (action.startsWith("admin_status_changed_to_")) {
    const s = action.replace("admin_status_changed_to_", "");
    return { ko: `관리자 상태변경 → ${STATUS_LABEL[s] ?? s}`, color: "#6b7280", dot: "🔄" };
  }
  if (action.startsWith("admin_assigned_translator_")) {
    return { ko: "관리자 번역사 배정", color: "#9333ea", dot: "👤" };
  }
  return { ko: action, color: "#6b7280", dot: "•" };
}

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
            <div style={{ padding: "4px 0" }}>
              {[...logs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((log, idx, arr) => {
                const info = getActionLabel(log.action);
                const isLast = idx === arr.length - 1;
                return (
                  <div key={log.id} style={{ display: "flex", gap: 0 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 34, flexShrink: 0 }}>
                      <div style={{
                        width: 26, height: 26, borderRadius: "50%",
                        background: info.color + "18", border: `2px solid ${info.color}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, flexShrink: 0,
                      }}>{info.dot}</div>
                      {!isLast && <div style={{ width: 2, flex: 1, minHeight: 14, background: "#e5e7eb" }} />}
                    </div>
                    <div style={{ flex: 1, paddingLeft: 10, paddingBottom: isLast ? 0 : 12, paddingTop: 2 }}>
                      <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: info.color }}>{info.ko}</p>
                      <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>{new Date(log.createdAt).toLocaleString("ko-KR")}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── CompanyDetailModal ──────────────────────────────────────────────────────
function CompanyDetailModal({ companyId, token, onClose, onToast, onOpenProject }: {
  companyId: number; token: string; onClose: () => void;
  onToast: (msg: string) => void; onOpenProject: (id: number) => void;
}) {
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showContactForm, setShowContactForm] = useState(false);
  const [contactForm, setContactForm] = useState({ name: "", department: "", position: "", email: "", phone: "", notes: "" });
  const [addingContact, setAddingContact] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", businessNumber: "", industry: "", address: "", website: "", notes: "", representativeName: "", email: "", phone: "" });
  const [compNotes, setCompNotes] = useState<NoteEntry[]>([]);
  const [compNoteText, setCompNoteText] = useState("");
  const [addingCompNote, setAddingCompNote] = useState(false);

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes] = await Promise.all([
        fetch(api(`/api/admin/companies/${companyId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=company&entityId=${companyId}`), { headers: authH }),
      ]);
      const [data, nData] = await Promise.all([dRes.json(), nRes.json()]);
      if (dRes.ok) {
        setDetail(data);
        setEditForm({
          name: data.name, businessNumber: data.businessNumber ?? "",
          industry: data.industry ?? "", address: data.address ?? "",
          website: data.website ?? "", notes: data.notes ?? "",
          representativeName: data.representativeName ?? "",
          email: data.email ?? "", phone: data.phone ?? "",
        });
      }
      if (nRes.ok) setCompNotes(Array.isArray(nData) ? nData : []);
    } catch { onToast("오류: 거래처 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [companyId]);

  const handleAddCompNote = async () => {
    if (!compNoteText.trim()) return;
    setAddingCompNote(true);
    try {
      const res = await fetch(api("/api/admin/notes"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "company", entityId: companyId, content: compNoteText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setCompNotes(prev => [data, ...prev]);
      setCompNoteText("");
      onToast("메모가 추가되었습니다.");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingCompNote(false); }
  };

  const handleSaveEdit = async () => {
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, ...data } : prev);
      setEditMode(false);
      onToast("거래처 정보가 수정되었습니다.");
    } catch { onToast("오류: 수정 실패"); }
  };

  const handleAddContact = async () => {
    if (!contactForm.name.trim()) { onToast("담당자명을 입력하세요."); return; }
    setAddingContact(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/contacts`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(contactForm),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, contacts: [...prev.contacts, data] } : prev);
      setContactForm({ name: "", department: "", position: "", email: "", phone: "", notes: "" });
      setShowContactForm(false);
      onToast("담당자가 추가되었습니다.");
    } catch { onToast("오류: 담당자 추가 실패"); }
    finally { setAddingContact(false); }
  };

  const sH: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", width: "100%", maxWidth: 780, padding: "24px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>거래처 #{companyId} 상세</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af" }}>×</button>
        </div>
        {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : !detail ? <p style={{ color: "#dc2626" }}>데이터를 불러올 수 없습니다.</p> : (
          <>
            <p style={sH}>거래처 정보</p>
            {!editMode ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px", marginBottom: 8 }}>
                {([["회사명", detail.name], ["사업자번호", detail.businessNumber ?? "-"], ["업종", detail.industry ?? "-"], ["주소", detail.address ?? "-"], ["웹사이트", detail.website ?? "-"], ["대표자명", detail.representativeName ?? "-"], ["이메일", detail.email ?? "-"], ["전화", detail.phone ?? "-"]] as [string,string][]).map(([l, v]) => (
                  <div key={l} style={{ display: "flex", gap: 4, fontSize: 13, marginBottom: 4 }}>
                    <span style={{ color: "#9ca3af", minWidth: 80 }}>{l}</span>
                    <span style={{ color: "#374151", fontWeight: l === "회사명" ? 700 : 400 }}>{v}</span>
                  </div>
                ))}
                <GhostBtn onClick={() => setEditMode(true)} style={{ width: "fit-content", fontSize: 12, padding: "5px 12px" }}>정보 수정</GhostBtn>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", marginBottom: 12 }}>
                {(["name","businessNumber","industry","address","website","representativeName","email","phone"] as const).map(f => (
                  <div key={f}><label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{f === "name" ? "회사명*" : f === "businessNumber" ? "사업자번호" : f === "industry" ? "업종" : f === "address" ? "주소" : f === "website" ? "웹사이트" : f === "representativeName" ? "대표자명" : f === "email" ? "이메일" : "전화"}</label>
                    <input value={editForm[f]} onChange={e => setEditForm(p => ({ ...p, [f]: e.target.value }))} style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} /></div>
                ))}
                <div style={{ gridColumn: "span 2", display: "flex", gap: 8 }}>
                  <PrimaryBtn onClick={handleSaveEdit} style={{ fontSize: 13, padding: "7px 16px" }}>저장</PrimaryBtn>
                  <GhostBtn onClick={() => setEditMode(false)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                </div>
              </div>
            )}

            <p style={sH}>재무 요약</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {[
                { label: "담당자 수", value: `${detail.contacts.length}명`, color: "#6b7280", bg: "#f3f4f6" },
                { label: "프로젝트 수", value: `${detail.projects.length}건`, color: "#2563eb", bg: "#eff6ff" },
                { label: "총 견적 금액", value: `${Number(detail.totalQuote).toLocaleString()}원`, color: "#0891b2", bg: "#f0f9ff" },
                { label: "총 결제 금액", value: `${Number(detail.totalPayment).toLocaleString()}원`, color: "#059669", bg: "#f0fdf4" },
                { label: "총 정산 금액", value: `${Number(detail.totalSettlement).toLocaleString()}원`, color: "#7c3aed", bg: "#faf5ff" },
              ].map(s => (
                <div key={s.label} style={{ background: s.bg, border: `1px solid ${s.color}22`, borderRadius: 10, padding: "10px 16px", flex: "1 1 100px" }}>
                  <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: s.color }}>{s.label}</p>
                  <p style={{ margin: 0, fontSize: 18, fontWeight: 800, color: s.color }}>{s.value}</p>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20, marginBottom: 10 }}>
              <p style={{ ...sH, margin: 0 }}>담당자 목록 ({detail.contacts.length})</p>
              <GhostBtn onClick={() => setShowContactForm(v => !v)} style={{ fontSize: 12, padding: "4px 10px" }}>+ 추가</GhostBtn>
            </div>
            {showContactForm && (
              <div style={{ background: "#f9fafb", borderRadius: 10, padding: "14px 16px", marginBottom: 12, border: "1px solid #e5e7eb" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
                  {(["name","department","position","email","phone"] as const).map(f => (
                    <div key={f}><label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>{f === "name" ? "이름*" : f === "department" ? "부서" : f === "position" ? "직책" : f === "email" ? "이메일" : "전화"}</label>
                      <input value={contactForm[f]} onChange={e => setContactForm(p => ({ ...p, [f]: e.target.value }))} style={{ ...inputStyle, fontSize: 13, padding: "6px 10px", width: "100%", boxSizing: "border-box" }} /></div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <PrimaryBtn onClick={handleAddContact} disabled={addingContact} style={{ fontSize: 13, padding: "7px 16px" }}>{addingContact ? "추가 중..." : "추가"}</PrimaryBtn>
                  <GhostBtn onClick={() => setShowContactForm(false)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                </div>
              </div>
            )}
            {detail.contacts.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>등록된 담당자가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.contacts.map(c => (
                  <div key={c.id} style={{ padding: "10px 14px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                    <strong style={{ color: "#111827", minWidth: 80 }}>{c.name}</strong>
                    {c.position && <span style={{ color: "#6b7280" }}>{c.position}</span>}
                    {c.email && <span style={{ color: "#2563eb" }}>✉ {c.email}</span>}
                    {c.phone && <span style={{ color: "#374151" }}>📞 {c.phone}</span>}
                  </div>
                ))}
              </div>
            )}

            <p style={{ ...sH, marginTop: 20 }}>프로젝트 목록 ({detail.projects.length})</p>
            {detail.projects.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>등록된 프로젝트가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.projects.map(p => (
                  <div key={p.id} onClick={() => { onClose(); onOpenProject(p.id); }}
                    style={{ display: "flex", gap: 16, padding: "10px 14px", background: "#f9fafb", borderRadius: 8, fontSize: 13, cursor: "pointer", alignItems: "center", border: "1px solid transparent" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#eff6ff"; (e.currentTarget as HTMLDivElement).style.borderColor = "#bfdbfe"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; (e.currentTarget as HTMLDivElement).style.borderColor = "transparent"; }}>
                    <span style={{ color: "#9ca3af", minWidth: 36 }}>#{p.id}</span>
                    <span style={{ fontWeight: 600, color: "#111827", flex: 1 }}>{p.title}</span>
                    <StatusBadge status={p.status} />
                    <span style={{ color: "#9ca3af", fontSize: 12 }}>{new Date(p.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </div>
            )}

            <p style={{ ...sH, marginTop: 20 }}>메모 ({compNotes.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input value={compNoteText} onChange={e => setCompNoteText(e.target.value)} placeholder="메모 입력..."
                style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
                onKeyDown={e => e.key === "Enter" && handleAddCompNote()} />
              <PrimaryBtn onClick={handleAddCompNote} disabled={addingCompNote || !compNoteText.trim()} style={{ fontSize: 13, padding: "7px 14px" }}>
                {addingCompNote ? "추가 중..." : "추가"}
              </PrimaryBtn>
            </div>
            {compNotes.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>메모가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {compNotes.map(n => (
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

// ─── TranslatorProfileModal ──────────────────────────────────────────────────
function TranslatorProfileModal({ userId, userEmail, token, onClose, onToast }: {
  userId: number; userEmail: string; token: string;
  onClose: () => void; onToast: (msg: string) => void;
}) {
  const [profile, setProfile] = useState<TranslatorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    languagePairs: "", specializations: "", education: "", major: "",
    graduationYear: "", region: "", rating: "", availabilityStatus: "available",
    bio: "", ratePerWord: "", ratePerPage: "",
  });

  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/translator-profiles/${userId}`), { headers: authH });
        const data = await res.json();
        if (res.ok && data.profile) {
          const p = data.profile as TranslatorProfile;
          setProfile(p);
          setForm({
            languagePairs: p.languagePairs ?? "",
            specializations: p.specializations ?? "",
            education: p.education ?? "",
            major: p.major ?? "",
            graduationYear: p.graduationYear ? String(p.graduationYear) : "",
            region: p.region ?? "",
            rating: p.rating ? String(p.rating) : "",
            availabilityStatus: p.availabilityStatus ?? "available",
            bio: p.bio ?? "",
            ratePerWord: p.ratePerWord ? String(p.ratePerWord) : "",
            ratePerPage: p.ratePerPage ? String(p.ratePerPage) : "",
          });
        }
      } catch { onToast("오류: 프로필 불러오기 실패"); }
      finally { setLoading(false); }
    })();
  }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/translator-profiles/${userId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
          rating: form.rating ? Number(form.rating) : null,
          ratePerWord: form.ratePerWord ? Number(form.ratePerWord) : null,
          ratePerPage: form.ratePerPage ? Number(form.ratePerPage) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setProfile(data);
      onToast("번역사 프로필이 저장되었습니다.");
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const F = ({ label, field, type = "text", placeholder = "" }: { label: string; field: keyof typeof form; type?: string; placeholder?: string }) => (
    <div>
      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{label}</label>
      <input type={type} value={form[field]} onChange={e => setForm(p => ({ ...p, [field]: e.target.value }))}
        placeholder={placeholder} style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", width: "100%", maxWidth: 680, padding: "24px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>번역사 프로필</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>{userEmail}</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af" }}>×</button>
        </div>
        {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" }}>기본 정보</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                <F label="언어 조합 (예: 한→영, 영→한)" field="languagePairs" placeholder="한→영, 영→한" />
                <F label="전문 분야" field="specializations" placeholder="법률, 의학, 기술" />
                <F label="학력" field="education" placeholder="서울대학교" />
                <F label="전공" field="major" />
                <F label="졸업연도" field="graduationYear" type="number" placeholder="2010" />
                <F label="지역" field="region" placeholder="서울" />
              </div>
            </div>
            <div>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" }}>운영 정보</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>가용 상태</label>
                  <select value={form.availabilityStatus} onChange={e => setForm(p => ({ ...p, availabilityStatus: e.target.value }))}
                    style={{ ...inputStyle, width: "100%", padding: "7px 10px", fontSize: 13 }}>
                    <option value="available">가능</option>
                    <option value="busy">바쁨</option>
                    <option value="unavailable">불가</option>
                  </select>
                </div>
                <F label="평점 (0-5)" field="rating" type="number" placeholder="4.5" />
                <F label="단어당 단가 (원)" field="ratePerWord" type="number" placeholder="50" />
                <F label="페이지당 단가 (원)" field="ratePerPage" type="number" placeholder="10000" />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>소개 / 메모</label>
              <textarea value={form.bio} onChange={e => setForm(p => ({ ...p, bio: e.target.value }))}
                rows={4} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 14, padding: "10px 24px" }}>
                {saving ? "저장 중..." : "저장"}
              </PrimaryBtn>
              <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "10px 20px" }}>닫기</GhostBtn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ContactDetailModal ──────────────────────────────────────────────────────
function ContactDetailModal({ contactId, token, onClose, onToast, onOpenProject }: {
  contactId: number; token: string; onClose: () => void;
  onToast: (msg: string) => void; onOpenProject: (id: number) => void;
}) {
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes] = await Promise.all([
        fetch(api(`/api/admin/contacts/${contactId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=contact&entityId=${contactId}`), { headers: authH }),
      ]);
      const [dData, nData] = await Promise.all([dRes.json(), nRes.json()]);
      if (dRes.ok) setDetail(dData);
      if (nRes.ok) setNotes(Array.isArray(nData) ? nData : []);
    } catch { onToast("오류: 담당자 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [contactId]);

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(api("/api/admin/notes"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "contact", entityId: contactId, content: noteText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setNotes(prev => [data, ...prev]);
      setNoteText("");
      onToast("메모가 추가되었습니다.");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const sH: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", width: "100%", maxWidth: 720, padding: "24px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>담당자 상세</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af" }}>×</button>
        </div>
        {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : !detail ? <p style={{ color: "#dc2626" }}>데이터를 불러올 수 없습니다.</p> : (
          <>
            <p style={sH}>기본 정보</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px", marginBottom: 8 }}>
              {([["이름", detail.name], ["거래처", detail.companyName ?? "-"], ["부서", detail.department ?? "-"], ["직책", detail.position ?? "-"], ["이메일", detail.email ?? "-"], ["전화", detail.phone ?? "-"]] as [string,string][]).map(([l, v]) => (
                <div key={l} style={{ display: "flex", gap: 4, fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: "#9ca3af", minWidth: 60 }}>{l}</span>
                  <span style={{ color: "#374151", fontWeight: l === "이름" ? 700 : 400 }}>{v}</span>
                </div>
              ))}
            </div>

            <p style={{ ...sH, marginTop: 20 }}>연관 프로젝트 ({detail.projects.length})</p>
            {detail.projects.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>프로젝트가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.projects.map(p => (
                  <div key={p.id} onClick={() => { onClose(); onOpenProject(p.id); }}
                    style={{ display: "flex", gap: 16, padding: "10px 14px", background: "#f9fafb", borderRadius: 8, fontSize: 13, cursor: "pointer", alignItems: "center", border: "1px solid transparent" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#eff6ff"; (e.currentTarget as HTMLDivElement).style.borderColor = "#bfdbfe"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; (e.currentTarget as HTMLDivElement).style.borderColor = "transparent"; }}>
                    <span style={{ color: "#9ca3af", minWidth: 36 }}>#{p.id}</span>
                    <span style={{ fontWeight: 600, color: "#111827", flex: 1 }}>{p.title}</span>
                    <StatusBadge status={p.status} />
                    <span style={{ color: "#9ca3af", fontSize: 12 }}>{new Date(p.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </div>
            )}

            {detail.communications.length > 0 && (
              <>
                <p style={{ ...sH, marginTop: 20 }}>커뮤니케이션 이력 ({detail.communications.length})</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {detail.communications.map(c => (
                    <div key={c.id} style={{ padding: "8px 12px", background: "#f9fafb", borderRadius: 8, fontSize: 12, border: "1px solid #f3f4f6" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                        <span style={{ fontWeight: 600, color: "#6b7280" }}>{c.type}</span>
                        <span style={{ color: "#9ca3af" }}>{new Date(c.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                      <p style={{ margin: 0, color: "#374151" }}>{c.content}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            <p style={{ ...sH, marginTop: 20 }}>메모 ({notes.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="메모 입력..."
                style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
                onKeyDown={e => e.key === "Enter" && handleAddNote()} />
              <PrimaryBtn onClick={handleAddNote} disabled={addingNote || !noteText.trim()} style={{ fontSize: 13, padding: "7px 14px" }}>
                {addingNote ? "추가 중..." : "추가"}
              </PrimaryBtn>
            </div>
            {notes.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>메모가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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

// ─── TranslatorDetailModal ───────────────────────────────────────────────────
function TranslatorDetailModal({ userId, userEmail, token, onClose, onToast }: {
  userId: number; userEmail: string; token: string;
  onClose: () => void; onToast: (msg: string) => void;
}) {
  const [profile, setProfile] = useState<TranslatorProfile | null>(null);
  const [rates, setRates] = useState<TranslatorRate[]>([]);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [rateForm, setRateForm] = useState({ serviceType: "", languagePair: "", unit: "word", rate: "" });
  const [addingRate, setAddingRate] = useState(false);
  const [form, setForm] = useState({
    languagePairs: "", specializations: "", education: "", major: "",
    graduationYear: "", region: "", rating: "", availabilityStatus: "available",
    bio: "", ratePerWord: "", ratePerPage: "",
  });

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes] = await Promise.all([
        fetch(api(`/api/admin/translators/${userId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=translator&entityId=${userId}`), { headers: authH }),
      ]);
      const [dData, nData] = await Promise.all([dRes.json(), nRes.json()]);
      if (dRes.ok) {
        const p: TranslatorProfile | null = dData.profile;
        setProfile(p);
        setRates(Array.isArray(dData.rates) ? dData.rates : []);
        if (p) {
          setForm({
            languagePairs: p.languagePairs ?? "", specializations: p.specializations ?? "",
            education: p.education ?? "", major: p.major ?? "",
            graduationYear: p.graduationYear ? String(p.graduationYear) : "",
            region: p.region ?? "", rating: p.rating ? String(p.rating) : "",
            availabilityStatus: p.availabilityStatus ?? "available",
            bio: p.bio ?? "", ratePerWord: p.ratePerWord ? String(p.ratePerWord) : "",
            ratePerPage: p.ratePerPage ? String(p.ratePerPage) : "",
          });
        }
      }
      if (nRes.ok) setNotes(Array.isArray(nData) ? nData : []);
    } catch { onToast("오류: 번역사 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
          rating: form.rating ? Number(form.rating) : null,
          ratePerWord: form.ratePerWord ? Number(form.ratePerWord) : null,
          ratePerPage: form.ratePerPage ? Number(form.ratePerPage) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setProfile(data);
      onToast("번역사 프로필이 저장되었습니다.");
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const handleAddRate = async () => {
    if (!rateForm.serviceType.trim() || !rateForm.languagePair.trim() || !rateForm.rate) return;
    setAddingRate(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/rates`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ ...rateForm, rate: Number(rateForm.rate) }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setRates(prev => [data, ...prev]);
      setRateForm({ serviceType: "", languagePair: "", unit: "word", rate: "" });
      onToast("단가가 추가되었습니다.");
    } catch { onToast("오류: 단가 추가 실패"); }
    finally { setAddingRate(false); }
  };

  const handleDeleteRate = async (rateId: number) => {
    try {
      await fetch(api(`/api/admin/translators/${userId}/rates/${rateId}`), { method: "DELETE", headers: authH });
      setRates(prev => prev.filter(r => r.id !== rateId));
      onToast("단가가 삭제되었습니다.");
    } catch { onToast("오류: 단가 삭제 실패"); }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(api("/api/admin/notes"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "translator", entityId: userId, content: noteText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setNotes(prev => [data, ...prev]);
      setNoteText("");
      onToast("메모가 추가되었습니다.");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const sH: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
  };
  const F = ({ label, field, type = "text", placeholder = "" }: { label: string; field: keyof typeof form; type?: string; placeholder?: string }) => (
    <div>
      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{label}</label>
      <input type={type} value={form[field]} onChange={e => setForm(p => ({ ...p, [field]: e.target.value }))}
        placeholder={placeholder} style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", width: "100%", maxWidth: 820, padding: "24px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>번역사 상세</h2>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>{userEmail}</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af" }}>×</button>
        </div>
        {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : (
          <>
            <p style={sH}>프로필 편집</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", marginBottom: 12 }}>
              <F label="언어쌍" field="languagePairs" placeholder="예: 한→영, 영→한" />
              <F label="전문분야" field="specializations" placeholder="예: 법률, IT, 의학" />
              <F label="학력" field="education" />
              <F label="전공" field="major" />
              <F label="졸업연도" field="graduationYear" type="number" />
              <F label="지역" field="region" />
              <F label="평점 (1-5)" field="rating" type="number" placeholder="예: 4.5" />
              <div>
                <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>가용 상태</label>
                <select value={form.availabilityStatus} onChange={e => setForm(p => ({ ...p, availabilityStatus: e.target.value }))}
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                  <option value="available">가능</option>
                  <option value="busy">바쁨</option>
                  <option value="unavailable">불가</option>
                </select>
              </div>
              <F label="기본 단가 (어절)" field="ratePerWord" type="number" />
              <F label="기본 단가 (페이지)" field="ratePerPage" type="number" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>소개/메모</label>
              <textarea value={form.bio} onChange={e => setForm(p => ({ ...p, bio: e.target.value }))}
                rows={3} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
            </div>
            <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: "8px 20px", marginBottom: 4 }}>
              {saving ? "저장 중..." : "프로필 저장"}
            </PrimaryBtn>

            <p style={sH}>단가 관리 ({rates.length})</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px 100px auto", gap: "6px 8px", alignItems: "end", marginBottom: 10 }}>
              <input value={rateForm.serviceType} onChange={e => setRateForm(p => ({ ...p, serviceType: e.target.value }))}
                placeholder="서비스 유형 (예: 번역)" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
              <input value={rateForm.languagePair} onChange={e => setRateForm(p => ({ ...p, languagePair: e.target.value }))}
                placeholder="언어조합 (예: 한→영)" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
              <select value={rateForm.unit} onChange={e => setRateForm(p => ({ ...p, unit: e.target.value }))}
                style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }}>
                <option value="word">어절</option>
                <option value="page">페이지</option>
                <option value="hour">시간</option>
              </select>
              <input type="number" value={rateForm.rate} onChange={e => setRateForm(p => ({ ...p, rate: e.target.value }))}
                placeholder="단가(원)" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
              <PrimaryBtn onClick={handleAddRate} disabled={addingRate} style={{ fontSize: 12, padding: "6px 12px", whiteSpace: "nowrap" }}>
                {addingRate ? "추가 중..." : "+ 추가"}
              </PrimaryBtn>
            </div>
            {rates.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 4 }}>
                {rates.map(r => (
                  <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", fontSize: 13 }}>
                    <span style={{ fontWeight: 600, color: "#374151", minWidth: 80 }}>{r.serviceType}</span>
                    <span style={{ color: "#2563eb", minWidth: 80 }}>{r.languagePair}</span>
                    <span style={{ color: "#6b7280", minWidth: 50 }}>{r.unit === "word" ? "어절" : r.unit === "page" ? "페이지" : "시간"}</span>
                    <span style={{ fontWeight: 700, color: "#059669", flex: 1 }}>{r.rate.toLocaleString()}원</span>
                    <button onClick={() => handleDeleteRate(r.id)} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 12, cursor: "pointer" }}>삭제</button>
                  </div>
                ))}
              </div>
            ) : <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0" }}>등록된 단가가 없습니다.</p>}

            <p style={sH}>메모 ({notes.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="메모 입력..."
                style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
                onKeyDown={e => e.key === "Enter" && handleAddNote()} />
              <PrimaryBtn onClick={handleAddNote} disabled={addingNote || !noteText.trim()} style={{ fontSize: 13, padding: "7px 14px" }}>
                {addingNote ? "추가 중..." : "추가"}
              </PrimaryBtn>
            </div>
            {notes.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0" }}>메모가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "9px 20px" }}>닫기</GhostBtn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const COMM_TYPE_LABEL: Record<string, string> = { email: "이메일", phone: "전화", message: "메시지" };
const COMM_TYPE_COLOR: Record<string, string> = { email: "#2563eb", phone: "#059669", message: "#7c3aed" };

function CustomerDetailModal({ customerId, token, onClose, onToast, onOpenProject }: {
  customerId: number; token: string; onClose: () => void;
  onToast: (msg: string) => void; onOpenProject: (id: number) => void;
}) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [comms, setComms] = useState<Communication[]>([]);
  const [loading, setLoading] = useState(true);
  const [commType, setCommType] = useState<"email"|"phone"|"message">("message");
  const [commContent, setCommContent] = useState("");
  const [addingComm, setAddingComm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ companyName: "", contactName: "", email: "", phone: "" });

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      const [dRes, cRes] = await Promise.all([
        fetch(api(`/api/admin/customers/${customerId}`), { headers: authH }),
        fetch(api(`/api/admin/customers/${customerId}/communications`), { headers: authH }),
      ]);
      const [dData, cData] = await Promise.all([dRes.json(), cRes.json()]);
      if (dRes.ok) {
        setDetail(dData);
        setEditForm({ companyName: dData.companyName, contactName: dData.contactName, email: dData.email, phone: dData.phone ?? "" });
      }
      if (cRes.ok) setComms(Array.isArray(cData) ? cData : []);
    } catch { onToast("오류: 고객 데이터 불러오기 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [customerId]);

  const handleAddComm = async () => {
    if (!commContent.trim()) return;
    setAddingComm(true);
    try {
      const res = await fetch(api("/api/admin/communications"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, type: commType, content: commContent.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setComms(prev => [data, ...prev]);
      setCommContent("");
      onToast("커뮤니케이션 기록이 추가되었습니다.");
    } catch { onToast("오류: 추가 실패"); }
    finally { setAddingComm(false); }
  };

  const handleSaveEdit = async () => {
    if (!editForm.companyName.trim() || !editForm.contactName.trim() || !editForm.email.trim()) {
      onToast("필수 항목을 입력하세요."); return;
    }
    try {
      const res = await fetch(api(`/api/admin/customers/${customerId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, ...data } : prev);
      setEditing(false);
      onToast("고객 정보가 수정되었습니다.");
    } catch { onToast("오류: 수정 실패"); }
  };

  const sH: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 300, overflowY: "auto", padding: "20px 16px",
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb",
        width: "100%", maxWidth: 760, padding: "24px 28px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>
            고객 #{customerId} 상세
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
        ) : !detail ? (
          <p style={{ color: "#dc2626" }}>고객 데이터를 불러올 수 없습니다.</p>
        ) : (
          <>
            {/* 고객 기본 정보 */}
            <p style={sH}>고객 정보</p>
            {!editing ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
                {[
                  ["회사명", detail.companyName],
                  ["담당자", detail.contactName],
                  ["이메일", detail.email],
                  ["전화", detail.phone ?? "-"],
                  ["등록일", new Date(detail.createdAt).toLocaleDateString("ko-KR")],
                ].map(([label, val]) => (
                  <div key={label} style={{ display: "flex", gap: 4, fontSize: 13, marginBottom: 6 }}>
                    <span style={{ color: "#9ca3af", minWidth: 72 }}>{label}</span>
                    <span style={{ color: "#374151", fontWeight: label === "회사명" ? 700 : 400 }}>{val}</span>
                  </div>
                ))}
                <GhostBtn onClick={() => setEditing(true)} style={{ gridColumn: "span 2", width: "fit-content", marginTop: 4, fontSize: 12, padding: "5px 12px" }}>정보 수정</GhostBtn>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
                {(["companyName","contactName","email","phone"] as const).map(field => (
                  <div key={field}>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>
                      {field === "companyName" ? "회사명" : field === "contactName" ? "담당자" : field === "email" ? "이메일" : "전화"}
                    </label>
                    <input
                      value={editForm[field]}
                      onChange={e => setEditForm(f => ({ ...f, [field]: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                    />
                  </div>
                ))}
                <div style={{ gridColumn: "span 2", display: "flex", gap: 8, marginTop: 4 }}>
                  <PrimaryBtn onClick={handleSaveEdit} style={{ fontSize: 13, padding: "7px 16px" }}>저장</PrimaryBtn>
                  <GhostBtn onClick={() => setEditing(false)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                </div>
              </div>
            )}

            {/* 요약 통계 */}
            <p style={sH}>통계 요약</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {[
                { label: "총 프로젝트", value: `${detail.projectCount}건`, color: "#2563eb", bg: "#eff6ff" },
                { label: "총 결제 금액", value: `${Number(detail.totalPayment).toLocaleString()}원`, color: "#059669", bg: "#f0fdf4" },
                { label: "총 정산 금액", value: `${Number(detail.totalSettlement).toLocaleString()}원`, color: "#7c3aed", bg: "#faf5ff" },
              ].map(s => (
                <div key={s.label} style={{ background: s.bg, border: `1px solid ${s.color}22`, borderRadius: 10, padding: "12px 18px", flex: "1 1 120px" }}>
                  <p style={{ margin: "0 0 3px", fontSize: 11, fontWeight: 600, color: s.color }}>{s.label}</p>
                  <p style={{ margin: 0, fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</p>
                </div>
              ))}
            </div>

            {/* 프로젝트 목록 */}
            <p style={sH}>프로젝트 목록 ({detail.projects.length})</p>
            {detail.projects.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "12px 0" }}>등록된 프로젝트가 없습니다.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.projects.map(p => (
                  <div key={p.id} onClick={() => { onClose(); onOpenProject(p.id); }}
                    style={{
                      display: "flex", gap: 16, padding: "10px 14px", background: "#f9fafb",
                      borderRadius: 8, fontSize: 13, cursor: "pointer", alignItems: "center",
                      border: "1px solid transparent", transition: "all 0.12s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#eff6ff"; (e.currentTarget as HTMLDivElement).style.borderColor = "#bfdbfe"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; (e.currentTarget as HTMLDivElement).style.borderColor = "transparent"; }}>
                    <span style={{ color: "#9ca3af", minWidth: 36 }}>#{p.id}</span>
                    <span style={{ fontWeight: 600, color: "#111827", flex: 1 }}>{p.title}</span>
                    <StatusBadge status={p.status} />
                    <span style={{ color: "#9ca3af", fontSize: 12, whiteSpace: "nowrap" }}>{new Date(p.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </div>
            )}

            {/* 커뮤니케이션 기록 */}
            <p style={sH}>커뮤니케이션 기록 ({comms.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <select value={commType} onChange={e => setCommType(e.target.value as "email"|"phone"|"message")}
                style={{ ...inputStyle, width: "auto", padding: "7px 10px", fontSize: 13 }}>
                <option value="message">메시지</option>
                <option value="email">이메일</option>
                <option value="phone">전화</option>
              </select>
              <input
                value={commContent} onChange={e => setCommContent(e.target.value)}
                placeholder="내용 입력..."
                style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "8px 10px", minWidth: 200 }}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleAddComm()}
              />
              <PrimaryBtn onClick={handleAddComm} disabled={addingComm || !commContent.trim()} style={{ padding: "8px 16px", fontSize: 13 }}>
                {addingComm ? "추가 중..." : "기록 추가"}
              </PrimaryBtn>
            </div>
            {comms.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "12px 0" }}>커뮤니케이션 기록이 없습니다.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
                {comms.map(c => (
                  <div key={c.id} style={{ padding: "10px 14px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, alignItems: "center" }}>
                      <span style={{
                        padding: "2px 9px", borderRadius: 12, fontSize: 11, fontWeight: 700,
                        background: `${COMM_TYPE_COLOR[c.type]}18`, color: COMM_TYPE_COLOR[c.type],
                      }}>{COMM_TYPE_LABEL[c.type]}</span>
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(c.createdAt).toLocaleString("ko-KR")}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{c.content}</p>
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

function ProjectDetailModal({ projectId, token, onClose, onRefresh, onToast, adminList }: {
  projectId: number; token: string; onClose: () => void;
  onRefresh: () => void; onToast: (msg: string) => void;
  adminList?: AdminUser[];
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [statusTarget, setStatusTarget] = useState("");
  const [changingStatus, setChangingStatus] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [commType, setCommType] = useState<"email"|"phone"|"message">("message");
  const [commContent, setCommContent] = useState("");
  const [addingComm, setAddingComm] = useState(false);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [showCandidates, setShowCandidates] = useState(false);
  const [activeSection, setActiveSection] = useState<"info"|"company"|"translator"|"settlement"|"comms"|"notes"|"log">("info");

  // 기본정보 인라인 편집
  const [editingInfo, setEditingInfo] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editCompanyId, setEditCompanyId] = useState<number | null>(null);
  const [editContactId, setEditContactId] = useState<number | null>(null);
  const [savingInfo, setSavingInfo] = useState(false);
  const [companiesList, setCompaniesList] = useState<{id: number; name: string}[]>([]);
  const [contactsList, setContactsList] = useState<{id: number; name: string; companyId: number | null}[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);

  // 견적 생성
  const [quoteAmount, setQuoteAmount] = useState("");
  const [creatingQuote, setCreatingQuote] = useState(false);
  type QuoteItemForm = { productName: string; unit: string; quantity: string; unitPrice: string; taxRate: "0" | "0.1" };
  const defaultItem = (): QuoteItemForm => ({ productName: "", unit: "건", quantity: "1", unitPrice: "", taxRate: "0" });
  const [quoteMode, setQuoteMode] = useState<"simple" | "items">("simple");
  const [quoteItemForms, setQuoteItemForms] = useState<QuoteItemForm[]>([defaultItem()]);
  const calcItemTotal = (it: QuoteItemForm) => {
    const supply = Math.round(Number(it.quantity || 1) * Number(it.unitPrice || 0));
    const tax = Math.round(supply * Number(it.taxRate));
    return { supply, tax, total: supply + tax };
  };
  const quoteItemsGrandTotal = quoteItemForms.reduce((s, it) => s + calcItemTotal(it).total, 0);

  // 결제 등록
  const [paymentAmount, setPaymentAmount] = useState("");
  const [creatingPayment, setCreatingPayment] = useState(false);

  const authH = { Authorization: `Bearer ${token}` };

  const loadDetail = async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}`), { headers: authH });
      const data = await res.json();
      if (res.ok) {
        setDetail(data);
        setStatusTarget(data.status);
      } else {
        setErr(data.error ?? "조회 실패");
      }
    } catch { setErr("서버 연결 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadDetail(); }, [projectId]);

  const loadCandidates = async () => {
    setLoadingCandidates(true);
    setShowCandidates(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/match-candidates`), { headers: authH });
      const data = await res.json();
      if (res.ok) setCandidates(Array.isArray(data) ? data : []);
      else onToast(`오류: ${data.error}`);
    } catch { onToast("오류: 후보 조회 실패"); }
    finally { setLoadingCandidates(false); }
  };

  const handleAssignTranslator = async (translatorId: number) => {
    setAssigning(translatorId);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/assign-translator`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ translatorId }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`번역사 배정 완료 → ${data.translatorEmail}`);
      setShowCandidates(false);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 배정 실패"); }
    finally { setAssigning(null); }
  };

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

  const loadMeta = async () => {
    if (companiesList.length > 0) return;
    setLoadingMeta(true);
    try {
      const [cRes, coRes] = await Promise.all([
        fetch(api("/api/admin/companies"), { headers: authH }),
        fetch(api("/api/admin/contacts"), { headers: authH }),
      ]);
      if (cRes.ok) setCompaniesList((await cRes.json()).map((c: any) => ({ id: c.id, name: c.name })));
      if (coRes.ok) setContactsList((await coRes.json()).map((c: any) => ({ id: c.id, name: c.name, companyId: c.companyId })));
    } catch { /* ignore */ }
    finally { setLoadingMeta(false); }
  };

  const startEditInfo = async () => {
    if (!detail) return;
    await loadMeta();
    setEditTitle(detail.title);
    setEditCompanyId(detail.company?.id ?? (detail as any).companyId ?? null);
    setEditContactId(detail.contact?.id ?? (detail as any).contactId ?? null);
    setEditingInfo(true);
  };

  const handleSaveInfo = async () => {
    if (!editTitle.trim()) return;
    setSavingInfo(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/info`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle.trim(), companyId: editCompanyId, contactId: editContactId }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast("기본정보가 수정되었습니다.");
      setEditingInfo(false);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 저장 실패"); }
    finally { setSavingInfo(false); }
  };

  const handleCreateQuote = async () => {
    setCreatingQuote(true);
    try {
      let body: Record<string, unknown>;
      if (quoteMode === "items") {
        const validItems = quoteItemForms.filter(it => it.productName.trim() && Number(it.unitPrice) > 0);
        if (validItems.length === 0) { onToast("품목명과 단가를 입력하세요."); return; }
        body = {
          items: validItems.map(it => ({
            productName: it.productName.trim(),
            unit: it.unit || "건",
            quantity: Number(it.quantity) || 1,
            unitPrice: Number(it.unitPrice),
            taxRate: Number(it.taxRate) as 0 | 0.1,
          })),
        };
      } else {
        const amt = Number(quoteAmount.replace(/,/g, ""));
        if (!amt || amt <= 0) { onToast("유효한 금액을 입력하세요."); return; }
        body = { amount: amt };
      }
      const res = await fetch(api(`/api/admin/projects/${projectId}/quote`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`견적 생성 완료`);
      setQuoteAmount(""); setQuoteItemForms([defaultItem()]);
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 견적 생성 실패"); }
    finally { setCreatingQuote(false); }
  };

  const handleCreatePayment = async () => {
    const amt = Number(paymentAmount.replace(/,/g, ""));
    if (!amt || amt <= 0) { onToast("유효한 금액을 입력하세요."); return; }
    setCreatingPayment(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/payment`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amt }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      onToast(`결제 등록 완료 — ${amt.toLocaleString()}원`);
      setPaymentAmount("");
      await loadDetail(); onRefresh();
    } catch { onToast("오류: 결제 등록 실패"); }
    finally { setCreatingPayment(false); }
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
      setDetail(prev => prev ? { ...prev, notes: [...(prev.notes ?? []), data] } : prev);
      setNoteInput("");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const handleAddComm = async () => {
    if (!commContent.trim() || !detail) return;
    setAddingComm(true);
    try {
      const res = await fetch(api("/api/admin/communications"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: detail.projectCustomerId, projectId, type: commType, content: commContent.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, communications: [data, ...(prev.communications ?? [])] } : prev);
      setCommContent("");
      onToast("커뮤니케이션 기록이 추가되었습니다.");
    } catch { onToast("오류: 추가 실패"); }
    finally { setAddingComm(false); }
  };

  const AVAIL_STYLE: Record<string, { label: string; color: string }> = {
    available: { label: "가능", color: "#059669" },
    busy:      { label: "바쁨", color: "#d97706" },
    unavailable: { label: "불가", color: "#dc2626" },
  };

  const sectionHd: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "16px 0 8px", paddingBottom: 5, borderBottom: "1px solid #f3f4f6",
  };
  const dl: React.CSSProperties = { display: "flex", gap: 6, fontSize: 13, marginBottom: 5, alignItems: "flex-start" };
  const dt: React.CSSProperties = { color: "#9ca3af", minWidth: 72, flexShrink: 0 };
  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px", fontSize: 12, fontWeight: active ? 700 : 500, borderRadius: 20, cursor: "pointer",
    border: "1px solid", borderColor: active ? "#2563eb" : "#e5e7eb",
    background: active ? "#eff6ff" : "#fff", color: active ? "#2563eb" : "#6b7280",
  });

  const sections: Array<{ key: typeof activeSection; label: string }> = [
    { key: "info", label: "기본 정보" },
    { key: "settlement", label: "견적/결제/정산" },
    { key: "translator", label: "번역사" },
    { key: "company", label: "거래처/담당자" },
    { key: "comms", label: "커뮤니케이션" },
    { key: "notes", label: "메모" },
    { key: "log", label: "이벤트 로그" },
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      zIndex: 300, overflowY: "auto", padding: "20px 16px",
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb",
        width: "100%", maxWidth: 780, padding: "24px 28px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: "0 0 2px", fontSize: 18, fontWeight: 800, color: "#111827" }}>
              프로젝트 #{projectId} 상세
            </h2>
            {detail && <StatusBadge status={detail.status} />}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
        ) : err ? (
          <p style={{ color: "#dc2626", padding: "16px 0" }}>{err}</p>
        ) : detail && (
          <>
            {/* 액션 바 */}
            <div style={{ background: "#f9fafb", borderRadius: 10, padding: "10px 12px", marginBottom: 14, border: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {/* 상태 변경 */}
                {(PROJECT_STATUS_TRANSITIONS[detail.status] ?? []).length > 0 && (
                  <>
                    <select value={statusTarget} onChange={e => setStatusTarget(e.target.value)}
                      style={{ ...inputStyle, width: "auto", padding: "6px 10px", fontSize: 12 }}>
                      <option value={detail.status}>{STATUS_LABEL[detail.status] ?? detail.status} (현재)</option>
                      {(PROJECT_STATUS_TRANSITIONS[detail.status] ?? []).map(s => (
                        <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                      ))}
                    </select>
                    <GhostBtn onClick={handleStatusChange} disabled={changingStatus || statusTarget === detail.status} color="#2563eb" style={{ fontSize: 12, padding: "6px 12px" }}>
                      {changingStatus ? "변경 중..." : "상태 변경 적용"}
                    </GhostBtn>
                    <span style={{ color: "#d1d5db", fontSize: 14 }}>|</span>
                  </>
                )}
                {/* 번역사 추천 — 배정이 필요한 상태일 때만 */}
                {["paid", "matched", "in_progress"].includes(detail.status) && (
                  <GhostBtn onClick={loadCandidates} disabled={loadingCandidates} color="#7c3aed" style={{ fontSize: 12, padding: "6px 12px" }}>
                    {loadingCandidates ? "조회 중..." : "번역사 추천"}
                  </GhostBtn>
                )}
                {/* 프로젝트 취소 */}
                {!["cancelled", "completed"].includes(detail.status) && (
                  <GhostBtn onClick={handleCancel} disabled={cancelling} color="#dc2626" style={{ fontSize: 12, padding: "6px 12px", marginLeft: "auto" }}>
                    {cancelling ? "취소 중..." : "프로젝트 취소"}
                  </GhostBtn>
                )}
              </div>
            </div>

            {/* 번역사 추천 후보 */}
            {showCandidates && (
              <div style={{ marginBottom: 14, padding: "12px 14px", background: "#faf5ff", borderRadius: 10, border: "1px solid #e9d5ff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>추천 번역사 (상위 3명)</p>
                  <button onClick={() => setShowCandidates(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 }}>×</button>
                </div>
                {loadingCandidates ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center" }}>조회 중...</p>
                ) : candidates.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13 }}>조건에 맞는 번역사가 없습니다.</p>
                ) : candidates.map((c, i) => {
                  const av = AVAIL_STYLE[c.profile?.availabilityStatus ?? ""] ?? AVAIL_STYLE.unavailable;
                  return (
                    <div key={c.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 10px", background: "#fff", borderRadius: 8, marginBottom: 6, border: "1px solid #e9d5ff" }}>
                      <span style={{ fontWeight: 700, color: "#7c3aed", fontSize: 16, minWidth: 24 }}>#{i + 1}</span>
                      <div style={{ flex: 1 }}>
                        <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: "#111827" }}>{c.email}</p>
                        <p style={{ margin: 0, fontSize: 11, color: "#6b7280" }}>
                          {c.profile?.languagePairs ?? "언어쌍 미설정"} · {c.profile?.specializations ?? "분야 미설정"}
                          {c.profile?.rating != null && ` · ⭐ ${c.profile.rating.toFixed(1)}`}
                        </p>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 600, color: av.color, minWidth: 32 }}>{av.label}</span>
                      <span style={{ fontSize: 11, color: "#6b7280" }}>점수 {c.score}</span>
                      <PrimaryBtn
                        onClick={() => handleAssignTranslator(c.id)}
                        disabled={assigning === c.id}
                        style={{ fontSize: 12, padding: "5px 12px" }}>
                        {assigning === c.id ? "배정 중..." : "배정"}
                      </PrimaryBtn>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 탭 내비 */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {sections.map(s => (
                <button key={s.key} onClick={() => setActiveSection(s.key)} style={tabBtnStyle(activeSection === s.key)}>
                  {s.label}
                </button>
              ))}
            </div>

            {/* 기본 정보 */}
            {activeSection === "info" && (
              <>
                {!editingInfo ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
                      <div style={dl}><span style={dt}>제목</span><strong style={{ color: "#111827", fontSize: 14 }}>{detail.title}</strong></div>
                      <div style={dl}><span style={dt}>고객</span><span style={{ color: "#374151" }}>{detail.customerEmail ?? "-"}</span></div>
                      <div style={dl}><span style={dt}>상태</span><StatusBadge status={detail.status} /></div>
                      <div style={dl}><span style={dt}>등록일</span><span style={{ color: "#374151" }}>{new Date(detail.createdAt).toLocaleString("ko-KR")}</span></div>
                      <div style={dl}><span style={dt}>거래처</span><span style={{ color: "#374151" }}>{detail.company?.name ?? (detail as any).companyName ?? "미연결"}</span></div>
                      <div style={dl}><span style={dt}>담당자</span><span style={{ color: "#374151" }}>{detail.contact?.name ?? (detail as any).contactName ?? "미연결"}</span></div>
                      {detail.fileUrl && (
                        <div style={{ ...dl, gridColumn: "span 2" }}>
                          <span style={dt}>첨부파일</span>
                          <a href={detail.fileUrl} target="_blank" rel="noreferrer" style={{ color: "#2563eb", fontSize: 13 }}>📎 다운로드</a>
                        </div>
                      )}
                    </div>
                    <div style={{ marginTop: 14 }}>
                      <GhostBtn onClick={startEditInfo} disabled={loadingMeta} color="#6b7280" style={{ fontSize: 12, padding: "5px 12px" }}>
                        {loadingMeta ? "불러오는 중..." : "✏️ 기본정보 수정"}
                      </GhostBtn>
                    </div>
                  </>
                ) : (
                  <div style={{ background: "#f0f9ff", borderRadius: 10, padding: "14px 16px", border: "1px solid #bae6fd" }}>
                    <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 700, color: "#0369a1" }}>기본정보 수정</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>제목 *</label>
                        <input value={editTitle} onChange={e => setEditTitle(e.target.value)}
                          style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} placeholder="프로젝트 제목" />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                          <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>거래처</label>
                          <select value={editCompanyId ?? ""} onChange={e => { setEditCompanyId(e.target.value ? Number(e.target.value) : null); setEditContactId(null); }}
                            style={{ ...inputStyle, width: "100%" }}>
                            <option value="">미연결</option>
                            {companiesList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 4 }}>담당자</label>
                          <select value={editContactId ?? ""} onChange={e => setEditContactId(e.target.value ? Number(e.target.value) : null)}
                            style={{ ...inputStyle, width: "100%" }}>
                            <option value="">미연결</option>
                            {contactsList
                              .filter(c => !editCompanyId || c.companyId === editCompanyId)
                              .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <PrimaryBtn onClick={handleSaveInfo} disabled={savingInfo || !editTitle.trim()} style={{ fontSize: 12, padding: "6px 16px" }}>
                        {savingInfo ? "저장 중..." : "저장"}
                      </PrimaryBtn>
                      <GhostBtn onClick={() => setEditingInfo(false)} style={{ fontSize: 12, padding: "6px 12px" }}>취소</GhostBtn>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 거래처 / 담당자 */}
            {activeSection === "company" && (
              <>
                <p style={sectionHd}>거래처 정보</p>
                {detail.company ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px", padding: "12px", background: "#f9fafb", borderRadius: 8, marginBottom: 12 }}>
                    <div style={dl}><span style={dt}>회사명</span><strong>{detail.company.name}</strong></div>
                    <div style={dl}><span style={dt}>업종</span><span>{detail.company.industry ?? "-"}</span></div>
                    <div style={dl}><span style={dt}>대표자</span><span>{detail.company.representativeName ?? "-"}</span></div>
                    <div style={dl}><span style={dt}>이메일</span><span>{detail.company.email ?? "-"}</span></div>
                    <div style={dl}><span style={dt}>전화</span><span>{detail.company.phone ?? "-"}</span></div>
                  </div>
                ) : (
                  <p style={{ color: "#9ca3af", fontSize: 13, padding: "8px 0" }}>연결된 거래처가 없습니다.</p>
                )}

                <p style={sectionHd}>담당자 정보</p>
                {detail.contact ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px", padding: "12px", background: "#f9fafb", borderRadius: 8 }}>
                    <div style={dl}><span style={dt}>이름</span><strong>{detail.contact.name}</strong></div>
                    <div style={dl}><span style={dt}>부서</span><span>{detail.contact.department ?? "-"}</span></div>
                    <div style={dl}><span style={dt}>직책</span><span>{detail.contact.position ?? "-"}</span></div>
                    <div style={dl}><span style={dt}>이메일</span><span>{detail.contact.email ?? "-"}</span></div>
                    <div style={dl}><span style={dt}>전화</span><span>{detail.contact.phone ?? "-"}</span></div>
                  </div>
                ) : (
                  <p style={{ color: "#9ca3af", fontSize: 13, padding: "8px 0" }}>연결된 담당자가 없습니다.</p>
                )}
              </>
            )}

            {/* 번역사 정보 */}
            {activeSection === "translator" && (
              <>
                {detail.tasks.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "24px 0", color: "#9ca3af" }}>
                    <p style={{ margin: 0 }}>배정된 번역사가 없습니다.</p>
                    <p style={{ margin: "6px 0 0", fontSize: 12 }}>위 「번역사 추천」 버튼으로 후보를 확인하고 배정하세요.</p>
                  </div>
                ) : detail.tasks.map(t => {
                  const avStyle = AVAIL_STYLE[t.translatorProfile?.availabilityStatus ?? ""] ?? AVAIL_STYLE.unavailable;
                  return (
                    <div key={t.id} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{t.translatorEmail ?? `#${t.translatorId}`}</span>
                        <StatusBadge status={t.status} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: avStyle.color }}>가용: {avStyle.label}</span>
                        <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: "auto" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                      {t.translatorProfile && (
                        <div style={{ padding: "10px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px" }}>
                          <div style={dl}><span style={dt}>언어쌍</span><span>{t.translatorProfile.languagePairs ?? "-"}</span></div>
                          <div style={dl}><span style={dt}>전문분야</span><span>{t.translatorProfile.specializations ?? "-"}</span></div>
                          {t.translatorProfile.rating != null && (
                            <div style={dl}><span style={dt}>평점</span><span style={{ color: "#d97706", fontWeight: 600 }}>⭐ {t.translatorProfile.rating.toFixed(1)}</span></div>
                          )}
                          {t.translatorProfile.bio && (
                            <div style={{ ...dl, gridColumn: "span 2" }}><span style={dt}>소개</span><span style={{ color: "#374151" }}>{t.translatorProfile.bio}</span></div>
                          )}
                        </div>
                      )}
                      {t.translatorRates.length > 0 && (
                        <>
                          <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" }}>단가표</p>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {t.translatorRates.map(r => (
                              <div key={r.id} style={{ display: "flex", gap: 10, fontSize: 12, padding: "5px 10px", background: "#f9fafb", borderRadius: 6 }}>
                                <span style={{ color: "#374151", fontWeight: 600 }}>{r.serviceType}</span>
                                <span style={{ color: "#6b7280" }}>{r.languagePair}</span>
                                <span style={{ color: "#059669", fontWeight: 600, marginLeft: "auto" }}>{Number(r.rate).toLocaleString()}원/{r.unit === "word" ? "단어" : r.unit === "page" ? "페이지" : "시간"}</span>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            {/* 견적/결제/정산 */}
            {activeSection === "settlement" && (
              <>
                {/* 문서 출력 */}
                <div style={{ background: "#f8fafc", borderRadius: 10, padding: "12px 14px", marginBottom: 16, border: "1px solid #e2e8f0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginRight: 4 }}>문서 출력</span>
                  <button
                    onClick={() => {
                      const url = api(`/api/admin/projects/${projectId}/pdf/quote?token=${encodeURIComponent(token)}`);
                      window.open(url, "_blank", "noopener");
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 5, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    🖨 견적서 PDF
                  </button>
                  <button
                    onClick={() => {
                      const url = api(`/api/admin/projects/${projectId}/pdf/statement?token=${encodeURIComponent(token)}`);
                      window.open(url, "_blank", "noopener");
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 5, background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                    🖨 거래명세서 PDF
                  </button>
                  <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 4 }}>새 창에서 열린 후 Ctrl+P 또는 인쇄 버튼으로 PDF 저장</span>
                </div>

                {/* 견적 섹션 */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <p style={sectionHd}>견적 ({detail.quotes.length})</p>
                </div>
                {detail.status === "created" && detail.quotes.length === 0 && (
                  <div style={{ background: "#fdf4ff", borderRadius: 10, padding: "12px 14px", marginBottom: 12, border: "1px solid #e9d5ff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>견적 생성</p>
                      <div style={{ display: "flex", gap: 0, borderRadius: 6, overflow: "hidden", border: "1px solid #d8b4fe" }}>
                        {(["simple", "items"] as const).map(m => (
                          <button key={m} onClick={() => setQuoteMode(m)}
                            style={{ padding: "4px 10px", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
                              background: quoteMode === m ? "#7c3aed" : "#fdf4ff", color: quoteMode === m ? "#fff" : "#7c3aed" }}>
                            {m === "simple" ? "단순 금액" : "품목 입력"}
                          </button>
                        ))}
                      </div>
                    </div>

                    {quoteMode === "simple" ? (
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="number" min="0" value={quoteAmount}
                          onChange={e => setQuoteAmount(e.target.value)}
                          placeholder="견적 금액 (원)"
                          style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
                          onKeyDown={e => e.key === "Enter" && handleCreateQuote()} />
                        <PrimaryBtn onClick={handleCreateQuote} disabled={creatingQuote || !quoteAmount}
                          style={{ fontSize: 12, padding: "7px 14px", background: "#7c3aed", border: "none" }}>
                          {creatingQuote ? "생성 중..." : "견적 생성"}
                        </PrimaryBtn>
                      </div>
                    ) : (
                      <div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 48px 64px 88px 72px 28px", gap: 4, marginBottom: 4 }}>
                          {["품목명", "단위", "수량", "단가(원)", "부가세", ""].map(h => (
                            <div key={h} style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", padding: "0 2px" }}>{h}</div>
                          ))}
                        </div>
                        {quoteItemForms.map((it, idx) => {
                          const { supply, tax, total } = calcItemTotal(it);
                          return (
                            <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 48px 64px 88px 72px 28px", gap: 4, marginBottom: 4, alignItems: "center" }}>
                              <input value={it.productName} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, productName: e.target.value } : p))}
                                placeholder="예: 영→한 번역" style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }} />
                              <input value={it.unit} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, unit: e.target.value } : p))}
                                placeholder="건" style={{ ...inputStyle, fontSize: 12, padding: "6px 6px", textAlign: "center" }} />
                              <input type="number" value={it.quantity} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, quantity: e.target.value } : p))}
                                min="0" style={{ ...inputStyle, fontSize: 12, padding: "6px 6px", textAlign: "right" }} />
                              <input type="number" value={it.unitPrice} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, unitPrice: e.target.value } : p))}
                                placeholder="0" min="0" style={{ ...inputStyle, fontSize: 12, padding: "6px 6px", textAlign: "right" }} />
                              <select value={it.taxRate} onChange={e => setQuoteItemForms(prev => prev.map((p, i) => i === idx ? { ...p, taxRate: e.target.value as "0"|"0.1" } : p))}
                                style={{ ...inputStyle, fontSize: 11, padding: "6px 4px" }}>
                                <option value="0">면세</option>
                                <option value="0.1">10%</option>
                              </select>
                              <button onClick={() => setQuoteItemForms(prev => prev.filter((_, i) => i !== idx))} disabled={quoteItemForms.length <= 1}
                                style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                              {(supply > 0 || tax > 0) && (
                                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, fontSize: 11, color: "#6b7280", paddingLeft: 4, paddingBottom: 2 }}>
                                  <span>공급가액 {supply.toLocaleString()}원</span>
                                  {tax > 0 && <span>세액 {tax.toLocaleString()}원</span>}
                                  <span style={{ fontWeight: 700, color: "#7c3aed" }}>합계 {total.toLocaleString()}원</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                          <button onClick={() => setQuoteItemForms(prev => [...prev, defaultItem()])}
                            style={{ fontSize: 12, color: "#7c3aed", background: "none", border: "1px dashed #d8b4fe", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>
                            + 품목 추가
                          </button>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            {quoteItemsGrandTotal > 0 && (
                              <span style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>
                                합계: {quoteItemsGrandTotal.toLocaleString()}원
                              </span>
                            )}
                            <PrimaryBtn onClick={handleCreateQuote} disabled={creatingQuote}
                              style={{ fontSize: 12, padding: "7px 14px", background: "#7c3aed", border: "none" }}>
                              {creatingQuote ? "생성 중..." : "견적 생성"}
                            </PrimaryBtn>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {detail.quotes.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, paddingBottom: 8 }}>등록된 견적이 없습니다.</p>
                ) : detail.quotes.map(q => (
                  <div key={q.id} style={{ display: "flex", gap: 14, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 13, alignItems: "center" }}>
                    <span style={{ color: "#9ca3af" }}>#{q.id}</span>
                    <span style={{ fontWeight: 700, color: "#0891b2" }}>{Number(q.amount).toLocaleString()}원</span>
                    <StatusBadge status={q.status} />
                    <span style={{ color: "#9ca3af", marginLeft: "auto" }}>{new Date(q.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}

                {/* 결제 섹션 */}
                <p style={{ ...sectionHd, marginTop: 10 }}>결제 ({detail.payments.length})</p>
                {detail.status === "approved" && detail.payments.filter((pm: any) => pm.status === "paid").length === 0 && (
                  <div style={{ background: "#f0fdf4", borderRadius: 10, padding: "12px 14px", marginBottom: 12, border: "1px solid #bbf7d0" }}>
                    <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#059669" }}>결제 확인 등록</p>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="number" min="0" value={paymentAmount}
                        onChange={e => setPaymentAmount(e.target.value)}
                        placeholder="결제 금액 (원)"
                        style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
                        onKeyDown={e => e.key === "Enter" && handleCreatePayment()}
                      />
                      <PrimaryBtn onClick={handleCreatePayment} disabled={creatingPayment || !paymentAmount}
                        style={{ fontSize: 12, padding: "7px 14px", background: "#059669", border: "none" }}>
                        {creatingPayment ? "처리 중..." : "결제 확인"}
                      </PrimaryBtn>
                    </div>
                    {detail.quotes.length > 0 && (
                      <p style={{ margin: "6px 0 0", fontSize: 11, color: "#6b7280" }}>
                        견적 금액: {Number(detail.quotes[0].amount).toLocaleString()}원
                      </p>
                    )}
                  </div>
                )}
                {detail.payments.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, paddingBottom: 8 }}>등록된 결제가 없습니다.</p>
                ) : detail.payments.map((pm: any) => (
                  <div key={pm.id} style={{ display: "flex", gap: 14, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 13, alignItems: "center" }}>
                    <span style={{ color: "#9ca3af" }}>#{pm.id}</span>
                    <span style={{ fontWeight: 700, color: "#0891b2" }}>{Number(pm.amount).toLocaleString()}원</span>
                    <StatusBadge status={pm.status} />
                    <span style={{ color: "#9ca3af", marginLeft: "auto" }}>{new Date(pm.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}

                {/* 정산 섹션 */}
                <p style={{ ...sectionHd, marginTop: 10 }}>정산 ({detail.settlements.length})</p>
                {detail.settlements.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13 }}>등록된 정산이 없습니다.</p>
                ) : detail.settlements.map((s: any) => (
                  <div key={s.id} style={{ display: "flex", gap: 14, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, marginBottom: 6, fontSize: 13, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ color: "#9ca3af" }}>#{s.id}</span>
                    <span style={{ color: "#0891b2", fontWeight: 600 }}>총 {Number(s.totalAmount).toLocaleString()}원</span>
                    <span style={{ color: "#059669", fontWeight: 600 }}>번역사 {Number(s.translatorAmount).toLocaleString()}원</span>
                    <StatusBadge status={s.status} />
                  </div>
                ))}
              </>
            )}

            {/* 커뮤니케이션 */}
            {activeSection === "comms" && (
              <>
                {detail.projectCustomerId ? (
                  <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                    <select value={commType} onChange={e => setCommType(e.target.value as "email"|"phone"|"message")}
                      style={{ ...inputStyle, width: "auto", padding: "7px 10px", fontSize: 13 }}>
                      <option value="message">메시지</option>
                      <option value="email">이메일</option>
                      <option value="phone">전화</option>
                    </select>
                    <input
                      value={commContent} onChange={e => setCommContent(e.target.value)}
                      placeholder="내용 입력..."
                      style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "8px 10px", minWidth: 180 }}
                      onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleAddComm()}
                    />
                    <PrimaryBtn onClick={handleAddComm} disabled={addingComm || !commContent.trim()} style={{ padding: "8px 16px", fontSize: 13 }}>
                      {addingComm ? "추가 중..." : "기록 추가"}
                    </PrimaryBtn>
                  </div>
                ) : (
                  <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 8 }}>고객이 연결된 프로젝트에서만 커뮤니케이션 기록을 추가할 수 있습니다.</p>
                )}
                {(detail.communications ?? []).length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "16px 0" }}>커뮤니케이션 기록이 없습니다.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                    {(detail.communications ?? []).map(c => (
                      <div key={c.id} style={{ padding: "9px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, alignItems: "center" }}>
                          <span style={{
                            padding: "2px 9px", borderRadius: 12, fontSize: 11, fontWeight: 700,
                            background: `${COMM_TYPE_COLOR[c.type]}18`, color: COMM_TYPE_COLOR[c.type],
                          }}>{COMM_TYPE_LABEL[c.type]}</span>
                          <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(c.createdAt).toLocaleString("ko-KR")}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{c.content}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* 메모 */}
            {activeSection === "notes" && (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
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
                {(detail.notes ?? []).length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "16px 0" }}>메모가 없습니다.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                    {(detail.notes ?? []).map(n => (
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

            {/* 이벤트 로그 */}
            {activeSection === "log" && (
              <>
                {detail.logs.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "16px 0" }}>이벤트 로그가 없습니다.</p>
                ) : (
                  <div style={{ maxHeight: 380, overflowY: "auto", padding: "4px 0" }}>
                    {[...detail.logs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((log, idx, arr) => {
                      const info = getActionLabel(log.action);
                      const isLast = idx === arr.length - 1;
                      return (
                        <div key={log.id} style={{ display: "flex", gap: 0, position: "relative" }}>
                          {/* 세로선 + 아이콘 */}
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 36, flexShrink: 0 }}>
                            <div style={{
                              width: 28, height: 28, borderRadius: "50%",
                              background: info.color + "18", border: `2px solid ${info.color}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 13, zIndex: 1, flexShrink: 0,
                            }}>{info.dot}</div>
                            {!isLast && <div style={{ width: 2, flex: 1, minHeight: 18, background: "#e5e7eb" }} />}
                          </div>
                          {/* 내용 */}
                          <div style={{ flex: 1, paddingLeft: 10, paddingBottom: isLast ? 0 : 14, paddingTop: 3 }}>
                            <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: info.color }}>{info.ko}</p>
                            <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>
                              {new Date(log.createdAt).toLocaleString("ko-KR")}
                              {log.entityType && log.entityType !== "project" && (
                                <span style={{ marginLeft: 6, background: "#f3f4f6", borderRadius: 4, padding: "1px 6px", color: "#6b7280" }}>{log.entityType}</span>
                              )}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AdminDashboard({ user, token }: { user: User; token: string }) {
  const [adminTab, setAdminTab] = useState<"projects"|"payments"|"tasks"|"settlements"|"users"|"customers"|"companies"|"contacts"|"products"|"board"|"translators"|"test">("projects");
  const [projects, setProjects] = useState<AdminProject[]>([]);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [settlements, setSettlements] = useState<AdminSettlement[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);
  const [customersLoading, setCustomersLoading] = useState(false);

  // project filters + pagination
  const PROJECT_PAGE_SIZE = 20;
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [projectSearch, setProjectSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [assignedAdminFilter, setAssignedAdminFilter] = useState<string>("all");
  const [projectPage, setProjectPage] = useState(1);

  // other filters
  const [paymentFilter, setPaymentFilter] = useState<string>("all");
  const [settlementFilter, setSettlementFilter] = useState<string>("all");

  // customer management
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerModal, setCustomerModal] = useState<number | null>(null);
  const [showCreateCustomer, setShowCreateCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ companyName: "", contactName: "", email: "", phone: "" });
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  // user management
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<string>("all");
  const [roleChanging, setRoleChanging] = useState<number | null>(null);
  const [toggling, setToggling] = useState<number | null>(null);
  const [resetPwUserId, setResetPwUserId] = useState<number | null>(null);
  const [resetPwInput, setResetPwInput] = useState("");
  const [resetPwLoading, setResetPwLoading] = useState(false);

  // companies / products / board state
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [companyModal, setCompanyModal] = useState<number | null>(null);
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [companyForm, setCompanyForm] = useState({ name: "", businessNumber: "", industry: "", address: "", website: "", notes: "" });
  const [savingCompany, setSavingCompany] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [showProductForm, setShowProductForm] = useState(false);
  const [productForm, setProductForm] = useState({ code: "", name: "", category: "", unit: "건", basePrice: "", languagePair: "", field: "" });
  const [editingProduct, setEditingProduct] = useState<number | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);

  const [boardPosts, setBoardPosts] = useState<BoardPost[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardCategory, setBoardCategory] = useState<string>("all");
  const [boardPostModal, setBoardPostModal] = useState<BoardPost | null>(null);
  const [showBoardForm, setShowBoardForm] = useState(false);
  const [boardForm, setBoardForm] = useState({ category: "notice", title: "", content: "", pinned: false, visibleToAll: false });
  const [savingBoard, setSavingBoard] = useState(false);

  // translator profile modal
  const [translatorProfileModal, setTranslatorProfileModal] = useState<{ userId: number; email: string } | null>(null);

  // contacts tab state
  const [contacts, setContacts] = useState<AdminContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [contactModal, setContactModal] = useState<number | null>(null);

  // translators tab state
  const [translatorList, setTranslatorList] = useState<TranslatorListItem[]>([]);
  const [translatorsLoading, setTranslatorsLoading] = useState(false);
  const [translatorSearch, setTranslatorSearch] = useState("");
  const [translatorLangFilter, setTranslatorLangFilter] = useState("");
  const [translatorStatusFilter, setTranslatorStatusFilter] = useState("all");
  const [translatorRatingFilter, setTranslatorRatingFilter] = useState("");
  const [translatorDetailModal, setTranslatorDetailModal] = useState<{ userId: number; email: string } | null>(null);

  // 운영 테스트 시나리오
  type ScenarioStep = { step: number; name: string; status: "ok"|"error"|"skipped"; detail: string; data?: Record<string, unknown> };
  type ScenarioResult = { projectId: number|null; startedAt: string; finishedAt: string; steps: ScenarioStep[]; summary: { total: number; ok: number; error: number; skipped: number } };
  const [scenarioRunning, setScenarioRunning] = useState(false);
  const [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null);
  const [scenarioAmount, setScenarioAmount] = useState("500000");
  const [scenarioRatio, setScenarioRatio] = useState("0.6");
  const [scenarioHistory, setScenarioHistory] = useState<Array<{ id: number; title: string; status: string; createdAt: string }>>([]);
  const [scenarioHistoryLoading, setScenarioHistoryLoading] = useState(false);
  // 실제 운영 데이터 셀렉터
  const [realData, setRealData] = useState<{ companies: {id:number;name:string}[]; contacts: {id:number;name:string;companyId:number|null}[]; translators: {id:number;email:string}[] } | null>(null);
  const [scenarioCompanyId, setScenarioCompanyId] = useState<string>("");
  const [scenarioContactId, setScenarioContactId] = useState<string>("");
  // UX 피드백
  const FEEDBACK_TAGS = [
    { value: "general", label: "일반", color: "#6b7280", bg: "#f3f4f6" },
    { value: "bug", label: "🐛 버그", color: "#991b1b", bg: "#fef2f2" },
    { value: "ux", label: "🎨 UX", color: "#1d4ed8", bg: "#eff6ff" },
    { value: "idea", label: "💡 아이디어", color: "#065f46", bg: "#f0fdf4" },
    { value: "urgent", label: "🔥 긴급", color: "#92400e", bg: "#fffbeb" },
  ] as const;
  type FeedbackTag = "general" | "bug" | "ux" | "idea" | "urgent";
  const [feedbackList, setFeedbackList] = useState<Array<{ id: number; content: string; tag: string | null; createdAt: string; adminEmail: string | null }>>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackInput, setFeedbackInput] = useState("");
  const [feedbackTag, setFeedbackTag] = useState<FeedbackTag>("general");
  const [feedbackTagFilter, setFeedbackTagFilter] = useState<string>("all");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);

  // 관리자 프로젝트 생성 모달
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newProjectCustomerId, setNewProjectCustomerId] = useState<number | null>(null);
  const [newProjectCompanyId, setNewProjectCompanyId] = useState<number | null>(null);
  const [newProjectContactId, setNewProjectContactId] = useState<number | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

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
      if (assignedAdminFilter !== "all") params.set("assignedAdminId", assignedAdminFilter);
      const pUrl = `/api/admin/projects${params.toString() ? "?" + params.toString() : ""}`;

      const [pRes, pmRes, tRes, sRes, auRes] = await Promise.all([
        fetch(api(pUrl), { headers: authHeaders }),
        fetch(api("/api/admin/payments"), { headers: authHeaders }),
        fetch(api("/api/admin/tasks"), { headers: authHeaders }),
        fetch(api("/api/admin/settlements"), { headers: authHeaders }),
        fetch(api("/api/admin/users?role=admin"), { headers: authHeaders }),
      ]);
      const [pData, pmData, tData, sData, auData] = await Promise.all([pRes.json(), pmRes.json(), tRes.json(), sRes.json(), auRes.json()]);
      if (pRes.ok) setProjects(Array.isArray(pData) ? pData : []);
      if (pmRes.ok) setPayments(Array.isArray(pmData) ? pmData : []);
      if (tRes.ok) setTasks(Array.isArray(tData) ? tData : []);
      if (sRes.ok) setSettlements(Array.isArray(sData) ? sData : []);
      if (auRes.ok) setAdminUsers(Array.isArray(auData) ? auData : []);
    } catch { setToast("오류: 데이터 불러오기 실패"); }
    finally { setLoading(false); }
  }, [token, projectSearch, projectFilter, dateFrom, dateTo, assignedAdminFilter]);

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

  const fetchCustomers = useCallback(async () => {
    setCustomersLoading(true);
    try {
      const params = new URLSearchParams();
      if (customerSearch.trim()) params.set("search", customerSearch.trim());
      const res = await fetch(api(`/api/admin/customers${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setCustomers(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 고객 조회 실패"); }
    finally { setCustomersLoading(false); }
  }, [token, customerSearch]);

  const handleCreateCustomer = async () => {
    if (!newCustomer.companyName.trim() || !newCustomer.contactName.trim() || !newCustomer.email.trim()) {
      setToast("회사명, 담당자명, 이메일은 필수입니다."); return;
    }
    setCreatingCustomer(true);
    try {
      const res = await fetch(api("/api/admin/customers"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(newCustomer),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("고객이 등록되었습니다.");
      setNewCustomer({ companyName: "", contactName: "", email: "", phone: "" });
      setShowCreateCustomer(false);
      await fetchCustomers();
    } catch { setToast("오류: 고객 등록 실패"); }
    finally { setCreatingCustomer(false); }
  };

  const fetchCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    try {
      const params = new URLSearchParams();
      if (companySearch.trim()) params.set("search", companySearch.trim());
      const res = await fetch(api(`/api/admin/companies${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setCompanies(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 거래처 조회 실패"); }
    finally { setCompaniesLoading(false); }
  }, [token, companySearch]);

  const fetchProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const params = new URLSearchParams();
      if (productSearch.trim()) params.set("search", productSearch.trim());
      const res = await fetch(api(`/api/admin/products${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setProducts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 상품 조회 실패"); }
    finally { setProductsLoading(false); }
  }, [token, productSearch]);

  const fetchBoard = useCallback(async () => {
    setBoardLoading(true);
    try {
      const params = new URLSearchParams();
      if (boardCategory !== "all") params.set("category", boardCategory);
      const res = await fetch(api(`/api/admin/board${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setBoardPosts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 게시판 조회 실패"); }
    finally { setBoardLoading(false); }
  }, [token, boardCategory]);

  const fetchContacts = useCallback(async () => {
    setContactsLoading(true);
    try {
      const params = new URLSearchParams();
      if (contactSearch.trim()) params.set("search", contactSearch.trim());
      const res = await fetch(api(`/api/admin/contacts${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setContacts(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 담당자 조회 실패"); }
    finally { setContactsLoading(false); }
  }, [token, contactSearch]);

  const fetchTranslators = useCallback(async () => {
    setTranslatorsLoading(true);
    try {
      const params = new URLSearchParams();
      if (translatorSearch.trim()) params.set("search", translatorSearch.trim());
      if (translatorLangFilter.trim()) params.set("languagePair", translatorLangFilter.trim());
      if (translatorStatusFilter !== "all") params.set("status", translatorStatusFilter);
      if (translatorRatingFilter.trim()) params.set("minRating", translatorRatingFilter.trim());
      const res = await fetch(api(`/api/admin/translators${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setTranslatorList(Array.isArray(data) ? data : []);
    } catch { setToast("오류: 번역사 조회 실패"); }
    finally { setTranslatorsLoading(false); }
  }, [token, translatorSearch, translatorLangFilter, translatorStatusFilter, translatorRatingFilter]);

  const handleCreateCompany = async () => {
    if (!companyForm.name.trim()) { setToast("회사명을 입력하세요."); return; }
    setSavingCompany(true);
    try {
      const res = await fetch(api("/api/admin/companies"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(companyForm),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("거래처가 등록되었습니다.");
      setCompanyForm({ name: "", businessNumber: "", industry: "", address: "", website: "", notes: "" });
      setShowCompanyForm(false);
      await fetchCompanies();
    } catch { setToast("오류: 거래처 등록 실패"); }
    finally { setSavingCompany(false); }
  };

  const handleSaveProduct = async () => {
    if (!productForm.code.trim() || !productForm.name.trim() || !productForm.basePrice) {
      setToast("코드, 상품명, 기본단가는 필수입니다."); return;
    }
    setSavingProduct(true);
    try {
      const payload = { ...productForm, basePrice: Number(productForm.basePrice) };
      const url = editingProduct ? `/api/admin/products/${editingProduct}` : "/api/admin/products";
      const method = editingProduct ? "PATCH" : "POST";
      const res = await fetch(api(url), {
        method, headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(editingProduct ? "상품이 수정되었습니다." : "상품이 등록되었습니다.");
      setProductForm({ code: "", name: "", category: "", unit: "건", basePrice: "", languagePair: "", field: "" });
      setEditingProduct(null);
      setShowProductForm(false);
      await fetchProducts();
    } catch { setToast("오류: 상품 저장 실패"); }
    finally { setSavingProduct(false); }
  };

  const handleToggleProduct = async (id: number) => {
    try {
      const res = await fetch(api(`/api/admin/products/${id}/toggle`), { method: "PATCH", headers: authHeaders });
      if (!res.ok) { setToast("오류: 상태 변경 실패"); return; }
      await fetchProducts();
    } catch { setToast("오류: 상태 변경 실패"); }
  };

  const handleSaveBoardPost = async () => {
    if (!boardForm.title.trim() || !boardForm.content.trim()) { setToast("제목과 내용을 입력하세요."); return; }
    setSavingBoard(true);
    try {
      const res = await fetch(api("/api/admin/board"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(boardForm),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("게시물이 등록되었습니다.");
      setBoardForm({ category: "notice", title: "", content: "", pinned: false, visibleToAll: false });
      setShowBoardForm(false);
      await fetchBoard();
    } catch { setToast("오류: 게시물 등록 실패"); }
    finally { setSavingBoard(false); }
  };

  const handleDeleteBoardPost = async (id: number) => {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    try {
      const res = await fetch(api(`/api/admin/board/${id}`), { method: "DELETE", headers: authHeaders });
      if (!res.ok) { setToast("오류: 삭제 실패"); return; }
      setToast("게시물이 삭제되었습니다.");
      setBoardPostModal(null);
      await fetchBoard();
    } catch { setToast("오류: 삭제 실패"); }
  };

  const handleExportCSV = async (type: "projects" | "settlements") => {
    try {
      const res = await fetch(api(`/api/admin/export/${type}`), { headers: authHeaders });
      if (!res.ok) { setToast("오류: CSV 내보내기 실패"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${type}_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch { setToast("오류: CSV 내보내기 실패"); }
  };

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => { if (adminTab === "users") fetchUsers(); }, [adminTab, fetchUsers]);
  useEffect(() => { if (adminTab === "customers") fetchCustomers(); }, [adminTab, fetchCustomers]);
  useEffect(() => { if (adminTab === "companies") fetchCompanies(); }, [adminTab, fetchCompanies]);
  useEffect(() => { if (adminTab === "contacts") fetchContacts(); }, [adminTab, fetchContacts]);
  useEffect(() => { if (adminTab === "products") fetchProducts(); }, [adminTab, fetchProducts]);
  useEffect(() => { if (adminTab === "board") fetchBoard(); }, [adminTab, fetchBoard]);
  useEffect(() => { if (adminTab === "translators") fetchTranslators(); }, [adminTab, fetchTranslators]);

  const fetchScenarioHistory = async () => {
    setScenarioHistoryLoading(true);
    try {
      const res = await fetch(api("/api/admin/test/scenarios"), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setScenarioHistory(await res.json());
    } catch { /* ignore */ }
    finally { setScenarioHistoryLoading(false); }
  };
  const fetchFeedback = async () => {
    setFeedbackLoading(true);
    try {
      const res = await fetch(api("/api/admin/feedback"), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setFeedbackList(await res.json());
    } catch { /* ignore */ }
    finally { setFeedbackLoading(false); }
  };
  const fetchRealData = async () => {
    try {
      const res = await fetch(api("/api/admin/test/real-data"), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setRealData(await res.json());
    } catch { /* ignore */ }
  };
  useEffect(() => {
    if (adminTab === "test") { fetchScenarioHistory(); fetchFeedback(); fetchRealData(); }
  }, [adminTab]);

  const runScenario = async () => {
    if (scenarioRunning) return;
    setScenarioRunning(true);
    setScenarioResult(null);
    try {
      const body: Record<string, unknown> = {
        quoteAmount: Number(scenarioAmount) || 500000,
        translatorRatio: Number(scenarioRatio) || 0.6,
      };
      if (scenarioCompanyId) body.companyId = Number(scenarioCompanyId);
      if (scenarioContactId) body.contactId = Number(scenarioContactId);
      const res = await fetch(api("/api/admin/test/run-scenario"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setScenarioResult(data);
      fetchScenarioHistory();
    } catch { setToast("시나리오 실행 오류"); }
    finally { setScenarioRunning(false); }
  };

  const submitFeedback = async () => {
    if (!feedbackInput.trim() || feedbackSubmitting) return;
    setFeedbackSubmitting(true);
    try {
      const res = await fetch(api("/api/admin/feedback"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: feedbackInput.trim(), tag: feedbackTag }),
      });
      if (res.ok) { setFeedbackInput(""); fetchFeedback(); setToast("피드백이 저장되었습니다."); }
      else { const d = await res.json(); setToast(`오류: ${d.error}`); }
    } catch { setToast("피드백 저장 실패"); }
    finally { setFeedbackSubmitting(false); }
  };

  const deleteFeedback = async (id: number) => {
    try {
      await fetch(api(`/api/admin/feedback/${id}`), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      setFeedbackList(prev => prev.filter(f => f.id !== id));
    } catch { setToast("삭제 실패"); }
  };

  const handleCreateAdminProject = async () => {
    if (!newProjectTitle.trim()) { setToast("프로젝트 제목을 입력하세요."); return; }
    setCreatingProject(true);
    try {
      const res = await fetch(api("/api/admin/projects"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newProjectTitle.trim(),
          customerId: newProjectCustomerId ?? undefined,
          companyId: newProjectCompanyId ?? undefined,
          contactId: newProjectContactId ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(`프로젝트 #${data.id} 생성 완료`);
      setShowCreateProject(false);
      setNewProjectTitle(""); setNewProjectCustomerId(null); setNewProjectCompanyId(null); setNewProjectContactId(null);
      await fetchAll();
      setDetailModal(data.id);
    } catch { setToast("오류: 프로젝트 생성 실패"); }
    finally { setCreatingProject(false); }
  };

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

  const handleResetPassword = async () => {
    if (!resetPwUserId || !resetPwInput.trim() || resetPwInput.length < 6) {
      setToast("오류: 새 비밀번호는 최소 6자 이상이어야 합니다."); return;
    }
    setResetPwLoading(true);
    try {
      const res = await fetch(api(`/api/admin/users/${resetPwUserId}/reset-password`), {
        method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: resetPwInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast("비밀번호가 재설정되었습니다.");
      setResetPwUserId(null); setResetPwInput("");
    } catch { setToast("오류: 비밀번호 재설정 실패"); }
    finally { setResetPwLoading(false); }
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
    { id: "customers", label: "고객 관리" },
    { id: "companies", label: "거래처" },
    { id: "contacts", label: "담당자" },
    { id: "products", label: "상품/단가" },
    { id: "board", label: "게시판" },
    { id: "translators", label: "번역사" },
    { id: "test", label: "🧪 운영 테스트" },
  ] as const;

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />
      {companyModal !== null && (
        <CompanyDetailModal
          companyId={companyModal}
          token={token}
          onClose={() => setCompanyModal(null)}
          onToast={setToast}
          onOpenProject={(id) => { setCompanyModal(null); setDetailModal(id); }}
        />
      )}
      {contactModal !== null && (
        <ContactDetailModal
          contactId={contactModal}
          token={token}
          onClose={() => setContactModal(null)}
          onToast={setToast}
          onOpenProject={(id) => { setContactModal(null); setDetailModal(id); }}
        />
      )}
      {translatorDetailModal !== null && (
        <TranslatorDetailModal
          userId={translatorDetailModal.userId}
          userEmail={translatorDetailModal.email}
          token={token}
          onClose={() => setTranslatorDetailModal(null)}
          onToast={setToast}
        />
      )}
      {translatorProfileModal !== null && (
        <TranslatorProfileModal
          userId={translatorProfileModal.userId}
          userEmail={translatorProfileModal.email}
          token={token}
          onClose={() => setTranslatorProfileModal(null)}
          onToast={setToast}
        />
      )}
      {boardPostModal !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
          <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", width: "100%", maxWidth: 680, padding: "24px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  {boardPostModal.pinned && <span style={{ background: "#fef3c7", color: "#d97706", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>📌 고정</span>}
                  <span style={{ background: "#eff6ff", color: "#2563eb", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>{BOARD_CATEGORY_LABEL[boardPostModal.category] ?? boardPostModal.category}</span>
                  {boardPostModal.visibleToAll && <span style={{ background: "#f0fdf4", color: "#059669", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 }}>공개</span>}
                </div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>{boardPostModal.title}</h2>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "#9ca3af" }}>{boardPostModal.authorEmail} · {new Date(boardPostModal.createdAt).toLocaleDateString("ko-KR")}</p>
              </div>
              <button onClick={() => setBoardPostModal(null)} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af" }}>×</button>
            </div>
            <div style={{ background: "#f9fafb", borderRadius: 10, padding: "16px 18px", fontSize: 14, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap", marginBottom: 16, border: "1px solid #e5e7eb" }}>
              {boardPostModal.content ?? "내용 없음"}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={() => handleDeleteBoardPost(boardPostModal.id)} style={{ background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>삭제</button>
            </div>
          </div>
        </div>
      )}
      {resetPwUserId !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400 }}>
          <div style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 400, padding: "28px 32px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#111827" }}>비밀번호 재설정</h3>
            <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280" }}>
              사용자 #{resetPwUserId}의 비밀번호를 재설정합니다.
            </p>
            <input
              type="password"
              value={resetPwInput}
              onChange={e => setResetPwInput(e.target.value)}
              placeholder="새 비밀번호 (최소 6자)"
              onKeyDown={e => e.key === "Enter" && handleResetPassword()}
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 14 }}
              autoFocus
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <GhostBtn onClick={() => { setResetPwUserId(null); setResetPwInput(""); }}>취소</GhostBtn>
              <PrimaryBtn onClick={handleResetPassword} disabled={resetPwLoading || resetPwInput.length < 6} style={{ padding: "8px 18px" }}>
                {resetPwLoading ? "처리 중..." : "재설정"}
              </PrimaryBtn>
            </div>
          </div>
        </div>
      )}
      {detailModal !== null && (
        <ProjectDetailModal
          projectId={detailModal} token={token}
          onClose={() => setDetailModal(null)}
          onRefresh={fetchAll}
          onToast={setToast}
          adminList={adminUsers}
        />
      )}
      {customerModal !== null && (
        <CustomerDetailModal
          customerId={customerModal} token={token}
          onClose={() => setCustomerModal(null)}
          onToast={setToast}
          onOpenProject={(id) => { setCustomerModal(null); setDetailModal(id); }}
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

      {/* 관리자 프로젝트 생성 모달 */}
      {showCreateProject && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400 }}>
          <div style={{ background: "#fff", borderRadius: 14, width: "100%", maxWidth: 480, padding: "28px 32px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <h3 style={{ margin: "0 0 18px", fontSize: 17, fontWeight: 800, color: "#111827" }}>프로젝트 직접 등록</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>제목 *</label>
                <input value={newProjectTitle} onChange={e => setNewProjectTitle(e.target.value)}
                  placeholder="프로젝트 제목" autoFocus
                  style={{ width: "100%", boxSizing: "border-box", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, outline: "none" }}
                  onKeyDown={e => e.key === "Enter" && handleCreateAdminProject()} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>고객 (선택)</label>
                <select value={newProjectCustomerId ?? ""} onChange={e => setNewProjectCustomerId(e.target.value ? Number(e.target.value) : null)}
                  style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, background: "#fff" }}>
                  <option value="">— 고객 없이 등록 —</option>
                  {customers.map(c => <option key={c.id} value={c.id}>{c.contactName} ({c.email})</option>)}
                </select>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>거래처 (선택)</label>
                  <select value={newProjectCompanyId ?? ""} onChange={e => { setNewProjectCompanyId(e.target.value ? Number(e.target.value) : null); setNewProjectContactId(null); }}
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, background: "#fff" }}>
                    <option value="">— 없음 —</option>
                    {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 4 }}>담당자 (선택)</label>
                  <select value={newProjectContactId ?? ""} onChange={e => setNewProjectContactId(e.target.value ? Number(e.target.value) : null)}
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "9px 12px", fontSize: 14, background: "#fff" }}>
                    <option value="">— 없음 —</option>
                    {contacts
                      .filter((c: any) => !newProjectCompanyId || c.companyId === newProjectCompanyId)
                      .map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <GhostBtn onClick={() => { setShowCreateProject(false); setNewProjectTitle(""); }}>취소</GhostBtn>
              <PrimaryBtn onClick={handleCreateAdminProject} disabled={creatingProject || !newProjectTitle.trim()} style={{ padding: "9px 20px" }}>
                {creatingProject ? "생성 중..." : "프로젝트 등록"}
              </PrimaryBtn>
            </div>
          </div>
        </div>
      )}

      {/* ── 프로젝트 탭 ── */}
      {adminTab === "projects" && (
        <Section title={`전체 프로젝트 (${projects.length})`} action={
          <div style={{ display: "flex", gap: 8 }}>
            <PrimaryBtn onClick={() => { fetchCustomers(); fetchCompanies(); fetchContacts(); setShowCreateProject(true); }} style={{ fontSize: 13, padding: "7px 14px" }}>+ 프로젝트 등록</PrimaryBtn>
            <GhostBtn onClick={() => handleExportCSV("projects")} style={{ fontSize: 13, padding: "7px 14px" }}>⬇ CSV 내보내기</GhostBtn>
          </div>
        }>
          {/* 검색 + 필터 */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
            <input
              value={projectSearch} onChange={e => setProjectSearch(e.target.value)}
              placeholder="제목, 이메일, 거래처, 담당자 검색..."
              style={{ ...inputStyle, maxWidth: 280, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchAll()}
            />
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13 }} />
            <span style={{ color: "#9ca3af", fontSize: 13 }}>~</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13 }} />
            <select value={assignedAdminFilter} onChange={e => setAssignedAdminFilter(e.target.value)}
              style={{ ...inputStyle, width: "auto", padding: "8px 10px", fontSize: 13, cursor: "pointer" }}>
              <option value="all">전체 담당자</option>
              {adminUsers.map(a => <option key={a.id} value={String(a.id)}>{a.email}</option>)}
            </select>
            <PrimaryBtn onClick={fetchAll} disabled={loading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {loading ? "검색 중..." : "검색"}
            </PrimaryBtn>
            {(projectSearch || dateFrom || dateTo || assignedAdminFilter !== "all" || projectFilter !== "all") && (
              <GhostBtn onClick={() => { setProjectSearch(""); setDateFrom(""); setDateTo(""); setAssignedAdminFilter("all"); setProjectFilter("all"); setProjectPage(1); }} style={{ padding: "8px 12px", fontSize: 13 }}>
                초기화
              </GhostBtn>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            <FilterPill label="전체" active={projectFilter === "all"} onClick={() => { setProjectFilter("all"); setProjectPage(1); }} />
            {ALL_PROJECT_STATUSES.map(s => (
              <FilterPill key={s} label={STATUS_LABEL[s] ?? s}
                active={projectFilter === s} onClick={() => { setProjectFilter(s); setProjectPage(1); }} />
            ))}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : projects.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
              해당 조건의 프로젝트가 없습니다.
            </Card>
          ) : (() => {
            const totalPages = Math.ceil(projects.length / PROJECT_PAGE_SIZE);
            const safePage = Math.min(projectPage, totalPages);
            const pagedProjects = projects.slice((safePage - 1) * PROJECT_PAGE_SIZE, safePage * PROJECT_PAGE_SIZE);
            return (
              <>
                <Card style={{ padding: 0, overflow: "hidden" }}>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          {["ID","제목","고객","거래처","담당자","상태","생성일","빠른액션"].map(h => (
                            <th key={h} style={tableTh}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedProjects.map(p => (
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
                            <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.companyName ?? "-"}</td>
                            <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.contactName ?? "-"}</td>
                            <td style={tableTd}><StatusBadge status={p.status} /></td>
                            <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                              {new Date(p.createdAt).toLocaleDateString("ko-KR")}
                            </td>
                            <td style={{ ...tableTd }} onClick={e => e.stopPropagation()}>
                              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                <button
                                  onClick={() => setDetailModal(p.id)}
                                  style={{ background: "#eff6ff", color: "#2563eb", border: "none", borderRadius: 6, padding: "4px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                                  상세보기
                                </button>
                                {p.status !== "cancelled" && p.status !== "completed" && (
                                  <button
                                    onClick={async () => {
                                      if (!confirm(`프로젝트 #${p.id}를 취소하시겠습니까?`)) return;
                                      const res = await fetch(api(`/api/admin/projects/${p.id}/cancel`), {
                                        method: "PATCH",
                                        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                                      });
                                      if (res.ok) { setToast("프로젝트가 취소되었습니다."); fetchAll(); }
                                      else { const d = await res.json(); setToast(`오류: ${d.error}`); }
                                    }}
                                    style={{ background: "#fef2f2", color: "#dc2626", border: "none", borderRadius: 6, padding: "4px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                                    취소
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
                {/* 페이지네이션 */}
                {totalPages > 1 && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 12 }}>
                    <button
                      onClick={() => setProjectPage(p => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      style={{ background: safePage <= 1 ? "#f3f4f6" : "#fff", border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: safePage <= 1 ? "default" : "pointer", color: safePage <= 1 ? "#9ca3af" : "#374151" }}>
                      이전
                    </button>
                    <span style={{ fontSize: 13, color: "#6b7280" }}>
                      {safePage} / {totalPages} 페이지
                      <span style={{ marginLeft: 6, color: "#9ca3af" }}>({projects.length}건)</span>
                    </span>
                    <button
                      onClick={() => setProjectPage(p => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      style={{ background: safePage >= totalPages ? "#f3f4f6" : "#fff", border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 14px", fontSize: 13, cursor: safePage >= totalPages ? "default" : "pointer", color: safePage >= totalPages ? "#9ca3af" : "#374151" }}>
                      다음
                    </button>
                  </div>
                )}
              </>
            );
          })()}
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
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <GhostBtn onClick={() => handleExportCSV("settlements")} style={{ fontSize: 12, padding: "6px 12px" }}>⬇ CSV</GhostBtn>
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
                    <tr>{["ID","이메일","역할","상태","가입일","역할 변경","계정 상태","비밀번호","프로필"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
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
                        <td style={tableTd}>
                          <button
                            onClick={() => { setResetPwUserId(u.id); setResetPwInput(""); }}
                            style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, fontWeight: 600, cursor: "pointer", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                            재설정
                          </button>
                        </td>
                        <td style={tableTd}>
                          {u.role === "translator" ? (
                            <button onClick={() => setTranslatorProfileModal({ userId: u.id, email: u.email })}
                              style={{ padding: "4px 10px", fontSize: 12, borderRadius: 6, fontWeight: 600, cursor: "pointer", background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe" }}>
                              프로필
                            </button>
                          ) : <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>}
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

      {/* ── 고객 관리 탭 ── */}
      {adminTab === "customers" && (
        <Section title={`고객 관리 (${customers.length})`} action={
          <PrimaryBtn onClick={() => setShowCreateCustomer(v => !v)} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showCreateCustomer ? "취소" : "+ 고객 등록"}
          </PrimaryBtn>
        }>
          {/* 고객 등록 폼 */}
          {showCreateCustomer && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>새 고객 등록</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                {([
                  ["companyName", "회사명 *"],
                  ["contactName", "담당자명 *"],
                  ["email", "이메일 *"],
                  ["phone", "전화번호"],
                ] as const).map(([field, label]) => (
                  <div key={field}>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{label}</label>
                    <input
                      value={newCustomer[field]}
                      onChange={e => setNewCustomer(f => ({ ...f, [field]: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                      placeholder={label.replace(" *", "")}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryBtn onClick={handleCreateCustomer} disabled={creatingCustomer} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {creatingCustomer ? "등록 중..." : "등록"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowCreateCustomer(false)} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}

          {/* 검색 */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input
              value={customerSearch} onChange={e => setCustomerSearch(e.target.value)}
              placeholder="회사명, 담당자명, 이메일 검색..."
              style={{ ...inputStyle, maxWidth: 300, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchCustomers()}
            />
            <PrimaryBtn onClick={fetchCustomers} disabled={customersLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {customersLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>

          {customersLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : customers.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>
              고객이 없습니다. 상단의 "+ 고객 등록" 버튼으로 추가하세요.
            </Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","회사명","담당자","이메일","전화","프로젝트","총 결제","등록일"].map(h => (
                      <th key={h} style={tableTh}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {customers.map(c => (
                      <tr key={c.id}
                        onClick={() => setCustomerModal(c.id)}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{c.companyName}</td>
                        <td style={tableTd}>{c.contactName}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{c.email}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.phone ?? "-"}</td>
                        <td style={{ ...tableTd, textAlign: "center" }}>
                          <span style={{ padding: "2px 10px", borderRadius: 12, background: "#eff6ff", color: "#2563eb", fontSize: 12, fontWeight: 600 }}>
                            {c.projectCount}건
                          </span>
                        </td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#059669", whiteSpace: "nowrap" }}>
                          {Number(c.totalPayment).toLocaleString()}원
                        </td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>
                          {new Date(c.createdAt).toLocaleDateString("ko-KR")}
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

      {/* ── 거래처 탭 ── */}
      {adminTab === "companies" && (
        <Section title={`거래처 관리 (${companies.length})`} action={
          <PrimaryBtn onClick={() => setShowCompanyForm(v => !v)} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showCompanyForm ? "취소" : "+ 거래처 등록"}
          </PrimaryBtn>
        }>
          {showCompanyForm && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>새 거래처 등록</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                {([["name","회사명 *"],["businessNumber","사업자번호"],["industry","업종"],["address","주소"],["website","웹사이트"]] as const).map(([f, l]) => (
                  <div key={f}>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>{l}</label>
                    <input value={companyForm[f]} onChange={e => setCompanyForm(p => ({ ...p, [f]: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
                  </div>
                ))}
                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>메모</label>
                  <textarea value={companyForm.notes} onChange={e => setCompanyForm(p => ({ ...p, notes: e.target.value }))}
                    rows={2} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px", resize: "vertical" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryBtn onClick={handleCreateCompany} disabled={savingCompany} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {savingCompany ? "등록 중..." : "등록"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowCompanyForm(false)} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input value={companySearch} onChange={e => setCompanySearch(e.target.value)}
              placeholder="회사명, 사업자번호 검색..."
              style={{ ...inputStyle, maxWidth: 300, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchCompanies()} />
            <PrimaryBtn onClick={fetchCompanies} disabled={companiesLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {companiesLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {companiesLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : companies.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 거래처가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","회사명","업종","담당자","프로젝트","총 결제","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {companies.map(c => (
                      <tr key={c.id} onClick={() => setCompanyModal(c.id)} style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{c.name}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.industry ?? "-"}</td>
                        <td style={{ ...tableTd, textAlign: "center" }}>
                          <span style={{ padding: "2px 8px", borderRadius: 10, background: "#f3f4f6", color: "#374151", fontSize: 12 }}>{c.contactCount}명</span>
                        </td>
                        <td style={{ ...tableTd, textAlign: "center" }}>
                          <span style={{ padding: "2px 8px", borderRadius: 10, background: "#eff6ff", color: "#2563eb", fontSize: 12, fontWeight: 600 }}>{c.projectCount}건</span>
                        </td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#059669", whiteSpace: "nowrap" }}>{Number(c.totalPayment).toLocaleString()}원</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(c.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 담당자 탭 ── */}
      {adminTab === "contacts" && (
        <Section title={`담당자 관리 (${contacts.length})`}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input value={contactSearch} onChange={e => setContactSearch(e.target.value)}
              placeholder="이름, 이메일, 부서, 거래처 검색..."
              style={{ ...inputStyle, maxWidth: 320, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchContacts()} />
            <PrimaryBtn onClick={fetchContacts} disabled={contactsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {contactsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {contactsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : contacts.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 담당자가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","이름","부서/직책","이메일","전화","거래처","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {contacts.map(c => (
                      <tr key={c.id} onClick={() => setContactModal(c.id)} style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{c.name}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>
                          {[c.department, c.position].filter(Boolean).join(" / ") || "-"}
                        </td>
                        <td style={{ ...tableTd, color: "#2563eb", fontSize: 12 }}>{c.email ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{c.phone ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.companyName ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(c.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 상품/단가 탭 ── */}
      {adminTab === "products" && (
        <Section title={`상품/단가 관리 (${products.length})`} action={
          <PrimaryBtn onClick={() => { setShowProductForm(v => !v); setEditingProduct(null); setProductForm({ code: "", name: "", category: "", unit: "건", basePrice: "", languagePair: "", field: "" }); }} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showProductForm && !editingProduct ? "취소" : "+ 상품 등록"}
          </PrimaryBtn>
        }>
          {showProductForm && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>{editingProduct ? "상품 수정" : "새 상품 등록"}</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                {([["code","상품 코드 *"],["name","상품명 *"],["category","분류"],["unit","단위"],["basePrice","기본단가 *"],["languagePair","언어 조합"],["field","전문 분야"]] as const).map(([f, l]) => (
                  <div key={f}>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>{l}</label>
                    <input value={productForm[f]} onChange={e => setProductForm(p => ({ ...p, [f]: e.target.value }))}
                      type={f === "basePrice" ? "number" : "text"}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }} />
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <PrimaryBtn onClick={handleSaveProduct} disabled={savingProduct} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {savingProduct ? "저장 중..." : "저장"}
                </PrimaryBtn>
                <GhostBtn onClick={() => { setShowProductForm(false); setEditingProduct(null); }} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <input value={productSearch} onChange={e => setProductSearch(e.target.value)}
              placeholder="상품명, 코드 검색..."
              style={{ ...inputStyle, maxWidth: 300, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchProducts()} />
            <PrimaryBtn onClick={fetchProducts} disabled={productsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {productsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {productsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : products.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 상품이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["코드","상품명","분류","단위","기본단가","언어조합","분야","상태","관리"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {products.map(p => (
                      <tr key={p.id}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, fontFamily: "monospace", fontSize: 12, color: "#6b7280" }}>{p.code}</td>
                        <td style={{ ...tableTd, fontWeight: 700, color: "#111827" }}>{p.name}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.category ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12 }}>{p.unit}</td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#2563eb", whiteSpace: "nowrap" }}>{Number(p.basePrice).toLocaleString()}원</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.languagePair ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{p.field ?? "-"}</td>
                        <td style={tableTd}>
                          <span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 12, fontWeight: 600, background: p.active ? "#f0fdf4" : "#f3f4f6", color: p.active ? "#059669" : "#9ca3af" }}>
                            {p.active ? "활성" : "비활성"}
                          </span>
                        </td>
                        <td style={{ ...tableTd, whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => { setEditingProduct(p.id); setProductForm({ code: p.code, name: p.name, category: p.category ?? "", unit: p.unit, basePrice: String(p.basePrice), languagePair: p.languagePair ?? "", field: p.field ?? "" }); setShowProductForm(true); }}
                              style={{ padding: "3px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer", background: "#eff6ff", color: "#2563eb", border: "none", fontWeight: 600 }}>수정</button>
                            <button onClick={() => handleToggleProduct(p.id)}
                              style={{ padding: "3px 8px", fontSize: 11, borderRadius: 6, cursor: "pointer", background: p.active ? "#fef2f2" : "#f0fdf4", color: p.active ? "#dc2626" : "#059669", border: "none", fontWeight: 600 }}>
                              {p.active ? "비활성" : "활성"}
                            </button>
                          </div>
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

      {/* ── 게시판 탭 ── */}
      {adminTab === "board" && (
        <Section title={`게시판 (${boardPosts.length})`} action={
          <PrimaryBtn onClick={() => setShowBoardForm(v => !v)} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showBoardForm ? "취소" : "+ 글 작성"}
          </PrimaryBtn>
        }>
          {showBoardForm && (
            <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#111827" }}>게시물 작성</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>카테고리</label>
                  <select value={boardForm.category} onChange={e => setBoardForm(p => ({ ...p, category: e.target.value }))}
                    style={{ ...inputStyle, width: "100%", padding: "7px 10px", fontSize: 13 }}>
                    <option value="notice">공지</option>
                    <option value="reference">통역자료</option>
                    <option value="manual">내부매뉴얼</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>제목 *</label>
                  <input value={boardForm.title} onChange={e => setBoardForm(p => ({ ...p, title: e.target.value }))}
                    style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "7px 10px" }} />
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>내용 *</label>
                <textarea value={boardForm.content} onChange={e => setBoardForm(p => ({ ...p, content: e.target.value }))}
                  rows={5} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
              </div>
              <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={boardForm.pinned} onChange={e => setBoardForm(p => ({ ...p, pinned: e.target.checked }))} />
                  상단 고정
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={boardForm.visibleToAll} onChange={e => setBoardForm(p => ({ ...p, visibleToAll: e.target.checked }))} />
                  번역사에게 공개
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryBtn onClick={handleSaveBoardPost} disabled={savingBoard} style={{ fontSize: 13, padding: "8px 18px" }}>
                  {savingBoard ? "등록 중..." : "등록"}
                </PrimaryBtn>
                <GhostBtn onClick={() => setShowBoardForm(false)} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
              </div>
            </Card>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            {[{ v: "all", l: "전체" }, { v: "notice", l: "공지" }, { v: "reference", l: "통역자료" }, { v: "manual", l: "내부매뉴얼" }].map(({ v, l }) => (
              <button key={v} onClick={() => setBoardCategory(v)}
                style={{ padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                  background: boardCategory === v ? "#2563eb" : "#f3f4f6", color: boardCategory === v ? "#fff" : "#374151" }}>
                {l}
              </button>
            ))}
          </div>

          {boardLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : boardPosts.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>게시물이 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["","분류","제목","작성자","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {boardPosts.map(post => (
                      <tr key={post.id} onClick={() => setBoardPostModal(post)} style={{ cursor: "pointer" }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f9fafb")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <td style={{ ...tableTd, width: 30 }}>
                          {post.pinned && <span style={{ fontSize: 14 }}>📌</span>}
                        </td>
                        <td style={tableTd}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, background: "#eff6ff", color: "#2563eb", fontSize: 11, fontWeight: 700 }}>
                              {BOARD_CATEGORY_LABEL[post.category] ?? post.category}
                            </span>
                            {post.visibleToAll && <span style={{ padding: "2px 8px", borderRadius: 10, background: "#f0fdf4", color: "#059669", fontSize: 11, fontWeight: 700 }}>공개</span>}
                          </div>
                        </td>
                        <td style={{ ...tableTd, fontWeight: 600, color: "#111827" }}>{post.title}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{post.authorEmail ?? "-"}</td>
                        <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(post.createdAt).toLocaleDateString("ko-KR")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 번역사 탭 ── */}
      {adminTab === "translators" && (
        <Section title={`번역사 관리 (${translatorList.length})`}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            <input value={translatorSearch} onChange={e => setTranslatorSearch(e.target.value)}
              placeholder="이메일, 언어쌍, 지역 검색..."
              style={{ ...inputStyle, maxWidth: 260, flex: "1 1 180px", padding: "8px 12px", fontSize: 13 }}
              onKeyDown={e => e.key === "Enter" && fetchTranslators()} />
            <input value={translatorLangFilter} onChange={e => setTranslatorLangFilter(e.target.value)}
              placeholder="언어쌍 (예: 한→영)"
              style={{ ...inputStyle, maxWidth: 160, padding: "8px 12px", fontSize: 13 }} />
            <input value={translatorRatingFilter} onChange={e => setTranslatorRatingFilter(e.target.value)}
              placeholder="최소 평점 (1~5)"
              style={{ ...inputStyle, maxWidth: 130, padding: "8px 12px", fontSize: 13 }} />
            <select value={translatorStatusFilter} onChange={e => setTranslatorStatusFilter(e.target.value)}
              style={{ ...inputStyle, padding: "8px 12px", fontSize: 13, minWidth: 100 }}>
              <option value="all">전체 상태</option>
              <option value="available">가능</option>
              <option value="busy">바쁨</option>
              <option value="unavailable">불가</option>
            </select>
            <PrimaryBtn onClick={fetchTranslators} disabled={translatorsLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
              {translatorsLoading ? "검색 중..." : "검색"}
            </PrimaryBtn>
          </div>
          {translatorsLoading ? (
            <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : translatorList.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>등록된 번역사가 없습니다.</Card>
          ) : (
            <Card style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>{["ID","이메일","언어쌍","분야","지역","평점","상태","단가(어절)","활성","등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {translatorList.map(t => {
                      const statusColor = t.availabilityStatus === "available" ? "#059669" : t.availabilityStatus === "busy" ? "#d97706" : "#dc2626";
                      const statusBg = t.availabilityStatus === "available" ? "#f0fdf4" : t.availabilityStatus === "busy" ? "#fffbeb" : "#fef2f2";
                      return (
                        <tr key={t.id} onClick={() => setTranslatorDetailModal({ userId: t.id, email: t.email })} style={{ cursor: "pointer" }}
                          onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          <td style={{ ...tableTd, color: "#9ca3af" }}>#{t.id}</td>
                          <td style={{ ...tableTd, fontWeight: 600, color: "#111827", fontSize: 12 }}>{t.email}</td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#374151" }}>{t.languagePairs ?? "-"}</td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{t.specializations ?? "-"}</td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{t.region ?? "-"}</td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            {t.rating != null ? <span style={{ fontWeight: 700, color: "#d97706" }}>★ {t.rating.toFixed(1)}</span> : <span style={{ color: "#9ca3af" }}>-</span>}
                          </td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            <span style={{ padding: "2px 8px", borderRadius: 10, background: statusBg, color: statusColor, fontSize: 11, fontWeight: 700 }}>
                              {AVAILABILITY_LABEL[t.availabilityStatus ?? "available"] ?? t.availabilityStatus}
                            </span>
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#374151", textAlign: "right" }}>
                            {t.ratePerWord != null ? `${t.ratePerWord.toFixed(1)}원` : "-"}
                          </td>
                          <td style={{ ...tableTd, textAlign: "center" }}>
                            <span style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: t.isActive ? "#059669" : "#d1d5db" }} />
                          </td>
                          <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(t.createdAt).toLocaleDateString("ko-KR")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </Section>
      )}

      {/* ── 운영 테스트 탭 ── */}
      {adminTab === "test" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>

          {/* 시나리오 실행 패널 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#111827" }}>🧪 운영 시나리오 자동 실행</h3>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#6b7280" }}>프로젝트 생성 → 견적 → 승인 → 결제 → 번역사 배정 → 진행 → 완료 → 정산까지 순차 실행합니다.</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#374151", display: "block", marginBottom: 3 }}>견적 금액 (원)</label>
                  <input value={scenarioAmount} onChange={e => setScenarioAmount(e.target.value)} type="number" min="10000"
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box" as const }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 600, color: "#374151", display: "block", marginBottom: 3 }}>번역사 수익 비율 (0~1)</label>
                  <input value={scenarioRatio} onChange={e => setScenarioRatio(e.target.value)} type="number" min="0" max="1" step="0.1"
                    style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 7, padding: "7px 10px", fontSize: 13, boxSizing: "border-box" as const }} />
                </div>
              </div>

              {/* 실제 거래처/담당자 연결 (선택) */}
              <div style={{ background: "#f0f9ff", borderRadius: 8, padding: "10px 12px", marginBottom: 12, border: "1px solid #bae6fd" }}>
                <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#0369a1" }}>실제 거래처 연결 (선택 — 미선택 시 테스트 데이터로 생성)</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "#374151", display: "block", marginBottom: 2 }}>거래처</label>
                    <select value={scenarioCompanyId} onChange={e => { setScenarioCompanyId(e.target.value); setScenarioContactId(""); }}
                      style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, boxSizing: "border-box" as const }}>
                      <option value="">— 테스트 거래처 —</option>
                      {(realData?.companies ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#374151", display: "block", marginBottom: 2 }}>담당자</label>
                    <select value={scenarioContactId} onChange={e => setScenarioContactId(e.target.value)}
                      style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 6, padding: "6px 8px", fontSize: 12, boxSizing: "border-box" as const }}>
                      <option value="">— 담당자 없음 —</option>
                      {(realData?.contacts ?? [])
                        .filter(ct => !scenarioCompanyId || ct.companyId === Number(scenarioCompanyId))
                        .map(ct => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
                    </select>
                  </div>
                </div>
                {scenarioCompanyId && (
                  <p style={{ margin: "6px 0 0", fontSize: 11, color: "#0369a1" }}>
                    ✅ 실제 거래처 데이터로 프로젝트가 생성됩니다. 최소 입력 항목: 거래처 선택 완료.
                  </p>
                )}
              </div>

              <button onClick={runScenario} disabled={scenarioRunning}
                style={{ width: "100%", padding: "11px 0", background: scenarioRunning ? "#9ca3af" : "#1e3a8a", color: "#fff", border: "none", borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: scenarioRunning ? "not-allowed" : "pointer" }}>
                {scenarioRunning ? "⏳ 실행 중..." : "▶ 시나리오 실행"}
              </button>

              {/* 실제 운영 데이터 최소 입력 안내 */}
              <div style={{ marginTop: 12, padding: "10px 12px", background: "#f9fafb", borderRadius: 8, fontSize: 11, color: "#374151", lineHeight: 1.8 }}>
                <strong style={{ color: "#111827" }}>실제 프로젝트 1건 테스트 최소 요건:</strong><br/>
                ① 거래처 등록 (거래처 탭) ② 담당자 등록 (담당자 탭) ③ 번역사 계정 + 프로필 등록 (번역사 탭) ④ 제품 마스터 등록 (제품 탭) ⑤ 여기서 거래처/담당자 선택 후 실행
              </div>
            </div>

            {/* 실행 결과 */}
            {scenarioResult && (
              <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#111827" }}>
                    실행 결과 {scenarioResult.projectId ? `— #${scenarioResult.projectId}` : ""}
                  </h4>
                  <div style={{ display: "flex", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, background: "#f0fdf4", color: "#166534", borderRadius: 6, padding: "2px 8px" }}>✅ {scenarioResult.summary.ok}</span>
                    {scenarioResult.summary.error > 0 && <span style={{ fontSize: 12, fontWeight: 700, background: "#fef2f2", color: "#991b1b", borderRadius: 6, padding: "2px 8px" }}>❌ {scenarioResult.summary.error}</span>}
                    {scenarioResult.summary.skipped > 0 && <span style={{ fontSize: 12, fontWeight: 700, background: "#f3f4f6", color: "#6b7280", borderRadius: 6, padding: "2px 8px" }}>⏭ {scenarioResult.summary.skipped}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {scenarioResult.steps.map(s => (
                    <div key={s.step} style={{
                      display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px",
                      borderRadius: 8,
                      background: s.status === "ok" ? "#f0fdf4" : s.status === "error" ? "#fef2f2" : "#f9fafb",
                      border: `1px solid ${s.status === "ok" ? "#bbf7d0" : s.status === "error" ? "#fecaca" : "#e5e7eb"}`,
                    }}>
                      <span style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}>
                        {s.status === "ok" ? "✅" : s.status === "error" ? "❌" : "⏭"}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af" }}>Step {s.step}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{s.name}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 12, color: s.status === "error" ? "#991b1b" : "#374151", wordBreak: "break-all" }}>{s.detail}</p>
                        {s.data?.logs && (
                          <details style={{ marginTop: 4 }}>
                            <summary style={{ fontSize: 11, color: "#6b7280", cursor: "pointer" }}>로그 보기</summary>
                            <pre style={{ margin: "4px 0 0", fontSize: 10, color: "#374151", background: "#f9fafb", borderRadius: 4, padding: "6px 8px", overflowX: "auto" }}>{JSON.stringify(s.data.logs, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <p style={{ margin: "10px 0 0", fontSize: 11, color: "#9ca3af" }}>
                  {new Date(scenarioResult.startedAt).toLocaleString("ko-KR")} → {new Date(scenarioResult.finishedAt).toLocaleString("ko-KR")}
                </p>
              </div>
            )}

            {/* 시나리오 실행 이력 */}
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", boxShadow: "0 1px 3px rgba(0,0,0,.07)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#111827" }}>시나리오 이력 ({scenarioHistory.length})</h4>
                <button onClick={fetchScenarioHistory} disabled={scenarioHistoryLoading}
                  style={{ fontSize: 12, color: "#2563eb", background: "none", border: "none", cursor: "pointer" }}>
                  {scenarioHistoryLoading ? "로딩..." : "새로고침"}
                </button>
              </div>
              {scenarioHistory.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>아직 실행된 시나리오가 없습니다.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {scenarioHistory.slice(0, 10).map(h => (
                    <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 10px", background: "#f9fafb", borderRadius: 7, fontSize: 12 }}>
                      <span style={{ color: "#111827", fontWeight: 600 }}>#{h.id} {h.title.replace("[테스트] 시나리오 ", "")}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ color: "#6b7280", fontSize: 11 }}>{h.status}</span>
                        <span style={{ color: "#9ca3af", fontSize: 11 }}>{new Date(h.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* UX 피드백 패널 */}
          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,.07)", display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 800, color: "#111827" }}>💬 불편한 점 메모</h3>
              <p style={{ margin: "0 0 10px", fontSize: 13, color: "#6b7280" }}>운영 테스트 중 발견한 UX 문제나 개선 아이디어를 유형별로 기록하세요.</p>
              {/* 유형 선택 */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                {FEEDBACK_TAGS.map(t => (
                  <button key={t.value} onClick={() => setFeedbackTag(t.value as FeedbackTag)}
                    style={{ padding: "3px 10px", fontSize: 11, fontWeight: 700, borderRadius: 20, border: "1.5px solid",
                      borderColor: feedbackTag === t.value ? t.color : "#e5e7eb",
                      background: feedbackTag === t.value ? t.bg : "#fff",
                      color: feedbackTag === t.value ? t.color : "#9ca3af",
                      cursor: "pointer" }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <textarea
                value={feedbackInput} onChange={e => setFeedbackInput(e.target.value)}
                placeholder="예) 프로젝트 목록에서 상태 필터 초기화 버튼이 눈에 잘 안 띕니다..."
                rows={4}
                style={{ width: "100%", boxSizing: "border-box" as const, border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 12px", fontSize: 13, resize: "vertical", fontFamily: "inherit", color: "#111", outline: "none" }}
                onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitFeedback(); }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <span style={{ fontSize: 11, color: "#9ca3af" }}>Ctrl+Enter 또는 버튼으로 저장</span>
                <button onClick={submitFeedback} disabled={feedbackSubmitting || !feedbackInput.trim()}
                  style={{ padding: "7px 18px", background: feedbackSubmitting || !feedbackInput.trim() ? "#e5e7eb" : "#1e3a8a", color: feedbackSubmitting || !feedbackInput.trim() ? "#9ca3af" : "#fff", border: "none", borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: feedbackSubmitting || !feedbackInput.trim() ? "not-allowed" : "pointer" }}>
                  {feedbackSubmitting ? "저장 중..." : "저장"}
                </button>
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "#374151" }}>
                  피드백 목록 ({feedbackList.filter(f => feedbackTagFilter === "all" || f.tag === feedbackTagFilter).length})
                </h4>
                <button onClick={fetchFeedback} disabled={feedbackLoading}
                  style={{ fontSize: 12, color: "#2563eb", background: "none", border: "none", cursor: "pointer" }}>
                  {feedbackLoading ? "로딩..." : "새로고침"}
                </button>
              </div>
              {/* 태그 필터 */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                <button onClick={() => setFeedbackTagFilter("all")}
                  style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 20, border: "1.5px solid", borderColor: feedbackTagFilter === "all" ? "#374151" : "#e5e7eb", background: feedbackTagFilter === "all" ? "#f3f4f6" : "#fff", color: feedbackTagFilter === "all" ? "#374151" : "#9ca3af", cursor: "pointer" }}>
                  전체 ({feedbackList.length})
                </button>
                {FEEDBACK_TAGS.map(t => {
                  const cnt = feedbackList.filter(f => f.tag === t.value).length;
                  if (cnt === 0) return null;
                  return (
                    <button key={t.value} onClick={() => setFeedbackTagFilter(t.value)}
                      style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 20, border: "1.5px solid",
                        borderColor: feedbackTagFilter === t.value ? t.color : "#e5e7eb",
                        background: feedbackTagFilter === t.value ? t.bg : "#fff",
                        color: feedbackTagFilter === t.value ? t.color : "#9ca3af",
                        cursor: "pointer" }}>
                      {t.label} ({cnt})
                    </button>
                  );
                })}
              </div>
              {feedbackList.filter(f => feedbackTagFilter === "all" || f.tag === feedbackTagFilter).length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, color: "#9ca3af" }}>아직 저장된 피드백이 없습니다.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 520, overflowY: "auto" }}>
                  {feedbackList.filter(f => feedbackTagFilter === "all" || f.tag === feedbackTagFilter).map(f => {
                    const tagInfo = FEEDBACK_TAGS.find(t => t.value === (f.tag ?? "general")) ?? FEEDBACK_TAGS[0];
                    return (
                      <div key={f.id} style={{ background: tagInfo.bg, border: `1px solid`, borderColor: tagInfo.color + "44", borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 5 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: tagInfo.color, background: "#fff", border: `1px solid ${tagInfo.color}33`, borderRadius: 10, padding: "1px 7px" }}>{tagInfo.label}</span>
                            <span style={{ fontSize: 11, color: "#374151", fontWeight: 600 }}>{f.adminEmail ?? "관리자"}</span>
                            <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(f.createdAt).toLocaleString("ko-KR")}</span>
                          </div>
                          <button onClick={() => deleteFeedback(f.id)}
                            style={{ fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer", padding: 0 }}>삭제</button>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: "#111827", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{f.content}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TranslatorDashboard({ user, token }: { user: User; token: string }) {
  const [tab, setTab] = useState<"tasks"|"settlement"|"profile">("tasks");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settlements, setSettlements] = useState<MySettlement[]>([]);
  const [profile, setProfile] = useState<TranslatorProfile | null>(null);
  const [rates, setRates] = useState<TranslatorRate[]>([]);
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [acting, setActing] = useState<number | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<Partial<TranslatorProfile>>({});
  const [editingProfile, setEditingProfile] = useState(false);
  const [rateForm, setRateForm] = useState({ serviceType: "번역", languagePair: "EN-KO", unit: "word", rate: "" });
  const [addingRate, setAddingRate] = useState(false);
  const [deletingRate, setDeletingRate] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchTasksAndSettlements = useCallback(async () => {
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

  const fetchProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const [pRes, rRes] = await Promise.all([
        fetch(api(`/api/translator-profiles/${user.id}`), { headers: authHeaders }),
        fetch(api(`/api/translator-rates/${user.id}`), { headers: authHeaders }),
      ]);
      if (pRes.ok) {
        const pd = await pRes.json();
        setProfile(pd);
        setProfileForm(pd ?? {});
      }
      if (rRes.ok) {
        const rd = await rRes.json();
        setRates(Array.isArray(rd) ? rd : []);
      }
    } catch { setToast("오류: 프로필을 불러올 수 없습니다."); }
    finally { setProfileLoading(false); }
  }, [user.id, token]);

  useEffect(() => { fetchTasksAndSettlements(); }, [fetchTasksAndSettlements]);
  useEffect(() => { if (tab === "profile") fetchProfile(); }, [tab, fetchProfile]);

  const doAction = async (taskId: number, action: "start" | "complete") => {
    setActing(taskId);
    try {
      const res = await fetch(api(`/api/tasks/${taskId}/${action}`), {
        method: "PATCH", headers: { "Authorization": `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setToast(action === "start" ? "작업을 시작했습니다." : "작업을 완료했습니다. 정산이 자동 생성됩니다.");
      await fetchTasksAndSettlements();
    } catch { setToast("오류: 상태 변경 실패"); }
    finally { setActing(null); }
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const res = await fetch(api(`/api/translator-profiles/${user.id}`), {
        method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...profileForm, userId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setProfile(data); setEditingProfile(false);
      setToast("프로필이 저장되었습니다.");
    } catch { setToast("오류: 저장 실패"); }
    finally { setSavingProfile(false); }
  };

  const addRate = async () => {
    if (!rateForm.rate || isNaN(Number(rateForm.rate))) { setToast("단가를 숫자로 입력하세요."); return; }
    setAddingRate(true);
    try {
      const res = await fetch(api(`/api/translator-rates/${user.id}`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...rateForm, rate: Number(rateForm.rate), translatorId: user.id }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(`오류: ${data.error}`); return; }
      setRates(prev => [...prev, data]);
      setRateForm({ serviceType: "번역", languagePair: "EN-KO", unit: "word", rate: "" });
      setToast("단가가 추가되었습니다.");
    } catch { setToast("오류: 단가 추가 실패"); }
    finally { setAddingRate(false); }
  };

  const deleteRate = async (rateId: number) => {
    setDeletingRate(rateId);
    try {
      const res = await fetch(api(`/api/translator-rates/${user.id}/${rateId}`), {
        method: "DELETE", headers: authHeaders,
      });
      if (!res.ok) { setToast("오류: 삭제 실패"); return; }
      setRates(prev => prev.filter(r => r.id !== rateId));
      setToast("단가가 삭제되었습니다.");
    } catch { setToast("오류: 삭제 실패"); }
    finally { setDeletingRate(null); }
  };

  const active = tasks.filter(t => t.status !== "done");
  const completed = tasks.filter(t => t.status === "done");

  const SETTLEMENT_STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
    pending: { label: "대기", color: "#6b7280", bg: "#f3f4f6" },
    ready:   { label: "정산 가능", color: "#d97706", bg: "#fffbeb" },
    paid:    { label: "지급 완료", color: "#059669", bg: "#f0fdf4" },
  };
  const AVAIL_LABEL: Record<string, string> = { available: "가능", busy: "바쁨", unavailable: "불가" };
  const tabBtn = (key: typeof tab, label: string) => (
    <button key={key} onClick={() => setTab(key)} style={{
      padding: "7px 18px", borderRadius: 20, cursor: "pointer", fontSize: 13, fontWeight: tab === key ? 700 : 500,
      border: "1px solid", borderColor: tab === key ? "#2563eb" : "#e5e7eb",
      background: tab === key ? "#eff6ff" : "#fff", color: tab === key ? "#2563eb" : "#6b7280",
    }}>{label}</button>
  );

  return (
    <>
      <Toast msg={toast} onClose={() => setToast("")} />
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {tabBtn("tasks", `작업 (${tasks.length})`)}
        {tabBtn("settlement", `정산 (${settlements.length})`)}
        {tabBtn("profile", "프로필 · 단가표")}
      </div>

      {/* ── 작업 탭 ── */}
      {tab === "tasks" && (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
            <GhostBtn onClick={fetchTasksAndSettlements} disabled={loading}>
              {loading ? "로딩 중..." : "새로고침"}
            </GhostBtn>
          </div>
          {loading ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
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
        </>
      )}

      {/* ── 정산 탭 ── */}
      {tab === "settlement" && (
        <>
          {settlements.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "32px 24px", color: "#9ca3af" }}>
              <p style={{ margin: 0, fontSize: 28 }}>💰</p>
              <p style={{ margin: "8px 0 0", fontSize: 14 }}>아직 정산 내역이 없습니다.</p>
            </Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {settlements.map(s => {
                const st = SETTLEMENT_STATUS_STYLE[s.status] ?? SETTLEMENT_STATUS_STYLE.pending;
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
                        {Number(s.translatorAmount).toLocaleString()}<span style={{ fontSize: 13, marginLeft: 3 }}>원</span>
                      </p>
                      <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>
                        총 결제 {Number(s.totalAmount).toLocaleString()}원의 70%
                      </p>
                    </div>
                    <div style={{ minWidth: 90, textAlign: "right" }}>
                      <span style={{ background: st.bg, color: st.color, padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 700 }}>
                        {st.label}
                      </span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── 프로필/단가표 탭 ── */}
      {tab === "profile" && (
        <>
          {profileLoading ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#9ca3af" }}>불러오는 중...</div>
          ) : (
            <>
              <Card style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>기본 프로필</p>
                  {!editingProfile ? (
                    <GhostBtn onClick={() => setEditingProfile(true)} style={{ fontSize: 12, padding: "5px 12px" }}>편집</GhostBtn>
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      <GhostBtn onClick={() => { setEditingProfile(false); setProfileForm(profile ?? {}); }} style={{ fontSize: 12, padding: "5px 12px" }}>취소</GhostBtn>
                      <PrimaryBtn onClick={saveProfile} disabled={savingProfile} style={{ fontSize: 12, padding: "5px 14px" }}>
                        {savingProfile ? "저장 중..." : "저장"}
                      </PrimaryBtn>
                    </div>
                  )}
                </div>

                {!editingProfile ? (
                  profile ? (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 20px" }}>
                      {([
                        ["언어쌍", profile.languagePairs ?? "-"],
                        ["전문분야", profile.specializations ?? "-"],
                        ["학력", `${profile.education ?? "-"}${profile.major ? ` / ${profile.major}` : ""}${profile.graduationYear ? ` (${profile.graduationYear})` : ""}`],
                        ["지역", profile.region ?? "-"],
                        ["가용여부", AVAIL_LABEL[profile.availabilityStatus ?? ""] ?? "-"],
                        ["평점", profile.rating != null ? `⭐ ${Number(profile.rating).toFixed(1)}` : "-"],
                        ["단어당 단가", profile.ratePerWord != null ? `${Number(profile.ratePerWord).toLocaleString()}원` : "-"],
                        ["페이지당 단가", profile.ratePerPage != null ? `${Number(profile.ratePerPage).toLocaleString()}원` : "-"],
                      ] as [string, string][]).map(([k, v]) => (
                        <div key={k} style={{ display: "flex", gap: 6, fontSize: 13 }}>
                          <span style={{ color: "#9ca3af", minWidth: 80, flexShrink: 0 }}>{k}</span>
                          <span style={{ color: "#111827" }}>{v}</span>
                        </div>
                      ))}
                      {profile.bio && (
                        <div style={{ gridColumn: "span 2", display: "flex", gap: 6, fontSize: 13 }}>
                          <span style={{ color: "#9ca3af", minWidth: 80 }}>소개</span>
                          <span style={{ color: "#374151", lineHeight: 1.6 }}>{profile.bio}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>
                      프로필이 없습니다. 편집 버튼을 눌러 프로필을 등록하세요.
                    </p>
                  )
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                    {([
                      ["languagePairs", "언어쌍", "예: EN-KO, JA-KO"],
                      ["specializations", "전문분야", "예: IT, 법률, 의료"],
                      ["region", "지역", "예: 서울"],
                      ["education", "학교", "예: 서울대학교"],
                      ["major", "전공", "예: 영문학"],
                    ] as [keyof TranslatorProfile, string, string][]).map(([field, label, placeholder]) => (
                      <div key={field}>
                        <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{label}</label>
                        <input
                          value={(profileForm[field] as string) ?? ""}
                          onChange={e => setProfileForm(p => ({ ...p, [field]: e.target.value }))}
                          placeholder={placeholder}
                          style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                        />
                      </div>
                    ))}
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>졸업연도</label>
                      <input
                        type="number"
                        value={profileForm.graduationYear ?? ""}
                        onChange={e => setProfileForm(p => ({ ...p, graduationYear: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="예: 2015"
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>가용 여부</label>
                      <select
                        value={profileForm.availabilityStatus ?? "available"}
                        onChange={e => setProfileForm(p => ({ ...p, availabilityStatus: e.target.value }))}
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}>
                        <option value="available">가능</option>
                        <option value="busy">바쁨</option>
                        <option value="unavailable">불가</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>단어당 단가 (원)</label>
                      <input
                        type="number"
                        value={profileForm.ratePerWord ?? ""}
                        onChange={e => setProfileForm(p => ({ ...p, ratePerWord: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="예: 50"
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>페이지당 단가 (원)</label>
                      <input
                        type="number"
                        value={profileForm.ratePerPage ?? ""}
                        onChange={e => setProfileForm(p => ({ ...p, ratePerPage: e.target.value ? Number(e.target.value) : undefined }))}
                        placeholder="예: 20000"
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                    <div style={{ gridColumn: "span 2" }}>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>소개</label>
                      <textarea
                        value={profileForm.bio ?? ""}
                        onChange={e => setProfileForm(p => ({ ...p, bio: e.target.value }))}
                        placeholder="자기소개를 입력하세요..."
                        rows={3}
                        style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 10px", resize: "vertical" }}
                      />
                    </div>
                  </div>
                )}
              </Card>

              <Card>
                <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#111827" }}>단가표</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto", gap: "8px 10px", alignItems: "center", marginBottom: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "#9ca3af", display: "block", marginBottom: 2 }}>서비스 유형</label>
                    <input value={rateForm.serviceType} onChange={e => setRateForm(p => ({ ...p, serviceType: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12, padding: "6px 8px", width: "100%", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#9ca3af", display: "block", marginBottom: 2 }}>언어쌍</label>
                    <input value={rateForm.languagePair} onChange={e => setRateForm(p => ({ ...p, languagePair: e.target.value }))}
                      placeholder="EN-KO" style={{ ...inputStyle, fontSize: 12, padding: "6px 8px", width: "100%", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#9ca3af", display: "block", marginBottom: 2 }}>단가 (원)</label>
                    <input type="number" value={rateForm.rate} onChange={e => setRateForm(p => ({ ...p, rate: e.target.value }))}
                      placeholder="50" style={{ ...inputStyle, fontSize: 12, padding: "6px 8px", width: "100%", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "#9ca3af", display: "block", marginBottom: 2 }}>단위</label>
                    <select value={rateForm.unit} onChange={e => setRateForm(p => ({ ...p, unit: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12, padding: "6px 8px" }}>
                      <option value="word">단어</option>
                      <option value="page">페이지</option>
                      <option value="hour">시간</option>
                    </select>
                  </div>
                  <div style={{ marginTop: 16 }}>
                    <PrimaryBtn onClick={addRate} disabled={addingRate || !rateForm.rate} style={{ fontSize: 12, padding: "6px 14px" }}>
                      {addingRate ? "추가 중..." : "+ 추가"}
                    </PrimaryBtn>
                  </div>
                </div>
                {rates.length === 0 ? (
                  <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "12px 0" }}>단가표가 없습니다. 위에서 추가하세요.</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {rates.map(r => (
                      <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 12px", background: "#f9fafb", borderRadius: 8, fontSize: 13 }}>
                        <span style={{ fontWeight: 600, color: "#374151", minWidth: 60 }}>{r.serviceType}</span>
                        <span style={{ color: "#6b7280" }}>{r.languagePair}</span>
                        <span style={{ color: "#059669", fontWeight: 700, marginLeft: "auto" }}>
                          {Number(r.rate).toLocaleString()}원/{r.unit === "word" ? "단어" : r.unit === "page" ? "페이지" : "시간"}
                        </span>
                        <button
                          onClick={() => deleteRate(r.id)}
                          disabled={deletingRate === r.id}
                          style={{ padding: "3px 8px", fontSize: 11, borderRadius: 5, background: "#fee2e2", color: "#dc2626", border: "none", cursor: "pointer", fontWeight: 600 }}>
                          {deletingRate === r.id ? "..." : "삭제"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}
        </>
      )}
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
