import { pgTable, serial, integer, numeric, timestamp, pgEnum, varchar, text } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const paymentStatusEnum = pgEnum("payment_status", ["pending", "paid", "failed"]);

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  status: paymentStatusEnum("status").notNull().default("pending"),
  paymentDate: timestamp("payment_date"),
  paymentMethod: varchar("payment_method", { length: 100 }),
  paymentNote: text("payment_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Payment = typeof paymentsTable.$inferSelect;
