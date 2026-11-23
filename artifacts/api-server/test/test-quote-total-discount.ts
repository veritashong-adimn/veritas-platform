// 총금액 기준 할인(discountType='total_amount') — 복제/개발 DB · 로컬 API 전용. fixture 생성 후 삭제.
//  [A] 서버 계산(computeQuoteItemAmounts)  [B] 저장·재조회·수정  [C] PDF 합계  [D] 판매전환 승계  [E] 기존 공급가 기준 할인 유지
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { computeQuoteItemAmounts } from "../src/routes/admin";
import { buildQuotePdfData } from "../../web-app/src/lib/quotePdf";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const B = process.env.TEST_API ?? "http://localhost:8080/api";
const n = (v: unknown) => Number(v ?? 0);
const sums = (items: any[]) => ({
  supply: items.reduce((a, x) => a + n(x.supplyAmount), 0),
  tax: items.reduce((a, x) => a + n(x.taxAmount), 0),
  total: items.reduce((a, x) => a + n(x.totalAmount), 0),
});

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");

  console.log("\n[A] 서버 계산");
  const tr = (taxType = "taxable") => ({ itemType: "translation", quantity: 48, unitPrice: 100000, taxRate: (taxType === "taxable" ? 0.1 : 0) as 0 | 0.1, taxType });
  const dc = (v: number, taxType = "taxable", discountType = "total_amount") => ({ itemType: "discount", quantity: 1, unitPrice: 0, taxRate: (taxType === "taxable" ? 0.1 : 0) as 0 | 0.1, taxType, discountType, discountValue: v });
  const r1 = sums(computeQuoteItemAmounts([tr(), dc(280000)]));
  check("일반과세 4,800,000 + 총금액 할인 280,000 → 공급가 4,545,455 · 부가세 454,545 · 총액 5,000,000", r1.supply === 4545455 && r1.tax === 454545 && r1.total === 5000000, r1);
  for (const v of [1, 7, 11, 99999, 123457, 5279999]) {
    const r = sums(computeQuoteItemAmounts([tr(), dc(v)]));
    if (!(r.total === 5280000 - v && Number.isInteger(r.supply) && Number.isInteger(r.tax))) check(`임의 할인 ${v} 정확`, false, r);
  }
  check("임의 할인액(1·7·11·99,999·123,457·5,279,999) → 총액 = 원총액 − 할인액, 정수", true);
  const rz = sums(computeQuoteItemAmounts([tr("zero_rate"), dc(280000, "zero_rate")]));
  check("영세율 4,800,000 − 280,000 → 공급가 4,520,000 · 부가세 0", rz.supply === 4520000 && rz.tax === 0 && rz.total === 4520000, rz);
  const rx = sums(computeQuoteItemAmounts([tr("exempt"), dc(280000, "exempt")]));
  check("면세 4,800,000 − 280,000 → 공급가 4,520,000 · 부가세 0", rx.supply === 4520000 && rx.tax === 0, rx);
  const rc = sums(computeQuoteItemAmounts([tr(), dc(9999999)]));
  check("할인액 초과 → 총액 0으로 클램프", rc.total === 0 && rc.supply === 0 && rc.tax === 0, rc);
  const ra = sums(computeQuoteItemAmounts([tr(), dc(280000, "taxable", "amount")]));
  check("기존 공급가 기준(amount) 280,000 → 공급가 4,520,000 · 부가세 452,000 (기존 그대로)", ra.supply === 4520000 && ra.tax === 452000, ra);
  const rp = sums(computeQuoteItemAmounts([tr(), dc(10, "taxable", "percent")]));
  check("기존 공급가 기준(percent) 10% → 공급가 4,320,000 · 부가세 432,000 (기존 그대로)", rp.supply === 4320000 && rp.tax === 432000, rp);
  const rn = sums(computeQuoteItemAmounts([tr(), { ...dc(280000), discountType: null as any }]));
  check("discountType 없음(구 데이터) → 공급가 기준 금액 할인", rn.supply === 4520000, rn);

  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const H = { Authorization: `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "10m" })}`, "Content-Type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${B}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) as any };
  };
  const tag = `__TEST_TOTALDC_${Date.now()}`;
  const quoteIds: number[] = [], companyIds: number[] = [];
  const before = await rows(sql`SELECT (SELECT count(*) FROM quotes) q, (SELECT count(*) FROM quote_items) qi, (SELECT coalesce(sum(price),0) FROM quotes) p`);

  try {
    const [co] = await rows(sql`INSERT INTO companies (name, company_type, is_customer) VALUES (${`${tag}_co`}, 'client', true) RETURNING id`);
    companyIds.push(Number(co.id));
    const item = { productName: "번역", unit: "페이지", quantity: 48, unitPrice: 100000, taxRate: 0.1, taxType: "taxable", itemType: "translation" };
    const dcItem = (v: number, t = "total_amount") => ({ productName: "Special D.C", unit: "건", quantity: 1, unitPrice: 0, taxRate: 0.1, taxType: "taxable", itemType: "discount", discountType: t, discountValue: v, discountReason: "테스트" });

    console.log("\n[B] 저장·재조회·수정");
    const c = await call("POST", "/admin/quotes", { title: `${tag}_q`, companyId: co.id, quoteType: "b2b_standard", billingType: "postpaid_per_project", taxCategory: "normal", taxDocumentType: "tax_invoice", issueDate: "2026-11-23", items: [item, dcItem(280000)] });
    check("생성 성공", c.ok, c);
    const qid = c.data.id; quoteIds.push(qid);
    const g = await call("GET", `/admin/quotes/${qid}`);
    const s1 = sums(g.data.items);
    const dRow = g.data.items.find((x: any) => x.itemType === "discount");
    check("저장 후: price 5,000,000 · 공급가 4,545,455 · 부가세 454,545", n(g.data.price) === 5000000 && s1.supply === 4545455 && s1.tax === 454545, { price: g.data.price, s1 });
    check("할인행 저장: discountType=total_amount · 값 280,000 · 행 -254,545 / -25,455", dRow?.discountType === "total_amount" && n(dRow.discountValue) === 280000 && n(dRow.supplyAmount) === -254545 && n(dRow.taxAmount) === -25455, dRow);

    const u = await call("PUT", `/admin/quotes/${qid}`, { title: `${tag}_q`, items: [item, dcItem(380000)] });
    const g2 = await call("GET", `/admin/quotes/${qid}`);
    const s2 = sums(g2.data.items);
    check("수정(할인 380,000) → 총액 4,900,000 · 공급가 4,454,545 · 부가세 445,455", u.ok && n(g2.data.price) === 4900000 && s2.supply === 4454545 && s2.tax === 445455, { u: u.status, price: g2.data.price, s2 });
    const u2 = await call("PUT", `/admin/quotes/${qid}`, { title: `${tag}_q`, items: [item, dcItem(280000)] });
    const g3 = await call("GET", `/admin/quotes/${qid}`);
    check("재수정(280,000) → 총액 5,000,000 복귀", u2.ok && n(g3.data.price) === 5000000, g3.data?.price);

    console.log("\n[C] PDF 데이터");
    try {
      const pdf: any = buildQuotePdfData({ ...g3.data, settings: g3.data.settings ?? {} } as any);
      check("PDF 합계: 공급가 4,545,455 · 부가세 454,545 · 총액 5,000,000", pdf.supplyTotal === 4545455 && pdf.taxTotal === 454545 && pdf.grandTotal === 5000000,
        { s: pdf.supplyTotal, t: pdf.taxTotal, g: pdf.grandTotal });
    } catch (e) { check("PDF 데이터 생성", false, String(e)); }

    console.log("\n[D] 판매전환");
    const cv = await call("PATCH", `/admin/quotes/${qid}/status`, { status: "approved" });
    const ga = await call("GET", `/admin/quotes/${qid}`);
    const sa = sums(ga.data.items);
    check("판매전환 후 총액·공급가·부가세 유지", cv.ok && ga.data.status === "approved" && n(ga.data.price) === 5000000 && sa.supply === 4545455 && sa.tax === 454545, { cv: cv.status, price: ga.data?.price, sa });

    console.log("\n[E] 기존 공급가 기준 할인 견적");
    const c2 = await call("POST", "/admin/quotes", { title: `${tag}_q2`, companyId: co.id, quoteType: "b2b_standard", billingType: "postpaid_per_project", taxCategory: "normal", taxDocumentType: "tax_invoice", issueDate: "2026-11-23", items: [item, dcItem(280000, "amount")] });
    if (c2.ok) quoteIds.push(c2.data.id);
    const g4 = await call("GET", `/admin/quotes/${c2.data.id}`);
    check("공급가 기준 280,000 → 총액 4,972,000 (기존 동일)", n(g4.data.price) === 4972000 && g4.data.items.find((x: any) => x.itemType === "discount")?.discountType === "amount", g4.data?.price);
  } finally {
    const Q = sql.join((quoteIds.length ? quoteIds : [0]).map(i => sql`${i}`), sql`, `);
    const pids = (await rows(sql`SELECT DISTINCT project_id FROM quotes WHERE id IN (${Q}) AND project_id IS NOT NULL`)).map(r => Number(r.project_id));
    const P = sql.join((pids.length ? pids : [0]).map(i => sql`${i}`), sql`, `);
    // 판매전환으로 생길 수 있는 부속 행 — FK 메타데이터 기준 정리
    const fks = await rows(sql`SELECT tc.table_name t, kcu.column_name c, ccu.table_name r FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name IN ('quotes','projects','quote_items') AND tc.table_name NOT IN ('quotes','projects','quote_items')`);
    for (let pass2 = 0; pass2 < 3; pass2++) for (const f of fks) {
      const ids = f.r === "projects" ? P : f.r === "quotes" ? Q : sql`SELECT id FROM quote_items WHERE quote_id IN (${Q})`;
      try { await db.execute(sql`DELETE FROM ${sql.identifier(f.t)} WHERE ${sql.identifier(f.c)} IN (${ids})`); } catch { /* 다음 패스 */ }
    }
    await db.execute(sql`UPDATE quotes SET project_id = NULL WHERE id IN (${Q})`).catch(() => {});
    await db.execute(sql`DELETE FROM quote_items WHERE quote_id IN (${Q})`);
    await db.execute(sql`DELETE FROM quotes WHERE id IN (${Q})`);
    await db.execute(sql`DELETE FROM projects WHERE id IN (${P})`).catch(e => console.log("project cleanup:", String(e).slice(0, 120)));
    await db.execute(sql`DELETE FROM companies WHERE id IN (${sql.join(companyIds.map(i => sql`${i}`), sql`, `)})`).catch(() => {});
    const after = await rows(sql`SELECT (SELECT count(*) FROM quotes) q, (SELECT count(*) FROM quote_items) qi, (SELECT coalesce(sum(price),0) FROM quotes) p`);
    check("정리 후 기존 견적 수·품목 수·금액 합계 변동 없음", JSON.stringify(after) === JSON.stringify(before), { before, after });
  }
  console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
