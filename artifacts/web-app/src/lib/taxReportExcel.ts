/**
 * VERITAS 세무자료(세무사 제출용 지급자료) Excel Export.
 *
 * 조회 전용 유틸(계산 없음). 서버(/api/admin/tax-report)가 산출한 행을 그대로 출력한다.
 *  · 컬럼: 지급일 | 통역사명 | 주민번호 | 언어 | 교통비 | 지급액(세전) | 지급액(세후) | 해외 현지 송금건 | 비고
 *  · 지급일=Excel 날짜값(yyyy-mm-dd), 금액=실제 숫자셀(#,##0 천단위). 헤더강조·테두리·자동필터·열너비 정리.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import XLSX from 'xlsx-js-style';
import { formatTaxTreatment } from './taxTreatmentDisplay';

export interface TaxReportRow {
  payDate: string | null;         // YYYY-MM-DD
  payeeName: string;
  residentNumber: string | null;      // 전체값(권한+reveal 시)
  residentNumberMasked: string | null; // 마스킹값
  language: string | null;
  transport: number;
  pretax: number | null;
  posttax: number | null;
  overseasAmount: number | null;
  note: string | null;
  // 10차 §4 — 세금 컬럼(서버 신규 필드, 확정 스냅샷 SSOT 우선)
  roundName?: string | null;               // 지급회차
  withholdingTreatment?: string | null;    // 세금처리 enum
  withholdingRate?: number | null;         // 원천세율(%)
  withholdingTax?: number | null;          // 원천세액
  ssotSource?: string | null;              // 'snapshot' | 'live'
}

// 원천세율 — 서버 확정값(withholdingRate) 우선, 없으면 국내 정률(3.3/2.2)에서 도출. exempt=0, 그 외 미확정=blank.
const RATE_BY_TREATMENT: Record<string, number> = { domestic_3_3: 3.3, domestic_2_2: 2.2, exempt: 0 };
function resolveRate(row: TaxReportRow): number | null {
  if (row.withholdingRate != null && Number.isFinite(row.withholdingRate)) return Number(row.withholdingRate);
  const t = row.withholdingTreatment ?? '';
  return t in RATE_BY_TREATMENT ? RATE_BY_TREATMENT[t] : null;
}

// 주민등록번호 표시 — 세무사 제출용(전체 표시). DB 원본 불변, 출력 시에만 정규화(§6).
//   숫자만 추출 → 정확히 13자리면 YYMMDD-XXXXXXX, 그 외(마스킹/비정상 길이)는 원본 그대로(임의 보정 금지).
//   반드시 TEXT cell 로 출력해 앞자리 0 보존·지수표기 방지.
function formatResidentNumber(full: string | null | undefined, masked: string | null | undefined): string {
  const src = (full ?? masked ?? '').trim();
  if (!src) return '';
  const digits = src.replace(/[^0-9]/g, '');
  if (digits.length === 13) return `${digits.slice(0, 6)}-${digits.slice(6)}`;
  return src;   // 마스킹(하이픈 포함)·복호실패·비정상 길이 → 원본 유지
}

const BRAND = '1E3A5F';
const BORDER_THIN = { style: 'thin', color: { rgb: 'D1D5DB' } };
const BORDER_ALL = { top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN };
const HEADER = { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: BRAND } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: BORDER_ALL };
const TEXT = { font: { sz: 10 }, alignment: { vertical: 'center', wrapText: true }, border: BORDER_ALL };
const TEXT_C = { font: { sz: 10 }, alignment: { horizontal: 'center', vertical: 'center' }, border: BORDER_ALL };
const NUM = { font: { sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' }, border: BORDER_ALL };
const NUM_RATE = { font: { sz: 10 }, numFmt: '0.0', alignment: { horizontal: 'right', vertical: 'center' }, border: BORDER_ALL };
const DATEC = { font: { sz: 10 }, numFmt: 'yyyy-mm-dd', alignment: { horizontal: 'center', vertical: 'center' }, border: BORDER_ALL };

// 'YYYY-MM-DD' → Excel 날짜 시리얼(1899-12-30 기준). 실제 날짜값이라 정렬·필터 가능.
function excelSerial(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000 + 25569;
}

export function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

const COLUMNS: { header: string; width: number }[] = [
  { header: '지급일', width: 13 },
  { header: '지급회차', width: 16 },
  { header: '통역사명', width: 14 },
  { header: '주민번호', width: 17 },
  { header: '언어', width: 16 },
  { header: '지급액(세전)', width: 14 },
  { header: '세금처리', width: 14 },
  { header: '원천세율', width: 9 },
  { header: '원천세액', width: 13 },
  { header: '지급액(세후)', width: 14 },
  { header: '해외 현지 송금건', width: 16 },
  { header: '비고', width: 30 },
];

export function downloadTaxReportExcel(opts: { filename: string; rows: TaxReportRow[]; masked: boolean }): void {
  const { filename, rows } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {};
  const put = (r: number, c: number, cell: any) => { ws[XLSX.utils.encode_cell({ r, c })] = cell; };

  // 헤더
  COLUMNS.forEach((col, c) => put(0, c, { v: col.header, t: 's', s: HEADER }));

  // 데이터 — 세금처리/원천세율/원천세액은 확정 스냅샷 SSOT 기준(서버). 세금처리 표시는 공용 formatter(개인 세무자료).
  rows.forEach((row, ri) => {
    const r = ri + 1;
    // 0 지급일 — 실제 날짜셀(값 없으면 빈칸)
    if (row.payDate) put(r, 0, { v: excelSerial(row.payDate), t: 'n', s: DATEC });
    else put(r, 0, { v: '', t: 's', s: TEXT_C });
    put(r, 1, { v: row.roundName ?? '', t: 's', s: TEXT_C });   // 지급회차
    put(r, 2, { v: row.payeeName ?? '', t: 's', s: TEXT });
    // 3 주민번호 — 전체번호 YYMMDD-XXXXXXX(세무사 제출용). TEXT 저장(앞자리 0 보존·지수표기 방지). DB 원본 불변.
    put(r, 3, { v: formatResidentNumber(row.residentNumber, row.residentNumberMasked), t: 's', s: TEXT_C });
    put(r, 4, { v: row.language ?? '', t: 's', s: TEXT });
    // 5 지급액(세전) / 9 지급액(세후) — 국내만 값, 해외는 빈칸(값은 10 '해외 현지 송금건'에)
    if (row.pretax != null) put(r, 5, { v: Math.round(row.pretax), t: 'n', s: NUM }); else put(r, 5, { v: '', t: 's', s: TEXT_C });
    // 6 세금처리(공용 formatter · 개인) / 7 원천세율 / 8 원천세액
    put(r, 6, { v: formatTaxTreatment({ payeeType: 'individual', withholdingTreatment: row.withholdingTreatment, withholdingRate: row.withholdingRate }), t: 's', s: TEXT_C });
    const rate = resolveRate(row);
    if (rate != null) put(r, 7, { v: rate, t: 'n', s: NUM_RATE }); else put(r, 7, { v: '', t: 's', s: TEXT_C });
    if (row.withholdingTax != null) put(r, 8, { v: Math.round(row.withholdingTax), t: 'n', s: NUM }); else put(r, 8, { v: '', t: 's', s: TEXT_C });
    if (row.posttax != null) put(r, 9, { v: Math.round(row.posttax), t: 'n', s: NUM }); else put(r, 9, { v: '', t: 's', s: TEXT_C });
    if (row.overseasAmount != null) put(r, 10, { v: Math.round(row.overseasAmount), t: 'n', s: NUM }); else put(r, 10, { v: '', t: 's', s: TEXT_C });
    put(r, 11, { v: row.note ?? '', t: 's', s: TEXT });
  });

  const lastRow = rows.length;   // header=0, data=1..rows.length
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(lastRow, 0), c: COLUMNS.length - 1 } });
  ws['!cols'] = COLUMNS.map((col) => ({ wch: col.width }));
  ws['!rows'] = [{ hpt: 22 }];   // 헤더 행 높이
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(lastRow, 0), c: COLUMNS.length - 1 } }) };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '세무자료');
  XLSX.writeFile(wb, filename);
}
