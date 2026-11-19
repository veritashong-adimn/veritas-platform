// ─────────────────────────────────────────────────────────────────────────────
// 지급 정정·관리자 승인·차액 정산 API(2026-11 승인) — 로직은 services/payoutAdjustments.ts.
//  · 요청: 판매 수정 권한(project.update) — 수행정보 화면의 [수정 요청]·[정정 요청]
//  · 승인·반려: payout.confirm(관리자급 지급 승인 권한 재사용) + 요청자 ≠ 승인자(서비스에서 강제)
//  · 정산 방식·회차 편입: payout.manage / 환수·해외송금 정산 완료 확인: payout.transfer(실제 지급 실행 권한)
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAuth, requireRole, requireRolePermission, requireStaffPermission } from "../middlewares/auth";
import { getPermissionsForRole } from "../lib/rbac";
import { rowSchema } from "./performances";
import {
  AdjError, createAdjustmentRequest, previewAdjustmentRequest, approveAdjustment, rejectAdjustment, cancelAdjustment, setSettlementType,
  assignAdjustmentToRound, unassignAdjustmentFromRound, settleAdjustmentManually, listAdjustments, adjustmentHistory,
} from "../services/payoutAdjustments";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const viewGuard = [...adminGuard, requireStaffPermission(["payout.view", "payout.statement"], { allowStaffWithoutRole: true })];
const confirmGuard = [...adminGuard, requireStaffPermission("payout.confirm")];
const manageGuard = [...adminGuard, requireStaffPermission("payout.manage")];
const transferGuard = [...adminGuard, requireStaffPermission("payout.transfer")];

const actorOf = (req: any) => (req.user ? { id: req.user.id, email: req.user.email, role: req.user.role, roleId: req.user.roleId } : undefined);
const fail = (res: any, req: any, err: any, msg: string) => {
  if (err instanceof AdjError) { res.status(err.status).json({ error: err.message }); return; }
  req.log.error({ err }, msg);
  res.status(500).json({ error: `${msg} 중 오류가 발생했습니다.` });
};
const noteSchema = z.object({ note: z.string().trim().max(1000).optional().nullable() });

// 판매건 단위 정정 현황(수행정보 화면)
router.get("/admin/projects/:id/payout-adjustments", ...adminGuard, async (req, res) => {
  try { res.json(await listAdjustments({ projectId: Number(req.params.id) })); } catch (e) { fail(res, req, e, "정정 현황 조회"); }
});
// 전체 정정 현황(지급회차 관리) — status / settlement(pending|open|scheduled|settled) / roundId 필터
router.get("/admin/payout-adjustments", ...viewGuard, async (req, res) => {
  try {
    res.json(await listAdjustments({
      status: req.query.status ? String(req.query.status) : undefined,
      settlement: req.query.settlement ? String(req.query.settlement) : undefined,
      roundId: req.query.roundId ? Number(req.query.roundId) : undefined,
    }));
  } catch (e) { fail(res, req, e, "정정 현황 조회"); }
});
router.get("/admin/payout-adjustments/:id/history", ...viewGuard, async (req, res) => {
  try { res.json({ rows: await adjustmentHistory(Number(req.params.id)) }); } catch (e) { fail(res, req, e, "변경 이력 조회"); }
});

// 수정·정정 요청 생성 — 수행정보 저장에서 APPROVAL_REQUIRED 로 돌려받은 행 입력을 그대로 제출.
const createSchema = z.object({ rows: z.array(rowSchema).min(1).max(50), reason: z.string().trim().min(1).max(1000) });
router.post("/admin/projects/:id/payout-adjustments", ...adminGuard, requireRolePermission("project.update"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "수정·정정 사유와 대상 행이 필요합니다.", detail: parsed.error.flatten() }); return; }
  const projectId = Number(req.params.id);
  const created: any[] = []; const errors: { id: number | null; error: string }[] = [];
  for (const r of parsed.data.rows) {
    try { created.push(await createAdjustmentRequest(projectId, r, parsed.data.reason, actorOf(req), req.log)); }
    catch (e: any) {
      if (!(e instanceof AdjError)) req.log.error({ e }, "정정 요청 생성 실패");
      errors.push({ id: r.id ?? null, error: e instanceof AdjError ? e.message : "정정 요청 생성 중 오류" });
    }
  }
  res.status(created.length ? 201 : 400).json({ created, errors, ...(created.length ? {} : { error: errors.map((x) => x.error).join(" / ") }) });
});

// 요청 미리보기(저장 없음) — 정정 요청 화면에서 기존·정정 후·차액·예상 정산 방식을 보여 준다.
router.post("/admin/projects/:id/payout-adjustments/preview", ...adminGuard, requireRolePermission("project.update"), async (req, res) => {
  const parsed = z.object({ row: rowSchema }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "정정 대상 행 입력이 올바르지 않습니다." }); return; }
  try { res.json(await previewAdjustmentRequest(Number(req.params.id), parsed.data.row, actorOf(req))); } catch (e) { fail(res, req, e, "정정 미리보기"); }
});

router.post("/admin/payout-adjustments/:id/approve", ...confirmGuard, async (req, res) => {
  try { res.json(await approveAdjustment(Number(req.params.id), noteSchema.parse(req.body ?? {}).note ?? null, actorOf(req), req.log)); }
  catch (e) { fail(res, req, e, "정정 승인"); }
});
router.post("/admin/payout-adjustments/:id/reject", ...confirmGuard, async (req, res) => {
  try { res.json({ adjustment: await rejectAdjustment(Number(req.params.id), noteSchema.parse(req.body ?? {}).note ?? null, actorOf(req), req.log) }); }
  catch (e) { fail(res, req, e, "정정 반려"); }
});
router.post("/admin/payout-adjustments/:id/cancel", ...adminGuard, async (req, res) => {
  try {
    const u = req.user!;
    const canManage = (u.role === "admin" && !u.roleId) || (u.roleId ? (await getPermissionsForRole(u.roleId)).has("payout.confirm") : false);
    res.json({ adjustment: await cancelAdjustment(Number(req.params.id), noteSchema.parse(req.body ?? {}).note ?? null, actorOf(req), canManage, req.log) });
  } catch (e) { fail(res, req, e, "정정 요청 취소"); }
});
router.post("/admin/payout-adjustments/:id/settlement-type", ...manageGuard, async (req, res) => {
  const t = z.object({ type: z.string().min(1) }).safeParse(req.body);
  if (!t.success) { res.status(400).json({ error: "정산 방식을 선택해 주세요." }); return; }
  try { res.json({ adjustment: await setSettlementType(Number(req.params.id), t.data.type, actorOf(req), req.log) }); } catch (e) { fail(res, req, e, "정산 방식 변경"); }
});
router.post("/admin/payout-adjustments/:id/assign-round", ...manageGuard, async (req, res) => {
  const t = z.object({ roundId: z.number().int().positive() }).safeParse(req.body);
  if (!t.success) { res.status(400).json({ error: "편입할 지급회차를 선택해 주세요." }); return; }
  try { res.json({ adjustment: await assignAdjustmentToRound(Number(req.params.id), t.data.roundId, actorOf(req), req.log) }); } catch (e) { fail(res, req, e, "지급회차 편입"); }
});
router.post("/admin/payout-adjustments/:id/unassign-round", ...manageGuard, async (req, res) => {
  try { res.json({ adjustment: await unassignAdjustmentFromRound(Number(req.params.id), actorOf(req), req.log) }); } catch (e) { fail(res, req, e, "지급회차 편입 해제"); }
});
router.post("/admin/payout-adjustments/:id/settle", ...transferGuard, async (req, res) => {
  const t = z.object({ ref: z.string().max(500).optional().nullable(), note: z.string().max(1000).optional().nullable(), remittanceId: z.number().int().positive().optional().nullable() }).safeParse(req.body ?? {});
  if (!t.success) { res.status(400).json({ error: "입력값을 확인해 주세요." }); return; }
  try { res.json({ adjustment: await settleAdjustmentManually(Number(req.params.id), t.data, actorOf(req), req.log) }); } catch (e) { fail(res, req, e, "정산 완료 처리"); }
});

export default router;
