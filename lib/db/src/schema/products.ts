import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  mainCategory: text("main_category"),
  subCategory: text("sub_category"),
  unit: text("unit").notNull().default("건"),
  basePrice: integer("base_price").notNull().default(0),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  category: text("category"),
  languagePair: text("language_pair"),
  field: text("field"),
  productType: text("product_type").notNull().default("translation"),
  interpretationDuration: text("interpretation_duration"),
  overtimePrice: integer("overtime_price"),
});

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = typeof productsTable.$inferInsert;
