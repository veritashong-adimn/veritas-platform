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
  // 통번역 계열
  "통번역",
  "출장통번역",   "전시회통번역", "상담회통번역", "IR통번역",
  // 감수 계열
  "감수",
  "원어민감수",   "AI감수",
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
  "번역":       { productType: "translation",    mainCategory: "일반번역",    canonicalPrefix: "TR",        unit: "페이지" },
  "일반번역":   { productType: "translation",    mainCategory: "일반번역",    canonicalPrefix: "TR",        unit: "페이지" },
  "전문번역":   { productType: "translation",    mainCategory: "전문번역",    canonicalPrefix: "TR:spec",   unit: "페이지" },
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

  // ─── 통번역 계열 ──────────────────────────────────────────────────────────
  "통번역":       { productType: "combined",       mainCategory: "일반번역",    canonicalPrefix: "CO:general",   unit: "건" },
  "출장통번역":   { productType: "combined",       mainCategory: "출장통번역",  canonicalPrefix: "CO:biz",       unit: "건" },
  "전시회통번역": { productType: "combined",       mainCategory: "전시회통번역",canonicalPrefix: "CO:expo",      unit: "건" },
  "상담회통번역": { productType: "combined",       mainCategory: "상담회통번역",canonicalPrefix: "CO:mtg",       unit: "건" },
  "IR통번역":    { productType: "combined",       mainCategory: "IR통번역",    canonicalPrefix: "CO:ir",        unit: "건" },

  // ─── 감수 계열 ─────────────────────────────────────────────────────────────
  "감수":       { productType: "proofreading",   mainCategory: "감수",        canonicalPrefix: "PR",       unit: "페이지" },
  "원어민감수": { productType: "proofreading",   mainCategory: "원어민감수",  canonicalPrefix: "PR:nat",   unit: "페이지" },
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

export function buildCanonicalKey(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
): string {
  const cfg = LAZY_SERVICE_CONFIG[serviceType];
  const { canonicalPrefix, productType } = cfg;
  const src = normalizeZhForCanonical(sourceLanguage.toLowerCase().trim(), productType);
  const tgt = normalizeZhForCanonical(targetLanguage.toLowerCase().trim(), productType);
  return `${canonicalPrefix}:${src}:${tgt}`;
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
};

export function buildVirtualProduct(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
  isoLabel: Record<string, string>,
): VirtualProduct {
  const cfg = LAZY_SERVICE_CONFIG[serviceType];
  const normSrc = normalizeZhForCanonical(sourceLanguage.toLowerCase().trim(), cfg.productType);
  const normTgt = normalizeZhForCanonical(targetLanguage.toLowerCase().trim(), cfg.productType);
  return {
    isVirtual: true,
    displayName: buildLazyDisplayName(serviceType, normSrc, normTgt, isoLabel),
    productType: cfg.productType,
    mainCategory: cfg.mainCategory,
    serviceType,
    sourceLanguage: normSrc,
    targetLanguage: normTgt,
    canonicalKey: buildCanonicalKey(serviceType, normSrc, normTgt),
    unit: cfg.unit,
    creationSource: "lazy_product_generation",
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
  };
}
