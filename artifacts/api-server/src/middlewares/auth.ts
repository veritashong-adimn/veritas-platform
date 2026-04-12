import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "../lib/rbac";

const JWT_SECRET = process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev";

export type UserRole = "admin" | "staff" | "client" | "linguist" | "customer" | "translator";

export interface JwtPayload {
  id: number;
  email: string;
  role: UserRole;
  roleId?: number | null;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query?.token === "string" ? req.query.token : undefined;
  const raw = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;

  if (!raw) {
    res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <token>" });
    return;
  }

  try {
    const payload = jwt.verify(raw, JWT_SECRET) as JwtPayload;
    req.user = { id: payload.id, email: payload.email, role: payload.role, roleId: payload.roleId ?? null };
    next();
  } catch {
    res.status(401).json({ error: "토큰이 유효하지 않거나 만료되었습니다." });
  }
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
