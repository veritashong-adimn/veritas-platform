import { Router } from "express";
import { db, prepaidAccountsTable, prepaidLedgerTable, projectsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole, requireStaffPermission } from "../middlewares/auth";
import { getCompanyPrepaidState, confirmApprovedQuoteReservations, getLinkCandidates, linkAndConfirmQuoteReservations, getLinkedAmountByAccount } from "../services/prepaidDeductionQuote";
import { logEvent } from "../lib/logEvent";
import { writeHistory, snap as ledgerSnap } from "../services/prepaidLedger";

const router = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 거래처 가용잔액 (차감 견적 작성용) ──────────────────────────────────────
// GET /api/prepaid/available/:companyId?excludeQuoteId=123
// available = 확정잔액 − 다른 차감 견적의 차감예정액(중복 사용 방지)
router.get("/prepaid/available/:companyId", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.companyId);
  const excludeQuoteId = req.query.excludeQuoteId ? Number(req.query.excludeQuoteId) : null;
  if (!companyId) { res.status(400).json({ error: "companyId가 필요합니다." }); return; }
  try {
    const state = await getCompanyPrepaidState(db, companyId, excludeQuoteId);
    res.json({ companyId, ...state });
  } catch (err) {
    req.log.error({ err }, "Failed to get prepaid available balance");
    res.status(500).json({ error: "가용잔액 조회 실패" });
  }
});

// ─── 거래처별 선입금 잔액 집계 ──────────────────────────────────────────────
// GET /api/prepaid/balance/:companyId
// 모든 active 계정의 잔액을 합산하여 회사 단위 잔액 요약 반환
router.get("/prepaid/balance/:companyId", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!companyId) { res.status(400).json({ error: "companyId가 필요합니다." }); return; }
  try {
    const accounts = await db
      .select({
        id: prepaidAccountsTable.id,
        initialAmount: prepaidAccountsTable.initialAmount,
        currentBalance: prepaidAccountsTable.currentBalance,
        status: prepaidAccountsTable.status,
        note: prepaidAccountsTable.note,
        depositDate: prepaidAccountsTable.depositDate,
        createdAt: prepaidAccountsTable.createdAt,
      })
      .from(prepaidAccountsTable)
      .where(eq(prepaidAccountsTable.companyId, companyId))
      .orderBy(desc(prepaidAccountsTable.createdAt));

    const activeAccounts = accounts.filter(a => a.status === "active");
    const totalInitial = activeAccounts.reduce((s, a) => s + Number(a.initialAmount), 0);
    const totalBalance = activeAccounts.reduce((s, a) => s + Number(a.currentBalance), 0);
    // 기존 입금 연결(판매관리 입금완료 참조)은 신규 입금 누계에 없으므로 사용액 계산에만 더한다
    const linkedMap = await getLinkedAmountByAccount(db, activeAccounts.map(a => a.id));
    const totalLinked = activeAccounts.reduce((s, a) => s + (linkedMap.get(a.id) ?? 0), 0);
    const totalUsed = totalInitial + totalLinked - totalBalance;

    res.json({
      companyId,
      totalInitialAmount: totalInitial,
      totalCurrentBalance: totalBalance,
      totalUsedAmount: totalUsed,
      totalLinkedAmount: totalLinked,
      accountCount: activeAccounts.length,
      accounts: activeAccounts.map(a => ({
        ...a,
        initialAmount: Number(a.initialAmount),
        currentBalance: Number(a.currentBalance),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get prepaid balance");
    res.status(500).json({ error: "잔액 조회 실패" });
  }
});

// ─── 거래처 전체 선입금 거래 내역 ─────────────────────────────────────────────
// GET /api/prepaid/transactions?companyId=...&accountId=...&limit=100
router.get("/prepaid/transactions", ...adminGuard, async (req, res) => {
  const companyId = Number(req.query.companyId);
  const accountId = req.query.accountId ? Number(req.query.accountId) : null;
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  if (!companyId) { res.status(400).json({ error: "companyId가 필요합니다." }); return; }
  try {
    // accountId로 필터링하거나 companyId로 모든 계정의 거래 조회
    const accounts = await db
      .select({ id: prepaidAccountsTable.id })
      .from(prepaidAccountsTable)
      .where(
        accountId
          ? and(eq(prepaidAccountsTable.companyId, companyId), eq(prepaidAccountsTable.id, accountId))
          : eq(prepaidAccountsTable.companyId, companyId)
      );
    const accountIds = accounts.map(a => a.id);
    if (accountIds.length === 0) { res.json([]); return; }

    // 원장 조회 (프로젝트 제목 join)
    const rows = await db
      .select({
        id: prepaidLedgerTable.id,
        accountId: prepaidLedgerTable.accountId,
        projectId: prepaidLedgerTable.projectId,
        quoteId: prepaidLedgerTable.quoteId,
        type: prepaidLedgerTable.type,
        amount: prepaidLedgerTable.amount,
        balanceBefore: prepaidLedgerTable.balanceBefore,
        balanceAfter: prepaidLedgerTable.balanceAfter,
        supplyAmount: prepaidLedgerTable.supplyAmount,
        taxAmount: prepaidLedgerTable.taxAmount,
        description: prepaidLedgerTable.description,
        transactionDate: prepaidLedgerTable.transactionDate,
        createdAt: prepaidLedgerTable.createdAt,
        projectTitle: projectsTable.title,
      })
      .from(prepaidLedgerTable)
      .leftJoin(projectsTable, eq(prepaidLedgerTable.projectId, projectsTable.id))
      // 확정(confirmed) 내역만 노출 — 차감 견적의 예약(reserved)/해제(released)는 원장 화면에서 제외
      .where(and(
        sql`${prepaidLedgerTable.accountId} = ANY(ARRAY[${sql.join(accountIds.map(id => sql`${id}`), sql`, `)}]::integer[])`,
        eq(prepaidLedgerTable.status, "confirmed"),
      ))
      .orderBy(desc(prepaidLedgerTable.createdAt), desc(prepaidLedgerTable.id))
      .limit(limit);

    res.json(rows.map(r => ({
      ...r,
      amount: Number(r.amount),
      balanceBefore: r.balanceBefore != null ? Number(r.balanceBefore) : null,
      balanceAfter: Number(r.balanceAfter),
      supplyAmount: r.supplyAmount != null ? Number(r.supplyAmount) : null,
      taxAmount: r.taxAmount != null ? Number(r.taxAmount) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to get prepaid transactions");
    res.status(500).json({ error: "거래 내역 조회 실패" });
  }
});

// ─── 선입금 입금 (새 계정 생성 또는 기존 계정에 추가 입금) ─────────────────────
// POST /api/prepaid/deposit
// body: { companyId, amount, note?, depositDate?, accountId? }
// accountId 지정 시 해당 계정에 추가 입금, 없으면 새 계정 생성
router.post("/prepaid/deposit", ...adminGuard, async (req, res) => {
  const { companyId, amount, note, depositDate, accountId } = req.body as {
    companyId: number;
    amount: number;
    note?: string;
    depositDate?: string;
    accountId?: number;
  };
  if (!companyId || !amount || amount <= 0) {
    res.status(400).json({ error: "companyId와 amount(>0)가 필요합니다." }); return;
  }
  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = await db.transaction(async tx => {
      let acctId: number;
      let prevBalance = 0;

      if (accountId) {
        // 기존 계정에 추가 입금
        const [acct] = await tx.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, accountId));
        if (!acct || acct.status !== "active") throw new Error("유효하지 않은 계정입니다.");
        prevBalance = Number(acct.currentBalance);
        const newBalance = prevBalance + amount;
        await tx.update(prepaidAccountsTable)
          .set({ currentBalance: String(newBalance) })
          .where(eq(prepaidAccountsTable.id, accountId));
        acctId = accountId;
        const [entry] = await tx.insert(prepaidLedgerTable).values({
          accountId: acctId,
          type: "deposit",
          amount: String(amount),
          balanceBefore: String(prevBalance),
          balanceAfter: String(newBalance),
          description: note ?? "추가 입금",
          transactionDate: depositDate ?? today,
          createdBy: ((req as any).user?.id as number | undefined) ?? null,
        }).returning();
        await writeHistory(tx, { ledgerId: entry.id, accountId: acctId, action: "create", before: null, after: ledgerSnap(entry), actor: (req as any).user ?? null });
        return { account: { id: acctId, currentBalance: newBalance }, entry };
      } else {
        // 새 계정 생성 + 최초 입금 원장 기록
        const [acct] = await tx.insert(prepaidAccountsTable).values({
          companyId,
          initialAmount: String(amount),
          currentBalance: String(amount),
          note: note ?? null,
          depositDate: depositDate ?? today,
        }).returning();
        acctId = acct.id;
        const [entry] = await tx.insert(prepaidLedgerTable).values({
          accountId: acctId,
          type: "deposit",
          amount: String(amount),
          balanceBefore: "0",
          balanceAfter: String(amount),
          description: note ?? "최초 입금",
          transactionDate: depositDate ?? today,
          createdBy: ((req as any).user?.id as number | undefined) ?? null,
        }).returning();
        await writeHistory(tx, { ledgerId: entry.id, accountId: acctId, action: "create", before: null, after: ledgerSnap(entry), actor: (req as any).user ?? null });
        return { account: { id: acctId, currentBalance: amount, isNew: true }, entry };
      }
    });
    res.status(201).json({
      ...result,
      entry: {
        ...result.entry,
        amount: Number(result.entry.amount),
        balanceBefore: Number(result.entry.balanceBefore),
        balanceAfter: Number(result.entry.balanceAfter),
      },
    });
  } catch (err: any) {
    req.log.error({ err }, "Failed to create prepaid deposit");
    res.status(500).json({ error: err?.message ?? "입금 처리 실패" });
  }
});

// ─── 선입금 차감 (잔액 검증 후 원장 기록) ──────────────────────────────────
// POST /api/prepaid/deduct
// body: { accountId, amount, projectId?, quoteId?, supplyAmount?, taxAmount?, description?, transactionDate? }
router.post("/prepaid/deduct", ...adminGuard, async (req, res) => {
  const { accountId, amount, projectId, quoteId, supplyAmount, taxAmount, description, transactionDate } = req.body as {
    accountId: number;
    amount: number;
    projectId?: number;
    quoteId?: number;
    supplyAmount?: number;
    taxAmount?: number;
    description?: string;
    transactionDate?: string;
  };
  if (!accountId || !amount || amount <= 0) {
    res.status(400).json({ error: "accountId와 amount(>0)가 필요합니다." }); return;
  }
  const today = new Date().toISOString().slice(0, 10);
  try {
    const [acct] = await db.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, accountId));
    if (!acct || acct.status !== "active") {
      res.status(400).json({ error: "유효하지 않은 선입금 계정입니다." }); return;
    }
    const prevBalance = Number(acct.currentBalance);
    if (amount > prevBalance) {
      res.status(400).json({
        error: `잔액 부족: 현재 잔액 ${prevBalance.toLocaleString()}원, 차감 요청 ${amount.toLocaleString()}원`,
        currentBalance: prevBalance,
        shortage: amount - prevBalance,
      });
      return;
    }
    const newBalance = prevBalance - amount;

    const result = await db.transaction(async tx => {
      await tx.update(prepaidAccountsTable)
        .set({ currentBalance: String(newBalance) })
        .where(eq(prepaidAccountsTable.id, accountId));
      const [entry] = await tx.insert(prepaidLedgerTable).values({
        accountId,
        projectId: projectId ?? null,
        quoteId: quoteId ?? null,
        type: "deduction",
        amount: String(amount),
        balanceBefore: String(prevBalance),
        balanceAfter: String(newBalance),
        supplyAmount: supplyAmount != null ? String(supplyAmount) : null,
        taxAmount: taxAmount != null ? String(taxAmount) : null,
        description: description ?? "서비스 차감",
        transactionDate: transactionDate ?? today,
        createdBy: ((req as any).user?.id as number | undefined) ?? null,
      }).returning();
      await writeHistory(tx, { ledgerId: entry.id, accountId, action: "create", before: null, after: ledgerSnap(entry), actor: (req as any).user ?? null });
      return entry;
    });
    res.status(201).json({
      ...result,
      amount: Number(result.amount),
      balanceBefore: Number(result.balanceBefore),
      balanceAfter: Number(result.balanceAfter),
      supplyAmount: result.supplyAmount != null ? Number(result.supplyAmount) : null,
      taxAmount: result.taxAmount != null ? Number(result.taxAmount) : null,
      currentBalance: newBalance,
    });
  } catch (err: any) {
    req.log.error({ err }, "Failed to deduct prepaid balance");
    res.status(500).json({ error: err?.message ?? "차감 처리 실패" });
  }
});

// ─── 선입금 계정 상태 변경 (활성/비활성) ────────────────────────────────────
// PATCH /api/prepaid/accounts/:id/status
// ─── 판매확정 차감 견적의 예약 → 확정 반영 (직원 명시 실행) ─────────────────────────────
// POST /api/prepaid/quotes/:quoteId/confirm  { allowDuplicate?: boolean }
//  판매확정 이후 차감 견적으로 바뀐 판매건(과거 CRM 이관 등)은 판매전환 시점의 자동 확정이 다시 일어나지 않는다.
//  같은 규칙(confirmQuoteReservations)으로 확정하되, 자동으로 하지 않고 선입금관리에서 직원이 실행한다.
//  · 멱등: 예약 라인이 없으면 아무것도 바꾸지 않음(already) · 동시 실행: 계정 잠금 후 재조회
//  · 중복 의심(같은 계정·금액·발생일의 확정 입금 존재) → 409 POSSIBLE_DUPLICATE (allowDuplicate=true 로만 진행)
router.post("/prepaid/quotes/:quoteId/confirm", ...adminGuard, requireStaffPermission("prepaid.manage"), async (req, res) => {
  const quoteId = Number(req.params.quoteId);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 ID" }); return; }
  const allowDuplicate = (req.body as { allowDuplicate?: boolean } | undefined)?.allowDuplicate === true;
  try {
    const actorId = ((req as any).user?.id as number | undefined) ?? null;
    const r = await db.transaction(tx => confirmApprovedQuoteReservations(tx, quoteId, { allowDuplicate, actorId }));
    if (r.result === "not_allowed") { res.status(409).json({ error: r.reason, code: "NOT_CONFIRMABLE" }); return; }
    if (r.result === "link_required") {
      res.status(409).json({ error: "판매관리에 이미 입금완료된 같은 금액의 기록이 있습니다. 새 입금으로 반영하지 않고 '기존 입금 연결'로 진행하세요.", code: "LINK_REQUIRED", matches: r.matches });
      return;
    }
    if (r.result === "duplicate") {
      res.status(409).json({ error: "같은 돈이 이미 다른 곳에 기록돼 있을 수 있어 확정을 멈췄습니다. 아래 사유를 확인하세요(기존 기록은 바뀌지 않았습니다).", code: "POSSIBLE_DUPLICATE", matches: r.matches });
      return;
    }
    if (r.result === "nothing") { res.json({ ok: true, already: true }); return; }
    await logEvent("quote", quoteId, "prepaid_reservations_confirmed", req.log, (req as any).user ?? undefined, JSON.stringify({
      accountId: r.accountId, inflow: r.inflow, usageAmount: r.usageAmount, balanceBefore: r.balanceBefore, balanceAfter: r.balanceAfter, allowDuplicate,
    }));
    res.json({ ok: true, already: false, ...r });
  } catch (err) {
    req.log.error({ err }, "Failed to confirm quote prepaid reservations");
    res.status(500).json({ error: "선입금 확정 반영 실패" });
  }
});

// ─── 기존 입금 연결 후보 조회 ─────────────────────────────────────────────────
// GET /api/prepaid/quotes/:quoteId/link-candidates — 견적의 예정 선입/이월 행 + 같은 거래처의 입금완료(원화) 청구회차 후보
router.get("/prepaid/quotes/:quoteId/link-candidates", ...adminGuard, requireStaffPermission("prepaid.manage"), async (req, res) => {
  const quoteId = Number(req.params.quoteId);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 ID" }); return; }
  try { res.json(await getLinkCandidates(db, quoteId)); }
  catch (err) { req.log.error({ err }, "Failed to load link candidates"); res.status(500).json({ error: "기존 입금 후보 조회 실패" }); }
});

// ─── 기존 입금 연결 + 확정 ────────────────────────────────────────────────────
// POST /api/prepaid/quotes/:quoteId/link-confirm { links: [{ ledgerId, paymentId }], reviewNote?, allowDuplicate? }
//  새 입금 없이 예정 선입/이월 행을 판매관리 입금완료 청구회차에 참조 연결하고 차감을 확정한다(한 트랜잭션).
//  관리자 검토가 필요한 후보(일반 판매 배분 입금 · 과거 CRM 사용 이력)는 admin + 검토 사유가 있어야 진행.
router.post("/prepaid/quotes/:quoteId/link-confirm", ...adminGuard, requireStaffPermission("prepaid.manage"), async (req, res) => {
  const quoteId = Number(req.params.quoteId);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 ID" }); return; }
  const body = (req.body ?? {}) as { links?: Array<{ ledgerId: number; paymentId: number }>; reviewNote?: string; allowDuplicate?: boolean };
  const user = (req as any).user as { id: number; email: string; role: string } | undefined;
  try {
    const r = await db.transaction(tx => linkAndConfirmQuoteReservations(tx, quoteId, {
      links: (body.links ?? []).map(l => ({ ledgerId: Number(l.ledgerId), paymentId: Number(l.paymentId) })),
      actorId: user?.id ?? null, isAdmin: user?.role === "admin", reviewNote: body.reviewNote ?? null, allowDuplicate: body.allowDuplicate === true,
    }));
    if (r.result === "not_allowed") { res.status(409).json({ error: r.reason, code: "NOT_CONFIRMABLE" }); return; }
    if (r.result === "blocked") { res.status(409).json({ error: r.reasons.join("\n"), code: r.code, reasons: r.reasons }); return; }
    if (r.result === "duplicate") { res.status(409).json({ error: "같은 돈이 이미 다른 곳에 기록돼 있을 수 있어 확정을 멈췄습니다.", code: "POSSIBLE_DUPLICATE", matches: r.matches }); return; }
    if (r.result === "nothing") { res.json({ ok: true, already: true }); return; }
    await logEvent("quote", quoteId, "prepaid_existing_payment_linked", req.log, user ?? undefined, JSON.stringify({
      accountId: r.accountId, linked: r.linked, usageAmount: r.usageAmount, balanceBefore: r.balanceBefore, balanceAfter: r.balanceAfter,
      reviewNote: body.reviewNote?.trim() || null, allowDuplicate: body.allowDuplicate === true,
    }));
    res.json({ ok: true, already: false, ...r });
  } catch (err: any) {
    // 동시 요청이 같은 청구회차를 먼저 연결한 경우(부분 유니크 인덱스) — 이중 연결 차단
    if (err?.code === "23505" || err?.cause?.code === "23505") { res.status(409).json({ error: "이 입금은 방금 다른 원장 행에 연결되었습니다. 새로고침 후 다시 확인하세요.", code: "ALREADY_LINKED" }); return; }
    req.log.error({ err }, "Failed to link existing payment");
    res.status(500).json({ error: "기존 입금 연결 실패" });
  }
});

router.patch("/prepaid/accounts/:id/status", ...adminGuard, requireStaffPermission("prepaid.manage"), async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body as { status: "active" | "closed" };
  if (!["active", "closed"].includes(status)) {
    res.status(400).json({ error: "status는 active 또는 closed 이어야 합니다." }); return;
  }
  try {
    const [updated] = await db.update(prepaidAccountsTable)
      .set({ status })
      .where(eq(prepaidAccountsTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "계정을 찾을 수 없습니다." }); return; }
    res.json({ ...updated, initialAmount: Number(updated.initialAmount), currentBalance: Number(updated.currentBalance) });
  } catch (err) {
    req.log.error({ err }, "Failed to update prepaid account status");
    res.status(500).json({ error: "상태 변경 실패" });
  }
});

export default router;
