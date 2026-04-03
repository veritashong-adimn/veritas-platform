import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const translatorSensitiveTable = pgTable("translator_sensitive", {
  id: serial("id").primaryKey(),
  translatorId: integer("translator_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),

  // ── 지급 방식 ──────────────────────────────────────────────────────────────
  // domestic_withholding | domestic_business | overseas_paypal | overseas_bank | other
  paymentMethod: text("payment_method"),

  // ── 국내 3.3% 원천징수 ────────────────────────────────────────────────────
  residentNumber: text("resident_number"),      // AES-256-GCM 암호화
  bankName: text("bank_name"),
  bankAccount: text("bank_account"),
  accountHolder: text("account_holder"),

  // ── 국내 사업자(세금계산서) ───────────────────────────────────────────────
  businessNumber: text("business_number"),      // 사업자등록번호
  businessName: text("business_name"),          // 상호
  businessOwner: text("business_owner"),        // 대표자명
  taxInvoiceEmail: text("tax_invoice_email"),   // 세금계산서 이메일
  // 은행 정보는 위 bankName/bankAccount/accountHolder 공용

  // ── 해외 공통 ─────────────────────────────────────────────────────────────
  englishName: text("english_name"),            // 영문이름
  country: text("country"),                     // 국가
  currency: text("currency"),                   // 통화 (USD, EUR, JPY …)

  // ── 해외 PayPal ───────────────────────────────────────────────────────────
  paypalEmail: text("paypal_email"),            // PayPal 계정 이메일
  remittanceMemo: text("remittance_memo"),      // 송금 메모

  // ── 해외 은행송금 ─────────────────────────────────────────────────────────
  addressEn: text("address_en"),               // 거주지 영문주소
  bankNameEn: text("bank_name_en"),            // 은행명(영문)
  swiftCode: text("swift_code"),               // SWIFT Code
  routingNumber: text("routing_number"),        // Routing Number
  iban: text("iban"),                          // IBAN (선택)

  // ── 공통 추가 항목 ────────────────────────────────────────────────────────
  baseCurrency: text("base_currency"),          // 기본 통화
  remittanceFeePayer: text("remittance_fee_payer"), // 수수료 부담: sender | recipient | split
  paymentHold: boolean("payment_hold").default(false), // 지급 보류
  settlementMemo: text("settlement_memo"),      // 정산 메모

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TranslatorSensitive = typeof translatorSensitiveTable.$inferSelect;
export type InsertTranslatorSensitive = typeof translatorSensitiveTable.$inferInsert;
