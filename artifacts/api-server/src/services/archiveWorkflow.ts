/**
 * 회사 자료보관함 — 버전·승인 워크플로 및 파일 저장.
 *
 *  · 승인된 버전은 절대 덮어쓰지 않는다. 모든 변경은 새 버전 행 + (필요 시) 승인 요청.
 *  · 승인 필요 자료(requiresApproval / 표준양식): 새 버전은 in_review → 승인 시 approved, 이전 승인본은 superseded.
 *  · 승인 불필요 자료: 새 버전이 즉시 approved.
 *  · 파일은 R2 `archive/` 접두사에만 저장한다. 영구삭제도 이 접두사 객체만 지운다(기존 R2 파일 보호).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  db, archiveDocumentsTable, archiveDocumentVersionsTable, archiveApprovalsTable, archiveAclTable,
  archiveLinksTable, archiveAuditLogsTable,
  type ArchiveDocument, type ArchiveApproval,
} from "@workspace/db";
import { and, eq, ne, desc, sql } from "drizzle-orm";
import { uploadToR2, deleteFromR2 } from "../lib/r2";
import { extractText } from "../lib/textExtractor";
import { sanitizeActions } from "./archiveAccess";

export const ARCHIVE_KEY_PREFIX = "archive/";

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 검색·AI용 텍스트 추출. 이미지 OCR(유료 OpenAI 호출)은 사용하지 않는다. */
export async function extractForArchive(buf: Buffer, fileName: string, ext: string): Promise<{ text: string | null; method: string; aiStatus: string }> {
  try {
    if (ext === ".csv" || ext === ".eml") {
      const text = buf.toString("utf8").replace(/\u0000/g, "").slice(0, 50_000);
      return { text, method: ext === ".csv" ? "csv-utf8" : "eml-raw", aiStatus: text.trim() ? "extracted" : "empty" };
    }
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".msg"].includes(ext)) {
      return { text: null, method: "skipped", aiStatus: "skipped" };
    }
    // openaiApiKey 를 넘기지 않음 → 이미지 OCR 경로 비활성(유료 API 미사용)
    const r = await extractText(buf, fileName);
    const text = (r.text ?? "").replace(/\u0000/g, "");
    return { text: text || null, method: r.method, aiStatus: text.trim() ? "extracted" : "empty" };
  } catch {
    return { text: null, method: "error", aiStatus: "failed" };
  }
}

export async function storeArchiveFile(buf: Buffer, ext: string, mime: string): Promise<string> {
  const now = new Date();
  const key = `${ARCHIVE_KEY_PREFIX}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}${ext}`;
  await uploadToR2(key, buf, mime);
  return key;
}

export function needsApproval(doc: Pick<ArchiveDocument, "requiresApproval" | "isStandardForm">): boolean {
  return doc.requiresApproval || doc.isStandardForm;
}

/**
 * 새 버전 생성(파일은 이미 저장된 상태). 승인 정책에 따라 즉시 승인 또는 승인요청 생성.
 * @param submit false 면 승인 필요 자료를 '초안' 으로만 저장(검토 요청은 나중에).
 */
export async function addVersion(params: {
  doc: ArchiveDocument;
  storageKey: string; fileName: string; mime: string; size: number; hash: string;
  text: string | null; method: string;
  reason: string | null; actorId: number; submit: boolean; isAi?: boolean;
  requestType: "register" | "new_version" | "restore_version";
}): Promise<{ versionId: number; versionNo: number; approvalId: number | null; status: string }> {
  const { doc } = params;
  return db.transaction(async (tx) => {
    const [{ maxNo }] = await tx.select({ maxNo: sql<number>`coalesce(max(${archiveDocumentVersionsTable.versionNo}), 0)` })
      .from(archiveDocumentVersionsTable).where(eq(archiveDocumentVersionsTable.documentId, doc.id));
    const versionNo = Number(maxNo) + 1;
    const approvalRequired = needsApproval(doc);
    const vStatus = !approvalRequired ? "approved" : params.submit ? "in_review" : "draft";
    const now = new Date();
    const [v] = await tx.insert(archiveDocumentVersionsTable).values({
      documentId: doc.id, versionNo, storageKey: params.storageKey, originalFileName: params.fileName,
      mimeType: params.mime, fileSize: params.size, sha256: params.hash,
      extractedText: params.text, extractMethod: params.method, changeReason: params.reason,
      status: vStatus, createdBy: params.actorId,
      approvedBy: vStatus === "approved" ? params.actorId : null,
      approvedAt: vStatus === "approved" ? now : null,
    }).returning({ id: archiveDocumentVersionsTable.id });

    let approvalId: number | null = null;
    if (vStatus === "approved") {
      await tx.update(archiveDocumentVersionsTable).set({ status: "superseded" })
        .where(and(eq(archiveDocumentVersionsTable.documentId, doc.id), eq(archiveDocumentVersionsTable.status, "approved"), ne(archiveDocumentVersionsTable.id, v.id)));
      await tx.update(archiveDocumentsTable).set({
        currentVersionId: v.id, approvedVersionId: v.id, status: "approved", updatedAt: now, updatedBy: params.actorId,
      }).where(eq(archiveDocumentsTable.id, doc.id));
    } else {
      await tx.update(archiveDocumentsTable).set({
        currentVersionId: v.id,
        status: vStatus === "in_review" ? (doc.approvedVersionId ? "revised" : "in_review") : (doc.approvedVersionId ? "revised" : "draft"),
        updatedAt: now, updatedBy: params.actorId,
      }).where(eq(archiveDocumentsTable.id, doc.id));
      if (vStatus === "in_review") {
        const [a] = await tx.insert(archiveApprovalsTable).values({
          documentId: doc.id, versionId: v.id, requestType: params.requestType,
          payload: { versionNo, fileName: params.fileName, previousApprovedVersionId: doc.approvedVersionId },
          reason: params.reason, isAiAuthored: !!params.isAi, requestedBy: params.actorId,
        }).returning({ id: archiveApprovalsTable.id });
        approvalId = a.id;
      }
    }
    return { versionId: v.id, versionNo, approvalId, status: vStatus };
  });
}

/** 초안 버전에 대한 검토 요청 */
export async function requestReview(doc: ArchiveDocument, versionId: number, actorId: number, reason: string | null): Promise<number> {
  return db.transaction(async (tx) => {
    const [v] = await tx.select().from(archiveDocumentVersionsTable)
      .where(and(eq(archiveDocumentVersionsTable.id, versionId), eq(archiveDocumentVersionsTable.documentId, doc.id)));
    if (!v || v.status !== "draft") throw new WorkflowError("초안 상태의 버전만 검토 요청할 수 있습니다.");
    await tx.update(archiveDocumentVersionsTable).set({ status: "in_review" }).where(eq(archiveDocumentVersionsTable.id, v.id));
    await tx.update(archiveDocumentsTable).set({ status: doc.approvedVersionId ? "revised" : "in_review", updatedAt: new Date() })
      .where(eq(archiveDocumentsTable.id, doc.id));
    const [a] = await tx.insert(archiveApprovalsTable).values({
      documentId: doc.id, versionId: v.id, requestType: doc.approvedVersionId ? "new_version" : "register",
      payload: { versionNo: v.versionNo, fileName: v.originalFileName, previousApprovedVersionId: doc.approvedVersionId },
      reason, requestedBy: actorId,
    }).returning({ id: archiveApprovalsTable.id });
    return a.id;
  });
}

export class WorkflowError extends Error {
  constructor(msg: string, public status = 400) { super(msg); }
}

/** 승인 처리 — 요청 유형별 결과 반영 */
export async function approveRequest(ap: ArchiveApproval, approverId: number, note: string | null): Promise<void> {
  if (ap.status !== "pending") throw new WorkflowError("이미 처리된 요청입니다.", 409);
  const now = new Date();
  if (ap.requestType === "purge") {
    await purgeDocument(ap.documentId);
    return; // 문서와 함께 승인 행도 cascade 삭제 → 감사로그는 호출측에서 기록
  }
  await db.transaction(async (tx) => {
    if (["register", "new_version", "restore_version"].includes(ap.requestType) && ap.versionId) {
      const [v] = await tx.select().from(archiveDocumentVersionsTable).where(eq(archiveDocumentVersionsTable.id, ap.versionId));
      if (!v || v.status !== "in_review") throw new WorkflowError("검토중인 버전이 아닙니다.", 409);
      await tx.update(archiveDocumentVersionsTable).set({ status: "superseded" })
        .where(and(eq(archiveDocumentVersionsTable.documentId, ap.documentId), eq(archiveDocumentVersionsTable.status, "approved")));
      await tx.update(archiveDocumentVersionsTable).set({ status: "approved", approvedBy: approverId, approvedAt: now })
        .where(eq(archiveDocumentVersionsTable.id, v.id));
      await tx.update(archiveDocumentsTable).set({
        approvedVersionId: v.id, currentVersionId: v.id, status: "approved", updatedAt: now, updatedBy: approverId,
      }).where(eq(archiveDocumentsTable.id, ap.documentId));
    } else if (ap.requestType === "acl_change") {
      const after = (ap.payload as any)?.after;
      if (!Array.isArray(after)) throw new WorkflowError("권한 변경 내용이 올바르지 않습니다.");
      await tx.delete(archiveAclTable).where(eq(archiveAclTable.documentId, ap.documentId));
      const rows = normalizeAclRows(after, { documentId: ap.documentId }, ap.requestedBy);
      if (rows.length) await tx.insert(archiveAclTable).values(rows);
    } else if (ap.requestType === "status_change") {
      const to = (ap.payload as any)?.to;
      if (to !== "discarded") throw new WorkflowError("지원하지 않는 상태 변경입니다.");
      await tx.update(archiveDocumentsTable).set({ status: "discarded", updatedAt: now, updatedBy: approverId })
        .where(eq(archiveDocumentsTable.id, ap.documentId));
    }
    await tx.update(archiveApprovalsTable).set({ status: "approved", decidedBy: approverId, decidedAt: now, decisionNote: note })
      .where(eq(archiveApprovalsTable.id, ap.id));
  });
}

export async function rejectRequest(ap: ArchiveApproval, approverId: number, note: string | null): Promise<void> {
  if (ap.status !== "pending") throw new WorkflowError("이미 처리된 요청입니다.", 409);
  const now = new Date();
  await db.transaction(async (tx) => {
    if (ap.versionId && ["register", "new_version", "restore_version"].includes(ap.requestType)) {
      await tx.update(archiveDocumentVersionsTable).set({ status: "rejected" }).where(eq(archiveDocumentVersionsTable.id, ap.versionId));
      const [doc] = await tx.select().from(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, ap.documentId));
      if (doc) {
        await tx.update(archiveDocumentsTable).set({
          status: doc.approvedVersionId ? "approved" : "draft",
          currentVersionId: doc.approvedVersionId ?? doc.currentVersionId,
          updatedAt: now,
        }).where(eq(archiveDocumentsTable.id, doc.id));
      }
    }
    await tx.update(archiveApprovalsTable).set({ status: "rejected", decidedBy: approverId, decidedAt: now, decisionNote: note })
      .where(eq(archiveApprovalsTable.id, ap.id));
  });
}

export function normalizeAclRows(
  entries: unknown[], target: { documentId?: number; folderId?: number }, createdBy: number | null,
) {
  const out: Array<typeof archiveAclTable.$inferInsert> = [];
  for (const raw of entries) {
    const e = raw as any;
    const subjectType = String(e?.subjectType ?? "");
    if (!["all_staff", "role", "department", "user", "no_inherit"].includes(subjectType)) continue;
    if (subjectType === "no_inherit") {
      out.push({ documentId: target.documentId ?? null, folderId: target.folderId ?? null, subjectType, effect: "allow", actions: [], createdBy });
      continue;
    }
    const actions = sanitizeActions(e?.actions);
    if (!actions.length) continue;
    const subjectId = subjectType === "role" || subjectType === "user" ? Number(e?.subjectId) || null : null;
    const subjectValue = subjectType === "department" ? String(e?.subjectValue ?? "").trim() || null : null;
    if ((subjectType === "role" || subjectType === "user") && !subjectId) continue;
    if (subjectType === "department" && !subjectValue) continue;
    out.push({
      documentId: target.documentId ?? null, folderId: target.folderId ?? null,
      subjectType, subjectId, subjectValue, effect: e?.effect === "deny" ? "deny" : "allow", actions, createdBy,
    });
  }
  return out;
}

/** 영구 삭제: DB 행(버전·ACL·연결·승인 cascade) + archive/ 접두사 R2 객체만 삭제. */
export async function purgeDocument(documentId: number): Promise<{ deletedObjects: number }> {
  const versions = await db.select({ key: archiveDocumentVersionsTable.storageKey })
    .from(archiveDocumentVersionsTable).where(eq(archiveDocumentVersionsTable.documentId, documentId));
  await db.transaction(async (tx) => {
    await tx.delete(archiveLinksTable).where(eq(archiveLinksTable.documentId, documentId));
    await tx.delete(archiveDocumentsTable).where(eq(archiveDocumentsTable.id, documentId));
  });
  let deletedObjects = 0;
  for (const key of new Set(versions.map(v => v.key))) {
    if (!key.startsWith(ARCHIVE_KEY_PREFIX)) continue; // 기존 R2 파일 보호
    try { await deleteFromR2(key); deletedObjects++; } catch { /* 객체 정리 실패는 DB 삭제를 되돌리지 않음 */ }
  }
  return { deletedObjects };
}

/** 문서의 최근 감사기록 */
export async function recentAudit(documentId: number, limit = 100) {
  return db.select().from(archiveAuditLogsTable).where(eq(archiveAuditLogsTable.documentId, documentId))
    .orderBy(desc(archiveAuditLogsTable.createdAt)).limit(limit);
}
