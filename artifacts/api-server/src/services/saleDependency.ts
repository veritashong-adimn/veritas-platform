// ─────────────────────────────────────────────────────────────────────────────
// 판매(견적/프로젝트) Dependency Guard — READ-ONLY 정합성 검사 service
//
// 목적: 판매취소 / 견적삭제 / 견적영구삭제 이전에 연결된 모든 하위 업무·금융
//       데이터를 전수 검사하여, 확정 금융이력이 있는 판매를 상태변경만으로
//       삭제·취소하지 못하도록 통제한다.
//
// [불변식]
//   · 이 모듈은 SELECT 만 수행한다. 어떤 경우에도 DB 를 변경하지 않는다(검사 = 무부작용).
//   · 기존 금융 SSOT(project_payments / payment_transactions / performance_assignments /
//     payout_rounds / payout_round_items / payout_transfers / settlements)를 재사용한다.
//   · 신규 테이블/컬럼을 만들지 않는다.
//
// [등급 A/B/C/D]
//   A 후속 데이터 없음                         → 삭제/취소 가능
//   B 수행정보만 존재 / 금융거래 없음           → 수행 선행정리 후 삭제/취소 가능
//   C 미확정 금융자료 존재                       → 판매 단독 삭제/취소 금지(먼저 미확정건 취소)
//     (입금예정 scheduled · 지급회차 draft/reviewing · 미확정 정산)
//   D 확정 금융이력 존재                         → 판매 단순 삭제/취소 금지(환불/환수/정정 필요)
//     (deposit_confirmed · payment_transactions · payout confirmed/paid · transfer paid · settlement paid)
// ─────────────────────────────────────────────────────────────────────────────

import { db } from "@workspace/db";
import {
  projectsTable,
  quotesTable,
  projectPaymentsTable,
  paymentTransactionsTable,
  performanceAssignmentsTable,
  payoutRoundsTable,
  payoutRoundItemsTable,
  payoutTransfersTable,
  settlementsTable,
} from "@workspace/db";
import { eq, and, isNull, inArray } from "drizzle-orm";

export type SaleGuardGrade = "A" | "B" | "C" | "D";

interface CountSum {
  count: number;
  amount: number;
}

export interface SaleDependencyDetail {
  customerPayments: {
    confirmed: CountSum; // deposit_confirmed = true (입금확정)
    scheduled: CountSum; // 미확정 청구행(입금예정/부분/미납)
    transactions: CountSum; // payment_transactions (실제 입금거래)
  };
  performance: {
    active: number; // deleted_at IS NULL 수행건
    unpaidActive: number; // payment_status='unpaid' 활성 수행건
    inDraftRound: number; // draft/reviewing 회차에 편입된 수행건
  };
  payout: {
    draftReviewingRounds: number[]; // 미확정 회차 id
    confirmedRounds: number[]; // 확정 회차 id
    paidRounds: number[]; // 지급완료 회차 id
    paidTransfers: CountSum; // status='paid' 또는 paid_at 존재 송금건
  };
  settlements: {
    total: number; // 레거시 정산 건수
    paid: number; // status='paid'
  };
}

export interface SaleDependencyReport {
  projectId: number | null;
  projectStatus: string | null;
  grade: SaleGuardGrade;
  canDelete: boolean;
  canCancel: boolean;
  dependencies: SaleDependencyDetail;
  blockingReasons: string[]; // 사용자 표시용(사유 + 건수/금액)
  requiredActions: string[]; // C등급: 먼저 취소/해제해야 할 항목 안내
}

const KRW = (n: number): string => `${Math.round(n).toLocaleString("ko-KR")}원`;

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const EMPTY_DETAIL = (): SaleDependencyDetail => ({
  customerPayments: {
    confirmed: { count: 0, amount: 0 },
    scheduled: { count: 0, amount: 0 },
    transactions: { count: 0, amount: 0 },
  },
  performance: { active: 0, unpaidActive: 0, inDraftRound: 0 },
  payout: { draftReviewingRounds: [], confirmedRounds: [], paidRounds: [], paidTransfers: { count: 0, amount: 0 } },
  settlements: { total: 0, paid: 0 },
});

/**
 * 프로젝트(=판매) 단위 Dependency 검사. READ-ONLY.
 * project 가 존재하지 않으면 grade A(후속 데이터 없음)로 간주한다.
 */
export async function evaluateProjectDependencies(projectId: number): Promise<SaleDependencyReport> {
  const dep = EMPTY_DETAIL();

  const [project] = await db
    .select({ id: projectsTable.id, status: projectsTable.status })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) {
    // 프로젝트가 없으면 매달린 금융/수행도 없다(모든 하위 FK가 projectId 기준).
    return {
      projectId: null,
      projectStatus: null,
      grade: "A",
      canDelete: true,
      canCancel: true,
      dependencies: dep,
      blockingReasons: [],
      requiredActions: [],
    };
  }

  // ── 1) 고객 입금 계열 ──────────────────────────────────────────────
  const payRows = await db
    .select({
      amount: projectPaymentsTable.amount,
      depositConfirmed: projectPaymentsTable.depositConfirmed,
    })
    .from(projectPaymentsTable)
    .where(eq(projectPaymentsTable.projectId, projectId));
  for (const r of payRows) {
    if (r.depositConfirmed === true) {
      dep.customerPayments.confirmed.count += 1;
      dep.customerPayments.confirmed.amount += toNum(r.amount);
    } else {
      dep.customerPayments.scheduled.count += 1;
      dep.customerPayments.scheduled.amount += toNum(r.amount);
    }
  }

  const txnRows = await db
    .select({ amount: paymentTransactionsTable.customerPaidAmount })
    .from(paymentTransactionsTable)
    .where(eq(paymentTransactionsTable.projectId, projectId));
  for (const r of txnRows) {
    dep.customerPayments.transactions.count += 1;
    dep.customerPayments.transactions.amount += toNum(r.amount);
  }

  // ── 2) 수행 계열(활성만) ───────────────────────────────────────────
  const paRows = await db
    .select({
      paymentStatus: performanceAssignmentsTable.paymentStatus,
      payoutRoundId: performanceAssignmentsTable.payoutRoundId,
    })
    .from(performanceAssignmentsTable)
    .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));
  const roundIdSet = new Set<number>();
  for (const r of paRows) {
    dep.performance.active += 1;
    if (r.paymentStatus === "unpaid") dep.performance.unpaidActive += 1;
    if (r.payoutRoundId != null) roundIdSet.add(r.payoutRoundId);
  }

  // 확정 스냅샷(payout_round_items)이 이 프로젝트를 직접 참조하는 회차도 포함(수행건이 soft-delete 되어도 스냅샷은 남을 수 있음)
  const snapRows = await db
    .select({ payoutRoundId: payoutRoundItemsTable.payoutRoundId })
    .from(payoutRoundItemsTable)
    .where(eq(payoutRoundItemsTable.projectId, projectId));
  for (const r of snapRows) if (r.payoutRoundId != null) roundIdSet.add(r.payoutRoundId);

  // ── 3) 지급회차 / 지급명세서(송금) 계열 ────────────────────────────
  const roundIds = Array.from(roundIdSet);
  if (roundIds.length > 0) {
    const rounds = await db
      .select({ id: payoutRoundsTable.id, status: payoutRoundsTable.status })
      .from(payoutRoundsTable)
      .where(inArray(payoutRoundsTable.id, roundIds));
    for (const rd of rounds) {
      if (rd.status === "draft" || rd.status === "reviewing") dep.payout.draftReviewingRounds.push(rd.id);
      else if (rd.status === "confirmed") dep.payout.confirmedRounds.push(rd.id);
      else if (rd.status === "paid") dep.payout.paidRounds.push(rd.id);
      // cancelled 회차는 무시
    }
    // draft/reviewing 회차에 편입된 활성 수행건 수(선행 제외 안내용)
    const draftSet = new Set(dep.payout.draftReviewingRounds);
    for (const r of paRows) if (r.payoutRoundId != null && draftSet.has(r.payoutRoundId)) dep.performance.inDraftRound += 1;

    const transfers = await db
      .select({ status: payoutTransfersTable.status, paidAt: payoutTransfersTable.paidAt, amount: payoutTransfersTable.amount })
      .from(payoutTransfersTable)
      .where(inArray(payoutTransfersTable.payoutRoundId, roundIds));
    for (const t of transfers) {
      if (t.status === "paid" || t.paidAt != null) {
        dep.payout.paidTransfers.count += 1;
        dep.payout.paidTransfers.amount += toNum(t.amount);
      }
    }
  }

  // ── 4) 레거시 정산(settlements) ────────────────────────────────────
  const stRows = await db
    .select({ status: settlementsTable.status })
    .from(settlementsTable)
    .where(eq(settlementsTable.projectId, projectId));
  for (const r of stRows) {
    dep.settlements.total += 1;
    if (r.status === "paid") dep.settlements.paid += 1;
  }

  // ── 등급 판정 ──────────────────────────────────────────────────────
  const blockingReasons: string[] = [];
  const requiredActions: string[] = [];

  // D — 확정 금융이력
  const hasConfirmedDeposit = dep.customerPayments.confirmed.count > 0;
  const hasTransactions = dep.customerPayments.transactions.count > 0;
  const hasConfirmedRound = dep.payout.confirmedRounds.length > 0;
  const hasPaidRound = dep.payout.paidRounds.length > 0;
  const hasPaidTransfer = dep.payout.paidTransfers.count > 0;
  const hasPaidSettlement = dep.settlements.paid > 0;
  const isD =
    hasConfirmedDeposit || hasTransactions || hasConfirmedRound || hasPaidRound || hasPaidTransfer || hasPaidSettlement;

  // C — 미확정 금융자료
  const hasScheduledDeposit = dep.customerPayments.scheduled.count > 0;
  const hasDraftRound = dep.payout.draftReviewingRounds.length > 0;
  const hasUnpaidSettlement = dep.settlements.total - dep.settlements.paid > 0;
  const isC = hasScheduledDeposit || hasDraftRound || hasUnpaidSettlement;

  const hasPerformance = dep.performance.active > 0;

  let grade: SaleGuardGrade;
  if (isD) {
    grade = "D";
    if (hasConfirmedDeposit)
      blockingReasons.push(
        `고객 입금확정 ${dep.customerPayments.confirmed.count}건 / ${KRW(dep.customerPayments.confirmed.amount)}`,
      );
    if (hasTransactions)
      blockingReasons.push(
        `실제 입금거래 ${dep.customerPayments.transactions.count}건 / ${KRW(dep.customerPayments.transactions.amount)}`,
      );
    if (hasPaidRound) blockingReasons.push(`지급완료 회차 ${dep.payout.paidRounds.length}건 (paid)`);
    if (hasConfirmedRound) blockingReasons.push(`확정 지급회차 ${dep.payout.confirmedRounds.length}건 (confirmed)`);
    if (hasPaidTransfer)
      blockingReasons.push(`통번역사 지급완료(송금) ${dep.payout.paidTransfers.count}건 / ${KRW(dep.payout.paidTransfers.amount)}`);
    if (hasPaidSettlement) blockingReasons.push(`확정 정산(지급완료) ${dep.settlements.paid}건`);
    requiredActions.push("확정된 입금/지급 이력은 삭제·취소할 수 없습니다. 환불/환수/정정/역분개 절차로 처리해야 합니다.");
  } else if (isC) {
    grade = "C";
    if (hasScheduledDeposit)
      blockingReasons.push(
        `입금예정(미확정) ${dep.customerPayments.scheduled.count}건 / ${KRW(dep.customerPayments.scheduled.amount)}`,
      );
    if (hasDraftRound)
      blockingReasons.push(`미확정 지급회차 ${dep.payout.draftReviewingRounds.length}건 (draft/reviewing), 편입 수행 ${dep.performance.inDraftRound}건`);
    if (hasUnpaidSettlement) blockingReasons.push(`미확정 정산 ${dep.settlements.total - dep.settlements.paid}건`);
    if (hasScheduledDeposit) requiredActions.push("연결된 입금예정 청구행을 먼저 취소한 뒤 판매취소하세요.");
    if (hasDraftRound) requiredActions.push("해당 수행건을 지급회차에서 먼저 제외(또는 회차 취소)한 뒤 판매취소하세요.");
    if (hasUnpaidSettlement) requiredActions.push("연결된 정산건을 먼저 정리한 뒤 판매취소하세요.");
  } else if (hasPerformance) {
    grade = "B";
    requiredActions.push(`수행정보 ${dep.performance.active}건이 연결되어 있습니다. 수행정보를 먼저 취소/삭제(soft-delete)한 뒤 진행하세요.`);
  } else {
    grade = "A";
  }

  return {
    projectId: project.id,
    projectStatus: project.status as string,
    grade,
    canDelete: grade === "A" || grade === "B",
    canCancel: grade === "A" || grade === "B",
    dependencies: dep,
    blockingReasons,
    requiredActions,
  };
}

/**
 * 견적 단위 Dependency 검사. quote 에 연결된 project 의 dependency 를 위임 평가한다.
 * (판매취소는 막고 견적 영구삭제로 우회하는 경로를 차단하기 위함)
 */
export async function evaluateQuoteDependencies(
  quoteId: number,
): Promise<SaleDependencyReport & { quoteId: number; linkedProjectId: number | null }> {
  const [quote] = await db
    .select({ id: quotesTable.id, projectId: quotesTable.projectId })
    .from(quotesTable)
    .where(eq(quotesTable.id, quoteId));

  if (!quote || quote.projectId == null) {
    // 연결 프로젝트가 없으면 금융/수행 하위도 없다 → grade A.
    return {
      quoteId,
      linkedProjectId: null,
      projectId: null,
      projectStatus: null,
      grade: "A",
      canDelete: true,
      canCancel: true,
      dependencies: EMPTY_DETAIL(),
      blockingReasons: [],
      requiredActions: [],
    };
  }

  const report = await evaluateProjectDependencies(quote.projectId);
  return { ...report, quoteId, linkedProjectId: quote.projectId };
}

/** blockingReasons 를 사용자 표시용 한 덩어리 메시지로 합친다(기존 toast/alert 재사용). */
export function buildGuardMessage(action: "취소" | "삭제" | "영구삭제", report: SaleDependencyReport): string {
  const head =
    report.grade === "D"
      ? `[판매 ${action} 불가] 확정된 금융이력이 있는 판매는 직접 ${action}할 수 없습니다.`
      : `[판매 ${action} 불가] 먼저 정리해야 할 미확정 금융자료가 있습니다.`;
  const reasons = report.blockingReasons.length ? "\n- " + report.blockingReasons.join("\n- ") : "";
  const actions = report.requiredActions.length ? "\n\n" + report.requiredActions.join("\n") : "";
  return head + reasons + actions;
}
