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

  const fetchInsights = useCallback(async (f = appliedFilters) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (f.serviceType) params.set("serviceType", f.serviceType);
      if (f.status) params.set("status", f.status);
      if (f.visibilityLevel) params.set("visibilityLevel", f.visibilityLevel);
      if (f.domain) params.set("domain", f.domain);
      if (f.languagePair) params.set("languagePair", f.languagePair);

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
  }, [appliedFilters, token, setToast]);

  useEffect(() => { fetchInsights(); }, [fetchInsights]);

  const handleSearch = () => {
    setAppliedFilters(filters);
    setSelected(null);
    fetchInsights(filters);
  };

  const handleReset = () => {
    const empty = { serviceType: "", status: "", visibilityLevel: "", domain: "", languagePair: "" };
    setFilters(empty);
    setAppliedFilters(empty);
    setSelected(null);
    fetchInsights(empty);
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

        <button onClick={handleSearch} style={btnPrimaryStyle}>검색</button>
        <button onClick={handleReset} style={btnGhostStyle}>초기화</button>

        <span style={{ marginLeft: "auto", fontSize: 12, color: "#6b7280" }}>
          총 <strong>{total}</strong>건
        </span>

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
                    {["ID", "유형", "질문", "요약 답변", "건수", "평균 단가", "신뢰도", "상태", "공개", "생성일"].map(h => (
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
                      ["출처 URL",
                        selected.sourceUrl
                          ? <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer"
                              style={{ color: "#2563eb", fontSize: 11, wordBreak: "break-all" }}>
                              {selected.sourceUrl}
                            </a>
                          : "-"
                      ],
                    ]} />
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
