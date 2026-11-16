import { pgTable, serial, integer, numeric, varchar, timestamp, text, date, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { projectsTable } from "./projects";
import { projectPaymentsTable } from "./project_payments";

// ── 거래처별 선입금 계정 ────────────────────────────────────────────────────
// 고객이 선입금을 입금하면 이 계정이 생성됨. 거래처당 여러 계정 가능 (재충전 시 누적)
export const prepaidAccountsTable = pgTable("prepaid_accounts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  initialAmount: numeric("initial_amount", { precision: 15, scale: 2 }).notNull(),
  currentBalance: numeric("current_balance", { precision: 15, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"), // active | closed
  note: text("note"),
  depositDate: date("deposit_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ── 선입금 원장 (입금/차감/조정/환불 내역) ─────────────────────────────────
// 계정의 모든 거래 이력 (회계 장부처럼 — 삭제 없이 보정 거래로만 정정)
export const prepaidLedgerTable = pgTable("prepaid_ledger", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => prepaidAccountsTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "set null" }),
  quoteId: integer("quote_id"),                                         // 연결 견적 (FK 없음 — 순환 dep 방지)
  // deposit | deduction | adjustment | refund | carryover
  //  - deposit: 선입금(같은 고객이 여러 번 선입해도 각 행의 발생/입금일로 구분)
  //  - carryover: 기존 진행건 잔액 이월(신규 잔액 발생)
  type: varchar("type", { length: 20 }).notNull(),
  // confirmed(확정·잔액 반영) | reserved(차감예정·잔액 미반영) | released(취소로 해제)
  //  - 차감 견적서 저장 시 reserved 로 기록(가용잔액만 점유, current_balance 불변)
  //  - 판매전환 시 confirmed 로 승격(current_balance 실제 반영)
  //  - 미체결/취소/거절 시 reserved→released 또는 confirmed 반전 후 released
  //  - 기존 데이터·수동 입출금은 항상 confirmed(default) 이므로 하위호환 유지
  status: varchar("status", { length: 20 }).notNull().default("confirmed"),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),     // 항상 양수
  balanceBefore: numeric("balance_before", { precision: 15, scale: 2 }), // 거래 전 잔액 (nullable: 레거시 데이터)
  balanceAfter: numeric("balance_after", { precision: 15, scale: 2 }).notNull(), // 거래 후 잔액
  supplyAmount: numeric("supply_amount", { precision: 15, scale: 2 }),   // 공급가 (차감 시)
  taxAmount: numeric("tax_amount", { precision: 15, scale: 2 }),         // 부가세 (차감 시)
  description: text("description"),
  transactionDate: date("transaction_date").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // ── 기존 입금 연결(선입/이월 행 전용) ──
  //  판매관리에 이미 입금완료된 청구회차의 돈을 선입금으로 쓰는 경우 — 새 현금 입금이 아니라 그 기록을 참조한다.
  //  · 잔액(current_balance)에는 반영하되 계정 신규 입금 누계(initial_amount)는 늘리지 않는다(이중 집계 방지).
  //  · 같은 청구회차는 활성(reserved/confirmed) 행 하나에만 연결 가능(부분 유니크 인덱스).
  linkedPaymentId: integer("linked_payment_id").references(() => projectPaymentsTable.id, { onDelete: "restrict" }),
  confirmedBy: integer("confirmed_by"),              // 확정 처리자(users.id)
  confirmedAt: timestamp("confirmed_at"),            // 확정 처리 시각
  createdBy: integer("created_by"),                  // 등록자(users.id) — 기존 행은 NULL
  // 비고(사용자 메모) — 거래 내용(description)과 별개. 견적 저장(예약 재작성)으로 덮어쓰지 않는다.
  memo: text("memo"),
}, (t) => [
  // 2026-11-17 마이그레이션과 동일 정의(push 시 인덱스가 삭제되지 않도록 스키마에도 선언)
  uniqueIndex("uq_prepaid_ledger_linked_payment").on(t.linkedPaymentId).where(sql`linked_payment_id IS NOT NULL AND status IN ('reserved','confirmed')`),
  uniqueIndex("uq_prepaid_ledger_quote_deduction").on(t.quoteId).where(sql`type = 'deduction' AND status IN ('reserved','confirmed') AND quote_id IS NOT NULL`),
]);

// ── 선입금 원장 수정 이력 ─────────────────────────────────────────────────────
//  원장 행이 바뀔 때마다 변경 전·후 값과 사유·수정자·시각을 남긴다(확정 거래 정정 이력 보존).
//  화면에는 최신값을 표시하고, 이전 값은 이 이력에서 확인한다. 원장 행을 지워도 이력은 남는다(FK 없음).
export const prepaidLedgerHistoryTable = pgTable("prepaid_ledger_history", {
  id: serial("id").primaryKey(),
  ledgerId: integer("ledger_id").notNull(),
  accountId: integer("account_id").notNull(),
  action: varchar("action", { length: 30 }).notNull(),   // update | quote_sync | link | confirm | delete
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  changedBy: integer("changed_by"),
  changedByEmail: text("changed_by_email"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
}, (t) => [
  index("idx_prepaid_ledger_history_ledger").on(t.ledgerId, t.changedAt),
  index("idx_prepaid_ledger_history_account").on(t.accountId, t.changedAt),
]);

export type PrepaidAccount = typeof prepaidAccountsTable.$inferSelect;
export type PrepaidLedgerEntry = typeof prepaidLedgerTable.$inferSelect;
export type PrepaidLedgerHistory = typeof prepaidLedgerHistoryTable.$inferSelect;
