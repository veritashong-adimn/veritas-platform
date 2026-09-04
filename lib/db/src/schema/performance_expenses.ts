import {
  pgTable, serial, integer, numeric, text, date, boolean, timestamp,
} from "drizzle-orm/pg-core";
import { performanceAssignmentsTable } from "./performance_assignments";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 수행 추가비용 (§10) — 수행행 1:N 다건 하위구조.
//   교통비·출장비·숙박비·식비·장비비·기타비용을 개별 건으로 등록.
//   지급대상 포함(includedInPayout=true) 건만 원가합계(costTotal)에 반영.
//   ※ 기존 performance_assignments 의 단일 고정필드(transportationFee 등)는 레거시로 보존.
//     신규 입력은 본 테이블을 사용한다.
// ─────────────────────────────────────────────────────────────────────────────
export const performanceExpensesTable = pgTable("performance_expenses", {
  id: serial("id").primaryKey(),
  assignmentId: integer("assignment_id")
    .notNull()
    .references(() => performanceAssignmentsTable.id, { onDelete: "cascade" }),

  expenseType: text("expense_type").notNull(),   // 교통비/출장비/숙박비/식비/장비비/기타비용
  // amount = 실제 지급액(지급률 적용 후). 정산·지급명세서·원가계산은 이 값을 그대로 사용(다운스트림 무변경).
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  // 지급률 구조(§비용지급률) — 기준금액 × 지급률(%) = amount(실제 지급액). 둘 다 nullable:
  //   기존 데이터·미설정은 base=amount·rate=100%로 간주(재계산 없음). 신규 입력부터 항목별 기본 지급률 적용.
  baseAmount: numeric("base_amount", { precision: 14, scale: 2 }),   // 기준금액(협의 전 원단가). null=amount와 동일 취급
  payoutRate: numeric("payout_rate", { precision: 6, scale: 2 }),    // 지급률(%) 예: 85.00 / 100.00. null=100% 취급
  incurredDate: date("incurred_date"),           // 발생일
  includedInPayout: boolean("included_in_payout").notNull().default(true), // 지급대상 포함 여부
  evidenceUrl: text("evidence_url"),             // 증빙자료 (GCS 경로)
  evidenceFileName: text("evidence_file_name"),
  memo: text("memo"),                            // 비고

  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PerformanceExpense = typeof performanceExpensesTable.$inferSelect;
export type InsertPerformanceExpense = typeof performanceExpensesTable.$inferInsert;
