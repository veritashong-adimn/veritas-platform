import { Router, type IRouter } from "express";
import { db, tasksTable, projectsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();

router.post("/projects/:id/match", async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "Invalid project id." });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) {
    res.status(404).json({ error: `Project with id ${projectId} not found.` });
    return;
  }

  if (project.status !== "approved") {
    res.status(400).json({ error: `Project must be in "approved" status to be matched. Current status: "${project.status}".` });
    return;
  }

  const existingTask = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.projectId, projectId));

  if (existingTask.length > 0) {
    res.status(400).json({ error: "Project is already matched to a translator." });
    return;
  }

  const translators = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.role, "translator"));

  if (translators.length === 0) {
    res.status(404).json({ error: "No translators available." });
    return;
  }

  const randomTranslator = translators[Math.floor(Math.random() * translators.length)];

  try {
    const result = await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(tasksTable)
        .values({ projectId, translatorId: randomTranslator.id })
        .returning();

      await tx
        .update(projectsTable)
        .set({ status: "matched" })
        .where(eq(projectsTable.id, projectId));

      return task;
    });

    await logEvent("project", projectId, "project_matched", req.log);
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to match project");
    res.status(500).json({ error: "Failed to match project." });
  }
});

router.patch("/tasks/:id/start", async (req, res) => {
  const taskId = Number(req.params.id);
  if (isNaN(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id." });
    return;
  }

  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId));

  if (!task) {
    res.status(404).json({ error: `Task with id ${taskId} not found.` });
    return;
  }

  if (task.status === "working" || task.status === "done") {
    res.status(400).json({ error: `Task is already in "${task.status}" status.` });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tasksTable)
        .set({ status: "working" })
        .where(eq(tasksTable.id, taskId))
        .returning();

      await tx
        .update(projectsTable)
        .set({ status: "in_progress" })
        .where(eq(projectsTable.id, task.projectId));

      return updated;
    });

    await logEvent("task", taskId, "task_started", req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to start task");
    res.status(500).json({ error: "Failed to start task." });
  }
});

router.patch("/tasks/:id/complete", async (req, res) => {
  const taskId = Number(req.params.id);
  if (isNaN(taskId) || taskId <= 0) {
    res.status(400).json({ error: "Invalid task id." });
    return;
  }

  const [task] = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId));

  if (!task) {
    res.status(404).json({ error: `Task with id ${taskId} not found.` });
    return;
  }

  if (task.status === "done") {
    res.status(400).json({ error: "Task is already completed." });
    return;
  }

  if (task.status !== "working") {
    res.status(400).json({ error: `Task must be in "working" status to complete. Current status: "${task.status}".` });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(tasksTable)
        .set({ status: "done" })
        .where(eq(tasksTable.id, taskId))
        .returning();

      await tx
        .update(projectsTable)
        .set({ status: "completed" })
        .where(eq(projectsTable.id, task.projectId));

      return updated;
    });

    await logEvent("task", taskId, "task_completed", req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to complete task");
    res.status(500).json({ error: "Failed to complete task." });
  }
});

export default router;
