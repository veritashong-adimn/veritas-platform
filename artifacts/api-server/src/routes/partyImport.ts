// ─── 거래처·담당자 대량등록 배치 이력 · 되돌리기 API ─────────────────────────────────
//   GET  /admin/party-import/:module/batches                     최근 배치(module = company | contact)
//   GET  /admin/party-import/batches/:id/rollback-preview         되돌리기 영향(DB 미변경)
//   POST /admin/party-import/batches/:id/rollback                 되돌리기(관리자, 삭제 없이 소프트 삭제·이전 값 복원)
import { Router, type IRouter } from "express";
import { requireAuth, requireRole } from "../middlewares/auth";
import { listPartyBatches, planPartyRollback, executePartyRollback } from "../services/partyImportPlan";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const approverGuard = [requireAuth, requireRole("admin")];

router.get("/admin/party-import/:module/batches", ...adminGuard, async (req, res) => {
  const m = req.params.module === "contact" ? "contact" : req.params.module === "company" ? "company" : null;
  if (!m) { res.status(400).json({ error: "module 은 company | contact" }); return; }
  try { res.json({ batches: await listPartyBatches(m) }); } catch (err) { req.log.error({ err }, "party batches failed"); res.status(500).json({ error: "등록 이력 조회 실패." }); }
});
router.get("/admin/party-import/batches/:id/rollback-preview", ...approverGuard, async (req, res) => {
  try { res.json(await planPartyRollback(Number(req.params.id))); } catch (err) { req.log.error({ err }, "party rollback preview failed"); res.status(500).json({ error: "되돌리기 미리보기 실패." }); }
});
router.post("/admin/party-import/batches/:id/rollback", ...approverGuard, async (req, res) => {
  if (req.body?.confirm !== true) { res.status(400).json({ error: "되돌리기 확인(confirm=true)이 필요합니다." }); return; }
  try { res.json(await executePartyRollback(Number(req.params.id), (req as any).user?.id ?? null)); }
  catch (err: any) { if (err?.status) { res.status(err.status).json({ error: err.message }); return; } req.log.error({ err }, "party rollback failed"); res.status(500).json({ error: "되돌리기 실패(변경 없음)." }); }
});
export default router;
