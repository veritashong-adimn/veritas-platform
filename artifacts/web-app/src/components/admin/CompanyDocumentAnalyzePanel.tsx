import React, { useState, useEffect } from "react";
import { api } from "../../lib/constants";

export type CompanyOcrDocType = "business_license" | "bankbook";

interface FieldConfig {
  key: string;
  label: string;
  mono?: boolean;
}

// "text": 붙여넣은 텍스트 AI 분석(AiTextPasteBox) 결과 검토용 — 파일 분석과 같은 검토/반영 흐름을 재사용한다.
type PanelDocType = CompanyOcrDocType | "text";

const CUSTOMER_TYPE_LABEL: Record<string, string> = { CORPORATE: "기업", PUBLIC: "공공기관", INDIVIDUAL: "개인고객" };

const FIELD_CONFIG: Record<PanelDocType, FieldConfig[]> = {
  text: [
    { key: "customerType", label: "고객 유형 (근거 있을 때만)" },
    { key: "name", label: "거래처명" },
    { key: "businessNumber", label: "사업자등록번호", mono: true },
    { key: "representativeName", label: "대표자명" },
    { key: "registeredAt", label: "개업일" },
    { key: "industry", label: "업태" },
    { key: "businessCategory", label: "종목" },
    { key: "address", label: "주소" },
    { key: "email", label: "이메일 (기업은 메모)" },
    { key: "mobile", label: "연락처 (기업은 메모)" },
    { key: "website", label: "홈페이지 (메모)" },
  ],
  business_license: [
    { key: "name", label: "상호(거래처명)" },
    { key: "businessNumber", label: "사업자등록번호", mono: true },
    { key: "representativeName", label: "대표자명" },
    { key: "registeredAt", label: "개업일" },
    { key: "industry", label: "업태" },
    { key: "businessCategory", label: "종목" },
    { key: "address", label: "주소" },
    { key: "vendorType", label: "외주유형 (추천)" },
  ],
  bankbook: [
    { key: "bankName", label: "은행명" },
    { key: "accountHolder", label: "예금주" },
    { key: "bankAccount", label: "계좌번호", mono: true },
  ],
};

interface AnalyzeResult {
  extracted: Record<string, string | null>;
  current?: Record<string, string | null>;
  validations?: Record<string, boolean>;
  confidence: "high" | "medium" | "low";
  notes: string | null;
  customerTypeEvidence?: string | null;
}

const confidenceColor: Record<string, string> = { high: "#059669", medium: "#d97706", low: "#dc2626" };
const confidenceLabel: Record<string, string> = { high: "높음", medium: "보통", low: "낮음" };

async function parseJsonResponse(r: Response): Promise<Record<string, unknown>> {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const preview = text.slice(0, 100).replace(/\s+/g, " ").trim();
    throw new Error(
      `서버 응답이 올바른 JSON이 아닙니다 (HTTP ${r.status}). API 경로 또는 서버 상태를 확인해 주세요.` +
      (preview ? ` [응답 미리보기: ${preview}]` : ""),
    );
  }
}

export function CompanyDocumentAnalyzePanel({
  file,
  docType,
  token,
  onToast,
  onClose,
  onApplied,
  prefetched,
  currentValues,
  extraTop,
}: {
  /** 파일 분석 시 필수. docType="text"(prefetched 사용) 에서는 생략 */
  file?: File;
  docType: PanelDocType;
  token: string;
  onToast: (msg: string) => void;
  onClose: () => void;
  onApplied: (appliedFields: string[], appliedValues: Record<string, string>) => void;
  /** 이미 받은 분석 결과(텍스트 분석). 있으면 파일 업로드 분석을 호출하지 않는다. */
  prefetched?: AnalyzeResult;
  /** 현재 폼 입력값 — 값이 이미 있고 AI 값과 다르면 기본 미선택(덮어쓰기 방지) */
  currentValues?: Record<string, string>;
  /** 결과 상단 추가 영역(기존 거래처 후보 안내 등) */
  extraTop?: React.ReactNode;
}) {
  const label = docType === "business_license" ? "사업자등록증" : docType === "text" ? "텍스트" : "통장사본";
  const fields = FIELD_CONFIG[docType];
  const authH = { Authorization: `Bearer ${token}` };

  const [analyzing, setAnalyzing] = useState(true);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const initFrom = (res: AnalyzeResult) => {
    setResult(res);
    const initEdited: Record<string, string> = {};
    const initChecked: Record<string, boolean> = {};
    for (const f of fields) {
      const v = res.extracted[f.key];
      const cur = currentValues?.[f.key]?.trim();
      initEdited[f.key] = v ?? "";
      // 기존 입력값과 다른 AI 값은 사용자가 직접 선택해야 반영된다.
      initChecked[f.key] = !!v && (!cur || cur === v);
    }
    setEdited(initEdited);
    setChecked(initChecked);
  };

  const handleAnalyze = async () => {
    if (prefetched) { initFrom(prefetched); setAnalyzing(false); return; }
    if (!file) { setError("분석할 파일이 없습니다."); setAnalyzing(false); return; }
    setAnalyzing(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(api(`/api/admin/companies/document-analyze-upload?type=${docType}`), {
        method: "POST",
        headers: authH,
        body: fd,
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) { setError((d.error as string) ?? (d.message as string) ?? `HTTP ${r.status}`); return; }
      initFrom(d as unknown as AnalyzeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} 분석에 실패했습니다.`);
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => { handleAnalyze(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = () => {
    const body: Record<string, string> = {};
    for (const f of fields) {
      if (checked[f.key] && edited[f.key]?.trim()) body[f.key] = edited[f.key].trim();
    }
    if (Object.keys(body).length === 0) { onToast("반영할 항목을 선택해 주세요."); return; }
    onApplied(Object.keys(body), body);
    onClose();
  };

  const bankNameUnmatched = docType === "bankbook" && !!result?.extracted.bankName && result.validations?.bankNameMatched === false;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}
      onClick={onClose}
      data-testid="company-document-analyze-overlay"
    >
      <div
        style={{ background: "#fff", borderRadius: 12, width: "min(740px, 95vw)", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}
        onClick={e => e.stopPropagation()}
        data-testid="company-document-analyze-panel"
      >
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f0f9ff" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0369a1" }}>
              {docType === "business_license" ? "📄" : docType === "text" ? "📝" : "🏦"} {label} AI 분석
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
              분석 결과를 검토 후 승인하면 등록 폼에 자동 반영됩니다.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#6b7280", lineHeight: 1, padding: "4px 8px" }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {analyzing && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 32, animation: "spin 1s linear infinite", display: "inline-block", marginBottom: 12 }}>⏳</div>
              <p style={{ fontSize: 14, color: "#374151", margin: 0 }}>{label}을 분석하고 있습니다...</p>
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 6 }}>GPT-4o Vision 분석 중, 최대 30초 소요될 수 있습니다.</p>
            </div>
          )}

          {!analyzing && error && (
            <div style={{ padding: "14px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#dc2626", fontWeight: 700 }}>분석 실패</p>
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "#b91c1c", fontFamily: "monospace" }}>{error}</p>
              <button
                type="button"
                onClick={handleAnalyze}
                aria-label="다시 분석"
                style={{ marginTop: 10, fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "1px solid #dc2626", background: "#fff", color: "#dc2626", cursor: "pointer" }}
              >
                다시 시도
              </button>
            </div>
          )}

          {!analyzing && result && (
            <>
              {/* 신뢰도 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "#374151" }}>AI 신뢰도:</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: confidenceColor[result.confidence] ?? "#6b7280", borderRadius: 4, padding: "2px 8px" }}>
                  {confidenceLabel[result.confidence] ?? result.confidence}
                </span>
                <span style={{ fontSize: 11, color: "#0369a1", background: "#e0f2fe", borderRadius: 4, padding: "2px 8px", fontWeight: 600 }}>등록 폼 반영 모드</span>
                <span style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}>체크된 항목만 폼에 반영됩니다.</span>
              </div>

              {extraTop}

              {bankNameUnmatched && (
                <div style={{ padding: "8px 12px", marginBottom: 8, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, fontSize: 12, color: "#991b1b", fontWeight: 600 }}>
                  ⚠️ 은행명이 등록된 은행 목록과 일치하지 않습니다. 입력값을 확인해 주세요.
                </div>
              )}

              {/* 비교 헤더 */}
              <div style={{ display: "grid", gridTemplateColumns: "26px 130px 1fr", gap: "0 8px", marginBottom: 6, paddingBottom: 4, borderBottom: "1px solid #e5e7eb" }}>
                <div />
                <div />
                <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", textAlign: "center" }}>AI 추출값 (수정 가능)</div>
              </div>

              {fields.map(f => (
                <div key={f.key} style={{ display: "grid", gridTemplateColumns: "26px 130px 1fr", gap: "0 8px", marginBottom: 10, alignItems: "start" }}>
                  <input
                    type="checkbox"
                    checked={!!checked[f.key]}
                    onChange={e => setChecked(p => ({ ...p, [f.key]: e.target.checked }))}
                    aria-label={`${f.label} 승인 포함`}
                    data-testid={`company-ocr-check-${f.key}`}
                    style={{ marginTop: 9 }}
                  />
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", paddingTop: 7, paddingRight: 4 }}>{f.label}</label>
                  <div>
                  {f.key === "customerType" ? (
                    <select
                      value={edited[f.key] ?? ""}
                      onChange={e => setEdited(p => ({ ...p, [f.key]: e.target.value }))}
                      aria-label={`${f.label} AI 추천값`}
                      data-testid={`company-ocr-input-${f.key}`}
                      style={{ width: "100%", border: checked[f.key] ? "1.5px solid #059669" : "1px solid #d1d5db", borderRadius: 6, padding: "6px 10px", fontSize: 12, background: checked[f.key] ? "#f0fdf4" : "#fff" }}
                    >
                      <option value="">(추천 없음 — 직접 선택)</option>
                      {Object.entries(CUSTOMER_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  ) : (
                  <input
                    type="text"
                    value={edited[f.key] ?? ""}
                    onChange={e => setEdited(p => ({ ...p, [f.key]: e.target.value }))}
                    aria-label={`${f.label} AI 추출값`}
                    data-testid={`company-ocr-input-${f.key}`}
                    style={{
                      width: "100%", border: checked[f.key] ? "1.5px solid #059669" : "1px solid #d1d5db",
                      borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "#111827", boxSizing: "border-box",
                      fontFamily: f.mono ? "monospace" : undefined, background: checked[f.key] ? "#f0fdf4" : "#fff",
                    }}
                  />
                  )}
                  {f.key === "customerType" && result.customerTypeEvidence && (
                    <p style={{ margin: "3px 0 0", fontSize: 11, color: "#6b7280" }}>근거: “{result.customerTypeEvidence}”</p>
                  )}
                  {(() => {
                    const cur = currentValues?.[f.key]?.trim();
                    return cur && edited[f.key] && cur !== edited[f.key] ? (
                      <p style={{ margin: "3px 0 0", fontSize: 11, color: "#b45309" }} data-testid={`company-ocr-current-${f.key}`}>
                        현재 입력값: {cur} — 체크하면 AI 값으로 바뀝니다.
                      </p>
                    ) : null;
                  })()}
                  </div>
                </div>
              ))}

              {result.notes && (
                <div style={{ marginTop: 10, padding: "8px 12px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, fontSize: 12, color: "#92400e" }}>
                  <strong>AI 메모:</strong> {result.notes}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 20px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", gap: 8, background: "#f9fafb" }}>
          <button
            type="button"
            onClick={onClose}
            aria-label="무시 (반영하지 않고 닫기)"
            data-testid="btn-company-ocr-dismiss"
            style={{ background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 20px", fontSize: 14, color: "#374151", cursor: "pointer" }}
          >
            무시
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!result}
            aria-label="선택 항목 폼에 반영"
            data-testid="btn-company-ocr-apply"
            style={{
              background: result ? "#059669" : "#9ca3af", border: "none", borderRadius: 6,
              padding: "8px 20px", fontSize: 14, fontWeight: 600, color: "#fff",
              cursor: result ? "pointer" : "not-allowed",
            }}
          >
            폼에 반영
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }`}</style>
    </div>
  );
}
