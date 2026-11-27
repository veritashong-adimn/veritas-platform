// ─── 지급 준비 점검 API(READ-ONLY) — services/payoutReadiness ─────────────────────────────────────
//   GET /admin/payout-unified/readiness?date=YYYY-MM-DD[&scope=date|all] → 통합 지급행(플랫폼·과거 CRM 전환·CRM 원본) A/B/C/D 분류 + 사유·조치
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requireStaffPermission, requireAdminExport } from "../middlewares/auth";
import { computePayoutReadiness, loadResidentNumbers, loadProjectProfits } from "../services/payoutReadiness";
import { getPermissionsForRole } from "../lib/rbac";
import { logEvent } from "../lib/logEvent";
import { maskPhoneLast4 } from "../lib/phoneMask";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin", "staff"), requireStaffPermission(["payout.view", "payout.statement"], { allowStaffWithoutRole: true })];

router.get("/admin/payout-unified/readiness", ...guard, async (req, res) => {
  // scope=date(기본): 지급일 기준 지급 후보 + 누락 방지 교차조회 / scope=all: 전체 기간 지급 누락·날짜 공란·확인필요
  const scope = req.query.scope === "all" ? "all" : "date";
  const date = String(req.query.date ?? "");
  if (scope === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "date(YYYY-MM-DD)가 필요합니다." }); return; }
  try {
    const r = await computePayoutReadiness(db, { scope, date });
    // 연락처 — 통번역사 명부와 같은 기준(역할 미지정 관리자·직원 또는 project.update 보유자만 전체, 그 외 끝 4자리 마스킹)
    const roleId = (req as any).user?.roleId ?? null;
    const contactVisible = !roleId || (await getPermissionsForRole(roleId)).has("project.update");
    if (!contactVisible) for (const o of r.items as any[]) o.payeePhone = maskPhoneLast4(o.payeePhone);
    res.json({ ...r, canRevealResidentNumber: await canRevealRrn(req) });
  }
  catch (err) { req.log.error({ err }, "지급 준비 점검 조회 실패"); res.status(500).json({ error: "지급 준비 점검 조회 실패." }); }
});

// 주민번호 전체 열람 — 관리자(admin)만: 슈퍼관리자(역할 미지정) 또는 translator.sensitive 권한 보유 역할. 일반 직원(staff) 불가.
async function canRevealRrn(req: any): Promise<boolean> {
  const u = req.user;
  if (!u || u.role !== "admin") return false;
  if (!u.roleId) return true;
  return (await getPermissionsForRole(u.roleId)).has("translator.sensitive");
}

// ─── 지급준비점검 '전체번호 엑셀' 전용 — POST body { translatorIds } → { residentNumbers: { [id]: '900101-1234567' } } ─────
//   번호를 URL·쿼리에 싣지 않고(POST), 캐시 금지. 응답값·번호는 로그에 남기지 않으며 열람 사실(건수)만 기록한다.
router.post("/admin/payout-unified/readiness/resident-numbers", ...guard, requireAdminExport, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!(await canRevealRrn(req))) { res.status(403).json({ error: "주민등록번호 전체 열람 권한이 없습니다(관리자 전용)." }); return; }
  const ids = Array.isArray(req.body?.translatorIds) ? (req.body.translatorIds as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  if (!ids.length || ids.length > 5000) { res.status(400).json({ error: "translatorIds(1~5000건)가 필요합니다." }); return; }
  try {
    const m = await loadResidentNumbers(db, ids, true);
    await logEvent("translator", 0, "resident_number.bulk_reveal", req.log, req.user, JSON.stringify({ via: "payout_readiness_excel", requested: new Set(ids).size, revealed: m.size }));
    res.json({ residentNumbers: Object.fromEntries(m) });
  } catch (err) { req.log.error({ err: (err as Error)?.message }, "지급준비점검 주민번호 조회 실패"); res.status(500).json({ error: "주민등록번호 조회 실패." }); }
});

// ─── 지급준비점검 엑셀 수익금액·수익률 전용 — POST body { projectIds } → { profits: { [projectId]: { amount, rate, supply, cost, cancelled } | null } } ─────
//   엑셀 다운로드 시에만 호출(화면 조회에서는 손익 계산 안 함). 프로젝트 손익 요약과 같은 공용 계산. 조회 전용.
router.post("/admin/payout-unified/readiness/project-profits", ...guard, async (req, res) => {
  const ids = Array.isArray(req.body?.projectIds) ? (req.body.projectIds as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  if (ids.length > 5000) { res.status(400).json({ error: "projectIds는 5000건 이하여야 합니다." }); return; }
  try { res.json({ profits: Object.fromEntries(await loadProjectProfits(ids)) }); }
  catch (err) { req.log.error({ err: (err as Error)?.message }, "지급준비점검 프로젝트 손익 조회 실패"); res.status(500).json({ error: "프로젝트 손익 조회 실패." }); }
});

export default router;
