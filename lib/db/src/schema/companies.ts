import { pgTable, serial, text, timestamp, varchar, integer } from "drizzle-orm/pg-core";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  businessNumber: text("business_number"),
  representativeName: text("representative_name"),
  email: text("email"),
  phone: text("phone"),
  mobile: text("mobile"),
  industry: text("industry"),
  businessCategory: text("business_category"),
  address: text("address"),
  website: text("website"),
  notes: text("notes"),
  registeredAt: text("registered_at"),
  // postpaid_per_project | prepaid_wallet | monthly_billing
  billingType: varchar("billing_type", { length: 50 }).notNull().default("postpaid_per_project"),
  // client (고객사) | vendor (외주업체)
  companyType: varchar("company_type", { length: 30 }).notNull().default("client"),
  // vendor 전용: interpretation_equipment | editing | translation_agency | cleaning | water_supply | etc
  vendorType: varchar("vendor_type", { length: 50 }),
  // client 전용: CORPORATE | PUBLIC | INDIVIDUAL (NULL = vendor 또는 레거시 client → CORPORATE 처리)
  customerType: varchar("customer_type", { length: 20 }).default("CORPORATE"),
  createdAt: timestamp("created_at").notNull().defaultNow(),

  // ── Soft Delete (휴지통) ────────────────────────────────
  // 물리 삭제하지 않고 목록·검색에서만 제외한다(레코드·연결관계는 모두 보존).
  // 견적(quotes)과 동일한 패턴. 복원 시 세 필드를 NULL 로 초기화한다.
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),          // 삭제 처리 관리자 id
  deletionReason: text("deletion_reason"),   // 삭제 사유(필수 입력)
});

export type Company = typeof companiesTable.$inferSelect;
export type InsertCompany = typeof companiesTable.$inferInsert;
