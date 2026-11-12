// 과거 CRM 견적 품목 상세정보 복원 검증 — 개발 DB 전용(운영 연결이면 중단). 임시 fixture 를 만들고 끝나면 모두 삭제한다.
//  [A] 판단 규칙(decideItemDetail) 단위 검증 — 번역·감수·편집·복수 파일·통역·금액 불일치·원본 없음
//  [B] 신규 전환(executeActivation): 한국철도공사 사례 원본 → 품목 2 × 35,000, 파일명·단어수·글자수, 금액 70,000/7,000/77,000
//  [C] 기존 전환 판매 복원(applyItemRestore): 품목 id 유지·금액 불변·재실행 안전·수정 품목/통역/복수행/복수품목 미변경·되돌리기·결제정보 불변
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { decideItemDetail, sourceDetailOf, encodeDocMemo, planItemRestore, applyItemRestore, rollbackItemRestore } from "./services/legacyQuoteItemRestore";
import { buildActivationPlan, executeActivation } from "./services/legacySaleActivation";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await rows(q))[0];

// 한국철도공사 Q261110-045 원본(진행관리표 20261110.xls 32행) — 개인정보 칸 제외
const KORAIL = { "내용": "번역", "단가": "35,000", "단위": "단어", "비고": null, "수량": "2", "총액": "77,000", "고객명": "홍하림", "글자수": "1,440", "단어수": "504",
  "상품명": "한영번역", "파일명": "12월-리플릿_표지후면-(301x216)", "거래처명": "", "공급가액": "70,000", "부가세": "7,000", "견적서구분": "일반견적서", "체결일": "2026-11-10",
  "견적서발행일": "2026-11-06", "통번역사명": "__TEST_번역사", "통번역사납품일": "2026-11-10" };

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const tag = `__TEST_QIR_${Date.now()}`;
  const made = { legacy: [] as number[], projects: [] as number[], saleNos: [] as string[], batches: [] as number[] };

  console.log("\n[A] 판단 규칙");
  const d1 = decideItemDetail([KORAIL], 70000);
  check("번역 단일행 → restorable(2 × 35,000, 원본 '단위'는 분량 기준 volumeBasis='단어', 파일명·504단어·1440글자)", d1.status === "restorable" && d1.detail.quantity === 2 && d1.detail.unitPrice === 35000
    && d1.detail.volumeBasis === "단어" && d1.detail.translatorQuantity === null && d1.detail.fileName === "12월-리플릿_표지후면-(301x216)" && d1.detail.wordCount === "504" && d1.detail.charCount === "1440", d1);
  check("메모 인코딩 = 견적 편집기·PDF 규약", encodeDocMemo(null, (d1 as any).detail) === "파일: 12월-리플릿_표지후면-(301x216) | 단어수: 504 | 글자수: 1440");
  check("기존 사용자 비고 보존 후 문서정보 추가", encodeDocMemo("고객 요청 메모", (d1 as any).detail)!.startsWith("고객 요청 메모 / 파일: "));
  check("감수 상품(내용=번역) → restorable", decideItemDetail([{ ...KORAIL, "상품명": "영문감수", "수량": "3", "단가": "20,000" }], 60000).status === "restorable");
  check("편집 상품(내용=번역) → restorable", decideItemDetail([{ ...KORAIL, "상품명": "텍스트편집", "수량": "1", "단가": "70,000" }], 70000).status === "restorable");
  check("복수 파일(행별 파일명 다름) → multiple_values", decideItemDetail([KORAIL, { ...KORAIL, "파일명": "다른파일.docx" }], 70000).status === "multiple_values");
  check("같은 값 반복 행(대표값) → 금액 일치 시에만 확정", decideItemDetail([KORAIL, KORAIL], 70000).status === "restorable" && decideItemDetail([KORAIL, KORAIL], 140000).status === "amount_mismatch");
  check("통역 단일값 → restorable(수량·단가만, 파일명·단어수·글자수는 품목 정보 아님)", (() => { const d = decideItemDetail([{ ...KORAIL, "내용": "통역" }], 70000); return d.status === "restorable" && d.detail.fileName === null && d.detail.wordCount === null; })());
  check("내용이 번역·통역이 아니면 → not_document", decideItemDetail([{ ...KORAIL, "내용": "장비" }], 70000).status === "not_document");
  check("수량×단가 ≠ 공급가액 → amount_mismatch", decideItemDetail([KORAIL], 30000).status === "amount_mismatch");
  check("원본 행 없음 → no_progress", decideItemDetail([], 70000).status === "no_progress");
  check("글자수 0·빈값은 없음으로(값 생성 없음)", (() => { const d = decideItemDetail([{ ...KORAIL, "글자수": "0", "단어수": null }], 70000); return d.status === "restorable" && d.detail.charCount === null && d.detail.wordCount === null; })());

  // fixture 도우미 — 과거 CRM 판매목록 1행 + 진행행 n개 + 확정 연결
  let rowSeq = 0;
  const legacySale = async (saleNo: string, product: string, total: number, progs: Array<Record<string, unknown>>) => {
    const fh = `${tag}_${++rowSeq}`;
    const [s] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
      VALUES ('sales_list', ${fh}, 'Sheet1', 1, ${tag + "_거래처"}, ${product}, ${total}, ${JSON.stringify({ "판매번호": saleNo, "거래처명": tag + "_거래처", "상품명": product, "총액": total.toLocaleString(), "영업담당자": null })}::jsonb, ${fh}) RETURNING id`);
    made.legacy.push(Number(s.id)); made.saleNos.push(saleNo);
    let i = 0;
    for (const p of progs) {
      const [r] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
        VALUES ('progress', ${fh}, 'P', ${++i}, ${tag + "_거래처"}, ${product}, ${total}, ${JSON.stringify({ ...p, "거래처명": tag + "_거래처", "상품명": product })}::jsonb, ${fh + "p" + i}) RETURNING id`);
      made.legacy.push(Number(r.id));
      await db.execute(sql`INSERT INTO legacy_sales_progress_links (sale_row_id, progress_row_id, sale_no, match_key, match_method, decision) VALUES (${s.id}, ${r.id}, ${saleNo}, 'test', 'test', 'confirmed')`);
    }
    return Number(s.id);
  };
  // 기존 로직으로 전환된 판매 재현(품목 1 × 공급가액, 건, 비고 없음)
  const convertedOld = async (saleNo: string, product: string, supply: number, vat: number, items: Array<Partial<{ quantity: number; unit: string; unitPrice: number; memo: string | null; itemType: string }>> = [{}]) => {
    const [p] = await rows(sql`INSERT INTO projects (user_id, title, status) VALUES (${admin.id}, ${product}, 'approved') RETURNING id`);
    made.projects.push(Number(p.id));
    const [q] = await rows(sql`INSERT INTO quotes (project_id, price, status, title, issue_date) VALUES (${p.id}, ${supply + vat}, 'approved', ${product}, '2026-11-10') RETURNING id`);
    const itemIds: number[] = [];
    for (const it of items) {
      const [x] = await rows(sql`INSERT INTO quote_items (quote_id, product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, item_type, tax_type, memo, is_custom_product)
        VALUES (${q.id}, ${product}, ${it.unit ?? "건"}, ${String(it.quantity ?? 1)}, ${String(it.unitPrice ?? supply)}, ${String(supply / items.length)}, ${String(vat / items.length)}, ${String((supply + vat) / items.length)},
          ${it.itemType ?? "translation"}, 'taxable', ${it.memo ?? null}, true) RETURNING id`);
      itemIds.push(Number(x.id));
    }
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status) VALUES ('old_crm', 'sale', ${saleNo}, ${p.id}, 'activation', 'active')`);
    return { projectId: Number(p.id), quoteId: Number(q.id), itemIds };
  };

  try {
    // 통번역수량 = 단어수(원본 '단위'가 분량 기준임을 보여 주는 값)
  check("통번역수량은 분량 근거로만 기록", sourceDetailOf({ ...KORAIL, "통번역수량": "504" }).translatorQuantity === "504");
  console.log("\n[B] 신규 전환 — 한국철도공사 원본 재현");
    const korailRow = await legacySale(`${tag}-KORAIL`, "한영번역", 77000, [KORAIL]);
    const plan = await buildActivationPlan(db, korailRow);
    check("전환 미리보기 itemDetail = restorable", plan.itemDetail.status === "restorable", plan.itemDetail);
    const act = await executeActivation(korailRow, plan.planToken, { id: admin.id });
    made.projects.push(act.projectId); made.batches.push(act.batchId);
    const it = await one(sql`SELECT quantity, unit, unit_price, supply_amount, tax_amount, total_amount, memo FROM quote_items WHERE id = ${act.itemId}`);
    const qq = await one(sql`SELECT price FROM quotes WHERE id = ${act.quoteId}`);
    check("품목 = 2건 × 35,000 (원본 수량·단가, 단위는 '단어'로 정하지 않고 기본 '건')", Number(it.quantity) === 2 && it.unit === "건" && Number(it.unit_price) === 35000, it);
    check("공급가액 70,000 · 부가세 7,000 · 총액 77,000 유지", Number(it.supply_amount) === 70000 && Number(it.tax_amount) === 7000 && Number(it.total_amount) === 77000 && Number(qq.price) === 77000, { it, qq });
    check("파일명·단어수·글자수(memo 규약)", it.memo === "파일: 12월-리플릿_표지후면-(301x216) | 단어수: 504 | 글자수: 1440", it.memo);
    const lin = await one(sql`SELECT source_raw FROM import_row_sources WHERE batch_id = ${act.batchId} AND status = 'activated'`);
    check("이관 근거: 원본 분량 기준 '단어'·단위 확인 대상 기록", lin?.source_raw?.itemDetail?.status === "restored_from_progress" && lin.source_raw.itemDetail.source?.volumeBasis === "단어"
      && lin.source_raw.itemDetail.unitCheck?.appliedUnit === "건" && lin.source_raw.itemDetail.unitCheck?.crmVolumeBasis === "단어", lin?.source_raw?.itemDetail);
    // 이미 정확히 전환된 견적은 복원 대상 아님(재이관·재실행 시 덮어쓰기 없음)
    const p0 = await planItemRestore(db, { saleNos: [`${tag}-KORAIL`] });
    check("이미 원본대로 전환된 견적 → already_restored(변경 없음)", p0[0]?.status === "already_restored", p0[0]);

    console.log("\n[C] 기존 전환 판매 복원");
    const S = (k: string) => `${tag}-${k}`;
    await legacySale(S("TR"), "한영번역", 77000, [KORAIL]);
    const tr = await convertedOld(S("TR"), "한영번역", 70000, 7000);
    await legacySale(S("REV"), "영문감수", 66000, [{ ...KORAIL, "상품명": "영문감수", "수량": "3", "단가": "20,000", "공급가액": "60,000", "부가세": "6,000", "총액": "66,000", "파일명": "감수본.docx", "글자수": "0", "단어수": "1,200" }]);
    const rev = await convertedOld(S("REV"), "영문감수", 60000, 6000);
    await legacySale(S("INT"), "영어순차통역", 550000, [{ ...KORAIL, "내용": "통역", "수량": "1", "단가": "500,000", "공급가액": "500,000", "부가세": "50,000", "총액": "550,000", "파일명": "통역료" }]);
    const intp = await convertedOld(S("INT"), "영어순차통역", 500000, 50000, [{ itemType: "interpretation" }]);
    await legacySale(S("MULTI"), "한영번역 외1", 154000, [{ ...KORAIL, "총액": "154,000", "공급가액": "140,000", "부가세": "14,000" }, { ...KORAIL, "파일명": "두번째파일.pptx", "총액": "154,000", "공급가액": "140,000", "부가세": "14,000" }]);
    const multi = await convertedOld(S("MULTI"), "한영번역 외1", 140000, 14000);
    await legacySale(S("EDIT"), "한영번역", 77000, [KORAIL]);
    const edited = await convertedOld(S("EDIT"), "한영번역", 70000, 7000, [{ quantity: 1, unit: "페이지", unitPrice: 70000, memo: "직원 수정" }]);
    await legacySale(S("TWO"), "한영번역", 77000, [KORAIL]);
    const two = await convertedOld(S("TWO"), "한영번역", 70000, 7000, [{}, {}]);
    await legacySale(S("NOSRC"), "한영번역", 77000, []);
    const nosrc = await convertedOld(S("NOSRC"), "한영번역", 70000, 7000);
    await legacySale(S("AMT"), "한영번역", 33000, [{ ...KORAIL, "공급가액": "30,000", "부가세": "3,000", "총액": "33,000" }]);
    const amt = await convertedOld(S("AMT"), "한영번역", 30000, 3000);
    // 결제정보(불변 확인)
    await db.execute(sql`INSERT INTO project_payments (project_id, sequence, amount, deposit_status) VALUES (${tr.projectId}, 1, 77000, 'scheduled')`);
    const paySnap = async () => JSON.stringify(await rows(sql`SELECT * FROM project_payments WHERE project_id = ${tr.projectId} ORDER BY id`));
    const pay0 = await paySnap();
    const snapItems = async (ids: number[]) => JSON.stringify(await rows(sql`SELECT * FROM quote_items WHERE id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)}) ORDER BY id`));
    const others = [...intp.itemIds, ...multi.itemIds, ...edited.itemIds, ...two.itemIds, ...nosrc.itemIds, ...amt.itemIds];
    const others0 = await snapItems(others);

    const names = ["TR", "REV", "INT", "MULTI", "EDIT", "TWO", "NOSRC", "AMT"].map(S);
    const plan1 = new Map((await planItemRestore(db, { saleNos: names })).map(r => [r.saleNo, r]));
    check("계획: 단위는 변경 대상 아님 + 단위 확인 사유 기록", plan1.get(S("TR"))?.after?.unit === "건" && !!plan1.get(S("TR"))?.unitCheck);
    check("계획: 번역·감수 restorable / 통역 1×공급가(원본과 같음) already_restored / 복수행 multiple_values / 수정품목 edited / 복수품목 multi_item / 원본없음 no_progress / 금액불일치 amount_mismatch",
      plan1.get(S("TR"))?.status === "restorable" && plan1.get(S("REV"))?.status === "restorable" && plan1.get(S("INT"))?.status === "already_restored"
      && plan1.get(S("MULTI"))?.status === "multiple_values" && plan1.get(S("EDIT"))?.status === "edited_after_activation" && plan1.get(S("TWO"))?.status === "multi_item"
      && plan1.get(S("NOSRC"))?.status === "no_progress" && plan1.get(S("AMT"))?.status === "amount_mismatch", [...plan1.values()].map(r => [r.saleNo.slice(-6), r.status]));

    const res = await db.transaction(tx => applyItemRestore(tx as any, { userId: admin.id, saleNos: names }));
    made.batches.push(res.batchId);
    check("복원 2건(번역·감수)만 실행", res.restored === 2, res);
    const trIt = await one(sql`SELECT id, quantity, unit, unit_price, supply_amount, tax_amount, total_amount, memo FROM quote_items WHERE quote_id = ${tr.quoteId}`);
    check("품목 id 유지(삭제·재생성 없음)", Number(trIt.id) === tr.itemIds[0]);
    check("번역: 2건 × 35,000(단위 불변) · 파일명·단어수·글자수", Number(trIt.quantity) === 2 && trIt.unit === "건" && Number(trIt.unit_price) === 35000 && trIt.memo === "파일: 12월-리플릿_표지후면-(301x216) | 단어수: 504 | 글자수: 1440", trIt);
    check("금액 불변 70,000/7,000/77,000", Number(trIt.supply_amount) === 70000 && Number(trIt.tax_amount) === 7000 && Number(trIt.total_amount) === 77000);
    const revIt = await one(sql`SELECT quantity, unit_price, memo FROM quote_items WHERE quote_id = ${rev.quoteId}`);
    check("감수: 3 × 20,000 · 글자수 0 은 기록 안 함", Number(revIt.quantity) === 3 && Number(revIt.unit_price) === 20000 && revIt.memo === "파일: 감수본.docx | 단어수: 1200", revIt);
    check("통역·복수행·수정품목·복수품목·원본없음·금액불일치 품목 불변", (await snapItems(others)) === others0);
    check("결제(청구·입금) 정보 불변", (await paySnap()) === pay0);
    const rec = await one(sql`SELECT source_raw FROM import_row_sources WHERE batch_id = ${res.batchId} AND entity_id = ${tr.itemIds[0]}`);
    check("변경 전후·원본 근거 기록", rec?.source_raw?.before?.quantity === 1 && rec?.source_raw?.after?.quantity === 2 && rec?.source_raw?.source?.fileName === KORAIL["파일명"], rec?.source_raw);

    const res2 = await db.transaction(tx => applyItemRestore(tx as any, { userId: admin.id, saleNos: names }));
    made.batches.push(res2.batchId);
    check("재실행 시 변경 0건(이미 복원됨 — 덮어쓰기·중복 없음)", res2.restored === 0, res2);
    check("품목 수 그대로(중복 생성 없음)", Number((await one(sql`SELECT count(*) n FROM quote_items WHERE quote_id = ${tr.quoteId}`)).n) === 1);

    const rb = await db.transaction(tx => rollbackItemRestore(tx as any, res.batchId));
    const trBack = await one(sql`SELECT quantity, unit, unit_price, memo FROM quote_items WHERE id = ${tr.itemIds[0]}`);
    check("되돌리기 — 복원 전 값(1 건 × 70,000, 비고 없음)", rb.reverted === 2 && Number(trBack.quantity) === 1 && trBack.unit === "건" && Number(trBack.unit_price) === 70000 && trBack.memo == null, { rb, trBack });
  } finally {
    // 정리 — 이 테스트가 만든 행만
    const pids = made.projects;
    if (pids.length) {
      const pl = sql.join(pids.map(i => sql`${i}`), sql`, `);
      const qids = (await rows(sql`SELECT id FROM quotes WHERE project_id IN (${pl})`)).map(r => Number(r.id));
      const aids = (await rows(sql`SELECT id FROM performance_assignments WHERE project_id IN (${pl})`)).map(r => Number(r.id));
      if (aids.length) {
        const al = sql.join(aids.map(i => sql`${i}`), sql`, `);
        await db.execute(sql`DELETE FROM performance_deductions WHERE assignment_id IN (${al})`).catch(() => {});
        await db.execute(sql`DELETE FROM performance_expenses WHERE assignment_id IN (${al})`).catch(() => {});
        await db.execute(sql`DELETE FROM performance_assignments WHERE id IN (${al})`);
      }
      await db.execute(sql`DELETE FROM logs WHERE (entity_type = 'project' AND entity_id IN (${pl}))${qids.length ? sql` OR (entity_type = 'quote' AND entity_id IN (${sql.join(qids.map(i => sql`${i}`), sql`, `)}))` : sql``}`);
      await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE project_id IN (${pl}))`);
      await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM legacy_master_mappings WHERE entity_type = 'sale' AND entity_id IN (${pl})`);
      await db.execute(sql`DELETE FROM projects WHERE id IN (${pl})`);
    }
    if (made.batches.length) {
      const bl = sql.join(made.batches.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM import_row_sources WHERE batch_id IN (${bl})`);
      await db.execute(sql`DELETE FROM import_batches WHERE id IN (${bl})`);
    }
    await db.execute(sql`DELETE FROM logs WHERE action = 'legacy_quote_item_restored' AND metadata LIKE ${`%${tag}%`}`);
    if (made.legacy.length) {
      const ll = sql.join(made.legacy.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM legacy_sales_progress_links WHERE sale_row_id IN (${ll}) OR progress_row_id IN (${ll})`);
      await db.execute(sql`DELETE FROM legacy_archive_rows WHERE id IN (${ll})`);
    }
    const left = await one(sql`SELECT (SELECT count(*) FROM legacy_archive_rows WHERE file_hash LIKE ${tag + "%"}) a, (SELECT count(*) FROM legacy_master_mappings WHERE legacy_id LIKE ${tag + "%"}) b`);
    check("fixture 정리 완료", Number(left.a) === 0 && Number(left.b) === 0, left);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
