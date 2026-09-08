import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, and, isNull, isNotNull, desc, sql } from "drizzle-orm";
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
      // 기본 목록은 삭제(휴지통) 사용자를 제외한다(§21). 휴지통은 별도 엔드포인트에서만 조회.
      .where(isNull(usersTable.deletedAt))
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
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true), isNull(usersTable.deletedAt)));
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
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true), isNull(usersTable.deletedAt)));
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

// ─── 사용자 삭제 (Soft Delete · 휴지통 이동) ───────────────────────────────
//  · 물리삭제 금지 — deletedAt/deletedBy/deletionReason 만 기록(업무 FK 이력 전부 보존).
//  · 본인 계정 삭제 차단 + 마지막 유효 관리자 삭제 차단(서버측 재검증, §8·§9).
//  · isActive 는 건드리지 않는다(활성/비활성 상태는 삭제와 독립, §14).
router.delete("/admin/users/:id", ...adminGuard, requirePermission("user.manage"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }

  if (userId === req.user!.id) {
    res.status(400).json({ error: "현재 로그인 중인 계정은 삭제할 수 없습니다." });
    return;
  }

  const reason = ((req.body?.reason ?? "") as string).trim();

  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    if (target.deletedAt) { res.status(409).json({ error: "이미 휴지통에 있는 사용자입니다." }); return; }

    // 마지막 유효 관리자 삭제 방지 — 삭제되지 않은 활성 admin 이 본인 1명뿐이면 차단.
    if (target.role === "admin") {
      const validAdmins = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true), isNull(usersTable.deletedAt)));
      if (validAdmins.length <= 1 && validAdmins.some(a => a.id === userId)) {
        res.status(400).json({ error: "마지막 관리자 계정은 삭제할 수 없습니다." });
        return;
      }
    }

    // 경합 방지: WHERE 에 deletedAt IS NULL 포함.
    const [updated] = await db
      .update(usersTable)
      .set({ deletedAt: new Date(), deletedBy: req.user?.id ?? null, deletionReason: reason || null })
      .where(and(eq(usersTable.id, userId), isNull(usersTable.deletedAt)))
      .returning({ id: usersTable.id });
    if (!updated) { res.status(409).json({ error: "이미 휴지통에 있는 사용자입니다." }); return; }

    // 감사 기록은 기존 사용자 엔드포인트와 동일하게 구조화 로거(pino)로 남긴다(logs 테이블 enum 미변경).
    req.log.info({ userId, email: target.email, role: target.role, deletedBy: req.user?.id, reason: reason || undefined }, "Admin: user soft-deleted (휴지통 이동)");
    res.json({ ok: true, deletedUserId: userId });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to soft-delete user");
    res.status(500).json({ error: "사용자 삭제 실패." });
  }
});

// ─── 사용자 복구 (휴지통 → 사용자관리) ─────────────────────────────────────
//  · deletedAt/deletedBy/deletionReason 만 NULL 로 초기화. id·email·역할·프로필·업무이력 전부 유지.
//  · isActive 는 복원하지 않는다 — 삭제 전 비활성 계정은 복구 후에도 비활성 유지(§13·§14).
router.post("/admin/users/:id/restore", ...adminGuard, requirePermission("user.manage"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  const restoreReason = ((req.body?.reason ?? "") as string).trim();

  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    if (!target.deletedAt) { res.status(400).json({ error: "휴지통에 있는 사용자가 아닙니다." }); return; }

    await db.update(usersTable)
      .set({ deletedAt: null, deletedBy: null, deletionReason: null })
      .where(eq(usersTable.id, userId));

    req.log.info({ userId, email: target.email, restoredBy: req.user?.id, restoreReason: restoreReason || undefined }, "Admin: user restored from trash");
    res.json({ ok: true, restoredUserId: userId });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to restore user");
    res.status(500).json({ error: "사용자 복구 실패." });
  }
});

// ─── 사용자 휴지통 목록 ────────────────────────────────────────────────────
router.get("/admin/users-trash", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        department: usersTable.department,
        jobTitle: usersTable.jobTitle,
        isActive: usersTable.isActive,
        deletedAt: usersTable.deletedAt,
        deletionReason: usersTable.deletionReason,
        deletedByName: sql<string | null>`(SELECT name FROM users WHERE id = ${usersTable.deletedBy})`,
      })
      .from(usersTable)
      .where(isNotNull(usersTable.deletedAt))
      .orderBy(desc(usersTable.deletedAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to list user trash");
    res.status(500).json({ error: "사용자 휴지통 조회 실패." });
  }
});

export default router;
