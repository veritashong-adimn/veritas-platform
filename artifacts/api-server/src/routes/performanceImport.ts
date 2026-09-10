// ─────────────────────────────────────────────────────────────────────────────
// 수행정보/통번역사 배정 Native Excel 대량등록(Import) — VERITAS OS 7차
//
//  · Legacy CRM Migration 아님. 기존 판매/프로젝트의 수행정보를 Excel로 신규 대량 배정.
//  · 프로젝트 단위 Import(projectId 는 판매 상세에서 고정, 사용자가 직접 입력하지 않음 §4).
//  · new-only(§29): "신규배정" + 사용자 선택 행만 INSERT. 기존/확인필요/오류/기존배정은 INSERT 금지.
//  · 저장/계산은 기존 SSOT(applyPerformanceRow / computeRowValues / computePerformanceBaseFee /
//    calcCostTotal / calcPayoutWithholding) 재사용(§33) — 수동 배정과 완전히 동일한 결과.
//  · 자동 생성 금지: project/quote/quote_item/translator/payout_round/settlement/billing.
//  · autoAssignByPaymentDate 호출하지 않음(§23·CASE22-23) — Import된 배정은 지급회차 미연결.
//  · 민감정보(주민번호·계좌·SWIFT/IBAN 등)는 Template/Preview/응답에 절대 미노출(§34).
//
// 엔드포인트:
//   GET  /admin/projects/:id/performances/import-template   Template 사전채움용 판매품목 seed(민감정보 없음)
//   POST /admin/projects/:id/performances/bulk-import/analyze   파일 분석(DB 미변경)
//   POST /admin/projects/:id/performances/bulk-import/execute   신규+선택 행 INSERT(파일 재검증 후)
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import multer from "multer";
import {
  db, performanceAssignmentsTable, performanceExpensesTable, performanceDeductionsTable,
  quotesTable, quoteItemsTable, quoteItemFilesTable, productsTable, projectsTable, companiesTable,
  usersTable, translatorProfilesTable, translatorEmailsTable, translatorAliasesTable, translatorSensitiveTable,
  importBatchesTable, importRowSourcesTable,
  calcCostTotal, calcPayoutWithholding, calcPaymentDate, DEFAULT_DOMESTIC_WITHHOLDING_TREATMENT,
} from "@workspace/db";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import {
  parseWorkbookSheets, buildColumnMap, describeColumnMap, isBlankRow, getCell,
  normalizeEmail, normalizePhone, normalizeName, normalizeDate,
  PERF_ASSIGN_SYNONYMS as ASSIGN_SYNONYMS, PERF_COST_SYNONYMS as COST_SYNONYMS, PERF_DEDUCT_SYNONYMS as DEDUCT_SYNONYMS,
} from "../lib/hometaxExcel";
import {
  applyPerformanceRow, computeRowValues, computePerformanceBaseFee, buildDetailSnapshot,
  loadKrHolidaySet, isInterpretationSnap, type RowInput, type ApplyRowCtx,
} from "./performances";

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

function decodeFileName(raw: string | undefined): string {
  if (!raw) return "";
  try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; }
}

// ── 파싱 헬퍼 ────────────────────────────────────────────────────────────────
function numOrNull(v: unknown): number | null {
  const s = String(v ?? "").replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function strCell(v: unknown): string { return String(v ?? "").trim(); }
function intCode(v: unknown): number | null {
  const s = String(v ?? "").replace(/[^0-9]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}
// 세금처리 셀 → 세율(%) 숫자. Excel percentage 셀(3.3%)은 내부적으로 0.033 numeric 으로 읽히므로
//   0<n<1 이면 fraction 으로 보고 ×100 한다(0.033→3.3). 순수 숫자/"3.3%" 문자열만 해석(텍스트 유형은 null).
function taxCellPercent(raw: unknown): number | null {
  let n: number | null = null;
  if (typeof raw === "number" && Number.isFinite(raw)) n = raw;
  else {
    const t = String(raw ?? "").trim();
    if (/^[0-9]*\.?[0-9]+%?$/.test(t)) n = Number(t.replace(/%$/, ""));  // "3.3", "3.3%", "0.033"
  }
  if (n == null || !Number.isFinite(n)) return null;
  return n > 0 && n < 1 ? n * 100 : n;   // 0.033→3.3 / 3.3→3.3
}

/** 세금처리 친숙표시값 → enum(§18). 신규 세금유형 생성 금지. 허용 세율(3.3/2.2)만 정규화. */
function parseTaxTreatment(raw: unknown): { value: string | null; ok: boolean } {
  // 1) percentage numeric 셀 / 숫자 — 허용된 세율(3.3%·2.2%)만 매핑(임의 숫자 불허 §4).
  const pct = taxCellPercent(raw);
  if (pct != null) {
    if (Math.abs(pct - 3.3) < 0.05) return { value: "domestic_3_3", ok: true };
    if (Math.abs(pct - 2.2) < 0.05) return { value: "domestic_2_2", ok: true };
    return { value: null, ok: false };   // 3.3/2.2 외 임의 숫자 → 오류
  }
  // 2) 텍스트 입력 — 기존 지원 유지.
  const s = String(raw ?? "").replace(/[\s()]/g, "").toLowerCase();
  if (!s) return { value: null, ok: true };  // 공란 → 저장시 통번역사 스냅샷 기본값(§10·§18)
  if (["3.3%", "3.3", "domestic_3_3", "원천징수3.3", "3.3퍼센트"].includes(s)) return { value: "domestic_3_3", ok: true };
  if (["2.2%", "2.2", "domestic_2_2", "원천징수2.2"].includes(s)) return { value: "domestic_2_2", ok: true };
  if (["원천징수예외", "예외", "exempt", "원천징수제외", "원천세제외"].includes(s)) return { value: "exempt", ok: true };
  if (["세금계산서", "tax_review_required", "세무확인", "세무확인필요", "계산서"].includes(s)) return { value: "tax_review_required", ok: true };
  return { value: null, ok: false };  // 허용 외 값 → 오류
}
// 기타비용 항목명 정규화(§5·§7) — 알려진 유형은 저장값으로 통일(라벨 입력 허용), 그 외는 자유입력 그대로.
//   기존 EXPENSE_TYPE_OPTS 저장값 재사용 — 신규 enum 생성 없음. 정규 3종(추가통역료·출장비·교통비)은 전용 컬럼이 처리.
const ETC_TYPE_ALIAS: Record<string, string> = {
  "숙박비": "숙박비", "식비": "식비", "식대": "식비", "저작권료": "저작권료",
  "이동일보상": "이동일보상", "이동일보상비": "이동일보상", "이동보상비": "이동일보상",
  "취소보상": "취소보상", "취소보상비": "취소보상",
};
function normalizeExpenseType(raw: string): string {
  const key = raw.replace(/[\s()]/g, "");
  return ETC_TYPE_ALIAS[key] ?? raw.trim();
}
function parseIncluded(raw: unknown): boolean {
  const s = String(raw ?? "").replace(/[\s()]/g, "").toLowerCase();
  if (!s) return true;
  return !["n", "no", "false", "0", "제외", "아니오", "미포함", "x"].includes(s);
}

// 비용상세/차감상세 시트를 수행순번(rowSeq) → 항목[] 로 그룹화
type CostDetail = { expenseType: string; amount: number; baseAmount: number | null; payoutRate: number | null; includedInPayout: boolean; memo: string | null };
type DeductDetail = { deductionType: string; amount: number; reason: string | null };

// ── 미리보기 행 ───────────────────────────────────────────────────────────────
type PerfStatus = "new" | "identical" | "needs_review" | "duplicate_file" | "error";
interface PerfImportRow {
  rowNumber: number;
  rowSeq: string;
  status: PerfStatus;
  reason?: string;
  warning?: string;
  rowKey: string | null;
  // 표시용
  productName: string;
  serviceType: string;
  translatorName: string;
  email: string;
  phone: string;
  language: string;
  startDate: string;
  endDate: string;
  deliveryDate: string;
  fee100: number | null;
  fee85: number | null;
  quantity: number | null;
  unit: string;
  matchedTranslatorId?: number | null;
  matchedSaleItemId?: number | null;
  existingId?: number | null;
  // 계산 미리보기(§28) — 기존 SSOT 결과
  base: number;
  expenseTotal: number;
  deductionTotal: number;
  grossPre: number;          // 세전 지급예정액 = costTotal
  withholdingRate: number;
  withholdingTax: number;
  netPay: number;            // 세후 지급예정액
  payScheduled: string | null;
  // 내부(execute 재사용) — 응답에서는 제거
  _payload?: RowInput;
}

/** 신규 배정 business key(§24·§32) — projectId + saleItemId + translatorId + 수행시작/종료일. */
function perfRowKey(projectId: number, saleItemId: number | null, userId: number | null, start: string, end: string): string {
  return `perf|p:${projectId}|si:${saleItemId ?? "na"}|u:${userId ?? "na"}|s:${start || "na"}|e:${end || "na"}`;
}

interface AnalyzeContext {
  projectId: number;
  isHoliday: (d: string) => boolean;
}

export async function analyzePerformanceImport(projectId: number, buffer: Buffer, ctx: AnalyzeContext): Promise<{
  sheetName: string; columnMap: Record<string, string | null>; rows: PerfImportRow[];
}> {
  // ── 프로젝트/견적/판매품목 로드 ──
  const [quote] = await db.select().from(quotesTable)
    .where(and(eq(quotesTable.projectId, projectId), eq(quotesTable.isCurrent, true), isNull(quotesTable.deletedAt)));
  const items = quote
    ? await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).orderBy(quoteItemsTable.id)
    : [];
  const productIds = Array.from(new Set(items.map(it => it.productId).filter((v): v is number => v != null)));
  const products = productIds.length ? await db.select().from(productsTable).where(inArray(productsTable.id, productIds)) : [];
  const prodMap = new Map(products.map(p => [p.id, p]));
  const itemIds = items.map(it => it.id);
  const files = itemIds.length ? await db.select().from(quoteItemFilesTable).where(inArray(quoteItemFilesTable.quoteItemId, itemIds)).orderBy(quoteItemFilesTable.id) : [];
  const fileByItem = new Map<number, string>();
  for (const f of files) { if (!fileByItem.has(f.quoteItemId)) fileByItem.set(f.quoteItemId, f.fileName); }

  // 판매품목 매칭 인덱스 — id / 1-based 순번 / (상품명|서비스유형|시작일)
  const itemById = new Map<number, typeof items[number]>();
  const itemBySeq = new Map<number, typeof items[number]>();
  const itemByNSD = new Map<string, typeof items[number][]>();
  items.forEach((it, idx) => {
    itemById.set(it.id, it);
    itemBySeq.set(idx + 1, it);
    const start = normalizeDate(it.interpretDate ?? it.eventStartDate ?? "") || "";
    const k = `${strCell(it.productName)}|${strCell(it.itemType)}|${start}`.toLowerCase();
    (itemByNSD.get(k) ?? itemByNSD.set(k, []).get(k)!).push(it);
  });

  // ── 통번역사 매칭 인덱스(§10) — 이메일/휴대폰/이름. 민감정보 미로드(paymentMethod 만 세율 기본값용). ──
  const users = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
    .from(usersTable).where(isNull(usersTable.deletedAt));
  const translatorName = new Map<number, string>();
  const emailToIds = new Map<string, Set<number>>();
  const addEmail = (em: string, id: number) => { if (!em) return; const s = emailToIds.get(em) ?? new Set(); s.add(id); emailToIds.set(em, s); };
  for (const u of users) {
    if (u.role === "translator") { translatorName.set(u.id, u.name ?? ""); const em = normalizeEmail(u.email); if (em) addEmail(em, u.id); }
  }
  const temails = await db.select({ translatorId: translatorEmailsTable.translatorId, email: translatorEmailsTable.email }).from(translatorEmailsTable);
  for (const te of temails) { if (translatorName.has(te.translatorId)) addEmail(normalizeEmail(te.email), te.translatorId); }
  const profiles = await db.select({ userId: translatorProfilesTable.userId, phone: translatorProfilesTable.phone }).from(translatorProfilesTable);
  const phoneToIds = new Map<string, Set<number>>();
  for (const p of profiles) { const ph = normalizePhone(p.phone); if (ph && translatorName.has(p.userId)) { const s = phoneToIds.get(ph) ?? new Set(); s.add(p.userId); phoneToIds.set(ph, s); } }
  const aliases = await db.select({ translatorId: translatorAliasesTable.translatorId, norm: translatorAliasesTable.normalizedAlias }).from(translatorAliasesTable);
  const nameToIds = new Map<string, Set<number>>();
  const addName = (id: number, norm: string) => { if (!norm) return; const s = nameToIds.get(norm) ?? new Set(); s.add(id); nameToIds.set(norm, s); };
  for (const [id, nm] of translatorName) addName(id, normalizeCompanyName(nm));
  for (const a of aliases) { if (translatorName.has(a.translatorId)) addName(a.translatorId, a.norm); }
  // paymentMethod → 세율 기본값(미리보기 전용, 브라우저 미전송). PII 아님.
  const sens = await db.select({ translatorId: translatorSensitiveTable.translatorId, paymentMethod: translatorSensitiveTable.paymentMethod }).from(translatorSensitiveTable);
  const payMethodById = new Map<number, string | null>();
  for (const s of sens) payMethodById.set(s.translatorId, s.paymentMethod ?? null);
  const defaultTreatmentFor = (id: number | null | undefined): string => {
    const pm = id != null ? payMethodById.get(id) : null;
    return pm === "domestic_withholding" ? DEFAULT_DOMESTIC_WITHHOLDING_TREATMENT : "tax_review_required";
  };

  // ── 기존 배정(중복판정용, §23·§24) ──
  const existing = await db.select({
    saleItemId: performanceAssignmentsTable.saleItemId,
    individualUserId: performanceAssignmentsTable.individualUserId,
    performanceStartDate: performanceAssignmentsTable.performanceStartDate,
    performanceEndDate: performanceAssignmentsTable.performanceEndDate,
    id: performanceAssignmentsTable.id,
  }).from(performanceAssignmentsTable)
    .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));
  const existingKey = new Map<string, number>();
  for (const e of existing) {
    const k = perfRowKey(projectId, e.saleItemId ?? null, e.individualUserId ?? null,
      e.performanceStartDate ? String(e.performanceStartDate).slice(0, 10) : "",
      e.performanceEndDate ? String(e.performanceEndDate).slice(0, 10) : "");
    if (!existingKey.has(k)) existingKey.set(k, e.id);
  }

  // ── 시트 파싱 ──
  const sheets = parseWorkbookSheets(buffer, {
    assign: { hints: ["수행자배정", "배정", "수행자"], synonyms: ASSIGN_SYNONYMS },
    cost: { hints: ["비용상세", "비용"], synonyms: COST_SYNONYMS },
    deduct: { hints: ["차감상세", "차감"], synonyms: DEDUCT_SYNONYMS },
  });
  const assign = sheets.assign;
  if (!assign) throw new Error("‘수행자배정’ 시트를 찾을 수 없습니다. 템플릿을 사용해 주세요.");
  const aMap = buildColumnMap(assign.headers, ASSIGN_SYNONYMS);

  // 비용/차감 상세 → rowSeq 그룹화
  const costByRowSeq = new Map<string, CostDetail[]>();
  if (sheets.cost) {
    const cMap = buildColumnMap(sheets.cost.headers, COST_SYNONYMS);
    for (const raw of sheets.cost.dataRows) {
      if (isBlankRow(raw)) continue;
      const seq = strCell(getCell(raw, cMap, "rowSeq"));
      const type = strCell(getCell(raw, cMap, "expenseType"));
      if (!seq || !type) continue;
      const baseAmount = numOrNull(getCell(raw, cMap, "baseAmount"));
      const payoutRate = numOrNull(getCell(raw, cMap, "payoutRate"));
      let amount = numOrNull(getCell(raw, cMap, "amount"));
      if (amount == null && baseAmount != null && payoutRate != null) amount = Math.round(baseAmount * (payoutRate / 100) * 100) / 100;
      (costByRowSeq.get(seq) ?? costByRowSeq.set(seq, []).get(seq)!).push({
        expenseType: type, amount: amount ?? 0, baseAmount, payoutRate,
        includedInPayout: parseIncluded(getCell(raw, cMap, "includedInPayout")),
        memo: strCell(getCell(raw, cMap, "memo")) || null,
      });
    }
  }
  const deductByRowSeq = new Map<string, DeductDetail[]>();
  if (sheets.deduct) {
    const dMap = buildColumnMap(sheets.deduct.headers, DEDUCT_SYNONYMS);
    for (const raw of sheets.deduct.dataRows) {
      if (isBlankRow(raw)) continue;
      const seq = strCell(getCell(raw, dMap, "rowSeq"));
      const amount = numOrNull(getCell(raw, dMap, "amount"));
      if (!seq || amount == null) continue;
      (deductByRowSeq.get(seq) ?? deductByRowSeq.set(seq, []).get(seq)!).push({
        deductionType: strCell(getCell(raw, dMap, "deductionType")) || "기타조정",
        amount, reason: strCell(getCell(raw, dMap, "reason")) || null,
      });
    }
  }

  const seenFileKey = new Set<string>();
  const rows: PerfImportRow[] = [];

  assign.dataRows.forEach((raw, i) => {
    if (isBlankRow(raw)) return;
    const rowNumber = assign.headerRowIndex + 2 + i;
    const rowSeq = strCell(getCell(raw, aMap, "rowSeq")) || String(i + 1);

    const startDate = normalizeDate(getCell(raw, aMap, "startDate"));
    const endDate = normalizeDate(getCell(raw, aMap, "endDate"));
    const deliveryDate = normalizeDate(getCell(raw, aMap, "deliveryDate"));
    const payDate = normalizeDate(getCell(raw, aMap, "payDate"));
    const fee100 = numOrNull(getCell(raw, aMap, "fee100"));
    const fee85 = numOrNull(getCell(raw, aMap, "fee85"));
    const qty = numOrNull(getCell(raw, aMap, "quantity"));
    const cup = numOrNull(getCell(raw, aMap, "contractUnitPrice"));
    const emailNorm = normalizeEmail(getCell(raw, aMap, "email"));
    const phoneNorm = normalizePhone(getCell(raw, aMap, "phone"));
    const nameRaw = normalizeName(getCell(raw, aMap, "translatorName"));

    const row: PerfImportRow = {
      rowNumber, rowSeq, status: "new", rowKey: null,
      productName: strCell(getCell(raw, aMap, "productName")),
      serviceType: strCell(getCell(raw, aMap, "serviceType")),
      translatorName: nameRaw,
      email: strCell(getCell(raw, aMap, "email")),
      phone: strCell(getCell(raw, aMap, "phone")),
      language: strCell(getCell(raw, aMap, "language")),
      startDate, endDate, deliveryDate,
      fee100, fee85, quantity: qty, unit: strCell(getCell(raw, aMap, "unit")),
      base: 0, expenseTotal: 0, deductionTotal: 0, grossPre: 0, withholdingRate: 0, withholdingTax: 0, netPay: 0, payScheduled: null,
    };

    // ── 1) 판매품목 매칭(§7·§8) ──
    let item: typeof items[number] | undefined;
    const codeId = intCode(getCell(raw, aMap, "saleItemCode"));
    const saleSeq = intCode(getCell(raw, aMap, "saleSeq"));
    if (codeId != null && itemById.has(codeId)) item = itemById.get(codeId);
    else if (saleSeq != null && itemBySeq.has(saleSeq)) item = itemBySeq.get(saleSeq);
    else {
      const k = `${row.productName}|${row.serviceType}|${startDate}`.toLowerCase();
      const cands = itemByNSD.get(k) ?? [];
      if (cands.length === 1) item = cands[0];
      else if (cands.length > 1) { row.status = "needs_review"; row.reason = "판매품목 다중후보 — 판매품목코드/순번으로 지정 필요"; rows.push(row); return; }
    }
    if (!item) { row.status = "error"; row.reason = "판매품목 미확인 — 판매품목코드/순번을 확인하세요"; rows.push(row); return; }
    row.matchedSaleItemId = item.id;

    // ── 2) 통번역사 매칭(§10·§11) ──
    let matchedId: number | null = null;
    const codeTid = intCode(getCell(raw, aMap, "translatorCode"));
    const nameNorm = normalizeCompanyName(nameRaw);
    const emailIds = emailNorm ? [...(emailToIds.get(emailNorm) ?? [])] : [];
    const phoneIds = phoneNorm ? [...(phoneToIds.get(phoneNorm) ?? [])] : [];
    const nameIds = nameNorm ? [...(nameToIds.get(nameNorm) ?? [])] : [];
    if (codeTid != null && translatorName.has(codeTid)) matchedId = codeTid;
    else if (emailIds.length === 1) matchedId = emailIds[0];
    else if (emailIds.length >= 2) { row.status = "needs_review"; row.reason = "이메일 다중후보(여러 통번역사) — 확인필요"; rows.push(row); return; }
    else if (phoneIds.length === 1) matchedId = phoneIds[0];
    else if (phoneIds.length >= 2) { row.status = "needs_review"; row.reason = "휴대폰 다중후보(여러 통번역사) — 확인필요"; rows.push(row); return; }
    else if (nameIds.length === 1) { row.status = "needs_review"; row.reason = "이름만 일치 — 동명이인 가능, 코드/이메일/휴대폰으로 확인 필요"; rows.push(row); return; }
    else if (nameIds.length >= 2) { row.status = "needs_review"; row.reason = "동일 성명 다수 — 동명이인, 확인필요"; rows.push(row); return; }
    else { row.status = "error"; row.reason = "통번역사 미등록 — 통번역사 마스터에 먼저 등록해야 합니다"; rows.push(row); return; }
    row.matchedTranslatorId = matchedId;

    // ── 3) 세금처리 파싱(§18) ──
    const tax = parseTaxTreatment(getCell(raw, aMap, "taxTreatment"));
    if (!tax.ok) { row.status = "error"; row.reason = "세금처리 값 오류 — 3.3%/2.2%/원천징수예외/세금계산서 중 입력"; rows.push(row); return; }

    // ── 4) 서비스별 상세 스냅샷 + 85%/100% 매핑(§12·§13·§14, 실제 UI/DB 정책 미러) ──
    const prod = item.productId != null ? prodMap.get(item.productId) : undefined;
    const detailSnap = buildDetailSnapshot(item, prod, fileByItem.get(item.id) ?? null);
    // 저장될 수행시작일 = Excel 값 우선, 없으면 판매품목 일자(중복판정·idempotency 키와 동일 기준 §32).
    const resolvedStart = startDate || normalizeDate((detailSnap as any).interpretDate ?? (detailSnap as any).eventStartDate ?? "") || "";
    const isInterp = isInterpretationSnap(detailSnap, item.itemType);
    let isDirectAmount = false;
    let directAmount: number | null = null;
    let contractUnitPrice: number | null = null;
    let quantity: number | null = qty;
    if (isInterp) {
      // 통역: 통역료(85%)=directAmount(×0.85 지급base), 요금(100%)=contractUnitPrice(참조값·계산 미사용). 두 값 독립(동시 입력 정상).
      if (fee85 != null) { isDirectAmount = true; directAmount = fee85; contractUnitPrice = fee100; }
      else if (cup != null && qty != null) { isDirectAmount = false; contractUnitPrice = cup; quantity = qty; }
      else { isDirectAmount = true; directAmount = null; contractUnitPrice = fee100; row.warning = "통역 지급기준(통역료85% 또는 계약단가×수량) 미입력 — 기본지급액 0"; }
    } else {
      // 번역·감수 등: 요금(100%)=directAmount(그대로), 또는 계약단가×수량. 통역료(85%) 입력 불가(§14).
      if (fee85 != null) { row.status = "error"; row.reason = "번역행에 통역료(85%) 입력 불가 — 요금(100%) 또는 계약단가×수량 사용(§14)"; rows.push(row); return; }
      if (fee100 != null) { isDirectAmount = true; directAmount = fee100; }
      else if (cup != null && qty != null) { isDirectAmount = false; contractUnitPrice = cup; quantity = qty; }
      else { isDirectAmount = false; row.warning = "번역 지급기준(요금100% 또는 계약단가×수량) 미입력 — 기본지급액 0"; }
    }

    // ── 5) 추가비용·차감(단일시트 인라인 + 구4시트 상세 호환) ──
    const expenses: RowInput["expenses"] = [];
    const pushExp = (type: string, amt: number | null) => { if (amt != null && amt > 0) expenses!.push({ expenseType: type, amount: amt }); };
    // 정규 3종(추가통역료·출장비·교통비) — 독립 컬럼 유지(§8).
    pushExp("수가통역료", numOrNull(getCell(raw, aMap, "addInterpFee")));
    pushExp("출장비", numOrNull(getCell(raw, aMap, "businessTripFee")));
    pushExp("교통비", numOrNull(getCell(raw, aMap, "transportFee")));
    // 기타비용 3쌍(단일시트, §4·§7) — 항목+금액 쌍 검증(§6). 알려진 유형은 저장값으로 정규화, 그 외 자유입력.
    let etcError: string | null = null;
    for (let k = 0; k < 3; k++) {
      const t = strCell(getCell(raw, aMap, `etc${k + 1}Type`));
      const aCell = getCell(raw, aMap, `etc${k + 1}Amount`);
      const aStr = String(aCell ?? "").trim();
      const a = numOrNull(aCell);
      if (!t && !aStr) continue;                                     // 둘 다 공란 → 건너뜀
      if (t && !aStr) { etcError = `기타비용${k + 1} 금액 누락(항목 '${t}')`; break; }
      if (!t && aStr) { etcError = `기타비용${k + 1} 항목 누락(금액만 입력됨)`; break; }
      if (a == null || a <= 0) { etcError = `기타비용${k + 1} 금액 오류(양수 숫자 필요): '${aStr}'`; break; }
      expenses!.push({ expenseType: normalizeExpenseType(t), amount: a });
    }
    if (etcError) { row.status = "error"; row.reason = etcError; rows.push(row); return; }
    // 레거시 단일 '기타비용' 컬럼(구 템플릿 호환).
    pushExp("기타비용", numOrNull(getCell(raw, aMap, "etcCost")));
    // 구 4시트 '비용상세' 시트(있을 때만) — backward compatibility(§15).
    for (const c of costByRowSeq.get(rowSeq) ?? []) {
      expenses!.push({ expenseType: c.expenseType, amount: c.amount, baseAmount: c.baseAmount, payoutRate: c.payoutRate, includedInPayout: c.includedInPayout, memo: c.memo });
    }
    const deductions: RowInput["deductions"] = [];
    const inlineDedAmt = numOrNull(getCell(raw, aMap, "deductionAmount"));
    const inlineDedReason = strCell(getCell(raw, aMap, "deductionReason"));
    if (inlineDedAmt != null && inlineDedAmt > 0) deductions!.push({ deductionType: inlineDedReason || "기타조정", amount: inlineDedAmt, reason: inlineDedReason || null });
    for (const d of deductByRowSeq.get(rowSeq) ?? []) deductions!.push({ deductionType: d.deductionType, amount: d.amount, reason: d.reason });

    // ── 6) 저장 payload(신규 배정) — 위험 상태/지급상태 직접 지정 금지(§21·§22) ──
    const payload: RowInput = {
      saleItemId: item.id,
      saleItemSequence: items.indexOf(item),
      quoteId: quote ? quote.id : null,
      sourceType: "manual",
      performerCategory: "individual",
      individualUserId: matchedId,
      status: "assigned",                                   // 신규배정 기본(§21) — completed/paid 등 금지
      serviceType: item.itemType ?? null,
      productNameSnapshot: item.productName ?? null,
      serviceDetailSnapshot: detailSnap,
      languageOrServiceSnapshot: row.language || item.languagePair || null,
      performanceStartDate: resolvedStart || null,
      performanceEndDate: endDate || null,
      deliveryDate: deliveryDate || null,
      deliveryDateManual: !!deliveryDate,
      contractUnitPrice,
      quantity,
      unit: row.unit || item.unit || null,
      isDirectAmount,
      directAmount,
      payDateManual: !!payDate,
      expectedPaymentDate: payDate || null,
      payDateChangeReason: payDate ? "Excel 대량등록 수동 지정" : null,
      paymentStatus: "unpaid",                              // §22 — paid/hold 직접 생성 금지
      withholdingTreatment: (tax.value as any),
      remark: strCell(getCell(raw, aMap, "remark")) || null,
      expenses, deductions,
    };

    // ── 7) 중복판정(§24·§25·§26) — 저장될 값과 동일한 resolvedStart 로 키 생성(idempotency §32). ──
    const key = perfRowKey(projectId, item.id, matchedId, resolvedStart, endDate);
    row.rowKey = key;
    if (existingKey.has(key)) { row.status = "identical"; row.reason = "기존 배정 존재(동일 품목·수행자·수행일) — 신규 생성 안 함"; row.existingId = existingKey.get(key)!; }
    else if (seenFileKey.has(key)) { row.status = "duplicate_file"; row.reason = "파일 내부 중복(동일 품목·수행자·수행일)"; }
    else { row.status = "new"; seenFileKey.add(key); }

    // ── 8) 계산 미리보기(§28) — 기존 SSOT 재사용 ──
    const computed = computeRowValues(payload);
    const base = computePerformanceBaseFee(payload, computed, detailSnap);
    const totals = calcCostTotal(
      base,
      (expenses ?? []).map(e => ({ amount: Number(e.amount ?? 0), includedInPayout: e.includedInPayout })),
      (deductions ?? []).map(d => ({ amount: Number(d.amount ?? 0) })),
    );
    const effTreatment = tax.value ?? defaultTreatmentFor(matchedId);
    const wt = calcPayoutWithholding(totals.costTotal, "individual", effTreatment, null);
    row.base = totals.basePerformanceFee;
    row.expenseTotal = totals.expenseTotal;
    row.deductionTotal = totals.deductionTotal;
    row.grossPre = wt.gross;
    row.withholdingRate = wt.rate;
    row.withholdingTax = wt.deduction;
    row.netPay = wt.net;
    // 지급예정일 미리보기 — 수동입력값 우선, 없으면 납품일 기준 SSOT 자동계산(저장 시 applyPerformanceRow가 최종 확정).
    const resolvedDelivery = deliveryDate || endDate || null;
    row.payScheduled = payDate || calcPaymentDate(resolvedDelivery, ctx.isHoliday);

    row._payload = payload;
    rows.push(row);
  });

  return {
    sheetName: assign.sheetName,
    columnMap: describeColumnMap(assign.headers, aMap),
    rows,
  };
}

function summarize(rows: PerfImportRow[]) {
  return {
    total: rows.length,
    new: rows.filter(r => r.status === "new").length,
    identical: rows.filter(r => r.status === "identical").length,
    update: 0,
    needsReview: rows.filter(r => r.status === "needs_review").length,
    duplicateFile: rows.filter(r => r.status === "duplicate_file").length,
    error: rows.filter(r => r.status === "error").length,
    warning: rows.filter(r => !!r.warning).length,
  };
}

/** 응답에서 내부 payload 제거(§34 — 민감정보/내부 페이로드 미노출). */
function stripInternal(r: PerfImportRow) {
  const { _payload, ...safe } = r;
  return safe;
}

// ── GET Template seed(사전채움용 판매품목) ──────────────────────────────────
router.get("/admin/projects/:id/performances/import-template", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  try {
    const [proj] = await db.select({ id: projectsTable.id, title: projectsTable.title, companyId: projectsTable.companyId }).from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!proj) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }
    const [quote] = await db.select().from(quotesTable)
      .where(and(eq(quotesTable.projectId, projectId), eq(quotesTable.isCurrent, true), isNull(quotesTable.deletedAt)));
    const items = quote ? await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).orderBy(quoteItemsTable.id) : [];
    let companyName: string | null = null;
    if (proj.companyId != null) { const [c] = await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, proj.companyId)); companyName = c?.name ?? null; }
    const seedItems = items
      .filter(it => (it.itemType ?? "") !== "discount")
      .map((it, idx) => ({
        saleItemId: it.id,
        saleSeq: idx + 1,
        productName: it.productName ?? "",
        serviceType: it.itemType ?? "",
        startDate: normalizeDate(it.interpretDate ?? it.eventStartDate ?? "") || "",
        endDate: normalizeDate(it.eventEndDate ?? "") || "",
        place: it.interpretPlace ?? it.itemLocation ?? "",
        unit: it.unit ?? "",
        quantity: it.quantity != null ? Number(it.quantity) : null,
        interpreterCount: it.interpreterCount ?? null,
        languagePair: it.languagePair ?? "",
      }));
    res.json({
      meta: { quoteNumber: quote?.quoteNumber ?? null, companyName, projectTitle: proj.title ?? null },
      items: seedItems,
    });
  } catch (err) {
    req.log.error({ err }, "수행정보 대량등록 템플릿 seed 조회 실패");
    res.status(500).json({ error: "템플릿 정보를 불러오지 못했습니다." });
  }
});

// ── POST analyze(DB 미변경) ──────────────────────────────────────────────────
router.post("/admin/projects/:id/performances/bulk-import/analyze", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
  try {
    const holidaySet = await loadKrHolidaySet();
    const isHoliday = (d: string) => holidaySet.has(d);
    const result = await analyzePerformanceImport(projectId, req.file.buffer, { projectId, isHoliday });
    res.json({
      fileName: decodeFileName(req.file.originalname),
      sheetName: result.sheetName,
      columnMap: result.columnMap,
      summary: summarize(result.rows),
      rows: result.rows.map(stripInternal),
    });
  } catch (err: any) {
    req.log.error({ err }, "수행정보 대량등록 분석 실패");
    res.status(400).json({ error: err?.message ?? "엑셀 분석 실패. 템플릿 형식을 확인해주세요." });
  }
});

// ── POST execute(파일 재검증 후 신규+선택 행만 INSERT) ─────────────────────────
router.post("/admin/projects/:id/performances/bulk-import/execute", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
  const fileName = decodeFileName(req.file.originalname);
  const userId = (req as any).user?.id ?? null;
  // 선택된 rowKey(사용자 선택 §29). 미제공 시 신규 전체(하위호환).
  let selected: Set<string> | null = null;
  const rawSel = req.body?.selectedKeys;
  if (rawSel != null) {
    try { const arr = typeof rawSel === "string" ? JSON.parse(rawSel) : rawSel; if (Array.isArray(arr)) selected = new Set(arr.map(String)); }
    catch { selected = null; }
  }
  try {
    const holidaySet = await loadKrHolidaySet();
    const isHoliday = (d: string) => holidaySet.has(d);
    // 서버 재분석·재검증(§16 보안) — 클라이언트 가공값 불신뢰.
    const result = await analyzePerformanceImport(projectId, req.file.buffer, { projectId, isHoliday });
    const summary = summarize(result.rows);
    const targets = result.rows.filter(r => r.status === "new" && r._payload && (selected == null || (r.rowKey != null && selected.has(r.rowKey))));

    let inserted = 0;
    let batchId: number | null = null;
    if (targets.length > 0) {
      await db.transaction(async (tx) => {
        // 시퀀스 시작값 — 기존 최대 sequence 이후로 부여.
        const priorRows = await tx.select().from(performanceAssignmentsTable)
          .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));
        let maxSeq = priorRows.reduce((m: number, e: any) => Math.max(m, e.sequence ?? 0), -1);
        const priorById = new Map(priorRows.map((p: any) => [p.id, p]));
        const ctx: ApplyRowCtx = { userId, isHoliday, mayConfirm: false, priorById };

        const [batch] = await tx.insert(importBatchesTable).values({
          module: "performance_assignment", importType: "excel_bulk",
          originalFilename: fileName || null, sheetName: result.sheetName || null,
          totalRows: summary.total, successRows: targets.length, warningRows: summary.warning, errorRows: summary.error,
          status: "completed", createdBy: userId,
        }).returning({ id: importBatchesTable.id });
        batchId = batch.id;

        for (const r of targets) {
          maxSeq += 1;
          // 배정 + 추가비용 + 차감을 단일 경로(applyPerformanceRow)로 원자 저장(§30·§33).
          const payload: RowInput = { ...(r._payload as RowInput), sequence: maxSeq };
          // 최종 방어: 위험 상태/지급상태는 저장 직전에도 고정(§21·§22).
          payload.status = "assigned";
          payload.paymentStatus = "unpaid";
          const assignmentId = await applyPerformanceRow(tx, projectId, payload, ctx);
          await tx.insert(importRowSourcesTable).values({
            batchId: batch.id, module: "performance_assignment", entityId: assignmentId,
            sourceFile: fileName || null, sourceSheet: result.sheetName || null,
            sourceRow: r.rowNumber, rowKey: r.rowKey, status: "new",
          });
          inserted += 1;
        }
      });
    }

    await logEvent("project", projectId, "bulk_import_performances", req.log,
      userId ? { id: userId, email: (req as any).user?.email ?? "" } : undefined,
      JSON.stringify({ projectId, fileName, batchId, total: summary.total, inserted, identical: summary.identical, needsReview: summary.needsReview, duplicateFile: summary.duplicateFile, error: summary.error }));

    res.json({ fileName, mode: "new_only", batchId, inserted, updated: 0, summary });
  } catch (err: any) {
    req.log.error({ err }, "수행정보 대량등록 실행 실패");
    res.status(400).json({ error: err?.message ?? "수행정보 대량등록에 실패했습니다." });
  }
});

export default router;
