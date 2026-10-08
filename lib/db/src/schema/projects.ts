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
  customerUserId: integer("customer_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  adminId: integer("admin_id").references(() => usersTable.id),
  companyId: integer("company_id"),
  contactId: integer("contact_id"),
  requestingCompanyId: integer("requesting_company_id"),
  requestingDivisionId: integer("requesting_division_id"),
  billingCompanyId: integer("billing_company_id"),
  billingDivisionId: integer("billing_division_id"),
  payerCompanyId: integer("payer_company_id"),
  payerDivisionId: integer("payer_division_id"),
  // 거래 당시 표시명 Snapshot(§과거값 보존) — ID 참조(관계)는 유지, 이름은 생성 시점/ import 원본값으로 고정.
  // Master 개명·통합 시 자동 변경하지 않으며, 조회는 COALESCE(snapshot, 현재 Master명) fallback.
  companyNameSnapshot: text("company_name_snapshot"),
  contactNameSnapshot: text("contact_name_snapshot"),
  title: text("title").notNull(),
  fileUrl: text("file_url"),
  status: projectStatusEnum("status").notNull().default("created"),
  financialStatus: financialStatusEnum("financial_status").notNull().default("unbilled"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, status: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
