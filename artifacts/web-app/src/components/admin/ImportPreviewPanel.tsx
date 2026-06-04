import React, { useState, useEffect } from 'react';
import { api, LANGUAGE_CODES } from '../../lib/constants';
import { Card, GhostBtn } from '../ui';
import { ReviewFixConsoleModal, ReviewFixItem, ReparseSavePayload } from './ReviewFixConsoleModal';

// ─── Review Fix Console — Audit Trail ───────────────────────────────────────
export type AuditEntry = {
  actionType: "edit" | "reparse" | "approve" | "exclude" | "delete";
  changedAt: string;
  originalRawName?: string;
  editedRawName?: string;
  beforeReviewReasons?: string[];
  afterReviewReasons?: string[];
};

// ─── Review Persistence 모듈 레벨 타입 ─────────────────────────────────────
export type ImportPreviewItem = {
  rowNum: number; name: string; productType: string; mainCategory: string;
  subCategory: string; sourceLanguage: string | null; targetLanguage: string | null;
  unit: string; basePrice: number | null; description: string | null;
  status: "new" | "duplicate" | "conflict" | "review";
  issues: string[]; suggestedType: string;
  duplicateOf: { code: string; name: string }[];
  analysis: { productCandidate: string; langPair: string; direction: string; difficulty: string; industry: string; industry2: string; isOptionCandidate: boolean; confidenceScore: number; reviewReasons: string[]; displayName?: string; domain?: string; langHint?: string };
};

export type RowOverride = {
  reviewStatus: "pending" | "approved" | "rejected";
  rejectReason: string;
  overriddenCandidate: string | undefined;
  originalCandidate: string;
  reviewedAt?: string;
  reviewedBy?: string;
  // Review Fix Console 확장
  manuallyApproved?: boolean;
  approvedAt?: string;
  excluded?: boolean;
  excludedAt?: string;
  excludeReason?: string;
  originalRawName?: string;
  editedDisplayName?: string;   // ReviewFix 저장 후 canonical column 표시용
  notes?: string;
  auditTrail?: AuditEntry[];
};

export type ReviewSessionMeta = {
  sessionId: string;
  fileName: string;
  uploadedAt: string;
  totalRows: number;
};

export type PersistedReviewSession = {
  session: ReviewSessionMeta;
  importPreview: ImportPreviewData;
  rowOverrides: Record<number, RowOverride>;
};

// ─── Exported types for ProductManagementTab ─────────────────────────────────
export type ImportPreviewData = {
  summary: { total: number; new: number; duplicate: number; conflict: number; review: number };
  items: ImportPreviewItem[];
  fileName: string;
};

export type ImportResult = {
  created: number;
  errors: { row: number; message: string }[];
};

// ─── localStorage 헬퍼 ────────────────────────────────────────────────────
export const IMPORT_PREVIEW_SCHEMA_VERSION = 6;
export const REVIEW_SESSION_KEY = "veritas_review_session_v2";

export function loadReviewSession(): PersistedReviewSession | null {
  try {
    const raw = localStorage.getItem(REVIEW_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedReviewSession & { schemaVersion?: number };
    if ((parsed.schemaVersion ?? 1) !== IMPORT_PREVIEW_SCHEMA_VERSION) return null;
    if (parsed.importPreview?.items) {
      parsed.importPreview.items = parsed.importPreview.items.map(item => ({
        ...item,
        analysis: item.analysis
          ? { ...item.analysis, displayName: item.analysis.displayName ?? "" }
          : item.analysis,
      }));
    }
    return parsed;
  } catch { return null; }
}

export function saveReviewSession(data: PersistedReviewSession): void {
  try { localStorage.setItem(REVIEW_SESSION_KEY, JSON.stringify({ ...data, schemaVersion: IMPORT_PREVIEW_SCHEMA_VERSION })); } catch { /* storage quota */ }
}

export function clearReviewSession(): void {
  try { localStorage.removeItem(REVIEW_SESSION_KEY); } catch { /* ignore */ }
}

// ─── 언어 코드 레이블 ────────────────────────────────────────────────────────
const LANG_LABEL: Record<string, string> = Object.fromEntries(LANGUAGE_CODES.map(l => [l.code, l.label]));

// ─── 런타임 ISO→한글 확장 맵 (LANGUAGE_CODES 미포함 보완) ────────────────────
const ISO_TO_KR: Record<string, string> = {
  ...LANG_LABEL,
  zh:  "중국어",
  si:  "싱할라어",
  ne:  "네팔어",
  sw:  "스와힐리어",
  tl:  "타갈로그어",
  sr:  "세르비아어",
  ro:  "루마니아어",
  hu:  "헝가리어",
  bg:  "불가리아어",
  hr:  "크로아티아어",
  da:  "덴마크어",
  no:  "노르웨이어",
  fi:  "핀란드어",
  lt:  "리투아니아어",
  lv:  "라트비아어",
  et:  "에스토니아어",
  sk:  "슬로바키아어",
  sl:  "슬로베니아어",
  ky:  "키르기스어",
  tk:  "투르크멘어",
};

function humanizeProductName(raw: string): string {
  if (!raw?.trim()) return raw;
  let s = raw;
  s = s.replace(/(zh-hans|zh-hant)([→↔])([a-z]{2,3})/gi, (_, src, arr, tgt) =>
    `${ISO_TO_KR[src.toLowerCase()] ?? src} ${arr} ${ISO_TO_KR[tgt.toLowerCase()] ?? tgt}`);
  s = s.replace(/([a-z]{2,3})([→↔])(zh-hans|zh-hant)/gi, (_, src, arr, tgt) =>
    `${ISO_TO_KR[src.toLowerCase()] ?? src} ${arr} ${ISO_TO_KR[tgt.toLowerCase()] ?? tgt}`);
  s = s.replace(/\b([a-z]{2,3})([→↔])([a-z]{2,3})\b/gi, (_, src, arr, tgt) =>
    `${ISO_TO_KR[src.toLowerCase()] ?? src} ${arr} ${ISO_TO_KR[tgt.toLowerCase()] ?? tgt}`);
  s = s.replace(/^([a-z]{2,3})-([a-z]{2,3})(\s)/gi, (_, src, tgt, sp) =>
    `${ISO_TO_KR[src.toLowerCase()] ?? src}-${ISO_TO_KR[tgt.toLowerCase()] ?? tgt}${sp}`);
  return s;
}

function renderDirection(dir: string): string {
  if (!dir) return "";
  if (dir === "bidirectional") return "↔";
  const d = dir.replace(/\bto\b/gi, "→").replace(/[*]/g, "↔").replace(/<->|<>/g, "↔");
  if (/↔/.test(d)) return "↔";
  let h = d;
  h = h.replace(/(zh-hans|zh-hant)/gi, c => ISO_TO_KR[c.toLowerCase()] ?? c);
  h = h.replace(/\b([a-z]{2,3})\b/gi, c => ISO_TO_KR[c.toLowerCase()] ?? c);
  return h.replace(/\s*([→])\s*/g, " $1 ").trim();
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 8,
  border: '1px solid #d1d5db', fontSize: 14, color: '#111827',
  outline: 'none', boxSizing: 'border-box', background: '#fff',
};

// ─── Props ────────────────────────────────────────────────────────────────────
interface ImportPreviewPanelProps {
  preview: ImportPreviewData;
  initialRowOverrides?: Record<number, RowOverride>;
  initialSession?: ReviewSessionMeta | null;
  sessionRestored?: boolean;
  token: string;
  authHeaders: Record<string, string>;
  setToast: (msg: string) => void;
  onImportSuccess: (result: ImportResult) => void;
  onRequestClose: () => void;
}

export default function ImportPreviewPanel({
  preview: initialPreview,
  initialRowOverrides,
  initialSession,
  sessionRestored: sessionRestoredProp,
  token,
  authHeaders,
  setToast,
  onImportSuccess,
  onRequestClose,
}: ImportPreviewPanelProps) {
  const [importPreview, setImportPreview] = useState<ImportPreviewData>(initialPreview);
  const [importPreviewFilter, setImportPreviewFilter] = useState<"all" | "new" | "duplicate" | "conflict" | "review">("all");
  const [importExecuting, setImportExecuting] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [importPreviewSort, setImportPreviewSort] = useState<"conf_asc" | "conf_desc" | "risk_desc" | "risk_asc">("conf_asc");
  const [importQualFilter, setImportQualFilter] = useState<"all" | "review_only" | "safe_only" | "low_conf">("all");
  const [importPriorityFilter, setImportPriorityFilter] = useState<"all" | "high" | "review_needed" | "stable">("all");
  const [importConfirmModal, setImportConfirmModal] = useState<{ mode: "selected" | "safe" | "all"; rows: ImportPreviewItem[] } | null>(null);
  const [rowOverrides, setRowOverrides] = useState<Record<number, RowOverride>>(initialRowOverrides ?? {});
  const [reviewSession, setReviewSession] = useState<ReviewSessionMeta | null>(initialSession ?? null);
  const [isSessionRestored, setIsSessionRestored] = useState(sessionRestoredProp ?? false);
  const [editingRowNum, setEditingRowNum] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [importReviewFilter, setImportReviewFilter] = useState<"all" | "approved" | "rejected" | "pending" | "modified">("all");
  const [bulkConfirmModal, setBulkConfirmModal] = useState<{
    action: "approve" | "reject" | "override";
    rows: ImportPreviewItem[];
  } | null>(null);
  const [bulkRejectReason, setBulkRejectReason] = useState("");
  const [bulkOverrideValue, setBulkOverrideValue] = useState("");
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [reviewFixModal, setReviewFixModal] = useState<{ item: ReviewFixItem } | null>(null);
  const [excludeConfirmModal, setExcludeConfirmModal] = useState<{ item: ImportPreviewItem } | null>(null);
  const [excludeReasonInput, setExcludeReasonInput] = useState("");
  const [deletePreviewConfirmModal, setDeletePreviewConfirmModal] = useState<{ item: ImportPreviewItem } | null>(null);
  const [highRiskApproveConfirm, setHighRiskApproveConfirm] = useState<{ item: ImportPreviewItem } | null>(null);

  // ── rowOverrides / importPreview 변경 시 자동 저장 ────────────────────────
  useEffect(() => {
    if (!reviewSession) return;
    saveReviewSession({ session: reviewSession, importPreview, rowOverrides });
  }, [reviewSession, importPreview, rowOverrides]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Bulk Review 핸들러 ─────────────────────────────────────────────────
  const executeBulkApprove = (rows: ImportPreviewItem[]) => {
    const now = new Date().toISOString();
    setRowOverrides(prev => {
      const next = { ...prev };
      rows.forEach(item => {
        const base = next[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: item.analysis?.productCandidate ?? "" };
        next[item.rowNum] = { ...base, reviewStatus: "approved", reviewedAt: now };
      });
      return next;
    });
    setBulkConfirmModal(null);
    setSelectedRows(new Set());
  };

  const executeBulkReject = (rows: ImportPreviewItem[], reason: string) => {
    const now = new Date().toISOString();
    setRowOverrides(prev => {
      const next = { ...prev };
      rows.forEach(item => {
        const base = next[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: item.analysis?.productCandidate ?? "" };
        next[item.rowNum] = { ...base, reviewStatus: "rejected", rejectReason: reason, reviewedAt: now };
      });
      return next;
    });
    setBulkConfirmModal(null);
    setBulkRejectReason("");
    setSelectedRows(new Set());
  };

  const executeBulkOverride = (rows: ImportPreviewItem[], candidate: string) => {
    setRowOverrides(prev => {
      const next = { ...prev };
      rows.forEach(item => {
        const aiOriginal = item.analysis?.productCandidate ?? "";
        const ex = next[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: aiOriginal };
        next[item.rowNum] = { ...ex, overriddenCandidate: candidate, originalCandidate: ex.originalCandidate || aiOriginal };
      });
      return next;
    });
    setBulkConfirmModal(null);
    setBulkOverrideValue("");
    setSelectedRows(new Set());
  };

  // ─── Review Fix Console 핸들러 ───────────────────────────────────────────

  const executeRowApprove = (item: ImportPreviewItem) => {
    const now = new Date().toISOString();
    setRowOverrides(prev => {
      const base = prev[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: item.analysis?.productCandidate ?? "" };
      const entry: AuditEntry = { actionType: "approve", changedAt: now };
      return { ...prev, [item.rowNum]: { ...base, reviewStatus: "approved", manuallyApproved: true, approvedAt: now, auditTrail: [...(base.auditTrail ?? []), entry] } };
    });
    setHighRiskApproveConfirm(null);
  };

  const executeRowExclude = (item: ImportPreviewItem, reason: string) => {
    const now = new Date().toISOString();
    setRowOverrides(prev => {
      const base = prev[item.rowNum] ?? { reviewStatus: "pending" as const, rejectReason: reason, overriddenCandidate: undefined, originalCandidate: item.analysis?.productCandidate ?? "" };
      const entry: AuditEntry = { actionType: "exclude", changedAt: now, originalRawName: item.name };
      return { ...prev, [item.rowNum]: { ...base, reviewStatus: "rejected", excluded: true, excludedAt: now, excludeReason: reason, rejectReason: reason, auditTrail: [...(base.auditTrail ?? []), entry] } };
    });
    setExcludeConfirmModal(null);
    setExcludeReasonInput("");
  };

  const executeDeleteFromPreview = (rowNum: number) => {
    setImportPreview(prev => {
      if (!prev) return prev;
      return { ...prev, items: prev.items.filter(x => x.rowNum !== rowNum) };
    });
    setRowOverrides(prev => { const next = { ...prev }; delete next[rowNum]; return next; });
    setSelectedRows(prev => { const next = new Set(prev); next.delete(rowNum); return next; });
    setDeletePreviewConfirmModal(null);
  };

  const handleReparseSave = ({ rowNum, editedName, editedType, editedSrc, editedTgt, editedMainCat, analysis: newAnalysis, notes, reparsed }: ReparseSavePayload) => {
    const now = new Date().toISOString();
    const originalItem = importPreview?.items.find(x => x.rowNum === rowNum);

    const isGenericDisplay = !newAnalysis?.displayName ||
      newAnalysis.displayName === newAnalysis.productCandidate ||
      newAnalysis.displayName === "";
    const editedDisplayName = isGenericDisplay ? editedName : (newAnalysis?.displayName ?? editedName);

    setImportPreview(prev => {
      if (!prev) return prev;
      const updated = {
        ...prev,
        items: prev.items.map(x => x.rowNum !== rowNum ? x : {
          ...x, name: editedName, productType: editedType,
          sourceLanguage: editedSrc, targetLanguage: editedTgt,
          mainCategory: editedMainCat, analysis: newAnalysis,
        }),
      };
      return updated;
    });

    setRowOverrides(prev => {
      const base = prev[rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: originalItem?.analysis?.productCandidate ?? "" };
      const entry: AuditEntry = {
        actionType: reparsed ? "reparse" : "edit",
        changedAt: now,
        originalRawName: base.originalRawName ?? originalItem?.name,
        editedRawName: editedName,
        beforeReviewReasons: originalItem?.analysis?.reviewReasons ?? [],
        afterReviewReasons: newAnalysis?.reviewReasons ?? [],
      };
      const autoApprove = reparsed && (newAnalysis?.reviewReasons ?? []).length === 0 && base.reviewStatus === "pending";
      const updatedNotes = notes ? (base.notes ? `${base.notes}\n${notes}` : notes) : base.notes;
      const next = { ...prev, [rowNum]: {
        ...base,
        reviewStatus: autoApprove ? "approved" : base.reviewStatus,
        ...(autoApprove && { manuallyApproved: true, approvedAt: now }),
        originalRawName: base.originalRawName ?? originalItem?.name,
        editedDisplayName,
        notes: updatedNotes,
        auditTrail: [...(base.auditTrail ?? []), entry],
      }};
      return next;
    });

    setReviewFixModal(null);
  };

  const handleProductImportExecute = async (rows: ImportPreviewItem[]) => {
    if (!importPreview || rows.length === 0) { setToast("등록 대상 항목이 없습니다."); return; }
    setImportExecuting(true);
    try {
      const processedRows = rows.map(item => {
        const an = item.analysis;
        const ovr = rowOverrides[item.rowNum];
        const effectiveName = ovr?.overriddenCandidate || an?.displayName || an?.productCandidate || item.name;
        const dirStr = an?.direction ?? "";

        let parsedSrc: string | null = null;
        let parsedTgt: string | null = null;
        if (dirStr.includes("→") && !dirStr.includes("↔")) {
          const p = dirStr.split("→");
          parsedSrc = p[0]?.trim() || null;
          parsedTgt = p[1]?.trim() || null;
        } else if (dirStr.includes("↔")) {
          const p = dirStr.split("↔");
          parsedSrc = p[0]?.trim() || null;
          parsedTgt = p[1]?.trim() || null;
        }
        if ((dirStr.includes("→") || dirStr.includes("↔")) && (!parsedSrc || !parsedTgt)) {
          console.warn("[direction-parse-failed]", dirStr, { parsedSrc, parsedTgt, row: item.rowNum });
        }
        return {
          ...item,
          name: effectiveName,
          sourceLanguage: parsedSrc ?? item.sourceLanguage,
          targetLanguage: parsedTgt ?? item.targetLanguage,
        };
      });
      const res = await fetch(api("/api/admin/products/import/execute"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ rows: processedRows, fileName: importPreview.fileName }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(data.error ?? "등록 실패"); return; }
      setImportConfirmModal(null);
      setSelectedRows(new Set());
      clearReviewSession();
      setToast(`✅ ${data.created}건 등록 완료${data.errors?.length ? ` (오류 ${data.errors.length}건)` : ""}`);
      onImportSuccess(data);
    } finally {
      setImportExecuting(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
    new:       { label: "신규 등록", color: "#059669", bg: "#f0fdf4" },
    duplicate: { label: "유사 중복", color: "#d97706", bg: "#fffbeb" },
    conflict:  { label: "코드 충돌", color: "#dc2626", bg: "#fef2f2" },
    review:    { label: "검토 필요", color: "#7c3aed", bg: "#f5f3ff" },
  };
  const s = importPreview.summary;

  const isSafe = (item: ImportPreviewItem) =>
    item.status === "new" &&
    (item.analysis?.reviewReasons ?? []).length === 0 &&
    (item.analysis?.confidenceScore ?? 0) >= 60 &&
    !item.analysis?.industry2 &&
    (item.analysis?.productCandidate ?? "") !== "";

  const REJECT_REASONS = ["프로젝트명", "내부업무", "Product 아님", "설명형 텍스트", "중복 의미", "운영성 항목"];
  const REVIEW_STATUS_META = {
    pending:  { label: "보류", color: "#6b7280", bg: "#f3f4f6", border: "#d1d5db" },
    approved: { label: "승인", color: "#059669", bg: "#f0fdf4", border: "#bbf7d0" },
    rejected: { label: "제외", color: "#dc2626", bg: "#fef2f2", border: "#fca5a5" },
  };
  const getReviewStatus = (item: ImportPreviewItem): "pending" | "approved" | "rejected" =>
    rowOverrides[item.rowNum]?.reviewStatus ?? "pending";
  const getEffectiveCandidate = (item: ImportPreviewItem): string => {
    const ov = rowOverrides[item.rowNum];
    return ov?.overriddenCandidate !== undefined ? ov.overriddenCandidate : (item.analysis?.productCandidate ?? "");
  };
  const setRowReviewStatus = (rowNum: number, status: "pending" | "approved" | "rejected") =>
    setRowOverrides(prev => {
      const base = prev[rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: "" };
      return { ...prev, [rowNum]: { ...base, reviewStatus: status } };
    });
  const setRowRejectReason = (rowNum: number, reason: string) =>
    setRowOverrides(prev => {
      const base = prev[rowNum] ?? { reviewStatus: "rejected" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: "" };
      return { ...prev, [rowNum]: { ...base, rejectReason: reason } };
    });
  const setRowOverrideCandidate = (rowNum: number, value: string, aiOriginal: string) =>
    setRowOverrides(prev => {
      const ex = prev[rowNum] ?? { reviewStatus: "pending" as const, rejectReason: "", overriddenCandidate: undefined, originalCandidate: aiOriginal };
      return { ...prev, [rowNum]: { ...ex, overriddenCandidate: value, originalCandidate: ex.originalCandidate || aiOriginal } };
    });

  // ── Risk Priority Score ───────────────────────────────────────────
  const calcRiskScore = (item: ImportPreviewItem): number => {
    let score = 0;
    const conf = item.analysis?.confidenceScore ?? 0;
    if (conf < 60) score += 30;
    else if (conf < 70) score += 20;
    else if (conf < 80) score += 10;
    const reasons = item.analysis?.reviewReasons ?? [];
    score += reasons.length * 10;
    if (reasons.some(r => r.includes("프로젝트명") || r.includes("설명형"))) score += 25;
    if (reasons.some(r => r.includes("Product") || r.includes("불명확"))) score += 20;
    if (reasons.some(r => r.includes("언어") || r.includes("미지원"))) score += 20;
    if (reasons.some(r => r.includes("운영성"))) score += 10;
    if (reasons.includes("POTENTIAL_VARIANT_DUPLICATE")) score += 15;
    if (reasons.includes("ZH_AMBIGUOUS")) score += 10;
    if (reasons.includes("CANTONESE_REVIEW")) score += 5;
    if (rowOverrides[item.rowNum]?.overriddenCandidate !== undefined) score += 10;
    if (rowOverrides[item.rowNum]?.reviewStatus === "rejected") score += 15;
    return score;
  };
  const getRiskLevel = (score: number): "high" | "review_needed" | "stable" =>
    score >= 50 ? "high" : score >= 20 ? "review_needed" : "stable";
  const RISK_META = {
    high:          { label: "고위험", color: "#b91c1c", bg: "#fef2f2", border: "#fca5a5", borderLeft: "3px solid #f87171" },
    review_needed: { label: "검토필요", color: "#92400e", bg: "#fffbeb", border: "#fde68a", borderLeft: "3px solid #fbbf24" },
    stable:        { label: "안정",   color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb", borderLeft: "none" },
  };

  const safeAndNotRejected = importPreview.items.filter(x => isSafe(x) && getReviewStatus(x) !== "rejected");
  const allNewNotRejected = importPreview.items.filter(x => x.status === "new" && getReviewStatus(x) !== "rejected");
  const approvedCount = importPreview.items.filter(x => getReviewStatus(x) === "approved").length;
  const rejectedCount = importPreview.items.filter(x => getReviewStatus(x) === "rejected").length;
  const excludedCount = importPreview.items.filter(x => rowOverrides[x.rowNum]?.excluded === true).length;
  const modifiedCount = importPreview.items.filter(x => {
    const ov = rowOverrides[x.rowNum];
    return ov?.overriddenCandidate !== undefined && ov.overriddenCandidate !== (x.analysis?.productCandidate ?? "");
  }).length;
  const editedCount = importPreview.items.filter(x => !!rowOverrides[x.rowNum]?.editedDisplayName).length;
  const highRiskCount = importPreview.items.filter(x => getRiskLevel(calcRiskScore(x)) === "high").length;
  const reviewNeededCount = importPreview.items.filter(x => getRiskLevel(calcRiskScore(x)) === "review_needed").length;
  const stableCount = importPreview.items.filter(x => getRiskLevel(calcRiskScore(x)) === "stable").length;

  // 상태 탭 필터
  let filtered = importPreviewFilter === "all"
    ? importPreview.items
    : importPreview.items.filter(x => x.status === importPreviewFilter);

  // 품질 필터
  if (importQualFilter === "review_only") filtered = filtered.filter(x => !isSafe(x));
  else if (importQualFilter === "safe_only") filtered = filtered.filter(isSafe);
  else if (importQualFilter === "low_conf") filtered = filtered.filter(x => (x.analysis?.confidenceScore ?? 0) < 80);

  // 검토 상태 필터
  if (importReviewFilter === "approved") filtered = filtered.filter(x => getReviewStatus(x) === "approved");
  else if (importReviewFilter === "rejected") filtered = filtered.filter(x => getReviewStatus(x) === "rejected");
  else if (importReviewFilter === "pending") filtered = filtered.filter(x => getReviewStatus(x) === "pending");
  else if (importReviewFilter === "modified") filtered = filtered.filter(x => {
    const ov = rowOverrides[x.rowNum];
    return ov?.overriddenCandidate !== undefined && ov.overriddenCandidate !== (x.analysis?.productCandidate ?? "");
  });

  // Priority 필터
  if (importPriorityFilter !== "all")
    filtered = filtered.filter(x => getRiskLevel(calcRiskScore(x)) === importPriorityFilter);

  // 정렬
  filtered = [...filtered].sort((a, b) => {
    if (importPreviewSort === "risk_desc") return calcRiskScore(b) - calcRiskScore(a);
    if (importPreviewSort === "risk_asc")  return calcRiskScore(a) - calcRiskScore(b);
    const ca = a.analysis?.confidenceScore ?? 0;
    const cb = b.analysis?.confidenceScore ?? 0;
    return importPreviewSort === "conf_asc" ? ca - cb : cb - ca;
  });

  if (filtered.length === 0 && importPreview.items.length > 0) {
    console.warn("[ImportPreview] filter returned 0 rows unexpectedly", { importPreviewFilter, importQualFilter, importReviewFilter, importPriorityFilter });
  }

  const TAB_LABELS: [typeof importPreviewFilter, string, number][] = [
    ["all",       `전체 ${s.total}`,          s.total],
    ["new",       `신규 ${s.new}`,             s.new],
    ["duplicate", `유사중복 ${s.duplicate}`,   s.duplicate],
    ["conflict",  `충돌 ${s.conflict}`,        s.conflict],
    ["review",    `검토필요 ${s.review}`,      s.review],
  ];

  const allFilteredSelected = filtered.length > 0 && filtered.every(x => selectedRows.has(x.rowNum));
  const thStyle: React.CSSProperties = { position: "sticky", top: 0, zIndex: 5, padding: "6px 8px", textAlign: "left", color: "#9ca3af", fontWeight: 600, background: "#f9fafb", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap", fontSize: 11 };
  const qualBtnStyle = (k: string): React.CSSProperties => ({
    fontSize: 11, padding: "3px 9px", borderRadius: 5, border: `1px solid ${importQualFilter === k ? "#2563eb" : "#e5e7eb"}`,
    background: importQualFilter === k ? "#eff6ff" : "#fff", color: importQualFilter === k ? "#2563eb" : "#6b7280", cursor: "pointer", fontWeight: importQualFilter === k ? 700 : 400,
  });
  const sortBtnStyle = (k: string): React.CSSProperties => ({
    fontSize: 11, padding: "3px 9px", borderRadius: 5, border: `1px solid ${importPreviewSort === k ? "#7c3aed" : "#e5e7eb"}`,
    background: importPreviewSort === k ? "#f5f3ff" : "#fff", color: importPreviewSort === k ? "#7c3aed" : "#6b7280", cursor: "pointer", fontWeight: importPreviewSort === k ? 700 : 400,
  });
  const rvFilterBtnStyle = (k: string): React.CSSProperties => ({
    fontSize: 11, padding: "3px 9px", borderRadius: 5,
    border: `1px solid ${importReviewFilter === k ? "#0369a1" : "#e5e7eb"}`,
    background: importReviewFilter === k ? "#f0f9ff" : "#fff",
    color: importReviewFilter === k ? "#0369a1" : "#6b7280",
    cursor: "pointer", fontWeight: importReviewFilter === k ? 700 : 400,
  });

  return (
    <>
      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 16, overflow: "hidden" }}>
        {/* 헤더 */}
        <div style={{ background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>📋 Import 미리보기</span>
            <span style={{ fontSize: 11, color: "#6b7280", background: "#e5e7eb", borderRadius: 5, padding: "2px 7px" }}>{importPreview.fileName}</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {/* 선택 항목만 등록 — excluded(rejected) 행은 체크되어 있어도 항상 제외 */}
            <button
              disabled={selectedRows.size === 0 || importExecuting}
              onClick={() => {
                const rows = importPreview.items.filter(x => selectedRows.has(x.rowNum) && getReviewStatus(x) !== "rejected");
                if (rows.length > 0) setImportConfirmModal({ mode: "selected", rows });
                else setToast("선택된 항목이 모두 제외 처리되어 등록 대상이 없습니다.");
              }}
              style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, border: "none", background: selectedRows.size > 0 ? "#2563eb" : "#e5e7eb", color: selectedRows.size > 0 ? "#fff" : "#9ca3af", cursor: selectedRows.size > 0 ? "pointer" : "not-allowed", fontWeight: 700 }}>
              선택 {selectedRows.size}건 등록
            </button>
            {/* 검토필요 제외하고 등록 (제외 처리된 항목 자동 제외) */}
            <button
              disabled={safeAndNotRejected.length === 0 || importExecuting}
              onClick={() => { if (safeAndNotRejected.length > 0) setImportConfirmModal({ mode: "safe", rows: safeAndNotRejected }); }}
              style={{ fontSize: 12, padding: "5px 12px", borderRadius: 7, border: "1px solid #059669", background: safeAndNotRejected.length > 0 ? "#f0fdf4" : "#f9fafb", color: safeAndNotRejected.length > 0 ? "#059669" : "#9ca3af", cursor: safeAndNotRejected.length > 0 ? "pointer" : "not-allowed", fontWeight: 700 }}>
              검토필요 제외 {safeAndNotRejected.length}건 등록
            </button>
            {/* 전체 등록 — 보조 버튼 스타일 (제외 처리된 항목 자동 제외) */}
            <button
              disabled={allNewNotRejected.length === 0 || importExecuting}
              onClick={() => { if (allNewNotRejected.length > 0) setImportConfirmModal({ mode: "all", rows: allNewNotRejected }); }}
              style={{ fontSize: 11, padding: "5px 10px", borderRadius: 7, border: "1px solid #d1d5db", background: "#f9fafb", color: allNewNotRejected.length > 0 ? "#6b7280" : "#9ca3af", cursor: allNewNotRejected.length > 0 ? "pointer" : "not-allowed", fontWeight: 500 }}>
              전체 {allNewNotRejected.length}건
            </button>
            <button
              onClick={() => setShowAnalytics(v => !v)}
              style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: `1px solid ${showAnalytics ? "#1d4ed8" : "#d1d5db"}`, background: showAnalytics ? "#eff6ff" : "#fff", color: showAnalytics ? "#1d4ed8" : "#6b7280", cursor: "pointer", fontWeight: showAnalytics ? 700 : 400 }}>
              📊 분석
            </button>
            <button onClick={() => { setSelectedRows(new Set()); onRequestClose(); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: 20, lineHeight: 1, padding: "0 4px" }}>×</button>
          </div>
        </div>

        {/* 세션 복원/진행 바 */}
        {(isSessionRestored || reviewSession) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 16px", background: isSessionRestored ? "#fffbeb" : "#f0f9ff", borderBottom: "1px solid #e5e7eb", fontSize: 11, gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: isSessionRestored ? "#92400e" : "#0369a1" }}>
              {isSessionRestored
                ? `📂 이전 세션 복원됨 — ${reviewSession?.fileName ?? ""} · ${reviewSession?.uploadedAt ? new Date(reviewSession.uploadedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""} · 승인 ${approvedCount} / 제외 ${rejectedCount} / 행편집 ${editedCount}`
                : `💾 세션 자동 저장 중 — ${reviewSession?.fileName ?? ""}`}
            </span>
            <button
              onClick={() => {
                clearReviewSession();
                setReviewSession(null);
                setIsSessionRestored(false);
                setRowOverrides({});
                setSelectedRows(new Set());
                onRequestClose();
              }}
              style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid #d97706", background: "#fffbeb", color: "#92400e", cursor: "pointer", fontWeight: 600, flexShrink: 0 }}>
              초기화
            </button>
          </div>
        )}

        {/* Bulk Review Toolbar — 선택 항목 있을 때만 표시 */}
        {selectedRows.size > 0 && (() => {
          const selItems = importPreview.items.filter(x => selectedRows.has(x.rowNum));
          const selApproved = selItems.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "approved").length;
          const selRejected = selItems.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "rejected").length;
          const selPending = selItems.length - selApproved - selRejected;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#1d4ed8", flexShrink: 0 }}>
                선택 {selectedRows.size}건
              </span>
              <span style={{ fontSize: 11, color: "#6b7280", paddingRight: 8, borderRight: "1px solid #bfdbfe" }}>
                승인 {selApproved} · 제외 {selRejected} · 보류 {selPending}
              </span>
              <button
                onClick={() => setBulkConfirmModal({ action: "approve", rows: selItems })}
                style={{ fontSize: 11, padding: "4px 11px", borderRadius: 5, border: "none", background: "#059669", color: "#fff", cursor: "pointer", fontWeight: 700 }}>
                ✅ 일괄 승인
              </button>
              <button
                onClick={() => { setBulkRejectReason(""); setBulkConfirmModal({ action: "reject", rows: selItems }); }}
                style={{ fontSize: 11, padding: "4px 11px", borderRadius: 5, border: "none", background: "#dc2626", color: "#fff", cursor: "pointer", fontWeight: 700 }}>
                🚫 일괄 제외
              </button>
              <button
                onClick={() => { setBulkOverrideValue(""); setBulkConfirmModal({ action: "override", rows: selItems }); }}
                style={{ fontSize: 11, padding: "4px 11px", borderRadius: 5, border: "1px solid #7c3aed", background: "#f5f3ff", color: "#7c3aed", cursor: "pointer", fontWeight: 700 }}>
                ✏️ Product 일괄 수정
              </button>
              <button onClick={() => setSelectedRows(new Set())}
                style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, border: "1px solid #d1d5db", background: "#fff", color: "#9ca3af", cursor: "pointer", marginLeft: "auto" }}>
                ✕ 선택 해제
              </button>
            </div>
          );
        })()}

        {/* 카운트 바 */}
        <div style={{ display: "flex", gap: 14, padding: "6px 16px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb", fontSize: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ color: "#374151" }}>신규 <strong style={{ color: "#059669" }}>{s.new}</strong></span>
          <span style={{ color: "#374151" }}>중복 <strong style={{ color: "#d97706" }}>{s.duplicate}</strong></span>
          <span style={{ color: "#374151" }}>충돌 <strong style={{ color: "#dc2626" }}>{s.conflict}</strong></span>
          <span style={{ color: "#374151" }}>검토필요 <strong style={{ color: "#7c3aed" }}>{s.review}</strong></span>
          <span style={{ color: "#374151" }}>등록가능 <strong style={{ color: "#059669" }}>{safeAndNotRejected.length}</strong></span>
          <span style={{ color: "#6b7280", fontSize: 11 }}>|</span>
          {approvedCount > 0 && <span style={{ color: "#374151" }}>승인 <strong style={{ color: "#059669" }}>{approvedCount}</strong></span>}
          {rejectedCount > 0 && <span style={{ color: "#374151" }}>제외 <strong style={{ color: "#dc2626" }}>{rejectedCount}</strong>{excludedCount > 0 && <span style={{ fontSize: 10, color: "#9ca3af" }}> ({excludedCount}명시)</span>}</span>}
          {modifiedCount > 0 && <span style={{ color: "#374151" }}>후보수정 <strong style={{ color: "#7c3aed" }}>{modifiedCount}</strong></span>}
          {editedCount > 0 && <span style={{ color: "#374151" }}>행편집 <strong style={{ color: "#059669" }}>{editedCount}</strong></span>}
          <span style={{ color: "#6b7280", fontSize: 11 }}>|</span>
          {highRiskCount > 0 && <span style={{ color: "#374151" }}>고위험 <strong style={{ color: "#b91c1c" }}>{highRiskCount}</strong></span>}
          {reviewNeededCount > 0 && <span style={{ color: "#374151" }}>검토필요 <strong style={{ color: "#92400e" }}>{reviewNeededCount}</strong></span>}
          {stableCount > 0 && <span style={{ color: "#374151" }}>안정 <strong style={{ color: "#6b7280" }}>{stableCount}</strong></span>}
          {selectedRows.size > 0 && (
            <span style={{ color: "#374151" }}>선택됨 <strong style={{ color: "#2563eb" }}>{selectedRows.size}</strong>
              <button onClick={() => setSelectedRows(new Set())} style={{ marginLeft: 4, fontSize: 10, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: 0 }}>✕ 해제</button>
            </span>
          )}
        </div>

        {/* Review Analytics Dashboard */}
        {showAnalytics && (() => {
          const total = importPreview.items.length;
          const apvd = importPreview.items.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "approved").length;
          const rjcd = importPreview.items.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "rejected").length;
          const ovrd = importPreview.items.filter(x => {
            const ov = rowOverrides[x.rowNum];
            return ov?.overriddenCandidate !== undefined && ov.overriddenCandidate !== (x.analysis?.productCandidate ?? "");
          }).length;
          const pndg = total - apvd - rjcd;
          const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;

          const rejectCounts: Record<string, number> = {};
          importPreview.items.forEach(item => {
            const ov = rowOverrides[item.rowNum];
            if (ov?.reviewStatus === "rejected" && ov.rejectReason) {
              rejectCounts[ov.rejectReason] = (rejectCounts[ov.rejectReason] ?? 0) + 1;
            }
          });
          const rejectPatterns = Object.entries(rejectCounts).sort((a, b) => b[1] - a[1]);

          const overridePairs: Record<string, number> = {};
          importPreview.items.forEach(item => {
            const ov = rowOverrides[item.rowNum];
            if (ov?.overriddenCandidate !== undefined && ov.overriddenCandidate !== (item.analysis?.productCandidate ?? "")) {
              const key = `${ov.originalCandidate || (item.analysis?.productCandidate ?? "")} → ${ov.overriddenCandidate}`;
              overridePairs[key] = (overridePairs[key] ?? 0) + 1;
            }
          });
          const overridePatterns = Object.entries(overridePairs).sort((a, b) => b[1] - a[1]).slice(0, 5);

          const confBands = [
            { label: "90+",    min: 90, max: 100 },
            { label: "80~89",  min: 80, max: 89  },
            { label: "70~79",  min: 70, max: 79  },
            { label: "60~69",  min: 60, max: 69  },
            { label: "60미만", min: 0,  max: 59  },
          ];
          const confData = confBands.map(band => {
            const items = importPreview.items.filter(x => {
              const c = x.analysis?.confidenceScore ?? 0;
              return c >= band.min && c <= band.max;
            });
            return {
              ...band,
              count: items.length,
              approved: items.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "approved").length,
              rejected: items.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "rejected").length,
            };
          });

          const insights: string[] = [];
          const dashHighRisk = importPreview.items.filter(x => getRiskLevel(calcRiskScore(x)) === "high").length;
          if (dashHighRisk > 0) insights.push(`고위험 항목 ${dashHighRisk}건 — 우선 검토 권장`);
          if (rejectPatterns.length > 0) insights.push(`가장 빈번한 제외 사유: "${rejectPatterns[0][0]}" ${rejectPatterns[0][1]}건`);
          const lowConfApproved = importPreview.items.filter(x => (x.analysis?.confidenceScore ?? 0) < 60 && rowOverrides[x.rowNum]?.reviewStatus === "approved").length;
          if (lowConfApproved > 0) insights.push(`신뢰도 60미만 승인 항목 ${lowConfApproved}건 — 재검토 권장`);
          const pendingUnsafe = importPreview.items.filter(x => !isSafe(x) && (rowOverrides[x.rowNum]?.reviewStatus ?? "pending") === "pending").length;
          if (pendingUnsafe > 0) insights.push(`검토필요 보류 항목 ${pendingUnsafe}건 남음`);
          const projNameItems = importPreview.items.filter(x => (x.analysis?.reviewReasons ?? []).some(r => r.includes("프로젝트명"))).length;
          if (projNameItems > 0) insights.push(`프로젝트명 가능성 항목 ${projNameItems}건`);
          const unsupportedLangItems = importPreview.items.filter(x => (x.analysis?.reviewReasons ?? []).some(r => r.includes("언어") || r.includes("미지원"))).length;
          if (unsupportedLangItems > 0) insights.push(`미지원 언어 포함 항목 ${unsupportedLangItems}건`);
          const zhAmbiguousItems = importPreview.items.filter(x => (x.analysis?.reviewReasons ?? []).includes("ZH_AMBIGUOUS")).length;
          const variantItems = importPreview.items.filter(x => (x.analysis?.reviewReasons ?? []).includes("POTENTIAL_VARIANT_DUPLICATE")).length;
          const cantoneseItems = importPreview.items.filter(x => (x.analysis?.reviewReasons ?? []).includes("CANTONESE_REVIEW")).length;
          if (zhAmbiguousItems > 0) insights.push(`중국어 모호 표기 ${zhAmbiguousItems}건 — 간체/번체 확인 필요`);
          if (variantItems > 0) insights.push(`기존 ZH 계열 variant ${variantItems}건 — 중복 여부 확인`);
          if (cantoneseItems > 0) insights.push(`광동어 표기(zh-hant 분류됨) ${cantoneseItems}건`);
          const strippedInterpItems = importPreview.items.filter(x => (x.analysis?.reviewReasons ?? []).includes("SCRIPT_VARIANT_STRIPPED_FOR_INTERP")).length;
          if (strippedInterpItems > 0) insights.push(`통역 상품 script variant(간체/번체) 제거됨 ${strippedInterpItems}건 — 중국어로 통합 표시`);

          const statCard = (label: string, value: number, color: string, showPct?: boolean) => (
            <div key={label} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "6px 12px", minWidth: 66, textAlign: "center", flex: "0 0 auto" }}>
              <div style={{ fontSize: 17, fontWeight: 700, color }}>{value}</div>
              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1 }}>{label}</div>
              {showPct && <div style={{ fontSize: 10, fontWeight: 700, color }}>{pct(value)}%</div>}
            </div>
          );

          return (
            <div style={{ background: "#f9fafb", borderBottom: "1px solid #e5e7eb", padding: "12px 16px" }}>
              {/* Summary */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                {statCard("총 항목", total, "#374151")}
                {statCard("승인", apvd, "#059669", true)}
                {statCard("제외", rjcd, "#dc2626", true)}
                {statCard("수정됨", ovrd, "#7c3aed", true)}
                {statCard("보류", pndg, "#6b7280", true)}
              </div>

              {/* 3-panel row */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {/* Reject Pattern */}
                <div style={{ flex: "1 1 150px", background: "#fff", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 12px" }}>
                  <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "#dc2626" }}>🚫 제외 패턴</p>
                  {rejectPatterns.length === 0
                    ? <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>없음</p>
                    : rejectPatterns.map(([reason, count]) => (
                      <div key={reason} style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, gap: 6 }}>
                        <span style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</span>
                        <strong style={{ fontSize: 11, color: "#dc2626", flexShrink: 0 }}>{count}</strong>
                      </div>
                    ))
                  }
                </div>

                {/* Override Pattern */}
                <div style={{ flex: "1 1 190px", background: "#fff", border: "1px solid #c4b5fd", borderRadius: 8, padding: "8px 12px" }}>
                  <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "#7c3aed" }}>✏️ 수정 패턴 (Top 5)</p>
                  {overridePatterns.length === 0
                    ? <p style={{ margin: 0, fontSize: 11, color: "#9ca3af" }}>없음</p>
                    : overridePatterns.map(([pair, count]) => (
                      <div key={pair} style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, gap: 6 }}>
                        <span style={{ fontSize: 11, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pair}</span>
                        <strong style={{ fontSize: 11, color: "#7c3aed", flexShrink: 0 }}>{count}</strong>
                      </div>
                    ))
                  }
                </div>

                {/* Confidence Distribution */}
                <div style={{ flex: "1 1 170px", background: "#fff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "8px 12px" }}>
                  <p style={{ margin: "0 0 6px", fontSize: 11, fontWeight: 700, color: "#1d4ed8" }}>📊 신뢰도 분포</p>
                  {confData.map(band => band.count === 0 ? null : (
                    <div key={band.label} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, color: "#6b7280", width: 38, flexShrink: 0 }}>{band.label}</span>
                      <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${Math.round((band.count / total) * 100)}%`, background: band.min >= 80 ? "#059669" : band.min >= 60 ? "#d97706" : "#dc2626", borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 10, color: "#374151", width: 20, textAlign: "right", flexShrink: 0 }}>{band.count}</span>
                      {band.approved > 0 && <span style={{ fontSize: 9, color: "#059669", flexShrink: 0 }}>✓{band.approved}</span>}
                      {band.rejected > 0 && <span style={{ fontSize: 9, color: "#dc2626", flexShrink: 0 }}>✕{band.rejected}</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Priority Insights */}
              {insights.length > 0 && (
                <div style={{ marginTop: 10, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "7px 12px" }}>
                  <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 700, color: "#92400e" }}>💡 우선 검토 인사이트</p>
                  {insights.map((ins, i) => (
                    <p key={i} style={{ margin: "2px 0 0", fontSize: 11, color: "#78350f" }}>• {ins}</p>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* 상태 탭 */}
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #e5e7eb", background: "#fff", overflowX: "auto" }}>
          {TAB_LABELS.map(([key, label, count]) => count > 0 || key === "all" ? (
            <button key={key} onClick={() => setImportPreviewFilter(key)}
              style={{ padding: "7px 14px", fontSize: 12, fontWeight: importPreviewFilter === key ? 700 : 500, border: "none", background: "none", cursor: "pointer", color: importPreviewFilter === key ? "#2563eb" : "#6b7280", borderBottom: importPreviewFilter === key ? "2px solid #2563eb" : "2px solid transparent", whiteSpace: "nowrap" }}>
              {label}
            </button>
          ) : null)}
        </div>

        {/* 품질 필터 + 정렬 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f0", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginRight: 2 }}>품질:</span>
          {(["all", "review_only", "safe_only", "low_conf"] as const).map(k => (
            <button key={k} onClick={() => setImportQualFilter(k)} style={qualBtnStyle(k)}>
              {k === "all" ? "전체" : k === "review_only" ? "검토필요만" : k === "safe_only" ? "등록가능만" : "신뢰도 80미만"}
            </button>
          ))}
          <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginLeft: 8, marginRight: 2 }}>정렬:</span>
          {(["conf_asc", "conf_desc", "risk_desc", "risk_asc"] as const).map(k => (
            <button key={k} onClick={() => setImportPreviewSort(k)} style={sortBtnStyle(k)}>
              {k === "conf_asc" ? "낮은신뢰도순" : k === "conf_desc" ? "높은신뢰도순" : k === "risk_desc" ? "위험도높은순" : "위험도낮은순"}
            </button>
          ))}
        </div>
        {/* Priority 필터 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 14px", background: "#fafafa", borderBottom: "1px solid #f0f0f0", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginRight: 2 }}>위험도:</span>
          {([
            ["all",          "전체",                          "#6b7280", "#fff",    "#e5e7eb"],
            ["high",         `고위험 ${highRiskCount}`,       "#b91c1c", "#fef2f2", "#fca5a5"],
            ["review_needed",`검토필요 ${reviewNeededCount}`, "#92400e", "#fffbeb", "#fde68a"],
            ["stable",       `안정 ${stableCount}`,           "#6b7280", "#f9fafb", "#e5e7eb"],
          ] as const).map(([k, label, tc, bg, bc]) => (
            <button key={k} onClick={() => setImportPriorityFilter(k)}
              style={{ fontSize: 11, padding: "3px 9px", borderRadius: 5, cursor: "pointer",
                border: `1px solid ${importPriorityFilter === k ? bc : "#e5e7eb"}`,
                background: importPriorityFilter === k ? bg : "#fff",
                color: importPriorityFilter === k ? tc : "#6b7280",
                fontWeight: importPriorityFilter === k ? 700 : 400 }}>
              {label}
            </button>
          ))}
        </div>
        {/* 검토 상태 필터 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 14px", background: "#f5f7fa", borderBottom: "1px solid #eaecf0", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginRight: 2 }}>검토:</span>
          {([
            ["all",      "전체"],
            ["pending",  `보류${importReviewFilter === "pending" ? "" : rejectedCount + approvedCount > 0 ? ` (${importPreview.items.length - approvedCount - rejectedCount})` : ""}`],
            ["approved", `승인${approvedCount > 0 ? ` ${approvedCount}` : ""}`],
            ["rejected", `제외${rejectedCount > 0 ? ` ${rejectedCount}` : ""}`],
            ["modified", `수정됨${modifiedCount > 0 ? ` ${modifiedCount}` : ""}`],
          ] as const).map(([k, label]) => (
            <button key={k} onClick={() => setImportReviewFilter(k)} style={rvFilterBtnStyle(k)}>{label}</button>
          ))}
        </div>

        {/* 미리보기 테이블 — 단일 scroll 컨테이너 (sticky 정상 동작) */}
        <div style={{ maxHeight: 320, overflowY: "auto", overflowX: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0", fontSize: 13, color: "#9ca3af" }}>해당 항목 없음</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 1400 }}>
              <thead>
                <tr>
                  {/* 체크박스 헤더 */}
                  <th style={{ ...thStyle, width: 32, textAlign: "center" }}>
                    <input type="checkbox" checked={allFilteredSelected}
                      onChange={e => {
                        if (e.target.checked) {
                          setSelectedRows(prev => new Set([...prev, ...filtered.map(x => x.rowNum)]));
                        } else {
                          setSelectedRows(prev => { const n = new Set(prev); filtered.forEach(x => n.delete(x.rowNum)); return n; });
                        }
                      }} />
                  </th>
                  {(["행", "상품명(canonical)", "Product 후보", "언어쌍", "방향", "유형", "단위", "단가", "상태", "이슈", "검토", "액션"] as const).map(h => {
                    const minW: Record<string, number> = {
                      "상품명(canonical)": 220,
                      "Product 후보":       180,
                      "언어쌍":             200,
                      "방향":               150,
                    };
                    return <th key={h} style={{ ...thStyle, minWidth: minW[h] }}>{h}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {filtered.map((item, idx) => {
                  const sm = STATUS_META[item.status] ?? STATUS_META.review;
                  const an = item.analysis ?? { productCandidate: "", langPair: "", direction: "", difficulty: "", industry: "", industry2: "", isOptionCandidate: false, confidenceScore: 0, reviewReasons: [] };
                  const isBidir = an.direction === "bidirectional" || (an.direction?.includes("↔") ?? false);
                  const isSelected = selectedRows.has(item.rowNum);
                  const riskScore = calcRiskScore(item);
                  const riskLevel = getRiskLevel(riskScore);
                  const riskMeta = RISK_META[riskLevel];
                  return (
                    <tr key={idx} style={{ borderBottom: "1px solid #f3f4f6", background: isSelected ? "#eff6ff" : (idx % 2 === 0 ? "#fff" : "#fafafa"), borderLeft: riskMeta.borderLeft }}>
                      {/* 체크박스 */}
                      <td style={{ padding: "4px 8px", textAlign: "center" }}>
                        <input type="checkbox" checked={isSelected}
                          onChange={e => setSelectedRows(prev => { const n = new Set(prev); if (e.target.checked) n.add(item.rowNum); else n.delete(item.rowNum); return n; })} />
                      </td>
                      <td style={{ padding: "4px 8px", color: "#c4c4c4", fontFamily: "monospace", fontSize: 11, verticalAlign: "top" }}>
                        {riskLevel !== "stable" && (
                          <div title={`위험도 ${riskScore}점 — ${riskLevel === "high" ? "우선 검토 권장" : "검토 필요"}`}
                            style={{ fontSize: 9, fontWeight: 700, color: riskMeta.color, background: riskMeta.bg, border: `1px solid ${riskMeta.border}`, borderRadius: 3, padding: "0 4px", marginBottom: 2, display: "inline-block", cursor: "default", whiteSpace: "nowrap" }}>
                            {riskMeta.label}
                          </div>
                        )}
                        <div>{item.rowNum}</div>
                      </td>
                      {/* 상품명(canonical): ReviewFix 편집명 > parser displayName > humanize fallback */}
                      {(() => {
                        const ovr = rowOverrides[item.rowNum];
                        const isGenericDisplay = !an?.displayName || an.displayName === an?.productCandidate;
                        const canonicalLabel =
                          ovr?.editedDisplayName ||
                          (!isGenericDisplay ? an?.displayName : null) ||
                          humanizeProductName(item.name);
                        const isEdited = !!ovr?.editedDisplayName;
                        const originalName = ovr?.originalRawName ?? item.name;
                        return (
                          <td
                            title={`원본: ${originalName}${isEdited ? ` → 수정됨` : ""}`}
                            style={{ padding: "4px 8px", color: isEdited ? "#059669" : "#374151", minWidth: 220, whiteSpace: "nowrap", fontWeight: isEdited ? 600 : 400 }}
                          >
                            {canonicalLabel}
                            {isEdited && (
                              <span style={{ marginLeft: 4, fontSize: 9, color: "#059669", background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 3, padding: "0 3px" }}>수정됨</span>
                            )}
                          </td>
                        );
                      })()}
                      {/* Product 후보 — 클릭하여 inline 수정 가능 */}
                      <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                        {editingRowNum === item.rowNum ? (
                          <input
                            autoFocus
                            value={editingValue}
                            onChange={e => setEditingValue(e.target.value)}
                            onBlur={() => { setRowOverrideCandidate(item.rowNum, editingValue, an.productCandidate); setEditingRowNum(null); }}
                            onKeyDown={e => {
                              if (e.key === "Enter") { setRowOverrideCandidate(item.rowNum, editingValue, an.productCandidate); setEditingRowNum(null); }
                              if (e.key === "Escape") setEditingRowNum(null);
                            }}
                            style={{ fontSize: 11, padding: "1px 5px", border: "1px solid #2563eb", borderRadius: 3, outline: "none", width: 90, color: "#111827" }}
                          />
                        ) : (() => {
                          const eff = getEffectiveCandidate(item);
                          const isOverridden = rowOverrides[item.rowNum]?.overriddenCandidate !== undefined;
                          return (
                            <>
                              <span
                                title={isOverridden
                                  ? `AI 추천: ${an.productCandidate} → 수정: ${eff} (클릭하여 재수정)`
                                  : `AI 분석 추천값 — 클릭하여 수정`}
                                onClick={() => { setEditingRowNum(item.rowNum); setEditingValue(eff); }}
                                style={{
                                  fontSize: 11, cursor: "text",
                                  color: isOverridden ? "#7c3aed" : "#374151",
                                  fontWeight: isOverridden ? 700 : 500,
                                  background: isOverridden ? "#f5f3ff" : "#f3f4f6",
                                  borderRadius: 3, padding: "1px 6px",
                                  border: `1px solid ${isOverridden ? "#c4b5fd" : "#e5e7eb"}`,
                                }}>
                                {eff || <span style={{ color: "#c4c4c4" }}>—</span>}
                              </span>
                              {isOverridden && rowOverrides[item.rowNum]?.originalCandidate && rowOverrides[item.rowNum].originalCandidate !== eff && (
                                <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1, textDecoration: "line-through", lineHeight: "13px" }}>
                                  {rowOverrides[item.rowNum].originalCandidate}
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {an.displayName && an.displayName !== an.productCandidate && !rowOverrides[item.rowNum]?.overriddenCandidate && (
                          <div style={{ fontSize: 10, color: "#1d4ed8", marginTop: 2, background: "#eff6ff", borderRadius: 3, padding: "1px 5px", display: "inline-block", whiteSpace: "nowrap" }}>
                            {an.displayName}
                          </div>
                        )}
                      {an.isOptionCandidate && (
                          <span title="동일 서비스가 여러 언어쌍/산업으로 반복 — 옵션화 가능" style={{ marginLeft: 4, fontSize: 10, color: "#6d28d9", background: "#ede9fe", borderRadius: 3, padding: "1px 4px", fontWeight: 600, cursor: "default" }}>옵션화 가능</span>
                        )}
                      </td>
                      {/* 언어쌍 */}
                      <td style={{ padding: "4px 8px", color: "#374151", whiteSpace: "nowrap", fontSize: 12 }}>{an.langPair || ""}</td>
                      {/* 방향 */}
                      <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                        {an.direction ? (
                          <span style={{ fontSize: 11, color: isBidir ? "#059669" : "#6b7280", background: isBidir ? "#f0fdf4" : "#f9fafb", border: `1px solid ${isBidir ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 3, padding: "1px 5px" }}>
                            {renderDirection(an.direction)}
                          </span>
                        ) : ""}
                      </td>
                      {/* 유형 */}
                      <td style={{ padding: "4px 8px", color: "#374151", whiteSpace: "nowrap", fontSize: 11 }}>
                        {item.productType}
                        {item.suggestedType && item.suggestedType !== item.productType && (
                          <span style={{ marginLeft: 3, fontSize: 10, color: "#a78bfa" }}>→{item.suggestedType}</span>
                        )}
                      </td>
                      <td style={{ padding: "4px 8px", color: "#6b7280", fontSize: 11 }}>{item.unit}</td>
                      <td style={{ padding: "4px 8px", color: "#374151", textAlign: "right", fontSize: 11 }}>{item.basePrice != null ? item.basePrice.toLocaleString() : ""}</td>
                      {/* 상태 + confidence */}
                      <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg, borderRadius: 4, padding: "1px 6px" }}>{sm.label}</span>
                        {typeof an.confidenceScore === "number" && (
                          <span title={`분석 신뢰도 ${an.confidenceScore}점`} style={{ marginLeft: 4, fontSize: 10, color: an.confidenceScore >= 80 ? "#059669" : an.confidenceScore >= 60 ? "#d97706" : "#dc2626", cursor: "default" }}>
                            {an.confidenceScore}
                          </span>
                        )}
                      </td>
                      {/* 이슈 + 검토 사유 chip */}
                      <td style={{ padding: "4px 8px", maxWidth: 200, fontSize: 11 }}>
                        {(an.reviewReasons ?? []).map((r, i) => {
                          const CODE_STYLE: Record<string, { color: string; background: string; border: string }> = {
                            COUNTRY_NOT_LANGUAGE:        { color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe" },
                            UNKNOWN_LANGUAGE:            { color: "#dc2626", background: "#fef2f2", border: "1px solid #fca5a5" },
                            MULTI_LANGUAGE_AMBIGUOUS:    { color: "#0891b2", background: "#ecfeff", border: "1px solid #a5f3fc" },
                            DOMAIN_BASED:                { color: "#059669", background: "#f0fdf4", border: "1px solid #86efac" },
                            MISSING_DIRECTION:           { color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a" },
                            REGION_LANGUAGE_AMBIGUOUS:   { color: "#1d4ed8", background: "#eff6ff", border: "1px solid #bfdbfe" },
                            DOMAIN_SPECIALIZED_REVIEW:   { color: "#7c3aed", background: "#faf5ff", border: "1px solid #e9d5ff" },
                            ZH_AMBIGUOUS:                { color: "#b45309", background: "#fef3c7", border: "1px solid #fcd34d" },
                            POTENTIAL_VARIANT_DUPLICATE: { color: "#6d28d9", background: "#ede9fe", border: "1px solid #c4b5fd" },
                            CANTONESE_REVIEW:            { color: "#0369a1", background: "#e0f2fe", border: "1px solid #7dd3fc" },
                            COMPACT_DIRECTION_PATTERN:   { color: "#065f46", background: "#ecfdf5", border: "1px solid #6ee7b7" },
                            COUNTRY_LANGUAGE_ALIAS:      { color: "#92400e", background: "#fffbeb", border: "1px solid #fcd34d" },
                            AMBIGUOUS_LANGUAGE:          { color: "#9a3412", background: "#fff7ed", border: "1px solid #fdba74" },
                            MULTI_LANGUAGE_DETECTED:     { color: "#0891b2", background: "#ecfeff", border: "1px solid #67e8f9" },
                            UNKNOWN_ABBREVIATION:        { color: "#dc2626", background: "#fef2f2", border: "1px solid #fca5a5" },
                            REVIEW_REQUIRED_LANGUAGE:    { color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a" },
                            SCRIPT_VARIANT_STRIPPED_FOR_INTERP: { color: "#065f46", background: "#ecfdf5", border: "1px solid #6ee7b7" },
                          };
                          const st = CODE_STYLE[r] ?? { color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a" };
                          return (
                            <span key={i} style={{ display: "inline-block", marginRight: 3, marginBottom: 2, fontSize: 10, borderRadius: 3, padding: "1px 4px", ...st }}>{r}</span>
                          );
                        })}
                        {an.domain && (
                          <span style={{ display: "inline-block", marginRight: 3, marginBottom: 2, fontSize: 10, color: "#4f46e5", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 3, padding: "1px 4px" }}>{an.domain}</span>
                        )}
                        {an.langHint && (
                          <span style={{ display: "inline-block", marginRight: 3, marginBottom: 2, fontSize: 10, color: "#6d28d9", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 3, padding: "1px 4px" }}>{an.langHint}</span>
                        )}
                        {item.issues.filter(s => s.startsWith("유사 중복") || s.startsWith("taxonomy") || s.startsWith("단가") || s.startsWith("단위")).map((s, i) => (
                          <span key={`iss-${i}`} style={{ display: "inline-block", marginRight: 3, color: "#9ca3af" }}>{s}</span>
                        ))}
                      </td>
                      {/* 검토 상태 — 승인/보류/제외 + Reject Reason */}
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap", verticalAlign: "top" }}>
                        {(() => {
                          const rv = getReviewStatus(item);
                          const ov = rowOverrides[item.rowNum];
                          return (
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <div style={{ display: "flex", gap: 2 }}>
                                {(["approved", "pending", "rejected"] as const).map(st => {
                                  const meta = REVIEW_STATUS_META[st];
                                  const active = rv === st;
                                  return (
                                    <button key={st}
                                      onClick={() => {
                                        if (st === "approved" && getRiskLevel(riskScore) === "high") {
                                          setHighRiskApproveConfirm({ item });
                                        } else {
                                          setRowReviewStatus(item.rowNum, st);
                                        }
                                      }}
                                      style={{
                                        fontSize: 10, padding: "2px 6px", borderRadius: 4,
                                        border: `1px solid ${active ? meta.border : "#e5e7eb"}`,
                                        background: active ? meta.bg : "#fff",
                                        color: active ? meta.color : "#9ca3af",
                                        cursor: "pointer", fontWeight: active ? 700 : 400, lineHeight: "15px",
                                      }}>
                                      {meta.label}
                                    </button>
                                  );
                                })}
                              </div>
                              {rv === "rejected" && (
                                <select
                                  value={ov?.rejectReason ?? ""}
                                  onChange={e => setRowRejectReason(item.rowNum, e.target.value)}
                                  style={{ fontSize: 10, padding: "1px 3px", border: "1px solid #fca5a5", borderRadius: 3, color: "#dc2626", background: "#fef2f2", maxWidth: 105 }}>
                                  <option value="">사유 선택</option>
                                  {REJECT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                                </select>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      {/* 액션 — Review Fix Console */}
                      <td style={{ padding: "4px 6px", whiteSpace: "nowrap", verticalAlign: "top" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <button
                            onClick={() => setReviewFixModal({ item: item as unknown as ReviewFixItem })}
                            title="수정 / 재분석"
                            data-testid={`action-edit-${item.rowNum}`}
                            style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, border: "1px solid #c7d2fe", background: "#eef2ff", color: "#4338ca", cursor: "pointer", fontWeight: 600, lineHeight: "15px" }}>
                            ✎ 수정
                          </button>
                          <button
                            onClick={() => setExcludeConfirmModal({ item })}
                            title="이번 Import에서 제외"
                            data-testid={`action-exclude-${item.rowNum}`}
                            style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, border: "1px solid #fca5a5", background: "#fef2f2", color: "#b91c1c", cursor: "pointer", fontWeight: 600, lineHeight: "15px" }}>
                            ⊗ 제외
                          </button>
                          <button
                            onClick={() => setDeletePreviewConfirmModal({ item })}
                            title="Preview 목록에서 삭제 (DB 삭제 아님)"
                            data-testid={`action-delete-${item.rowNum}`}
                            style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, border: "1px solid #e5e7eb", background: "#f9fafb", color: "#6b7280", cursor: "pointer", fontWeight: 600, lineHeight: "15px" }}>
                            ✕ 삭제
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ─── Review Fix Console 모달 ─────────────────────────────────────────── */}
      {reviewFixModal && (
        <ReviewFixConsoleModal
          item={reviewFixModal.item}
          token={token ?? ""}
          onSave={handleReparseSave}
          onClose={() => setReviewFixModal(null)}
        />
      )}

      {/* 제외 확인 모달 */}
      {excludeConfirmModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 10, boxShadow: "0 10px 40px rgba(0,0,0,0.15)", padding: "24px 28px", maxWidth: 440, width: "100%" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 6 }}>⊗ 제외 확인</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>
              <strong style={{ color: "#374151" }}>{excludeConfirmModal.item.name}</strong><br />
              이번 Import 등록 대상에서 제외합니다. DB 삭제가 아닙니다.
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 4 }}>제외 사유 (선택)</label>
              <select
                value={excludeReasonInput}
                onChange={e => setExcludeReasonInput(e.target.value)}
                style={{ width: "100%", padding: "7px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, marginBottom: 6 }}
                data-testid="exclude-reason-select">
                <option value="">선택 없음</option>
                {["프로젝트명", "내부업무", "Product 아님", "설명형 텍스트", "중복 의미", "운영성 항목", "메모성 row", "임시 데이터", "SET 포함"].map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <input
                value={excludeReasonInput}
                onChange={e => setExcludeReasonInput(e.target.value)}
                placeholder="또는 직접 입력..."
                data-testid="exclude-reason-input"
                style={{ width: "100%", padding: "7px 9px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13, boxSizing: "border-box" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { setExcludeConfirmModal(null); setExcludeReasonInput(""); }}
                style={{ padding: "8px 16px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer" }}>
                취소
              </button>
              <button
                onClick={() => executeRowExclude(excludeConfirmModal.item, excludeReasonInput)}
                data-testid="exclude-confirm-btn"
                style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                제외 확정
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview 삭제 확인 모달 */}
      {deletePreviewConfirmModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 10, boxShadow: "0 10px 40px rgba(0,0,0,0.15)", padding: "24px 28px", maxWidth: 420, width: "100%" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#111827", marginBottom: 6 }}>✕ Preview에서 삭제</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 6 }}>
              <strong style={{ color: "#374151" }}>{deletePreviewConfirmModal.item.name}</strong>
            </div>
            <div style={{ fontSize: 12, color: "#b91c1c", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, padding: "8px 12px", marginBottom: 16 }}>
              이번 업로드 목록에서만 삭제됩니다. 실제 상품 DB에는 영향이 없습니다.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setDeletePreviewConfirmModal(null)}
                style={{ padding: "8px 16px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer" }}>
                취소
              </button>
              <button
                onClick={() => executeDeleteFromPreview(deletePreviewConfirmModal.item.rowNum)}
                data-testid="delete-preview-confirm-btn"
                style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: "#374151", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                이번 업로드 목록에서 삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 고위험 승인 확인 모달 */}
      {highRiskApproveConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 10, boxShadow: "0 10px 40px rgba(0,0,0,0.15)", padding: "24px 28px", maxWidth: 440, width: "100%" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#b91c1c", marginBottom: 6 }}>⚠ 고위험 항목 승인 확인</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 4 }}>
              <strong style={{ color: "#374151" }}>{highRiskApproveConfirm.item.name}</strong>
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16 }}>
              이 항목은 고위험(High Risk)으로 분류되었습니다.<br />
              검토 사유: {(highRiskApproveConfirm.item.analysis?.reviewReasons ?? []).join(", ") || "없음"}
              <br />수동 승인 후 등록 대상에 포함됩니다. 계속하시겠습니까?
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setHighRiskApproveConfirm(null)}
                style={{ padding: "8px 16px", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, cursor: "pointer" }}>
                취소
              </button>
              <button
                onClick={() => executeRowApprove(highRiskApproveConfirm.item)}
                data-testid="high-risk-approve-confirm-btn"
                style={{ padding: "8px 18px", borderRadius: 7, border: "none", background: "#b91c1c", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                위험 인지 후 승인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import 등록 확인 모달 */}
      {importConfirmModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1010 }}>
          <Card style={{ width: 480, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: importConfirmModal.mode === "all" ? "#fee2e2" : "#fef3c7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>
                {importConfirmModal.mode === "all" ? "⚠" : "📋"}
              </div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>
                  {importConfirmModal.mode === "selected" ? "선택 항목 등록 확인" : importConfirmModal.mode === "safe" ? "검토필요 제외 등록 확인" : "전체 등록 확인"}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>등록 후 되돌리기 어렵습니다</p>
              </div>
            </div>

            {/* 통계 */}
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 16px", marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>총 Preview 항목</span>
                <strong>{importPreview.summary.total}건</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>실제 등록 대상</span>
                <strong style={{ color: "#2563eb" }}>{importConfirmModal.rows.length}건</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>제외 항목</span>
                <strong style={{ color: "#7c3aed" }}>{importPreview.summary.total - importConfirmModal.rows.length}건</strong>
              </div>
              {importConfirmModal.rows.some(x => (x.analysis?.reviewReasons ?? []).length > 0) && (
                <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626", fontWeight: 600, background: "#fef2f2", borderRadius: 6, padding: "6px 10px" }}>
                  ⚠ 등록 대상에 검토 사유가 있는 항목이 포함되어 있습니다.
                </div>
              )}
            </div>

            {/* 전체 등록 강한 경고 */}
            {importConfirmModal.mode === "all" && (
              <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
                <p style={{ margin: 0, fontSize: 13, color: "#dc2626", fontWeight: 700 }}>
                  검토필요 항목까지 포함하여 전체 등록됩니다.
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "#ef4444" }}>
                  실제 운영 상품 마스터에 반영되므로 신중히 확인하세요.
                </p>
              </div>
            )}

            <p style={{ margin: "0 0 20px", fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
              등록 후 개별 비활성화는 가능하지만 일괄 복구는 어렵습니다.<br />
              계속 진행하시겠습니까?
            </p>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => handleProductImportExecute(importConfirmModal.rows)}
                disabled={importExecuting}
                style={{ flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, cursor: importExecuting ? "not-allowed" : "pointer", background: importExecuting ? "#9ca3af" : importConfirmModal.mode === "all" ? "#dc2626" : "#2563eb", color: "#fff", border: "none", fontWeight: 700 }}>
                {importExecuting ? "등록 중..." : `${importConfirmModal.rows.length}건 등록 확인`}
              </button>
              <GhostBtn onClick={() => setImportConfirmModal(null)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}

      {/* Bulk Review 확인 모달 */}
      {bulkConfirmModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1015 }}>
          <Card style={{ width: 460, padding: "28px 32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, background: bulkConfirmModal.action === "approve" ? "#dcfce7" : bulkConfirmModal.action === "reject" ? "#fee2e2" : "#f5f3ff" }}>
                {bulkConfirmModal.action === "approve" ? "✅" : bulkConfirmModal.action === "reject" ? "🚫" : "✏️"}
              </div>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 16, color: "#111827" }}>
                  {bulkConfirmModal.action === "approve" ? "일괄 승인 확인" : bulkConfirmModal.action === "reject" ? "일괄 제외 확인" : "Product 일괄 수정 확인"}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#9ca3af" }}>선택된 {bulkConfirmModal.rows.length}건에 적용됩니다</p>
              </div>
            </div>

            {/* 통계 */}
            <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                <span style={{ color: "#6b7280" }}>대상 항목</span>
                <strong style={{ color: bulkConfirmModal.action === "approve" ? "#059669" : bulkConfirmModal.action === "reject" ? "#dc2626" : "#7c3aed" }}>
                  {bulkConfirmModal.rows.length}건
                </strong>
              </div>
              {bulkConfirmModal.action !== "override" && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                    <span style={{ color: "#9ca3af" }}>현재 승인됨</span>
                    <span>{bulkConfirmModal.rows.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "approved").length}건</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: "#9ca3af" }}>현재 제외됨</span>
                    <span>{bulkConfirmModal.rows.filter(x => rowOverrides[x.rowNum]?.reviewStatus === "rejected").length}건</span>
                  </div>
                </>
              )}
              {bulkConfirmModal.action === "override" && (
                <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>
                  선택된 {bulkConfirmModal.rows.length}건의 Product 후보가 아래 입력값으로 일괄 변경됩니다.<br />
                  기존 AI 추천값은 취소선으로 보존됩니다.
                </p>
              )}
            </div>

            {/* Reject: 사유 선택 (필수) */}
            {bulkConfirmModal.action === "reject" && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ margin: "0 0 7px", fontSize: 13, fontWeight: 700, color: "#dc2626" }}>⚠ 제외 사유 선택 (필수)</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {["프로젝트명", "내부업무", "Product 아님", "설명형 텍스트", "중복 의미", "운영성 항목"].map(r => (
                    <button key={r} onClick={() => setBulkRejectReason(r)}
                      style={{ fontSize: 12, padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontWeight: bulkRejectReason === r ? 700 : 400, background: bulkRejectReason === r ? "#fee2e2" : "#f9fafb", color: bulkRejectReason === r ? "#dc2626" : "#374151", border: `1px solid ${bulkRejectReason === r ? "#fca5a5" : "#e5e7eb"}` }}>
                      {r}
                    </button>
                  ))}
                </div>
                {!bulkRejectReason && (
                  <p style={{ margin: "5px 0 0", fontSize: 11, color: "#9ca3af" }}>사유를 선택해야 제외 실행이 가능합니다.</p>
                )}
              </div>
            )}

            {/* Override: 새 후보명 입력 (필수) */}
            {bulkConfirmModal.action === "override" && (
              <div style={{ marginBottom: 14 }}>
                <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>새 Product 후보명 (필수)</p>
                <input
                  autoFocus
                  value={bulkOverrideValue}
                  onChange={e => setBulkOverrideValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && bulkOverrideValue.trim()) executeBulkOverride(bulkConfirmModal.rows, bulkOverrideValue.trim());
                  }}
                  placeholder="예: 번역, 통역, 영문 교정..."
                  style={{ ...inputStyle, fontSize: 13, padding: "8px 12px", border: "1px solid #c4b5fd" }}
                />
                {!bulkOverrideValue.trim() && (
                  <p style={{ margin: "4px 0 0", fontSize: 11, color: "#9ca3af" }}>값을 입력해야 일괄 수정이 가능합니다.</p>
                )}
              </div>
            )}

            {/* Reject 경고 */}
            {bulkConfirmModal.action === "reject" && bulkRejectReason && (
              <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 12px", marginBottom: 14 }}>
                <p style={{ margin: 0, fontSize: 12, color: "#dc2626", fontWeight: 700 }}>
                  제외된 항목은 등록 안전장치에서 자동으로 제외됩니다.
                </p>
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={
                  (bulkConfirmModal.action === "reject" && !bulkRejectReason) ||
                  (bulkConfirmModal.action === "override" && !bulkOverrideValue.trim())
                }
                onClick={() => {
                  if (bulkConfirmModal.action === "approve") executeBulkApprove(bulkConfirmModal.rows);
                  else if (bulkConfirmModal.action === "reject") executeBulkReject(bulkConfirmModal.rows, bulkRejectReason);
                  else if (bulkConfirmModal.action === "override") executeBulkOverride(bulkConfirmModal.rows, bulkOverrideValue.trim());
                }}
                style={{
                  flex: 1, padding: "10px 0", fontSize: 14, borderRadius: 8, fontWeight: 700, border: "none",
                  color: "#fff",
                  cursor: (bulkConfirmModal.action === "reject" && !bulkRejectReason) || (bulkConfirmModal.action === "override" && !bulkOverrideValue.trim()) ? "not-allowed" : "pointer",
                  background: (bulkConfirmModal.action === "reject" && !bulkRejectReason) || (bulkConfirmModal.action === "override" && !bulkOverrideValue.trim())
                    ? "#9ca3af"
                    : bulkConfirmModal.action === "approve" ? "#059669" : bulkConfirmModal.action === "reject" ? "#dc2626" : "#7c3aed",
                }}>
                {bulkConfirmModal.action === "approve"
                  ? `${bulkConfirmModal.rows.length}건 승인`
                  : bulkConfirmModal.action === "reject"
                  ? `${bulkConfirmModal.rows.length}건 제외`
                  : `${bulkConfirmModal.rows.length}건 수정`}
              </button>
              <GhostBtn onClick={() => setBulkConfirmModal(null)} style={{ fontSize: 13, padding: "10px 20px" }}>취소</GhostBtn>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
