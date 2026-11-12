// 수정한 과거 CRM 이관 로직의 읽기 전용 검증 — 대상 DB(DIAG_DB_URL)에 BEGIN TRANSACTION READ ONLY 로만 접속한다.
//   1) 전환 미리보기(buildActivationPlan): 담당자 Master 이메일이 없을 때 거래처 이메일로 대체하지 않는지
//   2) 판매 담당자 연락처(saleContactInfo): 업무 표시 이메일이 거래처 이메일로 대체되지 않는지
//   3) 이름 기준 자동 연결 계획(planNameLinks): 이름만 일치하는 기존 Master 연결·신규 묶음이 예외로 분리되는지
// 실행: DIAG_DB_URL=... DIAG_SALE_NOS=판매번호,... pnpm run diag:crm-import-logic
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import { pool as appPool } from "@workspace/db";
import { buildActivationPlan } from "./services/legacySaleActivation";
import { saleContactInfo, planNameLinks, summarizeNameLinks } from "./services/legacyContactRestore";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL;
if (!url) { console.error("DIAG_DB_URL 필요"); process.exit(2); }

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  try {
    const [ro] = await q(sql`SELECT current_setting('transaction_read_only') ro`);
    if (ro.ro !== "on") throw new Error("읽기 전용 트랜잭션이 아닙니다 — 중단");
    const saleNos = (process.env.DIAG_SALE_NOS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    for (const saleNo of saleNos) {
      const [s] = await q(sql`SELECT id, company_name FROM legacy_archive_rows WHERE source_type = 'sales_list' AND is_effective AND source_raw->>'판매번호' = ${saleNo} LIMIT 1`);
      if (!s) { console.log(`${saleNo}: 판매행 없음`); continue; }
      const [m] = await q(sql`SELECT entity_id FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale_contact' AND status = 'active' AND legacy_id = ${saleNo}`);
      let plan: any = null;
      try { plan = await buildActivationPlan(dbx as any, Number(s.id)); } catch (e: any) { plan = { error: e?.message }; }
      const info = await saleContactInfo(dbx as any, saleNo, { companyId: plan?.company?.matchedId ?? null, companyName: s.company_name, linkedContactId: m ? Number(m.entity_id) : null, linkVia: null });
      console.log(JSON.stringify({ saleNo, activationPreview: plan?.error ? { error: plan.error } : { contact: plan.contact?.name, contactId: plan.contact?.matchedId, contactEmail: plan.contact?.email ?? null, emailFrom: plan.contact?.emailFrom ?? null, companyEmail: plan.company?.email ?? null },
        saleDetail: { linked: info.linked?.name ?? null, effectiveEmail: info.effectiveEmail, effectiveEmailFrom: info.effectiveEmailFrom, companyEmail: info.companyEmail } }));
    }
    const plan = await planNameLinks(dbx as any);
    console.log(JSON.stringify({ nameLinkPlan: summarizeNameLinks(plan) }, null, 2));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
