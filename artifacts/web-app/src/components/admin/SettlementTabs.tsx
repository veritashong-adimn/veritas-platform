// ─────────────────────────────────────────────────────────────────────────────
// 정산 화면 컨테이너 — 재무→정산.
//  · 하위메뉴 3개는 좌측 사이드바에서 선택(지급회차 관리 · 지급명세서 · 세무자료).
//    화면 상단 하위탭 대신 사이드바 하위메뉴로 이동 → view prop 으로 렌더 대상만 분기.
//  · 신규 지급회차는 performance_assignments를 상위 회차로 집계(PayoutRoundsTab).
//  · 지급명세서는 조회 전용 독립 화면(PayoutStatementTab) — 지급회차 화면과 데이터·기능 동일.
//  · 「기존 정산(레거시)」 화면(SettlementManagementTab)은 1단계 제거됨(UI만). settlements 테이블·API 는 유지.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import PayoutRoundsTab from './PayoutRoundsTab';
import PayoutStatementTab from './PayoutStatementTab';
import TaxReportTab from './TaxReportTab';

interface Props {
  view: 'payout' | 'statement' | 'tax';
  token: string;
  onToast: (m: string) => void;
}

export function SettlementTabs({ view, token, onToast }: Props) {
  if (view === 'statement') return <PayoutStatementTab token={token} onToast={onToast} />;
  if (view === 'tax') return <TaxReportTab token={token} onToast={onToast} />;
  return <PayoutRoundsTab token={token} onToast={onToast} />;
}
