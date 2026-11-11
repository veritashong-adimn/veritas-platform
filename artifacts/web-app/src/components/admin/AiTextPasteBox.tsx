import React, { useState } from "react";
import { api } from "../../lib/constants";

/**
 * 거래처·담당자 등록 — AI 텍스트 자동입력 입력 영역.
 * 이메일 본문/서명, 명함 텍스트, 회사 정보 등을 붙여넣고 [AI 분석]을 누르면
 * POST /api/admin/ai/text-analyze 결과를 onResult 로 넘긴다(폼 반영은 기존 검토 패널이 담당).
 */
export const AI_TEXT_MAX = 5000;

export type TextMatchCompany = {
  id: number; name: string; customerType: string | null; businessNumber: string | null;
  matchReason: "business_number" | "name" | "alias" | "email_domain" | "similar_name";
};
export type TextMatchContact = {
  id: number; name: string; companyId: number | null; companyName: string | null;
  email: string | null; mobile: string | null; department: string | null; position: string | null;
  matchReason: "email" | "mobile" | "name_company" | "name";
};
export interface TextAnalyzeResult {
  extracted: Record<string, string | null>;
  confidence: "high" | "medium" | "low";
  notes: string | null;
  customerTypeEvidence?: string | null;
  matches: { companies: TextMatchCompany[]; contacts: TextMatchContact[] };
}

/** 거래처 후보 중 "동일 거래처"로 볼 수 있는 강한 일치 */
export const isStrongCompanyMatch = (c: TextMatchCompany) =>
  c.matchReason === "business_number" || c.matchReason === "alias" || c.matchReason === "name";

export const COMPANY_MATCH_LABEL: Record<TextMatchCompany["matchReason"], string> = {
  business_number: "사업자번호 일치", alias: "거래처명(별칭) 일치", name: "거래처명 일치",
  email_domain: "이메일 도메인 일치", similar_name: "이름 유사",
};
export const CONTACT_MATCH_LABEL: Record<TextMatchContact["matchReason"], string> = {
  email: "이메일 일치", mobile: "휴대폰 일치", name_company: "이름+거래처 일치", name: "동명이인 확인 필요",
};

export function AiTextPasteBox({
  kind, token, placeholder, onResult,
}: {
  kind: "company" | "contact";
  token: string;
  placeholder?: string;
  onResult: (r: TextAnalyzeResult) => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const len = text.trim().length;
  const canRun = !loading && len >= 5 && len <= AI_TEXT_MAX;

  const run = async () => {
    if (!canRun) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(api("/api/admin/ai/text-analyze"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ kind, text }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d?.error ?? `분석 실패 (HTTP ${r.status})`); return; }
      onResult(d as TextAnalyzeResult);
    } catch {
      setError("AI 분석 요청 중 오류가 발생했습니다.");
    } finally { setLoading(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value.slice(0, AI_TEXT_MAX))}
        placeholder={placeholder ?? "이메일 본문, 이메일 서명, 명함 텍스트, 회사 정보 등을 붙여넣으세요."}
        rows={6}
        disabled={loading}
        data-testid={`ai-text-input-${kind}`}
        aria-label="AI 분석할 텍스트"
        style={{ width: "100%", boxSizing: "border-box", border: "1px solid #bae6fd", borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.5, resize: "vertical", background: loading ? "#f8fafc" : "#fff", color: "#111827", fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: len > AI_TEXT_MAX ? "#dc2626" : "#94a3b8" }}>
          {len.toLocaleString()} / {AI_TEXT_MAX.toLocaleString()}자 · 분석 결과는 확인 후 폼에 반영되며 바로 저장되지 않습니다.
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {text && !loading && (
            <button type="button" onClick={() => { setText(""); setError(null); }}
              data-testid={`ai-text-clear-${kind}`} aria-label="붙여넣은 텍스트 지우기"
              style={{ fontSize: 12, padding: "6px 10px", background: "#fff", color: "#6b7280", border: "1px solid #e5e7eb", borderRadius: 7, cursor: "pointer" }}>
              지우기
            </button>
          )}
          <button type="button" onClick={run} disabled={!canRun}
            data-testid={`ai-text-analyze-${kind}`} aria-label="텍스트 AI 분석"
            style={{ fontSize: 13, padding: "6px 16px", background: canRun ? "#0284c7" : "#cbd5e1", color: "#fff", border: "none", borderRadius: 7, cursor: canRun ? "pointer" : "not-allowed", fontWeight: 700, whiteSpace: "nowrap" }}>
            {loading ? "⏳ 분석 중..." : "✨ AI 분석"}
          </button>
        </div>
      </div>
      {error && (
        <div data-testid={`ai-text-error-${kind}`} style={{ padding: "8px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, fontSize: 12, color: "#b91c1c" }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** [파일 업로드] [텍스트 붙여넣기] 입력 방식 선택 탭 */
export function AiInputModeTabs({ mode, onChange, testIdPrefix }: {
  mode: "file" | "text"; onChange: (m: "file" | "text") => void; testIdPrefix: string;
}) {
  const btn = (m: "file" | "text", label: string) => (
    <button type="button" onClick={() => onChange(m)}
      data-testid={`${testIdPrefix}-mode-${m}`} aria-label={label} aria-pressed={mode === m}
      style={{
        fontSize: 12, padding: "5px 12px", borderRadius: 7, cursor: "pointer", fontWeight: 700,
        border: `1px solid ${mode === m ? "#0284c7" : "#bae6fd"}`,
        background: mode === m ? "#0284c7" : "#fff", color: mode === m ? "#fff" : "#0369a1",
      }}>
      {label}
    </button>
  );
  return <div style={{ display: "flex", gap: 6 }}>{btn("file", "파일 업로드")}{btn("text", "텍스트 붙여넣기")}</div>;
}
