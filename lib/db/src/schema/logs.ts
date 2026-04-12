import { pgTable, serial, text, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const entityTypeEnum = pgEnum("entity_type", ["project", "quote", "task", "communication", "company", "translator"]);

export const logsTable = pgTable("logs", {
  id: serial("id").primaryKey(),
  entityType: entityTypeEnum("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  action: text("action").notNull(),
  performedBy: integer("performed_by"),
  performedByEmail: text("performed_by_email"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Log = typeof logsTable.$inferSelect;
