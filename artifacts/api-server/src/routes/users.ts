import { Router, type IRouter } from "express";
import { db, usersTable, insertUserSchema } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";

const router: IRouter = Router();

// 보안: 기존에는 인증 없이 열려 있어 비밀번호 해시·초대토큰이 노출되고 임의 계정 생성이 가능했다.
//   관리자 + user.manage 권한으로 제한하고, 응답에서 인증정보(password·inviteToken)를 제외한다.
//   (프론트엔드 미사용 엔드포인트 — 경로·응답의 나머지 필드는 유지)
const guard = [requireAuth, requireRole("admin"), requirePermission("user.manage")];
const withoutSecrets = <T extends { password?: unknown; inviteToken?: unknown }>(u: T) => {
  const { password: _p, inviteToken: _t, ...rest } = u;
  return rest;
};

router.post("/users", ...guard, async (req, res) => {
  const parsed = insertUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const [user] = await db.insert(usersTable).values(parsed.data).returning();
    res.status(201).json(withoutSecrets(user));
  } catch (err) {
    req.log.error({ err }, "Failed to create user");
    res.status(400).json({ error: "Failed to create user. Email may already exist." });
  }
});

router.get("/users/:id", ...guard, async (req, res) => {
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

  res.json(withoutSecrets(user));
});

export default router;
