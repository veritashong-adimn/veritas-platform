import React, { useState, useCallback } from 'react';
import { api, LANGUAGE_CODES, PRODUCT_TYPES_META, MAIN_CATEGORIES_BY_TYPE } from '../../lib/constants';
import { DraggableModal } from './DraggableModal';

type Analysis = {
  productCandidate: string; langPair: string; direction: string;
  difficulty: string; industry: string; industry2: string;
  isOptionCandidate: boolean; confidenceScore: number;
  reviewReasons: string[]; displayName?: string;
  domain?: string; langHint?: string;
};

export type ReviewFixItem = {
  rowNum: number; name: string; productType: string; mainCategory: string;
  subCategory: string; sourceLanguage: string | null; targetLanguage: string | null;
  unit: string; basePrice: number | null;
  analysis: Analysis;
};

export type ReparseSavePayload = {
  rowNum: number;
  editedName: string;
  editedType: string;
  editedSrc: string | null;
  editedTgt: string | null;
  editedMainCat: string;
  analysis: Analysis;
  notes: string;
  reparsed: boolean;
};

type Props = {
  item: ReviewFixItem;
  token: string;
  onSave: (payload: ReparseSavePayload) => void;
  onClose: () => void;
};

function rrStyle(r: string): React.CSSProperties {
  if (r.includes("UNKNOWN") || r.includes("미지원") || r.includes("MISSING"))
    return { color: "#dc2626", background: "#fef2f2", border: "1px solid #fca5a5" };
  if (r.includes("AMBIGUOUS") || r.includes("모호") || r.includes("CANTONESE"))
    return { color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a" };
  if (r.includes("STRIPPED") || r.includes("COMPACT"))
    return { color: "#065f46", background: "#ecfdf5", border: "1px solid #6ee7b7" };
  return { color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe" };
}

const fieldLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "#6b7280", display: "block", marginBottom: 3,
};
const fieldInput: React.CSSProperties = {
  width: "100%", padding: "7px 9px", border: "1px solid #d1d5db", borderRadius: 6,
  fontSize: 13, boxSizing: "border-box" as const, color: "#111827",
};
const badge: React.CSSProperties = {
  display: "inline-block", marginRight: 3, marginBottom: 2,
  fontSize: 10, borderRadius: 3, padding: "1px 5px",
};

async function callAnalyzeRow(
  token: string,
  name: string, productType: string,
  sourceLanguage: string | null, targetLanguage: string | null,
  mainCategory: string,
): Promise<Analysis> {
  const res = await fetch(api("/api/admin/products/analyze-row"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, productType, sourceLanguage, targetLanguage, mainCategory }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "재분석 실패");
  }
  const data = await res.json() as { analysis: Analysis };
  return data.analysis;
}

export function ReviewFixConsoleModal({ item, token, onSave, onClose }: Props) {
  const [editedName, setEditedName] = useState(item.name);
  const [editedType, setEditedType] = useState(item.productType);
  const [editedSrc, setEditedSrc]   = useState(item.sourceLanguage ?? "");
  const [editedTgt, setEditedTgt]   = useState(item.targetLanguage ?? "");
  const [editedMainCat, setEditedMainCat] = useState(item.mainCategory);
  const [notes, setNotes] = useState("");

  // Re-parse state — independent from form edits so drag doesn't reset it
  const [latestAnalysis, setLatestAnalysis] = useState<Analysis>(item.analysis);
  const [reparsed, setReparsed] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState("");

  const nameChanged = editedName.trim() !== item.name;
  const needsReparse = nameChanged && !reparsed;

  const mainCats = (MAIN_CATEGORIES_BY_TYPE as Record<string, { label: string }[]>)[editedType] ?? [];

  const doReparse = useCallback(async (
    name: string, type: string, src: string | null, tgt: string | null, cat: string,
  ): Promise<Analysis | null> => {
    if (!name.trim()) return null;
    setParseError("");
    setParsing(true);
    try {
      const analysis = await callAnalyzeRow(token, name.trim(), type, src || null, tgt || null, cat);
      setLatestAnalysis(analysis);
      setReparsed(true);
      return analysis;
    } catch (e) {
      setParseError((e as Error).message);
      return null;
    } finally {
      setParsing(false);
    }
  }, [token]);

  const handleManualReparse = () => {
    doReparse(editedName, editedType, editedSrc, editedTgt, editedMainCat);
  };

  // Save: auto-reparse first if name changed and not yet reparsed
  const handleSave = async () => {
    if (!editedName.trim()) return;
    console.log("[ReviewFix] save clicked", { rowNum: item.rowNum, editedName, needsReparse, reparsed });
    setSaving(true);
    try {
      let finalAnalysis = latestAnalysis;
      let didReparse = reparsed;

      if (needsReparse) {
        // auto-reparse before saving so displayName/reviewReasons are fresh
        const result = await doReparse(editedName, editedType, editedSrc, editedTgt, editedMainCat);
        if (!result) {
          // re-parse failed — keep original analysis and still save
          finalAnalysis = item.analysis;
          didReparse = false;
          console.warn("[ReviewFix] reparse failed — saving with original analysis");
        } else {
          finalAnalysis = result;
          didReparse = true;
          console.log("[ReviewFix] reparse ok", { displayName: result.displayName, reviewReasons: result.reviewReasons });
        }
      }

      console.log("[ReviewFix] calling onSave", { rowNum: item.rowNum, editedName, didReparse, finalDisplayName: finalAnalysis?.displayName });
      onSave({
        rowNum: item.rowNum,
        editedName: editedName.trim(),
        editedType,
        editedSrc: editedSrc || null,
        editedTgt: editedTgt || null,
        editedMainCat,
        analysis: finalAnalysis,
        notes,
        reparsed: didReparse,
      });
    } catch (err) {
      console.error("[ReviewFix] handleSave error", err);
    } finally {
      setSaving(false);
    }
  };

  const beforeReasons = item.analysis.reviewReasons ?? [];
  const afterReasons  = latestAnalysis.reviewReasons ?? [];
  const resolved      = beforeReasons.filter(r => !afterReasons.includes(r));

  const subtitle = `Row #${item.rowNum} — 변경은 이번 Preview에만 반영됩니다`;

  return (
    <DraggableModal
      title="✎ 행 수정 / 재분석"
      subtitle={subtitle}
      onClose={onClose}
      width={700}
      height="auto"
      zIndex={1000}
      bodyPadding="18px 24px"
      resizable
    >
      {/* Before / After 비교 패널 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16, padding: 12, background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", marginBottom: 5 }}>원본 / 현재</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", wordBreak: "break-all", marginBottom: 4 }}>{item.name}</div>
          {item.analysis.displayName && item.analysis.displayName !== item.name && (
            <div style={{ fontSize: 11, color: "#2563eb", marginBottom: 4 }}>→ {item.analysis.displayName}</div>
          )}
          {item.analysis.direction && (
            <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>방향: {item.analysis.direction}</div>
          )}
          <div>
            {beforeReasons.length === 0
              ? <span style={{ fontSize: 11, color: "#059669" }}>✓ 검토 사유 없음</span>
              : beforeReasons.map((r, i) => (
                <span key={i} style={{ ...badge, ...rrStyle(r) }}>{r}</span>
              ))
            }
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: reparsed ? "#059669" : "#9ca3af", marginBottom: 5 }}>
            {reparsed ? "재분석 결과" : "재분석 결과 (대기)"}
          </div>
          {reparsed ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#059669", marginBottom: 4, wordBreak: "break-all" }}>
                {latestAnalysis.displayName || latestAnalysis.productCandidate}
              </div>
              {latestAnalysis.direction && (
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 2 }}>방향: {latestAnalysis.direction}</div>
              )}
              <div style={{ fontSize: 11, color: "#374151", marginBottom: 6 }}>신뢰도 {latestAnalysis.confidenceScore}점</div>
              <div>
                {resolved.map((r, i) => (
                  <span key={`res${i}`} style={{ ...badge, color: "#065f46", background: "#ecfdf5", border: "1px solid #6ee7b7", textDecoration: "line-through" }}>{r} ✓</span>
                ))}
                {afterReasons.map((r, i) => (
                  <span key={`rem${i}`} style={{ ...badge, ...rrStyle(r) }}>{r}</span>
                ))}
                {afterReasons.length === 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#059669" }}>✓ 검토 사유 없음 — 등록 가능</span>
                )}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: "#9ca3af" }}>
              {needsReparse
                ? "이름이 변경됨 — 저장 시 자동으로 재분석합니다"
                : "↺ 재분석 버튼을 누르면 미리 확인할 수 있습니다"}
            </div>
          )}
        </div>
      </div>

      {/* 편집 필드 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={fieldLabel}>수정명 *</label>
          <input
            value={editedName}
            onChange={e => { setEditedName(e.target.value); setReparsed(false); }}
            style={{ ...fieldInput, borderColor: nameChanged ? "#f59e0b" : "#d1d5db" }}
            placeholder="수정할 상품명"
            data-testid="review-fix-name-input"
          />
          {needsReparse && (
            <div style={{ fontSize: 10, color: "#d97706", marginTop: 2 }}>이름 변경 감지 — 저장 시 재분석이 자동 실행됩니다</div>
          )}
        </div>

        <div>
          <label style={fieldLabel}>상품 유형</label>
          <select value={editedType}
            onChange={e => { setEditedType(e.target.value); setReparsed(false); }}
            style={fieldInput}>
            {Object.entries(PRODUCT_TYPES_META as Record<string, { label: string }>).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={fieldLabel}>대분류</label>
          <select value={editedMainCat}
            onChange={e => { setEditedMainCat(e.target.value); setReparsed(false); }}
            style={fieldInput}>
            <option value="">선택 없음</option>
            {mainCats.map(c => <option key={c.label} value={c.label}>{c.label}</option>)}
          </select>
        </div>

        <div>
          <label style={fieldLabel}>출발 언어</label>
          <select value={editedSrc}
            onChange={e => { setEditedSrc(e.target.value); setReparsed(false); }}
            style={fieldInput}>
            <option value="">없음</option>
            {LANGUAGE_CODES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>

        <div>
          <label style={fieldLabel}>도착 언어</label>
          <select value={editedTgt}
            onChange={e => { setEditedTgt(e.target.value); setReparsed(false); }}
            style={fieldInput}>
            <option value="">없음</option>
            {LANGUAGE_CODES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <label style={fieldLabel}>메모 (운영자 내부 노트)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            style={{ ...fieldInput, resize: "vertical" }}
            placeholder="검토 판단 근거, 운영자 메모 — audit trail에 기록됩니다"
            data-testid="review-fix-notes-input"
          />
        </div>
      </div>

      {parseError && (
        <div style={{ padding: "8px 12px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, fontSize: 12, color: "#dc2626", marginBottom: 12 }}>
          ⚠ 재분석 오류: {parseError} — 기존 데이터를 유지한 채 저장됩니다.
        </div>
      )}

      {/* 버튼 */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 14, borderTop: "1px solid #e5e7eb" }}>
        <button
          onClick={onClose}
          disabled={saving}
          style={{ padding: "8px 16px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer", fontWeight: 500 }}
          data-testid="review-fix-cancel">
          취소
        </button>
        <button
          onClick={handleManualReparse}
          disabled={parsing || saving || !editedName.trim()}
          style={{ padding: "8px 16px", borderRadius: 7, border: "1px solid #2563eb", background: parsing ? "#93c5fd" : "#eff6ff", color: parsing ? "#1e40af" : "#2563eb", fontSize: 13, cursor: (parsing || saving) ? "not-allowed" : "pointer", fontWeight: 600 }}
          data-testid="review-fix-reparse"
          title="재분석 결과를 미리 확인합니다 (저장 시에도 자동 실행됨)">
          {parsing ? "재분석 중..." : "↺ 미리 재분석"}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || parsing || !editedName.trim()}
          style={{ padding: "8px 20px", borderRadius: 7, border: "none", background: (saving || parsing) ? "#9ca3af" : "#059669", color: "#fff", fontSize: 13, cursor: (saving || parsing) ? "not-allowed" : "pointer", fontWeight: 700 }}
          data-testid="review-fix-save"
          title={needsReparse ? "이름이 변경됨 — 저장 시 재분석이 자동 실행됩니다" : "현재 상태로 저장"}>
          {saving ? "저장 중..." : needsReparse ? "재분석 후 저장" : "✓ 저장"}
        </button>
      </div>
    </DraggableModal>
  );
}
