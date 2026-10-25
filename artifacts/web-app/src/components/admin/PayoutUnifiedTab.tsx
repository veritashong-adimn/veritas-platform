// 통합 지급회차관리 (Phase 1 · READ-ONLY) — 과거 CRM(legacy) + 신규 플랫폼(current)을 지급일별로 통합 조회·집계.
//   · 운영 지급확정/은행이체 로직은 변경하지 않음(§12). 저장·송금·상태변경 없음. 원본값 기준.
//   · 과거 CRM 지급완료 판정 = 납품일 ≤ 2026-09-15(대표 확인·2026-10-07 CRM 기준) 또는 입금증빙. 조회/표시 전용(원본 불변).
//   · 날짜 기준 기본값 = 납품일(§5). 조회 기준과 지급회차 귀속(지급일)은 분리.
//   · 중복 의심(§9)은 표시만 — 자동 삭제/제외/지급 없음.
import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Pagination } from '../ui/Paginator';
import { exportReproStatementExcel, exportReproStatementPdf } from '../../lib/payoutReproStatement';
import { DateField } from './DatePickerShared';
import './readTableView.css';

type DateBasis = 'delivery' | 'payout';
type RoundRow = {
  payoutDate: string | null; label: string;
  assignmentCount: number; legacyCount: number; currentCount: number;
  pretaxTotal: number; posttaxTotal: number; withholdingImplied: number; withholdingRecalc: number;
  paidTotal: number; unpaidTotal: number; needReviewCount: number; excludedCount: number;
};
type DetailRow = {
  source: 'legacy' | 'current'; sourceKey: string; id: number;
  deliveryDate: string | null; payoutDate: string | null; client: string | null;
  translator: string | null; residentMasked: string | null; language: string | null;
  masterEmail: string | null; masterPhone: string | null; originalPhone: string | null;
  matchStatus: string; matchedUserId: number | null; masterKey: string; confirmed: boolean;
  content: string | null; filename: string | null; pretax: number; posttax: number; withholdingImplied: number;
  status: 'paid' | 'pending' | 'deposit_unconfirmed' | 'excluded' | 'dup_suspect'; statusLabel: string; dupSuspect: boolean;
  paidBasis: string | null;
};
type PayeeGroup = {
  masterKey: string; name: string; confirmed: boolean; matchStatus: string; matchedUserId: number | null;
  email: string | null; phone: string | null; count: number; languages: string[];
  pretaxTotal: number; posttaxTotal: number; withholdingImplied: number;
  paidPretax: number; unpaidPretax: number; paidCount: number; unpaidCount: number; needReviewCount: number; dupSuspectCount: number; sources: string[];
};

// 지급상태 — 실제 '지급' 여부만(검증상태와 분리). '지급확인 필요'는 지급일은 있으나 원본에 입금일/입금내역이 없어 지급완료를 확인할 수 없는 건(입금증빙=검증상태와 별개).
const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  paid: { label: '지급완료', bg: '#eff6ff', fg: '#1d4ed8' },
  pending: { label: '지급대기', bg: '#fffbeb', fg: '#b45309' },
  deposit_unconfirmed: { label: '지급확인 필요', bg: '#fef3c7', fg: '#92400e' },
  dup_suspect: { label: '중복 의심', bg: '#fef2f2', fg: '#dc2626' },
  excluded: { label: '지급 제외', bg: '#f1f5f9', fg: '#475569' },
};
// 출처(legacy/current)는 화면 열에서 제거(§4) — 데이터·식별정보는 백엔드에 그대로 보존. 회차 목록의 건수(과거/신규)로만 표시.
const STATUS_OPTS: [string, string][] = [['all', '전체'], ['paid', '지급완료'], ['pending', '지급대기'], ['deposit_unconfirmed', '지급확인 필요'], ['dup_suspect', '중복 의심'], ['excluded', '지급 제외']];
const SOURCE_OPTS: [string, string][] = [['all', '전체'], ['legacy', '과거 CRM'], ['current', '신규 플랫폼']];

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const won = (n: number | null | undefined) => (n == null ? '-' : Math.round(Number(n)).toLocaleString());
const td: React.CSSProperties = { padding: '8px 12px', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
// 통번역사·언어·이메일·연락처·건수·세전·원천세공제·실지급·지급상태·출력(§2 순서)
const STMT_COLS = 'minmax(96px,1fr) minmax(64px,0.7fr) minmax(140px,1.3fr) 118px 48px 104px 104px 104px minmax(104px,auto) 128px';

function pickPhone(rows: DetailRow[]): string | null {
  const conf = new Set(rows.filter(r => r.matchStatus === 'confirmed' && r.masterPhone).map(r => r.masterPhone as string));
  if (conf.size === 1) return [...conf][0]; if (conf.size > 1) return null;
  const orig = new Set(rows.filter(r => r.originalPhone).map(r => r.originalPhone as string));
  return orig.size === 1 ? [...orig][0] : null;
}

export function PayoutUnifiedTab({ token, onToast }: { token: string; onToast: (m: string) => void }) {
  const authH = { Authorization: `Bearer ${token}` };
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [pg, setPg] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 1 }); // 기본 20행(옵션 20/30/50)
  const [basis, setBasis] = useState<DateBasis>('delivery'); // 기본값 = 납품일(§5)
  const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const [translator, setTranslator] = useState(''); const [client, setClient] = useState('');
  const [status, setStatus] = useState('all'); const [source, setSource] = useState('all');
  const [applied, setApplied] = useState({ basis: 'delivery' as DateBasis, from: '', to: '', status: 'all', source: 'all', translator: '', client: '' });
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<RoundRow | null>(null);
  const [detail, setDetail] = useState<DetailRow[]>([]); const [payees, setPayees] = useState<PayeeGroup[]>([]); const [totals, setTotals] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 선택한 통번역사(masterKey) 또는 '__all__'(전체 건별). null = 아직 미선택(상세 숨김). §6
  const [selPayee, setSelPayee] = useState<string | null>(null);

  const loadRounds = useCallback(async (page = 1, overridePageSize?: number) => {
    setLoading(true);
    try {
      // 표시 건수는 override 우선 — 선택 즉시 호출 시 옛 상태(클로저) 대신 새 값으로 서버 조회(선택값=pageSize 일치).
      const ps = overridePageSize ?? pg.pageSize;
      const p = new URLSearchParams(); p.set('page', String(page)); p.set('pageSize', String(ps)); p.set('basis', basis);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) p.set('dateFrom', dateFrom);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) p.set('dateTo', dateTo);
      if (translator.trim()) p.set('translator', translator.trim());
      if (client.trim()) p.set('client', client.trim());
      if (source !== 'all') p.set('source', source);
      const r = await fetch(api(`/api/admin/payout-unified/rounds?${p}`), { headers: authH });
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || '조회 실패');
      setRounds(d.rounds); setPg(d.pagination); setSel(null); setDetail([]); setPayees([]); setTotals(null); setSelPayee(null);
      setApplied({ basis, from: dateFrom, to: dateTo, status, source, translator, client });
    } catch (e: any) { onToast(e?.message || '통합 회차 조회 실패'); } finally { setLoading(false); }
  }, [token, pg.pageSize, basis, dateFrom, dateTo, translator, client, source, status]);

  const loadDetail = useCallback(async (round: RoundRow) => {
    setSel(round); setDetailLoading(true); setSelPayee(null); setDetail([]); setPayees([]); // 회차 변경 시 이전 선택·상세 초기화(§6-12)
    try {
      const p = new URLSearchParams(); p.set('date', round.payoutDate ?? 'none'); p.set('basis', applied.basis);
      if (applied.basis === 'delivery') { if (/^\d{4}-\d{2}-\d{2}$/.test(applied.from)) p.set('dateFrom', applied.from); if (/^\d{4}-\d{2}-\d{2}$/.test(applied.to)) p.set('dateTo', applied.to); }
      if (applied.translator.trim()) p.set('translator', applied.translator.trim());
      if (applied.client.trim()) p.set('client', applied.client.trim());
      if (applied.source !== 'all') p.set('source', applied.source);
      if (applied.status !== 'all') p.set('status', applied.status);
      const r = await fetch(api(`/api/admin/payout-unified/payees?${p}`), { headers: authH });
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || '조회 실패');
      setDetail(d.items); setPayees(d.payees); setTotals(d.totals);
    } catch (e: any) { onToast(e?.message || '상세 조회 실패'); } finally { setDetailLoading(false); }
  }, [token, applied]);

  useEffect(() => { loadRounds(1); /* 최초 1회 — 납품일 기준 */ }, []); // eslint-disable-line

  const reset = () => { setBasis('delivery'); setDateFrom(''); setDateTo(''); setTranslator(''); setClient(''); setStatus('all'); setSource('all'); setTimeout(() => loadRounds(1), 0); };

  const inp: React.CSSProperties = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  const btn = (primary?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer', background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });
  const sBtn: React.CSSProperties = { padding: '3px 9px', borderRadius: 6, fontSize: 12, fontWeight: 700, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', cursor: 'pointer' };
  // 지급명세서 출력 버튼 — 텍스트 버튼(§3), 같은 행 내 크기·높이 통일.
  const stmtBtn: React.CSSProperties = { minWidth: 58, padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', cursor: 'pointer', lineHeight: 1.2 };

  // §4 — '실지급액'(전체 세후)과 '지급완료'(지급완료 건 세전)는 기준이 달라 값이 다르다. 라벨에 기준 명시(계산 로직 불변).
  const summaryList: [string, string, string?][] = sel && totals ? [
    ['지급대상 인원', `${num(totals.payeeCount)}명`], ['수행건수', `${num(totals.assignmentCount)}건`],
    ['세전금액', `${won(totals.pretaxTotal)}원`, '전체 건 세전 합계'],
    ['원천세공제(3.3%)', `${won(totals.withholdingImpliedTotal)}원`, '원본 세전−세후(실제 공제) 합계 · 3.3%는 참고'],
    ['실지급액(세후)', `${won(totals.posttaxTotal)}원`, '전체 건 세후(실지급) 합계 = 세전 − 원천세공제'],
    ['지급완료(세전)', `${won(totals.paidTotal)}원`, '입금 증빙이 있는 지급완료 건의 세전 합계(전체 세후와 기준이 다름)'],
    ['미지급(세전)', `${won(totals.unpaidTotal)}원`, '신규 미지급 건의 세전 합계'],
    ['지급확인 필요', `${num(totals.needReviewCount)}건`, '지급일은 있으나 원본에 입금일/입금내역이 없어 지급완료를 확인할 수 없는 건(지급상태) · 입금증빙·Master연결·금액 검증과 무관. 대표 확인 대상.'],
  ] : [];

  // 선택한 통번역사의 상세만 표시(§6). null=미선택(숨김) · '__all__'=전체 건별.
  const detailRows = selPayee == null ? [] : (selPayee === '__all__' ? detail : detail.filter(r => r.masterKey === selPayee));
  const selPayeeName = selPayee && selPayee !== '__all__' ? (payees.find(g => g.masterKey === selPayee)?.name ?? '') : '전체';
  const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'normal', lineHeight: 1.35 } as React.CSSProperties;
  // 내부 세로 스크롤 제거 — 페이지당 건수만큼 자연 확장, 스크롤은 페이지 전체에서. 가로 부족 시에만 가로 스크롤. 헤더는 vz-sticky로 고정.
  const roundsBox: React.CSSProperties = { overflowX: 'auto', overflowY: 'visible', border: '1px solid #e5e7eb', borderRadius: 10 };
  const secTitle: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: '#374151', margin: '0 0 6px' };

  const stmtFor = (g: PayeeGroup) => {
    const rows = detail.filter(r => r.masterKey === g.masterKey);
    const payDate = rows.find(r => r.payoutDate)?.payoutDate ?? (sel?.payoutDate ?? '-');
    return { payeeName: g.name, email: g.email, phone: g.phone ?? pickPhone(rows), scopeValue: `${sel?.payoutDate ?? '지급일 미확인'} 지급`, payDate,
      rows: rows.map(r => ({ client: r.client, filename: r.filename, deliveryDate: r.deliveryDate, payoutDate: r.payoutDate, content: r.content, pretax: r.pretax, posttax: r.posttax })) };
  };

  return (
    <div data-testid="payout-unified-tab">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 8px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 19, fontWeight: 800, color: '#111827', margin: 0 }}>지급회차관리</h1>
        <span style={{ fontSize: 11.5, color: '#9ca3af' }}>과거 CRM + 신규 플랫폼 통합 조회 · 조회/명세서 전용(지급확정·송금 없음) · 과거 CRM 지급완료 = 대표 확인(2026-10-07 CRM 기준, 납품일 ≤ 2026-09-15) 또는 입금증빙</span>
      </div>

      {/* 검색조건 — 한 줄(폭 부족 시 줄바꿈) */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 700 }}>날짜 기준</label>
        <select style={inp} value={basis} onChange={e => setBasis(e.target.value as DateBasis)} aria-label="날짜 기준" data-testid="pu-basis">
          <option value="delivery">납품일</option><option value="payout">지급일</option>
        </select>
        <DateField style={{ ...inp, width: 148 }} value={dateFrom} max={dateTo || undefined} onChange={setDateFrom} testid="pu-from" ariaLabel="시작일" />
        <span style={{ color: '#9ca3af' }}>~</span>
        <DateField style={{ ...inp, width: 148 }} value={dateTo} min={dateFrom || undefined} onChange={setDateTo} testid="pu-to" ariaLabel="종료일" />
        <input style={{ ...inp, minWidth: 130 }} placeholder="거래처" value={client} onChange={e => setClient(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') loadRounds(1); }} aria-label="거래처 검색" data-testid="pu-client" />
        <input style={{ ...inp, minWidth: 130 }} placeholder="통번역사" value={translator} onChange={e => setTranslator(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') loadRounds(1); }} aria-label="통번역사 검색" data-testid="pu-translator" />
        <select style={inp} value={status} onChange={e => setStatus(e.target.value)} aria-label="지급상태" data-testid="pu-status">{STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select style={inp} value={source} onChange={e => setSource(e.target.value)} aria-label="데이터 출처" data-testid="pu-source">{SOURCE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button style={btn(true)} onClick={() => loadRounds(1)} disabled={loading} data-testid="pu-search">{loading ? '조회 중…' : '조회'}</button>
        <button style={btn()} onClick={reset} data-testid="pu-reset">초기화</button>
      </div>

      {applied.basis === 'delivery' && (applied.from || applied.to) && (
        <div data-testid="pu-delivery-notice" style={{ marginBottom: 10, padding: '7px 11px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 11.5, color: '#92400e' }}>
          <b>납품일 기준</b> (납품일 {applied.from || '…'} ~ {applied.to || '…'}) — 아래 회차는 실제 지급일별로 묶입니다. 서로 다른 지급일 건을 하나의 회차로 합산·지급확정하지 않습니다(§5).
        </div>
      )}

      {/* ① 지급회차 목록 — 페이지당 건수만큼 자연 확장(내부 세로 스크롤 없음, 페이지 전체 스크롤) */}
      <div style={secTitle}>① 지급회차 목록 <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af' }}>· 행 클릭 → 통번역사별 지급내역</span></div>
      <div style={roundsBox}>
        <table className="veritas-read-table vz-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['지급일(회차)', '수행건수', '출처(과거/신규)', '세전금액', '원천세공제', '지급완료', '미지급', '지급확인'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: h.includes('금액') || h.includes('완료') || h.includes('미지급') || h.includes('공제') ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rounds.map((r, i) => (
              <tr key={(r.payoutDate ?? 'none') + i} data-testid={`pu-round-${r.payoutDate ?? 'none'}`} onClick={() => loadDetail(r)}
                style={{ cursor: 'pointer', background: sel && sel.payoutDate === r.payoutDate ? '#dbeafe' : undefined, outline: sel && sel.payoutDate === r.payoutDate ? '2px solid #93c5fd' : undefined, outlineOffset: -2 }}>
                <td style={{ ...td, fontWeight: sel && sel.payoutDate === r.payoutDate ? 800 : 400 }}>{r.payoutDate ?? <span style={{ color: '#b45309', fontWeight: 700 }}>(지급일 미확인)</span>}</td>
                <td style={tdR}>{r.assignmentCount.toLocaleString()}건</td>
                <td style={td}><span style={{ color: '#6d28d9', fontWeight: 600 }}>{r.legacyCount}</span> / <span style={{ color: '#047857', fontWeight: 600 }}>{r.currentCount}</span></td>
                <td style={tdR}>{won(r.pretaxTotal)}</td>
                <td style={{ ...tdR, color: '#6b7280' }}>{won(r.withholdingImplied)}</td>
                <td style={{ ...tdR, color: '#1d4ed8' }}>{won(r.paidTotal)}</td>
                <td style={{ ...tdR, color: r.unpaidTotal > 0 ? '#b45309' : '#9ca3af' }}>{won(r.unpaidTotal)}</td>
                <td style={{ ...tdR, color: r.needReviewCount > 0 ? '#92400e' : '#9ca3af' }}>{r.needReviewCount.toLocaleString()}건</td>
              </tr>
            ))}
            {rounds.length === 0 && !loading && <tr><td colSpan={8} style={{ padding: 28, textAlign: 'center', color: '#9ca3af' }}>조회된 회차가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      {pg.total > 0 && <Pagination idPrefix="pu-rounds" page={pg.page} pageSize={pg.pageSize} total={pg.total} unit="회차" disabled={loading} pageSizeOptions={[20, 30, 50]} onPageChange={(p) => loadRounds(p)} onPageSizeChange={(s) => { setPg(v => ({ ...v, pageSize: s, page: 1 })); loadRounds(1, s); }} />}

      {/* 선택 회차 영역 */}
      {sel && (
        <div style={{ marginTop: 16 }}>
          {/* 회차 요약 — 한 줄(§4) */}
          {summaryList.length > 0 && (
            <div data-testid="pu-summary" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 0', alignItems: 'center', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 12px', marginBottom: 14, background: '#fff' }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: '#111827', marginRight: 10 }}>{sel.label}</span>
              {summaryList.map(([k, v, tip], idx) => (
                <React.Fragment key={k}>
                  {idx > 0 && <span style={{ color: '#e5e7eb', margin: '0 10px' }}>|</span>}
                  <span style={{ fontSize: 11.5, color: '#9ca3af', marginRight: 5, cursor: tip ? 'help' : undefined }} title={tip}>{k}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: k.includes('원천세') ? '#dc2626' : k.includes('실지급') ? '#111827' : '#374151', fontVariantNumeric: 'tabular-nums' }} title={tip}>{v}</span>
                </React.Fragment>
              ))}
            </div>
          )}

          {/* ② 통번역사별 지급내역 — 메인(§5). 행 클릭 → 해당 통번역사 상세. */}
          {payees.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                <div style={secTitle}>② 통번역사별 지급내역 <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af' }}>· Master 연결 기준 · {payees.length}명 · 행 클릭 → 건별 상세</span></div>
                <button style={{ ...sBtn, background: selPayee === '__all__' ? '#0369a1' : '#fff', color: selPayee === '__all__' ? '#fff' : '#334155' }} data-testid="pu-show-all" onClick={() => setSelPayee('__all__')}>전체 건별 내역 ({detail.length}건)</button>
              </div>
              {/* 내부 세로 스크롤 제거(§1) — 행 수만큼 자연 확장, 가로 부족 시에만 가로 스크롤 */}
              <div data-testid="pu-payee-panel" style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', overflowX: 'auto', overflowY: 'visible' }}>
                <div style={{ minWidth: 1040 }}>
                <div style={{ display: 'grid', gridTemplateColumns: STMT_COLS, gap: '0 12px', alignItems: 'center', fontSize: 12, padding: '7px 12px', background: '#f3f4f6', color: '#6b7280', fontWeight: 700 }}>
                  <div>통번역사</div><div>언어</div><div>이메일</div><div>연락처</div><div style={{ textAlign: 'right' }}>건수</div><div style={{ textAlign: 'right' }}>세전금액</div><div style={{ textAlign: 'right' }}>원천세공제</div><div style={{ textAlign: 'right' }}>실지급액</div><div style={{ textAlign: 'right' }}>지급상태</div><div style={{ textAlign: 'right' }}>Excel · PDF</div>
                </div>
                <div className="pu-payee-list">
                  {payees.map((g) => {
                    const opts = stmtFor(g); const selected = selPayee === g.masterKey;
                    return (
                      <div className="pu-payee-row" key={g.masterKey} data-testid={`pu-payee-${g.name}`} onClick={() => setSelPayee(g.masterKey)}
                        style={{ display: 'grid', gridTemplateColumns: STMT_COLS, gap: '0 12px', alignItems: 'center', fontSize: 12.5, padding: '8px 12px', ...(selected ? { background: '#dbeafe' } : null) }}>
                        <div style={{ color: '#111827', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {g.name}
                          {/* 연결(검증상태) — 지급상태와 무관(§1·§3). Master 연결된 건(active/confirmed)은 배지 없음.
                              거래처/업체는 개인 Master 대상이 아니므로 '거래처'로만 표시. 이름만 존재·미연결 개인만 '연결 확인필요'. */}
                          {!g.confirmed && (g.matchStatus === 'vendor' || g.matchStatus === 'client')
                            ? <span style={{ marginLeft: 5, fontSize: 10, color: '#475569', background: '#f1f5f9', padding: '1px 5px', borderRadius: 7 }} title="거래처/외주업체 — 개인 통번역사 Master 연결 대상이 아님">거래처</span>
                            : !g.confirmed
                              ? <span style={{ marginLeft: 5, fontSize: 10, color: '#1d4ed8', background: '#eff6ff', padding: '1px 5px', borderRadius: 7 }} title="검증상태: Master 연결 미확정(지급상태와 무관). 이름만 일치는 자동 연결하지 않음.">연결 확인필요</span>
                              : null}
                        </div>
                        <div style={{ color: '#374151', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }} title={g.languages.join(', ')}>{g.languages.join(', ')}</div>
                        <div style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }} title={g.email ?? undefined}>{g.email || ''}</div>
                        <div style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11.5 }}>{g.phone || ''}</div>
                        <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{g.count}</div>
                        <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{won(g.pretaxTotal)}</div>
                        <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#dc2626' }}>{won(g.withholdingImplied)}</div>
                        <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 800, color: '#111827' }}>{won(g.posttaxTotal)}</div>
                        {/* 지급상태(§4②) — 건수 기준으로 지급완료/지급확인필요/미지급을 분리 표시. 연결 검증상태와 혼합하지 않음. */}
                        <div style={{ textAlign: 'right', display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          {g.paidCount > 0 && <span style={{ fontSize: 10, color: '#1d4ed8', background: '#eff6ff', padding: '1px 5px', borderRadius: 7 }}>지급완료 {g.paidCount}건</span>}
                          {g.needReviewCount > 0 && <span style={{ fontSize: 10, color: '#92400e', background: '#fef3c7', padding: '1px 5px', borderRadius: 7 }} title="지급일은 있으나 원본에 입금일/입금내역이 없어 지급완료를 확인할 수 없는 건(대표 확인 대상)">지급확인 필요 {g.needReviewCount}건</span>}
                          {g.unpaidCount > 0 && <span style={{ fontSize: 10, color: '#b45309', background: '#fffbeb', padding: '1px 5px', borderRadius: 7 }}>미지급 {g.unpaidCount}건</span>}
                          {g.dupSuspectCount > 0 && <span style={{ fontSize: 10, color: '#dc2626', background: '#fef2f2', padding: '1px 5px', borderRadius: 7 }}>중복 {g.dupSuspectCount}건</span>}
                          {g.paidCount === 0 && g.unpaidCount === 0 && g.needReviewCount === 0 && g.dupSuspectCount === 0 && <span style={{ fontSize: 10, color: '#9ca3af' }}>-</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button style={stmtBtn} data-testid={`pu-excel-${g.name}`} onClick={(e) => { e.stopPropagation(); exportReproStatementExcel(opts); onToast(`${g.name} 지급명세서 Excel을 다운로드했습니다.`); }}>Excel</button>
                          <button style={stmtBtn} data-testid={`pu-pdf-${g.name}`} onClick={(e) => { e.stopPropagation(); if (!exportReproStatementPdf(opts)) onToast('팝업 차단을 해제한 후 다시 시도해 주세요.'); }}>PDF</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                </div>
              </div>
            </div>
          )}

          {/* ③ 선택 통번역사 건별 상세(§6) — 미선택 시 안내, 선택 시 해당 내역만. 내부 세로 스크롤 제거(§1·C). */}
          {selPayee != null ? (
            <div>
              <div style={secTitle} data-testid="pu-detail-title">③ {selPayeeName} – 건별 상세내역 ({detailRows.length}건)</div>
              {/* 내부 세로 스크롤 제거 — 건수만큼 자연 확장, 가로 부족 시에만 가로 스크롤. 헤더는 페이지 스크롤에 sticky. */}
              <div style={{ overflowX: 'auto', overflowY: 'visible', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                <table className="veritas-read-table vz-sticky pr-detail-zebra" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr>{['거래처', '통번역사', '주민번호', '언어', '상품/업무', '상세내역', '납품일', '지급일', '세전지급액', '세후지급액', '원천세공제액', '지급상태'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: h.includes('액') ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {detailRows.map((p, i) => {
                      const sm = STATUS_META[p.status] ?? STATUS_META.deposit_unconfirmed;
                      return (
                        <tr key={p.sourceKey} data-testid={`pu-detail-${i}`} data-source={p.source} data-status={p.status}>
                          <td style={{ ...td, whiteSpace: 'normal', maxWidth: 180 }} data-testid={`pu-client-${i}`} title={p.client ?? undefined}><div style={clamp2}>{p.client ?? <span style={{ color: '#b45309', fontWeight: 700 }}>거래처 확인 필요</span>}</div></td>
                          <td style={{ ...td, whiteSpace: 'normal', lineHeight: 1.35 }}>
                            <div style={{ fontWeight: 600, color: '#111827' }}>{p.translator ?? '-'}</div>
                            {(p.masterEmail || p.masterPhone) && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }} title="현재 Master 등록 연락처">{p.masterEmail && <div>{p.masterEmail}</div>}{p.masterPhone && <div>{p.masterPhone}</div>}</div>}
                          </td>
                          <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: p.residentMasked ? '#6b7280' : '#d1d5db' }} title="주민번호 앞 6자리만 표시(마스킹)">{p.residentMasked ?? '-'}</td>
                          <td style={{ ...td, whiteSpace: 'normal', maxWidth: 140 }}>{p.language ?? '-'}</td>
                          <td style={{ ...td, maxWidth: 200 }} title={p.content ?? undefined}><div style={clamp2}>{p.content ?? '-'}</div></td>
                          <td style={{ ...td, maxWidth: 230 }} data-testid={`pu-detail-detail-${i}`} title={p.filename ?? undefined}><div style={clamp2}>{p.filename ?? '-'}</div></td>
                          <td style={td}>{p.deliveryDate ?? <span style={{ color: '#b45309' }}>(납품일 미상)</span>}</td>
                          <td style={td}>{p.payoutDate ?? <span style={{ color: '#b45309', fontWeight: 700 }}>(지급일 미확인)</span>}</td>
                          <td style={tdR}>{won(p.pretax)}</td>
                          <td style={tdR}>{won(p.posttax)}</td>
                          <td style={{ ...tdR, color: '#dc2626' }}>{won(p.withholdingImplied)}</td>
                          <td style={td}><span style={{ padding: '2px 8px', borderRadius: 10, background: sm.bg, color: sm.fg, fontSize: 12, fontWeight: 700, cursor: p.paidBasis ? 'help' : undefined }} title={p.paidBasis ? `지급완료 근거: ${p.paidBasis}` : undefined} data-testid={`pu-detail-status-${i}`}>{sm.label}</span></td>
                        </tr>
                      );
                    })}
                    {detailRows.length === 0 && !detailLoading && <tr><td colSpan={12} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>상세 내역이 없습니다.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div data-testid="pu-detail-hint" style={{ border: '1px dashed #d1d5db', borderRadius: 10, padding: '18px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              위 통번역사 행을 클릭하면 해당 통번역사의 건별 상세내역이 표시됩니다. (또는 <b>전체 건별 내역</b> 버튼)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
