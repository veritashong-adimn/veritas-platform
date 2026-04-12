declare namespace Express {
  interface Request {
    user?: {
      id: number;
      email: string;
      role: "admin" | "staff" | "client" | "linguist" | "customer" | "translator";
      roleId?: number | null;
      sessionId?: string;
    };
  }
}
