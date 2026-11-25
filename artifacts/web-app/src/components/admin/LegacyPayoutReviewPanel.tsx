// ─── 과거 지급 확인 필요 — 지급완료 확인(개별·일괄) ─────────────────────────────────────
//  이미 완료된 지급을 '확인'하는 기능이다(송금·지급 실행 아님). 지급완료 확인 시 창 하나에서 실제 지급일·실제 지급액(필수)과
//  증빙(선택)을 받아 실제 지급확정 기록(수행정보 actual_payment_date/amount + 감사로그: 확인자·일시·근거)으로 남긴다.
//  지급예정일·원가·원천세 등 기존 값은 변경하지 않는다. 확인 전 표시: 지급예정(예정일 도래 전) / 확인 필요(예정일 경과·없음).
//  서버: POST /admin/projects/:id/legacy-payout-review/bulk (건별 처리·중복 확정 차단·건별 결과)
import { DateField } from './DatePickerShared';
import React, { useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { GhostBtn } from '../ui';
import { PayoutPaidConfirmDialog, type PaidConfirmLine } from './PayoutPaidConfirmDialog';

export type PayoutReviewItem = {
  assignmentId: number; performerName: string | null; costTotal: number | null; originalPreTax: number | null;
  expectedPaymentDate?: string | null; payDate?: string | null; suggestedPaidAmount?: number | null;
  payoutDisplay?: 'paid' | 'scheduled' | 'review' | null;
  // 외화 지급(수행정보 지급통화·외화 지급금액) — 원화 지급 건은 null
  payCurrency?: string | null; foreignAmount?: number | null;
};
const isForeign = (p?: PayoutReviewItem) => !!p?.payCurrency && p.payCurrency !== 'KRW';
const won = (v: number | null | undefined) => (v == null ? '-' : `${Math.round(v).toLocaleString()}원`);
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const inp: React.CSSProperties = { fontSize: 12, padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: 'inherit' };

export function LegacyPayoutReviewPanel({ projectId, token, items, onToast, onDone, onUnpaid, busyId }: {
  projectId: number; token: string; items: PayoutReviewItem[]; onToast: (m: string) => void; onDone: () => void | Promise<void>;
  onUnpaid: (assignmentId: number) => void; busyId: number | null;
}) {
  const today = kstToday();
  // 실제 지급일 기본값 = 과거 CRM 원본 지급일(확인된 기존 지급일 기록) › 없으면 지급예정일 — 이미 지난 경우만. 담당자가 확인·수정
  //   지급액 기본값 = 제안값(CRM 세후 → 세후 예상액)
  const dueOf = (p: PayoutReviewItem) => p.payDate ?? p.expectedPaymentDate ?? null;
  const [form, setForm] = useState<Record<number, { date: string; amount: string }>>(() =>
    Object.fromEntries(items.map(p => { const d = dueOf(p);
      // 외화 지급 건 = 수행정보 외화 지급금액이 기본값(원화 제안값 사용 안 함)
      const amount = isForeign(p) ? (p.foreignAmount != null ? String(p.foreignAmount) : '') : p.suggestedPaidAmount != null ? String(p.suggestedPaidAmount) : '';
      return [p.assignmentId, { date: d && d <= today ? d : '', amount }]; })));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Array<{ assignmentId: number; error: string }>>([]);
  const f = (id: number) => form[id] ?? { date: '', amount: '' };
  const setF = (id: number, patch: Partial<{ date: string; amount: string }>) => setForm(s => ({ ...s, [id]: { ...f(id), ...patch } }));
  const allSel = items.length > 0 && items.every(p => sel.has(p.assignmentId));
  const byId = useMemo(() => new Map(items.map(p => [p.assignmentId, p])), [items]);

  // 지급완료 확인 — 창 하나(지급일·실제 지급금액·증빙 선택). 저장하면 바로 지급완료 반영(새 지급거래 없음)
  const [dialog, setDialog] = useState<PaidConfirmLine[] | null>(null);
  const confirmPaid = (ids: number[]) => {
    if (!ids.length) { onToast('지급완료 확인할 건을 선택하세요.'); return; }
    setDialog(ids.map(id => { const p = byId.get(id);
      // 외화 지급 건은 0원 건이 아니다 — 외화 금액·통화로 확인
      const foreign = isForeign(p);
      const zeroOk = !!p && !foreign && !(Number(p.costTotal ?? 0) > 0) && !(Number(p.originalPreTax ?? 0) > 0);
      return { id, name: p?.performerName ?? null, date: f(id).date, amount: f(id).amount || (zeroOk ? '0' : ''), zeroOk, currency: foreign ? p!.payCurrency! : 'KRW' }; }));
  };
  const savePaid = async ({ lines, evidence }: { lines: PaidConfirmLine[]; evidence: string }) => {
    setBusy(true); setFailures([]);
    try {
      const r = await fetch(api(`/api/admin/projects/${projectId}/legacy-payout-review/bulk`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: evidence, items: lines.map(l => ({ assignmentId: l.id, actualPaymentDate: l.date, actualPaymentAmount: Number(l.amount.replace(/,/g, '')), actualPaymentCurrency: l.currency ?? 'KRW' })) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onToast(`지급완료 확인 실패: ${d.error ?? r.status}`); return; }
      const fails = (d.results ?? []).filter((x: any) => !x.ok);
      setFailures(fails);
      onToast(`지급완료 확인 ${d.succeeded}건${fails.length ? ` · 실패 ${fails.length}건(아래 사유 확인)` : ''}`);
      setSel(new Set()); setDialog(null);
      await onDone();
    } catch { onToast('처리 중 오류가 발생했습니다.'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid #fde68a', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }} data-testid="legacy-payout-review-panel">
      {dialog && <PayoutPaidConfirmDialog lines={dialog} busy={busy} onCancel={() => setDialog(null)} onConfirm={savePaid} />}
      <div style={{ padding: '6px 10px', background: '#fffbeb', fontSize: 12, fontWeight: 700, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>과거 지급 확인 필요 — 확인 전에는 지급회차·기업은행 대량이체에서 제외됩니다(지급예정일만으로 지급완료 처리하지 않음)</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <label style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(items.map(p => p.assignmentId)))} data-testid="chk-legacy-payout-all" aria-label="전체 선택" /> 전체
          </label>
          <GhostBtn onClick={() => confirmPaid([...sel])} disabled={busy || sel.size === 0} style={{ fontSize: 11, padding: '3px 8px' }}
            data-testid="btn-legacy-paid-bulk" aria-label="선택 건 지급완료 확인">{busy ? '처리 중…' : `선택 ${sel.size}건 지급완료 확인`}</GhostBtn>
        </span>
      </div>
      {failures.length > 0 && (
        <div data-testid="legacy-payout-failures" style={{ padding: '6px 10px', background: '#fef2f2', color: '#b91c1c', fontSize: 12 }}>
          {failures.map(x => <div key={x.assignmentId}>· {byId.get(x.assignmentId)?.performerName ?? `#${x.assignmentId}`}: {x.error}</div>)}
        </div>
      )}
      {items.map(p => {
        const due = dueOf(p);
        const st = p.payoutDisplay === 'scheduled' ? { t: '지급예정', c: '#1d4ed8', bg: '#eff6ff' } : { t: '확인 필요', c: '#b45309', bg: '#fef3c7' };
        return (
          <div key={p.assignmentId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderTop: '1px solid #fef3c7', fontSize: 12, flexWrap: 'wrap' }} data-testid={`legacy-payout-row-${p.assignmentId}`}>
            <input type="checkbox" checked={sel.has(p.assignmentId)} onChange={() => setSel(s => { const n = new Set(s); n.has(p.assignmentId) ? n.delete(p.assignmentId) : n.add(p.assignmentId); return n; })}
              data-testid={`chk-legacy-payout-${p.assignmentId}`} aria-label={`${p.performerName ?? p.assignmentId} 선택`} />
            <span style={{ minWidth: 90 }}>{p.performerName ?? '-'}</span>
            <span style={{ padding: '1px 7px', borderRadius: 999, background: st.bg, color: st.c, fontWeight: 700 }} data-testid={`legacy-payout-status-${p.assignmentId}`}>{st.t}</span>
            {isForeign(p)
              ? <span data-testid={`legacy-payout-foreign-${p.assignmentId}`} style={{ fontWeight: 700, color: '#1d4ed8' }}>외화 지급 {p.payCurrency} {p.foreignAmount != null ? p.foreignAmount.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '미입력'}</span>
              : <span>원가 {won(p.costTotal)}</span>}
            <span style={{ color: '#6b7280' }}>지급예정일 {due ?? '없음'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>실제 지급일
              <DateField value={f(p.assignmentId).date} max={today} onChange={v => setF(p.assignmentId, { date: v })} style={inp}
                testid={`input-legacy-paid-date-${p.assignmentId}`} ariaLabel={`${p.performerName ?? ''} 실제 지급일`} /></span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>실제 지급액{isForeign(p) ? `(${p.payCurrency})` : ''}
              <input value={f(p.assignmentId).amount} onChange={e => setF(p.assignmentId, { amount: e.target.value.replace(/[^0-9.,]/g, '') })} style={{ ...inp, width: 96, textAlign: 'right' }}
                data-testid={`input-legacy-paid-amount-${p.assignmentId}`} aria-label={`${p.performerName ?? ''} 실제 지급액`} /></span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <GhostBtn onClick={() => confirmPaid([p.assignmentId])} disabled={busy || busyId === p.assignmentId} style={{ fontSize: 11, padding: '3px 8px' }}
                data-testid={`btn-legacy-paid-${p.assignmentId}`} aria-label="과거 지급완료로 확인">지급완료 확인</GhostBtn>
              <GhostBtn onClick={() => onUnpaid(p.assignmentId)} disabled={busy || busyId === p.assignmentId} style={{ fontSize: 11, padding: '3px 8px' }}
                data-testid={`btn-legacy-unpaid-${p.assignmentId}`} aria-label="미지급으로 확인">미지급 확인</GhostBtn>
            </span>
          </div>
        );
      })}
    </div>
  );
}
