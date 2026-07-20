import { pgTable, serial, integer, numeric, text, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { quotesTable } from "./quotes";

/**
 * quote_price_adjustments — 견적 가격조정(Price Adjustment) 이력 테이블
 *
 * 견적 '전체'에 대한 최종 가격조정을 관리하는 전용 테이블.
 * 1차에서는 사용자에게 'Special D.C'(최종 할인) 한 종류만 노출하지만,
 * 내부 구조는 향후 정부기관/VIP/대표승인/프로모션 등으로 확장 가능한 모듈형으로 설계한다.
 *
 * - 원본 데이터의 소스는 이 테이블이다. quotes.price 는 여기서 파생된 '할인 후 최종액'.
 * - 상품별 금액(quote_items)은 절대 변경하지 않는다. 조정은 견적 전체 단위로만 적용한다.
 * - 물리 삭제보다 status 변경(cancelled)·soft delete 를 우선한다(이력 보존).
 */
export const quotePriceAdjustmentsTable = pgTable("quote_price_adjustments", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id")
    .notNull()
    .references(() => quotesTable.id, { onDelete: "cascade" }),

  // 조정 유형 — 현재는 'special_dc'만 사용.
  // 향후: government_discount | vip_discount | promotion | manual_adjustment ...
  adjustmentType: varchar("adjustment_type", { length: 40 }).notNull().default("special_dc"),

  // 할인 방식: amount(금액) | percent(비율)
  amountType: varchar("amount_type", { length: 10 }).notNull().default("amount"),

  // 사용자가 입력한 원본 값(금액 또는 비율)
  inputValue: numeric("input_value", { precision: 14, scale: 2 }).notNull(),

  // 실제 계산된 할인 금액(원 단위). amount=inputValue, percent=round(supplyTotal × inputValue / 100)
  calculatedAmount: numeric("calculated_amount", { precision: 14, scale: 2 }).notNull().default("0"),

  // 내부 할인 사유(필수). PDF·외부 문서에는 출력하지 않는다.
  reason: text("reason"),

  // 상태: draft | applied | cancelled (합계에는 applied 만 포함)
  status: varchar("status", { length: 20 }).notNull().default("applied"),

  // 이력 — 누가 등록/승인했는지
  createdBy: integer("created_by"),
  approvedBy: integer("approved_by"),   // 현재 nullable — 향후 대표/관리자 승인 확장

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
}, (t) => ({
  quoteIdIdx: index("idx_quote_price_adjustments_quote_id").on(t.quoteId),
}));

export type QuotePriceAdjustment = typeof quotePriceAdjustmentsTable.$inferSelect;

// ─── 공통 계산 헬퍼(순수 함수) ─────────────────────────────────────────────────

/** 조정 단건의 실제 할인 금액을 계산한다. (원 단위 반올림) */
export function calcAdjustmentAmount(
  amountType: string,
  inputValue: number,
  supplyTotal: number,
): number {
  const v = Number(inputValue) || 0;
  if (amountType === "percent") return Math.round((supplyTotal * v) / 100);
  return Math.round(v);
}

/**
 * 상품 공급가 합계 + 원 부가세에 가격조정(할인)을 적용해 최종 금액을 계산한다.
 * 계산순서: supplyTotal → (−adjustment) → adjustedSupply → VAT → finalPrice.
 * 부가세는 기존 VAT 비율을 유지한 채 '조정 공급가' 기준으로 비례 재계산한다.
 *  - 예: rawTax=1,220,000, supplyTotal=12,200,000, adjustment=500,000
 *        → adjustedSupply=11,700,000, tax=round(1,220,000×11,700,000/12,200,000)=1,170,000
 * 조정이 0이면 원본과 완전히 동일한 값을 반환한다(미사용 시 무변화 보장).
 */
export function applyAdjustments(
  supplyTotal: number,
  rawTax: number,
  adjustmentTotal: number,
): { appliedAdjustment: number; adjustedSupply: number; tax: number; total: number } {
  const adj = Math.min(Math.max(Math.round(adjustmentTotal), 0), supplyTotal);
  const adjustedSupply = supplyTotal - adj;
  const tax = supplyTotal > 0 ? Math.round((rawTax * adjustedSupply) / supplyTotal) : 0;
  return { appliedAdjustment: adj, adjustedSupply, tax, total: adjustedSupply + tax };
}
