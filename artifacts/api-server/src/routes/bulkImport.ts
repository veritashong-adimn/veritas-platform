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
import { db, companiesTable, contactsTable, companyNameHistoryTable, companyAliasesTable } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { buildAliasValues } from "../lib/companyAlias";
import {
  parseWorkbook, buildColumnMap, describeColumnMap, isBlankRow, getCell,
  normalizeBusinessNumber, isValidBusinessNumber, normalizePhone, normalizeEmail,
  normalizeName, normalizeDate,
  COMPANY_COLUMN_SYNONYMS, CONTACT_COLUMN_SYNONYMS,
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

// new       : 신규 등록 예정
// identical : 기존 데이터 동일(저장 안 함)
// update    : 기존 데이터 변경 예정(update 모드에서만 저장)
// duplicate_file : 파일 내부 중복
// error     : 오류
type RowStatus = "new" | "identical" | "update" | "duplicate_file" | "error";
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

function summarize(rows: { status: RowStatus }[]) {
  return {
    total: rows.length,
    new: rows.filter((r) => r.status === "new").length,
    identical: rows.filter((r) => r.status === "identical").length,
    update: rows.filter((r) => r.status === "update").length,
    duplicateFile: rows.filter((r) => r.status === "duplicate_file").length,
    error: rows.filter((r) => r.status === "error").length,
  };
}

// ── 거래처 분석 ───────────────────────────────────────────────────────────────
interface CompanyRow {
  rowNumber: number;
  status: RowStatus;
  reason?: string;
  existingId?: number | null;   // update 대상의 기존 거래처 ID
  changes?: ChangeMap;          // update 행의 변경 필드 미리보기
  name: string;
  businessNumber: string;      // 원문(표시용)
  businessNumberNorm: string;  // 숫자만
  representativeName: string;
  registeredAt: string;
  industry: string;
  businessCategory: string;
  address: string;
}

/** 대량등록으로 update 가능한 거래처 필드만: key → 실제 저장값 getter */
const COMPANY_UPDATE_FIELDS: Record<string, (r: CompanyRow) => string | null> = {
  name: (r) => r.name,
  representativeName: (r) => r.representativeName || null,
  registeredAt: (r) => r.registeredAt || null,
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

  // 기존 거래처 전체 조회(사업자번호 정규화 키). 비교/업데이트에 필요한 필드 포함.
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
    })
    .from(companiesTable);
  const existingByBiz = new Map<string, (typeof existing)[number]>();
  for (const e of existing) {
    if (e.biz && e.biz.length > 0 && !existingByBiz.has(e.biz)) existingByBiz.set(e.biz, e);
  }

  const seenInFile = new Set<string>();
  const rows: CompanyRow[] = [];

  parsed.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const rowNumber = parsed.headerRowIndex + 2 + i; // 엑셀 기준 1-based 행번호

    const name = normalizeName(getCell(raw, colMap, "name"));
    const bizRaw = normalizeName(getCell(raw, colMap, "businessNumber"));
    const bizNorm = normalizeBusinessNumber(bizRaw);
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
    };

    if (!name) { row.status = "error"; row.reason = "거래처명 누락"; }
    else if (!bizNorm) { row.status = "error"; row.reason = "사업자등록번호 누락"; }
    else if (!isValidBusinessNumber(bizNorm)) { row.status = "error"; row.reason = "사업자등록번호 형식 오류"; }
    else if (existingByBiz.has(bizNorm)) {
      const ex = existingByBiz.get(bizNorm)!;
      const changes = diffFields([
        { key: "name", excel: row.name, db: ex.name ?? "" },
        { key: "representativeName", excel: row.representativeName, db: ex.representativeName ?? "" },
        { key: "registeredAt", excel: row.registeredAt, db: ex.registeredAt ?? "", norm: (s) => normalizeDate(s) },
        { key: "industry", excel: row.industry, db: ex.industry ?? "" },
        { key: "businessCategory", excel: row.businessCategory, db: ex.businessCategory ?? "" },
        { key: "address", excel: row.address, db: ex.address ?? "" },
      ]);
      row.existingId = ex.id;
      if (Object.keys(changes).length === 0) { row.status = "identical"; row.reason = "기존 데이터 동일"; }
      else { row.status = "update"; row.reason = "기존 데이터 변경 예정"; row.changes = changes; }
    }
    else if (seenInFile.has(bizNorm)) { row.status = "duplicate_file"; row.reason = "파일 내부 중복"; }
    else { seenInFile.add(bizNorm); }

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
      if (newRows.length > 0 || updateRows.length > 0) {
        await db.transaction(async (tx) => {
          // 1) 신규 batch insert (500행 청크)
          for (let i = 0; i < newRows.length; i += 500) {
            const chunk = newRows.slice(i, i + 500);
            const created = await tx
              .insert(companiesTable)
              .values(chunk.map((r) => ({
                name: r.name,
                businessNumber: r.businessNumber || null,
                representativeName: r.representativeName || null,
                industry: r.industry || null,
                businessCategory: r.businessCategory || null,
                address: r.address || null,
                registeredAt: r.registeredAt || today,
                companyType: "client",
                customerType: "CORPORATE",
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
        JSON.stringify({ fileName, mode, total: summary.total, inserted, updated, identical: summary.identical, duplicateFile: summary.duplicateFile, error: summary.error }));

      res.json({ fileName, mode, inserted, updated, summary });
    } catch (err) {
      req.log.error({ err }, "BulkImport: company execute failed");
      res.status(500).json({ error: "거래처 일괄 등록 실패." });
    }
  },
);

// ── 담당자 분석 ───────────────────────────────────────────────────────────────
interface ContactRow {
  rowNumber: number;
  status: RowStatus;
  reason?: string;
  existingId?: number | null;   // update 대상의 기존 담당자 ID
  changes?: ChangeMap;
  companyName: string;         // 파일상 표시용 거래처명
  matchedCompanyName: string;  // 실제 연결된 거래처명
  companyId: number | null;
  businessNumber: string;
  businessNumberNorm: string;
  name: string;
  registeredAt: string;
  department: string;
  mobile: string;              // 원문 표시용(정규화 전 trimmed)
  mobileNorm: string;
  email: string;
  emailNorm: string;
  officePhone: string;
  officePhoneNorm: string;
}

/** 대량등록으로 update 가능한 담당자 필드만: key → 실제 저장값 getter(정규화 저장) */
const CONTACT_UPDATE_FIELDS: Record<string, (r: ContactRow) => string | null> = {
  name: (r) => r.name,
  department: (r) => r.department || null,
  mobile: (r) => r.mobileNorm || null,
  email: (r) => r.emailNorm || null,
  officePhone: (r) => r.officePhoneNorm || null,
  registeredAt: (r) => r.registeredAt || null,
};

/** 담당자 중복판정 키(거래처 내부): 이메일 > 휴대폰 > 이름+직장전화 */
function contactDedupKey(companyId: number, emailNorm: string, mobileNorm: string, nameNorm: string, officeNorm: string): string {
  if (emailNorm) return `${companyId}|e|${emailNorm}`;
  if (mobileNorm) return `${companyId}|m|${mobileNorm}`;
  return `${companyId}|n|${nameNorm}|${officeNorm}`;
}

async function analyzeContacts(buffer: Buffer): Promise<{
  sheetName: string; headerRowIndex: number; columnMap: Record<string, string | null>;
  rows: ContactRow[];
}> {
  const parsed = parseWorkbook(buffer, CONTACT_COLUMN_SYNONYMS);
  const colMap = buildColumnMap(parsed.headers, CONTACT_COLUMN_SYNONYMS);

  // 사업자번호 → 거래처 매핑(일괄 조회, §14)
  const companies = await db
    .select({
      id: companiesTable.id,
      name: companiesTable.name,
      biz: sql<string>`regexp_replace(coalesce(${companiesTable.businessNumber}, ''), '[^0-9]', '', 'g')`,
    })
    .from(companiesTable);
  const companyByBiz = new Map<string, { id: number; name: string }>();
  for (const c of companies) {
    if (c.biz && c.biz.length > 0 && !companyByBiz.has(c.biz)) companyByBiz.set(c.biz, { id: c.id, name: c.name });
  }

  // 기존 담당자(활성) dedup 키 → 레코드. 비교/업데이트에 필요한 필드 포함.
  const existingContacts = await db
    .select({
      id: contactsTable.id,
      companyId: contactsTable.companyId,
      name: contactsTable.name,
      department: contactsTable.department,
      email: contactsTable.email,
      mobile: contactsTable.mobile,
      officePhone: contactsTable.officePhone,
      registeredAt: contactsTable.registeredAt,
    })
    .from(contactsTable)
    .where(sql`${contactsTable.isActive} = true`);
  const existingByKey = new Map<string, (typeof existingContacts)[number]>();
  for (const c of existingContacts) {
    const key = contactDedupKey(
      c.companyId,
      normalizeEmail(c.email),
      normalizePhone(c.mobile),
      normalizeName(c.name),
      normalizePhone(c.officePhone),
    );
    if (!existingByKey.has(key)) existingByKey.set(key, c);
  }

  const seenInFile = new Set<string>();
  const rows: ContactRow[] = [];

  parsed.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const rowNumber = parsed.headerRowIndex + 2 + i;

    const bizRaw = normalizeName(getCell(raw, colMap, "businessNumber"));
    const bizNorm = normalizeBusinessNumber(bizRaw);
    const name = normalizeName(getCell(raw, colMap, "name"));
    const emailNorm = normalizeEmail(getCell(raw, colMap, "email"));
    const mobileNorm = normalizePhone(getCell(raw, colMap, "mobile"));
    const officeNorm = normalizePhone(getCell(raw, colMap, "officePhone"));
    const matched = bizNorm ? companyByBiz.get(bizNorm) : undefined;

    const row: ContactRow = {
      rowNumber,
      status: "new",
      companyName: normalizeName(getCell(raw, colMap, "companyName")),
      matchedCompanyName: matched?.name ?? "",
      companyId: matched?.id ?? null,
      businessNumber: bizRaw,
      businessNumberNorm: bizNorm,
      name,
      registeredAt: normalizeDate(getCell(raw, colMap, "registeredAt")),
      department: normalizeName(getCell(raw, colMap, "department")),
      mobile: normalizeName(getCell(raw, colMap, "mobile")),
      mobileNorm,
      email: normalizeName(getCell(raw, colMap, "email")),
      emailNorm,
      officePhone: normalizeName(getCell(raw, colMap, "officePhone")),
      officePhoneNorm: officeNorm,
    };

    if (!name) { row.status = "error"; row.reason = "담당자명 누락"; }
    else if (!bizNorm) { row.status = "error"; row.reason = "사업자등록번호 누락"; }
    else if (!matched) { row.status = "error"; row.reason = "기존 거래처 없음"; }
    else {
      const key = contactDedupKey(matched.id, emailNorm, mobileNorm, normalizeName(name), officeNorm);
      if (existingByKey.has(key)) {
        const ex = existingByKey.get(key)!;
        const changes = diffFields([
          { key: "name", excel: row.name, db: ex.name ?? "" },
          { key: "department", excel: row.department, db: ex.department ?? "" },
          { key: "mobile", excel: row.mobile, db: ex.mobile ?? "", norm: (s) => normalizePhone(s) },
          { key: "email", excel: row.email, db: ex.email ?? "", norm: (s) => normalizeEmail(s) },
          { key: "officePhone", excel: row.officePhone, db: ex.officePhone ?? "", norm: (s) => normalizePhone(s) },
          { key: "registeredAt", excel: row.registeredAt, db: ex.registeredAt ?? "", norm: (s) => normalizeDate(s) },
        ]);
        row.existingId = ex.id;
        if (Object.keys(changes).length === 0) { row.status = "identical"; row.reason = "기존 데이터 동일"; }
        else { row.status = "update"; row.reason = "기존 데이터 변경 예정"; row.changes = changes; }
      }
      else if (seenInFile.has(key)) { row.status = "duplicate_file"; row.reason = "파일 내부 중복"; }
      else { seenInFile.add(key); }
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
    const mode = parseMode((req.body as any)?.mode);
    try {
      const result = await analyzeContacts(req.file.buffer);
      const newRows = result.rows.filter((r) => r.status === "new" && r.companyId != null);
      const updateRows = mode === "update"
        ? result.rows.filter((r) => r.status === "update" && r.existingId != null)
        : [];
      const summary = summarize(result.rows);
      const today = new Date().toISOString().slice(0, 10);
      const performer = { id: (req as any).user?.id ?? 0, email: (req as any).user?.email ?? "" };

      let inserted = 0;
      let updated = 0;
      if (newRows.length > 0 || updateRows.length > 0) {
        await db.transaction(async (tx) => {
          // 1) 신규 batch insert
          for (let i = 0; i < newRows.length; i += 500) {
            const chunk = newRows.slice(i, i + 500);
            const created = await tx
              .insert(contactsTable)
              .values(chunk.map((r) => ({
                companyId: r.companyId as number,
                name: r.name,
                department: r.department || null,
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
            inserted += created.length;
          }

          // 2) 기존 담당자 update (ID 기준, 허용 필드만). 역할/활성/연결관계 미변경.
          for (const r of updateRows) {
            const changes = r.changes ?? {};
            const set: Record<string, string | null> = {};
            for (const key of Object.keys(changes)) {
              const getter = CONTACT_UPDATE_FIELDS[key];
              if (getter) set[key] = getter(r);
            }
            if (Object.keys(set).length === 0) continue;
            await tx.update(contactsTable).set(set).where(eq(contactsTable.id, r.existingId as number));
            updated += 1;
          }
        });
      }

      await logEvent("company", 0, "bulk_import_contacts", req.log, performer.id ? performer : undefined,
        JSON.stringify({ fileName, mode, total: summary.total, inserted, updated, identical: summary.identical, duplicateFile: summary.duplicateFile, error: summary.error }));

      res.json({ fileName, mode, inserted, updated, summary });
    } catch (err) {
      req.log.error({ err }, "BulkImport: contact execute failed");
      res.status(500).json({ error: "담당자 일괄 등록 실패." });
    }
  },
);

export default router;
