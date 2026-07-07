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
import type { Product } from './constants';

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
      if (item.interpretDate) {
        parts.push(item.interpretEndDate
          ? `${item.interpretDate}~${item.interpretEndDate}`
          : item.interpretDate);
      }
      const time = [item.startTime, item.endTime].filter(Boolean).join('~');
      if (time) parts.push(time);
      if (item.interpretPlace)  parts.push(item.interpretPlace);
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

// ─── 공급가액 계산 ────────────────────────────────────────────────────────────

function calcSupply(item: ExportItem): number {
  const p    = fmtN(item.unitPrice);
  const q    = Number(item.quantity) || 1;
  const cnt  = item.productType === 'interpretation' ? (Number(item.interpreterCount) || 1) : 1;
  const days = item.productType === 'equipment'      ? (Number(item.usagePeriod)      || 1) : 1;
  return Math.round(days * cnt * q * p);
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
    sc(r, COL.QTY,     Number(item.quantity) || 1,           S.tdNum, 'n');
    sc(r, COL.UNIT,    item.unit || '-',                     S.tdC);
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
