/**
 * 회사 자료보관함 — 등록·가져오기(단일/다중/폴더 업로드), 중복 확인, 새 버전, 버전 복원, 검토 요청, 양식 발급.
 *  · 파일 1개 = 요청 1건(클라이언트가 순차 전송) → 파일별 성공·실패 결과를 명확히 반환.
 *  · 용량 제한: 기존 /api/upload 정책과 동일한 10MB. 기존 제한은 변경하지 않는다.
 *  · 동일 해시 자료가 있어도 자동 삭제·차단하지 않고 안내만 한다(skipIfDuplicate 지정 시에만 건너뜀).
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import {
  db, archiveDocumentsTable, archiveDocumentVersionsTable, archiveFoldersTable, archiveAclTable, archiveLinksTable,
  type ArchiveDocument,
} from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { isR2Configured } from "../lib/r2";
import {
  loadAclContext, documentActions, folderActions, canListDocument, canSeeUnapproved, folderPath, archiveAudit,
  isFolderDeleted, type AclContext,
} from "../services/archiveAccess";
import {
  requireArchiveModule, archiveFileInfo, ARCHIVE_MAX_FILE_SIZE, ARCHIVE_ALLOWED_EXTS, DOC_TYPES, SECURITY_LEVELS,
  LINK_ENTITY_TYPES, parseId,
} from "../services/archiveCommon";
import {
  sha256, extractForArchive, storeArchiveFile, addVersion, requestReview, normalizeAclRows, WorkflowError,
} from "../services/archiveWorkflow";
import { ensureReviewFolder, runArchiveClassification } from "../services/archiveClassify";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin", "staff"), requireArchiveModule];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ARCHIVE_MAX_FILE_SIZE, files: 1 } });

function singleFile(req: Request, res: Response, next: NextFunction) {
  if (!isR2Configured()) { res.status(503).json({ error: "파일 저장소(R2)가 설정되지 않았습니다." }); return; }
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const code = (err as any)?.code;
      res.status(code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: code === "LIMIT_FILE_SIZE" ? `파일 용량이 ${ARCHIVE_MAX_FILE_SIZE / 1024 / 1024}MB 를 초과합니다.` : "파일 업로드 요청이 올바르지 않습니다.",
      });
      return;
    }
    next();
  });
}

function parseMeta(req: Request): Record<string, any> {
  try { return typeof req.body?.meta === "string" ? JSON.parse(req.body.meta) : (req.body ?? {}); } catch { return {}; }
}

/** multer 는 파일명을 latin1 로 해석하므로 클라이언트가 보낸 UTF-8 파일명을 우선 사용 */
function fileNameOf(req: Request, meta: Record<string, any>): string {
  const raw = typeof meta.fileName === "string" && meta.fileName.trim() ? meta.fileName.trim() : req.file!.originalname;
  return raw.replace(/[\\/]/g, "_").slice(0, 255);
}

type PreparedFile = { fileName: string; ext: string; mime: string; buf: Buffer; hash: string };

function prepareFile(req: Request, res: Response, meta: Record<string, any>): PreparedFile | null {
  if (!req.file) { res.status(400).json({ error: "파일을 첨부해 주세요." }); return null; }
  const fileName = fileNameOf(req, meta);
  const info = archiveFileInfo(fileName);
  if (!info) {
    res.status(415).json({ error: `지원하지 않는 파일 형식입니다. 지원 형식: ${ARCHIVE_ALLOWED_EXTS.join(", ")}` });
    return null;
  }
  if (req.file.size === 0) { res.status(400).json({ error: "빈 파일은 등록할 수 없습니다." }); return null; }
  return { fileName, ext: info.ext, mime: info.mime, buf: req.file.buffer, hash: sha256(req.file.buffer) };
}

/** 같은 해시의 기존 자료 중 요청자에게 보이는 것만 반환 */
async function findVisibleDuplicates(req: Request, ctx: AclContext, hashes: string[]) {
  if (!hashes.length) return new Map<string, Array<{ id: number; title: string; folderPath: string; versionNo: number }>>();
  const actor = req.archiveActor!;
  const rows = await db.select({ v: archiveDocumentVersionsTable, d: archiveDocumentsTable })
    .from(archiveDocumentVersionsTable)
    .innerJoin(archiveDocumentsTable, eq(archiveDocumentVersionsTable.documentId, archiveDocumentsTable.id))
    .where(and(inArray(archiveDocumentVersionsTable.sha256, hashes), isNull(archiveDocumentsTable.deletedAt)));
  const out = new Map<string, Array<{ id: number; title: string; folderPath: string; versionNo: number }>>();
  for (const r of rows) {
    const acts = documentActions(actor, ctx, r.d);
    if (!canListDocument(actor, acts, r.d)) continue;
    if (r.v.id !== r.d.approvedVersionId && !canSeeUnapproved(actor, acts, r.d)) continue;
    const arr = out.get(r.v.sha256!) ?? [];
    if (!arr.some(x => x.id === r.d.id)) arr.push({ id: r.d.id, title: r.d.title, folderPath: folderPath(ctx, r.d.folderId), versionNo: r.v.versionNo });
    out.set(r.v.sha256!, arr);
  }
  return out;
}

router.post("/archive/duplicates", ...guard, async (req, res) => {
  const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes.filter((h: unknown) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h)).slice(0, 500) : [];
  const ctx = await loadAclContext();
  const map = await findVisibleDuplicates(req, ctx, hashes);
  res.json(Object.fromEntries(map));
});

/** 폴더 업로드의 상대경로(a/b/file.pdf) 하위 폴더를 기준 폴더 아래에 보장 */
async function ensureSubfolders(base: number, relativePath: string | undefined, actorId: number, ctx: AclContext): Promise<number> {
  if (!relativePath) return base;
  const parts = relativePath.split("/").map(p => p.trim()).filter(Boolean).slice(0, -1); // 마지막은 파일명
  // 브라우저 webkitRelativePath 는 선택한 최상위 폴더명부터 시작 → 그대로 하위 구조로 보존
  let parent = base;
  for (const name of parts.slice(0, 10)) {
    const safe = name.slice(0, 200);
    const existing = [...ctx.folders.values()].find(f => f.parentId === parent && f.name === safe && !f.deletedAt);   // 삭제된 폴더에는 배정하지 않음
    if (existing) { parent = existing.id; continue; }
    const [f] = await db.insert(archiveFoldersTable).values({ parentId: parent, name: safe, createdBy: actorId })
      .returning({ id: archiveFoldersTable.id, parentId: archiveFoldersTable.parentId, name: archiveFoldersTable.name, menuKey: archiveFoldersTable.menuKey, isActive: archiveFoldersTable.isActive, sortOrder: archiveFoldersTable.sortOrder });
    ctx.folders.set(f.id, f);
    parent = f.id;
  }
  return parent;
}

function docFieldsFromMeta(meta: Record<string, any>) {
  const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    docType: (DOC_TYPES as readonly string[]).includes(meta.docType) ? meta.docType : "general",
    description: s(meta.description), keywords: s(meta.keywords), authorName: s(meta.authorName),
    ownerDepartment: s(meta.ownerDepartment), documentDate: date(meta.documentDate),
    securityLevel: (SECURITY_LEVELS as readonly string[]).includes(meta.securityLevel) ? meta.securityLevel : "restricted",
    aiAllowed: meta.aiAllowed === true, retentionUntil: date(meta.retentionUntil), expiresAt: date(meta.expiresAt),
    requiresApproval: meta.requiresApproval === true, isStandardForm: meta.isStandardForm === true,
  };
}

async function insertLinks(documentId: number, links: unknown, actorId: number) {
  if (!Array.isArray(links)) return;
  const rows = links
    .map((l: any) => ({ entityType: String(l?.entityType ?? ""), entityId: parseId(l?.entityId) }))
    .filter(l => (LINK_ENTITY_TYPES as readonly string[]).includes(l.entityType) && l.entityId)
    .map(l => ({ documentId, entityType: l.entityType, entityId: l.entityId!, createdBy: actorId }));
  if (rows.length) await db.insert(archiveLinksTable).values(rows).onConflictDoNothing();
}

/**
 * 공개 범위(visibility) — 등록 시 명시 필수.
 *  inherit: 폴더 권한 상속 / private: 상속 해제(등록자·관리자만) / custom: 상속 해제 + 지정 대상
 */
function aclFromVisibility(meta: Record<string, any>): unknown[] | null {
  if (meta.visibility === "inherit") return [];
  if (meta.visibility === "private") return [{ subjectType: "no_inherit" }];
  if (meta.visibility === "custom" && Array.isArray(meta.acl)) return [{ subjectType: "no_inherit" }, ...meta.acl];
  return null;
}

// ─── 신규 자료 등록 ─────────────────────────────────────────────────────────

router.post("/archive/upload", ...guard, singleFile, async (req, res) => {
  const actor = req.archiveActor!;
  if (!actor.canUpload) { res.status(403).json({ error: "자료 등록 권한(archive.upload)이 없습니다." }); return; }
  const meta = parseMeta(req);
  const f = prepareFile(req, res, meta);
  if (!f) return;
  const acl = aclFromVisibility(meta);
  if (!acl) { res.status(400).json({ error: "공개 범위(visibility: inherit|private|custom)를 지정해 주세요." }); return; }
  const ctx = await loadAclContext();
  const baseFolder = parseId(meta.folderId);
  if (!baseFolder || !ctx.folders.has(baseFolder) || isFolderDeleted(ctx, baseFolder)) { res.status(400).json({ error: "저장할 폴더를 선택해 주세요." }); return; }
  if (!ctx.folders.get(baseFolder)!.isActive) { res.status(400).json({ error: "비활성 폴더에는 등록할 수 없습니다." }); return; }
  if (!folderActions(actor, ctx, baseFolder).has("upload")) { res.status(403).json({ error: "이 폴더에 자료를 등록할 권한이 없습니다." }); return; }
  // 극비 자료는 관리자만 등록
  const fields = docFieldsFromMeta(meta);
  if (fields.securityLevel === "secret" && !actor.isArchiveAdmin) { res.status(403).json({ error: "극비 등급 자료는 자료보관함 관리자만 등록할 수 있습니다." }); return; }

  try {
    const dups = await findVisibleDuplicates(req, ctx, [f.hash]);
    const duplicates = dups.get(f.hash) ?? [];
    if (duplicates.length && meta.skipIfDuplicate === true) {
      res.status(200).json({ skipped: true, duplicates });
      return;
    }
    const folderId = await ensureSubfolders(baseFolder, typeof meta.relativePath === "string" ? meta.relativePath : undefined, actor.id, ctx);
    const storageKey = await storeArchiveFile(f.buf, f.ext, f.mime);
    const ex = await extractForArchive(f.buf, f.fileName, f.ext);
    const title = (typeof meta.title === "string" && meta.title.trim()) ? meta.title.trim().slice(0, 500) : f.fileName.replace(/\.[^.]+$/, "");
    const [doc] = await db.insert(archiveDocumentsTable).values({
      folderId, title, ...fields, aiStatus: ex.aiStatus, createdBy: actor.id, updatedBy: actor.id,
    }).returning();
    const aclRows = normalizeAclRows(acl, { documentId: doc.id }, actor.id);
    if (aclRows.length) await db.insert(archiveAclTable).values(aclRows);
    await insertLinks(doc.id, meta.links, actor.id);
    const v = await addVersion({
      doc, storageKey, fileName: f.fileName, mime: f.mime, size: f.buf.length, hash: f.hash,
      text: ex.text, method: ex.method, reason: "최초 등록", actorId: actor.id,
      submit: meta.submit !== false, requestType: "register",
    });
    await archiveAudit(req, "upload", { documentId: doc.id, folderId, versionId: v.versionId }, {
      fileName: f.fileName, size: f.buf.length, sha256: f.hash, visibility: meta.visibility, duplicateOf: duplicates.map(d => d.id),
    });
    if (v.approvalId) await archiveAudit(req, "approval_request", { documentId: doc.id, versionId: v.versionId }, { type: "register", approvalId: v.approvalId });
    res.status(201).json({ documentId: doc.id, versionId: v.versionId, status: v.status, approvalId: v.approvalId, duplicates, extract: ex.aiStatus });
  } catch (err) {
    req.log.error({ err }, "[archive] upload failed");
    res.status(500).json({ error: "자료 등록 중 오류가 발생했습니다." });
  }
});

// ─── 통합 간편 등록(파일만) — AI 자동 분석·분류 ──────────────────────────────────
//  직원 입력은 파일뿐. 원본을 먼저 저장해 등록을 완료하고(관리자 승인 불필요), AI 분류는 비동기로 반영한다.
//  · 최초 위치: 「분류 확인 필요」 폴더 → AI 가 기존 폴더 중 적합한 곳으로 이동(불명확하면 그대로)
//  · 공개 범위: 등록자·자료보관함 관리자 전용(no_inherit) — 열람 확대는 관리자가 권한 설정
//  · 승인: 'register' 승인요청 생성(관리자 확인 대기). AI 활용·공식 서식/매뉴얼 지정은 기본 해제(관리자 승인 사항)
//  · 폴더 업로드의 하위 경로는 폴더를 새로 만들지 않고 AI 참고 정보로만 사용
router.post("/archive/upload/auto", ...guard, singleFile, async (req, res) => {
  const actor = req.archiveActor!;
  if (!actor.canUpload) { res.status(403).json({ error: "자료 등록 권한(archive.upload)이 없습니다." }); return; }
  const meta = parseMeta(req);
  const f = prepareFile(req, res, meta);
  if (!f) return;
  const relativePath = typeof meta.relativePath === "string" ? meta.relativePath.slice(0, 500) : null;
  try {
    const ctx = await loadAclContext();
    const dups = await findVisibleDuplicates(req, ctx, [f.hash]);
    const duplicates = dups.get(f.hash) ?? [];
    const reviewFolder = await ensureReviewFolder(actor.id);
    const storageKey = await storeArchiveFile(f.buf, f.ext, f.mime);
    const ex = await extractForArchive(f.buf, f.fileName, f.ext);
    const hasText = !!ex.text?.trim();
    const [doc] = await db.insert(archiveDocumentsTable).values({
      folderId: reviewFolder, title: f.fileName.replace(/\.[^.]+$/, "").slice(0, 500) || f.fileName,
      docType: "other", securityLevel: "restricted", aiAllowed: false, requiresApproval: true, isStandardForm: false,
      ownerDepartment: actor.department, aiStatus: hasText ? "analyzing" : "needs_review",
      createdBy: actor.id, updatedBy: actor.id,
    }).returning();
    await db.insert(archiveAclTable).values(normalizeAclRows([{ subjectType: "no_inherit" }], { documentId: doc.id }, actor.id));
    const v = await addVersion({
      doc, storageKey, fileName: f.fileName, mime: f.mime, size: f.buf.length, hash: f.hash,
      text: ex.text, method: ex.method, reason: "최초 등록(간편 등록·AI 자동 분류)", actorId: actor.id, submit: true, requestType: "register",
    });
    await archiveAudit(req, "upload", { documentId: doc.id, folderId: reviewFolder, versionId: v.versionId }, {
      fileName: f.fileName, size: f.buf.length, sha256: f.hash, mode: "auto", relativePath, duplicateOf: duplicates.map(d => d.id), extract: ex.aiStatus,
    });
    if (v.approvalId) await archiveAudit(req, "approval_request", { documentId: doc.id, versionId: v.versionId }, { type: "register", approvalId: v.approvalId });
    res.status(201).json({ documentId: doc.id, versionId: v.versionId, status: v.status, approvalId: v.approvalId, duplicates, aiStatus: hasText ? "analyzing" : "needs_review" });
    // 응답 후 비동기 분류 — 실패해도 원본·문서는 보존(aiStatus=failed → 재분석 가능)
    void runArchiveClassification(doc.id, { actorId: actor.id, actorEmail: actor.email, relativePath }).catch(() => undefined);
  } catch (err) {
    req.log.error({ err }, "[archive] auto upload failed");
    res.status(500).json({ error: "자료 등록 중 오류가 발생했습니다." });
  }
});

/** 등록 상태 조회(업로드 화면 진행 표시용) — 요청자에게 보이는 자료만 */
router.post("/archive/ai-status", ...guard, async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(parseId).filter((x: number | null): x is number => !!x).slice(0, 200);
  if (!ids.length) { res.json([]); return; }
  const ctx = await loadAclContext();
  const docs = await db.select().from(archiveDocumentsTable).where(and(inArray(archiveDocumentsTable.id, ids), isNull(archiveDocumentsTable.deletedAt)));
  const actor = req.archiveActor!;
  res.json(docs.filter(d => canListDocument(actor, documentActions(actor, ctx, d), d)).map(d => ({
    id: d.id, aiStatus: d.aiStatus, title: d.title, docType: d.docType, status: d.status, folderPath: folderPath(ctx, d.folderId),
  })));
});

// ─── 새 버전 등록(기존 승인본은 보존) ─────────────────────────────────────────

async function loadEditable(req: Request, res: Response): Promise<{ doc: ArchiveDocument; ctx: AclContext } | null> {
  const id = parseId(req.params.id);
  const [doc] = id ? await db.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, id)) : [];
  const ctx = await loadAclContext();
  if (!doc || doc.deletedAt) { res.status(404).json({ error: "자료를 찾을 수 없습니다." }); return null; }
  const acts = documentActions(req.archiveActor!, ctx, doc);
  if (!canListDocument(req.archiveActor!, acts, doc)) { res.status(404).json({ error: "자료를 찾을 수 없습니다." }); return null; }
  if (!acts.has("edit")) { res.status(403).json({ error: "이 자료를 수정할 권한이 없습니다." }); return null; }
  if (doc.status === "discarded") { res.status(409).json({ error: "폐기된 자료는 수정할 수 없습니다." }); return null; }
  return { doc, ctx };
}

router.post("/archive/documents/:id/versions", ...guard, singleFile, async (req, res) => {
  const l = await loadEditable(req, res);
  if (!l) return;
  const meta = parseMeta(req);
  const f = prepareFile(req, res, meta);
  if (!f) return;
  const reason = typeof meta.reason === "string" && meta.reason.trim() ? meta.reason.trim() : null;
  if (!reason) { res.status(400).json({ error: "변경 사유를 입력해 주세요." }); return; }
  try {
    const storageKey = await storeArchiveFile(f.buf, f.ext, f.mime);
    const ex = await extractForArchive(f.buf, f.fileName, f.ext);
    const v = await addVersion({
      doc: l.doc, storageKey, fileName: f.fileName, mime: f.mime, size: f.buf.length, hash: f.hash,
      text: ex.text, method: ex.method, reason, actorId: req.user!.id, submit: meta.submit !== false, requestType: "new_version",
    });
    await db.update(archiveDocumentsTable).set({ aiStatus: ex.aiStatus }).where(eq(archiveDocumentsTable.id, l.doc.id));
    await archiveAudit(req, "version_add", { documentId: l.doc.id, versionId: v.versionId }, { versionNo: v.versionNo, fileName: f.fileName, reason, status: v.status });
    if (v.approvalId) await archiveAudit(req, "approval_request", { documentId: l.doc.id, versionId: v.versionId }, { type: "new_version", approvalId: v.approvalId });
    res.status(201).json(v);
  } catch (err) {
    req.log.error({ err }, "[archive] version upload failed");
    res.status(500).json({ error: "새 버전 등록 중 오류가 발생했습니다." });
  }
});

/** 이전 버전 복원 — 해당 파일을 새 버전으로 재등록(승인 정책 적용). 이력은 보존. */
router.post("/archive/documents/:id/versions/:vid/restore", ...guard, async (req, res) => {
  const l = await loadEditable(req, res);
  if (!l) return;
  const vid = parseId(req.params.vid);
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : null;
  if (!reason) { res.status(400).json({ error: "복원 사유를 입력해 주세요." }); return; }
  const [old] = vid ? await db.select().from(archiveDocumentVersionsTable)
    .where(and(eq(archiveDocumentVersionsTable.id, vid), eq(archiveDocumentVersionsTable.documentId, l.doc.id))) : [];
  if (!old) { res.status(404).json({ error: "버전을 찾을 수 없습니다." }); return; }
  const v = await addVersion({
    doc: l.doc, storageKey: old.storageKey, fileName: old.originalFileName, mime: old.mimeType ?? "application/octet-stream",
    size: old.fileSize ?? 0, hash: old.sha256 ?? "", text: old.extractedText, method: old.extractMethod ?? "restored",
    reason: `v${old.versionNo} 복원: ${reason}`, actorId: req.user!.id, submit: true, requestType: "restore_version",
  });
  await archiveAudit(req, "version_restore", { documentId: l.doc.id, versionId: v.versionId }, { fromVersionNo: old.versionNo, reason, status: v.status });
  res.status(201).json(v);
});

/** AI 재분석 — 분석 실패·확인 필요 자료(수정 권한자). 관리자가 수정한 폴더·제목·날짜는 보존 */
router.post("/archive/documents/:id/reanalyze", ...guard, async (req, res) => {
  const l = await loadEditable(req, res);
  if (!l) return;
  await db.update(archiveDocumentsTable).set({ aiStatus: "analyzing" }).where(eq(archiveDocumentsTable.id, l.doc.id));
  await archiveAudit(req, "ai_reanalyze", { documentId: l.doc.id });
  const aiStatus = await runArchiveClassification(l.doc.id, { actorId: req.user!.id, actorEmail: req.user!.email });
  res.json({ aiStatus });
});

router.post("/archive/documents/:id/versions/:vid/submit", ...guard, async (req, res) => {
  const l = await loadEditable(req, res);
  if (!l) return;
  const vid = parseId(req.params.vid);
  if (!vid) { res.status(400).json({ error: "잘못된 버전" }); return; }
  try {
    const approvalId = await requestReview(l.doc, vid, req.user!.id, req.body?.reason ? String(req.body.reason) : null);
    await archiveAudit(req, "approval_request", { documentId: l.doc.id, versionId: vid }, { approvalId });
    res.status(201).json({ approvalId });
  } catch (err) {
    if (err instanceof WorkflowError) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});

// ─── 서류양식 발급·작성본 등록(원본 표준양식은 변경되지 않음) ─────────────────

router.post("/archive/documents/:id/issue", ...guard, singleFile, async (req, res) => {
  const actor = req.archiveActor!;
  const id = parseId(req.params.id);
  const [tpl] = id ? await db.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, id)) : [];
  const ctx = await loadAclContext();
  if (!tpl || tpl.deletedAt) { res.status(404).json({ error: "양식을 찾을 수 없습니다." }); return; }
  const tActs = documentActions(actor, ctx, tpl);
  if (!canListDocument(actor, tActs, tpl) || !tActs.has("download")) { res.status(404).json({ error: "양식을 찾을 수 없습니다." }); return; }
  if (tpl.docType !== "form_template" && !tpl.isStandardForm) { res.status(400).json({ error: "표준양식에서만 발급본을 등록할 수 있습니다." }); return; }
  if (!actor.canUpload) { res.status(403).json({ error: "자료 등록 권한(archive.upload)이 없습니다." }); return; }
  const meta = parseMeta(req);
  const f = prepareFile(req, res, meta);
  if (!f) return;
  const folderId = parseId(meta.folderId) ?? tpl.folderId;
  if (!ctx.folders.has(folderId) || isFolderDeleted(ctx, folderId) || !folderActions(actor, ctx, folderId).has("upload")) {
    res.status(403).json({ error: "발급본을 저장할 폴더에 대한 권한이 없습니다." }); return;
  }
  const acl = aclFromVisibility(meta) ?? [{ subjectType: "no_inherit" }]; // 발급본 기본: 비공개
  try {
    const storageKey = await storeArchiveFile(f.buf, f.ext, f.mime);
    const ex = await extractForArchive(f.buf, f.fileName, f.ext);
    const fields = docFieldsFromMeta(meta);
    const [doc] = await db.insert(archiveDocumentsTable).values({
      ...fields, folderId, docType: "form_issued", isStandardForm: false, templateDocumentId: tpl.id,
      // 증명서·계약서 등 발급본은 기본 승인 대상(명시적으로 false 를 보낸 경우만 해제)
      requiresApproval: meta.requiresApproval !== false,
      title: (typeof meta.title === "string" && meta.title.trim()) ? meta.title.trim().slice(0, 500) : `${tpl.title} (작성본)`,
      aiStatus: ex.aiStatus, createdBy: actor.id, updatedBy: actor.id,
    }).returning();
    const aclRows = normalizeAclRows(acl, { documentId: doc.id }, actor.id);
    if (aclRows.length) await db.insert(archiveAclTable).values(aclRows);
    await insertLinks(doc.id, meta.links, actor.id);
    const v = await addVersion({
      doc, storageKey, fileName: f.fileName, mime: f.mime, size: f.buf.length, hash: f.hash, text: ex.text, method: ex.method,
      reason: `양식 「${tpl.title}」 기반 작성`, actorId: actor.id, submit: meta.submit !== false, requestType: "register",
      isAi: meta.isAiAuthored === true,
    });
    await archiveAudit(req, "form_issue", { documentId: tpl.id }, { issuedDocumentId: doc.id });
    await archiveAudit(req, "upload", { documentId: doc.id, versionId: v.versionId }, { fromTemplate: tpl.id, fileName: f.fileName });
    res.status(201).json({ documentId: doc.id, versionId: v.versionId, status: v.status, approvalId: v.approvalId });
  } catch (err) {
    req.log.error({ err }, "[archive] issue failed");
    res.status(500).json({ error: "발급본 등록 중 오류가 발생했습니다." });
  }
});

export default router;
