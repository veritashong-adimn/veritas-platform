import { pgTable, serial, integer, text, boolean, numeric, timestamp } from "drizzle-orm/pg-core";
import { languageServiceDataTable, languageServiceTypeEnum } from "./language_service_data";

export const contentInsightsTable = pgTable("content_insights", {
  id: serial("id").primaryKey(),

  serviceType: languageServiceTypeEnum("service_type").notNull().default("translation"),
  languageServiceDataId: integer("language_service_data_id")
    .references(() => languageServiceDataTable.id, { onDelete: "set null" }),

  question: text("question").notNull(),
  answer: text("answer").notNull(),
  shortAnswer: text("short_answer"),
  longAnswer: text("long_answer"),

  questionType: text("question_type"),

  domain: text("domain"),
  languagePair: text("language_pair"),
  industry: text("industry"),
  useCase: text("use_case"),

  sourceCount: integer("source_count"),
  avgPrice: numeric("avg_price", { precision: 15, scale: 2 }),
  minPrice: numeric("min_price", { precision: 15, scale: 2 }),
  maxPrice: numeric("max_price", { precision: 15, scale: 2 }),
  avgDuration: numeric("avg_duration", { precision: 8, scale: 2 }),

  status: text("status").notNull().default("draft"),
  visibilityLevel: text("visibility_level").notNull().default("internal_summary"),
  confidenceScore: numeric("confidence_score", { precision: 5, scale: 2 }),

  isPublic: boolean("is_public").notNull().default(true),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ContentInsight = typeof contentInsightsTable.$inferSelect;
export type InsertContentInsight = typeof contentInsightsTable.$inferInsert;
