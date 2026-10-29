// @ts-nocheck — 격리 테스트(복제 DB veritas_inq_scratch + 테스트 서버 :8098). 의뢰건 삭제(논리 삭제) A~E + 중복 요청.
//   운영 DB 에서는 실행되지 않는다(DATABASE_URL 이 복제 DB 가 아니면 즉시 종료).
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_inq_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("복제 DB(veritas_inq_scratch) 전용 테스트입니다."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8098/api";
const T = jwt.sign({ id: 10, email: "admin@test", role: "admin" }, process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev", { expiresIn: "30m" });
const call = async (m: string, p: string, b?: any) => { const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const one = async (q: any) => ((await db.execute(q)).rows as any[])[0];
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d: any = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };

const co = await one(sql`SELECT c.id cid, ct.id ctid FROM companies c JOIN contacts ct ON ct.company_id = c.id ORDER BY c.id LIMIT 1`);
const masterSig = async () => one(sql`SELECT md5(row(c.*)::text) c, (SELECT md5(row(ct.*)::text) FROM contacts ct WHERE ct.id = ${co.ctid}) ct FROM companies c WHERE c.id = ${co.cid}`);
const mkInquiry = async (tag: string) => (await call("POST", "/admin/inquiries", {
  customerCompanyName: `의뢰삭제테스트${tag}`, contactName: "테스터", channel: "email", serviceTypes: ["equipment"], companyId: co.cid, contactId: co.ctid,
  attachmentsJson: JSON.stringify([{ name: "요청.pdf", url: "/objects/t/요청.pdf" }]), requirements: `요청 ${tag}`,
})).body.id;
const mkQuote = async (inquiryId: number, tag: string) => (await call("POST", "/admin/quotes", {
  title: `의뢰삭제테스트${tag}`, companyId: co.cid, contactId: co.ctid,
  items: [{ productName: "동시통역장비", unit: "세트", quantity: 1, unitPrice: 500000, itemType: "equipment" }],
  inquiryCustomer: { inquiryId, companyId: co.cid, contactId: co.ctid },
})).body;
const today = (await one(sql`SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text d`)).d;
const listIds = async () => { const r = (await call("GET", `/admin/inquiries?date=${today}`)).body; return { ids: (r.rows ?? []).map((x: any) => x.id), summary: r.summary ?? r.counts ?? null }; };
const sig0 = await masterSig();

console.log("\n[A] 견적서 없는 의뢰건 삭제");
const a = await mkInquiry("A");
await db.execute(sql`UPDATE inquiries SET ai_draft_json = '{"analyzed":true}', ai_status = 'draft' WHERE id = ${a}`);
const before = await listIds();
check("A 삭제 전 목록에 표시", before.ids.includes(a));
const ca = await call("GET", `/admin/inquiries/${a}/delete-check`);
check("A 삭제 가능 확인", ca.status === 200 && ca.body.ok === true, ca.body);
const da = await call("DELETE", `/admin/inquiries/${a}`, { reason: "테스트 정리" });
check("A 삭제 성공 + 메시지 '의뢰건이 삭제 처리되었습니다.'", da.status === 200 && da.body.message === "의뢰건이 삭제 처리되었습니다.", da.body);
const ra = await one(sql`SELECT deleted_at, deleted_by, deletion_reason, attachments_json, ai_draft_json, company_id, contact_id FROM inquiries WHERE id = ${a}`);
check("A 논리 삭제(행 보존·삭제일시/처리자/사유 기록)", !!ra.deleted_at && ra.deleted_by === 10 && ra.deletion_reason === "테스트 정리", ra);
check("A 첨부·AI 분석 이력·고객 연결 보존", /요청\.pdf/.test(ra.attachments_json) && /analyzed/.test(ra.ai_draft_json) && ra.company_id === co.cid && ra.contact_id === co.ctid);
check("A 상세 조회 제외(404)", (await call("GET", `/admin/inquiries/${a}`)).status === 404);
const la = await one(sql`SELECT metadata FROM logs WHERE entity_type = 'inquiry' AND entity_id = ${a} AND action = 'inquiry_deleted' ORDER BY id DESC LIMIT 1`);
check("A 감사로그 INQUIRY_DELETED", la && JSON.parse(la.metadata).event === "INQUIRY_DELETED", la);

console.log("\n[E] 삭제 후 목록·집계");
const after = await listIds();
check("E 일반 목록에서 제외", !after.ids.includes(a));
check("E 일자별 집계 건수 1 감소", before.ids.length - after.ids.length === 1, [before.ids.length, after.ids.length]);

console.log("\n[B] 견적서 삭제 후 의뢰건 삭제");
const b = await mkInquiry("B"); const qb = await mkQuote(b, "B");
check("B 유효 견적 연결 시 삭제 제한", (await call("DELETE", `/admin/inquiries/${b}`, {})).status === 409);
const dq = await call("DELETE", `/admin/quotes/${qb.id}`, {});
check("B 견적서 삭제", dq.status === 200, dq.body);
const db_ = await call("DELETE", `/admin/inquiries/${b}`, {});
check("B 의뢰건 삭제 성공", db_.status === 200, db_.body);
const lb = JSON.parse((await one(sql`SELECT metadata FROM logs WHERE entity_type = 'inquiry' AND entity_id = ${b} AND action = 'inquiry_deleted' ORDER BY id DESC LIMIT 1`)).metadata);
check("B 감사로그에 원래 프로젝트·견적 ID", lb.projectIds.includes(qb.projectId) && lb.quoteIds.includes(qb.id), lb);
const pb = await one(sql`SELECT id, status FROM projects WHERE id = ${qb.projectId}`);
check("B 프로젝트 물리 삭제 없음(그대로 보존)", pb && pb.id === qb.projectId, pb);
check("B 삭제된 의뢰건으로 견적 작성 불가", (await mkQuote(b, "B2"))?.error?.includes("삭제된 의뢰건") ?? false);

console.log("\n[C] 유효 견적서가 있는 의뢰건");
const c = await mkInquiry("C"); const qc = await mkQuote(c, "C");
const cc = await call("GET", `/admin/inquiries/${c}/delete-check`);
const dc = await call("DELETE", `/admin/inquiries/${c}`, {});
check("C 삭제 제한 + 사유(유효한 견적서)", cc.body.ok === false && dc.status === 409 && /유효한 견적서/.test(dc.body.error), dc.body);
check("C 의뢰건·견적 그대로", !(await one(sql`SELECT deleted_at FROM inquiries WHERE id = ${c}`)).deleted_at && !(await one(sql`SELECT deleted_at FROM quotes WHERE id = ${qc.id}`)).deleted_at);

console.log("\n[D] 배정·작업·정산·발송 이력(삭제된 견적 포함)");
// D1: 과거(이전 규칙) 발송 후 삭제된 견적 — 견적은 삭제됐지만 발송 이력이 있으므로 의뢰건 삭제 제한
const d1 = await mkInquiry("D1"); const q1 = await mkQuote(d1, "D1");
await call("PATCH", `/admin/quotes/${q1.id}/status`, { status: "sent" });
await db.execute(sql`UPDATE quotes SET deleted_at = now() WHERE id = ${q1.id}`);
await db.execute(sql`UPDATE inquiries SET quote_id = NULL WHERE id = ${d1}`);
await db.execute(sql`INSERT INTO logs (entity_type, entity_id, action, metadata) VALUES ('inquiry', ${d1}, 'inquiry_quote_unlinked', ${JSON.stringify({ quoteId: q1.id, projectId: q1.projectId })})`);
const dd1 = await call("DELETE", `/admin/inquiries/${d1}`, {});
check("D 삭제된 견적이라도 과거 발송 이력 → 제한", dd1.status === 409 && dd1.body.reasons.some((r: string) => /발송/.test(r)), dd1.body);
// D2: 배정(task) 이력
const d2 = await mkInquiry("D2"); const q2 = await mkQuote(d2, "D2");
await db.execute(sql`INSERT INTO tasks (project_id, translator_id) VALUES (${q2.projectId}, 10)`);
const dd2 = await call("DELETE", `/admin/inquiries/${d2}`, {});
check("D 배정 이력(유효 견적 포함) → 제한", dd2.status === 409, dd2.body);
// D3: 정산 이력 + 견적은 삭제된 상태(규칙 우회 시뮬레이션)
const d3 = await mkInquiry("D3"); const q3 = await mkQuote(d3, "D3");
await db.execute(sql`INSERT INTO settlements (project_id, translator_id, total_amount, translator_amount, platform_fee) VALUES (${q3.projectId}, 10, 100000, 70000, 30000)`);
await db.execute(sql`UPDATE quotes SET deleted_at = now() WHERE id = ${q3.id}`);
await db.execute(sql`UPDATE inquiries SET quote_id = NULL WHERE id = ${d3}`);
await db.execute(sql`INSERT INTO logs (entity_type, entity_id, action, metadata) VALUES ('inquiry', ${d3}, 'inquiry_quote_unlinked', ${JSON.stringify({ quoteId: q3.id, projectId: q3.projectId })})`);
const dd3 = await call("DELETE", `/admin/inquiries/${d3}`, {});
check("D 삭제된 견적의 프로젝트에 정산 기록 → 제한", dd3.status === 409 && dd3.body.reasons.some((r: string) => /정산/.test(r)), dd3.body);

console.log("\n[중복] 동일 의뢰건 중복 삭제");
const h = await mkInquiry("H");
const [h1, h2] = await Promise.all([call("DELETE", `/admin/inquiries/${h}`, {}), call("DELETE", `/admin/inquiries/${h}`, {})]);
check("동시 2회 → 1건만 성공", [h1.status, h2.status].sort().join() === "200,409", [h1.status, h2.status]);
check("이미 삭제된 의뢰건 재요청 → 404/409", [404, 409].includes((await call("DELETE", `/admin/inquiries/${h}`, {})).status));
check("삭제 로그 1건", (await one(sql`SELECT count(*)::int n FROM logs WHERE entity_type = 'inquiry' AND entity_id = ${h} AND action = 'inquiry_deleted'`)).n === 1);

check("거래처·담당자 Master 변경 없음", JSON.stringify(await masterSig()) === JSON.stringify(sig0));
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
