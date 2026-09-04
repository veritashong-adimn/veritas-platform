// ─────────────────────────────────────────────────────────────────────────────
// 수행정보 (Performance) 섹션 — 판매 상세 C 섹션. ERP형 한줄 입력 구조(2차 개편).
//  · 수행자·외주업체·경비 = 1행. 상세 펼침(Accordion) 제거 — 모든 필드를 한 줄에서 편집.
//  · 좌측고정(행제어·구분·수행자·상품) + 우측고정(원가합계·지급·관리) + 가운데 가로스크롤.
//  · 추가비용·차감·금액상세는 소형 팝업(performancePopups). 계산 로직은 기존 유지(§15).
//  · 저장은 PUT /admin/projects/:id/performances — 원가·원천세·부가세 서버 재계산. 판매금액과 분리.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useMemo, useState, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';
import PerformanceProfitSummary from './PerformanceProfitSummary';
import RowControls from './RowControls';
import InlinePerformerPicker from './InlinePerformerPicker';
import { AmountDetailPopup, AdjustmentPopup, RatePopup } from './performancePopups';
import ServiceDetailCell from './performanceServiceDetail';
import {
  Row, ExpenseRow, toRow, won, num, round2, commafy, dateVal, calcRowCostPreview, calcPaymentDate, isEquipmentKind, isInterpretationKind, isTranslationKind, perPersonSnapshot,
  autoRateSig, isAutoRateOverwritable, afterTaxPayout, profitRatePct,
  INTERP_ADD_FEE_TYPE, INTERP_BIZTRIP_TYPE, INTERP_TRANSPORT_TYPE, INTERP_DEDICATED_EXPENSE_TYPES, INTERP_ETC_DEFAULT_TYPE,
  ETC_SELECTABLE_TYPES, computeEtcCols, etcColLabel, etcColIsEmpty, CUSTOM_EXPENSE_VALUE,
  defaultPayoutRate, effectivePayoutRate, expenseBase, actualPayout, displayPayoutRate, isFixed100Type,
  CATEGORY_OPTS, TREATMENT_OPTS, normalizeTreatment, effectiveTreatment,
  PERFORMER_TYPE_OPTS, resolvePerformerType, performerTypeLabel, canonicalLineCategory,
  PAYMENT_STATUS_OPTS, PAYMENT_STATUS_SELECTABLE_OPTS,
  PaymentBadge,
} from './performanceShared';

interface Props {
  projectId: number;
  token: string;
  performances: any[];
  onChanged: () => void | Promise<void>;
  onToast: (msg: string) => void;
  projectAdminId?: number | null;   // 프로젝트 담당 PM(납품확인 권한 §9)
}

type SortKey = 'deliveryDate' | 'expectedPaymentDate' | 'costTotal' | null;

export default function PerformanceSection({ projectId, token, performances, onChanged, onToast, projectAdminId }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // 현재 사용자(납품확인 권한 판정 §9) — JWT payload 디코드(id·role). 서버가 최종 강제.
  const currentUser = useMemo(() => {
    try {
      const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch { return null; }
  }, [token]);
  const canConfirmDelivery = !!currentUser && (currentUser.role === 'admin' || (projectAdminId != null && currentUser.id === projectAdminId));
  const [editMode, setEditMode] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [searchIdx, setSearchIdx] = useState<number | null>(null);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [summaryKey, setSummaryKey] = useState(0);
  // 소형 팝업(§금액상세 / §조정항목) — 행 인덱스 기준
  const [amountPopup, setAmountPopup] = useState<number | null>(null);
  const [adjustPopup, setAdjustPopup] = useState<number | null>(null);
  // 비용항목 지급률 팝업(§비용지급률·§9) — 셀 클릭 시 {행 index, expenseType} 지정. 기준금액×지급률=실제지급액 편집.
  const [ratePopup, setRatePopup] = useState<{ i: number; type: string; label: string } | null>(null);
  // 사용자가 기타비용 선택기로 추가한 '빈' 동적 컬럼(§3·§7) — 데이터가 아직 없어도 컬럼 노출. 편집 세션 한정(삽입 순서 유지).
  //   데이터 유래 컬럼은 computeEtcCols 가 별도로 합산하므로 여기엔 넣지 않는다. enterEdit/cancelEdit 시 초기화.
  const [pinnedEtcCols, setPinnedEtcCols] = useState<string[]>([]);
  // 조정항목 상세(조회 전용) 팝업 — 조회모드에서 셀 클릭 시 읽기 전용 표시
  const [adjustViewPopup, setAdjustViewPopup] = useState<number | null>(null);
  // 필터/정렬 (조회모드)
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [payFilter, setPayFilter] = useState('');
  const [onlyUnpaid, setOnlyUnpaid] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  // 공휴일 집합(지급일 직전 영업일 조정용, §4·§6) — 서버 단일 출처에서 로드, 하드코딩 없음
  const [holidaySet, setHolidaySet] = useState<Set<string>>(new Set());
  const isHoliday = React.useCallback((d: string) => holidaySet.has(d), [holidaySet]);
  // 납품일 변경/삭제 시 수동 지급일 보호 확인창(§10-2·§13)
  const [dateConfirm, setDateConfirm] = useState<{ idx: number; kind: 'recalc' | 'clear'; newDelivery: string; auto: string | null } | null>(null);
  // 서비스 종료일 변경 시 수동/확인 납품일 보호 확인창(§8)
  const [endSync, setEndSync] = useState<{ idx: number; newEnd: string; newDelivery: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(api('/api/admin/holidays'), { headers: { Authorization: `Bearer ${token}` } });
        const j = await res.json().catch(() => null);
        if (alive && Array.isArray(j?.dates)) setHolidaySet(new Set(j.dates as string[]));
      } catch { /* 미로드 시 주말만 조정(서버 저장 시 재검증) */ }
    })();
    return () => { alive = false; };
  }, [token]);

  const list: any[] = performances ?? [];

  // ── 지급일 잠금(§14) — 지급진행·지급회차 확정 행은 날짜 임의수정 불가(정산상태·지급명세서 상태 제거) ──
  const isDateLocked = (r: Row): boolean =>
    ((r.paymentStatus ?? '') === 'paid') ||
    (r.payoutRoundId != null);

  // ── 납품일 직접수정 → 수동상태·확인해제(§7) + 지급일 재계산(§10·§11). 수동 지급일이면 확인창(§10-2). ──
  const changeDelivery = (i: number, d: string) => {
    const r = rows[i];
    if (isDateLocked(r)) { onToast('지급 진행 행의 날짜는 수정할 수 없습니다.'); return; }
    // 납품일을 사용자가 바꾸면 확인상태 자동 해제(§7)
    const resetConfirm = { deliveryDateManual: true, deliveryConfirmed: false };
    if (!d) { // 납품일 삭제(§13)
      if (r.payDateManual && r.expectedPaymentDate) { setDateConfirm({ idx: i, kind: 'clear', newDelivery: '', auto: null }); return; }
      patchRow(i, { deliveryDate: '', expectedPaymentDate: null, payDateManual: false, payDateChangeReason: null, ...resetConfirm });
      return;
    }
    const auto = calcPaymentDate(d, isHoliday);
    if (r.payDateManual && r.expectedPaymentDate) { setDateConfirm({ idx: i, kind: 'recalc', newDelivery: d, auto }); return; }
    patchRow(i, { deliveryDate: d, expectedPaymentDate: auto, payDateManual: false, payDateChangeReason: null, ...resetConfirm });
  };
  // ── 납품확인 체크(§4·§9) — 권한자만. 확인자·확인일시는 저장 시 서버 기록. ──
  const toggleDeliveryConfirm = (i: number) => {
    const r = rows[i];
    if (!canConfirmDelivery) { onToast('납품확인 권한이 없습니다. 담당 PM 또는 관리자만 확인할 수 있습니다.'); return; }
    if (!r.deliveryConfirmed && !r.deliveryDate) { onToast('납품일이 없어 확인할 수 없습니다.'); return; }
    patchRow(i, { deliveryConfirmed: !r.deliveryConfirmed });
  };
  // ── 서비스 종료일 변경(§8) — 자동·미확인 납품일이면 자동 갱신, 수동/확인이면 확인창. ──
  const changeServiceEndDate = (i: number, v: string) => {
    const r = rows[i];
    const newDelivery = v || null;
    if (!r.deliveryDateManual && !r.deliveryConfirmed) {
      const pay = r.payDateManual ? {} : { expectedPaymentDate: calcPaymentDate(newDelivery, isHoliday) };
      patchRow(i, { performanceEndDate: v, deliveryDate: newDelivery, deliveryDateAuto: newDelivery, ...pay });
    } else {
      setEndSync({ idx: i, newEnd: v, newDelivery });
    }
  };
  // ── 지급일 직접수정 → 수동상태로 전환. 비우면 자동모드 복귀(§8·§11). ──
  const changePayDate = (i: number, d: string) => {
    const r = rows[i];
    if (isDateLocked(r)) { onToast('지급 진행 행의 날짜는 수정할 수 없습니다.'); return; }
    patchRow(i, { expectedPaymentDate: d || null, payDateManual: !!d });
  };

  // ── 조회모드 필터·정렬 ──
  const viewRows = useMemo(() => {
    let out = list.map(toRow);
    const kw = q.trim().toLowerCase();
    if (kw) out = out.filter(r => `${r.performerNameSnapshot ?? ''} ${r.productNameSnapshot ?? ''} ${r.lineCategory ?? ''}`.toLowerCase().includes(kw));
    if (catFilter) out = out.filter(r => r.performerCategory === catFilter);
    if (payFilter) out = out.filter(r => (r.paymentStatus ?? 'unpaid') === payFilter);
    if (onlyUnpaid) out = out.filter(r => (r.paymentStatus ?? 'unpaid') === 'unpaid');
    if (sortKey) {
      const dir = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = sortKey === 'costTotal' ? num(a.costTotal) : (dateVal(a[sortKey]) || '');
        const bv = sortKey === 'costTotal' ? num(b.costTotal) : (dateVal(b[sortKey]) || '');
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }
    return out;
  }, [list, q, catFilter, payFilter, onlyUnpaid, sortKey, sortDir]);

  const enterEdit = () => { setRows(list.map(toRow)); setDeletedIds([]); setPinnedEtcCols([]); setEditMode(true); };
  const cancelEdit = () => { setRows([]); setDeletedIds([]); setPinnedEtcCols([]); setEditMode(false); setAmountPopup(null); setAdjustPopup(null); };
  // 기타비용 선택기(§1~§4) — 항목 선택 시 동적 컬럼 추가(pin). 직접입력은 항목명 입력(빈이름·중복·전용3종 금지 §6·§11).
  const addEtcCol = (type: string) => setPinnedEtcCols(prev => prev.includes(type) ? prev : [...prev, type]);
  const addCustomEtcCol = (dataTypes: string[]) => {
    const raw = window.prompt('기타비용 항목명을 입력하세요 (예: 주차비, 택배비)');
    const name = (raw ?? '').trim();
    if (!name) return;                                                       // 빈 이름 금지(§6)
    if ((INTERP_DEDICATED_EXPENSE_TYPES as string[]).includes(name)) { onToast('추가통역료·출장비·교통비는 전용 컬럼입니다.'); return; }  // §11
    if (dataTypes.includes(name) || pinnedEtcCols.includes(name)) { onToast('이미 있는 항목입니다.'); return; }  // 중복 방지(§6·§11)
    setPinnedEtcCols(prev => [...prev, name]);
  };
  // 동적 컬럼 제거(§8) — pin 해제만. 데이터가 있는 행이 하나라도 있으면 computeEtcCols가 다시 포함하므로 컬럼은 유지(데이터 손실 없음).
  const removeEtcCol = (type: string) => setPinnedEtcCols(prev => prev.filter(t => t !== type));
  const patchRow = (i: number, p: Partial<Row>) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...p } : r));
  // 통역 요금(100%) — 독립 입력 필드. 통역료(85%)를 자동계산하지 않는다(요금×0.85 자동연동 제거). '85%'는 요율 구분 명칭일 뿐.
  //   요금(100%)=contractUnitPrice는 참조값(계산 미사용). 통역 지급 base는 통역료(85%)=directAmount 이므로 isDirectAmount=true만 유지.
  //   → 요금(100%) 입력이 통역료(85%) 값을 변경하지 않는다(각 필드 독립).
  const setInterpFee100 = (i: number, v: string) => {
    patchRow(i, { contractUnitPrice: v, isDirectAmount: true });
  };
  // 번역 요금(100%) — 협의 총액(§3·§4A). 입력 시 base가 되도록 isDirectAmount=true+directAmount 설정 → 지급액=요금100+기타비용.
  //   공란이면 isDirectAmount=false로 되돌려 수량×단가(§4B) 방식으로 계산(요금100 우선, 이중합산 방지). 판매단가 자동복사 없음(§7).
  const setTransFee100 = (i: number, v: string) => {
    const has = v != null && v !== '';
    patchRow(i, { directAmount: v, isDirectAmount: has });
  };
  // 번역 수행 단위 — 글자/단어(§10). 신규 구조는 지급액=수량×단가를 이 단위 기준으로 계산.
  // 번역 수행 단위 — 7종(§단위확장). 저장값은 기존 canonical(한글 문자열, UNIT_OPTS와 동일 값) 재사용 — 신규 enum 없음.
  //   지급액=수량×단가는 단위 종류와 무관(라벨/기록용). '단어/글자'는 기존값 유지, '페이지/회/분/시간/일' 추가.
  const TRANS_UNIT_OPTS = [
    { value: '단어', label: '단어' },
    { value: '글자', label: '글자' },
    { value: '페이지', label: '페이지' },
    { value: '회', label: '회' },
    { value: '분', label: '분' },
    { value: '시간', label: '시간' },
    { value: '일', label: '일' },
  ];
  // 통역 부대비용 전용 컬럼(추가통역료·출장비·교통비) — expenses[]의 특정 항목에 바인딩(원가 SSOT = expenseTotal 유지).
  const expAmtOf = (r: Row, type: string): string | number => {
    const e = (r.expenses ?? []).find(x => x.expenseType === type);
    return e && e.amount != null ? e.amount : '';
  };
  // 특정 expenseType 금액 upsert/삭제 — 다른 expenses·deductions는 보존. 공란이면 해당 항목 제거.
  const setExpAmt = (i: number, r: Row, type: string, v: string) => {
    const list: ExpenseRow[] = [...(r.expenses ?? [])];
    const idx = list.findIndex(x => x.expenseType === type);
    const empty = v == null || v === '';
    if (idx >= 0) {
      if (empty) list.splice(idx, 1);
      else list[idx] = { ...list[idx], amount: v, includedInPayout: true };
    } else if (!empty) {
      list.push({ expenseType: type, amount: v, includedInPayout: true });
    }
    patchRow(i, { expenses: list });
  };
  // 지급률 반영 upsert(§비용지급률) — 기준금액×지급률=실제지급액(amount)로 저장. 기준금액·지급률도 함께 보존(재조회 복원).
  //   공란/0 기준금액이면 항목 제거. 다른 expenses·deductions·부가필드(발생일·증빙·메모)는 보존.
  const setExpFull = (i: number, r: Row, type: string, baseStr: string, ratePct: number) => {
    const list: ExpenseRow[] = [...(r.expenses ?? [])];
    const idx = list.findIndex(x => x.expenseType === type);
    const empty = baseStr == null || baseStr === '';
    if (empty) {
      if (idx >= 0) list.splice(idx, 1);
    } else {
      const base = num(baseStr);
      const actual = actualPayout(base, ratePct);   // 실제 지급액 = 기준금액 × 지급률/100
      const patch = { expenseType: type, amount: actual, baseAmount: base, payoutRate: ratePct, includedInPayout: true };
      if (idx >= 0) list[idx] = { ...list[idx], ...patch };
      else list.push(patch);
    }
    patchRow(i, { expenses: list });
  };
  // 기타비용(통역) 합계 — 전용 3종(추가통역료·출장비·교통비)을 제외한 지급대상 추가비용 합.
  const etcExpenseTotal = (r: Row) => round2((r.expenses ?? [])
    .filter(e => !INTERP_DEDICATED_EXPENSE_TYPES.includes(e.expenseType) && e.includedInPayout !== false)
    .reduce((s, e) => s + num(e.amount), 0));
  // 상단 버튼: 유형 지정 행을 목록 마지막에 추가(§13)
  const addRow = (performerCategory: string, lineCategory: string) =>
    setRows(prev => [...prev, { performerCategory, lineCategory, status: 'unassigned', paymentStatus: 'unpaid', quantity: 1, expenses: [], deductions: [] }]);
  // 행별 + : 클릭한 행 바로 아래에 빈 신규 행 삽입(§13). 기존 값 복사 안 함.
  const insertBelow = (i: number) => setRows(prev => {
    const blank: Row = { performerCategory: 'individual', lineCategory: '통번역사', status: 'unassigned', paymentStatus: 'unpaid', quantity: 1, expenses: [], deductions: [] };
    return [...prev.slice(0, i + 1), blank, ...prev.slice(i + 1)];
  });
  // 순서 이동(§13) — 행 객체 전체를 교환하므로 금액·상세·정산정보가 섞이지 않음
  const moveRow = (i: number, dir: 'up' | 'down') => setRows(prev => {
    const next = [...prev];
    const swap = dir === 'up' ? i - 1 : i + 1;
    if (swap < 0 || swap >= next.length) return prev;
    [next[i], next[swap]] = [next[swap], next[i]];
    return next;
  });
  // 복제(§13) — 서비스 수행조건(구조화 필드)을 완전 복사, 수행자·정산·지급 완료정보만 초기화. 원본 바로 아래 생성.
  //   서비스별 상세정보는 문자열이 아닌 원본 스냅샷(serviceDetailSnapshot)을 복사해, 동일 formatter로 원본과 동일하게 표시된다
  //   (시간·수행시간·장소·언어·세부옵션 유지). 단, 인원수(interpreterCount)는 각 행 = 통역사 1명 원칙에 따라 1로 정규화 —
  //   원가(계약단가×수행일수×인원)가 전체 인원으로 중복 산정되지 않도록 함. 원본 행과 기존 저장 데이터는 변경하지 않는다.
  const dupRow = (i: number) => setRows(prev => {
    const s = prev[i];
    // 1인분 정규화(불러오기와 동일 로직) — 인원수를 1로 정규화해 원본과 동일한 1인분 기본수행료가 산정되도록 한다.
    const snapCopy = perPersonSnapshot(s.serviceDetailSnapshot);
    const copy: Row = {
      performerCategory: s.performerCategory, lineCategory: s.lineCategory, saleItemId: s.saleItemId,
      serviceType: s.serviceType, productNameSnapshot: s.productNameSnapshot, languageOrServiceSnapshot: s.languageOrServiceSnapshot,
      // 서비스별 상세 스냅샷 — 원본 구조 전체 복사(시간·장소·수행시간·판매수량/단위·언어·세부옵션 등 표시·계산 원본값 유지)
      serviceDetailSnapshot: snapCopy,
      performanceStartDate: s.performanceStartDate, performanceEndDate: s.performanceEndDate, deliveryDate: s.deliveryDate,
      quantity: s.quantity, unit: s.unit, contractUnitPrice: s.contractUnitPrice, isDirectAmount: s.isDirectAmount, directAmount: s.directAmount,
      // 기본수행료·추가비용(조정) 기본값 복사 — 원가/지급액 산정 기준·지급일 산정정보 유지
      baseFee: s.baseFee, transportationFee: s.transportationFee, businessTripFee: s.businessTripFee,
      copyrightFee: s.copyrightFee, travelDayCompensation: s.travelDayCompensation, cancellationCompensation: s.cancellationCompensation,
      supplyAmount: s.supplyAmount, vatAmount: s.vatAmount, purchaseEvidenceType: s.purchaseEvidenceType,
      serviceCountry: s.serviceCountry,
      memo: s.memo,
      expenses: (s.expenses ?? []).map(e => ({ ...e, id: undefined })),
      deductions: (s.deductions ?? []).map(d => ({ ...d, id: undefined })),
      // 초기화 — 통번역사 배정·식별정보·정산·지급 완료정보(세금처리·거주구분은 수행자 선택 시 재도출되므로 미복사)
      status: 'unassigned', paymentStatus: 'unpaid',
      performerNameSnapshot: null, individualUserId: null, vendorCompanyId: null,
      identifierSnapshotMasked: null, vendorTypeSnapshot: null,
      payoutRoundId: null, payStatementId: null, actualPaymentAmount: null, actualPaymentDate: null, expectedPaymentDate: null,
    };
    return [...prev.slice(0, i + 1), copy, ...prev.slice(i + 1)];
  });
  // 삭제 가능 여부(§13) — 지급진행/지급회차/실지급 시 차단(정산상태·지급명세서 상태 제거)
  const canDelete = (r: Row): boolean => {
    if (r.status === 'paid') return false;
    if ((r.paymentStatus ?? 'unpaid') === 'paid') return false;
    if (r.payoutRoundId != null) return false;
    if (num(r.actualPaymentAmount) > 0) return false;
    return true;
  };
  const removeRow = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (!canDelete(r)) { onToast('지급이 진행된 수행정보는 삭제할 수 없습니다.'); return; }
    if (!window.confirm('이 수행정보 행을 삭제하시겠습니까?')) return;
    setRows(prev => {
      if (prev[i]?.id) setDeletedIds(d => [...d, prev[i].id!]);
      return prev.filter((_, idx) => idx !== i);
    });
  };

  const rowKey = (r: Row, i: number) => String(r.id ?? `new-${i}`);

  // ── 수행자·업체 검색/선택 ──
  const runSearch = async (i: number, url: string) => {
    setSearchIdx(i);
    try {
      const res = await fetch(api(url), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => []);
      const arr = Array.isArray(data) ? data : (data.rows ?? []);
      setSearchResults(arr.slice(0, 8));
    } catch { setSearchResults([]); }
  };
  const onSearchTranslator = (i: number, s: string) => { if (!s.trim()) { setSearchIdx(i); setSearchResults([]); return; } runSearch(i, `/api/admin/translators?search=${encodeURIComponent(s)}`); };
  const onSearchVendor = (i: number, s: string) => { if (!s.trim()) { setSearchIdx(i); setSearchResults([]); return; } runSearch(i, `/api/admin/companies?companyType=vendor&search=${encodeURIComponent(s)}`); };
  const onClearPerformer = (i: number) => { patchRow(i, { performerNameSnapshot: null }); setSearchIdx(i); setSearchResults([]); };

  // 통번역사 최근 수행이력 조회(§2·§3) — 상세 미리보기에서 지연 호출. 실패해도 빈 배열(미리보기 유지).
  const fetchRecentPerformances = React.useCallback(async (translatorId: number) => {
    try {
      const res = await fetch(api(`/api/admin/performances/recent-by-translator?translatorId=${translatorId}`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      return res.ok && Array.isArray(data.rows) ? data.rows : [];
    } catch { return []; }
  }, [token]);

  // 인라인 선택(§선택-저장 분리) — 신규·기존 행 모두 "로컬 폼에만" 반영. 즉시 저장·화면전환 없음.
  //   개인: 3.3%·마스킹식별번호·기본단가 등 자동값은 읽기전용 resolve로 폼에만 채운다(DB 미저장).
  //   상단 「저장」 클릭 시 일괄 저장되며, 그때 서버가 식별자(암호문)·거주국·업체유형 스냅샷을 재도출한다.
  const pickTranslator = async (i: number, t: any) => {
    const r = rows[i];
    const isTrans = isTranslationKind(r);   // 번역행 여부(§5·§22) — 자동매칭/기본단가 처리 분기
    patchRow(i, {
      performerCategory: 'individual', individualUserId: t.id, vendorCompanyId: null,
      performerNameSnapshot: t.name || t.email, lineCategory: r.lineCategory || '통번역사', vendorTypeSnapshot: null,
    });
    setSearchResults([]); setSearchIdx(null);   // 검색 드롭다운만 닫는다(수정화면 유지)
    try {
      const res = await fetch(api(`/api/admin/performances/resolve-individual?translatorId=${t.id}`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.snapshot) {
        const s = data.snapshot;
        setRows(prev => prev.map((row, idx) => {
          if (idx !== i || row.individualUserId !== t.id) return row;   // 그 사이 다른 선택이면 무시
          return {
            ...row,
            performerNameSnapshot: s.performerNameSnapshot ?? row.performerNameSnapshot,
            identifierSnapshotMasked: s.identifierMasked ?? null,
            residenceCountrySnapshot: s.residenceCountrySnapshot ?? null,
            residencyType: s.residencyType ?? null,
            withholdingTreatment: s.withholdingTreatment ?? null,
            // 통역 등 비번역: 프로필 기본단가(방향·단위 무관 단일값)를 계약단가 초기값으로(기존 동작 유지·§22).
            //   번역은 여기서 복사하지 않는다 — 방향·단위별 등록단가 자동매칭만 사용(§7·§14). 아래 autoMatchTranslationRate 처리.
            ...(!isTrans && (row.contractUnitPrice == null || row.contractUnitPrice === '') && s.baseRate != null
              ? { contractUnitPrice: String(s.baseRate), quantity: (row.quantity == null || row.quantity === '') ? '1' : row.quantity }
              : {}),
          };
        }));
      }
    } catch { /* resolve 실패해도 로컬 선택은 유지 — 저장 시 서버가 스냅샷 재도출 */ }
    // 번역행 자동매칭(§5~§16) — 선택된 번역사의 방향·단위별 등록단가 × 판매 작업량으로 수량/단위/단가 자동입력.
    if (isTrans) await autoMatchTranslationRate(i, t.id, r.saleItemId ?? null);
  };
  // 번역 단가 자동매칭(§5~§16) — 서버 읽기전용 조회 결과를 dirty 보호 하에 로컬 폼에만 반영. DB 미변경.
  //   미매칭/모호(복수·isDefault 미확정)는 공란 유지(§14·§15). 사용자가 직접 수정한 값은 덮어쓰지 않는다(§11·§12).
  const autoMatchTranslationRate = async (i: number, translatorId: number, saleItemId: number | null) => {
    if (saleItemId == null) return;   // 판매 미연결(수동 추가) 행은 작업량·방향이 없어 매칭 대상 아님
    try {
      const res = await fetch(api(`/api/admin/performances/resolve-translation-rate?translatorId=${translatorId}&saleItemId=${saleItemId}`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.matched) return;   // 미매칭 → 공란 유지(§6·§14). 판매단가·타방향 fallback 없음.
      const qty = String(data.quantity); const unit = String(data.unit); const price = String(data.unitPrice);
      setRows(prev => prev.map((row, idx) => {
        if (idx !== i || row.individualUserId !== translatorId) return row;   // 그 사이 다른 선택이면 무시
        if (!isAutoRateOverwritable(row)) return row;                          // 사용자 직접수정 보호(§11·§12)
        const next: Row = { ...row, quantity: qty, unit, contractUnitPrice: price };
        next._autoRateSig = autoRateSig(next);   // 이번 자동입력값 서명 기록(다음 재매칭 시 미수정 판정)
        return next;
      }));
    } catch { /* 자동매칭 실패해도 로컬 선택은 유지 */ }
  };
  const pickVendor = (i: number, c: any) => {
    const r = rows[i];
    // 업체 정보(상호·업체유형·사업자번호)는 검색결과에 포함(비PII) — 로컬 반영만. 저장 시 서버가 스냅샷 재도출.
    patchRow(i, {
      performerCategory: 'vendor', vendorCompanyId: c.id, individualUserId: null,
      performerNameSnapshot: c.name, vendorTypeSnapshot: c.vendorType ?? null,
      identifierSnapshotMasked: c.businessNumber ?? null, lineCategory: r.lineCategory || '외주업체',
      residencyType: null, withholdingTreatment: 'tax_review_required',   // 외주업체 기본값: 세금계산서(기록용)
    });
    setSearchResults([]); setSearchIdx(null);
  };
  // 통합 구분 변경(§4·§6) — 선택값 → 상위유형(category)+세부라벨(lineCategory) 분해 저장.
  //   상위유형이 바뀌면 수행자·업체 선택 초기화 확인(§7·§13). 같은 상위유형 내 세부만 바뀌면 유지.
  const changePerformerType = (i: number, key: string) => {
    const r = rows[i];
    const opt = PERFORMER_TYPE_OPTS.find(o => o.value === key);
    if (!opt || key === resolvePerformerType(r)) return;
    const categoryChanged = opt.category !== r.performerCategory;
    const hasPerformer = !!(r.performerNameSnapshot || r.individualUserId || r.vendorCompanyId);
    if (categoryChanged && hasPerformer && !window.confirm('구분을 변경하면 현재 선택된 수행자 정보가 초기화됩니다. 변경하시겠습니까?')) return;
    patchRow(i, categoryChanged && hasPerformer
      ? { performerCategory: opt.category, lineCategory: opt.lineCategory, individualUserId: null, vendorCompanyId: null,
          performerNameSnapshot: null, identifierSnapshotMasked: null, vendorTypeSnapshot: null, residencyType: null, withholdingTreatment: null }
      : { performerCategory: opt.category, lineCategory: opt.lineCategory });
    setSearchIdx(i); setSearchResults([]);
  };

  const importFromSale = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances/import-from-sale`), { method: 'POST', headers: authH });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '판매정보 불러오기 실패'); return; }
      onToast(data.message ?? '불러오기 완료');
      // 불러온 행을 1인분 기준으로 정규화(§10-2) — 수행정보 1행 = 통번역사 1명 원칙에 따라 인원수를 1로 정규화한다.
      //   판매 공급가액 = 수행일수 × 인원수 × 계약단가이므로, 인원=1이면 기본수행료 = 공급가액/인원수(1인분)로 산정된다.
      //   복사(dupRow)와 동일한 perPersonSnapshot 로직을 사용하며, 원본 판매정보는 변경하지 않는다(저장 시 서버가 재계산).
      const toPerPerson = (p: any): Row => { const row = toRow(p); return { ...row, serviceDetailSnapshot: perPersonSnapshot(row.serviceDetailSnapshot) }; };
      // 교정된 기존 행(§8·§9)은 id로 로컬 상태에 병합, 신규 행은 목록 끝에 추가.
      const corrected = new Map(((data.correctedRows ?? []) as any[]).map(r => [r.id, toPerPerson(r)]));
      setRows(prev => [
        ...prev.map(r => (r.id != null && corrected.has(r.id) ? corrected.get(r.id)! : r)),
        ...((data.rows ?? []) as any[]).map(toPerPerson),
      ]);
      // §7 판매 비용상품 감지 → 해당 동적 기타비용 컬럼 자동 노출(빈 컬럼 pin). 판매금액은 지급비용으로 자동복사하지 않는다(금액 미복사).
      //   교통비·출장비는 전용 컬럼이므로 pin 대상 아님. 감지 실패해도 무해(사용자가 선택기로 직접 추가 가능).
      const detectEtc = (arr: any[]): string[] => {
        const found = new Set<string>();
        for (const p of arr) {
          const s = `${p?.productNameSnapshot ?? ''} ${p?.serviceType ?? ''} ${p?.languageOrServiceSnapshot ?? ''}`;
          if (/숙박/.test(s)) found.add('숙박비');
          if (/식비|식대/.test(s)) found.add('식비');
          if (/저작권/.test(s)) found.add('저작권료');
          if (/이동일/.test(s)) found.add('이동일보상');
          if (/취소\s*보상/.test(s)) found.add('취소보상');
        }
        return [...found];
      };
      const detected = detectEtc([...((data.rows ?? []) as any[]), ...((data.correctedRows ?? []) as any[])]);
      if (detected.length) setPinnedEtcCols(prev => Array.from(new Set([...prev, ...detected])));
      await onChanged();
    } catch { onToast('판매정보 불러오기 중 오류'); } finally { setBusy(false); }
  };

  const buildRowPayload = (r: Row, idx: number) => ({
    id: r.id, saleItemId: r.saleItemId ?? null, sequence: idx,
    performerCategory: r.performerCategory, lineCategory: canonicalLineCategory(r), status: r.status,
    performerNameSnapshot: r.performerNameSnapshot ?? null,
    serviceType: r.serviceType ?? null, productNameSnapshot: r.productNameSnapshot ?? null,
    serviceDetailSnapshot: r.serviceDetailSnapshot ?? null,
    languageOrServiceSnapshot: r.languageOrServiceSnapshot ?? null,
    performanceStartDate: r.performanceStartDate || null, performanceEndDate: r.performanceEndDate || null,
    deliveryDate: r.deliveryDate || null, deliveryDateManual: !!r.deliveryDateManual, deliveryConfirmed: !!r.deliveryConfirmed,
    expectedPaymentDate: r.expectedPaymentDate || null, actualPaymentDate: r.actualPaymentDate || null,
    memo: r.memo ?? null, remark: r.remark ?? null,
    contractUnitPrice: r.contractUnitPrice != null && r.contractUnitPrice !== '' ? num(r.contractUnitPrice) : null,
    quantity: r.quantity != null && r.quantity !== '' ? num(r.quantity) : null,
    unit: r.unit ?? null,
    isDirectAmount: r.performerCategory === 'expense' ? true : !!r.isDirectAmount,
    directAmount: r.directAmount != null && r.directAmount !== '' ? num(r.directAmount) : null,
    payDateManual: !!r.payDateManual, payDateChangeReason: r.payDateChangeReason ?? null,
    paymentStatus: r.paymentStatus ?? undefined,
    actualPaymentAmount: r.actualPaymentAmount != null && r.actualPaymentAmount !== '' ? num(r.actualPaymentAmount) : null,
    individualUserId: r.individualUserId ?? null, residencyType: r.residencyType ?? null, serviceCountry: r.serviceCountry ?? null,
    // 세금처리 — 레거시 값 정규화 + 외주업체 기본값(세금계산서) 반영해 저장. DB enum·계산 불변. 외주업체는 기록용(원천세 미적용).
    withholdingTreatment: effectiveTreatment(r) || null,
    withholdingRate: r.withholdingRate != null && r.withholdingRate !== '' ? num(r.withholdingRate) : null,
    baseFee: num(r.baseFee), transportationFee: num(r.transportationFee), businessTripFee: num(r.businessTripFee),
    copyrightFee: num(r.copyrightFee), travelDayCompensation: num(r.travelDayCompensation), cancellationCompensation: num(r.cancellationCompensation),
    vendorCompanyId: r.vendorCompanyId ?? null, purchaseEvidenceType: r.purchaseEvidenceType ?? null,
    purchaseInvoiceDate: r.purchaseInvoiceDate || null, supplyAmount: num(r.supplyAmount), vatAmountManual: num(r.vatAmount),
    expenses: (r.expenses ?? []).map(e => ({
      id: e.id, expenseType: e.expenseType, amount: num(e.amount), incurredDate: e.incurredDate || null,
      // 지급률 구조(§비용지급률) — 기준금액·지급률 동반 저장(있을 때만). amount=실제 지급액이라 정산 불변.
      baseAmount: e.baseAmount != null && e.baseAmount !== '' ? num(e.baseAmount) : null,
      payoutRate: e.payoutRate != null && e.payoutRate !== '' ? num(e.payoutRate) : null,
      includedInPayout: e.includedInPayout !== false, evidenceUrl: e.evidenceUrl ?? null, evidenceFileName: e.evidenceFileName ?? null, memo: e.memo ?? null,
    })),
    deductions: (r.deductions ?? []).map(d => ({ id: d.id, deductionType: d.deductionType, amount: num(d.amount), reason: d.reason ?? null })),
  });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const payload = { rows: rows.map(buildRowPayload), deletedIds };
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances`), { method: 'PUT', headers: authH, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '수행정보 저장 실패'); return; }
      onToast('수행정보가 저장되었습니다.');
      setEditMode(false); setRows([]); setDeletedIds([]); setAmountPopup(null); setAdjustPopup(null);
      setSummaryKey(k => k + 1);
      await onChanged();
    } catch { onToast('수행정보 저장 중 오류'); } finally { setBusy(false); }
  };

  // ── 조회화면 조정항목 즉시 저장(§1·§6) — 편집 없이 해당 1행만 전체 페이로드로 PUT. ──
  //   다른 필드는 현재 조회값 그대로 전송 → 서버가 동일 입력으로 재계산하므로 지급일·정산상태 등 불변(§7).
  //   서버가 원가합계를 재계산하고, onChanged() 재조회로 조회화면 금액·원가합계가 즉시 갱신됨.
  const saveViewAdjustment = async (viewIdx: number, p: Partial<Row>) => {
    if (busy) return;
    const target = viewRows[viewIdx];
    if (!target) return;
    setBusy(true);
    try {
      const merged = { ...target, ...p };
      const seqIdx = list.findIndex(x => x.id === target.id);   // sequence 보존(정렬/필터 무관하게 원본 순서 유지)
      const payload = { rows: [buildRowPayload(merged, seqIdx >= 0 ? seqIdx : viewIdx)], deletedIds: [] as number[] };
      const res = await fetch(api(`/api/admin/projects/${projectId}/performances`), { method: 'PUT', headers: authH, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '추가비용 저장 실패'); return; }
      onToast('추가비용이 저장되었습니다.');
      setSummaryKey(k => k + 1);
      await onChanged();
    } catch { onToast('추가비용 저장 중 오류'); } finally { setBusy(false); }
  };

  // ── 스타일 ──
  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 30, padding: '4px 8px', width: '100%' };
  const filterInp: React.CSSProperties = { ...dsInputStd(), minHeight: 30, padding: '3px 8px' };
  const catSel: React.CSSProperties = { ...inp, fontSize: 12, fontWeight: 400, minHeight: 30, padding: '4px 8px', lineHeight: '16px' };
  const catMenu: React.CSSProperties = { fontSize: 12 };
  const cellBg = C.bgCard;
  // 한 행 = 한 줄(§7). 살짝 높은 행 높이, 줄바꿈 금지.
  const tdBase: React.CSSProperties = { ...TYPO.inputValue, padding: '9px 8px', borderBottom: BD.divider, verticalAlign: 'middle', whiteSpace: 'nowrap', background: cellBg };
  const thBase: React.CSSProperties = { ...TYPO.gridHeader, padding: '0 8px 9px', borderBottom: BD.grid, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: cellBg, zIndex: 4, textAlign: 'left' };
  const tdR: React.CSSProperties = { ...tdBase, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  // 컬럼 너비. 행제어만 좌측 틀고정 유지(offset 0), 나머지는 일반 컬럼으로 좌우 스크롤.
  const LW = { control: 116, category: 118, performer: 176, product: 216 };   // 상품·업무 소폭 확대(긴 상품명 가독성)
  const L = { control: 0 };
  const RW = { cost: 130, pay: 118, remark: 260 };                            // cost=지급액(금액 4컬럼 동일폭) · remark=비고(최대폭 유지)
  const fzTd = (side: 'left' | 'right', offset: number, extra?: React.CSSProperties): React.CSSProperties =>
    ({ ...tdBase, position: 'sticky', [side]: offset, zIndex: 3, ...extra });
  const fzTh = (side: 'left' | 'right', offset: number, extra?: React.CSSProperties): React.CSSProperties =>
    ({ ...thBase, position: 'sticky', [side]: offset, zIndex: 6, ...extra });

  // 세금처리 조회 표시 — 3.3% / 원천징수 예외 / 세금계산서. 외주업체는 미설정 시 세금계산서 기본.
  const withholdingText = (r: Row) => {
    const t = effectiveTreatment(r);
    if (t === 'domestic_3_3') return '3.3%';
    if (t === 'domestic_2_2') return '2.2%';
    if (t === 'exempt') return '원천징수 예외';
    if (t === 'tax_review_required') return '세금계산서';
    return '미선택';
  };
  const numCell = (v: unknown, on: (val: string) => void, testid: string, label: string, disabled?: boolean) => (
    <input type="number" min={0} inputMode="numeric" disabled={disabled} data-testid={testid} aria-label={label}
      style={{ ...inp, textAlign: 'right', ...(disabled ? { background: C.g50, color: C.textSecondary } : {}) }}
      value={v == null || v === '' ? '' : String(v)} onChange={e => on(e.target.value)} />
  );
  // 계약단가 전용: 소수점 없이 천 단위 콤마 표시. 입력 시 숫자만 저장(콤마 자동), 저장은 숫자형 그대로.
  const priceCell = (v: unknown, on: (val: string) => void, testid: string, label: string, disabled?: boolean) => (
    <input type="text" inputMode="numeric" disabled={disabled} data-testid={testid} aria-label={label}
      style={{ ...inp, textAlign: 'right', ...(disabled ? { background: C.g50, color: C.textSecondary } : {}) }}
      value={commafy(v)} onChange={e => on(e.target.value.replace(/[^\d]/g, ''))} />
  );
  const muted = <span style={{ color: C.g400 }}>—</span>;
  const amtBtn = (label: React.ReactNode, on: () => void, testid: string, extra?: React.CSSProperties) => (
    <button type="button" onClick={on} data-testid={testid}
      style={{ ...inp, textAlign: 'right', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, background: cellBg, fontVariantNumeric: 'tabular-nums', ...extra }}>
      {label}<span style={{ color: C.primaryText, fontSize: 10 }}>✎</span>
    </button>
  );
  // 지급률 배지(§1·§2·§10) — 셀 금액 옆에 실제 적용 지급률 표시. 85%(협의) 강조(amber), 100%(실비·기본) 흐리게(gray).
  const rateBadge = (rate: number, type: string, i: number) => (
    <span data-testid={`perf-rate-badge-${type}-${i}`}
      style={{ fontSize: 9, fontWeight: 700, lineHeight: 1.4, padding: '0 4px', borderRadius: 4, flexShrink: 0,
        background: rate === 100 ? C.g100 : '#fef3c7', color: rate === 100 ? C.g400 : '#b45309' }}>{rate}%</span>
  );
  // 비용 셀(§비용지급률·§9·§1) — 실제 지급액(amount) + 지급률 배지. 편집: 클릭 시 지급률 팝업. 조회: 텍스트+배지.
  const costCell = (r: Row, i: number, type: string, label: string, editable: boolean) => {
    const e = (r.expenses ?? []).find(x => x.expenseType === type);
    const amt = expAmtOf(r, type);   // 실제 지급액
    const has = amt !== '' && amt != null;
    const rate = displayPayoutRate(type, e);
    const shown = has
      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>{won(amt)}원 {rateBadge(rate, type, i)}</span>
      : null;
    return editable
      ? amtBtn(shown ?? <span style={{ color: C.g400 }}>입력</span>, () => setRatePopup({ i, type, label }), `perf-cost-${type}-${i}`)
      : (has ? shown : muted);
  };

  const sortMark = (key: Exclude<SortKey, null>) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortBtn = (label: string, key: Exclude<SortKey, null>) => (
    <button type="button" onClick={() => { setSortKey(key); setSortDir(d => (sortKey === key && d === 'asc' ? 'desc' : 'asc')); }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit', padding: 0 }} aria-label={`${label} 정렬`}>
      {label}{sortMark(key)}
    </button>
  );

  // ── ERP 테이블 헤더 (조회·수정 공통 §16) ──
  const renderHeader = (editable: boolean, etcCols: string[] = [], emptyCols: Set<string> = new Set()) => (
    <thead><tr>
      <th style={fzTh('left', L.control, { width: LW.control, textAlign: 'center' })}>행제어</th>
      {/* '구분' 컬럼 제거(§2) — 수행자·업체 선택으로 유형이 이미 식별되므로 화면 표시 불필요. 내부 performerCategory 값은 유지. */}
      <th style={{ ...thBase, width: LW.performer }}>수행자·업체</th>
      <th style={{ ...thBase, width: LW.product }}>상품·업무</th>
      <th style={{ ...thBase, width: 330 }}>서비스별 상세정보</th>
      <th style={{ ...thBase, width: 136 }}>{editable ? '납품일 · 확인' : sortBtn('납품일', 'deliveryDate')}</th>
      <th style={{ ...thBase, width: 106 }}>{editable ? '지급일' : sortBtn('지급일', 'expectedPaymentDate')}</th>
      {/* 통역 전용 금액 컬럼(§1) — 요금(100%)·통역료(85%)·추가통역료·출장비·교통비·기타비용 */}
      <th style={{ ...thBase, width: 112, textAlign: 'right' }}>요금(100%)</th>
      <th style={{ ...thBase, width: 112, textAlign: 'right' }}>통역료(85%)</th>
      <th style={{ ...thBase, width: 112, textAlign: 'right' }}>추가통역료</th>
      <th style={{ ...thBase, width: 100, textAlign: 'right' }}>출장비</th>
      <th style={{ ...thBase, width: 100, textAlign: 'right' }}>교통비</th>
      {/* 동적 기타비용 컬럼(§1·§3·§5) — 전 행 합집합, 고정 컬럼과 기타비용 선택기 사이. 편집모드에서 미사용(데이터 없는) 컬럼은 ✕로 제거(§8). */}
      {etcCols.map(type => (
        <th key={`etc-h-${type}`} style={{ ...thBase, width: 96, textAlign: 'right' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, justifyContent: 'flex-end' }}>
            {etcColLabel(type)}
            {editable && emptyCols.has(type) && (
              <button type="button" onClick={() => removeEtcCol(type)} aria-label={`${etcColLabel(type)} 컬럼 제거`} title="컬럼 제거(사용 중인 행 없음)"
                data-testid={`etc-col-remove-${type}`}
                style={{ border: 'none', background: 'none', color: C.g400, cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0 }}>✕</button>
            )}
          </span>
        </th>
      ))}
      {/* 기타비용 선택기 컬럼(§1·§4) — 항상 마지막 위치(동적 컬럼들의 오른쪽). */}
      <th style={{ ...thBase, width: 116, textAlign: 'center' }}>기타비용</th>
      {/* 번역 전용 금액 컬럼(§1) — 수량·단위·단가 */}
      <th style={{ ...thBase, width: 86, textAlign: 'right' }}>수량</th>
      <th style={{ ...thBase, width: 80, textAlign: 'center' }}>단위</th>
      <th style={{ ...thBase, width: 112, textAlign: 'right' }}>단가</th>
      {/* 지급액 세전/세후 분리(§1) — 세전=수행원가(정산·수익률 기준), 세후=원천세 공제 후 실송금액 */}
      <th style={{ ...thBase, width: RW.cost, textAlign: 'right' }}>{editable ? '지급액(세전)' : sortBtn('지급액(세전)', 'costTotal')}</th>
      <th style={{ ...thBase, width: RW.cost, textAlign: 'right' }}>지급액(세후)</th>
      {/* 세금처리 — 4컬럼보다 약간 넓게 + 좌측 여백(paddingLeft)으로 지급액과 명확히 분리 */}
      <th style={{ ...thBase, width: 156, paddingLeft: 20 }}>세금처리</th>
      <th style={{ ...thBase, width: RW.pay }}>지급상태</th>
      {/* 수익률%(§4) — 지급상태 오른쪽. 판매 공급가액 대비 세전 수행원가 마진율 */}
      <th style={{ ...thBase, width: 92, textAlign: 'right' }}>수익률%</th>
      <th style={{ ...thBase, width: RW.remark }}>비고</th>
    </tr></thead>
  );

  // ── ERP 테이블 행 (조회·수정 공통) ──
  const renderRow = (r: Row, i: number, editable: boolean, bySale?: Map<number, { cost: number; assigned: boolean }>, etcCols: string[] = []) => {
    const cost = calcRowCostPreview(r);
    const adjTotal = cost.expenseTotal - cost.deductionTotal;   // 조정합계 = 추가(+) − 차감(-)
    // 지급액 세전/세후(§1·§2) — 세전=수행원가(costTotal), 세후=세전×(1−원천세율). 미선택 시 세율 0 → 세후=세전.
    const before = cost.costTotal;
    const after = afterTaxPayout(before, r);
    // 수익률(§5·§8) — 같은 판매상품(saleItemId) 연결행들의 세전 합계를 원가로 사용. 공급가액은 판매 스냅샷 구조화 필드(§7).
    const saleSupply = num((r.serviceDetailSnapshot ?? {}).saleSupplyAmount);
    const agg = r.saleItemId != null ? bySale?.get(r.saleItemId) : undefined;
    const groupCost = agg ? agg.cost : before;
    const assigned = agg ? agg.assigned : (r.individualUserId != null || r.vendorCompanyId != null);
    // 미배정+원가 0원은 '미입력'으로 보고 수익률 미표시(§11). 공급가액 없음/0도 미표시(§10). 그 외(음수 포함) 표시(§12).
    const profit = (assigned || groupCost > 0) ? profitRatePct(saleSupply, groupCost) : null;
    const cat = r.performerCategory;
    const isIndiv = cat === 'individual';
    // 유형별 금액 컬럼 분기(§2·§9·§11) — 개인 통역/번역만 신규 구조 적용. 외주·경비·장비는 기존 표시 유지.
    const isInterp = isIndiv && isInterpretationKind(r);
    const isTrans = isIndiv && isTranslationKind(r);
    const isEquip = isEquipmentKind(r);                         // 장비: 단가×수량(번역 단가/수량 컬럼 재사용)
    const isOtherAmt = !isInterp && !isTrans && !isEquip;       // 외주·경비·일반개인: 요금(100%) 컬럼에 금액상세 팝업 폴백
    const locked = isDateLocked(r);
    const deletable = canDelete(r);
    const dateTitle = locked ? '지급 진행 행은 수정 불가' : '';
    const payShown = dateVal(r.expectedPaymentDate) || (r.payDateManual ? '' : (calcPaymentDate(r.deliveryDate, isHoliday) ?? ''));
    // 납품확인(§5·§13) — 확인 전(미입력·미확인 공통)은 붉은색 경고 / 확인완료만 본문색+✓.
    //   번역은 판매에 종료일이 없어 납품일이 비어 시작하므로, 미입력도 붉은색으로 경고해 입력·확인 누락을 방지한다.
    const dConfirmed = !!r.deliveryConfirmed;
    const dColor = dConfirmed ? C.textPrimary : C.danger;
    const dTitle = !r.deliveryDate ? '납품일 미입력 — 납품일 입력 후 확인 필요' : (dConfirmed ? (r.deliveryConfirmedAt ? `확인완료 · ${dateVal(r.deliveryConfirmedAt)}` : '확인완료') : '담당 PM 납품확인 전');
    return (
      <tr key={rowKey(r, i)}>
        {/* 행제어만 좌측 고정 유지 */}
        <td style={fzTd('left', L.control, { width: LW.control })}>
          {editable
            ? <RowControls idx={i} total={rows.length} onRemove={removeRow} onAddBelow={insertBelow}
                onMoveUp={x => moveRow(x, 'up')} onMoveDown={x => moveRow(x, 'down')}
                onDuplicate={dupRow} duplicateTestId={`perf-dup-${i}`}
                removeDisabled={!deletable} removeTitle={deletable ? '행 삭제' : '지급 진행 행은 삭제 불가'} />
            : <span style={{ ...TYPO.helper, display: 'block', textAlign: 'center' }}>{i + 1}</span>}
        </td>
        {/* '구분' 셀 제거(§2·§3) — 수행자·업체 선택 시 대상 자체로 내부 유형 판별. 사용자 별도 선택 단계 없음. */}
        <td style={{ ...tdBase, width: LW.performer }}>
          {editable
            ? <InlinePerformerPicker r={r} i={i} searchIdx={searchIdx} searchResults={searchResults}
                onSearchTranslator={onSearchTranslator} onSearchVendor={onSearchVendor}
                onPickTranslator={pickTranslator} onPickVendor={pickVendor} onClear={onClearPerformer}
                onCancelChange={() => { setSearchIdx(null); setSearchResults([]); }} patch={(p) => patchRow(i, p)}
                fetchRecentPerformances={fetchRecentPerformances} />
            : <span>{r.performerNameSnapshot || muted}</span>}
        </td>
        <td style={{ ...tdBase, width: LW.product }}>
          {editable
            ? <input style={inp} value={r.productNameSnapshot ?? ''} onChange={e => patchRow(i, { productNameSnapshot: e.target.value })} placeholder="상품·업무명" data-testid={`perf-name-${i}`} aria-label="상품·업무명" />
            : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', maxWidth: LW.product - 12 }} title={r.productNameSnapshot ?? ''}>{r.productNameSnapshot || '—'}</span>}
        </td>
        {/* 가운데 가로스크롤 — 서비스 유형별 상세정보(§3~§9·§14·§17) */}
        <td style={{ ...tdBase, minWidth: 330 }}>
          <ServiceDetailCell r={r} editable={editable} patch={(p) => patchRow(i, p)} onEndDateChange={editable ? (v) => changeServiceEndDate(i, v) : undefined} />
        </td>
        {/* 납품일 + 담당 PM 확인 체크(§4·§5·§13·§16) — 미확인 붉은색, 한 줄 유지 */}
        <td style={tdBase}>
          {editable ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
              <input type="date" style={{ ...inp, width: 122, color: dColor, ...(!dConfirmed ? { borderColor: C.danger } : {}) }}
                value={dateVal(r.deliveryDate)} disabled={locked} onChange={e => changeDelivery(i, e.target.value)}
                data-testid={`perf-delivery-row-${i}`} aria-label="납품일" title={dateTitle || dTitle} />
              <input type="checkbox" checked={dConfirmed} disabled={!canConfirmDelivery || !r.deliveryDate || locked}
                onChange={() => toggleDeliveryConfirm(i)} data-testid={`perf-delivery-confirm-${i}`} aria-label="담당 PM 납품확인" title={dTitle}
                style={{ cursor: (!canConfirmDelivery || !r.deliveryDate || locked) ? 'default' : 'pointer' }} />
            </div>
          ) : (
            <span style={{ color: dColor, whiteSpace: 'nowrap' }} title={dTitle}>{r.deliveryDate ? dateVal(r.deliveryDate) : '미입력'}{r.deliveryDate && dConfirmed ? ' ✓' : ''}</span>
          )}
        </td>
        <td style={tdBase}>
          {editable
            ? <input type="date" style={{ ...inp, ...(r.payDateManual ? {} : { background: C.g50 }) }} disabled={locked} value={payShown}
                onChange={e => changePayDate(i, e.target.value)} data-testid={`perf-paydate-row-${i}`} aria-label="지급일"
                title={locked ? dateTitle : (r.payDateManual ? '수동변경' : '자동계산(납품일 기준·직전 영업일)')} />
            : <span title={r.payDateManual ? '수동변경' : '자동계산'} style={{ color: dateVal(r.expectedPaymentDate) ? undefined : C.g400 }}>{payShown || '—'}</span>}
        </td>
        {/* ⑧ 요금(100%) — 통역: 독립 입력(통역료 자동계산 없음). 번역: 협의 총액(§3·§4A, base=directAmount). 외주·경비·일반개인: 금액상세 팝업. 장비: '-'. */}
        <td style={tdR}>
          {isInterp
            ? (editable ? priceCell(r.contractUnitPrice, v => setInterpFee100(i, v), `perf-fee100-${i}`, '요금(100%)') : (r.contractUnitPrice != null && r.contractUnitPrice !== '' ? `${won(r.contractUnitPrice)}원` : muted))
            : isTrans
              ? (editable ? priceCell(r.directAmount, v => setTransFee100(i, v), `perf-fee100-${i}`, '요금(100%)') : (r.isDirectAmount && r.directAmount != null && r.directAmount !== '' ? `${won(r.directAmount)}원` : muted))
              : isOtherAmt
                ? (editable ? amtBtn(`${won(cost.base)}원`, () => setAmountPopup(i), `perf-amount-${i}`) : `${won(cost.base)}원`)
                : muted}
        </td>
        {/* ⑨ 통역료(85%) — 독립 입력(자동계산 없음, 요금과 역산 안 함). 셀은 입력한 '기준금액' 그대로 표시(§8). 지급액 세전은 이 값×0.85(cost.base). 통역 전용. */}
        <td style={tdR}>
          {isInterp ? (editable ? priceCell(r.directAmount, v => patchRow(i, { directAmount: v, isDirectAmount: true }), `perf-fee85-${i}`, '통역료(85%)') : (r.directAmount != null && r.directAmount !== '' ? `${won(r.directAmount)}원` : muted)) : muted}
        </td>
        {/* ⑩ 추가통역료 — expenses['수가통역료']. 셀 클릭→지급률 팝업(기본 85%). 실제 지급액 표시. 통역 전용. */}
        <td style={tdR}>{isInterp ? costCell(r, i, INTERP_ADD_FEE_TYPE, '추가통역료', editable) : muted}</td>
        {/* ⑪ 출장비 — expenses['출장비']. 지급률 기본 85%. 통역 전용. */}
        <td style={tdR}>{isInterp ? costCell(r, i, INTERP_BIZTRIP_TYPE, '출장비', editable) : muted}</td>
        {/* ⑫ 교통비 — expenses['교통비']. 지급률 기본 100%(실비, §8). 통역 전용. */}
        <td style={tdR}>{isInterp ? costCell(r, i, INTERP_TRANSPORT_TYPE, '교통비', editable) : muted}</td>
        {/* ⑬ 동적 기타비용 컬럼(§3·§5) — 각 컬럼 = expenses[]의 특정 expenseType. 개인은 지급률 팝업(실제 지급액 표시), 그 외 읽기전용. */}
        {etcCols.map(type => {
          const amt = expAmtOf(r, type);
          return (
            <td key={`etc-c-${type}-${i}`} style={tdR}>
              {isIndiv
                ? costCell(r, i, type, etcColLabel(type), editable)
                : (amt !== '' ? `${won(amt)}원` : muted)}
            </td>
          );
        })}
        {/* ⑭ 기타비용 선택기(§1·§4) — 항상 마지막. 개인: 항목 선택→동적 컬럼 추가 / 직접입력 / 차감·상세 팝업. 외주·장비·일반개인: 기존 추가비용(+/-) 팝업 유지. */}
        <td style={{ ...tdBase, textAlign: 'center' }}>
          {isIndiv
            ? (editable
                ? <span data-testid={`perf-etc-select-${i}`}>
                    <ClickSelect value="" placeholder="기타비용" triggerStyle={{ ...inp, minWidth: 96 }}
                      options={[
                        ...ETC_SELECTABLE_TYPES.filter(o => !etcCols.includes(o.value)),
                        { value: CUSTOM_EXPENSE_VALUE, label: '직접입력' },
                        { value: '__detail__', label: '차감 · 상세…' },
                      ]}
                      onChange={(v: string) => {
                        if (v === CUSTOM_EXPENSE_VALUE) addCustomEtcCol(etcCols);
                        else if (v === '__detail__') setAdjustPopup(i);
                        else addEtcCol(v);
                      }} />
                  </span>
                : amtBtn('상세', () => setAdjustViewPopup(i), `perf-etc-view-${i}`))
            : (isOtherAmt || isEquip)
                ? (adjTotal === 0 ? muted : (editable ? amtBtn(`${won(adjTotal)}원`, () => setAdjustPopup(i), `perf-adj-${i}`) : amtBtn(`${won(adjTotal)}원`, () => setAdjustViewPopup(i), `perf-adj-view-${i}`)))
                : muted}
        </td>
        {/* ⑭ 수량 — 번역/장비 전용. */}
        <td style={tdR}>
          {(isTrans || isEquip)
            ? (editable
                ? <input type="number" min={0} inputMode="numeric" data-testid={`perf-qty-${i}`} aria-label="수량"
                    style={{ ...inp, textAlign: 'right' }}
                    value={r.quantity == null || r.quantity === '' ? '' : String(r.quantity)} onChange={e => patchRow(i, { quantity: e.target.value })} />
                : <span>{r.quantity != null && r.quantity !== '' ? won(r.quantity) : muted}</span>)
            : muted}
        </td>
        {/* ⑮ 단위 — 번역: 글자/단어 선택. 장비: 저장 단위 표시(읽기전용). */}
        <td style={{ ...tdBase, textAlign: 'center' }}>
          {isTrans
            ? (editable
                ? <ClickSelect value={TRANS_UNIT_OPTS.some(o => o.value === r.unit) ? (r.unit as string) : ''} onChange={(v: string) => patchRow(i, { unit: v })} triggerStyle={{ ...inp, minWidth: 64 }} options={TRANS_UNIT_OPTS} />
                : <span>{r.unit || muted}</span>)
            : isEquip ? <span>{r.unit || muted}</span> : muted}
        </td>
        {/* ⑯ 단가 — 번역/장비 전용(계약단가). */}
        <td style={tdR}>
          {(isTrans || isEquip)
            ? (editable ? priceCell(r.contractUnitPrice, v => patchRow(i, { contractUnitPrice: v }), `perf-unitprice-${i}`, '단가') : (r.contractUnitPrice != null && r.contractUnitPrice !== '' ? `${won(r.contractUnitPrice)}원` : muted))
            : muted}
        </td>
        {/* 지급액(세전) — 수행원가(정산·수익률 기준 §3·§6). 기존 지급액값 그대로. */}
        <td style={{ ...tdR, width: RW.cost, fontWeight: 700, color: C.primaryText }}>{won(before)}원</td>
        {/* 지급액(세후) — 세전 × (1−원천세율). 실제 송금 기준(§3). 세율 0이면 세전과 동일. */}
        <td style={{ ...tdR, width: RW.cost }} title="세전 × (1 − 원천세율)">{won(after)}원</td>
        {/* 세금처리 — 통번역사·외주업체 공통 드롭다운(3.3% / 원천징수 예외 / 세금계산서). 외주업체는 기록용(지급액 불변) */}
        {/* paddingLeft 20 — 헤더와 동일. 지급액(우측정렬 금액)과 세금처리 사이 여백 확보(붙어 보임 방지) */}
        <td style={{ ...tdBase, paddingLeft: 20 }}>
          {(isIndiv || cat === 'vendor')
            ? (editable
                ? <ClickSelect value={effectiveTreatment(r)} onChange={(v: string) => patchRow(i, { withholdingTreatment: v })} triggerStyle={catSel} menuStyle={catMenu} options={TREATMENT_OPTS} />
                : <span style={{ fontSize: 12 }}>{withholdingText(r)}</span>)
            : muted}
        </td>
        <td style={{ ...tdBase, width: RW.pay }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
            {/* 지급완료(paid)는 직접 선택·변경 불가 → 배지로 표시만. 정산 지급회차 처리로만 변경된다. */}
            {editable && (r.paymentStatus ?? 'unpaid') !== 'paid'
              ? <ClickSelect value={r.paymentStatus ?? 'unpaid'} onChange={(v: string) => patchRow(i, { paymentStatus: v })} triggerStyle={inp} options={PAYMENT_STATUS_SELECTABLE_OPTS} />
              : <PaymentBadge value={r.paymentStatus} />}
            {/* §18 회차 배정 표시(최소) — 지급회차에 포함된 건 표기. 상세는 정산 화면에서 관리. */}
            {r.payoutRoundId != null && (
              <span title={`지급회차 배정됨 (#${r.payoutRoundId}) — 정산 화면에서 관리`} aria-label="지급회차 배정됨"
                style={{ ...TYPO.helper, color: C.primaryText, background: C.primaryBg, borderRadius: 5, padding: '1px 5px', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>회차</span>
            )}
          </div>
        </td>
        {/* 수익률%(§4·§5) — (공급가액 − 세전원가합계) ÷ 공급가액 × 100. 계산불가/미입력은 '—'. 적자(음수)만 붉은색(과도한 강조 없음 §13). */}
        <td style={{ ...tdR, width: 92 }} title={profit == null ? '판매 공급가액 없음 또는 원가 미입력 — 계산불가' : '(판매 공급가액 − 세전 수행원가 합계) ÷ 판매 공급가액'}>
          {profit == null
            ? muted
            : <span style={{ fontWeight: 600, color: profit < 0 ? C.danger : C.textPrimary }}>{profit.toFixed(1)}%</span>}
        </td>
        {/* 비고(§16) — 사용자 자유입력 운영 메모. remark 컬럼 연동 저장·조회. 계산·정산 로직 미반영. */}
        <td style={{ ...tdBase, width: RW.remark }}>
          {editable
            ? <input style={inp} value={r.remark ?? ''} onChange={e => patchRow(i, { remark: e.target.value })} placeholder="비고" data-testid={`perf-remark-${i}`} aria-label="비고" />
            : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', maxWidth: RW.remark - 12 }} title={r.remark ?? ''}>{r.remark || muted}</span>}
        </td>
      </tr>
    );
  };

  const BASE_COLSPAN = 21;
  const erpTable = (data: Row[], editable: boolean, emptyMsg: string) => {
    // 판매상품(saleItemId)별 세전 지급액 합계 + 배정여부(§8) — 복수 수행자 시 상품 수익률 계산 기준.
    //   같은 판매상품에 연결된 모든 수행행의 세전(costTotal)을 합산하고, 하나라도 수행자 배정이면 assigned=true.
    const bySale = new Map<number, { cost: number; assigned: boolean }>();
    for (const r of data) {
      if (r.saleItemId == null) continue;
      const prev = bySale.get(r.saleItemId) ?? { cost: 0, assigned: false };
      prev.cost = round2(prev.cost + calcRowCostPreview(r).costTotal);
      if (r.individualUserId != null || r.vendorCompanyId != null) prev.assigned = true;
      bySale.set(r.saleItemId, prev);
    }
    // 동적 기타비용 컬럼(§5) — 전 행 합집합(+ 편집모드는 사용자 pin). 미사용(데이터 없는) 컬럼은 편집모드에서 ✕ 제거 가능(§8).
    const etcCols = computeEtcCols(data, editable ? pinnedEtcCols : []);
    const emptyCols = new Set(etcCols.filter(t => etcColIsEmpty(data, t)));
    const COLSPAN = BASE_COLSPAN + etcCols.length;
    const minW = 2894 + etcCols.length * 96;   // 동적 컬럼당 최소폭 96(§12 compact 유지)
    return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 620, border: `1px solid ${C.g200}`, borderRadius: BD.radius.md }}>
      <table style={{ borderCollapse: 'collapse', minWidth: minW, width: 'max-content' }}>
        {renderHeader(editable, etcCols, emptyCols)}
        <tbody>
          {data.map((r, i) => renderRow(r, i, editable, bySale, etcCols))}
          {data.length === 0 && (
            <tr><td colSpan={COLSPAN} style={{ ...tdBase, textAlign: 'center', color: C.g400, padding: '20px 8px' }}>{emptyMsg}</td></tr>
          )}
        </tbody>
      </table>
    </div>
    );
  };

  // ── 헤더 ──
  const header = (
    <div style={{ ...TYPO.sectionTitle, paddingBottom: SP[4], borderBottom: BD.grid, marginBottom: SP[5], display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
      <span style={{ width: 22, height: 22, borderRadius: BD.radius.md, background: '#fef3c7', color: '#b45309', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>C</span>
      수행정보
      <span style={{ ...TYPO.helper, marginLeft: SP[2] }}>수행자·외주업체 배정, 원가·지급 관리 (한 줄 입력 · 좌우 스크롤)</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {editMode ? (
          <>
            <GhostBtn onClick={importFromSale} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-perf-import" aria-label="판매정보 불러오기">판매정보 불러오기</GhostBtn>
            <GhostBtn onClick={() => addRow('individual', '통번역사')} disabled={busy} style={{ fontSize: 12, padding: '6px 10px' }} data-testid="btn-perf-add-individual" aria-label="수행자 추가">+ 통번역사</GhostBtn>
            <GhostBtn onClick={() => addRow('vendor', '외주업체')} disabled={busy} style={{ fontSize: 12, padding: '6px 10px' }} data-testid="btn-perf-add-vendor" aria-label="외주업체 추가">+ 외주업체</GhostBtn>
            <GhostBtn onClick={() => addRow('expense', '경비')} disabled={busy} style={{ fontSize: 12, padding: '6px 10px' }} data-testid="btn-perf-add-expense" aria-label="원가항목 추가">+ 원가항목</GhostBtn>
            <GhostBtn onClick={cancelEdit} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-perf-cancel" aria-label="취소">취소</GhostBtn>
            <PrimaryBtn onClick={save} disabled={busy} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-perf-save" aria-label="수행정보 저장">{busy ? '저장 중…' : '저장'}</PrimaryBtn>
          </>
        ) : (
          <GhostBtn onClick={enterEdit} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="btn-perf-edit" aria-label="수행정보 수정">✏ 수행정보 수정</GhostBtn>
        )}
      </div>
    </div>
  );

  // ── 필터바 (조회모드) ──
  const filterBar = (
    <div style={{ display: 'flex', gap: SP[3], flexWrap: 'wrap', alignItems: 'center', marginBottom: SP[4] }}>
      <input style={{ ...filterInp, width: 200 }} placeholder="수행자·업체·상품 검색" value={q} onChange={e => setQ(e.target.value)} data-testid="perf-filter-q" aria-label="수행정보 검색" />
      <ClickSelect value={catFilter} onChange={setCatFilter} triggerStyle={{ ...filterInp, minWidth: 110 }} options={[{ value: '', label: '전체 구분' }, ...CATEGORY_OPTS]} />
      <ClickSelect value={payFilter} onChange={setPayFilter} triggerStyle={{ ...filterInp, minWidth: 120 }} options={[{ value: '', label: '전체 지급상태' }, ...PAYMENT_STATUS_OPTS]} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...TYPO.helper, cursor: 'pointer' }}>
        <input type="checkbox" checked={onlyUnpaid} onChange={e => setOnlyUnpaid(e.target.checked)} aria-label="미지급만" /> 미지급만
      </label>
      {(q || catFilter || payFilter || onlyUnpaid || sortKey) && (
        <button type="button" onClick={() => { setQ(''); setCatFilter(''); setPayFilter(''); setOnlyUnpaid(false); setSortKey(null); }}
          style={{ ...TYPO.helper, background: 'none', border: 'none', color: C.primaryText, cursor: 'pointer' }}>필터 초기화</button>
      )}
      <span style={{ ...TYPO.helper, marginLeft: 'auto' }}>{viewRows.length} / {list.length}건</span>
    </div>
  );

  const popupRow = amountPopup != null ? rows[amountPopup] : (adjustPopup != null ? rows[adjustPopup] : null);

  return (
    <Card>
      {header}

      {/* ── 조회모드 (수정과 동일 컬럼 구조 §16) ── */}
      {!editMode && (
        <>
          {filterBar}
          {erpTable(viewRows, false, list.length === 0 ? '등록된 수행정보가 없습니다. 「수행정보 수정 → 판매정보 불러오기」로 시작하세요.' : '필터 조건에 맞는 항목이 없습니다.')}
          <PerformanceProfitSummary projectId={projectId} token={token} refreshKey={summaryKey} />
        </>
      )}

      {/* ── 수정모드 ── */}
      {editMode && (
        <>
          {erpTable(rows, true, '등록된 수행자·외주업체·원가항목이 없습니다. 상단의 「+ 수행자 / 외주업체 / 원가항목」 또는 「판매정보 불러오기」로 추가하세요.')}
          <div style={{ ...TYPO.helper, marginTop: SP[3] }}>
            ※ 기본수행료·추가비용 셀을 클릭하면 소형 팝업에서 상세 입력합니다. 추가비용은 교통비·출장비·직접입력 등 추가(+)와 차감(-)을 통합 관리하며, 지급액 = 기본수행료 + 추가비용 합계로 자동 계산됩니다. 저장 시 서버가 원가·원천세·부가세를 재계산합니다.
          </div>
        </>
      )}

      {/* 금액상세 팝업(§금액입력) */}
      {editMode && amountPopup != null && popupRow && (
        <AmountDetailPopup r={popupRow} patch={(p) => patchRow(amountPopup, p)} onClose={() => setAmountPopup(null)} />
      )}
      {/* 비용항목 지급률 팝업(§비용지급률·§9) — 기준금액×지급률=실제지급액. 기존 데이터(지급률 null)는 100%로 취급(§11), 신규는 항목별 기본율. */}
      {editMode && ratePopup != null && rows[ratePopup.i] && (() => {
        const r = rows[ratePopup.i];
        const e = (r.expenses ?? []).find(x => x.expenseType === ratePopup.type);
        const fixed100 = isFixed100Type(ratePopup.type);   // 교통비·숙박비·식비 = 100% 고정(§4·§5)
        const base = e ? expenseBase(e) : null;
        const rate = fixed100 ? 100 : (e ? (e.payoutRate != null && e.payoutRate !== '' ? num(e.payoutRate) : 100) : defaultPayoutRate(ratePopup.type));
        return <RatePopup label={ratePopup.label} expenseType={ratePopup.type} base={base} rate={rate} fixed100={fixed100}
          onConfirm={(b, rt) => setExpFull(ratePopup.i, r, ratePopup.type, b, fixed100 ? 100 : rt)}
          onClose={() => setRatePopup(null)} />;
      })()}
      {/* 조정항목 팝업(§4~§8) — 추가(+)·차감(-) 통합 입력, 확인 시 커밋 */}
      {editMode && adjustPopup != null && popupRow && (() => {
        const indiv = popupRow.performerCategory === 'individual';
        const interp = indiv && isInterpretationKind(popupRow);          // 통역: 전용3종 제외
        const etcMode = interp || (indiv && isTranslationKind(popupRow)); // 통역·번역: 기타비용 팝업(저작권료 등)
        return <AdjustmentPopup r={popupRow} patch={(p) => patchRow(adjustPopup, p)} onClose={() => setAdjustPopup(null)}
          excludeTypes={interp ? INTERP_DEDICATED_EXPENSE_TYPES : undefined} addDefaultType={etcMode ? INTERP_ETC_DEFAULT_TYPE : undefined} title={etcMode ? '기타비용' : undefined}
          hideSelectTypes={etcMode ? INTERP_DEDICATED_EXPENSE_TYPES : undefined} />;
      })()}
      {/* 조정항목(조회화면 즉시 수정, §1·§2·§6) — 수정화면과 동일한 공통 AdjustmentPopup. 확인 시 해당 1행만 즉시 저장 */}
      {!editMode && adjustViewPopup != null && viewRows[adjustViewPopup] && (() => {
        const vr = viewRows[adjustViewPopup];
        const indiv = vr.performerCategory === 'individual';
        const interp = indiv && isInterpretationKind(vr);
        const etcMode = interp || (indiv && isTranslationKind(vr));
        return <AdjustmentPopup r={vr} patch={(p) => saveViewAdjustment(adjustViewPopup, p)} onClose={() => setAdjustViewPopup(null)}
          excludeTypes={interp ? INTERP_DEDICATED_EXPENSE_TYPES : undefined} addDefaultType={etcMode ? INTERP_ETC_DEFAULT_TYPE : undefined} title={etcMode ? '기타비용' : undefined}
          hideSelectTypes={etcMode ? INTERP_DEDICATED_EXPENSE_TYPES : undefined} />;
      })()}

      {/* 납품일 변경/삭제 시 수동 지급일 보호 확인창(§10-2·§13) — 3방향 선택 */}
      {dateConfirm && (() => {
        const dc = dateConfirm;
        const isClear = dc.kind === 'clear';
        const close = () => setDateConfirm(null);
        const keep = () => { patchRow(dc.idx, isClear ? { deliveryDate: '', deliveryDateManual: true, deliveryConfirmed: false } : { deliveryDate: dc.newDelivery, deliveryDateManual: true, deliveryConfirmed: false }); close(); };
        const apply = () => {
          patchRow(dc.idx, isClear
            ? { deliveryDate: '', expectedPaymentDate: null, payDateManual: false, payDateChangeReason: null, deliveryDateManual: true, deliveryConfirmed: false }
            : { deliveryDate: dc.newDelivery, expectedPaymentDate: dc.auto, payDateManual: false, payDateChangeReason: null, deliveryDateManual: true, deliveryConfirmed: false });
          close();
        };
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9700, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onMouseDown={close}>
            <div onMouseDown={e => e.stopPropagation()} style={{ background: C.bgCard, borderRadius: 12, padding: 20, width: 440, maxWidth: '90vw', boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
              <div style={{ ...TYPO.sectionTitle, marginBottom: 10 }}>지급일 확인</div>
              <div style={{ ...TYPO.inputValue, color: C.textSecondary, lineHeight: 1.6, marginBottom: 16 }}>
                {isClear
                  ? '납품일을 삭제하면 자동 지급일 계산 기준이 없어집니다. 현재 지급일도 초기화하시겠습니까?'
                  : '지급일이 수동으로 변경되어 있습니다. 납품일 기준으로 지급일을 다시 계산하시겠습니까?'}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <GhostBtn onClick={close} style={{ fontSize: 12, padding: '6px 12px' }} aria-label="취소">취소</GhostBtn>
                <GhostBtn onClick={keep} style={{ fontSize: 12, padding: '6px 12px' }} aria-label={isClear ? '지급일 유지' : '현재 지급일 유지'}>{isClear ? '지급일 유지' : '현재 지급일 유지'}</GhostBtn>
                <PrimaryBtn onClick={apply} style={{ fontSize: 12, padding: '6px 12px' }} aria-label={isClear ? '함께 초기화' : '다시 계산'}>{isClear ? '함께 초기화' : '다시 계산'}</PrimaryBtn>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 서비스 종료일 변경 시 수동/확인 납품일 보호 확인창(§8) */}
      {endSync && (() => {
        const es = endSync;
        const close = () => setEndSync(null);
        const keepEnd = () => { patchRow(es.idx, { performanceEndDate: es.newEnd }); close(); };  // 종료일만 변경, 납품일 유지
        const applyEnd = () => {
          const pay = calcPaymentDate(es.newDelivery, isHoliday);
          patchRow(es.idx, { performanceEndDate: es.newEnd, deliveryDate: es.newDelivery, deliveryDateAuto: es.newDelivery, deliveryDateManual: false, deliveryConfirmed: false, expectedPaymentDate: pay, payDateManual: false });
          close();
        };
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9700, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onMouseDown={close}>
            <div onMouseDown={e => e.stopPropagation()} style={{ background: C.bgCard, borderRadius: 12, padding: 20, width: 460, maxWidth: '90vw', boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
              <div style={{ ...TYPO.sectionTitle, marginBottom: 10 }}>납품일 확인</div>
              <div style={{ ...TYPO.inputValue, color: C.textSecondary, lineHeight: 1.6, marginBottom: 16 }}>
                서비스 종료일이 변경되었습니다. 납품일도 새 종료일({es.newDelivery || '없음'})로 변경하시겠습니까? 변경 시 납품확인은 해제되고 지급일이 재계산됩니다.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <GhostBtn onClick={close} style={{ fontSize: 12, padding: '6px 12px' }} aria-label="취소">취소</GhostBtn>
                <GhostBtn onClick={keepEnd} style={{ fontSize: 12, padding: '6px 12px' }} aria-label="현재 납품일 유지">현재 납품일 유지</GhostBtn>
                <PrimaryBtn onClick={applyEnd} style={{ fontSize: 12, padding: '6px 12px' }} aria-label="납품일 변경">변경</PrimaryBtn>
              </div>
            </div>
          </div>
        );
      })()}
    </Card>
  );
}
