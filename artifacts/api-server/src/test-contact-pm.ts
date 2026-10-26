// @ts-nocheck — 격리 테스트(임시 복제 DB veritas_act_scratch + :8099). 고객담당자/담당PM 분리 검증.
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_act_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB 전용"); process.exit(1); }
const B = "http://localhost:8099/api";
const T = jwt.sign({ id: 10, email: "admin@test", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "20m" });
const call = async (m: string, p: string, b?: any) => { const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const one = async (s: any) => ((await db.execute(s)).rows as any[])[0];
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const NO_PROG = Number(process.env.NO_PROG), WITH_CUST = Number(process.env.WITH_CUST), EXISTING_PID = Number(process.env.EXISTING_PID);

async function activate(id: number) {
  const pv = (await call("GET", `/admin/legacy-archive/${id}/activation-preview`)).body;
  const a = await call("POST", `/admin/legacy-archive/${id}/activate`, { confirm: true, planToken: pv.planToken });
  return { pv, pid: a.body?.projectId, status: a.status };
}

async function main() {
  const contactsBefore = await one(sql`SELECT count(*)::int n, md5(string_agg(id||':'||name||':'||company_id, ',' ORDER BY id)) h FROM contacts`);

  // 1) 원본 고객명 없는 판매(영업담당자만) → 고객담당자 없음('-'), 담당PM=영업담당자(직원 매칭 시)
  const raw1 = await one(sql`SELECT source_raw->>'영업담당자' rep FROM legacy_archive_rows WHERE id=${NO_PROG}`);
  const r1 = await activate(NO_PROG);
  const p1 = await one(sql`SELECT contact_id, contact_name_snapshot, admin_id, (SELECT name FROM users WHERE id=admin_id) pm FROM projects WHERE id=${r1.pid}`);
  check("고객명 없는 판매: 미리보기 고객담당자 없음", r1.pv.contact.name === null, `영업담당자=${raw1.rep ? "있음" : "없음"}`);
  check("고객명 없는 판매: 전환 후 고객담당자 snapshot·ID 비어 있음", r1.status === 201 && p1.contact_name_snapshot === null && p1.contact_id === null);
  const staffMatch = await one(sql`SELECT count(*)::int n FROM users WHERE role IN ('admin','staff') AND deleted_at IS NULL AND replace(name,' ','')=replace(${raw1.rep ?? ""},' ','')`);
  check("담당PM: 영업담당자 = 내부 직원(단일 일치)일 때만 연결", staffMatch.n === 1 ? p1.pm?.replace(/\s/g, "") === String(raw1.rep).replace(/\s/g, "") : p1.admin_id === 10, `직원일치 ${staffMatch.n}`);
  const q1 = (await call("GET", `/admin/quotes/${(await one(sql`SELECT id FROM quotes WHERE project_id=${r1.pid}`)).id}`)).body;
  check("견적 상세/출력: 고객담당자 없음 · 담당PM 이름이 고객담당자로 나오지 않음", (q1.contactName ?? null) === null && q1.contactName !== raw1.rep, `contactName=${q1.contactName}`);
  const sh = (await call("GET", `/admin/sales-history?range=all&pageSize=50&search=${encodeURIComponent(r1.pv.company.name ?? "")}`)).body;
  const row = sh.rows.find(r => r.source === "current" && r.id === r1.pid);
  check("판매관리 목록: 고객담당자 '-'(null) · 담당PM 은 adminId 로 별도 · 과거 CRM 배지", row && row.contactName == null && row.origin === "legacy_crm" && row.adminId === p1.admin_id);

  // 2) 연결 진행행 고객명(단일) + 같은 거래처 소속 담당자 Master → 고객담당자 연결
  const r2 = await activate(WITH_CUST);
  const p2 = await one(sql`SELECT p.contact_id, p.contact_name_snapshot, p.company_id, k.company_id kc, k.name kn FROM projects p LEFT JOIN contacts k ON k.id=p.contact_id WHERE p.id=${r2.pid}`);
  check("고객명 있는 판매: 고객담당자 = 원본 고객명 · 해당 거래처 소속 Master 연결", r2.status === 201 && p2.contact_name_snapshot === r2.pv.contact.name && p2.contact_id != null && p2.kc === p2.company_id,
    `contact ${p2.contact_id} (company ${p2.kc}=${p2.company_id})`);
  check("고객담당자 ≠ 영업담당자(내부 직원)", r2.pv.contact.name !== r2.pv.pm.name);

  // 3) 기존 전환건(스타트업플렉스) — 승인 정정안(snapshot 제거)을 임시 DB 에서만 적용 후 표시 확인
  await db.execute(sql`UPDATE projects SET contact_name_snapshot = NULL WHERE id=${EXISTING_PID} AND contact_id IS NULL`);
  const d3 = (await call("GET", `/admin/projects/${EXISTING_PID}`)).body;
  const q3 = (await call("GET", `/admin/quotes/${d3.quotes[0].id}`)).body;
  const sh3 = (await call("GET", `/admin/sales-history?range=all&pageSize=50&search=${encodeURIComponent("스타트업플렉스")}`)).body;
  const row3 = sh3.rows.find(r => r.id === EXISTING_PID && r.source === "current");
  check("정정안 적용 시: 판매 상세·견적·목록 고객담당자 '-' · 담당PM 이상우 유지", d3.contact == null && d3.contactNameSnapshot == null && (q3.contactName ?? null) === null && row3 && row3.contactName == null && d3.adminId === 25);

  // 4) 신규 판매건(담당자 Master 지정) 표시
  const co = await one(sql`SELECT c.id, k.id kid, k.name kn FROM companies c JOIN contacts k ON k.company_id=c.id AND k.deleted_at IS NULL WHERE c.deleted_at IS NULL ORDER BY c.id LIMIT 1`);
  const [np] = (await db.execute(sql`INSERT INTO projects (user_id, title, status, company_id, contact_id, contact_name_snapshot, admin_id) VALUES (10, '신규 담당자 표시', 'approved', ${co.id}, ${co.kid}, ${co.kn}, 25) RETURNING id`)).rows as any[];
  await db.execute(sql`INSERT INTO quotes (project_id, quote_number, title, price, status, quote_type, issue_date) VALUES (${np.id}, 'TQ-CP-1', '신규 담당자 표시', 1000, 'approved', 'b2b_standard', '2031-01-05')`);
  const d4 = (await call("GET", `/admin/projects/${np.id}`)).body;
  const q4 = (await call("GET", `/admin/quotes/${d4.quotes[0].id}`)).body;
  check("신규 판매: 고객담당자 = 거래처 담당자 Master · 담당PM 별도", d4.contact?.name === co.kn && q4.contactName === co.kn && d4.adminId === 25);

  const contactsAfter = await one(sql`SELECT count(*)::int n, md5(string_agg(id||':'||name||':'||company_id, ',' ORDER BY id)) h FROM contacts`);
  check("담당자 Master 불변 · 중복 담당자 생성 없음", contactsAfter.n === contactsBefore.n && contactsAfter.h === contactsBefore.h);
  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("테스트 오류:", e); process.exit(1); });
