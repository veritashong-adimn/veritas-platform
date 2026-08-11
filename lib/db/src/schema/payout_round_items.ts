import {
  pgTable, serial, integer, numeric, text, date, timestamp, boolean, jsonb,
} from "drizzle-orm/pg-core";
import { payoutRoundsTable } from "./payout_rounds";

// ─────────────────────────────────────────────────────────────────────────────
// 지급회차 건별 확정 스냅샷(payout_round_items) — 정산 무결성 보존 레이어.
//   · [원칙] 지급확정 전: performance_assignments(수행정보)가 Source of Truth → 회차 상세는 실시간 재계산.
//   · [원칙] 지급확정(confirmed)·지급완료(paid): 확정 당시 건별 정산정보를 이 테이블에 동결 저장하고,
//     이후 조회는 원본을 재계산하지 않고 이 스냅샷을 그대로 표시한다(§10·§11).
//   · 원본 수행정보는 확정 후에도 정정 가능하나, 그 변경은 과거 확정 스냅샷을 바꾸지 않는다(§4·§6).
//   · payout_round_id·performance_assignment_id 는 소프트링크(FK 미설정 — 기존 payoutRoundId 방침과 동일).
//     단 회차 삭제/재확정 시 정합을 위해 payout_round_id 에만 FK(onDelete cascade)를 둔다.
// ─────────────────────────────────────────────────────────────────────────────
export const payoutRoundItemsTable = pgTable("payout_round_items", {
  id: serial("id").primaryKey(),
  payoutRoundId: integer("payout_round_id")
    .notNull()
    .references(() => payoutRoundsTable.id, { onDelete: "cascade" }),
  performanceAssignmentId: integer("performance_assignment_id").notNull(), // 원본 수행건(소프트링크)

  // ── 지급대상 ──
  payeeType: text("payee_type"),           // individual | vendor | none
  payeeId: integer("payee_id"),            // individual_user_id 또는 vendor_company_id
  payeeName: text("payee_name"),

  // ── 프로젝트/판매/상품·업무 ──
  projectId: integer("project_id"),
  projectTitle: text("project_title"),
  quoteId: integer("quote_id"),
  quoteNumber: text("quote_number"),
  customerName: text("customer_name"),
  serviceType: text("service_type"),
  productName: text("product_name"),

  // ── 일자 ──
  performanceStartDate: date("performance_start_date"),
  performanceEndDate: date("performance_end_date"),
  deliveryDate: date("delivery_date"),
  paymentDate: date("payment_date"),       // 지급일(확정 당시 expectedPaymentDate)

  // ── 작업량·단가 ──
  quantity: numeric("quantity", { precision: 14, scale: 2 }),
  unit: text("unit"),
  contractUnitPrice: numeric("contract_unit_price", { precision: 14, scale: 2 }),
  isDirectAmount: boolean("is_direct_amount"),
  serviceDetail: jsonb("service_detail"),  // 작업량 표시용(단어수·통역 인원 등) 확정 당시 스냅샷

  // ── 금액(확정 당시) ──
  basePerformanceFee: numeric("base_performance_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  expenseTotal: numeric("expense_total", { precision: 14, scale: 2 }).notNull().default("0"),
  deductionTotal: numeric("deduction_total", { precision: 14, scale: 2 }).notNull().default("0"),
  grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }).notNull().default("0"), // 세전 = costTotal

  // ── 세금(확정 당시) ──
  withholdingTreatment: text("withholding_treatment"),
  withholdingRate: numeric("withholding_rate", { precision: 7, scale: 4 }),
  withholdingAmount: numeric("withholding_amount", { precision: 14, scale: 2 }).notNull().default("0"), // 공제(원천징수)
  purchaseEvidenceType: text("purchase_evidence_type"),
  vatIncluded: boolean("vat_included").notNull().default(false),
  vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  netAmount: numeric("net_amount", { precision: 14, scale: 2 }).notNull().default("0"),       // 실지급액

  // ── 세부내역 스냅샷(건별 상세 인라인 표시용) ──
  expenses: jsonb("expenses"),             // [{ type, amount, memo }]
  deductions: jsonb("deductions"),         // [{ type, amount, reason }]
  remark: text("remark"),

  // ── 메타 ──
  confirmedAt: timestamp("confirmed_at"),  // 지급확정 시각
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PayoutRoundItem = typeof payoutRoundItemsTable.$inferSelect;
export type InsertPayoutRoundItem = typeof payoutRoundItemsTable.$inferInsert;
