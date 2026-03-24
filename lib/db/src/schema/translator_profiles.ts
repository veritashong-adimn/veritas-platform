import { pgTable, serial, integer, text, boolean, real, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const translatorProfilesTable = pgTable("translator_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id),
  languagePairs: text("language_pairs"),
  specializations: text("specializations"),
  education: text("education"),
  major: text("major"),
  graduationYear: integer("graduation_year"),
  region: text("region"),
  rating: real("rating"),
  availabilityStatus: text("availability_status").notNull().default("available"),
  bio: text("bio"),
  ratePerWord: integer("rate_per_word"),
  ratePerPage: integer("rate_per_page"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TranslatorProfile = typeof translatorProfilesTable.$inferSelect;
export type InsertTranslatorProfile = typeof translatorProfilesTable.$inferInsert;
