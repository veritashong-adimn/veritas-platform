/**
 * Lazy Product Generation — 유틸리티
 *
 * 상품 마스터에 미리 등록하지 않고, 실제 필요한 시점에만 상품을 생성한다.
 * canonicalKey 기반 중복 방지.
 *
 * MVP 대상 서비스 타입: 번역, 순차통역, 동시통역, 상담회통역
 */

// ─── MVP 서비스 타입 ─────────────────────────────────────────────────────────
export const LAZY_SERVICE_TYPES = ["번역", "순차통역", "동시통역", "상담회통역"] as const;
export type LazyServiceType = typeof LAZY_SERVICE_TYPES[number];

export function isLazyServiceType(s: string): s is LazyServiceType {
  return (LAZY_SERVICE_TYPES as readonly string[]).includes(s);
}

// ─── 서비스 타입 → 상품 구조 매핑 ───────────────────────────────────────────
export type LazyServiceConfig = {
  productType: string;
  mainCategory: string;
  canonicalPrefix: string; // canonicalKey 앞부분
  unit: string;
};

export const LAZY_SERVICE_CONFIG: Record<LazyServiceType, LazyServiceConfig> = {
  "번역": {
    productType: "translation",
    mainCategory: "일반번역",
    canonicalPrefix: "TR",
    unit: "페이지",
  },
  "순차통역": {
    productType: "interpretation",
    mainCategory: "순차통역",
    canonicalPrefix: "IN:consecutive",
    unit: "1시간",
  },
  "동시통역": {
    productType: "interpretation",
    mainCategory: "동시통역",
    canonicalPrefix: "IN:simultaneous",
    unit: "1시간",
  },
  "상담회통역": {
    // DB 대분류: "미팅통역" (MAIN_CATEGORIES_BY_TYPE interpretation 참조)
    productType: "interpretation",
    mainCategory: "미팅통역",
    canonicalPrefix: "IN:business_meeting",
    unit: "1시간",
  },
};

// ─── canonicalKey 생성 ────────────────────────────────────────────────────────
/**
 * 중복 방지 키. 방향 포함 (ko:en ≠ en:ko).
 * 예: "TR:ko:en", "IN:consecutive:ko:en", "IN:business_meeting:ko:en"
 */
export function buildCanonicalKey(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
): string {
  const { canonicalPrefix } = LAZY_SERVICE_CONFIG[serviceType];
  const src = sourceLanguage.toLowerCase().trim();
  const tgt = targetLanguage.toLowerCase().trim();
  return `${canonicalPrefix}:${src}:${tgt}`;
}

// ─── displayName 생성 ─────────────────────────────────────────────────────────
/**
 * isoLabel: products.ts 의 ISO_LABEL 맵을 전달 (circular import 방지)
 * 예: buildDisplayName("순차통역", "ko", "en", ISO_LABEL) → "한국어-영어 순차통역"
 */
export function buildLazyDisplayName(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
  isoLabel: Record<string, string>,
): string {
  const srcLabel = isoLabel[sourceLanguage] ?? sourceLanguage;
  const tgtLabel = isoLabel[targetLanguage] ?? targetLanguage;
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

/**
 * DB에 없는 경우 생성되는 가상 상품 후보.
 * 저장 시점까지 DB에 기록하지 않는다.
 */
export function buildVirtualProduct(
  serviceType: LazyServiceType,
  sourceLanguage: string,
  targetLanguage: string,
  isoLabel: Record<string, string>,
): VirtualProduct {
  const cfg = LAZY_SERVICE_CONFIG[serviceType];
  return {
    isVirtual: true,
    displayName: buildLazyDisplayName(serviceType, sourceLanguage, targetLanguage, isoLabel),
    productType: cfg.productType,
    mainCategory: cfg.mainCategory,
    serviceType,
    sourceLanguage: sourceLanguage.toLowerCase().trim(),
    targetLanguage: targetLanguage.toLowerCase().trim(),
    canonicalKey: buildCanonicalKey(serviceType, sourceLanguage, targetLanguage),
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
