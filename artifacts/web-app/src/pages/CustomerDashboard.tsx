import React, { useState, useCallback, useEffect } from "react";
import { api, User, Project, PaymentPanel } from "../lib/constants";
import { Card, Toast, PrimaryBtn, GhostBtn } from "../components/ui";
import { ProjectCard, PaymentModal } from "../components/projects";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 6,
};

export function CustomerDashboard({ user, token }: { user: User; token: string }) {
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
