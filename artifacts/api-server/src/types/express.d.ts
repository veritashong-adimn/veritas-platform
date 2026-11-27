declare namespace Express {
  interface Request {
    user?: {
      id: number;
      email: string;
      role: "admin" | "staff" | "client" | "linguist" | "customer" | "translator";
      roleId?: number | null;
      sessionId?: string;
      idleTimeoutMinutes?: number | null;   // 미사용 자동 로그아웃 시간(분) — 관리자 60·직원 30·그 외 null(lib/idlePolicy)
    };
  }
}
