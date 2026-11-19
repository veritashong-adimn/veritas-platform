// ─────────────────────────────────────────────────────────────────────────────
// 지급 정정·관리자 승인·차액 정산 현황(2026-11 승인) — payout_adjustments.
//  · mode="project": 판매 상세 > 수행정보 하단(이 판매건 요청만). 요청이 없으면 렌더하지 않는다.
//  · mode="admin"  : 정산 > 지급회차 관리 상단(전체 현황 + 회차 편입·정산 확인).
//  · 버튼 노출은 편의 판단일 뿐이며 권한·요청자≠승인자·중복 편입 방지는 서버가 최종 강제한다.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { formatDisplayDate } from '../../lib/dateFormat';
import { Card, GhostBtn, ClickSelect, confirmDialog, promptDialog } from '../ui';
import { C, TYPO, BD } from '../../lib/ds';

type Adj = Record<string, any>;
type Summary = Record<string, any>;
const won = (v: unknown) => `${Math.round(Number(v) || 0).toLocaleString('ko-KR')}원`;
const signed = (v: unknown, cur = 'KRW') => {
  const n = Number(v) || 0;
  const s = n > 0 ? '+' : n < 0 ? '−' : '';
  return cur === 'KRW' ? `${s}${Math.abs(Math.round(n)).toLocaleString('ko-KR')}원` : `${s}${cur} ${Math.abs(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`;
};
const SETTLE_TYPE: Record<string, string> = {
  additional_payment: '추가지급', offset: '다음 회차 상계', refund: '환수', none: '차액 없음',
  additional_remittance: '추가 송금(외화)', foreign_refund: '환수(외화)', foreign_offset: '상계(외화)',
};
const SETTLE_STATUS: Record<string, string> = { open: '정산 대기', scheduled: '회차 편입', settled: '정산 완료' };
const ACTION_LABEL: Record<string, string> = {
  payout_adjustment_requested: '요청', payout_adjustment_approved: '승인', payout_adjustment_rejected: '반려', payout_adjustment_cancelled: '취소',
  payout_adjustment_settlement_type: '정산 방식 변경', payout_adjustment_scheduled: '지급회차 편입', payout_adjustment_unscheduled: '편입 해제', payout_adjustment_settled: '정산 완료',
};

function useCurrentUserId(token: string): number | null {
  return useMemo(() => {
    try { const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(decodeURIComponent(escape(atob(b)))).id ?? null; } catch { return null; }
  }, [token]);
}

export function PayoutAdjustmentList({ mode, token, projectId, refreshKey, onToast, onChanged, initialFilter, focus }: {
  mode: 'project' | 'admin'; token: string; projectId?: number; refreshKey?: string | number;
  onToast: (m: string) => void; onChanged?: () => void;
  initialFilter?: 'all' | 'requested' | 'pending' | 'done';   // 지급회차관리 기본 화면 바로가기에서 지정
  focus?: boolean;                                            // true 면 마운트 시 이 목록으로 스크롤
}) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const me = useCurrentUserId(token);
  const [rows, setRows] = useState<Adj[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [filter, setFilter] = useState<'all' | 'requested' | 'pending' | 'done'>(initialFilter ?? (mode === 'admin' ? 'requested' : 'all'));
  const [remitPick, setRemitPick] = useState<{ adj: Adj; records: any[] } | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) setTimeout(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 300); }, [focus]);
  const [rounds, setRounds] = useState<{ id: number; batchNumber: string | null; paymentDate: string; status: string }[]>([]);
  const [history, setHistory] = useState<{ id: number; rows: any[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(mode === 'admin');

  const load = useCallback(async () => {
    const url = mode === 'project' ? `/api/admin/projects/${projectId}/payout-adjustments` : '/api/admin/payout-adjustments';
    const res = await fetch(api(url), { headers: authH });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { setRows(data.rows ?? []); setSummary(data.summary ?? null); }
    if (mode === 'admin') {
      const rr = await fetch(api('/api/admin/payout-rounds'), { headers: authH });
      const rd = await rr.json().catch(() => ({}));
      if (rr.ok) setRounds((rd.rows ?? []).filter((r: any) => r.status === 'draft' || r.status === 'reviewing'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, projectId, token]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const act = async (path: string, body: any, ok: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-adjustments/${path}`), { method: 'POST', headers: authH, body: JSON.stringify(body ?? {}) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${data.error ?? '처리 실패'}`); return false; }
      const stale = data.transferResync?.staleLocked?.length;
      onToast(stale ? `${ok} (송금파일이 이미 생성된 송금건 ${stale}건은 금액이 달라 지급완료가 차단됩니다 — 송금파일 재확인 필요)` : ok);
      await load(); onChanged?.();
      return true;
    } catch { onToast('오류: 처리 중 오류가 발생했습니다.'); return false; } finally { setBusy(false); }
  };
  const approve = async (a: Adj) => {
    const note = await promptDialog({ title: `정정 #${a.id} 승인`, message: `${a.kind === 'confirmed_change' ? '지급확정 금액을 정정하고 해당 건의 확정 스냅샷을 갱신합니다.' : '수행정보를 정정하고 차액을 별도 정산 대상으로 등록합니다. 기존 지급기록은 바뀌지 않습니다.'}\n기존 ${fmtBefore(a)} → 정정 후 ${fmtAfter(a)} (차액 ${fmtDelta(a)})`, label: '승인 메모(선택)', confirmLabel: '승인', multiline: true });
    if (note === null) return;
    await act(`${a.id}/approve`, { note: note.trim() || null }, '정정 요청이 승인되었습니다.');
  };
  const reject = async (a: Adj) => {
    const note = await promptDialog({ title: `정정 #${a.id} 반려`, message: '반려하면 기존 금액이 그대로 유지됩니다.', label: '반려 사유', confirmLabel: '반려', multiline: true, validate: (v) => (v.trim() ? null : '반려 사유를 입력해 주세요.') });
    if (!note || !note.trim()) return;
    await act(`${a.id}/reject`, { note: note.trim() }, '정정 요청이 반려되었습니다.');
  };
  const cancel = async (a: Adj) => {
    if (!(await confirmDialog({ title: `정정 #${a.id} 요청 취소`, message: '승인 대기 중인 요청을 취소할까요? 기존 금액은 그대로입니다.', confirmLabel: '요청 취소', variant: 'warning' }))) return;
    await act(`${a.id}/cancel`, {}, '정정 요청이 취소되었습니다.');
  };
  const settle = async (a: Adj) => {
    if (a.settlementType === 'additional_remittance') {
      // 이 수행정보의 해외송금 내역만 조회해 선택(송금번호 직접 입력 없음). 기존 송금기록은 읽기만 한다.
      const res = await fetch(api(`/api/admin/performances/${a.assignmentId}/remittances`), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(`오류: ${data.error ?? '송금내역 조회 실패'}`); return; }
      setRemitPick({ adj: a, records: data.records ?? [] });
      return;
    }
    const ref = await promptDialog({ title: `정정 #${a.id} ${SETTLE_TYPE[a.settlementType] ?? '정산'} 확인`, message: `실제 ${a.settlementType === 'foreign_offset' ? '상계' : '환수 입금'}이 확인된 경우에만 완료 처리하세요.\n대상: ${deltaLabel(a)}`, label: '확인 근거(입금일·입금자·참조번호 등)', confirmLabel: '정산 완료', multiline: true, validate: (x) => (x.trim() ? null : '확인 근거를 입력해 주세요.') });
    if (!ref || !ref.trim()) return;
    await act(`${a.id}/settle`, { ref: ref.trim() }, `정정 #${a.id} 정산 완료로 기록했습니다.`);
  };
  const showHistory = async (a: Adj) => {
    if (history?.id === a.id) { setHistory(null); return; }
    const res = await fetch(api(`/api/admin/payout-adjustments/${a.id}/history`), { headers: authH });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { onToast(`오류: ${data.error ?? '이력 조회 실패'}`); return; }
    setHistory({ id: a.id, rows: data.rows ?? [] });
  };

  const visible = rows.filter((a) => filter === 'all' ? true
    : filter === 'requested' ? a.status === 'requested'
    : filter === 'pending' ? a.status === 'approved' && (a.settlementStatus === 'open' || a.settlementStatus === 'scheduled')
    : a.status !== 'requested' && !(a.status === 'approved' && (a.settlementStatus === 'open' || a.settlementStatus === 'scheduled')));
  if (mode === 'project' && rows.length === 0) return null;

  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '6px 8px', borderBottom: BD.grid, textAlign: 'left', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '7px 8px', borderBottom: BD.divider, fontSize: 12, verticalAlign: 'top' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const chip = (label: string, value: React.ReactNode, color: string, testid: string) => (
    <span data-testid={testid} style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline', padding: '4px 10px', borderRadius: 999, border: `1px solid ${C.border}`, fontSize: 12 }}>
      <span style={{ color: C.textSecondary }}>{label}</span><b style={{ color }}>{value}</b>
    </span>
  );
  const btn = (label: string, onClick: () => void, testid: string, danger = false) => (
    <button type="button" onClick={onClick} disabled={busy} data-testid={testid} aria-label={label}
      style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', border: `1px solid ${danger ? C.dangerBorder : C.border}`, background: C.white, color: danger ? C.dangerText : C.textPrimary, whiteSpace: 'nowrap' }}>{label}</button>
  );

  return (
    <div data-testid={`payout-adjustments-${mode}`} ref={rootRef}><Card style={{ marginTop: 12, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setOpen(o => !o)} data-testid="payout-adj-toggle" aria-label="정정·승인 현황 펼치기"
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontWeight: 700, fontSize: 14, color: C.textPrimary }}>
          {open ? '▾' : '▸'} 수정·정정 요청 / 승인 / 차액 정산
        </button>
        {summary && <>
          {chip('승인 대기', `${summary.requested}건`, summary.requested ? C.warningTextDeep : C.textSecondary, 'payout-adj-sum-requested')}
          {chip('추가 지급 대상', `${summary.additionalPayment?.count ?? 0}건 · ${won(summary.additionalPayment?.amount)}`, C.primaryText, 'payout-adj-sum-additional')}
          {chip('환수·상계 대상', `${summary.offsetRefund?.count ?? 0}건 · ${won(summary.offsetRefund?.amount)}`, C.dangerText, 'payout-adj-sum-offset')}
          {(summary.foreignPending?.length ?? 0) > 0 && chip('해외(외화) 정산 대기', summary.foreignPending.map((f: any) => signed(f.deltaForeign, f.currency)).join(', '), C.aiText, 'payout-adj-sum-foreign')}
          {summary.taxCorrection > 0 && chip('원천세 정정 필요', `${summary.taxCorrection}건`, C.warningTextDeep, 'payout-adj-sum-tax')}
          {summary.invoiceCorrection > 0 && chip('수정세금계산서 확인', `${summary.invoiceCorrection}건`, C.warningTextDeep, 'payout-adj-sum-invoice')}
        </>}
      </div>
      {open && <>
        <div style={{ display: 'flex', gap: 6, margin: '10px 0 6px' }}>
          {([['requested', '승인 대기'], ['pending', '정산 대기'], ['done', '완료·반려·취소'], ['all', '전체']] as const).map(([k, l]) => (
            <GhostBtn key={k} onClick={() => setFilter(k)} data-testid={`payout-adj-filter-${k}`} aria-label={`${l} 보기`}
              style={{ fontSize: 12, padding: '4px 10px', ...(filter === k ? { borderColor: C.primary, color: C.primaryText, fontWeight: 700 } : {}) }}>{l}</GhostBtn>
          ))}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>#</th>{mode === 'admin' && <th style={th}>판매건</th>}<th style={th}>수행·지급대상</th><th style={th}>구분</th><th style={th}>상태</th>
              <th style={{ ...th, textAlign: 'right' }}>기존</th><th style={{ ...th, textAlign: 'right' }}>정정 후</th><th style={{ ...th, textAlign: 'right' }}>차액</th>
              <th style={th}>사유</th><th style={th}>요청 / 승인</th><th style={th}>차액 정산</th><th style={th}>처리</th>
            </tr></thead>
            <tbody>
              {visible.length === 0 && <tr><td style={{ ...td, color: C.textMuted }} colSpan={12}>해당하는 요청이 없습니다.</td></tr>}
              {visible.map((a) => {
                const st = stateOf(a);
                const mine = me != null && a.requestedBy === me;
                const krw = a.currency === 'KRW';
                const neg = krw ? Number(a.deltaNet) < 0 : Number(a.deltaForeign) < 0;
                return (
                  <React.Fragment key={a.id}>
                    <tr data-testid={`payout-adj-row-${a.id}`}>
                      <td style={td}>{a.id}</td>
                      {mode === 'admin' && <td style={td}><a href={`/admin/projects/${a.projectId}`} style={{ color: C.primaryText }}>{a.projectTitle ?? `#${a.projectId}`}</a></td>}
                      <td style={td}>{a.productName ?? `수행 #${a.assignmentId}`}<div style={{ color: C.textSecondary }}>{a.payeeName ?? '-'}</div></td>
                      <td style={td}>{a.kind === 'confirmed_change' ? '수정 요청(지급확정)' : krw ? '정정 요청(지급완료)' : '정정 요청(해외송금)'}
                        {a.sourceRoundName && <div style={{ color: C.textSecondary }}>{a.sourceRoundName}</div>}</td>
                      <td style={{ ...td, minWidth: 104, whiteSpace: 'nowrap' }}><span data-testid={`payout-adj-state-${a.id}`} style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontWeight: 700, fontSize: 11, color: st.fg, background: st.bg, whiteSpace: 'nowrap' }}>{st.label}</span></td>
                      <td style={tdR}>{fmtBefore(a)}</td>
                      <td style={tdR}>{fmtAfter(a)}</td>
                      <td style={{ ...tdR, minWidth: 150 }} data-testid={`payout-adj-delta-${a.id}`}>
                        <div style={{ fontWeight: 700, color: neg ? C.dangerText : C.primaryText }}>{deltaLabel(a)}</div>
                        {krw && a.kind === 'paid_correction' && a.payeeType === 'vendor' && <div style={{ color: C.textSecondary }}>공급가 {signed(a.deltaGross)} · 부가세 {signed(a.deltaVat)} · 합계 {signed(a.deltaNet)}</div>}
                        {krw && a.payeeType !== 'vendor' && <div style={{ color: C.textSecondary }}>세전 {signed(a.deltaGross)} · 원천세 {signed(a.deltaWithholding)} · 실지급 {signed(a.deltaNet)}</div>}
                        {krw && a.kind === 'confirmed_change' && a.payeeType === 'vendor' && <div style={{ color: C.textSecondary }}>공급가 {signed(a.deltaGross)} · 부가세 {signed(a.deltaVat)}</div>}
                      </td>
                      <td style={{ ...td, maxWidth: 220, whiteSpace: 'normal' }}>{a.reason}{a.decisionNote && <div style={{ color: C.textSecondary }}>└ {a.decisionNote}</div>}
                        {a.taxCorrectionNeeded && <div style={{ color: C.warningTextDeep }}>원천세 신고·지급명세서 정정 필요</div>}
                        {a.invoiceCorrectionNeeded && <div style={{ color: C.warningTextDeep }}>수정세금계산서 확인 필요(자동 변경 안 함)</div>}</td>
                      <td style={td}>{a.requestedByName ?? '-'} · {formatDisplayDate(a.requestedAt)}
                        {a.decidedAt && <div style={{ color: C.textSecondary }}>{a.decidedByName ?? '-'} · {formatDisplayDate(a.decidedAt)}</div>}</td>
                      <td style={td}>{a.settlementType ? <>{SETTLE_TYPE[a.settlementType] ?? a.settlementType} · {SETTLE_STATUS[a.settlementStatus] ?? '-'}
                        {a.settlementRoundName && <div style={{ color: C.textSecondary }}>{a.settlementRoundName}</div>}
                        {a.settlementRef && a.settlementStatus === 'settled' && <div style={{ color: C.textSecondary }}>{a.settlementRef}</div>}</> : a.kind === 'confirmed_change' && a.status === 'approved' ? '확정 금액 갱신' : '-'}</td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {a.status === 'requested' && !mine && btn('승인', () => approve(a), `payout-adj-approve-${a.id}`)}
                          {a.status === 'requested' && !mine && btn('반려', () => reject(a), `payout-adj-reject-${a.id}`, true)}
                          {a.status === 'requested' && btn('요청 취소', () => cancel(a), `payout-adj-cancel-${a.id}`)}
                          {mode === 'admin' && a.status === 'approved' && a.settlementStatus === 'open' && neg && (
                            <ClickSelect value={a.settlementType} onChange={(v: string) => act(`${a.id}/settlement-type`, { type: v }, `정산 방식을 '${SETTLE_TYPE[v]}'(으)로 바꿨습니다.`)}
                              triggerStyle={{ fontSize: 11, minHeight: 24, padding: '2px 6px' }} aria-label="정산 방식 선택" data-testid={`payout-adj-type-${a.id}`}
                              options={(krw ? ['offset', 'refund'] : ['foreign_refund', 'foreign_offset']).map(v => ({ value: v, label: SETTLE_TYPE[v] }))} />
                          )}
                          {mode === 'admin' && a.status === 'approved' && a.settlementStatus === 'open' && krw && (a.settlementType === 'additional_payment' || a.settlementType === 'offset') && (
                            <ClickSelect value="" onChange={(v: string) => act(`${a.id}/assign-round`, { roundId: Number(v) }, `지급회차에 편입했습니다.`)}
                              triggerStyle={{ fontSize: 11, minHeight: 24, padding: '2px 6px' }} placeholder="다음 회차 편입" aria-label="지급회차 편입" data-testid={`payout-adj-assign-${a.id}`}
                              options={rounds.filter(r => r.id !== a.sourceRoundId).map(r => ({ value: String(r.id), label: r.batchNumber ?? r.paymentDate }))} />
                          )}
                          {mode === 'admin' && a.settlementStatus === 'scheduled' && a.settlementRoundStatus !== 'confirmed' && a.settlementRoundStatus !== 'paid' && btn('편입 해제', () => act(`${a.id}/unassign-round`, {}, '지급회차 편입을 해제했습니다.'), `payout-adj-unassign-${a.id}`)}
                          {mode === 'admin' && a.status === 'approved' && a.settlementStatus === 'open' && ['refund', 'additional_remittance', 'foreign_refund', 'foreign_offset'].includes(a.settlementType) && btn('정산 확인', () => settle(a), `payout-adj-settle-${a.id}`)}
                          {btn(history?.id === a.id ? '이력 닫기' : '이력', () => showHistory(a), `payout-adj-history-${a.id}`)}
                        </div>
                      </td>
                    </tr>
                    {history?.id === a.id && (
                      <tr><td colSpan={12} style={{ ...td, background: C.bgPage }} data-testid={`payout-adj-history-list-${a.id}`}>
                        {(history?.rows ?? []).length === 0 ? "이력이 없습니다." : (history?.rows ?? []).map((h) => (
                          <div key={h.id}>{formatDisplayDate(h.createdAt)} · <b>{ACTION_LABEL[h.action] ?? h.action}</b> · {h.performedByEmail ?? '-'}
                            {h.metadata?.note ? ` · ${h.metadata.note}` : ''}{h.metadata?.reason ? ` · ${h.metadata.reason}` : ''}
                            {h.metadata?.payoutRoundId ? ` · 회차 #${h.metadata.payoutRoundId}` : ''}{h.metadata?.ref ? ` · ${h.metadata.ref}` : ''}</div>
                        ))}
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </>}
    </Card>
    {remitPick && (() => {
      const a = remitPick.adj;
      const linked = new Set(rows.filter((x) => x.id !== a.id && String(x.settlementRef ?? '').startsWith('remittance:')).map((x) => Number(String(x.settlementRef).split(':')[1])));
      const decided = a.decidedAt ? new Date(a.decidedAt).getTime() : 0;
      const recs = remitPick.records.map((r: any) => {
        const why = r.status !== 'completed' ? '송금완료 아님' : String(r.currency).toUpperCase() !== String(a.currency).toUpperCase() ? `통화 다름(${r.currency})`
          : new Date(r.createdAt).getTime() < decided ? '승인 이전 송금' : linked.has(r.id) ? '다른 정정에 연결됨' : null;
        return { ...r, why };
      });
      return (
        <div role="dialog" aria-modal="true" aria-label="추가 송금 내역 선택" data-testid="remit-pick-modal"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
          <div style={{ background: C.white, borderRadius: 12, width: 'min(620px, 100%)', padding: 20 }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>정정 #{a.id} 추가 송금 연결</div>
            <div style={{ fontSize: 12, color: C.textSecondary, margin: '4px 0 10px' }}>
              {a.productName ?? `수행 #${a.assignmentId}`} · 필요 추가 송금액 <b>{signed(a.deltaForeign, a.currency)}</b><br />
              이 수행정보의 송금내역만 표시됩니다. 실제 추가 송금을 수행정보 송금내역에 '송금완료'로 먼저 등록한 뒤 선택하세요. 기존 송금기록은 변경되지 않습니다.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['선택', '송금일', '통화', '송금액', '상태', '비고'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {recs.length === 0 && <tr><td colSpan={6} style={{ ...td, color: C.textMuted }}>송금내역이 없습니다.</td></tr>}
                {recs.map((r: any) => (
                  <tr key={r.id} data-testid={`remit-pick-row-${r.id}`} style={{ opacity: r.why ? 0.55 : 1 }}>
                    <td style={td}>{r.why ? '—' : btn('선택', async () => { if (await act(`${a.id}/settle`, { remittanceId: r.id }, '추가 송금을 연결해 정산 완료로 기록했습니다.')) setRemitPick(null); }, `remit-pick-${r.id}`)}</td>
                    <td style={td}>{r.remitDate ? formatDisplayDate(r.remitDate) : '-'}</td>
                    <td style={td}>{r.currency}</td>
                    <td style={tdR}>{Number(r.foreignAmount).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</td>
                    <td style={td}>{r.status === 'completed' ? '송금완료' : r.status === 'requested' ? '송금요청' : r.status}</td>
                    <td style={{ ...td, color: C.textSecondary }}>{r.why ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <GhostBtn onClick={() => setRemitPick(null)} data-testid="remit-pick-close" aria-label="닫기">닫기</GhostBtn>
            </div>
          </div>
        </div>
      );
    })()}
    </div>
  );
}

// 상태 표시 — 요청 단계와 정산 단계를 한 라벨로(지급상태와 별개). 수정 요청(지급확정) / 정정 요청(지급완료) / 정산 완료.
function stateOf(a: Adj): { label: string; fg: string; bg: string } {
  const req = a.kind === 'confirmed_change' ? '수정 요청' : '정정 요청';
  if (a.status === 'requested') return { label: `${req} · 승인 대기`, fg: C.warningTextDeep, bg: C.warningBg };
  if (a.status === 'rejected') return { label: `${req} · 반려`, fg: C.dangerText, bg: C.dangerBg };
  if (a.status === 'cancelled') return { label: `${req} · 취소`, fg: C.textSecondary, bg: C.bgPage };
  if (a.kind === 'confirmed_change') return { label: '수정 승인 · 확정 반영', fg: C.successText, bg: C.successBg };
  if (a.settlementStatus === 'settled') return { label: '정산 완료', fg: C.successText, bg: C.successBg };
  if (a.settlementStatus === 'scheduled') return { label: '승인 · 회차 편입', fg: C.primaryText, bg: C.primaryBg };
  return { label: '승인 · 정산 대기', fg: C.primaryText, bg: C.primaryBg };
}
// 차액 라벨 — 음수만 보여 주지 않고 처리 유형과 함께(추가 지급 / 환수 대상 / 상계 대상 / 추가 송금 / 초과 송금).
function deltaLabel(a: Adj): string {
  const krw = a.currency === 'KRW';
  const n = krw ? Number(a.deltaNet) || 0 : Number(a.deltaForeign) || 0;
  const amt = krw ? `${Math.abs(Math.round(n)).toLocaleString('ko-KR')}원` : `${a.currency} ${Math.abs(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`;
  if (Math.abs(n) < 0.005) return '차액 없음';
  if (a.kind === 'confirmed_change') return `확정 금액 ${n > 0 ? '증가' : '감소'} ${amt}`;
  if (!krw) {
    if (n > 0) return `추가 송금 ${amt}`;
    return `초과 송금 ${amt} (${a.settlementType === 'foreign_offset' ? '상계' : a.settlementType === 'foreign_refund' ? '환수' : '환수·상계'} 대상)`;
  }
  if (n > 0) return `추가 지급 ${amt}`;
  return a.settlementType === 'refund' ? `환수 대상 ${amt}` : a.settlementType === 'offset' ? `상계 대상 ${amt}` : `과다 지급 ${amt} (환수·상계 대상)`;
}

function fmtBefore(a: Adj) {
  const b = a.beforeValues ?? {};
  if (b.kind === 'foreign') return `${b.currency} 계약 ${Number(b.contractAmount ?? 0).toLocaleString('ko-KR')} · 송금 ${Number(b.remitted ?? 0).toLocaleString('ko-KR')}`;
  return won(b.net);
}
function fmtAfter(a: Adj) {
  const v = a.afterValues ?? {};
  if (v.kind === 'foreign') return `${v.currency} 계약 ${Number(v.contractAmount ?? 0).toLocaleString('ko-KR')}`;
  return won(v.net);
}
function fmtDelta(a: Adj) {
  return a.currency === 'KRW' ? signed(a.deltaNet) : signed(a.deltaForeign, a.currency);
}

export default PayoutAdjustmentList;
