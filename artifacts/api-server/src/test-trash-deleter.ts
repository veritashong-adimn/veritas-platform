// @ts-nocheck — 격리 테스트(복제 DB veritas_inq_scratch + 테스트 서버 :8098). 통합 휴지통 삭제자 표시 전 영역 점검.
//   운영 DB 에서는 실행되지 않는다(DATABASE_URL 이 복제 DB 가 아니면 즉시 종료).
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_inq_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("복제 DB(veritas_inq_scratch) 전용 테스트입니다."); process.exit(1); }
const B = process.env.TEST_API ?? "http://localhost:8098/api";
const T = jwt.sign({ id: 10, email: "admin@test", role: "admin" }, process.env.JWT_SECRET ?? "translation-platform-jwt-secret-dev", { expiresIn: "30m" });
const call = async (m: string, p: string, b?: any) => { const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const all = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await all(q))[0];
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d: any = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const tag = `삭제자테스트${Date.now()}`;
const list = async (path: string) => (await call("GET", `/admin/${path}`)).body;
const byId = (rows: any[], id: number) => rows.find(x => x.id === id);

const real = await one(sql`SELECT id, COALESCE(NULLIF(btrim(name), ''), email) label FROM users WHERE id = 10`);
const mkUser = async (s: string, active: boolean, deleted: boolean, name: string | null) => (await one(sql`INSERT INTO users (email, name, role, is_active, deleted_at) VALUES (${`${tag}-${s}@test.local`}, ${name}, 'staff', ${active}, ${deleted ? sql`now()` : null}) RETURNING id`)).id;
const inactive = await mkUser("inactive", false, false, `${tag}비활성관리자`);
const softDel = await mkUser("softdel", true, true, `${tag}삭제된관리자`);
const noName = await mkUser("noname", true, false, null);
const GONE = 999999999;
const mkCo = async (s: string, by: number | null) => (await one(sql`INSERT INTO companies (name, deleted_at, deleted_by, deletion_reason) VALUES (${`${tag}${s}`}, now(), ${by}, '테스트') RETURNING id`)).id;
const cReal = await mkCo("정상", 10), cInact = await mkCo("비활성", inactive), cSoft = await mkCo("삭제됨", softDel), cNoName = await mkCo("이름없음", noName), cNull = await mkCo("기록없음", null), cGone = await mkCo("확인불가", GONE);
const target = (await one(sql`INSERT INTO users (email, name, role, is_active, deleted_at, deleted_by, deletion_reason) VALUES (${`${tag}-target@test.local`}, ${`${tag}김철수`}, 'staff', false, now(), 10, '테스트') RETURNING id`)).id;

console.log("\n[①③④⑤] 거래처 — 삭제자 경우별");
const cos = await list("companies-trash");
check("① 정상 삭제자 이름", byId(cos, cReal).deletedByName === real.label && byId(cos, cReal).deletedBy === 10, byId(cos, cReal));
check("③ 비활성 삭제자도 이름 유지", byId(cos, cInact).deletedByName === `${tag}비활성관리자`, byId(cos, cInact));
check("③ 소프트 삭제된 삭제자도 이름 유지", byId(cos, cSoft).deletedByName === `${tag}삭제된관리자`, byId(cos, cSoft));
check("이름 없는 삭제자는 이메일", byId(cos, cNoName).deletedByName === `${tag}-noname@test.local`, byId(cos, cNoName));
check("④ deleted_by 없음 → id·이름 모두 null(화면 '기록 없음')", byId(cos, cNull).deletedBy === null && byId(cos, cNull).deletedByName === null, byId(cos, cNull));
check("⑤ 없는 사용자 → id 유지·이름 null(화면 '사용자 확인 불가')", byId(cos, cGone).deletedBy === GONE && byId(cos, cGone).deletedByName === null, byId(cos, cGone));
check("현재 로그인 관리자를 대입하지 않음", byId(cos, cNull).deletedByName !== real.label && byId(cos, cGone).deletedByName !== real.label);

console.log("\n[②] 사용자 — 삭제 대상과 삭제자 구분");
const us = await list("users-trash");
const ut = byId(us, target);
check("② 삭제 대상 = 김철수, 삭제자 = 관리자", ut.name === `${tag}김철수` && ut.deletedByName === real.label && ut.id !== ut.deletedBy, ut);
check("② 삭제된 사용자 자신이 deleter 로 표시되지 않음", us.every((u: any) => u.deletedBy == null || u.deletedBy !== u.id));
const softRow = byId(us, softDel);
check("② 삭제자 없는 소프트 삭제 사용자 → '기록 없음' 대상", softRow.deletedBy === null && softRow.deletedByName === null, softRow);

console.log("\n[⑥⑦⑩] 전 영역 API ↔ DB 대조");
const label = (t: string) => sql.raw(`SELECT t.id, t.deleted_by, COALESCE(NULLIF(btrim(u.name), ''), u.email) label FROM ${t} t LEFT JOIN users u ON u.id = t.deleted_by WHERE t.deleted_at IS NOT NULL`);
for (const [nm, path, t] of [["의뢰건", "inquiries-trash", "inquiries"], ["견적서", "quotes-trash", "quotes"], ["거래처", "companies-trash", "companies"], ["담당자", "contacts-trash", "contacts"], ["사용자", "users-trash", "users"]] as const) {
  const api = await list(path); const dbRows = await all(label(t));
  check(`${nm} 건수 일치(${api.length})`, api.length === dbRows.length, [api.length, dbRows.length]);
  const m = new Map(dbRows.map(r => [Number(r.id), r]));
  const bad = api.filter((a: any) => { const r = m.get(a.id); return !r || (a.deletedBy ?? null) !== (r.deleted_by ?? null) || (a.deletedByName ?? null) !== (r.label ?? null); });
  check(`${nm} 삭제자 전건 일치`, bad.length === 0, bad.slice(0, 2));
}
const prods = await list("products/trash"); const pdb = await all(label("products")); const pm = new Map(pdb.map(r => [Number(r.id), r]));
check(`상품 건수 일치(${prods.length})`, prods.length === pdb.length);
check("상품 삭제자 전건 일치", prods.every((a: any) => (a.deletedBy ?? null) === (pm.get(a.id)?.deleted_by ?? null) && (a.deletedByName ?? a.deletedByEmail ?? null) === (pm.get(a.id)?.label ?? null)));
const tr = await list("translators?includeInactive=true"); const trRows = Array.isArray(tr) ? tr : (tr.rows ?? []);
const trDb = (await one(sql`SELECT count(*)::int n FROM users WHERE role = 'translator' AND is_active = false AND deleted_at IS NULL`)).n;
check(`통번역사 비활성 건수 일치(${trDb})`, trRows.filter((r: any) => r.isActive === false).length === trDb);

console.log("\n[⑧⑨] 복원·완전삭제 후 감사로그");
const co = (await call("POST", "/admin/companies", { name: `${tag}감사로그` })).body; const cid = co.id ?? co.company?.id;
const logN = async (a: string) => (await one(sql`SELECT count(*)::int n FROM logs WHERE entity_type = 'company' AND entity_id = ${cid} AND action = ${a}`)).n;
check("⑧ 삭제", (await call("DELETE", `/admin/companies/${cid}`, { reason: "테스트 삭제" })).status === 200);
const d1 = await one(sql`SELECT deleted_by FROM companies WHERE id = ${cid}`);
check("⑧ deleted_by = 실제 처리자", d1.deleted_by === 10, d1);
const logD = await one(sql`SELECT performed_by FROM logs WHERE entity_type = 'company' AND entity_id = ${cid} AND action = 'deleted' ORDER BY id DESC LIMIT 1`);
check("⑧ 삭제 기록 = 감사로그 처리자", logD.performed_by === d1.deleted_by, logD);
check("⑧ 복원", (await call("POST", `/admin/companies/${cid}/restore`, { reason: "테스트 복원" })).status === 200);
check("⑧ 복원 후 삭제 표시 해제·감사로그 보존", (await one(sql`SELECT deleted_by FROM companies WHERE id = ${cid}`)).deleted_by === null && await logN("deleted") === 1 && await logN("restored") === 1);
await call("DELETE", `/admin/companies/${cid}`, { reason: "재삭제" });
const pg = await call("DELETE", `/admin/companies/${cid}/permanent`, { reason: "테스트 완전삭제" });
check("⑨ 완전삭제", pg.status === 200, pg);
check("⑨ 행 삭제·감사로그 보존", !(await one(sql`SELECT id FROM companies WHERE id = ${cid}`)) && await logN("deleted") === 2 && await logN("purged") === 1, [await logN("deleted"), await logN("purged")]);

console.log("\n[담당자] 삭제 감사로그 처리자");
const hostCo = (await one(sql`INSERT INTO companies (name) VALUES (${`${tag}담당자거래처`}) RETURNING id`)).id;
const ctId = (await one(sql`INSERT INTO contacts (company_id, name) VALUES (${hostCo}, ${`${tag}담당자`}) RETURNING id`)).id;
const del = await call("DELETE", `/admin/contacts/${ctId}`, { reason: "테스트 삭제" });
check("담당자 삭제", del.status === 200, del);
const ctRow = await one(sql`SELECT deleted_by FROM contacts WHERE id = ${ctId}`);
const ctLog = await one(sql`SELECT performed_by, performed_by_email, metadata FROM logs WHERE entity_type = 'company' AND entity_id = ${hostCo} AND action = 'company_contact_deleted' ORDER BY id DESC LIMIT 1`);
check("감사로그 처리자 ID = 실제 처리자", ctLog?.performed_by === 10, ctLog);
check("감사로그 처리자 이메일 기록", ctLog?.performed_by_email === "admin@test", ctLog);
check("감사로그 처리자 = 삭제 기록 deleted_by", ctLog?.performed_by === ctRow.deleted_by, [ctLog, ctRow]);
check("감사로그 대상 담당자·사유 유지", JSON.parse(ctLog.metadata).contactId === ctId && JSON.parse(ctLog.metadata).reason === "테스트 삭제", ctLog);
await db.execute(sql`DELETE FROM contacts WHERE id = ${ctId}`);

await db.execute(sql`DELETE FROM companies WHERE name LIKE ${tag + "%"}`);
await db.execute(sql`DELETE FROM users WHERE email LIKE ${tag + "%"}`);
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
