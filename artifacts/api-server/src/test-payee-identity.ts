// 수행자 ↔ 지급대상 신원 불일치 재현·차단 회귀 테스트(2026-11-28) — 개발 DB 전용 · 로컬 API(TEST_API, 기본 :8090)
//   운영 오연결 사례(수행정보 #123)와 같은 구조를 재현: 수행정보 이름·주민번호 스냅샷 = B, 내부 지급대상 연결 = A(앱 밖 일괄 재연결로 연결만 바뀐 상태).
//   ① 신원 점검 mismatch ② 지급준비점검 identity_mismatch(주민번호 원문 없음) ③ 지급확정 409 차단
//   ④ 이름만 다른 건(주민번호 대조 불가)은 참고만·차단 안 함 ⑤ 앱 저장 로직(수행정보 1행 저장 + 변경 사유)으로 정상화 → 스냅샷·감사로그
//   ⑥ 정상화 후 지급확정 성공 ⑦ 확정 스냅샷 지급대상이 바뀐 경우 IBK 파일 생성 409 차단 ⑧ CRM 전환 동명이인 보호(이름만으로 연결 안 함)
//   fixture 는 끝나면 모두 삭제한다.
import { db, performanceAssignmentsTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { encrypt } from "./lib/encrypt";
import { checkPayeeIdentity } from "./services/payeeIdentity";
import { computePayoutReadiness } from "./services/payoutReadiness";
import { loadTranslatorIndex } from "./services/legacySaleActivation";
import { rowSchema } from "./routes/performances";
import { testSessionToken, cleanupTestSessions } from "./testing/sessionToken";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL || /neon\.tech/.test(process.env.DATABASE_URL)) {
  console.error("개발 DB 전용 테스트입니다(운영 DB 거부)."); process.exit(1);
}
const B = process.env.TEST_API ?? "http://localhost:8090/api";
const TAG = "[TEST-ID]";
const PAYDATE = "2031-05-30";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const q = async (s: any) => (await db.execute(s)).rows as any[];
const one = async (s: any) => (await q(s))[0];
// 합성 주민번호(실존 번호 아님)
const RRN_A = "8001011000001", RRN_B = "8102022000002", RRN_D1 = "8203031000003", RRN_D2 = "8304042000004";
const hasRrn = (o: unknown) => /\d{6}-?\d{7}/.test(JSON.stringify(o)) || [RRN_A, RRN_B, RRN_D1, RRN_D2].some(r => JSON.stringify(o).includes(r.slice(0, 6)));

async function cleanup() {
  const pids = (await q(sql`SELECT id FROM projects WHERE title LIKE ${TAG + "%"}`)).map(r => Number(r.id));
  const rids = (await q(sql`SELECT id FROM payout_rounds WHERE note LIKE ${TAG + "%"}`)).map(r => Number(r.id));
  const uids = (await q(sql`SELECT id FROM users WHERE name LIKE ${TAG + "%"}`)).map(r => Number(r.id));
  const list = (a: number[]) => sql.join((a.length ? a : [-1]).map(i => sql`${i}`), sql`, `);
  await db.execute(sql`DELETE FROM payout_transfers WHERE payout_round_id IN (${list(rids)})`);
  await db.execute(sql`DELETE FROM payout_round_items WHERE payout_round_id IN (${list(rids)})`);
  await db.execute(sql`DELETE FROM logs WHERE entity_type = 'project' AND entity_id IN (${list(pids)})`);
  await db.execute(sql`DELETE FROM performance_assignments WHERE project_id IN (${list(pids)})`);
  await db.execute(sql`DELETE FROM payout_rounds WHERE id IN (${list(rids)})`);
  await db.execute(sql`DELETE FROM projects WHERE id IN (${list(pids)})`);
  await db.execute(sql`DELETE FROM legacy_master_mappings WHERE legacy_id LIKE ${TAG + "%"}`);
  await db.execute(sql`DELETE FROM translator_sensitive WHERE translator_id IN (${list(uids)})`);
  await db.execute(sql`DELETE FROM user_sessions WHERE user_id IN (${list(uids)})`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${list(uids)})`);
  await db.execute(sql`DELETE FROM companies WHERE name LIKE ${TAG + "%"}`);
  await cleanupTestSessions(db);
}

async function mkTranslator(name: string, rrn: string | null) {
  const u = await one(sql`INSERT INTO users (email, name, role, is_active) VALUES (${`tid-${Math.random().toString(36).slice(2, 10)}@test.local`}, ${name}, 'translator', true) RETURNING id`);
  await db.execute(sql`INSERT INTO translator_sensitive (translator_id, resident_number, payment_method) VALUES (${u.id}, ${rrn ? encrypt(rrn) : null}, 'domestic_withholding')`);
  return Number(u.id);
}

async function main() {
  await cleanup();
  const admin = await one(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
  const token = await testSessionToken(db, Number(admin.id));
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
    const ct = r.headers.get("content-type") ?? ""; return { status: r.status, data: ct.includes("json") ? await r.json().catch(() => null) as any : null }; };

  // ── fixture: 통번역사 A(잘못 연결된 지급대상)·B(실제 수행자)·C(명부 주민번호 없음) · 거래처 · 판매 · 지급회차(draft) ──
  const A = await mkTranslator(`${TAG}갑통역사`, RRN_A), Bk = await mkTranslator(`${TAG}을통역사`, RRN_B), C = await mkTranslator(`${TAG}Lee Mina`, null);
  const co = await one(sql`INSERT INTO companies (name) VALUES (${TAG + "테스트거래처"}) RETURNING id`);
  const pj = await one(sql`INSERT INTO projects (user_id, title, company_id, company_name_snapshot) VALUES (${admin.id}, ${TAG + "통역"}, ${co.id}, ${TAG + "테스트거래처"}) RETURNING id`);
  const rd = await one(sql`INSERT INTO payout_rounds (batch_number, payment_date, period_start, period_end, status, note) VALUES (${PAYDATE + " 지급회차"}, ${PAYDATE}, ${PAYDATE}, ${PAYDATE}, 'draft', ${TAG + "회차"}) RETURNING id`);
  const mkPa = async (seq: number, uid: number, snap: string, rrn: string | null, cost: number) => Number((await one(sql`INSERT INTO performance_assignments
      (project_id, sequence, performer_category, cost_type, payee_type, individual_user_id, performer_name_snapshot, identifier_snapshot_enc, identifier_snapshot_masked,
       status, service_type, product_name_snapshot, delivery_date, delivery_confirmed, expected_payment_date, withholding_treatment, residency_type,
       is_direct_amount, direct_amount, base_performance_fee, cost_total, payment_status, payout_round_id, line_category)
    VALUES (${pj.id}, ${seq}, 'individual', 'individual', 'individual', ${uid}, ${snap}, ${rrn ? encrypt(rrn) : null}, ${rrn ? rrn.slice(0, 6) + "-*******" : null},
       'completed', 'interpretation', '영어동시통역 외5', '2031-05-10', true, ${PAYDATE}, 'domestic_3_3', 'domestic_resident',
       true, ${cost / 0.85}, ${cost}, ${cost}, 'unpaid', ${rd.id}, '통번역사') RETURNING id`)).id);
  // #123 재현: 이름·주민번호 스냅샷 = B(을통역사), 연결 = A(갑통역사)
  const bad = await mkPa(4, A, `${TAG}을통역사`, RRN_B, 85000);
  // 정상: A 본인
  const okA = await mkPa(1, A, `${TAG}갑통역사`, RRN_A, 85000);
  // 이름만 다름(명부 주민번호 없음·스냅샷 주민번호 없음): 스냅샷 '이미나' ↔ 명부 'Lee Mina' — 차단 대상 아님
  const nameOnly = await mkPa(6, C, `${TAG}이미나`, null, 100000);

  console.log("\n[1] 신원 점검(services/payeeIdentity)");
  const ver = await checkPayeeIdentity(db, [bad, okA, nameOnly].map(id => ({ assignmentId: id, payeeType: "individual", payeeId: id === nameOnly ? C : A })));
  check("#123 재현 건 = mismatch(주민번호 기준)", ver.get(bad)?.status === "mismatch" && ver.get(bad)?.basis === "resident_number", ver.get(bad));
  check("불일치 사유에 실제 수행자 명부(B) 표시", (ver.get(bad)?.identityOwner ?? []).some(o => o.id === Bk), ver.get(bad));
  check("정상 건 = match", ver.get(okA)?.status === "match", ver.get(okA));
  check("이름만 다른 건 = name_diff(오류 아님)", ver.get(nameOnly)?.status === "name_diff", ver.get(nameOnly));
  check("점검 결과에 주민번호 원문 없음", !hasRrn([...ver.values()]));

  console.log("\n[2] 지급준비점검");
  const rd1 = await computePayoutReadiness(db, { scope: "date", date: PAYDATE });
  const it = (id: number) => (rd1.items as any[]).find(x => x.assignmentId === id);
  check("재현 건 identity_mismatch(C) 표시", it(bad)?.blockers?.some((b: any) => b.code === "identity_mismatch" && b.cat === "C"), it(bad)?.blockers);
  check("사유 문구에 수행자·연결 지급대상 포함", /을통역사/.test(it(bad)?.blockers?.find((b: any) => b.code === "identity_mismatch")?.text ?? "") && /갑통역사/.test(it(bad)?.blockers?.find((b: any) => b.code === "identity_mismatch")?.text ?? ""));
  check("거래처·금액 표시", it(bad)?.client === `${TAG}테스트거래처` && it(bad)?.pretax === 85000, { client: it(bad)?.client, pretax: it(bad)?.pretax });
  check("정상 건 identity 경고 없음", !it(okA)?.blockers?.some((b: any) => b.code.startsWith("identity_")), it(okA)?.blockers);
  check("이름만 다른 건 참고(I)만", it(nameOnly)?.blockers?.some((b: any) => b.code === "identity_name_diff" && b.cat === "I") && !it(nameOnly)?.blockers?.some((b: any) => b.code === "identity_mismatch"));
  check("지급준비점검 응답에 주민번호 원문 없음(신원 필드)", !hasRrn((rd1.items as any[]).filter(x => [bad, okA, nameOnly].includes(x.assignmentId)).map(x => ({ b: x.blockers, i: x.identity }))));

  console.log("\n[3] 지급확정 서버 차단");
  const c1 = await call("PATCH", `/admin/payout-rounds/${rd.id}/confirm`);
  check("지급확정 409 PAYEE_IDENTITY_MISMATCH", c1.status === 409 && c1.data?.code === "PAYEE_IDENTITY_MISMATCH", c1);
  const m0 = c1.data?.mismatches?.[0];
  check("차단 목록 = 거래처·수행자·지급대상·금액·사유", c1.data?.mismatches?.length === 1 && m0?.assignmentId === bad && m0?.client === `${TAG}테스트거래처` && /을통역사/.test(m0?.performerName) && /갑통역사/.test(m0?.payeeName) && Math.round(m0?.net) === 82195 && !!m0?.reason, c1.data?.mismatches);
  check("차단 응답에 주민번호 원문 없음", !hasRrn(c1.data));
  check("회차 상태 draft 유지", (await one(sql`SELECT status FROM payout_rounds WHERE id = ${rd.id}`)).status === "draft");

  console.log("\n[4] 앱 저장 로직으로 정상화(판매관리 수행정보 1행 저장 = 화면 저장과 같은 요청)");
  const [row] = await db.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, bad));
  const keys = Object.keys((rowSchema as any).shape);
  const payloadRow: any = Object.fromEntries(keys.filter(k => (row as any)[k] !== undefined).map(k => [k, (row as any)[k]]));
  payloadRow.individualUserId = Bk;   // 화면: 수행자 검색에서 실제 수행자(을통역사) 다시 선택
  const parsed = rowSchema.safeParse(payloadRow);
  check("저장 요청 형식 유효", parsed.success, parsed.success ? "" : parsed.error.flatten());
  const s1 = await call("PUT", `/admin/projects/${pj.id}/performances`, { rows: [payloadRow], deletedIds: [] });
  check("지급회차 배정 건 → 변경 사유 요구(CHANGE_REASON_REQUIRED)", s1.data?.code === "CHANGE_REASON_REQUIRED", s1);
  const s2 = await call("PUT", `/admin/projects/${pj.id}/performances`, { rows: [payloadRow], deletedIds: [], changeReason: "수행자-지급대상 오연결 정정(실제 수행자 을통역사)" });
  check("변경 사유와 함께 저장 성공", s2.status === 200, s2);
  const after = await one(sql`SELECT individual_user_id, performer_name_snapshot, identifier_snapshot_enc, identifier_snapshot_masked, cost_total, payout_round_id, payment_status FROM performance_assignments WHERE id = ${bad}`);
  let decOk = false; try { const { decrypt } = await import("./lib/encrypt"); decOk = decrypt(after.identifier_snapshot_enc).replace(/\D/g, "") === RRN_B; } catch { /* */ }
  check("지급대상 = 실제 수행자(B)", Number(after.individual_user_id) === Bk, after.individual_user_id);
  check("이름·주민번호 스냅샷 = B 유지", after.performer_name_snapshot === `${TAG}을통역사` && decOk && after.identifier_snapshot_masked === RRN_B.slice(0, 6) + "-*******");
  check("금액·회차·지급상태 불변", Number(after.cost_total) === 85000 && Number(after.payout_round_id) === rd.id && after.payment_status === "unpaid", after);
  const lg = await one(sql`SELECT performed_by_email, metadata FROM logs WHERE entity_type = 'project' AND entity_id = ${pj.id} AND action = 'performances_saved' ORDER BY id DESC LIMIT 1`);
  check("감사로그(계정·변경 전후 지급대상) 기록", !!lg?.performed_by_email && /"individualUserId":\s*\d+/.test(lg?.metadata ?? "") && (lg?.metadata ?? "").includes(String(A)) && (lg?.metadata ?? "").includes(String(Bk)), lg);
  const ver2 = await checkPayeeIdentity(db, [{ assignmentId: bad, payeeType: "individual", payeeId: Bk }]);
  check("정상화 후 신원 = match", ver2.get(bad)?.status === "match", ver2.get(bad));

  console.log("\n[5] 정상화 후 지급확정(이름만 다른 건은 차단하지 않음)");
  const c2 = await call("PATCH", `/admin/payout-rounds/${rd.id}/confirm`);
  check("지급확정 성공", c2.status === 200 && c2.data?.round?.status === "confirmed", { status: c2.status, err: c2.data?.error });
  const snapRows = await q(sql`SELECT performance_assignment_id aid, payee_id FROM payout_round_items WHERE payout_round_id = ${rd.id} AND adjustment_id IS NULL ORDER BY performance_assignment_id`);
  check("확정 스냅샷 지급대상: 정정 건 = B", snapRows.some(r => Number(r.aid) === bad && Number(r.payee_id) === Bk), snapRows);

  console.log("\n[6] 확정 후 지급대상이 앱 밖에서 바뀐 경우 — IBK 파일 생성 차단");
  await db.execute(sql`UPDATE payout_round_items SET payee_id = ${A} WHERE payout_round_id = ${rd.id} AND performance_assignment_id = ${bad}`);   // 테스트 재현(일괄 수정 모사)
  const f1 = await call("POST", `/admin/payout-rounds/${rd.id}/transfers/ibk-file`);
  check("IBK 파일 409 PAYEE_IDENTITY_MISMATCH", f1.status === 409 && f1.data?.code === "PAYEE_IDENTITY_MISMATCH", { status: f1.status, data: f1.data });
  await db.execute(sql`UPDATE payout_round_items SET payee_id = ${Bk} WHERE payout_round_id = ${rd.id} AND performance_assignment_id = ${bad}`);
  const f2 = await call("POST", `/admin/payout-rounds/${rd.id}/transfers/ibk-file`);
  check("신원 정상이면 신원 차단 없음(이후 기존 송금건·계좌 점검으로 진행)", f2.data?.code !== "PAYEE_IDENTITY_MISMATCH", { status: f2.status, code: f2.data?.code, err: f2.data?.error });

  console.log("\n[7] CRM 전환 동명이인 보호(loadTranslatorIndex)");
  const D1 = await mkTranslator(`${TAG}동명통역사`, RRN_D1), D2 = await mkTranslator(`${TAG}동명통역사`, RRN_D2), E = await mkTranslator(`${TAG}유일한`, null);
  await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, status) VALUES
    ('old_crm', 'translator', ${TAG + "동명통역사"}, ${D1}, 'confirmed'), ('old_crm', 'translator', ${TAG + "유일한"}, ${E}, 'confirmed')`);
  const match = await loadTranslatorIndex(db);
  const r1 = match(`${TAG}동명통역사`, null), r2 = match(`${TAG}동명통역사`, RRN_D2), r3 = match(`${TAG}동명통역사`, RRN_D1), r4 = match(`${TAG}유일한`, null);
  check("동명이인 + 주민번호 없음 → 연결 안 함", r1.id == null && r1.method === "homonym_unverified", r1);
  check("동명이인 + CRM 주민번호 일치 → 그 사람(이름 매핑과 달라도)", r2.id === D2 && r2.method === "homonym_rrn", r2);
  check("동명이인 + 매핑 대상과 주민번호 일치 → 매핑 대상", r3.id === D1 && r3.method === "homonym_rrn", r3);
  check("동명이인 없는 이름 → 기존 이름 매핑 그대로", r4.id === E && r4.method === "mapping", r4);
}

main().catch(e => { fail++; console.error(e); }).finally(async () => {
  try { await cleanup(); const left = await one(sql`SELECT (SELECT count(*) FROM users WHERE name LIKE ${TAG + "%"})::int u, (SELECT count(*) FROM projects WHERE title LIKE ${TAG + "%"})::int p, (SELECT count(*) FROM payout_rounds WHERE note LIKE ${TAG + "%"})::int r`);
    console.log(`\n정리 완료 — 남은 테스트 데이터: 통번역사 ${left.u} · 판매 ${left.p} · 회차 ${left.r}`); } catch (e) { console.error("정리 실패", e); fail++; }
  console.log(`결과: ${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0);
});
