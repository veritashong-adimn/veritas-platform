// ─── 수행정보 / 통번역사 배정 Excel Export (공통 excelExport 엔진 재사용) ───────────────
// VERITAS 6차: 판매 상세 수행정보 섹션의 project 단위 Export. 배정 대량등록(Import)은 이번 단계 보류(§13·§14).
//  · 전역 수행목록 화면·API 가 없으므로 project 단위 Export 제공(§11). 이미 로드된 project.performances 사용 → 백엔드 무변경.
//  · Sheet1 수행목록(통역+번역 단일 시트, 미해당 필드 blank §5), Sheet2 수행자배정(비용).
//  · 통역료 85%/요금 100% 는 저장값 그대로(§7 자동 85% 계산 없음). 판매금액과 지급액은 완전 분리(§8).
//  · 기타비용은 고정(추가통역료·출장비·교통비) + 동적 컬럼으로 항목명 보존(§10). 합산으로 항목명 잃지 않음.
//  · 민감정보(주민번호·계좌·SWIFT 등) 미포함(§25).
import { exportWorkbook, todayStamp, type ExcelColumn } from './excelExport';
import {
  type Row, num, computeEtcCols, etcColLabel,
  INTERP_ADD_FEE_TYPE, INTERP_BIZTRIP_TYPE, INTERP_TRANSPORT_TYPE, INTERP_DEDICATED_EXPENSE_TYPES,
} from '../components/admin/performanceShared';

export interface PerformanceExportMeta {
  quoteNumber?: string;
  companyName?: string;
  projectTitle?: string;
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

const svcLabel = (r: Row) => SERVICE_LABEL[r.serviceType ?? ''] ?? r.serviceType ?? '';
const isInterp = (r: Row) => r.serviceType === 'interpretation';
const isTrans = (r: Row) => r.serviceType === 'translation';
const snapOf = (r: Row): any => (r.serviceDetailSnapshot && typeof r.serviceDetailSnapshot === 'object') ? r.serviceDetailSnapshot : {};
// 수행식별값: 판매항목(saleItemId) 우선, 없으면 배정 id. 없는 수행번호를 만들지 않는다(§4).
const perfKey = (r: Row) => (r.saleItemId != null ? `S${r.saleItemId}` : (r.id != null ? `A${r.id}` : ''));
const hasPerformer = (r: Row) => r.individualUserId != null || r.vendorCompanyId != null;
// 특정 기타비용 항목의 저장된 실지급액(자동 재계산 없이 저장값 그대로, §9).
const expAmt = (r: Row, type: string): number | '' => {
  const e = (r.expenses ?? []).find((x: any) => x.expenseType === type);
  return e ? num(e.amount) : '';
};
const numOrBlank = (v: unknown): number | '' => (v == null || v === '' ? '' : num(v));

// ── Sheet1: 수행목록 (수행항목 단위로 dedupe — 수행 1건 + 배정 N명 → 목록 1행, 배정 N행) ──
function buildListRows(rows: Row[], meta: PerformanceExportMeta) {
  const byKey = new Map<string, any>();
  for (const r of rows) {
    if (r.performerCategory === 'expense') continue; // 경비 원가항목은 수행정보 행이 아님
    const key = perfKey(r);
    const existing = byKey.get(key);
    if (existing) {
      if (hasPerformer(r)) existing.assignedCount += 1;
      continue;
    }
    const s = snapOf(r);
    byKey.set(key, {
      quoteNumber: meta.quoteNumber ?? '',
      projectTitle: meta.projectTitle ?? '',
      companyName: meta.companyName ?? '',
      perfKey: key,
      serviceType: svcLabel(r),
      language: r.languageOrServiceSnapshot ?? '',
      startDate: isInterp(r) ? (r.performanceStartDate ?? '') : '',
      endDate: isInterp(r) ? (r.performanceEndDate ?? '') : '',
      time: isInterp(r) ? (s.operationHours ?? '') : '',
      place: isInterp(r) ? (s.interpretPlace ?? '') : '',
      quantity: isTrans(r) ? numOrBlank(r.quantity) : '',
      unit: isTrans(r) ? (r.unit ?? '') : '',
      deliveryDate: r.deliveryDate ?? '',
      assignedCount: hasPerformer(r) ? 1 : 0,
      status: STATUS_LABEL[r.status ?? ''] ?? r.status ?? '',
      pmName: meta.pmName ?? '',
      remark: r.remark ?? '',
    });
  }
  return Array.from(byKey.values());
}

const LIST_COLUMNS: ExcelColumn<any>[] = [
  { header: '견적번호', value: 'quoteNumber' },
  { header: '프로젝트명', value: 'projectTitle' },
  { header: '거래처', value: 'companyName' },
  { header: '수행식별값', value: 'perfKey' },
  { header: '서비스유형', value: 'serviceType' },
  { header: '언어', value: 'language' },
  { header: '수행시작일', value: 'startDate', type: 'date' },
  { header: '수행종료일', value: 'endDate', type: 'date' },
  { header: '시간', value: 'time' },
  { header: '장소', value: 'place' },
  { header: '수량', value: 'quantity', type: 'number' },
  { header: '단위', value: 'unit' },
  { header: '납품예정일', value: 'deliveryDate', type: 'date' },
  { header: '배정인원', value: 'assignedCount', type: 'number' },
  { header: '수행상태', value: 'status' },
  { header: '담당PM', value: 'pmName' },
  { header: '비고', value: 'remark' },
];

// ── Sheet2: 수행자배정 (통번역사/외주 1배정 = 1행). 경비 원가항목 제외. ──
const ASSIGN_COLUMNS_HEAD: ExcelColumn<any>[] = [
  { header: '수행식별값', value: 'perfKey' },
  { header: '견적번호', value: 'quoteNumber' },
  { header: '프로젝트명', value: 'projectTitle' },
  { header: '통번역사/업체명', value: 'performerName' },
  { header: '통번역사ID/업체ID', value: 'performerId' },
  { header: '구분', value: 'category' },
  { header: '언어', value: 'language' },
  { header: '배정상태', value: 'status' },
  { header: '수행일', value: 'performDate', type: 'date' },
  { header: '통번역료', value: 'baseFee', type: 'number' },
  { header: '추가통역료', value: 'addInterpFee', type: 'number' },
  { header: '출장비', value: 'bizTripFee', type: 'number' },
  { header: '교통비', value: 'transportFee', type: 'number' },
];
const ASSIGN_COLUMNS_TAIL: ExcelColumn<any>[] = [
  { header: '차감', value: 'deductionTotal', type: 'number' },
  { header: '세전지급예정액', value: 'grossPayment', type: 'number' },
  { header: '원천징수', value: 'withholdingTax', type: 'number' },
  { header: '세후지급예정액', value: 'netPayment', type: 'number' },
  { header: '지급상태', value: 'paymentStatus' },
  { header: '비고', value: 'remark' },
];

function buildAssignRows(rows: Row[], meta: PerformanceExportMeta) {
  const src = rows.filter((r) => r.performerCategory !== 'expense');
  // 동적 기타비용 컬럼 — 고정 3종(추가통역료·출장비·교통비) 제외한 실제 등장 항목만(§10, 항목명 보존).
  const etcCols = computeEtcCols(src).filter((t) => !INTERP_DEDICATED_EXPENSE_TYPES.includes(t));
  const out = src.map((r) => {
    const base: any = {
      perfKey: perfKey(r),
      quoteNumber: meta.quoteNumber ?? '',
      projectTitle: meta.projectTitle ?? '',
      performerName: r.performerNameSnapshot ?? '',
      performerId: r.performerCategory === 'individual' ? (r.individualUserId ?? '') : (r.vendorCompanyId ?? ''),
      category: r.lineCategory ?? '',
      language: r.languageOrServiceSnapshot ?? '',
      status: STATUS_LABEL[r.status ?? ''] ?? r.status ?? '',
      performDate: r.performanceStartDate ?? r.deliveryDate ?? '',
      baseFee: numOrBlank(r.basePerformanceFee),
      addInterpFee: expAmt(r, INTERP_ADD_FEE_TYPE),
      bizTripFee: expAmt(r, INTERP_BIZTRIP_TYPE),
      transportFee: expAmt(r, INTERP_TRANSPORT_TYPE),
      deductionTotal: numOrBlank(r.deductionTotal),
      grossPayment: r.grossPayment != null ? num(r.grossPayment) : numOrBlank(r.costTotal),
      withholdingTax: numOrBlank(r.withholdingTax),
      netPayment: numOrBlank(r.netPayment),
      paymentStatus: PAYSTATUS_LABEL[r.paymentStatus ?? ''] ?? r.paymentStatus ?? '',
      remark: r.remark ?? '',
    };
    for (const t of etcCols) base[`etc__${t}`] = expAmt(r, t);
    return base;
  });
  const etcColumns: ExcelColumn<any>[] = etcCols.map((t) => ({
    header: etcColLabel(t), value: (row: any) => row[`etc__${t}`] ?? '', type: 'number' as const,
  }));
  return { rows: out, columns: [...ASSIGN_COLUMNS_HEAD, ...etcColumns, ...ASSIGN_COLUMNS_TAIL] };
}

/** 판매(project) 단위 수행/배정 Excel 다운로드 — 수행목록 + 수행자배정 2시트. read-only. */
export function exportPerformances(meta: PerformanceExportMeta, rows: Row[]): void {
  const listRows = buildListRows(rows, meta);
  const assign = buildAssignRows(rows, meta);
  exportWorkbook({
    filename: `VERITAS_수행배정_${todayStamp()}.xlsx`,
    sheets: [
      { sheetName: '수행목록', columns: LIST_COLUMNS, rows: listRows },
      { sheetName: '수행자배정', columns: assign.columns, rows: assign.rows },
    ],
  });
}
