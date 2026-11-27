import { sql } from "drizzle-orm";
// ─── 외화 청구·수금 공통 계산 (READ-ONLY 순수 함수) ─────────────────────────────────────────────
// 저장 의미(기존 원화 필드의 의미는 바꾸지 않는다):
//   project_payments  : amount/supply/vat = 원화 기준 청구금액(기존 그대로)
//                       billing_currency  = 청구통화(NULL·'KRW' = 원화 청구 — 기존 동작)
//                       foreign_amount    = 외화 청구금액(인보이스 금액, billing_currency 단위)
//                       invoice_fx_rate   = 인보이스 적용환율(외화 1단위당 원화) · invoice_fx_date = 환율 기준일
//   payment_transactions (외화 청구회차의 거래):
//                       currency          = 입금통화 · foreign_amount = 실제 외화 입금액(또는 상계액)
//                       fx_rate           = 실제 입금 적용환율(외화 1단위당 원화) · krw_amount = 원화 환산액(확정값)
//                       fee_amount        = 수수료(거래 통화 단위)
//                       customer_paid_amount = 확정된 원화 환산액(환율 미확정이면 0 — 원화 집계에 추측값을 넣지 않음)
//                       txn_type          = NULL/'deposit' 실제 은행 입금 · 'offset' 선입금(초과입금) 상계
//                       offset_source_payment_id = 상계 원천 청구회차(초과입금이 발생한 회차)
// 외화 청구회차의 미수금·입금상태는 외화 금액으로만 판정한다(환율 차이로 미수금이 생기지 않음).
// 원화 환산 미수금 = 외화 미수금 × 인보이스 환율(없으면 원화 청구금액 비율) — 참고값.
// 모든 금액 계산은 BigInt 고정소수점(외화 0.01 · 환율 0.000001)으로 수행한다(부동소수점 미사용).

export const FX_CURRENCIES = ["EUR", "USD", "JPY", "CNY", "GBP", "CHF", "CAD", "AUD", "SGD", "HKD"] as const;
// ISO 4217 소수 자릿수(저장은 numeric(14,2) — 지원 통화는 모두 2자리 이하)
export const CURRENCY_DIGITS: Record<string, number> = { KRW: 0, JPY: 0, EUR: 2, USD: 2, CNY: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, SGD: 2, HKD: 2 };
export const isForeignCurrency = (c?: string | null) => !!c && c.toUpperCase() !== "KRW";

// ── 고정소수점 ──
const pow10 = (n: number) => 10n ** BigInt(n);
export function toScaled(v: unknown, scale: number): bigint | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/,/g, "").trim();
  const m = s.match(/^(-)?(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[2] && !m[3])) return null;
  const frac = (m[3] ?? "").padEnd(scale + 1, "0");
  let n = BigInt((m[2] || "0") + frac.slice(0, scale));
  if (Number(frac[scale] ?? "0") >= 5) n += 1n;   // 입력이 저장 자릿수를 넘으면 반올림(half-up)
  return m[1] ? -n : n;
}
export function fromScaled(n: bigint, scale: number): string {
  const neg = n < 0n; const a = neg ? -n : n; const d = pow10(scale);
  const s = scale ? `${a / d}.${(a % d).toString().padStart(scale, "0")}` : `${a}`;
  return neg ? `-${s}` : s;
}
const divRound = (a: bigint, b: bigint) => { const q = a / b, r = a % b; return (r * 2n >= b) ? q + 1n : q; };   // a,b ≥ 0, half-up

// 원화 환산액(원 단위 정수, half-up) = 외화금액 × 환율(1단위당 원화). 환율·금액 없으면 null(추측 금지).
export function krwOf(foreign: unknown, rate: unknown): number | null {
  const f = toScaled(foreign, 2), r = toScaled(rate, 6);
  if (f == null || r == null || r <= 0n) return null;
  const neg = f < 0n; const v = divRound(neg ? -f * r : f * r, pow10(8));
  return Number(neg ? -v : v);
}

export type FxTxn = { txn_type?: string | null; currency?: string | null; foreign_amount?: unknown; fx_rate?: unknown; krw_amount?: unknown; fee_amount?: unknown; offset_source_payment_id?: number | null; paid_date?: string | null };
export type FxBillRow = { id: number; amount: unknown; billing_currency?: string | null; foreign_amount?: unknown; invoice_fx_rate?: unknown; invoice_fx_date?: string | null };
export type FxStatus = "unpaid" | "partial" | "completed" | "overpaid" | "review";

export interface FxSummary {
  currency: string;
  billedForeign: string | null;      // 외화 청구액
  depositForeign: string;            // 실제 은행 외화 입금 합계
  offsetForeign: string;             // 이 회차로 들어온 상계액
  offsetOutForeign: string;          // 이 회차의 초과입금에서 다른 회차로 상계해 나간 금액
  paidForeign: string;               // 수금 처리액 = 입금 + 상계
  receivableForeign: string | null;  // 외화 미수금(음수 없음)
  overpaidForeign: string;           // 남은 초과입금(상계 가능 잔액)
  feeForeign: string;                // 수수료 합계(거래 통화)
  depositKrwConfirmed: number;       // 환율 확정 입금의 원화 환산 합계(확정분만)
  unconfirmedCount: number;          // 원화 환산 미확정(환율 없음) 입금 건수 — 원화 집계 제외
  receivableKrwRef: number | null;   // 원화 환산 미수금(참고)
  receivableKrwBasis: "invoice_rate" | "billing_ratio" | null;
  paidKrwForSale: number;            // 판매 원화 기준 수금 처리액(= 원화 청구액 − 원화 환산 미수금) — 판매 단위 원화 집계용
  status: FxStatus;
  reviewReasons: string[];
}

// 외화 청구회차 1건 요약. txnsIn = 이 회차의 거래, offsetsOut = 이 회차를 원천으로 다른 회차에 상계한 거래.
export function summarizeFxRow(b: FxBillRow, txnsIn: FxTxn[], offsetsOut: FxTxn[] = []): FxSummary {
  const cur = String(b.billing_currency ?? "").toUpperCase();
  const reasons: string[] = [];
  const billed = toScaled(b.foreign_amount, 2);
  let dep = 0n, off = 0n, fee = 0n, krwConf = 0, unconf = 0;
  for (const t of txnsIn) {
    const tc = String(t.currency ?? "KRW").toUpperCase();
    const f = toScaled(t.foreign_amount, 2) ?? 0n;
    if (tc !== cur) { reasons.push(`청구통화(${cur})와 다른 통화(${tc}) 거래`); continue; }
    if (t.txn_type === "offset") off += f; else {
      dep += f;
      const k = t.krw_amount != null && t.krw_amount !== "" ? Math.round(Number(t.krw_amount)) : null;
      if (k != null && t.fx_rate != null && t.fx_rate !== "") krwConf += k; else if (f > 0n) unconf++;
    }
    fee += toScaled(t.fee_amount, 2) ?? 0n;
  }
  let out = 0n; for (const t of offsetsOut) out += toScaled(t.foreign_amount, 2) ?? 0n;
  const paid = dep + off;
  const billedKrw = Math.round(Number(b.amount ?? 0));
  if (billed == null || billed <= 0n) reasons.push("외화 청구금액 없음");
  const recv = billed != null ? (paid >= billed ? 0n : billed - paid) : null;
  const over = billed != null ? (paid > billed ? paid - billed - out : 0n) : 0n;
  if (over < 0n) reasons.push("상계 사용액이 초과입금액보다 큼");
  // 수수료 공제로 청구액에 못 미치는 경우 — 자동 미수금/손실 확정 금지 → 확인 필요
  if (recv != null && recv > 0n && fee > 0n && paid + fee >= billed!) reasons.push("수수료 공제 차액 확인 필요");
  // 원화 환산 미수금(참고)
  let recvKrw: number | null = null; let basis: FxSummary["receivableKrwBasis"] = null;
  if (recv != null) {
    if (recv === 0n) { recvKrw = 0; basis = b.invoice_fx_rate ? "invoice_rate" : "billing_ratio"; }
    else if (b.invoice_fx_rate != null && b.invoice_fx_rate !== "") { recvKrw = krwOf(fromScaled(recv, 2), b.invoice_fx_rate); basis = "invoice_rate"; }
    else if (billed && billed > 0n) { recvKrw = Number(divRound(BigInt(billedKrw) * recv, billed)); basis = "billing_ratio"; }
  }
  const status: FxStatus = reasons.length ? "review"
    : paid <= 0n ? "unpaid" : recv! > 0n ? "partial" : paid > billed! ? "overpaid" : "completed";
  return {
    currency: cur, billedForeign: billed != null ? fromScaled(billed, 2) : null,
    depositForeign: fromScaled(dep, 2), offsetForeign: fromScaled(off, 2), offsetOutForeign: fromScaled(out, 2),
    paidForeign: fromScaled(paid, 2), receivableForeign: recv != null ? fromScaled(recv, 2) : null,
    overpaidForeign: fromScaled(over > 0n ? over : 0n, 2), feeForeign: fromScaled(fee, 2),
    depositKrwConfirmed: krwConf, unconfirmedCount: unconf,
    receivableKrwRef: recvKrw, receivableKrwBasis: basis,
    // 판매 원화 집계: 외화 기준으로 다 받았으면 원화 청구액 전부 수금(환율 차이로 미수금 생성 금지). 미확정이면 0 처리하지 않고 review.
    paidKrwForSale: recvKrw == null ? 0 : Math.max(billedKrw - recvKrw, 0),
    status, reviewReasons: [...new Set(reasons)],
  };
}

// 표시 문자열 — 'EUR 5,161.34'
export function fmtForeign(cur: string, amount: string | number | null | undefined): string {
  if (amount == null || amount === "") return "";
  const d = CURRENCY_DIGITS[cur] ?? 2;
  const n = toScaled(amount, d) ?? 0n;
  const s = fromScaled(n < 0n ? -n : n, d);
  const [i, f] = s.split(".");
  return `${n < 0n ? "-" : ""}${cur} ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${f ? "." + f : ""}`;
}
const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
// 'EUR 5,161.34 (원화 환산 7,742,010원)' / 환율 없으면 '(원화 환산 확인 필요)'
export function fmtForeignWithKrw(cur: string, foreign: unknown, krw: number | null): string {
  return `${fmtForeign(cur, foreign as any)} (${krw != null ? `원화 환산 ${won(krw)}` : "원화 환산 확인 필요"})`;
}

// ── DB 일괄 조회(N+1 없음): 청구회차 id 목록 중 외화 청구회차만 요약 → Map<청구회차 id, FxSummary> ──
export async function loadFxSummaries(dbx: any, paymentIds: number[]): Promise<Map<number, FxSummary>> {
  const out = new Map<number, FxSummary>();
  const ids = [...new Set(paymentIds.filter((v) => Number.isFinite(v)))];
  if (!ids.length) return out;
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const bills = (await dbx.execute(sql`SELECT id, amount, billing_currency, foreign_amount, invoice_fx_rate, invoice_fx_date::text
    FROM project_payments WHERE id IN (${list}) AND billing_currency IS NOT NULL AND upper(billing_currency) <> 'KRW'`)).rows as FxBillRow[];
  if (!bills.length) return out;
  const fxList = sql.join(bills.map((b) => sql`${b.id}`), sql`, `);
  const txns = (await dbx.execute(sql`SELECT project_payment_id, txn_type, currency, foreign_amount, fx_rate, krw_amount, fee_amount, offset_source_payment_id, paid_date::text
    FROM payment_transactions WHERE project_payment_id IN (${fxList}) OR offset_source_payment_id IN (${fxList})`)).rows as any[];
  return summarizeFxBills(bills, txns);
}
// 외화 청구회차 + 관련 입금거래(해당 회차 거래 · 해당 회차를 상계 원천으로 쓴 거래) → 요약. 거래 목록은 더 많아도 된다(회차별로 골라 씀).
export function summarizeFxBills(bills: FxBillRow[], txns: any[]): Map<number, FxSummary> {
  const out = new Map<number, FxSummary>();
  for (const b of bills) {
    out.set(Number(b.id), summarizeFxRow(b, txns.filter((t) => Number(t.project_payment_id) === Number(b.id)),
      txns.filter((t) => t.txn_type === "offset" && Number(t.offset_source_payment_id) === Number(b.id))));
  }
  return out;
}

// 통화별 합계(서로 다른 통화는 합산하지 않음) — 수금관리 상단 요약용
export function sumFxByCurrency(list: FxSummary[]) {
  const m = new Map<string, { billed: bigint; paid: bigint; receivable: bigint; krwConfirmed: number; unconfirmed: number; review: number; count: number }>();
  for (const s of list) {
    const a = m.get(s.currency) ?? { billed: 0n, paid: 0n, receivable: 0n, krwConfirmed: 0, unconfirmed: 0, review: 0, count: 0 };
    a.billed += toScaled(s.billedForeign, 2) ?? 0n; a.paid += toScaled(s.paidForeign, 2) ?? 0n; a.receivable += toScaled(s.receivableForeign, 2) ?? 0n;
    a.krwConfirmed += s.depositKrwConfirmed; a.unconfirmed += s.unconfirmedCount; a.review += s.status === "review" ? 1 : 0; a.count++;
    m.set(s.currency, a);
  }
  return [...m.entries()].map(([currency, a]) => ({ currency, count: a.count, billed: fromScaled(a.billed, 2), paid: fromScaled(a.paid, 2), receivable: fromScaled(a.receivable, 2),
    krwConfirmed: a.krwConfirmed, unconfirmedCount: a.unconfirmed, reviewCount: a.review }));
}
