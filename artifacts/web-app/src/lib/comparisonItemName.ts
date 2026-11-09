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

// ─────────────────────────────────────────────────────────────────────────────
// 고객용 출력 정리(v2) — 저장 데이터는 그대로 두고 "PDF 출력/새 품목 초기값"에만 적용한다.
// ─────────────────────────────────────────────────────────────────────────────

// 내부 관리 문구 판정 — 원본 견적 memo 는 "단가 확인 필요 / 파일: a.pdf | 형식: PDF | 단어수: 6630 | 글자수: 43229" 형태.
const INTERNAL_SEGMENT_RULES: RegExp[] = [
  /확인\s*필요/,                                   // 단가 확인 필요 · 상품 확인 필요 등 검토 플래그
  /AI\s*(분석|초안|추정|생성)/i,                    // AI 초안 관련 내부 안내
  /^(파일|파일명|형식|단어수|글자수|페이지\s*산정|원본\s*단가|원본\s*공급가액|원가|마진|내부\s*메모)\s*[:：]/,
  /내부\s*(검토|계산|관리|확인|참고|메모)/,
  /검토용|계산용/,
  /^[a-z]{2,3}(-[a-z]{2,4})?$/i,                   // 단독 언어 코드(en, ko, zh-hans …)
];

/** 내부 관리 문구 여부(세그먼트 단위). */
export function isInternalSegment(seg: string): boolean {
  const s = seg.trim();
  if (!s) return true;
  return INTERNAL_SEGMENT_RULES.some((r) => r.test(s));
}

/**
 * 품목 설명 → 고객용 문구. " / ", " | ", 줄바꿈 단위로 나눠 내부 관리 문구를 제거한다.
 * 남는 문구가 없으면 빈 문자열(= PDF 미출력).
 */
export function toCustomerFacingNote(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const lines = s.split(/\r?\n/).map((line) =>
    line.split(/\s+[/|]\s+|\s*\|\s*/).map((x) => x.trim()).filter((x) => !isInternalSegment(x)).join(' · '),
  ).filter(Boolean);
  return lines.join('\n');
}

/** 고객용 정리 결과와 원문이 다른지(작성 화면에서 "PDF 미출력 문구 있음" 안내용). */
export function hasInternalText(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim();
  if (!s) return false;
  const norm = (x: string) => x.replace(/\s+/g, '');
  return norm(toCustomerFacingNote(s)) !== norm(s.split(/\s+[/|]\s+|\s*\|\s*/).join(' · '));
}

const ABBR_TO_FULL: Record<string, string> = Object.fromEntries(
  Object.entries(LANG_FULL_TO_ABBR).map(([full, abbr]) => [abbr, full]),
);

/**
 * 품목명에서 번역 언어 방향을 "영어 → 한국어" 형태로 해석한다. 확실한 경우만 반환, 아니면 null(추정 금지).
 *  · "영한번역" / "한영 번역"  → 약칭 2개가 모두 등록 언어이고 바로 뒤가 '번역'일 때만(방향이 명확)
 *  · "영어→한국어 번역"        → 전체 언어명 + 화살표가 명시된 경우
 *  · 통역 약칭("한일 순차통역")은 방향이 명시되지 않으므로 표시하지 않는다.
 *  · 품목명에 이미 전체 언어명이 쓰여 있으면 중복 표시하지 않는다(null).
 */
export function toLanguageDirectionLabel(name: string | null | undefined): string | null {
  const s = (name ?? '').trim();
  if (!s) return null;
  const full = s.match(/^(\S+?)\s*(→|↔|⟷)\s*(\S+?)(?:\s|$)/);
  if (full && LANG_FULL_TO_ABBR[full[1]] && LANG_FULL_TO_ABBR[full[3]]) return null; // 품목명에 이미 표시됨
  const ab = s.match(/^([가-힣])([가-힣])\s?번역/);
  if (ab && ABBR_TO_FULL[ab[1]] && ABBR_TO_FULL[ab[2]] && ab[1] !== ab[2]) {
    return `${ABBR_TO_FULL[ab[1]]} → ${ABBR_TO_FULL[ab[2]]}`;
  }
  return null;
}
