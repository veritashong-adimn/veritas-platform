// 판매관리 목록(/admin/sales-history) ↔ 판매 상세 D.청구정보 연동 검증 — 개발 DB · 로컬 API :8080 전용. fixture 를 만들고 끝나면 삭제한다.
//  계산서발행일 · 입금일(실제 입금만, 입금예정일 제외) · 입금내역(은행 금액, 복수 입금 누락 없음) · 입금상태(완료/부분)
//  현재 판매 + 과거 CRM 전환 판매(플랫폼 청구 없으면 원본 값 유지) · 영세율/면세/세금계산서 · 저장 직후 = 재조회 · 원본 데이터 불변
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import jwt from "jsonwebtoken";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const B = process.env.TEST_API ?? "http://localhost:8080/api";

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const H = { Authorization: `Bearer ${jwt.sign({ id: admin.id, email: admin.email, role: "admin" }, process.env.JWT_SECRET!, { expiresIn: "10m" })}`, "Content-Type": "application/json" };
  const tag = `ZZSLB${Date.now()}`;
  const pids: number[] = [], legacyIds: number[] = [], saleNos: string[] = [];

  const mk = async (name: string, price: number) => {
    const [p] = await rows(sql`INSERT INTO projects (user_id, title, status, financial_status) VALUES (${admin.id}, ${`${tag}_${name}`}, 'approved', 'billed') RETURNING id`);
    pids.push(Number(p.id));
    await db.execute(sql`INSERT INTO quotes (project_id, price, status, title, issue_date, is_current) VALUES (${p.id}, ${price}, 'approved', ${name}, '2026-10-01', true)`);
    return Number(p.id);
  };
  const pay = async (pid: number, seq: number, o: { method: string; issue?: string | null; expected?: string | null; amount: number; vat?: number; paid?: string | null; status?: string; confirmed?: boolean }) => {
    const [r] = await rows(sql`INSERT INTO project_payments (project_id, sequence, issue_date, expected_date, payment_type, payment_method, supply_amount, vat_amount, amount, paid_date, deposit_status, deposit_confirmed, payment_category, payer, deposit_item)
      VALUES (${pid}, ${seq}, ${o.issue ?? null}, ${o.expected ?? null}, 'lump_sum', ${o.method}, ${String(o.amount - (o.vat ?? 0))}, ${String(o.vat ?? 0)}, ${String(o.amount)}, ${o.paid ?? null},
        ${o.status ?? "scheduled"}, ${o.confirmed ?? false}, '일반결제', '고객사', '전체금액') RETURNING id`);
    return Number(r.id);
  };
  const txn = (pid: number, ppId: number, date: string, bank: string, amount: number) => db.execute(sql`INSERT INTO payment_transactions (project_payment_id, project_id, paid_date, method, customer_paid_amount, settled_amount, fee_amount, currency, krw_amount, bank_account)
    VALUES (${ppId}, ${pid}, ${date}, '국내이체', ${String(amount)}, ${String(amount)}, '0', 'KRW', ${String(amount)}, ${bank})`);
  const list = async () => {
    const res = await fetch(`${B}/admin/sales-history?range=all&search=${tag}&pageSize=200`, { headers: H });
    const d: any = await res.json();
    return new Map<number, any>((d.rows ?? []).filter((r: any) => r.source === "current").map((r: any) => [Number(r.id), r]));
  };
  const snapshot = async () => JSON.stringify({
    pp: await rows(sql`SELECT * FROM project_payments WHERE project_id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)}) ORDER BY id`),
    tx: await rows(sql`SELECT * FROM payment_transactions WHERE project_id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)}) ORDER BY id`),
    q: await rows(sql`SELECT price FROM quotes WHERE project_id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)}) ORDER BY id`),
    la: legacyIds.length ? await rows(sql`SELECT source_raw FROM legacy_archive_rows WHERE id IN (${sql.join(legacyIds.map(i => sql`${i}`), sql`, `)}) ORDER BY id`) : [],
  });

  try {
    // ① 가우디움형 — 세금계산서 발행 2026-10-23, 입금확인(입금거래 없이 입금완료 확정) 2026-11-12, 371,250 전액
    const g = await mk("가우디움형", 371250);
    await pay(g, 1, { method: "세금계산서", issue: "2026-10-23", expected: "2026-11-10", amount: 371250, vat: 33750, paid: "2026-11-12", status: "completed", confirmed: true });
    // ② 킨텍스형(과거 CRM 전환) — 면세 계산서 42,000,000 · 부가세 0 · 발행 2026-11-09 · 입금거래 2026-11-12 기업은행. 원본 값은 다른 값(플랫폼 우선 확인용)
    const k = await mk("킨텍스형", 42000000);
    const kp = await pay(k, 1, { method: "면세 계산서", issue: "2026-11-09", amount: 42000000, vat: 0, paid: "2026-11-12", status: "completed", confirmed: true });
    await txn(k, kp, "2026-11-12", "기업은행", 42000000);
    const kNo = `${tag}-K`; saleNos.push(kNo);
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, status) VALUES ('old_crm', 'sale', ${kNo}, ${k}, 'active')`);
    const [kl] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, source_raw, row_hash, is_effective) VALUES ('sales_list', ${JSON.stringify({ 판매번호: kNo, "세금계산서발행(예정)일": "2026-11-01", 입금일: "", 입금내역: "" })}::jsonb, ${tag + "k"}, true) RETURNING id`);
    legacyIds.push(Number(kl.id));
    // ③ 입금 전 — 영세율 계산서 발행만, 입금예정일 있음(입금일로 오인 금지)
    const u = await mk("입금전", 500000);
    await pay(u, 1, { method: "영세율 계산서", issue: "2026-11-05", expected: "2026-11-30", amount: 500000 });
    // ④ 부분입금 — 300,000 중 100,000 입금거래
    const pt = await mk("부분입금", 300000);
    const ptp = await pay(pt, 1, { method: "세금계산서", issue: "2026-11-01", expected: "2026-11-15", amount: 300000, vat: 27273, status: "partial" });
    await txn(pt, ptp, "2026-11-10", "국민은행", 100000);
    // ⑤ 여러 회차 + 분할입금 — 선금(발행 10-01, 입금 10-05 국민) · 잔금(발행 11-01, 입금 11-03 기업 + 11-08 기업)
    const mlt = await mk("복수회차", 1000000);
    const m1 = await pay(mlt, 1, { method: "세금계산서", issue: "2026-10-01", amount: 400000, vat: 36364 });
    const m2 = await pay(mlt, 2, { method: "세금계산서", issue: "2026-11-01", amount: 600000, vat: 54545 });
    await txn(mlt, m1, "2026-10-05", "국민은행", 400000);
    await txn(mlt, m2, "2026-11-03", "기업은행", 250000);
    await txn(mlt, m2, "2026-11-08", "기업은행", 350000);
    // ⑥ 과거 CRM 전환 판매 · 플랫폼 청구정보 없음 → 원본 값 그대로
    const o = await mk("원본유지", 770000);
    const oNo = `${tag}-O`; saleNos.push(oNo);
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, status) VALUES ('old_crm', 'sale', ${oNo}, ${o}, 'active')`);
    const [ol] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, source_raw, row_hash, is_effective) VALUES ('sales_list', ${JSON.stringify({ 판매번호: oNo, "세금계산서발행(예정)일": "2026-09-30", 입금일: "2026-09-30", 입금내역: "9/29- 346,500(선금), 9/30-423,500(잔금)" })}::jsonb, ${tag + "o"}, true) RETURNING id`);
    legacyIds.push(Number(ol.id));
    // ⑦ 청구정보 없는 일반 판매 → 모두 '-'
    const n = await mk("청구없음", 100000);

    const before = await snapshot();
    const L = await list();
    const r = (id: number) => L.get(id) ?? {};
    check("목록에 fixture 7건 조회", [g, k, u, pt, mlt, o, n].every(id => L.has(id)), [...L.keys()]);
    check("① 가우디움형: 발행 2026-10-23 · 입금 2026-11-12 · 371,250 · 완료", r(g).taxInvoiceDate === "2026-10-23" && r(g).paymentDate === "2026-11-12" && r(g).paymentMemo === "371,250" && r(g).paymentStatus === "completed", r(g));
    check("② 킨텍스형(전환·면세): 플랫폼 발행 2026-11-09 우선(원본 11-01 아님) · 입금 2026-11-12 · 기업은행 42,000,000 · 완료",
      r(k).origin === "legacy_crm" && r(k).taxInvoiceDate === "2026-11-09" && r(k).paymentDate === "2026-11-12" && r(k).paymentMemo === "기업은행 42,000,000" && r(k).paymentStatus === "completed", r(k));
    check("③ 입금 전(영세율): 발행 2026-11-05 · 입금예정일을 입금일로 쓰지 않음 · 입금내역/상태 없음", r(u).taxInvoiceDate === "2026-11-05" && r(u).paymentDate == null && r(u).paymentMemo == null && r(u).paymentStatus == null, r(u));
    check("④ 부분입금: 입금 2026-11-10 · 국민은행 100,000 · 부분", r(pt).paymentDate === "2026-11-10" && r(pt).paymentMemo === "국민은행 100,000" && r(pt).paymentStatus === "partial", r(pt));
    check("⑤ 복수 회차: 발행일 두 회차 모두 · 마지막 입금일 11-08 · 입금 3건 누락 없음 · 완료",
      r(mlt).taxInvoiceDate === "2026-10-01, 2026-11-01" && r(mlt).paymentDate === "2026-11-08"
      && r(mlt).paymentMemo === "10/5 국민은행 400,000, 11/3 기업은행 250,000, 11/8 기업은행 350,000" && r(mlt).paymentStatus === "completed", r(mlt));
    check("⑥ 전환 판매 · 플랫폼 청구 없음 → 원본 발행일·입금일·입금내역 유지", r(o).taxInvoiceDate === "2026-09-30" && r(o).paymentDate === "2026-09-30" && r(o).paymentMemo === "9/29- 346,500(선금), 9/30-423,500(잔금)" && r(o).paymentStatus == null, r(o));
    check("⑦ 청구정보 없는 일반 판매 → 발행일·입금 모두 없음(임의 생성 없음)", r(n).taxInvoiceDate == null && r(n).paymentDate == null && r(n).paymentMemo == null, r(n));

    // 저장 직후 반영 — 판매 상세 저장 API 로 입금 전 판매(③)에 입금 반영 → 목록 재조회 결과 = 저장값, 다시 조회해도 같음
    const det: any = await (await fetch(`${B}/admin/projects/${u}`, { headers: H })).json();
    const rec = det.paymentRecords[0];
    const put = await fetch(`${B}/admin/projects/${u}/payment-records`, { method: "PUT", headers: H, body: JSON.stringify({ deletedIds: [], rows: [{
      id: rec.id, issueDate: String(rec.issueDate).slice(0, 10), expectedDate: String(rec.expectedDate).slice(0, 10), paidDate: "2026-11-20", paymentType: rec.paymentType, paymentMethod: rec.paymentMethod,
      supplyAmount: Number(rec.supplyAmount), vatAmount: Number(rec.vatAmount), amount: Number(rec.amount), depositStatus: "completed", depositConfirmed: true,
      paymentCategory: rec.paymentCategory, payer: rec.payer, depositItem: rec.depositItem, billingCompanyId: null, billingContactId: null, note: null }] }) });
    const L2 = await list(), L3 = await list();
    check("저장 직후 목록: 영세율 판매 입금 2026-11-20 · 500,000 · 완료 · 발행일 유지", put.ok && L2.get(u)?.paymentDate === "2026-11-20" && L2.get(u)?.paymentMemo === "500,000" && L2.get(u)?.paymentStatus === "completed" && L2.get(u)?.taxInvoiceDate === "2026-11-05", { status: put.status, row: L2.get(u) });
    check("재조회(새로고침)해도 같은 결과", JSON.stringify([...L2.entries()]) === JSON.stringify([...L3.entries()]));
    check("판매금액 표시 불변(목록 금액 = 견적 금액)", L3.get(mlt)?.amount === 1000000 && L3.get(k)?.amount === 42000000);
    // 데이터 불변 — 목록 조회는 READ-ONLY(③ 저장분 외 청구·입금·견적·원본 그대로)
    const after = JSON.parse(await snapshot()), b0 = JSON.parse(before);
    const strip = (x: any[]) => x.filter((p: any) => Number(p.project_id) !== u);
    check("목록 조회 전후 청구·입금거래·견적·과거 CRM 원본 불변", JSON.stringify(strip(after.pp)) === JSON.stringify(strip(b0.pp)) && JSON.stringify(after.tx) === JSON.stringify(b0.tx)
      && JSON.stringify(after.q) === JSON.stringify(b0.q) && JSON.stringify(after.la) === JSON.stringify(b0.la));
    // 과거 CRM(미전환) 탭 행은 기존 원본 값 그대로(회귀)
    const lg: any = await (await fetch(`${B}/admin/sales-history?range=legacy&pageSize=5`, { headers: H })).json();
    check("과거 CRM 탭 조회 정상 · legacy 행은 paymentStatus 없음(기존 원본 표시)", Array.isArray(lg.rows) && lg.sources?.legacy?.ok && lg.rows.every((x: any) => x.source === "legacy" && x.paymentStatus == null));
  } finally {
    if (pids.length) {
      const pl = sql.join(pids.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM logs WHERE entity_type = 'project' AND entity_id IN (${pl})`);
      await db.execute(sql`DELETE FROM payment_transactions WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${pl})`);
      await db.execute(sql`DELETE FROM legacy_master_mappings WHERE source_system = 'old_crm' AND entity_type = 'sale' AND entity_id IN (${pl})`);
      await db.execute(sql`DELETE FROM projects WHERE id IN (${pl})`);
    }
    if (legacyIds.length) await db.execute(sql`DELETE FROM legacy_archive_rows WHERE id IN (${sql.join(legacyIds.map(i => sql`${i}`), sql`, `)})`);
    const [left] = await rows(sql`SELECT (SELECT count(*) FROM projects WHERE title LIKE ${tag + "%"}) + (SELECT count(*) FROM legacy_archive_rows WHERE row_hash LIKE ${tag + "%"}) n`);
    check("fixture 정리 완료", Number(left.n) === 0, left);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
