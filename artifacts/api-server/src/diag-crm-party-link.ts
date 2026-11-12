// 과거 CRM 판매 거래처·담당자 연결 진단(읽기 전용) — planPartyLinks 를 대상 DB 에 READ ONLY 트랜잭션으로 실행하고 ROLLBACK.
// 실행: DIAG_DB_URL=<env> DIAG_OUT=<폴더> pnpm run diag:crm-party-link
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { planPartyLinks, summarizePartyLinks } from "./services/legacyPartyLink";

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
    const list = await planPartyLinks(dbx as any);
    const summary = summarizePartyLinks(list);
    fs.mkdirSync(outDir!, { recursive: true });
    const flat = list.map(r => ({ saleNo: r.saleNo, category: r.category, issues: [...new Set(r.issues)].join(","), converted: r.converted, rawCompany: r.rawCompany,
      companyId: r.company.id, companyName: r.company.name, companyVia: r.company.via, companyCandidates: r.company.candidates?.join("/") ?? null,
      customerName: r.customerName, sourcePhones: r.sourcePhones.join("/"), sourceEmail: r.sourceEmail,
      linkedId: r.linked?.contactId ?? null, linkedName: r.linked?.name ?? null, linkedVia: r.linked?.via ?? null, linkedCheck: r.linked?.check ?? null,
      proposalId: r.proposal?.contactId ?? null, proposalName: r.proposal?.name ?? null, proposalBasis: r.proposal?.basis ?? null,
      alias: r.alias?.alias ?? null, supplement: r.supplement ? `${r.supplement.field}:${r.supplement.value}→#${r.supplement.contactId}` : null, detail: r.detail }));
    const cols = Object.keys(flat[0] ?? {});
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(path.join(outDir!, "crm_party_link_diag.csv"), "﻿" + [cols.join(","), ...flat.map(o => cols.map(c => cell((o as any)[c])).join(","))].join("\n"));
    fs.writeFileSync(path.join(outDir!, "crm_party_link_summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
