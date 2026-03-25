import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const notesTable = pgTable("notes", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull().default("project"),
  entityId: integer("entity_id").notNull(),
  adminId: integer("admin_id")
    .notNull()
    .references(() => usersTable.id),
  content: text("content").notNull(),
  tag: text("tag"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Note = typeof notesTable.$inferSelect;
export type InsertNote = typeof notesTable.$inferInsert;
