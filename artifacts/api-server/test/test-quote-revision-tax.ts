// 변경견적·판매전환 회귀 + 세금 유형 승계 — 복제 DB(veritas_inq_scratch) + 테스트 서버(:8098) 전용. fixture 는 끝나면 삭제.
//  ① 영세율 원견적 판매전환 · 중복 전환 차단  ② 변경견적 작성(영세율 승계) → 거절 → 원견적 유효·판매 유지
//  ③ 변경견적 작성 → 삭제 → 원견적 유효   ④ 변경견적(면세로 변경) 승인 → 판매 금액·유형 = 변경견적, 원견적 대체(수정 불가)
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { deriveVatMode } from "../../web-app/src/lib/quoteTaxType";

if (!/\/veritas_inq_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("복제 DB(veritas_inq_scratch) 전용 테스트입니다."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8098/api";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const num = (v: unknown) => Number(v ?? 0);

async function main() {
  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const H = { Authorization: `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "10m" })}`, "Content-Type": "application/json" };
  const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) as any }; };
  const get = async (id: number) => (await call("GET", `/admin/quotes/${id}`)).data;
  const tag = `__TEST_REVTAX_${Date.now()}`;
  const [co] = await rows(sql`INSERT INTO companies (name, company_type, is_customer) VALUES (${tag}, 'client', true) RETURNING id`);
  const ids: number[] = [];
  const item = (t: string, qty = 10) => ({ productName: "영한 번역", unit: "페이지", quantity: qty, unitPrice: 100000, taxRate: t === "taxable" ? 0.1 : 0, taxType: t, itemType: "translation" });
  try {
    const mk = async (t: string) => { const r = await call("POST", "/admin/quotes", { title: `${tag}_${t}`, companyId: co.id, quoteType: "b2b_standard", billingType: "postpaid_per_project", issueDate: "2026-11-13", taxDocumentType: t === "taxable" ? "tax_invoice" : t === "zero_rate" ? "zero_rate_tax_invoice" : "invoice", items: [item(t)] }); ids.push(r.data.id); return r.data.id as number; };

    console.log("\n① 영세율 원견적 판매전환");
    const q0 = await mk("zero_rate");
    const cv = await call("PATCH", `/admin/quotes/${q0}/status`, { status: "approved" });
    const dup = await call("PATCH", `/admin/quotes/${q0}/status`, { status: "approved" });
    const g0 = await get(q0);
    check("판매전환 → 1,000,000 · 부가세 0 · 영세율", cv.ok && g0.status === "approved" && num(g0.price) === 1000000 && deriveVatMode(g0.items) === "zero_rate", cv);
    check("중복 판매전환 차단", !dup.ok, dup.status);

    console.log("\n② 변경견적 작성 → 거절");
    const r1 = await call("POST", `/admin/quotes/${q0}/create-revision`, { versionReason: "테스트 변경" }); ids.push(r1.data?.id);
    const g1 = await get(r1.data.id);
    check("변경견적 작성 → 영세율·금액 승계", r1.ok && deriveVatMode(g1.items) === "zero_rate" && num(g1.price) === 1000000, r1);
    const rj = await call("POST", `/admin/quotes/${r1.data.id}/reject-revision`);
    const g0b = await get(q0);
    check("변경견적 거절 → 원견적 판매 유지(approved·영세율·1,000,000)", rj.ok && g0b.status === "approved" && num(g0b.price) === 1000000 && deriveVatMode(g0b.items) === "zero_rate", rj);

    console.log("\n③ 변경견적 작성 → 삭제");
    const r2 = await call("POST", `/admin/quotes/${q0}/create-revision`, { versionReason: "테스트 변경2" }); ids.push(r2.data?.id);
    const del = await call("DELETE", `/admin/quotes/${r2.data.id}`, { reason: "테스트 정리" });
    const g0c = await get(q0);
    const [curC] = await rows(sql`SELECT is_current FROM quotes WHERE id = ${q0}`);
    check("변경견적 삭제 → 원견적 유효(approved·is_current)", r2.ok && del.ok && g0c.status === "approved" && curC.is_current === true, { r2: r2.status, del: del.data });

    console.log("\n④ 변경견적(면세·수량 12) 승인");
    const r3 = await call("POST", `/admin/quotes/${q0}/create-revision`, { versionReason: "면세 변경" }); ids.push(r3.data?.id);
    const put = await call("PUT", `/admin/quotes/${r3.data.id}`, { title: `${tag}_rev`, quoteType: "b2b_standard", issueDate: "2026-11-13", taxDocumentType: "invoice", versionReason: "면세 변경", items: [item("exempt", 12)] });
    const ap = await call("POST", `/admin/quotes/${r3.data.id}/approve-revision`);
    const g3 = await get(r3.data.id), g0d = await get(q0);
    check("승인 → 변경견적 판매(1,200,000 · 부가세 0 · 면세)", put.ok && ap.ok && g3.status === "approved" && num(g3.price) === 1200000 && deriveVatMode(g3.items) === "exempt", { put: put.status, ap: ap.data });
    const [cur0] = await rows(sql`SELECT is_current FROM quotes WHERE id = ${q0}`);
    check("원견적 대체(과거본) → 금액·영세율 그대로 보존", cur0.is_current === false && num(g0d.price) === 1000000 && deriveVatMode(g0d.items) === "zero_rate", { cur: cur0.is_current });
    const old = await call("PUT", `/admin/quotes/${q0}`, { title: "x", items: [item("taxable")] });
    check("대체된 원견적 수정 차단(409)", old.status === 409, old.status);
    const conf = await call("POST", `/admin/quotes/${q0}/confirm-tax-type`, { taxType: "taxable", dryRun: true });
    check("대체된 원견적 세금 유형 확인 절차도 차단(409)", conf.status === 409, conf.status);
  } finally {
    const all = (await rows(sql`SELECT id, project_id FROM quotes WHERE title LIKE ${tag + "%"} OR id IN (${sql.join(ids.filter(Boolean).map(i => sql`${i}`).concat([sql`0`]), sql`, `)})`));
    const Q = sql.join(all.map(r => sql`${r.id}`).concat([sql`0`]), sql`, `);
    const P = sql.join([...new Set(all.map(r => r.project_id).filter(Boolean))].map(i => sql`${i}`).concat([sql`0`]), sql`, `);
    for (const [target, ids2] of [["quotes", Q], ["projects", P]] as const) {
      const refs = await rows(sql`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = ${target}::regclass AND c.conrelid <> 'quotes'::regclass AND c.conrelid <> 'projects'::regclass`);
      for (const r of refs) await db.execute(sql`DELETE FROM ${sql.identifier(r.tbl)} WHERE ${sql.identifier(r.col)} IN (${ids2})`).catch(() => {});
    }
    await db.execute(sql`DELETE FROM logs WHERE (entity_type = 'quote' AND entity_id IN (${Q})) OR (entity_type = 'project' AND entity_id IN (${P}))`);
    await db.execute(sql`UPDATE quotes SET root_quote_id = NULL, parent_version_id = NULL WHERE id IN (${Q})`);
    await db.execute(sql`DELETE FROM quote_items WHERE quote_id IN (${Q})`);
    await db.execute(sql`DELETE FROM quotes WHERE id IN (${Q})`);
    await db.execute(sql`DELETE FROM projects WHERE id IN (${P})`);
    await db.execute(sql`DELETE FROM companies WHERE id = ${co.id}`).catch(e => console.log("company cleanup:", e.message));
    const [left] = await rows(sql`SELECT (SELECT count(*) FROM quotes WHERE title LIKE ${tag + "%"}) q`);
    console.log(`\n정리 완료 — 남은 테스트 견적 ${left.q}`);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
