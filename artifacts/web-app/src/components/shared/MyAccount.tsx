import React, { useEffect, useRef, useState } from "react";
import { api, User } from "../../lib/constants";

// ─── 내 계정 · 본인 비밀번호 변경 ─────────────────────────────────────────────
//  · 서버 /api/auth/change-password(본인만, 현재 비밀번호 확인, 횟수 제한) 호출. 비밀번호 값은 어디에도 저장하지 않는다.
//  · 성공 시 서버가 기존 토큰을 모두 무효화 → 화면은 로그아웃 후 로그인 화면에 안내 문구를 띄운다.

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;
export const PASSWORD_RECOMMENDED_LENGTH = 12;   // 권장(강제 아님)
// 흔한 취약 비밀번호 — 서버(api-server routes/auth.ts)와 같은 목록·규칙(소문자 비교). 한쪽을 바꾸면 다른 쪽도 함께 바꾼다.
const COMMON_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000", "88888888", "12341234", "11223344", "1q2w3e4r", "1q2w3e4r5t",
  "1qaz2wsx", "qwer1234", "qwerty12", "qwerty123", "qwertyuiop", "asdf1234", "asdfghjkl", "zxcvbnm1", "zxcvbnm123", "abcd1234", "abc12345",
  "a1b2c3d4", "aa123456", "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "p@ssword", "iloveyou", "sunshine",
  "princess", "football", "baseball", "superman", "welcome1", "letmein1", "trustno1", "dragon12", "monkey12", "changeme", "admin123",
  "admin1234", "administrator", "test1234", "user1234", "guest1234", "veritas1", "veritas123", "veritas1234", "veritasos",
]);
const KEYBOARD_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
export function weakPasswordReason(pw: string): string | null {
  const s = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(s)) return "흔히 사용되는 비밀번호입니다.";
  if (/^(.)\1+$/.test(s)) return "같은 문자만 반복한 비밀번호입니다.";
  const codes = [...s].map(c => c.charCodeAt(0));
  const step = codes[1] - codes[0];
  if ((step === 1 || step === -1) && codes.every((c, i) => i === 0 || c - codes[i - 1] === step)) return "연속된 문자·숫자로만 된 비밀번호입니다.";
  if (KEYBOARD_ROWS.some(r => r.includes(s) || [...r].reverse().join("").includes(s))) return "키보드 배열 순서로만 된 비밀번호입니다.";
  if (/^(password|passw0rd|p@ssw0rd|qwerty|admin|veritas|welcome|letmein|iloveyou|test|user|guest|abcd|love)[\d!@#$%^&*._\-~]*$/.test(s)) return "흔한 단어에 숫자·기호만 붙인 비밀번호입니다.";
  return null;
}

/** 새 비밀번호 검증 — 서버 validateNewPassword 와 같은 기준(현재 비밀번호 일치·재사용 여부는 서버가 최종 판정) */
export function validateNewPassword(pw: string, email?: string | null): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return `새 비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상 입력해 주세요.`;
  if (pw.length > PASSWORD_MAX_LENGTH) return `새 비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하로 입력해 주세요.`;
  if (new TextEncoder().encode(pw).length > 72) return "새 비밀번호가 너무 깁니다. 한글 등은 더 짧게 입력해 주세요.";
  if (!pw.trim()) return "공백만으로 된 비밀번호는 사용할 수 없습니다.";
  if (email && pw.trim().toLowerCase() === email.trim().toLowerCase()) return "이메일과 같은 비밀번호는 사용할 수 없습니다.";
  const weak = weakPasswordReason(pw);
  if (weak) return `${weak} 다른 비밀번호를 사용해 주세요.`;
  return null;
}


// 로그인 화면 안내 — 비밀번호 변경 후 재로그인 유도(세션 저장소, 1회 표시)
const NOTICE_KEY = "veritas_relogin_notice";
export function setReloginNotice(msg: string) { try { sessionStorage.setItem(NOTICE_KEY, msg); } catch { /* 무시 */ } }
export function takeReloginNotice(): string {
  try { const m = sessionStorage.getItem(NOTICE_KEY) ?? ""; sessionStorage.removeItem(NOTICE_KEY); return m; } catch { return ""; }
}
export const RELOGIN_MSG = "비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해 주세요.";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 64px 9px 12px", borderRadius: 8, border: "1px solid #d1d5db",
  fontSize: 14, color: "#111827", outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6 };

function PasswordField({ id, label, value, onChange, autoComplete, placeholder, autoFocus }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; placeholder?: string; autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <div style={{ position: "relative" }}>
        <input id={id} type={show ? "text" : "password"} value={value} onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete} placeholder={placeholder} autoFocus={autoFocus} style={inputStyle}
          aria-label={label} data-testid={`pw-input-${id}`} spellCheck={false} autoCapitalize="off" />
        <button type="button" onClick={() => setShow(v => !v)} aria-pressed={show}
          aria-label={`${label} ${show ? "숨기기" : "표시"}`} data-testid={`pw-toggle-${id}`}
          style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", padding: "4px 8px", fontSize: 12,
            background: "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: 6, color: "#4b5563", cursor: "pointer" }}>
          {show ? "숨기기" : "표시"}
        </button>
      </div>
    </div>
  );
}

export function ChangePasswordForm({ token, email, onSuccess, onCancel }: { token: string; email?: string | null; onSuccess: () => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const lengthOk = next.length >= PASSWORD_MIN_LENGTH && next.length <= PASSWORD_MAX_LENGTH;
  const nextErr = next ? validateNewPassword(next, email) : null;
  const matchOk = confirm.length > 0 && next === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!current || !next || !confirm) { setErr("모든 항목을 입력해 주세요."); return; }
    const policyErr = validateNewPassword(next, email);
    if (policyErr) { setErr(policyErr); return; }
    if (next !== confirm) { setErr("새 비밀번호와 확인 비밀번호가 일치하지 않습니다."); return; }
    if (next === current) { setErr("현재 사용 중인 비밀번호는 다시 사용할 수 없습니다."); return; }
    setLoading(true);
    try {
      const res = await fetch(api("/api/auth/change-password"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: current, newPassword: next, confirmPassword: confirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.error ?? "비밀번호 변경에 실패했습니다."); return; }
      setCurrent(""); setNext(""); setConfirm("");
      onSuccess();
    } catch { setErr("서버에 연결할 수 없습니다."); }
    finally { setLoading(false); }
  };

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="change-password-form" aria-label="비밀번호 변경">
      {err && (
        <div role="alert" data-testid="change-password-error"
          style={{ padding: "10px 14px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", fontSize: 13 }}>{err}</div>
      )}
      <PasswordField id="current" label="현재 비밀번호" value={current} onChange={setCurrent} autoComplete="current-password" autoFocus />
      <div>
        <PasswordField id="new" label="새 비밀번호" value={next} onChange={setNext} autoComplete="new-password" placeholder={`${PASSWORD_MIN_LENGTH}자 이상 입력`} />
        <div style={{ fontSize: 11.5, marginTop: 4, color: next ? (nextErr ? "#b45309" : "#15803d") : "#9ca3af" }} data-testid="pw-hint-length">
          {next && nextErr ? nextErr : <>{next ? "✓ " : "· "}{PASSWORD_MIN_LENGTH}자 이상 입력 · {PASSWORD_RECOMMENDED_LENGTH}자 이상 권장 · 현재 비밀번호와 다르게</>}
          {next && !nextErr && lengthOk && next.length < PASSWORD_RECOMMENDED_LENGTH && <span style={{ color: "#9ca3af" }}> (더 길게 하면 안전합니다)</span>}
        </div>
      </div>
      <div>
        <PasswordField id="confirm" label="새 비밀번호 확인" value={confirm} onChange={setConfirm} autoComplete="new-password" placeholder="한 번 더 입력" />
        {confirm && (
          <div style={{ fontSize: 11.5, marginTop: 4, color: matchOk ? "#15803d" : "#dc2626" }} data-testid="pw-hint-match">
            {matchOk ? "✓ 새 비밀번호와 일치합니다." : "새 비밀번호와 일치하지 않습니다."}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button type="submit" disabled={loading} aria-label="비밀번호 변경" data-testid="change-password-submit"
          style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: loading ? "#a5b4fc" : "#4f46e5", color: "#fff",
            fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer" }}>
          {loading ? "변경 중..." : "비밀번호 변경"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={loading} aria-label="취소" data-testid="change-password-cancel"
            style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 14, cursor: "pointer" }}>
            취소
          </button>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "#9ca3af", textAlign: "center" }}>
        변경하면 모든 기기에서 로그아웃되며, 새 비밀번호로 다시 로그인해야 합니다.
      </p>
    </form>
  );
}

export function ChangePasswordModal({ token, email, onClose, onSuccess }: { token: string; email?: string | null; onClose: () => void; onSuccess: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="비밀번호 변경" data-testid="change-password-modal"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400 }}>
      <div style={{ width: "100%", maxWidth: 420, margin: "0 16px", background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 10px 30px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#111827" }}>비밀번호 변경</h2>
          <button type="button" onClick={onClose} aria-label="닫기" data-testid="change-password-close"
            style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af", lineHeight: 1 }}>×</button>
        </div>
        <ChangePasswordForm token={token} email={email} onSuccess={onSuccess} onCancel={onClose} />
      </div>
    </div>
  );
}

/** 비밀번호 변경 성공 공통 처리 — 안내 문구를 남기고 로그아웃(서버에서 기존 토큰은 이미 무효) */
export function finishPasswordChange(onLogout?: () => void) {
  setReloginNotice(RELOGIN_MSG);
  onLogout?.();
}

/** 임시 비밀번호 계정 — 최초 로그인 후 변경 전까지 이 화면만 표시(서버도 다른 API 를 막는다) */
export function ForcePasswordChangePage({ user, token, onLogout }: { user: User; token: string; onLogout: () => void }) {
  return (
    <div data-testid="force-password-change" style={{ minHeight: "100vh", background: "#f9fafb", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 440, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 28 }}>
        <h1 style={{ margin: "0 0 6px", fontSize: 19, fontWeight: 800, color: "#111827" }}>비밀번호 변경이 필요합니다</h1>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "#6b7280", lineHeight: 1.6 }}>
          <b style={{ color: "#374151" }}>{user.email}</b> 계정은 관리자가 발급한 임시 비밀번호로 로그인했습니다.
          계속하려면 본인만 아는 새 비밀번호로 변경해 주세요.
        </p>
        <ChangePasswordForm token={token} email={user.email} onSuccess={() => finishPasswordChange(onLogout)} />
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button type="button" onClick={onLogout} aria-label="로그아웃" data-testid="force-password-logout"
            style={{ background: "none", border: "none", color: "#6b7280", fontSize: 12.5, textDecoration: "underline", cursor: "pointer" }}>로그아웃</button>
        </div>
      </div>
    </div>
  );
}

/** 관리자 사이드바 하단 계정 영역 — 클릭하면 '내 계정' 메뉴(비밀번호 변경·로그아웃) */
export function SidebarAccountMenu({ user, token, roleLabel, onLogout }: { user: User; token: string; roleLabel: string; onLogout?: () => void }) {
  const [open, setOpen] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const item: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", padding: "9px 14px", background: "none", border: "none",
    color: "#e5e7eb", fontSize: 13, cursor: "pointer" };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="내 계정 메뉴 열기" data-testid="sidebar-account"
        style={{ display: "block", width: "100%", textAlign: "left", background: open ? "#232a3a" : "transparent", border: "none", borderRadius: 6,
          padding: "4px 6px", margin: "0 -6px 8px", cursor: "pointer" }}>
        <div style={{ fontSize: 12, color: "#c3c9d5", marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {user.name ? `${user.name} · ` : ""}{user.email}
        </div>
        <div style={{ fontSize: 10, color: "#5a6478" }}>{roleLabel} · 내 계정 ▾</div>
      </button>
      {open && (
        <div role="menu" aria-label="내 계정" data-testid="account-menu"
          style={{ position: "absolute", bottom: "100%", left: 0, right: 0, marginBottom: 6, background: "#1f2533", border: "1px solid #3d4558",
            borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.35)", overflow: "hidden", zIndex: 50 }}>
          <div style={{ padding: "8px 14px", fontSize: 11, color: "#8892a4", borderBottom: "1px solid #2d3547" }}>내 계정</div>
          <button type="button" role="menuitem" style={item} aria-label="비밀번호 변경" data-testid="account-menu-change-password"
            onClick={() => { setOpen(false); setShowPw(true); }}>🔒 비밀번호 변경</button>
          {onLogout && (
            <button type="button" role="menuitem" style={{ ...item, borderTop: "1px solid #2d3547" }} aria-label="로그아웃" data-testid="account-menu-logout"
              onClick={() => { setOpen(false); onLogout(); }}>로그아웃</button>
          )}
        </div>
      )}
      {showPw && (
        <ChangePasswordModal token={token} email={user.email} onClose={() => setShowPw(false)}
          onSuccess={() => { setShowPw(false); setDone(true); setTimeout(() => finishPasswordChange(onLogout), 1500); }} />
      )}
      {done && (
        <div role="status" data-testid="change-password-done"
          style={{ position: "fixed", top: 24, right: 24, zIndex: 500, padding: "12px 18px", borderRadius: 8, background: "#f0fdf4",
            border: "1px solid #86efac", color: "#15803d", boxShadow: "0 4px 12px rgba(0,0,0,0.1)", fontSize: 14 }}>
          ✓ {RELOGIN_MSG}
        </div>
      )}
    </div>
  );
}
