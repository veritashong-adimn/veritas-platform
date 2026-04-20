import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { contentInsightsTable } from "./content_insights";

export const insightAutoSuggestionsTable = pgTable("insight_auto_suggestions", {
  id: serial("id").primaryKey(),
  insightId: integer("insight_id").notNull().references(() => contentInsightsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // "faq" | "related" | "meta"
  payload: jsonb("payload").notNull(), // type에 따라 다른 구조
  status: text("status").notNull().default("pending"), // "pending" | "applied" | "rejected"
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
