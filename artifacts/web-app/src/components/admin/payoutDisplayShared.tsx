// ─── 지급회차관리 화면 공통 표시(2026-11-25) — 지급준비점검·지급대상별 요약·건별 상세내역 ─────────────────
//  지급상태 6종(서버 lib/payDisplayStatus 와 같은 키) · 외화 통화별 요약 · 판매번호 → 판매상세 연결. 표시 전용(저장값·계산 불변).
import React from 'react';

export type PayStatusKey = 'scheduled' | 'unpaid' | 'paid' | 'free' | 'hold' | 'review';
export const PAY_STATUS_ORDER: PayStatusKey[] = ['scheduled', 'unpaid', 'paid', 'free', 'hold', 'review'];
export const PAY_STATUS_META: Record<PayStatusKey, { label: string; fg: string; bg: string; tip: string }> = {
  scheduled: { label: '지급예정', fg: '#047857', bg: '#ecfdf5', tip: '지급일이 오늘 또는 이후인 미지급 건' },
  unpaid: { label: '미지급', fg: '#b45309', bg: '#fffbeb', tip: '지급일이 지났는데 지급완료가 아닌 건' },
  paid: { label: '지급완료', fg: '#1d4ed8', bg: '#eff6ff', tip: '지급완료 판정 건' },
  free: { label: '무료 제공', fg: '#475569', bg: '#f1f5f9', tip: '정상 무료 제공으로 확인된 0원 건(송금 대상 아님)' },
  hold: { label: '지급보류', fg: '#7c3aed', bg: '#f5f3ff', tip: '수행정보 지급보류' },
  review: { label: '지급확인 필요', fg: '#b91c1c', bg: '#fef2f2', tip: '과거 지급 여부 미확인·중복 의심·지급금액 미입력·지급일 없음' },
};
export const PAY_STATUS_FILTER_OPTS: [string, string][] = [['all', '전체 지급상태'], ...PAY_STATUS_ORDER.map(k => [k, PAY_STATUS_META[k].label] as [string, string])];

export function PayStatusBadge({ status, label, testid }: { status?: string | null; label?: string | null; testid?: string }) {
  const m = PAY_STATUS_META[(status ?? 'review') as PayStatusKey] ?? PAY_STATUS_META.review;
  return <span data-testid={testid} title={m.tip} aria-label={`지급상태 ${label ?? m.label}`}
    style={{ padding: '2px 8px', borderRadius: 10, background: m.bg, color: m.fg, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{label ?? m.label}</span>;
}

/** 지급상태별 건수 — 0건은 생략 */
export function payStatusChips(counts: Record<string, number> | null | undefined, small = false): React.ReactNode {
  const ks = PAY_STATUS_ORDER.filter(k => (counts?.[k] ?? 0) > 0);
  if (!ks.length) return <span style={{ fontSize: 10, color: '#9ca3af' }}>-</span>;
  return ks.map(k => { const m = PAY_STATUS_META[k]; return (
    <span key={k} title={m.tip} data-testid={`pay-status-count-${k}`}
      style={{ fontSize: small ? 10 : 11, color: m.fg, background: m.bg, padding: '1px 6px', borderRadius: 7, marginRight: 4, whiteSpace: 'nowrap', fontWeight: 700 }}>{m.label} {counts![k]}건</span>); });
}

export type ForeignTotal = { currency: string; count: number; amount: number; missing: number };
export const fxNum = (cur: string, v: number) => v.toLocaleString('ko-KR', { minimumFractionDigits: cur === 'JPY' ? 0 : 2, maximumFractionDigits: 2 });
/** 외화 통화별 요약 — 'EUR 5,506.70 · 5건(금액 미입력 1건)' (원화 합계와 별도) */
export function fxSummaryText(list: ForeignTotal[]): string {
  return list.map(f => `${f.currency} ${fxNum(f.currency, f.amount)} · ${f.count}건${f.missing ? `(금액 미입력 ${f.missing}건)` : ''}`).join(' / ');
}

/** 판매번호 → 판매상세(새 탭, 현재 화면 유지). 판매 id 가 없으면(CRM 원본만) 번호만 표시 */
export function SaleLink({ projectId, saleNo, testid }: { projectId?: number | null; saleNo?: string | null; testid?: string }) {
  const label = saleNo || (projectId ? `#${projectId}` : '—');
  if (!projectId) return <span data-testid={testid}>{label}</span>;
  return <a href={`/sales/${projectId}`} target="_blank" rel="noopener noreferrer" data-testid={testid} aria-label={`판매상세 ${label} 열기`}
    title="판매상세 열기(새 탭)" onClick={(e) => e.stopPropagation()} style={{ color: '#0369a1', fontWeight: 600, textDecoration: 'underline' }}>{label}</a>;
}

// ─── 국내 실지급 합계(2026-11-26 대표 결정) — 서버 lib/payoutAmount.wonPayTotals 와 같은 규칙 ─────────────────────────
//   플랫폼 수행정보(source='current')의 원화 지급 건은 지급대상(개인 i:{userId} / 외주 v:{companyId})별 합계를 원 단위 반올림 후 합산
//   (지급회차·IBK 송금파일과 같은 송금 기준). 외화·과거 CRM 자료는 기존 금액 그대로. 건별 금액은 바꾸지 않고 차이를 adjustment 로 구분.
export function domesticPayeeKeyOf(r: { source?: string | null; payeeType?: string | null; payCurrency?: string | null; userId?: number | null; vendorId?: number | null }): string | null {
  if (r.source !== 'current') return null;
  if (r.payCurrency && String(r.payCurrency).toUpperCase() !== 'KRW') return null;
  if (r.payeeType === 'vendor') return r.vendorId != null ? `v:${r.vendorId}` : null;
  return r.userId != null ? `i:${r.userId}` : null;
}
const r2c = (n: number) => Math.round(n * 100) / 100;
export function wonPayTotalsOf<T>(rows: T[], net: (r: T) => number, key: (r: T) => string | null): { exact: number; pay: number; adjustment: number } {
  const groups = new Map<string, number>(); let other = 0, exact = 0;
  for (const r of rows) { const v = Number(net(r)) || 0; exact += v; const k = key(r); if (k) groups.set(k, (groups.get(k) ?? 0) + v); else other += v; }
  let pay = r2c(other); for (const s of groups.values()) pay += Math.round(r2c(s));
  return { exact: r2c(exact), pay: r2c(pay), adjustment: r2c(pay - exact) };
}
/** 원 단위 조정 표시 문구(차이가 없으면 null) — 화면·Excel 공통 */
export function roundingNote(exact: number, adjustment: number): string | null {
  if (Math.abs(adjustment) < 0.005) return null;
  const sign = adjustment > 0 ? '+' : '−';
  return `건별 합계 ${exact.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원 · 원 단위 조정 ${sign}${Math.abs(adjustment).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원(지급대상자별 원 단위 반올림)`;
}
