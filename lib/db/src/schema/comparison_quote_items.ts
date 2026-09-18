import { pgTable, serial, integer, text, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { comparisonQuotesTable } from "./comparison_quotes";

// ── 비교견적 품목 (생성 시점 스냅샷) ─────────────────────────────────────────
// 원본 견적 품목을 복사 저장한 뒤 자유 편집(상품명/수량/단가/금액/비고/행 추가·삭제).
// 원본 quote_items 를 절대 수정하지 않는다.
export const comparisonQuoteItemsTable = pgTable("comparison_quote_items", {
  id: serial("id").primaryKey(),
  comparisonQuoteId: integer("comparison_quote_id")
    .notNull()
    .references(() => comparisonQuotesTable.id, { onDelete: "cascade" }),
  // 원본 quote_items.id 참조(추적용). quote_items 는 저장마다 재생성되므로 FK 없는 soft-link.
  sourceQuoteItemId: integer("source_quote_item_id"),

  description: text("description").notNull(), // 상품/업무명
  languagePair: text("language_pair"),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),
  unit: text("unit").notNull().default("건"),
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull().default("0"),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"), // 라인 합계(사용자 자유 수정 가능)
  memo: text("memo"),
  sortOrder: integer("sort_order").notNull().default(0),

  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  idxComparisonItem: index("idx_comparison_quote_items_comparison").on(t.comparisonQuoteId),
}));

export type ComparisonQuoteItem = typeof comparisonQuoteItemsTable.$inferSelect;
export type InsertComparisonQuoteItem = typeof comparisonQuoteItemsTable.$inferInsert;
