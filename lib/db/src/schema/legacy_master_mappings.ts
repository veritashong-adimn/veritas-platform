import { pgTable, serial, text, integer, timestamp, varchar, uniqueIndex, index } from "drizzle-orm/pg-core";
import { importBatchesTable } from "./import_batches";

// ─── Legacy Master Mapping (원본 CRM Master ID → VERITAS Master ID 영구 추적) ───
// 역할(= 정체성/멱등 권위): "기존 CRM 의 어떤 레코드가 VERITAS 의 어떤 Master id 로 들어왔는가".
//   · import_row_sources(행 lineage) 와 역할 분리 — 여기는 원본 identity ↔ VERITAS identity 의 1:1 권위.
//   · Snapshot(거래 당시 표시값) 과도 분리 — 여기엔 이름/표시값을 저장하지 않는다.
//   · 논리키 = (sourceSystem, entityType, legacyId). legacyId 는 TEXT(앞자리 0/UUID/혼합 보존).
//   · entityId 는 polymorphic(entityType 별 대상 테이블이 다름) — 무리한 단일 FK 를 걸지 않고
//     application/service 레벨에서 대상 Master 존재를 검증한다.
//   · Master 개명/사용중지/Merge 후에도 이 매핑은 삭제하지 않는다(출처 추적 영구). rollback 시 status 전이만.
//   · legacyId/주민번호/계좌 등 민감·식별정보를 legacyId 로 사용하지 않는다(상위 import 정책).

export const legacyMasterMappingsTable = pgTable("legacy_master_mappings", {
  id: serial("id").primaryKey(),
  // 원본 시스템: old_crm | another_crm | manual_migration ...
  sourceSystem: varchar("source_system", { length: 40 }).notNull(),
  // company | division | contact | product | translator | vendor_profile
  entityType: varchar("entity_type", { length: 30 }).notNull(),
  // 원본 CRM 레코드 식별자 — 원본 그대로 보존(TEXT)
  legacyId: text("legacy_id").notNull(),
  // VERITAS Master PK (company→companies.id, translator→users.id, vendor_profile→companies.id 등)
  entityId: integer("entity_id").notNull(),
  importBatchId: integer("import_batch_id").references(() => importBatchesTable.id, { onDelete: "set null" }),
  sourceRow: integer("source_row"),                 // 최초 등장 원본 행번호
  // legacy | strong | probable | duplicate_candidate | needs_review | unmatched
  matchMethod: varchar("match_method", { length: 20 }).notNull().default("legacy"),
  // active | rolled_back
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  // 멱등·정체성 권위: 같은 (sourceSystem, entityType, legacyId) 는 단 하나.
  uqLegacy: uniqueIndex("uq_legacy_master_mappings_src_type_legacy").on(t.sourceSystem, t.entityType, t.legacyId),
  // 역조회: Master → 그 Master 로 들어온 원본 legacy 들(Merge 후 "여러 legacyId → 한 master" 추적).
  idxEntity: index("idx_legacy_master_mappings_entity").on(t.entityType, t.entityId),
}));

export type LegacyMasterMapping = typeof legacyMasterMappingsTable.$inferSelect;
export type InsertLegacyMasterMapping = typeof legacyMasterMappingsTable.$inferInsert;
