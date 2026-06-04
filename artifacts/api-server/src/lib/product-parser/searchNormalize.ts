/**
 * Product Search Normalize Layer
 *
 * parser/canonicalization 원본 로직을 변경하지 않고,
 * 검색 전용 normalize layer로 축약 검색어를 표준형으로 확장한다.
 *
 * 예: "영한번역" → ["영한번역", "영어-한국어 번역", "영어한국어번역"]
 *     "인한통역" → ["인한통역", "인도네시아어-한국어 통역", ...]
 */

// ─── 단일자 언어 축약어 → 풀 한국어 레이블 ─────────────────────────────────────
// 운영 현장에서 실제로 쓰이는 축약 표기 기준 (B2B 통번역 업계 관용)
export const SEARCH_LANG_ABBR: Record<string, string> = {
  영: "영어",
  한: "한국어",
  일: "일본어",
  중: "중국어",
  불: "프랑스어",  // 불어(佛語)
  독: "독일어",
  서: "스페인어",  // 서어(西語) / 서반아어
  러: "러시아어",
  아: "아랍어",
  포: "포르투갈어", // 포어(葡語)
  태: "태국어",
  베: "베트남어",
  몽: "몽골어",
  인: "인도네시아어", // 인니어(印尼語) 계열
  터: "튀르키예어",
  말: "말레이어",
  힌: "힌디어",
  광: "광동어",
};

// ─── 다자 언어 별칭 → 풀 레이블 ────────────────────────────────────────────────
// 2자 이상 축약/별칭. normalizeSearchQuery 에서 단자 분리 전에 먼저 시도한다.
export const SEARCH_LANG_MULTI: Record<string, string> = {
  인니: "인도네시아어",
  인도네시아: "인도네시아어",
  광동: "광동어",
  간체: "중국어(간체)",
  번체: "중국어(번체)",
  중간: "중국어(간체)",  // 중국어간체 축약
  중번: "중국어(번체)",  // 중국어번체 축약
  한글: "한국어",
  국문: "한국어",
  영문: "영어",
  일문: "일본어",
  불어: "프랑스어",
  독어: "독일어",
  포어: "포르투갈어",
  서어: "스페인어",
  서반아어: "스페인어",
};

// ─── 서비스 타입 (긴 것 우선 — 접두어 오탐 방지) ────────────────────────────
export const SERVICE_TYPES = [
  "동시통역",
  "순차통역",
  "위스퍼링통역",
  "수행통역",
  "전화통역",
  "영상통역",
  "원어민감수",
  "번역",
  "통역",
  "감수",
  "교정",
  "검수",
  "자막",
  "DTP",
] as const;

export type ServiceType = typeof SERVICE_TYPES[number];

// ─── ISO 코드 → 첫 글자 축약 ────────────────────────────────────────────────────
// 괄호 qualifier 제거: "중국어(간체)" → "중국어" → "중"
function firstChar(label: string): string {
  return label.replace(/\(.*?\)/, "").trim().charAt(0);
}

/**
 * 상품 1건의 검색 텍스트를 생성한다.
 *
 * - 기존 필드(name, code, mainCategory, subCategory, sourceLanguage, targetLanguage) 포함
 * - 언어 레이블 풀네임 포함: "영어", "한국어"
 * - 축약 페어 포함: "영한번역", "한영번역"
 * - 무구분자 합성형 포함: "영어한국어번역"
 *
 * isoLabel: products.ts의 ISO_LABEL 맵을 그대로 전달 (circular import 방지)
 */
export function buildProductSearchText(
  product: {
    name: string;
    code: string;
    mainCategory: string | null;
    subCategory: string | null;
    sourceLanguage: string | null;
    targetLanguage: string | null;
  },
  isoLabel: Record<string, string>,
): string {
  const parts: string[] = [
    product.name,
    product.code,
    product.mainCategory ?? "",
    product.subCategory ?? "",
    product.sourceLanguage ?? "",
    product.targetLanguage ?? "",
  ];

  const srcCode = product.sourceLanguage ?? "";
  const tgtCode = product.targetLanguage ?? "";

  if (srcCode && tgtCode) {
    const srcLabel = isoLabel[srcCode] ?? "";
    const tgtLabel = isoLabel[tgtCode] ?? "";

    if (srcLabel && tgtLabel) {
      parts.push(srcLabel);
      parts.push(tgtLabel);
      // 무구분자 합성형: "영어한국어"
      parts.push(`${srcLabel}${tgtLabel}`);

      // 축약 첫글자
      const srcA = firstChar(srcLabel);
      const tgtA = firstChar(tgtLabel);

      if (srcA && tgtA) {
        // 상품명에서 서비스 타입을 감지해 축약 페어 생성
        for (const st of SERVICE_TYPES) {
          if (product.name.includes(st)) {
            // "영한번역", "한영번역" 등
            parts.push(`${srcA}${tgtA}${st}`);
            // "영어한국어번역" (풀네임 + 서비스타입 무구분자)
            parts.push(`${srcLabel}${tgtLabel}${st}`);
            // "영어-한국어번역" (하이픈 있으나 공백 없는 형태)
            parts.push(`${srcLabel}-${tgtLabel}${st}`);
            break;
          }
        }

        // 서비스 타입 감지 없이도 축약 페어 자체를 추가 (코드 검색용)
        parts.push(`${srcA}${tgtA}`);
      }
    }
  }

  return parts.filter(Boolean).join(" ").toLowerCase();
}

/**
 * 사용자 입력 검색어를 후보 검색 문자열 배열로 확장한다.
 *
 * 전략:
 * 1. 원본 그대로 포함
 * 2. 서비스 타입이 뒤에 붙은 경우, 언어 파트를 단자/다자 축약어로 분리하여 표준형 생성
 * 3. 공백/하이픈 제거 정규화 추가
 *
 * 예:
 *   "영한번역"   → ["영한번역", "영어-한국어 번역", "영어한국어번역"]
 *   "인한통역"   → ["인한통역", "인도네시아어-한국어 통역", ...]
 *   "영어한국어" → ["영어한국어", "영어-한국어", ...]
 */
export function normalizeSearchQuery(query: string): string[] {
  const raw = query.trim();
  if (!raw) return [];

  const q = raw.toLowerCase();
  const candidates = new Set<string>([q]);

  // 공백/하이픈 제거 버전도 항상 포함
  const stripped = q.replace(/[\s\-]/g, "");
  if (stripped !== q) candidates.add(stripped);

  // ─── 서비스 타입 분리 ────────────────────────────────────────────────────
  let serviceType = "";
  let langPart = q;

  for (const st of SERVICE_TYPES) {
    const stLower = st.toLowerCase();
    if (q.endsWith(stLower)) {
      serviceType = st;
      langPart = q.slice(0, q.length - stLower.length).trim();
      break;
    }
  }

  if (!langPart) return [...candidates];

  // ─── 다자 별칭 우선 분리 시도 ─────────────────────────────────────────────
  // "인니한번역" → "인니" + "한" 분리
  function expandLangPart(part: string): string[] {
    const results: string[] = [];

    // 다자 별칭 먼저 시도 (긴 것 우선)
    const multiKeys = Object.keys(SEARCH_LANG_MULTI).sort((a, b) => b.length - a.length);
    for (const key of multiKeys) {
      if (part.startsWith(key)) {
        const rest = part.slice(key.length);
        const label1 = SEARCH_LANG_MULTI[key];
        // rest를 단자 또는 다자로 해석
        const label2 =
          SEARCH_LANG_ABBR[rest] ??
          SEARCH_LANG_MULTI[rest] ??
          (rest.length === 0 ? "" : null);
        if (label2 !== null) {
          results.push(`${label1}::${label2}`);
        }
      }
      if (part.endsWith(key)) {
        const rest = part.slice(0, part.length - key.length);
        const label2 = SEARCH_LANG_MULTI[key];
        const label1 =
          SEARCH_LANG_ABBR[rest] ??
          SEARCH_LANG_MULTI[rest] ??
          (rest.length === 0 ? "" : null);
        if (label1 !== null) {
          results.push(`${label1}::${label2}`);
        }
      }
    }

    // 단자 분리: 남은 langPart를 1~3자씩 나눠 두 언어로 해석
    for (let i = 1; i <= Math.min(3, part.length - 1); i++) {
      const p1 = part.slice(0, i);
      const p2 = part.slice(i);
      const l1 = SEARCH_LANG_ABBR[p1] ?? SEARCH_LANG_MULTI[p1];
      const l2 = SEARCH_LANG_ABBR[p2] ?? SEARCH_LANG_MULTI[p2];
      if (l1 && l2) results.push(`${l1}::${l2}`);
    }

    return results;
  }

  const langPairs = expandLangPart(langPart);

  for (const pair of langPairs) {
    const [l1, l2] = pair.split("::");
    if (!l1 || l2 === undefined) continue;

    if (serviceType) {
      // "영어-한국어 번역" 형태 (표준 displayName) — 방향 안전
      candidates.add(`${l1}-${l2} ${serviceType}`.toLowerCase());
      // "영어한국어번역" 형태 (무구분자) — 방향 안전
      candidates.add(`${l1}${l2}${serviceType}`.toLowerCase());
      // 공백 구분 "영어 한국어 번역" 은 추가하지 않음:
      // "한국어 영어 한국어영어" 같은 searchText에서 역방향 부분 일치 오탐 발생
    }

    // 언어 페어만 — 하이픈/무구분자만 사용 (방향 안전)
    // 공백 구분자 "영어 한국어" 는 제외: "영어 한국어영어" 내 substring 오탐
    candidates.add(`${l1}-${l2}`.toLowerCase());
    candidates.add(`${l1}${l2}`.toLowerCase());
  }

  // ─── 서비스 타입 없이 언어 전체가 축약어인 경우 ──────────────────────────
  if (!serviceType) {
    const singleLabel = SEARCH_LANG_ABBR[langPart] ?? SEARCH_LANG_MULTI[langPart];
    if (singleLabel) {
      candidates.add(singleLabel.toLowerCase());
    }
  }

  return [...candidates].filter(Boolean);
}
