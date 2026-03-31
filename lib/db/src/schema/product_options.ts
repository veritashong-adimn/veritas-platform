import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { productsTable } from "./products";

export const productOptionsTable = pgTable("product_options", {
  id: serial("id").primaryKey(),
  productId: integer("product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  optionType: text("option_type").notNull(),
  optionValue: text("option_value").notNull(),
  price: integer("price").default(0),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ProductOption = typeof productOptionsTable.$inferSelect;
export type InsertProductOption = typeof productOptionsTable.$inferInsert;
