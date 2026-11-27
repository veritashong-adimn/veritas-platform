import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "../lib/rbac";
import { db, usersTable, rolesTable, userSessionsTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { idleTimeoutMinutes, checkSession } from "../lib/idlePolicy";

// 서명 키 — 운영(NODE_ENV=production)에서는 환경변수 JWT_SECRET 만 사용한다. 없으면 공개된 개발용 기본키로 동작하지 않고
//   토큰 발급·인증을 모두 거부한다(fail-closed: 개발용 키로 만든 토큰이 운영 인증을 통과하는 일을 원천 차단).
const DEV_JWT_SECRET = "translation-platform-jwt-secret-dev";
const JWT_SECRET: string | null = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? null : DEV_JWT_SECRET);
if (!JWT_SECRET) console.error("[auth] FATAL: 운영환경에 JWT_SECRET 이 설정되지 않아 로그인·인증을 모두 거부합니다.");

export type UserRole = "admin" | "staff" | "client" | "linguist" | "customer" | "translator";

export interface JwtPayload {
  id: number;
  email: string;
  role: UserRole;
  roleId?: number | null;
  sessionId?: string;
}

export const authConfigured = (): boolean => !!JWT_SECRET;

// 로그인 세션 토큰 발급 — sessionId(user_sessions 행)가 반드시 있어야 한다. 세션 없는 토큰은 발급하지 않는다.
export function signToken(payload: JwtPayload & { sessionId: string }): string {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not configured");
  if (!payload.sessionId) throw new Error("signToken: sessionId required");
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

// 계정 상태 검증 — 삭제(휴지통)·비활성·영구 비식별 처리된 계정은 이미 발급된 JWT 로도 API 접근을 차단한다.
//   캐시를 두지 않는다: 차단 직후 첫 요청부터 거부되어야 하며(다중 인스턴스 포함), PK 조회 1회라 비용이 작다.
//   영구 비식별 처리 계정은 deletedAt·isActive=false 가 함께 설정되므로 이 조건으로 함께 차단된다.
//   세션(로그인 1회 = user_sessions 1행)도 같은 조회에서 함께 읽는다(추가 DB 왕복 없음): 로그아웃·미사용 만료 세션의 토큰 차단.
async function loadAccountState(userId: number, sessionId: string | undefined) {
  const [row] = await db
    .select({ isActive: usersTable.isActive, deletedAt: usersTable.deletedAt, role: usersTable.role, roleId: usersTable.roleId, email: usersTable.email,
      passwordChangedAt: usersTable.passwordChangedAt, mustChangePassword: usersTable.mustChangePassword,
      roleName: rolesTable.name,
      sessionRowId: userSessionsTable.id, sessionLogoutAt: userSessionsTable.logoutAt, sessionLastActivityAt: userSessionsTable.lastActivityAt })
    .from(usersTable)
    .leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
    .leftJoin(userSessionsTable, sessionId
      ? and(eq(userSessionsTable.sessionId, sessionId), eq(userSessionsTable.userId, usersTable.id))
      : sql`false`)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row;
}

// 미사용 만료 세션 종료 기록(1회) — 이미 종료된 세션은 건드리지 않는다. 실패해도 요청은 이미 거부된다.
async function closeExpiredSession(userId: number, sessionId: string) {
  await db.update(userSessionsTable).set({ logoutAt: new Date(), isOnline: false })
    .where(and(eq(userSessionsTable.userId, userId), eq(userSessionsTable.sessionId, sessionId), isNull(userSessionsTable.logoutAt)));
}

const SESSION_ERRORS = {
  missing: { error: "로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.", code: "SESSION_INVALID" },
  logged_out: { error: "로그아웃된 세션입니다. 다시 로그인해 주세요.", code: "SESSION_ENDED" },
  expired: { error: "장시간 사용하지 않아 자동 로그아웃되었습니다. 다시 로그인해 주세요.", code: "SESSION_EXPIRED" },
} as const;

const PASSWORD_CHANGE_ALLOWED = ["/api/auth/change-password", "/api/auth/permissions", "/api/auth/logout", "/api/auth/heartbeat"];

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query?.token === "string" ? req.query.token : undefined;
  const raw = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;

  if (!raw) {
    res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <token>" });
    return;
  }

  if (!JWT_SECRET) {
    res.status(503).json({ error: "인증 설정 오류로 로그인할 수 없습니다. 관리자에게 문의하세요." });
    return;
  }
  let payload: JwtPayload & { iat?: number };
  try {
    payload = jwt.verify(raw, JWT_SECRET) as JwtPayload & { iat?: number };
  } catch {
    res.status(401).json({ error: "토큰이 유효하지 않거나 만료되었습니다." });
    return;
  }
  // 로그인 세션 필수 — 모든 인증 토큰은 user_sessions 행과 연결된 sessionId 를 가져야 한다(내부·외부 계정 공통, 예외 없음).
  //   세션 없는 토큰(구 회원가입 토큰·서명키로 직접 만든 토큰)은 DB 조회 전에 거부한다.
  if (typeof payload.sessionId !== "string" || !payload.sessionId || !Number.isInteger(payload.id)) {
    res.status(401).json({ error: "로그인 세션이 없는 인증입니다. 다시 로그인해 주세요.", code: "SESSION_REQUIRED" });
    return;
  }

  let account: Awaited<ReturnType<typeof loadAccountState>>;
  try {
    account = await loadAccountState(payload.id, payload.sessionId);
  } catch (err) {
    // 상태를 확인할 수 없으면 허용하지 않는다(fail-closed).
    req.log?.error?.({ err }, "requireAuth: account state lookup failed");
    res.status(503).json({ error: "인증 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요." });
    return;
  }
  if (!account || account.deletedAt || !account.isActive) {
    req.log?.warn?.({ userId: payload.id, reason: !account ? "not_found" : account.deletedAt ? "deleted" : "inactive" }, "requireAuth: blocked account token");
    res.status(401).json({ error: "사용할 수 없는 계정입니다. 다시 로그인하거나 관리자에게 문의하세요.", code: "ACCOUNT_BLOCKED" });
    return;
  }

  // 비밀번호 변경 이전에 발급된 토큰 거부 — 본인 비밀번호 변경 시 다른 기기·탭의 기존 세션을 모두 무효화한다.
  if (account.passwordChangedAt && typeof payload.iat === "number" && payload.iat < Math.floor(account.passwordChangedAt.getTime() / 1000)) {
    res.status(401).json({ error: "비밀번호가 변경되어 다시 로그인해야 합니다.", code: "TOKEN_REVOKED" });
    return;
  }
  // 로그인 세션 검증 — 로그인 토큰은 모두 sessionId 를 가진다(로그인 시 user_sessions 기록 후 발급).
  //   · 로그아웃(또는 비밀번호 변경·계정 정리로 종료)된 세션의 토큰 → 거부
  //   · 관리자 60분·직원 30분 동안 실제 사용자 활동(heartbeat 보고)이 없으면 만료 → 세션 종료 기록 후 거부(연장으로 복구 불가)
  const idleMin = idleTimeoutMinutes(account.role, account.roleName);
  {
    const state = checkSession({ exists: account.sessionRowId != null, logoutAt: account.sessionLogoutAt ?? null, lastActivityAt: account.sessionLastActivityAt ?? null }, idleMin, Date.now());
    if (state !== "active") {
      if (state === "expired") await closeExpiredSession(payload.id, payload.sessionId).catch(err => req.log?.error?.({ err }, "requireAuth: close expired session failed"));
      res.status(401).json(SESSION_ERRORS[state]);
      return;
    }
  }
  // 인증 API 응답은 브라우저·중간 캐시에 저장하지 않는다(로그아웃 후 뒤로가기·캐시로 업무자료 노출 방지)
  res.setHeader("Cache-Control", "no-store");
  // 임시 비밀번호 계정 — 비밀번호 변경 전에는 변경·권한 조회·로그아웃·활동 기록 외 API 사용 불가(서버 강제)
  if (account.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.some(p => (req.originalUrl ?? "").split("?")[0] === p)) {
    res.status(403).json({ error: "임시 비밀번호로 로그인했습니다. 비밀번호를 먼저 변경해 주세요.", code: "PASSWORD_CHANGE_REQUIRED" });
    return;
  }

  // 역할·RBAC 역할(roleId)·이메일은 토큰 발급 시점 값이 아니라 현재 DB 값을 쓴다.
  //   로그인 이후 관리자가 역할을 지정·변경해도 재로그인 없이 다음 요청부터 화면(/auth/permissions)과 API 권한에 함께 반영된다.
  req.user = { id: payload.id, email: account.email, role: account.role as UserRole, roleId: account.roleId ?? null, sessionId: payload.sessionId, idleTimeoutMinutes: idleMin };
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "인증이 필요합니다." });
      return;
    }
    if (!roles.includes(req.user.role as UserRole)) {
      res.status(403).json({ error: `접근 권한이 없습니다. 필요 역할: ${roles.join(", ")}` });
      return;
    }
    next();
  };
}

/**
 * RBAC 권한 체크 미들웨어
 * - admin (roleId 없음) → 전체 권한 허용 (하위 호환)
 * - staff / admin (roleId 있음) → 해당 역할의 권한 목록에서 key 확인
 */
// 역할(roleId)이 지정된 사용자는 권한 키를 서버에서 검증하고, 역할 미지정 기존 사용자(슈퍼관리자·역할 미지정 직원)는
// 기존과 같이 통과시킨다 — 그동안 adminGuard 만 적용되던 저장 API 에 권한 검증을 더하면서 기존 권한체계를 유지하기 위함.
export function requireRolePermission(key: string) {
  const strict = requirePermission(key);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: "인증이 필요합니다." }); return; }
    if (!req.user.roleId) { next(); return; }
    return strict(req, res, next);
  };
}

export function requirePermission(key: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "인증이 필요합니다." });
      return;
    }

    if (req.user.role === "admin" && !req.user.roleId) {
      next();
      return;
    }

    if (!req.user.roleId) {
      // 역할 미지정 직원 — 원인과 조치를 함께 안내(응답 형태 {error} 유지, code·permission 은 추가 필드).
      res.status(403).json({ error: `권한이 없습니다: ${key} (이 계정에 역할이 지정되지 않았습니다. 관리자에게 사용자관리에서 역할 지정을 요청하세요)`, code: "ROLE_NOT_ASSIGNED", permission: key });
      return;
    }

    try {
      const perms = await getPermissionsForRole(req.user.roleId);
      if (!perms.has(key)) {
        res.status(403).json({ error: `권한이 없습니다: ${key}` });
        return;
      }
      next();
    } catch {
      res.status(500).json({ error: "권한 확인 중 오류가 발생했습니다." });
    }
  };
}

/**
 * 직원 실행권한 검증(업무 메뉴 공용).
 *  · admin 계정: 기존과 동일하게 전체 허용.
 *  · staff + 역할(roleId): keys 중 하나라도 역할에 있어야 허용, 없으면 403.
 *  · staff + 역할 미지정: allowStaffWithoutRole 일 때만 허용(기존에 adminGuard 로 허용되던 조회·공용 업무 흐름 유지).
 *  · 그 외 역할: 403.
 */
export function requireStaffPermission(keys: string | string[], opts: { allowStaffWithoutRole?: boolean } = {}) {
  const list = Array.isArray(keys) ? keys : [keys];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const u = req.user;
    if (!u) { res.status(401).json({ error: "인증이 필요합니다." }); return; }
    if (u.role === "admin") { next(); return; }
    if (u.role !== "staff") { res.status(403).json({ error: "권한이 없습니다." }); return; }
    if (!u.roleId) {
      if (opts.allowStaffWithoutRole) { next(); return; }
      res.status(403).json({ error: `권한이 없습니다: ${list[0]} (역할이 지정되지 않았습니다)`, code: "PERMISSION_DENIED", permission: list[0] }); return;
    }
    try {
      const perms = await getPermissionsForRole(u.roleId);
      if (!list.some(k => perms.has(k))) {
        res.status(403).json({ error: `권한이 없습니다: ${list[0]}`, code: "PERMISSION_DENIED", permission: list[0] }); return;
      }
      next();
    } catch {
      res.status(500).json({ error: "권한 확인 중 오류가 발생했습니다." });
    }
  };
}
