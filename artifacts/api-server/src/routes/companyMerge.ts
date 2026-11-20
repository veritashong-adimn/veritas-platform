// ─── 거래처 중복 통합 API(services/companyMerge) — 관리자 전용 ─────────────────────────────────────
//   GET  /admin/companies/:id/merge-preview?sourceId=  → 이동 대상·충돌·중복 담당자(DB 미변경)
//   POST /admin/companies/:id/merge-from/:sourceId { reason }  → 단일 트랜잭션 통합(source soft delete · 감사로그)
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { previewCompanyMerge, executeCompanyMerge, CompanyMergeError } from "../services/companyMerge";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin"), requirePermission("company.update")];
const fail = (res: any, req: any, err: any, msg: string) => {
  if (err instanceof CompanyMergeError) { res.status(err.status).json({ error: err.message, code: err.code, detail: err.detail ?? null }); return; }
  req.log.error({ err }, msg); res.status(500).json({ error: `${msg}(변경 없음).` });
};

router.get("/admin/companies/:id/merge-preview", ...guard, async (req, res) => {
  const targetId = Number(req.params.id), sourceId = Number(req.query.sourceId);
  if (!Number.isInteger(targetId) || !Number.isInteger(sourceId)) { res.status(400).json({ error: "거래처 id 가 필요합니다." }); return; }
  try { res.json(await previewCompanyMerge(db, targetId, sourceId)); } catch (err) { fail(res, req, err, "통합 미리보기 실패"); }
});

router.post("/admin/companies/:id/merge-from/:sourceId", ...guard, async (req, res) => {
  const targetId = Number(req.params.id), sourceId = Number(req.params.sourceId);
  if (!Number.isInteger(targetId) || !Number.isInteger(sourceId)) { res.status(400).json({ error: "거래처 id 가 필요합니다." }); return; }
  try {
    const out = await db.transaction((tx: any) => executeCompanyMerge(tx, targetId, sourceId, { userId: req.user?.id ?? null, userEmail: req.user?.email ?? null, reason: String(req.body?.reason ?? "") }));
    res.json({ ok: true, ...out });
  } catch (err) { fail(res, req, err, "거래처 통합 실패"); }
});

export default router;
