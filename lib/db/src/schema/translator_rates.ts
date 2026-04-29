import { pgTable, serial, integer, text, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const translatorRatesTable = pgTable("translator_rates", {
  id: serial("id").primaryKey(),
  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id),
  serviceType: text("service_type").notNull(),
  subType: text("sub_type"),
  language: text("language"),
  languagePair: text("language_pair"),
  unit: text("unit").notNull().default("word"),
  rate: real("rate").notNull(),
  currency: text("currency").notNull().default("KRW"),
  vatIncluded: boolean("vat_included").notNull().default(false),
  minPrice: real("min_price"),
  baseHours: real("base_hours"),
  overtimeRate: real("overtime_rate"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  memo: text("memo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TranslatorRate = typeof translatorRatesTable.$inferSelect;
export type InsertTranslatorRate = typeof translatorRatesTable.$inferInsert;
