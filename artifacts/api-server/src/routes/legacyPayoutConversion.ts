// ─── 과거 CRM 미지급 수행건 → 운영 지급 전환 승인 API ─────────────────────────────────
//   GET  /admin/legacy-payout-conversions?status=requested     요청 목록(담당자·관리자)
//   GET  /admin/legacy-payout-conversions/check/:rowId         전환 가능 여부(읽기 전용)
//   POST /admin/legacy-payout-conversions                      전환 승인 요청 { progressRowId, note } (담당자·관리자)
//   POST /admin/legacy-payout-conversions/:id/approve          승인 { note } (관리자) — 운영 판매건 전환 + 미지급 확인. 지급확정·송금 아님
//   POST /admin/legacy-payout-conversions/:id/reject           반려 { note(필수) } (관리자)
// 요청·승인·반려 이력 = legacy_payout_conversions(요청자·결정자·일시·당시 금액·상태·사유). 승인은 감사로그(logs, 운영 판매건)에도 기록. 규칙·흐름은 services/legacyPayoutConversion.ts 참고.
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { approveConversion, checkEligibility, ConversionError, listConversions, rejectConversion, requestConversion } from "../services/legacyPayoutConversion";

const router: IRouter = Router();
const staffGuard = [requireAuth, requireRole("admin", "staff")];
const adminOnly = [requireAuth, requireRole("admin")];
const performer = (req: any) => (req.user ? { id: req.user.id, email: req.user.email } : undefined);
const uid = (req: any): number | null => req.user?.id ?? null;
const note = (v: unknown) => (String(v ?? "").trim().slice(0, 500) || null);
function fail(res: any, req: any, err: any, msg: string) {
  if (err instanceof ConversionError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  req.log.error({ err }, msg); res.status(500).json({ error: `${msg} (변경 없음)` });
}

router.get("/admin/legacy-payout-conversions", ...staffGuard, async (req, res) => {
  try {
    const s = String(req.query.status ?? "");
    res.json({ rows: await listConversions(db, ["requested", "approved", "rejected"].includes(s) ? s : null) });
  } catch (err) { fail(res, req, err, "전환 요청 목록 조회 실패"); }
});

router.get("/admin/legacy-payout-conversions/check/:rowId", ...staffGuard, async (req, res) => {
  try {
    const r = await checkEligibility(db, Number(req.params.rowId));
    res.json(r.ok ? { ok: true } : { ok: false, reason: r.reason });
  } catch (err) { fail(res, req, err, "전환 가능 여부 확인 실패"); }
});

router.post("/admin/legacy-payout-conversions", ...staffGuard, async (req, res) => {
  const rowId = Number(req.body?.progressRowId);
  if (!Number.isInteger(rowId) || rowId <= 0) { res.status(400).json({ error: "유효하지 않은 수행건입니다." }); return; }
  try {
    const c = await requestConversion(db, { progressRowId: rowId, note: note(req.body?.note), userId: uid(req) });
    // 요청 이력 = legacy_payout_conversions 행(요청자·일시·당시 금액·상태). 감사로그 entity 열거형에 없는 대상이라 서버 로그로 보조 기록.
    req.log.info({ conversionId: c.id, progressRowId: rowId, by: uid(req) }, "legacy payout conversion requested");
    res.status(201).json(c);
  } catch (err) { fail(res, req, err, "전환 승인 요청 실패"); }
});

router.post("/admin/legacy-payout-conversions/:id/approve", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const c = await approveConversion(db, { id, note: note(req.body?.note), userId: uid(req) });
    await logEvent("project", Number(c.projectId), "legacy_payout_conversion_approved", req.log, performer(req),
      JSON.stringify({ conversionId: id, progressRowId: c.progressRowId, saleNo: c.saleNo, projectId: c.projectId, assignmentId: c.assignmentId,
        amountPretax: c.amountPretax, amountPosttax: c.amountPosttax, legacyStatus: c.legacyStatus, after: "unpaid(지급확정 전)" }));
    res.json(c);
  } catch (err) { fail(res, req, err, "전환 승인 실패"); }
});

router.post("/admin/legacy-payout-conversions/:id/reject", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id); const n = note(req.body?.note);
  if (!n) { res.status(400).json({ error: "반려 사유를 입력하세요." }); return; }
  try {
    const c = await rejectConversion(db, { id, note: n, userId: uid(req) });
    req.log.info({ conversionId: id, progressRowId: c.progressRowId, by: uid(req) }, "legacy payout conversion rejected");   // 반려 이력 = 전환 테이블(결정자·일시·사유)
    res.json(c);
  } catch (err) { fail(res, req, err, "전환 반려 실패"); }
});

export default router;
