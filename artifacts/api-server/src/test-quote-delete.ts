// @ts-nocheck — 격리 테스트(복제 DB veritas_inq_scratch + 테스트 서버 :8098). 견적서 삭제(논리 삭제) + 의뢰건·프로젝트 원복 A~J.
//   운영 DB 에서는 실행되지 않는다(DATABASE_URL 이 복제 DB 가 아니면 즉시 종료).
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_inq_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("복제 DB(veritas_inq_scratch) 전용 테스트입니다."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8098/api";
const T = jwt.sign({ id: 10, email: "admin@test", role: "admin" }, process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev", { expiresIn: "30m" });
const call = async (m: string, p: string, b?: any) => { const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const one = async (q: any) => ((await db.execute(q)).rows as any[])[0];
const all = async (q: any) => (await db.execute(q)).rows as any[];
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d: any = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };

const co = await one(sql`SELECT c.id cid, ct.id ctid FROM companies c JOIN contacts ct ON ct.company_id = c.id ORDER BY c.id LIMIT 1`);
const EQ = JSON.stringify([{ kind: "동시통역장비", quantity: "1", unit: "세트", days: "3", location: "테스트홀", note: "부스1개포함" }, { kind: "리시버", quantity: "800", unit: "개", location: "테스트홀", note: "9/14 20개" }]);
const ATT = JSON.stringify([{ name: "견적요청.pdf", url: "/objects/test/견적요청.pdf" }]);
let seq = 0;
async function mkInquiryQuote(tag: string) {
  seq++;
  const inq = await call("POST", "/admin/inquiries", {
    customerCompanyName: `삭제테스트${tag}`, contactName: "테스터", subject: "", channel: "email", serviceTypes: ["equipment"],
    companyId: co.cid, contactId: co.ctid, equipmentJson: EQ, attachmentsJson: ATT, requirements: `요청사항 ${tag}`,
    scheduleFrom: "2026-09-14T00:00:00.000Z", scheduleTo: "2026-09-16T00:00:00.000Z", place: "테스트홀",
  });
  await db.execute(sql`UPDATE inquiries SET ai_draft_json = ${JSON.stringify({ analyzed: tag })}, ai_status = 'draft' WHERE id = ${inq.body.id}`);
  const q = await call("POST", "/admin/quotes", {
    title: `삭제테스트${tag}_동시통역장비`, companyId: co.cid, contactId: co.ctid,
    items: [{ productName: "동시통역장비", unit: "세트", quantity: 1, unitPrice: 600000, itemType: "equipment" }],
    inquiryCustomer: { inquiryId: inq.body.id, companyId: co.cid, contactId: co.ctid },
  });
  return { inquiryId: inq.body.id, quoteId: q.body.id, projectId: q.body.projectId, quoteNumber: q.body.quoteNumber, status: q.status };
}
const inqRow = (id: number) => one(sql`SELECT * FROM inquiries WHERE id = ${id}`);
const strip = (r: any) => { const { quote_id, updated_at, ...rest } = r; return rest; };

// ── A. 미발송(저장만) 견적서 삭제 → 의뢰건 원복 ──
console.log("\n[A] 미발송 견적서 삭제 → 의뢰건 접수 상태 원복");
const a = await mkInquiryQuote("A");
check("A 준비: 의뢰건→견적 저장(프로젝트 생성·의뢰건 연결)", a.status === 201 && a.projectId && (await inqRow(a.inquiryId)).quote_id === a.quoteId, a);
const before = await inqRow(a.inquiryId);
const projCountBefore = (await one(sql`SELECT count(*)::int n FROM projects`)).n;
const chkA = await call("GET", `/admin/quotes/${a.quoteId}/delete-check`);
check("A 삭제 가능 확인(delete-check ok)", chkA.status === 200 && chkA.body.ok === true, chkA.body);
const delA = await call("DELETE", `/admin/quotes/${a.quoteId}`, {});
check("A 삭제 성공(사유 없이)", delA.status === 200 && delA.body.success && delA.body.inquiryId === a.inquiryId, delA.body);
check("A 메시지 '견적서가 삭제 처리되었습니다. 기존 의뢰건으로 돌아갑니다.'", delA.body?.message === "견적서가 삭제 처리되었습니다. 기존 의뢰건으로 돌아갑니다.", delA.body?.message);
const qA = await one(sql`SELECT deleted_at, deleted_by, deletion_reason, quote_number, project_id FROM quotes WHERE id = ${a.quoteId}`);
check("A 논리 삭제(레코드 보존·deleted_at/by 기록·견적번호 유지)", !!qA.deleted_at && qA.deleted_by === 10 && qA.quote_number === a.quoteNumber && qA.project_id === a.projectId, qA);
const itemsKept = (await one(sql`SELECT count(*)::int n FROM quote_items WHERE quote_id = ${a.quoteId}`)).n;
check("A 삭제 견적의 품목·단가는 삭제 견적에 그대로 보존", itemsKept === 1, itemsKept);
const pA = await one(sql`SELECT id, status FROM projects WHERE id = ${a.projectId}`);
check("A 프로젝트 ID 유지·상태 '접수'(created)·프로젝트 신규 생성 없음", pA.id === a.projectId && pA.status === "created" && (await one(sql`SELECT count(*)::int n FROM projects`)).n === projCountBefore, pA);
const dA = await call("GET", `/admin/inquiries/${a.inquiryId}`);
check("A 의뢰건 연결 해제 → 처리상태 '견적 생성 가능'(quoteId 없음, 확인중)", dA.body.quoteId === null && dA.body.quoteProgress === "none" && ["new", "reviewing"].includes(dA.body.processingStatus), { quoteId: dA.body.quoteId, p: dA.body.processingStatus });
const logs = await all(sql`SELECT entity_type, action, metadata FROM logs WHERE (entity_type = 'quote' AND entity_id = ${a.quoteId}) OR (entity_type = 'inquiry' AND entity_id = ${a.inquiryId}) OR (entity_type = 'project' AND entity_id = ${a.projectId}) ORDER BY id`);
const qlog = logs.find(l => l.entity_type === "quote" && l.action === "quote_deleted");
const m = qlog ? JSON.parse(qlog.metadata) : {};
check("A 감사로그 QUOTE_DELETED(견적번호·프로젝트·처리 전후 상태)", m.event === "QUOTE_DELETED" && m.quoteNumber === a.quoteNumber && m.projectId === a.projectId && m.projectStatusAfter === "created", m);
check("A 의뢰건·프로젝트 이력에도 삭제 기록", logs.some(l => l.entity_type === "inquiry" && l.action === "inquiry_quote_unlinked") && logs.some(l => l.entity_type === "project" && l.action === "quote_deleted"));

// ── J. 의뢰 정보 유지 ──
console.log("\n[J] 삭제 후 고객·의뢰·장비·첨부·AI 분석 정보 유지");
const after = await inqRow(a.inquiryId);
check("J 의뢰건 행(연결 견적 외) 변경 없음 — 고객·장비(대여일수)·첨부·AI 분석·접수정보·PM", JSON.stringify(strip(after)) === JSON.stringify(strip(before)));
check("J 장비 대여일수·첨부 그대로", JSON.parse(after.equipment_json)[0].days === "3" && JSON.parse(after.attachments_json)[0].name === "견적요청.pdf");

// ── I. 목록·휴지통 반영 ──
console.log("\n[I] 견적 목록·휴지통");
const list = await call("GET", "/admin/quotes?limit=200");
const rows = Array.isArray(list.body) ? list.body : list.body?.items ?? list.body?.rows ?? list.body?.data ?? [];
check("I 견적 목록에서 삭제 견적 제외", !rows.some((r: any) => r.id === a.quoteId), rows.length);
const trash = await call("GET", "/admin/quotes-trash");
check("I 휴지통에는 표시(추적 가능)", trash.body.some((r: any) => r.id === a.quoteId));

// ── B. 삭제 후 견적 재생성 ──
console.log("\n[B] 같은 의뢰건에서 견적 재생성");
const qB = await call("POST", "/admin/quotes", {
  title: "삭제테스트A_재작성", companyId: co.cid, contactId: co.ctid,
  items: [{ productName: "동시통역장비", unit: "세트", quantity: 1, unitPrice: 700000, itemType: "equipment" }],
  inquiryCustomer: { inquiryId: a.inquiryId, companyId: co.cid, contactId: co.ctid },
});
check("B 새 견적서 생성", qB.status === 201 && qB.body.id !== a.quoteId, qB.status);
check("B 견적번호 재사용 없음", qB.body.quoteNumber !== a.quoteNumber, [qB.body.quoteNumber, a.quoteNumber]);
check("B 기존 프로젝트 ID 재사용(빈 프로젝트 미생성)", qB.body.projectId === a.projectId && (await one(sql`SELECT count(*)::int n FROM projects`)).n === projCountBefore, [qB.body.projectId, a.projectId]);
const afterB = await inqRow(a.inquiryId);
check("B 의뢰건이 새 견적에 연결, 의뢰정보 그대로", afterB.quote_id === qB.body.id && afterB.equipment_json === before.equipment_json && afterB.attachments_json === before.attachments_json);

// ── H. 중복 삭제 ──
console.log("\n[H] 중복 삭제 요청");
const again = await call("DELETE", `/admin/quotes/${a.quoteId}`, {});
check("H 이미 삭제된 견적 재요청 → 409", again.status === 409, again.body);
const h = await mkInquiryQuote("H");
const [h1, h2] = await Promise.all([call("DELETE", `/admin/quotes/${h.quoteId}`, {}), call("DELETE", `/admin/quotes/${h.quoteId}`, {})]);
check("H 동시 2회 요청 → 1건만 성공(200), 1건 409", [h1.status, h2.status].sort().join() === "200,409", [h1.status, h2.status]);
const hLogs = (await one(sql`SELECT count(*)::int n FROM logs WHERE entity_type = 'quote' AND entity_id = ${h.quoteId} AND action = 'quote_deleted'`)).n;
check("H 삭제 로그 1건", hLogs === 1, hLogs);

// ── C. 발송된 견적 ──
console.log("\n[C~F] 삭제 제한");
const c = await mkInquiryQuote("C");
await call("PATCH", `/admin/quotes/${c.quoteId}/status`, { status: "sent" });
const cc = await call("GET", `/admin/quotes/${c.quoteId}/delete-check`);
const cd = await call("DELETE", `/admin/quotes/${c.quoteId}`, {});
check("C 발송된 견적 → 삭제 제한 + 사유 안내", cc.body.ok === false && cd.status === 409 && /발송/.test(cd.body.error), cd.body);
check("C 의뢰건 연결 유지", (await inqRow(c.inquiryId)).quote_id === c.quoteId);
// ── D. 승인(판매전환)된 견적 ──
const d = await mkInquiryQuote("D");
await db.execute(sql`UPDATE quotes SET status = 'approved' WHERE id = ${d.quoteId}`);
await db.execute(sql`UPDATE projects SET status = 'approved' WHERE id = ${d.projectId}`);
const dd = await call("DELETE", `/admin/quotes/${d.quoteId}`, {});
check("D 승인된 견적 → 삭제 제한", dd.status === 409 && /승인/.test(dd.body.error), dd.body);
// ── E. 배정·진행 ──
const e = await mkInquiryQuote("E");
await db.execute(sql`INSERT INTO tasks (project_id, translator_id) VALUES (${e.projectId}, 10)`);
const ed = await call("DELETE", `/admin/quotes/${e.quoteId}`, {});
check("E 통번역사 배정 기록 → 삭제 제한", ed.status === 409 && ed.body.reasons.some((r: string) => /배정/.test(r)), ed.body);
const e2 = await mkInquiryQuote("E2");
await db.execute(sql`UPDATE projects SET status = 'in_progress' WHERE id = ${e2.projectId}`);
const e2d = await call("DELETE", `/admin/quotes/${e2.quoteId}`, {});
check("E 진행중 프로젝트 → 삭제 제한", e2d.status === 409 && e2d.body.reasons.some((r: string) => /진행중/.test(r)), e2d.body);
// ── F. 결제·정산 ──
const f = await mkInquiryQuote("F");
await db.execute(sql`INSERT INTO payments (project_id, amount) VALUES (${f.projectId}, 660000)`);
const fd = await call("DELETE", `/admin/quotes/${f.quoteId}`, {});
check("F 결제 기록 → 삭제 제한", fd.status === 409 && fd.body.reasons.some((r: string) => /결제/.test(r)), fd.body);
const f2 = await mkInquiryQuote("F2");
await db.execute(sql`INSERT INTO settlements (project_id, translator_id, total_amount, translator_amount, platform_fee) VALUES (${f2.projectId}, 10, 100000, 70000, 30000)`);
const f2d = await call("DELETE", `/admin/quotes/${f2.quoteId}`, {});
check("F 정산 기록 → 삭제 제한", f2d.status === 409 && f2d.body.reasons.some((r: string) => /정산/.test(r)), f2d.body);
const blockedKept = await all(sql`SELECT id FROM quotes WHERE id IN (${c.quoteId}, ${d.quoteId}, ${e.quoteId}, ${e2.quoteId}, ${f.quoteId}, ${f2.quoteId}) AND deleted_at IS NULL`);
check("C~F 제한된 견적은 모두 그대로(삭제 안 됨)", blockedKept.length === 6, blockedKept.length);

// ── G. 같은 프로젝트에 유효 견적 2건 ──
console.log("\n[G] 같은 프로젝트에 유효 견적 2건");
const g = await mkInquiryQuote("G");
await db.execute(sql`UPDATE projects SET status = 'quoted' WHERE id = ${g.projectId}`);
const g2 = await one(sql`INSERT INTO quotes (project_id, price, status, quote_number, title, is_current) SELECT project_id, price, 'pending', ${'QTESTG2-' + Date.now()}, title || '_2', false FROM quotes WHERE id = ${g.quoteId} RETURNING id`);
const gc = await call("GET", `/admin/quotes/${g.quoteId}/delete-check`);
check("G 삭제 확인에 다른 유효 견적 안내", gc.body.otherActiveQuotes?.length === 1, gc.body);
const gd = await call("DELETE", `/admin/quotes/${g.quoteId}`, {});
check("G 하나만 삭제·실제 결과 메시지(상태 유지)", gd.status === 200 && /다른 유효 견적서\(1건\)/.test(gd.body.message) && gd.body.projectStatusAfter === "quoted", gd.body);
check("G 나머지 견적 유지 + 의뢰건은 남은 유효 견적에 연결", !(await one(sql`SELECT deleted_at FROM quotes WHERE id = ${g2.id}`)).deleted_at && (await inqRow(g.inquiryId)).quote_id === g2.id);
check("G 프로젝트 상태 유지(quoted)", (await one(sql`SELECT status FROM projects WHERE id = ${g.projectId}`)).status === "quoted");

// ── 휴지통 복원 시 의뢰건 재연결 ──
console.log("\n[복원] 휴지통 복원 → 의뢰건 재연결");
const r = await mkInquiryQuote("R");
await call("DELETE", `/admin/quotes/${r.quoteId}`, { reason: "디자인 확인용" });
check("복원 전: 삭제 사유 기록", (await one(sql`SELECT deletion_reason FROM quotes WHERE id = ${r.quoteId}`)).deletion_reason === "디자인 확인용");
const rr = await call("POST", `/admin/quotes/${r.quoteId}/restore`, {});
check("복원 → 의뢰건이 다시 그 견적에 연결", rr.status === 200 && (await inqRow(r.inquiryId)).quote_id === r.quoteId, rr.body);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
