import React, { useState, useEffect } from "react";
import { api, TranslatorProfile, TranslatorRate, NoteEntry } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

export function TranslatorDetailModal({ userId, userEmail, token, onClose, onToast }: {
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
        placeholder={placeholder} style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
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
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}>
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
                rows={3} style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
            </div>
            <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: "8px 20px", marginBottom: 4 }}>
              {saving ? "저장 중..." : "프로필 저장"}
            </PrimaryBtn>

            <p style={sH}>단가 관리 ({rates.length})</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px 100px auto", gap: "6px 8px", alignItems: "end", marginBottom: 10 }}>
              <input value={rateForm.serviceType} onChange={e => setRateForm(p => ({ ...p, serviceType: e.target.value }))}
                placeholder="서비스 유형" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
              <input value={rateForm.languagePair} onChange={e => setRateForm(p => ({ ...p, languagePair: e.target.value }))}
                placeholder="언어조합" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
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
