import React, { useState } from "react";
import { api, User } from "../lib/constants";
import { Card, PrimaryBtn } from "../components/ui";
import { takeReloginNotice } from "../components/shared/MyAccount";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6,
};

// 아이디 기억하기 — 이메일만 저장한다(비밀번호·토큰 등 인증정보는 절대 저장하지 않음).
//   로그아웃(clearAuth)은 인증 키만 지우므로 이 값은 유지된다. 저장소 접근 불가 시 기능만 비활성.
const REMEMBER_EMAIL_KEY = "veritas_remembered_email";
const readRememberedEmail = (): string => {
  try { return localStorage.getItem(REMEMBER_EMAIL_KEY) ?? ""; } catch { return ""; }
};
const writeRememberedEmail = (value: string | null) => {
  try {
    if (value) localStorage.setItem(REMEMBER_EMAIL_KEY, value);
    else localStorage.removeItem(REMEMBER_EMAIL_KEY);
  } catch { /* 저장소 사용 불가 — 무시 */ }
};

export function AuthPage({ onAuth }: { onAuth: (token: string, user: User, permissions?: string[]) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState(readRememberedEmail);
  const [rememberEmail, setRememberEmail] = useState(() => readRememberedEmail() !== "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"customer" | "translator">("customer");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  // 비밀번호 변경 직후 재로그인 안내(1회)
  const [notice] = useState(takeReloginNotice);

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
      // 로그인 성공 시에만 저장/갱신(실패 시 저장하지 않음). 회원가입에는 적용하지 않는다.
      if (mode === "login" && rememberEmail) writeRememberedEmail(email.trim());
      onAuth(data.token, data.user, data.user?.permissions ?? []);
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
            width: 52, height: 52, background: "#0b1220", borderRadius: 14,
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 14px",
          }}>
            <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
              <defs>
                <linearGradient id="vg_a" x1="2" y1="4" x2="30" y2="29" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#6366f1"/>
                  <stop offset="100%" stopColor="#22d3ee"/>
                </linearGradient>
              </defs>
              <path fillRule="evenodd" d="M2,4 L30,4 L16,29 Z M10,4 L22,4 L16,24 Z" fill="url(#vg_a)"/>
            </svg>
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "#111827", letterSpacing: "0.06em" }}>
            VERITAS <span style={{ fontWeight: 700, color: "#6366f1" }}>OS</span>
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "#9ca3af", letterSpacing: "0.05em" }}>AI Platform</p>
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

          {notice && !msg && (
            <div role="status" data-testid="relogin-notice" style={{
              padding: "10px 14px", borderRadius: 8, marginBottom: 16,
              background: "#f0fdf4", border: "1px solid #86efac", color: "#15803d", fontSize: 13,
            }}>{notice}</div>
          )}
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
                onChange={e => setPassword(e.target.value)} placeholder={mode === "login" ? "비밀번호" : "최소 6자 이상"} />
            </div>

            {mode === "login" && (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#374151", cursor: "pointer", userSelect: "none", marginTop: -4 }}>
                <input type="checkbox" checked={rememberEmail}
                  onChange={e => {
                    setRememberEmail(e.target.checked);
                    if (!e.target.checked) writeRememberedEmail(null); // 해제 즉시 삭제
                  }}
                  data-testid="checkbox-remember-email" aria-label="아이디 기억하기"
                  style={{ width: 15, height: 15, margin: 0, accentColor: "#2563eb", cursor: "pointer" }} />
                아이디 기억하기
              </label>
            )}

            {mode === "register" && (
              <div>
                <label style={labelStyle}>가입 유형</label>
                <div style={{ display: "flex", gap: 10 }}>
                  {(["customer", "translator"] as const).map((r) => (
                    <label key={r} style={{
                      flex: 1, display: "flex", alignItems: "center", gap: 8,
                      padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                      border: `2px solid ${role === r ? "#2563eb" : "#e5e7eb"}`,
                      background: role === r ? "#eff6ff" : "#fff",
                    }}>
                      <input type="radio" name="role" value={r} checked={role === r}
                        onChange={() => setRole(r)} style={{ accentColor: "#2563eb" }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: role === r ? "#1d4ed8" : "#374151" }}>
                        {r === "customer" ? "고객" : "통번역사"}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <PrimaryBtn disabled={loading} style={{ marginTop: 4, padding: "11px" }}>
              {loading ? (mode === "login" ? "로그인 중..." : "가입 중...") : (mode === "login" ? "로그인" : "회원가입")}
            </PrimaryBtn>
          </form>
        </Card>
      </div>
    </div>
  );
}
