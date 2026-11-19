import {
  pgTable, serial, integer, numeric, text, date, timestamp, index,
} from "drizzle-orm/pg-core";
import { performanceAssignmentsTable } from "./performance_assignments";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 해외 외주업체 실제 송금내역(2026-11) — 수행행(performance_assignments) 1:N.
//  · 계약통화·계약금액(performance_assignments.contract_currency / contract_amount_foreign)과 분리 — 송금기록 추가가 계약금액을 바꾸지 않는다.
//  · 분할송금: 한 수행행에 여러 건. 누적 송금액 = 계약통화와 같은 통화의 '송금완료' 건 외화금액 합(다른 통화는 합산하지 않음).
//  · 원화 환산액 = 외화 송금액 × 적용환율(원 단위). 은행 수수료(원화)는 환산액과 별도.
//  · 고객 수금(payment_transactions)·국내 IBK 이체(payout_transfers)와 별개 구조. 삭제는 soft delete(금융 이력 보존).
// ─────────────────────────────────────────────────────────────────────────────
export const REMITTANCE_STATUSES = ["completed", "requested", "failed"] as const;   // 송금완료 · 송금요청(진행중) · 실패/반송
export type RemittanceStatus = typeof REMITTANCE_STATUSES[number];

export const performanceRemittancesTable = pgTable("performance_remittances", {
  id: serial("id").primaryKey(),
  assignmentId: integer("assignment_id").notNull()
    .references(() => performanceAssignmentsTable.id),   // cascade 금지 — 송금(금융) 이력이 있는 수행행은 물리삭제 차단
  remitDate: date("remit_date"),                                          // 송금일
  currency: text("currency").notNull(),                                   // 송금 통화(기본=계약통화)
  foreignAmount: numeric("foreign_amount", { precision: 16, scale: 2 }).notNull(),   // 실제 외화 송금액
  fxRate: numeric("fx_rate", { precision: 18, scale: 6 }),                // 적용환율(외화 1단위당 원화)
  krwAmount: numeric("krw_amount", { precision: 14, scale: 2 }),          // 원화 환산액 = 외화 × 환율(서버 계산)
  bankFee: numeric("bank_fee", { precision: 14, scale: 2 }).notNull().default("0"),  // 은행 수수료(원화, 환산액과 별도)
  status: text("status").notNull().default("completed"),                  // REMITTANCE_STATUSES
  memo: text("memo"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedBy: integer("updated_by").references(() => usersTable.id),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by").references(() => usersTable.id),
}, (t) => ({
  idxAssignment: index("idx_performance_remittances_assignment").on(t.assignmentId),
}));

export type PerformanceRemittance = typeof performanceRemittancesTable.$inferSelect;

/** 원화 환산액 = 외화 × 환율(원 단위). 환율 미입력이면 null. */
export function calcRemitKrw(foreignAmount: number, fxRate: number | null | undefined): number | null {
  if (fxRate == null || !Number.isFinite(Number(fxRate))) return null;
  return Math.round(Number(foreignAmount) * Number(fxRate));
}

export type RemittanceSummaryStatus = "planned" | "partial" | "completed";
export type RemittanceSummary = {
  contractCurrency: string | null; contractAmount: number | null;
  remittedAmount: number;            // 누적 송금액(계약통화 · 송금완료 건)
  remainingAmount: number | null;    // 미송금액 = 계약금액 − 누적 송금액(계약금액 없으면 null)
  status: RemittanceSummaryStatus;   // 송금예정(완료건 없음) · 부분송금 · 송금완료
  completedCount: number; pendingCount: number;
  krwTotal: number; bankFeeTotal: number;                  // 원화 환산액 합 · 은행 수수료 합(원화, 서로 분리)
  otherCurrency: Array<{ currency: string; amount: number }>;  // 계약통화와 다른 통화 송금(합산하지 않고 별도 표시)
};
const r2 = (n: number) => Math.round(n * 100) / 100;
/** 송금내역 요약 — 계약통화와 같은 통화의 '송금완료' 건만 누적. 다른 통화는 합산하지 않는다. */
export function summarizeRemittances(
  contractCurrency: string | null | undefined, contractAmount: number | string | null | undefined,
  records: Array<{ currency: string; foreignAmount: number | string; status: string; krwAmount?: number | string | null; bankFee?: number | string | null; deletedAt?: Date | null }>,
): RemittanceSummary {
  const cur = (contractCurrency ?? "").toUpperCase() || null;
  const amount = contractAmount != null && contractAmount !== "" ? Number(contractAmount) : null;
  const live = records.filter((r) => r.deletedAt == null);
  const done = live.filter((r) => r.status === "completed");
  let remitted = 0; const other = new Map<string, number>();
  for (const r of done) {
    const c = r.currency.toUpperCase();
    if (cur && c === cur) remitted += Number(r.foreignAmount) || 0;
    else other.set(c, (other.get(c) ?? 0) + (Number(r.foreignAmount) || 0));
  }
  remitted = r2(remitted);
  const remaining = amount != null ? r2(amount - remitted) : null;
  const status: RemittanceSummaryStatus = remitted <= 0 ? "planned"
    : (remaining != null && remaining > 0 ? "partial" : "completed");
  return {
    contractCurrency: cur, contractAmount: amount, remittedAmount: remitted, remainingAmount: remaining, status,
    completedCount: done.length, pendingCount: live.filter((r) => r.status === "requested").length,
    krwTotal: done.reduce((s, r) => s + (Number(r.krwAmount) || 0), 0),
    bankFeeTotal: done.reduce((s, r) => s + (Number(r.bankFee) || 0), 0),
    otherCurrency: [...other].map(([currency, a]) => ({ currency, amount: r2(a) })),
  };
}
