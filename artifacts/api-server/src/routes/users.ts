import { Router, type IRouter } from "express";
import { db, usersTable, insertUserSchema } from "@workspace/db";
import { eq } from "drizzle-orm";

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

router.get("/users/:id", async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "Invalid user id." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) {
    res.status(404).json({ error: `User with id ${userId} not found.` });
    return;
  }

  res.json(user);
});

export default router;
