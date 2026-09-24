import React, { useState, useEffect, useCallback } from "react";
import { Factory } from "lucide-react";
import { api } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { OUTSOURCING_FIELD_LABELS, OUTSOURCING_FIELD_OPTIONS } from "./VendorManagementTab";

// ─────────────────────────────────────────────────────────────────────────────
// 거래처 상세 내 "외주업체 정보" 섹션 — is_vendor=true 회사에서만 노출(§4·§6).
//  · companies 는 identity SSOT. 이 섹션은 외주 역할의 부가정보(company_vendor_profiles)만 조회/수정한다.
//  · 지급/계좌정보는 상단 CompanyPaymentAccountSection(company_sensitive)에서 다룬다 — 여기서 중복하지 않는다.
//  · 저장은 기존 PUT /admin/companies/:id/vendor-profile(upsert) 재사용. 회사 공통정보는 건드리지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
type VendorProfile = {
  id: number;
  companyId: number;
  outsourcingField: string | null;
  mainWork: string | null;
  issuesTaxInvoice: boolean;
  memo: string | null;
  status: string;
};

const sH: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: "#111827",
  borderLeft: "3px solid #7c3aed", paddingLeft: 10, margin: 0, lineHeight: 1.5,
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: "#374151", display: "block", marginBottom: 4, fontWeight: 600 };

export function CompanyVendorProfileSection({ companyId, token, onToast, onChanged }: {
  companyId: number; token: string; onToast: (msg: string) => void; onChanged?: () => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [profile, setProfile] = useState<VendorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ outsourcingField: "", mainWork: "", memo: "", issuesTaxInvoice: false, status: "active" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/vendor-profile`), { headers: authH });
      const data = await res.json().catch(() => null);
      if (res.ok) setProfile(data?.vendorProfile ?? null);
    } catch { /* 조회 실패는 조용히 미등록 취급 */ }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, token]);

  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    setForm({
      outsourcingField: profile?.outsourcingField ?? "",
      mainWork: profile?.mainWork ?? "",
      memo: profile?.memo ?? "",
      issuesTaxInvoice: !!profile?.issuesTaxInvoice,
      status: profile?.status === "inactive" ? "inactive" : "active",
    });
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/vendor-profile`), {
        method: "PUT", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          outsourcingField: form.outsourcingField || null,
          mainWork: form.mainWork.trim() || null,
          memo: form.memo.trim() || null,
          issuesTaxInvoice: form.issuesTaxInvoice,
          status: form.status,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${data.error ?? "외주 정보 저장 실패"}`); return; }
      setProfile(data?.vendorProfile ?? null);
      setEditing(false);
      onToast("외주업체 정보가 저장되었습니다.");
      onChanged?.();
    } catch { onToast("오류: 외주 정보 저장 실패"); }
    finally { setSaving(false); }
  };

  const fieldLabel = (f: string | null) => (f ? (OUTSOURCING_FIELD_LABELS[f] ?? f) : "미지정");

  return (
    <div data-testid="company-vendor-profile-section" style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "20px 0 10px" }}>
        <p style={sH}>외주업체 정보</p>
        {!editing && !loading && (
          <GhostBtn onClick={startEdit} style={{ fontSize: 12, padding: "4px 12px" }}
            data-testid="btn-company-vendor-profile-edit" aria-label="외주업체 정보 수정">
            {profile ? "외주정보 수정" : "외주역할 부여"}
          </GhostBtn>
        )}
      </div>

      {loading ? (
        <p style={{ color: "#9ca3af", fontSize: 13, padding: "4px 0" }}>불러오는 중…</p>
      ) : editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 10, padding: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle}>외주분야</label>
              <ClickSelect
                value={form.outsourcingField}
                onChange={v => setForm(f => ({ ...f, outsourcingField: v }))}
                triggerStyle={{ fontSize: 14, padding: "9px 12px", borderRadius: 8, minWidth: 160 }}
                options={[{ value: "", label: "선택 안 함" }, ...OUTSOURCING_FIELD_OPTIONS]}
              />
            </div>
            <div>
              <label style={labelStyle}>상태</label>
              <ClickSelect
                value={form.status}
                onChange={v => setForm(f => ({ ...f, status: v }))}
                triggerStyle={{ fontSize: 14, padding: "9px 12px", borderRadius: 8, minWidth: 120 }}
                options={[{ value: "active", label: "활성" }, { value: "inactive", label: "비활성" }]}
              />
            </div>
          </div>
          <div>
            <label style={labelStyle} htmlFor="cvp-mainwork">주요업무</label>
            <input id="cvp-mainwork" style={inputStyle} value={form.mainWork}
              onChange={e => setForm(f => ({ ...f, mainWork: e.target.value }))}
              placeholder="예: 영상 자막 번역, 동시통역 장비 대여" data-testid="company-vendor-mainwork" />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "#374151", cursor: "pointer" }}>
            <input type="checkbox" checked={form.issuesTaxInvoice}
              onChange={e => setForm(f => ({ ...f, issuesTaxInvoice: e.target.checked }))}
              data-testid="company-vendor-taxinvoice" />
            세금계산서 발행 업체
          </label>
          <div>
            <label style={labelStyle} htmlFor="cvp-memo">메모</label>
            <textarea id="cvp-memo" rows={2} style={{ ...inputStyle, resize: "vertical" }} value={form.memo}
              onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}
              placeholder="외주업체 관련 특이사항" data-testid="company-vendor-memo" />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <GhostBtn onClick={() => setEditing(false)} disabled={saving} style={{ fontSize: 12, padding: "6px 12px" }}>취소</GhostBtn>
            <PrimaryBtn onClick={save} disabled={saving} style={{ fontSize: 12, padding: "6px 14px" }}
              data-testid="company-vendor-save" aria-label="외주업체 정보 저장">
              {saving ? "저장 중…" : "저장"}
            </PrimaryBtn>
          </div>
        </div>
      ) : !profile ? (
        <p style={{ color: "#9ca3af", fontSize: 13, padding: "4px 0" }}>외주 역할 정보가 없습니다. [외주역할 부여]로 등록하세요.</p>
      ) : (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            { label: "외주분야", value: fieldLabel(profile.outsourcingField) },
            { label: "세금계산서", value: profile.issuesTaxInvoice ? "발행" : "미발행" },
            { label: "상태", value: profile.status === "inactive" ? "비활성" : "활성" },
            { label: "주요업무", value: profile.mainWork || "미입력" },
          ].map(({ label, value }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 8, padding: "8px 12px", minWidth: 150 }}>
              <Factory size={16} color="#7c3aed" />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 11, color: "#6b7280" }}>{label}</span>
                <span style={{ fontSize: 14, color: "#111827", fontWeight: 600 }}>{value}</span>
              </div>
            </div>
          ))}
          {profile.memo && (
            <div style={{ width: "100%", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 8, padding: "8px 12px" }}>
              <span style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 2 }}>메모</span>
              <span style={{ fontSize: 13, color: "#374151", whiteSpace: "pre-wrap" }}>{profile.memo}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default CompanyVendorProfileSection;
