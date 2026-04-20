import { pgTable, serial, text, integer, boolean, numeric, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const languageServiceTypeEnum = pgEnum("language_service_type", [
  "translation",
  "interpretation",
  "equipment",
]);

export const languageServiceDataTable = pgTable("language_service_data", {
  id: serial("id").primaryKey(),
  serviceType: languageServiceTypeEnum("service_type").notNull().default("translation"),

  languagePair: text("language_pair"),
  domain: text("domain"),
  industry: text("industry"),
  useCase: text("use_case"),
  unitPrice: integer("unit_price"),
  totalPrice: integer("total_price"),
  turnaroundTime: text("turnaround_time"),
  isPublic: boolean("is_public").notNull().default(true),

  interpretationType: text("interpretation_type"),
  durationHours: numeric("duration_hours", { precision: 5, scale: 1 }),
  numInterpreters: integer("num_interpreters"),
  locationType: text("location_type"),

  equipmentType: text("equipment_type"),
  quantity: integer("quantity"),
  rentalDuration: text("rental_duration"),

  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type LanguageServiceData = typeof languageServiceDataTable.$inferSelect;
export type InsertLanguageServiceData = typeof languageServiceDataTable.$inferInsert;
