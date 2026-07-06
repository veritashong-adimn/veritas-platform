/**
 * VERITAS Language Page Count Policy
 *
 * 언어별 페이지 산정 기준 및 글자수·단어수 교차검증 규칙.
 * 이 파일만 수정하면 모든 기준이 반영됨 — 코드 하드코딩 금지.
 *
 * 향후 확장 예정:
 *  - 고객사별/계약별/상품별 정책 오버라이드
 *  - 나라장터 (800자), 일본어 650자, 중국어 650자 등 특수 기준
 *  - 번역사 지급 정책 / 원가 계산 정책
 *  - Translation Cost Intelligence Engine (AI 원가·리스크 분석)
 */

export type CalcType = 'character' | 'word';

export interface LanguagePagePolicy {
  languageCode: string;
  languageName: string;
  calcType: CalcType;
  /** 1페이지당 글자수(character) 또는 단어수(word) */
  standardValue: number;
  /** 교차검증용 글자수÷단어수 예상 비율 범위 (null = 기준 미확정) */
  expectedCharsPerWord: { min: number; max: number } | null;
  active: boolean;
  remark?: string;
}

export interface ValidationResult {
  status: 'ok' | 'warning' | 'unchecked';
  message: string;
  detail?: {
    actualRatio: number;
    expectedMin: number;
    expectedMax: number;
    deviationPct: number;
  };
  causes?: string[];
}

/** 시스템 기본 교차검증 경고 임계 편차 (향후 Language Policy 필드로 이관 가능) */
export const DEFAULT_WARNING_THRESHOLD = 0.20;

export const LANGUAGE_PAGE_POLICIES: LanguagePagePolicy[] = [

  // ── CJK (글자수 기준) ───────────────────────────────────────────────────────
  {
    languageCode: 'ko', languageName: '한국어',
    calcType: 'character', standardValue: 700,
    expectedCharsPerWord: { min: 1.2, max: 5.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'ja', languageName: '일본어',
    calcType: 'character', standardValue: 700,
    expectedCharsPerWord: { min: 0.5, max: 5.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'zh-hans', languageName: '중국어(간체)',
    calcType: 'character', standardValue: 700,
    expectedCharsPerWord: { min: 0.5, max: 3.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'zh-hant', languageName: '중국어(번체)',
    calcType: 'character', standardValue: 700,
    expectedCharsPerWord: { min: 0.5, max: 3.0 },
    active: true, remark: '기본',
  },

  // ── 유럽어 (단어수 기준) ────────────────────────────────────────────────────
  {
    languageCode: 'en', languageName: '영어',
    calcType: 'word', standardValue: 250,
    expectedCharsPerWord: { min: 3.5, max: 9.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'de', languageName: '독일어',
    calcType: 'word', standardValue: 250,
    expectedCharsPerWord: { min: 4.0, max: 12.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'fr', languageName: '프랑스어',
    calcType: 'word', standardValue: 250,
    expectedCharsPerWord: { min: 3.5, max: 9.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'es', languageName: '스페인어',
    calcType: 'word', standardValue: 250,
    expectedCharsPerWord: { min: 3.5, max: 9.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'it', languageName: '이탈리아어',
    calcType: 'word', standardValue: 250,
    expectedCharsPerWord: { min: 3.5, max: 9.0 },
    active: true, remark: '기본',
  },
  {
    languageCode: 'pt', languageName: '포르투갈어',
    calcType: 'word', standardValue: 250,
    expectedCharsPerWord: { min: 3.5, max: 9.0 },
    active: true, remark: '기본',
  },

  // ── 기준 미확정 — 향후 업계 기준 조사 후 추가 ─────────────────────────────
  { languageCode: 'ar', languageName: '아랍어',     calcType: 'word',      standardValue: 250, expectedCharsPerWord: null, active: false, remark: '기준 미확정' },
  { languageCode: 'th', languageName: '태국어',     calcType: 'character', standardValue: 700, expectedCharsPerWord: null, active: false, remark: '기준 미확정' },
  { languageCode: 'vi', languageName: '베트남어',   calcType: 'word',      standardValue: 250, expectedCharsPerWord: null, active: false, remark: '기준 미확정' },
  { languageCode: 'ru', languageName: '러시아어',   calcType: 'word',      standardValue: 250, expectedCharsPerWord: null, active: false, remark: '기준 미확정' },
  { languageCode: 'hi', languageName: '힌디어',     calcType: 'word',      standardValue: 250, expectedCharsPerWord: null, active: false, remark: '기준 미확정' },
];

/** 활성 정책 목록 (언어 선택 UI용) */
export function getActivePolicies(): LanguagePagePolicy[] {
  return LANGUAGE_PAGE_POLICIES.filter(p => p.active);
}

/** 언어 코드로 정책 조회 */
export function getPolicy(code: string): LanguagePagePolicy | null {
  if (!code) return null;
  return LANGUAGE_PAGE_POLICIES.find(p => p.languageCode === code.toLowerCase()) ?? null;
}

/** 0.5페이지 단위 반올림: 소수 0.0~0.1 → 내림 / 0.2~0.5 → +0.5 / 0.6~0.9 → 올림 */
export function roundToHalfPage(raw: number): number {
  const floor = Math.floor(raw);
  const dec   = raw - floor;
  if (dec <= 0.1) return floor;
  if (dec <= 0.5) return floor + 0.5;
  return floor + 1;
}

/** 숫자 문자열 + 기준값(표준값) → 페이지 수 (null = 입력값 없음) */
export function calcPagesFromStr(countStr: string, standardValue: number): number | null {
  const n = Number(countStr.replace?.(/,/g, '') || 0);
  if (!n || n <= 0) return null;
  return roundToHalfPage(n / standardValue);
}

/** 글자수·단어수 교차검증 — 비율이 언어 정책 허용 범위 이탈 시 warning 반환 */
export function validateCounts(
  policy:       LanguagePagePolicy,
  charCountStr: string,
  wordCountStr: string,
): ValidationResult {
  const chars = Number(charCountStr.replace?.(/,/g, '') || 0);
  const words = Number(wordCountStr.replace?.(/,/g, '') || 0);

  if (!chars || !words) {
    return { status: 'unchecked', message: '단일 지표 — 교차검증 건너뜀' };
  }

  const expected = policy.expectedCharsPerWord;
  if (!expected) {
    return { status: 'unchecked', message: `${policy.languageName} 교차검증 기준 미확정` };
  }

  const actualRatio  = chars / words;
  const expectedMid  = (expected.min + expected.max) / 2;

  if (actualRatio >= expected.min && actualRatio <= expected.max) {
    return { status: 'ok', message: 'AI 검증 완료' };
  }

  const deviationPct = actualRatio < expected.min
    ? ((expected.min - actualRatio) / expectedMid * 100)
    : ((actualRatio - expected.max) / expectedMid * 100);

  return {
    status: 'warning',
    message: `글자수·단어수 비율 이상 (${deviationPct.toFixed(0)}% 오차)`,
    detail: { actualRatio, expectedMin: expected.min, expectedMax: expected.max, deviationPct },
    causes: [
      '한글·영문 혼합 문서',
      '띄어쓰기 오류 (붙여쓰기)',
      '표·이미지 다수 포함 문서',
      'OCR 분석 오류',
      '숨김 텍스트 포함',
      'Word Count 도구 오류',
      '문서 형식 문제',
    ],
  };
}
