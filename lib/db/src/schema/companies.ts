import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

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
  // postpaid_per_project | prepaid_wallet | monthly_billing
  billingType: varchar("billing_type", { length: 50 }).notNull().default("postpaid_per_project"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Company = typeof companiesTable.$inferSelect;
export type InsertCompany = typeof companiesTable.$inferInsert;
