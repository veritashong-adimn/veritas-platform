/**
 * CustomerRankingView — 고객관리 > [고객 순위]. 매출액(공급가액)·거래 건수 순위(서버 집계).
 *  · 조건: 연도 구간(시작~종료, 같으면 단일 연도 · 전체 기간 · 기준일 없음) · 상세 기간 · 순위 기준 · 고객사명 · 등급 → [조회]
 *  · 다년도 = 선택 구간 내 고객사별 매출·건수 합산(서버 집계, 기존 산정 기준 그대로)
 *  · 동일 기준값 공동 순위(1,1,3). 검색은 표시 범위만 좁히고 순위는 유지.
 *  · Excel 은 현재 조회 조건 그대로 전체 행을 서버에서 받아 생성.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/constants';
import { formatWon } from '../../lib/utils';
import { exportDataset } from '../../lib/excelExport';
import { Card, PrimaryBtn, GhostBtn } from '../ui';
import { Pagination } from '../ui/Paginator';
import { GradeBadge, CUSTOMER_GRADES } from './customerGrade';
import './readTableView.css';

interface Filters { yearFrom: string; yearTo: string; from: string; to: string; metric: 'sales' | 'count'; order: 'desc' | 'asc'; search: string; grade: string }
interface RankRow { id: number; name: string; grade: string; autoGrade: string; gradeOverridden: boolean; sales: number; count: number; lastDate: string | null; estimatedCount: number; rank: number }
interface RankResponse {
  total: number; summary: { customers: number; sales: number; count: number };
  years: { year: string; count: number }[]; undatedCount: number; rows: RankRow[];
}
const DEFAULT: Filters = { yearFrom: '', yearTo: '', from: '', to: '', metric: 'sales', order: 'desc', search: '', grade: '' };

const ctl: React.CSSProperties = { padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#111827' };
const th: React.CSSProperties = { padding: '10px 12px', fontSize: 11, fontWeight: 600, color: '#6b7280', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '9px 12px', fontSize: 13, color: '#374151', borderBottom: '1px solid #edf0f3', verticalAlign: 'middle', whiteSpace: 'nowrap' };

const toParams = (f: Filters) => {
  const p = new URLSearchParams({ metric: f.metric, order: f.order });
  if (f.yearFrom === 'undated') p.set('year', 'undated');
  else { if (f.yearFrom) p.set('yearFrom', f.yearFrom); if (f.yearTo) p.set('yearTo', f.yearTo); }
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.search.trim()) p.set('search', f.search.trim());
  if (f.grade) p.set('grade', f.grade);
  return p;
};
// 조회 기간 표시: 전체 기간 / 2026년 / 2024~2026년 / 2024년~ / ~2025년 (+ 상세 날짜)
export function yearRangeLabel(f: Pick<Filters, 'yearFrom' | 'yearTo'>): string {
  if (f.yearFrom === 'undated') return '기준일 없음';
  if (!f.yearFrom && !f.yearTo) return '전체 기간';
  if (f.yearFrom && f.yearTo) return f.yearFrom === f.yearTo ? `${f.yearFrom}년` : `${f.yearFrom}~${f.yearTo}년`;
  return f.yearFrom ? `${f.yearFrom}년~` : `~${f.yearTo}년`;
}
const periodLabel = (f: Filters) => [yearRangeLabel(f), f.from || f.to ? `(${f.from || '처음'}~${f.to || '현재'})` : ''].filter(Boolean).join(' ');

export function CustomerRankingView({ token, onToast, onOpenCustomer }: { token: string; onToast: (m: string) => void; onOpenCustomer: (id: number) => void }) {
  const [form, setForm] = useState<Filters>(DEFAULT);
  const [applied, setApplied] = useState<Filters>(DEFAULT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<RankResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = toParams(applied); p.set('page', String(page)); p.set('pageSize', String(pageSize));
      const res = await fetch(api(`/api/admin/customer-management/ranking?${p}`), { headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? '고객 순위 조회 실패');
      setData(j);
    } catch (e) { onToast(`오류: ${e instanceof Error ? e.message : '고객 순위 조회 실패'}`); } finally { setLoading(false); }
  }, [token, applied, page, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const run = (next?: Partial<Filters>) => { const f = { ...form, ...next }; setForm(f); setApplied(f); setPage(1); };
  // 헤더 클릭 정렬: 같은 기준이면 방향 전환, 다른 기준이면 해당 기준 높은 순
  const sortBy = (metric: 'sales' | 'count') => run({ metric, order: applied.metric === metric && applied.order === 'desc' ? 'asc' : 'desc' });
  const arrow = (metric: 'sales' | 'count') => (applied.metric === metric ? (applied.order === 'desc' ? ' ▼' : ' ▲') : '');

  const downloadExcel = async () => {
    setExporting(true);
    try {
      const p = toParams(applied); p.set('export', '1');
      const res = await fetch(api(`/api/admin/customer-management/ranking?${p}`), { headers: { Authorization: `Bearer ${token}` } });
      const j: RankResponse = await res.json();
      if (!res.ok) throw new Error((j as any)?.error ?? '다운로드 실패');
      const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
      exportDataset<RankRow>({
        filename: `고객순위_${periodLabel(applied).replace(/[\s()]+/g, '_').replace(/_+$/, '')}_${applied.metric === 'sales' ? '매출액' : '거래건수'}${applied.order === 'asc' ? '_낮은순' : ''}_${stamp}.xlsx`,
        sheetName: '고객 순위',
        columns: [
          { header: '조회 기간', value: () => periodLabel(applied) },
          { header: '순위', value: 'rank', type: 'number', numFmt: '0' },
          { header: '고객사', value: 'name' },
          { header: '등급', value: (r) => r.grade + (r.gradeOverridden ? '(지정)' : '') },
          { header: `매출액 합계(공급가액, ${periodLabel(applied)})`, value: 'sales', type: 'number' },
          { header: `거래 건수 합계(${periodLabel(applied)})`, value: 'count', type: 'number', numFmt: '0' },
          { header: '최근 거래일', value: (r) => r.lastDate ?? '' },
          { header: '공급가액 추정 건수', value: 'estimatedCount', type: 'number', numFmt: '0' },
        ],
        rows: j.rows,
      });
    } catch (e) { onToast(`오류: ${e instanceof Error ? e.message : '다운로드 실패'}`); } finally { setExporting(false); }
  };

  const rows = data?.rows ?? [];
  // 연도 목록: 데이터가 있는 연도(최신순) — 오름차순 선택 편의를 위해 그대로 사용
  const [yearOpts, setYearOpts] = useState<string[]>([]);
  useEffect(() => { if (data?.years?.length && !yearOpts.length) setYearOpts(data.years.map((y) => y.year)); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-testid="customer-ranking">
      {/* 조회 조건 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        {/* 연도 구간: 시작 ≤ 종료 자동 보정. 같은 연도 = 단일 연도 조회 */}
        <select value={form.yearFrom} aria-label="시작 연도" data-testid="ranking-year-from" style={ctl}
          onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, yearFrom: v, yearTo: v === 'undated' ? '' : (v && f.yearTo && f.yearTo < v ? v : f.yearTo) })); }}>
          <option value="">{form.yearTo ? '처음부터' : '전체 기간'}</option>
          {yearOpts.map((y) => <option key={y} value={y}>{y}년</option>)}
          {(data?.undatedCount ?? 0) > 0 && <option value="undated">기준일 없음</option>}
        </select>
        <span style={{ color: '#9ca3af' }}>~</span>
        <select value={form.yearTo} aria-label="종료 연도" data-testid="ranking-year-to" style={ctl} disabled={form.yearFrom === 'undated'}
          onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, yearTo: v, yearFrom: v && f.yearFrom && f.yearFrom !== 'undated' && f.yearFrom > v ? v : f.yearFrom })); }}>
          <option value="">{form.yearFrom ? '최근까지' : '전체 기간'}</option>
          {yearOpts.map((y) => <option key={y} value={y} disabled={!!form.yearFrom && form.yearFrom !== 'undated' && y < form.yearFrom}>{y}년</option>)}
        </select>
        <span style={{ width: 1, height: 22, background: '#e5e7eb', margin: '0 2px' }} />
        <input type="date" value={form.from} onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))} aria-label="시작일" data-testid="ranking-from" style={ctl} />
        <span style={{ color: '#9ca3af' }}>~</span>
        <input type="date" value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))} aria-label="종료일" data-testid="ranking-to" style={ctl} />
        <select value={`${form.metric}:${form.order}`} onChange={(e) => { const [metric, order] = e.target.value.split(':') as [Filters['metric'], Filters['order']]; setForm((f) => ({ ...f, metric, order })); }}
          aria-label="순위 기준" data-testid="ranking-metric" style={ctl}>
          <option value="sales:desc">매출액 높은 순</option>
          <option value="sales:asc">매출액 낮은 순</option>
          <option value="count:desc">거래 건수 많은 순</option>
          <option value="count:asc">거래 건수 적은 순</option>
        </select>
        <select value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} aria-label="고객 등급" data-testid="ranking-grade" style={ctl}>
          <option value="">전체 등급</option>
          {CUSTOMER_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input value={form.search} onChange={(e) => setForm((f) => ({ ...f, search: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder="고객사명 검색" aria-label="고객사명 검색" data-testid="ranking-search" style={{ ...ctl, flex: '1 1 160px', maxWidth: 240 }} />
        <PrimaryBtn onClick={() => run()} disabled={loading} style={{ padding: '7px 16px', fontSize: 13 }} data-testid="ranking-search-btn" aria-label="고객 순위 조회">
          {loading ? '조회 중...' : '조회'}
        </PrimaryBtn>
        <GhostBtn onClick={() => { setForm(DEFAULT); setApplied(DEFAULT); setPage(1); }} style={{ padding: '7px 12px', fontSize: 13 }} data-testid="ranking-reset" aria-label="조회 조건 초기화">초기화</GhostBtn>
        <GhostBtn onClick={downloadExcel} disabled={exporting || !data?.total} style={{ padding: '7px 12px', fontSize: 13, marginLeft: 'auto' }} data-testid="ranking-excel" aria-label="고객 순위 Excel 다운로드">
          {exporting ? '생성 중...' : 'Excel 다운로드'}
        </GhostBtn>
      </div>

      {data && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <span style={{ fontSize: 14.5, fontWeight: 800, color: '#111827' }} data-testid="ranking-title">{periodLabel(applied)} 고객 순위</span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{applied.metric === 'sales' ? '매출액' : '거래 건수'} {applied.order === 'desc' ? (applied.metric === 'sales' ? '높은 순' : '많은 순') : (applied.metric === 'sales' ? '낮은 순' : '적은 순')}</span>
        </div>
      )}
      {data && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }} data-testid="ranking-summary">
          {periodLabel(applied)} · 거래 고객 {data.summary.customers.toLocaleString()}곳 · 전체 매출 {formatWon(data.summary.sales)} · 전체 거래 {data.summary.count.toLocaleString()}건
          {applied.search && ` · 검색 결과 ${data.total.toLocaleString()}곳`}
          <span style={{ color: '#9ca3af' }}> (부가세 제외 공급가액 · 신규 판매전환 건 + 과거 CRM 판매 · 수금과 별개)</span>
        </div>
      )}

      {rows.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 32, color: '#9ca3af', fontSize: 14 }}>{loading ? '불러오는 중...' : '조회 기간에 거래한 고객이 없습니다.'}</Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden', opacity: loading ? 0.6 : 1 }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="veritas-read-table" style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }} data-testid="ranking-table">
              <thead>
                <tr>
                  <th style={{ ...th, width: 70, textAlign: 'center' }}>순위</th>
                  <th style={{ ...th, textAlign: 'left' }}>고객사</th>
                  <th style={{ ...th, width: 80, textAlign: 'center' }}>등급</th>
                  <th style={{ ...th, width: 160, textAlign: 'right' }}>
                    <button type="button" onClick={() => sortBy('sales')} data-testid="ranking-sort-sales" aria-label="매출액 정렬" style={{ all: 'unset', cursor: 'pointer' }}>매출액{arrow('sales')}</button>
                  </th>
                  <th style={{ ...th, width: 110, textAlign: 'right' }}>
                    <button type="button" onClick={() => sortBy('count')} data-testid="ranking-sort-count" aria-label="거래 건수 정렬" style={{ all: 'unset', cursor: 'pointer' }}>거래 건수{arrow('count')}</button>
                  </th>
                  <th style={{ ...th, width: 120, textAlign: 'center' }}>최근 거래일</th>
                  <th style={{ ...th, width: 90, textAlign: 'center' }}>고객 상세</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`ranking-row-${r.id}`}>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700, color: r.rank <= 3 ? '#1d4ed8' : '#374151' }}>{r.rank}</td>
                    <td style={{ ...td, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <button type="button" onClick={() => onOpenCustomer(r.id)} title={r.name} data-testid={`ranking-open-${r.id}`} aria-label={`${r.name} 고객 상세`}
                        style={{ all: 'unset', cursor: 'pointer', fontWeight: 600, color: '#111827' }}>{r.name}</button>
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}><GradeBadge grade={r.grade} overridden={r.gradeOverridden} title={r.gradeOverridden ? `관리자 지정 · 자동 ${r.autoGrade}` : undefined} /></td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600 }} title={r.estimatedCount ? `과거 CRM ${r.estimatedCount}건 공급가액 추정 포함` : undefined}>
                      {formatWon(r.sales)}{r.estimatedCount > 0 && <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: 11 }}> *</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{r.count.toLocaleString()}건</td>
                    <td style={{ ...td, textAlign: 'center', fontSize: 12 }}>{r.lastDate ?? <span style={{ color: '#9ca3af' }}>기준일 없음</span>}</td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <GhostBtn onClick={() => onOpenCustomer(r.id)} style={{ fontSize: 12, padding: '3px 10px' }} data-testid={`ranking-detail-${r.id}`} aria-label={`${r.name} 상세 보기`}>상세</GhostBtn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {(data?.total ?? 0) > 0 && (
        <Pagination idPrefix="customer-ranking" page={page} pageSize={pageSize} total={data!.total} unit="곳" disabled={loading}
          onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
      )}
      <p style={{ margin: '8px 0 0', fontSize: 11, color: '#9ca3af' }}>* 과거 CRM 원본에 공급가액이 없어 총액 기준으로 추정한 판매가 포함된 금액입니다.</p>
    </div>
  );
}
