import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
import { projectsTable } from "./projects";

export const commTypeEnum = pgEnum("comm_type", ["email", "phone", "message"]);

export const communicationsTable = pgTable("communications", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id),
  projectId: integer("project_id")
    .references(() => projectsTable.id),
  type: commTypeEnum("type").notNull().default("message"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Communication = typeof communicationsTable.$inferSelect;
export type InsertCommunication = typeof communicationsTable.$inferInsert;
