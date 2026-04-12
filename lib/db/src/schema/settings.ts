import { pgTable, serial, varchar, text, timestamp, integer, boolean, numeric } from "drizzle-orm/pg-core";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),

  // ── 공급자 정보 ────────────────────────────────────────────────────────────
  companyName:      varchar("company_name",      { length: 200 }),
  businessNumber:   varchar("business_number",   { length: 50 }),
  ceoName:          varchar("ceo_name",           { length: 100 }),
  address:          text("address"),
  email:            varchar("email",              { length: 200 }),
  phone:            varchar("phone",              { length: 50 }),

  // ── 입금 계좌 ─────────────────────────────────────────────────────────────
  bankName:         varchar("bank_name",          { length: 100 }),
  accountNumber:    varchar("account_number",     { length: 100 }),
  accountHolder:    varchar("account_holder",     { length: 100 }),

  // ── 문서 설정 ─────────────────────────────────────────────────────────────
  /** 견적 유효기간 기본값 (일수) */
  quoteValidityDays:  integer("quote_validity_days").default(14),
  /** 기본 세율 (%) — 예: 10 */
  taxRate:            numeric("tax_rate", { precision: 5, scale: 2 }).default("10"),
  /** 견적서 안내문 (모든 견적서 하단에 출력) */
  quoteNotes:         text("quote_notes"),
  /** 서명 이미지 URL (Object Storage) */
  signatureImageUrl:  text("signature_image_url"),

  // ── 결제 설정 ─────────────────────────────────────────────────────────────
  /** 기본 결제 방식: postpaid_per_project | prepaid_wallet | monthly_billing */
  defaultBillingType: varchar("default_billing_type", { length: 50 }).default("postpaid_per_project"),
  /** 결제 기한 (일수) */
  paymentDueDays:     integer("payment_due_days").default(7),
  /** 부분입금 허용 여부 */
  allowPartialPayment: boolean("allow_partial_payment").default(false),

  // ── 정산 설정 ─────────────────────────────────────────────────────────────
  /** 정산 비율 (%) — 예: 70 */
  settlementRatio:    numeric("settlement_ratio", { precision: 5, scale: 2 }).default("70"),
  /** 정산 주기: weekly | biweekly | monthly */
  settlementCycle:    varchar("settlement_cycle", { length: 20 }).default("monthly"),
  /** 3.3% 원천세 적용 여부 */
  applyWithholdingTax: boolean("apply_withholding_tax").default(true),

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Settings = typeof settingsTable.$inferSelect;
