import React, { useState, useEffect } from "react";
import { api, Product } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";
import { DraggableModal } from "./DraggableModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 };
const sH: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.06em", margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};
const errStyle: React.CSSProperties = { color: "#dc2626", fontSize: 12, marginTop: 2 };

const GRADES = ["S", "A", "B", "C"];
const LANG_LEVELS = ["일반", "비즈니스", "전문"];
const COMMON_SPECIALIZATIONS = ["IT", "법률", "의료/제약", "금융", "특허", "문학/출판", "기술/공학", "마케팅", "방송/미디어", "게임"];

export function TranslatorCreateModal({ token, onClose, onCreated, onToast }: {
  token: string;
  onClose: () => void;
  onCreated: (translator: any) => void;
  onToast: (msg: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Array<{ productId: number; unitPrice: string }>>([]);
  const [selectedSpecs, setSelectedSpecs] = useState<string[]>([]);
  const [customSpec, setCustomSpec] = useState("");

  const [form, setForm] = useState({
    email: "", password: "", confirmPassword: "", name: "", phone: "", region: "",
    languagePairs: "", languageLevel: "",
    grade: "", bio: "", ratePerWord: "", ratePerPage: "",
    resumeUrl: "", availabilityStatus: "available",
  });

  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    fetch(api("/api/admin/products"), { headers: authH })
      .then(r => r.json())
      .then(d => setAvailableProducts(Array.isArray(d) ? d.filter((p: Product) => p.active) : []))
      .catch(() => {});
  }, []);

  const setF = (key: keyof typeof form, val: string) => {
    setForm(p => ({ ...p, [key]: val }));
    setErrors(p => { const n = { ...p }; delete n[key]; return n; });
  };

  const toggleSpec = (s: string) => {
    setSelectedSpecs(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  };

  const addProduct = (productId: number) => {
    if (selectedProducts.find(p => p.productId === productId)) return;
    setSelectedProducts(p => [...p, { productId, unitPrice: "" }]);
  };

  const removeProduct = (productId: number) => {
    setSelectedProducts(p => p.filter(x => x.productId !== productId));
  };

  const setProductPrice = (productId: number, unitPrice: string) => {
    setSelectedProducts(p => p.map(x => x.productId === productId ? { ...x, unitPrice } : x));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.email.trim()) e.email = "이메일을 입력하세요.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "올바른 이메일 형식이 아닙니다.";
    if (!form.password) e.password = "비밀번호를 입력하세요.";
    else if (form.password.length < 8) e.password = "비밀번호는 8자 이상이어야 합니다.";
    if (form.password !== form.confirmPassword) e.confirmPassword = "비밀번호가 일치하지 않습니다.";
    if (!form.name.trim()) e.name = "이름을 입력하세요.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const specializations = [
        ...selectedSpecs,
        ...(customSpec.trim() ? customSpec.split(",").map(s => s.trim()).filter(Boolean) : []),
      ].join(", ") || undefined;

      const res = await fetch(api("/api/admin/translators"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim(), password: form.password,
          name: form.name.trim(), phone: form.phone.trim() || undefined,
          region: form.region.trim() || undefined,
          languagePairs: form.languagePairs.trim() || undefined,
          languageLevel: form.languageLevel || undefined,
          specializations,
          grade: form.grade || undefined,
          bio: form.bio.trim() || undefined,
          ratePerWord: form.ratePerWord ? Number(form.ratePerWord) : undefined,
          ratePerPage: form.ratePerPage ? Number(form.ratePerPage) : undefined,
          resumeUrl: form.resumeUrl.trim() || undefined,
          availabilityStatus: form.availabilityStatus,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) setErrors({ email: data.error });
        else onToast(`오류: ${data.error}`);
        return;
      }

      // 수행 상품 추가 (등록된 후 바로)
      const userId = data.id;
      for (const sp of selectedProducts) {
        if (!sp.productId) continue;
        await fetch(api(`/api/admin/translators/${userId}/products`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify({ productId: sp.productId, unitPrice: sp.unitPrice ? Number(sp.unitPrice) : null }),
        });
      }

      onToast(`통번역사 "${data.name ?? data.email}"이(가) 등록되었습니다.`);
      onCreated(data);
      onClose();
    } catch { onToast("오류: 등록 실패"); }
    finally { setSaving(false); }
  };

  const assignedProductIds = new Set(selectedProducts.map(p => p.productId));

  const F = ({ label, field, type = "text", placeholder = "", required = false }: {
    label: string; field: keyof typeof form; type?: string; placeholder?: string; required?: boolean;
  }) => (
    <div>
      <label style={labelSt}>{label}{required && <span style={{ color: "#dc2626" }}> *</span>}</label>
      <input type={type} value={form[field]} onChange={e => setF(field, e.target.value)}
        placeholder={placeholder} style={{ ...inputStyle, borderColor: errors[field] ? "#dc2626" : "#d1d5db" }} />
      {errors[field] && <span style={errStyle}>{errors[field]}</span>}
    </div>
  );

  return (
    <DraggableModal title="통번역사 등록" subtitle="새 통번역사 계정 생성" onClose={onClose} width={760} zIndex={310} bodyPadding="20px 28px">
      {/* ── 기본정보 ── */}
      <p style={sH}>기본 정보</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
        <F label="이름" field="name" placeholder="홍길동" required />
        <F label="이메일" field="email" type="email" placeholder="translator@example.com" required />
        <F label="비밀번호" field="password" type="password" placeholder="8자 이상" required />
        <F label="비밀번호 확인" field="confirmPassword" type="password" placeholder="비밀번호 재입력" required />
        <F label="휴대폰" field="phone" placeholder="010-0000-0000" />
        <F label="지역" field="region" placeholder="서울, 경기..." />
      </div>

      {/* ── 언어 ── */}
      <p style={sH}>언어</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
        <div>
          <label style={labelSt}>언어쌍</label>
          <input value={form.languagePairs} onChange={e => setF("languagePairs", e.target.value)}
            placeholder="예: 한→영, 영→한, 한→일" style={inputStyle} />
          <span style={{ fontSize: 11, color: "#9ca3af" }}>쉼표로 구분하여 여러 언어쌍 입력</span>
        </div>
        <div>
          <label style={labelSt}>언어 레벨</label>
          <select value={form.languageLevel} onChange={e => setF("languageLevel", e.target.value)} style={inputStyle}>
            <option value="">선택 안 함</option>
            {LANG_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      </div>

      {/* ── 전문분야 ── */}
      <p style={sH}>전문분야</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {COMMON_SPECIALIZATIONS.map(s => (
          <button key={s} onClick={() => toggleSpec(s)}
            style={{
              padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
              border: selectedSpecs.includes(s) ? "1.5px solid #2563eb" : "1.5px solid #e5e7eb",
              background: selectedSpecs.includes(s) ? "#eff6ff" : "#f9fafb",
              color: selectedSpecs.includes(s) ? "#1d4ed8" : "#374151",
              fontWeight: selectedSpecs.includes(s) ? 700 : 400,
            }}>{s}</button>
        ))}
      </div>
      <div>
        <label style={labelSt}>직접 입력 (쉼표 구분)</label>
        <input value={customSpec} onChange={e => setCustomSpec(e.target.value)}
          placeholder="예: 특허, 환경, 스포츠" style={inputStyle} />
      </div>

      {/* ── 가능 상품 & 단가 ── */}
      <p style={sH}>가능 상품 & 단가</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <select defaultValue="" onChange={e => { if (e.target.value) { addProduct(Number(e.target.value)); e.target.value = ""; } }}
          style={{ ...inputStyle, flex: 1 }}>
          <option value="">상품 선택하여 추가...</option>
          {availableProducts.filter(p => !assignedProductIds.has(p.id)).map(p => (
            <option key={p.id} value={p.id}>
              {p.mainCategory ? `[${p.mainCategory}] ` : ""}{p.name}
            </option>
          ))}
        </select>
      </div>
      {selectedProducts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 4 }}>
          {selectedProducts.map(sp => {
            const prod = availableProducts.find(p => p.id === sp.productId);
            return (
              <div key={sp.productId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", background: "#f0fdf4", borderRadius: 8, border: "1px solid #bbf7d0" }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "#065f46" }}>
                  {prod?.mainCategory ? <span style={{ fontSize: 11, color: "#6b7280", marginRight: 4 }}>[{prod.mainCategory}]</span> : null}
                  {prod?.name ?? `#${sp.productId}`}
                </span>
                <input type="number" value={sp.unitPrice}
                  onChange={e => setProductPrice(sp.productId, e.target.value)}
                  placeholder="단가(원)" style={{ width: 110, padding: "5px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }} />
                <span style={{ fontSize: 11, color: "#6b7280" }}>{prod?.unit ?? ""}</span>
                <button onClick={() => removeProduct(sp.productId)}
                  style={{ background: "none", border: "none", color: "#dc2626", fontSize: 14, cursor: "pointer", padding: "0 4px" }}>×</button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── 등급 & 단가 ── */}
      <p style={sH}>등급 & 기본 단가</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 16px" }}>
        <div>
          <label style={labelSt}>등급</label>
          <select value={form.grade} onChange={e => setF("grade", e.target.value)} style={inputStyle}>
            <option value="">등급 없음</option>
            {GRADES.map(g => <option key={g} value={g}>{g}등급</option>)}
          </select>
        </div>
        <F label="기본 단가/어절 (원)" field="ratePerWord" type="number" placeholder="예: 40" />
        <F label="기본 단가/페이지 (원)" field="ratePerPage" type="number" placeholder="예: 30000" />
      </div>

      {/* ── 파일/기타 ── */}
      <p style={sH}>파일 & 기타</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
        <F label="이력서 URL" field="resumeUrl" placeholder="https://drive.google.com/..." />
        <div>
          <label style={labelSt}>가용 상태</label>
          <select value={form.availabilityStatus} onChange={e => setF("availabilityStatus", e.target.value)} style={inputStyle}>
            <option value="available">가능</option>
            <option value="busy">바쁨</option>
            <option value="unavailable">불가</option>
          </select>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <label style={labelSt}>소개/메모</label>
        <textarea value={form.bio} onChange={e => setF("bio", e.target.value)}
          rows={3} placeholder="통번역사 소개, 특이사항 등..."
          style={{ ...inputStyle, resize: "vertical" }} />
      </div>

      {/* ── 액션 버튼 ── */}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20, paddingTop: 16, borderTop: "1px solid #f3f4f6" }}>
        <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "10px 20px" }}>취소</GhostBtn>
        <PrimaryBtn onClick={handleSubmit} disabled={saving} style={{ fontSize: 14, padding: "10px 24px" }}>
          {saving ? "등록 중..." : "통번역사 등록"}
        </PrimaryBtn>
      </div>
    </DraggableModal>
  );
}
