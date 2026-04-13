import React, { useState, useEffect, useRef } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";

const inp: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 };
const sH: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.06em", margin: "16px 0 10px", paddingBottom: 5, borderBottom: "1px solid #f3f4f6",
};
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px" };
const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 14px" };

export const PAYMENT_METHODS = [
  { value: "domestic_withholding", label: "국내 3.3% 원천징수" },
  { value: "domestic_business",    label: "국내 사업자 (세금계산서)" },
  { value: "overseas_paypal",      label: "해외 PayPal" },
  { value: "overseas_bank",        label: "해외 은행송금" },
  { value: "other",                label: "기타" },
];

const CURRENCIES = ["KRW", "USD", "EUR", "JPY", "GBP", "CAD", "AUD", "CNY", "HKD", "SGD"];
const FEE_PAYER_OPTIONS = [
  { value: "sender",    label: "송금인 부담 (당사)" },
  { value: "recipient", label: "수취인 부담 (통번역사)" },
  { value: "split",     label: "공동 부담" },
];

type SensitiveData = {
  exists: boolean;
  paymentMethod: string | null;
  residentNumberMasked: string | null;
  bankName: string | null;
  bankAccount: string | null;
  accountHolder: string | null;
  businessNumber: string | null;
  businessName: string | null;
  businessOwner: string | null;
  taxInvoiceEmail: string | null;
  paypalEmail: string | null;
  englishName: string | null;
  country: string | null;
  currency: string | null;
  remittanceMemo: string | null;
  addressEn: string | null;
  bankNameEn: string | null;
  swiftCode: string | null;
  routingNumber: string | null;
  iban: string | null;
  baseCurrency: string | null;
  remittanceFeePayer: string | null;
  paymentHold: boolean | null;
  settlementMemo: string | null;
  updatedAt?: string;
};

const emptyForm = () => ({
  paymentMethod: "",
  residentFront: "", residentBack: "",
  bankName: "", bankAccount: "", accountHolder: "",
  businessNumber: "", businessName: "", businessOwner: "", taxInvoiceEmail: "",
  paypalEmail: "", englishName: "", country: "", currency: "",
  remittanceMemo: "", addressEn: "", bankNameEn: "", swiftCode: "",
  routingNumber: "", iban: "",
  baseCurrency: "", remittanceFeePayer: "",
  paymentHold: false, settlementMemo: "",
});

export function SensitiveInfoModal({ userId, userName, token, onClose, onToast }: {
  userId: number; userName: string; token: string;
  onClose: () => void; onToast: (msg: string) => void;
}) {
  const [data, setData] = useState<SensitiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const backRef = useRef<HTMLInputElement>(null);
  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    setLoading(true);
    fetch(api(`/api/admin/translators/${userId}/sensitive`), { headers: authH })
      .then(r => r.json())
      .then((d: SensitiveData) => {
        setData(d);
        setForm({
          paymentMethod: d.paymentMethod ?? "",
          residentFront: "", residentBack: "",
          bankName: d.bankName ?? "", bankAccount: d.bankAccount ?? "", accountHolder: d.accountHolder ?? "",
          businessNumber: d.businessNumber ?? "", businessName: d.businessName ?? "",
          businessOwner: d.businessOwner ?? "", taxInvoiceEmail: d.taxInvoiceEmail ?? "",
          paypalEmail: d.paypalEmail ?? "", englishName: d.englishName ?? "",
          country: d.country ?? "", currency: d.currency ?? "",
          remittanceMemo: d.remittanceMemo ?? "", addressEn: d.addressEn ?? "",
          bankNameEn: d.bankNameEn ?? "", swiftCode: d.swiftCode ?? "",
          routingNumber: d.routingNumber ?? "", iban: d.iban ?? "",
          baseCurrency: d.baseCurrency ?? "", remittanceFeePayer: d.remittanceFeePayer ?? "",
          paymentHold: d.paymentHold ?? false, settlementMemo: d.settlementMemo ?? "",
        });
        if (!d.exists) setEditMode(true);
      })
      .catch(() => onToast("오류: 민감정보 불러오기 실패"))
      .finally(() => setLoading(false));
  }, [userId]);

  const sf = (key: keyof ReturnType<typeof emptyForm>, val: string | boolean) =>
    setForm(p => ({ ...p, [key]: val }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const rn = `${form.residentFront.trim()}${form.residentBack.trim()}`;
      const body: Record<string, unknown> = {
        paymentMethod: form.paymentMethod || null,
        bankName: form.bankName || null,
        bankAccount: form.bankAccount || null,
        accountHolder: form.accountHolder || null,
        businessNumber: form.businessNumber || null,
        businessName: form.businessName || null,
        businessOwner: form.businessOwner || null,
        taxInvoiceEmail: form.taxInvoiceEmail || null,
        paypalEmail: form.paypalEmail || null,
        englishName: form.englishName || null,
        country: form.country || null,
        currency: form.currency || null,
        remittanceMemo: form.remittanceMemo || null,
        addressEn: form.addressEn || null,
        bankNameEn: form.bankNameEn || null,
        swiftCode: form.swiftCode || null,
        routingNumber: form.routingNumber || null,
        iban: form.iban || null,
        baseCurrency: form.baseCurrency || null,
        remittanceFeePayer: form.remittanceFeePayer || null,
        paymentHold: form.paymentHold,
        settlementMemo: form.settlementMemo || null,
      };
      if (rn.length >= 6) body.residentNumber = rn;

      const res = await fetch(api(`/api/admin/translators/${userId}/sensitive`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) { onToast(`오류: ${d.error}`); return; }
      setData(d);
      setForm(p => ({ ...p, residentFront: "", residentBack: "" }));
      setEditMode(false);
      onToast("정산/지급 정보가 저장되었습니다.");
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const pm = form.paymentMethod;
  const isDomesticWith = pm === "domestic_withholding";
  const isDomesticBiz  = pm === "domestic_business";
  const isPaypal       = pm === "overseas_paypal";
  const isBank         = pm === "overseas_bank";
  const isOther        = pm === "other";

  const pmLabel = (val: string | null) =>
    PAYMENT_METHODS.find(m => m.value === val)?.label ?? val ?? "미등록";
  const feeLabel = (val: string | null) =>
    FEE_PAYER_OPTIONS.find(f => f.value === val)?.label ?? val ?? "미설정";

  return (
    <DraggableModal
      title="정산/지급 정보 관리"
      subtitle={`${userName} — 민감 개인정보`}
      onClose={onClose} width={620} zIndex={400} bodyPadding="18px 24px"
    >
      {/* 보안 배너 */}
      <div style={{ display:"flex", gap:10, alignItems:"flex-start", background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"10px 14px", marginBottom:14 }}>
        <span style={{ fontSize:18 }}>🔒</span>
        <div style={{ fontSize:12, color:"#92400e", lineHeight:1.5 }}>
          <strong>민감 개인정보 보호 구역</strong> — admin / finance 권한자만 접근 가능합니다.<br/>
          모든 조회·수정 이력이 서버 로그에 기록됩니다.
        </div>
      </div>

      {loading ? (
        <p style={{ color:"#9ca3af", textAlign:"center", padding:"24px 0" }}>불러오는 중...</p>
      ) : (
        <>
          {/* ─── 뷰 모드 ─────────────────────────────────────────────────── */}
          {data && !editMode && (
            <>
              {!data.exists ? (
                <div style={{ padding:"20px", background:"#f9fafb", borderRadius:8, textAlign:"center", marginBottom:12 }}>
                  <p style={{ color:"#9ca3af", fontSize:13, margin:"0 0 8px" }}>아직 등록된 정산 정보가 없습니다.</p>
                </div>
              ) : (
                <>
                  {/* 지급방식 배지 */}
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
                    <span style={{ fontSize:13, fontWeight:700, color:"#374151" }}>지급 방식</span>
                    <span style={{ padding:"4px 12px", borderRadius:20, fontSize:12, fontWeight:700, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe" }}>
                      {pmLabel(data.paymentMethod)}
                    </span>
                    {data.paymentHold && (
                      <span style={{ padding:"3px 10px", borderRadius:20, fontSize:11, fontWeight:700, background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca" }}>⏸ 지급 보류</span>
                    )}
                  </div>

                  {/* 국내 3.3% 원천징수 */}
                  {data.paymentMethod === "domestic_withholding" && (
                    <>
                      <p style={sH}>주민등록번호 · 계좌정보</p>
                      <div style={grid2}>
                        <InfoField label="주민등록번호" value={data.residentNumberMasked ?? "미등록"} sensitive />
                        <InfoField label="은행명" value={data.bankName ?? "미등록"} />
                        <InfoField label="계좌번호" value={data.bankAccount ?? "미등록"} mono />
                        <InfoField label="예금주" value={data.accountHolder ?? "미등록"} />
                      </div>
                    </>
                  )}

                  {/* 국내 사업자 */}
                  {data.paymentMethod === "domestic_business" && (
                    <>
                      <p style={sH}>사업자 정보</p>
                      <div style={grid2}>
                        <InfoField label="사업자등록번호" value={data.businessNumber ?? "미등록"} mono />
                        <InfoField label="상호" value={data.businessName ?? "미등록"} />
                        <InfoField label="대표자명" value={data.businessOwner ?? "미등록"} />
                        <InfoField label="세금계산서 이메일" value={data.taxInvoiceEmail ?? "미등록"} />
                      </div>
                      <p style={sH}>계좌정보</p>
                      <div style={grid3}>
                        <InfoField label="은행명" value={data.bankName ?? "미등록"} />
                        <InfoField label="계좌번호" value={data.bankAccount ?? "미등록"} mono />
                        <InfoField label="예금주" value={data.accountHolder ?? "미등록"} />
                      </div>
                    </>
                  )}

                  {/* 해외 PayPal */}
                  {data.paymentMethod === "overseas_paypal" && (
                    <>
                      <p style={sH}>PayPal 송금 정보</p>
                      <div style={grid2}>
                        <InfoField label="PayPal 계정 이메일" value={data.paypalEmail ?? "미등록"} sensitive />
                        <InfoField label="영문이름" value={data.englishName ?? "미등록"} />
                        <InfoField label="국가" value={data.country ?? "미등록"} />
                        <InfoField label="통화" value={data.currency ?? "미등록"} />
                      </div>
                      {data.remittanceMemo && (
                        <div style={{ marginTop:8 }}><InfoField label="송금 메모" value={data.remittanceMemo} /></div>
                      )}
                    </>
                  )}

                  {/* 해외 은행송금 */}
                  {data.paymentMethod === "overseas_bank" && (
                    <>
                      <p style={sH}>수취인 정보</p>
                      <div style={grid2}>
                        <InfoField label="영문이름" value={data.englishName ?? "미등록"} />
                        <InfoField label="국가" value={data.country ?? "미등록"} />
                        <InfoField label="통화" value={data.currency ?? "미등록"} />
                        <InfoField label="거주지 영문주소" value={data.addressEn ?? "미등록"} />
                      </div>
                      <p style={sH}>해외 은행 정보</p>
                      <div style={grid2}>
                        <InfoField label="은행명(영문)" value={data.bankNameEn ?? "미등록"} />
                        <InfoField label="계좌번호" value={data.bankAccount ?? "미등록"} mono />
                        <InfoField label="SWIFT Code" value={data.swiftCode ?? "미등록"} mono />
                        <InfoField label="Routing Number" value={data.routingNumber ?? "미등록"} mono />
                        {data.iban && <InfoField label="IBAN" value={data.iban} mono />}
                      </div>
                    </>
                  )}

                  {/* 기타 */}
                  {data.paymentMethod === "other" && (
                    <div style={{ marginBottom:12 }}><InfoField label="정산 메모" value={data.settlementMemo ?? "미등록"} /></div>
                  )}

                  {/* 공통 추가 정보 */}
                  {(data.baseCurrency || data.remittanceFeePayer || data.settlementMemo) && (
                    <>
                      <p style={sH}>추가 정보</p>
                      <div style={grid3}>
                        {data.baseCurrency && <InfoField label="기본 통화" value={data.baseCurrency} />}
                        {data.remittanceFeePayer && <InfoField label="수수료 부담" value={feeLabel(data.remittanceFeePayer)} />}
                        {data.settlementMemo && <InfoField label="정산 메모" value={data.settlementMemo} />}
                      </div>
                    </>
                  )}
                </>
              )}

              {data.updatedAt && (
                <p style={{ fontSize:11, color:"#9ca3af", marginTop:10 }}>마지막 수정: {new Date(data.updatedAt).toLocaleString("ko-KR")}</p>
              )}
              <div style={{ display:"flex", gap:8, marginTop:14 }}>
                <PrimaryBtn onClick={() => setEditMode(true)} style={{ fontSize:13, padding:"8px 16px" }}>
                  {data.exists ? "정보 수정" : "정보 등록"}
                </PrimaryBtn>
                <GhostBtn onClick={onClose} style={{ fontSize:13, padding:"8px 16px" }}>닫기</GhostBtn>
              </div>
            </>
          )}

          {/* ─── 편집 모드 ─────────────────────────────────────────────────── */}
          {editMode && (
            <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
              {/* 지급방식 선택 */}
              <p style={sH}>지급 방식 선택</p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 }}>
                {PAYMENT_METHODS.map(m => (
                  <button key={m.value} onClick={() => sf("paymentMethod", m.value)}
                    style={{
                      padding:"10px 14px", borderRadius:8, fontSize:13, cursor:"pointer", textAlign:"left",
                      border: form.paymentMethod === m.value ? "2px solid #2563eb" : "1.5px solid #e5e7eb",
                      background: form.paymentMethod === m.value ? "#eff6ff" : "#f9fafb",
                      color: form.paymentMethod === m.value ? "#1d4ed8" : "#374151",
                      fontWeight: form.paymentMethod === m.value ? 700 : 400,
                    }}>{m.label}</button>
                ))}
              </div>

              {/* ── 국내 3.3% 원천징수 ── */}
              {isDomesticWith && (
                <>
                  <p style={sH}>주민등록번호</p>
                  <ResidentInput
                    front={form.residentFront} back={form.residentBack} backRef={backRef}
                    onFront={v => { sf("residentFront", v); if (v.length === 6) backRef.current?.focus(); }}
                    onBack={v => sf("residentBack", v)}
                    existing={data?.residentNumberMasked}
                  />
                  <p style={sH}>계좌정보</p>
                  <BankFields form={form} sf={sf} />
                </>
              )}

              {/* ── 국내 사업자 ── */}
              {isDomesticBiz && (
                <>
                  <p style={sH}>사업자 정보</p>
                  <div style={{ ...grid2, marginBottom:10 }}>
                    <Field label="사업자등록번호" value={form.businessNumber} onChange={v => sf("businessNumber", v)} placeholder="000-00-00000" mono />
                    <Field label="상호" value={form.businessName} onChange={v => sf("businessName", v)} placeholder="(주)회사명" />
                    <Field label="대표자명" value={form.businessOwner} onChange={v => sf("businessOwner", v)} placeholder="홍길동" />
                    <Field label="세금계산서 이메일" value={form.taxInvoiceEmail} onChange={v => sf("taxInvoiceEmail", v)} placeholder="tax@company.com" type="email" />
                  </div>
                  <p style={sH}>계좌정보</p>
                  <BankFields form={form} sf={sf} />
                </>
              )}

              {/* ── 해외 PayPal ── */}
              {isPaypal && (
                <>
                  <p style={sH}>PayPal 정보</p>
                  <div style={{ ...grid2, marginBottom:10 }}>
                    <Field label="PayPal 계정 이메일" value={form.paypalEmail} onChange={v => sf("paypalEmail", v)} placeholder="paypal@email.com" type="email" />
                    <Field label="영문이름 (Full Name)" value={form.englishName} onChange={v => sf("englishName", v)} placeholder="Hong Gil Dong" />
                    <Field label="국가" value={form.country} onChange={v => sf("country", v)} placeholder="South Korea" />
                    <CurrencySelect value={form.currency} onChange={v => sf("currency", v)} label="통화" />
                  </div>
                  <Field label="송금 메모 (선택)" value={form.remittanceMemo} onChange={v => sf("remittanceMemo", v)} placeholder="프로젝트명 또는 메모" />
                </>
              )}

              {/* ── 해외 은행송금 ── */}
              {isBank && (
                <>
                  <p style={sH}>수취인 정보</p>
                  <div style={{ ...grid2, marginBottom:10 }}>
                    <Field label="영문이름 (Full Name)" value={form.englishName} onChange={v => sf("englishName", v)} placeholder="Hong Gil Dong" />
                    <Field label="국가" value={form.country} onChange={v => sf("country", v)} placeholder="United States" />
                    <CurrencySelect value={form.currency} onChange={v => sf("currency", v)} label="통화" />
                    <Field label="거주지 영문주소" value={form.addressEn} onChange={v => sf("addressEn", v)} placeholder="123 Main St, City, State" />
                  </div>
                  <p style={sH}>해외 은행 정보</p>
                  <div style={{ ...grid2, marginBottom:10 }}>
                    <Field label="은행명(영문)" value={form.bankNameEn} onChange={v => sf("bankNameEn", v)} placeholder="Bank of America" />
                    <Field label="계좌번호" value={form.bankAccount} onChange={v => sf("bankAccount", v)} placeholder="Account Number" mono />
                    <Field label="SWIFT Code" value={form.swiftCode} onChange={v => sf("swiftCode", v)} placeholder="AAAABBCC" mono />
                    <Field label="Routing Number" value={form.routingNumber} onChange={v => sf("routingNumber", v)} placeholder="021000021" mono />
                  </div>
                  <Field label="IBAN (선택)" value={form.iban} onChange={v => sf("iban", v)} placeholder="GB33BUKB20201555555555" mono />
                </>
              )}

              {/* ── 기타 ── */}
              {isOther && (
                <div style={{ marginBottom:10 }}>
                  <Field label="정산 방식 설명" value={form.settlementMemo} onChange={v => sf("settlementMemo", v)} placeholder="지급 방식 및 기타 정보를 입력하세요" />
                </div>
              )}

              {/* ── 공통 추가 정보 ── */}
              {pm && (
                <>
                  <p style={sH}>추가 정보</p>
                  <div style={{ ...grid2, marginBottom:10 }}>
                    <div>
                      <label style={lbl}>기본 통화</label>
                      <ClickSelect value={form.baseCurrency} onChange={v => sf("baseCurrency", v)}
                        style={{ width: "100%" }} triggerStyle={{ ...inp, width: "100%", boxSizing: "border-box" as const }}
                        options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
                    </div>
                    {(isPaypal || isBank) && (
                      <div>
                        <label style={lbl}>해외송금 수수료 부담</label>
                        <ClickSelect value={form.remittanceFeePayer} onChange={v => sf("remittanceFeePayer", v)}
                          style={{ width: "100%" }} triggerStyle={{ ...inp, width: "100%", boxSizing: "border-box" as const }}
                          options={[{ value: "", label: "선택 안 함" }, ...FEE_PAYER_OPTIONS.map(f => ({ value: f.value, label: f.label }))]} />
                      </div>
                    )}
                  </div>
                  <div style={{ marginBottom:10 }}>
                    <Field label="정산 메모 (내부용)" value={form.settlementMemo} onChange={v => sf("settlementMemo", v)} placeholder="특이사항, 지급 조건 등" />
                  </div>
                  <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", marginBottom:14, fontSize:13, color:form.paymentHold ? "#dc2626" : "#374151" }}>
                    <input type="checkbox" checked={form.paymentHold} onChange={e => sf("paymentHold", e.target.checked)}
                      style={{ width:16, height:16, accentColor:"#dc2626" }} />
                    <span style={{ fontWeight: form.paymentHold ? 700 : 400 }}>⏸ 지급 보류 (이 통번역사에게 지급을 일시 중단)</span>
                  </label>
                </>
              )}

              <div style={{ display:"flex", gap:8, paddingTop:4 }}>
                <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize:13, padding:"9px 20px" }}>
                  {saving ? "저장 중..." : "저장"}
                </PrimaryBtn>
                {data?.exists && (
                  <GhostBtn onClick={() => setEditMode(false)} style={{ fontSize:13, padding:"9px 16px" }}>취소</GhostBtn>
                )}
                <GhostBtn onClick={onClose} style={{ fontSize:13, padding:"9px 16px" }}>닫기</GhostBtn>
              </div>
            </div>
          )}
        </>
      )}
    </DraggableModal>
  );
}

// ─── 서브 컴포넌트들 ─────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder = "", type = "text", mono = false }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; mono?: boolean;
}) {
  return (
    <div>
      <label style={lbl}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...inp, fontFamily: mono ? "monospace" : undefined, letterSpacing: mono ? 0.5 : undefined }} />
    </div>
  );
}

function CurrencySelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div>
      <label style={lbl}>{label}</label>
      <ClickSelect value={value} onChange={onChange}
        style={{ width: "100%" }} triggerStyle={{ ...inp, width: "100%", boxSizing: "border-box" as const }}
        options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
    </div>
  );
}

function BankFields({ form, sf }: { form: ReturnType<typeof emptyForm>; sf: (k: keyof ReturnType<typeof emptyForm>, v: string | boolean) => void }) {
  return (
    <div style={{ ...grid3, marginBottom:10 }}>
      <Field label="은행명" value={form.bankName} onChange={v => sf("bankName", v)} placeholder="국민은행" />
      <Field label="예금주" value={form.accountHolder} onChange={v => sf("accountHolder", v)} placeholder="홍길동" />
      <Field label="계좌번호" value={form.bankAccount} onChange={v => sf("bankAccount", v)} placeholder="123-456-789012" mono />
    </div>
  );
}

function ResidentInput({ front, back, backRef, onFront, onBack, existing }: {
  front: string; back: string; backRef: React.RefObject<HTMLInputElement | null>;
  onFront: (v: string) => void; onBack: (v: string) => void; existing?: string | null;
}) {
  return (
    <div style={{ marginBottom:10 }}>
      {existing && (
        <div style={{ fontSize:11, color:"#9ca3af", marginBottom:6 }}>
          현재: <span style={{ fontFamily:"monospace", color:"#92400e" }}>{existing}</span> (공백 시 기존 유지)
        </div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <input type="password" value={front} onChange={e => onFront(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="앞 6자리" maxLength={6} autoComplete="off"
          style={{ width:110, padding:"9px 12px", borderRadius:8, border:"1px solid #d1d5db", fontSize:13, textAlign:"center", fontFamily:"monospace", letterSpacing:2, boxSizing:"border-box" }} />
        <span style={{ fontSize:18, color:"#d1d5db", fontWeight:700 }}>-</span>
        <input ref={backRef} type="password" value={back} onChange={e => onBack(e.target.value.replace(/\D/g, "").slice(0, 7))}
          placeholder="뒤 7자리" maxLength={7} autoComplete="off"
          style={{ width:125, padding:"9px 12px", borderRadius:8, border:"1px solid #d1d5db", fontSize:13, textAlign:"center", fontFamily:"monospace", letterSpacing:2, boxSizing:"border-box" }} />
        <span style={{ fontSize:11, color:"#9ca3af" }}>AES-256 암호화 저장</span>
      </div>
      <p style={{ fontSize:11, color:"#9ca3af", marginTop:4 }}>저장 후 앞 6자리만 표시됩니다 (예: 900101-***)</p>
    </div>
  );
}

function InfoField({ label, value, sensitive = false, mono = false }: {
  label: string; value: string; sensitive?: boolean; mono?: boolean;
}) {
  return (
    <div style={{ padding:"9px 11px", background: sensitive ? "#fef3c7" : "#f9fafb", borderRadius:8, border:`1px solid ${sensitive ? "#fde68a" : "#f3f4f6"}` }}>
      <div style={{ fontSize:11, color:"#6b7280", fontWeight:600, marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:13, fontWeight:700, color: value === "미등록" ? "#d1d5db" : sensitive ? "#92400e" : "#111827", fontFamily:(sensitive || mono) ? "monospace" : undefined }}>
        {sensitive && value !== "미등록" ? `🔒 ${value}` : value}
      </div>
    </div>
  );
}
