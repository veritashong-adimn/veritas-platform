import { Router, type IRouter } from "express";
import { db, settlementsTable, projectsTable, usersTable, paymentsTable, companiesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();

const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ── 정산 목록 ─────────────────────────────────────────────────────────────────
router.get("/admin/settlements", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: settlementsTable.id,
        projectId: settlementsTable.projectId,
        translatorId: settlementsTable.translatorId,
        paymentId: settlementsTable.paymentId,
        totalAmount: settlementsTable.totalAmount,
        translatorAmount: settlementsTable.translatorAmount,
        platformFee: settlementsTable.platformFee,
        status: settlementsTable.status,
        paidDate: settlementsTable.paidDate,
        paymentMemo: settlementsTable.paymentMemo,
        createdAt: settlementsTable.createdAt,
        projectTitle: projectsTable.title,
        translatorEmail: usersTable.email,
        translatorName: usersTable.name,
        companyName: companiesTable.name,
      })
      .from(settlementsTable)
      .leftJoin(projectsTable, eq(settlementsTable.projectId, projectsTable.id))
      .leftJoin(companiesTable, eq(projectsTable.companyId, companiesTable.id))
      .leftJoin(usersTable, eq(settlementsTable.translatorId, usersTable.id))
      .orderBy(settlementsTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch settlements");
    res.status(500).json({ error: "정산 목록 조회 실패." });
  }
});

// ── 단건 지급 완료 처리 ───────────────────────────────────────────────────────
router.patch("/admin/settlements/:id/pay",
  ...adminGuard,
  requirePermission("settlement.pay"),
  async (req, res) => {
    const settlementId = Number(req.params.id);
    if (isNaN(settlementId) || settlementId <= 0) {
      res.status(400).json({ error: "유효하지 않은 settlement id." });
      return;
    }

    const [settlement] = await db
      .select()
      .from(settlementsTable)
      .where(eq(settlementsTable.id, settlementId));

    if (!settlement) {
      res.status(404).json({ error: `Settlement ${settlementId} not found.` });
      return;
    }
    if (settlement.status === "paid") {
      res.status(400).json({ error: "이미 정산 완료된 건입니다." });
      return;
    }
    if (settlement.status !== "ready") {
      res.status(400).json({ error: `정산 완료 처리는 "ready" 상태에서만 가능합니다. 현재: "${settlement.status}"` });
      return;
    }

    try {
      const paymentMemo = typeof req.body?.paymentMemo === "string" ? req.body.paymentMemo.trim() || null : null;

      const [updated] = await db
        .update(settlementsTable)
        .set({ status: "paid", paidDate: new Date(), paymentMemo })
        .where(eq(settlementsTable.id, settlementId))
        .returning();

      await logEvent("project", settlement.projectId, "settlement_paid", req.log);
      res.json(updated);
    } catch (err) {
      req.log.error({ err }, "Failed to pay settlement");
      res.status(500).json({ error: "정산 완료 처리 실패." });
    }
  }
);

// ── 일괄 지급 완료 처리 ───────────────────────────────────────────────────────
router.patch("/admin/settlements/batch-pay",
  ...adminGuard,
  requirePermission("settlement.pay"),
  async (req, res) => {
    const { ids, paymentMemo } = req.body as { ids?: unknown; paymentMemo?: unknown };

    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "ids 배열이 필요합니다." });
      return;
    }

    const validIds = ids.map(Number).filter(n => !isNaN(n) && n > 0);
    if (validIds.length === 0) {
      res.status(400).json({ error: "유효한 id가 없습니다." });
      return;
    }

    const memo = typeof paymentMemo === "string" ? paymentMemo.trim() || null : null;

    try {
      const targets = await db
        .select({ id: settlementsTable.id, projectId: settlementsTable.projectId, status: settlementsTable.status })
        .from(settlementsTable)
        .where(inArray(settlementsTable.id, validIds));

      const readyIds = targets.filter(t => t.status === "ready").map(t => t.id);

      if (readyIds.length === 0) {
        res.status(400).json({ error: "지급 처리 가능한(ready 상태) 정산 건이 없습니다." });
        return;
      }

      const updated = await db
        .update(settlementsTable)
        .set({ status: "paid", paidDate: new Date(), paymentMemo: memo })
        .where(inArray(settlementsTable.id, readyIds))
        .returning();

      for (const t of targets.filter(t => readyIds.includes(t.id))) {
        await logEvent("project", t.projectId, "settlement_paid", req.log);
      }

      res.json({ updated: updated.length, skipped: validIds.length - readyIds.length, items: updated });
    } catch (err) {
      req.log.error({ err }, "Failed to batch-pay settlements");
      res.status(500).json({ error: "일괄 정산 처리 실패." });
    }
  }
);

// ── 번역사 본인 정산 내역 ──────────────────────────────────────────────────────
router.get("/settlements/my", requireAuth, requireRole("translator"), async (req, res) => {
  const translatorId = req.user!.id;
  try {
    const rows = await db
      .select({
        id: settlementsTable.id,
        projectId: settlementsTable.projectId,
        totalAmount: settlementsTable.totalAmount,
        translatorAmount: settlementsTable.translatorAmount,
        platformFee: settlementsTable.platformFee,
        status: settlementsTable.status,
        paidDate: settlementsTable.paidDate,
        createdAt: settlementsTable.createdAt,
        projectTitle: projectsTable.title,
      })
      .from(settlementsTable)
      .leftJoin(projectsTable, eq(settlementsTable.projectId, projectsTable.id))
      .where(eq(settlementsTable.translatorId, translatorId))
      .orderBy(settlementsTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Translator: failed to fetch settlements");
    res.status(500).json({ error: "정산 내역 조회 실패." });
  }
});

export default router;
