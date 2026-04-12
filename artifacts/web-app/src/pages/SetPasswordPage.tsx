import { useState, useEffect } from "react";
import { api } from "../lib/constants";
import { Card } from "../components/ui";

type Step = "loading" | "form" | "done" | "invalid";

export function SetPasswordPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";

  const [step, setStep] = useState<Step>("loading");
  const [userInfo, setUserInfo] = useState<{ email: string; name: string } | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) { setStep("invalid"); return; }
    fetch(api(`/api/auth/invite/${token}`))
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.email) { setUserInfo({ email: d.email, name: d.name ?? "" }); setStep("form"); }
        else setStep("invalid");
      })
      .catch(() => setStep("invalid"));
  }, [token]);

  const handleSubmit = async () => {
    setErrMsg("");
    if (!password) { setErrMsg("비밀번호를 입력하세요."); return; }
    if (password.length < 8) { setErrMsg("비밀번호는 8자 이상이어야 합니다."); return; }
    if (password !== confirm) { setErrMsg("비밀번호가 일치하지 않습니다."); return; }
    setSubmitting(true);
    try {
      const res = await fetch(api("/api/auth/set-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) { setErrMsg(data.error ?? "오류가 발생했습니다."); return; }
      setStep("done");
    } catch {
      setErrMsg("서버 연결에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const inputSt: React.CSSProperties = {
    width: "100%", padding: "10px 12px", borderRadius: 8,
    border: "1px solid #d1d5db", fontSize: 14, outline: "none",
    boxSizing: "border-box", color: "#111827",
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#f9fafb", fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif",
      padding: "24px",
    }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <p style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 800, color: "#111827" }}>비밀번호 설정</p>
          <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>통번역 플랫폼 계정을 활성화합니다</p>
        </div>

        <Card style={{ padding: "28px 32px" }}>
          {step === "loading" && (
            <p style={{ textAlign: "center", color: "#9ca3af", fontSize: 14 }}>링크를 확인하는 중...</p>
          )}

          {step === "invalid" && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
              <p style={{ fontWeight: 700, color: "#dc2626", marginBottom: 6 }}>유효하지 않은 링크</p>
              <p style={{ fontSize: 13, color: "#6b7280" }}>
                이 초대 링크는 만료되었거나 이미 사용되었습니다.<br />
                관리자에게 새 초대 링크를 요청하세요.
              </p>
            </div>
          )}

          {step === "form" && userInfo && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "10px 14px" }}>
                <p style={{ margin: 0, fontSize: 12, color: "#065f46" }}>
                  <strong>{userInfo.name || userInfo.email}</strong> 계정으로 초대받으셨습니다.
                  {userInfo.name && <span style={{ color: "#6b7280" }}> ({userInfo.email})</span>}
                </p>
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>
                  새 비밀번호 <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="password" value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="8자 이상"
                  style={inputSt}
                  onKeyDown={e => e.key === "Enter" && handleSubmit()}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>
                  비밀번호 확인 <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <input
                  type="password" value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder="비밀번호 재입력"
                  style={inputSt}
                  onKeyDown={e => e.key === "Enter" && handleSubmit()}
                />
              </div>

              {errMsg && (
                <p style={{ margin: 0, fontSize: 12, color: "#dc2626", background: "#fef2f2", padding: "8px 12px", borderRadius: 6 }}>
                  {errMsg}
                </p>
              )}

              <button
                onClick={handleSubmit}
                disabled={submitting}
                style={{
                  width: "100%", padding: "11px 0", borderRadius: 8, border: "none",
                  background: submitting ? "#93c5fd" : "#2563eb", color: "#fff",
                  fontSize: 14, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer",
                  marginTop: 4,
                }}>
                {submitting ? "처리 중..." : "비밀번호 설정"}
              </button>
            </div>
          )}

          {step === "done" && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
              <p style={{ fontWeight: 700, color: "#111827", fontSize: 16, marginBottom: 6 }}>비밀번호 설정 완료</p>
              <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>
                이제 이메일과 설정한 비밀번호로 로그인할 수 있습니다.
              </p>
              <button
                onClick={() => window.location.replace("/")}
                style={{
                  width: "100%", padding: "10px 0", borderRadius: 8, border: "none",
                  background: "#2563eb", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
                }}>
                로그인 페이지로 이동
              </button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
