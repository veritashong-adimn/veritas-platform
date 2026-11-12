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
