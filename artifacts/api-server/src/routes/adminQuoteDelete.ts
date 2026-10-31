import { Router, type IRouter } from "express";
import { db, quotesTable, projectsTable, inquiriesTable, logsTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { deleterNameSql } from "../lib/deleterName";
import { evaluateQuoteDependencies, buildGuardMessage } from "../services/saleDependency";
import { checkQuoteDeletable, deleteQuoteAndRevert, QuoteDeleteError } from "../services/quoteDeletion";

// 견적 삭제(Soft Delete) 전용 라우터.
// admin.ts(초대형 파일)의 타입 추론 부하를 늘리지 않도록 별도 파일로 분리한다.
const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 견적 삭제 (Soft Delete) + 의뢰건·프로젝트 원복 ─────────────────────────────
// 물리 삭제하지 않고 deletedAt/deletedBy/deletionReason 만 기록한다(견적번호 재사용 없음).
// 삭제 가능 조건·원복 규칙은 services/quoteDeletion(checkQuoteDeletable / deleteQuoteAndRevert) — 화면 검사와 별개로 서버에서 다시 검증.
//   저장만 된 견적(pending)만 — 발송·승인·거절·누적마감·배정·작업·결제·정산·청구 증빙·선입금 차감이 있으면 409 + 사유.
router.get("/admin/quotes/:id/delete-check", ...adminGuard, requirePermission("quote.update"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (isNaN(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 id." }); return; }
  try {
    const r = await checkQuoteDeletable(quoteId);
    if (!r.quote) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
    res.json({ ok: r.ok, reasons: r.reasons, inquiryIds: r.inquiryIds, projectStatus: r.project?.status ?? null,
      otherActiveQuotes: r.otherActiveQuotes.map(o => ({ id: o.id, quoteNumber: o.quoteNumber, status: o.status })) });
  } catch (err) {
    req.log.error({ err }, "Admin: quote delete-check failed");
    res.status(500).json({ error: "삭제 가능 여부 확인 실패." });
  }
});

router.delete("/admin/quotes/:id", ...adminGuard, requirePermission("quote.update"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (isNaN(quoteId) || quoteId <= 0) {
    res.status(400).json({ error: "유효하지 않은 견적 id." });
    return;
  }
  // 삭제 사유 — 선택 입력(목록 일괄 삭제 화면은 기존대로 입력을 받는다)
  const trimmedReason = ((req.body as { reason?: string } | undefined)?.reason ?? "").trim() || null;

  try {
    const r = await deleteQuoteAndRevert(quoteId, req.user?.id ?? null, trimmedReason);
    // 감사로그(커밋 후) — 실제 처리 결과 그대로
    const meta = {
      event: "QUOTE_DELETED", quoteNumber: r.quoteNumber, projectId: r.projectId,
      projectStatusBefore: r.projectStatusBefore, projectStatusAfter: r.projectStatusAfter,
      inquiryIds: r.inquiries.map(i => i.id), relinkedQuoteId: r.inquiries[0]?.relinkedQuoteId ?? null,
      otherActiveQuoteIds: r.otherActiveQuoteIds, reason: trimmedReason,
    };
    await logEvent("quote", quoteId, "quote_deleted", req.log, req.user ?? undefined, JSON.stringify(meta));
    for (const i of r.inquiries) {
      await logEvent("inquiry", i.id, "inquiry_quote_unlinked", req.log, req.user ?? undefined,
        JSON.stringify({ quoteId, quoteNumber: r.quoteNumber, projectId: r.projectId, relinkedQuoteId: i.relinkedQuoteId }));
    }
    if (r.projectId != null) {
      await logEvent("project", r.projectId, "quote_deleted", req.log, req.user ?? undefined,
        JSON.stringify({ quoteId, quoteNumber: r.quoteNumber, statusBefore: r.projectStatusBefore, statusAfter: r.projectStatusAfter, reason: trimmedReason }));
    }
    req.log.info({ quoteId, quoteNumber: r.quoteNumber, deletedBy: req.user?.id }, "Admin: quote soft-deleted");
    const reverted = r.otherActiveQuoteIds.length === 0;
    res.json({
      success: true, deletedQuoteId: quoteId, projectId: r.projectId,
      projectStatusBefore: r.projectStatusBefore, projectStatusAfter: r.projectStatusAfter,
      inquiryId: r.inquiries[0]?.id ?? null, relinkedQuoteId: r.inquiries[0]?.relinkedQuoteId ?? null,
      message: reverted
        ? (r.inquiries.length ? "견적서가 삭제 처리되었습니다. 기존 의뢰건으로 돌아갑니다." : "견적서가 삭제 처리되었습니다.")
        : `견적서가 삭제 처리되었습니다. 같은 의뢰의 다른 유효 견적서(${r.otherActiveQuoteIds.length}건)가 있어 프로젝트 상태는 유지됩니다.`,
    });
  } catch (err) {
    if (err instanceof QuoteDeleteError) { res.status(err.status).json({ error: err.message, reasons: err.reasons }); return; }
    req.log.error({ err }, "Admin: failed to soft-delete quote");
    res.status(500).json({ error: "견적 삭제 실패." });
  }
});

// ─── 견적 휴지통 목록 (soft-delete 된 견적만) ────────────────────────────────
// 경로 충돌 회피: adminRouter의 GET /admin/quotes/:id 보다 먼저 매칭되도록 '-trash' 사용.
router.get("/admin/quotes-trash", ...adminGuard, async (_req, res) => {
  try {
    const rows = await db
      .select({
        id:             quotesTable.id,
        quoteNumber:    quotesTable.quoteNumber,
        title:          quotesTable.title,
        price:          quotesTable.price,
        status:         quotesTable.status,
        issueDate:      quotesTable.issueDate,
        deletedAt:      quotesTable.deletedAt,
        deletionReason: quotesTable.deletionReason,
        deletedBy:      quotesTable.deletedBy,
        deletedByName:  deleterNameSql("quotes"),
        companyName:    sql<string | null>`(SELECT name FROM companies WHERE id = ${projectsTable.companyId})`,
      })
      .from(quotesTable)
      .leftJoin(projectsTable, eq(quotesTable.projectId, projectsTable.id))
      .where(isNotNull(quotesTable.deletedAt))
      .orderBy(desc(quotesTable.deletedAt));
    res.json(rows.map(r => ({ ...r, price: r.price != null ? Number(r.price) : 0 })));
  } catch (err) {
    (res.req as any).log?.error({ err }, "Admin: failed to list quote trash");
    res.status(500).json({ error: "휴지통 조회 실패." });
  }
});

// ─── 견적 복원 (휴지통 → 기본 목록) ──────────────────────────────────────────
// PM(quote.update 권한)도 복원 가능. 견적번호·내용·ID 등 기존 상태 그대로 유지(soft-delete 플래그만 해제).
router.post("/admin/quotes/:id/restore", ...adminGuard, requirePermission("quote.update"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (isNaN(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 id." }); return; }
  // 복원 사유(선택 입력) — logs.metadata.restoreReason 에 기록.
  const restoreReason = ((req.body?.reason ?? "") as string).trim();
  try {
    const [quote] = await db
      .select({ id: quotesTable.id, deletedAt: quotesTable.deletedAt, quoteNumber: quotesTable.quoteNumber })
      .from(quotesTable).where(eq(quotesTable.id, quoteId));
    if (!quote) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
    if (!quote.deletedAt) { res.status(400).json({ error: "휴지통에 있는 견적이 아닙니다." }); return; }

    await db.update(quotesTable)
      .set({ deletedAt: null, deletedBy: null, deletionReason: null })
      .where(eq(quotesTable.id, quoteId));
    // 삭제 때 연결이 풀린 의뢰건이 아직 다른 견적과 연결되지 않았으면 다시 연결한다
    const unlinked = await db.select({ entityId: logsTable.entityId }).from(logsTable)
      .where(and(eq(logsTable.entityType, "inquiry"), eq(logsTable.action, "inquiry_quote_unlinked"), sql`${logsTable.metadata}::jsonb ->> 'quoteId' = ${String(quoteId)}`));
    for (const u of unlinked) {
      const [relinked] = await db.update(inquiriesTable).set({ quoteId, updatedAt: new Date() })
        .where(and(eq(inquiriesTable.id, u.entityId), isNull(inquiriesTable.quoteId))).returning({ id: inquiriesTable.id });
      if (relinked) await logEvent("inquiry", relinked.id, "inquiry_quote_linked", req.log, req.user ?? undefined, JSON.stringify({ quoteId, restored: true }));
    }

    await logEvent("quote", quoteId, "quote_restored", req.log, req.user ?? undefined,
      JSON.stringify({ quoteNumber: quote.quoteNumber, ...(restoreReason ? { restoreReason } : {}) }));
    req.log.info({ quoteId, quoteNumber: quote.quoteNumber, restoredBy: req.user?.id }, "Admin: quote restored from trash");
    res.json({ success: true, restoredQuoteId: quoteId });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to restore quote");
    res.status(500).json({ error: "견적 복원 실패." });
  }
});

// ─── 견적 영구삭제 (관리자 전용) ─────────────────────────────────────────────
// requireRole("admin") → staff(PM)은 서버에서도 거부(403). 휴지통에 있는 견적만 대상.
// FK ON DELETE CASCADE(quote_items → quote_item_files)로 하위 데이터까지 트랜잭션 내에서 정리.
router.delete("/admin/quotes/:id/permanent", requireAuth, requireRole("admin"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (isNaN(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 견적 id." }); return; }
  // 완전삭제 사유(선택 입력) — logs.metadata.purgeReason 에 기록.
  const purgeReason = ((req.body?.reason ?? "") as string).trim();
  try {
    const [quote] = await db
      .select({ id: quotesTable.id, deletedAt: quotesTable.deletedAt, quoteNumber: quotesTable.quoteNumber })
      .from(quotesTable).where(eq(quotesTable.id, quoteId));
    if (!quote) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
    // 안전장치: 휴지통에 있는(soft-delete 된) 견적만 영구삭제 허용
    if (!quote.deletedAt) { res.status(400).json({ error: "휴지통에 있는 견적만 영구삭제할 수 있습니다." }); return; }

    // Dependency Guard — 영구삭제로 확정 금융이력이 연결된 quote/project 부모관계를 끊지 못하게 차단.
    //   C/D 등급이면 hard delete 금지. 검사는 READ-ONLY.
    const guard = await evaluateQuoteDependencies(quoteId);
    if (!guard.canDelete) {
      res.status(409).json({ error: buildGuardMessage("영구삭제", guard), guard });
      return;
    }

    // 감사로그를 실제 삭제 "이전"에 먼저 기록(행 제거 후에는 참조 불가).
    await logEvent("quote", quoteId, "quote_purged", req.log, req.user ?? undefined,
      JSON.stringify({ quoteNumber: quote.quoteNumber, ...(purgeReason ? { purgeReason } : {}) }));

    await db.transaction(async tx => {
      // quote_items / quote_item_files 는 FK CASCADE 로 함께 삭제됨 → 고아 데이터 없음
      await tx.delete(quotesTable).where(eq(quotesTable.id, quoteId));
    });

    req.log.warn({ quoteId, quoteNumber: quote.quoteNumber, purgedBy: req.user?.id }, "Admin: quote PERMANENTLY deleted");
    res.json({ success: true, purgedQuoteId: quoteId });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to permanently delete quote");
    res.status(500).json({ error: "견적 영구삭제 실패." });
  }
});

export default router;
