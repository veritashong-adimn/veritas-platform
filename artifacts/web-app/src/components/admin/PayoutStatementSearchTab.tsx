// ─────────────────────────────────────────────────────────────────────────────
// 지급명세서 통합 검색·조회·출력 (정산 → 지급명세서 · READ-ONLY)
//  · 데이터 = '지급회차 관리'(PayoutUnifiedTab)와 동일한 통합 지급자료 API(/admin/payout-unified/*) —
//    과거 CRM(legacy_archive_rows progress) + 신규 플랫폼(performance_assignments). 별도 데이터·재계산 없음.
//  · 목록 1행 = 지급대상자(Master 연결 기준 masterKey — 동명이인은 통번역사 고유 ID로 구분) × 지급일(회차).
//    금액은 서버가 내려준 건별 세전·세후·공제(세전−세후)를 회차 상세와 같은 방식으로 합산만 한다.
//  · 명세서 Excel·PDF = 지급회차 관리와 같은 정식 양식(payoutReproStatement) 재사용.
//    지급완료가 아닌 건(지급예정·지급대기·지급확인 필요·중복 의심·지급 제외)은 명세서에 넣지 않는다.
//  · 저장·지급확정·상태변경·재지급 기능 없음(과거 CRM 지급완료 건 포함 — 조회·출력 전용).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/constants';
import { Pagination } from '../ui/Paginator';
import { DateField } from './DatePickerShared';
import { exportReproStatementExcel, exportReproStatementPdf, reproPayeeLanguages, type ReproStmtOpts } from '../../lib/payoutReproStatement';
import { exportDataset, todayStamp } from '../../lib/excelExport';
import './readTableView.css';

type Status = 'paid' | 'scheduled' | 'pending' | 'deposit_unconfirmed' | 'excluded' | 'dup_suspect';
type Item = {
  source: 'legacy' | 'current'; sourceKey: string; id: number;
  deliveryDate: string | null; payoutDate: string | null; client: string | null; translator: string | null;
  language: string | null; languageSource?: 'original' | 'master' | null; masterLanguages?: string | null; masterEmail: string | null; masterPhone: string | null; originalPhone: string | null;
  matchStatus: string; matchedUserId: number | null; masterKey: string; confirmed: boolean;
  content: string | null; filename: string | null; pretax: number; posttax: number; withholdingImplied: number;
  withholdingTax?: number | null;   // 신규: 저장 원천세 / 과거 CRM: null(세전−세후만 존재 → 전액 원천징수로 표시, 분리 추정 안 함)
  status: Status; statusLabel: string; paidBasis: string | null;
};
type Stmt = {
  key: string; masterKey: string; matchedUserId: number | null; confirmed: boolean; matchStatus: string;
  name: string; email: string | null; phone: string | null; payoutDate: string | null;
  count: number; pretax: number; posttax: number; withholding: number; otherDeduction: number;
  byStatus: Partial<Record<Status, number>>; paidItems: Item[]; items: Item[]; sources: Set<string>;
};

const STATUS_META: Record<Status, { label: string; bg: string; fg: string }> = {
  paid: { label: '지급완료', bg: '#eff6ff', fg: '#1d4ed8' },
  pending: { label: '지급대기', bg: '#fffbeb', fg: '#b45309' },
  scheduled: { label: '지급예정', bg: '#ecfdf5', fg: '#047857' },
  deposit_unconfirmed: { label: '지급확인 필요', bg: '#fef3c7', fg: '#92400e' },
  dup_suspect: { label: '중복 의심', bg: '#fef2f2', fg: '#dc2626' },
  excluded: { label: '지급 제외', bg: '#f1f5f9', fg: '#475569' },
};
const STATUS_OPTS: [string, string][] = [['all', '전체 상태'], ['paid', '지급완료'], ['scheduled', '지급예정'], ['pending', '지급대기'], ['deposit_unconfirmed', '지급확인 필요'], ['dup_suspect', '중복 의심'], ['excluded', '지급 제외']];
const SOURCE_OPTS: [string, string][] = [['all', '과거+신규'], ['legacy', '과거 CRM'], ['current', '신규 플랫폼']];
const RECENT_MONTHS = 3;   // 조건 미지정 시 기본 조회: 최근 3개월 지급일 ~ 이후 지급예정분

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const won = (n: number) => Math.round(n).toLocaleString();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const recentFrom = () => { const d = new Date(); d.setMonth(d.getMonth() - RECENT_MONTHS); return ymd(d); };
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const roundLabel = (d: string | null) => (d ? `${d} 지급` : '지급일 미확인');
/** 원천징수액·기타 공제액 — 서버 저장값 분해만(계산식 없음). 세전−세후(공제 합계) = 원천징수 + 기타 공제.
 *  분리는 지급완료(세금 확정) 신규 건만. 미지급 신규 건은 원천세·실지급 저장값이 아직 0(미계산)이고, 과거 CRM은 분리 정보가 없어
 *  지급회차 관리 '원천세공제'와 같이 세전−세후 전액을 원천징수로 표시한다(기타 공제 0). */
const whOf = (it: Item) => (it.status === 'paid' && it.source === 'current' && it.withholdingTax != null ? num(it.withholdingTax) : num(it.withholdingImplied));
const otherOf = (it: Item) => Math.round((num(it.withholdingImplied) - whOf(it)) * 100) / 100;
type LoadState = 'ok' | 'forbidden' | 'api_error' | 'network_error';
const STATE_MSG: Record<Exclude<LoadState, 'ok'>, string> = { forbidden: '지급자료 조회 권한이 없습니다.', api_error: '지급자료 API 오류가 발생했습니다.', network_error: '데이터 연결 오류' };

/** 지급회차 관리(PayoutUnifiedTab)와 같은 연락처 선택 규칙: 확정 Master 연락처 1개 → 그 값, 없으면 원본 연락처 1개. */
function pickPhone(rows: Item[]): string | null {
  const conf = new Set(rows.filter(r => r.matchStatus === 'confirmed' && r.masterPhone).map(r => r.masterPhone as string));
  if (conf.size === 1) return [...conf][0]; if (conf.size > 1) return null;
  const orig = new Set(rows.filter(r => r.originalPhone).map(r => r.originalPhone as string));
  return orig.size === 1 ? [...orig][0] : null;
}

/** 지급완료 건만 정식 명세서에 담는다(미지급·예정·확인필요 건을 지급완료 명세서로 출력하지 않음). */
function stmtOpts(s: Stmt): ReproStmtOpts {
  // 상단 수행 언어 — 지급회차관리 PDF 와 같은 공용 규칙(reproPayeeLanguages). 명세서 대상(지급완료) 건 기준.
  return {
    payeeName: s.name, payeeLanguages: reproPayeeLanguages(s.paidItems), email: s.email, phone: s.phone, scopeValue: roundLabel(s.payoutDate), payDate: s.payoutDate ?? '-',
    rows: s.paidItems.map(r => ({ client: r.client, filename: r.filename, deliveryDate: r.deliveryDate, payoutDate: r.payoutDate, content: r.content, pretax: r.pretax, posttax: r.posttax })),
  };
}

export function PayoutStatementSearchTab({ token, onToast }: { token: string; onToast: (m: string) => void }) {
  const authH = { Authorization: `Bearer ${token}` };
  const [q, setQ] = useState('');
  const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const [round, setRound] = useState('');            // '' = 전체, 'none' = 지급일 미확인, 'YYYY-MM-DD'
  const [status, setStatus] = useState('all'); const [source, setSource] = useState('all');
  const [roundDates, setRoundDates] = useState<(string | null)[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [appliedLabel, setAppliedLabel] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('ok');
  const [pg, setPg] = useState({ page: 1, pageSize: 20 });
  const [selKey, setSelKey] = useState<string | null>(null);

  // 지급회차(지급일) 목록 — 지급회차 관리와 같은 API(지급일 기준 그룹). 조회만.
  useEffect(() => {
    fetch(api('/api/admin/payout-unified/rounds?basis=payout&pageSize=500'), { headers: authH })
      .then(r => r.json()).then(d => setRoundDates((d.rounds ?? []).map((r: any) => r.payoutDate ?? null))).catch(() => setRoundDates([]));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = useCallback(async (f: { q: string; dateFrom: string; dateTo: string; round: string; status: string; source: string }) => {
    setLoading(true); setError(''); setLoadState('ok'); setSelKey(null);
    const p = new URLSearchParams(); p.set('basis', 'payout');
    let label: string;
    if (f.round) { p.set('date', f.round); label = roundLabel(f.round === 'none' ? null : f.round); }
    else if (f.dateFrom || f.dateTo) {
      if (isYmd(f.dateFrom)) p.set('dateFrom', f.dateFrom); if (isYmd(f.dateTo)) p.set('dateTo', f.dateTo);
      label = `지급일 ${f.dateFrom || '…'} ~ ${f.dateTo || '…'}`;
    } else if (f.q.trim()) label = '전체 기간';
    else { const from = recentFrom(); p.set('dateFrom', from); label = `최근 ${RECENT_MONTHS}개월(지급일 ${from} 이후 · 지급예정 포함)`; }
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.status !== 'all') p.set('status', f.status);
    if (f.source !== 'all') p.set('source', f.source);
    try {
      let r: Response;
      try { r = await fetch(api(`/api/admin/payout-unified/payees?${p}`), { headers: authH }); }
      catch { setLoadState('network_error'); setError('서버에 연결할 수 없습니다. 네트워크 또는 서버 상태를 확인하세요.'); setItems([]); return; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setLoadState(r.status === 401 || r.status === 403 ? 'forbidden' : 'api_error'); setError(d?.error || `조회 실패 (HTTP ${r.status})`); setItems([]); return; }
      setItems(d.items ?? []); setTruncated(!!d.truncated); setAppliedLabel(label); setPg(v => ({ ...v, page: 1 }));
    } catch (e: any) { setLoadState('api_error'); setError(e?.message || '지급명세서 조회 실패'); setItems([]); }
    finally { setLoading(false); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { search({ q: '', dateFrom: '', dateTo: '', round: '', status: 'all', source: 'all' }); }, [search]);

  const runSearch = () => search({ q, dateFrom, dateTo, round, status, source });
  const reset = () => {
    setQ(''); setDateFrom(''); setDateTo(''); setRound(''); setStatus('all'); setSource('all');
    search({ q: '', dateFrom: '', dateTo: '', round: '', status: 'all', source: 'all' });
  };

  // 지급대상자(masterKey) × 지급일 단위 명세서 — 지급회차 관리의 회차별 통번역사 집계와 같은 합산(서버 건별값 그대로).
  const stmts = useMemo<Stmt[]>(() => {
    const m = new Map<string, Stmt>();
    for (const it of items) {
      const key = `${it.masterKey}|${it.payoutDate ?? 'none'}`;
      const s = m.get(key) ?? { key, masterKey: it.masterKey, matchedUserId: it.matchedUserId, confirmed: it.confirmed, matchStatus: it.matchStatus,
        name: it.translator ?? '(이름 미상)', email: null, phone: null, payoutDate: it.payoutDate, count: 0, pretax: 0, posttax: 0, withholding: 0, otherDeduction: 0,
        byStatus: {}, paidItems: [], items: [], sources: new Set<string>() };
      s.count++; s.pretax += num(it.pretax); s.posttax += num(it.posttax); s.withholding += whOf(it); s.otherDeduction += otherOf(it);
      s.byStatus[it.status] = (s.byStatus[it.status] ?? 0) + 1;
      if (it.status === 'paid') s.paidItems.push(it);
      s.items.push(it); s.sources.add(it.source);
      if (!s.email && it.masterEmail) s.email = it.masterEmail;
      m.set(key, s);
    }
    const out = [...m.values()];
    for (const s of out) { s.phone = pickPhone(s.items); s.withholding = Math.round(s.withholding * 100) / 100; s.otherDeduction = Math.round(s.otherDeduction * 100) / 100; }
    return out.sort((a, b) => (b.payoutDate ?? '').localeCompare(a.payoutDate ?? '') || a.name.localeCompare(b.name, 'ko') || a.masterKey.localeCompare(b.masterKey));
  }, [items]);

  // 동명이인 표시 — 같은 이름에 서로 다른 masterKey(통번역사 고유 ID)가 있으면 ID 배지로 구분.
  const homonyms = useMemo(() => {
    const byName = new Map<string, Set<string>>();
    for (const s of stmts) { const set = byName.get(s.name) ?? new Set(); set.add(s.masterKey); byName.set(s.name, set); }
    return new Set([...byName].filter(([, v]) => v.size > 1).map(([k]) => k));
  }, [stmts]);

  const totals = useMemo(() => stmts.reduce((t, s) => ({ count: t.count + s.count, pretax: t.pretax + s.pretax, withholding: t.withholding + s.withholding, other: t.other + s.otherDeduction, posttax: t.posttax + s.posttax }),
    { count: 0, pretax: 0, withholding: 0, other: 0, posttax: 0 }), [stmts]);
  const pageRows = stmts.slice((pg.page - 1) * pg.pageSize, pg.page * pg.pageSize);
  const sel = stmts.find(s => s.key === selKey) ?? null;

  const exportStmt = (s: Stmt, kind: 'excel' | 'pdf') => {
    if (s.paidItems.length === 0) { onToast('지급완료 건이 없어 명세서를 출력할 수 없습니다(지급예정·미지급 건은 지급명세서로 출력하지 않습니다).'); return; }
    const opts = stmtOpts(s);
    if (kind === 'excel') { exportReproStatementExcel(opts); onToast(`${s.name} 지급명세서 Excel을 다운로드했습니다.`); }
    else if (!exportReproStatementPdf(opts)) onToast('팝업 차단을 해제한 후 다시 시도해 주세요.');
  };

  const exportList = () => {
    if (stmts.length === 0) { onToast('다운로드할 명세서 목록이 없습니다.'); return; }
    const statusText = (s: Stmt) => (Object.entries(s.byStatus) as [Status, number][]).map(([k, n]) => `${STATUS_META[k].label} ${n}건`).join(', ');
    exportDataset<Stmt>({
      filename: `지급명세서목록_${todayStamp()}.xlsx`, sheetName: '지급명세서 목록',
      columns: [
        { header: '통번역사', value: 'name', width: 14 },
        { header: '통번역사 ID', value: (s) => s.matchedUserId ?? '', width: 10 },
        { header: '이메일', value: (s) => s.email ?? '', width: 24 },
        { header: '연락처', value: (s) => s.phone ?? '', width: 15 },
        { header: '지급일', value: (s) => s.payoutDate ?? '지급일 미확인', width: 12 },
        { header: '지급회차', value: (s) => roundLabel(s.payoutDate), width: 16 },
        { header: '수행건수', value: 'count', type: 'number', width: 9 },
        { header: '세전금액', value: (s) => Math.round(s.pretax), type: 'number', width: 13 },
        { header: '원천징수액', value: (s) => Math.round(s.withholding), type: 'number', width: 13 },
        { header: '기타 공제액', value: (s) => Math.round(s.otherDeduction), type: 'number', width: 12 },
        { header: '실지급금액', value: (s) => Math.round(s.posttax), type: 'number', width: 13 },
        { header: '지급상태', value: statusText, width: 26 },
        { header: '명세서 출력 가능(지급완료 건)', value: (s) => s.paidItems.length, type: 'number', width: 12 },
      ],
      rows: stmts,
    });
    onToast(`명세서 ${stmts.length.toLocaleString()}건(수행 ${totals.count.toLocaleString()}건)을 Excel로 내보냈습니다.`);
  };

  const inp: React.CSSProperties = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 };
  const btn = (primary?: boolean): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, border: 'none', cursor: 'pointer', background: primary ? '#0ea5e9' : '#e5e7eb', color: primary ? '#fff' : '#374151' });
  const stmtBtn = (enabled: boolean): React.CSSProperties => ({ minWidth: 52, padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, border: '1px solid #cbd5e1', background: '#fff', color: enabled ? '#334155' : '#cbd5e1', cursor: enabled ? 'pointer' : 'not-allowed', lineHeight: 1.2 });
  const th: React.CSSProperties = { padding: '8px 10px', whiteSpace: 'nowrap', textAlign: 'left' };
  const thR: React.CSSProperties = { ...th, textAlign: 'right' };
  const td: React.CSSProperties = { padding: '7px 10px', fontSize: 12.5, color: '#374151', whiteSpace: 'nowrap' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const badge = (st: Status, n?: number) => (
    <span key={st} style={{ fontSize: 10.5, color: STATUS_META[st].fg, background: STATUS_META[st].bg, padding: '1px 6px', borderRadius: 7, whiteSpace: 'nowrap' }}>
      {STATUS_META[st].label}{n != null ? ` ${n}` : ''}</span>
  );

  return (
    <div data-testid="payout-statement-search">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '0 0 8px', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 19, fontWeight: 800, color: '#111827', margin: 0 }}>지급명세서</h1>
        <span style={{ fontSize: 11.5, color: '#9ca3af' }}>지급회차 관리와 동일한 통합 지급자료(과거 CRM + 신규 플랫폼) · 조회·출력 전용 · 명세서는 지급완료 건만 출력</span>
      </div>

      {/* 상단 — 통합 검색 · 지급일 기간 · 지급회차 · 지급상태 · 과거/신규 · 검색/초기화 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <input style={{ ...inp, minWidth: 260, flex: '1 1 260px', maxWidth: 380 }} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
          placeholder="통번역사·이메일·연락처·거래처·지급일(예: 2026-09)" aria-label="통합 검색" data-testid="ps-q" />
        <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 700 }}>지급일</span>
        <DateField style={{ ...inp, width: 142 }} value={dateFrom} max={dateTo || undefined} onChange={setDateFrom} testid="ps-from" ariaLabel="지급일 시작" />
        <span style={{ color: '#9ca3af' }}>~</span>
        <DateField style={{ ...inp, width: 142 }} value={dateTo} min={dateFrom || undefined} onChange={setDateTo} testid="ps-to" ariaLabel="지급일 종료" />
        <select style={{ ...inp, maxWidth: 200 }} value={round} onChange={e => setRound(e.target.value)} aria-label="지급회차 선택" data-testid="ps-round">
          <option value="">전체 지급회차</option>
          {roundDates.map(d => <option key={d ?? 'none'} value={d ?? 'none'}>{roundLabel(d)}</option>)}
        </select>
        <select style={inp} value={status} onChange={e => setStatus(e.target.value)} aria-label="지급상태" data-testid="ps-status">{STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select style={inp} value={source} onChange={e => setSource(e.target.value)} aria-label="과거·신규 구분" data-testid="ps-source">{SOURCE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button type="button" style={btn(true)} onClick={runSearch} disabled={loading} data-testid="ps-search" aria-label="검색">{loading ? '조회 중…' : '검색'}</button>
        <button type="button" style={btn()} onClick={reset} data-testid="ps-reset" aria-label="검색 초기화">초기화</button>
      </div>
      {round && (dateFrom || dateTo) && <div style={{ fontSize: 11.5, color: '#92400e', marginBottom: 8 }}>지급회차를 선택하면 지급일 기간보다 회차가 우선 적용됩니다.</div>}

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 중앙 — 지급대상자별 명세서 목록 */}
        <div style={{ flex: '1 1 640px', minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: '#6b7280', margin: '0 0 6px' }} data-testid="ps-scope">
            <b style={{ color: '#374151' }}>{appliedLabel}</b> · 명세서 {stmts.length.toLocaleString()}건 · 수행 {totals.count.toLocaleString()}건
            {truncated && <span style={{ color: '#b45309', fontWeight: 700 }}> · 조회 상한(5,000건) 도달 — 기간·검색어로 범위를 좁혀 주세요</span>}
          </div>
          {loadState !== 'ok' && (
            <div data-testid={`ps-state-${loadState}`} style={{ padding: 16, border: '1px solid #fecaca', borderRadius: 10, marginBottom: 10, background: '#fef2f2' }}>
              <div style={{ color: '#dc2626', fontWeight: 700 }}>⚠ {STATE_MSG[loadState]}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{error}</div>
            </div>
          )}
          <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
            <table className="veritas-read-table vz-sticky pz-zebra" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>
                <th style={th}>통번역사</th><th style={th}>이메일</th><th style={th}>지급일(회차)</th><th style={thR}>수행건수</th>
                <th style={thR}>세전금액</th><th style={thR} title="과거 CRM은 원본 세전−세후 전액">원천징수액</th><th style={thR}>기타 공제액</th><th style={thR}>실지급금액</th><th style={th}>지급상태</th><th style={thR}>명세서 출력</th>
              </tr></thead>
              <tbody>
                {pageRows.map(s => {
                  const can = s.paidItems.length > 0; const partial = can && s.paidItems.length < s.count;
                  const tip = !can ? '지급완료 건이 없어 지급명세서를 출력할 수 없습니다' : partial ? `지급완료 ${s.paidItems.length}건만 명세서에 포함됩니다` : '지급명세서 출력';
                  return (
                    <tr key={s.key} onClick={() => setSelKey(s.key === selKey ? null : s.key)} data-testid={`ps-row-${s.key}`}
                      style={{ cursor: 'pointer', background: s.key === selKey ? '#dbeafe' : undefined }}>
                      <td style={{ ...td, fontWeight: 700, color: '#111827' }}>
                        {s.name}
                        {homonyms.has(s.name) && <span style={{ marginLeft: 5, fontSize: 10, color: '#6d28d9', background: '#f5f3ff', padding: '1px 5px', borderRadius: 7 }} title="동명이인 — 통번역사 고유 ID로 구분">{s.matchedUserId != null ? `ID ${s.matchedUserId}` : '미연결'}</span>}
                        {!s.confirmed && <span style={{ marginLeft: 5, fontSize: 10, color: '#1d4ed8', background: '#eff6ff', padding: '1px 5px', borderRadius: 7 }} title="Master 연결 미확정(이름 기준 표시)">{s.matchStatus === 'vendor' || s.matchStatus === 'client' ? '거래처' : '연결 확인필요'}</span>}
                      </td>
                      <td style={{ ...td, color: '#6b7280', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.email ?? undefined}>{s.email ?? ''}</td>
                      <td style={td}>{s.payoutDate ?? <span style={{ color: '#b45309', fontWeight: 700 }}>지급일 미확인</span>}</td>
                      <td style={tdR}>{s.count}</td>
                      <td style={tdR}>{won(s.pretax)}</td>
                      <td style={{ ...tdR, color: '#dc2626' }}>{won(s.withholding)}</td>
                      <td style={{ ...tdR, color: s.otherDeduction ? '#b45309' : '#9ca3af' }}>{won(s.otherDeduction)}</td>
                      <td style={{ ...tdR, fontWeight: 800, color: '#111827' }}>{won(s.posttax)}</td>
                      <td style={td}><div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>{(Object.entries(s.byStatus) as [Status, number][]).map(([k, n]) => badge(k, n))}</div></td>
                      <td style={{ ...tdR }}>
                        <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }} title={tip}>
                          <button type="button" style={stmtBtn(can)} disabled={!can} onClick={e => { e.stopPropagation(); exportStmt(s, 'excel'); }} data-testid={`ps-excel-${s.key}`} aria-label={`${s.name} ${roundLabel(s.payoutDate)} 지급명세서 Excel`}>Excel</button>
                          <button type="button" style={stmtBtn(can)} disabled={!can} onClick={e => { e.stopPropagation(); exportStmt(s, 'pdf'); }} data-testid={`ps-pdf-${s.key}`} aria-label={`${s.name} ${roundLabel(s.payoutDate)} 지급명세서 PDF`}>PDF</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {stmts.length === 0 && !loading && loadState === 'ok' && <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: '#9ca3af' }}>조회된 지급명세서가 없습니다. 검색어나 지급일 기간을 확인해 주세요.</td></tr>}
                {loading && <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center', color: '#9ca3af' }}>불러오는 중…</td></tr>}
              </tbody>
            </table>
          </div>
          {stmts.length > 0 && <Pagination idPrefix="ps-list" page={pg.page} pageSize={pg.pageSize} total={stmts.length} unit="건" disabled={loading} pageSizeOptions={[20, 50, 100]}
            onPageChange={(p) => setPg(v => ({ ...v, page: p }))} onPageSizeChange={(s) => setPg({ page: 1, pageSize: s })} />}

          {/* 선택 명세서 건별 상세 — 지급회차 관리 건별 상세와 같은 값(서버 건별 원본값) */}
          {sel && (
            <div style={{ marginTop: 14 }} data-testid="ps-detail">
              <div style={{ fontSize: 13, fontWeight: 800, color: '#374151', margin: '0 0 6px' }}>{sel.name} · {roundLabel(sel.payoutDate)} — 건별 상세 ({sel.count}건)</div>
              <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                <table className="veritas-read-table vz-sticky pr-detail-zebra" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr>{['거래처', '상품/업무', '상세내역', '납품일', '지급일', '세전지급액', '원천징수액', '기타 공제액', '세후지급액', '지급상태', '출처'].map(h => <th key={h} style={h.includes('액') ? thR : th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {sel.items.map(it => (
                      <tr key={it.sourceKey} data-testid={`ps-detail-${it.sourceKey}`}>
                        <td style={{ ...td, whiteSpace: 'normal', maxWidth: 180 }}>{it.client ?? <span style={{ color: '#b45309', fontWeight: 700 }}>거래처 확인 필요</span>}</td>
                        <td style={{ ...td, whiteSpace: 'normal', maxWidth: 200 }}>{it.content ?? '-'}</td>
                        <td style={{ ...td, whiteSpace: 'normal', maxWidth: 220 }}>{it.filename ?? '-'}</td>
                        <td style={td}>{it.deliveryDate ?? '-'}</td>
                        <td style={td}>{it.payoutDate ?? '-'}</td>
                        <td style={tdR}>{won(it.pretax)}</td>
                        <td style={{ ...tdR, color: '#dc2626' }}>{won(whOf(it))}</td>
                        <td style={tdR}>{won(otherOf(it))}</td>
                        <td style={tdR}>{won(it.posttax)}</td>
                        <td style={td} title={it.paidBasis ? `지급완료 근거: ${it.paidBasis}` : undefined}>{badge(it.status)}</td>
                        <td style={{ ...td, color: '#9ca3af' }}>{it.source === 'legacy' ? '과거 CRM' : '신규'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* 우측 — Excel / PDF 출력 */}
        <aside style={{ flex: '0 0 240px', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fff', position: 'sticky', top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }} data-testid="ps-output-panel">
          <div style={{ fontSize: 13, fontWeight: 800, color: '#374151', marginBottom: 8 }}>출력</div>
          <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.6, marginBottom: 10 }}>
            세전 <b style={{ color: '#111827' }}>{won(totals.pretax)}</b>원<br />원천징수 <b style={{ color: '#dc2626' }}>{won(totals.withholding)}</b>원<br />기타 공제 <b>{won(totals.other)}</b>원<br />실지급 <b style={{ color: '#111827' }}>{won(totals.posttax)}</b>원
          </div>
          <button type="button" style={{ ...btn(), width: '100%', marginBottom: 12 }} onClick={exportList} data-testid="ps-list-excel" aria-label="검색 결과 명세서 목록 Excel 다운로드">명세서 목록 Excel</button>
          <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 10, fontSize: 12 }}>
            {sel ? (
              <>
                <div style={{ fontWeight: 700, color: '#111827' }}>{sel.name}</div>
                <div style={{ color: '#6b7280', marginBottom: 6 }}>{roundLabel(sel.payoutDate)} · 지급완료 {sel.paidItems.length}/{sel.count}건</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" style={{ ...stmtBtn(sel.paidItems.length > 0), flex: 1, padding: '6px 0' }} disabled={!sel.paidItems.length} onClick={() => exportStmt(sel, 'excel')} data-testid="ps-sel-excel" aria-label="선택 명세서 Excel">Excel</button>
                  <button type="button" style={{ ...stmtBtn(sel.paidItems.length > 0), flex: 1, padding: '6px 0' }} disabled={!sel.paidItems.length} onClick={() => exportStmt(sel, 'pdf')} data-testid="ps-sel-pdf" aria-label="선택 명세서 PDF">PDF</button>
                </div>
                {sel.paidItems.length < sel.count && <div style={{ marginTop: 6, color: '#92400e', fontSize: 11.5 }}>지급완료가 아닌 {sel.count - sel.paidItems.length}건은 명세서에 포함되지 않습니다.</div>}
              </>
            ) : <span style={{ color: '#9ca3af' }}>목록에서 명세서를 선택하면 상세내역과 출력 버튼이 표시됩니다.</span>}
          </div>
        </aside>
      </div>
    </div>
  );
}
