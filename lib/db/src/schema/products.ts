import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  productType: text("product_type").notNull().default("translation"),
  sourceLanguage: text("source_language"),
  targetLanguage: text("target_language"),
  languagePair: text("language_pair"),
  mainCategory: text("main_category"),
  subCategory: text("sub_category"),
  category: text("category"),
  field: text("field"),
  unit: text("unit").notNull().default("건"),
  basePrice: integer("base_price"),
  description: text("description"),
  interpretationDuration: text("interpretation_duration"),
  overtimePrice: integer("overtime_price"),
  active: boolean("active").notNull().default(true),
  deactivationReason: text("deactivation_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
});

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = typeof productsTable.$inferInsert;
