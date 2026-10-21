// ─── 거래처·담당자 대량등록(홈택스 엑셀) ──────────────────────────────────────
// 별도 라우트 파일(companies.ts 는 1,400줄 이상으로 한계 근접).
// 엔드포인트:
//   POST /admin/companies/bulk-import/analyze   거래처 파일 분석(DB 미변경)
//   POST /admin/companies/bulk-import/execute    거래처 일괄 등록/업데이트(파일 재검증 후 저장)
//   POST /admin/contacts/bulk-import/analyze     담당자 파일 분석(DB 미변경)
//   POST /admin/contacts/bulk-import/execute     담당자 일괄 등록/업데이트(파일 재검증 후 저장)
//
// 보안(§16): execute 는 클라이언트가 가공한 결과를 신뢰하지 않고 동일 파일을 다시
// 업로드받아 서버에서 재분석·재검증한 뒤 상태별로 저장한다.
//
// 등록 방식(mode):
//   new_only(기본) → 신규(new) 행만 insert. 기존 데이터는 절대 변경하지 않음.
//   update         → 신규 insert + 변경 예정(update) 행을 기존 ID 기준으로 update.
// 어떤 경우에도 기존 레코드를 삭제/재생성하지 않으며 ID·연결관계를 유지한다.
import { Router, type IRouter } from "express";
import multer from "multer";
import {
  db, companiesTable, contactsTable, companyNameHistoryTable, companyAliasesTable,
  importBatchesTable, importRowSourcesTable,
  usersTable, translatorProfilesTable, translatorEmailsTable, translatorAliasesTable,
  translatorSensitiveTable, legacyMasterMappingsTable,
  quotesTable, quoteItemsTable, projectsTable, productsTable,
} from "@workspace/db";
import { decrypt, encrypt, maskResidentNumber } from "../lib/encrypt";
import { isLegacyPlaceholderEmail } from "../lib/mailer";
import { saveSnapshot, listSnapshots, readSnapshotBuffer, getSnapshotMeta, deleteSnapshot, pruneExpired, isValidSnapshotId } from "../lib/importSnapshot";
import { sql, eq, and, desc, inArray } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { buildAliasValues } from "../lib/companyAlias";
import { buildTranslatorAliasValues } from "../lib/translatorAlias";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { getSettings } from "../lib/getSettings";
import { generateQuoteNumber, computeQuoteItemAmounts } from "./admin";
import {
  parseWorkbook, parseWorkbookSheets, buildColumnMap, describeColumnMap, isBlankRow, getCell,
  normalizeBusinessNumber, isValidBusinessNumber, normalizePhone, normalizeEmail,
  normalizeName, normalizeDate, isValidEmail,
  parseCustomerType, normalizeCompanyNameKey,
  COMPANY_COLUMN_SYNONYMS, CONTACT_COLUMN_SYNONYMS, TRANSLATOR_COLUMN_SYNONYMS,
  QUOTE_HEADER_SYNONYMS, QUOTE_ITEM_SYNONYMS,
} from "../lib/hometaxExcel";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    if (name.endsWith(".xls") || name.endsWith(".xlsx")) cb(null, true);
    else cb(new Error(".xls 또는 .xlsx 파일만 업로드할 수 있습니다."));
  },
});

// new         : 신규 등록 예정
// identical   : 기존 데이터 동일(저장 안 함)
// update      : 기존 데이터 변경 예정(update 모드에서만 저장)
// needs_review: 중복검토 — 자동 동일판정이 위험한 경우(다중 후보·전화/이메일만 일치·파일내 사업자번호 중복 등). 절대 자동 insert/update 하지 않음(§2~§7).
// duplicate_file : 파일 내부 중복(선행 1건은 신규로 등록, 후행은 제외)
// conflict    : 기존 Master 와 동일인으로 식별되나 일부 필드가 기존 값과 충돌(§req2). 자동 반영 금지·별도 검토.
// error       : 오류
type RowStatus = "new" | "identical" | "update" | "needs_review" | "duplicate_file" | "conflict" | "error";
type ImportMode = "new_only" | "update";

/** 변경 필드 미리보기: 컬럼 key → { old, new }(표시용 원문) */
type ChangeMap = Record<string, { old: string; new: string }>;

function parseMode(raw: unknown): ImportMode {
  return raw === "update" ? "update" : "new_only";
}

function decodeFileName(raw: string | undefined): string {
  if (!raw) return "";
  // multer 는 Content-Disposition 을 latin1 로 파싱 → UTF-8 재디코딩
  try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; }
}

/** 변경 필드 계산. 엑셀 값이 비어있으면(정규화 후) 기존값을 보존한다(덮어쓰지 않음). */
interface FieldDiff { key: string; excel: string; db: string; norm?: (s: string) => string; }
function diffFields(defs: FieldDiff[]): ChangeMap {
  const out: ChangeMap = {};
  for (const d of defs) {
    const norm = d.norm ?? ((s: string) => s.trim());
    const ex = norm(d.excel);
    if (ex === "") continue;            // 엑셀 공란 → 기존값 보존
    if (ex === norm(d.db)) continue;    // 동일 → 변경 아님
    out[d.key] = { old: d.db, new: d.excel };
  }
  return out;
}

function summarize(rows: { status: RowStatus; warning?: string }[]) {
  return {
    total: rows.length,
    new: rows.filter((r) => r.status === "new").length,
    identical: rows.filter((r) => r.status === "identical").length,
    update: rows.filter((r) => r.status === "update").length,
    needsReview: rows.filter((r) => r.status === "needs_review").length,
    duplicateFile: rows.filter((r) => r.status === "duplicate_file").length,
    conflict: rows.filter((r) => r.status === "conflict").length,
    error: rows.filter((r) => r.status === "error").length,
    // 경고(§9): 저장은 가능하나 확인이 필요한 행(사업자번호 없음·이메일 형식 의심 등). status 와 독립.
    warning: rows.filter((r) => !!r.warning).length,
  };
}

// ── 거래처 분석 ───────────────────────────────────────────────────────────────
interface CompanyRow {
  rowNumber: number;
  status: RowStatus;
  reason?: string;
  warning?: string;             // 경고(저장 가능하나 확인 필요) — status 와 독립(§9)
  existingId?: number | null;   // update/기존일치 대상의 기존 거래처 ID
  changes?: ChangeMap;          // update 행의 변경 필드 미리보기
  // 개인고객(INDIVIDUAL) 중복 후보의 매칭 기존 레코드(§9) — 사용자가 직접 비교할 수 있도록 표시.
  matchDetail?: { id: number; name: string; email: string | null; phone: string | null; fields: string[] } | null;
  name: string;
  businessNumber: string;      // 원문(표시용)
  businessNumberNorm: string;  // 숫자만
  representativeName: string;
  registeredAt: string;
  industry: string;
  businessCategory: string;
  address: string;
  // 템플릿 추가 컬럼(기존 companies 컬럼에만 매핑)
  customerType: string;         // 원문(표시용)
  customerTypeValue: string | null; // DB 저장값 CORPORATE|PUBLIC|INDIVIDUAL, 빈값이면 null
  phone: string;
  email: string;
  website: string;
  notes: string;
}

/** 대량등록으로 update 가능한 거래처 필드만: key → 실제 저장값 getter.
 *  등록일(registeredAt)은 최초등록일로 불변(§10) — 신규등록 시에만 생성되고 기존거래처 update 로는 절대 바뀌지 않는다. */
const COMPANY_UPDATE_FIELDS: Record<string, (r: CompanyRow) => string | null> = {
  name: (r) => r.name,
  representativeName: (r) => r.representativeName || null,
  industry: (r) => r.industry || null,
  businessCategory: (r) => r.businessCategory || null,
  address: (r) => r.address || null,
};

interface ImportDiagnostics {
  // 진단 모드: 개인고객(INDIVIDUAL) 파일이면 "individual"(사업자번호 패널 대신 개인고객 통계 표시, §11).
  mode: "business" | "individual";
  totalRows: number; rowsNoBiz: number; rowsInvalidBiz: number; rowsWithValidBiz: number;
  uniqueBizGroups: number; dupGroupCount: number; dupGroupRowCount: number; singleBizGroupCount: number;
  groupsDiffPhone: number; groupsDiffEmail: number; reviewConflictGroups: number;
  dbBizExactMatchUnique: number; newUniqueBiz: number; finalUniqueMasters: number;
  // ── 개인고객 전용 통계(§11) — mode==="individual" 일 때 의미 있음. 사업자번호와 무관. ──
  indivTotalRows: number;          // 개인고객 행 수
  indivUniqueCandidates: number;   // unique 개인고객 후보 수(이름+휴대폰+이메일 조합)
  indivNewRegistrable: number;     // 신규등록 가능(동명이인 포함 — 이름 같아도 연락처 다르면 등록)
  indivFileExactDup: number;       // 파일 내 완전중복(이름+휴대폰+이메일 모두 동일 = 같은 행 반복)
  indivHomonymGroups: number;      // 동명이인 그룹 수(같은 이름·다른 연락처 → 모두 등록 가능)
  indivDbExactDup: number;         // 기존 개인고객과 완전동일(이미 등록됨·제외)
  indivPhoneOnly: number;          // 휴대폰 일치·이름 다름(검토 후보, 등록 허용)
  indivEmailOnly: number;          // 이메일 일치·이름 다름(검토 후보, 등록 허용)
  indivErrors: number;             // 오류
}

async function analyzeCompanies(buffer: Buffer, opts?: { forceCustomerType?: "INDIVIDUAL" }): Promise<{
  sheetName: string; headerRowIndex: number; columnMap: Record<string, string | null>;
  rows: CompanyRow[]; diagnostics: ImportDiagnostics;
}> {
  // 전용 '개인고객 대량등록' 모드: 파일에 거래처구분 컬럼이 없어도 모든 행을 INDIVIDUAL 로 처리한다(명시적 선택).
  //   사업자(홈택스) Import 에는 영향 없음 — 이 옵션이 없으면 기존과 100% 동일하게 동작한다.
  const forceIndividual = opts?.forceCustomerType === "INDIVIDUAL";
  const parsed = parseWorkbook(buffer, COMPANY_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, COMPANY_COLUMN_SYNONYMS);

  // 기존 거래처 전체 조회(사업자번호 정규화 키 + 거래처명 정규화 키). 비교/업데이트에 필요한 필드 포함.
  // 휴지통(soft delete) 거래처는 중복비교 대상에서 제외한다.
  const existing = await db
    .select({
      id: companiesTable.id,
      biz: sql<string>`regexp_replace(coalesce(${companiesTable.businessNumber}, ''), '[^0-9]', '', 'g')`,
      name: companiesTable.name,
      representativeName: companiesTable.representativeName,
      registeredAt: companiesTable.registeredAt,
      industry: companiesTable.industry,
      businessCategory: companiesTable.businessCategory,
      address: companiesTable.address,
      phone: companiesTable.phone,
      email: companiesTable.email,
    })
    .from(companiesTable)
    .where(sql`${companiesTable.deletedAt} is null`);

  // 다중 후보 보존(§4): 동일 key 에 기존 거래처가 여러 개면 배열로 모두 유지한다.
  //   하나만 남기고 임의 선택하지 않는다 → 후보 2개 이상이면 중복검토로 처리(§2).
  //   대표전화/대표이메일은 회사 unique key 가 아니므로(§3) 단독 자동 매칭에 쓰지 않고
  //   "보조 신호(중복검토 유발)"로만 쓴다.
  type Existing = (typeof existing)[number];
  const pushCand = (m: Map<string, Existing[]>, key: string, e: Existing) => {
    const arr = m.get(key);
    if (arr) arr.push(e); else m.set(key, [e]);
  };
  const existingByBiz = new Map<string, Existing[]>();
  const existingByName = new Map<string, Existing[]>();
  const existingByPhone = new Map<string, Existing[]>();
  const existingByEmail = new Map<string, Existing[]>();
  for (const e of existing) {
    if (e.biz && e.biz.length > 0) pushCand(existingByBiz, e.biz, e);
    const nk = normalizeCompanyNameKey(e.name);
    if (nk) pushCand(existingByName, nk, e);
    const ph = normalizePhone(e.phone);
    if (ph) pushCand(existingByPhone, ph, e);
    const em = normalizeEmail(e.email);
    if (em) pushCand(existingByEmail, em, e);
  }

  // 파일 내부 사업자번호 그룹 사전탐지(§5·§6): 같은 파일에 동일 사업자번호가 여러 행 있어도
  //   "모두 제외"하지 않는다. 그 사업자번호가 DB Master 에 없으면, 정보가 가장 완전한 대표 행 1개를
  //   신규 Master 로 생성하고 나머지 행은 "동일 사업자번호 source(파일내중복)"로 둔다(회사 N개 생성 금지).
  //   단, 같은 사업자번호에 실질적으로 다른 거래처명이 섞여 있으면(법인표기 정규화 후에도 상이) 자동 선택
  //   금지 → 그룹 전체 검토(§7). completeness = 이름·대표자·주소·전화·이메일 중 채워진 개수.
  const fileBizCount = new Map<string, number>();
  const fileBizNameKeys = new Map<string, Set<string>>();               // biz → 정규화 거래처명 집합(충돌 판정)
  const fileBizRep = new Map<string, { rowNumber: number; score: number }>(); // biz → 대표 행(정보 완전성 최고)
  parsed.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const bn = normalizeBusinessNumber(normalizeName(getCell(raw, colMap, "businessNumber")));
    if (!bn) return;
    const rowNumber = parsed.headerRowIndex + 2 + i;
    fileBizCount.set(bn, (fileBizCount.get(bn) ?? 0) + 1);
    const nk = normalizeCompanyNameKey(normalizeName(getCell(raw, colMap, "name")));
    if (nk) { const s = fileBizNameKeys.get(bn) ?? new Set<string>(); s.add(nk); fileBizNameKeys.set(bn, s); }
    const score = [
      normalizeName(getCell(raw, colMap, "name")),
      normalizeName(getCell(raw, colMap, "representativeName")),
      normalizeName(getCell(raw, colMap, "address")),
      normalizeName(getCell(raw, colMap, "phone")),
      normalizeName(getCell(raw, colMap, "email")),
    ].filter(Boolean).length;
    const cur = fileBizRep.get(bn);
    if (!cur || score > cur.score) fileBizRep.set(bn, { rowNumber, score }); // 동점이면 선행 행 유지
  });

  const seenNameInFile = new Set<string>();
  // 개인고객(INDIVIDUAL) 파일 내부 중복 감지용 — 사업자 로직과 완전 분리(§2).
  //   등록 규칙: 이름이 같아도 휴대폰이나 이메일이 다르면 서로 다른 사람 → 등록 허용(동명이인).
  //   오직 이름+휴대폰+이메일이 "모두 동일"할 때만 같은 사람 재입력으로 보고 제외한다.
  const indivTuple = new Set<string>();  // `${nameKey}|${phone}|${email}` 완전 동일(=같은 사람 재입력)
  const indivPhone = new Map<string, { row: number; nameKey: string }>();  // 휴대폰 일치·이름 다름(검토 후보) 안내용
  const indivEmail = new Map<string, { row: number; nameKey: string }>();  // 이메일 일치·이름 다름(검토 후보) 안내용
  const rows: CompanyRow[] = [];

  parsed.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const rowNumber = parsed.headerRowIndex + 2 + i; // 엑셀 기준 1-based 행번호

    const name = normalizeName(getCell(raw, colMap, "name"));
    const bizRaw = normalizeName(getCell(raw, colMap, "businessNumber"));
    const bizNorm = normalizeBusinessNumber(bizRaw);
    const nameKey = normalizeCompanyNameKey(name);
    const ctRaw = normalizeName(getCell(raw, colMap, "customerType"));
    const ctParsed = parseCustomerType(ctRaw); // null=빈값, undefined=허용외, or CORPORATE|PUBLIC|INDIVIDUAL
    const emailNorm = normalizeEmail(getCell(raw, colMap, "email"));
    const row: CompanyRow = {
      rowNumber,
      status: "new",
      name,
      businessNumber: bizRaw,
      businessNumberNorm: bizNorm,
      representativeName: normalizeName(getCell(raw, colMap, "representativeName")),
      registeredAt: normalizeDate(getCell(raw, colMap, "registeredAt")),
      industry: normalizeName(getCell(raw, colMap, "industry")),
      businessCategory: normalizeName(getCell(raw, colMap, "businessCategory")),
      address: normalizeName(getCell(raw, colMap, "address")),
      customerType: forceIndividual ? (ctRaw || "개인고객") : ctRaw,
      customerTypeValue: forceIndividual ? "INDIVIDUAL" : (ctParsed === undefined ? null : ctParsed),
      phone: normalizeName(getCell(raw, colMap, "phone")),
      email: emailNorm,
      website: normalizeName(getCell(raw, colMap, "website")),
      notes: normalizeName(getCell(raw, colMap, "notes")),
    };

    // ── 개인고객(INDIVIDUAL) 전용 중복판정 ────────────────────────────────
    // 등록 규칙(사용자 확정): 이름이 같아도 휴대폰이나 이메일이 "다르면" 서로 다른 사람 → 등록 허용(동명이인).
    //   같은 사람으로 보고 제외하는 경우는 이름+휴대폰+이메일이 "모두 동일"할 때뿐이다.
    //     · 파일 내 완전 동일  → duplicate_file(같은 행 반복)
    //     · 기존 DB와 완전 동일 → identical(이미 등록됨)
    //   이름이 다른데 휴대폰/이메일만 겹치는 경우(예: 개인고객 vs 기존 사업자 대표이메일)는 등록을 막지 않고
    //   경고 + 매칭 레코드만 표시한다(§5·§6, 자동병합/자동UPDATE 없음). 사업자번호 grouping 은 사용하지 않는다.
    if (row.customerTypeValue === "INDIVIDUAL") {
      const phoneN = normalizePhone(row.phone);
      const emailN = row.email; // parse 시 이미 normalizeEmail 적용됨
      const nk = nameKey;
      const tupleKey = `${nk}|${phoneN}|${emailN}`; // 이름+휴대폰+이메일 완전 동일 판정용(빈값도 값으로 취급)
      const mkDetail = (e: Existing, fields: string[]) => ({ id: e.id, name: e.name, email: e.email ?? null, phone: e.phone ?? null, fields });

      if (!name) { row.status = "error"; row.reason = "성명 누락"; rows.push(row); return; }

      // 기존 DB에서 이름+휴대폰+이메일이 모두 동일한 개인고객(=이미 등록된 동일인)
      const dbNameCands = nk ? (existingByName.get(nk) ?? []) : [];
      const dbExact = dbNameCands.find((e) => normalizePhone(e.phone) === phoneN && normalizeEmail(e.email) === emailN);
      // 이름은 다른데 휴대폰/이메일만 같은 기존 레코드 → 등록 허용하되 검토 후보로 안내(차단/병합 아님).
      const dbPhoneOnly = phoneN ? (existingByPhone.get(phoneN) ?? []).filter((e) => normalizeCompanyNameKey(e.name) !== nk) : [];
      const dbEmailOnly = emailN ? (existingByEmail.get(emailN) ?? []).filter((e) => normalizeCompanyNameKey(e.name) !== nk) : [];

      if (indivTuple.has(tupleKey)) {
        // 파일 내 이름+휴대폰+이메일 모두 동일 → 같은 사람 재입력 → 제외.
        row.status = "duplicate_file"; row.reason = "파일 내 이름+휴대폰+이메일 모두 동일";
      } else if (dbExact) {
        // 기존 개인고객과 완전 동일 → 이미 등록됨(등록 제외). 자동 UPDATE 하지 않음.
        row.status = "identical"; row.existingId = dbExact.id;
        row.reason = "기존 개인고객과 동일 (이름+휴대폰+이메일 일치)";
        row.matchDetail = mkDetail(dbExact, ["이름", "휴대전화", "이메일"]);
      } else {
        // 등록 대상. 이름이 같아도 휴대폰/이메일이 다르면 동명이인으로 등록(new).
        //   이름 다름 + 연락처 단독 일치면 경고 + 매칭 레코드만 표시(등록 차단하지 않음).
        row.status = "new";
        const warns: string[] = [];
        if (dbEmailOnly.length > 0) { const e = dbEmailOnly[0]; warns.push(`기존 거래처 #${e.id} ${e.name} 와 이메일 일치 — 동일인 여부 확인`); row.existingId = e.id; row.matchDetail = mkDetail(e, ["이메일"]); }
        else if (dbPhoneOnly.length > 0) { const e = dbPhoneOnly[0]; warns.push(`기존 거래처 #${e.id} ${e.name} 와 휴대전화 일치 — 동일인 여부 확인`); row.existingId = e.id; row.matchDetail = mkDetail(e, ["휴대전화"]); }
        else if (emailN && indivEmail.has(emailN) && indivEmail.get(emailN)!.nameKey !== nk) { warns.push(`파일 내 다른 이름과 이메일 일치 (${indivEmail.get(emailN)!.row}행)`); }
        else if (phoneN && indivPhone.has(phoneN) && indivPhone.get(phoneN)!.nameKey !== nk) { warns.push(`파일 내 다른 이름과 휴대전화 일치 (${indivPhone.get(phoneN)!.row}행)`); }
        if (row.email && !isValidEmail(row.email)) warns.push("이메일 형식 의심");
        if (warns.length > 0) row.warning = warns.join(" · ");
      }

      // 후행 행 비교용 파일 내부 상태 기록(error 제외한 모든 개인고객 행).
      indivTuple.add(tupleKey);
      if (phoneN && !indivPhone.has(phoneN)) indivPhone.set(phoneN, { row: rowNumber, nameKey: nk });
      if (emailN && !indivEmail.has(emailN)) indivEmail.set(emailN, { row: rowNumber, nameKey: nk });

      rows.push(row);
      return;
    }

    // ── 검증(§9) + 동일성 판정 우선순위(§2~§5) ───────────────────────────
    // 판정 원칙: 자동 "기존거래처 일치"는 후보가 정확히 1개일 때만. 후보가 여러 개거나
    //   근거가 약하면(전화/이메일만 일치·이름만 유사) 임의 선택하지 않고 중복검토로 넘긴다.
    // 우선순위:
    //   0) 필수/형식 검증(거래처명·거래처구분·사업자번호 형식)
    //   1) 파일 내 사업자번호 중복 → 중복검토(양쪽 모두 자동등록 금지, CASE 9)
    //   2) 사업자번호 exact: 후보 1개 → 기존거래처 일치 / 후보 2개↑ → 중복검토
    //   3) (사업자번호 없음) 거래처명 exact: 후보 1개 → 기존거래처 일치 / 후보 2개↑ → 중복검토
    //   4) (사업자번호 없음) 파일 내 거래처명 중복 → 파일내부중복
    //   5) 대표전화/대표이메일만 일치 → 중복검토(단독 식별키 금지, §3)
    //   6) 그 외 → 신규등록
    const bizCands = bizNorm ? (existingByBiz.get(bizNorm) ?? []) : [];
    const nameCands = nameKey ? (existingByName.get(nameKey) ?? []) : [];
    const phoneNorm = normalizePhone(row.phone);
    const phoneCands = phoneNorm ? (existingByPhone.get(phoneNorm) ?? []) : [];
    const emailCands = row.email ? (existingByEmail.get(row.email) ?? []) : [];

    // 거래처구분(customerType)은 VERITAS 내부 관리값이며 홈택스엔 존재하지 않는다(§3·§7).
    //   값이 없거나(빈값→null) 인식 불가한 값이어도 정상 사업자를 오류 처리하지 않는다.
    //   인식 불가값은 아래 신규등록 분기에서 경고만 남기고 NULL→기본 CORPORATE 로 저장된다.
    //   (row.customerTypeValue 는 ctParsed===undefined 이면 이미 null 로 세팅되어 있다.)
    if (!name) { row.status = "error"; row.reason = "거래처명 누락"; }
    else if (bizRaw && !isValidBusinessNumber(bizNorm)) { row.status = "error"; row.reason = "사업자등록번호 형식 오류"; }
    else if (bizCands.length >= 2) {
      // 동일 사업자번호에 기존 거래처가 복수 존재(비정상) → 임의 선택 금지(§2 우선순위 1 단서).
      row.status = "needs_review"; row.reason = "동일 사업자등록번호 기존 거래처 복수 (중복검토)";
    }
    else if (bizCands.length === 1) {
      // 사업자번호 정확 일치 + 후보 1개 → 매우 강한 동일 거래처(§2·§4). 기존 Master 사용(파일 내 중복이어도).
      const ex = bizCands[0];
      // 등록일(registeredAt)은 불변(§10)이므로 변경비교 대상에서 제외한다.
      const changes = diffFields([
        { key: "name", excel: row.name, db: ex.name ?? "" },
        { key: "representativeName", excel: row.representativeName, db: ex.representativeName ?? "" },
        { key: "industry", excel: row.industry, db: ex.industry ?? "" },
        { key: "businessCategory", excel: row.businessCategory, db: ex.businessCategory ?? "" },
        { key: "address", excel: row.address, db: ex.address ?? "" },
      ]);
      row.existingId = ex.id;
      if (Object.keys(changes).length === 0) { row.status = "identical"; row.reason = "기존 데이터 동일"; }
      else { row.status = "update"; row.reason = "기존 데이터 변경 예정"; row.changes = changes; }
    }
    // ── 파일 내부 동일 사업자번호 그룹 + DB Master 없음(§5·§6·§7) ──────────────
    // 대표 행 1개만 신규 Master 로 생성하고 나머지는 통합(중복). 상이 거래처명 섞이면 그룹 전체 검토.
    else if (bizNorm && (fileBizCount.get(bizNorm) ?? 0) >= 2 && (fileBizNameKeys.get(bizNorm)?.size ?? 0) >= 2) {
      row.status = "needs_review"; row.reason = "동일 사업자등록번호·상이 거래처명 (검토 필요)";
    }
    else if (bizNorm && (fileBizCount.get(bizNorm) ?? 0) >= 2 && fileBizRep.get(bizNorm)?.rowNumber !== rowNumber) {
      // 비대표 행 → 등록하지 않고 동일 사업자번호 source 로 표시(대표 행이 Master 를 생성).
      row.status = "duplicate_file"; row.reason = "동일 사업자번호 대표행으로 통합(비대표 source)";
    }
    // (대표 행·충돌 없음)은 아래 흐름을 그대로 타서 신규 Master(new)로 생성된다.
    else if (!bizNorm && nameCands.length >= 2) {
      // 동일 정규화 거래처명에 기존 거래처가 복수 → 임의 선택 금지(§2 우선순위 2 단서).
      row.status = "needs_review"; row.reason = "동일 거래처명 기존 거래처 복수 (중복검토)";
    }
    else if (!bizNorm && nameCands.length === 1) {
      // 사업자번호가 없고 거래처명 정확 일치(후보 1개) → 기존 거래처로 간주(등록 제외). 자동 UPDATE 안 함(§6).
      row.existingId = nameCands[0].id;
      row.status = "identical";
      row.reason = "기존 거래처명 일치 (등록 제외)";
    }
    else if (!bizNorm && nameKey && seenNameInFile.has(nameKey)) { row.status = "duplicate_file"; row.reason = "파일 내부 중복(거래처명)"; }
    else if (phoneCands.length > 0 || emailCands.length > 0) {
      // 사업자번호·거래처명 근거가 없고 대표전화/대표이메일만 일치 → 자동 매칭 금지, 중복검토(§3·§5 우선순위 4).
      const sig = phoneCands.length > 0 ? "대표전화" : "대표이메일";
      row.status = "needs_review"; row.reason = `${sig}만 일치 (자동매칭 금지·중복검토)`;
    }
    else {
      // 신규 등록 대상. 파일 내 재중복 방지용 키 기록(사업자번호 없는 행은 거래처명으로).
      if (!bizNorm && nameKey) seenNameInFile.add(nameKey);
      // 경고(§9): 저장은 하되 확인 권장. 여러 경고가 겹치면 함께 표시한다.
      const warns: string[] = [];
      if (!bizNorm) warns.push("사업자등록번호 없음");
      if (row.email && !isValidEmail(row.email)) warns.push("이메일 형식 의심");
      // 거래처구분 값이 있으나 기업/공공기관/개인으로 인식 불가 → 기본 CORPORATE(기업)로 저장(§3·§7).
      if (ctParsed === undefined) warns.push(`거래처구분 미인식('${ctRaw}') → 기업으로 처리`);
      if (warns.length > 0) row.warning = warns.join(" · ");
    }

    rows.push(row);
  });

  // ── 진단 통계(읽기전용, 2단계 조사 §13) ─────────────────────────────────────
  // 사업자번호 canonical(10자리) 기준으로 grouping 하여 "행 수"와 "unique 거래처 수"를 분리한다.
  //   앱 분류는 "파일 내부 사업자번호 중복" 검사가 DB 매칭보다 우선순위가 높아 기존 거래처 일치가
  //   가려지므로(masking), 여기서는 그 가림을 풀어 기존 535 대비 exact match 를 독립 집계한다.
  //   추가 DB 조회 없음(위에서 만든 existingByBiz 재사용). 저장/변경 없음.
  const bizGroups = new Map<string, CompanyRow[]>();
  for (const r of rows) {
    if (r.businessNumberNorm && isValidBusinessNumber(r.businessNumberNorm)) {
      const a = bizGroups.get(r.businessNumberNorm);
      if (a) a.push(r); else bizGroups.set(r.businessNumberNorm, [r]);
    }
  }
  const dupGroups = [...bizGroups.values()].filter((a) => a.length >= 2);
  const distinctCount = (xs: string[]) => new Set(xs.filter((x) => x !== "")).size;
  let groupsDiffPhone = 0, groupsDiffEmail = 0, groupsDiffName = 0;
  for (const a of dupGroups) {
    if (distinctCount(a.map((r) => normalizePhone(r.phone))) >= 2) groupsDiffPhone++;
    if (distinctCount(a.map((r) => r.email)) >= 2) groupsDiffEmail++;
    if (distinctCount(a.map((r) => normalizeCompanyNameKey(r.name))) >= 2) groupsDiffName++;
  }
  const dbMatchUnique = [...bizGroups.keys()].filter((b) => (existingByBiz.get(b)?.length ?? 0) >= 1).length;
  const noBizRows = rows.filter((r) => !r.businessNumberNorm).length;
  const invalidBizRows = rows.filter((r) => r.businessNumberNorm && !isValidBusinessNumber(r.businessNumberNorm)).length;

  // ── 개인고객(INDIVIDUAL) 전용 진단(§11) — 사업자번호와 무관. ──────────────────
  //   진단 모드: 개인고객 행이 있고 기업/공공기관 행이 없으면 individual(사업자번호 패널 대신 개인고객 통계).
  const indivRows = rows.filter((r) => r.customerTypeValue === "INDIVIDUAL");
  const hasBizType = rows.some((r) => r.customerTypeValue === "CORPORATE" || r.customerTypeValue === "PUBLIC");
  const mode: "business" | "individual" = indivRows.length > 0 && !hasBizType ? "individual" : "business";
  // 동명이인 그룹: 같은 이름키가 2행 이상이면서 서로 다른 연락처(휴대폰|이메일)가 섞여 있는 그룹.
  const indivNameGroups = new Map<string, CompanyRow[]>();
  for (const r of indivRows) { const k = normalizeCompanyNameKey(r.name); if (!k) continue; const a = indivNameGroups.get(k); if (a) a.push(r); else indivNameGroups.set(k, [r]); }
  let indivHomonymGroups = 0;
  for (const a of indivNameGroups.values()) {
    if (a.length < 2) continue;
    if (new Set(a.map((r) => `${normalizePhone(r.phone)}|${r.email}`)).size >= 2) indivHomonymGroups++;
  }
  const indivUniqueCandidates = new Set(indivRows.map((r) => `${normalizeCompanyNameKey(r.name)}|${normalizePhone(r.phone)}|${r.email}`)).size;
  const indivPhoneOnly = indivRows.filter((r) => r.status === "new" && r.matchDetail?.fields?.length === 1 && r.matchDetail.fields[0] === "휴대전화").length;
  const indivEmailOnly = indivRows.filter((r) => r.status === "new" && r.matchDetail?.fields?.length === 1 && r.matchDetail.fields[0] === "이메일").length;

  const diagnostics = {
    mode,
    indivTotalRows: indivRows.length,
    indivUniqueCandidates,
    indivNewRegistrable: indivRows.filter((r) => r.status === "new").length,
    indivFileExactDup: indivRows.filter((r) => r.status === "duplicate_file").length,
    indivHomonymGroups,
    indivDbExactDup: indivRows.filter((r) => r.status === "identical").length, // 기존 개인고객과 완전동일(제외)
    indivPhoneOnly,
    indivEmailOnly,
    indivErrors: indivRows.filter((r) => r.status === "error").length,
    totalRows: rows.length,                                          // 전체 데이터행
    rowsNoBiz: noBizRows,                                            // 사업자번호 없음
    rowsInvalidBiz: invalidBizRows,                                  // 사업자번호 형식오류
    rowsWithValidBiz: rows.length - noBizRows - invalidBizRows,      // 유효 10자리 보유 행
    uniqueBizGroups: bizGroups.size,                                 // canonical 사업자번호 unique 그룹 수
    dupGroupCount: dupGroups.length,                                 // 동일 사업자번호 ≥2행 그룹 수
    dupGroupRowCount: dupGroups.reduce((s, a) => s + a.length, 0),   // 중복 그룹에 포함된 총 행 수
    singleBizGroupCount: bizGroups.size - dupGroups.length,          // 1행짜리 사업자 수
    groupsDiffPhone,                                                 // 동일 biz 내 전화 상이 그룹 수
    groupsDiffEmail,                                                 // 동일 biz 내 이메일 상이 그룹 수
    reviewConflictGroups: groupsDiffName,                            // 동일 biz 인데 정규화 거래처명 상이 → 사람 검토
    dbBizExactMatchUnique: dbMatchUnique,                            // 기존 535 와 사업자번호 exact match unique 수(masking 해제)
    newUniqueBiz: bizGroups.size - dbMatchUnique,                    // 실제 신규 unique 사업자 수
    finalUniqueMasters: bizGroups.size + noBizRows,                  // 최종 unique Master(사업자번호 그룹 + 사업자번호 없는 행 각 별도)
  };

  return {
    sheetName: parsed.sheetName,
    headerRowIndex: parsed.headerRowIndex,
    columnMap: describeColumnMap(parsed.headers, colMap),
    rows,
    diagnostics,
  };
}

router.post(
  "/admin/companies/bulk-import/analyze",
  ...adminGuard,
  requirePermission("company.create"),
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    // importKind="individual" → 전용 개인고객 모드(모든 행 INDIVIDUAL). 미지정/기타 → 기존 사업자 거래처 처리.
    const forceCustomerType = (req.body as any)?.importKind === "individual" ? ("INDIVIDUAL" as const) : undefined;
    try {
      const result = await analyzeCompanies(req.file.buffer, { forceCustomerType });
      res.json({
        fileName: decodeFileName(req.file.originalname),
        sheetName: result.sheetName,
        headerRowIndex: result.headerRowIndex,
        columnMap: result.columnMap,
        summary: summarize(result.rows),
        diagnostics: result.diagnostics,
        rows: result.rows,
      });
    } catch (err) {
      req.log.error({ err }, "BulkImport: company analyze failed");
      res.status(500).json({ error: "엑셀 분석 실패. 파일 형식을 확인해주세요." });
    }
  },
);

router.post(
  "/admin/companies/bulk-import/execute",
  ...adminGuard,
  requirePermission("company.create"),
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    const fileName = decodeFileName(req.file.originalname);
    const mode = parseMode((req.body as any)?.mode);
    const forceCustomerType = (req.body as any)?.importKind === "individual" ? ("INDIVIDUAL" as const) : undefined;
    try {
      // 서버에서 재분석·재검증 후 상태별 저장 (analyze 와 동일 옵션으로 재검증 — §16 보안)
      const result = await analyzeCompanies(req.file.buffer, { forceCustomerType });
      const newRows = result.rows.filter((r) => r.status === "new");
      const updateRows = mode === "update"
        ? result.rows.filter((r) => r.status === "update" && r.existingId != null)
        : [];
      const summary = summarize(result.rows);
      const today = new Date().toISOString().slice(0, 10);
      const performer = { id: (req as any).user?.id ?? 0, email: (req as any).user?.email ?? "" };

      let inserted = 0;
      let updated = 0;
      let batchId: number | null = null;
      if (newRows.length > 0 || updateRows.length > 0) {
        await db.transaction(async (tx) => {
          // 0) Import Batch 기록(§12) — 이 import 실행 1건의 메타. lineage 의 부모.
          const [batch] = await tx
            .insert(importBatchesTable)
            .values({
              module: "company",
              importType: ((req.body as any)?.sourceSystem) ? "legacy_migration" : "excel_bulk",
              originalFilename: fileName || null,
              sheetName: result.sheetName || null,
              totalRows: summary.total,
              successRows: newRows.length,
              warningRows: summary.warning,
              errorRows: summary.error,
              status: "completed",
              createdBy: performer.id || null,
              sourceSystem: (req.body as any)?.sourceSystem ?? null,  // C-1(additive): legacy 이관 연계
            })
            .returning({ id: importBatchesTable.id });
          batchId = batch.id;

          // 1) 신규 batch insert (500행 청크)
          for (let i = 0; i < newRows.length; i += 500) {
            const chunk = newRows.slice(i, i + 500);
            const created = await tx
              .insert(companiesTable)
              .values(chunk.map((r) => ({
                name: r.name,
                businessNumber: r.businessNumber || null,
                representativeName: r.representativeName || null,
                phone: r.phone || null,
                email: r.email || null,
                website: r.website || null,
                industry: r.industry || null,
                businessCategory: r.businessCategory || null,
                address: r.address || null,
                notes: r.notes || null,
                registeredAt: r.registeredAt || today,
                companyType: "client",
                customerType: r.customerTypeValue ?? "CORPORATE",
              })))
              .returning({ id: companiesTable.id, name: companiesTable.name });

            // 개별 등록과 동일하게 상호 이력 기록
            await tx.insert(companyNameHistoryTable).values(created.map((c) => ({
              companyId: c.id,
              companyName: c.name,
              nameType: "current",
              validFrom: today,
              changedBy: performer.id || null,
              changedByEmail: performer.email || null,
              reason: "대량등록",
            })));

            // 공식명 기반 기본 Alias 자동 생성(§8). 정규화 결과가 비면 제외, 중복은 무시.
            const aliasValues = created
              .map((c) => buildAliasValues(c.id, c.name, true))
              .filter((v) => v.normalizedAlias);
            if (aliasValues.length > 0) {
              await tx.insert(companyAliasesTable).values(aliasValues).onConflictDoNothing();
            }

            // Source Lineage(§12) — 각 등록 거래처가 온 원본 파일/시트/행 + idempotency 비교키.
            //  created 는 단일 다중행 INSERT 결과라 chunk 와 순서가 보존된다.
            await tx.insert(importRowSourcesTable).values(created.map((c, idx) => {
              const src = chunk[idx];
              const rowKey = src.businessNumberNorm
                ? `company|biz|${src.businessNumberNorm}`
                : `company|name|${normalizeCompanyNameKey(src.name)}`;
              return {
                batchId: batch.id,
                module: "company",
                entityId: c.id,
                sourceFile: fileName || null,
                sourceSheet: result.sheetName || null,
                sourceRow: src.rowNumber,
                rowKey,
                status: "new",
              };
            }));
            inserted += created.length;
          }

          // 2) 기존 데이터 update (ID 기준, 허용 필드만). 삭제/재생성 없음.
          for (const r of updateRows) {
            const changes = r.changes ?? {};
            const set: Record<string, string | null> = {};
            for (const key of Object.keys(changes)) {
              const getter = COMPANY_UPDATE_FIELDS[key];
              if (getter) set[key] = getter(r);
            }
            if (Object.keys(set).length === 0) continue;
            await tx.update(companiesTable).set(set).where(eq(companiesTable.id, r.existingId as number));

            // 상호가 바뀌면 개별 편집과 동일하게 이력 종료 + 신규 current 추가
            if (changes.name) {
              await tx.update(companyNameHistoryTable)
                .set({ validTo: today, nameType: "previous" })
                .where(and(
                  eq(companyNameHistoryTable.companyId, r.existingId as number),
                  eq(companyNameHistoryTable.nameType, "current"),
                ));
              await tx.insert(companyNameHistoryTable).values({
                companyId: r.existingId as number,
                companyName: r.name,
                nameType: "current",
                validFrom: today,
                changedBy: performer.id || null,
                changedByEmail: performer.email || null,
                reason: "대량등록 수정",
              });
            }
            updated += 1;
          }
        });
      }

      await logEvent("company", 0, "bulk_import_companies", req.log, performer.id ? performer : undefined,
        JSON.stringify({ fileName, mode, batchId, total: summary.total, inserted, updated, warning: summary.warning, identical: summary.identical, needsReview: summary.needsReview, duplicateFile: summary.duplicateFile, error: summary.error }));

      res.json({ fileName, mode, batchId, inserted, updated, summary });
    } catch (err) {
      req.log.error({ err }, "BulkImport: company execute failed");
      res.status(500).json({ error: "거래처 일괄 등록 실패." });
    }
  },
);

// ── 담당자 분석 ───────────────────────────────────────────────────────────────
// 담당자는 "어느 거래처 소속인지"가 핵심이다(§2). 거래처 연결 우선순위(§7): 사업자번호 exact →
// 거래처명 normalized exact(후보 1개만 자동연결). 거래처코드 컬럼은 스키마에 없어 제외한다.
// 중복판정(§9~§16)은 거래처와 다르게: 이메일/휴대폰 exact(동일거래처)만 강한 신호, 타 거래처면
// 자동 merge 금지(이직/공용 가능) → 중복검토. 회사전화·이름 단독은 식별키로 쓰지 않는다.
interface ContactRow {
  rowNumber: number;
  status: RowStatus;               // new | identical | needs_review | duplicate_file | error
  reason?: string;
  existingId?: number | null;      // 기존담당자 일치 시 매칭된 담당자 id(표시용)
  companyName: string;             // 파일상 표시용 거래처명
  matchedCompanyName: string;      // 실제 연결된 거래처명(확정 시)
  companyId: number | null;        // 확정 연결된 거래처 id(없으면 INSERT 금지)
  businessNumber: string;
  businessNumberNorm: string;
  name: string;
  registeredAt: string;
  department: string;
  position: string;
  mobile: string;                  // 원문 표시용(정규화 전 trimmed)
  mobileNorm: string;
  email: string;
  emailNorm: string;
  officePhone: string;
  officePhoneNorm: string;
}

type MiniCompany = { id: number; name: string; biz?: string };

/** 파일의 거래처 식별정보(사업자번호/거래처명)로 VERITAS 거래처를 확정 연결(§7·§8). */
function resolveContactCompany(
  bizNorm: string, companyNameKey: string,
  byBiz: Map<string, MiniCompany[]>, byName: Map<string, MiniCompany[]>,
): { company: MiniCompany | null; status?: "error" | "needs_review"; reason?: string } {
  const bizCands = bizNorm ? (byBiz.get(bizNorm) ?? []) : [];
  const nameCands = companyNameKey ? (byName.get(companyNameKey) ?? []) : [];

  if (bizNorm) {
    // 동일 사업자번호 Master 2건 이상(§10) → 자동연결 금지, 정확한 사유 표시.
    if (bizCands.length >= 2) return { company: null, status: "needs_review", reason: "동일 사업자번호 거래처 Master 2건 이상 존재 (검토 필요)" };
    if (bizCands.length === 1) {
      const comp = bizCands[0];
      // 사업자번호 exact 1개 → 자동연결(§8·§9). 단, 파일 거래처명이 실질적으로 다른 회사(법인표기 차이 아님)를
      //   가리키면 임의 선택 금지 → "사업자번호 일치 / 회사명 상이"로 사람 검토(§9).
      if (companyNameKey && nameCands.length > 0 && !nameCands.some((c) => c.id === comp.id)) {
        return { company: null, status: "needs_review", reason: "사업자번호 일치 / 회사명 상이 (검토 필요)" };
      }
      return { company: comp };
    }
    // 사업자번호가 있으나 canonical 일치하는 Master 없음.
    if (companyNameKey) {
      if (nameCands.length >= 2) return { company: null, status: "needs_review", reason: "거래처명 다중후보 · 사업자번호 Master 없음 (검토 필요)" };
      if (nameCands.length === 1) {
        // 거래처명은 일치하나 사업자번호가 Master 값과 다름/누락(§12 세분화).
        const nc = nameCands[0];
        return (nc.biz && nc.biz.length > 0)
          ? { company: null, status: "needs_review", reason: "회사명 일치 / 사업자번호 상이 (검토 필요)" }
          : { company: null, status: "needs_review", reason: "거래처 사업자번호 누락 (거래처명 일치) — 확인필요" };
      }
    }
    // §11: canonical 사업자번호 match 없음 + 안전한 거래처명 match 없음 → 실제 Master 부재.
    return { company: null, status: "error", reason: "거래처 미등록 (사업자번호·거래처명 모두 Master에 없음)" };
  }
  // 사업자번호 없음 → 거래처명으로만
  if (companyNameKey) {
    if (nameCands.length >= 2) return { company: null, status: "needs_review", reason: "거래처명 다중후보 (검토 필요)" };
    if (nameCands.length === 1) return { company: nameCands[0] };
    return { company: null, status: "error", reason: "거래처 미등록 (거래처명 Master에 없음)" };
  }
  return { company: null, status: "error", reason: "거래처 연결 불가(사업자번호·거래처명 없음)" };
}

/** 신규 담당자의 안정적 business key(idempotency·lineage §18·§19). 파일명과 무관. */
function contactRowKey(r: ContactRow): string {
  const base = `contact|${r.companyId}`;
  if (r.emailNorm) return `${base}|e:${r.emailNorm}`;
  if (r.mobileNorm) return `${base}|m:${r.mobileNorm}`;
  return `${base}|n:${normalizeName(r.name)}`;
}

async function analyzeContacts(buffer: Buffer): Promise<{
  sheetName: string; headerRowIndex: number; columnMap: Record<string, string | null>;
  rows: ContactRow[];
}> {
  const parsed = parseWorkbook(buffer, CONTACT_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, CONTACT_COLUMN_SYNONYMS);

  // 거래처 연결용 매핑(§7). 휴지통(soft delete) 거래처는 제외. 동일 key 다중후보는 배열로 보존(임의 선택 금지).
  const companies = await db
    .select({
      id: companiesTable.id,
      name: companiesTable.name,
      biz: sql<string>`regexp_replace(coalesce(${companiesTable.businessNumber}, ''), '[^0-9]', '', 'g')`,
    })
    .from(companiesTable)
    .where(sql`${companiesTable.deletedAt} is null`);
  const companyByBiz = new Map<string, MiniCompany[]>();
  const companyByName = new Map<string, MiniCompany[]>();
  for (const c of companies) {
    const mc: MiniCompany = { id: c.id, name: c.name, biz: c.biz };
    if (c.biz && c.biz.length > 0) { const a = companyByBiz.get(c.biz); if (a) a.push(mc); else companyByBiz.set(c.biz, [mc]); }
    const nk = normalizeCompanyNameKey(c.name);
    if (nk) { const a = companyByName.get(nk); if (a) a.push(mc); else companyByName.set(nk, [mc]); }
  }

  // 기존 담당자(활성·미삭제). 동일거래처 이메일/휴대폰/이름 + 타 거래처 이메일/휴대폰(이직·공용 탐지)용 인덱스.
  const existingContacts = await db
    .select({
      id: contactsTable.id, companyId: contactsTable.companyId,
      name: contactsTable.name, email: contactsTable.email, mobile: contactsTable.mobile,
    })
    .from(contactsTable)
    .where(sql`${contactsTable.isActive} = true and ${contactsTable.deletedAt} is null`);
  type ExC = (typeof existingContacts)[number];
  const byCompanyEmail = new Map<string, ExC>();   // `${companyId}|${emailNorm}` → 담당자
  const byCompanyMobile = new Map<string, ExC>();  // `${companyId}|${mobileNorm}`
  const byCompanyName = new Map<string, ExC[]>();   // `${companyId}|${nameNorm}` → 동명이인 배열
  const emailCompanies = new Map<string, Set<number>>();  // emailNorm → 소속 거래처 id 집합
  const mobileCompanies = new Map<string, Set<number>>(); // mobileNorm → 거래처 id 집합
  for (const c of existingContacts) {
    const em = normalizeEmail(c.email), mo = normalizePhone(c.mobile), nm = normalizeName(c.name);
    if (em) { if (!byCompanyEmail.has(`${c.companyId}|${em}`)) byCompanyEmail.set(`${c.companyId}|${em}`, c);
      const s = emailCompanies.get(em) ?? new Set(); s.add(c.companyId); emailCompanies.set(em, s); }
    if (mo) { if (!byCompanyMobile.has(`${c.companyId}|${mo}`)) byCompanyMobile.set(`${c.companyId}|${mo}`, c);
      const s = mobileCompanies.get(mo) ?? new Set(); s.add(c.companyId); mobileCompanies.set(mo, s); }
    if (nm) { const k = `${c.companyId}|${nm}`; const a = byCompanyName.get(k); if (a) a.push(c); else byCompanyName.set(k, [c]); }
  }

  const seenFileEmail = new Set<string>();
  const seenFileMobile = new Set<string>();
  const seenFileName = new Set<string>();
  const rows: ContactRow[] = [];

  parsed.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const rowNumber = parsed.headerRowIndex + 2 + i;

    const bizRaw = normalizeName(getCell(raw, colMap, "businessNumber"));
    const bizNorm = normalizeBusinessNumber(bizRaw);
    const name = normalizeName(getCell(raw, colMap, "name"));
    const companyNameRaw = normalizeName(getCell(raw, colMap, "companyName"));
    const companyNameKey = normalizeCompanyNameKey(companyNameRaw);
    const emailNorm = normalizeEmail(getCell(raw, colMap, "email"));
    const mobileNorm = normalizePhone(getCell(raw, colMap, "mobile"));
    const officeNorm = normalizePhone(getCell(raw, colMap, "officePhone"));

    const row: ContactRow = {
      rowNumber, status: "new",
      companyName: companyNameRaw, matchedCompanyName: "", companyId: null,
      businessNumber: bizRaw, businessNumberNorm: bizNorm,
      name,
      registeredAt: normalizeDate(getCell(raw, colMap, "registeredAt")),
      department: normalizeName(getCell(raw, colMap, "department")),
      position: normalizeName(getCell(raw, colMap, "position")),
      mobile: normalizeName(getCell(raw, colMap, "mobile")), mobileNorm,
      email: normalizeName(getCell(raw, colMap, "email")), emailNorm,
      officePhone: normalizeName(getCell(raw, colMap, "officePhone")), officePhoneNorm: officeNorm,
    };

    // ── 1) 필수값(§6): 담당자명 ──
    if (!name) { row.status = "error"; row.reason = "담당자명 누락"; rows.push(row); return; }

    // ── 2) 거래처 연결(§7·§8) ──
    const link = resolveContactCompany(bizNorm, companyNameKey, companyByBiz, companyByName);
    if (!link.company) { row.status = link.status ?? "error"; row.reason = link.reason; rows.push(row); return; }
    const compId = link.company.id;
    row.companyId = compId;
    row.matchedCompanyName = link.company.name;

    const nameNorm = normalizeName(name);
    const nameCompatible = (exName: string | null) => { const en = normalizeName(exName); return !en || en === nameNorm; };

    // ── 3) 중복판정(§9~§16) ──
    const sameEmail = emailNorm ? byCompanyEmail.get(`${compId}|${emailNorm}`) : undefined;
    const sameMobile = mobileNorm ? byCompanyMobile.get(`${compId}|${mobileNorm}`) : undefined;
    const sameNameList = byCompanyName.get(`${compId}|${nameNorm}`) ?? [];

    if (sameEmail) {
      // CASE A: 동일거래처 + 이메일 exact
      row.existingId = sameEmail.id;
      if (nameCompatible(sameEmail.name)) { row.status = "identical"; row.reason = "기존담당자 일치(동일 거래처·이메일)"; }
      else { row.status = "needs_review"; row.reason = "이메일 일치하나 담당자명 상이 — 확인필요"; }
    } else if (sameMobile) {
      // CASE B: 동일거래처 + 휴대폰 exact
      row.existingId = sameMobile.id;
      if (nameCompatible(sameMobile.name)) { row.status = "identical"; row.reason = "기존담당자 일치(동일 거래처·휴대폰)"; }
      else { row.status = "needs_review"; row.reason = "휴대폰 일치하나 담당자명 상이 — 확인필요"; }
    } else if (emailNorm && [...(emailCompanies.get(emailNorm) ?? [])].some((id) => id !== compId)) {
      // CASE D: 이메일이 "다른 거래처"에 존재 → 이직/공용 가능, 자동 merge 금지
      row.status = "needs_review"; row.reason = "이메일 중복(다른 거래처) — 이직/공용 가능, 확인필요";
    } else if (mobileNorm && [...(mobileCompanies.get(mobileNorm) ?? [])].some((id) => id !== compId)) {
      // CASE E: 휴대폰이 다른 거래처에 존재 → 자동 merge 금지
      row.status = "needs_review"; row.reason = "휴대폰 중복(다른 거래처) — 확인필요";
    } else if (sameNameList.length > 0) {
      // CASE C: 동일거래처 + 이름만 일치(이메일/휴대폰 없음) → 동명이인 가능성
      row.status = "needs_review"; row.reason = "동일 거래처 동명이인 가능 — 확인필요";
    } else if (emailNorm && seenFileEmail.has(`${compId}|${emailNorm}`)) {
      // 파일 내부 중복(§16): 동일거래처 + 동일 이메일
      row.status = "duplicate_file"; row.reason = "파일 내부 중복(이메일)";
    } else if (mobileNorm && seenFileMobile.has(`${compId}|${mobileNorm}`)) {
      row.status = "duplicate_file"; row.reason = "파일 내부 중복(휴대폰)";
    } else if (nameNorm && seenFileName.has(`${compId}|${nameNorm}`)) {
      // 파일 내부 동일거래처 동명 → 동명이인 가능성
      row.status = "needs_review"; row.reason = "파일 내부 동일 거래처 동명이인 가능 — 확인필요";
    } else {
      // 신규등록 대상. 파일 내 재중복 방지 키 기록.
      row.status = "new";
      if (emailNorm) seenFileEmail.add(`${compId}|${emailNorm}`);
      if (mobileNorm) seenFileMobile.add(`${compId}|${mobileNorm}`);
      if (nameNorm) seenFileName.add(`${compId}|${nameNorm}`);
    }

    rows.push(row);
  });

  return {
    sheetName: parsed.sheetName,
    headerRowIndex: parsed.headerRowIndex,
    columnMap: describeColumnMap(parsed.headers, colMap),
    rows,
  };
}

router.post(
  "/admin/contacts/bulk-import/analyze",
  ...adminGuard,
  requirePermission("contact.create"),
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    try {
      const result = await analyzeContacts(req.file.buffer);
      res.json({
        fileName: decodeFileName(req.file.originalname),
        sheetName: result.sheetName,
        headerRowIndex: result.headerRowIndex,
        columnMap: result.columnMap,
        summary: summarize(result.rows),
        rows: result.rows,
      });
    } catch (err) {
      req.log.error({ err }, "BulkImport: contact analyze failed");
      res.status(500).json({ error: "엑셀 분석 실패. 파일 형식을 확인해주세요." });
    }
  },
);

router.post(
  "/admin/contacts/bulk-import/execute",
  ...adminGuard,
  requirePermission("contact.create"),
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    const fileName = decodeFileName(req.file.originalname);
    try {
      // 서버 재분석·재검증(§16 보안). 이번 단계는 new-only(§17): "신규등록" + 거래처 확정 행만 INSERT.
      // 기존 담당자 자동 UPDATE/MERGE 없음. update 모드는 아직 미구현.
      const result = await analyzeContacts(req.file.buffer);
      const newRows = result.rows.filter((r) => r.status === "new" && r.companyId != null);
      const summary = summarize(result.rows);
      const today = new Date().toISOString().slice(0, 10);
      const performer = { id: (req as any).user?.id ?? 0, email: (req as any).user?.email ?? "" };

      let inserted = 0;
      let batchId: number | null = null;
      if (newRows.length > 0) {
        await db.transaction(async (tx) => {
          // 0) Import Batch(§18)
          const [batch] = await tx
            .insert(importBatchesTable)
            .values({
              module: "contact",
              importType: ((req.body as any)?.sourceSystem) ? "legacy_migration" : "excel_bulk",
              originalFilename: fileName || null,
              sheetName: result.sheetName || null,
              totalRows: summary.total,
              successRows: newRows.length,
              warningRows: 0,
              errorRows: summary.error,
              status: "completed",
              createdBy: performer.id || null,
              sourceSystem: (req.body as any)?.sourceSystem ?? null,  // C-1(additive): legacy 이관 연계
            })
            .returning({ id: importBatchesTable.id });
          batchId = batch.id;

          // 1) 신규 담당자 insert (500행 청크). 역할/활성 기본값은 개별 등록과 동일.
          for (let i = 0; i < newRows.length; i += 500) {
            const chunk = newRows.slice(i, i + 500);
            const created = await tx
              .insert(contactsTable)
              .values(chunk.map((r) => ({
                companyId: r.companyId as number,
                name: r.name,
                department: r.department || null,
                position: r.position || null,
                email: r.emailNorm || null,
                mobile: r.mobileNorm || null,
                officePhone: r.officePhoneNorm || null,
                registeredAt: r.registeredAt || today,
                isPrimary: false,
                isQuoteContact: false,
                isBillingContact: false,
                isActive: true,
              })))
              .returning({ id: contactsTable.id });

            // Source Lineage(§18) — 각 담당자의 원본 파일/시트/행 + idempotency 비교키(파일명 무관).
            await tx.insert(importRowSourcesTable).values(created.map((c, idx) => {
              const src = chunk[idx];
              return {
                batchId: batch.id,
                module: "contact",
                entityId: c.id,
                sourceFile: fileName || null,
                sourceSheet: result.sheetName || null,
                sourceRow: src.rowNumber,
                rowKey: contactRowKey(src),
                status: "new",
              };
            }));
            inserted += created.length;
          }
        });
      }

      await logEvent("company", 0, "bulk_import_contacts", req.log, performer.id ? performer : undefined,
        JSON.stringify({ fileName, mode: "new_only", batchId, total: summary.total, inserted, identical: summary.identical, needsReview: summary.needsReview, duplicateFile: summary.duplicateFile, error: summary.error }));

      res.json({ fileName, mode: "new_only", batchId, inserted, updated: 0, summary });
    } catch (err) {
      req.log.error({ err }, "BulkImport: contact execute failed");
      res.status(500).json({ error: "담당자 일괄 등록 실패." });
    }
  },
);

// ── 통번역사(3차) 분석 ────────────────────────────────────────────────────────
// 통번역사는 users(role=translator) + translator_profiles(1:1) + translator_emails/aliases 로 구성된다.
// 민감정보(translator_sensitive: 주민번호·계좌·해외송금 등)는 이 일반 Import 에서 절대 수신하지 않는다(§4·§5·§14).
// 신원 신호: 이메일(users.email + translator_emails) · 휴대폰(profile.phone) · 이름(users.name + aliases).
// 이름만으로 동일인 자동판정 금지(§12). new-only(§17), Import Batch/Lineage(§19), idempotency(§20).
// needs_review 세분(요구사항3): 실제 동일인 후보 / 동명이인 / CRM 내부중복 / 판단불가 / 무이메일 이관대기.
type ReviewCategory = "same_person" | "homonym" | "file_internal" | "undecidable" | "legacy_no_email";
// 매칭 근거(요구사항1): 원본 행 ↔ Master 연결 방법. 주민번호 > 이메일 > 휴대폰 > 이름 우선순위.
type MatchMethod = "rrn" | "email" | "phone" | "name";

interface TranslatorRow {
  rowNumber: number;
  status: RowStatus;               // new | identical | update | conflict | needs_review | duplicate_file | error
  reason?: string;
  existingId?: number | null;      // 기존통번역사 일치 시 매칭된 user id(표시용·연결 근거)
  matchMethod?: MatchMethod;       // 연결 근거 보존(요구사항1)
  reviewCategory?: ReviewCategory; // needs_review 세분(요구사항3)
  changes?: ChangeMap;             // update/conflict 행의 변경·충돌 필드 미리보기(컬럼 key → old/new)
  changeSummary?: string;          // 보완/충돌 필드 요약(한글 라벨, 컬럼 외 필드도 노출)
  residentMasked?: string;         // 엑셀 원본 주민번호 마스킹 표기(예: 900101-1******). 원문은 절대 미보관(§4·요구사항7).
  masterInactive?: boolean;        // 매칭된 기존 Master 가 비활성 인력인지(요구사항4 — 자동 활성화 금지 표시).
  name: string;
  englishName: string;
  email: string;                   // 원문 표시용
  emailNorm: string;
  phone: string;                   // 원문 표시용
  phoneNorm: string;
  region: string;
  languages: string;
  services: string;
  specializations: string;
  education: string;
  major: string;
  graduationYear: string;
  grade: string;
  availabilityStatus: string;
  bio: string;                     // 상세정보 — 원문 보존(trim 만, §23)
  // 주의: 주민번호 원문은 이 구조체에 절대 보관하지 않는다(§4·요구사항7). 매칭은 서버 지역변수에서만 수행.
}

/** 신규 통번역사의 안정적 business key(idempotency·lineage §19·§20). 파일명 무관. */
function translatorRowKey(r: TranslatorRow): string {
  if (r.emailNorm) return `translator|e:${r.emailNorm}`;
  if (r.phoneNorm) return `translator|m:${r.phoneNorm}`;
  return `translator|n:${normalizeCompanyName(r.name)}`;
}

/** 주민번호 13자리 숫자만 추출(서버 내부 매칭 전용 — 원문/반환/로그 금지, §4·요구사항7). */
function rrnDigits13(s: string | null | undefined): string | null {
  const d = (s ?? "").replace(/[^0-9]/g, "");
  return d.length === 13 ? d : null;
}

/** 졸업년도 안전 파싱(정수 컬럼용) — 4자리 연도만 인정, 비정상(문자·범위 밖)은 null(NaN 삽입 방지). */
function gradYear(s: string | null | undefined): number | null {
  const m = String(s ?? "").match(/\d{4}/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}

/** 필드 비교용 기존 Master 요약(민감정보 제외 — 주민번호·계좌는 포함하지 않는다). */
interface MiniTranslator {
  id: number; name: string; email: string; phone: string; region: string;
  languagePairs: string; profileWorkTypes: string; specializations: string;
  education: string; major: string; graduationYear: string; grade: string; bio: string;
}

/** 기존 Master vs 엑셀 행 필드 비교(요구사항2).
 *  규칙: 엑셀 공란→보존(임의 생성 금지) · 동일→변경 아님 ·
 *        기존 공란 & 엑셀 값 있음→보완(fill, update 후보) · 기존 값 있음 & 상이→충돌(conflict, 별도 검토).
 *  email/phone 은 정규화 비교. 성명은 매칭이 이미 성명호환을 통과한 경우(includeName=false) 비교 제외(별칭 오탐 방지). */
function classifyTranslatorChange(ex: MiniTranslator, r: TranslatorRow, includeName: boolean): {
  status: "identical" | "update" | "conflict"; changes: ChangeMap; fill: string[]; conflict: string[];
} {
  const norm = (s: string) => (s ?? "").trim();
  const defs: { key: string; label: string; excel: string; db: string; cmp?: (s: string) => string }[] = [
    ...(includeName ? [{ key: "name", label: "성명", excel: r.name, db: ex.name }] : []),
    { key: "email", label: "이메일", excel: r.email, db: ex.email, cmp: (s: string) => normalizeEmail(s) },
    { key: "phone", label: "휴대폰", excel: r.phone, db: ex.phone, cmp: (s: string) => normalizePhone(s) },
    { key: "languages", label: "언어", excel: r.languages, db: ex.languagePairs },
    { key: "services", label: "가능서비스", excel: r.services, db: ex.profileWorkTypes },
    { key: "specializations", label: "전문분야", excel: r.specializations, db: ex.specializations },
    { key: "grade", label: "인력등급", excel: r.grade, db: ex.grade },
    { key: "region", label: "활동지역", excel: r.region, db: ex.region },
    { key: "education", label: "학력", excel: r.education, db: ex.education },
    { key: "major", label: "전공", excel: r.major, db: ex.major },
    { key: "graduationYear", label: "졸업년도", excel: r.graduationYear, db: ex.graduationYear },
    { key: "bio", label: "상세정보", excel: r.bio, db: ex.bio },
  ];
  const changes: ChangeMap = {};
  const fill: string[] = []; const conflict: string[] = [];
  for (const d of defs) {
    const cmp = d.cmp ?? norm;
    const exc = cmp(d.excel);
    if (exc === "") continue;            // 엑셀 공란 → 기존값 보존
    const dbv = cmp(d.db);
    if (exc === dbv) continue;           // 동일 → 변경 아님
    changes[d.key] = { old: d.db ?? "", new: d.excel ?? "" };
    if (dbv === "") fill.push(d.label);  // 기존 공란 → 보완 후보
    else conflict.push(d.label);         // 기존 값 상이 → 충돌
  }
  const status = conflict.length ? "conflict" : (fill.length ? "update" : "identical");
  return { status, changes, fill, conflict };
}

async function analyzeTranslators(buffer: Buffer): Promise<{
  sheetName: string; headerRowIndex: number; columnMap: Record<string, string | null>;
  rows: TranslatorRow[]; translatorDiagnostics: Record<string, unknown>;
}> {
  const parsed = parseWorkbook(buffer, TRANSLATOR_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, TRANSLATOR_COLUMN_SYNONYMS);

  // 기존 사용자(이메일 소유자 — 유니크 충돌/타 계정 사용 탐지). 휴지통(soft delete)은 제외.
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive })
    .from(usersTable)
    .where(sql`${usersTable.deletedAt} is null`);
  const emailOwners = new Map<string, { id: number; role: string }[]>();
  const pushOwner = (em: string, v: { id: number; role: string }) => { const a = emailOwners.get(em); if (a) a.push(v); else emailOwners.set(em, [v]); };
  const translatorName = new Map<number, string>();  // id → users.name
  const userById = new Map<number, { name: string; email: string; isActive: boolean }>();  // 필드 비교용(요구사항2) + 활성상태(요구사항4)
  for (const u of users) {
    const em = normalizeEmail(u.email);
    if (em) pushOwner(em, { id: u.id, role: u.role });
    if (u.role === "translator") { translatorName.set(u.id, u.name ?? ""); userById.set(u.id, { name: u.name ?? "", email: u.email ?? "", isActive: u.isActive !== false }); }
  }
  // translator_emails(대표/보조) 도 이메일 소유자에 포함
  const temails = await db.select({ translatorId: translatorEmailsTable.translatorId, email: translatorEmailsTable.email }).from(translatorEmailsTable);
  for (const te of temails) { const em = normalizeEmail(te.email); if (em && translatorName.has(te.translatorId)) pushOwner(em, { id: te.translatorId, role: "translator" }); }

  // 기존 프로필 전체(필드 보완/충돌 비교용 — 요구사항2) + 휴대폰 → 통번역사 id 역색인.
  const profiles = await db.select({
    userId: translatorProfilesTable.userId, phone: translatorProfilesTable.phone,
    region: translatorProfilesTable.region, languagePairs: translatorProfilesTable.languagePairs,
    profileWorkTypes: translatorProfilesTable.profileWorkTypes, specializations: translatorProfilesTable.specializations,
    education: translatorProfilesTable.education, major: translatorProfilesTable.major,
    graduationYear: translatorProfilesTable.graduationYear, grade: translatorProfilesTable.grade,
    bio: translatorProfilesTable.bio,
  }).from(translatorProfilesTable);
  const phoneToIds = new Map<string, Set<number>>();
  const profileById = new Map<number, typeof profiles[number]>();
  for (const p of profiles) {
    if (!translatorName.has(p.userId)) continue;
    profileById.set(p.userId, p);
    const ph = normalizePhone(p.phone); if (ph) { const s = phoneToIds.get(ph) ?? new Set(); s.add(p.userId); phoneToIds.set(ph, s); }
  }

  // 주민번호 → 통번역사 id 역색인(요구사항1·우선 매칭). 복호는 서버 내부에서만, 원문/13자리는
  // 어떤 행·응답·로그에도 저장하지 않는다(§4·요구사항7). 복호 실패/불완전 값은 조용히 skip.
  const sensitives = await db
    .select({ translatorId: translatorSensitiveTable.translatorId, rn: translatorSensitiveTable.residentNumber })
    .from(translatorSensitiveTable);
  const rrnToIds = new Map<string, number[]>();
  const rrnById = new Map<number, string>();   // 모순(귀화 등 식별번호 상이) 판정용 — 서버 내부만.
  for (const s of sensitives) {
    if (!translatorName.has(s.translatorId)) continue;
    const raw = s.rn ? String(s.rn).trim() : "";
    if (!raw) continue;
    let plain: string; try { plain = decrypt(raw); } catch { continue; }
    const k = rrnDigits13(plain); if (!k) continue;   // 주민등록·외국인등록번호 공통 13자리
    const arr = rrnToIds.get(k); if (arr) arr.push(s.translatorId); else rrnToIds.set(k, [s.translatorId]);
    if (!rrnById.has(s.translatorId)) rrnById.set(s.translatorId, k);
  }

  // 실제(비임시) 이메일 → 통번역사 id 역색인. 기존 시스템 생성 임시 이메일(@crm-migrated.invalid)은 비교 제외(요구사항1).
  const realEmailToIds = new Map<string, Set<number>>();
  const addRealEmail = (rawEmail: string | null | undefined, id: number) => {
    if (!rawEmail || isLegacyPlaceholderEmail(rawEmail)) return;
    const em = normalizeEmail(rawEmail); if (!em) return;
    const s = realEmailToIds.get(em) ?? new Set(); s.add(id); realEmailToIds.set(em, s);
  };
  for (const [id, u] of userById) addRealEmail(u.email, id);
  for (const te of temails) { if (translatorName.has(te.translatorId)) addRealEmail(te.email, te.translatorId); }

  // 기존 과거 CRM 이관자(legacy_master_mappings, entity_type='translator', 미롤백) → Master id 집합(요구사항5·6F).
  // 읽기 전용. 매핑은 변경하지 않는다.
  const legacyMaps = await db
    .select({ entityId: legacyMasterMappingsTable.entityId, status: legacyMasterMappingsTable.status })
    .from(legacyMasterMappingsTable)
    .where(eq(legacyMasterMappingsTable.entityType, "translator"));
  const legacyMappedMasterIds = new Set<number>();
  for (const m of legacyMaps) { if (m.status !== "rolled_back" && translatorName.has(m.entityId)) legacyMappedMasterIds.add(m.entityId); }

  const buildMini = (id: number): MiniTranslator => {
    const u = userById.get(id); const p = profileById.get(id);
    return {
      id, name: u?.name ?? translatorName.get(id) ?? "", email: u?.email ?? "",
      phone: p?.phone ?? "", region: p?.region ?? "", languagePairs: p?.languagePairs ?? "",
      profileWorkTypes: p?.profileWorkTypes ?? "", specializations: p?.specializations ?? "",
      education: p?.education ?? "", major: p?.major ?? "",
      graduationYear: p?.graduationYear != null ? String(p.graduationYear) : "", grade: p?.grade ?? "", bio: p?.bio ?? "",
    };
  };

  // 이름 → 통번역사 id (users.name + aliases). id별 정규화 이름 집합(이름 호환 판정용).
  const aliases = await db.select({ translatorId: translatorAliasesTable.translatorId, norm: translatorAliasesTable.normalizedAlias }).from(translatorAliasesTable);
  const nameToIds = new Map<string, Set<number>>();
  const idToNameNorms = new Map<number, Set<string>>();
  const addName = (id: number, norm: string) => {
    if (!norm) return;
    const s = nameToIds.get(norm) ?? new Set(); s.add(id); nameToIds.set(norm, s);
    const t = idToNameNorms.get(id) ?? new Set(); t.add(norm); idToNameNorms.set(id, t);
  };
  for (const [id, nm] of translatorName) addName(id, normalizeCompanyName(nm));
  for (const a of aliases) { if (translatorName.has(a.translatorId)) addName(a.translatorId, a.norm); }

  // 이메일 소유자 중 통번역사 id 집합 / 비통번역사 여부
  const transIdsByEmail = (em: string) => {
    const owners = emailOwners.get(em) ?? [];
    return [...new Set(owners.filter((o) => o.role === "translator").map((o) => o.id))];
  };
  const hasNonTranslatorOwner = (em: string) => (emailOwners.get(em) ?? []).some((o) => o.role !== "translator");

  const seenFileEmail = new Set<string>();
  const seenFilePhone = new Set<string>();
  const seenFileName = new Set<string>();
  const rows: TranslatorRow[] = [];

  // ── 정합성 검증 집계(읽기 전용, 2단계) — 원본 행 수와 고유 인원 수 구분(요구사항6). ──
  const conflictFieldCounts: Record<string, number> = {};   // 정보 충돌 유형별 건수(요구사항1·B)
  const fillFieldCounts: Record<string, number> = {};       // 보완 가능 필드별 건수(요구사항3·C)
  const confirmedMasterIds = new Set<number>();             // 동일인 확정(identical/update/conflict)의 고유 Master
  const updateMasterIds = new Set<number>();                // 보완 대상 고유 Master
  const matchedExistingIds = new Set<number>();             // 어떤 방식으로든 기존 Master 와 연결된 id(F 계산용)
  const linkedLegacyMasterIds = new Set<number>();          // 기존 이관자(legacy)와 연결된 Master
  const newKeys = new Set<string>();                        // 신규 등록 고유 인원 키
  const homonymNames = new Set<string>();                   // 동명이인 고유 성명
  // 단순화 기준(요구사항) — Master 별 확정 매칭 방식(우선순위 rrn>email>phone, 중복 집계 방지) + 예외 고유 집계.
  const masterMethod = new Map<number, MatchMethod>();      // A/B/C: Master → 확정 방식(인원 기준 1회)
  const exceptionKeys = new Set<string>();                  // F: 예외 검토 고유(인원 기준)

  parsed.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const rowNumber = parsed.headerRowIndex + 2 + i;

    const name = normalizeName(getCell(raw, colMap, "name"));
    const emailNorm = normalizeEmail(getCell(raw, colMap, "email"));
    const phoneNorm = normalizePhone(getCell(raw, colMap, "phone"));
    const gradYearRaw = normalizeName(getCell(raw, colMap, "graduationYear"));

    const row: TranslatorRow = {
      rowNumber, status: "new",
      name,
      englishName: normalizeName(getCell(raw, colMap, "englishName")),
      email: normalizeName(getCell(raw, colMap, "email")), emailNorm,
      phone: normalizeName(getCell(raw, colMap, "phone")), phoneNorm,
      region: normalizeName(getCell(raw, colMap, "region")),
      languages: normalizeName(getCell(raw, colMap, "languages")),
      services: normalizeName(getCell(raw, colMap, "services")),
      specializations: normalizeName(getCell(raw, colMap, "specializations")),
      education: normalizeName(getCell(raw, colMap, "education")),
      major: normalizeName(getCell(raw, colMap, "major")),
      graduationYear: gradYearRaw.replace(/[^\d]/g, "").slice(0, 4),
      grade: normalizeName(getCell(raw, colMap, "grade")),
      availabilityStatus: normalizeName(getCell(raw, colMap, "availabilityStatus")),
      bio: normalizeName(getCell(raw, colMap, "bio")),  // 상세정보: trim 만(§23), 내용 변경 없음
    };

    // ── 필수값: 성명만 필수. 이메일 없는 과거 CRM 이관자는 '비활성 Master 이관 대상'으로 분류(요구사항4). ──
    if (!name) { row.status = "error"; row.reason = "성명 누락"; rows.push(row); return; }

    const nameNorm = normalizeCompanyName(name);
    const nameMatches = (id: number) => { const set = idToNameNorms.get(id); return !nameNorm || !set || set.has(nameNorm); };
    // 주민번호 매칭키(서버 지역변수 — 행/응답/로그에 저장하지 않음, §4·요구사항7).
    const rrnKey = rrnDigits13(normalizeName(getCell(raw, colMap, "residentNumber")));
    const rrnIds = rrnKey ? (rrnToIds.get(rrnKey) ?? []) : [];
    // 미리보기 표시용 마스킹: 900101-1****** (생년월일 6 + 성별 1자리만 노출, 뒤 6자리 마스킹).
    // 마스킹 문자열만 응답에 포함하고 전체 13자리는 서버 지역변수 밖으로 내보내지 않는다.
    if (rrnKey) row.residentMasked = `${rrnKey.slice(0, 6)}-${rrnKey[6]}******`;

    // CRM 이메일이 임시 주소(@crm-migrated.invalid)면 매칭에서 제외(요구사항1).
    const emailRealNorm = isLegacyPlaceholderEmail(row.email) ? "" : emailNorm;

    // 동일인 확정: 필드 비교 후 변경 있으면 update(보완·변경 후보), 없으면 identical. (충돌 일괄 분류 폐지 — 요구사항3)
    const applyMatch = (id: number, method: MatchMethod) => {
      row.existingId = id; row.matchMethod = method;
      row.masterInactive = userById.get(id)?.isActive === false;   // 비활성 Master 표시(요구사항2·9)
      const { changes, fill, conflict } = classifyTranslatorChange(buildMini(id), row, !nameMatches(id));
      confirmedMasterIds.add(id);
      const prio: Record<MatchMethod, number> = { rrn: 3, email: 2, phone: 1, name: 0 };   // 우선순위 ①주민번호 ②이메일 ③휴대폰
      const prev = masterMethod.get(id);
      if (!prev || prio[method] > prio[prev]) masterMethod.set(id, method);
      if (Object.keys(changes).length === 0) {
        row.status = "identical"; row.reason = `기존 Master #${id} 와 동일(${method})`;
      } else {
        row.status = "update"; row.changes = changes; updateMasterIds.add(id);
        row.reason = `기존 Master #${id} 보완/변경 ${Object.keys(changes).length}개 필드`;
        row.changeSummary = [fill.length ? `보완: ${fill.join("·")}` : "", conflict.length ? `변경: ${conflict.join("·")}` : ""].filter(Boolean).join(" / ");
        for (const label of fill) fillFieldCounts[label] = (fillFieldCounts[label] ?? 0) + 1;
        for (const label of conflict) conflictFieldCounts[label] = (conflictFieldCounts[label] ?? 0) + 1;
      }
    };
    const markException = (reason: string) => {
      row.status = "needs_review"; row.reviewCategory = "undecidable"; row.reason = reason;
      exceptionKeys.add(row.existingId != null ? `m:${row.existingId}` : `k:${rrnKey || emailRealNorm || phoneNorm || `n:${nameNorm}`}`);
    };

    // ── 단순화 매칭(요구사항1): 성명 + (주민번호 | 실제 이메일 | 휴대폰). 우선순위 ①주민번호 ②이메일 ③휴대폰. ──
    // 후보는 "성명 일치 Master" 로 제한. 식별자별 소유 Master 와 교집합.
    const nameMatchedSet = new Set<number>(nameNorm ? [...(nameToIds.get(nameNorm) ?? [])] : []);
    const rrnOwners = rrnKey ? (rrnToIds.get(rrnKey) ?? []) : [];
    const emailOwners2 = emailRealNorm ? [...(realEmailToIds.get(emailRealNorm) ?? [])] : [];
    const phoneOwners = phoneNorm ? [...(phoneToIds.get(phoneNorm) ?? [])] : [];
    const cand = new Map<number, Set<MatchMethod>>();
    const addCand = (ids: number[], m: MatchMethod) => { for (const id of ids) if (nameMatchedSet.has(id)) { const s = cand.get(id) ?? new Set<MatchMethod>(); s.add(m); cand.set(id, s); } };
    addCand(rrnOwners, "rrn"); addCand(emailOwners2, "email"); addCand(phoneOwners, "phone");
    const candIds = [...cand.keys()];

    if (candIds.length >= 2) {
      // 복수 Master 일치 → 명백한 모순(요구사항1 단서) → 예외 검토.
      markException("성명+식별정보가 복수 Master와 일치 — 예외 검토");
    } else if (candIds.length === 1) {
      const id = candIds[0];
      const methods = cand.get(id)!;
      const method: MatchMethod = methods.has("rrn") ? "rrn" : methods.has("email") ? "email" : "phone";
      const masterRrn = rrnById.get(id);
      // 식별번호 모순(귀화 등): 이메일/휴대폰으로 확정됐는데 양쪽 주민번호가 모두 있고 다르면 예외(번호 불일치만으론 타인 확정 안 함 → 검토로).
      if (method !== "rrn" && rrnKey && masterRrn && masterRrn !== rrnKey) {
        row.existingId = id; row.matchMethod = method; row.masterInactive = userById.get(id)?.isActive === false;
        markException(`기존 Master #${id} 와 ${method} 일치하나 식별번호 상이 — 귀화 등 예외 검토`);
      } else {
        applyMatch(id, method);
      }
    } else {
      // 성명+식별정보로 확정된 Master 없음.
      const otherDup = rrnOwners.length + emailOwners2.length + phoneOwners.length > 0;  // 이름 무관 식별정보가 타 Master와 일치
      if (otherDup) {
        markException("식별정보가 다른 성명의 Master와 일치 — 중복 가능성, 예외 검토");
      } else if (nameMatchedSet.size > 0) {
        // 동명 Master 존재하나 식별정보 미일치/부재 → 중복 가능성 남음 → 보류(요구사항4).
        row.status = "needs_review"; row.reviewCategory = "homonym";
        row.reason = "동명 Master 존재·식별정보 불일치 — 중복 가능성, 보류";
        if (nameNorm) homonymNames.add(nameNorm);
        exceptionKeys.add(`k:${emailRealNorm || phoneNorm || `n:${nameNorm}`}`);
      } else if ((emailRealNorm && seenFileEmail.has(emailRealNorm)) || (phoneNorm && seenFilePhone.has(phoneNorm)) || (nameNorm && seenFileName.has(nameNorm))) {
        // CRM 파일 내부 중복 → 보류(요구사항4).
        row.status = "duplicate_file"; row.reviewCategory = "file_internal"; row.reason = "CRM 파일 내부 중복 — 보류";
        exceptionKeys.add(`k:${emailRealNorm || phoneNorm || `n:${nameNorm}`}`);
      } else {
        row.status = "new";
        if (emailRealNorm) seenFileEmail.add(emailRealNorm);
        if (phoneNorm) seenFilePhone.add(phoneNorm);
        if (nameNorm) seenFileName.add(nameNorm);
      }
    }

    // ── 고유 인원·연결 집계(원본 행 수와 구분, 요구사항6) ──
    if (row.existingId != null) {
      matchedExistingIds.add(row.existingId);                               // 기존 Master 와 연결된 행(F 계산)
      if (legacyMappedMasterIds.has(row.existingId)) linkedLegacyMasterIds.add(row.existingId);  // 기존 이관자 연결(요구사항5)
    }
    if (row.status === "new") newKeys.add(emailRealNorm || phoneNorm || `n:${nameNorm}`);

    rows.push(row);
  });

  // 진단 통계(읽기전용·미리보기 전용) — 단순화 기준 A~F(중복 집계 없이 실제 인원).
  const errorBreakdown: Record<string, number> = {};
  for (const r of rows) if (r.status === "error" && r.reason) errorBreakdown[r.reason] = (errorBreakdown[r.reason] ?? 0) + 1;
  const countStatus = (s: RowStatus) => rows.filter((r) => r.status === s).length;

  const buckets = {
    new: countStatus("new"), identical: countStatus("identical"), update: countStatus("update"),
    needsReview: countStatus("needs_review"), duplicateFile: countStatus("duplicate_file"), error: countStatus("error"),
  };
  const bucketSum = buckets.new + buckets.identical + buckets.update + buckets.needsReview + buckets.duplicateFile + buckets.error;
  const methodVals = [...masterMethod.values()];
  const A_rrn = methodVals.filter((m) => m === "rrn").length;
  const B_email = methodVals.filter((m) => m === "email").length;
  const C_phone = methodVals.filter((m) => m === "phone").length;

  const translatorDiagnostics = {
    // 핵심 요약(요구사항5): 기존 연결 / 신규 / 예외.
    linkedPersons: confirmedMasterIds.size,            // 기존 Master 연결(동일인 확정) 고유 인원
    newPersons: newKeys.size,                          // 신규 등록 가능 고유 인원
    exceptionPersons: exceptionKeys.size,              // 예외 검토 고유 인원
    updatablePersons: updateMasterIds.size,            // 업데이트 가능 고유 인원
    errorBreakdown,
    conflictFieldCounts,   // 동일인 확정 후 실제 변경 필드별 건수
    fillFieldCounts,       // 공란 보완 필드별 건수
    legacyMappedTotal: legacyMappedMasterIds.size,
    legacyLinkedInFile: linkedLegacyMasterIds.size,
    // ── A~F 보고서(중복 집계 없이 실제 인원 기준, 요구사항) ──
    report: {
      rowsTotal: rows.length,
      A_nameRrn: A_rrn,                                // 이름+주민/외국인번호 일치 인원
      B_nameEmail: B_email,                            // 이름+실제이메일 일치 인원
      C_namePhone: C_phone,                            // 이름+휴대폰 일치 인원
      D_updatable: updateMasterIds.size,               // 기존 Master 업데이트 가능 인원
      E_newRegistrable: newKeys.size,                  // 신규 등록 가능 인원
      F_exception: exceptionKeys.size,                 // 예외 검토 인원
      legacyNotInFile: legacyMappedMasterIds.size - [...legacyMappedMasterIds].filter((id) => matchedExistingIds.has(id)).length,
      reconciliation: { bucketSum, rowsTotal: rows.length, reconciled: bucketSum === rows.length, buckets },
    },
  };

  return {
    sheetName: parsed.sheetName,
    headerRowIndex: parsed.headerRowIndex,
    columnMap: describeColumnMap(parsed.headers, colMap),
    rows,
    translatorDiagnostics,
  };
}

router.post(
  "/admin/translators/bulk-import/analyze",
  ...adminGuard,   // 통번역사 수동 등록과 동일한 접근 기준(별도 permission key 없음)
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    try {
      const result = await analyzeTranslators(req.file.buffer);
      // 업로드 원본을 암호화 임시 저장소에 보관(Master 재구축 재사용). 실패해도 분석 응답은 정상 반환.
      // 원본 바이트만 암호화 저장하고, 메타·응답·로그에 주민번호 등 셀 값은 넣지 않는다(§PII).
      let snapshotId: string | null = null;
      try {
        pruneExpired();
        const snap = saveSnapshot("translator", req.file.buffer, {
          filename: decodeFileName(req.file.originalname),
          sheetName: result.sheetName, totalRows: result.rows.length,
          createdBy: (req as any).user?.id ?? null,
        });
        snapshotId = snap.id;
      } catch (e) { req.log.warn({ err: e }, "BulkImport: snapshot save failed (분석은 계속)"); }

      res.json({
        fileName: decodeFileName(req.file.originalname),
        sheetName: result.sheetName,
        headerRowIndex: result.headerRowIndex,
        columnMap: result.columnMap,
        summary: summarize(result.rows),
        translatorDiagnostics: result.translatorDiagnostics,
        snapshotId,              // 서버 암호화 보관 식별자(재분석/삭제에 사용)
        rows: result.rows,
      });
    } catch (err) {
      req.log.error({ err }, "BulkImport: translator analyze failed");
      res.status(500).json({ error: "엑셀 분석 실패. 파일 형식을 확인해주세요." });
    }
  },
);

// ── 통번역사 Master 재구축 — 저장된 업로드 스냅샷 관리 + 수행이력(진행관리표) 대조 분석(읽기 전용) ──
// ★이 엔드포인트들은 DB·Master·매핑을 변경하지 않는다. 주민번호 원문은 복호 후 서버 내부 매칭에만 사용.★
// 재구축 실행용 1인 액션(요구사항1~4). 주민번호는 원문 미보관 — 신규 생성용 암호문(rrnEnc)·마스킹만.
interface RebuildPersonAction {
  rowNumber: number;
  action: "reuse" | "new" | "manual" | "exclude";
  bucket: string;                 // reuse | newPure | rrnIndepNew | historyIndepNew | multiCandidate | idConflict | historyMismatch | rrnMismatch | other | excludeC
  masterId?: number;              // reuse 대상 기존 Master id(요구사항1·7 — ID 유지)
  name: string;
  englishName: string;
  emailNorm: string;
  phoneNorm: string;
  region: string; languages: string; services: string; specializations: string;
  education: string; major: string; graduationYear: string; grade: string;
  availabilityStatus: string; bio: string;
  rrnEnc: string | null;          // 신규 생성 시 translator_sensitive 적재용 암호문(요구사항7). 원문·13자리 미보관.
  hasRrn: boolean;
  residentMasked: string;         // 표시용 마스킹(예: 900101-*******)
  rowKey: string;                 // idempotency/lineage 키
}

async function classifyRebuildTargets(buffer: Buffer, opts: { withPlan?: boolean } = {}): Promise<Record<string, unknown>> {
  const parsed = parseWorkbook(buffer, TRANSLATOR_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, TRANSLATOR_COLUMN_SYNONYMS);
  const plan: RebuildPersonAction[] = [];

  // 진행관리표(수행이력) 신원 집합 — 읽기 전용.
  const prog = await db.execute(sql`
    SELECT nullif(btrim(source_raw->>'통번역사명'),'') AS nm,
           substring(regexp_replace(coalesce(source_raw->>'주민등록번호',''),'[^0-9]','','g') from 1 for 13) AS rrn
    FROM legacy_archive_rows WHERE source_type='progress' AND is_effective=true`);
  const progNames = new Set<string>();
  const progRrn = new Set<string>();
  const progNameToRrns = new Map<string, Set<string>>();   // 수행자 이름 → 진행관리표상 주민번호 집합(식별정보 불일치 판정용)
  for (const r of (prog.rows as any[])) {
    const nm = r.nm ? normalizeCompanyName(String(r.nm)) : "";
    if (nm) progNames.add(nm);
    const rr = r.rrn && String(r.rrn).length === 13 ? String(r.rrn) : "";
    if (rr) progRrn.add(rr);
    if (nm && rr) { const s = progNameToRrns.get(nm) ?? new Set<string>(); s.add(rr); progNameToRrns.set(nm, s); }
  }

  // ── 기존 Master(통번역사) 교차대조 인덱스 — 전부 읽기 전용 SELECT. 재사용/신규/정리 산정용(요구사항1·5). ──
  //   매칭 원칙: 성명 호환 + (주민번호 | 실제 이메일 | 휴대폰) 중 하나 일치 → 동일인 '확정'. 이름만 일치는 확정 아님(동명이인 자동병합 금지).
  const mUsers = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(sql`${usersTable.deletedAt} is null`);
  const masterIds = new Set<number>();                     // 통번역사 Master id
  const masterNameNorms = new Set<string>();               // 기존 Master 정규화 성명(진행관리표 연결 예정 판정)
  const nameToIds = new Map<string, Set<number>>();        // 정규화 성명 → Master id (users.name + aliases)
  const mEmailToIds = new Map<string, Set<number>>();      // 실제 이메일 → Master id
  const mPhoneToIds = new Map<string, Set<number>>();      // 휴대폰 → Master id
  const mRrnToIds = new Map<string, Set<number>>();        // 주민/외국인 13자리 → Master id (서버 내부만)
  // 기존 Master별 식별정보 보유 여부(⑥ 보완 가능 판정용) — 특정 Master에 이메일/휴대폰/주민번호가 있는지.
  const mHasEmail = new Set<number>();
  const mHasPhone = new Set<number>();
  const mHasRrn = new Set<number>();
  const addTo = (m: Map<string, Set<number>>, k: string, id: number) => { if (!k) return; const s = m.get(k) ?? new Set<number>(); s.add(id); m.set(k, s); };
  const addRealEmail = (m: Map<string, Set<number>>, rawEmail: string | null | undefined, id: number) => {
    if (!rawEmail || isLegacyPlaceholderEmail(rawEmail)) return;
    addTo(m, normalizeEmail(rawEmail), id);
    mHasEmail.add(id);
  };
  for (const u of mUsers) {
    if (u.role !== "translator") continue;
    masterIds.add(u.id);
    const nn = normalizeCompanyName(u.name ?? "");
    if (nn) { masterNameNorms.add(nn); addTo(nameToIds, nn, u.id); }
    addRealEmail(mEmailToIds, u.email, u.id);
  }
  // 보조 이메일(translator_emails) · 프로필 휴대폰 · 별칭 성명 — Master 소속분만 반영.
  const mTEmails = await db.select({ translatorId: translatorEmailsTable.translatorId, email: translatorEmailsTable.email }).from(translatorEmailsTable);
  for (const te of mTEmails) if (masterIds.has(te.translatorId)) addRealEmail(mEmailToIds, te.email, te.translatorId);
  const mProfiles = await db.select({ userId: translatorProfilesTable.userId, phone: translatorProfilesTable.phone }).from(translatorProfilesTable);
  for (const p of mProfiles) if (masterIds.has(p.userId)) { const ph = normalizePhone(p.phone); if (ph) { addTo(mPhoneToIds, ph, p.userId); mHasPhone.add(p.userId); } }
  const mAliases = await db.select({ translatorId: translatorAliasesTable.translatorId, norm: translatorAliasesTable.normalizedAlias }).from(translatorAliasesTable);
  for (const a of mAliases) if (masterIds.has(a.translatorId)) { if (a.norm) { masterNameNorms.add(a.norm); addTo(nameToIds, a.norm, a.translatorId); } }
  // 주민번호 역색인(복호는 서버 내부에서만, 원문·13자리 미반환·미로그 — §4·요구사항7).
  const mSensitives = await db.select({ translatorId: translatorSensitiveTable.translatorId, rn: translatorSensitiveTable.residentNumber }).from(translatorSensitiveTable);
  for (const s of mSensitives) {
    if (!masterIds.has(s.translatorId)) continue;
    const raw = s.rn ? String(s.rn).trim() : ""; if (!raw) continue;
    let plain: string; try { plain = decrypt(raw); } catch { continue; }
    const k = rrnDigits13(plain); if (!k) continue;
    addTo(mRrnToIds, k, s.translatorId);
    mHasRrn.add(s.translatorId);
  }
  // 중복 Master 정리 후보(요구사항1): 동일 주민번호가 2개 이상의 기존 Master에 존재 → 초과분만 '검증 후 비활성화' 후보로 집계(실행 없음·자동병합 금지).
  let dupMasterCleanup = 0;
  for (const ids of mRrnToIds.values()) if (ids.size >= 2) dupMasterCleanup += ids.size - 1;

  const seenKey = new Set<string>();
  let totalRows = 0, crmUnique = 0, internalDupById = 0, sameNameNoId = 0, invalid = 0, uniqueWithRrn = 0;
  let A_history = 0, A_byRrn = 0, A_byNameOnly = 0, B_rrnNoHistory = 0, C_hold = 0;
  // 등록 대상(A+B) → 기존 Master 교차대조 결과(요구사항5). 합계 = registerTarget 로 정합.
  let reuseExistingMaster = 0, newMasterToCreate = 0, identityException = 0;
  let masterSupplementable = 0;                             // ⑥ 기존 Master 정보 보완 가능 인원(재사용 대상 중 CRM이 결측 식별정보 보유)
  // ── 동일인 확정 불가 인원 세분(요구사항1~4) — 등록자격(A/B/C)과 동일인 식별을 분리. ──
  //   · 실제 중복위험(복수후보·주민번호/식별정보 충돌)만 '수동 확인'. 이름만 일치는 수동 사유 아님(병합 금지).
  //   · 수행이력/주민번호로 등록자격을 갖추고 충돌이 없으면 '독립 신규 등록 후보'로 분류(이름만 일치로 자동연결 안 함).
  let exMultiCandidate = 0;        // 성명+식별정보가 복수 Master와 일치 → 수동(자동병합 금지)
  let exIdConflict = 0;            // CRM 식별정보(실명이메일/휴대폰/주민번호)를 다른 이름 Master가 보유 → 수동(실제 충돌)
  let exHistoryMismatch = 0;       // 진행관리표 수행이력과 CRM 주민번호 불일치 → 수동(실제 충돌)
  let exRrnMismatch = 0;           // 동명 Master가 다른 주민번호 보유 → 수동(귀화 가능성 포함 확인·실제 충돌)
  let exRrnIndepNew = 0;           // 이름만 일치·CRM 고유 주민번호 보유·동명 Master 주민번호 없음 → 독립 신규 후보(주민번호 기준)
  let exHistoryIndepNew = 0;       // 이름만 일치·주민번호 없음·수행이력 확인 → 독립 신규 후보(동명이인 가능 표시, 자동병합 금지)
  let exOther = 0;                 // 기타(이론상 희소) → 수동
  let exMissingRrn = 0;            // (비배타 진단) 동일인 미확정 인원 중 주민번호 누락
  let exMissingContact = 0;        // (비배타 진단) 동일인 미확정 인원 중 이메일·휴대폰 모두 누락
  const reuseMasterIds = new Set<number>();                 // 재사용 대상 기존 Master(참고)
  const mastersFoundInCrm = new Set<number>();              // CRM 명부에서 동일인으로 확정된 기존 Master(⑩ 산정용)
  const registerTargetNameNorms = new Set<string>();        // 등록 대상 정규화 성명(진행관리표 연결 예정 판정)

  for (const raw of parsed.dataRows) {
    if (isBlankRow(raw)) continue;
    totalRows++;
    const name = normalizeName(getCell(raw, colMap, "name"));
    if (!name) { invalid++; continue; }
    const nameNorm = normalizeCompanyName(name);
    const rrn = rrnDigits13(normalizeName(getCell(raw, colMap, "residentNumber")));   // 서버 지역변수(미반환·미로그)
    const emailRaw = normalizeName(getCell(raw, colMap, "email"));
    const emailReal = isLegacyPlaceholderEmail(emailRaw) ? "" : normalizeEmail(emailRaw);
    const phone = normalizePhone(getCell(raw, colMap, "phone"));

    // 고유 인원: 식별자(주민번호>실제이메일>휴대폰) 우선. 식별자 동일 = 동일인 중복행 → 제외.
    // 식별자 없는 동일 이름은 병합하지 않음(동명이인 가능) → 별도 집계만.
    const idKey = rrn ? `r:${rrn}` : emailReal ? `e:${emailReal}` : phone ? `p:${phone}` : "";
    if (idKey) {
      if (seenKey.has(idKey)) { internalDupById++; continue; }
      seenKey.add(idKey);
    } else {
      const nk = `n:${nameNorm}`;
      if (seenKey.has(nk)) sameNameNoId++;   // 동명이인 확인 대상(병합 안 함)
      seenKey.add(nk);
    }

    crmUnique++;
    if (rrn) uniqueWithRrn++;
    const histRrn = !!rrn && progRrn.has(rrn);
    const histName = progNames.has(nameNorm);
    const isRegisterTarget = histRrn || histName || !!rrn;   // A(이력) 또는 B(주민번호) → 등록 대상
    if (histRrn || histName) { A_history++; if (histRrn) A_byRrn++; else A_byNameOnly++; }
    else if (rrn) { B_rrnNoHistory++; }
    else { C_hold++; }

    // ── 기존 Master 교차대조(요구사항1·5) — 성명 호환 + 식별자 일치 시 동일인 확정. ──
    //    확정 Master는 모든 고유행 기준으로 수집(⑩ CRM 미존재 Master 산정). 재사용/신규/예외 분류는 등록 대상(A+B)만.
    const nameSet = nameToIds.get(nameNorm) ?? new Set<number>();
    const idCands = new Set<number>();                       // 성명 호환 + 식별자 일치 Master(동일인 확정 후보)
    if (rrn) for (const id of (mRrnToIds.get(rrn) ?? [])) if (nameSet.has(id)) idCands.add(id);
    if (emailReal) for (const id of (mEmailToIds.get(emailReal) ?? [])) if (nameSet.has(id)) idCands.add(id);
    if (phone) for (const id of (mPhoneToIds.get(phone) ?? [])) if (nameSet.has(id)) idCands.add(id);
    for (const id of idCands) mastersFoundInCrm.add(id);     // CRM에서 확정된 기존 Master(동명이인 자동병합 아님)

    let act: RebuildPersonAction["action"] = "exclude";   // 기본값: 등록 제외(C). register target 에서 재지정.
    let bkt = "excludeC";
    let mId: number | undefined;
    if (isRegisterTarget) {
      registerTargetNameNorms.add(nameNorm);
      if (idCands.size === 1) {
        const only = [...idCands][0];
        reuseExistingMaster++; reuseMasterIds.add(only);     // 기존 ID 재사용(안전 연결)
        act = "reuse"; bkt = "reuse"; mId = only;
        // ⑥ 보완 가능: CRM 행이 기존 Master에 없는 식별정보(이메일/휴대폰/주민번호)를 보유 → 보완 후보.
        if ((emailReal && !mHasEmail.has(only)) || (phone && !mHasPhone.has(only)) || (rrn && !mHasRrn.has(only))) masterSupplementable++;
      } else {
        const idOwnerElsewhere = (!!rrn && mRrnToIds.has(rrn)) || (!!emailReal && mEmailToIds.has(emailReal)) || (!!phone && mPhoneToIds.has(phone));
        if (idCands.size === 0 && !idOwnerElsewhere && nameSet.size === 0) {
          newMasterToCreate++;                               // 기존 Master 없음(이름·식별정보 모두 미존재) → 신규 생성 예정
          act = "new"; bkt = "newPure";
        } else {
          // ── 동일인 확정 불가 → 등록자격(A/B)과 식별을 분리해 재분류(요구사항1~4). ──
          //   실제 중복위험(복수후보·식별정보/주민번호 충돌)만 수동. 그 외 자격 충족분은 독립 신규 후보.
          identityException++;
          if (!rrn) exMissingRrn++;
          if (!emailReal && !phone) exMissingContact++;
          const sameNameWithRrn = [...nameSet].some((id) => mHasRrn.has(id));
          const progRrns = progNameToRrns.get(nameNorm);
          const historyIdMismatch = histName && !!rrn && !!progRrns && progRrns.size > 0 && !progRrns.has(rrn);
          // idOwnerElsewhere=false 지점이므로 CRM 식별정보(주민번호/실명이메일/휴대폰)는 기존 Master와 '실제 충돌' 없음(요구사항4).
          if (idCands.size >= 2) {
            exMultiCandidate++; act = "manual"; bkt = "multiCandidate";   // 복수 후보 → 수동(자동병합 금지)
          } else if (idOwnerElsewhere) {
            exIdConflict++; act = "manual"; bkt = "idConflict";          // 식별정보를 다른 이름 Master가 보유 → 수동(실제 충돌)
          } else if (historyIdMismatch) {
            exHistoryMismatch++; act = "manual"; bkt = "historyMismatch"; // 진행관리표 주민번호와 CRM 주민번호 불일치 → 수동
          } else if (rrn && sameNameWithRrn) {
            exRrnMismatch++; act = "manual"; bkt = "rrnMismatch";        // 동명 Master가 다른 주민번호 보유 → 수동(귀화 포함 확인)
          } else if (rrn) {
            exRrnIndepNew++; act = "new"; bkt = "rrnIndepNew";           // 주민번호 보유·충돌 없음 → 독립 신규 후보(주민번호 우선 식별)
          } else if (histName) {
            exHistoryIndepNew++; act = "new"; bkt = "historyIndepNew";   // 수행이력 확인·주민번호 없음·충돌 없음 → 독립 신규 후보(동명이인 가능)
          } else {
            exOther++; act = "manual"; bkt = "other";                    // 기타(이론상 희소) → 수동
          }
        }
      }
    }

    // 실행 계획 1인 레코드(요구사항7·8) — withPlan 일 때만. 주민번호 원문 미보관(신규용 암호문·마스킹만).
    if (opts.withPlan) {
      const rrnPlain = rrn;   // 서버 지역변수(13자리). plan 에는 암호문/마스킹만 저장하고 원문은 보관하지 않는다.
      plan.push({
        rowNumber: parsed.headerRowIndex + 2 + parsed.dataRows.indexOf(raw),
        action: act, bucket: bkt, masterId: mId,
        name,
        englishName: normalizeName(getCell(raw, colMap, "englishName")),
        emailNorm: emailReal || normalizeEmail(emailRaw),   // 실명 우선, 없으면 정규화 이메일(임시 포함)
        phoneNorm: phone,
        region: normalizeName(getCell(raw, colMap, "region")),
        languages: normalizeName(getCell(raw, colMap, "languages")),
        services: normalizeName(getCell(raw, colMap, "services")),
        specializations: normalizeName(getCell(raw, colMap, "specializations")),
        education: normalizeName(getCell(raw, colMap, "education")),
        major: normalizeName(getCell(raw, colMap, "major")),
        graduationYear: normalizeName(getCell(raw, colMap, "graduationYear")),
        grade: normalizeName(getCell(raw, colMap, "grade")),
        availabilityStatus: normalizeName(getCell(raw, colMap, "availabilityStatus")),
        bio: (getCell(raw, colMap, "bio") ?? "").toString().trim(),
        rrnEnc: rrnPlain ? encrypt(rrnPlain) : null,         // 신규 생성 시 translator_sensitive 적재용(요구사항7)
        hasRrn: !!rrnPlain,
        residentMasked: rrnPlain ? maskResidentNumber(rrnPlain) : "",
        rowKey: emailReal ? `translator|e:${emailReal}` : phone ? `translator|m:${phone}` : `translator|n:${nameNorm}`,
      });
    }
  }
  const exceptionNewCandidate = exRrnIndepNew + exHistoryIndepNew;   // 동일인 미확정 → 독립 신규 후보로 재분류
  const exceptionManualReview = identityException - exceptionNewCandidate;   // 실제 수동 확인 필요(복수후보·식별정보/주민번호 충돌)
  const exceptionReconciled =
    exMultiCandidate + exIdConflict + exHistoryMismatch + exRrnMismatch + exRrnIndepNew + exHistoryIndepNew + exOther === identityException;

  // ── 진행관리표 수행자 이름 그룹(1,366) 연결 예정 산정(요구사항2·5) — 미연결 그룹을 CRM 등록대상·기존 Master와 전수 대조. ──
  const linkRow = (await db.execute(sql`
    WITH names AS (SELECT DISTINCT nullif(btrim(source_raw->>'통번역사명'),'') nm
      FROM legacy_archive_rows WHERE source_type='progress' AND is_effective=true
        AND nullif(btrim(source_raw->>'통번역사명'),'') IS NOT NULL)
    SELECT (SELECT count(*) FROM names) AS groups,
      (SELECT count(*) FROM names n WHERE EXISTS (SELECT 1 FROM legacy_master_mappings m
         WHERE m.entity_type='translator' AND m.status<>'rolled_back' AND btrim(m.legacy_id)=n.nm)) AS linked`)).rows[0] as any;
  // 미연결 그룹의 원본 이름 → 정규화 후 등록대상/기존 Master 성명과 대조(이름 기준 그룹이므로 실인원과 동일 가정 안 함).
  const unlinkedNames = (await db.execute(sql`
    WITH names AS (SELECT DISTINCT nullif(btrim(source_raw->>'통번역사명'),'') nm
      FROM legacy_archive_rows WHERE source_type='progress' AND is_effective=true
        AND nullif(btrim(source_raw->>'통번역사명'),'') IS NOT NULL)
    SELECT n.nm FROM names n WHERE NOT EXISTS (SELECT 1 FROM legacy_master_mappings m
       WHERE m.entity_type='translator' AND m.status<>'rolled_back' AND btrim(m.legacy_id)=n.nm)`)).rows as any[];
  const groups = Number(linkRow?.groups ?? 0);
  const linked = Number(linkRow?.linked ?? 0);
  const unlinked = groups - linked;
  let unlinkedWillConnect = 0;        // 미연결 그룹 중 등록대상/기존 Master와 성명 매칭 → 연결 예정
  for (const r of unlinkedNames) {
    const nn = r.nm ? normalizeCompanyName(String(r.nm)) : "";
    if (nn && (registerTargetNameNorms.has(nn) || masterNameNorms.has(nn))) unlinkedWillConnect++;
  }
  const progressLink = {
    groups, linked, unlinked,
    confirmed: linked,                            // 확정 연결(기존 legacy_master_mappings) — 이름만 일치는 포함 안 함(요구사항4)
    candidate: unlinkedWillConnect,               // 연결 후보(미연결 그룹 중 성명 매칭) — 확정 아님
    expected: linked + unlinkedWillConnect,       // 연결 예정 건수(기존 연결 + 미연결 중 매칭)
    unresolvedException: unlinked - unlinkedWillConnect,   // 동일인 확인 어려움 → 별도 예외 목록(요구사항2)
  };

  return {
    sheetName: parsed.sheetName,
    crmTotalRows: totalRows,
    crmUniquePersons: crmUnique,
    crmInternalDupById: internalDupById,         // 동일 식별자 중복행(K)
    crmSameNameNoIdentifier: sameNameNoId,        // 식별자 없는 동명 — 확인 필요
    crmInvalidRows: invalid,                      // 성명 누락 등
    uniqueWithRrn,
    A_withHistory: A_history,                     // 수행이력 O → 전원 등록
    A_confirmedByRrn: A_byRrn,                     // 주민번호로 확정
    A_byNameOnlyNeedsCheck: A_byNameOnly,          // 이름만 일치(동명이인 확인 필요)
    B_rrnNoHistory: B_rrnNoHistory,               // 수행이력 X · 주민번호 O → 등록
    C_hold: C_hold,                                // 수행이력 X · 주민번호 X → 보류
    registerTarget: A_history + B_rrnNoHistory,    // 최종 등록(A+B)
    // ── 기존 Master 교차대조(요구사항5) — reuse + new + exception = registerTarget 로 정합. ──
    reuseExistingMaster,                          // ⑤ 기존 Master 재사용 예정 인원(동일인 확정)
    reuseMasterCount: reuseMasterIds.size,         // ↑ 참고: 실제 재사용되는 고유 Master 수
    masterSupplementable,                         // ⑥ 기존 Master 정보 보완 가능 인원(재사용 대상 중 CRM이 결측 식별정보 보유)
    newMasterToCreate,                            // ⑦ 신규 Master 생성 예정 인원(이름·식별정보 모두 기존 Master에 없음)
    identityException,                            // ⑨ 동일인 확인 예외 인원(복수일치·동명 미확정 등)
    masterTotal: masterIds.size,                  // 참고: 기존 통번역사 Master 총원(미삭제)
    masterNotInCrm: masterIds.size - mastersFoundInCrm.size,   // ⑩ CRM 명부엔 없고 기존 Master엔 존재하는 인원
    dupMasterCleanup,                             // 중복 Master 정리 예정 인원(동일 주민번호 초과분·검증 후 비활성화 후보)
    masterMatchReconciled: reuseExistingMaster + newMasterToCreate + identityException === A_history + B_rrnNoHistory,
    // ── 동일인 확정 불가 인원 재분류(요구사항1~5) — 등록자격/식별 분리. 독립 신규 후보 vs 실제 수동. ──
    exceptionAnalysis: {
      total: identityException,
      newCandidate: exceptionNewCandidate,              // 독립 신규 등록 후보로 재분류(이름만 일치 자동연결 안 함)
      manualReview: exceptionManualReview,              // 실제 수동 확인 필요(복수후보·식별정보/주민번호 충돌)
      byReason: {
        multiCandidate: exMultiCandidate,               // 수동: 동일인 후보 복수
        idConflictOtherMaster: exIdConflict,            // 수동: 식별정보(실명이메일/휴대폰/주민번호)를 다른 Master 보유
        historyIdMismatch: exHistoryMismatch,           // 수동: 진행관리표 수행이력과 CRM 주민번호 불일치
        rrnMismatchSameName: exRrnMismatch,             // 수동: 동명 Master와 주민번호 불일치(귀화 포함 확인)
        rrnIndependentNew: exRrnIndepNew,               // 신규 후보: 주민번호 보유·충돌 없음(주민번호 우선 식별)
        historyIndependentNew: exHistoryIndepNew,       // 신규 후보: 수행이력 확인·주민번호 없음·충돌 없음(동명이인 가능)
        other: exOther,
      },
      diagnostics: { missingRrn: exMissingRrn, missingContact: exMissingContact },  // 비배타 진단(주민번호·연락처 누락)
      reconciled: exceptionReconciled,                  // 원인별 합계 === 동일인 미확정 총원
    },
    newMasterCandidateTotal: newMasterToCreate + exceptionNewCandidate,   // 신규 Master 등록 가능 인원(순수 신규 + 재분류 독립 신규)
    // ── 최종 처리방향(요구사항6) — 고유 인원 기준, 합계 정합 검증. ──
    finalDisposition: {
      reuseExisting: reuseExistingMaster,                             // 기존 Master 재사용
      newCandidate: newMasterToCreate + exceptionNewCandidate,        // 신규 Master 등록 가능
      manualReview: exceptionManualReview,                            // 실제 수동 확인 필요
      excluded: C_hold,                                               // 등록 제외
      total: crmUnique,
      reconciled: reuseExistingMaster + (newMasterToCreate + exceptionNewCandidate) + exceptionManualReview + C_hold === crmUnique,
    },
    progressLink,                                 // 진행관리표 연결 현황·예정(확정/후보/미연결 구분)
    reconciled: A_history + B_rrnNoHistory + C_hold === crmUnique,
    ...(opts.withPlan ? { plan } : {}),           // 실행 계획(요구사항7·8) — withPlan 호출에서만. PII(주민번호 원문) 미포함.
  };
}

const snapshotGuard = adminGuard;   // 관리자 전용. (super-admin 또는 admin/staff)

router.get("/admin/translators/bulk-import/snapshots", ...snapshotGuard, async (_req, res) => {
  try { res.json({ snapshots: listSnapshots("translator") }); }
  catch (err) { res.status(500).json({ error: "스냅샷 목록 조회 실패." }); }
});

router.post("/admin/translators/bulk-import/snapshots/:id/rebuild-analysis", ...snapshotGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!isValidSnapshotId(id)) { res.status(400).json({ error: "잘못된 스냅샷 ID." }); return; }
  const meta = getSnapshotMeta(id);
  const buf = readSnapshotBuffer(id);
  if (!meta || !buf) { res.status(404).json({ error: "스냅샷을 찾을 수 없거나 복호화 실패." }); return; }
  try {
    const classification = await classifyRebuildTargets(buf);
    // 진행관리표 연결 현황·예정(읽기 전용) — 이름 그룹 1,366 / 연결 / 미연결 / 연결 예정은 분류 함수가 산출.
    res.json({
      dryRun: true, committed: false,
      snapshot: { id: meta.id, filename: meta.filename, createdAt: meta.createdAt },
      classification,
      progressLink: classification.progressLink,
      note: "읽기 전용. Master 등록·삭제·매핑 변경 없음. 주민번호 원문 미반환·미로그.",
    });
  } catch (err) {
    req.log.error({ err }, "BulkImport: rebuild-analysis failed");
    res.status(500).json({ error: "재구축 분석 실패." });
  }
});

// ── 통번역사 Master 재구축 실제 등록 실행(요구사항1~9) ───────────────────────────────
//  · 기본은 DRY-RUN(계획+검증만, DB 미변경). 실제 반영은 commit=true + confirm=<snapshotId> 일 때만.
//  · 재사용(action='reuse')은 기존 Master ID 유지 + 공란 필드만 보완(fill-only). 주민번호/계좌/단가/이메일/별칭 보존.
//  · 신규(action='new')는 Master 생성 + 암호화 주민번호 적재 + CRM 매핑 신규 추가(기존 매핑 보존). UNIQUE(이메일/주민번호) 사전·실행 재검증.
//  · 수동(action='manual')·제외(action='exclude')는 생성하지 않음. 기존 Master 중 재사용 외 인원은 삭제·비활성화 없이 '최종 정리 대상' 목록만.
//  · 전 과정 단일 트랜잭션 — 실패 시 전체 롤백. 실행 전/후 인원·변경내역 기록(logs/import_batches).
// 재구축 실행 코어(요구사항1~9) — HTTP 라우트와 헤드리스 러너가 공유하는 단일 소스(로직 중복 방지). {status, body} 반환.
export async function runRebuildExecute(
  buf: Buffer,
  meta: { id: string; filename: string; createdAt?: string },
  performer: { id: number; email: string },
  opts: { commit: boolean; confirmToken: string },
  log?: { error?: (...a: any[]) => void },
): Promise<{ status: number; body: Record<string, unknown> }> {
    const result = await classifyRebuildTargets(buf, { withPlan: true });
    const plan = (result.plan as RebuildPersonAction[] | undefined) ?? [];
    const fd = result.finalDisposition as Record<string, unknown>;
    const commit = opts.commit;
    const confirmToken = opts.confirmToken;

    // 실행 전 인원(요구사항7 — 실행 전후 기록).
    const beforeCount = Number(((await db.execute(sql`SELECT count(*)::int n FROM users WHERE role='translator' AND deleted_at IS NULL`)).rows[0] as any)?.n ?? 0);

    // ── 라이브 UNIQUE 소유자 색인(요구사항7 — 이메일·주민번호 충돌 방지). 주민번호 복호는 서버 내부만. ──
    const liveUsers = await db.select({ email: usersTable.email }).from(usersTable).where(sql`${usersTable.deletedAt} is null`);
    const liveEmail = new Set<string>();
    for (const u of liveUsers) { const e = normalizeEmail(u.email); if (e) liveEmail.add(e); }
    const liveTEmails = await db.select({ email: translatorEmailsTable.email }).from(translatorEmailsTable);
    for (const te of liveTEmails) { const e = normalizeEmail(te.email); if (e) liveEmail.add(e); }
    const liveRrn = new Set<string>();
    const liveSens = await db.select({ rn: translatorSensitiveTable.residentNumber }).from(translatorSensitiveTable);
    for (const s of liveSens) { const raw = s.rn ? String(s.rn).trim() : ""; if (!raw) continue; try { const k = rrnDigits13(decrypt(raw)); if (k) liveRrn.add(k); } catch { /* skip */ } }
    const planRrn = (p: RebuildPersonAction): string | null => { if (!p.rrnEnc) return null; try { return rrnDigits13(decrypt(p.rrnEnc)); } catch { return null; } };

    // ── 신규 대상 사전검증: UNIQUE 충돌·파일내부 중복 → 생성 불가분 분리(요구사항7 — 중복 생성 방지). ──
    const seenNewEmail = new Set<string>(); const seenNewRrn = new Set<string>();
    let newCreatable = 0, emailCollision = 0, rrnCollision = 0, fileDupBlocked = 0;
    const blocked: { rowNumber: number; name: string; reason: string }[] = [];
    for (const p of plan) {
      if (p.action !== "new") continue;
      const rrnK = planRrn(p);
      const realEmail = p.emailNorm && !isLegacyPlaceholderEmail(p.emailNorm) ? p.emailNorm : "";
      if (realEmail && liveEmail.has(realEmail)) { emailCollision++; blocked.push({ rowNumber: p.rowNumber, name: p.name, reason: "email_unique_conflict" }); continue; }
      if (rrnK && liveRrn.has(rrnK)) { rrnCollision++; blocked.push({ rowNumber: p.rowNumber, name: p.name, reason: "rrn_unique_conflict" }); continue; }
      if (realEmail && seenNewEmail.has(realEmail)) { fileDupBlocked++; blocked.push({ rowNumber: p.rowNumber, name: p.name, reason: "file_internal_duplicate" }); continue; }
      if (rrnK && seenNewRrn.has(rrnK)) { fileDupBlocked++; blocked.push({ rowNumber: p.rowNumber, name: p.name, reason: "file_internal_duplicate" }); continue; }
      if (realEmail) seenNewEmail.add(realEmail);
      if (rrnK) seenNewRrn.add(rrnK);
      newCreatable++;
    }

    const reuseList = plan.filter((p) => p.action === "reuse");
    const manualList = plan.filter((p) => p.action === "manual");
    const excludeCount = plan.filter((p) => p.action === "exclude").length;

    // 최종 정리 대상(요구사항5): 기존 Master 중 재사용에 포함되지 않는 인원 — 삭제·비활성화 없이 목록 수만.
    const reuseIds = new Set<number>(reuseList.map((p) => p.masterId!).filter((x): x is number => !!x));
    const allMasters = await db.select({ id: usersTable.id }).from(usersTable).where(sql`${usersTable.role}='translator' and ${usersTable.deletedAt} is null`);
    const cleanupCandidates = allMasters.filter((m) => !reuseIds.has(m.id)).length;

    const validation = {
      idPreserved: true,                                // 재사용은 기존 id 유지(신규 id 생성 안 함)
      newCreatable, emailCollision, rrnCollision, fileDupBlocked,
      blockedSample: blocked.slice(0, 50),
      cleanupCandidates,                                // 최종 정리 대상(삭제/비활성화 안 함)
      originalsPreserved: true,                         // progress/sales_list/매핑/민감정보 원본 — 쓰기 경로에 포함 안 함
    };
    const projectedAfter = beforeCount + newCreatable;
    const readyToExecute = (result.exceptionAnalysis as any)?.reconciled === true && fd?.reconciled === true;

    // ── 요구사항2: 등록 제외 = 기준 C(주민번호 없음 AND 수행이력 없음) 검증. 다른 사유 제외 탐지. ──
    //   exclude 액션은 register target(histRrn||histName||rrn)이 아닐 때만 부여되므로 구조상 주민번호 보유 제외는 0이어야 함.
    const excludeList = plan.filter((p) => p.action === "exclude");
    const excludeWithRrn = excludeList.filter((p) => p.hasRrn).length;   // 기준 위반(있으면 안 됨)
    const excludeAudit = {
      total: excludeList.length,
      criterionC: excludeList.length - excludeWithRrn,   // 기준 C 정상 제외
      withRrnButExcluded: excludeWithRrn,                // 주민번호 보유인데 제외(다른 사유) — 0 기대
      nameMissingSeparate: Number((result.crmInvalidRows as number) ?? 0),  // 성명 누락 무효행(고유 2,019·526에 미포함)
      allCriterionC: excludeWithRrn === 0,
    };

    // ── 요구사항3: 수동 확인 대상 상세(개인정보 마스킹). ──
    const maskName = (n: string) => { const s = (n ?? "").trim(); return !s ? "(이름없음)" : s.length <= 1 ? "*" : s[0] + "*".repeat(s.length - 1); };
    const MANUAL_REASON: Record<string, { reason: string; action: string }> = {
      multiCandidate: { reason: "성명+식별정보가 복수 기존 Master와 일치", action: "수동 대조 후 1인 선택 또는 분리 등록" },
      idConflict: { reason: "식별정보(실명이메일/휴대폰/주민번호)를 다른 이름의 기존 Master가 보유", action: "타인 식별정보 여부 확인 → 동일인이면 보완, 아니면 신규" },
      historyMismatch: { reason: "진행관리표 수행이력과 CRM 주민번호 불일치", action: "수행이력 신원 확인 후 연결/분리" },
      rrnMismatch: { reason: "동명 기존 Master와 주민번호 불일치(귀화/개명 가능성)", action: "귀화·개명 여부 확인 후 동일인/별인 판정" },
      other: { reason: "기타", action: "수동 검토" },
    };
    const manualReviewDetail = manualList.map((p) => ({
      rowNumber: p.rowNumber, nameMasked: maskName(p.name), residentMasked: p.residentMasked || "(없음)",
      reasonCode: p.bucket, reason: MANUAL_REASON[p.bucket]?.reason ?? p.bucket, action: MANUAL_REASON[p.bucket]?.action ?? "수동 검토",
    }));

    // ── 요구사항1: 분석 결과 ↔ 실행 계획 정합. newCandidate = 실제 생성가능 + UNIQUE/중복 차단분. ──
    const blockedTotal = emailCollision + rrnCollision + fileDupBlocked;
    const planMatchesAnalysis =
      Number((fd as any).reuseExisting) === reuseList.length &&
      Number((fd as any).manualReview) === manualList.length &&
      Number((fd as any).excluded) === excludeCount &&
      Number((fd as any).newCandidate) === newCreatable + blockedTotal;

    if (!commit) {
      // DRY-RUN — DB INSERT/UPDATE/DELETE 없음.
      return { status: 200, body: {
        dryRun: true, committed: false,
        snapshot: { id: meta.id, filename: meta.filename, createdAt: meta.createdAt },
        disposition: fd,                                // reuse/newCandidate/manualReview/excluded + reconciled
        willRegister: { reuseExisting: reuseList.length, newCreate: newCreatable, manualHold: manualList.length, excluded: excludeCount },
        validation, beforeCount, projectedAfter, readyToExecute,
        planMatchesAnalysis,                            // 요구사항1
        excludeAudit,                                   // 요구사항2
        manualReviewDetail,                             // 요구사항3(마스킹)
        note: "읽기 전용. DB 미반영. 실제 실행은 commit=true & confirm=<snapshotId> 에서만. 이름만 일치 자동연결 없음·기존 ID 유지·민감정보/계좌/매핑 보존.",
      } };
    }

    // ── 실제 실행(commit=true) — 단일 트랜잭션·실패 시 롤백(요구사항7·8). ──
    if (confirmToken !== meta.id) { return { status: 400, body: { error: "확인 토큰 불일치. 실제 실행 시 confirm=<snapshotId> 필요." } }; }

    // 재사용 보완용 라이브 프로필/이메일 로드(공란 판정). 읽기 전용.
    const reuseUsers = await db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).where(sql`${usersTable.role}='translator' and ${usersTable.deletedAt} is null`);
    const userEmailById = new Map<number, string>(); for (const u of reuseUsers) userEmailById.set(u.id, u.email ?? "");
    const reuseProfiles = await db.select({
      userId: translatorProfilesTable.userId, phone: translatorProfilesTable.phone, region: translatorProfilesTable.region,
      languagePairs: translatorProfilesTable.languagePairs, profileWorkTypes: translatorProfilesTable.profileWorkTypes,
      specializations: translatorProfilesTable.specializations, education: translatorProfilesTable.education,
      major: translatorProfilesTable.major, graduationYear: translatorProfilesTable.graduationYear,
      grade: translatorProfilesTable.grade, bio: translatorProfilesTable.bio,
    }).from(translatorProfilesTable);
    const profById = new Map<number, typeof reuseProfiles[number]>(); for (const p of reuseProfiles) profById.set(p.userId, p);
    const empty = (v: unknown) => !((v ?? "").toString().trim());

    let createdCount = 0, updatedCount = 0, batchId: number | null = null;
    await db.transaction(async (tx) => {
      const [batch] = await tx.insert(importBatchesTable).values({
        module: "translator", importType: "legacy_migration",
        originalFilename: meta.filename || null, sheetName: null,
        totalRows: plan.length, successRows: 0, warningRows: manualList.length, errorRows: 0,
        status: "completed", createdBy: performer.id || null, sourceSystem: "crm_rebuild",
      }).returning({ id: importBatchesTable.id });
      batchId = batch.id;

      // 1) 신규 생성(action='new') — UNIQUE 재검증 후 users→profile→email→alias→sensitive→lineage→mapping.
      for (const p of plan) {
        if (p.action !== "new") continue;
        const rrnK = planRrn(p);
        const realEmail = p.emailNorm && !isLegacyPlaceholderEmail(p.emailNorm) ? p.emailNorm : "";
        if (realEmail && liveEmail.has(realEmail)) continue;    // 실행 시점 재검증(요구사항7)
        if (rrnK && liveRrn.has(rrnK)) continue;
        // users.email 은 NOT NULL·UNIQUE — 실명 이메일이 없으면 임시 이메일 생성(레거시 이관 방식). 스냅샷ID+행번호로 유일.
        const insertEmail = p.emailNorm || `rebuild-${meta.id}-${p.rowNumber}@crm-migrated.invalid`;
        const [u] = await tx.insert(usersTable).values({
          email: insertEmail, password: null, name: p.name || null, role: "translator", isActive: true,
        }).returning({ id: usersTable.id });
        await tx.insert(translatorProfilesTable).values({
          userId: u.id, phone: p.phoneNorm || null, region: p.region || null,
          languagePairs: p.languages || null, profileWorkTypes: p.services || null,
          specializations: p.specializations || null, education: p.education || null,
          major: p.major || null, graduationYear: gradYear(p.graduationYear),
          grade: p.grade || null, availabilityStatus: p.availabilityStatus || "available", bio: p.bio || null,
        });
        await tx.insert(translatorEmailsTable).values({ translatorId: u.id, email: insertEmail, isPrimary: true }).onConflictDoNothing();
        const aliasVals = [buildTranslatorAliasValues(u.id, p.name, true)];
        if (p.englishName) aliasVals.push(buildTranslatorAliasValues(u.id, p.englishName, false));
        const aliasClean = aliasVals.filter((v) => v.normalizedAlias);
        if (aliasClean.length) await tx.insert(translatorAliasesTable).values(aliasClean).onConflictDoNothing();
        if (p.rrnEnc) await tx.insert(translatorSensitiveTable).values({ translatorId: u.id, residentNumber: p.rrnEnc }).onConflictDoNothing();  // 암호문 적재(요구사항7)
        await tx.insert(importRowSourcesTable).values({ batchId: batch.id, module: "translator", entityId: u.id, sourceFile: meta.filename || null, sourceSheet: null, sourceRow: p.rowNumber, rowKey: p.rowKey, status: "new" });
        await tx.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status, created_by, created_at)
          VALUES ('old_crm','translator', ${normalizeCompanyName(p.name)}, ${u.id}, 'crm_rebuild', 'active', ${performer.id || null}, now())
          ON CONFLICT (source_system, entity_type, legacy_id) DO NOTHING`);   // 기존 매핑 보존·신규만 추가
        if (realEmail) liveEmail.add(realEmail); if (rrnK) liveRrn.add(rrnK);
        createdCount++;
      }

      // 2) 재사용 보완(action='reuse') — 공란 필드만 채움(fill-only). 기존값·주민번호·계좌·단가 보존.
      for (const p of plan) {
        if (p.action !== "reuse" || !p.masterId) continue;
        const prof = profById.get(p.masterId);
        const upd: Record<string, unknown> = {};
        if (prof) {
          if (empty(prof.phone) && p.phoneNorm) upd.phone = p.phoneNorm;
          if (empty(prof.region) && p.region) upd.region = p.region;
          if (empty(prof.languagePairs) && p.languages) upd.languagePairs = p.languages;
          if (empty(prof.profileWorkTypes) && p.services) upd.profileWorkTypes = p.services;
          if (empty(prof.specializations) && p.specializations) upd.specializations = p.specializations;
          if (empty(prof.education) && p.education) upd.education = p.education;
          if (empty(prof.major) && p.major) upd.major = p.major;
          if (prof.graduationYear == null) { const gy = gradYear(p.graduationYear); if (gy != null) upd.graduationYear = gy; }
          if (empty(prof.grade) && p.grade) upd.grade = p.grade;
          if (empty(prof.bio) && p.bio) upd.bio = p.bio;
        }
        let changed = false;
        if (Object.keys(upd).length) { await tx.update(translatorProfilesTable).set(upd).where(eq(translatorProfilesTable.userId, p.masterId)); changed = true; }
        // 이메일: 기존이 임시(@crm-migrated.invalid)이고 CRM 실명 이메일이 충돌 없을 때만 교체(fill-only 확장).
        const curEmail = userEmailById.get(p.masterId) ?? "";
        const realEmail = p.emailNorm && !isLegacyPlaceholderEmail(p.emailNorm) ? p.emailNorm : "";
        if (realEmail && isLegacyPlaceholderEmail(curEmail) && !liveEmail.has(realEmail)) {
          await tx.update(usersTable).set({ email: realEmail }).where(eq(usersTable.id, p.masterId));
          await tx.insert(translatorEmailsTable).values({ translatorId: p.masterId, email: realEmail, isPrimary: false }).onConflictDoNothing();
          liveEmail.add(realEmail); changed = true;
        }
        // 별칭 보강(검색 일관성) — 중복 무시. 기존 별칭 삭제 안 함.
        const aliasVals = [buildTranslatorAliasValues(p.masterId, p.name, false)];
        if (p.englishName) aliasVals.push(buildTranslatorAliasValues(p.masterId, p.englishName, false));
        const aliasClean = aliasVals.filter((v) => v.normalizedAlias);
        if (aliasClean.length) await tx.insert(translatorAliasesTable).values(aliasClean).onConflictDoNothing();
        // CRM↔기존 Master 매핑 신규 추가(기존 보존).
        await tx.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status, created_by, created_at)
          VALUES ('old_crm','translator', ${normalizeCompanyName(p.name)}, ${p.masterId}, 'crm_rebuild_reuse', 'active', ${performer.id || null}, now())
          ON CONFLICT (source_system, entity_type, legacy_id) DO NOTHING`);
        if (changed) updatedCount++;
      }

      await tx.update(importBatchesTable).set({ successRows: createdCount + updatedCount }).where(eq(importBatchesTable.id, batch.id));
    });

    await logEvent("translator", 0, "crm_rebuild_execute", log as any, performer.id ? performer : undefined,
      JSON.stringify({ snapshot: meta.id, beforeCount, afterCount: beforeCount + createdCount, created: createdCount, updated: updatedCount, manualHold: manualList.length, excluded: excludeCount, cleanupCandidates, batchId }));
    return { status: 200, body: { dryRun: false, committed: true, batchId, beforeCount, afterCount: beforeCount + createdCount, created: createdCount, updated: updatedCount, manualHold: manualList.length, excluded: excludeCount } };
}

router.post("/admin/translators/bulk-import/snapshots/:id/rebuild-execute", ...snapshotGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!isValidSnapshotId(id)) { res.status(400).json({ error: "잘못된 스냅샷 ID." }); return; }
  const meta = getSnapshotMeta(id);
  const buf = readSnapshotBuffer(id);
  if (!meta || !buf) { res.status(404).json({ error: "스냅샷을 찾을 수 없거나 복호화 실패." }); return; }
  try {
    const commit = (req.body as any)?.commit === true || (req.body as any)?.commit === "true";
    const confirmToken = String((req.body as any)?.confirm ?? "");
    const performer = { id: (req as any).user?.id ?? 0, email: (req as any).user?.email ?? "" };
    const out = await runRebuildExecute(buf, meta, performer, { commit, confirmToken }, req.log);
    res.status(out.status).json(out.body);
  } catch (err) {
    req.log.error({ err }, "BulkImport: rebuild-execute failed");
    res.status(500).json({ error: "재구축 실행 실패(트랜잭션 롤백됨)." });
  }
});

router.delete("/admin/translators/bulk-import/snapshots/:id", ...snapshotGuard, async (req, res) => {
  const id = String(req.params.id);
  if (!isValidSnapshotId(id)) { res.status(400).json({ error: "잘못된 스냅샷 ID." }); return; }
  const ok = deleteSnapshot(id);
  res.json({ deleted: ok });
});

router.post(
  "/admin/translators/bulk-import/execute",
  ...adminGuard,   // 통번역사 수동 등록과 동일한 접근 기준(별도 permission key 없음)
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    const fileName = decodeFileName(req.file.originalname);
    try {
      // 서버 재분석·재검증(§16 보안). new-only(§17): "신규등록"으로 확정된 행만 INSERT.
      // 민감정보(translator_sensitive)·rates·수행/정산 관계는 일절 생성·변경하지 않는다(§4·§24).
      const result = await analyzeTranslators(req.file.buffer);
      const newRows = result.rows.filter((r) => r.status === "new");
      const summary = summarize(result.rows);
      const performer = { id: (req as any).user?.id ?? 0, email: (req as any).user?.email ?? "" };

      let inserted = 0;
      let batchId: number | null = null;
      if (newRows.length > 0) {
        await db.transaction(async (tx) => {
          const [batch] = await tx
            .insert(importBatchesTable)
            .values({
              module: "translator", importType: ((req.body as any)?.sourceSystem) ? "legacy_migration" : "excel_bulk",
              originalFilename: fileName || null, sheetName: result.sheetName || null,
              totalRows: summary.total, successRows: newRows.length, warningRows: 0, errorRows: summary.error,
              status: "completed", createdBy: performer.id || null,
              sourceSystem: (req.body as any)?.sourceSystem ?? null,  // C-1(additive): legacy 이관 연계
            })
            .returning({ id: importBatchesTable.id });
          batchId = batch.id;

          // 행별 순차 INSERT(users→profile→email→alias→lineage). 이메일 unique 는 재검증으로 사전 차단됨.
          for (const r of newRows) {
            const [u] = await tx.insert(usersTable).values({
              email: r.emailNorm, password: null, name: r.name || null,
              role: "translator", isActive: true,
            }).returning({ id: usersTable.id, createdAt: usersTable.createdAt });

            await tx.insert(translatorProfilesTable).values({
              userId: u.id,
              phone: r.phone || null,
              region: r.region || null,
              languagePairs: r.languages || null,
              profileWorkTypes: r.services || null,
              specializations: r.specializations || null,
              education: r.education || null,
              major: r.major || null,
              graduationYear: r.graduationYear ? Number(r.graduationYear) : null,
              grade: r.grade || null,
              availabilityStatus: r.availabilityStatus || "available",
              bio: r.bio || null,   // 상세정보 원문 보존(§7·§23)
            });

            await tx.insert(translatorEmailsTable).values({ translatorId: u.id, email: r.emailNorm, isPrimary: true });

            // 실명 기반 기본 alias + (있으면) 영문명 alias — 검색 일관성. 중복은 무시.
            const aliasVals = [buildTranslatorAliasValues(u.id, r.name, true)];
            if (r.englishName) aliasVals.push(buildTranslatorAliasValues(u.id, r.englishName, false));
            const aliasClean = aliasVals.filter((v) => v.normalizedAlias);
            if (aliasClean.length > 0) await tx.insert(translatorAliasesTable).values(aliasClean).onConflictDoNothing();

            await tx.insert(importRowSourcesTable).values({
              batchId: batch.id, module: "translator", entityId: u.id,
              sourceFile: fileName || null, sourceSheet: result.sheetName || null,
              sourceRow: r.rowNumber, rowKey: translatorRowKey(r), status: "new",
            });
            inserted += 1;
          }
        });
      }

      await logEvent("translator", 0, "bulk_import_translators", req.log, performer.id ? performer : undefined,
        JSON.stringify({ fileName, mode: "new_only", batchId, total: summary.total, inserted, identical: summary.identical, needsReview: summary.needsReview, duplicateFile: summary.duplicateFile, error: summary.error }));

      res.json({ fileName, mode: "new_only", batchId, inserted, updated: 0, summary });
    } catch (err) {
      req.log.error({ err }, "BulkImport: translator execute failed");
      res.status(500).json({ error: "통번역사 일괄 등록 실패." });
    }
  },
);

// ── 통번역사 기존 Master 상세정보 보완 — 드라이런(계획) ────────────────────────────
// 요구사항: 주민번호 13자리 완전 일치 = 동일인 확정 → 상세정보 보완 계획을 산출(★DB 미변경 dry-run★).
//   · 자동 반영(apply) 허용 = 주민번호 단일일치(matchMethod='rrn')에 한함(요구사항1·8). 그 외는 검토(hold).
//   · 필드 결정 규칙(요구사항3~7):
//       - CRM 공란 → 기존 유지(변경 아님, 요구사항5)
//       - 기존 공란 + CRM 값 → 보완(fill, 자동)
//       - 이메일: 기존이 임시(@crm-migrated.invalid) → CRM 실제 이메일로 교체(자동, 요구사항4)
//                 기존이 실제 이메일 & 상이 → 연락처 검토(요구사항7)
//       - 휴대폰: 기존 값 & 상이 → 수정일 불명확 → 검토(요구사항7)
//       - 언어·상세정보: 기존 유효값 삭제 금지 → 추가·통합 검토(merge, 요구사항6)
//       - 그 외 상이 → 충돌 검토
//   · 비활성 계정은 보완해도 비활성 유지(요구사항9) — isActive 는 계획에 포함하지 않음.
//   · 주민번호 불일치·중복·미등록 자동 반영 금지(요구사항8). 주민번호 원문·ID·매핑·수행/지급 연결 보존(요구사항10).
//   · 감사기록은 변경 전/후 비교 + 결정(category/decision)을 미리보기로 제공(실제 기록은 commit 단계, logs/import_batches 재사용).
type FieldDecision = "keep" | "apply" | "hold";
type FieldCategory = "fill" | "email_replace" | "merge" | "contact_review" | "conflict_review";
const UPDATE_FIELD_LABELS: Record<string, string> = {
  name: "성명", email: "이메일", phone: "휴대폰", languages: "언어", services: "가능서비스",
  specializations: "전문분야", grade: "인력등급", region: "활동지역",
  education: "학력", major: "전공", graduationYear: "졸업년도", bio: "상세정보",
};
const MERGE_FIELDS = new Set(["languages", "bio"]);     // 언어·상세정보(경력) — 삭제 금지·통합 검토(요구사항6)
const AUTO_CATEGORIES = new Set<FieldCategory>(["fill", "email_replace"]);
// 변경된 필드(old≠new, CRM 비공란)에 대한 결정 범주. old 공란이면 "fill".
function updateFieldCategory(field: string, oldVal: string, newVal: string): FieldCategory {
  if (!(oldVal ?? "").trim()) return "fill";                                              // 기존 공란 → 보완(자동)
  if (field === "email") return isLegacyPlaceholderEmail(oldVal) ? "email_replace" : "contact_review"; // 임시→교체(자동)/실제상이→검토
  if (field === "phone") return "contact_review";                                        // 연락처 상이 → 검토(요구사항7)
  if (MERGE_FIELDS.has(field)) return "merge";                                           // 언어·상세정보 → 통합 검토(요구사항6)
  return "conflict_review";
}
router.post(
  "/admin/translators/bulk-import/update-plan",
  ...adminGuard,
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    try {
      // 관리자 필드별 선택(override): { "<existingId>:<fieldKey>": "keep"|"apply"|"hold" }
      let selections: Record<string, FieldDecision> = {};
      try {
        const raw = (req.body as any)?.selections;
        if (typeof raw === "string" && raw.trim()) selections = JSON.parse(raw);
        else if (raw && typeof raw === "object") selections = raw;
      } catch { selections = {}; }
      const decisionOf = (id: number, field: string, fallback: FieldDecision): FieldDecision => {
        const v = selections[`${id}:${field}`];
        return v === "keep" || v === "apply" || v === "hold" ? v : fallback;
      };

      // 서버 재분석(§16 보안). DB 변경 없음.
      const result = await analyzeTranslators(req.file.buffer);

      // 동일인 확정 대상(applyMatch 결과) — 보완 가능.
      const eligible = result.rows.filter(
        (r) => (r.status === "update" || r.status === "conflict") && r.existingId != null &&
          (r.matchMethod === "rrn" || r.matchMethod === "email" || r.matchMethod === "phone"),
      );
      const blocked = result.rows.filter(
        (r) => r.reviewCategory === "homonym" || r.reviewCategory === "undecidable" ||
          r.reviewCategory === "same_person" || r.reviewCategory === "legacy_no_email" || r.reviewCategory === "file_internal",
      ).length;

      const applyFieldCounts: Record<string, number> = {};
      const holdFieldCounts: Record<string, number> = {};
      const keepFieldCounts: Record<string, number> = {};
      const categoryCounts: Record<FieldCategory, number> = { fill: 0, email_replace: 0, merge: 0, contact_review: 0, conflict_review: 0 };
      const personsToUpdate = new Set<number>();
      let appliedFieldTotal = 0;
      const auditPreview: Array<{
        masterId: number; name: string; residentMasked: string | null; matchMethod: string | null;
        masterInactive: boolean; autoUpdatable: boolean;
        changes: Array<{ field: string; label: string; old: string; new: string; category: FieldCategory; autoAllowed: boolean; decision: FieldDecision }>;
      }> = [];

      for (const r of eligible) {
        const id = r.existingId as number;
        const isRrn = r.matchMethod === "rrn";   // 자동 반영은 주민번호 일치에 한함(요구사항1·8)
        const rowChanges: Array<{ field: string; label: string; old: string; new: string; category: FieldCategory; autoAllowed: boolean; decision: FieldDecision }> = [];
        let anyReview = false;
        for (const [field, ch] of Object.entries(r.changes ?? {})) {
          const category = updateFieldCategory(field, ch.old, ch.new);
          categoryCounts[category] += 1;
          const autoAllowed = isRrn && AUTO_CATEGORIES.has(category);   // fill·임시이메일교체 & 주민번호 일치만 자동
          if (!autoAllowed) anyReview = true;
          const decision = decisionOf(id, field, autoAllowed ? "apply" : "hold");
          rowChanges.push({ field, label: UPDATE_FIELD_LABELS[field] ?? field, old: ch.old, new: ch.new, category, autoAllowed, decision });
          if (decision === "apply") { applyFieldCounts[field] = (applyFieldCounts[field] ?? 0) + 1; appliedFieldTotal += 1; personsToUpdate.add(id); }
          else if (decision === "hold") holdFieldCounts[field] = (holdFieldCounts[field] ?? 0) + 1;
          else keepFieldCounts[field] = (keepFieldCounts[field] ?? 0) + 1;
        }
        if (rowChanges.length > 0) {
          auditPreview.push({
            masterId: id, name: r.name, residentMasked: r.residentMasked ?? null, matchMethod: r.matchMethod ?? null,
            masterInactive: r.masterInactive === true, autoUpdatable: isRrn && !anyReview, changes: rowChanges,
          });
        }
      }

      // ── 주민번호 일치 대상 산출(요구사항: 453행 대상 자동 가능/검토 필요) ──
      const rrnSingle = result.rows.filter((r) => r.matchMethod === "rrn" && (r.status === "identical" || r.status === "update" || r.status === "conflict"));
      const rrnMulti = result.rows.filter((r) => r.matchMethod === "rrn" && r.status === "needs_review").length;  // 주민번호 중복 → 자동 금지(요구사항8)
      let rrnNoChange = 0, rrnAutoUpdatable = 0, rrnReviewNeeded = 0;
      for (const r of rrnSingle) {
        const changes = Object.entries(r.changes ?? {});
        if (changes.length === 0) { rrnNoChange += 1; continue; }   // 이미 동일(변경 없음)
        const hasReview = changes.some(([field, ch]) => !AUTO_CATEGORIES.has(updateFieldCategory(field, ch.old, ch.new)));
        if (hasReview) rrnReviewNeeded += 1; else rrnAutoUpdatable += 1;
      }

      const inactiveWithApply = auditPreview.filter((a) => a.masterInactive && a.changes.some((c) => c.decision === "apply")).length;

      res.json({
        fileName: decodeFileName(req.file.originalname),
        dryRun: true,            // ★ 실제 DB 변경 없음 ★
        committed: false,
        summary: {
          eligibleRows: eligible.length,
          eligiblePersons: new Set(eligible.map((r) => r.existingId)).size,
          blockedRows: blocked,
          personsToUpdate: personsToUpdate.size,
          appliedFieldTotal,
          applyFieldCounts, holdFieldCounts, keepFieldCounts, categoryCounts,
          inactiveWithApply,
        },
        // 주민번호 일치 대상 핵심 집계(요구사항).
        rrnReport: {
          rrnSingleTotal: rrnSingle.length,       // 주민번호 13자리 단일 일치(동일인 확정)
          rrnAutoUpdatable,                        // 자동 업데이트 가능(공란 보완·임시이메일 교체만)
          rrnReviewNeeded,                         // 추가 검토 필요(연락처 상이·언어/상세정보 통합·기타 충돌)
          rrnNoChange,                             // 이미 동일(변경 없음)
          rrnMultiBlocked: rrnMulti,               // 주민번호 중복 → 자동 반영 금지
          reconciled: rrnNoChange + rrnAutoUpdatable + rrnReviewNeeded === rrnSingle.length,
        },
        auditPreview,
        note: "dry-run: DB 미반영. 자동 반영은 주민번호 일치에 한함. 활성화(isActive)·주민번호 원문·ID·legacy 매핑·수행/지급 연결은 변경 대상에서 제외됩니다.",
      });
    } catch (err) {
      req.log.error({ err }, "BulkImport: translator update-plan failed");
      res.status(500).json({ error: "업데이트 계획 생성 실패." });
    }
  },
);

// ── 견적(4차) 분석 ────────────────────────────────────────────────────────────
// 견적 = projects(status=created 컨테이너) + quotes(헤더) + quote_items(품목). 수동 견적등록과 동일 구조.
// 이번 Import 는 일반견적(b2b_standard)만 허용(§7). 누적/선입금/차감/관계견적 직접 생성 금지(§7·§8).
// 금액은 기존 SSOT(computeQuoteItemAmounts/calcQuoteItemAmounts) 재사용(§15). new-only(§17).
// project+quote+items 는 한 트랜잭션(§18). 판매전환/판매·청구·지급·정산·prepaid 생성 없음(§19·§21).
const QUOTE_ALLOWED_TYPE = "b2b_standard";
function parseQuoteTypeCell(raw: string): { type: string; ok: boolean } {
  const s = raw.replace(/[\s()]/g, "").toLowerCase();
  if (!s) return { type: QUOTE_ALLOWED_TYPE, ok: true };
  if (["일반", "일반견적", "b2bstandard", "standard", "일반b2b"].includes(s)) return { type: QUOTE_ALLOWED_TYPE, ok: true };
  return { type: s, ok: false }; // 누적/선입금/차감/변경/추가/파생/분할 등 → 미지원
}
// 부가세: 개별 견적등록의 header vatType(taxable|exempt|zero_rate)과 동일 규칙(§5·§6 CASE B).
//  UI 라벨: '부가세 10%'(taxable) / '면세'(exempt) / '영세율'(zero_rate). taxRate = taxable ? 0.1 : 0.
function parseVatCell(raw: string): { vatType: "taxable" | "exempt" | "zero_rate"; ok: boolean } {
  const s = raw.replace(/[\s()]/g, "").toLowerCase();
  if (!s) return { vatType: "taxable", ok: true };
  if (["부가세10%", "10%", "과세", "taxable", "부가세", "vat"].includes(s)) return { vatType: "taxable", ok: true };
  if (["면세", "exempt"].includes(s)) return { vatType: "exempt", ok: true };
  if (["영세율", "영세", "zero", "zerorate", "zero_rate", "0%"].includes(s)) return { vatType: "zero_rate", ok: true };
  return { vatType: "taxable", ok: false };
}
function mapItemType(serviceMain: string, serviceType: string): string {
  const s = `${serviceMain} ${serviceType}`;
  if (/통역/.test(s)) return "interpretation";
  if (/장비/.test(s)) return "equipment";
  if (/경비|비용|출장|교통|숙박/.test(s)) return "expense";
  return "translation";
}
function numCell(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

interface QuoteItemResolved {
  seq: number; rowNumber: number;
  productId: number | null; productName: string; itemType: string; languagePair: string | null;
  unit: string; quantity: number; unitPrice: number; interpreterCount: number | null; taxRate: 0 | 0.1;
  interpretDate: string | null; interpretPlace: string | null;
  eventStartDate: string | null; eventEndDate: string | null; memo: string | null;
  supplyAmount: number; taxAmount: number; totalAmount: number;
}
interface QuoteRow {
  rowNumber: number; status: RowStatus; reason?: string;
  tempKey: string; title: string; quoteType: string; vatType: "taxable" | "exempt" | "zero_rate";
  companyName: string; matchedCompanyName: string; companyId: number | null; businessNumber: string;
  contactName: string; contactId: number | null; pm: string; adminId: number | null;
  issueDate: string; validUntil: string; note: string;
  itemCount: number; supplyAmount: number; taxAmount: number; totalAmount: number;
  items: QuoteItemResolved[]; fingerprint: string; existingQuoteId?: number | null;
}

async function analyzeQuotes(buffer: Buffer): Promise<{
  sheetName: string; headerRowIndex: number; columnMap: Record<string, string | null>; rows: QuoteRow[];
}> {
  const sheets = parseWorkbookSheets(buffer, {
    header: { hints: ["견적등록", "견적목록", "견적"], synonyms: QUOTE_HEADER_SYNONYMS },
    items: { hints: ["견적품목", "품목상세", "품목"], synonyms: QUOTE_ITEM_SYNONYMS },
  });
  const headerSheet = sheets.header;
  const itemSheet = sheets.items;
  if (!headerSheet) { const e = new Error("QUOTE_NO_HEADER_SHEET"); throw e; }
  const hMap = buildColumnMap(headerSheet.headers, QUOTE_HEADER_SYNONYMS);
  const iMap = itemSheet ? buildColumnMap(itemSheet.headers, QUOTE_ITEM_SYNONYMS) : {};

  // ── 연결 데이터 로드 ──
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name,
      biz: sql<string>`regexp_replace(coalesce(${companiesTable.businessNumber}, ''), '[^0-9]', '', 'g')` })
    .from(companiesTable).where(sql`${companiesTable.deletedAt} is null`);
  const byBiz = new Map<string, MiniCompany[]>(); const byCoName = new Map<string, MiniCompany[]>();
  for (const c of companies) {
    const mc = { id: c.id, name: c.name };
    if (c.biz) { const a = byBiz.get(c.biz); if (a) a.push(mc); else byBiz.set(c.biz, [mc]); }
    const nk = normalizeCompanyNameKey(c.name); if (nk) { const a = byCoName.get(nk); if (a) a.push(mc); else byCoName.set(nk, [mc]); }
  }
  const contacts = await db.select({ id: contactsTable.id, companyId: contactsTable.companyId, name: contactsTable.name })
    .from(contactsTable).where(sql`${contactsTable.isActive} = true and ${contactsTable.deletedAt} is null`);
  const contactByCoName = new Map<string, number[]>();
  for (const c of contacts) { const k = `${c.companyId}|${normalizeName(c.name)}`; const a = contactByCoName.get(k); if (a) a.push(c.id); else contactByCoName.set(k, [c.id]); }
  const pmUsers = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable).where(sql`${usersTable.role} in ('admin','staff') and ${usersTable.deletedAt} is null`);
  const pmByName = new Map<string, number[]>(); const pmByEmail = new Map<string, number>();
  for (const u of pmUsers) { const nn = normalizeCompanyName(u.name ?? ""); if (nn) { const a = pmByName.get(nn); if (a) a.push(u.id); else pmByName.set(nn, [u.id]); } const em = normalizeEmail(u.email); if (em) pmByEmail.set(em, u.id); }
  const products = await db.select({ id: productsTable.id, code: productsTable.code, name: productsTable.name, productType: productsTable.productType }).from(productsTable);
  const prodByCode = new Map<string, { id: number; name: string; productType: string }>();
  const prodByName = new Map<string, { id: number; name: string; productType: string }[]>();
  for (const p of products) {
    const ck = String(p.code ?? "").trim().toLowerCase(); if (ck) prodByCode.set(ck, { id: p.id, name: p.name, productType: p.productType });
    const nk = normalizeCompanyName(p.name); if (nk) { const a = prodByName.get(nk); if (a) a.push({ id: p.id, name: p.name, productType: p.productType }); else prodByName.set(nk, [{ id: p.id, name: p.name, productType: p.productType }]); }
  }
  // 기존 견적 fingerprint(재업로드·중복 탐지, §25). 파생은 derivedCompanyId, 그 외 project.companyId.
  const existingQuotes = await db.select({
      id: quotesTable.id, title: quotesTable.title, price: quotesTable.price, issueDate: quotesTable.issueDate,
      companyId: sql<number | null>`COALESCE(${quotesTable.derivedCompanyId}, ${projectsTable.companyId})`,
    }).from(quotesTable).leftJoin(projectsTable, eq(quotesTable.projectId, projectsTable.id))
    .where(sql`${quotesTable.deletedAt} is null`);
  const existingFp = new Map<string, number>();
  const fpOf = (companyId: number | null, issueDate: string, title: string, total: number) =>
    `${companyId ?? 0}|${issueDate}|${normalizeCompanyName(title)}|${total}`;
  for (const q of existingQuotes) {
    const fp = fpOf(q.companyId ?? null, String(q.issueDate ?? ""), String(q.title ?? ""), Math.round(Number(q.price)));
    if (!existingFp.has(fp)) existingFp.set(fp, q.id);
  }

  // ── 품목 시트 → tempKey 별 그룹 ──
  const itemsByKey = new Map<string, { rowNumber: number; seq: number; raw: unknown[] }[]>();
  const itemKeysSeen = new Set<string>();
  if (itemSheet) {
    itemSheet.dataRows.forEach((raw, i) => {
      if (isBlankRow(raw)) return;
      const rowNumber = itemSheet.headerRowIndex + 2 + i;
      const key = normalizeName(getCell(raw, iMap, "tempKey")).toUpperCase();
      if (!key) return; // tempKey 없는 품목행은 헤더 매칭 단계에서 orphan 으로 처리 불가 → 무시(빈 연결키)
      itemKeysSeen.add(key);
      const seq = Math.round(numCell(getCell(raw, iMap, "seq")));
      const arr = itemsByKey.get(key); const rec = { rowNumber, seq, raw };
      if (arr) arr.push(rec); else itemsByKey.set(key, [rec]);
    });
  }

  // ── 헤더 시트 파싱 + tempKey 중복 사전집계 ──
  const headerRaws: { rowNumber: number; raw: unknown[]; tempKey: string }[] = [];
  const tempKeyCount = new Map<string, number>();
  headerSheet.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const rowNumber = headerSheet.headerRowIndex + 2 + i;
    const tempKey = normalizeName(getCell(raw, hMap, "tempKey")).toUpperCase();
    headerRaws.push({ rowNumber, raw, tempKey });
    if (tempKey) tempKeyCount.set(tempKey, (tempKeyCount.get(tempKey) ?? 0) + 1);
  });

  const seenFileFp = new Set<string>();
  const usedItemKeys = new Set<string>();
  const rows: QuoteRow[] = [];

  for (const h of headerRaws) {
    const title = normalizeName(getCell(h.raw, hMap, "title"));
    const qt = parseQuoteTypeCell(normalizeName(getCell(h.raw, hMap, "quoteType")));
    const vat = parseVatCell(normalizeName(getCell(h.raw, hMap, "vatType")));
    const vatRate: 0 | 0.1 = vat.vatType === "taxable" ? 0.1 : 0;
    const bizRaw = normalizeName(getCell(h.raw, hMap, "businessNumber"));
    const bizNorm = normalizeBusinessNumber(bizRaw);
    const coNameRaw = normalizeName(getCell(h.raw, hMap, "companyName"));
    const coNameKey = normalizeCompanyNameKey(coNameRaw);
    const contactNameRaw = normalizeName(getCell(h.raw, hMap, "contactName"));
    const pmRaw = normalizeName(getCell(h.raw, hMap, "pm"));
    const issueDate = normalizeDate(getCell(h.raw, hMap, "issueDate")) || new Date().toISOString().slice(0, 10);
    const validUntil = normalizeDate(getCell(h.raw, hMap, "validUntil"));
    const note = normalizeName(getCell(h.raw, hMap, "note"));
    const groupItems = h.tempKey ? (itemsByKey.get(h.tempKey) ?? []) : [];
    if (h.tempKey) usedItemKeys.add(h.tempKey);

    const row: QuoteRow = {
      rowNumber: h.rowNumber, status: "new",
      tempKey: h.tempKey, title, quoteType: qt.type, vatType: vat.vatType,
      companyName: coNameRaw, matchedCompanyName: "", companyId: null, businessNumber: bizRaw,
      contactName: contactNameRaw, contactId: null, pm: pmRaw, adminId: null,
      issueDate, validUntil, note,
      itemCount: 0, supplyAmount: 0, taxAmount: 0, totalAmount: 0, items: [], fingerprint: "",
    };

    // ── 구조 검증(§10) ──
    if (!h.tempKey) { row.status = "error"; row.reason = "임시키 누락"; rows.push(row); continue; }
    if (tempKeyCount.get(h.tempKey)! >= 2) { row.status = "error"; row.reason = "임시키 중복"; rows.push(row); continue; }
    if (!title) { row.status = "error"; row.reason = "견적서명 누락"; rows.push(row); continue; }
    if (!qt.ok) { row.status = "error"; row.reason = "미지원 견적유형 (일반견적만 등록 가능)"; rows.push(row); continue; }
    if (!vat.ok) { row.status = "error"; row.reason = "미지원 부가세 값 (부가세 10% / 면세 / 영세율)"; rows.push(row); continue; }
    if (groupItems.length === 0) { row.status = "error"; row.reason = "품목 없음 (해당 임시키의 견적품목이 없습니다)"; rows.push(row); continue; }
    const seqs = groupItems.map((g) => g.seq);
    if (new Set(seqs).size !== seqs.length) { row.status = "error"; row.reason = "품목순번 중복"; rows.push(row); continue; }

    // ── 거래처 연결(§11) — 거래처코드 컬럼은 companies 스키마에 없어 사업자번호→거래처명 순 ──
    const link = resolveContactCompany(bizNorm, coNameKey, byBiz, byCoName);
    if (!link.company) { row.status = link.status ?? "error"; row.reason = `거래처 ${link.reason ?? "미확인"}`; rows.push(row); continue; }
    row.companyId = link.company.id; row.matchedCompanyName = link.company.name;

    // ── 담당자 연결(§12) — 확정 거래처 내부에서만 ──
    if (contactNameRaw) {
      const cands = contactByCoName.get(`${row.companyId}|${normalizeName(contactNameRaw)}`) ?? [];
      if (cands.length >= 2) { row.status = "needs_review"; row.reason = "담당자 다중후보(동일 거래처 동명이인)"; rows.push(row); continue; }
      if (cands.length === 1) row.contactId = cands[0];
      else { row.status = "needs_review"; row.reason = "담당자 미확인(해당 거래처에 없음) — 자동생성 금지"; rows.push(row); continue; }
    }
    // ── PM 연결(§13) ──
    if (pmRaw) {
      const em = normalizeEmail(pmRaw);
      if (em.includes("@")) { const id = pmByEmail.get(em); if (id) row.adminId = id; else { row.status = "needs_review"; row.reason = "PM 미확인(이메일 불일치)"; rows.push(row); continue; } }
      else { const cands = pmByName.get(normalizeCompanyName(pmRaw)) ?? []; if (cands.length >= 2) { row.status = "needs_review"; row.reason = "PM 다중후보 — 이메일로 지정 필요"; rows.push(row); continue; } if (cands.length === 1) row.adminId = cands[0]; else { row.status = "needs_review"; row.reason = "PM 미확인 — 자동생성 금지"; rows.push(row); continue; } }
    }

    // ── 품목 해석 + 상품 연결(§14) + 금액(§15) ──
    let itemError: string | null = null;
    const calcInput: { itemType: string; quantity: number; unitPrice: number; taxRate: 0 | 0.1; interpreterCount: number }[] = [];
    const resolved: Omit<QuoteItemResolved, "supplyAmount" | "taxAmount" | "totalAmount">[] = [];
    for (const g of groupItems.sort((a, b) => a.seq - b.seq)) {
      const serviceMain = normalizeName(getCell(g.raw, iMap, "serviceMain"));
      const serviceType = normalizeName(getCell(g.raw, iMap, "serviceType"));
      const productCode = normalizeName(getCell(g.raw, iMap, "productCode"));
      const productNameRaw = normalizeName(getCell(g.raw, iMap, "productName"));
      const itemType = mapItemType(serviceMain, serviceType);
      let productId: number | null = null; let productName = productNameRaw;
      if (productCode) {
        const p = prodByCode.get(productCode.toLowerCase());
        if (!p) { itemError = `상품 미확인(상품코드 ${productCode})`; break; }
        productId = p.id; if (!productName) productName = p.name;
      } else if (productNameRaw) {
        const cands = prodByName.get(normalizeCompanyName(productNameRaw)) ?? [];
        if (cands.length >= 2) { itemError = `상품 다중후보(${productNameRaw})`; break; }
        if (cands.length === 1) { productId = cands[0].id; } // 1개면 연결, 없으면 커스텀 상품(productId=null) 허용
      } else { itemError = "상품명 누락"; break; }
      const src = normalizeName(getCell(g.raw, iMap, "sourceLang"));
      const tgt = normalizeName(getCell(g.raw, iMap, "targetLang"));
      const languagePair = src && tgt ? `${src}→${tgt}` : (src || tgt || null);
      const headcount = Math.round(numCell(getCell(g.raw, iMap, "headcount")));
      const quantity = numCell(getCell(g.raw, iMap, "quantity")) || 1;
      const unitPrice = numCell(getCell(g.raw, iMap, "unitPrice"));
      const unit = normalizeName(getCell(g.raw, iMap, "unit")) || "건";
      const interpreterCount = itemType === "interpretation" && headcount > 0 ? headcount : null;
      calcInput.push({ itemType, quantity, unitPrice, taxRate: vatRate, interpreterCount: interpreterCount ?? 1 });
      resolved.push({
        seq: g.seq, rowNumber: g.rowNumber, productId, productName, itemType, languagePair,
        unit, quantity, unitPrice, interpreterCount, taxRate: vatRate,
        interpretDate: itemType === "interpretation" ? (normalizeDate(getCell(g.raw, iMap, "startDate")) || null) : null,
        interpretPlace: itemType === "interpretation" ? (normalizeName(getCell(g.raw, iMap, "place")) || null) : null,
        eventStartDate: itemType === "equipment" ? (normalizeDate(getCell(g.raw, iMap, "startDate")) || null) : null,
        eventEndDate: itemType === "equipment" ? (normalizeDate(getCell(g.raw, iMap, "endDate")) || null) : null,
        memo: normalizeName(getCell(g.raw, iMap, "memo")) || null,
      });
    }
    if (itemError) { row.status = "needs_review"; row.reason = itemError; rows.push(row); continue; }

    // 금액 SSOT 재사용
    const calc = computeQuoteItemAmounts(calcInput);
    row.items = resolved.map((r, idx) => ({ ...r, supplyAmount: calc[idx].supplyAmount, taxAmount: calc[idx].taxAmount, totalAmount: calc[idx].totalAmount }));
    row.itemCount = row.items.length;
    row.supplyAmount = row.items.reduce((s, it) => s + it.supplyAmount, 0);
    row.taxAmount = row.items.reduce((s, it) => s + it.taxAmount, 0);
    row.totalAmount = row.items.reduce((s, it) => s + it.totalAmount, 0);

    // ── 중복/idempotency(§25) ──
    const fp = fpOf(row.companyId, issueDate, title, row.totalAmount);
    row.fingerprint = fp;
    if (existingFp.has(fp)) { row.existingQuoteId = existingFp.get(fp)!; row.status = "identical"; row.reason = "기존견적 의심(동일 거래처·견적일·견적서명·금액) — 자동등록 제외"; rows.push(row); continue; }
    if (seenFileFp.has(fp)) { row.status = "duplicate_file"; row.reason = "파일 내부 중복"; rows.push(row); continue; }
    seenFileFp.add(fp);
    row.status = "new";
    rows.push(row);
  }

  // ── 헤더 없는 품목(orphan) → 오류 행(§10) ──
  for (const key of itemKeysSeen) {
    if (usedItemKeys.has(key)) continue;
    const first = itemsByKey.get(key)?.[0];
    rows.push({
      rowNumber: first?.rowNumber ?? 0, status: "error", reason: "Header 없음(견적등록에 임시키 없음)",
      tempKey: key, title: "", quoteType: QUOTE_ALLOWED_TYPE, vatType: "taxable", companyName: "", matchedCompanyName: "", companyId: null,
      businessNumber: "", contactName: "", contactId: null, pm: "", adminId: null, issueDate: "", validUntil: "", note: "",
      itemCount: 0, supplyAmount: 0, taxAmount: 0, totalAmount: 0, items: [], fingerprint: "",
    });
  }

  return {
    sheetName: headerSheet.sheetName,
    headerRowIndex: headerSheet.headerRowIndex,
    columnMap: describeColumnMap(headerSheet.headers, hMap),
    rows,
  };
}

// ── 견적 Excel 다운로드 데이터(견적목록 + 품목상세) — 현재 검색/필터 전체(§2·§3·§4) ──
router.get(
  "/admin/quotes/bulk-import/export",   // 3-segment — /admin/quotes/:id 라우트와 충돌 방지
  ...adminGuard,
  async (req, res) => {
    try {
      const { companyId: companyIdQ, status, quoteType: qtFilter, dateFrom, dateTo } = req.query as Record<string, string>;
      const conds: any[] = [sql`${quotesTable.deletedAt} is null`];
      if (status && status !== "all") conds.push(eq(quotesTable.status, status as any));
      if (qtFilter && qtFilter !== "all") conds.push(eq(quotesTable.quoteType, qtFilter));
      if (dateFrom) conds.push(sql`${quotesTable.issueDate} >= ${dateFrom}`);
      if (dateTo) conds.push(sql`${quotesTable.issueDate} <= ${dateTo}`);

      const qs = await db.select({
        id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, title: quotesTable.title,
        quoteType: quotesTable.quoteType, price: quotesTable.price, status: quotesTable.status,
        issueDate: quotesTable.issueDate, validUntil: quotesTable.validUntil, createdAt: quotesTable.createdAt,
        note: quotesTable.note, batchClosedAt: quotesTable.batchClosedAt, relationType: quotesTable.relationType,
        rootQuoteId: quotesTable.rootQuoteId, projectCompanyId: projectsTable.companyId,
        companyName: sql<string | null>`(SELECT name FROM companies WHERE id = COALESCE(${quotesTable.derivedCompanyId}, ${projectsTable.companyId}))`,
        businessNumber: sql<string | null>`(SELECT business_number FROM companies WHERE id = COALESCE(${quotesTable.derivedCompanyId}, ${projectsTable.companyId}))`,
        contactName: sql<string | null>`(SELECT name FROM contacts WHERE id = COALESCE(${quotesTable.derivedContactId}, ${projectsTable.contactId}))`,
        adminName: sql<string | null>`(SELECT name FROM users WHERE id = ${projectsTable.adminId})`,
        rootQuoteNumber: sql<string | null>`(SELECT quote_number FROM quotes rq WHERE rq.id = ${quotesTable.rootQuoteId})`,
      }).from(quotesTable).leftJoin(projectsTable, eq(quotesTable.projectId, projectsTable.id))
        .where(and(...conds)).orderBy(desc(quotesTable.id));

      const filtered = companyIdQ && companyIdQ !== "all" ? qs.filter((r) => r.projectCompanyId === Number(companyIdQ)) : qs;
      const ids = filtered.map((q) => q.id);
      const items = ids.length > 0
        ? await db.select({
            quoteId: quoteItemsTable.quoteId, productName: quoteItemsTable.productName, itemType: quoteItemsTable.itemType,
            languagePair: quoteItemsTable.languagePair, unit: quoteItemsTable.unit, quantity: quoteItemsTable.quantity,
            unitPrice: quoteItemsTable.unitPrice, supplyAmount: quoteItemsTable.supplyAmount, taxAmount: quoteItemsTable.taxAmount,
            totalAmount: quoteItemsTable.totalAmount, memo: quoteItemsTable.memo, interpretDate: quoteItemsTable.interpretDate,
            interpretPlace: quoteItemsTable.interpretPlace, eventStartDate: quoteItemsTable.eventStartDate, eventEndDate: quoteItemsTable.eventEndDate,
          }).from(quoteItemsTable).where(inArray(quoteItemsTable.quoteId, ids)).orderBy(quoteItemsTable.quoteId, quoteItemsTable.id)
        : [];

      // 견적별 집계
      const agg = new Map<number, { count: number; supply: number; tax: number; first: string }>();
      const qNumOf = new Map<number, string>(); const titleOf = new Map<number, string>();
      for (const q of filtered) { qNumOf.set(q.id, q.quoteNumber ?? ""); titleOf.set(q.id, q.title ?? ""); }
      for (const it of items) {
        const a = agg.get(it.quoteId) ?? { count: 0, supply: 0, tax: 0, first: "" };
        a.count += 1; a.supply += Number(it.supplyAmount); a.tax += Number(it.taxAmount);
        if (!a.first) a.first = it.productName;
        agg.set(it.quoteId, a);
      }
      const statusKo: Record<string, string> = { pending: "대기", sent: "발송", approved: "승인", rejected: "반려" };
      const relKo = (rt: string | null) => rt === "revision" ? "변경" : rt === "additional" ? "추가" : rt === "derived" ? "파생/분할" : "원견적";

      const quotes = filtered.map((q) => {
        const a = agg.get(q.id) ?? { count: 0, supply: 0, tax: 0, first: "" };
        return {
          quoteNumber: q.quoteNumber ?? "", title: q.title ?? "", quoteType: q.quoteType,
          companyName: q.companyName ?? "", businessNumber: q.businessNumber ?? "", contactName: q.contactName ?? "",
          adminName: q.adminName ?? "", issueDate: q.issueDate ?? "", validUntil: q.validUntil ?? "",
          firstService: a.first, itemCount: a.count, supplyAmount: a.supply, taxAmount: a.tax, totalAmount: Number(q.price),
          statusLabel: statusKo[q.status] ?? q.status, approvalLabel: q.status === "approved" ? "승인완료" : "미승인",
          convertedLabel: q.status === "approved" ? "Y" : "N",
          accumulatedLabel: q.quoteType === "accumulated_batch" ? (q.batchClosedAt ? "마감완료" : "누적중") : "",
          relationLabel: relKo(q.relationType), rootQuoteNumber: q.relationType ? (q.rootQuoteNumber ?? "") : "",
          createdAt: q.createdAt, note: q.note ?? "",
        };
      });
      const itemRows = items.map((it) => ({
        quoteNumber: qNumOf.get(it.quoteId) ?? "", title: titleOf.get(it.quoteId) ?? "",
        productName: it.productName, itemType: it.itemType, languagePair: it.languagePair ?? "",
        interpretDate: it.interpretDate ?? "", interpretPlace: it.interpretPlace ?? "",
        eventStartDate: it.eventStartDate ?? "", eventEndDate: it.eventEndDate ?? "",
        quantity: Number(it.quantity), unit: it.unit, unitPrice: Number(it.unitPrice),
        supplyAmount: Number(it.supplyAmount), taxAmount: Number(it.taxAmount), totalAmount: Number(it.totalAmount), memo: it.memo ?? "",
      }));
      res.json({ quotes, items: itemRows });
    } catch (err) {
      req.log.error({ err }, "BulkImport: quote export data failed");
      res.status(500).json({ error: "견적 다운로드 데이터 조회 실패." });
    }
  },
);

router.post(
  "/admin/quotes/bulk-import/analyze",
  ...adminGuard,
  requirePermission("quote.create"),
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    try {
      const result = await analyzeQuotes(req.file.buffer);
      res.json({
        fileName: decodeFileName(req.file.originalname),
        sheetName: result.sheetName, headerRowIndex: result.headerRowIndex, columnMap: result.columnMap,
        summary: summarize(result.rows), rows: result.rows,
      });
    } catch (err) {
      if ((err as Error)?.message === "QUOTE_NO_HEADER_SHEET") { res.status(400).json({ error: "'견적등록' 시트를 찾을 수 없습니다. 견적 대량등록 템플릿을 사용해 주세요." }); return; }
      req.log.error({ err }, "BulkImport: quote analyze failed");
      res.status(500).json({ error: "엑셀 분석 실패. 파일 형식을 확인해주세요." });
    }
  },
);

router.post(
  "/admin/quotes/bulk-import/execute",
  ...adminGuard,
  requirePermission("quote.create"),
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    const fileName = decodeFileName(req.file.originalname);
    try {
      // 서버 재분석·재검증(§16). new-only(§17): "신규등록" 행만. 판매/청구/지급/정산/prepaid 미생성(§19·§21).
      const result = await analyzeQuotes(req.file.buffer);
      const newRows = result.rows.filter((r) => r.status === "new");
      const summary = summarize(result.rows);
      const performer = { id: (req as any).user?.id ?? 0, email: (req as any).user?.email ?? "" };
      const stg = await getSettings();

      // 견적번호는 트랜잭션 밖에서 미리 발번(기존 수동등록과 동일 패턴). 롤백 시 번호 gap 은 정상.
      const qNums: string[] = [];
      for (let i = 0; i < newRows.length; i++) qNums.push(await generateQuoteNumber());

      let inserted = 0; let batchId: number | null = null;
      if (newRows.length > 0) {
        await db.transaction(async (tx) => {
          const [batch] = await tx.insert(importBatchesTable).values({
            module: "quote", importType: "excel_bulk", originalFilename: fileName || null,
            sheetName: result.sheetName || null, totalRows: summary.total, successRows: newRows.length,
            warningRows: 0, errorRows: summary.error, status: "completed", createdBy: performer.id || null,
          }).returning({ id: importBatchesTable.id });
          batchId = batch.id;

          for (let i = 0; i < newRows.length; i++) {
            const r = newRows[i];
            // 1) project 컨테이너(status=created) — 거래처/담당자/PM 연결. 판매(approved) 아님(§19 무효화 결정).
            let linkedProjectId: number | null = null;
            if (r.companyId || r.contactId || r.adminId) {
              const [proj] = await tx.insert(projectsTable).values({
                userId: performer.id || null, adminId: r.adminId ?? null,
                companyId: r.companyId ?? null, contactId: r.contactId ?? null,
                title: r.title, status: "created",
              }).returning({ id: projectsTable.id });
              linkedProjectId = proj.id;
            }
            // 2) quote 헤더 (기존 수동등록 필드/기본값과 동일)
            const [quote] = await tx.insert(quotesTable).values({
              projectId: linkedProjectId, quoteNumber: qNums[i], title: r.title, price: String(r.totalAmount),
              status: "pending", note: r.note || null, taxDocumentType: "tax_invoice", taxCategory: "normal",
              quoteType: QUOTE_ALLOWED_TYPE, billingType: stg.defaultBillingType, paymentMethod: null,
              validUntil: r.validUntil || (() => { const b = new Date(r.issueDate); b.setDate(b.getDate() + stg.quoteValidityDays); return b.toISOString().slice(0, 10); })(),
              issueDate: r.issueDate, invoiceDueDate: null,
              paymentDueDate: (() => { const b = new Date(); b.setDate(b.getDate() + stg.paymentDueDays); return b.toISOString().slice(0, 10); })(),
              batchItemCount: r.items.length, equipmentCommon: null,
            }).returning({ id: quotesTable.id });
            // 3) quote_items (§18 — 하나라도 실패 시 batch 전체 rollback)
            await tx.insert(quoteItemsTable).values(r.items.map((it) => ({
              quoteId: quote.id, productId: it.productId, productName: it.productName,
              languagePair: it.languagePair, unit: it.unit, quantity: String(it.quantity), unitPrice: String(it.unitPrice),
              supplyAmount: String(it.supplyAmount), taxAmount: String(it.taxAmount), totalAmount: String(it.totalAmount),
              memo: it.memo, itemType: it.itemType, taxType: r.vatType,
              interpretDate: it.interpretDate, interpretPlace: it.interpretPlace,
              interpreterCount: it.interpreterCount, eventStartDate: it.eventStartDate, eventEndDate: it.eventEndDate,
              isCustomProduct: it.productId == null,
            })));
            // 4) Source Lineage — 헤더 + 각 품목 행(§24)
            await tx.insert(importRowSourcesTable).values([
              { batchId: batch.id, module: "quote", entityId: quote.id, sourceFile: fileName || null, sourceSheet: result.sheetName || null, sourceRow: r.rowNumber, rowKey: `quote|${r.fingerprint}`, status: "new" },
              ...r.items.map((it) => ({ batchId: batch.id, module: "quote", entityId: quote.id, sourceFile: fileName || null, sourceSheet: "견적품목", sourceRow: it.rowNumber, rowKey: `quote_item|${r.fingerprint}|${it.seq}`, status: "new" })),
            ]);
            inserted += 1;
          }
        });
      }

      await logEvent("quote", 0, "bulk_import_quotes", req.log, performer.id ? performer : undefined,
        JSON.stringify({ fileName, mode: "new_only", batchId, total: summary.total, inserted, identical: summary.identical, needsReview: summary.needsReview, duplicateFile: summary.duplicateFile, error: summary.error }));

      res.json({ fileName, mode: "new_only", batchId, inserted, updated: 0, summary });
    } catch (err) {
      req.log.error({ err }, "BulkImport: quote execute failed");
      res.status(500).json({ error: "견적 일괄 등록 실패." });
    }
  },
);

export default router;
