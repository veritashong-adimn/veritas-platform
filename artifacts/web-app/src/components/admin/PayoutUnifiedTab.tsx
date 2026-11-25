// 지급회차관리 — 지급회차 목록(최초 화면) → 지급일 클릭 → 지급회차 상세(PayoutRoundDetail, 탭 4개).
//   · 목록 = 과거 CRM(legacy) + 신규 플랫폼(current) 통합 조회(지급일별, READ-ONLY). 원본값 기준.
//   · 운영 지급회차(payout_rounds)는 같은 지급일 행에 표시. 통합 조회에 없는 지급일의 운영 회차도 같은 목록에 끼워 넣어 접근(별도 목록 없음).
//   · 상세는 같은 컴포넌트 안에서 전환 — 목록의 검색조건·페이지·표시 건수는 그대로 유지된다.
//   · 과거 CRM 지급완료 판정 = 납품일 ≤ 2026-09-15(대표 확인) 또는 지급회차 지급일 경과(별도 지급파일 처리분). 입금일/입금내역은 고객 수금 기록(지급 증빙 아님).
//   · 날짜 기준 기본값 = 납품일(§5). 조회 기준과 지급회차 귀속(지급일)은 분리.
import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Pagination } from '../ui/Paginator';
import { DateField } from './DatePickerShared';
import './readTableView.css';
import { ConversionRequestsPanel } from './LegacyPayoutConversion';
import { PayoutRoundDetail, type RoundRow, type OpRound, OP_STATUS, opDate, opStatusGroups, num, won, td, tdR, sc } from './PayoutRoundDetail';
import type { PayoutPerms } from './PayoutRoundsTab';

type DateBasis = 'delivery' | 'payout';
const SOURCE_OPTS: [string, string][] = [['all', '전체'], ['legacy', '과거 CRM'], ['current', '신규 플랫폼']];

export function PayoutUnifiedTab({ token, onToast, canOps = false, payoutPerms }: { token: string; onToast: (m: string) => void; canOps?: boolean; payoutPerms?: PayoutPerms }) {
  const authH = { Authorization: `Bearer ${token}` };
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [pg, setPg] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 }); // 기본 10행(옵션 5/10/20/50/100)
  const [basis, setBasis] = useState<DateBasis>('delivery'); // 기본값 = 납품일(§5)
  const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const [translator, setTranslator] = useState(''); const [client, setClient] = useState('');
  const [source, setSource] = useState('all');
  const [applied, setApplied] = useState({ basis: 'delivery' as DateBasis, from: '', to: '', source: 'all', translator: '', client: '' });
  const [loading, setLoading] = useState(false);
  const [convKey, setConvKey] = useState(0);   // 과거 CRM 지급 전환 요청·승인 후 요청 패널 재조회
  // 상세 — 선택 지급일(undefined = 목록 화면, null = 지급일 미확인)
  const [detailDate, setDetailDate] = useState<string | null | undefined>(undefined);
  const [detailTab, setDetailTab] = useState<'readiness' | 'operational' | undefined>(undefined);
  const [listScroll, setListScroll] = useState(0);
  // 운영 지급회차(payout_rounds) — 지급일별 표시·상세 연결. 조회 권한이 없으면 빈 목록(통합 조회만).
  const [opRounds, setOpRounds] = useState<OpRound[]>([]);
  const loadOpRounds = useCallback(async () => {
    try { const r = await fetch(api('/api/admin/payout-rounds'), { headers: authH }); const d = await r.json(); if (r.ok) setOpRounds(d.rows ?? []); } catch { /* 권한·오류 시 통합 조회만 */ }
  }, [token]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadOpRounds(); }, [loadOpRounds]);

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
      setRounds(d.rounds); setPg(d.pagination);
      setApplied({ basis, from: dateFrom, to: dateTo, source, translator, client });
    } catch (e: any) { onToast(e?.message || '통합 회차 조회 실패'); } finally { setLoading(false); }
  }, [token, pg.pageSize, basis, dateFrom, dateTo, translator, client, source]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadRounds(1); /* 최초 1회 — 납품일 기준 */ }, []); // eslint-disable-line

  const reset = () => { setBasis('delivery'); setDateFrom(''); setDateTo(''); setTranslator(''); setClient(''); setSource('all'); setTimeout(() => loadRounds(1), 0); };

  // 지급일별 운영 회차
  const opByDate = new Map<string, OpRound[]>();
  for (const r of opRounds) { const k = opDate(r); opByDate.set(k, [...(opByDate.get(k) ?? []), r]); }

  // 통합 조회에 없는 지급일의 운영 회차 — 같은 목록(지급일 내림차순)의 해당 위치에 끼워 넣는다(별도 목록 없음).
  //  · 목록은 지급일 내림차순 페이지 → 이 페이지의 날짜 범위(첫 행~마지막 행, 첫 페이지는 위쪽·마지막 페이지는 아래쪽 열림) 안에 있는데
  //    목록에 없는 날짜 = 통합 조회에 없는 날짜이므로 이 페이지에 표시. 거래처·통번역사 검색 또는 과거 CRM 출처 조회 중에는 끼워 넣지 않는다.
  //  · 지급일 기준 기간 조회면 기간 안만, 납품일 기준 기간 조회면 지급일과 기준이 달라 끼워 넣지 않는다.
  const rowsWithOp: RoundRow[] = (() => {
    if (applied.translator.trim() || applied.client.trim() || applied.source === 'legacy') return rounds;
    if (applied.basis === 'delivery' && (applied.from || applied.to)) return rounds;
    const dated = rounds.filter(r => r.payoutDate);
    const present = new Set(dated.map(r => r.payoutDate as string));
    const hi = pg.page <= 1 ? '9999-12-31' : (dated[0]?.payoutDate ?? '');
    const lo = pg.page >= pg.totalPages ? '0000-01-01' : (dated[dated.length - 1]?.payoutDate ?? '9999-12-31');
    const extra = [...opByDate.keys()].filter(d => !present.has(d) && d <= hi && d >= lo
      && (applied.basis !== 'payout' || ((!applied.from || d >= applied.from) && (!applied.to || d <= applied.to))))
      .map(d => ({ payoutDate: d, label: `${d} 지급`, assignmentCount: 0, legacyCount: 0, currentCount: 0, pretaxTotal: 0, posttaxTotal: 0, withholdingImplied: 0, withholdingRecalc: 0, paidTotal: 0, unpaidTotal: 0, needReviewCount: 0, excludedCount: 0, opOnly: true } as RoundRow));
    if (!extra.length) return rounds;
    const nulls = rounds.filter(r => !r.payoutDate);
    return [...dated, ...extra].sort((a, b) => String(b.payoutDate).localeCompare(String(a.payoutDate))).concat(nulls);
  })();

  const openDetail = (r: RoundRow) => {
    setListScroll(window.scrollY);
    setDetailTab(r.opOnly ? 'operational' : undefined);
    setDetailDate(r.payoutDate);
    window.scrollTo({ top: 0 });
  };
  const closeDetail = () => {
    setDetailDate(undefined);
    void loadOpRounds();
    setTimeout(() => window.scrollTo({ top: listScroll }), 0);
  };

  if (detailDate !== undefined) {
    return (
      <PayoutRoundDetail token={token} onToast={onToast} payoutDate={detailDate}
        opRounds={detailDate ? (opByDate.get(detailDate) ?? []) : []} reloadOpRounds={loadOpRounds}
        canOps={canOps} payoutPerms={payoutPerms} initialTab={detailTab === 'operational' && canOps ? 'operational' : undefined}
        onBack={closeDetail} />
    );
  }

  const inp: React.CSSProperties = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  const btn = (primary?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer', background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });
  const cntSub = (color: string, n: number): React.CSSProperties => ({ fontSize: 11, fontWeight: 600, marginTop: 1, color: n > 0 ? color : '#cbd5e1' });
  const roundsBox: React.CSSProperties = { overflowX: 'auto', overflowY: 'visible', border: '1px solid #e5e7eb', borderRadius: 10 };
  const dash = <span style={{ color: '#d1d5db' }}>-</span>;

  return (
    <div data-testid="payout-unified-tab">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 8px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 19, fontWeight: 800, color: '#111827', margin: 0 }}>지급회차관리</h1>
        <span style={{ fontSize: 11.5, color: '#9ca3af' }}
          title="과거 CRM 지급완료 = 지급일 경과(다음 날부터 · 별도 지급파일 처리분, VERITAS 송금 아님) 또는 납품일 ≤ 2026-09-15(대표 확인) · 입금내역(고객 수금)은 지급 근거 아님">
          과거 CRM + 신규 플랫폼 통합 조회 · 지급일을 클릭하면 지급준비점검·지급대상별 요약·건별 상세내역{canOps ? '·지급확정·은행이체' : ''}
        </span>
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
        <select style={inp} value={source} onChange={e => setSource(e.target.value)} aria-label="데이터 출처" data-testid="pu-source">{SOURCE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button style={btn(true)} onClick={() => loadRounds(1)} disabled={loading} data-testid="pu-search" aria-label="조회">{loading ? '조회 중…' : '조회'}</button>
        <button style={btn()} onClick={reset} data-testid="pu-reset" aria-label="검색조건 초기화">초기화</button>
      </div>

      {applied.basis === 'delivery' && (applied.from || applied.to) && (
        <div data-testid="pu-delivery-notice" style={{ marginBottom: 10, padding: '7px 11px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 11.5, color: '#92400e' }}>
          <b>납품일 기준</b> (납품일 {applied.from || '…'} ~ {applied.to || '…'}) — 아래 회차는 실제 지급일별로 묶입니다. 상세화면은 선택한 지급일 전체를 표시합니다.
        </div>
      )}

      {/* 과거 CRM 지급 전환 승인 요청(있을 때만) — 관리자 승인·반려 */}
      <ConversionRequestsPanel token={token} onToast={onToast} reloadKey={convKey} onChanged={() => setConvKey(k => k + 1)} />

      <div style={roundsBox}>
        <table className="veritas-read-table vz-sticky pz-zebra" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['지급일(회차)', '수행건수', '출처(과거/신규)', '세전금액', '원천세공제', '지급완료', '미지급', '지급예정', '지급확인', '운영 회차'].map(h => <th key={h} style={{ padding: '8px 12px', textAlign: h.includes('금액') || h.includes('완료') || h.includes('미지급') || h.includes('공제') || h === '지급예정' || h === '지급확인' ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rowsWithOp.map((r, i) => {
              const ops = r.payoutDate ? (opByDate.get(r.payoutDate) ?? []) : [];
              const k = r.payoutDate ?? 'none';
              return (
                <tr key={k + i} data-testid={`pu-round-${k}`} onClick={() => openDetail(r)} style={{ cursor: 'pointer' }}
                  tabIndex={0} role="button" aria-label={`${r.label} 상세 보기`} onKeyDown={e => { if (e.key === 'Enter') openDetail(r); }}>
                  <td style={{ ...td, fontWeight: 600, color: '#0369a1' }}>{r.payoutDate ?? <span style={{ color: '#b45309', fontWeight: 700 }}>(지급일 미확인)</span>}</td>
                  {r.opOnly ? <>
                    <td colSpan={8} style={{ ...td, color: '#6b7280', fontSize: 12 }} data-testid={`pu-round-oponly-${k}`}>통합 조회 대상 건 없음 — 운영 지급회차만 있는 지급일</td>
                  </> : <>
                    <td style={tdR}>{r.assignmentCount.toLocaleString()}건</td>
                    <td style={td}><span style={{ color: '#6d28d9', fontWeight: 600 }}>{r.legacyCount}</span> / <span style={{ color: '#047857', fontWeight: 600 }}>{r.currentCount}</span></td>
                    <td style={tdR}>{won(r.pretaxTotal)}</td>
                    <td style={{ ...tdR, color: '#6b7280' }}>{won(r.withholdingImplied)}
                      {num(r.vatTotal) > 0 && <div style={{ fontSize: 10.5, color: '#7c3aed', fontWeight: 600 }} data-testid={`pu-round-vat-${k}`}>외주 부가세 {won(num(r.vatTotal))}</div>}</td>
                    <td style={{ ...tdR, color: '#1d4ed8' }}>{won(r.paidTotal)}<div style={cntSub('#1d4ed8', sc(r).paid)} data-testid={`pu-round-paidcnt-${k}`}>{sc(r).paid.toLocaleString()}건</div></td>
                    <td style={{ ...tdR, color: r.unpaidTotal > 0 ? '#b45309' : '#9ca3af' }}>{won(r.unpaidTotal)}<div style={cntSub('#c2410c', sc(r).unpaid)} data-testid={`pu-round-unpaidcnt-${k}`}>{sc(r).unpaid.toLocaleString()}건</div></td>
                    <td style={{ ...tdR, color: sc(r).scheduled > 0 ? '#047857' : '#9ca3af' }} data-testid={`pu-round-scheduled-${k}`}>{sc(r).scheduled.toLocaleString()}건</td>
                    <td style={{ ...tdR, color: sc(r).review > 0 ? '#92400e' : '#9ca3af' }} data-testid={`pu-round-review-${k}`}>{sc(r).review.toLocaleString()}건</td>
                  </>}
                  <td style={td} data-testid={`pu-round-op-${k}`}>{ops.length ? (
                    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {opStatusGroups(ops).map(([st, n]) => { const m = OP_STATUS[st] ?? OP_STATUS.draft; return <span key={st} style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 8, background: m.bg, color: m.color }}>{m.label}{n > 1 ? ` ${n}` : ''}</span>; })}
                    </span>) : dash}</td>
                </tr>
              );
            })}
            {rowsWithOp.length === 0 && !loading && <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: '#9ca3af' }}>조회된 회차가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      {pg.total > 0 && <Pagination idPrefix="pu-rounds" page={pg.page} pageSize={pg.pageSize} total={pg.total} unit="회차" disabled={loading} pageSizeOptions={[5, 10, 20, 50, 100]} onPageChange={(p) => loadRounds(p)} onPageSizeChange={(s) => { setPg(v => ({ ...v, pageSize: s, page: 1 })); loadRounds(1, s); }} />}
    </div>
  );
}
