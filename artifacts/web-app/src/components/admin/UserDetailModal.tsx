import React, { useEffect, useMemo, useState } from 'react';
import { formatDisplayDate } from '../../lib/dateFormat';
import { api, AdminUser, User } from '../../lib/constants';
import { RoleBadge } from '../ui';

// ─── 사용자 상세정보(등록정보 조회·수정) 모달 ─────────────────────────────────
//  · 조회 모드 → [수정] → 편집 → [저장]/[취소]. 취소 시 서버값으로 원복.
//  · 변경된 항목만 PATCH /api/admin/users/:id 로 전송(서버에서 재검증·감사로그 기록).
//  · 비밀번호는 표시/수정하지 않으며 기존 "비밀번호 재설정" 기능으로 연결만 한다.

type Detail = {
  user: {
    id: number; email: string; name: string | null; phone: string | null;
    role: AdminUser["role"]; roleId: number | null; roleName: string | null;
    isActive: boolean; department: string | null; jobTitle: string | null;
    createdAt: string; lastLoginAt: string | null; lastActivityAt: string | null;
  };
  activity: {
    loginCount: number;
    recentSessions: { loginAt: string; logoutAt: string | null; lastActivityAt: string; ipAddress: string | null }[];
  };
  history: {
    id: number; action: string; performedByEmail: string | null; createdAt: string;
    changes: Record<string, { before: unknown; after: unknown }> | null;
  }[];
};

type Form = { name: string; email: string; phone: string; department: string; jobTitle: string; role: string };

const FIELD_LABELS: Record<string, string> = {
  name: "이름", email: "이메일", phone: "연락처", department: "부서", jobTitle: "직책", role: "사용자 유형",
};
const ROLE_LABELS: Record<string, string> = {
  admin: "관리자", staff: "직원", client: "고객", linguist: "통번역사", customer: "고객(기존)", translator: "통번역사(기존)",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[0-9+\-() .]{7,30}$/;

const fmtDateTime = (v?: string | null) =>
  v ? new Date(v).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

const fmtChange = (k: string, v: unknown) =>
  v == null || v === "" ? "(없음)" : k === "role" ? ROLE_LABELS[String(v)] ?? String(v) : String(v);

const toForm = (u: Detail["user"]): Form => ({
  name: u.name ?? "", email: u.email, phone: u.phone ?? "",
  department: u.department ?? "", jobTitle: u.jobTitle ?? "", role: u.role,
});

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db",
  fontSize: 13, color: "#111827", outline: "none", boxSizing: "border-box", background: "#fff",
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4, fontWeight: 600 };
const valueStyle: React.CSSProperties = { fontSize: 14, color: "#111827", minHeight: 20, wordBreak: "break-all" };

interface Props {
  token: string;
  userId: number;
  currentUser: User;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (updated: Partial<AdminUser> & { id: number }) => void;
  onResetPassword: (userId: number) => void;
  onToast: (msg: string) => void;
}

export function UserDetailModal({ token, userId, currentUser, canEdit, onClose, onSaved, onResetPassword, onToast }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true); setLoadError("");
    try {
      const res = await fetch(api(`/api/admin/users/${userId}/detail`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) { setLoadError(data?.error ?? "조회 실패"); return; }
      setDetail(data); setForm(toForm(data.user));
    } catch { setLoadError("사용자 상세정보 조회 실패"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSelf = userId === currentUser.id;
  const original = detail ? toForm(detail.user) : null;

  // 변경된 항목만 추출
  const diff = useMemo(() => {
    if (!form || !original) return {} as Partial<Form>;
    const out: Partial<Form> = {};
    (Object.keys(form) as (keyof Form)[]).forEach(k => {
      const a = form[k].trim(), b = original[k].trim();
      if (k === "email" ? a.toLowerCase() !== b.toLowerCase() : a !== b) out[k] = a;
    });
    return out;
  }, [form, original]);
  const dirty = Object.keys(diff).length > 0;

  const validate = (): boolean => {
    if (!form) return false;
    const e: Partial<Record<keyof Form, string>> = {};
    if (!form.name.trim()) e.name = "이름은 필수입니다.";
    if (!form.email.trim()) e.email = "이메일은 필수입니다.";
    else if (!EMAIL_RE.test(form.email.trim())) e.email = "이메일 형식이 올바르지 않습니다.";
    if (form.phone.trim() && !PHONE_RE.test(form.phone.trim())) e.phone = "숫자, +, -, 공백만 입력하세요.";
    if (detail && diff.role !== undefined && detail.user.roleId && !["admin", "staff"].includes(form.role)) {
      e.role = "시스템 권한(RBAC)을 먼저 해제해야 고객/통번역사로 변경할 수 있습니다.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleCancel = () => {
    if (original) setForm(original);
    setErrors({}); setEditing(false);
  };

  const handleSave = async () => {
    if (!dirty) { setEditing(false); return; }
    if (!validate()) return;
    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/users/${userId}`), {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(diff),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error ?? "저장 실패";
        if (data?.field) setErrors({ [data.field]: msg });
        onToast(`오류: ${msg}`);
        return;
      }
      if (data?.user) onSaved(data.user);
      onToast(`사용자 정보가 저장되었습니다. (${(data?.changed ?? []).map((k: string) => FIELD_LABELS[k] ?? k).join(", ")})`);
      setEditing(false); setErrors({});
      await load();
    } catch { onToast("오류: 사용자 정보 저장 실패"); }
    finally { setSaving(false); }
  };

  const roleOptions = useMemo(() => {
    const base = ["admin", "staff", "client", "linguist"];
    if (detail && !base.includes(detail.user.role)) base.push(detail.user.role);
    return base;
  }, [detail]);

  const renderField = (key: keyof Form, opts: { required?: boolean; type?: string; placeholder?: string } = {}) => (
    <div>
      <label style={labelStyle} htmlFor={`user-detail-${key}`}>{FIELD_LABELS[key]}{opts.required && editing ? " *" : ""}</label>
      {editing && form ? (
        <>
          <input id={`user-detail-${key}`} type={opts.type ?? "text"} value={form[key]}
            onChange={e => { setForm(f => f && ({ ...f, [key]: e.target.value })); setErrors(er => ({ ...er, [key]: undefined })); }}
            placeholder={opts.placeholder} data-testid={`input-user-detail-${key}`} aria-label={FIELD_LABELS[key]}
            style={{ ...inputStyle, borderColor: errors[key] ? "#f87171" : diff[key] !== undefined ? "#93c5fd" : "#d1d5db" }} />
          {errors[key] && <div style={{ fontSize: 11, color: "#dc2626", marginTop: 3 }}>{errors[key]}</div>}
        </>
      ) : (
        <div style={valueStyle} data-testid={`text-user-detail-${key}`}>{(original?.[key] || "").trim() || <span style={{ color: "#d1d5db" }}>—</span>}</div>
      )}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => { if (!saving && !editing) onClose(); }}>
      <div onClick={e => e.stopPropagation()} data-testid="modal-user-detail" role="dialog" aria-label="사용자 상세정보"
        style={{ background: "#fff", borderRadius: 14, width: 640, maxWidth: "94vw", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", borderTop: "4px solid #1d4ed8" }}>
        {/* 헤더 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 26px 14px", borderBottom: "1px solid #f3f4f6" }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#111827" }}>사용자 #{userId} 상세정보</h2>
          {detail && <RoleBadge role={detail.user.role} />}
          {detail && (
            <span style={{ padding: "2px 9px", borderRadius: 12, fontSize: 11, fontWeight: 700, background: detail.user.isActive ? "#f0fdf4" : "#fef2f2", color: detail.user.isActive ? "#059669" : "#dc2626" }}>
              {detail.user.isActive ? "활성" : "비활성"}
            </span>
          )}
          {editing && <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", background: "#dbeafe", padding: "2px 8px", borderRadius: 10 }}>수정 중</span>}
          <button onClick={() => { if (editing) handleCancel(); onClose(); }} disabled={saving}
            data-testid="btn-user-detail-close" aria-label="닫기"
            style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 20, color: "#9ca3af", cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ padding: "18px 26px 22px" }}>
          {loading && !detail ? (
            <div style={{ textAlign: "center", padding: 32, color: "#9ca3af", fontSize: 14 }}>불러오는 중...</div>
          ) : loadError ? (
            <div style={{ textAlign: "center", padding: 32, color: "#dc2626", fontSize: 14 }}>{loadError}</div>
          ) : detail && form && (
            <>
              {/* 기본정보 */}
              <div style={{ fontSize: 13, fontWeight: 800, color: "#374151", marginBottom: 10 }}>기본정보</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "14px 20px", marginBottom: 14 }}>
                {renderField("name", { required: true, placeholder: "홍길동" })}
                {renderField("email", { required: true, type: "email", placeholder: "name@company.com" })}
                {renderField("phone", { type: "tel", placeholder: "010-0000-0000" })}
                <div>
                  <label style={labelStyle} htmlFor="user-detail-role">사용자 유형{editing ? " *" : ""}</label>
                  {editing && !isSelf ? (
                    <>
                      <select id="user-detail-role" value={form.role} data-testid="select-user-detail-role" aria-label="사용자 유형"
                        onChange={e => { setForm(f => f && ({ ...f, role: e.target.value })); setErrors(er => ({ ...er, role: undefined })); }}
                        style={{ ...inputStyle, borderColor: errors.role ? "#f87171" : diff.role !== undefined ? "#93c5fd" : "#d1d5db" }}>
                        {roleOptions.map(r => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
                      </select>
                      {errors.role && <div style={{ fontSize: 11, color: "#dc2626", marginTop: 3 }}>{errors.role}</div>}
                    </>
                  ) : (
                    <div style={valueStyle} data-testid="text-user-detail-role">
                      {ROLE_LABELS[detail.user.role] ?? detail.user.role}
                      {editing && isSelf && <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 6 }}>(본인 유형은 변경 불가)</span>}
                    </div>
                  )}
                </div>
                {renderField("department", { placeholder: "예: 운영팀" })}
                {renderField("jobTitle", { placeholder: "예: PM" })}
              </div>

              {/* 조회 전용 정보 */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
                {[
                  ["가입일", formatDisplayDate(detail.user.createdAt)],
                  ["최근 로그인", fmtDateTime(detail.user.lastLoginAt)],
                  ["최근 활동", fmtDateTime(detail.user.lastActivityAt)],
                  ["누적 로그인", `${detail.activity.loginCount}회`],
                  ["시스템 권한(RBAC)", detail.user.roleName ?? (detail.user.role === "admin" && !detail.user.roleId ? "전체 권한" : "—")],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 2 }}>{k}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{v}</div>
                  </div>
                ))}
              </div>

              {/* 비밀번호 — 표시/수정하지 않고 기존 재설정 기능 연결 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18, fontSize: 12, color: "#6b7280" }}>
                <span>비밀번호는 상세정보에서 표시·수정하지 않습니다.</span>
                <button onClick={() => onResetPassword(userId)} disabled={editing}
                  data-testid="btn-user-detail-reset-password" aria-label="비밀번호 재설정"
                  style={{ padding: "4px 10px", fontSize: 11, borderRadius: 6, fontWeight: 600, cursor: editing ? "not-allowed" : "pointer", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", opacity: editing ? 0.5 : 1 }}>
                  비밀번호 재설정
                </button>
              </div>

              {/* 활동 기록 (조회 전용) */}
              <details style={{ marginBottom: 12 }}>
                <summary style={{ fontSize: 13, fontWeight: 800, color: "#374151", cursor: "pointer" }} data-testid="toggle-user-detail-sessions">
                  최근 접속 기록 ({detail.activity.recentSessions.length})
                </summary>
                {detail.activity.recentSessions.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#9ca3af", padding: "8px 0" }}>접속 기록이 없습니다.</div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
                    <thead><tr style={{ background: "#f3f4f6" }}>
                      {["로그인", "마지막 활동", "로그아웃", "IP"].map(h => <th key={h} style={{ padding: "5px 8px", textAlign: "left", color: "#374151" }}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {detail.activity.recentSessions.map((s, i) => (
                        <tr key={i} style={{ borderTop: "1px solid #f3f4f6" }}>
                          <td style={{ padding: "5px 8px" }}>{fmtDateTime(s.loginAt)}</td>
                          <td style={{ padding: "5px 8px" }}>{fmtDateTime(s.lastActivityAt)}</td>
                          <td style={{ padding: "5px 8px" }}>{fmtDateTime(s.logoutAt)}</td>
                          <td style={{ padding: "5px 8px", color: "#9ca3af" }}>{s.ipAddress ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </details>

              {/* 수정 이력 (감사로그, 조회 전용) */}
              <details>
                <summary style={{ fontSize: 13, fontWeight: 800, color: "#374151", cursor: "pointer" }} data-testid="toggle-user-detail-history">
                  수정 이력 ({detail.history.length})
                </summary>
                {detail.history.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#9ca3af", padding: "8px 0" }}>수정 이력이 없습니다.</div>
                ) : detail.history.map(h => (
                  <div key={h.id} style={{ borderTop: "1px solid #f3f4f6", padding: "8px 0", fontSize: 12 }}>
                    <div style={{ color: "#6b7280", marginBottom: 3 }}>{fmtDateTime(h.createdAt)} · {h.performedByEmail ?? "—"}</div>
                    {Object.entries(h.changes ?? {}).map(([k, c]) => (
                      <div key={k} style={{ color: "#374151" }}>
                        <b>{FIELD_LABELS[k] ?? k}</b>: <span style={{ color: "#9ca3af", textDecoration: c.before == null ? "none" : "line-through" }}>{fmtChange(k, c.before)}</span>
                        {" → "}<span style={{ color: "#1d4ed8", fontWeight: 600 }}>{fmtChange(k, c.after)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </details>
            </>
          )}
        </div>

        {/* 하단 버튼 */}
        {detail && (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", padding: "14px 26px", borderTop: "1px solid #f3f4f6", background: "#fafafa", borderRadius: "0 0 14px 14px" }}>
            {!canEdit && <span style={{ fontSize: 12, color: "#9ca3af", marginRight: "auto" }}>사용자 수정 권한(user.manage)이 없어 조회만 가능합니다.</span>}
            {editing ? (
              <>
                {dirty && <span style={{ fontSize: 12, color: "#1d4ed8", marginRight: "auto" }}>변경 항목: {Object.keys(diff).map(k => FIELD_LABELS[k]).join(", ")}</span>}
                <button onClick={handleCancel} disabled={saving} data-testid="btn-user-detail-cancel" aria-label="수정 취소"
                  style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, fontWeight: 600, color: "#374151", cursor: saving ? "not-allowed" : "pointer" }}>취소</button>
                <button onClick={handleSave} disabled={saving || !dirty} data-testid="btn-user-detail-save" aria-label="저장"
                  style={{ padding: "8px 20px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 700, color: "#fff", background: saving || !dirty ? "#93c5fd" : "#1d4ed8", cursor: saving || !dirty ? "not-allowed" : "pointer" }}>
                  {saving ? "저장 중..." : "저장"}
                </button>
              </>
            ) : (
              <>
                <button onClick={onClose} data-testid="btn-user-detail-close-footer" aria-label="닫기"
                  style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, fontWeight: 600, color: "#374151", cursor: "pointer" }}>닫기</button>
                {canEdit && (
                  <button onClick={() => { setForm(original); setErrors({}); setEditing(true); }} data-testid="btn-user-detail-edit" aria-label="수정"
                    style={{ padding: "8px 20px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 700, color: "#fff", background: "#1d4ed8", cursor: "pointer" }}>수정</button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
