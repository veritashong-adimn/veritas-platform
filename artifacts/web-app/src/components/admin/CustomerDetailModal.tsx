import React, { useState, useEffect } from "react";
import { api, CustomerDetail, Communication, COMM_TYPE_LABEL, COMM_TYPE_COLOR } from "../../lib/constants";
import { StatusBadge, PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const sH: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.06em",
  margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};

export function CustomerDetailModal({ customerId, token, onClose, onToast, onOpenProject }: {
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

  return (
    <DraggableModal title={`고객 #${customerId} 상세`} onClose={onClose} width={760} zIndex={300} bodyPadding="20px 28px">

        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
        ) : !detail ? (
          <p style={{ color: "#dc2626" }}>고객 데이터를 불러올 수 없습니다.</p>
        ) : (
          <>
            <p style={sH}>고객 정보</p>
            {!editing ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 24px" }}>
                {[["회사명", detail.companyName], ["담당자", detail.contactName], ["이메일", detail.email], ["전화", detail.phone ?? "-"], ["등록일", new Date(detail.createdAt).toLocaleDateString("ko-KR")]].map(([label, val]) => (
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
                    <input value={editForm[field]} onChange={e => setEditForm(f => ({ ...f, [field]: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                ))}
                <div style={{ gridColumn: "span 2", display: "flex", gap: 8, marginTop: 4 }}>
                  <PrimaryBtn onClick={handleSaveEdit} style={{ fontSize: 13, padding: "7px 16px" }}>저장</PrimaryBtn>
                  <GhostBtn onClick={() => setEditing(false)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                </div>
              </div>
            )}

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

            <p style={sH}>프로젝트 목록 ({detail.projects.length})</p>
            {detail.projects.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "12px 0" }}>등록된 프로젝트가 없습니다.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.projects.map(p => (
                  <div key={p.id} onClick={() => { onClose(); onOpenProject(p.id); }}
                    style={{ display: "flex", gap: 16, padding: "10px 14px", background: "#f9fafb", borderRadius: 8, fontSize: 13, cursor: "pointer", alignItems: "center", border: "1px solid transparent" }}
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

            <p style={sH}>커뮤니케이션 기록 ({comms.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <ClickSelect value={commType} onChange={v => setCommType(v as "email"|"phone"|"message")}
                triggerStyle={{ fontSize: 13, padding: "7px 10px" }}
                options={[
                  { value: "message", label: "메시지" }, { value: "email", label: "이메일" }, { value: "phone", label: "전화" },
                ]} />
              <input value={commContent} onChange={e => setCommContent(e.target.value)} placeholder="내용 입력..."
                style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "8px 10px", minWidth: 200 }}
                onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleAddComm()} />
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
                      <span style={{ padding: "2px 9px", borderRadius: 12, fontSize: 11, fontWeight: 700, background: `${COMM_TYPE_COLOR[c.type]}18`, color: COMM_TYPE_COLOR[c.type] }}>
                        {COMM_TYPE_LABEL[c.type]}
                      </span>
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(c.createdAt).toLocaleString("ko-KR")}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{c.content}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
    </DraggableModal>
  );
}
