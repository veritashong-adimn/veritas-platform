import React, { useState, useEffect, useRef } from "react";
import { api, Product } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";
import { DraggableModal } from "./DraggableModal";
import { PAYMENT_METHODS } from "./SensitiveInfoModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const inpAmber: React.CSSProperties = { ...inputStyle, borderColor: "#fcd34d", background: "#fffbeb" };
const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 };
const labelAmber: React.CSSProperties = { ...labelSt, color: "#92400e" };
const sH: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.06em", margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};
const sHAmber: React.CSSProperties = { ...sH, color: "#92400e", borderBottomColor: "#fde68a" };
const errStyle: React.CSSProperties = { color: "#dc2626", fontSize: 12, marginTop: 2 };
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px" };
const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 14px" };

const GRADES = ["S", "A", "B", "C"];
const LANG_LEVELS = ["일반", "비즈니스", "전문"];
const COMMON_SPECIALIZATIONS = ["IT", "법률", "의료/제약", "금융", "특허", "문학/출판", "기술/공학", "마케팅", "방송/미디어", "게임"];
const CURRENCIES = ["KRW", "USD", "EUR", "JPY", "GBP", "CAD", "AUD", "CNY", "HKD", "SGD"];
const FEE_PAYER_OPTIONS = [
  { value: "sender",    label: "송금인 부담 (당사)" },
  { value: "recipient", label: "수취인 부담 (통번역사)" },
  { value: "split",     label: "공동 부담" },
];

const emptySensitive = () => ({
  paymentMethod: "",
  residentFront: "", residentBack: "",
  bankName: "", bankAccount: "", accountHolder: "",
  businessNumber: "", businessName: "", businessOwner: "", taxInvoiceEmail: "",
  paypalEmail: "", englishName: "", country: "", currency: "",
  remittanceMemo: "", addressEn: "", bankNameEn: "", swiftCode: "",
  routingNumber: "", iban: "",
  baseCurrency: "", remittanceFeePayer: "", settlementMemo: "",
  paymentHold: false,
});

export function TranslatorCreateModal({ token, permissions = [], onClose, onCreated, onToast }: {
  token: string; permissions?: string[];
  onClose: () => void; onCreated: (translator: any) => void; onToast: (msg: string) => void;
}) {
  const hasPerm = (key: string) => permissions.includes(key) || permissions.includes("*");

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [availableProducts, setAvailableProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Array<{ productId: number; unitPrice: string }>>([]);
  const [selectedSpecs, setSelectedSpecs] = useState<string[]>([]);
  const [customSpec, setCustomSpec] = useState("");
  const [form, setForm] = useState({
    email: "", password: "", confirmPassword: "", name: "", phone: "", region: "",
    languagePairs: "", languageLevel: "", grade: "", bio: "", ratePerWord: "", ratePerPage: "",
    resumeUrl: "", availabilityStatus: "available",
  });
  const [sf, setSF] = useState(emptySensitive());
  const backRef = useRef<HTMLInputElement>(null);
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
  const setSf = (key: keyof ReturnType<typeof emptySensitive>, val: string | boolean) =>
    setSF(p => ({ ...p, [key]: val }));

  const toggleSpec = (s: string) =>
    setSelectedSpecs(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  const addProduct = (productId: number) => {
    if (selectedProducts.find(p => p.productId === productId)) return;
    setSelectedProducts(p => [...p, { productId, unitPrice: "" }]);
  };
  const removeProduct = (id: number) => setSelectedProducts(p => p.filter(x => x.productId !== id));
  const setProductPrice = (id: number, price: string) =>
    setSelectedProducts(p => p.map(x => x.productId === id ? { ...x, unitPrice: price } : x));

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
          specializations, grade: form.grade || undefined,
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

      const userId = data.id;

      for (const sp of selectedProducts) {
        if (!sp.productId) continue;
        await fetch(api(`/api/admin/translators/${userId}/products`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify({ productId: sp.productId, unitPrice: sp.unitPrice ? Number(sp.unitPrice) : null }),
        });
      }

      // 정산/지급 정보 저장
      if (hasPerm("translator.sensitive") && sf.paymentMethod) {
        const rn = `${sf.residentFront.trim()}${sf.residentBack.trim()}`;
        const sbody: Record<string, unknown> = {
          paymentMethod: sf.paymentMethod || null,
          bankName: sf.bankName || null, bankAccount: sf.bankAccount || null, accountHolder: sf.accountHolder || null,
          businessNumber: sf.businessNumber || null, businessName: sf.businessName || null,
          businessOwner: sf.businessOwner || null, taxInvoiceEmail: sf.taxInvoiceEmail || null,
          paypalEmail: sf.paypalEmail || null, englishName: sf.englishName || null,
          country: sf.country || null, currency: sf.currency || null,
          remittanceMemo: sf.remittanceMemo || null, addressEn: sf.addressEn || null,
          bankNameEn: sf.bankNameEn || null, swiftCode: sf.swiftCode || null,
          routingNumber: sf.routingNumber || null, iban: sf.iban || null,
          baseCurrency: sf.baseCurrency || null, remittanceFeePayer: sf.remittanceFeePayer || null,
          paymentHold: sf.paymentHold, settlementMemo: sf.settlementMemo || null,
        };
        if (rn.length >= 6) sbody.residentNumber = rn;

        await fetch(api(`/api/admin/translators/${userId}/sensitive`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify(sbody),
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

  const SA = ({ label, field, placeholder = "", type = "text", mono = false }: {
    label: string; field: keyof ReturnType<typeof emptySensitive>; placeholder?: string; type?: string; mono?: boolean;
  }) => (
    <div>
      <label style={labelAmber}>{label}</label>
      <input type={type} value={sf[field] as string} onChange={e => setSf(field, e.target.value)}
        placeholder={placeholder}
        style={{ ...inpAmber, fontFamily: mono ? "monospace" : undefined }} />
    </div>
  );

  const isDomesticWith = sf.paymentMethod === "domestic_withholding";
  const isDomesticBiz  = sf.paymentMethod === "domestic_business";
  const isPaypal       = sf.paymentMethod === "overseas_paypal";
  const isBank         = sf.paymentMethod === "overseas_bank";
  const isOther        = sf.paymentMethod === "other";
  const hasMethod      = !!sf.paymentMethod;

  return (
    <DraggableModal title="통번역사 등록" subtitle="새 통번역사 계정 생성" onClose={onClose} width={800} zIndex={310} bodyPadding="20px 28px">

      {/* ── 기본 정보 ── */}
      <p style={sH}>기본 정보</p>
      <div style={grid2}>
        <F label="이메일" field="email" type="email" placeholder="example@email.com" required />
        <F label="이름" field="name" placeholder="홍길동" required />
        <F label="비밀번호" field="password" type="password" placeholder="8자 이상" required />
        <F label="비밀번호 확인" field="confirmPassword" type="password" placeholder="비밀번호 재입력" required />
        <F label="휴대폰" field="phone" placeholder="010-0000-0000" />
        <F label="지역" field="region" placeholder="서울, 경기..." />
      </div>

      {/* ── 언어 ── */}
      <p style={sH}>언어</p>
      <div style={grid2}>
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
          <button key={s} onClick={() => toggleSpec(s)} style={{
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
            <option key={p.id} value={p.id}>{p.mainCategory ? `[${p.mainCategory}] ` : ""}{p.name}</option>
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
                <input type="number" value={sp.unitPrice} onChange={e => setProductPrice(sp.productId, e.target.value)}
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
      <div style={grid3}>
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
      <div style={grid2}>
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
        <textarea value={form.bio} onChange={e => setF("bio", e.target.value)} rows={3}
          placeholder="통번역사 소개, 특이사항 등..." style={{ ...inputStyle, resize: "vertical" }} />
      </div>

      {/* ── 정산/지급 정보 (권한자만) ── */}
      {hasPerm("translator.sensitive") && (
        <>
          <p style={sHAmber}>
            🔒 정산/지급 정보
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: "#9ca3af", textTransform: "none", letterSpacing: 0 }}>
              암호화 저장 · admin/finance 권한만 열람 가능 · 나중에 입력해도 됩니다
            </span>
          </p>
          <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10, padding: "16px 18px" }}>

            {/* 지급방식 선택 */}
            <p style={{ fontSize: 12, fontWeight: 700, color: "#92400e", margin: "0 0 10px" }}>지급 방식 선택</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 16 }}>
              {PAYMENT_METHODS.map(m => (
                <button key={m.value} onClick={() => setSf("paymentMethod", m.value === sf.paymentMethod ? "" : m.value)}
                  style={{
                    padding: "8px 6px", borderRadius: 8, fontSize: 11, cursor: "pointer", textAlign: "center", lineHeight: 1.3,
                    border: sf.paymentMethod === m.value ? "2px solid #d97706" : "1.5px solid #fde68a",
                    background: sf.paymentMethod === m.value ? "#fde68a" : "#fffbeb",
                    color: sf.paymentMethod === m.value ? "#78350f" : "#92400e",
                    fontWeight: sf.paymentMethod === m.value ? 700 : 400,
                  }}>{m.label}</button>
              ))}
            </div>

            {/* ── 국내 3.3% 원천징수 ── */}
            {isDomesticWith && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>주민등록번호</p>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="password" value={sf.residentFront}
                      onChange={e => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); setSf("residentFront", v); if (v.length === 6) backRef.current?.focus(); }}
                      placeholder="앞 6자리" maxLength={6} autoComplete="off"
                      style={{ width: 110, padding: "9px 12px", borderRadius: 8, border: "1px solid #fcd34d", fontSize: 13, textAlign: "center", fontFamily: "monospace", letterSpacing: 2, boxSizing: "border-box", background: "#fffbeb" }} />
                    <span style={{ fontSize: 18, color: "#d97706", fontWeight: 700 }}>-</span>
                    <input ref={backRef} type="password" value={sf.residentBack}
                      onChange={e => setSf("residentBack", e.target.value.replace(/\D/g, "").slice(0, 7))}
                      placeholder="뒤 7자리" maxLength={7} autoComplete="off"
                      style={{ width: 125, padding: "9px 12px", borderRadius: 8, border: "1px solid #fcd34d", fontSize: 13, textAlign: "center", fontFamily: "monospace", letterSpacing: 2, boxSizing: "border-box", background: "#fffbeb" }} />
                    <span style={{ fontSize: 11, color: "#b45309" }}>AES-256 암호화</span>
                  </div>
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>계좌정보</p>
                <div style={{ ...grid3, marginBottom: 4 }}>
                  <SA label="은행명" field="bankName" placeholder="국민은행" />
                  <SA label="예금주" field="accountHolder" placeholder="홍길동" />
                  <SA label="계좌번호" field="bankAccount" placeholder="123-456-789012" mono />
                </div>
              </>
            )}

            {/* ── 국내 사업자 ── */}
            {isDomesticBiz && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>사업자 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  <SA label="사업자등록번호" field="businessNumber" placeholder="000-00-00000" mono />
                  <SA label="상호" field="businessName" placeholder="(주)회사명" />
                  <SA label="대표자명" field="businessOwner" placeholder="홍길동" />
                  <SA label="세금계산서 이메일" field="taxInvoiceEmail" placeholder="tax@company.com" type="email" />
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>계좌정보</p>
                <div style={{ ...grid3, marginBottom: 4 }}>
                  <SA label="은행명" field="bankName" placeholder="국민은행" />
                  <SA label="예금주" field="accountHolder" placeholder="홍길동" />
                  <SA label="계좌번호" field="bankAccount" placeholder="123-456-789012" mono />
                </div>
              </>
            )}

            {/* ── 해외 PayPal ── */}
            {isPaypal && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>PayPal 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  <SA label="PayPal 계정 이메일" field="paypalEmail" placeholder="paypal@email.com" type="email" />
                  <SA label="영문이름 (Full Name)" field="englishName" placeholder="Hong Gil Dong" />
                  <SA label="국가" field="country" placeholder="South Korea" />
                  <div>
                    <label style={labelAmber}>통화</label>
                    <select value={sf.currency} onChange={e => setSf("currency", e.target.value)} style={inpAmber}>
                      <option value="">선택 안 함</option>
                      {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <SA label="송금 메모 (선택)" field="remittanceMemo" placeholder="프로젝트명 또는 메모" />
              </>
            )}

            {/* ── 해외 은행송금 ── */}
            {isBank && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>수취인 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  <SA label="영문이름 (Full Name)" field="englishName" placeholder="Hong Gil Dong" />
                  <SA label="국가" field="country" placeholder="United States" />
                  <div>
                    <label style={labelAmber}>통화</label>
                    <select value={sf.currency} onChange={e => setSf("currency", e.target.value)} style={inpAmber}>
                      <option value="">선택 안 함</option>
                      {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <SA label="거주지 영문주소" field="addressEn" placeholder="123 Main St, City, State" />
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>해외 은행 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  <SA label="은행명(영문)" field="bankNameEn" placeholder="Bank of America" />
                  <SA label="계좌번호" field="bankAccount" placeholder="Account Number" mono />
                  <SA label="SWIFT Code" field="swiftCode" placeholder="AAAABBCC" mono />
                  <SA label="Routing Number" field="routingNumber" placeholder="021000021" mono />
                </div>
                <SA label="IBAN (선택)" field="iban" placeholder="GB33BUKB20201555555555" mono />
              </>
            )}

            {/* ── 기타 ── */}
            {isOther && (
              <SA label="정산 방식 설명" field="settlementMemo" placeholder="지급 방식 및 기타 정보를 입력하세요" />
            )}

            {/* ── 공통 추가 정보 ── */}
            {hasMethod && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #fde68a" }}>
                <div style={{ ...grid2, marginBottom: 10 }}>
                  <div>
                    <label style={labelAmber}>기본 통화</label>
                    <select value={sf.baseCurrency} onChange={e => setSf("baseCurrency", e.target.value)} style={inpAmber}>
                      <option value="">선택 안 함</option>
                      {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  {(isPaypal || isBank) && (
                    <div>
                      <label style={labelAmber}>해외송금 수수료 부담</label>
                      <select value={sf.remittanceFeePayer} onChange={e => setSf("remittanceFeePayer", e.target.value)} style={inpAmber}>
                        <option value="">선택 안 함</option>
                        {FEE_PAYER_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={labelAmber}>정산 메모 (내부용)</label>
                  <input value={sf.settlementMemo} onChange={e => setSf("settlementMemo", e.target.value)}
                    placeholder="특이사항, 지급 조건 등" style={inpAmber} />
                </div>
              </div>
            )}
          </div>
        </>
      )}

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
