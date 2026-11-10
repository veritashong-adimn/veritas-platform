// ─────────────────────────────────────────────────────────────────────────────
// 정산 화면 컨테이너 — 재무→정산.
//  · 하위메뉴 3개는 좌측 사이드바에서 선택(지급회차 관리 · 지급명세서 · 세무자료). view prop 으로 분기.
//  · 지급회차 관리(view='payout')는 과거 CRM + 신규 플랫폼을 지급일별로 통합 조회하는
//    단일 '지급회차관리' 화면(PayoutUnifiedTab)으로 구성한다(§3). 기존 2개 탭(운영/과거 재현)은 제거.
//  · 운영 지급확정·은행이체(PayoutRoundsTab)는 1차 범위 밖(§12)이라 로직 무변경 — 조회 화면에서
//    보조 버튼으로 진입만 가능하게 유지(지급확정·IBK 기능 접근성 보존). 두 흐름은 명확히 분리.
//  · 과거 지급 재현 엔진/탭(PayoutReproductionTab)은 삭제하지 않고 관리자 검증용으로 보존(라우팅만 비노출).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { BackToListButton } from './BackToListButton';
import PayoutRoundsTab, { type PayoutPerms } from './PayoutRoundsTab';
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
  // 지급회차 관리 화면: 통합 조회(기본) ↔ 운영 지급확정·이체(보조). 다른 view(명세서·세무)는 영향 없음.
  const [mode, setMode] = useState<'unified' | 'operational'>('unified');
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        {/* 페이지 이동 버튼 — 통번역사 상세 '뒤로가기'(BackToListButton subtle)와 같은 디자인. 앞으로 = 오른쪽 화살표, 돌아가기 = 왼쪽 화살표. */}
        {!canOps ? null : mode === 'unified'
          ? <BackToListButton variant="subtle" direction="forward" label="운영 지급확정·은행이체" ariaLabel="운영 지급확정·은행이체 화면 열기"
              testId="settlement-mode-toggle" onClick={() => setMode('operational')} />
          : <BackToListButton variant="subtle" label="통합 지급회차관리" ariaLabel="통합 지급회차관리로 돌아가기"
              testId="settlement-mode-toggle" onClick={() => setMode('unified')} />}
      </div>
      {mode === 'unified' || !canOps
        ? <PayoutUnifiedTab token={token} onToast={onToast} />
        : <PayoutRoundsTab token={token} onToast={onToast} perms={payoutPerms} />}
    </div>
  );
}
