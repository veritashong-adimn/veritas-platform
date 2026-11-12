// ─── [운영 작업 · 별도 승인 후 실행] 과거 CRM 전환 판매 전체 공통 복원 ─────────────────────────────
// [실행 이력] 2026-11-12 OPS_SALES=2026-08-28-0006,2026-11-04-0013 적용 완료(import_batches #106 품목 · #107 청구). 재실행 시 대상 0건.
// 실행: OPS_DB_URL=<env> OPS_OUT=<폴더> [OPS_SALES=판매번호,…] [OPS_COMMIT=1] pnpm run ops:repair-legacy-sales
//   · OPS_COMMIT=1 이 없으면 전체 검증 후 ROLLBACK(사전 점검). 하나라도 어긋나면 전체 ROLLBACK.
//   · 대상: 전환된 판매 전체(또는 OPS_SALES 지정) 중 auditConvertedSales 의 자동 복원 항목만(품목 수량·단가 / 세금계산서 발행정보 / 담당자 이메일).
//   · 이미 복원된 판매(킨텍스 등)는 already_restored·already_billed 로 대상에서 빠진다(재실행 안전).
//   · 불변 검증: 견적 금액·품목 공급가/부가세/총액·세금구분, 수행·지급, 기존 청구·입금 행, 수금거래, 판매 상태·거래처·담당자.
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { auditConvertedSales, summarizeAudit, applyConvertedSaleRepair } from "./services/legacySaleAudit";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.OPS_DB_URL, outDir = process.env.OPS_OUT, commit = process.env.OPS_COMMIT === "1";
const saleNos = (process.env.OPS_SALES ?? "").split(",").map(s => s.trim()).filter(Boolean);
if (!url || !outDir) { console.error("OPS_DB_URL, OPS_OUT 필요"); process.exit(2); }
const REASON = "과거 CRM 전환 판매 공통 복원(수량·단가 / 세금계산서 발행정보 / 담당자 이메일)";
class Abort extends Error {}

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  const report: any = { mode: commit ? "COMMIT" : "DRY_RUN(ROLLBACK)", reason: REASON, scope: saleNos.length ? saleNos : "전체", startedAt: new Date().toISOString(), checks: [] };
  const check = (label: string, ok: boolean, extra?: unknown) => { report.checks.push({ label, ok, ...(extra !== undefined ? { extra } : {}) }); if (!ok) throw new Abort(`검증 실패: ${label} ${extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ""}`); };
  const [admin] = await q(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active ORDER BY id LIMIT 1`);
  await client.query("BEGIN");
  try {
    await q(sql`SELECT pg_advisory_xact_lock(hashtext('legacy_sale_repair:all'))`);
    const pids = (await q(sql`SELECT p.id FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active'
      ${saleNos.length ? sql`AND m.legacy_id IN (${sql.join(saleNos.map(s => sql`${s}`), sql`, `)})` : sql``}`)).map(r => Number(r.id));
    check("대상 판매 조회", pids.length > 0 && (!saleNos.length || pids.length === saleNos.length), { pids: pids.length, requested: saleNos.length });
    const P = sql.join(pids.map(i => sql`${i}`), sql`, `);
    const frozen = async () => ({
      amounts: JSON.stringify(await q(sql`SELECT qi.id, qi.supply_amount, qi.tax_amount, qi.total_amount, qi.tax_type, q.price FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${P}) ORDER BY qi.id`)),
      perf: JSON.stringify(await q(sql`SELECT * FROM performance_assignments WHERE project_id IN (${P}) ORDER BY id`)),
      txn: JSON.stringify(await q(sql`SELECT * FROM payment_transactions WHERE project_id IN (${P}) ORDER BY id`)),
      proj: JSON.stringify(await q(sql`SELECT id, status, financial_status, company_id, contact_id FROM projects WHERE id IN (${P}) ORDER BY id`)),
      settle: JSON.stringify(await q(sql`SELECT * FROM settlements WHERE project_id IN (${P}) ORDER BY id`)),
      pays: await q(sql`SELECT * FROM project_payments WHERE project_id IN (${P}) ORDER BY id`),
    });
    const before = await audit(dbx);
    report.before = before.summary;
    const f0 = await frozen();

    const rep = await applyConvertedSaleRepair(dbx as any, { userId: admin.id, saleNos: saleNos.length ? saleNos : undefined, reason: REASON, executedVia: "ops-repair-legacy-sales" });
    report.applied = { targets: rep.targets, item: rep.item, billing: rep.billing, email: rep.email };
    check("품목 복원 수 = 계획", (rep.item?.restored ?? 0) === rep.targets.item.length, rep.item);
    check("청구 복원 수 = 계획", (rep.billing?.restored ?? 0) === rep.targets.billing.length, rep.billing);
    check("이메일 보완 수 = 계획", (rep.email?.filled ?? 0) === rep.targets.emailContacts.length, rep.email);

    const f1 = await frozen();
    check("금액(견적·품목 공급가/부가세/총액·세금구분) 불변", f1.amounts === f0.amounts);
    check("수행·지급 불변", f1.perf === f0.perf);
    check("수금거래 불변", f1.txn === f0.txn);
    check("정산 불변", f1.settle === f0.settle);
    check("판매 상태·재무상태·거래처·담당자 불변", f1.proj === f0.proj);
    const ids0 = new Set(f0.pays.map((p: any) => Number(p.id)));
    // 기존 행: 비어 있던 발행일만 채워질 수 있음 — 그 외 모든 칸(금액·입금상태·입금일 등) 동일
    const norm = (p: any, ref?: any) => ({ ...p, issue_date: ref && ref.issue_date == null ? null : p.issue_date, updated_at: null, updated_by: null });
    const b0 = new Map(f0.pays.map((p: any) => [Number(p.id), p]));
    check("기존 청구·입금 행 불변(비어 있던 발행일 채움 외)", f1.pays.filter((p: any) => ids0.has(Number(p.id))).every((p: any) => JSON.stringify(norm(p, b0.get(Number(p.id)))) === JSON.stringify(norm(b0.get(Number(p.id)), b0.get(Number(p.id))))));
    const added = f1.pays.filter((p: any) => !ids0.has(Number(p.id)));
    check("새 청구행 ≤ 발행정보 복원 대상 · 모두 입금예정(입금일 없음)", added.length <= rep.targets.billing.length && added.every((p: any) => p.deposit_status === "scheduled" && p.paid_date == null && !p.deposit_confirmed), added.length);
    const items = await q(sql`SELECT qi.quantity, qi.unit_price, qi.supply_amount FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${P})`);
    check("복원 후 수량 × 단가 = 공급가액(대상 판매 전 품목)", items.every(r => Math.abs(Number(r.quantity) * Number(r.unit_price) - Number(r.supply_amount)) <= 1),
      items.filter(r => Math.abs(Number(r.quantity) * Number(r.unit_price) - Number(r.supply_amount)) > 1).length);
    const after = await audit(dbx);
    check("복원 후 자동 복원 대상 0건", after.summary.perItem.item.auto === 0 && after.summary.perItem.billing.auto === 0 && after.summary.perItem.email.auto === 0, after.summary.perItem);
    report.after = after.summary;
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    report.result = commit ? "COMMITTED" : "ROLLED_BACK(사전 점검 통과)";
  } catch (e) {
    await client.query("ROLLBACK");
    report.result = "ABORTED"; report.error = e instanceof Error ? e.message : String(e);
  } finally {
    client.release(); await pool.end();
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, `ops-repair-legacy-sales-${commit ? "commit" : "dryrun"}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, error: report.error, targets: report.applied?.targets, checks: report.checks.map((c: any) => `${c.ok ? "OK" : "NG"} ${c.label}`) }, null, 2));
    if (report.result === "ABORTED") process.exit(1);
  }
  async function audit(d: any) { const list = await auditConvertedSales(d, { saleNos: saleNos.length ? saleNos : undefined }); return { summary: summarizeAudit(list) }; }
}
main();
