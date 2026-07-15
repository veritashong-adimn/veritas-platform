import { Router, type IRouter } from "express";
import { db, quotesTable, projectsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

// 견적 삭제(Soft Delete) 전용 라우터.
// admin.ts(초대형 파일)의 타입 추론 부하를 늘리지 않도록 별도 파일로 분리한다.
const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 견적 삭제 (Soft Delete) ─────────────────────────────────────────────────
// 물리 삭제하지 않고 deletedAt/deletedBy/deletionReason 만 기록한다.
// 판매전환 완료(활성 Project 연결) 견적은 삭제 불가 — 먼저 판매취소 필요.
router.delete("/admin/quotes/:id", ...adminGuard, requirePermission("quote.update"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (isNaN(quoteId) || quoteId <= 0) {
    res.status(400).json({ error: "유효하지 않은 견적 id." });
    return;
  }

  const { reason } = req.body as { reason?: string };
  const trimmedReason = (reason ?? "").trim();

  try {
    // 1) 견적 존재 확인
    const [quote] = await db
      .select({ id: quotesTable.id, projectId: quotesTable.projectId, deletedAt: quotesTable.deletedAt, quoteNumber: quotesTable.quoteNumber })
      .from(quotesTable)
      .where(eq(quotesTable.id, quoteId));
    if (!quote) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }

    // 2) 이미 삭제된 견적인가
    if (quote.deletedAt) { res.status(400).json({ error: "이미 삭제된 견적입니다." }); return; }

    // 3) 활성 판매 Project가 연결되어 있는가 (판매전환 완료 → 삭제 불가)
    //    판매취소 시 project.status='cancelled' 로 전환되므로, cancelled 가 아닌 Project 연결은 활성으로 본다.
    if (quote.projectId != null) {
      const [project] = await db
        .select({ id: projectsTable.id, status: projectsTable.status })
        .from(projectsTable)
        .where(eq(projectsTable.id, quote.projectId));
      if (project && project.status !== "cancelled") {
        res.status(409).json({ error: "판매전환된 견적은 삭제할 수 없습니다. 먼저 판매취소를 진행해 주세요." });
        return;
      }
    }

    // 4) 삭제 사유 검증 (필수, 공백 제외 2자 이상)
    if (trimmedReason.length < 2) {
      res.status(400).json({ error: "삭제 사유를 2자 이상 입력해 주세요." });
      return;
    }

    // 5) Soft Delete 처리 — 레코드 보존, 목록/현황/검색에서만 제외
    const [updated] = await db
      .update(quotesTable)
      .set({ deletedAt: new Date(), deletedBy: req.user?.id ?? null, deletionReason: trimmedReason })
      .where(and(eq(quotesTable.id, quoteId), isNull(quotesTable.deletedAt)))
      .returning({ id: quotesTable.id });

    if (!updated) { res.status(409).json({ error: "이미 삭제된 견적입니다." }); return; }

    await logEvent("quote", quoteId, "quote_deleted", req.log, req.user ?? undefined, JSON.stringify({ reason: trimmedReason }));
    req.log.info({ quoteId, quoteNumber: quote.quoteNumber, deletedBy: req.user?.id }, "Admin: quote soft-deleted");
    res.json({ success: true, deletedQuoteId: quoteId });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to soft-delete quote");
    res.status(500).json({ error: "견적 삭제 실패." });
  }
});

export default router;
