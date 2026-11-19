// ─── 해외 외주업체 실제 송금내역(2026-11) ─────────────────────────────────────
//  · 수행행 1:N 송금기록(performance_remittances). 계약금액(performance_assignments)은 변경하지 않는다.
//  · 원화 환산액 = 외화 송금액 × 적용환율(서버 계산, 원 단위). 은행 수수료는 별도.
//  · 수행정보·지급회차 화면이 같은 API 를 사용(조회 공용, 저장은 여기 한 곳).
import { Router, type IRouter } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  db, performanceAssignmentsTable, performanceRemittancesTable, REMITTANCE_STATUSES, calcRemitKrw, summarizeRemittances,
} from "@workspace/db";
import { requireAuth, requireRole, requireRolePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const editGuard = [...adminGuard, requireRolePermission("project.update")];

const bodySchema = z.object({
  remitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  foreignAmount: z.coerce.number().positive().finite(),
  fxRate: z.coerce.number().positive().finite().nullable().optional(),
  bankFee: z.coerce.number().min(0).finite().optional(),
  status: z.enum(REMITTANCE_STATUSES).optional(),
  memo: z.string().max(500).nullable().optional(),
});

async function loadAssignment(id: number) {
  const [a] = await db.select({
    id: performanceAssignmentsTable.id, projectId: performanceAssignmentsTable.projectId,
    performerCategory: performanceAssignmentsTable.performerCategory, vendorSettlementType: performanceAssignmentsTable.vendorSettlementType,
    contractCurrency: performanceAssignmentsTable.contractCurrency, contractAmountForeign: performanceAssignmentsTable.contractAmountForeign,
    performerName: performanceAssignmentsTable.performerNameSnapshot, productName: performanceAssignmentsTable.productNameSnapshot,
    deletedAt: performanceAssignmentsTable.deletedAt,
  }).from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, id));
  return a;
}
const isOverseas = (a: any) => a && a.deletedAt == null && a.performerCategory === "vendor" && a.vendorSettlementType === "overseas";

async function detail(id: number) {
  const a = await loadAssignment(id);
  if (!a) return null;
  const records = await db.select().from(performanceRemittancesTable)
    .where(and(eq(performanceRemittancesTable.assignmentId, id), isNull(performanceRemittancesTable.deletedAt)))
    .orderBy(asc(performanceRemittancesTable.remitDate), asc(performanceRemittancesTable.id));
  const { deletedAt: _d, ...assignment } = a; void _d;
  return { assignment, records, summary: summarizeRemittances(a.contractCurrency, a.contractAmountForeign, records) };
}

// 조회 — 수행정보·지급회차 공용
router.get("/admin/performances/:id/remittances", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "잘못된 수행정보 ID" }); return; }
  const d = await detail(id);
  if (!d) { res.status(404).json({ error: "수행정보를 찾을 수 없습니다." }); return; }
  res.json(d);
});

// 등록 — 해외 외주(정산유형 overseas) 행만
router.post("/admin/performances/:id/remittances", ...editGuard, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const a = await loadAssignment(id);
  if (!isOverseas(a)) { res.status(400).json({ error: "해외송금 정산유형의 외주업체 수행정보만 송금내역을 등록할 수 있습니다. 먼저 수행정보를 저장해 주세요." }); return; }
  const b = parsed.data;
  const currency = (b.currency ?? a.contractCurrency ?? "USD").toUpperCase();
  const [rec] = await db.insert(performanceRemittancesTable).values({
    assignmentId: id, remitDate: b.remitDate ?? null, currency,
    foreignAmount: String(b.foreignAmount), fxRate: b.fxRate != null ? String(b.fxRate) : null,
    krwAmount: (() => { const k = calcRemitKrw(b.foreignAmount, b.fxRate); return k != null ? String(k) : null; })(),
    bankFee: String(b.bankFee ?? 0), status: b.status ?? "completed", memo: b.memo ?? null,
    createdBy: req.user?.id ?? null, updatedBy: req.user?.id ?? null,
  }).returning();
  await logEvent("project", a.projectId, "performance_remittance_created", req.log, req.user ? { id: req.user.id, email: req.user.email } : undefined,
    JSON.stringify({ assignmentId: id, remittanceId: rec.id, currency, foreignAmount: b.foreignAmount, status: rec.status }));
  res.status(201).json(await detail(id));
});

// 수정
router.patch("/admin/performance-remittances/:rid", ...editGuard, async (req, res) => {
  const rid = Number(req.params.rid);
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const [prev] = await db.select().from(performanceRemittancesTable).where(and(eq(performanceRemittancesTable.id, rid), isNull(performanceRemittancesTable.deletedAt)));
  if (!prev) { res.status(404).json({ error: "송금내역을 찾을 수 없습니다." }); return; }
  const a = await loadAssignment(prev.assignmentId);
  const b = parsed.data;
  await db.update(performanceRemittancesTable).set({
    remitDate: b.remitDate ?? null, currency: (b.currency ?? prev.currency).toUpperCase(),
    foreignAmount: String(b.foreignAmount), fxRate: b.fxRate != null ? String(b.fxRate) : null,
    krwAmount: (() => { const k = calcRemitKrw(b.foreignAmount, b.fxRate); return k != null ? String(k) : null; })(),
    bankFee: String(b.bankFee ?? 0), status: b.status ?? prev.status, memo: b.memo ?? null,
    updatedBy: req.user?.id ?? null, updatedAt: new Date(),
  }).where(eq(performanceRemittancesTable.id, rid));
  await logEvent("project", a?.projectId ?? 0, "performance_remittance_updated", req.log, req.user ? { id: req.user.id, email: req.user.email } : undefined,
    JSON.stringify({ assignmentId: prev.assignmentId, remittanceId: rid, before: { foreignAmount: prev.foreignAmount, fxRate: prev.fxRate, status: prev.status }, after: b }));
  res.json(await detail(prev.assignmentId));
});

// 삭제(soft) — 금융 이력 보존
router.delete("/admin/performance-remittances/:rid", ...editGuard, async (req, res) => {
  const rid = Number(req.params.rid);
  const [prev] = await db.select().from(performanceRemittancesTable).where(and(eq(performanceRemittancesTable.id, rid), isNull(performanceRemittancesTable.deletedAt)));
  if (!prev) { res.status(404).json({ error: "송금내역을 찾을 수 없습니다." }); return; }
  await db.update(performanceRemittancesTable).set({ deletedAt: new Date(), deletedBy: req.user?.id ?? null })
    .where(eq(performanceRemittancesTable.id, rid));
  const a = await loadAssignment(prev.assignmentId);
  await logEvent("project", a?.projectId ?? 0, "performance_remittance_deleted", req.log, req.user ? { id: req.user.id, email: req.user.email } : undefined,
    JSON.stringify({ assignmentId: prev.assignmentId, remittanceId: rid, foreignAmount: prev.foreignAmount, currency: prev.currency }));
  res.json(await detail(prev.assignmentId));
});

export default router;
