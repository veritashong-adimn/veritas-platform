import { pgTable, serial, text, integer, timestamp, varchar, jsonb, boolean } from "drizzle-orm/pg-core";

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
  // ── Legacy 이관 확장(C-1, additive nullable) ──
  sourceSystem: varchar("source_system", { length: 40 }),  // old_crm | another_crm | manual_migration
  fileHash: text("file_hash"),                             // 동일 파일 재실행 감지(파일명 아님)
  skippedRows: integer("skipped_rows"),                    // skip 처리 행수
  // ── (C-4G) Legacy Archive 스냅샷 세대(additive nullable) ──
  // 하나의 import_batch = 하나의 CRM 다운로드 스냅샷. source_type 별로 최신 1개만 is_current=true.
  sourceType: varchar("source_type", { length: 20 }),      // legacy_archive 스냅샷의 source_type(sales_list|progress)
  isCurrent: boolean("is_current"),                        // 해당 source_type 최신 스냅샷 여부(legacy_archive 전용)
  // (C-4I-c) 원본 Excel header 순서 보존(JSONB 키순서는 소실되므로 배열로 별도 저장). 조회 화면 전체컬럼 정렬용.
  headersJson: jsonb("headers_json"),                      // string[] — 원본 header 원래 순서(dominant sheet)
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
  // ── Legacy 이관 확장(C-1, additive nullable) ──
  sourceSystem: varchar("source_system", { length: 40 }),  // 원본 시스템(legacy mapping 과 연계)
  legacyId: text("legacy_id"),                             // 이 행의 원본 CRM 식별자(있을 때)
  sourceRaw: jsonb("source_raw"),                          // 비-PII 원본 행 보존(감사/재검증). PII 저장 금지.
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ImportBatch = typeof importBatchesTable.$inferSelect;
export type InsertImportBatch = typeof importBatchesTable.$inferInsert;
export type ImportRowSource = typeof importRowSourcesTable.$inferSelect;
export type InsertImportRowSource = typeof importRowSourcesTable.$inferInsert;
