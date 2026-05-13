import React, { useState, useEffect } from "react";
import { api, ContactDetail, NoteEntry } from "../../lib/constants";
import { StatusBadge, PrimaryBtn } from "../ui";
import { ReviewMemoPanel } from "./ReviewMemoPanel";
import { DraggableModal } from "./DraggableModal";
import { ContactFormModal } from "./ContactFormModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 11px", borderRadius: 7,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const sH: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.06em",
  margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};
const readLabel: React.CSSProperties = { color: "#9ca3af", minWidth: 64, fontSize: 13, flexShrink: 0 };
const readValue: React.CSSProperties = { color: "#374151", fontSize: 13 };

export function ContactDetailModal({ contactId, token, onClose, onToast, onOpenProject, onRefreshList }: {
  contactId: number; token: string; onClose: () => void;
  onToast: (msg: string) => void; onOpenProject: (id: number) => void;
  onRefreshList?: () => void;
}) {
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

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

  const headerExtra = !loading && detail ? (
    <button
      onClick={() => setShowEditModal(true)}
      style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "4px 14px", cursor: "pointer" }}>
      수정
    </button>
  ) : null;

  return (
    <>
      <DraggableModal title="담당자 상세" headerExtra={headerExtra} onClose={onClose} width={720} zIndex={300} bodyPadding="20px 28px" resizable>
        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
        ) : !detail ? (
          <p style={{ color: "#dc2626" }}>데이터를 불러올 수 없습니다.</p>
        ) : (
          <>
            <ReviewMemoPanel storageKey={`contact_${contactId}`} label="이 담당자 검수 메모" />

            {/* ── 기본 정보 ── */}
            <p style={sH}>기본 정보</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", marginBottom: 8 }}>
              {([
                ["이름", detail.name],
                ["거래처", detail.companyName ?? "-"],
                ["브랜드/부서", detail.divisionName ?? "-"],
                ["부서", detail.department ?? "-"],
                ["직책", detail.position ?? "-"],
                ["이메일", detail.email ?? "-"],
                ["전화", detail.phone ?? "-"],
                ["휴대폰", detail.mobile ?? "-"],
                ["사무실", detail.officePhone ?? "-"],
              ] as [string, string][]).map(([l, v]) => (
                <div key={l} style={{ display: "flex", gap: 6, marginBottom: 5, alignItems: "flex-start" }}>
                  <span style={readLabel}>{l}</span>
                  <span style={{ ...readValue, fontWeight: l === "이름" ? 700 : 400 }}>{v}</span>
                </div>
              ))}
              {detail.memo && (
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 6, marginTop: 2 }}>
                  <span style={readLabel}>메모</span>
                  <span style={{ ...readValue, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{detail.memo}</span>
                </div>
              )}
            </div>

            {/* ── 역할 ── */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              {detail.isPrimary && <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 5, padding: "2px 8px", fontWeight: 700 }}>기본 담당자</span>}
              {detail.isQuoteContact && <span style={{ fontSize: 11, background: "#d1fae5", color: "#065f46", borderRadius: 5, padding: "2px 8px", fontWeight: 700 }}>견적 담당자</span>}
              {detail.isBillingContact && <span style={{ fontSize: 11, background: "#ede9fe", color: "#5b21b6", borderRadius: 5, padding: "2px 8px", fontWeight: 700 }}>청구 담당자</span>}
              <span style={{ fontSize: 11, background: detail.isActive ? "#d1fae5" : "#f3f4f6", color: detail.isActive ? "#065f46" : "#9ca3af", borderRadius: 5, padding: "2px 8px", fontWeight: 600 }}>
                {detail.isActive ? "활성" : "비활성"}
              </span>
            </div>

            {/* ── 연관 프로젝트 ── */}
            <p style={{ ...sH, marginTop: 20 }}>연관 프로젝트 ({detail.projects.length})</p>
            {detail.projects.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>프로젝트가 없습니다.</p>
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
                    <span style={{ color: "#9ca3af", fontSize: 12 }}>{new Date(p.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </div>
            )}

            {/* ── 커뮤니케이션 이력 ── */}
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

            {/* ── 메모 ── */}
            <p style={{ ...sH, marginTop: 20 }}>메모 ({notes.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="메모 입력..."
                style={{ ...inputStyle, flex: 1, padding: "7px 10px" }}
                onKeyDown={e => e.key === "Enter" && handleAddNote()} />
              <PrimaryBtn onClick={handleAddNote} disabled={addingNote || !noteText.trim()} style={{ fontSize: 13, padding: "7px 14px" }}>
                {addingNote ? "추가 중..." : "추가"}
              </PrimaryBtn>
            </div>
            {notes.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>메모가 없습니다.</p>
            ) : (
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
      </DraggableModal>

      {/* ── 담당자 수정 모달 ── */}
      {showEditModal && detail && (
        <ContactFormModal
          mode="edit"
          token={token}
          contactId={contactId}
          initialData={detail}
          onClose={() => setShowEditModal(false)}
          onSuccess={async () => {
            setShowEditModal(false);
            await load();
            onRefreshList?.();
          }}
          onToast={onToast}
        />
      )}
    </>
  );
}
