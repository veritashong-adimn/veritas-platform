// ─── 선입금 목록형 원장 API ─────────────────────────────────────────────────────────────
//  GET    /api/prepaid/overview?from=&to=              거래처별 선입금 현황(목록)
//  GET    /api/prepaid/companies/:companyId/ledger     거래처 상세 원장(확정 → 예정, 행별 잔액)
//  GET    /api/prepaid/ledger/:id                      원장 행 상세 + 수정 가능 범위
//  GET    /api/prepaid/ledger/:id/history              수정 이력
//  PATCH  /api/prepaid/ledger/:id                      원장 행 수정 { base, changes, reason?, confirmImpact?, dryRun? }
//  모든 조회는 Cache-Control: no-store — 저장 직후 재조회가 이전 값을 받지 않도록.
import { Router } from "express";
import { db } from "@workspace/db";
import { requireAuth, requireRole, requireStaffPermission } from "../middlewares/auth";
import { getCompanyOverview, getCompanyLedger, getLedgerEntryDetail, getLedgerHistory, editLedgerEntry, getLedgerLinkCandidates, getAccountDeleteCheck, deletePrepaidAccounts } from "../services/prepaidLedger";
import { logEvent } from "../lib/logEvent";

const router = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const noStore = (_req: any, res: any, next: any) => { res.set("Cache-Control", "no-store"); next(); };

router.get("/prepaid/overview", ...adminGuard, noStore, async (req, res) => {
  try {
    const { from, to } = req.query as { from?: string; to?: string };
    res.json(await getCompanyOverview(db, { from: from ?? null, to: to ?? null }));
  } catch (err) {
    req.log.error({ err }, "Failed to load prepaid overview");
    res.status(500).json({ error: "선입금 현황 조회 실패" });
  }
});

router.get("/prepaid/companies/:companyId/ledger", ...adminGuard, noStore, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 ID" }); return; }
  try {
    const r = await getCompanyLedger(db, companyId);
    if (!r) { res.status(404).json({ error: "이 거래처의 선입금 계정이 없습니다." }); return; }
    res.json(r);
  } catch (err) {
    req.log.error({ err }, "Failed to load company prepaid ledger");
    res.status(500).json({ error: "거래처 원장 조회 실패" });
  }
});

// 거래처 원장 삭제 전 확인 — 거래처명 · 선입금/차감 건수 · 연결 견적서 · 삭제 가능 여부(사유)
router.get("/prepaid/companies/:companyId/delete-check", ...adminGuard, noStore, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 ID" }); return; }
  try { const r = await getAccountDeleteCheck(db, companyId); if (!r) { res.status(404).json({ error: "이 거래처의 선입금 계정이 없습니다." }); return; } res.json(r); }
  catch (err) { req.log.error({ err }, "Failed to check prepaid account delete"); res.status(500).json({ error: "삭제 확인 실패" }); }
});
// 거래처 원장(선입금 계정) 삭제 — 금융거래가 없던 계정만. 거래처 마스터·견적서는 삭제하지 않음.
router.delete("/prepaid/companies/:companyId", ...adminGuard, requireStaffPermission("prepaid.manage"), async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 ID" }); return; }
  try {
    const r = await deletePrepaidAccounts(db, companyId);
    if (r.result === "not_found") { res.status(404).json({ error: "이 거래처의 선입금 계정이 없습니다." }); return; }
    if (r.result === "blocked") { res.status(409).json({ code: "HAS_TRANSACTIONS", error: r.check.reasons.join("\n"), check: r.check }); return; }
    await logEvent("company", companyId, "prepaid_account_deleted", req.log, (req as any).user ?? undefined,
      JSON.stringify({ accountIds: r.check.accountIds, companyName: r.check.companyName, quotes: r.check.quotes }));
    res.json({ ok: true, deletedAccountIds: r.check.accountIds });
  } catch (err) { req.log.error({ err }, "Failed to delete prepaid account"); res.status(500).json({ error: "선입금 원장 삭제 실패" }); }
});

router.get("/prepaid/ledger/:id", ...adminGuard, noStore, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 원장 ID" }); return; }
  try {
    const r = await getLedgerEntryDetail(db, id);
    if (!r) { res.status(404).json({ error: "원장 행을 찾을 수 없습니다." }); return; }
    res.json(r);
  } catch (err) {
    req.log.error({ err }, "Failed to load prepaid ledger entry");
    res.status(500).json({ error: "원장 상세 조회 실패" });
  }
});

router.get("/prepaid/ledger/:id/link-candidates", ...adminGuard, noStore, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 원장 ID" }); return; }
  try { const r = await getLedgerLinkCandidates(db, id); if (!r) { res.status(404).json({ error: "원장 행을 찾을 수 없습니다." }); return; } res.json(r); }
  catch (err) { req.log.error({ err }, "Failed to load ledger link candidates"); res.status(500).json({ error: "기존 입금 후보 조회 실패" }); }
});

router.get("/prepaid/ledger/:id/history", ...adminGuard, noStore, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 원장 ID" }); return; }
  try { res.json(await getLedgerHistory(db, id)); }
  catch (err) { req.log.error({ err }, "Failed to load prepaid ledger history"); res.status(500).json({ error: "수정 이력 조회 실패" }); }
});

router.patch("/prepaid/ledger/:id", ...adminGuard, requireStaffPermission("prepaid.manage"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "유효하지 않은 원장 ID" }); return; }
  const body = (req.body ?? {}) as { base?: any; changes?: any; reason?: string; confirmImpact?: boolean; dryRun?: boolean };
  if (!body.changes || typeof body.changes !== "object") { res.status(400).json({ error: "변경 내용(changes)이 없습니다." }); return; }
  const user = (req as any).user as { id: number; email: string; role: string } | undefined;
  try {
    const r: any = await editLedgerEntry(db, id, {
      base: body.base ?? null, changes: body.changes, reason: body.reason ?? null,
      confirmImpact: body.confirmImpact === true, dryRun: body.dryRun === true,
    }, { id: user?.id ?? null, email: user?.email ?? null });
    switch (r.result) {
      case "not_found": res.status(404).json({ error: "원장 행을 찾을 수 없습니다." }); return;
      case "invalid": res.status(r.code === "QUOTE_MANAGED" ? 409 : 400).json({ error: r.errors.join("\n"), code: r.code, errors: r.errors }); return;
      case "conflict": res.status(409).json({ error: "다른 사용자가 먼저 이 거래를 수정했습니다. 최신 값을 다시 불러왔습니다 — 확인 후 다시 저장하세요.", code: "CONFLICT", current: r.current }); return;
      case "confirm_required": res.status(409).json({ error: "이 수정은 다른 확정 거래나 판매확정 견적에 영향을 줍니다. 영향 범위를 확인하세요.", code: "IMPACT_CONFIRM_REQUIRED", impact: r.impact }); return;
      case "preview": res.json({ ok: true, preview: true, impact: r.impact }); return;
      case "unchanged": res.json({ ok: true, unchanged: true, entry: r.entry }); return;
      case "saved":
        // 감사 로그(보조) — 1차 기록은 prepaid_ledger_history. 견적/판매 연결 행만 해당 엔티티 로그에 남긴다.
        if (r.entry.quoteId != null || r.entry.projectId != null) await logEvent(r.entry.quoteId != null ? "quote" : "project", r.entry.quoteId ?? r.entry.projectId, "prepaid_ledger_updated", req.log, user ?? undefined, JSON.stringify({
          ledgerId: id, accountId: r.entry.accountId, before: r.impact.target.before, after: r.impact.target.after,
          balance: r.impact.balance, reason: body.reason?.trim() || null, cascade: r.impact.otherFinancialChanges.length,
        })).catch(() => {});
        res.json({ ok: true, entry: r.entry, impact: r.impact });
        return;
    }
    res.status(500).json({ error: "알 수 없는 처리 결과" });
  } catch (err: any) {
    if (err?.code === "23505" || err?.cause?.code === "23505") { res.status(409).json({ error: "같은 견적의 활성 차감이 이미 있거나 같은 입금이 이미 연결돼 있어 저장하지 않았습니다(중복 방지).", code: "DUPLICATE" }); return; }
    req.log.error({ err }, "Failed to edit prepaid ledger entry");
    res.status(500).json({ error: err?.message?.startsWith("잔액 재계산 불일치") ? err.message : "원장 수정 실패 — 저장되지 않았습니다." });
  }
});

export default router;
