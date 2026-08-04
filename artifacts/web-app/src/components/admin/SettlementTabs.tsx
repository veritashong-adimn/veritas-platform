// ─────────────────────────────────────────────────────────────────────────────
// 정산 화면 컨테이너 — 재무→정산.
//  · 하위탭 2개: "지급회차 관리"(기본·신규) + "기존 정산(레거시)".
//  · 신규 지급회차는 performance_assignments를 상위 회차로 집계(PayoutRoundsTab).
//  · 레거시 settlements 화면(SettlementManagementTab)은 데이터·기능 보존을 위해 그대로 유지.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { SettlementManagementTab } from './SettlementManagementTab';
import PayoutRoundsTab from './PayoutRoundsTab';
import { C, TYPO, SP } from '../../lib/ds';

interface Props {
  settlements: any[];
  loading: boolean;
  token: string;
  onToast: (m: string) => void;
  onRefresh: () => void;
}

export function SettlementTabs({ settlements, loading, token, onToast, onRefresh }: Props) {
  const [sub, setSub] = useState<'payout' | 'legacy'>('payout');
  const tabBtn = (key: 'payout' | 'legacy', label: string) => (
    <button type="button" onClick={() => setSub(key)} data-testid={`settlement-subtab-${key}`}
      style={{
        fontSize: 13, fontWeight: 700, padding: '9px 18px', cursor: 'pointer', background: 'none', border: 'none',
        color: sub === key ? C.primaryText : C.textSecondary,
        borderBottom: `2px solid ${sub === key ? C.primaryText : 'transparent'}`,
      }}>{label}</button>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.g200}`, ...TYPO.inputValue }}>
        {tabBtn('payout', '지급회차 관리')}
        {tabBtn('legacy', '기존 정산(레거시)')}
      </div>
      {sub === 'payout'
        ? <PayoutRoundsTab token={token} onToast={onToast} />
        : <SettlementManagementTab settlements={settlements} loading={loading} token={token} onToast={onToast} onRefresh={onRefresh} />}
    </div>
  );
}
