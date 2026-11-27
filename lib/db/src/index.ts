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

// 연결 풀 — 연결 수립(WebSocket·TLS·인증)은 DB 왕복 여러 번이 들어 비싸므로 유휴 연결을 짧게 재사용한다.
//  · idleTimeoutMillis 60초: 기본값(10초)은 메뉴 이동 뒤 재조회 때마다 연결을 새로 만들게 했다.
//    5분(Neon 자동 일시중지 기준)보다 충분히 짧게 두어 유휴 연결이 DB 일시중지를 막지 않게 한다.
//  · max 20: 기본값 10 은 화면 1회 조회(동시 조회 최대 10건)만으로 가득 차 여러 직원이 동시에 조회하면 대기가 생겼다.
export const pool = new Pool({
  connectionString: dbUrl || "postgresql://localhost/placeholder",
  max: 20,
  idleTimeoutMillis: 60_000,
});

pool.on("error", (err: Error) => {
  console.error("[DB] Pool error (server continues):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
