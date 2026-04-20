import { useState, useEffect, useCallback } from "react";

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
                    {["ID", "유형", "질문", "요약 답변", "건수", "평균 단가", "신뢰도", "상태", "공개", "생성일"].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {insights.map(r => {
                    const isActive = selected?.id === r.id;
                    const stColor = STATUS_COLOR[r.status] ?? { bg: "#f3f4f6", color: "#374151" };
                    return (
                      <tr
                        key={r.id}
                        onClick={() => setSelected(isActive ? null : r)}
                        style={{
                          cursor: "pointer",
                          borderBottom: "1px solid #f3f4f6",
                          background: isActive ? "#eff6ff" : "transparent",
                          transition: "background 0.1s",
                        }}
                        onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "#f9fafb"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isActive ? "#eff6ff" : "transparent"; }}
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
                인사이트 #{selected.id} 상세
              </span>
              <button
                onClick={() => setSelected(null)}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#6b7280" }}
              >✕</button>
            </div>

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
