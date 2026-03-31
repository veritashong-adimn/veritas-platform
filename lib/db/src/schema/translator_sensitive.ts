import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const translatorSensitiveTable = pgTable("translator_sensitive", {
  id: serial("id").primaryKey(),
  translatorId: integer("translator_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  residentNumber: text("resident_number"),
  bankName: text("bank_name"),
  bankAccount: text("bank_account"),
  accountHolder: text("account_holder"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TranslatorSensitive = typeof translatorSensitiveTable.$inferSelect;
export type InsertTranslatorSensitive = typeof translatorSensitiveTable.$inferInsert;
