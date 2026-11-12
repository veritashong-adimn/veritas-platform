// ─── [운영 작업] Q000045(한국철도공사) 견적 품목 단위 정정(1회성, 관리자 승인) ─────────────────────────
// 승인 범위: quote_items #270 의 unit '단어' → '건' 한 칸만. 수량·단가·금액·문서정보·다른 데이터는 바꾸지 않는다.
// 근거: 진행관리표 '단위'는 통번역사 분량(통번역수량) 산정 기준이고(이 건 통번역수량 504 = 단어수 504), 실제 거래 단위는
//       관리자가 CRM 견적서로 확인한 '건'이다.
// 실행: OPS_DB_URL=<env> OPS_OUT=<폴더> [OPS_COMMIT=1] pnpm run ops:correct-q000045-unit
//   OPS_COMMIT=1 이 없으면 전체 검증 후 ROLLBACK. 하나라도 어긋나면 전체 ROLLBACK.
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { ITEM_RESTORE_MODULE } from "./services/legacyQuoteItemRestore";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.OPS_DB_URL, outDir = process.env.OPS_OUT, commit = process.env.OPS_COMMIT === "1";
if (!url || !outDir) { console.error("OPS_DB_URL, OPS_OUT 필요"); process.exit(2); }
const REASON = "과거 CRM 견적 수량 단위 오류 정정 — 원본 '단위'(단어)는 분량 산정 기준, 실제 거래 단위 '건'(관리자 확인)";
const ITEM_ID = 270, QUOTE_NO = "Q000045", SALE_NO = "2026-11-10-0009";
const EXPECT = { quantity: "2.00", unit: "단어", unit_price: "35000.00", supply_amount: "70000.00", tax_amount: "7000.00", total_amount: "77000.00",
  memo: "파일: 12월-리플릿_표지후면-(301x216) | 단어수: 504 | 글자수: 1440" };
class Abort extends Error {}

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  const report: any = { mode: commit ? "COMMIT" : "DRY_RUN(ROLLBACK)", reason: REASON, startedAt: new Date().toISOString(), checks: [] };
  const check = (label: string, ok: boolean, extra?: unknown) => { report.checks.push({ label, ok, ...(extra !== undefined ? { extra } : {}) }); if (!ok) throw new Abort(`검증 실패: ${label} ${extra ? JSON.stringify(extra) : ""}`); };
  await client.query("BEGIN");
  try {
    // ① 현재 값 확인 · ② 변경 전 기록
    const [it] = await q(sql`SELECT qi.*, q.quote_number, q.project_id, q.is_current, q.deleted_at q_deleted FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id
      WHERE qi.id = ${ITEM_ID} FOR UPDATE OF qi`);
    check("품목 #270 존재 · 견적 Q000045 · 현재 견적", !!it && it.quote_number === QUOTE_NO && it.is_current === true && it.q_deleted == null, it && { quote_number: it.quote_number });
    const [m] = await q(sql`SELECT legacy_id FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale' AND status='active' AND entity_id = ${it.project_id}`);
    check("판매번호 연결 2026-11-10-0009", m?.legacy_id === SALE_NO, m);
    for (const [k, v] of Object.entries(EXPECT)) check(`현재 ${k} = ${v}`, it[k] === v, it[k]);
    check("견적 품목 1개", Number((await q(sql`SELECT count(*) n FROM quote_items WHERE quote_id = ${it.quote_id}`))[0].n) === 1);
    const pid = Number(it.project_id), qid = Number(it.quote_id);
    const snap = async () => ({
      quotes: await q(sql`SELECT * FROM quotes WHERE project_id = ${pid} ORDER BY id`),
      projects: await q(sql`SELECT * FROM projects WHERE id = ${pid}`),
      items: await q(sql`SELECT * FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE project_id = ${pid}) ORDER BY id`),
      itemFiles: await q(sql`SELECT * FROM quote_item_files WHERE quote_item_id = ${ITEM_ID}`),
      mappings: await q(sql`SELECT * FROM legacy_master_mappings WHERE (entity_type = 'sale' AND entity_id = ${pid}) OR legacy_id = ${SALE_NO} ORDER BY id`),
      performances: await q(sql`SELECT * FROM performance_assignments WHERE project_id = ${pid} ORDER BY id`),
      deductions: await q(sql`SELECT * FROM performance_deductions WHERE assignment_id IN (SELECT id FROM performance_assignments WHERE project_id = ${pid}) ORDER BY id`),
      expenses: await q(sql`SELECT * FROM performance_expenses WHERE assignment_id IN (SELECT id FROM performance_assignments WHERE project_id = ${pid}) ORDER BY id`),
      payoutItems: await q(sql`SELECT * FROM payout_round_items WHERE project_id = ${pid} OR quote_id = ${qid} ORDER BY id`),
      payoutConversions: await q(sql`SELECT * FROM legacy_payout_conversions WHERE project_id = ${pid} ORDER BY id`),
      projectPayments: await q(sql`SELECT * FROM project_payments WHERE project_id = ${pid} ORDER BY id`),
      paymentTx: await q(sql`SELECT * FROM payment_transactions WHERE project_id = ${pid} ORDER BY id`),
      payments: await q(sql`SELECT * FROM payments WHERE project_id = ${pid} ORDER BY id`),
      settlements: await q(sql`SELECT * FROM settlements WHERE project_id = ${pid} ORDER BY id`),
      billingItems: await q(sql`SELECT * FROM billing_batch_items WHERE project_id = ${pid} OR quote_id = ${qid} ORDER BY id`),
      billingBatches: await q(sql`SELECT * FROM billing_batches WHERE quote_id = ${qid} ORDER BY id`),
      prepaid: await q(sql`SELECT * FROM prepaid_ledger WHERE project_id = ${pid} OR quote_id = ${qid} ORDER BY id`),
      tasks: await q(sql`SELECT * FROM tasks WHERE project_id = ${pid} ORDER BY id`),
      otherRestored: await q(sql`SELECT * FROM quote_items WHERE id IN (189, 264) ORDER BY id`),   // Q000029·Q000040 — 이번 승인 범위 밖(불변 확인)
    });
    const before = await snap();
    fs.mkdirSync(outDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(outDir!, `unitfix_before_${stamp}.json`), JSON.stringify(before, null, 2));

    // ③ 단위만 수정
    const up = await dbx.execute(sql`UPDATE quote_items SET unit = '건' WHERE id = ${ITEM_ID} AND unit = '단어'`);
    check("1행만 수정", up.rowCount === 1, up.rowCount);

    // ④ 변경 전후 비교
    const after = await snap();
    for (const k of Object.keys(before) as Array<keyof typeof before>) if (k !== "items") check(`불변: ${k}`, JSON.stringify(before[k]) === JSON.stringify(after[k]));
    const b = before.items.find((x: any) => x.id === ITEM_ID), a = after.items.find((x: any) => x.id === ITEM_ID);
    const changed = Object.keys(b).filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
    check("바뀐 칸은 unit 하나", changed.length === 1 && changed[0] === "unit", changed);
    check("다른 품목 불변", JSON.stringify(before.items.filter((x: any) => x.id !== ITEM_ID)) === JSON.stringify(after.items.filter((x: any) => x.id !== ITEM_ID)));
    check("최종: 2 건 × 35,000 · 70,000 / 7,000 / 77,000", a.quantity === "2.00" && a.unit === "건" && a.unit_price === "35000.00" && a.supply_amount === "70000.00" && a.tax_amount === "7000.00" && a.total_amount === "77000.00");

    // ⑥ 감사기록 — 기존 복원 기록과 같은 모듈에 정정 배치로 남긴다(변경 전후·근거·사유·시각)
    const [batch] = await q(sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
      VALUES (${ITEM_RESTORE_MODULE}, 'unit_correction', ${REASON}, 1, 1, 'completed', null, 'old_crm', false) RETURNING id`);
    const rec = { quoteId: qid, quoteNumber: QUOTE_NO, itemId: ITEM_ID, saleNo: SALE_NO, field: "unit", before: { unit: b.unit }, after: { unit: a.unit },
      basis: { crmVolumeBasis: "단어", crmTranslatorQuantity: "504", crmWordCount: "504", note: "원본 '단위'는 통번역수량 산정 기준. 실제 거래 단위 '건'은 관리자가 CRM 견적서로 확인" },
      reason: REASON, executedVia: "ops-correct-q000045-unit(관리자 승인)", at: new Date().toISOString(), supersedesBatch: 83 };
    await dbx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw)
      VALUES (${batch.id}, ${ITEM_RESTORE_MODULE}, ${ITEM_ID}, ${`quote_item:${ITEM_ID}`}, 'unit_corrected', 'old_crm', ${SALE_NO}, ${JSON.stringify(rec)}::jsonb)`);
    await dbx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, metadata) VALUES ('quote', ${qid}, 'legacy_quote_item_unit_corrected', null, ${JSON.stringify({ ...rec, batchId: Number(batch.id) })})`);
    report.batchId = Number(batch.id); report.before = { id: b.id, quantity: b.quantity, unit: b.unit, unit_price: b.unit_price, supply_amount: b.supply_amount, tax_amount: b.tax_amount, total_amount: b.total_amount, memo: b.memo };
    report.after = { id: a.id, quantity: a.quantity, unit: a.unit, unit_price: a.unit_price, supply_amount: a.supply_amount, tax_amount: a.tax_amount, total_amount: a.total_amount, memo: a.memo };
    fs.writeFileSync(path.join(outDir!, `unitfix_after_${stamp}.json`), JSON.stringify(after, null, 2));
    if (commit) { await client.query("COMMIT"); report.committed = true; } else { await client.query("ROLLBACK"); report.committed = false; }
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {}); report.committed = false; report.error = e?.message ?? String(e);
  } finally {
    client.release(); await pool.end();
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, `unitfix_report_${commit ? "commit" : "dryrun"}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ mode: report.mode, committed: report.committed, error: report.error ?? null, checks: report.checks.length,
      failed: report.checks.filter((c: any) => !c.ok), batchId: report.batchId ?? null, before: report.before, after: report.after }, null, 2));
  }
  process.exit(report.error ? 1 : 0);
}
main();
