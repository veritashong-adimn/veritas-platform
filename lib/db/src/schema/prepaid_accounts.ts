import { pgTable, serial, integer, numeric, varchar, timestamp, text, date } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { projectsTable } from "./projects";

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
});

export type PrepaidAccount = typeof prepaidAccountsTable.$inferSelect;
export type PrepaidLedgerEntry = typeof prepaidLedgerTable.$inferSelect;
