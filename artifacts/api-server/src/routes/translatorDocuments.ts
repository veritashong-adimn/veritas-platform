import { Router, type IRouter } from "express";
import { db, translatorDocumentsTable, usersTable } from "@workspace/db";
import { eq, and, isNull, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logEvent } from "../lib/logEvent";

// ─────────────────────────────────────────────────────────────────────────────
// 통번역사 서류관리 라우트(§2·§8) — vendor_documents 와 동일 패턴을 통번역사 도메인에 미러링.
//  · 파일 실체는 기존 R2 오브젝트 저장소(objectStorage)에 저장 — 새 저장체계를 만들지 않는다(§8).
//    업로드 흐름: 클라이언트가 POST /api/storage/uploads/request-url 로 presigned URL 발급 →
//    R2 직접 PUT → 이 라우트(POST .../documents)로 메타데이터만 등록.
//  · 서류는 통번역사(translatorId = users.id) 기준으로 보관/조회한다.
//  · 삭제는 soft-delete(휴지통) — 통번역사/서류를 삭제하지 않는 한 서류가 사라지지 않는다(§6·§7).
//  · 다운로드는 인증된 스트리밍 경로만 제공한다 — 파일을 영구 public URL 로 노출하지 않는다(§7).
//  · 기존 이력서/신분증/통장사본(GCS, translators.ts) 엔드포인트는 건드리지 않는다 — 별개 SSOT.
// ─────────────────────────────────────────────────────────────────────────────
const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const objectStorage = new ObjectStorageService();

const RegisterDocBody = z.object({
  documentType: z.string().min(1).max(50),
  documentName: z.string().max(255).optional().nullable(),
  originalFileName: z.string().min(1),
  objectPath: z.string().min(1),
  mimeType: z.string().optional().nullable(),
  fileSize: z.number().int().nonnegative().optional().nullable(),
  memo: z.string().optional().nullable(),
});

// ── GET /api/admin/translators/:id/documents ─────────────────────────────────
// 통번역사 서류 목록. soft-delete 제외, 최신순. (민감 원문은 포함하지 않음 — 메타데이터만)
router.get("/admin/translators/:id/documents", ...adminGuard, async (req, res) => {
  const translatorId = Number(req.params.id);
  if (!translatorId) { res.status(400).json({ error: "Invalid translator ID" }); return; }

  try {
    const rows = await db
      .select({
        id: translatorDocumentsTable.id,
        translatorId: translatorDocumentsTable.translatorId,
        documentType: translatorDocumentsTable.documentType,
        documentName: translatorDocumentsTable.documentName,
        originalFileName: translatorDocumentsTable.originalFileName,
        mimeType: translatorDocumentsTable.mimeType,
        fileSize: translatorDocumentsTable.fileSize,
        memo: translatorDocumentsTable.memo,
        uploadedAt: translatorDocumentsTable.uploadedAt,
        uploadedBy: translatorDocumentsTable.uploadedBy,
        uploaderName: usersTable.name,
      })
      .from(translatorDocumentsTable)
      .leftJoin(usersTable, eq(translatorDocumentsTable.uploadedBy, usersTable.id))
      .where(and(eq(translatorDocumentsTable.translatorId, translatorId), isNull(translatorDocumentsTable.deletedAt)))
      .orderBy(desc(translatorDocumentsTable.uploadedAt));

    res.json({ rows });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch translator documents");
    res.status(500).json({ error: "서류 목록 조회 실패" });
  }
});

// ── POST /api/admin/translators/:id/documents ────────────────────────────────
// 클라이언트가 R2 업로드를 마친 뒤 메타데이터를 등록한다. (이력서는 덮어쓰지 않고 개별 행으로 누적, §6)
router.post("/admin/translators/:id/documents", ...adminGuard, async (req, res) => {
  const translatorId = Number(req.params.id);
  if (!translatorId) { res.status(400).json({ error: "Invalid translator ID" }); return; }

  const parsed = RegisterDocBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "잘못된 요청", details: parsed.error.flatten() });
    return;
  }

  try {
    // 통번역사(user) 존재 확인 — 문서는 통번역사 기준으로 보관.
    const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, translatorId));
    if (!user) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }

    const [doc] = await db.insert(translatorDocumentsTable).values({
      translatorId,
      documentType: parsed.data.documentType,
      documentName: parsed.data.documentName?.trim() || parsed.data.originalFileName,
      originalFileName: parsed.data.originalFileName,
      filePath: parsed.data.objectPath,
      mimeType: parsed.data.mimeType ?? null,
      fileSize: parsed.data.fileSize ?? null,
      memo: parsed.data.memo?.trim() || null,
      uploadedBy: req.user!.id,
    }).returning();

    // 감사로그: 파일명/문서종류만 기록(원문 개인정보 미출력, §7).
    await logEvent("translator", translatorId, "document_uploaded", req.log, req.user ?? undefined,
      JSON.stringify({ documentType: doc.documentType, fileName: doc.originalFileName }));

    res.status(201).json({ document: doc });
  } catch (err) {
    req.log.error({ err }, "Failed to register translator document");
    res.status(500).json({ error: "서류 등록 실패" });
  }
});

// ── GET /api/admin/translators/:id/documents/:docId/download ──────────────────
// 인증된 스트리밍 다운로드(영구 public URL 미노출, §7).
router.get("/admin/translators/:id/documents/:docId/download", ...adminGuard, async (req, res) => {
  const translatorId = Number(req.params.id);
  const docId = Number(req.params.docId);
  if (!translatorId || !docId) { res.status(400).json({ error: "Invalid ID" }); return; }

  try {
    const [doc] = await db.select().from(translatorDocumentsTable)
      .where(and(eq(translatorDocumentsTable.id, docId), eq(translatorDocumentsTable.translatorId, translatorId), isNull(translatorDocumentsTable.deletedAt)));
    if (!doc) { res.status(404).json({ error: "서류를 찾을 수 없습니다." }); return; }

    const obj = await objectStorage.getObjectEntityFile(doc.filePath);
    const response = await objectStorage.downloadObject(obj);

    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalFileName)}`);
    if (doc.mimeType) res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Cache-Control", "private, max-age=0, no-store");

    if (response.body) {
      const { Readable } = await import("stream");
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "서류 파일을 찾을 수 없습니다." });
      return;
    }
    req.log.error({ err }, "Failed to download translator document");
    res.status(500).json({ error: "서류 다운로드 실패" });
  }
});

// ── DELETE /api/admin/translators/:id/documents/:docId ────────────────────────
// soft-delete(휴지통). 물리 삭제하지 않는다(§7).
router.delete("/admin/translators/:id/documents/:docId", ...adminGuard, async (req, res) => {
  const translatorId = Number(req.params.id);
  const docId = Number(req.params.docId);
  if (!translatorId || !docId) { res.status(400).json({ error: "Invalid ID" }); return; }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;

  try {
    const [doc] = await db.select().from(translatorDocumentsTable)
      .where(and(eq(translatorDocumentsTable.id, docId), eq(translatorDocumentsTable.translatorId, translatorId), isNull(translatorDocumentsTable.deletedAt)));
    if (!doc) { res.status(404).json({ error: "서류를 찾을 수 없습니다." }); return; }

    await db.update(translatorDocumentsTable)
      .set({ deletedAt: new Date(), deletedBy: req.user!.id, deletionReason: reason, updatedAt: new Date() })
      .where(eq(translatorDocumentsTable.id, docId));

    await logEvent("translator", translatorId, "document_deleted", req.log, req.user ?? undefined,
      JSON.stringify({ documentType: doc.documentType, fileName: doc.originalFileName }));

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete translator document");
    res.status(500).json({ error: "서류 삭제 실패" });
  }
});

export default router;
