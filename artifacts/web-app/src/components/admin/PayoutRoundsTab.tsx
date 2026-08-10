// ─────────────────────────────────────────────────────────────────────────────
// 지급회차 관리(정산 Phase 1) — 재무→정산 메인 화면.
//  · 수행정보 미지급 건을 지급일별 회차로 묶어 지급대상(개인/외주)별 자동합산·검토·확정.
//  · 계산은 서버(payoutRounds API)가 costTotal+세금처리로 산출. 화면은 표시·조작만.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';

const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString('ko-KR');
const dateVal = (v?: string | null) => (v ? String(v).slice(0, 10) : '');

const ROUND_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft:     { label: '작성 중',  color: '#6b7280', bg: '#f3f4f6' },
  reviewing: { label: '검토 중',  color: '#b45309', bg: '#fffbeb' },
  confirmed: { label: '지급 확정', color: '#047857', bg: '#ecfdf5' },
  paid:      { label: '지급 완료', color: '#1d4ed8', bg: '#eff6ff' },
  cancelled: { label: '취소',     color: '#dc2626', bg: '#fef2f2' },
};
const TREATMENT_LABEL: Record<string, string> = {
  domestic_3_3: '3.3%', exempt: '원천징수 예외',
  nonresident_custom: '비거주자', treaty_reduction_or_exemption: '조세조약', tax_review_required: '세무확인 필요',
};
// 외주 매입 증빙유형 → 세금처리 표시. 미설정(null)·tax_invoice는 외주 기본 '세금계산서'(§3·§7①).
const VENDOR_EVIDENCE_LABEL: Record<string, string> = {
  tax_invoice: '세금계산서', zero_rate_tax_invoice: '영세율 세금계산서', invoice: '계산서', other: '기타 증빙', none: '세무확인 필요',
};
// 세금처리 표시 — 요약/상세/지급명세서/PDF/Excel 공통 단일 기준(§2·§5).
//  · 외주(vendor): 매입 증빙유형 기준. 미설정이면 세금계산서(운영 기본). withholdingTreatment(원천)는 사용하지 않는다.
//  · 개인(individual): 원천 처리구분 기준. 값이 있으면 그 라벨, 없으면(NULL) '세무확인 필요'(§4).
function taxTreatmentLabel(x: { payeeType?: string | null; performerCategory?: string | null; withholdingTreatment?: string | null; purchaseEvidenceType?: string | null }): string {
  const isVendor = (x.payeeType ?? x.performerCategory) === 'vendor';
  if (isVendor) return x.purchaseEvidenceType ? (VENDOR_EVIDENCE_LABEL[x.purchaseEvidenceType] ?? '세금계산서') : '세금계산서';
  return x.withholdingTreatment ? (TREATMENT_LABEL[x.withholdingTreatment] ?? '세무확인 필요') : '세무확인 필요';
}
// 지급대상(그룹) 세금처리 — 하위 건들의 표시값이 모두 같으면 그 값, 다르면 null(혼재).
function groupTaxTreatmentLabel(g: { items?: any[]; payeeType?: string; treatments?: string[] }): string | null {
  const items = g.items ?? [];
  if (items.length === 0) return taxTreatmentLabel({ payeeType: g.payeeType, withholdingTreatment: g.treatments?.[0] ?? null });
  const labels = new Set(items.map(taxTreatmentLabel));
  return labels.size === 1 ? [...labels][0] : null;
}
const HOLD_REASONS = ['납품확인 필요', '계좌정보 미확인', '세금처리 확인 필요', '고객 클레임', '금액 재검토', '기타'];

// 지급예정일 → 대상기간 자동 제안(§6). 15일 지급→전월 16~말일 / 말일 지급→당월 1~15. 편집 가능.
function suggestPeriod(paymentDate: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(paymentDate);
  if (!m) return { start: '', end: '' };
  const y = +m[1], mo = +m[2], d = +m[3];
  const p2 = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d >= lastDay - 1) return { start: `${y}-${p2(mo)}-01`, end: `${y}-${p2(mo)}-15` };
  let py = y, pm = mo - 1; if (pm < 1) { pm = 12; py -= 1; }
  const pLast = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return { start: `${py}-${p2(pm)}-16`, end: `${py}-${p2(pm)}-${p2(pLast)}` };
}

interface Props { token: string; onToast: (m: string) => void; }

export default function PayoutRoundsTab({ token, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [rounds, setRounds] = useState<any[]>([]);
  // 선택값(§6): 'all'(전체 지급대상·기본) | 'unassigned'(미배정) | 회차 id 문자열.
  // selId 는 "실제 회차"가 선택됐을 때만 숫자 — 회차 전용 액션(확정/완료/제외 등)은 이 값으로만 동작.
  const [sel, setSel] = useState<string>('all');
  const selId = /^\d+$/.test(sel) ? Number(sel) : null;
  const [detail, setDetail] = useState<any | null>(null);
  // 조회 상태 명확 구분(§14): loading / error / (empty·data 는 detail 기준 하위 렌더).
  // 이전 구조는 fetch 실패 시 detail 이 계속 null → 「불러오는 중…」에 영구히 갇히는 결함이 있었다.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'summary' | 'items'>('summary');
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showWarn, setShowWarn] = useState(false);
  const [holdFor, setHoldFor] = useState<{ id: number; name: string } | null>(null);
  const [holdReason, setHoldReason] = useState('');

  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 32, padding: '5px 9px', width: '100%' };
  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '8px 10px', borderBottom: BD.grid, whiteSpace: 'nowrap', textAlign: 'left', background: C.g50 };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '8px 10px', borderBottom: BD.divider, whiteSpace: 'nowrap' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  const loadRounds = useCallback(async () => {
    try {
      const res = await fetch(api('/api/admin/payout-rounds'), { headers: authH });
      const data = await res.json().catch(() => ({}));
      const rows = data.rows ?? [];
      setRounds(rows);   // 기본값은 '전체 지급대상' — 회차를 자동선택하지 않는다(§1·§6).
    } catch { onToast('지급회차 목록 조회 실패'); }
  }, [token]);

  // 전체 지급대상(개요) / 미배정 / 특정 회차 — 선택값에 따라 조회 소스 분기(§1·§6).
  const loadDetail = useCallback(async (s: string) => {
    const url = s === 'all' ? '/api/admin/payout-rounds/overview'
      : s === 'unassigned' ? '/api/admin/payout-rounds/overview?scope=unassigned'
      : `/api/admin/payout-rounds/${s}`;
    setLoading(true); setError(null);
    try {
      const res = await fetch(api(url), { headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 서버 미배포(구버전 → /overview 404)·권한·서버오류 등을 화면에 명시(무한 로딩 방지).
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

  const round = detail?.round;
  const summary: any[] = detail?.summary ?? [];
  const totals = detail?.totals ?? {};
  const warnings = detail?.warnings ?? { total: 0, holdAmount: 0, byReason: [] };
  const collectable: any[] = detail?.collectable ?? [];
  const locked = round && (round.status === 'confirmed' || round.status === 'paid' || round.status === 'cancelled');
  // 전체 지급대상(개요) 모드 — 회차가 선택되지 않았고 데이터가 로드된 상태(§1). 건별 조치는 회차 선택 시만 가능.
  const isOverview = !!detail && !round;
  const overviewInfo = detail?.overview ?? null;
  const showActions = !!round && !locked;   // 제외/이월/보류는 특정 회차(편집가능)에서만
  // (VAT별도) 표시는 서버 공통계산(calcPayoutWithholding)이 내려준 isVatIncluded 값만 사용한다.
  //  · 화면에서 purchaseEvidenceType 을 다시 판정하지 않는다 — 계산·표시 기준을 단일화(§9).
  //  · isVatIncluded=true 는 외주 세금계산서(tax_invoice)로 실지급액에 VAT가 포함된 건. (표시 전용)
  const vatTag = (cond: boolean) => cond ? <span style={{ fontSize: 10, color: C.textSecondary, fontWeight: 400 }}> (VAT별도)</span> : null;
  // 세전 금액 셀 — 숫자는 우측 정렬(고정 안쪽 여백 기준)으로 끝자리 X축을 통일하고, (VAT별도)는
  //  별도 span으로 예약된 우측 영역에 절대배치 → 숫자 위치에 영향 없음(§3·§4·§6). 요약·상세 공용.
  const grossCell = (amount: number, showVat: boolean, strong = false) => (
    <td style={{ ...tdR, position: 'relative', paddingRight: 58, fontWeight: strong ? 700 : (tdR.fontWeight as any) }}>
      {won(amount)}
      {showVat && <span style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: C.textSecondary, fontWeight: 400, whiteSpace: 'nowrap' }}>(VAT별도)</span>}
    </td>
  );
  // 추가비용·차감 세부항목을 한 줄 인라인 문자열로(합계 없이). 항목명(type)·금액(amount)을 그대로 출력(§4·§5·§7).
  const inlineItems = (arr: { type: string; amount: number }[] | undefined) =>
    arr && arr.length ? arr.map(x => `${x.type} ${won(x.amount)}`).join(' · ') : '—';

  // ── 건별 상세 16컬럼 표시 헬퍼 (표시 전용 — 원본 데이터 매핑, 계산 없음) ──
  // 수행일: 시작~종료. 같은 연도면 종료는 MM-DD, 연도 다르면 전체 표시(§3). 단일이면 하나, 없으면 '-'.
  //  · 납품일을 대신 쓰지 않음 — 번역처럼 수행일 원본이 없으면 '-' 유지(§3·§12).
  const perfDate = (it: any) => {
    const s = dateVal(it.performanceStartDate), e = dateVal(it.performanceEndDate);
    if (s && e && e !== s) return s.slice(0, 4) === e.slice(0, 4) ? `${s}~${e.slice(5)}` : `${s}~${e}`;
    return s || e || '-';
  };
  // 작업량: 기존 수행정보 UI(performanceServiceDetail) 표시 원칙을 재사용(§2·§4). 없는 데이터는 '-'(§12).
  //  · 번역/감수: 실제 정산 작업량 = 단어수(우선)/글자수. 페이지수(quantity)는 판매값이라 미사용.
  //  · 통역: 수행일수 × 인원(interpreterCount명). basefee=일수×단가, 인원은 설명값.
  //  · 장비/기타: 수량+단위(수량×단가=기본수행료로 정합).
  const nfmt = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(v); };
  const workAmount = (it: any) => {
    const d = it.serviceDetail || {};
    const svc = it.serviceType;
    if (svc === 'translation' || svc === 'review') {
      if (d.wordCount != null && d.wordCount !== '') return `${nfmt(d.wordCount)}단어`;
      if (d.charCount != null && d.charCount !== '') return `${nfmt(d.charCount)}글자`;
      return '-';
    }
    if (it.quantity == null || Number(it.quantity) === 0) return '-';
    const base = `${nfmt(it.quantity)}${it.unit ?? ''}`;
    if (svc === 'interpretation' && d.interpreterCount) return `${base} × ${nfmt(d.interpreterCount)}명`;
    return base;
  };
  // 단가: 계약단가(원가단가, §5). 판매단가 미사용. 직접입력·단가없음이면 '-'(§8).
  const unitPrice = (it: any) =>
    it.isDirectAmount || it.contractUnitPrice == null ? '-' : won(it.contractUnitPrice);
  // 지급회차: 배정된 회차명(없으면 '미배정', §16)
  const roundLabel = (it: any) => it.payoutRoundId
    ? (it.roundBatchNumber || dateVal(it.roundPaymentDate) || `#${it.payoutRoundId}`)
    : null;

  // 회차 저장(제외/보류/재포함 changes 전송) — 서버가 재계산·재조회 반환
  const applyChanges = async (changes: any[], okMsg?: string) => {
    if (!selId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${selId}`), { method: 'PATCH', headers: authH, body: JSON.stringify({ changes }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '저장 실패'); return; }
      setDetail(data);
      await loadRounds();
      if (okMsg) onToast(okMsg);
    } catch { onToast('저장 중 오류'); } finally { setBusy(false); }
  };

  const excludeItem = (id: number) => applyChanges([{ assignmentId: id, action: 'exclude' }], '이번 회차에서 제외했습니다.');
  const carryOverItem = (id: number) => applyChanges([{ assignmentId: id, action: 'exclude' }], '다음 회차로 이월했습니다.');
  const includeItem = (id: number) => applyChanges([{ assignmentId: id, action: 'include' }], '이번 회차에 포함했습니다.');
  const unholdItem = (id: number) => applyChanges([{ assignmentId: id, action: 'unhold' }], '지급보류를 해제했습니다. (미지급)');
  const confirmHold = () => {
    if (!holdFor) return;
    if (!holdReason.trim()) { onToast('지급보류 사유를 입력하세요.'); return; }
    applyChanges([{ assignmentId: holdFor.id, action: 'hold', holdReason: holdReason.trim() }], '지급보류 처리했습니다.');
    setHoldFor(null); setHoldReason('');
  };

  const confirmRound = async () => {
    if (!selId || busy) return;
    if (!window.confirm('이 회차를 지급확정할까요?\n확정 후에는 관리자만 수정할 수 있습니다.')) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${selId}/confirm`), { method: 'PATCH', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '지급확정 실패'); return; }
      setDetail(data); await loadRounds(); onToast('지급확정되었습니다.');
    } catch { onToast('지급확정 중 오류'); } finally { setBusy(false); }
  };

  // 지급완료 처리 — 확정된 회차의 정상 지급대상(지급보류 제외)을 지급완료(paid)로 전환.
  const payRound = async () => {
    if (!selId || busy) return;
    if (!window.confirm('이 회차를 지급완료 처리할까요?\n지급보류 건을 제외한 지급대상의 지급상태가 "지급완료"로 변경됩니다.\n(수행정보에서는 되돌릴 수 없습니다)')) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${selId}/pay`), { method: 'PATCH', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '지급완료 처리 실패'); return; }
      setDetail(data); await loadRounds(); onToast('지급완료 처리되었습니다.');
    } catch { onToast('지급완료 처리 중 오류'); } finally { setBusy(false); }
  };

  // 지급대상 다시 수집(전체 동기화) — Draft 회차만. 신규 편입·금액 반영·완료/보류/삭제 제외 후 결과 안내.
  const recollectRound = async () => {
    if (!selId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${selId}/recollect`), { method: 'PATCH', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '다시 수집 실패'); return; }
      setDetail(data); await loadRounds();
      const r = data.recollect ?? { added: 0, removed: 0, changed: 0 };
      onToast(`다시 수집 완료 — 새 수행건 ${r.added}건 추가 · 기존 ${r.changed}건 금액 변경 · 삭제 ${r.removed}건`);
    } catch { onToast('다시 수집 중 오류'); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      {/* ── 상단: 회차 선택 + 생성 + 확정 ── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
          <span style={{ ...TYPO.sectionTitle }}>지급회차</span>
          <div style={{ width: 300 }}>
            <ClickSelect value={sel} onChange={(v: string) => setSel(v || 'all')}
              triggerStyle={inp}
              options={[
                { value: 'all', label: '전체 지급대상' },
                { value: 'unassigned', label: '미배정' },
                ...rounds.map(r => ({ value: String(r.id), label: `${r.batchNumber || dateVal(r.paymentDate)} · ${ROUND_STATUS[r.status]?.label ?? r.status} · ${r.totalAssignments ?? 0}건` })),
              ]} />
          </div>
          <PrimaryBtn onClick={() => setShowCreate(true)} style={{ fontSize: 12, padding: '7px 14px' }} data-testid="payout-create" aria-label="지급회차 생성">+ 지급회차 생성</PrimaryBtn>
          {/* §7 지급명세서 출력 — 다음 Phase 구현. 현재는 배치만(준비중·Disabled). */}
          {round && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" disabled title="다음 단계에서 구현 예정" data-testid="payout-pdf" aria-label="지급명세서 PDF (준비중)"
                style={{ fontSize: 12, padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.g300}`, background: C.g50, color: C.g400, cursor: 'not-allowed' }}>📄 지급명세서 PDF <span style={{ fontSize: 10 }}>(준비중)</span></button>
              <button type="button" disabled title="다음 단계에서 구현 예정" data-testid="payout-excel" aria-label="지급명세서 Excel (준비중)"
                style={{ fontSize: 12, padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.g300}`, background: C.g50, color: C.g400, cursor: 'not-allowed' }}>📊 지급명세서 Excel <span style={{ fontSize: 10 }}>(준비중)</span></button>
            </div>
          )}
        </div>
      </Card>

      {/* 상태 명확 구분(§14): LOADING / ERROR. EMPTY·DATA 는 아래 detail 기준으로 렌더. */}
      {loading && <Card style={{ padding: 32, textAlign: 'center', color: C.g400 }}>불러오는 중…</Card>}
      {!loading && error && (
        <Card style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ color: C.danger, fontWeight: 700, marginBottom: 10 }}>⚠ {error}</div>
          <GhostBtn onClick={() => loadDetail(sel)} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="payout-retry">다시 시도</GhostBtn>
        </Card>
      )}

      {/* ── 전체 지급대상 개요 요약바(§13) — 회차 미선택 시. 진입 즉시 지급대상 전체가 보인다(§1·§9). ── */}
      {!loading && !error && isOverview && (
        <Card>
          <div style={{ display: 'flex', gap: SP[5], alignItems: 'center', flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
            <b style={{ fontSize: 15 }}>{sel === 'unassigned' ? '미배정 지급대상' : '전체 지급대상'}</b>
            <span>총 지급대상 <b>{totals.payees ?? 0}명</b> (개인 {totals.individualCount ?? 0} · 외주 {totals.vendorCount ?? 0})</span>
            <span>총 수행건 <b>{totals.assignments ?? 0}건</b></span>
            <span>미배정 <b style={{ color: (overviewInfo?.unassignedCount ?? 0) > 0 ? C.danger : C.textSecondary }}>{overviewInfo?.unassignedCount ?? 0}건</b></span>
            <span>총 실지급 <b style={{ color: C.primaryText }}>{won(totals.netTotal)}원</b></span>
          </div>
        </Card>
      )}

      {/* ── 회차 요약바(§2·§14) — 특정 회차 선택 시만 표시 ── */}
      {!loading && !error && round && (
          <Card>
            <div style={{ display: 'flex', gap: SP[3], alignItems: 'center', flexWrap: 'wrap', marginBottom: SP[3] }}>
              <b style={{ ...TYPO.inputValue, fontSize: 15 }}>{round.batchNumber || `${dateVal(round.paymentDate)} 지급회차`}</b>
              <span style={{ ...TYPO.badge, color: ROUND_STATUS[round.status]?.color, background: ROUND_STATUS[round.status]?.bg, padding: '3px 9px', borderRadius: 6, fontWeight: 700 }}>{ROUND_STATUS[round.status]?.label ?? round.status}</span>
              <span style={{ ...TYPO.helper }}>지급예정일 <b>{dateVal(round.paymentDate)}</b></span>
              <span style={{ ...TYPO.helper }}>대상기간 <b>{dateVal(round.periodStart)} ~ {dateVal(round.periodEnd)}</b></span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* 전체 동기화 — Draft 회차에서만. 확정/완료/취소 회차는 숨김(§5). 개별 [포함]과 역할 분리(§6). */}
                {round.status === 'draft' && (
                  <button type="button" onClick={recollectRound} disabled={busy} data-testid="payout-recollect" aria-label="지급대상 다시 수집"
                    style={{ ...TYPO.helper, color: C.primaryText, background: C.primaryBg, border: `1px solid ${C.primaryBorder}`, borderRadius: 6, padding: '4px 10px', cursor: busy ? 'not-allowed' : 'pointer', fontWeight: 700 }}>
                    🔄 지급대상 다시 수집
                  </button>
                )}
                {warnings.total > 0 && (
                  <button type="button" onClick={() => setShowWarn(true)} data-testid="payout-warnings"
                    style={{ ...TYPO.helper, color: C.danger, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 700 }}>
                    ⚠ 제외·확인 필요 {warnings.total}건
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: SP[5], flexWrap: 'wrap', padding: `${SP[3]}px ${SP[4]}px`, background: C.primaryBg, borderRadius: 8, ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
              <span>대상 건수 <b>{totals.assignments ?? 0}건</b></span>
              <span>지급대상 <b>{totals.payees ?? 0}</b> (개인 {totals.individualCount ?? 0} · 외주 {totals.vendorCount ?? 0})</span>
              <span>총 세전 <b>{won(totals.grossTotal)}원</b></span>
              <span>총 공제 <b style={{ color: C.danger }}>{won(totals.withholdingTotal)}원</b></span>
              <span>총 실지급 <b style={{ color: C.primaryText }}>{won(totals.netTotal)}원</b></span>
              {warnings.holdAmount > 0 && <span>지급보류 <b style={{ color: '#b45309' }}>{won(warnings.holdAmount)}원</b></span>}
            </div>
          </Card>
      )}

      {/* ── 지급대상별 요약 / 건별 상세내역 — 회차·개요 공용, 진입 즉시 표시(§1·§4·§5) ── */}
      {!loading && !error && detail && (
        <>
          {/* ── 보기 전환 ── */}
          <div style={{ display: 'flex', gap: 6 }}>
            {(['summary', 'items'] as const).map(v => (
              <button key={v} type="button" onClick={() => setView(v)} data-testid={`payout-view-${v}`}
                style={{ fontSize: 12, padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, border: `1px solid ${view === v ? C.primaryText : C.g300}`, background: view === v ? C.primaryBg : C.bgCard, color: view === v ? C.primaryText : C.textSecondary }}>
                {v === 'summary' ? '지급대상별 요약' : '건별 상세내역'}
              </button>
            ))}
          </div>

          {/* ── 지급대상별 요약(§10) ── */}
          {view === 'summary' && (
            <Card>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1100 }}>
                  <thead><tr>
                    <th style={th}>지급대상</th><th style={th}>구분</th>
                    <th style={{ ...th, textAlign: 'right' }}>건수</th><th style={{ ...th, textAlign: 'right' }}>번역</th><th style={{ ...th, textAlign: 'right' }}>통역</th><th style={{ ...th, textAlign: 'right' }}>장비·외주</th>
                    <th style={{ ...th, textAlign: 'right' }}>기본수행료</th><th style={{ ...th, textAlign: 'right' }}>추가비용</th><th style={{ ...th, textAlign: 'right' }}>차감</th>
                    <th style={{ ...th, textAlign: 'right' }}>세전</th><th style={th}>세금처리</th><th style={{ ...th, textAlign: 'right' }}>공제</th><th style={{ ...th, textAlign: 'right' }}>실지급</th>
                  </tr></thead>
                  <tbody>
                    {summary.length === 0 && <tr><td colSpan={13} style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }}>수집된 지급대상이 없습니다.</td></tr>}
                    {/* 집계 전용 — 펼침 없음. 건별 근거·세부내역은 '건별 상세내역' 탭에서 확인(§1·§2). */}
                    {summary.map((g) => (
                      <tr key={g.payeeKey}>
                        <td style={{ ...td, fontWeight: 700 }}>{g.payeeName}</td>
                        <td style={td}>{g.payeeType === 'individual' ? '통번역사' : '외주업체'}</td>
                        <td style={tdR}>{g.count}건</td><td style={tdR}>{g.translationCount}</td><td style={tdR}>{g.interpretationCount}</td><td style={tdR}>{g.equipmentEtcCount}</td>
                        <td style={tdR}>{won(g.baseTotal)}</td><td style={tdR}>{won(g.expenseTotal)}</td><td style={tdR}>{won(g.deductionTotal)}</td>
                        {grossCell(g.grossTotal, !!g.isVatIncluded, true)}
                        <td style={td}>
                          {(() => { const lbl = groupTaxTreatmentLabel(g); return lbl === null
                            ? <span style={{ color: C.danger, fontWeight: 700 }} title="서로 다른 세금처리 혼재 — 건별 확인 필요">⚠ 혼재</span>
                            : lbl; })()}
                        </td>
                        <td style={{ ...tdR, color: C.danger }}>{won(g.withholdingTotal)}</td>
                        <td style={{ ...tdR, fontWeight: 800, color: C.primaryText }}>{won(g.netTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* ── 건별 상세내역(§3·§4·§5) — 지급명세서 원본. 한 건당 한 줄. 추가비용·차감은 항목 인라인(합계 없음). ── */}
          {view === 'items' && (
            <Card>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1820 }}>
                  <thead><tr>
                    {/* 17개 컬럼(§1) — 날짜 흐름 수행일→납품일→지급일. 조치는 회차 편집 모드에서만 후행 표시 */}
                    <th style={th}>지급대상</th><th style={th}>거래처</th><th style={th}>상품·업무</th><th style={th}>구분</th>
                    <th style={th}>수행일</th><th style={th}>납품일</th><th style={th}>지급일</th>
                    <th style={th}>작업량</th><th style={{ ...th, textAlign: 'right' }}>단가</th><th style={{ ...th, textAlign: 'right' }}>기본수행료</th>
                    <th style={th}>추가비용</th><th style={th}>차감</th>
                    <th style={{ ...th, textAlign: 'right' }}>세전금액</th><th style={th}>세금처리</th><th style={{ ...th, textAlign: 'right' }}>공제</th><th style={{ ...th, textAlign: 'right' }}>실지급</th>
                    <th style={th}>지급회차</th>
                    {showActions && <th style={th}>조치</th>}
                  </tr></thead>
                  <tbody>
                    {summary.length === 0 && <tr><td colSpan={17 + (showActions ? 1 : 0)} style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }}>{isOverview ? '지급대상이 없습니다.' : '수집된 지급대상이 없습니다.'}</td></tr>}
                    {summary.flatMap((g) => g.items.map((it: any) => ({ ...it, payeeName: g.payeeName }))).map((it: any) => (
                      <tr key={it.id}>
                        {/* [1] 지급대상 */}
                        <td style={{ ...td, fontWeight: 600 }}>{it.payeeName}</td>
                        {/* [2] 거래처 — 별도 컬럼(§2). 없으면 '-' */}
                        <td style={td}>{it.customerName || '-'}</td>
                        {/* [3] 상품·업무 — 거래처 중복표기 안 함(§3) */}
                        <td style={td}>{it.productName || `#${it.projectId}`}</td>
                        {/* [4] 구분 — 서비스 유형(§4) */}
                        <td style={td}>{it.serviceType === 'translation' ? '번역' : it.serviceType === 'interpretation' ? '통역' : it.serviceType === 'equipment' ? '장비' : it.serviceType === 'review' ? '감수' : it.serviceType === 'dtp' ? 'DTP' : it.serviceType === 'media' ? '미디어' : '기타'}</td>
                        {/* [5] 수행일 (§5) */}
                        <td style={td}>{perfDate(it)}</td>
                        {/* [6] 납품일 */}
                        <td style={td}>{dateVal(it.deliveryDate) || '-'}</td>
                        {/* [7] 지급일 — 수행정보 expectedPaymentDate 원본 그대로. 미배정도 표시, 없으면 '-'(§3~§6) */}
                        <td style={td}>{dateVal(it.expectedPaymentDate) || '-'}</td>
                        {/* [8] 작업량 */}
                        <td style={td}>{workAmount(it)}</td>
                        {/* [8] 단가 (§8, 우측정렬) */}
                        <td style={tdR}>{unitPrice(it)}</td>
                        {/* [9] 기본수행료 (§9, 우측정렬) */}
                        <td style={tdR}>{won(it.basePerformanceFee)}</td>
                        {/* [10] 추가비용 — 항목명+금액 인라인(§10) */}
                        <td style={{ ...td, whiteSpace: 'normal', color: (it.expenses?.length ? C.textSecondary : C.g400) }}>{inlineItems(it.expenses)}</td>
                        {/* [11] 차감 — 항목명+금액 인라인(§11) */}
                        <td style={{ ...td, whiteSpace: 'normal', color: (it.deductions?.length ? C.danger : C.g400) }}>{inlineItems(it.deductions)}</td>
                        {/* [12] 세전금액 — VAT별도 보조표시가 숫자 정렬 안 깨뜨림(§12·§5) */}
                        {grossCell(it.gross, !!it.isVatIncluded, true)}
                        {/* [13] 세금처리 (§13) */}
                        <td style={td}>{(() => { const lbl = taxTreatmentLabel(it); return lbl === '세무확인 필요' ? <span style={{ color: C.danger }}>{lbl}</span> : lbl; })()}</td>
                        {/* [14] 공제 (§14, 우측정렬) */}
                        <td style={{ ...tdR, color: C.danger }}>{won(it.withholdingTax)}</td>
                        {/* [15] 실지급 (§15, 우측정렬·파란 강조) */}
                        <td style={{ ...tdR, fontWeight: 700, color: C.primaryText }}>{won(it.netPayment)}</td>
                        {/* [16] 지급회차 — 미배정 포함(§16) */}
                        <td style={td}>{roundLabel(it) ?? <span style={{ color: C.textSecondary, fontWeight: 700 }}>미배정</span>}</td>
                        {showActions && (
                          <td style={td}>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button type="button" onClick={() => excludeItem(it.id)} disabled={busy} title="이번 회차에서 제외" data-testid={`payout-exclude-${it.id}`} style={{ border: `1px solid ${C.g300}`, borderRadius: 5, background: C.bgCard, cursor: 'pointer', padding: '2px 6px', fontSize: 10 }}>제외</button>
                              <button type="button" onClick={() => carryOverItem(it.id)} disabled={busy} title="다음 회차로 이월" data-testid={`payout-carry-${it.id}`} style={{ border: `1px solid ${C.g300}`, borderRadius: 5, background: C.bgCard, cursor: 'pointer', padding: '2px 6px', fontSize: 10 }}>이월</button>
                              <button type="button" onClick={() => { setHoldFor({ id: it.id, name: it.payeeName }); setHoldReason(''); }} disabled={busy} title="지급보류" data-testid={`payout-hold-${it.id}`} style={{ border: '1px solid #fcd34d', borderRadius: 5, background: '#fffbeb', color: '#b45309', cursor: 'pointer', padding: '2px 6px', fontSize: 10 }}>보류</button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ── 재포함 + 회차 총계·지급확정/완료 — 특정 회차 선택 시만(§6·§8·§11) ── */}
      {!loading && !error && round && (
        <>
          {/* ── 재포함 가능 건(§5 포함) — 제외/이월했거나 새로 조건 충족된 미배정 건 ── */}
          {!locked && collectable.length > 0 && (
            <Card>
              <div style={{ ...TYPO.inputValue, fontWeight: 700, marginBottom: SP[2] }}>재포함 가능 <span style={{ color: C.primaryText }}>{collectable.length}건</span> <span style={{ ...TYPO.helper, fontWeight: 400 }}>— 대상기간 내 조건 충족·미배정 건. 「포함」으로 이 회차에 편입</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                {collectable.map((it) => (
                  <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: BD.divider }}>
                    <span style={{ ...TYPO.inputValue, flex: 1 }}>{it.performerName || '(미지정)'} <span style={{ ...TYPO.helper }}>· {it.productName || it.customerName || `#${it.id}`}</span></span>
                    <span style={{ ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>{won(it.gross)}원{vatTag(!!it.isVatIncluded)}</span>
                    <button type="button" onClick={() => includeItem(it.id)} disabled={busy} data-testid={`payout-include-${it.id}`} style={{ border: `1px solid ${C.primaryText}`, borderRadius: 5, background: C.primaryBg, color: C.primaryText, cursor: 'pointer', padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>포함</button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* ── 회차 총계(§6) + 지급확정(§8 하단 우측) ── */}
          <Card>
            <div style={{ ...TYPO.inputValue, fontWeight: 800, marginBottom: SP[3] }}>회차 총계</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: SP[3], fontVariantNumeric: 'tabular-nums' }}>
              {[
                ['총 대상자', `${totals.payees ?? 0}명`], ['총 건수', `${totals.assignments ?? 0}건`],
                ['기본수행료 합계', `${won(totals.baseTotal)}원`], ['추가비용 합계', `${won(totals.expenseTotal)}원`],
                ['차감 합계', `${won(totals.deductionTotal)}원`], ['공제액 합계', `${won(totals.withholdingTotal)}원`],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={TYPO.helper}>{k}</span><span style={{ ...TYPO.inputValue, fontWeight: 700 }}>{v}</span></div>
              ))}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={TYPO.helper}>실지급액 합계</span><span style={{ ...TYPO.inputValue, fontWeight: 800, fontSize: 17, color: C.primaryText }}>{won(totals.netTotal)}원</span></div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: SP[4], borderTop: BD.grid, paddingTop: SP[3] }}>
              {/* 상태 흐름: draft → [지급확정](confirmed) → [지급완료](paid). 취소/완료는 라벨만. */}
              {round.status === 'confirmed'
                ? <>
                    <span style={{ ...TYPO.helper, color: ROUND_STATUS.confirmed.color, fontWeight: 700, alignSelf: 'center' }}>지급 확정 — 관리자만 수정 가능</span>
                    <PrimaryBtn onClick={payRound} disabled={busy} style={{ fontSize: 13, padding: '9px 20px' }} data-testid="payout-pay" aria-label="지급완료">지급완료</PrimaryBtn>
                  </>
                : (round.status === 'paid' || round.status === 'cancelled')
                  ? <span style={{ ...TYPO.helper, color: ROUND_STATUS[round.status]?.color, fontWeight: 700 }}>{ROUND_STATUS[round.status]?.label} — 수정 불가</span>
                  : <PrimaryBtn onClick={confirmRound} disabled={busy || (totals.assignments ?? 0) === 0} style={{ fontSize: 13, padding: '9px 20px' }} data-testid="payout-confirm" aria-label="지급확정">지급확정</PrimaryBtn>}
            </div>
          </Card>
        </>
      )}

      {showCreate && <CreateDialog token={token} onToast={onToast} onClose={() => setShowCreate(false)} onCreated={async (d) => { setShowCreate(false); await loadRounds(); setSel(String(d.round.id)); setDetail(d); }} />}
      {showWarn && <WarningsModal warnings={warnings} busy={busy} onUnhold={!locked ? unholdItem : undefined} onClose={() => setShowWarn(false)} />}
      {holdFor && (
        <Modal title={`지급보류 — ${holdFor.name}`} onClose={() => setHoldFor(null)}>
          <p style={{ ...TYPO.helper, margin: '0 0 8px' }}>보류 사유를 선택하거나 입력하세요 (필수).</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {HOLD_REASONS.map(r => <button key={r} type="button" onClick={() => setHoldReason(r)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 14, cursor: 'pointer', border: `1px solid ${holdReason === r ? C.primaryText : C.g300}`, background: holdReason === r ? C.primaryBg : C.bgCard }}>{r}</button>)}
          </div>
          <input style={inp} value={holdReason} onChange={e => setHoldReason(e.target.value)} placeholder="보류 사유" data-testid="payout-hold-reason" aria-label="지급보류 사유" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <GhostBtn onClick={() => setHoldFor(null)} style={{ fontSize: 12, padding: '6px 12px' }}>취소</GhostBtn>
            <PrimaryBtn onClick={confirmHold} disabled={busy} style={{ fontSize: 12, padding: '6px 14px' }}>보류 처리</PrimaryBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── 회차 생성 다이얼로그(§5·§6) ──
function CreateDialog({ token, onToast, onClose, onCreated }: { token: string; onToast: (m: string) => void; onClose: () => void; onCreated: (d: any) => void; }) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [paymentDate, setPaymentDate] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [note, setNote] = useState('');
  // 대상기간 자동제안(suggestPeriod)이 납품 기준 기간을 만들므로 수집기준 기본값도 납품일로 정합(§6).
  const [basis, setBasis] = useState<'expected_payment_date' | 'delivery_date'>('delivery_date');
  const [busy, setBusy] = useState(false);
  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 34, padding: '6px 10px', width: '100%' };

  // 지급예정일 선택 → 회차명(자동·읽기전용) + 대상기간(자동, 수정 가능) 동시 생성(§1-①②).
  const onPayDate = (v: string) => {
    setPaymentDate(v);
    const s = suggestPeriod(v);
    setPeriodStart(s.start); setPeriodEnd(s.end);
    setBatchNumber(v ? `${v} 지급회차` : '');
  };

  const create = async () => {
    if (!paymentDate || !periodStart || !periodEnd) { onToast('지급예정일과 대상기간을 입력하세요.'); return; }
    setBusy(true);
    try {
      const res = await fetch(api('/api/admin/payout-rounds'), { method: 'POST', headers: authH, body: JSON.stringify({ paymentDate, periodStart, periodEnd, collectionBasis: basis, batchNumber: batchNumber || null, note: note || null }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '회차 생성 실패'); return; }
      // 동일 지급일 회차가 이미 있으면 서버가 생성하지 않고 기존 회차를 반환(duplicate) → 기존 회차 선택.
      if (data.duplicate) onToast('이미 생성된 지급회차가 있습니다. 기존 지급회차를 표시합니다.');
      else onToast(`지급회차가 생성되었습니다 (${data.totals?.assignments ?? 0}건 수집).`);
      onCreated(data);
    } catch { onToast('회차 생성 중 오류'); } finally { setBusy(false); }
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={{ ...TYPO.helper, fontWeight: 700 }}>{label}</span>{node}</label>
  );

  return (
    <Modal title="새 지급회차 생성" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 14px' }}>
        {field('지급예정일 *', <input type="date" style={inp} value={paymentDate} onChange={e => onPayDate(e.target.value)} data-testid="payout-new-paydate" aria-label="지급예정일" />)}
        {field('회차명 (자동)', <input style={{ ...inp, background: C.g50, color: C.textSecondary }} value={batchNumber} readOnly data-testid="payout-new-name" aria-label="회차명(자동)" placeholder="지급예정일 선택 시 자동 생성" />)}
        {field('대상기간 시작 (자동·수정가능)', <input type="date" style={inp} value={periodStart} onChange={e => setPeriodStart(e.target.value)} data-testid="payout-new-start" aria-label="대상기간 시작" />)}
        {field('대상기간 종료 (자동·수정가능)', <input type="date" style={inp} value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} data-testid="payout-new-end" aria-label="대상기간 종료" />)}
        {field('수집 기준', <ClickSelect value={basis} onChange={(v: string) => setBasis(v as any)} triggerStyle={inp} options={[{ value: 'delivery_date', label: '납품일 기준' }, { value: 'expected_payment_date', label: '지급예정일 기준' }]} />)}
        {field('비고', <input style={inp} value={note} onChange={e => setNote(e.target.value)} placeholder="비고" data-testid="payout-new-note" aria-label="비고" />)}
      </div>
      <p style={{ ...TYPO.helper, marginTop: 10, color: C.textSecondary }}>지급예정일 선택 시 대상기간이 자동 제안됩니다(수정 가능). 조건을 충족한 미지급·미배정 건이 자동수집됩니다.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <GhostBtn onClick={onClose} style={{ fontSize: 12, padding: '7px 14px' }}>취소</GhostBtn>
        <PrimaryBtn onClick={create} disabled={busy} style={{ fontSize: 12, padding: '7px 16px' }} data-testid="payout-new-submit">{busy ? '생성 중…' : '생성 + 자동수집'}</PrimaryBtn>
      </div>
    </Modal>
  );
}

// ── 제외·확인 필요 목록 모달(§8) ──
function WarningsModal({ warnings, busy, onUnhold, onClose }: { warnings: any; busy?: boolean; onUnhold?: (id: number) => void; onClose: () => void; }) {
  return (
    <Modal title={`제외·확인 필요 ${warnings.total}건`} onClose={onClose}>
      {warnings.byReason.length === 0 && <p style={{ ...TYPO.helper }}>확인이 필요한 항목이 없습니다.</p>}
      {warnings.byReason.map((b: any) => {
        const isHold = b.reason === '지급보류';
        return (
        <div key={b.reason} style={{ marginBottom: 12 }}>
          <div style={{ ...TYPO.inputValue, fontWeight: 700, marginBottom: 4 }}>{b.reason} <span style={{ color: C.danger }}>{b.count}건</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {b.items.slice(0, 20).map((it: any) => (
              <div key={it.id} style={{ ...TYPO.helper, color: C.textSecondary, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>{it.performerName || '(미지정)'} · {it.productName || `#${it.projectId}`}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{won(it.costTotal)}원</span>
                  {isHold && onUnhold && (
                    <button type="button" onClick={() => onUnhold(it.id)} disabled={busy} data-testid={`payout-unhold-${it.id}`}
                      title="지급보류 해제 (미지급으로 복귀)" style={{ border: '1px solid #86efac', borderRadius: 5, background: '#f0fdf4', color: '#15803d', cursor: busy ? 'not-allowed' : 'pointer', padding: '2px 8px', fontSize: 10, fontWeight: 700 }}>보류 해제</button>
                  )}
                </span>
              </div>
            ))}
            {b.items.length > 20 && <span style={{ ...TYPO.helper }}>…외 {b.items.length - 20}건</span>}
          </div>
        </div>
        );
      })}
    </Modal>
  );
}

// ── 공용 모달 ──
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void; }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.bgCard, borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.2)', padding: 22, width: 560, maxWidth: '100%', maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, ...TYPO.sectionTitle }}>{title}</h3>
          <button type="button" onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'none', fontSize: 20, cursor: 'pointer', color: C.textSecondary, lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
