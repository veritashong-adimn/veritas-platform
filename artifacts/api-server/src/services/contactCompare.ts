// ─── 담당자 연락처 비교(공통) — 저장값(견적 수신자·판매건·의뢰) ↔ 담당자 Master ─────────────────────
//  경고 판단에만 쓴다. DB 값은 바꾸지 않는다. web-app/src/lib/contactCompare.ts 와 같은 규칙(미러).
//  · 전화: 일반전화·휴대전화를 칸이 아니라 '실제 번호 집합'으로 비교(하이픈·공백·괄호·+82 차이 무시, 7자리 미만은 번호 아님).
//    - Master 번호가 저장값 어디에도 없으면 '다름'(변경·누락). Master 에 번호가 전혀 없는데 저장값에만 있으면 '다름'(Master 누락).
//    - 저장값에만 있는 추가 번호는 Master 의 해당 칸이 비어 있는 것이므로 '다름'으로 보지 않는다(예: Master 일반전화 공란).
//  · 이메일: 앞뒤 공백·대소문자 무시.
import { normPhone } from "./legacyContactRestore";

export const phoneSet = (vals: Array<unknown>): Set<string> =>
  new Set(vals.map(v => normPhone(v)).filter(d => d.length >= 7));
export function comparePhones(saved: Array<unknown>, master: Array<unknown>) {
  const a = phoneSet(saved), b = phoneSet(master);
  const masterOnly = [...b].filter(x => !a.has(x));
  const savedOnly = [...a].filter(x => !b.has(x));
  const masterEmpty = b.size === 0;
  return { same: masterOnly.length === 0 && !(masterEmpty && a.size > 0), masterOnly, savedOnly, masterEmpty };
}
export const phonesIntersect = (x: Array<unknown>, y: Array<unknown>) => { const b = phoneSet(y); return [...phoneSet(x)].some(p => b.has(p)); };
export const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
