/**
 * customerGrade — 고객 등급 5단계 표시 공통(배지·라벨). 등급 계산은 서버(customerPerformance)에서만 한다.
 */
import React from 'react';

export type CustomerGrade = 'VIP' | '우수' | '일반' | '휴면' | '신규';
export const CUSTOMER_GRADES: CustomerGrade[] = ['VIP', '우수', '일반', '휴면', '신규'];

const STYLE: Record<CustomerGrade, { bg: string; color: string; border: string }> = {
  VIP:  { bg: '#fdf4ff', color: '#9333ea', border: '#d8b4fe' },
  우수: { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  일반: { bg: '#f8fafc', color: '#64748b', border: '#cbd5e1' },
  휴면: { bg: '#fafaf9', color: '#a8a29e', border: '#e7e5e4' },
  신규: { bg: '#f0fdf4', color: '#16a34a', border: '#86efac' },
};

export function GradeBadge({ grade, overridden, title }: { grade: CustomerGrade | string; overridden?: boolean; title?: string }) {
  const st = STYLE[grade as CustomerGrade] ?? STYLE['일반'];
  return (
    <span title={title} data-testid="customer-grade-badge"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap', background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>
      {grade}{overridden && <span style={{ fontSize: 9, fontWeight: 700, opacity: 0.85 }}>·지정</span>}
    </span>
  );
}
