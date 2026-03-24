import { Router, type IRouter } from "express";
import { db, tasksTable, projectsTable, usersTable, paymentsTable, settlementsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/tasks", async (req, res) => {
  try {
    const { translatorId } = req.query as { translatorId?: string };
    let query = db.select({
      id: tasksTable.id,
      projectId: tasksTable.projectId,
      translatorId: tasksTable.translatorId,
      status: tasksTable.status,
      createdAt: tasksTable.createdAt,
      projectTitle: projectsTable.title,
      projectStatus: projectsTable.status,
    })
    .from(tasksTable)
    .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
    .$dynamic();

    if (translatorId) {
      const id = Number(translatorId);
      if (!isNaN(id)) query = query.where(eq(tasksTable.translatorId, id));
    }
    res.json(await query);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch tasks");
    res.status(500).json({ error: "작업 조회 실패." });
  }
});

router.post(
  "/projects/:id/match",
  requireAuth,
  requireRole("admin", "customer"),
  async (req, res) => {
    const projectId = Number(req.params.id);
    if (isNaN(projectId) || projectId <= 0) {
      res.status(400).json({ error: "유효하지 않은 project id." });
      return;
    }

    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: `Project ${projectId} not found.` });
      return;
    }
    if (project.status !== "paid") {
      res.status(400).json({ error: `매칭하려면 결제가 완료된 "paid" 상태여야 합니다. 현재: "${project.status}"` });
      return;
    }

    const existingTask = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    if (existingTask.length > 0) {
      res.status(400).json({ error: "이미 번역사가 배정된 프로젝트입니다." });
      return;
    }

    const translators = await db.select().from(usersTable).where(eq(usersTable.role, "translator"));
    if (translators.length === 0) {
      res.status(404).json({ error: "등록된 번역사가 없습니다." });
      return;
    }

    const randomTranslator = translators[Math.floor(Math.random() * translators.length)];

    try {
      const result = await db.transaction(async (tx) => {
        const [task] = await tx
          .insert(tasksTable)
          .values({ projectId, translatorId: randomTranslator.id })
          .returning();
        await tx.update(projectsTable).set({ status: "matched" }).where(eq(projectsTable.id, projectId));
        return task;
      });
      await logEvent("project", projectId, "project_matched", req.log);
      res.status(201).json(result);
    } catch (err) {
      req.log.error({ err }, "Failed to match project");
      res.status(500).json({ error: "매칭 실패." });
    }
  },
);

router.patch(
  "/tasks/:id/start",
  requireAuth,
  requireRole("translator", "admin"),
  async (req, res) => {
    const taskId = Number(req.params.id);
    if (isNaN(taskId) || taskId <= 0) {
      res.status(400).json({ error: "유효하지 않은 task id." });
      return;
    }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task) {
      res.status(404).json({ error: `Task ${taskId} not found.` });
      return;
    }
    if (task.status === "working" || task.status === "done") {
      res.status(400).json({ error: `이미 "${task.status}" 상태입니다.` });
      return;
    }
    if (req.user!.role === "translator" && task.translatorId !== req.user!.id) {
      res.status(403).json({ error: "본인에게 배정된 작업만 시작할 수 있습니다." });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(tasksTable).set({ status: "working" })
          .where(eq(tasksTable.id, taskId)).returning();
        await tx.update(projectsTable).set({ status: "in_progress" }).where(eq(projectsTable.id, task.projectId));
        return updated;
      });
      await logEvent("task", taskId, "task_started", req.log);
      res.json(result);
    } catch (err) {
      req.log.error({ err }, "Failed to start task");
      res.status(500).json({ error: "작업 시작 실패." });
    }
  },
);

router.patch(
  "/tasks/:id/complete",
  requireAuth,
  requireRole("translator", "admin"),
  async (req, res) => {
    const taskId = Number(req.params.id);
    if (isNaN(taskId) || taskId <= 0) {
      res.status(400).json({ error: "유효하지 않은 task id." });
      return;
    }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!task) {
      res.status(404).json({ error: `Task ${taskId} not found.` });
      return;
    }
    if (task.status === "done") {
      res.status(400).json({ error: "이미 완료된 작업입니다." });
      return;
    }
    if (task.status !== "working") {
      res.status(400).json({ error: `완료하려면 "working" 상태여야 합니다. 현재: "${task.status}"` });
      return;
    }
    if (req.user!.role === "translator" && task.translatorId !== req.user!.id) {
      res.status(403).json({ error: "본인에게 배정된 작업만 완료할 수 있습니다." });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(tasksTable).set({ status: "done" })
          .where(eq(tasksTable.id, taskId)).returning();
        await tx.update(projectsTable).set({ status: "completed" }).where(eq(projectsTable.id, task.projectId));
        return updated;
      });
      await logEvent("task", taskId, "task_completed", req.log);

      // 정산 자동 생성 (중복 방지)
      const [existing] = await db
        .select()
        .from(settlementsTable)
        .where(eq(settlementsTable.projectId, task.projectId));

      if (!existing) {
        const [payment] = await db
          .select()
          .from(paymentsTable)
          .where(eq(paymentsTable.projectId, task.projectId));

        const total = payment ? Number(payment.amount) : 0;
        const translatorAmount = total * 0.7;
        const platformFee = total * 0.3;

        const [settlement] = await db
          .insert(settlementsTable)
          .values({
            projectId: task.projectId,
            translatorId: task.translatorId,
            paymentId: payment?.id ?? null,
            totalAmount: total.toFixed(2),
            translatorAmount: translatorAmount.toFixed(2),
            platformFee: platformFee.toFixed(2),
            status: "ready",
          })
          .returning();

        await logEvent("project", task.projectId, "settlement_created", req.log);
        req.log.info({ settlementId: settlement.id, projectId: task.projectId }, "Settlement auto-created");
      }

      res.json(result);
    } catch (err) {
      req.log.error({ err }, "Failed to complete task");
      res.status(500).json({ error: "작업 완료 실패." });
    }
  },
);

export default router;
