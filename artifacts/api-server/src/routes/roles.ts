import { Router, type IRouter } from "express";
import { db, rolesTable, permissionsTable, rolePermissionsTable, usersTable, importBatchesTable, importRowSourcesTable } from "@workspace/db";
import { eq, inArray, sql, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { ALL_PERMISSIONS, PERM_GROUPS, PERM_META, invalidatePermCache, getPermissionsForRole } from "../lib/rbac";

const router: IRouter = Router();
// 조회: 관리자·직원(역할관리 메뉴 권한자) / 변경(역할 생성·수정·삭제·권한 저장·사용자 역할 지정): 관리자만.
//   (2026-11-08 보안 정비) 이전에는 직원도 변경 API 를 호출할 수 있어 스스로 권한을 올릴 수 있었다.
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const adminOnly = [requireAuth, requireRole("admin")];

// 권한 변경 감사 이력 — 기존 이력 테이블(import_batches module='rbac_audit' + import_row_sources)에 변경 전·후를 남긴다(스키마 변경 없음).
async function auditRbac(req: any, action: string, target: Record<string, unknown>, before: unknown, after: unknown) {
  try {
    const [b] = await db.insert(importBatchesTable).values({
      module: "rbac_audit", importType: action, originalFilename: null, totalRows: 1, successRows: 1, status: "completed",
      createdBy: req.user?.id ?? null, isCurrent: false,
    }).returning({ id: importBatchesTable.id });
    await db.insert(importRowSourcesTable).values({
      batchId: b.id, module: "rbac_audit", rowKey: action, status: "rbac_audit",
      sourceRaw: { action, target, before, after, by: { id: req.user?.id ?? null, email: req.user?.email ?? null }, at: new Date().toISOString() },
    });
  } catch (err) { req.log?.error?.({ err, action }, "rbac audit write failed"); }
}

// ─── 전체 권한 목록 ───────────────────────────────────────────────────────────
//   배열 형태(기존 응답) 유지 + 항목별 group/deprecated/enforce 메타 추가. ?groups=1 이면 { groups, permissions }.
router.get("/admin/permissions", ...adminGuard, async (req, res) => {
  const list = ALL_PERMISSIONS.map(({ grantFrom: _g, ...p }) => p);
  if (req.query.groups === "1") { res.json({ groups: PERM_GROUPS, permissions: list }); return; }
  res.json(list);
});

// ─── 권한 변경 감사 이력(최근) ───────────────────────────────────────────────
router.get("/admin/roles/audit", ...adminOnly, async (_req, res) => {
  try {
    const rows = (await db.execute(sql`SELECT s.id, s.source_raw, s.created_at FROM import_row_sources s
      WHERE s.module = 'rbac_audit' ORDER BY s.id DESC LIMIT 100`)).rows;
    res.json(rows);
  } catch { res.status(500).json({ error: "권한 변경 이력 조회 실패" }); }
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
router.post("/admin/roles", ...adminOnly, async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) { res.status(400).json({ error: "역할명은 필수입니다." }); return; }

  try {
    const [role] = await db.insert(rolesTable).values({
      name: name.trim(),
      description: description?.trim() || null,
      isSystem: false,
    }).returning();
    await auditRbac(req, "role_create", { roleId: role.id, name: role.name }, null, { name: role.name, description: role.description });
    res.status(201).json(role);
  } catch {
    res.status(400).json({ error: "이미 존재하는 역할명입니다." });
  }
});

// ─── 역할 수정 ───────────────────────────────────────────────────────────────
router.patch("/admin/roles/:id", ...adminOnly, async (req, res) => {
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
    await auditRbac(req, "role_update", { roleId: id }, { name: role.name, description: role.description }, { name: updated.name, description: updated.description });
    res.json(updated);
  } catch {
    res.status(500).json({ error: "역할 수정 실패" });
  }
});

// ─── 역할 삭제 ───────────────────────────────────────────────────────────────
router.delete("/admin/roles/:id", ...adminOnly, async (req, res) => {
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

    const beforeKeys = [...await getPermissionsForRole(id)];
    await db.delete(rolesTable).where(eq(rolesTable.id, id));
    invalidatePermCache(id);
    await auditRbac(req, "role_delete", { roleId: id, name: role.name }, { permissions: beforeKeys }, null);
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
router.put("/admin/roles/:id/permissions", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const { keys } = req.body as { keys: string[] };

  if (!Array.isArray(keys)) { res.status(400).json({ error: "keys 배열 필요" }); return; }

  try {
    const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, id)).limit(1);
    if (!role) { res.status(404).json({ error: "역할을 찾을 수 없습니다." }); return; }

    // 화면에서 다루는 권한만 교체한다. 숨김(미사용) 권한·코드에 정의되지 않은 권한의 기존 연결은 그대로 보존
    //   (화면에 없다는 이유로 저장 시 지워지지 않게). 알 수 없는 키·숨김 키는 요청에 있어도 추가하지 않는다.
    const editable = new Set(ALL_PERMISSIONS.filter(p => !p.deprecated).map(p => p.key));
    const wanted = [...new Set(keys.filter(k => editable.has(k)))];
    const beforeKeys = [...await getPermissionsForRole(id)];
    const allPerms = await db.select({ id: permissionsTable.id, key: permissionsTable.key }).from(permissionsTable);
    const editableIds = allPerms.filter(p => editable.has(p.key)).map(p => p.id);
    const permIds = allPerms.filter(p => wanted.includes(p.key)).map(p => p.id);
    await db.transaction(async (tx) => {
      if (editableIds.length) await tx.delete(rolePermissionsTable).where(and(eq(rolePermissionsTable.roleId, id), inArray(rolePermissionsTable.permissionId, editableIds)));
      if (permIds.length > 0) await tx.insert(rolePermissionsTable).values(permIds.map(permissionId => ({ roleId: id, permissionId })));
    });

    invalidatePermCache(id);
    const afterKeys = [...await getPermissionsForRole(id)];
    const added = afterKeys.filter(k => !beforeKeys.includes(k)), removed = beforeKeys.filter(k => !afterKeys.includes(k));
    if (added.length || removed.length) await auditRbac(req, "role_permissions", { roleId: id, name: role.name }, { removed }, { added });
    res.json({ ok: true, count: afterKeys.length, added, removed });
  } catch {
    res.status(500).json({ error: "권한 설정 실패" });
  }
});

// ─── 사용자에게 역할 지정 ─────────────────────────────────────────────────────
router.patch("/admin/users/:id/rbac-role", ...adminOnly, async (req, res) => {
  const userId = Number(req.params.id);
  const { roleId } = req.body as { roleId: number | null };

  try {
    const [prev] = await db.select({ roleId: usersTable.roleId, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const [updated] = await db
      .update(usersTable)
      .set({ roleId: roleId ?? null })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, roleId: usersTable.roleId });
    if (!updated) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    if ((prev?.roleId ?? null) !== (updated.roleId ?? null)) await auditRbac(req, "user_role", { userId, email: prev?.email ?? null }, { roleId: prev?.roleId ?? null }, { roleId: updated.roleId ?? null });
    res.json(updated);
  } catch {
    res.status(500).json({ error: "역할 지정 실패" });
  }
});

export default router;
