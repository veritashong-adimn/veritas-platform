import {
  pgTable, serial, integer, numeric, text, timestamp, boolean, date,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { quotesTable } from "./quotes";
import { productsTable } from "./products";

export const quoteItemsTable = pgTable("quote_items", {
  id: serial("id").primaryKey(),

  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),

  productId: integer("product_id")
    .references(() => productsTable.id, { onDelete: "set null" }),

  productName: text("product_name").notNull(),

  languagePair: text("language_pair"),

  unit: text("unit").notNull().default("건"),

  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),

  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),

  supplyAmount: numeric("supply_amount", { precision: 14, scale: 2 }).notNull(),

  taxAmount: numeric("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),

  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),

  memo: text("memo"),

  // ── 항목 유형 ────────────────────────────────────────────────────────────
  itemType: text("item_type").default("translation"),
  // "translation" | "interpretation" | "equipment" | "expense"

  // ── 세금 유형 ────────────────────────────────────────────────────────────
  taxType: text("tax_type").default("taxable"),                // "taxable" | "exempt" | "zero_rate"

  // ── 통역 전용 필드 ─────────────────────────────────────────────────────
  interpretDate: date("interpret_date"),
  interpretPlace: text("interpret_place"),
  interpretType: text("interpret_type"),                       // "consecutive" | "simultaneous" | "meeting"
  interpretDuration: text("interpret_duration"),
  // 운영시간(행사 실제 운영시간) — 자유입력 안내 정보. 통역시간(interpretDuration)과 독립. 계산 미사용.
  operationHours: text("operation_hours"),
  // 투입 인원(통역사 수). 통역 공급가액 = quantity(진행일수) × interpreterCount × unitPrice.
  // NULL = 레거시 행(quantity에 인원×일수가 이미 포함되어 있음 → 인원=quantity÷일수로 역산).
  interpreterCount: integer("interpreter_count"),
  hasTravelExpense: boolean("has_travel_expense").default(false),
  hasEquipment: boolean("has_equipment").default(false),

  // ── 통역 방향 (통역 항목) ────────────────────────────────────────────────
  interpretationDirection: text("interpretation_direction"),   // "양방향" | "A→B" | "B→A"

  // ── 장비 전용 필드 ─────────────────────────────────────────────────────
  quantityUnit: text("quantity_unit"),                         // "개" | "세트" | "부스"
  usagePeriod: text("usage_period"),                           // "반일" | "1일" | "2일" | "3일"

  // ── 장비 개별 설정 (공통값 override) ───────────────────────────────────
  eventStartDate: date("event_start_date"),
  eventEndDate: date("event_end_date"),
  itemLocation: text("item_location"),

  // ── 커스텀 상품 여부 ────────────────────────────────────────────────────
  isCustomProduct: boolean("is_custom_product").default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertQuoteItemSchema = createInsertSchema(quoteItemsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertQuoteItem = z.infer<typeof insertQuoteItemSchema>;
export type QuoteItem = typeof quoteItemsTable.$inferSelect;

/**
 * 견적 항목 금액 계산.
 * 공급가액 = round(quantity × unitPrice × peopleMultiplier).
 *  - 일반 상품: peopleMultiplier=1 (수량 × 단가)
 *  - 통역 상품: quantity=진행일수, peopleMultiplier=투입인원 → 일수 × 인원 × 단가
 * peopleMultiplier 기본값 1이라 기존 호출부는 변경 없이 동작한다.
 */
export function calcQuoteItemAmounts(
  quantity: number,
  unitPrice: number,
  taxRate: 0 | 0.1 = 0,
  peopleMultiplier = 1,
) {
  const mult = peopleMultiplier > 0 ? peopleMultiplier : 1;
  const supply = Math.round(quantity * unitPrice * mult);
  const tax = Math.round(supply * taxRate);
  return { supplyAmount: supply, taxAmount: tax, totalAmount: supply + tax };
}
