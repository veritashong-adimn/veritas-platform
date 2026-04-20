import { useEffect, useState } from "react";
import { api } from "../lib/constants";

interface RelatedInsight {
  id: number;
  question: string;
  shortAnswer: string | null;
  slug: string;
}

interface InsightDetail {
  id: number;
  serviceType: string;
  question: string;
  shortAnswer: string | null;
  longAnswer: string | null;
  questionType: string | null;
  domain: string | null;
  languagePair: string | null;
  industry: string | null;
  useCase: string | null;
  avgPrice: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  sourceCount: number | null;
  confidenceScore: string | null;
  createdAt: string;
  updatedAt: string;
  slug: string;
  related: RelatedInsight[];
}

const SERVICE_LABEL: Record<string, string> = {
  translation: "번역",
  interpretation: "통역",
  equipment: "장비",
};
const DOMAIN_LABEL: Record<string, string> = {
  legal: "법률", finance: "금융", medical: "의료", technical: "기술",
  marketing: "마케팅", general: "일반", academic: "학술", literary: "문학",
  science: "과학", government: "정부/공공",
};
const LANG_LABEL: Record<string, string> = {
  "ko-en": "한→영", "en-ko": "영→한", "ko-ja": "한→일", "ja-ko": "일→한",
  "ko-zh": "한→중", "zh-ko": "중→한", "ko-de": "한→독", "ko-fr": "한→불",
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

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

function renderLongAnswer(text: string) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) {
      const content = line.replace(/^#{1,3}\s+/, "");
      elements.push(
        <h3 key={i} style={{ margin: "20px 0 6px", fontSize: 15, fontWeight: 700, color: "#111827" }}>
          {content}
        </h3>,
      );
    } else if (/^\s*[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} style={{ margin: "6px 0 10px", paddingLeft: 20 }}>
          {items.map((item, j) => (
            <li key={j} style={{ fontSize: 14, color: "#374151", lineHeight: 1.7 }}>
              {item.replace(/\*\*([^*]+)\*\*/g, "$1")}
            </li>
          ))}
        </ul>,
      );
      continue;
    } else if (line.trim() === "") {
      // skip blank
    } else {
      const rendered = line
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");
      elements.push(
        <p
          key={i}
          style={{ margin: "0 0 12px", fontSize: 14, color: "#374151", lineHeight: 1.8 }}
          dangerouslySetInnerHTML={{ __html: rendered }}
        />,
      );
    }
    i++;
  }
  return elements;
}

export function InsightDetailPage({ slug }: { slug: string }) {
  const [insight, setInsight] = useState<InsightDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(api(`/api/public/insights/${encodeURIComponent(slug)}`))
      .then(r => {
        if (r.status === 404) { setNotFound(true); setLoading(false); return null; }
        return r.json();
      })
      .then(d => {
        if (!d) return;
        setInsight(d);
        setLoading(false);
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [slug]);

  useEffect(() => {
    if (!insight) return;
    document.title = insight.question;

    const upsertMeta = (name: string, content: string, property?: string) => {
      const sel = property ? `meta[property="${property}"]` : `meta[name="${name}"]`;
      let el = document.querySelector(sel) as HTMLMetaElement | null;
      if (!el) {
        el = document.createElement("meta");
        if (property) el.setAttribute("property", property); else el.name = name;
        document.head.appendChild(el);
      }
      el.content = content;
    };
    upsertMeta("description", insight.shortAnswer ?? insight.question);
    upsertMeta("", insight.question, "og:title");
    upsertMeta("", insight.shortAnswer ?? insight.question, "og:description");

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [{
        "@type": "Question",
        "name": insight.question,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": [
            insight.shortAnswer,
            insight.longAnswer ? stripMarkdown(insight.longAnswer) : null,
          ].filter(Boolean).join(" "),
        },
      }],
    };
    let scriptEl = document.getElementById("faq-jsonld");
    if (!scriptEl) {
      scriptEl = document.createElement("script");
      scriptEl.id = "faq-jsonld";
      scriptEl.setAttribute("type", "application/ld+json");
      document.head.appendChild(scriptEl);
    }
    scriptEl.textContent = JSON.stringify(jsonLd);
  }, [insight]);

  const BADGE_COLOR: Record<string, { bg: string; text: string }> = {
    translation: { bg: "#eff6ff", text: "#2563eb" },
    interpretation: { bg: "#f0fdf4", text: "#16a34a" },
    equipment: { bg: "#fef9c3", text: "#b45309" },
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#f9fafb",
      fontFamily: "'Pretendard', 'Apple SD Gothic Neo', system-ui, sans-serif",
    }}>
      <header style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "0 24px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", alignItems: "center", height: 56, gap: 12 }}>
          <a href="/" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
            <div style={{
              width: 32, height: 32, background: "#2563eb", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontWeight: 800, fontSize: 14,
            }}>T</div>
            <span style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>통번역 플랫폼</span>
          </a>
          <span style={{ color: "#d1d5db" }}>/</span>
          <a href="/insights" style={{ fontSize: 14, color: "#6b7280", textDecoration: "none" }}>인사이트</a>
          {insight && (
            <>
              <span style={{ color: "#d1d5db" }}>/</span>
              <span style={{ fontSize: 14, color: "#374151", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {insight.question}
              </span>
            </>
          )}
        </div>
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 80px" }}>
        {loading && (
          <div style={{ textAlign: "center", padding: "80px 0", color: "#9ca3af" }}>불러오는 중...</div>
        )}

        {notFound && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
            <h1 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "#111827" }}>페이지를 찾을 수 없습니다</h1>
            <p style={{ margin: "0 0 24px", color: "#6b7280", fontSize: 14 }}>
              해당 인사이트가 존재하지 않거나 공개되지 않은 상태입니다.
            </p>
            <a href="/insights" style={{
              display: "inline-block", background: "#2563eb", color: "#fff",
              padding: "10px 20px", borderRadius: 8, textDecoration: "none",
              fontSize: 14, fontWeight: 600,
            }}>
              목록으로 돌아가기
            </a>
          </div>
        )}

        {!loading && insight && (() => {
          const badge = BADGE_COLOR[insight.serviceType] ?? { bg: "#f3f4f6", text: "#374151" };
          return (
            <>
              <div style={{ marginBottom: 8 }}>
                <span style={{
                  display: "inline-block", background: badge.bg, color: badge.text,
                  fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 100,
                }}>
                  {SERVICE_LABEL[insight.serviceType] ?? insight.serviceType}
                </span>
              </div>

              <h1 style={{ margin: "0 0 16px", fontSize: 24, fontWeight: 800, color: "#111827", lineHeight: 1.4 }}>
                {insight.question}
              </h1>

              {insight.shortAnswer && (
                <p style={{
                  margin: "0 0 28px", fontSize: 16, color: "#374151", lineHeight: 1.8,
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
                  padding: "16px 20px",
                }}>
                  {insight.shortAnswer}
                </p>
              )}

              {insight.longAnswer && (
                <div style={{
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
                  padding: "20px 22px", marginBottom: 24,
                }}>
                  <h2 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#111827" }}>상세 설명</h2>
                  <div>{renderLongAnswer(insight.longAnswer)}</div>
                </div>
              )}

              <div style={{
                background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
                padding: "20px 22px", marginBottom: 24,
              }}>
                <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 700, color: "#111827" }}>데이터 근거</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 16 }}>
                  {[
                    { label: "평균 단가", value: fmtPrice(insight.avgPrice) },
                    { label: "최소 단가", value: fmtPrice(insight.minPrice) },
                    { label: "최대 단가", value: fmtPrice(insight.maxPrice) },
                    { label: "데이터 건수", value: insight.sourceCount !== null ? `${insight.sourceCount}건` : null },
                    { label: "신뢰도", value: fmtConf(insight.confidenceScore) },
                  ].filter(item => item.value !== null).map(item => (
                    <div key={item.label} style={{
                      background: "#f9fafb", borderRadius: 8, padding: "12px 14px",
                    }}>
                      <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginBottom: 4 }}>{item.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{item.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {(insight.domain || insight.languagePair || insight.industry || insight.useCase) && (
                <div style={{
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
                  padding: "20px 22px", marginBottom: 24,
                }}>
                  <h2 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#111827" }}>관련 정보</h2>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                    {insight.domain && (
                      <div style={{ fontSize: 13, color: "#374151" }}>
                        <span style={{ color: "#9ca3af", marginRight: 4 }}>도메인</span>
                        <strong>{DOMAIN_LABEL[insight.domain] ?? insight.domain}</strong>
                      </div>
                    )}
                    {insight.languagePair && (
                      <div style={{ fontSize: 13, color: "#374151" }}>
                        <span style={{ color: "#9ca3af", marginRight: 4 }}>언어쌍</span>
                        <strong>{LANG_LABEL[insight.languagePair] ?? insight.languagePair}</strong>
                      </div>
                    )}
                    {insight.industry && (
                      <div style={{ fontSize: 13, color: "#374151" }}>
                        <span style={{ color: "#9ca3af", marginRight: 4 }}>산업/업종</span>
                        <strong>{insight.industry}</strong>
                      </div>
                    )}
                    {insight.useCase && (
                      <div style={{ fontSize: 13, color: "#374151" }}>
                        <span style={{ color: "#9ca3af", marginRight: 4 }}>사용 목적</span>
                        <strong>{insight.useCase}</strong>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {insight.related.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <h2 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#111827" }}>관련 인사이트</h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {insight.related.map(r => (
                      <a
                        key={r.id}
                        href={`/insights/${r.slug}`}
                        style={{
                          display: "block", background: "#fff",
                          border: "1px solid #e5e7eb", borderRadius: 8,
                          padding: "14px 16px", textDecoration: "none",
                          transition: "border-color 0.15s",
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.borderColor = "#c7d2fe"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.borderColor = "#e5e7eb"; }}
                      >
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#111827", marginBottom: 4 }}>{r.question}</div>
                        {r.shortAnswer && (
                          <div style={{
                            fontSize: 13, color: "#6b7280",
                            display: "-webkit-box",
                            WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          } as React.CSSProperties}>
                            {r.shortAnswer}
                          </div>
                        )}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ fontSize: 12, color: "#d1d5db", textAlign: "right", marginTop: 32 }}>
                최종 업데이트: {new Date(insight.updatedAt).toLocaleDateString("ko-KR")}
              </div>
            </>
          );
        })()}
      </main>

      <footer style={{ borderTop: "1px solid #e5e7eb", background: "#fff", padding: "20px 24px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", fontSize: 13, color: "#9ca3af" }}>
          © 통번역 플랫폼 — 실제 거래 데이터 기반 인사이트
        </div>
      </footer>
    </div>
  );
}
