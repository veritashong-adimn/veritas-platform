import { pgTable, serial, integer, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { usersTable } from "./users";
import { paymentsTable } from "./payments";

export const settlementStatusEnum = pgEnum("settlement_status", ["pending", "ready", "paid"]);

export const settlementsTable = pgTable("settlements", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id),
  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id),
  paymentId: integer("payment_id")
    .references(() => paymentsTable.id),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  translatorAmount: numeric("translator_amount", { precision: 12, scale: 2 }).notNull(),
  platformFee: numeric("platform_fee", { precision: 12, scale: 2 }).notNull(),
  status: settlementStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Settlement = typeof settlementsTable.$inferSelect;
