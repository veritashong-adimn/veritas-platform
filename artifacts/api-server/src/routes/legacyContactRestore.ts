// ─── 과거 CRM 고객 담당자 복원 API ─────────────────────────────────────────────
//   GET  /admin/legacy-contact-restore/preview       분류 통계(읽기 전용)
//   POST /admin/legacy-contact-restore/apply         연결 보정 + 정확 일치 Master 자동 연결({ confirm: true, saleNos?: 표본 })
//   POST /admin/legacy-contact-restore/rollback      배치 되돌리기({ batchId })
//   GET  /admin/legacy-contact-restore/review        담당자 확인 필요(B)·미확인(C) 목록(최신 전체 실행 배치 기준)
//   GET  /admin/legacy-contact-restore/name-preview  이름 기준 전체 자동 연결 사전 분석(읽기 전용 — 건수·예외 사유별 집계, ?detail=1 이면 예외·신규 목록 포함)
//   POST /admin/legacy-contact-restore/name-apply    이름 기준 전체 자동 연결 실행({ confirm: true }) — 되돌리기는 /rollback { batchId }
//   GET  /admin/legacy-company-restore/preview       거래처 미확정 판매의 거래처 Master 복원 사전 분석(읽기 전용, ?detail=1 그룹 목록)
//   POST /admin/legacy-company-restore/apply         거래처 연결·신규 등록 → 담당자 이름 기준 자동 연결을 한 트랜잭션으로({ confirm: true })
//   POST /admin/legacy-company-restore/rollback      { companyBatchId, nameBatchId } — 담당자 배치 → 거래처 배치 순으로 되돌림
import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { classifySales, summarize, applyRestore, rollbackRestore, RESTORE_MODULE, planNameLinks, summarizeNameLinks, applyNameLinks } from "../services/legacyContactRestore";
import { planCompanyLinks, summarizeCompanyLinks, applyCompanyLinks, rollbackCompanyLinks } from "../services/legacyCompanyRestore";

const router: IRouter = Router();
const adminOnly = [requireAuth, requireRole("admin"), requirePermission("project.update")];
// 실행·되돌리기 기록은 import_batches(module=legacy_contact_restore, created_by·status·요약)와 import_row_sources(건별 근거)에 남는다.

router.get("/admin/legacy-contact-restore/preview", ...adminOnly, async (req, res) => {
  try { res.json(summarize(await classifySales(db))); }
  catch (err) { req.log.error({ err }, "contact restore preview failed"); res.status(500).json({ error: "분석 실패." }); }
});

router.post("/admin/legacy-contact-restore/apply", ...adminOnly, async (req, res) => {
  const b = req.body ?? {};
  if (b.confirm !== true) { res.status(400).json({ error: "confirm=true 가 필요합니다." }); return; }
  const saleNos = Array.isArray(b.saleNos) ? b.saleNos.map(String).filter(Boolean) : undefined;
  try {
    const bases = Array.isArray(b.bases) ? b.bases.filter((x: unknown) => x === "single" || x === "single_intl" || x === "multi") : undefined;
    const r = await db.transaction(async tx => applyRestore(tx, { userId: req.user?.id ?? null, saleNos, bases }));
    res.json(r);
  } catch (err) { req.log.error({ err }, "contact restore apply failed"); res.status(500).json({ error: "복원 실행 실패." }); }
});

router.post("/admin/legacy-contact-restore/rollback", ...adminOnly, async (req, res) => {
  const batchId = Number(req.body?.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) { res.status(400).json({ error: "batchId 가 필요합니다." }); return; }
  try {
    const r = await db.transaction(async tx => rollbackRestore(tx, batchId));
    res.json(r);
  } catch (err) { req.log.error({ err }, "contact restore rollback failed"); res.status(500).json({ error: "되돌리기 실패." }); }
});

router.get("/admin/legacy-contact-restore/name-preview", ...adminOnly, async (req, res) => {
  try {
    const plan = await planNameLinks(db);
    res.json({ summary: summarizeNameLinks(plan), ...(req.query.detail === "1" ? { exceptions: plan.exceptions, creates: plan.creates } : {}) });
  } catch (err) { req.log.error({ err }, "name link preview failed"); res.status(500).json({ error: "분석 실패." }); }
});

router.post("/admin/legacy-contact-restore/name-apply", ...adminOnly, async (req, res) => {
  if (req.body?.confirm !== true) { res.status(400).json({ error: "confirm=true 가 필요합니다." }); return; }
  try {
    const r = await db.transaction(async tx => applyNameLinks(tx, { userId: req.user?.id ?? null }));
    res.json(r);
  } catch (err) { req.log.error({ err }, "name link apply failed"); res.status(500).json({ error: "자동 연결 실행 실패(전체 롤백됨)." }); }
});

router.get("/admin/legacy-company-restore/preview", ...adminOnly, async (req, res) => {
  try {
    const groups = await planCompanyLinks(db);
    res.json({ summary: summarizeCompanyLinks(groups), ...(req.query.detail === "1" ? { groups } : {}) });
  } catch (err) { req.log.error({ err }, "company restore preview failed"); res.status(500).json({ error: "분석 실패." }); }
});

router.post("/admin/legacy-company-restore/apply", ...adminOnly, async (req, res) => {
  if (req.body?.confirm !== true) { res.status(400).json({ error: "confirm=true 가 필요합니다." }); return; }
  try {
    const r = await db.transaction(async tx => {
      const company = await applyCompanyLinks(tx, { userId: req.user?.id ?? null });
      const contact = await applyNameLinks(tx, { userId: req.user?.id ?? null });   // 거래처가 생긴 판매의 담당자 연결(기존 기능 재사용)
      return { company, contact };
    });
    res.json(r);
  } catch (err) { req.log.error({ err }, "company restore apply failed"); res.status(500).json({ error: "거래처 복원 실행 실패(전체 롤백됨)." }); }
});

router.post("/admin/legacy-company-restore/rollback", ...adminOnly, async (req, res) => {
  const companyBatchId = Number(req.body?.companyBatchId); const nameBatchId = req.body?.nameBatchId != null ? Number(req.body.nameBatchId) : null;
  if (!Number.isInteger(companyBatchId) || companyBatchId <= 0) { res.status(400).json({ error: "companyBatchId 가 필요합니다." }); return; }
  try {
    const r = await db.transaction(async tx => ({
      contact: nameBatchId ? await rollbackRestore(tx, nameBatchId) : null,
      company: await rollbackCompanyLinks(tx, companyBatchId),
    }));
    res.json(r);
  } catch (err) { req.log.error({ err }, "company restore rollback failed"); res.status(500).json({ error: "되돌리기 실패." }); }
});

router.get("/admin/legacy-contact-restore/review", ...[requireAuth, requireRole("admin", "staff")], async (req, res) => {
  const status = req.query.status === "unverified" ? "unverified" : "review";
  try {
    const list = (await db.execute(sql`SELECT r.entity_id "saleRowId", r.legacy_id "saleNo", r.source_raw "evidence", s.company_name "companyName", s.product_name "productName", s.total_amount "totalAmount"
      FROM import_row_sources r JOIN import_batches b ON b.id = r.batch_id AND b.module = ${RESTORE_MODULE} AND b.is_current
      LEFT JOIN legacy_archive_rows s ON s.id = r.entity_id
      WHERE r.module = ${RESTORE_MODULE} AND r.status = ${status} ORDER BY r.legacy_id DESC`)).rows;
    res.json({ status, rows: list });
  } catch (err) { req.log.error({ err }, "contact restore review failed"); res.status(500).json({ error: "목록 조회 실패." }); }
});

export default router;
