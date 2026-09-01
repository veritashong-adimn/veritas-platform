import { pgTable, serial, integer, numeric, timestamp, date, text, varchar } from "drizzle-orm/pg-core";
import { projectPaymentsTable } from "./project_payments";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

// 수금거래(payment_transactions) — 청구행(project_payments) 1 : 입금/결제 거래 N.
//  · project_payments = 청구정보(청구행). payment_transactions = 그 청구행에 실제 발생한 입금/결제 거래.
//  · 한 청구건에 1차/2차/N차 부분입금을 청구행 복제 없이 거래 row 로 표현한다.
//  · 금융 3개념 분리(혼용 금지):
//      청구금액   = project_payments.amount
//      고객결제액 = SUM(payment_transactions.customer_paid_amount)   ← 미수금 계산 기준
//      회사정산액 = payment_transactions.settled_amount              ← 미수금 계산에 사용하지 않음
//  · 이 테이블은 '수금 거래'이며 매출이 아니다(매출 합산에 절대 포함하지 않음).
//  · nullable 항목은 실제 필요한 결제방법에서만 입력한다(국내이체/해외송금/신용카드/기타).
export const paymentTransactionsTable = pgTable("payment_transactions", {
  id: serial("id").primaryKey(),
  // 어느 청구행의 입금인지 — 청구행 삭제 시 함께 삭제(cascade).
  projectPaymentId: integer("project_payment_id").notNull().references(() => projectPaymentsTable.id, { onDelete: "cascade" }),
  // 조회 편의(denormalized) — 프로젝트 단위 집계용.
  projectId: integer("project_id").notNull().references(() => projectsTable.id),

  paidDate: date("paid_date"),                       // 입금/결제일
  method: text("method"),                            // 국내이체 · 해외송금 · 신용카드 · 기타

  // 고객 실제 결제금액(채권 이행액) — 미수금 계산의 단일 기준.
  customerPaidAmount: numeric("customer_paid_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  // 회사 실제 정산금액(수수료 제외 실입금) — 향후 회계용. 고객 미수금에 사용 금지.
  settledAmount: numeric("settled_amount", { precision: 14, scale: 2 }),
  // 카드/PG·중계은행 수수료 — 향후. 고객 미수금에 사용 금지.
  feeAmount: numeric("fee_amount", { precision: 14, scale: 2 }),

  // 해외송금 확장(환차손익 자동회계는 이번 범위 아님 — 데이터만 수용).
  currency: varchar("currency", { length: 3 }).notNull().default("KRW"),
  fxRate: numeric("fx_rate", { precision: 18, scale: 6 }),        // 적용/회계 환율
  foreignAmount: numeric("foreign_amount", { precision: 14, scale: 2 }), // 외화 실입금액
  krwAmount: numeric("krw_amount", { precision: 14, scale: 2 }),  // 원화 환산액

  bankAccount: text("bank_account"),                 // 입금계좌(향후 회사계좌 master FK 로 승격)
  payerName: text("payer_name"),                     // 입금자명 / 송금인
  approvalNo: text("approval_no"),                   // 카드 승인번호
  cardPgType: text("card_pg_type"),                  // 카드/PG 구분(신용카드)
  note: text("note"),

  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedBy: integer("updated_by").references(() => usersTable.id),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PaymentTransaction = typeof paymentTransactionsTable.$inferSelect;
