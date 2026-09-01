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

export interface PayTxn {
  id?: number;
  paidDate?: string | null;
  method?: string | null;            // 국내이체 · 해외송금 · 신용카드 · 기타
  customerPaidAmount?: string | number | null;   // 고객 실제 결제금액(미수금 기준)
  settledAmount?: string | number | null;        // 회사 실제 정산금액(회계용)
  feeAmount?: string | number | null;
  currency?: string | null;
  fxRate?: string | number | null;
  foreignAmount?: string | number | null;
  krwAmount?: string | number | null;
  bankAccount?: string | null;
  payerName?: string | null;
  approvalNo?: string | null;
  cardPgType?: string | null;
  note?: string | null;
}
interface PayRow {
  id?: number;
  transactions?: PayTxn[];           // 이 청구행의 수금거래(입금/결제 내역) N건
  // ── 편집모드 전용 임시 필드(첫 입금을 기본 청구행에서 직접 입력) — project_payments 에는 저장 안 함 ──
  _bank?: string;                    // 입금은행(첫 입금)
  _paidAmt?: string;                 // 입금액(원화, 첫 입금)
  _curr?: string;                    // 통화(외화송금)
  _foreign?: string;                 // 외화입금액(외화송금)
  _txnId?: number;                   // 첫 입금이 이미 거래로 저장돼 있으면 그 거래 id(수정모드 복원·update-in-place용, §8)
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
  // 차감견적을 판매전환한 판매건 전용 — 하단 요약을 '이번 서비스 사용액/총 선입금액/사용가능잔액'으로 대체.
  //  (일반/누적 견적 판매건은 isPrepaidSale=false → 기존 미수금/입금완료율 요약 그대로 유지)
  isPrepaidSale?: boolean;
  prepaidDeposited?: number | null;  // 총 선입금액 = Σ prepaid_accounts.initial_amount(원장 소스)
  prepaidAvailable?: number | null;  // 사용가능잔액 = Σ prepaid_accounts.current_balance(원장 소스)
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
  { value: '외화송금', label: '외화입금' }, { value: '현금', label: '현금' },
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
// 표시명 매핑 — canonical 값('외화송금')·DB·매칭(isOverseas) 로직은 그대로 두고, 화면 표시만 '외화입금'(수금 관점).
//  · 이 화면은 고객으로부터 '입금'을 받는 수금관리이므로 표시상 '외화입금'이 정확. 저장/비교값은 계속 '외화송금'.
const METHOD_DISPLAY: Record<string, string> = { '외화송금': '외화입금' };
const displayMethod = (v?: string | null) => { const s = normMethod(v); return s ? (METHOD_DISPLAY[s] ?? s) : ''; };
const methodText = (v?: string | null) => displayMethod(v) || '—';
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

// 입금은행(§3) — 정해진 4개만. 해외송금 기본 '기업은행외화'.
const BANK_OPTS = ['기업은행', '국민은행', '우리은행', '기업은행외화'];
// 통화(§5) — ISO 4217 코드 저장, 화면은 코드+한글명. 외화송금에서만 사용.
const CURRENCY_OPTS: { value: string; label: string }[] = [
  { value: 'USD', label: 'USD (미국 달러)' }, { value: 'EUR', label: 'EUR (유로)' }, { value: 'JPY', label: 'JPY (일본 엔)' },
  { value: 'CNY', label: 'CNY (중국 위안)' }, { value: 'GBP', label: 'GBP (영국 파운드)' }, { value: 'CHF', label: 'CHF (스위스 프랑)' },
  { value: 'CAD', label: 'CAD (캐나다 달러)' }, { value: 'AUD', label: 'AUD (호주 달러)' }, { value: 'SGD', label: 'SGD (싱가포르 달러)' },
  { value: 'HKD', label: 'HKD (홍콩 달러)' },
];
const isOverseas = (method?: string | null) => normMethod(method) === '외화송금';
// 입금거래 결제방법(§2/§3) — 외화송금 선택 시 통화/외화입금액 UI 노출.
const TXN_METHOD_OPTS = [
  { value: '국내이체', label: '국내이체' }, { value: '외화송금', label: '외화입금' }, { value: '카드', label: '카드' },
  { value: '세금계산서', label: '세금계산서' }, { value: '현금', label: '현금' }, { value: '기타', label: '기타' },
];

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
//  ⚠ numeric(14,2) DB값은 "5500000.00" 처럼 소수점이 붙어 오므로 [^\d] 제거는 소수점까지 지워 100배로 부풀린다.
//  → num()으로 정확히 파싱 후 반올림 표시(소수점 안전).
const commafy = (v: unknown) => { const n = num(v); return n ? Math.round(n).toLocaleString('ko-KR') : ''; };
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

export default function PaymentInfoSection({ projectId, token, paymentRecords, saleTotal, defaultCompany, isPrepaidSale = false, prepaidDeposited = null, prepaidAvailable = null, onChanged, onToast }: Props) {
  const authH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [editMode, setEditMode] = useState(false);
  const [rows, setRows] = useState<PayRow[]>([]);
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<string>(CAT_GENERAL);   // 결제유형(섹션 단위)
  const [contactsCache, setContactsCache] = useState<Record<number, { value: string; label: string }[]>>({}); // 회사별 담당자 캐시
  // ── 인라인 수금(입금/결제) 상태 — 팝업 제거, 청구행 아래 하위행으로 표시/입력 ──
  const [expanded, setExpanded] = useState<Set<number>>(new Set());   // 펼친 청구행(project_payment id)
  const [addingFor, setAddingFor] = useState<number | null>(null);    // 인라인 [+ 입금 추가] 대상 청구행 id
  const [txnBusy, setTxnBusy] = useState(false);
  const emptyTxn = (): PayTxn => ({ paidDate: new Date().toISOString().slice(0, 10), method: '기타' });
  const [addForm, setAddForm] = useState<PayTxn>(emptyTxn());
  const toggleExpand = (id: number) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

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

  const mapRow = (r: PayRow): PayRow => {
  // §8 수정모드 복원 — 이 청구행이 '첫 입금' 거래 1건만 가진 경우, 그 거래값을 기본행 임시필드로 되살린다.
  //  (거래 2건 이상은 첫입금 인라인 대상이 아니라 하위행에서 관리 → 시드하지 않음)
  const only = (r.transactions && r.transactions.length === 1) ? r.transactions[0] : null;
  const seedCurr = only?.currency && only.currency !== 'KRW' ? only.currency : '';
  return {
    id: r.id, transactions: r.transactions ?? [],   // 수금거래는 하위행/기본행에서 관리 — 편집 중에도 계산 일관성 위해 보존
    _txnId: only?.id,
    _bank: only?.bankAccount ?? '', _paidAmt: only && num(only.customerPaidAmount) > 0 ? String(num(only.customerPaidAmount)) : '',
    _curr: seedCurr, _foreign: only && num(only.foreignAmount) > 0 ? String(num(only.foreignAmount)) : '',
    expectedDate: r.expectedDate ?? null, paidDate: r.paidDate ?? null,
    paymentType: r.paymentType ?? null, paymentMethod: r.paymentMethod ?? null,
    supplyAmount: r.supplyAmount ?? '', vatAmount: r.vatAmount ?? '', amount: r.amount ?? '',
    depositStatus: r.depositStatus ?? 'scheduled', depositConfirmed: r.depositConfirmed ?? false,
    paymentCategory: r.paymentCategory ?? CAT_GENERAL, payer: r.payer ?? null, depositItem: r.depositItem ?? null,
    billingCompanyId: r.billingCompanyId ?? null, billingCompanyName: r.billingCompanyName ?? null,
    billingContactId: r.billingContactId ?? null, billingContactName: r.billingContactName ?? null,
    note: r.note ?? '',
  };
  };
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
  // ── 입금완료 상태 정합(§TOP3) — 세 필드(completed·confirmed·paidDate)는 항상 함께 움직인다(모순 금지) ──
  //  · 입금완료: depositStatus='completed' + depositConfirmed=true + paidDate(실제/지정 입금일) 동시 세팅.
  //  · 미입금: depositConfirmed=false + paidDate=null + depositStatus는 completed가 아닌 값(기본 'scheduled').
  const markPaid = (i: number, paidDate: string) => patchRow(i, { depositStatus: 'completed', depositConfirmed: true, paidDate });
  const markUnpaid = (i: number, status: string = 'scheduled') => patchRow(i, { depositStatus: status, depositConfirmed: false, paidDate: null });
  const todayStr = () => new Date().toISOString().slice(0, 10);
  // 결제방법 변경 — 세금계산서가 아니면 발행일 자동 클리어(세금계산서만 발행일 사용).
  //  외화송금 선택 시(§11/§12) 기본 제안값(입금은행 기업은행외화·통화 USD)을 비어있을 때만 채운다(강제 아님, 사용자가 변경 가능).
  const patchMethod = (i: number, v: string) => setRows(prev => prev.map((r, idx) => {
    if (idx !== i) return r;
    const next: PayRow = { ...r, paymentMethod: v, ...(v !== METHOD_TAX ? { issueDate: null } : {}) };
    if (isOverseas(v)) { if (!next._bank) next._bank = '기업은행외화'; if (!next._curr) next._curr = 'USD'; }
    return next;
  }));
  // 입금일 변경 — 입력 시 입금완료(3필드 세트), 삭제 시 미입금(3필드 세트)으로 정합. 모순 상태를 만들지 않는다.
  const patchPaid = (i: number, v: string) => (v ? markPaid(i, v) : markUnpaid(i));
  // 입금확인 토글 — 수행정보 납품확인과 동일 개념.
  //  · 체크 ON: 입금예정일 → 입금일 복사 + 입금완료(3필드 세트). 체크 OFF: 미입금(3필드 세트).
  //  · 입금일을 직접 수정한 이력(≠예정일)이 있으면 해제 시 경고 후 처리.
  const toggleDepositConfirm = (i: number) => {
    const r = rows[i];
    if (!r.expectedDate) { onToast('입금예정일이 없어 확인할 수 없습니다.'); return; }
    if (!r.depositConfirmed) {
      markPaid(i, r.expectedDate);
    } else {
      const manuallyEdited = !!r.paidDate && dateVal(r.paidDate) !== dateVal(r.expectedDate);
      if (manuallyEdited && !window.confirm('입금일을 직접 수정한 이력이 있습니다.\n입금확인을 해제하면 입력된 입금일이 삭제됩니다. 계속하시겠습니까?')) return;
      markUnpaid(i);
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

      // ── 첫 입금(§3/§4/§5/§6) — 기본 청구행에 입력한 입금값을 payment_transaction 1건으로 생성/갱신 ──
      //  · 청구금액 필드를 바꾸지 않고 실제 수금거래를 만든다. 저장된 행 id 는 반환 rows(회차 순)로 매칭.
      //  · 트리거: 원화 입금액(>0) OR 외화송금 외화입금액(>0). 외화-only(원화 0/미확정)도 반드시 거래를 남긴다.
      //  · 거래 0건이면 신규 insert, 이미 1건이면(§8 복원값) 그 거래를 update(_txnId)한다. 2건 이상 행은 하위행에서 관리(대상 제외).
      const savedRows: any[] = Array.isArray(data.rows) ? data.rows : [];
      const firstPays = rows.map((r, idx) => ({ r, idx })).filter(({ r }) => {
        const cnt = r.transactions?.length ?? 0;
        if (cnt > 1) return false;
        const overseas = isOverseas(r.paymentMethod);
        return num(r._paidAmt) > 0 || (overseas && num(r._foreign) > 0);
      });
      for (const { r, idx } of firstPays) {
        const saved = savedRows[idx];
        if (!saved?.id) continue;
        const m = normMethod(r.paymentMethod) || '기타';
        const txn: PayTxn = {
          ...(r._txnId ? { id: r._txnId } : {}),
          paidDate: r.paidDate || null, method: m, customerPaidAmount: num(r._paidAmt), bankAccount: r._bank || null,
          ...(isOverseas(m) ? { currency: r._curr || null, foreignAmount: num(r._foreign) || null } : {}),
        };
        await fetch(api(`/api/admin/project-payments/${saved.id}/transactions`), { method: 'PUT', headers: authH, body: JSON.stringify({ rows: [txn], deletedIds: [] }) });
      }

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
  // 첫 예정/이벤트 날짜 컬럼명 — 행별 결제방법에 따라 자동 결정. 혼합 시 '/'로 병기.
  const col2Labels = Array.from(new Set(data.map(r => scheduledLabel(r.paymentMethod))));
  const col2Header = col2Labels.length ? col2Labels.join('/') : '입금예정일';
  const haap = (r: PayRow) => effAmounts(r, isVoucher).amount;     // 합계/입금액(수출바우처는 자동)
  // 입금완료 = 세 필드(completed·confirmed·paidDate) 모두 충족 시에만(§TOP3). 미수금 계산의 단일 기준 — 모순 데이터 방어.
  const isRowPaid = (r: PayRow) => r.depositStatus === 'completed' && r.depositConfirmed === true && !!r.paidDate;
  // 수금 SSOT(§G) — 신규 수금거래(transactions)가 1건 이상이면 그 합계를 고객결제액으로 사용(레거시 depositConfirmed 무시, 이중합산 금지).
  //  거래가 없으면 기존 depositConfirmed/depositStatus/paidDate 로직을 fallback 으로 유지.
  const hasTxn = (r: PayRow) => (r.transactions?.length ?? 0) > 0;
  const txnPaid = (r: PayRow) => (r.transactions ?? []).reduce((s, t) => s + num(t.customerPaidAmount), 0);
  const paidOf = (r: PayRow) => (hasTxn(r) ? txnPaid(r) : (isRowPaid(r) ? haap(r) : 0));
  const lastTxn = (r: PayRow): PayTxn | null => { const ts = r.transactions ?? []; return ts.length ? ts[ts.length - 1] : null; };  // 최근(마지막) 입금거래
  const dispPaidDate = (r: PayRow): string => { const t = lastTxn(r); return (t?.paidDate ? dateVal(t.paidDate) : (dateVal(r.paidDate) || '—')); };  // §11 입금일: 최종 입금일
  const dispBank = (r: PayRow): string => { const t = lastTxn(r); return t?.bankAccount || '—'; };  // §3 입금은행: 최근 거래 은행
  // §7/§12 조회 compact 외화 표시 — 최근 거래가 외화송금이면 "USD 4,000" 처럼 결제방법 셀 아래 한 줄로. 없으면 빈 문자열.
  const dispForeign = (r: PayRow): string => { const t = lastTxn(r); return (t && isOverseas(t.method) && num(t.foreignAmount) > 0) ? `${t.currency || 'FX'} ${won(num(t.foreignAmount))}` : ''; };
  // 입금상태(§F) — 거래 존재 시 결제액 vs 청구액으로 파생. 없으면 기존 depositStatus.
  const effStatus = (r: PayRow): string => {
    if (!hasTxn(r)) return r.depositStatus ?? 'scheduled';
    const paid = txnPaid(r); const bill = num(haap(r));
    return paid <= 0 ? 'scheduled' : (paid < bill ? 'partial' : 'completed');
  };
  // 분할청구 판별 — 서로 다른 청구업체가 2곳 이상이면 '업체별 분할청구'(예: 분할견적 판매전환).
  //  이 경우 각 청구행 미수금 = MAX(행 청구액 − 행 입금액, 0)(행 자체 기준). project 전체 미수금을 행에 쓰지 않는다.
  //  단일 업체의 회차청구(선금/중도금/잔금)는 기존 '총판매 − 누적입금'(러닝) 유지 → 일반/누적 회귀 없음.
  const isSplitBilling = new Set(data.map(r => r.billingCompanyId).filter((x): x is number => x != null)).size > 1;
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
  // 하위 입금행 상세 텍스트 — 결제방법별 핵심만 한 줄로(외화송금=통화/외화/환율, 카드=승인/수수료/정산).
  const txnDetail = (t: PayTxn): string => isOverseas(t.method)
    ? `${t.currency || 'FX'} ${won(num(t.foreignAmount))} @ ${t.fxRate ?? '—'}${t.payerName ? ' · ' + t.payerName : ''}`
    : normMethod(t.method) === '카드'
      ? `${t.cardPgType ? t.cardPgType : ''}${t.approvalNo ? ' · ' + t.approvalNo : ''}${num(t.feeAmount) ? ' · 수수료 ' + won(num(t.feeAmount)) + '원' : ''}${num(t.settledAmount) ? ' · 정산 ' + won(num(t.settledAmount)) + '원' : ''}`
      : `${t.payerName ? t.payerName : ''}`;

  // ── 수금거래(payment_transactions) 인라인 저장/삭제 — 기존 배치 API 재사용 ──
  //  · 추가: { rows:[신규] } (미포함 거래는 미변경) / 삭제: { deletedIds:[id] }. onChanged 로 판매상세 재조회.
  const putTxn = async (paymentId: number, body: { rows?: PayTxn[]; deletedIds?: number[] }): Promise<boolean> => {
    setTxnBusy(true);
    try {
      const res = await fetch(api(`/api/admin/project-payments/${paymentId}/transactions`), {
        method: 'PUT', headers: authH, body: JSON.stringify({ rows: body.rows ?? [], deletedIds: body.deletedIds ?? [] }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); onToast(`수금 저장 실패: ${d.error ?? res.status}`); return false; }
      await onChanged();
      return true;
    } catch { onToast('수금 저장 중 오류가 발생했습니다.'); return false; }
    finally { setTxnBusy(false); }
  };
  // 입금 추가 시작 — 결제방법은 청구행에서 승계(§2/§5). 외화송금이면 은행/통화 기본값 세팅.
  const startAdd = (r: PayRow) => {
    if (r.id == null) return;
    const m = normMethod(r.paymentMethod) || '기타';
    setExpanded(prev => new Set(prev).add(r.id as number));
    setAddForm({ paidDate: new Date().toISOString().slice(0, 10), method: m, bankAccount: isOverseas(m) ? '기업은행외화' : '기업은행', currency: isOverseas(m) ? 'USD' : undefined });
    setAddingFor(r.id);
  };
  const cancelAdd = () => { setAddingFor(null); setAddForm(emptyTxn()); };
  const saveAdd = async (paymentId: number) => {
    const m = addForm.method ?? '기타';
    const amt = num(addForm.customerPaidAmount);
    // §3/§4 — 외화송금은 통화·외화입금액만 있으면 원화(customerPaidAmount) 0/미확정이어도 저장 허용. 그 외는 원화 입금액 필수.
    if (isOverseas(m)) {
      if (!addForm.currency || num(addForm.foreignAmount) <= 0) { onToast('외화송금은 통화·외화입금액이 필요합니다.'); return; }
    } else if (amt <= 0) { onToast('고객결제금액을 입력하세요.'); return; }
    // 숫자 필드는 정리해서 전송(콤마 제거·빈값 null) — 검증 실패 방지(§13).
    const payload: PayTxn = {
      paidDate: addForm.paidDate || null, method: m,
      customerPaidAmount: amt, bankAccount: addForm.bankAccount || null,
      payerName: addForm.payerName || null, note: addForm.note || null,
      ...(isOverseas(m) ? {
        currency: addForm.currency || null, foreignAmount: num(addForm.foreignAmount) || null,
        fxRate: num(addForm.fxRate) || null, krwAmount: num(addForm.krwAmount) || null,
      } : {}),
    };
    const ok = await putTxn(paymentId, { rows: [payload] });
    if (ok) cancelAdd();
  };
  const deleteTxn = async (paymentId: number, txnId?: number) => {
    if (!txnId) return;
    await putTxn(paymentId, { deletedIds: [txnId] });
  };

  // 2차+ 입금 추가 — 얇은 한 줄(§7/§8). 라벨 없이 placeholder로 compact. 결제방법 선택 시 외화면 통화/외화액만 추가.
  const setAF = (patch: Partial<PayTxn>) => setAddForm(prev => ({ ...prev, ...patch }));
  const renderTxnAddForm = (paymentId: number) => {
    const m = addForm.method ?? '기타';
    const overseas = isOverseas(m);
    const tinp: React.CSSProperties = { padding: '4px 7px', borderRadius: 6, border: `1px solid ${C.g300}`, fontSize: 12, boxSizing: 'border-box' };
    // §3/§4 — 외화송금: 통화+외화입금액이면 저장 가능(원화 0 허용). 그 외: 원화 입금액(>0) 필수.
    const canSave = (overseas ? (!!addForm.currency && num(addForm.foreignAmount) > 0) : num(addForm.customerPaidAmount) > 0) && !txnBusy;
    return (
      <div style={{ paddingLeft: 28, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color: C.primaryText, fontSize: 12 }}>└ 입금 추가</span>
        <ClickSelect value={m} onChange={(v: string) => setAF({ method: v, bankAccount: isOverseas(v) ? '기업은행외화' : (addForm.bankAccount || '기업은행'), currency: isOverseas(v) ? (addForm.currency || 'USD') : undefined })} triggerStyle={{ ...tinp, width: 110 }} options={TXN_METHOD_OPTS} />
        <input type="date" style={{ ...tinp, width: 128 }} value={addForm.paidDate ?? ''} onChange={e => setAF({ paidDate: e.target.value || null })} data-testid="txn-add-date" />
        <ClickSelect value={addForm.bankAccount ?? ''} onChange={(v: string) => setAF({ bankAccount: v })} triggerStyle={{ ...tinp, width: 110 }} options={BANK_OPTS.map(b => ({ value: b, label: b }))} />
        {overseas && <>
          <ClickSelect value={addForm.currency ?? ''} onChange={(v: string) => setAF({ currency: v })} triggerStyle={{ ...tinp, width: 78 }} options={CURRENCY_OPTS} />
          <input style={{ ...tinp, width: 88, textAlign: 'right' }} inputMode="decimal" value={String(addForm.foreignAmount ?? '')} onChange={e => setAF({ foreignAmount: e.target.value })} placeholder="외화액" data-testid="txn-add-foreign" />
        </>}
        <input style={{ ...tinp, width: 120, textAlign: 'right', fontWeight: 700 }} inputMode="numeric" value={String(addForm.customerPaidAmount ?? '')} onChange={e => setAF({ customerPaidAmount: e.target.value })} placeholder={overseas ? '원화 입금액' : '입금액'} data-testid="txn-add-amount" />
        <input style={{ ...tinp, width: 140 }} value={addForm.note ?? ''} onChange={e => setAF({ note: e.target.value })} placeholder="비고" data-testid="txn-add-note" />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={() => saveAdd(paymentId)} disabled={!canSave} data-testid="txn-add-save"
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, background: canSave ? C.primary : '#9ca3af', cursor: canSave ? 'pointer' : 'not-allowed' }}>{txnBusy ? '저장 중…' : '저장'}</button>
          <button type="button" onClick={cancelAdd} disabled={txnBusy} data-testid="txn-add-cancel"
            style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.g300}`, background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
        </div>
      </div>
    );
  };

  // 미수금(행): 일반/누적 = 총 판매금액 − 누적 입금완료액(요약과 일치) / 차감견적 = 청구금액 − 행 입금액(음수 금지). 상세는 아래.
  const renderRow = (r: PayRow, i: number, editable: boolean) => {
    // 수출바우처 행은 금액이 자동(시스템 관리) — 편집·삭제 불가. 청구업체는 payer 기준 고정 표시.
    const voucher = editable ? category === CAT_VOUCHER : r.paymentCategory === CAT_VOUCHER;
    const a = effAmounts(r, voucher);
    // 미수금(행):
    //  · 일반/누적 견적 판매건(단일 업체 회차청구) = 총 판매금액 − 누적 입금완료액(회차순, 하단 요약과 일치) — 기존 로직 유지.
    //  · 차감견적 판매건 / 분할청구(업체별) = '청구금액(합계) − 해당 행 실제 입금액'. 행 자체 기준이며 음수가 되지 않는다.
    //    (max(…,0)로 과입금도 0 처리 — §6. 하단 총 미수금은 SUM(행)=총판매−총입금과 일치하므로 요약 불변 §2)
    const cumulativePaid = data.slice(0, i + 1).reduce((s, x) => s + paidOf(x), 0);
    // 거래(transactions)가 있는 행 / 분할청구 / 차감견적 = 행 자체 기준(청구 − 행 고객결제액). 그 외 단일업체 회차청구는 러닝.
    const receivable = (isPrepaidSale || isSplitBilling || hasTxn(r)) ? Math.max(a.amount - paidOf(r), 0) : saleTotal - cumulativePaid;
    const companyLabel = r.billingCompanyName || r.payer || '—';
    const isTaxMethod = normMethod(r.paymentMethod) === METHOD_TAX;   // 발행일 입력 대상 여부
    const schedLabel = scheduledLabel(r.paymentMethod);              // 첫 예정/이벤트 날짜 컬럼명(행별)
    // 입금 미확인(붉은색) — 예정일이 입력됐지만 입금확인 체크 전(수행정보 미확인 납품일과 동일). 확인 시 검정색.
    const confirmed = !!r.depositConfirmed;
    const expUnconfirmed = !!r.expectedDate && !confirmed;
    const cols = 13;   // 하위행 colSpan — 최종 13컬럼(§1).
    const pid = r.id ?? null;
    const isOpen = pid != null && expanded.has(pid);
    const txns = r.transactions ?? [];
    const overseasRow = isOverseas(r.paymentMethod);
    // 첫 입금(§6/§8) — 편집모드 + 수출바우처 아님 + 거래 0~1건 → 기본 청구행에서 입금은행/입금액/외화 직접 입력.
    //  거래 1건이면 그 거래값을 임시필드로 시드(mapRow)해 복원·update-in-place. 2건 이상은 하위행 관리라 인라인 편집 대상 아님.
    const firstPayMode = editable && !voucher && txns.length <= 1;
    // 미수금 미리보기 — 첫 입금 입력 중이면 입력값 반영, 그 외 기존 계산.
    const rowReceivable = firstPayMode && num(r._paidAmt) > 0 ? Math.max(a.amount - num(r._paidAmt), 0) : receivable;
    const firstStatus = num(r._paidAmt) <= 0 ? 'scheduled' : (num(r._paidAmt) < a.amount ? 'partial' : 'completed');
    return (
      <React.Fragment key={r.id ?? `new-${i}`}>
      <tr>
        {/* 회차(자동) + (읽기모드) 입금내역 펼침 토글 / (편집모드) 행 삭제 */}
        <td style={{ ...tdBase, textAlign: 'center', width: 96 }}>
          {editable && !voucher ? (
            <div style={{ display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'center' }}>
              <button type="button" onClick={() => removeRow(i)} data-testid={`pay-del-${i}`} aria-label="청구 삭제"
                style={{ border: `1px solid ${C.g300}`, borderRadius: 5, background: cellBg, color: C.danger, cursor: 'pointer', width: 22, height: 22, lineHeight: 1 }}>−</button>
              <span style={{ ...TYPO.helper, minWidth: 16, textAlign: 'center' }}>{i + 1}</span>
            </div>
          ) : (!editable && pid != null && hasTxn(r) ? (
            <div style={{ display: 'flex', gap: 3, alignItems: 'center', justifyContent: 'center' }}>
              <button type="button" onClick={() => toggleExpand(pid)} data-testid={`txn-toggle-${i}`} aria-label={isOpen ? '입금내역 접기' : '입금내역 펼치기'}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textSecondary, fontSize: 11, padding: 0, width: 14 }}>{isOpen ? '▼' : '▶'}</button>
              <span style={{ ...TYPO.helper }}>{i + 1}</span>
            </div>
          ) : <span style={{ ...TYPO.helper }}>{i + 1}</span>)}
        </td>
        {/* 청구업체 — 일반결제: 거래처 검색 / 수출바우처: 고정(고객사=거래처, 운영기관 라벨) */}
        {/* overflow: visible — CompanyPicker의 inline absolute 검색 드롭다운이 셀에 잘리지 않도록(ClickSelect와 달리 portal 아님). 읽기 텍스트는 자체 span에서 말줄임 처리. */}
        <td style={{ ...tdBase, width: 180, overflow: 'visible' }}>
          {editable && !voucher
            ? <CompanyPicker token={token} companyName={r.billingCompanyName} onPick={(c) => pickCompany(i, c)} style={inp} />
            : <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }} title={companyLabel}>{companyLabel}</span>}
        </td>
        {/* 청구담당자 컬럼 제거(§3/§21) — billingContactId 데이터/저장은 유지, UI 열만 삭제 */}
        {/* 결제방법 — 드롭다운. 외화송금 + 첫 입금이면 같은 셀에 통화/외화입금액 compact 표시(§10/§11, 팝업 없음) */}
        <td style={{ ...tdBase, width: 168 }}>
          {editable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <PaymentMethodField value={r.paymentMethod ?? ''} onChange={(v) => patchMethod(i, v)} triggerStyle={inp} testid={`pay-method-${i}`} />
              {firstPayMode && overseasRow && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <ClickSelect value={r._curr ?? ''} onChange={(v: string) => patchRow(i, { _curr: v })} triggerStyle={{ ...inp, width: 78 }} options={CURRENCY_OPTS} />
                  <input style={{ ...inp, width: 82, textAlign: 'right' }} inputMode="decimal" placeholder="외화액" value={r._foreign ?? ''} onChange={e => patchRow(i, { _foreign: e.target.value })} data-testid={`pay-foreign-${i}`} />
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span>{methodText(r.paymentMethod)}</span>
              {/* §7 조회모드 — 외화송금 거래가 있으면 통화·외화입금액이 사라지지 않도록 셀 아래 compact 표시(팝업 없음) */}
              {dispForeign(r) && <span style={{ fontSize: 11, color: C.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{dispForeign(r)}</span>}
            </div>
          )}
        </td>
        {/* 발행일(§1) — 항상 표시. 세금계산서 행이면 입력, 아니면 '—' */}
        <td style={{ ...tdBase, width: 150 }}>
          {isTaxMethod
            ? (editable ? dateCell(r.issueDate, v => patchRow(i, { issueDate: v || null }), `pay-issue-${i}`, '발행일') : (dateVal(r.issueDate) || '—'))
            : <span style={{ color: C.g400 }}>—</span>}
        </td>
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
        {/* 입금일(§11) — 거래 있으면 최종 입금일(읽기전용). 없으면 기존 입력/표시(fallback) */}
        <td style={{ ...tdBase, width: 150 }}>
          {hasTxn(r)
            ? dispPaidDate(r)
            : (editable ? dateCell(r.paidDate, v => patchPaid(i, v), `pay-paid-${i}`, '입금일') : (dateVal(r.paidDate) || '—'))}
        </td>
        {/* 결제구분 */}
        <td style={{ ...tdBase, width: 110 }}>
          {editable
            ? <ClickSelect value={r.paymentType ?? ''} onChange={(v: string) => patchRow(i, { paymentType: v })} triggerStyle={inp} options={PAY_TYPE_OPTS} />
            : labelOf(PAY_TYPE_OPTS, r.paymentType)}
        </td>
        {/* 청구금액(§1/§14) = project_payments.amount. 공급가/부가세는 내부 자동산출(컬럼 미표시). 일반결제: 입력 / 수출바우처: 자동 */}
        <td style={{ ...tdR, width: 132, fontWeight: 700 }}>
          {editable && !voucher ? priceCell(r.amount, v => patchHaap(i, v), `pay-haap-${i}`, '청구금액') : `${won(a.amount)}원`}
        </td>
        {/* 입금은행(§3/§4) — 첫 입금이면 기본행에서 직접 선택(4개 고정). 그 외엔 최근 거래 은행 표시 */}
        <td style={{ ...tdBase, width: 130 }} data-testid={`pay-bank-${i}`}>
          {firstPayMode
            ? <ClickSelect value={r._bank ?? ''} onChange={(v: string) => patchRow(i, { _bank: v })} triggerStyle={inp} options={BANK_OPTS.map(b => ({ value: b, label: b }))} />
            : dispBank(r)}
        </td>
        {/* 입금액(§5/§6/§14) — 첫 입금이면 기본행에서 직접 입력(저장 시 payment_transaction 생성). 그 외엔 Σ거래. 2차+는 '+ 입금' */}
        <td style={{ ...tdR, width: 128 }} data-testid={`pay-paid-amt-${i}`}>
          {firstPayMode
            ? priceCell(r._paidAmt, v => patchRow(i, { _paidAmt: v }), `pay-paidamt-${i}`, '입금액')
            : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                <span style={{ fontWeight: 700, color: paidOf(r) > 0 ? C.primaryText : C.textSecondary }}>{`${won(paidOf(r))}원`}</span>
                {!editable && pid != null && hasTxn(r) && addingFor !== pid && (
                  <button type="button" onClick={() => startAdd(r)} data-testid={`txn-add-open-${i}`}
                    style={{ border: `1px solid ${C.primary}`, borderRadius: 5, background: '#eff6ff', color: C.primaryText, cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '2px 8px' }}>+ 입금</button>
                )}
              </div>
            )}
        </td>
        {/* 미수금 — 첫 입금 입력 중이면 미리보기 반영 */}
        <td style={{ ...tdR, width: 128, color: rowReceivable > 0 ? C.danger : C.textSecondary }}>{`${won(rowReceivable)}원`}</td>
        {/* 입금상태 — 거래 있으면 파생 / 첫 입금 입력 중이면 미리보기 / 그 외 기존 */}
        <td style={{ ...tdBase, width: 110 }}>
          {hasTxn(r)
            ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 700, background: effStatus(r) === 'completed' ? '#dcfce7' : effStatus(r) === 'partial' ? '#fef9c3' : '#f3f4f6', color: effStatus(r) === 'completed' ? '#15803d' : effStatus(r) === 'partial' ? '#854d0e' : '#6b7280' }}>{labelOf(DEPOSIT_OPTS, effStatus(r))}</span>
            : firstPayMode && num(r._paidAmt) > 0
              ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 700, background: firstStatus === 'completed' ? '#dcfce7' : '#fef9c3', color: firstStatus === 'completed' ? '#15803d' : '#854d0e' }}>{labelOf(DEPOSIT_OPTS, firstStatus)}</span>
              : (editable
                  ? <ClickSelect value={r.depositStatus ?? 'scheduled'} onChange={(v: string) => (v === 'completed' ? markPaid(i, r.paidDate || r.expectedDate || todayStr()) : markUnpaid(i, v))} triggerStyle={inp} options={DEPOSIT_OPTS} />
                  : labelOf(DEPOSIT_OPTS, r.depositStatus))}
        </td>
        {/* 입금/결제정보 컬럼 제거(§1) — 입금 상세는 회차 토글로 펼치는 하위 입금행에서 관리 */}
        {/* 비고 — 가장 넓은 컬럼(메모 입력 고려) */}
        <td style={{ ...tdBase, width: 240 }}>
          {editable
            ? <input style={inp} value={r.note ?? ''} onChange={e => patchRow(i, { note: e.target.value })} placeholder="비고" data-testid={`pay-note-${i}`} aria-label="비고" />
            : (r.note || '—')}
        </td>
      </tr>
      {/* 하위 입금행(§7/§8) — 읽기모드 펼침 시 각 payment_transaction 표시(회차/날짜/은행/금액/상세) */}
      {!editable && isOpen && txns.map((t, ti) => (
        <tr key={`t-${t.id ?? ti}`} data-testid={`txn-subrow-${i}-${ti}`}>
          <td colSpan={cols} style={{ ...tdBase, background: '#fbfdff', whiteSpace: 'normal' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 28, fontSize: 12, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, color: C.primaryText }}>└ {ti + 1}차</span>
              <span>{t.paidDate || '—'}</span>
              <span style={{ padding: '1px 7px', borderRadius: 4, background: '#eef2ff', color: '#4338ca', fontWeight: 600 }}>{displayMethod(t.method) || '—'}</span>
              <span style={{ color: '#374151' }}>{t.bankAccount || '—'}</span>
              <span style={{ fontWeight: 700 }}>{won(num(t.customerPaidAmount))}원</span>
              {txnDetail(t) && <span style={{ color: '#6b7280' }}>{txnDetail(t)}</span>}
              {t.note ? <span style={{ color: '#9ca3af' }}>· {t.note}</span> : null}
              <button type="button" onClick={() => deleteTxn(pid!, t.id)} disabled={txnBusy} data-testid={`txn-sub-del-${i}-${ti}`}
                style={{ marginLeft: 'auto', border: `1px solid ${C.g300}`, borderRadius: 5, background: '#fff', color: C.danger, cursor: 'pointer', padding: '2px 8px', fontSize: 11 }}>삭제</button>
            </div>
          </td>
        </tr>
      ))}
      {/* 2차+ 입금 추가(§6/§8) — 거래가 1건 이상인 행에서만. 첫 입금은 기본행(수정모드)에서 직접 입력. */}
      {!editable && isOpen && pid != null && hasTxn(r) && (
        <tr data-testid={`txn-addrow-${i}`}>
          <td colSpan={cols} style={{ ...tdBase, background: '#f8fbff', whiteSpace: 'normal' }}>
            {addingFor === pid
              ? renderTxnAddForm(pid)
              : <button type="button" onClick={() => startAdd(r)} data-testid={`txn-add-open-${i}`}
                  style={{ marginLeft: 28, border: `1px dashed ${C.primary}`, borderRadius: 6, background: '#fff', color: C.primaryText, cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: '5px 12px' }}>└ + 입금 추가</button>}
          </td>
        </tr>
      )}
      </React.Fragment>
    );
  };

  const table = (editable: boolean) => (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.g200}`, borderRadius: BD.radius.md }}>
      {/* table-layout: fixed — 지정한 컬럼 width를 실제 렌더 폭으로 강제(auto는 콘텐츠 기준이라 width가 최소값 취급되어 무시됨).
          컬럼 폭은 첫 행(thead th)의 width로 확정 → th/td width를 동일하게 유지. width=max-content로 폭 합만큼 렌더 후 컨테이너에서 가로 스크롤. */}
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 1900, width: 'max-content' }}>
        <thead><tr>
          <th style={{ ...thBase, width: 96, textAlign: 'center' }}>회차</th>
          <th style={{ ...thBase, width: 180 }}>청구업체</th>
          <th style={{ ...thBase, width: 168 }}>결제방법</th>
          <th style={{ ...thBase, width: 150 }}>발행일</th>
          <th style={{ ...thBase, width: 160 }}>{col2Header}</th>
          <th style={{ ...thBase, width: 150 }}>입금일</th>
          <th style={{ ...thBase, width: 110 }}>결제구분</th>
          <th style={{ ...thBase, width: 132, textAlign: 'right' }}>청구금액</th>
          <th style={{ ...thBase, width: 130 }}>입금은행</th>
          <th style={{ ...thBase, width: 128, textAlign: 'right' }}>입금액</th>
          <th style={{ ...thBase, width: 128, textAlign: 'right' }}>미수금</th>
          <th style={{ ...thBase, width: 110 }}>입금상태</th>
          <th style={{ ...thBase, width: 240 }}>비고</th>
        </tr></thead>
        <tbody>
          {data.map((r, i) => renderRow(r, i, editable))}
          {data.length === 0 && (
            <tr><td colSpan={13} style={{ ...tdBase, textAlign: 'center', color: C.g400, padding: '20px 8px' }}>
              등록된 청구정보가 없습니다. {editable ? '「+ 청구추가」로 청구 내역을 입력하세요.' : '「수정」에서 청구를 추가하세요.'}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  // 차감견적 판매건: 선입금은 매출대금 초과입금이 아니라 예치금이므로 미수금/입금완료율 개념을 쓰지 않는다.
  //  하단 요약을 '이번 서비스 사용액 / 총 선입금액 / 사용가능잔액'(원장 소스)으로 대체한다.
  //  청구정보 테이블(청구·입금 이력)과 세금계산서/VAT 정책은 그대로 유지한다.
  const summaryBox = isPrepaidSale ? (
    <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap', ...TYPO.inputValue, fontVariantNumeric: 'tabular-nums', padding: `${SP[3]}px ${SP[4]}px`, background: C.primaryBg, borderRadius: 8, marginTop: SP[3] }}>
      <span>이번 서비스 사용액 <b>{won(saleTotal)}원</b></span>
      <span>총 선입금액 <b style={{ color: C.primaryText }}>{won(prepaidDeposited ?? 0)}원</b></span>
      <span>사용가능잔액 <b style={{ color: C.primaryText }}>{won(prepaidAvailable ?? 0)}원</b></span>
    </div>
  ) : (
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
