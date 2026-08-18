/**
 * VERITAS 정산(지급회차) Excel Export — 조회 결과 표를 그대로 .xlsx 로 출력.
 *
 * 조회 전용 유틸(계산 없음). 화면(PayoutRoundsTab)에서 필터·라벨을 이미 적용한
 * 표 데이터를 넘겨주면, 컬럼 정의대로 헤더 굵게·금액 천단위 서식·컬럼폭 자동 조정한
 * 단일 시트 통합문서를 만들어 브라우저 다운로드한다.
 *
 * · 첫 행 = 컬럼명(굵게) · 금액 = 숫자 서식(#,##0) · 날짜/텍스트는 문자 그대로.
 * · 한글 깨짐 방지를 위해 xlsx-js-style 의 writeFile(.xlsx, UTF-8)만 사용한다.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import XLSX from 'xlsx-js-style';

export type ExcelCellType = 'text' | 'number';
export interface ExcelColumn {
  header: string;
  type?: ExcelCellType; // 기본 'text' — 'number'만 숫자 서식(#,##0) 적용
  width?: number;       // wch 지정(생략 시 내용 기준 자동)
}
export type ExcelCell = string | number | null | undefined;

// quoteExcel.ts 와 동일한 서식 기준(헤더 회색 F3F4F6·굵게 / 금액 #,##0 우측정렬).
const HEADER_STYLE = {
  font: { bold: true, sz: 10 },
  fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
};
const TEXT_STYLE = { font: { sz: 10 }, alignment: { vertical: 'center' } };
const NUM_STYLE = { font: { sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } };

// 컬럼폭 자동 계산용 표시폭(한글·전각은 2, 그 외 1).
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2000 ? 2 : 1;
  return w;
}

/**
 * 표 데이터를 단일 시트 .xlsx 로 생성·다운로드.
 * @param filename 저장 파일명(확장자 포함, 예: 지급대상별요약_20260813.xlsx)
 */
export function downloadTableExcel(opts: {
  filename: string;
  sheetName: string;
  columns: ExcelColumn[];
  rows: ExcelCell[][];
}): void {
  const { filename, sheetName, columns, rows } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {};

  // 헤더 행
  columns.forEach((col, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: col.header, t: 's', s: HEADER_STYLE };
  });

  // 데이터 행 — number 컬럼이고 실제 숫자면 숫자셀(서식), 아니면 문자셀.
  rows.forEach((row, ri) => {
    columns.forEach((col, c) => {
      const raw = row[c];
      const addr = XLSX.utils.encode_cell({ r: ri + 1, c });
      if (col.type === 'number' && typeof raw === 'number' && Number.isFinite(raw)) {
        ws[addr] = { v: raw, t: 'n', s: NUM_STYLE };
      } else {
        ws[addr] = { v: raw == null ? '' : String(raw), t: 's', s: TEXT_STYLE };
      }
    });
  });

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: Math.max(columns.length - 1, 0) } });
  ws['!cols'] = columns.map((col, c) => {
    if (col.width) return { wch: col.width };
    let max = displayWidth(col.header);
    for (const row of rows) {
      const v = row[c];
      const text = v == null ? '' : typeof v === 'number' ? Math.round(v).toLocaleString('ko-KR') : String(v);
      const len = displayWidth(text);
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 8), 42) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

// 파일명용 오늘 날짜 YYYYMMDD (로컬/KST 표시 기준).
export function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// ── 지급명세서 전용 서식(제목·기본정보 블록·브랜드 헤더·합계·최종 강조) ─────────────────
const BRAND = '1E3A5F';   // VERITAS 브랜드(진청) — 화면/PDF 톤과 일치
const TITLE_STYLE = { font: { bold: true, sz: 15, color: { rgb: BRAND } }, alignment: { vertical: 'center' } };
const INFO_KEY = { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { vertical: 'center' } };
const INFO_VAL = { font: { sz: 10 }, alignment: { vertical: 'center', wrapText: true } };
// 표 헤더 — 브랜드 배경 + 흰색 굵게(강조).
const STH_L = { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: BRAND } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: true } };
const STH_R = { ...STH_L, alignment: { horizontal: 'right', vertical: 'center', wrapText: true } };
// 데이터 셀 — 텍스트 줄바꿈 허용 / 숫자 우측정렬·천단위.
const DATA_TEXT = { font: { sz: 10 }, alignment: { vertical: 'center', wrapText: true } };
const DATA_NUM = { font: { sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } };
// 합계행(컬럼 정렬).
const TOT_LBL = { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } }, alignment: { horizontal: 'right', vertical: 'center' } };
const TOT_NUM = { font: { bold: true, sz: 10 }, numFmt: '#,##0', fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } }, alignment: { horizontal: 'right', vertical: 'center' } };
const TOT_BLANK = { fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } } };
// 하단 라벨형 합계.
const FOOT_LBL = { font: { bold: true, sz: 10 }, fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'right', vertical: 'center' } };
const FOOT_NUM = { font: { bold: true, sz: 10 }, numFmt: '#,##0', fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } }, alignment: { horizontal: 'right', vertical: 'center' } };
// 최종 실지급액 — 브랜드 강조(가장 명확).
const FINAL_LBL = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: BRAND } }, alignment: { horizontal: 'right', vertical: 'center' } };
const FINAL_NUM = { font: { bold: true, sz: 12, color: { rgb: 'FFFFFF' } }, numFmt: '#,##0', fill: { patternType: 'solid', fgColor: { rgb: BRAND } }, alignment: { horizontal: 'right', vertical: 'center' } };

/**
 * 지급명세서(수행자 1인)를 단일 시트 .xlsx 로 생성·다운로드.
 * 화면과 동일한 항목·금액을 그대로 출력(별도 계산 없음). 상세내역 금액은 서버 확정값이다.
 *  · 상단: 제목 + 기본정보(지급대상자/이메일/구분/지급회차/지급일)
 *  · 중단: 상세내역 표(columns/rows) — 브랜드 헤더 · 금액 우측정렬 · 텍스트 줄바꿈
 *  · 하단: 합계행(totals — columns 정렬) + 라벨형 합계(footerRows, 최종 실지급액 강조)
 */
export function downloadStatementExcel(opts: {
  filename: string;
  sheetName: string;
  title: string;
  info: [string, string][];
  columns: ExcelColumn[];
  rows: ExcelCell[][];
  totals: ExcelCell[];
  footerRows?: [string, ExcelCell][];   // 표 컬럼이 아닌 합계(공제액·최종 실지급액 등) — 우측하단 라벨:값
}): void {
  const { filename, sheetName, title, info, columns, rows, totals, footerRows = [] } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {};
  const ncols = Math.max(columns.length, 2);
  const put = (row: number, col: number, v: ExcelCell, s: object, t?: 's' | 'n') => {
    ws[XLSX.utils.encode_cell({ r: row, c: col })] = { v: v == null ? '' : v, s, t: t ?? (typeof v === 'number' ? 'n' : 's') };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowHeights: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merges: any[] = [];
  let r = 0;
  put(r, 0, title, TITLE_STYLE); rowHeights[r] = { hpt: 24 }; r += 2;
  for (const [k, v] of info) { put(r, 0, k, INFO_KEY); put(r, 1, v ?? '', INFO_VAL); rowHeights[r] = { hpt: 17 }; r++; }
  r++; // 빈 행
  const headerRow = r;
  columns.forEach((c, i) => put(headerRow, i, c.header, c.type === 'number' ? STH_R : STH_L));
  rowHeights[headerRow] = { hpt: 22 };
  r++;
  for (const row of rows) {
    columns.forEach((c, i) => {
      const raw = row[i];
      if (c.type === 'number' && typeof raw === 'number' && Number.isFinite(raw)) put(r, i, raw, DATA_NUM, 'n');
      else put(r, i, raw == null ? '' : String(raw), DATA_TEXT, 's');
    });
    rowHeights[r] = { hpt: 16 };
    r++;
  }
  // 합계행(컬럼 정렬 — 기본수행료/추가비용/차감/세전 등)
  columns.forEach((c, i) => {
    const raw = totals[i];
    if (raw == null || raw === '') { put(r, i, '', TOT_BLANK, 's'); return; }
    if (c.type === 'number' && typeof raw === 'number') put(r, i, raw, TOT_NUM, 'n');
    else put(r, i, String(raw), TOT_LBL, 's');
  });
  rowHeights[r] = { hpt: 18 };
  r++;
  // 추가 합계행(공제액·최종 실지급액 등) — 우측하단에 라벨:값. 마지막 행(최종 실지급액)은 브랜드 강조.
  //  · 라벨('최종 실지급액' 등 한글)은 단일 열 폭이 부족해 잘리므로 라벨 셀만 좌측 2개 열을 병합해
  //    폭을 확보한다(우측정렬 → 라벨 오른쪽 끝 위치·값 셀은 그대로). 건별 표/숫자 열 폭은 불변.
  const lblStart = Math.max(0, ncols - 3);   // 라벨 병합 시작 열(값 왼쪽 2개 열)
  footerRows.forEach(([label, value], i) => {
    const isFinal = i === footerRows.length - 1;
    put(r, lblStart, label, isFinal ? FINAL_LBL : FOOT_LBL, 's');
    put(r, ncols - 2, '', isFinal ? FINAL_LBL : FOOT_LBL, 's');   // 병합 우측 셀 — 배경 연속(값 아님)
    merges.push({ s: { r, c: lblStart }, e: { r, c: ncols - 2 } });
    if (typeof value === 'number') put(r, ncols - 1, value, isFinal ? FINAL_NUM : FOOT_NUM, 'n');
    else put(r, ncols - 1, value == null ? '' : String(value), isFinal ? FINAL_LBL : FOOT_LBL, 's');
    rowHeights[r] = { hpt: isFinal ? 22 : 18 };
    r++;
  });

  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: ncols - 1 } });
  ws['!rows'] = rowHeights;
  if (merges.length) ws['!merges'] = merges;
  ws['!cols'] = columns.map((col, c) => {
    if (col.width) return { wch: col.width };
    let max = displayWidth(col.header);
    // 기본정보 블록도 A·B 열 폭에 반영
    if (c === 0) for (const [k] of info) max = Math.max(max, displayWidth(k));
    if (c === 1) for (const [, v] of info) max = Math.max(max, displayWidth(String(v ?? '')));
    for (const row of [...rows, totals]) {
      const v = row[c];
      const text = v == null ? '' : typeof v === 'number' ? Math.round(v).toLocaleString('ko-KR') : String(v);
      max = Math.max(max, displayWidth(text));
    }
    return { wch: Math.min(Math.max(max + 2, 8), 46) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}
