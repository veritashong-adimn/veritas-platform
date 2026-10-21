import { pgTable, serial, integer, text, timestamp, boolean, varchar, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// ─── 통번역사 Master 수동 통합 — 영구 매핑 + 감사 로그 (Phase 3) ───────────────
// 역할: "어떤 Master(mergedMaster)가 어떤 대표 Master(representative)로 통합되었는가"의 영구 권위.
//   · 통합은 물리삭제가 아니다 — mergedMaster 는 soft-exclude(users.deleted_at + operational_status='merged')로
//     운영목록/선택창에서 제외되고, 이 매핑으로 "merged → representative" 를 영구 해석한다(§11 복구 근거).
//   · 진행관리표/판매목록 원본(legacy_archive_rows)은 절대 변경하지 않는다 — 귀속은 FK 재지정 + 이 매핑으로만 표현.
//   · 되돌리기(revert): 감사로그(translator_merge_audit)의 from/to 로 모든 FK 를 원복하고 snapshot 으로 상태 복구.
export const translatorMergesTable = pgTable("translator_merges", {
  id: serial("id").primaryKey(),
  mergedMasterId: integer("merged_master_id").notNull().references(() => usersTable.id),         // 통합되어 숨겨지는 계정
  representativeMasterId: integer("representative_master_id").notNull().references(() => usersTable.id), // 유지되는 대표
  samePersonConfirmed: boolean("same_person_confirmed").notNull().default(false),  // §6 대표의 동일인 확인 체크
  basis: text("basis"),                                   // 동일인 근거(rrn|phone|email|manual)
  note: text("note"),
  performedBy: integer("performed_by").references(() => usersTable.id),
  // 통합 직전 mergedMaster 상태(deleted_at/is_active/operational_status 등) — 복구용 스냅샷(§11)
  snapshot: jsonb("snapshot"),
  status: varchar("status", { length: 20 }).notNull().default("active"),   // active | reverted
  mergedAt: timestamp("merged_at").notNull().defaultNow(),
  revertedAt: timestamp("reverted_at"),
  revertedBy: integer("reverted_by").references(() => usersTable.id),
}, (t) => ({
  // 한 계정은 동시에 하나의 대표로만 통합(활성 매핑 1개) — 재통합/중복 방지.
  uqActiveMerged: uniqueIndex("uq_translator_merges_merged_active").on(t.mergedMasterId).where(sql`status = 'active'`),
  idxRep: index("idx_translator_merges_rep").on(t.representativeMasterId),
}));

// 통합 시 재지정된 모든 참조의 before/after 를 기록 — 되돌리기(정확 원복)와 감사 추적의 근거(§11·§12).
export const translatorMergeAuditTable = pgTable("translator_merge_audit", {
  id: serial("id").primaryKey(),
  mergeId: integer("merge_id").notNull().references(() => translatorMergesTable.id),
  action: varchar("action", { length: 20 }).notNull(),   // repoint | exclude | revert_repoint | revert_restore
  entityTable: varchar("entity_table", { length: 40 }),  // tasks | settlements | performance_assignments | payout_round_items | payout_transfers | legacy_master_mappings | users
  entityId: integer("entity_id"),                        // 재지정된 원본 행 id
  field: varchar("field", { length: 40 }),               // translator_id | individual_user_id | payee_id | entity_id ...
  fromValue: text("from_value"),
  toValue: text("to_value"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({ idxMerge: index("idx_translator_merge_audit_merge").on(t.mergeId) }));

export type TranslatorMerge = typeof translatorMergesTable.$inferSelect;
export type TranslatorMergeAudit = typeof translatorMergeAuditTable.$inferSelect;
