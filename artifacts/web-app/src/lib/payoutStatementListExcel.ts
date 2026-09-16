// ─── 지급명세서 '다행 목록' Excel (10차 §3) ───────────────────────────────────
// 지급회차/조회범위의 모든 지급건을 1행=1건 평면 목록으로 출력한다(견적 상품정보/판매정보와 같은 목록형).
//   · 공통 Excel 엔진(excelExport) 재사용 — 헤더강조·AutoFilter·Freeze·자동폭·#,##0·실제 date cell(yyyy.mm.dd).
//   · 계산 없음: payout-rounds API가 산출한 확정 정산값(확정 회차는 payout_round_items 스냅샷)을 그대로 출력(§2·§13).
//   · 세금처리 표기는 공용 formatter(taxTreatmentDisplay) 사용. 민감정보(주민번호 등)는 포함하지 않는다(§5 — 세무자료 전용).
//   · 판매번호·지급방법은 payout SSOT 응답에 없어 컬럼에서 제외(임의 생성 금지 §5·§7).
import { exportDataset, type ExcelColumn } from './excelExport';
import { formatDisplayDate, formatScheduleRange } from './dateFormat';
import { formatLanguageLabel } from './constants';
import { formatTaxTreatment } from './taxTreatmentDisplay';

const num = (v: unknown): number => (Number(v ?? 0) || 0);
const SVC: Record<string, string> = { translation: '번역', interpretation: '통역', equipment: '장비', expense: '경비' };
const svcLabel = (t?: string | null) => SVC[String(t ?? '')] ?? (t ?? '');
const payeeTypeLabel = (t?: string | null) => (t === 'vendor' ? '외주업체' : t === 'individual' ? '통번역사' : '경비');

type Row = Record<string, unknown>;

/**
 * summary: payout-rounds API의 지급대상(payee) 그룹 배열. 각 그룹의 items[](건별)를 평면화한다.
 * roundName: 지급회차 표시명(특정 회차) 또는 조회범위 라벨.
 */
export function exportPayoutStatementList(opts: { filename: string; roundName: string; summary: any[] }): void {
  const rows: Row[] = [];
  for (const g of opts.summary ?? []) {
    for (const it of (g.items ?? [])) {
      const sd = (it.serviceDetail && typeof it.serviceDetail === 'object') ? it.serviceDetail : {};
      rows.push({
        roundName: opts.roundName || (it.roundBatchNumber ?? ''),
        // 지급예정일: expected_payment_date(없으면 회차 예정일). 실제지급일: payout_transfers.paid_at(미지급 blank) — 예정일로 fallback 안 함(§2).
        expectedDate: it.expectedPaymentDate ?? it.roundPaymentDate ?? '',
        actualDate: it.actualPayDate ?? '',
        payeeName: g.payeeName ?? '',
        payeeEmail: g.payeeEmail ?? '',
        payeeTypeLabel: payeeTypeLabel(g.payeeType),
        projectTitle: it.projectTitle ?? it.customerName ?? '',
        quoteNumber: it.quoteNumber ?? '',
        serviceLabel: svcLabel(it.serviceType),
        language: formatLanguageLabel(sd.languagePair ?? it.languageOrServiceSnapshot ?? ''),
        perfPeriod: formatScheduleRange(it.performanceStartDate, it.performanceEndDate) || formatDisplayDate(it.deliveryDate),
        productName: it.productName ?? '',
        base: num(it.basePerformanceFee),
        expense: num(it.expenseTotal),
        deduction: num(it.deductionTotal),
        gross: num(it.gross ?? it.costTotal),
        taxTreatment: formatTaxTreatment({
          payeeType: it.payeeType ?? g.payeeType,
          withholdingTreatment: it.withholdingTreatment,
          withholdingRate: it.withholdingRate,
          purchaseEvidenceType: it.purchaseEvidenceType,
          vatIncluded: it.isVatIncluded,
        }),
        withholding: num(it.withholdingTax),
        vat: num(it.vat),
        net: num(it.netPayment),
        remark: it.remark ?? '',
      });
    }
  }

  const columns: ExcelColumn<Row>[] = [
    { header: '지급회차', value: 'roundName', width: 18 },
    { header: '지급예정일', value: 'expectedDate', type: 'date' },
    { header: '실제지급일', value: 'actualDate', type: 'date' },
    { header: '지급대상명', value: 'payeeName', width: 14 },
    { header: '이메일', value: 'payeeEmail', width: 22 },
    { header: '구분', value: 'payeeTypeLabel', width: 9 },
    { header: '프로젝트명', value: 'projectTitle', width: 24 },
    { header: '견적번호', value: 'quoteNumber', width: 14 },
    { header: '업무유형', value: 'serviceLabel', width: 9 },
    { header: '언어', value: 'language', width: 14 },
    { header: '수행일', value: 'perfPeriod', width: 18 },
    { header: '수행내용', value: 'productName', width: 24 },
    { header: '통번역료', value: 'base', type: 'number' },
    { header: '기타비용', value: 'expense', type: 'number' },
    { header: '차감', value: 'deduction', type: 'number' },
    { header: '세전금액', value: 'gross', type: 'number' },
    { header: '세금처리', value: 'taxTreatment', width: 16 },
    { header: '공제/원천세액', value: 'withholding', type: 'number' },
    { header: '부가세', value: 'vat', type: 'number' },
    { header: '실지급액', value: 'net', type: 'number' },
    { header: '비고', value: 'remark', width: 24 },
  ];

  exportDataset({ filename: opts.filename, sheetName: '지급명세서', columns, rows });
}
