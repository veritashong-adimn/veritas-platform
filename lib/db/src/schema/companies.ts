import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  businessNumber: text("business_number"),
  representativeName: text("representative_name"),
  email: text("email"),
  phone: text("phone"),
  industry: text("industry"),
  address: text("address"),
  website: text("website"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Company = typeof companiesTable.$inferSelect;
export type InsertCompany = typeof companiesTable.$inferInsert;
