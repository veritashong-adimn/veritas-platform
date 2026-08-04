// ─────────────────────────────────────────────────────────────────────────────
// 결제정보 (고객 수금) 섹션 — 판매 상세 D 섹션.
//  · "고객으로부터 얼마를·언제·어떤 방식으로 받았는지" 관리. 통번역사 지급(수행정보)과는 별개.
//  · 저장은 PUT /admin/projects/:id/payment-records (rows + deletedIds). 회차는 서버가 자동번호.
//  · 미수금은 저장하지 않고 화면 계산(총 판매금액 − 총 입금액). 향후 세금계산서·카드매출·자동매칭·채권관리 연계 대비.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useMemo, useState, useEffect } from 'react';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';

interface PayRow {
  id?: number;
  issueDate?: string | null;         // 발행일(세금계산서 발행일)
  expectedDate?: string | null;      // 입금예정일
  paidDate?: string | null;          // 입금일(실제 입금일)
  paymentType?: string | null;
  paymentMethod?: string | null;
  supplyAmount?: string | number | null;
  vatAmount?: string | number | null;
  amount?: string | number | null;
  depositStatus?: string | null;
  depositConfirmed?: boolean | null; // 입금확인 — 체크 시 입금일=입금예정일·상태 입금완료
  paymentCategory?: string | null;   // 결제유형: 일반결제 · 수출바우처
  payer?: string | null;             // 입금주체: 고객사 · 수출바우처 운영기관
  depositItem?: string | null;       // 입금항목: 공급가액 · 부가세 · 전체금액
  billingCompanyId?: number | null;  // 청구업체
  billingCompanyName?: string | null;
  billingContactId?: number | null;  // 담당자
  billingContactName?: string | null;
  note?: string | null;
}

interface Props {
  projectId: number;
  token: string;
  paymentRecords: any[];
  saleTotal: number;                 // 총 판매금액(견적 total = 공급가+부가세)
  defaultCompany?: { id: number; name: string } | null;   // 판매정보 거래처(일반청구 기본 청구업체)
  onChanged: () => void | Promise<void>;
  onToast: (msg: string) => void;
}

// 코드값 ↔ 표시명(라벨) — DB enum은 코드, 화면은 한글.
const PAY_TYPE_OPTS = [
  { value: 'lump_sum', label: '일괄결제' }, { value: 'advance', label: '선금' },
  { value: 'interim', label: '중도금' }, { value: 'balance', label: '잔금' }, { value: 'other', label: '기타' },
];
// 결제방법 — text(자유 입력). 기본 4개(라벨=값) + '기타' 직접입력. 저장은 라벨/사용자 문자열 그대로.
const METHOD_OPTS = [
  { value: '세금계산서', label: '세금계산서' }, { value: '카드', label: '카드' },
  { value: '외화송금', label: '외화송금' }, { value: '현금', label: '현금' },
];
const CUSTOM_METHOD = '__custom__';
const METHOD_SELECT_OPTS = [...METHOD_OPTS, { value: CUSTOM_METHOD, label: '기타' }];
const PREDEFINED_METHODS = new Set(METHOD_OPTS.map(o => o.value));
// 레거시 enum 코드 → 라벨(text 전환 전 저장분 호환). 사전 정의 밖·사용자 입력은 그대로.
const METHOD_LEGACY: Record<string, string> = {
  card: '카드', cash: '현금', overseas_remittance: '외화송금', tax_invoice: '세금계산서',
  bank_transfer: '계좌이체', promissory_note: '어음', check: '수표', other: '',
};
const normMethod = (v?: string | null) => { const s = v ?? ''; return s in METHOD_LEGACY ? METHOD_LEGACY[s] : s; };
const methodText = (v?: string | null) => normMethod(v) || '—';
const DEPOSIT_OPTS = [
  { value: 'scheduled', label: '입금예정' }, { value: 'partial', label: '부분입금' },
  { value: 'completed', label: '입금완료' }, { value: 'unpaid', label: '미수' },
];
// 결제유형·입금주체·입금항목 — 모두 text(라벨=값), 향후 사업유형 자유 확장.
const CAT_GENERAL = '일반결제', CAT_VOUCHER = '수출바우처';
const CATEGORY_OPTS = [{ value: CAT_GENERAL, label: '일반결제' }, { value: CAT_VOUCHER, label: '수출바우처' }];
const PAYER_CUSTOMER = '고객사', PAYER_OPERATOR = '수출바우처 운영기관';
const PAYER_OPTS = [{ value: PAYER_CUSTOMER, label: '고객사' }, { value: PAYER_OPERATOR, label: '수출바우처 운영기관' }];
const ITEM_SUPPLY = '공급가액', ITEM_VAT = '부가세', ITEM_TOTAL = '전체금액';
const DEPOSIT_ITEM_OPTS = [{ value: ITEM_SUPPLY, label: '공급가액' }, { value: ITEM_VAT, label: '부가세' }, { value: ITEM_TOTAL, label: '전체금액' }];
const labelOf = (opts: { value: string; label: string }[], v?: string | null) => opts.find(o => o.value === v)?.label ?? '—';

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const won = (n: number) => Math.round(n).toLocaleString('ko-KR');
const dateVal = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
const METHOD_TAX = '세금계산서';   // 발행일은 세금계산서일 때만 입력 가능
// 결제방법별 첫 예정/이벤트 날짜(expectedDate)의 컬럼명 — 카드=카드결제일 · 외화송금=송금예정일 · 그 외(세금계산서·현금·기타)=입금예정일.
const scheduledLabel = (method?: string | null) => {
  const m = normMethod(method);
  if (m === '카드') return '카드결제일';
  if (m === '외화송금') return '송금예정일';
  return '입금예정일';
};
// 천 단위 콤마 표시(입력은 숫자만 저장). 부가세 = 공급가액 × 10%(원 단위 반올림).
const commafy = (v: unknown) => { const s = String(v ?? '').replace(/[^\d]/g, ''); return s ? Number(s).toLocaleString('ko-KR') : ''; };
const vatOf = (supply: unknown) => Math.round(num(supply) * 0.1);

// 결제방법 필드 — 세금처리 '직접입력'과 동일한 인플레이스 패턴. 기본 4개 드롭다운 + '기타' 선택 시 같은 칸에서 직접 입력.
//  · 저장값이 사전 정의 4개가 아니면(레거시/사용자 입력) 자동으로 직접입력 모드로 표시. ▾ 로 목록 복귀.
function PaymentMethodField({ value, onChange, triggerStyle, testid }: {
  value: string; onChange: (v: string) => void; triggerStyle: React.CSSProperties; testid: string;
}) {
  const v = normMethod(value);
  const derivedCustom = !!v && !PREDEFINED_METHODS.has(v);
  const [manualCustom, setManualCustom] = useState(false);
  useEffect(() => { if (v && PREDEFINED_METHODS.has(v)) setManualCustom(false); }, [v]);
  const custom = derivedCustom || manualCustom;
  if (custom) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input type="text" style={{ ...triggerStyle, flex: 1, minWidth: 0 }} value={v} autoFocus={manualCustom}
          onChange={e => onChange(e.target.value)} placeholder="결제방법 직접입력"
          data-testid={`${testid}-custom`} aria-label="결제방법 직접입력" />
        <button type="button" aria-label="목록에서 선택" title="목록에서 선택"
          onClick={() => { setManualCustom(false); onChange(''); }}
          style={{ flexShrink: 0, border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: 'pointer', padding: '4px 7px', fontSize: 11, lineHeight: 1 }}>▾</button>
      </div>
    );
  }
  return (
    <ClickSelect value={v} triggerStyle={triggerStyle} options={METHOD_SELECT_OPTS}
      onChange={(nv: string) => { if (nv === CUSTOM_METHOD) { setManualCustom(true); onChange(''); } else onChange(nv); }} />
  );
}

// 청구업체 검색 — 거래처명 입력 → /admin/companies?search 결과에서 선택.
function CompanyPicker({ token, companyName, onPick, style }: {
  token: string; companyName?: string | null;
  onPick: (c: { id: number; name: string }) => void; style: React.CSSProperties;
}) {
  const [q, setQ] = useState(companyName ?? '');
  const [results, setResults] = useState<{ id: number; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { setQ(companyName ?? ''); }, [companyName]);
  const search = async (term: string) => {
    setQ(term); setOpen(true);
    if (!term.trim()) { setResults([]); return; }
    try {
      const res = await fetch(api(`/api/admin/companies?search=${encodeURIComponent(term)}&pageSize=8`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      const rows = Array.isArray(data) ? data : (data.rows ?? []);
      setResults(rows.slice(0, 8).map((c: any) => ({ id: c.id, name: c.name })));
    } catch { setResults([]); }
  };
  return (
    <div style={{ position: 'relative' }} onBlur={() => setTimeout(() => setOpen(false), 150)}>
      <input style={style} value={q} placeholder="거래처 검색" aria-label="청구업체 검색"
        onChange={e => search(e.target.value)} onFocus={() => { if (results.length) setOpen(true); }} />
      {open && results.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: '#fff', border: `1px solid ${C.g200}`, borderRadius: 6, boxShadow: '0 4px 18px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto' }}>
          {results.map(c => (
            <div key={c.id} onMouseDown={() => { onPick(c); setQ(c.name); setOpen(false); setResults([]); }}
              style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PaymentInfoSection({ projectId, token, paymentRecords, saleTotal, defaultCompany, onChanged, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [editMode, setEditMode] = useState(false);
  const [rows, setRows] = useState<PayRow[]>([]);
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<string>(CAT_GENERAL);   // 결제유형(섹션 단위)
  const [contactsCache, setContactsCache] = useState<Record<number, { value: string; label: string }[]>>({}); // 회사별 담당자 캐시

  const list: PayRow[] = paymentRecords ?? [];
  // 결제유형 — 저장 데이터에서 판단(수출바우처 행이 하나라도 있으면 수출바우처).
  const listCategory = list.some(r => r.paymentCategory === CAT_VOUCHER || r.payer === PAYER_OPERATOR) ? CAT_VOUCHER : CAT_GENERAL;
  // 판매 공급가/부가세(분할청구 검증 기준) — 총판매에서 10% 기준 분해.
  const saleSupply = Math.round(num(saleTotal) / 1.1);
  const saleVat = num(saleTotal) - saleSupply;

  // 회사 담당자 로드(캐시). 회사 선택 시 대표 담당자 자동 선택용.
  const loadContacts = async (companyId: number): Promise<{ value: string; label: string; primary?: boolean }[]> => {
    if (contactsCache[companyId]) return contactsCache[companyId];
    try {
      const res = await fetch(api(`/api/admin/companies/${companyId}/contacts`), { headers: authH });
      const rows = await res.json().catch(() => []);
      const opts = (Array.isArray(rows) ? rows : []).map((c: any) => ({ value: String(c.id), label: c.name }));
      setContactsCache(prev => ({ ...prev, [companyId]: opts }));
      return opts;
    } catch { return []; }
  };
  // 청구업체 선택 → 회사·이름 반영 + 담당자 목록 로드 후 대표 담당자 자동 선택.
  const pickCompany = async (i: number, c: { id: number; name: string }) => {
    patchRow(i, { billingCompanyId: c.id, billingCompanyName: c.name, billingContactId: null, billingContactName: null });
    const opts = await loadContacts(c.id);
    if (opts.length) patchRow(i, { billingContactId: Number(opts[0].value), billingContactName: opts[0].label });
  };

  const mapRow = (r: PayRow): PayRow => ({
    id: r.id, expectedDate: r.expectedDate ?? null, paidDate: r.paidDate ?? null,
    paymentType: r.paymentType ?? null, paymentMethod: r.paymentMethod ?? null,
    supplyAmount: r.supplyAmount ?? '', vatAmount: r.vatAmount ?? '', amount: r.amount ?? '',
    depositStatus: r.depositStatus ?? 'scheduled', depositConfirmed: r.depositConfirmed ?? false,
    paymentCategory: r.paymentCategory ?? CAT_GENERAL, payer: r.payer ?? null, depositItem: r.depositItem ?? null,
    billingCompanyId: r.billingCompanyId ?? null, billingCompanyName: r.billingCompanyName ?? null,
    billingContactId: r.billingContactId ?? null, billingContactName: r.billingContactName ?? null,
    note: r.note ?? '',
  });
  const enterEdit = () => {
    const mapped = list.map(mapRow);
    // #5 일반청구 기본값 — 청구가 없으면 판매 거래처 기준 1건 자동 시드(공급가/부가세/합계 = 판매 총액).
    if (mapped.length === 0) {
      mapped.push({
        paymentCategory: CAT_GENERAL, payer: PAYER_CUSTOMER, depositItem: ITEM_TOTAL,
        paymentMethod: '세금계산서', paymentType: 'lump_sum', depositStatus: 'scheduled',
        billingCompanyId: defaultCompany?.id ?? null, billingCompanyName: defaultCompany?.name ?? null,
        supplyAmount: String(saleSupply), vatAmount: String(saleVat), amount: String(num(saleTotal)),
      });
    }
    mapped.forEach(r => { if (r.billingCompanyId) loadContacts(r.billingCompanyId); });   // 담당자 목록 미리 로드
    setRows(mapped);
    setCategory(listCategory);
    setDeletedIds([]);
    setEditMode(true);
  };
  const cancelEdit = () => { setRows([]); setDeletedIds([]); setEditMode(false); };

  // 수출바우처 청구행 빌더(2행 고정) — 고객사=부가세, 운영기관=공급가. 금액은 시스템 자동(사용자 편집 불가).
  const voucherRows = (): PayRow[] => ([
    { paymentCategory: CAT_VOUCHER, payer: PAYER_CUSTOMER, depositItem: ITEM_VAT, paymentMethod: '세금계산서', paymentType: 'lump_sum', depositStatus: 'scheduled',
      billingCompanyId: defaultCompany?.id ?? null, billingCompanyName: defaultCompany?.name ?? null,
      supplyAmount: '0', vatAmount: String(saleVat), amount: String(saleVat) },
    { paymentCategory: CAT_VOUCHER, payer: PAYER_OPERATOR, depositItem: ITEM_SUPPLY, paymentMethod: '기타', paymentType: 'lump_sum', depositStatus: 'scheduled',
      billingCompanyId: null, billingCompanyName: PAYER_OPERATOR,
      supplyAmount: String(saleSupply), vatAmount: '0', amount: String(saleSupply) },
  ]);
  const generalRow = (): PayRow => ({
    paymentCategory: CAT_GENERAL, payer: PAYER_CUSTOMER, depositItem: ITEM_TOTAL, paymentMethod: '세금계산서', paymentType: 'lump_sum', depositStatus: 'scheduled',
    billingCompanyId: defaultCompany?.id ?? null, billingCompanyName: defaultCompany?.name ?? null,
    supplyAmount: String(saleSupply), vatAmount: String(saleVat), amount: String(num(saleTotal)),
  });
  // 수출바우처 금액 자동 산출 — payer 기준(고객사=부가세만 / 운영기관=공급가만). 판매금액 변경 시 자동 반영.
  const effAmounts = (r: PayRow, voucher: boolean) => {
    if (!voucher) return { supply: num(r.supplyAmount), vat: num(r.vatAmount), amount: num(r.amount) };
    if (r.payer === PAYER_OPERATOR) return { supply: saleSupply, vat: 0, amount: saleSupply };
    return { supply: 0, vat: saleVat, amount: saleVat };   // 고객사
  };
  // 결제유형 전환 — 혼용 금지. 기존 행은 교체(id는 삭제 대상). 수출바우처=2행 고정, 일반결제=기본 1행.
  const changeCategory = (v: string) => {
    if (v === category) return;
    setDeletedIds(d => [...d, ...rows.filter(r => r.id != null).map(r => r.id as number)]);
    setCategory(v);
    if (v === CAT_VOUCHER) { setRows(voucherRows()); if (defaultCompany?.id) loadContacts(defaultCompany.id); }
    else setRows([generalRow()]);
  };

  const patchRow = (i: number, p: Partial<PayRow>) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...p } : r));
  // 결제방법 변경 — 세금계산서가 아니면 발행일 자동 클리어(세금계산서만 발행일 사용).
  const patchMethod = (i: number, v: string) => patchRow(i, { paymentMethod: v, ...(v !== METHOD_TAX ? { issueDate: null } : {}) });
  // 입금일 변경 — 입력 시 입금상태 자동 '입금완료'. 삭제 시 상태는 사용자 선택값 유지(자동 변경 안 함).
  //  · 입금확인(depositConfirmed) 상태는 그대로 유지 — 사용자가 실제 입금일에 맞게 수정 가능(요구사항 #5).
  const patchPaid = (i: number, v: string) => patchRow(i, { paidDate: v || null, ...(v ? { depositStatus: 'completed' } : {}) });
  // 입금확인 토글 — 수행정보 납품확인과 동일 개념.
  //  · 체크 ON: 입금예정일 → 입금일 자동복사 + 입금상태 '입금완료'(→ 붉은색 해제·미수금/입금완료율 자동 재계산).
  //  · 체크 OFF: 입금일 비움 + 입금상태 '입금예정'(→ 입금예정일 다시 붉은색). 단, 입금일을 직접 수정한 이력(≠예정일)이 있으면 경고 후 처리(요구사항 #4).
  const toggleDepositConfirm = (i: number) => {
    const r = rows[i];
    if (!r.expectedDate) { onToast('입금예정일이 없어 확인할 수 없습니다.'); return; }
    if (!r.depositConfirmed) {
      patchRow(i, { depositConfirmed: true, paidDate: r.expectedDate, depositStatus: 'completed' });
    } else {
      const manuallyEdited = !!r.paidDate && dateVal(r.paidDate) !== dateVal(r.expectedDate);
      if (manuallyEdited && !window.confirm('입금일을 직접 수정한 이력이 있습니다.\n입금확인을 해제하면 입력된 입금일이 삭제됩니다. 계속하시겠습니까?')) return;
      patchRow(i, { depositConfirmed: false, paidDate: null, depositStatus: 'scheduled' });
    }
  };
  // 공급가액 입력 → 부가세(10%)·합계 정방향 계산. 빈 값이면 모두 비움.
  const patchSupply = (i: number, digits: string) => {
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      if (digits === '') return { ...r, supplyAmount: '', vatAmount: '', amount: '' };
      const vat = vatOf(digits);
      return { ...r, supplyAmount: digits, vatAmount: String(vat), amount: String(num(digits) + vat) };
    }));
  };
  // 합계 입력 → 공급가액(합계÷1.1 반올림)·부가세(합계−공급가액) 역산. 공급가액+부가세는 항상 합계와 일치. 빈 값이면 모두 비움.
  const patchHaap = (i: number, digits: string) => {
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      if (digits === '') return { ...r, amount: '', supplyAmount: '', vatAmount: '' };
      const total = num(digits);
      const supply = Math.round(total / 1.1);
      return { ...r, amount: digits, supplyAmount: String(supply), vatAmount: String(total - supply) };
    }));
  };
  // 새 청구 기본값 — 청구업체=판매 거래처, 결제방법 세금계산서, 결제구분 일괄결제, 입금주체 고객사, 입금항목 전체금액.
  const addRow = () => setRows(prev => [...prev, { depositStatus: 'scheduled', supplyAmount: '', vatAmount: '', amount: '', paymentMethod: '세금계산서', paymentType: 'lump_sum', paymentCategory: category, payer: PAYER_CUSTOMER, depositItem: ITEM_TOTAL, billingCompanyId: defaultCompany?.id ?? null, billingCompanyName: defaultCompany?.name ?? null }]);
  const removeRow = (i: number) => setRows(prev => {
    const target = prev[i];
    if (target?.id != null) setDeletedIds(d => [...d, target.id!]);
    return prev.filter((_, idx) => idx !== i);
  });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const isVoucherSave = category === CAT_VOUCHER;
      const payload = {
        rows: rows.map(r => {
          const a = effAmounts(r, isVoucherSave);   // 수출바우처는 자동 금액 저장
          return {
            id: r.id,
            // 채권관리 날짜 — 발행일(세금계산서 발행일)·입금예정일·입금일.
            issueDate: r.issueDate || null, expectedDate: r.expectedDate || null, paidDate: r.paidDate || null,
            paymentType: r.paymentType || null, paymentMethod: r.paymentMethod || null,
            supplyAmount: a.supply, vatAmount: a.vat, amount: a.amount,
            depositStatus: r.depositStatus || 'scheduled',
            depositConfirmed: !!r.depositConfirmed,
            paymentCategory: category,                                     // 결제유형(섹션 단위 → 전 행 동일)
            payer: r.payer || null, depositItem: r.depositItem || null,
            billingCompanyId: r.billingCompanyId ?? null, billingContactId: r.billingContactId ?? null,
            note: r.note || null,
          };
        }),
        deletedIds,
      };
      const res = await fetch(api(`/api/admin/projects/${projectId}/payment-records`), { method: 'PUT', headers: authH, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onToast(data.error ?? '청구정보 저장 실패'); return; }
      onToast('청구정보가 저장되었습니다.');
      setEditMode(false); setRows([]); setDeletedIds([]);
      await onChanged();
    } catch { onToast('청구정보 저장 중 오류'); } finally { setBusy(false); }
  };

  // ── 합계/요약(§자동계산) ──
  //  · 합계/입금액(행) = amount. 총 입금액 = 입금완료 행의 합계. 미수금 = 총 판매금액 − 총 입금액.
  //  · 입금완료율 = 총입금액 ÷ 총판매 × 100. 수출바우처는 두 행 모두 입금완료 시 100%(= 최종 입금완료).
  const data: PayRow[] = editMode ? rows : list;
  const effCat = editMode ? category : listCategory;
  const isVoucher = effCat === CAT_VOUCHER;                        // 청구정보 전체 유형(혼용 없음)
  // 발행일 컬럼 — 세금계산서 행이 하나라도 있을 때만 표시(없으면 '필요한 날짜만' 원칙에 따라 컬럼 숨김).
  const showIssueCol = data.some(r => normMethod(r.paymentMethod) === METHOD_TAX);
  // 첫 예정/이벤트 날짜 컬럼명 — 행별 결제방법에 따라 자동 결정. 혼합 시 '/'로 병기.
  const col2Labels = Array.from(new Set(data.map(r => scheduledLabel(r.paymentMethod))));
  const col2Header = col2Labels.length ? col2Labels.join('/') : '입금예정일';
  const haap = (r: PayRow) => effAmounts(r, isVoucher).amount;     // 합계/입금액(수출바우처는 자동)
  const paidOf = (r: PayRow) => (r.depositStatus === 'completed' ? haap(r) : 0);
  const summary = useMemo(() => {
    const totalPaid = data.reduce((s, r) => s + paidOf(r), 0);     // 총 입금액(입금완료 행)
    const receivable = saleTotal - totalPaid;                      // 미수금 = 총판매 − 총입금액
    const rate = saleTotal > 0 ? (totalPaid / saleTotal) * 100 : 0;
    // #8 분할청구 검증 — 일반결제만. 청구 공급가/부가세/합계 합이 판매금액과 일치해야 함(수출바우처는 자동이라 제외).
    const sumSupply = data.reduce((s, r) => s + effAmounts(r, isVoucher).supply, 0);
    const sumVat = data.reduce((s, r) => s + effAmounts(r, isVoucher).vat, 0);
    const sumTotal = data.reduce((s, r) => s + haap(r), 0);
    const matched = isVoucher || (sumSupply === saleSupply && sumVat === saleVat && sumTotal === num(saleTotal));
    return { totalPaid, receivable, rate, sumSupply, sumVat, sumTotal, matched };
  }, [data, saleTotal, isVoucher]);

  // ── 스타일 ──
  const inp: React.CSSProperties = { ...dsInputStd(), minHeight: 30, padding: '4px 8px', width: '100%' };
  const cellBg = C.bgCard;
  const thBase: React.CSSProperties = { ...TYPO.gridHeader, padding: '0 8px 9px', borderBottom: BD.grid, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: cellBg, zIndex: 2, textAlign: 'left' };
  // overflow hidden + ellipsis — table-layout:fixed에서 콘텐츠가 지정 width를 넘겨 컬럼을 늘리지 못하게 클리핑(폭 정확 적용).
  //  · ClickSelect 메뉴는 portal이라 클리핑 영향 없음. CompanyPicker(청구업체) 셀만 overflow:visible로 예외 처리.
  const tdBase: React.CSSProperties = { ...TYPO.inputValue, padding: '8px', borderBottom: BD.divider, verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', background: cellBg };
  const tdR: React.CSSProperties = { ...tdBase, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  // 금액 입력 — 천 단위 콤마 표시, 저장은 숫자만(콤마 제거).
  const priceCell = (v: unknown, on: (digits: string) => void, testid: string, label: string) => (
    <input type="text" inputMode="numeric" data-testid={testid} aria-label={label} placeholder="0"
      style={{ ...inp, textAlign: 'right' }} value={commafy(v)} onChange={e => on(e.target.value.replace(/[^\d]/g, ''))} />
  );
  // 날짜 입력 셀 — 수행정보와 동일한 네이티브 date UI(고정폭). overdue=미수 시 붉은 테두리. disabled=발행일 비대상.
  const dateCell = (v: string | null | undefined, on: (val: string) => void, testid: string, label: string, opts?: { disabled?: boolean; overdue?: boolean }) => (
    <input type="date" data-testid={testid} aria-label={label} disabled={opts?.disabled}
      style={{ ...inp, width: 124, ...(opts?.disabled ? { background: C.g50, color: C.g400 } : {}), ...(opts?.overdue ? { borderColor: C.danger, color: C.danger } : {}) }}
      value={dateVal(v)} onChange={e => on(e.target.value)} />
  );
  // 미수금(행) = 총 판매금액 − 누적 입금완료액(회차순 그 행까지). 요약 미수금과 일치.
  const renderRow = (r: PayRow, i: number, editable: boolean) => {
    const cumulativePaid = data.slice(0, i + 1).reduce((s, x) => s + paidOf(x), 0);
    const receivable = saleTotal - cumulativePaid;
    // 수출바우처 행은 금액이 자동(시스템 관리) — 편집·삭제 불가. 청구업체는 payer 기준 고정 표시.
    const voucher = editable ? category === CAT_VOUCHER : r.paymentCategory === CAT_VOUCHER;
    const a = effAmounts(r, voucher);
    const companyLabel = r.billingCompanyName || r.payer || '—';
    const isTaxMethod = normMethod(r.paymentMethod) === METHOD_TAX;   // 발행일 입력 대상 여부
    const schedLabel = scheduledLabel(r.paymentMethod);              // 첫 예정/이벤트 날짜 컬럼명(행별)
    // 입금 미확인(붉은색) — 예정일이 입력됐지만 입금확인 체크 전(수행정보 미확인 납품일과 동일). 확인 시 검정색.
    const confirmed = !!r.depositConfirmed;
    const expUnconfirmed = !!r.expectedDate && !confirmed;
    return (
      <tr key={r.id ?? `new-${i}`}>
        {/* 회차(자동) + 행 삭제(일반결제만) */}
        <td style={{ ...tdBase, textAlign: 'center', width: 96 }}>
          {editable && !voucher ? (
            <div style={{ display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'center' }}>
              <button type="button" onClick={() => removeRow(i)} data-testid={`pay-del-${i}`} aria-label="청구 삭제"
                style={{ border: `1px solid ${C.g300}`, borderRadius: 5, background: cellBg, color: C.danger, cursor: 'pointer', width: 22, height: 22, lineHeight: 1 }}>−</button>
              <span style={{ ...TYPO.helper, minWidth: 16, textAlign: 'center' }}>{i + 1}</span>
            </div>
          ) : <span style={{ ...TYPO.helper }}>{i + 1}</span>}
        </td>
        {/* 청구업체 — 일반결제: 거래처 검색 / 수출바우처: 고정(고객사=거래처, 운영기관 라벨) */}
        {/* overflow: visible — CompanyPicker의 inline absolute 검색 드롭다운이 셀에 잘리지 않도록(ClickSelect와 달리 portal 아님). 읽기 텍스트는 자체 span에서 말줄임 처리. */}
        <td style={{ ...tdBase, width: 180, overflow: 'visible' }}>
          {editable && !voucher
            ? <CompanyPicker token={token} companyName={r.billingCompanyName} onPick={(c) => pickCompany(i, c)} style={inp} />
            : <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }} title={companyLabel}>{companyLabel}</span>}
        </td>
        {/* 청구담당자 — 청구업체 선택 시 대표 자동, 변경 가능 */}
        <td style={{ ...tdBase, width: 120 }}>
          {editable
            ? <ClickSelect value={r.billingContactId != null ? String(r.billingContactId) : ''}
                onChange={(v: string) => { const opt = (r.billingCompanyId ? contactsCache[r.billingCompanyId] : [])?.find(o => o.value === v); patchRow(i, { billingContactId: Number(v), billingContactName: opt?.label ?? null }); }}
                triggerStyle={inp} options={r.billingCompanyId ? (contactsCache[r.billingCompanyId] ?? (r.billingContactId ? [{ value: String(r.billingContactId), label: r.billingContactName ?? '담당자' }] : [])) : []} />
            : (r.billingContactName || '—')}
        </td>
        {/* 결제방법 — 기본 4개 드롭다운 + '기타' 선택 시 같은 칸에서 직접 입력 */}
        <td style={{ ...tdBase, width: 140 }}>
          {editable
            ? <PaymentMethodField value={r.paymentMethod ?? ''} onChange={(v) => patchMethod(i, v)} triggerStyle={inp} testid={`pay-method-${i}`} />
            : methodText(r.paymentMethod)}
        </td>
        {/* 발행일 — 세금계산서 발행일. 세금계산서 행이 있을 때만 컬럼 존재. 해당 행이 세금계산서면 입력, 아니면 '—' */}
        {showIssueCol && (
          <td style={{ ...tdBase, width: 160 }}>
            {isTaxMethod
              ? (editable ? dateCell(r.issueDate, v => patchRow(i, { issueDate: v || null }), `pay-issue-${i}`, '발행일') : (dateVal(r.issueDate) || '—'))
              : <span style={{ color: C.g400 }}>—</span>}
          </td>
        )}
        {/* 첫 예정/이벤트 날짜 — 결제방법별 라벨(입금예정일/카드결제일/송금예정일). 입력 후 입금확인 전이면 붉은색, 확인 체크 시 검정색.
            우측 확인 체크박스(수행정보 납품확인과 동일) — 체크 시 입금일 자동복사·입금상태 입금완료. */}
        <td style={{ ...tdBase, width: 160 }}>
          {editable ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
              <input type="date" data-testid={`pay-expected-${i}`} aria-label={schedLabel}
                title={expUnconfirmed ? '입금 미확인 — 확인 체크 시 입금일로 반영' : (confirmed ? '입금확인 완료' : undefined)}
                style={{ ...inp, width: 122, ...(expUnconfirmed ? { borderColor: C.danger, color: C.danger } : { color: C.textPrimary }) }}
                value={dateVal(r.expectedDate)} onChange={e => patchRow(i, { expectedDate: e.target.value || null })} />
              <input type="checkbox" checked={confirmed} disabled={!r.expectedDate}
                onChange={() => toggleDepositConfirm(i)} data-testid={`pay-expected-confirm-${i}`} aria-label="입금확인"
                title={!r.expectedDate ? '입금예정일 입력 후 확인 가능' : (confirmed ? '입금확인 완료' : '입금 미확인 — 확인 시 입금완료 처리')}
                style={{ cursor: !r.expectedDate ? 'default' : 'pointer' }} />
            </div>
          ) : (
            <span style={{ color: expUnconfirmed ? C.danger : undefined, whiteSpace: 'nowrap' }}
              title={confirmed ? '입금확인 완료' : (expUnconfirmed ? '입금 미확인' : undefined)}>
              {dateVal(r.expectedDate) || '—'}{r.expectedDate && confirmed ? ' ✓' : ''}
            </span>
          )}
        </td>
        {/* 입금일 — 모든 결제방법. 입력 시 입금상태 자동 '입금완료' */}
        <td style={{ ...tdBase, width: 160 }}>
          {editable
            ? dateCell(r.paidDate, v => patchPaid(i, v), `pay-paid-${i}`, '입금일')
            : (dateVal(r.paidDate) || '—')}
        </td>
        {/* 결제구분 */}
        <td style={{ ...tdBase, width: 110 }}>
          {editable
            ? <ClickSelect value={r.paymentType ?? ''} onChange={(v: string) => patchRow(i, { paymentType: v })} triggerStyle={inp} options={PAY_TYPE_OPTS} />
            : labelOf(PAY_TYPE_OPTS, r.paymentType)}
        </td>
        {/* 공급가 — 일반결제: 콤마 입력(→부가세·합계 자동) / 수출바우처: 자동 읽기전용 */}
        <td style={{ ...tdR, width: 128 }}>
          {editable && !voucher ? priceCell(r.supplyAmount, v => patchSupply(i, v), `pay-supply-${i}`, '공급가') : `${won(a.supply)}원`}
        </td>
        {/* 부가세 — 자동 산출(읽기전용) */}
        <td style={{ ...tdR, width: 128 }} data-testid={`pay-vat-${i}`}>{`${won(a.vat)}원`}</td>
        {/* 합계 — 일반결제: 역산 입력 / 수출바우처: 자동 읽기전용 */}
        <td style={{ ...tdR, width: 128, fontWeight: 700 }}>
          {editable && !voucher ? priceCell(r.amount, v => patchHaap(i, v), `pay-haap-${i}`, '합계') : `${won(a.amount)}원`}
        </td>
        {/* 미수금 = 총판매 − 누적 입금완료액 */}
        <td style={{ ...tdR, width: 128, color: receivable > 0 ? C.danger : C.textSecondary }}>{`${won(receivable)}원`}</td>
        {/* 입금상태 */}
        <td style={{ ...tdBase, width: 110 }}>
          {editable
            ? <ClickSelect value={r.depositStatus ?? 'scheduled'} onChange={(v: string) => patchRow(i, { depositStatus: v })} triggerStyle={inp} options={DEPOSIT_OPTS} />
            : labelOf(DEPOSIT_OPTS, r.depositStatus)}
        </td>
        {/* 비고 — 가장 넓은 컬럼(메모 입력 고려) */}
        <td style={{ ...tdBase, width: 240 }}>
          {editable
            ? <input style={inp} value={r.note ?? ''} onChange={e => patchRow(i, { note: e.target.value })} placeholder="비고" data-testid={`pay-note-${i}`} aria-label="비고" />
            : (r.note || '—')}
        </td>
      </tr>
    );
  };

  const table = (editable: boolean) => (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.g200}`, borderRadius: BD.radius.md }}>
      {/* table-layout: fixed — 지정한 컬럼 width를 실제 렌더 폭으로 강제(auto는 콘텐츠 기준이라 width가 최소값 취급되어 무시됨).
          컬럼 폭은 첫 행(thead th)의 width로 확정 → th/td width를 동일하게 유지. width=max-content로 폭 합만큼 렌더 후 컨테이너에서 가로 스크롤. */}
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: showIssueCol ? 1988 : 1828, width: 'max-content' }}>
        <thead><tr>
          <th style={{ ...thBase, width: 96, textAlign: 'center' }}>회차</th>
          <th style={{ ...thBase, width: 180 }}>청구업체</th>
          <th style={{ ...thBase, width: 120 }}>청구담당자</th>
          <th style={{ ...thBase, width: 140 }}>결제방법</th>
          {/* 날짜 3컬럼 — 동일 폭(160)으로 통일. 입금예정일의 날짜+확인 체크박스가 border-box 콘텐츠 영역에 안전히 들어가는 최소폭 */}
          {showIssueCol && <th style={{ ...thBase, width: 160 }}>발행일</th>}
          <th style={{ ...thBase, width: 160 }}>{col2Header}</th>
          <th style={{ ...thBase, width: 160 }}>입금일</th>
          <th style={{ ...thBase, width: 110 }}>결제구분</th>
          {/* 금액 4컬럼 — 동일 폭(128)으로 균등 배치 */}
          <th style={{ ...thBase, width: 128, textAlign: 'right' }}>공급가액</th>
          <th style={{ ...thBase, width: 128, textAlign: 'right' }}>부가세</th>
          <th style={{ ...thBase, width: 128, textAlign: 'right' }}>합계</th>
          <th style={{ ...thBase, width: 128, textAlign: 'right' }}>미수금</th>
          <th style={{ ...thBase, width: 110 }}>입금상태</th>
          <th style={{ ...thBase, width: 240 }}>비고</th>
        </tr></thead>
        <tbody>
          {data.map((r, i) => renderRow(r, i, editable))}
          {data.length === 0 && (
            <tr><td colSpan={showIssueCol ? 14 : 13} style={{ ...tdBase, textAlign: 'center', color: C.g400, padding: '20px 8px' }}>
              등록된 청구정보가 없습니다. {editable ? '「+ 청구추가」로 청구 내역을 입력하세요.' : '「수정」에서 청구를 추가하세요.'}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const summaryBox = (
    <>
      {/* #6 분할청구 검증 — 청구 합계가 판매금액과 불일치 시 경고 */}
      {editMode && !summary.matched && (
        <div style={{ ...TYPO.helper, color: C.danger, padding: `${SP[2]}px ${SP[3]}px`, background: '#fef2f2', border: `1px solid #fca5a5`, borderRadius: 8, marginTop: SP[3] }}>
          ⚠ 청구 합계가 판매금액과 일치하지 않습니다 — 공급가 {won(summary.sumSupply)}/{won(saleSupply)} · 부가세 {won(summary.sumVat)}/{won(saleVat)} · 합계 {won(summary.sumTotal)}/{won(num(saleTotal))}원
        </div>
      )}
      <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums', padding: `${SP[3]}px ${SP[4]}px`, background: C.primaryBg, borderRadius: 8, marginTop: SP[3] }}>
        <span>총 판매금액 <b>{won(saleTotal)}원</b></span>
        <span>총 입금액 <b style={{ color: C.primaryText }}>{won(summary.totalPaid)}원</b></span>
        <span>미수금 <b style={{ color: summary.receivable > 0 ? C.danger : C.textSecondary }}>{won(summary.receivable)}원</b></span>
        <span>입금완료율 <b>{summary.rate.toFixed(1)}%</b></span>
      </div>
    </>
  );

  return (
    <Card>
      <div style={{ ...TYPO.sectionTitle, paddingBottom: SP[4], borderBottom: BD.grid, marginBottom: SP[5], display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
        <span style={{ width: 22, height: 22, borderRadius: BD.radius.md, background: '#ecfdf5', color: '#047857', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>D</span>
        청구정보
        <span style={{ ...TYPO.helper, marginLeft: SP[2] }}>업체별 청구·입금 관리 (청구 = 입금 관리 단위 · 좌우 스크롤)</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* 결제유형 — 수출바우처 선택 시 고객사·운영기관 청구 2건 자동 생성 */}
          <span style={{ ...TYPO.helper }}>결제유형</span>
          {editMode ? (
            <div style={{ width: 130 }}>
              <ClickSelect value={category} onChange={changeCategory} triggerStyle={{ ...dsInputStd(), minHeight: 30, padding: '4px 8px', width: '100%' }} options={CATEGORY_OPTS} />
            </div>
          ) : (
            <b style={{ ...TYPO.inputValue }}>{labelOf(CATEGORY_OPTS, listCategory)}</b>
          )}
          {editMode ? (
            <>
              <GhostBtn onClick={addRow} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="pay-add-row" aria-label="행 추가">+ 행 추가</GhostBtn>
              <GhostBtn onClick={cancelEdit} style={{ fontSize: 12, padding: '6px 12px' }} data-testid="pay-cancel" aria-label="취소">취소</GhostBtn>
              <PrimaryBtn onClick={save} disabled={busy} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="pay-save" aria-label="저장">{busy ? '저장 중…' : '저장'}</PrimaryBtn>
            </>
          ) : (
            <GhostBtn onClick={enterEdit} style={{ fontSize: 12, padding: '6px 14px' }} data-testid="pay-edit" aria-label="수정">수정</GhostBtn>
          )}
        </div>
      </div>
      {table(editMode)}
      {summaryBox}
    </Card>
  );
}
