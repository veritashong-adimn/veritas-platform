// ─── 누적청구 Excel Export (공통 excelExport 엔진 재사용) ──────────────────────
// VERITAS 9차: 수금관리 > 누적 청구 전용. SSOT = GET /api/admin/billing-batches.
//  · 마감 전 '가상 누적행'(accumulated_quote)과 마감 후 '실제 batch'(billing_batch)는 API 에서
//    quoteId 기준 상호배타 → 두 줄 중복 없음(§8·§9). 여기서도 그대로 내보낸다.
//  · 청구금액 = API totalAmount(가상행은 quote.price, 실행은 billing_batch.total_amount) SSOT 그대로.
//  · 발행일·입금예정일·입금액·미수금·입금상태는 청구행(project_payment) 축 값으로, 수금현황 Excel 에서
//    다룬다 → 누적청구 Excel 에는 중복 포함하지 않는다(§13 중복 금지). batch/누적 축 컬럼만 담는다.
//  · [누적기간 표시 원칙] 누적시작일/누적마감일은 '실제 누적기간' 만 보여준다.
//    - 누적시작일 = quote.batch_period_start(값이 있을 때만). billing_batches.period_start 는 마감 실행 순간의
//      timestamp(과거 마감/재오픈 orphan 포함)라 실제 누적기간이 아니므로 사용하지 않는다.
//    - 누적마감일 = quote.batch_closed_at(실제 마감 상태일 때만). billing_batches.period_end 로 fallback 하지 않는다.
//    - 두 값 모두 없으면 빈칸. 견적일/수행일/생성일 등으로 임의 추정하지 않는다.
//    (quote.batch_period_start 는 현재 API 응답에 없어 항상 빈칸으로 표기된다 — 값이 채워지면 표시하도록 필드 참조만 유지.)
import { exportDataset, todayStamp, type ExcelColumn } from './excelExport';

export interface AccumulatedBillingExportRow {
  sourceType?: 'billing_batch' | 'accumulated_quote';
  id: number | null;
  quoteNumber?: string | null;
  projectName?: string | null;
  companyName: string | null;
  status: string;
  periodStart: string | null;   // billing_batches.period_start — 마감 실행 timestamp. 누적기간 표시엔 쓰지 않음.
  periodEnd: string | null;     // billing_batches.period_end   — 동상. 누적마감일 fallback 으로 쓰지 않음.
  batchPeriodStart?: string | null;  // quote.batch_period_start — 실제 누적기간 시작(있을 때만 표시).
  batchClosedAt?: string | null;     // quote.batch_closed_at    — 실제 마감일(있을 때만 표시).
  itemCount: number;
  totalAmount: number;
  quoteStatus: string | null;
  createdAt: string;
}

// 배치상태/누적상태 라벨 — 누적청구 화면(STATUS_COLOR)과 동일. 미지 값은 원본 그대로.
const STATUS_LABEL: Record<string, string> = {
  draft: '초안', sent: '발송', approved: '승인', paid: '완료',
  accumulating: '누적중', closed: '마감완료', billable: '청구가능',
  pending: '작성중', rejected: '반려',
};
const label = (s: string | null | undefined) => (s ? (STATUS_LABEL[s] ?? s) : '');

const SOURCE_LABEL: Record<string, string> = {
  billing_batch: '청구배치', accumulated_quote: '누적견적(가상)',
};

const num = (v: number | null | undefined) => (typeof v === 'number' ? v : '');

const ACCUMULATED_COLUMNS: ExcelColumn<AccumulatedBillingExportRow>[] = [
  { header: '구분', value: (r) => SOURCE_LABEL[r.sourceType ?? 'billing_batch'] ?? '' },
  { header: '누적견적번호', value: (r) => r.quoteNumber ?? '' },
  { header: '프로젝트명', value: (r) => r.projectName ?? '' },
  { header: '거래처', value: (r) => r.companyName ?? '' },
  { header: '누적상태', value: (r) => label(r.status) },
  // 실제 누적기간만 표시(billing_batches.period_* 는 마감 timestamp 라 미사용). 값 없으면 빈칸.
  { header: '누적시작일', value: (r) => r.batchPeriodStart ?? '', type: 'date' },
  { header: '누적마감일', value: (r) => r.batchClosedAt ?? '', type: 'date' },
  { header: '건수', value: (r) => num(r.itemCount), type: 'number' },
  { header: '청구금액', value: (r) => num(r.totalAmount), type: 'number' },
  { header: '배치번호', value: (r) => (r.sourceType === 'accumulated_quote' || r.id == null ? '' : `#${r.id}`) },
  { header: '견적상태', value: (r) => label(r.quoteStatus) },
  { header: '생성일', value: 'createdAt', type: 'date' },
];

/** 누적청구 Excel 다운로드 — 현재 상태필터에 매칭되는 전체 행(가상행 + 실 batch). */
export function exportAccumulatedBilling(rows: AccumulatedBillingExportRow[]): void {
  exportDataset<AccumulatedBillingExportRow>({
    filename: `누적청구_${todayStamp()}.xlsx`,
    sheetName: '누적청구',
    columns: ACCUMULATED_COLUMNS,
    rows,
  });
}
