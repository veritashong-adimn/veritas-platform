// ─── 과거 CRM 반복 업로드 — 미리보기·되돌리기·변경로그 API ─────────────────────────
//   POST /admin/legacy-archive/sync-preview                5분류 미리보기(DB 미변경) + 승인 토큰 + previewId(서버 캐시)
//   POST /admin/legacy-archive/sync-preview/page           캐시된 미리보기의 분류·페이지 조회(파일 재전송·재파싱 없음)
//   GET  /admin/legacy-archive/batches/:id/changes          배치 변경 로그(import_row_sources)
//   GET  /admin/legacy-archive/batches/:id/rollback-preview 되돌리기 영향 미리보기(DB 미변경)
//   POST /admin/legacy-archive/batches/:id/rollback         배치 되돌리기(관리자 승인, 삭제 없음)
// 반영(execute)은 기존 경로 POST /admin/legacy-archive/execute 에서 승인 토큰과 함께 수행한다.
//
// 판매목록·진행관리표 통합 동기화(최신 파일 기준 · 같은 기준일 · 전부 또는 전무):
//   GET  /admin/legacy-archive/full-sync/status               최종 동기화 기준일
//   POST /admin/legacy-archive/full-sync/preview              두 파일 미리보기(DB 미변경) → fullSyncId + 승인 토큰 2개
//   POST /admin/legacy-archive/full-sync/page                 미리보기 분류별 상세(캐시)
//   POST /admin/legacy-archive/full-sync/execute              '최신 자료로 동기화'(관리자, 단일 트랜잭션)
//   GET  /admin/legacy-archive/full-sync/runs                 통합 동기화 이력
//   POST /admin/legacy-archive/full-sync/runs/:runId/rollback 통합 동기화 되돌리기(두 배치 동시)
import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { ARCHIVE_SOURCE_TYPES, type ArchiveSourceType } from "../services/legacyArchiveResolve";
import {
  buildSyncPreview, summarizePreview, previewPage, planBatchRollback, executeBatchRollback, listBatchChanges, SyncError,
  cachePreview, getCachedPreview,
  buildFullSyncPreview, getFullSyncSet, summarizeFullSync, executeFullSync, listFullSyncRuns, rollbackFullSync, lastSyncAsOf,
  type SyncClass, type SyncScope,
} from "../services/legacyArchiveSync";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
// 실제 반영·되돌리기는 관리자(대표) 권한만.
const approverGuard = [requireAuth, requireRole("admin")];

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    if (name.endsWith(".xls") || name.endsWith(".xlsx")) cb(null, true);
    else cb(new Error(".xls 또는 .xlsx 파일만 업로드할 수 있습니다."));
  },
});

const PAGE_CLASSES = ["NEW", "UPDATED", "SAME", "AMBIGUOUS", "DELETION_SUSPECT", "DELETION_CONFLICT", "CHANGES"] as const;
type PageCls = SyncClass | "DELETION_SUSPECT" | "DELETION_CONFLICT" | "CHANGES";
function decodeFileName(raw: string | undefined): string { if (!raw) return ""; try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; } }
export function coerceScope(v: unknown): SyncScope { return v === "full" ? "full" : "range"; }

router.post("/admin/legacy-archive/sync-preview", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  try {
    const sourceType = req.body?.sourceType as ArchiveSourceType;
    if (!ARCHIVE_SOURCE_TYPES.includes(sourceType)) { res.status(400).json({ error: "sourceType 은 sales_list | progress | translator_list 중 하나여야 합니다." }); return; }
    if (!req.file?.buffer) { res.status(400).json({ error: "엑셀 파일(file)이 필요합니다." }); return; }
    const cls = (PAGE_CLASSES as readonly string[]).includes(req.body?.cls) ? (req.body.cls as PageCls) : "CHANGES";
    const started = Date.now();
    const p = await buildSyncPreview(db, { buffer: req.file.buffer, sourceType, scope: coerceScope(req.body?.scope) });
    const previewId = cachePreview(p, (req as any).user?.id ?? null);
    res.json({ previewId, elapsedMs: Date.now() - started, summary: summarizePreview(p), page: previewPage(p, cls, Number(req.body?.page) || 1, Number(req.body?.pageSize) || 50) });
  } catch (err) {
    if (err instanceof SyncError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    req.log.error({ err }, "legacy-archive sync-preview failed");
    res.status(500).json({ error: "변경분 미리보기 실패." });
  }
});

router.post("/admin/legacy-archive/sync-preview/page", ...adminGuard, async (req, res) => {
  try {
    const p = getCachedPreview(String(req.body?.previewId ?? ""), (req as any).user?.id ?? null);
    if (!p) { res.status(410).json({ error: "미리보기 결과가 만료되었습니다. 변경분 미리보기를 다시 실행하세요.", code: "PREVIEW_EXPIRED" }); return; }
    const cls = (PAGE_CLASSES as readonly string[]).includes(req.body?.cls) ? (req.body.cls as PageCls) : "CHANGES";
    res.json({ summary: summarizePreview(p), page: previewPage(p, cls, Number(req.body?.page) || 1, Number(req.body?.pageSize) || 50) });
  } catch (err) {
    req.log.error({ err }, "legacy-archive sync-preview page failed");
    res.status(500).json({ error: "미리보기 페이지 조회 실패." });
  }
});

router.get("/admin/legacy-archive/batches/:id/changes", ...adminGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "잘못된 배치 id" }); return; }
    const q = req.query as Record<string, string | undefined>;
    res.json(await listBatchChanges(db, id, q.status?.trim() || null, Number(q.page) || 1, Number(q.pageSize) || 50));
  } catch (err) {
    req.log.error({ err }, "legacy-archive batch changes failed");
    res.status(500).json({ error: "변경 로그 조회 실패." });
  }
});

router.get("/admin/legacy-archive/batches/:id/rollback-preview", ...approverGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "잘못된 배치 id" }); return; }
    res.json(await planBatchRollback(db, id));
  } catch (err) {
    req.log.error({ err }, "legacy-archive rollback-preview failed");
    res.status(500).json({ error: "되돌리기 미리보기 실패." });
  }
});

router.post("/admin/legacy-archive/batches/:id/rollback", ...approverGuard, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "잘못된 배치 id" }); return; }
    if (req.body?.confirm !== true && req.body?.confirm !== "true") { res.status(400).json({ error: "되돌리기 확인(confirm=true)이 필요합니다." }); return; }
    const performerId = (req as any).user?.id ?? null;
    const result = await db.transaction(async (tx) => executeBatchRollback(tx, id, performerId));
    res.json(result);
  } catch (err) {
    if (err instanceof SyncError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    req.log.error({ err }, "legacy-archive rollback failed");
    res.status(500).json({ error: "배치 되돌리기 실패(변경 없음)." });
  }
});

// ─── 통합 동기화 ────────────────────────────────────────────────────────────────
router.get("/admin/legacy-archive/full-sync/status", ...adminGuard, async (req, res) => {
  try { res.json({ lastAsOf: await lastSyncAsOf(db) }); }
  catch (err) { req.log.error({ err }, "full-sync status failed"); res.status(500).json({ error: "동기화 상태 조회 실패." }); }
});

router.post("/admin/legacy-archive/full-sync/preview", ...adminGuard,
  excelUpload.fields([{ name: "salesFile", maxCount: 1 }, { name: "progressFile", maxCount: 1 }]), async (req, res) => {
  try {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const sf = files.salesFile?.[0], pf = files.progressFile?.[0];
    if (!sf?.buffer || !pf?.buffer) { res.status(400).json({ error: "판매목록 파일과 진행관리표 파일이 모두 필요합니다.", code: "FILE_MISSING" }); return; }
    const asOfDate = String(req.body?.asOfDate ?? "").trim();
    const started = Date.now();
    const set = await buildFullSyncPreview(db, { salesBuffer: sf.buffer, progressBuffer: pf.buffer, salesName: decodeFileName(sf.originalname), progressName: decodeFileName(pf.originalname),
      asOfDate, scope: coerceScope(req.body?.scope), userId: (req as any).user?.id ?? null });
    res.json({ elapsedMs: Date.now() - started, summary: summarizeFullSync(set) });
  } catch (err) {
    if (err instanceof SyncError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    req.log.error({ err }, "full-sync preview failed");
    res.status(500).json({ error: "통합 동기화 미리보기 실패." });
  }
});

router.post("/admin/legacy-archive/full-sync/page", ...adminGuard, async (req, res) => {
  try {
    const set = getFullSyncSet(String(req.body?.fullSyncId ?? ""), (req as any).user?.id ?? null);
    if (!set) { res.status(410).json({ error: "미리보기 결과가 만료되었습니다. 다시 미리보기하세요.", code: "PREVIEW_EXPIRED" }); return; }
    const p = req.body?.source === "sales_list" ? set.sales : set.progress;
    const cls = (PAGE_CLASSES as readonly string[]).includes(req.body?.cls) ? (req.body.cls as PageCls) : "CHANGES";
    res.json({ page: previewPage(p, cls, Number(req.body?.page) || 1, Number(req.body?.pageSize) || 50) });
  } catch (err) { req.log.error({ err }, "full-sync page failed"); res.status(500).json({ error: "미리보기 상세 조회 실패." }); }
});

router.post("/admin/legacy-archive/full-sync/execute", ...approverGuard, async (req, res) => {
  try {
    if (req.body?.confirm !== true) { res.status(400).json({ error: "실행 확인(confirm=true)이 필요합니다.", code: "APPROVAL_REQUIRED" }); return; }
    const userId = (req as any).user?.id ?? null;
    const result = await db.transaction(async (tx) => executeFullSync(tx, {
      fullSyncId: String(req.body?.fullSyncId ?? ""), salesToken: String(req.body?.salesToken ?? ""), progressToken: String(req.body?.progressToken ?? ""), userId, cancelConfirmedSales: req.body?.cancelConfirmedSales === true, cancelLinkedProgress: req.body?.cancelLinkedProgress === true,
    }));
    res.json(result);
  } catch (err) {
    if (err instanceof SyncError) { res.status(err.status).json({ error: err.message, code: err.code, detail: err.detail }); return; }
    req.log.error({ err }, "full-sync execute failed");
    res.status(500).json({ error: `통합 동기화 실패 — 전체 롤백되어 변경 없음. (${(err as Error)?.message ?? ""})` });
  }
});

router.get("/admin/legacy-archive/full-sync/runs", ...adminGuard, async (req, res) => {
  try { res.json({ runs: await listFullSyncRuns(db) }); }
  catch (err) { req.log.error({ err }, "full-sync runs failed"); res.status(500).json({ error: "동기화 이력 조회 실패." }); }
});

router.post("/admin/legacy-archive/full-sync/runs/:runId/rollback", ...approverGuard, async (req, res) => {
  try {
    if (req.body?.confirm !== true) { res.status(400).json({ error: "되돌리기 확인(confirm=true)이 필요합니다." }); return; }
    const userId = (req as any).user?.id ?? null;
    res.json(await db.transaction(async (tx) => rollbackFullSync(tx, String(req.params.runId), userId)));
  } catch (err) {
    if (err instanceof SyncError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
    req.log.error({ err }, "full-sync rollback failed");
    res.status(500).json({ error: "통합 동기화 되돌리기 실패(변경 없음)." });
  }
});

export default router;
