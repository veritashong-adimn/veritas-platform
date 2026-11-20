// ─── 지급 준비 점검 API(READ-ONLY) — services/payoutReadiness ─────────────────────────────────────
//   GET /admin/payout-unified/readiness?date=YYYY-MM-DD[&scope=date|all] → 통합 지급행(플랫폼·과거 CRM 전환·CRM 원본) A/B/C/D 분류 + 사유·조치
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requireStaffPermission } from "../middlewares/auth";
import { computePayoutReadiness } from "../services/payoutReadiness";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin", "staff"), requireStaffPermission(["payout.view", "payout.statement"], { allowStaffWithoutRole: true })];

router.get("/admin/payout-unified/readiness", ...guard, async (req, res) => {
  // scope=date(기본): 지급일 기준 지급 후보 + 누락 방지 교차조회 / scope=all: 전체 기간 지급 누락·날짜 공란·확인필요
  const scope = req.query.scope === "all" ? "all" : "date";
  const date = String(req.query.date ?? "");
  if (scope === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "date(YYYY-MM-DD)가 필요합니다." }); return; }
  try { res.json(await computePayoutReadiness(db, { scope, date })); }
  catch (err) { req.log.error({ err }, "지급 준비 점검 조회 실패"); res.status(500).json({ error: "지급 준비 점검 조회 실패." }); }
});

export default router;
