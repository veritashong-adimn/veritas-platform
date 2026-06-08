/**
 * ProductReviewPanel — 검수 워크플로우 UX
 *
 * 목적: 중복/canonical/normalize 후보를 관리자가 검토·승인·보류할 수 있는 패널.
 *       모든 결정은 로컬 상태(UI state)로만 관리 — DB 수정 없음.
 *
 * 검수 상태: pending | keep | accept | deferred | ignored
 */
import React, { useState, useMemo, useCallback } from 'react';
import { LANGUAGE_CODES, PRODUCT_TYPES_META } from '../../lib/constants';
import type { Product } from '../../lib/constants';

// ─── 검수 상태 ───────────────────────────────────────────────────────────────
type ReviewStatus = 'pending' | 'keep' | 'accept' | 'deferred' | 'ignored';

const STATUS_META: Record<ReviewStatus, { label: string; bg: string; color: string; border: string }> = {
  pending:  { label: "대기",       bg: "#f9fafb", color: "#6b7280", border: "#e5e7eb" },
  keep:     { label: "유지",       bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
  accept:   { label: "적용 예정",  bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe" },
  deferred: { label: "보류",       bg: "#fffbeb", color: "#d97706", border: "#fde68a" },
  ignored:  { label: "제외",       bg: "#fef2f2", color: "#dc2626", border: "#fecaca" },
};

// ─── 언어 레이블 맵 ──────────────────────────────────────────────────────────
const LANG_LABEL: Record<string, string> = Object.fromEntries(
  LANGUAGE_CODES.map(l => [l.code, l.label])
);

// ─── 상품유형 분류 ────────────────────────────────────────────────────────────
const OPS_COMPAT_TYPES = new Set(["transport", "meal", "accommodation", "other_cost", "expense", "operations"]);
const LANG_PAIR_TYPES  = new Set(["translation", "interpretation", "combined", "proofreading"]);

// ─── legacy naming 패턴 ───────────────────────────────────────────────────────
const LEGACY_LANG_RX = /^(한영|영한|일한|한일|중한|한중|한불|불한|한독|독한|영중|중영|한베|베한|한태|태한|한아|아한|한러|러한|스한|한스|한포|포한|이한|한이|아랍한|한아랍|태국한|태국어한|불어한|독어한)[\s·\-]/;

// ─── 운영/실비 normalize 규칙 ────────────────────────────────────────────────
const OPS_SUBCAT_NORMALIZE: Array<[RegExp, string, string]> = [
  [/항공|항공권|항공료/,        "항공료",    "교통비"],
  [/택시|택시비/,               "택시비",    "교통비"],
  [/렌트카|차량\s*렌트|렌터카/, "렌터카",    "교통비"],
  [/KTX|기차|열차/i,           "KTX·기차",  "교통비"],
  [/주유|유류/,                 "주유비",    "교통비"],
  [/숙박|호텔|게스트하우스/,    "숙박",      "숙박"],
  [/식비|식대|조식|중식|석식/,  "식대",      "식대"],
  [/퀵|배송|택배/,              "배송/퀵",   "기타실비"],
  [/공증|인증서류/,             "공증서류",  "기타실비"],
  [/인쇄|제본/,                 "인쇄/제본", "기타실비"],
];

// ─── 장비 유사 그룹 시드 ─────────────────────────────────────────────────────
const EQUIP_SIMILARITY_GROUPS: Array<{ label: string; patterns: RegExp[] }> = [
  { label: "동시통역장비 계열", patterns: [/동시통역장비/, /FM장비/, /FM방식/, /적외선장비/, /적외선방식/] },
  { label: "마이크 계열",       patterns: [/마이크/, /핀마이크/, /무선마이크/, /유선마이크/] },
  { label: "리시버 계열",       patterns: [/리시버/, /수신기/] },
  { label: "송신기 계열",       patterns: [/송신기/, /트랜스미터/] },
];

// ─── canonical name 생성 ─────────────────────────────────────────────────────
function buildCanonicalName(p: Product): string | null {
  if (!LANG_PAIR_TYPES.has(p.productType)) return null;
  const src = p.sourceLanguage; const tgt = p.targetLanguage;
  if (!src || !tgt) return null;
  const svcLabel = p.mainCategory || PRODUCT_TYPES_META[p.productType]?.label || p.productType;
  return `${LANG_LABEL[src] ?? src}-${LANG_LABEL[tgt] ?? tgt} ${svcLabel}`;
}

// ─── 유형 레이블 ─────────────────────────────────────────────────────────────
function typeLabel(p: Product): string {
  return PRODUCT_TYPES_META[p.productType]?.label
    ?? (OPS_COMPAT_TYPES.has(p.productType) ? "운영/실비" : p.productType);
}

// ─── 뱃지 ────────────────────────────────────────────────────────────────────
function Badge({ n, color = "#dc2626" }: { n: number; color?: string }) {
  return (
    <span style={{
      display: "inline-block", minWidth: 20, padding: "1px 7px",
      borderRadius: 99, fontSize: 11, fontWeight: 700,
      background: color, color: "#fff", marginLeft: 6,
    }}>{n}</span>
  );
}

// ─── 검수 액션 버튼 그룹 ─────────────────────────────────────────────────────
function ActionBtns({
  decisionKey, current, onDecide, hasProposal = false,
}: {
  decisionKey: string;
  current: ReviewStatus;
  onDecide: (key: string, s: ReviewStatus) => void;
  hasProposal?: boolean;
}) {
  const actions: { status: ReviewStatus; label: string; title: string }[] = [
    { status: "keep",     label: "유지",       title: "현재 상태 유지 — 변경 불필요" },
    ...(hasProposal
      ? [{ status: "accept" as ReviewStatus, label: "적용 예정", title: "다음 단계에서 제안 적용 예정" }]
      : []),
    { status: "deferred", label: "보류",       title: "나중에 다시 검토" },
    { status: "ignored",  label: "제외",       title: "이번 검수에서 제외" },
  ];

  return (
    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
      {actions.map(a => {
        const active = current === a.status;
        const m = STATUS_META[a.status];
        return (
          <button key={a.status}
            title={a.title}
            onClick={() => onDecide(decisionKey, active ? "pending" : a.status)}
            style={{
              padding: "3px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer",
              fontWeight: active ? 700 : 500,
              border: `1px solid ${active ? m.border : "#e5e7eb"}`,
              background: active ? m.bg : "#fff",
              color: active ? m.color : "#9ca3af",
              transition: "all 0.1s",
            }}>
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── 검수 가능한 단일 상품 행 ─────────────────────────────────────────────────
function ReviewableRow({
  decisionKey, p, proposal, proposalNote, decision, onDecide,
}: {
  decisionKey: string;
  p: Product;
  proposal?: string | null;
  proposalNote?: string;
  decision: ReviewStatus;
  onDecide: (key: string, s: ReviewStatus) => void;
}) {
  const m = STATUS_META[decision];
  return (
    <div style={{
      padding: "8px 10px", borderRadius: 8, marginBottom: 6,
      border: `1px solid ${m.border}`,
      background: m.bg,
    }}>
      {/* 상단: 상품 정보 + 액션 버튼 */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <code style={{ fontSize: 11, color: "#9ca3af", flexShrink: 0 }}>{p.code}</code>
            <span style={{ fontWeight: 600, fontSize: 13, color: "#111827" }}>{p.name}</span>
            <span style={{
              fontSize: 10, padding: "1px 5px", borderRadius: 4,
              background: "#f3f4f6", color: "#6b7280", border: "1px solid #e5e7eb",
            }}>{typeLabel(p)}</span>
            {p.mainCategory && (
              <span style={{ fontSize: 10, color: "#9ca3af" }}>{p.mainCategory}</span>
            )}
            {!p.active && (
              <span style={{ fontSize: 10, color: "#dc2626", fontWeight: 700 }}>비활성</span>
            )}
          </div>
          {/* 제안 표시 */}
          {proposal && (
            <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "#9ca3af", flexShrink: 0 }}>→ 제안:</span>
              <span style={{
                fontSize: 12, fontWeight: 600, color: "#2563eb",
                background: "#eff6ff", padding: "2px 8px", borderRadius: 4,
                border: "1px solid #bfdbfe",
              }}>{proposal}</span>
              {proposalNote && (
                <span style={{ fontSize: 10, color: "#6b7280" }}>({proposalNote})</span>
              )}
            </div>
          )}
        </div>
        {/* 상태 뱃지 + 액션 버튼 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {decision !== "pending" && (
            <span style={{
              fontSize: 10, padding: "2px 7px", borderRadius: 5, fontWeight: 700,
              background: m.bg, color: m.color, border: `1px solid ${m.border}`,
            }}>{m.label}</span>
          )}
          <ActionBtns
            decisionKey={decisionKey} current={decision}
            onDecide={onDecide} hasProposal={!!proposal}
          />
        </div>
      </div>
    </div>
  );
}

// ─── 그룹 검수 카드 (중복 후보) ───────────────────────────────────────────────
function ReviewableGroup({
  groupKey, members, groupLabel, decision, representative,
  onDecide, onSelectRepresentative,
}: {
  groupKey: string;
  members: Product[];
  groupLabel: string;
  decision: ReviewStatus;
  representative: number | null;
  onDecide: (key: string, s: ReviewStatus) => void;
  onSelectRepresentative: (key: string, id: number) => void;
}) {
  const m = STATUS_META[decision];
  return (
    <div style={{
      marginBottom: 12, padding: "10px 12px", borderRadius: 9,
      border: `1px solid ${m.border}`, background: m.bg,
    }}>
      {/* 그룹 헤더 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>{groupLabel}</span>
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{members.length}건</span>
          {decision !== "pending" && (
            <span style={{
              fontSize: 10, padding: "2px 7px", borderRadius: 5, fontWeight: 700,
              background: m.bg, color: m.color, border: `1px solid ${m.border}`,
            }}>{m.label}</span>
          )}
        </div>
        <ActionBtns
          decisionKey={groupKey} current={decision}
          onDecide={onDecide} hasProposal={representative !== null}
        />
      </div>
      {/* 멤버 목록 — 대표 선택 radio */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {members.map(p => (
          <label key={p.id} style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: "6px 8px", borderRadius: 6, cursor: "pointer",
            background: representative === p.id ? "#eff6ff" : "#fff",
            border: `1px solid ${representative === p.id ? "#bfdbfe" : "#e5e7eb"}`,
          }}>
            <input
              type="radio"
              name={`rep-${groupKey}`}
              checked={representative === p.id}
              onChange={() => onSelectRepresentative(groupKey, p.id)}
              style={{ marginTop: 2, flexShrink: 0, accentColor: "#2563eb" }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <code style={{ fontSize: 10, color: "#9ca3af" }}>{p.code}</code>
                <span style={{ fontWeight: 600, fontSize: 12, color: "#111827" }}>{p.name}</span>
                {p.mainCategory && (
                  <span style={{ fontSize: 10, color: "#6b7280" }}>{p.mainCategory}</span>
                )}
                {!p.active && <span style={{ fontSize: 10, color: "#dc2626", fontWeight: 700 }}>비활성</span>}
                {representative === p.id && (
                  <span style={{
                    fontSize: 10, padding: "1px 6px", borderRadius: 4,
                    background: "#dbeafe", color: "#2563eb", fontWeight: 700,
                  }}>대표 선택됨</span>
                )}
              </div>
            </div>
          </label>
        ))}
      </div>
      {representative === null && decision === "accept" && (
        <p style={{ margin: "6px 0 0", fontSize: 11, color: "#d97706" }}>
          ⚠ 대표 상품을 선택해 주세요 (radio 버튼)
        </p>
      )}
    </div>
  );
}

// ─── 섹션 컨테이너 ────────────────────────────────────────────────────────────
function ReviewSection({ title, count, children, color = "#2563eb" }: {
  title: string; count: number; children: React.ReactNode; color?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 16, border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "9px 14px", background: "#f8fafc", border: "none", cursor: "pointer",
          fontSize: 13, fontWeight: 700, color: "#111827",
        }}>
        <span>{title}<Badge n={count} color={count === 0 ? "#9ca3af" : color} /></span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ padding: "12px 14px", background: "#fff" }}>
          {count === 0
            ? <p style={{ margin: 0, fontSize: 12, color: "#9ca3af" }}>이상 없음</p>
            : children}
        </div>
      )}
    </div>
  );
}

// ─── 진행률 요약 바 ───────────────────────────────────────────────────────────
function ProgressBar({ decisions, total }: { decisions: Map<string, ReviewStatus>; total: number }) {
  const counts = { keep: 0, accept: 0, deferred: 0, ignored: 0, pending: 0 };
  decisions.forEach(s => { counts[s] = (counts[s] ?? 0) + 1; });
  counts.pending = total - (counts.keep + counts.accept + counts.deferred + counts.ignored);

  const reviewed = total - counts.pending;
  const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;

  const segments: { status: ReviewStatus; count: number }[] = [
    { status: "keep",     count: counts.keep },
    { status: "accept",   count: counts.accept },
    { status: "deferred", count: counts.deferred },
    { status: "ignored",  count: counts.ignored },
  ];

  return (
    <div style={{ marginBottom: 14, padding: "10px 12px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e5e7eb" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
          검수 진행률 {pct}% ({reviewed}/{total})
        </span>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {segments.map(({ status, count }) => {
            const m = STATUS_META[status];
            return count > 0 ? (
              <span key={status} style={{ fontSize: 11, color: m.color, fontWeight: 600 }}>
                {m.label} {count}
              </span>
            ) : null;
          })}
          {counts.pending > 0 && (
            <span style={{ fontSize: 11, color: "#9ca3af" }}>대기 {counts.pending}</span>
          )}
        </div>
      </div>
      {/* 색상 바 */}
      <div style={{ height: 6, borderRadius: 3, background: "#e5e7eb", overflow: "hidden", display: "flex" }}>
        {segments.map(({ status, count }) => {
          const m = STATUS_META[status];
          if (count === 0) return null;
          return (
            <div key={status} style={{
              width: `${(count / total) * 100}%`,
              background: m.color, transition: "width 0.3s",
            }} />
          );
        })}
      </div>
    </div>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
  products: Product[];
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────────
export function ProductReviewPanel({ products }: Props) {
  // 검수 결정 상태: key → ReviewStatus
  // key 규칙: "dup:{i}", "equip:{i}", "legacy:{id}", "ops:{id}", "canon:{id}"
  const [decisions, setDecisions] = useState<Map<string, ReviewStatus>>(new Map());
  // 중복 그룹 대표 상품 ID: groupKey → productId
  const [representatives, setRepresentatives] = useState<Map<string, number>>(new Map());

  const decide = useCallback((key: string, status: ReviewStatus) => {
    setDecisions(prev => {
      const next = new Map(prev);
      if (status === "pending") next.delete(key);
      else next.set(key, status);
      return next;
    });
  }, []);

  const selectRepresentative = useCallback((key: string, id: number) => {
    setRepresentatives(prev => new Map(prev).set(key, id));
  }, []);

  const getDecision = (key: string): ReviewStatus =>
    decisions.get(key) ?? "pending";

  // ── 분석 결과 ─────────────────────────────────────────────────────────────
  const duplicateGroups = useMemo(() => {
    const groups: Map<string, Product[]> = new Map();
    for (const p of products) {
      const key = LANG_PAIR_TYPES.has(p.productType)
        ? [p.productType, (p.sourceLanguage ?? "").toLowerCase(), (p.targetLanguage ?? "").toLowerCase(), (p.mainCategory ?? "").trim()].join("|")
        : `${p.productType}|${p.name.trim().replace(/\s+/g, "").toLowerCase()}`;
      const g = groups.get(key) ?? [];
      g.push(p);
      groups.set(key, g);
    }
    return Array.from(groups.values()).filter(g => g.length > 1);
  }, [products]);

  const equipSimilarGroups = useMemo(() => {
    const equips = products.filter(p => p.productType === "equipment");
    return EQUIP_SIMILARITY_GROUPS
      .map(g => ({ label: g.label, members: equips.filter(p => g.patterns.some(rx => rx.test(p.name))) }))
      .filter(g => g.members.length > 1);
  }, [products]);

  const legacyCandidates = useMemo(() =>
    products.filter(p => LANG_PAIR_TYPES.has(p.productType) && LEGACY_LANG_RX.test(p.name))
      .map(p => ({ product: p, canonical: buildCanonicalName(p) })),
    [products]);

  const opsCandidates = useMemo(() => {
    const result: { product: Product; normalizedTo: string; category: string }[] = [];
    for (const p of products.filter(p => OPS_COMPAT_TYPES.has(p.productType))) {
      for (const [rx, normalized, category] of OPS_SUBCAT_NORMALIZE) {
        if (rx.test(p.name) && p.name.trim() !== normalized) {
          result.push({ product: p, normalizedTo: normalized, category });
          break;
        }
      }
    }
    return result;
  }, [products]);

  const canonCandidates = useMemo(() => {
    const norm = (s: string) => s.trim().replace(/\s+/g, " ");
    return products
      .filter(p => LANG_PAIR_TYPES.has(p.productType) && p.sourceLanguage && p.targetLanguage)
      .map(p => ({ product: p, canonical: buildCanonicalName(p) }))
      .filter(({ product: p, canonical: c }) => c !== null && norm(p.name) !== norm(c!));
  }, [products]);

  // 전체 검수 항목 수
  const totalItems =
    duplicateGroups.length + equipSimilarGroups.length +
    legacyCandidates.length + opsCandidates.length + canonCandidates.length;

  return (
    <div style={{ padding: "14px 0 4px" }}>
      {/* 헤더 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #e5e7eb",
      }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>🔍 검수 워크플로우</span>
        <span style={{ fontSize: 12, color: "#6b7280" }}>
          {products.length}건 분석 · 검수 필요
          <Badge n={totalItems} color={totalItems === 0 ? "#9ca3af" : "#dc2626"} />
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>
          ※ 로컬 상태만 관리 — DB 수정 없음
        </span>
      </div>

      {/* 진행률 바 */}
      {totalItems > 0 && (
        <ProgressBar decisions={decisions} total={totalItems} />
      )}

      {/* 1. 정확 중복 후보 */}
      <ReviewSection title="1. 정확 중복 후보" count={duplicateGroups.length} color="#dc2626">
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "#6b7280" }}>
          같은 유형·언어쌍·대분류 기준 동일 상품 2건 이상 — 대표 상품 radio로 선택 후 액션을 결정하세요.
        </p>
        {duplicateGroups.map((g, i) => (
          <ReviewableGroup
            key={i}
            groupKey={`dup:${i}`}
            members={g}
            groupLabel={`그룹 ${i + 1}`}
            decision={getDecision(`dup:${i}`)}
            representative={representatives.get(`dup:${i}`) ?? null}
            onDecide={decide}
            onSelectRepresentative={selectRepresentative}
          />
        ))}
      </ReviewSection>

      {/* 2. 통역장비 유사 중복 후보 */}
      <ReviewSection title="2. 통역장비 유사 중복 후보" count={equipSimilarGroups.length} color="#d97706">
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "#6b7280" }}>
          이름 패턴이 유사한 장비 상품 그룹 — merge 전 검수용. 대표 상품 선택 후 액션을 결정하세요.
        </p>
        {equipSimilarGroups.map((g, i) => (
          <ReviewableGroup
            key={i}
            groupKey={`equip:${i}`}
            members={g.members}
            groupLabel={g.label}
            decision={getDecision(`equip:${i}`)}
            representative={representatives.get(`equip:${i}`) ?? null}
            onDecide={decide}
            onSelectRepresentative={selectRepresentative}
          />
        ))}
      </ReviewSection>

      {/* 3. Legacy naming 후보 */}
      <ReviewSection title="3. Legacy naming 후보 (약어 언어쌍)" count={legacyCandidates.length} color="#7c3aed">
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "#6b7280" }}>
          "한영 번역" 형식 약어 언어쌍 감지 — canonical 형식: "한국어-영어 번역"
        </p>
        {legacyCandidates.map(({ product: p, canonical }) => (
          <ReviewableRow
            key={p.id}
            decisionKey={`legacy:${p.id}`}
            p={p}
            proposal={canonical}
            decision={getDecision(`legacy:${p.id}`)}
            onDecide={decide}
          />
        ))}
      </ReviewSection>

      {/* 4. 운영/실비 normalize 후보 */}
      <ReviewSection title="4. 운영/실비 normalize 후보" count={opsCandidates.length} color="#0f766e">
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "#6b7280" }}>
          normalize 규칙과 불일치 — 실제 변경은 다음 단계에서 진행합니다.
        </p>
        {opsCandidates.map(({ product: p, normalizedTo, category }) => (
          <ReviewableRow
            key={p.id}
            decisionKey={`ops:${p.id}`}
            p={p}
            proposal={normalizedTo}
            proposalNote={category}
            decision={getDecision(`ops:${p.id}`)}
            onDecide={decide}
          />
        ))}
      </ReviewSection>

      {/* 5. Canonical naming 불일치 후보 */}
      <ReviewSection title="5. Canonical naming 불일치 후보" count={canonCandidates.length} color="#2563eb">
        <p style={{ margin: "0 0 10px", fontSize: 11, color: "#6b7280" }}>
          언어쌍 상품 중 canonical 형식("언어-언어 서비스명")과 다른 이름 — 변경은 다음 단계에서 진행합니다.
        </p>
        {canonCandidates.map(({ product: p, canonical }) => (
          <ReviewableRow
            key={p.id}
            decisionKey={`canon:${p.id}`}
            p={p}
            proposal={canonical}
            decision={getDecision(`canon:${p.id}`)}
            onDecide={decide}
          />
        ))}
      </ReviewSection>
    </div>
  );
}
