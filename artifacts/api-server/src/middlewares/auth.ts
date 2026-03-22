import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev";

export interface JwtPayload {
  id: number;
  email: string;
  role: "customer" | "translator" | "admin";
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <token>" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    req.user = { id: payload.id, email: payload.email, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: "토큰이 유효하지 않거나 만료되었습니다." });
  }
}

export function requireRole(...roles: Array<"customer" | "translator" | "admin">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "인증이 필요합니다." });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: `접근 권한이 없습니다. 필요 역할: ${roles.join(", ")}` });
      return;
    }
    next();
  };
}
