/**
 * VERITAS Quote Excel Export v1
 *
 * 내부 관리용 Excel — 견적 기본정보 + 혼합 서비스 상품정보 + 금액 요약
 * 서비스 유형별 상세는 "서비스별 상세" 단일 컬럼에 텍스트로 조합하여 출력
 *
 * 재사용 가능한 공통 함수:
 *   formatServiceDetail(item, products) — 서비스별 상세 문자열 생성
 *   downloadQuoteExcel(data)            — Excel Blob 생성 + 다운로드
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — xlsx-js-style has no bundled declaration file; types via @types/xlsx
import XLSX from 'xlsx-js-style';
import { getPolicy } from './languagePagePolicy';
import type { Product } from './constants';

// ── 공통 ExportItem 타입 ─────────────────────────────────────────────────────
// QuoteItemForm과 구조적으로 호환 — lib → component 역방향 import 방지

export interface ExportItem {
  productId:        number | null;
  productName:      string;
  productType:      string;
  quantity:         string;
  unit:             string;
  unitPrice:        string;
  memo:             string;
  // 번역
  sourceLanguage:   string;
  fileName:         string;
  fileFormat:       string;
  wordCount:        string;
  charCount:        string;
  // 통역
  interpretDate:    string;
  interpretEndDate: string;
  startTime:        string;
  endTime:          string;
  interpretPlace:   string;
  interpreterCount: string;
  // 장비
  eventStartDate:   string;
  eventEndDate:     string;
  itemLocation:     string;
  usagePeriod:      string;
  // 기타
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

// ── 레이블 매핑 ───────────────────────────────────────────────────────────────

const QUOTE_TYPE_LABEL: Record<string, string> = {
  b2b_standard:      '일반 견적서',
  b2c_prepaid:       '선불 (B2C)',
  accumulated_batch: '누적 배치',
};
const VAT_LABEL: Record<string, string> = {
  taxable:   '10% (과세)',
  exempt:    '면세',
  zero_rate: '영세율 (0%)',
};
const SVC_LABEL: Record<string, string> = {
  translation:    '번역',
  interpretation: '통역',
  equipment:      '장비',
  expense:        '기타',
};

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────

function getLangName(code: string | null | undefined): string {
  if (!code) return '';
  return getPolicy(code)?.languageName ?? code;
}

function fmtN(v: string): number {
  return Number(String(v).replace(/,/g, '')) || 0;
}

// ── formatServiceDetail ───────────────────────────────────────────────────────
// 서비스 유형별 상세 문자열 생성 — 빈 값 자동 제외, " / " 구분자
// 향후 판매관리 목록 / 프로젝트 목록 / 활동 로그 등에서 동일 함수 재사용

export function formatServiceDetail(item: ExportItem, products: Product[]): string {
  const parts: string[] = [];

  switch (item.productType) {
    case 'translation': {
      // 언어쌍: 상품 Master의 sourceLanguage / targetLanguage 기준
      const prod = item.productId != null
        ? products.find(p => p.id === item.productId) ?? null
        : null;
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
      if (item.interpretDate) {
        parts.push(item.interpretEndDate
          ? `${item.interpretDate}~${item.interpretEndDate}`
          : item.interpretDate);
      }
      const time = [item.startTime, item.endTime].filter(Boolean).join('~');
      if (time) parts.push(time);
      if (item.interpretPlace) parts.push(item.interpretPlace);
      const cnt = fmtN(item.interpreterCount);
      if (cnt > 0) parts.push(`${cnt}명`);
      break;
    }
    case 'equipment': {
      if (item.eventStartDate) {
        parts.push(item.eventEndDate
          ? `${item.eventStartDate}~${item.eventEndDate}`
          : item.eventStartDate);
      }
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

// ── 공급가액 계산 ─────────────────────────────────────────────────────────────
// calcItem()과 동일 로직 — 통역: 투입인원×수량×단가, 장비: 사용일수×수량×단가

function calcItemSupply(item: ExportItem): number {
  const p    = fmtN(item.unitPrice);
  const q    = Number(item.quantity) || 1;
  const cnt  = item.productType === 'interpretation' ? (Number(item.interpreterCount) || 1) : 1;
  const days = item.productType === 'equipment'      ? (Number(item.usagePeriod)      || 1) : 1;
  return Math.round(days * cnt * q * p);
}

// ── Excel 스타일 정의 ─────────────────────────────────────────────────────────

const ST = {
  infoKey:  { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F9FAFB' } } },
  infoVal:  { font: { sz: 10 } },
  colHC:    { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'center', vertical: 'center' } },
  colHR:    { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'right',  vertical: 'center' } },
  colHL:    { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'left',   vertical: 'center' } },
  data:     { font: { sz: 10 }, alignment: { vertical: 'center' } },
  dataC:    { font: { sz: 10 }, alignment: { horizontal: 'center', vertical: 'center' } },
  dataNum:  { font: { sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } },
  dataTxt:  { font: { sz: 10 }, alignment: { vertical: 'center', wrapText: true } },
  sumKey:   { font: { bold: true, sz: 10 }, alignment: { horizontal: 'right' } },
  sumVal:   { font: { bold: true, sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right' } },
  totalKey: { font: { bold: true, sz: 11 }, fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } }, alignment: { horizontal: 'right' } },
  totalVal: { font: { bold: true, sz: 11 }, numFmt: '#,##0', fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } }, alignment: { horizontal: 'right' } },
};

// 컬럼 인덱스 (A=0 … I=8)
const COL = { NO: 0, TYPE: 1, PRODUCT: 2, DETAIL: 3, QTY: 4, UNIT: 5, PRICE: 6, SUPPLY: 7, MEMO: 8 };
const TOTAL_COLS = 9;

// ── downloadQuoteExcel ───────────────────────────────────────────────────────

export function downloadQuoteExcel(data: QuoteExportData): void {
  const wb = XLSX.utils.book_new();
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
    sc(r, 0, k, ST.infoKey);
    sc(r, 1, v, ST.infoVal);
    r++;
  }

  r++; // 빈 행 구분

  // ── B. 상품정보 헤더 ────────────────────────────────────────────────────────

  const headers = ['No', '유형', '상품', '서비스별 상세', '수량', '단위', '단가', '공급가액', '비고'];
  const hSt     = [ST.colHC, ST.colHC, ST.colHL, ST.colHL, ST.colHR, ST.colHC, ST.colHR, ST.colHR, ST.colHL];
  headers.forEach((h, c) => sc(r, c, h, hSt[c]));
  r++;

  // ── B. 상품정보 데이터 ──────────────────────────────────────────────────────

  data.items.forEach((item, idx) => {
    const supply = calcItemSupply(item);
    const detail = formatServiceDetail(item, data.products);

    sc(r, COL.NO,      idx + 1,                              ST.dataC,   'n');
    sc(r, COL.TYPE,    SVC_LABEL[item.productType] ?? item.productType, ST.data);
    sc(r, COL.PRODUCT, item.productName || '-',              ST.data);
    sc(r, COL.DETAIL,  detail,                               ST.dataTxt);
    sc(r, COL.QTY,     Number(item.quantity) || 1,           ST.dataNum, 'n');
    sc(r, COL.UNIT,    item.unit || '-',                     ST.dataC);
    sc(r, COL.PRICE,   fmtN(item.unitPrice),                 ST.dataNum, 'n');
    sc(r, COL.SUPPLY,  supply,                               ST.dataNum, 'n');
    sc(r, COL.MEMO,    item.memo || '',                      ST.dataTxt);
    r++;
  });

  r++; // 빈 행 구분

  // ── C. 금액 요약 ────────────────────────────────────────────────────────────
  // 단가 컬럼(6)에 레이블, 공급가액 컬럼(7)에 금액 — 재무 컬럼과 수직 정렬

  const summaryRows: [string, number, object, object][] = [
    ['공급가액 합계', data.totals.supply, ST.sumKey,   ST.sumVal],
    ['부가세',        data.totals.tax,    ST.sumKey,   ST.sumVal],
    ['총 견적금액',   data.totals.total,  ST.totalKey, ST.totalVal],
  ];
  for (const [k, v, ks, vs] of summaryRows) {
    sc(r, COL.PRICE,  k, ks);
    sc(r, COL.SUPPLY, v, vs, 'n');
    r++;
  }

  // 비고 (견적 전체 비고)
  if (data.note) {
    r++;
    sc(r, 0, '비고', ST.infoKey);
    sc(r, 1, data.note, ST.infoVal);
    r++;
  }

  // ── 시트 범위 · 컬럼 너비 ──────────────────────────────────────────────────

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: TOTAL_COLS - 1 } });
  ws['!cols'] = [
    { wch: 12 }, // A: No / 기본정보 레이블
    { wch: 28 }, // B: 유형 / 기본정보 값
    { wch: 22 }, // C: 상품
    { wch: 54 }, // D: 서비스별 상세 (넓게)
    { wch:  7 }, // E: 수량
    { wch:  7 }, // F: 단위
    { wch: 15 }, // G: 단가
    { wch: 15 }, // H: 공급가액
    { wch: 32 }, // I: 비고 (넓게)
  ];

  XLSX.utils.book_append_sheet(wb, ws, '견적관리');

  // ── 파일명: VERITAS_견적관리_견적명_견적일.xlsx ──────────────────────────────

  const safeName = (data.title || '견적').replace(/[\\/:*?"<>|\s]+/g, '_');
  XLSX.writeFile(wb, `VERITAS_견적관리_${safeName}_${data.issueDate}.xlsx`);
}
