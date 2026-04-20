import { useState, useEffect, useCallback } from "react";
import { api } from "../../lib/constants";

interface AnalyticsRow {
  insightId: number;
  question: string;
  slug: string | null;
  views: number;
  clicks: number;
  conversions: number;
  ctr: number;
  conversionRate: number;
  viewConversionRate: number;
}

interface Props {
  token: string;
  setToast: (msg: string) => void;
}

const API = "/api";

const thS: React.CSSProperties = {
  padding: "8px 12px", textAlign: "left", fontSize: 11, fontWeight: 700,
  color: "#6b7280", background: "#f9fafb", borderBottom: "2px solid #e5e7eb",
  whiteSpace: "nowrap", userSelect: "none", cursor: "pointer",
};
const tdS: React.CSSProperties = {
  padding: "10px 12px", fontSize: 13, borderBottom: "1px solid #f3f4f6",
  verticalAlign: "middle",
};

function MetricBadge({ value, suffix = "", color = "#374151" }: { value: number | string; suffix?: string; color?: string }) {
  return (
    <span style={{ fontWeight: 700, color }}>
      {value}{suffix}
    </span>
  );
}

function EmptyState() {
  return (
    <div style={{ padding: "60px 0", textAlign: "center", color: "#9ca3af" }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>아직 성과 데이터가 없습니다</div>
      <div style={{ fontSize: 13 }}>게시된 인사이트 페이지를 방문하면 자동으로 수집됩니다.</div>
    </div>
  );
}

export function InsightAnalyticsTab({ token, setToast }: Props) {
  const [rows, setRows] = useState<AnalyticsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<"all" | "7d" | "30d">("all");
  const [sortBy, setSortBy] = useState<"views" | "clicks" | "conversions" | "ctr">("views");
  const [filterMode, setFilterMode] = useState<"all" | "has_conversion" | "high_ctr">("all");

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAnalytics = useCallback(async (p = period, s = sortBy) => {
    setLoading(true);
    try {
      const res = await fetch(
        `${API}/admin/insight-analytics?period=${p}&sortBy=${s}`,
        { headers: authHeaders },
      );
      if (!res.ok) throw new Error("성과 분석 조회 실패");
      const data = await res.json();
      setRows(data.data ?? []);
    } catch {
      setToast("성과 분석 조회 실패");
    } finally {
      setLoading(false);
    }
  }, [period, sortBy, token]);

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  const handleSort = (col: typeof sortBy) => {
    setSortBy(col);
    fetchAnalytics(period, col);
  };

  const filteredRows = rows.filter(r => {
    if (filterMode === "has_conversion") return r.conversions > 0;
    if (filterMode === "high_ctr") return r.ctr >= 10;
    return true;
  });

  // 요약 통계
  const totalViews = rows.reduce((a, r) => a + r.views, 0);
  const totalClicks = rows.reduce((a, r) => a + r.clicks, 0);
  const totalConversions = rows.reduce((a, r) => a + r.conversions, 0);
  const avgCtr = totalViews > 0 ? Math.round((totalClicks / totalViews) * 1000) / 10 : 0;

  const SortTh = ({ col, label }: { col: typeof sortBy; label: string }) => (
    <th style={{ ...thS, color: sortBy === col ? "#2563eb" : "#6b7280" }} onClick={() => handleSort(col)}>
      {label}{sortBy === col ? " ▼" : ""}
    </th>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>

      {/* ── 요약 카드 ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          { label: "총 조회수", value: totalViews.toLocaleString(), color: "#2563eb", icon: "👁" },
          { label: "총 클릭수", value: totalClicks.toLocaleString(), color: "#059669", icon: "🖱" },
          { label: "총 전환수", value: totalConversions.toLocaleString(), color: "#7c3aed", icon: "🎯" },
          { label: "평균 CTR", value: avgCtr + "%", color: "#d97706", icon: "📈" },
        ].map(card => (
          <div key={card.label} style={{
            flex: "1 1 140px", background: "#fff", borderRadius: 10,
            border: "1px solid #e5e7eb", padding: "14px 16px",
          }}>
            <div style={{ fontSize: 20, marginBottom: 6 }}>{card.icon}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: card.color }}>{card.value}</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{card.label}</div>
          </div>
        ))}
      </div>

      {/* ── 필터 바 ────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {/* 기간 */}
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>기간:</span>
        {([["all", "전체"], ["7d", "최근 7일"], ["30d", "최근 30일"]] as const).map(([val, label]) => (
          <button key={val} onClick={() => { setPeriod(val); fetchAnalytics(val, sortBy); }}
            style={{
              padding: "4px 12px", borderRadius: 99, fontSize: 12, fontWeight: 600,
              border: "1.5px solid", cursor: "pointer", transition: "all 0.1s",
              borderColor: period === val ? "#2563eb" : "#e5e7eb",
              background: period === val ? "#2563eb" : "#fff",
              color: period === val ? "#fff" : "#6b7280",
            }}>
            {label}
          </button>
        ))}

        <div style={{ width: 1, height: 20, background: "#e5e7eb", margin: "0 4px" }} />

        {/* 성과 필터 */}
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>필터:</span>
        {([["all", "전체"], ["has_conversion", "전환 있음"], ["high_ctr", "CTR 10%+"]] as const).map(([val, label]) => (
          <button key={val} onClick={() => setFilterMode(val)}
            style={{
              padding: "4px 12px", borderRadius: 99, fontSize: 12, fontWeight: 600,
              border: "1.5px solid", cursor: "pointer", transition: "all 0.1s",
              borderColor: filterMode === val ? "#7c3aed" : "#e5e7eb",
              background: filterMode === val ? "#7c3aed" : "#fff",
              color: filterMode === val ? "#fff" : "#6b7280",
            }}>
            {label}
          </button>
        ))}

        <button onClick={() => fetchAnalytics()}
          style={{
            marginLeft: "auto", padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
            background: "#f9fafb", border: "1px solid #e5e7eb", cursor: "pointer", color: "#374151",
          }}>
          새로고침
        </button>
      </div>

      {/* ── 테이블 ─────────────────────────────────────────────────────────────── */}
      <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb", overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#9ca3af" }}>로딩 중…</div>
        ) : filteredRows.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...thS, minWidth: 260 }}>인사이트</th>
                  <SortTh col="views" label="조회수" />
                  <SortTh col="clicks" label="클릭수" />
                  <SortTh col="conversions" label="전환수" />
                  <SortTh col="ctr" label="CTR (%)" />
                  <th style={thS}>전환율 (%)</th>
                  <th style={thS}>뷰전환 (%)</th>
                  <th style={thS}>진단</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, idx) => {
                  // 운영 진단 로직
                  const diagnosis: { text: string; color: string } = (() => {
                    if (r.views === 0) return { text: "미노출", color: "#9ca3af" };
                    if (r.conversions > 0 && r.ctr >= 10) return { text: "🏆 최고 성과", color: "#059669" };
                    if (r.conversions > 0) return { text: "✅ 전환 발생", color: "#059669" };
                    if (r.views > 10 && r.clicks === 0) return { text: "⚠ CTA 개선 필요", color: "#d97706" };
                    if (r.ctr >= 10 && r.conversions === 0) return { text: "🔍 랜딩 개선 필요", color: "#7c3aed" };
                    if (r.views > 0) return { text: "📈 수집 중", color: "#6b7280" };
                    return { text: "—", color: "#d1d5db" };
                  })();

                  return (
                    <tr key={r.insightId} style={{ background: idx % 2 === 0 ? "#fff" : "#fafafa" }}>
                      <td style={tdS}>
                        <div style={{ fontWeight: 600, color: "#111827", marginBottom: 2 }}>
                          {r.question.length > 55 ? r.question.slice(0, 55) + "…" : r.question}
                        </div>
                        {r.slug && (
                          <a href={`/insights/${r.slug}`} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: 11, color: "#6b7280", textDecoration: "none" }}>
                            /insights/{r.slug.slice(0, 30)}{r.slug.length > 30 ? "…" : ""}
                          </a>
                        )}
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <MetricBadge value={r.views.toLocaleString()} color={r.views > 50 ? "#1e40af" : r.views > 0 ? "#374151" : "#d1d5db"} />
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <MetricBadge value={r.clicks.toLocaleString()} color={r.clicks > 0 ? "#059669" : "#d1d5db"} />
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <MetricBadge value={r.conversions.toLocaleString()} color={r.conversions > 0 ? "#7c3aed" : "#d1d5db"} />
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <MetricBadge
                          value={r.ctr}
                          suffix="%"
                          color={r.ctr >= 15 ? "#059669" : r.ctr >= 5 ? "#d97706" : r.ctr > 0 ? "#374151" : "#d1d5db"}
                        />
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <MetricBadge
                          value={r.conversionRate}
                          suffix="%"
                          color={r.conversionRate >= 5 ? "#7c3aed" : r.conversionRate > 0 ? "#374151" : "#d1d5db"}
                        />
                      </td>
                      <td style={{ ...tdS, textAlign: "center" }}>
                        <MetricBadge
                          value={r.viewConversionRate}
                          suffix="%"
                          color={r.viewConversionRate > 0 ? "#374151" : "#d1d5db"}
                        />
                      </td>
                      <td style={tdS}>
                        <span style={{
                          fontSize: 11, fontWeight: 700, color: diagnosis.color,
                          background: diagnosis.color + "1a", padding: "2px 8px",
                          borderRadius: 99, whiteSpace: "nowrap",
                        }}>
                          {diagnosis.text}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 운영 가이드 ────────────────────────────────────────────────────────── */}
      <div style={{
        background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "14px 16px",
      }}>
        <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "#166534" }}>운영 활용 가이드</p>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 12, color: "#374151" }}>
          <span>⚠ CTA 개선 필요 → 조회는 많지만 클릭 없음 → 버튼 문구/위치 개선</span>
          <span>🔍 랜딩 개선 필요 → 클릭했는데 전환 없음 → 가격/신뢰도 보완</span>
          <span>🏆 최고 성과 → 관련 인사이트 확장 우선 대상</span>
        </div>
      </div>
    </div>
  );
}
