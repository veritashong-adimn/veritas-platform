import { pgTable, serial, integer, unique } from "drizzle-orm/pg-core";
import { rolesTable } from "./roles";
import { permissionsTable } from "./permissions";

export const rolePermissionsTable = pgTable("role_permissions", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").notNull().references(() => rolesTable.id, { onDelete: "cascade" }),
  permissionId: integer("permission_id").notNull().references(() => permissionsTable.id, { onDelete: "cascade" }),
}, (t) => [unique().on(t.roleId, t.permissionId)]);

export type RolePermission = typeof rolePermissionsTable.$inferSelect;
