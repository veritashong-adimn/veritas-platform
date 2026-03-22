import { Router, type IRouter } from "express";
import { db, projectsTable, insertProjectSchema } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logEvent } from "../lib/logEvent";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

router.post(
  "/projects",
  requireAuth,
  requireRole("customer", "admin"),
  async (req, res) => {
    const { fileUrl, ...rest } = req.body as { fileUrl?: string; [key: string]: unknown };
    const body = { ...rest, userId: req.user!.id };
    const parsed = insertProjectSchema.omit({ fileUrl: true }).safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    if (fileUrl !== undefined && typeof fileUrl !== "string") {
      res.status(400).json({ error: "fileUrl은 문자열이어야 합니다." });
      return;
    }

    try {
      const [project] = await db
        .insert(projectsTable)
        .values({ ...parsed.data, fileUrl: fileUrl ?? null })
        .returning();
      await logEvent("project", project.id, "project_created", req.log);
      res.status(201).json(project);
    } catch (err) {
      req.log.error({ err }, "Failed to create project");
      res.status(400).json({ error: "프로젝트 생성 실패." });
    }
  },
);

router.get("/projects", async (req, res) => {
  try {
    const { userId } = req.query as { userId?: string };
    let query = db.select().from(projectsTable).$dynamic();
    if (userId) {
      const id = Number(userId);
      if (!isNaN(id)) query = query.where(eq(projectsTable.userId, id));
    }
    res.json(await query);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch projects");
    res.status(500).json({ error: "프로젝트 조회 실패." });
  }
});

export default router;
