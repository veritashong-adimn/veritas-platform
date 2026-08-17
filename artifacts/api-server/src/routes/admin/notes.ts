import { Router, type IRouter } from "express";
import { db, notesTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { logEvent } from "../../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

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

    await logEvent("project", projectId, "note_added", req.log, req.user ?? undefined);

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

export default router;
