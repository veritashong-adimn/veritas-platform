import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const productRequestsTable = pgTable("product_requests", {
  id: serial("id").primaryKey(),
  serviceType: text("service_type").notNull().default(""),
  languagePair: text("language_pair").notNull().default(""),
  category: text("category").notNull().default(""),
  productType: text("product_type").notNull().default("translation"),
  sourceLanguage: text("source_language"),
  targetLanguage: text("target_language"),
  mainCategory: text("main_category"),
  subCategory: text("sub_category"),
  name: text("name").notNull(),
  unit: text("unit").notNull().default("건"),
  description: text("description"),
  status: text("status").notNull().default("pending"),
  requestedBy: integer("requested_by").references(() => usersTable.id),
  requestedByEmail: text("requested_by_email"),
  approvedBy: integer("approved_by").references(() => usersTable.id),
  approvedByEmail: text("approved_by_email"),
  approvedProductId: integer("approved_product_id"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProductRequest = typeof productRequestsTable.$inferSelect;
export type InsertProductRequest = typeof productRequestsTable.$inferInsert;
