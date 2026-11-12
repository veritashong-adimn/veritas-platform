// ─── [운영 작업 · 승인 후 실행] 킨텍스 과거 CRM 판매 2026-06-22-0003(Q000049 · 화면 Q260622-049) 보정 ──────────────
// [실행 완료 2026-11-12 · import_batches #99(재연결) #100(품목) #101(청구) — 재실행 금지] 재실행 시 '현재 연결 3183/5161' 검증에서 중단된다.
// 실행: OPS_DB_URL=<env> OPS_OUT=<폴더> [OPS_BILLING=1] [OPS_COMMIT=1] pnpm run ops:repair-kintex-sale
//   · OPS_COMMIT=1 이 없으면 전체 검증 후 ROLLBACK(사전 점검). 하나라도 어긋나면 전체 ROLLBACK.
//   · OPS_BILLING=1 일 때만 세금계산서 발행정보(청구 1회차) 복원 — 실제 발행 증빙(42,000,000원·부가세 0·2026-11-09) 확인 후 별도 승인.
// 순서: ① 거래처·담당자 재연결(3183/5161 → 3739/7253, 이전 Master 보존) ② 견적 품목 105 × 400,000 ③ (선택) 청구정보
// 판매금액·수행(36건)·지급·입금·정산은 바꾸지 않는다(전후 스냅샷 비교). 되돌리기: 각 배치 rollback 함수.
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { applyItemRestore, planItemRestore } from "./services/legacyQuoteItemRestore";
import { applyBillingRestore, planBillingRestore, relinkSaleParty } from "./services/legacySaleRepair";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.OPS_DB_URL, outDir = process.env.OPS_OUT, commit = process.env.OPS_COMMIT === "1", billing = process.env.OPS_BILLING === "1";
if (!url || !outDir) { console.error("OPS_DB_URL, OPS_OUT 필요"); process.exit(2); }
const SALE = "2026-06-22-0003", REASON = "킨텍스 과거 CRM 이관 오류 보정(판매수량·담당자·발행정보)";
const BASIS = "통역사 35명 × 3일 = 105";   // 사용자 확정 정보(원본 Excel 에는 산출 근거 칸 없음)
const EXPECT = { projectId: 118, quoteId: 123, quoteNumber: "Q000049", itemId: 286, oldCompany: 3183, oldContact: 5161, newCompany: 3739, newContact: 7253,
  brn: "128-81-78009", email: "youra37@kintex.com" };
class Abort extends Error {}

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  const report: any = { mode: commit ? "COMMIT" : "DRY_RUN(ROLLBACK)", billing, reason: REASON, startedAt: new Date().toISOString(), checks: [] };
  const check = (label: string, ok: boolean, extra?: unknown) => { report.checks.push({ label, ok, ...(extra !== undefined ? { extra } : {}) }); if (!ok) throw new Abort(`검증 실패: ${label} ${extra !== undefined ? JSON.stringify(extra) : ""}`); };
  const [admin] = await q(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active ORDER BY id LIMIT 1`);
  const P = EXPECT.projectId;
  const frozen = async () => JSON.stringify({
    perf: await q(sql`SELECT * FROM performance_assignments WHERE project_id = ${P} ORDER BY id`),
    tx: await q(sql`SELECT * FROM payment_transactions WHERE project_id = ${P} ORDER BY id`),
    quote: await q(sql`SELECT price, status, is_current FROM quotes WHERE id = ${EXPECT.quoteId}`),
    amounts: await q(sql`SELECT supply_amount, tax_amount, total_amount FROM quote_items WHERE quote_id = ${EXPECT.quoteId} ORDER BY id`),
    oldMaster: await q(sql`SELECT * FROM contacts WHERE id = ${EXPECT.oldContact}`), oldCompany: await q(sql`SELECT * FROM companies WHERE id = ${EXPECT.oldCompany}`),
    status: await q(sql`SELECT financial_status FROM projects WHERE id = ${P}`),
    ...(billing ? {} : { pay: await q(sql`SELECT * FROM project_payments WHERE project_id = ${P} ORDER BY id`) }),
  });
  await client.query("BEGIN");
  try {
    // 0) 대상 대조
    const [m] = await q(sql`SELECT entity_id FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale' AND status='active' AND legacy_id = ${SALE}`);
    check("판매번호 → 프로젝트 118", Number(m?.entity_id) === P, m);
    const [pr] = await q(sql`SELECT company_id, contact_id FROM projects WHERE id = ${P} FOR UPDATE`);
    check("현재 연결 3183/5161", Number(pr.company_id) === EXPECT.oldCompany && Number(pr.contact_id) === EXPECT.oldContact, pr);
    const [qt] = await q(sql`SELECT quote_number, is_current FROM quotes WHERE id = ${EXPECT.quoteId} AND project_id = ${P} AND deleted_at IS NULL`);
    check("견적 Q000049 현재 견적", qt?.quote_number === EXPECT.quoteNumber && qt.is_current === true, qt);
    const cos = await q(sql`SELECT id, name, business_number FROM companies WHERE id IN (${EXPECT.oldCompany}, ${EXPECT.newCompany}) AND deleted_at IS NULL ORDER BY id`);
    check("거래처: 3183 킨텍스(사업자번호 없음) · 3739 (주)킨텍스 128-81-78009", cos.length === 2 && !cos[0].business_number && cos[1].business_number === EXPECT.brn, cos);
    const al = await q(sql`SELECT company_id FROM company_aliases WHERE normalized_alias = '킨텍스' AND company_id IN (${EXPECT.oldCompany}, ${EXPECT.newCompany})`);
    check("두 거래처가 같은 정규화 거래처명(킨텍스)", al.length === 2);
    const [nc] = await q(sql`SELECT company_id, name, email, phone, position FROM contacts WHERE id = ${EXPECT.newContact} AND deleted_at IS NULL`);
    check("담당자 7253: 3739 소속 · 김유라과장 · youra37@kintex.com", Number(nc?.company_id) === EXPECT.newCompany && nc.name === "김유라과장" && nc.email === EXPECT.email, nc);
    const [oc] = await q(sql`SELECT company_id, name, phone FROM contacts WHERE id = ${EXPECT.oldContact}`);
    check("담당자 5161: 3183 소속 · 김유라 · 031-995-8845(원본 연락처)", Number(oc.company_id) === EXPECT.oldCompany && oc.name === "김유라" && oc.phone === "0319958845", oc);
    const ip = (await planItemRestore(dbx as any, { saleNos: [SALE] }))[0];
    check("품목 계획: 1 × 42,000,000 → 105 × 400,000", ip?.status === "restorable" && ip.itemId === EXPECT.itemId && ip.after?.quantity === 105 && ip.after?.unitPrice === 400000 && ip.before?.supplyAmount === 42000000 && ip.before?.taxAmount === 0, ip);
    const bp = (await planBillingRestore(dbx as any, { saleNos: [SALE] }))[0];
    if (billing) check("청구 계획: 2026-11-09 · 42,000,000 · 부가세 0 · 기존 청구 없음", bp?.status === "restorable" && bp.after?.issueDate === "2026-11-09" && bp.after?.amount === 42000000 && bp.after?.vat === 0 && !bp.payments.length, bp);
    report.before = { project: pr, item: ip.before, billing: bp, contacts: { old: oc, new: nc } };
    const f0 = await frozen();

    // ① 재연결 ② 품목 ③ 청구(선택)
    const rel = await relinkSaleParty(dbx as any, { saleNo: SALE, companyId: EXPECT.newCompany, contactId: EXPECT.newContact,
      contactPatch: { expectName: "김유라과장", name: "김유라", position: "과장", phone: "031-995-8845" }, fillQuoteEmail: true }, { userId: admin.id, reason: REASON, executedVia: "ops-repair-kintex-sale" });
    const it = await applyItemRestore(dbx as any, { userId: admin.id, saleNos: [SALE], reason: REASON, executedVia: "ops-repair-kintex-sale", basisNotes: { [SALE]: BASIS } });
    check("품목 1건 복원", it.restored === 1, it);
    const bl = billing ? await applyBillingRestore(dbx as any, { userId: admin.id, saleNos: [SALE], reason: REASON, executedVia: "ops-repair-kintex-sale" }) : null;
    if (billing) check("청구 1건 복원", bl?.restored === 1, bl);

    // 사후 검증
    const [a] = await q(sql`SELECT quantity, unit, unit_price, supply_amount, tax_amount, total_amount, memo FROM quote_items WHERE id = ${EXPECT.itemId}`);
    check("품목 105 × 400,000 · 단위 건 · 근거 비고 · 수량×단가 = 공급가액", Number(a.quantity) === 105 && Number(a.unit_price) === 400000 && a.unit === "건" && a.memo === BASIS && Number(a.quantity) * Number(a.unit_price) === Number(a.supply_amount), a);
    const [ap] = await q(sql`SELECT p.company_id, p.contact_id, q.customer_contact_email e, c.name, c.position, c.phone FROM projects p JOIN quotes q ON q.id = ${EXPECT.quoteId} JOIN contacts c ON c.id = p.contact_id WHERE p.id = ${P}`);
    check("판매 → 3739/7253 · 견적 수신자 이메일 youra37 · 담당자 김유라(과장)", Number(ap.company_id) === EXPECT.newCompany && Number(ap.contact_id) === EXPECT.newContact && ap.e === EXPECT.email && ap.name === "김유라" && ap.position === "과장", ap);
    check("판매금액·수행 36건·수금거래·이전 Master·재무상태" + (billing ? "" : "·청구") + " 불변", (await frozen()) === f0);
    if (billing) {
      const pays = await q(sql`SELECT issue_date, supply_amount, vat_amount, amount, deposit_status, deposit_confirmed, billing_company_id, billing_contact_id FROM project_payments WHERE project_id = ${P}`);
      check("청구 1회차: 2026-11-09 · 42,000,000 · 부가세 0 · 입금예정 · 청구처 3739/7253", pays.length === 1 && String(pays[0].issue_date).slice(0, 10) === "2026-11-09" && Number(pays[0].amount) === 42000000
        && Number(pays[0].vat_amount) === 0 && pays[0].deposit_status === "scheduled" && !pays[0].deposit_confirmed && Number(pays[0].billing_company_id) === EXPECT.newCompany && Number(pays[0].billing_contact_id) === EXPECT.newContact, pays);
    }
    report.after = { item: a, party: ap, batches: { relink: rel.batchId, item: it.batchId, billing: bl?.batchId ?? null } };
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    report.result = commit ? "COMMITTED" : "ROLLED_BACK(사전 점검 통과)";
  } catch (e) {
    await client.query("ROLLBACK");
    report.result = "ABORTED"; report.error = e instanceof Error ? e.message : String(e);
  } finally {
    client.release(); await pool.end();
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, `ops-repair-kintex-${commit ? "commit" : "dryrun"}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, error: report.error, checks: report.checks.map((c: any) => `${c.ok ? "OK" : "NG"} ${c.label}`) }, null, 2));
    if (report.result === "ABORTED") process.exit(1);
  }
}
main();
