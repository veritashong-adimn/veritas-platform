// ─────────────────────────────────────────────────────────────────────────────
// 수행정보 상단 요약(§14) + 프로젝트 손익 요약(§15).
//  · GET /admin/projects/:id/performance-summary — 수행원가(costTotal) 기준 실시간 집계.
//  · 판매 공급가액은 서버가 현재 견적에서 산출(부가세 제외, 공급가 기준).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { C, TYPO, SP, BD } from '../../lib/ds';
import { won } from './performanceShared';

interface Props {
  projectId: number;
  token: string;
  refreshKey: number;   // 저장 시 증가시켜 재조회 트리거
}

interface Summary {
  header: {
    rowCount: number; individualCount: number; vendorCount: number; expenseCount: number;
    costTotal: number;
    paidCount: number; unpaidCount: number;
  };
  profit: {
    saleSupplyAmount: number; totalCost: number; basePerformanceFeeTotal: number;
    expenseTotal: number; deductionTotal: number; estimatedProfit: number; estimatedMarginRate: number;
    paidCost: number; actualProfit: number; actualMarginRate: number;
  };
}

const chip = (label: string, value: React.ReactNode): React.ReactNode => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 84 }}>
    <span style={TYPO.helper}>{label}</span>
    <span style={{ ...TYPO.inputValue, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  </div>
);

const profitRow = (label: string, value: string, opts?: { strong?: boolean; color?: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0' }}>
    <span style={{ ...TYPO.helper, color: opts?.strong ? C.textPrimary : C.textSecondary, fontWeight: opts?.strong ? 700 : 400 }}>{label}</span>
    <span style={{ ...TYPO.inputValue, fontWeight: opts?.strong ? 800 : 600, color: opts?.color ?? C.textPrimary, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
  </div>
);

export default function PerformanceProfitSummary({ projectId, token, refreshKey }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState(false);
  const [profitOpen, setProfitOpen] = useState(false);   // 프로젝트 손익 요약 아코디언 — 기본 접힘(§15). 화면 상태만, DB 저장 안 함.

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(api(`/api/admin/projects/${projectId}/performance-summary`), { headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok || !j) { setErr(true); return; }
        setData(j); setErr(false);
      } catch { if (alive) setErr(true); }
    })();
    return () => { alive = false; };
  }, [projectId, token, refreshKey]);

  if (err) return null;
  if (!data) return null;
  const { header, profit } = data;
  const profitColor = (n: number) => (n >= 0 ? C.successText : C.dangerText);

  return (
    <div style={{ marginTop: SP[6], display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      {/* 상단 요약 스트립 (§14) */}
      <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', padding: `${SP[4]}px ${SP[5]}px`, background: C.g50, border: `1px solid ${C.g200}`, borderRadius: BD.radius.md }}>
        {chip('수행·원가 항목', `${header.rowCount}건`)}
        {chip('통번역사', `${header.individualCount}명`)}
        {chip('외주업체', `${header.vendorCount}개`)}
        {chip('경비', `${header.expenseCount}건`)}
        {chip('원가 합계', `${won(header.costTotal)}원`)}
        {chip('지급완료', `${header.paidCount}건`)}
        {chip('미지급', `${header.unpaidCount}건`)}
      </div>

      {/* 프로젝트 손익 요약 (§15) — 아코디언(기본 접힘). 접힘/펼침은 화면 상태로만 관리(DB 저장 안 함) → 다시 열면 항상 접힘. */}
      <div style={{ border: `1px solid ${C.g200}`, borderRadius: BD.radius.md, overflow: 'hidden' }}>
        {/* 제목 = 토글 버튼. ▶ 접힘 / ▼ 펼침. 계산식·데이터 불변, 표시만 접기/펼치기. */}
        <button type="button" onClick={() => setProfitOpen(o => !o)}
          aria-expanded={profitOpen} aria-controls="perf-profit-body" data-testid="perf-profit-toggle" aria-label="프로젝트 손익 요약 펼치기/접기"
          style={{ ...TYPO.fieldLabel, fontWeight: 800, width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: SP[2],
            padding: `${SP[3]}px ${SP[5]}px`, background: C.g50, border: 'none', borderBottom: profitOpen ? `1px solid ${C.g200}` : 'none', cursor: 'pointer', color: C.textPrimary }}>
          <span aria-hidden style={{ fontSize: 10, color: C.textSecondary, display: 'inline-block', width: 12, transition: 'transform 0.2s ease', transform: profitOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
          프로젝트 손익 요약 <span style={TYPO.helper}>(부가세 제외 · 공급가액 기준)</span>
          {/* 접힘 상태 KPI — 핵심 지표(예상이익·예상이익률)만 우측 요약. 값·색상은 펼친 화면과 동일한 계산·규칙 사용(새 계산식 없음). */}
          {!profitOpen && (
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'baseline', gap: 4, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
              <span style={TYPO.helper}>예상이익</span>
              <span style={{ ...TYPO.inputValue, fontWeight: 800, color: profitColor(profit.estimatedProfit) }}>{won(profit.estimatedProfit)}원</span>
              <span style={{ ...TYPO.helper, color: profitColor(profit.estimatedProfit) }}>({profit.estimatedMarginRate}%)</span>
            </span>
          )}
        </button>
        {/* 본문 — max-height transition으로 자연스럽게 펼침/접힘(0.25s). 접힘 시 항목 전부 숨김. */}
        <div id="perf-profit-body" style={{ maxHeight: profitOpen ? 800 : 0, overflow: 'hidden', transition: 'max-height 0.25s ease' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: SP[6], padding: `${SP[4]}px ${SP[5]}px` }}>
          {/* 예상 */}
          <div>
            {profitRow('총 판매 공급가액', `${won(profit.saleSupplyAmount)}원`)}
            {profitRow('기본 수행료 합계', `${won(profit.basePerformanceFeeTotal)}원`)}
            {profitRow('추가비용 합계', `${won(profit.expenseTotal)}원`)}
            {profitRow('차감액 합계', `− ${won(profit.deductionTotal)}원`)}
            {profitRow('총 수행원가', `${won(profit.totalCost)}원`, { strong: true })}
            <div style={{ borderTop: BD.grid, marginTop: 4, paddingTop: 4 }}>
              {profitRow('예상이익', `${won(profit.estimatedProfit)}원`, { strong: true, color: profitColor(profit.estimatedProfit) })}
              {profitRow('예상이익률', `${profit.estimatedMarginRate}%`, { color: profitColor(profit.estimatedProfit) })}
            </div>
          </div>
          {/* 실제(지급완료 기준) */}
          <div>
            {profitRow('지급완료 원가', `${won(profit.paidCost)}원`)}
            <div style={{ borderTop: BD.grid, marginTop: 4, paddingTop: 4 }}>
              {profitRow('실제이익', `${won(profit.actualProfit)}원`, { strong: true, color: profitColor(profit.actualProfit) })}
              {profitRow('실제이익률', `${profit.actualMarginRate}%`, { color: profitColor(profit.actualProfit) })}
            </div>
            <div style={{ ...TYPO.helper, marginTop: SP[3] }}>
              ※ 실제이익은 지급완료된 원가만 반영합니다.
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
