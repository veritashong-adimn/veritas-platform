import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const divisionsTable = pgTable("divisions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Division = typeof divisionsTable.$inferSelect;
export type InsertDivision = typeof divisionsTable.$inferInsert;
