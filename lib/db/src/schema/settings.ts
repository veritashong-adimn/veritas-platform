import { pgTable, serial, varchar, text, timestamp } from "drizzle-orm/pg-core";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),

  // 공급자 정보
  companyName:      varchar("company_name",      { length: 200 }),
  businessNumber:   varchar("business_number",   { length: 50 }),
  ceoName:          varchar("ceo_name",           { length: 100 }),
  address:          text("address"),
  email:            varchar("email",              { length: 200 }),
  phone:            varchar("phone",              { length: 50 }),

  // 입금 계좌
  bankName:         varchar("bank_name",          { length: 100 }),
  accountNumber:    varchar("account_number",     { length: 100 }),
  accountHolder:    varchar("account_holder",     { length: 100 }),

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Settings = typeof settingsTable.$inferSelect;
