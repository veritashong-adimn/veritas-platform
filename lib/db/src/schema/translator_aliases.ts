import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// 통번역사 이름 별칭(Alias). 한 통번역사가 여러 이름(영문명·한국명·귀화명·여권명·활동명·약칭 등)으로
// 검색·기록되는 문제를 해결하기 위한 1:N 별칭 관리 테이블. 거래처 Alias(company_aliases)와 동일 구조.
//   - aliasName        : 사용자가 입력/표시하는 원문 별칭
//   - normalizedAlias  : 공백·기호 제거 후 소문자화(검색·중복판정 기준)
//   - isPrimary        : 통번역사 생성 시 실제 이름으로 자동 생성한 기본 별칭 표시(화면에는 숨김)
// 동일 통번역사 내 normalizedAlias 중복은 DB UNIQUE 로도 차단한다.
export const translatorAliasesTable = pgTable("translator_aliases", {
  id: serial("id").primaryKey(),
  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  aliasName: text("alias_name").notNull(),
  normalizedAlias: text("normalized_alias").notNull(),
  isPrimary: boolean("is_primary").default(false).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [unique().on(t.translatorId, t.normalizedAlias)]);

export type TranslatorAlias = typeof translatorAliasesTable.$inferSelect;
export type InsertTranslatorAlias = typeof translatorAliasesTable.$inferInsert;
