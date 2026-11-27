import { isReservedEmail } from "../lib/userPurge";
import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { randomUUID, randomBytes } from "crypto";
import { db, usersTable, userSessionsTable, invitationsTable, projectsTable, rolesTable } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { signToken, requireAuth, authConfigured } from "../middlewares/auth";
import { idleTimeoutMinutes, activityTimeFromReport } from "../lib/idlePolicy";
import { getPermissionsForRole, ALL_PERMISSIONS } from "../lib/rbac";

/** 오늘 날짜 키 (YYYY-MM-DD, KST) */
function todayKey(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

/** 마지막 활동 기준 온라인 판정 (5분 이내) */
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

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

// 로그인 세션 생성(user_sessions 1행) — 로그인·회원가입 공통. 토큰은 이 세션 ID 로만 발급한다(세션 없는 토큰 없음).
//   토큰 발급 전에 기록을 완료한다(인증 미들웨어가 세션 행으로 로그아웃·미사용 만료를 검증). 실패하면 null.
async function createLoginSession(req: any, user: { id: number; role: string }): Promise<string | null> {
  const sessionId = randomUUID();
  const now = new Date();
  try {
    await db.insert(userSessionsTable).values({
      userId: user.id,
      sessionId,
      roleType: user.role,
      loginAt: now,
      lastActivityAt: now,
      ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      isOnline: true,
      dateKey: todayKey(),
    });
  } catch (err) {
    req.log.error({ err }, "Session record failed");
    return null;
  }
  db.update(usersTable)
    .set({ lastLoginAt: now, lastActivityAt: now })
    .where(eq(usersTable.id, user.id))
    .catch((err: unknown) => req.log.error({ err }, "Login time update failed"));
  return sessionId;
}

// 화면 버전 확인 — 미사용 자동 로그아웃(실제 활동 보고)을 지원하는 화면은 로그인 요청에 이 헤더를 보낸다.
//   내부 계정(관리자·직원)은 이 화면으로만 로그인할 수 있다: 이전 화면은 3분마다 자동 활동 보고를 보내며 자동 로그아웃이 없으므로,
//   배포 전에 열어 둔 화면에서 다시 로그인하면 새로고침 안내로 거절한다(새로고침하면 최신 화면이 열린다).
export const CLIENT_PROTOCOL_HEADER = "x-veritas-client";
export const CLIENT_PROTOCOL = "idle-v1";
const OUTDATED_CLIENT = { error: "새 버전이 배포되었습니다. 브라우저를 새로고침(F5)한 뒤 다시 로그인해 주세요.", code: "CLIENT_OUTDATED" } as const;

const AUTH_NOT_CONFIGURED = { error: "인증 설정 오류로 로그인할 수 없습니다. 관리자에게 문의하세요." } as const;

router.post("/auth/register", async (req, res) => {
  if (!authConfigured()) { res.status(503).json(AUTH_NOT_CONFIGURED); return; }
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
  if (isReservedEmail(email)) {
    res.status(400).json({ error: "사용할 수 없는 이메일 도메인입니다." });
    return;
  }

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

    // 가입 직후 바로 로그인 — 로그인과 같은 세션을 만들어 발급(세션 없는 토큰 발급 없음). 가입 가능 역할은 외부 계정뿐(위 allowedRoles).
    const sessionId = await createLoginSession(req, user);
    if (!sessionId) { res.status(503).json({ error: "가입은 완료되었지만 로그인 세션을 만들지 못했습니다. 로그인 화면에서 다시 로그인해 주세요." }); return; }
    const token = signToken({ id: user.id, email: user.email, role: user.role, roleId: user.roleId, sessionId });
    const permissions = await resolvePermissions(user);
    res.status(201).json({ token, user: { ...user, permissions }, idleTimeoutMinutes: idleTimeoutMinutes(user.role, null) });
  } catch (err) {
    req.log.error({ err }, "Register failed");
    res.status(400).json({ error: "이미 사용 중인 이메일입니다." });
  }
});

router.post("/auth/login", async (req, res) => {
  if (!authConfigured()) { res.status(503).json(AUTH_NOT_CONFIGURED); return; }
  const { email: rawEmail, password } = req.body as { email?: string; password?: string };

  if (!rawEmail || !password) {
    res.status(400).json({ error: "email과 password는 필수입니다." });
    return;
  }

  const email = rawEmail.trim().toLowerCase();

  let user: (typeof usersTable.$inferSelect) | undefined;
  try {
    [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
  } catch (err) {
    req.log.error({ err }, "Login DB query failed");
    res.status(503).json({ error: "데이터베이스 연결에 실패했습니다. 잠시 후 다시 시도해 주세요." });
    return;
  }

  if (!user) {
    req.log.warn({ email }, "Login failed: user not found");
    res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }

  // 삭제(휴지통) 계정 로그인 차단 — 비활성(isActive)과 독립. 복구 전까지 인증 불가(§10).
  if (user.deletedAt) {
    req.log.warn({ email, userId: user.id }, "Login failed: account deleted (in trash)");
    res.status(403).json({ error: "삭제된 계정입니다. 관리자에게 문의하세요." });
    return;
  }

  if (!user.password) {
    req.log.warn({ email }, "Login failed: password not set (invite pending)");
    res.status(403).json({ error: "비밀번호가 설정되지 않은 계정입니다. 초대 이메일의 링크를 통해 비밀번호를 설정해 주세요.", code: "INVITE_PENDING" });
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

  // 내부 계정은 자동 로그아웃을 지원하는 최신 화면에서만 로그인(이전 화면 → 새로고침 안내). 고객·통번역사 계정은 기존과 같다.
  if ((user.role === "admin" || user.role === "staff") && req.headers[CLIENT_PROTOCOL_HEADER] !== CLIENT_PROTOCOL) {
    req.log.warn({ email, userId: user.id }, "Login rejected: outdated client");
    res.status(409).json(OUTDATED_CLIENT);
    return;
  }

  req.log.info({ email, userId: user.id, role: user.role }, "Login success");

  const sessionId = await createLoginSession(req, user);
  if (!sessionId) { res.status(503).json({ error: "로그인 세션을 만들지 못했습니다. 잠시 후 다시 시도해 주세요." }); return; }

  const token = signToken({ id: user.id, email: user.email, role: user.role, roleId: user.roleId, sessionId });
  const [permissions, roleRow] = await Promise.all([
    resolvePermissions(user),
    user.roleId ? db.select({ name: rolesTable.name }).from(rolesTable).where(eq(rolesTable.id, user.roleId)).then(r => r[0]) : Promise.resolve(undefined),
  ]);

  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, name: user.name, roleId: user.roleId, permissions, mustChangePassword: user.mustChangePassword },
    idleTimeoutMinutes: idleTimeoutMinutes(user.role, roleRow?.name),   // 미사용 자동 로그아웃(분) — 관리자 60·직원 30·그 외 null
  });
});

/** 현재 로그인 사용자의 권한 목록 재조회 */
router.get("/auth/permissions", requireAuth, async (req, res) => {
  const user = req.user!;
  const permissions = await resolvePermissions(user);
  const [flags] = await db.select({ mustChangePassword: usersTable.mustChangePassword }).from(usersTable).where(eq(usersTable.id, user.id));
  // 기존 응답(permissions) 유지 + 현재 역할 정보 추가 — 화면이 저장된 사용자 정보(role/roleId)를 최신으로 맞춘다.
  res.json({ permissions, role: user.role, roleId: user.roleId ?? null, mustChangePassword: !!flags?.mustChangePassword, idleTimeoutMinutes: user.idleTimeoutMinutes ?? null });
});

// ─── 본인 비밀번호 변경 ──────────────────────────────────────────────────────
//  · 본인(토큰의 사용자)만 — 대상 id 를 받지 않는다. 비밀번호 값은 로그에 남기지 않는다.
//  · 성공 시 passwordChangedAt 기록 → 이 시각 이전 토큰은 requireAuth 에서 거부(기존 세션 전부 무효화, 재로그인 필요).
//  · 횟수 제한(메모리): 사용자별 15분에 10회 요청, 현재 비밀번호 오류 5회 → 15분 차단.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;
// 흔한 취약 비밀번호 — 프론트(MyAccount.tsx)와 같은 목록·규칙을 쓴다(소문자 비교)
const COMMON_PASSWORDS = new Set([
  "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000", "88888888", "12341234", "11223344", "1q2w3e4r", "1q2w3e4r5t",
  "1qaz2wsx", "qwer1234", "qwerty12", "qwerty123", "qwertyuiop", "asdf1234", "asdfghjkl", "zxcvbnm1", "zxcvbnm123", "abcd1234", "abc12345",
  "a1b2c3d4", "aa123456", "password", "password1", "password12", "password123", "passw0rd", "p@ssw0rd", "p@ssword", "iloveyou", "sunshine",
  "princess", "football", "baseball", "superman", "welcome1", "letmein1", "trustno1", "dragon12", "monkey12", "changeme", "admin123",
  "admin1234", "administrator", "test1234", "user1234", "guest1234", "veritas1", "veritas123", "veritas1234", "veritasos",
]);
const KEYBOARD_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
export function weakPasswordReason(pw: string): string | null {
  const s = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(s)) return "흔히 사용되는 비밀번호입니다.";
  if (/^(.)\1+$/.test(s)) return "같은 문자만 반복한 비밀번호입니다.";
  const codes = [...s].map(c => c.charCodeAt(0));
  const step = codes[1] - codes[0];
  if ((step === 1 || step === -1) && codes.every((c, i) => i === 0 || c - codes[i - 1] === step)) return "연속된 문자·숫자로만 된 비밀번호입니다.";
  if (KEYBOARD_ROWS.some(r => r.includes(s) || [...r].reverse().join("").includes(s))) return "키보드 배열 순서로만 된 비밀번호입니다.";
  if (/^(password|passw0rd|p@ssw0rd|qwerty|admin|veritas|welcome|letmein|iloveyou|test|user|guest|abcd|love)[\d!@#$%^&*._\-~]*$/.test(s)) return "흔한 단어에 숫자·기호만 붙인 비밀번호입니다.";
  return null;
}

const PW_WINDOW_MS = 15 * 60 * 1000;
const pwAttempts = new Map<number, { start: number; total: number; failed: number }>();
function pwRateCheck(userId: number): { ok: true; rec: { start: number; total: number; failed: number } } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  let rec = pwAttempts.get(userId);
  if (!rec || now - rec.start > PW_WINDOW_MS) { rec = { start: now, total: 0, failed: 0 }; pwAttempts.set(userId, rec); }
  if (rec.failed >= 5 || rec.total >= 10) return { ok: false, retryAfterSec: Math.ceil((rec.start + PW_WINDOW_MS - now) / 1000) };
  rec.total++;
  return { ok: true, rec };
}
export function validateNewPassword(pw: string, email?: string | null): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return `새 비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상 입력해 주세요.`;
  if (pw.length > PASSWORD_MAX_LENGTH) return `새 비밀번호는 ${PASSWORD_MAX_LENGTH}자 이하로 입력해 주세요.`;
  // bcrypt 는 72바이트 초과분을 무시한다 — 한글 등 다바이트 문자로 64자 안에서 넘는 경우 차단(안전장치)
  if (new TextEncoder().encode(pw).length > 72) return "새 비밀번호가 너무 깁니다. 한글 등은 더 짧게 입력해 주세요.";
  if (!pw.trim()) return "공백만으로 된 비밀번호는 사용할 수 없습니다.";
  if (email && pw.trim().toLowerCase() === email.trim().toLowerCase()) return "이메일과 같은 비밀번호는 사용할 수 없습니다.";
  const weak = weakPasswordReason(pw);
  if (weak) return `${weak} 다른 비밀번호를 사용해 주세요.`;
  return null;
}

router.patch("/auth/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body as {
    currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown;
  };
  const userId = req.user!.id;

  const rl = pwRateCheck(userId);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    res.status(429).json({ error: `비밀번호 변경 시도가 너무 많습니다. ${Math.ceil(rl.retryAfterSec / 60)}분 후 다시 시도해 주세요.`, code: "RATE_LIMITED" });
    return;
  }
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
    res.status(400).json({ error: "현재 비밀번호와 새 비밀번호를 모두 입력해주세요." });
    return;
  }
  // 확인 값은 화면에서 함께 보낼 때만 검사(기존 호출 호환)
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    res.status(400).json({ error: "새 비밀번호와 확인 비밀번호가 일치하지 않습니다.", code: "CONFIRM_MISMATCH" });
    return;
  }

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email, password: usersTable.password })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user || !user.password) {
    res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
    return;
  }

  const policyErr = validateNewPassword(newPassword, user.email);
  if (policyErr) { res.status(400).json({ error: policyErr, code: "POLICY" }); return; }

  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) {
    rl.rec.failed++;
    req.log.warn({ userId, failed: rl.rec.failed }, "Password change rejected: current password mismatch");
    res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다.", code: "CURRENT_MISMATCH" });
    return;
  }
  // 기존(현재) 비밀번호 재사용 금지 — 해시 비교(비밀번호 이력은 보관하지 않는다)
  if (currentPassword === newPassword || await bcrypt.compare(newPassword, user.password)) {
    res.status(400).json({ error: "현재 사용 중인 비밀번호는 다시 사용할 수 없습니다.", code: "REUSE" });
    return;
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  const now = new Date();
  await db
    .update(usersTable)
    .set({ password: hashed, passwordChangedAt: now, mustChangePassword: false })
    .where(eq(usersTable.id, userId));
  // 활동 화면용 세션 상태 정리(토큰 무효화 자체는 passwordChangedAt 으로 처리)
  await db.update(userSessionsTable)
    .set({ logoutAt: now, isOnline: false })
    .where(and(eq(userSessionsTable.userId, userId), sql`${userSessionsTable.logoutAt} IS NULL`))
    .catch(err => req.log.error({ err }, "Password change: session close failed"));
  pwAttempts.delete(userId);

  req.log.info({ userId }, "Password changed by user");
  res.json({ ok: true, reloginRequired: true });
});

/** Heartbeat: 실제 사용자 활동 보고 — 마지막 활동 시간 갱신.
 *  화면은 마우스·키보드·스크롤 등 실제 활동이 있을 때만(최대 2분 간격) 또는 '로그인 연장' 클릭 시 호출한다(백그라운드 조회는 보고하지 않음).
 *  body.idleMs = 화면 기준 마지막 활동 이후 경과(ms) → 서버 시각 기준 활동 시각으로 환산(시계 차이 무관, 최대 10분). 생략 시 지금.
 *  활동 시각은 앞당기지 않는다(GREATEST). 만료·로그아웃된 세션은 requireAuth 에서 이미 거부되므로 이 호출로 복구되지 않는다. */
router.post("/auth/heartbeat", requireAuth, async (req, res) => {
  const user = req.user!;
  const body = req.body as { activity?: unknown; idleMs?: unknown } | undefined;
  // 실제 활동 보고만 인정 — 최신 화면은 { activity: true, idleMs } 형식으로만 보낸다.
  //   이전 화면의 3분 주기 자동 호출(본문 없음)은 성공 응답만 하고 활동 시각을 갱신하지 않는다(자동 로그아웃 우회 차단).
  if (body?.activity !== true || typeof body.idleMs !== "number") {
    res.json({ ok: true, counted: false, idleTimeoutMinutes: user.idleTimeoutMinutes ?? null });
    return;
  }
  const at = activityTimeFromReport(Date.now(), body.idleMs);

  await Promise.all([
    db.update(usersTable)
      .set({ lastActivityAt: sql`GREATEST(COALESCE(${usersTable.lastActivityAt}, ${at}), ${at})` })
      .where(eq(usersTable.id, user.id)),
    user.sessionId
      ? db.update(userSessionsTable)
          .set({ lastActivityAt: sql`GREATEST(${userSessionsTable.lastActivityAt}, ${at})`, isOnline: true })
          .where(and(
            eq(userSessionsTable.userId, user.id),
            eq(userSessionsTable.sessionId, user.sessionId),
          ))
      : Promise.resolve(),
  ]);

  res.json({ ok: true, counted: true, lastActivityAt: at, idleTimeoutMinutes: user.idleTimeoutMinutes ?? null });
});

/** Logout: 세션을 오프라인 처리 */
router.post("/auth/logout", requireAuth, async (req, res) => {
  const user = req.user!;
  const now = new Date();

  await Promise.all([
    user.sessionId
      ? db.update(userSessionsTable)
          .set({ logoutAt: now, isOnline: false })
          .where(and(
            eq(userSessionsTable.userId, user.id),
            eq(userSessionsTable.sessionId, user.sessionId),
          ))
      : Promise.resolve(),
  ]);

  res.json({ ok: true });
});

// ─── 초대 토큰으로 비밀번호 설정 ─────────────────────────────────────────────
router.post("/auth/set-password", async (req, res) => {
  const { token, password } = req.body as { token?: string; password?: string };

  if (!token?.trim()) {
    res.status(400).json({ error: "초대 토큰이 필요합니다." });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "비밀번호는 8자 이상이어야 합니다." });
    return;
  }

  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email, inviteToken: usersTable.inviteToken })
      .from(usersTable)
      .where(eq(usersTable.inviteToken, token.trim()));

    if (!user) {
      res.status(404).json({ error: "유효하지 않거나 만료된 초대 링크입니다." });
      return;
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.update(usersTable)
      .set({ password: hashed, isActive: true, inviteToken: null })
      .where(eq(usersTable.id, user.id));

    // 초대 레코드 확인 → 프로젝트 자동 연결
    const [invitation] = await db
      .select({ projectId: invitationsTable.projectId })
      .from(invitationsTable)
      .where(eq(invitationsTable.token, token.trim()));

    if (invitation?.projectId) {
      await db.update(projectsTable)
        .set({ customerUserId: user.id })
        .where(eq(projectsTable.id, invitation.projectId));
    }

    res.json({ ok: true, email: user.email });
  } catch (err) {
    res.status(500).json({ error: "비밀번호 설정 실패." });
  }
});

// ─── 초대 토큰 검증 (비밀번호 설정 페이지 진입 시) ──────────────────────────
router.get("/auth/invite/:token", async (req, res) => {
  const { token } = req.params;
  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.inviteToken, token));

    if (!user) {
      res.status(404).json({ error: "유효하지 않거나 만료된 초대 링크입니다." });
      return;
    }
    res.json({ email: user.email, name: user.name });
  } catch {
    res.status(500).json({ error: "초대 링크 확인 실패." });
  }
});

export default router;
