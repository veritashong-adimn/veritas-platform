// @ts-nocheck — 격리 테스트(복제 DB veritas_rev_scratch + 테스트 서버 :8098). 변경견적 R 번호·현재유효·생성기준·판매 중복 방지.
//   운영 DB 에서는 실행되지 않는다(DATABASE_URL 이 복제 DB 가 아니면 즉시 종료).
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_rev_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("복제 DB(veritas_rev_scratch) 전용 테스트입니다."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8098/api";
const T = jwt.sign({ id: 10, email: "admin@test", role: "admin" }, process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev", { expiresIn: "30m" });
const call = async (m: string, p: string, b?: any) => { const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const one = async (q: any) => ((await db.execute(q)).rows as any[])[0];
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d: any = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const today = (await one(sql`SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text d`)).d;
const q = (id: number) => one(sql`SELECT id, quote_number, status, is_current, project_id, parent_version_id, version, issue_date::text issue_date FROM quotes WHERE id = ${id}`);
const famSales = (rootId: number) => one(sql`SELECT count(DISTINCT p.id)::int n FROM projects p JOIN quotes q ON q.project_id = p.id WHERE COALESCE(q.root_quote_id, q.id) = ${rootId} AND p.status = 'approved'`);
const currents = (rootId: number) => one(sql`SELECT count(*)::int n FROM quotes WHERE COALESCE(root_quote_id, id) = ${rootId} AND is_current AND deleted_at IS NULL AND (relation_type IS NULL OR relation_type = 'revision')`);

const co = await one(sql`SELECT c.id cid, ct.id ctid FROM companies c JOIN contacts ct ON ct.company_id = c.id ORDER BY c.id LIMIT 1`);
const created = await call("POST", "/admin/quotes", {
  title: "변경견적검증_원견적", companyId: co.cid, contactId: co.ctid, quoteType: "b2b_standard", issueDate: "2026-11-16",
  items: [{ productName: "번역", unit: "건", quantity: 1, unitPrice: 1000000, itemType: "translation" }],
});
const rootId = created.body?.id; const base = created.body?.quoteNumber;
check("준비: 원견적 생성", created.status === 201 && rootId, created);

console.log("\n[1] 원견적 판매전환 → R1 생성");
const conv = await call("PATCH", `/admin/quotes/${rootId}/status`, { status: "approved" });
check("원견적 판매전환", conv.status === 200, conv.body);
const saleProjectId = (await q(rootId)).project_id;
const r1 = await call("POST", `/admin/quotes/${rootId}/create-revision`, { versionReason: "R1" });
check("R1 번호 = -R1", r1.status === 200 && r1.body.quoteNumber === `${base}-R1`, r1.body);
const R1 = await q(r1.body.id);
check("R1 승인대기·현재유효 아님·부모=원견적·발행일=오늘(KST)", R1.status === "pending" && R1.is_current === false && R1.parent_version_id === rootId && R1.issue_date === today, R1);
check("R1 생성 시 원견적·판매 변경 없음", (await q(rootId)).status === "approved" && (await q(rootId)).is_current === true && (await famSales(rootId)).n === 1);
const r2early = await call("POST", `/admin/quotes/${rootId}/create-revision`, {});
check("R1 대기 중 추가 생성 차단(409, 대기번호 안내)", r2early.status === 409 && r2early.body.pendingRevisionNumber === `${base}-R1`, r2early.body);
const convPending = await call("PATCH", `/admin/quotes/${r1.body.id}/status`, { status: "approved" });
check("대기 변경견적은 [판매전환] 불가(409)", convPending.status === 409, convPending.body);

console.log("\n[2] R1 승인 → 판매 재사용");
const ap1 = await call("POST", `/admin/quotes/${r1.body.id}/approve-revision`);
check("R1 승인: 기존 판매건 재사용(신규 판매 없음)", ap1.status === 200 && ap1.body.projectCreated === false && ap1.body.projectId === saleProjectId, ap1.body);
check("R1 현재유효·원견적 과거본·체인 현재유효 1건·판매 1건", (await q(r1.body.id)).is_current && !(await q(rootId)).is_current && (await currents(rootId)).n === 1 && (await famSales(rootId)).n === 1);
const ap1b = await call("POST", `/admin/quotes/${r1.body.id}/approve-revision`);
check("R1 재승인 멱등(alreadyProcessed)", ap1b.status === 200 && ap1b.body.alreadyProcessed === true, ap1b.body);

console.log("\n[3] 과거본(원견적)에서 생성 차단 → R1 에서 R2 생성 → 거절");
const fromOld = await call("POST", `/admin/quotes/${rootId}/create-revision`, {});
check("과거본(원견적)에서 변경견적 생성 차단(409, 현재유효 R1 안내)", fromOld.status === 409 && fromOld.body.currentQuoteNumber === `${base}-R1`, fromOld.body);
const r2 = await call("POST", `/admin/quotes/${r1.body.id}/create-revision`, { versionReason: "R2" });
const R2 = r2.body?.id ? await q(r2.body.id) : null;
check("R2 = -R2·부모 R1·version 3", r2.status === 200 && r2.body.quoteNumber === `${base}-R2` && R2.parent_version_id === r1.body.id && R2.version === 3, r2.body);
const rj2 = await call("POST", `/admin/quotes/${r2.body.id}/reject-revision`);
check("R2 거절 → R1 현재유효 유지·판매 1건", rj2.status === 200 && (await q(r2.body.id)).status === "rejected" && (await q(r1.body.id)).is_current && (await famSales(rootId)).n === 1, rj2.body);
const fromRejected = await call("POST", `/admin/quotes/${r2.body.id}/create-revision`, {});
check("거절본(R2)에서 생성 차단(409)", fromRejected.status === 409, fromRejected.body);

console.log("\n[4] R3 생성(번호 재사용 없음) → 승인 → R4 생성(횟수 제한 없음)");
const r3 = await call("POST", `/admin/quotes/${r1.body.id}/create-revision`, { versionReason: "R3" });
check("R3 = -R3 (거절된 R2 번호 재사용 없음)", r3.status === 200 && r3.body.quoteNumber === `${base}-R3`, r3.body);
const ap3 = await call("POST", `/admin/quotes/${r3.body.id}/approve-revision`);
check("R3 승인: 판매 재사용·현재유효 R3 1건·판매 1건", ap3.status === 200 && ap3.body.projectId === saleProjectId && (await q(r3.body.id)).is_current && !(await q(r1.body.id)).is_current && (await currents(rootId)).n === 1 && (await famSales(rootId)).n === 1, ap3.body);
const r4 = await call("POST", `/admin/quotes/${r3.body.id}/create-revision`, { versionReason: "R4" });
check("R4 = -R4 (R3 이후에도 생성 가능)", r4.status === 200 && r4.body.quoteNumber === `${base}-R4` && (await q(r4.body.id)).parent_version_id === r3.body.id, r4.body);
const fromR1 = await call("POST", `/admin/quotes/${r1.body.id}/create-revision`, {});
check("과거본(R1)에서 생성 차단", fromR1.status === 409, fromR1.body);

console.log("\n[5] family API 현재유효 판정");
const fam = await call("GET", `/admin/quotes/${rootId}/family`);
const curM = fam.body.members.filter((m: any) => m.isCurrent && (m.relationType == null || m.relationType === "revision"));
check("family: 현재유효 = R3 1건, R4 는 승인대기·현재유효 아님", curM.length === 1 && curM[0].id === r3.body.id && fam.body.members.find((m: any) => m.id === r4.body.id)?.isCurrent === false, curM);
const nums = fam.body.members.map((m: any) => m.quoteNumber);
check("family 순서: 원견적 → R1 → R2 → R3 → R4", JSON.stringify(nums) === JSON.stringify([base, `${base}-R1`, `${base}-R2`, `${base}-R3`, `${base}-R4`]), nums);
const rj4 = await call("POST", `/admin/quotes/${r4.body.id}/reject-revision`);
check("R4 거절", rj4.status === 200);

console.log("\n[6] 판매취소 → 대기 복귀 변경견적 재승인(중복 판매 없음)");
const projCnt0 = (await one(sql`SELECT count(*)::int n FROM projects`)).n;
const cancel = await call("PATCH", `/admin/projects/${saleProjectId}/cancel`, { reason: "검증" });
check("판매취소", cancel.status === 200, cancel.body);
const R3c = await q(r3.body.id);
check("판매취소 후 R3 = 승인대기(현재유효 플래그 유지 상태)", R3c.status === "pending" && R3c.is_current === true, R3c);
const blocked = await call("POST", `/admin/quotes/${r3.body.id}/create-revision`, {});
check("승인대기 R3 에서 변경견적 생성 차단", blocked.status === 409, blocked.body);
const reap = await call("POST", `/admin/quotes/${r3.body.id}/approve-revision`);
check("R3 재승인: 같은 판매건 재활성·프로젝트 신규 생성 없음", reap.status === 200 && reap.body.projectId === saleProjectId && reap.body.projectCreated === false && (await one(sql`SELECT count(*)::int n FROM projects`)).n === projCnt0 && (await famSales(rootId)).n === 1, reap.body);

console.log("\n[7] 판매취소로 대기 복귀한 과거본(R1) — 승인대기로 집계·승인·거절되지 않음");
const R1after = await q(r1.body.id);
check("R1 은 DB 상 pending 그대로(표시만 과거본, 데이터 불변)", R1after.status === "pending" && R1after.is_current === false, R1after);
const apOld = await call("POST", `/admin/quotes/${r1.body.id}/approve-revision`);
check("과거본 R1 승인 차단(409) — 현재유효 R3 유지", apOld.status === 409 && (await q(r3.body.id)).is_current === true, apOld.body);
const rjOld = await call("POST", `/admin/quotes/${r1.body.id}/reject-revision`);
check("과거본 R1 거절 차단(409) — 상태 불변", rjOld.status === 409 && (await q(r1.body.id)).status === "pending", rjOld.body);
const r5 = await call("POST", `/admin/quotes/${r3.body.id}/create-revision`, { versionReason: "R5" });
check("R3 재승인 후 다음 변경견적 생성 가능(-R5, 과거본 R1 이 미확정으로 집계되지 않음)", r5.status === 200 && r5.body.quoteNumber === `${base}-R5`, r5.body);
const famR = await call("GET", `/admin/quotes/${rootId}/family`);
check("family: 현재유효 R3 1건 유지", famR.body.members.filter((m: any) => m.isCurrent).map((m: any) => m.id).join() === String(r3.body.id), famR.body.members.map((m: any) => [m.quoteNumber, m.status, m.isCurrent]));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패  (rootId=${rootId}, base=${base})`);
process.exit(fail ? 1 : 0);
