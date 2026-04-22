import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

// Node.js 환경(비 엣지)에서는 WebSocket 생성자를 명시적으로 지정해야 함
neonConfig.webSocketConstructor = ws;

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error(
    "[DB] WARNING: DATABASE_URL is not set. DB queries will fail, but server will continue.",
  );
}

export const pool = new Pool({
  connectionString: dbUrl || "postgresql://localhost/placeholder",
});

pool.on("error", (err: Error) => {
  console.error("[DB] Pool error (server continues):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
