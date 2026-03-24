import { Router, type IRouter } from "express";
import {
  db, projectsTable, paymentsTable, tasksTable, usersTable,
  logsTable, quotesTable, settlementsTable, notesTable,
} from "@workspace/db";
import { eq, and, ne, ilike, or, gte, lte, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

// ─── 프로젝트 목록 (검색/필터) ────────────────────────────────────────────
router.get("/admin/projects", ...adminGuard, async (req, res) => {
  try {
    const { search, status, dateFrom, dateTo } = req.query as {
      search?: string; status?: string; dateFrom?: string; dateTo?: string;
    };

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

    let result = rows.reverse();

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(p =>
        p.title.toLowerCase().includes(s) ||
        (p.customerEmail ?? "").toLowerCase().includes(s)
      );
    }

    if (status?.trim()) {
      const statuses = status.split(",").map(s => s.trim()).filter(Boolean);
      if (statuses.length > 0) {
        result = result.filter(p => statuses.includes(p.status));
      }
    }

    if (dateFrom?.trim()) {
      const from = new Date(dateFrom);
      if (!isNaN(from.getTime())) {
        result = result.filter(p => new Date(p.createdAt) >= from);
      }
    }

    if (dateTo?.trim()) {
      const to = new Date(dateTo);
      if (!isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        result = result.filter(p => new Date(p.createdAt) <= to);
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch projects");
    res.status(500).json({ error: "프로젝트 조회 실패." });
  }
});

// ─── 프로젝트 상세 ─────────────────────────────────────────────────────────
router.get("/admin/projects/:id", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const [project] = await db
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
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    const [quotes, payments, tasks, settlements, logs] = await Promise.all([
      db.select().from(quotesTable).where(eq(quotesTable.projectId, projectId)),
      db.select().from(paymentsTable).where(eq(paymentsTable.projectId, projectId)),
      db
        .select({
          id: tasksTable.id,
          translatorId: tasksTable.translatorId,
          status: tasksTable.status,
          createdAt: tasksTable.createdAt,
          translatorEmail: usersTable.email,
        })
        .from(tasksTable)
        .leftJoin(usersTable, eq(tasksTable.translatorId, usersTable.id))
        .where(eq(tasksTable.projectId, projectId)),
      db.select().from(settlementsTable).where(eq(settlementsTable.projectId, projectId)),
      db.select().from(logsTable).where(eq(logsTable.entityId, projectId)).orderBy(logsTable.createdAt),
    ]);

    res.json({ ...project, quotes, payments, tasks, settlements, logs });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch project detail");
    res.status(500).json({ error: "프로젝트 상세 조회 실패." });
  }
});

// ─── 프로젝트 상태 수동 변경 ──────────────────────────────────────────────
router.patch("/admin/projects/:id/status", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  const { status } = req.body as { status?: string };

  const ALLOWED = ["created", "quoted", "approved", "paid", "matched", "in_progress", "completed", "cancelled"] as const;
  type AllowedStatus = typeof ALLOWED[number];

  if (!status || !ALLOWED.includes(status as AllowedStatus)) {
    res.status(400).json({ error: `status는 ${ALLOWED.join(", ")} 중 하나여야 합니다.` });
    return;
  }

  try {
    const [updated] = await db
      .update(projectsTable)
      .set({ status: status as AllowedStatus })
      .where(eq(projectsTable.id, projectId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    await logEvent("project", projectId, `admin_status_changed_to_${status}`, req.log);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update project status");
    res.status(500).json({ error: "상태 변경 실패." });
  }
});

// ─── 번역사 재매칭 ─────────────────────────────────────────────────────────
router.post("/admin/projects/:id/rematch", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    const translators = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true)));

    if (translators.length === 0) {
      res.status(404).json({ error: "활성 상태의 번역사가 없습니다." });
      return;
    }

    const randomTranslator = translators[Math.floor(Math.random() * translators.length)];

    const newTask = await db.transaction(async (tx) => {
      await tx.delete(tasksTable).where(eq(tasksTable.projectId, projectId));
      const [task] = await tx
        .insert(tasksTable)
        .values({ projectId, translatorId: randomTranslator.id })
        .returning();
      await tx.update(projectsTable).set({ status: "matched" }).where(eq(projectsTable.id, projectId));
      return task;
    });

    await logEvent("project", projectId, "admin_rematch", req.log);
    res.status(201).json({ task: newTask, translatorEmail: randomTranslator.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to rematch project");
    res.status(500).json({ error: "재매칭 실패." });
  }
});

// ─── 프로젝트 취소 ─────────────────────────────────────────────────────────
router.patch("/admin/projects/:id/cancel", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }
    if (project.status === "cancelled") {
      res.status(400).json({ error: "이미 취소된 프로젝트입니다." });
      return;
    }

    const [updated] = await db
      .update(projectsTable)
      .set({ status: "cancelled" })
      .where(eq(projectsTable.id, projectId))
      .returning();

    await logEvent("project", projectId, "admin_project_cancelled", req.log);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to cancel project");
    res.status(500).json({ error: "프로젝트 취소 실패." });
  }
});

// ─── 결제 목록 ─────────────────────────────────────────────────────────────
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

// ─── 작업 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/tasks", ...adminGuard, async (req, res) => {
  try {
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

// ─── 이벤트 로그 ───────────────────────────────────────────────────────────
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

// ─── 관리자 이메일 변경 ────────────────────────────────────────────────────
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

// ─── 사용자 목록 ───────────────────────────────────────────────────────────
router.get("/admin/users", ...adminGuard, async (req, res) => {
  try {
    const { search, role } = req.query as { search?: string; role?: string };

    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        role: usersTable.role,
        isActive: usersTable.isActive,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt);

    let result = rows.reverse();

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(u => u.email.toLowerCase().includes(s));
    }

    if (role?.trim() && ["customer", "translator", "admin"].includes(role.trim())) {
      result = result.filter(u => u.role === role.trim());
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch users");
    res.status(500).json({ error: "사용자 조회 실패." });
  }
});

// ─── 사용자 역할 변경 ─────────────────────────────────────────────────────
router.patch("/admin/users/:id/role", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  const { role } = req.body as { role?: string };

  if (!role || !["customer", "translator"].includes(role)) {
    res.status(400).json({ error: "role은 'customer' 또는 'translator'만 가능합니다." });
    return;
  }

  if (userId === req.user!.id) {
    res.status(400).json({ error: "본인의 역할은 변경할 수 없습니다." });
    return;
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }
    if (user.role === "admin") {
      res.status(400).json({ error: "관리자 계정의 역할은 변경할 수 없습니다." });
      return;
    }

    const [updated] = await db
      .update(usersTable)
      .set({ role: role as "customer" | "translator" })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive, createdAt: usersTable.createdAt });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update user role");
    res.status(500).json({ error: "역할 변경 실패." });
  }
});

// ─── 사용자 활성화/비활성화 ───────────────────────────────────────────────
router.patch("/admin/users/:id/deactivate", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);

  if (userId === req.user!.id) {
    res.status(400).json({ error: "본인 계정은 비활성화할 수 없습니다." });
    return;
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }

    const newActive = !user.isActive;
    const [updated] = await db
      .update(usersTable)
      .set({ isActive: newActive })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive, createdAt: usersTable.createdAt });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to toggle user active state");
    res.status(500).json({ error: "계정 상태 변경 실패." });
  }
});

// ─── 관리자 메모 ───────────────────────────────────────────────────────────
router.get("/admin/projects/:id/notes", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const rows = await db
      .select({
        id: notesTable.id,
        content: notesTable.content,
        createdAt: notesTable.createdAt,
        adminEmail: usersTable.email,
      })
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
      .where(eq(notesTable.projectId, projectId))
      .orderBy(notesTable.createdAt);

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch notes");
    res.status(500).json({ error: "메모 조회 실패." });
  }
});

router.post("/admin/projects/:id/notes", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  const { content } = req.body as { content?: string };
  if (!content?.trim()) {
    res.status(400).json({ error: "메모 내용을 입력해주세요." });
    return;
  }

  try {
    const [note] = await db
      .insert(notesTable)
      .values({ projectId, adminId: req.user!.id, content: content.trim() })
      .returning();

    res.status(201).json({ ...note, adminEmail: req.user!.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to add note");
    res.status(500).json({ error: "메모 추가 실패." });
  }
});

export default router;
