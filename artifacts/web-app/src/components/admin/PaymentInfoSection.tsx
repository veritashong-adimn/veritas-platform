// ─────────────────────────────────────────────────────────────────────────────
// 결제정보 (고객 수금) 섹션 — 판매 상세 D 섹션.
//  · "고객으로부터 얼마를·언제·어떤 방식으로 받았는지" 관리. 통번역사 지급(수행정보)과는 별개.
//  · 저장은 PUT /admin/projects/:id/payment-records (rows + deletedIds). 회차는 서버가 자동번호.
//  · 미수금은 저장하지 않고 화면 계산(총 판매금액 − 총 입금액). 향후 세금계산서·카드매출·자동매칭·채권관리 연계 대비.
// ─────────────────────────────────────────────────────────────────────────────
import { isCardMethod, cardTotals, CardPaidCell, CardFeeEditPanel } from './CardFeeParts';
import React, { useMemo, useState, useEffect } from 'react';
import { formatDisplayDate } from '../../lib/dateFormat';
import { api } from '../../lib/constants';
import { Card, GhostBtn, PrimaryBtn, ClickSelect, confirmDialog } from '../ui';
import { C, TYPO, SP, BD, dsInputStd } from '../../lib/ds';
import { DateField } from './DatePickerShared';
import { saleSplitOf, amountsFromSupply, amountsFromTotal, splitMatched, isInvoiceMethod, isZeroVatMethod, methodVatWarning, METHOD_ZERO_RATED, METHOD_EXEMPT } from '../../lib/paymentSplit';
import { BILLING_METHOD_BY_KIND, type VatMode } from '../../lib/quoteTaxType';
import './readTableView.css';
import { FxEditPanel, FxBilledCell, FxPaidCell, FxReceivableCell, FxStatusBadge, FxTxnAddForm, FxSummaryLine, fxTxnText } from './FxPaymentParts';
import { isForeignCur, rateInputFromPer1, ratePer1FromInput, krwOf, fmtForeign, type FxSummary } from '../../lib/fxMoney';

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
  txnType?: string | null;            // 'deposit' 실제 입금 · 'offset' 선입금 상계(외화 회차) · 'refund' 입금 환불(음수 금액)
  offsetSourcePaymentId?: number | null;
  // 입금내역별 결제구분·입금예정(2026-11) — 입금예정 내역은 실제 입금액 0·입금일 없음(예정액은 수금 집계 제외)
  paymentType?: string | null;        // lump_sum · advance · interim · balance
  expectedDate?: string | null;
  expectedAmount?: string | number | null;
  depositStatus?: 'scheduled' | 'completed';   // 저장 요청 전용(서버 정규화) — 조회 시엔 isScheduledTxn 으로 파생
}
// 입금예정 내역 — 실제 입금(입금일·입금액)이 없는 거래. 미수금·입금액·입금상태 계산에서 0으로 처리된다(서버 집계와 동일).
const isScheduledTxn = (t: PayTxn) => !t.paidDate && Number(t.customerPaidAmount ?? 0) === 0 && Number(t.foreignAmount ?? 0) === 0
  && t.txnType !== 'offset' && t.txnType !== 'refund';
const TXN_PAY_TYPE_OPTS = [
  { value: 'lump_sum', label: '일괄결제' }, { value: 'advance', label: '선금' }, { value: 'interim', label: '중도금' }, { value: 'balance', label: '잔금' },
];
// 분할입금 회차 — 실제·예정 입금내역(환불·상계 제외)이 2건 이상이면 상위 결제구분을 '분할결제'로 표시(저장값은 그대로).
const isSplitDepositRow = (txns?: PayTxn[]) => (txns ?? []).filter(t => t.txnType !== 'refund' && t.txnType !== 'offset').length >= 2;
// 입금내역 목록 열 — 차수 · 결제구분 · 입금상태 · 입금예정일 · 입금일 · 결제방법 · 입금은행 · 입금액 · 비고 · 관리(제목 행과 같은 열 폭)
const TXN_GRID: React.CSSProperties = { display: 'grid', gridTemplateColumns: '48px 72px 76px 100px 100px 96px 116px 170px 260px 104px', columnGap: 10, alignItems: 'center', paddingLeft: 28, fontSize: 12 };
const TXN_HEADS = ['차수', '결제구분', '입금상태', '입금예정일', '입금일', '결제방법', '입금은행', '입금액', '비고', ''];
const TXN_STATUS_OPTS = [{ value: 'completed', label: '입금완료' }, { value: 'scheduled', label: '입금예정' }];
interface PayRow {
  id?: number;
  transactions?: PayTxn[];           // 이 청구행의 수금거래(입금/결제 내역) N건
  // ── 편집모드 전용 임시 필드(첫 입금을 기본 청구행에서 직접 입력) — project_payments 에는 저장 안 함 ──
  _bank?: string;                    // 입금은행(청구 회차 단위 deposit_bank 로 저장 · 첫 입금 거래의 은행으로도 사용)
  _bankOk?: boolean;                 // 입금은행 확인(deposit_bank_confirmed)
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
  depositBank?: string | null;       // 입금은행(청구 회차 단위). NULL 이면 최근 입금거래 은행 표시
  depositBankConfirmed?: boolean | null; // 입금은행 확인 — 미확인 붉은색 / 확인 검정색
  paymentCategory?: string | null;   // 결제유형: 일반결제 · 수출바우처
  payer?: string | null;             // 입금주체: 고객사 · 수출바우처 운영기관
  depositItem?: string | null;       // 입금항목: 공급가액 · 부가세 · 전체금액
  billingCompanyId?: number | null;  // 청구업체
  billingCompanyName?: string | null;
  billingContactId?: number | null;  // 담당자
  billingContactName?: string | null;
  note?: string | null;
  // 외화 청구(결제방법 외화입금) — billingCurrency NULL/KRW = 원화 청구(기존). 환율은 화면 입력 단위(JPY 100엔당)로 편집.
  billingCurrency?: string | null; foreignAmount?: string | null; invoiceFxRate?: string | null; invoiceFxRateInput?: string; invoiceFxDate?: string | null;
  fx?: FxSummary | null;             // 서버 외화 수금 요약(조회)
  _rateInput?: string; _krw?: string; _fee?: string; _paidDate?: string | null;
  // 입금확인(2026-11) — 입금액 옆 체크. 체크 전 입금액은 붉은색(미확인·수금 미반영), 체크 후 검정색(저장 시 실제 입금기록 생성).
  _paidOk?: boolean;      // 입금확인 체크(실제 입금)
  _paidAuto?: boolean;    // 세금계산서 발행일 입력으로 청구금액이 자동 입력된 상태(미확인)
  _legacyPaid?: boolean;  // 입금기록 없이 기존 방식으로 입금완료 확정된 회차(보호 — 입금기록 신규 생성 안 함)
  _customType?: boolean;  // 결제구분 '직접입력' 선택(명칭 입력 중)
  _advRate?: string;      // 선금 비율(%) 입력값(일반결제 선금 행) — 저장 시 deposit_item '선금비율:N'
  _cardFee?: string; _cardRate?: string;   // 카드결제 첫 입금: 카드사 수수료·수수료율 입력(실제 입금액은 _paidAmt)   // 첫 외화 입금: 적용환율(입력 단위)·은행확인 원화액·수수료·실제 입금일
}

interface Props {
  projectId: number;
  token: string;
  paymentRecords: any[];
  saleTotal: number;                 // 총 판매금액(견적 total = 공급가+부가세)
  // 판매 견적에 실제 저장된 공급가액·부가세(품목 합계). 주어지고 합이 총액과 같으면 청구 검증·기본값의 기준으로 쓴다
  //  (영세율·해외 통역 등 부가세 0원 판매를 10%로 재계산하지 않기 위함). 없으면 기존 총액÷1.1 분해.
  saleSupplyAmount?: number | null;
  saleVatAmount?: number | null;
  // 판매 견적 세금 유형(견적 품목 저장값 기준) — 신규 청구행 기본 결제·발행 유형 결정용. 기존 청구행·금액은 바꾸지 않는다.
  saleTaxType?: VatMode;
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
// 결제방법 — text(자유 입력). 기본 4개(라벨=값) + '기타' 직접입력. 저장은 라벨/사용자 문자열 그대로.
//  · 영세율 계산서·면세 계산서(부가세 0원) — 서로 다른 값으로 저장. 세금 구분 규칙은 lib/paymentSplit.
const METHOD_OPTS = [
  { value: '세금계산서', label: '세금계산서' },
  { value: METHOD_ZERO_RATED, label: '영세율 계산서' }, { value: METHOD_EXEMPT, label: '면세 계산서' },
  { value: '카드', label: '신용카드' },   // 저장값 '카드' 유지(표시명만 신용카드)
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
const METHOD_DISPLAY: Record<string, string> = { '외화송금': '외화입금', '카드': '신용카드' };
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
// 결제구분(2026-11) — 일괄결제·선금·중도금·잔금·부가세·공급가·직접입력. DB 스키마 변경 없이 저장:
//   · 일괄결제·선금·중도금·잔금 = payment_type enum 그대로(입금항목 deposit_item 은 기본값: 일반 '전체금액' / 수출바우처 입금주체 기준)
//   · 부가세 = payment_type 'other' + deposit_item '부가세' / 공급가 = 'other' + '공급가액' / 직접입력 = 'other' + deposit_item = 입력 명칭
//   · 기존 '기타'(other + '전체금액'·비어 있음)는 그대로 '기타'로 조회된다. 결제구분 선택은 청구금액을 바꾸지 않는다.
const PAY_TYPE_UI_OPTS = [
  { value: 'lump_sum', label: '일괄결제' }, { value: 'advance', label: '선금' }, { value: 'interim', label: '중도금' }, { value: 'balance', label: '잔금' },
  { value: 'vat', label: '부가세' }, { value: 'supply', label: '공급가' }, { value: 'custom', label: '직접입력' },
];
const payTypeKey = (r: { paymentType?: string | null; depositItem?: string | null; _customType?: boolean }): string => {
  if (r._customType) return 'custom';
  if (r.paymentType !== 'other') return r.paymentType ?? '';
  const it = (r.depositItem ?? '').trim();
  return it === ITEM_VAT ? 'vat' : it === ITEM_SUPPLY ? 'supply' : (!it || it === ITEM_TOTAL) ? 'other' : 'custom';
};
// 선금 비율(2026-11) — 스키마 변경 없이 일반결제 선금 행의 deposit_item 에 '선금비율:50' 형식으로 저장.
//  · 비율 미입력(기존 선금 행 포함)은 deposit_item '전체금액' 그대로 → 표시 '선금'(기존과 동일). 비율은 표시·청구금액 계산 보조용일 뿐
//    청구·입금·미수금 계산은 기존대로 amount 기준이며, 선금 등록만으로 입금확인하지 않는다.
const ADV_RATE_PREFIX = '선금비율:';
const parseAdvRateInput = (s: string | null | undefined): number | null => {
  const t = String(s ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 100 ? n : null;
};
const advRateOf = (r: { paymentType?: string | null; depositItem?: string | null }): number | null => {
  if (r.paymentType !== 'advance') return null;
  const it = (r.depositItem ?? '').trim();
  return it.startsWith(ADV_RATE_PREFIX) ? parseAdvRateInput(it.slice(ADV_RATE_PREFIX.length)) : null;
};
const payTypeLabel = (r: { paymentType?: string | null; depositItem?: string | null; _customType?: boolean }): string => {
  const k = payTypeKey(r);
  if (k === 'custom') return (r.depositItem ?? '').trim() || '직접입력';
  if (k === 'other') return '기타';
  if (k === 'advance') { const rate = advRateOf(r); if (rate != null) return `선금(${rate}%)`; }
  return PAY_TYPE_UI_OPTS.find(o => o.value === k)?.label ?? '—';
};
const DEPOSIT_ITEM_OPTS = [{ value: ITEM_SUPPLY, label: '공급가액' }, { value: ITEM_VAT, label: '부가세' }, { value: ITEM_TOTAL, label: '전체금액' }];
const labelOf = (opts: { value: string; label: string }[], v?: string | null) => opts.find(o => o.value === v)?.label ?? '—';

// 입금은행 — 선택 순서: 국민은행 → 기업은행 → 우리은행 → 기업은행외화 → 기타(직접입력). 신규 청구 기본 국민은행, 외화송금 기본 기업은행외화.
const BANK_OPTS = ['국민은행', '기업은행', '우리은행', '기업은행외화'];
const BANK_DEFAULT = '국민은행';
const BANK_CUSTOM = '__bank_custom__';
// 저장된 입금은행이 없을 때의 기본 표시값(미확인 상태) — 외화입금 회차는 기업은행외화, 그 외 국민은행. 저장값이 있으면 항상 저장값 유지.
const defaultBankFor = (method?: string | null) => (isOverseas(method) ? '기업은행외화' : BANK_DEFAULT);
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
  { value: '국내이체', label: '국내이체' }, { value: '외화송금', label: '외화입금' }, { value: '카드', label: '신용카드' },
  { value: '세금계산서', label: '세금계산서' }, { value: '현금', label: '현금' }, { value: '기타', label: '기타' },
];

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const won = (n: number) => Math.round(n).toLocaleString('ko-KR');
const dateVal = (v?: string | null) => (v ? String(v).slice(0, 10) : '');
// 결제방법별 첫 예정/이벤트 날짜(expectedDate)의 컬럼명 — 카드=카드결제일 · 외화송금=송금예정일 · 그 외(세금계산서·현금·기타)=입금예정일.
const scheduledLabel = (method?: string | null) => {
  const m = normMethod(method);
  if (m === '카드') return '카드결제일';
  if (m === '외화송금') return '송금예정일';
  return '입금예정일';
};
// 천 단위 콤마 표시(입력은 숫자만 저장). 부가세 계산·청구 합계 검증은 lib/paymentSplit(부가세 0원 판매는 0 유지).
//  ⚠ numeric(14,2) DB값은 "5500000.00" 처럼 소수점이 붙어 오므로 [^\d] 제거는 소수점까지 지워 100배로 부풀린다.
//  → num()으로 정확히 파싱 후 반올림 표시(소수점 안전).
const commafy = (v: unknown) => { const n = num(v); return n ? Math.round(n).toLocaleString('ko-KR') : ''; };

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

// 입금은행 필드 — 결제방법과 같은 인플레이스 패턴. 목록 4개 + '기타(직접입력)' 선택 시 같은 칸에서 은행명 직접 입력.
//  · 저장값이 목록에 없으면(직접입력·과거값) 자동으로 직접입력 모드. ▾ 로 목록 복귀.
function BankField({ value, onChange, triggerStyle, testid }: {
  value: string; onChange: (v: string) => void; triggerStyle: React.CSSProperties; testid: string;
}) {
  const v = (value ?? '').trim();
  const derivedCustom = !!v && !BANK_OPTS.includes(v);
  const [manualCustom, setManualCustom] = useState(false);
  useEffect(() => { if (v && BANK_OPTS.includes(v)) setManualCustom(false); }, [v]);
  if (derivedCustom || manualCustom) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0, flex: 1 }}>
        <input type="text" style={{ ...triggerStyle, flex: 1, minWidth: 0 }} value={value ?? ''} autoFocus={manualCustom}
          onChange={e => onChange(e.target.value)} placeholder="은행명 직접입력" data-testid={`${testid}-custom`} aria-label="입금은행 직접입력" />
        <button type="button" aria-label="은행 목록에서 선택" title="목록에서 선택" onClick={() => { setManualCustom(false); onChange(BANK_DEFAULT); }}
          style={{ flexShrink: 0, border: `1px solid ${C.g300}`, borderRadius: 6, background: C.bgCard, color: C.textSecondary, cursor: 'pointer', padding: '4px 7px', fontSize: 11, lineHeight: 1 }}>▾</button>
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minWidth: 0 }} data-testid={testid}>
      <ClickSelect value={v} style={{ display: 'block', width: '100%' }} triggerStyle={triggerStyle} aria-label="입금은행 선택"
        options={[...BANK_OPTS.map(b => ({ value: b, label: b })), { value: BANK_CUSTOM, label: '기타(직접입력)' }]}
        onChange={(nv: string) => { if (nv === BANK_CUSTOM) { setManualCustom(true); onChange(''); } else onChange(nv); }} />
    </div>
  );
}

// 청구업체 — 거래처명 입력 → /admin/companies?search 결과에서 선택(거래처 연결) 또는 업체명 직접입력(미연결, Master 생성 없음).
//  · onType: 입력값을 그대로 청구업체명으로 반영(선택 전까지 거래처 미연결). 이전에는 선택하지 않으면 입력값이 버려졌다.
//  · onEmpty: 칸을 비우고 나가면 판매 거래처 기본값으로 되돌린다.
function CompanyPicker({ token, companyName, linked = true, onPick, onType, onEmpty, style, testid }: {
  token: string; companyName?: string | null; linked?: boolean;
  onPick: (c: { id: number; name: string }) => void; onType?: (name: string) => void; onEmpty?: () => void;
  style: React.CSSProperties; testid?: string;
}) {
  const [q, setQ] = useState(companyName ?? '');
  const [results, setResults] = useState<{ id: number; name: string; customerType?: string | null; phone?: string | null; mobile?: string | null; email?: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { setQ(companyName ?? ''); }, [companyName]);
  const search = async (term: string) => {
    setQ(term); setOpen(true);
    if (!term.trim()) { setResults([]); return; }
    try {
      const res = await fetch(api(`/api/admin/companies?search=${encodeURIComponent(term)}&pageSize=8`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      const rows = Array.isArray(data) ? data : (data.rows ?? []);
      setResults(rows.slice(0, 8).map((c: any) => ({ id: c.id, name: c.name, customerType: c.customerType, phone: c.phone, mobile: c.mobile, email: c.email })));
    } catch { setResults([]); }
  };
  return (
    <div style={{ position: 'relative' }} onBlur={() => setTimeout(() => { setOpen(false); if (!q.trim()) onEmpty?.(); }, 150)}>
      <input style={style} value={q} placeholder="거래처 검색 또는 업체명 입력" aria-label="청구업체 검색 또는 입력" data-testid={testid}
        onChange={e => { search(e.target.value); onType?.(e.target.value); }} onFocus={() => { if (results.length) setOpen(true); }} />
      {!linked && q.trim() && (
        <div data-testid={testid ? `${testid}-unlinked` : undefined} title="거래처 목록에서 선택하지 않은 업체명입니다. 거래처 정보는 변경·생성되지 않습니다."
          style={{ fontSize: 10, color: '#b45309', marginTop: 2, whiteSpace: 'nowrap' }}>직접입력 · 거래처 미연결</div>
      )}
      {open && results.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: '#fff', border: `1px solid ${C.g200}`, borderRadius: 6, boxShadow: '0 4px 18px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto' }}>
          {results.map(c => {
            // 개인고객은 동명이인 식별을 위해 휴대전화·이메일을 보조줄로 표시(§6). 기업은 이름만.
            const hint = c.customerType === 'INDIVIDUAL'
              ? [(c.mobile || c.phone || '').trim() || null, c.email || null].filter(Boolean).join(' · ')
              : '';
            return (
              <div key={c.id} onMouseDown={() => { onPick(c); setQ(c.name); setOpen(false); setResults([]); }}
                style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span>{c.name}{c.customerType === 'INDIVIDUAL' && <span style={{ marginLeft: 6, fontSize: 10, color: '#c2410c' }}>개인고객</span>}</span>
                {hint && <div style={{ fontSize: 10, color: '#94a3b8' }}>{hint}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PaymentInfoSection({ projectId, token, paymentRecords, saleTotal, saleSupplyAmount = null, saleVatAmount = null, saleTaxType, defaultCompany, isPrepaidSale = false, prepaidDeposited = null, prepaidAvailable = null, onChanged, onToast }: Props) {
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
  const [editingTxnId, setEditingTxnId] = useState<number | null>(null);   // 입금내역 수정 대상(같은 입력줄 재사용)
  const [carryLegacy, setCarryLegacy] = useState(false);                   // 기존 확정 입금 → 입금내역 이관 요청(입금거래 없는 입금완료 회차)
  // 입금 환불 — 대상 청구행 id·입력값(환불일·환불금액은 직접 입력, 기본값 없음)
  const [refundFor, setRefundFor] = useState<number | null>(null);
  const [refundForm, setRefundForm] = useState<{ date: string; amount: string; note: string }>({ date: '', amount: '', note: '' });
  const toggleExpand = (id: number) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const list: PayRow[] = paymentRecords ?? [];
  // 결제유형 — 저장 데이터에서 판단(수출바우처 행이 하나라도 있으면 수출바우처).
  const listCategory = list.some(r => r.paymentCategory === CAT_VOUCHER || r.payer === PAYER_OPERATOR) ? CAT_VOUCHER : CAT_GENERAL;
  // 판매 공급가/부가세(분할청구 검증 기준) — 견적에 저장된 실제 값 우선(합 = 총액일 때), 없으면 총판매에서 10% 기준 분해.
  const split = useMemo(() => saleSplitOf(saleTotal, saleSupplyAmount, saleVatAmount), [saleTotal, saleSupplyAmount, saleVatAmount]);
  const saleSupply = split.supply;
  const saleVat = split.vat;
  // 부가세 0원 판매(영세율·해외 통역 등) — 청구 금액 입력 시에도 부가세 0 유지(10% 자동계산 안 함)
  const zeroVatSale = split.zeroVat;
  // 신규 청구행 기본 결제·발행 유형 — 영세율 판매=영세율 계산서, 면세 판매=면세 계산서, 그 외(일반과세·확인 필요)=세금계산서(기존)
  const defaultMethod = saleTaxType === 'zero_rate' || saleTaxType === 'exempt' ? BILLING_METHOD_BY_KIND[saleTaxType] : '세금계산서';

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

  // 청구업체명 직접입력 — 이 회차만 변경. 입력한 이름을 저장값으로 쓰고 거래처 연결·담당자는 해제(다른 회차·판매 거래처 불변).
  const typeCompany = (i: number, name: string) => patchRow(i, { billingCompanyId: null, billingCompanyName: name, billingContactId: null, billingContactName: null });
  // 비우면 판매 거래처 기본값으로 복귀(명시적 기본값 처리)
  const resetCompany = (i: number) => patchRow(i, { billingCompanyId: defaultCompany?.id ?? null, billingCompanyName: defaultCompany?.name ?? null, billingContactId: null, billingContactName: null });

  const mapRow = (r: PayRow): PayRow => {
  // §8 수정모드 복원 — 이 청구행이 '첫 입금' 거래 1건만 가진 경우, 그 거래값을 기본행 임시필드로 되살린다.
  //  (거래 2건 이상은 첫입금 인라인 대상이 아니라 하위행에서 관리 → 시드하지 않음)
  const only = (r.transactions && r.transactions.length === 1 && !isScheduledTxn(r.transactions[0])) ? r.transactions[0] : null;   // 입금예정 내역은 첫 입금 인라인 대상 아님
  const seedCurr = only?.currency && only.currency !== 'KRW' ? only.currency : '';
  return {
    id: r.id, transactions: r.transactions ?? [],   // 수금거래는 하위행/기본행에서 관리 — 편집 중에도 계산 일관성 위해 보존
    _txnId: only?.id,
    // 입금은행 — 청구 회차에 저장된 값 우선, 없으면(기존 행) 첫 입금 거래 은행, 그것도 없으면 기본 은행(국민은행·미확인). 확인 여부는 저장값.
    _bank: (r.depositBank ?? '').trim() || (only?.bankAccount ?? '').trim() || defaultBankFor(r.paymentMethod),
    _bankOk: !!r.depositBankConfirmed && !!((r.depositBank ?? '').trim() || (only?.bankAccount ?? '').trim()), _paidAmt: only && num(only.customerPaidAmount) > 0 ? String(num(only.customerPaidAmount)) : '',
    _curr: seedCurr, _foreign: only && num(only.foreignAmount) > 0 ? String(num(only.foreignAmount)) : '',
    // 발행일(세금계산서) — 수정 화면에서도 저장값 그대로(누락 시 저장하면 발행일이 지워짐)
    issueDate: r.issueDate ? String(r.issueDate).slice(0, 10) : null,
    expectedDate: r.expectedDate ?? null, paidDate: r.paidDate ?? null,
    paymentType: r.paymentType ?? null, paymentMethod: r.paymentMethod ?? null,
    supplyAmount: r.supplyAmount ?? '', vatAmount: r.vatAmount ?? '', amount: r.amount ?? '',
    depositStatus: r.depositStatus ?? 'scheduled', depositConfirmed: r.depositConfirmed ?? false,
    paymentCategory: r.paymentCategory ?? CAT_GENERAL, payer: r.payer ?? null, depositItem: r.depositItem ?? null,
    _advRate: (() => { const v = advRateOf(r); return v != null ? String(v) : ''; })(),
    billingCompanyId: r.billingCompanyId ?? null, billingCompanyName: r.billingCompanyName ?? null,
    billingContactId: r.billingContactId ?? null, billingContactName: r.billingContactName ?? null,
    note: r.note ?? '',
    billingCurrency: r.billingCurrency ?? null, foreignAmount: r.foreignAmount != null ? String(r.foreignAmount) : null,
    invoiceFxRateInput: rateInputFromPer1(r.invoiceFxRate, r.billingCurrency), invoiceFxDate: r.invoiceFxDate ?? null, fx: r.fx ?? null,
    _rateInput: only ? rateInputFromPer1(only.fxRate, only.currency) : '',
    // 은행 확인 원화액: 저장된 환산액이 외화×환율 계산값과 다를 때만(직접 입력했던 값) 복원
    _krw: only && only.krwAmount != null && only.fxRate != null && krwOf(only.foreignAmount, only.fxRate) !== Math.round(num(only.krwAmount)) ? String(Math.round(num(only.krwAmount))) : '',
    _fee: only && num(only.feeAmount) > 0 ? String(only.feeAmount) : '',
    _paidDate: only?.paidDate ?? null,
    // 입금확인 상태 — 입금기록이 있으면 확인(검정). 입금기록 없이 기존 방식으로 입금완료 확정된 회차는 보호(_legacyPaid, 청구금액=입금액으로 표시).
    _paidOk: !!only || (!(r.transactions?.length) && r.depositStatus === 'completed' && !!r.depositConfirmed && !!r.paidDate),
    _legacyPaid: !(r.transactions?.length) && r.depositStatus === 'completed' && !!r.depositConfirmed && !!r.paidDate,
    ...(!(r.transactions?.length) && r.depositStatus === 'completed' && !!r.depositConfirmed && !!r.paidDate ? { _paidAmt: String(num(r.amount)) } : {}),
    // 발행일만 있고 입금 미확인 → 조회와 같은 기준으로 청구금액을 자동입력(붉은색·미확인) 상태로 연다(저장 시 입금기록 생성 안 함)
    ...(!(r.transactions?.length) && !(r.depositStatus === 'completed' && !!r.depositConfirmed && !!r.paidDate) && r.issueDate && num(r.amount) > 0
      ? { _paidAmt: String(num(r.amount)), _paidAuto: true } : {}),
    ...(only && isCardMethod(normMethod(r.paymentMethod)) && only.settledAmount != null && num(only.feeAmount) > 0
      ? { _paidAmt: String(Math.round(num(only.settledAmount))), _cardFee: String(Math.round(num(only.feeAmount))) } : {}),
  };
  };
  // 외화 청구회차 = 결제방법 외화입금 + 청구통화 외화(원화 청구 외화입금은 기존 원화 방식)
  const isFxRow = (r: PayRow) => isOverseas(r.paymentMethod) && isForeignCur(r.billingCurrency);
  const enterEdit = () => {
    const mapped = list.map(mapRow);
    // #5 일반청구 기본값 — 청구가 없으면 판매 거래처 기준 1건 자동 시드(공급가/부가세/합계 = 판매 총액).
    if (mapped.length === 0) {
      mapped.push({
        _bank: BANK_DEFAULT, _bankOk: false,   // 신규 청구 회차: 입금은행 기본 국민은행 · 미확인
        paymentCategory: CAT_GENERAL, payer: PAYER_CUSTOMER, depositItem: ITEM_TOTAL,
        paymentMethod: defaultMethod, paymentType: 'lump_sum', depositStatus: 'scheduled',
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
    { _bank: BANK_DEFAULT, _bankOk: false, paymentCategory: CAT_VOUCHER, payer: PAYER_CUSTOMER, depositItem: ITEM_VAT, paymentMethod: '세금계산서', paymentType: 'lump_sum', depositStatus: 'scheduled',
      billingCompanyId: defaultCompany?.id ?? null, billingCompanyName: defaultCompany?.name ?? null,
      supplyAmount: '0', vatAmount: String(saleVat), amount: String(saleVat) },
    { _bank: BANK_DEFAULT, _bankOk: false, paymentCategory: CAT_VOUCHER, payer: PAYER_OPERATOR, depositItem: ITEM_SUPPLY, paymentMethod: '기타', paymentType: 'lump_sum', depositStatus: 'scheduled',
      billingCompanyId: null, billingCompanyName: PAYER_OPERATOR,
      supplyAmount: String(saleSupply), vatAmount: '0', amount: String(saleSupply) },
  ]);
  const generalRow = (): PayRow => ({
    _bank: BANK_DEFAULT, _bankOk: false,
    paymentCategory: CAT_GENERAL, payer: PAYER_CUSTOMER, depositItem: ITEM_TOTAL, paymentMethod: defaultMethod, paymentType: 'lump_sum', depositStatus: 'scheduled',
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
  //  입금거래(입금·환불 이력)가 있는 회차는 삭제하지 않고 새 유형의 첫 회차(수출바우처는 고객사·부가세 회차)로 이어 쓴다 — 거래 이력 보존.
  const changeCategory = (v: string) => {
    if (v === category) return;
    const keep = rows.find(r => r.id != null && (r.transactions?.length ?? 0) > 0);
    setDeletedIds(d => [...d, ...rows.filter(r => r.id != null && r.id !== keep?.id).map(r => r.id as number)]);
    setCategory(v);
    const fresh = v === CAT_VOUCHER ? voucherRows() : [generalRow()];
    if (keep) fresh[0] = { ...fresh[0], id: keep.id, transactions: keep.transactions, note: keep.note,
      depositStatus: keep.depositStatus, depositConfirmed: keep.depositConfirmed, paidDate: keep.paidDate };
    setRows(fresh);
    if (v === CAT_VOUCHER && defaultCompany?.id) loadContacts(defaultCompany.id);
  };

  const patchRow = (i: number, p: Partial<PayRow>) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...p } : r));
  // ── 입금완료 상태 정합(§TOP3) — 세 필드(completed·confirmed·paidDate)는 항상 함께 움직인다(모순 금지) ──
  //  · 입금완료: depositStatus='completed' + depositConfirmed=true + paidDate(실제/지정 입금일) 동시 세팅.
  //  · 미입금: depositConfirmed=false + paidDate=null + depositStatus는 completed가 아닌 값(기본 'scheduled').
  const markPaid = (i: number, paidDate: string) => patchRow(i, { depositStatus: 'completed', depositConfirmed: true, paidDate });
  const markUnpaid = (i: number, status: string = 'scheduled') => patchRow(i, { depositStatus: status, depositConfirmed: false, paidDate: null });
  const todayStr = () => new Date().toISOString().slice(0, 10);
  // 결제방법 변경 — 계산서(세금·영세율·면세)가 아니면 발행일 자동 클리어(계산서만 발행일 사용).
  //  금액(공급가·부가세·청구금액)은 결제방법 변경만으로 다시 계산하지 않는다(불일치는 경고만).
  //  외화송금 선택 시(§11/§12) 기본 제안값(입금은행 기업은행외화·통화 USD)을 비어있을 때만 채운다(강제 아님, 사용자가 변경 가능).
  const patchMethod = (i: number, v: string) => setRows(prev => prev.map((r, idx) => {
    if (idx !== i) return r;
    const next: PayRow = { ...r, paymentMethod: v, ...(!isInvoiceMethod(v) ? { issueDate: null } : {}) };
    if (isOverseas(v)) { if (!next._bank || (next._bank === BANK_DEFAULT && !next._bankOk)) { next._bank = '기업은행외화'; next._bankOk = false; } if (!next._curr) next._curr = 'USD'; if (!next.billingCurrency) next.billingCurrency = next._curr; }
    else next.billingCurrency = null;
    return next;
  }));
  // 입금일 변경 — 입력 시 입금완료(3필드 세트), 삭제 시 미입금(3필드 세트)으로 정합. 모순 상태를 만들지 않는다.
  // 입금일 직접 입력 = 입금확인(입금액 없으면 청구금액). 삭제 = 확인 해제(입금기록이 아직 없을 때만 — 기존 입금기록은 입금내역에서 정정).
  const patchPaid = (i: number, v: string) => {
    const r = rows[i];
    if (v) { markPaid(i, v); patchRow(i, { _paidOk: true, _paidAuto: false, ...(num(r._paidAmt) > 0 ? {} : { _paidAmt: String(effAmounts(r, category === CAT_VOUCHER).amount) }) }); }
    else { markUnpaid(i); patchRow(i, { _paidOk: false }); }
  };
  // 결제구분 변경 — 청구금액은 바꾸지 않는다. 부가세/공급가/직접입력은 payment_type 'other' + deposit_item 으로 저장(스키마 불변).
  const changePayType = (i: number, key: string) => {
    const r = rows[i];
    const voucher = category === CAT_VOUCHER;
    const defItem = voucher ? (r.payer === PAYER_OPERATOR ? ITEM_SUPPLY : ITEM_VAT) : ITEM_TOTAL;
    if (key === 'vat') patchRow(i, { paymentType: 'other', depositItem: ITEM_VAT, _customType: false });
    else if (key === 'supply') patchRow(i, { paymentType: 'other', depositItem: ITEM_SUPPLY, _customType: false });
    else if (key === 'custom') patchRow(i, { paymentType: 'other', depositItem: payTypeKey(r) === 'custom' ? r.depositItem : '', _customType: true });
    else if (key === 'other') patchRow(i, { paymentType: 'other', depositItem: ITEM_TOTAL, _customType: false });
    else patchRow(i, { paymentType: key, depositItem: defItem, _customType: false, _advRate: '' });
  };
  // 선금 비율 입력(일반결제) — 유효(0 초과 100 이하)하면 청구금액 = 총 판매금액(VAT 포함) × 비율 / 100(원 단위 반올림),
  //  공급가·부가세는 청구금액 입력과 같은 규칙으로 역산. 비우거나 범위 밖이면 금액은 그대로 두고 비율 저장 안 함('전체금액').
  const patchAdvRate = (i: number, v: string) => {
    const s = v.replace(/[^\d.]/g, '').slice(0, 6);
    const rate = parseAdvRateInput(s);
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      const next: PayRow = { ...r, _advRate: s, depositItem: rate != null ? `${ADV_RATE_PREFIX}${rate}` : ITEM_TOTAL };
      if (rate == null) return next;
      const amt = Math.round(num(saleTotal) * rate / 100);
      return { ...next, ...amountsFromTotal(String(amt), zeroVatSale || isZeroVatMethod(r.paymentMethod)) };
    }));
  };
  // 세금계산서 발행일 → 입금액 자동입력(청구금액, 붉은색·미확인). 실제 입금기록·기존 확인값은 덮어쓰지 않는다. 발행일만으로는 입금 처리 안 함.
  const patchIssue = (i: number, v: string) => setRows(prev => prev.map((r, idx) => {
    if (idx !== i) return r;
    const next: PayRow = { ...r, issueDate: v || null };
    const locked = (r.transactions?.length ?? 0) > 0 || r._paidOk || r._legacyPaid;
    if (!locked) {
      if (v && (!r._paidAmt || r._paidAuto)) { next._paidAmt = String(effAmounts(r, category === CAT_VOUCHER).amount); next._paidAuto = true; }
      else if (!v && r._paidAuto) { next._paidAmt = ''; next._paidAuto = false; }
    }
    return next;
  }));
  // 입금확인 체크(입금액 옆) — 체크: 입금일(입력값 › 입금예정일 › 오늘) 확정·검정색, 저장 시 실제 입금기록 1건 생성(부분입금 가능).
  //  해제: 아직 입금기록이 없을 때만(붉은색 복귀). 이미 입금기록이 있거나 기존 확정 회차는 입금내역의 정정 절차로만 변경.
  const togglePaidConfirm = (i: number) => {
    const r = rows[i];
    if ((r.transactions?.length ?? 0) > 0 || r._legacyPaid) { onToast('이미 입금기록이 있습니다. 변경·취소는 입금내역에서 정정하세요.'); return; }
    if (!r._paidOk) {
      if (num(r._paidAmt) <= 0 && num(r._foreign) <= 0) { onToast('입금액을 입력한 뒤 확인하세요.'); return; }
      markPaid(i, r.paidDate || r.expectedDate || todayStr());
      patchRow(i, { _paidOk: true, _paidAuto: false });
    } else {
      markUnpaid(i); patchRow(i, { _paidOk: false });
    }
  };
  // 공급가액 입력 → 부가세(10%)·합계 정방향 계산. 빈 값이면 모두 비움.
  const patchSupply = (i: number, digits: string) => {
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      return { ...r, ...amountsFromSupply(digits, zeroVatSale || isZeroVatMethod(r.paymentMethod)) };
    }));
  };
  // 합계 입력 → 공급가액(합계÷1.1 반올림)·부가세(합계−공급가액) 역산. 공급가액+부가세는 항상 합계와 일치. 빈 값이면 모두 비움.
  const patchHaap = (i: number, digits: string) => {
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      return { ...r, ...amountsFromTotal(digits, zeroVatSale || isZeroVatMethod(r.paymentMethod)) };
    }));
  };
  // 새 청구 기본값 — 청구업체=판매 거래처, 결제방법 세금계산서, 결제구분 일괄결제, 입금주체 고객사, 입금항목 전체금액.
  const addRow = () => setRows(prev => [...prev, { _bank: BANK_DEFAULT, _bankOk: false, depositStatus: 'scheduled', supplyAmount: '', vatAmount: '', amount: '', paymentMethod: category === CAT_GENERAL ? defaultMethod : '세금계산서', paymentType: 'lump_sum', paymentCategory: category, payer: PAYER_CUSTOMER, depositItem: ITEM_TOTAL, billingCompanyId: defaultCompany?.id ?? null, billingCompanyName: defaultCompany?.name ?? null }]);
  const removeRow = (i: number) => setRows(prev => {
    const target = prev[i];
    if (target?.id != null) setDeletedIds(d => [...d, target.id!]);
    return prev.filter((_, idx) => idx !== i);
  });

  const save = async () => {
    if (busy) return;
    const noLabel = rows.findIndex(r => payTypeKey(r) === 'custom' && !(r.depositItem ?? '').trim());
    if (noLabel >= 0) { onToast(`${noLabel + 1}회차: 직접입력 결제구분 명칭을 입력하세요.`); return; }
    const badRate = category === CAT_GENERAL ? rows.findIndex(r => payTypeKey(r) === 'advance' && (r._advRate ?? '').trim() !== '' && parseAdvRateInput(r._advRate) == null) : -1;
    if (badRate >= 0) { onToast(`${badRate + 1}회차: 선금 비율은 0 초과 100 이하로 입력하세요(소수점 2자리까지).`); return; }
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
            // 회차별 청구업체명(직접입력 포함). 비어 있으면 판매 거래처 기본값.
            billingCompanyName: (r.billingCompanyName ?? '').trim() || (r.billingCompanyId == null ? (defaultCompany?.name ?? null) : null),
            // 외화 청구(외화입금 + 외화 통화만). 그 외는 원화 청구(NULL)
            ...(isFxRow(r)
              ? { billingCurrency: String(r.billingCurrency).toUpperCase(), foreignAmount: r.foreignAmount || null,
                  invoiceFxRate: ratePer1FromInput(r.invoiceFxRateInput, r.billingCurrency), invoiceFxDate: r.invoiceFxDate || null }
              : { billingCurrency: null }),
            ...((r.billingCompanyName ?? '').trim() || r.billingCompanyId != null ? {} : { billingCompanyId: defaultCompany?.id ?? null }),
            note: r.note || null,
            // 입금은행·확인(청구 회차 단위) — 입금 전에도 저장. 은행이 없으면 확인도 해제.
            depositBank: (r._bank ?? '').trim() || null,
            depositBankConfirmed: !!r._bankOk && !!(r._bank ?? '').trim(),
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
      // 저장 결과 확인 — 서버가 실제 저장한 회차별 청구업체명이 요청과 다르면 성공 처리하지 않는다.
      const sent: any[] = payload.rows;
      const mismatch = sent.findIndex((s, idx) => s.billingCompanyName && (savedRows[idx]?.billingCompanyName ?? null) !== s.billingCompanyName);
      if (mismatch >= 0) { onToast(`청구업체 저장 확인 실패(${mismatch + 1}회차) — 다시 시도해 주세요.`); await onChanged(); return; }
      const firstPays = rows.map((r, idx) => ({ r, idx })).filter(({ r }) => {
        const cnt = r.transactions?.length ?? 0;
        if (cnt > 1) return false;
        const overseas = isOverseas(r.paymentMethod);
        // 입금확인 체크된 회차만 실제 입금기록 생성(자동입력·미확인 금액은 기록하지 않음). 기존 확정 회차(_legacyPaid)는 중복 생성 금지.
        if (r._legacyPaid || (!isFxRow(r) && !r._paidOk && !r._txnId)) return false;   // 외화 청구회차는 기존 외화 입금 입력 방식 유지
        return num(r._paidAmt) > 0 || (overseas && num(r._foreign) > 0);
      });
      for (const { r, idx } of firstPays) {
        const saved = savedRows[idx];
        if (!saved?.id) continue;
        const m = normMethod(r.paymentMethod) || '기타';
        const cur = String(r.billingCurrency ?? '').toUpperCase();
        // 외화 청구회차: 외화 입금액(통화 단위 그대로)·입금 적용환율·은행확인 원화액·수수료. 원화 환산·원화 결제액은 서버가 decimal 로 확정.
        const txn: PayTxn & Record<string, unknown> = isFxRow(r) ? {
          ...(r._txnId ? { id: r._txnId } : {}), txnType: 'deposit', method: '외화송금',
          paidDate: r._paidDate || r.paidDate || null, bankAccount: r._bank || null, currency: cur, foreignAmount: r._foreign || null,
          fxRate: ratePer1FromInput(r._rateInput, cur), krwAmount: r._krw ? Number(r._krw) : null, feeAmount: r._fee || null,
        } : {
          ...(r._txnId ? { id: r._txnId } : {}),
          paidDate: r.paidDate || null, method: m, customerPaidAmount: num(r._paidAmt) + (isCardMethod(m) ? num(r._cardFee) : 0), bankAccount: r._bank || null,
          // 카드: 실제 입금액(정산액)·카드사 수수료 별도 저장. 수수료 미입력이면 기존과 같이 입금액만(임의 생성 없음).
          ...(isCardMethod(m) && num(r._cardFee) > 0 ? { settledAmount: num(r._paidAmt), feeAmount: num(r._cardFee) } : (isCardMethod(m) && r._txnId ? { settledAmount: null, feeAmount: null } : {})),
          ...(isOverseas(m) ? { currency: r._curr || null, foreignAmount: num(r._foreign) || null } : {}),
        };
        const tr = await fetch(api(`/api/admin/project-payments/${saved.id}/transactions`), { method: 'PUT', headers: authH, body: JSON.stringify({ rows: [txn], deletedIds: [] }) });
        if (!tr.ok) { const d = await tr.json().catch(() => ({})); onToast(`${idx + 1}회차 입금 저장 실패: ${d.error ?? tr.status}`); setEditMode(false); setRows([]); await onChanged(); return; }
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
  const paidOf = (r: PayRow) => (isFxRow(r) ? (r.fx?.paidKrwForSale ?? 0) : hasTxn(r) ? txnPaid(r) : (isRowPaid(r) ? haap(r) : 0));
  const lastTxn = (r: PayRow): PayTxn | null => { const ts = (r.transactions ?? []).filter(t => !isScheduledTxn(t)); return ts.length ? ts[ts.length - 1] : null; };  // 최근(마지막) 실제 입금거래(입금예정 제외)
  const dispPaidDate = (r: PayRow): string => { const t = lastTxn(r); return (t?.paidDate ? formatDisplayDate(t.paidDate) : (formatDisplayDate(r.paidDate) || '—')); };  // §11 입금일: 최종 입금일
  // 입금은행 — 청구 회차 저장값 우선, 없으면(기존 행) 최근 입금거래 은행
  //  둘 다 없으면 기본 은행(국민은행, 외화입금 회차는 기업은행외화)을 미확인(붉은색)으로 표시 — 저장값은 바꾸지 않는다.
  const dispBank = (r: PayRow): string => { const t = lastTxn(r); return (r.depositBank ?? '').trim() || (t?.bankAccount ?? '').trim() || defaultBankFor(r.paymentMethod); };
  // §7/§12 조회 compact 외화 표시 — 최근 거래가 외화송금이면 "USD 4,000" 처럼 결제방법 셀 아래 한 줄로. 없으면 빈 문자열.
  const dispForeign = (r: PayRow): string => { const t = lastTxn(r); return (t && isOverseas(t.method) && num(t.foreignAmount) > 0) ? fmtForeign(t.currency || 'FX', t.foreignAmount) : ''; };   // 통화 소수 자릿수 유지(반올림 금지)
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
    const matched = isVoucher || splitMatched({ supply: sumSupply, vat: sumVat, total: sumTotal }, saleTotal, split);
    return { totalPaid, receivable, rate, sumSupply, sumVat, sumTotal, matched };
  }, [data, saleTotal, split, isVoucher]);

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
    <DateField testid={testid} ariaLabel={label} disabled={opts?.disabled}
      style={{ ...inp, width: 124, ...(opts?.disabled ? { background: C.g50, color: C.g400 } : {}), ...(opts?.overdue ? { borderColor: C.danger, color: C.danger } : {}) }}
      value={dateVal(v)} onChange={val => on(val)} />
  );
  // 하위 입금행 상세 텍스트 — 결제방법별 핵심만 한 줄로(외화송금=통화/외화/환율, 카드=승인/수수료/정산).
  const txnDetail = (t: PayTxn): string => isOverseas(t.method)
    ? `${t.currency || 'FX'} ${won(num(t.foreignAmount))} @ ${t.fxRate ?? '—'}${t.payerName ? ' · ' + t.payerName : ''}`
    : normMethod(t.method) === '카드'
      ? `${t.cardPgType ? t.cardPgType : ''}${t.approvalNo ? ' · ' + t.approvalNo : ''}${num(t.feeAmount) ? ' · 수수료 ' + won(num(t.feeAmount)) + '원' : ''}${num(t.settledAmount) ? ' · 정산 ' + won(num(t.settledAmount)) + '원' : ''}`
      : `${t.payerName ? t.payerName : ''}`;

  // ── 수금거래(payment_transactions) 인라인 저장/삭제 — 기존 배치 API 재사용 ──
  //  · 추가: { rows:[신규] } (미포함 거래는 미변경) / 삭제: { deletedIds:[id] }. onChanged 로 판매상세 재조회.
  const putTxn = async (paymentId: number, body: { rows?: PayTxn[]; deletedIds?: number[]; carryLegacyDeposit?: boolean }): Promise<boolean> => {
    setTxnBusy(true);
    try {
      const res = await fetch(api(`/api/admin/project-payments/${paymentId}/transactions`), {
        method: 'PUT', headers: authH, body: JSON.stringify({ rows: body.rows ?? [], deletedIds: body.deletedIds ?? [], ...(body.carryLegacyDeposit ? { carryLegacyDeposit: true } : {}) }),
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
    // 결제구분 기본값 — 첫 내역은 청구회차의 결제구분(일괄/선금/중도금/잔금), 이후 내역은 잔금. 입금상태 기본 입금완료(입금일 오늘).
    const rowType = TXN_PAY_TYPE_OPTS.some(o => o.value === r.paymentType) ? (r.paymentType as string) : 'lump_sum';
    setAddForm({ paidDate: new Date().toISOString().slice(0, 10), method: m, bankAccount: isOverseas(m) ? '기업은행외화' : ((r.depositBank ?? '').trim() || BANK_DEFAULT), currency: isOverseas(m) ? 'USD' : undefined,
      paymentType: hasTxn(r) || isRowPaid(r) ? 'balance' : rowType, depositStatus: 'completed', expectedDate: hasTxn(r) ? null : (r.expectedDate ?? null) });
    setEditingTxnId(null);
    setCarryLegacy(!hasTxn(r) && isRowPaid(r));   // 입금거래 없이 입금완료 확정된 회차 — 기존 입금을 입금내역 1건으로 이관 후 추가(중복 집계 방지)
    setAddingFor(r.id);
  };
  // 입금내역 수정 — 같은 입력줄에 기존 값 채움. 입금예정 내역의 금액칸 = 예정액, 실제 입금 = 입금액(카드는 실제 입금액 + 수수료 별도).
  const startEditTxn = (r: PayRow, t: PayTxn) => {
    if (r.id == null || t.id == null) return;
    const sched = isScheduledTxn(t);
    const card = isCardMethod(normMethod(t.method)) && t.settledAmount != null && num(t.feeAmount) > 0;
    setExpanded(prev => new Set(prev).add(r.id as number));
    setAddForm({ ...t, method: normMethod(t.method) || '기타', depositStatus: sched ? 'scheduled' : 'completed',
      customerPaidAmount: String(Math.round(sched ? num(t.expectedAmount) : card ? num(t.settledAmount) : num(t.customerPaidAmount))),
      feeAmount: card ? String(Math.round(num(t.feeAmount))) : null,
      paidDate: sched ? null : (t.paidDate ?? null) });
    setEditingTxnId(t.id); setCarryLegacy(false); setRefundFor(null);
    setAddingFor(r.id);
  };
  const cancelAdd = () => { setAddingFor(null); setEditingTxnId(null); setCarryLegacy(false); setAddForm(emptyTxn()); };
  const saveAdd = async (paymentId: number) => {
    const m = addForm.method ?? '기타';
    const amt = num(addForm.customerPaidAmount);
    const base = { ...(editingTxnId ? { id: editingTxnId } : {}), paymentType: addForm.paymentType || null, expectedDate: addForm.expectedDate || null };
    // 입금예정 — 실제 입금액에 포함하지 않는다(서버가 실입금 0·입금일 없음으로 저장). 금액칸 = 입금예정액.
    if (addForm.depositStatus === 'scheduled') {
      if (isOverseas(m)) { onToast('외화입금은 입금예정 내역을 지원하지 않습니다. 입금완료로 등록하세요.'); return; }
      if (amt <= 0) { onToast('입금예정액을 입력하세요.'); return; }
      const ok = await putTxn(paymentId, { rows: [{ ...base, depositStatus: 'scheduled', expectedAmount: amt, paidDate: null, method: m,
        bankAccount: addForm.bankAccount || null, payerName: addForm.payerName || null, note: addForm.note || null }], carryLegacyDeposit: carryLegacy });
      if (ok) cancelAdd();
      return;
    }
    if (!addForm.paidDate) { onToast('입금완료는 입금일을 입력하세요.'); return; }
    // §3/§4 — 외화송금은 통화·외화입금액만 있으면 원화(customerPaidAmount) 0/미확정이어도 저장 허용. 그 외는 원화 입금액 필수.
    if (isOverseas(m)) {
      if (!addForm.currency || num(addForm.foreignAmount) <= 0) { onToast('외화송금은 통화·외화입금액이 필요합니다.'); return; }
    } else if (amt <= 0) { onToast('고객결제금액을 입력하세요.'); return; }
    // 숫자 필드는 정리해서 전송(콤마 제거·빈값 null) — 검증 실패 방지(§13).
    const cardFee = isCardMethod(m) ? num(addForm.feeAmount) : 0;   // 카드: 입력 금액 = 실제 입금액, 수수료 별도
    const payload: PayTxn = {
      ...base, depositStatus: 'completed',
      // 예정 내역을 입금완료로 바꾸는 경우 원래 예정액은 기록으로 유지(수정 시 기존 값 그대로 전송)
      ...(editingTxnId ? { expectedAmount: addForm.expectedAmount != null && addForm.expectedAmount !== '' ? num(addForm.expectedAmount) : null } : {}),
      paidDate: addForm.paidDate || null, method: m,
      customerPaidAmount: amt + cardFee, bankAccount: addForm.bankAccount || null,
      ...(cardFee > 0 ? { settledAmount: amt, feeAmount: cardFee } : (editingTxnId ? { settledAmount: null, feeAmount: null } : {})),
      payerName: addForm.payerName || null, note: addForm.note || null,
      ...(isOverseas(m) ? {
        currency: addForm.currency || null, foreignAmount: num(addForm.foreignAmount) || null,
        fxRate: num(addForm.fxRate) || null, krwAmount: num(addForm.krwAmount) || null,
      } : {}),
    };
    const ok = await putTxn(paymentId, { rows: [payload], carryLegacyDeposit: carryLegacy });
    if (ok) cancelAdd();
  };
  const deleteTxn = async (paymentId: number, txnId?: number) => {
    if (!txnId) return;
    await putTxn(paymentId, { deletedIds: [txnId] });
  };
  // 입금 환불 — 환불일·환불금액 직접 입력(전액·부분). 순입금액 초과 차단(서버도 재검증). 실제 송금은 하지 않고 환불 기록만 남긴다.
  //  입금거래 없이 확정된 회차(과거 CRM 전환 입금 등)는 서버가 기존 입금일·금액을 입금거래로 먼저 이관한다(중복 생성 없음).
  const startRefund = (r: PayRow) => { if (r.id == null) return; setAddingFor(null); setRefundFor(r.id); setRefundForm({ date: '', amount: '', note: '' }); };
  const saveRefund = async (r: PayRow) => {
    if (r.id == null) return;
    const amt = num(refundForm.amount), net = paidOf(r);
    if (!refundForm.date) { onToast('환불일을 입력하세요.'); return; }
    if (amt <= 0) { onToast('환불금액을 입력하세요.'); return; }
    if (amt > net + 0.005) { onToast(`환불금액이 순입금액(${won(net)}원)을 초과합니다.`); return; }
    const ok = await putTxn(r.id, { rows: [{ txnType: 'refund', paidDate: refundForm.date, method: '환불', customerPaidAmount: amt, bankAccount: null, note: refundForm.note || null }] });
    if (ok) { setRefundFor(null); setExpanded(prev => new Set(prev).add(r.id as number)); }
  };

  // 2차+ 입금 추가 — 얇은 한 줄(§7/§8). 라벨 없이 placeholder로 compact. 결제방법 선택 시 외화면 통화/외화액만 추가.
  const setAF = (patch: Partial<PayTxn>) => setAddForm(prev => ({ ...prev, ...patch }));
  const renderTxnAddForm = (paymentId: number) => {
    const m = addForm.method ?? '기타';
    const overseas = isOverseas(m);
    const tinp: React.CSSProperties = { padding: '4px 7px', borderRadius: 6, border: `1px solid ${C.g300}`, fontSize: 12, boxSizing: 'border-box' };
    // §3/§4 — 외화송금: 통화+외화입금액이면 저장 가능(원화 0 허용). 그 외: 원화 입금액(>0) 필수.
    // 입금예정: 예정액(>0)만 필수(입금일 없음). 입금완료: 입금일 + 입금액(외화는 통화·외화액).
    const sched = addForm.depositStatus === 'scheduled';
    const canSave = (sched ? num(addForm.customerPaidAmount) > 0 && !overseas
      : !!addForm.paidDate && (overseas ? (!!addForm.currency && num(addForm.foreignAmount) > 0) : num(addForm.customerPaidAmount) > 0)) && !txnBusy;
    return (
      <div style={{ paddingLeft: 28, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }} data-testid="txn-form">
        <span style={{ fontWeight: 700, color: C.primaryText, fontSize: 12 }}>└ {editingTxnId ? '입금 수정' : '입금 추가'}</span>
        <span data-testid="txn-add-paytype"><ClickSelect value={addForm.paymentType ?? ''} onChange={(v: string) => setAF({ paymentType: v })} triggerStyle={{ ...tinp, width: 86 }} options={TXN_PAY_TYPE_OPTS} aria-label="결제구분" /></span>
        <span data-testid="txn-add-status"><ClickSelect value={addForm.depositStatus ?? 'completed'} triggerStyle={{ ...tinp, width: 86 }} options={TXN_STATUS_OPTS} aria-label="입금상태"
          onChange={(v: string) => setAF(v === 'scheduled' ? { depositStatus: 'scheduled', paidDate: null } : { depositStatus: 'completed', paidDate: addForm.paidDate || new Date().toISOString().slice(0, 10) })} /></span>
        <ClickSelect value={m} onChange={(v: string) => setAF({ method: v, bankAccount: isOverseas(v) ? '기업은행외화' : (addForm.bankAccount || BANK_DEFAULT), currency: isOverseas(v) ? (addForm.currency || 'USD') : undefined })} triggerStyle={{ ...tinp, width: 110 }} options={TXN_METHOD_OPTS} />
        <DateField style={{ ...tinp, width: 128 }} value={addForm.expectedDate ?? ''} onChange={v => setAF({ expectedDate: v || null })} testid="txn-add-expected" ariaLabel="입금예정일" placeholder="입금예정일" />
        <DateField style={{ ...tinp, width: 128, ...(sched ? { background: C.g50, color: C.g400 } : {}) }} disabled={sched} value={addForm.paidDate ?? ''} onChange={v => setAF({ paidDate: v || null })} testid="txn-add-date" ariaLabel="입금일" placeholder="입금일" />
        <div style={{ width: 130 }}><BankField value={addForm.bankAccount ?? ''} onChange={(v) => setAF({ bankAccount: v })} triggerStyle={{ ...tinp, width: '100%' }} testid="txn-add-bank" /></div>
        {overseas && <>
          <ClickSelect value={addForm.currency ?? ''} onChange={(v: string) => setAF({ currency: v })} triggerStyle={{ ...tinp, width: 78 }} options={CURRENCY_OPTS} />
          <input style={{ ...tinp, width: 88, textAlign: 'right' }} inputMode="decimal" value={String(addForm.foreignAmount ?? '')} onChange={e => setAF({ foreignAmount: e.target.value })} placeholder="외화액" data-testid="txn-add-foreign" />
        </>}
        <input style={{ ...tinp, width: 120, textAlign: 'right', fontWeight: 700 }} inputMode="numeric" value={String(addForm.customerPaidAmount ?? '')} onChange={e => setAF({ customerPaidAmount: e.target.value })} placeholder={sched ? '입금예정액' : overseas ? '원화 입금액' : isCardMethod(m) ? '실제 입금액' : '입금액'} aria-label={sched ? '입금예정액' : '입금액'} data-testid="txn-add-amount" />
        {isCardMethod(m) && !sched && <input style={{ ...tinp, width: 100, textAlign: 'right' }} inputMode="numeric" value={String(addForm.feeAmount ?? '')} onChange={e => setAF({ feeAmount: e.target.value.replace(/[^\d]/g, '') })} placeholder="카드 수수료" aria-label="카드사 수수료" data-testid="txn-add-card-fee" />}
        <input style={{ ...tinp, width: 140 }} value={addForm.note ?? ''} onChange={e => setAF({ note: e.target.value })} placeholder="비고" data-testid="txn-add-note" />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={() => saveAdd(paymentId)} disabled={!canSave} data-testid="txn-add-save" aria-label="입금내역 저장"
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, background: canSave ? C.primary : '#9ca3af', cursor: canSave ? 'pointer' : 'not-allowed' }}>{txnBusy ? '저장 중…' : '저장'}</button>
          <button type="button" onClick={cancelAdd} disabled={txnBusy} data-testid="txn-add-cancel" aria-label="입금내역 입력 취소"
            style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.g300}`, background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
        </div>
        {carryLegacy && !editingTxnId && <span data-testid="txn-carry-note" style={{ flexBasis: '100%', fontSize: 11, color: C.textSecondary }}>
          ※ 이 회차의 기존 입금완료(입금일·청구금액)는 입금내역 1건으로 함께 이관됩니다(중복 집계 없음).</span>}
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
    const isTaxMethod = isInvoiceMethod(normMethod(r.paymentMethod));   // 발행일 입력 대상 여부(세금·영세율·면세 계산서)
    const vatWarn = methodVatWarning(normMethod(r.paymentMethod), a.vat);   // 세금 구분 ↔ 금액 불일치(경고만)
    const schedLabel = scheduledLabel(r.paymentMethod);              // 첫 예정/이벤트 날짜 컬럼명(행별)
    // 입금 미확인(붉은색) — 예정일이 입력됐지만 입금확인 체크 전(수행정보 미확인 납품일과 동일). 확인 시 검정색.
    // 입금예정일 색상 기준 — 회차 입금확인, 또는 입금내역 합계로 입금완료된 회차(입금내역 방식은 회차 확인 플래그를 쓰지 않음)
    const confirmed = !!r.depositConfirmed || (hasTxn(r) && effStatus(r) === 'completed');
    const expUnconfirmed = !!r.expectedDate && !confirmed;
    const cols = 13;   // 하위행 colSpan — 최종 13컬럼(§1).
    const pid = r.id ?? null;
    const isOpen = pid != null && expanded.has(pid);
    const txns = r.transactions ?? [];
    const overseasRow = isOverseas(r.paymentMethod);
    // 첫 입금(§6/§8) — 편집모드 + 수출바우처 아님 + 거래 0~1건 → 기본 청구행에서 입금은행/입금액/외화 직접 입력.
    //  거래 1건이면 그 거래값을 임시필드로 시드(mapRow)해 복원·update-in-place. 2건 이상은 하위행 관리라 인라인 편집 대상 아님.
    //  수출바우처(부가세·공급가 2회차)도 회차별로 입금액 입력·입금확인(2026-11).
    const firstPayMode = editable && (txns.length === 0 || (txns.length === 1 && r._txnId != null));   // 입금예정 내역 1건뿐인 회차는 하위행에서 관리
    // 미수금 미리보기 — 첫 입금 입력 중이면 입력값 반영, 그 외 기존 계산.
    const cardRow = isCardMethod(normMethod(r.paymentMethod));
    const firstCovered = num(r._paidAmt) + (cardRow ? num(r._cardFee) : 0);   // 카드: 실제 입금액 + 수수료
    //  미확인(체크 전) 입금액은 미수금에서 빼지 않는다 — 실제 확인된 금액만 반영.
    const rowReceivable = firstPayMode && r._paidOk && !r._legacyPaid && num(r._paidAmt) > 0 ? Math.max(a.amount - firstCovered, 0) : receivable;
    const unconfirmedAuto = !hasTxn(r) && !isRowPaid(r) && !!r.issueDate;   // 조회: 발행일만 있고 미확인 → 청구금액을 붉은색 예정 입금액으로 표시
    const firstStatus = num(r._paidAmt) <= 0 ? 'scheduled' : (firstCovered < a.amount ? 'partial' : 'completed');
    return (
      <React.Fragment key={r.id ?? `new-${i}`}>
      <tr>
        {/* 회차(자동) + (읽기모드) 입금내역 펼침 토글 / (편집모드) 행 삭제 */}
        <td style={{ ...tdBase, textAlign: 'center', width: 96 }}>
          {editable && !voucher ? (
            <div style={{ display: 'flex', gap: 2, alignItems: 'center', justifyContent: 'center' }}>
              <button type="button" onClick={() => ((r.transactions ?? []).some(t => t.txnType === 'refund') ? onToast('입금·환불 이력이 있는 회차는 삭제할 수 없습니다. 청구금액·결제유형을 수정하세요.') : removeRow(i))} data-testid={`pay-del-${i}`} aria-label="청구 삭제"
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
            ? <CompanyPicker token={token} companyName={r.billingCompanyName} linked={r.billingCompanyId != null} style={inp} testid={`pay-company-${i}`}
                onPick={(c) => pickCompany(i, c)}
                onType={(name) => typeCompany(i, name)}
                onEmpty={() => resetCompany(i)} />
            : <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }} title={companyLabel}>{companyLabel}</span>}
        </td>
        {/* 청구담당자 컬럼 제거(§3/§21) — billingContactId 데이터/저장은 유지, UI 열만 삭제 */}
        {/* 결제방법 — 드롭다운. 외화송금 + 첫 입금이면 같은 셀에 통화/외화입금액 compact 표시(§10/§11, 팝업 없음) */}
        <td style={{ ...tdBase, width: 168 }}>
          {editable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <PaymentMethodField value={r.paymentMethod ?? ''} onChange={(v) => patchMethod(i, v)} triggerStyle={inp} testid={`pay-method-${i}`} />
              {vatWarn && <span data-testid={`pay-method-warn-${i}`} title={vatWarn} style={{ fontSize: 11, color: C.danger, whiteSpace: 'normal' }}>⚠ 부가세 확인</span>}
              {firstPayMode && overseasRow && !isFxRow(r) && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <ClickSelect value={r._curr ?? ''} onChange={(v: string) => patchRow(i, { _curr: v })} triggerStyle={{ ...inp, width: 78 }} options={CURRENCY_OPTS} />
                  <input style={{ ...inp, width: 82, textAlign: 'right' }} inputMode="decimal" placeholder="외화액" value={r._foreign ?? ''} onChange={e => patchRow(i, { _foreign: e.target.value })} data-testid={`pay-foreign-${i}`} />
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span>{methodText(r.paymentMethod)}</span>
              {vatWarn && <span title={vatWarn} style={{ fontSize: 11, color: C.danger }}>⚠ 부가세 확인</span>}
              {/* §7 조회모드 — 외화송금 거래가 있으면 통화·외화입금액이 사라지지 않도록 셀 아래 compact 표시(팝업 없음) */}
              {dispForeign(r) && <span style={{ fontSize: 11, color: C.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{dispForeign(r)}</span>}
            </div>
          )}
        </td>
        {/* 발행일(§1) — 항상 표시. 세금계산서 행이면 입력, 아니면 '—' */}
        <td style={{ ...tdBase, width: 150 }}>
          {isTaxMethod
            ? (editable ? dateCell(r.issueDate, v => patchIssue(i, v), `pay-issue-${i}`, '발행일') : (formatDisplayDate(r.issueDate) || '—'))
            : <span style={{ color: C.g400 }}>—</span>}
        </td>
        {/* 첫 예정/이벤트 날짜 — 결제방법별 라벨(입금예정일/카드결제일/송금예정일). 입력 후 입금확인 전이면 붉은색, 확인 체크 시 검정색.
            우측 확인 체크박스(수행정보 납품확인과 동일) — 체크 시 입금일 자동복사·입금상태 입금완료. */}
        <td style={{ ...tdBase, width: 160 }}>
          {editable ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
              <DateField testid={`pay-expected-${i}`} ariaLabel={schedLabel}
                title={expUnconfirmed ? '입금 미확인 — 확인 체크 시 입금일로 반영' : (confirmed ? '입금확인 완료' : undefined)}
                style={{ ...inp, width: 122, ...(expUnconfirmed ? { borderColor: C.danger, color: C.danger } : { color: C.textPrimary }) }}
                value={dateVal(r.expectedDate)} onChange={v => patchRow(i, { expectedDate: v || null })} />
              {/* 입금확인 체크는 입금액 옆으로 이동(2026-11) — 실제 입금기록과 연동 */}
            </div>
          ) : (
            <span style={{ color: expUnconfirmed ? C.danger : undefined, whiteSpace: 'nowrap' }}
              title={confirmed ? '입금확인 완료' : (expUnconfirmed ? '입금 미확인' : undefined)}>
              {formatDisplayDate(r.expectedDate) || '—'}{r.expectedDate && confirmed ? ' ✓' : ''}
            </span>
          )}
        </td>
        {/* 입금일(§11) — 거래 있으면 최종 입금일(읽기전용). 없으면 기존 입력/표시(fallback) */}
        <td style={{ ...tdBase, width: 150 }}>
          {hasTxn(r)
            ? dispPaidDate(r)
            : (editable ? dateCell(r.paidDate, v => patchPaid(i, v), `pay-paid-${i}`, '입금일') : (formatDisplayDate(r.paidDate) || '—'))}
        </td>
        {/* 결제구분 */}
        <td style={{ ...tdBase, width: 110 }}>
          {editable
            ? <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid={`pay-type-${i}`}>
                <ClickSelect value={payTypeKey(r)} onChange={(v: string) => changePayType(i, v)} triggerStyle={inp}
                  options={payTypeKey(r) === 'other' ? [...PAY_TYPE_UI_OPTS, { value: 'other', label: '기타' }] : PAY_TYPE_UI_OPTS} />
                {payTypeKey(r) === 'custom' && <input style={inp} value={r.depositItem ?? ''} placeholder="결제구분 명칭" maxLength={50}
                  onChange={e => patchRow(i, { depositItem: e.target.value, _customType: true })} data-testid={`pay-type-label-${i}`} aria-label="결제구분 직접입력" />}
                {payTypeKey(r) === 'advance' && !voucher && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input style={{ ...inp, textAlign: 'right' }} inputMode="decimal" value={r._advRate ?? ''} placeholder="비율"
                      onChange={e => patchAdvRate(i, e.target.value)} data-testid={`pay-adv-rate-${i}`} aria-label="선금 비율(%)" />
                    <span style={{ fontSize: 12, color: '#6b7280' }}>%</span>
                  </div>
                )}
              </div>
            : isSplitDepositRow(txns)
              ? <span data-testid={`pay-type-text-${i}`} title={`입금내역 ${txns.filter(t => t.txnType !== 'refund' && t.txnType !== 'offset').length}건으로 분할 입금 · 저장된 결제구분: ${payTypeLabel(r)}`}>분할결제</span>
              : <span data-testid={`pay-type-text-${i}`}>{payTypeLabel(r)}</span>}
        </td>
        {/* 청구금액(§1/§14) = project_payments.amount. 공급가/부가세는 내부 자동산출(컬럼 미표시). 일반결제: 입력 / 수출바우처: 자동 */}
        <td style={{ ...tdR, width: 132, fontWeight: 700 }}>
          {editable && !voucher ? priceCell(r.amount, v => patchHaap(i, v), `pay-haap-${i}`, '청구금액')
            : isFxRow(r) ? <FxBilledCell krw={a.amount} cur={String(r.billingCurrency).toUpperCase()} foreign={r.foreignAmount} /> : `${won(a.amount)}원`}
        </td>
        {/* 입금은행 + 확인 체크 — 미확인 붉은색 / 확인 검정색. 은행을 바꾸면 확인 해제. 편집모드에서 모든 회차 선택·저장(입금 전에도). */}
        <td style={{ ...tdBase, width: 168, overflow: 'visible' }} data-testid={`pay-bank-${i}`}>
          {editable ? (() => {
            const hasBank = !!(r._bank ?? '').trim();
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <div style={{ width: 132, flexShrink: 0, display: 'flex' }}>
                  <BankField value={r._bank ?? ''} onChange={(v) => patchRow(i, { _bank: v, _bankOk: false })} testid={`pay-bank-select-${i}`}
                    triggerStyle={{ ...inp, ...(hasBank && !r._bankOk ? { color: C.danger, borderColor: C.danger } : { color: C.textPrimary }) }} />
                </div>
                <input type="checkbox" checked={!!r._bankOk} disabled={!hasBank} onChange={() => patchRow(i, { _bankOk: !r._bankOk })}
                  data-testid={`pay-bank-confirm-${i}`} aria-label="입금은행 확인" title={!hasBank ? '입금은행 선택 후 확인 가능' : (r._bankOk ? '입금은행 확인 완료' : '입금은행 미확인')}
                  style={{ cursor: hasBank ? 'pointer' : 'default', flexShrink: 0 }} />
              </div>
            );
          })() : (() => {
            const b = dispBank(r), ok = !!r.depositBankConfirmed;
            return <span data-testid={`pay-bank-text-${i}`} title={b === '—' ? undefined : (ok ? '입금은행 확인 완료' : '입금은행 미확인')}
              style={{ color: b !== '—' && !ok ? C.danger : undefined }}>{b}{b !== '—' && ok ? ' ✓' : ''}</span>;
          })()}
        </td>
        {/* 입금액(§5/§6/§14) — 첫 입금이면 기본행에서 직접 입력(저장 시 payment_transaction 생성). 그 외엔 Σ거래. 2차+는 '+ 입금' */}
        <td style={{ ...tdR, width: 128 }} data-testid={`pay-paid-amt-${i}`}>
          {firstPayMode && isFxRow(r)
            ? <span style={{ fontSize: 11, color: C.textSecondary }}>아래 외화 입력</span>
            : firstPayMode
            ? (() => {
                const lockedPaid = hasTxn(r) || !!r._legacyPaid;   // 실제 입금기록·기존 확정 회차 — 체크 해제·자동입력 덮어쓰기 금지(입금내역에서 정정)
                const red = !r._paidOk && num(r._paidAmt) > 0;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                    <input type="text" inputMode="numeric" data-testid={`pay-paidamt-${i}`} aria-label="입금액" placeholder="0" disabled={!!r._legacyPaid}
                      data-unconfirmed={red ? 'true' : undefined}
                      title={red ? (r._paidAuto ? '세금계산서 발행일 기준 자동입력 — 입금 미확인(수금 미반영)' : '입금 미확인 — 체크 시 실제 입금으로 반영') : (r._paidOk ? '입금확인 완료' : undefined)}
                      style={{ ...inp, textAlign: 'right', ...(red ? { color: C.danger, borderColor: C.danger } : { color: C.textPrimary }) }}
                      value={commafy(r._paidAmt)} onChange={e => patchRow(i, { _paidAmt: e.target.value.replace(/[^\d]/g, ''), _paidAuto: false })} />
                    <input type="checkbox" checked={!!r._paidOk} disabled={lockedPaid || (!r._paidOk && num(r._paidAmt) <= 0 && num(r._foreign) <= 0)}
                      onChange={() => togglePaidConfirm(i)} data-testid={`pay-paid-confirm-${i}`} aria-label="입금확인"
                      title={lockedPaid ? '입금기록 있음 — 정정은 입금내역에서' : (r._paidOk ? '입금확인 — 저장 시 실제 입금기록 반영' : '입금 미확인 — 체크하면 실제 입금 확인')}
                      style={{ cursor: lockedPaid ? 'default' : 'pointer', flexShrink: 0 }} />
                  </div>
                );
              })()
            : !editable && isFxRow(r) && r.fx ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                <FxPaidCell fx={r.fx} />
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                {cardRow && hasTxn(r) && cardTotals(txns).fee > 0
                  ? <CardPaidCell txns={txns} billed={a.amount} />
                  : unconfirmedAuto && !editable
                    ? <span data-testid={`pay-paid-unconfirmed-${i}`} title="세금계산서 발행 — 입금 미확인(수금 미반영). 수정에서 입금확인 체크"
                        style={{ fontWeight: 700, color: C.danger }}>{`${won(a.amount)}원`}<span style={{ fontSize: 10, fontWeight: 600, marginLeft: 3 }}>미확인</span></span>
                    : <span data-testid={`pay-paid-confirmed-${i}`} style={{ fontWeight: 700, color: paidOf(r) > 0 ? C.textPrimary : C.textSecondary }}>{`${won(paidOf(r))}원`}</span>}
              </div>
            )}
        </td>
        {/* 미수금 — 첫 입금 입력 중이면 미리보기 반영 */}
        <td style={{ ...tdR, width: 128, color: rowReceivable > 0 ? C.danger : C.textSecondary }}>
          {isFxRow(r) ? (r.fx && !editable ? <FxReceivableCell fx={r.fx} /> : <span style={{ fontSize: 11, color: C.textSecondary }}>외화 기준</span>) : `${won(rowReceivable)}원`}
        </td>
        {/* 입금상태 — 거래 있으면 파생 / 첫 입금 입력 중이면 미리보기 / 그 외 기존 */}
        <td style={{ ...tdBase, width: 110 }}>
          {isFxRow(r) && r.fx && !editable
            ? <FxStatusBadge status={r.fx.status} title={r.fx.reviewReasons.join(', ') || undefined} />
            : hasTxn(r)
            ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 5, fontWeight: 700, background: effStatus(r) === 'completed' ? '#dcfce7' : effStatus(r) === 'partial' ? '#fef9c3' : '#f3f4f6', color: effStatus(r) === 'completed' ? '#15803d' : effStatus(r) === 'partial' ? '#854d0e' : '#6b7280' }}>{labelOf(DEPOSIT_OPTS, effStatus(r))}</span>
            : firstPayMode && r._paidOk && !r._legacyPaid && num(r._paidAmt) > 0
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
      {/* 카드결제 회차(편집·첫 입금) — 청구금액·실제 입금액·카드사 수수료·수수료율·미수금 */}
      {editable && !voucher && cardRow && firstPayMode && (
        <tr data-testid={`card-panel-row-${i}`}><td colSpan={cols} style={{ ...tdBase, whiteSpace: 'normal', overflow: 'visible', background: '#f8fafc' }}>
          <CardFeeEditPanel billed={a.amount} paidInput={r._paidAmt} feeInput={r._cardFee} rateInput={r._cardRate} inp={inp} idx={i} onPatch={(p) => patchRow(i, p)} />
        </td></tr>
      )}
      {/* 외화입금 회차(편집) — A.외화 청구 / B.실제 외화 입금(외화 금액 옆 원화 환산 자동 표시) */}
      {editable && !voucher && overseasRow && (
        <tr data-testid={`fx-panel-row-${i}`}><td colSpan={cols} style={{ ...tdBase, whiteSpace: 'normal', overflow: 'visible', background: '#f8fafc' }}>
          <FxEditPanel row={r} idx={i} inp={inp} firstPayMode={firstPayMode} onPatch={(p) => patchRow(i, p as Partial<PayRow>)} />
        </td></tr>
      )}
      {/* 하위 입금행 — 읽기모드 펼침 시 각 payment_transaction 을 제목 행과 같은 열로 정렬해 표시 */}
      {!editable && isOpen && txns.length > 0 && (
        <tr data-testid={`txn-head-${i}`}>
          <td colSpan={cols} style={{ ...tdBase, background: '#f5f8fc', padding: '6px 8px', borderBottom: BD.divider }}>
            <div style={{ ...TXN_GRID, fontSize: 11, fontWeight: 700, color: C.textSecondary }}>
              {TXN_HEADS.map((h, hi) => <span key={hi} style={{ textAlign: hi === 7 ? 'right' : 'left' }}>{h}</span>)}
            </div>
          </td>
        </tr>
      )}
      {!editable && isOpen && txns.map((t, ti) => {
        const sched = isScheduledTxn(t), refund = t.txnType === 'refund', offset = t.txnType === 'offset';
        const editableTxn = !isFxRow(r) && !refund && !offset;
        const badge = (text: string, bg: string, fg: string) => <span style={{ justifySelf: 'start', padding: '1px 7px', borderRadius: 4, background: bg, color: fg, fontWeight: 700 }}>{text}</span>;
        return (
        <tr key={`t-${t.id ?? ti}`} data-testid={`txn-subrow-${i}-${ti}`}>
          <td colSpan={cols} style={{ ...tdBase, background: '#fbfdff', whiteSpace: 'normal', padding: '6px 8px' }}>
            <div style={{ ...TXN_GRID, ...(editingTxnId === t.id ? { opacity: 0.45 } : {}) }}>
              <span style={{ fontWeight: 700, color: C.primaryText }}>└ {ti + 1}차</span>
              <span data-testid={`txn-paytype-${i}-${ti}`} style={{ fontWeight: 600 }}>{t.paymentType ? labelOf(TXN_PAY_TYPE_OPTS, t.paymentType) : '—'}</span>
              <span data-testid={`txn-status-${i}-${ti}`} style={{ display: 'flex' }}>
                {refund ? badge('환불', '#fee2e2', C.danger) : offset ? badge('상계', '#f3e8ff', '#7c3aed')
                  : sched ? badge('입금예정', '#f3f4f6', '#6b7280') : badge('입금완료', '#dcfce7', '#15803d')}
              </span>
              <span style={{ color: sched && t.expectedDate && String(t.expectedDate).slice(0, 10) < todayStr() ? C.danger : undefined }}>{formatDisplayDate(t.expectedDate) || '—'}</span>
              <span>{formatDisplayDate(t.paidDate) || '—'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayMethod(t.method) || '—'}</span>
              <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.bankAccount || '—'}</span>
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {isFxRow(r) && isForeignCur(t.currency)
                  ? <span style={{ fontWeight: 700, color: offset ? '#7c3aed' : undefined }} data-testid={`txn-fx-${i}-${ti}`}>{fxTxnText(t)}</span>
                  : refund
                  ? <span data-testid={`txn-refund-${i}-${ti}`} style={{ fontWeight: 700, color: C.danger }}>−{won(Math.abs(num(t.customerPaidAmount)))}원</span>
                  : sched
                  ? <span data-testid={`txn-expected-amt-${i}-${ti}`} style={{ fontWeight: 700, color: '#6b7280' }} title="입금예정액 — 실제 입금액·미수금 계산에 포함하지 않음">(예정) {won(num(t.expectedAmount))}원</span>
                  : <span style={{ fontWeight: 700 }}>{won(num(t.customerPaidAmount))}원</span>}
                {!sched && !refund && !(isFxRow(r) && isForeignCur(t.currency)) && txnDetail(t) && <span style={{ display: 'block', fontSize: 11, color: '#6b7280' }}>{txnDetail(t)}</span>}
              </span>
              <span style={{ color: t.note ? '#4b5563' : '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.note ?? undefined}>{t.note || '—'}</span>
              <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                {editableTxn && (
                  <button type="button" onClick={() => startEditTxn(r, t)} disabled={txnBusy} data-testid={`txn-sub-edit-${i}-${ti}`} aria-label="입금내역 수정"
                    style={{ border: `1px solid ${C.g300}`, borderRadius: 5, background: '#fff', color: C.primaryText, cursor: 'pointer', padding: '2px 8px', fontSize: 11 }}>수정</button>)}
                <button type="button" onClick={() => deleteTxn(pid!, t.id)} disabled={txnBusy} data-testid={`txn-sub-del-${i}-${ti}`} aria-label="입금내역 삭제"
                  style={{ border: `1px solid ${C.g300}`, borderRadius: 5, background: '#fff', color: C.danger, cursor: 'pointer', padding: '2px 8px', fontSize: 11 }}>삭제</button>
              </span>
            </div>
          </td>
        </tr>
        );
      })}
      {/* '+ 입금 추가' — 저장된 모든 청구회차에서, 입금내역이 접혀 있어도 항상 표시(누르면 펼치고 입력줄 열기).
          청구회차·발행일·청구금액은 그대로 두고 입금내역만 추가. 외화 청구회차는 외화 입금·상계 입력. */}
      {!editable && pid != null && (
        <tr data-testid={`txn-addrow-${i}`}>
          <td colSpan={cols} style={{ ...tdBase, background: '#f8fbff', whiteSpace: 'normal' }}>
            {addingFor === pid && isFxRow(r)
              ? <FxTxnAddForm paymentId={pid} cur={String(r.billingCurrency).toUpperCase()} token={token} busy={txnBusy}
                  onSave={async (t) => { if (await putTxn(pid, { rows: [t as PayTxn] })) cancelAdd(); }} onCancel={cancelAdd} />
              : addingFor === pid
              ? renderTxnAddForm(pid)
              : <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 28 }}>
                  <button type="button" onClick={() => startAdd(r)} data-testid={`txn-add-open-${i}`}
                    aria-label="입금 추가" style={{ border: `1px dashed ${C.primary}`, borderRadius: 6, background: '#fff', color: C.primaryText, cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: '3px 12px' }}>└ + {isFxRow(r) ? '입금·상계 추가' : '입금 추가'}</button>
                  {/* 환불 처리 — 표시 조건 기존 그대로(조회 모드 · 저장된 회차 · 순입금액 > 0 · 환불 입력 중 아님). 접힌 상태에서도 표시 */}
                  {paidOf(r) > 0 && refundFor !== pid && (
                    <button type="button" onClick={() => startRefund(r)} data-testid={`txn-refund-open-${i}`} aria-label="환불 처리"
                      style={{ border: `1px solid ${C.g300}`, borderRadius: 6, background: '#fff', color: C.textSecondary, cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '3px 12px' }}>환불 처리</button>
                  )}
                </div>}
          </td>
        </tr>
      )}
      {/* 입금 환불 입력 — 환불일·환불금액(전액·부분, 순입금액 이하)·비고. 환불은 음수 거래로 기록(실제 송금 아님) */}
      {!editable && pid != null && refundFor === pid && (
        <tr data-testid={`txn-refundrow-${i}`}>
          <td colSpan={cols} style={{ ...tdBase, background: '#fff7f7', whiteSpace: 'normal' }}>
            <div style={{ paddingLeft: 28, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
              <span style={{ fontWeight: 700, color: C.danger }}>└ 입금 환불</span>
              <span style={{ color: C.textSecondary }}>순입금액 {won(paidOf(r))}원</span>
              <DateField style={{ padding: '4px 7px', borderRadius: 6, border: `1px solid ${C.g300}`, fontSize: 12, width: 128 }} value={refundForm.date}
                onChange={v => setRefundForm(f => ({ ...f, date: v || '' }))} testid={`txn-refund-date-${i}`} ariaLabel="환불일" placeholder="환불일" />
              <input inputMode="numeric" value={commafy(refundForm.amount)} onChange={e => setRefundForm(f => ({ ...f, amount: e.target.value.replace(/[^\d]/g, '') }))}
                placeholder="환불금액" data-testid={`txn-refund-amount-${i}`} aria-label="환불금액"
                style={{ padding: '4px 7px', borderRadius: 6, border: `1px solid ${C.g300}`, fontSize: 12, width: 120, textAlign: 'right', fontWeight: 700 }} />
              <button type="button" onClick={() => setRefundForm(f => ({ ...f, amount: String(Math.round(paidOf(r))) }))} data-testid={`txn-refund-full-${i}`} aria-label="전액 환불 금액 입력"
                style={{ border: `1px solid ${C.g300}`, borderRadius: 5, background: '#fff', cursor: 'pointer', fontSize: 11, padding: '2px 8px' }}>전액</button>
              <input value={refundForm.note} onChange={e => setRefundForm(f => ({ ...f, note: e.target.value }))} placeholder="비고(환불 사유)" data-testid={`txn-refund-note-${i}`} aria-label="환불 비고"
                style={{ padding: '4px 7px', borderRadius: 6, border: `1px solid ${C.g300}`, fontSize: 12, width: 180 }} />
              <button type="button" onClick={() => saveRefund(r)} disabled={txnBusy} data-testid={`txn-refund-save-${i}`} aria-label="환불 저장"
                style={{ padding: '6px 14px', borderRadius: 6, border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, background: txnBusy ? '#9ca3af' : C.danger, cursor: txnBusy ? 'not-allowed' : 'pointer' }}>{txnBusy ? '저장 중…' : '환불 저장'}</button>
              <button type="button" onClick={() => setRefundFor(null)} disabled={txnBusy} data-testid={`txn-refund-cancel-${i}`} aria-label="환불 취소"
                style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${C.g300}`, background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>취소</button>
            </div>
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
      <table className={editable ? 'veritas-thead' : 'veritas-read-table'} style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 1900, width: 'max-content' }}>
        <thead><tr>
          <th style={{ ...thBase, width: 96, textAlign: 'center' }}>회차</th>
          <th style={{ ...thBase, width: 180 }}>청구업체</th>
          <th style={{ ...thBase, width: 168 }}>결제방법</th>
          <th style={{ ...thBase, width: 150 }}>발행일</th>
          <th style={{ ...thBase, width: 160 }}>{col2Header}</th>
          <th style={{ ...thBase, width: 150 }}>입금일</th>
          <th style={{ ...thBase, width: 110 }}>결제구분</th>
          <th style={{ ...thBase, width: 132, textAlign: 'right' }}>청구금액</th>
          <th style={{ ...thBase, width: 168 }}>입금은행</th>
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
        {list.some(isFxRow) && <span style={{ ...TYPO.helper }} data-testid="fx-krw-basis-note">※ 외화 회차의 원화 입금·미수금은 외화 기준 수금 처리액(판매 원화금액 기준) — 실제 원화 환산 입금액은 아래 통화별 요약</span>}
      </div>
      {/* 외화 청구회차 — 통화별 외화 청구·수금·미수(원화와 합산하지 않음). 위 원화 금액은 외화 기준 판정 결과(환율 차이로 미수 생성 없음) */}
      {!editMode && <FxSummaryLine list={list.filter(isFxRow).map(r => r.fx).filter((x): x is FxSummary => !!x)} />}
    </>
  );

  return (
    <Card>
      <div style={{ ...TYPO.sectionTitle, paddingBottom: SP[4], borderBottom: BD.grid, marginBottom: SP[5], display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
        <span style={{ width: 22, height: 22, borderRadius: BD.radius.md, background: '#ecfdf5', color: '#047857', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>D</span>
        청구정보
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* 결제유형 — 수출바우처 선택 시 고객사·운영기관 청구 2건 자동 생성 */}
          <span style={{ ...TYPO.helper }}>결제유형</span>
          {editMode ? (
            <div style={{ width: 130 }}>
<span data-testid="pay-category" style={{ display: 'block' }}><ClickSelect value={category} onChange={changeCategory} triggerStyle={{ ...dsInputStd(), minHeight: 30, padding: '4px 8px', width: '100%' }} options={CATEGORY_OPTS} /></span>
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
