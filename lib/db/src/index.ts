import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error(
    "[DB] WARNING: DATABASE_URL is not set. DB queries will fail, but server will continue.",
  );
}

export const pool = new Pool({
  connectionString: dbUrl || "postgresql://localhost/placeholder",
});

pool.on("error", (err) => {
  console.error("[DB] Pool error (server continues):", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
