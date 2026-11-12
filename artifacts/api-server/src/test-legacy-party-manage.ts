// 판매관리 '미연결 관리' API 검증 — 개발 DB 전용. 임시 fixture 를 만들고 HTTP 로 호출한 뒤 모두 삭제한다.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import express from "express";
import type { AddressInfo } from "node:net";
import { signToken } from "./middlewares/auth";
import manageRouter from "./routes/legacyPartyManage";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await rows(q))[0];

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const [admin] = await rows(sql`SELECT id, email FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active AND NOT coalesce(must_change_password, false) LIMIT 1`);
  const app = express(); app.use(express.json());
  app.use((req: any, _r, next) => { req.log = { error: (...a: unknown[]) => console.error(...a), warn: () => {}, info: () => {} }; next(); });
  app.use("/api", manageRouter);
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const token = signToken({ id: admin.id, email: admin.email, role: "admin" });
  const call = async (method: string, p: string, body?: unknown) => { const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const tag = `__TLM${Date.now() % 1e8}`; const T = (s: string) => `${tag}${s}`;
  const made = { companies: [] as number[], legacy: [] as number[], saleNos: [] as string[], projects: [] as number[] };
  let seq = 0;
  const company = async (name: string, o: any = {}) => { const [c] = await rows(sql`INSERT INTO companies (name, customer_type, mobile, business_number) VALUES (${name}, ${o.type ?? "CORPORATE"}, ${o.mobile ?? null}, ${o.brn ?? null}) RETURNING id`); made.companies.push(Number(c.id)); return Number(c.id); };
  const contact = async (coId: number, name: string, mobile: string) => Number((await one(sql`INSERT INTO contacts (company_id, name, mobile) VALUES (${coId}, ${name}, ${mobile}) RETURNING id`)).id);
  const sale = async (key: string, raw: string, cust: string | null, tel: string | null, date = "2026-11-01") => {
    const saleNo = `${date}-${tag}${key}`; const fh = `${tag}_${++seq}`; const total = 220000 + seq;
    const [s] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
      VALUES ('sales_list', ${fh}, 'S', 1, ${raw}, '한영번역', ${total}, ${JSON.stringify({ "판매번호": saleNo, "거래처명": raw, "상품명": "한영번역", "총액": String(total), "영업담당자": "테스트PM" })}::jsonb, ${fh}) RETURNING id`);
    const [p] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
      VALUES ('progress', ${fh}, 'P', 1, ${raw}, '한영번역', ${total}, ${JSON.stringify({ "거래처명": raw, "상품명": "한영번역", "총액": String(total), "고객명": cust, "연락처": tel, "내용": "번역", "체결일": date })}::jsonb, ${fh + "p"}) RETURNING id`);
    made.legacy.push(Number(s.id), Number(p.id)); made.saleNos.push(saleNo);
    await db.execute(sql`INSERT INTO legacy_sales_progress_links (sale_row_id, progress_row_id, sale_no, match_key, match_method, decision) VALUES (${s.id}, ${p.id}, ${saleNo}, 'test', 'test', 'confirmed')`);
    return saleNo;
  };
  const guard = async () => JSON.stringify(await one(sql`SELECT (SELECT md5(string_agg(id||':'||price||status, ',' ORDER BY id)) FROM quotes) q,
    (SELECT md5(string_agg(id||':'||quantity||unit_price||supply_amount||total_amount, ',' ORDER BY id)) FROM quote_items) qi,
    (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM project_payments t) pp, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM settlements t) st,
    (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM performance_assignments t) pa, (SELECT md5(string_agg(id||':'||row_hash, ',' ORDER BY id)) FROM legacy_archive_rows WHERE NOT (file_hash LIKE ${tag + "%"})) lg`));
  try {
    const coA = await company(T("병원"));               // 기존 거래처(원본 표기 '…병원 서울'과 이름만 비슷)
    const hongA = await contact(coA, "홍길동", "01011112222");
    const coB = await company(T("다른회사"), { brn: "999-99-12345" });
    const hongB = await contact(coB, "홍길동", "01099998888");   // 다른 거래처 동명이인
    const coInd = await company(T("최유리"), { type: "INDIVIDUAL", mobile: "01055556666" });
    const S1 = await sale("S1", T("병원 서울"), "홍길동", "010-1111-2222", "2026-11-02");
    const S2 = await sale("S2", T("병원 서울"), "홍길동", "010-1111-2222", "2026-11-03");
    const S3 = await sale("S3", T("미등록상사"), "박서준", "010-3333-4444");
    const S4 = await sale("S4", `개인고객(${T("최유리")})`, T("최유리"), "010-5555-6666");
    const S6 = await sale("S6", T("병원"), "김철수", "010-7777-8888");   // 기존 거래처로 인식 + 다른 담당자 연결
    const kim = await contact(coA, "김철수", "01077778888");
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status) VALUES ('old_crm', 'sale_contact', ${S6}, ${kim}, 'manual', 'active')`);
    // 운영 전환 판매(거래처 비어 있음)
    const S5 = await sale("S5", T("전환상사"), "이영희", "010-9999-0000");
    const [pj] = await rows(sql`INSERT INTO projects (user_id, title, status) VALUES (${admin.id}, '전환 테스트', 'approved') RETURNING id`); made.projects.push(Number(pj.id));
    await db.execute(sql`INSERT INTO quotes (project_id, price, status, title, issue_date) VALUES (${pj.id}, 110000, 'approved', '전환 테스트', '2026-11-01')`);
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status) VALUES ('old_crm', 'sale', ${S5}, ${pj.id}, 'activation', 'active')`);
    const g0 = await guard();

    console.log("\n[1] 집계·검색·페이지네이션");
    let r = await call("GET", "/admin/legacy-party/summary?refresh=1");
    check("summary 200 · 상태별 건수", r.status === 200 && typeof r.body.legacyByStatus?.company_missing === "number", r.body);
    r = await call("GET", `/admin/legacy-party/list?status=unlinked&company=${encodeURIComponent(tag)}&pageSize=20`);
    const st = new Map((r.body.rows ?? []).map((x: any) => [x.saleNo, x]));
    check("검색(거래처명) — fixture 미연결 판매", st.has(S1) && st.has(S2) && st.has(S3) && st.has(S4) && st.has(S5) && !st.has(S6), [...st.keys()]);
    check("상태: S1 거래처 미등록 · S4 개인고객 확인 · S5 운영전환 미등록", (st.get(S1) as any)?.status === "company_missing" && (st.get(S4) as any)?.status === "individual_review" && (st.get(S5) as any)?.source === "current", [...st.values()].map((x: any) => [x.saleNo, x.status]));
    check("같은 표기 건수 표시(S1·S2 = 2)", (st.get(S1) as any)?.sameRawCount === 2);
    r = await call("GET", `/admin/legacy-party/list?status=&phone=01033334444&company=${encodeURIComponent(tag)}`);
    check("검색(전화번호) → S3", r.body.rows?.length === 1 && r.body.rows[0].saleNo === S3, r.body.rows?.map((x: any) => x.saleNo));
    r = await call("GET", `/admin/legacy-party/list?status=&saleNo=${encodeURIComponent(tag + "S6")}`);
    check("검색(판매번호) → S6 연결 완료", r.body.rows?.length === 1 && r.body.rows[0].status === "linked", r.body.rows);
    r = await call("GET", `/admin/legacy-party/list?status=&company=${encodeURIComponent(tag)}&from=2026-11-02&to=2026-11-03`);
    check("기간 필터 → S1·S2", r.body.rows?.length === 2, r.body.rows?.map((x: any) => x.saleNo));
    r = await call("GET", `/admin/legacy-party/list?status=&company=${encodeURIComponent(tag)}&pageSize=20&page=1`);
    check("페이지네이션 정보", r.body.pagination?.pageSize === 20 && r.body.pagination?.total >= 6, r.body.pagination);

    console.log("\n[2] 거래처 연결(단건·같은 표기 일괄·운영 전환·충돌)");
    r = await call("POST", "/admin/legacy-party/link-company", { companyId: coA, saleNos: [S1] });
    check("S1 연결 → 같은 표기 S2 도 함께(별칭)", r.status === 200 && r.body.success === 1 && r.body.results[0].affectedSaleNos?.includes(S2), r.body);
    r = await call("POST", "/admin/legacy-party/link-company", { companyId: coA, saleNos: [S1, S2] });
    check("재실행 — 중복 생성 없음(already)", r.body.success === 2 && r.body.results.every((x: any) => x.result === "already"), r.body);
    check("별칭 1개만", Number((await one(sql`SELECT count(*) n FROM company_aliases WHERE company_id = ${coA} AND alias_name = ${T("병원 서울")}`)).n) === 1);
    r = await call("POST", "/admin/legacy-party/link-company", { companyId: coB, saleNos: [S6, `${tag}-없음`] });
    check("이미 다른 거래처로 인식된 판매·없는 판매 → 실패(기존 연결 변경 없음)", r.body.success === 0 && r.body.failed === 2, r.body);
    r = await call("POST", "/admin/legacy-party/link-company", { companyId: coA, saleNos: [S5] });
    const pj2 = await one(sql`SELECT company_id, contact_id FROM projects WHERE id = ${pj.id}`);
    check("운영 전환 판매 → projects.company_id 만", r.body.results?.[0]?.result === "linked_project" && Number(pj2.company_id) === coA && pj2.contact_id == null, { r: r.body, pj2 });
    r = await call("POST", "/admin/legacy-party/link-company", { companyId: coB, saleNos: [S5] });
    check("운영 전환 판매 재연결 시도 → 실패(덮어쓰기 없음)", r.body.failed === 1, r.body);

    console.log("\n[3] 신규 거래처·개인고객 등록");
    r = await call("POST", "/admin/legacy-party/create-company", { name: T("다른회사"), saleNos: [S3] });
    check("같은 이름 거래처 → 409 POSSIBLE_DUPLICATE", r.status === 409 && r.body.code === "POSSIBLE_DUPLICATE", r.body);
    r = await call("POST", "/admin/legacy-party/create-company", { name: T("미등록상사"), businessNumber: "999-99-12345", saleNos: [S3] });
    check("같은 사업자번호 → 409 BRN_EXISTS", r.status === 409 && r.body.code === "BRN_EXISTS", r.body);
    r = await call("POST", "/admin/legacy-party/create-company", { name: T("미등록상사"), saleNos: [S3] });
    if (r.body.companyId) made.companies.push(Number(r.body.companyId));
    check("신규 등록 후 연결", r.status === 201 && r.body.success === 1, r.body);
    r = await call("POST", "/admin/legacy-party/create-company", { name: T("미등록상사"), saleNos: [S3] });
    check("같은 거래처 재등록 시도 → 409(중복 생성 방지)", r.status === 409, r.body);
    r = await call("POST", "/admin/legacy-party/link-company", { companyId: coInd, saleNos: [S4] });
    check("개인고객 표기 → 기존 개인고객 연결", r.body.success === 1, r.body);

    console.log("\n[4] 담당자 연결(일괄·동명이인·기존 연결 보호)");
    r = await call("GET", `/admin/legacy-party/company-contacts?companyId=${coA}&names=${encodeURIComponent("홍길동")}`);
    check("다른 거래처 동명이인 경고", (r.body.otherCompanySameName ?? []).some((c: any) => c.id === hongB), r.body.otherCompanySameName);
    r = await call("POST", "/admin/legacy-party/link-contact", { contactId: hongA, saleNos: [S1, S2, S6, `${tag}-없음`] });
    check("일괄: S1·S2 성공, S6(기존 담당자)·없는 판매 실패(보류)", r.body.success === 2 && r.body.failed === 2 && r.body.results.find((x: any) => x.saleNo === S6)?.ok === false, r.body);
    check("S6 기존 담당자 유지", Number((await one(sql`SELECT entity_id FROM legacy_master_mappings WHERE entity_type='sale_contact' AND legacy_id = ${S6}`)).entity_id) === kim);
    r = await call("POST", "/admin/legacy-party/link-contact", { contactId: hongA, saleNos: [S1, S2] });
    check("재실행 — already", r.body.success === 2 && r.body.results.every((x: any) => x.result === "already"), r.body);
    r = await call("POST", "/admin/legacy-party/link-contact", { contactId: hongB, saleNos: [S3] });
    check("다른 거래처 담당자 → 실패", r.body.failed === 1, r.body);
    r = await call("GET", `/admin/legacy-party/list?status=&company=${encodeURIComponent(tag)}&refresh=1`);
    const st2 = new Map((r.body.rows ?? []).map((x: any) => [x.saleNo, x]));
    check("연결 후 S1·S2 연결 완료(이름+연락처 일치)", (st2.get(S1) as any)?.status === "linked" && (st2.get(S2) as any)?.contact?.check === "verified", [...st2.values()].map((x: any) => [x.saleNo, x.status]));

    console.log("\n[5] 감사로그·데이터 보호");
    check("감사로그(거래처 연결·담당자 연결)", Number((await one(sql`SELECT count(*) n FROM logs WHERE action IN ('legacy_sale_company_linked','legacy_sale_contact_linked') AND (entity_id = ${coA} OR entity_id = ${pj.id} OR metadata LIKE ${"%" + tag + "%"})`)).n) >= 3);
    check("견적·품목·청구·정산·수행·과거 CRM 원본 불변", (await guard()) === g0);
    check("기존 담당자 값 불변", JSON.stringify(await rows(sql`SELECT id, name, mobile, email FROM contacts WHERE id IN (${hongA}, ${hongB}, ${kim}) ORDER BY id`)) === JSON.stringify([{ id: hongA, name: "홍길동", mobile: "01011112222", email: null }, { id: hongB, name: "홍길동", mobile: "01099998888", email: null }, { id: kim, name: "김철수", mobile: "01077778888", email: null }]));
  } finally {
    const sn = made.saleNos;
    if (sn.length) {
      await db.execute(sql`DELETE FROM legacy_master_mappings WHERE legacy_id IN (${sql.join(sn.map(s => sql`${s}`), sql`, `)})`);
      await db.execute(sql`DELETE FROM import_row_sources WHERE module = 'legacy_party_link' AND legacy_id IN (${sql.join(sn.map(s => sql`${s}`), sql`, `)})`);
    }
    await db.execute(sql`DELETE FROM import_batches b WHERE b.module = 'legacy_party_link' AND b.import_type LIKE 'manual_%' AND NOT EXISTS (SELECT 1 FROM import_row_sources r WHERE r.batch_id = b.id) AND b.created_at > now() - interval '1 hour'`);
    if (made.projects.length) { const pl = sql.join(made.projects.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM logs WHERE entity_type = 'project' AND entity_id IN (${pl})`); await db.execute(sql`DELETE FROM quotes WHERE project_id IN (${pl})`); await db.execute(sql`DELETE FROM projects WHERE id IN (${pl})`); }
    if (made.legacy.length) { const ll = sql.join(made.legacy.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM legacy_sales_progress_links WHERE sale_row_id IN (${ll}) OR progress_row_id IN (${ll})`); await db.execute(sql`DELETE FROM legacy_archive_rows WHERE id IN (${ll})`); }
    if (made.companies.length) { const cl = sql.join(made.companies.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM logs WHERE entity_type = 'company' AND entity_id IN (${cl})`);
      await db.execute(sql`DELETE FROM company_aliases WHERE company_id IN (${cl})`); await db.execute(sql`DELETE FROM contacts WHERE company_id IN (${cl})`); await db.execute(sql`DELETE FROM companies WHERE id IN (${cl})`); }
    const left = await one(sql`SELECT (SELECT count(*) FROM companies WHERE name LIKE ${tag + "%"}) a, (SELECT count(*) FROM legacy_archive_rows WHERE file_hash LIKE ${tag + "%"}) b`);
    check("fixture 정리 완료", Number(left.a) === 0 && Number(left.b) === 0, left);
    server.close();
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
