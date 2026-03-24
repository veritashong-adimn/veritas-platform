import { Router, type IRouter } from "express";
import { db, projectsTable, paymentsTable, tasksTable, usersTable, logsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

const adminGuard = [requireAuth, requireRole("admin")];

router.get("/admin/projects", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        fileUrl: projectsTable.fileUrl,
        createdAt: projectsTable.createdAt,
        customerEmail: usersTable.email,
        customerId: usersTable.id,
      })
      .from(projectsTable)
      .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
      .orderBy(projectsTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch projects");
    res.status(500).json({ error: "프로젝트 조회 실패." });
  }
});

router.get("/admin/payments", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: paymentsTable.id,
        projectId: paymentsTable.projectId,
        amount: paymentsTable.amount,
        status: paymentsTable.status,
        createdAt: paymentsTable.createdAt,
        projectTitle: projectsTable.title,
        projectStatus: projectsTable.status,
      })
      .from(paymentsTable)
      .leftJoin(projectsTable, eq(paymentsTable.projectId, projectsTable.id))
      .orderBy(paymentsTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch payments");
    res.status(500).json({ error: "결제 조회 실패." });
  }
});

router.get("/admin/tasks", ...adminGuard, async (req, res) => {
  try {
    const translatorAlias = usersTable;
    const rows = await db
      .select({
        id: tasksTable.id,
        projectId: tasksTable.projectId,
        translatorId: tasksTable.translatorId,
        status: tasksTable.status,
        createdAt: tasksTable.createdAt,
        projectTitle: projectsTable.title,
        projectStatus: projectsTable.status,
        translatorEmail: usersTable.email,
      })
      .from(tasksTable)
      .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
      .leftJoin(usersTable, eq(tasksTable.translatorId, usersTable.id))
      .orderBy(tasksTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch tasks");
    res.status(500).json({ error: "작업 조회 실패." });
  }
});

router.get("/admin/logs/:projectId", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 projectId." });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(logsTable)
      .where(eq(logsTable.entityId, projectId))
      .orderBy(logsTable.createdAt);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch logs");
    res.status(500).json({ error: "로그 조회 실패." });
  }
});

export default router;
