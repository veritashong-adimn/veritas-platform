// ─── 통번역사 대량등록 통합 판정 · 대표 승인 · 실행 · 되돌리기 API ─────────────────────
//   POST /admin/translators/import-plan/preview              Excel 업로드 → 원본 암호화 보관 + 5유형 판정(DB 미변경)
//   POST /admin/translators/import-plan/page                 보관 원본 기준 유형별 페이지 조회(DB 미변경)
//   POST /admin/translators/import-plan/review               동일인 수동 확인 비교 상세(업로드 vs 후보 Master·수행이력·통합관계)
//   POST /admin/translators/import-plan/review/decision      수동 판정 저장(감사로그 · 재분석 시 유지, 관리자)
//   POST /admin/translators/import-plan/execute              대표 승인 후 실행(관리자, 승인 토큰·수동 결정 필요)
//   GET  /admin/translators/import-plan/batches              통합 승인 경로 배치 이력
//   GET  /admin/translators/import-plan/batches/:id/rollback-preview
//   POST /admin/translators/import-plan/batches/:id/rollback
// 기존 일반 등록(bulk-import/execute)·재구축 실행(rebuild-execute commit)은 이 경로로 일원화(중복 Master 방지).
import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { saveSnapshot, readSnapshotBuffer, getSnapshotMeta, isValidSnapshotId, pruneExpired } from "../lib/importSnapshot";
import {
  buildImportPlan, planSummary, planPage, executeImportPlan, planImportRollback, executeImportRollback, listImportBatches,
  PlanError, PLAN_CATEGORIES, REASON_LABEL, type PlanCategory, type ManualDecision, type ImportPlan,
  buildReviewDetail, saveReviewDecision, loadSavedDecisions,
} from "../services/translatorImportPlan";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const approverGuard = [requireAuth, requireRole("admin")];
const excelUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => { const n = (file.originalname || "").toLowerCase(); if (n.endsWith(".xls") || n.endsWith(".xlsx")) cb(null, true); else cb(new Error(".xls 또는 .xlsx 파일만 업로드할 수 있습니다.")); },
});
const decodeFileName = (raw?: string) => { if (!raw) return ""; try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; } };

// 판정 결과 캐시(스냅샷 id 단위). 승인 토큰(기준 지문)이 같을 때만 재사용 — 기준이 바뀌면 다시 계산.
const cache = new Map<string, { plan: ImportPlan; at: number }>();
async function planFor(snapshotId: string): Promise<{ plan: ImportPlan; buf: Buffer; fileName: string }> {
  const meta = getSnapshotMeta(snapshotId); const buf = readSnapshotBuffer(snapshotId);
  if (!meta || !buf) throw new PlanError("SNAPSHOT_NOT_FOUND", 404, "업로드 원본을 찾을 수 없습니다. 파일을 다시 업로드하세요.");
  const c = cache.get(snapshotId);
  const fresh = await buildImportPlan(db, buf);   // 약 1초(2천 행) — 기준 변동 감지를 위해 매번 계산
  if (!c || c.plan.planToken !== fresh.planToken) cache.set(snapshotId, { plan: fresh, at: Date.now() });
  for (const [k, v] of cache) if (Date.now() - v.at > 30 * 60 * 1000) cache.delete(k);
  return { plan: fresh, buf, fileName: meta.filename };
}
const coerceCat = (v: unknown): PlanCategory | "ALL" => (PLAN_CATEGORIES as string[]).includes(String(v)) ? (v as PlanCategory) : "ALL";
const sendErr = (res: any, req: any, err: unknown, label: string) => {
  if (err instanceof PlanError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  req.log.error({ err }, label); res.status(500).json({ error: `${label} 실패.` });
};

router.post("/admin/translators/import-plan/preview", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) { res.status(400).json({ error: "엑셀 파일(file)이 필요합니다." }); return; }
    pruneExpired();
    const plan0 = await buildImportPlan(db, req.file.buffer);
    const snap = saveSnapshot("translator", req.file.buffer, { filename: decodeFileName(req.file.originalname), sheetName: "", totalRows: plan0.rows.length, createdBy: (req as any).user?.id ?? null });
    cache.set(snap.id, { plan: plan0, at: Date.now() });
    res.json({ snapshotId: snap.id, summary: planSummary(plan0), reasonLabels: REASON_LABEL, page: planPage(plan0, coerceCat(req.body?.cat), 1, Number(req.body?.pageSize) || 50) });
  } catch (err) { sendErr(res, req, err, "통합 판정 미리보기"); }
});

router.post("/admin/translators/import-plan/page", ...adminGuard, async (req, res) => {
  try {
    const sid = String(req.body?.snapshotId ?? "");
    if (!isValidSnapshotId(sid)) { res.status(400).json({ error: "잘못된 스냅샷 ID." }); return; }
    const { plan } = await planFor(sid);
    const page = planPage(plan, coerceCat(req.body?.cat), Number(req.body?.page) || 1, Number(req.body?.pageSize) || 50, req.body?.q);
    const saved = await loadSavedDecisions(db);
    const reviewed = plan.rows.filter(r => r.category === "MANUAL" && !r.firstRowOfDuplicate && saved.has(r.personKey)).length;
    res.json({ summary: { ...planSummary(plan), reviewedManual: reviewed }, reasonLabels: REASON_LABEL,
      page: { ...page, rows: page.rows.map(r => ({ ...r, savedDecision: saved.get(r.personKey) ?? null })) } });
  } catch (err) { sendErr(res, req, err, "판정 페이지 조회"); }
});

router.post("/admin/translators/import-plan/review", ...adminGuard, async (req, res) => {
  try {
    const sid = String(req.body?.snapshotId ?? "");
    if (!isValidSnapshotId(sid)) { res.status(400).json({ error: "잘못된 스냅샷 ID." }); return; }
    const { plan, buf } = await planFor(sid);
    res.json(await buildReviewDetail(db, buf, plan, Number(req.body?.rowNumber)));
  } catch (err) { sendErr(res, req, err, "수동 확인 상세"); }
});

router.post("/admin/translators/import-plan/review/decision", ...approverGuard, async (req, res) => {
  try {
    const sid = String(req.body?.snapshotId ?? "");
    if (!isValidSnapshotId(sid)) { res.status(400).json({ error: "잘못된 스냅샷 ID." }); return; }
    const { plan } = await planFor(sid);
    const rec = await saveReviewDecision(db, { plan, rowNumber: Number(req.body?.rowNumber), decision: String(req.body?.decision ?? "") as ManualDecision,
      note: req.body?.note ? String(req.body.note) : null, snapshotId: sid, performerId: (req as any).user?.id ?? null });
    res.json({ saved: rec });
  } catch (err) { sendErr(res, req, err, "수동 판정 저장"); }
});

router.post("/admin/translators/import-plan/execute", ...approverGuard, async (req, res) => {
  try {
    const sid = String(req.body?.snapshotId ?? "");
    if (!isValidSnapshotId(sid)) { res.status(400).json({ error: "잘못된 스냅샷 ID." }); return; }
    if (req.body?.approve !== true) { res.status(400).json({ error: "대표 승인(approve=true)이 필요합니다.", code: "APPROVAL_REQUIRED" }); return; }
    const decisions: Record<string, ManualDecision> = {};
    for (const [k, v] of Object.entries(req.body?.decisions ?? {})) { const s = String(v); if (["new", "hold", "different", "different_own_history"].includes(s) || /^link:\d+$/.test(s)) decisions[k] = s as ManualDecision; }
    const meta = getSnapshotMeta(sid); const buf = readSnapshotBuffer(sid);
    if (!meta || !buf) { res.status(404).json({ error: "업로드 원본을 찾을 수 없습니다." }); return; }
    const result = await db.transaction(async (tx) => executeImportPlan(tx, {
      buffer: buf, fileName: meta.filename, snapshotId: sid, planToken: String(req.body?.planToken ?? ""), decisions, performerId: (req as any).user?.id ?? null,
    }));
    cache.delete(sid);
    res.json(result);
  } catch (err) { sendErr(res, req, err, "통번역사 등록 실행"); }
});

router.get("/admin/translators/import-plan/batches", ...adminGuard, async (req, res) => {
  try { res.json({ batches: await listImportBatches(db) }); } catch (err) { sendErr(res, req, err, "등록 이력 조회"); }
});
router.get("/admin/translators/import-plan/batches/:id/rollback-preview", ...approverGuard, async (req, res) => {
  try { res.json(await planImportRollback(db, Number(req.params.id))); } catch (err) { sendErr(res, req, err, "되돌리기 미리보기"); }
});
router.post("/admin/translators/import-plan/batches/:id/rollback", ...approverGuard, async (req, res) => {
  try {
    if (req.body?.confirm !== true) { res.status(400).json({ error: "되돌리기 확인(confirm=true)이 필요합니다." }); return; }
    const r = await db.transaction(async (tx) => executeImportRollback(tx, Number(req.params.id), (req as any).user?.id ?? null));
    res.json(r);
  } catch (err) { sendErr(res, req, err, "배치 되돌리기"); }
});

export default router;
