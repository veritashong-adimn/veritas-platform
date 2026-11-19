// 지급회차관리 기본(통합 조회) 화면 상단 — 정정 요청 승인 대기·정산 대기 건수와 바로가기(2026-11).
//  · 건수가 0이면 표시하지 않는다. 버튼은 운영 지급확정 화면의 정정 요청 목록(해당 필터)으로 이동해 바로 승인·반려할 수 있게 한다.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { C } from '../../lib/ds';

export default function PayoutAdjustmentBanner({ token, canOpen, onOpen }: { token: string; canOpen: boolean; onOpen: (f: 'requested' | 'pending') => void }) {
  const [sum, setSum] = useState<{ requested: number; pending: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(api('/api/admin/payout-adjustments'), { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null)).then((d: any) => {
        if (!alive || !d) return;
        const pending = (d.rows ?? []).filter((x: any) => x.status === 'approved' && (x.settlementStatus === 'open' || x.settlementStatus === 'scheduled')).length;
        setSum({ requested: d.summary?.requested ?? 0, pending });
      }).catch(() => {});
    return () => { alive = false; };
  }, [token]);
  if (!sum || (sum.requested === 0 && sum.pending === 0)) return null;
  const btn = (label: string, f: 'requested' | 'pending', testid: string) => (
    <button type="button" onClick={() => onOpen(f)} disabled={!canOpen} data-testid={testid} aria-label={label}
      style={{ fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 8, border: `1px solid ${C.primary}`, background: C.white, color: C.primaryText, cursor: canOpen ? 'pointer' : 'default' }}>{label} →</button>
  );
  return (
    <div data-testid="payout-adj-banner" role="status"
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 10, borderRadius: 10, background: C.warningBg, border: `1px solid ${C.warningBorder}` }}>
      <b style={{ fontSize: 13 }}>수정·정정 요청</b>
      <span style={{ fontSize: 13 }}>승인 대기 <b data-testid="payout-adj-banner-requested" style={{ color: C.warningTextDeep }}>{sum.requested}건</b></span>
      <span style={{ fontSize: 13 }}>차액 정산 대기 <b data-testid="payout-adj-banner-pending" style={{ color: C.primaryText }}>{sum.pending}건</b></span>
      <span style={{ flex: 1 }} />
      {canOpen ? <>{btn('승인·반려 목록', 'requested', 'payout-adj-banner-open-requested')}{btn('정산 대기 목록', 'pending', 'payout-adj-banner-open-pending')}</>
        : <span style={{ fontSize: 12, color: C.textSecondary }}>승인·반려는 운영 지급확정 권한이 필요합니다.</span>}
    </div>
  );
}
