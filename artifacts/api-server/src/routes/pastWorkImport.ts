// ─────────────────────────────────────────────────────────────────────────────
// 과거자료 일괄등록 (Past-Work Bulk Registration) — VERITAS OS
//
// 목적: 실제 과거 「결제리스트」(견적→판매→수행→지급) 자료를, 사용자가 화면에서 직접
//       견적등록→판매전환→수행등록→통번역사배정→지급예정 을 한 것과 "동일한 정상 운영
//       데이터"로 이관한다. 별도 레거시 저장소/정산 직접 INSERT 금지(§0·§30).
//
// 재사용(중복 엔진 금지):
//   · 파싱      : hometaxExcel.parseAllSheets / buildColumnMap (공통 파서)
//   · 견적금액   : 그룹 대표 공급가/부가세/총액 1회 사용(중복합산 금지). 견적번호 generateQuoteNumber
//   · 수행 SSOT : applyPerformanceRow / computeRowValues / computePerformanceBaseFee /
//                 calcCostTotal / calcPayoutWithholding (수동 수행등록과 동일)
//   · 멱등성    : import_batches / import_row_sources (재업로드 중복방지 §21)
//
// 9/15 지급 흐름(§0·§15·§16): 신규 수행/지급회차 시스템만 사용. tasks→settlements 미사용.
//   수행배정을 deliveryConfirmed=true · paymentStatus=unpaid · costTotal>0 ·
//   expectedPaymentDate=지급일 로 생성하여, 기존 지급회차 로직이 자동 수집하도록 한다.
//
// 안전(§20·§21·§22·§30): 주민등록번호 등 PII 미매핑/미노출. 미매칭 자동생성 금지(거래처/담당자/
//   통번역사/상품). 기존 데이터 수정/삭제 금지. execute 는 견적그룹 단위 트랜잭션.
//
// 엔드포인트:
//   POST /admin/past-work/bulk-import/analyze   파일 분석·Grouping·매칭·금액대사 (DB 미변경)
//   POST /admin/past-work/bulk-import/execute    선택 그룹 등록(파일 재검증 후) — ※운영 승인 후 사용
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import multer from "multer";
import {
  db, quotesTable, quoteItemsTable, projectsTable, companiesTable, contactsTable,
  productsTable, usersTable, translatorAliasesTable, companyAliasesTable, divisionsTable,
  performanceAssignmentsTable, importBatchesTable, importRowSourcesTable,
  calcCostTotal, calcPayoutWithholding, DEFAULT_DOMESTIC_WITHHOLDING_TREATMENT,
} from "@workspace/db";
import { sql, eq, and, isNull } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { getSettings } from "../lib/getSettings";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { generateQuoteNumber } from "./admin";
import {
  applyPerformanceRow, computeRowValues, computePerformanceBaseFee,
  loadKrHolidaySet, type RowInput, type ApplyRowCtx,
} from "./performances";
import {
  parseAllSheets, buildColumnMap, describeColumnMap, isBlankRow, getCell,
  normalizeName, normalizeDate, normalizeCompanyNameKey,
  PASTWORK_SYNONYMS,
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

function decodeFileName(raw: string | undefined): string {
  if (!raw) return "";
  try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; }
}

// ── 셀 파싱 ──────────────────────────────────────────────────────────────────
function strCell(v: unknown): string { return String(v ?? "").trim(); }
/** 금액/숫자 셀 → number|null (음수·콤마·통화기호 허용, 원본값 무보정 §12). */
function numOrNull(v: unknown): number | null {
  const s = String(v ?? "").replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

// 시트명 → 서비스 구분(§1: 번역/통역/장비 시트). 미상은 상품명/내용에서 유추(폴백).
function categoryFromSheet(sheetName: string): "translation" | "interpretation" | "equipment" | null {
  const k = sheetName.replace(/\s/g, "");
  if (/통역/.test(k)) return "interpretation";
  if (/번역/.test(k)) return "translation";
  if (/장비/.test(k)) return "equipment";
  return null;
}
function categoryFromText(...texts: string[]): "translation" | "interpretation" | "equipment" {
  const s = texts.join(" ");
  if (/통역/.test(s)) return "interpretation";
  if (/장비/.test(s)) return "equipment";
  return "translation";
}

// ── 원본 행(한 행 = 수행 1건) ─────────────────────────────────────────────────
interface RawRow {
  sheet: string; rowNumber: number;
  category: "translation" | "interpretation" | "equipment";
  // 견적/영업(그룹 판별·금액)
  companyName: string; bizNo: string; customerName: string; phone: string;
  quoteIssueDate: string; quoteKind: string; contractDate: string;
  content: string; productName: string; note: string; pm: string;
  unitPrice: number | null; quantity: number | null;
  supplyAmount: number | null; vatAmount: number | null; totalAmount: number | null;
  // 수행정보
  translatorName: string; fileName: string; detailInfo: string;
  language: string; deliveryDate: string; payDate: string; place: string;
  // 수행비용
  fee100: number | null; fee85: number | null;
  transportFee: number | null; businessTripFee: number | null;
  travelDayCompensation: number | null; copyrightFee: number | null; cancellationCompensation: number | null;
  perfQuantity: number | null; perfUnit: string; perfUnitPrice: number | null;
  preTaxPayout: number | null;
  // 거래처 Master resolution 결과(그룹핑 전에 canonicalize, §5) — annotateCompanies 에서 채움.
  resolvedCompanyId?: number | null; resolvedDivisionId?: number | null;
  resolvedCompanyName?: string; resolvedDivisionName?: string;
  resolvedMethod?: CoMethod; resolvedCandidates?: number;
}

// ── Preview 타입 ──────────────────────────────────────────────────────────────
type Status = "new" | "identical" | "duplicate_file" | "needs_review" | "error";

interface AssignPreview {
  rowNumber: number; sheet: string; groupKey: string; companyName: string;
  category: string; translatorName: string; matchedTranslatorId: number | null;
  language: string; fileName: string; content: string;
  deliveryDate: string; payDate: string;
  quantity: number | null; unit: string; unitPrice: number | null;
  // 원본 수행비 항목별(§11 · §7 대사용) — 뭉개지 않고 각 항목 보존.
  fee100: number | null; fee85: number | null;
  transportFee: number | null; businessTripFee: number | null;
  travelDayCompensation: number | null; copyrightFee: number | null; cancellationCompensation: number | null;
  base: number; expenseTotal: number; deductionTotal: number;
  computedPreTax: number;               // 시스템 계산 세전(costTotal)
  originalPreTax: number | null;        // 원본 지급액(세전)
  preTaxDiff: number;                   // 원본 − 시스템 (§12·§27)
  withholdingRate: number; withholdingTax: number; netPay: number;
  status: Status; reason?: string; warning?: string;
}

interface QuotePreview {
  groupKey: string; rowKey: string;
  companyName: string; matchedCompanyId: number | null; matchedCompanyName: string;
  companyMatchMethod: CoMethod;                       // bizno|canonical|alias|relation|normalized|ambiguous|unmatched
  matchedDivisionId: number | null; matchedDivisionName: string;   // 본점/브랜드 관계 매칭 시
  quoteCategory: "translation" | "interpretation" | "equipment" | "mixed";   // 견적 유형(번역/통역/장비/혼합)
  customerName: string; matchedContactId: number | null;
  pm: string; matchedAdminId: number | null;
  quoteIssueDate: string; contractDate: string; quoteKind: string;
  title: string; itemCount: number; assignmentCount: number;
  // 금액 대사(§26): 원본 총액 vs 시스템(공급가+부가세) — 그룹 대표금액 1회 기준
  originalSupply: number; originalVat: number; originalTotal: number;
  systemSupply: number; systemVat: number; systemTotal: number;
  totalDiff: number;                    // 원본총액 − 시스템총액
  status: Status; reason?: string; warning?: string;
  existingQuoteId?: number | null;
}

interface AnalyzeResult {
  sheetNames: string[]; columnMap: Record<string, string | null>;
  quotes: QuotePreview[]; assignments: AssignPreview[];
}

// ── 그룹 키(§4) — 이번 과거자료 확정 규칙 ──────────────────────────────────────
// 동일 견적 판별: 거래처명(상호) + 공급가액 + 부가세 + 총액.  이 4값이 같으면 Excel에서
// 2·3·5줄로 나뉘어 있어도 견적은 1건이다. 각 행의 차이(고객명/견적일/견적구분/체결일/상품명/
// 파일/통번역사/언어/수량/수행비 등)는 "별도 견적"이 아니라 그 견적 안의 수행 상세이므로
// 키에서 제외한다 — 이 값들의 차이로 동일 견적이 30건으로 과분리되던 문제를 제거한다.
// 금액은 정규화만 한다(콤마 제거는 numOrNull, 빈 VAT=0, 상호 공백·법인표기 제거). 값 자체는
// 반올림·수정하지 않는다(§12): 여기서는 매칭용 key 문자열만 정규화하고 원본 숫자는 보존한다.
const GROUP_KEY_FIELDS = ["canonical거래처", "공급가액", "부가세", "총액"] as const;
/** 금액 매칭 키: 빈값(null)=0으로 취급(빈 VAT가 실제 0을 의미). 반올림·변형 없이 숫자 원값 사용. */
function amtKey(n: number | null): string { return n == null ? "0" : String(n); }
// 견적 Grouping 은 "원본 거래처명(정규화)" + 공급가 + 부가세 + 총액 기준이다(§2·§3·§7).
// Master resolution 결과(canonical 회사 ID)를 그룹 키에 넣지 않는다 — canonicalize-before-group 은
// 동일 원본 견적을 resolution 상태 차이로 쪼개(29→33 과분리) 회귀를 유발했으므로 제거한다.
// resolution 은 그룹 확정 후 각 그룹에 붙인다(annotateCompanies 결과는 매칭 표시·연결용으로만 사용).
function companyGroupPart(r: RawRow): string {
  return normalizeCompanyNameKey(r.companyName);
}
function buildGroupKey(r: RawRow): string {
  return [companyGroupPart(r), amtKey(r.supplyAmount), amtKey(r.vatAmount), amtKey(r.totalAmount)].join("|");
}
/** 각 행의 원본 거래처명을 Master(사업자번호/canonical/alias/본점-브랜드/normalized)로 resolve 하여
 *  canonical 회사 ID 를 부여한다. 그룹핑은 이 회사 ID 기준으로 수행한다(§5, alias/브랜드 표기차 흡수). */
function annotateCompanies(rows: RawRow[], m: Masters): void {
  const cache = new Map<string, CoResolution>();
  for (const r of rows) {
    const ck = `${r.companyName}${r.bizNo}`;
    let res = cache.get(ck);
    if (!res) { res = resolveCompany(r.companyName, r.bizNo, m); cache.set(ck, res); }
    r.resolvedCompanyId = res.companyId; r.resolvedDivisionId = res.divisionId;
    r.resolvedCompanyName = res.companyName; r.resolvedDivisionName = res.divisionName;
    r.resolvedMethod = res.method; r.resolvedCandidates = res.candidates;
  }
}
// forward-fill 경계 — 병합/첫행에만 견적금액이 있는 경우 같은 거래처(canonical) 연속행에 상속(§4).
function identityKey(r: RawRow): string { return companyGroupPart(r); }

// ── 마스터 인덱스 로드 ─────────────────────────────────────────────────────────
// 거래처 매칭에 필요한 4개 축(사업자번호 / canonical name / alias / 본점-브랜드(division))을
// 모두 인덱싱한다. alias 의 정규화는 별칭 생성 시와 동일한 normalizeCompanyName 을 기준으로 해야
// "롯데백화점→롯데쇼핑" 같은 기존 별칭이 Import 매칭에서 실제로 사용된다.
const addTo = (map: Map<string, number[]>, key: string, id: number) => {
  if (!key) return; const a = map.get(key) ?? map.set(key, []).get(key)!;
  if (!a.includes(id)) a.push(id);
};
async function loadMasters() {
  const companies = await db.select({ id: companiesTable.id, name: companiesTable.name, bizNo: companiesTable.businessNumber })
    .from(companiesTable).where(isNull(companiesTable.deletedAt));
  const companyNameById = new Map<number, string>();
  const byBizNo = new Map<string, number>();          // 사업자번호(숫자10) → 회사 (1순위)
  const byCanonical = new Map<string, number[]>();     // normalizeCompanyName(회사명) → 회사 (2순위)
  const byNormalizedAlt = new Map<string, number[]>(); // normalizeCompanyNameKey(회사명) 폴백 (5순위)
  for (const c of companies) {
    companyNameById.set(c.id, c.name);
    const biz = (c.bizNo ?? "").replace(/\D/g, "");
    if (/^\d{10}$/.test(biz) && !byBizNo.has(biz)) byBizNo.set(biz, c.id);
    addTo(byCanonical, normalizeCompanyName(c.name), c.id);
    addTo(byNormalizedAlt, normalizeCompanyNameKey(c.name), c.id);
  }
  // 거래처 별칭(3순위) — normalized_alias(=별칭 생성 시 normalizeCompanyName) + aliasName 재정규화 둘 다 색인.
  const aliasRows = await db.select({ companyId: companyAliasesTable.companyId, aliasName: companyAliasesTable.aliasName, norm: companyAliasesTable.normalizedAlias }).from(companyAliasesTable);
  const liveCompanyIds = new Set(companies.map(c => c.id));
  const byAlias = new Map<string, number[]>();
  for (const a of aliasRows) {
    if (!liveCompanyIds.has(a.companyId)) continue;
    addTo(byAlias, (a.norm ?? "").trim(), a.companyId);
    addTo(byAlias, normalizeCompanyName(a.aliasName), a.companyId);
  }
  // 본점/브랜드 관계(4순위) — divisions: 회사 소속 브랜드/사업부. "회사|정규화브랜드" → divisionId.
  const divisions = await db.select({ id: divisionsTable.id, companyId: divisionsTable.companyId, name: divisionsTable.name }).from(divisionsTable);
  const divisionByCompany = new Map<string, number>();   // `${companyId}|${normalizeCompanyName(brand)}` → divisionId
  const divisionNameById = new Map<number, string>();
  for (const d of divisions) {
    if (!liveCompanyIds.has(d.companyId)) continue;
    divisionByCompany.set(`${d.companyId}|${normalizeCompanyName(d.name)}`, d.id);
    divisionNameById.set(d.id, d.name);
  }

  const contacts = await db.select({ id: contactsTable.id, companyId: contactsTable.companyId, name: contactsTable.name })
    .from(contactsTable).where(and(eq(contactsTable.isActive, true), isNull(contactsTable.deletedAt)));
  const contactByCoName = new Map<string, number[]>();
  for (const c of contacts) { const k = `${c.companyId}|${normalizeName(c.name)}`; (contactByCoName.get(k) ?? contactByCoName.set(k, []).get(k)!).push(c.id); }
  const pmUsers = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable).where(sql`${usersTable.role} in ('admin','staff') and ${usersTable.deletedAt} is null`);
  const pmByName = new Map<string, number[]>();
  for (const u of pmUsers) { const nn = normalizeCompanyName(u.name ?? ""); if (nn) (pmByName.get(nn) ?? pmByName.set(nn, []).get(nn)!).push(u.id); }
  const products = await db.select({ id: productsTable.id, name: productsTable.name }).from(productsTable);
  const prodByName = new Map<string, number[]>();
  for (const p of products) { const nk = normalizeCompanyName(p.name); if (nk) (prodByName.get(nk) ?? prodByName.set(nk, []).get(nk)!).push(p.id); }
  // 통번역사(§20: PII 미로드). users(role=translator) 이름 + alias 로만 매칭.
  const translators = await db.select({ id: usersTable.id, name: usersTable.name })
    .from(usersTable).where(sql`${usersTable.role} = 'translator' and ${usersTable.deletedAt} is null`);
  const nameToIds = new Map<string, number[]>();
  const addName = (id: number, nk: string) => { if (nk) (nameToIds.get(nk) ?? nameToIds.set(nk, []).get(nk)!).push(id); };
  for (const t of translators) addName(t.id, normalizeCompanyName(t.name ?? ""));
  const talias = await db.select({ translatorId: translatorAliasesTable.translatorId, norm: translatorAliasesTable.normalizedAlias }).from(translatorAliasesTable);
  const known = new Set(translators.map(t => t.id));
  for (const a of talias) { if (known.has(a.translatorId)) addName(a.translatorId, a.norm); }
  // 재업로드 멱등성(§21): 과거자료 배치가 남긴 rowKey 집합.
  const priorSources = await db.select({ rowKey: importRowSourcesTable.rowKey })
    .from(importRowSourcesTable).where(eq(importRowSourcesTable.module, "past_work"));
  const priorRowKeys = new Map<string, boolean>();
  for (const s of priorSources) { if (s.rowKey) priorRowKeys.set(s.rowKey, true); }
  return { companyNameById, byBizNo, byCanonical, byNormalizedAlt, byAlias, divisionByCompany, divisionNameById,
    contactByCoName, pmByName, prodByName, nameToIds, priorRowKeys };
}
type Masters = Awaited<ReturnType<typeof loadMasters>>;

// ── 거래처 Master resolution(§2~5) ────────────────────────────────────────────
// 우선순위: 1)사업자번호 2)canonical exact 3)alias exact 4)본점/브랜드 관계 5)normalized 폴백.
// fuzzy 자동확정 금지. 다중후보/복합명 관계 미확인은 ambiguous(확인필요)로 남긴다.
type CoMethod = "bizno" | "canonical" | "alias" | "relation" | "normalized" | "ambiguous" | "unmatched";
interface CoResolution { companyId: number | null; companyName: string; divisionId: number | null; divisionName: string; method: CoMethod; candidates: number; }
function resolveCompany(rawName: string, bizNoRaw: string, m: Masters): CoResolution {
  const nm = (id: number) => m.companyNameById.get(id) ?? "";
  const hit = (id: number, method: CoMethod, divisionId: number | null = null): CoResolution =>
    ({ companyId: id, companyName: nm(id), divisionId, divisionName: divisionId != null ? (m.divisionNameById.get(divisionId) ?? "") : "", method, candidates: 1 });
  const none = (method: CoMethod, candidates = 0): CoResolution => ({ companyId: null, companyName: "", divisionId: null, divisionName: "", method, candidates });
  const raw = (rawName ?? "").trim();
  // 1) 사업자등록번호 exact
  const biz = (bizNoRaw ?? "").replace(/\D/g, "");
  if (/^\d{10}$/.test(biz)) { const id = m.byBizNo.get(biz); if (id != null) return hit(id, "bizno"); }
  if (!raw) return none("unmatched");
  // 2) canonical exact
  const canon = normalizeCompanyName(raw);
  { const c = m.byCanonical.get(canon) ?? []; if (c.length === 1) return hit(c[0], "canonical"); if (c.length >= 2) return none("ambiguous", c.length); }
  // 3) alias exact
  { const c = m.byAlias.get(canon) ?? []; if (c.length === 1) return hit(c[0], "alias"); if (c.length >= 2) return none("ambiguous", c.length); }
  // 4) 복합명(본점/브랜드): "/" 등 separator 분해 → 구성요소를 회사+division 관계로 확인(DB에 있을 때만).
  //    "/"가 있다고 무조건 앞부분 회사로 붙이지 않는다 — 실제 관계 확인 시에만 확정, 아니면 확인필요.
  if (/[\/／|]/.test(raw)) {
    const parts = raw.split(/[\/／|]/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const compCanon = normalizeCompanyName(parts[i]);
      const compIds = [...new Set([...(m.byCanonical.get(compCanon) ?? []), ...(m.byAlias.get(compCanon) ?? [])])];
      if (compIds.length !== 1) continue;
      const cid = compIds[0];
      for (let j = 0; j < parts.length; j++) {
        if (j === i) continue;
        const div = m.divisionByCompany.get(`${cid}|${normalizeCompanyName(parts[j])}`);
        if (div != null) return hit(cid, "relation", div);
      }
    }
    return none("ambiguous", 0); // 복합명이나 본점/브랜드 관계 미확인 → 확인필요(자동 확정 금지)
  }
  // 5) normalized 폴백(hometax 변형 정규화)
  { const c = m.byNormalizedAlt.get(normalizeCompanyNameKey(raw)) ?? []; if (c.length === 1) return hit(c[0], "normalized"); if (c.length >= 2) return none("ambiguous", c.length); }
  return none("unmatched");
}

// ── 원본 파일 → RawRow[] ───────────────────────────────────────────────────────
function readRawRows(buffer: Buffer): { rows: RawRow[]; sheetNames: string[]; columnMap: Record<string, string | null> } {
  const sheets = parseAllSheets(buffer, PASTWORK_SYNONYMS);
  if (sheets.length === 0) throw new Error("인식 가능한 데이터 시트를 찾을 수 없습니다. 결제리스트 형식을 확인해주세요.");
  const rows: RawRow[] = [];
  let firstColMap: Record<string, string | null> = {};
  sheets.forEach((sheet, si) => {
    const cMap = buildColumnMap(sheet.headers, PASTWORK_SYNONYMS);
    if (si === 0) firstColMap = describeColumnMap(sheet.headers, cMap);
    const sheetCat = categoryFromSheet(sheet.sheetName);
    sheet.dataRows.forEach((raw, i) => {
      if (isBlankRow(raw)) return;
      const g = (f: string) => getCell(raw, cMap, f);
      const productName = strCell(g("productName"));
      const content = strCell(g("content"));
      const category = sheetCat ?? categoryFromText(productName, content);
      rows.push({
        sheet: sheet.sheetName, rowNumber: sheet.headerRowIndex + 2 + i, category,
        companyName: strCell(g("companyName")), bizNo: strCell(g("businessNumber")), customerName: strCell(g("customerName")), phone: strCell(g("phone")),
        quoteIssueDate: normalizeDate(g("quoteIssueDate")), quoteKind: strCell(g("quoteKind")), contractDate: normalizeDate(g("contractDate")),
        content, productName, note: strCell(g("note")), pm: strCell(g("pm")),
        unitPrice: numOrNull(g("unitPrice")), quantity: numOrNull(g("quantity")),
        supplyAmount: numOrNull(g("supplyAmount")), vatAmount: numOrNull(g("vatAmount")), totalAmount: numOrNull(g("totalAmount")),
        translatorName: strCell(g("translatorName")), fileName: strCell(g("fileName")), detailInfo: strCell(g("detailInfo")),
        language: strCell(g("language")), deliveryDate: normalizeDate(g("deliveryDate")), payDate: normalizeDate(g("payDate")), place: strCell(g("place")),
        fee100: numOrNull(g("fee100")), fee85: numOrNull(g("fee85")),
        transportFee: numOrNull(g("transportFee")), businessTripFee: numOrNull(g("businessTripFee")),
        travelDayCompensation: numOrNull(g("travelDayCompensation")), copyrightFee: numOrNull(g("copyrightFee")),
        cancellationCompensation: numOrNull(g("cancellationCompensation")),
        perfQuantity: numOrNull(g("perfQuantity")), perfUnit: strCell(g("perfUnit")), perfUnitPrice: numOrNull(g("perfUnitPrice")),
        preTaxPayout: numOrNull(g("preTaxPayout")),
      });
    });
  });
  // forward-fill: 병합/첫행에만 있는 "견적금액"(공급가/부가세/총액)과 PM·비고를 같은 거래처
  // 연속행에 상속한다(§4). 행별 상세(단가/수량/수행비 등)는 각 행 고유값이므로 상속하지 않는다.
  let prevId = ""; let fill: Partial<RawRow> = {};
  for (const r of rows) {
    const id = identityKey(r);
    if (id !== prevId) { prevId = id; fill = {}; }
    for (const f of ["supplyAmount", "vatAmount", "totalAmount", "pm", "note"] as const) {
      if ((r as any)[f] == null || (r as any)[f] === "") { if ((fill as any)[f] != null) (r as any)[f] = (fill as any)[f]; }
      else (fill as any)[f] = (r as any)[f];
    }
  }
  return { rows, sheetNames: sheets.map(s => s.sheetName), columnMap: firstColMap };
}

// ── 통번역사 매칭(§5·§20) — 이름 only(동명이인 위험은 경고). 미등록은 오류(자동생성 금지). ──
function matchTranslator(name: string, m: Masters): { id: number | null; status: Status; reason?: string; warning?: string } {
  const nk = normalizeCompanyName(name);
  if (!nk) return { id: null, status: "error", reason: "통번역사명 없음" };
  const cands = m.nameToIds.get(nk) ?? [];
  if (cands.length === 1) return { id: cands[0], status: "new", warning: "이름 기준 매칭 — 확인 권장" };
  if (cands.length >= 2) return { id: null, status: "needs_review", reason: "동명이인 다수 — 확인 필요" };
  return { id: null, status: "error", reason: "통번역사 미등록 — 마스터에 먼저 등록 필요" };
}

// ── 한 수행 행의 지급비용 미리보기(기존 SSOT 재사용, §11·§28) ──────────────────
function buildAssignPayload(r: RawRow, translatorId: number | null): RowInput {
  const isInterp = r.category === "interpretation";
  let isDirectAmount = false; let directAmount: number | null = null;
  let contractUnitPrice: number | null = null; let quantity: number | null = r.perfQuantity ?? r.quantity;
  if (isInterp) {
    // 통역: 요율(85%)=directAmount(지급base ×0.85 규칙), 요금(100%)=참조. 단가×수량 폴백.
    if (r.fee85 != null) { isDirectAmount = true; directAmount = r.fee85; contractUnitPrice = r.fee100; }
    else if (r.perfUnitPrice != null && quantity != null) { contractUnitPrice = r.perfUnitPrice; }
    else { isDirectAmount = true; directAmount = null; contractUnitPrice = r.fee100; }
  } else {
    // 번역·감수: 요금(100%)=directAmount 또는 단가×수량.
    if (r.fee100 != null) { isDirectAmount = true; directAmount = r.fee100; }
    else if (r.perfUnitPrice != null && quantity != null) { contractUnitPrice = r.perfUnitPrice; }
  }
  // 추가비용 유형별 분해(§11 — 뭉개기 금지). performance_expenses 저장값 사용.
  const expenses: NonNullable<RowInput["expenses"]> = [];
  const pushExp = (type: string, amt: number | null) => { if (amt != null && amt > 0) expenses.push({ expenseType: type, amount: amt }); };
  pushExp("교통비", r.transportFee);
  pushExp("출장비", r.businessTripFee);
  pushExp("이동일보상", r.travelDayCompensation);
  pushExp("저작권료", r.copyrightFee);
  pushExp("취소보상", r.cancellationCompensation);

  const category = r.category === "equipment" ? "vendor" : "individual";
  const snap: any = { itemType: r.category, productName: r.productName || r.content, languagePair: r.language || null, interpretPlace: r.place || null };
  return {
    saleItemId: null, quoteId: null, sourceType: "manual",
    performerCategory: category as any,
    individualUserId: category === "individual" ? translatorId : null,
    status: "assigned",
    serviceType: r.category,
    productNameSnapshot: r.productName || r.content || null,
    serviceDetailSnapshot: snap,
    languageOrServiceSnapshot: r.language || null,
    performanceStartDate: r.deliveryDate || null,
    performanceEndDate: r.deliveryDate || null,
    deliveryDate: r.deliveryDate || null,
    deliveryDateManual: !!r.deliveryDate,
    deliveryConfirmed: true,                       // 과거자료 = 이미 납품 완료(§15) → 지급회차 수집 조건 충족
    contractUnitPrice, quantity, unit: r.perfUnit || null,
    isDirectAmount, directAmount,
    payDateManual: !!r.payDate,
    expectedPaymentDate: r.payDate || null,        // 통번역사지급일(2026.09.15) → 지급예정일(§15)
    payDateChangeReason: r.payDate ? "과거자료 일괄등록 — 원본 지급일 보존" : null,
    paymentStatus: "unpaid",                       // §16 — paid 직접 생성 금지(지급회차로만)
    withholdingTreatment: DEFAULT_DOMESTIC_WITHHOLDING_TREATMENT as any,
    remark: r.fileName || r.detailInfo || null,
    expenses, deductions: [],
  };
}

function computeAssignPreview(payload: RowInput): { base: number; expenseTotal: number; deductionTotal: number; gross: number; rate: number; deduction: number; net: number } {
  const computed = computeRowValues(payload);
  const base = computePerformanceBaseFee(payload, computed, payload.serviceDetailSnapshot ?? null);
  const totals = calcCostTotal(
    base,
    (payload.expenses ?? []).map(e => ({ amount: Number(e.amount ?? 0), includedInPayout: e.includedInPayout })),
    (payload.deductions ?? []).map(d => ({ amount: Number(d.amount ?? 0) })),
  );
  const payeeType = payload.performerCategory === "vendor" ? "vendor" : "individual";
  const wt = calcPayoutWithholding(totals.costTotal, payeeType as any, (payload.withholdingTreatment as any) ?? DEFAULT_DOMESTIC_WITHHOLDING_TREATMENT, null);
  return { base: totals.basePerformanceFee, expenseTotal: totals.expenseTotal, deductionTotal: totals.deductionTotal, gross: wt.gross, rate: wt.rate, deduction: wt.deduction, net: wt.net };
}

// 견적 매출금액은 그룹 대표 공급가/부가세/총액을 1회만 사용한다(중복합산 금지). quote_items 는
// 대표 품목 1건으로 생성하고, 원본 수행행의 상세(상품/파일/통번역사/수량/수행비)는 수행배정에 보존한다.
// 상품명 매칭에는 loadMasters().prodByName 을 그대로 사용한다(execute 의 대표품목 productId 연결).

// ── 분석(§2·§7) — DB 미변경 ────────────────────────────────────────────────────
export async function analyzePastWork(buffer: Buffer): Promise<AnalyzeResult> {
  const { rows, sheetNames, columnMap } = readRawRows(buffer);
  const m = await loadMasters();
  annotateCompanies(rows, m);   // §5: 그룹핑 전에 거래처를 canonical 회사 ID 로 resolve

  // 그룹핑(canonical 회사 ID + 공급가 + 부가세 + 총액)
  const groups = new Map<string, RawRow[]>();
  for (const r of rows) { const k = buildGroupKey(r); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }

  const quotes: QuotePreview[] = [];
  const assignments: AssignPreview[] = [];
  const seenFileFp = new Set<string>();

  for (const [groupKey, group] of groups) {
    const head = group.find(r => r.companyName) ?? group[0];
    // 견적 유형(번역/통역/장비/혼합) — 그룹 내 수행행 category 로 판정.
    const cats = new Set(group.map(r => r.category));
    const quoteCategory: QuotePreview["quoteCategory"] = cats.size === 1 ? [...cats][0] : "mixed";
    // 그룹 대표 resolution — 그룹 내에서 실제로 매칭된 행을 우선(원본명 변형으로 일부만 매칭될 수 있음).
    const resRow = group.find(r => r.resolvedCompanyId != null) ?? head;
    const title = `${head.content || head.productName || "과거 업무"}${head.quoteIssueDate ? ` (${head.quoteIssueDate})` : ""}`;

    const qp: QuotePreview = {
      groupKey, rowKey: `pastwork|quote|${groupKey}`,
      companyName: head.companyName, matchedCompanyId: null, matchedCompanyName: "",
      companyMatchMethod: resRow.resolvedMethod ?? "unmatched",
      matchedDivisionId: resRow.resolvedDivisionId ?? null, matchedDivisionName: resRow.resolvedDivisionName ?? "",
      quoteCategory,
      customerName: head.customerName, matchedContactId: null, pm: head.pm, matchedAdminId: null,
      quoteIssueDate: head.quoteIssueDate, contractDate: head.contractDate, quoteKind: head.quoteKind,
      title, itemCount: 0, assignmentCount: group.length,
      originalSupply: 0, originalVat: 0, originalTotal: 0, systemSupply: 0, systemVat: 0, systemTotal: 0, totalDiff: 0,
      status: "new",
    };

    // 거래처 매칭 결과(§7·§8, annotateCompanies 에서 resolve — grouping 이후 적용). fuzzy 자동확정 없음.
    qp.matchedCompanyId = resRow.resolvedCompanyId ?? null;
    qp.matchedCompanyName = resRow.resolvedCompanyName ?? "";
    if (qp.matchedCompanyId != null) {
      if (resRow.resolvedMethod === "relation" && qp.matchedDivisionName) qp.warning = `본점/브랜드 관계로 매칭: ${qp.matchedCompanyName} / ${qp.matchedDivisionName}`;
    } else if (resRow.resolvedMethod === "ambiguous") {
      qp.status = "needs_review";
      qp.reason = (resRow.resolvedCandidates ?? 0) >= 2 ? `거래처 다중후보(${resRow.resolvedCandidates}) — 확인 필요` : "거래처 복합명/본점·브랜드 관계 미확인 — 확인 필요";
    } else {
      qp.status = "error"; qp.reason = "거래처 미등록 — 마스터 연결/신규등록 결정 필요";
    }

    // 담당자 매칭(확정 거래처 내부, canonical 회사 기준 §6)
    if (qp.matchedCompanyId && head.customerName) {
      const cc = m.contactByCoName.get(`${qp.matchedCompanyId}|${normalizeName(head.customerName)}`) ?? [];
      if (cc.length === 1) qp.matchedContactId = cc[0];
      else if (cc.length >= 2 && qp.status === "new") { qp.status = "needs_review"; qp.reason = "담당자 다중후보(동일 거래처)"; }
      else if (cc.length === 0 && qp.status === "new") { qp.warning = "담당자 미확인 — 거래처만 연결됩니다"; }
    }
    // PM 매칭(이름)
    if (head.pm) { const pc = m.pmByName.get(normalizeCompanyName(head.pm)) ?? []; if (pc.length === 1) qp.matchedAdminId = pc[0]; }

    // 견적금액 대사(§26 · 중복합산 금지): 그룹 대표 공급가/부가세/총액을 "1회"만 사용한다.
    // 동일 견적이 여러 수행행으로 반복돼도 각 행 금액을 합산하지 않는다(139M 과다계상의 원인 제거).
    // 그룹 키가 (거래처+공급가+부가세+총액)이므로 그룹 내 금액은 동일 — 첫 유효행을 대표로 취한다.
    // 수행비/지급액은 이와 별개로 그룹 내 각 수행행의 실제값을 합산한다(아래 assignments).
    const repRow = group.find(r => r.supplyAmount != null || r.vatAmount != null || r.totalAmount != null) ?? head;
    const repSupply = repRow.supplyAmount ?? 0;
    const repVat = repRow.vatAmount ?? 0;
    const repTotal = repRow.totalAmount ?? round2(repSupply + repVat);
    qp.itemCount = 1;                                   // 대표 매출 라인 1건(원본 수행행은 별도 보존)
    qp.originalSupply = round2(repSupply);
    qp.originalVat = round2(repVat);
    qp.originalTotal = round2(repTotal);
    qp.systemSupply = round2(repSupply);
    qp.systemVat = round2(repVat);
    qp.systemTotal = round2(repSupply + repVat);       // 시스템: 공급가+부가세로 재구성(검증용)
    qp.totalDiff = round2(repTotal - qp.systemTotal);  // 총액 vs (공급가+부가세) 불일치 검출

    // 멱등성/중복(§21)
    if (qp.status === "new") {
      if (m.priorRowKeys.has(qp.rowKey)) { qp.status = "identical"; qp.reason = "이미 등록된 과거자료(동일 그룹) — 재등록 제외"; }
      else if (seenFileFp.has(qp.rowKey)) { qp.status = "duplicate_file"; qp.reason = "파일 내부 중복 그룹"; }
      else seenFileFp.add(qp.rowKey);
    }

    quotes.push(qp);

    // 수행 배정 미리보기(그룹 내 각 행)
    group.forEach((r, idx) => {
      const tm = r.category === "equipment"
        ? { id: null as number | null, status: "needs_review" as Status, reason: "장비/업체 지급 — 공급업체 매칭 확인 필요(§14)" }
        : matchTranslator(r.translatorName, m);
      const payload = buildAssignPayload(r, tm.id);
      const c = computeAssignPreview(payload);
      const orig = r.preTaxPayout;
      assignments.push({
        rowNumber: r.rowNumber, sheet: r.sheet, groupKey, companyName: r.companyName,
        category: r.category, translatorName: r.translatorName, matchedTranslatorId: tm.id,
        language: r.language, fileName: r.fileName, content: r.content,
        deliveryDate: r.deliveryDate, payDate: r.payDate,
        quantity: r.perfQuantity ?? r.quantity, unit: r.perfUnit, unitPrice: r.perfUnitPrice,
        fee100: r.fee100, fee85: r.fee85,
        transportFee: r.transportFee, businessTripFee: r.businessTripFee,
        travelDayCompensation: r.travelDayCompensation, copyrightFee: r.copyrightFee, cancellationCompensation: r.cancellationCompensation,
        base: c.base, expenseTotal: c.expenseTotal, deductionTotal: c.deductionTotal,
        computedPreTax: c.gross, originalPreTax: orig, preTaxDiff: orig != null ? round2(orig - c.gross) : 0,
        withholdingRate: c.rate, withholdingTax: c.deduction, netPay: c.net,
        status: tm.status, reason: tm.reason, warning: tm.warning,
      });
      void idx;
    });
  }

  return { sheetNames, columnMap, quotes, assignments };
}

// 이번 과거자료 지급회차 기준일(§10) — 이 날짜가 지급예정일인 수행행만 9/15 지급 대상.
const TARGET_PAYOUT_DATE = "2026-09-15";

function summarize(a: AnalyzeResult) {
  const q = a.quotes;
  const asg = a.assignments;
  const sum = (xs: AssignPreview[], f: (x: AssignPreview) => number) => round2(xs.reduce((s, x) => s + f(x), 0));
  const projectCount = q.filter(x => x.status === "new").length;
  // 번역/통역/장비 분리(§1·§5·§13). 장비는 통번역사 지급/견적 수에서 분리 집계.
  const tr = asg.filter(x => x.category === "translation");
  const itp = asg.filter(x => x.category === "interpretation");
  const eq = asg.filter(x => x.category === "equipment");
  const nonEq = asg.filter(x => x.category !== "equipment");   // 통번역사 세전 대사 대상(장비 제외)
  // 9/15 지급 대상 = 원본 지급예정일이 TARGET_PAYOUT_DATE 인 통번역 수행행(§10·§11). 장비 제외.
  const pay0915 = nonEq.filter(x => x.payDate === TARGET_PAYOUT_DATE);
  return {
    // ── 원본(§14 A) ──
    rawRows: asg.length,
    rawRowsTranslation: tr.length, rawRowsInterpretation: itp.length, rawRowsEquipment: eq.length,
    // ── 견적 Grouping(§14 견적) ──
    quotesTotal: q.length,                                   // 원본 분석 전체 견적 Group 수
    quotesNew: projectCount,                                 // 신규등록 가능(status=new)
    quotesIdentical: q.filter(x => x.status === "identical").length,
    quotesNeedsReview: q.filter(x => x.status === "needs_review").length,
    quotesDuplicate: q.filter(x => x.status === "duplicate_file").length,
    quotesError: q.filter(x => x.status === "error").length,
    quotesTranslation: q.filter(x => x.quoteCategory === "translation").length,
    quotesInterpretation: q.filter(x => x.quoteCategory === "interpretation").length,
    quotesEquipment: q.filter(x => x.quoteCategory === "equipment").length,
    quotesMixed: q.filter(x => x.quoteCategory === "mixed").length,
    projectCount, assignmentCount: asg.length,
    assignmentsTranslation: tr.length, assignmentsInterpretation: itp.length, assignmentsEquipment: eq.length,
    // ── Master(§14) — 거래처 resolution 방식별 분해 ──
    companyMatched: q.filter(x => x.matchedCompanyId != null).length,
    companyUnmatched: q.filter(x => x.matchedCompanyId == null).length,
    companyExact: q.filter(x => x.companyMatchMethod === "bizno" || x.companyMatchMethod === "canonical").length,
    companyAlias: q.filter(x => x.companyMatchMethod === "alias").length,
    companyRelation: q.filter(x => x.companyMatchMethod === "relation").length,
    companyNormalized: q.filter(x => x.companyMatchMethod === "normalized").length,
    contactMatched: q.filter(x => x.matchedContactId != null).length,
    contactUnmatched: q.filter(x => x.customerName && x.matchedContactId == null).length,
    translatorMatched: nonEq.filter(x => x.matchedTranslatorId != null).length,
    translatorUnmatched: nonEq.filter(x => x.matchedTranslatorId == null).length,
    // ── 견적금액 대사(§9·§14) — 그룹 대표금액 1회, 중복합산 없음 ──
    quoteTotalOriginal: sum(q as any, (x: any) => x.originalTotal),
    quoteTotalSystem: sum(q as any, (x: any) => x.systemTotal),
    quoteTotalDiff: sum(q as any, (x: any) => x.totalDiff),
    // ── 금액 대사(전체, Master 매칭과 무관 §11) — 장비 제외 통번역 세전 ──
    preTaxOriginal: sum(nonEq, x => x.originalPreTax ?? 0),
    preTaxSystem: sum(nonEq, x => x.computedPreTax),
    preTaxDiff: sum(nonEq, x => (x.originalPreTax ?? 0) - x.computedPreTax),
    // ── 9/15 지급회차 대상만(§10·§11·§14) ──
    pay0915Rows: pay0915.length,
    pay0915PreTaxOriginal: sum(pay0915, x => x.originalPreTax ?? 0),
    pay0915PreTaxSystem: sum(pay0915, x => x.computedPreTax),
    pay0915PreTaxDiff: sum(pay0915, x => (x.originalPreTax ?? 0) - x.computedPreTax),
    nonPay0915Rows: nonEq.length - pay0915.length,
    // ── 장비(별도 §13) ──
    equipmentRows: eq.length,
    equipmentOriginalTotal: sum(eq, x => x.originalPreTax ?? 0),
    // 오류(§7)
    errorCount: q.filter(x => x.status === "error").length + asg.filter(x => x.status === "error").length,
  };
}

// ── 검증/리포트 전용(라우트 미노출, 스크립트에서 호출) ────────────────────────
// 수정 전(구 key: 거래처+고객+견적일+견적구분+체결일+총액) vs 수정 후(신 key: 거래처+공급가+부가세+총액)
// Grouping 을 비교하고, 견적별 상세 + 30→26 로 합쳐진 견적을 Before/After 로 산출한다. DB 미변경.
function oldGroupKey(r: RawRow): string {
  return [
    normalizeCompanyNameKey(r.companyName), normalizeName(r.customerName),
    r.quoteIssueDate, r.quoteKind, r.contractDate,
    r.totalAmount != null ? Math.round(r.totalAmount) : "",
  ].join("|");
}
// 거래처 resolution 단독 검증(파일 불필요) — 대표 케이스(롯데백화점→롯데쇼핑 등) 확인용.
export async function debugResolveCompanies(inputs: { name: string; bizNo?: string }[]) {
  const m = await loadMasters();
  return inputs.map(x => ({ input: x.name, ...resolveCompany(x.name, x.bizNo ?? "", m) }));
}
export async function analyzeWithGroupingDiff(buffer: Buffer) {
  const { rows } = readRawRows(buffer);
  const m = await loadMasters();
  annotateCompanies(rows, m);   // Before/After 그룹핑 비교를 위해 canonical 회사 ID 부여
  const result = await analyzePastWork(buffer);
  const summary = summarize(result);
  const groupBy = (keyFn: (r: RawRow) => string) => {
    const g = new Map<string, RawRow[]>();
    for (const r of rows) { const k = keyFn(r); (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
    return g;
  };
  const oldGroups = groupBy(oldGroupKey);
  const newGroups = groupBy(buildGroupKey);
  // 견적별 세전 지급액(원본/시스템) — assignments 를 groupKey 로 합산.
  const preTaxByGroup = new Map<string, { orig: number; sys: number }>();
  for (const a of result.assignments) {
    const e = preTaxByGroup.get(a.groupKey) ?? { orig: 0, sys: 0 };
    e.orig += a.originalPreTax ?? 0; e.sys += a.computedPreTax;
    preTaxByGroup.set(a.groupKey, e);
  }
  const perQuote = result.quotes.map(q => {
    const pt = preTaxByGroup.get(q.groupKey) ?? { orig: 0, sys: 0 };
    return {
      status: q.status, method: q.companyMatchMethod, company: q.matchedCompanyName || q.companyName, rawCompany: q.companyName,
      matchedCompanyId: q.matchedCompanyId, division: q.matchedDivisionName || "",
      sourceRows: q.assignmentCount, assignments: q.assignmentCount,
      supply: q.originalSupply, vat: q.originalVat, total: q.originalTotal,
      systemTotal: q.systemTotal, totalDiff: q.totalDiff,
      preTaxOriginal: round2(pt.orig), preTaxSystem: round2(pt.sys), preTaxDiff: round2(pt.orig - pt.sys),
    };
  });
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  // item 1: 신규 그룹 29개 전체 진단 덤프.
  let gi = 0;
  const allGroups = [...newGroups.entries()].map(([gk, rs]) => {
    const h = rs.find(r => r.companyName) ?? rs[0];
    return {
      groupNo: ++gi, groupKey: gk,
      canonicalCompanyId: h.resolvedCompanyId ?? null, canonicalCompanyName: h.resolvedCompanyName || "",
      companyMatchMethod: h.resolvedMethod ?? "unmatched",
      rawCompanyNames: uniq(rs.map(r => r.companyName)),
      supply: h.supplyAmount, vat: h.vatAmount, total: h.totalAmount,
      rowNumbers: rs.map(r => r.rowNumber), rowCount: rs.length,
      customers: uniq(rs.map(r => r.customerName)), quoteDates: uniq(rs.map(r => r.quoteIssueDate)),
      contractDates: uniq(rs.map(r => r.contractDate)), products: uniq(rs.map(r => r.productName || r.content)),
      translators: uniq(rs.map(r => r.translatorName)),
    };
  });
  // item 1: 동일 canonical 회사에서 2개 이상 그룹으로 분리된 경우(정상 다중견적 vs 잔여 분리 판단용).
  const byCompany = new Map<string, typeof allGroups>();
  for (const g of allGroups) { const k = g.canonicalCompanyId != null ? `co#${g.canonicalCompanyId}` : `raw:${normalizeCompanyName(g.rawCompanyNames[0] || "")}`; (byCompany.get(k) ?? byCompany.set(k, []).get(k)!).push(g); }
  const sameCompanyMultiGroups = [...byCompany.values()].filter(gs => gs.length >= 2)
    .map(gs => ({ company: gs[0].canonicalCompanyName || gs[0].rawCompanyNames[0], groupCount: gs.length,
      groups: gs.map(g => ({ groupNo: g.groupNo, supply: g.supply, vat: g.vat, total: g.total, rows: g.rowCount })) }));
  // item 1: 원본 문자열 기준(정규화 raw)+금액이 동일한데 서로 다른 신규 그룹으로 남은 잔여 분리.
  const byRawAmt = new Map<string, Set<string>>();
  for (const r of rows) { const k = `${normalizeCompanyName(r.companyName)}|${amtKey(r.supplyAmount)}|${amtKey(r.vatAmount)}|${amtKey(r.totalAmount)}`; (byRawAmt.get(k) ?? byRawAmt.set(k, new Set()).get(k)!).add(buildGroupKey(r)); }
  const residualSplits = [...byRawAmt.entries()].filter(([, gks]) => gks.size >= 2).map(([k, gks]) => ({ rawAmtKey: k, splitInto: gks.size }));
  // Before→After: 하나의 신규 그룹이 구 key 로는 2개 이상으로 쪼개져 있던(=합쳐진) 견적.
  const merged: any[] = [];
  for (const [nk, nrows] of newGroups) {
    const okeys = new Map<string, RawRow[]>();
    for (const r of nrows) { const ok = oldGroupKey(r); (okeys.get(ok) ?? okeys.set(ok, []).get(ok)!).push(r); }
    if (okeys.size >= 2) {
      const h = nrows.find(r => r.companyName) ?? nrows[0];
      merged.push({
        newKey: nk, company: h.resolvedCompanyName || h.companyName, rawCompanies: uniq(nrows.map(r => r.companyName)),
        supply: h.supplyAmount, vat: h.vatAmount, total: h.totalAmount, rowCount: nrows.length, oldGroupCount: okeys.size,
        oldGroups: [...okeys.values()].map(rs => {
          const g = rs[0];
          return { rawCompany: g.companyName, customerName: g.customerName, quoteIssueDate: g.quoteIssueDate, quoteKind: g.quoteKind, contractDate: g.contractDate, productName: g.productName || g.content, rows: rs.length };
        }),
      });
    }
  }
  // 미매칭 목록(등록 가능 여부용)
  const companyUnmatchedList = result.quotes.filter(q => q.matchedCompanyId == null).map(q => ({ raw: q.companyName, method: q.companyMatchMethod, reason: q.reason }));
  const contactUnmatchedList = result.quotes.filter(q => q.customerName && q.matchedContactId == null).map(q => ({ company: q.matchedCompanyName || q.companyName, customer: q.customerName }));
  const translatorUnmatchedList = uniq(result.assignments.filter(a => a.category !== "equipment" && a.matchedTranslatorId == null).map(a => a.translatorName));
  return {
    summary, oldGroupCount: oldGroups.size, newGroupCount: newGroups.size,
    allGroups, sameCompanyMultiGroups, residualSplits, perQuote, merged,
    assignments: result.assignments,
    companyUnmatchedList, contactUnmatchedList, translatorUnmatchedList,
  };
}

// ── analyze 엔드포인트(DB 미변경) ─────────────────────────────────────────────
router.post("/admin/past-work/bulk-import/analyze", ...adminGuard, requirePermission("quote.create"), excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
  try {
    const result = await analyzePastWork(req.file.buffer);
    res.json({
      fileName: decodeFileName(req.file.originalname),
      sheetNames: result.sheetNames,
      columnMap: result.columnMap,
      summary: summarize(result),
      quotes: result.quotes,
      assignments: result.assignments,
    });
  } catch (err: any) {
    req.log.error({ err }, "과거자료 일괄등록 분석 실패");
    res.status(400).json({ error: err?.message ?? "엑셀 분석 실패. 파일 형식을 확인해주세요." });
  }
});

// ── execute 엔드포인트(파일 재검증 후 선택 그룹 등록) ──────────────────────────
// ※ 실제 「결제리스트 20260915」 등록은 운영 승인 후에만 호출한다(§25·§31).
// 견적그룹 1건 = 1 트랜잭션(§22): quote(approved) + project(approved) + quote_items +
//   그 그룹의 수행배정(applyPerformanceRow, deliveryConfirmed=true) + import 계보.
router.post("/admin/past-work/bulk-import/execute", ...adminGuard, requirePermission("quote.create"), excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
  const fileName = decodeFileName(req.file.originalname);
  const performer = { id: (req as any).user?.id ?? 0, email: (req as any).user?.email ?? "" };
  // 사용자가 선택한 그룹(groupKey). 미제공 시 신규 그룹 전체.
  let selected: Set<string> | null = null;
  const rawSel = req.body?.selectedGroups;
  if (rawSel != null) { try { const arr = typeof rawSel === "string" ? JSON.parse(rawSel) : rawSel; if (Array.isArray(arr)) selected = new Set(arr.map(String)); } catch { selected = null; } }

  try {
    // 서버 재분석·재검증(§16) — 클라이언트 가공값 불신뢰. 원본 행 재구성.
    const { rows } = readRawRows(req.file.buffer);
    const result = await analyzePastWork(req.file.buffer);
    const summary = summarize(result);
    const holidaySet = await loadKrHolidaySet();
    const isHoliday = (d: string) => holidaySet.has(d);
    const stg = await getSettings();

    // groupKey → 원본 행 (analyze 와 동일하게 canonical 회사 ID 로 resolve 후 그룹핑 §5)
    const m = await loadMasters();
    annotateCompanies(rows, m);
    const rowsByGroup = new Map<string, RawRow[]>();
    for (const r of rows) { const k = buildGroupKey(r); (rowsByGroup.get(k) ?? rowsByGroup.set(k, []).get(k)!).push(r); }

    const targets = result.quotes.filter(q => q.status === "new" && (selected == null || selected.has(q.groupKey)));
    // 견적번호 사전 발번(트랜잭션 밖, 롤백 시 gap 정상 — 수동/기존 임포트와 동일 패턴).
    const qNums: string[] = [];
    for (let i = 0; i < targets.length; i++) qNums.push(await generateQuoteNumber());

    let quotesCreated = 0, projectsCreated = 0, assignmentsCreated = 0;
    let batchId: number | null = null;

    if (targets.length > 0) {
      // 배치 헤더(계보) — 그룹 트랜잭션과 분리(그룹 단위 원자성 §22).
      const [batch] = await db.insert(importBatchesTable).values({
        module: "past_work", importType: "legacy_migration", originalFilename: fileName || null,
        sheetName: (result.sheetNames || []).join(",") || null,
        totalRows: summary.assignmentCount, successRows: 0, warningRows: 0, errorRows: summary.errorCount,
        status: "analyzed", createdBy: performer.id || null,
      }).returning({ id: importBatchesTable.id });
      batchId = batch.id;

      for (let i = 0; i < targets.length; i++) {
        const qp = targets[i];
        const group = rowsByGroup.get(qp.groupKey) ?? [];
        const head = group.find(r => r.companyName) ?? group[0];
        // 견적금액: 그룹 대표 공급가/부가세/총액을 1회만 사용(중복합산 금지 — analyze와 동일 규칙).
        const repRow = group.find(r => r.supplyAmount != null || r.vatAmount != null || r.totalAmount != null) ?? head;
        const repSupply = repRow.supplyAmount ?? 0;
        const repVat = repRow.vatAmount ?? 0;
        const repTotal = repRow.totalAmount ?? (repSupply + repVat);
        const vatRate: 0 | 0.1 = repVat > 0 ? 0.1 : 0;
        const totalPrice = repTotal;
        // 대표 매출 품목 1건(상품명=대표행, 단일매칭 시 productId 연결). 수행 상세는 수행배정에 보존.
        const repName = head.content || head.productName || "과거 업무";
        const repProdCands = m.prodByName.get(normalizeCompanyName(repName)) ?? [];
        const repProductId = repProdCands.length === 1 ? repProdCands[0] : null;

        await db.transaction(async (tx) => {
          // 1) project(status=approved) — 판매전환된 상태로 직접 생성(admin.ts 판매전환 블록 미러).
          const [project] = await tx.insert(projectsTable).values({
            userId: performer.id || null, adminId: qp.matchedAdminId ?? (performer.id || null),
            companyId: qp.matchedCompanyId ?? null, contactId: qp.matchedContactId ?? null,
            title: qp.title, status: "approved",
          }).returning({ id: projectsTable.id });
          projectsCreated += 1;

          // 2) quote(status=approved) — 판매. 금액 SSOT. 원본 견적일 보존.
          const [quote] = await tx.insert(quotesTable).values({
            projectId: project.id, quoteNumber: qNums[i], title: qp.title, price: String(totalPrice),
            status: "approved", note: head.note || null, taxDocumentType: "tax_invoice",
            taxCategory: "normal",
            quoteType: "b2b_standard", billingType: stg.defaultBillingType, paymentMethod: null,
            issueDate: head.quoteIssueDate || new Date().toISOString().slice(0, 10),
            validUntil: head.quoteIssueDate || new Date().toISOString().slice(0, 10),
            batchItemCount: 1,
          }).returning({ id: quotesTable.id });
          quotesCreated += 1;

          // 3) quote_items — 대표 매출 품목 1건(원본 공급가/부가세/총액 그대로 보존, 재계산·반올림 없음).
          const insertedItems = await tx.insert(quoteItemsTable).values([{
            quoteId: quote.id, productId: repProductId, productName: repName,
            unit: "건", quantity: "1", unitPrice: String(repSupply),
            supplyAmount: String(repSupply), taxAmount: String(repVat), totalAmount: String(repTotal),
            itemType: head.category, taxType: vatRate === 0 ? "exempt" : "taxable", isCustomProduct: repProductId == null,
          }]).returning({ id: quoteItemsTable.id, productName: quoteItemsTable.productName });
          const repItemId = insertedItems[0]?.id ?? null;

          // 4) 수행배정 — 그룹 내 각 원본 수행행을 개별 보존(삭제/병합 금지). 매칭 payee 만 생성.
          const priorRows = await tx.select().from(performanceAssignmentsTable)
            .where(and(eq(performanceAssignmentsTable.projectId, project.id), isNull(performanceAssignmentsTable.deletedAt)));
          let maxSeq = priorRows.reduce((mx: number, e: any) => Math.max(mx, e.sequence ?? 0), -1);
          const ctx: ApplyRowCtx = { userId: performer.id || null, isHoliday, mayConfirm: true, priorById: new Map() };

          for (const r of group) {
            const tm = r.category === "equipment" ? { id: null } : matchTranslator(r.translatorName, m);
            if (tm.id == null) continue; // 미매칭 payee(통번역사/장비업체) → 건너뜀(§5·§14, 사용자 재작업)
            maxSeq += 1;
            const payload = buildAssignPayload(r, tm.id ?? null);
            payload.quoteId = quote.id;
            payload.saleItemId = repItemId;
            payload.sequence = maxSeq;
            const assignmentId = await applyPerformanceRow(tx, project.id, payload, ctx);
            assignmentsCreated += 1;
            await tx.insert(importRowSourcesTable).values({
              batchId: batch.id, module: "past_work", entityId: assignmentId,
              sourceFile: fileName || null, sourceSheet: r.sheet, sourceRow: r.rowNumber,
              rowKey: `pastwork|perf|${qp.groupKey}|${r.rowNumber}`, status: "new",
            });
          }

          // 5) 견적 그룹 계보
          await tx.insert(importRowSourcesTable).values({
            batchId: batch.id, module: "past_work", entityId: quote.id,
            sourceFile: fileName || null, sourceSheet: head.sheet, sourceRow: head.rowNumber,
            rowKey: qp.rowKey, status: "new",
          });
        });
      }

      await db.update(importBatchesTable).set({ successRows: quotesCreated, status: "completed" }).where(eq(importBatchesTable.id, batch.id));
    }

    await logEvent("quote", 0, "bulk_import_past_work", req.log, performer.id ? performer : undefined,
      JSON.stringify({ fileName, batchId, quotesCreated, projectsCreated, assignmentsCreated, ...summary }));

    res.json({ fileName, batchId, quotesCreated, projectsCreated, assignmentsCreated, summary });
  } catch (err: any) {
    req.log.error({ err }, "과거자료 일괄등록 실행 실패");
    res.status(400).json({ error: err?.message ?? "과거자료 일괄등록에 실패했습니다." });
  }
});

export default router;
export { GROUP_KEY_FIELDS };
