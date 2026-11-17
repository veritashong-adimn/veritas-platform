// ─── 지급완료 확인 창(단일) — 지급일 · 실제 지급금액 · 증빙(선택) ─────────────────────────────
//  이미 지급된 건을 확인해 기록하는 창이다(송금·지급 실행 아님). 저장하면 즉시 지급완료로 반영되고,
//  새 지급회차·이체는 만들지 않는다. 단건은 지급일·금액을 이 창에서 확인·수정하고, 일괄은 행에 입력한 값으로 목록만 보여준다.
import React, { useState } from 'react';
import { ModalOverlay, PrimaryBtn, GhostBtn } from '../ui';

export type PaidConfirmLine = { id: number; name: string | null; date: string; amount: string };
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const toNum = (v: string) => Number(String(v).replace(/,/g, ''));
const inp: React.CSSProperties = { fontSize: 13, padding: '6px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontFamily: 'inherit', outline: 'none' };

export function PayoutPaidConfirmDialog({ lines, busy = false, onCancel, onConfirm }: {
  lines: PaidConfirmLine[];
  busy?: boolean;
  onCancel: () => void;
  /** 단건이면 수정된 지급일·금액, 일괄이면 lines 그대로 + 증빙(빈 문자열 = 미입력) */
  onConfirm: (result: { lines: PaidConfirmLine[]; evidence: string }) => void;
}) {
  const single = lines.length === 1;
  const today = kstToday();
  const [date, setDate] = useState(lines[0]?.date ?? '');
  const [amount, setAmount] = useState(lines[0]?.amount ?? '');
  const [evidence, setEvidence] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    const out = single ? [{ ...lines[0], date, amount }] : lines;
    const bad = out.filter(l => !/^\d{4}-\d{2}-\d{2}$/.test(l.date) || l.date > today || !(toNum(l.amount) > 0));
    if (bad.length) { setErr(single ? '지급일(오늘 이전)과 실제 지급금액을 입력하세요.' : `지급일(오늘 이전)과 지급금액을 확인하세요 — ${bad.map(l => l.name ?? `#${l.id}`).slice(0, 5).join(', ')}`); return; }
    onConfirm({ lines: out, evidence: evidence.trim() });
  };
  const total = (single ? toNum(amount) : lines.reduce((a, l) => a + toNum(l.amount), 0)) || 0;

  return (
    <ModalOverlay onClose={busy ? undefined : onCancel} maxWidth={460}>
      <div data-testid="payout-paid-confirm-dialog" role="dialog" aria-label="지급완료 확인">
        <div style={{ fontSize: 16, fontWeight: 800, color: '#111827' }}>지급완료 확인{single ? '' : ` ${lines.length}건`}</div>
        <div style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 14px' }}>이미 지급된 건으로 기록합니다(송금 실행 아님). 저장하면 바로 지급완료로 반영됩니다.</div>

        {single ? (
          <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr', gap: '8px 10px', alignItems: 'center', fontSize: 13 }}>
            <span style={{ color: '#6b7280' }}>대상</span><span style={{ fontWeight: 700 }}>{lines[0].name ?? `#${lines[0].id}`}</span>
            <label htmlFor="paid-confirm-date" style={{ color: '#6b7280' }}>지급일</label>
            <input id="paid-confirm-date" type="date" value={date} max={today} onChange={e => setDate(e.target.value)} style={inp}
              data-testid="input-paid-confirm-date" aria-label="지급일" />
            <label htmlFor="paid-confirm-amount" style={{ color: '#6b7280' }}>실제 지급금액</label>
            <input id="paid-confirm-amount" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))} style={{ ...inp, textAlign: 'right' }}
              inputMode="numeric" data-testid="input-paid-confirm-amount" aria-label="실제 지급금액" />
          </div>
        ) : (
          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #f1f5f9', borderRadius: 8, fontSize: 12 }}>
            {lines.map(l => (
              <div key={l.id} style={{ display: 'flex', gap: 8, padding: '5px 10px', borderBottom: '1px solid #f8fafc' }}>
                <span style={{ flex: 1 }}>{l.name ?? `#${l.id}`}</span><span style={{ color: '#6b7280' }}>{l.date || '지급일 없음'}</span>
                <span style={{ minWidth: 90, textAlign: 'right' }}>{toNum(l.amount) ? `${Math.round(toNum(l.amount)).toLocaleString()}원` : '-'}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, margin: '10px 0 12px' }}>합계 {Math.round(total).toLocaleString()}원</div>

        <label htmlFor="paid-confirm-evidence" style={{ fontSize: 12, color: '#6b7280' }}>증빙 (선택)</label>
        <textarea id="paid-confirm-evidence" value={evidence} onChange={e => setEvidence(e.target.value)} rows={2}
          placeholder="예: 2026-11-17 기업은행 이체내역 확인" style={{ ...inp, width: '100%', boxSizing: 'border-box', marginTop: 4, resize: 'vertical' }}
          data-testid="input-paid-confirm-evidence" aria-label="지급 증빙(선택)" />

        {err && <div data-testid="paid-confirm-error" style={{ color: '#b91c1c', fontSize: 12, marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <GhostBtn onClick={onCancel} disabled={busy} data-testid="btn-paid-confirm-cancel" aria-label="취소">취소</GhostBtn>
          <PrimaryBtn onClick={submit} disabled={busy} data-testid="btn-paid-confirm-save" aria-label="지급완료로 저장">{busy ? '저장 중…' : '지급완료 저장'}</PrimaryBtn>
        </div>
      </div>
    </ModalOverlay>
  );
}

export default PayoutPaidConfirmDialog;
