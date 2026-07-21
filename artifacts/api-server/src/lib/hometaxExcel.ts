// ─── 홈택스 거래처목록 엑셀 파싱/분석 유틸 ────────────────────────────────────
// 거래처·담당자 "대량등록" 기능 전용. 홈택스 다운로드 파일은 헤더 위치·컬럼명·
// 데이터 타입이 제각각이므로 방어적으로 파싱한다.
//   - 시트 자동 선택(첫 데이터 시트)
//   - 헤더 행 자동 탐지(상위 여러 행을 스캔해 알려진 컬럼명이 가장 많은 행)
//   - 컬럼명 정규화 + 동의어 매칭
//   - 사업자번호 / 전화 / 날짜(엑셀 시리얼) 정규화
// analyze / execute 라우트가 공유한다. DB 접근은 하지 않는다(순수 함수).
import * as XLSX from "xlsx";

// ── 문자열 정규화 ─────────────────────────────────────────────────────────────
/** 헤더/키 비교용: 모든 공백·괄호 제거 후 소문자화 */
function normKey(s: unknown): string {
  return String(s ?? "")
    .replace(/[\s　()\[\]{}·.\-_/]/g, "")
    .toLowerCase()
    .trim();
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return String(v).trim();
}

/** 사업자등록번호 정규화: 숫자만 */
export function normalizeBusinessNumber(raw: unknown): string {
  return cellToString(raw).replace(/\D/g, "");
}

/** 사업자등록번호 형식 유효성: 10자리 숫자 */
export function isValidBusinessNumber(normalized: string): boolean {
  return /^\d{10}$/.test(normalized);
}

/** 전화/휴대폰 정규화: 숫자만. 엑셀에서 앞자리 0이 누락된 경우 보정 */
export function normalizePhone(raw: unknown): string {
  let d = cellToString(raw).replace(/\D/g, "");
  if (!d) return "";
  // 엑셀이 숫자로 저장하며 앞 0을 떨어뜨린 경우: 010→10(9~10자리), 02→2 등
  if (!d.startsWith("0")) {
    // 휴대폰(1로 시작 10자리) 또는 지역/일반번호로 추정되면 0 보정
    if (/^1\d{9}$/.test(d) || /^[1-9]\d{8,9}$/.test(d)) d = "0" + d;
  }
  return d;
}

/** 이메일 정규화: trim + 소문자 */
export function normalizeEmail(raw: unknown): string {
  return cellToString(raw).toLowerCase().trim();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/** 이름 정규화: 앞뒤 공백 제거 */
export function normalizeName(raw: unknown): string {
  return cellToString(raw).trim();
}

/** 엑셀 날짜값(시리얼 숫자 / 문자열)을 YYYY-MM-DD 로 변환. 실패 시 원문 trim */
export function normalizeDate(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && raw > 0) {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d && d.y) {
      const mm = String(d.m).padStart(2, "0");
      const dd = String(d.d).padStart(2, "0");
      return `${d.y}-${mm}-${dd}`;
    }
  }
  const s = cellToString(raw);
  // 20240131 / 2024.01.31 / 2024-01-31 / 2024/01/31 형태 정규화
  const digits = s.replace(/[^\d]/g, "");
  if (/^\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return s;
}

// ── 컬럼 동의어 ───────────────────────────────────────────────────────────────
// 각 논리 필드에 매핑될 수 있는 홈택스/일반 엑셀 헤더명 후보(정규화 전 원문 기준).
const BIZ_NO_SYNONYMS = ["사업자등록번호", "거래처등록번호", "등록번호", "사업자번호", "사업자등록번호(거래처)"];
const COMPANY_NAME_SYNONYMS = ["거래처명", "거래처상호", "상호", "상호명", "거래처", "회사명", "사업장명", "납세자명", "공급받는자상호", "공급자상호"];

export const COMPANY_COLUMN_SYNONYMS: Record<string, string[]> = {
  name: COMPANY_NAME_SYNONYMS,
  businessNumber: BIZ_NO_SYNONYMS,
  representativeName: ["대표자명", "대표자", "대표", "대표자성명", "성명(대표자)"],
  registeredAt: ["등록일자", "등록일", "개업일자", "개업일", "거래처등록일"],
  industry: ["업태", "업태명"],
  businessCategory: ["종목", "종목명", "업종", "업종명"],
  address: ["사업장주소", "주소", "사업자주소", "소재지", "사업장소재지"],
};

export const CONTACT_COLUMN_SYNONYMS: Record<string, string[]> = {
  businessNumber: BIZ_NO_SYNONYMS,
  companyName: COMPANY_NAME_SYNONYMS,
  name: ["성명", "담당자명", "담당자", "이름", "성명(담당자)", "담당자성명"],
  registeredAt: ["등록일자", "등록일", "개업일자", "개업일", "담당자등록일", "거래처등록일"],
  department: ["부서명", "부서", "소속부서", "소속"],
  mobile: ["휴대전화번호", "휴대폰", "휴대폰번호", "핸드폰", "휴대전화", "휴대폰(담당자)", "hp"],
  email: ["이메일주소", "이메일", "email", "e-mail", "전자우편", "메일"],
  officePhone: ["전화번호", "직장전화", "회사전화", "대표전화", "사업장전화", "유선전화", "연락처", "tel"],
};

// ── 헤더 탐지 & 컬럼 매핑 ─────────────────────────────────────────────────────
export interface ParsedSheet {
  sheetName: string;
  headerRowIndex: number; // 0-based within the sheet
  headers: string[];
  dataRows: unknown[][];
}

/** 시트를 aoa 로 읽어 헤더 행을 자동 탐지한다 */
export function parseWorkbook(buffer: Buffer, synonyms: Record<string, string[]>): ParsedSheet {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const allSynNorm = new Set(
    Object.values(synonyms).flat().map(normKey),
  );

  // 데이터가 있는 첫 시트 선택
  let best: { sheetName: string; headerRowIndex: number; headers: string[]; dataRows: unknown[][]; score: number } | null = null;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true });
    if (aoa.length === 0) continue;

    // 상위 최대 20행에서 헤더 후보 탐색
    const scanLimit = Math.min(20, aoa.length);
    for (let r = 0; r < scanLimit; r++) {
      const row = aoa[r] || [];
      let matchCount = 0;
      for (const cell of row) {
        const k = normKey(cell);
        if (k && allSynNorm.has(k)) matchCount++;
      }
      if (matchCount >= 2 && (!best || matchCount > best.score)) {
        best = {
          sheetName,
          headerRowIndex: r,
          headers: row.map(cellToString),
          dataRows: aoa.slice(r + 1),
          score: matchCount,
        };
      }
    }
  }

  if (!best) {
    // 헤더 탐지 실패: 첫 시트의 첫 행을 헤더로 가정(방어적 폴백)
    const sheetName = wb.SheetNames[0];
    const ws = sheetName ? wb.Sheets[sheetName] : undefined;
    const aoa: unknown[][] = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true }) : [];
    return {
      sheetName: sheetName ?? "",
      headerRowIndex: 0,
      headers: (aoa[0] ?? []).map(cellToString),
      dataRows: aoa.slice(1),
    };
  }

  return { sheetName: best.sheetName, headerRowIndex: best.headerRowIndex, headers: best.headers, dataRows: best.dataRows };
}

/** 헤더 배열에서 각 논리필드 → 컬럼 인덱스 매핑을 만든다 */
export function buildColumnMap(headers: string[], synonyms: Record<string, string[]>): Record<string, number> {
  const normHeaders = headers.map(normKey);
  const map: Record<string, number> = {};
  for (const [field, cands] of Object.entries(synonyms)) {
    let found = -1;
    // 1) 정확 일치 우선
    for (const cand of cands) {
      const ck = normKey(cand);
      const idx = normHeaders.findIndex((h) => h === ck);
      if (idx >= 0) { found = idx; break; }
    }
    // 2) 부분 포함 매칭
    if (found < 0) {
      for (const cand of cands) {
        const ck = normKey(cand);
        const idx = normHeaders.findIndex((h) => h && (h.includes(ck) || ck.includes(h)));
        if (idx >= 0) { found = idx; break; }
      }
    }
    map[field] = found;
  }
  return map;
}

/** 매핑된 컬럼 라벨(디버깅/검증 표시용): field → 실제 헤더명 or null */
export function describeColumnMap(headers: string[], colMap: Record<string, number>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [field, idx] of Object.entries(colMap)) {
    out[field] = idx >= 0 ? (headers[idx] ?? null) : null;
  }
  return out;
}

function cellAt(row: unknown[], idx: number): unknown {
  return idx >= 0 ? row[idx] : undefined;
}

/** 빈 행 여부(모든 셀 공백) */
export function isBlankRow(row: unknown[]): boolean {
  return row.every((c) => cellToString(c) === "");
}

export function getCell(row: unknown[], colMap: Record<string, number>, field: string): unknown {
  return cellAt(row, colMap[field] ?? -1);
}
