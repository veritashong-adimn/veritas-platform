// ─── 수금현황 Excel Export (공통 excelExport 엔진 재사용) ──────────────────────
// VERITAS 9차: 수금관리 > 수금 현황 전용. SSOT = GET /api/admin/collections (project_payments + payment_transactions).
//  · Excel 은 신규 금액 계산을 하지 않는다 — collections API 가 계산한 값을 그대로 내보낸다(§3·§18).
//  · 청구행(project_payment) 1건 = 1행. 분할청구면 판매 1건이 여러 행(§5·§7).
//  · 입금은행은 payment_transactions.bankAccount SSOT 그대로 — 없으면 blank(임의 보정 금지, §15).
//  · 외화는 원화(누적입금액)와 분리해 통화/외화입금액 별도 컬럼(§16). 표시 용어 '외화입금'(§5).
//  · 선입금·차감 견적은 collections 에서 이미 제외됨 → 일반 수금과 분리 유지(§12).
import { exportDataset, todayStamp, type ExcelColumn } from './excelExport';
import { displayPaymentMethod } from './paymentMethodDisplay';
import { VAT_MODE_LABEL, type VatMode } from './quoteTaxType';

export interface CollectionExportRow {
  quoteNumber: string | null;
  sequence: number;
  projectTitle: string | null;
  billingCompanyName: string | null;
  paymentMethod: string | null;
  issueDate: string | null;
  expectedDate: string | null;
  lastPaidDate: string | null;
  amount: number;
  paidAmount: number | null;         // 과거 CRM '확인 필요' → null(blank)
  receivable: number | null;
  status: 'scheduled' | 'partial' | 'completed' | 'review';
  source?: 'current' | 'legacy';
  reviewReason?: string | null;
  overdue: boolean;
  bankAccount: string | null;
  foreign: { currency: string; foreignAmount: number }[];
  pmName: string | null;
  note: string | null;
}

// 입금상태 라벨 — 수금현황 화면(STATUS_META)과 동일. 미지 값은 원본 그대로.
const STATUS_LABEL: Record<string, string> = {
  scheduled: '입금예정', partial: '부분입금', completed: '입금완료', review: '확인 필요',
};
const statusLabel = (r: CollectionExportRow) => {
  const base = STATUS_LABEL[r.status] ?? r.status;
  return r.overdue ? `${base} (기한경과)` : base;
};

// numeric 셀은 실제 숫자만("원" 문자열 금지, §18). 근거 없는 값은 blank.
const num = (v: number | null | undefined) => (typeof v === 'number' ? v : '');

// 외화통화: 거래별 통화 나열(중복 제거). 외화입금액: 단일통화면 numeric, 복수통화면 통화별 합침 문자열.
const fxCurrency = (r: CollectionExportRow) =>
  r.foreign.length ? [...new Set(r.foreign.map((f) => f.currency))].join(', ') : '';
const fxAmount = (r: CollectionExportRow): number | string => {
  if (!r.foreign.length) return '';
  if (r.foreign.length === 1) return r.foreign[0].foreignAmount;   // numeric 셀
  return r.foreign.map((f) => `${f.currency} ${f.foreignAmount.toLocaleString('ko-KR')}`).join(', ');
};

const COLLECTION_COLUMNS: ExcelColumn<CollectionExportRow>[] = [
  { header: '견적번호', value: (r) => r.quoteNumber ?? '' },
  { header: '회차', value: 'sequence', type: 'number' },
  { header: '프로젝트명', value: (r) => r.projectTitle ?? '' },
  { header: '청구업체', value: (r) => r.billingCompanyName ?? '' },
  { header: '결제방법', value: (r) => displayPaymentMethod(r.paymentMethod) },
  { header: '발행일', value: 'issueDate', type: 'date' },
  { header: '입금예정일', value: 'expectedDate', type: 'date' },
  { header: '최근입금일', value: 'lastPaidDate', type: 'date' },
  { header: '청구금액', value: (r) => num(r.amount), type: 'number' },
  { header: '누적입금액', value: (r) => num(r.paidAmount), type: 'number' },
  { header: '미수금', value: (r) => num(r.receivable), type: 'number' },
  { header: '입금상태', value: statusLabel },
  { header: '입금은행', value: (r) => r.bankAccount ?? '' },
  { header: '외화통화', value: fxCurrency },
  { header: '외화입금액', value: fxAmount, type: 'number' },
  { header: '담당PM', value: (r) => r.pmName ?? '' },
  { header: '비고', value: (r) => r.note ?? '' },
  // 과거 CRM 통합 — 기존 열 뒤에 추가
  { header: '자료 출처', value: (r) => (r.source === 'legacy' ? '과거 CRM' : '신규 판매') },
  { header: '확인 사유', value: (r) => r.reviewReason ?? '' },
];

/** 수금현황 Excel 다운로드 — 현재 검색/필터에 매칭되는 전체 청구행(현재 화면 rows). */
export function exportCollections(rows: CollectionExportRow[]): void {
  exportDataset<CollectionExportRow>({
    filename: `수금현황_${todayStamp()}.xlsx`,
    sheetName: '수금현황',
    columns: COLLECTION_COLUMNS,
    rows,
  });
}

// ─── 판매건별 수금현황 Excel(판매건 1건 = 1행) ─────────────────────────────────────
//  · SSOT = GET /api/admin/collections/sales — 서버 계산값을 그대로 내보낸다(Excel 에서 재계산 없음).
export interface SaleCollectionExportRow {
  source: 'current' | 'legacy';
  saleNumber: string | null;
  companyName: string | null;
  projectTitle: string | null;
  saleTotal: number;
  saleTaxType?: string | null;   // 판매 세금 유형(현재 판매만, 과거 CRM 목록은 없음)
  paidAmount: number | null;
  receivable: number | null;
  paidRate: number | null;
  status: 'unpaid' | 'partial' | 'completed' | 'review';
  overpaid: boolean;
  overpaidAmount: number;
  installments: { sequence: number; amount: number; status: 'scheduled' | 'partial' | 'completed' }[];
  unbilledAmount: number | null;
  unissuedAmount: number | null;
  issuedAwaitingAmount: number | null;
  nextExpectedDate: string | null;
  lastPaidDate: string | null;
  overdue: boolean;
  pmName: string | null;
  reviewReason?: string | null;
}
export const SALE_STATUS_LABEL: Record<SaleCollectionExportRow['status'], string> = {
  unpaid: '미입금', partial: '부분입금', completed: '입금완료', review: '확인 필요',
};
export const INSTALLMENT_STATUS_LABEL: Record<string, string> = { scheduled: '대기', partial: '부분', completed: '완료' };
/** 청구회차 요약 — "1차 완료 / 2차 대기" */
export const installmentSummary = (r: Pick<SaleCollectionExportRow, 'installments'>) =>
  r.installments.map((i) => `${i.sequence}차 ${INSTALLMENT_STATUS_LABEL[i.status] ?? i.status}`).join(' / ');

const SALE_COLUMNS: ExcelColumn<SaleCollectionExportRow>[] = [
  { header: '판매번호', value: (r) => r.saleNumber ?? '' },
  { header: '거래처명', value: (r) => r.companyName ?? '' },
  { header: '프로젝트명', value: (r) => r.projectTitle ?? '' },
  { header: '총 판매금액(VAT 포함)', value: (r) => num(r.saleTotal), type: 'number' },
  { header: '세금 유형', value: (r) => (r.saleTaxType ? (VAT_MODE_LABEL[r.saleTaxType as VatMode] ?? r.saleTaxType) : '') },
  { header: '누적 입금액', value: (r) => num(r.paidAmount), type: 'number' },
  { header: '잔여 미수금', value: (r) => num(r.receivable), type: 'number' },
  { header: '입금률(%)', value: (r) => num(r.paidRate), type: 'number', numFmt: '0.0' },
  { header: '수금상태', value: (r) => SALE_STATUS_LABEL[r.status] + (r.overpaid ? ' (초과입금)' : '') + (r.overdue ? ' (기한경과)' : '') },
  { header: '초과입금액', value: (r) => (r.overpaid ? r.overpaidAmount : ''), type: 'number' },
  { header: '청구회차', value: (r) => installmentSummary(r) },
  { header: '청구 전 금액', value: (r) => num(r.unbilledAmount), type: 'number' },
  { header: '미발행금액', value: (r) => num(r.unissuedAmount), type: 'number' },
  { header: '발행 후 입금대기', value: (r) => num(r.issuedAwaitingAmount), type: 'number' },
  { header: '입금예정일', value: 'nextExpectedDate', type: 'date' },
  { header: '최종 입금일', value: 'lastPaidDate', type: 'date' },
  { header: '담당PM', value: (r) => r.pmName ?? '' },
  { header: '자료 출처', value: (r) => (r.source === 'legacy' ? '과거 CRM' : '신규 판매') },
  { header: '확인 사유', value: (r) => r.reviewReason ?? '' },
];

/** 판매건별 수금현황 Excel — 현재 필터·검색·정렬 결과 그대로 */
export function exportSaleCollections(rows: SaleCollectionExportRow[]): void {
  exportDataset<SaleCollectionExportRow>({
    filename: `수금현황_판매건별_${todayStamp()}.xlsx`,
    sheetName: '판매건별 수금현황',
    columns: SALE_COLUMNS,
    rows,
  });
}
