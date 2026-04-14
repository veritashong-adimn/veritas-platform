import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { translationUnitsTable } from "./translation_units";
import { usersTable } from "./users";

export const translationUnitLogsTable = pgTable("translation_unit_logs", {
  id: serial("id").primaryKey(),
  translationUnitId: integer("translation_unit_id")
    .notNull()
    .references(() => translationUnitsTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  actorUserId: integer("actor_user_id")
    .references(() => usersTable.id, { onDelete: "set null" }),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TranslationUnitLog = typeof translationUnitLogsTable.$inferSelect;
export type InsertTranslationUnitLog = typeof translationUnitLogsTable.$inferInsert;
