// ─────────────────────────────────────────────────────────────────────────────
// [수정 요청]·[정정 요청] 화면(2026-11) — 지급확정·지급완료·해외송금 완료 수행정보의 금액 변경 요청 전용.
//  · 일반 수행정보 저장과 분리: 이 화면에서 바꾼 값은 저장되지 않고 '요청'으로만 접수된다(승인 전 기존 금액 유지).
//  · [차액 확인] = 서버 미리보기(기존 저장 경로로 계산 후 롤백) → 기존·정정 후·차액·예상 정산 방식을 보여 준 뒤 제출.
//  · 계산은 서버가 기존 규칙(원천세·국내 외주 공급가액/부가세/합계·해외 계약통화)으로만 수행한다.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { api } from '../../lib/constants';
import { C } from '../../lib/ds';
import type { Row } from './performanceShared';

export type CorrectionMode = 'confirmed' | 'paid' | 'overseas';
const SETTLE_LABEL: Record<string, string> = {
  confirmed_update: '승인 시 해당 건 확정 금액 갱신(송금건 재동기화)', additional_payment: '추가 지급 — 다음 지급회차에 별도 항목으로 지급',
  offset: '과다 지급 — 다음 지급회차 상계(또는 환수 선택)', none: '차액 없음',
  additional_remittance: '추가 송금(외화) — 실제 송금 후 송금내역 연결', foreign_refund: '초과 송금(외화) — 환수 또는 상계',
};
const won = (v: unknown) => `${Math.round(Number(v) || 0).toLocaleString('ko-KR')}원`;
const sgn = (v: unknown, cur = 'KRW') => { const n = Number(v) || 0; const s = n > 0 ? '+' : n < 0 ? '−' : '±'; return cur === 'KRW' ? `${s}${Math.abs(Math.round(n)).toLocaleString('ko-KR')}원` : `${s}${cur} ${Math.abs(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`; };
const fx = (v: unknown) => Number(v ?? 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 });

export default function PayoutCorrectionModal({ row, mode, projectId, token, buildPayload, onClose, onSubmitted, onToast }: {
  row: Row; mode: CorrectionMode; projectId: number; token: string;
  buildPayload: (r: Row) => any; onClose: () => void; onSubmitted: () => void; onToast: (m: string) => void;
}) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const title = mode === 'confirmed' ? '수정 요청' : '정정 요청';
  const [qty, setQty] = useState(row.quantity == null ? '' : String(row.quantity));
  const [price, setPrice] = useState(row.contractUnitPrice == null ? '' : String(row.contractUnitPrice));
  const [direct, setDirect] = useState(row.directAmount == null ? '' : String(row.directAmount));
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const useDirect = !!row.isDirectAmount && mode !== 'overseas';
  const patched = (): Row => ({ ...row, quantity: qty === '' ? null : qty, contractUnitPrice: price === '' ? null : price, ...(useDirect ? { directAmount: direct === '' ? null : direct } : {}) } as Row);
  const reset = () => { setPreview(null); setErr(null); };

  const runPreview = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/payout-adjustments/preview`), { method: 'POST', headers: authH, body: JSON.stringify({ row: buildPayload(patched()) }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setPreview(null); setErr(data.error ?? '차액 확인 실패'); return; }
      setPreview(data);
    } catch { setErr('차액 확인 중 오류'); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!preview) { setErr('먼저 [차액 확인]으로 변경 금액을 확인해 주세요.'); return; }
    if (!reason.trim()) { setErr(`${title} 사유를 입력해 주세요.`); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/payout-adjustments`), { method: 'POST', headers: authH, body: JSON.stringify({ rows: [buildPayload(patched())], reason: reason.trim() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.errors?.length) { setErr(data.error ?? data.errors?.[0]?.error ?? `${title} 접수 실패`); return; }
      onToast(mode === 'confirmed' ? '수정 요청이 접수되었습니다.' : '정정 요청이 접수되었습니다.');
      onSubmitted();
    } catch { setErr(`${title} 접수 중 오류`); } finally { setBusy(false); }
  };

  const inp: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '7px 9px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13 };
  const lab: React.CSSProperties = { fontSize: 12, color: C.textSecondary, marginBottom: 4, display: 'block' };
  const cell: React.CSSProperties = { padding: '5px 8px', borderBottom: `1px solid ${C.border}`, fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' };
  const head: React.CSSProperties = { ...cell, color: C.textSecondary, fontWeight: 700 };
  const b = preview?.before ?? {}, a = preview?.after ?? {};
  const vendor = preview?.payeeType === 'vendor';
  const rows: [string, unknown, unknown, unknown][] = preview == null ? [] : preview.before?.kind === 'foreign' ? [] : vendor
    ? [['공급가액', b.gross, a.gross, preview.deltaGross], ['부가세', b.vat, a.vat, preview.deltaVat], ['합계(지급액)', b.net, a.net, preview.deltaNet]]
    : [['세전', b.gross, a.gross, preview.deltaGross], ['원천세', b.withholding, a.withholding, preview.deltaWithholding], ['실지급', b.net, a.net, preview.deltaNet]];

  return (
    <div role="dialog" aria-modal="true" aria-label={title} data-testid="corr-modal"
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: C.white, borderRadius: 12, width: 'min(560px, 100%)', maxHeight: '90vh', overflowY: 'auto', padding: 20, boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>{title} <span style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary }}>수행정보 #{row.id}</span></div>
        <div style={{ fontSize: 12, color: C.textSecondary, marginBottom: 12, lineHeight: 1.6 }}>
          {row.productNameSnapshot ?? ''} · {row.performerNameSnapshot ?? ''}<br />
          {mode === 'confirmed' ? '지급확정된 금액입니다. 요청은 저장되지 않고 관리자(요청자 외) 승인 후 확정 금액에 반영됩니다.'
            : mode === 'paid' ? '지급완료된 건입니다. 승인되어도 기존 지급기록은 바뀌지 않고, 차액만 추가 지급·환수·상계로 따로 정산됩니다.'
            : '해외송금 완료 내역이 있습니다. 승인되어도 기존 송금기록은 바뀌지 않고, 외화 차액을 실제 통화로 따로 정산합니다.'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: useDirect ? '1fr 1fr 1fr' : '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <label><span style={lab}>수량{row.unit ? ` (${row.unit})` : ''}</span>
            <input type="number" min={0} step="any" value={qty} onChange={e => { setQty(e.target.value); reset(); }} style={inp} data-testid="corr-qty" aria-label="정정 수량" /></label>
          <label><span style={lab}>단가{mode === 'overseas' ? ` (${row.contractCurrency ?? 'USD'})` : ''}</span>
            <input type="number" min={0} step="any" value={price} onChange={e => { setPrice(e.target.value); reset(); }} style={inp} data-testid="corr-price" aria-label="정정 단가" /></label>
          {useDirect && <label><span style={lab}>직접금액(기준)</span>
            <input type="number" min={0} step="any" value={direct} onChange={e => { setDirect(e.target.value); reset(); }} style={inp} data-testid="corr-direct" aria-label="정정 직접금액" /></label>}
        </div>
        <label><span style={lab}>{title} 사유 (필수)</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} placeholder="예: 통역 수행일수 정정(2일→3일)" data-testid="corr-reason" aria-label={`${title} 사유`} /></label>

        {preview && (
          <div data-testid="corr-preview-result" style={{ marginTop: 12, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, background: C.bgPage }}>
            {preview.before?.kind === 'foreign' ? (
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                계약금액 {b.currency} {fx(b.contractAmount)} → <b>{a.currency} {fx(a.contractAmount)}</b> · 누적 송금 {b.currency} {fx(b.remitted)}<br />
                {Number(preview.deltaForeign) > 0 ? '추가 송금 필요' : Number(preview.deltaForeign) < 0 ? '초과 송금(환수·상계 대상)' : '차액 없음'} <b>{sgn(preview.deltaForeign, preview.currency)}</b>
                <span style={{ color: C.textSecondary }}> · 원화 금액과 합산하지 않습니다</span>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={{ ...head, textAlign: 'left' }}>구분</th><th style={head}>기존{mode === 'paid' ? '(지급)' : '(확정)'}</th><th style={head}>정정 후</th><th style={head}>차액</th></tr></thead>
                <tbody>{rows.map(([k, x, y, d]) => (
                  <tr key={k}><td style={{ ...cell, textAlign: 'left' }}>{k}</td><td style={cell}>{won(x)}</td><td style={cell}>{won(y)}</td>
                    <td style={{ ...cell, fontWeight: 700, color: Number(d) < 0 ? C.dangerText : C.primaryText }}>{sgn(d)}</td></tr>
                ))}</tbody>
              </table>
            )}
            <div style={{ fontSize: 12, marginTop: 6, color: C.textPrimary }}>처리: <b>{SETTLE_LABEL[preview.expectedSettlement] ?? preview.expectedSettlement}</b></div>
            {preview.taxCorrectionNeeded && <div style={{ fontSize: 12, color: C.warningTextDeep }}>원천세 신고·지급명세서 정정 필요</div>}
            {preview.invoiceCorrectionNeeded && <div style={{ fontSize: 12, color: C.warningTextDeep }}>수정세금계산서 확인 필요(자동 변경 안 함)</div>}
          </div>
        )}
        {err && <div role="alert" data-testid="corr-error" style={{ marginTop: 10, fontSize: 12, color: C.dangerText, background: C.dangerBg, borderRadius: 6, padding: '6px 9px' }}>⚠️ {err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" onClick={onClose} disabled={busy} data-testid="corr-cancel" aria-label="닫기"
            style={{ padding: '8px 14px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, cursor: 'pointer' }}>닫기</button>
          <button type="button" onClick={runPreview} disabled={busy} data-testid="corr-preview" aria-label="차액 확인"
            style={{ padding: '8px 14px', borderRadius: 8, border: `1px solid ${C.primary}`, background: C.white, color: C.primaryText, fontWeight: 700, cursor: 'pointer' }}>차액 확인</button>
          <button type="button" onClick={submit} disabled={busy || !preview} data-testid="corr-submit" aria-label={`${title} 제출`}
            style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: preview ? C.primary : C.textDisabled, color: '#fff', fontWeight: 700, cursor: preview ? 'pointer' : 'default' }}>{title} 제출</button>
        </div>
      </div>
    </div>
  );
}
