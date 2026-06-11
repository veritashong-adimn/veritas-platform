import React, { useState, useEffect } from "react";

export interface ResumeAnalysisResult {
  name: string | null;
  languagePairs: string | null;
  education: string | null;
  major: string | null;
  graduationYear: number | null;
  specializations: string | null;
  profileWorkTypes: string | null;
  profileSubTypes: string | null;
  region: string | null;
  bio: string | null;
  confidence: "high" | "medium" | "low";
  notes: string | null;
}

interface Props {
  userId: number;
  token: string;
  hasResume: boolean;
  onApply: (result: ResumeAnalysisResult) => void;
  onToast: (msg: string) => void;
  onClose: () => void;
  autoStart?: boolean;
}

const FIELD_LABELS: { key: keyof ResumeAnalysisResult; label: string; multiline?: boolean }[] = [
  { key: "name", label: "이름" },
  { key: "languagePairs", label: "가능언어" },
  { key: "education", label: "학력" },
  { key: "major", label: "전공" },
  { key: "graduationYear", label: "졸업연도" },
  { key: "specializations", label: "전문분야" },
  { key: "profileWorkTypes", label: "업무유형 (쉼표 구분)" },
  { key: "profileSubTypes", label: "세부유형 (쉼표 구분)" },
  { key: "region", label: "지역" },
  { key: "bio", label: "상세정보 (경력요약)", multiline: true },
  { key: "notes", label: "AI 메모", multiline: true },
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

export const ResumeAnalyzePanel: React.FC<Props> = ({
  userId,
  token,
  hasResume,
  onApply,
  onToast,
  onClose,
  autoStart = false,
}) => {
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ResumeAnalysisResult | null>(null);
  const [edited, setEdited] = useState<ResumeAnalysisResult | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // autoStart=true이면 패널 열릴 때 즉시 분석 실행
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
    setAnalyzeError(null);
    try {
      const resp = await fetch(`/api/admin/translators/${userId}/resume-analyze`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `분석 실패 (${resp.status})`);
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
          width: "min(640px, 95vw)",
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
            <div style={{ padding: "16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#dc2626", fontWeight: 600 }}>분석 실패</p>
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "#b91c1c" }}>{analyzeError}</p>
              <button
                type="button"
                onClick={handleAnalyze}
                style={{ marginTop: 10, fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "1px solid #dc2626", background: "#fff", color: "#dc2626", cursor: "pointer" }}
              >
                다시 시도
              </button>
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
              {/* Confidence badge */}
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
                <span style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}>
                  * 항목을 직접 수정한 뒤 승인할 수 있습니다.
                </span>
              </div>

              {/* Editable fields */}
              {FIELD_LABELS.map(({ key, label, multiline }) => {
                if (key === "confidence" || key === "notes") return null;
                const val = edited[key];
                const strVal = val == null ? "" : String(val);
                return (
                  <div key={key} style={{ marginBottom: 12 }}>
                    <label
                      style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}
                    >
                      {label}
                    </label>
                    {multiline ? (
                      <textarea
                        value={strVal}
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
                        value={strVal}
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
