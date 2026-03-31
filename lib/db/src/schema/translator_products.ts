import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { productsTable } from "./products";

export const translatorProductsTable = pgTable("translator_products", {
  id: serial("id").primaryKey(),
  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  productId: integer("product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  unitPrice: integer("unit_price"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TranslatorProduct = typeof translatorProductsTable.$inferSelect;
export type InsertTranslatorProduct = typeof translatorProductsTable.$inferInsert;
