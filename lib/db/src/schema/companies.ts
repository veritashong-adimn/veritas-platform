import { pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  businessNumber: text("business_number"),
  representativeName: text("representative_name"),
  email: text("email"),
  phone: text("phone"),
  mobile: text("mobile"),
  industry: text("industry"),
  businessCategory: text("business_category"),
  address: text("address"),
  website: text("website"),
  notes: text("notes"),
  registeredAt: text("registered_at"),
  // postpaid_per_project | prepaid_wallet | monthly_billing
  billingType: varchar("billing_type", { length: 50 }).notNull().default("postpaid_per_project"),
  // client (고객사) | vendor (외주업체)
  companyType: varchar("company_type", { length: 30 }).notNull().default("client"),
  // vendor 전용: interpretation_equipment | editing | translation_agency | cleaning | water_supply | etc
  vendorType: varchar("vendor_type", { length: 50 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Company = typeof companiesTable.$inferSelect;
export type InsertCompany = typeof companiesTable.$inferInsert;
