// 과거 CRM 판매건 운영 전환 API(건별). 서버에서 권한 검증 · 감사로그 기록.
//   GET  /admin/legacy-archive/:id/activation-preview   전환 미리보기(DB 미변경)
//   POST /admin/legacy-archive/:id/activate              미리보기 확인(planToken) 후 운영 판매건 생성
//   GET  /admin/projects/:id/legacy-origin               운영 판매건의 과거 CRM 출처·확인 대상
//   POST /admin/performances/:id/legacy-payout-review    과거 지급 확인 필요 건 관리자 확인(지급완료/미지급)
//   GET  /admin/projects/:id/legacy-revert-check         과거 CRM 원복 가능 여부(DB 미변경) — 관리자만
//   POST /admin/projects/:id/legacy-revert               과거 CRM 원복 실행(confirm=true) — 관리자만, 감사로그
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import {
  buildActivationPlan, executeActivation, getLegacyOrigin, resolvePayoutReview, publicPlan, ActivationError,
} from "../services/legacySaleActivation";
import { checkLegacySaleRevert, executeLegacySaleRevert, REVERT_BLOCKED_MESSAGE } from "../services/legacySaleRevert";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const adminOnly  = [requireAuth, requireRole("admin")];
const performerOf = (req: any) => (req.user ? { id: req.user.id, email: req.user.email } : undefined);

function sendError(res: any, req: any, err: any, fallback: string) {
  if (err instanceof ActivationError) { res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra ?? {}) }); return; }
  if (String(err?.code ?? err?.cause?.code) === "23505" || /uq_legacy_master_mappings/.test(String(err?.message ?? "") + String(err?.cause?.message ?? ""))) { res.status(409).json({ error: "이미 운영 판매건으로 전환된 판매입니다.", code: "ALREADY_ACTIVATED" }); return; }
  req.log.error({ err }, fallback);
  res.status(500).json({ error: fallback });
}

router.get("/admin/legacy-archive/:id/activation-preview", ...adminGuard, requirePermission("project.create"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try { res.json(publicPlan(await buildActivationPlan(db, id))); }
  catch (err) { sendError(res, req, err, "전환 미리보기 실패."); }
});

router.post("/admin/legacy-archive/:id/activate", ...adminGuard, requirePermission("project.create"), requirePermission("quote.create"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  if ((req.body as any)?.confirm !== true) { res.status(400).json({ error: "미리보기 확인(confirm=true)이 필요합니다." }); return; }
  try {
    const r = await executeActivation(id, String((req.body as any)?.planToken ?? ""), { id: req.user?.id ?? null });
    await logEvent("project", r.projectId, "legacy_sale_activated", req.log, performerOf(req), JSON.stringify({
      legacyRowId: id, saleNo: r.plan.saleNo, quoteId: r.quoteId, batchId: r.batchId, paymentRecordId: r.paymentRecordId,
      company: { name: r.plan.company.name, matchedId: r.plan.company.matchedId }, contact: { name: r.plan.contact.name, matchedId: r.plan.contact.matchedId },
      total: r.plan.total, performances: r.plan.perfSummary, collection: { status: r.plan.collection.status, reason: r.plan.collection.reason },
    }));
    res.status(201).json({ projectId: r.projectId, quoteId: r.quoteId, performances: r.plan.perfSummary, collection: r.plan.collection.status });
  } catch (err) { sendError(res, req, err, "운영 판매건 전환 실패."); }
});

router.get("/admin/projects/:id/legacy-origin", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try { res.json({ origin: await getLegacyOrigin(db, id) }); }
  catch (err) { sendError(res, req, err, "과거 CRM 출처 조회 실패."); }
});

router.post("/admin/performances/:id/legacy-payout-review", ...adminGuard, requirePermission("settlement.pay"), async (req, res) => {
  const id = Number(req.params.id);
  const { decision, reason } = (req.body ?? {}) as { decision?: string; reason?: string };
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  if (decision !== "paid" && decision !== "unpaid") { res.status(400).json({ error: "decision 은 paid | unpaid 여야 합니다." }); return; }
  if (!reason || !reason.trim()) { res.status(400).json({ error: "확인 근거(사유)를 입력하세요." }); return; }
  try {
    const r = await resolvePayoutReview(id, decision, reason.trim(), { id: req.user?.id ?? null });
    await logEvent("project", r.projectId, "legacy_payout_review_resolved", req.log, performerOf(req),
      JSON.stringify({ assignmentId: id, decision, reason: reason.trim(), before: r.before, after: { paymentStatus: decision === "paid" ? "paid" : "unpaid" } }));
    res.json({ ok: true, assignmentId: id, decision });
  } catch (err) { sendError(res, req, err, "과거 지급 확인 처리 실패."); }
});

// ── 과거 CRM 원복(관리자 전용) ────────────────────────────────────────────────
router.get("/admin/projects/:id/legacy-revert-check", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try {
    const c = await checkLegacySaleRevert(db, id);
    res.json({ canRevert: c.canRevert, reasons: c.reasons, message: c.canRevert ? null : REVERT_BLOCKED_MESSAGE, saleNo: c.saleNo, modified: c.modified });
  } catch (err) { sendError(res, req, err, "원복 가능 여부 확인 실패."); }
});

router.post("/admin/projects/:id/legacy-revert", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  if ((req.body as any)?.confirm !== true) { res.status(400).json({ error: "원복 확인(confirm=true)이 필요합니다." }); return; }
  try {
    const r = await executeLegacySaleRevert(id, { id: req.user?.id ?? null });
    await logEvent("project", id, "legacy_sale_reverted", req.log, performerOf(req), JSON.stringify({
      event: "LEGACY_SALE_REVERTED", result: "reverted", projectId: id, saleNo: r.saleNo, legacyRowId: r.legacyRowId, quoteId: r.quoteId,
      before: r.before, after: r.after, modifiedAfterActivation: r.modified, preserved: r.preserved,
    }));
    res.json({ ok: true, projectId: id, saleNo: r.saleNo, legacyRowId: r.legacyRowId });
  } catch (err) {
    if (err instanceof ActivationError && err.code === "REVERT_BLOCKED") {
      await logEvent("project", id, "legacy_sale_revert_blocked", req.log, performerOf(req),
        JSON.stringify({ event: "LEGACY_SALE_REVERT_BLOCKED", result: "blocked", projectId: id, reasons: (err.extra as any)?.reasons ?? [] }));
    }
    sendError(res, req, err, "과거 CRM 원복 실패.");
  }
});

export default router;
