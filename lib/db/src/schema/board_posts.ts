import { pgTable, serial, integer, text, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const boardCategoryEnum = pgEnum("board_category", ["notice", "reference", "manual"]);

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
