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
  representativeName: ["대표자명", "대표자", "대표자성명", "성명(대표자)"],
  registeredAt: ["등록일자", "등록일", "개업일자", "개업일", "거래처등록일"],
  industry: ["업태", "업태명"],
  businessCategory: ["종목", "종목명", "업종", "업종명"],
  address: ["사업장주소", "주소", "사업자주소", "소재지", "사업장소재지"],
  // 대량등록 템플릿 추가 컬럼(모두 companies 기존 컬럼에만 매핑 — 스키마 무변경)
  customerType: ["거래처구분", "고객구분", "고객분류", "거래처유형", "구분"],
  phone: ["대표전화", "전화", "전화번호", "회사전화", "대표번호"],
  email: ["대표이메일", "이메일", "이메일주소", "email", "e-mail", "전자우편", "메일"],
  website: ["홈페이지", "웹사이트", "website", "url", "홈페이지주소"],
  notes: ["비고", "메모", "특이사항", "참고"],
};

// ── 거래처구분(customerType) enum ──────────────────────────────────────────
// companies.customerType 는 CORPORATE | PUBLIC | INDIVIDUAL 3값만 존재한다(기존 표준값 재사용).
// 화면 필터 탭(기업/공공기관/개인)과 동일한 라벨을 허용한다. 새 taxonomy 를 만들지 않는다(§5).
export const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  CORPORATE: "기업",
  PUBLIC: "공공기관",
  INDIVIDUAL: "개인",
};

/** 엑셀의 거래처구분 원문 → DB customerType. 빈값이면 null(=기본 CORPORATE 처리), 허용 외 값이면 undefined(오류). */
export function parseCustomerType(raw: unknown): string | null | undefined {
  const s = cellToString(raw).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (up === "CORPORATE" || up === "PUBLIC" || up === "INDIVIDUAL") return up;
  // 한글 라벨 매핑(기존 UI 표준값 + 흔한 동의어)
  const k = s.replace(/[\s·()]/g, "");
  if (["기업", "법인", "회사", "기업체"].includes(k)) return "CORPORATE";
  if (["공공기관", "정부", "정부공공기관", "공공", "관공서", "교육연구기관", "협회단체", "협회", "단체"].includes(k)) return "PUBLIC";
  if (["개인", "개인사업자", "개인고객"].includes(k)) return "INDIVIDUAL";
  return undefined; // 허용 외 값 → 오류로 처리
}

/** 거래처명 중복비교용 정규화키: (주)·주식회사·공백·기호 제거 + 소문자. 원본은 훼손하지 않는다(§8). */
export function normalizeCompanyNameKey(raw: unknown): string {
  return cellToString(raw)
    .replace(/\(주\)|\（주\）|㈜|주식회사|\(유\)|㈜|유한회사|\(재\)|재단법인|\(사\)|사단법인/g, "")
    .replace(/[\s　()\[\]{}·.,\-_/'"]/g, "")
    .toLowerCase()
    .trim();
}

export const CONTACT_COLUMN_SYNONYMS: Record<string, string[]> = {
  businessNumber: BIZ_NO_SYNONYMS,
  companyName: COMPANY_NAME_SYNONYMS,
  name: ["성명", "담당자명", "담당자", "이름", "성명(담당자)", "담당자성명"],
  registeredAt: ["등록일자", "등록일", "개업일자", "개업일", "담당자등록일", "거래처등록일"],
  department: ["부서명", "부서", "소속부서", "소속"],
  position: ["직책", "직위", "직급", "position", "title"],
  mobile: ["휴대전화번호", "휴대폰", "휴대폰번호", "핸드폰", "휴대전화", "휴대폰(담당자)", "hp"],
  email: ["이메일주소", "이메일", "email", "e-mail", "전자우편", "메일"],
  officePhone: ["전화번호", "직장전화", "회사전화", "대표전화", "사업장전화", "유선전화", "연락처", "tel"],
};

// ── 통번역사(3차) 대량등록/다운로드 컬럼 동의어 ─────────────────────────────
// 민감정보(주민번호·계좌·해외송금 등)는 이 매핑에 절대 포함하지 않는다(§4·§5·§14).
export const TRANSLATOR_COLUMN_SYNONYMS: Record<string, string[]> = {
  name: ["성명", "이름", "통번역사명", "통역사명", "번역사명", "담당자명"],
  email: ["이메일", "이메일주소", "email", "e-mail", "전자우편", "메일"],
  englishName: ["영문명", "영문이름", "영어이름", "english name", "englishname"],
  phone: ["휴대폰", "휴대전화", "휴대폰번호", "핸드폰", "휴대전화번호", "hp", "mobile", "연락처"],
  region: ["활동지역", "지역", "거주지역", "활동가능지역"],
  languages: ["가능언어", "언어", "언어쌍", "언어페어", "언어방향", "language pairs", "languagepairs"],
  services: ["가능서비스", "업무유형", "서비스", "가능업무"],
  specializations: ["전문분야", "세부전문분야", "전문", "분야", "specialization"],
  education: ["최종학력", "학력", "education"],
  major: ["전공", "major"],
  graduationYear: ["졸업년도", "졸업연도", "졸업", "graduation year", "graduationyear"],
  grade: ["인력등급", "등급", "grade"],
  availabilityStatus: ["가용상태", "활동상태", "가용", "availability"],
  bio: ["상세정보", "프로필상세", "약력", "자기소개", "소개", "경력", "주요경력", "bio"],
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

/** 헤더 배열에서 각 논리필드 → 컬럼 인덱스 매핑을 만든다.
 *  전역 2단계: (1) 모든 필드의 "정확 일치"를 먼저 확정 → (2) 남은 필드만 "부분 포함" 매칭.
 *  한 컬럼은 한 필드에만 배정한다(used). 이렇게 해야 '대표전화'가 representativeName("대표")의
 *  부분매칭에 선점되지 않고 phone 의 정확일치로 올바르게 매핑된다. */
export function buildColumnMap(headers: string[], synonyms: Record<string, string[]>): Record<string, number> {
  const normHeaders = headers.map(normKey);
  const map: Record<string, number> = {};
  const used = new Set<number>();
  const fields = Object.keys(synonyms);

  // 1) 정확 일치(전역 우선). 이미 배정된 컬럼은 건너뛴다.
  for (const field of fields) {
    let found = -1;
    for (const cand of synonyms[field]) {
      const ck = normKey(cand);
      const idx = normHeaders.findIndex((h, i) => h === ck && !used.has(i));
      if (idx >= 0) { found = idx; break; }
    }
    map[field] = found;
    if (found >= 0) used.add(found);
  }

  // 2) 부분 포함 매칭(정확 매칭에서 못 찾은 필드만). 이미 쓰인 컬럼은 제외.
  for (const field of fields) {
    if ((map[field] ?? -1) >= 0) continue;
    let found = -1;
    for (const cand of synonyms[field]) {
      const ck = normKey(cand);
      const idx = normHeaders.findIndex((h, i) => !used.has(i) && !!h && (h.includes(ck) || ck.includes(h)));
      if (idx >= 0) { found = idx; break; }
    }
    map[field] = found;
    if (found >= 0) used.add(found);
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

// ── 견적(4차) 다중 시트 파싱 ─────────────────────────────────────────────────
// 견적 대량등록 템플릿은 "견적등록"(헤더) + "견적품목"(품목) 2개 시트를 사용한다.
// 단일 최적 시트만 고르는 parseWorkbook 과 달리, 시트 이름 힌트 + 동의어 점수로 여러 시트를 각각 파싱한다.
export const QUOTE_HEADER_SYNONYMS: Record<string, string[]> = {
  tempKey: ["임시키", "연결키", "tempkey", "temp"],
  title: ["견적서명", "견적명", "견적제목", "제목"],
  quoteType: ["견적유형", "견적종류", "견적구분"],
  vatType: ["부가세", "부가가치세", "vat", "과세구분", "부가세구분", "세금구분"],
  companyCode: ["거래처코드", "고객코드"],
  businessNumber: ["사업자등록번호", "사업자번호", "등록번호"],
  companyName: ["거래처명", "거래처", "회사명", "상호"],
  contactName: ["담당자명", "담당자", "담당자성명"],
  pm: ["담당pm", "담당PM", "pm", "담당운영", "담당PM명", "담당pm명"],
  issueDate: ["견적일", "견적일자", "발행일", "issuedate"],
  validUntil: ["유효기간", "견적유효기간", "유효일", "validuntil"],
  note: ["메모", "비고", "특이사항"],
};
export const QUOTE_ITEM_SYNONYMS: Record<string, string[]> = {
  tempKey: ["임시키", "연결키", "tempkey", "temp"],
  seq: ["품목순번", "순번", "품목번호"],
  serviceMain: ["서비스대분류", "대분류", "항목유형", "서비스구분"],
  serviceType: ["서비스유형", "서비스종류", "세부유형"],
  productCode: ["상품코드", "제품코드", "productcode"],
  productName: ["상품명", "품목명", "제품명", "서비스명"],
  sourceLang: ["출발언어", "출발어", "sourcelang"],
  targetLang: ["도착언어", "도착어", "targetlang"],
  startDate: ["수행시작일", "시작일", "행사시작일", "startdate"],
  endDate: ["수행종료일", "종료일", "행사종료일", "enddate"],
  startTime: ["시작시간", "starttime"],
  endTime: ["종료시간", "endtime"],
  place: ["장소", "수행장소", "행사장소"],
  headcount: ["인원", "투입인원", "통역사수"],
  quantity: ["수량", "일수", "진행일수", "qty"],
  unit: ["단위"],
  unitPrice: ["단가", "unitprice"],
  memo: ["비고", "메모", "특이사항"],
};

/** aoa 상위 20행에서 헤더 행을 자동 탐지(알려진 동의어가 2개 이상인 행). 실패 시 0행 헤더 폴백. */
export function detectHeaderInAoa(aoa: unknown[][], synonyms: Record<string, string[]>): { headerRowIndex: number; headers: string[]; dataRows: unknown[][] } {
  const allSynNorm = new Set(Object.values(synonyms).flat().map(normKey));
  const scanLimit = Math.min(20, aoa.length);
  let bestRow = -1, bestScore = 1;
  for (let r = 0; r < scanLimit; r++) {
    const row = aoa[r] || [];
    let m = 0;
    for (const c of row) { const k = normKey(c); if (k && allSynNorm.has(k)) m++; }
    if (m >= 2 && m > bestScore) { bestScore = m; bestRow = r; }
  }
  if (bestRow < 0) return { headerRowIndex: 0, headers: (aoa[0] ?? []).map(cellToString), dataRows: aoa.slice(1) };
  return { headerRowIndex: bestRow, headers: (aoa[bestRow] || []).map(cellToString), dataRows: aoa.slice(bestRow + 1) };
}

/** 워크북에서 이름 힌트/동의어 점수로 여러 논리 시트를 각각 파싱한다. 못 찾으면 해당 key=null. */
export function parseWorkbookSheets(
  buffer: Buffer,
  specs: Record<string, { hints: string[]; synonyms: Record<string, string[]> }>,
): Record<string, ParsedSheet | null> {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const out: Record<string, ParsedSheet | null> = {};
  const used = new Set<string>();
  const aoaOf = (sn: string): unknown[][] => {
    const ws = wb.Sheets[sn];
    return ws ? (XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true }) as unknown[][]) : [];
  };
  for (const [key, spec] of Object.entries(specs)) {
    let chosen: string | null = null;
    // 1) 시트 이름 힌트(정규화 포함 매칭)
    for (const sn of wb.SheetNames) {
      if (used.has(sn)) continue;
      const nk = normKey(sn);
      if (spec.hints.some((h) => nk.includes(normKey(h)))) { chosen = sn; break; }
    }
    // 2) 동의어 점수 최고 시트(≥2)
    if (!chosen) {
      const allSyn = new Set(Object.values(spec.synonyms).flat().map(normKey));
      let bestScore = 1;
      for (const sn of wb.SheetNames) {
        if (used.has(sn)) continue;
        const aoa = aoaOf(sn);
        const scan = Math.min(20, aoa.length);
        let best = 0;
        for (let r = 0; r < scan; r++) { let m = 0; for (const c of (aoa[r] || [])) { const k = normKey(c); if (k && allSyn.has(k)) m++; } if (m > best) best = m; }
        if (best > bestScore) { bestScore = best; chosen = sn; }
      }
    }
    if (!chosen) { out[key] = null; continue; }
    used.add(chosen);
    const d = detectHeaderInAoa(aoaOf(chosen), spec.synonyms);
    out[key] = { sheetName: chosen, headerRowIndex: d.headerRowIndex, headers: d.headers, dataRows: d.dataRows };
  }
  return out;
}
