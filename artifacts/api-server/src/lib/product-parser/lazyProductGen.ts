/**
 * Lazy Product Generation — 유틸리티
 *
 * 상품 마스터에 미리 등록하지 않고, 실제 필요한 시점에만 상품을 생성한다.
 * canonicalKey 기반 중복 방지.
 */

// ─── 서비스 타입 ─────────────────────────────────────────────────────────────
export const LAZY_SERVICE_TYPES = [
  // 번역 계열
  "번역",         "일반번역",
  "전문번역",     "출판번역",
  "번역공증",     "영상번역",   "자막번역",   "SW번역",
  // 통역 계열
  "동시통역",     "위스퍼링통역",
  "순차통역",     "수행통역",   "상담회통역",
  "다국어릴레이",
  // 통번역 계열
  "통번역",
  "출장통번역",   "전시회통번역", "상담회통번역", "IR통번역",
  // 감수 계열
  "감수",
  "원어민감수",   "원문대조감수",   "AI감수",
  // 하위호환 (기존 quick panel / 외부 API 호출)
  "통역",         "일반통역",
] as const;
export type LazyServiceType = typeof LAZY_SERVICE_TYPES[number];

export function isLazyServiceType(s: string): s is LazyServiceType {
  return (LAZY_SERVICE_TYPES as readonly string[]).includes(s);
}

// ─── 서비스 타입 → 상품 구조 매핑 ───────────────────────────────────────────
export type LazyServiceConfig = {
  productType: string;
  mainCategory: string;
  canonicalPrefix: string;
  unit: string;
};

export const LAZY_SERVICE_CONFIG: Record<LazyServiceType, LazyServiceConfig> = {
  // ─── 번역 계열 ─────────────────────────────────────────────────────────────
  "번역":       { productType: "translation",    mainCategory: "번역",        canonicalPrefix: "TR",        unit: "페이지" },
  "일반번역":   { productType: "translation",    mainCategory: "번역",        canonicalPrefix: "TR",        unit: "페이지" },
  "전문번역":   { productType: "translation",    mainCategory: "번역",        canonicalPrefix: "TR",        unit: "페이지" },
  "출판번역":   { productType: "translation",    mainCategory: "출판번역",    canonicalPrefix: "TR:pub",    unit: "페이지" },
  "번역공증":   { productType: "translation",    mainCategory: "번역공증",    canonicalPrefix: "TR:cert",   unit: "건" },
  "영상번역":   { productType: "translation",    mainCategory: "영상번역",    canonicalPrefix: "TR:vid",    unit: "분" },
  "자막번역":   { productType: "translation",    mainCategory: "자막번역",    canonicalPrefix: "TR:sub",    unit: "분" },
  "SW번역":     { productType: "translation",    mainCategory: "SW번역",      canonicalPrefix: "TR:sw",     unit: "건" },

  // ─── 통역 계열 ─────────────────────────────────────────────────────────────
  "동시통역":    { productType: "interpretation", mainCategory: "동시통역",    canonicalPrefix: "IN:simultaneous",    unit: "1시간" },
  "위스퍼링통역":{ productType: "interpretation", mainCategory: "위스퍼링통역",canonicalPrefix: "IN:whispering",      unit: "1시간" },
  "순차통역":    { productType: "interpretation", mainCategory: "순차통역",    canonicalPrefix: "IN:consecutive",     unit: "1시간" },
  "수행통역":    { productType: "interpretation", mainCategory: "수행통역",    canonicalPrefix: "IN:escort",          unit: "1시간" },
  "상담회통역":  { productType: "interpretation", mainCategory: "미팅통역",    canonicalPrefix: "IN:business_meeting",unit: "1시간" },
  "다국어릴레이":{ productType: "interpretation", mainCategory: "다국어릴레이",canonicalPrefix: "IN:relay",           unit: "1시간" },

  // ─── 통번역 계열 ──────────────────────────────────────────────────────────
  "통번역":       { productType: "combined",       mainCategory: "번역",        canonicalPrefix: "CO:general",   unit: "건" },
  "출장통번역":   { productType: "combined",       mainCategory: "출장통번역",  canonicalPrefix: "CO:biz",       unit: "건" },
  "전시회통번역": { productType: "combined",       mainCategory: "전시회통번역",canonicalPrefix: "CO:expo",      unit: "건" },
  "상담회통번역": { productType: "combined",       mainCategory: "상담회통번역",canonicalPrefix: "CO:mtg",       unit: "건" },
  "IR통번역":    { productType: "combined",       mainCategory: "IR통번역",    canonicalPrefix: "CO:ir",        unit: "건" },

  // ─── 감수 계열 ─────────────────────────────────────────────────────────────
  "감수":       { productType: "proofreading",   mainCategory: "감수",        canonicalPrefix: "PR",       unit: "페이지" },
  "원어민감수": { productType: "proofreading",   mainCategory: "원어민감수",  canonicalPrefix: "PR:native-review", unit: "페이지" },
  "원문대조감수":{ productType: "proofreading",   mainCategory: "원문대조감수",canonicalPrefix: "PR:comp",  unit: "페이지" },
  "AI감수":    { productType: "proofreading",   mainCategory: "AI감수",      canonicalPrefix: "PR:ai",    unit: "페이지" },

  // ─── 하위호환 ─────────────────────────────────────────────────────────────
  "통역":       { productType: "interpretation", mainCategory: "일반통역",    canonicalPrefix: "IN:general",   unit: "1시간" },
  "일반통역":   { productType: "interpretation", mainCategory: "일반통역",    canonicalPrefix: "IN:general",   unit: "1시간" },
};

// ─── canonicalKey 생성 ────────────────────────────────────────────────────────
/**
 * 통역/통번역: zh-hans/zh-hant → zh (spoken language 기준)
 * 번역/감수:   zh → zh-hans (script variant 유지)
 */
function normalizeZhForCanonical(code: string, productType: string): string {
  if (productType === "interpretation" || productType === "combined") {
    if (code === "zh-hans" || code === "zh-hant" || code === "zh") return "zh";
  } else {
    if (code === "zh") return "zh-hans";
  }
  return code;
}

/**
 * 릴레이 대상언어 정규화 — 소문자·trim·zh 정규화 후 중복 제거, **알파벳 오름차순 정렬**.
 * 입력 순서와 무관하게 동일 조합이면 항상 동일한 결과를 반환한다.
 * (예: [zh, en, ja] → ["en","ja","zh"])
 */
export function normalizeRelayTargets(targetLanguages: string[], productType: string): string[] {
  const set = new Set<string>();
  for (const t of targetLanguages ?? []) {
    const n = normalizeZhForCanonical(String(t ?? "").toLowerCase().trim(), productType);
    if (n) set.add(n);
  }
  return Array.from(set).sort();
}

export function buildCanonicalKey(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
  targetLanguages?: string[],
): string {
  const cfg = LAZY_SERVICE_CONFIG[serviceType];
  const { canonicalPrefix, productType } = cfg;
  const src = normalizeZhForCanonical(sourceLanguage.toLowerCase().trim(), productType);
  const tgt = normalizeZhForCanonical(targetLanguage.toLowerCase().trim(), productType);
  const base = `${canonicalPrefix}:${src}:${tgt}`;
  // 릴레이: 대상언어 조합을 정렬·결합하여 키에 포함 → 조합이 다르면 다른 상품
  // 예) IN:relay:de:ko:en-ja-zh
  if (targetLanguages && targetLanguages.length > 0) {
    const norm = normalizeRelayTargets(targetLanguages, productType);
    if (norm.length > 0) return `${base}:${norm.join("-")}`;
  }
  return base;
}

// ─── displayName 생성 ─────────────────────────────────────────────────────────
export function buildLazyDisplayName(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
  isoLabel: Record<string, string>,
): string {
  const cfg = LAZY_SERVICE_CONFIG[serviceType];
  const normSrc = normalizeZhForCanonical(sourceLanguage, cfg.productType);
  const normTgt = normalizeZhForCanonical(targetLanguage, cfg.productType);
  const srcLabel = isoLabel[normSrc] ?? sourceLanguage;
  const tgtLabel = isoLabel[normTgt] ?? targetLanguage;
  return `${srcLabel}-${tgtLabel} ${serviceType}`;
}

/**
 * 릴레이 displayName — "출발언어 → 기준언어 → 대상언어1·대상언어2… 다국어릴레이"
 * 예) 독일어 → 한국어 → 영어·일본어·중국어 다국어릴레이
 */
export function buildRelayDisplayName(
  sourceLanguage: string,
  pivotLanguage: string,
  targetLanguages: string[],
  isoLabel: Record<string, string>,
): string {
  const norm = (c: string) => normalizeZhForCanonical(c.toLowerCase().trim(), "interpretation");
  const label = (c: string) => isoLabel[norm(c)] ?? c;
  const srcLabel = label(sourceLanguage);
  const pivotLabel = label(pivotLanguage);
  const tgtLabels = normalizeRelayTargets(targetLanguages, "interpretation").map(c => isoLabel[c] ?? c);
  return `${srcLabel} → ${pivotLabel} → ${tgtLabels.join("·")} 다국어릴레이`;
}

/**
 * 원어민감수 displayName —
 *  · single: "영어 원어민감수" (감수언어 1개)
 *  · pair:   "한국어→영어 원어민감수" (출발→도착, 화살표 표기)
 */
export function buildNativeReviewDisplayName(
  mode: "single" | "pair",
  sourceLanguage: string,
  targetLanguage: string,
  reviewLanguage: string,
  isoLabel: Record<string, string>,
): string {
  const label = (c: string) => {
    const n = normalizeZhForCanonical(c.toLowerCase().trim(), "proofreading");
    return isoLabel[n] ?? c;
  };
  if (mode === "single") return `${label(reviewLanguage)} 원어민감수`;
  return `${label(sourceLanguage)}→${label(targetLanguage)} 원어민감수`;
}

// ─── 릴레이 언어 구성 ─────────────────────────────────────────────────────────
// (lib/db RelayLanguages 와 동일 shape — 서버/DB 경계에서 재선언하여 결합도 최소화)
export type RelayLanguages = {
  sourceLanguage: string;
  pivotLanguage: string;
  targetLanguages: string[];
};

// ─── 원어민감수 언어 방식 ─────────────────────────────────────────────────────
export type NativeReviewMode = "single" | "pair";
export type NativeReviewInput = {
  mode: NativeReviewMode;
  reviewLanguage?: string; // single 전용
};

// ─── VirtualProduct 타입 ─────────────────────────────────────────────────────
export type VirtualProduct = {
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
  relayLanguages?: RelayLanguages;
  reviewLanguageMode?: NativeReviewMode;
  reviewLanguage?: string;
};

export function buildVirtualProduct(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
  isoLabel: Record<string, string>,
  targetLanguages?: string[],
  nativeReview?: NativeReviewInput,
): VirtualProduct {
  const cfg = LAZY_SERVICE_CONFIG[serviceType];
  const normSrc = normalizeZhForCanonical(sourceLanguage.toLowerCase().trim(), cfg.productType);
  const normTgt = normalizeZhForCanonical(targetLanguage.toLowerCase().trim(), cfg.productType);

  // ── 원어민감수: 단일언어 / 언어쌍 방식 분기 ──
  if (nativeReview) {
    if (nativeReview.mode === "single") {
      const rl = normalizeZhForCanonical((nativeReview.reviewLanguage ?? "").toLowerCase().trim(), cfg.productType);
      return {
        isVirtual: true,
        displayName: buildNativeReviewDisplayName("single", "", "", rl, isoLabel),
        productType: cfg.productType,
        mainCategory: cfg.mainCategory,
        serviceType,
        sourceLanguage: "",   // 단일언어는 출발/도착 미사용 (null 저장)
        targetLanguage: "",
        canonicalKey: `${cfg.canonicalPrefix}:${rl}`,   // 예) PR:native-review:en
        unit: cfg.unit,
        creationSource: "lazy_product_generation",
        reviewLanguageMode: "single",
        reviewLanguage: rl,
      };
    }
    // pair: 출발→도착 (canonicalKey는 기존 규칙 = PR:native-review:ko:en)
    return {
      isVirtual: true,
      displayName: buildNativeReviewDisplayName("pair", normSrc, normTgt, "", isoLabel),
      productType: cfg.productType,
      mainCategory: cfg.mainCategory,
      serviceType,
      sourceLanguage: normSrc,
      targetLanguage: normTgt,
      canonicalKey: buildCanonicalKey(serviceType, normSrc, normTgt),
      unit: cfg.unit,
      creationSource: "lazy_product_generation",
      reviewLanguageMode: "pair",
    };
  }

  // 릴레이: 대상언어(복수) 포함. sourceLanguage=출발, targetLanguage=기준(Pivot).
  const isRelay = Array.isArray(targetLanguages) && targetLanguages.length > 0;
  const normTargets = isRelay ? normalizeRelayTargets(targetLanguages!, cfg.productType) : [];

  return {
    isVirtual: true,
    displayName: isRelay
      ? buildRelayDisplayName(normSrc, normTgt, normTargets, isoLabel)
      : buildLazyDisplayName(serviceType, normSrc, normTgt, isoLabel),
    productType: cfg.productType,
    mainCategory: cfg.mainCategory,
    serviceType,
    sourceLanguage: normSrc,
    targetLanguage: normTgt,
    canonicalKey: buildCanonicalKey(serviceType, normSrc, normTgt, isRelay ? normTargets : undefined),
    unit: cfg.unit,
    creationSource: "lazy_product_generation",
    ...(isRelay
      ? { relayLanguages: { sourceLanguage: normSrc, pivotLanguage: normTgt, targetLanguages: normTargets } }
      : {}),
  };
}

// ─── Audit metadata ──────────────────────────────────────────────────────────
export type LazyCreationAudit = {
  createdBy: string;
  creationSource: "lazy_product_generation";
  serviceType: LazyServiceType;
  sourceLanguage: string;
  targetLanguage: string;
  canonicalKey: string;
  relayLanguages?: RelayLanguages;
  reviewLanguageMode?: NativeReviewMode;
  reviewLanguage?: string;
};

export function buildAuditMetadata(
  virtual: VirtualProduct,
  createdBy: string,
): LazyCreationAudit {
  return {
    createdBy,
    creationSource: "lazy_product_generation",
    serviceType: virtual.serviceType,
    sourceLanguage: virtual.sourceLanguage,
    targetLanguage: virtual.targetLanguage,
    canonicalKey: virtual.canonicalKey,
    ...(virtual.relayLanguages ? { relayLanguages: virtual.relayLanguages } : {}),
    ...(virtual.reviewLanguageMode ? { reviewLanguageMode: virtual.reviewLanguageMode } : {}),
    ...(virtual.reviewLanguage ? { reviewLanguage: virtual.reviewLanguage } : {}),
  };
}
