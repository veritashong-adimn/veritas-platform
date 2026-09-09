// ─── 판매/프로젝트 Excel Export (공통 excelExport 엔진 재사용) ──────────────────────
// VERITAS 5차: 판매 목록 Excel 다운로드 전용. Native 판매 대량등록은 제공하지 않는다(§12).
//  · 판매 식별 컬럼은 '견적번호'(별도 판매번호 체계 없음 — §22, 없는 번호를 만들지 않는다).
//  · 판매금액/공급가/부가세는 백엔드 export API 가 유효견적 quote_items SSOT 로 계산해 전달.
//  · 청구/입금/미수금/입금상태는 billing·payment SSOT 실시간 계산값(중복 저장 없음, §14).
//  · 판매일/수행시작·종료일/수행상태는 안전한 필드가 없어 컬럼에서 제외(§4·§10·§23 — 근거 없는 값 금지).
import { exportDataset, todayStamp, type ExcelColumn } from './excelExport';

export interface SalesExportRow {
  quoteNumber?: string;
  title?: string;
  quoteType?: string;
  requestingCompanyName?: string;
  businessNumber?: string;
  contactName?: string;
  pmName?: string;
  serviceType?: string;
  saleAmount?: number | null;
  supplyAmount?: number | null;
  taxAmount?: number | null;
  projectStatus?: string;
  totalBilled?: number | null;
  taxDocumentType?: string;
  paidAmount?: number | null;
  receivable?: number | null;
  depositStatus?: string;
  createdAt?: string;
  note?: string;
}

// 라벨 매핑 — 내부 코드값을 사람이 읽는 자연어로(§Product 철학). 미지의 값은 원본 그대로 표시.
const QUOTE_TYPE_LABEL: Record<string, string> = {
  b2b_standard: '일반', b2c_prepaid: '선입금', prepaid_deduction: '차감', accumulated_batch: '누적',
};
const STATUS_LABEL: Record<string, string> = {
  created: '생성', quoted: '견적', approved: '판매확정', paid: '결제완료',
  matched: '배정완료', in_progress: '진행중', completed: '완료', cancelled: '취소',
};
const SERVICE_LABEL: Record<string, string> = {
  translation: '번역', interpretation: '통역', equipment: '장비', expense: '경비',
};
const DEPOSIT_LABEL: Record<string, string> = {
  scheduled: '미입금', partial: '부분입금', completed: '입금완료',
};
const TAXDOC_LABEL: Record<string, string> = {
  tax_invoice: '세금계산서', cash_receipt: '현금영수증', invoice: '계산서', none: '없음',
};

// numeric 셀은 실제 숫자만(문자열 "원" 금지, §20). 근거 없는 값은 blank.
const num = (v: number | null | undefined) => (typeof v === 'number' ? v : '');

const SALES_LIST_COLUMNS: ExcelColumn<SalesExportRow>[] = [
  { header: '견적번호', value: 'quoteNumber' },
  { header: '프로젝트명', value: 'title' },
  { header: '판매유형', value: (r) => QUOTE_TYPE_LABEL[r.quoteType ?? ''] ?? r.quoteType ?? '' },
  { header: '의뢰거래처', value: 'requestingCompanyName' },
  { header: '사업자등록번호', value: 'businessNumber' },
  { header: '담당자', value: 'contactName' },
  { header: '담당PM', value: 'pmName' },
  { header: '서비스유형', value: (r) => SERVICE_LABEL[r.serviceType ?? ''] ?? r.serviceType ?? '' },
  { header: '판매금액', value: (r) => num(r.saleAmount), type: 'number' },
  { header: '공급가액', value: (r) => num(r.supplyAmount), type: 'number' },
  { header: '부가세', value: (r) => num(r.taxAmount), type: 'number' },
  { header: '프로젝트상태', value: (r) => STATUS_LABEL[r.projectStatus ?? ''] ?? r.projectStatus ?? '' },
  { header: '총청구액', value: (r) => num(r.totalBilled), type: 'number' },
  { header: '세금계산서상태', value: (r) => (r.taxDocumentType ? (TAXDOC_LABEL[r.taxDocumentType] ?? r.taxDocumentType) : '') },
  { header: '누적입금액', value: (r) => num(r.paidAmount), type: 'number' },
  { header: '미수금', value: (r) => num(r.receivable), type: 'number' },
  { header: '입금상태', value: (r) => (r.depositStatus ? (DEPOSIT_LABEL[r.depositStatus] ?? r.depositStatus) : '') },
  { header: '등록일', value: 'createdAt', type: 'date' },
  { header: '비고', value: 'note' },
];

/** 판매목록 Excel 다운로드 — 현재 검색/필터에 매칭되는 전체 판매(전체 rows). */
export function exportSales(rows: SalesExportRow[]): void {
  exportDataset<SalesExportRow>({
    filename: `VERITAS_판매_${todayStamp()}.xlsx`,
    sheetName: '판매목록',
    columns: SALES_LIST_COLUMNS,
    rows,
  });
}
