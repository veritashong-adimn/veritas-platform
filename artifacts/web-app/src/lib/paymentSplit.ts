// 청구정보(결제정보) 금액 분해·검증 — PaymentInfoSection 공용 순수 함수.
//  · 판매 공급가/부가세 기준: 견적에 실제 저장된 값(품목 합계, 합 = 총액)이 있으면 그것을, 없으면 총액÷1.1(10%) 분해.
//  · 부가세 0원 판매(영세율·해외 통역 등)는 청구 금액 입력 시에도 부가세 0을 유지한다(10% 재계산 금지).
//  · 청구 합계 검증은 실제 저장 기준 또는 기존 10% 분해 기준 중 하나와 일치하면 정상(기존 10% 판매 회귀 방지).
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

export interface SaleSplit { supply: number; vat: number; stored: boolean; zeroVat: boolean; legacy: { supply: number; vat: number } }

export function saleSplitOf(total: unknown, storedSupply?: unknown, storedVat?: unknown): SaleSplit {
  const t = num(total);
  const lSupply = Math.round(t / 1.1);
  const legacy = { supply: lSupply, vat: t - lSupply };
  const stored = storedSupply != null && storedVat != null && Math.abs(num(storedSupply) + num(storedVat) - t) < 0.5;
  if (!stored) return { ...legacy, stored: false, zeroVat: false, legacy };
  const supply = Math.round(num(storedSupply));
  const vat = t - supply;
  return { supply, vat, stored: true, zeroVat: vat === 0 && supply > 0, legacy };
}

/** 공급가액 입력 → 부가세·합계(정방향). 부가세 0원 판매는 부가세 0 */
export function amountsFromSupply(digits: string, zeroVat: boolean) {
  if (digits === '') return { supplyAmount: '', vatAmount: '', amount: '' };
  const vat = zeroVat ? 0 : Math.round(num(digits) * 0.1);
  return { supplyAmount: digits, vatAmount: String(vat), amount: String(num(digits) + vat) };
}

/** 합계 입력 → 공급가액·부가세(역산). 부가세 0원 판매는 공급가액 = 합계 */
export function amountsFromTotal(digits: string, zeroVat: boolean) {
  if (digits === '') return { amount: '', supplyAmount: '', vatAmount: '' };
  const total = num(digits);
  const supply = zeroVat ? total : Math.round(total / 1.1);
  return { amount: digits, supplyAmount: String(supply), vatAmount: String(total - supply) };
}

/** 청구 합계(공급가·부가세·합계)가 판매금액과 일치하는지 — 저장 기준 또는 기존 10% 분해 기준 */
export function splitMatched(sum: { supply: number; vat: number; total: number }, total: unknown, split: SaleSplit) {
  if (sum.total !== num(total)) return false;
  return (sum.supply === split.supply && sum.vat === split.vat) || (sum.supply === split.legacy.supply && sum.vat === split.legacy.vat);
}

// ─── 결제방법별 세금 구분 ─────────────────────────────────────────────────────
//  · 저장값(text) — '세금계산서'(과세) / '영세율 계산서'(영세율) / '면세 계산서'(면세). 영세율·면세는 서로 다른 값으로 구분 저장.
//  · 세 가지 모두 계산서 발행 대상(발행일 입력·유지). 영세율·면세는 금액 입력 시 부가세 0원.
//  · 결제방법을 바꾸는 것만으로 기존 공급가·부가세·청구금액을 다시 계산하지 않는다(불일치는 경고만).
export const METHOD_TAX_INVOICE = '세금계산서', METHOD_ZERO_RATED = '영세율 계산서', METHOD_EXEMPT = '면세 계산서';
const squash = (m?: string | null) => (m ?? '').replace(/\s/g, '');
export type MethodTaxKind = 'taxable' | 'zero_rated' | 'exempt' | null;
export function methodTaxKind(m?: string | null): MethodTaxKind {
  const s = squash(m);
  if (s === squash(METHOD_TAX_INVOICE)) return 'taxable';
  if (s === squash(METHOD_ZERO_RATED)) return 'zero_rated';
  if (s === squash(METHOD_EXEMPT)) return 'exempt';
  return null;
}
/** 계산서 발행 대상(발행일 사용) — 세금계산서·영세율 계산서·면세 계산서 */
export const isInvoiceMethod = (m?: string | null) => methodTaxKind(m) !== null;
/** 금액 입력 시 부가세 0원 — 영세율·면세 계산서 */
export const isZeroVatMethod = (m?: string | null) => { const k = methodTaxKind(m); return k === 'zero_rated' || k === 'exempt'; };
/** 세금 구분과 저장 금액 불일치 경고 — 영세율·면세인데 부가세가 있으면 안내(금액은 바꾸지 않음). 해당 없으면 null */
export function methodVatWarning(m: string | null | undefined, vat: unknown): string | null {
  const k = methodTaxKind(m);
  if ((k === 'zero_rated' || k === 'exempt') && num(vat) !== 0) return `${k === 'zero_rated' ? '영세율' : '면세'} 계산서는 부가세 0원입니다 — 현재 부가세 ${Math.round(num(vat)).toLocaleString('ko-KR')}원(금액을 확인해 주세요)`;
  return null;
}
