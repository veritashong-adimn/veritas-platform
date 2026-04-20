import { useState, useEffect, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContentInsight {
  id: number;
  serviceType: string;
  languageServiceDataId: number | null;
  question: string;
  answer: string;
  shortAnswer: string | null;
  longAnswer: string | null;
  questionType: string | null;
  domain: string | null;
  languagePair: string | null;
  industry: string | null;
  useCase: string | null;
  sourceCount: number | null;
  avgPrice: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  avgDuration: string | null;
  confidenceScore: string | null;
  status: string;
  visibilityLevel: string;
  isPublic: boolean;
  slug: string | null;
  sourceType: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  filterScore: number | null;
  filterDecision: string | null;
  filterReason: string | null;
  duplicateOfId: number | null;
  searchIntentScore: number | null;
  commercialIntentScore: number | null;
  specificityScore: number | null;
  duplicationScore: number | null;
  sourceWeight: number | null;
  aeoTitle: string | null;
  aeoDescription: string | null;
  faqJson: { question: string; answer: string }[] | null;
  relatedIds: number[] | null;
  // 파생 필드 (API 계산)
  faqCount: number;
  relatedCount: number;
  hasAeoTitle: boolean;
  hasAeoDescription: boolean;
  hasShortAnswer: boolean;
  aeoScore: number;
  aeoStatus: "READY" | "PARTIAL" | "NONE";
  isArchived: boolean;
  mergedIntoId: number | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  token: string;
  setToast: (msg: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const API = "/api";

const SERVICE_TYPE_KO: Record<string, string> = {
  translation: "번역",
  interpretation: "통역",
  equipment: "장비",
};

const STATUS_KO: Record<string, string> = {
  draft: "초안",
  approved: "승인됨",
  published: "게시됨",
  archived: "보관됨",
};

const VISIBILITY_KO: Record<string, string> = {
  private: "비공개",
  internal_summary: "내부용",
  public_insight: "공개",
};

const STATUS_COLOR: Record<string, { bg: string; color: string }> = {
  draft:     { bg: "#f3f4f6", color: "#374151" },
  approved:  { bg: "#d1fae5", color: "#065f46" },
  published: { bg: "#dbeafe", color: "#1e40af" },
  archived:  { bg: "#fef3c7", color: "#92400e" },
};

const SERVICE_COLOR: Record<string, string> = {
  translation:   "#eff6ff",
  interpretation: "#f5f3ff",
  equipment:      "#fff7ed",
};

function fmt(val: string | number | null | undefined, suffix = ""): string {
  if (val === null || val === undefined || val === "") return "-";
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(n)) return String(val);
  return Math.round(n).toLocaleString("ko-KR") + suffix;
}

function fmtConf(val: string | null | undefined): string {
  if (!val) return "-";
  return (parseFloat(val) * 100).toFixed(0) + "%";
}

function truncate(str: string | null | undefined, len = 60): string {
  if (!str) return "-";
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function Badge({ text, style }: { text: string; style?: React.CSSProperties }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: "nowrap",
      ...style,
    }}>
      {text}
    </span>
  );
}

function LongAnswerRenderer({ text }: { text: string | null | undefined }) {
  if (!text) return <p style={{ color: "#9ca3af", fontStyle: "italic", margin: 0 }}>상세 답변 없음</p>;

  return (
    <div style={{ fontSize: 13, lineHeight: 1.7, color: "#374151" }}>
      {text.split("\n").map((line, i) => {
        if (line.startsWith("## ")) return (
          <h3 key={i} style={{ fontSize: 14, fontWeight: 700, margin: "8px 0 4px", color: "#111827" }}>
            {line.replace(/^## /, "")}
          </h3>
        );
        if (line.startsWith("### ")) return (
          <h4 key={i} style={{ fontSize: 13, fontWeight: 600, margin: "8px 0 2px", color: "#374151" }}>
            {line.replace(/^### /, "")}
          </h4>
        );
        if (line.startsWith("- ")) return (
          <li key={i} style={{ marginLeft: 16, marginBottom: 2 }}>{line.replace(/^- /, "")}</li>
        );
        if (line.startsWith("※ ")) return (
          <p key={i} style={{ margin: "6px 0", color: "#b45309", fontWeight: 500 }}>{line}</p>
        );
        if (line.startsWith("*") && line.endsWith("*")) return (
          <p key={i} style={{ margin: "6px 0", color: "#6b7280", fontStyle: "italic" }}>
            {line.replace(/^\*|\*$/g, "")}
          </p>
        );
        if (line === "") return <div key={i} style={{ height: 4 }} />;
        return <p key={i} style={{ margin: "2px 0" }}>{line}</p>;
      })}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function InsightManagementTab({ token, setToast }: Props) {
  const [insights, setInsights] = useState<ContentInsight[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ContentInsight | null>(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editDraft, setEditDraft] = useState<Partial<ContentInsight>>({});
  const [saving, setSaving] = useState(false);

  const [showCreateDropdown, setShowCreateDropdown] = useState(false);

  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [clearPrevious, setClearPrevious] = useState(false);
  const [generating, setGenerating] = useState(false);

  const EMPTY_MANUAL = {
    question: "", shortAnswer: "", longAnswer: "",
    serviceType: "translation", domain: "", languagePair: "",
    industry: "", useCase: "", avgPrice: "", minPrice: "", maxPrice: "", confidenceScore: "",
  };
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualDraft, setManualDraft] = useState({ ...EMPTY_MANUAL });
  const [creating, setCreating] = useState(false);

  const EMPTY_BLOG = { title: "", content: "", sourceUrl: "", count: "3" };
  const [showBlogModal, setShowBlogModal] = useState(false);
  const [blogDraft, setBlogDraft] = useState({ ...EMPTY_BLOG });
  const [convertingBlog, setConvertingBlog] = useState(false);

  const [filtering, setFiltering] = useState(false);

  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeSource, setMergeSource] = useState<ContentInsight | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [merging, setMerging] = useState(false);

  // ── 자동 보완 ──────────────────────────────────────────────────────────────
  interface AutoSuggestion {
    id: number;
    insightId: number;
    type: "faq" | "related" | "meta";
    payload: Record<string, unknown>;
    status: "pending" | "applied" | "rejected";
    createdAt: string;
  }
  const [suggestions, setSuggestions] = useState<AutoSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [batchEnhancing, setBatchEnhancing] = useState(false);

  const [highlightedIds, setHighlightedIds] = useState<Set<number>>(new Set());
  const [pendingScrollId, setPendingScrollId] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pendingScrollId === null) return;
    const el = document.querySelector(`[data-insight-id="${pendingScrollId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    setPendingScrollId(null);
  }, [pendingScrollId, insights]);

  useEffect(() => () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current); }, []);

  const [filters, setFilters] = useState({
    serviceType: "",
    status: "",
    visibilityLevel: "",
    domain: "",
    languagePair: "",
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [decisionTab, setDecisionTab] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [aeoStatusFilter, setAeoStatusFilter] = useState<"" | "READY" | "PARTIAL" | "NONE">("");
  const [sortBy, setSortBy] = useState<"" | "aeoScore" | "faqCount" | "relatedCount">("");

  const fetchInsights = useCallback(async (
    f = appliedFilters,
    dtab = decisionTab,
    archived = showArchived,
    aeoSt = aeoStatusFilter,
    sBy = sortBy,
  ) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (f.serviceType) params.set("serviceType", f.serviceType);
      if (f.status) params.set("status", f.status);
      if (f.visibilityLevel) params.set("visibilityLevel", f.visibilityLevel);
      if (f.domain) params.set("domain", f.domain);
      if (f.languagePair) params.set("languagePair", f.languagePair);
      if (dtab !== "all") params.set("filterDecision", dtab);
      if (archived) params.set("showArchived", "true");
      if (aeoSt) params.set("aeoStatus", aeoSt);
      if (sBy) params.set("sortBy", sBy);

      const res = await fetch(`${API}/admin/content-insights?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setInsights(data.data ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setToast("인사이트 조회 실패");
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, decisionTab, showArchived, aeoStatusFilter, sortBy, token, setToast]);

  useEffect(() => { fetchInsights(); }, [fetchInsights]);

  const handleSearch = () => {
    setAppliedFilters(filters);
    setSelected(null);
    fetchInsights(filters, decisionTab, showArchived, aeoStatusFilter, sortBy);
  };

  const handleReset = () => {
    const empty = { serviceType: "", status: "", visibilityLevel: "", domain: "", languagePair: "" };
    setFilters(empty);
    setAppliedFilters(empty);
    setAeoStatusFilter("");
    setSortBy("");
    setSelected(null);
    fetchInsights(empty, decisionTab, showArchived, "", "");
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const url = clearPrevious
        ? `${API}/admin/content-insights/generate?clearPrevious=true`
        : `${API}/admin/content-insights/generate`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error();
      const data: { generated: number; updated: number; total: number; ids?: number[] } = await res.json();

      // 0.4초 딜레이: 완료 감각 제공
      await new Promise(r => setTimeout(r, 400));
      setShowGenerateModal(false);
      setClearPrevious(false);

      // 필터 유지한 채 목록 재조회
      const f = appliedFilters;
      const params = new URLSearchParams({ limit: "100" });
      if (f.serviceType) params.set("serviceType", f.serviceType);
      if (f.status) params.set("status", f.status);
      if (f.visibilityLevel) params.set("visibilityLevel", f.visibilityLevel);
      if (f.domain) params.set("domain", f.domain);
      if (f.languagePair) params.set("languagePair", f.languagePair);

      setLoading(true);
      const listRes = await fetch(`${API}/admin/content-insights?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listData = await listRes.json();
      const newInsights: ContentInsight[] = listData.data ?? [];
      setInsights(newInsights);
      setTotal(listData.total ?? 0);
      setLoading(false);

      // 새로 생성된 첫 번째 ID 자동 선택 + 스크롤
      const ids: number[] = data.ids ?? [];
      const firstNew = ids.length > 0 ? newInsights.find(r => ids.includes(r.id)) : null;

      if (firstNew) {
        setSelected(firstNew);
        setPendingScrollId(firstNew.id);
      }

      // 하이라이트 효과 (2초)
      if (ids.length > 0) {
        setHighlightedIds(new Set(ids));
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedIds(new Set()), 2000);
      }

      // 현재 필터로 생성 결과가 안 보이는 경우 안내
      const visibleNewCount = ids.filter(id => newInsights.some(r => r.id === id)).length;
      const hasHidden = ids.length > 0 && visibleNewCount < ids.length;

      const baseMsg = `${data.generated ?? 0}건의 인사이트가 생성되었습니다.`;
      const updateMsg = (data.updated ?? 0) > 0 ? ` (업데이트: ${data.updated}건)` : "";
      const filterMsg = hasHidden ? "\n현재 필터 조건으로 일부 생성 결과가 보이지 않을 수 있습니다." : "";
      setToast(`${baseMsg}${updateMsg}${filterMsg}`);
    } catch (err) {
      console.error("인사이트 생성 오류:", err);
      setToast("인사이트 생성 중 오류가 발생했습니다.");
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    setEditMode(false);
    if (selected) {
      setEditDraft({
        question: selected.question,
        shortAnswer: selected.shortAnswer ?? "",
        longAnswer: selected.longAnswer ?? "",
        serviceType: selected.serviceType,
        questionType: selected.questionType ?? "",
        domain: selected.domain ?? "",
        languagePair: selected.languagePair ?? "",
        industry: selected.industry ?? "",
        useCase: selected.useCase ?? "",
        avgPrice: selected.avgPrice ?? "",
        minPrice: selected.minPrice ?? "",
        maxPrice: selected.maxPrice ?? "",
        confidenceScore: selected.confidenceScore ?? "",
      });
    }
  }, [selected?.id]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/admin/content-insights/${selected.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(editDraft),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "수정 실패");
      }
      const updated: ContentInsight = await res.json();
      setInsights(prev => prev.map(r => r.id === updated.id ? updated : r));
      setSelected(updated);
      setEditMode(false);
      setToast("인사이트가 수정되었습니다.");
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "인사이트 수정 실패");
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (id: number, newStatus: string) => {
    setStatusUpdating(true);
    try {
      const res = await fetch(`${API}/admin/content-insights/${id}/status`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setInsights(prev => prev.map(r => r.id === id ? updated : r));
      setSelected(updated);
      setToast(`상태가 "${STATUS_KO[newStatus] ?? newStatus}"로 변경되었습니다.`);
    } catch {
      setToast("상태 변경 실패");
    } finally {
      setStatusUpdating(false);
    }
  };

  const handleCreateManual = async () => {
    if (!manualDraft.question.trim()) {
      setToast("질문은 필수 입력 항목입니다.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`${API}/admin/content-insights`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(manualDraft),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "생성 실패");
      }
      const created: ContentInsight = await res.json();

      setShowManualModal(false);
      setManualDraft({ ...EMPTY_MANUAL });

      // 목록 재조회
      const f = appliedFilters;
      const params = new URLSearchParams({ limit: "100" });
      if (f.serviceType) params.set("serviceType", f.serviceType);
      if (f.status) params.set("status", f.status);
      if (f.visibilityLevel) params.set("visibilityLevel", f.visibilityLevel);
      if (f.domain) params.set("domain", f.domain);
      if (f.languagePair) params.set("languagePair", f.languagePair);

      setLoading(true);
      const listRes = await fetch(`${API}/admin/content-insights?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listData = await listRes.json();
      const newList: ContentInsight[] = listData.data ?? [];
      setInsights(newList);
      setTotal(listData.total ?? 0);
      setLoading(false);

      // 생성된 항목 자동 선택 + 스크롤 + 하이라이트
      const found = newList.find(r => r.id === created.id);
      if (found) {
        setSelected(found);
        setPendingScrollId(found.id);
        setHighlightedIds(new Set([found.id]));
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedIds(new Set()), 2000);
      }

      setToast("인사이트가 생성되었습니다.");
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "인사이트 생성 실패");
    } finally {
      setCreating(false);
    }
  };

  const handleBlogConvert = async () => {
    const body = blogDraft.content.trim();
    if (body.length < 300) {
      setToast("본문이 너무 짧아 인사이트 생성이 어렵습니다. (최소 300자)");
      return;
    }
    setConvertingBlog(true);
    try {
      const res = await fetch(`${API}/admin/content-insights/from-blog`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: blogDraft.title.trim() || undefined,
          content: body,
          sourceUrl: blogDraft.sourceUrl.trim() || undefined,
          count: Number(blogDraft.count) || 3,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "변환 실패");
      }
      const result = await res.json();
      const createdItems: ContentInsight[] = result.items ?? [];

      setShowBlogModal(false);
      setBlogDraft({ ...EMPTY_BLOG });

      // 목록 재조회
      const f = appliedFilters;
      const params = new URLSearchParams({ limit: "100" });
      if (f.serviceType) params.set("serviceType", f.serviceType);
      if (f.status) params.set("status", f.status);
      if (f.visibilityLevel) params.set("visibilityLevel", f.visibilityLevel);
      if (f.domain) params.set("domain", f.domain);
      if (f.languagePair) params.set("languagePair", f.languagePair);

      setLoading(true);
      const listRes = await fetch(`${API}/admin/content-insights?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listData = await listRes.json();
      const newList: ContentInsight[] = listData.data ?? [];
      setInsights(newList);
      setTotal(listData.total ?? 0);
      setLoading(false);

      // 첫 번째 생성 항목 자동 선택 + 하이라이트
      if (createdItems.length > 0) {
        const firstId = createdItems[0].id;
        const found = newList.find(r => r.id === firstId);
        if (found) {
          setSelected(found);
          setPendingScrollId(found.id);
        }
        const newIds = new Set(createdItems.map(r => r.id));
        setHighlightedIds(newIds);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedIds(new Set()), 2000);
      }

      setToast(`블로그 글 기반 인사이트 초안 ${result.created ?? createdItems.length}건이 생성되었습니다.`);
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "블로그 변환 실패");
    } finally {
      setConvertingBlog(false);
    }
  };

  const handleFilter = async (selectedIds?: number[]) => {
    setFiltering(true);
    try {
      const body = selectedIds && selectedIds.length > 0 ? { ids: selectedIds } : {};
      const res = await fetch(`${API}/admin/content-insights/filter`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "필터 실행 실패");
      }
      const result = await res.json();

      // 목록 재조회
      const f = appliedFilters;
      const params = new URLSearchParams({ limit: "100" });
      if (f.serviceType) params.set("serviceType", f.serviceType);
      if (f.status) params.set("status", f.status);
      if (f.visibilityLevel) params.set("visibilityLevel", f.visibilityLevel);
      if (f.domain) params.set("domain", f.domain);
      if (f.languagePair) params.set("languagePair", f.languagePair);

      setLoading(true);
      const listRes = await fetch(`${API}/admin/content-insights?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listData = await listRes.json();
      const newList: ContentInsight[] = listData.data ?? [];
      setInsights(newList);
      setTotal(listData.total ?? 0);
      setLoading(false);

      // 선택된 항목 갱신
      if (selected) {
        const refreshed = newList.find(r => r.id === selected.id);
        if (refreshed) setSelected(refreshed);
      }

      const kept = result.result.filter((r: any) => r.decision === "keep").length;
      const reviewed = result.result.filter((r: any) => r.decision === "review").length;
      const merged = result.result.filter((r: any) => r.decision === "merge").length;
      const dropped = result.result.filter((r: any) => r.decision === "drop").length;
      setToast(`품질 필터 완료: ${result.processed}건 처리 — keep ${kept}, review ${reviewed}, merge ${merged}, drop ${dropped}`);
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "품질 필터 실행 실패");
    } finally {
      setFiltering(false);
    }
  };

  const handleApprove = async (id: number) => {
    try {
      const res = await fetch(`${API}/admin/content-insights/${id}/approve`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "승격 실패");
      const updated: ContentInsight = await res.json();
      setInsights(prev => prev.map(r => r.id === id ? updated : r));
      if (selected?.id === id) setSelected(updated);
      setToast("KEEP으로 승격되었습니다.");
    } catch (err: unknown) { setToast(err instanceof Error ? err.message : "승격 실패"); }
  };

  const handleDrop = async (id: number) => {
    if (!confirm(`#${id} 인사이트를 삭제(보관) 처리하시겠습니까?`)) return;
    try {
      const res = await fetch(`${API}/admin/content-insights/${id}/drop`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "삭제 실패");
      setInsights(prev => prev.filter(r => r.id !== id));
      if (selected?.id === id) setSelected(null);
      setToast(`#${id} 인사이트가 보관되었습니다.`);
    } catch (err: unknown) { setToast(err instanceof Error ? err.message : "삭제 실패"); }
  };

  const handleRestore = async (id: number) => {
    try {
      const res = await fetch(`${API}/admin/content-insights/${id}/restore`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "복구 실패");
      const updated: ContentInsight = await res.json();
      setInsights(prev => prev.map(r => r.id === id ? updated : r));
      if (selected?.id === id) setSelected(updated);
      setToast(`#${id} 인사이트가 복구되었습니다.`);
    } catch (err: unknown) { setToast(err instanceof Error ? err.message : "복구 실패"); }
  };

  const openMergeModal = (insight: ContentInsight) => {
    setMergeSource(insight);
    setMergeTargetId(insight.duplicateOfId ? String(insight.duplicateOfId) : "");
    setShowMergeModal(true);
  };

  const handleMergeConfirm = async () => {
    if (!mergeSource || !mergeTargetId.trim()) return;
    const targetId = Number(mergeTargetId.trim());
    if (isNaN(targetId) || targetId <= 0) { setToast("유효한 대상 ID를 입력하세요."); return; }
    if (!confirm(`#${mergeSource.id}를 #${targetId}에 병합하시겠습니까?\n병합된 항목은 보관 처리됩니다.`)) return;
    setMerging(true);
    try {
      const res = await fetch(`${API}/admin/content-insights/merge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: mergeSource.id, targetId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "병합 실패");
      setShowMergeModal(false);
      setInsights(prev => prev.filter(r => r.id !== mergeSource.id));
      if (selected?.id === mergeSource.id) setSelected(null);
      setToast(`#${mergeSource.id} → #${targetId} 병합 완료`);
    } catch (err: unknown) { setToast(err instanceof Error ? err.message : "병합 실패"); }
    finally { setMerging(false); }
  };

  // ── 자동 보완 핸들러 ─────────────────────────────────────────────────────────
  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadSuggestions = async (insightId: number) => {
    setSuggestionsLoading(true);
    try {
      const res = await fetch(`${API}/admin/content-insights/${insightId}/suggestions`, { headers: authHeaders });
      if (res.ok) setSuggestions(await res.json());
    } finally {
      setSuggestionsLoading(false);
    }
  };

  useEffect(() => {
    if (selected) { setSuggestions([]); loadSuggestions(selected.id); }
    else setSuggestions([]);
  }, [selected?.id]);

  const handleAutoEnhance = async (insightId: number) => {
    setEnhancing(true);
    try {
      const res = await fetch(`${API}/admin/content-insights/${insightId}/auto-enhance`, {
        method: "POST", headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "자동 보완 실패");
      if (data.created === 0) {
        setToast(data.message ?? "새로운 제안이 없습니다.");
      } else {
        setToast(`자동 보완 제안 ${data.created}개 생성 완료`);
        setSuggestions(data.suggestions ?? []);
      }
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "자동 보완 실패");
    } finally {
      setEnhancing(false);
    }
  };

  const handleBatchAutoEnhance = async () => {
    if (!confirm("현재 목록의 PARTIAL/NONE 인사이트(최대 20개)에 대해 자동 보완을 실행합니다.\n시간이 걸릴 수 있습니다. 계속하시겠습니까?")) return;
    setBatchEnhancing(true);
    try {
      const res = await fetch(`${API}/admin/content-insights/batch-auto-enhance`, {
        method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "배치 자동 보완 실패");
      setToast(`배치 완료: ${data.processed}건 처리, ${data.created}개 제안 생성`);
      if (selected) await loadSuggestions(selected.id);
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "배치 자동 보완 실패");
    } finally {
      setBatchEnhancing(false);
    }
  };

  const handleApplySuggestion = async (sugId: number) => {
    try {
      const res = await fetch(`${API}/admin/suggestions/${sugId}/apply`, { method: "POST", headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "제안 적용 실패");
      setSuggestions(prev => prev.map(s => s.id === sugId ? { ...s, status: "applied" } : s));
      if (selected && data.insight) {
        const updated = data.insight as ContentInsight;
        setSelected(updated);
        setInsights(prev => prev.map(r => r.id === updated.id ? updated : r));
      }
      setToast("제안이 적용되었습니다.");
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "적용 실패");
    }
  };

  const handleRejectSuggestion = async (sugId: number) => {
    try {
      const res = await fetch(`${API}/admin/suggestions/${sugId}/reject`, { method: "POST", headers: authHeaders });
      if (!res.ok) throw new Error("무시 실패");
      setSuggestions(prev => prev.map(s => s.id === sugId ? { ...s, status: "rejected" } : s));
      setToast("제안을 무시했습니다.");
    } catch (err: unknown) {
      setToast(err instanceof Error ? err.message : "무시 실패");
    }
  };

  const statusActions = (insight: ContentInsight): { label: string; next: string; bg: string; color: string }[] => {
    const { status } = insight;
    if (status === "draft")     return [{ label: "승인", next: "approved",  bg: "#059669", color: "#fff" }];
    if (status === "approved")  return [
      { label: "게시", next: "published", bg: "#2563eb", color: "#fff" },
      { label: "초안으로", next: "draft", bg: "#6b7280", color: "#fff" },
    ];
    if (status === "published") return [{ label: "보관", next: "archived",  bg: "#d97706", color: "#fff" }];
    if (status === "archived")  return [{ label: "게시 복원", next: "published", bg: "#2563eb", color: "#fff" }];
    return [];
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>

      {/* ── 필터 바 ────────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
        padding: "14px 16px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
      }}>
        <select
          value={filters.serviceType}
          onChange={e => setFilters(f => ({ ...f, serviceType: e.target.value }))}
          style={selectStyle}
        >
          <option value="">서비스 유형 전체</option>
          <option value="translation">번역</option>
          <option value="interpretation">통역</option>
          <option value="equipment">장비</option>
        </select>

        <select
          value={filters.status}
          onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
          style={selectStyle}
        >
          <option value="">상태 전체</option>
          <option value="draft">초안</option>
          <option value="approved">승인됨</option>
          <option value="published">게시됨</option>
          <option value="archived">보관됨</option>
        </select>

        <select
          value={filters.visibilityLevel}
          onChange={e => setFilters(f => ({ ...f, visibilityLevel: e.target.value }))}
          style={selectStyle}
        >
          <option value="">공개수준 전체</option>
          <option value="private">비공개</option>
          <option value="internal_summary">내부용</option>
          <option value="public_insight">공개</option>
        </select>

        <input
          placeholder="도메인 검색"
          value={filters.domain}
          onChange={e => setFilters(f => ({ ...f, domain: e.target.value }))}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          style={inputStyle}
        />

        <input
          placeholder="언어쌍 (예: ko-en)"
          value={filters.languagePair}
          onChange={e => setFilters(f => ({ ...f, languagePair: e.target.value }))}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          style={inputStyle}
        />

        <select
          value={aeoStatusFilter}
          onChange={e => {
            const v = e.target.value as "" | "READY" | "PARTIAL" | "NONE";
            setAeoStatusFilter(v);
            setSelected(null);
          }}
          style={{ ...selectStyle, borderColor: aeoStatusFilter ? "#2563eb" : undefined }}
        >
          <option value="">AEO 상태 전체</option>
          <option value="READY">✅ READY</option>
          <option value="PARTIAL">⚠️ PARTIAL</option>
          <option value="NONE">❌ NONE</option>
        </select>

        <select
          value={sortBy}
          onChange={e => {
            const v = e.target.value as "" | "aeoScore" | "faqCount" | "relatedCount";
            setSortBy(v);
            setSelected(null);
          }}
          style={{ ...selectStyle, borderColor: sortBy ? "#7c3aed" : undefined }}
        >
          <option value="">기본 정렬 (최신순)</option>
          <option value="aeoScore">AEO 점수 높은순</option>
          <option value="faqCount">FAQ 많은순</option>
          <option value="relatedCount">관련 연결 많은순</option>
        </select>

        <button onClick={handleSearch} style={btnPrimaryStyle}>검색</button>
        <button onClick={handleReset} style={btnGhostStyle}>초기화</button>

        <span style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
          총 <strong>{total}</strong>건
        </span>

        <button
          onClick={() => handleFilter()}
          disabled={filtering}
          style={{
            ...btnGhostStyle,
            display: "flex", alignItems: "center", gap: 5,
            opacity: filtering ? 0.6 : 1,
            cursor: filtering ? "not-allowed" : "pointer",
            border: "1px solid #d1d5db",
          }}
          title="draft 상태 인사이트 전체에 품질 필터를 실행합니다"
        >
          <span style={{ fontSize: 14 }}>⚙️</span>
          {filtering ? "필터 실행 중…" : "품질 필터 실행"}
        </button>

        <button
          onClick={handleBatchAutoEnhance}
          disabled={batchEnhancing}
          style={{
            ...btnGhostStyle,
            display: "flex", alignItems: "center", gap: 5,
            opacity: batchEnhancing ? 0.6 : 1,
            cursor: batchEnhancing ? "not-allowed" : "pointer",
            border: "1px solid #7c3aed", color: "#7c3aed",
          }}
          title="PARTIAL/NONE 인사이트 최대 20개에 자동 보완 제안을 생성합니다"
        >
          <span style={{ fontSize: 14 }}>✨</span>
          {batchEnhancing ? "보완 실행 중…" : "자동 보완 실행"}
        </button>

        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowCreateDropdown(d => !d)}
            style={{ ...btnPrimaryStyle, background: "#2563eb", display: "flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ fontSize: 14 }}>+</span> 인사이트 생성
            <span style={{ fontSize: 10, opacity: 0.8 }}>▾</span>
          </button>
          {showCreateDropdown && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 10 }}
                onClick={() => setShowCreateDropdown(false)}
              />
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", right: 0,
                background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
                boxShadow: "0 8px 24px rgba(0,0,0,0.12)", minWidth: 200, zIndex: 20,
                overflow: "hidden",
              }}>
                <button
                  onClick={() => { setShowManualModal(true); setShowCreateDropdown(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "11px 14px", border: "none", background: "none",
                    cursor: "pointer", fontSize: 13, color: "#111827", textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#f9fafb"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                >
                  <span style={{ fontSize: 16 }}>✍️</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>수동 입력 생성</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 1 }}>직접 내용을 입력하여 생성</div>
                  </div>
                </button>
                <div style={{ height: 1, background: "#f3f4f6" }} />
                <button
                  onClick={() => { setShowBlogModal(true); setShowCreateDropdown(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "11px 14px", border: "none", background: "none",
                    cursor: "pointer", fontSize: 13, color: "#111827", textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#f9fafb"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                >
                  <span style={{ fontSize: 16 }}>📝</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>블로그 글 변환</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 1 }}>기존 블로그 글을 인사이트로 변환</div>
                  </div>
                </button>
                <div style={{ height: 1, background: "#f3f4f6" }} />
                <button
                  onClick={() => { setShowGenerateModal(true); setShowCreateDropdown(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%",
                    padding: "11px 14px", border: "none", background: "none",
                    cursor: "pointer", fontSize: 13, color: "#111827", textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "#f9fafb"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
                >
                  <span style={{ fontSize: 16 }}>⚡</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>데이터 기반 자동 생성</div>
                    <div style={{ fontSize: 11, color: "#6b7280", marginTop: 1 }}>언어 서비스 데이터 기반 자동 생성</div>
                  </div>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 생성 모달 ────────────────────────────────────────────────────────────── */}
      {showGenerateModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}
          onClick={e => { if (e.target === e.currentTarget) setShowGenerateModal(false); }}
        >
          <div style={{
            background: "#fff", borderRadius: 12, padding: 28, width: 440, maxWidth: "90vw",
            boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>인사이트 생성</h3>
              <button
                onClick={() => setShowGenerateModal(false)}
                style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#6b7280" }}
              >✕</button>
            </div>

            <div style={{
              background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 8,
              padding: "10px 14px", marginBottom: 20, fontSize: 13, color: "#0369a1", lineHeight: 1.5,
            }}>
              언어 서비스 데이터 중 공개된 데이터(is_public=true)를 기반으로<br />
              인사이트가 자동 생성됩니다.
            </div>

            <label style={{
              display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
              padding: "12px 14px", borderRadius: 8, border: "1px solid #e5e7eb",
              background: clearPrevious ? "#fef2f2" : "#f9fafb", marginBottom: 24,
            }}>
              <input
                type="checkbox"
                checked={clearPrevious}
                onChange={e => setClearPrevious(e.target.checked)}
                style={{ marginTop: 2, width: 15, height: 15, cursor: "pointer" }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
                  기존 draft 삭제 후 재생성 (clearPrevious)
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3, lineHeight: 1.4 }}>
                  {clearPrevious
                    ? "⚠️ 기존 draft 상태 인사이트를 모두 삭제하고 새로 생성합니다."
                    : "기존 데이터는 유지하고 upsert 방식으로 생성합니다."}
                </div>
              </div>
            </label>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => { setShowGenerateModal(false); setClearPrevious(false); }}
                disabled={generating}
                style={{ ...btnGhostStyle, opacity: generating ? 0.5 : 1 }}
              >
                취소
              </button>
              <button
                onClick={handleGenerate}
                disabled={generating}
                style={{
                  ...btnPrimaryStyle,
                  background: clearPrevious ? "#dc2626" : "#2563eb",
                  minWidth: 100,
                  opacity: generating ? 0.7 : 1,
                  cursor: generating ? "not-allowed" : "pointer",
                }}
              >
                {generating ? "생성 중…" : "생성 실행"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 수동 생성 모달 ────────────────────────────────────────────────────────── */}
      {showManualModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}
          onClick={e => { if (e.target === e.currentTarget) { setShowManualModal(false); setManualDraft({ ...EMPTY_MANUAL }); } }}
        >
          <div style={{
            background: "#fff", borderRadius: 14, width: 560, maxWidth: "92vw",
            maxHeight: "88vh", overflowY: "auto",
            boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
          }}>
            {/* 모달 헤더 */}
            <div style={{
              padding: "18px 22px", borderBottom: "1px solid #e5e7eb",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              position: "sticky", top: 0, background: "#fff", zIndex: 1, borderRadius: "14px 14px 0 0",
            }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>✍️ 인사이트 수동 생성</h3>
                <p style={{ margin: "3px 0 0", fontSize: 12, color: "#6b7280" }}>직접 내용을 입력하여 인사이트를 생성합니다.</p>
              </div>
              <button
                onClick={() => { setShowManualModal(false); setManualDraft({ ...EMPTY_MANUAL }); }}
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6b7280", lineHeight: 1 }}
              >✕</button>
            </div>

            {/* 모달 바디 */}
            <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>

              {/* 질문 */}
              <div>
                <label style={modalLabelStyle}>질문 <span style={{ color: "#ef4444" }}>*</span></label>
                <textarea
                  value={manualDraft.question}
                  onChange={e => setManualDraft(d => ({ ...d, question: e.target.value }))}
                  rows={2}
                  placeholder="예: 법률 한영 번역 비용은 얼마인가요?"
                  style={textareaStyle}
                />
              </div>

              {/* 요약 답변 */}
              <div>
                <label style={modalLabelStyle}>요약 답변 (shortAnswer)</label>
                <textarea
                  value={manualDraft.shortAnswer}
                  onChange={e => setManualDraft(d => ({ ...d, shortAnswer: e.target.value }))}
                  rows={2}
                  placeholder="한 두 문장의 핵심 답변"
                  style={textareaStyle}
                />
              </div>

              {/* 상세 답변 */}
              <div>
                <label style={modalLabelStyle}>상세 답변 (longAnswer)</label>
                <textarea
                  value={manualDraft.longAnswer}
                  onChange={e => setManualDraft(d => ({ ...d, longAnswer: e.target.value }))}
                  rows={5}
                  placeholder="마크다운 형식 가능. ## 제목, - 목록 등"
                  style={textareaStyle}
                />
              </div>

              {/* 서비스 유형 */}
              <div>
                <label style={modalLabelStyle}>서비스 유형</label>
                <select
                  value={manualDraft.serviceType}
                  onChange={e => setManualDraft(d => ({ ...d, serviceType: e.target.value }))}
                  style={{ ...editSelectStyle, maxWidth: 200 }}
                >
                  <option value="translation">번역</option>
                  <option value="interpretation">통역</option>
                  <option value="equipment">장비</option>
                </select>
              </div>

              {/* 분류 정보 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                  <label style={modalLabelStyle}>도메인</label>
                  <input value={manualDraft.domain} onChange={e => setManualDraft(d => ({ ...d, domain: e.target.value }))} placeholder="예: legal, finance" style={editInputStyle} />
                </div>
                <div>
                  <label style={modalLabelStyle}>언어쌍</label>
                  <input value={manualDraft.languagePair} onChange={e => setManualDraft(d => ({ ...d, languagePair: e.target.value }))} placeholder="예: ko-en" style={editInputStyle} />
                </div>
                <div>
                  <label style={modalLabelStyle}>산업</label>
                  <input value={manualDraft.industry} onChange={e => setManualDraft(d => ({ ...d, industry: e.target.value }))} placeholder="예: 제약, IT" style={editInputStyle} />
                </div>
                <div>
                  <label style={modalLabelStyle}>사용 목적</label>
                  <input value={manualDraft.useCase} onChange={e => setManualDraft(d => ({ ...d, useCase: e.target.value }))} placeholder="예: 계약서, 특허" style={editInputStyle} />
                </div>
              </div>

              {/* 가격 정보 */}
              <div>
                <label style={modalLabelStyle}>가격 정보 (원)</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>평균 단가</div>
                    <input type="number" value={manualDraft.avgPrice} onChange={e => setManualDraft(d => ({ ...d, avgPrice: e.target.value }))} placeholder="100000" style={editInputStyle} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>최소 단가</div>
                    <input type="number" value={manualDraft.minPrice} onChange={e => setManualDraft(d => ({ ...d, minPrice: e.target.value }))} placeholder="80000" style={editInputStyle} />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 3 }}>최대 단가</div>
                    <input type="number" value={manualDraft.maxPrice} onChange={e => setManualDraft(d => ({ ...d, maxPrice: e.target.value }))} placeholder="120000" style={editInputStyle} />
                  </div>
                </div>
              </div>

              {/* 신뢰도 */}
              <div>
                <label style={modalLabelStyle}>신뢰도 (0.0 ~ 1.0)</label>
                <input type="number" min="0" max="1" step="0.1" value={manualDraft.confidenceScore} onChange={e => setManualDraft(d => ({ ...d, confidenceScore: e.target.value }))} placeholder="0.7" style={{ ...editInputStyle, maxWidth: 100 }} />
              </div>
            </div>

            {/* 모달 푸터 */}
            <div style={{
              padding: "14px 22px", borderTop: "1px solid #e5e7eb",
              display: "flex", justifyContent: "flex-end", gap: 8,
              position: "sticky", bottom: 0, background: "#fff", borderRadius: "0 0 14px 14px",
            }}>
              <button
                onClick={() => { setShowManualModal(false); setManualDraft({ ...EMPTY_MANUAL }); }}
                disabled={creating}
                style={{ ...btnGhostStyle, opacity: creating ? 0.5 : 1 }}
              >취소</button>
              <button
                onClick={handleCreateManual}
                disabled={creating || !manualDraft.question.trim()}
                style={{
                  ...btnPrimaryStyle, minWidth: 100,
                  opacity: (creating || !manualDraft.question.trim()) ? 0.7 : 1,
                  cursor: (creating || !manualDraft.question.trim()) ? "not-allowed" : "pointer",
                }}
              >{creating ? "생성 중…" : "생성"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 블로그 변환 모달 ────────────────────────────────────────────────────── */}
      {showBlogModal && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}
          onClick={e => { if (e.target === e.currentTarget && !convertingBlog) { setShowBlogModal(false); setBlogDraft({ ...EMPTY_BLOG }); } }}
        >
          <div style={{
            background: "#fff", borderRadius: 14, width: 580, maxWidth: "92vw",
            maxHeight: "90vh", overflowY: "auto",
            boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
          }}>
            {/* 헤더 */}
            <div style={{
              padding: "18px 22px", borderBottom: "1px solid #e5e7eb",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              position: "sticky", top: 0, background: "#fff", zIndex: 1, borderRadius: "14px 14px 0 0",
            }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>📝 블로그 글 → 인사이트 변환</h3>
                <p style={{ margin: "3px 0 0", fontSize: 12, color: "#6b7280" }}>블로그 본문을 붙여넣어 AEO/GEO 인사이트 초안을 자동 생성합니다.</p>
              </div>
              <button
                onClick={() => { if (!convertingBlog) { setShowBlogModal(false); setBlogDraft({ ...EMPTY_BLOG }); } }}
                style={{ background: "none", border: "none", fontSize: 20, cursor: convertingBlog ? "not-allowed" : "pointer", color: "#6b7280", lineHeight: 1 }}
              >✕</button>
            </div>

            {/* 바디 */}
            <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
              {/* 블로그 제목 */}
              <div>
                <label style={modalLabelStyle}>블로그 제목 <span style={{ color: "#9ca3af", fontWeight: 400 }}>(선택)</span></label>
                <input
                  value={blogDraft.title}
                  onChange={e => setBlogDraft(d => ({ ...d, title: e.target.value }))}
                  placeholder="예) 동시통역 비용은 어떻게 결정될까?"
                  style={editInputStyle}
                  disabled={convertingBlog}
                />
              </div>

              {/* 본문 */}
              <div>
                <label style={modalLabelStyle}>
                  블로그 본문 <span style={{ color: "#ef4444" }}>*</span>
                  <span style={{
                    fontSize: 11, fontWeight: 400, color: blogDraft.content.trim().length < 300 && blogDraft.content.length > 0 ? "#ef4444" : "#9ca3af",
                    marginLeft: 8,
                  }}>
                    ({blogDraft.content.trim().length}자{blogDraft.content.trim().length < 300 ? " / 최소 300자 필요" : ""})
                  </span>
                </label>
                <textarea
                  value={blogDraft.content}
                  onChange={e => setBlogDraft(d => ({ ...d, content: e.target.value }))}
                  rows={12}
                  placeholder="블로그 글 본문 전체를 붙여넣으세요"
                  style={{ ...textareaStyle, fontFamily: "inherit", lineHeight: 1.6 }}
                  disabled={convertingBlog}
                />
                {blogDraft.content.trim().length > 0 && blogDraft.content.trim().length < 300 && (
                  <div style={{
                    marginTop: 6, padding: "8px 10px", background: "#fef2f2", borderRadius: 6,
                    border: "1px solid #fecaca", fontSize: 12, color: "#dc2626",
                  }}>
                    본문이 너무 짧아 인사이트 생성이 어렵습니다. (최소 300자)
                  </div>
                )}
              </div>

              {/* 출처 URL */}
              <div>
                <label style={modalLabelStyle}>출처 URL <span style={{ color: "#9ca3af", fontWeight: 400 }}>(선택)</span></label>
                <input
                  value={blogDraft.sourceUrl}
                  onChange={e => setBlogDraft(d => ({ ...d, sourceUrl: e.target.value }))}
                  placeholder="https://..."
                  style={editInputStyle}
                  disabled={convertingBlog}
                />
              </div>

              {/* 생성 개수 */}
              <div>
                <label style={modalLabelStyle}>생성 개수</label>
                <select
                  value={blogDraft.count}
                  onChange={e => setBlogDraft(d => ({ ...d, count: e.target.value }))}
                  style={{ ...editSelectStyle, maxWidth: 120 }}
                  disabled={convertingBlog}
                >
                  <option value="1">1개</option>
                  <option value="3">3개</option>
                  <option value="5">5개</option>
                </select>
              </div>

              {/* 안내 */}
              <div style={{
                padding: "12px 14px", background: "#f0f9ff", borderRadius: 8,
                border: "1px solid #bae6fd", fontSize: 12, color: "#0369a1",
                lineHeight: 1.6,
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>📌 안내</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>생성된 인사이트는 모두 <strong>초안(draft)</strong> 상태로 저장됩니다.</li>
                  <li>자동 게시되지 않으며, 검수 후 게시할 수 있습니다.</li>
                  <li>실제 운영 데이터가 없는 경우 가격 정보는 임의 생성하지 않습니다.</li>
                </ul>
              </div>

              {/* 생성 중 표시 */}
              {convertingBlog && (
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "12px 14px", background: "#f0fdf4", borderRadius: 8,
                  border: "1px solid #bbf7d0", fontSize: 13, color: "#15803d",
                }}>
                  <span style={{ fontSize: 18 }}>⏳</span>
                  AI가 블로그 글을 분석 중입니다… 잠시 기다려 주세요.
                </div>
              )}
            </div>

            {/* 푸터 */}
            <div style={{
              padding: "14px 22px", borderTop: "1px solid #e5e7eb",
              display: "flex", justifyContent: "flex-end", gap: 8,
              position: "sticky", bottom: 0, background: "#fff", borderRadius: "0 0 14px 14px",
            }}>
              <button
                onClick={() => { setShowBlogModal(false); setBlogDraft({ ...EMPTY_BLOG }); }}
                disabled={convertingBlog}
                style={{ ...btnGhostStyle, opacity: convertingBlog ? 0.5 : 1, cursor: convertingBlog ? "not-allowed" : "pointer" }}
              >취소</button>
              <button
                onClick={handleBlogConvert}
                disabled={convertingBlog || blogDraft.content.trim().length < 300}
                style={{
                  ...btnPrimaryStyle, minWidth: 120,
                  opacity: (convertingBlog || blogDraft.content.trim().length < 300) ? 0.7 : 1,
                  cursor: (convertingBlog || blogDraft.content.trim().length < 300) ? "not-allowed" : "pointer",
                }}
              >{convertingBlog ? "생성 중…" : "초안 생성"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 병합 모달 ──────────────────────────────────────────────────────────── */}
      {showMergeModal && mergeSource && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={e => { if (e.target === e.currentTarget && !merging) { setShowMergeModal(false); } }}
        >
          <div style={{ background: "#fff", borderRadius: 14, width: 460, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,0.22)", padding: 24 }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700 }}>병합 실행</h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "#6b7280" }}>
              아래 소스 인사이트를 대상 인사이트에 병합합니다. 소스는 보관 처리됩니다.
            </p>
            <div style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 3 }}>소스 (병합되어 사라질 항목)</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>#{mergeSource.id} — {mergeSource.question}</div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={modalLabelStyle}>
                대상 인사이트 ID
                {mergeSource.duplicateOfId && (
                  <span style={{ fontWeight: 400, color: "#6b7280", marginLeft: 8, fontSize: 11 }}>
                    (추천: #{mergeSource.duplicateOfId})
                  </span>
                )}
              </label>
              <input
                type="number"
                value={mergeTargetId}
                onChange={e => setMergeTargetId(e.target.value)}
                placeholder={mergeSource.duplicateOfId ? `추천 대상: #${mergeSource.duplicateOfId}` : "대상 ID 입력"}
                style={{ ...editInputStyle, maxWidth: 180 }}
                disabled={merging}
              />
              <button
                onClick={() => setMergeTargetId(String(mergeSource.duplicateOfId ?? ""))}
                style={{ ...btnGhostStyle, marginLeft: 8, fontSize: 11, padding: "4px 8px" }}
                disabled={!mergeSource.duplicateOfId}
              >추천 사용</button>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowMergeModal(false)} disabled={merging} style={{ ...btnGhostStyle, opacity: merging ? 0.5 : 1 }}>취소</button>
              <button
                onClick={handleMergeConfirm}
                disabled={merging || !mergeTargetId.trim()}
                style={{ ...btnPrimaryStyle, background: "#2563eb", opacity: (merging || !mergeTargetId.trim()) ? 0.7 : 1 }}
              >{merging ? "병합 중…" : "병합 실행"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 판정 탭 + 보관됨 토글 ────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {([
          { key: "all", label: "전체", color: "#374151" },
          { key: "keep", label: "✅ KEEP", color: "#166534" },
          { key: "review", label: "🔍 REVIEW", color: "#854d0e" },
          { key: "merge", label: "🔀 MERGE", color: "#1e40af" },
          { key: "drop", label: "🗑 DROP", color: "#991b1b" },
        ] as const).map(({ key, label, color }) => (
          <button key={key}
            onClick={() => { setDecisionTab(key); setSelected(null); }}
            style={{
              padding: "5px 14px", borderRadius: 99, fontSize: 12, fontWeight: 600,
              border: "1.5px solid",
              borderColor: decisionTab === key ? color : "#e5e7eb",
              background: decisionTab === key ? color : "#fff",
              color: decisionTab === key ? "#fff" : "#6b7280",
              cursor: "pointer",
              transition: "all 0.1s",
            }}
          >{label}</button>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "#6b7280", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => { setShowArchived(e.target.checked); setSelected(null); }}
              style={{ cursor: "pointer" }}
            />
            보관됨 포함
          </label>
        </div>
      </div>

      {/* ── 콘텐츠 영역: 목록 + 상세 ────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, minHeight: 0, alignItems: "flex-start" }}>

        {/* ── 목록 테이블 ─────────────────────────────────────────────────────── */}
        <div style={{
          flex: selected ? "0 0 60%" : "1 1 100%",
          background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
          overflow: "hidden", transition: "flex 0.2s",
        }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: "center", color: "#9ca3af" }}>로딩 중…</div>
          ) : insights.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "#9ca3af" }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>💡</div>
              <div>인사이트가 없습니다.</div>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f9fafb", borderBottom: "2px solid #e5e7eb" }}>
                    {["ID", "유형", "질문", "요약 답변", "건수", "평균 단가", "신뢰도", "품질점수", "판정", "AEO 상태", "FAQ", "관련", "AEO 점수", "상태", "공개", "생성일", "액션"].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {insights.map(r => {
                    const isActive = selected?.id === r.id;
                    const isHighlighted = highlightedIds.has(r.id);
                    const stColor = STATUS_COLOR[r.status] ?? { bg: "#f3f4f6", color: "#374151" };
                    const rowBg = isActive ? "#eff6ff" : isHighlighted ? "#f0fdf4" : "transparent";
                    return (
                      <tr
                        key={r.id}
                        data-insight-id={r.id}
                        onClick={() => setSelected(isActive ? null : r)}
                        style={{
                          cursor: "pointer",
                          borderBottom: "1px solid #f3f4f6",
                          background: rowBg,
                          transition: "background 0.6s",
                          outline: isHighlighted && !isActive ? "2px solid #bbf7d0" : "none",
                          outlineOffset: -1,
                        }}
                        onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "#f9fafb"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = rowBg; }}
                      >
                        <td style={tdStyle}>{r.id}</td>
                        <td style={tdStyle}>
                          <Badge
                            text={SERVICE_TYPE_KO[r.serviceType] ?? r.serviceType}
                            style={{ background: SERVICE_COLOR[r.serviceType] ?? "#f3f4f6", color: "#374151" }}
                          />
                        </td>
                        <td style={{ ...tdStyle, maxWidth: 220 }}>
                          <span title={r.question}>{truncate(r.question, selected ? 40 : 60)}</span>
                        </td>
                        <td style={{ ...tdStyle, maxWidth: 180 }}>
                          <span title={r.shortAnswer ?? r.answer} style={{ color: "#6b7280" }}>
                            {truncate(r.shortAnswer ?? r.answer, 50)}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: "center" }}>{r.sourceCount ?? "-"}</td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>{fmt(r.avgPrice, "원")}</td>
                        <td style={{ ...tdStyle, textAlign: "center" }}>{fmtConf(r.confidenceScore)}</td>
                        <td style={{ ...tdStyle, textAlign: "center", fontWeight: 600, color: r.filterScore !== null ? (r.filterScore >= 80 ? "#059669" : r.filterScore >= 60 ? "#d97706" : "#dc2626") : "#9ca3af" }}>
                          {r.filterScore !== null ? r.filterScore : "—"}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "center" }}>
                          {r.filterDecision ? (
                            <span style={{
                              padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700,
                              ...(r.filterDecision === "keep"   ? { background: "#dcfce7", color: "#166534" } :
                                  r.filterDecision === "review" ? { background: "#fef9c3", color: "#854d0e" } :
                                  r.filterDecision === "merge"  ? { background: "#dbeafe", color: "#1e40af" } :
                                  r.filterDecision === "drop"   ? { background: "#fee2e2", color: "#991b1b" } :
                                  { background: "#f3f4f6", color: "#6b7280" }),
                            }}>
                              {r.filterDecision.toUpperCase()}
                              {r.filterDecision === "merge" && r.duplicateOfId ? ` #${r.duplicateOfId}` : ""}
                            </span>
                          ) : <span style={{ color: "#d1d5db", fontSize: 11 }}>—</span>}
                        </td>
                        {/* ── AEO 컬럼 ── */}
                        <td style={{ ...tdStyle, textAlign: "center" }}>
                          <span style={{
                            padding: "2px 7px", borderRadius: 99, fontSize: 10, fontWeight: 700,
                            ...(r.aeoStatus === "READY"   ? { background: "#dcfce7", color: "#166534" } :
                                r.aeoStatus === "PARTIAL" ? { background: "#fef9c3", color: "#92400e" } :
                                                             { background: "#fee2e2", color: "#991b1b" }),
                          }}>
                            {r.aeoStatus ?? "NONE"}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: "center", color: r.faqCount >= 3 ? "#059669" : r.faqCount >= 1 ? "#d97706" : "#9ca3af" }}>
                          {r.faqCount != null ? `FAQ ${r.faqCount}` : "—"}
                        </td>
                        <td style={{ ...tdStyle, textAlign: "center", color: r.relatedCount >= 1 ? "#2563eb" : "#9ca3af" }}>
                          {r.relatedCount > 0 ? `연결 ${r.relatedCount}` : "없음"}
                        </td>
                        <td style={{
                          ...tdStyle, textAlign: "center", fontWeight: 700,
                          color: r.aeoScore >= 80 ? "#059669" : r.aeoScore >= 40 ? "#d97706" : "#dc2626",
                        }}>
                          {r.aeoScore ?? 0}
                        </td>
                        <td style={tdStyle}>
                          <Badge text={STATUS_KO[r.status] ?? r.status} style={stColor} />
                        </td>
                        <td style={tdStyle}>
                          <span style={{ fontSize: 11, color: "#6b7280" }}>
                            {VISIBILITY_KO[r.visibilityLevel] ?? r.visibilityLevel}
                          </span>
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "#6b7280" }}>
                          {new Date(r.createdAt).toLocaleDateString("ko-KR")}
                        </td>
                        {/* 액션 버튼 */}
                        <td style={{ ...tdStyle, whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
                          {r.isArchived ? (
                            <button onClick={() => handleRestore(r.id)}
                              style={{ ...miniBtn, background: "#eff6ff", color: "#1e40af" }}>복구</button>
                          ) : r.filterDecision === "keep" || !r.filterDecision ? (
                            <span style={{ color: "#d1d5db", fontSize: 10 }}>—</span>
                          ) : r.filterDecision === "review" ? (
                            <div style={{ display: "flex", gap: 4 }}>
                              <button onClick={() => handleApprove(r.id)}
                                style={{ ...miniBtn, background: "#dcfce7", color: "#166534" }}>✔ 살리기</button>
                              <button onClick={() => handleDrop(r.id)}
                                style={{ ...miniBtn, background: "#fee2e2", color: "#991b1b" }}>🗑</button>
                            </div>
                          ) : r.filterDecision === "merge" ? (
                            <button onClick={() => openMergeModal(r)}
                              style={{ ...miniBtn, background: "#dbeafe", color: "#1e40af" }}>병합하기</button>
                          ) : r.filterDecision === "drop" ? (
                            <button onClick={() => handleRestore(r.id)}
                              style={{ ...miniBtn, background: "#f3f4f6", color: "#6b7280" }}>복구</button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── 상세 패널 ────────────────────────────────────────────────────────── */}
        {selected && (
          <div style={{
            flex: "0 0 39%", background: "#fff", borderRadius: 10,
            border: "1px solid #e5e7eb", overflow: "hidden",
          }}>
            {/* 헤더 */}
            <div style={{
              padding: "12px 16px", borderBottom: "1px solid #e5e7eb",
              display: "flex", justifyContent: "space-between", alignItems: "center",
              background: "#f9fafb",
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
                인사이트 #{selected.id} {editMode ? "수정" : "상세"}
              </span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {!editMode && (
                  <button
                    onClick={() => setEditMode(true)}
                    style={{
                      padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db",
                      background: "#fff", color: "#374151", fontSize: 11, fontWeight: 600, cursor: "pointer",
                    }}
                  >✏️ 수정</button>
                )}
                <button
                  onClick={() => { setSelected(null); setEditMode(false); }}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#6b7280" }}
                >✕</button>
              </div>
            </div>

            {editMode ? (
              /* ── 수정 폼 ────────────────────────────────────────────── */
              <div style={{ padding: 16, overflowY: "auto", maxHeight: "calc(100vh - 280px)", display: "flex", flexDirection: "column", gap: 12 }}>

                {selected.status === "published" && (
                  <div style={{
                    background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8,
                    padding: "8px 12px", fontSize: 12, color: "#92400e",
                  }}>
                    ⚠️ 게시 상태에서 수정하면 공개 페이지에 즉시 반영됩니다.
                  </div>
                )}

                <EditField label="질문">
                  <textarea
                    value={editDraft.question ?? ""}
                    onChange={e => setEditDraft(d => ({ ...d, question: e.target.value }))}
                    rows={3}
                    style={textareaStyle}
                  />
                </EditField>

                <EditField label="요약 답변 (shortAnswer)">
                  <textarea
                    value={editDraft.shortAnswer ?? ""}
                    onChange={e => setEditDraft(d => ({ ...d, shortAnswer: e.target.value }))}
                    rows={3}
                    style={textareaStyle}
                  />
                </EditField>

                <EditField label="상세 답변 (longAnswer)">
                  <textarea
                    value={editDraft.longAnswer ?? ""}
                    onChange={e => setEditDraft(d => ({ ...d, longAnswer: e.target.value }))}
                    rows={8}
                    style={textareaStyle}
                  />
                </EditField>

                <EditField label="서비스 유형">
                  <select
                    value={editDraft.serviceType ?? "translation"}
                    onChange={e => setEditDraft(d => ({ ...d, serviceType: e.target.value }))}
                    style={editSelectStyle}
                  >
                    <option value="translation">번역</option>
                    <option value="interpretation">통역</option>
                    <option value="equipment">장비</option>
                  </select>
                </EditField>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <EditField label="도메인">
                    <input value={editDraft.domain ?? ""} onChange={e => setEditDraft(d => ({ ...d, domain: e.target.value }))} style={editInputStyle} placeholder="예: legal" />
                  </EditField>
                  <EditField label="언어쌍">
                    <input value={editDraft.languagePair ?? ""} onChange={e => setEditDraft(d => ({ ...d, languagePair: e.target.value }))} style={editInputStyle} placeholder="예: ko-en" />
                  </EditField>
                  <EditField label="산업">
                    <input value={editDraft.industry ?? ""} onChange={e => setEditDraft(d => ({ ...d, industry: e.target.value }))} style={editInputStyle} />
                  </EditField>
                  <EditField label="사용 목적">
                    <input value={editDraft.useCase ?? ""} onChange={e => setEditDraft(d => ({ ...d, useCase: e.target.value }))} style={editInputStyle} />
                  </EditField>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <EditField label="평균 단가">
                    <input type="number" value={editDraft.avgPrice ?? ""} onChange={e => setEditDraft(d => ({ ...d, avgPrice: e.target.value }))} style={editInputStyle} placeholder="0" />
                  </EditField>
                  <EditField label="최저 단가">
                    <input type="number" value={editDraft.minPrice ?? ""} onChange={e => setEditDraft(d => ({ ...d, minPrice: e.target.value }))} style={editInputStyle} placeholder="0" />
                  </EditField>
                  <EditField label="최고 단가">
                    <input type="number" value={editDraft.maxPrice ?? ""} onChange={e => setEditDraft(d => ({ ...d, maxPrice: e.target.value }))} style={editInputStyle} placeholder="0" />
                  </EditField>
                </div>

                <EditField label="신뢰도 (0.0 ~ 1.0)">
                  <input type="number" min="0" max="1" step="0.1" value={editDraft.confidenceScore ?? ""} onChange={e => setEditDraft(d => ({ ...d, confidenceScore: e.target.value }))} style={{ ...editInputStyle, maxWidth: 100 }} placeholder="0.7" />
                </EditField>

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4, borderTop: "1px solid #f3f4f6" }}>
                  <button
                    onClick={() => setEditMode(false)}
                    disabled={saving}
                    style={{ ...btnGhostStyle, opacity: saving ? 0.5 : 1 }}
                  >취소</button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    style={{
                      ...btnPrimaryStyle, minWidth: 80,
                      opacity: saving ? 0.7 : 1,
                      cursor: saving ? "not-allowed" : "pointer",
                    }}
                  >{saving ? "저장 중…" : "저장"}</button>
                </div>
              </div>
            ) : (
              /* ── 상세 뷰 ────────────────────────────────────────────── */
              <div style={{ padding: 16, overflowY: "auto", maxHeight: "calc(100vh - 280px)", display: "flex", flexDirection: "column", gap: 14 }}>

                {/* 상태 변경 버튼 */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {statusActions(selected).map(a => (
                    <button
                      key={a.next}
                      onClick={() => handleStatusChange(selected.id, a.next)}
                      disabled={statusUpdating}
                      style={{
                        padding: "6px 14px", borderRadius: 6, border: "none",
                        background: a.bg, color: a.color, fontWeight: 600, fontSize: 12,
                        cursor: statusUpdating ? "not-allowed" : "pointer",
                        opacity: statusUpdating ? 0.6 : 1,
                      }}
                    >
                      {statusUpdating ? "처리 중…" : a.label}
                    </button>
                  ))}
                  <Badge
                    text={STATUS_KO[selected.status] ?? selected.status}
                    style={{ ...(STATUS_COLOR[selected.status] ?? {}), alignSelf: "center" }}
                  />
                </div>

                {/* 질문 */}
                <DetailSection label="질문">
                  <p style={{ margin: 0, fontWeight: 600, color: "#111827", fontSize: 14 }}>{selected.question}</p>
                </DetailSection>

                {/* 요약 답변 */}
                <DetailSection label="요약 답변 (shortAnswer)">
                  <p style={{ margin: 0, color: "#374151" }}>{selected.shortAnswer ?? selected.answer ?? "-"}</p>
                </DetailSection>

                {/* 상세 답변 */}
                <DetailSection label="상세 답변 (longAnswer)">
                  <LongAnswerRenderer text={selected.longAnswer} />
                </DetailSection>

                {/* 메타 정보 */}
                <DetailSection label="분류 정보">
                  <MetaGrid rows={[
                    ["서비스 유형", SERVICE_TYPE_KO[selected.serviceType] ?? selected.serviceType],
                    ["질문 유형",   selected.questionType ?? "-"],
                    ["언어쌍",     selected.languagePair ?? "-"],
                    ["도메인",     selected.domain ?? "-"],
                    ["산업",       selected.industry ?? "-"],
                    ["사용 목적",  selected.useCase ?? "-"],
                  ]} />
                </DetailSection>

                {/* 출처 정보 */}
                {(selected.sourceType || selected.sourceTitle || selected.sourceUrl) && (
                  <DetailSection label="출처 정보">
                    <MetaGrid rows={[
                      ["출처 유형",  selected.sourceType ?? "-"],
                      ["출처 제목",  selected.sourceTitle ?? "-"],
                    ]} />
                    {selected.sourceUrl && (
                      <div style={{ display: "flex", gap: 8, marginTop: 6, fontSize: 12 }}>
                        <span style={{ color: "#6b7280", minWidth: 80 }}>출처 URL</span>
                        <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer"
                          style={{ color: "#2563eb", wordBreak: "break-all" }}>
                          {selected.sourceUrl}
                        </a>
                      </div>
                    )}
                  </DetailSection>
                )}

                {/* 통계 정보 */}
                <DetailSection label="데이터 통계">
                  <MetaGrid rows={[
                    ["기반 건수",   selected.sourceCount !== null ? `${selected.sourceCount}건` : "-"],
                    ["평균 단가",   fmt(selected.avgPrice, "원")],
                    ["최저 단가",   fmt(selected.minPrice, "원")],
                    ["최고 단가",   fmt(selected.maxPrice, "원")],
                    ["평균 시간",   selected.avgDuration ? `${parseFloat(selected.avgDuration).toFixed(1)}시간` : "-"],
                    ["신뢰도",     fmtConf(selected.confidenceScore)],
                  ]} />
                </DetailSection>

                {/* AEO/GEO 준비 상태 */}
                <DetailSection label="AEO/GEO 노출 준비 상태">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{
                        padding: "4px 12px", borderRadius: 99, fontSize: 13, fontWeight: 700,
                        ...(selected.aeoStatus === "READY"   ? { background: "#dcfce7", color: "#166534" } :
                            selected.aeoStatus === "PARTIAL" ? { background: "#fef9c3", color: "#92400e" } :
                                                                { background: "#fee2e2", color: "#991b1b" }),
                      }}>
                        {selected.aeoStatus ?? "NONE"}
                      </span>
                      <span style={{
                        fontSize: 18, fontWeight: 800,
                        color: (selected.aeoScore ?? 0) >= 80 ? "#059669" : (selected.aeoScore ?? 0) >= 40 ? "#d97706" : "#dc2626",
                      }}>
                        {selected.aeoScore ?? 0}점
                      </span>
                      <span style={{ fontSize: 11, color: "#9ca3af" }}>/ 100</span>
                    </div>
                    <button
                      onClick={() => handleAutoEnhance(selected.id)}
                      disabled={enhancing}
                      style={{
                        padding: "5px 12px", borderRadius: 7, border: "1px solid #7c3aed",
                        background: enhancing ? "#f5f3ff" : "#7c3aed", color: enhancing ? "#7c3aed" : "#fff",
                        cursor: enhancing ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600,
                        display: "flex", alignItems: "center", gap: 5,
                      }}
                      title="AI로 부족한 AEO 필드(FAQ/관련/메타)를 자동 보완합니다"
                    >
                      <span>✨</span>
                      {enhancing ? "보완 중…" : "자동 보완"}
                    </button>
                  </div>
                  <MetaGrid rows={[
                    ["핵심 답변(shortAnswer)", selected.hasShortAnswer ? "✅ 있음 (+30점)" : "❌ 없음 (0점)"],
                    ["FAQ 수", selected.faqCount >= 3 ? `✅ ${selected.faqCount}개 (+30점)` : selected.faqCount >= 1 ? `⚠️ ${selected.faqCount}개 (+15점)` : "❌ 없음 (0점)"],
                    ["관련 연결 수", selected.relatedCount >= 1 ? `✅ ${selected.relatedCount}개 (+20점)` : "❌ 없음 (0점)"],
                    ["AEO Title", selected.hasAeoTitle ? "✅ 있음 (+10점)" : "❌ 없음 (0점)"],
                    ["AEO Description", selected.hasAeoDescription ? "✅ 있음 (+10점)" : "❌ 없음 (0점)"],
                  ]} />
                  {selected.aeoTitle && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 3, fontWeight: 600 }}>AEO TITLE</div>
                      <div style={{ fontSize: 13, color: "#111827", background: "#f9fafb", padding: "7px 10px", borderRadius: 6 }}>{selected.aeoTitle}</div>
                    </div>
                  )}
                  {selected.aeoDescription && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 3, fontWeight: 600 }}>AEO DESCRIPTION</div>
                      <div style={{ fontSize: 13, color: "#374151", background: "#f9fafb", padding: "7px 10px", borderRadius: 6, lineHeight: 1.5 }}>{selected.aeoDescription}</div>
                    </div>
                  )}
                  {selected.faqJson && selected.faqJson.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6, fontWeight: 600 }}>FAQ 목록 ({selected.faqJson.length}개)</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        {selected.faqJson.map((faq, i) => (
                          <div key={i} style={{ background: "#f0fdf4", borderRadius: 6, padding: "7px 10px", border: "1px solid #dcfce7" }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#111827", marginBottom: 2 }}>Q. {faq.question}</div>
                            <div style={{ fontSize: 12, color: "#374151" }}>A. {faq.answer}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(!selected.faqJson || selected.faqJson.length === 0) && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>FAQ 미생성 — 블로그 변환 또는 수동 추가 필요</div>
                  )}
                </DetailSection>

                {/* 자동 보완 제안 */}
                {(suggestionsLoading || suggestions.length > 0) && (
                  <DetailSection label="자동 보완 제안">
                    {suggestionsLoading ? (
                      <div style={{ fontSize: 12, color: "#9ca3af" }}>제안 불러오는 중…</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {suggestions.length === 0 && (
                          <div style={{ fontSize: 12, color: "#9ca3af", fontStyle: "italic" }}>제안 없음 — "✨ 자동 보완" 버튼을 눌러 생성하세요</div>
                        )}
                        {suggestions.map(sug => {
                          const isPending = sug.status === "pending";
                          const isApplied = sug.status === "applied";
                          const isRejected = sug.status === "rejected";
                          const typeLabel = sug.type === "faq" ? "FAQ 제안" : sug.type === "related" ? "관련 연결 제안" : "메타 제안";
                          const typeColor = sug.type === "faq" ? "#1e40af" : sug.type === "related" ? "#065f46" : "#6d28d9";
                          const typeBg = sug.type === "faq" ? "#dbeafe" : sug.type === "related" ? "#d1fae5" : "#ede9fe";
                          return (
                            <div key={sug.id} style={{
                              border: `1px solid ${isPending ? "#e5e7eb" : isApplied ? "#bbf7d0" : "#fecaca"}`,
                              borderRadius: 8, padding: "10px 12px",
                              background: isPending ? "#fff" : isApplied ? "#f0fdf4" : "#fef2f2",
                              opacity: isRejected ? 0.7 : 1,
                            }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{
                                    padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 700,
                                    background: typeBg, color: typeColor,
                                  }}>{typeLabel}</span>
                                  {isApplied && <span style={{ fontSize: 11, color: "#059669", fontWeight: 600 }}>✅ 적용됨</span>}
                                  {isRejected && <span style={{ fontSize: 11, color: "#dc2626", fontWeight: 600 }}>✕ 무시됨</span>}
                                </div>
                                {isPending && (
                                  <div style={{ display: "flex", gap: 6 }}>
                                    <button
                                      onClick={() => handleApplySuggestion(sug.id)}
                                      style={{
                                        padding: "3px 10px", borderRadius: 6, border: "1px solid #059669",
                                        background: "#059669", color: "#fff", cursor: "pointer",
                                        fontSize: 11, fontWeight: 600,
                                      }}
                                    >적용</button>
                                    <button
                                      onClick={() => handleRejectSuggestion(sug.id)}
                                      style={{
                                        padding: "3px 10px", borderRadius: 6, border: "1px solid #d1d5db",
                                        background: "#fff", color: "#6b7280", cursor: "pointer",
                                        fontSize: 11,
                                      }}
                                    >무시</button>
                                  </div>
                                )}
                              </div>
                              {/* 페이로드 미리보기 */}
                              {sug.type === "faq" && Array.isArray((sug.payload as {items?: unknown}).items) && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                                  {((sug.payload as {items: {question: string; answer: string}[]}).items).slice(0, 5).map((faq, i) => (
                                    <div key={i} style={{ background: "#f9fafb", borderRadius: 5, padding: "6px 8px", border: "1px solid #e5e7eb" }}>
                                      <div style={{ fontSize: 11, fontWeight: 600, color: "#111827", marginBottom: 2 }}>Q. {faq.question}</div>
                                      <div style={{ fontSize: 11, color: "#374151" }}>A. {faq.answer}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {sug.type === "related" && Array.isArray((sug.payload as {items?: unknown}).items) && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  {((sug.payload as {items: {id: number; question: string}[]}).items).map((r, i) => (
                                    <div key={i} style={{ fontSize: 11, color: "#1e40af", background: "#eff6ff", padding: "4px 8px", borderRadius: 5 }}>
                                      #{r.id} {r.question}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {sug.type === "meta" && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                  {(sug.payload as Record<string,string>).aeoTitle && (
                                    <div style={{ fontSize: 11 }}>
                                      <span style={{ color: "#6b7280", fontWeight: 600 }}>Title: </span>
                                      <span style={{ color: "#111827" }}>{(sug.payload as Record<string,string>).aeoTitle}</span>
                                    </div>
                                  )}
                                  {(sug.payload as Record<string,string>).aeoDescription && (
                                    <div style={{ fontSize: 11 }}>
                                      <span style={{ color: "#6b7280", fontWeight: 600 }}>Desc: </span>
                                      <span style={{ color: "#374151" }}>{(sug.payload as Record<string,string>).aeoDescription}</span>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </DetailSection>
                )}

                {/* 품질 필터 */}
                <DetailSection label="품질 필터">
                  {selected.filterDecision ? (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                        <span style={{
                          padding: "4px 12px", borderRadius: 99, fontSize: 13, fontWeight: 700,
                          ...(selected.filterDecision === "keep"   ? { background: "#dcfce7", color: "#166534" } :
                              selected.filterDecision === "review" ? { background: "#fef9c3", color: "#854d0e" } :
                              selected.filterDecision === "merge"  ? { background: "#dbeafe", color: "#1e40af" } :
                              selected.filterDecision === "drop"   ? { background: "#fee2e2", color: "#991b1b" } :
                              { background: "#f3f4f6", color: "#6b7280" }),
                        }}>
                          {selected.filterDecision.toUpperCase()}
                        </span>
                        <span style={{ fontSize: 16, fontWeight: 700, color: selected.filterScore !== null ? (selected.filterScore >= 80 ? "#059669" : selected.filterScore >= 60 ? "#d97706" : "#dc2626") : "#9ca3af" }}>
                          {selected.filterScore !== null ? `${selected.filterScore}점` : "-"}
                        </span>
                      </div>
                      {selected.filterReason && (
                        <div style={{ fontSize: 12, color: "#4b5563", marginBottom: 10, lineHeight: 1.5 }}>
                          {selected.filterReason}
                        </div>
                      )}
                      {selected.filterDecision === "merge" && selected.duplicateOfId && (
                        <div style={{ fontSize: 11, color: "#1e40af", background: "#eff6ff", padding: "6px 10px", borderRadius: 6, marginBottom: 10 }}>
                          기존 인사이트 #{selected.duplicateOfId}와 중복 판정
                        </div>
                      )}
                      <MetaGrid rows={[
                        ["검색 의도",   selected.searchIntentScore !== null ? `${selected.searchIntentScore}/25` : "-"],
                        ["상업적 의도", selected.commercialIntentScore !== null ? `${selected.commercialIntentScore}/25` : "-"],
                        ["구체성",     selected.specificityScore !== null ? `${selected.specificityScore}/20` : "-"],
                        ["중복 없음",  selected.duplicationScore !== null ? `${selected.duplicationScore}/15` : "-"],
                        ["출처 가중치", selected.sourceWeight !== null ? `${selected.sourceWeight}/10` : "-"],
                      ]} />
                      <button
                        onClick={() => handleFilter([selected.id])}
                        disabled={filtering}
                        style={{ ...btnGhostStyle, marginTop: 8, fontSize: 11, padding: "4px 10px", opacity: filtering ? 0.5 : 1 }}
                      >↻ 재평가</button>

                      {/* 판정 처리 액션 */}
                      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #f3f4f6", display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {selected.isArchived ? (
                          <button onClick={() => handleRestore(selected.id)} style={{ ...miniBtn, background: "#eff6ff", color: "#1e40af", padding: "5px 12px", fontSize: 12 }}>
                            복구
                          </button>
                        ) : selected.filterDecision === "review" ? (
                          <>
                            <button onClick={() => handleApprove(selected.id)} style={{ ...miniBtn, background: "#dcfce7", color: "#166534", padding: "5px 12px", fontSize: 12 }}>
                              ✔ KEEP으로 살리기
                            </button>
                            <button onClick={() => openMergeModal(selected)} style={{ ...miniBtn, background: "#dbeafe", color: "#1e40af", padding: "5px 12px", fontSize: 12 }}>
                              🔀 병합 처리
                            </button>
                            <button onClick={() => handleDrop(selected.id)} style={{ ...miniBtn, background: "#fee2e2", color: "#991b1b", padding: "5px 12px", fontSize: 12 }}>
                              🗑 삭제
                            </button>
                          </>
                        ) : selected.filterDecision === "merge" ? (
                          <>
                            <button onClick={() => openMergeModal(selected)} style={{ ...miniBtn, background: "#dbeafe", color: "#1e40af", padding: "5px 12px", fontSize: 12 }}>
                              🔀 병합 실행
                            </button>
                            <button onClick={() => handleDrop(selected.id)} style={{ ...miniBtn, background: "#fee2e2", color: "#991b1b", padding: "5px 12px", fontSize: 12 }}>
                              🗑 삭제
                            </button>
                          </>
                        ) : selected.filterDecision === "drop" ? (
                          <>
                            <button onClick={() => handleRestore(selected.id)} style={{ ...miniBtn, background: "#f3f4f6", color: "#6b7280", padding: "5px 12px", fontSize: 12 }}>
                              복구
                            </button>
                          </>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>아직 품질 필터가 실행되지 않았습니다.</p>
                      <button
                        onClick={() => handleFilter([selected.id])}
                        disabled={filtering}
                        style={{
                          ...btnGhostStyle, fontSize: 11, padding: "5px 12px", display: "inline-flex",
                          alignItems: "center", gap: 4, alignSelf: "flex-start",
                          opacity: filtering ? 0.5 : 1,
                        }}
                      >
                        <span>⚙️</span> 이 항목 필터 실행
                      </button>
                    </div>
                  )}
                </DetailSection>

                {/* 공개 설정 */}
                <DetailSection label="공개 설정">
                  <MetaGrid rows={[
                    ["공개 수준",   VISIBILITY_KO[selected.visibilityLevel] ?? selected.visibilityLevel],
                    ["공개 여부",   selected.isPublic ? "공개" : "비공개"],
                    ["생성일",     new Date(selected.createdAt).toLocaleString("ko-KR")],
                    ["수정일",     new Date(selected.updatedAt).toLocaleString("ko-KR")],
                  ]} />
                </DetailSection>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ background: "#f9fafb", borderRadius: 6, padding: "10px 12px", border: "1px solid #f3f4f6" }}>
        {children}
      </div>
    </div>
  );
}

function MetaGrid({ rows }: { rows: [string, string][] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px" }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600 }}>{label}</span>
          <span style={{ fontSize: 12, color: "#111827", fontWeight: value === "-" ? 400 : 500 }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db",
  fontSize: 12, color: "#374151", background: "#fff", cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db",
  fontSize: 12, color: "#374151", minWidth: 130,
};

const btnPrimaryStyle: React.CSSProperties = {
  padding: "6px 14px", borderRadius: 6, border: "none",
  background: "#2563eb", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer",
};

const btnGhostStyle: React.CSSProperties = {
  padding: "6px 14px", borderRadius: 6, border: "1px solid #d1d5db",
  background: "#fff", color: "#374151", fontSize: 12, cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontSize: 11,
  fontWeight: 600, color: "#6b7280", whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px", fontSize: 12, color: "#111827", verticalAlign: "middle",
};

const editInputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 9px", borderRadius: 6, border: "1px solid #d1d5db",
  fontSize: 12, color: "#111827", boxSizing: "border-box",
};

const editSelectStyle: React.CSSProperties = {
  width: "100%", padding: "6px 9px", borderRadius: 6, border: "1px solid #d1d5db",
  fontSize: 12, color: "#111827", background: "#fff", cursor: "pointer", boxSizing: "border-box",
};

const textareaStyle: React.CSSProperties = {
  width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid #d1d5db",
  fontSize: 12, color: "#111827", resize: "vertical", lineHeight: 1.5,
  fontFamily: "inherit", boxSizing: "border-box",
};

const modalLabelStyle: React.CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 5,
};

const miniBtn: React.CSSProperties = {
  padding: "3px 8px", borderRadius: 5, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer",
};
