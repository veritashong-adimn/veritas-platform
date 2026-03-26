import { pgTable, serial, integer, numeric, timestamp, pgEnum, text, varchar, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const quoteStatusEnum = pgEnum("quote_status", ["pending", "sent", "approved", "rejected"]);

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  status: quoteStatusEnum("status").notNull().default("pending"),
  note: text("note"),

  // ── 세무 구분 ──────────────────────────────────────────
  taxDocumentType: varchar("tax_document_type", { length: 50 }).default("tax_invoice"),
  taxCategory: varchar("tax_category", { length: 50 }).default("normal"),

  // ── 견적서 유형 ────────────────────────────────────────
  // b2c_prepaid | b2b_standard | prepaid_deduction | accumulated_batch
  quoteType: varchar("quote_type", { length: 50 }).notNull().default("b2b_standard"),
  // postpaid_per_project | prepaid_wallet | monthly_billing
  billingType: varchar("billing_type", { length: 50 }).notNull().default("postpaid_per_project"),

  // ── 공통 날짜 ──────────────────────────────────────────
  validUntil: date("valid_until"),
  issueDate: date("issue_date"),
  invoiceDueDate: date("invoice_due_date"),
  paymentDueDate: date("payment_due_date"),

  // ── 선입금 차감 (prepaid_deduction) ────────────────────
  prepaidBalanceBefore: numeric("prepaid_balance_before", { precision: 15, scale: 2 }),
  prepaidUsageAmount: numeric("prepaid_usage_amount", { precision: 15, scale: 2 }),
  prepaidBalanceAfter: numeric("prepaid_balance_after", { precision: 15, scale: 2 }),

  // ── 누적 견적 (accumulated_batch) ──────────────────────
  batchPeriodStart: date("batch_period_start"),
  batchPeriodEnd: date("batch_period_end"),
  batchItemCount: integer("batch_item_count"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({ id: true, createdAt: true, status: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
