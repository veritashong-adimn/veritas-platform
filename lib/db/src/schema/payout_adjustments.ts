import {
  pgTable, serial, integer, numeric, text, varchar, boolean, jsonb, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { performanceAssignmentsTable } from "./performance_assignments";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 지급 정정·승인·차액 정산(payout_adjustments, 2026-11 승인) — 지급확정 후 수정 / 지급완료 후 정정의 단일 기록.
//  · kind
//     - confirmed_change : 지급확정(confirmed) 회차 소속·미지급 행의 금액 수정 요청. 승인 시 수행정보 반영 +
//                          해당 건 확정 스냅샷 재동결(건 단위 확정해제→재확정) + 송금건 재동기화.
//     - paid_correction  : 지급완료(paid) 행 또는 해외송금 완료 이력이 있는 행의 정정 요청. 승인 시 수행정보(원가)만 정정하고
//                          실제 지급기록(payout_round_items·payout_transfers·performance_remittances)은 바꾸지 않는다.
//                          기존 지급액과의 차액을 이 행에 남겨 추가지급·상계·환수로 별도 정산한다.
//  · status: requested → approved | rejected | cancelled. 승인되지 않은 변경은 원본에 반영되지 않는다(requestedPatch 보관만).
//  · 요청자 ≠ 승인자(서버 강제). 승인 권한은 기존 RBAC payout.confirm 재사용.
//  · 차액 정산(settlement*) — paid_correction 승인 건만:
//     additional_payment : 다음 원화 지급회차에 별도 지급 항목(+)으로 편입 → 회차 지급완료 시 settled
//     offset             : 다음 원화 지급회차에 차감 항목(−)으로 편입(같은 지급대상 지급액에서 상계) → 회차 지급완료 시 settled
//     refund             : 환수 — 실제 환수 확인(관리자 입력) 시 settled
//     additional_remittance / foreign_refund / foreign_offset : 해외(외화) — 실제 통화로 별도 관리, 확인 입력 시 settled
//     none               : 차액 0
//  · 중복 방지: (1) 수행행당 진행 중(requested) 요청 1건(부분 UNIQUE) (2) settlementRoundId 는 미배정일 때만 조건부 배정
//    (3) payout_round_items.adjustment_id 부분 UNIQUE — 같은 차액이 두 회차 확정 스냅샷에 동시에 존재할 수 없다.
// ─────────────────────────────────────────────────────────────────────────────
export const PAYOUT_ADJUSTMENT_KINDS = ["confirmed_change", "paid_correction"] as const;
export const PAYOUT_ADJUSTMENT_STATUSES = ["requested", "approved", "rejected", "cancelled"] as const;
export const PAYOUT_SETTLEMENT_TYPES = ["additional_payment", "offset", "refund", "additional_remittance", "foreign_refund", "foreign_offset", "none"] as const;
export const PAYOUT_SETTLEMENT_STATUSES = ["open", "scheduled", "settled"] as const;

export const payoutAdjustmentsTable = pgTable("payout_adjustments", {
  id: serial("id").primaryKey(),
  assignmentId: integer("assignment_id").notNull()
    .references(() => performanceAssignmentsTable.id),          // cascade 금지 — 정정 이력 보존
  projectId: integer("project_id").notNull(),
  kind: varchar("kind", { length: 30 }).notNull(),             // PAYOUT_ADJUSTMENT_KINDS
  sourceRoundId: integer("source_round_id"),                    // 원 지급회차(소프트링크)

  payeeType: text("payee_type"),                                // individual | vendor
  payeeId: integer("payee_id"),
  payeeName: text("payee_name"),
  currency: varchar("currency", { length: 3 }).notNull().default("KRW"),

  requestedPatch: jsonb("requested_patch").notNull(),           // 승인 시 반영할 수행정보 행 입력(RowInput)
  beforeValues: jsonb("before_values").notNull(),               // 기준값(확정/지급 스냅샷 또는 송금누계)
  afterValues: jsonb("after_values"),                           // 정정 후 값(요청 시 미리보기 → 승인 시 확정)

  deltaGross: numeric("delta_gross", { precision: 16, scale: 2 }).notNull().default("0"),
  deltaWithholding: numeric("delta_withholding", { precision: 16, scale: 2 }).notNull().default("0"),
  deltaVat: numeric("delta_vat", { precision: 16, scale: 2 }).notNull().default("0"),
  deltaNet: numeric("delta_net", { precision: 16, scale: 2 }).notNull().default("0"),       // 원화 실지급 차액
  deltaForeign: numeric("delta_foreign", { precision: 16, scale: 2 }),                       // 외화 차액(currency 단위)
  taxCorrectionNeeded: boolean("tax_correction_needed").notNull().default(false),           // 원천세 신고·지급명세서 정정 필요
  invoiceCorrectionNeeded: boolean("invoice_correction_needed").notNull().default(false),   // 수정세금계산서 필요(자동 변경 안 함)

  reason: text("reason").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("requested"),
  requestedBy: integer("requested_by").references(() => usersTable.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  decidedBy: integer("decided_by").references(() => usersTable.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  decisionNote: text("decision_note"),

  settlementType: varchar("settlement_type", { length: 30 }),
  settlementStatus: varchar("settlement_status", { length: 20 }),
  settlementRoundId: integer("settlement_round_id"),            // 편입된 지급회차(소프트링크)
  settledAt: timestamp("settled_at"),
  settledBy: integer("settled_by").references(() => usersTable.id, { onDelete: "set null" }),
  settlementRef: text("settlement_ref"),                        // 환수 입금 확인·송금내역 ID 등 참조
  settlementNote: text("settlement_note"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  uqPending: uniqueIndex("uq_payout_adjustments_pending").on(t.assignmentId).where(sql`status = 'requested'`),
  idxStatus: index("idx_payout_adjustments_status").on(t.status),
  idxAssignment: index("idx_payout_adjustments_assignment").on(t.assignmentId),
  idxSettlementRound: index("idx_payout_adjustments_settlement_round").on(t.settlementRoundId),
}));

export type PayoutAdjustment = typeof payoutAdjustmentsTable.$inferSelect;
