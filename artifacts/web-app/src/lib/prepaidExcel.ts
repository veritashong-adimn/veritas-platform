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
