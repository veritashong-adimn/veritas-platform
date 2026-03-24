import { Router, type IRouter } from "express";
import { db, boardPostsTable, usersTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];
const authGuard = [requireAuth];

// ─── 게시글 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/board", ...adminGuard, async (req, res) => {
  try {
    const { category } = req.query as { category?: string };

    const rows = await db
      .select({
        id: boardPostsTable.id,
        category: boardPostsTable.category,
        title: boardPostsTable.title,
        pinned: boardPostsTable.pinned,
        visibleToAll: boardPostsTable.visibleToAll,
        createdAt: boardPostsTable.createdAt,
        updatedAt: boardPostsTable.updatedAt,
        authorId: boardPostsTable.authorId,
        authorEmail: usersTable.email,
      })
      .from(boardPostsTable)
      .leftJoin(usersTable, eq(boardPostsTable.authorId, usersTable.id))
      .orderBy(desc(boardPostsTable.pinned), desc(boardPostsTable.createdAt));

    const filtered = category?.trim()
      ? rows.filter(r => r.category === category)
      : rows;

    res.json(filtered);
  } catch (err) {
    req.log.error({ err }, "Board: failed to list");
    res.status(500).json({ error: "게시글 조회 실패." });
  }
});

// ─── 게시글 단건 ─────────────────────────────────────────────────────────────
router.get("/admin/board/:id", ...adminGuard, async (req, res) => {
  const postId = Number(req.params.id);
  if (isNaN(postId) || postId <= 0) {
    res.status(400).json({ error: "유효하지 않은 post id." }); return;
  }

  try {
    const rows = await db
      .select({
        id: boardPostsTable.id,
        category: boardPostsTable.category,
        title: boardPostsTable.title,
        content: boardPostsTable.content,
        pinned: boardPostsTable.pinned,
        visibleToAll: boardPostsTable.visibleToAll,
        createdAt: boardPostsTable.createdAt,
        updatedAt: boardPostsTable.updatedAt,
        authorId: boardPostsTable.authorId,
        authorEmail: usersTable.email,
      })
      .from(boardPostsTable)
      .leftJoin(usersTable, eq(boardPostsTable.authorId, usersTable.id))
      .where(eq(boardPostsTable.id, postId));

    if (rows.length === 0) { res.status(404).json({ error: "게시글을 찾을 수 없습니다." }); return; }
    res.json(rows[0]);
  } catch (err) {
    req.log.error({ err }, "Board: failed to get");
    res.status(500).json({ error: "게시글 조회 실패." });
  }
});

// ─── 게시글 작성 ─────────────────────────────────────────────────────────────
router.post("/admin/board", ...adminGuard, async (req, res) => {
  const { category, title, content, pinned, visibleToAll } = req.body as {
    category?: string; title?: string; content?: string;
    pinned?: boolean; visibleToAll?: boolean;
  };

  if (!title?.trim() || !content?.trim()) {
    res.status(400).json({ error: "제목과 내용은 필수입니다." }); return;
  }

  const validCategories = ["notice", "reference", "manual"];
  const postCategory = validCategories.includes(category ?? "") ? category as "notice" | "reference" | "manual" : "notice";

  try {
    const [post] = await db
      .insert(boardPostsTable)
      .values({
        authorId: req.user!.id,
        category: postCategory,
        title: title.trim(),
        content: content.trim(),
        pinned: pinned ?? false,
        visibleToAll: visibleToAll ?? false,
      })
      .returning();
    res.status(201).json(post);
  } catch (err) {
    req.log.error({ err }, "Board: failed to create");
    res.status(500).json({ error: "게시글 작성 실패." });
  }
});

// ─── 게시글 수정 ─────────────────────────────────────────────────────────────
router.patch("/admin/board/:id", ...adminGuard, async (req, res) => {
  const postId = Number(req.params.id);
  if (isNaN(postId) || postId <= 0) {
    res.status(400).json({ error: "유효하지 않은 post id." }); return;
  }

  const { category, title, content, pinned, visibleToAll } = req.body;

  try {
    const [existing] = await db.select().from(boardPostsTable).where(eq(boardPostsTable.id, postId));
    if (!existing) { res.status(404).json({ error: "게시글을 찾을 수 없습니다." }); return; }

    const validCategories = ["notice", "reference", "manual"];
    const postCategory = validCategories.includes(category ?? "") ? category : existing.category;

    const [updated] = await db
      .update(boardPostsTable)
      .set({
        category: postCategory,
        title: title?.trim() ?? existing.title,
        content: content?.trim() ?? existing.content,
        pinned: pinned !== undefined ? Boolean(pinned) : existing.pinned,
        visibleToAll: visibleToAll !== undefined ? Boolean(visibleToAll) : existing.visibleToAll,
        updatedAt: new Date(),
      })
      .where(eq(boardPostsTable.id, postId))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Board: failed to update");
    res.status(500).json({ error: "게시글 수정 실패." });
  }
});

// ─── 게시글 삭제 ─────────────────────────────────────────────────────────────
router.delete("/admin/board/:id", ...adminGuard, async (req, res) => {
  const postId = Number(req.params.id);
  if (isNaN(postId) || postId <= 0) {
    res.status(400).json({ error: "유효하지 않은 post id." }); return;
  }

  try {
    await db.delete(boardPostsTable).where(eq(boardPostsTable.id, postId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Board: failed to delete");
    res.status(500).json({ error: "게시글 삭제 실패." });
  }
});

// ─── 공개 게시글 조회 (번역사/고객용) ────────────────────────────────────────
router.get("/board", ...authGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: boardPostsTable.id,
        category: boardPostsTable.category,
        title: boardPostsTable.title,
        pinned: boardPostsTable.pinned,
        createdAt: boardPostsTable.createdAt,
        authorEmail: usersTable.email,
      })
      .from(boardPostsTable)
      .leftJoin(usersTable, eq(boardPostsTable.authorId, usersTable.id))
      .where(eq(boardPostsTable.visibleToAll, true))
      .orderBy(desc(boardPostsTable.pinned), desc(boardPostsTable.createdAt));

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Board: failed to list public");
    res.status(500).json({ error: "게시글 조회 실패." });
  }
});

export default router;
