// ─── 과거 CRM 자료 최신화(업로드 즉시 반영) API ────────────────────────────────────
//   GET  /admin/crm-refresh/status            5개 자료 현황(현재 건수·최근 업데이트·최근 처리 결과/오류)
//   POST /admin/crm-refresh/sales-progress    판매목록+진행관리표 전체 교체(multipart: salesFile, progressFile) — 관리자
//   POST /admin/crm-refresh/translators       통번역사 명부 최신화(multipart: file) — 관리자
//   POST /admin/crm-refresh/log               거래처·담당자 최신화 결과 기록(화면이 기존 대량등록 API로 반영한 뒤 호출)
// 건별 비교·승인 단계 없음. 안전장치·롤백·처리 로그는 services/crmRefresh.ts 참고.
import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { saveSnapshot, pruneExpired } from "../lib/importSnapshot";
import { applySalesProgress, applyTranslatorList, refreshStatus, writeRefreshLog, errorInfo } from "../services/crmRefresh";

const router: IRouter = Router();
const staffGuard = [requireAuth, requireRole("admin", "staff")];
const adminGuard = [requireAuth, requireRole("admin")];
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => { const n = (file.originalname || "").toLowerCase(); if (n.endsWith(".xls") || n.endsWith(".xlsx")) cb(null, true); else cb(new Error(".xls 또는 .xlsx 파일만 업로드할 수 있습니다.")); },
});
const decodeFileName = (raw?: string) => { if (!raw) return ""; try { return Buffer.from(raw, "latin1").toString("utf8"); } catch { return raw; } };
const uid = (req: any): number | null => req.user?.id ?? null;
// 같은 종류 동시 실행 방지(프로세스 내). 판매·진행은 DB advisory lock 도 함께 사용(엔진).
const running = new Set<string>();

router.get("/admin/crm-refresh/status", ...staffGuard, async (req, res) => {
  try { res.json(await refreshStatus(db)); }
  catch (err) { req.log.error({ err }, "crm-refresh status failed"); res.status(500).json({ error: "자료 현황 조회 실패" }); }
});

router.post("/admin/crm-refresh/sales-progress", ...adminGuard,
  upload.fields([{ name: "salesFile", maxCount: 1 }, { name: "progressFile", maxCount: 1 }]), async (req, res) => {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const sf = files.salesFile?.[0], pf = files.progressFile?.[0];
  const names = [decodeFileName(sf?.originalname), decodeFileName(pf?.originalname)];
  if (!sf?.buffer?.length || !pf?.buffer?.length) { res.status(400).json({ error: "판매목록과 진행관리표 파일이 모두 필요합니다(한쪽만 교체하지 않습니다).", code: "FILE_MISSING" }); return; }
  if (running.has("sales_progress")) { res.status(409).json({ error: "이미 교체 작업이 진행 중입니다. 완료 후 다시 시도하세요.", code: "SYNC_RUNNING" }); return; }
  running.add("sales_progress");
  try {
    const r = await applySalesProgress(db, { salesBuffer: sf.buffer, progressBuffer: pf.buffer, salesName: names[0], progressName: names[1], userId: uid(req) });
    await writeRefreshLog(db, { kind: "sales_progress", ok: true, fileNames: names, userId: uid(req), summary: r as any });
    res.json(r);
  } catch (err) {
    const e = errorInfo(err);
    if (e.status >= 500) req.log.error({ err }, "crm-refresh sales-progress failed");
    await writeRefreshLog(db, { kind: "sales_progress", ok: false, fileNames: names, userId: uid(req), summary: {}, error: e.message, code: e.code }).catch(() => {});
    res.status(e.status).json({ error: e.message, code: e.code, detail: e.detail });
  } finally { running.delete("sales_progress"); }
});

router.post("/admin/crm-refresh/translators", ...adminGuard, upload.single("file"), async (req, res) => {
  const name = decodeFileName(req.file?.originalname);
  if (!req.file?.buffer?.length) { res.status(400).json({ error: "통번역사 명부 파일이 필요합니다.", code: "FILE_MISSING" }); return; }
  if (running.has("translator")) { res.status(409).json({ error: "이미 통번역사 명부 최신화가 진행 중입니다.", code: "SYNC_RUNNING" }); return; }
  running.add("translator");
  try {
    pruneExpired();
    // 업로드 원본은 기존 통번역사 판정 경로와 같이 서버에 암호화 보관(주민번호 포함 → 평문 저장 금지)
    const snap = saveSnapshot("translator", req.file.buffer, { filename: name, sheetName: "", totalRows: 0, createdBy: uid(req) });
    const r = await applyTranslatorList(db, { buffer: req.file.buffer, fileName: name, userId: uid(req), snapshotId: snap.id });
    await writeRefreshLog(db, { kind: "translator", ok: true, fileNames: [name], userId: uid(req), summary: r as any });
    res.json(r);
  } catch (err) {
    const e = errorInfo(err);
    if (e.status >= 500) req.log.error({ err }, "crm-refresh translators failed");
    await writeRefreshLog(db, { kind: "translator", ok: false, fileNames: [name], userId: uid(req), summary: {}, error: e.message, code: e.code }).catch(() => {});
    res.status(e.status).json({ error: e.message, code: e.code });
  } finally { running.delete("translator"); }
});

// 거래처·담당자는 화면이 기존 대량등록 API(analyze → execute, mode=update)로 반영한다. 그 결과(집계값)만 기록.
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
router.post("/admin/crm-refresh/log", ...staffGuard, async (req, res) => {
  try {
    const kind = req.body?.kind === "company" ? "company" : req.body?.kind === "contact" ? "contact" : null;
    if (!kind) { res.status(400).json({ error: "kind 는 company | contact" }); return; }
    const s = req.body?.summary ?? {};
    // 집계값만 저장(행 데이터·연락처 원문 저장 안 함)
    const summary = { totalRows: num(s.totalRows), inserted: num(s.inserted), updated: num(s.updated), same: num(s.same), review: num(s.review), excluded: num(s.excluded), batchId: s.batchId != null ? num(s.batchId) : null };
    const ok = req.body?.ok === true;
    const error = ok ? null : String(req.body?.error ?? "").slice(0, 500) || "처리 실패";
    const fileName = String(req.body?.fileName ?? "").slice(0, 300);
    res.json({ id: await writeRefreshLog(db, { kind, ok, fileNames: [fileName], userId: uid(req), summary, error }) });
  } catch (err) { req.log.error({ err }, "crm-refresh log failed"); res.status(500).json({ error: "처리 로그 기록 실패" }); }
});

export default router;
