// ─── 프로젝트 손익(§15) 공용 계산 — 판매 상세 '프로젝트 손익 요약' · 지급준비점검 엑셀 수익금액/수익률 (READ-ONLY) ─────
//  · 원가는 performance_assignments.costTotal(원가합계) 기준. 별도 저장값 없이 실시간 집계.
//  · 판매 공급가액은 현재 견적(quote_items)에서 불러옴 — 판매정보를 재입력/재저장하지 않음(§15).
//  · 부가세는 손익에서 제외, 공급가액 기준으로 계산(§15).
//  화면(GET /admin/projects/:id/performance-summary)과 엑셀이 이 함수 하나를 쓴다 — 계산 로직을 따로 두지 않는다.
import { db, quotesTable, quoteItemsTable, performanceAssignmentsTable, projectsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { legacyVerifiedSaleSupply } from "./legacyActivationLineage";

export interface ProjectProfit {
  saleSupplyAmount: number;
  saleSupplyBasis: "items" | "legacy_crm" | "legacy_unverified";
  saleCancelled: boolean;
  originalSaleSupplyAmount: number;
  totalCost: number;
  basePerformanceFeeTotal: number;
  expenseTotal: number;
  deductionTotal: number;
  estimatedProfit: number;
  estimatedMarginRate: number | null;
  paidCost: number;
  actualProfit: number;
  actualMarginRate: number | null;
}

export async function computeProjectProfit(projectId: number) {
  // 현재 견적의 공급가액 합계(총 판매 공급가액)
  const [currentQuote] = await db.select().from(quotesTable)
    .where(and(eq(quotesTable.projectId, projectId), eq(quotesTable.isCurrent, true), isNull(quotesTable.deletedAt)));
  let saleSupplyAmount = 0;
  // 공급가액 기준: items(현재 견적 품목) | legacy_crm(과거 CRM 원본 공급가액, 검증됨) | legacy_unverified(과거 CRM 전환·공급가/부가세 미확인)
  let saleSupplyBasis: ProjectProfit["saleSupplyBasis"] = "items";
  if (currentQuote) {
    const items = await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, currentQuote.id));
    saleSupplyAmount = items.reduce((s, i) => s + Number(i.supplyAmount ?? 0), 0);
    // 과거 CRM 전환 판매: 전환 시 부가세 포함 총액이 공급가로 들어간 건(품목 부가세 0)은 검증된 원본 공급가액으로 손익 계산(조회 전용, DB 미변경)
    const itemsTotal = items.reduce((s, i) => s + Number(i.totalAmount ?? 0), 0);
    const itemsTax = items.reduce((s, i) => s + Number(i.taxAmount ?? 0), 0);
    const lg = await legacyVerifiedSaleSupply(db, projectId, itemsTotal, itemsTax).catch(() => ({ supply: null, isLegacy: false }));
    if (lg.supply != null) { saleSupplyAmount = lg.supply; saleSupplyBasis = "legacy_crm"; }
    else if (lg.isLegacy && Math.abs(itemsTax) <= 0.5) saleSupplyBasis = "legacy_unverified";
  }

  // 수행/원가 행 (soft-delete 제외)
  const rows = await db.select().from(performanceAssignmentsTable)
    .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));

  const num = (v: unknown) => Number(v ?? 0);
  const totalCost               = rows.reduce((s, r) => s + num(r.costTotal), 0);
  const basePerformanceFeeTotal = rows.reduce((s, r) => s + num(r.basePerformanceFee), 0);
  const expenseTotal            = rows.reduce((s, r) => s + num(r.expenseTotal), 0);
  const deductionTotal          = rows.reduce((s, r) => s + num(r.deductionTotal), 0);
  // 실제원가: 지급완료(paid) 행의 원가합계 기준(정산상태 제거 → 지급상태로 단일화 §4·§5)
  const paidCost = rows.filter(r => r.paymentStatus === "paid")
    .reduce((s, r) => s + num(r.costTotal), 0);
  const actualCostBasis = paidCost;

  // 판매취소 건 — 유효 매출 0원, 실제 발생 원가는 그대로 → 손익 = 0 − 원가, 수익률은 계산하지 않음(null → 화면 '—').
  //   견적·품목·원가 데이터는 변경하지 않는다(조회 계산만). 최초 판매 공급가액은 originalSaleSupplyAmount 로 함께 제공.
  const [projRow] = await db.select({ status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, projectId));
  const saleCancelled = projRow?.status === "cancelled";
  const originalSaleSupplyAmount = saleSupplyAmount;
  if (saleCancelled) saleSupplyAmount = 0;

  const estimatedProfit = saleSupplyAmount - totalCost;
  const actualProfit    = saleSupplyAmount - actualCostBasis;
  const rate = (profit: number): number | null => (saleCancelled ? null : saleSupplyAmount > 0 ? Math.round((profit / saleSupplyAmount) * 1000) / 10 : 0);
  const r0 = (n: number) => Math.round(n);

  const profit: ProjectProfit = {
    saleSupplyAmount: r0(saleSupplyAmount),
    saleSupplyBasis,
    saleCancelled,
    originalSaleSupplyAmount: r0(originalSaleSupplyAmount),
    totalCost: r0(totalCost),
    basePerformanceFeeTotal: r0(basePerformanceFeeTotal),
    expenseTotal: r0(expenseTotal),
    deductionTotal: r0(deductionTotal),
    estimatedProfit: r0(estimatedProfit),
    estimatedMarginRate: rate(estimatedProfit),
    paidCost: r0(paidCost),
    actualProfit: r0(actualProfit),
    actualMarginRate: rate(actualProfit),
  };
  return { rows, totalCost, profit };
}
