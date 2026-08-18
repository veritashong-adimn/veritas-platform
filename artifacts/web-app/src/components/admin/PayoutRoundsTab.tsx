// ─────────────────────────────────────────────────────────────────────────────
// 지급회차 관리(정산 Phase 1) — 재무→정산 메인 화면.
//  · 수행정보 미지급 건을 지급일별 회차로 묶어 지급대상(개인/외주)별 자동합산·검토·확정.
//  · 계산은 서버(payoutRounds API)가 costTotal+세금처리로 산출. 화면은 표시·조작만.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { Pagination } from '../ui/Paginator';
import { useClientPagination } from './bulkListShared';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';
import { downloadTableExcel, todayStamp, type ExcelColumn } from '../../lib/payoutExcel';

const won = (n: unknown) => Math.round(Number(n ?? 0)).toLocaleString('ko-KR');
const dateVal = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
// 재집계용 안전 수치 변환(NaN·null → 0). 필터 결과 합산은 건별 서버 계산값을 그대로 더할 뿐 계산식은 불변.
const numOf = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

const ROUND_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft:     { label: '작성 중',  color: '#6b7280', bg: '#f3f4f6' },
  reviewing: { label: '검토 중',  color: '#b45309', bg: '#fffbeb' },
  confirmed: { label: '지급 확정', color: '#047857', bg: '#ecfdf5' },
  paid:      { label: '지급 완료', color: '#1d4ed8', bg: '#eff6ff' },
  cancelled: { label: '취소',     color: '#dc2626', bg: '#fef2f2' },
};
const TREATMENT_LABEL: Record<string, string> = {
  domestic_3_3: '3.3%', domestic_2_2: '2.2%', exempt: '원천징수 예외',
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
  // 건별(선택) 처리 — 체크한 수행건 id 집합. 회차/상태 변경 시 초기화.
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  // ── 조회 필터(지급회차 sel 과 조합) — 거래처 / 지급대상 검색 / 지급일 기간. 두 탭 동일 조건 적용. ──
  const [custFilter, setCustFilter] = useState<string>('all');   // 거래처명('all'=전체) — 회차 변경 시 초기화
  const [payeeQ, setPayeeQ] = useState('');                      // 지급대상(통번역사·외주업체명) 검색어
  const [dateFrom, setDateFrom] = useState('');                  // 지급일 시작(YYYY-MM-DD)
  const [dateTo, setDateTo] = useState('');                      // 지급일 종료(YYYY-MM-DD)

  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 32, padding: '5px 9px', width: '100%' };
  const th: React.CSSProperties = { ...TYPO.gridHeader, padding: '8px 10px', borderBottom: BD.grid, whiteSpace: 'nowrap', textAlign: 'left', background: C.g50 };
  const td: React.CSSProperties = { ...TYPO.inputValue, padding: '8px 10px', borderBottom: BD.divider, whiteSpace: 'nowrap' };
  const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  // ── 좌측 고정 컬럼(가로 스크롤 시 "누구/어떤 거래처·업무"를 항상 좌측 표시) ──
  //  · 요약: 지급대상 / 건별: (선택체크)·지급대상·거래처·상품·업무. 폭 고정 → left 오프셋 정합.
  //  · 고정 셀은 불투명 배경 + 마지막 고정 컬럼 우측에 경계선/그림자로 스크롤 영역과 자연 분리(§4).
  const STK_W = { chk: 34, payee: 132, email: 168, cust: 148, prod: 172, sumPayee: 156 };
  const stickyCol = (left: number, o?: { header?: boolean; last?: boolean; bg?: string; width?: number }): React.CSSProperties => ({
    position: 'sticky', left, zIndex: o?.header ? 3 : 2,
    background: o?.bg ?? (o?.header ? C.g50 : C.bgCard),
    ...(o?.width ? { width: o.width, minWidth: o.width, maxWidth: o.width, overflow: 'hidden', textOverflow: 'ellipsis' } : {}),
    ...(o?.last ? { boxShadow: `1px 0 0 0 ${C.border}, 6px 0 8px -6px rgba(15,23,42,0.16)` } : {}),
  });

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
  // 회차 전환 시: 건별 선택 초기화 + 거래처 필터 초기화(회차마다 거래처 목록이 다름) + 두 탭 1페이지(§1).
  //  · 지급대상 검색·지급일 기간은 회차 독립 개념이라 유지한다.
  useEffect(() => { setSelectedItems(new Set()); setCustFilter('all'); sumPg.setPage(1); itemPg.setPage(1); }, [sel]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 필터 변경 시: 두 탭 모두 1페이지부터 재표시(범위 밖 페이지 방지).
  useEffect(() => { sumPg.setPage(1); itemPg.setPage(1); }, [custFilter, payeeQ, dateFrom, dateTo]);   // eslint-disable-line react-hooks/exhaustive-deps

  const round = detail?.round;
  // 필터 활성 여부(초기화 버튼·안내 표시용).
  const filterActive = custFilter !== 'all' || payeeQ.trim() !== '' || !!dateFrom || !!dateTo;
  // 거래처 후보 — 현재 로드된 회차/개요의 실제 거래처만(회차 변경 시 자동 갱신). 별도 조회 없음.
  const customerOptions = useMemo(() => {
    const s = new Set<string>();
    (detail?.summary ?? []).forEach((g: any) => g.items.forEach((it: any) => { if (it.customerName) s.add(it.customerName); }));
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [detail]);
  // ── 필터 적용된 지급대상 그룹 ──
  //  · 서버 그룹(payeeKey/payeeName/payeeType/treatments 등) 위에 건별만 필터 후 "수치·건수만" 재집계.
  //  · gross·공제·실지급 등은 서버가 건별로 산출해 내려준 값을 그대로 합산 — 정산 계산식은 건드리지 않는다.
  //  · isVatIncluded(그룹)는 서버와 동일 규칙: 외주 && 전건 VAT포함.
  const filteredSummary: any[] = useMemo(() => {
    const q = payeeQ.trim().toLowerCase();
    const itemOk = (it: any) => {
      if (custFilter !== 'all' && (it.customerName || '') !== custFilter) return false;
      const d = it.expectedPaymentDate ? String(it.expectedPaymentDate).slice(0, 10) : '';
      if (dateFrom && (!d || d < dateFrom)) return false;   // 지급일 없는 건은 기간 지정 시 제외
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
  // 건별(필터 적용) — 두 탭이 동일한 조건. 전체선택·페이지네이션 기준.
  const itemRows: any[] = useMemo(
    () => filteredSummary.flatMap((g: any) => g.items.map((it: any) => ({ ...it, payeeName: g.payeeName, payeeEmail: g.payeeEmail ?? it.payeeEmail ?? null }))),
    [filteredSummary],
  );
  // 필터 결과 총계(조회 결과 라인·개요바용). 회차 총계/지급확정 영역은 회차 전체값 유지(운영 안전).
  const filteredTotals = useMemo(() => {
    let base = 0, exp = 0, ded = 0, gross = 0, wh = 0, net = 0, ind = 0, ven = 0;
    for (const g of filteredSummary) {
      base += numOf(g.baseTotal); exp += numOf(g.expenseTotal); ded += numOf(g.deductionTotal);
      gross += numOf(g.grossTotal); wh += numOf(g.withholdingTotal); net += numOf(g.netTotal);
      if (g.payeeType === 'individual') ind++; else ven++;
    }
    return { assignments: itemRows.length, payees: filteredSummary.length, individualCount: ind, vendorCount: ven,
      baseTotal: base, expenseTotal: exp, deductionTotal: ded, grossTotal: gross, withholdingTotal: wh, netTotal: net };
  }, [filteredSummary, itemRows]);
  // 클라이언트 페이지네이션(기본 20 · 20/50/100) — 요약/건별 각각. 회차·필터 변경 시 1페이지로.
  const sumPg = useClientPagination(filteredSummary, 20);
  const itemPg = useClientPagination(itemRows, 20);
  const totals = detail?.totals ?? {};
  const warnings = detail?.warnings ?? { total: 0, holdAmount: 0, byReason: [] };
  const collectable: any[] = detail?.collectable ?? [];
  const locked = round && (round.status === 'confirmed' || round.status === 'paid' || round.status === 'cancelled');
  // 전체 지급대상(개요) 모드 — 회차가 선택되지 않았고 데이터가 로드된 상태(§1). 건별 조치는 회차 선택 시만 가능.
  const isOverview = !!detail && !round;
  const overviewInfo = detail?.overview ?? null;
  const showActions = !!round && !locked;   // 제외/이월/보류는 특정 회차(편집가능)에서만
  // 건별(선택) 처리 가능 모드 — 지급확정(confirmed) 회차에서만. 부분 지급완료도 status는 confirmed 유지.
  const perItemMode = !!round && round.status === 'confirmed';
  const payStats = detail?.payStats ?? { paid: 0, hold: 0, unpaid: 0, total: 0 };
  // 회차 상태 표시(§6) — 0완료=지급확정 / 일부=일부 지급완료(n/m) / 전체=지급완료(paid는 서버 status).
  const partialPaid = round?.status === 'confirmed' && payStats.paid > 0;
  const statusLabel = partialPaid ? `일부 지급완료 (${payStats.paid}/${payStats.total}건)` : (ROUND_STATUS[round?.status]?.label ?? round?.status);
  const statusColor = partialPaid ? '#b45309' : ROUND_STATUS[round?.status]?.color;
  const statusBg = partialPaid ? '#fffbeb' : ROUND_STATUS[round?.status]?.bg;
  const isItemPaid = (it: any) => it.paymentStatus === 'paid';
  const isItemSelectable = (it: any) => perItemMode && it.paymentStatus === 'unpaid';   // 지급완료·보류 건은 선택 불가(§5)
  // 고정 셀 배경(지급완료 행 강조색과 정합) + 건별 고정 컬럼 left 오프셋(선택체크 유무 반영).
  const rowBg = (it: any) => (isItemPaid(it) ? '#f0fdf4' : C.bgCard);
  const stkChkW = perItemMode ? STK_W.chk : 0;
  const stkLeft = { payee: stkChkW, email: stkChkW + STK_W.payee, cust: stkChkW + STK_W.payee + STK_W.email, prod: stkChkW + STK_W.payee + STK_W.email + STK_W.cust };
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

  // 확정취소 — 지급완료 전 확정 회차를 작성중으로 되돌림. 확정 스냅샷 해제 + 같은 지급일 미배정 재편입 + 재계산.
  const unconfirmRound = async () => {
    if (!selId || busy) return;
    if (!window.confirm('이 회차의 지급확정을 취소하고 「작성중」으로 되돌릴까요?\n확정 스냅샷이 해제되고, 같은 지급일의 미배정 건이 다시 편입되며 금액이 재계산됩니다.\n(지급완료된 회차는 취소할 수 없습니다)')) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${selId}/unconfirm`), { method: 'PATCH', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '확정취소 실패'); return; }
      setDetail(data); await loadRounds();
      onToast(`확정취소되었습니다. (미배정 ${data.reassigned?.assigned ?? 0}건 재편입 · 작성중 전환)`);
    } catch { onToast('확정취소 중 오류'); } finally { setBusy(false); }
  };

  // 건별(선택) 처리 — 체크한 건만 지급완료/확정취소. selId(특정 회차)에서만 동작.
  const runItemAction = async (path: string, okMsg: (d: any) => string, failMsg: string) => {
    if (!selId || busy || selectedItems.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/payout-rounds/${selId}/${path}`), {
        method: 'PATCH', headers: authH, body: JSON.stringify({ assignmentIds: [...selectedItems] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? failMsg); return; }
      setDetail(data); await loadRounds(); setSelectedItems(new Set());
      onToast(okMsg(data));
    } catch { onToast(failMsg); } finally { setBusy(false); }
  };
  const payItemsSelected = () => {
    if (!window.confirm(`선택한 ${selectedItems.size}건을 지급완료 처리할까요?\n(지급완료된 건은 되돌릴 수 없습니다)`)) return;
    runItemAction('pay-items', (d) => `선택 ${d.paidNow ?? 0}건 지급완료 처리했습니다.`, '선택 지급완료 실패');
  };
  const unconfirmItemsSelected = () => {
    if (!window.confirm(`선택한 ${selectedItems.size}건을 확정취소(회차에서 제외)할까요?\n제외된 건은 미배정으로 돌아가 다시 처리됩니다.`)) return;
    runItemAction('unconfirm-items', (d) => `선택 ${d.removed ?? 0}건 확정취소했습니다. (미배정 복귀)`, '선택 확정취소 실패');
  };
  const toggleItem = (id: number) => setSelectedItems((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

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

  // ── Excel 다운로드(조회 전용) — 화면 필터가 적용된 전체 조회 결과를 그대로 출력(페이지네이션 무관, §Excel). ──
  //  · 금액·라벨은 화면과 동일 헬퍼(won 반올림·taxTreatmentLabel 등)를 재사용해 표시값 일치를 보장한다.
  //  · 정산 계산·회차·확정/완료·스냅샷 로직은 건드리지 않는다(읽기만).
  const svcLabel = (t: string) => t === 'translation' ? '번역' : t === 'interpretation' ? '통역' : t === 'equipment' ? '장비' : t === 'review' ? '감수' : t === 'dtp' ? 'DTP' : t === 'media' ? '미디어' : '기타';

  const exportSummaryExcel = () => {
    if (filteredSummary.length === 0) { onToast('내보낼 데이터가 없습니다.'); return; }
    const columns: ExcelColumn[] = [
      { header: '지급대상' }, { header: '이메일' }, { header: '구분' },
      { header: '건수', type: 'number' }, { header: '번역', type: 'number' }, { header: '통역', type: 'number' }, { header: '장비·외주', type: 'number' },
      { header: '기본수행료', type: 'number' }, { header: '추가비용', type: 'number' }, { header: '차감', type: 'number' },
      { header: '세전금액', type: 'number' }, { header: '세금처리' }, { header: '공제', type: 'number' }, { header: '실지급', type: 'number' },
    ];
    const rows = filteredSummary.map((g) => [
      g.payeeName,
      g.payeeEmail || '-',
      g.payeeType === 'individual' ? '통번역사' : '외주업체',
      numOf(g.count), numOf(g.translationCount), numOf(g.interpretationCount), numOf(g.equipmentEtcCount),
      Math.round(numOf(g.baseTotal)), Math.round(numOf(g.expenseTotal)), Math.round(numOf(g.deductionTotal)),
      Math.round(numOf(g.grossTotal)),
      groupTaxTreatmentLabel(g) ?? '⚠ 혼재',
      Math.round(numOf(g.withholdingTotal)), Math.round(numOf(g.netTotal)),
    ]);
    downloadTableExcel({ filename: `지급대상별요약_${todayStamp()}.xlsx`, sheetName: '지급대상별요약', columns, rows });
  };

  const exportItemsExcel = () => {
    if (itemRows.length === 0) { onToast('내보낼 데이터가 없습니다.'); return; }
    // 화면 건별 상세내역 컬럼 순서 그대로(체크박스·조치 열은 데이터 아님 → 제외).
    const columns: ExcelColumn[] = [
      { header: '지급대상' }, { header: '이메일' }, { header: '거래처' }, { header: '상품·업무' }, { header: '구분' },
      { header: '수행일' }, { header: '납품일' }, { header: '지급일' }, { header: '작업량' },
      { header: '단가', type: 'number' }, { header: '기본수행료', type: 'number' },
      { header: '추가비용' }, { header: '차감' },
      { header: '세전금액', type: 'number' }, { header: '세금처리' }, { header: '공제', type: 'number' }, { header: '실지급', type: 'number' },
      { header: '지급회차' },
    ];
    const rows = itemRows.map((it) => [
      it.payeeName,
      it.payeeEmail || '-',
      it.customerName || '-',
      it.productName || `#${it.projectId}`,
      svcLabel(it.serviceType),
      perfDate(it),
      dateVal(it.deliveryDate) || '-',
      dateVal(it.expectedPaymentDate) || '-',
      workAmount(it),
      (it.isDirectAmount || it.contractUnitPrice == null) ? '-' : Math.round(numOf(it.contractUnitPrice)),
      Math.round(numOf(it.basePerformanceFee)),
      inlineItems(it.expenses),
      inlineItems(it.deductions),
      Math.round(numOf(it.gross)),
      taxTreatmentLabel(it),
      Math.round(numOf(it.withholdingTax)),
      Math.round(numOf(it.netPayment)),
      roundLabel(it) ?? '미배정',
    ]);
    downloadTableExcel({ filename: `건별상세내역_${todayStamp()}.xlsx`, sheetName: '건별상세내역', columns, rows });
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
          {/* 지급명세서는 좌측 사이드바 정산→지급명세서 독립 메뉴로 분리(PayoutStatementTab). */}
        </div>
      </Card>

      {/* ── 조회 필터(지급회차 sel 과 조합) — 거래처 · 지급대상 검색 · 지급일 기간. 두 탭 동시 재집계. ── */}
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
              placeholder="통번역사·외주업체명" data-testid="payout-filter-payee" aria-label="지급대상 검색" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>지급일</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="date" style={{ ...inp, width: 152 }} value={dateFrom} max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)} data-testid="payout-filter-from" aria-label="지급일 시작" />
              <span style={{ color: C.textSecondary }}>~</span>
              <input type="date" style={{ ...inp, width: 152 }} value={dateTo} min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)} data-testid="payout-filter-to" aria-label="지급일 종료" />
            </div>
          </label>
          {filterActive && (
            <GhostBtn onClick={() => { setCustFilter('all'); setPayeeQ(''); setDateFrom(''); setDateTo(''); }}
              style={{ fontSize: 12, padding: '7px 14px' }} data-testid="payout-filter-reset" aria-label="필터 초기화">필터 초기화</GhostBtn>
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
            {/* 개요바 수치는 현재 필터 기준(§집계). 미배정 건수는 회차 구조값이라 서버 원본 유지. */}
            <span>{filterActive ? '지급대상' : '총 지급대상'} <b>{filteredTotals.payees}명</b> (개인 {filteredTotals.individualCount} · 외주 {filteredTotals.vendorCount})</span>
            <span>{filterActive ? '수행건' : '총 수행건'} <b>{filteredTotals.assignments}건</b></span>
            {!filterActive && <span>미배정 <b style={{ color: (overviewInfo?.unassignedCount ?? 0) > 0 ? C.danger : C.textSecondary }}>{overviewInfo?.unassignedCount ?? 0}건</b></span>}
            <span>{filterActive ? '실지급' : '총 실지급'} <b style={{ color: C.primaryText }}>{won(filteredTotals.netTotal)}원</b></span>
            {filterActive && <span style={{ ...TYPO.badge, color: C.primaryText, background: C.primaryBg, padding: '2px 8px', borderRadius: 6, fontWeight: 700 }}>필터 적용 중</span>}
          </div>
        </Card>
      )}

      {/* ── 회차 요약바(§2·§14) — 특정 회차 선택 시만 표시 ── */}
      {!loading && !error && round && (
          <Card>
            <div style={{ display: 'flex', gap: SP[3], alignItems: 'center', flexWrap: 'wrap', marginBottom: SP[3] }}>
              <b style={{ ...TYPO.inputValue, fontSize: 15 }}>{round.batchNumber || `${dateVal(round.paymentDate)} 지급회차`}</b>
              <span style={{ ...TYPO.badge, color: statusColor, background: statusBg, padding: '3px 9px', borderRadius: 6, fontWeight: 700 }}>{statusLabel}</span>
              {/* 정산정보 출처 표기 — 확정 스냅샷(동결) / 레거시(확정 당시 건별값 미보존, 원본 실시간 표시) */}
              {detail?.snapshotSource === 'snapshot' && (
                <span title="지급확정 당시 건별 정산정보가 동결되어 표시됩니다. 이후 원본 수행정보 수정과 무관합니다." style={{ ...TYPO.badge, color: '#047857', background: '#ecfdf5', padding: '3px 9px', borderRadius: 6, fontWeight: 700 }}>확정 스냅샷</span>
              )}
              {detail?.snapshotSource === 'live_legacy' && (
                <span title="스냅샷 도입 이전에 확정된 회차입니다. 확정 당시 건별값이 보존되지 않아 원본 수행정보 기준으로 표시됩니다(회차 총계는 확정 당시 값)." style={{ ...TYPO.badge, color: '#b45309', background: '#fffbeb', padding: '3px 9px', borderRadius: 6, fontWeight: 700 }}>⚠ 레거시(미보존)</span>
              )}
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

          {/* ── 조회 결과 요약(현재 필터 기준) — 두 탭 공통. 회차 총계/지급확정 영역은 별도로 회차 전체값 유지. ── */}
          <div style={{ display: 'flex', gap: SP[4], alignItems: 'center', flexWrap: 'wrap', padding: `${SP[2]}px ${SP[3]}px`, background: C.g50, borderRadius: 8, ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ ...TYPO.helper, fontWeight: 700 }}>조회 결과</span>
            <span>지급대상 <b>{filteredTotals.payees}명</b></span>
            <span>건수 <b>{filteredTotals.assignments}건</b></span>
            <span>세전 <b>{won(filteredTotals.grossTotal)}원</b></span>
            <span>공제 <b style={{ color: C.danger }}>{won(filteredTotals.withholdingTotal)}원</b></span>
            <span>실지급 <b style={{ color: C.primaryText }}>{won(filteredTotals.netTotal)}원</b></span>
            {filterActive && <span style={{ ...TYPO.badge, color: C.primaryText, background: C.primaryBg, padding: '2px 8px', borderRadius: 6, fontWeight: 700 }}>필터 적용 중</span>}
          </div>

          {/* ── 지급대상별 요약(§10) ── */}
          {view === 'summary' && (
            <Card>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: SP[2] }}>
                <GhostBtn onClick={exportSummaryExcel} disabled={filteredSummary.length === 0}
                  style={{ fontSize: 12, padding: '6px 14px' }} data-testid="payout-summary-excel" aria-label="지급대상별 요약 Excel 다운로드">📊 Excel 다운로드</GhostBtn>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1260 }}>
                  <thead><tr>
                    <th style={{ ...th, ...stickyCol(0, { header: true, last: true, width: STK_W.sumPayee }) }}>지급대상</th><th style={th}>이메일</th><th style={th}>구분</th>
                    <th style={{ ...th, textAlign: 'right' }}>건수</th><th style={{ ...th, textAlign: 'right' }}>번역</th><th style={{ ...th, textAlign: 'right' }}>통역</th><th style={{ ...th, textAlign: 'right' }}>장비·외주</th>
                    <th style={{ ...th, textAlign: 'right' }}>기본수행료</th><th style={{ ...th, textAlign: 'right' }}>추가비용</th><th style={{ ...th, textAlign: 'right' }}>차감</th>
                    <th style={{ ...th, textAlign: 'right' }}>세전</th><th style={th}>세금처리</th><th style={{ ...th, textAlign: 'right' }}>공제</th><th style={{ ...th, textAlign: 'right' }}>실지급</th>
                  </tr></thead>
                  <tbody>
                    {filteredSummary.length === 0 && <tr><td colSpan={14} style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }}>{filterActive ? '조건에 맞는 지급대상이 없습니다.' : '수집된 지급대상이 없습니다.'}</td></tr>}
                    {/* 집계 전용 — 펼침 없음. 건별 근거·세부내역은 '건별 상세내역' 탭에서 확인(§1·§2). */}
                    {sumPg.paged.map((g) => (
                      <tr key={g.payeeKey}>
                        <td style={{ ...td, fontWeight: 700, ...stickyCol(0, { last: true, width: STK_W.sumPayee }) }} title={g.payeeName}>{g.payeeName}</td>
                        <td style={{ ...td, color: C.textSecondary }} title={g.payeeEmail || '-'}>{g.payeeEmail || '-'}</td>
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
              {sumPg.total > 0 && (
                <Pagination page={sumPg.page} pageSize={sumPg.pageSize} total={sumPg.total}
                  onPageChange={sumPg.setPage} onPageSizeChange={sumPg.setPageSize}
                  pageSizeOptions={[20, 50, 100]} unit="명" idPrefix="payout-summary" />
              )}
            </Card>
          )}

          {/* ── 건별 상세내역(§3·§4·§5) — 지급명세서 원본. 한 건당 한 줄. 추가비용·차감은 항목 인라인(합계 없음). ── */}
          {view === 'items' && (
            <Card>
              {/* 건별(선택) 처리 툴바 — 지급확정 회차에서만. 체크한 건만 지급완료/확정취소(§건별). Excel은 항상 우측. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                {perItemMode && (<>
                  <span style={{ ...TYPO.helper, fontWeight: 700 }}>선택 {selectedItems.size}건</span>
                  <button type="button" onClick={payItemsSelected} disabled={busy || selectedItems.size === 0} data-testid="payout-pay-items" aria-label="선택 지급완료"
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 7, fontWeight: 700, cursor: (busy || selectedItems.size === 0) ? 'not-allowed' : 'pointer', color: '#fff', background: (busy || selectedItems.size === 0) ? C.g300 : C.primary, border: 'none' }}>선택 지급완료</button>
                  <button type="button" onClick={unconfirmItemsSelected} disabled={busy || selectedItems.size === 0} data-testid="payout-unconfirm-items" aria-label="선택 확정취소"
                    style={{ fontSize: 12, padding: '6px 12px', borderRadius: 7, fontWeight: 700, cursor: (busy || selectedItems.size === 0) ? 'not-allowed' : 'pointer', color: C.textSecondary, background: C.g50, border: `1px solid ${C.border}` }}>선택 확정취소</button>
                  <span style={{ ...TYPO.helper, color: C.textSecondary }}>지급완료된 건은 선택할 수 없습니다.</span>
                </>)}
                <GhostBtn onClick={exportItemsExcel} disabled={itemRows.length === 0}
                  style={{ marginLeft: 'auto', fontSize: 12, padding: '6px 14px' }} data-testid="payout-items-excel" aria-label="건별 상세내역 Excel 다운로드">📊 Excel 다운로드</GhostBtn>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1990 }}>
                  <thead><tr>
                    {/* 18개 컬럼(§1) — 지급대상→이메일(동명이인 식별)→거래처. 날짜 흐름 수행일→납품일→지급일. 조치는 회차 편집 모드에서만 후행 표시 */}
                    {perItemMode && (() => {
                      const selectable = itemRows.filter(isItemSelectable).map((it: any) => it.id);
                      const allSel = selectable.length > 0 && selectable.every((id: number) => selectedItems.has(id));
                      return <th style={{ ...th, textAlign: 'center', ...stickyCol(0, { header: true, width: STK_W.chk }) }}>
                        <input type="checkbox" checked={allSel} disabled={selectable.length === 0}
                          onChange={() => setSelectedItems(allSel ? new Set() : new Set(selectable))}
                          data-testid="payout-select-all" aria-label="전체 선택" />
                      </th>;
                    })()}
                    <th style={{ ...th, ...stickyCol(stkLeft.payee, { header: true, width: STK_W.payee }) }}>지급대상</th><th style={{ ...th, ...stickyCol(stkLeft.email, { header: true, width: STK_W.email }) }}>이메일</th><th style={{ ...th, ...stickyCol(stkLeft.cust, { header: true, width: STK_W.cust }) }}>거래처</th><th style={{ ...th, ...stickyCol(stkLeft.prod, { header: true, last: true, width: STK_W.prod }) }}>상품·업무</th><th style={th}>구분</th>
                    <th style={th}>수행일</th><th style={th}>납품일</th><th style={th}>지급일</th>
                    <th style={th}>작업량</th><th style={{ ...th, textAlign: 'right' }}>단가</th><th style={{ ...th, textAlign: 'right' }}>기본수행료</th>
                    <th style={th}>추가비용</th><th style={th}>차감</th>
                    <th style={{ ...th, textAlign: 'right' }}>세전금액</th><th style={th}>세금처리</th><th style={{ ...th, textAlign: 'right' }}>공제</th><th style={{ ...th, textAlign: 'right' }}>실지급</th>
                    <th style={th}>지급회차</th>
                    {showActions && <th style={th}>조치</th>}
                  </tr></thead>
                  <tbody>
                    {itemRows.length === 0 && <tr><td colSpan={18 + (showActions ? 1 : 0) + (perItemMode ? 1 : 0)} style={{ ...td, textAlign: 'center', color: C.g400, padding: 20 }}>{filterActive ? '조건에 맞는 지급 건이 없습니다.' : (isOverview ? '지급대상이 없습니다.' : '수집된 지급대상이 없습니다.')}</td></tr>}
                    {itemPg.paged.map((it: any) => (
                      <tr key={it.id} style={isItemPaid(it) ? { background: '#f0fdf4' } : undefined}>
                        {/* [0] 건별 선택 체크박스(§건별) — 지급확정 회차에서만. 지급완료 건은 '완료' 표시(선택 불가). */}
                        {perItemMode && (
                          <td style={{ ...td, textAlign: 'center', ...stickyCol(0, { width: STK_W.chk, bg: rowBg(it) }) }}>
                            {isItemPaid(it)
                              ? <span title="지급완료" style={{ fontSize: 11, color: '#047857', fontWeight: 700 }}>완료</span>
                              : <input type="checkbox" checked={selectedItems.has(it.id)} disabled={!isItemSelectable(it)}
                                  onChange={() => toggleItem(it.id)} data-testid={`payout-item-check-${it.id}`} aria-label={`${it.payeeName} 건 선택`} />}
                          </td>
                        )}
                        {/* [1] 지급대상 — 좌측 고정 */}
                        <td style={{ ...td, fontWeight: 600, ...stickyCol(stkLeft.payee, { width: STK_W.payee, bg: rowBg(it) }) }} title={it.payeeName}>{it.payeeName}</td>
                        {/* [2] 이메일 — 동명이인 식별용 표시정보, 좌측 고정. 미등록이면 '-' */}
                        <td style={{ ...td, color: C.textSecondary, ...stickyCol(stkLeft.email, { width: STK_W.email, bg: rowBg(it) }) }} title={it.payeeEmail || '-'}>{it.payeeEmail || '-'}</td>
                        {/* [3] 거래처 — 별도 컬럼(§2), 좌측 고정. 없으면 '-' */}
                        <td style={{ ...td, ...stickyCol(stkLeft.cust, { width: STK_W.cust, bg: rowBg(it) }) }} title={it.customerName || '-'}>{it.customerName || '-'}</td>
                        {/* [3] 상품·업무 — 거래처 중복표기 안 함(§3), 좌측 고정(마지막 고정 컬럼) */}
                        <td style={{ ...td, ...stickyCol(stkLeft.prod, { last: true, width: STK_W.prod, bg: rowBg(it) }) }} title={it.productName || `#${it.projectId}`}>{it.productName || `#${it.projectId}`}</td>
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
              {itemPg.total > 0 && (
                <Pagination page={itemPg.page} pageSize={itemPg.pageSize} total={itemPg.total}
                  onPageChange={itemPg.setPage} onPageSizeChange={itemPg.setPageSize}
                  pageSizeOptions={[20, 50, 100]} unit="건" idPrefix="payout-items" />
              )}
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
                    {/* 확정취소 — 지급완료 전에만. 작성중으로 되돌려 재편입·재계산 후 다시 확정. */}
                    <button type="button" onClick={unconfirmRound} disabled={busy} data-testid="payout-unconfirm" aria-label="확정취소"
                      style={{ fontSize: 13, padding: '9px 16px', borderRadius: 8, cursor: busy ? 'not-allowed' : 'pointer', background: C.g50, border: `1px solid ${C.border}`, color: C.textSecondary, fontWeight: 700, alignSelf: 'center' }}>
                      확정취소
                    </button>
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
