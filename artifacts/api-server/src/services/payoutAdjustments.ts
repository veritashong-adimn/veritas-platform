// ─────────────────────────────────────────────────────────────────────────────
// 지급 정정·관리자 승인·차액 정산 서비스(2026-11 승인) — payout_adjustments.
//  · 계산은 기존 저장 경로(applyPerformanceRow)와 기존 세금 계산(calcPayoutWithholding)을 그대로 재사용한다.
//    요청 시 미리보기는 같은 저장 경로를 트랜잭션 안에서 실행한 뒤 롤백해 얻는다(계산 로직 중복 없음).
//  · 실제 지급기록(payout_round_items 일반 항목·payout_transfers·performance_remittances)은 읽기만 한다.
//  · 감사로그: 기존 logs(판매건=project 단위) + metadata 첫 키 adjustmentId.
// ─────────────────────────────────────────────────────────────────────────────
import {
  db, payoutAdjustmentsTable, payoutRoundItemsTable, payoutRoundsTable, performanceAssignmentsTable, performanceRemittancesTable,
  calcPayoutWithholding, summarizeRemittances,
} from "@workspace/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";
import {
  applyPerformanceRow, approvalStageOf, approvalRequiredFor, loadKrHolidaySet,
  type ApplyRowCtx, type RowInput, type ApprovalStage,
} from "../routes/performances";
import { refreezeAssignmentSnapshot, refreshRoundTotals, roundPayeeNet } from "../routes/payoutRounds";
import { resyncTransfersIfAny } from "./payoutTransfers";

type Assign = typeof performanceAssignmentsTable.$inferSelect;
type Adj = typeof payoutAdjustmentsTable.$inferSelect;
export type Actor = { id: number; email: string; role?: string | null; roleId?: number | null } | undefined;

const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
export class AdjError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// 지급대상 키(payout_transfers.payeeKey 와 동일 규칙)
const payeeOf = (a: Assign) => a.performerCategory === "individual"
  ? { payeeType: "individual", payeeId: a.individualUserId, key: `i:${a.individualUserId ?? "none"}` }
  : { payeeType: "vendor", payeeId: a.vendorCompanyId, key: `v:${a.vendorCompanyId ?? "none"}` };
const isForeign = (a: Assign) => a.performerCategory === "vendor" && a.vendorSettlementType === "overseas" && String(a.contractCurrency ?? "USD").toUpperCase() !== "KRW";

// 원화 세금·실지급 계산 — 지급회차 집계(aggregate)와 동일 규칙(개인 원천징수 / 외주 세금계산서 VAT, 국내 정산유형은 원 단위 VAT).
export function krwTaxOf(a: Pick<Assign, "costTotal" | "performerCategory" | "withholdingTreatment" | "withholdingRate" | "purchaseEvidenceType" | "vendorSettlementType">) {
  const indiv = a.performerCategory === "individual";
  const t = calcPayoutWithholding(num(a.costTotal), indiv ? "individual" : "vendor", a.withholdingTreatment, a.withholdingRate != null ? num(a.withholdingRate) : null, a.purchaseEvidenceType);
  const vat = a.vendorSettlementType === "domestic" && t.vat ? Math.round(t.gross * 0.1) : t.vat;
  return { gross: t.gross, rate: t.rate, withholding: t.deduction, vat, net: r2(t.gross - t.deduction + vat),
    withholdingTreatment: a.withholdingTreatment ?? null, purchaseEvidenceType: a.purchaseEvidenceType ?? null };
}

// 기준값(before) — 단계별로 '이미 확정·지급된 금액'.
//   confirmed : 이 회차의 확정 스냅샷(없으면 현재 행 계산값)
//   paid      : 지급 당시 확정 스냅샷(회차 외 지급은 현재 행 계산값) + 이미 승인된 이전 정정 차액 누계(중복 정산 방지)
//   overseas  : 외화 계약금액·누적 송금액(계약통화 · 송금완료 건)
async function basisOf(dbx: any, a: Assign, stage: ApprovalStage, excludeAdjId?: number) {
  if (stage === "overseas_remitted" || (stage === "paid" && isForeign(a))) {
    const recs = await dbx.select().from(performanceRemittancesTable).where(and(eq(performanceRemittancesTable.assignmentId, a.id), isNull(performanceRemittancesTable.deletedAt)));
    const s = summarizeRemittances(a.contractCurrency, a.contractAmountForeign, recs);
    return { kind: "foreign" as const, currency: s.contractCurrency ?? "USD", contractAmount: s.contractAmount, remitted: s.remittedAmount, remaining: s.remainingAmount, source: "remittances" };
  }
  let base: any = null;
  if (a.payoutRoundId != null) {
    const [snap] = await dbx.select().from(payoutRoundItemsTable).where(and(
      eq(payoutRoundItemsTable.payoutRoundId, a.payoutRoundId), eq(payoutRoundItemsTable.performanceAssignmentId, a.id), isNull(payoutRoundItemsTable.adjustmentId)));
    if (snap) base = { gross: num(snap.grossAmount), rate: snap.withholdingRate != null ? num(snap.withholdingRate) : 0, withholding: num(snap.withholdingAmount), vat: num(snap.vatAmount), net: num(snap.netAmount),
      withholdingTreatment: snap.withholdingTreatment, purchaseEvidenceType: snap.purchaseEvidenceType, source: `payout_round:${a.payoutRoundId}` };
  }
  if (!base) base = { ...krwTaxOf(a), source: "performance_row" };
  const out: any = { kind: "krw" as const, currency: "KRW", ...base, priorAdjustments: [] as number[] };
  if (stage === "paid") {
    const prev = await dbx.select().from(payoutAdjustmentsTable).where(and(
      eq(payoutAdjustmentsTable.assignmentId, a.id), eq(payoutAdjustmentsTable.kind, "paid_correction"), eq(payoutAdjustmentsTable.status, "approved"), eq(payoutAdjustmentsTable.currency, "KRW"),
      ...(excludeAdjId ? [ne(payoutAdjustmentsTable.id, excludeAdjId)] : [])));
    for (const p of prev) {
      out.gross = r2(out.gross + num(p.deltaGross)); out.withholding = r2(out.withholding + num(p.deltaWithholding));
      out.vat = r2(out.vat + num(p.deltaVat)); out.net = r2(out.net + num(p.deltaNet)); out.priorAdjustments.push(p.id);
    }
  }
  return out;
}
function afterOf(a: Assign, foreign: boolean) {
  if (foreign) return { kind: "foreign" as const, currency: String(a.contractCurrency ?? "USD").toUpperCase(), contractAmount: a.contractAmountForeign != null ? num(a.contractAmountForeign) : null };
  return { kind: "krw" as const, currency: "KRW", ...krwTaxOf(a) };
}
function deltasOf(before: any, after: any, a: Assign, kind: string) {
  if (before.kind === "foreign") {
    const need = r2(num(after.contractAmount) - num(before.remitted));     // + 추가송금 필요 / − 초과송금
    return { deltaGross: 0, deltaWithholding: 0, deltaVat: 0, deltaNet: 0, deltaForeign: need, currency: before.currency,
      taxCorrectionNeeded: false, invoiceCorrectionNeeded: false };
  }
  const d = { deltaGross: r2(after.gross - before.gross), deltaWithholding: r2(after.withholding - before.withholding), deltaVat: r2(after.vat - before.vat), deltaNet: r2(after.net - before.net) };
  const indiv = a.performerCategory === "individual";
  const evid = after.purchaseEvidenceType ?? before.purchaseEvidenceType;
  return { ...d, deltaForeign: null, currency: "KRW",
    // 원천세 신고·지급명세서 정정 필요 — 이미 지급(신고 대상)된 개인 건의 원천세가 달라지는 경우
    taxCorrectionNeeded: indiv && kind === "paid_correction" && (Math.abs(d.deltaWithholding) >= 0.005 || (before.withholdingTreatment ?? null) !== (after.withholdingTreatment ?? null)),
    // 수정세금계산서 필요 — 국내 외주의 공급가액·부가세가 달라지고 이미 지급했거나 매입 세금계산서 일자가 기록된 경우(자동 변경하지 않음)
    invoiceCorrectionNeeded: !indiv && (kind === "paid_correction" || a.purchaseInvoiceDate != null)
      && ["tax_invoice", "invoice", "zero_rate_tax_invoice"].includes(String(evid ?? "")) && (Math.abs(d.deltaGross) >= 0.005 || Math.abs(d.deltaVat) >= 0.005) };
}

// 승인된 변경을 기존 저장 경로로 적용 — 지급상태·회차·실지급·지급예정일·납품확인 필드는 원래 값으로 복원(정정은 원가·금액만).
async function applyPatch(tx: any, a: Assign, patch: RowInput, userId: number | null, reason: string) {
  const holidaySet = await loadKrHolidaySet();
  const priorRows = await tx.select().from(performanceAssignmentsTable).where(and(eq(performanceAssignmentsTable.projectId, a.projectId), isNull(performanceAssignmentsTable.deletedAt)));
  const ctx: ApplyRowCtx = { userId, isHoliday: (d: string) => holidaySet.has(d), mayConfirm: false, priorById: new Map(priorRows.map((p: Assign) => [p.id, p])), changeReason: reason, approvedAdjustment: true };
  await applyPerformanceRow(tx, a.projectId, { ...patch, id: a.id }, ctx);
  await tx.update(performanceAssignmentsTable).set({
    paymentStatus: a.paymentStatus, payoutRoundId: a.payoutRoundId, actualPaymentDate: a.actualPaymentDate, actualPaymentAmount: a.actualPaymentAmount,
    payStatementId: a.payStatementId, payoutHoldReason: a.payoutHoldReason, expectedPaymentDate: a.expectedPaymentDate, expectedPaymentDateAuto: a.expectedPaymentDateAuto,
    payDateManual: a.payDateManual, status: a.status, deliveryConfirmed: a.deliveryConfirmed, deliveryConfirmedBy: a.deliveryConfirmedBy, deliveryConfirmedAt: a.deliveryConfirmedAt,
  }).where(eq(performanceAssignmentsTable.id, a.id));
  const [after] = await tx.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, a.id));
  return after as Assign;
}

const ROLLBACK = Symbol("rollback");
async function audit(a: { projectId: number }, action: string, actor: Actor, log: any, meta: Record<string, unknown>) {
  await logEvent("project", a.projectId, action, log, actor ? { id: actor.id, email: actor.email } : undefined, JSON.stringify(meta));
}
const kindOfStage = (s: ApprovalStage) => (s === "confirmed" ? "confirmed_change" : "paid_correction");

// ── 요청 계산(미리보기·생성 공용) ──────────────────────────────────────────────
async function computeRequest(projectId: number, patch: RowInput, reason: string, actor: Actor) {
  if (!patch.id) throw new AdjError(400, "정정 대상 수행정보 ID가 없습니다.");
  const [a] = await db.select().from(performanceAssignmentsTable).where(and(eq(performanceAssignmentsTable.id, patch.id), eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));
  if (!a) throw new AdjError(404, "수행정보를 찾을 수 없습니다(삭제되었거나 다른 판매건).");
  const stage = await approvalRequiredFor(db, a, patch);
  if (!stage) throw new AdjError(400, `수행정보(id ${a.id})는 승인 없이 수정할 수 있거나 지급 관련 변경이 없습니다. 금액을 바꾼 뒤 다시 확인해 주세요.`);
  const kind = kindOfStage(stage);
  const foreign = stage === "overseas_remitted" || (stage === "paid" && isForeign(a));
  // 미리보기 — 같은 저장 경로를 트랜잭션에서 실행 후 롤백(원본 불변).
  let preview: Assign | null = null;
  try {
    await db.transaction(async (tx) => { preview = await applyPatch(tx, a, patch, actor?.id ?? null, reason || "미리보기"); throw ROLLBACK; });
  } catch (e) { if (e !== ROLLBACK) throw new AdjError(400, (e as Error).message); }
  const before = await basisOf(db, a, stage);
  const after = afterOf(preview!, foreign);
  const d = deltasOf(before, after, preview!, kind);
  // 승인 시 예상 정산 방식(미리보기 표시용) — 실제 값은 승인 시점에 다시 계산한다.
  const expectedSettlement = kind === "confirmed_change" ? "confirmed_update"
    : foreign ? (d.deltaForeign! > 0.004 ? "additional_remittance" : d.deltaForeign! < -0.004 ? "foreign_refund" : "none")
    : (d.deltaNet > 0.004 ? "additional_payment" : d.deltaNet < -0.004 ? "offset" : "none");
  return { a, stage, kind, before, after, d, expectedSettlement, payeeType: a.performerCategory === "individual" ? "individual" : "vendor" };
}
export async function previewAdjustmentRequest(projectId: number, patch: RowInput, actor: Actor) {
  const c = await computeRequest(projectId, patch, "", actor);
  return { assignmentId: c.a.id, stage: c.stage, kind: c.kind, payeeType: c.payeeType, before: c.before, after: c.after, ...c.d, expectedSettlement: c.expectedSettlement };
}

// ── 요청 생성 ────────────────────────────────────────────────────────────────
export async function createAdjustmentRequest(projectId: number, patch: RowInput, reason: string, actor: Actor, log: any) {
  if (!reason.trim()) throw new AdjError(400, "수정·정정 사유를 입력해 주세요.");
  const { a, stage, kind, before, after, d } = await computeRequest(projectId, patch, reason, actor);
  const p = payeeOf(a);
  try {
    const [row] = await db.insert(payoutAdjustmentsTable).values({
      assignmentId: a.id, projectId, kind, sourceRoundId: a.payoutRoundId,
      payeeType: p.payeeType, payeeId: p.payeeId, payeeName: a.performerNameSnapshot,
      currency: d.currency, requestedPatch: { ...patch, id: a.id }, beforeValues: before, afterValues: after,
      deltaGross: String(d.deltaGross), deltaWithholding: String(d.deltaWithholding), deltaVat: String(d.deltaVat), deltaNet: String(d.deltaNet),
      deltaForeign: d.deltaForeign != null ? String(d.deltaForeign) : null,
      taxCorrectionNeeded: d.taxCorrectionNeeded, invoiceCorrectionNeeded: d.invoiceCorrectionNeeded,
      reason: reason.trim(), status: "requested", requestedBy: actor?.id ?? null,
    }).returning();
    await audit(row, "payout_adjustment_requested", actor, log, { adjustmentId: row.id, assignmentId: a.id, kind, stage, reason: row.reason, before, after, ...d });
    return row;
  } catch (e: any) {
    if (e?.code === "23505" || e?.cause?.code === "23505") throw new AdjError(409, `수행정보(id ${a.id})에 이미 승인 대기 중인 요청이 있습니다. 기존 요청을 처리하거나 취소한 뒤 다시 요청해 주세요.`);
    throw e;
  }
}

async function loadAdj(id: number) {
  const [adj] = await db.select().from(payoutAdjustmentsTable).where(eq(payoutAdjustmentsTable.id, id));
  if (!adj) throw new AdjError(404, "정정 요청을 찾을 수 없습니다.");
  return adj;
}

// ── 승인 ────────────────────────────────────────────────────────────────────
export async function approveAdjustment(id: number, note: string | null, actor: Actor, log: any) {
  const adj = await loadAdj(id);
  if (adj.status !== "requested") throw new AdjError(409, "승인 대기 상태의 요청만 승인할 수 있습니다.");
  if (actor?.id != null && adj.requestedBy === actor.id) throw new AdjError(403, "요청자 본인은 승인할 수 없습니다. 다른 관리자가 승인해야 합니다.");
  let result: { adj: Adj; snapshot?: any; roundId?: number | null } | null = null;
  await db.transaction(async (tx) => {
    const [a] = await tx.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, adj.assignmentId)).for("update");
    if (!a || a.deletedAt) throw new AdjError(409, "정정 대상 수행정보가 삭제되었습니다. 요청을 취소해 주세요.");
    const stage = await approvalStageOf(tx, a);
    if (!stage || kindOfStage(stage) !== adj.kind) throw new AdjError(409, `요청 이후 지급 단계가 바뀌었습니다(현재: ${stage ?? "승인 불필요"}). 요청을 취소하고 현재 단계에 맞게 다시 처리해 주세요.`);
    const foreign = stage === "overseas_remitted" || (stage === "paid" && isForeign(a));
    const before = await basisOf(tx, a, stage, adj.id);
    const after0 = await applyPatch(tx, a, adj.requestedPatch as RowInput, actor?.id ?? null, adj.reason);
    let snapshot: any;
    if (adj.kind === "confirmed_change") snapshot = await refreezeAssignmentSnapshot(tx, a.payoutRoundId!, a.id);
    const after = afterOf(after0, foreign);
    const d = deltasOf(before, after, after0, adj.kind);
    let settlementType: string | null = null, settlementStatus: string | null = null;
    if (adj.kind === "paid_correction") {
      if (foreign) settlementType = d.deltaForeign! > 0.004 ? "additional_remittance" : d.deltaForeign! < -0.004 ? "foreign_refund" : "none";
      else settlementType = d.deltaNet > 0.004 ? "additional_payment" : d.deltaNet < -0.004 ? "offset" : "none";
      settlementStatus = settlementType === "none" ? "settled" : "open";
    }
    const now = new Date();
    const [upd] = await tx.update(payoutAdjustmentsTable).set({
      status: "approved", decidedBy: actor?.id ?? null, decidedAt: now, decisionNote: note,
      beforeValues: before, afterValues: after, currency: d.currency,
      deltaGross: String(d.deltaGross), deltaWithholding: String(d.deltaWithholding), deltaVat: String(d.deltaVat), deltaNet: String(d.deltaNet),
      deltaForeign: d.deltaForeign != null ? String(d.deltaForeign) : null,
      taxCorrectionNeeded: d.taxCorrectionNeeded, invoiceCorrectionNeeded: d.invoiceCorrectionNeeded,
      settlementType, settlementStatus, ...(settlementStatus === "settled" ? { settledAt: now, settledBy: actor?.id ?? null, settlementNote: "차액 없음" } : {}),
      updatedAt: now,
    }).where(and(eq(payoutAdjustmentsTable.id, adj.id), eq(payoutAdjustmentsTable.status, "requested"))).returning();
    if (!upd) throw new AdjError(409, "다른 사용자가 먼저 처리한 요청입니다.");
    result = { adj: upd, snapshot, roundId: a.payoutRoundId };
  });
  const r = result!;
  let transferResync: any = null;
  if (r.adj.kind === "confirmed_change" && r.roundId != null) {
    await refreshRoundTotals(r.roundId);
    const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, r.roundId));
    try { if (round) transferResync = await resyncTransfersIfAny(round, log); } catch (e) { log?.error?.({ e }, "정정 승인 후 송금건 재동기화 실패(승인은 정상)"); }
  }
  await audit(r.adj, "payout_adjustment_approved", actor, log, { adjustmentId: r.adj.id, assignmentId: r.adj.assignmentId, kind: r.adj.kind, note,
    before: r.adj.beforeValues, after: r.adj.afterValues, deltaNet: num(r.adj.deltaNet), deltaForeign: r.adj.deltaForeign, settlementType: r.adj.settlementType,
    ...(r.snapshot ? { roundSnapshot: { roundId: r.roundId, beforeNet: r.snapshot.before ? num(r.snapshot.before.netAmount) : null, afterNet: r.snapshot.after ? num(r.snapshot.after.netAmount) : null } } : {}),
    ...(transferResync?.staleLocked ? { transferStaleLocked: transferResync.staleLocked } : {}) });
  return { adjustment: r.adj, transferResync };
}

// ── 반려 / 취소 ──────────────────────────────────────────────────────────────
export async function rejectAdjustment(id: number, note: string | null, actor: Actor, log: any) {
  const adj = await loadAdj(id);
  if (adj.status !== "requested") throw new AdjError(409, "승인 대기 상태의 요청만 반려할 수 있습니다.");
  if (actor?.id != null && adj.requestedBy === actor.id) throw new AdjError(403, "요청자 본인은 반려할 수 없습니다(취소를 이용하세요).");
  if (!note?.trim()) throw new AdjError(400, "반려 사유를 입력해 주세요.");
  const [upd] = await db.update(payoutAdjustmentsTable).set({ status: "rejected", decidedBy: actor?.id ?? null, decidedAt: new Date(), decisionNote: note.trim(), updatedAt: new Date() })
    .where(and(eq(payoutAdjustmentsTable.id, id), eq(payoutAdjustmentsTable.status, "requested"))).returning();
  if (!upd) throw new AdjError(409, "다른 사용자가 먼저 처리한 요청입니다.");
  await audit(upd, "payout_adjustment_rejected", actor, log, { adjustmentId: id, assignmentId: upd.assignmentId, note: note.trim() });
  return upd;
}
export async function cancelAdjustment(id: number, note: string | null, actor: Actor, canManage: boolean, log: any) {
  const adj = await loadAdj(id);
  if (adj.status !== "requested") throw new AdjError(409, "승인 대기 상태의 요청만 취소할 수 있습니다.");
  if (!canManage && adj.requestedBy !== actor?.id) throw new AdjError(403, "요청자 또는 승인권자만 취소할 수 있습니다.");
  const [upd] = await db.update(payoutAdjustmentsTable).set({ status: "cancelled", decidedBy: actor?.id ?? null, decidedAt: new Date(), decisionNote: note?.trim() || null, updatedAt: new Date() })
    .where(and(eq(payoutAdjustmentsTable.id, id), eq(payoutAdjustmentsTable.status, "requested"))).returning();
  if (!upd) throw new AdjError(409, "다른 사용자가 먼저 처리한 요청입니다.");
  await audit(upd, "payout_adjustment_cancelled", actor, log, { adjustmentId: id, assignmentId: upd.assignmentId, note: note?.trim() || null });
  return upd;
}

// ── 차액 정산 방식 변경(과다지급: 상계 ↔ 환수 / 해외: 환수 ↔ 상계) ───────────────────────
export async function setSettlementType(id: number, type: string, actor: Actor, log: any) {
  const adj = await loadAdj(id);
  if (adj.status !== "approved" || adj.kind !== "paid_correction") throw new AdjError(409, "승인된 지급완료 정정 건만 정산 방식을 정할 수 있습니다.");
  if (adj.settlementStatus !== "open") throw new AdjError(409, "정산 대기(미편입) 상태에서만 정산 방식을 바꿀 수 있습니다. 회차 편입을 먼저 해제하세요.");
  const foreign = adj.currency !== "KRW";
  const neg = foreign ? num(adj.deltaForeign) < 0 : num(adj.deltaNet) < 0;
  const allowed = foreign ? (neg ? ["foreign_refund", "foreign_offset"] : ["additional_remittance"]) : (neg ? ["offset", "refund"] : ["additional_payment"]);
  if (!allowed.includes(type)) throw new AdjError(400, `이 정정 건의 정산 방식은 ${allowed.join(" / ")} 중에서만 선택할 수 있습니다.`);
  const [upd] = await db.update(payoutAdjustmentsTable).set({ settlementType: type, updatedAt: new Date() })
    .where(and(eq(payoutAdjustmentsTable.id, id), eq(payoutAdjustmentsTable.settlementStatus, "open"))).returning();
  await audit(upd, "payout_adjustment_settlement_type", actor, log, { adjustmentId: id, from: adj.settlementType, to: type });
  return upd;
}

// ── 다음 지급회차 편입(추가지급 + / 상계 −) ────────────────────────────────────
export async function assignAdjustmentToRound(id: number, roundId: number, actor: Actor, log: any) {
  const adj = await loadAdj(id);
  if (adj.status !== "approved" || adj.currency !== "KRW" || !["additional_payment", "offset"].includes(String(adj.settlementType)))
    throw new AdjError(409, "승인된 원화 추가지급·상계 건만 지급회차에 편입할 수 있습니다.");
  if (adj.settlementStatus !== "open" || adj.settlementRoundId != null) throw new AdjError(409, "이미 지급회차에 편입되었거나 정산이 끝난 건입니다(중복 편입 방지).");
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, roundId));
  if (!round || (round.status !== "draft" && round.status !== "reviewing")) throw new AdjError(400, "작성중·검토중 지급회차에만 편입할 수 있습니다.");
  if (adj.sourceRoundId === roundId) throw new AdjError(400, "원 지급회차와 다른(다음) 지급회차를 선택해 주세요.");
  if (adj.settlementType === "offset") {
    const key = `${adj.payeeType === "individual" ? "i" : "v"}:${adj.payeeId ?? "none"}`;
    const available = await roundPayeeNet(roundId, key);
    if (available + num(adj.deltaNet) < -0.004) throw new AdjError(400, `이 회차의 같은 지급대상 지급액(${Math.round(available).toLocaleString("ko-KR")}원)이 상계액(${Math.round(-num(adj.deltaNet)).toLocaleString("ko-KR")}원)보다 작습니다. 환수로 전환하거나 다른 회차를 선택해 주세요.`);
  }
  const [upd] = await db.update(payoutAdjustmentsTable).set({ settlementRoundId: roundId, settlementStatus: "scheduled", updatedAt: new Date() })
    .where(and(eq(payoutAdjustmentsTable.id, id), eq(payoutAdjustmentsTable.settlementStatus, "open"), isNull(payoutAdjustmentsTable.settlementRoundId))).returning();
  if (!upd) throw new AdjError(409, "이미 다른 지급회차에 편입된 건입니다(중복 편입 방지).");
  await refreshRoundTotals(roundId);
  await audit(upd, "payout_adjustment_scheduled", actor, log, { adjustmentId: id, payoutRoundId: roundId, settlementType: upd.settlementType, deltaNet: num(upd.deltaNet) });
  return upd;
}
export async function unassignAdjustmentFromRound(id: number, actor: Actor, log: any) {
  const adj = await loadAdj(id);
  if (adj.settlementStatus !== "scheduled" || adj.settlementRoundId == null) throw new AdjError(409, "지급회차에 편입된 건이 아닙니다.");
  const [round] = await db.select().from(payoutRoundsTable).where(eq(payoutRoundsTable.id, adj.settlementRoundId));
  if (round && round.status !== "draft" && round.status !== "reviewing") throw new AdjError(409, "확정·지급완료된 회차에서는 편입을 해제할 수 없습니다(확정취소 후 처리).");
  const [upd] = await db.update(payoutAdjustmentsTable).set({ settlementRoundId: null, settlementStatus: "open", updatedAt: new Date() })
    .where(and(eq(payoutAdjustmentsTable.id, id), eq(payoutAdjustmentsTable.settlementStatus, "scheduled"))).returning();
  if (round) await refreshRoundTotals(round.id);
  await audit(upd, "payout_adjustment_unscheduled", actor, log, { adjustmentId: id, payoutRoundId: adj.settlementRoundId });
  return upd;
}

// ── 수동 정산 확인(환수 입금 확인 / 해외 추가송금·환수·상계 확인) ─────────────────────
//   실제 환수·송금이 확인된 경우에만 완료 처리. 추가송금은 실제 송금완료 내역(performance_remittances)과 1:1 연결.
export async function settleAdjustmentManually(id: number, body: { ref?: string | null; note?: string | null; remittanceId?: number | null }, actor: Actor, log: any) {
  const adj = await loadAdj(id);
  if (adj.status !== "approved" || adj.settlementStatus !== "open") throw new AdjError(409, "정산 대기 상태의 승인 건만 완료 처리할 수 있습니다.");
  const t = String(adj.settlementType);
  if (!["refund", "additional_remittance", "foreign_refund", "foreign_offset"].includes(t)) throw new AdjError(400, "추가지급·상계는 지급회차 지급완료 시 자동으로 정산 완료됩니다.");
  let ref = body.ref?.trim() || null;
  if (t === "additional_remittance") {
    if (!body.remittanceId) throw new AdjError(400, "추가 송금한 송금내역을 선택해 주세요.");
    const [rm] = await db.select().from(performanceRemittancesTable).where(eq(performanceRemittancesTable.id, body.remittanceId));
    if (!rm || rm.deletedAt || rm.assignmentId !== adj.assignmentId || rm.status !== "completed") throw new AdjError(400, "이 수행정보의 송금완료 내역만 연결할 수 있습니다.");
    if (rm.currency.toUpperCase() !== adj.currency.toUpperCase()) throw new AdjError(400, `정정 통화(${adj.currency})와 송금 통화(${rm.currency})가 다릅니다 — 통화가 다른 금액은 합산·정산하지 않습니다.`);
    if (adj.decidedAt && rm.createdAt < adj.decidedAt) throw new AdjError(400, "정정 승인 이후 등록된 송금내역만 추가 송금으로 연결할 수 있습니다.");
    ref = `remittance:${rm.id}`;
    const [dup] = await db.select({ id: payoutAdjustmentsTable.id }).from(payoutAdjustmentsTable).where(and(eq(payoutAdjustmentsTable.settlementRef, ref), ne(payoutAdjustmentsTable.id, id)));
    if (dup) throw new AdjError(409, `이 송금내역은 이미 다른 정정(#${dup.id})에 연결되었습니다(중복 정산 방지).`);
  } else if (!ref) throw new AdjError(400, "환수·상계 확인 근거(입금일·입금자·참조번호 등)를 입력해 주세요.");
  const now = new Date();
  const [upd] = await db.update(payoutAdjustmentsTable).set({ settlementStatus: "settled", settledAt: now, settledBy: actor?.id ?? null, settlementRef: ref, settlementNote: body.note?.trim() || null, updatedAt: now })
    .where(and(eq(payoutAdjustmentsTable.id, id), eq(payoutAdjustmentsTable.settlementStatus, "open"))).returning();
  if (!upd) throw new AdjError(409, "다른 사용자가 먼저 처리했습니다.");
  await audit(upd, "payout_adjustment_settled", actor, log, { adjustmentId: id, settlementType: t, ref, note: body.note?.trim() || null });
  return upd;
}

// ── 조회 ────────────────────────────────────────────────────────────────────
const LIST_SELECT = sql`
  SELECT pa.*, ru.name AS requested_by_name, du.name AS decided_by_name, su.name AS settled_by_name,
         p.title AS project_title, a.product_name_snapshot AS product_name, a.payment_status AS row_payment_status,
         sr.batch_number AS source_round_name, tr.batch_number AS settlement_round_name, tr.status AS settlement_round_status
  FROM payout_adjustments pa
  LEFT JOIN users ru ON ru.id = pa.requested_by
  LEFT JOIN users du ON du.id = pa.decided_by
  LEFT JOIN users su ON su.id = pa.settled_by
  LEFT JOIN projects p ON p.id = pa.project_id
  LEFT JOIN performance_assignments a ON a.id = pa.assignment_id
  LEFT JOIN payout_rounds sr ON sr.id = pa.source_round_id
  LEFT JOIN payout_rounds tr ON tr.id = pa.settlement_round_id`;
const camel = (row: any) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
export async function listAdjustments(f: { projectId?: number; status?: string; settlement?: string; roundId?: number }) {
  const conds = [sql`TRUE`];
  if (f.projectId) conds.push(sql`pa.project_id = ${f.projectId}`);
  if (f.status) conds.push(sql`pa.status = ${f.status}`);
  if (f.settlement === "pending") conds.push(sql`pa.status = 'approved' AND pa.settlement_status IN ('open','scheduled')`);
  else if (f.settlement) conds.push(sql`pa.settlement_status = ${f.settlement}`);
  if (f.roundId) conds.push(sql`(pa.settlement_round_id = ${f.roundId} OR pa.source_round_id = ${f.roundId})`);
  const r = await db.execute(sql`${LIST_SELECT} WHERE ${sql.join(conds, sql` AND `)} ORDER BY pa.id DESC LIMIT 500`);
  const rows = (r.rows as any[]).map(camel);
  const sum = (pred: (x: any) => boolean, f2: (x: any) => number) => r2(rows.filter(pred).reduce((s, x) => s + f2(x), 0));
  const pend = (x: any) => x.status === "approved" && (x.settlementStatus === "open" || x.settlementStatus === "scheduled");
  const summary = {
    requested: rows.filter((x) => x.status === "requested").length,
    confirmedChangeRequested: rows.filter((x) => x.status === "requested" && x.kind === "confirmed_change").length,
    paidCorrectionRequested: rows.filter((x) => x.status === "requested" && x.kind === "paid_correction").length,
    additionalPayment: { count: rows.filter((x) => pend(x) && x.settlementType === "additional_payment").length, amount: sum((x) => pend(x) && x.settlementType === "additional_payment", (x) => num(x.deltaNet)) },
    offsetRefund: { count: rows.filter((x) => pend(x) && (x.settlementType === "offset" || x.settlementType === "refund")).length, amount: sum((x) => pend(x) && (x.settlementType === "offset" || x.settlementType === "refund"), (x) => -num(x.deltaNet)) },
    foreignPending: rows.filter((x) => pend(x) && x.currency !== "KRW").map((x) => ({ id: x.id, currency: x.currency, deltaForeign: num(x.deltaForeign), settlementType: x.settlementType })),
    taxCorrection: rows.filter((x) => x.status === "approved" && x.taxCorrectionNeeded).length,
    invoiceCorrection: rows.filter((x) => x.status === "approved" && x.invoiceCorrectionNeeded).length,
  };
  return { rows, summary };
}
export async function adjustmentHistory(id: number) {
  const adj = await loadAdj(id);
  const r = await db.execute(sql`SELECT id, action, performed_by, performed_by_email, metadata, created_at FROM logs
    WHERE entity_type = 'project' AND entity_id = ${adj.projectId} AND action LIKE 'payout_adjustment_%' AND metadata LIKE ${`{"adjustmentId":${id},%`} ORDER BY id`);
  return (r.rows as any[]).map((x) => ({ id: x.id, action: x.action, performedBy: x.performed_by, performedByEmail: x.performed_by_email, createdAt: x.created_at, metadata: (() => { try { return JSON.parse(x.metadata); } catch { return x.metadata; } })() }));
}
