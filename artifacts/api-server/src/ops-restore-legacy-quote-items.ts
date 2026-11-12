// ─── [운영 작업] 승인된 과거 CRM 견적 품목 상세정보 복원(1회성) ─────────────────────────────
// [실행 완료 2026-11-12 · import_batches #83 — 재실행 금지] 승인 범위: Q000045(한국철도공사) · Q000040 · Q000029 의 기존 견적 품목 1개씩.
//   실행 당시 로직은 원본 '단위'(단어)를 품목 단위로 썼다. 이후 '단위'는 분량 산정 기준으로 확인되어 복원 로직은 단위를 바꾸지 않도록 정정됨
//   (Q000045 단위 정정: ops-correct-q000045-unit). 이 스크립트는 기록 보존용이며, 지금 로직으로는 대상이 already_restored 라 실행되지 않는다.
// 실행: OPS_DB_URL=<env> OPS_OUT=<폴더> [OPS_COMMIT=1] pnpm run ops:restore-legacy-quote-items
//   · OPS_COMMIT=1 이 없으면 전체 검증 후 ROLLBACK(사전 점검 실행).
//   · 하나의 트랜잭션: 대상 대조 → 변경 전 스냅샷 → applyItemRestore → 변경 후 검증. 하나라도 어긋나면 전체 ROLLBACK.
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { planItemRestore, applyItemRestore } from "./services/legacyQuoteItemRestore";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.OPS_DB_URL, outDir = process.env.OPS_OUT, commit = process.env.OPS_COMMIT === "1";
if (!url || !outDir) { console.error("OPS_DB_URL, OPS_OUT 필요"); process.exit(2); }
const REASON = "과거 CRM 견적 품목 상세정보 이관 누락 복원";

// 승인 내용(견적번호 → 기대값). 원본·DB 가 이와 다르면 실행하지 않는다.
const APPROVED: Record<string, { quantity: number; unit: string; unitPrice: number; supply: number }> = {
  Q000045: { quantity: 2, unit: "단어", unitPrice: 35000, supply: 70000 },
  Q000040: { quantity: 8, unit: "단어", unitPrice: 37400, supply: 299200 },
  Q000029: { quantity: 0.5, unit: "단어", unitPrice: 25000, supply: 12500 },
};

class Abort extends Error {}

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  const report: any = { mode: commit ? "COMMIT" : "DRY_RUN(ROLLBACK)", reason: REASON, startedAt: new Date().toISOString(), targets: [], checks: [] };
  const check = (label: string, ok: boolean, extra?: unknown) => { report.checks.push({ label, ok, ...(extra !== undefined ? { extra } : {}) }); if (!ok) throw new Abort(`검증 실패: ${label} ${extra ? JSON.stringify(extra) : ""}`); };
  await client.query("BEGIN");
  try {
    // 1) 대상 견적번호 ↔ DB id ↔ 과거 CRM 판매번호 대조
    const qnos = Object.keys(APPROVED);
    const tg = await q(sql`SELECT q.id quote_id, q.quote_number, q.project_id, m.legacy_id sale_no, m.status mstatus,
        (SELECT count(*) FROM legacy_archive_rows s WHERE s.source_type='sales_list' AND s.is_effective AND s.source_raw->>'판매번호' = m.legacy_id) sale_rows,
        (SELECT count(*) FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id AND s.is_effective AND s.source_type='sales_list'
           JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective WHERE s.source_raw->>'판매번호' = m.legacy_id AND l.decision = 'confirmed') prog_rows,
        (SELECT count(*) FROM quote_items qi WHERE qi.quote_id = q.id) items, q.is_current, q.deleted_at
      FROM quotes q JOIN legacy_master_mappings m ON m.entity_id = q.project_id AND m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active'
      WHERE q.quote_number IN (${sql.join(qnos.map(n => sql`${n}`), sql`, `)}) FOR UPDATE OF q`);
    check("대상 견적 3건 모두 조회(견적번호·판매 매핑)", tg.length === 3, tg.map(t => t.quote_number));
    for (const t of tg) {
      check(`${t.quote_number}: 현재 견적·삭제 안 됨`, t.is_current === true && t.deleted_at == null);
      check(`${t.quote_number}: 판매번호 ${t.sale_no} 원본 판매행 1개·진행행 1개`, Number(t.sale_rows) === 1 && Number(t.prog_rows) === 1, { sale_rows: t.sale_rows, prog_rows: t.prog_rows });
      check(`${t.quote_number}: 견적 품목 1개`, Number(t.items) === 1);
    }
    const saleNos = tg.map(t => String(t.sale_no));
    const projIds = tg.map(t => Number(t.project_id)), quoteIds = tg.map(t => Number(t.quote_id));
    const L = (xs: number[]) => sql.join(xs.map(x => sql`${x}`), sql`, `);

    // 2) 복원 계획 — 승인값과 일치 확인
    const plan = await planItemRestore(dbx as any, { saleNos });
    for (const p of plan) {
      const a = APPROVED[p.quoteNumber ?? ""];
      check(`${p.quoteNumber}: 계획 상태 restorable`, p.status === "restorable", { status: p.status, reason: p.reason });
      check(`${p.quoteNumber}: 원본 수량·단위·단가 = 승인값`, p.after!.quantity === a.quantity && p.after!.unit === a.unit && p.after!.unitPrice === a.unitPrice, p.after);
      check(`${p.quoteNumber}: 공급가액 = 승인값, 원본 수량×단가 = 공급가액`, p.before!.supplyAmount === a.supply && Math.abs(a.quantity * a.unitPrice - a.supply) < 0.01, p.before);
      check(`${p.quoteNumber}: 변경 전 = 전환 기본값(1 건 × 공급가액, 비고 없음)`, p.before!.quantity === 1 && p.before!.unit === "건" && p.before!.unitPrice === p.before!.supplyAmount && !p.before!.memo, p.before);
      check(`${p.quoteNumber}: 파일형식 미생성(원본에 칸 없음)`, !/형식:/.test(p.after!.memo ?? ""));
      report.targets.push({ quoteNumber: p.quoteNumber, quoteId: p.quoteId, itemId: p.itemId, saleNo: p.saleNo, before: p.before, after: p.after, source: p.source });
    }

    // 3) 변경 전 스냅샷 — 견적·판매·수행·청구·입금·정산·지급·연결관계
    const snap = async () => ({
      quotes: await q(sql`SELECT * FROM quotes WHERE id IN (${L(quoteIds)}) ORDER BY id`),
      projects: await q(sql`SELECT * FROM projects WHERE id IN (${L(projIds)}) ORDER BY id`),
      items: await q(sql`SELECT * FROM quote_items WHERE quote_id IN (${L(quoteIds)}) ORDER BY id`),
      itemFiles: await q(sql`SELECT * FROM quote_item_files WHERE quote_item_id IN (SELECT id FROM quote_items WHERE quote_id IN (${L(quoteIds)})) ORDER BY id`),
      mappings: await q(sql`SELECT * FROM legacy_master_mappings WHERE (entity_type = 'sale' AND entity_id IN (${L(projIds)})) OR legacy_id IN (${sql.join(saleNos.map(s => sql`${s}`), sql`, `)}) ORDER BY id`),
      performances: await q(sql`SELECT * FROM performance_assignments WHERE project_id IN (${L(projIds)}) ORDER BY id`),
      deductions: await q(sql`SELECT * FROM performance_deductions WHERE assignment_id IN (SELECT id FROM performance_assignments WHERE project_id IN (${L(projIds)})) ORDER BY id`),
      expenses: await q(sql`SELECT * FROM performance_expenses WHERE assignment_id IN (SELECT id FROM performance_assignments WHERE project_id IN (${L(projIds)})) ORDER BY id`),
      payoutItems: await q(sql`SELECT * FROM payout_round_items WHERE project_id IN (${L(projIds)}) OR quote_id IN (${L(quoteIds)}) ORDER BY id`),
      payoutConversions: await q(sql`SELECT * FROM legacy_payout_conversions WHERE project_id IN (${L(projIds)}) ORDER BY id`),
      projectPayments: await q(sql`SELECT * FROM project_payments WHERE project_id IN (${L(projIds)}) ORDER BY id`),
      paymentTx: await q(sql`SELECT * FROM payment_transactions WHERE project_id IN (${L(projIds)}) ORDER BY id`),
      payments: await q(sql`SELECT * FROM payments WHERE project_id IN (${L(projIds)}) ORDER BY id`),
      settlements: await q(sql`SELECT * FROM settlements WHERE project_id IN (${L(projIds)}) ORDER BY id`),
      billingItems: await q(sql`SELECT * FROM billing_batch_items WHERE project_id IN (${L(projIds)}) OR quote_id IN (${L(quoteIds)}) ORDER BY id`),
      billingBatches: await q(sql`SELECT * FROM billing_batches WHERE quote_id IN (${L(quoteIds)}) ORDER BY id`),
      prepaid: await q(sql`SELECT * FROM prepaid_ledger WHERE project_id IN (${L(projIds)}) OR quote_id IN (${L(quoteIds)}) ORDER BY id`),
      tasks: await q(sql`SELECT * FROM tasks WHERE project_id IN (${L(projIds)}) ORDER BY id`),
    });
    const before = await snap();
    fs.mkdirSync(outDir!, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(outDir!, `restore_before_${stamp}.json`), JSON.stringify(before, null, 2));

    // 4) 복원 실행(개발·테스트 완료한 로직)
    const res = await applyItemRestore(dbx as any, { userId: null, saleNos, reason: REASON, executedVia: "ops-restore-legacy-quote-items(관리자 승인)" });
    report.result = res;
    check("복원 3건 실행", res.restored === 3, res);

    // 5) 변경 후 검증
    const after = await snap();
    const same = (k: keyof typeof before) => JSON.stringify(before[k]) === JSON.stringify(after[k]);
    for (const k of Object.keys(before) as Array<keyof typeof before>) if (k !== "items") check(`불변: ${k}`, same(k));
    check("품목 수·품목 id 동일(삭제·재생성 없음)", JSON.stringify(before.items.map((i: any) => i.id)) === JSON.stringify(after.items.map((i: any) => i.id)));
    for (const b of before.items) {
      const a = after.items.find((x: any) => x.id === b.id)!;
      const changed = Object.keys(b).filter(k => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
      check(`품목 #${b.id}: 바뀐 칸은 quantity·unit·unit_price·memo 만`, changed.every(k => ["quantity", "unit", "unit_price", "memo"].includes(k)), changed);
      check(`품목 #${b.id}: 공급가액·부가세·총액 동일`, b.supply_amount === a.supply_amount && b.tax_amount === a.tax_amount && b.total_amount === a.total_amount);
      const t = report.targets.find((x: any) => x.itemId === b.id);
      check(`품목 #${b.id}: 저장값 = 계획값`, Number(a.quantity) === t.after.quantity && a.unit === t.after.unit && Number(a.unit_price) === t.after.unitPrice && a.memo === t.after.memo, { quantity: a.quantity, unit: a.unit, unit_price: a.unit_price, memo: a.memo });
      t.saved = { id: a.id, quantity: a.quantity, unit: a.unit, unit_price: a.unit_price, supply_amount: a.supply_amount, tax_amount: a.tax_amount, total_amount: a.total_amount, memo: a.memo };
    }
    const k45 = report.targets.find((x: any) => x.quoteNumber === "Q000045").saved;
    check("Q000045 = 2 단어 × 35,000 · 70,000 / 7,000 / 77,000", Number(k45.quantity) === 2 && k45.unit === "단어" && Number(k45.unit_price) === 35000
      && Number(k45.supply_amount) === 70000 && Number(k45.tax_amount) === 7000 && Number(k45.total_amount) === 77000, k45);
    const audit = await q(sql`SELECT entity_id, source_raw FROM import_row_sources WHERE batch_id = ${res.batchId} AND status = 'restored' ORDER BY entity_id`);
    check("감사기록 3건(변경 전후·원본 근거·사유·시각)", audit.length === 3 && audit.every(a => a.source_raw.reason === REASON && a.source_raw.before && a.source_raw.after && a.source_raw.source && a.source_raw.at));
    fs.writeFileSync(path.join(outDir!, `restore_after_${stamp}.json`), JSON.stringify(after, null, 2));

    if (commit) { await client.query("COMMIT"); report.committed = true; }
    else { await client.query("ROLLBACK"); report.committed = false; }
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {});
    report.committed = false; report.error = e?.message ?? String(e);
  } finally {
    client.release(); await pool.end();
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, `restore_report_${commit ? "commit" : "dryrun"}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ mode: report.mode, committed: report.committed, error: report.error ?? null, result: report.result ?? null,
      failedChecks: report.checks.filter((c: any) => !c.ok), checks: report.checks.length,
      targets: report.targets.map((t: any) => ({ quoteNumber: t.quoteNumber, itemId: t.itemId, saleNo: t.saleNo, before: t.before, after: t.saved ?? t.after })) }, null, 2));
  }
  process.exit(report.error ? 1 : 0);
}
main();
