// ─────────────────────────────────────────────────────────────────────────────
// 세무자료(정산 · 세무사 제출용 지급자료) — 재무→정산→세무자료.
//  · 조회조건(지급기간·지급대상·국내/해외) + 목록 + Excel 다운로드.
//  · 데이터·계산은 서버(/api/admin/tax-report)가 기존 정산 계산(calcPayoutWithholding)으로 산출한 값 그대로.
//  · 주민번호: 화면은 마스킹, Excel(reveal=1)은 권한(translator.sensitive) 보유 시 전체값.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';
import { downloadTaxReportExcel, todayStamp, type TaxReportRow } from '../../lib/taxReportExcel';

const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString('ko-KR');
const amt = (n: number | null | undefined) => (n == null ? '-' : won(n));

interface Props { token: string; onToast: (m: string) => void; }

export default function TaxReportTab({ token, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [rows, setRows] = useState<TaxReportRow[]>([]);       // 서버 조회 결과(지급기간 기준). region·q는 화면에서 필터.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canReveal, setCanReveal] = useState(false);
  // ── 조회조건 ──
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [q, setQ] = useState('');
  const [region, setRegion] = useState<'all' | 'domestic' | 'overseas'>('all');
  const [downloading, setDownloading] = useState(false);

  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 32, padding: '5px 9px', width: '100%' };
  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '8px 10px', borderBottom: BD.grid, whiteSpace: 'nowrap', textAlign: 'left', background: C.g50 };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '8px 10px', borderBottom: BD.divider, whiteSpace: 'nowrap' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  // 지급기간 기준으로 서버 조회(전체 지역). region·검색어는 화면에서 즉시 필터(요청 최소화).
  const fetchRows = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const res = await fetch(api(`/api/admin/tax-report?${params.toString()}`), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const m = data.error ?? `조회 실패 (HTTP ${res.status})`; setError(m); setRows([]); onToast(m); return; }
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setCanReveal(!!data.canReveal);
    } catch {
      setError('조회 중 오류가 발생했습니다. 네트워크 또는 서버 상태를 확인하세요.'); setRows([]); onToast('조회 중 오류');
    } finally { setLoading(false); }
  }, [token, dateFrom, dateTo]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  // 화면 필터(국내/해외 + 지급대상 검색) — 서버 재조회 없이 즉시 반영.
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return rows
      .filter((r: any) => region === 'all' ? true : r.region === region)
      .filter((r) => !kw || (r.payeeName ?? '').toLowerCase().includes(kw));
  }, [rows, region, q]);

  const totals = useMemo(() => filtered.reduce((t, r) => ({
    transport: t.transport + Number(r.transport ?? 0),
    pretax: t.pretax + Number(r.pretax ?? 0),
    posttax: t.posttax + Number(r.posttax ?? 0),
    overseas: t.overseas + Number(r.overseasAmount ?? 0),
  }), { transport: 0, pretax: 0, posttax: 0, overseas: 0 }), [filtered]);

  // 주민번호 미등록 인원수 — 지급대상(payeeKey)별로 주민번호가 하나도 없으면 미등록 1명.
  const missingRrn = useMemo(() => {
    const has = new Map<string, boolean>();
    for (const r of filtered as any[]) {
      const key = r.payeeKey || `n:${r.payeeName}`;
      has.set(key, (has.get(key) || false) || !!r.residentNumberMasked);
    }
    return [...has.values()].filter((v) => !v).length;
  }, [filtered]);

  // Excel — 주민번호 전체값 필요 → reveal=1로 재조회(권한 없으면 서버가 마스킹만 반환). 화면과 동일 필터 적용.
  const exportExcel = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const params = new URLSearchParams({ reveal: '1' });
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const res = await fetch(api(`/api/admin/tax-report?${params.toString()}`), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? 'Excel 조회 실패'); return; }
      const kw = q.trim().toLowerCase();
      const exRows: TaxReportRow[] = (Array.isArray(data.rows) ? data.rows : [])
        .filter((r: any) => region === 'all' ? true : r.region === region)
        .filter((r: any) => !kw || (r.payeeName ?? '').toLowerCase().includes(kw));
      if (exRows.length === 0) { onToast('내보낼 데이터가 없습니다.'); return; }
      const periodTag = `${dateFrom || '전체'}_${dateTo || '전체'}`.replace(/[\\/:*?"<>|\s]+/g, '');
      downloadTaxReportExcel({ filename: `세무자료_${periodTag}_${todayStamp()}.xlsx`, rows: exRows, masked: !data.revealed });
      onToast(data.revealed ? '세무자료 Excel을 다운로드했습니다. (주민번호 전체값 포함)' : '세무자료 Excel을 다운로드했습니다. (주민번호 마스킹 — 전체값 권한 없음)');
    } catch { onToast('Excel 생성 중 오류'); } finally { setDownloading(false); }
  };

  const filterActive = !!dateFrom || !!dateTo || q.trim() !== '' || region !== 'all';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      {/* ── 조회조건 ── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: SP[4], flexWrap: 'wrap' }}>
          <span style={{ ...TYPO.sectionTitle, alignSelf: 'center' }}>세무자료</span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>지급기간</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="date" style={{ ...inp, width: 152 }} value={dateFrom} max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)} data-testid="tax-filter-from" aria-label="지급기간 시작" />
              <span style={{ color: C.textSecondary }}>~</span>
              <input type="date" style={{ ...inp, width: 152 }} value={dateTo} min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)} data-testid="tax-filter-to" aria-label="지급기간 종료" />
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>지급대상 검색</span>
            <input style={{ ...inp, width: 200 }} value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="통역사명" data-testid="tax-filter-q" aria-label="지급대상 검색" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>국내/해외 구분</span>
            <div style={{ width: 150 }}>
              <ClickSelect value={region} onChange={(v: string) => setRegion((v || 'all') as any)} triggerStyle={inp}
                options={[{ value: 'all', label: '전체' }, { value: 'domestic', label: '국내(원천징수)' }, { value: 'overseas', label: '해외' }]} />
            </div>
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {filterActive && (
              <GhostBtn onClick={() => { setDateFrom(''); setDateTo(''); setQ(''); setRegion('all'); }}
                style={{ fontSize: 12, padding: '7px 14px' }} data-testid="tax-filter-reset" aria-label="필터 초기화">필터 초기화</GhostBtn>
            )}
            <PrimaryBtn onClick={exportExcel} disabled={downloading || filtered.length === 0}
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
      {!loading && !error && (
        <div style={{ display: 'flex', gap: SP[4], alignItems: 'center', flexWrap: 'wrap', padding: `${SP[2]}px ${SP[3]}px`, background: C.g50, borderRadius: 8, ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ ...TYPO.helper, fontWeight: 700 }}>조회 결과</span>
          <span>건수 <b>{filtered.length}건</b></span>
          <span>세전 <b>{won(totals.pretax)}원</b></span>
          <span>세후 <b style={{ color: C.primaryText }}>{won(totals.posttax)}원</b></span>
          <span>해외송금 <b>{won(totals.overseas)}원</b></span>
          <span style={{ marginLeft: 'auto' }}>주민번호 미등록 <b style={{ color: missingRrn > 0 ? C.danger : C.textSecondary }}>{missingRrn}명</b></span>
        </div>
      )}

      {loading && <Card style={{ padding: 32, textAlign: 'center', color: C.g400 }}>불러오는 중…</Card>}
      {!loading && error && (
        <Card style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ color: C.danger, fontWeight: 700, marginBottom: 10 }}>⚠ {error}</div>
          <GhostBtn onClick={fetchRows} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="tax-retry">다시 시도</GhostBtn>
        </Card>
      )}

      {/* ── 목록 ── */}
      {!loading && !error && (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1100 }}>
              <thead><tr>
                <th style={th}>지급일</th><th style={th}>통역사명</th><th style={th}>주민번호</th><th style={th}>언어</th>
                <th style={{ ...th, textAlign: 'right' }}>지급액(세전)</th><th style={{ ...th, textAlign: 'right' }}>지급액(세후)</th>
                <th style={{ ...th, textAlign: 'right' }}>해외 현지 송금건</th><th style={th}>비고</th>
              </tr></thead>
              <tbody>
                {filtered.length === 0 && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }}>{filterActive ? '조건에 맞는 지급자료가 없습니다.' : '조회된 지급자료가 없습니다.'}</td></tr>}
                {filtered.map((r, i) => (
                  <tr key={i}>
                    <td style={td}>{r.payDate || '-'}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{r.payeeName}</td>
                    <td style={{ ...td, color: C.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{r.residentNumberMasked || '-'}</td>
                    <td style={td}>{r.language || '-'}</td>
                    <td style={tdR}>{amt(r.pretax)}</td>
                    <td style={{ ...tdR, fontWeight: 700, color: r.posttax != null ? C.primaryText : undefined }}>{amt(r.posttax)}</td>
                    <td style={{ ...tdR, color: r.overseasAmount != null ? '#b45309' : undefined }}>{amt(r.overseasAmount)}</td>
                    <td style={{ ...td, whiteSpace: 'normal', color: C.textSecondary, maxWidth: 280 }}>{r.note || '-'}</td>
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
