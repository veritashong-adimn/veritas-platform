import React, { useState, useEffect } from "react";
import { api, TranslatorProfile, TranslatorRate, NoteEntry, normalizeLanguages } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { DraggableModal } from "./DraggableModal";
import { SensitiveInfoModal } from "./SensitiveInfoModal";
import {
  ALL_RATE_UNITS as ALL_UNITS,
  getRateUnitLabel as getUnitLabel,
  SERVICE_TYPES as PROFILE_WORK_TYPES,
  SUB_SERVICE_TYPES as PROFILE_SUB_TYPES_MAP,
  SPECIALIZATION_PRESETS,
} from "./translatorRateConstants";
import { TranslatorRateEntryCard, RateEntryData, emptyRateEntry } from "./TranslatorRateEntryCard";
import { ResumeAnalyzePanel, ResumeAnalysisResult } from "./ResumeAnalyzePanel";

// ── 이력서 파일 형식 정책 ──────────────────────────────────────────────────────
// 1단계 (현재): PDF · DOC · DOCX · TXT
// 2단계 (예정): HWP · HWPX
// 3단계 (예정): JPG · PNG · 스캔 PDF OCR
const RESUME_ALLOWED_EXTS = [".pdf", ".doc", ".docx", ".txt"] as const;
// 브라우저 미리보기 가능한 형식 (서명 URL을 새 탭으로 열면 바로 표시됨)
// 3단계 활성 시 ".jpg", ".jpeg", ".png" 추가
const RESUME_PREVIEWABLE_EXTS = [".pdf", ".txt"] as const;
const RESUME_ACCEPT = ".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
const RESUME_HINT = "PDF · DOC · DOCX · TXT (최대 10 MB)";
const RESUME_UPLOAD_ERROR_MSG = "PDF, DOC, DOCX, TXT 형식만 업로드할 수 있습니다.";

function getResumeExt(resumeUrl: string | null | undefined): string {
  if (!resumeUrl) return "";
  const dot = resumeUrl.lastIndexOf(".");
  return dot >= 0 ? resumeUrl.slice(dot).toLowerCase() : "";
}

function canPreviewResume(ext: string): boolean {
  return (RESUME_PREVIEWABLE_EXTS as readonly string[]).includes(ext);
}

function getResumeDisplayName(resumeUrl: string | null | undefined, fileName: string | null): string {
  if (fileName) return fileName;
  if (!resumeUrl) return "이력서";
  const lastSlash = resumeUrl.lastIndexOf("/");
  const nameWithExt = lastSlash >= 0 ? resumeUrl.slice(lastSlash + 1) : resumeUrl;
  const extIndex = nameWithExt.lastIndexOf(".");
  const ext = extIndex >= 0 ? nameWithExt.slice(extIndex).toLowerCase() : "";
  return `이력서${ext}`;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const GRADE_OPTIONS = ["S", "A", "B", "C"];
const LANG_LEVEL_OPTIONS = ["일반", "전문"];

type EmailEntry = { email: string; isPrimary: boolean; error: string };
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatPhoneNumber(value: string): string {
  const n = value.replace(/\D/g, "");
  if (n.length <= 3) return n;
  if (n.length <= 7) return `${n.slice(0, 3)}-${n.slice(3)}`;
  return `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7, 11)}`;
}

export function TranslatorDetailModal({ userId, userEmail, token, permissions = [], onClose, onToast, onDeleted, onSaved }: {
  userId: number; userEmail: string; token: string;
  permissions?: string[];
  onClose: () => void; onToast: (msg: string) => void;
  onDeleted?: () => void; onSaved?: () => void;
}) {
  const hasPerm = (key: string) => permissions.includes(key);
  const [profile, setProfile] = useState<TranslatorProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteCanForce] = useState(false);
  const [activating, setActivating] = useState(false);
  const [permanentDeleting, setPermanentDeleting] = useState(false);
  const [permanentDeleteError, setPermanentDeleteError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<{ name: string; email: string; isActive: boolean; invitePending?: boolean } | null>(null);
  const [reinviting, setReinviting] = useState(false);
  const [rates, setRates] = useState<TranslatorRate[]>([]);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [emailEntries, setEmailEntries] = useState<EmailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [rateForm, setRateForm] = useState<RateEntryData>(emptyRateEntry());
  const [addingRate, setAddingRate] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeDeleting, setResumeDeleting] = useState(false);
  const [showAllSubTypes, setShowAllSubTypes] = useState(false);
  const [pinnedSubTypes, setPinnedSubTypes] = useState<Set<string>>(new Set());
  const [showOtherSpec, setShowOtherSpec] = useState(false);
  const [showAnalyzePanel, setShowAnalyzePanel] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [resumeFileName, setResumeFileName] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState({
    education: true,
    resume: true,
    operational: true,
    operations: true,
    rates: true,
  });
  const toggleSection = (key: keyof typeof collapsed) =>
    setCollapsed(p => ({ ...p, [key]: !p[key] }));

  const [form, setForm] = useState({
    name: "",
    phone: "",
    languagePairs: "", languageLevel: "", specializations: "", education: "", major: "",
    graduationYear: "", region: "", grade: "", rating: "", availabilityStatus: "available",
    bio: "",
    affiliatedCompanyId: "" as string,
    settlementType: "",
    profileWorkTypes: "",
    profileSubTypes: "",
    operationalStatus: "normal",
    operationalNote: "",
    reassignmentAllowed: true,
  });
  const [vendorCompanies, setVendorCompanies] = useState<Array<{ id: number; name: string }>>([]);

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes, vcRes] = await Promise.all([
        fetch(api(`/api/admin/translators/${userId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=translator&entityId=${userId}`), { headers: authH }),
        fetch(api(`/api/admin/companies?companyType=vendor`), { headers: authH }),
      ]);
      const [dData, nData, vcData] = await Promise.all([dRes.json(), nRes.json(), vcRes.json()]);
      if (vcRes.ok && Array.isArray(vcData)) {
        setVendorCompanies(vcData.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name })));
      }
      if (dRes.ok) {
        const u = dData.user;
        setUserInfo({ name: u?.name ?? "", email: u?.email ?? userEmail, isActive: u?.isActive ?? true, invitePending: dData.user?.inviteStatus === "pending" });
        const p: TranslatorProfile | null = dData.profile;
        setProfile(p);
        setRates(Array.isArray(dData.rates) ? dData.rates : []);
        // 이메일 목록 구성
        const allEmails: Array<{ email: string; isPrimary: boolean }> = Array.isArray(dData.emails) ? dData.emails : [];
        const fallbackPrimary = u?.email ?? userEmail;
        let entries: EmailEntry[];
        if (allEmails.length > 0) {
          entries = allEmails.map(e => ({ email: e.email, isPrimary: e.isPrimary, error: "" }));
        } else {
          // translator_emails 없으면 users.email을 대표로
          entries = [{ email: fallbackPrimary, isPrimary: true, error: "" }];
        }
        // 대표 없으면 첫 번째를 대표로
        if (!entries.some(e => e.isPrimary)) entries[0].isPrimary = true;
        // 대표 이메일을 최상단으로 정렬
        entries.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
        setEmailEntries(entries);

        // 언어레벨 "비즈니스" → "일반" 정규화
        const rawLevel = p?.languageLevel ?? "";
        const normalizedLevel = rawLevel === "비즈니스" ? "일반" : rawLevel;
        setForm({
          name: u?.name ?? "",
          phone: p?.phone ?? "",
          languagePairs: p?.languagePairs ?? "", languageLevel: normalizedLevel,
          specializations: p?.specializations ?? "", education: p?.education ?? "", major: p?.major ?? "",
          graduationYear: p?.graduationYear ? String(p.graduationYear) : "",
          region: p?.region ?? "", grade: p?.grade ?? "",
          rating: p?.rating ? String(p.rating) : "",
          availabilityStatus: p?.availabilityStatus ?? "available",
          bio: p?.bio ?? "",
          affiliatedCompanyId: p?.affiliatedCompanyId ? String(p.affiliatedCompanyId) : "",
          settlementType: p?.settlementType ?? "",
          profileWorkTypes: p?.profileWorkTypes ?? "",
          profileSubTypes: p?.profileSubTypes ?? "",
          operationalStatus: p?.operationalStatus ?? "normal",
          operationalNote: p?.operationalNote ?? "",
          reassignmentAllowed: p?.reassignmentAllowed !== false,
        });
        // 앞 2개 = 대표 세부유형
        const rawSubs = (p?.profileSubTypes ?? "").split(",").map(s => s.trim()).filter(Boolean);
        setPinnedSubTypes(new Set(rawSubs.slice(0, 2)));
        // 기타 전문분야 입력창: 기존 데이터에 preset 외 값이 있으면 열어둠
        const existingSpecs = (p?.specializations ?? "").split(",").map(s => s.trim()).filter(Boolean);
        setShowOtherSpec(existingSpecs.some(s => !(SPECIALIZATION_PRESETS as readonly string[]).includes(s)));
      }
      if (nRes.ok) setNotes(Array.isArray(nData) ? nData : []);
    } catch { onToast("오류: 통번역사 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [userId]);

  const handleTogglePin = (st: string) => {
    if (pinnedSubTypes.has(st)) {
      setPinnedSubTypes(prev => { const n = new Set(prev); n.delete(st); return n; });
    } else if (pinnedSubTypes.size >= 2) {
      onToast("대표 세부유형은 최대 2개까지 선택할 수 있습니다.");
    } else {
      setPinnedSubTypes(prev => new Set(prev).add(st));
    }
  };

  const handleSave = async () => {
    // 이메일 검증
    const validated = emailEntries.map(e => {
      const t = e.email.trim().toLowerCase();
      if (!t) return { ...e, error: "이메일을 입력하세요." };
      if (!emailRegex.test(t)) return { ...e, error: "올바른 이메일 형식이 아닙니다." };
      return { ...e, error: "" };
    });
    if (validated.some(e => e.error)) { setEmailEntries(validated); return; }

    // 중복 검사
    const allNorm = validated.map(e => e.email.trim().toLowerCase());
    if (new Set(allNorm).size !== allNorm.length) {
      onToast("동일한 이메일이 중복 입력되어 있습니다."); return;
    }

    // 대표 이메일 1개 확인
    const primaryCount = validated.filter(e => e.isPrimary).length;
    if (primaryCount !== 1) {
      onToast("대표 이메일은 반드시 1개여야 합니다."); return;
    }

    setSaving(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}`), {
        method: "PATCH", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          name: form.name.trim() || null,
          phone: form.phone.trim() || null,
          graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
          rating: form.rating ? Number(form.rating) : null,
          grade: form.grade || null,
          languageLevel: form.languageLevel || null,
          affiliatedCompanyId: form.affiliatedCompanyId ? Number(form.affiliatedCompanyId) : null,
          settlementType: form.settlementType || null,
          profileWorkTypes: form.profileWorkTypes.trim() || null,
          profileSubTypes: (() => {
            const all = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
            const reordered = [...all.filter(s => pinnedSubTypes.has(s)), ...all.filter(s => !pinnedSubTypes.has(s))];
            return reordered.join(",") || null;
          })(),
          operationalStatus: form.operationalStatus || "normal",
          operationalNote: form.operationalNote.trim() || null,
          reassignmentAllowed: form.reassignmentAllowed,
          emails: validated.map(e => ({ email: e.email.trim().toLowerCase(), isPrimary: e.isPrimary })),
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      // name이 변경된 경우 userInfo 동기화
      if (form.name.trim()) setUserInfo(prev => prev ? { ...prev, name: form.name.trim() } : prev);
      setProfile(data);
      // 저장 응답값으로 form state 갱신 (학력/전공/졸업연도/전문분야 포함)
      setForm(prev => ({
        ...prev,
        education: data.education ?? "",
        major: data.major ?? "",
        graduationYear: data.graduationYear ? String(data.graduationYear) : "",
        specializations: data.specializations ?? "",
        languagePairs: data.languagePairs ?? "",
        languageLevel: data.languageLevel ?? "",
        region: data.region ?? "",
        grade: data.grade ?? "",
        rating: data.rating ? String(data.rating) : "",
        availabilityStatus: data.availabilityStatus ?? "available",
        bio: data.bio ?? "",
        affiliatedCompanyId: data.affiliatedCompanyId ? String(data.affiliatedCompanyId) : "",
        settlementType: data.settlementType ?? "",
        profileWorkTypes: data.profileWorkTypes ?? "",
        profileSubTypes: data.profileSubTypes ?? "",
        operationalStatus: data.operationalStatus ?? "normal",
        operationalNote: data.operationalNote ?? "",
        reassignmentAllowed: data.reassignmentAllowed !== false,
      }));
      // 저장된 profileSubTypes 기준으로 pins 재동기화 (앞 N개 유지)
      const savedSubs = (data.profileSubTypes ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
      setPinnedSubTypes(prev => new Set(savedSubs.slice(0, prev.size)));
      // 대표 이메일 변경 시 userInfo 갱신
      const newPrimary = validated.find(e => e.isPrimary)?.email.trim().toLowerCase() ?? "";
      if (newPrimary) setUserInfo(prev => prev ? { ...prev, email: newPrimary } : prev);
      onToast("통번역사 프로필이 저장되었습니다.");
      onSaved?.();
    } catch { onToast("오류: 저장 실패"); }
    finally { setSaving(false); }
  };

  const handleAddRate = async () => {
    if (!rateForm.workType || !rateForm.rate) { onToast("업무유형과 기본단가를 입력하세요."); return; }
    const subTypeVal = rateForm.subType.trim() || null;
    const srcLang = rateForm.sourceLang === "기타" ? rateForm.sourceCustom.trim() || "기타" : rateForm.sourceLang;
    const tgtLang = rateForm.targetLang === "기타" ? rateForm.targetCustom.trim() || "기타" : rateForm.targetLang;
    if (!srcLang || !tgtLang) { onToast("출발 언어와 도착 언어를 모두 선택하세요."); return; }
    if (srcLang === tgtLang) { onToast("출발 언어와 도착 언어가 같을 수 없습니다."); return; }
    const isDuplicate = rates.some(r =>
      r.serviceType === rateForm.workType &&
      (r.subType ?? null) === subTypeVal &&
      (r.language ?? null) === srcLang &&
      (r.languagePair ?? null) === tgtLang &&
      r.unit === rateForm.unit,
    );
    if (isDuplicate) { onToast("동일한 조합(업무유형+세부유형+출발언어+도착언어+단가단위)의 단가가 이미 존재합니다."); return; }
    setAddingRate(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/rates`), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({
          workType: rateForm.workType,
          subType: subTypeVal,
          language: srcLang,
          languagePair: tgtLang,
          unit: rateForm.unit,
          rate: Number(rateForm.rate),
          currency: rateForm.currency,
          vatIncluded: rateForm.vatIncluded,
          isDefault: rateForm.isDefault,
          isActive: rateForm.isActive,
          minPrice: rateForm.minPrice ? Number(rateForm.minPrice) : null,
          baseHours: rateForm.baseHours ? Number(rateForm.baseHours) : null,
          overtimeRate: rateForm.overtimeRate ? Number(rateForm.overtimeRate) : null,
          memo: rateForm.memo || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setRates(prev => [data, ...prev]);
      setRateForm(emptyRateEntry());
      onToast("단가가 추가되었습니다.");
    } catch { onToast("오류: 단가 추가 실패"); }
    finally { setAddingRate(false); }
  };

  const handleDeleteRate = async (rateId: number) => {
    try {
      await fetch(api(`/api/admin/translators/${userId}/rates/${rateId}`), { method: "DELETE", headers: authH });
      setRates(prev => prev.filter(r => r.id !== rateId));
      onToast("단가가 삭제되었습니다.");
    } catch { onToast("오류: 단가 삭제 실패"); }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(api("/api/admin/notes"), {
        method: "POST", headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ entityType: "translator", entityId: userId, content: noteText.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setNotes(prev => [data, ...prev]);
      setNoteText("");
      onToast("메모가 추가되었습니다.");
    } catch { onToast("오류: 메모 추가 실패"); }
    finally { setAddingNote(false); }
  };

  const sH: React.CSSProperties = {
    fontSize: 14, fontWeight: 700, color: "#111827",
    borderLeft: "3px solid #6366f1", paddingLeft: 10,
    margin: 0, lineHeight: 1.5,
  };
  const labelSt: React.CSSProperties = { fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 };
  const secRow = (label: string, collapseKey?: keyof typeof collapsed, extra?: React.ReactNode): React.ReactNode => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "18px 0 8px" }}>
      <p style={sH}>{label}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {extra}
        {collapseKey && (
          <button type="button" onClick={() => toggleSection(collapseKey)}
            style={{ fontSize: 12, color: "#6b7280", background: "none", border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer", padding: "2px 10px", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10 }}>{collapsed[collapseKey] ? "▶" : "▼"}</span>
            {collapsed[collapseKey] ? "펼치기" : "접기"}
          </button>
        )}
      </div>
    </div>
  );
  const handleReinvite = async () => {
    setReinviting(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/reinvite`), { method: "POST", headers: authH });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      const inviteUrl = `${window.location.origin}/set-password?token=${data.inviteToken}`;
      await navigator.clipboard.writeText(inviteUrl);
      onToast("새 초대 링크가 생성되어 클립보드에 복사되었습니다.");
      setUserInfo(prev => prev ? { ...prev, invitePending: true } : prev);
    } catch { onToast("오류: 초대 링크 재생성 실패"); }
    finally { setReinviting(false); }
  };

  const handleActivate = async () => {
    if (!confirm("이 통번역사를 다시 활성화하시겠습니까?")) return;
    setActivating(true);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/activate`), {
        method: "PATCH", headers: authH,
      });
      const data = await res.json();
      if (!res.ok) {
        onToast(data.error ?? "활성화 중 오류가 발생했습니다.");
        return;
      }
      onToast("통번역사가 활성화되었습니다.");
      setUserInfo(prev => prev ? { ...prev, isActive: true } : prev);
      onDeleted?.(); // 목록 새로고침
    } catch (err) {
      console.error("[PATCH /activate] 예외:", err);
      onToast("오류가 발생했습니다. 관리자에게 문의하세요.");
    } finally {
      setActivating(false);
    }
  };

  const handlePermanentDelete = async () => {
    const ok = confirm(
      "⚠️ 이 작업은 되돌릴 수 없습니다.\n\n" +
      "테스트 데이터인 경우에만 완전삭제하세요.\n\n" +
      "정말 완전삭제하시겠습니까?"
    );
    if (!ok) return;
    setPermanentDeleting(true);
    setPermanentDeleteError(null);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}/permanent`), {
        method: "DELETE", headers: authH,
      });
      const data = await res.json();
      if (!res.ok) {
        setPermanentDeleteError(data.error ?? "완전삭제 중 오류가 발생했습니다.");
        return;
      }
      onToast("통번역사가 완전삭제되었습니다.");
      onClose();
      onDeleted?.();
    } catch (err) {
      console.error("[DELETE /permanent] 예외:", err);
      setPermanentDeleteError("오류가 발생했습니다. 관리자에게 문의하세요.");
    } finally {
      setPermanentDeleting(false);
    }
  };

  const handleDeleteTranslator = async () => {
    if (!confirm("이 통번역사를 비활성 처리하시겠습니까?\n기존 단가, 정산, 작업 데이터는 보존됩니다.")) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(api(`/api/admin/translators/${userId}`), {
        method: "DELETE", headers: authH,
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error ?? "비활성 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.";
        console.error("[DELETE /admin/translators]", res.status, data);
        setDeleteError(msg);
        return;
      }
      onToast("통번역사가 비활성 처리되었습니다.");
      onDeleted?.();
      onClose();
    } catch (err) {
      console.error("[DELETE /admin/translators] 예외:", err);
      setDeleteError("오류가 발생했습니다. 관리자에게 문의하세요.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
    <DraggableModal title="통번역사 상세" subtitle={userEmail} onClose={onClose} width={860} height="88vh" zIndex={300} bodyPadding="20px 28px" resizable
      headerExtra={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={handleSave} disabled={saving}
              style={{ fontSize: 12, padding: "4px 14px", background: saving ? "#a5b4fc" : "#6366f1", color: "#fff", border: "none", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer", fontWeight: 700 }}>
              {saving ? "저장 중…" : "프로필 저장"}
            </button>
            {userInfo?.isActive === false ? (
              <button onClick={handleActivate} disabled={activating || permanentDeleting}
                style={{ fontSize: 11, padding: "3px 10px", background: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7", borderRadius: 6, cursor: "pointer", fontWeight: 700 }}>
                {activating ? "처리 중…" : "활성화"}
              </button>
            ) : (
              <button onClick={() => handleDeleteTranslator()} disabled={deleting || permanentDeleting}
                style={{ fontSize: 11, padding: "3px 10px", background: "#fee2e2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                {deleting ? "처리 중…" : "비활성 처리"}
              </button>
            )}
            <button onClick={handlePermanentDelete} disabled={permanentDeleting || deleting || activating}
              style={{ fontSize: 11, padding: "3px 10px", background: "#7f1d1d", color: "#fff", border: "1px solid #991b1b", borderRadius: 6, cursor: "pointer", fontWeight: 700, opacity: (permanentDeleting || deleting || activating) ? 0.6 : 1 }}>
              {permanentDeleting ? "삭제 중…" : "완전삭제"}
            </button>
          </div>
          {(deleteError || permanentDeleteError) && (
            <div style={{ fontSize: 11, color: "#dc2626", maxWidth: 300, textAlign: "right", lineHeight: 1.4 }}>
              {permanentDeleteError ?? deleteError}
            </div>
          )}
          {userInfo?.isActive === false && (
            <span style={{ fontSize: 10, color: "#9ca3af", background: "#f3f4f6", borderRadius: 4, padding: "1px 6px" }}>
              비활성 상태
            </span>
          )}
        </div>
      }
    >
      {loading ? <p style={{ color: "#9ca3af", textAlign: "center", padding: "32px 0" }}>불러오는 중...</p> : (
        <>
          {/* ═══════════════════════════════════════════
              1. 프로필 요약 카드 (읽기 전용)
          ═══════════════════════════════════════════ */}
          <div style={{
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            borderRadius: 12,
            padding: "14px 18px",
            marginBottom: 18,
            marginTop: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: "8px 20px",
            alignItems: "center",
          }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: "#0c4a6e" }}>
              {form.name || userInfo?.name || "—"}
            </span>
            {form.languagePairs && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
                {normalizeLanguages(form.languagePairs).split(",").map(s => s.trim()).filter(Boolean).map((lang, i) => (
                  <span key={i} style={{ fontSize: 12, background: "#e0f2fe", color: "#0369a1", borderRadius: 20, padding: "2px 8px", fontWeight: 600 }}>
                    {lang}
                  </span>
                ))}
              </div>
            )}
            {pinnedSubTypes.size > 0 && (
              <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                {[...pinnedSubTypes].map(st => (
                  <span key={st} style={{ fontSize: 12, background: "#ecfdf5", color: "#065f46", borderRadius: 20, padding: "2px 8px", fontWeight: 700, border: "1px solid #a7f3d0" }}>
                    ★ {st}
                  </span>
                ))}
              </div>
            )}
            {form.specializations && (() => {
              const specs = form.specializations.split(",").map(s => s.trim()).filter(Boolean);
              const LIMIT = 3;
              const visible = specs.slice(0, LIMIT);
              const hiddenCount = specs.length - LIMIT;
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
                  {visible.map((s, i) => (
                    <span key={i} style={{ fontSize: 11, background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "1px 6px", fontWeight: 600 }}>
                      {s}
                    </span>
                  ))}
                  {hiddenCount > 0 && <span style={{ fontSize: 11, color: "#9ca3af" }}>+{hiddenCount}</span>}
                </div>
              );
            })()}
            {form.rating && (
              <span style={{ fontSize: 13, fontWeight: 700, color: "#d97706" }}>★ {form.rating}</span>
            )}
            {form.grade && (
              <span style={{ fontSize: 12, background: "#fef3c7", color: "#92400e", borderRadius: 20, padding: "2px 9px", fontWeight: 700 }}>
                {form.grade}등급
              </span>
            )}
            <span style={{
              fontSize: 12, borderRadius: 20, padding: "2px 9px", fontWeight: 700,
              background: form.availabilityStatus === "available" ? "#d1fae5" : form.availabilityStatus === "busy" ? "#fef3c7" : "#fee2e2",
              color: form.availabilityStatus === "available" ? "#065f46" : form.availabilityStatus === "busy" ? "#92400e" : "#991b1b",
            }}>
              {form.availabilityStatus === "available" ? "가능" : form.availabilityStatus === "busy" ? "바쁨" : "불가"}
            </span>
            {form.operationalStatus && form.operationalStatus !== "normal" && (
              <span style={{
                fontSize: 12, borderRadius: 20, padding: "2px 9px", fontWeight: 700,
                background: form.operationalStatus === "warning" ? "#fefce8" : form.operationalStatus === "hold" ? "#f0f9ff" : "#fef2f2",
                color: form.operationalStatus === "warning" ? "#854d0e" : form.operationalStatus === "hold" ? "#075985" : "#991b1b",
                border: `1px solid ${form.operationalStatus === "warning" ? "#fde047" : form.operationalStatus === "hold" ? "#bae6fd" : "#fca5a5"}`,
              }}>
                {form.operationalStatus === "warning" ? "⚠️ 주의" : form.operationalStatus === "hold" ? "⏸ 보류" : "🚫 제외"}
              </span>
            )}
            {!form.reassignmentAllowed && (
              <span style={{ fontSize: 12, background: "#fee2e2", color: "#991b1b", borderRadius: 20, padding: "2px 9px", fontWeight: 700, border: "1px solid #fca5a5" }}>
                재배정 불가
              </span>
            )}
            {/* 학력/경력 요약 — 두 번째 줄 (있을 때만) */}
            {(form.education || form.bio) && (
              <div style={{ width: "100%", display: "flex", gap: 12, flexWrap: "wrap", borderTop: "1px solid #bae6fd", paddingTop: 6, marginTop: 2 }}>
                {form.education && (
                  <span style={{ fontSize: 11, color: "#0369a1" }}>
                    🎓 {form.education}{form.major ? ` · ${form.major}` : ""}{form.graduationYear ? ` (${form.graduationYear})` : ""}
                  </span>
                )}
                {form.bio && (
                  <span style={{ fontSize: 11, color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    📝 {form.bio.length > 60 ? form.bio.slice(0, 60) + "…" : form.bio}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ═══════════════════════════════════════════
              2. 기본 정보
          ═══════════════════════════════════════════ */}
          {secRow("기본 정보", undefined,
            userInfo?.invitePending ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fef3c7", color: "#92400e", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>⏳ 초대 대기</span>
                <button onClick={handleReinvite} disabled={reinviting}
                  style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: reinviting ? "not-allowed" : "pointer", fontWeight: 600 }}>
                  {reinviting ? "처리 중..." : "🔗 링크 재발급"}
                </button>
              </div>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#d1fae5", color: "#065f46", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>✓ 계정 활성</span>
            )
          )}
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 4 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
              {/* 이름 + 휴대폰 같은 줄 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>이름</label>
                <input type="text" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="이름 입력" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>휴대폰번호</label>
                <input type="tel" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: formatPhoneNumber(e.target.value) }))}
                  placeholder="010-0000-0000" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
              {/* 이메일 — 인라인 +/- 버튼, 별도 추가줄 없음 */}
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ ...labelSt, fontSize: 11 }}>
                  이메일 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(대표 이메일은 로그인에 사용됨)</span>
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {emailEntries.map((entry, i) => (
                    <div key={i}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="email" value={entry.email}
                          onChange={e => setEmailEntries(p => p.map((x, idx) => idx === i ? { ...x, email: e.target.value, error: "" } : x))}
                          placeholder="이메일 주소"
                          style={{ ...inputStyle, fontSize: 13, padding: "6px 10px", flex: 1, borderColor: entry.error ? "#dc2626" : "#d1d5db" }}
                        />
                        {entry.isPrimary ? (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 6, background: "#dbeafe", color: "#1d4ed8", whiteSpace: "nowrap", border: "1px solid #bfdbfe" }}>★ 대표</span>
                        ) : (
                          <button onClick={() => setEmailEntries(p => {
                              const sel = { ...p[i], isPrimary: true };
                              const rest = p.filter((_, idx) => idx !== i).map(x => ({ ...x, isPrimary: false }));
                              return [sel, ...rest];
                            })}
                            style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: "pointer", whiteSpace: "nowrap" }}>
                            대표 지정
                          </button>
                        )}
                        <button onClick={() => setEmailEntries(p => [...p, { email: "", isPrimary: false, error: "" }])}
                          style={{ fontSize: 14, fontWeight: 700, padding: "2px 8px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: "pointer", lineHeight: 1.4 }}
                          title="이메일 추가">+</button>
                        <button disabled={entry.isPrimary && emailEntries.length === 1}
                          onClick={() => {
                            const next = emailEntries.filter((_, idx) => idx !== i);
                            if (entry.isPrimary && next.length > 0) next[0].isPrimary = true;
                            setEmailEntries(next);
                          }}
                          style={{ fontSize: 14, fontWeight: 700, padding: "2px 8px", borderRadius: 6, border: "1px solid #fca5a5", background: "none", lineHeight: 1.4,
                            color: (entry.isPrimary && emailEntries.length === 1) ? "#d1d5db" : "#dc2626",
                            cursor: (entry.isPrimary && emailEntries.length === 1) ? "not-allowed" : "pointer" }}
                          title="이메일 삭제">−</button>
                      </div>
                      {entry.error && <p style={{ color: "#dc2626", fontSize: 11, margin: "3px 0 0" }}>{entry.error}</p>}
                    </div>
                  ))}
                </div>
              </div>
              {/* 언어 레벨 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>언어 레벨</label>
                <ClickSelect value={form.languageLevel} onChange={v => setForm(p => ({ ...p, languageLevel: v }))}
                  style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  options={[{ value: "", label: "선택 안 함" }, ...LANG_LEVEL_OPTIONS.map(l => ({ value: l, label: l }))]} />
              </div>
              {/* 소속업체 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>소속업체</label>
                <select value={form.affiliatedCompanyId} onChange={e => setForm(p => ({ ...p, affiliatedCompanyId: e.target.value }))}
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}>
                  <option value="">소속 없음 (프리랜서)</option>
                  {vendorCompanies.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                </select>
              </div>
              {/* 지역 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>지역</label>
                <input type="text" value={form.region} onChange={e => setForm(p => ({ ...p, region: e.target.value }))}
                  placeholder="서울, 경기..." style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
              </div>
              {/* 정산유형 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>정산유형</label>
                <ClickSelect value={form.settlementType} onChange={v => setForm(p => ({ ...p, settlementType: v }))}
                  style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  options={[
                    { value: "", label: "선택 안 함" },
                    { value: "개인", label: "개인 (3.3% 원천징수)" },
                    { value: "사업자", label: "사업자 (세금계산서)" },
                    { value: "업체정산", label: "업체정산 (소속업체 경유)" },
                  ]} />
              </div>
            </div>
          </div>

          {/* ═══════════════════════════════════════════
              3. 전문 정보
          ═══════════════════════════════════════════ */}
          {secRow("전문 정보")}
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 16 }}>
            {/* 가능언어 */}
            <div style={{ marginBottom: 10 }}>
              <label style={{ ...labelSt, fontSize: 11 }}>가능언어 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(수정 가능)</span></label>
              <input
                type="text"
                value={form.languagePairs}
                onChange={e => setForm(p => ({ ...p, languagePairs: e.target.value }))}
                placeholder="예: 한국어, 영어, 일본어"
                style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
              />
            </div>
            {/* 업무유형 */}
            <div style={{ marginBottom: 10 }}>
              <label style={labelSt}>업무유형 (프로필)</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {(PROFILE_WORK_TYPES as readonly string[]).map(wt => {
                  const selected = form.profileWorkTypes.split(",").map(s => s.trim()).filter(Boolean).includes(wt);
                  return (
                    <button key={wt} type="button"
                      onClick={() => {
                        const cur = form.profileWorkTypes.split(",").map(s => s.trim()).filter(Boolean);
                        const next = selected ? cur.filter(s => s !== wt) : [...cur, wt];
                        let nextSubTypes = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
                        if (selected) {
                          const validSubs = new Set(next.flatMap(t => PROFILE_SUB_TYPES_MAP[t] ?? []));
                          nextSubTypes = nextSubTypes.filter(st => validSubs.has(st));
                          setPinnedSubTypes(prev => new Set([...prev].filter(st => validSubs.has(st))));
                        }
                        setShowAllSubTypes(false);
                        setForm(p => ({ ...p, profileWorkTypes: next.join(","), profileSubTypes: nextSubTypes.join(",") }));
                      }}
                      style={{
                        padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
                        background: selected ? "#7c3aed" : "#f5f3ff",
                        color: selected ? "#fff" : "#7c3aed",
                        border: `1px solid ${selected ? "#7c3aed" : "#ddd8fe"}`,
                        fontWeight: selected ? 700 : 400,
                      }}>
                      {wt}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 세부유형 — 대표(pinned) 중심 UI: 기본은 pinned만 노출, 클릭 시 전체 펼침 */}
            {(() => {
              const selectedTypes = form.profileWorkTypes.split(",").map(s => s.trim()).filter(Boolean);
              const allSubs = Array.from(new Set(
                selectedTypes.flatMap(wt => PROFILE_SUB_TYPES_MAP[wt] ?? [])
              ));
              if (allSubs.length === 0) return null;
              const selectedSubSet = new Set(form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean));
              const sortedSubs = [
                ...allSubs.filter(s => pinnedSubTypes.has(s)),
                ...allSubs.filter(s => selectedSubSet.has(s) && !pinnedSubTypes.has(s)),
                ...allSubs.filter(s => !selectedSubSet.has(s)),
              ];
              // 기본: pinned만 표시. pinned 없으면 selected 최대 3개
              const defaultVisible = pinnedSubTypes.size > 0
                ? sortedSubs.filter(s => pinnedSubTypes.has(s))
                : sortedSubs.filter(s => selectedSubSet.has(s)).slice(0, 3);
              const visibleSubs = showAllSubTypes ? sortedSubs : defaultVisible;
              const hiddenCount = sortedSubs.length - visibleSubs.length;
              return (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <label style={{ ...labelSt, marginBottom: 0 }}>
                      세부유형 (프로필)
                      <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400, marginLeft: 6 }}>
                        ☆ 클릭으로 대표 지정 (최대 2개)
                      </span>
                    </label>
                    {(hiddenCount > 0 || showAllSubTypes) && (
                      <button type="button" onClick={() => setShowAllSubTypes(prev => !prev)}
                        style={{ fontSize: 11, color: "#6366f1", background: "none", border: "1px solid #e0e7ff", borderRadius: 6, cursor: "pointer", padding: "2px 8px", whiteSpace: "nowrap" }}>
                        {showAllSubTypes ? "접기" : `추가 ${hiddenCount}개 보기`}
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {visibleSubs.map(st => {
                      const selected = selectedSubSet.has(st);
                      const isPinned = pinnedSubTypes.has(st);
                      return (
                        <span key={st} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                          <button type="button"
                            onClick={() => {
                              const cur = form.profileSubTypes.split(",").map(s => s.trim()).filter(Boolean);
                              const next = selected ? cur.filter(s => s !== st) : [...cur, st];
                              if (selected && pinnedSubTypes.has(st)) {
                                setPinnedSubTypes(prev => { const n = new Set(prev); n.delete(st); return n; });
                              }
                              setForm(p => ({ ...p, profileSubTypes: next.join(",") }));
                            }}
                            style={{
                              padding: "3px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer",
                              background: isPinned ? "#065f46" : selected ? "#059669" : "#f0fdf4",
                              color: selected ? "#fff" : "#065f46",
                              border: `1px solid ${isPinned ? "#065f46" : selected ? "#059669" : "#a7f3d0"}`,
                              fontWeight: selected ? 700 : 400,
                            }}>
                            {isPinned && <span style={{ marginRight: 3, fontSize: 10 }}>★</span>}{st}
                          </button>
                          {selected && (
                            <button type="button" onClick={() => handleTogglePin(st)}
                              title={isPinned ? "대표 해제" : "대표로 지정"}
                              style={{ background: "none", border: "none", padding: "0 1px", fontSize: 12, cursor: "pointer", lineHeight: 1, color: isPinned ? "#f59e0b" : "#d1d5db" }}>
                              {isPinned ? "★" : "☆"}
                            </button>
                          )}
                        </span>
                      );
                    })}
                    {!showAllSubTypes && visibleSubs.length === 0 && (
                      <button type="button" onClick={() => setShowAllSubTypes(true)}
                        style={{ fontSize: 11, color: "#6366f1", background: "none", border: "1px dashed #c7d2fe", borderRadius: 6, cursor: "pointer", padding: "3px 10px" }}>
                        + 세부유형 선택
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}
            {/* 전문분야 */}
            {(() => {
              const parseList = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
              const selected = new Set(parseList(form.specializations));
              const presetSet = new Set<string>(SPECIALIZATION_PRESETS);
              const customVals = parseList(form.specializations).filter(x => !presetSet.has(x));

              const togglePreset = (tag: string) => {
                const cur = parseList(form.specializations);
                const next = cur.includes(tag) ? cur.filter(x => x !== tag) : [...cur, tag];
                setForm(p => ({ ...p, specializations: next.join(",") }));
              };

              const handleOtherToggle = () => {
                if (showOtherSpec) {
                  const presets = parseList(form.specializations).filter(x => presetSet.has(x));
                  setForm(p => ({ ...p, specializations: presets.join(",") }));
                  setShowOtherSpec(false);
                } else {
                  setShowOtherSpec(true);
                }
              };

              const handleCustomChange = (text: string) => {
                const presets = parseList(form.specializations).filter(x => presetSet.has(x));
                const customs = text.split(",").map(x => x.trim()).filter(Boolean);
                setForm(p => ({ ...p, specializations: [...presets, ...customs].join(",") }));
              };

              const tagStyle = (isSelected: boolean, colors: { bg: string; bgOff: string; fg: string; fgOff: string; border: string; borderOff: string }): React.CSSProperties => ({
                padding: "2px 8px", borderRadius: 20, fontSize: 11, cursor: "pointer",
                background: isSelected ? colors.bg : colors.bgOff,
                color: isSelected ? colors.fg : colors.fgOff,
                border: `1px solid ${isSelected ? colors.border : colors.borderOff}`,
                fontWeight: isSelected ? 700 : 400,
              });

              return (
                <div>
                  <label style={labelSt}>전문분야</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 4 }}>
                    {(SPECIALIZATION_PRESETS as readonly string[]).map(tag => {
                      const isSelected = selected.has(tag);
                      const isGeneral = tag === "범용 대응 가능";
                      return (
                        <button key={tag} type="button" onClick={() => togglePreset(tag)}
                          style={tagStyle(isSelected, isGeneral
                            ? { bg: "#059669", bgOff: "#ecfdf5", fg: "#fff", fgOff: "#065f46", border: "#059669", borderOff: "#a7f3d0" }
                            : { bg: "#2563eb", bgOff: "#eff6ff", fg: "#fff", fgOff: "#2563eb", border: "#2563eb", borderOff: "#bfdbfe" }
                          )}>{tag}</button>
                      );
                    })}
                    {/* 기타 */}
                    <button type="button" onClick={handleOtherToggle}
                      style={tagStyle(showOtherSpec, { bg: "#7c3aed", bgOff: "#f5f3ff", fg: "#fff", fgOff: "#7c3aed", border: "#7c3aed", borderOff: "#ddd8fe" })}>
                      기타
                    </button>
                  </div>
                  {showOtherSpec && (
                    <input
                      type="text"
                      value={customVals.join(", ")}
                      onChange={e => handleCustomChange(e.target.value)}
                      placeholder="예: 게임, 방산전자, 우주항공, 환경"
                      style={{ ...inputStyle, fontSize: 13, padding: "7px 10px", marginTop: 6 }}
                    />
                  )}
                </div>
              );
            })()}
          </div>

          {/* ═══ 4. 학력정보 (기본 접힘) ═══ */}
          {secRow("학력 정보", "education")}
          {!collapsed.education && (
            <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 16px" }}>
                <div>
                  <label style={labelSt}>학력</label>
                  <input type="text" value={form.education} onChange={e => setForm(p => ({ ...p, education: e.target.value }))}
                    placeholder="예: 서울대학교" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                </div>
                <div>
                  <label style={labelSt}>전공</label>
                  <input type="text" value={form.major} onChange={e => setForm(p => ({ ...p, major: e.target.value }))}
                    placeholder="예: 영어영문학" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                </div>
                <div>
                  <label style={labelSt}>졸업연도</label>
                  <input type="number" value={form.graduationYear} onChange={e => setForm(p => ({ ...p, graduationYear: e.target.value }))}
                    placeholder="예: 2018" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                </div>
              </div>
            </div>
          )}

          {/* ═══ 5. 이력서 & 상세정보 (기본 접힘) ═══ */}
          {secRow("이력서 & 상세정보", "resume")}
          {!collapsed.resume && (
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 10 }}>
            <div style={{ marginBottom: 12 }}>
              <label style={labelSt}>이력서 파일</label>
              {profile?.resumeUrl ? (
                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", marginBottom: 8,
                  background: "#f0fdf4", borderRadius: 8, border: "1px solid #a7f3d0",
                }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>📄</span>
                  <span
                    title={getResumeDisplayName(profile.resumeUrl, resumeFileName)}
                    style={{
                      fontSize: 12, color: "#065f46", fontWeight: 600,
                      flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                      whiteSpace: "nowrap", minWidth: 0,
                    }}
                  >
                    {getResumeDisplayName(profile.resumeUrl, resumeFileName)}
                  </span>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {canPreviewResume(getResumeExt(profile.resumeUrl)) && (
                      <button
                        type="button"
                        disabled={resumeUploading || resumeDeleting}
                        aria-label="이력서 미리보기"
                        onClick={async () => {
                          try {
                            const r = await fetch(api(`/api/admin/translators/${userId}/resume-url`), { headers: authH });
                            const d = await r.json();
                            if (!r.ok) { onToast(`오류: ${d.error}`); return; }
                            if (!d.downloadUrl) { onToast("미리보기 URL을 가져올 수 없습니다."); return; }
                            window.open(d.downloadUrl, "_blank", "noopener,noreferrer");
                          } catch {
                            onToast("오류: URL 생성 실패");
                          }
                        }}
                        style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151", whiteSpace: "nowrap" }}>
                        미리보기
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={resumeUploading || resumeDeleting}
                      aria-label="이력서 다운로드"
                      onClick={() => {
                        const a = document.createElement("a");
                        a.href = api(`/api/admin/translators/${userId}/resume-download`) + `?token=${encodeURIComponent(token)}`;
                        a.style.display = "none";
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                      }}
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151", whiteSpace: "nowrap" }}>
                      다운로드
                    </button>
                    <button
                      type="button"
                      disabled={resumeDeleting || resumeUploading}
                      aria-label="이력서 삭제"
                      onClick={async () => {
                        if (!window.confirm("이력서를 삭제하시겠습니까?")) return;
                        setResumeDeleting(true);
                        try {
                          const r = await fetch(api(`/api/admin/translators/${userId}/resume`), { method: "DELETE", headers: authH });
                          if (r.ok) {
                            setProfile(p => p ? { ...p, resumeUrl: null } : p);
                            setResumeFileName(null);
                            onToast("이력서가 삭제되었습니다.");
                          } else { const d = await r.json(); onToast(`오류: ${d.error}`); }
                        } catch { onToast("오류: 이력서 삭제 실패"); }
                        finally { setResumeDeleting(false); }
                      }}
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #fca5a5", background: "#fff5f5", cursor: "pointer", color: "#b91c1c", whiteSpace: "nowrap" }}>
                      {resumeDeleting ? "삭제 중..." : "삭제"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAnalyzePanel(true)}
                      aria-label="AI 이력서 분석"
                      data-testid="btn-open-analyze"
                      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #059669", background: "#f0fdf4", cursor: "pointer", color: "#065f46", fontWeight: 600, whiteSpace: "nowrap" }}>
                      ✨ AI 분석
                    </button>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 6px" }}>이력서 없음 — 아래에서 업로드해 주세요.</p>
              )}
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (!file) return;
                  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
                  if (!(RESUME_ALLOWED_EXTS as readonly string[]).includes(ext)) {
                    onToast(RESUME_UPLOAD_ERROR_MSG);
                    return;
                  }
                  if (profile?.resumeUrl && !window.confirm("기존 이력서를 새 파일로 교체하시겠습니까?")) return;
                  setResumeFile(file);
                }}
                style={{
                  border: `2px dashed ${dragOver ? "#059669" : "#d1d5db"}`,
                  borderRadius: 8,
                  padding: "10px 14px",
                  background: dragOver ? "#f0fdf4" : "#f9fafb",
                  transition: "border-color 0.15s, background 0.15s",
                  textAlign: "center" as const,
                }}
              >
                <p style={{ fontSize: 11, color: dragOver ? "#059669" : "#9ca3af", margin: "0 0 8px", fontWeight: dragOver ? 600 : 400 }}>
                  {dragOver ? "여기에 파일을 놓으세요" : `파일을 드래그하거나 아래 버튼으로 선택 (${RESUME_HINT})`}
                </p>
                {resumeFile && (
                  <p style={{ fontSize: 12, color: "#059669", margin: "0 0 8px", fontWeight: 600 }}>
                    📎 {resumeFile.name}
                  </p>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
                  <label
                    style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151" }}
                    aria-label="파일 선택"
                  >
                    파일 선택
                    <input
                      type="file"
                      accept={RESUME_ACCEPT}
                      onChange={e => {
                        const file = e.target.files?.[0] ?? null;
                        if (!file) return;
                        if (profile?.resumeUrl && !window.confirm("기존 이력서를 새 파일로 교체하시겠습니까?")) {
                          e.target.value = "";
                          return;
                        }
                        setResumeFile(file);
                      }}
                      style={{ display: "none" }}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!resumeFile || resumeUploading}
                    onClick={async () => {
                      if (!resumeFile) return;
                      setResumeUploading(true);
                      try {
                        const fd = new FormData();
                        fd.append("file", resumeFile);
                        const r = await fetch(api(`/api/admin/translators/${userId}/resume-upload`), {
                          method: "POST",
                          headers: { Authorization: `Bearer ${token}` },
                          body: fd,
                        });
                        const d = await r.json();
                        if (r.ok) {
                          setProfile(p => p ? { ...p, resumeUrl: d.resumeUrl } : p);
                          setResumeFileName(d.fileName ?? null);
                          setResumeFile(null);
                          onToast("이력서가 업로드되었습니다.");
                        } else {
                          onToast(`오류: ${d.error}`);
                        }
                      } catch { onToast("오류: 이력서 업로드 실패"); }
                      finally { setResumeUploading(false); }
                    }}
                    style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #6366f1", background: resumeFile ? "#6366f1" : "#e0e0e0", color: resumeFile ? "#fff" : "#999", cursor: resumeFile ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}>
                    {resumeUploading ? "업로드 중..." : "업로드"}
                  </button>
                </div>
              </div>
            </div>
            <div>
              <label style={labelSt}>상세정보 (경력·특이사항)</label>
              <textarea value={form.bio} onChange={e => setForm(p => ({ ...p, bio: e.target.value }))}
                rows={3} style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
            </div>
          </div>
          )} {/* !collapsed.resume */}

          {/* ═══ 6. 운영 정보 — 통합 섹션 (기본 접힘) ═══ */}
          {secRow("운영 정보", "operational")}
          {!collapsed.operational && (
            <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 10 }}>
              {/* 등급 / 평점 / 가용상태 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 16px", marginBottom: 12 }}>
                <div>
                  <label style={labelSt}>등급</label>
                  <ClickSelect value={form.grade} onChange={v => setForm(p => ({ ...p, grade: v }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[{ value: "", label: "등급 없음" }, ...GRADE_OPTIONS.map(g => ({ value: g, label: `${g}등급` }))]} />
                </div>
                <div>
                  <label style={labelSt}>평점 (1-5)</label>
                  <input type="number" value={form.rating} onChange={e => setForm(p => ({ ...p, rating: e.target.value }))}
                    placeholder="예: 4.5" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
                </div>
                <div>
                  <label style={labelSt}>가용 상태</label>
                  <ClickSelect value={form.availabilityStatus} onChange={v => setForm(p => ({ ...p, availabilityStatus: v }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[
                      { value: "available", label: "가능" }, { value: "busy", label: "바쁨" }, { value: "unavailable", label: "불가" },
                    ]} />
                </div>
              </div>
              {/* 운영상태 / 재배정 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginBottom: 12 }}>
                <div>
                  <label style={labelSt}>운영상태</label>
                  <ClickSelect value={form.operationalStatus} onChange={v => setForm(p => ({ ...p, operationalStatus: v }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[
                      { value: "normal",   label: "✅ 정상" },
                      { value: "warning",  label: "⚠️ 주의" },
                      { value: "hold",     label: "⏸ 보류" },
                      { value: "excluded", label: "🚫 제외" },
                    ]} />
                </div>
                <div>
                  <label style={labelSt}>재배정 가능 여부</label>
                  <ClickSelect value={form.reassignmentAllowed ? "true" : "false"}
                    onChange={v => setForm(p => ({ ...p, reassignmentAllowed: v === "true" }))}
                    style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                    options={[{ value: "true", label: "가능" }, { value: "false", label: "불가" }]} />
                </div>
              </div>
              {/* 운영메모 */}
              <div>
                <label style={labelSt}>운영메모 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(내부 전용 — 외부 비공개)</span></label>
                <textarea value={form.operationalNote} onChange={e => setForm(p => ({ ...p, operationalNote: e.target.value }))}
                  rows={3} placeholder="컴플레인 이력, 운영 리스크, 관리자 메모 등"
                  style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
              </div>
            </div>
          )}

          {/* ── 단가 관리 (기본 접힘) ── */}
          {secRow("단가 관리", "rates")}
          {!collapsed.rates && (
            <>
              <div style={{ marginBottom: 10 }}>
                <TranslatorRateEntryCard
                  value={rateForm}
                  onChange={patch => setRateForm(p => ({ ...p, ...patch }))}
                  actionLabel="+ 추가"
                  onAction={handleAddRate}
                  actionLoading={addingRate}
                />
              </div>
              {rates.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
                  {rates.map(r => (
                    <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: r.isActive === false ? "#f3f4f6" : "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", fontSize: 13, flexWrap: "wrap", opacity: r.isActive === false ? 0.65 : 1 }}>
                      <span style={{ fontWeight: 700, color: "#374151", minWidth: 40 }}>{r.serviceType}</span>
                      {r.subType && <span style={{ color: "#6366f1", fontWeight: 600, minWidth: 52 }}>{r.subType}</span>}
                      {(r.language || r.languagePair) && (
                        <span style={{ color: "#3b82f6", minWidth: 60 }}>{r.language ?? "??"}{r.languagePair ? ` → ${r.languagePair}` : ""}</span>
                      )}
                      <span style={{ color: "#6b7280", minWidth: 40 }}>{getUnitLabel(r.unit)}</span>
                      <span style={{ fontWeight: 700, color: "#059669", minWidth: 80 }}>{r.rate.toLocaleString()}{r.currency !== "KRW" ? ` ${r.currency}` : "원"}</span>
                      {r.vatIncluded && <span style={{ fontSize: 11, background: "#fef3c7", color: "#92400e", borderRadius: 4, padding: "1px 5px" }}>VAT포함</span>}
                      {r.isDefault && <span style={{ fontSize: 11, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 5px" }}>기본</span>}
                      {r.isActive === false && <span style={{ fontSize: 11, background: "#f3f4f6", color: "#9ca3af", borderRadius: 4, padding: "1px 5px" }}>비활성</span>}
                      {r.memo && <span style={{ color: "#9ca3af", fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.memo}</span>}
                      {!r.memo && <span style={{ flex: 1 }} />}
                      <button onClick={() => handleDeleteRate(r.id)} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 12, cursor: "pointer", padding: "2px 4px" }}>삭제</button>
                    </div>
                  ))}
                </div>
              ) : <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0 14px" }}>등록된 단가가 없습니다.</p>}
            </>
          )}

          {/* ── 하단 바 ── */}
          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {hasPerm("translator.sensitive") ? (
              <button onClick={() => setShowSensitive(true)}
                style={{ display: "flex", alignItems: "center", gap: 6, background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#92400e", cursor: "pointer" }}>
                🔒 정산 정보 관리
              </button>
            ) : <span />}
            <GhostBtn onClick={onClose} style={{ fontSize: 14, padding: "9px 20px" }}>닫기</GhostBtn>
          </div>
        </>
      )}
    </DraggableModal>

    {showSensitive && hasPerm("translator.sensitive") && (
      <SensitiveInfoModal
        userId={userId}
        userName={profile?.bio ? `${userEmail} (${profile.bio})` : userEmail}
        token={token}
        onClose={() => setShowSensitive(false)}
        onToast={onToast}
      />
    )}

    {showAnalyzePanel && (
      <ResumeAnalyzePanel
        userId={userId}
        token={token}
        hasResume={!!profile?.resumeUrl}
        autoStart={true}
        onToast={onToast}
        onClose={() => setShowAnalyzePanel(false)}
        onApply={(result: ResumeAnalysisResult) => {
          setForm(prev => ({
            ...prev,
            ...(result.name ? { name: result.name } : {}),
            ...(result.languagePairs ? { languagePairs: result.languagePairs } : {}),
            ...(result.education ? { education: result.education } : {}),
            ...(result.major ? { major: result.major } : {}),
            ...(result.graduationYear ? { graduationYear: String(result.graduationYear) } : {}),
            ...(result.specializations ? { specializations: result.specializations } : {}),
            ...(result.profileWorkTypes ? { profileWorkTypes: result.profileWorkTypes } : {}),
            ...(result.profileSubTypes ? { profileSubTypes: result.profileSubTypes } : {}),
            ...(result.region ? { region: result.region } : {}),
            ...(result.bio ? { bio: result.bio } : {}),
          }));
          setShowAnalyzePanel(false);
        }}
      />
    )}
    </>
  );
}
