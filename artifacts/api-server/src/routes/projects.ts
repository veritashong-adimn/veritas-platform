import { Router, type IRouter } from "express";
import { db, projectsTable, insertProjectSchema } from "@workspace/db";

const router: IRouter = Router();

router.post("/projects", async (req, res) => {
  const parsed = insertProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const [project] = await db.insert(projectsTable).values(parsed.data).returning();
    res.status(201).json(project);
  } catch (err) {
    req.log.error({ err }, "Failed to create project");
    res.status(400).json({ error: "Failed to create project." });
  }
});

router.get("/projects", async (req, res) => {
  try {
    const projects = await db.select().from(projectsTable);
    res.json(projects);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch projects");
    res.status(500).json({ error: "Failed to fetch projects." });
  }
});

export default router;
