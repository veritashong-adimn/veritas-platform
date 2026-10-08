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
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, and, or, ilike, gte, lte, count, desc, sql, type SQL } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { buildFilteredSalesProjectList } from "./admin";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

const LA = legacyArchiveRowsTable;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Legacy 전량 로드 안전 상한(수만 건 규모). 초과 시 degraded/truncated 로 표기(거짓 total 금지).
const LEGACY_FETCH_CAP = 20000;

export interface SalesHistoryRow {
  source: "current" | "legacy";
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
  };
}
function mapLegacyRow(r: any): SalesHistoryRow {
  return {
    source: "legacy", key: `legacy:${r.id}`, id: r.id,
    recordDate: r.recordDate ?? null,
    saleNumber: null,
    saleName: r.productName ?? r.companyName ?? null,
    companyName: r.companyName ?? null,
    contactName: r.contactName ?? null,
    productName: r.productName ?? null,
    amount: toNum(r.totalAmount),
    collectionDate: r.collectionDate ?? null,
    collectionStatus: r.collectionStatus ?? null,
    workflowStatus: null,         // Legacy 는 Current workflow 없음(가짜 생성 금지)
    pmName: null,
    adminId: null, financialStatus: null, quoteType: null,
  };
}

// Legacy sales_list 통합 대상 조회(공통 filter 만). Current 전용 filter 는 적용하지 않는다.
// (C-4I-b §14) Legacy 는 "effective 누적(is_effective)"만 사용 — 부분파일 업로드 후에도 과거 판매자료 소실 없이,
//   superseded 과거 version 은 통합목록에서 제외(중복 방지). Current Sales schema/데이터는 불변.
function legacyWhere(q: Record<string, string | undefined>): SQL {
  const conds: SQL[] = [eq(LA.sourceType, "sales_list"), eq(LA.isEffective, true)];
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
      const fetched = await dbx.select({
        id: LA.id, recordDate: LA.recordDate, companyName: LA.companyName, contactName: LA.contactName,
        productName: LA.productName, totalAmount: LA.totalAmount, collectionDate: LA.collectionDate, collectionStatus: LA.collectionStatus,
      }).from(LA).where(where).orderBy(sql`${LA.recordDate} desc nulls last`, desc(LA.id)).limit(LEGACY_FETCH_CAP);
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
