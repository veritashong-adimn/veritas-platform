import React, { useState, useEffect, useRef } from "react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";
import { DraggableModal } from "./DraggableModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelSt: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4,
};
const sH: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.06em", margin: "18px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};

const PAYMENT_METHODS = [
  { value: "withholding_3_3", label: "3.3% 원천징수" },
  { value: "overseas_remittance", label: "해외송금" },
  { value: "tax_invoice", label: "세금계산서" },
];

type SensitiveData = {
  exists: boolean;
  residentNumberMasked: string | null;
  bankName: string | null;
  bankAccount: string | null;
  accountHolder: string | null;
  paymentMethod: string | null;
  updatedAt?: string;
};

export function SensitiveInfoModal({ userId, userName, token, onClose, onToast }: {
  userId: number;
  userName: string;
  token: string;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [data, setData] = useState<SensitiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState({
    residentFront: "",
    residentBack: "",
    bankName: "", bankAccount: "", accountHolder: "",
    paymentMethod: "",
  });

  const backRef = useRef<HTMLInputElement>(null);
  const authH = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    setLoading(true);
    fetch(api(`/api/admin/translators/${userId}/sensitive`), { headers: authH })
      .then(r => r.json())
      .then((d: SensitiveData) => {
        setData(d);
        setForm({
          residentFront: "",
          residentBack: "",
          bankName: d.bankName ?? "",
          bankAccount: d.bankAccount ?? "",
          accountHolder: d.accountHolder ?? "",
          paymentMethod: d.paymentMethod ?? "",
        });
        if (!d.exists) setEditMode(true);
      })
      .catch(() => onToast("오류: 민감정보 불러오기 실패"))
      .finally(() => setLoading(false));
  }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const rn = `${form.residentFront.trim()}${form.residentBack.trim()}`;
      const body: Record<string, string | undefined> = {
        bankName: form.bankName.trim() || undefined,
        bankAccount: form.bankAccount.trim() || undefined,
        accountHolder: form.accountHolder.trim() || undefined,
        paymentMethod: form.paymentMethod || undefined,
      };
      if (rn.length >= 6) {
        body.residentNumber = rn;
      }

      const res = await fetch(api(`/api/admin/translators/${userId}/sensitive`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) { onToast(`오류: ${d.error}`); return; }
      setData(d);
      setForm(p => ({ ...p, residentFront: "", residentBack: "" }));
      setEditMode(false);
      onToast("정산 정보가 저장되었습니다.");
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const handleEnterEdit = () => {
    setForm(p => ({ ...p, residentFront: "", residentBack: "" }));
    setEditMode(true);
  };

  const paymentMethodLabel = (val: string | null) =>
    PAYMENT_METHODS.find(m => m.value === val)?.label ?? val ?? "미등록";

  return (
    <DraggableModal
      title="정산/세무 정보 관리"
      subtitle={`${userName} — 민감 개인정보`}
      onClose={onClose}
      width={560}
      zIndex={400}
      bodyPadding="20px 28px"
    >
      {/* 보안 안내 배너 */}
      <div style={{
        display: "flex", gap: 10, alignItems: "flex-start",
        background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 10,
        padding: "12px 14px", marginBottom: 16,
      }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>🔒</span>
        <div style={{ fontSize: 12, color: "#92400e", lineHeight: 1.5 }}>
          <strong>민감 개인정보 보호 구역</strong><br />
          이 화면은 admin / finance 권한자만 접근 가능합니다.<br />
          모든 조회·수정 이력이 서버 로그에 기록됩니다.
        </div>
      </div>

      {loading ? (
        <p style={{ color: "#9ca3af", textAlign: "center", padding: "24px 0" }}>불러오는 중...</p>
      ) : (
        <>
          {/* 뷰 모드 */}
          {data && !editMode && (
            <>
              <p style={sH}>저장된 정보</p>

              {/* 주민등록번호 */}
              <div style={{ marginBottom: 12 }}>
                <InfoField label="주민등록번호" value={data.residentNumberMasked ?? "미등록"} sensitive />
              </div>

              {/* 계좌 정보 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
                <InfoField label="은행명" value={data.bankName ?? "미등록"} />
                <InfoField label="예금주" value={data.accountHolder ?? "미등록"} />
                <InfoField label="계좌번호" value={data.bankAccount ?? "미등록"} mono />
              </div>

              {/* 지급방식 */}
              <div style={{ marginBottom: 12 }}>
                <InfoField label="지급 방식" value={paymentMethodLabel(data.paymentMethod)} />
              </div>

              {data.updatedAt && (
                <p style={{ fontSize: 11, color: "#9ca3af", marginBottom: 12 }}>
                  마지막 수정: {new Date(data.updatedAt).toLocaleString("ko-KR")}
                </p>
              )}
              {!data.exists && (
                <div style={{ padding: "16px", background: "#f9fafb", borderRadius: 8, textAlign: "center", marginBottom: 12 }}>
                  <p style={{ color: "#9ca3af", fontSize: 13, margin: "0 0 8px" }}>아직 등록된 정산 정보가 없습니다.</p>
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryBtn onClick={handleEnterEdit} style={{ fontSize: 13, padding: "8px 16px" }}>
                  {data.exists ? "정보 수정" : "정보 등록"}
                </PrimaryBtn>
                <GhostBtn onClick={onClose} style={{ fontSize: 13, padding: "8px 16px" }}>닫기</GhostBtn>
              </div>
            </>
          )}

          {/* 편집 모드 */}
          {editMode && (
            <>
              <p style={sH}>정산/세무 정보 입력</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>

                {/* 주민등록번호 분리 입력 */}
                <div>
                  <label style={labelSt}>
                    주민등록번호
                    {data?.exists && data.residentNumberMasked && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>
                        현재: {data.residentNumberMasked} (공백 시 기존 유지)
                      </span>
                    )}
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="password"
                      value={form.residentFront}
                      onChange={e => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                        setForm(p => ({ ...p, residentFront: v }));
                        if (v.length === 6) backRef.current?.focus();
                      }}
                      placeholder="앞 6자리"
                      maxLength={6}
                      autoComplete="off"
                      style={{ ...inputStyle, width: 120, textAlign: "center", fontFamily: "monospace", letterSpacing: 2 }}
                    />
                    <span style={{ fontSize: 18, color: "#d1d5db", fontWeight: 700, flexShrink: 0 }}>-</span>
                    <input
                      ref={backRef}
                      type="password"
                      value={form.residentBack}
                      onChange={e => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 7);
                        setForm(p => ({ ...p, residentBack: v }));
                      }}
                      placeholder="뒤 7자리"
                      maxLength={7}
                      autoComplete="off"
                      style={{ ...inputStyle, width: 130, textAlign: "center", fontFamily: "monospace", letterSpacing: 2 }}
                    />
                    <span style={{ fontSize: 11, color: "#9ca3af", flexShrink: 0 }}>AES-256 암호화 저장</span>
                  </div>
                  <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                    저장 후 조회 시 앞 6자리만 표시됩니다 (예: 900101-***)
                  </p>
                </div>

                {/* 지급방식 */}
                <div>
                  <label style={labelSt}>지급 방식</label>
                  <select
                    value={form.paymentMethod}
                    onChange={e => setForm(p => ({ ...p, paymentMethod: e.target.value }))}
                    style={inputStyle}
                  >
                    <option value="">선택 안 함</option>
                    {PAYMENT_METHODS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>

                {/* 은행 정보 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                  <div>
                    <label style={labelSt}>은행명</label>
                    <input value={form.bankName} onChange={e => setForm(p => ({ ...p, bankName: e.target.value }))}
                      placeholder="예: 국민은행" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelSt}>예금주</label>
                    <input value={form.accountHolder} onChange={e => setForm(p => ({ ...p, accountHolder: e.target.value }))}
                      placeholder="예금주명" style={inputStyle} />
                  </div>
                </div>
                <div>
                  <label style={labelSt}>계좌번호</label>
                  <input value={form.bankAccount} onChange={e => setForm(p => ({ ...p, bankAccount: e.target.value }))}
                    placeholder="예: 123-456-789012" style={{ ...inputStyle, fontFamily: "monospace", letterSpacing: 1 }} />
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: "9px 20px" }}>
                  {saving ? "저장 중..." : "저장"}
                </PrimaryBtn>
                {data?.exists && (
                  <GhostBtn onClick={() => setEditMode(false)} style={{ fontSize: 13, padding: "9px 16px" }}>취소</GhostBtn>
                )}
                <GhostBtn onClick={onClose} style={{ fontSize: 13, padding: "9px 16px" }}>닫기</GhostBtn>
              </div>
            </>
          )}
        </>
      )}
    </DraggableModal>
  );
}

function InfoField({ label, value, sensitive = false, mono = false }: {
  label: string; value: string; sensitive?: boolean; mono?: boolean;
}) {
  return (
    <div style={{
      padding: "10px 12px", background: sensitive ? "#fef3c7" : "#f9fafb",
      borderRadius: 8, border: `1px solid ${sensitive ? "#fde68a" : "#f3f4f6"}`,
    }}>
      <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: 14, fontWeight: 700,
        color: value === "미등록" ? "#d1d5db" : sensitive ? "#92400e" : "#111827",
        fontFamily: (sensitive || mono) ? "monospace" : undefined,
        letterSpacing: sensitive ? 1 : undefined,
      }}>
        {sensitive && value !== "미등록" ? `🔒 ${value}` : value}
      </div>
    </div>
  );
}
