// 과거 CRM 전환 판매 전체 점검·공통 복원 — 개발 DB 실데이터 표본 검증(운영 연결이면 중단). 끝나면 만든 행을 모두 삭제한다.
//  [A] 개발 DB 과거 CRM 원본에서 유형별 표본(통역·번역 복원 가능 / 발행일·미입금 / 입금 / 수량 불일치 / 무작위)을 실제 전환(executeActivation)
//      → 신규 전환: 통역·번역 수량·단가 원본대로, 발행일 있는 미입금 판매는 청구 1회차 생성, 입금 대조 판매는 중복 청구 없음
//  [B] 기존 로직으로 전환된 상태 재현(품목 1 × 공급가, 발행정보 없음) → auditConvertedSales → applyConvertedSaleRepair
//      → 자동 복원 항목만 변경 · 금액·수행·입금 불변 · 재실행 0건 · 배치 되돌리기로 원상태
import { db } from "@workspace/db";
import { execSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { buildActivationPlan, executeActivation } from "./services/legacySaleActivation";
import { auditConvertedSales, summarizeAudit, applyConvertedSaleRepair } from "./services/legacySaleAudit";
import { rollbackItemRestore } from "./services/legacyQuoteItemRestore";
import { rollbackBillingRestore, rollbackContactEmailFill } from "./services/legacySaleRepair";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const L = (xs: number[]) => sql.join(xs.map(i => sql`${i}`), sql`, `);

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const pre = Number((await rows(sql`SELECT count(*) n FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale' AND status='active'`))[0].n);
  if (pre > 0) throw new Error(`개발 DB 에 이미 전환된 판매 ${pre}건 — 표본 정리 범위를 보장할 수 없어 중단`);
  const [admin] = await rows(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const made = { projects: [] as number[], batches: [] as number[], saleNos: [] as string[] };

  // 표본 — 연결 진행행 1~40개, 판매번호 있는 유효 판매
  const base = sql`FROM legacy_archive_rows s WHERE s.source_type='sales_list' AND s.is_effective AND s.source_raw->>'판매번호' IS NOT NULL
    AND (SELECT count(*) FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective WHERE l.sale_row_id = s.id AND l.decision='confirmed') BETWEEN 1 AND 40`;
  const pick = async (cond: any, n: number) => (await rows(sql`SELECT s.id, s.source_raw->>'판매번호' sale_no ${base} AND ${cond} ORDER BY md5(s.id::text) LIMIT ${n}`));
  const prog1 = (expr: any) => sql`EXISTS (SELECT 1 FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective WHERE l.sale_row_id = s.id AND l.decision='confirmed' AND ${expr})`;
  const groups: Record<string, any[]> = {
    interp: await pick(sql`${prog1(sql`p.source_raw->>'내용' = '통역' AND replace(p.source_raw->>'수량', ',', '') ~ '^[0-9]+$' AND (p.source_raw->>'수량')::text <> '1'`)} AND s.source_raw->>'입금일' IS NULL`, 8),
    trans: await pick(sql`${prog1(sql`p.source_raw->>'내용' = '번역' AND replace(p.source_raw->>'수량', ',', '') ~ '^[0-9]+$' AND (p.source_raw->>'수량')::text <> '1'`)} AND s.source_raw->>'입금일' IS NULL`, 8),
    invoiceUnpaid: await pick(sql`s.source_raw->>'세금계산서발행(예정)일' IS NOT NULL AND coalesce(s.source_raw->>'입금일', '') = '' AND coalesce(s.source_raw->>'입금내역', '') = ''`, 8),
    deposit: await pick(sql`coalesce(s.source_raw->>'입금일', '') <> ''`, 6),
    random: await pick(sql`true`, 10),
  };
  const seen = new Set<number>(); const sample: Array<{ id: number; saleNo: string; group: string }> = [];
  for (const [g, list] of Object.entries(groups)) for (const r of list) if (!seen.has(Number(r.id))) { seen.add(Number(r.id)); sample.push({ id: Number(r.id), saleNo: String(r.sale_no), group: g }); }

  try {
    console.log(`\n[A] 실제 전환 — 표본 ${sample.length}건(${Object.entries(groups).map(([g, l]) => `${g} ${l.length}`).join(" · ")})`);
    const acts: Array<{ saleNo: string; group: string; projectId: number; billing: any; paymentRecordId: number | null; taxInvoiceDate: string | null; collection: string }> = [];
    let errors = 0;
    for (const s of sample) {
      try {
        const plan = await buildActivationPlan(db, s.id);
        if (plan.existing) continue;
        const r: any = await executeActivation(s.id, plan.planToken, { id: admin.id });
        made.projects.push(r.projectId); made.batches.push(r.batchId); made.saleNos.push(s.saleNo);
        if (r.billingRestore) made.batches.push(r.billingRestore.batchId);
        acts.push({ saleNo: s.saleNo, group: s.group, projectId: r.projectId, billing: r.billingRestore, paymentRecordId: r.paymentRecordId, taxInvoiceDate: plan.taxInvoiceDate, collection: plan.collection.status });
      } catch (e) { errors++; console.log(`    (전환 보류 ${s.saleNo}: ${e instanceof Error ? e.message.slice(0, 80) : e})`); }
    }
    check(`표본 전환 ${acts.length}건(전환 거부 ${errors}건은 기존 전환 규칙에 따른 보류)`, acts.length >= 25, { acts: acts.length, errors });
    const pids = acts.map(a => a.projectId);
    const audit0 = await auditConvertedSales(db, { saleNos: acts.map(a => a.saleNo) });
    const s0 = summarizeAudit(audit0);
    check("신규 전환 직후: 자동 복원 대상 품목·청구 0건(전환 시 이미 원본대로)", s0.perItem.item.auto === 0 && s0.perItem.billing.auto === 0, s0.perItem);
    const interp = audit0.filter(a => acts.find(x => x.saleNo === a.saleNo)?.group === "interp");
    check("통역 표본: 원본대로 전환(already_restored) 또는 원본 상충으로 보류(amount_mismatch 등) — 1 × 공급가 '복원 가능' 잔존 없음", interp.every(a => a.item.status !== "restorable"), interp.map(a => a.item.status));
    check("통역 표본 중 원본 수량·단가로 전환된 판매 존재", interp.some(a => a.item.status === "already_restored"), interp.map(a => a.item.status));
    const qty = await rows(sql`SELECT q.project_id, qi.quantity, qi.unit_price, qi.supply_amount FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${L(pids)})`);
    check("모든 전환 품목: 수량 × 단가 = 공급가액", qty.every(r => Math.abs(Number(r.quantity) * Number(r.unit_price) - Number(r.supply_amount)) <= 1), qty.filter(r => Math.abs(Number(r.quantity) * Number(r.unit_price) - Number(r.supply_amount)) > 1));
    const unpaidInv = acts.filter(a => a.taxInvoiceDate && a.collection !== "matched");
    const created = unpaidInv.filter(a => a.billing?.restored === 1);
    check(`발행일 있는 미입금 전환 ${unpaidInv.length}건 → 청구 1회차 생성 ${created.length}건(나머지는 금액·발행일 근거 보류)`, unpaidInv.length > 0 && created.length > 0, unpaidInv.map(a => [a.saleNo, a.billing]));
    const payCounts = await rows(sql`SELECT project_id, count(*) n FROM project_payments WHERE project_id IN (${L(pids)}) GROUP BY 1`);
    check("청구 회차 중복 없음(판매별 최대 1회차)", payCounts.every(r => Number(r.n) === 1), payCounts);
    const matched = acts.filter(a => a.collection === "matched");
    check("입금 대조 판매: 전환 입금 청구 1건만(발행정보 복원으로 중복 생성 없음)", matched.every(a => !a.billing || a.billing.restored === 0), matched.map(a => [a.saleNo, a.billing]));
    const bills = await rows(sql`SELECT pp.project_id, pp.issue_date, pp.amount, pp.vat_amount, pp.deposit_status, pp.paid_date, q.price, (SELECT sum(tax_amount) FROM quote_items WHERE quote_id = q.id) tax
      FROM project_payments pp JOIN quotes q ON q.project_id = pp.project_id AND q.is_current WHERE pp.project_id IN (${L(created.map(a => a.projectId).concat(0))})`);
    check("생성 청구: 금액 = 판매 총액 · 부가세 = 견적 부가세(0원 거래는 0) · 입금예정(입금일 없음)", bills.every(b => Number(b.amount) === Number(b.price) && Number(b.vat_amount) === Number(b.tax) && b.deposit_status === "scheduled" && b.paid_date == null), bills);

    console.log("\n[B] 기존 로직 전환 상태 재현 → 전체 점검·공통 복원");
    // 기존 로직: 품목 1 × 공급가액 · 비고 없음, 발행정보 청구 없음
    await db.execute(sql`UPDATE quote_items qi SET quantity = 1, unit_price = qi.supply_amount, memo = NULL FROM quotes q WHERE q.id = qi.quote_id AND q.project_id IN (${L(pids)})
      AND (SELECT count(*) FROM quote_items x WHERE x.quote_id = q.id) = 1`);
    await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${L(created.map(a => a.projectId).concat(0))}) AND note LIKE '과거 CRM 세금계산서 발행정보 복원%'`);
    const snap = async () => JSON.stringify({
      amounts: await rows(sql`SELECT qi.id, qi.supply_amount, qi.tax_amount, qi.total_amount, qi.tax_type, q.price FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${L(pids)}) ORDER BY qi.id`),
      perf: await rows(sql`SELECT * FROM performance_assignments WHERE project_id IN (${L(pids)}) ORDER BY id`),
      paid: await rows(sql`SELECT * FROM project_payments WHERE project_id IN (${L(pids)}) ORDER BY id`),
      proj: await rows(sql`SELECT id, status, financial_status, company_id, contact_id FROM projects WHERE id IN (${L(pids)}) ORDER BY id`),
    });
    const itemsOld = JSON.stringify(await rows(sql`SELECT qi.id, qi.quantity, qi.unit_price, qi.memo FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${L(pids)}) ORDER BY qi.id`));
    const snap0 = await snap();
    const audit1 = await auditConvertedSales(db, { saleNos: acts.map(a => a.saleNo) });
    const s1 = summarizeAudit(audit1);
    console.log(`    점검: 판매 ${s1.sales} · 품목 자동 ${s1.perItem.item.auto} · 청구 자동 ${s1.perItem.billing.auto} · 이메일 자동 ${s1.perItem.email.auto} · 수동 확인 판매 ${s1.salesWithManual} · 복원 불가 항목 보유 ${s1.salesWithImpossible}`);
    check("재현 상태 점검: 품목·청구 자동 복원 대상 검출", s1.perItem.item.auto > 0 && s1.perItem.billing.auto === created.length, s1.perItem);
    const rep = await db.transaction(tx => applyConvertedSaleRepair(tx as any, { userId: admin.id, saleNos: acts.map(a => a.saleNo), reason: "test", executedVia: "test" }));
    for (const b of [rep.item, rep.billing, rep.email]) if (b) made.batches.push(b.batchId);
    check(`공통 복원 실행: 품목 ${rep.item?.restored ?? 0} · 청구 ${rep.billing?.restored ?? 0} · 이메일 ${rep.email?.filled ?? 0}`, (rep.item?.restored ?? 0) === s1.perItem.item.auto && (rep.billing?.restored ?? 0) === s1.perItem.billing.auto, rep);
    const after = JSON.parse(await snap()), before = JSON.parse(snap0);
    check("금액(공급가·부가세·총액·세금구분·견적금액) 불변", JSON.stringify(after.amounts) === JSON.stringify(before.amounts));
    check("수행정보(지급 포함) 불변", JSON.stringify(after.perf) === JSON.stringify(before.perf));
    check("판매 상태·재무상태·거래처·담당자 불변", JSON.stringify(after.proj) === JSON.stringify(before.proj));
    const beforeIds = new Set(before.paid.map((p: any) => p.id));
    check("기존 청구·입금 행 불변(새 발행정보 청구만 추가)", JSON.stringify(after.paid.filter((p: any) => beforeIds.has(p.id))) === JSON.stringify(before.paid)
      && after.paid.filter((p: any) => !beforeIds.has(p.id)).every((p: any) => p.deposit_status === "scheduled" && p.paid_date == null));
    const qty2 = await rows(sql`SELECT qi.quantity, qi.unit_price, qi.supply_amount FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${L(pids)})`);
    check("복원 후 수량 × 단가 = 공급가액(전 품목)", qty2.every(r => Math.abs(Number(r.quantity) * Number(r.unit_price) - Number(r.supply_amount)) <= 1));
    const s2 = summarizeAudit(await auditConvertedSales(db, { saleNos: acts.map(a => a.saleNo) }));
    check("복원 후 재점검: 자동 복원 대상 0건", s2.perItem.item.auto === 0 && s2.perItem.billing.auto === 0 && s2.perItem.email.auto === 0, s2.perItem);
    const rep2 = await db.transaction(tx => applyConvertedSaleRepair(tx as any, { userId: admin.id, saleNos: acts.map(a => a.saleNo) }));
    check("재실행 → 변경 0건(중복 수정·생성 없음)", !rep2.item && !rep2.billing && !rep2.email, rep2.targets);
    // 되돌리기
    if (rep.item) await db.transaction(tx => rollbackItemRestore(tx as any, rep.item!.batchId));
    if (rep.billing) await db.transaction(tx => rollbackBillingRestore(tx as any, rep.billing!.batchId));
    if (rep.email) await db.transaction(tx => rollbackContactEmailFill(tx as any, rep.email!.batchId));
    const itemsBack = JSON.stringify(await rows(sql`SELECT qi.id, qi.quantity, qi.unit_price, qi.memo FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${L(pids)}) ORDER BY qi.id`));
    check("배치 되돌리기 → 복원 전 상태(품목·청구) 그대로", itemsBack === itemsOld && (await snap()) === snap0);

    console.log("\n[C] 운영 스크립트 사전 점검(ops:repair-legacy-sales, ROLLBACK) — 같은 표본");
    const out = execSync("pnpm run -s ops:repair-legacy-sales", { env: { ...process.env, OPS_DB_URL: process.env.DATABASE_URL, OPS_OUT: "dist/ops-test-out", OPS_COMMIT: "" }, encoding: "utf8" });
    const res = JSON.parse(out.slice(out.indexOf("{")));
    check(`운영 스크립트 검증 전부 통과 후 ROLLBACK(${res.checks?.length}개 검증)`, res.result === "ROLLED_BACK(사전 점검 통과)" && res.checks.every((c: string) => c.startsWith("OK")), res);
    check("운영 스크립트 대상 = 점검 결과와 동일(품목·청구)", res.targets?.item?.length === s1.perItem.item.auto && res.targets?.billing?.length === s1.perItem.billing.auto, res.targets);
    check("사전 점검 후 데이터 변화 없음", (await snap()) === snap0);
  } finally {
    const pids = made.projects;
    if (pids.length) {
      const pl = L(pids);
      const qids = (await rows(sql`SELECT id FROM quotes WHERE project_id IN (${pl})`)).map(r => Number(r.id));
      const aids = (await rows(sql`SELECT id FROM performance_assignments WHERE project_id IN (${pl})`)).map(r => Number(r.id));
      if (aids.length) {
        await db.execute(sql`DELETE FROM performance_deductions WHERE assignment_id IN (${L(aids)})`).catch(() => {});
        await db.execute(sql`DELETE FROM performance_expenses WHERE assignment_id IN (${L(aids)})`).catch(() => {});
        await db.execute(sql`DELETE FROM performance_assignments WHERE id IN (${L(aids)})`);
      }
      await db.execute(sql`DELETE FROM logs WHERE (entity_type = 'project' AND entity_id IN (${pl}))${qids.length ? sql` OR (entity_type = 'quote' AND entity_id IN (${L(qids)}))` : sql``}`);
      await db.execute(sql`DELETE FROM payment_transactions WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE project_id IN (${pl}))`);
      await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type = 'sale' AND entity_id IN (${pl})`);
      await db.execute(sql`DELETE FROM projects WHERE id IN (${pl})`);
    }
    const extra = (await rows(sql`SELECT id FROM import_batches WHERE module = 'legacy_sale_repair' AND created_at > now() - interval '1 hour' AND created_by = ${admin.id}`)).map(r => Number(r.id));
    const bl = [...new Set([...made.batches, ...extra])];
    if (bl.length) {
      await db.execute(sql`DELETE FROM import_row_sources WHERE batch_id IN (${L(bl)})`);
      await db.execute(sql`DELETE FROM import_batches WHERE id IN (${L(bl)})`);
    }
    const left = Number((await rows(sql`SELECT count(*) n FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale' AND status='active'`))[0].n);
    check("표본 정리 완료(개발 DB 전환 판매 0건으로 복귀)", left === 0, left);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
