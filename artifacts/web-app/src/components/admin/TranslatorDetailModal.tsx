import React, { useState, useEffect } from "react";
import { api, TranslatorProfile, TranslatorRate, NoteEntry } from "../../lib/constants";
import { PrimaryBtn, GhostBtn, ClickSelect } from "../ui";
import { ReviewMemoPanel } from "./ReviewMemoPanel";
import { DraggableModal } from "./DraggableModal";
import { SensitiveInfoModal } from "./SensitiveInfoModal";

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #d1d5db", fontSize: 14, color: "#111827",
  outline: "none", boxSizing: "border-box", background: "#fff",
};

const GRADE_OPTIONS = ["S", "A", "B", "C"];
const LANG_LEVEL_OPTIONS = ["일반", "전문"];
const WORK_TYPES = ["번역", "통역", "편집", "감수", "직접입력"];
const SUB_TYPES_MAP: Record<string, string[]> = {
  "번역": ["일반번역", "전문번역", "긴급번역", "공증번역"],
  "통역": ["동시통역", "순차통역", "수행통역", "미팅통역", "전시회통역", "전화통역", "화상통역"],
  "편집": ["원어민감수", "윤문", "교정", "편집", "DTP"],
  "감수": ["번역감수", "전문감수", "원어민감수"],
  "직접입력": [],
};
const TRANS_UNITS = [
  { value: "word", label: "단어" }, { value: "eojeol", label: "어절" },
  { value: "char", label: "글자" }, { value: "page", label: "페이지" }, { value: "item", label: "건" },
];
const INTERP_UNITS = [
  { value: "1h", label: "1시간" }, { value: "2h", label: "2시간" },
  { value: "4h", label: "4시간" }, { value: "6h", label: "6시간" },
  { value: "8h", label: "8시간" }, { value: "extra", label: "추가시간" },
  { value: "day", label: "일" }, { value: "item", label: "건" },
];
const UNIT_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  "번역": TRANS_UNITS, "통역": INTERP_UNITS, "편집": TRANS_UNITS,
  "감수": TRANS_UNITS, "직접입력": [...TRANS_UNITS, ...INTERP_UNITS.filter(u => u.value !== "item")],
};
const ALL_UNITS = [...TRANS_UNITS, ...INTERP_UNITS.filter(u => !TRANS_UNITS.some(t => t.value === u.value))];
const getUnitLabel = (unit: string) => ALL_UNITS.find(u => u.value === unit)?.label ?? unit;
const LANG_OPTIONS = [
  "한국어", "영어", "일본어", "중국어", "러시아어", "스페인어", "독일어", "프랑스어",
  "아랍어", "이탈리아어", "터키어", "포르투갈어", "폴란드어", "스웨덴어", "네덜란드어",
  "그리스어", "체코어", "페르시아어", "히브리어", "베트남어", "몽골어", "태국어",
  "인도네시아어", "캄보디아어", "인도어", "파키스탄어", "스리랑카어", "방글라데시어",
  "미얀마어", "라오스어", "광동어", "우즈베키스탄어", "우크라이나어", "기타",
];

type EmailEntry = { email: string; isPrimary: boolean; error: string };
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatPhoneNumber(value: string): string {
  const n = value.replace(/\D/g, "");
  if (n.length <= 3) return n;
  if (n.length <= 7) return `${n.slice(0, 3)}-${n.slice(3)}`;
  return `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7, 11)}`;
}

export function TranslatorDetailModal({ userId, userEmail, token, permissions = [], onClose, onToast, onDeleted }: {
  userId: number; userEmail: string; token: string;
  permissions?: string[];
  onClose: () => void; onToast: (msg: string) => void;
  onDeleted?: () => void;
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
  const [rateForm, setRateForm] = useState({ workType: "번역", subType: "일반번역", sourceLang: "한국어", sourceCustom: "", targetLang: "영어", targetCustom: "", unit: "eojeol", rate: "", memo: "" });
  const [addingRate, setAddingRate] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeDeleting, setResumeDeleting] = useState(false);

  const [form, setForm] = useState({
    name: "",
    phone: "",
    languagePairs: "", languageLevel: "", specializations: "", education: "", major: "",
    graduationYear: "", region: "", grade: "", rating: "", availabilityStatus: "available",
    bio: "",
  });

  const authH = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    try {
      const [dRes, nRes] = await Promise.all([
        fetch(api(`/api/admin/translators/${userId}`), { headers: authH }),
        fetch(api(`/api/admin/notes?entityType=translator&entityId=${userId}`), { headers: authH }),
      ]);
      const [dData, nData] = await Promise.all([dRes.json(), nRes.json()]);
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
        });
      }
      if (nRes.ok) setNotes(Array.isArray(nData) ? nData : []);
    } catch { onToast("오류: 통번역사 정보 불러오기 실패"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [userId]);

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
      }));
      // 대표 이메일 변경 시 userInfo 갱신
      const newPrimary = validated.find(e => e.isPrimary)?.email.trim().toLowerCase() ?? "";
      if (newPrimary) setUserInfo(prev => prev ? { ...prev, email: newPrimary } : prev);
      onToast("통번역사 프로필이 저장되었습니다.");
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
          memo: rateForm.memo || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { onToast(`오류: ${data.error}`); return; }
      setRates(prev => [data, ...prev]);
      setRateForm({ workType: "번역", subType: "일반번역", sourceLang: "한국어", sourceCustom: "", targetLang: "영어", targetCustom: "", unit: "eojeol", rate: "", memo: "" });
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
    fontSize: 12, fontWeight: 700, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.06em",
    margin: "20px 0 10px", paddingBottom: 6, borderBottom: "1px solid #f3f4f6",
  };
  const labelSt: React.CSSProperties = { fontSize: 12, color: "#6b7280", display: "block", marginBottom: 3 };
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
    <DraggableModal title="통번역사 상세" subtitle={userEmail} onClose={onClose} width={860} zIndex={300} bodyPadding="20px 28px"
      headerExtra={
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
          <ReviewMemoPanel storageKey={`translator_${userId}`} label="이 통번역사 검수 메모" />

          {/* ── 기본 정보 ── */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, marginTop: 16 }}>
            <p style={{ ...sH, margin: 0, border: "none", paddingBottom: 0 }}>기본 정보</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {userInfo?.invitePending ? (
                <>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fef3c7", color: "#92400e", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>
                    ⏳ 초대 대기
                  </span>
                  <button
                    onClick={handleReinvite}
                    disabled={reinviting}
                    style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: reinviting ? "not-allowed" : "pointer", fontWeight: 600 }}>
                    {reinviting ? "처리 중..." : "🔗 링크 재발급"}
                  </button>
                </>
              ) : (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#d1fae5", color: "#065f46", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>
                  ✓ 계정 활성
                </span>
              )}
            </div>
          </div>
          <div style={{ background: "#f9fafb", borderRadius: 10, border: "1px solid #f3f4f6", padding: "14px 16px", marginBottom: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 20px" }}>
              {/* 이름 — 수정 가능 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>이름 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(저장 버튼으로 반영)</span></label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="이름 입력"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
                />
              </div>
              {/* 이메일 목록 — 모두 편집 가능, 대표 지정 가능 */}
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ ...labelSt, fontSize: 11 }}>
                  이메일 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(저장 버튼으로 반영 · 대표 이메일은 로그인에 사용됨)</span>
                </label>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 6 }}>
                  {emailEntries.map((entry, i) => (
                    <div key={i}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="email"
                          value={entry.email}
                          onChange={e => setEmailEntries(p => p.map((x, idx) => idx === i ? { ...x, email: e.target.value, error: "" } : x))}
                          placeholder="이메일 주소"
                          style={{ ...inputStyle, fontSize: 13, padding: "6px 10px", flex: 1, borderColor: entry.error ? "#dc2626" : "#d1d5db" }}
                        />
                        {entry.isPrimary ? (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 6, background: "#dbeafe", color: "#1d4ed8", whiteSpace: "nowrap", border: "1px solid #bfdbfe" }}>
                            ★ 대표
                          </span>
                        ) : (
                          <button
                            onClick={() => setEmailEntries(p => {
                              const selected = { ...p[i], isPrimary: true };
                              const rest = p.filter((_, idx) => idx !== i).map(x => ({ ...x, isPrimary: false }));
                              return [selected, ...rest];
                            })}
                            style={{ fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#374151", cursor: "pointer", whiteSpace: "nowrap" }}>
                            대표로 지정
                          </button>
                        )}
                        <button
                          disabled={entry.isPrimary && emailEntries.length === 1}
                          onClick={() => {
                            const next = emailEntries.filter((_, idx) => idx !== i);
                            // 삭제된 항목이 대표였다면 남은 첫 번째를 대표로
                            if (entry.isPrimary && next.length > 0) next[0].isPrimary = true;
                            setEmailEntries(next);
                          }}
                          style={{
                            background: "none", border: "1px solid #fca5a5", borderRadius: 6,
                            color: (entry.isPrimary && emailEntries.length === 1) ? "#d1d5db" : "#dc2626",
                            fontSize: 13, padding: "5px 10px", cursor: (entry.isPrimary && emailEntries.length === 1) ? "not-allowed" : "pointer",
                            whiteSpace: "nowrap",
                          }}>
                          삭제
                        </button>
                      </div>
                      {entry.error && <p style={{ color: "#dc2626", fontSize: 11, margin: "3px 0 0" }}>{entry.error}</p>}
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setEmailEntries(p => [...p, { email: "", isPrimary: false, error: "" }])}
                  style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 7, border: "1.5px dashed #9ca3af", background: "#f9fafb", color: "#374151", cursor: "pointer" }}>
                  + 이메일 추가
                </button>
              </div>
              {/* 휴대폰 — 편집 가능 + 자동 포맷 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>휴대폰번호 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(수정 가능)</span></label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={e => setForm(p => ({ ...p, phone: formatPhoneNumber(e.target.value) }))}
                  placeholder="010-0000-0000"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
                />
              </div>
              {/* 지역 — 편집 가능 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>지역 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(수정 가능)</span></label>
                <input
                  type="text"
                  value={form.region}
                  onChange={e => setForm(p => ({ ...p, region: e.target.value }))}
                  placeholder="서울, 경기..."
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
                />
              </div>
              {/* 언어쌍 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>언어쌍 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(수정 가능)</span></label>
                <input
                  type="text"
                  value={form.languagePairs}
                  onChange={e => setForm(p => ({ ...p, languagePairs: e.target.value }))}
                  placeholder="예: 한→영, 영→한"
                  style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }}
                />
              </div>
              {/* 언어 레벨 */}
              <div>
                <label style={{ ...labelSt, fontSize: 11 }}>언어 레벨 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(수정 가능)</span></label>
                <ClickSelect value={form.languageLevel} onChange={v => setForm(p => ({ ...p, languageLevel: v }))}
                  style={{ width: "100%" }} triggerStyle={{ width: "100%", fontSize: 13, padding: "7px 10px", borderRadius: 8 }}
                  options={[{ value: "", label: "선택 안 함" }, ...LANG_LEVEL_OPTIONS.map(l => ({ value: l, label: l }))]} />
              </div>
            </div>
          </div>

          {/* ── 프로필 편집 ── */}
          <p style={sH}>프로필 편집</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", marginBottom: 12 }}>
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
            <div>
              <label style={labelSt}>전문분야</label>
              <input type="text" value={form.specializations} onChange={e => setForm(p => ({ ...p, specializations: e.target.value }))}
                placeholder="예: 법률, IT, 의학" style={{ ...inputStyle, fontSize: 13, padding: "7px 10px" }} />
            </div>
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
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelSt}>이력서 파일</label>
              {profile?.resumeUrl ? (
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#374151", background: "#f3f4f6", borderRadius: 6, padding: "4px 8px" }}>
                    📄 이력서 등록됨
                  </span>
                  <button
                    type="button"
                    disabled={resumeUploading || resumeDeleting}
                    onClick={async () => {
                      try {
                        const r = await fetch(api(`/api/admin/translators/${userId}/resume-url`), { headers: authH });
                        const d = await r.json();
                        if (r.ok) window.open(d.downloadUrl, "_blank");
                        else onToast(`오류: ${d.error}`);
                      } catch { onToast("오류: 다운로드 URL 생성 실패"); }
                    }}
                    style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer", color: "#374151" }}>
                    다운로드
                  </button>
                  <button
                    type="button"
                    disabled={resumeDeleting || resumeUploading}
                    onClick={async () => {
                      if (!window.confirm("이력서를 삭제하시겠습니까?")) return;
                      setResumeDeleting(true);
                      try {
                        const r = await fetch(api(`/api/admin/translators/${userId}/resume`), { method: "DELETE", headers: authH });
                        if (r.ok) { setProfile(p => p ? { ...p, resumeUrl: null } : p); onToast("이력서가 삭제되었습니다."); }
                        else { const d = await r.json(); onToast(`오류: ${d.error}`); }
                      } catch { onToast("오류: 이력서 삭제 실패"); }
                      finally { setResumeDeleting(false); }
                    }}
                    style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid #fca5a5", background: "#fff5f5", cursor: "pointer", color: "#b91c1c" }}>
                    {resumeDeleting ? "삭제 중..." : "삭제"}
                  </button>
                </div>
              ) : (
                <span style={{ fontSize: 12, color: "#9ca3af" }}>이력서 없음</span>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={e => setResumeFile(e.target.files?.[0] ?? null)}
                  style={{ fontSize: 12, flex: 1, minWidth: 0 }}
                />
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
          <div style={{ marginBottom: 12 }}>
            <label style={labelSt}>상세정보 (경력·특이사항)</label>
            <textarea value={form.bio} onChange={e => setForm(p => ({ ...p, bio: e.target.value }))}
              rows={3} style={{ ...inputStyle, fontSize: 13, padding: "8px 10px", resize: "vertical" }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
            <PrimaryBtn onClick={handleSave} disabled={saving} style={{ fontSize: 13, padding: "8px 20px" }}>
              {saving ? "저장 중..." : "프로필 저장"}
            </PrimaryBtn>
            {form.grade && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fef3c7", color: "#92400e", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>
                ★ {form.grade}등급
              </span>
            )}
            {form.languageLevel && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#ede9fe", color: "#5b21b6", borderRadius: 20, padding: "3px 10px", fontSize: 12, fontWeight: 600 }}>
                {form.languageLevel}
              </span>
            )}
          </div>

          {/* ── 단가 관리 ── */}
          <p style={sH}>단가 관리 ({rates.length})</p>
          {/* 단가 추가 폼 - 2행 4열 */}
          <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 12px", marginBottom: 10 }}>
            {/* 행1: 업무유형 / 세부유형 / 출발언어 / 도착언어 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "6px 8px", marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>업무유형</div>
                <ClickSelect value={rateForm.workType}
                  onChange={v => {
                    const units = UNIT_BY_TYPE[v] ?? TRANS_UNITS;
                    const defaultUnit = units[0]?.value ?? "eojeol";
                    const subs = SUB_TYPES_MAP[v] ?? [];
                    const defaultSub = subs[0] ?? "";
                    setRateForm(p => ({ ...p, workType: v, subType: defaultSub, unit: defaultUnit }));
                  }}
                  triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
                  options={WORK_TYPES.map(w => ({ value: w, label: w }))} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>세부유형</div>
                {rateForm.workType === "직접입력" ? (
                  <input value={rateForm.subType} onChange={e => setRateForm(p => ({ ...p, subType: e.target.value }))}
                    placeholder="세부유형 입력" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
                ) : (
                  <ClickSelect value={rateForm.subType}
                    onChange={v => setRateForm(p => ({ ...p, subType: v }))}
                    triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
                    options={[{ value: "", label: "세부유형 선택" }, ...(SUB_TYPES_MAP[rateForm.workType] ?? []).map(s => ({ value: s, label: s }))]} />
                )}
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>출발 언어</div>
                <ClickSelect value={rateForm.sourceLang}
                  onChange={v => setRateForm(p => ({ ...p, sourceLang: v, sourceCustom: "" }))}
                  triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
                  options={LANG_OPTIONS.map(l => ({ value: l, label: l }))} />
                {rateForm.sourceLang === "기타" && (
                  <input value={rateForm.sourceCustom}
                    onChange={e => setRateForm(p => ({ ...p, sourceCustom: e.target.value }))}
                    placeholder="언어명 입력 (예: 말레이어)"
                    style={{ ...inputStyle, fontSize: 12, padding: "5px 8px", marginTop: 4 }} />
                )}
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>도착 언어</div>
                <ClickSelect value={rateForm.targetLang}
                  onChange={v => setRateForm(p => ({ ...p, targetLang: v, targetCustom: "" }))}
                  triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
                  options={LANG_OPTIONS.map(l => ({ value: l, label: l }))} />
                {rateForm.targetLang === "기타" && (
                  <input value={rateForm.targetCustom}
                    onChange={e => setRateForm(p => ({ ...p, targetCustom: e.target.value }))}
                    placeholder="언어명 입력 (예: 말레이어)"
                    style={{ ...inputStyle, fontSize: 12, padding: "5px 8px", marginTop: 4 }} />
                )}
              </div>
            </div>
            {/* 행2: 단가단위 / 단가(원) / 메모 / [+추가] */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 1fr auto", gap: "6px 8px", alignItems: "end" }}>
              <div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>단가단위</div>
                <ClickSelect value={rateForm.unit}
                  onChange={v => setRateForm(p => ({ ...p, unit: v }))}
                  triggerStyle={{ fontSize: 13, padding: "6px 10px", borderRadius: 7, width: "100%" }}
                  options={UNIT_BY_TYPE[rateForm.workType] ?? TRANS_UNITS} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>단가 (원)</div>
                <input type="number" value={rateForm.rate}
                  onChange={e => setRateForm(p => ({ ...p, rate: e.target.value }))}
                  placeholder="예: 40" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>메모</div>
                <input value={rateForm.memo} onChange={e => setRateForm(p => ({ ...p, memo: e.target.value }))}
                  placeholder="메모 (선택)" style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }} />
              </div>
              <PrimaryBtn onClick={handleAddRate} disabled={addingRate}
                style={{ fontSize: 12, padding: "6px 14px", whiteSpace: "nowrap", alignSelf: "flex-end" }}>
                {addingRate ? "추가 중..." : "+ 추가"}
              </PrimaryBtn>
            </div>
          </div>
          {rates.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 4 }}>
              {rates.map(r => (
                <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #f3f4f6", fontSize: 13, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, color: "#374151", minWidth: 40 }}>{r.serviceType}</span>
                  {r.subType && <span style={{ color: "#6366f1", fontWeight: 600, minWidth: 52 }}>{r.subType}</span>}
                  {(r.language || r.languagePair) && (
                    <span style={{ color: "#3b82f6", minWidth: 60 }}>
                      {r.language ?? "??"}{r.languagePair ? ` → ${r.languagePair}` : ""}
                    </span>
                  )}
                  <span style={{ color: "#6b7280", minWidth: 40 }}>{getUnitLabel(r.unit)}</span>
                  <span style={{ fontWeight: 700, color: "#059669", minWidth: 80 }}>{r.rate.toLocaleString()}원</span>
                  {r.memo && <span style={{ color: "#9ca3af", fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.memo}</span>}
                  {!r.memo && <span style={{ flex: 1 }} />}
                  <button onClick={() => handleDeleteRate(r.id)} style={{ background: "none", border: "none", color: "#dc2626", fontSize: 12, cursor: "pointer", padding: "2px 4px" }}>삭제</button>
                </div>
              ))}
            </div>
          ) : <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0" }}>등록된 단가가 없습니다.</p>}

          {/* ── 메모 ── */}
          <p style={sH}>메모 ({notes.length})</p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="메모 입력..."
              style={{ ...inputStyle, flex: 1, fontSize: 13, padding: "7px 10px" }}
              onKeyDown={e => e.key === "Enter" && handleAddNote()} />
            <PrimaryBtn onClick={handleAddNote} disabled={addingNote || !noteText.trim()} style={{ fontSize: 13, padding: "7px 14px" }}>
              {addingNote ? "추가 중..." : "추가"}
            </PrimaryBtn>
          </div>
          {notes.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, padding: "6px 0" }}>메모가 없습니다.</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {notes.map(n => (
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
          <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            {hasPerm("translator.sensitive") ? (
              <button
                onClick={() => setShowSensitive(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8,
                  padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#92400e",
                  cursor: "pointer",
                }}
              >
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
    </>
  );
}
