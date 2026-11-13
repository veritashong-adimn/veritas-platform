// 과거 CRM 전환 판매 — 지급상태 동기화 · 지급완료 확인(실제 지급확정 기록) · 판매상품 연결 · 수량 표시 (개발 DB · 로컬 API :8080)
//  운영 KINTEX(2026-06-22-0003) 동일 구조를 재현: 판매 1건(105인일 × 400,000 = 42,000,000 영세율) · 수행정보 36행(직접금액 750,000, 3.3%,
//  수량 105 = 판매수량 복사) · 전환 이력 payout_review(지급보류) · 과거 CRM 원본 진행행 · 견적관리 저장으로 끊긴 판매상품 연결.
//  fixture 는 끝나면 모두 삭제한다.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import jwt from "jsonwebtoken";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await rows(q))[0];
const B = process.env.TEST_API ?? "http://localhost:8080/api";
const kst = (d = 0) => new Date(Date.now() + 9 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const H = { Authorization: `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "15m" })}`, "Content-Type": "application/json" };
  const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) as any }; };
  const tag = `__TEST_LPL_${Date.now()}`;
  const YEST = kst(-1), TOMO = kst(1);
  const fx: { companyId?: number; projectId?: number; quoteId?: number; batchId?: number; archiveIds: number[]; perfIds: number[] } = { archiveIds: [], perfIds: [] };
  try {
    // ── fixture ──
    const co = await one(sql`INSERT INTO companies (name, company_type, is_customer) VALUES (${`${tag}_킨텍스형`}, 'client', true) RETURNING id`); fx.companyId = co.id;
    const p = await one(sql`INSERT INTO projects (user_id, title, status, company_id) VALUES (${admin.id}, ${`${tag}_오사카수출상담회`}, 'approved', ${co.id}) RETURNING id`); fx.projectId = p.id;
    const q = await one(sql`INSERT INTO quotes (project_id, quote_number, price, status, title, issue_date, is_current, tax_document_type) VALUES (${p.id}, ${`QL${Date.now() % 1e9}`}, 42000000, 'approved', ${`${tag}_오사카수출상담회`}, '2026-06-22', true, 'zero_rate_tax_invoice') RETURNING id`); fx.quoteId = q.id;
    const item0 = await one(sql`INSERT INTO quote_items (quote_id, product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, item_type, tax_type, is_custom_product)
      VALUES (${q.id}, '일본어상담회통역', '인일', 105, 400000, 42000000, 0, 42000000, 'interpretation', 'zero_rate', true) RETURNING id`);
    await db.execute(sql`INSERT INTO project_payments (project_id, sequence, issue_date, payment_type, payment_method, supply_amount, vat_amount, amount, deposit_status, deposit_confirmed, paid_date, payment_category, payer, deposit_item)
      VALUES (${p.id}, 1, '2026-11-09', 'lump_sum', '영세율 계산서', 42000000, 0, 42000000, 'completed', true, '2026-11-12', '일반결제', '고객사', '전체금액')`);
    const bt = await one(sql`INSERT INTO import_batches (module, import_type, total_rows, success_rows, warning_rows, error_rows, status, source_system) VALUES ('legacy_sale_activation', ${tag}, 1, 1, 0, 0, 'completed', 'old_crm') RETURNING id`); fx.batchId = bt.id;
    const saleNo = `${tag}-0003`;
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, import_batch_id, match_method, status) VALUES ('old_crm', 'sale', ${saleNo}, ${p.id}, ${bt.id}, 'test', 'active')`);
    await db.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw) VALUES (${bt.id}, 'legacy_sale_activation', ${p.id}, ${`sale:${saleNo}`}, 'success', 'old_crm', ${saleNo}, '{}'::jsonb)`);
    // 36행: 0~33 = 지급예정일 어제(경과) · 34 = 내일(예정) · 35 = 과거 지급완료(cutoff, 이미 paid)
    for (let i = 0; i < 36; i++) {
      const pay = i === 34 ? TOMO : YEST, cutoff = i === 35;
      const deliv = cutoff ? "2026-09-01" : "2026-10-21";
      const name = `${tag}_통역사${String(i + 1).padStart(2, "0")}`;
      const ar = await one(sql`INSERT INTO legacy_archive_rows (source_type, source_raw, row_hash) VALUES ('progress',
        ${JSON.stringify({ 통번역사명: name, 통번역사지급일: pay, 통번역사납품일: deliv, "지급액(세전)": "750000", 거래처명: `${tag}_킨텍스형`, 상품명: "일본어상담회통역" })}::jsonb, ${`${tag}_${i}`}) RETURNING id`);
      fx.archiveIds.push(ar.id);
      const pa = await one(sql`INSERT INTO performance_assignments (project_id, quote_id, sale_item_id, sequence, performer_category, performer_name_snapshot, product_name_snapshot, service_type,
          performance_start_date, performance_end_date, delivery_date, expected_payment_date, pay_date_manual, quantity, is_direct_amount, contract_unit_price,
          base_performance_fee, cost_total, withholding_treatment, withholding_rate, payment_status, status, payee_type)
        VALUES (${p.id}, ${q.id}, ${item0.id}, ${i}, 'individual', ${name}, '일본어상담회통역', 'interpretation', '2026-10-21', '2026-10-21', ${deliv}, ${pay}, true, 105, true, 750000,
          750000, 750000, 'domestic_3_3', 3.3, ${cutoff ? "paid" : "payment_hold"}, ${cutoff ? "paid" : "assigned"}, 'individual') RETURNING id`);
      fx.perfIds.push(pa.id);
      await db.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw) VALUES (${bt.id}, 'legacy_sale_activation', ${pa.id},
        ${`progress:${ar.id}`}, ${cutoff ? "legacy_paid" : "payout_review"}, 'old_crm', ${String(ar.id)}, ${JSON.stringify({ payDate: pay })}::jsonb)`);
    }
    const snapPerf = async () => JSON.stringify(await rows(sql`SELECT id, quantity, contract_unit_price, cost_total, withholding_treatment, withholding_rate, withholding_tax, expected_payment_date FROM performance_assignments WHERE project_id = ${p.id} ORDER BY id`));
    const snapSale = async () => JSON.stringify(await rows(sql`SELECT (SELECT price FROM quotes WHERE id = ${q.id}) price, (SELECT json_agg(json_build_object('q', quantity, 's', supply_amount, 't', tax_amount, 'type', tax_type)) FROM quote_items WHERE quote_id = ${q.id}) items,
      (SELECT json_agg(json_build_object('amt', amount, 'paid', paid_date, 'st', deposit_status, 'm', payment_method)) FROM project_payments WHERE project_id = ${p.id}) pays`));
    const perf0 = await snapPerf(), sale0 = await snapSale();

    console.log("\n[1] 지급상태 표시 — 지급예정일만으로 지급완료 아님");
    let d = (await call("GET", `/admin/projects/${p.id}`)).data;
    const by = (i: number) => d.performances.find((x: any) => x.id === fx.perfIds[i]);
    check("수행정보 36행 보존", d.performances.length === 36, d.performances.length);
    check("지급예정일 경과(어제) + 지급보류 → '확인 필요' (지급완료 아님)", by(0).legacyPayout?.display === "review" && by(0).paymentStatus === "payment_hold", by(0).legacyPayout);
    check("지급예정일 미래(내일) → '지급예정'", by(34).legacyPayout?.display === "scheduled", by(34).legacyPayout);
    check("기존 지급완료 기록(cutoff) → '지급완료' 유지", by(35).legacyPayout?.display === "paid" && by(35).paymentStatus === "paid", by(35).legacyPayout);
    check("지급예정일과 실제 지급일 구분(실제 지급일 없음)", by(0).expectedPaymentDate?.slice(0, 10) === YEST && !by(0).actualPaymentDate, { e: by(0).expectedPaymentDate, a: by(0).actualPaymentDate });
    check("수량 105 = 판매수량 복사 표시 플래그(저장값 105 그대로)", by(0).quantityFromSale === true && Number(by(0).quantity) === 105);
    const org = (await call("GET", `/admin/projects/${p.id}/legacy-origin`)).data.origin;
    const oi = (i: number) => org.payoutItems.find((x: any) => x.assignmentId === fx.perfIds[i]);
    check("과거 지급 확인 목록: 확인 필요/지급예정 구분 · 지급액 제안 725,250(750,000 − 3.3%, 저장 세금처리 기준)", oi(0).payoutDisplay === "review" && oi(34).payoutDisplay === "scheduled" && oi(0).suggestedPaidAmount === 725250, oi(0));

    console.log("\n[2] 지급회차 통합조회·지급명세서 — 같은 기준");
    const uni = async (date: string) => (await call("GET", `/admin/payout-unified/payees?date=${date}&translator=${encodeURIComponent(tag)}`)).data;
    let u = await uni(YEST);
    const st = (it: any) => it?.status;
    const uItems: any[] = u?.items ?? [];
    const uOf = (i: number) => uItems.find((x: any) => x.id === fx.archiveIds[i]);
    check(`통합조회(지급일 ${YEST}): 확인 대기 건 = '지급확인 필요'(지급일 경과만으로 지급완료 아님)`, st(uOf(0)) === "deposit_unconfirmed" && uItems.filter(x => x.status === "paid").map((x: any) => x.id).join() === String(fx.archiveIds[35]), { s: st(uOf(0)), n: uItems.length });
    check("통합조회: 기존 지급완료(대표 확인 cutoff) 원본 행은 '지급완료' 유지", st(uOf(35)) === "paid", uOf(35));
    const uT = await uni(TOMO);
    check("통합조회(내일): '지급예정'", (uT?.items ?? []).find((x: any) => x.id === fx.archiveIds[34])?.status === "scheduled");
    const uC = await uni(YEST.slice(0, 4) === "2026" ? YEST : YEST);
    void uC;

    console.log("\n[3] 지급완료 확인 — 실제 지급확정 기록(지급일·지급액·확인자·일시·근거)");
    const single0 = await call("POST", `/admin/performances/${fx.perfIds[0]}/legacy-payout-review`, { decision: "paid", reason: "근거" });
    check("지급일·지급액 없이 지급완료 확인 → 400", single0.status === 400, single0.data);
    const fut = await call("POST", `/admin/performances/${fx.perfIds[0]}/legacy-payout-review`, { decision: "paid", reason: "근거", actualPaymentDate: TOMO, actualPaymentAmount: 725250 });
    check("미래 지급일 → 400(이미 지급된 건만)", fut.status === 400, fut.data);
    const noEvid = await call("POST", `/admin/projects/${p.id}/legacy-payout-review/bulk`, { items: [{ assignmentId: fx.perfIds[0], actualPaymentDate: YEST, actualPaymentAmount: 725250 }] });
    check("증빙(근거) 없이 일괄 확인 → 400", noEvid.status === 400);
    const bulkItems = [0, 1, 2].map(i => ({ assignmentId: fx.perfIds[i], actualPaymentDate: YEST, actualPaymentAmount: 725250 }));
    bulkItems.push({ assignmentId: fx.perfIds[34], actualPaymentDate: TOMO, actualPaymentAmount: 725250 });   // 부분 실패(미래 지급일)
    bulkItems.push({ assignmentId: fx.perfIds[35], actualPaymentDate: YEST, actualPaymentAmount: 725250 });   // 이미 지급완료(중복 확정)
    const bulk = await call("POST", `/admin/projects/${p.id}/legacy-payout-review/bulk`, { reason: "2026-11-13 기업은행 대량이체 내역 확인(테스트)", items: bulkItems });
    check("다수 통역사 일괄 확인: 3건 성공 · 2건 실패(미래 지급일·이미 지급완료) 건별 사유", bulk.ok && bulk.data.succeeded === 3 && bulk.data.failed === 2
      && bulk.data.results.find((r: any) => r.assignmentId === fx.perfIds[34])?.error?.includes("오늘") && !!bulk.data.results.find((r: any) => r.assignmentId === fx.perfIds[35])?.error, bulk.data);
    const a0 = await one(sql`SELECT payment_status, to_char(actual_payment_date,'YYYY-MM-DD') ad, actual_payment_amount aa, to_char(expected_payment_date,'YYYY-MM-DD') ed, cost_total, withholding_treatment, payout_round_id FROM performance_assignments WHERE id = ${fx.perfIds[0]}`);
    check("확인 후 수행정보: 지급완료 · 실제 지급일·지급액 기록 · 지급예정일·원가·세금처리 보존 · 지급회차 생성 없음",
      a0.payment_status === "paid" && a0.ad === YEST && Number(a0.aa) === 725250 && a0.ed === YEST && Number(a0.cost_total) === 750000 && a0.withholding_treatment === "domestic_3_3" && a0.payout_round_id == null, a0);
    const lg = await one(sql`SELECT performed_by, metadata FROM logs WHERE entity_type = 'project' AND entity_id = ${p.id} AND action = 'legacy_payout_review_resolved' AND metadata LIKE ${`%"assignmentId":${fx.perfIds[0]},%`}`);
    const m = JSON.parse(lg?.metadata ?? "{}");
    check("감사로그: 확인자·확인일시·근거·실제 지급일·지급액", Number(lg?.performed_by) === Number(admin.id) && !!m.confirmedAt && m.reason?.includes("대량이체") && m.actualPaymentDate === YEST && m.actualPaymentAmount === 725250, m);
    const again = await call("POST", `/admin/projects/${p.id}/legacy-payout-review/bulk`, { reason: "중복", items: [{ assignmentId: fx.perfIds[0], actualPaymentDate: YEST, actualPaymentAmount: 725250 }] });
    const nLog = await one(sql`SELECT count(*)::int n FROM logs WHERE entity_type = 'project' AND entity_id = ${p.id} AND action = 'legacy_payout_review_resolved' AND metadata LIKE ${`%"assignmentId":${fx.perfIds[0]},%`}`);
    check("중복 지급확정 방지(재확인 → 실패 · 기록 1건 유지)", again.data.succeeded === 0 && nLog.n === 1, again.data);
    const conc = await Promise.all([3, 3].map(() => call("POST", `/admin/projects/${p.id}/legacy-payout-review/bulk`, { reason: "동시", items: [{ assignmentId: fx.perfIds[3], actualPaymentDate: YEST, actualPaymentAmount: 725250 }] })));
    check("동시 2회 클릭 → 1건만 확정", conc.reduce((a, r) => a + (r.data?.succeeded ?? 0), 0) === 1, conc.map(r => r.data));
    const other = await call("POST", `/admin/projects/${p.id + 999999}/legacy-payout-review/bulk`, { reason: "x", items: [{ assignmentId: fx.perfIds[4], actualPaymentDate: YEST, actualPaymentAmount: 1 }] });
    check("다른 판매건 경로로 확인 시도 → 실패", other.data?.succeeded === 0);
    const unp = await call("POST", `/admin/performances/${fx.perfIds[5]}/legacy-payout-review`, { decision: "unpaid", reason: "미지급 확인(테스트)" });
    const a5 = await one(sql`SELECT payment_status, actual_payment_date FROM performance_assignments WHERE id = ${fx.perfIds[5]}`);
    check("미지급 확인(기존 경로) → 미지급 전환 · 실제 지급일 없음", unp.ok && a5.payment_status === "unpaid" && a5.actual_payment_date == null, unp.data);

    console.log("\n[4] 확인 후 화면 간 상태 일치");
    d = (await call("GET", `/admin/projects/${p.id}`)).data;
    check("판매관리 수행정보: 확인 건 '지급완료' + 실제 지급일 표시", by(0).legacyPayout?.display === "paid" && by(0).actualPaymentDate?.slice(0, 10) === YEST, by(0).legacyPayout);
    u = await uni(YEST);
    const u0 = (u?.items ?? []).find((x: any) => x.id === fx.archiveIds[0]);
    check("지급회차 통합조회·지급명세서: 같은 건 '지급완료' · 근거 'VERITAS OS 지급완료 확인'", u0?.status === "paid" && String(u0?.paidBasis).includes("지급완료 확인"), u0);
    check("미확인 건은 계속 '지급확인 필요'", (u?.items ?? []).find((x: any) => x.id === fx.archiveIds[6])?.status === "deposit_unconfirmed");
    const rnd = (await call("GET", `/admin/payout-unified/rounds?dateFrom=${YEST}&dateTo=${YEST}&translator=${encodeURIComponent(tag)}`)).data;
    const r0 = (rnd?.rounds ?? rnd?.rows ?? []).find((x: any) => x.payoutDate === YEST || x.date === YEST);
    check("지급회차 집계: 지급완료 4건(확인 4) 반영", !r0 || (r0.paidCount ?? r0.paid_cnt ?? 4) >= 4, r0);
    const cand = await rows(sql`SELECT count(*)::int n FROM performance_assignments WHERE project_id = ${p.id} AND payment_status = 'unpaid' AND payout_round_id IS NULL AND deleted_at IS NULL`);
    check("지급회차 수집 대상 = 미지급 확인 1건뿐(지급완료·확인 대기는 제외 → 중복 지급 없음)", cand[0].n === 1, cand[0]);

    console.log("\n[5] 판매상품 연결 — 견적관리 저장 버그 재현 · 근거 기반 복구 · 수정 후 연결 유지");
    // (재현) 수정 전 견적관리 저장 = sourceItemId 없이 품목 재삽입 → 수행정보 36행이 삭제된 품목을 가리킴
    const putBody = (withSrc: boolean, srcId?: number) => ({ title: `${tag}_오사카수출상담회`, quoteType: "b2b_standard", issueDate: "2026-06-22", taxDocumentType: "zero_rate_tax_invoice",
      items: [{ productName: "일본어상담회통역", unit: "인일", quantity: 105, unitPrice: 400000, taxRate: 0, taxType: "zero_rate", itemType: "interpretation", ...(withSrc ? { sourceItemId: srcId } : {}) }] });
    const put1 = await call("PUT", `/admin/quotes/${q.id}`, putBody(false));
    const stale1 = await rows(sql`SELECT count(*)::int n FROM performance_assignments pa WHERE pa.project_id = ${p.id} AND pa.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM quote_items qi WHERE qi.id = pa.sale_item_id)`);
    check("(재현) 기존 방식 저장(sourceItemId 없음) → 36행 연결 끊김", put1.ok && stale1[0].n === 36, { put: put1.status, n: stale1[0].n });
    const cur1 = await one(sql`SELECT id FROM quote_items WHERE quote_id = ${q.id}`);
    const sg = (await call("GET", `/admin/projects/${p.id}/stale-sale-links`)).data.suggestions;
    check(`근거 기반 추천: 36건 모두 #${item0.id} → #${cur1.id}(견적 저장 이력·상품명 1:1)`, sg.length === 36 && sg.every((s: any) => s.suggestedItemId === cur1.id && String(s.basis).includes(`#${item0.id} → #${cur1.id}`)), sg[0]);
    const rl = await call("POST", `/admin/projects/${p.id}/stale-sale-links/relink`, { performanceIds: fx.perfIds, reason: "근거 기반 재연결(테스트)" });
    const stale2 = await rows(sql`SELECT count(*)::int n FROM performance_assignments pa WHERE pa.project_id = ${p.id} AND pa.deleted_at IS NULL AND pa.sale_item_id = ${cur1.id}`);
    check("일괄 재연결 → 36행 현재 판매상품에 연결 · 건별 감사로그", rl.ok && rl.data.succeeded === 36 && stale2[0].n === 36, rl.data?.failed);
    const rl2 = await call("POST", `/admin/projects/${p.id}/stale-sale-links/relink`, { performanceIds: [fx.perfIds[0]], reason: "재시도" });
    check("이미 정상 연결 건 재연결 요청 → 거부", rl2.data?.succeeded === 0);
    const put2 = await call("PUT", `/admin/quotes/${q.id}`, putBody(true, cur1.id));
    const cur2 = await one(sql`SELECT id FROM quote_items WHERE quote_id = ${q.id}`);
    const kept = await rows(sql`SELECT count(*)::int n FROM performance_assignments WHERE project_id = ${p.id} AND deleted_at IS NULL AND sale_item_id = ${cur2.id}`);
    check("(수정 후) 견적관리 저장(sourceItemId 포함) → 판매상품 id 변경돼도 36행 연결 유지", put2.ok && cur2.id !== cur1.id && kept[0].n === 36, { cur2: cur2.id, n: kept[0].n });
    const lgq = await one(sql`SELECT metadata FROM logs WHERE entity_type = 'quote' AND entity_id = ${q.id} AND action = 'quote_items_updated' ORDER BY id DESC LIMIT 1`);
    check("견적 저장 감사로그에 저장 후 품목 id 기록(향후 추적 근거)", JSON.parse(lgq.metadata).after.items[0].id === cur2.id);

    console.log("\n[6] 기존 데이터 보존");
    const perf1 = JSON.parse(await snapPerf()), perfB = JSON.parse(perf0);
    const saleNow = await snapSale();
    check("판매수량 105 · 판매금액 42,000,000 · 영세율 · 청구·입금정보 무변경", saleNow === sale0 && Number(JSON.parse(saleNow)[0].items[0].q) === 105 && Number(JSON.parse(saleNow)[0].price) === 42000000, { a: saleNow, b: sale0 });
    check("수행정보 36행 수량·단가·원가·세금처리·지급예정일 무변경", JSON.stringify(perf1) === JSON.stringify(perfB));
  } finally {
    const P = fx.projectId ?? 0, Q = fx.quoteId ?? 0;
    const PA = sql.join((fx.perfIds.length ? fx.perfIds : [0]).map(i => sql`${i}`), sql`, `), AR = sql.join((fx.archiveIds.length ? fx.archiveIds : [0]).map(i => sql`${i}`), sql`, `);
    await db.execute(sql`DELETE FROM logs WHERE (entity_type = 'project' AND entity_id = ${P}) OR (entity_type = 'quote' AND entity_id = ${Q}) OR (entity_type = 'company' AND entity_id = ${fx.companyId ?? 0})`);
    await db.execute(sql`DELETE FROM import_row_sources WHERE batch_id = ${fx.batchId ?? 0}`);
    await db.execute(sql`DELETE FROM legacy_master_mappings WHERE import_batch_id = ${fx.batchId ?? 0}`);
    await db.execute(sql`DELETE FROM import_batches WHERE id = ${fx.batchId ?? 0}`);
    await db.execute(sql`DELETE FROM performance_assignments WHERE id IN (${PA})`);
    await db.execute(sql`DELETE FROM legacy_archive_rows WHERE id IN (${AR})`);
    await db.execute(sql`DELETE FROM project_payments WHERE project_id = ${P}`);
    await db.execute(sql`DELETE FROM quote_items WHERE quote_id = ${Q}`);
    await db.execute(sql`DELETE FROM quotes WHERE id = ${Q}`);
    await db.execute(sql`DELETE FROM projects WHERE id = ${P}`);
    await db.execute(sql`DELETE FROM companies WHERE id = ${fx.companyId ?? 0}`);
    const [left] = await rows(sql`SELECT (SELECT count(*) FROM projects WHERE title LIKE ${tag + "%"}) p, (SELECT count(*) FROM performance_assignments WHERE performer_name_snapshot LIKE ${tag + "%"}) pa, (SELECT count(*) FROM legacy_archive_rows WHERE row_hash LIKE ${tag + "%"}) ar`);
    console.log(`\n정리 완료 — 남은 테스트 데이터: 프로젝트 ${left.p} · 수행정보 ${left.pa} · 원본행 ${left.ar}`);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
