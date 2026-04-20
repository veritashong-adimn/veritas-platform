import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { contentInsightsTable } from "./content_insights";

export const insightEventsTable = pgTable("insight_events", {
  id: serial("id").primaryKey(),
  insightId: integer("insight_id")
    .notNull()
    .references(() => contentInsightsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // view | click | conversion
  userId: integer("user_id"),
  sessionId: text("session_id").notNull(),
  referrer: text("referrer"),
  device: text("device"), // mobile | desktop | tablet
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type InsightEvent = typeof insightEventsTable.$inferSelect;
export type InsertInsightEvent = typeof insightEventsTable.$inferInsert;
