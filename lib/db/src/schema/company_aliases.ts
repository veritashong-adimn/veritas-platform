import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// 거래처 기업명 별칭(Alias). 동일 회사가 다양한 표기(㈜베리타스 / VERITAS / 베리타스 통번역센터 등)로
// 기록되는 문제를 해결하기 위한 1:N 별칭 관리 테이블.
//   - aliasName        : 사용자가 입력/표시하는 원문 별칭
//   - normalizedAlias  : 법인표기·공백 제거 후 소문자화(검색·중복판정·향후 자동매칭 기준)
//   - isPrimary        : 거래처 생성 시 공식명으로 자동 생성한 기본 별칭 표시
// 동일 거래처 내 normalizedAlias 중복은 DB UNIQUE 로도 차단한다.
export const companyAliasesTable = pgTable("company_aliases", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  aliasName: text("alias_name").notNull(),
  normalizedAlias: text("normalized_alias").notNull(),
  isPrimary: boolean("is_primary").default(false).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [unique().on(t.companyId, t.normalizedAlias)]);

export type CompanyAlias = typeof companyAliasesTable.$inferSelect;
export type InsertCompanyAlias = typeof companyAliasesTable.$inferInsert;
