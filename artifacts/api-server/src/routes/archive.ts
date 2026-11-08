/**
 * 회사 자료보관함 API — 폴더·자료 목록/검색·상세·파일 제공·이동·삭제/복원/영구삭제.
 * 모든 엔드포인트: requireAuth → admin/staff → menu.archive → (자료별) ACL 판정.
 * 권한 없는 자료는 존재 여부도 노출하지 않도록 404 로 응답한다.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "node:stream";
import {
  db, usersTable, rolesTable, archiveFoldersTable, archiveDocumentsTable, archiveDocumentVersionsTable,
  archiveLinksTable, archiveApprovalsTable, archiveAclTable,
  companiesTable, contactsTable, quotesTable, inquiriesTable, projectsTable,
  type ArchiveDocument,
} from "@workspace/db";
import { and, eq, isNull, isNotNull, inArray, or, ilike, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getR2ObjectStream } from "../lib/r2";
import {
  loadAclContext, documentActions, folderActions, canListDocument, canSeeUnapproved, folderPath,
  folderDescendants, folderMenuKey, archiveAudit, isFolderDeleted, type AclContext, type ArchiveAction,
} from "../services/archiveAccess";
import {
  requireArchiveModule, DEFAULT_TAXONOMY, ARCHIVE_MENU_KEYS, DOC_TYPES, SECURITY_LEVELS, LINK_ENTITY_TYPES,
  isInlinePreviewable, resolveLinkLabels, parseId, ARCHIVE_MAX_FILE_SIZE, ARCHIVE_ALLOWED_EXTS,
} from "../services/archiveCommon";
import { purgeDocument, recentAudit } from "../services/archiveWorkflow";
import { latestAiAnalysis, REVIEW_FOLDER_NAME } from "../services/archiveClassify";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin", "staff"), requireArchiveModule];

// ─── 공통 헬퍼 ──────────────────────────────────────────────────────────────

type Loaded = { doc: ArchiveDocument; acts: Set<ArchiveAction>; ctx: AclContext };

/** 자료 로드 + 권한 확인. 실패 시 응답을 보내고 null. 삭제 자료는 allowDeleted 일 때만. */
async function loadDoc(req: Request, res: Response, need: ArchiveAction, opts: { allowDeleted?: boolean } = {}): Promise<Loaded | null> {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "잘못된 자료 ID" }); return null; }
  const actor = req.archiveActor!;
  const [doc] = await db.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, id));
  const ctx = await loadAclContext();
  if (!doc) { res.status(404).json({ error: "자료를 찾을 수 없습니다." }); return null; }
  const acts = documentActions(actor, ctx, doc);
  if (doc.deletedAt) {
    if (!opts.allowDeleted || !acts.has(need)) { res.status(404).json({ error: "자료를 찾을 수 없습니다." }); return null; }
    return { doc, acts, ctx };
  }
  if (!canListDocument(actor, acts, doc)) {
    await archiveAudit(req, "access_denied", { documentId: id }, { need });
    res.status(404).json({ error: "자료를 찾을 수 없습니다." });
    return null;
  }
  if (!acts.has(need)) {
    await archiveAudit(req, "access_denied", { documentId: id }, { need });
    res.status(403).json({ error: "이 자료에 대한 권한이 없습니다." });
    return null;
  }
  return { doc, acts, ctx };
}

/** 사용자가 받을 수 있는 버전 id 결정 (일반 열람자는 최신 승인본만) */
function resolveVersionId(req: Request, l: Loaded): number | null {
  const requested = parseId(req.query.versionId);
  const privileged = canSeeUnapproved(req.archiveActor!, l.acts, l.doc);
  if (requested) return requested === l.doc.approvedVersionId || privileged ? requested : -1;
  return l.doc.approvedVersionId ?? (privileged ? l.doc.currentVersionId : null);
}

function fileCategory(name: string | null | undefined): string {
  const ext = (name ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx"].includes(ext)) return "word";
  if (["xls", "xlsx", "csv"].includes(ext)) return "excel";
  if (["ppt", "pptx"].includes(ext)) return "ppt";
  if (["hwp", "hwpx"].includes(ext)) return "hwp";
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (["eml", "msg"].includes(ext)) return "email";
  if (ext === "txt") return "text";
  return "other";
}

// ─── 내 권한 / 메타 ─────────────────────────────────────────────────────────

router.get("/archive/me", ...guard, async (req, res) => {
  const a = req.archiveActor!;
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(archiveFoldersTable);
  res.json({
    userId: a.id, department: a.department, isSuper: a.isSuper, isArchiveAdmin: a.isArchiveAdmin,
    canUpload: a.canUpload, canApprove: a.canApprove, canPurge: a.canPurge,
    folderCount: c, maxFileSize: ARCHIVE_MAX_FILE_SIZE, allowedExtensions: ARCHIVE_ALLOWED_EXTS,
    docTypes: DOC_TYPES, securityLevels: SECURITY_LEVELS, menuKeys: ARCHIVE_MENU_KEYS, linkEntityTypes: LINK_ENTITY_TYPES,
  });
});

// ─── 폴더 ───────────────────────────────────────────────────────────────────

router.get("/archive/folders", ...guard, async (req, res) => {
  try {
    const actor = req.archiveActor!;
    const ctx = await loadAclContext();
    const all = [...ctx.folders.values()].filter(f => !f.deletedAt);   // 소프트 삭제 폴더는 탐색에서 제외(복원 목록은 /archive/folders/deleted)
    let visible: Set<number>;
    if (actor.isArchiveAdmin) {
      visible = new Set(all.map(f => f.id));
    } else {
      visible = new Set();
      const docs = await db.select({
        id: archiveDocumentsTable.id, folderId: archiveDocumentsTable.folderId, createdBy: archiveDocumentsTable.createdBy,
        approvedVersionId: archiveDocumentsTable.approvedVersionId, deletedAt: archiveDocumentsTable.deletedAt,
      }).from(archiveDocumentsTable).where(isNull(archiveDocumentsTable.deletedAt));
      for (const f of all) {
        if (!f.isActive) continue;
        const fa = folderActions(actor, ctx, f.id);
        if (fa.has("view") || fa.has("upload")) visible.add(f.id);
      }
      for (const d of docs) if (canListDocument(actor, documentActions(actor, ctx, d), d)) visible.add(d.folderId);
      // 상위 폴더 경로 포함(탐색용)
      for (const id of [...visible]) {
        let p = ctx.folders.get(id)?.parentId ?? null;
        while (p != null && !visible.has(p)) { visible.add(p); p = ctx.folders.get(p)?.parentId ?? null; }
      }
    }
    const counts = await db.select({ folderId: archiveDocumentsTable.folderId, c: sql<number>`count(*)::int` })
      .from(archiveDocumentsTable).where(isNull(archiveDocumentsTable.deletedAt)).groupBy(archiveDocumentsTable.folderId);
    const countMap = new Map(counts.map(c => [c.folderId, c.c]));
    res.json(all.filter(f => visible.has(f.id)).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id).map(f => ({
      ...f,
      effectiveMenuKey: folderMenuKey(ctx, f.id),
      path: folderPath(ctx, f.id),
      actions: [...folderActions(actor, ctx, f.id)],
      // 관리자에게만 폴더 직접 자료 수(권한 미적용 집계) 제공
      docCount: actor.isArchiveAdmin ? countMap.get(f.id) ?? 0 : undefined,
    })));
  } catch (err) {
    req.log.error({ err }, "[archive] folders failed");
    res.status(500).json({ error: "폴더 조회 실패" });
  }
});

router.post("/archive/folders/seed", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  if (!actor.isArchiveAdmin) { res.status(403).json({ error: "자료보관함 관리 권한이 필요합니다." }); return; }
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(archiveFoldersTable);
  if (c > 0) { res.status(409).json({ error: "이미 분류가 존재합니다. 기본 분류 생성은 최초 1회만 가능합니다." }); return; }
  await db.transaction(async (tx) => {
    let order = 0;
    for (const cat of DEFAULT_TAXONOMY) {
      const [root] = await tx.insert(archiveFoldersTable).values({
        name: cat.name, menuKey: cat.menuKey, sortOrder: (order += 10), isSystem: true, createdBy: actor.id,
      }).returning({ id: archiveFoldersTable.id });
      let sub = 0;
      for (const child of cat.children) {
        await tx.insert(archiveFoldersTable).values({ parentId: root.id, name: child, sortOrder: (sub += 10), isSystem: true, createdBy: actor.id });
      }
    }
  });
  await archiveAudit(req, "folder_seed", {}, { categories: DEFAULT_TAXONOMY.length });
  res.status(201).json({ ok: true });
});

function canManageFolder(req: Request, ctx: AclContext, folderId: number | null): boolean {
  const actor = req.archiveActor!;
  if (actor.isArchiveAdmin) return true;
  if (folderId == null) return false; // 최상위 분류 추가는 관리자만
  return folderActions(actor, ctx, folderId).has("manage");
}

const normName = (n: string) => n.trim().replace(/\s+/g, " ").toLowerCase();
/** 같은 상위 폴더(삭제 제외)에 같은 이름이 있는지 — 공백·대소문자 무시. 기존 중복 데이터는 건드리지 않고 신규 생성·변경만 차단. */
function siblingNameTaken(ctx: AclContext, parentId: number | null, name: string, excludeId?: number): boolean {
  const n = normName(name);
  for (const f of ctx.folders.values()) {
    if (f.deletedAt || f.id === excludeId) continue;
    if ((f.parentId ?? null) === parentId && normName(f.name) === n) return true;
  }
  return false;
}
/** AI 「분류 확인 필요」 시스템 폴더 — 이름으로 조회되므로 이름 변경·비활성화·삭제 금지(이동·순서 변경은 허용). */
const isReviewFolder = (ctx: AclContext, id: number) => ctx.folders.get(id)?.name === REVIEW_FOLDER_NAME;
const folderSnapshot = (ctx: AclContext, id: number) => {
  const f = ctx.folders.get(id);
  return f ? { name: f.name, parentId: f.parentId, path: folderPath(ctx, id), sortOrder: f.sortOrder, isActive: f.isActive, menuKey: f.menuKey } : null;
};
const DUP_NAME_ERROR = "같은 위치에 동일한 이름의 폴더가 이미 있습니다.";

router.post("/archive/folders", ...guard, async (req, res) => {
  const ctx = await loadAclContext();
  const parentId = req.body?.parentId == null ? null : parseId(req.body.parentId);
  const name = String(req.body?.name ?? "").trim();
  if (!name || name.length > 200) { res.status(400).json({ error: "폴더명을 입력해 주세요(200자 이내)." }); return; }
  if (parentId != null && (!ctx.folders.has(parentId) || isFolderDeleted(ctx, parentId))) { res.status(400).json({ error: "상위 폴더가 없습니다." }); return; }
  if (!canManageFolder(req, ctx, parentId)) { res.status(403).json({ error: "폴더를 추가할 권한이 없습니다." }); return; }
  if (siblingNameTaken(ctx, parentId, name)) { res.status(409).json({ error: DUP_NAME_ERROR, code: "name_conflict" }); return; }
  const menuKey = req.body?.menuKey && (ARCHIVE_MENU_KEYS as readonly string[]).includes(req.body.menuKey) ? req.body.menuKey : null;
  const [f] = await db.insert(archiveFoldersTable).values({
    parentId, name, menuKey, description: req.body?.description ? String(req.body.description) : null,
    sortOrder: Number(req.body?.sortOrder) || 0, createdBy: req.user!.id,
  }).returning();
  await archiveAudit(req, "folder_create", { folderId: f.id }, { name, parentId, parentPath: parentId != null ? folderPath(ctx, parentId) : null });
  res.status(201).json(f);
});

router.patch("/archive/folders/:id", ...guard, async (req, res) => {
  const id = parseId(req.params.id);
  const ctx = await loadAclContext();
  if (!id || !ctx.folders.has(id) || isFolderDeleted(ctx, id)) { res.status(404).json({ error: "폴더를 찾을 수 없습니다." }); return; }
  if (!canManageFolder(req, ctx, id)) { res.status(403).json({ error: "폴더를 수정할 권한이 없습니다." }); return; }
  const before = folderSnapshot(ctx, id);
  const cur = ctx.folders.get(id)!;
  const patch: Partial<typeof archiveFoldersTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof req.body?.name === "string" && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 200);
  if (req.body?.description !== undefined) patch.description = req.body.description ? String(req.body.description) : null;
  if (req.body?.sortOrder !== undefined) patch.sortOrder = Number(req.body.sortOrder) || 0;
  if (req.body?.menuKey !== undefined) {
    patch.menuKey = req.body.menuKey && (ARCHIVE_MENU_KEYS as readonly string[]).includes(req.body.menuKey) ? req.body.menuKey : null;
  }
  if (typeof req.body?.isActive === "boolean") patch.isActive = req.body.isActive;
  if (isReviewFolder(ctx, id) && ((patch.name !== undefined && patch.name !== cur.name) || patch.isActive === false)) {
    res.status(400).json({ error: `「${REVIEW_FOLDER_NAME}」 폴더는 AI 자동 분류용 시스템 폴더라 이름 변경·비활성화할 수 없습니다.` }); return;
  }
  if (req.body?.parentId !== undefined) {
    const newParent = req.body.parentId == null ? null : parseId(req.body.parentId);
    if (newParent != null) {
      if (!ctx.folders.has(newParent) || isFolderDeleted(ctx, newParent)) { res.status(400).json({ error: "대상 상위 폴더가 없습니다." }); return; }
      if (folderDescendants(ctx, id).has(newParent)) { res.status(400).json({ error: "자기 자신 또는 하위 폴더로 이동할 수 없습니다." }); return; }
    }
    if (!canManageFolder(req, ctx, newParent)) { res.status(403).json({ error: "대상 위치에 대한 권한이 없습니다." }); return; }
    patch.parentId = newParent;
  }
  // 이름·위치가 바뀌는 경우에만 같은 상위 폴더 내 중복 이름 차단(기존 중복은 유지)
  const nextParent = patch.parentId !== undefined ? patch.parentId ?? null : cur.parentId ?? null;
  const nextName = patch.name ?? cur.name;
  if ((patch.name !== undefined && normName(patch.name) !== normName(cur.name)) || nextParent !== (cur.parentId ?? null)) {
    if (siblingNameTaken(ctx, nextParent, nextName, id)) { res.status(409).json({ error: DUP_NAME_ERROR, code: "name_conflict" }); return; }
  }
  const moved = patch.parentId !== undefined && nextParent !== (cur.parentId ?? null);
  const [f] = await db.update(archiveFoldersTable).set(patch).where(eq(archiveFoldersTable.id, id)).returning();
  const after = await loadAclContext().then(c => folderSnapshot(c, id));
  await archiveAudit(req, moved ? "folder_move" : "folder_update", { folderId: id }, { before, after, patch });
  res.json(f);
});

// ─── 폴더 순서 변경 · 삭제(소프트) · 복원 ───────────────────────────────────────

/** 같은 상위 폴더 안에서 위/아래로 한 칸 이동 — 형제 순서를 10 단위로 재번호(감사로그 1건). */
router.post("/archive/folders/:id/reorder", ...guard, async (req, res) => {
  const id = parseId(req.params.id);
  const ctx = await loadAclContext();
  if (!id || !ctx.folders.has(id) || isFolderDeleted(ctx, id)) { res.status(404).json({ error: "폴더를 찾을 수 없습니다." }); return; }
  if (!canManageFolder(req, ctx, id)) { res.status(403).json({ error: "폴더 순서를 변경할 권한이 없습니다." }); return; }
  const dir = req.body?.direction;
  if (dir !== "up" && dir !== "down") { res.status(400).json({ error: "direction 은 up 또는 down 이어야 합니다." }); return; }
  const parentId = ctx.folders.get(id)!.parentId ?? null;
  const siblings = [...ctx.folders.values()].filter(f => !f.deletedAt && (f.parentId ?? null) === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const idx = siblings.findIndex(f => f.id === id);
  const swap = dir === "up" ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= siblings.length) { res.json({ ok: true, unchanged: true }); return; }
  const before = siblings.map(f => ({ id: f.id, name: f.name, sortOrder: f.sortOrder }));
  [siblings[idx], siblings[swap]] = [siblings[swap], siblings[idx]];
  const now = new Date();
  await db.transaction(async (tx) => {
    for (let i = 0; i < siblings.length; i++) {
      const order = (i + 1) * 10;
      if (siblings[i].sortOrder !== order) await tx.update(archiveFoldersTable).set({ sortOrder: order, updatedAt: now }).where(eq(archiveFoldersTable.id, siblings[i].id));
    }
  });
  await archiveAudit(req, "folder_reorder", { folderId: id }, {
    direction: dir, parentPath: parentId != null ? folderPath(ctx, parentId) : null,
    before, after: siblings.map((f, i) => ({ id: f.id, name: f.name, sortOrder: (i + 1) * 10 })),
  });
  res.json({ ok: true });
});

/** 삭제 영향 범위 — 하위 폴더(삭제 제외)·소속 문서·휴지통 문서·폴더 권한 수. 삭제 가능 여부와 사유를 함께 반환. */
async function folderDeleteImpact(ctx: AclContext, id: number) {
  const childFolders = [...ctx.folders.values()].filter(f => f.parentId === id && !f.deletedAt);
  const [counts] = await db.select({
    active: sql<number>`count(*) filter (where ${archiveDocumentsTable.deletedAt} is null)::int`,
    trashed: sql<number>`count(*) filter (where ${archiveDocumentsTable.deletedAt} is not null)::int`,
  }).from(archiveDocumentsTable).where(eq(archiveDocumentsTable.folderId, id));
  const [acl] = await db.select({ c: sql<number>`count(*)::int` }).from(archiveAclTable).where(eq(archiveAclTable.folderId, id));
  const reasons: string[] = [];
  if (childFolders.length) reasons.push(`하위 폴더 ${childFolders.length}개가 있습니다. 먼저 다른 위치로 이동하거나 삭제해 주세요.`);
  if (counts.active) reasons.push(`자료 ${counts.active}건이 있습니다. 먼저 다른 폴더로 이동해 주세요.`);
  if (counts.trashed) reasons.push(`휴지통에 이 폴더 소속 자료 ${counts.trashed}건이 있습니다. 복원 후 이동하거나 휴지통에서 정리해 주세요.`);
  if (isReviewFolder(ctx, id)) reasons.push(`「${REVIEW_FOLDER_NAME}」 폴더는 AI 자동 분류용 시스템 폴더라 삭제할 수 없습니다.`);
  return {
    folderId: id, path: folderPath(ctx, id),
    childFolderCount: childFolders.length, childFolders: childFolders.map(f => f.name).slice(0, 20),
    documentCount: counts.active, trashedDocumentCount: counts.trashed, aclCount: acl.c,
    canDelete: reasons.length === 0, reasons,
  };
}

router.get("/archive/folders/:id/delete-check", ...guard, async (req, res) => {
  if (!req.archiveActor!.isArchiveAdmin) { res.status(403).json({ error: "폴더 삭제는 자료보관함 관리자만 할 수 있습니다." }); return; }
  const id = parseId(req.params.id);
  const ctx = await loadAclContext();
  if (!id || !ctx.folders.has(id) || isFolderDeleted(ctx, id)) { res.status(404).json({ error: "폴더를 찾을 수 없습니다." }); return; }
  res.json(await folderDeleteImpact(ctx, id));
});

router.delete("/archive/folders/:id", ...guard, async (req, res) => {
  if (!req.archiveActor!.isArchiveAdmin) { res.status(403).json({ error: "폴더 삭제는 자료보관함 관리자만 할 수 있습니다." }); return; }
  const id = parseId(req.params.id);
  const ctx = await loadAclContext();
  if (!id || !ctx.folders.has(id) || isFolderDeleted(ctx, id)) { res.status(404).json({ error: "폴더를 찾을 수 없습니다." }); return; }
  const impact = await folderDeleteImpact(ctx, id);
  if (!impact.canDelete) { res.status(409).json({ error: impact.reasons.join(" "), code: "folder_not_empty", impact }); return; }
  const before = folderSnapshot(ctx, id);
  // 소프트 삭제만 — 폴더 행·폴더 권한(ACL)·감사로그는 그대로 보존(복원 시 원상태)
  await db.update(archiveFoldersTable).set({ deletedAt: new Date(), deletedBy: req.user!.id, updatedAt: new Date() })
    .where(and(eq(archiveFoldersTable.id, id), isNull(archiveFoldersTable.deletedAt)));
  await archiveAudit(req, "folder_delete", { folderId: id }, { before, aclPreserved: impact.aclCount, reason: req.body?.reason ?? null });
  res.json({ ok: true });
});

router.get("/archive/folders/deleted", ...guard, async (req, res) => {
  if (!req.archiveActor!.isArchiveAdmin) { res.status(403).json({ error: "자료보관함 관리 권한이 필요합니다." }); return; }
  const ctx = await loadAclContext();
  const rows = await db.select({ id: archiveFoldersTable.id, deletedAt: archiveFoldersTable.deletedAt, deletedBy: archiveFoldersTable.deletedBy, name: usersTable.name, email: usersTable.email })
    .from(archiveFoldersTable).leftJoin(usersTable, eq(archiveFoldersTable.deletedBy, usersTable.id))
    .where(isNotNull(archiveFoldersTable.deletedAt)).orderBy(desc(archiveFoldersTable.deletedAt));
  res.json(rows.map(r => {
    const f = ctx.folders.get(r.id)!;
    const parentId = f.parentId ?? null;
    const parentAvailable = parentId == null || (ctx.folders.has(parentId) && !isFolderDeleted(ctx, parentId));
    return {
      id: r.id, name: f.name, parentId, originalPath: folderPath(ctx, r.id),
      deletedAt: r.deletedAt, deletedByName: r.name, deletedByEmail: r.email,
      parentAvailable, nameConflict: parentAvailable ? siblingNameTaken(ctx, parentId, f.name, r.id) : false,
    };
  }));
});

/**
 * 폴더 복원 — 원래 위치·이름으로. 충돌(상위 폴더가 삭제됨 / 같은 이름 존재)이면 409 로 알리고,
 * 관리자가 parentId·name 을 지정해 다시 요청하면 그 위치·이름으로 복원한다(자동 변경 없음).
 */
router.post("/archive/folders/:id/restore", ...guard, async (req, res) => {
  if (!req.archiveActor!.isArchiveAdmin) { res.status(403).json({ error: "폴더 복원은 자료보관함 관리자만 할 수 있습니다." }); return; }
  const id = parseId(req.params.id);
  const ctx = await loadAclContext();
  if (!id || !ctx.folders.has(id) || !isFolderDeleted(ctx, id)) { res.status(404).json({ error: "삭제된 폴더를 찾을 수 없습니다." }); return; }
  const f = ctx.folders.get(id)!;
  const overrideParent = req.body?.parentId !== undefined;
  const parentId = overrideParent ? (req.body.parentId == null ? null : parseId(req.body.parentId)) : f.parentId ?? null;
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 200) : f.name;
  if (parentId != null && (!ctx.folders.has(parentId) || isFolderDeleted(ctx, parentId))) {
    res.status(409).json({ error: overrideParent ? "선택한 상위 폴더를 사용할 수 없습니다." : "원래 상위 폴더가 삭제되어 있습니다. 복원할 위치를 선택해 주세요.", code: "parent_unavailable" });
    return;
  }
  if (parentId != null && folderDescendants(ctx, id).has(parentId)) { res.status(400).json({ error: "자기 자신 또는 하위 폴더 아래로 복원할 수 없습니다." }); return; }
  if (siblingNameTaken(ctx, parentId, name, id)) {
    res.status(409).json({ error: `복원 위치에 같은 이름(「${name}」)의 폴더가 있습니다. 새 이름을 지정해 주세요.`, code: "name_conflict" });
    return;
  }
  const before = { ...folderSnapshot(ctx, id), deletedAt: f.deletedAt };
  await db.update(archiveFoldersTable).set({ deletedAt: null, deletedBy: null, parentId, name, updatedAt: new Date() })
    .where(eq(archiveFoldersTable.id, id));
  const after = await loadAclContext().then(c => folderSnapshot(c, id));
  await archiveAudit(req, "folder_restore", { folderId: id }, { before, after });
  res.json({ ok: true });
});

// ─── 자료 목록·검색 ─────────────────────────────────────────────────────────

router.get("/archive/documents", ...guard, async (req, res) => {
  try {
    const actor = req.archiveActor!;
    const ctx = await loadAclContext();
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
    const conds = [isNull(archiveDocumentsTable.deletedAt)];

    const folderId = parseId(req.query.folderId);
    if (folderId) {
      const ids = req.query.includeSub === "0" ? new Set([folderId]) : folderDescendants(ctx, folderId);
      conds.push(inArray(archiveDocumentsTable.folderId, [...ids]));
    }
    const menu = typeof req.query.menu === "string" ? req.query.menu : "";
    if (menu && (ARCHIVE_MENU_KEYS as readonly string[]).includes(menu)) {
      const ids = [...ctx.folders.keys()].filter(fid => folderMenuKey(ctx, fid) === menu);
      if (menu === "forms") {
        // 서류양식: 서류양식 분류 폴더 + 자료유형이 양식인 자료
        conds.push(or(
          ids.length ? inArray(archiveDocumentsTable.folderId, ids) : sql`false`,
          inArray(archiveDocumentsTable.docType, ["form_template", "form_issued"]),
        )!);
      } else {
        conds.push(ids.length ? inArray(archiveDocumentsTable.folderId, ids) : sql`false`);
      }
    }
    const str = (k: string) => (typeof req.query[k] === "string" && req.query[k] ? String(req.query[k]) : null);
    if (str("docType")) conds.push(eq(archiveDocumentsTable.docType, str("docType")!));
    if (str("status")) conds.push(eq(archiveDocumentsTable.status, str("status")!));
    if (str("securityLevel")) conds.push(eq(archiveDocumentsTable.securityLevel, str("securityLevel")!));
    if (parseId(req.query.createdBy)) conds.push(eq(archiveDocumentsTable.createdBy, parseId(req.query.createdBy)!));
    if (str("author")) conds.push(ilike(archiveDocumentsTable.authorName, `%${str("author")}%`));
    if (req.query.standardOnly === "1") conds.push(eq(archiveDocumentsTable.isStandardForm, true));
    const dateCol = req.query.dateField === "updated" ? archiveDocumentsTable.updatedAt : archiveDocumentsTable.createdAt;
    if (str("dateFrom")) conds.push(sql`${dateCol} >= ${str("dateFrom")}::date`);
    if (str("dateTo")) conds.push(sql`${dateCol} < (${str("dateTo")}::date + interval '1 day')`);

    const docs = await db.select({
      doc: archiveDocumentsTable,
      createdByName: usersTable.name,
      createdByEmail: usersTable.email,
    }).from(archiveDocumentsTable)
      .leftJoin(usersTable, eq(archiveDocumentsTable.createdBy, usersTable.id))
      .where(and(...conds));

    // 권한 필터
    let rows = docs.map(r => ({ ...r, acts: documentActions(actor, ctx, r.doc) }))
      .filter(r => canListDocument(actor, r.acts, r.doc));

    // 통합 검색(메타·파일명·본문·관련 거래처/담당자/업무번호)
    if (q && rows.length) {
      const like = `%${q}%`;
      const candidateIds = rows.map(r => r.doc.id);
      const metaHit = new Set(rows.filter(r => [r.doc.title, r.doc.description, r.doc.keywords, r.doc.authorName, r.doc.ownerDepartment, r.doc.aiSummary]
        .some(v => v && v.toLowerCase().includes(q.toLowerCase()))).map(r => r.doc.id));
      const verHits = await db.select({
        documentId: archiveDocumentVersionsTable.documentId, id: archiveDocumentVersionsTable.id,
      }).from(archiveDocumentVersionsTable).where(and(
        inArray(archiveDocumentVersionsTable.documentId, candidateIds),
        or(ilike(archiveDocumentVersionsTable.originalFileName, like), ilike(archiveDocumentVersionsTable.extractedText, like)),
      ));
      const linkHits = await db.select({ documentId: archiveLinksTable.documentId }).from(archiveLinksTable)
        .leftJoin(companiesTable, and(eq(archiveLinksTable.entityType, "company"), eq(companiesTable.id, archiveLinksTable.entityId)))
        .leftJoin(contactsTable, and(eq(archiveLinksTable.entityType, "contact"), eq(contactsTable.id, archiveLinksTable.entityId)))
        .leftJoin(quotesTable, and(eq(archiveLinksTable.entityType, "quote"), eq(quotesTable.id, archiveLinksTable.entityId)))
        .leftJoin(inquiriesTable, and(eq(archiveLinksTable.entityType, "inquiry"), eq(inquiriesTable.id, archiveLinksTable.entityId)))
        .leftJoin(projectsTable, and(eq(archiveLinksTable.entityType, "project"), eq(projectsTable.id, archiveLinksTable.entityId)))
        .where(and(inArray(archiveLinksTable.documentId, candidateIds), or(
          ilike(companiesTable.name, like), ilike(contactsTable.name, like), ilike(quotesTable.quoteNumber, like),
          ilike(inquiriesTable.inquiryNumber, like), ilike(projectsTable.title, like),
          sql`${archiveLinksTable.entityId}::text = ${q}`,
        )));
      const linkHit = new Set(linkHits.map(l => l.documentId));
      const byId = new Map(rows.map(r => [r.doc.id, r]));
      const verHit = new Set<number>();
      for (const v of verHits) {
        const r = byId.get(v.documentId);
        if (!r) continue;
        // 일반 열람자는 승인본 본문만 검색 대상
        if (v.id === r.doc.approvedVersionId || canSeeUnapproved(actor, r.acts, r.doc)) verHit.add(v.documentId);
      }
      rows = rows.filter(r => metaHit.has(r.doc.id) || verHit.has(r.doc.id) || linkHit.has(r.doc.id));
    }

    // 표시 버전 정보
    const shownVersionId = (r: typeof rows[number]) =>
      canSeeUnapproved(actor, r.acts, r.doc) ? (r.doc.currentVersionId ?? r.doc.approvedVersionId) : r.doc.approvedVersionId;
    const vIds = rows.map(shownVersionId).filter((x): x is number => !!x);
    const versions = vIds.length ? await db.select({
      id: archiveDocumentVersionsTable.id, versionNo: archiveDocumentVersionsTable.versionNo,
      fileName: archiveDocumentVersionsTable.originalFileName, mimeType: archiveDocumentVersionsTable.mimeType,
      fileSize: archiveDocumentVersionsTable.fileSize, status: archiveDocumentVersionsTable.status,
    }).from(archiveDocumentVersionsTable).where(inArray(archiveDocumentVersionsTable.id, vIds)) : [];
    const vMap = new Map(versions.map(v => [v.id, v]));

    const fileType = str("fileType");
    let items = rows.map(r => {
      const v = vMap.get(shownVersionId(r) ?? -1);
      return {
        id: r.doc.id, title: r.doc.title, docType: r.doc.docType, folderId: r.doc.folderId,
        folderPath: folderPath(ctx, r.doc.folderId), status: r.doc.status, securityLevel: r.doc.securityLevel,
        isStandardForm: r.doc.isStandardForm, aiAllowed: r.doc.aiAllowed, requiresApproval: r.doc.requiresApproval,
        ownerDepartment: r.doc.ownerDepartment, authorName: r.doc.authorName, documentDate: r.doc.documentDate,
        expiresAt: r.doc.expiresAt, createdAt: r.doc.createdAt, updatedAt: r.doc.updatedAt,
        createdByName: r.createdByName || r.createdByEmail || null,
        hasApprovedVersion: !!r.doc.approvedVersionId, aiStatus: r.doc.aiStatus,
        fileName: v?.fileName ?? null, mimeType: v?.mimeType ?? null, fileSize: v?.fileSize ?? null,
        versionNo: v?.versionNo ?? null, versionStatus: v?.status ?? null,
        fileCategory: fileCategory(v?.fileName),
        actions: [...r.acts],
      };
    });
    if (fileType) items = items.filter(i => i.fileCategory === fileType);

    const sort = req.query.sort === "name" ? "name" : req.query.sort === "oldest" ? "oldest" : "latest";
    items.sort((a, b) => sort === "name" ? a.title.localeCompare(b.title, "ko")
      : sort === "oldest" ? +new Date(a.updatedAt) - +new Date(b.updatedAt)
        : +new Date(b.updatedAt) - +new Date(a.updatedAt));

    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    if (q) await archiveAudit(req, "search", {}, { q, resultCount: items.length });
    res.json({ total: items.length, page, pageSize, items: items.slice((page - 1) * pageSize, page * pageSize) });
  } catch (err) {
    req.log.error({ err }, "[archive] list failed");
    res.status(500).json({ error: "자료 조회 실패" });
  }
});

// ─── 자료 상세 ──────────────────────────────────────────────────────────────

router.get("/archive/documents/:id", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "view");
  if (!l) return;
  const { doc, acts, ctx } = l;
  const actor = req.archiveActor!;
  const privileged = canSeeUnapproved(actor, acts, doc);
  const versions = await db.select({
    id: archiveDocumentVersionsTable.id, versionNo: archiveDocumentVersionsTable.versionNo,
    fileName: archiveDocumentVersionsTable.originalFileName, mimeType: archiveDocumentVersionsTable.mimeType,
    fileSize: archiveDocumentVersionsTable.fileSize, sha256: archiveDocumentVersionsTable.sha256,
    status: archiveDocumentVersionsTable.status, changeReason: archiveDocumentVersionsTable.changeReason,
    createdAt: archiveDocumentVersionsTable.createdAt, approvedAt: archiveDocumentVersionsTable.approvedAt,
    extractMethod: archiveDocumentVersionsTable.extractMethod,
    hasText: sql<boolean>`${archiveDocumentVersionsTable.extractedText} is not null and length(${archiveDocumentVersionsTable.extractedText}) > 0`,
    createdByName: usersTable.name, createdByEmail: usersTable.email, approvedBy: archiveDocumentVersionsTable.approvedBy,
  }).from(archiveDocumentVersionsTable).leftJoin(usersTable, eq(archiveDocumentVersionsTable.createdBy, usersTable.id))
    .where(eq(archiveDocumentVersionsTable.documentId, doc.id)).orderBy(desc(archiveDocumentVersionsTable.versionNo));
  const visibleVersions = privileged ? versions : versions.filter(v => v.id === doc.approvedVersionId);

  const links = await db.select().from(archiveLinksTable).where(eq(archiveLinksTable.documentId, doc.id));
  const labels = await resolveLinkLabels(links);

  const approvals = await db.select({
    a: archiveApprovalsTable, requesterName: usersTable.name, requesterEmail: usersTable.email,
  }).from(archiveApprovalsTable).leftJoin(usersTable, eq(archiveApprovalsTable.requestedBy, usersTable.id))
    .where(eq(archiveApprovalsTable.documentId, doc.id)).orderBy(desc(archiveApprovalsTable.requestedAt));
  const deciderIds = [...new Set(approvals.map(a => a.a.decidedBy).filter((x): x is number => !!x))];
  const deciders = deciderIds.length ? await db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, deciderIds)) : [];
  const deciderMap = new Map(deciders.map(d => [d.id, d.name || d.email]));

  const [creator] = doc.createdBy ? await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, doc.createdBy)) : [];
  let template: { id: number; title: string } | null = null;
  if (doc.templateDocumentId) {
    const [t] = await db.select({ id: archiveDocumentsTable.id, title: archiveDocumentsTable.title, folderId: archiveDocumentsTable.folderId, createdBy: archiveDocumentsTable.createdBy, approvedVersionId: archiveDocumentsTable.approvedVersionId, deletedAt: archiveDocumentsTable.deletedAt })
      .from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, doc.templateDocumentId));
    if (t && canListDocument(actor, documentActions(actor, ctx, t), t)) template = { id: t.id, title: t.title };
  }
  // 표준양식이면 발급·작성 이력(권한 있는 것만)
  let issued: Array<{ id: number; title: string; status: string; createdAt: Date }> = [];
  if (doc.docType === "form_template" || doc.isStandardForm) {
    const rows = await db.select().from(archiveDocumentsTable)
      .where(and(eq(archiveDocumentsTable.templateDocumentId, doc.id), isNull(archiveDocumentsTable.deletedAt)));
    issued = rows.filter(r => canListDocument(actor, documentActions(actor, ctx, r), r))
      .map(r => ({ id: r.id, title: r.title, status: r.status, createdAt: r.createdAt }));
  }

  const showAudit = actor.isArchiveAdmin || acts.has("manage");
  const audit = showAudit ? await recentAudit(doc.id, 100) : [];
  const showAcl = acts.has("manage");
  const acl = showAcl ? await db.select().from(archiveAclTable).where(eq(archiveAclTable.documentId, doc.id)) : [];

  await archiveAudit(req, "view", { documentId: doc.id });
  // AI 등록 분석(요약·키워드·분류 근거)은 등록 처리 결과이므로 열람 권한자에게 표시. AI 직원 업무 활용 여부(aiAllowed)와는 별개.
  const aiAnalysis = await latestAiAnalysis(doc.id);
  res.json({
    ...doc,
    aiAnalysis,
    folderPath: folderPath(ctx, doc.folderId),
    createdByName: creator?.name || creator?.email || null,
    actions: [...acts],
    canSeeUnapproved: privileged,
    canApproveHere: actor.canApprove,
    versions: visibleVersions.map(v => ({ ...v, createdByName: v.createdByName || v.createdByEmail, inlinePreview: isInlinePreviewable(v.mimeType) })),
    links: links.map(x => ({ ...x, label: labels.get(`${x.entityType}:${x.entityId}`) })),
    approvals: privileged ? approvals.map(a => ({
      ...a.a, requesterName: a.requesterName || a.requesterEmail, deciderName: a.a.decidedBy ? deciderMap.get(a.a.decidedBy) ?? null : null,
    })) : [],
    template, issued,
    audit: showAudit ? audit : null,
    acl: showAcl ? acl : null,
  });
});

// ─── 메타 수정 ──────────────────────────────────────────────────────────────

router.patch("/archive/documents/:id", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "edit");
  if (!l) return;
  const b = req.body ?? {};
  const patch: Partial<typeof archiveDocumentsTable.$inferInsert> = {};
  const strOrNull = (v: unknown) => (v === null || v === "" ? null : String(v));
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 500);
  for (const k of ["description", "keywords", "authorName", "ownerDepartment"] as const) if (b[k] !== undefined) patch[k] = strOrNull(b[k]);
  for (const k of ["documentDate", "retentionUntil", "expiresAt"] as const) {
    if (b[k] !== undefined) {
      const v = strOrNull(b[k]);
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { res.status(400).json({ error: `${k} 날짜 형식(YYYY-MM-DD) 오류` }); return; }
      patch[k] = v;
    }
  }
  if (b.docType !== undefined && (DOC_TYPES as readonly string[]).includes(b.docType)) patch.docType = b.docType;
  if (b.securityLevel !== undefined && (SECURITY_LEVELS as readonly string[]).includes(b.securityLevel)) patch.securityLevel = b.securityLevel;
  if (typeof b.aiAllowed === "boolean") patch.aiAllowed = b.aiAllowed;
  if (typeof b.requiresApproval === "boolean") patch.requiresApproval = b.requiresApproval;
  if (typeof b.isStandardForm === "boolean") patch.isStandardForm = b.isStandardForm;
  // 승인 정책 완화(승인필요 해제·표준양식 해제)는 승인권자/관리자만
  const actor = req.archiveActor!;
  // AI 직원 업무 활용 허용·공식 서식/매뉴얼(표준) 지정은 관리자 승인 사항 — 승인권자/관리자만 켤 수 있다
  if ((patch.aiAllowed === true && !l.doc.aiAllowed) || (patch.isStandardForm === true && !l.doc.isStandardForm)) {
    if (!actor.canApprove && !actor.isArchiveAdmin) { res.status(403).json({ error: "AI 활용 허용·공식 문서 지정은 관리자 승인 권한이 필요합니다." }); return; }
  }
  if ((patch.requiresApproval === false && l.doc.requiresApproval) || (patch.isStandardForm === false && l.doc.isStandardForm)) {
    if (!actor.canApprove && !actor.isArchiveAdmin) { res.status(403).json({ error: "승인 정책 해제는 승인권자만 가능합니다." }); return; }
  }
  if (!Object.keys(patch).length) { res.status(400).json({ error: "변경할 항목이 없습니다." }); return; }
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) before[k] = (l.doc as any)[k];
  const [d] = await db.update(archiveDocumentsTable).set({ ...patch, updatedAt: new Date(), updatedBy: req.user!.id })
    .where(eq(archiveDocumentsTable.id, l.doc.id)).returning();
  await archiveAudit(req, "update", { documentId: l.doc.id }, { before, after: patch });
  res.json(d);
});

/** 폐기 — 승인 필요 자료는 승인요청, 아니면 즉시 */
router.post("/archive/documents/:id/discard", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "edit");
  if (!l) return;
  if (l.doc.status === "discarded") { res.status(409).json({ error: "이미 폐기된 자료입니다." }); return; }
  const reason = req.body?.reason ? String(req.body.reason) : null;
  const actor = req.archiveActor!;
  if ((l.doc.requiresApproval || l.doc.isStandardForm) && !actor.isSuper) {
    const [a] = await db.insert(archiveApprovalsTable).values({
      documentId: l.doc.id, requestType: "status_change", payload: { from: l.doc.status, to: "discarded" }, reason, requestedBy: actor.id,
    }).returning();
    await archiveAudit(req, "approval_request", { documentId: l.doc.id }, { type: "status_change", approvalId: a.id });
    res.status(202).json({ pendingApproval: true, approvalId: a.id });
    return;
  }
  await db.update(archiveDocumentsTable).set({ status: "discarded", updatedAt: new Date(), updatedBy: actor.id }).where(eq(archiveDocumentsTable.id, l.doc.id));
  await archiveAudit(req, "discard", { documentId: l.doc.id }, { reason });
  res.json({ ok: true });
});

router.post("/archive/documents/:id/move", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "edit");
  if (!l) return;
  const target = parseId(req.body?.folderId);
  if (!target || !l.ctx.folders.has(target) || isFolderDeleted(l.ctx, target)) { res.status(400).json({ error: "대상 폴더가 없습니다." }); return; }
  if (!l.ctx.folders.get(target)!.isActive) { res.status(400).json({ error: "비활성 폴더로 이동할 수 없습니다." }); return; }
  if (!folderActions(req.archiveActor!, l.ctx, target).has("upload")) { res.status(403).json({ error: "대상 폴더에 자료를 둘 권한이 없습니다." }); return; }
  await db.update(archiveDocumentsTable).set({ folderId: target, updatedAt: new Date(), updatedBy: req.user!.id }).where(eq(archiveDocumentsTable.id, l.doc.id));
  await archiveAudit(req, "move", { documentId: l.doc.id, folderId: target }, {
    from: folderPath(l.ctx, l.doc.folderId), to: folderPath(l.ctx, target),
  });
  res.json({ ok: true });
});

// ─── 파일 제공(권한 검증 후 서버 스트리밍만) ──────────────────────────────────

router.get("/archive/documents/:id/file", ...guard, async (req, res) => {
  const inline = req.query.disposition === "inline";
  const l = await loadDoc(req, res, inline ? "preview" : "download");
  if (!l) return;
  const vid = resolveVersionId(req, l);
  if (vid === -1) { res.status(403).json({ error: "승인되지 않은 버전에 대한 권한이 없습니다." }); return; }
  if (!vid) { res.status(404).json({ error: "제공 가능한 승인 버전이 없습니다." }); return; }
  const [v] = await db.select().from(archiveDocumentVersionsTable)
    .where(and(eq(archiveDocumentVersionsTable.id, vid), eq(archiveDocumentVersionsTable.documentId, l.doc.id)));
  if (!v) { res.status(404).json({ error: "버전을 찾을 수 없습니다." }); return; }
  try {
    const obj = await getR2ObjectStream(v.storageKey);
    await archiveAudit(req, inline ? "preview" : "download", { documentId: l.doc.id, versionId: v.id }, { fileName: v.originalFileName });
    res.setHeader("Content-Type", v.mimeType || obj.contentType);
    if (obj.contentLength != null) res.setHeader("Content-Length", String(obj.contentLength));
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(v.originalFileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    Readable.fromWeb(obj.body as any).pipe(res);
  } catch (err) {
    req.log.error({ err, documentId: l.doc.id }, "[archive] file stream failed");
    res.status(502).json({ error: "파일을 불러오지 못했습니다." });
  }
});

/** 추출 텍스트(Office 등 원본 렌더링 불가 형식의 미리보기) */
router.get("/archive/documents/:id/text", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "preview");
  if (!l) return;
  const vid = resolveVersionId(req, l);
  if (vid === -1) { res.status(403).json({ error: "승인되지 않은 버전에 대한 권한이 없습니다." }); return; }
  if (!vid) { res.status(404).json({ error: "제공 가능한 승인 버전이 없습니다." }); return; }
  const [v] = await db.select({ text: archiveDocumentVersionsTable.extractedText, method: archiveDocumentVersionsTable.extractMethod })
    .from(archiveDocumentVersionsTable).where(and(eq(archiveDocumentVersionsTable.id, vid), eq(archiveDocumentVersionsTable.documentId, l.doc.id)));
  if (!v) { res.status(404).json({ error: "버전을 찾을 수 없습니다." }); return; }
  await archiveAudit(req, "preview_text", { documentId: l.doc.id, versionId: vid });
  res.json({ versionId: vid, text: v.text ?? "", method: v.method });
});

router.post("/archive/documents/:id/print", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "print");
  if (!l) return;
  await archiveAudit(req, "print", { documentId: l.doc.id, versionId: parseId(req.body?.versionId) });
  res.json({ ok: true });
});

// ─── 업무 연결 ──────────────────────────────────────────────────────────────

router.post("/archive/documents/:id/links", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "edit");
  if (!l) return;
  const entityType = String(req.body?.entityType ?? "");
  const entityId = parseId(req.body?.entityId);
  if (!(LINK_ENTITY_TYPES as readonly string[]).includes(entityType) || !entityId) { res.status(400).json({ error: "연결 대상이 올바르지 않습니다." }); return; }
  const [row] = await db.insert(archiveLinksTable).values({
    documentId: l.doc.id, entityType, entityId, note: req.body?.note ? String(req.body.note) : null, createdBy: req.user!.id,
  }).onConflictDoNothing().returning();
  await archiveAudit(req, "link_add", { documentId: l.doc.id }, { entityType, entityId });
  res.status(201).json(row ?? { ok: true, duplicate: true });
});

router.delete("/archive/documents/:id/links/:linkId", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "edit");
  if (!l) return;
  const linkId = parseId(req.params.linkId);
  if (!linkId) { res.status(400).json({ error: "잘못된 ID" }); return; }
  const [del] = await db.delete(archiveLinksTable).where(and(eq(archiveLinksTable.id, linkId), eq(archiveLinksTable.documentId, l.doc.id))).returning();
  if (!del) { res.status(404).json({ error: "연결을 찾을 수 없습니다." }); return; }
  await archiveAudit(req, "link_remove", { documentId: l.doc.id }, { entityType: del.entityType, entityId: del.entityId });
  res.json({ ok: true });
});

/** 기존 업무 검색(연결용, 읽기 전용). 업무 화면의 기존 권한과 별개로 식별 라벨만 반환. */
router.get("/archive/lookup/entities", ...guard, async (req, res) => {
  const type = String(req.query.type ?? "");
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.json([]); return; }
  const like = `%${q}%`;
  let rows: Array<{ id: number; label: string }> = [];
  if (type === "company") rows = (await db.select({ id: companiesTable.id, label: companiesTable.name }).from(companiesTable).where(ilike(companiesTable.name, like)).limit(20));
  else if (type === "contact") rows = (await db.select({ id: contactsTable.id, label: contactsTable.name }).from(contactsTable).where(ilike(contactsTable.name, like)).limit(20));
  else if (type === "quote") rows = (await db.select({ id: quotesTable.id, no: quotesTable.quoteNumber, t: quotesTable.title }).from(quotesTable).where(or(ilike(quotesTable.quoteNumber, like), ilike(quotesTable.title, like))).limit(20)).map(r => ({ id: r.id, label: [r.no, r.t].filter(Boolean).join(" ") }));
  else if (type === "inquiry") rows = (await db.select({ id: inquiriesTable.id, no: inquiriesTable.inquiryNumber, c: inquiriesTable.customerCompanyName }).from(inquiriesTable).where(or(ilike(inquiriesTable.inquiryNumber, like), ilike(inquiriesTable.customerCompanyName, like))).limit(20)).map(r => ({ id: r.id, label: [r.no, r.c].filter(Boolean).join(" ") }));
  else if (type === "project") rows = (await db.select({ id: projectsTable.id, label: projectsTable.title }).from(projectsTable).where(ilike(projectsTable.title, like)).limit(20));
  else if (type === "translator" || type === "user") {
    const roleCond = type === "translator" ? inArray(usersTable.role, ["translator", "linguist"]) : inArray(usersTable.role, ["admin", "staff"]);
    rows = (await db.select({ id: usersTable.id, n: usersTable.name, e: usersTable.email }).from(usersTable)
      .where(and(roleCond, or(ilike(usersTable.name, like), ilike(usersTable.email, like)))).limit(20)).map(r => ({ id: r.id, label: r.n || r.e }));
  }
  res.json(rows);
});

/** ACL 편집기용 대상 목록(역할·부서·직원) */
router.get("/archive/lookup/subjects", ...guard, async (_req, res) => {
  const [roles, staff] = await Promise.all([
    db.select({ id: rolesTable.id, name: rolesTable.name, description: rolesTable.description }).from(rolesTable),
    db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, department: usersTable.department })
      .from(usersTable).where(and(inArray(usersTable.role, ["admin", "staff"]), isNull(usersTable.deletedAt))),
  ]);
  const departments = [...new Set(staff.map(s => s.department?.trim()).filter((d): d is string => !!d))].sort();
  res.json({ roles, departments, users: staff.map(s => ({ id: s.id, label: s.name || s.email, department: s.department })) });
});

// ─── 삭제·휴지통·복원·영구삭제 ───────────────────────────────────────────────

router.delete("/archive/documents/:id", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "delete");
  if (!l) return;
  const reason = req.body?.reason ? String(req.body.reason) : null;
  await db.update(archiveDocumentsTable).set({ deletedAt: new Date(), deletedBy: req.user!.id, deletionReason: reason })
    .where(eq(archiveDocumentsTable.id, l.doc.id));
  await archiveAudit(req, "delete", { documentId: l.doc.id }, { reason, title: l.doc.title });
  res.json({ ok: true });
});

router.get("/archive/trash", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  const ctx = await loadAclContext();
  const rows = await db.select({ d: archiveDocumentsTable, deletedByName: usersTable.name, deletedByEmail: usersTable.email })
    .from(archiveDocumentsTable).leftJoin(usersTable, eq(archiveDocumentsTable.deletedBy, usersTable.id))
    .where(isNotNull(archiveDocumentsTable.deletedAt)).orderBy(desc(archiveDocumentsTable.deletedAt));
  res.json(rows.filter(r => documentActions(actor, ctx, r.d).has("restore")).map(r => ({
    id: r.d.id, title: r.d.title, folderPath: folderPath(ctx, r.d.folderId), docType: r.d.docType,
    securityLevel: r.d.securityLevel, deletedAt: r.d.deletedAt, deletedBy: r.d.deletedBy,
    deletedByName: r.deletedByName, deletedByEmail: r.deletedByEmail, deletionReason: r.d.deletionReason,
  })));
});

router.post("/archive/documents/:id/restore", ...guard, async (req, res) => {
  const l = await loadDoc(req, res, "restore", { allowDeleted: true });
  if (!l) return;
  if (!l.doc.deletedAt) { res.status(409).json({ error: "삭제된 자료가 아닙니다." }); return; }
  await db.update(archiveDocumentsTable).set({ deletedAt: null, deletedBy: null, deletionReason: null, updatedAt: new Date() })
    .where(eq(archiveDocumentsTable.id, l.doc.id));
  await archiveAudit(req, "restore", { documentId: l.doc.id }, { reason: req.body?.reason ?? null });
  res.json({ ok: true });
});

router.delete("/archive/documents/:id/purge", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  if (!actor.canPurge) { res.status(403).json({ error: "영구 삭제 권한(archive.purge)이 필요합니다." }); return; }
  const l = await loadDoc(req, res, "restore", { allowDeleted: true });
  if (!l) return;
  if (!l.doc.deletedAt) { res.status(409).json({ error: "휴지통에 있는 자료만 영구 삭제할 수 있습니다." }); return; }
  const reason = req.body?.reason ? String(req.body.reason) : null;
  // 기밀·극비 또는 승인본 보유 중요자료는 승인 절차 (최고관리자 제외)
  const important = ["confidential", "secret"].includes(l.doc.securityLevel) || l.doc.isStandardForm;
  if (important && !actor.isSuper) {
    const [dup] = await db.select({ id: archiveApprovalsTable.id }).from(archiveApprovalsTable)
      .where(and(eq(archiveApprovalsTable.documentId, l.doc.id), eq(archiveApprovalsTable.requestType, "purge"), eq(archiveApprovalsTable.status, "pending")));
    if (dup) { res.status(409).json({ error: "이미 영구 삭제 승인 요청이 진행 중입니다." }); return; }
    const [a] = await db.insert(archiveApprovalsTable).values({
      documentId: l.doc.id, requestType: "purge", payload: { title: l.doc.title, securityLevel: l.doc.securityLevel }, reason, requestedBy: actor.id,
    }).returning();
    await archiveAudit(req, "approval_request", { documentId: l.doc.id }, { type: "purge", approvalId: a.id });
    res.status(202).json({ pendingApproval: true, approvalId: a.id });
    return;
  }
  const r = await purgeDocument(l.doc.id);
  await archiveAudit(req, "purge", { documentId: l.doc.id }, { title: l.doc.title, reason, ...r });
  res.json({ ok: true, ...r });
});

export default router;
