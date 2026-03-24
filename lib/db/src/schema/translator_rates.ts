import { pgTable, serial, integer, text, real, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const translatorRatesTable = pgTable("translator_rates", {
  id: serial("id").primaryKey(),
  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id),
  serviceType: text("service_type").notNull(),
  languagePair: text("language_pair").notNull(),
  unit: text("unit").notNull().default("word"),
  rate: real("rate").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TranslatorRate = typeof translatorRatesTable.$inferSelect;
export type InsertTranslatorRate = typeof translatorRatesTable.$inferInsert;
