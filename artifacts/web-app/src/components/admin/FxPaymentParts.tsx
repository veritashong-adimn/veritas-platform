// ─────────────────────────────────────────────────────────────────────────────
// 외화 청구·입금 화면 부품 — 판매상세 D.청구정보(PaymentInfoSection)에서 결제방법 '외화입금' 회차에만 사용.
//  · 외화 금액은 해당 통화 단위(EUR 5,161.34)로 입력·표시하고, 원화 환산액은 옆에 별도 표시(서로 합산하지 않음).
//  · 원화 환산 = 외화 × 적용환율(외화 1단위당 원화, JPY 는 100엔당 입력) — decimal 계산(lib/fxMoney).
//  · 환율이 없으면 원화 금액을 추측하지 않고 '원화 환산 확인 필요'로 표시한다.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { ClickSelect } from '../ui';
import { C } from '../../lib/ds';
import { DateField } from './DatePickerShared';
import {
  FX_CURRENCY_OPTS, rateLabel, ratePer1FromInput, krwOf, cleanForeignInput, cleanRateInput, fmtForeign, fmtWon,
  addScaled, subScaled, cmpScaled, toScaled, FX_STATUS_LABEL, FX_STATUS_STYLE, fxBasisLabel, type FxSummary, type FxStatus,
} from '../../lib/fxMoney';

export const BILL_CURRENCY_OPTS = [{ value: 'KRW', label: 'KRW (원화 청구)' }, ...FX_CURRENCY_OPTS];

// 편집 중 외화 회차 상태(PaymentInfoSection PayRow 의 외화 필드 부분집합)
export interface FxEditRow {
  billingCurrency?: string | null; foreignAmount?: string | null; invoiceFxRateInput?: string; invoiceFxDate?: string | null;
  amount?: string | number | null; paidDate?: string | null;
  _foreign?: string; _rateInput?: string; _krw?: string; _fee?: string; _paidDate?: string | null;
  transactions?: { id?: number; txnType?: string | null; foreignAmount?: unknown }[];
  _txnId?: number;
}

const small: React.CSSProperties = { fontSize: 11, color: C.textSecondary };
const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#374151', whiteSpace: 'nowrap' };
const box: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' };
const unitTag = (t: string) => <span style={{ fontSize: 12, fontWeight: 700, color: '#4338ca', minWidth: 30 }}>{t}</span>;

export function FxStatusBadge({ status, title }: { status: FxStatus; title?: string }) {
  const st = FX_STATUS_STYLE[status];
  return <span title={title} data-testid="fx-status" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 700, background: st.bg, color: st.color }}>{FX_STATUS_LABEL[status]}</span>;
}

// 입금 1건의 원화 환산 미리보기(직접 입력 > 외화×환율)
export function previewKrw(foreign: unknown, rateInput: unknown, cur: string, krwOverride?: string): number | null {
  if (krwOverride && Number(krwOverride) > 0) return Math.round(Number(krwOverride));
  return krwOf(foreign, ratePer1FromInput(rateInput, cur));
}

// ── 편집모드 외화 패널(청구행 아래 한 줄) ──
export function FxEditPanel({ row, idx, onPatch, inp, firstPayMode }: {
  row: FxEditRow; idx: number; onPatch: (p: Partial<FxEditRow>) => void; inp: React.CSSProperties; firstPayMode: boolean;
}) {
  const cur = String(row.billingCurrency ?? 'KRW').toUpperCase();
  const foreign = cur !== 'KRW';
  const invoiceKrw = foreign ? krwOf(row.foreignAmount, ratePer1FromInput(row.invoiceFxRateInput, cur)) : null;
  const billKrw = Math.round(Number(String(row.amount ?? 0).replace(/,/g, '')) || 0);
  const depKrw = previewKrw(row._foreign, row._rateInput, cur, row._krw);
  // 미리보기 외화 미수금 = 청구 − (다른 거래 + 이번 입력)
  const others = (row.transactions ?? []).filter(t => t.id !== row._txnId).map(t => t.foreignAmount);
  const paid = addScaled([...others, row._foreign]);
  const recv = row.foreignAmount ? (cmpScaled(paid, row.foreignAmount) >= 0 ? '0.00' : subScaled(row.foreignAmount, paid)) : null;
  const w = (n: number): React.CSSProperties => ({ ...inp, width: n, textAlign: 'right' });
  return (
    <div data-testid={`fx-panel-${idx}`} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px 10px 28px', background: '#f8fafc', borderRadius: 6 }}>
      {/* A. 외화 청구정보 */}
      <div style={box}>
        <span style={{ ...lbl, color: '#4338ca' }}>A. 외화 청구</span>
        <span style={lbl}>청구통화</span>
        <div style={{ width: 150 }} data-testid={`fx-bill-cur-${idx}`}>
          <ClickSelect value={cur} onChange={(v: string) => onPatch({ billingCurrency: v })} triggerStyle={inp} options={BILL_CURRENCY_OPTS} />
        </div>
        {foreign ? <>
          <span style={lbl}>외화 청구금액</span>
          <input style={w(120)} inputMode="decimal" placeholder="0.00" value={row.foreignAmount ?? ''} data-testid={`fx-bill-amt-${idx}`} aria-label="외화 청구금액"
            onChange={e => onPatch({ foreignAmount: cleanForeignInput(e.target.value, cur) })} />{unitTag(cur)}
          <span style={lbl}>인보이스 환율</span><span style={small}>{rateLabel(cur)}</span>
          <input style={w(110)} inputMode="decimal" placeholder="환율" value={row.invoiceFxRateInput ?? ''} data-testid={`fx-bill-rate-${idx}`} aria-label="인보이스 적용환율"
            onChange={e => onPatch({ invoiceFxRateInput: cleanRateInput(e.target.value) })} /><span style={small}>원</span>
          <span style={lbl}>기준일</span>
          <DateField style={{ ...inp, width: 124 }} value={row.invoiceFxDate ?? ''} onChange={v => onPatch({ invoiceFxDate: v || null })} testid={`fx-bill-date-${idx}`} ariaLabel="환율 기준일" />
          <span style={small} data-testid={`fx-bill-krw-${idx}`}>
            원화 기준 청구금액 <b>{fmtWon(billKrw)}</b>
            {invoiceKrw != null && <> · 외화×환율 {fmtWon(invoiceKrw)}{invoiceKrw !== billKrw && <span style={{ color: '#b45309' }}> (차이 {fmtWon(invoiceKrw - billKrw)} — 판매금액은 바꾸지 않음)</span>}</>}
          </span>
        </> : <span style={small}>원화 청구 — 기존 원화 입금 방식(입금액 칸)으로 입력합니다.</span>}
      </div>
      {/* B. 실제 외화 입금정보 — 첫 입금(거래 0~1건)만 여기서 입력. 2건 이상은 조회 화면 하위행에서 추가·관리 */}
      {foreign && (firstPayMode ? (
        <div style={box}>
          <span style={{ ...lbl, color: '#047857' }}>B. 실제 외화 입금</span>
          <span style={lbl}>입금액</span>
          <input style={w(120)} inputMode="decimal" placeholder="0.00" value={row._foreign ?? ''} data-testid={`fx-dep-amt-${idx}`} aria-label={`실제 입금액(${cur})`}
            onChange={e => onPatch({ _foreign: cleanForeignInput(e.target.value, cur) })} />{unitTag(cur)}
          <span style={lbl}>적용환율</span><span style={small}>{rateLabel(cur)}</span>
          <input style={w(110)} inputMode="decimal" placeholder="은행 자료" value={row._rateInput ?? ''} data-testid={`fx-dep-rate-${idx}`} aria-label="실제 입금 적용환율"
            onChange={e => onPatch({ _rateInput: cleanRateInput(e.target.value) })} /><span style={small}>원</span>
          <span style={lbl}>원화 환산액</span>
          <b data-testid={`fx-dep-krw-${idx}`} style={{ minWidth: 110, textAlign: 'right', color: depKrw != null ? '#111827' : '#c2410c' }}>
            {row._foreign ? (depKrw != null ? fmtWon(depKrw) : '원화 환산 확인 필요') : '—'}
          </b>
          <span style={small} title="은행 입금확인서의 원화 금액이 계산값과 다를 때만 입력(입력 시 이 값을 원화 환산액으로 저장)">은행 확인 원화액</span>
          <input style={w(110)} inputMode="numeric" placeholder="(선택)" value={row._krw ?? ''} data-testid={`fx-dep-krw-override-${idx}`} aria-label="은행 확인 원화 환산액"
            onChange={e => onPatch({ _krw: e.target.value.replace(/[^\d]/g, '') })} />
          <span style={lbl}>수수료</span>
          <input style={w(90)} inputMode="decimal" placeholder="0.00" value={row._fee ?? ''} data-testid={`fx-dep-fee-${idx}`} aria-label={`은행 수수료(${cur})`}
            onChange={e => onPatch({ _fee: cleanForeignInput(e.target.value, cur) })} />{unitTag(cur)}
          {recv != null && <span style={small} data-testid={`fx-dep-recv-${idx}`}>외화 미수금 <b style={{ color: toScaled(recv, 2)! > 0n ? C.danger : '#15803d' }}>{fmtForeign(cur, recv)}</b></span>}
          <span style={lbl}>실제 입금일</span>
          <DateField style={{ ...inp, width: 124 }} value={row._paidDate ?? row.paidDate ?? ''} onChange={v => onPatch({ _paidDate: v || null })} testid={`fx-dep-date-${idx}`} ariaLabel="실제 입금일" />
        </div>
      ) : <span style={small}>입금내역이 2건 이상인 회차입니다 — 조회 화면에서 회차를 펼쳐 입금·상계를 추가/관리하세요.</span>)}
    </div>
  );
}

// ── 조회모드 셀 ──
export function FxBilledCell({ krw, cur, foreign }: { krw: number; cur: string; foreign?: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
      <span>{fmtWon(krw)}</span>
      <span style={{ fontSize: 11, color: '#4338ca', fontWeight: 700 }}>{foreign ? fmtForeign(cur, foreign) : `${cur} 청구액 미입력`}</span>
    </div>
  );
}
export function FxPaidCell({ fx }: { fx: FxSummary }) {
  const hasDep = (toScaled(fx.depositForeign, 2) ?? 0n) > 0n, hasOff = (toScaled(fx.offsetForeign, 2) ?? 0n) > 0n;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }} data-testid="fx-paid">
      <span style={{ fontWeight: 700, color: hasDep || hasOff ? C.primaryText : C.textSecondary }}>{fmtForeign(fx.currency, fx.depositForeign)}</span>
      {hasDep && <span style={{ fontSize: 11, color: fx.unconfirmedCount ? '#c2410c' : C.textSecondary }}>
        {fx.unconfirmedCount ? (fx.depositKrwConfirmed ? `원화 환산 ${fmtWon(fx.depositKrwConfirmed)} + 확인 필요 ${fx.unconfirmedCount}건` : '원화 환산 확인 필요') : `원화 환산 ${fmtWon(fx.depositKrwConfirmed)}`}
      </span>}
      {hasOff && <span style={{ fontSize: 11, color: '#7c3aed' }}>상계 {fmtForeign(fx.currency, fx.offsetForeign)}</span>}
    </div>
  );
}
export function FxReceivableCell({ fx }: { fx: FxSummary }) {
  const r = fx.receivableForeign;
  const pos = r != null && (toScaled(r, 2) ?? 0n) > 0n;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }} data-testid="fx-recv">
      <span style={{ fontWeight: 700, color: pos ? C.danger : C.textSecondary }}>{r != null ? fmtForeign(fx.currency, r) : '—'}</span>
      {pos && <span style={{ fontSize: 11, color: C.textSecondary }} title={fxBasisLabel(fx.receivableKrwBasis)}>
        {fx.receivableKrwRef != null ? `원화 환산 ${fmtWon(fx.receivableKrwRef)}` : '원화 환산 확인 필요'}</span>}
      {(toScaled(fx.overpaidForeign, 2) ?? 0n) > 0n && <span style={{ fontSize: 11, color: '#3730a3' }}>초과입금 {fmtForeign(fx.currency, fx.overpaidForeign)}</span>}
    </div>
  );
}
// 하위 입금행 한 줄 텍스트
export function fxTxnText(t: { txnType?: string | null; currency?: string | null; foreignAmount?: unknown; fxRate?: unknown; krwAmount?: unknown; feeAmount?: unknown; offsetSourcePaymentId?: number | null }) {
  const cur = String(t.currency ?? '');
  if (t.txnType === 'offset') return `상계 ${fmtForeign(cur, t.foreignAmount)} (원천 청구회차 #${t.offsetSourcePaymentId ?? '?'}) — 실제 은행 입금 아님`;
  const krw = t.krwAmount != null && t.fxRate != null ? Number(t.krwAmount) : null;
  const rate = t.fxRate != null ? ` @ 1 ${cur} = ${Number(t.fxRate).toLocaleString('ko-KR', { maximumFractionDigits: 6 })}원` : '';
  return `${fmtForeign(cur, t.foreignAmount)} (${krw != null ? `원화 환산 ${fmtWon(krw)}` : '원화 환산 확인 필요'})${rate}${Number(t.feeAmount ?? 0) > 0 ? ` · 수수료 ${fmtForeign(cur, t.feeAmount)}` : ''}`;
}

// ── 2차+ 입금 / 상계 추가 폼(조회모드 하위행) ──
export function FxTxnAddForm({ paymentId, cur, token, busy, onSave, onCancel }: {
  paymentId: number; cur: string; token: string; busy: boolean;
  onSave: (txn: Record<string, unknown>) => void; onCancel: () => void;
}) {
  const [type, setType] = useState<'deposit' | 'offset'>('deposit');
  const [f, setF] = useState({ paidDate: new Date().toISOString().slice(0, 10), bank: '기업은행외화', amount: '', rate: '', krw: '', fee: '', note: '', source: '' });
  const [sources, setSources] = useState<{ id: number; projectId: number; sequence: number; saleTitle: string | null; overpaidForeign: string }[]>([]);
  useEffect(() => {
    if (type !== 'offset') return;
    fetch(api(`/api/admin/project-payments/${paymentId}/offset-sources`), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setSources(Array.isArray(d.rows) ? d.rows : [])).catch(() => setSources([]));
  }, [type, paymentId, token]);
  const tinp: React.CSSProperties = { padding: '4px 7px', borderRadius: 6, border: `1px solid ${C.g300}`, fontSize: 12, boxSizing: 'border-box' };
  const krw = previewKrw(f.amount, f.rate, cur, f.krw);
  const src = sources.find(s => String(s.id) === f.source);
  const over = src && f.amount && cmpScaled(f.amount, src.overpaidForeign) > 0;
  const canSave = !busy && (toScaled(f.amount, 2) ?? 0n) > 0n && (type === 'deposit' || (!!f.source && !over));
  const save = () => onSave(type === 'deposit'
    ? { txnType: 'deposit', method: '외화송금', paidDate: f.paidDate || null, bankAccount: f.bank || null, currency: cur, foreignAmount: f.amount,
        fxRate: ratePer1FromInput(f.rate, cur), krwAmount: f.krw ? Number(f.krw) : null, feeAmount: f.fee || null, note: f.note || null }
    : { txnType: 'offset', method: '상계', paidDate: f.paidDate || null, currency: cur, foreignAmount: f.amount, offsetSourcePaymentId: Number(f.source), note: f.note || null });
  return (
    <div style={{ paddingLeft: 28, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }} data-testid="fx-txn-add">
      <span style={{ fontWeight: 700, color: C.primaryText, fontSize: 12 }}>└ 외화 {type === 'deposit' ? '입금' : '상계'} 추가</span>
      <ClickSelect value={type} onChange={(v: string) => setType(v as 'deposit' | 'offset')} triggerStyle={{ ...tinp, width: 120 }}
        options={[{ value: 'deposit', label: '실제 입금' }, { value: 'offset', label: '선입금 상계' }]} />
      <DateField style={{ ...tinp, width: 128 }} value={f.paidDate} onChange={v => setF({ ...f, paidDate: v })} testid="fx-add-date" ariaLabel={type === 'deposit' ? '입금일' : '상계일'} />
      {type === 'offset' && (
        <div style={{ width: 280 }} data-testid="fx-add-source">
          <ClickSelect value={f.source} onChange={(v: string) => setF({ ...f, source: v })} triggerStyle={{ ...tinp, width: '100%' }}
            options={sources.length ? sources.map(s => ({ value: String(s.id), label: `#${s.id} ${s.saleTitle ?? ''} ${s.sequence}회차 · 잔액 ${fmtForeign(cur, s.overpaidForeign)}` })) : [{ value: '', label: '상계 가능한 초과입금 없음' }]} />
        </div>
      )}
      {type === 'deposit' && <ClickSelect value={f.bank} onChange={(v: string) => setF({ ...f, bank: v })} triggerStyle={{ ...tinp, width: 110 }}
        options={['국민은행', '기업은행', '우리은행', '기업은행외화'].map(b => ({ value: b, label: b }))} />}
      <input style={{ ...tinp, width: 100, textAlign: 'right', fontWeight: 700 }} inputMode="decimal" placeholder="0.00" value={f.amount} data-testid="fx-add-amount"
        aria-label={`${type === 'deposit' ? '입금액' : '상계금액'}(${cur})`} onChange={e => setF({ ...f, amount: cleanForeignInput(e.target.value, cur) })} />{unitTag(cur)}
      {type === 'deposit' && <>
        <span style={small}>{rateLabel(cur)}</span>
        <input style={{ ...tinp, width: 90, textAlign: 'right' }} inputMode="decimal" placeholder="환율" value={f.rate} data-testid="fx-add-rate" aria-label="입금 적용환율"
          onChange={e => setF({ ...f, rate: cleanRateInput(e.target.value) })} /><span style={small}>원</span>
        <b style={{ fontSize: 12, minWidth: 96, textAlign: 'right', color: krw != null ? '#111827' : '#c2410c' }} data-testid="fx-add-krw">{f.amount ? (krw != null ? fmtWon(krw) : '원화 환산 확인 필요') : '—'}</b>
        <input style={{ ...tinp, width: 90, textAlign: 'right' }} inputMode="numeric" placeholder="은행확인 원화" value={f.krw} aria-label="은행 확인 원화 환산액"
          onChange={e => setF({ ...f, krw: e.target.value.replace(/[^\d]/g, '') })} />
        <input style={{ ...tinp, width: 70, textAlign: 'right' }} inputMode="decimal" placeholder="수수료" value={f.fee} aria-label={`수수료(${cur})`}
          onChange={e => setF({ ...f, fee: cleanForeignInput(e.target.value, cur) })} />
      </>}
      <input style={{ ...tinp, width: 150 }} value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder={type === 'offset' ? '상계 근거' : '비고'} data-testid="fx-add-note" />
      {over && <span style={{ fontSize: 11, color: C.danger }}>상계금액이 원천 잔액보다 큽니다</span>}
      <button type="button" onClick={save} disabled={!canSave} data-testid="fx-add-save"
        style={{ padding: '6px 14px', borderRadius: 6, border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, background: canSave ? C.primary : '#9ca3af', cursor: canSave ? 'pointer' : 'not-allowed' }}>{busy ? '저장 중…' : '저장'}</button>
      <button type="button" onClick={onCancel} disabled={busy} data-testid="fx-add-cancel"
        style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.g300}`, background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
    </div>
  );
}

// ── 하단 요약: 통화별 외화 합계(원화와 합산하지 않음) ──
export function FxSummaryLine({ list }: { list: FxSummary[] }) {
  if (!list.length) return null;
  const by = new Map<string, FxSummary[]>();
  for (const s of list) by.set(s.currency, [...(by.get(s.currency) ?? []), s]);
  return (
    <div data-testid="fx-summary" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, padding: '8px 16px', background: '#eef2ff', borderRadius: 8, marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>
      {[...by.entries()].map(([cur, ss]) => {
        const billed = addScaled(ss.map(s => s.billedForeign)), paid = addScaled(ss.map(s => s.paidForeign)), recv = addScaled(ss.map(s => s.receivableForeign));
        const off = addScaled(ss.map(s => s.offsetForeign));
        const krw = ss.reduce((a, s) => a + s.depositKrwConfirmed, 0), unconf = ss.reduce((a, s) => a + s.unconfirmedCount, 0);
        const review = ss.filter(s => s.status === 'review');
        return (
          <div key={cur} style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, color: '#4338ca' }}>{cur}</span>
            <span>외화 청구 <b>{fmtForeign(cur, billed)}</b></span>
            <span>외화 수금 <b style={{ color: C.primaryText }}>{fmtForeign(cur, paid)}</b>{(toScaled(off, 2) ?? 0n) > 0n && <span style={small}> (상계 {fmtForeign(cur, off)} 포함)</span>}</span>
            <span>외화 미수금 <b style={{ color: (toScaled(recv, 2) ?? 0n) > 0n ? C.danger : C.textSecondary }}>{fmtForeign(cur, recv)}</b></span>
            <span>원화 환산 입금(확정) <b>{fmtWon(krw)}</b>{unconf > 0 && <span style={{ color: '#c2410c' }}> · 환율 미확정 {unconf}건 제외</span>}</span>
            {review.length > 0 && <span style={{ color: '#c2410c' }}>확인 필요 {review.length}건: {[...new Set(review.flatMap(s => s.reviewReasons))].join(', ')}</span>}
          </div>
        );
      })}
    </div>
  );
}
