/**
 * InquiryListTab — 의뢰건 목록 (일일 업무관리 화면)
 *
 * 기준일 선택 → 해당 일자 접수/처리현황 자동 집계 + 이월 미처리(이전 날짜 미처리) 강조 표시.
 * 처리상태·견적진행상태는 서버가 quote.status 기준으로 파생한 값을 그대로 표시(중복 저장 없음).
 * 행 클릭 → 상세, 체크박스 → 선택(동작 분리). 기존 ERP 목록 디자인 패턴을 따른다.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/constants';
import { CHANNEL_LABEL, SERVICE_LABEL, PROCESSING_META, QUOTE_PROGRESS_META, kstTodayStr } from '../../lib/inquiryMeta';

interface InquiryRow {
  id: number;
  inquiryNumber: string | null;
  receivedAt: string;
  channel: string;
  status: string;
  companyDisplay: string | null;
  contactDisplay: string | null;
  serviceType: string | null;
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

const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' };
const badge = (m: { label: string; color: string; bg: string; border: string }): React.CSSProperties => ({
  display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: m.bg, color: m.color, border: `1px solid ${m.border}`, whiteSpace: 'nowrap',
});
const fmtDateTime = (s: string | null) => s ? new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const lang = (r: InquiryRow) => [r.languageFrom, r.languageTo].filter(Boolean).join('→') || '—';

function StatCard({ label, value, accent, highlight }: { label: string; value: number; accent?: string; highlight?: boolean }) {
  return (
    <div style={{ flex: '1 1 120px', minWidth: 110, background: highlight ? '#fef2f2' : '#fff', border: `1px solid ${highlight ? '#fecaca' : '#e5e7eb'}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, color: highlight ? '#b91c1c' : '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent ?? (highlight ? '#dc2626' : '#111827'), marginTop: 2 }}>{value}</div>
    </div>
  );
}

export function InquiryListTab({ token, onOpenDetail, onOpenQuote, onRegister, refreshTick }: {
  token: string;
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(api(`/api/admin/inquiries?date=${date}`), { headers: authH });
      const d = await res.json().catch(() => null);
      if (!res.ok) { setData(null); return; }
      setData(d);
      setSelected(new Set());
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [date, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load, refreshTick]);

  const toggle = (id: number) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const s = data?.summary;

  return (
    <div data-testid="inquiry-list-tab">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 }}>의뢰건 목록</h1>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>당일 접수는 당일 처리를 원칙으로 합니다. 이월 미처리를 우선 확인하세요.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={() => setDate(kstTodayStr())} data-testid="btn-inquiry-today"
            style={{ padding: '8px 12px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: '1px solid #d1d5db', background: '#f9fafb', color: '#374151', cursor: 'pointer' }}>오늘</button>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="input-inquiry-date"
            style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 8, outline: 'none' }} />
          {onRegister && (
            <button type="button" onClick={onRegister} data-testid="btn-inquiry-register-nav"
              style={{ padding: '8px 14px', fontSize: 13, fontWeight: 700, borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}>+ 의뢰건 등록</button>
          )}
        </div>
      </div>

      {/* 일일 현황 */}
      <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700, color: '#374151' }}>{date} 의뢰 현황</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <StatCard label="총 접수" value={s?.total ?? 0} />
        <StatCard label="신규/미처리" value={s?.new ?? 0} accent="#b45309" />
        <StatCard label="확인중" value={s?.reviewing ?? 0} accent="#2563eb" />
        <StatCard label="견적작성중" value={s?.quoting ?? 0} accent="#7c3aed" />
        <StatCard label="견적발송" value={s?.quoteSent ?? 0} accent="#059669" />
        <StatCard label="견적없이 종결" value={s?.closedNoQuote ?? 0} accent="#6b7280" />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatCard label="오늘 미처리" value={s?.unresolvedToday ?? 0} highlight={(s?.unresolvedToday ?? 0) > 0} />
        <StatCard label="이월 미처리" value={data?.carryoverCount ?? 0} highlight={(data?.carryoverCount ?? 0) > 0} />
        {selected.size > 0 && <div style={{ alignSelf: 'center', fontSize: 12, color: '#2563eb', fontWeight: 700 }}>선택 {selected.size}건</div>}
      </div>

      {/* 목록 */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ ...th, width: 40 }}></th>
              {['접수일시', '접수번호', '회사명', '담당자', '서비스', '언어', '접수경로', '담당PM', '처리상태', '견적상태', '견적번호', '견적발송일시', '종결'].map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {!data || data.rows.length === 0 ? (
              <tr><td colSpan={14} style={{ ...td, textAlign: 'center', color: '#9ca3af', padding: '32px 8px' }}>
                {loading ? '불러오는 중…' : '해당 일자의 의뢰건이 없습니다.'}
              </td></tr>
            ) : data.rows.map(r => {
              const pm = PROCESSING_META[r.processingStatus] ?? PROCESSING_META.new;
              const qm = QUOTE_PROGRESS_META[r.quoteProgress] ?? QUOTE_PROGRESS_META.none;
              return (
                <tr key={r.id} onClick={() => onOpenDetail(r.id)}
                  data-testid={`inquiry-row-${r.id}`}
                  style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: r.isCarryover ? '#fff7ed' : undefined }}
                  onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = r.isCarryover ? '#ffedd5' : '#f9fafb'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = r.isCarryover ? '#fff7ed' : ''; }}>
                  <td style={td} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                      aria-label={`${r.inquiryNumber ?? r.id} 선택`} data-testid={`inquiry-select-${r.id}`}
                      style={{ width: 15, height: 15, cursor: 'pointer' }} />
                  </td>
                  <td style={td}>
                    {r.isCarryover && <span style={{ ...badge({ label: '이월', color: '#c2410c', bg: '#ffedd5', border: '#fed7aa' }), marginRight: 6 }}>이월</span>}
                    {fmtDateTime(r.receivedAt)}
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', color: '#475569' }}>{r.inquiryNumber ?? `#${r.id}`}</td>
                  <td style={{ ...td, color: '#111827', fontWeight: 600, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.companyDisplay ?? '—'}</td>
                  <td style={td}>{r.contactDisplay ?? '—'}</td>
                  <td style={td}>{r.serviceType ? (SERVICE_LABEL[r.serviceType] ?? r.serviceType) : '—'}</td>
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
                  <td style={td}>{r.quoteProgress === 'sent' ? (r.quoteIssueDate ?? '—') : '—'}</td>
                  <td style={td}>{r.processingStatus === 'closed_no_quote' ? <span style={badge(PROCESSING_META.closed_no_quote)}>종결</span> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>
        ※ 처리상태·견적상태는 연결된 견적서 상태에서 자동 판단됩니다(중복 저장 없음). 주황색 배경 「이월」 행은 이전 날짜 접수 후 아직 처리(견적/종결)되지 않은 건입니다.
        견적발송일시는 연결 견적의 발행일 기준입니다.
      </p>
    </div>
  );
}

export default InquiryListTab;
