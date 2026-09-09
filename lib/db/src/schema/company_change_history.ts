import { pgTable, serial, integer, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// ─── 거래처 주요정보 변경이력 (필드 단위 audit) ───────────────────────────────
// 상호(name)는 기존 company_name_history 가 current/previous/alias 수명주기까지 관리하므로
// 그대로 재사용하고(중복 생성 금지), 이 테이블은 그 외 주요 사업자정보의 필드별 변경만 남긴다.
//   · 한 번의 수정에서 여러 필드가 바뀌면 필드별로 각각 1행.
//   · old_value === new_value 인 필드는 기록하지 않는다.
//   · 감사추적용 — 거래처 soft delete(휴지통) 시에도 보존한다(FK cascade 미사용).
//   · source_type 으로 변경 경로를 구분(MANUAL / NATIVE_IMPORT / LEGACY_MIGRATION / HOMETAX_RECONCILIATION).
export const companyChangeHistoryTable = pgTable("company_change_history", {
  id: serial("id").primaryKey(),
  // 참조만(무 cascade): 거래처가 물리 삭제돼도 이력은 남기도록 자동 삭제하지 않는다(§13).
  companyId: integer("company_id").notNull().references(() => companiesTable.id),
  // 변경된 논리 필드 키: businessNumber | representativeName | address | industry | businessCategory | phone | email | website ...
  fieldName: varchar("field_name", { length: 40 }).notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
  changedBy: integer("changed_by"),
  changedByEmail: text("changed_by_email"),
  // MANUAL | NATIVE_IMPORT | LEGACY_MIGRATION | HOMETAX_RECONCILIATION
  sourceType: varchar("source_type", { length: 30 }).notNull().default("MANUAL"),
  // import/migration 경로에서 온 변경이면 원본 배치 id (없으면 null). 현재는 MANUAL 만 실사용.
  sourceBatchId: integer("source_batch_id"),
});

export type CompanyChangeHistory = typeof companyChangeHistoryTable.$inferSelect;
export type InsertCompanyChangeHistory = typeof companyChangeHistoryTable.$inferInsert;
