// ─────────────────────────────────────────────────────────────────────────────
// 수금 현황 — 판매건별 보기(조회 전용). 데이터 SSOT = GET /api/admin/collections/sales?include=legacy
//  · 판매건 1건 = 1행. 청구회차가 여러 개여도 판매금액·미수금은 판매건당 1회만 집계(서버 계산값 그대로 표시).
//  · 수금상태: 미입금(입금 0) / 부분입금(0 < 입금 < 판매금액) / 입금완료(입금 ≥ 판매금액), 초과입금은 별도 경고.
//  · 미수금(입금 기준)과 세금계산서 미발행금액·발행 후 입금대기(발행 기록 기준)·청구 전 금액은 서로 다른 값으로 분리 표시.
//  · 입력/수정 없음 — 행 클릭 시 판매상세(청구정보) 또는 과거 CRM 판매 상세로 이동.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { formatWon } from "@/lib/utils";
import { api } from '../../lib/constants';
import { Card, FilterPill, GhostBtn } from '../ui';
import { Pagination } from '../ui/Paginator';
import './readTableView.css';
import { formatDisplayDate } from '../../lib/dateFormat';
import { exportSaleCollections, installmentSummary, SALE_STATUS_LABEL, INSTALLMENT_STATUS_LABEL, type SaleCollectionExportRow } from '../../lib/collectionsExcel';
import { displayPaymentMethod } from '../../lib/paymentMethodDisplay';
import { VAT_MODE_LABEL, type VatMode } from '../../lib/quoteTaxType';

type Installment = SaleCollectionExportRow['installments'][number] & {
  id: number; paidAmount: number; receivable: number; paymentMethod: string | null;
  issueDate: string | null; expectedDate: string | null; lastPaidDate: string | null; invoiceTarget: boolean;
};
export type SaleCollectionRow = Omit<SaleCollectionExportRow, 'installments'> & {
  rowKey: string;
  projectId: number | null;
  legacyRowId: number | null;
  installments: Installment[];
  billedAmount: number | null;
  parsedDepositAmount?: number | null;
  saleDate?: string | null;
};
type SaleSummary = {
  count: number; totalSales: number; totalPaid: number; totalReceivable: number;
  unpaid: { count: number; amount: number };
  partial: { count: number; receivable: number; paid: number };
  completed: { count: number; amount: number };
  overpaid: { count: number; amount: number };
  unbilled: number; unissued: number; issuedAwaiting: number; overdueCount: number;
  review?: { count: number; totalAmount: number };
  sources?: { current: number; legacy: number; legacyLinkedExcluded: number };
};

type StatusFilter = 'all' | 'unpaid' | 'partial' | 'completed' | 'overpaid' | 'review';
type SourceFilter = 'all' | 'current' | 'legacy';
type SortKey = 'default' | 'paidRate' | 'receivable' | 'expectedDate';
const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '전체' }, { key: 'unpaid', label: '미입금' }, { key: 'partial', label: '부분입금' },
  { key: 'completed', label: '입금완료' }, { key: 'overpaid', label: '초과입금' }, { key: 'review', label: '확인 필요' },
];
const STATUS_STYLE: Record<SaleCollectionRow['status'], { bg: string; color: string }> = {
  unpaid: { bg: '#f3f4f6', color: '#4b5563' },
  partial: { bg: '#fef3c7', color: '#b45309' },
  completed: { bg: '#dcfce7', color: '#15803d' },
  review: { bg: '#ede9fe', color: '#6d28d9' },
};
const INST_STYLE: Record<string, { bg: string; color: string }> = {
  completed: { bg: '#dcfce7', color: '#15803d' }, partial: { bg: '#fef3c7', color: '#b45309' }, scheduled: { bg: '#f3f4f6', color: '#6b7280' },
};

const th: React.CSSProperties = {
  padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280', background: '#f9fafb',
  borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '9px 12px', fontSize: 13, color: '#374151', borderBottom: '1px solid #edf0f3', verticalAlign: 'middle' };
const tdNum: React.CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const wonOrDash = (n: number | null | undefined) => (n == null ? '-' : formatWon(n));
const fmtDate = (s: string | null | undefined) => (s ? formatDisplayDate(s.slice(0, 10)) : '-');

interface Props {
  token: string;
  onToast?: (msg: string) => void;
  onOpenSalesDetail?: (projectId: number) => void;
  onOpenLegacyDetail?: (legacyRowId: number) => void;
}

export function CollectionsSaleView({ token, onToast, onOpenSalesDetail, onOpenLegacyDetail }: Props) {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [rows, setRows] = useState<SaleCollectionRow[]>([]);
  const [summary, setSummary] = useState<SaleSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'default', dir: 'desc' });
  const [pg, setPg] = useState({ page: 1, pageSize: 50 });

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError(null);
      const res = await fetch(api('/api/admin/collections/sales?include=legacy'), { headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const list: SaleCollectionRow[] = Array.isArray(data?.rows) ? data.rows : [];
        setRows(list); setSummary(data?.summary ?? null);
      } else {
        const m = res.status === 401 || res.status === 403 ? '수금 현황 조회 권한이 없습니다.' : (data?.error ?? `수금 현황 API 오류 (HTTP ${res.status})`);
        setLoadError(m); onToast?.(`오류: ${m}`);
      }
    } catch {
      setLoadError('서버에 연결할 수 없습니다(데이터 연결 오류).'); onToast?.('오류: 수금 현황 조회 실패');
    } finally { setLoading(false); }
  }, [authHeaders, onToast]);
  useEffect(() => { fetchRows(); }, [fetchRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (source !== 'all' && r.source !== source) return false;
      if (filter === 'overpaid') { if (!r.overpaid) return false; }
      else if (filter !== 'all' && r.status !== filter) return false;
      if (q) {
        const hay = [r.saleNumber, r.companyName, r.projectTitle, r.pmName].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // 기본: 신규 판매(최신 판매건 먼저) → 과거 CRM(판매일 최신순). 정렬 기준값이 없는 행은 항상 뒤로.
    if (sort.key === 'default') {
      return out.sort((a, b) => (a.source === b.source ? 0 : a.source === 'current' ? -1 : 1)
        || (a.source === 'legacy' ? (b.saleDate ?? '').localeCompare(a.saleDate ?? '') : (b.projectId ?? 0) - (a.projectId ?? 0)));
    }
    const val = (r: SaleCollectionRow): number | string | null =>
      sort.key === 'paidRate' ? r.paidRate : sort.key === 'receivable' ? r.receivable : r.nextExpectedDate;
    const d = sort.dir === 'asc' ? 1 : -1;
    return out.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * d;
    });
  }, [rows, filter, source, search, sort]);
  useEffect(() => { setPg((v) => ({ ...v, page: 1 })); }, [filter, source, search, sort]);
  const pageRows = filtered.slice((pg.page - 1) * pg.pageSize, pg.page * pg.pageSize);
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key
    ? (s.dir === (key === 'expectedDate' ? 'asc' : 'desc') ? { key, dir: key === 'expectedDate' ? 'desc' : 'asc' } : { key: 'default', dir: 'desc' })
    : { key, dir: key === 'expectedDate' ? 'asc' : 'desc' }));
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕');
  const reset = () => { setFilter('all'); setSource('all'); setSearch(''); setSort({ key: 'default', dir: 'desc' }); };
  const openRow = (r: SaleCollectionRow) => {
    if (r.source === 'legacy') { if (r.legacyRowId != null) onOpenLegacyDetail?.(r.legacyRowId); }
    else if (r.projectId != null) onOpenSalesDetail?.(r.projectId);
  };

  const headers: { label: string; align?: 'right'; sortKey?: SortKey; title?: string }[] = [
    { label: '판매번호' }, { label: '거래처명' }, { label: '프로젝트명' },
    { label: '총 판매금액', align: 'right', title: '판매상세 총 판매금액(일반과세 VAT 포함 · 영세율/면세는 부가세 0원)' },
    { label: '누적 입금액', align: 'right' },
    { label: '잔여 미수금', align: 'right', sortKey: 'receivable', title: '총 판매금액 − 실제 누적 입금액' },
    { label: '입금률', align: 'right', sortKey: 'paidRate', title: '실제 누적 입금액 ÷ 총 판매금액 × 100' },
    { label: '수금상태' }, { label: '청구회차' },
    { label: '청구 전 금액', align: 'right', title: '총 판매금액 중 아직 청구행이 없는 금액' },
    { label: '미발행금액', align: 'right', title: '결제방법이 세금계산서인 청구 중 발행일 기록이 없는 금액' },
    { label: '발행 후 입금대기', align: 'right', title: '세금계산서 발행일이 기록된 청구 중 아직 입금되지 않은 금액' },
    { label: '입금예정일', sortKey: 'expectedDate', title: '미수금이 남은 청구회차 중 가장 빠른 입금예정일' },
    { label: '최종 입금일' }, { label: '담당PM' },
  ];

  return (
    <div data-testid="collections-sale-view">
      {/* ── 상단 요약(판매건 단위 — 회차 중복 합산 없음) ── */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 10 }}>
          <SummaryCard testId="sale-sum-receivable" label="전체 미수금" value={formatWon(summary.totalReceivable)} color={summary.totalReceivable > 0 ? '#dc2626' : '#111827'}
            sub={`총 판매 ${formatWon(summary.totalSales)} · 입금 ${formatWon(summary.totalPaid)}`} />
          <SummaryCard testId="sale-sum-unpaid" label={`미입금 ${summary.unpaid.count.toLocaleString()}건`} value={formatWon(summary.unpaid.amount)} color="#4b5563" sub="입금 0원 판매건의 미수금" onClick={() => setFilter('unpaid')} />
          <SummaryCard testId="sale-sum-partial" label={`부분입금 ${summary.partial.count.toLocaleString()}건`} value={formatWon(summary.partial.receivable)} color="#b45309" sub={`잔여 미수금 · 입금 ${formatWon(summary.partial.paid)}`} onClick={() => setFilter('partial')} highlight={summary.partial.count > 0} />
          <SummaryCard testId="sale-sum-completed" label={`입금완료 ${summary.completed.count.toLocaleString()}건`} value={formatWon(summary.completed.amount)} color="#15803d" sub="판매금액 합계" onClick={() => setFilter('completed')} />
        </div>
      )}
      {summary && (
        <div data-testid="sale-sum-sub" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, margin: '0 0 12px', padding: '7px 12px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, color: '#4b5563' }}>
          <span title="총 판매금액 중 아직 청구행이 없는 금액(미수금에 포함)">청구 전 금액 <b>{formatWon(summary.unbilled)}</b></span>
          <span title="세금계산서 청구 중 발행 기록이 없는 금액 — 미수금과 별개">세금계산서 미발행 <b>{formatWon(summary.unissued)}</b></span>
          <span title="세금계산서 발행 후 아직 입금되지 않은 금액">발행 후 입금대기 <b>{formatWon(summary.issuedAwaiting)}</b></span>
          {summary.overpaid.count > 0 && <span style={{ color: '#dc2626', fontWeight: 600 }}>⚠ 초과입금 {summary.overpaid.count}건 · {formatWon(summary.overpaid.amount)}</span>}
          {summary.overdueCount > 0 && <span style={{ color: '#dc2626' }}>기한경과 {summary.overdueCount}건</span>}
          <span style={{ color: '#9ca3af' }}>(청구 전 금액·미발행금액은 신규 판매 기준)</span>
        </div>
      )}
      {summary?.review && summary.review.count > 0 && (
        <div data-testid="sale-review-notice" style={{ margin: '0 0 12px', padding: '7px 12px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8, fontSize: 12, color: '#5b21b6' }}>
          확인 필요(과거 CRM) <b>{summary.review.count.toLocaleString()}건</b> · 판매총액 <b>{formatWon(summary.review.totalAmount)}</b> — 입금 판정이 불명확해 상단 집계에서 제외.
        </div>
      )}

      {/* ── 필터 + 검색 ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => (
            <span key={f.key} data-testid={`sale-filter-${f.key}`}><FilterPill label={f.label} active={filter === f.key} onClick={() => setFilter(f.key)} /></span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} data-testid="sale-collections-source" aria-label="과거·신규 구분"
            style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
            <option value="all">과거+신규 전체</option><option value="current">신규 판매</option><option value="legacy">과거 CRM</option>
          </select>
          <input data-testid="sale-collections-search" aria-label="판매건 검색" placeholder="거래처명 · 판매번호 · 프로젝트명 · 담당PM"
            value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '7px 12px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 8, minWidth: 260 }} />
          <GhostBtn onClick={reset} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="sale-collections-reset" aria-label="검색 초기화">초기화</GhostBtn>
          <GhostBtn
            onClick={() => {
              if (filtered.length === 0) { onToast?.('다운로드할 수금 내역이 없습니다.'); return; }
              exportSaleCollections(filtered); onToast?.(`${filtered.length.toLocaleString()}건을 Excel로 내보냈습니다.`);
            }}
            style={{ fontSize: 12, padding: '6px 14px' }} data-testid="sale-collections-excel" aria-label="판매건별 수금 현황 Excel 다운로드">
            Excel 다운로드
          </GhostBtn>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af', fontSize: 14 }}>불러오는 중...</div>
      ) : loadError ? (
        <Card style={{ textAlign: 'center', padding: 24, color: '#dc2626', fontSize: 14 }}>
          ⚠ {loadError} <GhostBtn onClick={fetchRows} style={{ fontSize: 12, padding: '5px 12px', marginLeft: 8 }} data-testid="sale-collections-retry" aria-label="다시 시도">다시 시도</GhostBtn>
        </Card>
      ) : filtered.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 32, color: '#9ca3af', fontSize: 14 }}>{rows.length === 0 ? '판매건이 없습니다.' : '조건에 맞는 판매건이 없습니다.'}</Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ fontSize: 12, color: '#6b7280', padding: '8px 12px', borderBottom: '1px solid #edf0f3' }} data-testid="sale-collections-count">판매건 {filtered.length.toLocaleString()}건</div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 340px)' }}>
            <table className="veritas-read-table vz-sticky" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th key={h.label} title={h.title} style={{ ...th, textAlign: h.align ?? 'left', cursor: h.sortKey ? 'pointer' : undefined }}
                      onClick={h.sortKey ? () => toggleSort(h.sortKey!) : undefined}
                      data-testid={h.sortKey ? `sale-sort-${h.sortKey}` : undefined}
                      aria-label={h.sortKey ? `${h.label} 정렬` : undefined}
                      aria-sort={h.sortKey && sort.key === h.sortKey ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {h.label}{h.sortKey ? <span style={{ color: sort.key === h.sortKey ? '#2563eb' : '#cbd5e1' }}>{sortMark(h.sortKey)}</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => {
                  const st = STATUS_STYLE[r.status];
                  const isLegacy = r.source === 'legacy';
                  const hasRecv = (r.receivable ?? 0) > 0;
                  return (
                    <tr key={r.rowKey} data-testid={`sale-collection-row-${r.rowKey}`} data-status={r.status} onClick={() => openRow(r)}
                      style={{ cursor: 'pointer', background: r.status === 'partial' ? '#fffbeb' : undefined }}>
                      <td style={{ ...td, fontWeight: 600, color: '#2563eb', whiteSpace: 'nowrap' }}>
                        {r.saleNumber ?? '-'}
                        {isLegacy ? <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 600, color: '#6d28d9', background: '#f5f3ff', padding: '1px 5px', borderRadius: 6 }}>과거 CRM</span> : null}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.companyName ?? '-'}</td>
                      <td style={{ ...td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.projectTitle ?? '(제목 없음)'}</td>
                      <td style={{ ...tdNum, fontWeight: 700, color: '#0891b2' }}>{formatWon(r.saleTotal)}
                        {/* 세금 유형 — 일반과세(기본)는 표시 생략, 영세율·면세·확인 필요만 표시 */}
                        {r.saleTaxType && r.saleTaxType !== 'taxable' && (
                          <div data-testid={`sale-tax-type-${r.rowKey}`} style={{ fontSize: 11, fontWeight: 600, color: r.saleTaxType === 'unknown' ? '#b45309' : '#6b7280' }}>{r.saleTaxType === 'unknown' ? '세금 유형 확인 필요' : VAT_MODE_LABEL[r.saleTaxType as VatMode]}</div>
                        )}</td>
                      <td style={tdNum} title={r.status === 'review' && r.parsedDepositAmount != null ? `입금내역에서 읽힌 금액 ${formatWon(r.parsedDepositAmount)} (미확정 — 집계 제외)` : undefined}>{wonOrDash(r.paidAmount)}</td>
                      <td style={{ ...tdNum, fontWeight: hasRecv ? 700 : 400, color: hasRecv ? '#dc2626' : '#9ca3af' }}>{wonOrDash(r.receivable)}</td>
                      <td style={tdNum}><RateCell rate={r.paidRate} overpaid={r.overpaid} /></td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <span title={r.reviewReason ?? undefined} style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: st.bg, color: st.color, border: r.status === 'partial' ? '1px solid #fcd34d' : undefined }}>
                          {SALE_STATUS_LABEL[r.status]}
                        </span>
                        {r.overpaid ? <span title={`초과입금 ${formatWon(r.overpaidAmount)}`} style={{ marginLeft: 4, display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: '#fee2e2', color: '#dc2626' }}>⚠ 초과입금</span> : null}
                        {r.overdue ? <span style={{ marginLeft: 4, display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: '#fee2e2', color: '#dc2626' }}>기한경과</span> : null}
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }} title={installmentSummary(r) || undefined}>
                        {r.installments.length === 0 ? <span style={{ color: '#9ca3af' }}>{isLegacy ? '-' : '청구 없음'}</span>
                          : r.installments.map((i) => {
                            const s = INST_STYLE[i.status] ?? INST_STYLE.scheduled;
                            return (
                              <span key={i.id} data-testid={`sale-inst-${r.rowKey}-${i.sequence}`}
                                title={`${i.sequence}차 청구 ${formatWon(i.amount)} · 입금 ${formatWon(i.paidAmount)} · ${INSTALLMENT_STATUS_LABEL[i.status] ?? i.status}`
                                  + `${i.paymentMethod ? ` · ${displayPaymentMethod(i.paymentMethod)}` : ''}${i.issueDate ? ` · 발행 ${fmtDate(i.issueDate)}` : ''}`
                                  + `${i.expectedDate ? ` · 예정 ${fmtDate(i.expectedDate)}` : ''}${i.lastPaidDate ? ` · 입금 ${fmtDate(i.lastPaidDate)}` : ''}`}
                                style={{ display: 'inline-block', marginRight: 4, padding: '1px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: s.bg, color: s.color }}>
                                {i.sequence}차 {INSTALLMENT_STATUS_LABEL[i.status] ?? i.status}
                              </span>
                            );
                          })}
                      </td>
                      <td style={{ ...tdNum, color: (r.unbilledAmount ?? 0) > 0 ? '#b45309' : '#9ca3af' }}>{r.unbilledAmount == null ? '-' : r.unbilledAmount > 0 ? formatWon(r.unbilledAmount) : '0'}</td>
                      <td style={{ ...tdNum, color: (r.unissuedAmount ?? 0) > 0 ? '#7c3aed' : '#9ca3af' }}>{r.unissuedAmount == null ? '-' : r.unissuedAmount > 0 ? formatWon(r.unissuedAmount) : '0'}</td>
                      <td style={{ ...tdNum, color: (r.issuedAwaitingAmount ?? 0) > 0 ? '#0369a1' : '#9ca3af' }}>{r.issuedAwaitingAmount == null ? '-' : r.issuedAwaitingAmount > 0 ? formatWon(r.issuedAwaitingAmount) : '0'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: r.overdue ? '#dc2626' : '#6b7280', fontWeight: r.overdue ? 700 : 400 }}>{fmtDate(r.nextExpectedDate)}{r.overdue ? ' ⚠' : ''}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: '#6b7280' }}>{fmtDate(r.lastPaidDate)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.pmName ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '0 12px' }}>
            <Pagination idPrefix="sale-collections" page={pg.page} pageSize={pg.pageSize} total={filtered.length} unit="건" pageSizeOptions={[50, 100, 200]}
              onPageChange={(p) => setPg((v) => ({ ...v, page: p }))} onPageSizeChange={(sz) => setPg({ page: 1, pageSize: sz })} />
          </div>
        </Card>
      )}
    </div>
  );
}

function RateCell({ rate, overpaid }: { rate: number | null; overpaid: boolean }) {
  if (rate == null) return <span style={{ color: '#9ca3af' }}>-</span>;
  const w = Math.max(0, Math.min(100, rate));
  const color = overpaid ? '#dc2626' : rate >= 100 ? '#16a34a' : rate > 0 ? '#f59e0b' : '#d1d5db';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 44, height: 6, borderRadius: 3, background: '#f3f4f6', overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', width: `${w}%`, height: '100%', background: color }} />
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums', color: overpaid ? '#dc2626' : '#374151', fontWeight: overpaid ? 700 : 400 }}>{rate.toLocaleString()}%</span>
    </span>
  );
}

function SummaryCard({ label, value, color, sub, onClick, highlight, testId }: { label: string; value: string; color: string; sub?: string; onClick?: () => void; highlight?: boolean; testId: string }) {
  // Card 는 onClick·data 속성을 받지 않으므로 바깥 래퍼에서 처리(클릭 시 해당 상태 필터 적용)
  return (
    <div data-testid={testId} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `${label} 필터` : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{ cursor: onClick ? 'pointer' : undefined, borderRadius: 14, boxShadow: highlight ? '0 0 0 1px #fcd34d' : undefined }}>
      <Card style={{ padding: '12px 14px', height: '100%', boxSizing: 'border-box', background: highlight ? '#fffbeb' : undefined }}>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
        {sub ? <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{sub}</div> : null}
      </Card>
    </div>
  );
}
