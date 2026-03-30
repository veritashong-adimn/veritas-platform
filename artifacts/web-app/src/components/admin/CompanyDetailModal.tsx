import React, { useState, useEffect } from "react";
import { api, CompanyDetail, Contact, Division, NoteEntry } from "../../lib/constants";
import { StatusBadge, PrimaryBtn, GhostBtn } from "../ui";
import { ReviewMemoPanel } from "./ReviewMemoPanel";
import { PrepaidLedgerModal } from "./PrepaidLedgerModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const sH: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#6b7280",
  textTransform: "uppercase", letterSpacing: "0.06em",
  margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
};

export function CompanyDetailModal({ companyId, token, onClose, onToast, onOpenProject }: {
  companyId: number; token: string; onClose: () => void;
  onToast: (msg: string) => void; onOpenProject: (id: number) => void;
}) {
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showContactForm, setShowContactForm] = useState(false);
  const [contactForm, setContactForm] = useState({ name: "", department: "", position: "", email: "", phone: "", notes: "" });
  const [addingContact, setAddingContact] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", businessNumber: "", representativeName: "", email: "", phone: "", industry: "", businessCategory: "", address: "", website: "", notes: "", registeredAt: "" });
  const [originalName, setOriginalName] = useState("");
  const [nameChangeReason, setNameChangeReason] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [compNotes, setCompNotes] = useState<NoteEntry[]>([]);
  const [compNoteText, setCompNoteText] = useState("");
  const [addingCompNote, setAddingCompNote] = useState(false);
  type PrepaidAccount = { id: number; companyId: number; companyName: string; initialAmount: number; currentBalance: number; status: string; note: string | null; depositDate: string | null; createdAt: string };
  const [prepaidAccounts, setPrepaidAccounts] = useState<PrepaidAccount[]>([]);
  const [selectedLedgerAccountId, setSelectedLedgerAccountId] = useState<number | null>(null);
  const [showDivForm, setShowDivForm] = useState(false);
  const [divForm, setDivForm] = useState({ name: "", type: "" });
  const [addingDiv, setAddingDiv] = useState(false);
  const [editDivId, setEditDivId] = useState<number | null>(null);
  const [editDivForm, setEditDivForm] = useState({ name: "", type: "" });

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes] = await Promise.all([
        fetch(api(`/api/admin/companies/${companyId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=company&entityId=${companyId}`), { headers: authH }),
      ]);
      const [data, nData] = await Promise.all([dRes.json(), nRes.json()]);
      if (dRes.ok) {
        setDetail(data);
        setOriginalName(data.name);
        setEditForm({
          name: data.name,
          businessNumber: data.businessNumber ?? "",
          representativeName: data.representativeName ?? "",
          email: data.email ?? "",
          phone: data.phone ?? "",
          industry: data.industry ?? "",
          businessCategory: (data as any).businessCategory ?? "",
          address: data.address ?? "",
          website: data.website ?? "",
          notes: data.notes ?? "",
          registeredAt: (data as any).registeredAt ?? "",
        });
      }
      if (nRes.ok) setCompNotes(Array.isArray(nData) ? nData : []);
      // 선입금 계정 로드
      const paRes = await fetch(api(`/api/admin/prepaid-accounts?companyId=${companyId}`), { headers: authH });
      if (paRes.ok) setPrepaidAccounts(await paRes.json());
    } catch { onToast("오류: 거래처 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [companyId]);

  const handleAddCompNote = async () => {
    if (!compNoteText.trim()) return;
    setAddingCompNote(true);
    try {
      const res = await fetch(api("/api/admin/notes"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "company", entityId: companyId, content: compNoteText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setCompNotes(prev => [data, ...prev]);
      setCompNoteText("");
      onToast("메모가 추가되었습니다.");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingCompNote(false); }
  };

  const handleSaveEdit = async () => {
    const errs: Record<string, string> = {};
    if (!editForm.name.trim()) errs.name = "거래처명은 필수입니다.";
    if (editForm.businessNumber.trim()) {
      const bn = editForm.businessNumber.replace(/-/g, "");
      if (!/^\d{10}$/.test(bn)) errs.businessNumber = "사업자등록번호 형식: 000-00-00000";
    }
    if (editForm.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editForm.email.trim())) errs.email = "이메일 형식이 올바르지 않습니다.";
    if (editForm.website.trim() && !/^https?:\/\/.+/.test(editForm.website.trim())) errs.website = "웹사이트는 http:// 또는 https://로 시작해야 합니다.";
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // 상호 변경 시 사유 필수
    const isNameChanged = editForm.name.trim() !== originalName;
    if (isNameChanged && !nameChangeReason.trim()) {
      errs.nameChangeReason = "상호 변경 시 변경 사유를 입력해주세요.";
    }
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) return;

    try {
      const body: Record<string, any> = { ...editForm };
      if (isNameChanged) body.nameChangeReason = nameChangeReason.trim();
      const res = await fetch(api(`/api/admin/companies/${companyId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, ...data } : prev);
      setOriginalName(data.name);
      setFormErrors({});
      setNameChangeReason("");
      setEditMode(false);
      await load();
      onToast("거래처 정보가 수정되었습니다.");
    } catch { onToast("오류: 수정 실패"); }
  };

  const handleAddContact = async () => {
    if (!contactForm.name.trim()) { onToast("담당자 이름을 입력하세요."); return; }
    setAddingContact(true);
    try {
      const res = await fetch(api("/api/admin/contacts"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ ...contactForm, companyId }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, contacts: [...prev.contacts, data] } : prev);
      setContactForm({ name: "", department: "", position: "", email: "", phone: "", notes: "" });
      setShowContactForm(false);
      onToast("담당자가 추가되었습니다.");
    } catch { onToast("오류: 담당자 추가 실패"); }
    finally { setAddingContact(false); }
  };

  const handleAddDiv = async () => {
    if (!divForm.name.trim()) { onToast("브랜드/부서명을 입력하세요."); return; }
    setAddingDiv(true);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/divisions`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(divForm),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, divisions: [...prev.divisions, { ...data, projectCount: 0, totalPayment: 0, contactCount: 0 }] } : prev);
      setDivForm({ name: "", type: "" });
      setShowDivForm(false);
      onToast("브랜드/부서가 추가되었습니다.");
    } catch { onToast("오류: 추가 실패"); }
    finally { setAddingDiv(false); }
  };

  const handleSaveDiv = async (divId: number) => {
    try {
      const res = await fetch(api(`/api/admin/divisions/${divId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(editDivForm),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setDetail(prev => prev ? { ...prev, divisions: prev.divisions.map(d => d.id === divId ? { ...d, ...data } : d) } : prev);
      setEditDivId(null);
      onToast("수정되었습니다.");
    } catch { onToast("오류: 수정 실패"); }
  };

  const handleDeleteDiv = async (divId: number, name: string) => {
    if (!confirm(`"${name}" 브랜드/부서를 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(api(`/api/admin/divisions/${divId}`), { method: "DELETE", headers: authH });
      if (!res.ok) { onToast("삭제 실패"); return; }
      setDetail(prev => prev ? { ...prev, divisions: prev.divisions.filter(d => d.id !== divId) } : prev);
      onToast("삭제되었습니다.");
    } catch { onToast("오류: 삭제 실패"); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 300, overflowY: "auto", padding: "20px 16px" }}>
      <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", width: "100%", maxWidth: 780, padding: "24px 28px", boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>거래처 #{companyId} 상세</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9ca3af" }}>×</button>
        </div>
        {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : !detail ? <p style={{ color: "#dc2626" }}>데이터를 불러올 수 없습니다.</p> : (
          <>
            <ReviewMemoPanel storageKey={`company_${companyId}`} label="이 거래처 검수 메모" />
            <p style={sH}>거래처 정보</p>
            {!editMode ? (
              <div style={{ marginBottom: 10 }}>
                {/* 기본정보 그리드 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px 0", marginBottom: 10 }}>
                  {([
                    ["거래처명", detail.name, true],
                    ["사업자번호", detail.businessNumber ?? "-", false],
                    ["대표자명", detail.representativeName ?? "-", false],
                    ["등록일", (detail as any).registeredAt ?? "-", false],
                    ["전화번호", detail.phone ?? "-", false],
                    ["이메일", detail.email ?? "-", false],
                    ["웹사이트", detail.website ?? "-", false],
                    ["업태", detail.industry ?? "-", false],
                    ["종목", (detail as any).businessCategory ?? "-", false],
                  ] as [string, string, boolean][]).map(([l, v, bold]) => (
                    <div key={l} style={{ display: "flex", flexDirection: "column", gap: 1, paddingRight: 12 }}>
                      <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase" }}>{l}</span>
                      <span style={{ fontSize: 13, color: "#374151", fontWeight: bold ? 700 : 400 }}>
                        {l === "웹사이트" && v !== "-"
                          ? <a href={v} target="_blank" rel="noreferrer" style={{ color: "#2563eb" }}>{v}</a>
                          : v}
                      </span>
                    </div>
                  ))}
                </div>
                {/* 주소 */}
                {detail.address && (
                  <div style={{ display: "flex", gap: 6, fontSize: 13, marginBottom: 6 }}>
                    <span style={{ color: "#9ca3af", minWidth: 56, fontSize: 10, fontWeight: 600, textTransform: "uppercase", paddingTop: 2 }}>주소</span>
                    <span style={{ color: "#374151" }}>{detail.address}</span>
                  </div>
                )}
                {/* 메모 */}
                {detail.notes && (
                  <div style={{ background: "#f9fafb", borderRadius: 8, padding: "8px 12px", marginBottom: 6 }}>
                    <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase" }}>메모</span>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "#374151", whiteSpace: "pre-wrap" }}>{detail.notes}</p>
                  </div>
                )}
                <GhostBtn onClick={() => setEditMode(true)} style={{ width: "fit-content", fontSize: 12, padding: "5px 12px", marginTop: 4 }}>정보 수정</GhostBtn>
                {/* 상호 변경 이력 */}
                {(() => {
                  const history = (detail as any).nameHistory ?? [];
                  const previousNames = history.filter((h: any) => h.nameType === "previous" || h.nameType === "alias");
                  if (previousNames.length === 0) return null;
                  return (
                    <div style={{ marginTop: 10, background: "#f9fafb", borderRadius: 8, padding: "10px 12px", border: "1px solid #f3f4f6" }}>
                      <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>상호 변경 이력</p>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {previousNames.map((h: any) => (
                          <div key={h.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}>
                            <span style={{ background: "#e5e7eb", borderRadius: 4, padding: "1px 6px", color: "#374151", fontWeight: 600, whiteSpace: "nowrap", marginTop: 1 }}>
                              {h.nameType === "alias" ? "별칭" : "이전 상호"}
                            </span>
                            <div style={{ flex: 1 }}>
                              <span style={{ color: "#374151", fontWeight: 600 }}>{h.companyName}</span>
                              {h.validFrom && (
                                <span style={{ color: "#9ca3af", marginLeft: 6 }}>
                                  {h.validFrom}{h.validTo ? ` ~ ${h.validTo}` : ""}
                                </span>
                              )}
                              {h.reason && <span style={{ color: "#9ca3af", marginLeft: 6 }}>· {h.reason}</span>}
                              {h.changedByEmail && <span style={{ color: "#9ca3af", marginLeft: 6 }}>({h.changedByEmail})</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                {/* 1행: 거래처명 */}
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>거래처명 <span style={{ color: "#dc2626" }}>*</span></label>
                  <input value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))}
                    style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: formErrors.name ? "#fca5a5" : undefined }} />
                  {formErrors.name && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.name}</p>}
                </div>
                {/* 상호 변경 감지 시 사유 입력란 표시 */}
                {editForm.name.trim() !== originalName && editForm.name.trim() !== "" && (
                  <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "10px 12px" }}>
                    <p style={{ margin: "0 0 6px", fontSize: 12, color: "#92400e", fontWeight: 600 }}>⚠️ 거래처명(상호) 변경이 감지되었습니다</p>
                    <p style={{ margin: "0 0 8px", fontSize: 11, color: "#78350f" }}>
                      <strong>{originalName}</strong> → <strong>{editForm.name.trim()}</strong>
                      <br />이전 상호는 변경 이력으로 자동 저장됩니다.
                    </p>
                    <label style={{ fontSize: 12, color: "#92400e", fontWeight: 700, display: "block", marginBottom: 3 }}>변경 사유 <span style={{ color: "#dc2626" }}>*</span></label>
                    <input value={nameChangeReason} onChange={e => setNameChangeReason(e.target.value)}
                      placeholder="예: 법인 전환, 합병, 상호 변경 등"
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: formErrors.nameChangeReason ? "#fca5a5" : "#fcd34d" }} />
                    {formErrors.nameChangeReason && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.nameChangeReason}</p>}
                  </div>
                )}
                {/* 2행: 사업자등록번호 / 대표자명 / 등록일 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>사업자등록번호</label>
                    <input value={editForm.businessNumber} onChange={e => setEditForm(p => ({ ...p, businessNumber: e.target.value }))}
                      placeholder="000-00-00000"
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: formErrors.businessNumber ? "#fca5a5" : undefined }} />
                    {formErrors.businessNumber && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.businessNumber}</p>}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>대표자명</label>
                    <input value={editForm.representativeName} onChange={e => setEditForm(p => ({ ...p, representativeName: e.target.value }))}
                      placeholder="홍길동" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>등록일</label>
                    <input type="date" value={editForm.registeredAt} onChange={e => setEditForm(p => ({ ...p, registeredAt: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                </div>
                {/* 3행: 전화 / 이메일 / 웹사이트 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>전화번호</label>
                    <input value={editForm.phone} onChange={e => setEditForm(p => ({ ...p, phone: e.target.value }))}
                      placeholder="02-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>이메일</label>
                    <input value={editForm.email} onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))}
                      placeholder="contact@company.com"
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: formErrors.email ? "#fca5a5" : undefined }} />
                    {formErrors.email && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.email}</p>}
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>웹사이트</label>
                    <input value={editForm.website} onChange={e => setEditForm(p => ({ ...p, website: e.target.value }))}
                      placeholder="https://example.com"
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: formErrors.website ? "#fca5a5" : undefined }} />
                    {formErrors.website && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.website}</p>}
                  </div>
                </div>
                {/* 4행: 업태 / 종목 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 12px" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>업태</label>
                    <input value={editForm.industry} onChange={e => setEditForm(p => ({ ...p, industry: e.target.value }))}
                      placeholder="제조업, 서비스업 등" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>종목</label>
                    <input value={editForm.businessCategory} onChange={e => setEditForm(p => ({ ...p, businessCategory: e.target.value }))}
                      placeholder="통역, 번역, 소프트웨어 등" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                </div>
                {/* 5행: 주소 */}
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>주소</label>
                  <input value={editForm.address} onChange={e => setEditForm(p => ({ ...p, address: e.target.value }))}
                    placeholder="서울시 강남구 테헤란로 123" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                </div>
                {/* 6행: 메모 */}
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>메모</label>
                  <textarea value={editForm.notes} onChange={e => setEditForm(p => ({ ...p, notes: e.target.value }))}
                    rows={3} placeholder="거래처 관련 특이사항을 입력하세요."
                    style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", resize: "vertical" }} />
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <PrimaryBtn onClick={handleSaveEdit} style={{ fontSize: 13, padding: "7px 16px" }}>저장</PrimaryBtn>
                  <GhostBtn onClick={() => { setEditMode(false); setFormErrors({}); setNameChangeReason(""); }} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                </div>
              </div>
            )}

            <p style={sH}>재무 요약</p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {[
                { label: "담당자 수", value: `${detail.contacts.length}명`, color: "#6b7280", bg: "#f3f4f6" },
                { label: "프로젝트 수", value: `${detail.projects.length}건`, color: "#2563eb", bg: "#eff6ff" },
                { label: "총 견적 금액", value: `${Number(detail.totalQuote).toLocaleString()}원`, color: "#0891b2", bg: "#f0f9ff" },
                { label: "총 결제 금액", value: `${Number(detail.totalPayment).toLocaleString()}원`, color: "#059669", bg: "#f0fdf4" },
                { label: "총 정산 금액", value: `${Number(detail.totalSettlement).toLocaleString()}원`, color: "#7c3aed", bg: "#faf5ff" },
              ].map(s => (
                <div key={s.label} style={{ background: s.bg, border: `1px solid ${s.color}22`, borderRadius: 10, padding: "10px 16px", flex: "1 1 100px" }}>
                  <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: s.color }}>{s.label}</p>
                  <p style={{ margin: 0, fontSize: 18, fontWeight: 800, color: s.color }}>{s.value}</p>
                </div>
              ))}
            </div>
            {/* 확장 요약 */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              {(detail as any).prepaidBalance != null && (
                <div style={{ background: (detail as any).prepaidBalance > 0 ? "#f0fdf4" : "#fef2f2", border: "1px solid", borderColor: (detail as any).prepaidBalance > 0 ? "#bbf7d0" : "#fecaca", borderRadius: 10, padding: "10px 16px", flex: "1 1 120px" }}>
                  <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: (detail as any).prepaidBalance > 0 ? "#15803d" : "#dc2626" }}>선입금 잔액</p>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: (detail as any).prepaidBalance > 0 ? "#15803d" : "#dc2626" }}>{Number((detail as any).prepaidBalance).toLocaleString()}원</p>
                </div>
              )}
              {(detail as any).unpaidAmount > 0 && (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 16px", flex: "1 1 120px" }}>
                  <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: "#92400e" }}>미수금</p>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#92400e" }}>{Number((detail as any).unpaidAmount).toLocaleString()}원</p>
                </div>
              )}
              {(detail as any).activeAccumulatedCount > 0 && (
                <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "10px 16px", flex: "1 1 120px" }}>
                  <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 600, color: "#1d4ed8" }}>누적 청구 진행</p>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: "#1d4ed8" }}>{(detail as any).activeAccumulatedCount}건</p>
                </div>
              )}
            </div>

            {/* ── 선입금 계정 섹션 ── */}
            {prepaidAccounts.length > 0 && (
              <div style={{ marginTop: 18, marginBottom: 4 }}>
                <p style={sH}>선입금 계정 ({prepaidAccounts.length})</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {prepaidAccounts.map(acct => (
                    <div key={acct.id} onClick={() => setSelectedLedgerAccountId(acct.id)}
                      style={{ background: acct.currentBalance > 0 ? "#f0fdf4" : "#f9fafb", border: `1px solid ${acct.currentBalance > 0 ? "#86efac" : "#e5e7eb"}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", minWidth: 170, flex: "1 1 170px" }}
                      onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 2px 10px rgba(37,99,235,0.12)")}
                      onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}>
                      <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 2 }}>
                        {acct.depositDate ?? "-"}{acct.note ? ` · ${acct.note}` : ""}
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: acct.currentBalance > 0 ? "#15803d" : "#6b7280" }}>
                          {acct.currentBalance.toLocaleString()}원
                        </div>
                        <div style={{ fontSize: 10, color: "#9ca3af" }}>원장 보기 →</div>
                      </div>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>최초: {acct.initialAmount.toLocaleString()}원</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── 브랜드/부서 섹션 ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20, marginBottom: 10 }}>
              <p style={{ ...sH, margin: 0 }}>브랜드 / 부서 ({detail.divisions.length})</p>
              <GhostBtn onClick={() => setShowDivForm(v => !v)} style={{ fontSize: 12, padding: "4px 10px" }}>+ 추가</GhostBtn>
            </div>
            {showDivForm && (
              <div style={{ background: "#f9fafb", borderRadius: 10, padding: "14px 16px", marginBottom: 12, border: "1px solid #e5e7eb" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>브랜드/부서명 *</label>
                    <input value={divForm.name} onChange={e => setDivForm(p => ({ ...p, name: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} placeholder="예: 까르띠에" />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>유형 (선택)</label>
                    <input value={divForm.type} onChange={e => setDivForm(p => ({ ...p, type: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} placeholder="brand / department / team" />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <PrimaryBtn onClick={handleAddDiv} disabled={addingDiv} style={{ fontSize: 13, padding: "7px 16px" }}>
                    {addingDiv ? "추가 중..." : "추가"}
                  </PrimaryBtn>
                  <GhostBtn onClick={() => setShowDivForm(false)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                </div>
              </div>
            )}
            {detail.divisions.length === 0
              ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>등록된 브랜드/부서가 없습니다.</p>
              : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {detail.divisions.map((d: Division) => (
                    editDivId === d.id
                      ? (
                        <div key={d.id} style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 14px", border: "1px solid #e5e7eb" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <input value={editDivForm.name} onChange={e => setEditDivForm(p => ({ ...p, name: e.target.value }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "5px 8px" }} placeholder="브랜드/부서명" />
                            <input value={editDivForm.type} onChange={e => setEditDivForm(p => ({ ...p, type: e.target.value }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "5px 8px" }} placeholder="유형" />
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                            <PrimaryBtn onClick={() => handleSaveDiv(d.id)} style={{ fontSize: 12, padding: "5px 12px" }}>저장</PrimaryBtn>
                            <GhostBtn onClick={() => setEditDivId(null)} style={{ fontSize: 12, padding: "5px 12px" }}>취소</GhostBtn>
                          </div>
                        </div>
                      ) : (
                        <div key={d.id} style={{ display: "flex", gap: 12, padding: "10px 14px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", alignItems: "center", flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: 120 }}>
                            <span style={{ fontWeight: 700, fontSize: 13, color: "#111827" }}>{d.name}</span>
                            {d.type && <span style={{ marginLeft: 6, fontSize: 11, color: "#9ca3af", padding: "1px 6px", background: "#f3f4f6", borderRadius: 6 }}>{d.type}</span>}
                          </div>
                          <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#6b7280" }}>
                            <span>프로젝트 <strong style={{ color: "#2563eb" }}>{d.projectCount ?? 0}건</strong></span>
                            <span>매출 <strong style={{ color: "#059669" }}>{Number(d.totalPayment ?? 0).toLocaleString()}원</strong></span>
                            <span>담당자 <strong>{d.contactCount ?? 0}명</strong></span>
                          </div>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button onClick={() => { setEditDivId(d.id); setEditDivForm({ name: d.name, type: d.type ?? "" }); }}
                              style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", color: "#6b7280" }}>수정</button>
                            <button onClick={() => handleDeleteDiv(d.id, d.name)}
                              style={{ background: "none", border: "1px solid #fca5a5", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", color: "#ef4444" }}>삭제</button>
                          </div>
                        </div>
                      )
                  ))}
                </div>
              )
            }

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20, marginBottom: 10 }}>
              <p style={{ ...sH, margin: 0 }}>담당자 목록 ({detail.contacts.length})</p>
              <GhostBtn onClick={() => setShowContactForm(v => !v)} style={{ fontSize: 12, padding: "4px 10px" }}>+ 추가</GhostBtn>
            </div>
            {showContactForm && (
              <div style={{ background: "#f9fafb", borderRadius: 10, padding: "14px 16px", marginBottom: 12, border: "1px solid #e5e7eb" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
                  {(["name","department","position","email","phone"] as const).map(f => (
                    <div key={f}>
                      <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 2 }}>
                        {f === "name" ? "이름*" : f === "department" ? "부서" : f === "position" ? "직책" : f === "email" ? "이메일" : "전화"}
                      </label>
                      <input value={contactForm[f]} onChange={e => setContactForm(p => ({ ...p, [f]: e.target.value }))}
                        style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <PrimaryBtn onClick={handleAddContact} disabled={addingContact} style={{ fontSize: 13, padding: "7px 16px" }}>
                    {addingContact ? "추가 중..." : "추가"}
                  </PrimaryBtn>
                  <GhostBtn onClick={() => setShowContactForm(false)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                </div>
              </div>
            )}
            {detail.contacts.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>등록된 담당자가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.contacts.map((c: Contact) => (
                  <div key={c.id} style={{ padding: "10px 14px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                    <strong style={{ color: "#111827", minWidth: 80 }}>{c.name}</strong>
                    {c.position && <span style={{ color: "#6b7280" }}>{c.position}</span>}
                    {c.email && <span style={{ color: "#2563eb" }}>✉ {c.email}</span>}
                    {c.phone && <span style={{ color: "#374151" }}>📞 {c.phone}</span>}
                  </div>
                ))}
              </div>
            )}

            <p style={{ ...sH, marginTop: 20 }}>프로젝트 목록 ({detail.projects.length})</p>
            {detail.projects.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>등록된 프로젝트가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.projects.map(p => (
                  <div key={p.id} onClick={() => { onClose(); onOpenProject(p.id); }}
                    style={{ display: "flex", gap: 16, padding: "10px 14px", background: "#f9fafb", borderRadius: 8, fontSize: 13, cursor: "pointer", alignItems: "center", border: "1px solid transparent" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#eff6ff"; (e.currentTarget as HTMLDivElement).style.borderColor = "#bfdbfe"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; (e.currentTarget as HTMLDivElement).style.borderColor = "transparent"; }}>
                    <span style={{ color: "#9ca3af", minWidth: 36 }}>#{p.id}</span>
                    <span style={{ fontWeight: 600, color: "#111827", flex: 1 }}>{p.title}</span>
                    <StatusBadge status={p.status} />
                    <span style={{ color: "#9ca3af", fontSize: 12 }}>{new Date(p.createdAt).toLocaleDateString("ko-KR")}</span>
                  </div>
                ))}
              </div>
            )}

            <p style={{ ...sH, marginTop: 20 }}>메모 ({compNotes.length})</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <input value={compNoteText} onChange={e => setCompNoteText(e.target.value)} placeholder="메모 입력..."
                style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
                onKeyDown={e => e.key === "Enter" && handleAddCompNote()} />
              <PrimaryBtn onClick={handleAddCompNote} disabled={addingCompNote || !compNoteText.trim()} style={{ fontSize: 13, padding: "7px 14px" }}>
                {addingCompNote ? "추가 중..." : "추가"}
              </PrimaryBtn>
            </div>
            {compNotes.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "8px 0" }}>메모가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {compNotes.map(n => (
                  <div key={n.id} style={{ padding: "10px 12px", background: "#fffbeb", borderRadius: 8, border: "1px solid #fde68a" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "#92400e", fontWeight: 600 }}>{n.adminEmail ?? "관리자"}</span>
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(n.createdAt).toLocaleString("ko-KR")}</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: "#374151" }}>{n.content}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 선입금 원장 모달 */}
      {selectedLedgerAccountId !== null && (
        <PrepaidLedgerModal
          accountId={selectedLedgerAccountId}
          authHeaders={{ Authorization: `Bearer ${token}` }}
          onClose={() => setSelectedLedgerAccountId(null)}
          onUpdate={load}
        />
      )}
    </div>
  );
}
