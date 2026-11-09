import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";

/**
 * 고객관리 제외 목록 — 고객관리 화면의 [삭제]/[복원] 기록.
 *  · 거래처(companies) 원본은 바꾸지 않고, 고객관리 대상에서만 제외한다.
 *  · 복원은 행 삭제가 아니라 restored_at 기록(이력 보존). 현재 제외 중 = restored_at IS NULL (거래처당 1건).
 *  · 테이블 생성은 lib/db/drizzle/ADD_TABLE_customer_list_exclusions.sql (drizzle-kit push 미사용).
 */
export const customerListExclusionsTable = pgTable("customer_list_exclusions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  reason: text("reason"),
  excludedAt: timestamp("excluded_at").notNull().defaultNow(),
  excludedBy: integer("excluded_by"),
  restoredAt: timestamp("restored_at"),
  restoredBy: integer("restored_by"),
}, (t) => [
  uniqueIndex("uq_customer_list_exclusions_active").on(t.companyId).where(sql`restored_at IS NULL`),
]);

export type CustomerListExclusion = typeof customerListExclusionsTable.$inferSelect;
