import { pgTable, serial, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

export const taskStatusEnum = pgEnum("task_status", ["waiting", "assigned", "working", "done"]);

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id),
  translatorId: integer("translator_id")
    .notNull()
    .references(() => usersTable.id),
  status: taskStatusEnum("status").notNull().default("waiting"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Task = typeof tasksTable.$inferSelect;
