// ─── 수행정보 / 통번역사 배정 Excel Export (단일 시트, 공통 excelExport 엔진 재사용) ───────────
// VERITAS 7차 보완: 2-Sheet(수행목록+수행자배정) → 단일 "수행정보" 시트로 flatten.
//  · "한 수행자 배정 = Excel 한 행"(§2). 수행 1건 + 통역사 3명 → 3행(수행정보 반복, 지급정보만 개별).
//  · 수행자 미배정 수행도 1행 유지, 수행자/지급 컬럼만 blank(§3).
//  · DB 정규화 구조(quote_items·performance_assignments·performance_expenses·performance_deductions)는
//    그대로 두고, Export 시 한 행으로 펼쳐 보여준다(§1·§23).
//  · 요금(100%)/통역료(85%)/기본지급액을 명확히 분리(§5). 재계산하지 않고 기존 저장값·SSOT 함수 사용(§13).
//    세전=costTotal, 세율=withholdingRatePct, 세후=afterTaxPayout — 수행정보 화면과 동일 SSOT(§12·§14).
//  · 정규비용(추가통역료·출장비·교통비) 독립 컬럼 + 기타비용은 합계 + 상세(항목명·금액 보존, §7·§8).
//  · 판매금액과 수행자 지급금액은 섞지 않는다(§6). 민감정보(주민번호·계좌·SWIFT 등) 미포함(§18).
import { exportWorkbook, todayStamp, type ExcelColumn } from './excelExport';
import { formatLanguageLabel } from './constants';
import {
  type Row, num, round2, etcColLabel,
  INTERP_ADD_FEE_TYPE, INTERP_BIZTRIP_TYPE, INTERP_TRANSPORT_TYPE, INTERP_DEDICATED_EXPENSE_TYPES,
  withholdingRatePct, afterTaxPayout, effectiveTreatment, TREATMENT_OPTS,
} from '../components/admin/performanceShared';

export interface PerformanceExportMeta {
  quoteNumber?: string;
  companyName?: string;
  projectTitle?: string;
  contactName?: string;
  pmName?: string;
}

const SERVICE_LABEL: Record<string, string> = {
  translation: '번역', interpretation: '통역', equipment: '장비', expense: '경비',
};
const STATUS_LABEL: Record<string, string> = {
  unassigned: '미배정', assigned: '배정', in_progress: '진행중', completed: '완료',
  payout_pending: '지급대기', paid: '지급완료', cancelled: '취소',
};
const PAYSTATUS_LABEL: Record<string, string> = {
  unpaid: '미지급', payment_hold: '지급보류', paid: '지급완료',
};
const CATEGORY_LABEL: Record<string, string> = {
  individual: '통번역사', vendor: '외주업체', expense: '경비',
};
const TREATMENT_LABEL: Record<string, string> = Object.fromEntries(TREATMENT_OPTS.map(o => [o.value, o.label]));

const svcLabel = (r: Row) => SERVICE_LABEL[r.serviceType ?? ''] ?? r.serviceType ?? '';
const isInterp = (r: Row) => r.serviceType === 'interpretation';
const snapOf = (r: Row): any => (r.serviceDetailSnapshot && typeof r.serviceDetailSnapshot === 'object') ? r.serviceDetailSnapshot : {};
// 수행식별값: 판매항목(saleItemId) 우선, 없으면 배정 id. 없는 수행번호를 만들지 않는다(§4).
const perfKey = (r: Row) => (r.saleItemId != null ? `S${r.saleItemId}` : (r.id != null ? `A${r.id}` : ''));
const hasPerformer = (r: Row) => r.individualUserId != null || r.vendorCompanyId != null;
const numOrBlank = (v: unknown): number | '' => (v == null || v === '' ? '' : num(v));
// 특정 기타비용 항목의 저장된 실지급액(자동 재계산 없이 저장값 그대로, §13).
const expAmt = (r: Row, type: string): number | '' => {
  const e = (r.expenses ?? []).find((x: any) => x.expenseType === type);
  return e ? num(e.amount) : '';
};
// operationHours("10:00~14:00") → [시작, 종료]. 실제 저장값에서만 도출(임의 생성 금지 §4·§16).
const splitTime = (oh: unknown): [string, string] => {
  const s = String(oh ?? '').trim();
  if (!s) return ['', ''];
  const parts = s.split(/\s*[~\-–—]\s*/);
  return [parts[0] ?? '', parts[1] ?? ''];
};

// ── 단일 시트 행 빌드 — 한 수행자 배정 = 한 행. 경비 원가항목(performerCategory=expense) 제외. ──
function buildRows(rows: Row[], meta: PerformanceExportMeta) {
  return rows
    .filter((r) => r.performerCategory !== 'expense')
    .map((r) => {
      const s = snapOf(r);
      const pf = hasPerformer(r);                 // 수행자 배정 여부 — 미배정 시 수행자·지급 컬럼 blank(§3)
      const [startTime, endTime] = splitTime(s.operationHours);

      // 지급기준(§5) — 재계산 없이 저장값 사용. 통역: 요금100=contractUnitPrice(참조)·통역료85=directAmount.
      //   번역/기타: 요금100=directAmount(isDirectAmount일 때)·통역료85 미해당.
      const fee100 = isInterp(r) ? numOrBlank(r.contractUnitPrice) : (r.isDirectAmount ? numOrBlank(r.directAmount) : '');
      const fee85 = isInterp(r) ? numOrBlank(r.directAmount) : '';

      // 기타비용 — 정규 3종(추가통역료·출장비·교통비) 제외 항목. 합계(지급대상) + 상세(항목명·금액 보존, §8).
      const etcItems = (r.expenses ?? []).filter((e: any) => !INTERP_DEDICATED_EXPENSE_TYPES.includes(e.expenseType));
      const etcSum = round2(etcItems.filter((e: any) => e.includedInPayout !== false).reduce((a: number, e: any) => a + num(e.amount), 0));
      const etcDetail = etcItems.map((e: any) => `${etcColLabel(e.expenseType)} ${num(e.amount).toLocaleString('ko-KR')}`).join(' | ');

      // 차감 — 저장값 합계 + 사유별 보존(§11). 복수 차감이면 유형·금액 나열.
      const dedDetail = (r.deductions ?? []).map((d: any) =>
        `${d.deductionType} ${num(d.amount).toLocaleString('ko-KR')}${d.reason ? ` (${d.reason})` : ''}`).join(' | ');

      // 세전→원천세→세후 — 수행정보 화면과 동일 SSOT(costTotal + withholdingRatePct + afterTaxPayout, §12·§13).
      const gross = num(r.costTotal);
      const rate = pf ? withholdingRatePct(r) : 0;
      const tax = pf ? round2(gross * (rate / 100)) : '';
      const net = pf ? afterTaxPayout(gross, r) : '';

      const rr = r as any;                        // loadPerformanceRows 원본(추가 컬럼) 접근
      const actualDelivery = rr.deliveryConfirmed && rr.deliveryConfirmedAt ? String(rr.deliveryConfirmedAt).slice(0, 10) : '';

      return {
        // [기본 연결정보]
        quoteNumber: meta.quoteNumber ?? '',
        projectTitle: meta.projectTitle ?? '',
        companyName: meta.companyName ?? '',
        contactName: meta.contactName ?? '',
        pmName: meta.pmName ?? '',
        // [수행정보]
        perfKey: perfKey(r),
        productName: r.productNameSnapshot ?? '',
        serviceType: svcLabel(r),
        language: formatLanguageLabel(r.languageOrServiceSnapshot ?? s.languagePair ?? ''),
        startDate: r.performanceStartDate ?? '',
        endDate: r.performanceEndDate ?? '',
        startTime,
        endTime,
        place: s.interpretPlace ?? '',
        deliveryDate: r.deliveryDate ?? '',
        actualDelivery,
        quantity: numOrBlank(r.quantity),
        unit: r.unit ?? '',
        unitPrice: numOrBlank(r.contractUnitPrice),
        status: STATUS_LABEL[r.status ?? ''] ?? r.status ?? '',
        // [수행자정보] — 미배정 시 blank(§3). 통번역사 내부코드/ID는 사용자용 Excel에 미노출.
        performerName: pf ? (r.performerNameSnapshot ?? '') : '',
        performerCategory: pf ? (CATEGORY_LABEL[r.performerCategory ?? ''] ?? '') : '',
        role: pf ? (r.lineCategory ?? '') : '',
        assignStatus: pf ? '배정' : '미배정',
        // [지급기준] — 100%/85%/기본지급액 분리(§5)
        fee100: pf ? fee100 : '',
        fee85: pf ? fee85 : '',
        baseFee: pf ? numOrBlank(r.basePerformanceFee) : '',
        // [정규 비용]
        addInterpFee: pf ? expAmt(r, INTERP_ADD_FEE_TYPE) : '',
        bizTripFee: pf ? expAmt(r, INTERP_BIZTRIP_TYPE) : '',
        transportFee: pf ? expAmt(r, INTERP_TRANSPORT_TYPE) : '',
        // [기타비용]
        etcSum: pf && etcSum ? etcSum : '',
        etcDetail: pf ? etcDetail : '',
        // [차감]
        deductionTotal: pf ? numOrBlank(r.deductionTotal) : '',
        deductionReason: pf ? dedDetail : '',
        // [세금/지급]
        grossPayment: pf ? numOrBlank(r.costTotal) : '',
        taxTreatment: pf ? (TREATMENT_LABEL[effectiveTreatment(r)] ?? '') : '',
        withholdingRate: pf ? rate : '',
        withholdingTax: tax,
        netPayment: net,
        expectedPaymentDate: pf ? (r.expectedPaymentDate ?? '') : '',
        actualPaymentDate: pf ? (rr.actualPaymentDate ?? '') : '',
        paymentStatus: pf ? (PAYSTATUS_LABEL[r.paymentStatus ?? ''] ?? r.paymentStatus ?? '') : '',
        payoutRound: pf ? (rr.payoutRoundId ?? '') : '',
        // [기타]
        remark: r.remark ?? '',
      };
    });
}

const COLUMNS: ExcelColumn<any>[] = [
  // [기본 연결정보]
  { header: '견적번호', value: 'quoteNumber' },
  { header: '프로젝트명', value: 'projectTitle' },
  { header: '거래처', value: 'companyName' },
  { header: '담당자', value: 'contactName' },
  { header: '담당PM', value: 'pmName' },
  // [수행정보]
  { header: '수행식별값', value: 'perfKey' },
  { header: '상품명', value: 'productName' },
  { header: '서비스유형', value: 'serviceType' },
  { header: '언어', value: 'language' },
  { header: '수행시작일', value: 'startDate', type: 'date' },
  { header: '수행종료일', value: 'endDate', type: 'date' },
  { header: '시작시간', value: 'startTime' },
  { header: '종료시간', value: 'endTime' },
  { header: '수행장소', value: 'place' },
  { header: '납품예정일', value: 'deliveryDate', type: 'date' },
  { header: '실제납품일', value: 'actualDelivery', type: 'date' },
  { header: '수량', value: 'quantity', type: 'number' },
  { header: '단위', value: 'unit' },
  { header: '단가', value: 'unitPrice', type: 'number' },
  { header: '수행상태', value: 'status' },
  // [수행자정보]
  { header: '통번역사명', value: 'performerName' },
  { header: '수행자구분', value: 'performerCategory' },
  { header: '역할', value: 'role' },
  { header: '배정상태', value: 'assignStatus' },
  // [지급기준]
  { header: '요금(100%)', value: 'fee100', type: 'number' },
  { header: '통역료(85%)', value: 'fee85', type: 'number' },
  { header: '기본지급액', value: 'baseFee', type: 'number' },
  // [정규 비용]
  { header: '추가통역료', value: 'addInterpFee', type: 'number' },
  { header: '출장비', value: 'bizTripFee', type: 'number' },
  { header: '교통비', value: 'transportFee', type: 'number' },
  // [기타비용]
  { header: '기타비용 합계', value: 'etcSum', type: 'number' },
  { header: '기타비용 상세', value: 'etcDetail' },
  // [차감]
  { header: '차감액', value: 'deductionTotal', type: 'number' },
  { header: '차감사유', value: 'deductionReason' },
  // [세금/지급]
  { header: '세전지급예정액', value: 'grossPayment', type: 'number' },
  { header: '세금처리', value: 'taxTreatment' },
  { header: '원천세율', value: 'withholdingRate', type: 'number', numFmt: '0.0' },
  { header: '원천세액', value: 'withholdingTax', type: 'number' },
  { header: '세후지급예정액', value: 'netPayment', type: 'number' },
  { header: '지급예정일', value: 'expectedPaymentDate', type: 'date' },
  { header: '실제지급일', value: 'actualPaymentDate', type: 'date' },
  { header: '지급상태', value: 'paymentStatus' },
  { header: '지급회차', value: 'payoutRound', type: 'number' },
  // [기타]
  { header: '비고', value: 'remark' },
];

/** 판매(project) 단위 수행/배정 Excel 다운로드 — 단일 "수행정보" 시트. read-only(재계산 없이 저장값 사용). */
export function exportPerformances(meta: PerformanceExportMeta, rows: Row[]): void {
  exportWorkbook({
    filename: `VERITAS_수행정보_${todayStamp()}.xlsx`,
    sheets: [
      { sheetName: '수행정보', columns: COLUMNS, rows: buildRows(rows, meta) },
    ],
  });
}
