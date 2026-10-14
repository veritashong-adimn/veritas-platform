// ─── Current + Legacy 통합 판매이력 뷰 (C-4C) ─────────────────────────────────
// 판매관리 화면에서 자료범위 [전체자료]/[과거 CRM] 선택 시 사용. [현재] 는 기존 ProjectManagementTab 가 담당.
// /api/admin/sales-history(server-side 통합 pagination) 소비. Current row → /sales/:id, Legacy row → /legacy-archive/:id.
import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Pagination } from '../ui/Paginator';

type AdminUser = { id: number; name?: string | null; email?: string | null };
type Row = {
  source: 'current' | 'legacy'; key: string; id: number | string;
  recordDate: string | null; saleName: string | null; companyName: string | null; contactName: string | null;
  productName: string | null; amount: number | null; collectionDate: string | null; collectionStatus: string | null;
  workflowStatus: string | null; adminId: number | null; financialStatus: string | null; quoteType: string | null;
  taxInvoiceDate: string | null; salesRep: string | null;
  paymentDate: string | null; paymentMemo: string | null;
};

// (표시 전용) 통역/번역 서비스 유형 분류 — 원본 변경 없이 상품명 기준.
//   통역→통역 / 번역→번역 / 상품명은 있으나 통역·번역 아님(장비 등)→기타 / 상품명 없음·둘 다 명시(확정 불가)→미분류.
function serviceTypeOf(r: Row): string {
  const prod = (r.productName ?? '').trim();
  if (!prod) return '미분류';
  const isInterp = /통역/.test(prod), isTrans = /번역/.test(prod);
  if (isInterp && !isTrans) return '통역';
  if (isTrans && !isInterp) return '번역';
  if (isInterp && isTrans) return '미분류';   // 두 유형 동시 명시 → 확정 불가
  return '기타';                               // 명확한 기타 서비스(상품명 존재, 통역/번역 아님)
}
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
  const [pageSize, setPageSize] = useState(PAGE_SIZE);   // 기본 50(기존 유지). 공통 Pagination 의 페이지당 선택과 연동.

  const adminName = (id: number | null) => (id == null ? null : adminUsers.find(u => u.id === id)?.name || null);

  const load = useCallback(async (page = 1, keyword = q, size = pageSize) => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('range', range);
      if (keyword.trim()) p.set('search', keyword.trim());
      p.set('page', String(page)); p.set('pageSize', String(size));
      const res = await fetch(api(`/api/admin/sales-history?${p.toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || '조회 실패');
      setResult(data); setRows(data.rows);
    } catch (e: any) { setToast(e?.message || '판매이력 조회 실패'); }
    finally { setLoading(false); }
  }, [range, q, pageSize, authHeaders]);

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

      {/* 표 자체 스크롤 영역(세로/가로). 헤더는 이 영역 상단에 sticky — 페이지 상단 메뉴·검색영역과 겹치지 않음. */}
      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 300px)', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              {([['날짜', '8%'], ['거래처', '22%'], ['고객 담당자', '9%'], ['통역/번역', '7%'], ['상품', '14%'], ['금액', '8%'], ['계산서발행일', '10%'], ['입금일', '8%'], ['입금내역', '7%'], ['담당PM', '7%']] as [string, string][]).map(([h, w]) => (
                <th key={h} style={{ width: w, padding: '10px 12px', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2, background: '#f3f4f6' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isLegacy = r.source === 'legacy';
              // (거래처 목록과 동일 Zebra) nth-child(odd)=1·3·5행=#f9fafb / 짝수행 흰색 / hover #f3f4f6 — 색상 재사용.
              const zebra = i % 2 === 0 ? '#f9fafb' : '#fff';
              return (
                <tr key={r.key} data-testid={`sh-row-${r.key}`}
                    onClick={() => isLegacy ? onOpenLegacyDetail(Number(r.id)) : onOpenSalesDetail(Number(r.id))}
                    style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer', background: zebra, transition: 'background-color 0.12s ease' }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')} onMouseLeave={e => (e.currentTarget.style.background = zebra)}>
                  {/* 구분 badge 열 제거 — 현재/과거 구분은 탭 필터·행 클릭 라우팅(isLegacy)으로 유지 */}
                  {/* 열 순서: 날짜 | 거래처 | 고객 담당자 | 통역/번역 | 상품 | 금액 | 계산서발행일 | 입금일 | 입금내역 | 담당PM */}
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.recordDate ?? '-'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.companyName ?? undefined}>{r.companyName ?? '-'}</td>
                  {/* 고객 담당자 = 거래처 측 담당자(contactName). 담당PM 과 서로 대체하지 않음. */}
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.contactName ?? undefined}>{r.contactName ?? '-'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{serviceTypeOf(r)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.productName ?? undefined}>{r.productName ?? '-'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.amount != null ? r.amount.toLocaleString() : '-'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.taxInvoiceDate ?? '-'}</td>
                  {/* 입금일(YYYY-MM-DD) · 입금내역(원문 보존, 상태 변환 없음) — 원본 값 없으면 '-' */}
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.paymentDate ?? '-'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.paymentMemo ?? undefined}>{r.paymentMemo ?? '-'}</td>
                  {/* 담당PM = 베리타스 내부 담당자(legacy=영업담당자, current=adminName). 고객 담당자와 대체 금지. 맨 오른쪽. */}
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={(isLegacy ? r.salesRep : adminName(r.adminId)) ?? undefined}>{(isLegacy ? r.salesRep : adminName(r.adminId)) ?? '-'}</td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={10} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }} data-testid="sales-history-empty">검색 결과가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* (표준화) 거래처 등과 동일한 공통 Pagination — 좌: 범위/전체/페이지당, 우: 처음/이전/1~5/다음/마지막 */}
      {p && p.total > 0 && (
        <Pagination
          idPrefix="sales-history"
          page={p.page}
          pageSize={p.pageSize}
          total={p.total}
          unit="건"
          disabled={loading}
          onPageChange={(pg) => load(pg, q)}
          onPageSizeChange={(s) => { setPageSize(s); load(1, q, s); }}
        />
      )}
    </div>
  );
}
