/**
 * VERITAS Language Page Count Policy
 *
 * 언어별 페이지 산정 기준 및 AI 교차검증 규칙.
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
  /**
   * 환산계수 — 글자수÷단어수 명목값 (null = 검증 불가).
   * - character 기반: chars ÷ nominalCharsPerWord = 예상 단어수
   * - word 기반:     words × nominalCharsPerWord = 예상 글자수
   */
  nominalCharsPerWord: number | null;
  active: boolean;
  remark?: string;
}

export type ValidationSeverity = 'caution' | 'danger';

export interface ValidationResult {
  status: 'ok' | 'warning' | 'unchecked';
  /** status === 'warning' 일 때만 존재 */
  severity?: ValidationSeverity;
  message: string;
  detail?: {
    expectedVal:  number;    // 예상값 (단어수 or 글자수)
    actualVal:    number;    // 실제 입력값
    deviationPct: number;   // 오차율 (%)
    basis:        CalcType; // 기준 타입
  };
  causes?: string[];
}

/** 정상 판정 상한 (이하 → ok) */
export const THRESHOLD_OK      = 15;  // %
/** 주의/위험 경계 (초과 → 위험) */
export const THRESHOLD_CAUTION = 50;  // %

export const LANGUAGE_PAGE_POLICIES: LanguagePagePolicy[] = [

  // ── CJK (글자수 기준, 700글자 ≈ 1페이지 ≈ 210단어 → nominalCharsPerWord ≈ 3.3) ──
  {
    languageCode: 'ko', languageName: '한국어',
    calcType: 'character', standardValue: 700,
    nominalCharsPerWord: 3.3,
    active: true, remark: '기본',
  },
  {
    languageCode: 'ja', languageName: '일본어',
    calcType: 'character', standardValue: 700,
    nominalCharsPerWord: 3.3,
    active: true, remark: '기본',
  },
  {
    languageCode: 'zh-hans', languageName: '중국어(간체)',
    calcType: 'character', standardValue: 700,
    nominalCharsPerWord: 2.5,
    active: true, remark: '기본',
  },
  {
    languageCode: 'zh-hant', languageName: '중국어(번체)',
    calcType: 'character', standardValue: 700,
    nominalCharsPerWord: 2.5,
    active: true, remark: '기본',
  },

  // ── 유럽어 — 단어수 기준 (250단어 ≈ 1페이지) ────────────────────────────────
  {
    languageCode: 'en', languageName: '영어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'de', languageName: '독일어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 7.5,
    active: true, remark: '기본',
  },
  {
    languageCode: 'fr', languageName: '프랑스어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'es', languageName: '스페인어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'it', languageName: '이탈리아어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'pt', languageName: '포르투갈어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'ru', languageName: '러시아어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 7.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'nl', languageName: '네덜란드어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.5,
    active: true, remark: '기본',
  },
  {
    languageCode: 'pl', languageName: '폴란드어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 7.5,
    active: true, remark: '기본',
  },
  {
    languageCode: 'cs', languageName: '체코어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.5,
    active: true, remark: '기본',
  },
  {
    languageCode: 'uk', languageName: '우크라이나어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 7.0,
    active: true, remark: '기본',
  },

  // ── 아시아어 ──────────────────────────────────────────────────────────────────
  {
    languageCode: 'vi', languageName: '베트남어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 5.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'th', languageName: '태국어',
    calcType: 'character', standardValue: 700,
    nominalCharsPerWord: null,
    active: true, remark: '기준 미확정',
  },
  {
    languageCode: 'id', languageName: '인도네시아어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'ms', languageName: '말레이어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 6.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'hi', languageName: '힌디어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: null,
    active: true, remark: '기준 미확정',
  },
  {
    languageCode: 'mn', languageName: '몽골어',
    calcType: 'character', standardValue: 700,
    nominalCharsPerWord: null,
    active: true, remark: '기준 미확정',
  },

  // ── 중동어 ───────────────────────────────────────────────────────────────────
  {
    languageCode: 'ar', languageName: '아랍어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: null,
    active: true, remark: '기준 미확정',
  },
  {
    languageCode: 'tr', languageName: '터키어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: 8.0,
    active: true, remark: '기본',
  },
  {
    languageCode: 'fa', languageName: '페르시아어',
    calcType: 'word', standardValue: 250,
    nominalCharsPerWord: null,
    active: true, remark: '기준 미확정',
  },
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

/**
 * 글자수·단어수 AI 교차검증
 *
 * 언어별 환산계수(nominalCharsPerWord)를 기준으로
 * 예상값을 계산한 후 실제값과 비교한다.
 *
 * - character 기반: chars ÷ cpw = 예상 단어수 → 실제 단어수와 비교
 * - word 기반:     words × cpw = 예상 글자수 → 실제 글자수와 비교
 *
 * 오차율 기준:
 *   ≤ 15% → ok
 *   15~50% → warning / caution (주의)
 *   > 50% → warning / danger  (위험)
 */
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

  const cpw = policy.nominalCharsPerWord;
  if (!cpw) {
    return { status: 'unchecked', message: `${policy.languageName} 교차검증 기준 미확정` };
  }

  const basis = policy.calcType;
  let expectedVal: number;
  let actualVal: number;

  if (basis === 'character') {
    // 글자수 기준 언어: 글자수 → 예상 단어수
    expectedVal = Math.round(chars / cpw);
    actualVal   = words;
  } else {
    // 단어수 기준 언어: 단어수 → 예상 글자수
    expectedVal = Math.round(words * cpw);
    actualVal   = chars;
  }

  const deviationPct = Math.abs(actualVal - expectedVal) / expectedVal * 100;

  if (deviationPct <= THRESHOLD_OK) {
    return { status: 'ok', message: 'AI 검증 완료' };
  }

  const severity: ValidationSeverity = deviationPct > THRESHOLD_CAUTION ? 'danger' : 'caution';
  const valLabel  = basis === 'character' ? '단어수' : '글자수';
  const sevLabel  = severity === 'danger' ? '위험' : '주의';

  return {
    status: 'warning',
    severity,
    message: `${sevLabel} — ${valLabel} 오차 ${deviationPct.toFixed(0)}% (예상 ${expectedVal.toLocaleString()} / 실제 ${actualVal.toLocaleString()})`,
    detail: { expectedVal, actualVal, deviationPct, basis },
    causes: [
      'OCR 분석 오류',
      'Word Count 도구 오류',
      '문서 형식 문제',
      '한글·영문 혼합 문서',
      '띄어쓰기 오류 (붙여쓰기)',
      '숨김 텍스트 포함',
      '표·이미지 비율이 높은 문서',
    ],
  };
}
