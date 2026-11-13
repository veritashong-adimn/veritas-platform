// 과거 CRM 판매건 운영 전환 API(건별). 서버에서 권한 검증 · 감사로그 기록.
//   GET  /admin/legacy-archive/:id/activation-preview   전환 미리보기(DB 미변경)
//   POST /admin/legacy-archive/:id/activate              미리보기 확인(planToken) 후 운영 판매건 생성
//   GET  /admin/projects/:id/legacy-origin               운영 판매건의 과거 CRM 출처·확인 대상
//   POST /admin/performances/:id/legacy-payout-review    과거 지급 확인 필요 건 관리자 확인(지급완료/미지급)
//   GET  /admin/projects/:id/legacy-revert-check         과거 CRM 원복 가능 여부(DB 미변경) — 관리자만
//   POST /admin/projects/:id/legacy-revert               과거 CRM 원복 실행(confirm=true) — 관리자만, 감사로그
import { Router, type IRouter } from "express";
import { db, performanceAssignmentsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { suggestStaleSaleLinks } from "../services/legacyPayoutStatus";
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

// 과거 지급 확인 — 지급완료 확인은 실제 지급일·실제 지급액·근거 필수(실제 지급확정 기록). 송금을 실행하지 않는다.
const isYmd = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
function paidInput(b: any): { actualPaymentDate: string; actualPaymentAmount: number } | string {
  if (!isYmd(b?.actualPaymentDate)) return "실제 지급일(YYYY-MM-DD)을 입력하세요.";
  if (b.actualPaymentDate > kstToday()) return "실제 지급일은 오늘 이후일 수 없습니다(지급완료 확인은 이미 지급된 건만).";
  const amt = Number(b?.actualPaymentAmount);
  if (!Number.isFinite(amt) || amt <= 0) return "실제 지급액을 입력하세요.";
  return { actualPaymentDate: b.actualPaymentDate, actualPaymentAmount: Math.round(amt * 100) / 100 };
}
async function resolveAndLog(req: any, id: number, decision: "paid" | "unpaid", reason: string, paid?: { actualPaymentDate: string; actualPaymentAmount: number }, projectId?: number) {
  const r = await resolvePayoutReview(id, decision, reason, { id: req.user?.id ?? null }, paid, projectId);
  await logEvent("project", r.projectId, "legacy_payout_review_resolved", req.log, performerOf(req),
    JSON.stringify({ assignmentId: id, decision, reason, performerName: r.performerName,
      confirmedBy: req.user?.id ?? null, confirmedAt: new Date().toISOString(),
      ...(paid ? { actualPaymentDate: paid.actualPaymentDate, actualPaymentAmount: paid.actualPaymentAmount } : {}),
      before: r.before, after: { paymentStatus: decision === "paid" ? "paid" : "unpaid", ...(paid ?? {}) } }));
  return r;
}

router.post("/admin/performances/:id/legacy-payout-review", ...adminGuard, requirePermission("settlement.pay"), async (req, res) => {
  const id = Number(req.params.id);
  const { decision, reason } = (req.body ?? {}) as { decision?: string; reason?: string };
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  if (decision !== "paid" && decision !== "unpaid") { res.status(400).json({ error: "decision 은 paid | unpaid 여야 합니다." }); return; }
  if (!reason || !reason.trim()) { res.status(400).json({ error: "확인 근거(사유)를 입력하세요." }); return; }
  let paid: { actualPaymentDate: string; actualPaymentAmount: number } | undefined;
  if (decision === "paid") { const p = paidInput(req.body); if (typeof p === "string") { res.status(400).json({ error: p }); return; } paid = p; }
  try {
    await resolveAndLog(req, id, decision, reason.trim(), paid);
    res.json({ ok: true, assignmentId: id, decision, ...(paid ?? {}) });
  } catch (err) { sendError(res, req, err, "과거 지급 확인 처리 실패."); }
});

// 일괄 지급완료 확인 — 선택한 건별로 실제 지급일·지급액을 받아 각각 확정(건별 트랜잭션·중복 확정 차단). 송금 실행 아님.
//   body: { reason, items: [{ assignmentId, actualPaymentDate, actualPaymentAmount }] } → 건별 성공/실패 사유
router.post("/admin/projects/:id/legacy-payout-review/bulk", ...adminGuard, requirePermission("settlement.pay"), async (req, res) => {
  const projectId = Number(req.params.id);
  const { reason, items } = (req.body ?? {}) as { reason?: string; items?: any[] };
  if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  if (!reason || !reason.trim()) { res.status(400).json({ error: "확인 근거(지급 증빙)를 입력하세요." }); return; }
  if (!Array.isArray(items) || items.length === 0 || items.length > 200) { res.status(400).json({ error: "확인할 수행정보를 선택하세요(최대 200건)." }); return; }
  const ids = items.map(i => Number(i?.assignmentId));
  if (ids.some(i => !Number.isInteger(i) || i <= 0) || new Set(ids).size !== ids.length) { res.status(400).json({ error: "수행정보 id 가 올바르지 않거나 중복되었습니다." }); return; }
  const results: Array<{ assignmentId: number; ok: boolean; error?: string; performerName?: string | null }> = [];
  for (const it of items) {
    const id = Number(it.assignmentId);
    const p = paidInput(it);
    if (typeof p === "string") { results.push({ assignmentId: id, ok: false, error: p }); continue; }
    try { const r = await resolveAndLog(req, id, "paid", reason.trim(), p, projectId); results.push({ assignmentId: id, ok: true, performerName: r.performerName }); }
    catch (err: any) { results.push({ assignmentId: id, ok: false, error: err instanceof ActivationError ? err.message : "처리 실패" }); if (!(err instanceof ActivationError)) req.log.error({ err }, "bulk payout review"); }
  }
  res.json({ ok: results.every(r => r.ok), succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
});

// 끊어진 판매상품 연결 — 감사로그 근거 기반 추천 조회 / 근거 있는 건만 일괄 재연결(수행·지급 값 불변, 참조만 변경)
router.get("/admin/projects/:id/stale-sale-links", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try { res.json({ suggestions: await suggestStaleSaleLinks(db, projectId) }); }
  catch (err) { sendError(res, req, err, "연결 추천 조회 실패."); }
});
router.post("/admin/projects/:id/stale-sale-links/relink", ...adminGuard, requirePermission("project.update"), async (req, res) => {
  const projectId = Number(req.params.id);
  const { performanceIds, reason } = (req.body ?? {}) as { performanceIds?: number[]; reason?: string };
  if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  if (!reason || !reason.trim()) { res.status(400).json({ error: "변경 사유를 입력하세요." }); return; }
  if (!Array.isArray(performanceIds) || performanceIds.length === 0) { res.status(400).json({ error: "재연결할 수행정보를 선택하세요." }); return; }
  try {
    const sug = new Map((await suggestStaleSaleLinks(db, projectId)).map(s => [s.performanceId, s]));
    const results: Array<{ performanceId: number; ok: boolean; error?: string; from?: number; to?: number }> = [];
    for (const pid of performanceIds.map(Number)) {
      const s = sug.get(pid);
      if (!s) { results.push({ performanceId: pid, ok: false, error: "끊어진 연결이 아닙니다(이미 정상 연결 또는 다른 판매건)." }); continue; }
      if (!s.suggestedItemId) { results.push({ performanceId: pid, ok: false, error: "연결 근거가 없습니다 — 판매상품을 직접 확인해 선택하세요." }); continue; }
      const upd = await db.update(performanceAssignmentsTable).set({ saleItemId: s.suggestedItemId })
        .where(and(eq(performanceAssignmentsTable.id, pid), eq(performanceAssignmentsTable.saleItemId, s.staleItemId), isNull(performanceAssignmentsTable.deletedAt))).returning({ id: performanceAssignmentsTable.id });
      if (!upd.length) { results.push({ performanceId: pid, ok: false, error: "동시에 변경되었습니다. 새로고침 후 다시 시도하세요." }); continue; }
      await logEvent("project", projectId, "performance_sale_item_relinked", req.log, performerOf(req),
        JSON.stringify({ performanceId: pid, fromSaleItemId: s.staleItemId, toSaleItemId: s.suggestedItemId, reason: reason.trim(), basis: s.basis, via: "evidence_bulk" }));
      results.push({ performanceId: pid, ok: true, from: s.staleItemId, to: s.suggestedItemId });
    }
    res.json({ ok: results.every(r => r.ok), succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
  } catch (err) { sendError(res, req, err, "판매상품 재연결 실패."); }
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
