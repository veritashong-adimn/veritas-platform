// ─── 선입금/차감 Excel Export (공통 excelExport 엔진 재사용) ────────────────────
// VERITAS 9차: 수금관리 > 선입금 관리 전용. SSOT = GET /api/admin/prepaid-accounts (계정 목록).
//  · 1-sheet 계정 요약. 사용가능잔액 = currentBalance, 누적사용액 = initialAmount − currentBalance.
//  · 선입금 잔액을 음수 미수(negative receivable)/초과입금률로 표현하지 않는다(§10).
//  · 일반 수금(receivable)과 분리 — 수금현황 Excel 에는 포함하지 않는다(§12).
//  · 최근입금일/최근차감일은 계정 목록 SSOT 에 없고 원장(ledger) 축이라, 이번 1-sheet 요약에서는 제외한다.
//    (원장 상세 시트는 필요성 확인 후 별도 판단 — §11.)
import { exportDataset, todayStamp, type ExcelColumn } from './excelExport';

export interface PrepaidExportRow {
  id: number;
  companyName: string;
  initialAmount: number;
  currentBalance: number;
  status: string;
  depositDate: string | null;
  createdAt: string;
  note: string | null;
}

const STATUS_LABEL: Record<string, string> = { active: '활성', closed: '마감' };

const num = (v: number | null | undefined) => (typeof v === 'number' ? v : '');

const PREPAID_COLUMNS: ExcelColumn<PrepaidExportRow>[] = [
  { header: '거래처', value: (r) => r.companyName ?? '' },
  { header: '선입금계정', value: (r) => `#${r.id}` },
  { header: '최초선입금액', value: (r) => num(r.initialAmount), type: 'number' },
  { header: '누적사용액', value: (r) => num(r.initialAmount - r.currentBalance), type: 'number' },
  { header: '사용가능잔액', value: (r) => num(r.currentBalance), type: 'number' },
  { header: '입금일', value: 'depositDate', type: 'date' },
  { header: '상태', value: (r) => STATUS_LABEL[r.status] ?? r.status },
  { header: '등록일', value: 'createdAt', type: 'date' },
  { header: '비고', value: (r) => r.note ?? '' },
];

/** 선입금 관리 Excel 다운로드 — 현재 검색에 매칭되는 전체 선입금 계정(계정 요약). */
export function exportPrepaidAccounts(rows: PrepaidExportRow[]): void {
  exportDataset<PrepaidExportRow>({
    filename: `선입금관리_${todayStamp()}.xlsx`,
    sheetName: '선입금관리',
    columns: PREPAID_COLUMNS,
    rows,
  });
}

// ─── 목록형 원장(거래처별 현황 · 거래처 상세 원장) Excel ─────────────────────────────────
//  SSOT = GET /api/prepaid/overview · GET /api/prepaid/companies/:id/ledger (화면과 같은 값)
export interface PrepaidOverviewExportRow {
  companyName: string; totalDeposit: number; totalDeduction: number; confirmedBalance: number;
  pendingInflow: number; pendingDeduction: number; expectedBalance: number; lastTxDate: string | null; statusLabel: string; openingBalance: number;
}
export function exportPrepaidOverview(rows: PrepaidOverviewExportRow[]): void {
  exportDataset<PrepaidOverviewExportRow>({
    filename: `선입금현황_${todayStamp()}.xlsx`, sheetName: '거래처별 선입금 현황', rows,
    columns: [
      { header: '거래처', value: 'companyName' },
      { header: '총 입금액', value: 'totalDeposit', type: 'number' },
      { header: '총 차감액', value: 'totalDeduction', type: 'number' },
      { header: '확정 잔액', value: 'confirmedBalance', type: 'number' },
      { header: '예정 입금액', value: 'pendingInflow', type: 'number' },
      { header: '예정 차감액', value: 'pendingDeduction', type: 'number' },
      { header: '예상 잔액', value: 'expectedBalance', type: 'number' },
      { header: '최근 거래일', value: 'lastTxDate', type: 'date' },
      { header: '상태', value: 'statusLabel' },
      { header: '기초 잔액(원장 미기록)', value: (r) => (r.openingBalance ? r.openingBalance : ''), type: 'number' },
    ],
  });
}
export interface PrepaidLedgerExportRow {
  transactionDate: string; typeLabel: string; description: string; quoteNumber: string; saleNo: string;
  inflow: number | null; outflow: number | null; runningBalance: number; statusLabel: string; memo: string;
}
export function exportPrepaidCompanyLedger(companyName: string, rows: PrepaidLedgerExportRow[]): void {
  exportDataset<PrepaidLedgerExportRow>({
    filename: `선입금원장_${companyName.replace(/[\\/:*?"<>|]/g, '_')}_${todayStamp()}.xlsx`, sheetName: '선입금 원장', rows,
    columns: [
      { header: '거래일', value: 'transactionDate', type: 'date' },
      { header: '구분', value: 'typeLabel' },
      { header: '거래 내용', value: 'description' },
      { header: '연결 견적', value: 'quoteNumber' },
      { header: '연결 판매', value: 'saleNo' },
      { header: '입금액', value: (r) => r.inflow ?? '', type: 'number' },
      { header: '차감액', value: (r) => r.outflow ?? '', type: 'number' },
      { header: '거래 후 잔액', value: 'runningBalance', type: 'number' },
      { header: '상태', value: 'statusLabel' },
      { header: '비고', value: 'memo' },
    ],
  });
}
