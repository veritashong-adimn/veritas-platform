import { pgTable, serial, integer, text, boolean, real, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

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
  // 소속 외주업체 (nullable — 프리랜서는 null)
  affiliatedCompanyId: integer("affiliated_company_id").references(() => companiesTable.id),
  // 정산 구조 유형: 개인 | 사업자 | 업체정산
  settlementType: text("settlement_type"),
  // 프로필 업무유형/세부유형 (쉼표 구분 텍스트, 단가 관리와 별개)
  profileWorkTypes: text("profile_work_types"),
  profileSubTypes: text("profile_sub_types"),
  // 운영상태: normal | warning | hold | excluded
  operationalStatus: text("operational_status").notNull().default("normal"),
  // 운영 관리 메모 (내부 전용)
  operationalNote: text("operational_note"),
  // 재배정 가능 여부
  reassignmentAllowed: boolean("reassignment_allowed").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TranslatorProfile = typeof translatorProfilesTable.$inferSelect;
export type InsertTranslatorProfile = typeof translatorProfilesTable.$inferInsert;
