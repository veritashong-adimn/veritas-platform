import React, { useState, useEffect } from "react";
import { api, CompanyDetail, Contact, Division, NoteEntry, VENDOR_TYPE_LABELS, VENDOR_TYPE_OPTIONS } from "../../lib/constants";
import { StatusBadge, PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { formatPhone } from "../../lib/utils";
import { ReviewMemoPanel } from "./ReviewMemoPanel";
import { PrepaidLedgerModal } from "./PrepaidLedgerModal";
import { DraggableModal } from "./DraggableModal";

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

export function CompanyDetailModal({ companyId, token, onClose, onToast, onOpenProject, onRefresh, onDeleted }: {
  companyId: number; token: string; onClose: () => void;
  onToast: (msg: string) => void; onOpenProject: (id: number) => void;
  onRefresh?: () => void;
  onDeleted?: () => void;
}) {
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteCanForce, setDeleteCanForce] = useState(false);
  const [showContactForm, setShowContactForm] = useState(false);
  const emptyContactForm = { name: "", department: "", position: "", email: "", phone: "", mobile: "", officePhone: "", memo: "", isPrimary: false, isQuoteContact: false, isBillingContact: false, isActive: true, divisionId: null as number | null };
  const [contactForm, setContactForm] = useState(emptyContactForm);
  const [contactFormErrors, setContactFormErrors] = useState<Record<string, string>>({});
  const [addingContact, setAddingContact] = useState(false);
  const [editContactId, setEditContactId] = useState<number | null>(null);
  const [editContactForm, setEditContactForm] = useState(emptyContactForm);
  const [editContactErrors, setEditContactErrors] = useState<Record<string, string>>({});
  const [savingContact, setSavingContact] = useState(false);
  const [showInactiveContacts, setShowInactiveContacts] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", businessNumber: "", representativeName: "", email: "", phone: "", mobile: "", industry: "", businessCategory: "", address: "", website: "", notes: "", registeredAt: "", companyType: "client", vendorType: "" });
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
          mobile: (data as any).mobile ?? "",
          industry: data.industry ?? "",
          businessCategory: (data as any).businessCategory ?? "",
          address: data.address ?? "",
          website: data.website ?? "",
          notes: data.notes ?? "",
          registeredAt: (data as any).registeredAt ?? "",
          companyType: (data as any).companyType ?? "client",
          vendorType: (data as any).vendorType ?? "",
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
      onRefresh?.();
      onToast("거래처 정보가 수정되었습니다.");
    } catch { onToast("오류: 수정 실패"); }
  };

  const validateContactForm = (f: typeof emptyContactForm) => {
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = "담당자명은 필수입니다.";
    if (!f.mobile.trim() && !f.email.trim()) errs.mobile = "휴대폰 또는 이메일 중 하나 이상 입력해주세요.";
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) errs.email = "이메일 형식이 올바르지 않습니다.";
    return errs;
  };

  const handleAddContact = async () => {
    const errs = validateContactForm(contactForm);
    setContactFormErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setAddingContact(true);
    try {
      const res = await fetch(api("/api/admin/contacts"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ ...contactForm, companyId }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setContactForm(emptyContactForm);
      setContactFormErrors({});
      setShowContactForm(false);
      await load();
      onToast("담당자가 추가되었습니다.");
    } catch { onToast("오류: 담당자 추가 실패"); }
    finally { setAddingContact(false); }
  };

  const handleEditContact = (c: Contact) => {
    setEditContactId(c.id);
    setEditContactForm({
      name: c.name, department: c.department ?? "", position: c.position ?? "",
      email: c.email ?? "", phone: c.phone ?? "", mobile: c.mobile ?? "",
      officePhone: c.officePhone ?? "", memo: c.memo ?? "",
      isPrimary: c.isPrimary, isQuoteContact: c.isQuoteContact,
      isBillingContact: c.isBillingContact, isActive: c.isActive,
      divisionId: (c as any).divisionId ?? null,
    });
    setEditContactErrors({});
  };

  const handleSaveContact = async () => {
    if (!editContactId) return;
    const errs = validateContactForm(editContactForm);
    setEditContactErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSavingContact(true);
    try {
      const res = await fetch(api(`/api/admin/contacts/${editContactId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify(editContactForm),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setEditContactId(null);
      await load();
      onToast("담당자 정보가 수정되었습니다.");
    } catch { onToast("오류: 담당자 수정 실패"); }
    finally { setSavingContact(false); }
  };

  const handleDeleteContact = async (c: Contact) => {
    if (!window.confirm(`"${c.name}" 담당자를 삭제(비활성)하시겠습니까?`)) return;
    try {
      const res = await fetch(api(`/api/admin/contacts/${c.id}`), { method: "DELETE", headers: authH });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      await load();
      onToast(data.softDeleted ? `"${c.name}" 담당자가 비활성 처리되었습니다.` : `"${c.name}" 담당자가 삭제되었습니다.`);
    } catch { onToast("오류: 담당자 삭제 실패"); }
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
      setDetail(prev => prev ? {
        ...prev,
        divisions: prev.divisions.map(d =>
          d.id === divId ? { ...d, name: data.name ?? editDivForm.name, type: data.type ?? editDivForm.type } : d
        ),
      } : prev);
      setEditDivId(null);
      onToast("수정되었습니다.");
      load();
    } catch { onToast("오류: 수정 실패"); }
  };

  const handleDeleteCompany = async (force = false) => {
    if (!force) {
      if (!confirm("이 거래처를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.")) return;
    } else {
      if (!confirm("연결된 담당자, 프로젝트 등 모든 데이터가 함께 삭제됩니다.\n정말 강제 삭제하시겠습니까?")) return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}${force ? "?force=true" : ""}`), {
        method: "DELETE", headers: authH,
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.canForceDelete) {
          setDeleteError(data.error);
          setDeleteCanForce(true);
        } else {
          setDeleteError(data.error ?? "삭제 실패");
        }
        return;
      }
      onToast("거래처가 삭제되었습니다.");
      onRefresh?.();
      onDeleted?.();
      onClose();
    } catch {
      setDeleteError("오류가 발생했습니다.");
    } finally {
      setDeleting(false);
    }
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
    <>
    <DraggableModal title={`거래처 #${companyId} 상세`} onClose={onClose} width={800} zIndex={300} bodyPadding="20px 28px"
      headerExtra={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <button onClick={() => handleDeleteCompany(false)} disabled={deleting}
            style={{ fontSize: 11, padding: "3px 10px", background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
            {deleting ? "삭제 중…" : "거래처 삭제"}
          </button>
          {deleteError && (
            <div style={{ fontSize: 11, color: "#dc2626", maxWidth: 240, textAlign: "right" }}>
              {deleteError}
              {deleteCanForce && (
                <button onClick={() => handleDeleteCompany(true)} disabled={deleting}
                  style={{ marginLeft: 6, fontSize: 11, padding: "2px 8px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 700 }}>
                  강제 삭제
                </button>
              )}
            </div>
          )}
        </div>
      }
    >
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
                    ["거래처 유형", (detail as any).companyType === "vendor" ? "외주업체" : "고객사", false],
                    ...((detail as any).vendorType ? [["외주 유형", VENDOR_TYPE_LABELS[(detail as any).vendorType] ?? (detail as any).vendorType, false] as [string, string, boolean]] : []),
                    ["사업자번호", detail.businessNumber ?? "-", false],
                    ["대표자명", detail.representativeName ?? "-", false],
                    ["등록일", (detail as any).registeredAt ?? "-", false],
                    ["대표전화", detail.phone ?? "-", false],
                    ["휴대폰", (detail as any).mobile ?? "-", false],
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
                {/* 1.5행: 거래처 유형 / 외주유형 */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8, background: "#f9fafb", borderRadius: 10, padding: "12px 14px", border: "1px solid #f3f4f6" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, display: "block", marginBottom: 6 }}>거래처 유형</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      {[
                        { v: "client", label: "고객사", bg: "#eff6ff", color: "#1d4ed8", border: "#93c5fd" },
                        { v: "vendor", label: "외주업체", bg: "#f5f3ff", color: "#7c3aed", border: "#c4b5fd" },
                      ].map(opt => (
                        <button key={opt.v} type="button"
                          onClick={() => setEditForm(p => ({ ...p, companyType: opt.v, vendorType: opt.v === "client" ? "" : p.vendorType }))}
                          style={{
                            padding: "6px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
                            background: editForm.companyType === opt.v ? opt.bg : "#fff",
                            color: editForm.companyType === opt.v ? opt.color : "#9ca3af",
                            border: `2px solid ${editForm.companyType === opt.v ? opt.border : "#e5e7eb"}`,
                            transition: "all 0.15s",
                          }}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {editForm.companyType === "vendor" && (
                    <div>
                      <label style={{ fontSize: 12, color: "#7c3aed", fontWeight: 600, display: "block", marginBottom: 4 }}>외주유형</label>
                      <ClickSelect value={editForm.vendorType} onChange={v => setEditForm(p => ({ ...p, vendorType: v }))}
                        style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8, borderColor: "#ddd6fe" }}
                        options={[{ value: "", label: "— 선택 안 함 —" }, ...VENDOR_TYPE_OPTIONS.map(o => ({ value: o.value, label: o.label }))]} />
                    </div>
                  )}
                </div>

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
                {/* 3행: 대표전화 / 휴대폰 / 이메일 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 12px" }}>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>대표전화</label>
                    <input value={editForm.phone} onChange={e => setEditForm(p => ({ ...p, phone: formatPhone(e.target.value) }))}
                      placeholder="02-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>휴대폰</label>
                    <input value={editForm.mobile} onChange={e => setEditForm(p => ({ ...p, mobile: formatPhone(e.target.value) }))}
                      placeholder="010-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 }}>이메일</label>
                    <input value={editForm.email} onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))}
                      placeholder="contact@company.com"
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: formErrors.email ? "#fca5a5" : undefined }} />
                    {formErrors.email && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.email}</p>}
                  </div>
                </div>
                {/* 3.5행: 웹사이트 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "0 12px" }}>
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

            {/* ── 담당자 목록 ───────────────────────────────────────────── */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20, marginBottom: 8 }}>
              <p style={{ ...sH, margin: 0, flex: 1 }}>
                담당자 ({detail.contacts.filter((c: Contact) => c.isActive).length}명
                {detail.contacts.some((c: Contact) => !c.isActive) && (
                  <span style={{ color: "#9ca3af", fontWeight: 400, marginLeft: 4 }}>
                    / 비활성 {detail.contacts.filter((c: Contact) => !c.isActive).length}명
                  </span>
                )})
              </p>
              {detail.contacts.some((c: Contact) => !c.isActive) && (
                <button onClick={() => setShowInactiveContacts(v => !v)}
                  style={{ background: "none", border: "1px solid #d1d5db", borderRadius: 6, padding: "3px 8px", fontSize: 11, cursor: "pointer", color: "#6b7280" }}>
                  {showInactiveContacts ? "비활성 숨기기" : "비활성 보기"}
                </button>
              )}
              <GhostBtn onClick={() => { setShowContactForm(v => !v); setEditContactId(null); }} style={{ fontSize: 12, padding: "4px 10px" }}>
                {showContactForm ? "닫기" : "+ 담당자 추가"}
              </GhostBtn>
            </div>

            {/* 안내 문구 */}
            <p style={{ fontSize: 11, color: "#9ca3af", margin: "0 0 10px" }}>
              기본 담당자는 거래처별 1명만 지정됩니다. 견적/청구 담당자는 중복 지정 가능합니다.
            </p>

            {/* 담당자 추가 폼 */}
            {showContactForm && (() => {
              const cf = contactForm; const setCf = setContactForm; const errs = contactFormErrors;
              return (
                <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
                  <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#0369a1" }}>신규 담당자 등록</p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 14px" }}>
                    <div style={{ gridColumn: "1/-1" }}>
                      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>담당자명 <span style={{ color: "#dc2626" }}>*</span></label>
                      <input value={cf.name} onChange={e => setCf(p => ({ ...p, name: e.target.value }))}
                        placeholder="예: 홍길동" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: errs.name ? "#fca5a5" : undefined }} />
                      {errs.name && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{errs.name}</p>}
                    </div>
                    {detail.divisions.length > 0 && (
                      <div style={{ gridColumn: "1/-1" }}>
                        <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 2 }}>브랜드 / 부서 연결</label>
                        <ClickSelect
                          value={String(cf.divisionId ?? "")}
                          onChange={val => setCf(p => ({ ...p, divisionId: val ? Number(val) : null }))}
                          options={[
                            { value: "", label: "— 본사 직접 —" },
                            ...detail.divisions.map((d: any) => ({ value: String(d.id), label: d.name + (d.type ? ` (${d.type})` : "") })),
                          ]}
                          style={{ width: "100%" }}
                          triggerStyle={{ width: "100%", border: "1px solid #e9d5ff", background: "#faf5ff", color: "#7c3aed", fontWeight: 600, fontSize: 13, padding: "7px 10px" }}
                          menuStyle={{ minWidth: "100%" }}
                        />
                      </div>
                    )}
                    <div>
                      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>부서</label>
                      <input value={cf.department} onChange={e => setCf(p => ({ ...p, department: e.target.value }))}
                        placeholder="예: 마케팅팀" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>직책</label>
                      <input value={cf.position} onChange={e => setCf(p => ({ ...p, position: e.target.value }))}
                        placeholder="예: 과장" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>휴대폰 <span style={{ color: "#9ca3af", fontSize: 11 }}>(권장)</span></label>
                      <input value={cf.mobile} onChange={e => setCf(p => ({ ...p, mobile: formatPhone(e.target.value) }))}
                        placeholder="예: 010-1234-5678" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: errs.mobile ? "#fca5a5" : undefined }} />
                      {errs.mobile && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{errs.mobile}</p>}
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>이메일 <span style={{ color: "#9ca3af", fontSize: 11 }}>(권장)</span></label>
                      <input value={cf.email} onChange={e => setCf(p => ({ ...p, email: e.target.value }))}
                        placeholder="예: hong@example.com" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: errs.email ? "#fca5a5" : undefined }} />
                      {errs.email && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{errs.email}</p>}
                    </div>
                    <div>
                      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>직장전화</label>
                      <input value={cf.officePhone} onChange={e => setCf(p => ({ ...p, officePhone: formatPhone(e.target.value) }))}
                        placeholder="예: 02-1234-5678" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                    </div>
                    <div style={{ gridColumn: "1/-1" }}>
                      <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>메모</label>
                      <textarea value={cf.memo} onChange={e => setCf(p => ({ ...p, memo: e.target.value }))}
                        rows={2} placeholder="특이사항 등" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", resize: "vertical" }} />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                    {([["isPrimary","기본 담당자"],["isQuoteContact","견적 담당자"],["isBillingContact","청구 담당자"],["isActive","활성 상태"]] as const).map(([key, label]) => (
                      <label key={key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer", color: "#374151" }}>
                        <input type="checkbox" checked={cf[key] as boolean} onChange={e => setCf(p => ({ ...p, [key]: e.target.checked }))} />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <PrimaryBtn onClick={handleAddContact} disabled={addingContact} style={{ fontSize: 13, padding: "7px 16px" }}>
                      {addingContact ? "추가 중..." : "담당자 추가"}
                    </PrimaryBtn>
                    <GhostBtn onClick={() => { setShowContactForm(false); setContactForm(emptyContactForm); setContactFormErrors({}); }} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                  </div>
                </div>
              );
            })()}

            {/* 담당자 카드 목록 */}
            {detail.contacts.filter((c: Contact) => c.isActive || showInactiveContacts).length === 0
              ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>등록된 담당자가 없습니다.</p>
              : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.contacts.filter((c: Contact) => c.isActive || showInactiveContacts).map((c: Contact) => (
                    editContactId === c.id ? (
                      /* ── 수정 폼 ─────────────────────────────────────────── */
                      <div key={c.id} style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10, padding: "14px 16px" }}>
                        <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#92400e" }}>담당자 수정</p>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 14px" }}>
                          <div style={{ gridColumn: "1/-1" }}>
                            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>담당자명 <span style={{ color: "#dc2626" }}>*</span></label>
                            <input value={editContactForm.name} onChange={e => setEditContactForm(p => ({ ...p, name: e.target.value }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: editContactErrors.name ? "#fca5a5" : undefined }} />
                            {editContactErrors.name && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{editContactErrors.name}</p>}
                          </div>
                          {detail.divisions.length > 0 && (
                            <div style={{ gridColumn: "1/-1" }}>
                              <label style={{ fontSize: 12, color: "#7c3aed", display: "block", marginBottom: 2 }}>브랜드 / 부서 연결</label>
                              <ClickSelect
                                value={String(editContactForm.divisionId ?? "")}
                                onChange={val => setEditContactForm(p => ({ ...p, divisionId: val ? Number(val) : null }))}
                                options={[
                                  { value: "", label: "— 본사 직접 —" },
                                  ...detail.divisions.map((d: any) => ({ value: String(d.id), label: d.name + (d.type ? ` (${d.type})` : "") })),
                                ]}
                                style={{ width: "100%" }}
                                triggerStyle={{ width: "100%", border: "1px solid #e9d5ff", background: "#faf5ff", color: "#7c3aed", fontWeight: 600, fontSize: 13, padding: "7px 10px" }}
                                menuStyle={{ minWidth: "100%" }}
                              />
                            </div>
                          )}
                          <div>
                            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>부서</label>
                            <input value={editContactForm.department} onChange={e => setEditContactForm(p => ({ ...p, department: e.target.value }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>직책</label>
                            <input value={editContactForm.position} onChange={e => setEditContactForm(p => ({ ...p, position: e.target.value }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>휴대폰</label>
                            <input value={editContactForm.mobile} onChange={e => setEditContactForm(p => ({ ...p, mobile: formatPhone(e.target.value) }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: editContactErrors.mobile ? "#fca5a5" : undefined }} />
                            {editContactErrors.mobile && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{editContactErrors.mobile}</p>}
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>이메일</label>
                            <input value={editContactForm.email} onChange={e => setEditContactForm(p => ({ ...p, email: e.target.value }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: editContactErrors.email ? "#fca5a5" : undefined }} />
                            {editContactErrors.email && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{editContactErrors.email}</p>}
                          </div>
                          <div>
                            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>직장전화</label>
                            <input value={editContactForm.officePhone} onChange={e => setEditContactForm(p => ({ ...p, officePhone: formatPhone(e.target.value) }))}
                              style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                          </div>
                          <div style={{ gridColumn: "1/-1" }}>
                            <label style={{ fontSize: 12, color: "#374151", display: "block", marginBottom: 2 }}>메모</label>
                            <textarea value={editContactForm.memo} onChange={e => setEditContactForm(p => ({ ...p, memo: e.target.value }))}
                              rows={2} style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", resize: "vertical" }} />
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                          {([["isPrimary","기본 담당자"],["isQuoteContact","견적 담당자"],["isBillingContact","청구 담당자"],["isActive","활성 상태"]] as const).map(([key, label]) => (
                            <label key={key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer", color: "#374151" }}>
                              <input type="checkbox" checked={editContactForm[key] as boolean} onChange={e => setEditContactForm(p => ({ ...p, [key]: e.target.checked }))} />
                              {label}
                            </label>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                          <PrimaryBtn onClick={handleSaveContact} disabled={savingContact} style={{ fontSize: 13, padding: "7px 16px" }}>
                            {savingContact ? "저장 중..." : "저장"}
                          </PrimaryBtn>
                          <GhostBtn onClick={() => { setEditContactId(null); setEditContactErrors({}); }} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
                          <button onClick={() => handleDeleteContact(c)}
                            style={{ marginLeft: "auto", background: "none", border: "1px solid #fca5a5", borderRadius: 7, padding: "7px 14px", fontSize: 13, cursor: "pointer", color: "#ef4444" }}>
                            삭제
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* ── 담당자 카드 (뷰 모드) ─────────────────────────────── */
                      <div key={c.id} style={{
                        padding: "12px 14px", background: c.isActive ? "#f9fafb" : "#f3f4f6",
                        borderRadius: 8, border: `1px solid ${c.isPrimary ? "#bfdbfe" : "#f3f4f6"}`,
                        opacity: c.isActive ? 1 : 0.65,
                      }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                              <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{c.name}</span>
                              {c.position && <span style={{ fontSize: 12, color: "#6b7280" }}>{c.position}</span>}
                              {c.department && <span style={{ fontSize: 12, color: "#9ca3af" }}>· {c.department}</span>}
                              {(c as any).divisionId && (() => { const div = detail.divisions.find((d: any) => d.id === (c as any).divisionId); return div ? <span style={{ fontSize: 11, background: "#ede9fe", color: "#7c3aed", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>{div.name}</span> : null; })()}
                              {!c.isActive && <span style={{ fontSize: 11, background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>비활성</span>}
                            </div>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: c.memo ? 6 : 0 }}>
                              {c.mobile && <span style={{ fontSize: 12, color: "#374151" }}>📱 {c.mobile}</span>}
                              {c.email && <span style={{ fontSize: 12, color: "#2563eb" }}>✉ {c.email}</span>}
                              {c.officePhone && <span style={{ fontSize: 12, color: "#374151" }}>☎ {c.officePhone}</span>}
                              {c.phone && !c.mobile && <span style={{ fontSize: 12, color: "#374151" }}>📞 {c.phone}</span>}
                            </div>
                            {c.memo && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6b7280" }}>{c.memo}</p>}
                            <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                              {c.isPrimary && <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 7px", fontWeight: 700 }}>기본</span>}
                              {c.isQuoteContact && <span style={{ fontSize: 11, background: "#d1fae5", color: "#065f46", borderRadius: 4, padding: "1px 7px", fontWeight: 700 }}>견적</span>}
                              {c.isBillingContact && <span style={{ fontSize: 11, background: "#ede9fe", color: "#5b21b6", borderRadius: 4, padding: "1px 7px", fontWeight: 700 }}>청구</span>}
                            </div>
                          </div>
                          <button onClick={() => handleEditContact(c)}
                            style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer", color: "#374151", whiteSpace: "nowrap" }}>
                            수정
                          </button>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              )
            }

            <p style={{ ...sH, marginTop: 20 }}>프로젝트 목록 ({detail.projects.length})</p>
            {detail.projects.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "10px 0" }}>등록된 프로젝트가 없습니다.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.projects.map(p => (
                  <div key={p.id} onClick={() => { onClose(); onOpenProject(p.id); }}
                    style={{ display: "flex", gap: 16, padding: "10px 14px", background: "#f9fafb", borderRadius: 8, fontSize: 13, cursor: "pointer", alignItems: "center", border: "1px solid transparent" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "#eff6ff"; (e.currentTarget as HTMLDivElement).style.borderColor = "#bfdbfe"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = "#f9fafb"; (e.currentTarget as HTMLDivElement).style.borderColor = "transparent"; }}>
                    <span style={{ color: "#9ca3af", minWidth: 36 }}>#{p.id}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: "#111827" }}>{p.title}</span>
                      {(p as any).requestingDivisionId && (() => { const div = detail.divisions.find((d: any) => d.id === (p as any).requestingDivisionId); return div ? <span style={{ marginLeft: 6, fontSize: 11, background: "#ede9fe", color: "#7c3aed", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>{div.name}</span> : null; })()}
                    </div>
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
    </DraggableModal>
    {selectedLedgerAccountId !== null && (
      <PrepaidLedgerModal
        accountId={selectedLedgerAccountId}
        authHeaders={{ Authorization: `Bearer ${token}` }}
        onClose={() => setSelectedLedgerAccountId(null)}
        onUpdate={load}
      />
    )}
    </>
  );
}
