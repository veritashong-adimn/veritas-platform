// ─── Current + Legacy 통합 판매이력 뷰 (C-4C) ─────────────────────────────────
// 판매관리 화면에서 자료범위 [전체자료]/[과거 CRM] 선택 시 사용. [현재] 는 기존 ProjectManagementTab 가 담당.
// /api/admin/sales-history(server-side 통합 pagination) 소비. Current row → /sales/:id, Legacy row → /legacy-archive/:id.
import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { api } from '../../lib/constants';
import { Pagination } from '../ui/Paginator';
import { SaleContactPicker } from './SaleContactPicker';
import { ContactReviewListModal } from './ContactReviewListModal';
import { LegacyPartyManager } from './LegacyPartyManager';
import { SaleDateSearchBar, appendSalePeriod, hasSalePeriod, type SalePeriod } from './SaleDateSearchBar';

type AdminUser = { id: number; name?: string | null; email?: string | null };
type Row = {
  source: 'current' | 'legacy'; key: string; id: number | string; origin?: 'legacy_crm' | null; pmName?: string | null;
  recordDate: string | null; saleName: string | null; companyName: string | null; contactName: string | null; contactState?: 'master' | 'restored' | 'review' | null;
  productName: string | null; amount: number | null; collectionDate: string | null; collectionStatus: string | null;
  workflowStatus: string | null; adminId: number | null; financialStatus: string | null; quoteType: string | null;
  taxInvoiceDate: string | null; salesRep: string | null;
  paymentDate: string | null; paymentMemo: string | null;
  paymentStatus?: 'completed' | 'partial' | null;   // current: 청구정보 실제 입금 기준(입금 없음 null)
  // 판매건 식별(서버 saleIdentity) — 판매번호 / 원 견적번호 / 프로젝트명(대체값이면 projectNameFallback)
  saleNumber?: string | null; quoteNumber?: string | null; projectName?: string | null; projectNameFallback?: boolean;
  // 공급가액·부가세·합계(서버: 판매 상세와 같은 원천). vatMode=unknown 이면 공급가·부가세 미확인('—')
  supplyAmount?: number | null; vatAmount?: number | null; totalAmount?: number | null; vatMode?: string | null;
};

// 열 구성(폭 px) — 판매번호·프로젝트명 추가로 표가 넓어지면 기존 표 가로 스크롤(overflowX)을 사용한다.
const COLUMNS: [string, number][] = [
  ['날짜', 120], ['판매번호', 136], ['거래처', 160], ['고객 담당자', 96], ['프로젝트명', 190], ['통역/번역', 64],
  ['상품', 140], ['공급가액', 96], ['부가세', 80], ['합계', 104], ['계산서발행일', 100], ['입금일', 92], ['입금내역', 110], ['담당PM', 80],
];
const TABLE_MIN_WIDTH = COLUMNS.reduce((s, [, w]) => s + w, 0);

// 금액 칸 — 우측 정렬. 미확인(부가세 유형 확인 필요·원본 구분 없음)은 '—'(임의 계산 없음)
const AMOUNT_COLS = new Set(['공급가액', '부가세', '합계']);
const amt = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString());
const vatTitle = (r: Row) => r.vatMode === 'unknown' ? '부가세 유형 확인 필요 — 공급가액·부가세를 임의로 계산하지 않습니다'
  : r.vatMode === 'zero_rate' ? '영세율(부가세 0원)' : r.vatMode === 'exempt' ? '면세(부가세 0원)' : undefined;

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

export function UnifiedSalesHistoryView({ authHeaders, setToast, adminUsers, range, search, onOpenSalesDetail, onOpenLegacyDetail, returnTick = 0, period, onPeriodChange }: {
  // 날짜별 검색(판매날짜/계산서 발행일/입금일) — 적용값은 상위(판매관리)에서 탭 공통으로 보관
  period: SalePeriod; onPeriodChange: (p: SalePeriod) => void;
  // 판매 상세에서 돌아올 때마다 증가 — 마지막 조회 조건(검색어·페이지·페이지당)으로 조용히 재조회 + 표 스크롤 복원
  returnTick?: number;
  authHeaders: Record<string, string>; setToast: (m: string) => void; adminUsers: AdminUser[];
  range: 'all' | 'legacy'; search: string;
  onOpenSalesDetail: (id: number) => void; onOpenLegacyDetail: (id: number) => void;
}) {
  const [q, setQ] = useState(search);
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);   // 기본 50(기존 유지). 공통 Pagination 의 페이지당 선택과 연동.
  // 과거 CRM 판매건(미전환·전환) 고객 담당자 보완 창
  const [contactEdit, setContactEdit] = useState<{ source: 'legacy' | 'current'; id: number } | null>(null);
  const [showReview, setShowReview] = useState(false);   // 고객 담당자 확인 필요 목록
  const [showParty, setShowParty] = useState(false);     // 미연결 관리(거래처·담당자)

  const adminName = (id: number | null) => (id == null ? null : adminUsers.find(u => u.id === id)?.name || null);

  // lastLoad = 마지막으로 '조회한' 조건(적용된 검색어). 페이지 이동·뒤로가기 재조회는 입력창 값이 아니라 이 조건을 쓴다.
  const lastLoad = useRef<{ page: number; keyword: string; size: number }>({ page: 1, keyword: q, size: pageSize });
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const tableScrollTop = useRef(0);
  const reqSeq = useRef(0);                                    // 최신 요청 번호 — 늦게 도착한 이전 응답은 버린다
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async (page = 1, keyword = lastLoad.current.keyword, size = pageSize) => {
    if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; }
    lastLoad.current = { page, keyword, size };
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('range', range);
      if (keyword.trim()) p.set('search', keyword.trim());
      appendSalePeriod(p, period);
      p.set('page', String(page)); p.set('pageSize', String(size));
      const res = await fetch(api(`/api/admin/sales-history?${p.toString()}`), { headers: authHeaders });
      const data = await res.json();
      if (seq !== reqSeq.current) return;                      // 더 최근 요청이 있음 — 이 응답은 반영하지 않음
      if (!res.ok) throw new Error(data?.error || '조회 실패');
      setResult(data); setRows(data.rows);
    } catch (e: any) { if (seq === reqSeq.current) setToast(e?.message || '판매이력 조회 실패'); }
    finally { if (seq === reqSeq.current) setLoading(false); }
  }, [range, pageSize, authHeaders, period]);
  // 검색 실행(자동 검색·[검색]·Enter 공통) — 항상 첫 페이지부터. 빈 검색어 = 전체 목록.
  const runSearch = (keyword: string) => load(1, keyword);

  useEffect(() => { load(1, lastLoad.current.keyword); /* range·날짜 검색 변경 시 같은 검색어로 첫 페이지 재조회 */ }, [range, period.basis, period.from, period.to]); // eslint-disable-line
  // 자동 검색: 입력이 멈추고 300ms 후 조회(적용된 검색어와 같으면 생략). [검색]·Enter 는 즉시 같은 runSearch.
  useEffect(() => {
    if (q.trim() === lastLoad.current.keyword.trim()) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { debounce.current = null; runSearch(q); }, 300);
    return () => { if (debounce.current) { clearTimeout(debounce.current); debounce.current = null; } };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  // 판매 상세 → 뒤로가기: 숨겨 두었던 목록 그대로 표 스크롤 복원 → 같은 조건 재조회(행은 비우지 않음 → 위치 유지, 수정된 값만 바뀜)
  useLayoutEffect(() => {
    if (returnTick <= 0) return;
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = tableScrollTop.current;
    const l = lastLoad.current;
    load(l.page, l.keyword, l.size);
  }, [returnTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = result?.pagination;
  const srcCurrentFailed = result && !result.sources.current.ok && range !== 'legacy';
  const srcLegacyFailed = result && !result.sources.legacy.ok;

  const btn = (disabled: boolean, primary?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });

  return (
    <div data-testid="unified-sales-history">
      {/* 검색 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runSearch(q); }}
               placeholder="판매번호 · 프로젝트명 · 거래처 · 담당자 · 상품 통합검색 (현재 + 과거 CRM)" aria-label="통합 판매이력 검색" data-testid="sales-history-search"
               style={{ padding: '8px 11px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, flex: '1 1 320px', maxWidth: 420 }} />
        <button style={btn(loading, true)} disabled={loading} onClick={() => runSearch(q)} data-testid="sales-history-search-btn" aria-label="판매이력 검색">{loading ? '검색 중…' : '검색'}</button>
        <SaleDateSearchBar idPrefix="sales-history" value={period} disabled={loading}
          onApply={np => (np.basis === period.basis && np.from === period.from && np.to === period.to) ? load(1, lastLoad.current.keyword) : onPeriodChange(np)} />
        <span style={{ fontSize: 12, color: '#6b7280' }} data-testid="sales-history-total">{hasSalePeriod(period) ? '검색 결과 ' : '총 '}{(p?.total ?? 0).toLocaleString()}건{range === 'all' ? ' (현재+과거)' : ' (과거 CRM)'}</span>
        <button style={{ ...btn(false), marginLeft: 'auto', background: '#fef2f2', color: '#b91c1c' }} onClick={() => setShowParty(true)} data-testid="btn-legacy-party-manager" aria-label="미연결 관리">미연결 관리</button>
        <button style={btn(false)} onClick={() => setShowReview(true)} data-testid="btn-contact-review-open" aria-label="고객 담당자 확인 필요 목록">고객 담당자 확인 필요 목록</button>
      </div>

      {/* 부분 실패 / degraded 배너 */}
      {srcLegacyFailed && <div style={{ padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, color: '#9a3412', fontSize: 13, marginBottom: 10 }} data-testid="banner-legacy-failed">과거 CRM 자료 일부를 불러오지 못했습니다. 현재 판매자료만 표시합니다.</div>}
      {srcCurrentFailed && <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 13, marginBottom: 10 }} data-testid="banner-current-failed">현재 판매자료 일부를 불러오지 못했습니다. 과거 CRM 자료만 표시합니다.</div>}
      {result?.sources.legacy.truncated && <div style={{ padding: '8px 12px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, color: '#9a3412', fontSize: 13, marginBottom: 10 }}>과거 CRM 자료가 많아 일부만 통합 표시됩니다(검색으로 범위를 좁혀주세요).</div>}

      {/* 표 자체 스크롤 영역(세로/가로). 헤더는 이 영역 상단에 sticky — 페이지 상단 메뉴·검색영역과 겹치지 않음. */}
      <div ref={tableScrollRef} onScroll={e => { tableScrollTop.current = e.currentTarget.scrollTop; }}
           style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 300px)', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <table style={{ width: '100%', minWidth: TABLE_MIN_WIDTH, borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              {COLUMNS.map(([h, w]) => (
                <th key={h} style={{ width: w, padding: '10px 12px', textAlign: AMOUNT_COLS.has(h) ? 'right' : undefined, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2, background: '#f3f4f6' }}>{h}</th>
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
                  {/* 열 순서: 날짜 | 판매번호 | 거래처 | 고객 담당자 | 프로젝트명 | 통역/번역 | 상품 | 공급가액 | 부가세 | 합계 | 계산서발행일 | 입금일 | 입금내역 | 담당PM */}
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.recordDate ?? '-'}
                    {/* 과거 CRM 에서 운영 전환된 판매건 — 출처 표시(목록에는 운영 판매 1건만 표시) */}
                    {r.origin === 'legacy_crm' && <span style={{ marginLeft: 6, padding: '1px 5px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontSize: 10, fontWeight: 700 }} data-testid={`sh-origin-${r.key}`}>과거 CRM</span>}
                  </td>
                  {/* 판매번호 — 클릭 시 해당 판매 상세(행 클릭과 같은 경로: current=판매 ID, 과거 CRM=원본 행 ID). 이름·금액으로 연결하지 않음. */}
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={r.saleNumber ? `${r.saleNumber}${r.quoteNumber && r.quoteNumber !== r.saleNumber ? ` (견적번호 ${r.quoteNumber})` : ''}` : undefined}>
                    {r.saleNumber ? (
                      <button type="button" data-testid={`sh-saleno-${r.key}`} aria-label={`판매번호 ${r.saleNumber} 상세 보기`}
                        onClick={e => { e.stopPropagation(); if (isLegacy) onOpenLegacyDetail(Number(r.id)); else onOpenSalesDetail(Number(r.id)); }}
                        onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; }} onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; }}
                        onFocus={e => { e.currentTarget.style.textDecoration = 'underline'; }} onBlur={e => { e.currentTarget.style.textDecoration = 'none'; }}
                        style={{ border: 'none', background: 'transparent', padding: '2px 4px', cursor: 'pointer', color: '#2563eb', fontWeight: 400, fontSize: 13,
                          textDecoration: 'none', textUnderlineOffset: 2, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', fontVariantNumeric: 'tabular-nums' }}>
                        {r.saleNumber}
                      </button>
                    ) : <span style={{ padding: '0 4px', color: '#9ca3af' }}>-</span>}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.companyName ?? undefined}>{r.companyName ?? '-'}</td>
                  {/* 고객 담당자 = 거래처 측 담당자(contactName). 담당PM 과 서로 대체하지 않음. */}
                  {/* 과거 CRM 판매건(미전환·전환)은 칸을 눌러 담당자 검색·선택·신규 등록(원본 불변, 별도 연결) */}
                  {(isLegacy || r.origin === 'legacy_crm') ? (
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.contactName ? `${r.contactName} — 눌러서 수정` : '눌러서 고객 담당자 입력'}
                        onClick={e => { e.stopPropagation(); setContactEdit({ source: isLegacy ? 'legacy' : 'current', id: Number(r.id) }); }}>
                      <button type="button" data-testid={`sh-contact-${r.key}`} aria-label="고객 담당자 수정" data-state={r.contactState ?? 'none'}
                        style={{ border: '1px dashed #cbd5e1', background: 'transparent', borderRadius: 6, padding: '2px 6px', cursor: 'pointer', fontSize: 13, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
                          color: r.contactState === 'review' ? '#b45309' : r.contactName ? '#111827' : '#9ca3af' }}>
                        {/* ① 담당자 Master 연결 ② 진행관리표 복원 고객명(미연결) ③ 확인 필요 ④ 없음 */}
                        {r.contactState === 'review' ? '확인 필요' : (r.contactName ?? '-')}
                        {r.contactState === 'restored' && <span style={{ marginLeft: 4, fontSize: 10, color: '#9ca3af' }} title="진행관리표에서 복원한 고객명 — 담당자 Master 미연결">미연결</span>}
                        <span style={{ marginLeft: 3, color: '#9ca3af' }}>✎</span>
                      </button>
                    </td>
                  ) : (
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.contactName ?? undefined}>{r.contactName ?? '-'}</td>
                  )}
                  {/* 프로젝트명 — 한 줄 + 말줄임, 마우스 오버 시 전체(title). 대체값(과거 CRM 전환 시 상품명으로 채워진 제목)은 회색 기울임으로 구분. */}
                  <td data-testid={`sh-project-${r.key}`} data-fallback={r.projectNameFallback ? 'true' : undefined}
                      style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        color: r.projectNameFallback ? '#9ca3af' : undefined, fontStyle: r.projectNameFallback ? 'italic' : undefined }}
                      title={r.projectName ? (r.projectNameFallback ? `${r.projectName} — 프로젝트명 없음(상품명 대체 표시)` : r.projectName) : undefined}>
                    {r.projectName ?? '-'}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{serviceTypeOf(r)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.productName ?? undefined}>{r.productName ?? '-'}</td>
                  {/* 공급가액 · 부가세 · 합계 — 판매 상세 저장값 기준. 영세율·면세 부가세 0, 미확인은 '—' */}
                  <td data-testid={`sh-supply-${r.key}`} title={vatTitle(r)} style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.supplyAmount == null ? '#9ca3af' : undefined }}>{amt(r.supplyAmount)}</td>
                  <td data-testid={`sh-vat-${r.key}`} title={vatTitle(r)} style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.vatAmount == null ? '#9ca3af' : undefined }}>{amt(r.vatAmount)}</td>
                  <td data-testid={`sh-total-${r.key}`} style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: '#111827' }}>{amt(r.totalAmount ?? r.amount)}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.taxInvoiceDate ?? '-'}</td>
                  {/* 입금일(YYYY-MM-DD) · 입금내역(원문 보존, 상태 변환 없음) — 원본 값 없으면 '-' */}
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.paymentDate ?? '-'}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={r.paymentMemo ? `${r.paymentStatus === 'partial' ? '[부분입금] ' : r.paymentStatus === 'completed' ? '[입금완료] ' : ''}${r.paymentMemo}` : undefined}>
                    {/* current: 청구정보 입금상태 — 부분입금 / 입금완료 (입금 없음은 표시 없음) */}
                    {r.paymentStatus && <span data-testid={`sh-paystatus-${r.key}`} style={{ marginRight: 4, padding: '1px 4px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                      background: r.paymentStatus === 'partial' ? '#fef3c7' : '#dcfce7', color: r.paymentStatus === 'partial' ? '#92400e' : '#166534' }}>{r.paymentStatus === 'partial' ? '부분' : '완료'}</span>}
                    {r.paymentMemo ?? '-'}
                  </td>
                  {/* 담당PM = 베리타스 내부 담당자(legacy=영업담당자, current=adminName). 고객 담당자와 대체 금지. 맨 오른쪽. */}
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={(isLegacy ? r.salesRep : (adminName(r.adminId) ?? r.pmName)) ?? undefined}>{(isLegacy ? r.salesRep : (adminName(r.adminId) ?? r.pmName)) ?? '-'}</td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={COLUMNS.length} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }} data-testid="sales-history-empty">검색 결과가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showReview && (
        <ContactReviewListModal authHeaders={authHeaders} onClose={() => setShowReview(false)}
          onPick={id => { setShowReview(false); setContactEdit({ source: 'legacy', id }); }} />
      )}
      {showParty && (
        <LegacyPartyManager authHeaders={authHeaders} onClose={() => { setShowParty(false); load(p?.page ?? 1, lastLoad.current.keyword); }}
          onOpenSale={r => { setShowParty(false); if (r.source === 'legacy' && r.saleRowId) onOpenLegacyDetail(r.saleRowId); else if (r.projectId) onOpenSalesDetail(r.projectId); }} />
      )}
      {contactEdit && (
        <SaleContactPicker source={contactEdit.source} id={contactEdit.id} authHeaders={authHeaders}
          onClose={() => setContactEdit(null)}
          onSaved={msg => { setContactEdit(null); setToast(msg); load(p?.page ?? 1, lastLoad.current.keyword); }} />
      )}

      {/* (표준화) 거래처 등과 동일한 공통 Pagination — 좌: 범위/전체/페이지당, 우: 처음/이전/1~5/다음/마지막 */}
      {p && p.total > 0 && (
        <Pagination
          idPrefix="sales-history"
          page={p.page}
          pageSize={p.pageSize}
          total={p.total}
          unit="건"
          disabled={loading}
          onPageChange={(pg) => load(pg, lastLoad.current.keyword)}
          onPageSizeChange={(s) => { setPageSize(s); load(1, lastLoad.current.keyword, s); }}
        />
      )}
    </div>
  );
}
