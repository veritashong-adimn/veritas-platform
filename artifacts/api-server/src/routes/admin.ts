import { Router, type IRouter } from "express";
import { db, projectsTable, paymentsTable, tasksTable, usersTable, logsTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
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

router.patch("/admin/update-email", ...adminGuard, async (req, res) => {
  const { newEmail } = req.body as { newEmail?: string };

  if (!newEmail || typeof newEmail !== "string" || !newEmail.trim()) {
    res.status(400).json({ error: "newEmail은 필수입니다." });
    return;
  }

  const trimmed = newEmail.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    res.status(400).json({ error: "올바른 이메일 형식을 입력해주세요." });
    return;
  }

  const adminId = req.user!.id;

  try {
    const duplicates = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.email, trimmed), ne(usersTable.id, adminId)))
      .limit(1);

    if (duplicates.length > 0) {
      res.status(409).json({ error: "이미 사용 중인 이메일입니다." });
      return;
    }

    const [updated] = await db
      .update(usersTable)
      .set({ email: trimmed })
      .where(eq(usersTable.id, adminId))
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role });

    if (!updated) {
      res.status(404).json({ error: "계정을 찾을 수 없습니다." });
      return;
    }

    res.json({ message: "이메일이 변경되었습니다.", email: updated.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update email");
    res.status(500).json({ error: "이메일 변경 실패." });
  }
});

export default router;
