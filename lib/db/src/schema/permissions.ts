import { pgTable, serial, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const permissionCategoryEnum = pgEnum("permission_category", ["menu", "action"]);

export const permissionsTable = pgTable("permissions", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  category: permissionCategoryEnum("category").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Permission = typeof permissionsTable.$inferSelect;
