import { pgTable, serial, integer, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const divisionsTable = pgTable("divisions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type"),
  // 사용중지(Inactive) — 기본 활성(true). 삭제 대신 사용중지로 과거자료(divisionId 참조)를 보존한다.
  //  · 선택목록(신규 거래/담당자)에는 활성 부서만 노출, 과거자료 상세는 id 조인으로 당시 부서명 정상 표시.
  //  · contacts.isActive 패턴과 일관. 물리삭제는 연결자료 0건일 때만 가드 통과 시 허용.
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Division = typeof divisionsTable.$inferSelect;
export type InsertDivision = typeof divisionsTable.$inferInsert;
