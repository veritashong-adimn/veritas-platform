// ─── 과거 CRM 수행행 행 단위 통번역사 재연결 API — 동명이인 수행이력 분리(services/legacyRowTranslatorLink) ───────
//   POST /admin/legacy-progress-rows/:id/translator-link  { translatorId, reason }
//   · 원본 수행행·지급·정산·판매 연결은 변경하지 않고, 이력 귀속(행 단위 매핑)만 기록. 감사로그(legacy_row_relinked).
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { linkProgressRowToTranslator, RowLinkError } from "../services/legacyRowTranslatorLink";

const router: IRouter = Router();
const guard = [requireAuth, requireRole("admin"), requirePermission("translator.sensitive")];

router.post("/admin/legacy-progress-rows/:id/translator-link", ...guard, async (req, res) => {
  const rowId = Number(req.params.id);
  const translatorId = Number(req.body?.translatorId);
  if (!Number.isInteger(rowId) || rowId <= 0 || !Number.isInteger(translatorId) || translatorId <= 0) {
    res.status(400).json({ error: "수행행 id 와 translatorId 가 필요합니다." }); return;
  }
  try {
    const out = await db.transaction((tx: any) => linkProgressRowToTranslator(tx, rowId, translatorId, {
      userId: req.user?.id ?? null, userEmail: req.user?.email ?? null, reason: String(req.body?.reason ?? ""),
    }));
    res.json({ ok: true, ...out });
  } catch (err: any) {
    if (err instanceof RowLinkError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    req.log.error({ err }, "legacy row translator link failed");
    res.status(500).json({ error: "재연결 실패(변경 없음)." });
  }
});

export default router;
