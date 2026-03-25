/**
 * ============================================================
 * [DRAFT] quote_items 테이블 설계 초안 — 실제 마이그레이션 전 검토용
 * ============================================================
 *
 * 목적: 견적서의 품목 명세(제품명, 수량, 단가, 공급가액, 세액) 저장
 * 실제 push는 이 파일이 아닌 별도 확정된 schema 파일로 진행
 *
 * ── 영향 범위 분석 ──────────────────────────────────────────
 *
 * [DB 변경]
 *  - `quote_items` 신규 테이블 생성 (breaking 없음, 추가 전용)
 *  - `quotes.price` 컬럼 유지 (total_amount 합산값과 동기화 선택)
 *    → 권장: quote_items 생성/수정 시 quotes.price 자동 업데이트 (AFTER INSERT trigger 또는 서비스 레이어)
 *
 * [API 영향 범위]
 *  - routes/quotes.ts
 *      POST /api/quotes/:id/items        (품목 추가)
 *      GET  /api/quotes/:id/items        (품목 목록)
 *      PATCH /api/quotes/:id/items/:itemId  (품목 수정)
 *      DELETE /api/quotes/:id/items/:itemId (품목 삭제)
 *  - routes/admin.ts
 *      POST /api/admin/projects/:id/quote 에서 items[] 배열 함께 전달 가능하도록 확장
 *  - services/document.service.ts
 *      buildQuoteHtml() 에 QuoteItem[] 배열 파라미터 추가 → 품목 테이블 렌더링 (자리 확보됨)
 *
 * [Frontend 영향 범위]
 *  - App.tsx 견적 생성 폼: 품목 행 추가/삭제 UI 필요 (quoteItems state 배열)
 *  - PDF 미리보기: 품목 테이블이 추가되면 자동 반영 (HTML 템플릿 확장)
 *  - 예상 공수: 중간 (폼 UI + API 연동 + PDF 품목 테이블 렌더링)
 *
 * [products 연결 방향]
 *  - product_id: integer FK → products.id (옵셔널: 직접 입력도 허용)
 *  - 연결 시 product.name → product_name 자동 채움, product.basePrice → unit_price 기본값
 *  - product.unit → unit 컬럼 기본값으로 활용
 *  - language_pair, field 메타는 quote_items에는 복사하지 않음 (products 에서 참조)
 *
 * ──────────────────────────────────────────────────────────
 */

import {
  pgTable, serial, integer, numeric, text, timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
// import { quotesTable } from "./quotes";    // 실제 파일로 이동 시 주석 해제
// import { productsTable } from "./products"; // 옵셔널 FK

export const quoteItemsTable = pgTable("quote_items", {
  id: serial("id").primaryKey(),

  /** FK → quotes.id */
  quoteId: integer("quote_id")
    .notNull(),
    // .references(() => quotesTable.id, { onDelete: "cascade" }),

  /** 선택적 상품 마스터 연결 (없으면 직접 입력) */
  productId: integer("product_id"),
    // .references(() => productsTable.id, { onDelete: "set null" }),

  /** 품목명 (product.name 자동 채움 또는 직접 입력) */
  productName: text("product_name").notNull(),

  /** 단위 (건, 페이지, 시간 …) */
  unit: text("unit").notNull().default("건"),

  /** 수량 */
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),

  /** 단가 */
  unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).notNull(),

  /**
   * 공급가액 = quantity × unit_price
   * 애플리케이션에서 계산 후 저장; DB 계산 컬럼으로 변경 가능
   */
  supplyAmount: numeric("supply_amount", { precision: 14, scale: 2 }).notNull(),

  /**
   * 세액 (부가가치세 10%)
   * 기본값 0; 향후 과세/면세 구분 컬럼 추가 시 자동화 가능
   */
  taxAmount: numeric("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),

  /**
   * 합계 = supply_amount + tax_amount
   */
  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),

  /** 품목 메모 (선택) */
  memo: text("memo"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertQuoteItemSchema = createInsertSchema(quoteItemsTable).omit({
  id: true,
  createdAt: true,
  supplyAmount: true,
  taxAmount: true,
  totalAmount: true,
});

export type InsertQuoteItem = z.infer<typeof insertQuoteItemSchema>;
export type QuoteItem = typeof quoteItemsTable.$inferSelect;

/**
 * 공급가액·세액·합계 자동 계산 헬퍼 (서비스 레이어에서 사용)
 *
 * @param quantity  수량
 * @param unitPrice 단가
 * @param taxRate   세율 (기본 0 — 면세; 과세는 0.1)
 */
export function calcQuoteItemAmounts(
  quantity: number,
  unitPrice: number,
  taxRate: 0 | 0.1 = 0,
) {
  const supply = Math.round(quantity * unitPrice);
  const tax = Math.round(supply * taxRate);
  return { supplyAmount: supply, taxAmount: tax, totalAmount: supply + tax };
}
