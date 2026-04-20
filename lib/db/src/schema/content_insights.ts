import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { languageServiceDataTable, languageServiceTypeEnum } from "./language_service_data";

export const contentInsightsTable = pgTable("content_insights", {
  id: serial("id").primaryKey(),
  serviceType: languageServiceTypeEnum("service_type").notNull().default("translation"),
  languageServiceDataId: integer("language_service_data_id")
    .references(() => languageServiceDataTable.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  domain: text("domain"),
  languagePair: text("language_pair"),
  isPublic: boolean("is_public").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ContentInsight = typeof contentInsightsTable.$inferSelect;
export type InsertContentInsight = typeof contentInsightsTable.$inferInsert;
