// ─── Current + Legacy 통합 판매이력 뷰 (C-4C) ─────────────────────────────────
// 판매관리 화면에서 자료범위 [전체자료]/[과거 CRM] 선택 시 사용. [현재] 는 기존 ProjectManagementTab 가 담당.
// /api/admin/sales-history(server-side 통합 pagination) 소비. Current row → /sales/:id, Legacy row → /legacy-archive/:id.
import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';

type AdminUser = { id: number; name?: string | null; email?: string | null };
type Row = {
  source: 'current' | 'legacy'; key: string; id: number | string;
  recordDate: string | null; saleName: string | null; companyName: string | null; contactName: string | null;
  productName: string | null; amount: number | null; collectionDate: string | null; collectionStatus: string | null;
  workflowStatus: string | null; adminId: number | null; financialStatus: string | null; quoteType: string | null;
};
type Sources = { current: { ok: boolean; count?: number; error?: string }; legacy: { ok: boolean; count?: number; error?: string; truncated?: boolean } };
type Result = { rows: Row[]; pagination: { page: number; pageSize: number; total: number; totalPages: number }; sources: Sources; degraded: boolean; range: string; forcedCurrentOnly: boolean };

const PAGE_SIZE = 50;
const WORKFLOW_KR: Record<string, string> = { created: '접수', quoted: '견적', approved: '확정', paid: '입금', matched: '배정', in_progress: '진행중', completed: '완료', cancelled: '취소' };

export function UnifiedSalesHistoryView({ authHeaders, setToast, adminUsers, range, search, onOpenSalesDetail, onOpenLegacyDetail }: {
  authHeaders: Record<string, string>; setToast: (m: string) => void; adminUsers: AdminUser[];
  range: 'all' | 'legacy'; search: string;
  onOpenSalesDetail: (id: number) => void; onOpenLegacyDetail: (id: number) => void;
}) {
  const [q, setQ] = useState(search);
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  const adminName = (id: number | null) => (id == null ? null : adminUsers.find(u => u.id === id)?.name || null);

  const load = useCallback(async (page = 1, keyword = q) => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('range', range);
      if (keyword.trim()) p.set('search', keyword.trim());
      p.set('page', String(page)); p.set('pageSize', String(PAGE_SIZE));
      const res = await fetch(api(`/api/admin/sales-history?${p.toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '조회 실패');
      setResult(data); setRows(data.rows);
    } catch (e: any) { setToast(e?.message || '판매이력 조회 실패'); }
    finally { setLoading(false); }
  }, [range, q, authHeaders]);

  useEffect(() => { load(1, q); /* range 변경 시 재조회 */ }, [range]); // eslint-disable-line

  const p = result?.pagination;
  const srcCurrentFailed = result && !result.sources.current.ok && range !== 'legacy';
  const srcLegacyFailed = result && !result.sources.legacy.ok;

  const btn = (disabled: boolean, primary?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });

  return (
    <div data-testid="unified-sales-history">
      {/* 검색 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') load(1, q); }}
               placeholder="판매명 · 거래처 · 담당자 · 상품 통합검색 (현재 + 과거 CRM)" aria-label="통합 판매이력 검색" data-testid="sales-history-search"
               style={{ padding: '8px 11px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, flex: '1 1 320px', maxWidth: 420 }} />
        <button style={btn(loading, true)} disabled={loading} onClick={() => load(1, q)} data-testid="sales-history-search-btn">{loading ? '검색 중…' : '검색'}</button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>총 {(p?.total ?? 0).toLocaleString()}건{range === 'all' ? ' (현재+과거)' : ' (과거 CRM)'}</span>
      </div>

      {/* 부분 실패 / degraded 배너 */}
      {srcLegacyFailed && <div style={{ padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, color: '#9a3412', fontSize: 13, marginBottom: 10 }} data-testid="banner-legacy-failed">과거 CRM 자료 일부를 불러오지 못했습니다. 현재 판매자료만 표시합니다.</div>}
      {srcCurrentFailed && <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 13, marginBottom: 10 }} data-testid="banner-current-failed">현재 판매자료 일부를 불러오지 못했습니다. 과거 CRM 자료만 표시합니다.</div>}
      {result?.sources.legacy.truncated && <div style={{ padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, color: '#9a3412', fontSize: 13, marginBottom: 10 }}>과거 CRM 자료가 많아 일부만 통합 표시됩니다(검색으로 범위를 좁혀주세요).</div>}

      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f3f4f6', textAlign: 'left' }}>
              {['구분', '날짜', '판매명', '거래처', '담당자', '상품', '금액', '입금/상태', '담당PM'].map(h => (
                <th key={h} style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isLegacy = r.source === 'legacy';
              return (
                <tr key={r.key} data-testid={`sh-row-${r.key}`}
                    onClick={() => isLegacy ? onOpenLegacyDetail(Number(r.id)) : onOpenSalesDetail(Number(r.id))}
                    style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')} onMouseLeave={e => (e.currentTarget.style.background = '')}>
                  <td style={{ padding: '9px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 700, background: isLegacy ? '#fef3c7' : '#dbeafe', color: isLegacy ? '#92400e' : '#1e40af' }}>
                      {isLegacy ? '과거 CRM' : '현재'}
                    </span>
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{r.recordDate ?? '-'}</td>
                  <td style={{ padding: '9px 12px' }}>{r.saleName ?? '-'}</td>
                  <td style={{ padding: '9px 12px' }}>{r.companyName ?? '-'}</td>
                  <td style={{ padding: '9px 12px' }}>{r.contactName ?? '-'}</td>
                  <td style={{ padding: '9px 12px' }}>{r.productName ?? '-'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{r.amount != null ? r.amount.toLocaleString() : '-'}</td>
                  <td style={{ padding: '9px 12px' }}>
                    {isLegacy
                      ? (r.collectionStatus === 'paid' ? '입금' : r.collectionStatus === 'unpaid' ? '미입금' : '-')
                      : (r.workflowStatus ? (WORKFLOW_KR[r.workflowStatus] ?? r.workflowStatus) : '-')}
                  </td>
                  <td style={{ padding: '9px 12px' }}>{isLegacy ? '-' : (adminName(r.adminId) ?? '-')}</td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }} data-testid="sales-history-empty">검색 결과가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {p && p.totalPages > 1 && (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 14 }}>
          <button style={btn(p.page <= 1)} disabled={p.page <= 1} onClick={() => load(p.page - 1, q)} aria-label="이전 페이지">이전</button>
          <span style={{ padding: '7px 14px', fontSize: 13, color: '#374151' }}>{p.page} / {p.totalPages}</span>
          <button style={btn(p.page >= p.totalPages)} disabled={p.page >= p.totalPages} onClick={() => load(p.page + 1, q)} aria-label="다음 페이지">다음</button>
        </div>
      )}
    </div>
  );
}
