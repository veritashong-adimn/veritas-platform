// ─────────────────────────────────────────────────────────────────────────────
// 서비스 일정 날짜 범위 표시 규칙(공통) — 판매정보·수행정보·견적서 PDF·엑셀 등 모든 일정 표기에서 사용.
//  · 저장 데이터(Date)는 불변. 화면 출력 포맷만 변경(검색·정렬·계산·납품일 자동계산 등 로직에 영향 없음).
//
// 규칙 — 시작일과 겹치는 상위 정보를 종료일에서 생략(중복 제거로 가독성 향상):
//   1) 연·월이 같으면        종료일은 '일'만        → 2026-07-20 ~ 22
//   2) 연은 같고 월이 다르면 종료일은 '월-일'만      → 2026-07-30 ~ 08-02
//   3) 연이 다르면           양쪽 모두 전체 표시     → 2026-12-30 ~ 2027-01-02
//   · 종료일이 없거나 시작=종료면 시작일만 표시.
// ─────────────────────────────────────────────────────────────────────────────

// YYYY-MM-DD(앞 10자리)에서 [연, 월, 일] 추출. 표준 형식이 아니면 null.
const ymd = (v?: string | null): [string, string, string] | null => {
  const s = v ? String(v).slice(0, 10) : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? [m[1], m[2], m[3]] : null;
};

export interface ScheduleRangeOpts {
  sep?: string;     // 날짜 내부 구분자(기본 '-')
  joiner?: string;  // 시작~종료 연결 문자열(기본 ' ~ ' — 날짜 범위는 공백 포함)
}

// 서비스 일정 범위 문자열 생성. 표준 형식이 아닌 값은 앞 10자리만 안전 반환(기존 동작 보존).
export function formatScheduleRange(start?: string | null, end?: string | null, opts: ScheduleRangeOpts = {}): string {
  const sep = opts.sep ?? '-';
  const joiner = opts.joiner ?? ' ~ ';
  const raw = (v?: string | null) => (v ? String(v).slice(0, 10).replace(/-/g, sep) : '');
  const S = ymd(start);
  if (!S) return raw(start);                                              // 시작일 없음/형식 밖 → 그대로(또는 빈 문자열)
  const startStr = S.join(sep);
  const E = ymd(end);
  if (!E) return startStr;                                                // 종료일 없음/형식 밖 → 시작일만
  if (E[0] === S[0] && E[1] === S[1] && E[2] === S[2]) return startStr;   // 시작=종료 → 시작일만
  if (E[0] !== S[0]) return `${startStr}${joiner}${E.join(sep)}`;         // 연 다름 → 양쪽 전체
  if (E[1] === S[1]) return `${startStr}${joiner}${E[2]}`;                // 연·월 같음 → 종료일 '일'만
  return `${startStr}${joiner}${E[1]}${sep}${E[2]}`;                      // 연 같고 월 다름 → 종료일 '월-일'
}
