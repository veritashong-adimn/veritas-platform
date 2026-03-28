import { pgTable, serial, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const projectStatusEnum = pgEnum("project_status", [
  "created",
  "quoted",
  "approved",
  "paid",
  "matched",
  "in_progress",
  "completed",
  "cancelled",
]);

export const financialStatusEnum = pgEnum("financial_status", [
  "unbilled",
  "billed",
  "receivable",
  "paid",
]);

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  customerId: integer("customer_id"),
  adminId: integer("admin_id").references(() => usersTable.id),
  companyId: integer("company_id"),
  contactId: integer("contact_id"),
  requestingCompanyId: integer("requesting_company_id"),
  requestingDivisionId: integer("requesting_division_id"),
  billingCompanyId: integer("billing_company_id"),
  payerCompanyId: integer("payer_company_id"),
  title: text("title").notNull(),
  fileUrl: text("file_url"),
  status: projectStatusEnum("status").notNull().default("created"),
  financialStatus: financialStatusEnum("financial_status").notNull().default("unbilled"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, status: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
