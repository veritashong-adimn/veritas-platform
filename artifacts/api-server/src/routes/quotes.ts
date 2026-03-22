import { Router, type IRouter } from "express";
import { db, quotesTable, projectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.post("/quotes", requireAuth, async (req, res) => {
  const { projectId, price } = req.body as { projectId: unknown; price: unknown };

  if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) {
    res.status(400).json({ error: "projectId는 양의 정수여야 합니다." });
    return;
  }
  if (typeof price !== "number" || price <= 0) {
    res.status(400).json({ error: "price는 양수여야 합니다." });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) {
    res.status(404).json({ error: `Project ${projectId} not found.` });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [quote] = await tx
        .insert(quotesTable)
        .values({ projectId, price: String(price) })
        .returning();
      await tx.update(projectsTable).set({ status: "quoted" }).where(eq(projectsTable.id, projectId));
      return quote;
    });
    await logEvent("quote", result.id, "quote_created", req.log);
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to create quote");
    res.status(400).json({ error: "견적 생성 실패." });
  }
});

router.post("/quotes/:id/approve", async (req, res) => {
  const quoteId = Number(req.params.id);
  if (isNaN(quoteId) || quoteId <= 0) {
    res.status(400).json({ error: "유효하지 않은 quote id." });
    return;
  }

  const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.id, quoteId));
  if (!quote) {
    res.status(404).json({ error: `Quote ${quoteId} not found.` });
    return;
  }
  if (quote.status === "approved") {
    res.status(400).json({ error: "이미 승인된 견적입니다." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(quotesTable)
        .set({ status: "approved" })
        .where(eq(quotesTable.id, quoteId))
        .returning();
      await tx.update(projectsTable).set({ status: "approved" }).where(eq(projectsTable.id, quote.projectId));
      return updated;
    });
    await logEvent("quote", result.id, "quote_approved", req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to approve quote");
    res.status(500).json({ error: "견적 승인 실패." });
  }
});

export default router;
