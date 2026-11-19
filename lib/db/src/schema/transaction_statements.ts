import { pgTable, serial, integer, text, date, timestamp } from "drizzle-orm/pg-core";
import { quotesTable } from "./quotes";
import { projectPaymentsTable } from "./project_payments";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 거래명세서(2026-11) — 견적당 1건. 거래명세서 번호는 견적에서 파생(T+견적발행일+순번)되며 날짜 변경으로 바뀌지 않는다.
//  · transaction_date = 거래명세서에 출력되는 '거래일자'(사용자 선택·저장). 견적일·판매일·납품일·청구일·세금계산서 발행일과 별개.
//  · date_source: 'tax_invoice'(청구 회차 세금계산서 발행일과 동일) | 'manual'(직접 선택).
//  · linked_payment_id: 거래일자를 가져온 청구 회차(참조만 — 청구정보는 변경하지 않는다). 청구 회차 삭제 시 NULL.
//  · created_at = 시스템 문서 생성일(최초 저장 시각, 변경 불가). 변경 이력은 logs(entity 'quote') 감사로그.
// ─────────────────────────────────────────────────────────────────────────────
export const transactionStatementsTable = pgTable("transaction_statements", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id").notNull().unique().references(() => quotesTable.id, { onDelete: "cascade" }),   // 견적 영구삭제 시 함께 삭제(변경 이력은 감사로그에 유지)
  statementNo: text("statement_no").notNull(),
  transactionDate: date("transaction_date").notNull(),
  dateSource: text("date_source").notNull().default("manual"),
  linkedPaymentId: integer("linked_payment_id").references(() => projectPaymentsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: integer("created_by").references(() => usersTable.id),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: integer("updated_by").references(() => usersTable.id),
});
export type TransactionStatement = typeof transactionStatementsTable.$inferSelect;
