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
  quotesTable, quoteItemsTable, projectsTable, productsTable,
} from "@workspace/db";
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
// error       : 오류
type RowStatus = "new" | "identical" | "update" | "needs_review" | "duplicate_file" | "error";
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

async function analyzeCompanies(buffer: Buffer): Promise<{
  sheetName: string; headerRowIndex: number; columnMap: Record<string, string | null>;
  rows: CompanyRow[];
}> {
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

  // 파일 내부 사업자번호 중복 사전탐지(§7·CASE 9): 같은 파일에서 동일 사업자번호가
  //   2개 이상 나오면 "선행 1건 등록 + 후행 제외"가 아니라 관련 행 전체를 중복검토로 처리해
  //   어느 쪽도 자동 등록되지 않게 한다.
  const fileBizCount = new Map<string, number>();
  for (const raw of parsed.dataRows) {
    if (isBlankRow(raw)) continue;
    const bn = normalizeBusinessNumber(normalizeName(getCell(raw, colMap, "businessNumber")));
    if (bn) fileBizCount.set(bn, (fileBizCount.get(bn) ?? 0) + 1);
  }

  const seenNameInFile = new Set<string>();
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
      customerType: ctRaw,
      customerTypeValue: ctParsed === undefined ? null : ctParsed,
      phone: normalizeName(getCell(raw, colMap, "phone")),
      email: emailNorm,
      website: normalizeName(getCell(raw, colMap, "website")),
      notes: normalizeName(getCell(raw, colMap, "notes")),
    };

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

    if (!name) { row.status = "error"; row.reason = "거래처명 누락"; }
    else if (ctParsed === undefined) { row.status = "error"; row.reason = "거래처구분 허용값 오류 (기업/공공기관/개인)"; }
    else if (bizRaw && !isValidBusinessNumber(bizNorm)) { row.status = "error"; row.reason = "사업자등록번호 형식 오류"; }
    else if (bizNorm && (fileBizCount.get(bizNorm) ?? 0) >= 2) {
      // 파일 내부에서 동일 사업자번호가 2회 이상 → 어느 행도 자동 등록하지 않는다(§7·CASE 9).
      row.status = "needs_review"; row.reason = "파일 내부 사업자등록번호 중복 (중복검토)";
    }
    else if (bizCands.length >= 2) {
      // 동일 사업자번호에 기존 거래처가 복수 존재(비정상) → 임의 선택 금지(§2 우선순위 1 단서).
      row.status = "needs_review"; row.reason = "동일 사업자등록번호 기존 거래처 복수 (중복검토)";
    }
    else if (bizCands.length === 1) {
      // 사업자번호 정확 일치 + 후보 1개 → 매우 강한 동일 거래처(§2 우선순위 1).
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
      // 경고(§9): 저장은 하되 확인 권장.
      if (!bizNorm) row.warning = "사업자등록번호 없음";
      else if (row.email && !isValidEmail(row.email)) row.warning = "이메일 형식 의심";
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
  "/admin/companies/bulk-import/analyze",
  ...adminGuard,
  requirePermission("company.create"),
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    try {
      const result = await analyzeCompanies(req.file.buffer);
      res.json({
        fileName: decodeFileName(req.file.originalname),
        sheetName: result.sheetName,
        headerRowIndex: result.headerRowIndex,
        columnMap: result.columnMap,
        summary: summarize(result.rows),
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
    try {
      // 서버에서 재분석·재검증 후 상태별 저장
      const result = await analyzeCompanies(req.file.buffer);
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
              importType: "excel_bulk",
              originalFilename: fileName || null,
              sheetName: result.sheetName || null,
              totalRows: summary.total,
              successRows: newRows.length,
              warningRows: summary.warning,
              errorRows: summary.error,
              status: "completed",
              createdBy: performer.id || null,
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

type MiniCompany = { id: number; name: string };

/** 파일의 거래처 식별정보(사업자번호/거래처명)로 VERITAS 거래처를 확정 연결(§7·§8). */
function resolveContactCompany(
  bizNorm: string, companyNameKey: string,
  byBiz: Map<string, MiniCompany[]>, byName: Map<string, MiniCompany[]>,
): { company: MiniCompany | null; status?: "error" | "needs_review"; reason?: string } {
  const bizCands = bizNorm ? (byBiz.get(bizNorm) ?? []) : [];
  const nameCands = companyNameKey ? (byName.get(companyNameKey) ?? []) : [];

  if (bizNorm) {
    if (bizCands.length >= 2) return { company: null, status: "needs_review", reason: "거래처 다중후보(동일 사업자번호)" };
    if (bizCands.length === 1) {
      const comp = bizCands[0];
      // 식별정보 충돌(§8): 거래처명이 다른 회사(후보에 comp 없음)를 가리키면 임의 선택 금지.
      if (companyNameKey && nameCands.length > 0 && !nameCands.some((c) => c.id === comp.id)) {
        return { company: null, status: "needs_review", reason: "거래처 식별정보 충돌(사업자번호↔거래처명)" };
      }
      return { company: comp };
    }
    // 사업자번호가 있으나 VERITAS 에 없음
    if (companyNameKey) {
      if (nameCands.length >= 2) return { company: null, status: "needs_review", reason: "거래처 다중후보(거래처명)·사업자번호 미확인" };
      if (nameCands.length === 1) return { company: null, status: "needs_review", reason: "사업자번호 미확인(거래처명만 일치) — 확인필요" };
    }
    return { company: null, status: "error", reason: "거래처 미확인(사업자번호 불일치)" };
  }
  // 사업자번호 없음 → 거래처명으로만
  if (companyNameKey) {
    if (nameCands.length >= 2) return { company: null, status: "needs_review", reason: "거래처 다중후보(거래처명)" };
    if (nameCands.length === 1) return { company: nameCands[0] };
    return { company: null, status: "error", reason: "거래처 미확인(거래처명 불일치)" };
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
    const mc: MiniCompany = { id: c.id, name: c.name };
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
              importType: "excel_bulk",
              originalFilename: fileName || null,
              sheetName: result.sheetName || null,
              totalRows: summary.total,
              successRows: newRows.length,
              warningRows: 0,
              errorRows: summary.error,
              status: "completed",
              createdBy: performer.id || null,
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
interface TranslatorRow {
  rowNumber: number;
  status: RowStatus;               // new | identical | needs_review | duplicate_file | error
  reason?: string;
  existingId?: number | null;      // 기존통번역사 일치 시 매칭된 user id(표시용)
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
}

/** 신규 통번역사의 안정적 business key(idempotency·lineage §19·§20). 파일명 무관. */
function translatorRowKey(r: TranslatorRow): string {
  if (r.emailNorm) return `translator|e:${r.emailNorm}`;
  if (r.phoneNorm) return `translator|m:${r.phoneNorm}`;
  return `translator|n:${normalizeCompanyName(r.name)}`;
}

async function analyzeTranslators(buffer: Buffer): Promise<{
  sheetName: string; headerRowIndex: number; columnMap: Record<string, string | null>;
  rows: TranslatorRow[];
}> {
  const parsed = parseWorkbook(buffer, TRANSLATOR_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, TRANSLATOR_COLUMN_SYNONYMS);

  // 기존 사용자(이메일 소유자 — 유니크 충돌/타 계정 사용 탐지). 휴지통(soft delete)은 제외.
  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(sql`${usersTable.deletedAt} is null`);
  const emailOwners = new Map<string, { id: number; role: string }[]>();
  const pushOwner = (em: string, v: { id: number; role: string }) => { const a = emailOwners.get(em); if (a) a.push(v); else emailOwners.set(em, [v]); };
  const translatorName = new Map<number, string>();  // id → users.name
  for (const u of users) {
    const em = normalizeEmail(u.email);
    if (em) pushOwner(em, { id: u.id, role: u.role });
    if (u.role === "translator") translatorName.set(u.id, u.name ?? "");
  }
  // translator_emails(대표/보조) 도 이메일 소유자에 포함
  const temails = await db.select({ translatorId: translatorEmailsTable.translatorId, email: translatorEmailsTable.email }).from(translatorEmailsTable);
  for (const te of temails) { const em = normalizeEmail(te.email); if (em && translatorName.has(te.translatorId)) pushOwner(em, { id: te.translatorId, role: "translator" }); }

  // 휴대폰 → 통번역사 id (profile.phone)
  const profiles = await db.select({ userId: translatorProfilesTable.userId, phone: translatorProfilesTable.phone }).from(translatorProfilesTable);
  const phoneToIds = new Map<string, Set<number>>();
  for (const p of profiles) { const ph = normalizePhone(p.phone); if (ph && translatorName.has(p.userId)) { const s = phoneToIds.get(ph) ?? new Set(); s.add(p.userId); phoneToIds.set(ph, s); } }

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

    // ── 필수값(§13·§16): 성명, 이메일(users.email 필수·unique) ──
    if (!name) { row.status = "error"; row.reason = "성명 누락"; rows.push(row); return; }
    if (!emailNorm) { row.status = "error"; row.reason = "이메일 누락(통번역사 생성 필수)"; rows.push(row); return; }

    const nameNorm = normalizeCompanyName(name);
    const nameMatches = (id: number) => { const set = idToNameNorms.get(id); return !nameNorm || !set || set.has(nameNorm); };

    const emailTransIds = transIdsByEmail(emailNorm);
    const phoneIds = phoneNorm ? [...(phoneToIds.get(phoneNorm) ?? [])] : [];
    const nameIds = nameNorm ? [...(nameToIds.get(nameNorm) ?? [])] : [];

    if (hasNonTranslatorOwner(emailNorm) && emailTransIds.length === 0) {
      // 이메일이 통번역사 아닌 다른 계정에서 사용중 → unique 충돌 방지 + 확인필요
      row.status = "needs_review"; row.reason = "이메일이 다른 사용자 계정에서 사용중 — 확인필요";
    } else if (emailTransIds.length >= 2) {
      row.status = "needs_review"; row.reason = "이메일 다중후보(여러 통번역사) — 중복검토";   // CASE G
    } else if (emailTransIds.length === 1) {
      row.existingId = emailTransIds[0];
      if (nameMatches(emailTransIds[0])) { row.status = "identical"; row.reason = "기존통번역사 일치(이메일)"; }   // CASE A/C
      else { row.status = "needs_review"; row.reason = "이메일 일치하나 성명 상이 — 자동 merge 금지·중복검토"; }  // CASE 6
    } else if (phoneIds.length >= 2) {
      row.status = "needs_review"; row.reason = "휴대폰 다중후보(여러 통번역사) — 중복검토";   // CASE H
    } else if (phoneIds.length === 1) {
      row.existingId = phoneIds[0];
      if (nameMatches(phoneIds[0])) { row.status = "identical"; row.reason = "기존통번역사 일치(휴대폰)"; }   // CASE B
      else { row.status = "needs_review"; row.reason = "휴대폰 일치하나 성명 상이 — 중복검토"; }   // CASE D
    } else if (nameIds.length > 0) {
      // 이메일/휴대폰 매칭 없음 + 이름만 일치 → 동명이인 가능(§12·CASE E/F)
      row.status = "needs_review"; row.reason = "동일 성명 존재 — 동명이인 가능, 중복검토";
    } else if (emailNorm && seenFileEmail.has(emailNorm)) {
      row.status = "duplicate_file"; row.reason = "파일 내부 중복(이메일)";
    } else if (phoneNorm && seenFilePhone.has(phoneNorm)) {
      row.status = "duplicate_file"; row.reason = "파일 내부 중복(휴대폰)";
    } else if (nameNorm && seenFileName.has(nameNorm)) {
      row.status = "needs_review"; row.reason = "파일 내부 동일 성명 — 동명이인 가능, 중복검토";
    } else {
      row.status = "new";
      if (emailNorm) seenFileEmail.add(emailNorm);
      if (phoneNorm) seenFilePhone.add(phoneNorm);
      if (nameNorm) seenFileName.add(nameNorm);
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
  "/admin/translators/bulk-import/analyze",
  ...adminGuard,   // 통번역사 수동 등록과 동일한 접근 기준(별도 permission key 없음)
  excelUpload.single("file"),
  async (req, res) => {
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    try {
      const result = await analyzeTranslators(req.file.buffer);
      res.json({
        fileName: decodeFileName(req.file.originalname),
        sheetName: result.sheetName,
        headerRowIndex: result.headerRowIndex,
        columnMap: result.columnMap,
        summary: summarize(result.rows),
        rows: result.rows,
      });
    } catch (err) {
      req.log.error({ err }, "BulkImport: translator analyze failed");
      res.status(500).json({ error: "엑셀 분석 실패. 파일 형식을 확인해주세요." });
    }
  },
);

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
              module: "translator", importType: "excel_bulk",
              originalFilename: fileName || null, sheetName: result.sheetName || null,
              totalRows: summary.total, successRows: newRows.length, warningRows: 0, errorRows: summary.error,
              status: "completed", createdBy: performer.id || null,
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
