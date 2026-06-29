import React, { useState, useEffect } from "react";
import { api } from "../../lib/constants";

export type CompanyOcrDocType = "business_license" | "bankbook";

interface FieldConfig {
  key: string;
  label: string;
  mono?: boolean;
}

const FIELD_CONFIG: Record<CompanyOcrDocType, FieldConfig[]> = {
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
  current: Record<string, string | null>;
  validations: Record<string, boolean>;
  confidence: "high" | "medium" | "low";
  notes: string | null;
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
}: {
  file: File;
  docType: CompanyOcrDocType;
  token: string;
  onToast: (msg: string) => void;
  onClose: () => void;
  onApplied: (appliedFields: string[], appliedValues: Record<string, string>) => void;
}) {
  const label = docType === "business_license" ? "사업자등록증" : "통장사본";
  const fields = FIELD_CONFIG[docType];
  const authH = { Authorization: `Bearer ${token}` };

  const [analyzing, setAnalyzing] = useState(true);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
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
      setResult(d as unknown as AnalyzeResult);
      const initEdited: Record<string, string> = {};
      const initChecked: Record<string, boolean> = {};
      for (const f of fields) {
        const v = (d as unknown as AnalyzeResult).extracted[f.key];
        initEdited[f.key] = v ?? "";
        initChecked[f.key] = !!v;
      }
      setEdited(initEdited);
      setChecked(initChecked);
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

  const bankNameUnmatched = docType === "bankbook" && !!result?.extracted.bankName && result.validations.bankNameMatched === false;

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
              {docType === "business_license" ? "📄" : "🏦"} {label} AI 분석
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
