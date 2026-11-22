import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { db, boardPostsTable, boardPostTargetsTable, boardPostFilesTable, usersTable } from "@workspace/db";
import { eq, desc, and, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { uploadToR2, deleteFromR2, getR2ObjectStream, isR2Configured } from "../lib/r2";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const authGuard = [requireAuth];

// 분류: notice=공지사항, reference=회사자료, manual=내부매뉴얼, staff_only=직원전용, other=기타 (저장값 유지, 표시명만 화면에서 변경)
const CATEGORIES = ["notice", "reference", "manual", "staff_only", "other"] as const;
type Category = typeof CATEGORIES[number];
const STAFF_ONLY: Category = "staff_only";

// ─── 직원전용(staff_only) 접근 규칙(2026-11-22) ─────────────────────────────────
//   · 등록·수정·삭제·첨부 관리: role=admin 만.
//   · 조회(목록·상세·첨부 다운로드): admin 전체 / 그 외 직원은 board_post_targets 에 본인이 지정된 글만.
//     권한 없는 글은 목록에서 빠지고, 상세·다운로드는 존재 여부를 드러내지 않도록 404.
//   · 첨부 파일 실체는 R2 board-private/{postId}/{uuid} — 범용 /storage/objects 경로는 차단(routes/storage.ts).
//   · 다른 분류(공지·회사자료·내부매뉴얼·기타)의 기존 동작은 그대로.
const isAdmin = (req: Request) => req.user?.role === "admin";
const isStaffOnly = (c: unknown) => c === STAFF_ONLY;

/** 이 사용자가 직원전용 글을 볼 수 있는지(그 외 분류는 항상 true) */
async function canView(req: Request, post: { id: number; category: string }): Promise<boolean> {
  if (!isStaffOnly(post.category) || isAdmin(req)) return true;
  const [t] = await db.select({ postId: boardPostTargetsTable.postId }).from(boardPostTargetsTable)
    .where(and(eq(boardPostTargetsTable.postId, post.id), eq(boardPostTargetsTable.userId, req.user!.id)));
  return !!t;
}

// 대상 직원 명부(2026-11-22): role=staff 인 활성 계정만. 관리자(admin)·게스트 계정 제외.
//   게스트 = 별도 역할이 없어 계정 표시명 '게스트' 또는 이메일 아이디가 guest 로 시작하는 계정으로 판정.
const STAFF_DIRECTORY = and(eq(usersTable.role, "staff"), eq(usersTable.isActive, true), isNull(usersTable.deletedAt),
  sql`coalesce(btrim(${usersTable.name}), '') <> '게스트' AND split_part(${usersTable.email}, '@', 1) !~* '^guest'`);

/** 대상 직원 검증 — 새로 지정하는 계정은 직원 명부(STAFF_DIRECTORY)에 있어야 한다.
 *  keep: 이미 이 글에 지정돼 있던 계정(수정 시) — 기존 대상 데이터는 바꾸지 않으므로 명부 조건 없이 유지 허용. */
async function validateTargets(raw: unknown, keep: number[] = []): Promise<number[] | string> {
  if (!Array.isArray(raw)) return "대상 직원을 선택하세요.";
  const ids = [...new Set(raw.map(Number))];
  if (ids.length === 0) return "대상 직원을 1명 이상 선택하세요.";
  if (ids.some(i => !Number.isInteger(i) || i <= 0)) return "대상 직원 정보가 올바르지 않습니다.";
  const added = ids.filter(i => !keep.includes(i));
  if (added.length) {
    const found = await db.select({ id: usersTable.id }).from(usersTable).where(and(inArray(usersTable.id, added), STAFF_DIRECTORY));
    if (found.length !== added.length) return "직원 명부에 없는 계정(관리자·게스트·비활성·삭제 포함)이 대상에 포함되어 있습니다.";
  }
  return ids;
}

async function loadTargets(postIds: number[]) {
  if (!postIds.length) return new Map<number, { id: number; name: string | null; email: string }[]>();
  const rows = await db.select({ postId: boardPostTargetsTable.postId, id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(boardPostTargetsTable).innerJoin(usersTable, eq(usersTable.id, boardPostTargetsTable.userId))
    .where(inArray(boardPostTargetsTable.postId, postIds));
  const m = new Map<number, { id: number; name: string | null; email: string }[]>();
  for (const r of rows) { const a = m.get(r.postId) ?? []; a.push({ id: r.id, name: r.name, email: r.email }); m.set(r.postId, a); }
  return m;
}

// ─── 직원 명부(대상 직원 선택용) — 관리자 전용 ───────────────────────────────────
router.get("/admin/board/staff-directory", ...adminGuard, async (req, res) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "관리자만 조회할 수 있습니다." }); return; }
  try {
    const rows = await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
      .from(usersTable)
      .where(STAFF_DIRECTORY)
      .orderBy(usersTable.name);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Board: failed to list staff directory");
    res.status(500).json({ error: "직원 명부 조회 실패." });
  }
});

// ─── 게시글 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/board", ...adminGuard, async (req, res) => {
  try {
    const { category } = req.query as { category?: string };
    const admin = isAdmin(req);

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
        fileCount: sql<number>`(SELECT count(*)::int FROM board_post_files f WHERE f.post_id = ${boardPostsTable.id})`,
      })
      .from(boardPostsTable)
      .leftJoin(usersTable, eq(boardPostsTable.authorId, usersTable.id))
      // 직원전용: 관리자는 전체, 그 외는 본인이 대상으로 지정된 글만(서버에서 제외)
      .where(admin ? undefined : or(ne(boardPostsTable.category, STAFF_ONLY),
        sql`EXISTS (SELECT 1 FROM board_post_targets t WHERE t.post_id = ${boardPostsTable.id} AND t.user_id = ${req.user!.id})`))
      .orderBy(desc(boardPostsTable.pinned), desc(boardPostsTable.createdAt));

    const filtered = category?.trim()
      ? rows.filter(r => r.category === category)
      : rows;

    // 관리자에게만 직원전용 글의 대상 직원 목록을 붙인다
    const targets = admin ? await loadTargets(filtered.filter(r => isStaffOnly(r.category)).map(r => r.id)) : null;
    res.json(filtered.map(r => (isStaffOnly(r.category) && targets ? { ...r, targets: targets.get(r.id) ?? [] } : r)));
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

    if (rows.length === 0 || !(await canView(req, rows[0]))) { res.status(404).json({ error: "게시글을 찾을 수 없습니다." }); return; }
    const post = rows[0];
    const files = await db.select({ id: boardPostFilesTable.id, originalFileName: boardPostFilesTable.originalFileName,
      mimeType: boardPostFilesTable.mimeType, fileSize: boardPostFilesTable.fileSize, uploadedAt: boardPostFilesTable.uploadedAt })
      .from(boardPostFilesTable).where(eq(boardPostFilesTable.postId, postId)).orderBy(boardPostFilesTable.id);
    const extra: Record<string, unknown> = { files };
    if (isStaffOnly(post.category) && isAdmin(req)) extra.targets = (await loadTargets([postId])).get(postId) ?? [];
    res.json({ ...post, ...extra });
  } catch (err) {
    req.log.error({ err }, "Board: failed to get");
    res.status(500).json({ error: "게시글 조회 실패." });
  }
});

// ─── 게시글 작성 ─────────────────────────────────────────────────────────────
router.post("/admin/board", ...adminGuard, async (req, res) => {
  const { category, title, content, pinned, visibleToAll, targetUserIds } = req.body as {
    category?: string; title?: string; content?: string;
    pinned?: boolean; visibleToAll?: boolean; targetUserIds?: unknown;
  };

  if (!title?.trim() || !content?.trim()) {
    res.status(400).json({ error: "제목과 내용은 필수입니다." }); return;
  }

  const postCategory: Category = CATEGORIES.includes(category as Category) ? category as Category : "notice";
  let targets: number[] = [];
  if (isStaffOnly(postCategory)) {
    if (!isAdmin(req)) { res.status(403).json({ error: "직원전용 자료는 관리자만 등록할 수 있습니다." }); return; }
    const v = await validateTargets(targetUserIds);
    if (typeof v === "string") { res.status(400).json({ error: v }); return; }
    targets = v;
  }

  try {
    const post = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(boardPostsTable)
        .values({
          authorId: req.user!.id,
          category: postCategory,
          title: title.trim(),
          content: content.trim(),
          pinned: pinned ?? false,
          // 직원전용은 공개 게시판(/board) 노출 불가
          visibleToAll: isStaffOnly(postCategory) ? false : (visibleToAll ?? false),
        })
        .returning();
      if (targets.length) await tx.insert(boardPostTargetsTable).values(targets.map(userId => ({ postId: p.id, userId })));
      return p;
    });
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

  const { category, title, content, pinned, visibleToAll, targetUserIds } = req.body;

  try {
    const [existing] = await db.select().from(boardPostsTable).where(eq(boardPostsTable.id, postId));
    if (!existing || !(await canView(req, existing))) { res.status(404).json({ error: "게시글을 찾을 수 없습니다." }); return; }

    const postCategory: Category = CATEGORIES.includes(category) ? category : existing.category;
    const wasStaffOnly = isStaffOnly(existing.category), nowStaffOnly = isStaffOnly(postCategory);
    if ((wasStaffOnly || nowStaffOnly) && !isAdmin(req)) { res.status(403).json({ error: "직원전용 자료는 관리자만 수정할 수 있습니다." }); return; }
    // 분류를 직원전용 ↔ 일반으로 바꾸면 첨부·열람 범위가 섞이므로 금지(새 글로 등록)
    if (wasStaffOnly !== nowStaffOnly) { res.status(409).json({ error: "직원전용 분류는 다른 분류로(또는 다른 분류에서) 바꿀 수 없습니다. 새 글로 등록하세요." }); return; }
    let targets: number[] | null = null;
    if (nowStaffOnly && targetUserIds !== undefined) {
      const current = (await db.select({ userId: boardPostTargetsTable.userId }).from(boardPostTargetsTable)
        .where(eq(boardPostTargetsTable.postId, postId))).map(r => r.userId);
      const v = await validateTargets(targetUserIds, current);
      if (typeof v === "string") { res.status(400).json({ error: v }); return; }
      targets = v;
    }

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(boardPostsTable)
        .set({
          category: postCategory,
          title: title?.trim() ?? existing.title,
          content: content?.trim() ?? existing.content,
          pinned: pinned !== undefined ? Boolean(pinned) : existing.pinned,
          visibleToAll: nowStaffOnly ? false : (visibleToAll !== undefined ? Boolean(visibleToAll) : existing.visibleToAll),
          updatedAt: new Date(),
        })
        .where(eq(boardPostsTable.id, postId))
        .returning();
      if (targets) {
        await tx.delete(boardPostTargetsTable).where(eq(boardPostTargetsTable.postId, postId));
        await tx.insert(boardPostTargetsTable).values(targets.map(userId => ({ postId, userId })));
      }
      return u;
    });
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
    const [existing] = await db.select().from(boardPostsTable).where(eq(boardPostsTable.id, postId));
    if (existing && isStaffOnly(existing.category) && !isAdmin(req)) {
      // 권한 없는 직원에게는 존재 여부를 드러내지 않는다
      if (!(await canView(req, existing))) { res.status(404).json({ error: "게시글을 찾을 수 없습니다." }); return; }
      res.status(403).json({ error: "직원전용 자료는 관리자만 삭제할 수 있습니다." }); return;
    }
    const files = await db.select({ filePath: boardPostFilesTable.filePath }).from(boardPostFilesTable).where(eq(boardPostFilesTable.postId, postId));
    await db.delete(boardPostsTable).where(eq(boardPostsTable.id, postId));   // 대상 직원·첨부 메타데이터는 FK cascade
    for (const f of files) await deleteFromR2(f.filePath).catch(err => req.log.warn({ err, key: f.filePath }, "Board: R2 file delete failed"));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Board: failed to delete");
    res.status(500).json({ error: "게시글 삭제 실패." });
  }
});

// ─── 첨부파일(직원전용) ──────────────────────────────────────────────────────
const BOARD_MAX_FILE_SIZE = 50 * 1024 * 1024;
const BOARD_MAX_FILES = 10;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: BOARD_MAX_FILE_SIZE, files: BOARD_MAX_FILES } });
function multiFiles(req: Request, res: Response, next: NextFunction) {
  if (!isR2Configured()) { res.status(503).json({ error: "파일 저장소(R2)가 설정되지 않았습니다." }); return; }
  upload.array("files", BOARD_MAX_FILES)(req, res, (err: unknown) => {
    if (err) {
      const code = (err as any)?.code;
      res.status(code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: code === "LIMIT_FILE_SIZE" ? `파일 용량이 ${BOARD_MAX_FILE_SIZE / 1024 / 1024}MB 를 초과합니다.`
          : code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE" ? `한 번에 최대 ${BOARD_MAX_FILES}개까지 첨부할 수 있습니다.` : "파일 업로드 요청이 올바르지 않습니다.",
      });
      return;
    }
    next();
  });
}
/** multer 는 파일명을 latin1 로 해석하므로 클라이언트가 보낸 UTF-8 파일명(fileNames JSON 배열)을 우선 사용 */
function fileNamesOf(req: Request, files: Express.Multer.File[]): string[] {
  let names: unknown = [];
  try { names = JSON.parse(String(req.body?.fileNames ?? "[]")); } catch { /* 원본 파일명 사용 */ }
  return files.map((f, i) => {
    const n = Array.isArray(names) && typeof names[i] === "string" && names[i].trim() ? names[i].trim() : Buffer.from(f.originalname, "latin1").toString("utf8");
    return n.replace(/[\\/]/g, "_").slice(0, 255);
  });
}

router.post("/admin/board/:id/files", ...adminGuard, async (req, res, next) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "첨부파일은 관리자만 등록할 수 있습니다." }); return; }
  next();
}, multiFiles, async (req, res) => {
  const postId = Number(req.params.id);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!Number.isInteger(postId) || postId <= 0) { res.status(400).json({ error: "유효하지 않은 post id." }); return; }
  if (!files.length) { res.status(400).json({ error: "첨부할 파일을 선택하세요." }); return; }
  try {
    const [post] = await db.select().from(boardPostsTable).where(eq(boardPostsTable.id, postId));
    if (!post) { res.status(404).json({ error: "게시글을 찾을 수 없습니다." }); return; }
    if (!isStaffOnly(post.category)) { res.status(409).json({ error: "첨부파일은 직원전용 자료에만 등록할 수 있습니다." }); return; }
    const names = fileNamesOf(req, files);
    const saved: { id: number; originalFileName: string; mimeType: string | null; fileSize: number | null; uploadedAt: Date }[] = [];
    const uploadedKeys: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const key = `board-private/${postId}/${randomUUID()}`;
        await uploadToR2(key, files[i].buffer, files[i].mimetype || "application/octet-stream");
        uploadedKeys.push(key);
      }
      const rows = await db.insert(boardPostFilesTable).values(files.map((f, i) => ({
        postId, originalFileName: names[i], filePath: uploadedKeys[i], mimeType: f.mimetype || null, fileSize: f.size, uploadedBy: req.user!.id,
      }))).returning();
      for (const r of rows) saved.push({ id: r.id, originalFileName: r.originalFileName, mimeType: r.mimeType, fileSize: r.fileSize, uploadedAt: r.uploadedAt });
    } catch (err) {
      for (const k of uploadedKeys) await deleteFromR2(k).catch(() => {});   // 일부 실패 시 업로드분 정리(전부 아니면 전무)
      throw err;
    }
    res.status(201).json({ files: saved });
  } catch (err) {
    req.log.error({ err, postId }, "Board: failed to upload files");
    res.status(500).json({ error: "첨부파일 등록 실패." });
  }
});

router.delete("/admin/board/:id/files/:fileId", ...adminGuard, async (req, res) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "첨부파일은 관리자만 삭제할 수 있습니다." }); return; }
  const postId = Number(req.params.id), fileId = Number(req.params.fileId);
  if (!Number.isInteger(postId) || postId <= 0 || !Number.isInteger(fileId) || fileId <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try {
    const [f] = await db.delete(boardPostFilesTable).where(and(eq(boardPostFilesTable.id, fileId), eq(boardPostFilesTable.postId, postId))).returning();
    if (!f) { res.status(404).json({ error: "첨부파일을 찾을 수 없습니다." }); return; }
    await deleteFromR2(f.filePath).catch(err => req.log.warn({ err, key: f.filePath }, "Board: R2 file delete failed"));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Board: failed to delete file");
    res.status(500).json({ error: "첨부파일 삭제 실패." });
  }
});

router.get("/admin/board/:id/files/:fileId/download", ...adminGuard, async (req, res) => {
  const postId = Number(req.params.id), fileId = Number(req.params.fileId);
  if (!Number.isInteger(postId) || postId <= 0 || !Number.isInteger(fileId) || fileId <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try {
    const [post] = await db.select({ id: boardPostsTable.id, category: boardPostsTable.category }).from(boardPostsTable).where(eq(boardPostsTable.id, postId));
    if (!post || !(await canView(req, post))) { res.status(404).json({ error: "첨부파일을 찾을 수 없습니다." }); return; }
    const [f] = await db.select().from(boardPostFilesTable).where(and(eq(boardPostFilesTable.id, fileId), eq(boardPostFilesTable.postId, postId)));
    if (!f) { res.status(404).json({ error: "첨부파일을 찾을 수 없습니다." }); return; }
    const obj = await getR2ObjectStream(f.filePath);
    res.setHeader("Content-Type", f.mimeType || obj.contentType);
    if (obj.contentLength != null) res.setHeader("Content-Length", String(obj.contentLength));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.originalFileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    Readable.fromWeb(obj.body as any).pipe(res);
  } catch (err) {
    req.log.error({ err, postId, fileId }, "Board: file download failed");
    res.status(502).json({ error: "파일을 불러오지 못했습니다." });
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
      // 직원전용은 공개 게시판에 절대 노출하지 않는다
      .where(and(eq(boardPostsTable.visibleToAll, true), ne(boardPostsTable.category, STAFF_ONLY)))
      .orderBy(desc(boardPostsTable.pinned), desc(boardPostsTable.createdAt));

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Board: failed to list public");
    res.status(500).json({ error: "게시글 조회 실패." });
  }
});

export default router;
