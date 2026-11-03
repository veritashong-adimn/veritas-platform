// ─── 과거 CRM Excel 등록 — 분석 파일 저장·불러오기·삭제(보관) ──────────────────────────
// 원칙
//   · 분석 / 파일 저장 / 동기화는 서로 다른 작업. 이 라우트는 CRM 데이터(legacy_archive_rows·연결·동기화 배치)를 절대 변경하지 않는다.
//   · 원본 파일 = R2 비공개 객체(`legacy-crm/{자료유형}/{임의 UUID}`, 추측 불가 키). 공개 URL 미사용 — 권한 검증 후 서버로만 다운로드.
//   · 메타데이터 = 기존 테이블 재사용(스키마 변경 없음):
//       import_batches(module='legacy_crm_file') — 자료유형·원본 파일명·해시·등록자·등록일시·행 수·저장 상태
//       import_row_sources(status='file_meta')    — R2 키·파일 크기·분석일시·분석 요약(집계값만, 전체 행 데이터 미저장)
//       import_row_sources(status='file_audit')   — 저장·재분석·삭제·보관·다운로드 감사 기록
//     기존 동기화·스냅샷 코드는 module='legacy_archive' 만 조회하므로 영향 없음.
//   · 동기화 반영 여부는 저장하지 않고 조회 시 판정: 같은 해시·자료유형의 legacy_archive 배치(완료/되돌림) 존재 여부.
//   · 삭제: 미반영 파일만 실제 삭제(R2 객체 + 상태 deleted, 기록 보존). 동기화에 사용된 파일은 삭제하지 않고 '보관'으로 전환.
//
//   GET    /admin/legacy-archive/files?sourceType=      저장 파일 목록(최신순, 동기화 상태 포함)
//   POST   /admin/legacy-archive/files                  분석 파일 저장(multipart: file, sourceType, summary) — 해시 중복 감지
//   PATCH  /admin/legacy-archive/files/:id/analysis     재분석 결과 요약 갱신
//   GET    /admin/legacy-archive/files/:id/download     원본 다운로드(관리자)
//   DELETE /admin/legacy-archive/files/:id              삭제(미반영) 또는 보관(동기화 사용) — 관리자, confirm 필요
import { Router, type IRouter } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { db, importBatchesTable, importRowSourcesTable } from "@workspace/db";
import { sql, eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { ARCHIVE_SOURCE_TYPES, computeFileHash, type ArchiveSourceType } from "../services/legacyArchiveResolve";
import { isR2Configured, uploadToR2, getR2ObjectBuffer, deleteFromR2 } from "../lib/r2";

const router: IRouter = Router();
const staffGuard = [requireAuth, requireRole("admin", "staff")];
const adminGuard = [requireAuth, requireRole("admin")];
const MODULE = "legacy_crm_file";
const ST = { meta: "file_meta", audit: "file_audit" } as const;
type FileStatus = "saved" | "archived" | "deleted";

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => { const n = (file.originalname || "").toLowerCase(); if (n.endsWith(".xls") || n.endsWith(".xlsx")) cb(null, true); else cb(new Error(".xls 또는 .xlsx 파일만 저장할 수 있습니다.")); },
});
function decodeFileName(raw: string | undefined): string { if (!raw) return ""; try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; } }
const asType = (v: unknown): ArchiveSourceType | null => (ARCHIVE_SOURCE_TYPES as readonly string[]).includes(String(v)) ? (v as ArchiveSourceType) : null;
// 분석 요약 — 집계값만 허용(전체 행·원본 셀·주민번호 미저장). 64KB 초과 거부.
function cleanSummary(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === "") return null;
  let v: unknown = raw; if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return null; } }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = JSON.stringify(v); if (s.length > 64 * 1024) return null;
  return v as Record<string, unknown>;
}
async function audit(batchId: number, action: string, userId: number | null, extra: Record<string, unknown> = {}) {
  await db.insert(importRowSourcesTable).values({ batchId, module: MODULE, rowKey: `audit:${action}`, status: ST.audit, sourceSystem: "old_crm",
    sourceRaw: { action, userId, at: new Date().toISOString(), ...extra } });
}
async function loadFile(id: number) {
  const r = (await db.execute(sql`
    SELECT b.id, b.source_type, b.original_filename, b.file_hash, b.status, b.created_by, b.created_at, b.total_rows,
      m.id AS meta_id, m.source_raw AS meta
    FROM import_batches b LEFT JOIN import_row_sources m ON m.batch_id = b.id AND m.status = ${ST.meta}
    WHERE b.id = ${id} AND b.module = ${MODULE}`)).rows[0] as any;
  return r ?? null;
}
// 동기화 사용 여부 — 같은 원본(해시·유형)으로 만들어진 과거 CRM 반영 배치(완료 또는 되돌림 = 이력 보존 대상)
async function syncBatchesOf(fileHash: string, sourceType: string) {
  return (await db.execute(sql`SELECT id, status, created_at FROM import_batches WHERE module = 'legacy_archive' AND source_type = ${sourceType}
    AND file_hash = ${fileHash} AND status IN ('completed','rolled_back') ORDER BY id`)).rows as any[];
}

router.get("/admin/legacy-archive/files", ...staffGuard, async (req, res) => {
  try {
    const t = asType(req.query.sourceType);
    const includeDeleted = req.query.includeDeleted === "true";
    const rows = (await db.execute(sql`
      SELECT b.id, b.source_type, b.original_filename, b.file_hash, b.status, b.created_at, b.total_rows, u.name AS created_by_name, u.email AS created_by_email,
        m.source_raw AS meta,
        (SELECT coalesce(json_agg(json_build_object('id', sb.id, 'status', sb.status, 'createdAt', sb.created_at) ORDER BY sb.id), '[]'::json) FROM import_batches sb
          WHERE sb.module = 'legacy_archive' AND sb.source_type = b.source_type AND sb.file_hash = b.file_hash AND sb.status IN ('completed','rolled_back')) AS sync_batches
      FROM import_batches b LEFT JOIN import_row_sources m ON m.batch_id = b.id AND m.status = ${ST.meta}
      LEFT JOIN users u ON u.id = b.created_by
      WHERE b.module = ${MODULE} ${t ? sql`AND b.source_type = ${t}` : sql``} ${includeDeleted ? sql`` : sql`AND b.status <> 'deleted'`}
      ORDER BY b.created_at DESC, b.id DESC LIMIT 200`)).rows as any[];
    res.json({ r2: isR2Configured(), files: rows.map(r => {
      const m = r.meta ?? {}; const sb = (r.sync_batches ?? []) as any[];
      return { id: Number(r.id), sourceType: r.source_type, fileName: r.original_filename, fileHash: String(r.file_hash ?? "").slice(0, 12), status: r.status as FileStatus,
        createdAt: r.created_at, createdBy: r.created_by_name ?? r.created_by_email ?? null, totalRows: Number(r.total_rows ?? 0),
        size: m.size ?? null, analyzedAt: m.analyzedAt ?? null, summary: m.summary ?? null,
        syncStatus: sb.some(x => x.status === "completed") ? "synced" : sb.length ? "rolled_back" : "not_synced", syncBatchIds: sb.map(x => Number(x.id)) };
    }) });
  } catch (err) { req.log.error({ err }, "legacy crm files list failed"); res.status(500).json({ error: "저장 파일 목록 조회 실패" }); }
});

router.post("/admin/legacy-archive/files", ...staffGuard, upload.single("file"), async (req, res) => {
  try {
    const t = asType(req.body?.sourceType);
    if (!t) { res.status(400).json({ error: "자료 유형이 올바르지 않습니다." }); return; }
    if (!req.file?.buffer?.length) { res.status(400).json({ error: "저장할 엑셀 파일이 없습니다." }); return; }
    if (!isR2Configured()) { res.status(503).json({ error: "파일 저장소(R2)가 설정되지 않아 저장할 수 없습니다.", code: "R2_NOT_CONFIGURED" }); return; }
    const fileHash = computeFileHash(req.file.buffer);
    const dup = (await db.execute(sql`SELECT id, original_filename, status, created_at FROM import_batches WHERE module = ${MODULE} AND source_type = ${t}
      AND file_hash = ${fileHash} AND status <> 'deleted' ORDER BY id DESC LIMIT 1`)).rows[0] as any;
    if (dup) { res.status(409).json({ error: "같은 파일이 이미 저장되어 있습니다.", code: "DUPLICATE_FILE", existing: { id: Number(dup.id), fileName: dup.original_filename, status: dup.status, createdAt: dup.created_at } }); return; }
    const userId = (req as any).user?.id ?? null;
    const fileName = decodeFileName(req.file.originalname);
    const summary = cleanSummary(req.body?.summary);
    const totalRows = Number((summary as any)?.totalRows ?? 0) || 0;
    const analyzedAt = /^\d{4}-\d{2}-\d{2}T/.test(String(req.body?.analyzedAt ?? "")) ? String(req.body.analyzedAt) : (summary ? new Date().toISOString() : null);
    const ext = fileName.toLowerCase().endsWith(".xlsx") ? "xlsx" : "xls";
    const key = `legacy-crm/${t}/${crypto.randomUUID()}.${ext}`;   // 진행관리표는 주민번호 포함 → 해시 등 추측 가능한 키 금지
    await uploadToR2(key, req.file.buffer, req.file.mimetype || "application/vnd.ms-excel");
    const id = await db.transaction(async (tx) => {
      const [b] = await tx.insert(importBatchesTable).values({ module: MODULE, importType: "saved_file", originalFilename: fileName, totalRows, successRows: 0,
        status: "saved", createdBy: userId, sourceSystem: "old_crm", fileHash, sourceType: t, isCurrent: false }).returning({ id: importBatchesTable.id });
      await tx.insert(importRowSourcesTable).values({ batchId: b.id, module: MODULE, rowKey: "meta", status: ST.meta, sourceSystem: "old_crm", sourceFile: fileName,
        sourceRaw: { r2Key: key, size: req.file!.size, contentType: req.file!.mimetype ?? null, analyzedAt, summary } });
      return b.id as number;
    });
    await audit(id, "save", userId, { fileName, size: req.file.size });
    res.json({ id, fileName, fileHash: fileHash.slice(0, 12), status: "saved" });
  } catch (err) { req.log.error({ err }, "legacy crm file save failed"); res.status(500).json({ error: "분석 파일 저장 실패 — 저장되지 않았습니다." }); }
});

router.patch("/admin/legacy-archive/files/:id/analysis", ...staffGuard, async (req, res) => {
  try {
    const f = await loadFile(Number(req.params.id));
    if (!f || f.status === "deleted") { res.status(404).json({ error: "저장 파일을 찾을 수 없습니다." }); return; }
    const summary = cleanSummary(req.body?.summary);
    if (!summary) { res.status(400).json({ error: "분석 요약이 올바르지 않습니다." }); return; }
    const analyzedAt = new Date().toISOString();
    await db.execute(sql`UPDATE import_row_sources SET source_raw = source_raw || ${JSON.stringify({ summary, analyzedAt })}::jsonb WHERE id = ${f.meta_id}`);
    const totalRows = Number((summary as any).totalRows ?? 0) || 0;
    if (totalRows) await db.update(importBatchesTable).set({ totalRows }).where(eq(importBatchesTable.id, f.id));
    await audit(f.id, "reanalyze", (req as any).user?.id ?? null);
    res.json({ id: Number(f.id), analyzedAt });
  } catch (err) { req.log.error({ err }, "legacy crm file reanalyze failed"); res.status(500).json({ error: "재분석 결과 저장 실패" }); }
});

router.get("/admin/legacy-archive/files/:id/download", ...adminGuard, async (req, res) => {
  try {
    const f = await loadFile(Number(req.params.id));
    if (!f || f.status === "deleted" || !f.meta?.r2Key) { res.status(404).json({ error: "원본 파일을 찾을 수 없습니다." }); return; }
    const { body } = await getR2ObjectBuffer(String(f.meta.r2Key));
    await audit(Number(f.id), "download", (req as any).user?.id ?? null);
    const name = encodeURIComponent(f.original_filename || `crm-${f.id}.xls`);
    res.setHeader("Content-Type", f.meta.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${name}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(body);
  } catch (err) { req.log.error({ err }, "legacy crm file download failed"); res.status(500).json({ error: "원본 다운로드 실패" }); }
});

router.delete("/admin/legacy-archive/files/:id", ...adminGuard, async (req, res) => {
  try {
    if (req.query.confirm !== "true" && req.body?.confirm !== true) { res.status(400).json({ error: "삭제 확인(confirm)이 필요합니다." }); return; }
    const f = await loadFile(Number(req.params.id));
    if (!f || f.status === "deleted") { res.status(404).json({ error: "저장 파일을 찾을 수 없습니다." }); return; }
    const userId = (req as any).user?.id ?? null;
    const used = await syncBatchesOf(String(f.file_hash), String(f.source_type));
    if (used.length) {
      // 동기화 이력·되돌리기 근거 보존 — 원본 삭제 금지, 보관으로 전환
      await db.update(importBatchesTable).set({ status: "archived" }).where(and(eq(importBatchesTable.id, f.id), eq(importBatchesTable.module, MODULE)));
      await audit(Number(f.id), "archive", userId, { syncBatchIds: used.map(u => Number(u.id)) });
      res.json({ id: Number(f.id), result: "archived", syncBatchIds: used.map(u => Number(u.id)), message: "동기화에 사용된 파일이라 삭제하지 않고 보관 상태로 전환했습니다." });
      return;
    }
    if (f.meta?.r2Key) await deleteFromR2(String(f.meta.r2Key));
    await db.update(importBatchesTable).set({ status: "deleted" }).where(and(eq(importBatchesTable.id, f.id), eq(importBatchesTable.module, MODULE)));
    await audit(Number(f.id), "delete", userId, { fileName: f.original_filename });
    res.json({ id: Number(f.id), result: "deleted" });
  } catch (err) { req.log.error({ err }, "legacy crm file delete failed"); res.status(500).json({ error: "저장 파일 삭제 실패" }); }
});

export default router;
