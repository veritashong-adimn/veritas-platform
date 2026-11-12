// ─── 과거 CRM 전환 판매 전체 점검(읽기 전용) ───────────────────────────────────────────
// 실행: DIAG_DB_URL=<env> DIAG_OUT=<폴더> pnpm run diag:crm-sale-audit
//   BEGIN TRANSACTION READ ONLY 로만 조회 후 ROLLBACK. 접속 문자열은 출력하지 않는다.
//   전환된 판매 전체를 auditConvertedSales 로 점검 → 항목별 정상·자동 복원·수동 확인·복원 불가 건수와 판매별 상세(JSON)
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { auditConvertedSales, summarizeAudit } from "./services/legacySaleAudit";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL, outDir = process.env.DIAG_OUT;
if (!url || !outDir) { console.error("DIAG_DB_URL, DIAG_OUT 필요"); process.exit(2); }

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  try {
    if (((await dbx.execute(sql`SELECT current_setting('transaction_read_only') ro`)).rows[0] as any).ro !== "on") throw new Error("읽기 전용 아님 — 중단");
    const list = await auditConvertedSales(dbx as any);
    const summary = summarizeAudit(list);
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, "sale-audit.json"), JSON.stringify({ summary, sales: list }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.query("ROLLBACK"); client.release(); await pool.end();
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
