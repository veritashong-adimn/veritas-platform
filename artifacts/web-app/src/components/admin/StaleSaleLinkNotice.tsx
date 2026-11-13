// ─── 수행정보 ↔ 판매상품 끊어진 연결 안내·복구 ──────────────────────────────────────
// 수행정보가 가리키는 판매상품이 현재 판매정보에 없을 때만 표시한다(정상 판매건에는 렌더링 없음).
// 관리자가 근거를 확인한 뒤 현재 판매상품을 골라 [재연결] → 사유 입력 → 서버가 참조(sale_item_id)만 변경·감사로그 기록.
import React, { useEffect, useState } from 'react';
import { confirmDialog } from '../ui';
import { api } from '../../lib/constants';
import { promptDialog } from '../ui';

type Perf = { id: number; saleItemId?: number | null; performerNameSnapshot?: string | null; productNameSnapshot?: string | null; deletedAt?: string | null };
type Item = { id: number; productName?: string | null; itemType?: string | null; supplyAmount?: string | number | null };

const DEFAULT_REASON = '과거 CRM 전환 과정에서 삭제된 판매상품을 참조한 수행정보를 정상 상품으로 재연결함. 기존 수행·지급정보 유지.';

type Suggestion = { performanceId: number; staleItemId: number; suggestedItemId: number | null; basis: string | null };
export function StaleSaleLinkNotice({ projectId, performances, items, token, onDone, onToast }: {
  projectId: number; performances: Perf[]; items: Item[]; token: string; onDone: () => void; onToast: (m: string) => void;
}) {
  const itemIds = new Set(items.map(i => i.id));
  const stale = performances.filter(p => !p.deletedAt && p.saleItemId != null && !itemIds.has(p.saleItemId));
  const choices = items.filter(i => i.itemType !== 'discount');
  const [pick, setPick] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState<number | null>(null);
  // 감사로그 근거 기반 추천(견적 저장으로 품목이 재생성된 경우 #기존 → #현재). 근거 없으면 추천 없음(수동 선택).
  const [sug, setSug] = useState<Record<number, Suggestion>>({});
  const staleKey = stale.map(p => `${p.id}:${p.saleItemId}`).join(',');
  useEffect(() => {
    if (!staleKey) { setSug({}); return; }
    let alive = true;
    fetch(api(`/api/admin/projects/${projectId}/stale-sale-links`), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null).then(d => {
        if (!alive || !d) return;
        const m: Record<number, Suggestion> = {}; for (const x of d.suggestions ?? []) m[x.performanceId] = x;
        setSug(m);
        setPick(prev => { const n = { ...prev }; for (const x of d.suggestions ?? []) if (x.suggestedItemId && !n[x.performanceId]) n[x.performanceId] = x.suggestedItemId; return n; });
      }).catch(() => {});
    return () => { alive = false; };
  }, [projectId, staleKey, token]);
  if (stale.length === 0 || items.length === 0) return null;
  const withBasis = stale.filter(p => sug[p.id]?.suggestedItemId);
  const relinkAll = async () => {
    const targets = [...new Set(withBasis.map(p => sug[p.id].suggestedItemId))];
    const ok = await confirmDialog({
      title: `근거 있는 ${withBasis.length}건 일괄 재연결`,
      message: `${withBasis.length}건의 수행정보 판매상품 연결을 감사로그 근거에 따라 현재 판매상품 ${targets.map(t => `#${t}`).join(', ')}로 변경합니다.\n\n근거: ${sug[withBasis[0].id].basis}\n\n수행·지급·세금 정보는 변경되지 않습니다(연결 참조만 변경).`,
      confirmLabel: '일괄 재연결', cancelLabel: '취소',
    });
    if (!ok) return;
    setBusy(-1);
    try {
      const r = await fetch(api(`/api/admin/projects/${projectId}/stale-sale-links/relink`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ performanceIds: withBasis.map(p => p.id), reason: DEFAULT_REASON }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onToast(`일괄 재연결 실패: ${d.error ?? r.status}`); return; }
      onToast(`재연결 ${d.succeeded}건 완료${d.failed ? ` · 실패 ${d.failed}건(${(d.results ?? []).filter((x: any) => !x.ok).map((x: any) => `#${x.performanceId} ${x.error}`).slice(0, 3).join(' / ')})` : ''}`);
      onDone();
    } finally { setBusy(null); }
  };

  const relink = async (p: Perf) => {
    const target = pick[p.id];
    if (!target) { onToast('연결할 현재 판매상품을 선택하세요.'); return; }
    const reason = await promptDialog({
      title: '판매상품 재연결 사유',
      message: `수행정보 #${p.id}의 판매상품 연결을 #${p.saleItemId}(삭제됨) → #${target}로 변경합니다. 수행·지급정보는 변경되지 않습니다.`,
      placeholder: DEFAULT_REASON, defaultValue: DEFAULT_REASON, confirmLabel: '재연결',
    });
    if (reason == null || !reason.trim()) return;
    setBusy(p.id);
    try {
      const r = await fetch(api(`/api/admin/performances/${p.id}/relink-sale-item`), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ saleItemId: target, reason: reason.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onToast(`재연결 실패: ${d.error ?? r.status}`); return; }
      onToast(`수행정보 #${p.id}를 판매상품 #${target}에 재연결했습니다.`);
      onDone();
    } finally { setBusy(null); }
  };

  return (
    <div data-testid="stale-sale-link-notice" style={{ margin: '0 0 12px', padding: '10px 14px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, fontSize: 13, color: '#92400e' }}>
      <b>판매상품 연결 확인 필요 {stale.length}건</b> — 아래 수행정보가 현재 판매정보에 없는(삭제된) 판매상품을 가리킵니다. 근거를 확인한 뒤 현재 판매상품으로 재연결하세요.
      {withBasis.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} data-testid="stale-link-basis-summary">
          <span>연결 근거 확인됨 <b>{withBasis.length}건</b> — {sug[withBasis[0].id].basis}{stale.length > withBasis.length ? ` · 근거 없음 ${stale.length - withBasis.length}건은 직접 선택` : ''}</span>
          <button type="button" disabled={busy != null} onClick={relinkAll} data-testid="stale-link-relink-all" aria-label="근거 있는 수행정보 일괄 재연결"
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #b45309', background: '#b45309', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
            {busy === -1 ? '처리 중…' : `근거 있는 ${withBasis.length}건 일괄 재연결`}
          </button>
        </div>
      )}
      {stale.map(p => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <span>수행정보 #{p.id} · {p.performerNameSnapshot || '수행자 미지정'} · {p.productNameSnapshot || '-'} → 연결 품목 #{p.saleItemId}(없음){sug[p.id]?.suggestedItemId ? ` · 추천 #${sug[p.id].suggestedItemId}` : ' · 근거 없음'}</span>
          <select value={pick[p.id] ?? ''} onChange={e => setPick(s => ({ ...s, [p.id]: Number(e.target.value) }))}
            data-testid={`stale-link-select-${p.id}`} aria-label={`수행정보 ${p.id} 연결할 판매상품`}
            style={{ fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid #fcd34d' }}>
            <option value="">현재 판매상품 선택</option>
            {choices.map(i => <option key={i.id} value={i.id}>#{i.id} {i.productName}</option>)}
          </select>
          <button type="button" disabled={busy === p.id} onClick={() => relink(p)}
            data-testid={`stale-link-relink-${p.id}`} aria-label={`수행정보 ${p.id} 재연결`}
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid #b45309', background: '#fff', color: '#b45309', fontWeight: 700, cursor: 'pointer' }}>
            {busy === p.id ? '처리 중…' : '재연결'}
          </button>
        </div>
      ))}
    </div>
  );
}
