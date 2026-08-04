// ─────────────────────────────────────────────────────────────────────────────
// 지급회차(payout_rounds) API — 정산 Phase 1.
//  · 수행정보(performance_assignments)의 미지급 건을 지급일별 회차로 묶어 지급대상(개인/외주)별 자동합산.
//  · 세전 = costTotal(기본수행료+추가비용−차감), 공제/실지급 = calcPayoutWithholding(§11, 기존 세율·round2 재사용).
//  · payoutRoundId(소프트링크)로 연결. 한 수행건은 한 회차에만 포함(payoutRoundId != null → 중복 미수집·삭제잠금).
//  · Phase 1: 생성→자동수집→합산→검토→제외/보류/이월→저장→지급확정. 실제 지급완료·명세서는 Phase 2.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import {
  db, payoutRoundsTable, performanceAssignmentsTable, projectsTable, companiesTable, quotesTable,
  calcPayoutWithholding,
} from "@workspace/db";
import { eq, and, isNull, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

// 수집기준 날짜 컬럼 — 기본 지급예정일(없으면 납품일 보조 §7), delivery_date 기준 옵션.
const basisExpr = (basis: string) =>
  basis === "delivery_date"
    ? sql`${performanceAssignmentsTable.deliveryDate}`
    : sql`COALESCE(${performanceAssignmentsTable.expectedPaymentDate}, ${performanceAssignmentsTable.deliveryDate})`;

// 자동수집 조건(§7) — 지급대상 지정·납품확인·지급액>0·미지급·미배정·세금처리 선택(개인). 대상기간 내.
const collectWhere = (periodStart: string, periodEnd: string, basis: string) => and(
  isNull(performanceAssignmentsTable.deletedAt),
  isNull(performanceAssignmentsTable.payoutRoundId),
  eq(performanceAssignmentsTable.paymentStatus, "unpaid"),          // 지급완료·지급보류 제외(§7-6·§8)
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
      serviceType: performanceAssignmentsTable.serviceType,
      productName: performanceAssignmentsTable.productNameSnapshot,
      deliveryDate: performanceAssignmentsTable.deliveryDate,
      expectedPaymentDate: performanceAssignmentsTable.expectedPaymentDate,
      basePerformanceFee: performanceAssignmentsTable.basePerformanceFee,
      expenseTotal: performanceAssignmentsTable.expenseTotal,
      deductionTotal: performanceAssignmentsTable.deductionTotal,
      costTotal: performanceAssignmentsTable.costTotal,
      withholdingTreatment: performanceAssignmentsTable.withholdingTreatment,
      withholdingRate: performanceAssignmentsTable.withholdingRate,
      paymentStatus: performanceAssignmentsTable.paymentStatus,
      remark: performanceAssignmentsTable.remark,
    })
    .from(performanceAssignmentsTable)
    .leftJoin(projectsTable, eq(performanceAssignmentsTable.projectId, projectsTable.id))
    .leftJoin(companiesTable, eq(projectsTable.companyId, companiesTable.id))
    .leftJoin(quotesTable, eq(performanceAssignmentsTable.quoteId, quotesTable.id))
    .where(whereClause)
    .orderBy(performanceAssignmentsTable.payeeType, performanceAssignmentsTable.individualUserId, performanceAssignmentsTable.vendorCompanyId, performanceAssignmentsTable.id);
}
// 회차 포함건.
const loadRoundItems = (roundId: number) => selectItems(and(eq(performanceAssignmentsTable.payoutRoundId, roundId), isNull(performanceAssignmentsTable.deletedAt)));
// 재포함 가능건(§5) — 대상기간 내 수집조건 충족 + 미배정(제외/이월된 건 포함).
const loadCollectable = (round: any) => (!round.periodStart || !round.periodEnd)
  ? Promise.resolve([] as any[])
  : selectItems(collectWhere(round.periodStart, round.periodEnd, round.collectionBasis || "expected_payment_date"));

// 지급대상별 자동합산(§9·§10·§11) — 개인=individualUserId, 외주=vendorCompanyId 기준(반드시 고유 ID).
function aggregate(items: any[]) {
  const groups = new Map<string, any>();
  for (const it of items) {
    const isIndiv = it.payeeType === "individual" || it.performerCategory === "individual";
    const payeeId = isIndiv ? it.individualUserId : it.vendorCompanyId;
    const key = `${isIndiv ? "i" : "v"}:${payeeId ?? "none"}`;
    const tax = calcPayoutWithholding(num(it.costTotal), isIndiv ? "individual" : "vendor", it.withholdingTreatment, it.withholdingRate != null ? num(it.withholdingRate) : null);
    let g = groups.get(key);
    if (!g) {
      g = {
        payeeKey: key, payeeType: isIndiv ? "individual" : "vendor", payeeId: payeeId ?? null,
        payeeName: it.performerName || it.customerName || "(미지정)",
        count: 0, translationCount: 0, interpretationCount: 0, equipmentEtcCount: 0,
        baseTotal: 0, expenseTotal: 0, deductionTotal: 0, grossTotal: 0, withholdingTotal: 0, netTotal: 0,
        treatments: new Set<string>(), rateUnconfirmed: false, items: [] as any[],
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
    g.netTotal += tax.net;
    if (isIndiv && it.withholdingTreatment) g.treatments.add(it.withholdingTreatment);
    if (!tax.rateConfirmed) g.rateUnconfirmed = true;
    g.items.push({
      ...it,
      gross: tax.gross, withholdingTax: tax.deduction, netPayment: tax.net,
      rate: tax.rate, rateConfirmed: tax.rateConfirmed,
    });
  }
  return Array.from(groups.values()).map((g) => ({
    ...g,
    treatments: Array.from(g.treatments),
    mixedTreatment: g.treatments.size > 1,   // §11 서로 다른 세금처리 혼재 경고
  }));
}

// 회차 상세 로드 — 지급대상별 요약 + 건별 + 경고(§8) + 총계(§14).
async function loadRoundDetail(round: any) {
  const items = await loadRoundItems(round.id);
  const summary = aggregate(items);
  const totals = summary.reduce((t, g) => ({
    assignments: t.assignments + g.count,
    payees: t.payees + 1,
    individualCount: t.individualCount + (g.payeeType === "individual" ? 1 : 0),
    vendorCount: t.vendorCount + (g.payeeType === "vendor" ? 1 : 0),
    baseTotal: t.baseTotal + g.baseTotal,
    expenseTotal: t.expenseTotal + g.expenseTotal,
    deductionTotal: t.deductionTotal + g.deductionTotal,
    grossTotal: t.grossTotal + g.grossTotal,
    withholdingTotal: t.withholdingTotal + g.withholdingTotal,
    netTotal: t.netTotal + g.netTotal,
  }), { assignments: 0, payees: 0, individualCount: 0, vendorCount: 0, baseTotal: 0, expenseTotal: 0, deductionTotal: 0, grossTotal: 0, withholdingTotal: 0, netTotal: 0 });

  const warnings = await loadWarnings(round);
  // 재포함 가능건(§5) — costTotal 기준 세전, 표시용 요약값만 계산해 전달.
  const collectableRaw = await loadCollectable(round);
  const collectable = collectableRaw.map((it: any) => ({
    id: it.id, payeeType: it.payeeType || it.performerCategory, performerName: it.performerName,
    customerName: it.customerName, productName: it.productName, serviceType: it.serviceType,
    deliveryDate: it.deliveryDate, gross: num(it.costTotal),
  }));
  return { round, summary, totals, warnings, collectable };
}

// 제외·확인 필요 목록(§8) — 대상기간 내 지급대상(개인/외주)이지만 수집조건을 못 채운 건을 사유별 분류.
//  · 이미 이 회차에 포함된 건은 제외. 이미 다른 회차 포함 건은 별도 사유로 표기.
async function loadWarnings(round: any) {
  if (!round.periodStart || !round.periodEnd) return { total: 0, holdAmount: 0, byReason: [] as any[] };
  const basis = round.collectionBasis || "expected_payment_date";
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

// 스냅샷 총계 저장(§14·§15) — 목록 표시용. 상세는 항상 실시간 재계산.
async function saveSnapshot(round: any) {
  const { totals } = await loadRoundDetail(round);
  await db.update(payoutRoundsTable).set({
    totalAssignments: totals.assignments, totalPayees: totals.payees,
    grossAmount: String(totals.grossTotal), deductionAmount: String(totals.withholdingTotal), netAmount: String(totals.netTotal),
    updatedAt: new Date(),
  }).where(eq(payoutRoundsTable.id, round.id));
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
  const { paymentDate, periodStart, periodEnd, collectionBasis = "expected_payment_date", note } = parsed.data;
  const batchNumber = parsed.data.batchNumber || `${paymentDate} 지급회차`;
  const userId = req.user?.id ?? null;
  try {
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
    action: z.enum(["exclude", "hold", "include"]),   // 제외/이월 · 지급보류 · 재포함
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

// ── PATCH 지급확정(§16) ──────────────────────────────────────────────────────
router.patch("/admin/payout-rounds/:id/confirm", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status === "confirmed" || round.status === "paid") { res.status(400).json({ error: "이미 확정된 회차입니다." }); return; }
  try {
    await saveSnapshot(round);
    await db.update(payoutRoundsTable).set({ status: "confirmed", completedBy: req.user?.id ?? null, completedAt: new Date(), updatedAt: new Date() }).where(eq(payoutRoundsTable.id, id));
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json(await loadRoundDetail(refreshed));
  } catch (err) {
    req.log.error({ err }, "지급확정 실패");
    res.status(500).json({ error: "지급확정 중 오류가 발생했습니다." });
  }
});

// ── PATCH 취소 — 회차 연결 해제 후 취소(수집건을 미배정으로 되돌림) ───────────────
router.patch("/admin/payout-rounds/:id/cancel", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
  if (!round) { res.status(404).json({ error: "지급회차를 찾을 수 없습니다." }); return; }
  if (round.status === "paid") { res.status(400).json({ error: "지급완료 회차는 취소할 수 없습니다." }); return; }
  try {
    await db.update(performanceAssignmentsTable).set({ payoutRoundId: null, updatedAt: new Date() }).where(eq(performanceAssignmentsTable.payoutRoundId, id));
    await db.update(payoutRoundsTable).set({ status: "cancelled", totalAssignments: 0, totalPayees: 0, grossAmount: "0", deductionAmount: "0", netAmount: "0", updatedAt: new Date() }).where(eq(payoutRoundsTable.id, id));
    const [refreshed] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, id));
    res.json(await loadRoundDetail(refreshed));
  } catch (err) {
    req.log.error({ err }, "지급회차 취소 실패");
    res.status(500).json({ error: "지급회차 취소 중 오류가 발생했습니다." });
  }
});

export default router;
