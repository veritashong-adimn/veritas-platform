/**
 * VERITAS Quote Excel Export — 견적 데이터 출력
 *
 * Workspace의 A 기본정보 + B 상품정보를 Excel 데이터로 추출한다.
 * 고객 전달용 견적서가 아닌 내부 관리·데이터 활용 목적이다.
 *
 * 공통 재사용 함수:
 *   formatServiceDetail(item, products) — 서비스별 상세 문자열
 *   downloadQuoteExcel(data)            — Excel 생성 + 다운로드
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import XLSX from 'xlsx-js-style';
import { getPolicy } from './languagePagePolicy';
import { displayUnit, calcInterpretation } from './quotePdf';
import { formatScheduleRange } from './dateFormat';
import { formatLanguageLabel, type Product } from './constants';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export interface ExportItem {
  productId:        number | null;
  productName:      string;
  productType:      string;
  quantity:         string;
  unit:             string;
  unitPrice:        string;
  memo:             string;
  sourceLanguage:   string;
  fileName:         string;
  fileFormat:       string;
  wordCount:        string;
  charCount:        string;
  interpretDate:    string;
  interpretEndDate: string;
  startTime:        string;
  endTime:          string;
  interpretPlace:   string;
  interpreterCount: string;
  eventStartDate:   string;
  eventEndDate:     string;
  itemLocation:     string;
  usagePeriod:      string;
  expenseType:      string;
}

export interface QuoteExportData {
  title:       string;
  quoteType:   string;
  issueDate:   string;
  companyName: string;
  contactName: string;
  pmName:      string;
  vatType:     string;
  note:        string;
  items:       ExportItem[];
  products:    Product[];
  totals:      { supply: number; tax: number; total: number };
}

// ─── 레이블 ───────────────────────────────────────────────────────────────────

const QUOTE_TYPE_LABEL: Record<string, string> = {
  b2b_standard: '일반 견적서', b2c_prepaid: '선불 (B2C)', accumulated_batch: '누적 배치',
};
const VAT_LABEL: Record<string, string> = {
  taxable: '과세 (10%)', exempt: '면세', zero_rate: '영세율 (0%)',
};
const SVC_LABEL: Record<string, string> = {
  translation: '번역', interpretation: '통역', equipment: '장비', expense: '기타',
};

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

function getLangName(code: string | null | undefined): string {
  if (!code) return '';
  return getPolicy(code)?.languageName ?? code;
}

function fmtN(v: string): number {
  return Number(String(v).replace(/,/g, '')) || 0;
}

// ─── formatServiceDetail ──────────────────────────────────────────────────────
// 서비스별 상세 문자열 — 판매관리·프로젝트·활동 로그 등에서 동일 함수 재사용

export function formatServiceDetail(item: ExportItem, products: Product[]): string {
  const parts: string[] = [];
  switch (item.productType) {
    case 'translation': {
      const prod = item.productId != null ? products.find(p => p.id === item.productId) ?? null : null;
      const src = getLangName(prod?.sourceLanguage);
      const tgt = getLangName(prod?.targetLanguage);
      if (src || tgt) parts.push(`${src}→${tgt}`);
      if (item.fileName)   parts.push(item.fileName);
      if (item.fileFormat) parts.push(item.fileFormat);
      const wc = fmtN(item.wordCount);
      const cc = fmtN(item.charCount);
      if (wc > 0) parts.push(`${wc.toLocaleString()}단어`);
      if (cc > 0) parts.push(`${cc.toLocaleString()}글자`);
      break;
    }
    case 'interpretation': {
      if (item.interpretDate) parts.push(formatScheduleRange(item.interpretDate, item.interpretEndDate));
      const time = [item.startTime, item.endTime].filter(Boolean).join('~');
      if (time) parts.push(time);
      if (item.interpretPlace)  parts.push(item.interpretPlace);
      const cnt = fmtN(item.interpreterCount);
      if (cnt > 0) parts.push(`${cnt}명`);
      break;
    }
    case 'equipment': {
      if (item.eventStartDate) parts.push(formatScheduleRange(item.eventStartDate, item.eventEndDate));
      if (item.itemLocation) parts.push(item.itemLocation);
      const days = fmtN(item.usagePeriod);
      if (days > 0) parts.push(`${days}일`);
      break;
    }
    case 'expense': {
      if (item.expenseType) parts.push(item.expenseType);
      break;
    }
  }
  return parts.join(' / ');
}

// ─── 공급가액 계산 ────────────────────────────────────────────────────────────

function calcSupply(item: ExportItem): number {
  const p = fmtN(item.unitPrice);
  if (item.productType === 'interpretation') {
    // 통역: 진행일수 × 인원 × 단가 (날짜 기반 — 편집 화면·서버와 동일 공통 함수)
    return calcInterpretation({
      startDate:        item.interpretDate,
      endDate:          item.interpretEndDate,
      interpreterCount: item.interpreterCount,
      unitPrice:        item.unitPrice,
    }).supplyAmount;
  }
  const q    = Number(item.quantity) || 1;
  const days = item.productType === 'equipment' ? (Number(item.usagePeriod) || 1) : 1;
  return Math.round(days * q * p);
}

/** 엑셀 '수량' 열 값 — 통역은 진행일수, 그 외는 quantity. */
function displayQuantity(item: ExportItem): number {
  if (item.productType === 'interpretation') {
    const { serviceDays, invalidDateRange } = calcInterpretation({
      startDate: item.interpretDate,
      endDate:   item.interpretEndDate,
    });
    return invalidDateRange ? 0 : serviceDays;
  }
  return Number(item.quantity) || 1;
}

// ─── 스타일 ───────────────────────────────────────────────────────────────────

const S = {
  // A. 기본정보
  infoKey: {
    font:  { bold: true, sz: 10 },
    fill:  { patternType: 'solid', fgColor: { rgb: 'F9FAFB' } },
    alignment: { horizontal: 'left', vertical: 'center' },
  },
  infoVal: {
    font:  { sz: 10 },
    alignment: { horizontal: 'left', vertical: 'center' },
  },

  // B. 상품 테이블 헤더
  thC: { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'center', vertical: 'center' } },
  thL: { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'left',   vertical: 'center' } },
  thR: { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'right',  vertical: 'center' } },

  // B. 상품 테이블 데이터
  td:    { font: { sz: 10 }, alignment: { vertical: 'center', wrapText: true } },
  tdC:   { font: { sz: 10 }, alignment: { horizontal: 'center', vertical: 'center' } },
  tdNum: { font: { sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } },
  tdTxt: { font: { sz: 10 }, alignment: { vertical: 'center', wrapText: true } },

  // C. 금액 요약
  sumKey: { font: { bold: true, sz: 10 }, alignment: { horizontal: 'right' } },
  sumVal: { font: { bold: true, sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right' } },
  totKey: { font: { bold: true, sz: 11 }, fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } }, alignment: { horizontal: 'right' } },
  totVal: { font: { bold: true, sz: 11 }, numFmt: '#,##0', fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } }, alignment: { horizontal: 'right' } },
};

// 컬럼 인덱스 (A=0 … I=8)
const COL = { NO: 0, TYPE: 1, PRODUCT: 2, DETAIL: 3, QTY: 4, UNIT: 5, PRICE: 6, SUPPLY: 7, MEMO: 8, N: 9 };

// ─── downloadQuoteExcel ───────────────────────────────────────────────────────

export function downloadQuoteExcel(data: QuoteExportData): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {};
  let r = 0;

  function sc(row: number, col: number, v: string | number, s: object, t?: 's' | 'n') {
    ws[XLSX.utils.encode_cell({ r: row, c: col })] = {
      v, s, t: t ?? (typeof v === 'number' ? 'n' : 's'),
    };
  }

  // ── A. 기본정보 ─────────────────────────────────────────────────────────────

  const infoRows: [string, string][] = [
    ['견적명',    data.title || '(제목 없음)'],
    ['견적유형',  QUOTE_TYPE_LABEL[data.quoteType] ?? data.quoteType],
    ['견적일',    data.issueDate],
    ['거래처',    data.companyName || '-'],
    ['담당자',    data.contactName || '-'],
    ['담당 PM',   data.pmName     || '-'],
    ['부가세',    VAT_LABEL[data.vatType] ?? data.vatType],
  ];
  for (const [k, v] of infoRows) {
    sc(r, 0, k, S.infoKey);
    sc(r, 1, v, S.infoVal);
    r++;
  }

  r++; // 빈 행

  // ── B. 상품정보 헤더 ────────────────────────────────────────────────────────

  sc(r, COL.NO,      'No',       S.thC);
  sc(r, COL.TYPE,    '유형',     S.thC);
  sc(r, COL.PRODUCT, '상품',     S.thL);
  sc(r, COL.DETAIL,  '서비스별 상세', S.thL);
  sc(r, COL.QTY,     '수량',     S.thR);
  sc(r, COL.UNIT,    '단위',     S.thC);
  sc(r, COL.PRICE,   '단가',     S.thR);
  sc(r, COL.SUPPLY,  '공급가액', S.thR);
  sc(r, COL.MEMO,    '비고',     S.thL);
  r++;

  // ── B. 상품정보 데이터 ──────────────────────────────────────────────────────

  data.items.forEach((item, idx) => {
    const supply = calcSupply(item);
    const detail = formatServiceDetail(item, data.products);
    sc(r, COL.NO,      idx + 1,                              S.tdC,   'n');
    sc(r, COL.TYPE,    SVC_LABEL[item.productType] ?? item.productType, S.tdC);
    sc(r, COL.PRODUCT, item.productName || '-',              S.td);
    sc(r, COL.DETAIL,  detail,                               S.tdTxt);
    sc(r, COL.QTY,     displayQuantity(item),                S.tdNum, 'n');
    sc(r, COL.UNIT,    displayUnit(item.productName, item.unit) || '-', S.tdC);
    sc(r, COL.PRICE,   fmtN(item.unitPrice),                 S.tdNum, 'n');
    sc(r, COL.SUPPLY,  supply,                               S.tdNum, 'n');
    sc(r, COL.MEMO,    item.memo || '',                      S.tdTxt);
    r++;
  });

  r++; // 빈 행

  // ── C. 금액 요약 ────────────────────────────────────────────────────────────
  // 단가(G=6) 열에 레이블, 공급가액(H=7) 열에 금액

  const summaryRows: [string, number, object, object][] = [
    ['공급가액 합계', data.totals.supply, S.sumKey, S.sumVal],
    ['부가세',        data.totals.tax,    S.sumKey, S.sumVal],
    ['총 견적금액',   data.totals.total,  S.totKey, S.totVal],
  ];
  for (const [k, v, ks, vs] of summaryRows) {
    sc(r, COL.PRICE,  k, ks);
    sc(r, COL.SUPPLY, v, vs, 'n');
    r++;
  }

  // 견적 비고
  if (data.note && data.note.trim()) {
    r++;
    sc(r, 0, '비고', S.infoKey);
    sc(r, 1, data.note, S.infoVal);
    r++;
  }

  // ── 시트 범위 · 컬럼 너비 ──────────────────────────────────────────────────

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: COL.MEMO } });
  ws['!cols'] = [
    { wch: 12 }, // A: No / 기본정보 키
    { wch: 28 }, // B: 유형 / 기본정보 값
    { wch: 22 }, // C: 상품
    { wch: 54 }, // D: 서비스별 상세
    { wch:  7 }, // E: 수량
    { wch:  7 }, // F: 단위
    { wch: 15 }, // G: 단가
    { wch: 15 }, // H: 공급가액
    { wch: 32 }, // I: 비고
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '견적관리');

  // 파일명: VERITAS_견적관리_견적명_견적일.xlsx
  const safeName = (data.title || '견적').replace(/[\\/:*?"<>|\s]+/g, '_');
  XLSX.writeFile(wb, `VERITAS_견적관리_${safeName}_${data.issueDate}.xlsx`);
}

// ─── 견적 목록 Excel 다운로드(공통 Engine) + 대량등록 템플릿 ───────────────────
// 목록/품목상세 다운로드와 Native 대량등록 템플릿은 거래처/담당자/통번역사와 동일한 공통 excelExport 엔진을 재사용한다.
import {
  exportWorkbook, downloadTemplate, todayStamp,
  type ExcelColumn, type TemplateColumn,
} from './excelExport';

// 서버 /admin/quotes/bulk-export 응답 행 형태(느슨히 선언).
export interface QuoteListRow {
  quoteNumber?: string; title?: string; quoteType?: string;
  companyName?: string; businessNumber?: string; contactName?: string; adminName?: string;
  issueDate?: string; validUntil?: string; firstService?: string;
  itemCount?: number; supplyAmount?: number; taxAmount?: number; totalAmount?: number;
  statusLabel?: string; approvalLabel?: string; convertedLabel?: string;
  accumulatedLabel?: string; relationLabel?: string; rootQuoteNumber?: string;
  createdAt?: string | null; note?: string;
}
export interface QuoteItemRow {
  quoteNumber?: string; title?: string; productName?: string; itemType?: string; languagePair?: string;
  interpretDate?: string; interpretPlace?: string; eventStartDate?: string; eventEndDate?: string;
  quantity?: number; unit?: string; unitPrice?: number; supplyAmount?: number; taxAmount?: number; totalAmount?: number; memo?: string;
}

const QUOTE_TYPE_LABEL_EXPORT: Record<string, string> = {
  b2b_standard: '일반', b2c_prepaid: '선입금', prepaid_deduction: '차감', accumulated_batch: '누적',
};
const ITEM_TYPE_LABEL: Record<string, string> = {
  translation: '번역', interpretation: '통역', equipment: '장비', expense: '경비', discount: '할인',
};

const QUOTE_LIST_COLUMNS: ExcelColumn<QuoteListRow>[] = [
  { header: '견적번호', value: 'quoteNumber' },
  { header: '견적서명', value: 'title' },
  { header: '견적유형', value: (r) => QUOTE_TYPE_LABEL_EXPORT[r.quoteType ?? ''] ?? r.quoteType ?? '' },
  { header: '거래처명', value: 'companyName' },
  { header: '사업자등록번호', value: 'businessNumber' },
  { header: '담당자명', value: 'contactName' },
  { header: '담당PM', value: 'adminName' },
  { header: '견적일', value: 'issueDate', type: 'date' },
  { header: '유효기간', value: 'validUntil', type: 'date' },
  { header: '대표서비스', value: 'firstService' },
  { header: '품목수', value: (r) => (typeof r.itemCount === 'number' ? r.itemCount : ''), type: 'number' },
  { header: '공급가액', value: (r) => (typeof r.supplyAmount === 'number' ? r.supplyAmount : ''), type: 'number' },
  { header: '부가세', value: (r) => (typeof r.taxAmount === 'number' ? r.taxAmount : ''), type: 'number' },
  { header: '총금액', value: (r) => (typeof r.totalAmount === 'number' ? r.totalAmount : ''), type: 'number' },
  { header: '견적상태', value: 'statusLabel' },
  { header: '승인상태', value: 'approvalLabel' },
  { header: '판매전환여부', value: 'convertedLabel' },
  { header: '판매번호', value: () => '' },        // 별도 sale 번호 체계 없음 — 빈칸(§3)
  { header: '누적상태', value: 'accumulatedLabel' },
  { header: '관계구분', value: 'relationLabel' },
  { header: '원견적번호', value: 'rootQuoteNumber' },
  { header: '등록일', value: (r) => r.createdAt || '', type: 'date' },
  { header: '메모', value: 'note' },
];

const QUOTE_ITEM_COLUMNS: ExcelColumn<QuoteItemRow>[] = [
  { header: '견적번호', value: 'quoteNumber' },
  { header: '견적서명', value: 'title' },
  { header: '서비스대분류', value: (r) => ITEM_TYPE_LABEL[r.itemType ?? ''] ?? r.itemType ?? '' },
  { header: '상품명', value: 'productName' },
  { header: '언어', value: (r) => formatLanguageLabel(r.languagePair) },
  { header: '수행시작일', value: (r) => r.interpretDate || r.eventStartDate || '', type: 'date' },
  { header: '수행종료일', value: (r) => r.eventEndDate || '', type: 'date' },
  { header: '장소', value: 'interpretPlace' },
  { header: '수량', value: (r) => (typeof r.quantity === 'number' ? r.quantity : ''), type: 'number' },
  { header: '단위', value: 'unit' },
  { header: '단가', value: (r) => (typeof r.unitPrice === 'number' ? r.unitPrice : ''), type: 'number' },
  { header: '공급가액', value: (r) => (typeof r.supplyAmount === 'number' ? r.supplyAmount : ''), type: 'number' },
  { header: '부가세', value: (r) => (typeof r.taxAmount === 'number' ? r.taxAmount : ''), type: 'number' },
  { header: '금액', value: (r) => (typeof r.totalAmount === 'number' ? r.totalAmount : ''), type: 'number' },
  { header: '비고', value: 'memo' },
];

/** 견적 목록(견적목록 + 품목상세 2시트) .xlsx 다운로드. 현재 검색/필터 전체 결과를 넘길 것. */
export function exportQuotes(data: { quotes: QuoteListRow[]; items: QuoteItemRow[] }): void {
  exportWorkbook({
    filename: `VERITAS_견적_${todayStamp()}.xlsx`,
    sheets: [
      { sheetName: '견적목록', columns: QUOTE_LIST_COLUMNS, rows: data.quotes },
      { sheetName: '품목상세', columns: QUOTE_ITEM_COLUMNS, rows: data.items },
    ],
  });
}

// ── 대량등록 템플릿(3시트: 견적등록 + 견적품목 + 입력안내) ──
// 실제 견적번호는 시스템 생성 → 입력 대상 아님. Excel 내부 연결은 임시키(TEMP-001…) 사용(§6).
const QUOTE_HEADER_TEMPLATE: TemplateColumn[] = [
  { header: '임시키', required: true, example: 'TEMP-001', note: '필수. 견적품목 시트와 연결하는 임시 키(실제 견적번호 아님, 시스템 자동발번)' },
  { header: '견적서명', required: true, example: '2026 상반기 통역 견적', note: '필수' },
  { header: '견적유형', example: '일반', allowed: ['일반'], note: '이번 단계는 일반견적만 등록(누적/선입금/관계견적 미지원)' },
  { header: '부가세', example: '부가세 10%', allowed: ['부가세 10%', '면세', '영세율'], note: '개별 견적등록과 동일. 미입력 시 부가세 10%. 견적 전체(모든 품목)에 적용' },
  { header: '거래처코드', example: '', note: '(현재 미사용) 사업자등록번호 또는 거래처명으로 연결' },
  { header: '사업자등록번호', example: '123-45-67890', note: '거래처 연결 1순위' },
  { header: '거래처명', example: '(주)베리타스', note: '거래처 연결 2순위(동일명 여러 개면 확인필요)' },
  { header: '담당자명', example: '홍길동', note: '해당 거래처 소속 담당자만(동명이인이면 확인필요)' },
  { header: '담당PM', example: 'pm@veritas.co.kr', note: '이름 또는 이메일. 동명이인이면 이메일로 지정' },
  { header: '견적일', example: '2026-09-09', note: '미입력 시 오늘' },
  { header: '유효기간', example: '2026-10-09', note: '미입력 시 설정 기본값' },
  { header: '메모', example: '' },
];
const QUOTE_ITEM_TEMPLATE: TemplateColumn[] = [
  { header: '임시키', required: true, example: 'TEMP-001', note: '견적등록 시트의 임시키와 일치' },
  { header: '품목순번', required: true, example: '1', note: '동일 견적 내 순번(중복 불가)' },
  { header: '서비스대분류', example: '통역', allowed: ['번역', '통역', '장비', '경비'], note: '금액 계산 유형' },
  { header: '서비스유형', example: '순차통역' },
  { header: '상품코드', example: '', note: '있으면 상품 마스터 정확일치 연결(없는 코드는 확인필요)' },
  { header: '상품명', required: true, example: '순차통역(한↔영)', note: '필수. 상품코드 없으면 상품명으로 연결/커스텀' },
  { header: '출발언어', example: '한국어' },
  { header: '도착언어', example: '영어' },
  { header: '수행시작일', example: '2026-09-20' },
  { header: '수행종료일', example: '2026-09-21' },
  { header: '시작시간', example: '09:00' },
  { header: '종료시간', example: '18:00' },
  { header: '장소', example: '서울 코엑스' },
  { header: '인원', example: '2', note: '통역: 공급가액 = 수량(일수) × 인원 × 단가' },
  { header: '수량', example: '2', note: '통역은 진행일수' },
  { header: '단위', example: '일' },
  { header: '단가', example: '500000', note: '숫자만' },
  { header: '비고', example: '' },
];

/** 견적 대량등록 빈 템플릿 다운로드(견적등록 + 견적품목 + 입력안내). */
export function downloadQuoteTemplate(): void {
  // 공통 downloadTemplate 은 단일 입력시트 기반이라, 2개 입력시트는 각각 안내가 필요하다.
  // 여기서는 대표로 '견적등록' 템플릿(입력안내 포함)을 생성하고, 품목 컬럼 안내는 견적등록 입력안내 하단에 통합한다.
  downloadTemplate({
    filename: 'VERITAS_견적_대량등록_템플릿.xlsx',
    sheetName: '견적등록',
    columns: QUOTE_HEADER_TEMPLATE,
    extraSheets: [{ sheetName: '견적품목', columns: QUOTE_ITEM_TEMPLATE }],
  });
}
