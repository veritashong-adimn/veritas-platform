/**
 * CompanyForm — 거래처 등록/수정 공통 입력 폼.
 *
 * 등록(/admin/companies/new)과 수정(/admin/companies/:id/edit) 화면이 이 컴포넌트 하나를
 * mode="create" | "edit" 로만 분기해 공유한다. 두 화면의 입력 UI·Validation·레이아웃·AI 분석은
 * 완전히 동일하며, 서버 호출(POST/PATCH)만 mode 에 따라 달라진다.
 *
 * 이전에는 등록 폼(CompanyManagementTab)과 수정 폼(CompanyDetailModal)이 각각 중복 구현되어
 * 있었으나, 이 컴포넌트로 통합했다. (향후 담당자·프로젝트 등도 동일 패턴으로 확장)
 */
import React, { useEffect, useRef, useState } from "react";
import {
  api,
  VENDOR_TYPE_OPTIONS, VENDOR_TYPE_CATEGORY_CHIPS,
  resolveVendorType, finalVendorType,
  CUSTOMER_TYPE_OPTIONS, getCustomerTypeBadgeColors,
} from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { formatPhone } from "../../lib/utils";
import { CompanyDocumentAnalyzePanel, type CompanyOcrDocType } from "./CompanyDocumentAnalyzePanel";
import { CompanyAliasSection } from "./CompanyAliasSection";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

/** 거래처 폼 값 — 등록/수정 공통 */
export interface CompanyFormValues {
  name: string;
  businessNumber: string;
  representativeName: string;
  industry: string;
  businessCategory: string;
  address: string;
  email: string;
  mobile: string;
  notes: string;
  registeredAt: string;
  companyType: string;   // "client" | "vendor"
  vendorType: string;
  customerType: string;  // "CORPORATE" | "PUBLIC" | "INDIVIDUAL"
}

/** 신규 등록용 기본값 (등록일 = 오늘) */
export function emptyCompanyFormValues(): CompanyFormValues {
  return {
    name: "", businessNumber: "", representativeName: "",
    industry: "", businessCategory: "", address: "",
    email: "", mobile: "",
    notes: "", registeredAt: new Date().toISOString().slice(0, 10),
    companyType: "client", vendorType: "", customerType: "CORPORATE",
  };
}

/** 서버 상세 응답 → 폼 값 (수정 화면 초기값 구성) */
export function companyToFormValues(data: any): { values: CompanyFormValues; vendorTypeCustom: string } {
  const resolved = resolveVendorType(data?.vendorType ?? null);
  return {
    values: {
      name: data?.name ?? "",
      businessNumber: data?.businessNumber ?? "",
      representativeName: data?.representativeName ?? "",
      industry: data?.industry ?? "",
      businessCategory: data?.businessCategory ?? "",
      address: data?.address ?? "",
      email: data?.email ?? "",
      mobile: data?.mobile ?? "",
      notes: data?.notes ?? "",
      registeredAt: data?.registeredAt ?? "",
      companyType: data?.companyType ?? "client",
      vendorType: resolved.vendorType,
      customerType: data?.customerType ?? "CORPORATE",
    },
    vendorTypeCustom: resolved.vendorTypeCustom,
  };
}

type PersonCandidate = { source: string; id: number; name: string; companyId?: number; companyName?: string; email?: string; mobile?: string; roleLabel: string; matchReason?: string };
type SimilarCompany = { id: number; name: string; matchedDivisionName?: string | null };

interface CompanyFormProps {
  mode: "create" | "edit";
  token: string;
  onToast: (msg: string) => void;
  /** 저장 성공 시 (등록: 신규 id / 수정: 대상 id) */
  onSaved: (company: { id: number; name: string }) => void;
  onCancel: () => void;
  /** 수정 대상 id (mode="edit") */
  companyId?: number;
  /** 수정 초기값 (mode="edit") — 미제공 시 companyId 로 자체 로드 */
  initialValues?: CompanyFormValues;
  initialVendorTypeCustom?: string;
  /** 수정 초기 상호(변경 사유 필수 판단용) */
  originalName?: string;
  /** 유사 거래처/인물 후보 상세보기 */
  onOpenCompany?: (id: number) => void;
  onOpenTranslator?: (userId: number, email: string) => void;
}

export function CompanyForm({
  mode, token, onToast, onSaved, onCancel,
  companyId, initialValues, initialVendorTypeCustom = "", originalName = "",
  onOpenCompany, onOpenTranslator,
}: CompanyFormProps) {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [form, setForm] = useState<CompanyFormValues>(initialValues ?? emptyCompanyFormValues());
  const [vendorTypeCustom, setVendorTypeCustom] = useState(initialVendorTypeCustom);
  const [saving, setSaving] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [nameChangeReason, setNameChangeReason] = useState("");
  // 등록 화면 전용: 아직 거래처 id가 없으므로 별칭을 로컬 목록으로 모아두었다가 저장 직후 반영한다.
  const [aliasDrafts, setAliasDrafts] = useState<string[]>([]);

  // 메모 자동 확장(Auto Resize) — 기본은 낮게 시작하고 내용에 맞춰 최대 220px까지 늘어난다.
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [form.notes]);

  // AI 문서 자동입력
  const [licenseFile, setLicenseFile] = useState<File | null>(null);
  const [bankbookFile, setBankbookFile] = useState<File | null>(null);
  const [ocrPanel, setOcrPanel] = useState<CompanyOcrDocType | null>(null);
  const [dragOverType, setDragOverType] = useState<CompanyOcrDocType | null>(null);

  // 개인고객 기존 인물 후보 안내 모달 (등록 전용)
  const [personCandidateModal, setPersonCandidateModal] = useState<{ show: boolean; candidates: PersonCandidate[] } | null>(null);

  // 유사 거래처 안내 (등록 전용) — 이름 입력 시 서버 검색
  const [similarCompanies, setSimilarCompanies] = useState<SimilarCompany[]>([]);

  const isIndividual = form.companyType === "client" && form.customerType === "INDIVIDUAL";
  const nameChanged = mode === "edit" && form.name.trim() !== originalName && form.name.trim() !== "";

  // 수정 화면: initialValues 미제공 시 companyId 로 자체 로드
  useEffect(() => {
    if (mode !== "edit" || initialValues || companyId == null) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/companies/${companyId}`), { headers: authHeaders });
        const data = await res.json();
        if (!alive) return;
        if (!res.ok) { onToast(`오류: ${data?.error ?? "거래처 정보를 불러오지 못했습니다."}`); return; }
        const { values, vendorTypeCustom: vtc } = companyToFormValues(data);
        setForm(values);
        setVendorTypeCustom(vtc);
      } catch { if (alive) onToast("오류: 거래처 정보 불러오기 실패"); }
    })();
    return () => { alive = false; };
  }, [mode, companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 유사 거래처 검색 (등록 전용, 디바운스)
  useEffect(() => {
    if (mode !== "create") return;
    const q = form.name.trim();
    if (q.length < 2) { setSimilarCompanies([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(api(`/api/admin/companies?search=${encodeURIComponent(q)}&pageSize=3`), { headers: authHeaders });
        const data = await res.json();
        const rows: SimilarCompany[] = Array.isArray(data?.rows) ? data.rows : Array.isArray(data) ? data : [];
        setSimilarCompanies(rows.slice(0, 3));
      } catch { /* 유사 검색 실패는 무시 */ }
    }, 300);
    return () => clearTimeout(t);
  }, [mode, form.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── OCR 자동 반영 ──
  const applyLicenseOcr = (_fields: string[], values: Record<string, string>) => {
    setForm(prev => {
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
  const applyBankbookOcr = (_fields: string[], values: Record<string, string>) => {
    const parts = [
      values.bankName && `은행: ${values.bankName}`,
      values.accountHolder && `예금주: ${values.accountHolder}`,
      values.bankAccount && `계좌번호: ${values.bankAccount}`,
    ].filter(Boolean).join(" / ");
    if (parts) {
      setForm(prev => ({ ...prev, notes: prev.notes ? `${prev.notes}\n${parts}` : parts }));
      onToast("통장사본 정보가 메모에 추가되었습니다.");
    }
  };

  // ── Validation (등록·수정 공통) ──
  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = isIndividual ? "성명은 필수입니다." : "거래처명은 필수입니다.";
    if (form.businessNumber.trim()) {
      const bn = form.businessNumber.replace(/-/g, "");
      if (!/^\d{10}$/.test(bn)) errs.businessNumber = "사업자등록번호 형식: 000-00-00000";
    }
    if (mode === "edit" && nameChanged && !nameChangeReason.trim()) {
      errs.nameChangeReason = "상호 변경 시 변경 사유를 입력해주세요.";
    }
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // ── 저장 ──
  const doSubmit = async () => {
    setSaving(true);
    try {
      const body: Record<string, any> = { ...form, vendorType: finalVendorType(form.vendorType, vendorTypeCustom) };
      if (mode === "edit") {
        if (nameChanged) body.nameChangeReason = nameChangeReason.trim();
        const res = await fetch(api(`/api/admin/companies/${companyId}`), {
          method: "PATCH", headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) { onToast(`오류: ${data?.error ?? "수정 실패"}`); return; }
        onToast("거래처 정보가 수정되었습니다.");
        onSaved({ id: companyId!, name: data?.name ?? form.name });
      } else {
        const res = await fetch(api("/api/admin/companies"), {
          method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) { onToast(`오류: ${data?.error ?? "거래처 등록 실패"}`); return; }
        // 별칭 저장 — 기존 Alias API 재사용. 중복(정규화 동일)은 서버가 409로 걸러내므로 개별 실패는 무시.
        if (aliasDrafts.length > 0) {
          await Promise.all(aliasDrafts.map(name =>
            fetch(api(`/api/admin/companies/${data.id}/aliases`), {
              method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
              body: JSON.stringify({ aliasName: name }),
            }).catch(() => { /* 개별 별칭 실패는 무시(거래처 등록 자체는 성공) */ })
          ));
        }
        onToast("거래처가 등록되었습니다.");
        onSaved({ id: data.id, name: data.name });
      }
    } catch { onToast(mode === "edit" ? "오류: 수정 실패" : "오류: 거래처 등록 실패"); }
    finally { setSaving(false); }
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    // 개인고객 등록 시: 기존 인물 후보 안내 (차단 아님)
    if (mode === "create" && isIndividual) {
      const mobile = form.mobile?.trim().replace(/\D/g, "") || "";
      const email = form.email?.trim().toLowerCase() || "";
      if (mobile || email) {
        try {
          const params = new URLSearchParams();
          if (form.name.trim()) params.set("name", form.name.trim());
          if (mobile) params.set("mobile", mobile);
          if (email) params.set("email", email);
          const r = await fetch(api(`/api/admin/people/duplicate-candidates?${params}`), { headers: authHeaders });
          const d = await r.json();
          if (r.ok && Array.isArray(d.candidates) && d.candidates.length > 0) {
            setPersonCandidateModal({ show: true, candidates: d.candidates });
            return;
          }
        } catch { /* 후보 검색 실패는 무시하고 등록 진행 */ }
      }
    }
    await doSubmit();
  };

  const submitLabel = mode === "edit" ? "저장" : "거래처 등록";
  const savingLabel = mode === "edit" ? "저장 중..." : "등록 중...";

  return (
    <>
      {ocrPanel === "business_license" && licenseFile && (
        <CompanyDocumentAnalyzePanel
          file={licenseFile} docType="business_license" token={token} onToast={onToast}
          onClose={() => setOcrPanel(null)}
          onApplied={(fields, values) => { applyLicenseOcr(fields, values); setOcrPanel(null); }}
        />
      )}
      {ocrPanel === "bankbook" && bankbookFile && (
        <CompanyDocumentAnalyzePanel
          file={bankbookFile} docType="bankbook" token={token} onToast={onToast}
          onClose={() => setOcrPanel(null)}
          onApplied={(fields, values) => { applyBankbookOcr(fields, values); setOcrPanel(null); }}
        />
      )}

      {/* ── 개인고객 기존 인물 후보 안내 모달 (등록 전용) ── */}
      {personCandidateModal?.show && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 28px 22px", width: 520, maxWidth: "94vw", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", maxHeight: "82vh", overflowY: "auto" }}>
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>기존 인물 후보 {personCandidateModal.candidates.length}명 발견</div>
            </div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 18, paddingBottom: 14, borderBottom: "1px solid #f3f4f6" }}>
              등록은 가능하지만 기존 등록 여부를 확인하세요.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 22 }}>
              {personCandidateModal.candidates.map((c, i) => {
                const roleBg = c.source === "contact" ? "#eff6ff" : c.source === "translator" ? "#f5f3ff" : "#fff7ed";
                const roleColor = c.source === "contact" ? "#1d4ed8" : c.source === "translator" ? "#6d28d9" : "#c2410c";
                const roleBdr = c.source === "contact" ? "#bfdbfe" : c.source === "translator" ? "#ddd6fe" : "#fed7aa";
                const affiliation = c.source === "translator" ? "통번역사" : (c.companyName ?? "—");
                const matchLabel = c.matchReason === "name_mobile" ? "이름 + 휴대폰 일치"
                  : c.matchReason === "name_email" ? "이름 + 이메일 일치"
                  : c.matchReason === "mobile" ? "휴대폰 일치"
                  : c.matchReason === "email" ? "이메일 일치" : null;
                const handleView = () => {
                  setPersonCandidateModal(null);
                  if (c.source === "contact" && c.companyId != null) onOpenCompany?.(c.companyId);
                  else if (c.source === "individual_customer") onOpenCompany?.(c.id);
                  else if (c.source === "translator" && onOpenTranslator) onOpenTranslator(c.id, c.email ?? "");
                };
                const canView = c.source === "contact" ? c.companyId != null
                  : c.source === "individual_customer" ? true
                  : c.source === "translator" ? !!onOpenTranslator : false;
                return (
                  <div key={i} style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: roleBg, color: roleColor, border: `1px solid ${roleBdr}`, whiteSpace: "nowrap" }}>{c.roleLabel}</span>
                        {matchLabel && <span style={{ fontSize: 10, color: "#6b7280", background: "#f3f4f6", border: "1px solid #e5e7eb", padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>{matchLabel}</span>}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 8 }}>{c.name}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "3.2em 1fr", rowGap: 4, fontSize: 12 }}>
                        <span style={{ color: "#9ca3af", fontWeight: 500 }}>소속</span>
                        <span style={{ color: "#374151" }}>{affiliation}</span>
                        <span style={{ color: "#9ca3af", fontWeight: 500 }}>휴대폰</span>
                        <span style={{ color: "#374151" }}>{c.mobile ? formatPhone(c.mobile) : "—"}</span>
                        <span style={{ color: "#9ca3af", fontWeight: 500 }}>이메일</span>
                        <span style={{ color: "#374151", wordBreak: "break-all" }}>{c.email || "—"}</span>
                      </div>
                    </div>
                    {canView && (
                      <button onClick={handleView}
                        style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", background: "#fff", color: "#374151", border: "1px solid #d1d5db", whiteSpace: "nowrap", alignSelf: "flex-start" }}>
                        상세보기
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <GhostBtn onClick={() => setPersonCandidateModal(null)} style={{ fontSize: 13, padding: "7px 16px" }}>취소</GhostBtn>
              <button onClick={async () => { setPersonCandidateModal(null); await doSubmit(); }}
                style={{ padding: "7px 18px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", background: "#1d4ed8", color: "#fff", border: "none" }}>
                계속 등록
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

        {/* ── Card 1: AI 문서 자동입력 (기업고객 / 외주업체만) ── */}
        {!isIndividual && (() => {
          const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".pdf"];
          const handleDocDrop = (dt: CompanyOcrDocType, rawFile: File) => {
            const ext = rawFile.name.slice(rawFile.name.lastIndexOf(".")).toLowerCase();
            if (!ALLOWED_EXTS.includes(ext)) { onToast("JPG, PNG, PDF 형식만 업로드할 수 있습니다."); return; }
            if (dt === "business_license") setLicenseFile(rawFile); else setBankbookFile(rawFile);
          };
          return (
            <div style={{ background: "#fff", border: "1px solid #bae6fd", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(14,165,233,0.08)" }}>
              <div style={{ background: "#f0f9ff", padding: "9px 16px", borderBottom: "1px solid #bae6fd", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 17 }}>✨</span>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#0369a1" }}>AI 문서 자동입력</p>
              </div>
              <div style={{ padding: "12px 16px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {(["business_license", "bankbook"] as const).map(dt => {
                    const isLicense = dt === "business_license";
                    const file = isLicense ? licenseFile : bankbookFile;
                    const setFile = isLicense ? setLicenseFile : setBankbookFile;
                    const icon = isLicense ? "📄" : "🏦";
                    const label = isLicense ? "사업자등록증" : "통장사본";
                    const isDragging = dragOverType === dt;
                    return (
                      <div key={dt}
                        onDragOver={e => { e.preventDefault(); setDragOverType(dt); }}
                        onDragEnter={e => { e.preventDefault(); setDragOverType(dt); }}
                        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverType(null); }}
                        onDrop={e => { e.preventDefault(); setDragOverType(null); const dropped = e.dataTransfer.files?.[0]; if (dropped) handleDocDrop(dt, dropped); }}
                        style={{ background: isDragging ? "#e0f2fe" : "#f8fafc", borderRadius: 10, border: isDragging ? "2px dashed #0284c7" : "1.5px solid #e0f2fe", padding: "10px 12px", transition: "border-color 0.15s, background 0.15s" }}>
                        <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: isDragging ? "#0284c7" : "#0369a1" }}>{icon} {label}</p>
                        {!file && (
                          <div style={{ marginBottom: 8, padding: "8px", borderRadius: 8, border: `1.5px dashed ${isDragging ? "#0284c7" : "#93c5fd"}`, background: isDragging ? "#bae6fd" : "#f0f9ff", textAlign: "center", transition: "all 0.15s" }}>
                            <p style={{ margin: 0, fontSize: 11, color: isDragging ? "#0369a1" : "#7dd3fc", fontWeight: isDragging ? 700 : 400 }}>
                              {isDragging ? "여기에 파일을 놓으세요" : "파일 드래그 또는"} <span style={{ fontSize: 10, color: "#93c5fd" }}>PDF·JPG·PNG</span>
                            </p>
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
          <div style={{ padding: "10px 16px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 3, height: 18, background: "#6366f1", borderRadius: 2, display: "inline-block", flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>거래처 기본정보</p>
          </div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 11 }}>

            {/* 거래처 유형 + 분류 — 라벨/버튼을 한 행에 배치해 세로 공간 압축 */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", whiteSpace: "nowrap" }}>
                  거래처 유형 <span style={{ color: "#dc2626" }}>*</span>
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  {[
                    { v: "client", label: "고객사", icon: "🏢", color: "#1d4ed8", bg: "#dbeafe", border: "#3b82f6", ring: "#3b82f620" },
                    { v: "vendor", label: "외주업체", icon: "🔧", color: "#6d28d9", bg: "#ede9fe", border: "#7c3aed", ring: "#7c3aed20" },
                  ].map(opt => (
                    <button key={opt.v} type="button"
                      onClick={() => setForm(p => ({ ...p, companyType: opt.v, vendorType: "", customerType: "CORPORATE" }))}
                      style={{
                        padding: "5px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer",
                        transition: "all 0.15s", lineHeight: "20px",
                        background: form.companyType === opt.v ? opt.bg : "#f9fafb",
                        color: form.companyType === opt.v ? opt.color : "#9ca3af",
                        border: `2px solid ${form.companyType === opt.v ? opt.border : "#e5e7eb"}`,
                        boxShadow: form.companyType === opt.v ? `0 0 0 3px ${opt.ring}` : "none",
                      }}>
                      {opt.icon} {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* 2차: 고객 분류 (고객사 선택 시) — 별도 제목 없이 유형 아래로 자연스럽게 이어지는 인라인 배치 */}
              {form.companyType === "client" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6, paddingLeft: 12, borderLeft: "3px solid #93c5fd" }}>
                  {CUSTOMER_TYPE_OPTIONS.map(opt => {
                    const isActive = form.customerType === opt.value;
                    const { bg, color, border } = getCustomerTypeBadgeColors(opt.value);
                    return (
                      <button key={opt.value} type="button"
                        onClick={() => setForm(p => ({ ...p, customerType: opt.value }))}
                        style={{
                          padding: "5px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700,
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
              )}
              {/* 2차: 외주 분류 (외주업체 선택 시) — 별도 제목 없이 유형 아래로 이어지는 인라인 배치 */}
              {form.companyType === "vendor" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6, paddingLeft: 12, borderLeft: "2px solid #c4b5fd" }}>
                  <ClickSelect
                    value={form.vendorType}
                    onChange={v => { setForm(p => ({ ...p, vendorType: v })); if (v !== "etc") setVendorTypeCustom(""); }}
                    triggerStyle={{ fontSize: 13, padding: "5px 10px", minWidth: 160, borderRadius: 8, borderColor: "#ddd6fe" }}
                    chips={VENDOR_TYPE_CATEGORY_CHIPS}
                    options={[{ value: "", label: "선택 안 함" }, ...VENDOR_TYPE_OPTIONS]}
                  />
                  {form.vendorType === "etc" && (
                    <input value={vendorTypeCustom} onChange={e => setVendorTypeCustom(e.target.value)}
                      placeholder="기타 외주유형 직접 입력" aria-label="기타 외주유형 직접 입력"
                      style={{ ...inputStyle, width: "auto", flex: "1 1 200px", borderColor: "#ddd6fe", color: "#7c3aed" }} />
                  )}
                </div>
              )}
            </div>

            {/* 거래처명 + 별칭 — 한 행 배치(6:4). 별칭 여러 개(Tag)여도 레이아웃 유지. 좁은 화면 자동 줄바꿈. */}
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "3 1 300px", minWidth: 0 }}>
              <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>
                {isIndividual ? "성명" : "거래처명"} <span style={{ color: "#dc2626" }}>*</span>
              </label>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder={isIndividual ? "홍길동" : "(주)아크로네이처"}
                style={{ ...inputStyle, borderColor: formErrors.name ? "#fca5a5" : inputStyle.border as string }} />
              {formErrors.name && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.name}</p>}

              {/* 등록: 유사 거래처 안내 */}
              {mode === "create" && similarCompanies.length > 0 && (
                <div style={{ marginTop: 6, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8 }}>
                  <p style={{ margin: "0 0 5px", fontSize: 11, fontWeight: 700, color: "#92400e" }}>⚠ 유사 거래처가 이미 등록되어 있습니다</p>
                  {similarCompanies.map(c => (
                    <div key={c.id} style={{ fontSize: 12, color: "#78350f", marginTop: 2 }}>
                      <button type="button" onClick={() => onOpenCompany?.(c.id)}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "#b45309", fontWeight: 700, padding: 0, textDecoration: "underline", fontSize: 12 }}>
                        {c.name}{c.matchedDivisionName ? `(${c.matchedDivisionName})` : ""}
                      </button>
                      <span style={{ color: "#92400e", marginLeft: 6 }}>→ 클릭하면 상세보기</span>
                    </div>
                  ))}
                </div>
              )}

              {/* 수정: 상호 변경 안내 + 변경 사유(필수) */}
              {nameChanged && (
                <div style={{ marginTop: 8, padding: "10px 12px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8 }}>
                  <p style={{ margin: "0 0 8px", fontSize: 12, color: "#92400e" }}>
                    <strong>{originalName}</strong> → <strong>{form.name.trim()}</strong>
                    <br />이전 상호는 변경 이력으로 자동 저장됩니다.
                  </p>
                  <label style={{ fontSize: 12, color: "#92400e", fontWeight: 700, display: "block", marginBottom: 3 }}>변경 사유 <span style={{ color: "#dc2626" }}>*</span></label>
                  <input value={nameChangeReason} onChange={e => setNameChangeReason(e.target.value)}
                    placeholder="예: 법인 상호 변경, 오탈자 수정"
                    style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", borderColor: formErrors.nameChangeReason ? "#fca5a5" : "#fcd34d" }} />
                  {formErrors.nameChangeReason && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.nameChangeReason}</p>}
                </div>
              )}
              </div>

              {/* 별칭(Alias) — 거래처명 옆(6:4). 등록=로컬 draft, 수정=서버 즉시 CRUD. 상세와 동일 컴포넌트(compact) 재사용. */}
              <div style={{ flex: "2 1 240px", minWidth: 0 }}>
                <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>
                  별칭(Alias) <span style={{ color: "#9ca3af", fontWeight: 500, fontSize: 12 }}>(선택)</span>
                </label>
                {mode === "edit" && companyId != null ? (
                  <CompanyAliasSection companyId={companyId} token={token} onToast={onToast} compact />
                ) : (
                  <CompanyAliasSection token={token} onToast={onToast} value={aliasDrafts} onChange={setAliasDrafts} compact />
                )}
              </div>
            </div>

            {/* 개인고객: 휴대폰 / 이메일 */}
            {isIndividual && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
                <div>
                  <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>휴대폰</label>
                  <input value={form.mobile} onChange={e => setForm(p => ({ ...p, mobile: e.target.value }))}
                    placeholder="010-0000-0000" style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>이메일</label>
                  <input type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                    placeholder="name@example.com" style={inputStyle} />
                </div>
              </div>
            )}

            {/* 기업고객 / 외주업체: 사업자등록번호 / 대표자명 / 등록일 */}
            {!isIndividual && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 14px" }}>
                <div>
                  <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>사업자등록번호</label>
                  <input value={form.businessNumber} onChange={e => setForm(p => ({ ...p, businessNumber: e.target.value }))}
                    placeholder="000-00-00000"
                    style={{ ...inputStyle, borderColor: formErrors.businessNumber ? "#fca5a5" : inputStyle.border as string }} />
                  {formErrors.businessNumber && <p style={{ margin: "2px 0 0", fontSize: 11, color: "#dc2626" }}>{formErrors.businessNumber}</p>}
                </div>
                <div>
                  <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>대표자명</label>
                  <input value={form.representativeName} onChange={e => setForm(p => ({ ...p, representativeName: e.target.value }))}
                    placeholder="홍길동" style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>등록일</label>
                  <input type="date" value={form.registeredAt} onChange={e => setForm(p => ({ ...p, registeredAt: e.target.value }))}
                    style={inputStyle} />
                </div>
              </div>
            )}

            {/* 개인고객: 등록일 (단독 행) */}
            {isIndividual && (
              <div>
                <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>등록일</label>
                <input type="date" value={form.registeredAt} onChange={e => setForm(p => ({ ...p, registeredAt: e.target.value }))}
                  style={inputStyle} />
              </div>
            )}

            {/* 기업고객 / 외주업체: 업태 / 종목 */}
            {!isIndividual && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
                <div>
                  <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>업태</label>
                  <input value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))}
                    placeholder="제조업, 서비스업 등" style={inputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>종목</label>
                  <input value={form.businessCategory} onChange={e => setForm(p => ({ ...p, businessCategory: e.target.value }))}
                    placeholder="통역, 번역, 소프트웨어 등" style={inputStyle} />
                </div>
              </div>
            )}

            {/* 주소 */}
            <div>
              <label style={{ fontSize: 14, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>주소</label>
              <input value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
                placeholder="서울시 강남구 테헤란로 123" style={inputStyle} />
            </div>

          </div>
        </div>

        {/* ── Card 3: 메모 ── */}
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid #f3f4f6", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 3, height: 18, background: "#6366f1", borderRadius: 2, display: "inline-block", flexShrink: 0 }} />
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>메모</p>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>(선택)</span>
          </div>
          <div style={{ padding: "12px 16px" }}>
            <textarea ref={notesRef} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              rows={2} placeholder="거래처 관련 특이사항을 입력하세요."
              style={{ ...inputStyle, resize: "none", overflow: "hidden", minHeight: 40 }} />
          </div>
        </div>

        {/* ── 액션 버튼 ── */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <GhostBtn onClick={onCancel} style={{ fontSize: 14, padding: "9px 18px" }} data-testid="btn-company-form-cancel">취소</GhostBtn>
          <PrimaryBtn onClick={handleSubmit} disabled={saving || !form.name.trim()} style={{ fontSize: 14, padding: "9px 24px" }}
            data-testid="btn-company-form-submit">
            {saving ? savingLabel : submitLabel}
          </PrimaryBtn>
        </div>

      </div>
    </>
  );
}
