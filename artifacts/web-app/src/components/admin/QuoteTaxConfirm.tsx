// ─── 견적 세금 유형 확인 절차('확인 필요' → 일반과세·영세율·면세 확정) ─────────────────────────
//  서버 POST /admin/quotes/:id/confirm-tax-type 를 사용한다(원본 총액 불변 · 감사로그 기록).
//   · 영세율/면세: 금액 그대로 유형만 확정   · 일반과세: 총액에 부가세 포함(총액 유지, 공급가/부가세 분리)
//  선택 시 dryRun 으로 변경 전후 금액을 먼저 보여 주고, 확인 근거를 입력해야 확정된다.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { ClickSelect } from '../ui';
import { VAT_MODE_LABEL, type TaxKind } from '../../lib/quoteTaxType';

type Summary = { supply: number; tax: number; total: number };
type Confirmation = { taxType: string | null; basis: string | null; confirmedAt: string | null; confirmedByName: string | null };
const won = (v: number) => `${Math.round(v).toLocaleString()}원`;

/** 최근 확인 기록 표시(감사로그) — 확인된 견적에서만 보임 */
export function QuoteTaxConfirmationInfo({ quoteId, token, refreshKey = 0 }: { quoteId: number; token: string; refreshKey?: number }) {
  const [c, setC] = useState<Confirmation | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(api(`/api/admin/quotes/${quoteId}/tax-type-confirmation`), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null).then(d => { if (alive) setC(d); }).catch(() => {});
    return () => { alive = false; };
  }, [quoteId, token, refreshKey]);
  if (!c?.taxType) return null;
  return (
    <div data-testid="quote-tax-confirmation" style={{ marginTop: 4, fontSize: 11.5, color: '#4b5563', lineHeight: 1.5 }}>
      세금 유형 확인: <b>{VAT_MODE_LABEL[c.taxType as TaxKind] ?? c.taxType}</b> · {c.confirmedAt}{c.confirmedByName ? ` · ${c.confirmedByName}` : ''}{c.basis ? ` · 근거: ${c.basis}` : ''}
    </div>
  );
}

export function QuoteTaxConfirmPanel({ quoteId, token, onToast, canStart, onConfirmed }: {
  quoteId: number; token: string; onToast: (m: string) => void;
  /** 저장하지 않은 수정이 있으면 false — 확인 절차 시작 전 저장 요구 */
  canStart: () => boolean;
  onConfirmed: (taxType: TaxKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<TaxKind | ''>('');
  const [basis, setBasis] = useState('');
  const [preview, setPreview] = useState<{ before: Summary; after: Summary } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    setPreview(null); setPreviewErr(null);
    if (!type) return;
    let alive = true;
    fetch(api(`/api/admin/quotes/${quoteId}/confirm-tax-type`), { method: 'POST', headers: H, body: JSON.stringify({ taxType: type, dryRun: true }) })
      .then(async r => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
      .then(({ ok, d }) => { if (!alive) return; ok ? setPreview(d.summary) : setPreviewErr(d.error ?? '확인할 수 없습니다.'); })
      .catch(() => { if (alive) setPreviewErr('미리보기 실패'); });
    return () => { alive = false; };
  }, [type, quoteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!type || !preview) return;
    if (!basis.trim()) { onToast('확인 근거(확인 자료)를 입력하세요.'); return; }
    setBusy(true);
    try {
      const r = await fetch(api(`/api/admin/quotes/${quoteId}/confirm-tax-type`), { method: 'POST', headers: H, body: JSON.stringify({ taxType: type, basis: basis.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onToast(d.error ?? '세금 유형 확인 실패'); return; }
      onToast(`세금 유형을 ${VAT_MODE_LABEL[type]}(으)로 확인했습니다. 총액 ${won(d.summary.after.total)} 유지.`);
      setOpen(false); onConfirmed(type);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" data-testid="btn-quote-tax-confirm" aria-label="세금 유형 확인"
        onClick={() => { if (!canStart()) { onToast('저장되지 않은 수정사항이 있습니다. 먼저 저장하거나 취소한 뒤 세금 유형을 확인하세요.'); return; } setOpen(true); }}
        style={{ marginTop: 6, fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #f59e0b', background: '#fffbeb', color: '#92400e', cursor: 'pointer', fontWeight: 600 }}>
        세금 유형 확인
      </button>
    );
  }
  const diff = (a: number, b: number) => (b - a === 0 ? '' : ` (${b - a > 0 ? '+' : ''}${Math.round(b - a).toLocaleString()})`);
  return (
    <div data-testid="quote-tax-confirm-panel" style={{ marginTop: 8, padding: 12, border: '1px solid #fde68a', borderRadius: 8, background: '#fffbeb', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#92400e' }}>세금 유형 확인 — 원본 총액은 변경되지 않습니다</div>
      <ClickSelect value={type} onChange={v => setType(v as TaxKind)} placeholder="확정할 세금 유형 선택" aria-label="확정할 세금 유형" data-testid="select-quote-tax-confirm"
        options={[
          { value: 'taxable', label: '일반과세 (10%)', sub: '총액에 부가세 포함 — 공급가·부가세 분리(총액 유지)' },
          { value: 'zero_rate', label: '영세율 (0%)', sub: '금액 그대로' },
          { value: 'exempt', label: '면세', sub: '금액 그대로' },
        ]} />
      {previewErr && <div data-testid="quote-tax-confirm-error" style={{ fontSize: 12, color: '#b91c1c' }}>{previewErr}</div>}
      {preview && (
        <div data-testid="quote-tax-confirm-preview" style={{ fontSize: 12, color: '#374151', lineHeight: 1.7 }}>
          공급가액 {won(preview.before.supply)} → <b>{won(preview.after.supply)}</b>{diff(preview.before.supply, preview.after.supply)}<br />
          부가세 {won(preview.before.tax)} → <b>{won(preview.after.tax)}</b>{diff(preview.before.tax, preview.after.tax)}<br />
          총액 {won(preview.before.total)} → <b>{won(preview.after.total)}</b> (변경 없음)
        </div>
      )}
      <textarea value={basis} onChange={e => setBasis(e.target.value)} rows={2} placeholder="확인 근거(필수) — 예: 영세율 전자세금계산서 발행분 확인, 계약서 부가세 포함 조건 확인"
        data-testid="input-quote-tax-confirm-basis" aria-label="세금 유형 확인 근거" style={{ fontSize: 12.5, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, resize: 'vertical', fontFamily: 'inherit' }} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => setOpen(false)} disabled={busy} data-testid="btn-quote-tax-confirm-cancel" aria-label="세금 유형 확인 취소"
          style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer' }}>취소</button>
        <button type="button" onClick={submit} disabled={busy || !preview || !basis.trim()} data-testid="btn-quote-tax-confirm-submit" aria-label="세금 유형 확정"
          style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #b45309', background: !preview || !basis.trim() ? '#fcd34d' : '#b45309', color: '#fff', cursor: 'pointer' }}>{busy ? '처리 중…' : '확정'}</button>
      </div>
    </div>
  );
}
