import React, { useState, useEffect } from "react";
import { api, TranslatorProfile } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const GRADE_OPTIONS = ["S", "A", "B", "C"];

export function TranslatorProfileModal({ userId, userEmail, token, onClose, onToast }: {
  userId: number; userEmail: string; token: string;
  onClose: () => void; onToast: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    languagePairs: "", specializations: "", education: "", major: "",
    graduationYear: "", region: "", grade: "", rating: "",
    availabilityStatus: "available", bio: "",
    affiliatedCompanyId: "" as string, settlementType: "",
  });
  const [vendorCompanies, setVendorCompanies] = useState<Array<{ id: number; name: string }>>([]);

  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    (async () => {
      try {
        const [res, vcRes] = await Promise.all([
          fetch(api(`/api/admin/translator-profiles/${userId}`), { headers: authH }),
          fetch(api(`/api/admin/companies?companyType=vendor`), { headers: authH }),
        ]);
        const [data, vcData] = await Promise.all([res.json(), vcRes.json()]);
        if (vcRes.ok && Array.isArray(vcData)) {
          setVendorCompanies(vcData.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name })));
        }
        if (res.ok && data.profile) {
          const p = data.profile as TranslatorProfile;
          setForm({
            languagePairs: p.languagePairs ?? "",
            specializations: p.specializations ?? "",
            education: p.education ?? "",
            major: p.major ?? "",
            graduationYear: p.graduationYear ? String(p.graduationYear) : "",
            region: p.region ?? "",
            grade: p.grade ?? "",
            rating: p.rating ? String(p.rating) : "",
            availabilityStatus: p.availabilityStatus ?? "available",
            bio: p.bio ?? "",
            affiliatedCompanyId: p.affiliatedCompanyId ? String(p.affiliatedCompanyId) : "",
            settlementType: p.settlementType ?? "",
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
          grade: form.grade || null,
          affiliatedCompanyId: form.affiliatedCompanyId ? Number(form.affiliatedCompanyId) : null,
          settlementType: form.settlementType || null,
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
                <F label="가능언어 (예: 한국어, 영어, 일본어)" field="languagePairs" placeholder="한국어, 영어, 일본어" />
                <F label="지역" field="region" placeholder="서울" />
              </div>
            </div>
            <div>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" }}>학력 / 전문분야</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                <F label="학력" field="education" placeholder="서울대학교" />
                <F label="전공" field="major" placeholder="영어영문학" />
                <F label="졸업연도" field="graduationYear" type="number" placeholder="2010" />
                <F label="전문분야" field="specializations" placeholder="법률, 의학, 기술" />
              </div>
            </div>
            <div>
              <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase" }}>운영 정보</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>등급</label>
                  <ClickSelect
                    value={form.grade}
                    onChange={v => setForm(p => ({ ...p, grade: v }))}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[{ value: "", label: "등급 없음" }, ...GRADE_OPTIONS.map(g => ({ value: g, label: `${g}등급` }))]}
                  />
                </div>
                <F label="평점 (1-5)" field="rating" type="number" placeholder="4.5" />
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>가용 상태</label>
                  <ClickSelect value={form.availabilityStatus} onChange={v => setForm(p => ({ ...p, availabilityStatus: v }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[
                      { value: "available", label: "가능" }, { value: "busy", label: "바쁨" }, { value: "unavailable", label: "불가" },
                    ]} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>소속업체</label>
                  <select
                    value={form.affiliatedCompanyId}
                    onChange={e => setForm(p => ({ ...p, affiliatedCompanyId: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, color: "#111827", background: "#fff" }}
                  >
                    <option value="">소속 없음 (프리랜서)</option>
                    {vendorCompanies.map(c => (
                      <option key={c.id} value={String(c.id)}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>정산유형</label>
                  <ClickSelect
                    value={form.settlementType}
                    onChange={v => setForm(p => ({ ...p, settlementType: v }))}
                    style={{ width: "100%" }}
                    triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[
                      { value: "", label: "선택 안 함" },
                      { value: "개인", label: "개인 (3.3% 원천징수)" },
                      { value: "사업자", label: "사업자 (세금계산서)" },
                      { value: "업체정산", label: "업체정산 (소속업체 경유)" },
                    ]}
                  />
                </div>
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
