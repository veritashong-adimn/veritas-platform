import { Router, type IRouter } from "express";
import { db, settlementsTable, projectsTable, usersTable, paymentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();

const adminGuard = [requireAuth, requireRole("admin")];

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
        createdAt: settlementsTable.createdAt,
        projectTitle: projectsTable.title,
        translatorEmail: usersTable.email,
      })
      .from(settlementsTable)
      .leftJoin(projectsTable, eq(settlementsTable.projectId, projectsTable.id))
      .leftJoin(usersTable, eq(settlementsTable.translatorId, usersTable.id))
      .orderBy(settlementsTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch settlements");
    res.status(500).json({ error: "정산 목록 조회 실패." });
  }
});

router.patch("/admin/settlements/:id/pay", ...adminGuard, async (req, res) => {
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
    const [updated] = await db
      .update(settlementsTable)
      .set({ status: "paid" })
      .where(eq(settlementsTable.id, settlementId))
      .returning();

    await logEvent("project", settlement.projectId, "settlement_paid", req.log);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to pay settlement");
    res.status(500).json({ error: "정산 완료 처리 실패." });
  }
});

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
