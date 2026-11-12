// 판매상세 A.기본정보 수정 검증 — 개발 DB 에 임시 fixture 를 만들고 HTTP 로 API 를 호출한 뒤 fixture 를 모두 삭제한다.
//   운영 DB 에서 실행하지 않는다(DATABASE_URL 이 개발 DB 일 때만).
// 검증: 수정·저장·재조회 유지 / 이 판매건만 vs Master 동시 수정 / 다른 판매건 불변 / 다른 거래처 담당자 거부 / 사유 필수 /
//       PM·견적서명·견적일 / 견적서 출력 API 값 / 수행·결제 정보 불변 / 감사 로그
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import express from "express";
import { signToken } from "./middlewares/auth";
import saleBasicInfoRouter from "./routes/saleBasicInfo";
import adminRouter from "./routes/admin";

// 검증에 필요한 라우터만 올린 최소 앱(app.ts 는 정적 파일 경로 등 배포 설정을 포함)
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.log = { error: (...a: unknown[]) => console.error(...a), warn: () => {}, info: () => {} }; next(); });
app.use("/api", saleBasicInfoRouter);
app.use("/api", adminRouter);

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await rows(q))[0];

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active AND NOT coalesce(must_change_password, false) LIMIT 1`);
  if (!admin) throw new Error("개발 DB 에 관리자 계정이 없습니다.");
  const token = signToken({ id: admin.id, email: admin.email, role: "admin" });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const tag = `__TEST_SBI_${Date.now()}`;
  const ids: Record<string, number> = {};
  try {
    // ── fixture: 코트라 사례 재현 — 거래처 이메일 = 다른 담당자(최혜민) 개인 이메일, 김민정 Master 이메일 공란 ──
    ids.co = (await one(sql`INSERT INTO companies (name, email) VALUES (${tag + "_코트라"}, 'hmchoi@kotra.example') RETURNING id`)).id;
    ids.coOther = (await one(sql`INSERT INTO companies (name) VALUES (${tag + "_다른거래처"}) RETURNING id`)).id;
    ids.kim = (await one(sql`INSERT INTO contacts (company_id, name, mobile) VALUES (${ids.co}, '김민정', '01041800400') RETURNING id`)).id;
    ids.choi = (await one(sql`INSERT INTO contacts (company_id, name, email, office_phone) VALUES (${ids.co}, '최혜민', 'hmchoi@kotra.example', '0234603277') RETURNING id`)).id;
    ids.otherC = (await one(sql`INSERT INTO contacts (company_id, name, email) VALUES (${ids.coOther}, '타거래처담당', 'x@other.example') RETURNING id`)).id;
    // 판매 1(수정 대상) — 이관 당시 거래처 이메일이 수신자 이메일로 고정된 상태
    ids.p1 = (await one(sql`INSERT INTO projects (user_id, title, status, company_id, contact_id, admin_id, contact_name_snapshot) VALUES (${admin.id}, '영어동시통역 외10', 'approved', ${ids.co}, ${ids.kim}, ${admin.id}, '김민정') RETURNING id`)).id;
    ids.q1 = (await one(sql`INSERT INTO quotes (project_id, price, status, title, issue_date, quote_number, customer_company_name, customer_contact_name, customer_contact_mobile, customer_contact_email)
      VALUES (${ids.p1}, 4446200, 'approved', '영어동시통역 외10', '2026-10-27', ${tag.slice(-12)}, ${tag + "_코트라"}, '김민정', '01041800400', 'hmchoi@kotra.example') RETURNING id`)).id;
    // 판매 2(같은 담당자를 쓰는 다른 판매, 고정값 없음 — Master 를 따라 출력되는 기존 견적)
    ids.p2 = (await one(sql`INSERT INTO projects (user_id, title, status, company_id, contact_id) VALUES (${admin.id}, '다른 판매', 'approved', ${ids.co}, ${ids.kim}) RETURNING id`)).id;
    ids.q2 = (await one(sql`INSERT INTO quotes (project_id, price, status, title, issue_date) VALUES (${ids.p2}, 1000, 'approved', '다른 판매', '2026-10-01') RETURNING id`)).id;
    // 판매 1의 결제·수행 정보(불변 확인용)
    ids.pay = (await one(sql`INSERT INTO project_payments (project_id, sequence, amount, deposit_status) VALUES (${ids.p1}, 1, 4446200, 'scheduled') RETURNING id`)).id;
    ids.perf = (await one(sql`INSERT INTO performance_assignments (project_id) VALUES (${ids.p1}) RETURNING id`)).id;
    const finSnap = async () => JSON.stringify([
      await rows(sql`SELECT * FROM project_payments WHERE project_id = ${ids.p1} ORDER BY id`),
      await rows(sql`SELECT * FROM performance_assignments WHERE project_id = ${ids.p1} ORDER BY id`),
      await rows(sql`SELECT * FROM settlements WHERE project_id = ${ids.p1} ORDER BY id`),
      await rows(sql`SELECT * FROM payments WHERE project_id = ${ids.p1} ORDER BY id`),
    ]);
    const fin0 = await finSnap();

    console.log("\n[1] 조회");
    let r = await call("GET", `/admin/sales/${ids.p1}/basic-info`);
    check("GET 200", r.status === 200, r.body);
    check("현재 표시 이메일 = 이관 당시 고정값(hmchoi)", r.body.current?.email === "hmchoi@kotra.example", r.body.current);
    check("이 판매건 ↔ Master 차이 표시(이메일)", (r.body.diffs ?? []).some((d: any) => d.field === "email"), r.body.diffs);
    check("담당자 목록 = 이 거래처 소속만", (r.body.contacts ?? []).every((c: any) => [ids.kim, ids.choi].includes(c.id)) && r.body.contacts.length === 2, r.body.contacts);

    console.log("\n[2] 검증 오류");
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { contactEmail: "minjeongkim@kotra.example" });
    check("수정 사유 없으면 400", r.status === 400, r.body);
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { contactId: ids.otherC, reason: "t" });
    check("다른 거래처 담당자 선택 거부(409)", r.status === 409, r.body);
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { contactEmail: "bad-email", reason: "t" });
    check("이메일 형식 오류 400", r.status === 400, r.body);

    console.log("\n[3] 이메일 — 이 판매건만 수정(기본)");
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { contactEmail: "minjeongkim@kotra.example", reason: "이관 오류 정정(거래처 대표 이메일)" });
    check("PATCH 200", r.status === 200, r.body);
    check("contactScope = sale_only, masterUpdated=false", r.body.contactScope === "sale_only" && r.body.masterUpdated === false, r.body);
    let q1 = await one(sql`SELECT customer_contact_email e, customer_contact_mobile m FROM quotes WHERE id = ${ids.q1}`);
    check("판매 1 견적 수신자 이메일 변경", q1.e === "minjeongkim@kotra.example", q1);
    let kim = await one(sql`SELECT email FROM contacts WHERE id = ${ids.kim}`);
    check("담당자 Master 이메일 불변(공란 유지)", kim.email == null, kim);
    r = await call("GET", `/admin/sales/${ids.p1}/basic-info`);
    check("재조회(새로고침) 시 수정값 유지", r.body.current?.email === "minjeongkim@kotra.example", r.body.current);
    let qd = await call("GET", `/admin/quotes/${ids.q1}`);
    check("견적서 출력 API(customerContactEmail) = 수정값", qd.body.customerSnapshotFixed === true && qd.body.customerContactEmail === "minjeongkim@kotra.example", { fixed: qd.body.customerSnapshotFixed, e: qd.body.customerContactEmail });
    let lg = await one(sql`SELECT metadata, performed_by_email FROM logs WHERE entity_type = 'project' AND entity_id = ${ids.p1} AND action = 'sale_basic_info_updated' ORDER BY id DESC LIMIT 1`);
    const m1 = JSON.parse(lg?.metadata ?? "{}");
    check("감사 로그: 변경 전후·사유·수정자·Master 여부", m1.changes?.[0]?.before === "hmchoi@kotra.example" && m1.changes?.[0]?.after === "minjeongkim@kotra.example"
      && m1.reason && lg.performed_by_email === admin.email && m1.masterUpdated === false, m1);

    console.log("\n[4] 휴대전화 — 판매건 + 담당자 Master 함께 수정(명시 선택)");
    const q2Before = (await call("GET", `/admin/quotes/${ids.q2}`)).body;
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { contactMobile: "010-4180-0400", contactEmail: "minjeongkim@kotra.example", applyToMaster: true, reason: "Master 보완" });
    check("PATCH 200", r.status === 200, r.body);
    kim = await one(sql`SELECT email, mobile FROM contacts WHERE id = ${ids.kim}`);
    check("담당자 Master 이메일·휴대전화 변경", kim.email === "minjeongkim@kotra.example" && kim.mobile === "010-4180-0400", kim);
    check("masterUpdated=true, contactScope=sale_and_master", r.body.masterUpdated === true && r.body.contactScope === "sale_and_master", r.body);
    const q2After = (await call("GET", `/admin/quotes/${ids.q2}`)).body;
    check("다른 판매건(판매 2) 견적서 출력 이메일 불변(고정 처리)", (q2After.customerContactEmail ?? null) === (q2Before.contactEmail ?? null) && q2After.customerSnapshotFixed === true,
      { before: q2Before.contactEmail, after: q2After.customerContactEmail, fixed: q2After.customerSnapshotFixed });
    const p2 = await one(sql`SELECT contact_id FROM projects WHERE id = ${ids.p2}`);
    check("다른 판매건 담당자 연결 불변", Number(p2.contact_id) === ids.kim, p2);
    const clog = await one(sql`SELECT metadata FROM logs WHERE entity_type = 'company' AND entity_id = ${ids.co} AND action = 'company_contact_updated' ORDER BY id DESC LIMIT 1`);
    check("Master 변경 감사 로그(거래처)", !!clog && JSON.parse(clog.metadata).via === "sale_basic_info", clog);

    console.log("\n[5] 담당자 변경 · PM · 견적서명 · 견적일");
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { contactId: ids.choi, title: "영어동시통역 외10(정정)", issueDate: "2026-10-28", adminId: null, reason: "담당자 교체 요청" });
    check("PATCH 200", r.status === 200, r.body);
    const p1 = await one(sql`SELECT contact_id, contact_name_snapshot, admin_id, title FROM projects WHERE id = ${ids.p1}`);
    q1 = await one(sql`SELECT customer_contact_name n, customer_contact_email e, customer_contact_phone ph, title, to_char(issue_date,'YYYY-MM-DD') d FROM quotes WHERE id = ${ids.q1}`);
    check("판매 담당자 = 최혜민(같은 거래처)", Number(p1.contact_id) === ids.choi && p1.contact_name_snapshot === "최혜민", p1);
    check("견적 수신자 = 새 담당자 Master 값", q1.n === "최혜민" && q1.e === "hmchoi@kotra.example" && q1.ph === "0234603277", q1);
    check("PM 해제·판매명·견적서명·견적일 반영", p1.admin_id == null && p1.title === "영어동시통역 외10(정정)" && q1.title === "영어동시통역 외10(정정)" && q1.d === "2026-10-28", { p1, q1 });
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { adminId: admin.id, reason: "PM 재지정" });
    check("PM 재지정", r.status === 200 && Number((await one(sql`SELECT admin_id FROM projects WHERE id = ${ids.p1}`)).admin_id) === admin.id, r.body);
    r = await call("PATCH", `/admin/sales/${ids.p1}/basic-info`, { title: "영어동시통역 외10(정정)", reason: "동일값" });
    check("변경 없는 저장은 400", r.status === 400, r.body);

    console.log("\n[6] 수행·지급·청구·수금·정산 정보 보존");
    check("project_payments / performance_assignments / settlements / payments 불변", (await finSnap()) === fin0);
    const hist = await call("GET", `/admin/sales/${ids.p1}/basic-info`);
    check("변경 이력 조회(4건)", (hist.body.history ?? []).length === 4, hist.body.history?.length);
  } finally {
    // fixture 정리(로그 포함)
    const pids = [ids.p1, ids.p2].filter(Boolean);
    if (pids.length) {
      await db.execute(sql`DELETE FROM logs WHERE (entity_type = 'project' AND entity_id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)}))
        OR (entity_type = 'quote' AND entity_id IN (${ids.q1 ?? 0}, ${ids.q2 ?? 0})) OR (entity_type = 'company' AND entity_id IN (${ids.co ?? 0}, ${ids.coOther ?? 0}))`);
      await db.execute(sql`DELETE FROM performance_assignments WHERE project_id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM project_payments WHERE project_id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM projects WHERE id IN (${sql.join(pids.map(i => sql`${i}`), sql`, `)})`);
    }
    if (ids.co) await db.execute(sql`DELETE FROM contacts WHERE company_id IN (${ids.co}, ${ids.coOther ?? 0})`);
    if (ids.co) await db.execute(sql`DELETE FROM companies WHERE id IN (${ids.co}, ${ids.coOther ?? 0})`);
    server.close();
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
