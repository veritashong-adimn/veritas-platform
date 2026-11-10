import { Router, type IRouter } from "express";
import { db, usersTable, logsTable, userSessionsTable, rolesTable, invitationsTable } from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, and, isNull, isNotNull, desc, sql } from "drizzle-orm";
import { deleterNameSql } from "../../lib/deleterName";
import { purgedEmailFor, isReservedEmail, isPurgedEmail, notPurgedSql, PURGEABLE_ROLES } from "../../lib/userPurge";
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
        phone: usersTable.phone,
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

// ─── 사용자 상세정보 조회 (등록정보 + 최근 접속 기록 + 수정 이력) ─────────────
//  · 비밀번호·초대토큰 등 인증정보는 절대 반환하지 않는다.
router.get("/admin/users/:id/detail", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  try {
    const [user] = await db
      .select({
        id: usersTable.id, email: usersTable.email, name: usersTable.name, phone: usersTable.phone,
        role: usersTable.role, roleId: usersTable.roleId, roleName: rolesTable.name,
        isActive: usersTable.isActive, department: usersTable.department, jobTitle: usersTable.jobTitle,
        companyId: usersTable.companyId, createdAt: usersTable.createdAt,
        lastLoginAt: usersTable.lastLoginAt, lastActivityAt: usersTable.lastActivityAt,
        deletedAt: usersTable.deletedAt,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!user) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    // 영구 비식별 처리 계정은 계정관리 화면에서 조회하지 않는다(이름은 업무기록 표시용으로만 보존).
    if (isPurgedEmail(user.email)) { res.status(410).json({ error: "영구 비식별 처리된 계정입니다." }); return; }

    const [sessions, [loginAgg], history] = await Promise.all([
      db.select({
          loginAt: userSessionsTable.loginAt, logoutAt: userSessionsTable.logoutAt,
          lastActivityAt: userSessionsTable.lastActivityAt, ipAddress: userSessionsTable.ipAddress,
        })
        .from(userSessionsTable).where(eq(userSessionsTable.userId, userId))
        .orderBy(desc(userSessionsTable.loginAt)).limit(10),
      db.select({ count: sql<number>`count(*)::int` }).from(userSessionsTable).where(eq(userSessionsTable.userId, userId)),
      db.select({
          id: logsTable.id, action: logsTable.action, performedBy: logsTable.performedBy,
          performedByEmail: logsTable.performedByEmail, metadata: logsTable.metadata, createdAt: logsTable.createdAt,
        })
        .from(logsTable).where(and(eq(logsTable.entityType, "user"), eq(logsTable.entityId, userId)))
        .orderBy(desc(logsTable.createdAt)).limit(20),
    ]);

    res.json({
      user,
      activity: { loginCount: loginAgg?.count ?? 0, recentSessions: sessions },
      history: history.map(h => {
        let changes: unknown = null;
        try { changes = h.metadata ? JSON.parse(h.metadata).changes ?? null : null; } catch { /* ignore */ }
        return { id: h.id, action: h.action, performedBy: h.performedBy, performedByEmail: h.performedByEmail, createdAt: h.createdAt, changes };
      }),
    });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch user detail");
    res.status(500).json({ error: "사용자 상세정보 조회 실패." });
  }
});

// ─── 사용자 등록정보 수정 (이름·이메일·연락처·부서·직책·사용자 유형) ─────────────
//  · user.manage 권한 필수. 비밀번호/인증정보·RBAC roleId·활성상태는 이 API 로 변경하지 않는다.
//  · 전달된 필드 중 실제로 값이 바뀐 항목만 UPDATE 하고, 전후값·수정자·일시를 logs(entity_type=user)에 기록.
const EDITABLE_ROLES = ["admin", "staff", "client", "linguist", "customer", "translator"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.patch("/admin/users/:id", ...adminGuard, requirePermission("user.manage"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;

  const norm = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
  const nullable = (v: unknown) => norm(v) || null;

  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    if (target.deletedAt) { res.status(400).json({ error: "휴지통에 있는 사용자는 수정할 수 없습니다. 먼저 복구하세요." }); return; }

    const next: Partial<typeof usersTable.$inferInsert> = {};
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const track = <K extends "name" | "email" | "phone" | "department" | "jobTitle" | "role">(key: K, after: unknown) => {
      const before = (target as Record<string, unknown>)[key] ?? null;
      if ((before ?? null) !== (after ?? null)) {
        (next as Record<string, unknown>)[key] = after;
        changes[key] = { before, after };
      }
    };

    // 이름 — 필수
    if ("name" in body) {
      const name = norm(body.name);
      if (!name) { res.status(400).json({ error: "이름은 필수입니다.", field: "name" }); return; }
      if (name.length > 100) { res.status(400).json({ error: "이름은 100자 이하로 입력하세요.", field: "name" }); return; }
      track("name", name);
    }
    // 이메일 — 필수 · 형식 · 중복(대소문자 무시, 휴지통 사용자 포함 — DB unique 제약과 동일 범위)
    if ("email" in body) {
      const email = norm(body.email).toLowerCase();
      if (!email) { res.status(400).json({ error: "이메일은 필수입니다.", field: "email" }); return; }
      if (!EMAIL_RE.test(email)) { res.status(400).json({ error: "이메일 형식이 올바르지 않습니다.", field: "email" }); return; }
      if (isReservedEmail(email)) { res.status(400).json({ error: "시스템 예약 도메인은 사용할 수 없습니다.", field: "email" }); return; }
      if (email !== target.email.toLowerCase()) {
        const dup = await db.select({ id: usersTable.id }).from(usersTable)
          .where(and(sql`lower(${usersTable.email}) = ${email}`, sql`${usersTable.id} <> ${userId}`)).limit(1);
        if (dup.length) { res.status(409).json({ error: "이미 사용 중인 이메일입니다.", field: "email" }); return; }
      }
      track("email", email);
    }
    if ("phone" in body) {
      const phone = nullable(body.phone);
      if (phone && !/^[0-9+\-() .]{7,30}$/.test(phone)) { res.status(400).json({ error: "연락처 형식이 올바르지 않습니다. (숫자, +, -, 공백만 허용)", field: "phone" }); return; }
      track("phone", phone);
    }
    if ("department" in body) track("department", nullable(body.department));
    if ("jobTitle" in body) track("jobTitle", nullable(body.jobTitle));

    // 사용자 유형 — 기존 /role 엔드포인트와 동일한 보호 규칙 + RBAC 충돌 검증
    if ("role" in body && body.role !== target.role) {
      const role = norm(body.role);
      if (!(EDITABLE_ROLES as readonly string[]).includes(role)) {
        res.status(400).json({ error: "유효하지 않은 사용자 유형입니다.", field: "role" }); return;
      }
      if (userId === req.user!.id) {
        res.status(400).json({ error: "본인의 사용자 유형은 변경할 수 없습니다.", field: "role" }); return;
      }
      if (target.role === "admin" && role !== "admin" && target.isActive) {
        const admins = await db.select({ id: usersTable.id }).from(usersTable)
          .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true), isNull(usersTable.deletedAt)));
        if (admins.length <= 1) { res.status(400).json({ error: "마지막 관리자 계정의 유형은 변경할 수 없습니다.", field: "role" }); return; }
      }
      // RBAC 시스템 권한(roleId)은 내부 사용자(admin/staff) 전용 — 외부 유형으로 바꿀 때 권한이 남아 있으면 차단.
      if (target.roleId && role !== "admin" && role !== "staff") {
        res.status(400).json({ error: "시스템 권한(RBAC)이 지정된 사용자입니다. 목록의 '시스템 권한' 지정을 먼저 해제한 뒤 고객/통번역사로 변경하세요.", field: "role" }); return;
      }
      track("role", role);
    }

    if (Object.keys(changes).length === 0) {
      res.json({ ok: true, changed: [], user: null }); return;
    }

    let updated;
    try {
      [updated] = await db.update(usersTable).set(next)
        .where(and(eq(usersTable.id, userId), isNull(usersTable.deletedAt)))
        .returning({
          id: usersTable.id, email: usersTable.email, name: usersTable.name, phone: usersTable.phone,
          role: usersTable.role, roleId: usersTable.roleId, isActive: usersTable.isActive,
          department: usersTable.department, jobTitle: usersTable.jobTitle, createdAt: usersTable.createdAt,
        });
    } catch (err: any) {
      if (err?.code === "23505" || err?.cause?.code === "23505") { res.status(409).json({ error: "이미 사용 중인 이메일입니다.", field: "email" }); return; }
      throw err;
    }
    if (!updated) { res.status(409).json({ error: "사용자 상태가 변경되었습니다. 새로고침 후 다시 시도하세요." }); return; }

    // 감사로그 — 수정 전후값·수정자·수정일시(createdAt)
    try {
      await db.insert(logsTable).values({
        entityType: "user", entityId: userId, action: "profile_updated",
        performedBy: req.user?.id ?? null, performedByEmail: req.user?.email ?? null,
        metadata: JSON.stringify({ changes }),
      });
    } catch (err) { req.log.error({ err, userId }, "Admin: user audit log write failed"); }
    req.log.info({ userId, changedFields: Object.keys(changes), by: req.user?.id }, "Admin: user profile updated");

    res.json({ ok: true, changed: Object.keys(changes), user: updated });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update user");
    res.status(500).json({ error: "사용자 정보 수정 실패." });
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
  if (isReservedEmail(email)) { res.status(400).json({ error: "시스템 예약 도메인은 사용할 수 없습니다." }); return; }
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
    if (isPurgedEmail(target.email)) { res.status(409).json({ error: "영구 비식별 처리된 계정은 복원할 수 없습니다." }); return; }

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

// ─── 사용자 영구 비식별 처리 (통합휴지통 "완전삭제") ───────────────────────────
//  · 행을 물리 삭제하지 않는다 — 모든 FK·업무 데이터(견적·판매·수금·정산·감사로그)의 담당자 연결 유지.
//  · 제거: 이메일(대체값) · 비밀번호 · 초대토큰 · 연락처 · 세션 IP/UserAgent · 초대장 토큰/이메일(만료 처리).
//  · 보존: 이름·부서·직책·유형 — 과거 업무 담당자 표시용 업무기록(계정관리 화면·휴지통에서는 더 이상 노출 안 함).
//  · 차단: deletedAt 유지 + isActive=false → 로그인·기존 JWT 모두 차단(requireAuth 상태검증). 복원 불가.
//  · 적용 범위: 관리자·직원·고객. 통번역사 계정은 별도 정책으로 제외.
router.delete("/admin/users/:id/permanent", requireAuth, requireRole("admin"), requirePermission("user.manage"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  if (userId === req.user!.id) { res.status(400).json({ error: "현재 로그인 중인 계정은 처리할 수 없습니다." }); return; }
  const purgeReason = ((req.body?.reason ?? "") as string).trim();

  try {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!target) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    if (isPurgedEmail(target.email)) { res.status(409).json({ error: "이미 영구 비식별 처리된 계정입니다." }); return; }
    if (!target.deletedAt) { res.status(400).json({ error: "휴지통에 있는 사용자만 완전삭제할 수 있습니다." }); return; }
    if (!(PURGEABLE_ROLES as readonly string[]).includes(target.role)) {
      res.status(400).json({ error: "통번역사 계정은 이번 완전삭제 정책 대상이 아닙니다. (별도 정책 예정 — 복구만 가능)", code: "ROLE_NOT_SUPPORTED" });
      return;
    }
    // 마지막 관리자 보호 — 처리 대상 외에 유효한(활성·미삭제) 관리자가 1명 이상 있어야 한다.
    if (target.role === "admin") {
      const others = await db.select({ id: usersTable.id }).from(usersTable)
        .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true), isNull(usersTable.deletedAt), sql`${usersTable.id} <> ${userId}`));
      if (others.length === 0) { res.status(400).json({ error: "마지막 관리자 계정은 처리할 수 없습니다." }); return; }
    }

    const now = new Date();
    const cleared = ["email", "password", "inviteToken", "phone", "sessions.ipAddress", "sessions.userAgent", "invitations.token", "invitations.email"];
    await db.transaction(async tx => {
      // 경합 방지: 휴지통 상태이며 아직 처리되지 않은 경우에만.
      const [done] = await tx.update(usersTable)
        .set({ email: purgedEmailFor(userId), password: null, inviteToken: null, phone: null, isActive: false })
        .where(and(eq(usersTable.id, userId), isNotNull(usersTable.deletedAt), notPurgedSql))
        .returning({ id: usersTable.id });
      if (!done) throw Object.assign(new Error("state changed"), { status: 409 });

      // 세션 기록(접속 통계)은 유지하고 접속환경 개인정보만 제거, 열린 세션은 종료 처리.
      await tx.update(userSessionsTable)
        .set({ ipAddress: null, userAgent: null, isOnline: false, logoutAt: sql`coalesce(${userSessionsTable.logoutAt}, ${now})` })
        .where(eq(userSessionsTable.userId, userId));

      // 초대장: 행·FK 는 유지하고 토큰 무효화 + 이메일 비식별 + 즉시 만료.
      await tx.update(invitationsTable)
        .set({ token: sql`'revoked-' || ${invitationsTable.id} || '-' || md5(random()::text)`, email: purgedEmailFor(userId), expiresAt: now })
        .where(eq(invitationsTable.userId, userId));

      // 감사로그 — 실행자·일시·사유·처리 항목. 제거한 개인정보(원래 이메일 등)는 기록하지 않는다.
      await tx.insert(logsTable).values({
        entityType: "user", entityId: userId, action: "purged",
        performedBy: req.user?.id ?? null, performedByEmail: req.user?.email ?? null,
        metadata: JSON.stringify({ role: target.role, cleared, retained: ["name", "department", "jobTitle", "role", "companyId"], ...(purgeReason ? { purgeReason } : {}) }),
      });
    });

    req.log.warn({ userId, role: target.role, purgedBy: req.user?.id }, "Admin: user PERMANENTLY de-identified (영구 비식별 처리)");
    res.json({ ok: true, purgedUserId: userId });
  } catch (err: any) {
    if (err?.status === 409) { res.status(409).json({ error: "사용자 상태가 변경되었습니다. 새로고침 후 다시 시도하세요." }); return; }
    req.log.error({ err }, "Admin: failed to purge user");
    res.status(500).json({ error: "사용자 완전삭제(비식별 처리) 실패." });
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
        deletedBy: usersTable.deletedBy,
        deletedByName: deleterNameSql("users"),
      })
      .from(usersTable)
      // 영구 비식별 처리 완료 계정은 휴지통에서 제외(복원 불가 상태).
      .where(and(isNotNull(usersTable.deletedAt), notPurgedSql))
      .orderBy(desc(usersTable.deletedAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to list user trash");
    res.status(500).json({ error: "사용자 휴지통 조회 실패." });
  }
});

export default router;
