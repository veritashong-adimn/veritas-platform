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
  inviteToken: text("invite_token"),
  department: text("department"),
  jobTitle: text("job_title"),
  phone: text("phone"),                      // 연락처(사용자 상세정보에서 관리자가 수정, nullable)
  companyId: integer("company_id"),
  lastLoginAt: timestamp("last_login_at"),
  lastActivityAt: timestamp("last_activity_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // ── Soft Delete (휴지통) ────────────────────────────────────
  // 물리 삭제하지 않고 목록·검색·로그인에서만 제외한다(레코드·업무 FK 이력 모두 보존).
  // 거래처(companies)·견적(quotes)과 동일한 패턴. isActive(활성/비활성)와는 별개 개념이다.
  // 복구 시 세 필드를 NULL 로 초기화하며 isActive 는 건드리지 않는다(활성상태 별도 관리).
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),          // 삭제 처리 관리자 id
  deletionReason: text("deletion_reason"),   // 삭제 사유(선택)
  // ── 비밀번호 보안(추가 컬럼, 기존 행 영향 없음) ─────────────────
  // passwordChangedAt: 본인 비밀번호 변경 시각 — 이 시각 이전에 발급된 토큰은 거부(기존 세션 무효화). NULL = 변경 이력 없음.
  // mustChangePassword: 관리자가 임시 비밀번호를 발급한 계정 — 로그인 후 비밀번호 변경 전까지 다른 기능 사용 불가. 기존 계정은 false.
  passwordChangedAt: timestamp("password_changed_at"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
