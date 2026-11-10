import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "../lib/rbac";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const JWT_SECRET = process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev";

export type UserRole = "admin" | "staff" | "client" | "linguist" | "customer" | "translator";

export interface JwtPayload {
  id: number;
  email: string;
  role: UserRole;
  roleId?: number | null;
  sessionId?: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

// 계정 상태 검증 — 삭제(휴지통)·비활성·영구 비식별 처리된 계정은 이미 발급된 JWT 로도 API 접근을 차단한다.
//   캐시를 두지 않는다: 차단 직후 첫 요청부터 거부되어야 하며(다중 인스턴스 포함), PK 조회 1회라 비용이 작다.
//   영구 비식별 처리 계정은 deletedAt·isActive=false 가 함께 설정되므로 이 조건으로 함께 차단된다.
async function loadAccountState(userId: number) {
  const [row] = await db
    .select({ isActive: usersTable.isActive, deletedAt: usersTable.deletedAt, role: usersTable.role, roleId: usersTable.roleId, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query?.token === "string" ? req.query.token : undefined;
  const raw = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;

  if (!raw) {
    res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <token>" });
    return;
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(raw, JWT_SECRET) as JwtPayload;
  } catch {
    res.status(401).json({ error: "토큰이 유효하지 않거나 만료되었습니다." });
    return;
  }

  let account: Awaited<ReturnType<typeof loadAccountState>>;
  try {
    account = await loadAccountState(payload.id);
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

  // 역할·RBAC 역할(roleId)·이메일은 토큰 발급 시점 값이 아니라 현재 DB 값을 쓴다.
  //   로그인 이후 관리자가 역할을 지정·변경해도 재로그인 없이 다음 요청부터 화면(/auth/permissions)과 API 권한에 함께 반영된다.
  req.user = { id: payload.id, email: account.email, role: account.role as UserRole, roleId: account.roleId ?? null, sessionId: payload.sessionId };
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
      res.status(403).json({ error: "역할이 지정되지 않았습니다." });
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
