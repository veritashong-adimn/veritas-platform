import React, { useState, useEffect } from "react";
import { api, Company, ContactDetail, Division } from "../../lib/constants";
import { formatPhone } from "../../lib/utils";
import { DraggableModal } from "./DraggableModal";
import { PrimaryBtn, GhostBtn } from "../ui";
import { ContactDocumentAnalyzePanel } from "./ContactDocumentAnalyzePanel";

// ─── 공통 스타일 ────────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const fieldLabel: React.CSSProperties = {
  fontSize: 13, fontWeight: 600, color: "#374151", display: "block", marginBottom: 5,
};
const errorText: React.CSSProperties = {
  margin: "3px 0 0", fontSize: 12, color: "#dc2626",
};
const cardStyle: React.CSSProperties = {
  background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb",
  padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14,
};
const cardTitle: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: "#111827",
  borderLeft: "3px solid #6366f1", paddingLeft: 10, margin: "0 0 4px",
};

// ─── 타입 ────────────────────────────────────────────────────────────────────
type FormData = {
  companyId: number | null;
  divisionId: number | null;
  name: string;
  department: string;
  position: string;
  mobile: string;
  email: string;
  officePhone: string;
  memo: string;
  isPrimary: boolean;
  isQuoteContact: boolean;
  isBillingContact: boolean;
  isActive: boolean;
};

type Props =
  | {
      mode: "create";
      token: string;
      companies: Company[];
      onClose: () => void;
      onSuccess: () => void;
      onToast: (msg: string) => void;
      contactId?: never;
      initialData?: never;
    }
  | {
      mode: "edit";
      token: string;
      contactId: number;
      initialData: ContactDetail;
      onClose: () => void;
      onSuccess: () => void;
      onToast: (msg: string) => void;
      companies?: never;
    };

const emptyForm: FormData = {
  companyId: null, divisionId: null,
  name: "", department: "", position: "",
  mobile: "", email: "", officePhone: "",
  memo: "", isPrimary: false, isQuoteContact: false,
  isBillingContact: false, isActive: true,
};

// ─── 컴포넌트 ────────────────────────────────────────────────────────────────
export function ContactFormModal({ mode, token, companies, contactId, initialData, onClose, onSuccess, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const [form, setForm] = useState<FormData>(() => {
    if (mode === "edit" && initialData) {
      return {
        companyId: initialData.companyId,
        divisionId: initialData.divisionId ?? null,
        name: initialData.name ?? "",
        department: initialData.department ?? "",
        position: initialData.position ?? "",
        mobile: initialData.mobile ? formatPhone(initialData.mobile) : "",
        email: initialData.email ?? "",
        officePhone: initialData.officePhone ? formatPhone(initialData.officePhone) : "",
        memo: initialData.memo ?? "",
        isPrimary: initialData.isPrimary ?? false,
        isQuoteContact: initialData.isQuoteContact ?? false,
        isBillingContact: initialData.isBillingContact ?? false,
        isActive: initialData.isActive ?? true,
      };
    }
    return { ...emptyForm };
  });

  type CrossCompanyDup = { id: number; name: string; companyName: string; mobile: string | null; email: string | null };
  type WarningState =
    | { kind: "same_company"; message: string }
    | { kind: "cross_company"; message: string; duplicates: CrossCompanyDup[] };

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<WarningState | null>(null);

  // ── 거래처 검색 (create 전용) ─────────────────────────────────────────────
  const [companyQuery, setCompanyQuery] = useState("");
  const [divisions, setDivisions] = useState<Division[]>([]);

  // ── AI 분석 상태 ──────────────────────────────────────────────────────────
  const [aiFile, setAiFile] = useState<File | null>(null);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiDragOver, setAiDragOver] = useState(false);
  const ALLOWED_EXTS = [".jpg", ".jpeg", ".png", ".pdf"];

  // edit 모드: 마운트 시 division 목록 로드
  useEffect(() => {
    if (mode === "edit" && initialData?.companyId) {
      fetch(api(`/api/admin/companies/${initialData.companyId}/divisions`), { headers: authH })
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setDivisions(d); })
        .catch(() => { /* ignore */ });
    }
  }, [mode, initialData?.companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setF = <K extends keyof FormData>(k: K, v: FormData[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  // ── 파일 처리 ─────────────────────────────────────────────────────────────
  const handleAiFile = (rawFile: File) => {
    const ext = rawFile.name.slice(rawFile.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) { onToast("JPG, PNG, PDF 형식만 업로드할 수 있습니다."); return; }
    setAiFile(rawFile);
  };

  // ── AI 결과 반영 ──────────────────────────────────────────────────────────
  const handleAiApplied = (values: Record<string, string | null | undefined>) => {
    setForm(prev => {
      const next = { ...prev };
      if (values.contactName) next.name = values.contactName;
      if (values.department) next.department = values.department;
      if (values.position) next.position = values.position;
      if (values.email) next.email = values.email;
      if (values.mobilePhone) next.mobile = formatPhone(values.mobilePhone);
      if (values.officePhone) next.officePhone = formatPhone(values.officePhone);
      if (values.memo) next.memo = values.memo;
      return next;
    });

    // 거래처 자동 매칭 (create 모드 + 회사명 추출 시)
    if (mode === "create" && values.companyName && form.companyId === null) {
      const extracted = (values.companyName as string).toLowerCase();
      const matched = (companies ?? []).find(c => {
        const name = c.name.toLowerCase();
        return name.includes(extracted) || extracted.includes(name);
      });
      if (matched) {
        setForm(prev => ({ ...prev, companyId: matched.id }));
        setCompanyQuery(matched.name);
        loadDivisions(matched.id);
        onToast(`거래처 자동 매칭: "${matched.name}"`);
      } else {
        // 이메일 도메인으로 추가 매칭 시도
        if (values.email) {
          const domain = (values.email as string).split("@")[1]?.toLowerCase() ?? "";
          const domainMatch = domain
            ? (companies ?? []).find(c =>
                c.name.toLowerCase().replace(/[\s\(\)\(주\)(주)]/g, "").includes(
                  domain.split(".")[0]
                )
              )
            : null;
          if (domainMatch) {
            setForm(prev => ({ ...prev, companyId: domainMatch.id }));
            setCompanyQuery(domainMatch.name);
            loadDivisions(domainMatch.id);
            onToast(`이메일 도메인으로 거래처 추천: "${domainMatch.name}"`);
          } else {
            setCompanyQuery(values.companyName as string);
          }
        } else {
          setCompanyQuery(values.companyName as string);
        }
      }
    }

    onToast("AI 분석 결과가 폼에 자동 반영되었습니다.");
  };

  // ── 검증 ─────────────────────────────────────────────────────────────────
  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (mode === "create" && !form.companyId) errs.companyId = "거래처를 선택해주세요.";
    if (!form.name.trim()) errs.name = "담당자명은 필수입니다.";
    if (mode === "create" && !form.mobile.trim() && !form.email.trim())
      errs.mobile = "휴대폰 또는 이메일 중 하나 이상 입력해주세요.";
    if (form.email.trim() && !emailRe.test(form.email.trim()))
      errs.email = "이메일 형식이 올바르지 않습니다.";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // ── 저장 ─────────────────────────────────────────────────────────────────
  const save = async (force = false) => {
    if (!validate()) return;
    setSaving(true);
    try {
      const body = {
        companyId: form.companyId,
        divisionId: form.divisionId ?? null,
        name: form.name.trim(),
        department: form.department.trim() || null,
        position: form.position.trim() || null,
        mobile: form.mobile.trim() || null,
        email: form.email.trim() || null,
        officePhone: form.officePhone.trim() || null,
        memo: form.memo.trim() || null,
        isPrimary: form.isPrimary,
        isQuoteContact: form.isQuoteContact,
        isBillingContact: form.isBillingContact,
        isActive: form.isActive,
        ...(mode === "create" && force ? { force: true } : {}),
      };

      const res = await fetch(
        mode === "create"
          ? api("/api/admin/contacts")
          : api(`/api/admin/contacts/${contactId}`),
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { ...authH, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json();

      if (mode === "create" && res.status === 409) {
        onToast("오류: 동일한 휴대폰 번호의 담당자가 이미 존재합니다.");
        return;
      }
      if (mode === "create" && res.status === 200 && data.warning) {
        if (data.type === "cross_company_duplicate") {
          setWarning({ kind: "cross_company", message: data.message, duplicates: data.duplicates ?? [] });
        } else {
          setWarning({ kind: "same_company", message: data.message });
        }
        return;
      }
      if (!res.ok) {
        setErrors({ _server: data.error ?? "저장에 실패했습니다." });
        return;
      }

      onToast(mode === "create" ? "담당자가 등록되었습니다." : "담당자 정보가 수정되었습니다.");
      onSuccess();
      onClose();
    } catch {
      setErrors({ _server: "저장 중 오류가 발생했습니다." });
    } finally {
      setSaving(false);
    }
  };

  // ── 거래처 선택 ───────────────────────────────────────────────────────────
  const loadDivisions = async (cId: number) => {
    try {
      const res = await fetch(api(`/api/admin/companies/${cId}/divisions`), { headers: authH });
      if (res.ok) { const d = await res.json(); setDivisions(Array.isArray(d) ? d : []); }
    } catch { /* ignore */ }
  };

  const title = mode === "create" ? "담당자 등록" : "담당자 수정";
  const submitLabel = saving
    ? (mode === "create" ? "등록 중..." : "저장 중...")
    : (mode === "create" ? "담당자 등록" : "담당자 수정");

  return (
    <>
      {/* AI 분석 패널 */}
      {showAiPanel && aiFile && (
        <ContactDocumentAnalyzePanel
          file={aiFile}
          token={token}
          onToast={onToast}
          onClose={() => setShowAiPanel(false)}
          onApplied={handleAiApplied}
        />
      )}

      <DraggableModal
        title={title}
        subtitle={mode === "create" ? "하나의 거래처에 여러 명의 담당자를 등록할 수 있습니다." : undefined}
        onClose={onClose}
        width={860}
        height="90vh"
        zIndex={1000}
        bodyPadding="20px 28px"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ══ [1] AI 자동입력 Card (create 전용) ══ */}
          {mode === "create" && (
            <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 12, padding: "16px 20px" }}>
              <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 700, color: "#0369a1" }}>
                📇 AI 담당자 자동입력
              </p>
              <p style={{ margin: "0 0 12px", fontSize: 12, color: "#6b7280" }}>
                명함, 이메일 서명, PDF를 업로드하면 AI가 담당자 정보를 자동 추출합니다. (JPG, PNG, PDF)
              </p>

              {/* 드래그 앤 드롭 영역 */}
              <div
                onDragOver={e => { e.preventDefault(); setAiDragOver(true); }}
                onDragEnter={e => { e.preventDefault(); setAiDragOver(true); }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setAiDragOver(false); }}
                onDrop={e => { e.preventDefault(); setAiDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleAiFile(f); }}
                style={{
                  border: `2px dashed ${aiDragOver ? "#38bdf8" : "#bae6fd"}`,
                  borderRadius: 10,
                  padding: "16px 20px",
                  background: aiDragOver ? "#e0f2fe" : "#fff",
                  transition: "all 0.15s",
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: 1, minWidth: 160 }}>
                  {aiFile ? (
                    <p style={{ margin: 0, fontSize: 13, color: "#0284c7", fontWeight: 600 }}>
                      ✓ {aiFile.name}
                    </p>
                  ) : (
                    <p style={{ margin: 0, fontSize: 13, color: "#94a3b8" }}>
                      {aiDragOver ? "파일을 여기에 놓으세요" : "명함 또는 이메일 서명 이미지를 드래그하세요"}
                    </p>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <label style={{ cursor: "pointer" }}>
                    <input type="file" accept=".jpg,.jpeg,.png,.pdf" style={{ display: "none" }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleAiFile(f); e.target.value = ""; }} />
                    <span style={{ fontSize: 12, padding: "6px 14px", background: "#e0f2fe", color: "#0369a1", borderRadius: 7, fontWeight: 600, whiteSpace: "nowrap" }}>
                      파일 선택
                    </span>
                  </label>
                  {aiFile && (
                    <button type="button" onClick={() => setShowAiPanel(true)}
                      style={{ fontSize: 13, padding: "6px 16px", background: "#0284c7", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontWeight: 700, whiteSpace: "nowrap" }}>
                      AI 분석
                    </button>
                  )}
                  {aiFile && (
                    <button type="button" onClick={() => setAiFile(null)}
                      style={{ fontSize: 12, padding: "6px 10px", background: "none", color: "#9ca3af", border: "1px solid #e5e7eb", borderRadius: 7, cursor: "pointer" }}>
                      제거
                    </button>
                  )}
                </div>
              </div>

              {/* 지원 문서 안내 */}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {["종이 명함", "이메일 서명 캡처", "Outlook/Gmail PDF", "연락처 이미지"].map(t => (
                  <span key={t} style={{ fontSize: 11, background: "#e0f2fe", color: "#0369a1", borderRadius: 6, padding: "2px 8px", fontWeight: 600 }}>{t}</span>
                ))}
              </div>
            </div>
          )}

          {/* ══ [2] 거래처 선택 Card ══ */}
          <div style={cardStyle}>
            <p style={cardTitle}>거래처 선택</p>

            {mode === "create" ? (
              <div>
                {form.companyId === null ? (
                  <>
                    <label style={fieldLabel}>거래처 <span style={{ color: "#dc2626" }}>*</span></label>
                    <input
                      value={companyQuery}
                      onChange={e => { setCompanyQuery(e.target.value); setF("companyId", null); }}
                      placeholder="회사명, 브랜드명 검색..."
                      style={{ ...inputStyle, marginBottom: 6, borderColor: errors.companyId ? "#fca5a5" : undefined }}
                    />
                    {errors.companyId && <p style={errorText}>{errors.companyId}</p>}
                    {companyQuery.trim() && (
                      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, maxHeight: 180, overflowY: "auto", background: "#fff", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
                        {(() => {
                          const q = companyQuery.toLowerCase();
                          const filtered = (companies ?? []).filter(c =>
                            c.name.toLowerCase().includes(q) ||
                            (c.divisionNames ?? []).some(d => d.toLowerCase().includes(q)) ||
                            (c.businessNumber ?? "").replace(/-/g, "").includes(q.replace(/-/g, ""))
                          ).slice(0, 10);
                          if (filtered.length === 0) return (
                            <p style={{ padding: "12px 14px", color: "#9ca3af", fontSize: 13, margin: 0 }}>검색 결과가 없습니다.</p>
                          );
                          return filtered.map(c => {
                            const matchedDiv = (c.divisionNames ?? []).find(d => d.toLowerCase().includes(q));
                            return (
                              <div key={c.id}
                                onClick={async () => {
                                  setF("companyId", c.id);
                                  setF("divisionId", null);
                                  setCompanyQuery(c.name);
                                  setDivisions([]);
                                  await loadDivisions(c.id);
                                }}
                                style={{ padding: "9px 14px", cursor: "pointer", fontSize: 13, color: "#111827", borderBottom: "1px solid #f9fafb" }}
                                onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
                                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                                <span style={{ fontWeight: 600 }}>{c.name}</span>
                                {matchedDiv && <span style={{ color: "#7c3aed", fontWeight: 700, marginLeft: 4 }}>({matchedDiv})</span>}
                                {c.businessNumber && <span style={{ color: "#9ca3af", marginLeft: 8, fontSize: 12 }}>{c.businessNumber}</span>}
                              </div>
                            );
                          });
                        })()}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ padding: "10px 14px", background: "#eff6ff", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
                    <span style={{ color: "#1d4ed8", fontWeight: 600 }}>✓ {companyQuery}</span>
                    <button onClick={() => { setF("companyId", null); setF("divisionId", null); setCompanyQuery(""); setDivisions([]); }}
                      style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 12 }}>변경</button>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label style={fieldLabel}>거래처</label>
                <div style={{ padding: "10px 14px", background: "#f3f4f6", borderRadius: 8, fontSize: 14, color: "#6b7280", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, color: "#374151" }}>{initialData!.companyName ?? "-"}</span>
                  <span style={{ fontSize: 12, color: "#9ca3af" }}>(변경 불가)</span>
                </div>
              </div>
            )}

            {/* 브랜드/부서 */}
            {(form.companyId !== null || mode === "edit") && (
              <div>
                <label style={fieldLabel}>
                  브랜드/부서 <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}>(선택)</span>
                </label>
                {divisions.length === 0 ? (
                  <div style={{ padding: "9px 12px", background: "#f9fafb", borderRadius: 7, fontSize: 13, color: "#9ca3af", border: "1px solid #f3f4f6" }}>
                    {mode === "edit" && initialData!.divisionName
                      ? `현재: ${initialData!.divisionName} (변경 불가 — 브랜드/부서 없음)`
                      : "이 거래처에 등록된 브랜드/부서가 없습니다."}
                  </div>
                ) : (
                  <select value={form.divisionId ?? ""}
                    onChange={e => setF("divisionId", e.target.value ? Number(e.target.value) : null)}
                    style={{ ...inputStyle }}>
                    <option value="">선택 안 함 (거래처 전체 소속)</option>
                    {divisions.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>

          {/* ══ [3] 기본 정보 Card ══ */}
          <div style={cardStyle}>
            <p style={cardTitle}>담당자 기본 정보</p>

            {/* 담당자명 */}
            <div>
              <label style={fieldLabel}>담당자명 <span style={{ color: "#dc2626" }}>*</span></label>
              <input
                value={form.name}
                onChange={e => setF("name", e.target.value)}
                placeholder="예: 홍길동"
                style={{ ...inputStyle, borderColor: errors.name ? "#fca5a5" : undefined }}
              />
              {errors.name && <p style={errorText}>{errors.name}</p>}
            </div>

            {/* 부서 / 직책 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
              <div>
                <label style={fieldLabel}>부서</label>
                <input value={form.department} onChange={e => setF("department", e.target.value)}
                  placeholder="예: 마케팅팀" style={inputStyle} />
              </div>
              <div>
                <label style={fieldLabel}>직책</label>
                <input value={form.position} onChange={e => setF("position", e.target.value)}
                  placeholder="예: 과장" style={inputStyle} />
              </div>
            </div>

            {/* 휴대폰 / 이메일 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
              <div>
                <label style={fieldLabel}>
                  휴대폰{mode === "create" && <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}> (권장)</span>}
                </label>
                <input
                  value={form.mobile}
                  onChange={e => setF("mobile", formatPhone(e.target.value))}
                  placeholder="예: 010-1234-5678"
                  inputMode="numeric"
                  style={{ ...inputStyle, borderColor: errors.mobile ? "#fca5a5" : undefined }}
                />
                {errors.mobile && <p style={errorText}>{errors.mobile}</p>}
              </div>
              <div>
                <label style={fieldLabel}>
                  이메일{mode === "create" && <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 12 }}> (권장)</span>}
                </label>
                <input
                  value={form.email}
                  onChange={e => {
                    setF("email", e.target.value);
                    if (e.target.value && !emailRe.test(e.target.value)) {
                      setErrors(prev => ({ ...prev, email: "올바른 이메일 형식이 아닙니다." }));
                    } else {
                      setErrors(prev => { const n = { ...prev }; delete n.email; return n; });
                    }
                  }}
                  placeholder="예: hong@example.com"
                  style={{ ...inputStyle, borderColor: errors.email ? "#fca5a5" : undefined }}
                />
                {errors.email && <p style={errorText}>{errors.email}</p>}
              </div>
            </div>

            {/* 직장전화 */}
            <div>
              <label style={fieldLabel}>직장전화</label>
              <input
                value={form.officePhone}
                onChange={e => setF("officePhone", formatPhone(e.target.value))}
                placeholder="예: 02-1234-5678"
                inputMode="numeric"
                style={inputStyle}
              />
            </div>
          </div>

          {/* ══ [4] 역할 설정 Card ══ */}
          <div style={cardStyle}>
            <p style={cardTitle}>역할 설정</p>
            <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>
              기본 담당자는 거래처별 1명만 지정됩니다. 견적/청구 담당자는 중복 지정 가능합니다.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
              {([
                ["isPrimary",        "기본 담당자",  "기본 연락처로 지정"],
                ["isQuoteContact",   "견적 담당자",  "견적 발송 담당"],
                ["isBillingContact", "청구 담당자",  "청구 처리 담당"],
                ["isActive",         "활성 상태",    "비활성 시 목록에서 숨김"],
              ] as const).map(([key, label, desc]) => (
                <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "10px 14px", background: form[key] ? "#eff6ff" : "#f9fafb", borderRadius: 8, border: `1px solid ${form[key] ? "#bfdbfe" : "#e5e7eb"}`, transition: "all 0.15s" }}>
                  <input
                    type="checkbox"
                    checked={form[key]}
                    onChange={e => setF(key, e.target.checked)}
                    style={{ marginTop: 3, flexShrink: 0 }}
                  />
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: form[key] ? "#1d4ed8" : "#374151" }}>{label}</span>
                    <p style={{ margin: "2px 0 0", fontSize: 11, color: "#9ca3af" }}>{desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* ══ [5] 메모 Card ══ */}
          <div style={cardStyle}>
            <p style={cardTitle}>메모</p>
            <textarea
              value={form.memo}
              onChange={e => setF("memo", e.target.value)}
              rows={3}
              placeholder="특이사항, 커뮤니케이션 이력 등을 자유롭게 입력하세요."
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>

          {/* 서버 오류 */}
          {errors._server && (
            <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 13, color: "#dc2626", fontWeight: 600 }}>
              {errors._server}
            </div>
          )}

          {/* 하단 버튼 */}
          <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
            <PrimaryBtn onClick={() => save(false)} disabled={saving} style={{ flex: 1, fontSize: 14, padding: "11px" }}>
              {submitLabel}
            </PrimaryBtn>
            <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "11px 24px" }}>취소</GhostBtn>
          </div>
        </div>

        {/* ══ 동일 거래처 중복 경고 ══ */}
        {warning?.kind === "same_company" && (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ background: "#fff", borderRadius: 14, padding: "28px 32px", width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 17, fontWeight: 800, color: "#d97706" }}>⚠ 중복 담당자 경고</h3>
              <p style={{ margin: "0 0 20px", fontSize: 13, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{warning.message}</p>
              <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6b7280" }}>동명이인이거나 별도 담당자인 경우 계속 등록할 수 있습니다.</p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={() => setWarning(null)}
                  style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                  취소
                </button>
                <button onClick={() => { setWarning(null); save(true); }} disabled={saving}
                  style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#d97706", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  그래도 등록
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ 다른 거래처 중복 경고 ══ */}
        {warning?.kind === "cross_company" && (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ background: "#fff", borderRadius: 14, padding: "28px 32px", width: 460, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
              <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 800, color: "#d97706" }}>⚠ 다른 거래처 동일 담당자 확인</h3>
              <p style={{ margin: "0 0 14px", fontSize: 13, color: "#374151" }}>
                다른 거래처에 동일한 휴대폰 또는 이메일을 가진 담당자가 존재합니다.
              </p>
              <div style={{ background: "#fefce8", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 14, maxHeight: 180, overflowY: "auto" }}>
                {warning.duplicates.map(d => (
                  <div key={d.id} style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 13, padding: "6px 0", borderBottom: "1px solid #fde68a" }}>
                    <span style={{ fontWeight: 700, color: "#92400e" }}>{d.companyName}</span>
                    <span style={{ color: "#374151" }}>/ {d.name}</span>
                    {d.mobile && <span style={{ color: "#6b7280" }}>{formatPhone(d.mobile)}</span>}
                    {d.email && <span style={{ color: "#6b7280" }}>{d.email}</span>}
                  </div>
                ))}
              </div>
              <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280" }}>
                이직 또는 겸직 담당자일 수 있습니다. 계속 등록하시겠습니까?
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button onClick={() => setWarning(null)}
                  style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                  취소
                </button>
                <button onClick={() => { setWarning(null); save(true); }} disabled={saving}
                  style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#d97706", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  {saving ? "등록 중..." : "계속 등록"}
                </button>
              </div>
            </div>
          </div>
        )}
      </DraggableModal>
    </>
  );
}
