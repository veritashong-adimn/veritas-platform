import { pgTable, serial, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { legacyArchiveRowsTable } from "./legacy_archive_rows";

// ─── (C-4J-2C-6) 과거 CRM 판매목록 ↔ 진행관리표 연결 매핑 ─────────────────────────
// 역할: legacy_archive_rows(sales_list) 1건과 legacy_archive_rows(progress) 수행행들을 연결한다.
//   · 원본(legacy_archive_rows)은 절대 수정/병합/삭제하지 않는다 — 연결은 이 별도 매핑 테이블로만 표현.
//   · 하나의 판매건(sale_row_id)에 여러 수행행(progress_row_id) 연결 허용(1:N).
//   · 멱등: UNIQUE(sale_row_id, progress_row_id) + ON CONFLICT DO NOTHING → 재실행해도 중복 매핑 없음.
//   · 연결은 "확정(A)"만 저장한다. 모호(B)/연결정보부족(C)은 저장하지 않고 개별 판매건으로 보존(미연결).
//   · 연결 근거 보존: match_key(연결 키 값), match_method(판정 방식), sale_no(판매번호 원본).
//   · 서로 다른 판매번호를 합치지 않는다 — sale_row_id 는 판매건 단위이며 병합 개념이 없다.
export const legacySalesProgressLinksTable = pgTable("legacy_sales_progress_links", {
  id: serial("id").primaryKey(),
  // 판매목록 행(legacy_archive_rows.id, source_type='sales_list'). 원본 보존 → ON DELETE CASCADE(원본 삭제 시 매핑만 정리).
  saleRowId: integer("sale_row_id").notNull().references(() => legacyArchiveRowsTable.id, { onDelete: "cascade" }),
  // 진행관리 수행행(legacy_archive_rows.id, source_type='progress').
  progressRowId: integer("progress_row_id").notNull().references(() => legacyArchiveRowsTable.id, { onDelete: "cascade" }),
  saleNo: text("sale_no"),                       // 판매번호 원본(근거 보존, 식별자 아님)
  matchKey: text("match_key"),                   // 연결 키 값 (거래처|상품|총액|판매일 등, 축약 시 결측필드 ∅ 표기)
  matchMethod: text("match_method").notNull(),   // full_key_v1 | reduced_co_amt_date_v1 | reduced_prod_amt_date_v1
  decision: text("decision").notNull().default("confirmed"),  // confirmed(A) 만 저장
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  uqSaleProgress: uniqueIndex("uq_legacy_sp_links_sale_progress").on(t.saleRowId, t.progressRowId),
  idxSale: index("idx_legacy_sp_links_sale").on(t.saleRowId),
  idxProgress: index("idx_legacy_sp_links_progress").on(t.progressRowId),
}));

export type LegacySalesProgressLink = typeof legacySalesProgressLinksTable.$inferSelect;
export type InsertLegacySalesProgressLink = typeof legacySalesProgressLinksTable.$inferInsert;
