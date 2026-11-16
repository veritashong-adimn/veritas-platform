// ─── 외화 금액·환율 표시/계산 (화면용) — 서버 api-server/src/services/fxBilling.ts 와 같은 규칙 ─────────────
//  · 금액은 BigInt 고정소수점(외화 0.01 · 환율 0.000001)으로 계산(부동소수점 미사용). 원화 환산은 원 단위 반올림(half-up).
//  · 환율 저장 = 외화 1단위당 원화. 화면 입력 단위: JPY 는 100엔당(국내 고시 관행), 그 외 1단위당.
export const FX_CURRENCY_OPTS = [
  { value: 'EUR', label: 'EUR (유로)' }, { value: 'USD', label: 'USD (미국 달러)' }, { value: 'JPY', label: 'JPY (일본 엔)' },
  { value: 'CNY', label: 'CNY (중국 위안)' }, { value: 'GBP', label: 'GBP (영국 파운드)' }, { value: 'CHF', label: 'CHF (스위스 프랑)' },
  { value: 'CAD', label: 'CAD (캐나다 달러)' }, { value: 'AUD', label: 'AUD (호주 달러)' }, { value: 'SGD', label: 'SGD (싱가포르 달러)' },
  { value: 'HKD', label: 'HKD (홍콩 달러)' },
];
export const CURRENCY_DIGITS: Record<string, number> = { KRW: 0, JPY: 0, EUR: 2, USD: 2, CNY: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, SGD: 2, HKD: 2 };
export const isForeignCur = (c?: string | null) => !!c && c.toUpperCase() !== 'KRW';
export const rateUnit = (cur?: string | null) => (String(cur ?? '').toUpperCase() === 'JPY' ? 100 : 1);
export const rateLabel = (cur?: string | null) => `${rateUnit(cur)} ${cur || 'FX'} =`;

const pow10 = (n: number) => 10n ** BigInt(n);
export function toScaled(v: unknown, scale: number): bigint | null {
  if (v == null || v === '') return null;
  const s = String(v).replace(/,/g, '').trim();
  const m = s.match(/^(-)?(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[2] && !m[3])) return null;
  const frac = (m[3] ?? '').padEnd(scale + 1, '0');
  let n = BigInt((m[2] || '0') + frac.slice(0, scale));
  if (Number(frac[scale] ?? '0') >= 5) n += 1n;
  return m[1] ? -n : n;
}
export function fromScaled(n: bigint, scale: number): string {
  const neg = n < 0n; const a = neg ? -n : n; const d = pow10(scale);
  const s = scale ? `${a / d}.${(a % d).toString().padStart(scale, '0')}` : `${a}`;
  return neg ? `-${s}` : s;
}
const divRound = (a: bigint, b: bigint) => { const q = a / b, r = a % b; return (r * 2n >= b) ? q + 1n : q; };

// 원화 환산(원) = 외화 × 환율(1단위당). 근거 없으면 null.
export function krwOf(foreign: unknown, ratePer1: unknown): number | null {
  const f = toScaled(foreign, 2), r = toScaled(ratePer1, 6);
  if (f == null || r == null || r <= 0n || f < 0n) return null;
  return Number(divRound(f * r, pow10(8)));
}
// 화면 입력 환율(통화 고시 단위) ↔ 저장 환율(1단위당)
export function ratePer1FromInput(input: unknown, cur?: string | null): string | null {
  const r = toScaled(input, 6); if (r == null || r <= 0n) return null;
  return fromScaled(divRound(r, BigInt(rateUnit(cur))), 6);
}
export function rateInputFromPer1(per1: unknown, cur?: string | null): string {
  const r = toScaled(per1, 6); if (r == null) return '';
  return trimZeros(fromScaled(r * BigInt(rateUnit(cur)), 6));
}
const trimZeros = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

// 입력 정리 — 숫자·소수점만, 통화 소수 자릿수까지(EUR 5,161.34 → '5161.34'. 소수점을 지우지 않는다)
export function cleanForeignInput(v: string, cur?: string | null): string {
  const d = CURRENCY_DIGITS[String(cur ?? '').toUpperCase()] ?? 2;
  let s = v.replace(/[^\d.]/g, '');
  const i = s.indexOf('.');
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
  if (d === 0) return s.split('.')[0];
  const [a, b] = s.split('.');
  return b !== undefined ? `${a}.${b.slice(0, d)}` : a;
}
export const cleanRateInput = (v: string) => { let s = v.replace(/[^\d.]/g, ''); const i = s.indexOf('.'); if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '').slice(0, 6); return s; };

export function fmtForeign(cur: string | null | undefined, amount: unknown): string {
  if (amount == null || amount === '' || !cur) return '';
  const d = CURRENCY_DIGITS[cur] ?? 2;
  const n = toScaled(amount, d) ?? 0n;
  const s = fromScaled(n < 0n ? -n : n, d);
  const [i, f] = s.split('.');
  return `${n < 0n ? '-' : ''}${cur} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? '.' + f : ''}`;
}
export const fmtWon = (n: number | null | undefined) => (n == null ? '' : `${Math.round(n).toLocaleString('ko-KR')}원`);
export const addScaled = (vals: unknown[]) => fromScaled(vals.reduce<bigint>((s, v) => s + (toScaled(v, 2) ?? 0n), 0n), 2);
export const subScaled = (a: unknown, b: unknown) => fromScaled((toScaled(a, 2) ?? 0n) - (toScaled(b, 2) ?? 0n), 2);
export const cmpScaled = (a: unknown, b: unknown) => { const x = toScaled(a, 2) ?? 0n, y = toScaled(b, 2) ?? 0n; return x === y ? 0 : x > y ? 1 : -1; };

// 서버 fx 요약(GET 응답 paymentRecords[].fx / collections rows[].fx) 타입
export type FxStatus = 'unpaid' | 'partial' | 'completed' | 'overpaid' | 'review';
export interface FxSummary {
  currency: string; billedForeign: string | null; depositForeign: string; offsetForeign: string; offsetOutForeign: string;
  paidForeign: string; receivableForeign: string | null; overpaidForeign: string; feeForeign: string;
  depositKrwConfirmed: number; unconfirmedCount: number; receivableKrwRef: number | null;
  receivableKrwBasis: 'invoice_rate' | 'billing_ratio' | null; paidKrwForSale: number; status: FxStatus; reviewReasons: string[];
}
export const FX_STATUS_LABEL: Record<FxStatus, string> = { unpaid: '미입금', partial: '부분입금', completed: '입금완료', overpaid: '초과입금', review: '확인 필요' };
export const FX_STATUS_STYLE: Record<FxStatus, { bg: string; color: string }> = {
  unpaid: { bg: '#f3f4f6', color: '#6b7280' }, partial: { bg: '#fef9c3', color: '#854d0e' }, completed: { bg: '#dcfce7', color: '#15803d' },
  overpaid: { bg: '#e0e7ff', color: '#3730a3' }, review: { bg: '#ffedd5', color: '#c2410c' },
};
export const fxBasisLabel = (b: FxSummary['receivableKrwBasis']) => (b === 'invoice_rate' ? '인보이스 환율 기준' : b === 'billing_ratio' ? '원화 청구액 비율 기준' : '');
