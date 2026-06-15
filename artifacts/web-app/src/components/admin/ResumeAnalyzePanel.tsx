import React, { useState, useEffect } from "react";
import { api, parseLangExperiences, LangExpEntry } from "../../lib/constants";

export interface ResumeDebugInfo {
  sourceType: "file_upload" | "stored_file";
  fileName: string;
  extractedTextLength: number;
  extractedTextPreview: string;
  aiCalled: boolean;
  currentValuesUsed: boolean;
  jsonParseFailed?: boolean;
}

export interface ResumeAnalysisResult {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  languagePairs: string | null;
  referenceLangs: string | null;
  languageLevel: string | null;
  education: string | null;
  major: string | null;
  graduationYear: number | null;
  graduationStatus: string | null;
  specializations: string | null;
  profileWorkTypes: string | null;
  profileSubTypes: string | null;
  region: string | null;
  careerYears: string | null;
  certifications: string | null;
  bio: string | null;
  languageExperiences: string | null;
  confidence: "high" | "medium" | "low";
  notes: string | null;
  _debug?: ResumeDebugInfo;
}

export type ResumeFieldKey = Exclude<keyof ResumeAnalysisResult, "_debug">;
export type ResumeCurrentValues = Partial<Record<ResumeFieldKey, string | number | null>>;

type Props = {
  token: string;
  currentValues?: ResumeCurrentValues;
  onApply: (result: ResumeAnalysisResult) => void;
  onToast: (msg: string) => void;
  onClose: () => void;
  autoStart?: boolean;
} & (
  | { userId: number; hasResume: boolean; file?: never }
  | { userId?: never; hasResume?: never; file: File }
);

const FIELD_LABELS: { key: ResumeFieldKey; label: string; multiline?: boolean; section?: string; readOnly?: boolean }[] = [
  // 기본정보
  { key: "name",            label: "이름",             section: "기본정보" },
  { key: "phone",           label: "휴대폰",            section: "기본정보" },
  { key: "email",           label: "이메일",            section: "기본정보" },
  { key: "address",         label: "주소",              section: "기본정보" },
  { key: "region",          label: "거주지역",           section: "기본정보" },
  // 학력
  { key: "education",       label: "학력",              section: "학력" },
  { key: "major",           label: "전공",              section: "학력" },
  { key: "graduationYear",  label: "졸업연도",           section: "학력" },
  { key: "graduationStatus",label: "졸업상태",           section: "학력" },
  // 전문정보
  { key: "languagePairs",   label: "가능언어 (업무 가능)",  section: "전문정보" },
  { key: "referenceLangs",  label: "참고언어 (학습 이력)", section: "전문정보", readOnly: true },
  { key: "languageLevel",   label: "언어레벨",           section: "전문정보" },
  { key: "profileWorkTypes",label: "업무유형",           section: "전문정보" },
  { key: "profileSubTypes", label: "세부유형",           section: "전문정보" },
  { key: "specializations", label: "전문분야",           section: "전문정보" },
  // 운영정보
  { key: "careerYears",          label: "경력연수",               section: "운영정보" },
  { key: "certifications",       label: "자격증",                 section: "운영정보" },
  { key: "bio",                  label: "상세정보 (경력요약)",     section: "운영정보", multiline: true },
  { key: "languageExperiences",  label: "언어·국제경험 (자동생성)", section: "운영정보", readOnly: true },
];

const confidenceColor: Record<string, string> = {
  high: "#059669",
  medium: "#d97706",
  low: "#dc2626",
};

const confidenceLabel: Record<string, string> = {
  high: "높음",
  medium: "보통",
  low: "낮음",
};

function toStr(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v);
}

function isChanged(current: string | number | null | undefined, extracted: string | number | null): boolean {
  const c = toStr(current);
  const e = toStr(extracted);
  return e !== "" && c !== e;
}

export const ResumeAnalyzePanel: React.FC<Props> = (props) => {
  const { token, currentValues, onApply, onToast, onClose, autoStart = false } = props;
  const isFileMode = "file" in props && props.file != null;
  const hasResume = isFileMode ? true : (props as { hasResume: boolean }).hasResume;

  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ResumeAnalysisResult | null>(null);
  const [edited, setEdited] = useState<ResumeAnalysisResult | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [errorCategory, setErrorCategory] = useState<string | null>(null);
  const [errorDebug, setErrorDebug] = useState<Record<string, unknown> | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    if (autoStart && hasResume) {
      handleAnalyze();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAnalyze = async () => {
    if (!hasResume) {
      onToast("이력서를 먼저 업로드해 주세요.");
      return;
    }
    setAnalyzing(true);
    setResult(null);
    setEdited(null);
    setErrorDebug(null);
    setAnalyzeError(null);
    setErrorCategory(null);
    try {
      let resp: Response;
      if (isFileMode) {
        const fd = new FormData();
        fd.append("file", (props as { file: File }).file);
        resp = await fetch(api("/api/admin/translators/resume-analyze-upload"), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
      } else {
        const { userId } = props as { userId: number };
        resp = await fetch(api(`/api/admin/translators/${userId}/resume-analyze`), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({})) as { error?: string; _debug?: Record<string, unknown> };
        const errMsg = errBody.error ?? `HTTP ${resp.status}`;
        const category =
          resp.status === 404 ? "API 경로 없음 (404)" :
          resp.status === 401 || resp.status === 403 ? "인증/권한 오류" :
          resp.status === 400 ? "파일을 찾을 수 없음" :
          resp.status === 422 ? "텍스트 추출 실패" :
          "AI 분석 실패";
        setErrorCategory(category);
        if (errBody._debug) setErrorDebug(errBody._debug);
        throw new Error(errMsg);
      }
      const data: ResumeAnalysisResult = await resp.json();
      setResult(data);
      setEdited(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "이력서 분석에 실패했습니다.";
      setAnalyzeError(msg);
      onToast(msg);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleFieldChange = (key: keyof ResumeAnalysisResult, value: string) => {
    setEdited(prev =>
      prev
        ? {
            ...prev,
            [key]: key === "graduationYear" ? (value ? Number(value) : null) : value || null,
          }
        : prev
    );
  };

  const handleApply = () => {
    if (!edited) return;
    onApply(edited);
    onToast("AI 분석 결과가 프로필에 반영되었습니다. 저장 버튼을 눌러 확정하세요.");
  };

  const changedCount = result && currentValues
    ? FIELD_LABELS.filter(({ key }) => isChanged(currentValues[key], result[key])).length
    : 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={onClose}
      data-testid="resume-analyze-overlay"
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          width: "min(780px, 95vw)",
          maxHeight: "90vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
        onClick={e => e.stopPropagation()}
        data-testid="resume-analyze-panel"
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f0fdf4",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#065f46" }}>
              이력서 AI 분석
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
              분석 결과를 검토 후 승인하면 프로필에 반영됩니다.
              {isFileMode
                ? ` · 소스: 업로드 파일 (${(props as { file: File }).file.name})`
                : ` · 소스: 저장된 이력서 파일`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 20,
              color: "#6b7280",
              lineHeight: 1,
              padding: "4px 8px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {/* 분석 중 로딩 */}
          {analyzing && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 32, animation: "spin 1s linear infinite", display: "inline-block", marginBottom: 12 }}>⏳</div>
              <p style={{ fontSize: 14, color: "#374151", margin: 0 }}>이력서를 분석하고 있습니다...</p>
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 6 }}>GPT-4o 분석 중, 최대 30초 소요될 수 있습니다.</p>
            </div>
          )}

          {/* 에러 표시 */}
          {!analyzing && analyzeError && !result && (
            <div style={{ padding: "14px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 700 }}>분석 실패</span>
                {errorCategory && (
                  <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5" }}>
                    {errorCategory}
                  </span>
                )}
              </div>
              <p style={{ margin: 0, fontSize: 12, color: "#b91c1c", fontFamily: "monospace" }}>{analyzeError}</p>
              {errorDebug && (
                <div style={{ marginTop: 8, padding: "8px 10px", background: "#fff7f7", border: "1px dashed #fca5a5", borderRadius: 6, fontSize: 11, fontFamily: "monospace", color: "#7f1d1d" }}>
                  {Object.entries(errorDebug).map(([k, v]) => (
                    <div key={k}><b>{k}:</b> {String(v)}</div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" onClick={handleAnalyze}
                  style={{ fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "1px solid #dc2626", background: "#fff", color: "#dc2626", cursor: "pointer" }}>
                  다시 시도
                </button>
                <div style={{ fontSize: 11, color: "#6b7280", alignSelf: "center" }}>
                  {isFileMode ? `파일: ${(props as { file: File }).file.name}` : "저장된 이력서"}
                  {" · "}엔드포인트: {isFileMode ? "/api/admin/translators/resume-analyze-upload" : `/api/admin/translators/:id/resume-analyze`}
                </div>
              </div>
            </div>
          )}

          {/* 분석 실행 버튼 (analyzing 아닐 때, 결과 없을 때) */}
          {!analyzing && !result && !analyzeError && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={!hasResume}
                aria-label="AI 분석 실행"
                data-testid="btn-run-analyze"
                style={{
                  background: hasResume ? "#059669" : "#9ca3af",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "10px 28px",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: hasResume ? "pointer" : "not-allowed",
                }}
              >
                ✨ AI 분석 실행
              </button>
              {!hasResume && (
                <p style={{ marginTop: 8, fontSize: 12, color: "#ef4444" }}>
                  이력서 파일이 없습니다. 먼저 이력서를 업로드해 주세요.
                </p>
              )}
            </div>
          )}

          {/* Results */}
          {result && edited && (
            <>
              {/* Confidence + 변경 요약 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 16,
                  padding: "8px 12px",
                  background: "#f9fafb",
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: 13, color: "#374151" }}>AI 신뢰도:</span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#fff",
                    background: confidenceColor[result.confidence] ?? "#6b7280",
                    borderRadius: 4,
                    padding: "2px 8px",
                  }}
                >
                  {confidenceLabel[result.confidence] ?? result.confidence}
                </span>
                {changedCount > 0 && (
                  <span style={{ fontSize: 11, color: "#059669", fontWeight: 600, background: "#dcfce7", borderRadius: 4, padding: "2px 7px" }}>
                    {changedCount}개 항목 변경됨
                  </span>
                )}
                <span style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}>
                  항목을 직접 수정한 뒤 승인할 수 있습니다.
                </span>
              </div>

              {/* 디버그 패널 */}
              {result._debug && (
                <div style={{ marginBottom: 12 }}>
                  <button type="button" onClick={() => setShowDebug(p => !p)}
                    style={{ fontSize: 11, padding: "3px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", color: "#6b7280", cursor: "pointer" }}>
                    {showDebug ? "▲ 분석 소스 숨기기" : "▼ 분석 소스 확인"}
                  </button>
                  {showDebug && (
                    <div style={{ marginTop: 6, padding: "10px 14px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8, fontSize: 11, fontFamily: "monospace", lineHeight: 1.8 }}>
                      <div><span style={{ color: "#0369a1", fontWeight: 700 }}>분석 소스:</span> {result._debug.sourceType === "file_upload" ? "✅ 업로드 파일 (직접 추출)" : "✅ 저장된 이력서 파일 (GCS)"}</div>
                      <div><span style={{ color: "#0369a1", fontWeight: 700 }}>파일명:</span> {result._debug.fileName}</div>
                      <div><span style={{ color: "#0369a1", fontWeight: 700 }}>추출 텍스트 길이:</span> {result._debug.extractedTextLength.toLocaleString()}자</div>
                      <div><span style={{ color: "#0369a1", fontWeight: 700 }}>AI 호출 여부:</span> {result._debug.aiCalled ? "✅ true" : "❌ false"}</div>
                      <div><span style={{ color: "#0369a1", fontWeight: 700 }}>currentValues 사용 여부:</span> {result._debug.currentValuesUsed ? "⚠️ true (버그!)" : "✅ false (비교용 only)"}</div>
                      {result._debug.jsonParseFailed && <div style={{ color: "#dc2626" }}>⚠️ JSON 파싱 실패 — AI 응답이 비정상입니다.</div>}
                      <div style={{ marginTop: 4, color: "#6b7280" }}><span style={{ fontWeight: 700 }}>텍스트 미리보기:</span> {result._debug.extractedTextPreview}…</div>
                    </div>
                  )}
                </div>
              )}

              {/* 비교 헤더 (현재값이 있을 때만) */}
              {currentValues && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px 1fr 1fr",
                    gap: "0 8px",
                    marginBottom: 6,
                    paddingBottom: 4,
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  <div />
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textAlign: "center", padding: "2px 0" }}>현재값</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", textAlign: "center", padding: "2px 0" }}>AI 추출값 (수정 가능)</div>
                </div>
              )}

              {/* Editable fields */}
              {FIELD_LABELS.map(({ key, label, multiline, section, readOnly }, idx) => {
                const prevSection = idx > 0 ? FIELD_LABELS[idx - 1].section : null;
                const showSectionHeader = section && section !== prevSection;
                const extracted = edited[key];
                const strExtracted = toStr(extracted);
                const strCurrent = currentValues ? toStr(currentValues[key]) : null;
                const changed = strCurrent != null && isChanged(strCurrent, result[key]);

                // 언어·국제경험 — 특별 렌더링 (파싱된 배열 표시)
                if (key === "languageExperiences") {
                  const aiEntries: LangExpEntry[] = parseLangExperiences(strExtracted);
                  const currentEntries: LangExpEntry[] = parseLangExperiences(strCurrent ?? "");
                  if (aiEntries.length === 0) return null;
                  return (
                    <React.Fragment key={key}>
                      {showSectionHeader && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, margin: "12px 0 4px", paddingBottom: 3, borderBottom: "1px solid #e5e7eb" }}>
                          {section}
                        </div>
                      )}
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#1d4ed8", marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                          {label}
                          <span style={{ fontSize: 10, background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>
                            AI 자동생성 {aiEntries.length}개
                          </span>
                          {currentEntries.length > 0 && (
                            <span style={{ fontSize: 10, background: "#f3f4f6", color: "#6b7280", borderRadius: 4, padding: "1px 6px" }}>
                              현재 {currentEntries.length}개 (유지됨)
                            </span>
                          )}
                          <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: "auto" }}>승인 시 비어있는 경우에만 반영</span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {aiEntries.map((entry, i) => (
                            <div key={i} style={{
                              border: "1px solid #bfdbfe", borderRadius: 8, padding: "6px 10px",
                              background: entry.canWork ? "#eff6ff" : "#f9fafb", fontSize: 11,
                              display: "flex", flexDirection: "column", gap: 2, minWidth: 120,
                            }}>
                              <div style={{ fontWeight: 700, color: "#1e40af" }}>
                                {entry.language}
                                {entry.canWork && <span style={{ marginLeft: 4, fontSize: 10, color: "#059669", fontWeight: 700 }}>✓실무가능</span>}
                              </div>
                              {entry.level && <div style={{ color: "#374151" }}>레벨: {entry.level}</div>}
                              {entry.residenceCountry && <div style={{ color: "#6b7280" }}>거주: {entry.residenceCountry}{entry.residencePeriod ? ` ${entry.residencePeriod}` : ""}</div>}
                              {(entry.abroadUniversity || entry.abroadGraduate) && <div style={{ color: "#7c3aed" }}>해외대학: ✓</div>}
                              {(entry.abroadHigh || entry.abroadMiddle || entry.abroadElementary) && (
                                <div style={{ color: "#d97706" }}>
                                  해외초중고: {[entry.abroadElementary && "초", entry.abroadMiddle && "중", entry.abroadHigh && "고"].filter(Boolean).join("·")}
                                </div>
                              )}
                              {entry.internationalSchool && <div style={{ color: "#d97706" }}>국제학교: ✓</div>}
                              {entry.exchangeStudent && <div style={{ color: "#0891b2" }}>교환학생: ✓</div>}
                              {entry.languageStudyAbroad && <div style={{ color: "#0891b2" }}>어학연수: ✓</div>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                }

                if (currentValues) {
                  return (
                    <React.Fragment key={key}>
                      {showSectionHeader && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, margin: "12px 0 4px", paddingBottom: 3, borderBottom: "1px solid #e5e7eb" }}>
                          {section}
                        </div>
                      )}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "120px 1fr 1fr",
                        gap: "0 8px",
                        marginBottom: 10,
                        alignItems: "start",
                        background: changed ? "#f0fdf4" : "transparent",
                        borderRadius: 6,
                        padding: changed ? "4px 6px" : "0",
                      }}
                    >
                      <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", paddingTop: 7, paddingRight: 4 }}>
                        {label}
                        {changed && <span style={{ color: "#059669", marginLeft: 4 }}>●</span>}
                      </label>
                      {/* 현재값 (읽기 전용) */}
                      <div
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 6,
                          padding: "6px 10px",
                          fontSize: 12,
                          color: strCurrent ? "#374151" : "#9ca3af",
                          background: "#f9fafb",
                          minHeight: multiline ? 72 : 34,
                          overflowWrap: "break-word",
                          whiteSpace: multiline ? "pre-wrap" : "normal",
                        }}
                      >
                        {strCurrent || <em style={{ color: "#d1d5db" }}>없음</em>}
                      </div>
                      {/* AI 추출값 — readOnly 필드는 참고용 표시, 편집 불가 */}
                      {readOnly ? (
                        <div style={{
                          border: "1px dashed #f59e0b",
                          borderRadius: 6,
                          padding: "6px 10px",
                          fontSize: 12,
                          color: strExtracted ? "#92400e" : "#9ca3af",
                          background: "#fffbeb",
                          minHeight: 34,
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}>
                          <span style={{ fontSize: 10, background: "#fde68a", color: "#92400e", borderRadius: 4, padding: "1px 5px", fontWeight: 700, whiteSpace: "nowrap" }}>참고만</span>
                          {strExtracted || <em style={{ color: "#d1d5db" }}>없음</em>}
                        </div>
                      ) : multiline ? (
                        <textarea
                          value={strExtracted}
                          onChange={e => handleFieldChange(key, e.target.value)}
                          rows={3}
                          aria-label={label}
                          style={{
                            width: "100%",
                            border: changed ? "1.5px solid #059669" : "1px solid #d1d5db",
                            borderRadius: 6,
                            padding: "6px 10px",
                            fontSize: 12,
                            color: "#111827",
                            resize: "vertical",
                            boxSizing: "border-box",
                            background: changed ? "#f0fdf4" : "#fff",
                          }}
                        />
                      ) : (
                        <input
                          type={key === "graduationYear" ? "number" : "text"}
                          value={strExtracted}
                          onChange={e => handleFieldChange(key, e.target.value)}
                          aria-label={label}
                          style={{
                            width: "100%",
                            border: changed ? "1.5px solid #059669" : "1px solid #d1d5db",
                            borderRadius: 6,
                            padding: "6px 10px",
                            fontSize: 12,
                            color: "#111827",
                            boxSizing: "border-box",
                            background: changed ? "#f0fdf4" : "#fff",
                          }}
                        />
                      )}
                    </div>
                    </React.Fragment>
                  );
                }

                // currentValues 없을 때 기존 단일 컬럼 레이아웃
                return (
                  <React.Fragment key={key}>
                    {showSectionHeader && (
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1, margin: "12px 0 4px", paddingBottom: 3, borderBottom: "1px solid #e5e7eb" }}>
                        {section}
                      </div>
                    )}
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: readOnly ? "#92400e" : "#374151", marginBottom: 4 }}>
                      {label}
                      {readOnly && <span style={{ fontSize: 10, marginLeft: 6, background: "#fde68a", color: "#92400e", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>프로필 미반영</span>}
                    </label>
                    {readOnly ? (
                      <div style={{
                        border: "1px dashed #f59e0b",
                        borderRadius: 6,
                        padding: "7px 10px",
                        fontSize: 13,
                        color: strExtracted ? "#92400e" : "#9ca3af",
                        background: "#fffbeb",
                        minHeight: 34,
                      }}>
                        {strExtracted || <em style={{ color: "#d1d5db" }}>없음</em>}
                      </div>
                    ) : multiline ? (
                      <textarea
                        value={strExtracted}
                        onChange={e => handleFieldChange(key, e.target.value)}
                        rows={3}
                        aria-label={label}
                        style={{
                          width: "100%",
                          border: "1px solid #d1d5db",
                          borderRadius: 6,
                          padding: "6px 10px",
                          fontSize: 13,
                          color: "#111827",
                          resize: "vertical",
                          boxSizing: "border-box",
                        }}
                      />
                    ) : (
                      <input
                        type={key === "graduationYear" ? "number" : "text"}
                        value={strExtracted}
                        onChange={e => handleFieldChange(key, e.target.value)}
                        aria-label={label}
                        style={{
                          width: "100%",
                          border: "1px solid #d1d5db",
                          borderRadius: 6,
                          padding: "6px 10px",
                          fontSize: 13,
                          color: "#111827",
                          boxSizing: "border-box",
                        }}
                      />
                    )}
                  </div>
                  </React.Fragment>
                );
              })}

              {/* AI notes (read-only) */}
              {result.notes && (
                <div
                  style={{
                    marginTop: 4,
                    padding: "8px 12px",
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    borderRadius: 6,
                    fontSize: 12,
                    color: "#92400e",
                  }}
                >
                  <strong>AI 메모:</strong> {result.notes}
                </div>
              )}

              {/* Re-analyze button */}
              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setEdited(null);
                  }}
                  style={{
                    background: "none",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    padding: "6px 14px",
                    fontSize: 13,
                    color: "#6b7280",
                    cursor: "pointer",
                  }}
                  aria-label="다시 분석"
                >
                  다시 분석
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            background: "#f9fafb",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="취소"
            style={{
              background: "#fff",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              padding: "8px 20px",
              fontSize: 14,
              color: "#374151",
              cursor: "pointer",
            }}
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!edited}
            aria-label="승인 및 프로필 반영"
            data-testid="btn-apply-analysis"
            style={{
              background: edited ? "#059669" : "#9ca3af",
              border: "none",
              borderRadius: 6,
              padding: "8px 20px",
              fontSize: 14,
              fontWeight: 600,
              color: "#fff",
              cursor: edited ? "pointer" : "not-allowed",
            }}
          >
            승인 및 프로필 반영
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }`}</style>
    </div>
  );
};

export default ResumeAnalyzePanel;
