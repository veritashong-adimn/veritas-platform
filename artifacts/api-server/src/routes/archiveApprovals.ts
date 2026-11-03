/**
 * 회사 자료보관함 — 승인관리 + 접근권한(ACL) 설정.
 *  · 승인권자(archive.approve)만 승인·반려. 요청자 본인 승인은 금지(최고관리자 제외).
 *  · AI 작성 요청(isAiAuthored)도 동일 절차 — AI 가 승인 권한을 획득하는 경로는 없다.
 *  · 기밀·극비 자료의 권한 변경은 승인 요청으로 처리(최고관리자 제외).
 */
import { Router, type IRouter } from "express";
import {
  db, usersTable, archiveApprovalsTable, archiveDocumentsTable, archiveDocumentVersionsTable, archiveAclTable,
} from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  loadAclContext, documentActions, folderActions, folderPath, archiveAudit,
} from "../services/archiveAccess";
import { requireArchiveModule, parseId } from "../services/archiveCommon";
import { approveRequest, rejectRequest, normalizeAclRows, WorkflowError } from "../services/archiveWorkflow";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin", "staff"), requireArchiveModule];

// ─── 승인 목록 ──────────────────────────────────────────────────────────────

router.get("/archive/approvals", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  const ctx = await loadAclContext();
  const status = typeof req.query.status === "string" && req.query.status !== "all" ? req.query.status : null;
  const rows = await db.select({
    a: archiveApprovalsTable, d: archiveDocumentsTable, requesterName: usersTable.name, requesterEmail: usersTable.email,
  }).from(archiveApprovalsTable)
    .innerJoin(archiveDocumentsTable, eq(archiveApprovalsTable.documentId, archiveDocumentsTable.id))
    .leftJoin(usersTable, eq(archiveApprovalsTable.requestedBy, usersTable.id))
    .where(status ? eq(archiveApprovalsTable.status, status) : undefined)
    .orderBy(desc(archiveApprovalsTable.requestedAt)).limit(500);

  const visible = rows.filter(r => {
    if (r.a.requestedBy === actor.id) return true;
    if (actor.isArchiveAdmin) return true;
    return actor.canApprove && documentActions(actor, ctx, r.d).has("view");
  });
  const vIds = visible.map(r => r.a.versionId).filter((x): x is number => !!x);
  const versions = vIds.length ? await db.select({
    id: archiveDocumentVersionsTable.id, versionNo: archiveDocumentVersionsTable.versionNo,
    fileName: archiveDocumentVersionsTable.originalFileName, changeReason: archiveDocumentVersionsTable.changeReason,
  }).from(archiveDocumentVersionsTable).where(inArray(archiveDocumentVersionsTable.id, vIds)) : [];
  const vMap = new Map(versions.map(v => [v.id, v]));
  const deciderIds = [...new Set(visible.map(r => r.a.decidedBy).filter((x): x is number => !!x))];
  const deciders = deciderIds.length ? await db.select({ id: usersTable.id, n: usersTable.name, e: usersTable.email }).from(usersTable).where(inArray(usersTable.id, deciderIds)) : [];
  const dMap = new Map(deciders.map(d => [d.id, d.n || d.e]));

  res.json(visible.map(r => ({
    ...r.a,
    documentTitle: r.d.title, documentStatus: r.d.status, securityLevel: r.d.securityLevel,
    folderPath: folderPath(ctx, r.d.folderId), documentDeleted: !!r.d.deletedAt,
    requesterName: r.requesterName || r.requesterEmail,
    deciderName: r.a.decidedBy ? dMap.get(r.a.decidedBy) ?? null : null,
    version: r.a.versionId ? vMap.get(r.a.versionId) ?? null : null,
    canDecide: r.a.status === "pending" && actor.canApprove && (r.a.requestedBy !== actor.id || actor.isSuper),
    canCancel: r.a.status === "pending" && r.a.requestedBy === actor.id,
  })));
});

async function loadApproval(id: number | null) {
  if (!id) return null;
  const [row] = await db.select({ a: archiveApprovalsTable, d: archiveDocumentsTable }).from(archiveApprovalsTable)
    .innerJoin(archiveDocumentsTable, eq(archiveApprovalsTable.documentId, archiveDocumentsTable.id))
    .where(eq(archiveApprovalsTable.id, id));
  return row ?? null;
}

router.post("/archive/approvals/:id/:decision", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  const decision = String(req.params.decision);
  if (!["approve", "reject", "cancel"].includes(decision)) { res.status(404).json({ error: "알 수 없는 처리" }); return; }
  const row = await loadApproval(parseId(req.params.id));
  if (!row) { res.status(404).json({ error: "승인 요청을 찾을 수 없습니다." }); return; }
  const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim() : null;
  try {
    if (decision === "cancel") {
      if (row.a.requestedBy !== actor.id) { res.status(403).json({ error: "본인 요청만 취소할 수 있습니다." }); return; }
      if (row.a.status !== "pending") { res.status(409).json({ error: "이미 처리된 요청입니다." }); return; }
      await rejectRequest(row.a, actor.id, note ?? "요청자 취소");
      await db.update(archiveApprovalsTable).set({ status: "cancelled" }).where(eq(archiveApprovalsTable.id, row.a.id));
      await archiveAudit(req, "approval_cancel", { documentId: row.a.documentId, versionId: row.a.versionId }, { approvalId: row.a.id });
      res.json({ ok: true });
      return;
    }
    if (!actor.canApprove) { res.status(403).json({ error: "승인 권한(archive.approve)이 없습니다." }); return; }
    if (row.a.requestedBy === actor.id && !actor.isSuper) { res.status(403).json({ error: "본인이 요청한 건은 승인·반려할 수 없습니다." }); return; }
    const ctx = await loadAclContext();
    if (!actor.isArchiveAdmin && !documentActions(actor, ctx, row.d).has("view")) {
      res.status(403).json({ error: "해당 자료에 대한 열람 권한이 없어 처리할 수 없습니다." }); return;
    }
    if (decision === "reject" && !note) { res.status(400).json({ error: "반려 사유를 입력해 주세요." }); return; }
    if (decision === "approve") await approveRequest(row.a, actor.id, note);
    else await rejectRequest(row.a, actor.id, note);
    await archiveAudit(req, decision === "approve" ? "approval_approve" : "approval_reject",
      { documentId: row.a.requestType === "purge" && decision === "approve" ? null : row.a.documentId, versionId: row.a.versionId },
      { approvalId: row.a.id, requestType: row.a.requestType, note, documentId: row.a.documentId, title: row.d.title, isAiAuthored: row.a.isAiAuthored });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof WorkflowError) { res.status(err.status).json({ error: err.message }); return; }
    req.log.error({ err }, "[archive] approval decision failed");
    res.status(500).json({ error: "승인 처리 중 오류가 발생했습니다." });
  }
});

// ─── 접근권한(ACL) ──────────────────────────────────────────────────────────

router.get("/archive/folders/:id/acl", ...guard, async (req, res) => {
  const id = parseId(req.params.id);
  const ctx = await loadAclContext();
  if (!id || !ctx.folders.has(id)) { res.status(404).json({ error: "폴더를 찾을 수 없습니다." }); return; }
  if (!folderActions(req.archiveActor!, ctx, id).has("manage")) { res.status(403).json({ error: "권한 설정 권한이 없습니다." }); return; }
  const own = await db.select().from(archiveAclTable).where(eq(archiveAclTable.folderId, id));
  // 상위 폴더에서 상속되는 항목(읽기 전용 표시)
  const inherited: Array<Record<string, unknown>> = [];
  let p = ctx.folders.get(id)!.parentId;
  while (p != null) {
    for (const e of ctx.folderAcl.get(p) ?? []) inherited.push({ ...e, fromFolder: ctx.folders.get(p)?.name });
    p = ctx.folders.get(p)?.parentId ?? null;
  }
  res.json({ own, inherited });
});

router.put("/archive/folders/:id/acl", ...guard, async (req, res) => {
  const id = parseId(req.params.id);
  const ctx = await loadAclContext();
  if (!id || !ctx.folders.has(id)) { res.status(404).json({ error: "폴더를 찾을 수 없습니다." }); return; }
  if (!folderActions(req.archiveActor!, ctx, id).has("manage")) { res.status(403).json({ error: "권한 설정 권한이 없습니다." }); return; }
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.filter((e: any) => e?.subjectType !== "no_inherit") : null;
  if (!entries) { res.status(400).json({ error: "entries 배열이 필요합니다." }); return; }
  const rows = normalizeAclRows(entries, { folderId: id }, req.user!.id);
  const before = ctx.folderAcl.get(id) ?? [];
  await db.transaction(async (tx) => {
    await tx.delete(archiveAclTable).where(eq(archiveAclTable.folderId, id));
    if (rows.length) await tx.insert(archiveAclTable).values(rows);
  });
  await archiveAudit(req, "acl_change", { folderId: id }, { before: before.map(stripAcl), after: rows.map(stripAcl) });
  res.json({ ok: true, count: rows.length });
});

router.get("/archive/documents/:id/acl", ...guard, async (req, res) => {
  const id = parseId(req.params.id);
  const [doc] = id ? await db.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, id)) : [];
  const ctx = await loadAclContext();
  if (!doc || doc.deletedAt || !documentActions(req.archiveActor!, ctx, doc).has("manage")) { res.status(404).json({ error: "자료를 찾을 수 없습니다." }); return; }
  const own = ctx.docAcl.get(doc.id) ?? [];
  const inherited: Array<Record<string, unknown>> = [];
  let p: number | null = doc.folderId;
  while (p != null) {
    for (const e of ctx.folderAcl.get(p) ?? []) inherited.push({ ...e, fromFolder: ctx.folders.get(p)?.name });
    p = ctx.folders.get(p)?.parentId ?? null;
  }
  res.json({ own, inherited, inheritanceBroken: own.some(e => e.subjectType === "no_inherit") });
});

router.put("/archive/documents/:id/acl", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  const id = parseId(req.params.id);
  const [doc] = id ? await db.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, id)) : [];
  const ctx = await loadAclContext();
  if (!doc || doc.deletedAt || !documentActions(actor, ctx, doc).has("manage")) { res.status(404).json({ error: "자료를 찾을 수 없습니다." }); return; }
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) { res.status(400).json({ error: "entries 배열이 필요합니다." }); return; }
  const rows = normalizeAclRows(entries, { documentId: doc.id }, actor.id);
  const before = (ctx.docAcl.get(doc.id) ?? []).map(stripAcl);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : null;

  if (["confidential", "secret"].includes(doc.securityLevel) && !actor.isSuper) {
    const [a] = await db.insert(archiveApprovalsTable).values({
      documentId: doc.id, requestType: "acl_change", payload: { before, after: rows.map(stripAcl) }, reason, requestedBy: actor.id,
    }).returning();
    await archiveAudit(req, "approval_request", { documentId: doc.id }, { type: "acl_change", approvalId: a.id });
    res.status(202).json({ pendingApproval: true, approvalId: a.id });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(archiveAclTable).where(eq(archiveAclTable.documentId, doc.id));
    if (rows.length) await tx.insert(archiveAclTable).values(rows);
  });
  await archiveAudit(req, "acl_change", { documentId: doc.id }, { before, after: rows.map(stripAcl), reason });
  res.json({ ok: true, count: rows.length });
});

function stripAcl(e: { subjectType: string; subjectId?: number | null; subjectValue?: string | null; effect?: string; actions: unknown }) {
  return { subjectType: e.subjectType, subjectId: e.subjectId ?? null, subjectValue: e.subjectValue ?? null, effect: e.effect ?? "allow", actions: e.actions };
}

export default router;
