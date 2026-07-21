import React, { useState, useEffect } from "react";
import {
  User, Building2, Building, BriefcaseBusiness, Mail, Smartphone,
  Phone, BadgeCheck, CircleCheck, Calendar,
} from "lucide-react";
import { api, ContactDetail, NoteEntry } from "../../lib/constants";
import { formatPhoneDisplay } from "../../lib/utils";
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
  fontSize: 14, fontWeight: 700, color: "#111827",
  borderLeft: "3px solid #6366f1", paddingLeft: 10,
  margin: 0, lineHeight: 1.5,
};

const secRow = (label: string, extra?: React.ReactNode): React.ReactNode => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "20px 0 10px" }}>
    <p style={sH}>{label}</p>
    {extra && <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{extra}</div>}
  </div>
);

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
      <DraggableModal title="담당자 상세" headerExtra={headerExtra} onClose={onClose} width={1100} height="90vh" zIndex={300} bodyPadding="24px 36px" resizable>
        {loading ? (
          <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
        ) : !detail ? (
          <p style={{ color: "#dc2626" }}>데이터를 불러올 수 없습니다.</p>
        ) : (
          <>
            <ReviewMemoPanel storageKey={`contact_${contactId}`} label="이 담당자 검수 메모" />

            {/* ══ Summary Card ══ */}
            <div style={{
              background: "#f0f9ff",
              border: "1px solid #bae6fd",
              borderRadius: 12,
              padding: "16px 20px",
              marginBottom: 6,
              marginTop: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px 10px" }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: "#0c4a6e" }}>{detail.name}</span>

                {/* 담당자 유형 badges */}
                {detail.isPrimary && (
                  <span style={{ fontSize: 12, borderRadius: 20, padding: "3px 11px", fontWeight: 700, background: "#dbeafe", color: "#1d4ed8", border: "1px solid #93c5fd" }}>
                    기본 담당자
                  </span>
                )}
                {detail.isQuoteContact && (
                  <span style={{ fontSize: 12, borderRadius: 20, padding: "3px 11px", fontWeight: 700, background: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7" }}>
                    견적 담당자
                  </span>
                )}
                {detail.isBillingContact && (
                  <span style={{ fontSize: 12, borderRadius: 20, padding: "3px 11px", fontWeight: 700, background: "#ede9fe", color: "#5b21b6", border: "1px solid #c4b5fd" }}>
                    청구 담당자
                  </span>
                )}
                <span style={{
                  fontSize: 12, borderRadius: 20, padding: "3px 11px", fontWeight: 700,
                  background: detail.isActive ? "#dcfce7" : "#f3f4f6",
                  color: detail.isActive ? "#15803d" : "#9ca3af",
                  border: `1px solid ${detail.isActive ? "#86efac" : "#d1d5db"}`,
                }}>
                  {detail.isActive ? "활성" : "비활성"}
                </span>

                {/* 구분 */}
                {(detail.companyName || detail.divisionName || detail.position) && (
                  <>
                    <span style={{ color: "#94a3b8", fontSize: 14, margin: "0 2px" }}>|</span>
                    {detail.companyName && (
                      <span style={{ fontSize: 13, color: "#334155" }}>{detail.companyName}</span>
                    )}
                    {detail.divisionName && (
                      <span style={{ fontSize: 13, color: "#64748b" }}>{detail.divisionName}</span>
                    )}
                    {detail.position && (
                      <span style={{ fontSize: 13, color: "#64748b" }}>{detail.position}</span>
                    )}
                  </>
                )}

                <div style={{ flex: 1 }} />
                <span style={{ color: "#94a3b8", fontSize: 13 }}>|</span>
                <span style={{ fontSize: 13, color: "#0369a1", fontWeight: 600 }}>
                  담당 프로젝트 {detail.projects.length}건
                </span>
                <span style={{ color: "#94a3b8", fontSize: 13 }}>|</span>
                <span style={{ fontSize: 13, color: "#0369a1", fontWeight: 600 }}>
                  메모 {notes.length}건
                </span>
              </div>
            </div>

            {/* ══ 기본 정보 ══ */}
            {secRow("기본 정보", (
              <button onClick={() => setShowEditModal(true)}
                style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "4px 12px", cursor: "pointer" }}>
                정보 수정
              </button>
            ))}
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden", marginBottom: 10 }}>
              {([
                { label: "이름",     icon: <User             size={17} color="#6b7280" />, value: detail.name },
                { label: "거래처",   icon: <Building2        size={17} color="#6b7280" />, value: detail.companyName ?? "-" },
                { label: "브랜드/부서", icon: <Building      size={17} color="#6b7280" />, value: detail.divisionName ?? "-" },
                { label: "직책",     icon: <BriefcaseBusiness size={17} color="#6b7280" />, value: [detail.department, detail.position].filter(Boolean).join(" · ") || "-" },
                { label: "이메일",   icon: <Mail             size={17} color="#6b7280" />, value: detail.email ?? "-" },
                { label: "휴대폰",   icon: <Smartphone       size={17} color="#6b7280" />, value: formatPhoneDisplay(detail.mobile) },
                { label: "전화",     icon: <Phone            size={17} color="#6b7280" />, value: formatPhoneDisplay(detail.phone) },
                ...(detail.memo ? [{ label: "메모", icon: <Mail size={17} color="#6b7280" />, value: detail.memo }] : []),
              ] as { label: string; icon: React.ReactNode; value: string }[]).map(({ label, icon, value }, i, arr) => (
                <div key={label} style={{
                  display: "flex",
                  alignItems: "flex-start",
                  padding: "13px 20px",
                  borderBottom: i < arr.length - 1 ? "1px solid #f3f4f6" : "none",
                  gap: 14,
                  background: i % 2 === 0 ? "#fff" : "#fafafa",
                }}>
                  <span style={{ flexShrink: 0, marginTop: 1, display: "flex" }}>{icon}</span>
                  <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600, width: 140, flexShrink: 0 }}>{label}</span>
                  <div style={{ width: 1, alignSelf: "stretch", background: "#e5e7eb", flexShrink: 0 }} />
                  <span style={{ fontSize: 14, color: "#111827", fontWeight: 600, flex: 1, paddingLeft: 2, whiteSpace: label === "메모" ? "pre-wrap" : undefined }}>{value}</span>
                </div>
              ))}
            </div>

            {/* ══ 상태 정보 Strip ══ */}
            <div style={{
              display: "flex",
              alignItems: "center",
              background: "#f9fafb",
              borderRadius: 10,
              border: "1px solid #e5e7eb",
              padding: "12px 20px",
              gap: 20,
              marginBottom: 10,
            }}>
              {/* 담당자 유형 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <BadgeCheck size={17} color="#6b7280" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>담당자 유형</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {detail.isPrimary && (
                    <span style={{ fontSize: 12, borderRadius: 20, padding: "2px 10px", fontWeight: 700, background: "#dbeafe", color: "#1d4ed8", border: "1px solid #93c5fd" }}>기본</span>
                  )}
                  {detail.isQuoteContact && (
                    <span style={{ fontSize: 12, borderRadius: 20, padding: "2px 10px", fontWeight: 700, background: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7" }}>견적</span>
                  )}
                  {detail.isBillingContact && (
                    <span style={{ fontSize: 12, borderRadius: 20, padding: "2px 10px", fontWeight: 700, background: "#ede9fe", color: "#5b21b6", border: "1px solid #c4b5fd" }}>청구</span>
                  )}
                  {!detail.isPrimary && !detail.isQuoteContact && !detail.isBillingContact && (
                    <span style={{ fontSize: 12, color: "#9ca3af" }}>일반</span>
                  )}
                </div>
              </div>

              <div style={{ width: 1, height: 20, background: "#d1d5db", flexShrink: 0 }} />

              {/* 활성 상태 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <CircleCheck size={17} color="#6b7280" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>상태</span>
                <span style={{
                  fontSize: 12, borderRadius: 20, padding: "2px 10px", fontWeight: 700,
                  background: detail.isActive ? "#dcfce7" : "#f3f4f6",
                  color: detail.isActive ? "#15803d" : "#9ca3af",
                  border: `1px solid ${detail.isActive ? "#86efac" : "#d1d5db"}`,
                }}>
                  {detail.isActive ? "활성" : "비활성"}
                </span>
              </div>

              <div style={{ width: 1, height: 20, background: "#d1d5db", flexShrink: 0 }} />

              {/* 등록일 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Calendar size={17} color="#6b7280" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 600 }}>등록일</span>
                <span style={{ fontSize: 14, color: "#111827", fontWeight: 600 }}>
                  {/* 홈택스 원본 등록일(registeredAt) 우선, 없으면 플랫폼 생성일 fallback */}
                  {((detail as any).registeredAt ?? detail.createdAt) ? new Date((detail as any).registeredAt ?? detail.createdAt).toLocaleDateString("ko-KR") : "-"}
                </span>
              </div>
            </div>

            {/* ══ 연관 프로젝트 ══ */}
            {secRow(`연관 프로젝트 (${detail.projects.length})`)}
            {detail.projects.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>프로젝트가 없습니다.</p>
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

            {/* ══ 커뮤니케이션 이력 ══ */}
            {detail.communications.length > 0 && (
              <>
                {secRow(`커뮤니케이션 이력 (${detail.communications.length})`)}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {detail.communications.map(c => (
                    <div key={c.id} style={{ padding: "10px 14px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#6b7280" }}>{c.type}</span>
                        <span style={{ fontSize: 12, color: "#9ca3af" }}>{new Date(c.createdAt).toLocaleDateString("ko-KR")}</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{c.content}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* ══ 메모 ══ */}
            {secRow(`메모 (${notes.length})`)}
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

      {/* ══ 담당자 수정 모달 ══ */}
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
