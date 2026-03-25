import { Router, type IRouter } from "express";
import {
  db, projectsTable, paymentsTable, tasksTable, usersTable,
  logsTable, quotesTable, settlementsTable, notesTable,
  customersTable, communicationsTable, translatorProfilesTable,
  contactsTable, companiesTable, translatorRatesTable,
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, and, ne, ilike, or, gte, lte, inArray, sql, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

// ─── 프로젝트 목록 (검색/필터) ────────────────────────────────────────────
router.get("/admin/projects", ...adminGuard, async (req, res) => {
  try {
    const { search, status, dateFrom, dateTo, assignedAdminId, companyName, contactName } = req.query as {
      search?: string; status?: string; dateFrom?: string; dateTo?: string;
      assignedAdminId?: string; companyName?: string; contactName?: string;
    };

    const contactAlias = db
      .select({ id: contactsTable.id, name: contactsTable.name, companyId: contactsTable.companyId })
      .from(contactsTable)
      .as("proj_contact");

    const companyAlias = db
      .select({ id: companiesTable.id, name: companiesTable.name })
      .from(companiesTable)
      .as("proj_company");

    const rows = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        fileUrl: projectsTable.fileUrl,
        createdAt: projectsTable.createdAt,
        customerEmail: usersTable.email,
        customerId: usersTable.id,
        projectCustomerId: projectsTable.customerId,
        adminId: projectsTable.adminId,
        contactId: projectsTable.contactId,
        companyId: projectsTable.companyId,
        contactName: contactAlias.name,
        companyName: companyAlias.name,
      })
      .from(projectsTable)
      .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
      .leftJoin(contactAlias, eq(projectsTable.contactId, contactAlias.id))
      .leftJoin(companyAlias, eq(projectsTable.companyId, companyAlias.id))
      .orderBy(projectsTable.createdAt);

    let result = rows.reverse();

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(p =>
        p.title.toLowerCase().includes(s) ||
        (p.customerEmail ?? "").toLowerCase().includes(s) ||
        (p.contactName ?? "").toLowerCase().includes(s) ||
        (p.companyName ?? "").toLowerCase().includes(s)
      );
    }

    if (companyName?.trim()) {
      const cn = companyName.trim().toLowerCase();
      result = result.filter(p => (p.companyName ?? "").toLowerCase().includes(cn));
    }

    if (contactName?.trim()) {
      const ct = contactName.trim().toLowerCase();
      result = result.filter(p => (p.contactName ?? "").toLowerCase().includes(ct));
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

    if (assignedAdminId?.trim()) {
      const adminIdNum = Number(assignedAdminId);
      if (!isNaN(adminIdNum)) {
        result = result.filter(p => p.adminId === adminIdNum);
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
    const translatorUserAlias = db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .as("trans_user");

    const [project] = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        fileUrl: projectsTable.fileUrl,
        createdAt: projectsTable.createdAt,
        customerEmail: usersTable.email,
        customerId: usersTable.id,
        contactId: projectsTable.contactId,
        companyId: projectsTable.companyId,
        adminId: projectsTable.adminId,
      })
      .from(projectsTable)
      .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    const [quotes, payments, rawTasks, settlements, logs, notes, communications] = await Promise.all([
      db.select().from(quotesTable).where(eq(quotesTable.projectId, projectId)),
      db.select().from(paymentsTable).where(eq(paymentsTable.projectId, projectId)),
      db
        .select({
          id: tasksTable.id,
          translatorId: tasksTable.translatorId,
          status: tasksTable.status,
          createdAt: tasksTable.createdAt,
          translatorEmail: translatorUserAlias.email,
        })
        .from(tasksTable)
        .leftJoin(translatorUserAlias, eq(tasksTable.translatorId, translatorUserAlias.id))
        .where(eq(tasksTable.projectId, projectId)),
      db.select().from(settlementsTable).where(eq(settlementsTable.projectId, projectId)),
      db.select().from(logsTable).where(eq(logsTable.entityId, projectId)).orderBy(logsTable.createdAt),
      db
        .select({
          id: notesTable.id,
          content: notesTable.content,
          createdAt: notesTable.createdAt,
          adminEmail: usersTable.email,
        })
        .from(notesTable)
        .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
        .where(and(eq(notesTable.entityType, "project"), eq(notesTable.entityId, projectId)))
        .orderBy(notesTable.createdAt),
      db
        .select()
        .from(communicationsTable)
        .where(eq(communicationsTable.projectId, projectId))
        .orderBy(communicationsTable.createdAt),
    ]);

    // 거래처 + 담당자
    let company = null;
    let contact = null;
    if (project.companyId) {
      const [c] = await db.select().from(companiesTable).where(eq(companiesTable.id, project.companyId));
      company = c ?? null;
    }
    if (project.contactId) {
      const [ct] = await db.select().from(contactsTable).where(eq(contactsTable.id, project.contactId));
      contact = ct ?? null;
    }

    // 번역사 프로필 + 단가표
    const tasks = await Promise.all(
      rawTasks.map(async (t) => {
        if (!t.translatorId) return t;
        const [profile] = await db
          .select()
          .from(translatorProfilesTable)
          .where(eq(translatorProfilesTable.userId, t.translatorId));
        const rates = await db
          .select()
          .from(translatorRatesTable)
          .where(eq(translatorRatesTable.translatorId, t.translatorId));
        return { ...t, translatorProfile: profile ?? null, translatorRates: rates };
      }),
    );

    res.json({
      ...project, quotes, payments, tasks, settlements, logs, notes, communications,
      company, contact,
    });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch project detail");
    res.status(500).json({ error: "프로젝트 상세 조회 실패." });
  }
});

// ─── 번역사 매칭 후보 추천 (top-3) ─────────────────────────────────────────
router.get("/admin/projects/:id/match-candidates", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const [project] = await db
      .select({
        companyId: projectsTable.companyId,
        contactId: projectsTable.contactId,
        title: projectsTable.title,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    const translators = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        isActive: usersTable.isActive,
      })
      .from(usersTable)
      .where(and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true)));

    if (translators.length === 0) {
      res.json([]);
      return;
    }

    const translatorIds = translators.map(t => t.id);

    const [profiles, ratesList] = await Promise.all([
      db
        .select()
        .from(translatorProfilesTable)
        .where(inArray(translatorProfilesTable.userId, translatorIds)),
      db
        .select()
        .from(translatorRatesTable)
        .where(inArray(translatorRatesTable.translatorId, translatorIds)),
    ]);

    const profileMap = new Map(profiles.map(p => [p.userId, p]));
    const ratesMap = new Map<number, typeof ratesList>();
    for (const r of ratesList) {
      if (!ratesMap.has(r.translatorId)) ratesMap.set(r.translatorId, []);
      ratesMap.get(r.translatorId)!.push(r);
    }

    const { lp, field } = req.query as { lp?: string; field?: string };

    const scored = translators.map(t => {
      const profile = profileMap.get(t.id) ?? null;
      const rates = ratesMap.get(t.id) ?? [];
      let score = 0;

      if (profile?.availabilityStatus === "available") score += 30;
      else if (profile?.availabilityStatus === "busy") score += 5;

      if (profile?.rating) score += (profile.rating / 5) * 20;

      if (lp && profile?.languagePairs?.toLowerCase().includes(lp.toLowerCase())) score += 25;
      if (field && profile?.specializations?.toLowerCase().includes(field.toLowerCase())) score += 25;
      if (rates.length > 0) score += 5;

      return { id: t.id, email: t.email, profile, rates, score };
    });

    scored.sort((a, b) => b.score - a.score);
    res.json(scored.slice(0, 3));
  } catch (err) {
    req.log.error({ err }, "Admin: failed to get match candidates");
    res.status(500).json({ error: "후보 조회 실패." });
  }
});

// ─── 번역사 직접 배정 ───────────────────────────────────────────────────────
router.post("/admin/projects/:id/assign-translator", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  const { translatorId } = req.body as { translatorId?: number };

  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }
  if (!translatorId || isNaN(translatorId)) {
    res.status(400).json({ error: "translatorId는 필수입니다." });
    return;
  }

  try {
    const [translator] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.id, translatorId), eq(usersTable.role, "translator"), eq(usersTable.isActive, true)));

    if (!translator) {
      res.status(404).json({ error: "해당 번역사를 찾을 수 없습니다." });
      return;
    }

    const newTask = await db.transaction(async (tx) => {
      await tx.delete(tasksTable).where(eq(tasksTable.projectId, projectId));
      const [task] = await tx
        .insert(tasksTable)
        .values({ projectId, translatorId })
        .returning();
      await tx.update(projectsTable).set({ status: "matched" }).where(eq(projectsTable.id, projectId));
      return task;
    });

    await logEvent("project", projectId, `admin_assigned_translator_${translatorId}`, req.log);
    res.status(201).json({ task: newTask, translatorEmail: translator.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to assign translator");
    res.status(500).json({ error: "번역사 배정 실패." });
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

// ─── 관리자 비밀번호 재설정 (개발/운영용) ────────────────────────────────
router.patch("/admin/users/:id/reset-password", ...adminGuard, async (req, res) => {
  const targetId = Number(req.params.id);
  const { newPassword } = req.body as { newPassword?: string };

  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." });
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: "새 비밀번호는 최소 6자 이상이어야 합니다." });
    return;
  }

  try {
    const [target] = await db.select({ id: usersTable.id, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, targetId));
    if (!target) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }
    if (target.role === "admin" && target.id !== req.user!.id) {
      res.status(403).json({ error: "다른 관리자의 비밀번호는 변경할 수 없습니다." });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable).set({ password: hashed }).where(eq(usersTable.id, targetId));
    req.log.info({ adminId: req.user!.id, targetId }, "Admin reset password for user");
    res.json({ ok: true, message: "비밀번호가 재설정되었습니다." });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to reset password");
    res.status(500).json({ error: "비밀번호 재설정 실패." });
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
        entityType: notesTable.entityType,
        entityId: notesTable.entityId,
        content: notesTable.content,
        createdAt: notesTable.createdAt,
        adminEmail: usersTable.email,
      })
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
      .where(and(eq(notesTable.entityType, "project"), eq(notesTable.entityId, projectId)))
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
      .values({ entityType: "project", entityId: projectId, adminId: req.user!.id, content: content.trim() })
      .returning();

    res.status(201).json({ ...note, adminEmail: req.user!.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to add note");
    res.status(500).json({ error: "메모 추가 실패." });
  }
});

// ─── 범용 메모 API (entityType: project/company/contact/translator) ────────────
router.get("/admin/notes", ...adminGuard, async (req, res) => {
  const { entityType, entityId } = req.query as { entityType?: string; entityId?: string };
  if (!entityType || !entityId) {
    res.status(400).json({ error: "entityType과 entityId는 필수입니다." }); return;
  }

  try {
    const rows = await db
      .select({
        id: notesTable.id,
        entityType: notesTable.entityType,
        entityId: notesTable.entityId,
        content: notesTable.content,
        createdAt: notesTable.createdAt,
        adminEmail: usersTable.email,
        adminId: notesTable.adminId,
      })
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
      .where(and(eq(notesTable.entityType, entityType), eq(notesTable.entityId, Number(entityId))))
      .orderBy(desc(notesTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch generic notes");
    res.status(500).json({ error: "메모 조회 실패." });
  }
});

router.post("/admin/notes", ...adminGuard, async (req, res) => {
  const { entityType, entityId, content } = req.body as {
    entityType?: string; entityId?: number; content?: string;
  };

  const validTypes = ["project", "company", "contact", "translator"];
  if (!entityType || !validTypes.includes(entityType)) {
    res.status(400).json({ error: `entityType은 ${validTypes.join("/")} 중 하나여야 합니다.` }); return;
  }
  if (!entityId || isNaN(entityId)) {
    res.status(400).json({ error: "entityId는 필수입니다." }); return;
  }
  if (!content?.trim()) {
    res.status(400).json({ error: "메모 내용을 입력해주세요." }); return;
  }

  try {
    const [note] = await db
      .insert(notesTable)
      .values({ entityType, entityId: Number(entityId), adminId: req.user!.id, content: content.trim() })
      .returning();
    res.status(201).json({ ...note, adminEmail: req.user!.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to add generic note");
    res.status(500).json({ error: "메모 추가 실패." });
  }
});

// ─── 담당자 지정 ────────────────────────────────────────────────────────────
router.patch("/admin/projects/:id/assign", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  const { adminId } = req.body as { adminId: number | null };

  try {
    const [existing] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!existing) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }

    if (adminId !== null && adminId !== undefined) {
      const [admin] = await db.select().from(usersTable)
        .where(and(eq(usersTable.id, adminId), eq(usersTable.role, "admin")));
      if (!admin) { res.status(400).json({ error: "유효한 관리자가 아닙니다." }); return; }
    }

    const [updated] = await db
      .update(projectsTable)
      .set({ adminId: adminId ?? null })
      .where(eq(projectsTable.id, projectId))
      .returning();

    await logEvent("project", projectId, `담당자 ${adminId ? `지정 (adminId=${adminId})` : "해제"}`, req.log);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to assign admin");
    res.status(500).json({ error: "담당자 지정 실패." });
  }
});

// ─── 고객 목록 ──────────────────────────────────────────────────────────────
router.get("/admin/customers", ...adminGuard, async (req, res) => {
  try {
    const { search } = req.query as { search?: string };

    const rows = await db
      .select({
        id: customersTable.id,
        companyName: customersTable.companyName,
        contactName: customersTable.contactName,
        email: customersTable.email,
        phone: customersTable.phone,
        createdAt: customersTable.createdAt,
        projectCount: sql<number>`COUNT(DISTINCT ${projectsTable.id})::int`,
        totalPayment: sql<number>`COALESCE(SUM(${paymentsTable.amount}) FILTER (WHERE ${paymentsTable.status} = 'paid'), 0)::int`,
      })
      .from(customersTable)
      .leftJoin(projectsTable, eq(projectsTable.customerId, customersTable.id))
      .leftJoin(paymentsTable, eq(paymentsTable.projectId, projectsTable.id))
      .groupBy(customersTable.id)
      .orderBy(desc(customersTable.createdAt));

    let result = rows;
    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(c =>
        c.companyName.toLowerCase().includes(s) ||
        c.contactName.toLowerCase().includes(s) ||
        c.email.toLowerCase().includes(s)
      );
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch customers");
    res.status(500).json({ error: "고객 조회 실패." });
  }
});

// ─── 고객 생성 ──────────────────────────────────────────────────────────────
router.post("/admin/customers", ...adminGuard, async (req, res) => {
  const { companyName, contactName, email, phone } = req.body as {
    companyName?: string; contactName?: string; email?: string; phone?: string;
  };

  if (!companyName?.trim() || !contactName?.trim() || !email?.trim()) {
    res.status(400).json({ error: "회사명, 담당자명, 이메일은 필수입니다." });
    return;
  }

  try {
    const [customer] = await db
      .insert(customersTable)
      .values({ companyName: companyName.trim(), contactName: contactName.trim(), email: email.trim(), phone: phone?.trim() })
      .returning();
    res.status(201).json(customer);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to create customer");
    res.status(500).json({ error: "고객 생성 실패." });
  }
});

// ─── 고객 상세 ──────────────────────────────────────────────────────────────
router.get("/admin/customers/:id", ...adminGuard, async (req, res) => {
  const customerId = Number(req.params.id);
  if (isNaN(customerId) || customerId <= 0) {
    res.status(400).json({ error: "유효하지 않은 customer id." });
    return;
  }

  try {
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
    if (!customer) { res.status(404).json({ error: "고객을 찾을 수 없습니다." }); return; }

    const projects = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        createdAt: projectsTable.createdAt,
      })
      .from(projectsTable)
      .where(eq(projectsTable.customerId, customerId))
      .orderBy(desc(projectsTable.createdAt));

    const projectIds = projects.map(p => p.id);

    let totalPayment = 0;
    let totalSettlement = 0;

    if (projectIds.length > 0) {
      const [payRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${paymentsTable.amount}), 0)::int` })
        .from(paymentsTable)
        .where(and(inArray(paymentsTable.projectId, projectIds), eq(paymentsTable.status, "paid")));
      totalPayment = payRow?.total ?? 0;

      const [setRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${settlementsTable.translatorAmount}), 0)::int` })
        .from(settlementsTable)
        .where(inArray(settlementsTable.projectId, projectIds));
      totalSettlement = setRow?.total ?? 0;
    }

    res.json({ ...customer, projects, totalPayment, totalSettlement });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch customer detail");
    res.status(500).json({ error: "고객 상세 조회 실패." });
  }
});

// ─── 고객 수정 ──────────────────────────────────────────────────────────────
router.patch("/admin/customers/:id", ...adminGuard, async (req, res) => {
  const customerId = Number(req.params.id);
  if (isNaN(customerId) || customerId <= 0) {
    res.status(400).json({ error: "유효하지 않은 customer id." }); return;
  }

  const { companyName, contactName, email, phone } = req.body as {
    companyName?: string; contactName?: string; email?: string; phone?: string;
  };

  try {
    const [existing] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
    if (!existing) { res.status(404).json({ error: "고객을 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(customersTable)
      .set({
        companyName: companyName?.trim() ?? existing.companyName,
        contactName: contactName?.trim() ?? existing.contactName,
        email: email?.trim() ?? existing.email,
        phone: phone?.trim() ?? existing.phone,
      })
      .where(eq(customersTable.id, customerId))
      .returning();

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update customer");
    res.status(500).json({ error: "고객 수정 실패." });
  }
});

// ─── 커뮤니케이션 생성 ───────────────────────────────────────────────────────
router.post("/admin/communications", ...adminGuard, async (req, res) => {
  const { customerId, projectId, type, content } = req.body as {
    customerId?: number; projectId?: number; type?: string; content?: string;
  };

  if (!customerId || !content?.trim()) {
    res.status(400).json({ error: "고객 ID와 내용은 필수입니다." }); return;
  }

  const validTypes = ["email", "phone", "message"];
  const commType = validTypes.includes(type ?? "") ? (type as "email" | "phone" | "message") : "message";

  try {
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
    if (!customer) { res.status(404).json({ error: "고객을 찾을 수 없습니다." }); return; }

    const [comm] = await db
      .insert(communicationsTable)
      .values({
        customerId,
        projectId: projectId ?? null,
        type: commType,
        content: content.trim(),
      })
      .returning();

    if (projectId) {
      await logEvent("communication", comm.id, `커뮤니케이션 기록 (type=${commType}, projectId=${projectId})`, req.log);
    }

    res.status(201).json(comm);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to create communication");
    res.status(500).json({ error: "커뮤니케이션 기록 실패." });
  }
});

// ─── 고객별 커뮤니케이션 목록 ─────────────────────────────────────────────
router.get("/admin/customers/:id/communications", ...adminGuard, async (req, res) => {
  const customerId = Number(req.params.id);
  if (isNaN(customerId) || customerId <= 0) {
    res.status(400).json({ error: "유효하지 않은 customer id." }); return;
  }

  try {
    const rows = await db
      .select()
      .from(communicationsTable)
      .where(eq(communicationsTable.customerId, customerId))
      .orderBy(desc(communicationsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch customer communications");
    res.status(500).json({ error: "커뮤니케이션 조회 실패." });
  }
});

// ─── 프로젝트별 커뮤니케이션 목록 ───────────────────────────────────────────
router.get("/admin/projects/:id/communications", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." }); return;
  }

  try {
    const rows = await db
      .select({
        id: communicationsTable.id,
        customerId: communicationsTable.customerId,
        projectId: communicationsTable.projectId,
        type: communicationsTable.type,
        content: communicationsTable.content,
        createdAt: communicationsTable.createdAt,
        companyName: customersTable.companyName,
        contactName: customersTable.contactName,
      })
      .from(communicationsTable)
      .leftJoin(customersTable, eq(communicationsTable.customerId, customersTable.id))
      .where(eq(communicationsTable.projectId, projectId))
      .orderBy(desc(communicationsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch project communications");
    res.status(500).json({ error: "커뮤니케이션 조회 실패." });
  }
});

// ─── 번역사 프로필 조회 ───────────────────────────────────────────────────────
router.get("/admin/translator-profiles/:userId", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.userId);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user || user.role !== "translator") {
      res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return;
    }

    const [profile] = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    res.json({ user: { id: user.id, email: user.email, isActive: user.isActive }, profile: profile ?? null });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to get translator profile");
    res.status(500).json({ error: "번역사 프로필 조회 실패." });
  }
});

// ─── 번역사 프로필 저장/수정 (upsert) ─────────────────────────────────────────
router.patch("/admin/translator-profiles/:userId", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.userId);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  const {
    languagePairs, specializations, education, major,
    graduationYear, region, rating, availabilityStatus, bio,
    ratePerWord, ratePerPage,
  } = req.body;

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user || user.role !== "translator") {
      res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return;
    }

    const existing = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));

    const profileData = {
      languagePairs, specializations, education, major,
      graduationYear: graduationYear ? Number(graduationYear) : undefined,
      region, rating: rating ? Number(rating) : undefined,
      availabilityStatus: availabilityStatus ?? "available",
      bio, ratePerWord: ratePerWord ? Number(ratePerWord) : undefined,
      ratePerPage: ratePerPage ? Number(ratePerPage) : undefined,
      updatedAt: new Date(),
    };

    let profile;
    if (existing.length === 0) {
      [profile] = await db.insert(translatorProfilesTable).values({ userId, ...profileData }).returning();
    } else {
      [profile] = await db.update(translatorProfilesTable).set(profileData).where(eq(translatorProfilesTable.userId, userId)).returning();
    }
    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update translator profile");
    res.status(500).json({ error: "번역사 프로필 저장 실패." });
  }
});

// ─── 프로젝트 목록 CSV 내보내기 ───────────────────────────────────────────────
router.get("/admin/export/projects", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        createdAt: projectsTable.createdAt,
        customerEmail: usersTable.email,
      })
      .from(projectsTable)
      .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
      .orderBy(desc(projectsTable.createdAt));

    const header = ["ID", "제목", "고객 이메일", "상태", "생성일"].join(",");
    const lines = rows.map(r =>
      [
        r.id,
        `"${(r.title ?? "").replace(/"/g, '""')}"`,
        `"${(r.customerEmail ?? "").replace(/"/g, '""')}"`,
        r.status,
        new Date(r.createdAt).toLocaleDateString("ko-KR"),
      ].join(",")
    );

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="projects_${Date.now()}.csv"`);
    res.send("\uFEFF" + csv);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to export projects");
    res.status(500).json({ error: "내보내기 실패." });
  }
});

// ─── 정산 목록 CSV 내보내기 ───────────────────────────────────────────────────
router.get("/admin/export/settlements", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: settlementsTable.id,
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
      .orderBy(desc(settlementsTable.createdAt));

    const header = ["ID", "프로젝트", "번역사 이메일", "총 금액", "번역사 금액", "수수료", "상태", "생성일"].join(",");
    const lines = rows.map(r =>
      [
        r.id,
        `"${(r.projectTitle ?? "").replace(/"/g, '""')}"`,
        `"${(r.translatorEmail ?? "").replace(/"/g, '""')}"`,
        r.totalAmount,
        r.translatorAmount,
        r.platformFee,
        r.status,
        new Date(r.createdAt).toLocaleDateString("ko-KR"),
      ].join(",")
    );

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="settlements_${Date.now()}.csv"`);
    res.send("\uFEFF" + csv);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to export settlements");
    res.status(500).json({ error: "내보내기 실패." });
  }
});

export default router;
