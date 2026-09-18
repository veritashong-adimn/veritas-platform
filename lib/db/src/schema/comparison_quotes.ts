import { pgTable, serial, integer, text, varchar, date, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { quotesTable } from "./quotes";

// ── 비교견적 (고객 제출용 보조 문서) ──────────────────────────────────────────
// 현재 VERITAS 견적(source_quote_id)을 기준으로, VERITAS 가 아닌 다른 상호 명의의
// "비교견적서"를 생성하기 위한 별도 저장소.
//  · VERITAS 의 실제 영업/매출 데이터가 아님 — 판매전환·프로젝트·청구·정산과 절대 연결하지 않는다.
//  · projectId 없음. 금융/워크플로 테이블과 FK 관계를 만들지 않는다. source_quote_id 는 감사용 참조만.
//  · 생성 시점 스냅샷: 원본 견적이 이후 수정돼도 비교견적은 불변(품목은 comparison_quote_items 로 복사 저장).
//  · 정식 견적번호 체계(quote_number_seq / Q000001)를 사용하지 않는다. display_number 는 사용자 직접 입력(선택).
export const comparisonQuotesTable = pgTable("comparison_quotes", {
  id: serial("id").primaryKey(),
  // 원본 VERITAS 견적 참조(감사/역추적용). 금융 흐름과 무관 — 원본 삭제 시 함께 정리.
  sourceQuoteId: integer("source_quote_id")
    .notNull()
    .references((): AnyPgColumn => quotesTable.id, { onDelete: "cascade" }),

  // ── 비교업체 정보(사용자 직접 입력) — VERITAS 정보를 절대 채우지 않는다 ──
  companyName: varchar("company_name", { length: 200 }).notNull(), // 상호명(필수)
  representativeName: varchar("representative_name", { length: 100 }),
  businessNumber: varchar("business_number", { length: 50 }),
  address: text("address"),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 200 }),
  website: varchar("website", { length: 200 }),
  logoUrl: text("logo_url"),
  contactName: varchar("contact_name", { length: 100 }), // 담당자명

  // ── 문서 표시 정보 ──────────────────────────────────────────────────────
  // PDF 표시용 견적번호(사용자 직접 입력, 선택). 정식 Q번호 체계와 무관.
  displayNumber: varchar("display_number", { length: 50 }),
  quoteDate: date("quote_date"),
  // 'vat_10' | 'none' — 부가세 10% 또는 없음
  vatMode: varchar("vat_mode", { length: 20 }).notNull().default("vat_10"),
  memo: text("memo"),

  // ── 고객(수신처) 스냅샷 — 생성 시점 원본 견적의 거래처/담당자 정보를 복사 저장 ──
  //  · SSOT: 원본 견적 → project(company/contact) 또는 derived 필드에서 READ ONLY 로 해결해 스냅샷.
  //  · 원본 companies/contacts 는 절대 수정하지 않는다. 이후 고객 정보가 바뀌어도 이 비교견적은 불변.
  //  · PDF '수신' 영역 표시용. 비었으면 표시하지 않는다.
  customerCompanyName: varchar("customer_company_name", { length: 200 }),
  customerRepresentativeName: varchar("customer_representative_name", { length: 100 }), // 수신처 대표자(원본 견적 companies.representative_name 스냅샷)
  customerContactName: varchar("customer_contact_name", { length: 100 }),
  customerPhone: varchar("customer_phone", { length: 50 }),
  customerEmail: varchar("customer_email", { length: 200 }),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ComparisonQuote = typeof comparisonQuotesTable.$inferSelect;
export type InsertComparisonQuote = typeof comparisonQuotesTable.$inferInsert;
