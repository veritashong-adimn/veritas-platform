// ─────────────────────────────────────────────────────────────────────────────
// 카드결제 수수료 — 청구정보(PaymentInfoSection) 보조 컴포넌트.
//  · 저장 구조(기존 payment_transactions 컬럼 재사용, 스키마 변경 없음):
//      실제 입금액 = settled_amount · 카드사 수수료 = fee_amount · 고객결제액(customer_paid_amount) = 실제 입금액 + 수수료
//  · 미수금 = 청구금액 − 고객결제액 = 청구금액 − 실제 입금액 − 수수료(기존 미수금 공식 그대로 — 판매목록·수금관리 동일 반영).
//  · 수수료는 매출 할인·미수금이 아니라 별도 비용(fee_amount). 매출(청구금액)은 바꾸지 않는다.
//  · 수수료율 = 수수료 ÷ 청구금액 × 100(표시 소수 2자리). 수수료율을 입력하면 수수료 = 청구금액 × 율 ÷ 100(원 단위 반올림).
//  · 수수료가 입력되지 않은 기존 카드 거래는 그대로(임의 생성·입금완료 처리 없음).
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { C } from '../../lib/ds';

const n = (v: unknown) => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
const won = (v: number) => Math.round(v).toLocaleString('ko-KR');
export const isCardMethod = (m?: string | null) => ['카드', '신용카드', 'card'].includes(String(m ?? '').trim());
export const feeRateText = (fee: number, billed: number) => (billed > 0 && fee > 0 ? `${(fee / billed * 100).toFixed(2)}%` : '—');
export const feeFromRate = (rateInput: string, billed: number) => String(Math.round(billed * n(rateInput) / 100));

type Txn = { method?: string | null; customerPaidAmount?: unknown; settledAmount?: unknown; feeAmount?: unknown };
/** 카드 거래 합계 — 실제 입금액(정산액, 없으면 고객결제액 − 수수료)·수수료·고객결제액 */
export function cardTotals(txns: Txn[]) {
  let settled = 0, fee = 0, paid = 0;
  for (const t of txns) {
    const f = n(t.feeAmount), p = n(t.customerPaidAmount);
    fee += f; paid += p;
    settled += t.settledAmount != null && t.settledAmount !== '' ? n(t.settledAmount) : p - f;
  }
  return { settled, fee, paid };
}

/** 조회: 입금액 셀 — 실제 입금액 + (수수료·수수료율) */
export function CardPaidCell({ txns, billed }: { txns: Txn[]; billed: number }) {
  const t = cardTotals(txns);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }} data-testid="card-paid-cell">
      <span style={{ fontWeight: 700, color: t.settled > 0 ? C.primaryText : C.textSecondary }} title="실제 입금액">{won(t.settled)}원</span>
      {t.fee > 0 && <span style={{ fontSize: 11, color: C.textSecondary }} title="카드사 수수료(별도 비용) · 수수료율 = 수수료 ÷ 청구금액">수수료 {won(t.fee)}원 · {feeRateText(t.fee, billed)}</span>}
    </div>
  );
}

/** 편집: 카드결제 첫 입금 — 청구금액 · 실제 입금액 · 카드사 수수료 · 수수료율 · 미수금 */
export function CardFeeEditPanel({ billed, paidInput, feeInput, rateInput, inp, idx, onPatch }: {
  billed: number; paidInput?: string; feeInput?: string; rateInput?: string; inp: React.CSSProperties; idx: number;
  onPatch: (p: { _paidAmt?: string; _cardFee?: string; _cardRate?: string }) => void;
}) {
  const paid = n(paidInput), fee = n(feeInput);
  const receivable = Math.max(billed - paid - fee, 0);
  const lab: React.CSSProperties = { fontSize: 11.5, color: C.textSecondary, whiteSpace: 'nowrap' };
  const box: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5 };
  const numInp = (v: string | undefined, on: (s: string) => void, testid: string, label: string, w = 120) => (
    <input type="text" inputMode="numeric" value={v ? won(n(v)) : ''} placeholder="0" data-testid={testid} aria-label={label}
      onChange={e => on(e.target.value.replace(/[^\d]/g, ''))} style={{ ...inp, width: w, textAlign: 'right' }} />
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', paddingLeft: 28 }} data-testid={`card-fee-panel-${idx}`}>
      <b style={{ fontSize: 12, color: C.primaryText }}>카드결제</b>
      <span style={box}><span style={lab}>청구금액</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>{won(billed)}원</b></span>
      <span style={box}><span style={lab}>실제 입금액</span>{numInp(paidInput, v => onPatch({ _paidAmt: v }), `card-paid-${idx}`, '실제 입금액')}</span>
      <span style={box}><span style={lab}>카드사 수수료</span>
        {numInp(feeInput, v => onPatch({ _cardFee: v, _cardRate: undefined }), `card-fee-${idx}`, '카드사 수수료', 100)}</span>
      <span style={box}><span style={lab}>수수료율</span>
        <input type="text" inputMode="decimal" data-testid={`card-rate-${idx}`} aria-label="수수료율(%)"
          value={rateInput ?? (fee > 0 && billed > 0 ? (fee / billed * 100).toFixed(2) : '')} placeholder="0.00"
          onChange={e => { const v = e.target.value.replace(/[^\d.]/g, ''); onPatch({ _cardRate: v, _cardFee: v ? feeFromRate(v, billed) : '' }); }}
          onBlur={() => onPatch({ _cardRate: undefined })}
          style={{ ...inp, width: 70, textAlign: 'right' }} />%</span>
      <span style={box}><span style={lab}>미수금</span>
        <b style={{ color: receivable > 0 ? C.danger : C.textSecondary, fontVariantNumeric: 'tabular-nums' }} data-testid={`card-receivable-${idx}`}>{won(receivable)}원</b></span>
      <span style={{ fontSize: 11, color: C.textMuted }}>미수금 = 청구금액 − 실제 입금액 − 수수료 · 수수료는 매출 차감 없이 별도 비용</span>
    </div>
  );
}
