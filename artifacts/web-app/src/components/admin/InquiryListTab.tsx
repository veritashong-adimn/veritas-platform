/**
 * InquiryListTab — 의뢰건 목록 (일일 업무관리 화면)
 *
 * 기준일 선택 → 해당 일자 접수/처리현황 자동 집계 + 이월 미처리(이전 날짜 미처리) 강조 표시.
 * 처리상태·견적진행상태는 서버가 quote.status 기준으로 파생한 값을 그대로 표시(중복 저장 없음).
 * 행 클릭 → 상세, 체크박스 → 선택(동작 분리). 기존 ERP 목록 디자인 패턴을 따른다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { confirmAndDeleteInquiries } from './inquiryDeleteFlow';
import { formatDisplayDate } from '../../lib/dateFormat';
import { api } from '../../lib/constants';
import { CHANNEL_LABEL, PROCESSING_META, QUOTE_PROGRESS_META, kstTodayStr, inquiryServiceLabel } from '../../lib/inquiryMeta';
import { DateField } from './DatePickerShared';
import { Pagination } from '../ui/Paginator';
import { stickyBulkBarStyle } from './bulkListShared';
import './readTableView.css';

interface InquiryRow {
  id: number;
  inquiryNumber: string | null;
  receivedAt: string;
  customerReceivedDate?: string | null; customerReceivedTime?: string | null; customerReceivedStatus?: string | null;
  channel: string;
  status: string;
  companyDisplay: string | null;
  contactDisplay: string | null;
  serviceType: string | null;
  serviceTypes?: string[] | null; otherServices?: string[] | null;
  languageFrom: string | null;
  languageTo: string | null;
  pmName: string | null;
  quoteId: number | null;
  quoteNumber: string | null;
  quoteIssueDate: string | null;
  quoteProgress: string;
  saleConverted: boolean;
  processingStatus: string;
  closeReasonCode: string | null;
  isCarryover: boolean;
}
interface ListResponse {
  date: string;
  summary: { total: number; new: number; reviewing: number; quoting: number; quoteSent: number; closedNoQuote: number; unresolvedToday: number };
  carryoverCount: number;
  rows: InquiryRow[];
}

// 목록 공통 표 기준(공통 veritas-read-table 헤더 규격 · 셀 여백 9px 12px · 본문 13px)
const th: React.CSSProperties = { padding: '9px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '9px 12px', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' };
const badge = (m: { label: string; color: string; bg: string; border: string }): React.CSSProperties => ({
  display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: m.bg, color: m.color, border: `1px solid ${m.border}`, whiteSpace: 'nowrap',
});
// 일시 표시 — 목록 공통 YYYY.MM.DD HH:mm(KST)
const KST_PARTS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtDateTime = (s: string | null) => {
  if (!s) return '—';
  const d = new Date(s); if (Number.isNaN(d.getTime())) return '—';
  const p = Object.fromEntries(KST_PARTS.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
};
const lang = (r: InquiryRow) => [r.languageFrom, r.languageTo].filter(Boolean).join('→') || '—';

// 조회 기간(등록일 기준) — 기준일(date)로부터 거슬러 시작일 계산
type PeriodKey = 'today' | 'd3' | 'd7' | 'd15' | 'm1' | 'm3' | 'all';
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: '오늘' }, { key: 'd3', label: '3일' }, { key: 'd7', label: '7일' }, { key: 'd15', label: '15일' },
  { key: 'm1', label: '1개월' }, { key: 'm3', label: '3개월' }, { key: 'all', label: '전체' },
];
function periodFrom(base: string, p: PeriodKey): string {
  if (p === 'all') return 'all';
  if (p === 'today') return base;
  const [y, m, d] = base.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (p === 'm1' || p === 'm3') dt.setUTCMonth(dt.getUTCMonth() - (p === 'm1' ? 1 : 3));
  else dt.setUTCDate(dt.getUTCDate() - ({ d3: 3, d7: 7, d15: 15 }[p] - 1));
  return dt.toISOString().slice(0, 10);
}

function StatCard({ label, value, accent, highlight }: { label: string; value: number; accent?: string; highlight?: boolean }) {
  return (
    <div style={{ flex: '0 0 200px', width: 200, minHeight: 72, boxSizing: 'border-box', background: highlight ? '#fef2f2' : '#fff', border: `1px solid ${highlight ? '#fecaca' : '#e5e7eb'}`, borderRadius: 10, padding: '12px 14px' }}>   {/* 현황 카드 공통 약 200×72(가로로 늘어나지 않음) */}
      <div style={{ fontSize: 11, color: highlight ? '#b91c1c' : '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent ?? (highlight ? '#dc2626' : '#111827'), marginTop: 2 }}>{value}</div>
    </div>
  );
}

export function InquiryListTab({ token, onOpenDetail, onOpenQuote, onRegister, refreshTick, canDelete = false, onToast }: {
  token: string;
  /** 의뢰건 삭제 권한(관리자·견적 수정 권한) — 상단 [선택 삭제] 표시. 서버에서도 검증 */
  canDelete?: boolean;
  onToast?: (msg: string) => void;
  onOpenDetail: (id: number) => void;
  onOpenQuote?: (quoteId: number) => void;
  onRegister?: () => void;
  refreshTick?: number;
}) {
  const authH = { Authorization: `Bearer ${token}` };
  const [date, setDate] = useState<string>(kstTodayStr());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>('today');
  const from = periodFrom(date, period);
  // 페이지네이션 — 기간 필터 조회 결과 전체를 화면에서 나눔(목록 공통 10/20/50/100/200, 기본 50). 조회 조건 변경 시 1페이지.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => { setPage(1); }, [date, from]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/inquiries?date=${date}&from=${from}`), { headers: authH });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setData(null); return; }
      setData(d);
      setSelected(new Set());
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [date, from, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, refreshTick]);

  const toggle = (id: number) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const s = data?.summary;
  const allRows = data?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const rows = allRows.slice((curPage - 1) * pageSize, curPage * pageSize);   // 현재 페이지 행
  // 전체선택 = 현재 페이지 기준. 페이지·페이지당 변경 시 선택 초기화(다른 목록과 같은 규칙)
  const allChecked = rows.length > 0 && rows.every(r => selected.has(r.id));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map(r => r.id)));
  const goPage = (p: number) => { setPage(p); setSelected(new Set()); };
  const changeSize = (n: number) => { setPageSize(n); setPage(1); setSelected(new Set()); };
  const bulkDelete = async () => {
    if (bulkDeleting || selected.size === 0) return;
    setBulkDeleting(true);
    try {
      const items = allRows.filter(r => selected.has(r.id)).map(r => ({ id: r.id, label: r.inquiryNumber ?? `#${r.id}` }));
      const out = await confirmAndDeleteInquiries(token, items);
      if (out.deletedCount > 0) { onToast?.(`의뢰건 ${out.deletedCount}건이 삭제 처리되었습니다.`); await load(); }
    } finally { setBulkDeleting(false); }
  };
  const rangeLabel = from === 'all' ? `전체 ~ ${date}` : from === date ? date : `${from} ~ ${date}`;

  return (
    <div data-testid="inquiry-list-tab">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: 0 }} data-testid="inquiry-list-title">의뢰건 목록 ({allRows.length.toLocaleString()})</h1>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>당일 접수는 당일 처리를 원칙으로 합니다. 이월 미처리를 우선 확인하세요.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div role="group" aria-label="조회 기간" style={{ display: 'flex', border: '1px solid #d1d5db', borderRadius: 8, overflow: 'hidden' }}>
            {PERIODS.map((p, i) => {
              const on = period === p.key;
              return (
                <button key={p.key} type="button" aria-pressed={on} aria-label={`조회 기간 ${p.label}`} data-testid={`btn-inquiry-period-${p.key}`}
                  onClick={() => { setPeriod(p.key); if (p.key === 'today') setDate(kstTodayStr()); }}
                  style={{ padding: '8px 10px', fontSize: 12, fontWeight: on ? 700 : 500, border: 'none', borderLeft: i ? '1px solid #e5e7eb' : 'none', background: on ? '#2563eb' : '#f9fafb', color: on ? '#fff' : '#374151', cursor: 'pointer', whiteSpace: 'nowrap' }}>{p.label}</button>
              );
            })}
          </div>
          <DateField value={date} onChange={v => setDate(v)} testid="input-inquiry-date" ariaLabel="조회 날짜"
            style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} />
          {onRegister && (
            <button type="button" onClick={onRegister} data-testid="btn-inquiry-register-nav"
              style={{ padding: '8px 14px', fontSize: 13, fontWeight: 700, borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}>+ 의뢰건 등록</button>
          )}
        </div>
      </div>

      {/* 일일 현황 */}
      <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700, color: '#374151' }}>{rangeLabel} 의뢰 현황</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <StatCard label="총 접수" value={s?.total ?? 0} />
        <StatCard label="신규/미처리" value={s?.new ?? 0} accent="#b45309" />
        <StatCard label="확인중" value={s?.reviewing ?? 0} accent="#2563eb" />
        <StatCard label="견적작성중" value={s?.quoting ?? 0} accent="#7c3aed" />
        <StatCard label="견적발송" value={s?.quoteSent ?? 0} accent="#059669" />
        <StatCard label="견적없이 종결" value={s?.closedNoQuote ?? 0} accent="#6b7280" />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatCard label={period === 'today' ? '오늘 미처리' : '기간 내 미처리'} value={s?.unresolvedToday ?? 0} highlight={(s?.unresolvedToday ?? 0) > 0} />
        <StatCard label="이월 미처리" value={data?.carryoverCount ?? 0} highlight={(data?.carryoverCount ?? 0) > 0} />
      </div>

      {/* 현재 페이지 전체선택 바 — 목록 공통(고객·상품·견적서와 같은 형태). 선택 삭제는 기존 권한·삭제 흐름 그대로 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '9px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, ...stickyBulkBarStyle }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer', fontWeight: 600 }}>
          <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={!rows.length}
            aria-label="현재 페이지 전체 선택" data-testid="inquiry-select-page" style={{ width: 15, height: 15, cursor: 'pointer' }} />
          현재 페이지 전체선택
        </label>
        <span data-testid="inquiry-selected-count" style={{ fontSize: 13, fontWeight: 700, color: selected.size > 0 ? '#2563eb' : '#9ca3af' }}>선택 {selected.size}건</span>
        <div style={{ flex: 1 }} />
        {canDelete && (
          <button type="button" onClick={bulkDelete} disabled={selected.size === 0 || bulkDeleting}
            data-testid="inquiry-bulk-delete" aria-label="선택한 의뢰건 삭제"
            style={{ padding: '6px 14px', fontSize: 13, fontWeight: 700, borderRadius: 8, border: `1px solid ${selected.size ? '#fca5a5' : '#e5e7eb'}`, background: selected.size ? '#fef2f2' : '#f9fafb', color: selected.size ? '#dc2626' : '#9ca3af', cursor: selected.size && !bulkDeleting ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}>
            {bulkDeleting ? '삭제 중…' : '선택 삭제'}
          </button>
        )}
      </div>

      {/* 목록 */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 300px)' }}>
        <table className="veritas-read-table vz-sticky" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ ...th, width: 40 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={rows.length === 0}
                  aria-label="현재 페이지 전체 선택" data-testid="inquiry-select-all" style={{ width: 15, height: 15, cursor: 'pointer' }} />
              </th>
              {['등록일시', '접수번호', '회사명', '담당자', '서비스', '언어', '접수경로', '담당PM', '처리상태', '견적상태', '견적번호', '견적발송일시', '종결'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {!data || rows.length === 0 ? (
              <tr><td colSpan={14} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: '32px 8px' }}>
                {loading ? '불러오는 중…' : '해당 기간의 의뢰건이 없습니다.'}
              </td></tr>
            ) : rows.map(r => {
              const pm = PROCESSING_META[r.processingStatus] ?? PROCESSING_META.new;
              const qm = QUOTE_PROGRESS_META[r.quoteProgress] ?? QUOTE_PROGRESS_META.none;
              return (
                <tr key={r.id} onClick={() => onOpenDetail(r.id)}
                  data-testid={`inquiry-row-${r.id}`}
                  style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: r.isCarryover ? '#fff7ed' : undefined }}>
                  <td style={td} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                      aria-label={`${r.inquiryNumber ?? r.id} 선택`} data-testid={`inquiry-select-${r.id}`}
                      style={{ width: 15, height: 15, cursor: 'pointer' }} />
                  </td>
                  <td style={td}>
                    {r.isCarryover && <span style={{ ...badge({ label: '이월', color: '#c2410c', bg: '#ffedd5', border: '#fed7aa' }), marginRight: 6 }}>이월</span>}
                    {fmtDateTime(r.receivedAt)}
                    {/* 고객 접수일시(별도 데이터) — 확정이면 값, 확인 필요면 표시. 기존 자료(미분류)는 표시하지 않음 */}
                    {r.customerReceivedStatus === 'confirmed' && r.customerReceivedDate && (
                      <div style={{ fontSize: 11, color: '#6b7280' }}>고객 {formatDisplayDate(r.customerReceivedDate) || r.customerReceivedDate}{r.customerReceivedTime ? ` ${r.customerReceivedTime.slice(0, 5)}` : ''}</div>
                    )}
                    {r.customerReceivedStatus === 'needs_review' && <div style={{ fontSize: 11, color: '#b45309' }}>고객 접수 확인 필요</div>}
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', color: '#475569' }}>{r.inquiryNumber ?? `#${r.id}`}</td>
                  <td style={{ ...td, color: '#111827', fontWeight: 600, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.companyDisplay ?? '—'}</td>
                  <td style={td}>{r.contactDisplay ?? '—'}</td>
                  <td style={td}>{inquiryServiceLabel(r) || '—'}</td>
                  <td style={td}>{lang(r)}</td>
                  <td style={td}>{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td style={td}>{r.pmName ?? '—'}</td>
                  <td style={td}><span style={badge(pm)}>{pm.label}</span></td>
                  <td style={td}>
                    <span style={badge(qm)}>{qm.label}</span>
                    {r.saleConverted && <span style={{ ...badge({ label: '판매전환', color: '#065f46', bg: '#d1fae5', border: '#6ee7b7' }), marginLeft: 4 }}>판매전환</span>}
                  </td>
                  <td style={td} onClick={e => { if (r.quoteId && onOpenQuote) { e.stopPropagation(); onOpenQuote(r.quoteId); } }}>
                    {r.quoteNumber
                      ? <span style={{ fontFamily: 'monospace', color: '#2563eb', fontWeight: 700, textDecoration: onOpenQuote ? 'underline' : 'none' }}>{r.quoteNumber}</span>
                      : '—'}
                  </td>
                  <td style={td}>{r.quoteProgress === 'sent' ? (r.quoteIssueDate ? formatDisplayDate(r.quoteIssueDate) : '—') : '—'}</td>
                  <td style={td}>{r.processingStatus === 'closed_no_quote' ? <span style={badge(PROCESSING_META.closed_no_quote)}>종결</span> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {allRows.length > 0 && (
        <Pagination idPrefix="inquiry" page={curPage} pageSize={pageSize} total={allRows.length} unit="건" disabled={loading}
          onPageChange={goPage} onPageSizeChange={changeSize} />
      )}
      <p style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>
        ※ 처리상태·견적상태는 연결된 견적서 상태에서 자동 판단됩니다(중복 저장 없음). 주황색 배경 「이월」 행은 이전 날짜 접수 후 아직 처리(견적/종결)되지 않은 건입니다.
        견적발송일시는 연결 견적의 발행일 기준입니다.
      </p>
    </div>
  );
}

export default InquiryListTab;
