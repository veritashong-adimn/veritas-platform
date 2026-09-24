import { pgTable, serial, text, timestamp, varchar, integer, boolean } from "drizzle-orm/pg-core";

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

  // ── 역할 플래그(가산·additive) ──────────────────────────
  // companies 는 사업자/법인 identity 의 SSOT(§12). 한 회사가 "고객"이면서 "외주업체" 역할을
  // 동시에 가질 수 있다(§3·§12). 기존 단일값 companyType 은 그대로 두고(호환), 아래 두 플래그로
  // 역할 공존을 표현한다. companyType 기반 기존 로직/필터는 변경하지 않는다.
  //  · 외주업체 목록  = is_vendor = true
  //  · 고객사 목록    = 기존 companyType 로직 유지(회귀 방지)
  // 도입 시 companyType 으로부터 1회 backfill: vendor→is_vendor, 그 외→is_customer.
  // 신규 등록 시 API 가 등록 유형에 따라 명시적으로 설정한다.
  isCustomer: boolean("is_customer").notNull().default(false),
  isVendor: boolean("is_vendor").notNull().default(false),
  // client 전용: CORPORATE | PUBLIC | INDIVIDUAL (NULL = vendor 또는 레거시 client → CORPORATE 처리)
  customerType: varchar("customer_type", { length: 20 }).default("CORPORATE"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // 최종 수정일시. nullable — 기존 거래처는 이 기능 도입 시점에 임의 backfill 하지 않고 null 로 둔다(§16).
  // 신규 생성 및 수정 API 에서만 값이 채워진다. 등록일(registeredAt)·createdAt 과 혼용하지 않는다(§2).
  updatedAt: timestamp("updated_at"),

  // ── Soft Delete (휴지통) ────────────────────────────────
  // 물리 삭제하지 않고 목록·검색에서만 제외한다(레코드·연결관계는 모두 보존).
  // 견적(quotes)과 동일한 패턴. 복원 시 세 필드를 NULL 로 초기화한다.
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),          // 삭제 처리 관리자 id
  deletionReason: text("deletion_reason"),   // 삭제 사유(필수 입력)
});

export type Company = typeof companiesTable.$inferSelect;
export type InsertCompany = typeof companiesTable.$inferInsert;
