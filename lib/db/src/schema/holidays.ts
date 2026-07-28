import {
  pgTable, serial, date, text, boolean, integer, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// 공휴일 (Holidays)
//
// 지급일(expectedPaymentDate) 자동계산 시 "직전 영업일" 판정에 사용하는 공휴일 원천 데이터.
//  · 프론트엔드에 특정 연도 날짜 배열을 하드코딩하지 않는다 — 이 테이블이 단일 출처.
//  · 법정공휴일·대체공휴일·임시공휴일·선거일 등을 연도별로 보관하고 관리자가 추가·수정 가능.
//  · 날짜 계산의 최종 검증은 서버(@workspace/db previousBusinessDay)에서 수행하고,
//    프론트는 동일 규칙 + 이 테이블 조회결과로 "미리보기"만 계산(§7).
//  · 대한민국 기준 countryCode = 'KR'.
// ─────────────────────────────────────────────────────────────────────────────
export const holidaysTable = pgTable("holidays", {
  id: serial("id").primaryKey(),
  holidayDate: date("holiday_date").notNull(),
  holidayName: text("holiday_name").notNull(),
  // public(법정) | substitute(대체) | temporary(임시) | election(선거일) | anniversary(기타 지정)
  holidayType: text("holiday_type").notNull().default("public"),
  isSubstituteHoliday: boolean("is_substitute_holiday").notNull().default(false),
  isTemporaryHoliday: boolean("is_temporary_holiday").notNull().default(false),
  countryCode: text("country_code").notNull().default("KR"),
  year: integer("year").notNull(),
  active: boolean("active").notNull().default(true),   // 비활성화로 계산 제외(삭제 대신 소프트 off)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  // 같은 날짜에 복수 공휴일(예: 어린이날·부처님오신날 겹침)이 있을 수 있어 명칭까지 포함해 유니크.
  uq: uniqueIndex("holidays_country_date_name_uq").on(t.countryCode, t.holidayDate, t.holidayName),
  byCountryActive: index("holidays_country_active_idx").on(t.countryCode, t.active),
}));

export type Holiday = typeof holidaysTable.$inferSelect;
export type InsertHoliday = typeof holidaysTable.$inferInsert;
