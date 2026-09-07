// ─────────────────────────────────────────────────────────────────────────────
// VERITAS 공통 "날짜 표시(Display)" formatter — 판매정보·수행정보·견적서·지급명세서 등
// 모든 사용자 화면/문서 날짜 표기의 단일 소스.
//
// ★ 표시 전용(Display Layer)이다. DB 저장값·API·HTML date input value·날짜 계산·
//   검색/정렬/필터 기준값은 절대 이 파일을 거치지 않으며 기존 형식(YYYY-MM-DD)을 유지한다.
//
// 표준(점 구분자):
//   · 단일 날짜            2026.07.20
//   · 같은 연도 기간        2026.07.20 ~ 07.22      (종료일은 MM.DD)
//   · 다른 연도 기간        2026.12.30 ~ 2027.01.02 (종료일 전체)
//   · "~" 앞뒤 공백 1칸.
//   · 빈 값/오류 → '' (NaN.NaN.NaN·Invalid Date 노출 금지). 빈값 표시(-, blank)는 호출부 정책 유지.
// ─────────────────────────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0');

// "YYYY-MM-DD"(앞 10자리)에서 [연, 월, 일] 추출. 표준 형식이 아니면 null.
const ymd = (v?: string | null): [string, string, string] | null => {
  const s = v ? String(v).slice(0, 10) : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? [m[1], m[2], m[3]] : null;
};

/**
 * 단일 날짜 표시 → "YYYY.MM.DD". 빈 값/파싱 불가 → ''.
 *  · "YYYY-MM-DD" 순수 날짜 문자열: 문자 그대로 점 치환(타임존 이동 없음 — 저장 date 필드용).
 *  · Date·timestamp·시각 포함 ISO 문자열: 로컬 날짜 파트 사용(기존 new Date(x).toLocaleDateString 동작과 동일).
 */
export function formatDisplayDate(v?: string | number | Date | null): string {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    const t = String(v).trim();
    // 순수 날짜(YYYY-MM-DD, 시각 없음) → 문자 그대로(타임존 무이동)
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t.replace(/-/g, '.');
    // 그 외 문자열(시각 포함 ISO 등)은 아래 Date 파싱으로 처리
  }
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

export interface ScheduleRangeOpts {
  sep?: string;     // 날짜 내부 구분자(기본 '.')
  joiner?: string;  // 시작~종료 연결 문자열(기본 ' ~ ' — 앞뒤 공백 1칸)
}

// 서비스 일정 범위 문자열 생성. 표준 형식이 아닌 값은 앞 10자리만 안전 반환(기존 동작 보존).
//   · 종료일 없음/시작=종료 → 시작일만(단일)
//   · 연 다름  → 양쪽 전체(2026.12.30 ~ 2027.01.02)
//   · 연 같음  → 종료일 MM.DD (2026.07.20 ~ 07.22 / 2026.07.30 ~ 08.02)
export function formatScheduleRange(start?: string | null, end?: string | null, opts: ScheduleRangeOpts = {}): string {
  const sep = opts.sep ?? '.';
  const joiner = opts.joiner ?? ' ~ ';
  const raw = (v?: string | null) => (v ? String(v).slice(0, 10).replace(/-/g, sep) : '');
  const S = ymd(start);
  if (!S) return raw(start);                                              // 시작일 없음/형식 밖 → 그대로(또는 빈 문자열)
  const startStr = S.join(sep);
  const E = ymd(end);
  if (!E) return startStr;                                                // 종료일 없음/형식 밖 → 시작일만
  if (E[0] === S[0] && E[1] === S[1] && E[2] === S[2]) return startStr;   // 시작=종료 → 시작일만
  if (E[0] !== S[0]) return `${startStr}${joiner}${E.join(sep)}`;         // 연 다름 → 양쪽 전체
  return `${startStr}${joiner}${E[1]}${sep}${E[2]}`;                      // 연 같음 → 종료일 MM.DD
}

/** 기간 표시 별칭 — 의미 명확화용(formatScheduleRange 와 동일). */
export const formatDisplayDateRange = formatScheduleRange;

/**
 * 문자열 내부에 포함된 "YYYY-MM-DD" 패턴을 표시 표준(YYYY.MM.DD)으로 치환한다.
 * "날짜 + 텍스트" 복합 표시명(예: DB 저장 회차명 "2026-08-14 지급회차") 화면 표시 전용.
 *  · 날짜 외 문자는 그대로 보존("… 지급회차", "지급일 …" 등).
 *  · 문자열 안의 모든 YYYY-MM-DD 를 치환(global).
 * ★ 저장값·입력(input)value·API 계약·검색/정렬 기준은 이 함수를 거치지 않는다(display-only).
 *   빈 값/오류 → '' (기존 동작 보존, 빈값 표시 정책은 호출부 유지).
 */
export function formatLabelDates(v?: string | null): string {
  if (v == null || v === '') return '';
  return String(v).replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1.$2.$3');
}
