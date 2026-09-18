/**
 * comparisonItemName — 비교견적 전용 품목명 자동 변환 헬퍼.
 *
 * 원본 견적 품목(quote_items)의 productName 은 절대 수정하지 않는다(§3).
 * 비교견적 품목의 초기 description 표현만 아래 규칙으로 변환하며, 사용자는 이후 자유 수정 가능(§4).
 *
 * 규칙:
 *  1) 언어쌍 + 접미(번역/통역류): "한국어→영어 번역" → "한영번역", "한국어↔영어 동시통역" → "한영 동시통역"
 *     - 번역: 약칭을 붙여 공백 없이(한영번역)
 *     - 통역류(동시/순차/수행 통역 등): 약칭 + 공백 + 접미(한영 동시통역)
 *  2) 명시적 문구 치환: "통역사 출장비" → "출장경비", "통역사 교통비" → "교통비"
 *  3) 약칭이 정의되지 않은 언어(몽골어/광동어 등)는 억지 약칭을 만들지 않고 원본 명칭을 그대로 유지한다.
 *
 * 확장: 새 언어는 LANG_FULL_TO_ABBR 에, 새 문구 규칙은 PHRASE_RULES 에 한 줄씩 추가하면 된다.
 */

// 언어 전체명 → 1글자 약칭. constants.ts 의 LANG_ABBR(약칭→전체명)과 동일 소스를 역방향으로 미러링.
//  여기 없는 언어는 약칭 없음 → 변환하지 않고 원본 유지(§3 "억지 약칭 생성 금지").
export const LANG_FULL_TO_ABBR: Record<string, string> = {
  한국어: "한", 영어: "영", 일본어: "일", 중국어: "중",
  프랑스어: "불", 독일어: "독", 스페인어: "스", 러시아어: "러",
  아랍어: "아", 포르투갈어: "포", 이탈리아어: "이", 태국어: "태",
  베트남어: "베", 인도네시아어: "인",
};

// 명시적 문구 치환(비용 항목 등). 필요 시 규칙을 추가한다.
const PHRASE_RULES: { test: RegExp; to: string }[] = [
  { test: /^통역사\s*출장비$/, to: "출장경비" },
  { test: /^통역사\s*교통비$/, to: "교통비" },
];

// 언어쌍 구분자(→ ↔ ⟷ ~ - ― —) + 접미가 번역/통역으로 끝나는 형태.
const LANG_PAIR_RE = /^(.+?)\s*(?:→|↔|⟷|~|-|―|—)\s*(.+?)\s+(\S*(?:번역|통역))$/;

/** 비교견적 품목 초기 표현으로 변환. 변환 불가하면 원본을 그대로 반환한다. */
export function toComparisonItemName(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";

  for (const r of PHRASE_RULES) if (r.test.test(s)) return r.to;

  const m = s.match(LANG_PAIR_RE);
  if (m) {
    const a = LANG_FULL_TO_ABBR[m[1].trim()];
    const b = LANG_FULL_TO_ABBR[m[2].trim()];
    if (a && b) {
      const suffix = m[3].trim();
      return suffix === "번역" ? `${a}${b}번역` : `${a}${b} ${suffix}`;
    }
  }
  return s; // 미등록 언어/미매칭 → 원본 보존
}
