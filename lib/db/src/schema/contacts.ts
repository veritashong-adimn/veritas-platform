import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companiesTable.id),
  divisionId: integer("division_id"),
  name: text("name").notNull(),
  department: text("department"),
  position: text("position"),
  email: text("email"),
  phone: text("phone"),
  mobile: text("mobile"),
  officePhone: text("office_phone"),
  notes: text("notes"),
  memo: text("memo"),
  // 담당자 등록일(개업일). 대량등록 시 홈택스 원본 등록일자를 보존한다.
  registeredAt: text("registered_at"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  isQuoteContact: boolean("is_quote_contact").default(false).notNull(),
  isBillingContact: boolean("is_billing_contact").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),

  // ── Soft Delete (휴지통) ────────────────────────────────
  // 거래처(companies)와 동일한 패턴. 물리 삭제하지 않고 목록·검색에서만 제외한다.
  // isActive(활성/비활성·통합)와는 별개의 개념이다. 복원 시 세 필드를 NULL 로 초기화한다.
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),          // 삭제 처리 관리자 id
  deletionReason: text("deletion_reason"),   // 삭제 사유(필수 입력)
});

export type Contact = typeof contactsTable.$inferSelect;
export type InsertContact = typeof contactsTable.$inferInsert;
