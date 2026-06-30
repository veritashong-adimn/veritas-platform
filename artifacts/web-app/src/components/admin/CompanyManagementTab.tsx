import React, { useState, useCallback, useEffect } from 'react';
import {
  api, Company,
  VENDOR_TYPE_LABELS, VENDOR_TYPE_OPTIONS, VENDOR_TYPE_CATEGORY_CHIPS,
  resolveVendorType, finalVendorType,
  CUSTOMER_TYPE_OPTIONS, CUSTOMER_TYPE_LABELS, getCustomerTypeBadgeColors,
} from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';
import { CompanyDetailModal } from './CompanyDetailModal';
import { CompanyDocumentAnalyzePanel, type CompanyOcrDocType } from './CompanyDocumentAnalyzePanel';
import { formatPhone } from '../../lib/utils';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};

const tableTh: React.CSSProperties = {
  padding: "10px 12px", textAlign: "left", fontSize: 12,
  fontWeight: 600, color: "#6b7280", background: "#f9fafb",
  borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap",
};

const tableTd: React.CSSProperties = {
  padding: "9px 12px", fontSize: 13, color: "#374151",
  borderBottom: "1px solid #edf0f3", verticalAlign: "middle",
};

// ─── Design System: Information Hierarchy Badge Styles ───────────────────────
// Secondary: 상위 분류 (고객사 / 외주업체)
const BADGE_SECONDARY_CLIENT: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 5,
  background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe",
};
const BADGE_SECONDARY_VENDOR: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 5,
  background: "#f5f3ff", color: "#6d28d9", border: "1px solid #ddd6fe",
};
// Tertiary: 외주 세부 분류 (통번역업체 등) — purple 계열
const BADGE_TERTIARY_VENDOR: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 4,
  background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe",
};
// 고객 분류 Badge: customerType에 따라 색상 동적 적용
function getCustomerSubBadgeStyle(ct: string): React.CSSProperties {
  const { bg, color, border } = getCustomerTypeBadgeColors(ct);
  return { fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: bg, color, border: `1px solid ${border}` };
}
// ─────────────────────────────────────────────────────────────────────────────

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

interface CompanyManagementTabProps {
  token: string;
  onToast: (msg: string) => void;
  onOpenProject: (id: number) => void;
  onOpenTranslator?: (userId: number, email: string) => void;
  hasPerm: (key: string | undefined) => boolean;
}

export function CompanyManagementTab({ token, onToast, onOpenProject, onOpenTranslator, hasPerm }: CompanyManagementTabProps) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [companyModal, setCompanyModal] = useState<number | null>(null);
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [companyForm, setCompanyForm] = useState({
    name: "", businessNumber: "", representativeName: "",
    industry: "", businessCategory: "", address: "",
    email: "", mobile: "",
    notes: "", registeredAt: new Date().toISOString().slice(0, 10),
    companyType: "client", vendorType: "", customerType: "CORPORATE",
  });
  const [vendorTypeCustom, setVendorTypeCustom] = useState("");
  const [savingCompany, setSavingCompany] = useState(false);
  const [createdCompanyId, setCreatedCompanyId] = useState<number | null>(null);
  const [createdCompanyName, setCreatedCompanyName] = useState("");
  const [newCompanyDivForm, setNewCompanyDivForm] = useState({ name: "", type: "" });
  const [newCompanyDivisions, setNewCompanyDivisions] = useState<{ id: number; name: string; type: string | null }[]>([]);
  const [savingNewCompanyDiv, setSavingNewCompanyDiv] = useState(false);
  const emptyNewCompanyContactForm = {
    name: "", position: "", mobile: "", phone: "", email: "", memo: "",
    isPrimary: false, isQuoteContact: false, isBillingContact: false, divisionId: null as number | null,
  };
  const [newCompanyContactForm, setNewCompanyContactForm] = useState(emptyNewCompanyContactForm);
  const [newCompanyContacts, setNewCompanyContacts] = useState<{ id: number; name: string; divisionId: number | null; divisionName?: string }[]>([]);
  const [savingNewCompanyContact, setSavingNewCompanyContact] = useState(false);
  const [companyTypeFilter, setCompanyTypeFilter] = useState<"all" | "client" | "vendor">("all");
  const [companyVendorTypeFilter, setCompanyVendorTypeFilter] = useState<string>("all");
  const [companyCustomerTypeFilter, setCompanyCustomerTypeFilter] = useState<string>("all");

  // AI 문서 자동입력
  const [licenseFile, setLicenseFile] = useState<File | null>(null);
  const [bankbookFile, setBankbookFile] = useState<File | null>(null);
  const [ocrPanel, setOcrPanel] = useState<CompanyOcrDocType | null>(null);
  const [dragOverType, setDragOverType] = useState<CompanyOcrDocType | null>(null);

  // 담당자 중복 경고 모달 (신규 거래처 등록 중 담당자 추가 시)
  type ContactWarning = {
    message: string; warnings: string[]; type?: string;
    duplicates?: Array<{ id: number; name: string; companyName?: string; mobile?: string; email?: string }>;
    duplicateContact?: { id: number; name: string } | null;
  };
  const [newContactWarningModal, setNewContactWarningModal] = useState<ContactWarning | null>(null);

  // 개인고객 등록 시 기존 인물 후보 안내 모달
  type PersonCandidate = { source: string; id: number; name: string; companyId?: number; companyName?: string; email?: string; mobile?: string; roleLabel: string; matchReason?: string };
  const [personCandidateModal, setPersonCandidateModal] = useState<{ show: boolean; candidates: PersonCandidate[] } | null>(null);
  const [pendingCompanyCreate, setPendingCompanyCreate] = useState(false);

  const fetchCompanies = useCallback(async () => {
    setCompaniesLoading(true);
    try {
      const params = new URLSearchParams();
      if (companySearch.trim()) params.set("search", companySearch.trim());
      const res = await fetch(api(`/api/admin/companies${params.toString() ? "?" + params.toString() : ""}`), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setCompanies(Array.isArray(data) ? data : []);
    } catch { onToast("오류: 거래처 조회 실패"); }
    finally { setCompaniesLoading(false); }
  }, [token, companySearch]);

  useEffect(() => { fetchCompanies(); }, []);

  const doCreateCompany = async () => {
    setSavingCompany(true);
    try {
      const body = { ...companyForm, vendorType: finalVendorType(companyForm.vendorType, vendorTypeCustom) };
      const res = await fetch(api("/api/admin/companies"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setCreatedCompanyId(data.id);
      setCreatedCompanyName(data.name);
      setNewCompanyDivisions([]);
      setNewCompanyContacts([]);
      setNewCompanyDivForm({ name: "", type: "" });
      setNewCompanyContactForm(emptyNewCompanyContactForm);
      onToast("거래처가 등록되었습니다. 브랜드/담당자를 추가하거나 완료하세요.");
      await fetchCompanies();
    } catch { onToast("오류: 거래처 등록 실패"); }
    finally { setSavingCompany(false); }
  };

  const handleCreateCompany = async () => {
    if (!companyForm.name.trim()) {
      onToast(companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL" ? "성명을 입력하세요." : "회사명을 입력하세요.");
      return;
    }
    // 개인고객 등록 시: 기존 인물 후보 검색 (차단 아님, 안내만)
    if (companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL") {
      const mobile = companyForm.mobile?.trim().replace(/\D/g, "") || "";
      const email  = companyForm.email?.trim().toLowerCase() || "";
      if (mobile || email) {
        try {
          const params = new URLSearchParams();
          const personName = companyForm.name.trim();
          if (personName) params.set("name", personName);
          if (mobile) params.set("mobile", mobile);
          if (email)  params.set("email", email);
          const r = await fetch(api(`/api/admin/people/duplicate-candidates?${params}`), { headers: authHeaders });
          const d = await r.json();
          if (r.ok && Array.isArray(d.candidates) && d.candidates.length > 0) {
            setPersonCandidateModal({ show: true, candidates: d.candidates });
            setPendingCompanyCreate(true);
            return;
          }
        } catch { /* 후보 검색 실패는 무시하고 등록 진행 */ }
      }
    }
    await doCreateCompany();
  };

  const handleAddNewCompanyDivision = async () => {
    if (!newCompanyDivForm.name.trim() || !createdCompanyId) return;
    setSavingNewCompanyDiv(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${createdCompanyId}/divisions`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCompanyDivForm.name.trim(), type: newCompanyDivForm.type || null }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setNewCompanyDivisions(prev => [...prev, data]);
      setNewCompanyDivForm({ name: "", type: "" });
    } catch { onToast("오류: 브랜드/부서 추가 실패"); }
    finally { setSavingNewCompanyDiv(false); }
  };

  const handleAddNewCompanyContact = async (force = false) => {
    if (!newCompanyContactForm.name.trim() || !createdCompanyId) return;
    setSavingNewCompanyContact(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${createdCompanyId}/contacts`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...newCompanyContactForm, companyId: createdCompanyId, force }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      if (data.warning === true) {
        setNewContactWarningModal({
          message: data.message, warnings: data.warnings ?? [],
          type: data.type, duplicates: data.duplicates,
          duplicateContact: data.duplicateContact ?? null,
        });
        return;
      }
      const divName = newCompanyContactForm.divisionId
        ? newCompanyDivisions.find(d => d.id === newCompanyContactForm.divisionId)?.name
        : undefined;
      setNewCompanyContacts(prev => [...prev, { id: data.id, name: data.name, divisionId: data.divisionId, divisionName: divName }]);
      setNewCompanyContactForm(emptyNewCompanyContactForm);
      onToast("담당자가 추가되었습니다.");
    } catch { onToast("오류: 담당자 추가 실패"); }
    finally { setSavingNewCompanyContact(false); }
  };

  const handleDoneCompanyCreate = () => {
    setCreatedCompanyId(null);
    setCreatedCompanyName("");
    setNewCompanyDivisions([]);
    setNewCompanyContacts([]);
    setNewCompanyDivForm({ name: "", type: "" });
    setNewCompanyContactForm(emptyNewCompanyContactForm);
    setCompanyForm({
      name: "", businessNumber: "", representativeName: "",
      industry: "", businessCategory: "", address: "",
      email: "", mobile: "",
      notes: "", registeredAt: new Date().toISOString().slice(0, 10),
      companyType: "client", vendorType: "", customerType: "CORPORATE",
    });
    setVendorTypeCustom("");
    setLicenseFile(null);
    setBankbookFile(null);
    setShowCompanyForm(false);
  };

  const handleLicenseOcrApply = (_fields: string[], values: Record<string, string>) => {
    setCompanyForm(prev => {
      const next = { ...prev };
      if (values.name) next.name = values.name;
      if (values.businessNumber) next.businessNumber = values.businessNumber;
      if (values.representativeName) next.representativeName = values.representativeName;
      if (values.registeredAt) next.registeredAt = values.registeredAt;
      if (values.industry) next.industry = values.industry;
      if (values.businessCategory) next.businessCategory = values.businessCategory;
      if (values.address) next.address = values.address;
      if (values.vendorType && prev.companyType === "vendor") {
        const resolved = resolveVendorType(values.vendorType);
        next.vendorType = resolved.vendorType;
        setVendorTypeCustom(resolved.vendorTypeCustom);
      }
      return next;
    });
    onToast("사업자등록증 정보가 폼에 자동 반영되었습니다.");
  };

  const handleBankbookOcrApply = (_fields: string[], values: Record<string, string>) => {
    const parts = [
      values.bankName && `은행: ${values.bankName}`,
      values.accountHolder && `예금주: ${values.accountHolder}`,
      values.bankAccount && `계좌번호: ${values.bankAccount}`,
    ].filter(Boolean).join(" / ");
    if (parts) {
      setCompanyForm(prev => ({
        ...prev,
        notes: prev.notes ? `${prev.notes}\n${parts}` : parts,
      }));
      onToast("통장사본 정보가 메모에 추가되었습니다.");
    }
  };

  return (
    <>
      {/* ── 담당자 중복 경고 확인 모달 (신규 거래처 등록 중) ── */}
      {newContactWarningModal && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 28px 22px", width: 420, maxWidth: "92vw", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 12 }}>⚠️ 중복 연락처 안내</div>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7, marginBottom: 14 }}>
              {(newContactWarningModal.warnings ?? []).length > 0
                ? newContactWarningModal.warnings.map((w, i) => <div key={i} style={{ marginBottom: 4 }}>• {w}</div>)
                : <div>{newContactWarningModal.message}</div>}
            </div>
            {newContactWarningModal.type === "cross_company_duplicate" && newContactWarningModal.duplicates && (
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#374151" }}>
                {newContactWarningModal.duplicates.map((d, i) => (
                  <div key={i} style={{ marginBottom: i < newContactWarningModal.duplicates!.length - 1 ? 8 : 0 }}>
                    <span style={{ fontWeight: 700 }}>{d.name}</span>
                    {d.companyName && <span style={{ color: "#6b7280" }}> · {d.companyName}</span>}
                    {d.mobile && <span style={{ color: "#6b7280" }}> · {d.mobile}</span>}
                    {d.email && <span style={{ color: "#6b7280" }}> · {d.email}</span>}
                  </div>
                ))}
              </div>
            )}
            {newContactWarningModal.duplicateContact && !newContactWarningModal.type && (
              <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#374151" }}>
                <span style={{ fontWeight: 700 }}>{newContactWarningModal.duplicateContact.name}</span>
              </div>
            )}
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 18 }}>계속 등록하시겠습니까?</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <GhostBtn onClick={() => setNewContactWarningModal(null)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
              <button onClick={async () => { setNewContactWarningModal(null); await handleAddNewCompanyContact(true); }}
                style={{ padding: "7px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", background: "#1d4ed8", color: "#fff", border: "none" }}>
                계속 등록
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 개인고객 기존 인물 후보 안내 모달 ── */}
      {personCandidateModal?.show && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 28px 22px", width: 520, maxWidth: "94vw", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", maxHeight: "82vh", overflowY: "auto" }}>
            {/* 헤더 */}
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>기존 인물 후보 {personCandidateModal.candidates.length}명 발견</div>
            </div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 18, paddingBottom: 14, borderBottom: "1px solid #f3f4f6" }}>
              등록은 가능하지만 기존 등록 여부를 확인하세요.
            </div>

            {/* 카드 목록 */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 22 }}>
              {personCandidateModal.candidates.map((c, i) => {
                const roleBg    = c.source === "contact" ? "#eff6ff" : c.source === "translator" ? "#f5f3ff" : "#fff7ed";
                const roleColor = c.source === "contact" ? "#1d4ed8" : c.source === "translator" ? "#6d28d9" : "#c2410c";
                const roleBdr   = c.source === "contact" ? "#bfdbfe" : c.source === "translator" ? "#ddd6fe" : "#fed7aa";
                const affiliation = c.source === "translator" ? "통번역사" : (c.companyName ?? "—");
                const matchLabel = c.matchReason === "name_mobile" ? "이름 + 휴대폰 일치"
                  : c.matchReason === "name_email" ? "이름 + 이메일 일치"
                  : c.matchReason === "mobile" ? "휴대폰 일치"
                  : c.matchReason === "email" ? "이메일 일치" : null;

                const handleView = () => {
                  setPersonCandidateModal(null);
                  setPendingCompanyCreate(false);
                  if (c.source === "contact" && c.companyId != null) {
                    setCompanyModal(c.companyId);
                  } else if (c.source === "individual_customer") {
                    setCompanyModal(c.id);
                  } else if (c.source === "translator" && onOpenTranslator) {
                    onOpenTranslator(c.id, c.email ?? "");
                  }
                };

                const canView = c.source === "contact" ? c.companyId != null
                  : c.source === "individual_customer" ? true
                  : c.source === "translator" ? !!onOpenTranslator
                  : false;

                return (
                  <div key={i} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    {/* 정보 영역 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* 역할 배지 + 매칭 이유 */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: roleBg, color: roleColor, border: `1px solid ${roleBdr}`, whiteSpace: "nowrap" }}>{c.roleLabel}</span>
                        {matchLabel && (
                          <span style={{ fontSize: 10, color: "#6b7280", background: "#f3f4f6", border: "1px solid #e5e7eb", padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>{matchLabel}</span>
                        )}
                      </div>
                      {/* 이름 */}
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 8 }}>{c.name}</div>
                      {/* 상세 정보 그리드 */}
                      <div style={{ display: "grid", gridTemplateColumns: "3.2em 1fr", rowGap: 4, fontSize: 12 }}>
                        <span style={{ color: "#9ca3af", fontWeight: 500 }}>소속</span>
                        <span style={{ color: "#374151" }}>{affiliation}</span>
                        <span style={{ color: "#9ca3af", fontWeight: 500 }}>휴대폰</span>
                        <span style={{ color: "#374151" }}>{c.mobile || "—"}</span>
                        <span style={{ color: "#9ca3af", fontWeight: 500 }}>이메일</span>
                        <span style={{ color: "#374151", wordBreak: "break-all" }}>{c.email || "—"}</span>
                      </div>
                    </div>
                    {/* 상세보기 버튼 */}
                    {canView && (
                      <button
                        onClick={handleView}
                        style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "#fff", color: "#374151", border: "1px solid #d1d5db", whiteSpace: "nowrap", alignSelf: "flex-start" }}>
                        상세보기
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 하단 버튼 */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <GhostBtn onClick={() => { setPersonCandidateModal(null); setPendingCompanyCreate(false); }} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
              <button onClick={async () => { setPersonCandidateModal(null); setPendingCompanyCreate(false); await doCreateCompany(); }}
                style={{ padding: "7px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", background: "#1d4ed8", color: "#fff", border: "none" }}>
                계속 등록
              </button>
            </div>
          </div>
        </div>
      )}

      {companyModal !== null && (
        <CompanyDetailModal
          companyId={companyModal}
          token={token}
          onClose={() => setCompanyModal(null)}
          onToast={onToast}
          onOpenProject={(id) => { setCompanyModal(null); onOpenProject(id); }}
          onRefresh={fetchCompanies}
          onDeleted={() => { setCompanyModal(null); fetchCompanies(); }}
        />
      )}
      {ocrPanel === "business_license" && licenseFile && (
        <CompanyDocumentAnalyzePanel
          file={licenseFile}
          docType="business_license"
          token={token}
          onToast={onToast}
          onClose={() => setOcrPanel(null)}
          onApplied={(fields, values) => { handleLicenseOcrApply(fields, values); setOcrPanel(null); }}
        />
      )}
      {ocrPanel === "bankbook" && bankbookFile && (
        <CompanyDocumentAnalyzePanel
          file={bankbookFile}
          docType="bankbook"
          token={token}
          onToast={onToast}
          onClose={() => setOcrPanel(null)}
          onApplied={(fields, values) => { handleBankbookOcrApply(fields, values); setOcrPanel(null); }}
        />
      )}
      <Section title={`거래처 관리 (${companies.length})`} action={
        hasPerm("company.create") ? (
          <PrimaryBtn onClick={() => { setShowCompanyForm(v => !v); setCreatedCompanyId(null); setCreatedCompanyName(""); }} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showCompanyForm ? "취소" : "+ 거래처 등록"}
          </PrimaryBtn>
        ) : undefined
      }>
        {showCompanyForm && (
          <Card style={{ marginBottom: 16, padding: "20px 20px", background: "#f8fafc" }}>
            {createdCompanyId !== null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* 완료 배너 */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: "10px 14px" }}>
                  <span style={{ fontSize: 18 }}>✓</span>
                  <div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#166534" }}>{createdCompanyName} 등록 완료</p>
                    <p style={{ margin: 0, fontSize: 12, color: "#15803d" }}>
                      {companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL"
                        ? "담당자를 추가하거나 완료하세요."
                        : "브랜드/부서와 담당자를 추가하거나 완료하세요."}
                    </p>
                  </div>
                  <button onClick={handleDoneCompanyCreate} style={{ marginLeft: "auto", padding: "6px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "#166534", color: "#fff", border: "none", cursor: "pointer" }}>완료</button>
                </div>

                {/* 단계 2: 브랜드/부서 (기업고객 / 외주업체만) */}
                {!(companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL") && (
                <div style={{ border: "1px solid #e9d5ff", borderRadius: 10, padding: "12px 14px", background: "#faf5ff" }}>
                  <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.06em" }}>브랜드 / 부서 추가</p>
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <input value={newCompanyDivForm.name} onChange={e => setNewCompanyDivForm(p => ({ ...p, name: e.target.value }))}
                      placeholder="예: 반클리프아펠, 개발팀, 마케팅부" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", flex: 2 }} />
                    <input value={newCompanyDivForm.type} onChange={e => setNewCompanyDivForm(p => ({ ...p, type: e.target.value }))}
                      placeholder="유형 (선택)" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", flex: 1 }} />
                    <button onClick={handleAddNewCompanyDivision} disabled={savingNewCompanyDiv || !newCompanyDivForm.name.trim()}
                      style={{ padding: "7px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "#7c3aed", color: "#fff", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}>
                      {savingNewCompanyDiv ? "추가 중..." : "+ 추가"}
                    </button>
                  </div>
                  {newCompanyDivisions.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {newCompanyDivisions.map(d => (
                        <span key={d.id} style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: "#ede9fe", color: "#6d28d9", border: "1px solid #ddd6fe" }}>
                          {d.name}{d.type ? ` (${d.type})` : ""}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12, color: "#a78bfa" }}>아직 추가된 브랜드/부서가 없습니다.</p>
                  )}
                </div>
                )}

                {/* 단계 3: 담당자 */}
                <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px", background: "#f9fafb" }}>
                  <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>담당자 추가</p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px", marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 3 }}>담당자명 *</label>
                      <input value={newCompanyContactForm.name} onChange={e => setNewCompanyContactForm(p => ({ ...p, name: e.target.value }))}
                        placeholder="홍길동" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 3 }}>직책</label>
                      <input value={newCompanyContactForm.position} onChange={e => setNewCompanyContactForm(p => ({ ...p, position: e.target.value }))}
                        placeholder="과장" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 3 }}>휴대폰</label>
                      <input value={newCompanyContactForm.mobile} onChange={e => setNewCompanyContactForm(p => ({ ...p, mobile: formatPhone(e.target.value) }))}
                        placeholder="010-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 3 }}>이메일</label>
                      <input type="email" value={newCompanyContactForm.email} onChange={e => setNewCompanyContactForm(p => ({ ...p, email: e.target.value }))}
                        placeholder="name@company.com" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                    </div>
                    {newCompanyDivisions.length > 0 && (
                      <div style={{ gridColumn: "1 / -1" }}>
                        <label style={{ fontSize: 11, color: "#7c3aed", display: "block", marginBottom: 3, fontWeight: 700 }}>소속 브랜드/부서</label>
                        <ClickSelect
                          value={String(newCompanyContactForm.divisionId ?? "")}
                          onChange={v => setNewCompanyContactForm(p => ({ ...p, divisionId: v ? Number(v) : null }))}
                          style={{ width: "100%" }}
                          triggerStyle={{ width: "100%", fontSize: 13, padding: "6px 10px", borderRadius: 8, border: "1px solid #e9d5ff", background: "#faf5ff", color: "#7c3aed" }}
                          options={[
                            { value: "", label: "— 본사 직속 (브랜드 미지정) —" },
                            ...newCompanyDivisions.map(d => ({ value: String(d.id), label: d.name + (d.type ? ` (${d.type})` : "") })),
                          ]}
                        />
                      </div>
                    )}
                    <div style={{ gridColumn: "1 / -1" }}>
                      <label style={{ fontSize: 11, color: "#6b7280", display: "block", marginBottom: 3 }}>메모</label>
                      <input value={newCompanyContactForm.memo} onChange={e => setNewCompanyContactForm(p => ({ ...p, memo: e.target.value }))}
                        placeholder="메모" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                    </div>
                    <div style={{ gridColumn: "1 / -1", display: "flex", gap: 14, alignItems: "center" }}>
                      {[{ key: "isPrimary", label: "기본 담당자" }, { key: "isQuoteContact", label: "견적 담당" }, { key: "isBillingContact", label: "청구 담당" }].map(({ key, label }) => (
                        <label key={key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, cursor: "pointer" }}>
                          <input type="checkbox" checked={(newCompanyContactForm as any)[key]} onChange={e => setNewCompanyContactForm(p => ({ ...p, [key]: e.target.checked }))} />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => handleAddNewCompanyContact()} disabled={savingNewCompanyContact || !newCompanyContactForm.name.trim()}
                    style={{ padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "#374151", color: "#fff", border: "none", cursor: "pointer" }}>
                    {savingNewCompanyContact ? "추가 중..." : "+ 담당자 추가"}
                  </button>
                  {newCompanyContacts.length > 0 && (
                    <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {newCompanyContacts.map(c => (
                        <span key={c.id} style={{ fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb" }}>
                          {c.name}{c.divisionName ? ` / ${c.divisionName}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={handleDoneCompanyCreate} style={{ padding: "9px 24px", borderRadius: 10, fontSize: 14, fontWeight: 700, background: "#111827", color: "#fff", border: "none", cursor: "pointer" }}>등록 완료</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                {/* ── Card 1: AI 문서 자동입력 (기업고객 / 외주업체만) ── */}
                {!(companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL") && (() => {
                  const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".pdf"];
                  const handleDocDrop = (dt: CompanyOcrDocType, rawFile: File) => {
                    const ext = rawFile.name.slice(rawFile.name.lastIndexOf(".")).toLowerCase();
                    if (!ALLOWED_EXTS.includes(ext)) {
                      onToast("JPG, PNG, PDF 형식만 업로드할 수 있습니다.");
                      return;
                    }
                    if (dt === "business_license") setLicenseFile(rawFile);
                    else setBankbookFile(rawFile);
                  };
                  return (
                    <div style={{ background: "#fff", border: "1px solid #bae6fd", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(14,165,233,0.08)" }}>
                      <div style={{ background: "#f0f9ff", padding: "12px 18px", borderBottom: "1px solid #bae6fd", display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 20 }}>✨</span>
                        <div>
                          <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#0369a1" }}>AI 문서 자동입력</p>
                          <p style={{ margin: "2px 0 0", fontSize: 12, color: "#0284c7" }}>사업자등록증·통장사본 업로드 시 기본정보 자동 추출</p>
                        </div>
                      </div>
                      <div style={{ padding: "14px 18px" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          {(["business_license", "bankbook"] as const).map(dt => {
                            const isLicense = dt === "business_license";
                            const file = isLicense ? licenseFile : bankbookFile;
                            const setFile = isLicense ? setLicenseFile : setBankbookFile;
                            const icon = isLicense ? "📄" : "🏦";
                            const label = isLicense ? "사업자등록증" : "통장사본";
                            const desc = isLicense
                              ? "거래처명 · 사업자번호 · 대표자 · 업태 · 주소 자동 추출"
                              : "은행명 · 예금주 · 계좌번호 추출 → 메모 반영";
                            const isDragging = dragOverType === dt;
                            return (
                              <div
                                key={dt}
                                onDragOver={e => { e.preventDefault(); setDragOverType(dt); }}
                                onDragEnter={e => { e.preventDefault(); setDragOverType(dt); }}
                                onDragLeave={e => {
                                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverType(null);
                                }}
                                onDrop={e => {
                                  e.preventDefault();
                                  setDragOverType(null);
                                  const dropped = e.dataTransfer.files?.[0];
                                  if (dropped) handleDocDrop(dt, dropped);
                                }}
                                style={{
                                  background: isDragging ? "#e0f2fe" : "#f8fafc",
                                  borderRadius: 10,
                                  border: isDragging ? "2px dashed #0284c7" : "1.5px solid #e0f2fe",
                                  padding: "12px 14px",
                                  transition: "border-color 0.15s, background 0.15s",
                                }}
                              >
                                <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: isDragging ? "#0284c7" : "#0369a1" }}>{icon} {label}</p>
                                <p style={{ margin: "0 0 10px", fontSize: 11, color: "#6b7280" }}>{desc}</p>
                                {!file && (
                                  <div style={{ marginBottom: 10, padding: "12px", borderRadius: 8, border: `1.5px dashed ${isDragging ? "#0284c7" : "#93c5fd"}`, background: isDragging ? "#bae6fd" : "#f0f9ff", textAlign: "center", transition: "all 0.15s" }}>
                                    <p style={{ margin: 0, fontSize: 11, color: isDragging ? "#0369a1" : "#7dd3fc", fontWeight: isDragging ? 700 : 400 }}>
                                      {isDragging ? "여기에 파일을 놓으세요" : "파일을 여기에 드래그하거나"}
                                    </p>
                                    {!isDragging && <p style={{ margin: "2px 0 0", fontSize: 10, color: "#93c5fd" }}>PDF · JPG · PNG (최대 10 MB)</p>}
                                  </div>
                                )}
                                {file && (
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, padding: "6px 10px", background: isDragging ? "#bae6fd" : "#f0fdf4", borderRadius: 8, border: `1px solid ${isDragging ? "#7dd3fc" : "#bbf7d0"}` }}>
                                    <span style={{ fontSize: 11, color: isDragging ? "#0369a1" : "#065f46", fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {isDragging ? "파일을 놓으면 교체됩니다" : file.name}
                                    </span>
                                    {!isDragging && (
                                      <button type="button" onClick={() => setFile(null)} aria-label={`${label} 제거`}
                                        style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid #fca5a5", background: "#fff", color: "#dc2626", cursor: "pointer", whiteSpace: "nowrap" }}>
                                        제거
                                      </button>
                                    )}
                                  </div>
                                )}
                                <div style={{ display: "flex", gap: 6 }}>
                                  <label style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151", whiteSpace: "nowrap" }}
                                    aria-label={`${label} ${file ? "교체" : "파일 선택"}`}>
                                    {file ? "교체" : "파일 선택"}
                                    <input type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
                                      style={{ display: "none" }} data-testid={`input-company-doc-${dt}`}
                                      onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleDocDrop(dt, f); }} />
                                  </label>
                                  <button type="button" disabled={!file} onClick={() => setOcrPanel(dt)} aria-label={`${label} AI 분석`}
                                    data-testid={`btn-company-ocr-${dt}`}
                                    style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, border: "1px solid #0284c7", background: file ? "#0284c7" : "#e5e7eb", color: file ? "#fff" : "#9ca3af", cursor: file ? "pointer" : "not-allowed", fontWeight: 600, whiteSpace: "nowrap" }}>
                                    ✨ AI 분석
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* ── Card 2: 거래처 기본정보 ── */}

                <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ padding: "12px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 3, height: 20, background: "#6366f1", borderRadius: 2, display: "inline-block", flexShrink: 0 }} />
                    <div>
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>거래처 기본정보</p>
                      <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>기본 정보를 입력하거나 AI 분석 결과를 확인 후 수정할 수 있습니다</p>
                    </div>
                  </div>
                  <div style={{ padding: "18px 18px", display: "flex", flexDirection: "column", gap: 18 }}>

                    {/* 거래처 유형 */}
                    <div>
                      <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 8 }}>
                        거래처 유형 <span style={{ color: "#dc2626" }}>*</span>
                      </label>
                      {/* 1차: 고객사 / 외주업체 */}
                      <div style={{ display: "flex", gap: 8 }}>
                        {[
                          { v: "client",  label: "고객사",   icon: "🏢", color: "#1d4ed8", bg: "#dbeafe", border: "#3b82f6", ring: "#3b82f620" },
                          { v: "vendor",  label: "외주업체", icon: "🔧", color: "#6d28d9", bg: "#ede9fe", border: "#7c3aed", ring: "#7c3aed20" },
                        ].map(opt => (
                          <button key={opt.v} type="button"
                            onClick={() => setCompanyForm(p => ({ ...p, companyType: opt.v, vendorType: "", customerType: "CORPORATE" }))}
                            style={{
                              padding: "6px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
                              transition: "all 0.15s", lineHeight: "22px",
                              background: companyForm.companyType === opt.v ? opt.bg : "#f9fafb",
                              color: companyForm.companyType === opt.v ? opt.color : "#9ca3af",
                              border: `2px solid ${companyForm.companyType === opt.v ? opt.border : "#e5e7eb"}`,
                              boxShadow: companyForm.companyType === opt.v ? `0 0 0 3px ${opt.ring}` : "none",
                            }}>
                            {opt.icon} {opt.label}
                          </button>
                        ))}
                      </div>
                      {/* 2차: 고객 분류 (고객사 선택 시) */}
                      {companyForm.companyType === "client" && (
                        <div style={{ marginTop: 8, paddingLeft: 16, borderLeft: "3px solid #93c5fd" }}>
                          <div style={{ padding: "10px 14px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10 }}>
                            <label style={{ fontSize: 12, fontWeight: 700, color: "#1d4ed8", display: "block", marginBottom: 8, letterSpacing: "-0.01em" }}>고객 분류</label>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {CUSTOMER_TYPE_OPTIONS.map(opt => {
                                const isActive = companyForm.customerType === opt.value;
                                const { bg, color, border } = getCustomerTypeBadgeColors(opt.value);
                                return (
                                  <button key={opt.value} type="button"
                                    onClick={() => setCompanyForm(p => ({ ...p, customerType: opt.value }))}
                                    style={{
                                      padding: "6px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700,
                                      cursor: "pointer", transition: "all 0.15s", lineHeight: "1.4",
                                      background: isActive ? bg : "#fff",
                                      color: isActive ? color : "#9ca3af",
                                      border: `2px solid ${isActive ? border : "#e5e7eb"}`,
                                    }}>
                                    {opt.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                      {/* 2차: 외주 분류 (외주업체 선택 시) */}
                      {companyForm.companyType === "vendor" && (
                        <div style={{ marginTop: 10, paddingLeft: 16, borderLeft: "2px solid #c4b5fd" }}>
                          <div style={{ padding: "12px 14px", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 10 }}>
                            <label style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed", display: "block", marginBottom: 8 }}>외주 분류</label>
                            <ClickSelect
                              value={companyForm.vendorType}
                              onChange={v => { setCompanyForm(p => ({ ...p, vendorType: v })); if (v !== "etc") setVendorTypeCustom(""); }}
                              triggerStyle={{ fontSize: 13, padding: "6px 10px", minWidth: 160, borderRadius: 8, borderColor: "#ddd6fe", width: "100%" }}
                              style={{ width: "100%" }}
                              chips={VENDOR_TYPE_CATEGORY_CHIPS}
                              options={[{ value: "", label: "선택 안 함" }, ...VENDOR_TYPE_OPTIONS]}
                            />
                            {companyForm.vendorType === "etc" && (
                              <input
                                value={vendorTypeCustom}
                                onChange={e => setVendorTypeCustom(e.target.value)}
                                placeholder="기타 외주유형 직접 입력"
                                aria-label="기타 외주유형 직접 입력"
                                style={{ ...inputStyle, marginTop: 8, borderColor: "#ddd6fe", color: "#7c3aed" }}
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 거래처명 / 성명 */}
                    <div>
                      <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>
                        {companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL" ? "성명" : "거래처명"} <span style={{ color: "#dc2626" }}>*</span>
                      </label>
                      <input value={companyForm.name} onChange={e => setCompanyForm(p => ({ ...p, name: e.target.value }))}
                        placeholder={companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL" ? "홍길동" : "(주)아크로네이처"} style={inputStyle} />
                      {companyForm.name.trim().length >= 2 && (() => {
                        const q = companyForm.name.trim().toLowerCase();
                        const dupes = companies.filter(c =>
                          c.name.toLowerCase().includes(q) ||
                          (c.divisionNames ?? []).some(d => d.toLowerCase().includes(q))
                        ).slice(0, 3);
                        if (dupes.length === 0) return null;
                        return (
                          <div style={{ marginTop: 6, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8 }}>
                            <p style={{ margin: "0 0 5px", fontSize: 11, fontWeight: 700, color: "#92400e" }}>⚠ 유사 거래처가 이미 등록되어 있습니다</p>
                            {dupes.map(c => {
                              const matchedDiv = (c.divisionNames ?? []).find(d => d.toLowerCase().includes(q));
                              return (
                                <div key={c.id} style={{ fontSize: 12, color: "#78350f", marginTop: 2 }}>
                                  <button type="button" onClick={() => setCompanyModal(c.id)}
                                    style={{ background: "none", border: "none", cursor: "pointer", color: "#b45309", fontWeight: 700, padding: 0, textDecoration: "underline", fontSize: 12 }}>
                                    {c.name}{matchedDiv ? `(${matchedDiv})` : ""}
                                  </button>
                                  <span style={{ color: "#92400e", marginLeft: 6 }}>→ 클릭하면 상세보기</span>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>

                    {/* 개인고객: 휴대폰 / 이메일 */}
                    {companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL" && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
                        <div>
                          <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>휴대폰</label>
                          <input value={companyForm.mobile} onChange={e => setCompanyForm(p => ({ ...p, mobile: e.target.value }))}
                            placeholder="010-0000-0000" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>이메일</label>
                          <input type="email" value={companyForm.email} onChange={e => setCompanyForm(p => ({ ...p, email: e.target.value }))}
                            placeholder="name@example.com" style={inputStyle} />
                        </div>
                      </div>
                    )}

                    {/* 기업고객 / 외주업체: 사업자등록번호 / 대표자명 / 등록일 */}
                    {!(companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL") && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 14px" }}>
                        <div>
                          <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>사업자등록번호</label>
                          <input value={companyForm.businessNumber} onChange={e => setCompanyForm(p => ({ ...p, businessNumber: e.target.value }))}
                            placeholder="000-00-00000" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>대표자명</label>
                          <input value={companyForm.representativeName} onChange={e => setCompanyForm(p => ({ ...p, representativeName: e.target.value }))}
                            placeholder="홍길동" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>등록일</label>
                          <input type="date" value={companyForm.registeredAt} onChange={e => setCompanyForm(p => ({ ...p, registeredAt: e.target.value }))}
                            style={inputStyle} />
                        </div>
                      </div>
                    )}

                    {/* 개인고객: 등록일 (단독 행) */}
                    {companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL" && (
                      <div>
                        <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>등록일</label>
                        <input type="date" value={companyForm.registeredAt} onChange={e => setCompanyForm(p => ({ ...p, registeredAt: e.target.value }))}
                          style={inputStyle} />
                      </div>
                    )}

                    {/* 기업고객 / 외주업체: 업태 / 종목 */}
                    {!(companyForm.companyType === "client" && companyForm.customerType === "INDIVIDUAL") && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
                        <div>
                          <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>업태</label>
                          <input value={companyForm.industry} onChange={e => setCompanyForm(p => ({ ...p, industry: e.target.value }))}
                            placeholder="제조업, 서비스업 등" style={inputStyle} />
                        </div>
                        <div>
                          <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>종목</label>
                          <input value={companyForm.businessCategory} onChange={e => setCompanyForm(p => ({ ...p, businessCategory: e.target.value }))}
                            placeholder="통역, 번역, 소프트웨어 등" style={inputStyle} />
                        </div>
                      </div>
                    )}

                    {/* 주소 */}
                    <div>
                      <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>주소</label>
                      <input value={companyForm.address} onChange={e => setCompanyForm(p => ({ ...p, address: e.target.value }))}
                        placeholder="서울시 강남구 테헤란로 123" style={inputStyle} />
                    </div>

                  </div>
                </div>

                {/* ── Card 3: 메모 ── */}
                <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
                  <div style={{ padding: "12px 18px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 3, height: 20, background: "#6366f1", borderRadius: 2, display: "inline-block", flexShrink: 0 }} />
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>메모</p>
                    <span style={{ fontSize: 12, color: "#9ca3af" }}>(선택)</span>
                  </div>
                  <div style={{ padding: "14px 18px" }}>
                    <textarea value={companyForm.notes} onChange={e => setCompanyForm(p => ({ ...p, notes: e.target.value }))}
                      rows={3} placeholder="거래처 관련 특이사항을 입력하세요."
                      style={{ ...inputStyle, resize: "vertical" }} />
                  </div>
                </div>

                {/* ── 액션 버튼 ── */}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <GhostBtn onClick={() => { setShowCompanyForm(false); setCreatedCompanyId(null); }} style={{ fontSize: 14, padding: "9px 18px" }}>취소</GhostBtn>
                  <PrimaryBtn onClick={handleCreateCompany} disabled={savingCompany || !companyForm.name.trim()} style={{ fontSize: 14, padding: "9px 24px" }}>
                    {savingCompany ? "등록 중..." : "거래처 등록"}
                  </PrimaryBtn>
                </div>

              </div>
            )}
          </Card>
        )}

        {/* ── 거래처 유형 필터 탭 ── */}
        {(() => {
          const TYPE_TABS = [
            { value: "all",    label: "전체",    activeBg: "#374151" },
            { value: "client", label: "고객사",  activeBg: "#1d4ed8" },
            { value: "vendor", label: "외주업체", activeBg: "#7c3aed" },
          ];
          const CUSTOMER_SUB_TABS = [
            { value: "all",        label: "전체" },
            { value: "CORPORATE",  label: "기업" },
            { value: "PUBLIC",     label: "공공기관" },
            { value: "INDIVIDUAL", label: "개인" },
          ];
          const filteredCompanies = companies.filter(c => {
            if (companyTypeFilter !== "all" && c.companyType !== companyTypeFilter) return false;
            if (companyVendorTypeFilter !== "all" && c.vendorType !== companyVendorTypeFilter) return false;
            if (companyTypeFilter === "client" && companyCustomerTypeFilter !== "all") {
              const ct = c.customerType ?? "CORPORATE";
              if (ct !== companyCustomerTypeFilter) return false;
            }
            return true;
          });
          return (
            <div style={{ marginBottom: 16 }}>
              {/* 1행: 거래처 유형 (1차) */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginRight: 6, whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>거래처 유형</span>
                {TYPE_TABS.map(tab => {
                  const isActive = companyTypeFilter === tab.value;
                  return (
                    <button key={tab.value} onClick={() => { setCompanyTypeFilter(tab.value as "all" | "client" | "vendor"); setCompanyVendorTypeFilter("all"); setCompanyCustomerTypeFilter("all"); }}
                      style={{
                        padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: isActive ? 700 : 500,
                        cursor: "pointer", transition: "all 0.12s",
                        border: isActive ? `2px solid ${tab.activeBg}` : "2px solid #e5e7eb",
                        background: isActive ? tab.activeBg : "#fff",
                        color: isActive ? "#fff" : "#374151",
                        lineHeight: "1.4",
                      }}>
                      {tab.label}
                      <span style={{ marginLeft: 5, fontSize: 11, opacity: 0.75 }}>
                        ({companies.filter(c => tab.value === "all" ? true : c.companyType === tab.value).length})
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* 2행: 고객 분류 (고객사 선택 시) */}
              {companyTypeFilter === "client" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, paddingLeft: 18, paddingTop: 6, paddingBottom: 6, borderLeft: "3px solid #93c5fd" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", marginRight: 6, whiteSpace: "nowrap", letterSpacing: "-0.01em" }}>고객 분류</span>
                  {CUSTOMER_SUB_TABS.map(tab => {
                    const isActive = companyCustomerTypeFilter === tab.value;
                    const { bg, color, border } = tab.value !== "all" ? getCustomerTypeBadgeColors(tab.value) : { bg: "", color: "", border: "" };
                    return (
                      <button key={tab.value} onClick={() => setCompanyCustomerTypeFilter(tab.value)}
                        style={{
                          padding: "5px 13px", borderRadius: 20, fontSize: 12, fontWeight: isActive ? 700 : 500,
                          cursor: "pointer", transition: "all 0.12s", lineHeight: "1.4",
                          border: isActive ? (tab.value === "all" ? "2px solid #1d4ed8" : `2px solid ${border}`) : "2px solid #e5e7eb",
                          background: isActive ? (tab.value === "all" ? "#1d4ed8" : bg) : "#fff",
                          color: isActive ? (tab.value === "all" ? "#fff" : color) : "#6b7280",
                        }}>
                        {tab.label}
                        {tab.value !== "all" && (
                          <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.8 }}>
                            ({companies.filter(c => c.companyType === "client" && (c.customerType ?? "CORPORATE") === tab.value).length})
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* 2행: 외주 분류 (외주업체 선택 시) */}
              {companyTypeFilter === "vendor" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, paddingLeft: 18, paddingTop: 6, paddingBottom: 6, borderLeft: "3px solid #c4b5fd" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#6d28d9", whiteSpace: "nowrap", marginRight: 6, letterSpacing: "-0.01em" }}>외주 분류</span>
                  <ClickSelect
                    value={companyVendorTypeFilter}
                    onChange={setCompanyVendorTypeFilter}
                    triggerStyle={{ fontSize: 12, padding: "5px 11px", borderRadius: 20, lineHeight: "1.4" }}
                    options={[
                      { value: "all", label: "전체 외주 분류" },
                      ...VENDOR_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label })),
                    ]}
                  />
                </div>
              )}

              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
                <input value={companySearch} onChange={e => setCompanySearch(e.target.value)}
                  placeholder="회사명, 브랜드명, 사업자번호, 전화, 이메일, 담당자..."
                  style={{ ...inputStyle, maxWidth: 340, flex: "1 1 200px", padding: "8px 12px", fontSize: 13 }}
                  onKeyDown={e => e.key === "Enter" && fetchCompanies()} />
                <PrimaryBtn onClick={fetchCompanies} disabled={companiesLoading} style={{ padding: "8px 16px", fontSize: 13 }}>
                  {companiesLoading ? "검색 중..." : "검색"}
                </PrimaryBtn>
              </div>
              {/* ── 목록 ── */}
              <div style={{ marginTop: 14 }}>
                {companiesLoading ? (
                  <div style={{ textAlign: "center", padding: "32px 0", color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
                ) : filteredCompanies.length === 0 ? (
                  <Card style={{ textAlign: "center", padding: "32px", color: "#9ca3af", fontSize: 14 }}>해당하는 거래처가 없습니다.</Card>
                ) : (
                  <Card style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr>{["ID", "거래처명 / 유형", "업종", "담당자", "프로젝트", "총 결제", "등록일"].map(h => <th key={h} style={tableTh}>{h}</th>)}</tr>
                        </thead>
                        <tbody>
                          {filteredCompanies.map(c => (
                            <tr key={c.id} onClick={() => setCompanyModal(c.id)} style={{ cursor: "pointer" }}
                              onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                              <td style={{ ...tableTd, color: "#9ca3af" }}>#{c.id}</td>
                              <td style={{ ...tableTd }}>
                                {/* Primary: 거래처명 — 가장 강한 존재감 */}
                                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 3 }}>
                                  {c.name}
                                  {c.matchedDivisionName && (
                                    <span style={{ fontWeight: 600, color: "#7c3aed", marginLeft: 4 }}>({c.matchedDivisionName})</span>
                                  )}
                                </div>
                                {!c.matchedDivisionName && (c.divisionNames?.length ?? 0) > 0 && (
                                  <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 3 }}>
                                    {c.divisionNames!.slice(0, 3).join(" · ")}{c.divisionNames!.length > 3 ? ` 외 ${c.divisionNames!.length - 3}개` : ""}
                                  </div>
                                )}
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                                  {/* 1차: 고객사 / 외주업체 */}
                                  <span style={c.companyType === "vendor" ? BADGE_SECONDARY_VENDOR : BADGE_SECONDARY_CLIENT}>
                                    {c.companyType === "vendor" ? "외주업체" : "고객사"}
                                  </span>
                                  {/* 2차: 고객 분류(색상) / 외주 세부 분류(purple) */}
                                  {c.companyType === "client" && (
                                    <span style={getCustomerSubBadgeStyle(c.customerType ?? "CORPORATE")}>
                                      {CUSTOMER_TYPE_LABELS[c.customerType ?? "CORPORATE"] ?? "기업"}
                                    </span>
                                  )}
                                  {c.companyType === "vendor" && c.vendorType && (
                                    <span style={BADGE_TERTIARY_VENDOR}>
                                      {VENDOR_TYPE_LABELS[c.vendorType] ?? c.vendorType}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td style={{ ...tableTd, fontSize: 12, color: "#6b7280" }}>{c.industry ?? "-"}</td>
                              <td style={{ ...tableTd, textAlign: "center" }}>
                                <span style={{ padding: "2px 8px", borderRadius: 10, background: "#f3f4f6", color: "#374151", fontSize: 12 }}>{c.contactCount}명</span>
                              </td>
                              <td style={{ ...tableTd, textAlign: "center" }}>
                                <span style={{ padding: "2px 8px", borderRadius: 10, background: "#eff6ff", color: "#2563eb", fontSize: 12, fontWeight: 600 }}>{c.projectCount}건</span>
                              </td>
                              <td style={{ ...tableTd, fontWeight: 600, color: "#059669", whiteSpace: "nowrap" }}>{Number(c.totalPayment).toLocaleString()}원</td>
                              <td style={{ ...tableTd, fontSize: 12, color: "#9ca3af", whiteSpace: "nowrap" }}>{new Date(c.createdAt).toLocaleDateString("ko-KR")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </div>
            </div>
          );
        })()}
      </Section>
    </>
  );
}
