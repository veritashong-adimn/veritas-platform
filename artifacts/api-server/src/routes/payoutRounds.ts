// ─────────────────────────────────────────────────────────────────────────────
// 지급회차(payout_rounds) API — 정산 Phase 1.
//  · 수행정보(performance_assignments)의 미지급 건을 지급일별 회차로 묶어 지급대상(개인/외주)별 자동합산.
//  · 세전 = costTotal(기본수행료+추가비용−차감), 공제/실지급 = calcPayoutWithholding(§11, 기존 세율·round2 재사용).
//  · payoutRoundId(소프트링크)로 연결. 한 수행건은 한 회차에만 포함(payoutRoundId != null → 중복 미수집·삭제잠금).
//  · Phase 1: 생성→자동수집→합산→검토→제외/보류/이월→저장→지급확정. 실제 지급완료·명세서는 Phase 2.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import {
  db, payoutRoundsTable, payoutRoundItemsTable, performanceAssignmentsTable, projectsTable, companiesTable, quotesTable, usersTable,
  performanceExpensesTable, performanceDeductionsTable,
  calcPayoutWithholding, vendorVatApplies,
} from "@workspace/db";
import { eq, and, or, isNull, isNotNull, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

// 수집기준 날짜 컬럼 — delivery_date(납품일) 기준, expected_payment_date(지급예정일) 기준 옵션.
const basisExpr = (basis: string) =>
  basis === "delivery_date"
    ? sql`${performanceAssignmentsTable.deliveryDate}`
    : sql`COALESCE(${performanceAssignmentsTable.expectedPaymentDate}, ${performanceAssignmentsTable.deliveryDate})`;

// 기본 수집기준 — 대상기간 자동제안(suggestPeriod)이 '납품 기준 기간'(전월 16~말일 등)을 만들므로
// 수집기준도 납품일(delivery_date)로 정합시킨다. (지급예정일 기준은 지급일이 납품창 밖이라 0건 수집되던 문제 해결)
const DEFAULT_COLLECTION_BASIS = "delivery_date" as const;

// 지급대상 공통 자격조건 — 미삭제·미지급·납품확인·납품일·지급액>0·지급대상 지정(개인은 세금처리 포함).
//  · 회차 자동수집(collectWhere)과 전체 지급대상 개요(overview)가 이 동일 조건을 공유한다(§2 중복로직 방지).
//  · 회차/기간 조건(payoutRoundId·basisExpr)은 각 사용처에서만 추가로 붙인다.
const eligibleConds = () => [
  isNull(performanceAssignmentsTable.deletedAt),
  eq(performanceAssignmentsTable.paymentStatus, "unpaid"),          // 지급완료·지급보류 제외(§7-6·§8·§10)
  sql`${performanceAssignmentsTable.deliveryDate} IS NOT NULL`,     // 납품일 입력(§7-2)
  eq(performanceAssignmentsTable.deliveryConfirmed, true),          // 납품확인(§7-3)
  sql`${performanceAssignmentsTable.costTotal} > 0`,                // 지급액 확정·0원 초과(§7-4·5)
  sql`(
    (${performanceAssignmentsTable.performerCategory} = 'individual'
      AND ${performanceAssignmentsTable.individualUserId} IS NOT NULL
      AND ${performanceAssignmentsTable.withholdingTreatment} IS NOT NULL)
    OR (${performanceAssignmentsTable.performerCategory} = 'vendor'
      AND ${performanceAssignmentsTable.vendorCompanyId} IS NOT NULL)
  )`,                                                                // 지급대상 지정·세금처리(개인)(§7-1·§8)
];

// 전체 지급대상 개요(§1·§2) — 회차·기간 무관 자격충족 미지급 건 전체. scope=unassigned 이면 미배정만.
const overviewWhere = (unassignedOnly: boolean) =>
  unassignedOnly
    ? and(...eligibleConds(), isNull(performanceAssignmentsTable.payoutRoundId))
    : and(...eligibleConds());

// 자동수집 조건(§7) — 공통 자격조건 + 미배정 + 대상기간 내. (회차 생성·재수집 공용)
const collectWhere = (periodStart: string, periodEnd: string, basis: string) => and(
  ...eligibleConds(),
  isNull(performanceAssignmentsTable.payoutRoundId),
  sql`${basisExpr(basis)} >= ${periodStart}`,
  sql`${basisExpr(basis)} <= ${periodEnd}`,
);

// 표시용 조인(고객사·견적번호)으로 수행행 로드. where 절 주입식(회차 포함건 / 재포함 가능건 공용).
function selectItems(whereClause: any) {
  return db
    .select({
      id: performanceAssignmentsTable.id,
      projectId: performanceAssignmentsTable.projectId,
      quoteId: performanceAssignmentsTable.quoteId,
      quoteNumber: quotesTable.quoteNumber,
      quoteIssueDate: quotesTable.issueDate,
      customerName: companiesTable.name,
      projectTitle: projectsTable.title,
      performerCategory: performanceAssignmentsTable.performerCategory,
      payeeType: performanceAssignmentsTable.payeeType,
      individualUserId: performanceAssignmentsTable.individualUserId,
      vendorCompanyId: performanceAssignmentsTable.vendorCompanyId,
      performerName: performanceAssignmentsTable.performerNameSnapshot,
      // 지급대상 이메일(동명이인 식별용 표시정보) — 개인=users.email / 외주=companies.email. 정산 계산과 무관(표시 전용).
      //  · 서브쿼리로 조회해 기존 조인·행수에 영향 없음. 미등록이면 null → 프론트에서 '-' 표시.
      payeeEmail: sql<string | null>`COALESCE(
        (SELECT email FROM users WHERE id = ${performanceAssignmentsTable.individualUserId}),
        (SELECT email FROM companies WHERE id = ${performanceAssignmentsTable.vendorCompanyId})
      )`,
      serviceType: performanceAssignmentsTable.serviceType,
      productName: performanceAssignmentsTable.productNameSnapshot,
      deliveryDate: performanceAssignmentsTable.deliveryDate,
      expectedPaymentDate: performanceAssignmentsTable.expectedPaymentDate,
      // 건별 상세 16컬럼 표시용(수행일·작업량·단가) — 원본 필드 조회만 추가(계산 로직 불변).
      performanceStartDate: performanceAssignmentsTable.performanceStartDate,
      performanceEndDate: performanceAssignmentsTable.performanceEndDate,
      quantity: performanceAssignmentsTable.quantity,
      unit: performanceAssignmentsTable.unit,
      contractUnitPrice: performanceAssignmentsTable.contractUnitPrice,
      isDirectAmount: performanceAssignmentsTable.isDirectAmount,
      // 작업량 표시용 유형별 상세(단어/글자수·통역 인원 등). 기존 수행정보 UI와 동일 원본을 재사용(§2·§7).
      //  · 번역/감수 작업량 = wordCount||charCount(페이지수 미사용), 통역 = 일수×interpreterCount명.
      //  · saleUnitPrice 등 판매값은 사용하지 않는다(단가는 contractUnitPrice 원가단가, §5).
      serviceDetail: performanceAssignmentsTable.serviceDetailSnapshot,
      basePerformanceFee: performanceAssignmentsTable.basePerformanceFee,
      expenseTotal: performanceAssignmentsTable.expenseTotal,
      deductionTotal: performanceAssignmentsTable.deductionTotal,
      costTotal: performanceAssignmentsTable.costTotal,
      withholdingTreatment: performanceAssignmentsTable.withholdingTreatment,
      withholdingRate: performanceAssignmentsTable.withholdingRate,
      purchaseEvidenceType: performanceAssignmentsTable.purchaseEvidenceType,  // 표시용 — 외주 세금계산서(VAT별도) 라벨 판단
      paymentStatus: performanceAssignmentsTable.paymentStatus,
      remark: performanceAssignmentsTable.remark,
      // 소속 지급회차 표시용(§3) — 미배정이면 전부 null. 회차 상세 조회에도 무해(자기 회차값).
      payoutRoundId: performanceAssignmentsTable.payoutRoundId,
      roundBatchNumber: payoutRoundsTable.batchNumber,
      roundPaymentDate: payoutRoundsTable.paymentDate,
      roundStatus: payoutRoundsTable.status,
    })
    .from(performanceAssignmentsTable)
    .leftJoin(projectsTable, eq(performanceAssignmentsTable.projectId, projectsTable.id))
    .leftJoin(companiesTable, eq(projectsTable.companyId, companiesTable.id))
    .leftJoin(quotesTable, eq(performanceAssignmentsTable.quoteId, quotesTable.id))
    .leftJoin(payoutRoundsTable, eq(performanceAssignmentsTable.payoutRoundId, payoutRoundsTable.id))
    .where(whereClause)
    .orderBy(performanceAssignmentsTable.payeeType, performanceAssignmentsTable.individualUserId, performanceAssignmentsTable.vendorCompanyId, performanceAssignmentsTable.id);
}
// 수행건에 추가비용·차감 세부내역(판매관리 입력값)을 그대로 부착 — 정산 상세·지급명세서·통번역사 지급조회 공용 구조.
//  · 추가비용: 지급대상 포함(includedInPayout=true) 건만 → 합계가 expenseTotal 과 일치.
//  · 순서: 입력(생성) 순서 유지(id asc). 새 계산·DB 없음(표시용 원본 전달).
async function attachLineItems(items: any[]) {
  const ids = items.map(i => i.id);
  if (ids.length === 0) return items;
  const [expenses, deductions] = await Promise.all([
    db.select().from(performanceExpensesTable)
      .where(and(inArray(performanceExpensesTable.assignmentId, ids), eq(performanceExpensesTable.includedInPayout, true)))
      .orderBy(performanceExpensesTable.id),
    db.select().from(performanceDeductionsTable)
      .where(inArray(performanceDeductionsTable.assignmentId, ids))
      .orderBy(performanceDeductionsTable.id),
  ]);
  const expBy = new Map<number, any[]>();
  for (const e of expenses) { const a = expBy.get(e.assignmentId) ?? []; a.push({ type: e.expenseType, amount: num(e.amount), memo: e.memo ?? null }); expBy.set(e.assignmentId, a); }
  const dedBy = new Map<number, any[]>();
  for (const d of deductions) { const a = dedBy.get(d.assignmentId) ?? []; a.push({ type: d.deductionType, amount: num(d.amount), reason: d.reason ?? null }); dedBy.set(d.assignmentId, a); }
  return items.map(it => ({ ...it, expenses: expBy.get(it.id) ?? [], deductions: dedBy.get(it.id) ?? [] }));
}

// 회차 포함건 — 세부내역 부착.
const loadRoundItems = async (roundId: number) =>
  attachLineItems(await selectItems(and(eq(performanceAssignmentsTable.payoutRoundId, roundId), isNull(performanceAssignmentsTable.deletedAt))));
// 재포함 가능건(§5) — 대상기간 내 수집조건 충족 + 미배정(제외/이월된 건 포함).
const loadCollectable = (round: any) => (!round.periodStart || !round.periodEnd)
  ? Promise.resolve([] as any[])
  : selectItems(collectWhere(round.periodStart, round.periodEnd, round.collectionBasis || DEFAULT_COLLECTION_BASIS));

// 지급대상별 자동합산(§9·§10·§11) — 개인=individualUserId, 외주=vendorCompanyId 기준(반드시 고유 ID).
function aggregate(items: any[]) {
  const groups = new Map<string, any>();
  for (const it of items) {
    const isIndiv = it.payeeType === "individual" || it.performerCategory === "individual";
    const payeeId = isIndiv ? it.individualUserId : it.vendorCompanyId;
    const key = `${isIndiv ? "i" : "v"}:${payeeId ?? "none"}`;
    const tax = calcPayoutWithholding(num(it.costTotal), isIndiv ? "individual" : "vendor", it.withholdingTreatment, it.withholdingRate != null ? num(it.withholdingRate) : null, it.purchaseEvidenceType);
    let g = groups.get(key);
    if (!g) {
      g = {
        payeeKey: key, payeeType: isIndiv ? "individual" : "vendor", payeeId: payeeId ?? null,
        payeeName: it.performerName || it.customerName || "(미지정)",
        payeeEmail: it.payeeEmail ?? null,   // 동명이인 식별용 표시정보(그룹 대표값 — 같은 지급대상은 동일 이메일)
        count: 0, translationCount: 0, interpretationCount: 0, equipmentEtcCount: 0,
        baseTotal: 0, expenseTotal: 0, deductionTotal: 0, grossTotal: 0, withholdingTotal: 0, vatTotal: 0, netTotal: 0,
        treatments: new Set<string>(), rateUnconfirmed: false, allVat: true, items: [] as any[],
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (it.serviceType === "translation") g.translationCount += 1;
    else if (it.serviceType === "interpretation") g.interpretationCount += 1;
    else g.equipmentEtcCount += 1;
    g.baseTotal += num(it.basePerformanceFee);
    g.expenseTotal += num(it.expenseTotal);
    g.deductionTotal += num(it.deductionTotal);
    g.grossTotal += tax.gross;
    g.withholdingTotal += tax.deduction;
    g.vatTotal += tax.vat;
    g.netTotal += tax.net;
    if (isIndiv && it.withholdingTreatment) g.treatments.add(it.withholdingTreatment);
    if (!tax.rateConfirmed) g.rateUnconfirmed = true;
    if (!tax.isVatIncluded) g.allVat = false;   // 그룹 전체가 VAT별도(세금계산서)일 때만 요약행에 (VAT별도) 표시
    g.items.push({
      ...it,
      gross: tax.gross, withholdingTax: tax.deduction, vat: tax.vat, netPayment: tax.net,
      rate: tax.rate, rateConfirmed: tax.rateConfirmed, isVatIncluded: tax.isVatIncluded,
    });
  }
  return Array.from(groups.values()).map((g) => ({
    ...g,
    treatments: Array.from(g.treatments),
    mixedTreatment: g.treatments.size > 1,   // §11 서로 다른 세금처리 혼재 경고
    // 요약행 (VAT별도) 표시용 — 외주업체 + 그룹 내 모든 건이 세금계산서(VAT 포함)일 때만 true.
    isVatIncluded: g.payeeType === "vendor" && g.items.length > 0 && g.allVat,
  }));
}

// 지급대상별 요약 → 회차/개요 총계(§14). 회차 상세와 전체 지급대상 개요가 공용.
function computeTotals(summary: any[]) {
  return summary.reduce((t, g) => ({
    assignments: t.assignments + g.count,
    payees: t.payees + 1,
    individualCount: t.individualCount + (g.payeeType === "individual" ? 1 : 0),
    vendorCount: t.vendorCount + (g.payeeType === "vendor" ? 1 : 0),
    baseTotal: t.baseTotal + g.baseTotal,
    expenseTotal: t.expenseTotal + g.expenseTotal,
    deductionTotal: t.deductionTotal + g.deductionTotal,
    grossTotal: t.grossTotal + g.grossTotal,
    withholdingTotal: t.withholdingTotal + g.withholdingTotal,
    vatTotal: t.vatTotal + g.vatTotal,
    netTotal: t.netTotal + g.netTotal,
  }), { assignments: 0, payees: 0, individualCount: 0, vendorCount: 0, baseTotal: 0, expenseTotal: 0, deductionTotal: 0, grossTotal: 0, withholdingTotal: 0, vatTotal: 0, netTotal: 0 });
}

// 회차 상세 로드 — 지급대상별 요약 + 건별 + 경고(§8) + 총계(§14).
//  · [Source of Truth 분기] 지급확정 전(draft·reviewing): 원본 수행정보 실시간 재계산.
//    지급확정·지급완료(confirmed·paid): 확정 당시 건별 스냅샷(payout_round_items)을 그대로 표시 — 원본 재계산 금지(§10·§11).
async function loadRoundDetail(round: any) {
  if (round.status === "confirmed" || round.status === "paid") {
    const snap = await loadRoundDetailFromSnapshot(round);
    if (snap) return snap;
    // 스냅샷 미보존 레거시 확정 회차 — 확정 당시 건별값을 정확히 복원할 수 없음.
    //   임의로 현재 원본값을 확정값으로 저장하지 않는다(§7). 실시간 폴백에 'live_legacy' 플래그를 달아 표기.
  }
  const items = await loadRoundItems(round.id);
  const summary = aggregate(items);
  const totals = computeTotals(summary);

  const warnings = await loadWarnings(round);
  // 재포함 가능건(§5) — costTotal 기준 세전, 표시용 요약값만 계산해 전달.
  const collectableRaw = await loadCollectable(round);
  const collectable = collectableRaw.map((it: any) => {
    const payeeType = it.payeeType || it.performerCategory;
    return {
      id: it.id, payeeType, performerName: it.performerName,
      customerName: it.customerName, productName: it.productName, serviceType: it.serviceType,
      deliveryDate: it.deliveryDate, gross: num(it.costTotal), purchaseEvidenceType: it.purchaseEvidenceType,
      // (VAT별도) 표시용 — 세금계산서 외주만 true. 화면은 이 값만 사용(§9).
      isVatIncluded: vendorVatApplies(payeeType, it.purchaseEvidenceType),
    };
  });
  const isLocked = round.status === "confirmed" || round.status === "paid";
  const payStats = payStatsOf(summary.flatMap((g: any) => g.items.map((it: any) => it.paymentStatus ?? "unpaid")));
  return { round, summary, totals, warnings, collectable, snapshotSource: isLocked ? "live_legacy" : "live", payStats };
}

// ── 확정 스냅샷 → 회차 상세(§10·§11) ─────────────────────────────────────────
//  · 확정 당시 payout_round_items 에 동결된 건별 정산값을 지급대상별로 재집계.
//    aggregate()/computeTotals() 와 동일한 응답 형태로 구성(프론트 렌더 불변, API shape 보존).
//  · 원본 performance_assignments 를 다시 읽지 않으므로 확정 후 원본 수정에 영향받지 않는다.
function snapRowToItem(round: any, r: any, paymentStatus: string, payeeEmail: string | null = null) {
  const isIndiv = r.payeeType === "individual";
  const unconfirmed = isIndiv && (!r.withholdingTreatment || r.withholdingTreatment === "tax_review_required");
  return {
    id: r.performanceAssignmentId,
    projectId: r.projectId, quoteId: r.quoteId, quoteNumber: r.quoteNumber,
    customerName: r.customerName, projectTitle: r.projectTitle,
    performerCategory: r.payeeType, payeeType: r.payeeType,
    individualUserId: isIndiv ? r.payeeId : null,
    vendorCompanyId: r.payeeType === "vendor" ? r.payeeId : null,
    performerName: r.payeeName,
    payeeEmail,   // 동명이인 식별용 표시정보(스냅샷 미보존 → payeeId 기준 실시간 조회값). 정산 계산과 무관.
    serviceType: r.serviceType, productName: r.productName,
    deliveryDate: r.deliveryDate, expectedPaymentDate: r.paymentDate,
    performanceStartDate: r.performanceStartDate, performanceEndDate: r.performanceEndDate,
    quantity: r.quantity, unit: r.unit, contractUnitPrice: r.contractUnitPrice,
    isDirectAmount: r.isDirectAmount, serviceDetail: r.serviceDetail,
    basePerformanceFee: r.basePerformanceFee, expenseTotal: r.expenseTotal, deductionTotal: r.deductionTotal,
    costTotal: r.grossAmount,
    withholdingTreatment: r.withholdingTreatment, withholdingRate: r.withholdingRate,
    purchaseEvidenceType: r.purchaseEvidenceType,
    // 건별 실제 지급상태(원본 performance_assignments 기준) — 부분 지급완료 표시·선택 처리에 사용.
    paymentStatus,
    remark: r.remark,
    payoutRoundId: r.payoutRoundId, roundBatchNumber: round.batchNumber,
    roundPaymentDate: round.paymentDate, roundStatus: round.status,
    expenses: Array.isArray(r.expenses) ? r.expenses : [],
    deductions: Array.isArray(r.deductions) ? r.deductions : [],
    // 확정 당시 동결 세금·지급액(재계산 없음)
    gross: num(r.grossAmount), withholdingTax: num(r.withholdingAmount),
    vat: num(r.vatAmount), netPayment: num(r.netAmount),
    rate: r.withholdingRate != null ? num(r.withholdingRate) : 0,
    rateConfirmed: !unconfirmed, isVatIncluded: !!r.vatIncluded,
  };
}
async function loadRoundDetailFromSnapshot(round: any) {
  const rows = await db.select().from(payoutRoundItemsTable)
    .where(eq(payoutRoundItemsTable.payoutRoundId, round.id))
    .orderBy(payoutRoundItemsTable.payeeType, payoutRoundItemsTable.payeeId, payoutRoundItemsTable.performanceAssignmentId);
  if (!rows.length) return null;   // 스냅샷 미보존(레거시) → 상위에서 폴백 처리
  // 건별 실제 지급상태 조회(부분 지급완료 표시·선택 처리용). 스냅샷 금액은 그대로 두고 상태만 최신 반영.
  const ids = rows.map((r) => r.performanceAssignmentId);
  const payRows = await db.select({ id: performanceAssignmentsTable.id, ps: performanceAssignmentsTable.paymentStatus })
    .from(performanceAssignmentsTable).where(inArray(performanceAssignmentsTable.id, ids));
  const payMap = new Map(payRows.map((p) => [p.id, p.ps as string]));
  const defaultPs = round.status === "paid" ? "paid" : "unpaid";
  // 지급대상 이메일(표시정보) — 스냅샷은 이메일을 동결하지 않으므로 payeeId 기준으로 실시간 조회(개인=users / 외주=companies).
  //  · 확정 금액·명세 동결값은 그대로 두고 식별용 이메일만 최신값을 붙인다. 미등록·미확인이면 null → '-'.
  const emailMap = new Map<string, string | null>();
  const indivIds = [...new Set(rows.filter((r) => r.payeeType === "individual" && r.payeeId != null).map((r) => r.payeeId as number))];
  const vendorIds = [...new Set(rows.filter((r) => r.payeeType === "vendor" && r.payeeId != null).map((r) => r.payeeId as number))];
  const [indivRows, vendorRows] = await Promise.all([
    indivIds.length ? db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, indivIds)) : Promise.resolve([]),
    vendorIds.length ? db.select({ id: companiesTable.id, email: companiesTable.email }).from(companiesTable).where(inArray(companiesTable.id, vendorIds)) : Promise.resolve([]),
  ]);
  for (const u of indivRows) emailMap.set(`individual:${u.id}`, u.email ?? null);
  for (const c of vendorRows) emailMap.set(`vendor:${c.id}`, c.email ?? null);
  const emailOf = (r: any) => (r.payeeId != null ? emailMap.get(`${r.payeeType}:${r.payeeId}`) ?? null : null);
  const groups = new Map<string, any>();
  for (const r of rows) {
    const isIndiv = r.payeeType === "individual";
    const key = `${isIndiv ? "i" : "v"}:${r.payeeId ?? "none"}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        payeeKey: key, payeeType: isIndiv ? "individual" : "vendor", payeeId: r.payeeId ?? null,
        payeeName: r.payeeName || "(미지정)",
        payeeEmail: emailOf(r),
        count: 0, translationCount: 0, interpretationCount: 0, equipmentEtcCount: 0,
        baseTotal: 0, expenseTotal: 0, deductionTotal: 0, grossTotal: 0, withholdingTotal: 0, vatTotal: 0, netTotal: 0,
        treatments: new Set<string>(), rateUnconfirmed: false, allVat: true, items: [] as any[],
      };
      groups.set(key, g);
    }
    g.count += 1;
    if (r.serviceType === "translation") g.translationCount += 1;
    else if (r.serviceType === "interpretation") g.interpretationCount += 1;
    else g.equipmentEtcCount += 1;
    g.baseTotal += num(r.basePerformanceFee);
    g.expenseTotal += num(r.expenseTotal);
    g.deductionTotal += num(r.deductionTotal);
    g.grossTotal += num(r.grossAmount);
    g.withholdingTotal += num(r.withholdingAmount);
    g.vatTotal += num(r.vatAmount);
    g.netTotal += num(r.netAmount);
    if (isIndiv && r.withholdingTreatment) g.treatments.add(r.withholdingTreatment);
    if (isIndiv && (!r.withholdingTreatment || r.withholdingTreatment === "tax_review_required")) g.rateUnconfirmed = true;
    if (!r.vatIncluded) g.allVat = false;
    g.items.push(snapRowToItem(round, r, payMap.get(r.performanceAssignmentId) ?? defaultPs, emailOf(r)));
  }
  const summary = Array.from(groups.values()).map((g) => ({
    ...g,
    treatments: Array.from(g.treatments),
    mixedTreatment: g.treatments.size > 1,
    isVatIncluded: g.payeeType === "vendor" && g.items.length > 0 && g.allVat,
  }));
  const totals = computeTotals(summary);
  // 확정 회차는 잠금 — 경고/재포함 대상 없음(원본 기준 수집로직 미적용).
  return { round, summary, totals, warnings: { total: 0, holdAmount: 0, byReason: [] }, collectable: [], snapshotSource: "snapshot", payStats: payStatsOf(rows.map((r) => payMap.get(r.performanceAssignmentId) ?? defaultPs)) };
}

// 회차 내 건별 지급상태 집계 — 부분 지급완료 표시(§6)·상태 파생용.
function payStatsOf(statuses: string[]) {
  let paid = 0, hold = 0;
  for (const s of statuses) { if (s === "paid") paid++; else if (s === "payment_hold") hold++; }
  return { paid, hold, unpaid: statuses.length - paid - hold, total: statuses.length };
}

// 제외·확인 필요 목록(§8) — 대상기간 내 지급대상(개인/외주)이지만 수집조건을 못 채운 건을 사유별 분류.
//  · 이미 이 회차에 포함된 건은 제외. 이미 다른 회차 포함 건은 별도 사유로 표기.
async function loadWarnings(round: any) {
  if (!round.periodStart || !round.periodEnd) return { total: 0, holdAmount: 0, byReason: [] as any[] };
  const basis = round.collectionBasis || DEFAULT_COLLECTION_BASIS;
  const rows = await db
    .select({
      id: performanceAssignmentsTable.id,
      projectId: performanceAssignmentsTable.projectId,
      performerCategory: performanceAssignmentsTable.performerCategory,
      performerName: performanceAssignmentsTable.performerNameSnapshot,
      individualUserId: performanceAssignmentsTable.individualUserId,
      vendorCompanyId: performanceAssignmentsTable.vendorCompanyId,
      deliveryDate: performanceAssignmentsTable.deliveryDate,
      deliveryConfirmed: performanceAssignmentsTable.deliveryConfirmed,
      costTotal: performanceAssignmentsTable.costTotal,
      withholdingTreatment: performanceAssignmentsTable.withholdingTreatment,
      paymentStatus: performanceAssignmentsTable.paymentStatus,
      payoutRoundId: performanceAssignmentsTable.payoutRoundId,
      payoutHoldReason: performanceAssignmentsTable.payoutHoldReason,
      productName: performanceAssignmentsTable.productNameSnapshot,
    })
    .from(performanceAssignmentsTable)
    .where(and(
      isNull(performanceAssignmentsTable.deletedAt),
      // 지급대상(개인/외주) 후보만 — 경비(expense)는 지급대상 아님
      sql`${performanceAssignmentsTable.performerCategory} IN ('individual','vendor')`,
      sql`${basisExpr(basis)} >= ${round.periodStart}`,
      sql`${basisExpr(basis)} <= ${round.periodEnd}`,
      // 이 회차에 이미 포함된 건 제외
      sql`(${performanceAssignmentsTable.payoutRoundId} IS NULL OR ${performanceAssignmentsTable.payoutRoundId} <> ${round.id})`,
      // 지급완료 건은 경고 대상 아님
      ne(performanceAssignmentsTable.paymentStatus, "paid"),
    ));

  const buckets: Record<string, any[]> = {};
  const push = (reason: string, r: any) => { (buckets[reason] ??= []).push({ id: r.id, projectId: r.projectId, performerName: r.performerName, productName: r.productName, costTotal: num(r.costTotal), reason }); };
  let holdAmount = 0;
  for (const r of rows) {
    if (r.payoutRoundId != null && r.payoutRoundId !== round.id) { push("이미 다른 회차에 포함됨", r); continue; }
    if (r.paymentStatus === "payment_hold") { push("지급보류", r); holdAmount += num(r.costTotal); continue; }
    const hasPayee = (r.performerCategory === "individual" && r.individualUserId != null) || (r.performerCategory === "vendor" && r.vendorCompanyId != null);
    if (!hasPayee) { push("수행자 미지정", r); continue; }
    if (!r.deliveryDate) { push("납품일 미입력", r); continue; }
    if (!r.deliveryConfirmed) { push("납품확인 미완료", r); continue; }
    if (num(r.costTotal) <= 0) { push("지급액 0원", r); continue; }
    if (r.performerCategory === "individual" && !r.withholdingTreatment) { push("세금처리 미선택", r); continue; }
    // 위 조건을 모두 통과했는데도 이 회차에 없는 건 = 미수집(예: 저장 전 제외 처리) → 별도 표기
  }
  const byReason = Object.entries(buckets).map(([reason, items]) => ({ reason, count: items.length, items }));
  const total = byReason.reduce((s, b) => s + b.count, 0);
  return { total, holdAmount, byReason };
}

// 스냅샷 총계 저장(§14·§15) — 목록 표시용. 상세는 상태에 따라 실시간/스냅샷 조회.
async function saveSnapshot(round: any) {
  const { totals } = await loadRoundDetail(round);
  await db.update(payoutRoundsTable).set({
    totalAssignments: totals.assignments, totalPayees: totals.payees,
    grossAmount: String(totals.grossTotal), deductionAmount: String(totals.withholdingTotal), netAmount: String(totals.netTotal),
    updatedAt: new Date(),
  }).where(eq(payoutRoundsTable.id, round.id));
}

// ── 건별 확정 스냅샷 저장(§10·§11) — 지급확정 시점의 건별 정산정보를 payout_round_items 에 동결 ──
//   · 지급확정 당시 실시간 집계(aggregate) 결과를 그대로 저장 → 이후 원본 수정과 무관하게 보존.
//   · 재확정/재호출 시 정합을 위해 해당 회차 기존 스냅샷을 삭제 후 재삽입(멱등).
function snapshotRowsFromSummary(roundId: number, summary: any[], confirmedAt: Date) {
  const rows: any[] = [];
  for (const g of summary) {
    for (const it of g.items) {
      rows.push({
        payoutRoundId: roundId,
        performanceAssignmentId: it.id,
        payeeType: g.payeeType, payeeId: g.payeeId ?? null, payeeName: g.payeeName ?? it.performerName ?? null,
        projectId: it.projectId ?? null, projectTitle: it.projectTitle ?? null,
        quoteId: it.quoteId ?? null, quoteNumber: it.quoteNumber ?? null, customerName: it.customerName ?? null,
        serviceType: it.serviceType ?? null, productName: it.productName ?? null,
        performanceStartDate: it.performanceStartDate ?? null, performanceEndDate: it.performanceEndDate ?? null,
        deliveryDate: it.deliveryDate ?? null, paymentDate: it.expectedPaymentDate ?? null,
        quantity: it.quantity != null ? String(it.quantity) : null, unit: it.unit ?? null,
        contractUnitPrice: it.contractUnitPrice != null ? String(it.contractUnitPrice) : null,
        isDirectAmount: it.isDirectAmount ?? null,
        serviceDetail: it.serviceDetail ?? null,
        basePerformanceFee: String(num(it.basePerformanceFee)),
        expenseTotal: String(num(it.expenseTotal)),
        deductionTotal: String(num(it.deductionTotal)),
        grossAmount: String(num(it.gross)),
        withholdingTreatment: it.withholdingTreatment ?? null,
        withholdingRate: it.rateConfirmed ? String(num(it.rate)) : (it.withholdingRate != null ? String(it.withholdingRate) : null),
        withholdingAmount: String(num(it.withholdingTax)),
        purchaseEvidenceType: it.purchaseEvidenceType ?? null,
        vatIncluded: !!it.isVatIncluded, vatAmount: String(num(it.vat)),
        netAmount: String(num(it.netPayment)),
        expenses: Array.isArray(it.expenses) ? it.expenses : [],
        deductions: Array.isArray(it.deductions) ? it.deductions : [],
        remark: it.remark ?? null,
        confirmedAt,
      });
    }
  }
  return rows;
}
async function saveItemSnapshots(round: any, confirmedAt: Date) {
  const items = await loadRoundItems(round.id);   // 확정 시점 원본(실시간) 기준
  const summary = aggregate(items);
  const rows = snapshotRowsFromSummary(round.id, summary, confirmedAt);
  await db.delete(payoutRoundItemsTable).where(eq(payoutRoundItemsTable.payoutRoundId, round.id));
  if (rows.length) await db.insert(payoutRoundItemsTable).values(rows);
  return rows.length;
}

// ── 지급일 기준 미배정 → 기존 지급회차 자동배정 ──────────────────────────────
//  · 트리거: 수행정보 저장(지급일 입력·변경 포함). 저장 직후 이 프로젝트의 미배정 건을 점검.
//  · 매칭: 수행건 지급일(expectedPaymentDate) == 지급회차 지급예정일(paymentDate),
//    그리고 회차가 "지급확정 전(draft·reviewing)" 인 경우에만 배정.
//  · 대상: 미배정(payoutRoundId IS NULL) + 지급대상 자격충족(eligibleConds) 건만(회차 수집기준과 동일).
//  · 안전장치:
//     - 지급확정(confirmed)·지급완료(paid) 회차에는 자동 편입하지 않는다 → 미배정 유지(§5).
//       (confirmed/paid 회차는 후보 조회에서 제외되므로 스냅샷·지급완료 데이터 불변, §6)
//     - 이미 다른 회차에 배정된 건은 이동하지 않는다(payoutRoundId IS NULL 조건, §4).
//  · 배정된 draft 회차의 목록 스냅샷 총계를 갱신해 정산 목록 화면에 즉시 반영(§3). 상세는 항상 실시간.
export async function autoAssignByPaymentDate(projectId: number) {
  // 1) 미배정·자격충족·지급일 입력 건(회차 수집기준 eligibleConds 재사용 — 일관성)
  const candidates = await db
    .select({ id: performanceAssignmentsTable.id, pay: performanceAssignmentsTable.expectedPaymentDate })
    .from(performanceAssignmentsTable)
    .where(and(
      eq(performanceAssignmentsTable.projectId, projectId),
      isNull(performanceAssignmentsTable.payoutRoundId),
      isNotNull(performanceAssignmentsTable.expectedPaymentDate),
      ...eligibleConds(),
    ));
  if (!candidates.length) return { assigned: 0, rounds: [] as number[] };

  // 2) 해당 지급일들과 "지급예정일이 일치"하는 지급확정 전(draft·reviewing) 회차만 후보로.
  //    confirmed·paid·cancelled 회차는 제외 → 확정 스냅샷/지급완료 데이터 불변(§5·§6).
  const dates = Array.from(new Set(candidates.map(c => String(c.pay))));
  const rounds = await db
    .select({ id: payoutRoundsTable.id, paymentDate: payoutRoundsTable.paymentDate })
    .from(payoutRoundsTable)
    .where(and(
      inArray(payoutRoundsTable.paymentDate, dates),
      inArray(payoutRoundsTable.status, ["draft", "reviewing"]),
    ));
  if (!rounds.length) return { assigned: 0, rounds: [] };
  const byDate = new Map(rounds.map(r => [String(r.paymentDate), r.id]));

  // 3) 지급일이 일치하는 미배정 건만 배정(이중 안전: payoutRoundId IS NULL 재확인 → 배정 건 이동 금지).
  const affected = new Set<number>();
  let assigned = 0;
  for (const c of candidates) {
    const rid = byDate.get(String(c.pay));
    if (!rid) continue;   // 매칭 draft 회차 없음(또는 확정/완료뿐) → 미배정 유지
    await db.update(performanceAssignmentsTable)
      .set({ payoutRoundId: rid, updatedAt: new Date() })
      .where(and(
        eq(performanceAssignmentsTable.id, c.id),
        isNull(performanceAssignmentsTable.payoutRoundId),
      ));
    assigned++; affected.add(rid);
  }

  // 4) 배정이 발생한 draft 회차의 목록 스냅샷 총계 갱신(목록 화면 즉시 반영). 상세는 실시간이라 자동 반영.
  for (const rid of affected) {
    const [r] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, rid));
    if (r) await saveSnapshot(r);
  }
  return { assigned, rounds: Array.from(affected) };
}

// ── 특정 회차로 미배정 건 편입 — 확정취소 후 재편입용(§확정취소) ─────────────────
//  · 이 회차 지급예정일(paymentDate)과 지급일이 일치하는 미배정·자격충족 건을 이 회차에 편입.
//  · 호출 시점에 회차가 작성중(draft)이어야 함 — 확정/완료 회차엔 사용하지 않는다.
async function assignUnassignedToRound(round: any) {
  const res = await db.update(performanceAssignmentsTable)
    .set({ payoutRoundId: round.id, updatedAt: new Date() })
    .where(and(
      ...eligibleConds(),
      isNull(performanceAssignmentsTable.payoutRoundId),
      eq(performanceAssignmentsTable.expectedPaymentDate, round.paymentDate),
    ))
    .returning({ id: performanceAssignmentsTable.id });
  return { assigned: res.length };
}

// ── GET 목록 ─────────────────────────────────────────────────────────────────
router.get("/admin/payout-rounds", ...adminGuard, async (_req, res) => {
  const rows = await db.select().from(payoutRoundsTable).orderBy(sql`${payoutRoundsTable.paymentDate} DESC`, sql`${payoutRoundsTable.id} DESC`);
  res.json({ rows });
});

const createSchema = z.object({
  batchNumber: z.string().max(100).nullable().optional(),
  paymentDate: z.string().min(1),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  collectionBasis: z.enum(["expected_payment_date", "delivery_date"]).optional(),
  note: z.string().nullable().optional(),
});

// ── POST 생성 + 대상 자동수집(§5~§9) ─────────────────────────────────────────
router.post("/admin/payout-rounds", ...adminGuard, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const { paymentDate, periodStart, periodEnd, collectionBasis = DEFAULT_COLLECTION_BASIS, note } = parsed.data;
  const batchNumber = parsed.data.batchNumber || `${paymentDate} 지급회차`;
  const userId = req.user?.id ?? null;
  try {
    // 동일 지급일 중복 생성 방지 — 진행 중(draft·reviewing·confirmed) 회차가 이미 있으면
    // 새로 만들지 않고 기존 회차를 그대로 반환한다(duplicate=true). (취소·지급완료건은 제외)
    const [dup] = await db.select().from(payoutRoundsTable)
      .where(and(
        eq(payoutRoundsTable.paymentDate, paymentDate),
        inArray(payoutRoundsTable.status, ["draft", "reviewing", "confirmed"]),
      ))
      .limit(1);
    if (dup) {
      const existing = await loadRoundDetail(dup);
      res.status(200).json({ ...existing, duplicate: true });
      return;
    }
    const [round] = await db.insert(payoutRoundsTable).values({
      batchNumber, paymentDate, periodStart, periodEnd, collectionBasis, note: note ?? null,
      status: "draft", createdBy: userId,
    }).returning();
    // 자동수집 — 조건 충족 + 미배정 건에 이 회차 배정(중복수집 방지: payoutRoundId IS NULL).
    //   payeeType은 저장 시 performerCategory와 동일하게 이미 세팅됨(집계는 performerCategory로 폴백).
    await db.update(performanceAssignmentsTable)
      .set({ payoutRoundId: round.id, updatedAt: new Date() })
      .where(collectWhere(periodStart, periodEnd, collectionBasis));
    await saveSnapshot(round);
    const detail = await loadRoundDetail(round);
    res.status(201).json(detail);
  } catch (err) {
    req.log.error({ err }, "지급회차 생성 실패");
    res.status(500).json({ error: "지급회차 생성 중 오류가 발생했습니다." });
  }
});

// ── GET 전체 지급대상 개요(§1·§2·§13) — 회차 미선택 기본 화면 ────────────────────
//   · 회차·기간과 무관하게 자격충족 미지급 지급대상 전체를 지급대상별로 집계(배정+미배정).
//   · scope=unassigned 이면 미배정(payoutRoundId IS NULL) 건만.
//   · 지급완료 건은 제외(eligibleConds, §10). 집계·계산은 회차 상세와 동일 함수 재사용(§11 계산 불변).
//   · 읽기 전용 — payout_round_id·상태·원본 데이터를 일절 변경하지 않는다(§15).
//   · 반드시 GET /:id 보다 위에 정의(라우팅 충돌 방지: "overview"가 :id로 잡히지 않도록).
router.get("/admin/payout-rounds/overview", ...adminGuard, async (req, res) => {
  const unassignedOnly = String(req.query.scope ?? "all") === "unassigned";
  try {
    const items = await attachLineItems(await selectItems(overviewWhere(unassignedOnly)));
    const summary = aggregate(items);
    const totals = computeTotals(summary);
    const unassignedCount = items.filter((it: any) => it.payoutRoundId == null).length;
    // 회차 상세와 동일한 응답 형태(round=null)로 반환해 화면 렌더링을 공용화. 회차 전용 필드는 빈 값.
    res.json({
      round: null,
      overview: { scope: unassignedOnly ? "unassigned" : "all", unassignedCount },
      summary, totals,
      warnings: { total: 0, holdAmount: 0, byReason: [] },
      collectable: [],
    });
  } catch (err) {
    req.log.error({ err }, "전체 지급대상 개요 조회 실패");
    res.status(500).json({ error: "전체 지급대상 조회 중 오류가 발생했습니다." });
  }
});

// ── GET 상세 ─────────────────────────────────────────────────────────────────
router.get("/admin/payout-rounds/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  res.json(await loadRoundDetail(round));
});

const saveSchema = z.object({
  note: z.string().nullable().optional(),
  batchNumber: z.string().max(100).nullable().optional(),
  changes: z.array(z.object({
    assignmentId: z.number().int().positive(),
    action: z.enum(["exclude", "hold", "include", "unhold"]),   // 제외/이월 · 지급보류 · 재포함 · 보류해제
    holdReason: z.string().nullable().optional(),
  })).default([]),
});

// ── PATCH 저장(§12·§13·§15) — 메타 수정 + 건별 제외/보류/재포함 적용 ─────────────
router.patch("/admin/payout-rounds/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  // 확정·지급완료 회차는 관리자(super-admin: roleId 없음)만 수정 가능(§16)
  const isSuperAdmin = req.user?.role === "admin" && !req.user?.roleId;
  if ((round.status === "confirmed" || round.status === "paid") && !isSuperAdmin) {
    res.status(403).json({ error: "확정된 회차는 관리자만 수정할 수 있습니다." }); return;
  }
  const { note, batchNumber, changes } = parsed.data;
  try {
    {
      const meta: any = { updatedAt: new Date() };
      if (note !== undefined) meta.note = note;
      if (batchNumber !== undefined && batchNumber) meta.batchNumber = batchNumber;
      await db.update(payoutRoundsTable).set(meta).where(eq(payoutRoundsTable.id, id));
      for (const c of changes) {
        if (c.action === "exclude") {
          // 이번 회차 제외·다음 회차 이월 — 회차 연결만 해제(데이터·상태 보존)
          await db.update(performanceAssignmentsTable).set({ payoutRoundId: null, updatedAt: new Date() })
            .where(and(eq(performanceAssignmentsTable.id, c.assignmentId), eq(performanceAssignmentsTable.payoutRoundId, id)));
        } else if (c.action === "hold") {
          // 지급보류 — 사유 필수, 회차에서 제외(총액 미포함), 지급상태 보류
          if (!c.holdReason) throw new Error("HOLD_REASON_REQUIRED");
          await db.update(performanceAssignmentsTable)
            .set({ payoutRoundId: null, paymentStatus: "payment_hold", payoutHoldReason: c.holdReason, updatedAt: new Date() })
            .where(and(eq(performanceAssignmentsTable.id, c.assignmentId), eq(performanceAssignmentsTable.payoutRoundId, id)));
        } else if (c.action === "include") {
          // 재포함 — 미배정·미지급 건을 이 회차에 편입(보류였다면 해제)
          await db.update(performanceAssignmentsTable)
            .set({ payoutRoundId: id, paymentStatus: "unpaid", payoutHoldReason: null, updatedAt: new Date() })
            .where(and(eq(performanceAssignmentsTable.id, c.assignmentId), isNull(performanceAssignmentsTable.payoutRoundId), ne(performanceAssignmentsTable.paymentStatus, "paid")));
        } else if (c.action === "unhold") {
          // 지급보류 해제 — 미지급으로 되돌려 다음 지급처리가 가능하도록. 지급보류 건에만 적용(지급완료는 불변).
          await db.update(performanceAssignmentsTable)
            .set({ paymentStatus: "unpaid", payoutHoldReason: null, updatedAt: new Date() })
            .where(and(eq(performanceAssignmentsTable.id, c.assignmentId), eq(performanceAssignmentsTable.paymentStatus, "payment_hold")));
        }
      }
      // 확정·지급완료 회차를 관리자(super-admin)가 직접 수정한 경우(§16) — 건별 스냅샷 정합 유지.
      //   · 제외/보류로 회차에서 빠진 건은 스냅샷 삭제, 재포함 건은 현재값으로 스냅샷 재동결.
      //   · 손대지 않은 건의 확정값은 그대로 보존(전체 재스냅샷 금지). 스냅샷 미보존(레거시) 회차는 건드리지 않는다.
      if (round.status === "confirmed" || round.status === "paid") {
        const hasSnap = await db.select({ id: payoutRoundItemsTable.id }).from(payoutRoundItemsTable)
          .where(eq(payoutRoundItemsTable.payoutRoundId, id)).limit(1);
        if (hasSnap.length) {
          const confAt = round.completedAt ?? new Date();
          for (const c of changes) {
            if (c.action === "exclude" || c.action === "hold") {
              await db.delete(payoutRoundItemsTable).where(and(
                eq(payoutRoundItemsTable.payoutRoundId, id), eq(payoutRoundItemsTable.performanceAssignmentId, c.assignmentId)));
            } else if (c.action === "include") {
              await db.delete(payoutRoundItemsTable).where(and(
                eq(payoutRoundItemsTable.payoutRoundId, id), eq(payoutRoundItemsTable.performanceAssignmentId, c.assignmentId)));
              const one = await attachLineItems(await selectItems(and(
                eq(performanceAssignmentsTable.id, c.assignmentId),
                eq(performanceAssignmentsTable.payoutRoundId, id),
                isNull(performanceAssignmentsTable.deletedAt))));
              const rows = snapshotRowsFromSummary(id, aggregate(one), confAt);
              if (rows.length) await db.insert(payoutRoundItemsTable).values(rows);
            }
          }
        }
      }
    }
    const [updated] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    await saveSnapshot(updated);
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json(await loadRoundDetail(refreshed));
  } catch (err: any) {
    if (err?.message === "HOLD_REASON_REQUIRED") { res.status(400).json({ error: "지급보류 사유를 입력하세요." }); return; }
    req.log.error({ err }, "지급회차 저장 실패");
    res.status(500).json({ error: "지급회차 저장 중 오류가 발생했습니다." });
  }
});

// ── PATCH 재수집(§15-2) — Draft 회차를 현재 기간·조건으로 최신 수행정보와 동기화 ──────
//   전체 동기화(개별 [포함]과 역할 분리). Draft 상태에서만 허용.
//   기존 연결은 유지하되: ①신규 대상 자동 편입 ②연결건 금액변경은 링크 기반 실시간 반영
//   ③지급완료·④지급보류·⑤삭제 건은 회차에서 연결 해제. 새 상태값·컬럼 없이 기존 구조만 사용.
router.patch("/admin/payout-rounds/:id/recollect", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status !== "draft") { res.status(400).json({ error: "작성 중(Draft) 회차만 다시 수집할 수 있습니다." }); return; }
  if (!round.periodStart || !round.periodEnd) { res.status(400).json({ error: "대상기간이 없어 다시 수집할 수 없습니다." }); return; }
  const basis = round.collectionBasis || DEFAULT_COLLECTION_BASIS;
  try {
    const result = await db.transaction(async tx => {
      // before 스냅샷 — 삭제·상태 무관하게 이 회차에 연결된 전체(삭제건 포함) + 금액
      const before = await tx.select({ id: performanceAssignmentsTable.id, costTotal: performanceAssignmentsTable.costTotal })
        .from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.payoutRoundId, id));
      const beforeMap = new Map(before.map(r => [r.id, Number(r.costTotal)]));
      const beforeIds = new Set(before.map(r => r.id));
      // ③④⑤ 더 이상 유효하지 않은 연결 해제: 지급완료·지급보류·삭제
      await tx.update(performanceAssignmentsTable)
        .set({ payoutRoundId: null, updatedAt: new Date() })
        .where(and(
          eq(performanceAssignmentsTable.payoutRoundId, id),
          or(
            isNotNull(performanceAssignmentsTable.deletedAt),
            inArray(performanceAssignmentsTable.paymentStatus, ["paid", "payment_hold"]),
          ),
        ));
      // ① 신규 대상 편입 — collectWhere(미배정·미지급·납품확인·금액>0·지급대상 지정·기간 내)
      await tx.update(performanceAssignmentsTable)
        .set({ payoutRoundId: id, updatedAt: new Date() })
        .where(collectWhere(round.periodStart!, round.periodEnd!, basis));
      // after 스냅샷
      const after = await tx.select({ id: performanceAssignmentsTable.id, costTotal: performanceAssignmentsTable.costTotal })
        .from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.payoutRoundId, id));
      const afterIds = new Set(after.map(r => r.id));
      const added   = [...afterIds].filter(x => !beforeIds.has(x)).length;
      const removed = [...beforeIds].filter(x => !afterIds.has(x)).length;
      // ② 유지된 연결건 중 금액(costTotal) 변경 건수
      const changed = after.filter(r => beforeMap.has(r.id) && beforeMap.get(r.id) !== Number(r.costTotal)).length;
      return { added, removed, changed };
    });
    await saveSnapshot(round);
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    const detail = await loadRoundDetail(refreshed);
    res.json({ ...detail, recollect: result });
  } catch (err) {
    req.log.error({ err }, "지급대상 재수집 실패");
    res.status(500).json({ error: "지급대상 재수집 중 오류가 발생했습니다." });
  }
});

// ── PATCH 지급확정(§16) ──────────────────────────────────────────────────────
router.patch("/admin/payout-rounds/:id/confirm", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status === "confirmed" || round.status === "paid") { res.status(400).json({ error: "이미 확정된 회차입니다." }); return; }
  try {
    const confirmedAt = new Date();
    // 확정 전(draft/reviewing) 실시간 기준으로 회차 총계 + 건별 스냅샷을 동시에 동결(§10·§11).
    await saveSnapshot(round);
    await saveItemSnapshots(round, confirmedAt);
    await db.update(payoutRoundsTable).set({ status: "confirmed", completedBy: req.user?.id ?? null, completedAt: confirmedAt, updatedAt: confirmedAt }).where(eq(payoutRoundsTable.id, id));
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json(await loadRoundDetail(refreshed));
  } catch (err) {
    req.log.error({ err }, "지급확정 실패");
    res.status(500).json({ error: "지급확정 중 오류가 발생했습니다." });
  }
});

// ── PATCH 확정취소 — 지급확정(confirmed)을 작성중(draft)으로 되돌림(지급완료 전에만) ──
//  · 지급완료(paid) 회차는 확정취소 불가(회계자료 완전 잠금).
//  · 확정취소 시에만 건별 확정 스냅샷을 해제(삭제)하고, 같은 지급일의 미배정 건을 재편입한 뒤,
//    최신 수행정보 기준으로 회차 총계를 재계산한다. 이후 관리자가 다시 지급확정.
//  · 민감한 회계 상태 전환이므로 super-admin(관리자, roleId 없음)만 허용.
router.patch("/admin/payout-rounds/:id/unconfirm", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const isSuperAdmin = req.user?.role === "admin" && !req.user?.roleId;
  if (!isSuperAdmin) { res.status(403).json({ error: "확정취소는 관리자만 할 수 있습니다." }); return; }
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status === "paid") { res.status(400).json({ error: "지급완료된 회차는 확정취소할 수 없습니다." }); return; }
  if (round.status !== "confirmed") { res.status(400).json({ error: "지급확정된 회차만 확정취소할 수 있습니다." }); return; }
  try {
    // 1) 작성중으로 되돌리고 확정 메타 해제
    await db.update(payoutRoundsTable)
      .set({ status: "draft", completedBy: null, completedAt: null, updatedAt: new Date() })
      .where(eq(payoutRoundsTable.id, id));
    // 2) 확정 스냅샷 잠금 해제 — 확정취소 시에만 해제(§확정취소). 이후 상세는 원본 실시간 기준.
    await db.delete(payoutRoundItemsTable).where(eq(payoutRoundItemsTable.payoutRoundId, id));
    // 3) 같은 지급일의 미배정 건 재편입(최신 수행정보 기준)
    const [draftRound] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    const reassigned = await assignUnassignedToRound(draftRound);
    // 4) 최신 기준 회차 총계 재계산(목록 표시용). 상세는 실시간.
    await saveSnapshot(draftRound);
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json({ ...(await loadRoundDetail(refreshed)), reassigned });
  } catch (err) {
    req.log.error({ err }, "확정취소 실패");
    res.status(500).json({ error: "확정취소 중 오류가 발생했습니다." });
  }
});

// ── PATCH 지급완료(§17) — 확정 회차의 정상 지급대상 payment_status=paid, 회차 status=paid ──
//   · 대상: 이 회차에 연결된 건 중 지급보류(payment_hold)가 아닌 건 → 지급완료(paid).
//   · 지급보류 건은 대상에서 제외(상태 유지). payout_round.status 와 payment_status 는 역할 분리.
//   · 새 상태값·컬럼을 추가하지 않고 기존 enum(paid)만 사용한다.
router.patch("/admin/payout-rounds/:id/pay", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status === "paid") { res.status(400).json({ error: "이미 지급완료된 회차입니다." }); return; }
  if (round.status !== "confirmed") { res.status(400).json({ error: "지급확정된 회차만 지급완료 처리할 수 있습니다." }); return; }
  try {
    await db.update(performanceAssignmentsTable)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(and(
        eq(performanceAssignmentsTable.payoutRoundId, id),
        ne(performanceAssignmentsTable.paymentStatus, "payment_hold"),
      ));
    await db.update(payoutRoundsTable)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(payoutRoundsTable.id, id));
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json(await loadRoundDetail(refreshed));
  } catch (err) {
    req.log.error({ err }, "지급완료 처리 실패");
    res.status(500).json({ error: "지급완료 처리 중 오류가 발생했습니다." });
  }
});

// ── PATCH 선택(건별) 지급완료 — 체크한 건만 지급완료(§건별) ──────────────────────
//   · 대상: 이 회차 소속·미지급(unpaid) 건만. 지급완료(paid)·지급보류(hold)는 제외(§5).
//   · 처리 후 회차 내 미지급이 0이면 회차를 지급완료(paid)로 전환(전체 완료). 아니면 confirmed 유지(부분).
//   · 기존 전체 [지급완료]와 계산·스냅샷 로직 동일 — 상태 전환 조건만 건별 반영.
const itemIdsSchema = z.object({ assignmentIds: z.array(z.number().int().positive()).min(1) });
router.patch("/admin/payout-rounds/:id/pay-items", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = itemIdsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "선택된 건이 없습니다." }); return; }
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status === "paid") { res.status(400).json({ error: "이미 지급완료된 회차입니다." }); return; }
  if (round.status !== "confirmed") { res.status(400).json({ error: "지급확정된 회차만 지급완료 처리할 수 있습니다." }); return; }
  try {
    // 선택 건 중 이 회차 소속·미지급(unpaid)만 지급완료. 이미 지급완료·보류는 자동 제외(§5).
    const done = await db.update(performanceAssignmentsTable)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(and(
        eq(performanceAssignmentsTable.payoutRoundId, id),
        inArray(performanceAssignmentsTable.id, parsed.data.assignmentIds),
        eq(performanceAssignmentsTable.paymentStatus, "unpaid"),
      ))
      .returning({ id: performanceAssignmentsTable.id });
    // 회차 내 미지급(unpaid)이 더 이상 없으면 회차 전체를 지급완료(paid)로 전환(§6 6/6).
    const remainUnpaid = await db.select({ id: performanceAssignmentsTable.id }).from(performanceAssignmentsTable)
      .where(and(eq(performanceAssignmentsTable.payoutRoundId, id), eq(performanceAssignmentsTable.paymentStatus, "unpaid")));
    if (remainUnpaid.length === 0) {
      await db.update(payoutRoundsTable).set({ status: "paid", updatedAt: new Date() }).where(eq(payoutRoundsTable.id, id));
    }
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json({ ...(await loadRoundDetail(refreshed)), paidNow: done.length });
  } catch (err) {
    req.log.error({ err }, "선택 지급완료 실패");
    res.status(500).json({ error: "선택 지급완료 중 오류가 발생했습니다." });
  }
});

// ── PATCH 선택(건별) 확정취소 — 체크한 건만 확정회차에서 제외(§건별·§7) ────────────
//   · 대상: 이 회차 소속·미지급(지급완료 아님) 건만. 지급완료 건은 제외 불가(§5).
//   · 제외 건: payoutRoundId=NULL(미배정 복귀) + 확정 스냅샷 삭제. 남은 건 스냅샷·금액은 그대로 보존.
//   · 남은 확정 스냅샷 기준으로 회차 총계만 재계산. 민감 회계전환이므로 super-admin만 허용.
router.patch("/admin/payout-rounds/:id/unconfirm-items", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const isSuperAdmin = req.user?.role === "admin" && !req.user?.roleId;
  if (!isSuperAdmin) { res.status(403).json({ error: "확정취소는 관리자만 할 수 있습니다." }); return; }
  const parsed = itemIdsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "선택된 건이 없습니다." }); return; }
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status !== "confirmed") { res.status(400).json({ error: "지급확정된 회차의 건만 확정취소할 수 있습니다." }); return; }
  try {
    // 선택 건 중 이 회차 소속·지급완료 아닌 건만 회차에서 제외 → 미배정 복귀(§7). 지급완료 건은 자동 제외(§5).
    const removed = await db.update(performanceAssignmentsTable)
      .set({ payoutRoundId: null, updatedAt: new Date() })
      .where(and(
        eq(performanceAssignmentsTable.payoutRoundId, id),
        inArray(performanceAssignmentsTable.id, parsed.data.assignmentIds),
        ne(performanceAssignmentsTable.paymentStatus, "paid"),
      ))
      .returning({ id: performanceAssignmentsTable.id });
    if (removed.length) {
      // 제외 건의 확정 스냅샷만 삭제(잠금 해제). 남은 건 확정 스냅샷은 그대로 보존(§중요).
      await db.delete(payoutRoundItemsTable).where(and(
        eq(payoutRoundItemsTable.payoutRoundId, id),
        inArray(payoutRoundItemsTable.performanceAssignmentId, removed.map((r) => r.id)),
      ));
      // 남은 확정 스냅샷 기준 회차 총계 재계산(제외분 반영). 남은 건 금액은 확정값 그대로.
      const [r2] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
      await saveSnapshot(r2);
    }
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json({ ...(await loadRoundDetail(refreshed)), removed: removed.length });
  } catch (err) {
    req.log.error({ err }, "선택 확정취소 실패");
    res.status(500).json({ error: "선택 확정취소 중 오류가 발생했습니다." });
  }
});

// ── PATCH 취소 — 회차 연결 해제 후 취소(수집건을 미배정으로 되돌림) ───────────────
router.patch("/admin/payout-rounds/:id/cancel", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status === "paid") { res.status(400).json({ error: "지급완료 회차는 취소할 수 없습니다." }); return; }
  try {
    // 취소 시 3개 작업을 하나의 트랜잭션으로 원자 처리(§동시성): ①수행건 귀속 해제 ②확정 스냅샷 정리 ③회차 상태=cancelled.
    // 확정취소(unconfirm)와 동일하게 payout_round_items 를 삭제한다. 이를 누락하면 취소회차의 고아 스냅샷이
    // 남아, 귀속 해제된 수행건이 신규 회차로 재수집될 때 "취소회차 스냅샷 + 신규회차" 이중집계·이중지급 위험이 생긴다.
    // draft/reviewing 회차는 스냅샷이 없어 delete 는 no-op 이며, paid 회차는 위에서 이미 차단된다. payout_rounds
    // 레코드 자체는 status=cancelled 로 보존되어 감사 이력은 유지된다.
    await db.transaction(async (tx) => {
      await tx.update(performanceAssignmentsTable).set({ payoutRoundId: null, updatedAt: new Date() }).where(eq(performanceAssignmentsTable.payoutRoundId, id));
      await tx.delete(payoutRoundItemsTable).where(eq(payoutRoundItemsTable.payoutRoundId, id));
      await tx.update(payoutRoundsTable).set({ status: "cancelled", totalAssignments: 0, totalPayees: 0, grossAmount: "0", deductionAmount: "0", netAmount: "0", updatedAt: new Date() }).where(eq(payoutRoundsTable.id, id));
    });
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json(await loadRoundDetail(refreshed));
  } catch (err) {
    req.log.error({ err }, "지급회차 취소 실패");
    res.status(500).json({ error: "지급회차 취소 중 오류가 발생했습니다." });
  }
});

export default router;
