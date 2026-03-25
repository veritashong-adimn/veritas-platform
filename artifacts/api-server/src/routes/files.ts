import { Router, type IRouter } from "express";
import { db, projectFilesTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];
const objectStorage = new ObjectStorageService();

const RegisterFileBody = z.object({
  fileType: z.enum(["source", "translated", "attachment"]).default("attachment"),
  fileName: z.string().min(1),
  objectPath: z.string().min(1),
  fileSize: z.number().optional(),
  mimeType: z.string().optional(),
});

// ── GET /api/admin/projects/:id/files ────────────────────────────────────────
router.get("/admin/projects/:id/files", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!projectId) { res.status(400).json({ error: "Invalid project ID" }); return; }

  try {
    const files = await db
      .select({
        id: projectFilesTable.id,
        fileType: projectFilesTable.fileType,
        fileName: projectFilesTable.fileName,
        objectPath: projectFilesTable.objectPath,
        fileSize: projectFilesTable.fileSize,
        mimeType: projectFilesTable.mimeType,
        createdAt: projectFilesTable.createdAt,
        uploadedBy: projectFilesTable.uploadedBy,
        uploaderName: usersTable.name,
        uploaderEmail: usersTable.email,
      })
      .from(projectFilesTable)
      .leftJoin(usersTable, eq(projectFilesTable.uploadedBy, usersTable.id))
      .where(eq(projectFilesTable.projectId, projectId))
      .orderBy(projectFilesTable.createdAt);

    res.json(files);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch project files");
    res.status(500).json({ error: "파일 목록 조회 실패" });
  }
});

// ── POST /api/admin/projects/:id/files ───────────────────────────────────────
// Called after client completes GCS upload. Registers the file metadata in DB.
router.post("/admin/projects/:id/files", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!projectId) { res.status(400).json({ error: "Invalid project ID" }); return; }

  const parsed = RegisterFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "잘못된 요청", details: parsed.error.flatten() });
    return;
  }

  const userId = req.user!.id;

  try {
    const [file] = await db.insert(projectFilesTable).values({
      projectId,
      fileType: parsed.data.fileType,
      fileName: parsed.data.fileName,
      objectPath: parsed.data.objectPath,
      fileSize: parsed.data.fileSize,
      mimeType: parsed.data.mimeType,
      uploadedBy: userId,
    }).returning();

    const typeLabel = parsed.data.fileType === "source" ? "원본" : parsed.data.fileType === "translated" ? "번역본" : "첨부";
    await logEvent("project", projectId, `file_uploaded_${parsed.data.fileType}`, req.log, req.user ?? undefined, JSON.stringify({ fileName: parsed.data.fileName, fileType: typeLabel }));

    res.status(201).json(file);
  } catch (err) {
    req.log.error({ err }, "Failed to register project file");
    res.status(500).json({ error: "파일 등록 실패" });
  }
});

// ── DELETE /api/admin/projects/:id/files/:fileId ─────────────────────────────
router.delete("/admin/projects/:id/files/:fileId", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  if (!projectId || !fileId) { res.status(400).json({ error: "Invalid ID" }); return; }

  try {
    const [file] = await db
      .select()
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId)));

    if (!file) { res.status(404).json({ error: "파일을 찾을 수 없습니다." }); return; }

    await db.delete(projectFilesTable)
      .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId)));

    await logEvent("project", projectId, "file_deleted", req.log, req.user ?? undefined, JSON.stringify({ fileName: file.fileName }));

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete project file");
    res.status(500).json({ error: "파일 삭제 실패" });
  }
});

// ── GET /api/admin/projects/:id/files/:fileId/download ──────────────────────
router.get("/admin/projects/:id/files/:fileId/download", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  if (!projectId || !fileId) { res.status(400).json({ error: "Invalid ID" }); return; }

  try {
    const [file] = await db
      .select()
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.id, fileId), eq(projectFilesTable.projectId, projectId)));

    if (!file) { res.status(404).json({ error: "파일을 찾을 수 없습니다." }); return; }

    const gcsFile = await objectStorage.getObjectEntityFile(file.objectPath);
    const response = await objectStorage.downloadObject(gcsFile);

    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    if (file.mimeType) res.setHeader("Content-Type", file.mimeType);

    if (response.body) {
      const { Readable } = await import("stream");
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      return;
    }
    req.log.error({ err }, "Failed to download project file");
    res.status(500).json({ error: "파일 다운로드 실패" });
  }
});

export default router;
