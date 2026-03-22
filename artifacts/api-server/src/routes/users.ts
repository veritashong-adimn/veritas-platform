import { Router, type IRouter } from "express";
import { db, usersTable, insertUserSchema } from "@workspace/db";

const router: IRouter = Router();

router.post("/users", async (req, res) => {
  const parsed = insertUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const [user] = await db.insert(usersTable).values(parsed.data).returning();
    res.status(201).json(user);
  } catch (err) {
    req.log.error({ err }, "Failed to create user");
    res.status(400).json({ error: "Failed to create user. Email may already exist." });
  }
});

export default router;
