import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

router.get("/admin/users", ...adminGuard, async (req, res) => {
  try {
    const { search, roleType, role: roleLegacy } = req.query as { search?: string; roleType?: string; role?: string };
    // roleType 우선, 하위 호환을 위해 role도 지원
    const roleFilter = (roleType ?? roleLegacy ?? "").trim();

    const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000);

    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        roleId: usersTable.roleId,
        isActive: usersTable.isActive,
        createdAt: usersTable.createdAt,
        department: usersTable.department,
        jobTitle: usersTable.jobTitle,
        companyId: usersTable.companyId,
        lastLoginAt: usersTable.lastLoginAt,
        lastActivityAt: usersTable.lastActivityAt,
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt);

    const enriched = rows.map(u => ({
      ...u,
      isOnline: u.lastActivityAt ? u.lastActivityAt >= onlineThreshold : false,
    }));

    let result = enriched.reverse();

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(u =>
        u.email.toLowerCase().includes(s) ||
        (u.name ?? "").toLowerCase().includes(s) ||
        (u.department ?? "").toLowerCase().includes(s) ||
        (u.jobTitle ?? "").toLowerCase().includes(s)
      );
    }

    const allRoles = ["customer", "translator", "admin", "staff", "client", "linguist"];
    if (roleFilter && allRoles.includes(roleFilter)) {
      if (roleFilter === "client") {
        result = result.filter(u => u.role === "client" || u.role === "customer");
      } else if (roleFilter === "linguist") {
        result = result.filter(u => u.role === "linguist" || u.role === "translator");
      } else {
        result = result.filter(u => u.role === roleFilter);
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch users");
    res.status(500).json({ error: "사용자 조회 실패." });
  }
});

// ─── 사용자 역할 변경 ─────────────────────────────────────────────────────
router.patch("/admin/users/:id/name", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  const { name } = req.body as { name?: string };
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  try {
    const [updated] = await db
      .update(usersTable)
      .set({ name: name?.trim() || null })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role });
    if (!updated) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update user name");
    res.status(500).json({ error: "이름 변경 실패." });
  }
});

router.patch("/admin/users/:id/role", ...adminGuard, requirePermission("user.manage"), async (req, res) => {
  const userId = Number(req.params.id);
  const { role } = req.body as { role?: string };

  const allowedRoles = ["admin", "staff", "client", "linguist", "customer", "translator"];
  if (!role || !allowedRoles.includes(role)) {
    res.status(400).json({ error: "유효하지 않은 역할입니다. admin/staff/client/linguist 중 하나여야 합니다." });
    return;
  }

  if (userId === req.user!.id) {
    res.status(400).json({ error: "본인의 역할은 변경할 수 없습니다." });
    return;
  }

  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }

    // 마지막 admin 계정 보호
    if ((target.role === "admin") && role !== "admin") {
      const adminCount = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true)));
      if (adminCount.length <= 1) {
        res.status(400).json({ error: "마지막 관리자 계정의 역할은 변경할 수 없습니다." });
        return;
      }
    }

    const [updated] = await db
      .update(usersTable)
      .set({ role: role as typeof usersTable.$inferInsert["role"] })
      .where(eq(usersTable.id, userId))
      .returning({
        id: usersTable.id, email: usersTable.email, name: usersTable.name,
        role: usersTable.role, isActive: usersTable.isActive, createdAt: usersTable.createdAt,
        department: usersTable.department, jobTitle: usersTable.jobTitle, companyId: usersTable.companyId,
      });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update user role");
    res.status(500).json({ error: "역할 변경 실패." });
  }
});

// ─── 내부 사용자 생성 (admin/staff) ──────────────────────────────────────
router.post("/admin/users/internal", ...adminGuard, requirePermission("user.manage"), async (req, res) => {
  const { email: rawEmail, password, role, name, department, jobTitle } = req.body as {
    email?: string; password?: string; role?: string;
    name?: string; department?: string; jobTitle?: string;
  };

  if (!rawEmail || !password) {
    res.status(400).json({ error: "email과 password는 필수입니다." }); return;
  }
  const allowedRoles = ["admin", "staff"];
  if (!role || !allowedRoles.includes(role)) {
    res.status(400).json({ error: "내부 사용자는 admin 또는 staff 역할만 가능합니다." }); return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "비밀번호는 최소 6자 이상이어야 합니다." }); return;
  }

  const email = rawEmail.trim().toLowerCase();
  const bcrypt = await import("bcryptjs");
  const hashed = await bcrypt.hash(password, 10);

  try {
    const [user] = await db
      .insert(usersTable)
      .values({
        email, password: hashed,
        role: role as "admin" | "staff",
        name: name?.trim() || null,
        department: department?.trim() || null,
        jobTitle: jobTitle?.trim() || null,
      })
      .returning({
        id: usersTable.id, email: usersTable.email, role: usersTable.role,
        name: usersTable.name, department: usersTable.department, jobTitle: usersTable.jobTitle,
      });
    res.status(201).json(user);
  } catch {
    res.status(400).json({ error: "이미 사용 중인 이메일입니다." });
  }
});

// ─── 사용자 프로필(부서/직책) 수정 ───────────────────────────────────────
router.patch("/admin/users/:id/profile", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  const { department, jobTitle } = req.body as { department?: string; jobTitle?: string };
  if (isNaN(userId)) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }

  try {
    const [updated] = await db
      .update(usersTable)
      .set({
        department: department?.trim() || null,
        jobTitle: jobTitle?.trim() || null,
      })
      .where(eq(usersTable.id, userId))
      .returning({
        id: usersTable.id, email: usersTable.email, name: usersTable.name,
        role: usersTable.role, department: usersTable.department, jobTitle: usersTable.jobTitle,
      });
    if (!updated) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update user profile");
    res.status(500).json({ error: "프로필 수정 실패." });
  }
});

// ─── 관리자 비밀번호 재설정 (개발/운영용) ────────────────────────────────
router.patch("/admin/users/:id/reset-password", ...adminGuard, async (req, res) => {
  const targetId = Number(req.params.id);
  const { newPassword } = req.body as { newPassword?: string };

  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." });
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: "새 비밀번호는 최소 6자 이상이어야 합니다." });
    return;
  }

  try {
    const [target] = await db.select({ id: usersTable.id, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, targetId));
    if (!target) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }
    if (target.role === "admin" && target.id !== req.user!.id) {
      res.status(403).json({ error: "다른 관리자의 비밀번호는 변경할 수 없습니다." });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable).set({ password: hashed }).where(eq(usersTable.id, targetId));
    req.log.info({ adminId: req.user!.id, targetId }, "Admin reset password for user");
    res.json({ ok: true, message: "비밀번호가 재설정되었습니다." });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to reset password");
    res.status(500).json({ error: "비밀번호 재설정 실패." });
  }
});

// ─── 사용자 활성화/비활성화 ───────────────────────────────────────────────
router.patch("/admin/users/:id/deactivate", ...adminGuard, requirePermission("user.manage"), async (req, res) => {
  const userId = Number(req.params.id);

  if (userId === req.user!.id) {
    res.status(400).json({ error: "본인 계정은 비활성화할 수 없습니다." });
    return;
  }

  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }

    // 마지막 활성 admin 비활성화 방지
    if (target.role === "admin" && target.isActive) {
      const activeAdmins = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true)));
      if (activeAdmins.length <= 1) {
        res.status(400).json({ error: "마지막 활성 관리자 계정은 비활성화할 수 없습니다." });
        return;
      }
    }

    const newActive = !target.isActive;
    const [updated] = await db
      .update(usersTable)
      .set({ isActive: newActive })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive, createdAt: usersTable.createdAt });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to toggle user active state");
    res.status(500).json({ error: "계정 상태 변경 실패." });
  }
});

export default router;
