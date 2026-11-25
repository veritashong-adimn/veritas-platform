// ─────────────────────────────────────────────────────────────────────────────
// 정산 화면 컨테이너 — 재무→정산.
//  · 하위메뉴 3개는 좌측 사이드바에서 선택(지급회차 관리 · 지급명세서 · 세무자료). view prop 으로 분기.
//  · 지급회차 관리(view='payout') = 지급회차 목록(PayoutUnifiedTab, 통합 조회) → 지급일 클릭 → 지급회차 상세(PayoutRoundDetail).
//    운영 지급확정·은행이체(PayoutRoundsTab, 로직 무변경)는 상세의 '지급확정·은행이체' 탭(menu.payout_ops)에서 선택 지급일의 운영 회차로 연결.
//  · 과거 지급 재현 엔진/탭(PayoutReproductionTab)은 삭제하지 않고 관리자 검증용으로 보존(라우팅만 비노출).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { type PayoutPerms } from './PayoutRoundsTab';
import { PayoutAdjustmentList } from './PayoutAdjustmentsPanel';
import PayoutAdjustmentBanner from './PayoutAdjustmentBanner';
import PayoutStatementTab from './PayoutStatementTab';
import TaxReportTab from './TaxReportTab';
import { PayoutUnifiedTab } from './PayoutUnifiedTab';
import { PayoutStatementSearchTab } from './PayoutStatementSearchTab';

interface Props {
  view: 'payout' | 'statement' | 'tax';
  /** 운영 지급확정·은행이체 화면 접근 권한(menu.payout_ops). 없으면 이동 버튼을 숨기고 통합 화면만 표시. */
  canOps?: boolean;
  /** 지급회차 실행권한(작성·확정·송금·관리자) — 미전달 시 기존 동작. */
  payoutPerms?: PayoutPerms;
  token: string;
  onToast: (m: string) => void;
}

export function SettlementTabs({ view, token, onToast, canOps = true, payoutPerms }: Props) {
  const [adjFocus, setAdjFocus] = useState<'requested' | 'pending' | null>(null);   // 정정 요청 바로가기(2026-11) — 목록 상단에서 승인·반려 목록 열기
  // 지급명세서: 통합 검색(기본 — 지급회차 관리와 같은 통합 지급자료) ↔ 운영 지급회차 확정 스냅샷 명세서(기존 화면, 보조).
  const [stmtMode, setStmtMode] = useState<'search' | 'operational'>('search');

  if (view === 'statement') return (
    <div data-testid="settlement-statement-container">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <button
          type="button"
          aria-label={stmtMode === 'search' ? '운영 지급회차(확정 스냅샷) 명세서 화면 열기' : '통합 지급명세서 검색으로 돌아가기'}
          data-testid="statement-mode-toggle"
          onClick={() => setStmtMode(m => (m === 'search' ? 'operational' : 'search'))}
          style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', cursor: 'pointer' }}
        >
          {stmtMode === 'search' ? '운영 지급회차 명세서 →' : '← 통합 지급명세서 검색'}
        </button>
      </div>
      {stmtMode === 'search'
        ? <PayoutStatementSearchTab token={token} onToast={onToast} />
        : <PayoutStatementTab token={token} onToast={onToast} />}
    </div>
  );
  if (view === 'tax') return <TaxReportTab token={token} onToast={onToast} />;

  return (
    <div data-testid="settlement-payout-container">
      {/* 정정 요청 현황(2026-11) — 지급회차 목록 상단. 바로가기 버튼은 같은 자리에서 승인·반려·정산 대기 목록을 연다(운영 지급확정 권한). */}
      <PayoutAdjustmentBanner token={token} canOpen={canOps} onOpen={(f) => setAdjFocus(f)} />
      {canOps && adjFocus && (
        <div style={{ marginBottom: 12 }} data-testid="settlement-adj-list">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <button type="button" onClick={() => setAdjFocus(null)} data-testid="settlement-adj-close" aria-label="정정 요청 목록 닫기"
              style={{ padding: '5px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', cursor: 'pointer' }}>정정 요청 목록 닫기</button>
          </div>
          <PayoutAdjustmentList key={adjFocus} mode="admin" token={token} onToast={onToast} initialFilter={adjFocus} focus />
        </div>
      )}
      {/* 지급회차 목록 → 지급일 클릭 → 상세(지급준비점검·지급대상별 요약·건별 상세내역·지급확정·은행이체) */}
      <PayoutUnifiedTab token={token} onToast={onToast} canOps={canOps} payoutPerms={payoutPerms} />
    </div>
  );
}
