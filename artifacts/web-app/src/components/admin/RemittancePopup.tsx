// ─── 해외 외주업체 실제 송금내역 팝업(2026-11) ─────────────────────────────────
//  · 수행정보(편집)·지급회차(조회) 공용 — 같은 API(/api/admin/performances/:id/remittances)로 같은 송금기록을 조회한다(중복 저장 없음).
//  · 계약통화·계약금액은 수행정보 값(변경하지 않음). 송금기록은 건별(분할송금) 추가·수정·삭제(soft).
//  · 원화 환산액 = 외화 송금액 × 적용환율(서버 계산). 은행 수수료(원화)는 환산액과 별도. 다른 통화 송금은 누적에 합산하지 않음.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { C, TYPO } from '../../lib/ds';
import { GhostBtn, PrimaryBtn, ClickSelect, confirmDialog } from '../ui';
import { Modal } from './performancePopups';
import { DateField } from './DatePickerShared';

export type RemittanceSummary = {
  contractCurrency: string | null; contractAmount: number | null;
  remittedAmount: number; remainingAmount: number | null; status: 'planned' | 'partial' | 'completed';
  completedCount: number; pendingCount: number; krwTotal: number; bankFeeTotal: number;
  otherCurrency: Array<{ currency: string; amount: number }>;
};
type Rec = { id: number; remitDate: string | null; currency: string; foreignAmount: string; fxRate: string | null; krwAmount: string | null; bankFee: string; status: string; memo: string | null };

export const REMIT_STATUS_LABEL: Record<string, string> = { planned: '송금예정', partial: '부분송금', completed: '송금완료' };
const REC_STATUS_OPTS = [{ value: 'completed', label: '송금완료' }, { value: 'requested', label: '송금예정(요청)' }, { value: 'failed', label: '실패·반송' }];
const recStatusLabel = (v: string) => REC_STATUS_OPTS.find(o => o.value === v)?.label ?? v;
const CUR_OPTS = ['USD', 'EUR', 'JPY', 'CNY', 'GBP', 'KRW'].map(c => ({ value: c, label: c }));

export const fmtFx = (cur: string | null | undefined, v: number | string | null | undefined) => {
  if (v == null || v === '') return '-';
  const c = (cur ?? '').toUpperCase();
  const d = c === 'KRW' || c === 'JPY' ? 0 : 2;
  return `${c} ${Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: 2 })}`;
};
const won = (v: number | string | null | undefined) => v == null || v === '' ? '-' : `${Math.round(Number(v)).toLocaleString('ko-KR')}원`;

/** 상태 배지 — 송금예정·부분송금·송금완료 */
export function RemitStatusBadge({ s }: { s?: RemittanceSummary | null }) {
  const st = s?.status ?? 'planned';
  const color = st === 'completed' ? C.success ?? '#059669' : st === 'partial' ? '#d97706' : C.textMuted;
  return <span data-testid="remit-status-badge" style={{ fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: '0 6px', whiteSpace: 'nowrap' }}>{REMIT_STATUS_LABEL[st]}</span>;
}

const emptyForm = (cur: string | null) => ({ id: null as number | null, remitDate: '', currency: cur || 'USD', foreignAmount: '', fxRate: '', bankFee: '', status: 'completed', memo: '' });

export default function RemittancePopup({ assignmentId, token, readOnly, onClose, onChanged }: {
  assignmentId: number; token: string; readOnly?: boolean; onClose: () => void; onChanged?: () => void;
}) {
  const [data, setData] = useState<{ assignment: any; records: Rec[]; summary: RemittanceSummary } | null>(null);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(emptyForm(null));
  const [busy, setBusy] = useState(false);
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = useCallback(async () => {
    const res = await fetch(api(`/api/admin/performances/${assignmentId}/remittances`), { headers: authH });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error || '송금내역 조회 실패'); return; }
    setData(j); setForm(f => f.id == null && !f.foreignAmount ? emptyForm(j.summary.contractCurrency) : f);
  }, [assignmentId, token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const krwPreview = form.foreignAmount && form.fxRate ? Math.round(Number(form.foreignAmount) * Number(form.fxRate)) : null;
  const submit = async () => {
    if (!(Number(form.foreignAmount) > 0)) { setErr('외화 송금액을 입력해 주세요.'); return; }
    setBusy(true); setErr('');
    const body = { remitDate: form.remitDate || null, currency: form.currency, foreignAmount: Number(form.foreignAmount),
      fxRate: form.fxRate ? Number(form.fxRate) : null, bankFee: form.bankFee ? Number(form.bankFee) : 0, status: form.status, memo: form.memo || null };
    const url = form.id == null ? `/api/admin/performances/${assignmentId}/remittances` : `/api/admin/performance-remittances/${form.id}`;
    const res = await fetch(api(url), { method: form.id == null ? 'POST' : 'PATCH', headers: authH, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error || '저장 실패'); return; }
    setData(j); setForm(emptyForm(j.summary.contractCurrency)); onChanged?.();
  };
  const remove = async (r: Rec) => {
    if (!(await confirmDialog({ title: '송금내역 삭제', message: `${r.remitDate ?? '날짜 미입력'} · ${fmtFx(r.currency, r.foreignAmount)} 송금내역을 삭제하시겠습니까?\n(삭제 이력은 보존됩니다)`, confirmLabel: '삭제', variant: 'danger' }))) return;
    const res = await fetch(api(`/api/admin/performance-remittances/${r.id}`), { method: 'DELETE', headers: authH });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error || '삭제 실패'); return; }
    setData(j); onChanged?.();
  };

  const s = data?.summary;
  const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', border: `1px solid ${C.g300}`, borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const lbl: React.CSSProperties = { ...TYPO.helper, display: 'block', marginBottom: 3 };
  const th: React.CSSProperties = { padding: '6px 8px', fontSize: 12, fontWeight: 700, color: C.textSecondary, borderBottom: `1px solid ${C.g200}`, textAlign: 'right', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '6px 8px', fontSize: 13, borderBottom: `1px solid ${C.g100}`, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

  return (
    <Modal title={`해외송금 내역${data ? ` — ${data.assignment.performerName ?? ''} · ${data.assignment.productName ?? ''}` : ''}`} onClose={onClose} width={760} draggable
      footer={<GhostBtn onClick={onClose} data-testid="remit-close" aria-label="송금내역 닫기">닫기</GhostBtn>}>
      {!data ? <p style={TYPO.helper}>{err || '불러오는 중…'}</p> : <>
        {/* 계약 vs 실제 송금 요약 — 계약금액은 수행정보 값(변경 없음), 누적은 계약통화 송금완료 건만 */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', padding: '10px 12px', background: C.g50 ?? '#f9fafb', borderRadius: 8, marginBottom: 12, fontSize: 13 }} data-testid="remit-summary">
          <span>계약금액 <b>{fmtFx(s!.contractCurrency, s!.contractAmount)}</b></span>
          <span>누적 송금액 <b data-testid="remit-cumulative">{fmtFx(s!.contractCurrency, s!.remittedAmount)}</b></span>
          <span>미송금액 <b data-testid="remit-remaining" style={{ color: (s!.remainingAmount ?? 0) > 0 ? C.danger : undefined }}>{fmtFx(s!.contractCurrency, s!.remainingAmount)}</b></span>
          <RemitStatusBadge s={s} />
          <span style={TYPO.helper}>원화 환산 합 {won(s!.krwTotal)} · 은행 수수료 합 {won(s!.bankFeeTotal)}</span>
          {s!.otherCurrency.length > 0 && <span style={{ ...TYPO.helper, color: C.danger }}>다른 통화 송금(누적 미합산): {s!.otherCurrency.map(o => fmtFx(o.currency, o.amount)).join(', ')}</span>}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="remit-table">
            <thead><tr>
              <th style={{ ...th, textAlign: 'left' }}>송금일</th><th style={th}>외화 송금액</th><th style={th}>적용환율</th>
              <th style={th}>원화 환산액</th><th style={th}>은행 수수료</th><th style={{ ...th, textAlign: 'center' }}>상태</th>
              <th style={{ ...th, textAlign: 'left' }}>메모</th>{!readOnly && <th style={th} />}
            </tr></thead>
            <tbody>
              {data.records.length === 0 && <tr><td colSpan={readOnly ? 7 : 8} style={{ ...td, textAlign: 'center', color: C.textMuted }}>등록된 송금내역이 없습니다(송금예정).</td></tr>}
              {data.records.map(r => (
                <tr key={r.id} data-testid={`remit-row-${r.id}`}>
                  <td style={{ ...td, textAlign: 'left' }}>{r.remitDate ?? '-'}</td>
                  <td style={td}>{fmtFx(r.currency, r.foreignAmount)}</td>
                  <td style={td}>{r.fxRate != null ? Number(r.fxRate).toLocaleString('ko-KR', { maximumFractionDigits: 6 }) : '-'}</td>
                  <td style={td}>{won(r.krwAmount)}</td>
                  <td style={td}>{won(r.bankFee)}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{recStatusLabel(r.status)}</td>
                  <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>{r.memo ?? ''}</td>
                  {!readOnly && <td style={td}>
                    <GhostBtn onClick={() => setForm({ id: r.id, remitDate: r.remitDate ?? '', currency: r.currency, foreignAmount: String(Number(r.foreignAmount)), fxRate: r.fxRate != null ? String(Number(r.fxRate)) : '', bankFee: String(Number(r.bankFee)), status: r.status, memo: r.memo ?? '' })}
                      style={{ fontSize: 11, padding: '2px 8px' }} data-testid={`remit-edit-${r.id}`} aria-label="송금내역 수정">수정</GhostBtn>
                    <GhostBtn onClick={() => remove(r)} style={{ fontSize: 11, padding: '2px 8px', marginLeft: 4 }} data-testid={`remit-delete-${r.id}`} aria-label="송금내역 삭제">삭제</GhostBtn>
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!readOnly && (
          <div style={{ marginTop: 14, padding: 12, border: `1px solid ${C.g200}`, borderRadius: 8 }} data-testid="remit-form">
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{form.id == null ? '송금내역 추가' : '송금내역 수정'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
              <div><label style={lbl}>송금일</label><DateField value={form.remitDate} onChange={(v: string) => setForm(f => ({ ...f, remitDate: v }))} testid="remit-date" ariaLabel="송금일" /></div>
              <div><label style={lbl}>통화</label><ClickSelect value={form.currency} onChange={(v: string) => setForm(f => ({ ...f, currency: v }))} triggerStyle={inp} options={CUR_OPTS} data-testid="remit-currency" aria-label="송금 통화" /></div>
              <div><label style={lbl}>외화 송금액</label><input style={inp} type="number" min={0} step="0.01" value={form.foreignAmount} onChange={e => setForm(f => ({ ...f, foreignAmount: e.target.value }))} data-testid="remit-amount" aria-label="외화 송금액" /></div>
              <div><label style={lbl}>적용환율</label><input style={inp} type="number" min={0} step="0.0001" value={form.fxRate} onChange={e => setForm(f => ({ ...f, fxRate: e.target.value }))} data-testid="remit-fx" aria-label="적용환율" /></div>
              <div><label style={lbl}>원화 환산액(자동)</label><div style={{ ...inp, background: C.g50 ?? '#f9fafb' }} data-testid="remit-krw-preview">{krwPreview != null ? won(krwPreview) : '-'}</div></div>
              <div><label style={lbl}>은행 수수료(원)</label><input style={inp} type="number" min={0} value={form.bankFee} onChange={e => setForm(f => ({ ...f, bankFee: e.target.value }))} data-testid="remit-fee" aria-label="은행 수수료" /></div>
              <div><label style={lbl}>송금상태</label><ClickSelect value={form.status} onChange={(v: string) => setForm(f => ({ ...f, status: v }))} triggerStyle={inp} options={REC_STATUS_OPTS} data-testid="remit-status" aria-label="송금상태" /></div>
              <div><label style={lbl}>메모</label><input style={inp} value={form.memo} onChange={e => setForm(f => ({ ...f, memo: e.target.value }))} data-testid="remit-memo" aria-label="송금 메모" /></div>
            </div>
            {err && <p style={{ ...TYPO.helper, color: C.danger, marginTop: 6 }}>{err}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
              {form.id != null && <GhostBtn onClick={() => setForm(emptyForm(s!.contractCurrency))} data-testid="remit-cancel-edit" aria-label="수정 취소">취소</GhostBtn>}
              <PrimaryBtn onClick={submit} disabled={busy} data-testid="remit-save" aria-label="송금내역 저장">{busy ? '저장 중…' : form.id == null ? '추가' : '수정 저장'}</PrimaryBtn>
            </div>
          </div>
        )}
      </>}
    </Modal>
  );
}
