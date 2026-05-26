// ─── Review Reason Constants ──────────────────────────────────────────────────
// 운영자가 review 이유를 즉시 이해할 수 있도록 세분화된 코드 체계
// 추가 시 이 파일에만 선언하고 products.ts에서 import해서 사용

export const REVIEW_REASONS = {
  // ── 기존 ──────────────────────────────────────────────────────────────────
  MISSING_DIRECTION:          "MISSING_DIRECTION",
  UNKNOWN_LANGUAGE:           "UNKNOWN_LANGUAGE",
  ZH_AMBIGUOUS:               "ZH_AMBIGUOUS",
  CANTONESE_REVIEW:           "CANTONESE_REVIEW",
  COUNTRY_NOT_LANGUAGE:       "COUNTRY_NOT_LANGUAGE",
  REGION_LANGUAGE_AMBIGUOUS:  "REGION_LANGUAGE_AMBIGUOUS",
  DOMAIN_BASED:               "DOMAIN_BASED",
  MULTI_LANGUAGE_AMBIGUOUS:   "MULTI_LANGUAGE_AMBIGUOUS",
  DOMAIN_SPECIALIZED_REVIEW:  "DOMAIN_SPECIALIZED_REVIEW",

  // ── 신규 ──────────────────────────────────────────────────────────────────
  // 업계 compact 약어 패턴 (한영, 태한 등) — 정보성, 페널티 없음
  COMPACT_DIRECTION_PATTERN:  "COMPACT_DIRECTION_PATTERN",
  // 국가명이 언어명으로 쓰인 경우 (파키스탄어=우르두어) — 정보성, 페널티 없음
  COUNTRY_LANGUAGE_ALIAS:     "COUNTRY_LANGUAGE_ALIAS",
  // 언어 코드가 모호한 경우 (중 → zh-hans? zh-hant?)
  AMBIGUOUS_LANGUAGE:         "AMBIGUOUS_LANGUAGE",
  // 복수 언어 감지된 경우
  MULTI_LANGUAGE_DETECTED:    "MULTI_LANGUAGE_DETECTED",
  // 미등록 약어
  UNKNOWN_ABBREVIATION:       "UNKNOWN_ABBREVIATION",
  // 언어 감수 필요
  REVIEW_REQUIRED_LANGUAGE:   "REVIEW_REQUIRED_LANGUAGE",
} as const;

export type ReviewReason = typeof REVIEW_REASONS[keyof typeof REVIEW_REASONS];

// confidence 계산 시 페널티 제외 대상 (정보성 사유)
export const NON_PENALTY_REASONS = new Set<string>([
  REVIEW_REASONS.COMPACT_DIRECTION_PATTERN,
  REVIEW_REASONS.COUNTRY_LANGUAGE_ALIAS,
]);
