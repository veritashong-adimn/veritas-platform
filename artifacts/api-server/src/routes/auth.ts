import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken } from "../middlewares/auth";

const router: IRouter = Router();

router.post("/auth/register", async (req, res) => {
  const { email, password, role } = req.body as {
    email?: string;
    password?: string;
    role?: string;
  };

  if (!email || !password) {
    res.status(400).json({ error: "email과 password는 필수입니다." });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "비밀번호는 최소 6자 이상이어야 합니다." });
    return;
  }

  const allowedRoles = ["customer", "translator"] as const;
  type AllowedRole = typeof allowedRoles[number];
  if (role !== undefined && !allowedRoles.includes(role as AllowedRole)) {
    res.status(400).json({ error: "role은 'customer' 또는 'translator'만 허용됩니다." });
    return;
  }
  const userRole: AllowedRole = allowedRoles.includes(role as AllowedRole) ? (role as AllowedRole) : "customer";

  const hashed = await bcrypt.hash(password, 10);

  try {
    const [user] = await db
      .insert(usersTable)
      .values({ email, password: hashed, role: userRole })
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role });

    const token = signToken({ id: user.id, email: user.email, role: user.role });
    res.status(201).json({ token, user });
  } catch (err) {
    req.log.error({ err }, "Register failed");
    res.status(400).json({ error: "이미 사용 중인 이메일입니다." });
  }
});

router.post("/auth/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: "email과 password는 필수입니다." });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  if (!user || !user.password) {
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  const token = signToken({ id: user.id, email: user.email, role: user.role });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

export default router;
