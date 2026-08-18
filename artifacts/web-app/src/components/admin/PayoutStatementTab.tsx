// ─────────────────────────────────────────────────────────────────────────────
// 지급명세서(정산 · 조회 전용 독립 화면) — 재무→정산→지급명세서.
//  · 기존 지급회차 화면(PayoutRoundsTab)의 [지급명세서] 버튼이 열던 기능을 독립 페이지로 분리.
//  · 조회 기준(지급회차 선택 + 거래처·지급대상·지급일 필터)은 지급회차 화면과 동일하게 유지한다.
//  · 데이터·계산은 서버(payout-rounds API)가 산출한 값을 그대로 사용한다(재계산·상태변경 없음).
//  · 지급대상 목록·명세서 보기·Excel 등은 PayoutStatementModal(inline)을 그대로 재사용한다.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, ClickSelect } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';
import PayoutStatementModal from './PayoutStatementModal';

const dateVal = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
// 재집계용 안전 수치 변환(NaN·null → 0). 건별 서버 계산값을 그대로 합산할 뿐 계산식은 불변.
const numOf = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

const ROUND_STATUS_LABEL: Record<string, string> = {
  draft: '작성 중', reviewing: '검토 중', confirmed: '지급 확정', paid: '지급 완료', cancelled: '취소',
};

interface Props { token: string; onToast: (m: string) => void; }

export default function PayoutStatementTab({ token, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [rounds, setRounds] = useState<any[]>([]);
  // 조회 범위: 'all'(전체 지급대상·기본) | 'unassigned'(미배정) | 회차 id 문자열.
  const [sel, setSel] = useState<string>('all');
  const [detail, setDetail] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // ── 조회 필터 — 거래처 / 지급대상 검색 / 지급일 기간(지급회차 화면과 동일 조건). ──
  const [custFilter, setCustFilter] = useState<string>('all');
  const [payeeQ, setPayeeQ] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 32, padding: '5px 9px', width: '100%' };

  const loadRounds = useCallback(async () => {
    try {
      const res = await fetch(api('/api/admin/payout-rounds'), { headers: authH });
      const data = await res.json().catch(() => ({}));
      setRounds(data.rows ?? []);
    } catch { onToast('지급회차 목록 조회 실패'); }
  }, [token]);

  // 전체 지급대상(개요) / 미배정 / 특정 회차 — 선택값에 따라 조회 소스 분기.
  const loadDetail = useCallback(async (s: string) => {
    const url = s === 'all' ? '/api/admin/payout-rounds/overview'
      : s === 'unassigned' ? '/api/admin/payout-rounds/overview?scope=unassigned'
      : `/api/admin/payout-rounds/${s}`;
    setLoading(true); setError(null);
    try {
      const res = await fetch(api(url), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error ?? `조회 실패 (HTTP ${res.status})`;
        setError(msg); setDetail(null); onToast(msg); return;
      }
      setDetail(data);
    } catch {
      setError('조회 중 오류가 발생했습니다. 네트워크 또는 서버 상태를 확인하세요.');
      setDetail(null); onToast('조회 중 오류');
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { loadRounds(); }, [loadRounds]);
  useEffect(() => { loadDetail(sel); }, [sel, loadDetail]);
  // 회차 전환 시: 거래처 필터 초기화(회차마다 거래처 목록이 다름). 지급대상 검색·지급일은 회차 독립이라 유지.
  useEffect(() => { setCustFilter('all'); }, [sel]);

  const round = detail?.round;
  const filterActive = custFilter !== 'all' || payeeQ.trim() !== '' || !!dateFrom || !!dateTo;
  // 거래처 후보 — 현재 로드된 회차/개요의 실제 거래처만(회차 변경 시 자동 갱신).
  const customerOptions = useMemo(() => {
    const s = new Set<string>();
    (detail?.summary ?? []).forEach((g: any) => g.items.forEach((it: any) => { if (it.customerName) s.add(it.customerName); }));
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [detail]);

  // ── 필터 적용된 지급대상 그룹 — 서버 그룹 위에 건별만 필터 후 수치·건수만 재집계(계산식 불변). ──
  const filteredSummary: any[] = useMemo(() => {
    const q = payeeQ.trim().toLowerCase();
    const itemOk = (it: any) => {
      if (custFilter !== 'all' && (it.customerName || '') !== custFilter) return false;
      const d = it.expectedPaymentDate ? String(it.expectedPaymentDate).slice(0, 10) : '';
      if (dateFrom && (!d || d < dateFrom)) return false;
      if (dateTo && (!d || d > dateTo)) return false;
      return true;
    };
    return (detail?.summary ?? [])
      .filter((g: any) => !q || (g.payeeName || '').toLowerCase().includes(q))
      .map((g: any) => {
        const items = g.items.filter(itemOk);
        let count = 0, tC = 0, iC = 0, eC = 0, base = 0, exp = 0, ded = 0, gross = 0, wh = 0, vat = 0, net = 0, allVat = true;
        for (const it of items) {
          count++;
          if (it.serviceType === 'translation') tC++;
          else if (it.serviceType === 'interpretation') iC++;
          else eC++;
          base += numOf(it.basePerformanceFee); exp += numOf(it.expenseTotal); ded += numOf(it.deductionTotal);
          gross += numOf(it.gross); wh += numOf(it.withholdingTax); vat += numOf(it.vat); net += numOf(it.netPayment);
          if (!it.isVatIncluded) allVat = false;
        }
        return { ...g, items, count, translationCount: tC, interpretationCount: iC, equipmentEtcCount: eC,
          baseTotal: base, expenseTotal: exp, deductionTotal: ded, grossTotal: gross, withholdingTotal: wh, vatTotal: vat, netTotal: net,
          isVatIncluded: g.payeeType === 'vendor' && items.length > 0 && allVat };
      })
      .filter((g: any) => g.items.length > 0);
  }, [detail, custFilter, payeeQ, dateFrom, dateTo]);

  const scopeLabel = round ? undefined : (sel === 'unassigned' ? '미배정 지급대상' : '전체 지급회차');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      {/* ── 조회 기준: 지급회차 선택 ── */}
      {/*  · 특정 회차 선택 시 서버가 확정 회차는 snapshot(payout_round_items) 기준으로 반환 → 재계산 없음. */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: SP[4], flexWrap: 'wrap' }}>
          <span style={{ ...TYPO.sectionTitle, alignSelf: 'center' }}>지급명세서</span>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>지급회차</span>
            <div style={{ width: 340 }}>
              <ClickSelect value={sel} onChange={(v: string) => setSel(v || 'all')}
                triggerStyle={inp}
                options={[
                  { value: 'all', label: '전체 지급회차' },
                  { value: 'unassigned', label: '미배정' },
                  ...rounds.map(r => ({ value: String(r.id), label: `${r.batchNumber || dateVal(r.paymentDate)} · ${ROUND_STATUS_LABEL[r.status] ?? r.status} · ${r.totalAssignments ?? 0}건` })),
                ]} data-testid="statement-round-filter" aria-label="지급회차 선택" />
            </div>
          </label>
          {round && (
            <span style={{ ...TYPO.helper, color: C.textSecondary, alignSelf: 'center' }}>
              {detail?.snapshotSource === 'snapshot' ? '확정 스냅샷 기준' : detail?.snapshotSource === 'live_legacy' ? '레거시(확정 당시 미보존) — 원본 기준' : '작성중 · 실시간'}
            </span>
          )}
        </div>
      </Card>

      {/* ── 조회 필터 — 거래처 · 지급대상 검색 · 지급일 기간(지급회차 화면과 동일). ── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: SP[4], flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>거래처</span>
            <div style={{ width: 220 }}>
              <ClickSelect value={custFilter} onChange={(v: string) => setCustFilter(v || 'all')} triggerStyle={inp}
                options={[{ value: 'all', label: '전체 거래처' }, ...customerOptions.map((c) => ({ value: c, label: c }))]} />
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>지급대상 검색</span>
            <input style={{ ...inp, width: 200 }} value={payeeQ} onChange={(e) => setPayeeQ(e.target.value)}
              placeholder="통번역사·외주업체명" data-testid="statement-filter-payee" aria-label="지급대상 검색" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>지급일</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="date" style={{ ...inp, width: 152 }} value={dateFrom} max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)} data-testid="statement-filter-from" aria-label="지급일 시작" />
              <span style={{ color: C.textSecondary }}>~</span>
              <input type="date" style={{ ...inp, width: 152 }} value={dateTo} min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)} data-testid="statement-filter-to" aria-label="지급일 종료" />
            </div>
          </label>
          {filterActive && (
            <GhostBtn onClick={() => { setCustFilter('all'); setPayeeQ(''); setDateFrom(''); setDateTo(''); }}
              style={{ fontSize: 12, padding: '7px 14px' }} data-testid="statement-filter-reset" aria-label="필터 초기화">필터 초기화</GhostBtn>
          )}
        </div>
      </Card>

      {loading && <Card style={{ padding: 32, textAlign: 'center', color: C.g400 }}>불러오는 중…</Card>}
      {!loading && error && (
        <Card style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ color: C.danger, fontWeight: 700, marginBottom: 10 }}>⚠ {error}</div>
          <GhostBtn onClick={() => loadDetail(sel)} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="statement-retry">다시 시도</GhostBtn>
        </Card>
      )}

      {/* ── 지급대상 목록 · 명세서 보기 — 기존 지급명세서 기능을 그대로 재사용(inline). ── */}
      {!loading && !error && detail && (
        <PayoutStatementModal inline round={round ?? null} summary={filteredSummary}
          snapshotSource={detail?.snapshotSource} scopeLabel={scopeLabel} onToast={onToast} />
      )}
    </div>
  );
}
