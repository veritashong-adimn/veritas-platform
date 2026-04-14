import {
  pgTable, serial, integer, text, varchar, boolean, timestamp, index,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { tasksTable } from "./tasks";
import { usersTable } from "./users";

export const translationUnitsTable = pgTable(
  "translation_units",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .references(() => tasksTable.id, { onDelete: "set null" }),
    sourceText: text("source_text").notNull(),
    targetText: text("target_text").notNull(),
    sourceLang: varchar("source_lang", { length: 20 }).notNull(),
    targetLang: varchar("target_lang", { length: 20 }).notNull(),
    domain: varchar("domain", { length: 50 }),
    translatorId: integer("translator_id")
      .references(() => usersTable.id, { onDelete: "set null" }),
    qualityLevel: varchar("quality_level", { length: 10 }),
    securityLevel: varchar("security_level", { length: 20 }).notNull().default("restricted"),
    isAnonymized: boolean("is_anonymized").notNull().default(false),
    anonymizedSourceText: text("anonymized_source_text"),
    anonymizedTargetText: text("anonymized_target_text"),
    sourceCharCount: integer("source_char_count").notNull().default(0),
    targetCharCount: integer("target_char_count").notNull().default(0),
    sourceWordCount: integer("source_word_count").notNull().default(0),
    targetWordCount: integer("target_word_count").notNull().default(0),
    segmentIndex: integer("segment_index").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("tu_project_id_idx").on(t.projectId),
    index("tu_translator_id_idx").on(t.translatorId),
    index("tu_domain_idx").on(t.domain),
    index("tu_lang_pair_idx").on(t.sourceLang, t.targetLang),
    index("tu_security_level_idx").on(t.securityLevel),
    index("tu_status_idx").on(t.status),
  ],
);

export type TranslationUnit = typeof translationUnitsTable.$inferSelect;
export type InsertTranslationUnit = typeof translationUnitsTable.$inferInsert;
