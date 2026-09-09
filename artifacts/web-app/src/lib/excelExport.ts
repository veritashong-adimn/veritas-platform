/**
 * VERITAS 공통 Excel Export/Template Engine
 * ────────────────────────────────────────────────────────────────────────
 * 각 화면이 xlsx 파일 전체를 직접 만들지 않고, dataset + column 정의만 넘기면
 * 공통 규칙(헤더 스타일·autofilter·컬럼폭·숫자 #,##0·날짜 yyyy.mm.dd·빈셀)으로
 * .xlsx 를 생성·다운로드한다. 거래처를 시작으로 담당자/견적/판매/정산 등에서 재사용한다.
 *
 * · 숫자 컬럼(type:'number')  → 실제 숫자 셀(#,##0)
 * · 날짜 컬럼(type:'date')    → 실제 날짜 셀(yyyy.mm.dd). "1,000원" 같은 문자열 저장 금지.
 * · null/undefined           → 빈 셀
 * · 헤더 굵게 + autofilter + 상단 고정(freeze) best-effort
 *
 * 기존 payoutExcel.ts(정산 전용) 는 그대로 두고, 범용 엔진은 이 파일로 분리한다.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import XLSX from 'xlsx-js-style';

export type ExcelCellType = 'text' | 'number' | 'date';

export interface ExcelColumn<Row = Record<string, unknown>> {
  /** 헤더에 표시될 컬럼명 */
  header: string;
  /** row 에서 값을 뽑는 키 또는 함수 */
  value: keyof Row | ((row: Row) => unknown);
  type?: ExcelCellType; // 기본 'text'
  width?: number;       // wch(생략 시 내용 기준 자동)
}

const HEADER_STYLE = {
  font: { bold: true, sz: 10 },
  fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
};
const TEXT_STYLE = { font: { sz: 10 }, alignment: { vertical: 'center' } };
const NUM_STYLE = { font: { sz: 10 }, numFmt: '#,##0', alignment: { horizontal: 'right', vertical: 'center' } };
const DATE_STYLE = { font: { sz: 10 }, numFmt: 'yyyy.mm.dd', alignment: { horizontal: 'center', vertical: 'center' } };

// 컬럼폭 자동 계산용 표시폭(한글·전각은 2, 그 외 1).
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2000 ? 2 : 1;
  return w;
}

/** 문자열/Date → Date(유효할 때만). "2024-01-31" · "2024.01.31" · "20240131" · Date 지원. */
function toDate(v: unknown): Date | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 이미 엑셀 시리얼이 아닌 timestamp(ms)로 오면 Date 로. (사용처는 문자열 위주)
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const digits = v.replace(/[^\d]/g, '');
    if (/^\d{8}$/.test(digits)) {
      const y = +digits.slice(0, 4), m = +digits.slice(4, 6), d = +digits.slice(6, 8);
      const dt = new Date(y, m - 1, d);
      return isNaN(dt.getTime()) ? null : dt;
    }
    const dt = new Date(v);
    return isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function resolveValue<Row>(col: ExcelColumn<Row>, row: Row): unknown {
  return typeof col.value === 'function' ? (col.value as (r: Row) => unknown)(row) : (row as Record<string, unknown>)[col.value as string];
}

/** columns+rows → 스타일 적용된 워크시트 객체(공통 규칙). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildStyledSheet<Row>(columns: ExcelColumn<Row>[], rows: Row[]): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws: Record<string, any> = {};
  // 헤더 행
  columns.forEach((col, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: col.header, t: 's', s: HEADER_STYLE };
  });
  // 데이터 행
  rows.forEach((row, ri) => {
    columns.forEach((col, c) => {
      const raw = resolveValue(col, row);
      const addr = XLSX.utils.encode_cell({ r: ri + 1, c });
      if (raw == null || raw === '') {
        ws[addr] = { v: '', t: 's', s: TEXT_STYLE };
        return;
      }
      if (col.type === 'number' && typeof raw === 'number' && Number.isFinite(raw)) {
        ws[addr] = { v: raw, t: 'n', s: NUM_STYLE };
      } else if (col.type === 'date') {
        const d = toDate(raw);
        // 날짜는 실제 date 셀(t:'d')로 유지하되, 표시 형식은 SheetJS 표준 속성 z 로 지정한다.
        // xlsx-js-style 은 date 셀에서 style.numFmt 를 무시하고 내장 형식(mm-dd-yy)으로 폴백하므로,
        // VERITAS 표준 yyyy.mm.dd 를 강제하려면 z 지정이 필요하다(DATE_STYLE.numFmt 와 동일 값).
        if (d) ws[addr] = { v: d, t: 'd', z: DATE_STYLE.numFmt, s: DATE_STYLE };
        else ws[addr] = { v: String(raw), t: 's', s: TEXT_STYLE };
      } else {
        ws[addr] = { v: String(raw), t: 's', s: TEXT_STYLE };
      }
    });
  });
  const lastRow = rows.length;                 // 0 = 헤더만
  const lastCol = Math.max(columns.length - 1, 0);
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } });
  ws['!cols'] = columns.map((col) => {
    if (col.width) return { wch: col.width };
    let max = displayWidth(col.header);
    for (const row of rows) {
      const v = resolveValue(col, row);
      let text = '';
      if (v == null) text = '';
      else if (col.type === 'number' && typeof v === 'number') text = Math.round(v).toLocaleString('ko-KR');
      else if (col.type === 'date') { const d = toDate(v); text = d ? '0000.00.00' : String(v); }
      else text = String(v);
      const len = displayWidth(text);
      if (len > max) max = len;
    }
    return { wch: Math.min(Math.max(max + 2, 8), 42) };
  });
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } }) };
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
  return ws;
}

/** dataset → 단일 시트 .xlsx 생성·다운로드. 현재 검색/필터가 적용된 "전체 결과"를 넘길 것. */
export function exportDataset<Row>(opts: {
  filename: string;
  sheetName: string;
  columns: ExcelColumn<Row>[];
  rows: Row[];
}): void {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildStyledSheet(opts.columns, opts.rows), opts.sheetName);
  XLSX.writeFile(wb, opts.filename);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface WorkbookSheet<Row = any> { sheetName: string; columns: ExcelColumn<Row>[]; rows: Row[]; }
/** 여러 시트를 하나의 .xlsx 로 생성·다운로드(견적: 견적목록 + 품목상세). 시트별 공통 스타일 규칙 동일 적용. */
export function exportWorkbook(opts: { filename: string; sheets: WorkbookSheet[] }): void {
  const wb = XLSX.utils.book_new();
  for (const s of opts.sheets) {
    XLSX.utils.book_append_sheet(wb, buildStyledSheet(s.columns, s.rows), s.sheetName);
  }
  XLSX.writeFile(wb, opts.filename);
}

// ── 대량등록 템플릿 ────────────────────────────────────────────────────────
export interface TemplateColumn {
  header: string;
  required?: boolean;
  example?: string;   // 예시 행에 들어갈 값
  allowed?: string[]; // 허용값(안내 시트에 표기 + 가능 시 dropdown)
  note?: string;      // 입력 안내
}

/**
 * 빈 대량등록 템플릿(.xlsx) 생성·다운로드.
 *  · 1행: 헤더(필수 컬럼은 빨간 배경으로 강조)
 *  · 2행: 예시(회색, 안내용 — 실제 등록 시 지우고 입력)
 *  · '입력안내' 시트: 필수/선택 · 허용값 목록
 * (SheetJS 커뮤니티 빌드는 dataValidation 쓰기를 지원하지 않으므로 dropdown 대신 허용값 안내로 대체 — §5 "가능하면")
 */
export function downloadTemplate(opts: {
  filename: string;
  sheetName: string;
  columns: TemplateColumn[];
  /** 추가 입력 시트(견적: '견적품목'). 각 시트도 헤더+예시행으로 만들고 입력안내에 함께 기재한다. */
  extraSheets?: { sheetName: string; columns: TemplateColumn[] }[];
}): void {
  const { filename, sheetName, columns, extraSheets = [] } = opts;
  const REQUIRED_HDR = { font: { bold: true, sz: 10, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: 'DC2626' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };
  const OPTIONAL_HDR = HEADER_STYLE;
  const EXAMPLE_STYLE = { font: { sz: 10, italic: true, color: { rgb: '9CA3AF' } }, alignment: { vertical: 'center' } };

  const buildInputSheet = (cols: TemplateColumn[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws: Record<string, any> = {};
    cols.forEach((col, c) => {
      ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: col.header + (col.required ? ' *' : ''), t: 's', s: col.required ? REQUIRED_HDR : OPTIONAL_HDR };
      ws[XLSX.utils.encode_cell({ r: 1, c })] = { v: col.example ?? '', t: 's', s: EXAMPLE_STYLE };
    });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 1, c: Math.max(cols.length - 1, 0) } });
    ws['!cols'] = cols.map((col) => ({ wch: Math.min(Math.max(displayWidth(col.header) + 4, 12), 30) }));
    ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
    return ws;
  };

  // 입력안내 시트(모든 입력시트 컬럼을 시트명 그룹으로 나열)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guide: Record<string, any> = {};
  const gHdr = HEADER_STYLE; const gCell = TEXT_STYLE;
  guide[XLSX.utils.encode_cell({ r: 0, c: 0 })] = { v: '시트', t: 's', s: gHdr };
  guide[XLSX.utils.encode_cell({ r: 0, c: 1 })] = { v: '컬럼', t: 's', s: gHdr };
  guide[XLSX.utils.encode_cell({ r: 0, c: 2 })] = { v: '필수/선택', t: 's', s: gHdr };
  guide[XLSX.utils.encode_cell({ r: 0, c: 3 })] = { v: '허용값 / 안내', t: 's', s: gHdr };
  let gr = 1;
  for (const grp of [{ sheetName, columns }, ...extraSheets]) {
    for (const col of grp.columns) {
      guide[XLSX.utils.encode_cell({ r: gr, c: 0 })] = { v: grp.sheetName, t: 's', s: gCell };
      guide[XLSX.utils.encode_cell({ r: gr, c: 1 })] = { v: col.header, t: 's', s: gCell };
      guide[XLSX.utils.encode_cell({ r: gr, c: 2 })] = { v: col.required ? '필수' : '선택', t: 's', s: gCell };
      guide[XLSX.utils.encode_cell({ r: gr, c: 3 })] = { v: col.allowed && col.allowed.length ? `허용값: ${col.allowed.join(' / ')}` : (col.note ?? ''), t: 's', s: gCell };
      gr++;
    }
  }
  guide['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(gr - 1, 0), c: 3 } });
  guide['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 10 }, { wch: 50 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildInputSheet(columns), sheetName);
  for (const es of extraSheets) XLSX.utils.book_append_sheet(wb, buildInputSheet(es.columns), es.sheetName);
  XLSX.utils.book_append_sheet(wb, guide, '입력안내');
  XLSX.writeFile(wb, filename);
}

// 파일명용 오늘 날짜 YYYYMMDD (로컬/KST 표시 기준).
export function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
