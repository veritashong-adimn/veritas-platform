// 위치: api-server/test — web-app 공용 함수(lib/paymentSplit)를 함께 검증하므로 api-server src(tsc rootDir) 밖에 둔다. esbuild 번들로 실행.
// 청구정보 수정 화면 — 기존 저장값 보존 검증(개발 DB · 로컬 API :8080 전용). fixture 를 만들고 끝나면 삭제한다.
//  [A] 금액 분해·검증 규칙(web-app lib/paymentSplit) — 부가세 0원 판매 / 국내 10% 판매 / 1원 반올림 차이
//  [B] API 왕복 — 판매 상세 조회의 청구정보(발행일·금액) → 수정 화면과 같은 값으로 저장(입금일만 변경) → 발행일·공급가·부가세·청구금액 유지
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { saleSplitOf, amountsFromSupply, amountsFromTotal, splitMatched } from "../../web-app/src/lib/paymentSplit";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await rows(q))[0];
const B = process.env.TEST_API ?? "http://localhost:8080/api";

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const H = { Authorization: `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "10m" })}`, "Content-Type": "application/json" };
  const tag = `__TEST_PEP_${Date.now()}`;
  const pids: number[] = [];

  console.log("\n[A] 금액 분해·검증 규칙");
  const k = saleSplitOf(42000000, 42000000, 0);
  check("킨텍스(영세율): 판매 기준 = 공급가 42,000,000 · 부가세 0 (10% 재계산 없음)", k.stored && k.supply === 42000000 && k.vat === 0 && k.zeroVat, k);
  check("청구 42,000,000/0/42,000,000 → 합계 일치(불일치 경고 없음)", splitMatched({ supply: 42000000, vat: 0, total: 42000000 }, 42000000, k));
  check("(기존 오류 재현) 총액÷1.1 기준이면 부가세 3,818,182 로 불일치", saleSplitOf(42000000).vat === 3818182 && !splitMatched({ supply: 42000000, vat: 0, total: 42000000 }, 42000000, saleSplitOf(42000000)));
  check("부가세 0원 판매: 공급가 입력 → 부가세 0 · 합계 = 공급가", JSON.stringify(amountsFromSupply("42000000", true)) === JSON.stringify({ supplyAmount: "42000000", vatAmount: "0", amount: "42000000" }));
  check("부가세 0원 판매: 합계 입력 → 공급가 = 합계 · 부가세 0", JSON.stringify(amountsFromTotal("42000000", true)) === JSON.stringify({ amount: "42000000", supplyAmount: "42000000", vatAmount: "0" }));
  const d = saleSplitOf(1100000, 1000000, 100000);
  check("국내 10%: 기준 1,000,000/100,000 · 공급가 입력 시 부가세 10% 계산 유지", d.supply === 1000000 && d.vat === 100000 && !d.zeroVat
    && amountsFromSupply("1000000", d.zeroVat).vatAmount === "100000" && amountsFromTotal("1100000", d.zeroVat).supplyAmount === "1000000");
  check("국내 10% 청구 일치", splitMatched({ supply: 1000000, vat: 100000, total: 1100000 }, 1100000, d));
  const r = saleSplitOf(1149500, 1045001, 104499);   // 품목별 반올림으로 저장 부가세가 ÷1.1 분해와 1원 다른 판매
  check("1원 반올림 차이 판매: 기존 ÷1.1 기준으로 저장된 청구도 정상(회귀 없음)", splitMatched({ supply: 1045000, vat: 104500, total: 1149500 }, 1149500, r) && splitMatched({ supply: 1045001, vat: 104499, total: 1149500 }, 1149500, r));
  check("저장값 없음(견적 품목 없음) → 기존 ÷1.1 분해 그대로", (() => { const x = saleSplitOf(1100000, null, null); return !x.stored && x.supply === 1000000 && x.vat === 100000; })());
  check("합계 다르면 불일치", !splitMatched({ supply: 42000000, vat: 0, total: 41000000 }, 42000000, k));

  const mk = async (title: string, supply: number, vat: number, issue: string) => {
    const [p] = await rows(sql`INSERT INTO projects (user_id, title, status, financial_status) VALUES (${admin.id}, ${title}, 'approved', 'billed') RETURNING id`);
    pids.push(Number(p.id));
    const [q] = await rows(sql`INSERT INTO quotes (project_id, price, status, title, issue_date, is_current) VALUES (${p.id}, ${supply + vat}, 'approved', ${title}, '2026-06-22', true) RETURNING id`);
    await db.execute(sql`INSERT INTO quote_items (quote_id, product_name, unit, quantity, unit_price, supply_amount, tax_amount, total_amount, item_type, tax_type, is_custom_product)
      VALUES (${q.id}, ${title}, '건', '1', ${String(supply)}, ${String(supply)}, ${String(vat)}, ${String(supply + vat)}, 'interpretation', 'taxable', true)`);
    await db.execute(sql`INSERT INTO project_payments (project_id, sequence, issue_date, payment_type, payment_method, supply_amount, vat_amount, amount, deposit_status, deposit_confirmed, payment_category, payer, deposit_item)
      VALUES (${p.id}, 1, ${issue}, 'lump_sum', '세금계산서', ${String(supply)}, ${String(vat)}, ${String(supply + vat)}, 'scheduled', false, '일반결제', '고객사', '전체금액')`);
    return Number(p.id);
  };

  try {
    console.log("\n[B] API 왕복 — 조회 → 수정 화면 값 그대로 저장(입금일만 변경)");
    for (const c of [{ name: "킨텍스형 영세율", supply: 42000000, vat: 0, issue: "2026-11-09", paid: "2026-11-20" }, { name: "국내 10%", supply: 1000000, vat: 100000, issue: "2026-10-01", paid: "2026-10-15" }]) {
      const pid = await mk(`${tag}_${c.name}`, c.supply, c.vat, c.issue);
      const res = await fetch(`${B}/admin/projects/${pid}`, { headers: H });
      const detail: any = await res.json();
      const rec = detail.paymentRecords?.[0];
      check(`${c.name}: 판매 상세 청구정보 발행일 ${c.issue} 조회`, res.ok && String(rec?.issueDate ?? "").slice(0, 10) === c.issue, { status: res.status, rec });
      // 수정 화면 진입 값(mapRow) — 발행일·공급가·부가세·청구금액 저장값 그대로
      const quote = detail.quotes?.find((q: any) => q.isCurrent) ?? detail.quotes?.[0] ?? null;   // SalesDetailPage 와 같은 선택
      const items: any[] = quote?.items ?? [];
      const split = saleSplitOf(Number(quote?.price ?? 0), items.length ? items.reduce((s, it) => s + Number(it.supplyAmount ?? 0), 0) : null, items.length ? items.reduce((s, it) => s + Number(it.taxAmount ?? 0), 0) : null);
      check(`${c.name}: 판매 기준 공급가·부가세 = 저장값(${c.supply.toLocaleString()}/${c.vat.toLocaleString()})`, split.supply === c.supply && split.vat === c.vat, { split, items: items.length });
      check(`${c.name}: 수정 화면 합계 일치(경고 없음)`, splitMatched({ supply: Number(rec.supplyAmount), vat: Number(rec.vatAmount), total: Number(rec.amount) }, c.supply + c.vat, split));
      const row = { id: rec.id, issueDate: String(rec.issueDate).slice(0, 10), expectedDate: rec.expectedDate ?? null, paidDate: c.paid,
        paymentType: rec.paymentType, paymentMethod: rec.paymentMethod, supplyAmount: Number(rec.supplyAmount), vatAmount: Number(rec.vatAmount), amount: Number(rec.amount),
        depositStatus: "completed", depositConfirmed: true, paymentCategory: rec.paymentCategory, payer: rec.payer, depositItem: rec.depositItem,
        billingCompanyId: rec.billingCompanyId ?? null, billingContactId: rec.billingContactId ?? null, note: rec.note ?? null };
      const put = await fetch(`${B}/admin/projects/${pid}/payment-records`, { method: "PUT", headers: H, body: JSON.stringify({ rows: [row], deletedIds: [] }) });
      const after = await one(sql`SELECT issue_date, supply_amount, vat_amount, amount, paid_date, deposit_status FROM project_payments WHERE project_id = ${pid}`);
      check(`${c.name}: 입금일만 수정 저장 → 발행일·공급가·부가세·청구금액 유지, 입금 반영`, put.ok && String(after.issue_date).slice(0, 10) === c.issue && Number(after.supply_amount) === c.supply
        && Number(after.vat_amount) === c.vat && Number(after.amount) === c.supply + c.vat && String(after.paid_date).slice(0, 10) === c.paid && after.deposit_status === "completed", { status: put.status, after });
    }
  } finally {
    if (pids.length) {
      const pl = sql.join(pids.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM logs WHERE entity_type = 'project' AND entity_id IN (${pl})`);
      await db.execute(sql`DELETE FROM payment_transactions WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE project_id IN (${pl}))`);
      await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM projects WHERE id IN (${pl})`);
    }
    const left = await one(sql`SELECT count(*) n FROM projects WHERE title LIKE ${tag + "%"}`);
    check("fixture 정리 완료", Number(left.n) === 0, left);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
