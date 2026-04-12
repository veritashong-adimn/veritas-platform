import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middlewares/auth";
import { getPermissionsForRole, ALL_PERMISSIONS } from "../lib/rbac";

const router: IRouter = Router();

/** 사용자의 권한 목록을 반환 (admin + roleId 없음 → 전체 권한) */
async function resolvePermissions(user: { role: string; roleId?: number | null }): Promise<string[]> {
  if (user.role === "admin" && !user.roleId) {
    return ALL_PERMISSIONS.map(p => p.key);
  }
  if (!user.roleId) return [];
  const perms = await getPermissionsForRole(user.roleId);
  return Array.from(perms);
}

router.post("/auth/register", async (req, res) => {
  const { email: rawEmail, password, role, name } = req.body as {
    email?: string;
    password?: string;
    role?: string;
    name?: string;
  };

  if (!rawEmail || !password) {
    res.status(400).json({ error: "email과 password는 필수입니다." });
    return;
  }

  const email = rawEmail.trim().toLowerCase();

  if (password.length < 6) {
    res.status(400).json({ error: "비밀번호는 최소 6자 이상이어야 합니다." });
    return;
  }

  const allowedRoles = ["client", "linguist", "customer", "translator"] as const;
  type AllowedRole = typeof allowedRoles[number];
  if (role !== undefined && !allowedRoles.includes(role as AllowedRole)) {
    res.status(400).json({ error: "role은 'client', 'linguist', 'customer', 'translator'만 허용됩니다." });
    return;
  }
  const userRole: AllowedRole = allowedRoles.includes(role as AllowedRole) ? (role as AllowedRole) : "client";

  const hashed = await bcrypt.hash(password, 10);

  try {
    const [user] = await db
      .insert(usersTable)
      .values({ email, password: hashed, role: userRole, name: name?.trim() || null })
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role, name: usersTable.name, roleId: usersTable.roleId });

    const token = signToken({ id: user.id, email: user.email, role: user.role, roleId: user.roleId });
    const permissions = await resolvePermissions(user);
    res.status(201).json({ token, user: { ...user, permissions } });
  } catch (err) {
    req.log.error({ err }, "Register failed");
    res.status(400).json({ error: "이미 사용 중인 이메일입니다." });
  }
});

router.post("/auth/login", async (req, res) => {
  const { email: rawEmail, password } = req.body as { email?: string; password?: string };

  if (!rawEmail || !password) {
    res.status(400).json({ error: "email과 password는 필수입니다." });
    return;
  }

  const email = rawEmail.trim().toLowerCase();

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  if (!user) {
    req.log.warn({ email }, "Login failed: user not found");
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  if (!user.password) {
    req.log.warn({ email }, "Login failed: no password set (OAuth account?)");
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  if (!user.isActive) {
    req.log.warn({ email, userId: user.id }, "Login failed: account deactivated");
    res.status(403).json({ error: "비활성화된 계정입니다. 관리자에게 문의하세요." });
    return;
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    req.log.warn({ email, userId: user.id }, "Login failed: password mismatch");
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  req.log.info({ email, userId: user.id, role: user.role }, "Login success");
  const token = signToken({ id: user.id, email: user.email, role: user.role, roleId: user.roleId });
  const permissions = await resolvePermissions(user);

  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, name: user.name, roleId: user.roleId, permissions },
  });
});

/** 현재 로그인 사용자의 권한 목록 재조회 */
router.get("/auth/permissions", requireAuth, async (req, res) => {
  const user = req.user!;
  const permissions = await resolvePermissions(user);
  res.json({ permissions });
});

router.patch("/auth/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "현재 비밀번호와 새 비밀번호를 모두 입력해주세요." });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ error: "새 비밀번호는 최소 6자 이상이어야 합니다." });
    return;
  }
  if (currentPassword === newPassword) {
    res.status(400).json({ error: "현재 비밀번호와 새 비밀번호가 동일합니다." });
    return;
  }

  const userId = (req as any).user?.id as number;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user || !user.password) {
    res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
    return;
  }

  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) {
    res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
    return;
  }

  const hashed = await bcrypt.hash(newPassword, 10);

  await db
    .update(usersTable)
    .set({ password: hashed })
    .where(eq(usersTable.id, userId));

  req.log.info({ userId }, "Password changed");
  res.json({ ok: true });
});

export default router;
