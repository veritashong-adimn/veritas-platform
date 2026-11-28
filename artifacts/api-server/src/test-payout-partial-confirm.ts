// 지급대상 선택 지급확정(부분 확정) · 같은 지급일 추가 회차 · 중복 확정/송금 방지 회귀 테스트(2026-11-28) — 개발 DB 전용 · 로컬 API(TEST_API, 기본 :8090)
//   운영 11/30 구조 축소 재현: 개인 통번역사 2명 + 외주업체(장비) 1곳(세금계산서 부가세). 외주업체를 이번 확정에서 제외.
//   ① 제외 요청 검증(없는 지급대상·전원 제외) ② 남은 지급대상 신원 불일치면 409 + 제외 미적용 ③ 선택 지급대상만 확정·스냅샷·합계
//   ④ 제외 지급대상 = 회차 연결만 해제(미지급·지급예정일·금액 불변) ⑤ 송금건·IBK 파일에 제외 지급대상 없음, 파일 생성만으로 지급완료 아님
//   ⑥ 같은 지급일 추가 회차 = 제외 지급대상만 수집 → 확정·IBK 파일(그 업체만) ⑦ 두 회차 확정 스냅샷·송금건 중복 없음·합계 = 전체
//   ⑧ 더 수집할 것 없으면 추가 회차 거부 ⑨ 확정취소 시 다른 회차 건을 끌어오지 않음 ⑩ 전체 선택(제외 없음) = 기존 확정과 같음
//   fixture 는 끝나면 모두 삭제한다.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { encrypt } from "./lib/encrypt";
import { testSessionToken, cleanupTestSessions } from "./testing/sessionToken";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL || /neon\.tech/.test(process.env.DATABASE_URL)) {
  console.error("개발 DB 전용 테스트입니다(운영 DB 거부)."); process.exit(1);
}
const B = process.env.TEST_API ?? "http://localhost:8090/api";
const TAG = "[TEST-PART]";
const D1 = "2031-07-31", D2 = "2031-08-14";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const q = async (s: any) => (await db.execute(s)).rows as any[];
const one = async (s: any) => (await q(s))[0];
const ids = (a: number[]) => sql.join((a.length ? a : [-1]).map(i => sql`${i}`), sql`, `);
const RRN = { A: "8001011000001", B: "8102022000002", X: "8203031000003" };   // 합성 번호
const ACCT = { A: "11122233344", B: "22233344455", V: "33344455566", C: "44455566677" };
const BIZ = "1234567890";

async function cleanup() {
  const pids = (await q(sql`SELECT id FROM projects WHERE title LIKE ${TAG + "%"}`)).map(r => Number(r.id));
  const rids = (await q(sql`SELECT id FROM payout_rounds WHERE payment_date IN (${D1}, ${D2}) AND (note LIKE ${TAG + "%"} OR batch_number LIKE ${D1 + "%"} OR batch_number LIKE ${D2 + "%"})`)).map(r => Number(r.id));
  const uids = (await q(sql`SELECT id FROM users WHERE name LIKE ${TAG + "%"}`)).map(r => Number(r.id));
  const cids = (await q(sql`SELECT id FROM companies WHERE name LIKE ${TAG + "%"}`)).map(r => Number(r.id));
  await db.execute(sql`DELETE FROM payout_transfers WHERE payout_round_id IN (${ids(rids)})`);
  await db.execute(sql`DELETE FROM payout_round_items WHERE payout_round_id IN (${ids(rids)})`);
  await db.execute(sql`DELETE FROM logs WHERE entity_type = 'project' AND entity_id IN (${ids(pids)})`);
  await db.execute(sql`DELETE FROM performance_assignments WHERE project_id IN (${ids(pids)})`);
  await db.execute(sql`DELETE FROM payout_rounds WHERE id IN (${ids(rids)})`);
  await db.execute(sql`DELETE FROM projects WHERE id IN (${ids(pids)})`);
  await db.execute(sql`DELETE FROM translator_sensitive WHERE translator_id IN (${ids(uids)})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${ids(uids)})`);
  await db.execute(sql`DELETE FROM company_sensitive WHERE company_id IN (${ids(cids)})`);
  await db.execute(sql`DELETE FROM companies WHERE id IN (${ids(cids)})`);
  await cleanupTestSessions(db);
}

async function main() {
  await cleanup();
  const admin = await one(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const token = await testSessionToken(db, Number(admin.id));
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    const ct = r.headers.get("content-type") ?? "";
    if (ct.includes("spreadsheet") || ct.includes("octet-stream")) return { status: r.status, data: null as any, buf: Buffer.from(await r.arrayBuffer()) };
    return { status: r.status, data: await r.json().catch(() => null) as any, buf: null as Buffer | null }; };
  const fileAccounts = (buf: Buffer | null) => { if (!buf) return []; const wb = XLSX.read(buf); const ws = wb.Sheets[wb.SheetNames[0]];
    return (XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][]).map(r => String(r?.[1] ?? "").replace(/\D/g, "")).filter(x => x.length >= 10); };

  // ── fixture ──
  const mkT = async (name: string, rrn: string, acct: string) => { const u = await one(sql`INSERT INTO users (email, name, role, is_active) VALUES (${`part-${Math.random().toString(36).slice(2, 10)}@test.local`}, ${name}, 'translator', true) RETURNING id`);
    await db.execute(sql`INSERT INTO translator_sensitive (translator_id, resident_number, payment_method, bank_name, bank_account_enc, account_holder) VALUES (${u.id}, ${encrypt(rrn)}, 'domestic_withholding', '기업은행', ${encrypt(acct)}, ${name})`); return Number(u.id); };
  const A = await mkT(`${TAG}갑통역사`, RRN.A, ACCT.A), Bt = await mkT(`${TAG}을통역사`, RRN.B, ACCT.B);
  const vendor = await one(sql`INSERT INTO companies (name, is_vendor, company_type, business_number) VALUES (${TAG + "장비업체"}, true, 'vendor', ${BIZ}) RETURNING id`);
  await db.execute(sql`INSERT INTO company_sensitive (company_id, bank_name, bank_account_enc, account_holder) VALUES (${vendor.id}, '기업은행', ${encrypt(ACCT.V)}, ${TAG + "장비업체"})`);
  const co = await one(sql`INSERT INTO companies (name) VALUES (${TAG + "거래처"}) RETURNING id`);
  const pj = await one(sql`INSERT INTO projects (user_id, title, company_id, company_name_snapshot) VALUES (${admin.id}, ${TAG + "판매"}, ${co.id}, ${TAG + "거래처"}) RETURNING id`);
  const mkPa = async (seq: number, d: string, cat: "individual" | "vendor", uid: number | null, vid: number | null, name: string, ienc: string | null, imask: string | null, cost: number) => Number((await one(sql`INSERT INTO performance_assignments
      (project_id, sequence, performer_category, cost_type, payee_type, individual_user_id, vendor_company_id, performer_name_snapshot, identifier_snapshot_enc, identifier_snapshot_masked,
       status, service_type, product_name_snapshot, delivery_date, delivery_confirmed, expected_payment_date, withholding_treatment, residency_type, purchase_evidence_type,
       is_direct_amount, direct_amount, base_performance_fee, cost_total, payment_status, line_category)
    VALUES (${pj.id}, ${seq}, ${cat}, ${cat}, ${cat}, ${uid}, ${vid}, ${name}, ${ienc}, ${imask}, 'completed', 'interpretation', '통역', ${d.slice(0, 8) + "10"}, true, ${d},
      ${cat === "individual" ? "domestic_3_3" : null}, ${cat === "individual" ? "domestic_resident" : null}, ${cat === "vendor" ? "tax_invoice" : null},
      true, ${cost}, ${cost}, ${cost}, 'unpaid', ${cat === "individual" ? "통번역사" : "장비업체"}) RETURNING id`)).id);
  const iMask = (r: string) => r.slice(0, 6) + "-*******";
  const a1 = await mkPa(1, D1, "individual", A, null, `${TAG}갑통역사`, encrypt(RRN.A), iMask(RRN.A), 680000);
  const a2 = await mkPa(2, D1, "individual", A, null, `${TAG}갑통역사`, encrypt(RRN.A), iMask(RRN.A), 85000);
  const b1 = await mkPa(3, D1, "individual", Bt, null, `${TAG}을통역사`, encrypt(RRN.B), iMask(RRN.B), 680000);
  const v1 = await mkPa(4, D1, "vendor", null, Number(vendor.id), `${TAG}장비업체`, null, BIZ, 500000);
  const v2 = await mkPa(5, D1, "vendor", null, Number(vendor.id), `${TAG}장비업체`, null, BIZ, 20000);
  const v3 = await mkPa(6, D1, "vendor", null, Number(vendor.id), `${TAG}장비업체`, null, BIZ, 0);   // 무상(0원) — 수집 대상 아님
  const VK = `v:${vendor.id}`, AK = `i:${A}`, BK = `i:${Bt}`;

  console.log("\n[0] 회차 생성(지급일 " + D1 + ")");
  const c0 = await call("POST", "/admin/payout-rounds", { paymentDate: D1, periodStart: D1, periodEnd: D1, note: TAG + "회차" });
  const R1 = Number(c0.data?.round?.id);
  const full = c0.data;
  check("회차 생성 · 지급대상 3(개인 2·외주 1) · 5건 수집(0원 제외)", c0.status === 201 && full.summary.length === 3 && full.summary.reduce((s: number, g: any) => s + g.count, 0) === 5, { s: c0.status, g: full?.summary?.length });
  const net = (g: any) => Number(g.netTotal);
  const fullNet = full.summary.reduce((s: number, g: any) => s + net(g), 0);
  const vNet = net(full.summary.find((g: any) => g.payeeKey === VK));
  check("외주업체 실지급 = 공급가 + 부가세(세금계산서) = 572,000", Math.round(vNet) === 572000, vNet);

  console.log("\n[1] 제외 요청 검증");
  const u1 = await call("PATCH", `/admin/payout-rounds/${R1}/confirm`, { excludePayeeKeys: ["v:999999999"] });
  check("회차에 없는 지급대상 제외 → 400 UNKNOWN_PAYEE", u1.status === 400 && u1.data?.code === "UNKNOWN_PAYEE", u1.data);
  const u2 = await call("PATCH", `/admin/payout-rounds/${R1}/confirm`, { excludePayeeKeys: [AK, BK, VK] });
  check("전원 제외 → 400 NO_PAYEE_SELECTED", u2.status === 400 && u2.data?.code === "NO_PAYEE_SELECTED", u2.data);
  const u3 = await call("PATCH", `/admin/payout-rounds/${R1}/confirm`, { excludePayeeKeys: ["x:1"] });
  check("형식 오류 → 400", u3.status === 400, u3.data);
  check("검증 실패 후 회차 draft · 5건 그대로", (await one(sql`SELECT status FROM payout_rounds WHERE id = ${R1}`)).status === "draft"
    && Number((await one(sql`SELECT count(*)::int n FROM performance_assignments WHERE payout_round_id = ${R1}`)).n) === 5);

  console.log("\n[2] 남은 지급대상 신원 불일치 → 409, 제외 미적용");
  await db.execute(sql`UPDATE performance_assignments SET identifier_snapshot_enc = ${encrypt(RRN.X)} WHERE id = ${a2}`);   // 갑 건 1개 신원 불일치 재현
  const m1 = await call("PATCH", `/admin/payout-rounds/${R1}/confirm`, { excludePayeeKeys: [VK] });
  check("선택 지급대상 신원 불일치 → 409 PAYEE_IDENTITY_MISMATCH", m1.status === 409 && m1.data?.code === "PAYEE_IDENTITY_MISMATCH", m1.data?.code);
  check("차단 시 제외 미적용(외주업체 건 회차 연결 유지)", Number((await one(sql`SELECT count(*)::int n FROM performance_assignments WHERE id IN (${v1}, ${v2}) AND payout_round_id = ${R1}`)).n) === 2);
  await db.execute(sql`UPDATE performance_assignments SET identifier_snapshot_enc = ${encrypt(RRN.A)} WHERE id = ${a2}`);

  console.log("\n[3] 외주업체 제외하고 선택 지급대상만 지급확정");
  const vBefore = await q(sql`SELECT id, payment_status, to_char(expected_payment_date,'YYYY-MM-DD') ed, cost_total, payout_round_id FROM performance_assignments WHERE id IN (${v1}, ${v2}) ORDER BY id`);
  const cf = await call("PATCH", `/admin/payout-rounds/${R1}/confirm`, { excludePayeeKeys: [VK] });
  check("지급확정 200 · 회차 confirmed", cf.status === 200 && cf.data?.round?.status === "confirmed", { s: cf.status, e: cf.data?.error });
  check("응답 excludedPayees = 외주업체 1곳", cf.data?.excludedPayees?.length === 1 && cf.data.excludedPayees[0].payeeKey === VK, cf.data?.excludedPayees);
  const snap1 = await q(sql`SELECT performance_assignment_id aid, payee_type, payee_id FROM payout_round_items WHERE payout_round_id = ${R1} AND adjustment_id IS NULL`);
  check("확정 스냅샷 = 개인 3건만(외주업체 없음)", snap1.length === 3 && snap1.every(r => r.payee_type === "individual") && [a1, a2, b1].every(id => snap1.some(r => Number(r.aid) === id)), snap1);
  const r1 = await one(sql`SELECT total_payees, total_assignments, net_amount FROM payout_rounds WHERE id = ${R1}`);
  check(`회차 합계 = 전체 − 외주업체(2명 · 3건 · ${Math.round(fullNet - vNet).toLocaleString()}원)`, Number(r1.total_payees) === 2 && Number(r1.total_assignments) === 3 && Math.round(Number(r1.net_amount)) === Math.round(fullNet - vNet), r1);
  const vAfter = await q(sql`SELECT id, payment_status, to_char(expected_payment_date,'YYYY-MM-DD') ed, cost_total, payout_round_id FROM performance_assignments WHERE id IN (${v1}, ${v2}) ORDER BY id`);
  check("제외 지급대상: 회차 연결만 해제 · 미지급·지급예정일·금액 불변", vAfter.every((r, i) => r.payout_round_id == null && r.payment_status === "unpaid" && r.ed === vBefore[i].ed && Number(r.cost_total) === Number(vBefore[i].cost_total)), vAfter);
  const again = await call("PATCH", `/admin/payout-rounds/${R1}/confirm`, {});
  check("중복 지급확정 → 400(이미 확정)", again.status === 400, again.data);

  console.log("\n[4] 송금건·IBK 파일 — 제외 지급대상 없음 · 파일 생성만으로 지급완료 아님");
  const g1 = await call("POST", `/admin/payout-rounds/${R1}/transfers/generate`);
  const t1 = await q(sql`SELECT payee_key, status, amount FROM payout_transfers WHERE payout_round_id = ${R1} ORDER BY payee_key`);
  check("송금건 = 개인 2명(외주업체 없음) · 전원 계좌 검증 ready", g1.status === 200 && t1.length === 2 && !t1.some(t => t.payee_key === VK) && t1.every(t => t.status === "ready"), t1);
  const f1 = await call("POST", `/admin/payout-rounds/${R1}/transfers/ibk-file`);
  const acc1 = fileAccounts(f1.buf);
  check("IBK 파일 = 개인 2명 계좌만(외주업체 계좌 없음)", f1.status === 200 && acc1.length === 2 && acc1.includes(ACCT.A) && acc1.includes(ACCT.B) && !acc1.includes(ACCT.V), { s: f1.status, acc1, e: f1.data?.error });
  const st1 = await one(sql`SELECT status FROM payout_rounds WHERE id = ${R1}`);
  const paidN = await one(sql`SELECT count(*)::int n FROM performance_assignments WHERE id IN (${a1}, ${a2}, ${b1}) AND payment_status = 'paid'`);
  check("파일 생성 후에도 회차 confirmed · 수행건 미지급(지급완료 아님)", st1.status === "confirmed" && Number(paidN.n) === 0, { st: st1.status, paid: paidN.n });

  console.log("\n[5] 같은 지급일 추가 회차 — 제외 지급대상만 수집 → 확정 → IBK 파일");
  const c2 = await call("POST", "/admin/payout-rounds", { paymentDate: D1, periodStart: D1, periodEnd: D1, note: TAG + "추가 회차" });
  const R2 = Number(c2.data?.round?.id);
  check("추가 회차 생성 201 · 다른 회차 · 외주업체 2건만 수집", c2.status === 201 && R2 !== R1 && c2.data.summary.length === 1 && c2.data.summary[0].payeeKey === VK && c2.data.summary[0].count === 2, { s: c2.status, r: R2, g: c2.data?.summary?.map((g: any) => g.payeeKey) });
  const c2b = await call("POST", "/admin/payout-rounds", { paymentDate: D1, periodStart: D1, periodEnd: D1 });
  check("작성중 추가 회차가 있으면 다시 만들지 않음(duplicate)", c2b.status === 200 && c2b.data?.duplicate === true && Number(c2b.data?.round?.id) === R2, { s: c2b.status, d: c2b.data?.duplicate });
  const cf2 = await call("PATCH", `/admin/payout-rounds/${R2}/confirm`, {});
  check("추가 회차 지급확정 200", cf2.status === 200 && cf2.data?.round?.status === "confirmed", cf2.data?.error);
  await call("POST", `/admin/payout-rounds/${R2}/transfers/generate`);
  const t2 = await q(sql`SELECT payee_key, amount FROM payout_transfers WHERE payout_round_id = ${R2}`);
  const f2 = await call("POST", `/admin/payout-rounds/${R2}/transfers/ibk-file`);
  const acc2 = fileAccounts(f2.buf);
  check("추가 회차 송금건·IBK 파일 = 외주업체만(572,000원)", t2.length === 1 && t2[0].payee_key === VK && Math.round(Number(t2[0].amount)) === 572000 && acc2.length === 1 && acc2[0] === ACCT.V, { t2, acc2 });

  console.log("\n[6] 중복 방지 — 두 회차 확정 스냅샷·송금건 겹침 없음 · 합계 = 전체");
  const s1 = await q(sql`SELECT performance_assignment_id aid FROM payout_round_items WHERE payout_round_id = ${R1} AND adjustment_id IS NULL`);
  const s2 = await q(sql`SELECT performance_assignment_id aid FROM payout_round_items WHERE payout_round_id = ${R2} AND adjustment_id IS NULL`);
  const both = s1.map(r => Number(r.aid)).filter(id => s2.some(x => Number(x.aid) === id));
  check("같은 수행건이 두 회차에 확정되지 않음", both.length === 0 && s1.length + s2.length === 5, { both, n1: s1.length, n2: s2.length });
  const keys1 = t1.map(t => t.payee_key), keys2 = t2.map(t => t.payee_key);
  check("같은 지급대상이 두 회차 송금건에 중복되지 않음", !keys1.some(k => keys2.includes(k)), { keys1, keys2 });
  const n12 = await q(sql`SELECT coalesce(sum(net_amount),0) s FROM payout_rounds WHERE id IN (${R1}, ${R2})`);
  check(`두 회차 실지급 합계 = 전체 ${Math.round(fullNet).toLocaleString()}원`, Math.round(Number(n12[0].s)) === Math.round(fullNet), n12[0]);

  console.log("\n[7] 더 수집할 미배정 건이 없으면 추가 회차 거부");
  const c3 = await call("POST", "/admin/payout-rounds", { paymentDate: D1, periodStart: D1, periodEnd: D1 });
  check("400 NOTHING_TO_COLLECT", c3.status === 400 && c3.data?.code === "NOTHING_TO_COLLECT", { s: c3.status, d: c3.data });

  console.log("\n[8] 확정취소(기존 안전장치) — 다른 회차 건을 끌어오지 않음");
  const un = await call("PATCH", `/admin/payout-rounds/${R1}/unconfirm`, { reason: "테스트 확정취소" });
  const inR1 = await q(sql`SELECT id FROM performance_assignments WHERE payout_round_id = ${R1}`);
  const inR2 = await q(sql`SELECT id FROM performance_assignments WHERE payout_round_id = ${R2}`);
  check("확정취소 → R1 draft · 개인 3건만(외주업체 건은 R2 유지)", un.status === 200 && inR1.length === 3 && inR2.length === 2 && !inR1.some(r => [v1, v2].includes(Number(r.id))), { s: un.status, e: un.data?.error, r1: inR1.length, r2: inR2.length });

  console.log("\n[9] 전체 선택(제외 없음) = 기존 지급확정과 같음");
  const c4 = await call("POST", "/admin/payout-rounds", { paymentDate: D2, periodStart: D2, periodEnd: D2, note: TAG + "전체 선택" });
  const R4 = Number(c4.data?.round?.id);
  const w1 = await mkPa(7, D2, "individual", A, null, `${TAG}갑통역사`, encrypt(RRN.A), iMask(RRN.A), 100000);
  const w2 = await mkPa(8, D2, "vendor", null, Number(vendor.id), `${TAG}장비업체`, null, BIZ, 100000);
  await db.execute(sql`UPDATE performance_assignments SET payout_round_id = ${R4} WHERE id IN (${w1}, ${w2})`);
  const d4 = (await call("GET", `/admin/payout-rounds/${R4}`)).data;
  const cf4a = await call("PATCH", `/admin/payout-rounds/${R4}/confirm`);           // 본문 없음(기존 호출 방식)
  const s4 = await q(sql`SELECT count(*)::int n FROM payout_round_items WHERE payout_round_id = ${R4}`);
  const r4 = await one(sql`SELECT total_payees, total_assignments, net_amount FROM payout_rounds WHERE id = ${R4}`);
  check("본문 없는 기존 확정 요청 → 전체 확정(2명 · 2건 · 합계 동일)", cf4a.status === 200 && Number(s4[0].n) === 2 && Number(r4.total_payees) === 2
    && Math.round(Number(r4.net_amount)) === Math.round(d4.summary.reduce((s: number, g: any) => s + Number(g.netTotal), 0)), { s: cf4a.status, n: s4[0].n, r4 });
  void v3;
}

main().catch(e => { fail++; console.error(e); }).finally(async () => {
  try { await cleanup(); const left = await one(sql`SELECT (SELECT count(*) FROM users WHERE name LIKE ${TAG + "%"})::int u, (SELECT count(*) FROM projects WHERE title LIKE ${TAG + "%"})::int p, (SELECT count(*) FROM payout_rounds WHERE payment_date IN (${D1}, ${D2}))::int r`);
    console.log(`\n정리 완료 — 남은 테스트 데이터: 통번역사 ${left.u} · 판매 ${left.p} · 회차 ${left.r}`); } catch (e) { console.error("정리 실패", e); fail++; }
  console.log(`결과: ${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0);
});
