/**
 * 회사 자료보관함 — 자료 현황(대시보드), AI 지식관리 기반(권한 필터 근거 검색), 감사로그 조회.
 *
 * AI 지식관리 구현 범위(Phase 3 기반)
 *  · 구현: 업로드 시 본문 텍스트 추출·보관(원본과 분리), 권한·승인상태·AI허용 필터를 적용한 근거 검색(키워드),
 *          근거 문서·버전·발췌 반환, AI 검색 감사로그.
 *  · 미구현(표시만): 의미 기반(임베딩) 검색, AI 요약·자동분류·개정 제안, AI 직원별 지식 범위.
 *    → 유료 AI API 호출이 필요하므로 별도 승인 후 활성화. 이 모듈은 OpenAI 를 호출하지 않는다.
 */
import { Router, type IRouter } from "express";
import {
  db, usersTable, archiveDocumentsTable, archiveDocumentVersionsTable, archiveApprovalsTable, archiveAuditLogsTable,
} from "@workspace/db";
import { and, eq, isNull, inArray, ilike, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  loadAclContext, documentActions, canListDocument, canSeeUnapproved, canUseForAi, folderChain, folderPath, archiveAudit,
} from "../services/archiveAccess";
import { requireArchiveModule, parseId } from "../services/archiveCommon";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin", "staff"), requireArchiveModule];

export const ARCHIVE_AI_FEATURES = {
  textExtraction: true,
  keywordRetrieval: true,      // 권한 필터 근거 검색
  citations: true,             // 근거 문서 표시
  semanticSearch: false,       // 임베딩 — 미구현(유료 API 승인 필요)
  aiSummary: false,
  autoClassification: false,
  revisionSuggestion: false,
  aiWorkforceAgents: false,    // AI 직원 신원·권한 체계 미구축(Phase 4)
};

// ─── 자료 현황 ──────────────────────────────────────────────────────────────

router.get("/archive/stats", ...guard, async (req, res) => {
  try {
    const actor = req.archiveActor!;
    const ctx = await loadAclContext();
    const docs = await db.select({ d: archiveDocumentsTable, creatorName: usersTable.name, creatorEmail: usersTable.email })
      .from(archiveDocumentsTable).leftJoin(usersTable, eq(archiveDocumentsTable.createdBy, usersTable.id))
      .where(isNull(archiveDocumentsTable.deletedAt));
    const visible = docs.map(r => ({ ...r, acts: documentActions(actor, ctx, r.d) })).filter(r => canListDocument(actor, r.acts, r.d));
    const visibleIds = visible.map(r => r.d.id);

    // 분류별(최상위 폴더 기준)
    const byCategory = new Map<number, { folderId: number; name: string; count: number }>();
    for (const r of visible) {
      const chain = folderChain(ctx, r.d.folderId);
      const rootId = chain[chain.length - 1];
      const cur = byCategory.get(rootId) ?? { folderId: rootId, name: ctx.folders.get(rootId)?.name ?? "?", count: 0 };
      cur.count++;
      byCategory.set(rootId, cur);
    }
    const brief = (r: (typeof visible)[number]) => ({
      id: r.d.id, title: r.d.title, status: r.d.status, folderPath: folderPath(ctx, r.d.folderId),
      createdAt: r.d.createdAt, updatedAt: r.d.updatedAt, createdByName: r.creatorName || r.creatorEmail,
    });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const in30 = new Date(today.getTime() + 30 * 86400_000);
    const expiring = visible.filter(r => {
      const dates = [r.d.expiresAt, r.d.retentionUntil].filter(Boolean).map(d => new Date(d as string));
      return dates.some(d => d <= in30);
    }).map(r => ({ ...brief(r), expiresAt: r.d.expiresAt, retentionUntil: r.d.retentionUntil }));

    const reviewNeeded = visible.filter(r => ["draft", "in_review", "revised"].includes(r.d.status) && canSeeUnapproved(actor, r.acts, r.d));

    const pending = await db.select({ a: archiveApprovalsTable, d: archiveDocumentsTable }).from(archiveApprovalsTable)
      .innerJoin(archiveDocumentsTable, eq(archiveApprovalsTable.documentId, archiveDocumentsTable.id))
      .where(eq(archiveApprovalsTable.status, "pending"));
    const pendingVisible = pending.filter(p => p.a.requestedBy === actor.id || actor.isArchiveAdmin
      || (actor.canApprove && documentActions(actor, ctx, p.d).has("view")));

    const ai: Record<string, number> = {};
    for (const r of visible) ai[r.d.aiStatus] = (ai[r.d.aiStatus] ?? 0) + 1;
    const aiEligible = visible.filter(r => canUseForAi(r.acts, r.d)).length;

    // 저장공간: 관리자 = 전체(삭제 포함), 그 외 = 열람 가능 자료의 버전 합계
    let storage: { bytes: number; versions: number; scope: string };
    if (actor.isArchiveAdmin) {
      const [s] = await db.select({ bytes: sql<number>`coalesce(sum(${archiveDocumentVersionsTable.fileSize}),0)::bigint`, n: sql<number>`count(*)::int` }).from(archiveDocumentVersionsTable);
      storage = { bytes: Number(s.bytes), versions: s.n, scope: "all" };
    } else if (visibleIds.length) {
      const [s] = await db.select({ bytes: sql<number>`coalesce(sum(${archiveDocumentVersionsTable.fileSize}),0)::bigint`, n: sql<number>`count(*)::int` })
        .from(archiveDocumentVersionsTable).where(inArray(archiveDocumentVersionsTable.documentId, visibleIds));
      storage = { bytes: Number(s.bytes), versions: s.n, scope: "visible" };
    } else storage = { bytes: 0, versions: 0, scope: "visible" };

    let adminExtra: Record<string, unknown> | undefined;
    if (actor.isArchiveAdmin) {
      const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(archiveDocumentsTable).where(sql`${archiveDocumentsTable.deletedAt} is not null`);
      adminExtra = { trashCount: t.n, totalFolders: ctx.folders.size, aclEntries: [...ctx.folderAcl.values(), ...ctx.docAcl.values()].reduce((a, b) => a + b.length, 0) };
    }

    const sortBy = (k: "createdAt" | "updatedAt") => [...visible].sort((a, b) => +new Date(b.d[k]) - +new Date(a.d[k])).slice(0, 8).map(brief);
    res.json({
      scope: actor.isArchiveAdmin ? "admin" : "user",
      total: visible.length,
      byCategory: [...byCategory.values()].sort((a, b) => b.count - a.count),
      byStatus: visible.reduce<Record<string, number>>((m, r) => { m[r.d.status] = (m[r.d.status] ?? 0) + 1; return m; }, {}),
      recentCreated: sortBy("createdAt"),
      recentUpdated: sortBy("updatedAt"),
      pendingApprovals: pendingVisible.length,
      reviewNeeded: reviewNeeded.slice(0, 10).map(brief), reviewNeededCount: reviewNeeded.length,
      expiring: expiring.slice(0, 10), expiringCount: expiring.length,
      ai: { byStatus: ai, eligible: aiEligible, features: ARCHIVE_AI_FEATURES },
      storage,
      admin: adminExtra,
    });
  } catch (err) {
    req.log.error({ err }, "[archive] stats failed");
    res.status(500).json({ error: "자료 현황 조회 실패" });
  }
});

// ─── AI 지식 검색(근거 기반, 권한 필터) ──────────────────────────────────────

router.post("/archive/knowledge/search", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  const q = typeof req.body?.q === "string" ? req.body.q.trim().slice(0, 200) : "";
  if (q.length < 2) { res.status(400).json({ error: "검색어를 2자 이상 입력해 주세요." }); return; }
  // AI 직원(에이전트) 경유 요청은 아직 신원·권한 체계가 없으므로 거부(우회 방지)
  if (req.body?.agentKey) { res.status(501).json({ error: "AI 직원 연동은 아직 구현되지 않았습니다(Phase 4)." }); return; }
  const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 30);
  const ctx = await loadAclContext();

  // 1·3·4·5단계: 요청자 신원(JWT) → 요청자 자료 권한 → 승인상태·AI허용 → 허용 자료만 대상
  const docs = await db.select().from(archiveDocumentsTable)
    .where(and(isNull(archiveDocumentsTable.deletedAt), eq(archiveDocumentsTable.aiAllowed, true)));
  const eligible = docs.filter(d => canUseForAi(documentActions(actor, ctx, d), d));
  const approvedIds = eligible.map(d => d.approvedVersionId!).filter(Boolean);
  if (!approvedIds.length) {
    await archiveAudit(req, "ai_search", {}, { q, results: 0, eligible: 0 });
    res.json({ mode: "keyword", q, results: [], eligibleCount: 0, features: ARCHIVE_AI_FEATURES });
    return;
  }
  const docById = new Map(eligible.map(d => [d.id, d]));
  const like = `%${q}%`;
  // 승인본(approvedVersionId) 텍스트만 검색 — 초안·폐기본은 대상 아님
  const hits = await db.select({
    id: archiveDocumentVersionsTable.id, documentId: archiveDocumentVersionsTable.documentId,
    versionNo: archiveDocumentVersionsTable.versionNo, text: archiveDocumentVersionsTable.extractedText,
    fileName: archiveDocumentVersionsTable.originalFileName,
  }).from(archiveDocumentVersionsTable).where(and(
    inArray(archiveDocumentVersionsTable.id, approvedIds),
    sql`(${ilike(archiveDocumentVersionsTable.extractedText, like)} or ${archiveDocumentVersionsTable.documentId} in (
      select id from archive_documents where title ilike ${like} or keywords ilike ${like} or description ilike ${like}))`,
  ));

  const lower = q.toLowerCase();
  const results = hits.map(h => {
    const d = docById.get(h.documentId)!;
    const text = h.text ?? "";
    const idx = text.toLowerCase().indexOf(lower);
    const occurrences = idx < 0 ? 0 : text.toLowerCase().split(lower).length - 1;
    const snippet = idx < 0 ? (d.description ?? text.slice(0, 200)) : text.slice(Math.max(0, idx - 120), idx + q.length + 180);
    const titleHit = d.title.toLowerCase().includes(lower) ? 5 : 0;
    return {
      documentId: d.id, title: d.title, versionId: h.id, versionNo: h.versionNo, fileName: h.fileName,
      folderPath: folderPath(ctx, d.folderId), docType: d.docType, securityLevel: d.securityLevel,
      snippet: snippet.replace(/\s+/g, " ").trim(), score: occurrences + titleHit, approved: true,
    };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  await archiveAudit(req, "ai_search", {}, { q, results: results.length, eligible: eligible.length, documentIds: results.map(r => r.documentId) });
  res.json({ mode: "keyword", q, results, eligibleCount: eligible.length, features: ARCHIVE_AI_FEATURES });
});

// ─── 감사로그 조회(관리자) ───────────────────────────────────────────────────

router.get("/archive/audit", ...guard, async (req, res) => {
  const actor = req.archiveActor!;
  if (!actor.isArchiveAdmin) { res.status(403).json({ error: "자료보관함 관리 권한이 필요합니다." }); return; }
  const conds = [];
  if (typeof req.query.action === "string" && req.query.action) conds.push(eq(archiveAuditLogsTable.action, req.query.action));
  const docId = parseId(req.query.documentId);
  if (docId) conds.push(eq(archiveAuditLogsTable.documentId, docId));
  const userId = parseId(req.query.userId);
  if (userId) conds.push(eq(archiveAuditLogsTable.userId, userId));
  const rows = await db.select({ l: archiveAuditLogsTable, userName: usersTable.name, title: archiveDocumentsTable.title })
    .from(archiveAuditLogsTable)
    .leftJoin(usersTable, eq(archiveAuditLogsTable.userId, usersTable.id))
    .leftJoin(archiveDocumentsTable, eq(archiveAuditLogsTable.documentId, archiveDocumentsTable.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(archiveAuditLogsTable.createdAt)).limit(Math.min(Number(req.query.limit) || 200, 1000));
  res.json(rows.map(r => ({ ...r.l, userName: r.userName || r.l.userEmail, documentTitle: r.title })));
});

export default router;
