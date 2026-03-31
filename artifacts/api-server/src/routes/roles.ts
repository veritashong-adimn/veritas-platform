import { Router, type IRouter } from "express";
import { db, rolesTable, permissionsTable, rolePermissionsTable, usersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { ALL_PERMISSIONS, invalidatePermCache, getPermissionsForRole } from "../lib/rbac";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

// ─── 전체 권한 목록 ───────────────────────────────────────────────────────────
router.get("/admin/permissions", ...adminGuard, async (_req, res) => {
  res.json(ALL_PERMISSIONS);
});

// ─── 역할 목록 ───────────────────────────────────────────────────────────────
router.get("/admin/roles", ...adminGuard, async (_req, res) => {
  try {
    const roles = await db.select().from(rolesTable).orderBy(rolesTable.id);
    const rpRows = await db.select().from(rolePermissionsTable);
    const permMap = new Map<number, number[]>();
    for (const rp of rpRows) {
      if (!permMap.has(rp.roleId)) permMap.set(rp.roleId, []);
      permMap.get(rp.roleId)!.push(rp.permissionId);
    }

    const allPerms = await db.select().from(permissionsTable);
    const permById = new Map(allPerms.map(p => [p.id, p.key]));

    const result = roles.map(r => ({
      ...r,
      permissionCount: (permMap.get(r.id) ?? []).length,
      permissions: (permMap.get(r.id) ?? []).map(pid => permById.get(pid)).filter(Boolean),
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "역할 목록 조회 실패" });
  }
});

// ─── 역할 생성 ───────────────────────────────────────────────────────────────
router.post("/admin/roles", ...adminGuard, async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) { res.status(400).json({ error: "역할명은 필수입니다." }); return; }

  try {
    const [role] = await db.insert(rolesTable).values({
      name: name.trim(),
      description: description?.trim() || null,
      isSystem: false,
    }).returning();
    res.status(201).json(role);
  } catch {
    res.status(400).json({ error: "이미 존재하는 역할명입니다." });
  }
});

// ─── 역할 수정 ───────────────────────────────────────────────────────────────
router.patch("/admin/roles/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const { name, description } = req.body as { name?: string; description?: string };

  try {
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, id)).limit(1);
    if (!role) { res.status(404).json({ error: "역할을 찾을 수 없습니다." }); return; }
    if (role.isSystem && name && name.trim() !== role.name) {
      res.status(400).json({ error: "시스템 역할의 이름은 변경할 수 없습니다." }); return;
    }

    const updates: Partial<typeof rolesTable.$inferInsert> = {};
    if (name?.trim()) updates.name = name.trim();
    if (description !== undefined) updates.description = description?.trim() || null;

    const [updated] = await db.update(rolesTable).set(updates).where(eq(rolesTable.id, id)).returning();
    res.json(updated);
  } catch {
    res.status(500).json({ error: "역할 수정 실패" });
  }
});

// ─── 역할 삭제 ───────────────────────────────────────────────────────────────
router.delete("/admin/roles/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, id)).limit(1);
    if (!role) { res.status(404).json({ error: "역할을 찾을 수 없습니다." }); return; }
    if (role.isSystem) { res.status(400).json({ error: "시스템 역할은 삭제할 수 없습니다." }); return; }

    // 해당 역할 사용 중인 사용자 확인
    const users = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.roleId, id));
    if (users.length > 0) {
      res.status(400).json({ error: `${users.length}명의 사용자가 이 역할을 사용 중입니다.` }); return;
    }

    await db.delete(rolesTable).where(eq(rolesTable.id, id));
    invalidatePermCache(id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "역할 삭제 실패" });
  }
});

// ─── 역할별 권한 조회 ─────────────────────────────────────────────────────────
router.get("/admin/roles/:id/permissions", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const perms = await getPermissionsForRole(id);
    res.json(Array.from(perms));
  } catch {
    res.status(500).json({ error: "권한 조회 실패" });
  }
});

// ─── 역할 권한 일괄 설정 (PUT) ───────────────────────────────────────────────
router.put("/admin/roles/:id/permissions", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const { keys } = req.body as { keys: string[] };

  if (!Array.isArray(keys)) { res.status(400).json({ error: "keys 배열 필요" }); return; }

  try {
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, id)).limit(1);
    if (!role) { res.status(404).json({ error: "역할을 찾을 수 없습니다." }); return; }

    // key → id 매핑
    const perms = keys.length > 0
      ? await db.select({ id: permissionsTable.id, key: permissionsTable.key })
          .from(permissionsTable)
          .where(inArray(permissionsTable.key, keys))
      : [];
    const permIds = perms.map(p => p.id);

    // 기존 삭제 후 재삽입
    await db.delete(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, id));
    if (permIds.length > 0) {
      await db.insert(rolePermissionsTable).values(
        permIds.map(permissionId => ({ roleId: id, permissionId }))
      );
    }

    invalidatePermCache(id);
    res.json({ ok: true, count: permIds.length });
  } catch {
    res.status(500).json({ error: "권한 설정 실패" });
  }
});

// ─── 사용자에게 역할 지정 ─────────────────────────────────────────────────────
router.patch("/admin/users/:id/rbac-role", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  const { roleId } = req.body as { roleId: number | null };

  try {
    const [updated] = await db
      .update(usersTable)
      .set({ roleId: roleId ?? null })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, roleId: usersTable.roleId });
    if (!updated) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    res.json(updated);
  } catch {
    res.status(500).json({ error: "역할 지정 실패" });
  }
});

export default router;
