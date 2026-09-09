import { pgTable, serial, text, integer, timestamp, varchar } from "drizzle-orm/pg-core";

// ─── 공통 Excel Import Batch / Source Lineage ─────────────────────────────
// 공통 Excel Import Engine 이 남기는 "어떤 파일을, 언제, 누가, 몇 건" 기록과
// "각 등록 레코드가 원본 엑셀의 어느 파일/시트/행에서 왔는지" 계보(lineage)를 담는다.
//   · module 로 거래처/담당자/견적 등 향후 다른 모듈에도 그대로 재사용한다.
//   · 운영 도메인 테이블(companies 등)에는 컬럼을 붙이지 않고 별도 테이블로 분리(안전).
//   · 순수 추가 테이블 — 기존 스키마/데이터/응답에 영향 없음.

export const importBatchesTable = pgTable("import_batches", {
  id: serial("id").primaryKey(),
  // company | contact | quote | ... (향후 모듈 확장)
  module: varchar("module", { length: 30 }).notNull(),
  // excel_bulk | template_bulk | legacy_migration ...
  importType: varchar("import_type", { length: 30 }).notNull().default("excel_bulk"),
  originalFilename: text("original_filename"),
  sheetName: text("sheet_name"),
  totalRows: integer("total_rows").notNull().default(0),
  successRows: integer("success_rows").notNull().default(0),
  warningRows: integer("warning_rows").notNull().default(0),
  errorRows: integer("error_rows").notNull().default(0),
  // analyzed | completed | failed
  status: varchar("status", { length: 20 }).notNull().default("completed"),
  createdBy: integer("created_by"),          // 실행 관리자 user id
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const importRowSourcesTable = pgTable("import_row_sources", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id")
    .notNull()
    .references(() => importBatchesTable.id, { onDelete: "cascade" }),
  module: varchar("module", { length: 30 }).notNull(),
  entityId: integer("entity_id"),            // 생성/매칭된 레코드 id (company id 등). 오류행은 null.
  sourceFile: text("source_file"),
  sourceSheet: text("source_sheet"),
  sourceRow: integer("source_row"),          // 원본 엑셀 기준 1-based 행번호
  // idempotency 비교키: `${module}|biz|${사업자번호}` 또는 `${module}|name|${정규화명}`
  rowKey: text("row_key"),
  // new | identical | update | duplicate_file | error
  status: varchar("status", { length: 20 }).notNull().default("new"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ImportBatch = typeof importBatchesTable.$inferSelect;
export type InsertImportBatch = typeof importBatchesTable.$inferInsert;
export type ImportRowSource = typeof importRowSourcesTable.$inferSelect;
export type InsertImportRowSource = typeof importRowSourcesTable.$inferInsert;
