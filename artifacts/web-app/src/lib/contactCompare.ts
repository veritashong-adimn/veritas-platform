// ─── 담당자 연락처 비교(공통) — 저장값(견적 수신자 등) ↔ 담당자 Master ─────────────────────────────
//  경고 판단에만 쓴다(저장값 불변). api-server/src/services/contactCompare.ts 와 같은 규칙(미러).
//  · 전화: 일반전화·휴대전화를 칸이 아니라 '실제 번호 집합'으로 비교(하이픈·공백·괄호·+82 차이 무시, 7자리 미만은 번호 아님).
//    - Master 번호가 저장값 어디에도 없으면 '다름'(변경·누락). Master 에 번호가 전혀 없는데 저장값에만 있으면 '다름'(Master 누락).
//    - 저장값에만 있는 추가 번호는 Master 의 해당 칸이 비어 있는 것이므로 '다름'으로 보지 않는다(예: Master 일반전화 공란).
//  · 이메일: 앞뒤 공백·대소문자 무시.
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
/** 비교키 — 숫자만, 국제형식 국내번호(+82 …)는 0… 으로(형식 변환만) */
export function normPhone(v: unknown): string {
  const d = digits(v);
  if (/^82(1[016789]|[2-6]|70)\d{6,9}$/.test(d)) return '0' + d.slice(2);
  if (/^820\d{8,10}$/.test(d)) return d.slice(2);   // +82 0… 로 적은 경우
  return d;
}
export const phoneSet = (vals: Array<unknown>): Set<string> => new Set(vals.map(normPhone).filter(d => d.length >= 7));
export function comparePhones(saved: Array<unknown>, master: Array<unknown>) {
  const a = phoneSet(saved), b = phoneSet(master);
  const masterOnly = [...b].filter(x => !a.has(x));
  const savedOnly = [...a].filter(x => !b.has(x));
  const masterEmpty = b.size === 0;
  return { same: masterOnly.length === 0 && !(masterEmpty && a.size > 0), masterOnly, savedOnly, masterEmpty };
}
export const normEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
