import { useEffect, useState } from "react";
import { api } from "../lib/constants";

interface FaqItem {
  question: string;
  answer: string;
}

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
  aeoTitle: string | null;
  aeoDescription: string | null;
  faqJson: FaqItem[] | null;
  sourceWeight: number | null;
  filterScore: number | null;
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

// ── 이벤트 추적 헬퍼 ──────────────────────────────────────────────────────────

function getOrCreateSessionId(): string {
  const KEY = "insight_sid";
  let sid = localStorage.getItem(KEY);
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(KEY, sid);
  }
  return sid;
}

function getDevice(): string {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) return "mobile";
  if (/Tablet|iPad/i.test(ua)) return "tablet";
  return "desktop";
}

async function trackInsightEvent(insightId: number, eventType: "view" | "click" | "conversion", apiBase: string) {
  try {
    await fetch(`${apiBase}/api/insight-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        insightId,
        eventType,
        sessionId: getOrCreateSessionId(),
        referrer: document.referrer?.slice(0, 512) || null,
        device: getDevice(),
      }),
    });
  } catch {
    // 이벤트 수집 실패는 UX에 영향 주지 않음
  }
}

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

  // API base URL (환경에 따른 동적 처리)
  const apiBase = api("").replace(/\/$/, "").replace(/\/api$/, "");

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

  // view 이벤트 수집 (insight 로드 완료 시 1회)
  useEffect(() => {
    if (!insight?.id) return;
    trackInsightEvent(insight.id, "view", apiBase);
  }, [insight?.id, apiBase]);

  useEffect(() => {
    if (!insight) return;

    // SEO 메타 설정
    const metaTitle = insight.aeoTitle ?? insight.question;
    const metaDesc = insight.aeoDescription ?? insight.shortAnswer ?? insight.question;
    document.title = metaTitle;

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
    upsertMeta("description", metaDesc);
    upsertMeta("", metaTitle, "og:title");
    upsertMeta("", metaDesc, "og:description");

    // FAQPage Schema (질문 + faqJson 전체 포함)
    const faqEntities: object[] = [
      {
        "@type": "Question",
        "name": insight.question,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": [
            insight.shortAnswer,
            insight.longAnswer ? stripMarkdown(insight.longAnswer) : null,
          ].filter(Boolean).join(" "),
        },
      },
    ];
    if (insight.faqJson?.length) {
      for (const faq of insight.faqJson) {
        faqEntities.push({
          "@type": "Question",
          "name": faq.question,
          "acceptedAnswer": { "@type": "Answer", "text": faq.answer },
        });
      }
    }
    const faqSchema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqEntities,
    };
    let faqScript = document.getElementById("faq-jsonld");
    if (!faqScript) {
      faqScript = document.createElement("script");
      faqScript.id = "faq-jsonld";
      faqScript.setAttribute("type", "application/ld+json");
      document.head.appendChild(faqScript);
    }
    faqScript.textContent = JSON.stringify(faqSchema);

    // QAPage Schema
    const qaSchema = {
      "@context": "https://schema.org",
      "@type": "QAPage",
      "mainEntity": {
        "@type": "Question",
        "name": insight.question,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": insight.shortAnswer ?? "",
        },
      },
    };
    let qaScript = document.getElementById("qa-jsonld");
    if (!qaScript) {
      qaScript = document.createElement("script");
      qaScript.id = "qa-jsonld";
      qaScript.setAttribute("type", "application/ld+json");
      document.head.appendChild(qaScript);
    }
    qaScript.textContent = JSON.stringify(qaSchema);

    return () => {
      document.getElementById("qa-jsonld")?.remove();
    };
  }, [insight]);

  const BADGE_COLOR: Record<string, { bg: string; text: string }> = {
    translation: { bg: "#eff6ff", text: "#2563eb" },
    interpretation: { bg: "#f0fdf4", text: "#16a34a" },
    equipment: { bg: "#fef9c3", text: "#b45309" },
  };

  const hasKeyFacts = insight &&
    (insight.avgPrice || insight.minPrice || insight.maxPrice || insight.sourceCount !== null);

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
          const conf = fmtConf(insight.confidenceScore);
          return (
            <>
              {/* ── Answer Box (최상단, AEO/GEO 핵심 구조) ────────────────────────── */}
              <div style={{
                background: "#fff", border: "2px solid #e5e7eb", borderRadius: 14,
                padding: "24px 28px", marginBottom: 24,
                boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
              }}>
                {/* 배지 + 신뢰도 */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  <span style={{
                    display: "inline-block", background: badge.bg, color: badge.text,
                    fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 100,
                  }}>
                    {SERVICE_LABEL[insight.serviceType] ?? insight.serviceType}
                  </span>
                  {conf && (
                    <span style={{
                      fontSize: 12, color: "#6b7280", background: "#f3f4f6",
                      padding: "3px 10px", borderRadius: 100,
                    }}>
                      신뢰도 {conf}
                    </span>
                  )}
                </div>

                {/* 메인 질문 h1 */}
                <h1 style={{ margin: "0 0 16px", fontSize: 22, fontWeight: 800, color: "#111827", lineHeight: 1.4 }}>
                  {insight.question}
                </h1>

                {/* 핵심 답변 (shortAnswer) */}
                {insight.shortAnswer && (
                  <div style={{
                    fontSize: 16, color: "#374151", lineHeight: 1.8,
                    borderLeft: "4px solid #2563eb", paddingLeft: 16,
                    marginBottom: hasKeyFacts ? 20 : 0,
                  }}>
                    {insight.shortAnswer}
                  </div>
                )}

                {/* 핵심 수치 (key-facts) */}
                {hasKeyFacts && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: insight.shortAnswer ? 0 : 4 }}>
                    {fmtPrice(insight.avgPrice) && (
                      <div style={{ background: "#f0fdf4", borderRadius: 8, padding: "10px 14px", minWidth: 100 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, marginBottom: 2 }}>평균 단가</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#059669" }}>{fmtPrice(insight.avgPrice)}</div>
                      </div>
                    )}
                    {fmtPrice(insight.minPrice) && (
                      <div style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 14px", minWidth: 100 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, marginBottom: 2 }}>최소 단가</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{fmtPrice(insight.minPrice)}</div>
                      </div>
                    )}
                    {fmtPrice(insight.maxPrice) && (
                      <div style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 14px", minWidth: 100 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, marginBottom: 2 }}>최대 단가</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{fmtPrice(insight.maxPrice)}</div>
                      </div>
                    )}
                    {insight.sourceCount !== null && (
                      <div style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 14px", minWidth: 100 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 600, marginBottom: 2 }}>데이터 건수</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>{insight.sourceCount}건</div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── 상세 설명 ───────────────────────────────────────────────────────── */}
              {insight.longAnswer && (
                <div style={{
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
                  padding: "20px 24px", marginBottom: 24,
                }}>
                  <h2 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 700, color: "#111827" }}>상세 설명</h2>
                  <div>{renderLongAnswer(insight.longAnswer)}</div>
                </div>
              )}

              {/* ── FAQ 영역 (AEO/GEO 핵심) ─────────────────────────────────────── */}
              {insight.faqJson && insight.faqJson.length > 0 && (
                <div style={{
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
                  padding: "20px 24px", marginBottom: 24,
                }}>
                  <h2 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#111827" }}>자주 묻는 질문</h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {insight.faqJson.map((faq, idx) => (
                      <div key={idx} style={{
                        borderRadius: 8, background: "#f9fafb",
                        border: "1px solid #f3f4f6", padding: "14px 16px",
                      }}>
                        <h3 style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700, color: "#111827" }}>
                          {faq.question}
                        </h3>
                        <p style={{ margin: 0, fontSize: 14, color: "#374151", lineHeight: 1.7 }}>
                          {faq.answer}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── 관련 정보 (도메인/언어쌍/산업) ──────────────────────────────── */}
              {(insight.domain || insight.languagePair || insight.industry || insight.useCase) && (
                <div style={{
                  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
                  padding: "16px 20px", marginBottom: 24,
                }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
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

              {/* ── 관련 인사이트 (내부 링크) ────────────────────────────────────── */}
              {insight.related.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <h2 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "#111827" }}>관련 정보</h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {insight.related.map(r => (
                      <a
                        key={r.id}
                        href={`/insights/${r.slug}`}
                        style={{
                          display: "block", background: "#fff",
                          border: "1px solid #e5e7eb", borderRadius: 10,
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

              {/* ── CTA 섹션 ───────────────────────────────────────────────────── */}
              <div style={{
                background: "linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)",
                border: "1px solid #c7d2fe", borderRadius: 14,
                padding: "24px 28px", marginTop: 8, textAlign: "center",
              }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700, color: "#1e3a8a" }}>
                  전문 통번역이 필요하신가요?
                </h3>
                <p style={{ margin: "0 0 20px", fontSize: 14, color: "#4b5563" }}>
                  실제 거래 데이터 기반의 전문 서비스를 제공합니다.
                </p>
                <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
                  <a
                    href="/#contact"
                    onClick={() => trackInsightEvent(insight.id, "click", apiBase)}
                    style={{
                      display: "inline-block",
                      background: "#2563eb", color: "#fff",
                      padding: "12px 24px", borderRadius: 8,
                      textDecoration: "none", fontWeight: 700, fontSize: 14,
                      boxShadow: "0 2px 8px rgba(37,99,235,0.25)",
                      transition: "opacity 0.15s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.opacity = "0.9"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.opacity = "1"; }}
                  >
                    문의하기
                  </a>
                  <a
                    href="/#quote"
                    onClick={() => trackInsightEvent(insight.id, "click", apiBase)}
                    style={{
                      display: "inline-block",
                      background: "#fff", color: "#2563eb",
                      padding: "12px 24px", borderRadius: 8,
                      textDecoration: "none", fontWeight: 700, fontSize: 14,
                      border: "2px solid #2563eb",
                      transition: "opacity 0.15s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.opacity = "0.8"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.opacity = "1"; }}
                  >
                    견적 요청
                  </a>
                </div>
              </div>

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
