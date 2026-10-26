// ─── Current + Legacy 판매이력 통합조회 (C-4C) ────────────────────────────────
//   GET /admin/sales-history  — Current 판매(projects) + Legacy Archive(sales_list) 통합.
//
// 원칙:
//   · 저장 분리 / 조회 통합. Current/Legacy schema 를 합치지 않는다 — SELECT projection 만 공통 DTO 로.
//   · 기존 GET /admin/projects 는 변경하지 않는다(Current-only 로 그대로 유지). 이 endpoint 만 통합.
//   · Legacy 는 source_type='sales_list' 만 포함(progress 제외 — 판매건 이력이 아님).
//   · Current workflow / Current-only filter 가 있으면 Legacy 에 억지 적용하지 않고 current 범위로 좁힌다.
//   · Current/Legacy 쿼리를 독립 실행(try/catch) → 부분 실패 격리. degraded 시 가짜 total 만들지 않는다.
//   · Current Master 생성/mapping 없음. 날짜/금액/상태 추측 없음.
import { Router, type IRouter } from "express";
import { activatedSaleExists } from "../services/legacyActivationLineage";
import { db, legacyArchiveRowsTable, legacySalesProgressLinksTable } from "@workspace/db";
import { eq, and, or, ilike, gte, lte, count, desc, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireAuth, requireRole } from "../middlewares/auth";
import { buildFilteredSalesProjectList } from "./admin";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

const LA = legacyArchiveRowsTable;
// 과거 CRM 판매건의 "판매일" — sales_list 는 record_date 가 비어 있고(견적일 컬럼 없음) 날짜가 판매번호(YYYY-MM-DD-NNNN)에 내장됨.
//   권위 순서(C-4I-f 판매목록 정렬과 동일): record_date → 판매번호 앞 10자 → 세금계산서발행(예정)일 앞 10자.
//   원본(source_raw)·판매번호는 변경하지 않고 조회 시점 표시/정렬용으로만 파생한다.
const LEGACY_SALE_DATE = sql<string>`coalesce(to_char(${LA.recordDate},'YYYY-MM-DD'), substring(${LA.sourceRaw} ->> '판매번호' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'), substring(${LA.sourceRaw} ->> '세금계산서발행(예정)일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'))`;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Legacy 전량 로드 안전 상한(수만 건 규모). 초과 시 degraded/truncated 로 표기(거짓 total 금지).
const LEGACY_FETCH_CAP = 20000;

export interface SalesHistoryRow {
  source: "current" | "legacy";
  origin?: "legacy_crm" | null;   // current 중 과거 CRM 에서 전환된 판매건(출처 배지용, additive)
  key: string;
  id: number | string;
  recordDate: string | null;
  saleNumber: string | null;
  saleName: string | null;
  companyName: string | null;
  contactName: string | null;
  productName: string | null;
  amount: number | null;
  collectionDate: string | null;
  collectionStatus: string | null;
  workflowStatus: string | null;
  pmName: string | null;
  // Current 표시 보조(legacy 는 null)
  adminId: number | null;
  financialStatus: string | null;
  quoteType: string | null;
  // (목록 표시 전용, READ-ONLY) 계산서발행일·영업담당자. legacy 는 source_raw 원본값, current 는 null.
  taxInvoiceDate: string | null;
  salesRep: string | null;
  // (목록/상세 표시 전용, READ-ONLY) 입금일(YYYY-MM-DD)·입금내역(원문 문자열). legacy 는 source_raw, current 는 null(임의 생성 금지).
  paymentDate: string | null;
  paymentMemo: string | null;
}

function toDateStr(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function likeTerm(s: string): string { return `%${s.replace(/[\\%_]/g, (c) => "\\" + c)}%`; }
function validDate(s?: string): string | null { return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

// Current 전용 filter 가 걸리면 Legacy 에 적용 불가 → current 범위로 자동 전환(§12·§21).
const CURRENT_ONLY_PARAMS = ["status", "quickFilter", "quoteType", "billingType", "financialStatus", "paymentDueDateFrom", "paymentDueDateTo", "assignedAdminId", "companyId"];
function hasCurrentOnlyFilter(q: Record<string, string | undefined>): boolean {
  return CURRENT_ONLY_PARAMS.some((k) => q[k] != null && String(q[k]).trim() !== "" && q[k] !== "all");
}

function mapCurrentRow(p: any): SalesHistoryRow {
  return {
    source: "current", key: `current:${p.id}`, id: p.id,
    recordDate: toDateStr(p.createdAt),
    saleNumber: null,
    saleName: p.title ?? null,
    companyName: p.companyName ?? null,
    contactName: p.contactName ?? null,
    productName: null,
    amount: toNum(p.quotePrice),
    collectionDate: null,
    collectionStatus: p.financialStatus ?? null,
    workflowStatus: p.status ?? null,
    pmName: null,                 // 프론트에서 adminUsers[adminId] 로 표시
    adminId: p.adminId ?? null,
    financialStatus: p.financialStatus ?? null,
    quoteType: p.quoteType ?? null,
    taxInvoiceDate: null,         // current 은 계산서발행일 별도 보유 안 함(추정 금지)
    salesRep: null,               // current 담당자는 프론트에서 adminName(adminId) 사용
    paymentDate: null,            // current 수금/정산은 별도 로직 — 여기서 임의 생성하지 않음
    paymentMemo: null,
  };
}
// 담당PM 표시명(내부 직원 admin/staff) — 화면의 관리자 목록에 없는 직원 PM 도 표시되도록 current 행에 채운다(additive).
async function fillPmNames(dbx: any, list: SalesHistoryRow[]) {
  const ids = [...new Set(list.map(r => r.adminId).filter((v): v is number => v != null))];
  if (!ids.length) return;
  const us = (await dbx.execute(sql`SELECT id, coalesce(name, email) nm FROM users WHERE id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`)).rows as any[];
  const byId = new Map(us.map(u => [Number(u.id), String(u.nm)]));
  for (const r of list) if (r.adminId != null) r.pmName = byId.get(Number(r.adminId)) ?? null;
}

// 과거 CRM 전환 판매건 — 판매일은 전환일(createdAt)이 아니라 원본 판매번호의 판매일로 표시·정렬(원본 불변).
async function markLegacyOrigin(dbx: any, list: SalesHistoryRow[]) {
  if (!list.length) return;
  const ids = list.map(r => Number(r.id));
  const maps = (await dbx.execute(sql`SELECT entity_id, legacy_id FROM legacy_master_mappings
    WHERE source_system = 'old_crm' AND entity_type = 'sale' AND status = 'active' AND entity_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`)).rows as any[];
  const byId = new Map(maps.map(m => [Number(m.entity_id), String(m.legacy_id)]));
  for (const r of list) {
    const saleNo = byId.get(Number(r.id));
    if (!saleNo) continue;
    r.origin = "legacy_crm"; r.saleNumber = saleNo;
    r.recordDate = saleNo.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? r.recordDate;
  }
}

function mapLegacyRow(r: any): SalesHistoryRow {
  return {
    source: "legacy", key: `legacy:${r.id}`, id: r.id,
    // (정렬/표시) 판매번호 내장 날짜를 판매일로 사용(원본 불변). record_date 가 있으면 우선.
    recordDate: r.saleDate ?? r.recordDate ?? null,
    saleNumber: r.saleNumber ?? null,
    // 고객 담당자 = 연결 매핑으로 집계한 진행관리 '고객명'(거래처 측). 담당PM(영업담당자)과 대체하지 않음.
    saleName: r.productName ?? r.companyName ?? null,
    companyName: r.companyName ?? null,
    contactName: r.customerContact ?? null,   // 연결 매핑 집계 '고객명'(없거나 미연결이면 null → 화면 '-')
    productName: r.productName ?? null,
    amount: toNum(r.totalAmount),
    collectionDate: r.collectionDate ?? null,
    collectionStatus: r.collectionStatus ?? null,
    workflowStatus: null,         // Legacy 는 Current workflow 없음(가짜 생성 금지)
    pmName: null,
    adminId: null, financialStatus: null, quoteType: null,
    taxInvoiceDate: r.taxInvoiceDate ?? null,   // 원본 세금계산서발행(예정)일 값 그대로
    salesRep: r.salesRep ?? null,               // 원본 영업담당자 값 그대로
    paymentDate: r.paymentDate ?? null,         // 원본 입금일(YYYY-MM-DD)
    paymentMemo: r.paymentMemo ?? null,         // 원본 입금내역 문자열 보존(상태 변환 없음)
  };
}

// Legacy sales_list 통합 대상 조회(공통 filter 만). Current 전용 filter 는 적용하지 않는다.
// (C-4I-b §14) Legacy 는 "effective 누적(is_effective)"만 사용 — 부분파일 업로드 후에도 과거 판매자료 소실 없이,
//   superseded 과거 version 은 통합목록에서 제외(중복 방지). Current Sales schema/데이터는 불변.
function legacyWhere(q: Record<string, string | undefined>): SQL {
  const conds: SQL[] = [eq(LA.sourceType, "sales_list"), eq(LA.isEffective, true),
    // 운영 판매건으로 전환된 판매번호는 current 행 1건으로만 표시(중복 표시 방지). 전환 판매가 취소되면 다시 과거 행으로 표시.
    sql`NOT ${activatedSaleExists(sql`${LA.sourceRaw} ->> '판매번호'`)}`];
  if (q.search?.trim() || q.q?.trim()) {
    const term = likeTerm((q.search || q.q || "").trim());
    const orExpr = or(ilike(LA.companyName, term), ilike(LA.contactName, term), ilike(LA.productName, term));
    if (orExpr) conds.push(orExpr);
  }
  const dFrom = validDate(q.dateFrom), dTo = validDate(q.dateTo);
  if (dFrom) conds.push(gte(LA.recordDate, dFrom));
  if (dTo) conds.push(lte(LA.recordDate, dTo));
  return and(...conds) as SQL;
}

// 통합 정렬: recordDate DESC(null 뒤) → key DESC(deterministic).
function sortRows(rows: SalesHistoryRow[]): SalesHistoryRow[] {
  return rows.sort((a, b) => {
    if (a.recordDate && b.recordDate) { if (a.recordDate !== b.recordDate) return a.recordDate < b.recordDate ? 1 : -1; }
    else if (a.recordDate && !b.recordDate) return -1;
    else if (!a.recordDate && b.recordDate) return 1;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });
}

export interface SalesHistoryResult {
  rows: SalesHistoryRow[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  sources: { current: { ok: boolean; count?: number; error?: string }; legacy: { ok: boolean; count?: number; error?: string; truncated?: boolean } };
  degraded: boolean;
  range: "all" | "current" | "legacy";
  forcedCurrentOnly: boolean;
}

export async function getSalesHistory(dbx: any, q: Record<string, string | undefined>): Promise<SalesHistoryResult> {
  const reqRange = (q.range === "current" || q.range === "legacy" || q.range === "all") ? q.range : "all";
  const forcedCurrentOnly = reqRange !== "legacy" && hasCurrentOnlyFilter(q);
  const effRange: "all" | "current" | "legacy" = forcedCurrentOnly ? "current" : reqRange;

  const page = Math.max(1, Math.floor(Number(q.page) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(q.pageSize) || DEFAULT_PAGE_SIZE)));

  const sources: SalesHistoryResult["sources"] = { current: { ok: true }, legacy: { ok: true } };
  let currentRows: SalesHistoryRow[] = [];
  let legacyRows: SalesHistoryRow[] = [];

  // Current (기존 로직 재사용 — 전체 matching 반환)
  if (effRange === "all" || effRange === "current") {
    try {
      const list = await buildFilteredSalesProjectList(q);
      currentRows = (list as any[]).map(mapCurrentRow);
      await markLegacyOrigin(dbx, currentRows);
      await fillPmNames(dbx, currentRows);
      sources.current = { ok: true, count: currentRows.length };
    } catch (e: any) {
      sources.current = { ok: false, error: "현재 판매자료 조회 실패" };
    }
  }

  // Legacy sales_list (공통 filter 만)
  if (effRange === "all" || effRange === "legacy") {
    try {
      const where = legacyWhere(q);
      const totalRow = await dbx.select({ n: count() }).from(LA).where(where);
      const legacyTotal = Number(totalRow[0]?.n ?? 0);
      // (C-4J-2C-13) 고객 담당자 — 기존 확정 매핑(legacy_sales_progress_links)으로 연결된 진행관리 수행행의 '고객명'을 판매건별 집계.
      //   READ-ONLY 조회만(매핑 재계산/DB 변경 없음). 고유 1명→이름 / 복수 상이→'확인 필요' / 없음·미연결→null.
      //   '고객명'은 거래처 측 고객 담당자(내부 담당자·영업담당자·통번역사명과 구분됨 — 검증 완료).
      const LP = alias(legacyArchiveRowsTable, "lp");
      const LSP = legacySalesProgressLinksTable;
      const custSq = dbx.select({
        saleRowId: LSP.saleRowId,
        dn: sql<number>`count(distinct nullif(btrim(${LP.sourceRaw} ->> '고객명'), ''))`.as("dn"),
        oneName: sql<string | null>`max(nullif(btrim(${LP.sourceRaw} ->> '고객명'), ''))`.as("one_name"),
      }).from(LSP).innerJoin(LP, eq(LP.id, LSP.progressRowId))
        // 반복 업로드: 확정 연결 + 현재 유효 수행행만(수정 이전 버전·되돌린 이관 연결 제외 → 고객명 중복 집계 방지).
        .where(and(eq(LSP.decision, "confirmed"), eq(LP.isEffective, true)))
        .groupBy(LSP.saleRowId).as("cust");
      const fetched = await dbx.select({
        id: LA.id, recordDate: LA.recordDate, saleDate: LEGACY_SALE_DATE, saleNumber: sql<string | null>`${LA.sourceRaw} ->> '판매번호'`,
        companyName: LA.companyName, contactName: LA.contactName,
        productName: LA.productName, totalAmount: LA.totalAmount, collectionDate: LA.collectionDate, collectionStatus: LA.collectionStatus,
        taxInvoiceDate: sql<string | null>`nullif(btrim(${LA.sourceRaw} ->> '세금계산서발행(예정)일'), '')`,
        salesRep: sql<string | null>`nullif(btrim(${LA.sourceRaw} ->> '영업담당자'), '')`,
        paymentDate: sql<string | null>`substring(${LA.sourceRaw} ->> '입금일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')`,
        paymentMemo: sql<string | null>`nullif(btrim(${LA.sourceRaw} ->> '입금내역'), '')`,
        customerContact: sql<string | null>`case when ${custSq.dn} = 1 then ${custSq.oneName} when ${custSq.dn} > 1 then '확인 필요' else null end`,
      }).from(LA).leftJoin(custSq, eq(custSq.saleRowId, LA.id)).where(where).orderBy(sql`${LEGACY_SALE_DATE} desc nulls last`, desc(LA.id)).limit(LEGACY_FETCH_CAP);
      legacyRows = fetched.map(mapLegacyRow);
      const truncated = legacyTotal > fetched.length;
      sources.legacy = { ok: true, count: legacyTotal, truncated };
    } catch (e: any) {
      sources.legacy = { ok: false, error: "과거 CRM 자료 조회 실패" };
    }
  }

  const degraded = (effRange !== "legacy" && !sources.current.ok) || (effRange !== "current" && !sources.legacy.ok) || !!sources.legacy.truncated;

  const merged = sortRows([...currentRows, ...legacyRows]);
  const total = (sources.current.ok ? (sources.current.count ?? 0) : 0) + (sources.legacy.ok ? (sources.legacy.count ?? 0) : 0);
  const pageRows = merged.slice((page - 1) * pageSize, page * pageSize);

  return {
    rows: pageRows,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    sources, degraded, range: effRange, forcedCurrentOnly,
  };
}

router.get("/admin/sales-history", ...adminGuard, async (req, res) => {
  try {
    const result = await getSalesHistory(db, req.query as Record<string, string | undefined>);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "sales-history failed");
    res.status(500).json({ error: "판매이력 조회 실패." });
  }
});

export default router;
