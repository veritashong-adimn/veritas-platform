import { pgTable, serial, text, integer, timestamp, varchar, numeric, date, jsonb, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { importBatchesTable } from "./import_batches";

// ─── Legacy CRM Archive Lite (C-4A) ───────────────────────────────────────────
// 역할: 2018~기존 CRM 과거 Excel 자료를 "원본 그대로" 보존 + 검색용 최소 필드 추출.
//   · Current Master(Product/Company/Contact/Translator)를 생성하지 않는다. Master FK 를 갖지 않는다.
//     → 현재 VERITAS 에 해당 Master 가 하나도 없어도 저장/검색/조회가 가능해야 한다.
//   · source_raw(JSONB) = 파서가 읽은 원본 셀값 그대로(trim/auto-fill/enum/mapping 금지). 원본 보존 권위.
//   · normalized 검색/표시 필드(company_name, record_date, amount 등)는 source_raw 와 분리 — 파싱 실패 시 null,
//     그렇다고 row 자체를 버리지 않는다(Archive 의 1순위 목적 = 자료 보존).
//   · (C-4D) row_hash = CONTENT HASH(내용 지문)일 뿐 row 의 identity 가 아니다. 파일 내부에서 내용이 같은
//     서로 다른 Excel 행은 동일 row_hash 를 갖는 것이 정상이므로 row_hash 는 UNIQUE 가 아니다.
//   · (C-4D) source identity = (file_hash + source_type + source_sheet + source_row). file_hash 는 업로드
//     파일 bytes 의 SHA-256(파일명 무관). 동일 파일 재업로드(파일명만 바꾼 경우 포함)만 멱등 skip 하고,
//     파일 내부 동일값 행(서로 다른 source_row)은 원본 보존을 위해 전부 저장한다. 서로 다른 source_type 독립.
//   · group_key(판매목록↔진행관리 연결)는 C-4A 에서 만들지 않는다(안전한 deterministic key 미확인).
export const legacyArchiveRowsTable = pgTable("legacy_archive_rows", {
  id: serial("id").primaryKey(),
  // 1차 지원: sales_list(판매목록) | progress(통번역 진행관리). 확장 가능하되 지금은 2종만.
  sourceType: varchar("source_type", { length: 20 }).notNull(),
  sourceSystem: varchar("source_system", { length: 40 }).notNull().default("old_crm"),
  // 기존 import_batches 재사용(Master FK 없음). batch 삭제 시 archive row 는 보존(set null).
  importBatchId: integer("import_batch_id").references(() => importBatchesTable.id, { onDelete: "set null" }),
  sourceFile: text("source_file"),
  fileHash: text("file_hash"),                       // (C-4D) 업로드 파일 bytes SHA-256 — source identity 의 FILE 축(파일명 무관)
  sourceSheet: text("source_sheet"),
  sourceRow: integer("source_row"),                 // 1-based 원본 행번호
  // ── 검색/표시용 normalized (전부 nullable, 원본 아님) ──
  recordDate: date("record_date"),                  // 견적서발행일/체결일 등 파싱값(실패 시 null)
  companyName: text("company_name"),
  contactName: text("contact_name"),
  translatorName: text("translator_name"),          // progress 전용(sales_list 는 null)
  productName: text("product_name"),
  language: text("language"),
  supplyAmount: numeric("supply_amount"),
  vatAmount: numeric("vat_amount"),
  totalAmount: numeric("total_amount"),
  payoutPretax: numeric("payout_pretax"),           // progress 지급액(세전)
  deliveryDate: date("delivery_date"),
  payoutDate: date("payout_date"),
  collectionDate: date("collection_date"),
  collectionStatus: varchar("collection_status", { length: 20 }),  // paid|unpaid|null (원본 확정 시에만)
  // ── 원본 보존(권위) ──
  sourceRaw: jsonb("source_raw").notNull(),
  // ── CONTENT HASH(C-4D: identity 아님, 내용 지문 전용) ──
  rowHash: text("row_hash").notNull(),
  // ── (C-4G) 스냅샷 세대 ──
  // 재다운로드한 새 CRM Excel 은 새 snapshot(import_batch)으로 전량 보존한다. is_current=true 는 해당 source_type
  // 의 "최신 스냅샷" 행. 이전 스냅샷 행은 삭제하지 않고 is_current=false(historical) 로 강등만 한다(원본 보존).
  isCurrent: boolean("is_current").notNull().default(true),  // true=최신 스냅샷, false=historical
  // ── (C-4I-b) Effective Version Layer ──
  // is_current(스냅샷 provenance)와 별개. is_effective=true 는 "현재 업무조회에서 최신 유효 version".
  //   NEW/UPDATED/AMBIGUOUS=effective, SAME=evidence 보존(effective 중복 방지). 과거 version 은 삭제 않고 is_effective=false 로 보존.
  matchStatus: varchar("match_status", { length: 20 }),      // new | same | updated | ambiguous (저장 시점 판정)
  isEffective: boolean("is_effective").notNull().default(true),
  supersededById: integer("superseded_by_id"),               // 이 version 을 대체한 새 version row id(논리 포인터, FK 아님)
  logicalGroupKey: text("logical_group_key"),                // version chain 식별(내부 UUID). 주민번호/content-hash 로 만들지 않음
  effectiveVersion: integer("effective_version"),            // 1부터, UPDATED 마다 +1
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // (C-4D) row_hash 는 내용 지문일 뿐 → 파일 내부 동일내용·다른행이 같은 값을 가질 수 있어 UNIQUE 금지. 검색용 일반 index 만.
  idxRowHash: index("idx_legacy_archive_rows_row_hash").on(t.rowHash),
  // (C-4D) 재업로드 멱등 기준 = source identity. 동일 파일(file_hash)+type+sheet+row 중복만 차단, 파일 내부 동일행은 보존.
  uqSourceIdentity: uniqueIndex("uq_legacy_archive_rows_source_identity").on(t.fileHash, t.sourceType, t.sourceSheet, t.sourceRow),
  idxSourceType: index("idx_legacy_archive_rows_source_type").on(t.sourceType),
  idxRecordDate: index("idx_legacy_archive_rows_record_date").on(t.recordDate),
  idxCompanyName: index("idx_legacy_archive_rows_company_name").on(t.companyName),
  // (C-4G) 기본 조회 = source_type 별 최신 스냅샷(is_current) 필터용.
  idxCurrent: index("idx_legacy_archive_rows_current").on(t.sourceType, t.isCurrent),
  // (C-4I-b) 일반 조회 = source_type 별 effective 누적 필터용 + version chain 조회용.
  idxEffective: index("idx_legacy_archive_rows_effective").on(t.sourceType, t.isEffective),
  idxLogicalGroup: index("idx_legacy_archive_rows_logical_group").on(t.logicalGroupKey),
}));

export type LegacyArchiveRow = typeof legacyArchiveRowsTable.$inferSelect;
export type InsertLegacyArchiveRow = typeof legacyArchiveRowsTable.$inferInsert;
