/**
 * VERITAS Quote Excel Export v2
 *
 * 고객 전달 가능 수준의 공식 견적서 Excel을 생성한다.
 * excelKit.ts의 공통 스타일·회사정보를 사용하여 일관된 브랜드를 유지한다.
 *
 * 공통 재사용 함수:
 *   formatServiceDetail(item, products) — 서비스별 상세 문자열 (판매관리 등에서도 재사용)
 *   downloadQuoteExcel(data)            — Excel Blob 생성 + 다운로드 트리거
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import XLSX from 'xlsx-js-style';
import { getPolicy } from './languagePagePolicy';
import type { Product } from './constants';
import { COMPANY_INFO, XC, XST, xBorder } from './excelKit';

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
  quoteId?:    number;
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

// ─── 레이블 매핑 ──────────────────────────────────────────────────────────────

const QUOTE_TYPE_LABEL: Record<string, string> = {
  b2b_standard: '일반 견적서', b2c_prepaid: '선불 (B2C)', accumulated_batch: '누적 배치',
};
const VAT_LABEL: Record<string, string> = {
  taxable: '과세 (10%)', exempt: '면세', zero_rate: '영세율 (0%)',
};
const VAT_PCT: Record<string, string> = {
  taxable: '10%', exempt: '면세', zero_rate: '0%',
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

function validDate(d: string): string {
  if (!d) return '';
  try {
    const dt = new Date(d);
    dt.setDate(dt.getDate() + 30);
    return dt.toISOString().split('T')[0];
  } catch { return ''; }
}

// ─── formatServiceDetail ──────────────────────────────────────────────────────
// 공통 재사용 함수: 서비스별 상세 문자열 생성
// 판매관리 목록 / 프로젝트 목록 / 활동 로그 / 검색결과 등에서 동일 함수 사용

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

// ─── 공급가액 계산 ────────────────────────────────────────────────────────────

function calcSupply(item: ExportItem): number {
  const p    = fmtN(item.unitPrice);
  const q    = Number(item.quantity) || 1;
  const cnt  = item.productType === 'interpretation' ? (Number(item.interpreterCount) || 1) : 1;
  const days = item.productType === 'equipment'      ? (Number(item.usagePeriod)      || 1) : 1;
  return Math.round(days * cnt * q * p);
}

// ─── 컬럼 인덱스 ─────────────────────────────────────────────────────────────
// A(0)=No  B(1)=품목  C(2)=상세내용  D(3)=수량  E(4)=단위  F(5)=단가  G(6)=공급가액  H(7)=비고

const C = { NO: 0, ITEM: 1, DETAIL: 2, QTY: 3, UNIT: 4, PRICE: 5, SUPPLY: 6, MEMO: 7, N: 8 };

// ─── 셀 조작 헬퍼 ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WS  = Record<string, any>;
type Rng = { s: { r: number; c: number }; e: { r: number; c: number } };

function sc(ws: WS, r: number, c: number, v: string | number, s: object, t?: 's' | 'n') {
  ws[XLSX.utils.encode_cell({ r, c })] = { v, s, t: t ?? (typeof v === 'number' ? 'n' : 's') };
}

// 빈 셀에 border만 적용 (merge 안의 나머지 셀에 사용)
function sb(ws: WS, r: number, c: number, border: object) {
  ws[XLSX.utils.encode_cell({ r, c })] = { v: '', t: 's', s: { border } };
}

// merge 등록 + 범위 내 border 셀 채우기
function merge(ws: WS, merges: Rng[], r1: number, c1: number, r2: number, c2: number, borderStyle?: object) {
  merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  if (borderStyle) {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        sb(ws, r, c, borderStyle);
      }
    }
  }
}

// 특정 행의 모든 열에 동일한 스타일 적용 (구분선 행 등)
function fillRow(ws: WS, r: number, cols: number, s: object) {
  for (let c = 0; c < cols; c++) {
    ws[XLSX.utils.encode_cell({ r, c })] = { v: '', t: 's', s };
  }
}

// ─── downloadQuoteExcel ───────────────────────────────────────────────────────

export function downloadQuoteExcel(data: QuoteExportData): void {
  const wb     = XLSX.utils.book_new();
  const ws: WS = {};
  const merges: Rng[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowH: any[] = [];   // ws['!rows'] — row height array

  const setH = (r: number, hpt: number) => { rowH[r] = { hpt }; };
  let r = 0;

  // 견적번호 생성
  const quoteNo = data.quoteId
    ? `QT-${data.issueDate.replace(/-/g, '')}-${String(data.quoteId).padStart(4, '0')}`
    : 'DRAFT';
  const validUntil = validDate(data.issueDate);

  // ── 1. 문서 헤더 ──────────────────────────────────────────────────────────

  // Row 0: VERITAS 브랜드 | 견적서 제목
  setH(r, 36);
  sc(ws, r, C.NO,   COMPANY_INFO.name, XST.brand);
  merge(ws, merges, r, C.NO, r, C.QTY);
  sc(ws, r, C.UNIT, '견  적  서',      XST.docTitle);
  merge(ws, merges, r, C.UNIT, r, C.MEMO);
  r++;

  // Row 1: 태그라인 | QUOTATION (+ 두꺼운 하단 구분선)
  setH(r, 14);
  sc(ws, r, C.NO,   COMPANY_INFO.tagline, XST.tagline);
  merge(ws, merges, r, C.NO, r, C.QTY, xBorder.botMed(XC.border));
  sc(ws, r, C.UNIT, 'QUOTATION',          XST.docSub);
  merge(ws, merges, r, C.UNIT, r, C.MEMO, xBorder.botMed(XC.border));
  r++;

  // ── 2. 기본정보 ───────────────────────────────────────────────────────────

  // 2열 레이아웃: [레이블|값 (A-D)] | [레이블|값 (E-H)]
  const INFO_VAL_BORDER = xBorder.allThin(XC.border);
  const infoRow = (
    row: number,
    lbl1: string, val1: string,
    lbl2: string, val2: string,
  ) => {
    setH(row, 20);
    sc(ws, row, C.NO,    lbl1, XST.infoLbl);
    sc(ws, row, C.ITEM,  val1, XST.infoVal);
    merge(ws, merges, row, C.ITEM, row, C.QTY, INFO_VAL_BORDER);
    sc(ws, row, C.UNIT,  lbl2, XST.infoLbl);
    sc(ws, row, C.PRICE, val2, XST.infoVal);
    merge(ws, merges, row, C.PRICE, row, C.MEMO, INFO_VAL_BORDER);
  };

  infoRow(r, '수  신', data.companyName || '-', '견적번호', quoteNo);     r++;
  infoRow(r, '담당자', data.contactName || '-', '견적일',   data.issueDate); r++;
  infoRow(r, '담당 PM', data.pmName    || '-', '유효기간', validUntil || '-'); r++;
  infoRow(r, '견적유형', QUOTE_TYPE_LABEL[data.quoteType] ?? data.quoteType,
             '부가세',  VAT_LABEL[data.vatType] ?? data.vatType); r++;

  // 스페이서
  setH(r, 10);
  r++;

  // ── 3. 상품 테이블 ────────────────────────────────────────────────────────

  // 3-1. 헤더 행
  setH(r, 22);
  sc(ws, r, C.NO,     'No',      XST.thC);
  sc(ws, r, C.ITEM,   '품목',    XST.thL);
  sc(ws, r, C.DETAIL, '상세내용', XST.thL);
  sc(ws, r, C.QTY,    '수량',    XST.thR);
  sc(ws, r, C.UNIT,   '단위',    XST.thC);
  sc(ws, r, C.PRICE,  '단가',    XST.thR);
  sc(ws, r, C.SUPPLY, '공급가액', XST.thR);
  sc(ws, r, C.MEMO,   '비고',    XST.thL);
  r++;

  // 3-2. 데이터 행
  data.items.forEach((item, idx) => {
    const supply = calcSupply(item);
    const detail = formatServiceDetail(item, data.products);
    setH(r, 20);
    sc(ws, r, C.NO,     idx + 1,                                        XST.tdC, 'n');
    sc(ws, r, C.ITEM,   item.productName || '-',                        XST.td);
    sc(ws, r, C.DETAIL, detail,                                         XST.td);
    sc(ws, r, C.QTY,    Number(item.quantity) || 1,                     XST.tdNum, 'n');
    sc(ws, r, C.UNIT,   item.unit || '-',                               XST.tdC);
    sc(ws, r, C.PRICE,  fmtN(item.unitPrice),                           XST.tdNum, 'n');
    sc(ws, r, C.SUPPLY, supply,                                         XST.tdNum, 'n');
    sc(ws, r, C.MEMO,   item.memo || '',                                XST.td);
    r++;
  });

  // ── 4. 금액 요약 ──────────────────────────────────────────────────────────
  // 단가(F=5) 열: 레이블 / 공급가액(G=6) 열: 금액 — 재무 컬럼 수직 정렬

  setH(r, 8);
  r++; // 스페이서

  const vatPctStr = VAT_PCT[data.vatType] ?? '';

  const summaryRows: [string, number, object, object][] = [
    [`공급가액 합계`,      data.totals.supply, XST.sumLbl,   XST.sumVal],
    [`부가세 ${vatPctStr}`, data.totals.tax,   XST.sumLbl,   XST.sumVal],
    [`총  견적금액`,        data.totals.total, XST.totalLbl, XST.totalVal],
  ];
  for (const [lbl, val, ls, vs] of summaryRows) {
    setH(r, lbl.startsWith('총') ? 26 : 20);
    // A-E: 빈 셀 (no border)
    sc(ws, r, C.PRICE,  lbl, ls);
    sc(ws, r, C.SUPPLY, val, vs, 'n');
    // H: empty with no style
    r++;
  }

  // ── 5. 비고 ───────────────────────────────────────────────────────────────

  if (data.note && data.note.trim()) {
    setH(r, 8);
    r++; // 스페이서

    setH(r, 18);
    sc(ws, r, C.NO, '비  고', XST.secLbl);
    merge(ws, merges, r, C.NO, r, C.MEMO, xBorder.allThin(XC.border));
    r++;

    setH(r, 54);
    sc(ws, r, C.NO, data.note, XST.noteVal);
    merge(ws, merges, r, C.NO, r, C.MEMO, xBorder.allThin(XC.borderLt));
    r++;
  }

  // ── 6. 회사정보 Footer ─────────────────────────────────────────────────────

  setH(r, 10);
  r++; // 스페이서

  setH(r, 4);
  fillRow(ws, r, C.N, { border: xBorder.topMed(XC.border) });
  r++;

  const footerStr = [
    COMPANY_INFO.name,
    `주소: ${COMPANY_INFO.addr}`,
    `전화: ${COMPANY_INFO.tel}`,
    `이메일: ${COMPANY_INFO.email}`,
    `홈페이지: ${COMPANY_INFO.web}`,
    `사업자번호: ${COMPANY_INFO.bizNo}`,
  ].join('  |  ');
  setH(r, 16);
  sc(ws, r, C.NO, footerStr, XST.footer);
  merge(ws, merges, r, C.NO, r, C.MEMO);
  r++;

  // ── 시트 설정 ─────────────────────────────────────────────────────────────

  ws['!ref']    = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: C.MEMO } });
  ws['!merges'] = merges;
  ws['!rows']   = rowH;

  // 컬럼 너비 — A4 세로 기준 최적화
  ws['!cols'] = [
    { wch:  5 }, // A: No
    { wch: 24 }, // B: 품목
    { wch: 36 }, // C: 상세내용 (가장 넓게)
    { wch:  7 }, // D: 수량
    { wch:  7 }, // E: 단위
    { wch: 14 }, // F: 단가
    { wch: 14 }, // G: 공급가액
    { wch: 20 }, // H: 비고
  ];

  // 인쇄 설정: A4 세로, 여백 최소화, 1페이지 폭 맞춤
  ws['!pageSetup'] = {
    paperSize:   9,    // A4
    orientation: 'portrait',
    fitToPage:   true,
    fitToWidth:  1,
    fitToHeight: 0,
    scale:       90,
  };
  ws['!margins'] = { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };

  XLSX.utils.book_append_sheet(wb, ws, '견적서');

  // 파일명: VERITAS_견적서_견적명_견적일.xlsx
  const safeName = (data.title || '견적').replace(/[\\/:*?"<>|\s]+/g, '_');
  XLSX.writeFile(wb, `VERITAS_견적서_${safeName}_${data.issueDate}.xlsx`);
}
