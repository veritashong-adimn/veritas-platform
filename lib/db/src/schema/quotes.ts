import { pgTable, serial, integer, numeric, timestamp, pgEnum, text, varchar, date, boolean, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";
import { companiesTable } from "./companies";
import { contactsTable } from "./contacts";

export const quoteStatusEnum = pgEnum("quote_status", ["pending", "sent", "approved", "rejected"]);

export const quotesTable = pgTable("quotes", {
  id: serial("id").primaryKey(),
  // nullable — 견적서 독립 생성 후 approved 시 프로젝트가 자동 연결됨
  projectId: integer("project_id")
    .references(() => projectsTable.id),

  // ── 견적서 기본 정보 ────────────────────────────────────
  // UNIQUE — 관계견적 번호(-R1/-A1/-01) 중복 최종 방어선. NULL 다중 허용(Postgres) → 미발급 견적 무영향.
  quoteNumber: varchar("quote_number", { length: 30 }).unique(),   // Q000012 / Q000012-R1
  title: varchar("title", { length: 255 }),               // 견적서명

  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
  status: quoteStatusEnum("status").notNull().default("pending"),
  note: text("note"),

  // ── 세무 구분 ──────────────────────────────────────────
  taxDocumentType: varchar("tax_document_type", { length: 50 }).default("tax_invoice"),
  taxCategory: varchar("tax_category", { length: 50 }).default("normal"),

  // ── 견적서 유형 ────────────────────────────────────────
  // b2c_prepaid | b2b_standard | prepaid_deduction | accumulated_batch
  quoteType: varchar("quote_type", { length: 50 }).notNull().default("b2b_standard"),
  // postpaid_per_project | prepaid_wallet | monthly_billing | prepay_upfront
  billingType: varchar("billing_type", { length: 50 }).notNull().default("postpaid_per_project"),
  // card | cash | bank (prepay_upfront 청구방식에서만 사용)
  paymentMethod: varchar("payment_method", { length: 50 }),

  // ── 공통 날짜 ──────────────────────────────────────────
  validUntil: date("valid_until"),
  issueDate: date("issue_date"),
  invoiceDueDate: date("invoice_due_date"),
  paymentDueDate: date("payment_due_date"),

  // ── 선입금 차감 (prepaid_deduction) ────────────────────
  prepaidBalanceBefore: numeric("prepaid_balance_before", { precision: 15, scale: 2 }),
  prepaidUsageAmount: numeric("prepaid_usage_amount", { precision: 15, scale: 2 }),
  prepaidBalanceAfter: numeric("prepaid_balance_after", { precision: 15, scale: 2 }),

  // ── 누적 견적 (accumulated_batch) ──────────────────────
  batchPeriodStart: date("batch_period_start"),
  batchPeriodEnd: date("batch_period_end"),
  batchItemCount: integer("batch_item_count"),
  // 누적 마감: NULL = 누적중(accumulating), 값 존재 = 마감완료(closed) + 마감일자.
  //  accumulated_batch 견적서에만 사용. 마감 후 상품/금액 수정 차단(연결 판매건도 최종 확정 유지).
  batchClosedAt: timestamp("batch_closed_at"),

  // ── 장비 공통 설정 (JSON string) ────────────────────────
  equipmentCommon: text("equipment_common"),

  // ── Version Engine ──────────────────────────────────────
  version: integer("version").notNull().default(1),
  isCurrent: boolean("is_current").notNull().default(true),
  versionReason: text("version_reason"),
  parentVersionId: integer("parent_version_id"),   // 직전/직접 부모 견적 id (관계 엔진에서 재사용)

  // ── Relation Engine (견적 엔진 STEP 1) ──────────────────
  //  · rootQuoteId: 최초 원견적(family root) id. NULL = 이 견적 자신이 원견적(자기 자신을 backfill 하지 않음).
  //    family 조회는 COALESCE(root_quote_id, id) = root 기준. self-FK 로 고아 관계(root 삭제) 방지.
  //  · relationType: NULL=원견적 | 'revision'(변경) | 'additional'(추가) | 'derived'(파생/분리).
  //    현행 데이터는 모두 NULL(원견적)로 완전 호환. 일반견적(b2b_standard)만 적용 대상.
  rootQuoteId: integer("root_quote_id").references((): AnyPgColumn => quotesTable.id),
  relationType: varchar("relation_type", { length: 20 }),

  // ── 파생견적(견적서 분할 발행) 전용 — relation_type='derived' 에서만 사용 ──────────
  //  파생견적은 별도 project 를 만들지 않고 quote family 안에서만 관리된다. 대신 이 두 필드가
  //  '이 분할 견적서를 발행할 대상 회사/담당자'이자 '판매전환 시 청구정보(project_payments)에 자동 반영할 기본 청구처'다.
  //  둘 다 nullable — 일반/변경/누적/차감 견적에는 사용하지 않는다(기존 company/project 구조 무변경).
  derivedCompanyId: integer("derived_company_id").references(() => companiesTable.id),
  derivedContactId: integer("derived_contact_id").references(() => contactsTable.id),

  createdAt: timestamp("created_at").notNull().defaultNow(),

  // ── Soft Delete ────────────────────────────────────────
  // 물리 삭제하지 않고 목록·현황·검색에서만 제외한다(레코드는 보존).
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),          // 삭제 처리 사용자 id
  deletionReason: text("deletion_reason"),   // 삭제 사유(필수 입력)
});

export const insertQuoteSchema = createInsertSchema(quotesTable).omit({ id: true, createdAt: true, status: true, deletedAt: true, deletedBy: true, deletionReason: true });
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotesTable.$inferSelect;

// ─── 판매전환 여부 판단 (공통 비즈니스 로직) ─────────────────────────────────
/**
 * 견적이 '판매전환 완료' 상태인지 판단하는 단일 기준.
 * 판매전환 완료 = quote.status === 'approved'.
 *  - projectId 연결은 견적 저장 시점에도 생길 수 있어(전환과 무관) 판단 기준으로 쓰지 않는다.
 *  - 판매취소 시 status가 'approved' → 'pending'으로 복귀하므로 이 함수만으로 정확히 판단된다.
 * 목록·삭제·수정·판매전환 등 모든 화면/로직이 이 함수를 공통으로 사용한다.
 */
export function isQuoteConverted(status: string | null | undefined): boolean {
  return status === "approved";
}
