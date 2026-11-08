import { pgTable, serial, integer, text, varchar, numeric, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { legacyArchiveRowsTable } from "./legacy_archive_rows";
import { usersTable } from "./users";

// ─── 과거 CRM 미지급 수행건 → 운영 지급(은행이체) 전환 승인 이력 ───────────────────────
// · 대상: 과거 CRM 진행관리표 수행행(legacy_archive_rows, source_type='progress') 중 지급일이 없는 미지급 건만(대표 결정).
// · 흐름: 담당자 요청(requested) → 관리자 승인(approved) 또는 반려(rejected). 승인 시에만 기존 '과거 판매 → 운영 판매건 전환'
//   (legacySaleActivation)을 실행하고, 해당 수행건만 '미지급 확인'으로 은행이체 대상이 된다. 승인 ≠ 지급완료·송금.
// · 원본(legacy_archive_rows)은 수정하지 않는다. 승인 당시 금액·상태를 이 행에 스냅샷으로 남긴다.
// · 중복 전환 방지: 수행행당 진행 중(requested)·승인(approved) 기록은 1건만(부분 UNIQUE). 반려 후 재요청은 허용.
export const legacyPayoutConversionsTable = pgTable("legacy_payout_conversions", {
  id: serial("id").primaryKey(),
  progressRowId: integer("progress_row_id").notNull().references(() => legacyArchiveRowsTable.id),
  saleRowId: integer("sale_row_id").references(() => legacyArchiveRowsTable.id),   // 연결된 과거 판매목록 행(요청 시점)
  saleNo: text("sale_no"),
  translatorName: text("translator_name"),
  deliveryDate: text("delivery_date"),
  amountPretax: numeric("amount_pretax"),          // 요청·승인 당시 원본 지급액(세전) 스냅샷
  amountPosttax: numeric("amount_posttax"),        // 요청·승인 당시 원본 지급액(세후) 스냅샷
  legacyStatus: varchar("legacy_status", { length: 30 }),   // 요청 당시 과거 CRM 지급상태(예: deposit_unconfirmed)
  status: varchar("status", { length: 20 }).notNull().default("requested"),   // requested | approved | rejected
  requestNote: text("request_note"),
  requestedBy: integer("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  decisionNote: text("decision_note"),
  decidedBy: integer("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  projectId: integer("project_id"),                // 승인으로 연결된 운영 판매건
  assignmentId: integer("assignment_id"),          // 승인으로 은행이체 대상이 된 운영 수행정보
}, (t) => ({
  uqActive: uniqueIndex("uq_legacy_payout_conv_active").on(t.progressRowId).where(sql`status IN ('requested','approved')`),
  idxStatus: index("idx_legacy_payout_conv_status").on(t.status),
}));
export type LegacyPayoutConversion = typeof legacyPayoutConversionsTable.$inferSelect;
