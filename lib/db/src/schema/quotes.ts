import { pgTable, serial, integer, numeric, timestamp, pgEnum, text, varchar } from "drizzle-orm/pg-core";
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
  taxDocumentType: varchar("tax_document_type", { length: 50 }).default("tax_invoice"),
  taxCategory: varchar("tax_category", { length: 50 }).default("normal"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({ id: true, createdAt: true, status: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;
