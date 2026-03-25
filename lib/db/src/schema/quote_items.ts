import {
  pgTable, serial, integer, numeric, text, timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { quotesTable } from "./quotes";
import { productsTable } from "./products";

export const quoteItemsTable = pgTable("quote_items", {
  id: serial("id").primaryKey(),

  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),

  productId: integer("product_id")
    .references(() => productsTable.id, { onDelete: "set null" }),

  productName: text("product_name").notNull(),

  unit: text("unit").notNull().default("건"),

  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),

  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),

  supplyAmount: numeric("supply_amount", { precision: 14, scale: 2 }).notNull(),

  taxAmount: numeric("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),

  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),

  memo: text("memo"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertQuoteItemSchema = createInsertSchema(quoteItemsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertQuoteItem = z.infer<typeof insertQuoteItemSchema>;
export type QuoteItem = typeof quoteItemsTable.$inferSelect;

export function calcQuoteItemAmounts(
  quantity: number,
  unitPrice: number,
  taxRate: 0 | 0.1 = 0,
) {
  const supply = Math.round(quantity * unitPrice);
  const tax = Math.round(supply * taxRate);
  return { supplyAmount: supply, taxAmount: tax, totalAmount: supply + tax };
}
