import { pgTable, serial, integer, text, boolean, timestamp, pgEnum, primaryKey, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// staff_only(직원전용, 2026-11-22): 관리자(role=admin)만 등록·수정·삭제, 지정된 직원(board_post_targets)만 조회·다운로드.
export const boardCategoryEnum = pgEnum("board_category", ["notice", "reference", "manual", "other", "staff_only"]);

export const boardPostsTable = pgTable("board_posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id")
    .notNull()
    .references(() => usersTable.id),
  category: boardCategoryEnum("category").notNull().default("notice"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  pinned: boolean("pinned").notNull().default(false),
  visibleToAll: boolean("visible_to_all").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BoardPost = typeof boardPostsTable.$inferSelect;
export type InsertBoardPost = typeof boardPostsTable.$inferInsert;

// ─── 직원전용 게시글 대상 직원(2026-11-22) — 게시글 1 : 직원 계정 N ───────────────────
//  직원은 여기 지정된 글만 목록·상세·첨부 다운로드 가능(API 서버에서 차단). 게시글 삭제 시 함께 삭제.
export const boardPostTargetsTable = pgTable("board_post_targets", {
  postId: integer("post_id").notNull().references(() => boardPostsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.postId, t.userId] }),
  idxUser: index("idx_board_post_targets_user").on(t.userId),
}));

// ─── 게시글 첨부파일(2026-11-22) — 파일 실체는 R2(board-private/…), 이 표는 메타데이터만 ─────────
//  범용 /storage/objects 경로에서는 board-private/ 를 차단하고, 권한 확인 다운로드 API 로만 제공한다.
export const boardPostFilesTable = pgTable("board_post_files", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => boardPostsTable.id, { onDelete: "cascade" }),
  originalFileName: text("original_file_name").notNull(),
  filePath: text("file_path").notNull(),        // R2 key (board-private/{postId}/{uuid})
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
}, (t) => ({
  idxPost: index("idx_board_post_files_post").on(t.postId),
}));

export type BoardPostFile = typeof boardPostFilesTable.$inferSelect;
