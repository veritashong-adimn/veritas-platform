import { pgTable, serial, integer, numeric, varchar, timestamp, text } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { projectsTable } from "./projects";
import { quotesTable } from "./quotes";

export const billingBatchesTable = pgTable("billing_batches", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  status: varchar("status", { length: 50 }).notNull().default("draft"),
  totalAmount: numeric("total_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  note: text("note"),
  quoteId: integer("quote_id").references(() => quotesTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const billingBatchItemsTable = pgTable("billing_batch_items", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => billingBatchesTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projectsTable.id),
  quoteId: integer("quote_id").references(() => quotesTable.id, { onDelete: "set null" }),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  serviceName: text("service_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type BillingBatch = typeof billingBatchesTable.$inferSelect;
export type BillingBatchItem = typeof billingBatchItemsTable.$inferSelect;
