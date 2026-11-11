// ─── 수행정보 ↔ 판매상품 연결 복구(판매상품이 삭제·재생성되어 끊어진 참조만) ─────────────
// 판매정보 저장 시 품목이 재생성되어(구버전 편집) 수행정보의 sale_item_id 가 삭제된 품목을 가리키는 경우,
// 관리자가 근거를 확인한 뒤 같은 판매건의 현재 판매상품으로 참조만 옮긴다.
//   · 바꾸는 값: performance_assignments.sale_item_id 하나뿐(행 삭제·재생성 없음 → 수행정보 id·통번역사·금액·
//     원천세·지급상태·지급회차·지급명세서 연결 모두 그대로).
//   · 조건: 현재 연결 품목이 실제로 존재하지 않음(끊어진 연결) + 대상 품목이 같은 판매건의 현재 유효 견적 품목 + 사유 필수.
//   · 감사로그: project 단위 performance_sale_item_relinked (수행정보 id·이전/이후 품목 id·상품명·사유).
import { Router, type IRouter } from "express";
import { db, performanceAssignmentsTable, quoteItemsTable, quotesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireAuth, requireRole, requireRolePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin", "staff"), requireRolePermission("project.update")];

// POST /api/admin/performances/:id/relink-sale-item  { saleItemId, reason }
router.post("/admin/performances/:id/relink-sale-item", ...guard, async (req, res) => {
  const id = Number(req.params.id);
  const targetId = Number(req.body?.saleItemId);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(targetId) || targetId <= 0) { res.status(400).json({ error: "잘못된 요청입니다." }); return; }
  if (!reason) { res.status(400).json({ error: "변경 사유를 입력하세요." }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select({ id: performanceAssignmentsTable.id, projectId: performanceAssignmentsTable.projectId, saleItemId: performanceAssignmentsTable.saleItemId, deletedAt: performanceAssignmentsTable.deletedAt })
        .from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, id)).for("update");
      if (!row || row.deletedAt) return { status: 404, error: "수행정보를 찾을 수 없습니다." };
      if (row.saleItemId == null) return { status: 409, error: "판매상품이 연결되지 않은 수행정보입니다(복구 대상 아님)." };
      const [cur] = await tx.select({ id: quoteItemsTable.id }).from(quoteItemsTable).where(eq(quoteItemsTable.id, row.saleItemId));
      if (cur) return { status: 409, error: "현재 연결된 판매상품이 존재합니다(끊어진 연결만 복구할 수 있습니다)." };
      const [tgt] = await tx.select({ id: quoteItemsTable.id, productName: quoteItemsTable.productName, itemType: quoteItemsTable.itemType, projectId: quotesTable.projectId })
        .from(quoteItemsTable).innerJoin(quotesTable, eq(quotesTable.id, quoteItemsTable.quoteId))
        .where(and(eq(quoteItemsTable.id, targetId), eq(quotesTable.isCurrent, true), isNull(quotesTable.deletedAt)));
      if (!tgt || tgt.projectId !== row.projectId) return { status: 409, error: "같은 판매건의 현재 판매상품만 연결할 수 있습니다." };
      if (tgt.itemType === "discount") return { status: 409, error: "할인 항목에는 연결할 수 없습니다." };
      await tx.update(performanceAssignmentsTable).set({ saleItemId: tgt.id }).where(eq(performanceAssignmentsTable.id, id));
      return { status: 200, projectId: row.projectId, from: row.saleItemId, to: tgt.id, toProductName: tgt.productName };
    });
    if (result.status !== 200) { res.status(result.status).json({ error: result.error }); return; }
    // 수행정보 저장 이력(performances_saved)과 같이 판매건(project) 단위로 기록
    await logEvent("project", result.projectId!, "performance_sale_item_relinked", req.log, req.user ? { id: req.user.id, email: req.user.email } : undefined,
      JSON.stringify({ performanceId: id, fromSaleItemId: result.from, toSaleItemId: result.to, toProductName: result.toProductName, reason }));
    res.json({ ok: true, id, saleItemId: result.to });
  } catch (err) {
    req.log.error({ err, id }, "수행정보 판매상품 재연결 실패");
    res.status(500).json({ error: "판매상품 재연결에 실패했습니다." });
  }
});

export default router;
