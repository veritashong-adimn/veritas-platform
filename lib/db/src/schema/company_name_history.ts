import { pgTable, serial, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const companyNameHistoryTable = pgTable("company_name_history", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  nameType: varchar("name_type", { length: 20 }).notNull().default("current"), // current | previous | alias
  validFrom: text("valid_from"),
  validTo: text("valid_to"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
  changedBy: integer("changed_by"),
  changedByEmail: text("changed_by_email"),
  reason: text("reason"),
});

export type CompanyNameHistory = typeof companyNameHistoryTable.$inferSelect;
