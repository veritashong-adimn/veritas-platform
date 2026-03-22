import { Router, type IRouter } from "express";
import { db, logsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/logs", async (req, res) => {
  try {
    const { entityType, entityId } = req.query as {
      entityType?: "project" | "quote" | "task";
      entityId?: string;
    };

    let query = db.select().from(logsTable).$dynamic();

    if (entityType) {
      query = query.where(eq(logsTable.entityType, entityType));
    }

    if (entityId) {
      const id = Number(entityId);
      if (!isNaN(id)) {
        query = query.where(eq(logsTable.entityId, id));
      }
    }

    const logs = await query.orderBy(desc(logsTable.createdAt));
    res.json(logs);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch logs");
    res.status(500).json({ error: "Failed to fetch logs." });
  }
});

export default router;
