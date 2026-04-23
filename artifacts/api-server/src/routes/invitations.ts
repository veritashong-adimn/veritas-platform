import { Router } from "express";
import crypto from "crypto";
import { db, usersTable, invitationsTable, projectsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { sendEmail, buildInviteEmail, buildProjectNotificationEmail } from "../lib/mailer";

const adminGuard = [requireAuth, requireRole("admin", "staff")];

const router = Router();

// ─── 플랫폼 사용자(client/customer) 목록 조회 ─────────────────────────────
router.get("/admin/platform-users", ...adminGuard, async (req, res) => {
  try {
    const users = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive })
      .from(usersTable)
      .where(eq(usersTable.isActive, true))
      .orderBy(usersTable.name);

    res.json(users.filter(u => ["client", "customer"].includes(u.role)));
  } catch (err) {
    res.status(500).json({ error: "사용자 목록 조회 실패" });
  }
});

// ─── 초대 또는 알림 발송 ────────────────────────────────────────────────────
// POST /api/invitations
// 이미 계정이 있으면 → 프로젝트 연결 + 알림 이메일
// 없으면 → 계정 생성(invited) + 초대 이메일 + invitations 레코드
router.post("/invitations", ...adminGuard, async (req, res) => {
  const { name, email, projectId } = req.body as {
    name?: string;
    email?: string;
    projectId?: number;
  };

  if (!email?.trim()) {
    res.status(400).json({ error: "이메일은 필수입니다." });
    return;
  }
  if (!projectId) {
    res.status(400).json({ error: "프로젝트 ID는 필수입니다." });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const performer = (req as any).user as { id: number; email: string } | undefined;

  try {
    // 프로젝트 존재 확인 (requestingCompanyId 포함 - 신규 유저 companyId 설정에 사용)
    const [project] = await db
      .select({ id: projectsTable.id, title: projectsTable.title, requestingCompanyId: projectsTable.requestingCompanyId })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    // 기존 사용자 확인
    const [existingUser] = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail));

    const appUrl = process.env["APP_URL"] ?? "https://platform.example.com";

    if (existingUser) {
      // ── 기존 계정 → 프로젝트 customerUserId 연결 + 알림 이메일 ───────────
      await db
        .update(projectsTable)
        .set({ customerUserId: existingUser.id })
        .where(eq(projectsTable.id, projectId));

      await logEvent("project", projectId, "customer_linked", req.log, performer, existingUser.email);

      const mail = buildProjectNotificationEmail({
        name: existingUser.name ?? existingUser.email,
        projectTitle: project.title,
        appUrl,
      });
      await sendEmail({ ...mail, to: existingUser.email });

      await logEvent("project", projectId, "project_notification_sent", req.log, performer, existingUser.email);

      res.json({ ok: true, mode: "linked", userId: existingUser.id });
      return;
    }

    // ── 신규 사용자 → 계정 생성(inactive) + 초대 이메일 ──────────────────
    // 중복 초대 방지: 동일 이메일 + 동일 프로젝트 미처리 초대 확인
    const [existingInvitation] = await db
      .select({ id: invitationsTable.id, expiresAt: invitationsTable.expiresAt })
      .from(invitationsTable)
      .where(
        and(
          eq(invitationsTable.email, normalizedEmail),
          eq(invitationsTable.projectId, projectId),
        ),
      );

    if (existingInvitation && existingInvitation.expiresAt > new Date()) {
      res.status(409).json({ error: "이미 유효한 초대가 존재합니다. 초대 링크를 다시 발송하려면 기존 초대를 취소하세요." });
      return;
    }

    // 사용자 생성 (isActive: false = invited)
    // companyId: 프로젝트의 requestingCompanyId를 소속 회사로 설정
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const [newUser] = await db
      .insert(usersTable)
      .values({
        email: normalizedEmail,
        name: name?.trim() || null,
        role: "client",
        isActive: false,
        inviteToken,
        companyId: project.requestingCompanyId ?? null,
      })
      .returning({ id: usersTable.id });

    await logEvent("project", projectId, "customer_invitation_company_assigned", req.log, performer,
      JSON.stringify({ email: normalizedEmail, companyId: project.requestingCompanyId }));

    // 프로젝트 연결
    await db
      .update(projectsTable)
      .set({ customerUserId: newUser.id })
      .where(eq(projectsTable.id, projectId));

    // 초대 레코드 생성 (48시간 만료)
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.insert(invitationsTable).values({
      email: normalizedEmail,
      token: inviteToken,
      projectId,
      userId: newUser.id,
      expiresAt,
    });

    // 초대 이메일 발송
    const inviteUrl = `${appUrl}/set-password?token=${inviteToken}`;
    const mail = buildInviteEmail({
      name: name?.trim() || normalizedEmail,
      inviteUrl,
      projectTitle: project.title,
    });
    await sendEmail({ ...mail, to: normalizedEmail });

    await logEvent("project", projectId, "invitation_created", req.log, performer, normalizedEmail);

    req.log.info({ projectId, email: normalizedEmail, inviteToken, inviteUrl }, "Invitation created");

    res.status(201).json({ ok: true, mode: "invited", userId: newUser.id });
  } catch (err: any) {
    req.log.error({ err: err?.message }, "Failed to create invitation");
    res.status(500).json({ error: "초대 처리 실패." });
  }
});

// ─── 프로젝트 연결 알림 발송 (기존 계정 선택 시) ─────────────────────────
// POST /api/notifications/project-created
router.post("/notifications/project-created", ...adminGuard, async (req, res) => {
  const { userId, projectId } = req.body as { userId?: number; projectId?: number };

  if (!userId || !projectId) {
    res.status(400).json({ error: "userId 와 projectId 가 필요합니다." });
    return;
  }

  const performer = (req as any).user as { id: number; email: string } | undefined;

  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, userId));

    const [project] = await db
      .select({ id: projectsTable.id, title: projectsTable.title })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!user || !project) {
      res.status(404).json({ error: "사용자 또는 프로젝트를 찾을 수 없습니다." });
      return;
    }

    // 프로젝트에 customerUserId 연결
    await db
      .update(projectsTable)
      .set({ customerUserId: user.id })
      .where(eq(projectsTable.id, projectId));

    const appUrl = process.env["APP_URL"] ?? "https://platform.example.com";
    const mail = buildProjectNotificationEmail({
      name: user.name ?? user.email,
      projectTitle: project.title,
      appUrl,
    });
    await sendEmail({ ...mail, to: user.email });

    await logEvent("project", projectId, "project_notification_sent", req.log, performer, user.email);

    res.json({ ok: true });
  } catch (err: any) {
    req.log.error({ err: err?.message }, "Failed to send project notification");
    res.status(500).json({ error: "알림 발송 실패." });
  }
});

export default router;
