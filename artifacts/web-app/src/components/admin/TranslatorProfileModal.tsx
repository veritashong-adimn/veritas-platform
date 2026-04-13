import React, { useState, useEffect } from "react";
import { api, TranslatorProfile } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

export function TranslatorProfileModal({ userId, userEmail, token, onClose, onToast }: {
  userId: number; userEmail: string; token: string;
  onClose: () => void; onToast: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    languagePairs: "", specializations: "", education: "", major: "",
    graduationYear: "", region: "", rating: "", availabilityStatus: "available",
    bio: "", ratePerWord: "", ratePerPage: "",
  });

  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/translator-profiles/${userId}`), { headers: authH });
        const data = await res.json();
        if (res.ok && data.profile) {
          const p = data.profile as TranslatorProfile;
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
      } catch { onToast("오류: 프로필 불러오기 실패"); }
      finally { setLoading(false); }
    })();
  }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/translator-profiles/${userId}`), {
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
      onToast("통번역사 프로필이 저장되었습니다.");
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const F = ({ label, field, type = "text", placeholder = "" }: { label: string; field: keyof typeof form; type?: string; placeholder?: string }) => (
    <div>
      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>{label}</label>
      <input type={type} value={form[field]} onChange={e => setForm(p => ({ ...p, [field]: e.target.value }))}
        placeholder={placeholder} style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
    </div>
  );

  return (
    <DraggableModal title="통번역사 프로필" subtitle={userEmail} onClose={onClose} width={680} zIndex={300} bodyPadding="20px 28px">
        {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" }}>기본 정보</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                <F label="언어 조합 (예: 한→영, 영→한)" field="languagePairs" placeholder="한→영, 영→한" />
                <F label="전문 분야" field="specializations" placeholder="법률, 의학, 기술" />
                <F label="학력" field="education" placeholder="서울대학교" />
                <F label="전공" field="major" />
                <F label="졸업연도" field="graduationYear" type="number" placeholder="2010" />
                <F label="지역" field="region" placeholder="서울" />
              </div>
            </div>
            <div>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" }}>운영 정보</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>가용 상태</label>
                  <ClickSelect value={form.availabilityStatus} onChange={v => setForm(p => ({ ...p, availabilityStatus: v }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[
                      { value: "available", label: "가능" }, { value: "busy", label: "바쁨" }, { value: "unavailable", label: "불가" },
                    ]} />
                </div>
                <F label="평점 (0-5)" field="rating" type="number" placeholder="4.5" />
                <F label="단어당 단가 (원)" field="ratePerWord" type="number" placeholder="50" />
                <F label="페이지당 단가 (원)" field="ratePerPage" type="number" placeholder="10000" />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>소개 / 메모</label>
              <textarea value={form.bio} onChange={e => setForm(p => ({ ...p, bio: e.target.value }))}
                rows={4} style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 14, padding: "10px 24px" }}>
                {saving ? "저장 중..." : "저장"}
              </PrimaryBtn>
              <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "10px 20px" }}>닫기</GhostBtn>
            </div>
          </div>
        )}
    </DraggableModal>
  );
}
