import { Router, type IRouter } from "express";
import { db, vendorDocumentsTable, companiesTable, companyVendorProfilesTable, usersTable } from "@workspace/db";
import { eq, and, isNull, desc } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { logEvent } from "../lib/logEvent";

// ─────────────────────────────────────────────────────────────────────────────
// 외주업체 서류 관리 라우트.
//  · 파일 실체는 기존 R2 오브젝트 저장소(objectStorage)에 저장 — 새 저장체계를 만들지 않는다(§4).
//    업로드 흐름: 클라이언트가 POST /api/storage/uploads/request-url 로 presigned URL 발급 →
//    R2 직접 PUT → 이 라우트(POST .../documents)로 메타데이터만 등록. (project_files 와 동일 패턴)
//  · 문서는 회사(companyId) 기준으로 보관/조회한다. vendorProfileId 는 있으면 연결.
//  · 삭제는 soft-delete(휴지통) — 회사/외주업체를 삭제하지 않는 한 서류가 사라지지 않는다(§6).
//  · companies.ts 가 이미 2,400줄을 넘어 코드 무게 규칙상 별도 파일로 분리(§Code Weight Rules).
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
  vendorProfileId: z.number().int().positive().optional().nullable(),
});

// ── GET /api/admin/companies/:id/documents ───────────────────────────────────
// 회사(외주업체) 서류 목록. soft-delete 제외, 최신순.
router.get("/admin/companies/:id/documents", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) { res.status(400).json({ error: "Invalid company ID" }); return; }

  try {
    const rows = await db
      .select({
        id: vendorDocumentsTable.id,
        companyId: vendorDocumentsTable.companyId,
        vendorProfileId: vendorDocumentsTable.vendorProfileId,
        documentType: vendorDocumentsTable.documentType,
        documentName: vendorDocumentsTable.documentName,
        originalFileName: vendorDocumentsTable.originalFileName,
        mimeType: vendorDocumentsTable.mimeType,
        fileSize: vendorDocumentsTable.fileSize,
        memo: vendorDocumentsTable.memo,
        uploadedAt: vendorDocumentsTable.uploadedAt,
        uploadedBy: vendorDocumentsTable.uploadedBy,
        uploaderName: usersTable.name,
      })
      .from(vendorDocumentsTable)
      .leftJoin(usersTable, eq(vendorDocumentsTable.uploadedBy, usersTable.id))
      .where(and(eq(vendorDocumentsTable.companyId, companyId), isNull(vendorDocumentsTable.deletedAt)))
      .orderBy(desc(vendorDocumentsTable.uploadedAt));

    res.json({ rows });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch vendor documents");
    res.status(500).json({ error: "서류 목록 조회 실패" });
  }
});

// ── POST /api/admin/companies/:id/documents ──────────────────────────────────
// 클라이언트가 R2 업로드를 마친 뒤 메타데이터를 등록한다.
router.post("/admin/companies/:id/documents", ...adminGuard, requirePermission("company.update"), async (req, res) => {
  const companyId = Number(req.params.id);
  if (!companyId) { res.status(400).json({ error: "Invalid company ID" }); return; }

  const parsed = RegisterDocBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "잘못된 요청", details: parsed.error.flatten() });
    return;
  }

  try {
    // 회사 존재 확인(외주역할 여부는 강제하지 않음 — 서류는 회사 기준 보관).
    const [company] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "회사를 찾을 수 없습니다." }); return; }

    // vendorProfileId 가 넘어오면 해당 회사의 프로필인지 검증. 없으면 회사의 활성 프로필을 자동 연결.
    let vendorProfileId = parsed.data.vendorProfileId ?? null;
    if (vendorProfileId) {
      const [vp] = await db.select({ id: companyVendorProfilesTable.id })
        .from(companyVendorProfilesTable)
        .where(and(eq(companyVendorProfilesTable.id, vendorProfileId), eq(companyVendorProfilesTable.companyId, companyId)));
      if (!vp) vendorProfileId = null; // 불일치 시 무시(문서는 회사 기준으로 유지)
    } else {
      const [vp] = await db.select({ id: companyVendorProfilesTable.id })
        .from(companyVendorProfilesTable)
        .where(and(eq(companyVendorProfilesTable.companyId, companyId), isNull(companyVendorProfilesTable.deletedAt)));
      if (vp) vendorProfileId = vp.id;
    }

    const [doc] = await db.insert(vendorDocumentsTable).values({
      companyId,
      vendorProfileId,
      documentType: parsed.data.documentType,
      documentName: parsed.data.documentName?.trim() || parsed.data.originalFileName,
      originalFileName: parsed.data.originalFileName,
      filePath: parsed.data.objectPath,
      mimeType: parsed.data.mimeType ?? null,
      fileSize: parsed.data.fileSize ?? null,
      memo: parsed.data.memo?.trim() || null,
      uploadedBy: req.user!.id,
    }).returning();

    await logEvent("company", companyId, "vendor_document_uploaded", req.log, req.user ?? undefined,
      JSON.stringify({ documentType: doc.documentType, fileName: doc.originalFileName }));

    res.status(201).json({ document: doc });
  } catch (err) {
    req.log.error({ err }, "Failed to register vendor document");
    res.status(500).json({ error: "서류 등록 실패" });
  }
});

// ── GET /api/admin/companies/:id/documents/:docId/download ────────────────────
router.get("/admin/companies/:id/documents/:docId/download", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  const docId = Number(req.params.docId);
  if (!companyId || !docId) { res.status(400).json({ error: "Invalid ID" }); return; }

  try {
    const [doc] = await db.select().from(vendorDocumentsTable)
      .where(and(eq(vendorDocumentsTable.id, docId), eq(vendorDocumentsTable.companyId, companyId), isNull(vendorDocumentsTable.deletedAt)));
    if (!doc) { res.status(404).json({ error: "서류를 찾을 수 없습니다." }); return; }

    const obj = await objectStorage.getObjectEntityFile(doc.filePath);
    const response = await objectStorage.downloadObject(obj);

    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalFileName)}`);
    if (doc.mimeType) res.setHeader("Content-Type", doc.mimeType);

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
    req.log.error({ err }, "Failed to download vendor document");
    res.status(500).json({ error: "서류 다운로드 실패" });
  }
});

// ── DELETE /api/admin/companies/:id/documents/:docId ──────────────────────────
// soft-delete(휴지통). 물리 삭제하지 않는다(§6).
router.delete("/admin/companies/:id/documents/:docId", ...adminGuard, requirePermission("company.update"), async (req, res) => {
  const companyId = Number(req.params.id);
  const docId = Number(req.params.docId);
  if (!companyId || !docId) { res.status(400).json({ error: "Invalid ID" }); return; }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;

  try {
    const [doc] = await db.select().from(vendorDocumentsTable)
      .where(and(eq(vendorDocumentsTable.id, docId), eq(vendorDocumentsTable.companyId, companyId), isNull(vendorDocumentsTable.deletedAt)));
    if (!doc) { res.status(404).json({ error: "서류를 찾을 수 없습니다." }); return; }

    await db.update(vendorDocumentsTable)
      .set({ deletedAt: new Date(), deletedBy: req.user!.id, deletionReason: reason, updatedAt: new Date() })
      .where(eq(vendorDocumentsTable.id, docId));

    await logEvent("company", companyId, "vendor_document_deleted", req.log, req.user ?? undefined,
      JSON.stringify({ documentType: doc.documentType, fileName: doc.originalFileName }));

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete vendor document");
    res.status(500).json({ error: "서류 삭제 실패" });
  }
});

export default router;
