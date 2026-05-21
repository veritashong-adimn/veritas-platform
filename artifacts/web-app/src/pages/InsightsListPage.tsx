import { useEffect, useState } from "react";
import { api } from "../lib/constants";

interface PublicInsight {
  id: number;
  serviceType: string;
  question: string;
  shortAnswer: string | null;
  slug: string;
  avgPrice: string | null;
  sourceCount: number | null;
  confidenceScore: string | null;
}

const SERVICE_LABEL: Record<string, string> = {
  translation: "번역",
  interpretation: "통역",
  equipment: "장비",
};

const BADGE_COLOR: Record<string, { bg: string; text: string }> = {
  translation: { bg: "#eff6ff", text: "#2563eb" },
  interpretation: { bg: "#f0fdf4", text: "#16a34a" },
  equipment: { bg: "#fef9c3", text: "#b45309" },
};

function fmtPrice(val: string | null) {
  if (!val) return null;
  const n = parseFloat(val);
  if (isNaN(n)) return null;
  return n.toLocaleString("ko-KR") + "원";
}

function fmtConf(val: string | null) {
  if (!val) return null;
  const n = parseFloat(val);
  if (isNaN(n)) return null;
  return Math.round(n * 100) + "%";
}

export function InsightsListPage() {
  const [insights, setInsights] = useState<PublicInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "통번역 인사이트";
    const metaDesc = document.querySelector('meta[name="description"]');
    const content = "번역, 통역, 장비 비용과 실제 데이터 기반 인사이트 제공";
    if (metaDesc) {
      metaDesc.setAttribute("content", content);
    } else {
      const m = document.createElement("meta");
      m.name = "description";
      m.content = content;
      document.head.appendChild(m);
    }
  }, []);

  useEffect(() => {
    fetch(api("/api/public/insights"))
      .then(r => r.json())
      .then(d => {
        setInsights(d.data ?? []);
        setLoading(false);
      })
      .catch(() => {
        setError("인사이트를 불러오는 중 오류가 발생했습니다.");
        setLoading(false);
      });
  }, []);

  return (
    <div style={{
      minHeight: "100vh", background: "#f9fafb",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif",
    }}>
      <header style={{
        background: "#fff", borderBottom: "1px solid #e5e7eb",
        padding: "0 24px",
      }}>
        <div style={{ maxWidth: 960, margin: "0 auto", display: "flex", alignItems: "center", height: 56, gap: 12 }}>
          <a
            href="/"
            style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
          >
            <div style={{
              width: 32, height: 32, background: "#0f172a", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
                <path d="M4 5L16 25L28 5" stroke="#818cf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="7.6" y1="11" x2="24.4" y2="11" stroke="#818cf8" strokeWidth="1.2" strokeLinecap="round" opacity="0.55"/>
                <line x1="11.2" y1="17" x2="20.8" y2="17" stroke="#818cf8" strokeWidth="1" strokeLinecap="round" opacity="0.35"/>
                <circle cx="4" cy="5" r="2" fill="#6366f1"/>
                <circle cx="28" cy="5" r="2" fill="#6366f1"/>
                <circle cx="16" cy="25" r="2.2" fill="#60a5fa"/>
                <circle cx="7.6" cy="11" r="1.4" fill="#818cf8"/>
                <circle cx="24.4" cy="11" r="1.4" fill="#818cf8"/>
                <circle cx="11.2" cy="17" r="1.2" fill="#93c5fd" opacity="0.8"/>
                <circle cx="20.8" cy="17" r="1.2" fill="#93c5fd" opacity="0.8"/>
              </svg>
            </div>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#111827", letterSpacing: "0.05em" }}>
              VERITAS <span style={{ fontWeight: 400, color: "#9ca3af", letterSpacing: "0.08em" }}>OS</span>
            </span>
          </a>
          <span style={{ color: "#d1d5db", fontSize: 16 }}>/</span>
          <span style={{ fontSize: 14, color: "#6b7280" }}>인사이트</span>
        </div>
      </header>

      <main style={{ maxWidth: 960, margin: "0 auto", padding: "40px 24px 80px" }}>
        <div style={{ marginBottom: 32 }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 26, fontWeight: 800, color: "#111827" }}>
            통번역 인사이트
          </h1>
          <p style={{ margin: 0, fontSize: 15, color: "#6b7280" }}>
            실제 데이터 기반의 번역·통역·장비 비용 인사이트를 확인하세요.
          </p>
        </div>

        {loading && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#9ca3af" }}>
            불러오는 중...
          </div>
        )}
        {error && (
          <div style={{
            background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8,
            padding: "16px 20px", color: "#dc2626", fontSize: 14,
          }}>
            {error}
          </div>
        )}
        {!loading && !error && insights.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "#9ca3af", fontSize: 15 }}>
            게시된 인사이트가 없습니다.
          </div>
        )}

        {!loading && !error && insights.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
            {insights.map(insight => {
              const badge = BADGE_COLOR[insight.serviceType] ?? { bg: "#f3f4f6", text: "#374151" };
              return (
                <a
                  key={insight.id}
                  href={`/insights/${insight.slug}`}
                  style={{
                    display: "block", background: "#fff",
                    border: "1px solid #e5e7eb", borderRadius: 12,
                    padding: "20px 22px", textDecoration: "none",
                    transition: "box-shadow 0.15s, border-color 0.15s",
                    cursor: "pointer",
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLAnchorElement).style.boxShadow = "0 4px 16px rgba(0,0,0,0.08)";
                    (e.currentTarget as HTMLAnchorElement).style.borderColor = "#c7d2fe";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLAnchorElement).style.boxShadow = "none";
                    (e.currentTarget as HTMLAnchorElement).style.borderColor = "#e5e7eb";
                  }}
                >
                  <div style={{ marginBottom: 10 }}>
                    <span style={{
                      display: "inline-block", background: badge.bg, color: badge.text,
                      fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 100,
                    }}>
                      {SERVICE_LABEL[insight.serviceType] ?? insight.serviceType}
                    </span>
                  </div>
                  <h2 style={{
                    margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#111827",
                    lineHeight: 1.5,
                  }}>
                    {insight.question}
                  </h2>
                  {insight.shortAnswer && (
                    <p style={{
                      margin: "0 0 14px", fontSize: 13, color: "#4b5563",
                      lineHeight: 1.6,
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    } as React.CSSProperties}>
                      {insight.shortAnswer}
                    </p>
                  )}
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    {insight.avgPrice && (
                      <div>
                        <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, marginBottom: 1 }}>평균 단가</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{fmtPrice(insight.avgPrice)}</div>
                      </div>
                    )}
                    {insight.sourceCount !== null && (
                      <div>
                        <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, marginBottom: 1 }}>데이터 건수</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{insight.sourceCount}건</div>
                      </div>
                    )}
                    {insight.confidenceScore && (
                      <div>
                        <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, marginBottom: 1 }}>신뢰도</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{fmtConf(insight.confidenceScore)}</div>
                      </div>
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </main>

      <footer style={{ borderTop: "1px solid #e5e7eb", background: "#fff", padding: "20px 24px" }}>
        <div style={{ maxWidth: 960, margin: "0 auto", fontSize: 13, color: "#9ca3af" }}>
          © 통번역 플랫폼 — 실제 거래 데이터 기반 인사이트
        </div>
      </footer>
    </div>
  );
}
