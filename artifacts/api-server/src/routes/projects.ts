import { Router, type IRouter } from "express";
import { db, projectsTable, insertProjectSchema } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();

router.post("/projects", async (req, res) => {
  const parsed = insertProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const [project] = await db.insert(projectsTable).values(parsed.data).returning();
    await logEvent("project", project.id, "project_created", req.log);
    res.status(201).json(project);
  } catch (err) {
    req.log.error({ err }, "Failed to create project");
    res.status(400).json({ error: "Failed to create project." });
  }
});

router.get("/projects", async (req, res) => {
  try {
    const { userId } = req.query as { userId?: string };

    let query = db.select().from(projectsTable).$dynamic();

    if (userId) {
      const id = Number(userId);
      if (!isNaN(id)) {
        query = query.where(eq(projectsTable.userId, id));
      }
    }

    const projects = await query;
    res.json(projects);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch projects");
    res.status(500).json({ error: "Failed to fetch projects." });
  }
});

export default router;
