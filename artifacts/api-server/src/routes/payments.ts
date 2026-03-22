import { Router, type IRouter } from "express";
import { db, paymentsTable, projectsTable, quotesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.post("/payments/request", requireAuth, async (req, res) => {
  const { projectId } = req.body as { projectId?: unknown };

  if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) {
    res.status(400).json({ error: "projectId는 양의 정수여야 합니다." });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) {
    res.status(404).json({ error: `Project ${projectId}를 찾을 수 없습니다.` });
    return;
  }
  if (project.status !== "approved") {
    res.status(400).json({
      error: `결제 요청은 "approved" 상태에서만 가능합니다. 현재: "${project.status}"`,
    });
    return;
  }

  const [quote] = await db
    .select()
    .from(quotesTable)
    .where(eq(quotesTable.projectId, projectId));

  if (!quote) {
    res.status(404).json({ error: "이 프로젝트에 대한 견적이 존재하지 않습니다." });
    return;
  }
  if (quote.status !== "approved") {
    res.status(400).json({ error: "승인된 견적이 있어야 결제를 진행할 수 있습니다." });
    return;
  }

  const existing = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.projectId, projectId));

  const active = existing.find((p) => p.status === "pending" || p.status === "paid");
  if (active) {
    if (active.status === "paid") {
      res.status(400).json({ error: "이미 결제가 완료된 프로젝트입니다." });
      return;
    }
    res.json({ paymentId: active.id, amount: Number(active.amount) });
    return;
  }

  const amount = Number(quote.price);
  const [payment] = await db
    .insert(paymentsTable)
    .values({ projectId, amount: String(amount) })
    .returning();

  await logEvent("project", projectId, "payment_requested", req.log);

  res.status(201).json({ paymentId: payment.id, amount });
});

router.post("/payments/confirm", requireAuth, async (req, res) => {
  const { paymentId, success } = req.body as {
    paymentId?: unknown;
    success?: unknown;
  };

  if (typeof paymentId !== "number" || !Number.isInteger(paymentId) || paymentId <= 0) {
    res.status(400).json({ error: "paymentId는 양의 정수여야 합니다." });
    return;
  }
  if (typeof success !== "boolean") {
    res.status(400).json({ error: "success는 boolean이어야 합니다." });
    return;
  }

  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.id, paymentId));

  if (!payment) {
    res.status(404).json({ error: `Payment ${paymentId}를 찾을 수 없습니다.` });
    return;
  }
  if (payment.status !== "pending") {
    res.status(400).json({ error: `이미 처리된 결제입니다. 현재 상태: "${payment.status}"` });
    return;
  }

  try {
    const newPaymentStatus = success ? ("paid" as const) : ("failed" as const);

    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(paymentsTable)
        .set({ status: newPaymentStatus })
        .where(eq(paymentsTable.id, paymentId))
        .returning();

      if (success) {
        await tx
          .update(projectsTable)
          .set({ status: "paid" })
          .where(eq(projectsTable.id, payment.projectId));
      }

      return updated;
    });

    const action = success ? "payment_paid" : "payment_failed";
    await logEvent("project", payment.projectId, action, req.log);

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to confirm payment");
    res.status(500).json({ error: "결제 처리 실패." });
  }
});

router.get("/payments", async (req, res) => {
  try {
    const { projectId } = req.query as { projectId?: string };
    let query = db.select().from(paymentsTable).$dynamic();
    if (projectId) {
      const id = Number(projectId);
      if (!isNaN(id)) query = query.where(eq(paymentsTable.projectId, id));
    }
    res.json(await query);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch payments");
    res.status(500).json({ error: "결제 조회 실패." });
  }
});

export default router;
