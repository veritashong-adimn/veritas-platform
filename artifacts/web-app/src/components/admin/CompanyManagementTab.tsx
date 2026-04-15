import React, { useState, useCallback, useEffect } from 'react';
import {
  api, Company,
  VENDOR_TYPE_LABELS, VENDOR_TYPE_OPTIONS,
} from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn, ClickSelect } from '../ui';
import { CompanyDetailModal } from './CompanyDetailModal';
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
  hasPerm: (key: string | undefined) => boolean;
}

export function CompanyManagementTab({ token, onToast, onOpenProject, hasPerm }: CompanyManagementTabProps) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [companyModal, setCompanyModal] = useState<number | null>(null);
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [companyForm, setCompanyForm] = useState({
    name: "", businessNumber: "", representativeName: "", email: "",
    phone: "", mobile: "", industry: "", businessCategory: "", address: "",
    website: "", notes: "", registeredAt: new Date().toISOString().slice(0, 10),
    companyType: "client", vendorType: "",
  });
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

  const handleCreateCompany = async () => {
    if (!companyForm.name.trim()) { onToast("회사명을 입력하세요."); return; }
    setSavingCompany(true);
    try {
      const res = await fetch(api("/api/admin/companies"), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(companyForm),
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

  const handleAddNewCompanyContact = async () => {
    if (!newCompanyContactForm.name.trim() || !createdCompanyId) return;
    setSavingNewCompanyContact(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${createdCompanyId}/contacts`), {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ...newCompanyContactForm, companyId: createdCompanyId }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
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
      name: "", businessNumber: "", representativeName: "", email: "",
      phone: "", mobile: "", industry: "", businessCategory: "", address: "",
      website: "", notes: "", registeredAt: new Date().toISOString().slice(0, 10),
      companyType: "client", vendorType: "",
    });
    setShowCompanyForm(false);
  };

  return (
    <>
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
      <Section title={`거래처 관리 (${companies.length})`} action={
        hasPerm("company.create") ? (
          <PrimaryBtn onClick={() => { setShowCompanyForm(v => !v); setCreatedCompanyId(null); setCreatedCompanyName(""); }} style={{ fontSize: 13, padding: "7px 14px" }}>
            {showCompanyForm ? "취소" : "+ 거래처 등록"}
          </PrimaryBtn>
        ) : undefined
      }>
        {showCompanyForm && (
          <Card style={{ marginBottom: 16, padding: "16px 20px" }}>
            {createdCompanyId !== null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* 완료 배너 */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10, padding: "10px 14px" }}>
                  <span style={{ fontSize: 18 }}>✓</span>
                  <div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "#166534" }}>{createdCompanyName} 등록 완료</p>
                    <p style={{ margin: 0, fontSize: 12, color: "#15803d" }}>브랜드/부서와 담당자를 추가하거나 완료하세요.</p>
                  </div>
                  <button onClick={handleDoneCompanyCreate} style={{ marginLeft: "auto", padding: "6px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "#166534", color: "#fff", border: "none", cursor: "pointer" }}>완료</button>
                </div>

                {/* 단계 2: 브랜드/부서 */}
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
                  <button onClick={handleAddNewCompanyContact} disabled={savingNewCompanyContact || !newCompanyContactForm.name.trim()}
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
              <>
                <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#111827" }}>새 거래처 등록</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* 0행: 거래처 유형 */}
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 6 }}>거래처 유형 <span style={{ color: "#dc2626" }}>*</span></label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      {[{ v: "client", label: "고객사", color: "#1d4ed8", bg: "#eff6ff", border: "#93c5fd" }, { v: "vendor", label: "외주업체", color: "#7c3aed", bg: "#f5f3ff", border: "#c4b5fd" }].map(opt => (
                        <button key={opt.v} type="button" onClick={() => setCompanyForm(p => ({ ...p, companyType: opt.v, vendorType: "" }))}
                          style={{ padding: "7px 18px", borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all 0.12s",
                            background: companyForm.companyType === opt.v ? opt.bg : "#f9fafb",
                            color: companyForm.companyType === opt.v ? opt.color : "#6b7280",
                            border: `2px solid ${companyForm.companyType === opt.v ? opt.border : "#e5e7eb"}`,
                          }}>
                          {opt.label}
                        </button>
                      ))}
                      {companyForm.companyType === "vendor" && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 12, color: "#6b7280" }}>외주 유형:</span>
                          <ClickSelect
                            value={companyForm.vendorType}
                            onChange={v => setCompanyForm(p => ({ ...p, vendorType: v }))}
                            triggerStyle={{ fontSize: 13, padding: "6px 10px" }}
                            options={[
                              { value: "", label: "선택 안 함" },
                              ...VENDOR_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label })),
                            ]}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {/* 1행: 거래처명 */}
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>거래처명 <span style={{ color: "#dc2626" }}>*</span></label>
                    <input value={companyForm.name} onChange={e => setCompanyForm(p => ({ ...p, name: e.target.value }))}
                      placeholder="(주)아크로네이처" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
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
                  {/* 2행: 사업자등록번호 / 대표자명 / 등록일 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px" }}>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>사업자등록번호</label>
                      <input value={companyForm.businessNumber} onChange={e => setCompanyForm(p => ({ ...p, businessNumber: e.target.value }))}
                        placeholder="000-00-00000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>대표자명</label>
                      <input value={companyForm.representativeName} onChange={e => setCompanyForm(p => ({ ...p, representativeName: e.target.value }))}
                        placeholder="홍길동" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>등록일</label>
                      <input type="date" value={companyForm.registeredAt} onChange={e => setCompanyForm(p => ({ ...p, registeredAt: e.target.value }))}
                        style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                  </div>
                  {/* 3행: 대표전화 / 휴대폰 / 이메일 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px" }}>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>대표전화</label>
                      <input value={companyForm.phone} onChange={e => setCompanyForm(p => ({ ...p, phone: formatPhone(e.target.value) }))}
                        placeholder="02-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>휴대폰</label>
                      <input value={companyForm.mobile} onChange={e => setCompanyForm(p => ({ ...p, mobile: formatPhone(e.target.value) }))}
                        placeholder="010-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>이메일</label>
                      <input type="email" value={companyForm.email} onChange={e => setCompanyForm(p => ({ ...p, email: e.target.value }))}
                        placeholder="contact@company.com" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                  </div>
                  {/* 3.5행: 웹사이트 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "0 12px" }}>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>웹사이트</label>
                      <input value={companyForm.website} onChange={e => setCompanyForm(p => ({ ...p, website: e.target.value }))}
                        placeholder="https://example.com" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                  </div>
                  {/* 4행: 업태 / 종목 */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>업태</label>
                      <input value={companyForm.industry} onChange={e => setCompanyForm(p => ({ ...p, industry: e.target.value }))}
                        placeholder="제조업, 서비스업 등" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>종목</label>
                      <input value={companyForm.businessCategory} onChange={e => setCompanyForm(p => ({ ...p, businessCategory: e.target.value }))}
                        placeholder="통역, 번역, 소프트웨어 등" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                  </div>
                  {/* 5행: 주소 */}
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>주소</label>
                    <input value={companyForm.address} onChange={e => setCompanyForm(p => ({ ...p, address: e.target.value }))}
                      placeholder="서울시 강남구 테헤란로 123" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                  {/* 6행: 메모 */}
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>메모</label>
                    <textarea value={companyForm.notes} onChange={e => setCompanyForm(p => ({ ...p, notes: e.target.value }))}
                      rows={2} placeholder="거래처 관련 특이사항을 입력하세요." style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", resize: "vertical" }} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <PrimaryBtn onClick={handleCreateCompany} disabled={savingCompany || !companyForm.name.trim()} style={{ fontSize: 13, padding: "8px 18px" }}>
                    {savingCompany ? "등록 중..." : "등록"}
                  </PrimaryBtn>
                  <GhostBtn onClick={() => { setShowCompanyForm(false); setCreatedCompanyId(null); }} style={{ fontSize: 13, padding: "8px 14px" }}>취소</GhostBtn>
                </div>
              </>
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
          const filteredCompanies = companies.filter(c => {
            if (companyTypeFilter !== "all" && c.companyType !== companyTypeFilter) return false;
            if (companyVendorTypeFilter !== "all" && c.vendorType !== companyVendorTypeFilter) return false;
            return true;
          });
          return (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", marginRight: 4, whiteSpace: "nowrap" }}>거래처 유형</span>
                {TYPE_TABS.map(tab => {
                  const isActive = companyTypeFilter === tab.value;
                  return (
                    <button key={tab.value} onClick={() => { setCompanyTypeFilter(tab.value as "all" | "client" | "vendor"); setCompanyVendorTypeFilter("all"); }}
                      style={{ padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: isActive ? 700 : 500, cursor: "pointer", transition: "all 0.12s",
                        border: isActive ? `2px solid ${tab.activeBg}` : "2px solid #e5e7eb",
                        background: isActive ? tab.activeBg : "#fff",
                        color: isActive ? "#fff" : "#374151",
                      }}>
                      {tab.label}
                      <span style={{ marginLeft: 5, fontSize: 11, opacity: 0.8 }}>
                        ({companies.filter(c => tab.value === "all" ? true : c.companyType === tab.value).length})
                      </span>
                    </button>
                  );
                })}
                {companyTypeFilter === "vendor" && (
                  <ClickSelect
                    value={companyVendorTypeFilter}
                    onChange={setCompanyVendorTypeFilter}
                    triggerStyle={{ fontSize: 12, padding: "6px 10px", marginLeft: 4 }}
                    options={[
                      { value: "all", label: "전체 외주유형" },
                      ...VENDOR_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label })),
                    ]}
                  />
                )}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
                                <div style={{ fontWeight: 700, color: "#111827", marginBottom: 2 }}>
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
                                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                                  <span style={{
                                    fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 8,
                                    background: c.companyType === "vendor" ? "#f5f3ff" : "#eff6ff",
                                    color: c.companyType === "vendor" ? "#7c3aed" : "#1d4ed8",
                                    border: `1px solid ${c.companyType === "vendor" ? "#ddd6fe" : "#bfdbfe"}`,
                                  }}>
                                    {c.companyType === "vendor" ? "외주업체" : "고객사"}
                                  </span>
                                  {c.vendorType && (
                                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 8, background: "#faf5ff", color: "#9333ea", border: "1px solid #e9d5ff" }}>
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
