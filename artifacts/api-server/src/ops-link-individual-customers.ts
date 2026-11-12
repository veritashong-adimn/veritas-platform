// ─── [운영 작업] 과거 CRM 개인고객 표기 → 기존 개인고객 Master 연결(1회성, 관리자 승인) ─────────────────────
// 승인 범위: 거래처 별칭 6개(판매 7건 — '개인고객(최리나)' 판매 2건 포함). 기존 applyPartyLinks 재사용.
// 변경: company_aliases 6행 추가뿐. 거래처·담당자 Master 값, 담당자 연결, 판매·견적·수행·청구·입금·정산, 과거 CRM 원본 불변.
// 실행: OPS_DB_URL=<env> OPS_OUT=<폴더> [OPS_COMMIT=1] pnpm run ops:link-individual-customers  (OPS_COMMIT 없으면 검증 후 ROLLBACK)
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { planPartyLinks, applyPartyLinks, PARTY_LINK_MODULE } from "./services/legacyPartyLink";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.OPS_DB_URL, outDir = process.env.OPS_OUT, commit = process.env.OPS_COMMIT === "1";
if (!url || !outDir) { console.error("OPS_DB_URL, OPS_OUT 필요"); process.exit(2); }
const REASON = "과거 CRM 개인고객 표기 차이 — 기존 개인고객 Master 연결(관리자 승인, 별칭 6개)";
// 승인 범위(이전 진단): 판매번호 → [과거 CRM 표기, 개인고객 Master id, Master 이름]
const APPROVED: Record<string, [string, number, string]> = {
  "2026-06-23-0006": ["개인고객(최리나)", 752, "최리나"], "2024-08-26-0005": ["개인고객(최리나)", 752, "최리나"],
  "2026-03-12-0004": ["김완식(개인고객)", 776, "김완식"], "2025-12-24-0002": ["강성윤(개인고객)", 775, "강성윤"],
  "2024-04-19-0002": ["개인고객(안인균)", 746, "안인균"], "2023-11-22-0002": ["개인고객(문달주)", 733, "문달주"],
  "2018-10-12-0010": ["개인고객(김완용)", 725, "김완용"],
};
class Abort extends Error {}

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  const report: any = { mode: commit ? "COMMIT" : "DRY_RUN(ROLLBACK)", reason: REASON, startedAt: new Date().toISOString(), checks: [], targets: [] };
  const check = (label: string, ok: boolean, extra?: unknown) => { report.checks.push({ label, ok, ...(extra !== undefined ? { extra } : {}) }); if (!ok) throw new Abort(`검증 실패: ${label} ${extra !== undefined ? JSON.stringify(extra) : ""}`); };
  const saleNos = Object.keys(APPROVED);
  const coIds = [...new Set(Object.values(APPROVED).map(v => v[1]))];
  const L = (xs: Array<number | string>) => sql.join(xs.map(x => sql`${x}`), sql`, `);
  await client.query("BEGIN");
  try {
    // 1) 승인 범위 대조 — 개인고객 Master(이름·유형·살아 있음·동명 1곳), 판매 원본 표기, 계획 결과
    const cos = await q(sql`SELECT id, name, customer_type, phone, mobile, email, deleted_at FROM companies WHERE id IN (${L(coIds)}) FOR UPDATE`);
    for (const id of coIds) {
      const c = cos.find(x => Number(x.id) === id); const nm = Object.values(APPROVED).find(v => v[1] === id)![2];
      check(`Master #${id} ${nm}: 개인고객·살아 있음·이름 일치`, !!c && c.customer_type === "INDIVIDUAL" && c.deleted_at == null && c.name === nm, c);
      const [dup] = await q(sql`SELECT count(*) n FROM companies WHERE deleted_at IS NULL AND customer_type = 'INDIVIDUAL' AND regexp_replace(name, '\s', '', 'g') = ${nm}`);
      check(`Master ${nm}: 같은 이름 개인고객 1곳`, Number(dup.n) === 1, dup);
    }
    const plan = new Map((await planPartyLinks(dbx as any, { saleNos })).map(r => [String(r.saleNo), r]));
    for (const s of saleNos) {
      const r = plan.get(s); const [raw, id] = APPROVED[s];
      check(`${s}: 계획 F · 원본 표기 '${raw}' · 대상 Master #${id} · 별칭 제안`, !!r && r.category === "F" && r.rawCompany === raw && r.company.id === id && r.alias?.companyId === id && r.alias?.alias === raw && !r.converted, r && { category: r.category, raw: r.rawCompany, company: r.company, alias: r.alias });
      check(`${s}: 담당자 연결 제안 없음`, !r!.proposal);
      report.targets.push({ saleNo: s, rawCompany: raw, companyBefore: null, companyAfter: { id, name: APPROVED[s][2] } });
    }

    // 2) 변경 전 스냅샷
    const snap = async () => ({
      companies: await q(sql`SELECT * FROM companies WHERE id IN (${L(coIds)}) ORDER BY id`),
      aliases: await q(sql`SELECT id, company_id, alias_name, normalized_alias, is_primary FROM company_aliases WHERE company_id IN (${L(coIds)}) ORDER BY id`),
      contactsOfTargets: await q(sql`SELECT * FROM contacts WHERE company_id IN (${L(coIds)}) ORDER BY id`),
      saleMappings: await q(sql`SELECT * FROM legacy_master_mappings WHERE legacy_id IN (${L(saleNos)}) ORDER BY id`),
      legacyRows: await q(sql`SELECT id, row_hash, source_raw FROM legacy_archive_rows WHERE source_type = 'sales_list' AND source_raw->>'판매번호' IN (${L(saleNos)}) ORDER BY id`),
      global: await q(sql`SELECT (SELECT count(*) FROM companies) companies, (SELECT count(*) FROM contacts) contacts,
        (SELECT md5(string_agg(id||':'||name||coalesce(email,'')||coalesce(phone,'')||coalesce(mobile,'')||coalesce(office_phone,'')||company_id, ',' ORDER BY id)) FROM contacts) contacts_md5,
        (SELECT count(*) FROM legacy_master_mappings) mappings, (SELECT md5(string_agg(id||':'||entity_id||status, ',' ORDER BY id)) FROM legacy_master_mappings) mappings_md5,
        (SELECT count(*) FROM company_aliases) aliases, (SELECT count(*) FROM projects) projects, (SELECT count(*) FROM quotes) quotes, (SELECT count(*) FROM quote_items) items,
        (SELECT count(*) FROM performance_assignments) perf, (SELECT count(*) FROM project_payments) pp, (SELECT count(*) FROM payment_transactions) pt,
        (SELECT count(*) FROM settlements) st, (SELECT count(*) FROM payout_round_items) pri, (SELECT count(*) FROM legacy_archive_rows) legacy`),
    });
    const before = await snap();
    fs.mkdirSync(outDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(outDir!, `indlink_before_${stamp}.json`), JSON.stringify(before, null, 2));

    // 3) 적용(기존 로직 재사용 — 기본 근거: 담당자 연결은 이메일·연락처 일치만, 대상 판매에는 담당자 제안 없음)
    const res = await applyPartyLinks(dbx as any, { userId: null, saleNos, reason: REASON });
    report.result = res;
    check("별칭 6개 추가 · 담당자 연결 0건", res.aliases === 6 && res.links === 0, res);

    // 4) 변경 범위 검증
    const after = await snap();
    const g0 = before.global[0], g1 = after.global[0];
    for (const k of Object.keys(g0)) check(`전역 ${k} ${k === "aliases" ? "+6" : "불변"}`, k === "aliases" ? Number(g1[k]) === Number(g0[k]) + 6 : JSON.stringify(g0[k]) === JSON.stringify(g1[k]), { before: g0[k], after: g1[k] });
    for (const k of ["companies", "contactsOfTargets", "saleMappings", "legacyRows"] as const) check(`불변: ${k}`, JSON.stringify(before[k]) === JSON.stringify(after[k]));
    const added = after.aliases.filter((a: any) => !before.aliases.some((b: any) => b.id === a.id));
    check("추가 별칭 = 승인 표기 6개(대상 Master 에만, 기본 별칭 아님)", added.length === 6 && added.every((a: any) => !a.is_primary
      && Object.values(APPROVED).some(v => v[0] === a.alias_name && v[1] === Number(a.company_id))), added);
    const replan = new Map((await planPartyLinks(dbx as any, { saleNos })).map(r => [String(r.saleNo), r]));
    for (const s of saleNos) check(`${s}: 적용 후 기존 개인고객 Master #${APPROVED[s][1]} 로 인식(A)`, replan.get(s)?.category === "A" && replan.get(s)?.company.id === APPROVED[s][1] && replan.get(s)?.company.via === "existing", replan.get(s)?.company);
    const audit = await q(sql`SELECT entity_id, status, legacy_id, source_raw FROM import_row_sources WHERE batch_id = ${res.batchId} AND module = ${PARTY_LINK_MODULE}`);
    check("감사기록 6건(별칭·대상 Master·판매번호)", audit.length === 6 && audit.every(a => a.status === "alias_added"));
    report.added = added; report.batchId = res.batchId;
    fs.writeFileSync(path.join(outDir!, `indlink_after_${stamp}.json`), JSON.stringify(after, null, 2));
    if (commit) { await client.query("COMMIT"); report.committed = true; } else { await client.query("ROLLBACK"); report.committed = false; }
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {}); report.committed = false; report.error = e?.message ?? String(e);
  } finally {
    client.release(); await pool.end();
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, `indlink_report_${commit ? "commit" : "dryrun"}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ mode: report.mode, committed: report.committed, error: report.error ?? null, checks: report.checks.length,
      failed: report.checks.filter((c: any) => !c.ok), batchId: report.batchId ?? null, added: report.added?.map((a: any) => `${a.alias_name} → #${a.company_id} (alias #${a.id})`) }, null, 2));
  }
  process.exit(report.error ? 1 : 0);
}
main();
