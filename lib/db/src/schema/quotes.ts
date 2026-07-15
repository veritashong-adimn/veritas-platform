import { pgTable, serial, integer, numeric, timestamp, pgEnum, text, varchar, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const quoteStatusEnum = pgEnum("quote_status", ["pending", "sent", "approved", "rejected"]);

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  // nullable — 견적서 독립 생성 후 approved 시 프로젝트가 자동 연결됨
  projectId: integer("project_id")
    .references(() => projectsTable.id),

  // ── 견적서 기본 정보 ────────────────────────────────────
  quoteNumber: varchar("quote_number", { length: 30 }),   // Q20260703-001
  title: varchar("title", { length: 255 }),               // 견적서명

  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  status: quoteStatusEnum("status").notNull().default("pending"),
  note: text("note"),

  // ── 세무 구분 ──────────────────────────────────────────
  taxDocumentType: varchar("tax_document_type", { length: 50 }).default("tax_invoice"),
  taxCategory: varchar("tax_category", { length: 50 }).default("normal"),

  // ── 견적서 유형 ────────────────────────────────────────
  // b2c_prepaid | b2b_standard | prepaid_deduction | accumulated_batch
  quoteType: varchar("quote_type", { length: 50 }).notNull().default("b2b_standard"),
  // postpaid_per_project | prepaid_wallet | monthly_billing | prepay_upfront
  billingType: varchar("billing_type", { length: 50 }).notNull().default("postpaid_per_project"),
  // card | cash | bank (prepay_upfront 청구방식에서만 사용)
  paymentMethod: varchar("payment_method", { length: 50 }),

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

  // ── 장비 공통 설정 (JSON string) ────────────────────────
  equipmentCommon: text("equipment_common"),

  // ── Version Engine ──────────────────────────────────────
  version: integer("version").notNull().default(1),
  isCurrent: boolean("is_current").notNull().default(true),
  versionReason: text("version_reason"),
  parentVersionId: integer("parent_version_id"),

  createdAt: timestamp("created_at").notNull().defaultNow(),

  // ── Soft Delete ────────────────────────────────────────
  // 물리 삭제하지 않고 목록·현황·검색에서만 제외한다(레코드는 보존).
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),          // 삭제 처리 사용자 id
  deletionReason: text("deletion_reason"),   // 삭제 사유(필수 입력)
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({ id: true, createdAt: true, status: true, deletedAt: true, deletedBy: true, deletionReason: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
