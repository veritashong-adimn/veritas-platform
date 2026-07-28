import {
  pgTable, serial, integer, numeric, text, timestamp,
} from "drizzle-orm/pg-core";
import { performanceAssignmentsTable } from "./performance_assignments";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 수행 차감액 (§10) — 수행행 1:N 다건 하위구조.
//   선지급금 차감·과지급금 회수·계약상 차감·기타 조정을 개별 건으로 등록.
//   전 건 합산(deductionTotal)이 원가합계에서 차감된다.
// ─────────────────────────────────────────────────────────────────────────────
export const performanceDeductionsTable = pgTable("performance_deductions", {
  id: serial("id").primaryKey(),
  assignmentId: integer("assignment_id")
    .notNull()
    .references(() => performanceAssignmentsTable.id, { onDelete: "cascade" }),

  deductionType: text("deduction_type").notNull(), // 선지급금차감/과지급금회수/계약상차감/기타조정
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  reason: text("reason"),                          // 사유

  createdBy: integer("created_by").references(() => usersTable.id),  // 등록자
  createdAt: timestamp("created_at").notNull().defaultNow(),         // 등록일시
});

export type PerformanceDeduction = typeof performanceDeductionsTable.$inferSelect;
export type InsertPerformanceDeduction = typeof performanceDeductionsTable.$inferInsert;
