import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const translatorEmailsTable = pgTable("translator_emails", {
  id: serial("id").primaryKey(),
  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TranslatorEmail = typeof translatorEmailsTable.$inferSelect;
