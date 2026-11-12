// 판매관리 '미연결 관리' 집계(읽기 전용) — 화면과 같은 buildRows 를 대상 DB 에 READ ONLY 트랜잭션으로 실행 후 ROLLBACK.
// 실행: DIAG_DB_URL=<env> pnpm run diag:crm-party-manage
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import { pool as appPool } from "@workspace/db";
import { buildRows, STATUS_LABEL } from "./routes/legacyPartyManage";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL; if (!url) { console.error("DIAG_DB_URL 필요"); process.exit(2); }
async function main() {
  const pool = new Pool({ connectionString: url! }); const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY"); const dbx = drizzle(client as any);
  try {
    if (((await dbx.execute(sql`SELECT current_setting('transaction_read_only') ro`)).rows[0] as any).ro !== "on") throw new Error("읽기 전용 아님");
    const all = await buildRows(dbx);
    const by = (src: (r: any) => boolean) => Object.fromEntries(Object.keys(STATUS_LABEL).map(s => [STATUS_LABEL[s as keyof typeof STATUS_LABEL], all.filter(r => r.status === s && src(r)).length]));
    console.log(JSON.stringify({ legacy: all.filter(r => r.source !== "platform").length, legacyByStatus: by(r => r.source !== "platform"), platformUnlinked: by(r => r.source === "platform"),
      watch: all.filter(r => r.watchNote).map(r => `${r.saleNo} ${r.status} — ${r.watchNote}`).slice(0, 20) }, null, 2));
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
