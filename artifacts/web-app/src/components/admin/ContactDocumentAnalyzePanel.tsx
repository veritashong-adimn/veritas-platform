import React, { useState, useEffect } from "react";
import { api } from "../../lib/constants";

interface ContactAnalyzeResult {
  extracted: {
    name: string | null;
    companyName: string | null;
    department: string | null;
    position: string | null;
    email: string | null;
    mobile: string | null;
    officePhone: string | null;
    memo: string | null;
  };
  confidence: "high" | "medium" | "low";
  notes: string | null;
}

const CONTACT_FIELDS: { key: keyof ContactAnalyzeResult["extracted"]; label: string }[] = [
  { key: "name",        label: "담당자명" },
  { key: "companyName", label: "회사명/거래처" },
  { key: "department",  label: "부서" },
  { key: "position",    label: "직책" },
  { key: "email",       label: "이메일" },
  { key: "mobile",      label: "휴대폰" },
  { key: "officePhone", label: "직장전화" },
  { key: "memo",        label: "메모" },
];

const confidenceColor: Record<string, string> = { high: "#059669", medium: "#d97706", low: "#dc2626" };
const confidenceLabel: Record<string, string> = { high: "높음", medium: "보통", low: "낮음" };

async function parseJsonResponse(r: Response): Promise<Record<string, unknown>> {
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; }
  catch {
    const preview = text.slice(0, 100).replace(/\s+/g, " ").trim();
    throw new Error(
      `서버 응답 오류 (HTTP ${r.status}).` + (preview ? ` [${preview}]` : ""),
    );
  }
}

export function ContactDocumentAnalyzePanel({
  file,
  token,
  onToast,
  onClose,
  onApplied,
}: {
  file: File;
  token: string;
  onToast: (msg: string) => void;
  onClose: () => void;
  onApplied: (values: Partial<ContactAnalyzeResult["extracted"]>) => void;
}) {
  const authH = { Authorization: `Bearer ${token}` };

  const [analyzing, setAnalyzing] = useState(true);
  const [result, setResult] = useState<ContactAnalyzeResult | null>(null);
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
      const requestUrl = api("/api/admin/contacts/document-analyze-upload");
      console.log("[CONTACT-OCR] fetch →", requestUrl, "method=POST file=", file.name);
      const r = await fetch(requestUrl, {
        method: "POST",
        headers: authH,
        body: fd,
      });
      console.log("[CONTACT-OCR] response status=", r.status, r.statusText);
      const d = await parseJsonResponse(r);
      if (!r.ok) {
        const errDetail = `${(d.error as string) ?? ""} | ${(d.message as string) ?? ""} | HTTP ${r.status}`;
        console.error("[CONTACT-OCR] 실패:", errDetail, d);
        setError(errDetail.trim());
        return;
      }
      const res = d as unknown as ContactAnalyzeResult;
      setResult(res);
      const initEdited: Record<string, string> = {};
      const initChecked: Record<string, boolean> = {};
      for (const f of CONTACT_FIELDS) {
        const v = res.extracted[f.key];
        initEdited[f.key] = v ?? "";
        initChecked[f.key] = !!v;
      }
      setEdited(initEdited);
      setChecked(initChecked);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI 분석에 실패했습니다.");
    } finally {
      setAnalyzing(false);
    }
  };

  useEffect(() => { handleAnalyze(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = () => {
    const body: Partial<ContactAnalyzeResult["extracted"]> = {};
    for (const f of CONTACT_FIELDS) {
      if (checked[f.key] && edited[f.key]?.trim()) {
        (body as Record<string, string>)[f.key] = edited[f.key].trim();
      }
    }
    if (Object.keys(body).length === 0) { onToast("반영할 항목을 선택해 주세요."); return; }
    onApplied(body);
    onClose();
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}
      onClick={onClose}
    >
      <div
        style={{ background: "#fff", borderRadius: 12, width: "min(700px, 95vw)", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f0f9ff" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0369a1" }}>
              📇 담당자 명함 AI 분석
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
              분석 결과를 검토 후 승인하면 등록 폼에 자동 반영됩니다.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기"
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20, color: "#6b7280", lineHeight: 1, padding: "4px 8px" }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {analyzing && (
            <div style={{ textAlign: "center", padding: "32px 0" }}>
              <div style={{ fontSize: 32, animation: "spin 1s linear infinite", display: "inline-block", marginBottom: 12 }}>⏳</div>
              <p style={{ fontSize: 14, color: "#374151", margin: 0 }}>명함을 분석하고 있습니다...</p>
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 6 }}>GPT-4o Vision 분석 중, 최대 30초 소요될 수 있습니다.</p>
            </div>
          )}

          {!analyzing && error && (
            <div style={{ padding: "14px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: "#dc2626", fontWeight: 700 }}>분석 실패</p>
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "#b91c1c", fontFamily: "monospace" }}>{error}</p>
              <button type="button" onClick={handleAnalyze} aria-label="다시 분석"
                style={{ marginTop: 10, fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "1px solid #dc2626", background: "#fff", color: "#dc2626", cursor: "pointer" }}>
                다시 시도
              </button>
            </div>
          )}

          {!analyzing && result && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "8px 12px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "#374151" }}>AI 신뢰도:</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: confidenceColor[result.confidence] ?? "#6b7280", borderRadius: 4, padding: "2px 8px" }}>
                  {confidenceLabel[result.confidence] ?? result.confidence}
                </span>
                <span style={{ fontSize: 11, color: "#0369a1", background: "#e0f2fe", borderRadius: 4, padding: "2px 8px", fontWeight: 600 }}>등록 폼 반영 모드</span>
                <span style={{ fontSize: 11, color: "#6b7280", marginLeft: "auto" }}>체크된 항목만 폼에 반영됩니다.</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "26px 120px 1fr", gap: "0 8px", marginBottom: 6, paddingBottom: 4, borderBottom: "1px solid #e5e7eb" }}>
                <div /><div />
                <div style={{ fontSize: 11, fontWeight: 700, color: "#059669", textAlign: "center" }}>AI 추출값 (수정 가능)</div>
              </div>

              {CONTACT_FIELDS.map(f => (
                <div key={f.key} style={{ display: "grid", gridTemplateColumns: "26px 120px 1fr", gap: "0 8px", marginBottom: 10, alignItems: "start" }}>
                  <input type="checkbox" checked={!!checked[f.key]}
                    onChange={e => setChecked(p => ({ ...p, [f.key]: e.target.checked }))}
                    aria-label={`${f.label} 포함`} style={{ marginTop: 9 }} />
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", paddingTop: 7, paddingRight: 4 }}>{f.label}</label>
                  <input type="text" value={edited[f.key] ?? ""}
                    onChange={e => setEdited(p => ({ ...p, [f.key]: e.target.value }))}
                    aria-label={`${f.label} AI 추출값`}
                    style={{
                      width: "100%", border: checked[f.key] ? "1.5px solid #059669" : "1px solid #d1d5db",
                      borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "#111827", boxSizing: "border-box",
                      background: checked[f.key] ? "#f0fdf4" : "#fff",
                    }} />
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
          <button type="button" onClick={onClose} aria-label="무시"
            style={{ background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 20px", fontSize: 14, color: "#374151", cursor: "pointer" }}>
            무시
          </button>
          <button type="button" onClick={handleApply} disabled={!result} aria-label="폼에 반영"
            style={{
              background: result ? "#059669" : "#9ca3af", border: "none", borderRadius: 6,
              padding: "8px 20px", fontSize: 14, fontWeight: 600, color: "#fff",
              cursor: result ? "pointer" : "not-allowed",
            }}>
            폼에 반영
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }`}</style>
    </div>
  );
}
