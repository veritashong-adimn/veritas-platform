import React, { useState, useEffect, useRef } from "react";
import { api, Company, ContactDetail, Division } from "../../lib/constants";
import { formatPhone } from "../../lib/utils";
import { DraggableModal } from "./DraggableModal";
import { PrimaryBtn, GhostBtn } from "../ui";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 7,
  border: "1px solid #d1d5db", fontSize: 13, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};
const fieldLabel: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#374151", display: "block", marginBottom: 4,
};
const errorText: React.CSSProperties = {
  margin: "2px 0 0", fontSize: 11, color: "#dc2626",
};

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

export function ContactFormModal({ mode, token, companies, contactId, initialData, onClose, onSuccess, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}` };
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ── 폼 상태 ──────────────────────────────────────────────────────────────────
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

  // ── 거래처 검색 (create 전용) ───────────────────────────────────────────────
  const [companyQuery, setCompanyQuery] = useState("");

  // ── 브랜드/부서 ───────────────────────────────────────────────────────────────
  const [divisions, setDivisions] = useState<Division[]>([]);

  // edit 모드: 마운트 시 division 목록 로드
  useEffect(() => {
    if (mode === "edit" && initialData?.companyId) {
      fetch(api(`/api/admin/companies/${initialData.companyId}/divisions`), { headers: authH })
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setDivisions(d); })
        .catch(() => { /* ignore */ });
    }
  }, [mode, initialData?.companyId]);

  const setF = <K extends keyof FormData>(k: K, v: FormData[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  // ── 검증 ─────────────────────────────────────────────────────────────────────
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

  // ── 저장 ─────────────────────────────────────────────────────────────────────
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

  // ── 거래처 선택 (create 전용) ───────────────────────────────────────────────
  const loadDivisions = async (cId: number) => {
    try {
      const res = await fetch(api(`/api/admin/companies/${cId}/divisions`), { headers: authH });
      if (res.ok) { const d = await res.json(); setDivisions(Array.isArray(d) ? d : []); }
    } catch { /* ignore */ }
  };

  const title = mode === "create" ? "담당자 등록" : "담당자 수정";
  const submitLabel = saving ? (mode === "create" ? "등록 중..." : "저장 중...") : (mode === "create" ? "담당자 등록" : "담당자 수정");

  return (
    <DraggableModal
      title={title}
      subtitle={mode === "create" ? "하나의 거래처에 여러 명의 담당자를 등록할 수 있습니다." : undefined}
      onClose={onClose}
      width={560}
      zIndex={1000}
      bodyPadding="20px 24px"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* ── 거래처 선택 (create) / 거래처 표시 (edit) ── */}
        {mode === "create" ? (
          <div>
            <label style={fieldLabel}>거래처 선택 <span style={{ color: "#dc2626" }}>*</span></label>
            {form.companyId === null ? (
              <>
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
                        (c.businessNumber ?? "").replace(/-/g,"").includes(q.replace(/-/g,""))
                      ).slice(0, 10);
                      if (filtered.length === 0) return <p style={{ padding: "12px 14px", color: "#9ca3af", fontSize: 13, margin: 0 }}>검색 결과가 없습니다.</p>;
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
              <div style={{ padding: "8px 12px", background: "#eff6ff", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "#1d4ed8", fontWeight: 600 }}>✓ {companyQuery}</span>
                <button onClick={() => { setF("companyId", null); setF("divisionId", null); setCompanyQuery(""); setDivisions([]); }}
                  style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 12 }}>변경</button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <label style={fieldLabel}>거래처</label>
            <div style={{ padding: "8px 12px", background: "#f3f4f6", borderRadius: 7, fontSize: 13, color: "#6b7280", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600, color: "#374151" }}>{initialData!.companyName ?? "-"}</span>
              <span style={{ fontSize: 11, color: "#9ca3af" }}>(변경 불가)</span>
            </div>
          </div>
        )}

        {/* ── 브랜드/부서 ── */}
        {(form.companyId !== null || mode === "edit") && (
          <div>
            <label style={fieldLabel}>
              브랜드/부서 <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>(선택)</span>
            </label>
            {divisions.length === 0 ? (
              <div style={{ padding: "8px 12px", background: "#f9fafb", borderRadius: 7, fontSize: 12, color: "#9ca3af", border: "1px solid #f3f4f6" }}>
                {mode === "edit" && initialData!.divisionName
                  ? `현재: ${initialData!.divisionName} (변경 불가 — 브랜드/부서 없음)`
                  : "이 거래처에 등록된 브랜드/부서가 없습니다."}
              </div>
            ) : (
              <select
                value={form.divisionId ?? ""}
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

        {/* ── 기본 정보 그리드 ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
          {/* 담당자명 */}
          <div style={{ gridColumn: "1/-1" }}>
            <label style={fieldLabel}>담당자명 <span style={{ color: "#dc2626" }}>*</span></label>
            <input
              value={form.name}
              onChange={e => setF("name", e.target.value)}
              placeholder="예: 홍길동"
              style={{ ...inputStyle, borderColor: errors.name ? "#fca5a5" : undefined }}
            />
            {errors.name && <p style={errorText}>{errors.name}</p>}
          </div>

          {/* 부서 */}
          <div>
            <label style={fieldLabel}>부서</label>
            <input value={form.department} onChange={e => setF("department", e.target.value)}
              placeholder="예: 마케팅팀" style={inputStyle} />
          </div>

          {/* 직책 */}
          <div>
            <label style={fieldLabel}>직책</label>
            <input value={form.position} onChange={e => setF("position", e.target.value)}
              placeholder="예: 과장" style={inputStyle} />
          </div>

          {/* 휴대폰 */}
          <div>
            <label style={fieldLabel}>
              휴대폰 <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>{mode === "create" ? "(권장)" : ""}</span>
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

          {/* 이메일 */}
          <div>
            <label style={fieldLabel}>
              이메일 <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>{mode === "create" ? "(권장)" : ""}</span>
            </label>
            <input
              value={form.email}
              onChange={e => {
                setF("email", e.target.value);
                if (e.target.value && !emailRe.test(e.target.value)) {
                  setErrors(prev => ({ ...prev, email: "올바른 이메일 형식이 아닙니다. (@ 포함)" }));
                } else {
                  setErrors(prev => { const n = { ...prev }; delete n.email; return n; });
                }
              }}
              placeholder="예: hong@example.com"
              style={{ ...inputStyle, borderColor: errors.email ? "#fca5a5" : undefined }}
            />
            {errors.email && <p style={errorText}>{errors.email}</p>}
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

          {/* 메모 */}
          <div style={{ gridColumn: "1/-1" }}>
            <label style={fieldLabel}>메모</label>
            <textarea
              value={form.memo}
              onChange={e => setF("memo", e.target.value)}
              rows={2}
              placeholder="특이사항 등"
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>
        </div>

        {/* ── 역할 설정 ── */}
        <div style={{ background: "#f9fafb", borderRadius: 10, padding: "12px 16px" }}>
          <p style={{ margin: "0 0 10px", fontSize: 12, fontWeight: 700, color: "#6b7280" }}>역할 설정</p>
          <p style={{ margin: "0 0 10px", fontSize: 11, color: "#9ca3af" }}>
            기본 담당자는 거래처별 1명만 지정됩니다. 견적/청구 담당자는 중복 지정 가능합니다.
          </p>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {([
              ["isPrimary", "기본 담당자", "기본 연락처로 지정"],
              ["isQuoteContact", "견적 담당자", "견적 발송 담당"],
              ["isBillingContact", "청구 담당자", "청구 처리 담당"],
              ["isActive", "활성 상태", "비활성 시 목록에서 숨김"],
            ] as const).map(([key, label, desc]) => (
              <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form[key]}
                  onChange={e => setF(key, e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>{label}</span>
                  <p style={{ margin: "1px 0 0", fontSize: 11, color: "#9ca3af" }}>{desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* ── 서버 오류 ── */}
        {errors._server && (
          <div style={{ padding: "10px 14px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, fontSize: 13, color: "#dc2626", fontWeight: 600 }}>
            {errors._server}
          </div>
        )}

        {/* ── 저장/취소 ── */}
        <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
          <PrimaryBtn onClick={() => save(false)} disabled={saving} style={{ flex: 1, fontSize: 14, padding: "10px" }}>
            {submitLabel}
          </PrimaryBtn>
          <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "10px 20px" }}>취소</GhostBtn>
        </div>
      </div>

      {/* ── 동일 거래처 중복 경고 오버레이 ── */}
      {warning?.kind === "same_company" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "28px 32px", width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 17, fontWeight: 800, color: "#d97706" }}>⚠ 중복 담당자 경고</h3>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#374151", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{warning.message}</p>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#6b7280" }}>동명이인이거나 별도 담당자인 경우 계속 등록할 수 있습니다.</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setWarning(null)}
                style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                취소 (다시 확인)
              </button>
              <button
                onClick={() => { setWarning(null); save(true); }}
                disabled={saving}
                style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#d97706", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                그래도 등록
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 다른 거래처 중복 경고 오버레이 ── */}
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
                  {d.mobile && <span style={{ color: "#6b7280" }}>{d.mobile}</span>}
                  {d.email && <span style={{ color: "#6b7280" }}>{d.email}</span>}
                </div>
              ))}
            </div>
            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280" }}>
              이직 또는 겸직 담당자일 수 있습니다. 계속 등록하시겠습니까?
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setWarning(null)}
                style={{ padding: "9px 20px", borderRadius: 8, border: "1px solid #d1d5db", background: "#f9fafb", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                취소
              </button>
              <button
                onClick={() => { setWarning(null); save(true); }}
                disabled={saving}
                style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#d97706", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                {saving ? "등록 중..." : "계속 등록"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DraggableModal>
  );
}
