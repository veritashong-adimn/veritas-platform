import React, { useState, useEffect } from "react";
import { api, ContactDetail, NoteEntry } from "../../lib/constants";
import { StatusBadge, PrimaryBtn } from "../ui";
import { ReviewMemoPanel } from "./ReviewMemoPanel";
import { DraggableModal } from "./DraggableModal";

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

type EditForm = {
  name: string; department: string; position: string;
  email: string; phone: string; mobile: string; officePhone: string;
  memo: string;
};

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

  // ── 편집 모드 ──────────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>({ name: "", department: "", position: "", email: "", phone: "", mobile: "", officePhone: "", memo: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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

  const enterEdit = () => {
    if (!detail) return;
    setEditForm({
      name: detail.name ?? "",
      department: detail.department ?? "",
      position: detail.position ?? "",
      email: detail.email ?? "",
      phone: detail.phone ?? "",
      mobile: detail.mobile ?? "",
      officePhone: detail.officePhone ?? "",
      memo: detail.memo ?? "",
    });
    setFormError(null);
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setFormError(null);
  };

  const handleSave = async () => {
    if (!editForm.name.trim()) { setFormError("이름은 필수입니다."); return; }
    if (editForm.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editForm.email.trim())) {
      setFormError("이메일 형식이 올바르지 않습니다."); return;
    }
    setFormError(null);
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/contacts/${contactId}`), {
        method: "PATCH",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          department: editForm.department.trim() || null,
          position: editForm.position.trim() || null,
          email: editForm.email.trim() || null,
          phone: editForm.phone.trim() || null,
          mobile: editForm.mobile.trim() || null,
          officePhone: editForm.officePhone.trim() || null,
          memo: editForm.memo.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setFormError(data.error ?? "저장에 실패했습니다."); return; }
      onToast("담당자 정보가 수정되었습니다.");
      setEditMode(false);
      await load();
      onRefreshList?.();
    } catch { setFormError("저장 중 오류가 발생했습니다."); }
    finally { setSaving(false); }
  };

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

  const ef = (k: keyof EditForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setEditForm(prev => ({ ...prev, [k]: e.target.value }));

  // ── 모달 제목 영역 오른쪽 버튼 ──────────────────────────────────────────────
  const headerExtra = !loading && detail && !editMode ? (
    <button
      onClick={enterEdit}
      style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 6, padding: "4px 14px", cursor: "pointer" }}>
      수정
    </button>
  ) : null;

  return (
    <DraggableModal title="담당자 상세" headerExtra={headerExtra} onClose={onClose} width={720} zIndex={300} bodyPadding="20px 28px">
      {loading ? (
        <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p>
      ) : !detail ? (
        <p style={{ color: "#dc2626" }}>데이터를 불러올 수 없습니다.</p>
      ) : (
        <>
          <ReviewMemoPanel storageKey={`contact_${contactId}`} label="이 담당자 검수 메모" />

          {/* ── 기본 정보 ────────────────────────────────────────────────────── */}
          <p style={sH}>기본 정보</p>

          {editMode ? (
            /* ── 편집 모드 ───────────────────────────────────────────────────── */
            <div>
              {/* 거래처 (읽기 전용) */}
              <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                <span style={{ ...readLabel, minWidth: 76 }}>거래처</span>
                <span style={{ fontSize: 13, color: "#6b7280", background: "#f3f4f6", borderRadius: 6, padding: "6px 11px", flex: 1 }}>
                  {detail.companyName ?? "-"}
                  <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 8 }}>(변경 불가)</span>
                </span>
              </div>

              {/* 편집 가능 필드 */}
              {([
                { k: "name" as const, label: "이름 *", placeholder: "홍길동" },
                { k: "department" as const, label: "부서", placeholder: "마케팅팀" },
                { k: "position" as const, label: "직책", placeholder: "과장" },
                { k: "email" as const, label: "이메일", placeholder: "contact@company.com" },
                { k: "phone" as const, label: "전화", placeholder: "02-1234-5678" },
                { k: "mobile" as const, label: "휴대폰", placeholder: "010-1234-5678" },
                { k: "officePhone" as const, label: "사무실", placeholder: "02-9999-0000" },
              ]).map(({ k, label, placeholder }) => (
                <div key={k} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  <label style={{ ...readLabel, minWidth: 76 }}>{label}</label>
                  <input
                    value={editForm[k]}
                    onChange={ef(k)}
                    placeholder={placeholder}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                </div>
              ))}

              {/* 메모 */}
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
                <label style={{ ...readLabel, minWidth: 76, paddingTop: 8 }}>메모</label>
                <textarea
                  value={editForm.memo}
                  onChange={ef("memo")}
                  rows={3}
                  placeholder="담당자 특이사항, 선호사항 등"
                  style={{ ...inputStyle, flex: 1, resize: "vertical", lineHeight: 1.5 }}
                />
              </div>

              {/* 오류 메시지 */}
              {formError && (
                <div style={{ margin: "6px 0 10px", padding: "8px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 7, fontSize: 13, color: "#dc2626", fontWeight: 600 }}>
                  {formError}
                </div>
              )}

              {/* 저장 / 취소 버튼 */}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16, paddingTop: 12, borderTop: "1px solid #f3f4f6" }}>
                <button
                  onClick={cancelEdit}
                  disabled={saving}
                  style={{ padding: "8px 20px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, cursor: "pointer", color: "#374151", fontWeight: 500 }}>
                  취소
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !editForm.name.trim()}
                  style={{ padding: "8px 22px", borderRadius: 7, border: "none", background: saving || !editForm.name.trim() ? "#9ca3af" : "#2563eb", fontSize: 13, fontWeight: 700, cursor: saving || !editForm.name.trim() ? "not-allowed" : "pointer", color: "#fff" }}>
                  {saving ? "저장 중..." : "저장"}
                </button>
              </div>
            </div>
          ) : (
            /* ── 보기 모드 ───────────────────────────────────────────────────── */
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px", marginBottom: 8 }}>
              {([
                ["이름", detail.name],
                ["거래처", detail.companyName ?? "-"],
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
              {(detail.memo) && (
                <div style={{ gridColumn: "1 / -1", display: "flex", gap: 6, marginTop: 2 }}>
                  <span style={readLabel}>메모</span>
                  <span style={{ ...readValue, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{detail.memo}</span>
                </div>
              )}
            </div>
          )}

          {/* ── 연관 프로젝트 ─────────────────────────────────────────────────── */}
          {!editMode && (
            <>
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

              {/* ── 커뮤니케이션 이력 ─────────────────────────────────────────── */}
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

              {/* ── 메모 ──────────────────────────────────────────────────────── */}
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
        </>
      )}
    </DraggableModal>
  );
}
