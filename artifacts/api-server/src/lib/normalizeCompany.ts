// ─── 기업명 정규화(Alias 검색·중복판정·향후 자동매칭 공용) ──────────────────────
// 동일 회사가 다양한 표기로 기록되는 문제를 흡수하기 위해, 법인표기(한글·라틴)와
// 공백·구두점을 제거하고 소문자화한 "정규화 키"를 만든다.
//   ㈜베리타스        → 베리타스
//   주식회사 베리타스   → 베리타스
//   (사)대한병원협회    → 대한병원협회
//   VERITAS / Veritas Co. → veritas
// 규칙은 이 한 곳에서만 관리하여 서버 전역(라우트·대량등록·백필)에서 재사용한다.

// 괄호형 법인표기(전각 ㈜ 포함). 길이가 긴 것부터 제거.
const PAREN_LEGAL = [
  "㈜", "㈐", "㈎",
  "(주)", "(유)", "(사)", "(재)", "(합)", "(복지)", "(의)", "(학)",
  "(사단)", "(재단)", "(주식회사)",
];

// 풀네임 한글 법인표기(대개 접두/접미). 길이가 긴 것부터 제거.
const KOREAN_LEGAL = [
  "유한책임회사", "사회복지법인", "주식회사", "유한회사", "합자회사", "합명회사",
  "사단법인", "재단법인", "의료법인", "학교법인",
];

// 라틴 법인표기. \b 경계로 라틴 토큰만 매칭(한글 사이에는 매칭되지 않음). 길이가 긴 것부터.
const LATIN_LEGAL_RE =
  /\b(?:co\.?\s*,?\s*ltd\.?|corp(?:oration)?\.?|company\s+limited|company|co\.?|ltd\.?|inc\.?|llc)\b/gi;

/**
 * 기업명 정규화. 실패해도 절대 throw 하지 않고 최선의 문자열을 반환한다.
 * 결과가 빈 문자열이면(법인표기만 있던 경우 등) 원문 소문자 trim 으로 폴백한다.
 */
export function normalizeCompanyName(raw: unknown): string {
  const original = (raw == null ? "" : String(raw)).trim();
  if (!original) return "";

  let s = original.toLowerCase();

  // 1) 괄호형 법인표기 제거
  for (const t of PAREN_LEGAL) s = s.split(t.toLowerCase()).join(" ");
  // 2) 한글 풀네임 법인표기 제거
  for (const t of KOREAN_LEGAL) s = s.split(t).join(" ");
  // 3) 라틴 법인표기 제거
  s = s.replace(LATIN_LEGAL_RE, " ");
  // 4) 공백·구두점 전부 제거 → 압축 키
  s = s.replace(/[\s.,·・'"“”‘’()\-_/\\|&]+/g, "");

  // 법인표기만 있던 경우 등으로 비면 원문 기반 폴백(공백/구두점만 제거)
  if (!s) s = original.toLowerCase().replace(/[\s.,·・'"“”‘’()\-_/\\|&]+/g, "");
  return s;
}
