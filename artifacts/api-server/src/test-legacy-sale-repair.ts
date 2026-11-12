// 과거 CRM 판매·청구·담당자 보정 검증 — 개발 DB 전용(운영 연결이면 중단). 임시 fixture 를 만들고 끝나면 모두 삭제한다.
//  [A] 통역 품목 판정 — 킨텍스 원본(36행, 6행 파일명 메모) → 105 × 400,000
//  [B] 신규 전환(executeActivation) — 통역 105 × 400,000, 금액·수행 36건 그대로
//  [C] 기존 전환 판매 품목 복원 — 산출 근거 비고, 금액·수행·청구 불변, 되돌리기
//  [D] 청구정보 복원 — 생성/발행일 채움/보류 7유형, 재실행 안전, 되돌리기
//  [E] 담당자 이메일 보완 — 같은 거래처만, 충돌·동명이인·중복거래처 보류, 되돌리기
//  [F] 킨텍스형 거래처·담당자 재연결 — 이전 Master 보존, 견적 수신자 이메일, 되돌리기
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { decideItemDetail, kindMatchesItemType, planItemRestore, applyItemRestore, rollbackItemRestore } from "./services/legacyQuoteItemRestore";
import { buildActivationPlan, executeActivation } from "./services/legacySaleActivation";
import { planBillingRestore, applyBillingRestore, rollbackBillingRestore, planContactEmailFill, applyContactEmailFill, rollbackContactEmailFill,
  relinkSaleParty, rollbackSaleParty } from "./services/legacySaleRepair";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await rows(q))[0];
const L = (xs: number[]) => sql.join(xs.map(i => sql`${i}`), sql`, `);

// 킨텍스 2026-06-22-0003 진행관리표 원본(20261110.xls) — 개인정보 칸 제외, 통번역사명은 테스트 이름
const KINTEX = { "내용": "통역", "단가": "400,000", "단위": null, "비고": "일본현지통역건으로 영세율 발행", "수량": "105", "총액": "42,000,000", "고객명": "김유라",
  "글자수": "0", "단어수": "0", "부가세": "0", "공급가액": "42,000,000", "연락처": "031-995-8845", "파일명": null, "견적서구분": "일반견적서", "체결일": "2026-06-22",
  "견적서발행일": "2026-11-03", "계산서발행일": "2026-11-09", "통번역사명": "__TEST_통역사", "통번역사납품일": "2026-10-21", "지급액(세전)": "50,000", "지금액(세후)": "48,350" };
const kintexRows = () => Array.from({ length: 36 }, (_, i) => ({ ...KINTEX, "파일명": i % 6 === 0 ? "원천세제외 대상자" : null, "통번역사명": `__TEST_통역사${i}` }));

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const tag = `__TEST_SR_${Date.now()}`;
  const made = { legacy: [] as number[], projects: [] as number[], batches: [] as number[], companies: [] as number[] };
  const S = (k: string) => `${tag}-${k}`;

  let rowSeq = 0;
  const legacySale = async (saleNo: string, product: string, total: number, progs: Array<Record<string, unknown>>, rawExtra: Record<string, unknown> = {}) => {
    const fh = `${tag}_${++rowSeq}`;
    const [s] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
      VALUES ('sales_list', ${fh}, 'Sheet1', 1, ${tag + "_거래처"}, ${product}, ${total},
        ${JSON.stringify({ "판매번호": saleNo, "거래처명": tag + "_거래처", "상품명": product, "총액": total.toLocaleString(), "영업담당자": null, "입금일": null, "입금내역": null, "세금계산서발행(예정)일": null, ...rawExtra })}::jsonb, ${fh}) RETURNING id`);
    made.legacy.push(Number(s.id));
    let i = 0;
    for (const p of progs) {
      const [r] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
        VALUES ('progress', ${fh}, 'P', ${++i}, ${tag + "_거래처"}, ${product}, ${total}, ${JSON.stringify({ ...p, "거래처명": tag + "_거래처", "상품명": product })}::jsonb, ${fh + "p" + i}) RETURNING id`);
      made.legacy.push(Number(r.id));
      await db.execute(sql`INSERT INTO legacy_sales_progress_links (sale_row_id, progress_row_id, sale_no, match_key, match_method, decision) VALUES (${s.id}, ${r.id}, ${saleNo}, 'test', 'test', 'confirmed')`);
    }
    return Number(s.id);
  };
  // 기존 로직으로 전환된 판매(품목 1 × 공급가액, 건, 비고 없음) + 선택: 거래처·담당자
  const convertedOld = async (saleNo: string, product: string, supply: number, vat: number, o: { itemType?: string; companyId?: number; contactId?: number; financial?: string } = {}) => {
    const [p] = await rows(sql`INSERT INTO projects (user_id, title, status, company_id, contact_id, financial_status) VALUES (${admin.id}, ${product}, 'approved', ${o.companyId ?? null}, ${o.contactId ?? null}, ${o.financial ?? "billed"}) RETURNING id`);
    made.projects.push(Number(p.id));
    const [q] = await rows(sql`INSERT INTO quotes (project_id, price, status, title, issue_date, customer_contact_name) VALUES (${p.id}, ${supply + vat}, 'approved', ${product}, '2026-06-22', '김유라') RETURNING id`);
    const [x] = await rows(sql`INSERT INTO quote_items (quote_id, product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, item_type, tax_type, is_custom_product)
      VALUES (${q.id}, ${product}, '건', '1', ${String(supply)}, ${String(supply)}, ${String(vat)}, ${String(supply + vat)}, ${o.itemType ?? "interpretation"}, 'taxable', true) RETURNING id`);
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status) VALUES ('old_crm', 'sale', ${saleNo}, ${p.id}, 'activation', 'active')`);
    return { projectId: Number(p.id), quoteId: Number(q.id), itemId: Number(x.id) };
  };
  const company = async (name: string, brn: string | null, alias: string) => {
    const [c] = await rows(sql`INSERT INTO companies (name, business_number) VALUES (${name}, ${brn}) RETURNING id`);
    made.companies.push(Number(c.id));
    await db.execute(sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias) VALUES (${c.id}, ${alias}, ${alias})`);
    return Number(c.id);
  };
  const contact = async (companyId: number, name: string, email: string | null, phone: string | null) =>
    Number((await one(sql`INSERT INTO contacts (company_id, name, email, phone) VALUES (${companyId}, ${name}, ${email}, ${phone}) RETURNING id`)).id);
  const snap = async (q: any) => JSON.stringify(await rows(q));

  try {
    console.log("\n[A] 통역 품목 판정");
    const dk = decideItemDetail(kintexRows(), 42000000);
    check("킨텍스 36행(6행 파일명 '원천세제외 대상자') → restorable 105 × 400,000", dk.status === "restorable" && dk.detail.quantity === 105 && dk.detail.unitPrice === 400000 && dk.detail.fileName === null, dk);
    check("수량 × 단가 = 공급가액 42,000,000", dk.status === "restorable" && dk.detail.quantity! * dk.detail.unitPrice! === 42000000);
    check("통역 수량×단가 ≠ 공급가액 → amount_mismatch(보류)", decideItemDetail([{ ...KINTEX, "수량": "9", "단가": "700,000" }], 2400000).status === "amount_mismatch");
    check("통역 행마다 수량 다름 → multiple_values(보류)", decideItemDetail([KINTEX, { ...KINTEX, "수량": "104" }], 42000000).status === "multiple_values");
    check("번역 행의 파일명 차이는 여전히 multiple_values", decideItemDetail([{ ...KINTEX, "내용": "번역", "파일명": "a" }, { ...KINTEX, "내용": "번역", "파일명": "b" }], 42000000).status === "multiple_values");
    check("원본 내용 ↔ 품목 유형 일치 규칙", kindMatchesItemType("통역", "interpretation") && kindMatchesItemType("번역", "translation") && !kindMatchesItemType("통역", "translation") && !kindMatchesItemType("장비", "equipment"));

    console.log("\n[B] 신규 전환 — 킨텍스 원본 재현");
    const kRow = await legacySale(S("KNEW"), "일본어상담회통역", 42000000, kintexRows(), { "세금계산서발행(예정)일": "2026-11-09" });
    const plan = await buildActivationPlan(db, kRow);
    check("미리보기 itemDetail = restorable", plan.itemDetail.status === "restorable", plan.itemDetail);
    const act = await executeActivation(kRow, plan.planToken, { id: admin.id });
    made.projects.push(act.projectId); made.batches.push(act.batchId);
    const it = await one(sql`SELECT quantity, unit, unit_price, supply_amount, tax_amount, total_amount, memo FROM quote_items WHERE id = ${act.itemId}`);
    check("품목 105 × 400,000 · 단위 '건'(원본 단위 없음 — 임의 생성 안 함) · 비고 없음", Number(it.quantity) === 105 && Number(it.unit_price) === 400000 && it.unit === "건" && it.memo == null, it);
    check("공급가액 42,000,000 · 부가세 0 · 총액 42,000,000", Number(it.supply_amount) === 42000000 && Number(it.tax_amount) === 0 && Number(it.total_amount) === 42000000, it);
    check("수행정보 36건 그대로(판매수량 105로 추가 생성 없음)", Number((await one(sql`SELECT count(*) n FROM performance_assignments WHERE project_id = ${act.projectId}`)).n) === 36);
    // 전환 시 공통 규칙으로 발행정보(청구 1회차) 생성 — 이후 계획은 already_billed(중복 없음)
    if ((act as any).billingRestore) made.batches.push((act as any).billingRestore.batchId);
    const kNewPay = await rows(sql`SELECT issue_date, amount, vat_amount, deposit_status FROM project_payments WHERE project_id = ${act.projectId}`);
    check("전환 시 청구 1회차 생성(2026-11-09, 42,000,000, 부가세 0, 입금예정)", (act as any).billingRestore?.restored === 1 && kNewPay.length === 1 && String(kNewPay[0].issue_date).slice(0, 10) === "2026-11-09"
      && Number(kNewPay[0].amount) === 42000000 && Number(kNewPay[0].vat_amount) === 0 && kNewPay[0].deposit_status === "scheduled", { br: (act as any).billingRestore, kNewPay });
    check("전환 후 청구 계획 = already_billed(재실행해도 중복 없음)", (await planBillingRestore(db, { saleNos: [S("KNEW")] }))[0]?.status === "already_billed");

    console.log("\n[C] 기존 전환 판매 품목 복원(킨텍스형)");
    await legacySale(S("KOLD"), "일본어상담회통역", 42000000, kintexRows(), { "세금계산서발행(예정)일": "2026-11-09" });
    const kOld = await convertedOld(S("KOLD"), "일본어상담회통역", 42000000, 0);
    const perfOld = await snap(sql`SELECT * FROM performance_assignments WHERE project_id = ${kOld.projectId}`);
    const ip = (await planItemRestore(db, { saleNos: [S("KOLD")] }))[0];
    check("계획: restorable 1 × 42,000,000 → 105 × 400,000(단위 '건' 유지·확인 사유 기록)", ip?.status === "restorable" && ip.after?.quantity === 105 && ip.after?.unitPrice === 400000 && ip.after?.unit === "건" && !!ip.unitCheck, ip);
    const ir = await db.transaction(tx => applyItemRestore(tx as any, { userId: admin.id, saleNos: [S("KOLD")], basisNotes: { [S("KOLD")]: "통역사 35명 × 3일 = 105" } }));
    made.batches.push(ir.batchId);
    const kIt = await one(sql`SELECT id, quantity, unit, unit_price, supply_amount, tax_amount, total_amount, memo FROM quote_items WHERE quote_id = ${kOld.quoteId}`);
    check("품목 id 유지 · 105 × 400,000 · 산출 근거 비고", Number(kIt.id) === kOld.itemId && Number(kIt.quantity) === 105 && Number(kIt.unit_price) === 400000 && kIt.memo === "통역사 35명 × 3일 = 105", kIt);
    check("금액 불변 42,000,000 / 0 / 42,000,000 · 수량×단가 = 공급가액", Number(kIt.supply_amount) === 42000000 && Number(kIt.tax_amount) === 0 && Number(kIt.total_amount) === 42000000 && Number(kIt.quantity) * Number(kIt.unit_price) === Number(kIt.supply_amount));
    const irRec = await one(sql`SELECT source_raw FROM import_row_sources WHERE batch_id = ${ir.batchId}`);
    check("근거 기록: 전후 값 · 산출 근거 출처(user_confirmed) · 단위 확인 사유", irRec?.source_raw?.before?.quantity === 1 && irRec.source_raw.after?.quantity === 105 && irRec.source_raw.basisNote?.origin === "user_confirmed" && !!irRec.source_raw.unitCheck, irRec?.source_raw);
    check("재실행 → 변경 0건(already_restored)", (await planItemRestore(db, { saleNos: [S("KOLD")] }))[0]?.status === "already_restored");
    check("수행정보 불변", (await snap(sql`SELECT * FROM performance_assignments WHERE project_id = ${kOld.projectId}`)) === perfOld);
    const irb = await db.transaction(tx => rollbackItemRestore(tx as any, ir.batchId));
    const kBack = await one(sql`SELECT quantity, unit_price, memo FROM quote_items WHERE id = ${kOld.itemId}`);
    check("되돌리기 → 1 × 42,000,000 · 비고 없음", irb.reverted === 1 && Number(kBack.quantity) === 1 && Number(kBack.unit_price) === 42000000 && kBack.memo == null, kBack);

    console.log("\n[D] 청구정보(세금계산서 발행정보) 복원");
    const tr = (sup: string, vat: string, tot: string, extra: Record<string, unknown> = {}) => ({ ...KINTEX, "내용": "번역", "수량": "1", "단가": sup, "공급가액": sup, "부가세": vat, "총액": tot, "계산서발행일": "2026-10-01", ...extra });
    // FILL: 직원 청구 1건(발행일 없음, 금액 = 총액)
    await legacySale(S("FILL"), "한영번역", 110000, [tr("100,000", "10,000", "110,000")], { "세금계산서발행(예정)일": "2026-10-01" });
    const fill = await convertedOld(S("FILL"), "한영번역", 100000, 10000, { itemType: "translation" });
    await db.execute(sql`INSERT INTO project_payments (project_id, sequence, amount, supply_amount, vat_amount, deposit_status, payment_method) VALUES (${fill.projectId}, 1, 110000, 100000, 10000, 'scheduled', '세금계산서')`);
    // PART: 분할 청구 2건(발행일 없음)
    await legacySale(S("PART"), "한영번역", 110000, [tr("100,000", "10,000", "110,000")], { "세금계산서발행(예정)일": "2026-10-01" });
    const part = await convertedOld(S("PART"), "한영번역", 100000, 10000, { itemType: "translation" });
    await db.execute(sql`INSERT INTO project_payments (project_id, sequence, amount, deposit_status) VALUES (${part.projectId}, 1, 55000, 'scheduled'), (${part.projectId}, 2, 0, 'scheduled')`);
    // AMT: 견적이 원본과 다름(직원 수정)
    await legacySale(S("AMT"), "한영번역", 110000, [tr("100,000", "10,000", "110,000")], { "세금계산서발행(예정)일": "2026-10-01" });
    const amt = await convertedOld(S("AMT"), "한영번역", 120000, 12000, { itemType: "translation" });
    // DEP: 원본 입금기록 있음
    await legacySale(S("DEP"), "한영번역", 110000, [tr("100,000", "10,000", "110,000")], { "세금계산서발행(예정)일": "2026-10-01", "입금일": "2026-10-05" });
    const dep = await convertedOld(S("DEP"), "한영번역", 100000, 10000, { itemType: "translation" });
    // CONF: 판매목록 ↔ 진행관리표 발행일 다름
    await legacySale(S("CONF"), "한영번역", 110000, [tr("100,000", "10,000", "110,000", { "계산서발행일": "2026-10-02" })], { "세금계산서발행(예정)일": "2026-10-01" });
    const conf = await convertedOld(S("CONF"), "한영번역", 100000, 10000, { itemType: "translation" });
    // NODATE: 원본 발행일 없음
    await legacySale(S("NODATE"), "한영번역", 110000, [tr("100,000", "10,000", "110,000", { "계산서발행일": null })]);
    const nodate = await convertedOld(S("NODATE"), "한영번역", 100000, 10000, { itemType: "translation" });
    // DONE: 같은 발행일 청구 이미 있음
    await legacySale(S("DONE"), "한영번역", 110000, [tr("100,000", "10,000", "110,000", { "계산서발행일": "2026-10-01" })], { "세금계산서발행(예정)일": "2026-10-01" });
    const done = await convertedOld(S("DONE"), "한영번역", 100000, 10000, { itemType: "translation" });
    await db.execute(sql`INSERT INTO project_payments (project_id, sequence, issue_date, amount, deposit_status) VALUES (${done.projectId}, 1, '2026-10-01', 110000, 'completed')`);
    const bNames = ["KOLD", "FILL", "PART", "AMT", "DEP", "CONF", "NODATE", "DONE"].map(S);
    const bp = new Map((await planBillingRestore(db, { saleNos: bNames })).map(r => [r.saleNo, r]));
    const st = (k: string) => bp.get(S(k))?.status;
    check("분류: 킨텍스 restorable · 발행일만 채움 fill_issue_date · 분할청구 existing_payments · 금액불일치 amount_unclear · 입금기록 source_deposit · 발행일충돌 date_conflict · 원본없음 no_source_date · 기존 already_billed",
      st("KOLD") === "restorable" && st("FILL") === "fill_issue_date" && st("PART") === "existing_payments" && st("AMT") === "amount_unclear" && st("DEP") === "source_deposit"
      && st("CONF") === "date_conflict" && st("NODATE") === "no_source_date" && st("DONE") === "already_billed", [...bp.values()].map(r => [r.saleNo.slice(-6), r.status, r.reason]));
    const allPids = [kOld, fill, part, amt, dep, conf, nodate, done].map(x => x.projectId);
    const untouched = [part, amt, dep, conf, nodate, done].map(x => x.projectId);
    const pay0 = await snap(sql`SELECT * FROM project_payments WHERE project_id IN (${L(untouched)}) ORDER BY id`);
    const items0 = await snap(sql`SELECT qi.* FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${L(allPids)}) ORDER BY qi.id`);
    const proj0 = await snap(sql`SELECT id, financial_status, company_id, contact_id FROM projects WHERE id IN (${L(allPids)}) ORDER BY id`);
    const br = await db.transaction(tx => applyBillingRestore(tx as any, { userId: admin.id, saleNos: bNames }));
    made.batches.push(br.batchId);
    check("적용 2건(킨텍스 생성 + 발행일 채움)", br.restored === 2, br);
    const kPay = await rows(sql`SELECT * FROM project_payments WHERE project_id = ${kOld.projectId}`);
    check("킨텍스 청구 1회차: 발행일 2026-11-09 · 공급가 42,000,000 · 부가세 0 · 금액 42,000,000 · 세금계산서 · 입금예정(미확인)",
      kPay.length === 1 && String(kPay[0].issue_date).slice(0, 10) === "2026-11-09" && Number(kPay[0].supply_amount) === 42000000 && Number(kPay[0].vat_amount) === 0 && Number(kPay[0].amount) === 42000000
      && kPay[0].payment_method === "세금계산서" && kPay[0].deposit_status === "scheduled" && kPay[0].deposit_confirmed === false && kPay[0].paid_date == null && Number(kPay[0].sequence) === 1, kPay);
    const fPay = await one(sql`SELECT issue_date, amount, deposit_status FROM project_payments WHERE project_id = ${fill.projectId}`);
    check("발행일만 채움(금액·입금상태 불변)", String(fPay.issue_date).slice(0, 10) === "2026-10-01" && Number(fPay.amount) === 110000 && fPay.deposit_status === "scheduled", fPay);
    check("보류 건 청구·입금 불변", (await snap(sql`SELECT * FROM project_payments WHERE project_id IN (${L(untouched)}) ORDER BY id`)) === pay0);
    check("견적 품목·판매금액·재무상태 불변", (await snap(sql`SELECT qi.* FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE q.project_id IN (${L(allPids)}) ORDER BY qi.id`)) === items0
      && (await snap(sql`SELECT id, financial_status, company_id, contact_id FROM projects WHERE id IN (${L(allPids)}) ORDER BY id`)) === proj0);
    check("수금거래 생성 없음", Number((await one(sql`SELECT count(*) n FROM payment_transactions WHERE project_id IN (${L(allPids)})`)).n) === 0);
    const br2 = await db.transaction(tx => applyBillingRestore(tx as any, { userId: admin.id, saleNos: bNames }));
    made.batches.push(br2.batchId);
    check("재실행 → 0건(중복 청구회차 없음)", br2.restored === 0 && Number((await one(sql`SELECT count(*) n FROM project_payments WHERE project_id = ${kOld.projectId}`)).n) === 1, br2);
    const brb = await db.transaction(tx => rollbackBillingRestore(tx as any, br.batchId));
    check("되돌리기 → 생성 청구 삭제 · 채운 발행일 비움", brb.reverted === 2 && Number((await one(sql`SELECT count(*) n FROM project_payments WHERE project_id = ${kOld.projectId}`)).n) === 0
      && (await one(sql`SELECT issue_date FROM project_payments WHERE project_id = ${fill.projectId}`)).issue_date == null, brb);

    console.log("\n[E] 담당자 이메일 보완");
    const coA = await company(`${tag}_가`, null, `${tag}가`);
    const eTarget = await contact(coA, "홍길동", null, "0212345678");
    const eDonor = await contact(coA, "홍길동 과장", "hong@test.example", null);
    const conflictT = await contact(coA, "이몽룡", null, null);
    await contact(coA, "이몽룡", "a@test.example", null); await contact(coA, "이몽룡 대리", "b@test.example", null);
    const phoneT = await contact(coA, "성춘향", null, "0211112222");
    await contact(coA, "성춘향", "sung@test.example", "0233334444");
    const coB = await company(`${tag}_나`, "1234567890", `${tag}가`);   // 같은 별칭 = 중복 거래처
    const dupT = await contact(coA, "김유라", null, "0319958845");
    await contact(coB, "김유라과장", "youra@test.example", null);
    const coC = await company(`${tag}_다`, null, `${tag}다`);
    const otherT = await contact(coA, "박지성", null, null);
    await contact(coC, "박지성", "park@test.example", null);
    await legacySale(S("EM"), "한영번역", 110000, [tr("100,000", "10,000", "110,000")]);
    const em = await convertedOld(S("EM"), "한영번역", 100000, 10000, { itemType: "translation", companyId: coA, contactId: eTarget });
    await db.execute(sql`UPDATE quotes SET customer_contact_name = '홍길동' WHERE id = ${em.quoteId}`);
    for (const [k, c] of [["E1", conflictT], ["E2", phoneT], ["E3", dupT], ["E4", otherT]] as const)
      await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status) VALUES ('old_crm', 'sale_contact', ${S(k)}, ${c}, 'test', 'active')`);
    const ep = new Map((await planContactEmailFill(db, { contactIds: [eTarget, conflictT, phoneT, dupT, otherT] })).map(r => [r.contactId, r]));
    check("분류: 같은 거래처 동일인 fillable · 이메일 여러 개 email_conflict · 연락처 다름 phone_conflict · 중복 거래처 duplicate_company · 다른 거래처 other_company_only",
      ep.get(eTarget)?.status === "fillable" && ep.get(eTarget)?.email === "hong@test.example" && ep.get(conflictT)?.status === "email_conflict" && ep.get(phoneT)?.status === "phone_conflict"
      && ep.get(dupT)?.status === "duplicate_company" && ep.get(otherT)?.status === "other_company_only", [...ep.values()].map(r => [r.name, r.status]));
    const c0 = await snap(sql`SELECT id, email, name, company_id FROM contacts WHERE company_id IN (${L([coA, coB, coC])}) AND id <> ${eTarget} ORDER BY id`);
    const er = await db.transaction(tx => applyContactEmailFill(tx as any, { userId: admin.id, contactIds: [eTarget, conflictT, phoneT, dupT, otherT] }));
    made.batches.push(er.batchId);
    const eAfter = await one(sql`SELECT email, company_id FROM contacts WHERE id = ${eTarget}`);
    check("이메일만 보완 1명(소속 거래처 그대로)", er.filled === 1 && eAfter.email === "hong@test.example" && Number(eAfter.company_id) === coA, { er, eAfter });
    check("전환 견적 수신자 이메일(비어 있던 값)도 보완", (await one(sql`SELECT customer_contact_email e FROM quotes WHERE id = ${em.quoteId}`)).e === "hong@test.example");
    check("보류 담당자·다른 담당자 불변(덮어쓰기·연결 없음)", (await snap(sql`SELECT id, email, name, company_id FROM contacts WHERE company_id IN (${L([coA, coB, coC])}) AND id <> ${eTarget} ORDER BY id`)) === c0);
    const erb = await db.transaction(tx => rollbackContactEmailFill(tx as any, er.batchId));
    check("되돌리기 → 담당자·견적 이메일 비움", erb.reverted === 1 && (await one(sql`SELECT email FROM contacts WHERE id = ${eTarget}`)).email == null
      && (await one(sql`SELECT customer_contact_email e FROM quotes WHERE id = ${em.quoteId}`)).e == null, erb);

    console.log("\n[F] 킨텍스형 거래처·담당자 재연결");
    const kA = await company(`${tag}_킨텍스`, null, `${tag}킨텍스`);
    const kB = await company(`${tag}_(주)킨텍스`, "1288178009", `${tag}킨텍스`);
    const kOldContact = await contact(kA, "김유라", null, "0319958845");
    const kNewContact = await contact(kB, "김유라과장", "youra37@test.example", null);
    await legacySale(S("REL"), "일본어상담회통역", 42000000, kintexRows(), { "세금계산서발행(예정)일": "2026-11-09" });
    const rel = await convertedOld(S("REL"), "일본어상담회통역", 42000000, 0, { companyId: kA, contactId: kOldContact });
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status) VALUES ('old_crm', 'sale_contact', ${S("REL")}, ${kOldContact}, 'auto_name_created', 'active')`);
    await db.execute(sql`INSERT INTO project_payments (project_id, sequence, amount, deposit_status) VALUES (${rel.projectId}, 1, 42000000, 'scheduled')`);
    const relPay0 = await snap(sql`SELECT * FROM project_payments WHERE project_id = ${rel.projectId}`);
    const relItem0 = await snap(sql`SELECT * FROM quote_items WHERE quote_id = ${rel.quoteId}`);
    const oldMaster0 = await snap(sql`SELECT * FROM contacts WHERE id = ${kOldContact}`);
    const rr = await db.transaction(tx => relinkSaleParty(tx as any, { saleNo: S("REL"), companyId: kB, contactId: kNewContact,
      contactPatch: { expectName: "김유라과장", name: "김유라", position: "과장", phone: "031-995-8845" }, fillQuoteEmail: true }, { userId: admin.id, reason: "test" }));
    made.batches.push(rr.batchId);
    const rp = await one(sql`SELECT company_id, contact_id FROM projects WHERE id = ${rel.projectId}`);
    const rc = await one(sql`SELECT name, position, phone, email, company_id FROM contacts WHERE id = ${kNewContact}`);
    const rm = await one(sql`SELECT entity_id FROM legacy_master_mappings WHERE entity_type = 'sale_contact' AND legacy_id = ${S("REL")}`);
    const rq = await one(sql`SELECT customer_contact_email e, customer_contact_name n FROM quotes WHERE id = ${rel.quoteId}`);
    check("판매 → 기준 거래처(사업자번호)·담당자 연결", Number(rp.company_id) === kB && Number(rp.contact_id) === kNewContact && Number(rm.entity_id) === kNewContact, { rp, rm });
    check("담당자: 이름 '김유라' · 직위 '과장' · 연락처 보완 · 이메일 유지(중복 등록 없음)", rc.name === "김유라" && rc.position === "과장" && rc.phone === "031-995-8845" && rc.email === "youra37@test.example" && Number(rc.company_id) === kB, rc);
    check("견적 수신자 이메일 youra37 보완(수신자 이름 그대로)", rq.e === "youra37@test.example" && rq.n === "김유라", rq);
    check("이전 거래처·담당자 Master 보존(병합·삭제 없음)", (await snap(sql`SELECT * FROM contacts WHERE id = ${kOldContact}`)) === oldMaster0 && !!(await one(sql`SELECT id FROM companies WHERE id = ${kA} AND deleted_at IS NULL`)));
    check("담당자 수 증가 없음(신규 생성 없음)", Number((await one(sql`SELECT count(*) n FROM contacts WHERE company_id IN (${L([kA, kB])})`)).n) === 2);
    check("청구·견적 품목 불변", (await snap(sql`SELECT * FROM project_payments WHERE project_id = ${rel.projectId}`)) === relPay0 && (await snap(sql`SELECT * FROM quote_items WHERE quote_id = ${rel.quoteId}`)) === relItem0);
    const rrb = await db.transaction(tx => rollbackSaleParty(tx as any, rr.batchId));
    const rp2 = await one(sql`SELECT company_id, contact_id FROM projects WHERE id = ${rel.projectId}`);
    const rc2 = await one(sql`SELECT name, position, phone FROM contacts WHERE id = ${kNewContact}`);
    check("되돌리기 → 판매·매핑·담당자·견적 이메일 원상태", rrb.reverted.length === 4 && Number(rp2.company_id) === kA && Number(rp2.contact_id) === kOldContact && rc2.name === "김유라과장" && rc2.position == null && rc2.phone == null
      && (await one(sql`SELECT customer_contact_email e FROM quotes WHERE id = ${rel.quoteId}`)).e == null, { rrb, rp2, rc2 });
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
      await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE project_id IN (${pl}))`);
      await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM projects WHERE id IN (${pl})`);
    }
    await db.execute(sql`DELETE FROM legacy_master_mappings WHERE legacy_id LIKE ${tag + "%"}`);
    if (made.companies.length) {
      await db.execute(sql`DELETE FROM logs WHERE entity_type = 'company' AND entity_id IN (${L(made.companies)})`);
      await db.execute(sql`DELETE FROM contacts WHERE company_id IN (${L(made.companies)})`);
      await db.execute(sql`DELETE FROM companies WHERE id IN (${L(made.companies)})`);
    }
    if (made.batches.length) {
      await db.execute(sql`DELETE FROM import_row_sources WHERE batch_id IN (${L(made.batches)})`);
      await db.execute(sql`DELETE FROM import_batches WHERE id IN (${L(made.batches)})`);
    }
    if (made.legacy.length) {
      await db.execute(sql`DELETE FROM legacy_sales_progress_links WHERE sale_row_id IN (${L(made.legacy)}) OR progress_row_id IN (${L(made.legacy)})`);
      await db.execute(sql`DELETE FROM legacy_archive_rows WHERE id IN (${L(made.legacy)})`);
    }
    const left = await one(sql`SELECT (SELECT count(*) FROM legacy_archive_rows WHERE file_hash LIKE ${tag + "%"}) a, (SELECT count(*) FROM legacy_master_mappings WHERE legacy_id LIKE ${tag + "%"}) b,
      (SELECT count(*) FROM companies WHERE name LIKE ${tag + "%"}) c`);
    check("fixture 정리 완료", Number(left.a) === 0 && Number(left.b) === 0 && Number(left.c) === 0, left);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
