// @ts-nocheck — 격리 테스트 하네스(임시 복제 DB 의 API 서버 :8099 대상). 거래처·담당자 홈택스 최신화 핵심 검증.
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_sync_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB 에서만 실행합니다."); process.exit(1); }
const BASE = "http://localhost:8099/api"; const TOK = process.env.TOK;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const one = async (s: any) => ((await db.execute(s)).rows as any[])[0];
const state = () => one(sql`SELECT (SELECT count(*) FROM companies WHERE deleted_at IS NULL)::int companies, (SELECT count(*) FROM contacts WHERE deleted_at IS NULL)::int contacts,
  (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM companies WHERE deleted_at IS NULL) cids, (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM contacts WHERE deleted_at IS NULL) kids,
  (SELECT count(*) FROM projects)::int projects`);
async function post(path: string, buf: Buffer, extra: Record<string, string> = {}) {
  const fd = new FormData(); fd.append("file", new Blob([buf]), "hometax.xlsx"); for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Bearer ${TOK}` }, body: fd }); return { status: r.status, body: await r.json() };
}

async function main() {
  const S0 = await state();
  // 기존 거래처 200곳 × 담당자(기존) 각 1~2명으로 홈택스 형식 파일 구성
  const comps = (await db.execute(sql`SELECT c.id, c.name, c.business_number b, c.representative_name rep, c.industry ind, c.business_category cat, c.address addr FROM companies c
    WHERE c.deleted_at IS NULL AND c.business_number ~ '^[0-9-]{10,12}$' AND (SELECT count(*) FROM contacts k WHERE k.company_id=c.id AND k.deleted_at IS NULL AND k.is_active AND coalesce(k.email,'')<>'') >= 2
    ORDER BY c.id LIMIT 200`)).rows as any[];
  const conts = (await db.execute(sql`SELECT k.id, k.company_id cid, k.name, k.email, k.mobile, k.office_phone op, k.department dep, k.position pos FROM contacts k
    WHERE k.deleted_at IS NULL AND k.is_active AND coalesce(k.email,'')<>'' AND k.company_id = ANY(${sql.raw(`ARRAY[${comps.map(c => c.id).join(",")}]`)}) ORDER BY k.id`)).rows as any[];
  const H = ["거래처명", "사업자등록번호", "대표자명", "업태", "종목", "사업장주소", "담당자명", "이메일", "휴대전화번호", "부서명", "직책"];
  const rows: any[][] = [];
  const C = (c, over = {}) => ({ name: c.name, b: c.b, rep: c.rep, ind: c.ind, cat: c.cat, addr: c.addr, ...over });
  const R = (c, k) => [c.name, c.b, c.rep, c.ind, c.cat, c.addr, k?.name ?? null, k?.email ?? null, k?.mobile ?? null, k?.dep ?? null, k?.pos ?? null];
  comps.forEach((c, i) => {
    const ks = conts.filter(k => k.cid === c.id).slice(0, 2);
    let cc = C(c);
    if (i === 0 || i === 1) cc = C(c, { addr: `${c.addr ?? ""} 변경주소${i}` });            // 수정 2곳(모든 행 동일)
    ks.forEach((k, j) => {
      let row = cc;
      if (i === 2 && j === 1) row = C(c, { addr: "다른주소-행마다상이" });                    // 같은 거래처 행 값 상이 → 확인 필요
      let kk = k;
      if (i === 3 && j === 0) kk = { ...k, mobile: "010-9999-8888" };                         // 담당자 휴대폰 변경 → 정보 수정
      if (i === 4 && j === 0) kk = { ...k, dep: k.dep ? k.dep : "신규부서", pos: "팀장(변경)" }; // 부서·직책 변경
      rows.push(R(row, kk));
    });
    if (i === 5) rows.push(R(cc, null));                                                         // B. 거래처 정보만 있는 행
    if (i === 6) rows.push(R(cc, { name: null, email: "noname@example.com" }));                // A. 담당자 성명 없음
  });
  for (let n = 1; n <= 3; n++) {                                                                // 신규 거래처 3곳 + 담당자
    const nc = { name: `홈택스신규거래처${n}`, b: `999-88-0000${n}`, rep: "홍길동", ind: "서비스", cat: "번역", addr: "서울" };
    rows.push(R(nc, { name: `신규담당${n}`, email: `new${n}@hometax-test.kr`, mobile: `010-7777-000${n}` }));
  }
  rows.push(R({ name: "개인사업자테스트", b: "900101-1234567", rep: "김개인", ind: "", cat: "", addr: "" }, { name: "개인담당", email: "personal@hometax-test.kr" })); // 개인 식별번호 형태
  rows.push(R({ name: "연결불가거래처", b: "12345", rep: "", ind: "", cat: "", addr: "" }, { name: "연결불가담당", email: "nolink@hometax-test.kr" })); // 사업자번호 형식 오류 → 거래처 미생성 → D. 거래처 연결 불가
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sheet1"); ws.addRow(H); rows.forEach(r => ws.addRow(r.map(v => v == null || v === "" ? null : String(v))));
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  // ── 거래처 ──
  const a1 = await post("/admin/companies/bulk-import/analyze", buf);
  const u1 = a1.body.uniqueSummary;
  check("거래처 분석: 행이 아니라 고유 거래처 기준 집계", u1.uniqueTotal < a1.body.summary.total, JSON.stringify({ unique: u1.uniqueTotal, rows: a1.body.summary.total, counts: u1.counts }));
  check("거래처: 신규 3·수정 2(같은 값 여러 행은 1곳)·확인 필요 2(값 상이 1 + 개인번호 1)·제외 1(형식 오류)", u1.counts.new === 3 && u1.counts.update === 2 && u1.counts.review === 2 && u1.counts.excluded === 1, JSON.stringify(u1.counts));
  const pr = a1.body.rows.find(r => r.name === "개인사업자테스트");
  check("개인 식별번호: 사업자번호로 처리 안 함·마스킹·확인 필요", pr.status === "needs_review" && /\*{6}$/.test(pr.businessNumber) && !JSON.stringify(a1.body).includes("1234567"), `${pr.status} ${pr.businessNumber}`);
  const confl = a1.body.rows.filter(r => r.reason?.includes("값이 서로 다름"));
  check("같은 거래처 여러 행 값 상이 → 임의 선택 없이 확인 필요", confl.length >= 2 && confl.every(r => r.status === "needs_review"));
  let rj = await post("/admin/companies/bulk-import/execute", buf, { mode: "update" });
  check("승인 토큰 없이 실행 → 거부", rj.status === 409);
  const e1 = await post("/admin/companies/bulk-import/execute", buf, { mode: "update", planToken: a1.body.planToken });
  const S1 = await state();
  check("거래처 반영: 신규 3·수정 2만(확인 필요·제외 미반영)", e1.body.inserted === 3 && e1.body.updated === 2 && S1.companies === S0.companies + 3, JSON.stringify({ ins: e1.body.inserted, upd: e1.body.updated }));
  const a1b = await post("/admin/companies/bulk-import/analyze", buf);
  check("같은 파일 재분석: 신규 0·수정 0(중복 생성 없음)", a1b.body.uniqueSummary.counts.new === 0 && a1b.body.uniqueSummary.counts.update === 0, JSON.stringify(a1b.body.uniqueSummary.counts));

  // ── 담당자(반영된 거래처 ID 기준) ──
  const a2 = await post("/admin/contacts/bulk-import/analyze", buf);
  const u2 = a2.body.uniqueSummary;
  check("담당자: 신규 3·정보 수정 2·확인 필요 2(개인번호 C + 연결불가 D)", u2.counts.new === 3 && u2.counts.update === 2 && u2.counts.review === 2 && a2.body.rows.some(r => r.categoryReason === "D_company_link"), JSON.stringify(u2.counts));
  const upRows = a2.body.rows.filter(r => r.status === "update");
  check("담당자 정보 수정: 휴대폰·부서·직책 변경 전후 표시", upRows.some(r => r.changes?.mobile) && upRows.some(r => r.changes?.position), JSON.stringify(upRows.map(r => Object.keys(r.changes ?? {}))));
  check("오류 분류: A(성명 없음)·B(거래처 정보만) 제외", (u2.excludedReasons.A_no_name ?? 0) >= 1 && (u2.excludedReasons.B_company_only ?? 0) >= 1, JSON.stringify(u2.excludedReasons));
  const cRow = a2.body.rows.find(r => r.name === "개인담당");
  check("C. 개인 식별번호 행: 별도 확인 필요·마스킹", cRow.status === "needs_review" && cRow.categoryReason === "C_personal_id" && !JSON.stringify(a2.body).includes("1234567"));
  const e2 = await post("/admin/contacts/bulk-import/execute", buf, { mode: "update", planToken: a2.body.planToken });
  const S2 = await state();
  check("담당자 반영: 신규 3·수정 2·기존 담당자 ID 유지", e2.body.inserted === 3 && e2.body.updated === 2 && S2.contacts === S0.contacts + 3, JSON.stringify({ ins: e2.body.inserted, upd: e2.body.updated }));
  const ch = await one(sql`SELECT mobile FROM contacts WHERE id=${conts.find(k => k.cid === comps[3].id).id}`);
  check("휴대폰 변경 반영(기존 ID)", ch.mobile === "01099998888", ch.mobile);
  const a2b = await post("/admin/contacts/bulk-import/analyze", buf);
  check("담당자 같은 파일 재분석: 신규 0·수정 0", a2b.body.uniqueSummary.counts.new === 0 && a2b.body.uniqueSummary.counts.update === 0, JSON.stringify(a2b.body.uniqueSummary.counts));
  check("프로젝트 등 업무 연결 불변", S2.projects === S0.projects);

  // ── 되돌리기(담당자 → 거래처 순) ──
  const rb = async (id) => (await fetch(`${BASE}/admin/party-import/batches/${id}/rollback`, { method: "POST", headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) })).json();
  const r2 = await rb(e2.body.batchId); const r1 = await rb(e1.body.batchId);
  const S3 = await state();
  check("되돌리기: 거래처·담당자 유효 ID 집합 = 기준선", S3.cids === S0.cids && S3.kids === S0.kids, JSON.stringify({ r2: { s: r2.softDeleted, r: r2.restored }, r1: { s: r1.softDeleted, r: r1.restored } }));
  const chBack = await one(sql`SELECT mobile FROM contacts WHERE id=${conts.find(k => k.cid === comps[3].id).id}`);
  check("되돌리기: 변경된 휴대폰 원복", chBack.mobile === conts.find(k => k.cid === comps[3].id).mobile, `${chBack.mobile}`);
  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("테스트 오류:", e); process.exit(1); });
