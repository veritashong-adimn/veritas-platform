// 과거 지급회차 재현(1단계, READ-ONLY) — 과거 CRM 진행관리표를 지급일별·수취인별로 재현 조회.
//   · 운영 지급회차/지급명세서/송금과 완전 분리(저장·상태변경·IBK·자동수집 없음). 원본 불변.
//   · 세전/세후는 원본값. 원천세 재계산은 현재 기본세율(3.3%) 참고치(과거 실제 세율 단정 아님).
//   · 통번역사는 과거 CRM 이름 기준. 현재 Master는 '이름 유일 일치'일 때만 참고 연결(자동 병합 없음). 주민번호 미노출.
import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Pagination } from '../ui/Paginator';
import { exportDataset, todayStamp, type ExcelColumn } from '../../lib/excelExport';
import { DateField } from './DatePickerShared';
import './readTableView.css';

type DateBasis = 'payout' | 'delivery';
type RoundRow = {
  payoutDate: string | null; label: string; isUnconfirmed: boolean;
  payeeCount: number; assignmentCount: number; pretaxTotal: number; posttaxTotal: number;
  withholdingImplied: number; withholdingRecalc: number; withholdingDiff: number;
};
type MatchStatus = 'confirmed' | 'candidate' | 'vendor' | 'client' | 'unmatched';
type DetailRow = {
  id: number; deliveryDate: string | null; payoutDate: string | null;
  translator: string | null; residentMasked: string | null;
  language: string | null; languageSource: 'original' | 'master' | null;
  masterEmail: string | null; masterPhone: string | null;
  matchStatus: MatchStatus; matched: boolean; matchedUserId: number | null; matchedUserName: string | null; isPayroll: boolean;
  content: string | null; filename: string | null; pretax: number; posttax: number; withholdingImplied: number;
};

// 연결상태 배지 — 확정매핑만 '연결(확정)'. 이름일치는 '연결후보(확인필요)'로 구분(§5·§6).
const STATUS_META: Record<string, { label: string; bg: string; fg: string }> = {
  confirmed: { label: '연결(확정)', bg: '#ecfdf5', fg: '#047857' },
  candidate: { label: '연결후보(확인필요)', bg: '#eff6ff', fg: '#1d4ed8' },
  vendor: { label: '외주업체', bg: '#f5f3ff', fg: '#6d28d9' },
  client: { label: '거래처', bg: '#fdf2f8', fg: '#be185d' },
  unmatched: { label: '미연결', bg: '#fef3c7', fg: '#92400e' },
};

const won = (n: number | null | undefined) => (n == null ? '-' : Math.round(Number(n)).toLocaleString());
const scrollBox: React.CSSProperties = { overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 360px)', border: '1px solid #e5e7eb', borderRadius: 10 };
const td: React.CSSProperties = { padding: '9px 12px', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' };
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

export function PayoutReproductionTab({ token, onToast }: { token: string; onToast: (m: string) => void }) {
  const authH = { Authorization: `Bearer ${token}` };
  const [summary, setSummary] = useState<any>(null);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [pg, setPg] = useState({ page: 1, pageSize: 50, total: 0, totalPages: 1 });
  const [basis, setBasis] = useState<DateBasis>('payout');
  const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState(''); const [translator, setTranslator] = useState('');
  // 마지막으로 '조회'에 실제 적용된 조건 스냅샷 — 상세 재적용·안내문이 입력창 편집에 흔들리지 않도록.
  const [applied, setApplied] = useState<{ basis: DateBasis; from: string; to: string }>({ basis: 'payout', from: '', to: '' });
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<RoundRow | null>(null);
  const [detail, setDetail] = useState<DetailRow[]>([]); const [detailTotals, setDetailTotals] = useState<any>(null);
  const [payeeLoading, setPayeeLoading] = useState(false);

  const loadSummary = useCallback(async () => {
    try { const r = await fetch(api('/api/admin/payout-reproduction/summary'), { headers: authH }); const d = await r.json(); if (r.ok) setSummary(d); } catch { /* noop */ }
  }, [token]);

  const loadRounds = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const p = new URLSearchParams(); p.set('page', String(page)); p.set('pageSize', String(pg.pageSize));
      p.set('basis', basis);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) p.set('dateFrom', dateFrom);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) p.set('dateTo', dateTo);
      if (translator.trim()) p.set('translator', translator.trim());
      const r = await fetch(api(`/api/admin/payout-reproduction/rounds?${p}`), { headers: authH });
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || '조회 실패');
      setRounds(d.rounds); setPg(d.pagination); setSel(null); setDetail([]); setDetailTotals(null);
      setApplied({ basis, from: dateFrom, to: dateTo });
    } catch (e: any) { onToast(e?.message || '재현 회차 조회 실패'); } finally { setLoading(false); }
  }, [token, pg.pageSize, basis, dateFrom, dateTo, translator]);

  const loadDetail = useCallback(async (round: RoundRow) => {
    setSel(round); setPayeeLoading(true);
    try {
      const p = new URLSearchParams(); p.set('date', round.payoutDate ?? 'none'); p.set('basis', applied.basis);
      // 납품일 기준이면 상세에도 동일 납품일 범위를 재적용 → 회차 합계와 상세 합계 일치.
      if (applied.basis === 'delivery') {
        if (/^\d{4}-\d{2}-\d{2}$/.test(applied.from)) p.set('dateFrom', applied.from);
        if (/^\d{4}-\d{2}-\d{2}$/.test(applied.to)) p.set('dateTo', applied.to);
      }
      if (translator.trim()) p.set('translator', translator.trim());
      const r = await fetch(api(`/api/admin/payout-reproduction/payees?${p}`), { headers: authH });
      const d = await r.json(); if (!r.ok) throw new Error(d?.error || '조회 실패');
      setDetail(d.items); setDetailTotals(d.totals);
    } catch (e: any) { onToast(e?.message || '상세 조회 실패'); } finally { setPayeeLoading(false); }
  }, [token, translator, applied]);

  useEffect(() => { loadSummary(); loadRounds(1); /* 최초 1회 */ }, []); // eslint-disable-line

  const basisLabel = (b: DateBasis) => (b === 'delivery' ? '납품일' : '지급일');
  const rangeText = (b: DateBasis) => (b === 'delivery' && (applied.from || applied.to) ? `${applied.from || '…'} ~ ${applied.to || '…'}` : '-');

  const exportRounds = () => {
    if (rounds.length === 0) { onToast('내보낼 재현 회차가 없습니다.'); return; }
    const cols: ExcelColumn<RoundRow>[] = [
      { header: '날짜기준', value: () => basisLabel(applied.basis) },
      { header: '지급일', value: (r) => r.payoutDate ?? '(미확인)' },
      { header: '납품일조건', value: () => rangeText(applied.basis) },
      { header: '지급대상자수', value: 'payeeCount', type: 'number' },
      { header: '수행건수', value: 'assignmentCount', type: 'number' },
      { header: '세전합계', value: 'pretaxTotal', type: 'number' },
      { header: '세후합계', value: 'posttaxTotal', type: 'number' },
      { header: '원본차액(실제공제)', value: 'withholdingImplied', type: 'number' },
      { header: '현재세율재계산(3.3%참고)', value: 'withholdingRecalc', type: 'number' },
      { header: '차이', value: 'withholdingDiff', type: 'number' },
    ];
    exportDataset({ filename: `과거지급재현_회차_${basisLabel(applied.basis)}기준_${todayStamp()}.xlsx`, sheetName: '재현회차', columns: cols, rows: rounds });
  };
  const exportDetail = () => {
    if (detail.length === 0) { onToast('내보낼 상세 내역이 없습니다.'); return; }
    const cols: ExcelColumn<DetailRow>[] = [
      { header: '날짜기준', value: () => basisLabel(applied.basis) },
      { header: '납품일', value: (r) => r.deliveryDate ?? '', type: 'date' },
      { header: '지급일', value: (r) => r.payoutDate ?? '', type: 'date' },
      { header: '통번역사', value: (r) => r.translator ?? '' },
      { header: '주민번호(마스킹)', value: (r) => r.residentMasked ?? '' },
      { header: '언어', value: (r) => r.language ? (r.language + (r.languageSource === 'master' ? ' (Master참고)' : '')) : '' },
      { header: '연결상태', value: (r) => (STATUS_META[r.matchStatus] ?? STATUS_META.unmatched).label + (r.matchedUserId ? ` (${r.matchedUserName ?? ''}#${r.matchedUserId})` : '') + (r.isPayroll ? ' [직원성]' : '') },
      { header: '수행내용', value: (r) => r.content ?? '' },
      { header: '파일명', value: (r) => r.filename ?? '' },
      { header: '세전지급액', value: 'pretax', type: 'number' },
      { header: '세후지급액', value: 'posttax', type: 'number' },
      { header: '원본공제액', value: 'withholdingImplied', type: 'number' },
    ];
    exportDataset({ filename: `과거지급재현_상세_${sel?.payoutDate ?? 'none'}_${basisLabel(applied.basis)}기준_${todayStamp()}.xlsx`, sheetName: '상세내역', columns: cols, rows: detail });
  };

  const inp: React.CSSProperties = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  const btn = (primary?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer', background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });

  return (
    <div data-testid="payout-reproduction-tab">
      <div style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 }}>과거 지급 재현 (검증 · 읽기 전용)</h1>
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 0' }}>
          과거 CRM 진행관리표를 지급일·수취인별로 재현 조회합니다. 운영 지급회차와 무관하며 저장·송금·상태변경을 하지 않습니다.
          원천세 재계산은 현재 기본세율(3.3%) <b>참고치</b>이며 과거 실제 적용 세율로 단정하지 않습니다.
        </p>
      </div>

      {summary && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {[['원본 행수', summary.totalRows.toLocaleString()], ['재현 회차(지급일)', summary.roundCount.toLocaleString()], ['지급대상자', `${summary.payeeCount.toLocaleString()}명`],
            ['지급일 미확인', `${summary.noDateRows.toLocaleString()}행`], ['세전합계', won(summary.pretaxTotal)], ['세후합계', won(summary.posttaxTotal)], ['원본차액(공제)', won(summary.withholdingImplied)]]
            .map(([k, v]) => (
              <div key={k} style={{ flex: '1 1 130px', minWidth: 120, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600 }}>{k}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#111827', marginTop: 2 }}>{v}</div>
              </div>
            ))}
        </div>
      )}

      {/* 필터 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 700 }}>날짜 기준</label>
        <select style={inp} value={basis} onChange={e => setBasis(e.target.value as DateBasis)} aria-label="날짜 기준 선택" data-testid="pr-basis-select">
          <option value="payout">지급일</option>
          <option value="delivery">납품일</option>
        </select>
        <DateField style={{ ...inp, width: 150 }} value={dateFrom} max={dateTo || undefined}
          onChange={setDateFrom} testid="pr-date-from" ariaLabel={`${basis === 'delivery' ? '납품일' : '지급일'} 시작`} />
        <span style={{ color: '#9ca3af' }}>~</span>
        <DateField style={{ ...inp, width: 150 }} value={dateTo} min={dateFrom || undefined}
          onChange={setDateTo} testid="pr-date-to" ariaLabel={`${basis === 'delivery' ? '납품일' : '지급일'} 종료`} />
        <input style={{ ...inp, minWidth: 180 }} placeholder="통번역사 검색" value={translator} onChange={e => setTranslator(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') loadRounds(1); }} aria-label="통번역사 검색" data-testid="pr-translator-search" />
        <button style={btn(true)} onClick={() => loadRounds(1)} disabled={loading} data-testid="pr-search-btn">{loading ? '조회 중…' : '조회'}</button>
        <button style={btn()} onClick={() => { setBasis('payout'); setDateFrom(''); setDateTo(''); setTranslator(''); setTimeout(() => loadRounds(1), 0); }} data-testid="pr-reset-btn">초기화</button>
        <div style={{ flex: 1 }} />
        <button style={btn()} onClick={exportRounds} data-testid="pr-export-rounds">↓ 회차 Excel</button>
        {sel && <button style={btn()} onClick={exportDetail} data-testid="pr-export-detail">↓ 상세 Excel</button>}
      </div>

      {/* 납품일 기준 안내 — 회차 합계가 '전체 지급내역'이 아니라 납품일 필터 결과임을 명시(§3) */}
      {applied.basis === 'delivery' && (
        <div data-testid="pr-delivery-notice" style={{ marginBottom: 10, padding: '9px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
          <b>납품일 기준</b> 조회입니다{(applied.from || applied.to) ? ` (납품일 ${applied.from || '…'} ~ ${applied.to || '…'})` : ''}. 아래 각 회차의 수취인 수·수행건수·합계는 <b>해당 납품일 조건에 해당하는 수행건만</b> 기준으로 재계산된 값이며, 그 지급회차의 전체 지급내역이 아닙니다. 납품일이 조건에 맞아도 지급일이 없는 건은 <b>지급일 미확인</b>으로 구분됩니다.
        </div>
      )}

      {/* 재현 회차 목록 */}
      <div style={scrollBox}>
        <table className="veritas-read-table vz-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['지급일(재현 회차)', '지급대상자', '수행건수', '세전합계', '세후합계', '원본차액(공제)', '현재세율재계산(참고)', '차이'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: h.includes('합계') || h.includes('차') || h.includes('재계산') ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>
            {rounds.map((r, i) => (
              <tr key={(r.payoutDate ?? 'none') + i} data-testid={`pr-round-${r.payoutDate ?? 'none'}`} onClick={() => loadDetail(r)}
                style={{ cursor: 'pointer', background: sel && sel.payoutDate === r.payoutDate ? '#eff6ff' : undefined }}>
                <td style={td}>{r.payoutDate ?? <span style={{ color: '#b45309', fontWeight: 700 }}>(지급일 미확인)</span>} <span style={{ fontSize: 11, color: '#9ca3af' }}>· 재현그룹</span></td>
                <td style={tdR}>{r.payeeCount.toLocaleString()}명</td>
                <td style={tdR}>{r.assignmentCount.toLocaleString()}건</td>
                <td style={tdR}>{won(r.pretaxTotal)}</td>
                <td style={tdR}>{won(r.posttaxTotal)}</td>
                <td style={tdR}>{won(r.withholdingImplied)}</td>
                <td style={{ ...tdR, color: '#6b7280' }}>{won(r.withholdingRecalc)}</td>
                <td style={{ ...tdR, color: Math.abs(r.withholdingDiff) > 0 ? '#dc2626' : '#9ca3af' }}>{won(r.withholdingDiff)}</td>
              </tr>
            ))}
            {rounds.length === 0 && !loading && <tr><td colSpan={8} style={{ padding: 28, textAlign: 'center', color: '#9ca3af' }}>재현 회차가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      {pg.total > 0 && (
        <Pagination idPrefix="pr-rounds" page={pg.page} pageSize={pg.pageSize} total={pg.total} unit="회차" disabled={loading}
          onPageChange={(p) => loadRounds(p)} onPageSizeChange={(s) => { setPg(v => ({ ...v, pageSize: s })); setTimeout(() => loadRounds(1), 0); }} />
      )}

      {/* 수행건별 상세(행 단위) — 납품일·지급일·통번역사·수행내용·세전·세후·원본공제 */}
      {sel && (
        <div style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>{sel.label} — 수행건별 상세</h2>
            {detailTotals && <span style={{ fontSize: 12, color: '#6b7280' }}>수취인 {detailTotals.payeeCount.toLocaleString()}명 · {detailTotals.assignmentCount.toLocaleString()}건 · 세전 {won(detailTotals.pretaxTotal)} · 세후 {won(detailTotals.posttaxTotal)} · 원본공제 {won(detailTotals.withholdingImpliedTotal)}</span>}
            {detail.length > 0 && (() => {
              const sc = detail.reduce((m: Record<string, number>, r) => { m[r.matchStatus] = (m[r.matchStatus] ?? 0) + 1; if (r.isPayroll) m.payroll = (m.payroll ?? 0) + 1; return m; }, {});
              const parts = [['confirmed', '연결확정'], ['candidate', '후보'], ['vendor', '외주업체'], ['client', '거래처'], ['unmatched', '미연결'], ['payroll', '직원성']]
                .filter(([k]) => sc[k]).map(([k, lbl]) => `${lbl} ${sc[k]}`);
              return <span style={{ fontSize: 11, color: '#334155', fontWeight: 700 }} data-testid="pr-detail-statusbar">[{parts.join(' · ')}]</span>;
            })()}
            {applied.basis === 'delivery' && <span style={{ fontSize: 11, color: '#b45309', fontWeight: 700 }}>※ 납품일 필터 적용분만 표시(전체 지급내역 아님)</span>}
          </div>
          <div style={scrollBox}>
            <table className="veritas-read-table vz-sticky" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['납품일', '지급일', '통번역사', '주민번호', '언어', '연결상태', '수행내용', '파일명', '세전지급액', '세후지급액', '원본공제액'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: h.includes('액') ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
              <tbody>
                {detail.map((p, i) => {
                  const meta = STATUS_META[p.matchStatus] ?? STATUS_META.unmatched;
                  return (
                  <tr key={p.id} data-testid={`pr-detail-${i}`} data-matchstatus={p.matchStatus}>
                    <td style={td}>{p.deliveryDate ?? <span style={{ color: '#b45309' }}>(납품일 미상)</span>}</td>
                    <td style={td}>{p.payoutDate ?? <span style={{ color: '#b45309', fontWeight: 700 }}>(지급일 미확인)</span>}</td>
                    <td style={{ ...td, whiteSpace: 'normal', lineHeight: 1.35 }}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{p.translator ?? '-'}</div>
                      {(p.masterEmail || p.masterPhone) && (
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }} title="현재 Master 등록 연락처 · 과거 CRM 원본 아님">
                          {p.masterEmail && <div data-testid={`pr-detail-email-${i}`}>✉ {p.masterEmail}</div>}
                          {p.masterPhone && <div data-testid={`pr-detail-phone-${i}`}>☎ {p.masterPhone}</div>}
                        </div>
                      )}
                    </td>
                    <td style={{ ...td, fontVariantNumeric: 'tabular-nums', color: p.residentMasked ? '#6b7280' : '#d1d5db' }} title="주민번호는 앞 6자리만 표시(마스킹)">{p.residentMasked ?? '-'}</td>
                    <td style={{ ...td, whiteSpace: 'normal', maxWidth: 160 }} data-testid={`pr-detail-language-${i}`} title={p.languageSource === 'master' ? 'Master 등록 언어(참고) · 원본에 언어 없음' : (p.languageSource === 'original' ? '과거 CRM 원본 언어' : undefined)}>
                      {p.language ? <>{p.language}{p.languageSource === 'master' && <span style={{ marginLeft: 3, fontSize: 10, color: '#9ca3af' }}>(Master참고)</span>}</> : '-'}
                    </td>
                    <td style={td}>
                      <span style={{ padding: '2px 8px', borderRadius: 10, background: meta.bg, color: meta.fg, fontSize: 12, fontWeight: 700 }} data-testid={`pr-detail-status-${i}`}>
                        {meta.label}{(p.matchStatus === 'confirmed' || p.matchStatus === 'candidate') && p.matchedUserId ? ` · ${p.matchedUserName ?? ''}#${p.matchedUserId}` : ''}
                      </span>
                      {p.isPayroll && <span style={{ marginLeft: 4, padding: '2px 6px', borderRadius: 10, background: '#f1f5f9', color: '#475569', fontSize: 11, fontWeight: 700 }}>직원성 지급</span>}
                    </td>
                    <td style={{ ...td, whiteSpace: 'normal', maxWidth: 280 }}>{p.content ?? '-'}</td>
                    <td style={{ ...td, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.filename ?? undefined} data-testid={`pr-detail-filename-${i}`}>{p.filename ?? '-'}</td>
                    <td style={tdR}>{won(p.pretax)}</td>
                    <td style={tdR}>{won(p.posttax)}</td>
                    <td style={tdR}>{won(p.withholdingImplied)}</td>
                  </tr>
                  );
                })}
                {detail.length === 0 && !payeeLoading && <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>상세 내역이 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
