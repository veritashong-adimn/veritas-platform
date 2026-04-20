import { pgTable, serial, integer, text, boolean, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
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

  slug: text("slug"),

  sourceType: text("source_type"),
  sourceTitle: text("source_title"),
  sourceUrl: text("source_url"),

  filterScore: integer("filter_score"),
  filterDecision: text("filter_decision"),
  filterReason: text("filter_reason"),
  duplicateOfId: integer("duplicate_of_id"),

  searchIntentScore: integer("search_intent_score"),
  commercialIntentScore: integer("commercial_intent_score"),
  specificityScore: integer("specificity_score"),
  duplicationScore: integer("duplication_score"),
  sourceWeight: integer("source_weight"),

  aeoTitle: text("aeo_title"),
  aeoDescription: text("aeo_description"),
  faqJson: jsonb("faq_json").$type<{ question: string; answer: string }[]>(),
  relatedIds: integer("related_ids").array(),

  isArchived: boolean("is_archived").notNull().default(false),
  mergedIntoId: integer("merged_into_id"),
  deletedAt: timestamp("deleted_at"),

  publishedAt: timestamp("published_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ContentInsight = typeof contentInsightsTable.$inferSelect;
export type InsertContentInsight = typeof contentInsightsTable.$inferInsert;
