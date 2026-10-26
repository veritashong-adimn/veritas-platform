import React, { useState, useEffect, useRef } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";

export const BANK_LIST = [
  "국민은행", "신한은행", "우리은행", "하나은행", "기업은행",
  "농협은행", "카카오뱅크", "케이뱅크", "토스뱅크", "SC제일은행",
  "씨티은행", "우체국", "수협은행", "산업은행", "부산은행",
  "대구은행", "광주은행", "전북은행", "경남은행", "제주은행",
  "새마을금고", "신협",
] as const;

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
  // 지급수단(=실제 돈을 지급하는 방법). 세무처리(정산유형)와 독립. 신규 "국내 계좌송금"은 국내 은행계좌로 송금(원천징수 여부와 무관).
  { value: "domestic_bank_transfer", label: "국내 계좌송금" },
  { value: "domestic_withholding", label: "국내 3.3% 원천징수" },
  { value: "domestic_business",    label: "국내 사업자 (세금계산서)" },
  { value: "overseas_paypal",      label: "해외 PayPal" },
  { value: "overseas_bank",        label: "해외 은행송금" },
  { value: "other",                label: "기타" },
];

// 정산/지급 정보 관리 화면의 지급방식 선택지 — 송금 수단만 표시한다(세무처리는 원천징수율로 분리).
//   DB(payment_method)에는 정산·대량이체 로직이 쓰는 기존 코드를 그대로 저장한다(국내 계좌송금 + 원천징수율 → 아래 WITHHOLDING_RATES.code).
export const PAYMENT_METHOD_CHOICES = [
  { value: "domestic_bank_transfer", label: "국내 계좌송금" },
  { value: "overseas_paypal",        label: "해외 PayPal" },
  { value: "overseas_bank",          label: "해외 은행송금" },
  { value: "other",                  label: "기타" },
];

// 원천징수율(국내 계좌송금일 때) ↔ payment_method 코드. 1:1 대응이라 저장·재조회 시 값이 바뀌지 않는다.
//   원천세 신고 제외 = 확정 0%(지급회차 'exempt'). 기존 '세무 검토(domestic_bank_transfer)'는 미확정 상태로 별도 유지.
export const WITHHOLDING_RATES = [
  { value: "3.3",    label: "3.3% 원천징수",       code: "domestic_withholding" },
  { value: "2.2",    label: "2.2% 원천징수",       code: "domestic_withholding_2_2" },
  { value: "vat",    label: "미적용 (세금계산서)", code: "domestic_business" },
  { value: "exempt", label: "원천세 신고 제외",    code: "domestic_withholding_exempt" },
];
// 기존 미확정 데이터(선택 버튼 없음) — 관리자가 위 4개 중 하나를 직접 선택하기 전까지 코드 그대로 유지.
const UNCONFIRMED_RATE = { value: "review", label: "미확정 · 세무 검토", code: "domestic_bank_transfer" };
const ALL_RATES = [...WITHHOLDING_RATES, UNCONFIRMED_RATE];

// 저장 코드 → (지급방식, 원천징수율). 국내 코드는 모두 '국내 계좌송금'으로 표시. 알 수 없는 코드는 그대로 둔다(임의 변환 금지).
export function splitPaymentCode(code: string | null | undefined): { method: string; rate: string } {
  if (!code) return { method: "", rate: "" };
  const r = ALL_RATES.find(w => w.code === code);
  return r ? { method: "domestic_bank_transfer", rate: r.value } : { method: code, rate: "" };
}
// (지급방식, 원천징수율) → 저장 코드. 해외·기타는 지급방식 코드 그대로.
export function joinPaymentCode(method: string, rate: string): string {
  if (method !== "domestic_bank_transfer") return method;
  return ALL_RATES.find(w => w.value === rate)?.code ?? "domestic_bank_transfer";
}

// 정산유형별 원천징수율 기본값(제안용). 해외·원천세 신고 제외·외주업체는 기존 세무 처리 규칙 유지 → 제안 없음.
//   원천세 신고 제외는 기본값으로 제안하지 않는다(사용자가 명시 선택한 경우에만 적용).
const DEFAULT_RATE_BY_SETTLEMENT: Record<string, string> = { "개인(3.3%)": "3.3", "개인": "3.3", "사업자": "vat" };

export const SETTLEMENT_TYPES = [
  // value 는 기존 저장값 그대로(변경 시 기존 데이터 표시가 깨짐). 표시명만 정산유형 의미로 정리.
  { value: "개인(3.3%)", label: "개인 (사업소득)",       color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
  { value: "사업자",      label: "사업자 (세금계산서)",  color: "#6d28d9", bg: "#f5f3ff", border: "#ddd8fe" },
  { value: "해외개인",    label: "해외개인",              color: "#b45309", bg: "#fffbeb", border: "#fde68a" },
  { value: "해외법인",    label: "해외법인",              color: "#0f766e", bg: "#f0fdfa", border: "#99f6e4" },
  { value: "외주업체",    label: "외주업체 (소속업체 경유)", color: "#374151", bg: "#f3f4f6", border: "#d1d5db" },
];
// 선택지에서 제외된 기존 저장값 — 조회 표시만 하고 '정산유형 확인 필요'로 안내(값 자동 변경 없음).
//   '원천세 신고 예외'는 세무 처리 기준이라 원천징수율(원천세 신고 제외)에서 관리한다.
const LEGACY_SETTLEMENT_TYPES = [
  { value: "원천세 신고 예외", label: "원천세 신고 예외", color: "#be123c", bg: "#fff1f2", border: "#fecdd3" },
  { value: "개인",            label: "개인",            color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" },
  { value: "업체정산",        label: "업체정산",        color: "#374151", bg: "#f3f4f6", border: "#d1d5db" },
];
export function findSettlementType(value: string | null | undefined) {
  if (!value) return null;
  const cur = SETTLEMENT_TYPES.find(s => s.value === value);
  if (cur) return { ...cur, needsReview: false };
  const old = LEGACY_SETTLEMENT_TYPES.find(s => s.value === value);
  return { ...(old ?? { value, label: value, color: "#374151", bg: "#f3f4f6", border: "#d1d5db" }), needsReview: true };
}

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
  settlementType: "",
  paymentMethod: "",      // 화면용 지급방식(송금 수단). 저장 시 withholdingRate 와 합쳐 기존 코드로 변환
  withholdingRate: "",
  residentFront: "", residentBack: "",
  bankName: "", bankAccount: "", accountHolder: "",
  businessNumber: "", businessName: "", businessOwner: "", taxInvoiceEmail: "",
  paypalEmail: "", englishName: "", country: "", currency: "",
  remittanceMemo: "", addressEn: "", bankNameEn: "", swiftCode: "",
  routingNumber: "", iban: "",
  baseCurrency: "", remittanceFeePayer: "",
  paymentHold: false, settlementMemo: "",
});

export function SensitiveInfoModal({ userId, userName, token, onClose, onToast, initialSettlementType, onSettlementTypeSaved }: {
  userId: number; userName: string; token: string;
  onClose: () => void; onToast: (msg: string) => void;
  initialSettlementType?: string;
  onSettlementTypeSaved?: (type: string) => void;
}) {
  const [data, setData] = useState<SensitiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [savedSettlementType, setSavedSettlementType] = useState(initialSettlementType ?? "");
  const backRef = useRef<HTMLInputElement>(null);
  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    setLoading(true);
    fetch(api(`/api/admin/translators/${userId}/sensitive`), { headers: authH })
      .then(r => r.json())
      .then((d: SensitiveData) => {
        setData(d);
        setForm({
          settlementType: initialSettlementType ?? "",
          paymentMethod: splitPaymentCode(d.paymentMethod).method,
          withholdingRate: splitPaymentCode(d.paymentMethod).rate,
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
        paymentMethod: form.paymentMethod ? joinPaymentCode(form.paymentMethod, form.withholdingRate) : null,
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

      // 정산유형 별도 저장 (translator_profiles)
      if (form.settlementType !== (initialSettlementType ?? "")) {
        try {
          await fetch(api(`/api/admin/translators/${userId}/settlement-type`), {
            method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
            body: JSON.stringify({ settlementType: form.settlementType || null }),
          });
          setSavedSettlementType(form.settlementType);
          onSettlementTypeSaved?.(form.settlementType);
        } catch { /* 정산유형 저장 실패는 무시하지 않음 */ }
      } else {
        setSavedSettlementType(form.settlementType);
      }

      setEditMode(false);
      onToast("정산/지급 정보가 저장되었습니다.");
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const pm = form.paymentMethod;
  const isDomestic     = pm === "domestic_bank_transfer";
  const isPaypal       = pm === "overseas_paypal";
  const isBank         = pm === "overseas_bank";
  const isOther        = pm === "other";
  // 사업자정보 표시: 정산유형 사업자 또는 세금계산서(원천징수 미적용) 선택 시
  const isBizInfo      = form.settlementType === "사업자" || (isDomestic && form.withholdingRate === "vat");
  const defaultRate    = DEFAULT_RATE_BY_SETTLEMENT[form.settlementType] ?? "";
  const rateUnconfirmed = isDomestic && form.withholdingRate === "review";   // 기존 미확정 데이터 — 관리자 확인 대상
  const rateMismatch   = isDomestic && !!defaultRate && !!form.withholdingRate && !rateUnconfirmed
    && (defaultRate === "3.3" ? !["3.3", "2.2"].includes(form.withholdingRate) : form.withholdingRate !== defaultRate);

  // 정산유형 선택 — 원천징수율 기본값은 '미설정/세무 검토' 상태일 때만 제안 적용(사용자가 정한 세율은 덮어쓰지 않음)
  const pickSettlementType = (value: string) => {
    const next = value === form.settlementType ? "" : value;
    const rate = DEFAULT_RATE_BY_SETTLEMENT[next];
    setForm(p => {
      const canSuggest = !!rate && (p.paymentMethod === "" || p.paymentMethod === "domestic_bank_transfer")
        && p.withholdingRate === "";   // 기존 미확정(세무 검토)·사용자 선택 세율은 자동 변경하지 않음
      return canSuggest
        ? { ...p, settlementType: next, paymentMethod: "domestic_bank_transfer", withholdingRate: rate, baseCurrency: p.baseCurrency || "KRW" }
        : { ...p, settlementType: next };
    });
  };

  const pmLabel = (val: string | null) => {
    const { method } = splitPaymentCode(val);
    return PAYMENT_METHOD_CHOICES.find(m => m.value === method)?.label ?? PAYMENT_METHODS.find(m => m.value === val)?.label ?? val ?? "미등록";
  };
  const rateLabel = (val: string | null) => {
    const { method, rate } = splitPaymentCode(val);
    if (method !== "domestic_bank_transfer") return method ? "기존 규칙 (해외·기타)" : null;
    return ALL_RATES.find(w => w.value === rate)?.label ?? null;
  };
  const viewIsBiz = savedSettlementType === "사업자" || data?.paymentMethod === "domestic_business";
  const feeLabel = (val: string | null) =>
    FEE_PAYER_OPTIONS.find(f => f.value === val)?.label ?? val ?? "미설정";

  return (
    <DraggableModal
      title="정산/지급 정보 관리"
      subtitle={`${userName} — 민감 개인정보`}
      onClose={onClose} width={620} zIndex={400} bodyPadding="18px 24px" resizable
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
                  {/* 정산유형 + 지급방식 배지 */}
                  <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
                    {(() => {
                      const st = findSettlementType(savedSettlementType);
                      if (!st && !savedSettlementType) return (
                        <span style={{ fontSize:12, color:"#9ca3af", fontStyle:"italic" }}>정산유형 미설정</span>
                      );
                      const color = st?.color ?? "#374151";
                      const bg = st?.bg ?? "#f3f4f6";
                      const border = st?.border ?? "#d1d5db";
                      return (
                        <span style={{ padding:"4px 12px", borderRadius:20, fontSize:12, fontWeight:700, background:bg, color, border:`1px solid ${border}` }}>
                          {st?.label ?? savedSettlementType}{st?.needsReview ? " · 정산유형 확인 필요" : ""}
                        </span>
                      );
                    })()}
                    <span style={{ fontSize:12, color:"#d1d5db" }}>|</span>
                    <span style={{ fontSize:13, fontWeight:700, color:"#374151" }}>지급방식</span>
                    <span style={{ padding:"4px 12px", borderRadius:20, fontSize:12, fontWeight:700, background:"#eff6ff", color:"#1d4ed8", border:"1px solid #bfdbfe" }}>
                      {pmLabel(data.paymentMethod)}
                    </span>
                    {rateLabel(data.paymentMethod) && (
                      <>
                        <span style={{ fontSize:12, color:"#d1d5db" }}>|</span>
                        <span style={{ fontSize:13, fontWeight:700, color:"#374151" }}>원천징수</span>
                        <span style={{ padding:"4px 12px", borderRadius:20, fontSize:12, fontWeight:700, background:"#f9fafb", color:"#374151", border:"1px solid #e5e7eb" }}
                          data-testid="sensitive-view-withholding">
                          {rateLabel(data.paymentMethod)}
                        </span>
                      </>
                    )}
                    {data.paymentHold && (
                      <span style={{ padding:"3px 10px", borderRadius:20, fontSize:11, fontWeight:700, background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca" }}>⏸ 지급 보류</span>
                    )}
                  </div>

                  {/* 주민등록번호 · 계좌정보 — 항상 표시 */}
                  <p style={sH}>주민등록번호 · 계좌정보</p>
                  <div style={grid2}>
                    <InfoField label="주민등록번호" value={data.residentNumberMasked ?? "미등록"} sensitive />
                    <InfoField label="은행명" value={data.bankName ?? "미등록"} />
                    <InfoField label="계좌번호" value={data.bankAccount ?? "미등록"} mono />
                    <InfoField label="예금주" value={data.accountHolder ?? "미등록"} />
                  </div>

                  {/* 사업자(세금계산서) — 사업자 추가 정보 */}
                  {viewIsBiz && (
                    <>
                      <p style={sH}>사업자 정보</p>
                      <div style={grid2}>
                        <InfoField label="사업자등록번호" value={data.businessNumber ?? "미등록"} mono />
                        <InfoField label="상호" value={data.businessName ?? "미등록"} />
                        <InfoField label="대표자명" value={data.businessOwner ?? "미등록"} />
                        <InfoField label="세금계산서 이메일" value={data.taxInvoiceEmail ?? "미등록"} />
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
              {/* ① 정산유형 선택 */}
              <p style={sH}>정산유형</p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:16 }}>
                {SETTLEMENT_TYPES.map(st => (
                  <button key={st.value} onClick={() => pickSettlementType(st.value)}
                    data-testid={`sensitive-settlement-type-${st.value}`} aria-label={`정산유형 ${st.label}`} aria-pressed={form.settlementType === st.value}
                    style={{
                      padding:"9px 8px", borderRadius:8, fontSize:12, cursor:"pointer", textAlign:"center", lineHeight:1.3,
                      border: form.settlementType === st.value ? `2px solid ${st.color}` : `1.5px solid ${st.border}`,
                      background: form.settlementType === st.value ? st.bg : "#f9fafb",
                      color: form.settlementType === st.value ? st.color : "#374151",
                      fontWeight: form.settlementType === st.value ? 700 : 400,
                    }}>{st.label}</button>
                ))}
              </div>

              {findSettlementType(form.settlementType)?.needsReview && (
                <p style={{ fontSize:11, color:"#b45309", margin:"-10px 0 12px" }} data-testid="sensitive-settlement-type-review">
                  기존 저장값 '{form.settlementType}' — 정산유형 확인 필요. 올바른 정산유형을 선택해 저장하세요(선택하지 않으면 기존 값 유지).
                </p>
              )}

              {/* ② 지급방식 선택(송금 수단) */}
              <p style={sH}>지급방식</p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 }}>
                {PAYMENT_METHOD_CHOICES.map(m => (
                  <button key={m.value} onClick={() => {
                      const AUTO_CURRENCY: Record<string, string> = {
                        domestic_bank_transfer: "KRW",
                        overseas_paypal: "USD",
                        overseas_bank: "USD",
                      };
                      const auto = AUTO_CURRENCY[m.value];
                      setForm(p => ({
                        ...p, paymentMethod: m.value, ...(auto ? { baseCurrency: auto } : {}),
                        // 국내 계좌송금 최초 선택 시에만 정산유형 기본 세율 제안(기존 세율 유지)
                        ...(m.value === "domestic_bank_transfer" && !p.withholdingRate ? { withholdingRate: DEFAULT_RATE_BY_SETTLEMENT[p.settlementType] ?? "" } : {}),
                      }));
                    }}
                    data-testid={`sensitive-payment-method-${m.value}`} aria-label={`지급방식 ${m.label}`} aria-pressed={form.paymentMethod === m.value}
                    style={{
                      padding:"10px 14px", borderRadius:8, fontSize:13, cursor:"pointer", textAlign:"left",
                      border: form.paymentMethod === m.value ? "2px solid #2563eb" : "1.5px solid #e5e7eb",
                      background: form.paymentMethod === m.value ? "#eff6ff" : "#f9fafb",
                      color: form.paymentMethod === m.value ? "#1d4ed8" : "#374151",
                      fontWeight: form.paymentMethod === m.value ? 700 : 400,
                    }}>{m.label}</button>
                ))}
              </div>
              {pm && !PAYMENT_METHOD_CHOICES.some(m => m.value === pm) && (
                <p style={{ fontSize:11, color:"#b45309", margin:"4px 0 0" }}>기존 저장값({pm})을 유지합니다. 지급방식을 선택하면 변경됩니다.</p>
              )}

              {/* ③ 원천징수율 — 국내 계좌송금일 때만. 해외·기타는 기존 세무 처리 규칙 유지 */}
              {isDomestic && (
                <>
                  <p style={sH}>원천징수율</p>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:4 }}>
                    {WITHHOLDING_RATES.map(w => (
                      <button key={w.value} onClick={() => sf("withholdingRate", w.value)}
                        data-testid={`sensitive-withholding-${w.value}`} aria-label={`원천징수율 ${w.label}`} aria-pressed={form.withholdingRate === w.value}
                        style={{
                          padding:"10px 14px", borderRadius:8, fontSize:13, cursor:"pointer", textAlign:"left",
                          border: form.withholdingRate === w.value ? "2px solid #2563eb" : "1.5px solid #e5e7eb",
                          background: form.withholdingRate === w.value ? "#eff6ff" : "#f9fafb",
                          color: form.withholdingRate === w.value ? "#1d4ed8" : "#374151",
                          fontWeight: form.withholdingRate === w.value ? 700 : 400,
                        }}>{w.label}{defaultRate === w.value ? " (기본)" : ""}</button>
                    ))}
                  </div>
                  {rateUnconfirmed && (
                    <p style={{ fontSize:11, color:"#b45309", margin:"4px 0 0" }} data-testid="sensitive-withholding-unconfirmed">
                      기존 저장값: 미확정 (세무 검토) — 원천징수율을 확인 후 직접 선택하세요. 선택하지 않으면 기존 값이 유지됩니다.
                    </p>
                  )}
                  {rateMismatch && (
                    <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:8, fontSize:11, color:"#b45309", margin:"4px 0 0" }} data-testid="sensitive-withholding-mismatch">
                      정산유형 기본값({WITHHOLDING_RATES.find(w => w.value === defaultRate)?.label})과 다릅니다 — 확인 필요 (자동 변경하지 않음)
                      <button onClick={() => sf("withholdingRate", defaultRate)} data-testid="sensitive-withholding-apply-default" aria-label="원천징수율 기본값 적용"
                        style={{ padding:"2px 8px", borderRadius:6, border:"1px solid #fcd34d", background:"#fffbeb", color:"#92400e", fontSize:11, cursor:"pointer", whiteSpace:"nowrap" }}>
                        기본값 적용 → {WITHHOLDING_RATES.find(w => w.value === defaultRate)?.label}</button>
                    </div>
                  )}
                </>
              )}

              {/* ④ 주민등록번호 또는 사업자정보 */}
              {isBizInfo ? (
                <>
                  <p style={sH}>사업자 정보</p>
                  <div style={{ ...grid2, marginBottom:10 }}>
                    <Field label="사업자등록번호" value={form.businessNumber} onChange={v => sf("businessNumber", v)} placeholder="000-00-00000" mono />
                    <Field label="상호" value={form.businessName} onChange={v => sf("businessName", v)} placeholder="(주)회사명" />
                    <Field label="대표자명" value={form.businessOwner} onChange={v => sf("businessOwner", v)} placeholder="홍길동" />
                    <Field label="세금계산서 이메일" value={form.taxInvoiceEmail} onChange={v => sf("taxInvoiceEmail", v)} placeholder="tax@company.com" type="email" />
                  </div>
                </>
              ) : (
                <>
                  <p style={sH}>
                    주민등록번호
                    {(isPaypal || isBank || isOther) && (
                      <span style={{ fontSize:10, fontWeight:400, color:"#9ca3af", marginLeft:8, textTransform:"none", letterSpacing:0 }}>해외 방식 — 선택 입력</span>
                    )}
                  </p>
                  <ResidentInput
                    front={form.residentFront} back={form.residentBack} backRef={backRef}
                    onFront={v => { sf("residentFront", v); if (v.length === 6) backRef.current?.focus(); }}
                    onBack={v => sf("residentBack", v)}
                    existing={data?.residentNumberMasked}
                  />
                </>
              )}

              {/* ⑤ 계좌정보 — 국내·기타·미선택(해외 은행송금은 아래 해외 은행 정보, PayPal 은 계좌 불필요) */}
              {!isPaypal && !isBank && (
                <>
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

              {/* ⑥ 추가 정보 (항상 표시) */}
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
                {/* ⑦ 정산 메모 · 지급 보류 */}
                <p style={sH}>정산 메모 · 지급 보류</p>
                <div style={{ marginBottom:10 }}>
                  <Field label="정산 메모 (내부용)" value={form.settlementMemo} onChange={v => sf("settlementMemo", v)} placeholder="특이사항, 지급 조건 등" />
                </div>
                <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", marginBottom:14, fontSize:13, color:form.paymentHold ? "#dc2626" : "#374151" }}>
                  <input type="checkbox" checked={form.paymentHold} onChange={e => sf("paymentHold", e.target.checked)}
                    style={{ width:16, height:16, accentColor:"#dc2626" }} />
                  <span style={{ fontWeight: form.paymentHold ? 700 : 400 }}>⏸ 지급 보류 (이 통번역사에게 지급을 일시 중단)</span>
                </label>
              </>

              <div style={{ display:"flex", gap:8, paddingTop:4 }}>
                <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize:13, padding:"9px 20px" }}>
                  {saving ? "저장 중..." : "저장"}
                </PrimaryBtn>
                {data?.exists && (
                  <GhostBtn onClick={() => {
                    setForm(p => ({ ...p, settlementType: savedSettlementType }));
                    setEditMode(false);
                  }} style={{ fontSize:13, padding:"9px 16px" }}>취소</GhostBtn>
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

export function BankNameSelect({ value, onChange, label, inputStyle, labelStyle }: {
  value: string; onChange: (v: string) => void; label: string;
  inputStyle: React.CSSProperties; labelStyle: React.CSSProperties;
}) {
  const inList = (BANK_LIST as readonly string[]).includes(value);
  const [otherMode, setOtherMode] = useState(!inList && value !== "");

  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <ClickSelect
        value={otherMode ? "__other__" : (inList ? value : "")}
        onChange={v => {
          if (v === "__other__") { setOtherMode(true); onChange(""); }
          else { setOtherMode(false); onChange(v); }
        }}
        style={{ width: "100%" }}
        triggerStyle={{ ...inputStyle, width: "100%", boxSizing: "border-box" as const }}
        searchable
        options={[
          { value: "", label: "선택 안 함" },
          ...BANK_LIST.map(b => ({ value: b, label: b })),
          { value: "__other__", label: "기타 (직접 입력)" },
        ]}
      />
      {otherMode && (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="은행명 직접 입력"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          style={{ ...inputStyle, marginTop: 6 }}
        />
      )}
    </div>
  );
}

function BankFields({ form, sf }: { form: ReturnType<typeof emptyForm>; sf: (k: keyof ReturnType<typeof emptyForm>, v: string | boolean) => void }) {
  return (
    <div style={{ ...grid3, marginBottom:10 }}>
      <BankNameSelect label="은행명" value={form.bankName} onChange={v => sf("bankName", v)} inputStyle={inp} labelStyle={lbl} />
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
        <input type="text" inputMode="numeric" value={front} onChange={e => onFront(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onPaste={e => {
            // CRM 전체 주민번호(13자리)를 한 번에 붙여넣으면 앞 6 / 뒤 7로 자동 분리
            const digits = (e.clipboardData.getData("text") || "").replace(/\D/g, "");
            if (digits.length === 13) { e.preventDefault(); onFront(digits.slice(0, 6)); onBack(digits.slice(6, 13)); backRef.current?.focus(); }
          }}
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
