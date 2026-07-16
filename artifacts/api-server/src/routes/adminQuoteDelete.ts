import { Router, type IRouter } from "express";
import { db, quotesTable, projectsTable, isQuoteConverted } from "@workspace/db";
import { eq, and, isNull, isNotNull, desc, sql } from "drizzle-orm";
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
      .select({ id: quotesTable.id, status: quotesTable.status, deletedAt: quotesTable.deletedAt, quoteNumber: quotesTable.quoteNumber })
      .from(quotesTable)
      .where(eq(quotesTable.id, quoteId));
    if (!quote) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }

    // 2) 이미 삭제된 견적인가
    if (quote.deletedAt) { res.status(400).json({ error: "이미 삭제된 견적입니다." }); return; }

    // 3) 판매전환 완료 견적은 삭제 불가 (먼저 판매취소 필요).
    //    목록 UI와 100% 동일한 기준(status === 'approved') = 공통 함수 isQuoteConverted() 사용.
    //    projectId 연결 여부로 판단하지 않는다(저장 시점에 이미 연결될 수 있어 오판 원인이었음).
    //    판매취소 시 status가 'pending'으로 복귀하므로 취소 후에는 정상 삭제된다.
    if (isQuoteConverted(quote.status)) {
      res.status(409).json({ error: "판매전환된 견적은 삭제할 수 없습니다. 먼저 판매취소를 진행한 후 삭제해 주세요." });
      return;
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
        deletedByName:  sql<string | null>`(SELECT name FROM users WHERE id = ${quotesTable.deletedBy})`,
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
  try {
    const [quote] = await db
      .select({ id: quotesTable.id, deletedAt: quotesTable.deletedAt, quoteNumber: quotesTable.quoteNumber })
      .from(quotesTable).where(eq(quotesTable.id, quoteId));
    if (!quote) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
    if (!quote.deletedAt) { res.status(400).json({ error: "휴지통에 있는 견적이 아닙니다." }); return; }

    await db.update(quotesTable)
      .set({ deletedAt: null, deletedBy: null, deletionReason: null })
      .where(eq(quotesTable.id, quoteId));

    await logEvent("quote", quoteId, "quote_restored", req.log, req.user ?? undefined, JSON.stringify({ quoteNumber: quote.quoteNumber }));
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
  try {
    const [quote] = await db
      .select({ id: quotesTable.id, deletedAt: quotesTable.deletedAt, quoteNumber: quotesTable.quoteNumber })
      .from(quotesTable).where(eq(quotesTable.id, quoteId));
    if (!quote) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
    // 안전장치: 휴지통에 있는(soft-delete 된) 견적만 영구삭제 허용
    if (!quote.deletedAt) { res.status(400).json({ error: "휴지통에 있는 견적만 영구삭제할 수 있습니다." }); return; }

    await db.transaction(async tx => {
      // quote_items / quote_item_files 는 FK CASCADE 로 함께 삭제됨 → 고아 데이터 없음
      await tx.delete(quotesTable).where(eq(quotesTable.id, quoteId));
    });

    await logEvent("quote", quoteId, "quote_purged", req.log, req.user ?? undefined, JSON.stringify({ quoteNumber: quote.quoteNumber }));
    req.log.warn({ quoteId, quoteNumber: quote.quoteNumber, purgedBy: req.user?.id }, "Admin: quote PERMANENTLY deleted");
    res.json({ success: true, purgedQuoteId: quoteId });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to permanently delete quote");
    res.status(500).json({ error: "견적 영구삭제 실패." });
  }
});

export default router;
