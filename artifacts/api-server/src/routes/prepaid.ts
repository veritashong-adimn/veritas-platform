import { Router } from "express";
import { db, prepaidAccountsTable, prepaidLedgerTable, projectsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

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
    const totalUsed = totalInitial - totalBalance;

    res.json({
      companyId,
      totalInitialAmount: totalInitial,
      totalCurrentBalance: totalBalance,
      totalUsedAmount: totalUsed,
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
      .where(sql`${prepaidLedgerTable.accountId} = ANY(ARRAY[${sql.join(accountIds.map(id => sql`${id}`), sql`, `)}]::integer[])`)
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
        }).returning();
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
        }).returning();
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
      }).returning();
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
router.patch("/prepaid/accounts/:id/status", ...adminGuard, async (req, res) => {
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
