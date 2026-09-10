/**
 * 수행정보/통번역사 배정 대량등록(Import) 템플릿 — VERITAS OS 7차 보완(단일 시트)
 * ────────────────────────────────────────────────────────────────────────
 * 현재 판매/프로젝트의 판매품목을 미리 채운 "수행자배정" 단일 시트 템플릿(§1·§2).
 *   · 1행 = 수행 1건 + 수행자 1명. 수행자 여러 명이면 같은 수행정보를 여러 행에 반복.
 *   · 기타비용은 한 행 안에서 최대 3건(항목+금액)까지 인라인 입력(§4). 별도 비용상세/차감상세/입력안내 시트 없음.
 *   · 차감은 차감액+차감사유 인라인. Import 시 기존 정규화 구조(performance_expenses/deductions)로 변환(§7·§10).
 * 저장/계산은 서버 SSOT가 담당하며, 템플릿은 입력 편의만 제공한다. 민감정보 미포함(§18).
 */
import { exportWorkbook, todayStamp, type ExcelColumn } from './excelExport';
import { formatLanguageLabel } from './constants';

export interface PerfTemplateMeta {
  quoteNumber?: string | null;
  companyName?: string | null;
  projectTitle?: string | null;
}
export interface PerfSeedItem {
  saleItemId: number;
  saleSeq: number;
  productName: string;
  serviceType: string;
  startDate: string;
  endDate: string;
  place: string;
  unit: string;
  quantity: number | null;
  interpreterCount: number | null;
  languagePair: string;
}

// 사전채움 데이터 행(수행자배정 시트) — 기타비용 3쌍(항목/금액) 인라인.
interface AssignRow {
  rowSeq: number;
  saleItemCode: number;
  saleSeq: number;
  productName: string;
  serviceType: string;
  startDate: string;
  endDate: string;
  deliveryDate: string;
  startTime: string;
  endTime: string;
  place: string;
  translatorName: string;
  email: string;
  phone: string;
  language: string;
  role: string;
  fee100: number | null;
  fee85: number | null;
  quantity: number | null;
  unit: string;
  contractUnitPrice: number | null;
  addInterpFee: number | null;
  businessTripFee: number | null;
  transportFee: number | null;
  etc1Type: string;
  etc1Amount: number | null;
  etc2Type: string;
  etc2Amount: number | null;
  etc3Type: string;
  etc3Amount: number | null;
  deductionAmount: number | null;
  deductionReason: string;
  taxTreatment: string;
  payDate: string;
  remark: string;
}

// 수행자배정 단일 시트 컬럼(헤더=서버 동의어 정확 매칭). 금액=number(#,##0), 날짜=date(yyyy.mm.dd).
const ASSIGN_COLUMNS: ExcelColumn<AssignRow>[] = [
  { header: '수행순번', value: 'rowSeq', type: 'number', width: 8 },
  { header: '판매품목코드', value: 'saleItemCode', type: 'number', width: 11 },
  { header: '판매품목순번', value: 'saleSeq', type: 'number', width: 11 },
  { header: '상품명', value: 'productName', width: 22 },
  { header: '서비스유형', value: 'serviceType', width: 12 },
  { header: '수행시작일', value: 'startDate', type: 'date', width: 12 },
  { header: '수행종료일', value: 'endDate', type: 'date', width: 12 },
  { header: '납품일', value: 'deliveryDate', type: 'date', width: 12 },
  { header: '시작시간', value: 'startTime', width: 9 },
  { header: '종료시간', value: 'endTime', width: 9 },
  { header: '수행장소', value: 'place', width: 16 },
  { header: '통번역사명', value: 'translatorName', width: 12 },
  { header: '이메일', value: 'email', width: 22 },
  { header: '휴대폰', value: 'phone', width: 14 },
  { header: '언어', value: 'language', width: 12 },
  { header: '역할', value: 'role', width: 10 },
  { header: '요금(100%)', value: 'fee100', type: 'number', width: 12 },
  { header: '통역료(85%)', value: 'fee85', type: 'number', width: 12 },
  { header: '수량', value: 'quantity', type: 'number', width: 8 },
  { header: '단위', value: 'unit', width: 8 },
  { header: '계약단가', value: 'contractUnitPrice', type: 'number', width: 12 },
  { header: '추가통역료', value: 'addInterpFee', type: 'number', width: 11 },
  { header: '출장비', value: 'businessTripFee', type: 'number', width: 10 },
  { header: '교통비', value: 'transportFee', type: 'number', width: 10 },
  { header: '기타비용1 항목', value: 'etc1Type', width: 12 },
  { header: '기타비용1 금액', value: 'etc1Amount', type: 'number', width: 12 },
  { header: '기타비용2 항목', value: 'etc2Type', width: 12 },
  { header: '기타비용2 금액', value: 'etc2Amount', type: 'number', width: 12 },
  { header: '기타비용3 항목', value: 'etc3Type', width: 12 },
  { header: '기타비용3 금액', value: 'etc3Amount', type: 'number', width: 12 },
  { header: '차감액', value: 'deductionAmount', type: 'number', width: 10 },
  { header: '차감사유', value: 'deductionReason', width: 14 },
  { header: '세금처리', value: 'taxTreatment', width: 12 },
  { header: '지급예정일', value: 'payDate', type: 'date', width: 12 },
  { header: '비고', value: 'remark', width: 16 },
];

/** 판매품목을 미리 채운 단일 시트(수행자배정) 대량등록 템플릿 다운로드. */
export function downloadPerformanceImportTemplate(meta: PerfTemplateMeta, items: PerfSeedItem[]): void {
  const assignRows: AssignRow[] = items.map((it, idx) => ({
    rowSeq: idx + 1,
    saleItemCode: it.saleItemId,
    saleSeq: it.saleSeq,
    productName: it.productName,
    serviceType: it.serviceType,
    startDate: it.startDate,
    endDate: it.endDate,
    deliveryDate: '',
    startTime: '',
    endTime: '',
    place: it.place,
    translatorName: '',
    email: '',
    phone: '',
    language: formatLanguageLabel(it.languagePair),
    role: '',
    fee100: null,
    fee85: null,
    quantity: it.quantity,
    unit: it.unit,
    contractUnitPrice: null,
    addInterpFee: null,
    businessTripFee: null,
    transportFee: null,
    etc1Type: '',
    etc1Amount: null,
    etc2Type: '',
    etc2Amount: null,
    etc3Type: '',
    etc3Amount: null,
    deductionAmount: null,
    deductionReason: '',
    taxTreatment: '',
    payDate: '',
    remark: '',
  }));

  const base = (meta.quoteNumber || meta.projectTitle || '수행정보').replace(/[\\/:*?"<>|]/g, '_');
  exportWorkbook({
    filename: `수행자배정_대량등록_${base}_${todayStamp()}.xlsx`,
    sheets: [
      { sheetName: '수행자배정', columns: ASSIGN_COLUMNS, rows: assignRows },
    ],
  });
}
