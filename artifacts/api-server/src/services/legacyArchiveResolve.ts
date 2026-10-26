// ─── Legacy CRM Archive Lite — 파싱/정규화/멱등 (C-4A) ────────────────────────
// 순수 로직(DB 접근 없음). 기존 hometaxExcel 파서를 재사용하되 Master Resolution 은 하지 않는다.
//   · source_raw = 파서가 읽은 원본 셀값 그대로(trim/auto-fill/enum/mapping 금지) → 원본 보존 권위.
//   · normalized 필드(record_date/company_name/amount 등)는 별도 추출 — 파싱 실패 시 null(row 는 버리지 않음).
//   · row_hash = (source_type + source_sheet + 원본 row 내용 stable serialization). 파일명 무관.
import crypto from "node:crypto";
import { parseAllSheets, buildColumnMap, getCell, isBlankRow, normalizeDate, type ParsedSheet } from "../lib/hometaxExcel";
import { encrypt, maskResidentNumber } from "../lib/encrypt";

export type ArchiveSourceType = "sales_list" | "progress" | "translator_list";
export const ARCHIVE_SOURCE_TYPES: ArchiveSourceType[] = ["sales_list", "progress", "translator_list"];

// 검색/표시용 header alias. 값 추측 금지 — header 가 없으면 해당 normalized 필드는 null.
// 원문 보존은 source_raw 가 담당하므로 여기엔 "검색에 쓸 최소 필드"만 둔다(§12).
const SALES_LIST_SYNONYMS: Record<string, string[]> = {
  recordDate: ["견적서발행일", "견적일", "견적일자", "견적발행일", "체결일", "계약체결일", "판매일", "매출일"],
  companyName: ["거래처명", "거래처", "고객사", "회사명", "상호"],
  contactName: ["고객명", "고객", "요청자", "담당자"],
  productName: ["상품명", "품목명", "서비스명", "제품명", "내용", "건명"],
  supplyAmount: ["공급가액", "공급가", "공급액"],
  vatAmount: ["부가세", "부가가치세", "vat", "세액"],
  totalAmount: ["총액", "합계금액", "총금액", "청구액"],
  collectionDate: ["입금일", "입금일자", "수금일"],
  collectionStatus: ["입금여부", "수금상태", "입금상태", "결제상태", "수금여부"],
};
const PROGRESS_SYNONYMS: Record<string, string[]> = {
  recordDate: ["견적서발행일", "견적일", "견적일자", "견적발행일", "체결일", "수행일", "수행시작일"],
  companyName: ["거래처명", "거래처", "고객사", "회사명", "상호"],
  contactName: ["고객명", "고객", "요청자", "담당자"],
  translatorName: ["통번역사명", "통역사명", "번역사명", "수행자명", "작업자"],
  productName: ["상품명", "품목명", "서비스명", "제품명", "내용", "건명"],
  language: ["언어", "언어쌍", "언어페어"],
  deliveryDate: ["통번역사납품일", "납품일", "납기일", "완료일"],
  payoutDate: ["통번역사지급일", "지급일", "지급예정일"],
  payoutPretax: ["지급액(세전)", "세전지급액", "지급액세전", "세전금액"],
};
// (translator_list) CRM 통번역사 명부 — 검색/표시용 최소 normalized + 주민번호 컬럼 식별(평문 미저장용).
//   · residentNumber 는 normalized 필드로 저장하지 않는다(화면·검색·DB normalized 어디에도 평문 없음).
//     오직 "어느 컬럼이 주민번호인가"를 찾아 마스킹·암호화하기 위한 식별 용도로만 쓴다.
const TRANSLATOR_LIST_SYNONYMS: Record<string, string[]> = {
  translatorName: ["성명", "이름", "통번역사명", "통역사명", "번역사명", "담당자명", "name"],
  language: ["언어", "언어쌍", "언어페어", "가능언어", "전문언어", "language"],
  companyName: ["소속", "소속업체", "소속회사", "업체명", "소속사", "거래처명"],
  residentNumber: ["주민등록번호", "주민번호", "주민등록", "rrn", "외국인등록번호", "외국인번호", "여권번호"],
};
function synonymsFor(sourceType: ArchiveSourceType): Record<string, string[]> {
  if (sourceType === "progress") return PROGRESS_SYNONYMS;
  if (sourceType === "translator_list") return TRANSLATOR_LIST_SYNONYMS;
  return SALES_LIST_SYNONYMS;
}

// ─── 읽기(조회/상세/다운로드) 응답용 주민번호 마스킹 — 저장 원본 미변경 ──────────
// 기존 progress 원본(30,142행)은 적재 당시 마스킹 없이 source_raw 에 평문 RRN 이 들어 있다.
// DB 원본·무결성은 그대로 두고(별도 승인 계획 = 암호화 전환), 화면/API/다운로드로 나가는 '응답 사본'에만
// 마스킹을 적용해 주민번호 원문 노출을 차단한다(요구3). 내부 보존 키(__*)도 함께 제거한다.
//   · translator_list 는 저장 시점에 이미 마스킹되어 재마스킹하지 않는다(사본 그대로, __ 키만 제거).
//   · sales_list 는 RRN 컬럼이 없어 무영향.
const RRN_HEADER_RE = /주민\s*(등록)?\s*번호/;
const RRN_PATTERN = /\d{6}\D?\d{7}/;   // 6자리-7자리(구분자 선택). 금액/날짜와 구분되는 RRN 형태.
// 읽기 응답용 주민번호 표시 형식: 생년월일 6자리 + '-' + 뒷자리 첫 숫자 + '******'(예: 850312-2******).
//   원본에 있는 숫자만 노출하고 없는 자리는 생성하지 않는다(앞 6자리만 → 850312-*******). 그 외 형식(문장·다른 숫자 혼재)은 전체 마스킹.
const RRN_READ_RE = /^(\d{6})\s*-?\s*(\d)[\d*]{0,6}$/;
function maskRrnForRead(v: string): string {
  const s = v.trim();
  const m = s.match(RRN_READ_RE);
  if (m) return `${m[1]}-${m[2]}******`;
  if (/^\d{6}\s*-?$/.test(s)) return `${s.slice(0, 6)}-*******`;
  return "******-*******";
}
// 문장 속에 섞인 주민번호(상세정보·비고·파일명 등)도 같은 형식으로 마스킹 — 6자리-7자리, 또는 생년월일+성별 형태의 13자리 연속 숫자.
const RRN_EMBED_HYPHEN_RE = /(?<!\d)(\d{6})\s*-\s*(\d)\d{6}(?!\d)/g;
const RRN_EMBED_PLAIN_RE = /(?<!\d)(\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))([1-8])\d{6}(?!\d)/g;
function maskEmbeddedRrn(v: string): string {
  return v.replace(RRN_EMBED_HYPHEN_RE, "$1-$2******").replace(RRN_EMBED_PLAIN_RE, "$1-$2******");
}
export function maskSourceRawForRead(sourceType: string, sourceRaw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const src = (sourceRaw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("__")) continue;                 // 내부 보존 키(암호문·마커) 미노출
    if (sourceType === "progress" && typeof v === "string" && v.trim() !== "") {
      const digits = v.replace(/[^0-9]/g, "");
      // RRN 컬럼은 항상 마스킹. 그 외 컬럼도 13자리 RRN 형태·문장 속 주민번호를 방어적으로 마스킹(평문 0 보장).
      if (RRN_HEADER_RE.test(k) && digits.length >= 6) { out[k] = maskRrnForRead(v); continue; }
      out[k] = maskRrnValue(v); continue;
    }
    out[k] = v;
  }
  return out;
}

// 단일 셀값 RRN 마스킹(13자리 주민번호 형태 + 문장 속 주민번호). 그 외 값·타입은 그대로. differences/셀 투영 공용.
export function maskRrnValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const e = maskEmbeddedRrn(v);   // 문장 속 주민번호는 주변 문구를 유지한 채 해당 부분만 마스킹
  const digits = e.replace(/[^0-9]/g, "");
  return digits.length === 13 && RRN_PATTERN.test(e) ? maskRrnForRead(e) : e;
}

// 미리보기(Excel 원본 미리보기·Identity 진단)용 — parse 결과 sheets 의 '표시 사본'에서만 progress RRN 을 마스킹한다.
//   · buildArchivePreview 결과(rowHash/identity)는 execute 저장·재업로드 멱등에 쓰이므로 절대 변형하지 않는다(원본 계산 입력 불변).
//     이 함수는 analyze/preview-rows 라우트가 '화면에 투영하기 직전'에만 호출하는 별도 사본이다.
//   · progress 만 처리. translator_list 는 이미 마스킹됨, sales_list 는 RRN 컬럼 없음 → 원본 참조 그대로 반환.
//   · rawRow: RRN 헤더 컬럼은 항상 마스킹 + 타 컬럼의 13자리 RRN 형태도 방어적 마스킹. sourceRaw: maskSourceRawForRead.
export function maskSheetsForDisplay(sourceType: ArchiveSourceType, sheets: ArchiveSheetPreview[]): ArchiveSheetPreview[] {
  if (sourceType !== "progress") return sheets;
  return sheets.map(s => {
    const rrnCols = new Set<number>();
    s.headers.forEach((h, i) => { if (RRN_HEADER_RE.test(String(h ?? ""))) rrnCols.add(i); });
    return {
      ...s,
      rows: s.rows.map(r => ({
        ...r,
        rawRow: r.rawRow.map((cell, i) =>
          (rrnCols.has(i) && typeof cell === "string" && cell.trim() !== "") ? maskRrnForRead(cell) : maskRrnValue(cell)),
        sourceRaw: maskSourceRawForRead(sourceType, r.sourceRaw),
      })),
    };
  });
}

// 금액: 쉼표·통화기호·공백 등 제거 후 숫자. 실패 시 null(원문은 source_raw 에 보존).
export function parseArchiveAmount(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).replace(/[^0-9.\-]/g, "").trim();
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// 날짜: YYYY-MM-DD 로 정규화 성공 시만 값, 아니면 null(원문은 source_raw 에 보존).
export function parseArchiveDate(raw: unknown): string | null {
  const d = normalizeDate(raw);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
// 입금상태: 원본이 명확히 paid/unpaid 를 나타낼 때만. 추측 금지. Current workflow status 와 무관.
export function parseCollectionStatus(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[\s·()]/g, "").toLowerCase();
  if (!s) return null;
  if (["완납", "입금", "입금완료", "paid", "수금완료", "o", "y", "yes", "완료"].includes(s)) return "paid";
  if (["미입금", "미수", "미수금", "unpaid", "미납", "x", "n", "no"].includes(s)) return "unpaid";
  return null;
}

// 원본 셀값을 JSONB 안전하게 보존: string 은 trim 없이 그대로(trailing space 포함), number/boolean 은 원값, null 은 null.
function rawCell(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}
// 한 행의 전체 컬럼을 {header: 원본값} 으로 보존(header 공란이면 col{index} 키). 원본 전체 보존.
function buildSourceRaw(headers: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const n = Math.max(headers.length, row.length);
  for (let i = 0; i < n; i++) {
    const h = (headers[i] ?? "").toString();
    const key = h.trim() !== "" ? h : `col${i}`;
    // 동일 header 중복 시 뒤에 인덱스 부여(덮어쓰기 방지)
    const finalKey = out[key] === undefined ? key : `${key}#${i}`;
    out[finalKey] = rawCell(row[i]);
  }
  return out;
}

// stable serialization: header(정규화 전 원문) 기준 정렬 후 [header,cell] 직렬화. key ordering 비의존.
function stableRowContent(headers: string[], row: unknown[]): string {
  const pairs: [string, string][] = [];
  const n = Math.max(headers.length, row.length);
  for (let i = 0; i < n; i++) {
    const h = (headers[i] ?? "").toString();
    const key = h.trim() !== "" ? h : `col${i}`;
    const v = row[i];
    const vs = v == null ? "" : typeof v === "string" ? v : String(v);
    pairs.push([key, vs]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pairs);
}
// source_file 은 identity 에서 제외. source_type + source_sheet + 원본 row 내용만.
export function computeRowHash(sourceType: string, sourceSheet: string, headers: string[], row: unknown[]): string {
  const payload = `${sourceType}\u0000${sourceSheet}\u0000${stableRowContent(headers, row)}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export interface ArchivePreviewRow {
  sourceSheet: string;
  sourceRow: number;            // 1-based
  rowHash: string;
  // normalized (검색/표시) — 추출 실패 시 null
  recordDate: string | null;
  companyName: string | null;
  contactName: string | null;
  translatorName: string | null;
  productName: string | null;
  language: string | null;
  supplyAmount: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  payoutPretax: number | null;
  deliveryDate: string | null;
  payoutDate: string | null;
  collectionDate: string | null;
  collectionStatus: string | null;
  sourceRaw: Record<string, unknown>;
  rawRow: unknown[];            // 파서가 읽은 원본 row(셀 배열) — Preview 메모리 내 전체 컬럼 대조용(§4-C). DB 저장 안 함.
  warnings: string[];           // date/amount 파싱 경고(행 폐기 사유 아님)
}

export interface ArchiveSheetPreview {
  sheetName: string;
  headerRowIndex: number;
  recognizedColumns: Record<string, string | null>;  // field → 실제 header명
  headers: string[];                                  // (C-4E) 원본 Excel header 전체(원래 순서) — 원본 미리보기용
  rows: ArchivePreviewRow[];
}

// 파서가 읽은 모든 데이터 시트를 archive preview row 로 변환(DB 접근 없음, 원본 보존).
export function buildArchivePreview(buffer: Buffer, sourceType: ArchiveSourceType): ArchiveSheetPreview[] {
  const syn = synonymsFor(sourceType);
  const sheets: ParsedSheet[] = parseAllSheets(buffer, syn, { lean: true });   // raw 값만 사용 → lean 읽기(결과 동일)
  const out: ArchiveSheetPreview[] = [];
  for (const sheet of sheets) {
    const colMap = buildColumnMap(sheet.headers, syn);
    const recognized: Record<string, string | null> = {};
    for (const [field, idx] of Object.entries(colMap)) recognized[field] = idx >= 0 ? (sheet.headers[idx] ?? null) : null;

    const rows: ArchivePreviewRow[] = [];
    for (let i = 0; i < sheet.dataRows.length; i++) {
      const row = sheet.dataRows[i] ?? [];
      if (isBlankRow(row)) continue;
      const sourceRow = sheet.headerRowIndex + 2 + i;  // 1-based (기존 패턴과 동일)
      const warnings: string[] = [];

      const pick = (field: string) => getCell(row, colMap, field);
      const recordDate = parseArchiveDate(pick("recordDate"));
      if (pick("recordDate") != null && String(pick("recordDate")).trim() !== "" && recordDate == null) warnings.push("record_date 파싱 실패(원문 보존)");
      const supplyAmount = parseArchiveAmount(pick("supplyAmount"));
      const vatAmount = parseArchiveAmount(pick("vatAmount"));
      const totalAmount = parseArchiveAmount(pick("totalAmount"));
      const payoutPretax = sourceType === "progress" ? parseArchiveAmount(pick("payoutPretax")) : null;

      const toText = (v: unknown): string | null => {
        if (v == null) return null;
        const s = typeof v === "string" ? v.trim() : String(v).trim();
        return s === "" ? null : s;
      };

      // ── (translator_list) 주민번호 평문 미저장 ───────────────────────────────
      //   원본 row 의 주민번호 셀을 "결정적 마스킹"한 사본(workRow)으로 이후 모든 다운스트림을 처리한다
      //   (row_hash·source_raw·rawRow·preview·identity/중복분석 전부 마스킹값만 본다 → 평문 노출 0).
      //   복원용 원본값은 source_raw.__resident_number_enc 에 AES-256-GCM 암호문으로만 보존(서버 내부 복호 전용).
      //   file_hash(원본 파일 bytes)·행수·그 외 컬럼은 원본 그대로 → 원본 무결성 보존.
      //   · 결정적 마스킹 + row_hash 는 암호문 제외 → 동일 파일 재업로드 멱등(source identity) 유지.
      //   · progress/sales_list 는 workRow === row(동일 참조) → 기존 동작 100% 불변.
      let workRow = row;
      let rrnEnc: string | null = null;
      let rrnKind: "rrn13" | "other" | null = null;
      if (sourceType === "translator_list") {
        workRow = row.slice();
        const rrnIdx = colMap["residentNumber"];
        // 1) 인식된 주민번호 컬럼: 복원용 암호문 생성 + 표시값 마스킹(13자리=YYMMDD-*******, 그 외=고정 토큰).
        if (rrnIdx != null && rrnIdx >= 0) {
          const s = workRow[rrnIdx] == null ? "" : String(workRow[rrnIdx]).trim();
          if (s !== "") {
            const digits = s.replace(/[^0-9]/g, "");
            if (digits.length === 13) { rrnEnc = encrypt(digits); rrnKind = "rrn13"; workRow[rrnIdx] = maskResidentNumber(s); }
            else { rrnEnc = encrypt(s); rrnKind = "other"; workRow[rrnIdx] = "[암호화 보관]"; }  // 외국인등록/여권 등 비13자리 식별번호도 평문 미저장(복원은 암호문)
          }
        }
        // 2) 방어적: 인식 못한 다른 셀에 13자리 주민번호가 남아 있어도 전부 마스킹(평문 0 보장, 결정적).
        for (let c = 0; c < workRow.length; c++) {
          const cell = workRow[c];
          if (typeof cell === "string") {
            const d = cell.replace(/[^0-9]/g, "");
            if (d.length === 13 && /\d{6}\D?\d{7}/.test(cell)) workRow[c] = maskResidentNumber(cell);
          }
        }
      }
      const sourceRaw = buildSourceRaw(sheet.headers, workRow);
      if (sourceType === "translator_list" && rrnEnc) {
        sourceRaw["__resident_number_enc"] = rrnEnc;      // AES-256-GCM 암호문(서버 내부 복호 전용). 평문 아님.
        sourceRaw["__resident_number_kind"] = rrnKind;    // 'rrn13'(=기준A 주민번호 보유) | 'other'(외국인/여권 등). 非PII 마커.
      }

      rows.push({
        sourceSheet: sheet.sheetName,
        sourceRow,
        rowHash: computeRowHash(sourceType, sheet.sheetName, sheet.headers, workRow),
        recordDate,
        companyName: toText(pick("companyName")),
        contactName: toText(pick("contactName")),
        translatorName: (sourceType === "progress" || sourceType === "translator_list") ? toText(pick("translatorName")) : null,
        productName: toText(pick("productName")),
        language: (sourceType === "progress" || sourceType === "translator_list") ? toText(pick("language")) : null,
        supplyAmount,
        vatAmount,
        totalAmount,
        payoutPretax,
        deliveryDate: sourceType === "progress" ? parseArchiveDate(pick("deliveryDate")) : null,
        payoutDate: sourceType === "progress" ? parseArchiveDate(pick("payoutDate")) : null,
        collectionDate: sourceType === "sales_list" ? parseArchiveDate(pick("collectionDate")) : null,
        collectionStatus: sourceType === "sales_list" ? parseCollectionStatus(pick("collectionStatus")) : null,
        sourceRaw,
        rawRow: workRow.slice(),   // 원본 셀 배열 사본(메모리 내 대조 전용). translator_list 는 마스킹된 workRow → preview 에도 평문 없음.
        warnings,
      });
    }
    out.push({ sheetName: sheet.sheetName, headerRowIndex: sheet.headerRowIndex, recognizedColumns: recognized, headers: sheet.headers.slice(), rows });
  }
  return out;
}

// ─── C-4E: Excel 원본 미리보기(READ-ONLY, 전체 컬럼) ─────────────────────────
// normalized/검색 필드가 아니라 원본 header + rawRow(원본 셀값)을 그대로 페이지 단위로 투영한다.
//   · 원본 값 무변환(trim/normalize/enum/치환 금지). null 과 "" 는 payload 에서 구분 보존(JSON null vs "").
//   · 30,142행을 한 번에 보내지 않는다 — page/pageSize 로 제한(기본 50, 최대 200).
//   · DB 접근 없음(순수). 분석 결과(total/duplicate 등)에 영향 주지 않음.
export interface ExcelPreviewRow {
  sourceRow: number;      // 1-based 원본 Excel 행번호(source_row 와 동일)
  sourceSheet: string;
  values: unknown[];      // headers 와 동일 index 정렬. 원본 셀값 그대로(null/""/trailing space 보존)
}
export interface ExcelPreviewPage {
  headers: string[];      // 원본 Excel header(원래 순서)
  totalRows: number;      // 전체 데이터 행수(= 분석 total 과 동일)
  page: number;
  pageSize: number;
  rows: ExcelPreviewRow[];
  sheetCount: number;     // 파싱된 데이터 시트 수(>1 이면 UI 가 sheet 를 함께 표시)
}

export function clampPreviewPageSize(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 50;     // 기본 50
  return Math.min(200, n);                           // 최대 200 clamp
}

// 파싱된 sheets(allRows 평탄화 순서 유지)에서 한 페이지를 원본 그대로 투영한다.
export function buildExcelPreviewPage(sheets: ArchiveSheetPreview[], page: unknown, pageSize: unknown): ExcelPreviewPage {
  const ps = clampPreviewPageSize(pageSize);
  const pg = Math.max(1, Math.floor(Number(page)) || 1);
  const headers = sheets[0]?.headers ?? [];          // 단일 데이터시트 가정(진행관리표). 다중시트면 첫 시트 header + 행별 sourceSheet 표기.
  const all = sheets.flatMap(s => s.rows);
  const start = (pg - 1) * ps;
  const slice = all.slice(start, start + ps);
  const width = headers.length;
  const rows: ExcelPreviewRow[] = slice.map(r => ({
    sourceRow: r.sourceRow,
    sourceSheet: r.sourceSheet,
    // headers index 정렬. 원본 값 무변환(그대로). header 범위를 벗어난 trailing cell 은 header 가 없으므로 표시 대상 아님.
    values: Array.from({ length: width }, (_, i) => (i < r.rawRow.length ? r.rawRow[i] : null)),
  }));
  return { headers: headers.slice(), totalRows: all.length, page: pg, pageSize: ps, rows, sheetCount: sheets.length };
}

// ─── Preview 메모리 내 중복 원본 검증 (C-4A additive) ─────────────────────────
// 별도 파일/workspace 경로/임시저장 없이, analyze 요청이 이미 보유한 ArchivePreviewRow
// (row_hash + source_raw + rawRow) 만으로 duplicate group 을 구성·대조한다. DB write 없음.
//   · computeRowHash/stableRowContent/Execute 저장 로직은 일절 변경하지 않는다(§12).
//   · duplicateExcludedRows 는 Preview 의 duplicate count 와 동일하게 계산된다
//     (existing ? groupCount : groupCount-1 의 합 = analyze 라우트의 seen/existing 규칙과 일치).

export type DuplicateClass = "EXACT_DUPLICATE" | "SOURCE_RAW_DIFFERENT" | "ORIGINAL_ROW_DIFFERENT";

export interface DuplicateFieldDiff {
  column: string;               // source_raw key(헤더) 또는 rawRow index(col{i})
  excelRowA: number;            // 대표(그룹 첫) 행의 원본 Excel row
  excelRowB: number;            // 차이가 난 행의 원본 Excel row
  valueA: unknown;
  valueB: unknown;
  kind: "null_vs_empty" | "type_diff" | "value_diff";
}

export interface DuplicateGroup {
  rowHash: string;
  sourceSheet: string;
  excelRows: number[];          // group 내 모든 원본 Excel row(오름차순 아님 — 등장 순서)
  groupCount: number;           // 파일 내 동일 hash row 개수
  excludedCount: number;        // 중복으로 제외되는 개수(existing ? groupCount : groupCount-1)
  existsInDb: boolean;          // 기존 legacy_archive_rows 에 이미 존재하는 hash 인지
  classification: DuplicateClass;
  differences: DuplicateFieldDiff[];   // source_raw/rawRow 차이(없으면 빈 배열)
  nullEmptyDiffs: DuplicateFieldDiff[]; // §6: null/빈문자/type 차이만 추린 것
  representative: ArchivePreviewRow;    // group 의 첫 번째 row(표시용 normalized 필드 보유)
}

export interface DuplicateAnalysis {
  duplicateExcludedRows: number;   // = Preview summary.duplicate
  duplicateGroups: number;         // 중복을 발생시킨 group 수
  exactDuplicateRows: number;      // 원본 전체 동일 중복으로 제외된 행 수
  sourceRawDifferentRows: number;  // source_raw 차이가 있는 group 의 제외 행 수
  originalRowDifferentRows: number;// 파서 원본 row 차이가 있는 group 의 제외 행 수
  nullEmptyDifferenceRows: number; // null/빈문자/type 차이가 발견된 group 의 제외 행 수
  safeToSkip: boolean;             // 모든 중복이 EXACT 일 때만 true → Execute 허용
}

// JSON 안전한 값(원시/null/배열/plain object)의 깊은 동일성.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;   // null/undefined 는 === 로만 동일
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;       // 원시형이면서 ===아님 → 다름
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao), bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) { if (!Object.prototype.hasOwnProperty.call(bo, k)) return false; if (!deepEqual(ao[k], bo[k])) return false; }
  return true;
}

function isNullishOrEmpty(v: unknown): boolean { return v == null || v === ""; }

function classifyDiffKind(a: unknown, b: unknown): DuplicateFieldDiff["kind"] {
  if (isNullishOrEmpty(a) && isNullishOrEmpty(b)) return "null_vs_empty"; // null/undefined vs "" 등
  if (typeof a !== typeof b) return "type_diff";                          // 1(number) vs "1"(string) 등
  return "value_diff";
}

// 같은 hash group 내 source_raw 전체 key/value 를 대표행(members[0]) 기준으로 대조.
function collectSourceRawDiffs(members: ArchivePreviewRow[], cap = 50): DuplicateFieldDiff[] {
  const diffs: DuplicateFieldDiff[] = [];
  const base = members[0];
  for (let m = 1; m < members.length && diffs.length < cap; m++) {
    const cur = members[m];
    const keys = new Set<string>([...Object.keys(base.sourceRaw), ...Object.keys(cur.sourceRaw)]);
    for (const key of keys) {
      if (diffs.length >= cap) break;
      const va = base.sourceRaw[key], vb = cur.sourceRaw[key];
      if (!deepEqual(va, vb)) {
        diffs.push({ column: key, excelRowA: base.sourceRow, excelRowB: cur.sourceRow, valueA: va, valueB: vb, kind: classifyDiffKind(va, vb) });
      }
    }
  }
  return diffs;
}

// source_raw 가 동일할 때에도 파서 원본 row(셀 배열)까지 전체 대조(§4-C).
function collectRawRowDiffs(members: ArchivePreviewRow[], cap = 50): DuplicateFieldDiff[] {
  const diffs: DuplicateFieldDiff[] = [];
  const base = members[0];
  for (let m = 1; m < members.length && diffs.length < cap; m++) {
    const cur = members[m];
    const n = Math.max(base.rawRow.length, cur.rawRow.length);
    for (let i = 0; i < n && diffs.length < cap; i++) {
      const va = base.rawRow[i], vb = cur.rawRow[i];
      if (!deepEqual(va, vb)) {
        diffs.push({ column: `col${i}`, excelRowA: base.sourceRow, excelRowB: cur.sourceRow, valueA: va, valueB: vb, kind: classifyDiffKind(va, vb) });
      }
    }
  }
  return diffs;
}

// allRows(파일 전체) + existingHashes(기존 DB) → duplicate group 구성 및 원본 전체 컬럼 대조.
export function analyzeArchiveDuplicates(
  allRows: ArchivePreviewRow[],
  existingHashes: Set<string>,
): { analysis: DuplicateAnalysis; groups: DuplicateGroup[] } {
  // 등장 순서를 보존하며 hash 별 group 화.
  const byHash = new Map<string, ArchivePreviewRow[]>();
  for (const r of allRows) {
    const arr = byHash.get(r.rowHash);
    if (arr) arr.push(r); else byHash.set(r.rowHash, [r]);
  }

  const groups: DuplicateGroup[] = [];
  const analysis: DuplicateAnalysis = {
    duplicateExcludedRows: 0, duplicateGroups: 0,
    exactDuplicateRows: 0, sourceRawDifferentRows: 0, originalRowDifferentRows: 0,
    nullEmptyDifferenceRows: 0, safeToSkip: true,
  };

  for (const [rowHash, members] of byHash) {
    const existsInDb = existingHashes.has(rowHash);
    const groupCount = members.length;
    const excludedCount = existsInDb ? groupCount : groupCount - 1;
    if (excludedCount <= 0) continue;  // 중복 아님(파일 내 유일 + DB 미존재)

    // 분류: source_raw 먼저, 동일하면 rawRow 까지. (A=hash 동일은 group 구성 전제)
    let classification: DuplicateClass;
    let differences: DuplicateFieldDiff[] = [];
    if (groupCount >= 2) {
      const srDiffs = collectSourceRawDiffs(members);
      if (srDiffs.length > 0) {
        classification = "SOURCE_RAW_DIFFERENT";
        differences = srDiffs;
      } else {
        const rrDiffs = collectRawRowDiffs(members);
        if (rrDiffs.length > 0) { classification = "ORIGINAL_ROW_DIFFERENT"; differences = rrDiffs; }
        else classification = "EXACT_DUPLICATE";
      }
    } else {
      // 파일 내 1건이지만 DB 에 이미 존재(existsInDb) → 메모리에 대조 상대 없음 → 원본 동일로 간주.
      classification = "EXACT_DUPLICATE";
    }

    const nullEmptyDiffs = differences.filter(d => d.kind === "null_vs_empty" || d.kind === "type_diff");

    analysis.duplicateExcludedRows += excludedCount;
    analysis.duplicateGroups += 1;
    if (classification === "EXACT_DUPLICATE") analysis.exactDuplicateRows += excludedCount;
    else if (classification === "SOURCE_RAW_DIFFERENT") analysis.sourceRawDifferentRows += excludedCount;
    else analysis.originalRowDifferentRows += excludedCount;
    if (nullEmptyDiffs.length > 0) analysis.nullEmptyDifferenceRows += excludedCount;

    groups.push({
      rowHash, sourceSheet: members[0].sourceSheet,
      excelRows: members.map(m => m.sourceRow), groupCount, excludedCount, existsInDb,
      classification, differences, nullEmptyDiffs, representative: members[0],
    });
  }

  // hash 가 같지만 원본이 다른 사례가 하나라도 있으면 Execute 금지(§10).
  analysis.safeToSkip = analysis.sourceRawDifferentRows === 0 && analysis.originalRowDifferentRows === 0;

  // 표시 우선순위: 차이 있는 group(위험)을 앞으로, 그다음 그룹 크기 큰 순.
  groups.sort((a, b) => {
    const aw = a.classification === "EXACT_DUPLICATE" ? 1 : 0;
    const bw = b.classification === "EXACT_DUPLICATE" ? 1 : 0;
    if (aw !== bw) return aw - bw;
    return b.groupCount - a.groupCount;
  });

  return { analysis, groups };
}

// ─── C-4D: Source Identity 기반 저장 계획 ────────────────────────────────────
// 원칙(§2):  파일 내부 동일행 = 보존(전부 저장)  /  동일 파일 재업로드 = 차단.
//   · row_hash 는 identity 가 아니다(CONTENT HASH). 저장/skip 을 row_hash 로 판정하지 않는다(§3).
//   · source identity = file_hash + source_type + source_sheet + source_row (§5).
//   · file_hash = 업로드된 실제 파일 bytes 의 SHA-256(파일명 무관) → 파일명만 바꾼 재업로드도 동일 식별.

// 업로드 파일 bytes 지문(파일명 무관). import_batches.file_hash 와 동일한 개념을 재사용한다.
export function computeFileHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// 한 analyze/execute 요청 안에서 file_hash·source_type 은 고정 → identity 는 (sheet, row) 로 환원.
export function sourceIdentityKey(sourceSheet: string, sourceRow: number): string {
  return `${sourceSheet}\u0000${sourceRow}`;
}

// 동일 source identity 인데 저장된 내용(row_hash)이 다른 경우 — 데이터 손상/변조 의심. 자동 overwrite/skip 금지(§8·TEST E).
export interface ArchiveIdentityConflict {
  sourceSheet: string;
  sourceRow: number;
  storedRowHash: string;     // DB 에 이미 저장된 내용 지문
  incomingRowHash: string;   // 이번 업로드 파일의 같은 위치 내용 지문
}

export interface ArchiveImportPlan {
  toSaveRows: ArchivePreviewRow[];      // 신규 저장 대상(파일 내부 동일행 포함 — 전부 보존)
  alreadyStoredCount: number;           // 재업로드 제외(동일 파일·동일 위치·동일 내용이 이미 보존됨)
  conflicts: ArchiveIdentityConflict[]; // 동일 위치인데 내용 상이 → STOP 사유
  isReupload: boolean;                  // alreadyStoredCount > 0
  safeToExecute: boolean;               // conflicts 가 없을 때만 저장 허용
}

// allRows(파일 전체) + existingIdentities(동일 file_hash+source_type 로 이미 저장된 sheet|row → row_hash) → 저장 계획.
// row_hash 가 같은 파일 내부 동일행은 source_row 가 달라 identity 가 다르므로 전부 toSaveRows 에 남는다.
export function planArchiveImport(
  allRows: ArchivePreviewRow[],
  existingIdentities: Map<string, string>,
): ArchiveImportPlan {
  const toSaveRows: ArchivePreviewRow[] = [];
  const conflicts: ArchiveIdentityConflict[] = [];
  let alreadyStoredCount = 0;
  for (const r of allRows) {
    const stored = existingIdentities.get(sourceIdentityKey(r.sourceSheet, r.sourceRow));
    if (stored === undefined) { toSaveRows.push(r); continue; }        // 새 원본행 → 저장
    if (stored === r.rowHash) { alreadyStoredCount++; continue; }      // 동일 파일·동일 위치·동일 내용 → 재업로드 skip
    conflicts.push({ sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, storedRowHash: stored, incomingRowHash: r.rowHash });
  }
  return { toSaveRows, alreadyStoredCount, conflicts, isReupload: alreadyStoredCount > 0, safeToExecute: conflicts.length === 0 };
}

// ─── C-4H-2: Excel Identity 진단 (READ-ONLY, Preview 메모리 집계) ─────────────
// 목적: 재다운로드 후에도 유지되는 "안정적 per-row ID" 가 실제 Excel 에 있는지 실측.
//   · DB 접근/저장 없음(순수). Preview parser 가 읽은 sheets(headers+rawRow) 만 사용.
//   · 전체 행을 브라우저로 보내지 않는다 — 서버 메모리에서 Set/Map 집계 후 통계+소량 sample 만 반환.
//   · 이름만으로 ID 확정하지 않는다. uniqueness 높아도 자동 채택하지 않는다(진단만, Execute 무관).
//   · content/mutable field 로 임의 composite identity 만들지 않는다 — composite 후보는 ID 성격 컬럼만.

// ID 성격 header(정규화 후). 정확 이름이 아니어도 역할 패턴 포함.
const ID_NAME_RE = /(번호|코드|순번|일련|시퀀스|sequence|seq|code|number|\bid\b|\bno\b)/i;
// 시간이 지나며 바뀔 수 있는 mutable 성격 header — logical identity 에 쓰면 위험(진단 표시용).
const MUTABLE_NAME_RE = /(통번역사|통역사|번역사|납품|지급|입금|수금|계산서|세금|금액|상태|요금|통역료|교통비|출장비|보상비|저작권|담당)/;

function idNorm(h: string): string { return (h ?? "").toString().replace(/[\s　()\[\]{}·.\-_/]/g, "").toLowerCase(); }
function serCell(v: unknown): string | null {  // 존재값만 key 화. null/빈문자/공백은 "부재"(null) 취급.
  if (v == null) return null;
  const s = typeof v === "string" ? v : String(v);
  return s.trim() === "" ? null : s;
}

export type IdentityClass = "UNIQUE" | "NEAR_UNIQUE" | "NON_UNIQUE" | "MOSTLY_NULL" | "UNUSABLE";
const NEAR_UNIQUE_RATIO = 0.99;
const MOSTLY_NULL_RATIO = 0.5;

export interface IdentityHeaderStat {
  columnIndex: number; originalHeader: string;
  isIdCandidate: boolean; isMutable: boolean;
  nonNullCount: number; nullCount: number; blankCount: number;
  distinctCount: number; duplicateValueCount: number; uniquenessRatio: number;  // present 값 기준
}
export interface IdentityCandidate extends IdentityHeaderStat {
  classification: IdentityClass; valueType: string; sampleValues: string[];
  min: string | null; max: string | null;
}
export interface CompositeCandidate {
  columns: string[]; columnIndexes: number[]; coverage: number; distinctCount: number; uniquenessRatio: number; classification: IdentityClass;
}
export interface IdentityRelation {
  available: boolean; reason?: string;
  saleColumn?: string; assignmentColumn?: string;
  totalSales?: number; multiRowSales?: number; maxRowsPerSale?: number; avgRowsPerSale?: number;
  samples?: { saleId: string; rowCount: number; translatorCount: number; assignmentCount: number; sourceRows: number[] }[];
}
export interface IdenticalRowIdAnalysis {
  idColumnUsed: string | null;
  // "business content 동일(=ID 후보 컬럼 제외 전 컬럼 동일)" 그룹 기준. ID 후보 없으면 전체 컬럼(=row_hash) 동치.
  identicalRows: number; identicalGroups: number;
  distinguishableByIdRows: number; distinguishableByIdGroups: number;   // content 동일 + ID 서로 다름 → 서로 다른 record
  sameIdRows: number; sameIdGroups: number;                             // content 동일 + ID 동일 → 실제 duplicate 가능
  missingIdRows: number; missingIdGroups: number;                       // content 동일 + ID 없음/부재 → 구분 불가
  fullRowIdenticalRows: number; fullRowIdenticalGroups: number;         // 참고: 전 컬럼(row_hash) 완전 동일(= C-4D 153 상당)
}
export interface IdentitySample {
  rowHashShort: string; groupCount: number; companyName: string | null; productName: string | null;
  classification: "CONTENT_IDENTICAL_ID_DIFFERENT" | "CONTENT_IDENTICAL_ID_SAME" | "CONTENT_IDENTICAL_ID_MISSING";
  members: { sourceRow: number; idValues: Record<string, string | null> }[];
}
export interface ExcelIdentityAnalysis {
  analyzed: boolean; analyzedSheet: string; sheetCount: number; totalRows: number; totalColumns: number;
  headers: IdentityHeaderStat[]; candidateColumns: IdentityCandidate[]; compositeCandidates: CompositeCandidate[];
  mutableColumns: string[]; relationAnalysis: IdentityRelation; identicalRowAnalysis: IdenticalRowIdAnalysis;
  representativeSamples: IdentitySample[];
  conclusion: { stableRowIdFound: boolean; recommendedIdentity: string | null; confidence: "high" | "medium" | "low" | "none"; reason: string };
}

function classify(presentCount: number, distinctCount: number, totalRows: number, nullCount: number, blankCount: number): IdentityClass {
  if (presentCount === 0 || distinctCount <= 1) return "UNUSABLE";
  if ((nullCount + blankCount) / Math.max(1, totalRows) > MOSTLY_NULL_RATIO) return "MOSTLY_NULL";
  const ratio = distinctCount / presentCount;
  if (ratio >= 1 && presentCount === totalRows) return "UNIQUE";        // 전부 present + 전부 distinct
  if (ratio >= NEAR_UNIQUE_RATIO) return "NEAR_UNIQUE";
  return "NON_UNIQUE";
}

// 메인(최다행) 시트 기준 진단. 전체 행(rawRow) 집계, raw 데이터는 반환하지 않음.
export function analyzeExcelIdentity(sheets: ArchiveSheetPreview[]): ExcelIdentityAnalysis {
  const empty: ExcelIdentityAnalysis = {
    analyzed: false, analyzedSheet: "", sheetCount: sheets.length, totalRows: 0, totalColumns: 0,
    headers: [], candidateColumns: [], compositeCandidates: [], mutableColumns: [],
    relationAnalysis: { available: false, reason: "분석할 데이터 시트 없음" },
    identicalRowAnalysis: { idColumnUsed: null, identicalRows: 0, identicalGroups: 0, distinguishableByIdRows: 0, distinguishableByIdGroups: 0, sameIdRows: 0, sameIdGroups: 0, missingIdRows: 0, missingIdGroups: 0, fullRowIdenticalRows: 0, fullRowIdenticalGroups: 0 },
    representativeSamples: [],
    conclusion: { stableRowIdFound: false, recommendedIdentity: null, confidence: "none", reason: "데이터 없음" },
  };
  if (sheets.length === 0) return empty;
  // 최다 행 시트 선택
  const sheet = sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a), sheets[0]);
  const headers = sheet.headers;
  const rows = sheet.rows;
  const total = rows.length;
  const cols = headers.length;
  if (total === 0 || cols === 0) return { ...empty, analyzedSheet: sheet.sheetName };

  // 1패스 컬럼 통계
  const sets: Set<string>[] = headers.map(() => new Set<string>());
  const nonNull = new Array(cols).fill(0), blank = new Array(cols).fill(0);
  const numericAll = new Array(cols).fill(true), hasVal = new Array(cols).fill(false);
  const numMin = new Array(cols).fill(Infinity), numMax = new Array(cols).fill(-Infinity);
  for (const r of rows) {
    const rr = r.rawRow;
    for (let i = 0; i < cols; i++) {
      const v = i < rr.length ? rr[i] : null;
      if (v == null) continue;
      const s = typeof v === "string" ? v : String(v);
      if (s.trim() === "") { blank[i]++; continue; }  // nonNull 이지만 blank(빈문자/공백)
      nonNull[i]++; hasVal[i] = true;
      sets[i].add(s);
      const n = Number(s.replace(/,/g, ""));
      if (Number.isFinite(n)) { if (n < numMin[i]) numMin[i] = n; if (n > numMax[i]) numMax[i] = n; }
      else numericAll[i] = false;
    }
  }

  const headerStats: IdentityHeaderStat[] = headers.map((h, i) => {
    const present = nonNull[i];
    const distinct = sets[i].size;
    const nullCount = total - present - blank[i];
    return {
      columnIndex: i, originalHeader: h,
      isIdCandidate: ID_NAME_RE.test(idNorm(h)), isMutable: MUTABLE_NAME_RE.test(h),
      nonNullCount: present, nullCount, blankCount: blank[i],
      distinctCount: distinct, duplicateValueCount: Math.max(0, present - distinct),
      uniquenessRatio: present > 0 ? distinct / present : 0,
    };
  });

  const mutableColumns = headerStats.filter(s => s.isMutable).map(s => s.originalHeader);

  // ID 후보 상세
  const candidateColumns: IdentityCandidate[] = headerStats.filter(s => s.isIdCandidate).map(s => {
    const i = s.columnIndex, present = s.nonNullCount;
    const cls = classify(present, s.distinctCount, total, s.nullCount, s.blankCount);
    const samples: string[] = []; for (const v of sets[i]) { if (samples.length >= 10) break; samples.push(v); }
    const isNum = present > 0 && numericAll[i];
    return { ...s, classification: cls, valueType: isNum ? "number" : "string", sampleValues: samples,
      min: isNum ? String(numMin[i]) : null, max: isNum ? String(numMax[i]) : null };
  });

  // Composite 후보 — ID 성격 컬럼 중 NON_UNIQUE/NEAR_UNIQUE 상위 6개만(조합 폭발 방지). mutable/content 제외.
  const compPool = candidateColumns
    .filter(c => !c.isMutable && (c.classification === "NON_UNIQUE" || c.classification === "NEAR_UNIQUE"))
    .sort((a, b) => b.uniquenessRatio - a.uniquenessRatio).slice(0, 6);
  const compositeCandidates: CompositeCandidate[] = [];
  const evalCombo = (idxs: number[]) => {
    const set = new Set<string>(); let coverage = 0;
    for (const r of rows) {
      const parts: string[] = []; let ok = true;
      for (const i of idxs) { const s = serCell(i < r.rawRow.length ? r.rawRow[i] : null); if (s == null) { ok = false; break; } parts.push(s); }
      if (!ok) continue; coverage++; set.add(parts.join("\u0001"));
    }
    const ratio = coverage > 0 ? set.size / coverage : 0;
    compositeCandidates.push({
      columns: idxs.map(i => headers[i]), columnIndexes: idxs,
      coverage: coverage / total, distinctCount: set.size, uniquenessRatio: ratio,
      classification: (ratio >= 1 && coverage === total) ? "UNIQUE" : ratio >= NEAR_UNIQUE_RATIO ? "NEAR_UNIQUE" : "NON_UNIQUE",
    });
  };
  const top = compPool.map(c => c.columnIndex);
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) evalCombo([top[a], top[b]]);     // pairs(top6)
  for (let a = 0; a < Math.min(4, top.length); a++) for (let b = a + 1; b < Math.min(4, top.length); b++) for (let c = b + 1; c < Math.min(4, top.length); c++) evalCombo([top[a], top[b], top[c]]); // triples(top4)
  compositeCandidates.sort((x, y) => y.uniquenessRatio - x.uniquenessRatio);
  compositeCandidates.length = Math.min(compositeCandidates.length, 10);

  // 1:N 관계 — sale 성격(판매/견적/프로젝트) + assignment 성격(수행/배정/순번)
  const saleCand = candidateColumns.find(c => /(판매|견적|프로젝트|진행)/.test(c.originalHeader) && c.classification !== "UNUSABLE" && c.classification !== "MOSTLY_NULL");
  const asgCand = candidateColumns.find(c => /(수행|배정|순번|통번역사)/.test(c.originalHeader) && c.classification !== "UNUSABLE");
  let relationAnalysis: IdentityRelation = { available: false, reason: "sale 성격 ID 후보 없음" };
  if (saleCand) {
    const si = saleCand.columnIndex, ai = asgCand?.columnIndex;
    const bySale = new Map<string, { rows: number; trans: Set<string>; asg: Set<string>; sourceRows: number[] }>();
    const tIdx = headers.findIndex(h => /(통번역사명|통역사명|번역사명|수행자명)/.test(h));
    for (const r of rows) {
      const sv = serCell(r.rawRow[si]); if (sv == null) continue;
      let e = bySale.get(sv); if (!e) { e = { rows: 0, trans: new Set(), asg: new Set(), sourceRows: [] }; bySale.set(sv, e); }
      e.rows++; if (e.sourceRows.length < 10) e.sourceRows.push(r.sourceRow);
      if (tIdx >= 0) { const tv = serCell(r.rawRow[tIdx]); if (tv) e.trans.add(tv); }
      if (ai != null) { const av = serCell(r.rawRow[ai]); if (av) e.asg.add(av); }
    }
    let multi = 0, maxRows = 0, sum = 0;
    for (const e of bySale.values()) { if (e.rows > 1) multi++; if (e.rows > maxRows) maxRows = e.rows; sum += e.rows; }
    const samples = [...bySale.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, 5)
      .map(([saleId, e]) => ({ saleId, rowCount: e.rows, translatorCount: e.trans.size, assignmentCount: e.asg.size, sourceRows: e.sourceRows }));
    relationAnalysis = { available: true, saleColumn: saleCand.originalHeader, assignmentColumn: asgCand?.originalHeader,
      totalSales: bySale.size, multiRowSales: multi, maxRowsPerSale: maxRows, avgRowsPerSale: bySale.size ? sum / bySale.size : 0, samples };
  }

  // business content 동일 그룹 → ID 후보로 구분 가능한지.
  //   content key = ID 후보 컬럼을 제외한 전 컬럼 직렬화. (ID 후보가 없으면 전체 컬럼 = row_hash 동치)
  //   이렇게 해야 "업무적으로 같아 보이나 ID 가 달라 실제로는 다른 수행건"(UNESCAP 3일) 을 한 그룹으로 모아 비교할 수 있다.
  const idIdxSet = new Set(candidateColumns.map(c => c.columnIndex));
  const contentKey = (r: ArchivePreviewRow): string => {
    const parts: string[] = [];
    for (let i = 0; i < cols; i++) { if (idIdxSet.has(i)) continue; const v = i < r.rawRow.length ? r.rawRow[i] : null; parts.push(v == null ? "\u0000" : (typeof v === "string" ? v : String(v))); }
    return parts.join("\u0001");
  };
  const byContent = new Map<string, ArchivePreviewRow[]>();
  for (const r of rows) { const a = byContent.get(contentKey(r)); if (a) a.push(r); else byContent.set(contentKey(r), [r]); }
  // 참고용: 전 컬럼(row_hash) 완전 동일(C-4D 153 상당)
  const byHash = new Map<string, number>();
  for (const r of rows) byHash.set(r.rowHash, (byHash.get(r.rowHash) ?? 0) + 1);
  let fullRows = 0, fullGroups = 0; for (const n of byHash.values()) if (n >= 2) { fullRows += n; fullGroups++; }
  // 식별자 비교용 best id 후보 = (mutable 아님) uniqueness 최고. 없으면 null.
  const bestId = candidateColumns.filter(c => !c.isMutable && c.classification !== "UNUSABLE" && c.classification !== "MOSTLY_NULL")
    .sort((a, b) => b.uniquenessRatio - a.uniquenessRatio)[0] ?? null;
  const bestIdx = bestId ? bestId.columnIndex : -1;
  const idA: IdenticalRowIdAnalysis = { idColumnUsed: bestId ? bestId.originalHeader : null,
    identicalRows: 0, identicalGroups: 0, distinguishableByIdRows: 0, distinguishableByIdGroups: 0, sameIdRows: 0, sameIdGroups: 0, missingIdRows: 0, missingIdGroups: 0,
    fullRowIdenticalRows: fullRows, fullRowIdenticalGroups: fullGroups };
  const samplesOut: IdentitySample[] = [];
  const idGroups: ArchivePreviewRow[][] = [];
  for (const arr of byContent.values()) if (arr.length >= 2) idGroups.push(arr);
  idGroups.sort((a, b) => b.length - a.length);
  for (const g of idGroups) {
    idA.identicalRows += g.length; idA.identicalGroups += 1;
    let cls: IdentitySample["classification"];
    if (bestIdx < 0) { cls = "CONTENT_IDENTICAL_ID_MISSING"; }
    else {
      const vals = g.map(r => serCell(r.rawRow[bestIdx]));
      if (vals.some(v => v == null)) cls = "CONTENT_IDENTICAL_ID_MISSING";
      else cls = new Set(vals).size === vals.length ? "CONTENT_IDENTICAL_ID_DIFFERENT" : "CONTENT_IDENTICAL_ID_SAME";
    }
    if (cls === "CONTENT_IDENTICAL_ID_DIFFERENT") { idA.distinguishableByIdRows += g.length; idA.distinguishableByIdGroups += 1; }
    else if (cls === "CONTENT_IDENTICAL_ID_SAME") { idA.sameIdRows += g.length; idA.sameIdGroups += 1; }
    else { idA.missingIdRows += g.length; idA.missingIdGroups += 1; }
    if (samplesOut.length < 5) {
      samplesOut.push({
        rowHashShort: g[0].rowHash.slice(0, 10), groupCount: g.length,
        companyName: g[0].companyName, productName: g[0].productName, classification: cls,
        members: g.slice(0, 6).map(r => ({ sourceRow: r.sourceRow,
          idValues: Object.fromEntries(candidateColumns.map(c => [c.originalHeader, serCell(r.rawRow[c.columnIndex])])) })),
      });
    }
  }

  // 결론
  const singleUnique = candidateColumns.find(c => c.classification === "UNIQUE" && !c.isMutable);
  const compUnique = compositeCandidates.find(c => c.classification === "UNIQUE");
  let conclusion: ExcelIdentityAnalysis["conclusion"];
  if (singleUnique) conclusion = { stableRowIdFound: true, recommendedIdentity: `source_type + ${singleUnique.originalHeader}`, confidence: "high",
    reason: `단일 ID 컬럼 '${singleUnique.originalHeader}' 가 전행 present + 100% unique. (cross-download 안정성은 CRM 생성값인지 사용자 확인 권장)` };
  else if (compUnique) conclusion = { stableRowIdFound: true, recommendedIdentity: `source_type + ${compUnique.columns.join(" + ")}`, confidence: "medium",
    reason: `단일 unique ID 없음. ID 성격 컬럼 조합 [${compUnique.columns.join(" + ")}] 이 100% unique(coverage ${(compUnique.coverage * 100).toFixed(1)}%).` };
  else conclusion = { stableRowIdFound: false, recommendedIdentity: null, confidence: candidateColumns.length ? "low" : "none",
    reason: candidateColumns.length ? "ID 성격 컬럼은 있으나 단일/조합 모두 100% unique 아님 — 안정성 미확인. 억지 content composite 금지." : "ID/번호/코드/순번 성격 컬럼이 전혀 없음 — per-row 안정 ID 없음." };

  return { analyzed: true, analyzedSheet: sheet.sheetName, sheetCount: sheets.length, totalRows: total, totalColumns: cols,
    headers: headerStats, candidateColumns, compositeCandidates, mutableColumns, relationAnalysis, identicalRowAnalysis: idA, representativeSamples: samplesOut, conclusion };
}

// ─── C-4I-a: Effective Record Matching DRY-RUN (판정만, DB write 없음) ─────────
// C-4H-3(판정 B: AMBIGUOUS fallback) 설계 구현. incoming(이번 파일) vs existing(기존 effective) 비교.
//   · row_hash/source_row/주민등록번호를 business identity 로 쓰지 않는다(§1·§2).
//   · stable(contextual) 키로 candidate 축소 → 유일·충분 근거일 때만 SAME/UPDATED, 아니면 AMBIGUOUS.
//   · 153 identical: INITIAL 에선 각 행 NEW(병합 금지). REUPLOAD 다중성은 SAME-set 또는 AMBIGUOUS(1:1 날조 금지).
//   · O(N+E) — stableKey 인덱스. 전체 row detail 미반환(summary+sample).

export type ArchiveMatchClassification = "NEW" | "SAME" | "UPDATED" | "AMBIGUOUS";
export interface MatchEvidence { field: string; category: string; matched: boolean }
export interface ChangedField { field: string; before: unknown; after: unknown }

// 비교에 필요한 최소 필드(주민등록번호/row_hash content/source_row 는 identity 로 쓰지 않음; rowHash 는 SAME-set 다중집합 비교에만).
export interface MatchableRow {
  id?: number | string | null;
  sourceRow: number; rowHash: string;
  recordDate: string | null; companyName: string | null; contactName: string | null;
  translatorName: string | null; productName: string | null; language: string | null;
  deliveryDate: string | null; payoutDate: string | null; payoutPretax: number | string | null;
  collectionDate: string | null; collectionStatus: string | null;
  supplyAmount: number | string | null; vatAmount: number | string | null; totalAmount: number | string | null;
  logicalGroupKey?: string | null;   // 기존 effective row 의 version chain key(incoming 은 미설정)
  effectiveVersion?: number | null;
}

// 저장(Execute)용 per-row 판정 — Preview summary 와 동일 core 를 공유(§20 Preview==Execute 일관성).
export interface RowMatchDecision {
  index: number;                     // incoming 배열 index
  classification: ArchiveMatchClassification;
  matchedExistingId: number | string | null;   // UPDATED/SAME(1:1) 시 대응 기존 row id
  matchedLogicalGroupKey: string | null;        // 기존 chain key 승계
  matchedEffectiveVersion: number | null;
  changedFields: ChangedField[];
  confidence: "high" | "medium" | "low";
  sameSet: boolean;                  // 동일내용·동일 multiplicity SAME-set 멤버(1:1 미생성)
  groupKey: string;                  // stableKey(그룹 집계용)
  candidateCount: number;
  reason: string;
}

export interface RecordMatchingSummary {
  mode: "INITIAL_IMPORT" | "REUPLOAD";
  total: number;
  counts: Record<ArchiveMatchClassification, number>;
  sameSetGroups: number;                  // 동일내용·동일 multiplicity SAME-set 그룹 수(1:1 날조 안 함)
  updatedSamples: { sourceRow: number; matchedRecordId: number | string | null; companyName: string | null; productName: string | null; confidence: "high" | "medium" | "low"; changedFields: ChangedField[]; reason: string }[];
  ambiguousSamples: { sourceRows: number[]; companyName: string | null; productName: string | null; translatorName: string | null; language: string | null; recordDate: string | null; candidateCount: number; reason: string }[];
}

export function normName(v: unknown): string { return String(v ?? "").replace(/[\s　()\[\]{}·.,\-_/'"]/g, "").toLowerCase(); }
function emptyNorm(v: unknown): string { if (v == null) return "∅"; const s = typeof v === "string" ? v.trim() : String(v); return s === "" ? "∅" : s; }
function numNorm(v: unknown): string { if (v == null || v === "") return "∅"; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? String(n) : String(v); }
// stable(contextual) 키 — mutable/금액/사람/주민번호 제외. 이 값들이 같아야 같은 업무 record 후보.
export function stableKey(r: MatchableRow): string {
  return [normName(r.companyName), normName(r.contactName), normName(r.productName), emptyNorm(r.language), emptyNorm(r.recordDate)].join("\u0001");
}
function wellFormed(r: MatchableRow): boolean { return !!(r.companyName && r.productName); }  // 최소 근거: 거래처+상품

// mutable/financial 변경 감지(= changedFields). stable 은 키로 이미 동일.
const MUTABLE_FIELDS: { field: keyof MatchableRow; kind: "text" | "num" }[] = [
  { field: "translatorName", kind: "text" }, { field: "deliveryDate", kind: "text" }, { field: "payoutDate", kind: "text" },
  { field: "payoutPretax", kind: "num" }, { field: "collectionDate", kind: "text" }, { field: "collectionStatus", kind: "text" },
  { field: "supplyAmount", kind: "num" }, { field: "vatAmount", kind: "num" }, { field: "totalAmount", kind: "num" },
];
export function diffMutable(ex: MatchableRow, inc: MatchableRow): ChangedField[] {
  const out: ChangedField[] = [];
  for (const { field, kind } of MUTABLE_FIELDS) {
    const a = kind === "num" ? numNorm(ex[field]) : emptyNorm(ex[field]);
    const b = kind === "num" ? numNorm(inc[field]) : emptyNorm(inc[field]);
    if (a !== b) out.push({ field, before: ex[field] ?? null, after: inc[field] ?? null });
  }
  return out;
}
function sameMultiset(a: MatchableRow[], b: MatchableRow[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map<string, number>();
  for (const r of a) m.set(r.rowHash, (m.get(r.rowHash) ?? 0) + 1);
  for (const r of b) { const n = (m.get(r.rowHash) ?? 0) - 1; if (n < 0) return false; m.set(r.rowHash, n); }
  return [...m.values()].every(v => v === 0);
}

// Core: incoming 각 행을 기존 effective 대비 NEW/SAME/UPDATED/AMBIGUOUS 로 판정(저장·Preview 공용).
export function matchIncomingRows(incoming: MatchableRow[], existing: MatchableRow[]): { decisions: RowMatchDecision[]; sameSetGroups: number } {
  const exIdx = new Map<string, MatchableRow[]>();
  for (const r of existing) { const k = stableKey(r); const a = exIdx.get(k); if (a) a.push(r); else exIdx.set(k, [r]); }
  const inGroups = new Map<string, number[]>();
  incoming.forEach((r, i) => { const k = stableKey(r); const a = inGroups.get(k); if (a) a.push(i); else inGroups.set(k, [i]); });
  const existingTotal = existing.length;
  const decisions = new Array<RowMatchDecision>(incoming.length);
  let sameSetGroups = 0;

  for (const [key, idxs] of inGroups) {
    const exRows = exIdx.get(key) ?? [];
    if (exRows.length === 0) {
      // 후보 없음 → NEW. 단 REUPLOAD(기존 존재)인데 stable 근거 부족이면 AMBIGUOUS 우선(§8·§12).
      for (const i of idxs) {
        const ambiguous = existingTotal > 0 && !wellFormed(incoming[i]);
        decisions[i] = { index: i, classification: ambiguous ? "AMBIGUOUS" : "NEW", matchedExistingId: null, matchedLogicalGroupKey: null, matchedEffectiveVersion: null, changedFields: [], confidence: ambiguous ? "low" : "high", sameSet: false, groupKey: key, candidateCount: 0, reason: ambiguous ? "stable 식별근거 부족(거래처/상품 결측) — NEW 확정 불가" : "신규(대응 후보 없음)" };
      }
      continue;
    }
    if (idxs.length === 1 && exRows.length === 1) {
      const ex = exRows[0], inc = incoming[idxs[0]];
      const cf = diffMutable(ex, inc);
      // 내용 변경 신호: 정규화 mutable 변경(cf) 또는 원본 내용(row_hash) 변경(비정규화 필드 — 예: 세금계산서).
      const contentChanged = ex.rowHash !== inc.rowHash;
      const isUpdate = cf.length > 0 || contentChanged;
      decisions[idxs[0]] = { index: idxs[0], classification: isUpdate ? "UPDATED" : "SAME", matchedExistingId: ex.id ?? null, matchedLogicalGroupKey: ex.logicalGroupKey ?? null, matchedEffectiveVersion: ex.effectiveVersion ?? null, changedFields: cf, confidence: "high", sameSet: false, groupKey: key, candidateCount: 1,
        reason: cf.length > 0 ? "유일 stable 후보 + mutable 변경" : contentChanged ? "유일 stable 후보 + 원본 내용 변경(비정규화 포함)" : "유일 stable 후보 + 변경 없음" };
      continue;
    }
    // 다중성(기존 ≥2 또는 신규 ≥2) — 같은 묶음 안에서도 '확실한' 1:1 만 만든다(서로 다른 실제 수행 건 자동 병합 금지).
    //   ① 내용(row_hash) 완전 동일 행끼리 1:1 → 변경 없음
    //   ② 남은 행이 기존 1 ↔ 신규 1 → 그 둘을 대응(수정/변경 없음)
    //   ③ 남은 행끼리 통번역사명이 양쪽에서 각각 유일하게 일치 → 대응(수정/변경 없음)
    //   ④ 기존 행이 모두 대응되고 남은 신규 행 → 같은 묶음의 추가 수행 건(신규)
    //   ⑤ 그 외 남은 신규 행 → 중복 의심(자동 판정 안 함). 남은 기존 행은 묶음 단위로 '존재 확인'(삭제 의심 제외)
    const exUsed = new Set<number>();
    const byHash = new Map<string, number[]>();
    exRows.forEach((e, j) => { const a = byHash.get(e.rowHash); if (a) a.push(j); else byHash.set(e.rowHash, [j]); });
    const pair = (i: number, j: number, how: string, conf: "high" | "medium") => {
      exUsed.add(j);
      const ex = exRows[j], inc = incoming[i];
      const cf = diffMutable(ex, inc);
      const changed = cf.length > 0 || ex.rowHash !== inc.rowHash;
      decisions[i] = { index: i, classification: changed ? "UPDATED" : "SAME", matchedExistingId: ex.id ?? null, matchedLogicalGroupKey: ex.logicalGroupKey ?? null, matchedEffectiveVersion: ex.effectiveVersion ?? null,
        changedFields: cf, confidence: conf, sameSet: false, groupKey: key, candidateCount: exRows.length, reason: changed ? `${how} + 내용 변경` : `${how} + 변경 없음` };
    };
    let left: number[] = [];
    for (const i of idxs) { const a = byHash.get(incoming[i].rowHash); const j = a?.find(x => !exUsed.has(x)); if (j != null) pair(i, j, "동일 묶음 내 내용 완전 일치", "high"); else left.push(i); }
    let exLeft = exRows.map((_, j) => j).filter(j => !exUsed.has(j));
    if (left.length === 1 && exLeft.length === 1) { pair(left[0], exLeft[0], "동일 묶음에서 유일하게 남은 기존 행과 대응", "medium"); left = []; exLeft = []; }
    if (left.length && exLeft.length) {
      const tn = (r: MatchableRow) => normName(r.translatorName);
      const cntInc = new Map<string, number>(), cntEx = new Map<string, number>();
      for (const i of left) { const k = tn(incoming[i]); if (k) cntInc.set(k, (cntInc.get(k) ?? 0) + 1); }
      for (const j of exLeft) { const k = tn(exRows[j]); if (k) cntEx.set(k, (cntEx.get(k) ?? 0) + 1); }
      const rest: number[] = [];
      for (const i of left) {
        const k = tn(incoming[i]);
        const j = k && cntInc.get(k) === 1 && cntEx.get(k) === 1 ? exLeft.find(x => tn(exRows[x]) === k && !exUsed.has(x)) : undefined;
        if (j != null) pair(i, j, "동일 묶음 + 통번역사명 유일 일치", "medium"); else rest.push(i);
      }
      left = rest; exLeft = exLeft.filter(j => !exUsed.has(j));
    }
    if (left.length && exLeft.length === 0) {
      for (const i of left) decisions[i] = { index: i, classification: "NEW", matchedExistingId: null, matchedLogicalGroupKey: null, matchedEffectiveVersion: null, changedFields: [], confidence: "medium", sameSet: false, groupKey: key, candidateCount: exRows.length, reason: `동일 묶음의 기존 ${exRows.length}건이 모두 대응됨 — 추가 수행 건` };
    } else if (left.length) {
      const reason = `동일 묶음(거래처·담당자·상품·언어·체결일) 안에서 대응 불확실 — 기존 미대응 ${exLeft.length}건 ↔ 신규 미대응 ${left.length}건`;
      for (const i of left) decisions[i] = { index: i, classification: "AMBIGUOUS", matchedExistingId: null, matchedLogicalGroupKey: null, matchedEffectiveVersion: null, changedFields: [], confidence: "low", sameSet: false, groupKey: key, candidateCount: exLeft.length, reason };
    }
    if (exUsed.size === exRows.length && idxs.every(i => decisions[i].classification === "SAME")) sameSetGroups++;
  }
  return { decisions, sameSetGroups };
}

// Preview 요약 — matchIncomingRows 와 동일 core(§20). 전체 detail 미반환, summary+sample(≤20).
export function analyzeRecordMatching(incoming: MatchableRow[], existing: MatchableRow[]): RecordMatchingSummary {
  const mode: RecordMatchingSummary["mode"] = existing.length > 0 ? "REUPLOAD" : "INITIAL_IMPORT";
  const { decisions, sameSetGroups } = matchIncomingRows(incoming, existing);
  const counts: Record<ArchiveMatchClassification, number> = { NEW: 0, SAME: 0, UPDATED: 0, AMBIGUOUS: 0 };
  const updatedSamples: RecordMatchingSummary["updatedSamples"] = [];
  for (const d of decisions) {
    counts[d.classification]++;
    if (d.classification === "UPDATED" && updatedSamples.length < 20) {
      const r = incoming[d.index];
      updatedSamples.push({ sourceRow: r.sourceRow, matchedRecordId: d.matchedExistingId, companyName: r.companyName, productName: r.productName, confidence: d.confidence, changedFields: d.changedFields, reason: d.reason });
    }
  }
  // AMBIGUOUS 는 그룹(stableKey) 단위 sample.
  const ambiguousSamples: RecordMatchingSummary["ambiguousSamples"] = [];
  const ambGroups = new Map<string, number[]>();
  for (const d of decisions) if (d.classification === "AMBIGUOUS") { const a = ambGroups.get(d.groupKey); if (a) a.push(d.index); else ambGroups.set(d.groupKey, [d.index]); }
  for (const [, idxs] of ambGroups) {
    if (ambiguousSamples.length >= 20) break;
    const r0 = incoming[idxs[0]], d0 = decisions[idxs[0]];
    ambiguousSamples.push({ sourceRows: idxs.slice(0, 6).map(i => incoming[i].sourceRow), companyName: r0.companyName, productName: r0.productName, translatorName: r0.translatorName, language: r0.language, recordDate: r0.recordDate, candidateCount: d0.candidateCount, reason: d0.reason });
  }
  return { mode, total: incoming.length, counts, sameSetGroups, updatedSamples, ambiguousSamples };
}
