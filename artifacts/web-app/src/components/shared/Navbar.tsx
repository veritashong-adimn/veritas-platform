import React, { useState } from "react";
import { api, User, NavPage, Role } from "../../lib/constants";
import { Card, PrimaryBtn, GhostBtn, RoleBadge } from "../ui";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6,
};

function ChangePasswordModal({ token, onClose, onSuccess }: {
  token: string; onClose: () => void; onSuccess: () => void;
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
          <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 16, background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", fontSize: 13 }}>{err}</div>
        )}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>현재 비밀번호</label>
            <input type="password" style={inputStyle} value={current} onChange={e => setCurrent(e.target.value)} placeholder="현재 비밀번호" autoComplete="current-password" />
          </div>
          <div>
            <label style={labelStyle}>새 비밀번호</label>
            <input type="password" style={inputStyle} value={next} onChange={e => setNext(e.target.value)} placeholder="최소 6자" autoComplete="new-password" />
          </div>
          <div>
            <label style={labelStyle}>새 비밀번호 확인</label>
            <input type="password" style={inputStyle} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="동일하게 입력" autoComplete="new-password" />
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
  token: string; currentEmail: string; onClose: () => void; onSuccess: (newEmail: string) => void;
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
        <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 16, background: "#f8fafc", border: "1px solid #e2e8f0", color: "#64748b", fontSize: 13 }}>
          현재 이메일: <strong style={{ color: "#374151" }}>{currentEmail}</strong>
        </div>
        {err && (
          <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 16, background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", fontSize: 13 }}>{err}</div>
        )}
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>새 이메일</label>
            <input type="email" style={inputStyle} value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="example@domain.com" autoComplete="email" autoFocus />
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

export function Navbar({
  user, page, onPageChange, onLogout, token, onEmailChange,
}: {
  user: User; page: NavPage; onPageChange: (p: NavPage) => void;
  onLogout: () => void; token: string; onEmailChange?: (newEmail: string) => void;
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
        <ChangePasswordModal token={token} onClose={() => setShowPwModal(false)} onSuccess={handlePwSuccess} />
      )}
      {showEmailModal && (
        <ChangeEmailModal token={token} currentEmail={user.email} onClose={() => setShowEmailModal(false)} onSuccess={handleEmailSuccess} />
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
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, height: 56,
        background: "#fff", borderBottom: "1px solid #e5e7eb",
        display: "flex", alignItems: "center", padding: "0 24px", gap: 0,
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
            <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "3px 9px" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", letterSpacing: "0.05em" }}>ADMIN</span>
            </div>
          )}
          <RoleBadge role={user.role as Role} />
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
            background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer", fontWeight: 500,
          }}>로그아웃</button>
        </div>
      </nav>
    </>
  );
}
