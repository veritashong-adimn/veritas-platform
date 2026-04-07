import { pgTable, serial, integer, text, boolean, real, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const translatorProfilesTable = pgTable("translator_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id),
  languagePairs: text("language_pairs"),
  languageLevel: text("language_level"),
  specializations: text("specializations"),
  education: text("education"),
  major: text("major"),
  graduationYear: integer("graduation_year"),
  phone: text("phone"),
  region: text("region"),
  grade: text("grade"),
  rating: real("rating"),
  availabilityStatus: text("availability_status").notNull().default("available"),
  bio: text("bio"),
  ratePerWord: integer("rate_per_word"),
  ratePerPage: integer("rate_per_page"),
  unitType: text("unit_type").default("eojeol"),
  unitPrice: integer("unit_price"),
  resumeUrl: text("resume_url"),
  portfolioUrl: text("portfolio_url"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TranslatorProfile = typeof translatorProfilesTable.$inferSelect;
export type InsertTranslatorProfile = typeof translatorProfilesTable.$inferInsert;
