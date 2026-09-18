import { pgTable, serial, varchar, text, boolean, timestamp } from "drizzle-orm/pg-core";

// ── 비교견적 공급자(업체) Master ──────────────────────────────────────────────
// 비교견적에 사용할 "공급자(비교업체)" 정보를 미리 저장해 두고 재사용하기 위한 마스터.
//  · 실제 비교견적(comparison_quotes)과 분리된 Master. 선택 시 그 시점 값을 comparison_quotes 의
//    공급자 스냅샷 필드(company_name/representative_name/… )로 복사한다(별도 스냅샷 컬럼을 만들지 않는다).
//  · 이후 이 Master 가 바뀌어도 이미 생성된 비교견적은 불변(스냅샷 보존). 새 비교견적은 최신 Master 를 읽는다.
//  · VERITAS 실매출/견적/정산과 무관. 고객(수신자) 정보와 절대 혼합하지 않는다.
export const comparisonQuoteVendorsTable = pgTable("comparison_quote_vendors", {
  id: serial("id").primaryKey(),
  companyName: varchar("company_name", { length: 200 }).notNull(), // 상호(필수)
  representativeName: varchar("representative_name", { length: 100 }), // 대표자
  businessNumber: varchar("business_number", { length: 50 }), // 사업자등록번호
  address: text("address"),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 200 }),
  website: varchar("website", { length: 200 }),
  isActive: boolean("is_active").notNull().default(true), // 활성/비활성(비활성은 선택목록에서 숨김)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ComparisonQuoteVendor = typeof comparisonQuoteVendorsTable.$inferSelect;
export type InsertComparisonQuoteVendor = typeof comparisonQuoteVendorsTable.$inferInsert;
