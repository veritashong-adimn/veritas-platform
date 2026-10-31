// @ts-nocheck — 격리 테스트(복제 DB veritas_inq_scratch + 테스트 서버 :8098). 통합 휴지통 의뢰건: 목록·복원·완전삭제·권한.
//   운영 DB 에서는 실행되지 않는다(DATABASE_URL 이 복제 DB 가 아니면 즉시 종료).
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_inq_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("복제 DB(veritas_inq_scratch) 전용 테스트입니다."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8098/api";
const sign = (role: string, id: number) => jwt.sign({ id, email: `${role}@test`, role }, process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev", { expiresIn: "30m" });
const T = sign("admin", 10);
const call = async (m: string, p: string, b?: any, tok = T) => { const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const one = async (q: any) => ((await db.execute(q)).rows as any[])[0];
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d: any = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };

const co = await one(sql`SELECT c.id cid, c.name, ct.id ctid FROM companies c JOIN contacts ct ON ct.company_id = c.id WHERE c.deleted_at IS NULL ORDER BY c.id LIMIT 1`);
const mk = async (tag: string) => (await call("POST", "/admin/inquiries", {
  customerCompanyName: `휴지통테스트${tag}`, contactName: "테스터", channel: "email", serviceTypes: ["equipment"], companyId: co.cid, contactId: co.ctid,
  attachmentsJson: JSON.stringify([{ name: "요청.pdf", url: "/objects/t/요청.pdf" }]), subject: `휴지통주제${tag}`,
})).body;
const mkQuote = async (inquiryId: number, tag: string) => (await call("POST", "/admin/quotes", {
  title: `휴지통테스트${tag}`, companyId: co.cid, contactId: co.ctid,
  items: [{ productName: "동시통역장비", unit: "세트", quantity: 1, unitPrice: 500000, itemType: "equipment" }],
  inquiryCustomer: { inquiryId, companyId: co.cid, contactId: co.ctid },
})).body;
const del = (id: number, reason = "테스트 삭제") => call("DELETE", `/admin/inquiries/${id}`, { reason });
const trash = async () => (await call("GET", "/admin/inquiries-trash")).body;
const row = (id: number) => one(sql`SELECT * FROM inquiries WHERE id = ${id}`);
const lastLog = (id: number, action: string) => one(sql`SELECT metadata FROM logs WHERE entity_type = 'inquiry' AND entity_id = ${id} AND action = ${action} ORDER BY id DESC LIMIT 1`);
const counts = () => one(sql`SELECT (SELECT count(*) FROM quotes)::int q, (SELECT count(*) FROM projects)::int p, (SELECT count(*) FROM companies)::int c, (SELECT count(*) FROM contacts)::int ct, (SELECT count(*) FROM settlements)::int s, (SELECT count(*) FROM payments)::int pay`);

console.log("\n[A] 목록");
const baseTrash = (await trash()).length;
const dbTrash = (await one(sql`SELECT count(*)::int n FROM inquiries WHERE deleted_at IS NOT NULL`)).n;
check("A 휴지통 건수 = DB 삭제 건수", baseTrash === dbTrash, [baseTrash, dbTrash]);
const a = await mk("A");
await del(a.id);
const la = await trash(); const ra = la.find((x: any) => x.id === a.id);
check("A 삭제 후 1건 증가", la.length === baseTrash + 1);
check("A 표시 필드(번호·주제·거래처·삭제자·사유·삭제일)", ra?.inquiryNumber === a.inquiryNumber && ra.subject === "휴지통주제A" && ra.companyName === co.name && ra.customerCompanyName === "휴지통테스트A" && !!ra.deletedAt && ra.deletionReason === "테스트 삭제" && !!ra.deletedByName, ra);
check("A 삭제일 최신순", la[0].id === a.id, la[0]);

console.log("\n[B] 복원");
const before = await row(a.id);
const r1 = await call("POST", `/admin/inquiries/${a.id}/restore`, { reason: "복원 사유" });
check("B 복원 성공", r1.status === 200 && r1.body.success === true, r1);
const after = await row(a.id);
check("B 삭제 표시 해제", after.deleted_at === null && after.deleted_by === null && after.deletion_reason === null, after);
check("B 의뢰번호·거래처·담당자·첨부·내용 유지", ["inquiry_number", "company_id", "contact_id", "attachments_json", "subject", "quote_id", "status"].every(k => String(after[k]) === String(before[k])));
check("B 상세 재조회 가능", (await call("GET", `/admin/inquiries/${a.id}`)).status === 200);
check("B 목록 재조회", ((await call("GET", "/admin/inquiries")).body.rows ?? []).some((x: any) => x.id === a.id));
check("B 휴지통에서 제외", !(await trash()).some((x: any) => x.id === a.id));
check("B 행 중복 없음", (await one(sql`SELECT count(*)::int n FROM inquiries WHERE inquiry_number = ${a.inquiryNumber}`)).n === 1);
const lb = await lastLog(a.id, "inquiry_restored");
check("B 감사로그(복원 사유·이전 삭제사유)", lb && JSON.parse(lb.metadata).restoreReason === "복원 사유" && JSON.parse(lb.metadata).deletionReason === "테스트 삭제", lb);
check("B 삭제 안 된 의뢰건 복원 409", (await call("POST", `/admin/inquiries/${a.id}/restore`)).status === 409);
check("B 없는 의뢰건 복원 404", (await call("POST", `/admin/inquiries/999999999/restore`)).status === 404);
await del(a.id);
const dbl = await Promise.all([call("POST", `/admin/inquiries/${a.id}/restore`), call("POST", `/admin/inquiries/${a.id}/restore`)]);
check("B 동시 복원 — 1건만 성공", dbl.filter(x => x.status === 200).length === 1 && dbl.filter(x => x.status === 409).length === 1, dbl.map(x => x.status));

console.log("\n[C] 견적 연결 유지·완전삭제 차단");
const c = await mk("C");
const q = await mkQuote(c.id, "C");
const qid = q.id ?? q.quote?.id;
check("C 견적 연결", (await row(c.id)).quote_id === qid, q);
const live = await call("DELETE", `/admin/inquiries/${c.id}/permanent`);
check("C 삭제 안 된 의뢰건 완전삭제 차단", live.status === 409, live);
check("C 유효 견적 있으면 삭제 불가(기존 규칙)", (await del(c.id)).status === 409);
const qd = await call("DELETE", `/admin/quotes/${qid}`, { reason: "테스트" });
check("C 견적 삭제", qd.status === 200, qd);
check("C 의뢰건 삭제", (await del(c.id)).status === 200);
const sig = await counts();
const blocked = await call("DELETE", `/admin/inquiries/${c.id}/permanent`);
check("C 휴지통 견적 연결 시 완전삭제 차단 + 사유", blocked.status === 409 && /견적서/.test(blocked.body.error) && blocked.body.reasons.length === 1, blocked);
check("C 차단 시 행 유지", !!(await row(c.id)));
check("C 복원 가능", (await call("POST", `/admin/inquiries/${c.id}/restore`)).status === 200);
const qr = await call("POST", `/admin/quotes/${qid}/restore`);
check("C 견적 복원 → 의뢰건 재연결", qr.status === 200 && (await row(c.id)).quote_id === qid, qr);
check("C 연결 유지 상태로 상세 조회", (await call("GET", `/admin/inquiries/${c.id}`)).status === 200);

console.log("\n[D] 완전삭제");
const d = await mk("D"); await del(d.id, "완전삭제 대상");
const staff = sign("staff", 10);
check("D 직원 완전삭제 403", (await call("DELETE", `/admin/inquiries/${d.id}/permanent`, undefined, staff)).status === 403);
check("D 고객 휴지통 조회 403", (await call("GET", "/admin/inquiries-trash", undefined, sign("customer", 10))).status === 403);
check("D 고객 복원 403", (await call("POST", `/admin/inquiries/${d.id}/restore`, undefined, sign("customer", 10))).status === 403);
const sig2 = await counts();
const p = await call("DELETE", `/admin/inquiries/${d.id}/permanent`, { reason: "테스트 완전삭제" });
check("D 관리자 완전삭제 성공", p.status === 200 && p.body.success === true, p);
check("D 행 삭제", !(await row(d.id)));
check("D 휴지통에서 제외", !(await trash()).some((x: any) => x.id === d.id));
check("D 연결 데이터 무변경(견적·프로젝트·거래처·담당자·정산·결제)", JSON.stringify(await counts()) === JSON.stringify(sig2));
const ld = await lastLog(d.id, "inquiry_purged");
check("D 감사로그 보존(의뢰번호·거래처·사유)", ld && JSON.parse(ld.metadata).inquiryNumber === d.inquiryNumber && JSON.parse(ld.metadata).purgeReason === "테스트 완전삭제" && JSON.parse(ld.metadata).customerCompanyName === "휴지통테스트D", ld);
check("D 재완전삭제 404", (await call("DELETE", `/admin/inquiries/${d.id}/permanent`)).status === 404);
const e = await mk("E");
check("D 다음 의뢰번호는 재사용 없이 증가", e.inquiryNumber > d.inquiryNumber, [e.inquiryNumber, d.inquiryNumber]);
await del(e.id);
const race = await Promise.all([call("DELETE", `/admin/inquiries/${e.id}/permanent`), call("DELETE", `/admin/inquiries/${e.id}/permanent`)]);
check("D 동시 완전삭제 — 1건만 성공", race.filter(x => x.status === 200).length === 1, race.map(x => x.status));

console.log("\n[E] 기존 휴지통 유지");
for (const path of ["quotes-trash", "companies-trash", "contacts-trash", "products/trash", "users-trash"]) {
  const r = await call("GET", `/admin/${path}`);
  check(`E ${path} 정상`, r.status === 200 && Array.isArray(r.body), r.status);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
