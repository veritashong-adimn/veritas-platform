import React, { useState, useRef } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
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
const LANG_LEVELS = ["일반", "전문"];

function formatPhoneNumber(value: string): string {
  const n = value.replace(/\D/g, "");
  if (n.length <= 3) return n;
  if (n.length <= 7) return `${n.slice(0, 3)}-${n.slice(3)}`;
  return `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7, 11)}`;
}
const WORK_TYPES = ["번역", "통역", "편집", "감수", "직접입력"];
const SUB_TYPES_MAP: Record<string, string[]> = {
  "번역": ["일반번역", "전문번역", "긴급번역", "공증번역"],
  "통역": ["동시통역", "순차통역", "수행통역", "미팅통역", "전시회통역", "전화통역", "화상통역"],
  "편집": ["원어민감수", "윤문", "교정", "편집", "DTP"],
  "감수": ["번역감수", "전문감수", "원어민감수"],
  "직접입력": [],
};
const TRANS_UNITS = [
  { value: "word", label: "단어" }, { value: "eojeol", label: "어절" },
  { value: "char", label: "글자" }, { value: "page", label: "페이지" }, { value: "item", label: "건" },
];
const INTERP_UNITS = [
  { value: "1h", label: "1시간" }, { value: "2h", label: "2시간" },
  { value: "4h", label: "4시간" }, { value: "6h", label: "6시간" },
  { value: "8h", label: "8시간" }, { value: "extra", label: "추가시간" },
  { value: "day", label: "일" }, { value: "item", label: "건" },
];
const UNIT_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  "번역": TRANS_UNITS, "통역": INTERP_UNITS, "편집": TRANS_UNITS,
  "감수": TRANS_UNITS, "직접입력": [...TRANS_UNITS, ...INTERP_UNITS.filter(u => u.value !== "item")],
};
const languageDirectionMap: Record<string, string[]> = {
  영어: ["한→영", "영→한"], 일본어: ["한→일", "일→한"], 중국어: ["한→중", "중→한"],
  러시아어: ["한→러", "러→한"], 스페인어: ["한→스", "스→한"], 독일어: ["한→독", "독→한"],
  프랑스어: ["한→프", "프→한"], 아랍어: ["한→아", "아→한"], 이탈리아어: ["한→이", "이→한"],
  터키어: ["한→터", "터→한"], 포르투갈어: ["한→포", "포→한"], 폴란드어: ["한→폴", "폴→한"],
  스웨덴어: ["한→스웨", "스웨→한"], 네덜란드어: ["한→네", "네→한"], 그리스어: ["한→그", "그→한"],
  체코어: ["한→체", "체→한"], 페르시아어: ["한→페", "페→한"], 히브리어: ["한→히", "히→한"],
  베트남어: ["한→베", "베→한"], 몽골어: ["한→몽", "몽→한"], 태국어: ["한→태", "태→한"],
  인도네시아어: ["한→인니", "인니→한"], 캄보디아어: ["한→캄", "캄→한"], 인도어: ["한→인", "인→한"],
  파키스탄어: ["한→파", "파→한"], 스리랑카어: ["한→스리", "스리→한"], 방글라데시어: ["한→방", "방→한"],
  미얀마어: ["한→미", "미→한"], 라오스어: ["한→라", "라→한"], 광동어: ["한→광", "광→한"],
  우즈베키스탄어: ["한→우즈", "우즈→한"], 우크라이나어: ["한→우크", "우크→한"], 기타어: [],
};
const LANGUAGES = Object.keys(languageDirectionMap);
const getLangDirs = (language: string, langCustom: string): string[] => {
  if (language === "기타어") {
    const name = langCustom.trim();
    if (!name) return [];
    return [`한→${name}`, `${name}→한`];
  }
  return languageDirectionMap[language] ?? [];
};
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

  type RateEntry = { workType: string; subType: string; language: string; langCustom: string; langDir: string; unit: string; rate: string; memo: string };

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<RateEntry[]>([]);
  const [rateErrors, setRateErrors] = useState<string[]>([]);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    email: "", name: "", phone: "", region: "",
    languagePairs: "", languageLevel: "",
    education: "", major: "", graduationYear: "", specializations: "", grade: "", rating: "",
    bio: "", availabilityStatus: "available",
  });
  const [createdInvite, setCreatedInvite] = useState<{ email: string; inviteToken: string } | null>(null);
  const [sf, setSF] = useState(emptySensitive());
  const backRef = useRef<HTMLInputElement>(null);
  const authH = { Authorization: `Bearer ${token}` };

  const setF = (key: keyof typeof form, val: string) => {
    setForm(p => ({ ...p, [key]: val }));
    setErrors(p => { const n = { ...p }; delete n[key]; return n; });
  };
  const setSf = (key: keyof ReturnType<typeof emptySensitive>, val: string | boolean) =>
    setSF(p => ({ ...p, [key]: val }));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.email.trim()) e.email = "이메일을 입력하세요.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "올바른 이메일 형식이 아닙니다.";
    if (!form.name.trim()) e.name = "이름을 입력하세요.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      // 단가 중복 검사 (클라이언트)
      const seen = new Set<string>();
      const rErr: string[] = rates.map(_ => "");
      let hasDup = false;
      rates.forEach((r, i) => {
        const langVal = r.language === "기타어" ? r.langCustom.trim() || "기타어" : r.language.trim();
        const key = `${r.workType}|${r.subType}|${langVal}|${r.langDir}|${r.unit}`;
        if (seen.has(key)) { rErr[i] = "동일한 업무유형+세부유형+언어+언어방향+단가단위 조합이 중복됩니다."; hasDup = true; }
        else seen.add(key);
      });
      if (hasDup) { setRateErrors(rErr); return; }

      const res = await fetch(api("/api/admin/translators"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim(),
          name: form.name.trim(), phone: form.phone.trim() || undefined,
          region: form.region.trim() || undefined,
          languagePairs: form.languagePairs.trim() || undefined,
          languageLevel: form.languageLevel || undefined,
          specializations: form.specializations.trim() || undefined,
          education: form.education.trim() || undefined,
          major: form.major.trim() || undefined,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : undefined,
          rating: form.rating ? Number(form.rating) : undefined,
          grade: form.grade || undefined,
          bio: form.bio.trim() || undefined,
          availabilityStatus: form.availabilityStatus,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) setErrors({ email: data.error });
        else onToast(`오류: ${data.error}`);
        return;
      }
      setCreatedInvite({ email: data.email, inviteToken: data.inviteToken });

      const userId = data.id;

      for (const r of rates) {
        if (!r.workType || !r.unit || !r.rate) continue;
        const langVal = r.language === "기타어" ? r.langCustom.trim() || "기타어" : r.language.trim() || null;
        await fetch(api(`/api/admin/translators/${userId}/rates`), {
          method: "POST", headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify({
            workType: r.workType,
            subType: r.subType.trim() || null,
            language: langVal,
            languagePair: r.langDir.trim() || null,
            unit: r.unit,
            rate: Number(r.rate),
            memo: r.memo || null,
          }),
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

      // 이력서 파일 업로드 (선택한 경우)
      if (resumeFile) {
        const fd = new FormData();
        fd.append("file", resumeFile);
        await fetch(api(`/api/admin/translators/${userId}/resume-upload`), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        }).catch(() => {});
      }

      onToast(`통번역사 "${data.name ?? data.email}"이(가) 등록되었습니다.`);
      onCreated(data);
      // 초대 링크 화면으로 전환 (onClose는 사용자가 확인 후 호출)
    } catch { onToast("오류: 등록 실패"); }
    finally { setSaving(false); }
  };

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

  const inviteUrl = createdInvite
    ? `${window.location.origin}/set-password?token=${createdInvite.inviteToken}`
    : "";

  if (createdInvite) {
    return (
      <DraggableModal title="등록 완료" subtitle="초대 링크를 발송하거나 복사해 전달하세요" onClose={onClose} width={600} zIndex={310} bodyPadding="28px 32px">
        <div style={{ textAlign: "center", padding: "8px 0 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <p style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 4 }}>
            {createdInvite.email}
          </p>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
            계정이 생성되었습니다. 아래 링크를 통번역사에게 전달하면 비밀번호를 직접 설정할 수 있습니다.
          </p>
          <div style={{ background: "#f3f4f6", borderRadius: 10, padding: "14px 16px", marginBottom: 20, textAlign: "left" }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>비밀번호 설정 링크</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input readOnly value={inviteUrl} style={{
                flex: 1, padding: "8px 10px", fontSize: 12, fontFamily: "monospace",
                borderRadius: 6, border: "1px solid #d1d5db", background: "#fff",
                color: "#374151", outline: "none",
              }} onClick={e => (e.target as HTMLInputElement).select()} />
              <button
                onClick={() => { navigator.clipboard.writeText(inviteUrl); onToast("초대 링크가 복사되었습니다."); }}
                style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #2563eb", background: "#eff6ff", color: "#1d4ed8", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                복사
              </button>
            </div>
          </div>
          <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 24, textAlign: "left" }}>
            <p style={{ fontSize: 12, color: "#92400e", margin: 0 }}>
              ⚠️ 이 링크는 비밀번호 설정 전까지만 유효합니다. 설정 완료 후 자동으로 만료됩니다.
            </p>
          </div>
          <PrimaryBtn onClick={onClose} style={{ width: "100%", fontSize: 14, padding: "10px 0" }}>
            확인
          </PrimaryBtn>
        </div>
      </DraggableModal>
    );
  }

  return (
    <DraggableModal title="통번역사 등록" subtitle="초대 기반 계정 생성 — 비밀번호는 통번역사가 직접 설정합니다" onClose={onClose} width={800} zIndex={310} bodyPadding="20px 28px">

      {/* ── 기본 정보 ── */}
      <p style={sH}>기본 정보</p>
      <div style={grid2}>
        {F({ label: "이름", field: "name", placeholder: "홍길동", required: true })}
        <div>
          <label style={labelSt}>휴대폰</label>
          <input type="tel" value={form.phone}
            onChange={e => setF("phone", formatPhoneNumber(e.target.value))}
            placeholder="010-0000-0000"
            style={{ ...inputStyle, borderColor: errors.phone ? "#dc2626" : "#d1d5db" }} />
          {errors.phone && <span style={errStyle}>{errors.phone}</span>}
        </div>
        {F({ label: "이메일", field: "email", type: "email", placeholder: "example@email.com", required: true })}
        {F({ label: "지역", field: "region", placeholder: "서울, 경기..." })}
        <div>
          <label style={labelSt}>언어쌍</label>
          <input value={form.languagePairs} onChange={e => setF("languagePairs", e.target.value)}
            placeholder="예: 한→영, 영→한, 한→일" style={inputStyle} />
          <span style={{ fontSize: 11, color: "#9ca3af" }}>쉼표로 구분하여 여러 언어쌍 입력</span>
        </div>
        <div>
          <label style={labelSt}>언어 레벨</label>
          <ClickSelect value={form.languageLevel} onChange={v => setF("languageLevel", v)}
            style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8 }}
            options={[{ value: "", label: "선택 안 함" }, ...LANG_LEVELS.map(l => ({ value: l, label: l }))]} />
        </div>
      </div>

      {/* ── 프로필 편집 ── */}
      <p style={sH}>프로필 편집</p>
      <div style={grid2}>
        {F({ label: "학력", field: "education", placeholder: "예: 서울대학교" })}
        {F({ label: "전공", field: "major", placeholder: "예: 영어영문학" })}
        {F({ label: "졸업연도", field: "graduationYear", type: "number", placeholder: "예: 2018" })}
        {F({ label: "전문분야", field: "specializations", placeholder: "예: 법률, IT, 의학" })}
        <div>
          <label style={labelSt}>등급</label>
          <ClickSelect value={form.grade} onChange={v => setF("grade", v)}
            style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8 }}
            options={[{ value: "", label: "등급 없음" }, ...GRADES.map(g => ({ value: g, label: `${g}등급` }))]} />
        </div>
        {F({ label: "평점 (1-5)", field: "rating", type: "number", placeholder: "예: 4.5" })}
        <div>
          <label style={labelSt}>가용 상태</label>
          <ClickSelect value={form.availabilityStatus} onChange={v => setF("availabilityStatus", v)}
            style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "9px 12px", borderRadius: 8 }}
            options={[
              { value: "available", label: "가능" }, { value: "busy", label: "바쁨" }, { value: "unavailable", label: "불가" },
            ]} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <label style={labelSt}>상세정보 (경력·특이사항)</label>
        <textarea value={form.bio} onChange={e => setF("bio", e.target.value)} rows={3}
          placeholder="출신학교, 경력 요약, 전문분야, 통역/번역 특징, 주의사항 등" style={{ ...inputStyle, resize: "vertical" }} />
      </div>
      <div style={{ marginTop: 8 }}>
        <label style={labelSt}>이력서 파일 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(선택·등록 후 업로드됨)</span></label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="file"
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={e => setResumeFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 12, flex: 1, minWidth: 0 }}
          />
          {resumeFile && (
            <span style={{ fontSize: 12, color: "#6366f1", whiteSpace: "nowrap" }}>
              📄 {resumeFile.name}
            </span>
          )}
        </div>
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "3px 0 0" }}>PDF, DOC, DOCX · 최대 10MB</p>
      </div>

      {/* ── 단가 등록 ── */}
      <p style={sH}>단가 등록</p>
      {rates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
          {rates.map((r, i) => {
            const clearRateErr = () => setRateErrors(p => { const n = [...p]; n[i] = ""; return n; });
            const updateRate = (patch: Partial<typeof r>) => setRates(p => p.map((x, idx) => idx === i ? { ...x, ...patch } : x));
            const unitOpts = UNIT_BY_TYPE[r.workType] ?? TRANS_UNITS;
            return (
              <div key={i} style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
                {/* 행 1: 업무유형 / 세부유형 / 언어 / 언어방향 / 삭제 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: "6px 8px", marginBottom: 6, alignItems: "end" }}>
                  <div>
                    <label style={{ ...labelSt, marginBottom: 2 }}>업무유형</label>
                    <ClickSelect value={r.workType}
                      onChange={v => {
                        const units = UNIT_BY_TYPE[v] ?? TRANS_UNITS;
                        const subs = SUB_TYPES_MAP[v] ?? [];
                        updateRate({ workType: v, subType: subs[0] ?? "", unit: units[0]?.value ?? "eojeol" });
                        clearRateErr();
                      }}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 7 }}
                      options={WORK_TYPES.map(w => ({ value: w, label: w }))} />
                  </div>
                  <div>
                    <label style={{ ...labelSt, marginBottom: 2 }}>세부유형</label>
                    {r.workType === "직접입력" ? (
                      <input value={r.subType} onChange={e => { updateRate({ subType: e.target.value }); clearRateErr(); }}
                        placeholder="세부유형 입력" style={{ ...inputStyle, padding: "7px 10px", fontSize: 13 }} />
                    ) : (
                      <ClickSelect value={r.subType}
                        onChange={v => { updateRate({ subType: v }); clearRateErr(); }}
                        style={{ width: "100%" }}
                        triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 7 }}
                        options={[
                          { value: "", label: "세부유형 선택" },
                          ...(SUB_TYPES_MAP[r.workType] ?? []).map(s => ({ value: s, label: s })),
                        ]} />
                    )}
                  </div>
                  <div>
                    <label style={{ ...labelSt, marginBottom: 2 }}>언어</label>
                    <ClickSelect value={r.language}
                      onChange={v => {
                        const dirs = getLangDirs(v, r.langCustom);
                        updateRate({ language: v, langDir: dirs[0] ?? "" });
                        clearRateErr();
                      }}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 7 }}
                      options={LANGUAGES.map(l => ({ value: l, label: l }))} />
                    {r.language === "기타어" && (
                      <input value={r.langCustom}
                        onChange={e => {
                          const val = e.target.value;
                          const dirs = getLangDirs("기타어", val);
                          updateRate({ langCustom: val, langDir: dirs[0] ?? "" });
                          clearRateErr();
                        }}
                        placeholder="기타 언어명 (예: 말레이어)"
                        style={{ ...inputStyle, padding: "5px 8px", fontSize: 12, marginTop: 4 }} />
                    )}
                  </div>
                  <div>
                    <label style={{ ...labelSt, marginBottom: 2 }}>언어방향</label>
                    {(() => {
                      const dirs = getLangDirs(r.language, r.langCustom);
                      return dirs.length > 0 ? (
                        <ClickSelect value={r.langDir}
                          onChange={v => { updateRate({ langDir: v }); clearRateErr(); }}
                          style={{ width: "100%" }}
                          triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 7 }}
                          options={dirs.map(d => ({ value: d, label: d }))} />
                      ) : (
                        <input value={r.langDir}
                          onChange={e => { updateRate({ langDir: e.target.value }); clearRateErr(); }}
                          placeholder={r.language === "기타어" ? "언어명 입력 후 자동 생성" : "언어방향"}
                          style={{ ...inputStyle, padding: "7px 10px", fontSize: 13, color: "#9ca3af" }}
                          readOnly={dirs.length === 0 && r.language !== "기타어"} />
                      );
                    })()}
                  </div>
                  <button onClick={() => { setRates(p => p.filter((_, idx) => idx !== i)); setRateErrors(p => p.filter((_, idx) => idx !== i)); }}
                    style={{ background: "none", border: "none", color: "#dc2626", fontSize: 18, cursor: "pointer", padding: "0 4px", marginTop: 16 }}>×</button>
                </div>
                {/* 행 2: 단가단위 / 단가 / 메모 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 1fr", gap: "6px 8px" }}>
                  <div>
                    <label style={{ ...labelSt, marginBottom: 2 }}>단가단위</label>
                    <ClickSelect value={r.unit}
                      onChange={v => { updateRate({ unit: v }); clearRateErr(); }}
                      style={{ width: "100%" }}
                      triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 7 }}
                      options={unitOpts} />
                  </div>
                  <div>
                    <label style={{ ...labelSt, marginBottom: 2 }}>단가 (원)</label>
                    <input type="number" value={r.rate} onChange={e => { updateRate({ rate: e.target.value }); clearRateErr(); }}
                      placeholder="예: 40" style={{ ...inputStyle, padding: "7px 10px", fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ ...labelSt, marginBottom: 2 }}>메모</label>
                    <input type="text" value={r.memo} onChange={e => updateRate({ memo: e.target.value })}
                      placeholder="특이사항 등" style={{ ...inputStyle, padding: "7px 10px", fontSize: 13 }} />
                  </div>
                </div>
                {rateErrors[i] && <p style={{ ...errStyle, marginTop: 4 }}>{rateErrors[i]}</p>}
              </div>
            );
          })}
        </div>
      )}
      <button
        onClick={() => setRates(p => [...p, { workType: "번역", subType: "일반번역", language: "영어", langCustom: "", langDir: "한→영", unit: "eojeol", rate: "", memo: "" }])}
        style={{ fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 8, border: "1.5px dashed #9ca3af", background: "#f9fafb", color: "#374151", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        + 단가 추가
      </button>

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
                  {SA({ label: "은행명", field: "bankName", placeholder: "국민은행" })}
                  {SA({ label: "예금주", field: "accountHolder", placeholder: "홍길동" })}
                  {SA({ label: "계좌번호", field: "bankAccount", placeholder: "123-456-789012", mono: true })}
                </div>
              </>
            )}

            {/* ── 국내 사업자 ── */}
            {isDomesticBiz && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>사업자 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "사업자등록번호", field: "businessNumber", placeholder: "000-00-00000", mono: true })}
                  {SA({ label: "상호", field: "businessName", placeholder: "(주)회사명" })}
                  {SA({ label: "대표자명", field: "businessOwner", placeholder: "홍길동" })}
                  {SA({ label: "세금계산서 이메일", field: "taxInvoiceEmail", placeholder: "tax@company.com", type: "email" })}
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>계좌정보</p>
                <div style={{ ...grid3, marginBottom: 4 }}>
                  {SA({ label: "은행명", field: "bankName", placeholder: "국민은행" })}
                  {SA({ label: "예금주", field: "accountHolder", placeholder: "홍길동" })}
                  {SA({ label: "계좌번호", field: "bankAccount", placeholder: "123-456-789012", mono: true })}
                </div>
              </>
            )}

            {/* ── 해외 PayPal ── */}
            {isPaypal && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>PayPal 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "PayPal 계정 이메일", field: "paypalEmail", placeholder: "paypal@email.com", type: "email" })}
                  {SA({ label: "영문이름 (Full Name)", field: "englishName", placeholder: "Hong Gil Dong" })}
                  {SA({ label: "국가", field: "country", placeholder: "South Korea" })}
                  <div>
                    <label style={labelAmber}>통화</label>
                    <ClickSelect value={sf.currency} onChange={v => setSf("currency", v)}
                      style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                      options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
                  </div>
                </div>
                {SA({ label: "송금 메모 (선택)", field: "remittanceMemo", placeholder: "프로젝트명 또는 메모" })}
              </>
            )}

            {/* ── 해외 은행송금 ── */}
            {isBank && (
              <>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>수취인 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "영문이름 (Full Name)", field: "englishName", placeholder: "Hong Gil Dong" })}
                  {SA({ label: "국가", field: "country", placeholder: "United States" })}
                  <div>
                    <label style={labelAmber}>통화</label>
                    <ClickSelect value={sf.currency} onChange={v => setSf("currency", v)}
                      style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                      options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
                  </div>
                  {SA({ label: "거주지 영문주소", field: "addressEn", placeholder: "123 Main St, City, State" })}
                </div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#92400e", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>해외 은행 정보</p>
                <div style={{ ...grid2, marginBottom: 12 }}>
                  {SA({ label: "은행명(영문)", field: "bankNameEn", placeholder: "Bank of America" })}
                  {SA({ label: "계좌번호", field: "bankAccount", placeholder: "Account Number", mono: true })}
                  {SA({ label: "SWIFT Code", field: "swiftCode", placeholder: "AAAABBCC", mono: true })}
                  {SA({ label: "Routing Number", field: "routingNumber", placeholder: "021000021", mono: true })}
                </div>
                {SA({ label: "IBAN (선택)", field: "iban", placeholder: "GB33BUKB20201555555555", mono: true })}
              </>
            )}

            {/* ── 기타 ── */}
            {isOther && (
              SA({ label: "정산 방식 설명", field: "settlementMemo", placeholder: "지급 방식 및 기타 정보를 입력하세요" })
            )}

            {/* ── 공통 추가 정보 ── */}
            {hasMethod && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed #fde68a" }}>
                <div style={{ ...grid2, marginBottom: 10 }}>
                  <div>
                    <label style={labelAmber}>기본 통화</label>
                    <ClickSelect value={sf.baseCurrency} onChange={v => setSf("baseCurrency", v)}
                      style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                      options={[{ value: "", label: "선택 안 함" }, ...CURRENCIES.map(c => ({ value: c, label: c }))]} />
                  </div>
                  {(isPaypal || isBank) && (
                    <div>
                      <label style={labelAmber}>해외송금 수수료 부담</label>
                      <ClickSelect value={sf.remittanceFeePayer} onChange={v => setSf("remittanceFeePayer", v)}
                        style={{ width: "100%" }} triggerStyle={{ ...inpAmber, width: "100%", boxSizing: "border-box" as const }}
                        options={[{ value: "", label: "선택 안 함" }, ...FEE_PAYER_OPTIONS.map(f => ({ value: f.value, label: f.label }))]} />
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
