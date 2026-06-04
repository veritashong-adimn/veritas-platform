import React, { useState } from 'react';
import { api, LANGUAGE_CODES } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn } from '../ui';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

const LAZY_SERVICE_TYPES = ["번역", "순차통역", "동시통역", "상담회통역"] as const;
type LazyServiceType = typeof LAZY_SERVICE_TYPES[number];

type VirtualProduct = {
  isVirtual: true;
  displayName: string;
  productType: string;
  mainCategory: string;
  serviceType: LazyServiceType;
  sourceLanguage: string;
  targetLanguage: string;
  canonicalKey: string;
  unit: string;
  creationSource: "lazy_product_generation";
};

type ExistingProduct = {
  id: number;
  code: string;
  name: string;
  active: boolean;
};

type LookupResult =
  | { found: true; product: ExistingProduct }
  | { found: false; candidate: VirtualProduct };

type CreateResult = {
  created: boolean;
  product: ExistingProduct;
  message?: string;
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  token: string;
  authHeaders: Record<string, string>;
  setToast: (msg: string) => void;
  onProductCreated: () => void; // fetchProducts 트리거
}

// ─── 언어 레이블 맵 ───────────────────────────────────────────────────────────

const LANG_LABEL: Record<string, string> = Object.fromEntries(
  LANGUAGE_CODES.map(l => [l.code, l.label])
);

// ─── 스타일 상수 ──────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 7,
  fontSize: 13, color: "#111827", background: "#fff", cursor: "pointer",
};

const serviceColors: Record<LazyServiceType, { bg: string; color: string; border: string }> = {
  "번역":     { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" },
  "순차통역": { bg: "#f5f3ff", color: "#7c3aed", border: "#ddd6fe" },
  "동시통역": { bg: "#fdf4ff", color: "#9333ea", border: "#e9d5ff" },
  "상담회통역": { bg: "#f0fdf4", color: "#059669", border: "#bbf7d0" },
};

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────

export function LazyProductPanel({ token, authHeaders, setToast, onProductCreated }: Props) {
  const [srcLang, setSrcLang] = useState("ko");
  const [tgtLang, setTgtLang] = useState("en");
  const [serviceType, setServiceType] = useState<LazyServiceType>("번역");

  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [created, setCreated] = useState<ExistingProduct | null>(null);

  const handleLookup = async () => {
    if (!srcLang || !tgtLang) { setToast("출발언어와 도착언어를 선택하세요."); return; }
    if (srcLang === tgtLang) { setToast("출발언어와 도착언어가 같습니다."); return; }

    setLoading(true);
    setResult(null);
    setCreated(null);
    try {
      const res = await fetch(api("/api/admin/products/lazy-lookup"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ serviceType, sourceLanguage: srcLang, targetLanguage: tgtLang }),
      });
      const data = await res.json() as LookupResult;
      if (!res.ok) { setToast((data as any).error ?? "조회 실패"); return; }
      setResult(data);
    } catch { setToast("네트워크 오류"); }
    finally { setLoading(false); }
  };

  const handleCreate = async () => {
    if (!result || result.found) return;
    const c = result.candidate;
    setCreating(true);
    try {
      const res = await fetch(api("/api/admin/products/lazy-create"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType: c.serviceType,
          sourceLanguage: c.sourceLanguage,
          targetLanguage: c.targetLanguage,
          createdBy: "admin",
        }),
      });
      const data = await res.json() as CreateResult;
      if (!res.ok) { setToast((data as any).error ?? "생성 실패"); return; }
      setCreated(data.product);
      setResult({ found: true, product: data.product });
      setToast(data.created
        ? `✅ 상품 생성 완료: ${data.product.name} (${data.product.code})`
        : `ℹ 이미 존재하는 상품입니다: ${data.product.name}`
      );
      onProductCreated();
    } catch { setToast("네트워크 오류"); }
    finally { setCreating(false); }
  };

  const sc = serviceColors[serviceType];
  const srcLabel = LANG_LABEL[srcLang] ?? srcLang;
  const tgtLabel = LANG_LABEL[tgtLang] ?? tgtLang;
  const previewName = `${srcLabel}-${tgtLabel} ${serviceType}`;

  return (
    <Card style={{ marginBottom: 16, padding: "18px 22px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>⚡ 빠른 상품 조회/생성</span>
        <span style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", borderRadius: 4, padding: "2px 7px" }}>
          Lazy Product Generation
        </span>
      </div>

      {/* 선택 폼 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        {/* 서비스 타입 */}
        <div style={{ display: "flex", gap: 4 }}>
          {LAZY_SERVICE_TYPES.map(st => {
            const active = serviceType === st;
            const colors = serviceColors[st];
            return (
              <button key={st}
                onClick={() => { setServiceType(st); setResult(null); setCreated(null); }}
                style={{
                  fontSize: 12, padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontWeight: active ? 700 : 500,
                  border: `1px solid ${active ? colors.border : "#e5e7eb"}`,
                  background: active ? colors.bg : "#fff",
                  color: active ? colors.color : "#6b7280",
                }}>
                {st}
              </button>
            );
          })}
        </div>

        <span style={{ color: "#d1d5db" }}>|</span>

        {/* 출발언어 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af" }}>출발언어</label>
          <select value={srcLang} onChange={e => { setSrcLang(e.target.value); setResult(null); setCreated(null); }} style={selectStyle} data-testid="lazy-src-lang">
            {LANGUAGE_CODES.filter(l => l.code !== "other").map(l => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <span style={{ fontSize: 16, color: "#9ca3af", paddingTop: 14 }}>→</span>

        {/* 도착언어 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af" }}>도착언어</label>
          <select value={tgtLang} onChange={e => { setTgtLang(e.target.value); setResult(null); setCreated(null); }} style={selectStyle} data-testid="lazy-tgt-lang">
            {LANGUAGE_CODES.filter(l => l.code !== "other").map(l => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <div style={{ paddingTop: 14 }}>
          <PrimaryBtn onClick={handleLookup} disabled={loading} style={{ fontSize: 13, padding: "8px 18px" }} data-testid="lazy-lookup-btn">
            {loading ? "조회 중..." : "조회"}
          </PrimaryBtn>
        </div>
      </div>

      {/* 미리보기 */}
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
        조회 대상:&nbsp;
        <span style={{
          fontWeight: 700, color: sc.color, background: sc.bg,
          border: `1px solid ${sc.border}`, borderRadius: 4, padding: "1px 8px",
        }}>
          {previewName}
        </span>
      </div>

      {/* 결과 */}
      {result && (
        <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
          {result.found ? (
            /* ── 기존 상품 존재 ── */
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8 }}>
              <span style={{ fontSize: 16 }}>✅</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>기존 상품</div>
                <div style={{ fontSize: 13, color: "#374151", marginTop: 2 }}>{result.product.name}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, fontFamily: "monospace", background: "#e5e7eb", padding: "1px 6px", borderRadius: 4, color: "#374151" }}>
                    {result.product.code}
                  </span>
                  {!result.product.active && (
                    <span style={{ fontSize: 11, color: "#dc2626", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 4, padding: "1px 6px" }}>
                      비활성
                    </span>
                  )}
                  {created && (
                    <span style={{ fontSize: 11, color: "#059669", background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 4, padding: "1px 6px" }}>
                      방금 생성됨
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* ── 자동 생성 가능 ── */
            <div style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 16 }}>✨</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>자동 생성 가능</div>
                  <div style={{ fontSize: 12, color: "#78350f" }}>DB에 존재하지 않습니다. 저장 시 상품 마스터에 신규 등록됩니다.</div>
                </div>
              </div>

              {/* 후보 정보 */}
              <div style={{ background: "#fff", border: "1px solid #fcd34d", borderRadius: 7, padding: "10px 14px", marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 6 }}>
                  {result.candidate.displayName}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11 }}>
                  <span style={{ background: "#f3f4f6", padding: "1px 7px", borderRadius: 4, color: "#374151" }}>
                    {result.candidate.productType === "translation" ? "번역" : "통역"}
                  </span>
                  <span style={{ background: "#f3f4f6", padding: "1px 7px", borderRadius: 4, color: "#374151" }}>
                    {result.candidate.mainCategory}
                  </span>
                  <span style={{ background: "#f3f4f6", padding: "1px 7px", borderRadius: 4, color: "#374151" }}>
                    단위: {result.candidate.unit}
                  </span>
                  <span style={{ fontFamily: "monospace", background: "#fef3c7", padding: "1px 7px", borderRadius: 4, color: "#92400e" }}>
                    {result.candidate.canonicalKey}
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <PrimaryBtn onClick={handleCreate} disabled={creating} style={{ fontSize: 13, padding: "8px 20px", background: "#d97706" }} data-testid="lazy-create-btn">
                  {creating ? "생성 중..." : "상품 생성"}
                </PrimaryBtn>
                <GhostBtn onClick={() => { setResult(null); setCreated(null); }} style={{ fontSize: 13 }}>
                  취소
                </GhostBtn>
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>
                선택만으로는 DB에 저장되지 않습니다. "상품 생성" 버튼을 눌러야 등록됩니다.
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
