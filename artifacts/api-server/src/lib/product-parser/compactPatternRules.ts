// ─── Compact Pattern Rules ────────────────────────────────────────────────────
// 업계 관용 compact 2-char 언어쌍 패턴 전처리기
//
// 문제: "한영번역" 등 compact 패턴은 separator가 없어 LANG_ENTRIES SEP_RX 가드를 통과 못함
// 해결: Step 0.5에서 미리 ISO pair 형식으로 expand → 이후 기존 파서가 정상 처리
//
// 적용 범위: translation/interpretation 서비스 문맥에서만 (전역 적용 금지)
// 예) 한영번역 → ko→en 번역,  태한번역 → th→ko 번역,  한터번역 → ko→tr 번역

import { COMPACT_SINGLE_CHAR_MAP, COMPACT_SERVICE_KEYWORDS } from "./languageAliasRegistry";

export type CompactExpansion = {
  expanded: string;
  srcCode: string;
  tgtCode: string;
  srcChar: string;
  tgtChar: string;
  serviceKeyword: string;
};

// 런타임에 한 번만 빌드 (모듈 로드 시)
const COMPACT_CHARS = Object.keys(COMPACT_SINGLE_CHAR_MAP).join("");
const SERVICE_ALT   = [...COMPACT_SERVICE_KEYWORDS].join("|");

// ^ [src] [tgt] (service) (rest)?
// 한영번역 → m[1]="한" m[2]="영" m[3]="번역" m[4]=""
const COMPACT_RX = new RegExp(
  `^([${COMPACT_CHARS}])([${COMPACT_CHARS}])(${SERVICE_ALT})(.*)$`
);

export function expandCompactPattern(name: string): CompactExpansion | null {
  const m = name.match(COMPACT_RX);
  if (!m) return null;

  const srcCode = COMPACT_SINGLE_CHAR_MAP[m[1]];
  const tgtCode = COMPACT_SINGLE_CHAR_MAP[m[2]];

  // 같은 언어 쌍이면 패턴 아님 (예: 한한번역 → 무효)
  if (!srcCode || !tgtCode || srcCode === tgtCode) return null;

  const service = m[3];
  const rest    = m[4] ? ` ${m[4].trim()}` : "";

  return {
    expanded:       `${srcCode}→${tgtCode} ${service}${rest}`.trim(),
    srcCode,
    tgtCode,
    srcChar:        m[1],
    tgtChar:        m[2],
    serviceKeyword: service,
  };
}
