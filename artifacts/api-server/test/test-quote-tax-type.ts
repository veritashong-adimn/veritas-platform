// 위치: api-server/test — web-app 공용 함수(lib/quoteTaxType·quotePdf·paymentSplit)를 함께 검증하므로 api-server src 밖에 둔다. esbuild 번들로 실행.
// 견적 세금 유형(일반과세·영세율·면세) — 개발 DB · 로컬 API :8080 전용. fixture 를 만들고 끝나면 삭제한다.
//  [A] 판정·라벨 규칙(순수 함수)   [B] 견적 작성(일반·차감·누적 × 3유형) 저장·재조회·문서유형
//  [C] 과거 CRM(Q261015-068 동일 구조) 원본 총액 보호   [D] 판매전환 승계·중복 전환 차단
//  [E] 청구정보·수금관리 연동   [F] 거래처 기본 세금 유형
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { deriveVatMode, isTaxUnconfirmed, BILLING_METHOD_BY_KIND, TAX_DOCUMENT_TYPE_BY_KIND, VAT_ROW_LABEL } from "../../web-app/src/lib/quoteTaxType";
import { vatSummaryLabel, quoteTotalLabel } from "../../web-app/src/lib/quotePdf";
import { saleSplitOf, amountsFromSupply } from "../../web-app/src/lib/paymentSplit";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const B = process.env.TEST_API ?? "http://localhost:8080/api";
const n = (v: unknown) => Number(v ?? 0);
// 발행 문서 유형 — 견적 조회 API 응답에는 없는 필드라 DB 에서 직접 확인(응답 형태 변경 없음)
const docOf = async (id: number) => (await rows(sql`SELECT tax_document_type FROM quotes WHERE id = ${id}`))[0]?.tax_document_type ?? null;

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const H = { Authorization: `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "10m" })}`, "Content-Type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${B}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) as any };
  };
  const tag = `__TEST_TAX_${Date.now()}`;
  const quoteIds: number[] = [], companyIds: number[] = [], legacy: { batchId?: number; legacyId?: string } = {};
  const projectIdsOf = async () => (await rows(sql`SELECT DISTINCT project_id FROM quotes WHERE id IN (${sql.join((quoteIds.length ? quoteIds : [0]).map(i => sql`${i}`), sql`, `)}) AND project_id IS NOT NULL`)).map(r => Number(r.project_id));

  console.log("\n[A] 판정·라벨 규칙");
  const it = (taxType: string, supply: number, tax: number, itemType = "translation") => ({ taxType, supplyAmount: supply, taxAmount: tax, itemType, productType: itemType });
  check("일반과세 1,000,000/100,000 → taxable", deriveVatMode([it("taxable", 1000000, 100000)]) === "taxable");
  check("영세율 → zero_rate · 면세 → exempt (서로 다른 유형)", deriveVatMode([it("zero_rate", 1000000, 0)]) === "zero_rate" && deriveVatMode([it("exempt", 1000000, 0)]) === "exempt");
  check("과거 CRM형(taxable·부가세 0·공급가 8,800,000) → unknown(확인 필요)", deriveVatMode([it("taxable", 8800000, 0)]) === "unknown" && isTaxUnconfirmed("taxable", 8800000, 0));
  check("영세율 견적 + 할인행 → zero_rate 유지(기존: 면세로 변질)", deriveVatMode([it("zero_rate", 1000000, 0), it("zero_rate", -100000, 0, "discount")]) === "zero_rate");
  check("유형 혼재 → unknown", deriveVatMode([it("taxable", 100, 10), it("exempt", 100, 0)]) === "unknown");
  const pdfItems = (t: string, s: number, tax: number) => [{ taxType: t, supplyAmount: s, productType: "translation" }];
  check("PDF 부가세 라벨: (10%) · (영세율 0%) · (면세)",
    vatSummaryLabel(pdfItems("taxable", 1000000, 100000), 100000) === "부가세 (10%)" && vatSummaryLabel(pdfItems("zero_rate", 1000000, 0), 0) === "부가세 (영세율 0%)" && vatSummaryLabel(pdfItems("exempt", 1000000, 0), 0) === "부가세 (면세)");
  check("PDF 상단 총액 라벨: (VAT 포함) · (영세율 0%) · (면세) · 확인 필요는 '총 견적금액'",
    quoteTotalLabel(pdfItems("taxable", 1, 0.1), 100000) === "총 견적금액 (VAT 포함)" && quoteTotalLabel(pdfItems("zero_rate", 1000000, 0), 0) === "총 견적금액 (영세율 0%)"
    && quoteTotalLabel(pdfItems("exempt", 1000000, 0), 0) === "총 견적금액 (면세)" && quoteTotalLabel(pdfItems("taxable", 8800000, 0), 0) === "총 견적금액");
  check("문서유형 연결: tax_invoice · zero_rate_tax_invoice · invoice", TAX_DOCUMENT_TYPE_BY_KIND.taxable === "tax_invoice" && TAX_DOCUMENT_TYPE_BY_KIND.zero_rate === "zero_rate_tax_invoice" && TAX_DOCUMENT_TYPE_BY_KIND.exempt === "invoice");

  try {
    // ── 거래처(테스트) ──
    const [co] = await rows(sql`INSERT INTO companies (name, company_type, is_customer) VALUES (${`${tag}_UNDRR형`}, 'client', true) RETURNING id`);
    companyIds.push(Number(co.id));

    console.log("\n[F] 거래처 기본 세금 유형");
    const t0 = await call("GET", `/admin/companies/${co.id}/tax-type`);
    check("신규 거래처 기본 = 미확인(NULL)", t0.ok && t0.data.defaultTaxType === null, t0);
    const t1 = await call("PUT", `/admin/companies/${co.id}/tax-type`, { defaultTaxType: "zero_rate", taxTypeBasis: "영세율 전자세금계산서 발행 실적" });
    check("영세율 저장 → 근거·확인일·확인 담당자 기록", t1.ok && t1.data.defaultTaxType === "zero_rate" && t1.data.taxTypeBasis?.includes("영세율") && !!t1.data.taxTypeConfirmedAt && n(t1.data.taxTypeConfirmedBy) === n(admin.id), t1);
    const tBad = await call("PUT", `/admin/companies/${co.id}/tax-type`, { defaultTaxType: "vat0" });
    check("허용되지 않은 값 거부(400)", tBad.status === 400, tBad);

    console.log("\n[B] 견적 작성 — 일반·차감·누적 × 일반과세·영세율·면세");
    const kinds = ["taxable", "zero_rate", "exempt"] as const;
    const qTypes = ["b2b_standard", "b2c_prepaid", "accumulated_batch"];
    const created: Record<string, number> = {};
    for (const qt of qTypes) for (const k of kinds) {
      const body = {
        title: `${tag}_${qt}_${k}`, companyId: co.id, quoteType: qt, billingType: "postpaid_per_project", taxCategory: "normal",
        taxDocumentType: TAX_DOCUMENT_TYPE_BY_KIND[k], issueDate: "2026-11-13",
        items: [
          // 클라이언트가 영세율·면세에 taxRate 0.1 을 잘못 보내도 서버가 0 으로 강제하는지 함께 확인
          { productName: "번역", unit: "페이지", quantity: 10, unitPrice: 100000, taxRate: 0.1, taxType: k, itemType: "translation" },
        ],
      };
      if (k === "taxable") (body.items[0] as any).taxRate = 0.1;
      const r = await call("POST", "/admin/quotes", body);
      if (!r.ok) { check(`${qt}/${k} 생성`, false, r); continue; }
      quoteIds.push(r.data.id); created[`${qt}/${k}`] = r.data.id;
      const g = await call("GET", `/admin/quotes/${r.data.id}`);
      const sup = g.data.items.reduce((a: number, x: any) => a + n(x.supplyAmount), 0), tax = g.data.items.reduce((a: number, x: any) => a + n(x.taxAmount), 0);
      const expTax = k === "taxable" ? 100000 : 0;
      check(`${qt}/${k}: 공급가 1,000,000 · 부가세 ${expTax.toLocaleString()} · 총액 ${(1000000 + expTax).toLocaleString()} · 재조회 유형 ${k} · 문서유형 ${TAX_DOCUMENT_TYPE_BY_KIND[k]}`,
        sup === 1000000 && tax === expTax && n(g.data.price) === 1000000 + expTax && deriveVatMode(g.data.items) === k && await docOf(r.data.id) === TAX_DOCUMENT_TYPE_BY_KIND[k],
        { sup, tax, price: g.data.price, types: g.data.items.map((x: any) => x.taxType), doc: await docOf(r.data.id) });
    }
    // 수정(PUT) — 영세율 → 면세로 변경, 할인행 포함. 저장 후 유형·금액·문서유형 유지
    const qz = created["b2b_standard/zero_rate"];
    const put = await call("PUT", `/admin/quotes/${qz}`, {
      title: `${tag}_b2b_standard_zero_rate`, quoteType: "b2b_standard", issueDate: "2026-11-13", taxDocumentType: "invoice",
      items: [
        { productName: "번역", unit: "페이지", quantity: 10, unitPrice: 100000, taxRate: 0, taxType: "exempt", itemType: "translation" },
        { productName: "Special D.C", unit: "건", quantity: 1, unitPrice: 0, taxRate: 0, taxType: "exempt", itemType: "discount", discountType: "percent", discountValue: 10 },
      ],
    });
    const gz = await call("GET", `/admin/quotes/${qz}`);
    check("수정: 영세율 → 면세 + 10% 할인 → 공급가 900,000 · 부가세 0 · 총액 900,000 · 면세·invoice 유지",
      put.ok && n(gz.data.price) === 900000 && gz.data.items.every((x: any) => n(x.taxAmount) === 0) && deriveVatMode(gz.data.items) === "exempt" && await docOf(qz) === "invoice", { put, price: gz.data?.price });
    const qt10 = created["b2b_standard/taxable"];
    const put10 = await call("PUT", `/admin/quotes/${qt10}`, {
      title: `${tag}_b2b_standard_taxable`, quoteType: "b2b_standard", issueDate: "2026-11-13", taxDocumentType: "tax_invoice",
      items: [
        { productName: "번역", unit: "페이지", quantity: 10, unitPrice: 100000, taxRate: 0.1, taxType: "taxable", itemType: "translation" },
        { productName: "Special D.C", unit: "건", quantity: 1, unitPrice: 0, taxRate: 0.1, taxType: "taxable", itemType: "discount", discountType: "amount", discountValue: 100000 },
      ],
    });
    const g10 = await call("GET", `/admin/quotes/${qt10}`);
    check("일반과세 + 100,000 할인 → 공급가 900,000 · 부가세 90,000 · 총액 990,000(기존 계산 유지)", put10.ok && n(g10.data.price) === 990000, g10.data?.price);
    const putNoDoc = await call("PUT", `/admin/quotes/${qt10}`, { title: `${tag}_b2b_standard_taxable`, quoteType: "b2b_standard", issueDate: "2026-11-13",
      items: [{ productName: "번역", unit: "페이지", quantity: 10, unitPrice: 100000, taxRate: 0.1, taxType: "taxable", itemType: "translation" }] });
    const gNoDoc = await call("GET", `/admin/quotes/${qt10}`);
    check("문서유형 미전달 저장 → 기존값 보존", putNoDoc.ok && await docOf(qt10) === "tax_invoice");

    console.log("\n[D] 판매전환 — 세금 유형·금액 승계");
    for (const k of kinds) {
      const qid = k === "zero_rate" ? created["accumulated_batch/zero_rate"] : created[`b2b_standard/${k}`];
      const before = await call("GET", `/admin/quotes/${qid}`);
      const cv = await call("PATCH", `/admin/quotes/${qid}/status`, { status: "approved" });
      const after = await call("GET", `/admin/quotes/${qid}`);
      check(`${k} 판매전환: 유형 ${deriveVatMode(before.data.items)} → ${deriveVatMode(after.data?.items ?? [])} · 총액 ${n(before.data.price).toLocaleString()} 유지 · 문서유형 유지`,
        cv.ok && after.data.status === "approved" && deriveVatMode(after.data.items) === deriveVatMode(before.data.items) && n(after.data.price) === n(before.data.price)
        && JSON.stringify(after.data.items.map((x: any) => [x.supplyAmount, x.taxAmount, x.taxType])) === JSON.stringify(before.data.items.map((x: any) => [x.supplyAmount, x.taxAmount, x.taxType]))
        && (await docOf(qid)) === TAX_DOCUMENT_TYPE_BY_KIND[k], cv);
      const dup = await call("PATCH", `/admin/quotes/${qid}/status`, { status: "approved" });
      check(`${k} 중복 판매전환 차단`, !dup.ok, dup.status);
    }

    console.log("\n[E] 청구정보·수금관리");
    for (const k of kinds) {
      const qid = k === "zero_rate" ? created["accumulated_batch/zero_rate"] : created[`b2b_standard/${k}`];
      const q = (await call("GET", `/admin/quotes/${qid}`)).data;
      const mode = deriveVatMode(q.items);
      const sup = q.items.reduce((a: number, x: any) => a + n(x.supplyAmount), 0), vat = q.items.reduce((a: number, x: any) => a + n(x.taxAmount), 0);
      // 화면(PaymentInfoSection) 신규 청구행 기본값과 같은 규칙
      const split = saleSplitOf(q.price, sup, vat);
      const method = mode === "zero_rate" || mode === "exempt" ? BILLING_METHOD_BY_KIND[mode] : "세금계산서";
      const amt = amountsFromSupply(String(split.supply), split.zeroVat);
      const row = { issueDate: "2026-11-13", expectedDate: "2026-11-30", paidDate: null, paymentType: "lump_sum", paymentMethod: method, ...amt,
        depositStatus: "scheduled", paymentCategory: "일반결제", payer: "고객사", depositItem: "전체금액", billingCompanyId: co.id };
      const pr = await call("PUT", `/admin/projects/${q.projectId}/payment-records`, { rows: [row], deletedIds: [] });
      const [saved] = await rows(sql`SELECT payment_method, supply_amount, vat_amount, amount, issue_date FROM project_payments WHERE project_id = ${q.projectId}`);
      check(`${k}: 청구 결제·발행 유형 '${method}' · 청구 ${n(q.price).toLocaleString()} · 부가세 ${vat.toLocaleString()} (견적과 일치)`,
        pr.ok && saved?.payment_method === BILLING_METHOD_BY_KIND[k] && n(saved.amount) === n(q.price) && n(saved.vat_amount) === vat && n(saved.supply_amount) === sup, { pr, saved });
    }
    const coll = await call("GET", "/admin/collections/sales");
    const byPid = new Map<number, any>((coll.data?.rows ?? coll.data?.sales ?? []).map((r: any) => [r.projectId, r]));
    for (const k of kinds) {
      const qid = k === "zero_rate" ? created["accumulated_batch/zero_rate"] : created[`b2b_standard/${k}`];
      const q = (await call("GET", `/admin/quotes/${qid}`)).data;
      const r = byPid.get(q.projectId);
      check(`수금관리 ${k}: 세금 유형 ${k} · 판매금액 ${n(q.price).toLocaleString()} · 미입금(미수금 = 판매금액)`, !!r && r.saleTaxType === k && r.saleTotal === n(q.price) && r.status === "unpaid" && r.receivable === n(q.price), r ?? Object.keys(coll.data ?? {}));
    }

    console.log("\n[C] 과거 CRM 견적(Q261015-068 동일 구조) — 원본 총액 8,800,000 보호");
    const [lp] = await rows(sql`INSERT INTO projects (user_id, title, status, company_id) VALUES (${admin.id}, ${`${tag}_ESCAP형`}, 'approved', ${co.id}) RETURNING id`);
    const [lq] = await rows(sql`INSERT INTO quotes (project_id, quote_number, price, status, title, issue_date, is_current, tax_document_type, tax_category)
      VALUES (${lp.id}, ${`QT${Date.now() % 1e9}`}, 8800000, 'approved', ${`${tag}_ESCAP형`}, '2026-10-15', true, 'tax_invoice', 'normal') RETURNING id`);
    quoteIds.push(Number(lq.id));
    await db.execute(sql`INSERT INTO quote_items (quote_id, product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, item_type, tax_type, is_custom_product)
      VALUES (${lq.id}, '통역', '건', 1, 8800000, 8800000, 0, 8800000, 'interpretation', 'taxable', true)`);
    const [bt] = await rows(sql`INSERT INTO import_batches (module, import_type, total_rows, success_rows, warning_rows, error_rows, status, source_system)
      VALUES ('legacy_sale_activation', ${tag}, 1, 1, 0, 0, 'completed', 'old_crm') RETURNING id`);
    legacy.batchId = Number(bt.id); legacy.legacyId = `${tag}_L1`;
    await db.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw)
      VALUES (${bt.id}, 'legacy_sale_activation', ${lp.id}, ${`sale:${legacy.legacyId}`}, 'success', 'old_crm', ${legacy.legacyId}, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, import_batch_id, match_method, status)
      VALUES ('old_crm', 'sale', ${legacy.legacyId}, ${lp.id}, ${bt.id}, 'test', 'active')`);
    const lg = await call("GET", `/admin/quotes/${lq.id}`);
    check("조회: 원본 총액 8,800,000 · 세금 유형 '확인 필요'(10% 임의 적용 안 함) · 과거 CRM 원본 구분 unknown",
      n(lg.data.price) === 8800000 && deriveVatMode(lg.data.items) === "unknown" && lg.data.legacyOrigin?.taxBreakdown === "unknown", { price: lg.data?.price, origin: lg.data?.legacyOrigin });
    // 편집 화면 '확인 필요' 그대로 저장 = 품목 저장 유형(taxable) 유지 + 근거 미확인 품목 taxRate 0 (QuoteEditorWorkspace.toApiItem 규칙)
    const keep = await call("PUT", `/admin/quotes/${lq.id}`, { title: `${tag}_ESCAP형`, quoteType: "b2b_standard", issueDate: "2026-10-15",
      items: [{ productName: "통역", unit: "건", quantity: 1, unitPrice: 8800000, taxRate: 0, taxType: "taxable", itemType: "interpretation" }] });
    const lg2 = await call("GET", `/admin/quotes/${lq.id}`);
    check("확인 필요 상태 저장 → 총액 8,800,000 · 부가세 0 유지(880,000 추가 없음) · 문서유형 기존값 유지",
      keep.ok && n(lg2.data.price) === 8800000 && lg2.data.items.every((x: any) => n(x.taxAmount) === 0) && await docOf(Number(lq.id)) === "tax_invoice", keep);
    const add10 = await call("PUT", `/admin/quotes/${lq.id}`, { title: `${tag}_ESCAP형`, quoteType: "b2b_standard", issueDate: "2026-10-15", taxDocumentType: "tax_invoice", versionReason: "테스트",
      items: [{ productName: "통역", unit: "건", quantity: 1, unitPrice: 8800000, taxRate: 0.1, taxType: "taxable", itemType: "interpretation" }] });
    const lg3 = await call("GET", `/admin/quotes/${lq.id}`);
    check("일반과세로 바꿔 저장 시도 → 확인 요구(409 LEGACY_VAT_UNCONFIRMED · 차액 +880,000 표시) · DB 8,800,000 그대로",
      add10.status === 409 && add10.data.code === "LEGACY_VAT_UNCONFIRMED" && String(add10.data.error).includes("+880,000") && n(lg3.data.price) === 8800000, add10);
    const zr = await call("PUT", `/admin/quotes/${lq.id}`, { title: `${tag}_ESCAP형`, quoteType: "b2b_standard", issueDate: "2026-10-15", taxDocumentType: "zero_rate_tax_invoice",
      items: [{ productName: "통역", unit: "건", quantity: 1, unitPrice: 8800000, taxRate: 0, taxType: "zero_rate", itemType: "interpretation" }] });
    const lg4 = await call("GET", `/admin/quotes/${lq.id}`);
    check("영세율 확인 후 선택 저장 → 총액 8,800,000 그대로(확인 절차 불필요) · 영세율·zero_rate_tax_invoice",
      zr.ok && n(lg4.data.price) === 8800000 && deriveVatMode(lg4.data.items) === "zero_rate" && await docOf(Number(lq.id)) === "zero_rate_tax_invoice", zr);

    console.log("\n[G] 확인 필요 → 세금 유형 확인 절차(운영 Q000068 동일 구조 · 원본 총액 유지 · 감사로그)");
    let gSeq = 0;
    const mkLegacyLike = async (qty = 1, unitPrice = 8800000) => {
      gSeq++;
      const [p] = await rows(sql`INSERT INTO projects (user_id, title, status, company_id) VALUES (${admin.id}, ${`${tag}_G${gSeq}`}, 'approved', ${co.id}) RETURNING id`);
      const [q] = await rows(sql`INSERT INTO quotes (project_id, quote_number, price, status, title, issue_date, is_current, tax_document_type, tax_category)
        VALUES (${p.id}, ${`QG${gSeq}${Date.now() % 1e8}`}, 8800000, 'approved', ${`${tag}_G${gSeq}`}, '2026-10-15', true, 'tax_invoice', 'normal') RETURNING id`);
      quoteIds.push(Number(q.id));
      await db.execute(sql`INSERT INTO quote_items (quote_id, product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, item_type, tax_type, is_custom_product)
        VALUES (${q.id}, '영어동시통역 외9', '건', ${qty}, ${unitPrice}, 8800000, 0, 8800000, 'interpretation', 'taxable', true)`);
      return Number(q.id);
    };
    const snap = async (id: number) => JSON.stringify(await rows(sql`SELECT q.price, q.tax_document_type, qi.unit_price, qi.supply_amount, qi.tax_amount, qi.total_amount, qi.tax_type FROM quotes q JOIN quote_items qi ON qi.quote_id = q.id WHERE q.id = ${id} ORDER BY qi.id`));
    const g1 = await mkLegacyLike();
    const s0 = await snap(g1);
    await call("GET", `/admin/quotes/${g1}`); await call("GET", `/admin/quotes/${g1}`);   // 편집 진입·PDF 미리보기와 같은 조회 API
    check("조회(편집 진입·PDF 데이터) 반복 → DB 금액·유형 변경 없음", (await snap(g1)) === s0);
    const dry = await call("POST", `/admin/quotes/${g1}/confirm-tax-type`, { taxType: "taxable", dryRun: true });
    check("일반과세 미리보기 → 공급가 8,800,000→8,000,000 · 부가세 0→800,000 · 총액 8,800,000 유지 · DB 무변경",
      dry.ok && dry.data.summary.before.supply === 8800000 && dry.data.summary.after.supply === 8000000 && dry.data.summary.after.tax === 800000 && dry.data.summary.after.total === 8800000 && (await snap(g1)) === s0, dry.data);
    const noBasis = await call("POST", `/admin/quotes/${g1}/confirm-tax-type`, { taxType: "zero_rate" });
    check("근거 없이 확정 → 400 · DB 무변경", noBasis.status === 400 && (await snap(g1)) === s0, noBasis);
    const cz = await call("POST", `/admin/quotes/${g1}/confirm-tax-type`, { taxType: "zero_rate", basis: "영세율 전자세금계산서 발행분 확인(테스트)" });
    const gz1 = await call("GET", `/admin/quotes/${g1}`);
    check("영세율 확정 → 공급가 8,800,000 · 부가세 0 · 총액 8,800,000 그대로 · 유형 영세율 · 문서유형 zero_rate_tax_invoice",
      cz.ok && n(gz1.data.price) === 8800000 && n(gz1.data.items[0].supplyAmount) === 8800000 && n(gz1.data.items[0].taxAmount) === 0 && deriveVatMode(gz1.data.items) === "zero_rate" && await docOf(g1) === "zero_rate_tax_invoice", cz);
    const conf = await call("GET", `/admin/quotes/${g1}/tax-type-confirmation`);
    const [lgRow] = await rows(sql`SELECT performed_by FROM logs WHERE entity_type = 'quote' AND entity_id = ${g1} AND action = 'quote_tax_type_confirmed'`);
    check("감사로그: 확정 유형·근거·확인 담당자·확인일 기록", conf.ok && conf.data?.taxType === "zero_rate" && String(conf.data?.basis).includes("영세율") && !!conf.data?.confirmedAt && n(lgRow?.performed_by) === n(admin.id), conf.data);
    const again = await call("POST", `/admin/quotes/${g1}/confirm-tax-type`, { taxType: "taxable", basis: "재확정 시도" });
    check("이미 확정된 견적 재확정 → 409(편집 화면 절차로)", again.status === 409, again);
    const g2 = await mkLegacyLike();
    const ct = await call("POST", `/admin/quotes/${g2}/confirm-tax-type`, { taxType: "taxable", basis: "계약서 부가세 포함 조건 확인(테스트)" });
    const gt = await call("GET", `/admin/quotes/${g2}`);
    check("일반과세 확정(부가세 포함) → 총액 8,800,000 유지 · 공급가 8,000,000 · 부가세 800,000 · 단가 8,000,000",
      ct.ok && n(gt.data.price) === 8800000 && n(gt.data.items[0].supplyAmount) === 8000000 && n(gt.data.items[0].taxAmount) === 800000 && n(gt.data.items[0].unitPrice) === 8000000 && deriveVatMode(gt.data.items) === "taxable", ct.data);
    const re = await call("PUT", `/admin/quotes/${g2}`, { title: `${tag}_G2`, quoteType: "b2b_standard", issueDate: "2026-10-15", taxDocumentType: "tax_invoice",
      items: [{ productName: "영어동시통역 외9", unit: "건", quantity: 1, unitPrice: 8000000, taxRate: 0.1, taxType: "taxable", itemType: "interpretation" }] });
    check("확정 후 편집 화면 그대로 재저장 → 총액 8,800,000(화면 재계산 = 저장값)", re.ok && n((await call("GET", `/admin/quotes/${g2}`)).data.price) === 8800000, re);
    const g3 = await mkLegacyLike(2, 4400000);
    const s3 = await snap(g3);
    const c3 = await call("POST", `/admin/quotes/${g3}/confirm-tax-type`, { taxType: "taxable", basis: "x" });
    check("수량 2 품목 일반과세 확정 → 409(총액 유지 분리 불가 안내) · DB 무변경", c3.status === 409 && (await snap(g3)) === s3, c3.data);
    const c3z = await call("POST", `/admin/quotes/${g3}/confirm-tax-type`, { taxType: "exempt", basis: "면세 용역 확인(테스트)" });
    check("수량 2 품목 면세 확정 → 금액 그대로 · 면세", c3z.ok && (await snap(g3)).includes('"exempt"') && n((await call("GET", `/admin/quotes/${g3}`)).data.price) === 8800000, c3z.data);

    console.log("\n[H] 거래처 등록·기본 세금 유형 변경 → 기존 견적 무변경");
    const nc = await call("POST", "/admin/companies", { name: `${tag}_신규거래처`, companyType: "client", customerType: "PUBLIC" });
    if (nc.ok) companyIds.push(Number(nc.data.id));
    const ncTax = nc.ok ? await call("PUT", `/admin/companies/${nc.data.id}/tax-type`, { defaultTaxType: "exempt", taxTypeBasis: "면세 대상 확인(테스트)" }) : nc;
    const ncGet = nc.ok ? await call("GET", `/admin/companies/${nc.data.id}`) : nc;
    check("신규 거래처 등록 + 세금 유형 저장 → 재조회 시 유지(면세·근거·확인자)", nc.ok && ncTax.ok && ncGet.data?.defaultTaxType === "exempt" && String(ncGet.data?.taxTypeBasis).includes("면세") && n(ncGet.data?.taxTypeConfirmedBy) === n(admin.id), { nc: nc.status, ncTax: ncTax.data });
    const srch = await call("GET", `/admin/companies?search=${encodeURIComponent(`${tag}_신규`)}&page=1`);
    check("거래처 검색 영향 없음(신규 거래처 검색됨)", srch.ok && (srch.data.rows ?? []).some((r: any) => r.id === nc.data?.id), srch.status);
    const ncPatch = nc.ok ? await call("PATCH", `/admin/companies/${nc.data.id}`, { name: `${tag}_신규거래처`, notes: "수정 테스트" }) : nc;
    const ncGet2 = nc.ok ? await call("GET", `/admin/companies/${nc.data.id}`) : nc;
    check("거래처 일반 수정(메모) → 세금 유형 그대로 유지", ncPatch.ok && ncGet2.data?.defaultTaxType === "exempt" && ncGet2.data?.notes === "수정 테스트");
    const coQuotes = Object.values(created);
    const before = JSON.stringify(await Promise.all(coQuotes.map(id => snap(id))));
    await call("PUT", `/admin/companies/${co.id}/tax-type`, { defaultTaxType: "exempt", taxTypeBasis: "기본값 변경 테스트" });
    const after = JSON.stringify(await Promise.all(coQuotes.map(id => snap(id))));
    const [clog] = await rows(sql`SELECT count(*)::int n FROM logs WHERE entity_type = 'company' AND entity_id = ${co.id} AND action = 'company_tax_type_changed'`);
    check(`거래처 기본값 영세율→면세 변경 → 기존 견적 ${coQuotes.length}건 금액·유형·문서유형 무변경 · 변경 이력 감사로그(${clog.n}건)`, before === after && clog.n >= 2);

    console.log("\n[I] 판매정보 수정 후 세금 유형 유지 · 청구회차별 수금현황");
    const sz = created["accumulated_batch/zero_rate"];
    const szq = (await call("GET", `/admin/quotes/${sz}`)).data;
    const sPut = await call("PUT", `/admin/quotes/${sz}`, { title: szq.title, quoteType: "accumulated_batch", issueDate: "2026-11-13", taxDocumentType: "zero_rate_tax_invoice", taxCategory: "normal", versionReason: "수량 조정(테스트)",
      items: [{ productName: "번역", unit: "페이지", quantity: 12, unitPrice: 100000, taxRate: 0, taxType: "zero_rate", itemType: "translation" }] });
    const sAfter = (await call("GET", `/admin/quotes/${sz}`)).data;
    check("영세율 판매 수량 수정 → 1,200,000 · 부가세 0 · 영세율 유지(10% 재계산 없음)", sPut.ok && n(sAfter.price) === 1200000 && n(sAfter.items[0].taxAmount) === 0 && deriveVatMode(sAfter.items) === "zero_rate", sPut);
    const inst = await call("GET", "/admin/collections");
    const ir = (inst.data?.rows ?? []).find((r: any) => r.projectId === szq.projectId);
    check("청구회차별 수금현황: 영세율 계산서 · 청구 1,000,000(기존 청구금액 유지) · 입금예정", inst.ok && ir?.paymentMethod === "영세율 계산서" && n(ir?.amount) === 1000000 && ir?.status === "scheduled", ir);
  } finally {
    // ── 정리(개발 DB 테스트 데이터만) ──
    const pids = await projectIdsOf();
    const P = sql.join((pids.length ? pids : [0]).map(i => sql`${i}`), sql`, `);
    const Q = sql.join((quoteIds.length ? quoteIds : [0]).map(i => sql`${i}`), sql`, `);
    if (legacy.legacyId) {
      await db.execute(sql`DELETE FROM legacy_master_mappings WHERE legacy_id = ${legacy.legacyId}`);
      await db.execute(sql`DELETE FROM import_row_sources WHERE batch_id = ${legacy.batchId!}`);
      await db.execute(sql`DELETE FROM import_batches WHERE id = ${legacy.batchId!}`);
    }
    await db.execute(sql`DELETE FROM payment_transactions WHERE project_payment_id IN (SELECT id FROM project_payments WHERE project_id IN (${P}))`);
    await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${P})`);
    // 견적·프로젝트를 참조하는 부속 행(판매전환 시 생성될 수 있는 기록) — FK 메타데이터 기준으로 정리
    for (const [target, ids] of [["quotes", Q], ["projects", P]] as const) {
      const refs = await rows(sql`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = ${target}::regclass AND c.conrelid <> 'quotes'::regclass AND c.conrelid <> 'projects'::regclass`);
      for (const r of refs) await db.execute(sql`DELETE FROM ${sql.identifier(r.tbl)} WHERE ${sql.identifier(r.col)} IN (${ids})`).catch(() => {});
    }
    await db.execute(sql`DELETE FROM logs WHERE entity_type = 'quote' AND entity_id IN (${Q})`);
    await db.execute(sql`DELETE FROM quote_items WHERE quote_id IN (${Q})`);
    await db.execute(sql`DELETE FROM quotes WHERE id IN (${Q})`);
    await db.execute(sql`DELETE FROM projects WHERE id IN (${P})`);
    for (const cid of companyIds) {
      await db.execute(sql`DELETE FROM logs WHERE entity_type = 'company' AND entity_id = ${cid}`).catch(() => {});
      await db.execute(sql`DELETE FROM company_aliases WHERE company_id = ${cid}`).catch(() => {});
      await db.execute(sql`DELETE FROM company_name_history WHERE company_id = ${cid}`).catch(() => {});
      await db.execute(sql`DELETE FROM companies WHERE id = ${cid}`);
    }
    const left = await rows(sql`SELECT (SELECT count(*) FROM quotes WHERE title LIKE ${tag + "%"}) q, (SELECT count(*) FROM projects WHERE title LIKE ${tag + "%"}) p, (SELECT count(*) FROM companies WHERE name LIKE ${tag + "%"}) c`);
    console.log(`\n정리 완료 — 남은 테스트 데이터: 견적 ${left[0].q} · 프로젝트 ${left[0].p} · 거래처 ${left[0].c}`);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
