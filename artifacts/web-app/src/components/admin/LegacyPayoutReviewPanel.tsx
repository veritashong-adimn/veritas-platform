// ─── 과거 지급 확인 필요 — 지급완료 확인(개별·일괄) ─────────────────────────────────────
//  이미 완료된 지급을 '확인'하는 기능이다(송금·지급 실행 아님). 지급완료 확인 시 실제 지급일·실제 지급액·확인 근거를
//  필수로 받아 실제 지급확정 기록(수행정보 actual_payment_date/amount + 감사로그: 확인자·일시·근거)으로 남긴다.
//  지급예정일·원가·원천세 등 기존 값은 변경하지 않는다. 확인 전 표시: 지급예정(예정일 도래 전) / 확인 필요(예정일 경과·없음).
//  서버: POST /admin/projects/:id/legacy-payout-review/bulk (건별 처리·중복 확정 차단·건별 결과)
import React, { useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { GhostBtn, confirmDialog, promptDialog } from '../ui';

export type PayoutReviewItem = {
  assignmentId: number; performerName: string | null; costTotal: number | null; originalPreTax: number | null;
  expectedPaymentDate?: string | null; payDate?: string | null; suggestedPaidAmount?: number | null;
  payoutDisplay?: 'paid' | 'scheduled' | 'review' | null;
};
const won = (v: number | null | undefined) => (v == null ? '-' : `${Math.round(v).toLocaleString()}원`);
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const inp: React.CSSProperties = { fontSize: 12, padding: '3px 6px', border: '1px solid #e5e7eb', borderRadius: 6, fontFamily: 'inherit' };

export function LegacyPayoutReviewPanel({ projectId, token, items, onToast, onDone, onUnpaid, busyId }: {
  projectId: number; token: string; items: PayoutReviewItem[]; onToast: (m: string) => void; onDone: () => void | Promise<void>;
  onUnpaid: (assignmentId: number) => void; busyId: number | null;
}) {
  const today = kstToday();
  const dueOf = (p: PayoutReviewItem) => p.expectedPaymentDate ?? p.payDate ?? null;
  // 실제 지급일 기본값 = 지급예정일(이미 지난 경우만), 지급액 기본값 = 제안값(CRM 세후 → 세후 예상액). 담당자가 확인·수정
  const [form, setForm] = useState<Record<number, { date: string; amount: string }>>(() =>
    Object.fromEntries(items.map(p => { const d = dueOf(p); return [p.assignmentId, { date: d && d <= today ? d : '', amount: p.suggestedPaidAmount != null ? String(p.suggestedPaidAmount) : '' }]; })));
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Array<{ assignmentId: number; error: string }>>([]);
  const f = (id: number) => form[id] ?? { date: '', amount: '' };
  const setF = (id: number, patch: Partial<{ date: string; amount: string }>) => setForm(s => ({ ...s, [id]: { ...f(id), ...patch } }));
  const allSel = items.length > 0 && items.every(p => sel.has(p.assignmentId));
  const byId = useMemo(() => new Map(items.map(p => [p.assignmentId, p])), [items]);

  const confirmPaid = async (ids: number[]) => {
    if (!ids.length) { onToast('지급완료 확인할 건을 선택하세요.'); return; }
    const bad = ids.filter(id => !/^\d{4}-\d{2}-\d{2}$/.test(f(id).date) || f(id).date > today || !(Number(f(id).amount.replace(/,/g, '')) > 0));
    if (bad.length) { onToast(`실제 지급일(오늘 이전)과 지급액을 입력하세요 — ${bad.map(id => byId.get(id)?.performerName ?? `#${id}`).slice(0, 5).join(', ')}${bad.length > 5 ? ` 외 ${bad.length - 5}건` : ''}`); return; }
    const total = ids.reduce((a, id) => a + Number(f(id).amount.replace(/,/g, '')), 0);
    const lines = ids.slice(0, 12).map(id => `· ${byId.get(id)?.performerName ?? `#${id}`} — 지급일 ${f(id).date} · ${won(Number(f(id).amount.replace(/,/g, '')))}`).join('\n');
    const ok = await confirmDialog({
      title: `지급완료 확인 ${ids.length}건`,
      message: `이미 지급된 건으로 확정합니다(송금 실행 아님). 지급회차·대량이체 대상에서 계속 제외됩니다.\n\n${lines}${ids.length > 12 ? `\n· … 외 ${ids.length - 12}건` : ''}\n\n합계 ${won(total)}`,
      confirmLabel: '다음(증빙 입력)', cancelLabel: '취소',
    });
    if (!ok) return;
    const reason = await promptDialog({
      title: '지급 증빙 확인', message: '실제 지급을 확인한 근거를 입력하세요(통장 이체내역·지급파일 등).',
      placeholder: '예: 2026-11-13 기업은행 대량이체 내역 확인', confirmLabel: '지급완료 확인',
    });
    if (reason == null || !reason.trim()) return;
    setBusy(true); setFailures([]);
    try {
      const r = await fetch(api(`/api/admin/projects/${projectId}/legacy-payout-review/bulk`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), items: ids.map(id => ({ assignmentId: id, actualPaymentDate: f(id).date, actualPaymentAmount: Number(f(id).amount.replace(/,/g, '')) })) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onToast(`지급완료 확인 실패: ${d.error ?? r.status}`); return; }
      const fails = (d.results ?? []).filter((x: any) => !x.ok);
      setFailures(fails);
      onToast(`지급완료 확인 ${d.succeeded}건${fails.length ? ` · 실패 ${fails.length}건(아래 사유 확인)` : ''}`);
      setSel(new Set());
      await onDone();
    } catch { onToast('처리 중 오류가 발생했습니다.'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid #fde68a', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }} data-testid="legacy-payout-review-panel">
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
            <span>원가 {won(p.costTotal)}</span>
            <span style={{ color: '#6b7280' }}>지급예정일 {due ?? '없음'}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>실제 지급일
              <input type="date" value={f(p.assignmentId).date} max={today} onChange={e => setF(p.assignmentId, { date: e.target.value })} style={inp}
                data-testid={`input-legacy-paid-date-${p.assignmentId}`} aria-label={`${p.performerName ?? ''} 실제 지급일`} /></span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>실제 지급액
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
