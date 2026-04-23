import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { quoteItemsTable } from "./quote_items";

// ── 견적 항목별 첨부 파일 ────────────────────────────────────────────────────
// 번역 항목에 첨부된 원본 파일 (계약서, 스펙 문서 등)
export const quoteItemFilesTable = pgTable("quote_item_files", {
  id: serial("id").primaryKey(),
  quoteItemId: integer("quote_item_id")
    .notNull()
    .references(() => quoteItemsTable.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileUrl: text("file_url").notNull(),
  fileSize: integer("file_size"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type QuoteItemFile = typeof quoteItemFilesTable.$inferSelect;
