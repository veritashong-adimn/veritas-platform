// ─── 차감 견적서 전용: 선입/이월 입력 + 차감 잔액 요약 ────────────────────────
// quoteType === 'b2c_prepaid' 일 때만 렌더링된다. 일반/누적 견적서에는 노출되지 않는다.
// 화면 순서: [선입/이월 입력] → (차감 사용내역) → [차감 잔액 요약] → (금액 요약)
import React from 'react';
import { formatWon } from '@/lib/utils';
import { Card, DsButton, ClickSelect, NumericInput } from '../ui';
import { C, TYPO, dsField } from '../../lib/ds';

// 선입/이월 입력 라인 (클라이언트 폼 상태)
//  - deposit  : 선입금 (같은 고객이 여러 번 선입해도 각 행의 발생/입금일로 구분 → 별도 '추가 선입금' 유형 불필요)
//  - carryover: 기존 진행건 잔액 이월
export type PrepaidLine = {
  type: 'deposit' | 'carryover';
  amount: string;            // 원시 숫자 문자열(콤마 허용)
  transactionDate: string;   // 발생/입금일 YYYY-MM-DD
  sourceRef: string;         // 원천정보(원 견적/판매/프로젝트 번호 등 자유 텍스트)
  note: string;              // 비고
};

const LINE_TYPE_OPTS = [
  { value: 'deposit',   label: '선입금',              sub: '고객 선입금 입금(발생일로 복수 구분)' },
  { value: 'carryover', label: '기존 진행건 잔액 이월', sub: '남은 금액을 잔액으로 전환' },
];

export function makeEmptyPrepaidLine(): PrepaidLine {
  return { type: 'deposit', amount: '', transactionDate: new Date().toISOString().slice(0, 10), sourceRef: '', note: '' };
}

const num = (s: string) => Number(String(s ?? '').replace(/,/g, '')) || 0;

// 서버 저장 payload 형태로 변환
export function prepaidLinesToApi(lines: PrepaidLine[]) {
  return lines
    .filter(l => num(l.amount) > 0)
    .map(l => ({
      type: l.type,
      amount: num(l.amount),
      transactionDate: l.transactionDate || null,
      sourceRef: l.sourceRef.trim() || null,
      note: l.note.trim() || null,
    }));
}

// 차감 요약 계산 (백엔드 computeDeductionSummary 와 동일한 규칙 — 로직 변경 없음)
export function computeSummary(previousAvailable: number, incomingPrepaid: number, quoteTotal: number) {
  const prev = Math.max(0, Math.round(previousAvailable));
  const incoming = Math.max(0, Math.round(incomingPrepaid));
  const total = Math.max(0, Math.round(quoteTotal));
  const totalAvailable = prev + incoming;
  const appliedDeduction = Math.min(totalAvailable, total);
  const additionalCharge = total - appliedDeduction;
  const remainingAfter = totalAvailable - appliedDeduction;
  return { prev, incoming, total, totalAvailable, appliedDeduction, additionalCharge, remainingAfter };
}

// 선입/이월 라인 합계(공용) — 견적금액/공급가에는 절대 합산하지 않고 잔액 계산에만 사용
export function sumPrepaidLines(lines: PrepaidLine[]) {
  return lines.reduce((s, l) => s + num(l.amount), 0);
}

// 유형 | 금액 | 발생/입금일 | 비고(확장) | 삭제  — 원천정보 칸은 제거(비고에 통합)
const GRID = '180px 140px 150px minmax(260px, 1fr) 34px';

// ─── ① 선입 / 이월 입력 (상품정보 위) ────────────────────────────────────────
export function PrepaidLinesSection({
  lines,
  onLinesChange,
  hasCompany,
}: {
  lines: PrepaidLine[];
  onLinesChange: (lines: PrepaidLine[]) => void;
  hasCompany: boolean;
}) {
  const update = (idx: number, p: Partial<PrepaidLine>) => onLinesChange(lines.map((l, i) => (i === idx ? { ...l, ...p } : l)));
  const remove = (idx: number) => onLinesChange(lines.filter((_, i) => i !== idx));
  const add    = () => onLinesChange([...lines, makeEmptyPrepaidLine()]);

  const hdrCell: React.CSSProperties = { ...TYPO.fieldLabel, color: C.textMuted, padding: '0 2px' };

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ ...TYPO.badge, background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 6 }}>선입 / 이월</span>
        <span style={{ ...TYPO.fieldLabel, color: C.textMuted }}>
          고객 선입금·기존 진행건 잔액 이월을 기록합니다 (견적금액을 줄이는 항목이 아니라 잔액을 충전하는 별도 데이터)
        </span>
      </div>

      {!hasCompany && (
        <div style={{ ...TYPO.fieldLabel, color: C.danger, marginBottom: 10 }}>
          ※ 거래처를 먼저 선택해야 선입/이월 잔액이 계정에 반영됩니다.
        </div>
      )}

      {lines.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: '6px 10px', alignItems: 'center', marginBottom: 10 }}>
          <div style={hdrCell}>유형</div>
          <div style={hdrCell}>금액</div>
          <div style={hdrCell}>발생/입금일</div>
          <div style={hdrCell}>비고</div>
          <div />
          {lines.map((l, i) => (
            <React.Fragment key={i}>
              <ClickSelect value={l.type} onChange={v => update(i, { type: v as PrepaidLine['type'] })} triggerStyle={dsField()} options={LINE_TYPE_OPTS} />
              <NumericInput value={l.amount} onChange={raw => update(i, { amount: raw })} suffix="원" style={dsField()} />
              <input type="date" value={l.transactionDate} onChange={e => update(i, { transactionDate: e.target.value })} style={dsField()} />
              <input
                value={l.note}
                onChange={e => update(i, { note: e.target.value })}
                placeholder={l.type === 'carryover' ? '예: Q260716-008 잔액 이월' : '비고 (선택)'}
                style={dsField()}
              />
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label="선입 항목 삭제"
                data-testid={`prepaid-line-remove-${i}`}
                style={{ width: 30, height: 30, borderRadius: 6, border: `1px solid ${C.border}`, background: '#fff', color: C.danger, cursor: 'pointer', fontSize: 15, lineHeight: 1 }}
              >×</button>
            </React.Fragment>
          ))}
        </div>
      )}

      <DsButton variant="secondary" size="sm" onClick={add} data-testid="prepaid-line-add" aria-label="선입 항목 추가">+ 선입 항목</DsButton>
    </Card>
  );
}

// ─── ③ 차감 잔액 요약 (차감 사용내역 아래) ───────────────────────────────────
export function PrepaidSummarySection({
  previousAvailable,
  incomingPrepaid,
  quoteTotal,
  loadingBalance,
}: {
  previousAvailable: number;
  incomingPrepaid: number;
  quoteTotal: number;
  loadingBalance?: boolean;
}) {
  const sum = computeSummary(previousAvailable, incomingPrepaid, quoteTotal);
  return (
    <Card>
      <div style={{ ...TYPO.fieldLabel, color: C.textSecondary, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...TYPO.badge, background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 6 }}>차감 잔액 요약</span>
        {loadingBalance && <span style={{ color: C.textMuted, fontSize: 11 }}>(잔액 조회 중…)</span>}
      </div>
      <div style={{ padding: '12px 14px', background: '#f8fafc', border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '4px 24px' }}>
          <SummaryRow label="이전 가용잔액" value={sum.prev} />
          <SummaryRow label="이번 선입/이월액" value={sum.incoming} accent={C.primary} />
          <SummaryRow label="이번 견적금액" value={sum.total} />
          {/* 총 가용잔액: 이전 가용잔액과 이번 선입/이월이 모두 있을 때만 표시(PDF와 동일 규칙) */}
          {sum.prev > 0 && sum.incoming > 0 && <SummaryRow label="총 가용잔액" value={sum.totalAvailable} bold />}
          {/* 이번 총 차감액: 차감(감소) 의미 → PDF와 동일하게 붉은색 계열, 2순위 강조(bold) */}
          <SummaryRow label="이번 총 차감액" value={-sum.appliedDeduction} accent={C.danger} bold />
          {/* 추가 청구액: 발생(>0) 시에만 붉은색 강조, 0원이면 일반 텍스트 */}
          <SummaryRow label="추가 청구액" value={sum.additionalCharge} accent={sum.additionalCharge > 0 ? C.danger : undefined} bold={sum.additionalCharge > 0} />
        </div>
        {/* ── 차감 후 예상잔액: 핵심 결과값 → 하단 우측 강조 카드(파란 계열) ── */}
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{
            width: 'min(320px, 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '2px 16px',
            background: C.primaryBg, border: `1.5px solid ${C.primaryBorder}`, borderRadius: 10,
            padding: '12px 16px', boxSizing: 'border-box',
          }}>
            <span style={{ ...TYPO.fieldLabel, color: C.primary, fontWeight: 700 }}>차감 후 예상잔액</span>
            <span style={{ ...TYPO.amount, marginLeft: 'auto', fontSize: 20, fontWeight: 800, color: C.primary, whiteSpace: 'nowrap' }}>
              ₩{sum.remainingAfter.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function SummaryRow({ label, value, accent, bold }: { label: string; value: number; accent?: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
      <span style={{ ...TYPO.fieldLabel, color: C.textMuted }}>{label}</span>
      <span style={{ ...TYPO.amount, color: accent ?? C.textSecondary, fontWeight: bold ? 700 : 500 }}>{formatWon(value)}</span>
    </div>
  );
}
