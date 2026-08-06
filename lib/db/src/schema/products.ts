import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * 다국어 릴레이 통역 언어 구성.
 * - sourceLanguage: 출발언어
 * - pivotLanguage:  기준언어(중계/Pivot) — products.targetLanguage 컬럼과 동일 값으로 유지(하위호환)
 * - targetLanguages: 대상언어 배열(표시 순서 보존). canonicalKey는 알파벳 정렬본으로 생성됨.
 */
export type RelayLanguages = {
  sourceLanguage: string;
  pivotLanguage: string;
  targetLanguages: string[];
};

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  productType: text("product_type").notNull().default("translation"),
  sourceLanguage: text("source_language"),
  targetLanguage: text("target_language"),
  languagePair: text("language_pair"),
  mainCategory: text("main_category"),
  subCategory: text("sub_category"),
  category: text("category"),
  field: text("field"),
  unit: text("unit").notNull().default("건"),
  basePrice: integer("base_price"),
  description: text("description"),
  interpretationDuration: text("interpretation_duration"),
  overtimePrice: integer("overtime_price"),
  quantityUnit: text("quantity_unit"),
  usagePeriod: text("usage_period"),
  interpretationDirection: text("interpretation_direction"),
  active: boolean("active").notNull().default(true),
  deactivationReason: text("deactivation_reason"),
  canonicalKey: text("canonical_key"),
  relayLanguages: jsonb("relay_languages").$type<RelayLanguages>(),
  // 원어민감수 언어 방식: "single"=감수언어 1개(reviewLanguage), "pair"=출발/도착(sourceLanguage/targetLanguage).
  // 그 외 상품은 null. 단일언어를 source=target 동일값으로 우회 저장하지 않는다.
  reviewLanguageMode: text("review_language_mode"),
  reviewLanguage: text("review_language"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),
});

export type Product = typeof productsTable.$inferSelect;
export type InsertProduct = typeof productsTable.$inferInsert;
