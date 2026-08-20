import React, { useState, useEffect, useCallback } from "react";
import { Landmark } from "lucide-react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn } from "../ui";

// ─────────────────────────────────────────────────────────────────────────────
// 거래처 지급/환급 계좌정보 섹션 — 모든 거래처 유형(고객사/외주업체/행사·운영/기타)에서 사용.
//  · 용역대금 지급·오송금 반환·과입금 반환·환불 등에 재사용하는 정식 계좌 원천(company_sensitive).
//  · 계좌번호는 서버가 마스킹한 값만 표시·수신한다. 원본은 브라우저로 오지 않는다(§5).
//  · 저장 시 서버가 암호화(upsert). 빈 계좌번호 입력은 기존값 보존(모르고 삭제 방지).
//  · 지급 실행의 [계좌 재검증]이 이 원천을 조회하여 verified/ready 로 전환한다(§7·§8).
// ─────────────────────────────────────────────────────────────────────────────
type PaymentAccount = {
  companyId: number;
  bankName: string | null;
  bankAccountMasked: string | null;
  accountHolder: string | null;
  hasAccount: boolean;
  updatedAt: string | null;
};

const sH: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: "#111827",
  borderLeft: "3px solid #6366f1", paddingLeft: 10, margin: 0, lineHeight: 1.5,
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: "#374151", display: "block", marginBottom: 4, fontWeight: 600 };

export function CompanyPaymentAccountSection({ companyId, token, onToast }: {
  companyId: number; token: string; onToast: (msg: string) => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [acct, setAcct] = useState<PaymentAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ bankName: "", bankAccount: "", accountHolder: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/payment-account`), { headers: authH });
      const data = await res.json().catch(() => null);
      if (res.ok && data) setAcct(data);
    } catch { /* 조회 실패는 조용히 미등록 취급 */ }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, token]);

  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    setForm({ bankName: acct?.bankName ?? "", bankAccount: "", accountHolder: acct?.accountHolder ?? "" });
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/payment-account`), {
        method: "PUT", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${data.error ?? "지급/환급 계좌정보 저장 실패"}`); return; }
      setAcct(data);
      setEditing(false);
      onToast("지급/환급 계좌정보가 저장되었습니다.");
    } catch { onToast("오류: 지급/환급 계좌정보 저장 실패"); }
    finally { setSaving(false); }
  };

  const val = (v: string | null | undefined) => (v && v.trim() ? v : "미등록");

  return (
    <div data-testid="company-payment-account-section" style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "20px 0 10px" }}>
        <p style={sH}>지급/환급 계좌정보</p>
        {!editing && !loading && (
          <GhostBtn onClick={startEdit} style={{ fontSize: 12, padding: "4px 12px" }}
            data-testid="btn-company-payment-account-edit" aria-label="지급/환급 계좌정보 수정">
            {acct?.hasAccount ? "계좌 수정" : "계좌 등록"}
          </GhostBtn>
        )}
      </div>

      {loading ? (
        <p style={{ color: "#9ca3af", fontSize: 13, padding: "4px 0" }}>불러오는 중…</p>
      ) : editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
          <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>
            지급(용역대금)·환급(오송금/과입금 반환) 등 이 거래처에 대한 송금 시 사용하는 정식 계좌입니다. 계좌번호는 암호화되어 저장되며 화면에는 마스킹되어 표시됩니다.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle} htmlFor="cpa-bank">은행명</label>
              <input id="cpa-bank" style={inputStyle} value={form.bankName}
                onChange={e => setForm(f => ({ ...f, bankName: e.target.value }))}
                placeholder="예: 국민은행" data-testid="company-payment-bank" aria-label="은행명" />
            </div>
            <div>
              <label style={labelStyle} htmlFor="cpa-holder">예금주</label>
              <input id="cpa-holder" style={inputStyle} value={form.accountHolder}
                onChange={e => setForm(f => ({ ...f, accountHolder: e.target.value }))}
                placeholder="예: (주)코리아미디어" data-testid="company-payment-holder" aria-label="예금주" />
            </div>
          </div>
          <div>
            <label style={labelStyle} htmlFor="cpa-acct">계좌번호</label>
            <input id="cpa-acct" style={{ ...inputStyle, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} value={form.bankAccount}
              onChange={e => setForm(f => ({ ...f, bankAccount: e.target.value }))}
              placeholder={acct?.bankAccountMasked ? `현재: ${acct.bankAccountMasked} (변경 시에만 입력)` : "숫자만 입력 (예: 12345678901234)"}
              data-testid="company-payment-account" aria-label="계좌번호" inputMode="numeric" />
            <p style={{ fontSize: 11, color: "#9ca3af", margin: "4px 0 0" }}>※ 비워두면 기존 계좌번호가 유지됩니다.</p>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <GhostBtn onClick={() => setEditing(false)} disabled={saving} style={{ fontSize: 12, padding: "6px 12px" }}>취소</GhostBtn>
            <PrimaryBtn onClick={save} disabled={saving} style={{ fontSize: 12, padding: "6px 14px" }}
              data-testid="company-payment-save" aria-label="지급/환급 계좌정보 저장">
              {saving ? "저장 중…" : "저장"}
            </PrimaryBtn>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            { label: "은행명", value: val(acct?.bankName) },
            { label: "계좌번호", value: acct?.bankAccountMasked || "미등록", mono: true },
            { label: "예금주", value: val(acct?.accountHolder) },
          ].map(({ label, value, mono }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px", minWidth: 160 }}>
              <Landmark size={16} color="#6b7280" />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 11, color: "#6b7280" }}>{label}</span>
                <span style={{ fontSize: 14, color: value === "미등록" ? "#9ca3af" : "#111827", fontWeight: 600, fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined }}>{value}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CompanyPaymentAccountSection;
