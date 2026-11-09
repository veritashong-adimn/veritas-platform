import { pgTable, serial, integer, text, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";

/**
 * 고객 등급 관리자 지정 — 자동 등급보다 우선 표시. 해제 시 released_at 기록(이력 보존) → 자동 등급 복귀.
 *  · 현재 지정 = released_at IS NULL (거래처당 1건).
 *  · 테이블 생성은 lib/db/drizzle/ADD_TABLE_customer_grade_overrides.sql (drizzle-kit push 미사용).
 */
export const customerGradeOverridesTable = pgTable("customer_grade_overrides", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  grade: varchar("grade", { length: 10 }).notNull(),
  reason: text("reason").notNull(),
  setAt: timestamp("set_at").notNull().defaultNow(),
  setBy: integer("set_by"),
  releasedAt: timestamp("released_at"),
  releasedBy: integer("released_by"),
}, (t) => [
  uniqueIndex("uq_customer_grade_overrides_active").on(t.companyId).where(sql`released_at IS NULL`),
]);

export type CustomerGradeOverride = typeof customerGradeOverridesTable.$inferSelect;
