// ─────────────────────────────────────────────────────────────────────────────
// 세무자료(정산 · 세무사 제출용 지급자료) — 재무→정산→세무자료.
//  · 조회조건(지급기간·통번역사명·국내/해외) + 검색/초기화 + 목록 + Excel 다운로드.
//  · 데이터 = 서버(/api/admin/tax-report) 그대로 — 신규 플랫폼 실제 지급완료 건(지급 송금일 기준) +
//    과거 CRM 지급완료 건(지급회차 관리와 같은 통합 판정). 지급예정·미지급·중복 의심 건은 포함하지 않는다.
//  · 금액·세금은 저장값 그대로(재계산·보정 없음). 과거 CRM은 원본 세전·세후, 원천세액 = 세전−세후.
//  · 주민번호: 화면은 마스킹, Excel(reveal=1)은 권한(translator.sensitive) 보유 시 전체값(과거 CRM 원본은 마스킹만).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';
import { downloadTaxReportExcel, todayStamp, TAX_REGION_LABEL, TAX_SOURCE_LABEL, type TaxReportRow } from '../../lib/taxReportExcel';
import { DateField } from './DatePickerShared';
import { formatDisplayDate } from '../../lib/dateFormat';
import './readTableView.css';

const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString('ko-KR');
const amt = (n: number | null | undefined) => (n == null ? '-' : won(n));
const RECENT_MONTHS = 3;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const recentFrom = () => { const d = new Date(); d.setMonth(d.getMonth() - RECENT_MONTHS); return ymd(d); };

type Region = 'all' | 'domestic' | 'overseas' | 'unconfirmed';
type Applied = { from: string; to: string; q: string; region: Region; label: string };
// 결과 없음 상태 구분 — 실제 0건 / 권한 없음 / API 오류 / 연결 오류
type LoadState = 'ok' | 'forbidden' | 'api_error' | 'network_error';

interface Props { token: string; onToast: (m: string) => void; }

function buildApplied(f: { from: string; to: string; q: string; region: Region }): Applied {
  if (f.from || f.to) return { ...f, label: `지급일 ${f.from || '…'} ~ ${f.to || '…'}` };
  if (f.q.trim()) return { ...f, label: '전체 기간' };
  const from = recentFrom();
  return { ...f, from, label: `최근 ${RECENT_MONTHS}개월(지급일 ${from} 이후)` };
}

export default function TaxReportTab({ token, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [rows, setRows] = useState<TaxReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<LoadState>('ok');
  const [errMsg, setErrMsg] = useState('');
  const [canReveal, setCanReveal] = useState(false);
  const [excluded, setExcluded] = useState<{ paidWithoutPayoutDate: number; duplicateSuspect: number } | null>(null);
  // ── 조회조건(입력) / 적용된 조건 ──
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [q, setQ] = useState('');
  const [region, setRegion] = useState<Region>('all');
  const [applied, setApplied] = useState<Applied>(() => buildApplied({ from: '', to: '', q: '', region: 'all' }));
  const [downloading, setDownloading] = useState(false);

  const inp: React.CSSProperties = { ...dsInputStd(), fontFamily: 'inherit', minHeight: 32, padding: '5px 9px', width: '100%' };
  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '8px 10px', borderBottom: BD.grid, whiteSpace: 'nowrap', textAlign: 'left', background: C.g50 };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '8px 10px', borderBottom: BD.divider, whiteSpace: 'nowrap' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  const params = (a: Applied, reveal = false) => {
    const p = new URLSearchParams();
    if (reveal) p.set('reveal', '1');
    if (a.from) p.set('from', a.from);
    if (a.to) p.set('to', a.to);
    if (a.q.trim()) p.set('q', a.q.trim());
    return p;
  };

  const fetchRows = useCallback(async (a: Applied) => {
    setLoading(true); setState('ok'); setErrMsg('');
    try {
      const res = await fetch(api(`/api/admin/tax-report?${params(a).toString()}`), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const m = data.error ?? `조회 실패 (HTTP ${res.status})`;
        setState(res.status === 401 || res.status === 403 ? 'forbidden' : 'api_error'); setErrMsg(m); setRows([]); onToast(m); return;
      }
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setCanReveal(!!data.canReveal);
      setExcluded(data.legacyExcluded ?? null);
    } catch {
      setState('network_error'); setErrMsg('서버에 연결할 수 없습니다. 네트워크 또는 서버 상태를 확인하세요.'); setRows([]); onToast('세무자료 서버 연결 오류');
    } finally { setLoading(false); }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchRows(applied); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = () => { const a = buildApplied({ from: dateFrom, to: dateTo, q, region }); setApplied(a); fetchRows(a); };
  const reset = () => {
    setDateFrom(''); setDateTo(''); setQ(''); setRegion('all');
    const a = buildApplied({ from: '', to: '', q: '', region: 'all' }); setApplied(a); fetchRows(a);
  };

  // 국내/해외 구분은 화면 즉시 필터(서버 결과 위) — Excel 에도 동일 적용.
  const filtered = useMemo(() => rows.filter((r) => region === 'all' ? true : r.region === region), [rows, region]);

  const totals = useMemo(() => filtered.reduce((t, r) => ({
    pretax: t.pretax + Number(r.pretax ?? 0),
    withholding: t.withholding + Number(r.withholdingTax ?? 0),
    posttax: t.posttax + Number(r.posttax ?? 0),
    overseas: t.overseas + Number(r.overseasAmount ?? 0),
  }), { pretax: 0, withholding: 0, posttax: 0, overseas: 0 }), [filtered]);
  const counts = useMemo(() => ({
    legacy: filtered.filter((r) => r.source === 'legacy').length,
    current: filtered.filter((r) => r.source !== 'legacy').length,
    unconfirmed: filtered.filter((r) => r.region === 'unconfirmed').length,
  }), [filtered]);

  // 주민번호 미등록 인원수 — 지급대상(payeeKey)별로 주민번호가 하나도 없으면 미등록 1명.
  const missingRrn = useMemo(() => {
    const has = new Map<string, boolean>();
    for (const r of filtered as any[]) {
      const key = r.payeeKey || `n:${r.payeeName}`;
      has.set(key, (has.get(key) || false) || !!r.residentNumberMasked);
    }
    return [...has.values()].filter((v) => !v).length;
  }, [filtered]);

  // 동명이인 — 같은 이름에 서로 다른 통번역사 ID 가 있으면 ID 표시.
  const homonyms = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const r of filtered) { const s = m.get(r.payeeName) ?? new Set(); s.add(r.payeeId != null ? String(r.payeeId) : 'n'); m.set(r.payeeName, s); }
    return new Set([...m].filter(([, v]) => v.size > 1).map(([k]) => k));
  }, [filtered]);

  // Excel — 주민번호 전체값 필요 → reveal=1 로 같은 조건 재조회(권한 없으면 서버가 마스킹만 반환). 화면과 같은 구분 필터.
  const exportExcel = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(api(`/api/admin/tax-report?${params(applied, true).toString()}`), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? 'Excel 조회 실패'); return; }
      const exRows: TaxReportRow[] = (Array.isArray(data.rows) ? data.rows : []).filter((r: any) => region === 'all' ? true : r.region === region);
      if (exRows.length === 0) { onToast('내보낼 데이터가 없습니다.'); return; }
      if (exRows.length !== filtered.length) onToast(`주의: 화면 ${filtered.length}건과 Excel ${exRows.length}건이 다릅니다(조회 사이 자료 변경). 다시 검색 후 받아 주세요.`);
      const periodTag = `${applied.from || '전체'}_${applied.to || '전체'}`.replace(/[\\/:*?"<>|\s]+/g, '');
      downloadTaxReportExcel({ filename: `세무자료_${periodTag}_${todayStamp()}.xlsx`, rows: exRows, masked: !data.revealed });
      onToast(data.revealed ? `세무자료 ${exRows.length}건 Excel을 다운로드했습니다. (주민번호 전체값 포함)` : `세무자료 ${exRows.length}건 Excel을 다운로드했습니다. (주민번호 마스킹 — 전체값 권한 없음)`);
    } catch { onToast('Excel 생성 중 오류'); } finally { setDownloading(false); }
  };

  const STATE_MSG: Record<Exclude<LoadState, 'ok'>, string> = {
    forbidden: '세무자료 조회 권한이 없습니다.', api_error: '세무자료 API 오류가 발생했습니다.', network_error: '데이터 연결 오류',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      {/* ── 조회조건 ── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-end', columnGap: SP[6], rowGap: SP[4], flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>지급기간</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <DateField style={{ ...inp, width: 152 }} value={dateFrom} max={dateTo || undefined}
                onChange={(v) => setDateFrom(v)} testid="tax-filter-from" ariaLabel="지급기간 시작" />
              <span style={{ color: C.textSecondary }}>~</span>
              <DateField style={{ ...inp, width: 152 }} value={dateTo} min={dateFrom || undefined}
                onChange={(v) => setDateTo(v)} testid="tax-filter-to" ariaLabel="지급기간 종료" />
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>통번역사명</span>
            <input style={{ ...inp, width: 200 }} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder="통번역사명 검색" data-testid="tax-filter-q" aria-label="통번역사명 검색" />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>국내/해외 구분</span>
            <div style={{ width: 160 }}>
              <ClickSelect value={region} onChange={(v: string) => setRegion((v || 'all') as Region)} triggerStyle={inp} style={{ width: '100%' }}
                options={[{ value: 'all', label: '전체' }, { value: 'domestic', label: '국내(원천징수)' }, { value: 'overseas', label: '해외' }, { value: 'unconfirmed', label: '구분 확인 필요' }]}
                data-testid="tax-region-filter" aria-label="국내/해외 구분 선택" />
            </div>
          </div>
          <PrimaryBtn onClick={runSearch} disabled={loading} style={{ fontSize: 12, padding: '7px 16px' }} data-testid="tax-search" aria-label="세무자료 검색">{loading ? '조회 중…' : '검색'}</PrimaryBtn>
          <GhostBtn onClick={reset} style={{ fontSize: 12, padding: '7px 14px' }} data-testid="tax-filter-reset" aria-label="검색 초기화">초기화</GhostBtn>
          <div style={{ marginLeft: 'auto' }}>
            <PrimaryBtn onClick={exportExcel} disabled={downloading || loading || filtered.length === 0}
              style={{ fontSize: 12, padding: '7px 14px' }} data-testid="tax-excel" aria-label="세무자료 Excel 다운로드">📊 Excel 다운로드</PrimaryBtn>
          </div>
        </div>
        {!canReveal && (
          <div style={{ ...TYPO.helper, color: C.textSecondary, marginTop: SP[2] }}>
            ⓘ 주민번호 전체값 열람 권한(통번역사 민감정보)이 없어 Excel에도 마스킹 값으로 출력됩니다.
          </div>
        )}
      </Card>

      {/* ── 조회 결과 요약 ── */}
      {!loading && state === 'ok' && (
        <div data-testid="tax-summary" style={{ display: 'flex', gap: SP[4], alignItems: 'center', flexWrap: 'wrap', padding: `${SP[2]}px ${SP[3]}px`, background: C.g50, borderRadius: 8, ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ ...TYPO.helper, fontWeight: 700 }}>{applied.label}{applied.q.trim() ? ` · "${applied.q.trim()}"` : ''}</span>
          <span>건수 <b>{filtered.length}건</b> <span style={{ color: C.textSecondary }}>(과거 {counts.legacy} · 신규 {counts.current})</span></span>
          <span>세전 <b>{won(totals.pretax)}원</b></span>
          <span>원천징수 <b style={{ color: C.danger }}>{won(totals.withholding)}원</b></span>
          <span>세후 <b style={{ color: C.primaryText }}>{won(totals.posttax)}원</b></span>
          <span>해외송금 <b>{won(totals.overseas)}원</b></span>
          <span>주민번호 미등록 <b style={{ color: missingRrn > 0 ? C.danger : C.textSecondary }}>{missingRrn}명</b></span>
          {counts.unconfirmed > 0 && <span style={{ color: '#92400e' }}>국내·해외 구분 확인 필요 <b>{counts.unconfirmed}건</b></span>}
        </div>
      )}
      {!loading && state === 'ok' && excluded && (excluded.paidWithoutPayoutDate > 0 || excluded.duplicateSuspect > 0) && (
        <div data-testid="tax-excluded-notice" style={{ ...TYPO.helper, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: `${SP[2]}px ${SP[3]}px` }}>
          ⓘ 세무자료에서 제외된 과거 CRM 지급완료 건: 지급일 미상 {excluded.paidWithoutPayoutDate}건 · 신규 자료와 중복 의심 {excluded.duplicateSuspect}건 (임의 보정하지 않음 — 지급회차 관리에서 확인)
        </div>
      )}

      {loading && <Card style={{ padding: 32, textAlign: 'center', color: C.g400 }}>불러오는 중…</Card>}
      {!loading && state !== 'ok' && (
        <Card style={{ padding: 24, textAlign: 'center' }} data-testid={`tax-state-${state}`}>
          <div style={{ color: C.danger, fontWeight: 700, marginBottom: 6 }}>⚠ {STATE_MSG[state]}</div>
          <div style={{ ...TYPO.helper, color: C.textSecondary, marginBottom: 10 }}>{errMsg}</div>
          {state !== 'forbidden' && <GhostBtn onClick={() => fetchRows(applied)} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="tax-retry" aria-label="다시 시도">다시 시도</GhostBtn>}
        </Card>
      )}

      {/* ── 목록 ── */}
      {!loading && state === 'ok' && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: SP[3] }}>
            <h3 style={{ margin: 0, ...TYPO.sectionTitle }}>세무자료 목록 ({filtered.length})</h3>
          </div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 300px)' }}>
            <table className="veritas-read-table vz-sticky" style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1050 }}>
              <thead><tr>
                <th style={th}>지급일</th><th style={th}>통역사명</th><th style={th}>주민번호</th><th style={th}>언어</th><th style={th}>구분</th>
                <th style={{ ...th, textAlign: 'right' }}>지급액(세전)</th><th style={{ ...th, textAlign: 'right' }}>원천징수액</th><th style={{ ...th, textAlign: 'right' }}>지급액(세후)</th>
                <th style={{ ...th, textAlign: 'right' }}>해외 현지 송금건</th><th style={th}>출처</th>
              </tr></thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }} data-testid="tax-empty">
                    해당 조건의 실제 지급완료 자료가 없습니다. (지급예정·미지급 건은 세무자료에 포함되지 않습니다)
                  </td></tr>
                )}
                {filtered.map((r, i) => (
                  <tr key={i} data-source={r.source ?? 'current'} data-region={r.region ?? ''}>
                    <td style={td}>{formatDisplayDate(r.payDate) || '-'}</td>
                    <td style={{ ...td, fontWeight: 700 }}>
                      {r.payeeName}
                      {homonyms.has(r.payeeName) && <span style={{ marginLeft: 5, fontSize: 10, color: '#6d28d9', background: '#f5f3ff', padding: '1px 5px', borderRadius: 7 }} title="동명이인 — 통번역사 고유 ID로 구분">{r.payeeId != null ? `ID ${r.payeeId}` : '미연결'}</span>}
                    </td>
                    <td style={{ ...td, color: C.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{r.residentNumberMasked || <span style={{ color: C.danger }}>미등록</span>}</td>
                    <td style={td}>{r.language || '-'}</td>
                    <td style={{ ...td, color: r.region === 'unconfirmed' ? '#92400e' : undefined }}>{TAX_REGION_LABEL[r.region ?? ''] ?? '-'}</td>
                    <td style={tdR}>{amt(r.pretax)}</td>
                    <td style={{ ...tdR, color: C.danger }}>{amt(r.withholdingTax)}</td>
                    <td style={{ ...tdR, fontWeight: 700, color: r.posttax != null ? C.primaryText : undefined }}>{amt(r.posttax)}</td>
                    <td style={{ ...tdR, color: r.overseasAmount != null ? '#b45309' : undefined }}>{amt(r.overseasAmount)}</td>
                    <td style={{ ...td, color: C.textSecondary }}>{TAX_SOURCE_LABEL[r.source ?? 'current']}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
