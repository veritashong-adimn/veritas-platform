import { pgTable, serial, text, timestamp, pgEnum, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rolesTable } from "./roles";

export const userRoleEnum = pgEnum("user_role", [
  "customer",   // legacy (= client)
  "translator", // legacy (= linguist)
  "admin",
  "staff",
  "client",
  "linguist",
]);

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  password: text("password"),
  name: text("name"),
  role: userRoleEnum("role").notNull().default("client"),
  roleId: integer("role_id").references(() => rolesTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  department: text("department"),
  jobTitle: text("job_title"),
  companyId: integer("company_id"),
  lastLoginAt: timestamp("last_login_at"),
  lastActivityAt: timestamp("last_activity_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
