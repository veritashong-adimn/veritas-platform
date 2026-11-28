// IBK 대량이체 「내통장인쇄내용」 표준 규칙 회귀 테스트(2026-11-28) — lib/ibkPrintName · CLAUDE.md '베리타스 은행이체 통장 인쇄내용 표준 규칙'
//   A. 규칙(순수 함수, DB 없음): 통대 학교 약칭·학교 판정 함정(학부 통번역학·일반대학원·서울외대⊃외대통대)·학교 상충·일반·미확인·해외·외주,
//      언어 약칭, 공통 문구·임의 특징 미부착, 10자 압축(부가정보 약칭→생략, 이름 최우선, 이름 초과 경고), 한글 무결성
//   B. 이체 파일(개발 DB · 로컬 API TEST_API, 기본 :8090): 통합 통번역사 = 통합 대표 명부 기준, 인쇄내용 외 열(은행·계좌·금액·받는분·CMS) 불변
//   이름은 모두 합성값. fixture 는 끝나면 삭제.
import { explainPayeePrintName, buildPayeePrintName, truncateForBankPrint, MAX_BANK_PRINT_LEN, type PrintNameInput } from "./lib/ibkPrintName";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: unknown = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✅" : "❌"} ${n}${ok ? "" : " — " + JSON.stringify(d)}`); };
const P = (o: Partial<PrintNameInput>): PrintNameInput => ({ payeeType: "individual", name: "가나다", languagePairs: "한국어, 영어", ...o });
const expect = (label: string, input: PrintNameInput, text: string, category?: string) => {
  const r = explainPayeePrintName(input);
  check(`${label} → ${text}${category ? ` (${category})` : ""}`, r.text === text && (!category || r.category === category), r);
  return r;
};

function partA() {
  console.log("\n[A1] 통번역대학원 학교 약칭(학력·전공·학력이력·특징 종합)");
  expect("학력 한국외국어대학교 통번역대학원", P({ education: "한국외국어대학교 통번역대학원" }), "가나다영어외대통대", "grad_school");
  expect("학력 이화여자대학교 통역번역대학원", P({ education: "이화여자대학교 통역번역대학원" }), "가나다영어이대통대", "grad_school");
  expect("학력 서울외국어대학원대학교 통번역대학원", P({ education: "서울외국어대학원대학교 통번역대학원" }), "가나다영어서울외대", "grad_school");
  expect("학력 중앙대학교 통번역대학원", P({ education: "중앙대학교 통번역대학원" }), "가나다영어중앙대", "grad_school");
  expect("학력 선문대학교 통번역대학원", P({ education: "선문대학교 통번역대학원" }), "가나다영어선문대", "grad_school");
  expect("학력 Middlebury Institute ... at Monterey", P({ education: "Middlebury Institute of International Studies at Monterey" }), "가나다영어몬트레이", "grad_school");
  expect("학력 Macquarie University - Translation & Interpreting", P({ education: "Macquarie University - Translation & Interpreting" }), "가나다영어맥쿼리", "grad_school");
  expect("학력 '통번역대학원'만 + 특징 '서울외대통대 11졸'", P({ languagePairs: "영어", education: "통번역대학원", bio: "서울외대통대 11졸/ 개인사업자" }), "가나다영어서울외대", "grad_school");
  expect("특징 '이대통대12졸'", P({ languagePairs: "영어", education: "통번역대학원", bio: "이대통대12졸" }), "가나다영어이대통대");
  expect("특징 '외대통대19졸'(서울외대 아님)", P({ languagePairs: "러시아어", education: "통번역대학원", bio: "외대통대19졸" }), "가나다노어외대통대");
  expect("특징 '서울외대통대13졸'(외대통대 아님)", P({ languagePairs: "영어", education: "통번역대학원", bio: "서울외대통대13졸" }), "가나다영어서울외대");
  expect("특징 '한국외대통대26수료'", P({ languagePairs: "영어", education: "통번역대학원", bio: "한국외대통대26수료" }), "가나다영어외대통대");
  expect("전공 '한국외대통대 영어'", P({ languagePairs: "영어", education: "통번역대학원", major: "한국외대통대 영어" }), "가나다영어외대통대");
  expect("학력 '석사' + 특징 '중대통대26년졸'", P({ education: "석사", major: "전문통역번역(한영)", bio: "중대통대26년졸" }), "가나다영어중앙대", "grad_school");
  expect("특징 '몬트레이통대졸/ 영어동시'", P({ languagePairs: "영어", education: "통번역대학원", bio: "몬트레이통대졸/ 영어동시" }), "가나다영어몬트레이");
  expect("특징 '선문대통대졸'", P({ languagePairs: "영어", education: "통번역대학원", bio: "선문대통대졸" }), "가나다영어선문대");
  expect("중앙대학교 국제대학원 + 전공 전문통번역학", P({ education: "중앙대학교 국제대학원", major: "전문통번역학" }), "가나다영어중앙대", "grad_school");
  expect("학력이력(JSON) 이화여자대학교 통역번역대학원", P({ educationHistory: JSON.stringify([{ school: "고려대학교", degree: "학사" }, { school: "이화여자대학교", graduateSchool: "통역번역대학원", degree: "석사" }]) }), "가나다영어이대통대", "grad_school");

  console.log("\n[A2] 일반 학부·일반대학원을 통대로 오분류하지 않음");
  expect("학부 '한국외국어대학교 영어통번역학 학사'", P({ education: "한국외국어대학교 영어통번역학 학사" }), "가나다영어일반", "general");
  expect("일반대학원 '한국외국어대학교 대학원 인도-아세안어문번역학과 수료'", P({ education: "한국외국어대학교 대학원 인도-아세안어문번역학과 마인번역학 수료" }), "가나다영어일반", "general");
  expect("'이화여대일반대학원 사회학석사'", P({ education: "이화여대일반대학원 사회학석사" }), "가나다영어일반", "general");
  expect("중앙대학교 국제대학원 + 비통번역 전공(특징의 '전문 통번역사' 무시)", P({ education: "중앙대학교 국제대학원", major: "국제관계학", bio: "전문 통번역사 (경력 5년 이상)" }), "가나다영어일반", "general");
  expect("Macquarie University(통번역 표시 없음) 학사", P({ education: "Macquarie University 학사" }), "가나다영어일반", "general");
  expect("이화여자대학교 영문학 석사", P({ education: "이화여자대학교 영문학 석사", major: "영문학" }), "가나다영어일반", "general");

  console.log("\n[A3] 학교 미확인·상충·학력 미확인(추정 금지)");
  expect("학력 '통번역대학원'만(학교 정보 없음)", P({ languagePairs: "영어", education: "통번역대학원" }), "가나다영어", "grad_unknown_school");
  const cf = expect("통대 2곳(외대통대·이대통대) 상충", P({ languagePairs: "영어", education: "통번역대학원", bio: "외대통대 석사, 이대통대 박사" }), "가나다영어", "grad_unknown_school");
  check("상충 경고 school_conflict · 후보 2곳", cf.warnings.includes("school_conflict") && cf.schoolCandidates.length === 2, cf);
  expect("학력 없음 · 특징 '귀화자'", P({ languagePairs: "캄보디아어", bio: "귀화자" }), "가나다캄보디아어", "unknown");
  expect("특징 '대학병원 통역 경험'만(학력 아님)", P({ bio: "대학병원 통역 경험 다수" }), "가나다영어", "unknown");
  expect("학력 '석사' + 러시아어 → 일반", P({ languagePairs: "러시아어", education: "석사", bio: "GMP,경희대 교육대석사,러시아 약학대학 학사" }), "가나다노어일반", "general");
  check("여러 전문 분야 중 임의 특징(GMP) 미부착", !buildPayeePrintName(P({ languagePairs: "러시아어", education: "석사", bio: "GMP, 제약" })).includes("GMP"));

  console.log("\n[A4] 언어 약칭(통장 인쇄 전용) · 공통 문구 제외");
  for (const [l, a] of [["러시아어", "노어"], ["프랑스어", "불어"], ["독일어", "독어"], ["스페인어", "서어"], ["포르투갈어", "포어"], ["대만어, 중국어", "중국어"], ["중국어, 대만어", "중국어"], ["대만어", "대만어"], ["캄보디아어", "캄보디아어"], ["중국어, 한국어", "중국어"], ["영어 통번역", "영어"]] as const)
    expect(`언어 '${l}'`, P({ languagePairs: l }), `가나다${a}`);
  const all = [P({ languagePairs: "영어", education: "통번역대학원" }), P({ education: "학사" }), P({ bio: "번역사" }), P({ languagePairs: "통역사, 영어" })].map(buildPayeePrintName);
  check("결과에 통번역·통역사·번역사 문구 없음", all.every(t => !/통번역|통역사|번역사/.test(t)), all);

  console.log("\n[A5] 해외 현지 인력 · 외주업체(기존 유지)");
  expect("해외(overseas_bank) 일본어 · Japan", P({ languagePairs: "일본어", paymentMethod: "overseas_bank", country: "Japan", education: "통번역대학원", bio: "외대통대" }), "가나다일본어일본", "overseas");
  expect("해외 러시아어 · 국가 원문", P({ languagePairs: "러시아어", paymentMethod: "overseas_paypal", country: "카자흐스탄" }), "가나다노어카자흐스탄", "overseas");
  const v = expect("외주업체 업체명 그대로", { payeeType: "vendor", name: "(주)사아자차카파트너스" }, "(주)사아자차카파트너스", "vendor");
  check("외주업체 파일 출력 = 괄호 제거 후 10자(기존과 같음)", truncateForBankPrint(v.text) === "사아자차카파트너스", truncateForBankPrint(v.text));

  console.log(`\n[A6] 10자 압축(기업은행 공식 제한 아님 · 내부 기준 ${MAX_BANK_PRINT_LEN}자) · 이름 최우선 · 단어 중간 절단 금지`);
  expect("5자 이름+노어+외대통대(11자) → 학교 짧은 약칭 '외대'", P({ name: "남궁가나다", languagePairs: "러시아어", education: "한국외국어대학교 통번역대학원" }), "남궁가나다노어외대");
  expect("5자 이름+영어+이대통대(11자) → '이대'", P({ name: "남궁가나다", languagePairs: "영어", education: "이화여자대학교 통역번역대학원" }), "남궁가나다영어이대");
  expect("6자 이름+영어+서울외대(12자) → 학교 생략", P({ name: "가나다라마바", languagePairs: "영어", education: "서울외국어대학원대학교 통번역대학원" }), "가나다라마바영어");
  expect("6자 이름+일본어+일반(11자) → 일반 생략", P({ name: "가나다라마바", languagePairs: "일본어", education: "박사" }), "가나다라마바일본어");
  expect("8자 이름+일본어(11자) → 이름만", P({ name: "가나다라마바사아", languagePairs: "일본어" }), "가나다라마바사아");
  const over = explainPayeePrintName(P({ name: "가나다라마바사아자차카", languagePairs: "영어" }));
  check("이름 자체 11자 → 10자 + 경고 name_over_limit", over.text === "가나다라마바사아자차" && over.warnings.includes("name_over_limit"), over);
  const samples = ["가나다", "남궁가나다", "가나다라마바사아자차카"].flatMap(n => ["러시아어", "영어", "포르투갈어"].map(l => buildPayeePrintName(P({ name: n, languagePairs: l, education: "한국외국어대학교 통번역대학원" }))));
  check(`모든 결과 ${MAX_BANK_PRINT_LEN}자 이하 · NFC · 한글 완성형만(깨짐 없음)`, samples.every(t => [...t].length <= MAX_BANK_PRINT_LEN && t === t.normalize("NFC") && !/[ᄀ-ᇿ㄰-㆏�]/.test(t) && !/[\uD800-\uDFFF]/.test(t.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))), samples);
  check("이름은 항상 맨 앞에 온전히(10자 이하일 때)", samples.filter(t => !t.startsWith("가나다라마바사아자차")).every(t => t.startsWith("가나다") || t.startsWith("남궁가나다")), samples);
}

async function partB() {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const XLSX = await import("xlsx");
  const { encrypt } = await import("./lib/encrypt");
  const { testSessionToken, cleanupTestSessions } = await import("./testing/sessionToken");
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL === process.env.PROD_DATABASE_URL || /neon\.tech/.test(process.env.DATABASE_URL)) { console.log("\n[B] 건너뜀 — 개발 DB 전용"); return; }
  const B = process.env.TEST_API ?? "http://localhost:8090/api";
  try { await fetch(B + "/health"); } catch { console.log(`\n[B] 건너뜀 — API(${B}) 미기동`); return; }
  const D = "2031-10-31", TAG = "[TEST-IBKP]", MAIL = "ibkp-%@test.local";
  const q = async (s: any) => (await db.execute(s)).rows as any[];
  const one = async (s: any) => (await q(s))[0];
  const ids = (a: number[]) => sql.join((a.length ? a : [-1]).map(i => sql`${i}`), sql`, `);
  const cleanup = async () => {
    const pids = (await q(sql`SELECT id FROM projects WHERE title LIKE ${TAG + "%"}`)).map(r => Number(r.id));
    const rids = (await q(sql`SELECT id FROM payout_rounds WHERE payment_date = ${D}`)).map(r => Number(r.id));
    const uids = (await q(sql`SELECT id FROM users WHERE email LIKE ${MAIL}`)).map(r => Number(r.id));
    const cids = (await q(sql`SELECT id FROM companies WHERE name LIKE ${"%" + TAG + "%"} OR name = '(주)사아자'`)).map(r => Number(r.id));
    await db.execute(sql`DELETE FROM payout_transfers WHERE payout_round_id IN (${ids(rids)})`);
    await db.execute(sql`DELETE FROM payout_round_items WHERE payout_round_id IN (${ids(rids)})`);
    await db.execute(sql`DELETE FROM performance_assignments WHERE project_id IN (${ids(pids)})`);
    await db.execute(sql`DELETE FROM payout_rounds WHERE id IN (${ids(rids)})`);
    await db.execute(sql`DELETE FROM projects WHERE id IN (${ids(pids)})`);
    await db.execute(sql`DELETE FROM translator_merges WHERE merged_master_id IN (${ids(uids)})`);
    await db.execute(sql`DELETE FROM translator_profiles WHERE user_id IN (${ids(uids)})`);
    await db.execute(sql`DELETE FROM translator_sensitive WHERE translator_id IN (${ids(uids)})`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${ids(uids)})`);
    await db.execute(sql`DELETE FROM company_sensitive WHERE company_id IN (${ids(cids)})`);
    await db.execute(sql`DELETE FROM companies WHERE id IN (${ids(cids)})`);
  };
  try {
    await cleanup();
    console.log("\n[B] IBK 대량이체 파일 — 인쇄내용 표준 규칙 적용 · 다른 열 불변 · 통합 대표 명부 기준");
    const admin = await one(sql`SELECT id FROM users WHERE role = 'admin' AND role_id IS NULL AND deleted_at IS NULL AND is_active LIMIT 1`);
    const H = { Authorization: `Bearer ${await testSessionToken(db, Number(admin.id))}`, "Content-Type": "application/json" };
    const call = async (m: string, p: string, b?: unknown) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
      const ct = r.headers.get("content-type") ?? ""; return ct.includes("json") ? { status: r.status, data: await r.json() as any, buf: null } : { status: r.status, data: null, buf: Buffer.from(await r.arrayBuffer()) }; };
    const mkU = async (name: string, acct: string | null, prof: Record<string, string | null> | null, rrn: string) => {
      const u = await one(sql`INSERT INTO users (email, name, role, is_active) VALUES (${`ibkp-${Math.random().toString(36).slice(2, 10)}@test.local`}, ${name}, 'translator', true) RETURNING id`);
      await db.execute(sql`INSERT INTO translator_sensitive (translator_id, resident_number, payment_method, bank_name, bank_account_enc, account_holder) VALUES (${u.id}, ${encrypt(rrn)}, 'domestic_withholding', '기업은행', ${acct ? encrypt(acct) : null}, ${name})`);
      if (prof) await db.execute(sql`INSERT INTO translator_profiles (user_id, language_pairs, education, major, bio) VALUES (${u.id}, ${prof.lang}, ${prof.edu}, ${prof.major}, ${prof.bio})`);
      return Number(u.id); };
    // 일반: 학력 '통번역대학원' + 특징 '서울외대통대' → 가나다영어서울외대
    const T1 = await mkU("가나다", "11100022233", { lang: "영어", edu: "통번역대학원", major: null, bio: "서울외대통대 11졸" }, "8001011000001");
    // 통합: 대표 명부(라마바 — 러시아어·한국외대 통대) ← 통합된 명부(옛 계정, 명부 정보 없음·계좌 보유). 수행정보는 옛 계정에 연결
    const R = await mkU("라마바", null, { lang: "러시아어", edu: "한국외국어대학교 통번역대학원", major: null, bio: null }, "8102022000002");
    const M = await mkU("라마바", "22200033344", { lang: "영어", edu: null, major: null, bio: null }, "8102022000002");
    await db.execute(sql`INSERT INTO translator_merges (merged_master_id, representative_master_id, same_person_confirmed, status) VALUES (${M}, ${R}, true, 'active')`);
    const vendor = await one(sql`INSERT INTO companies (name, is_vendor, company_type, business_number) VALUES ('(주)사아자', true, 'vendor', '1112223334') RETURNING id`);
    await db.execute(sql`INSERT INTO company_sensitive (company_id, bank_name, bank_account_enc, account_holder) VALUES (${vendor.id}, '기업은행', ${encrypt("33300044455")}, '(주)사아자')`);
    const co = await one(sql`INSERT INTO companies (name) VALUES (${TAG + "거래처"}) RETURNING id`);
    const pj = await one(sql`INSERT INTO projects (user_id, title, company_id, company_name_snapshot) VALUES (${admin.id}, ${TAG + "판매"}, ${co.id}, ${TAG + "거래처"}) RETURNING id`);
    const mkPa = async (seq: number, cat: string, uid: number | null, vid: number | null, name: string, rrn: string | null, cost: number) => db.execute(sql`INSERT INTO performance_assignments
        (project_id, sequence, performer_category, cost_type, payee_type, individual_user_id, vendor_company_id, performer_name_snapshot, identifier_snapshot_enc, identifier_snapshot_masked,
         status, service_type, product_name_snapshot, delivery_date, delivery_confirmed, expected_payment_date, withholding_treatment, residency_type, purchase_evidence_type,
         is_direct_amount, direct_amount, base_performance_fee, cost_total, payment_status, line_category)
      VALUES (${pj.id}, ${seq}, ${cat}, ${cat}, ${cat}, ${uid}, ${vid}, ${name}, ${rrn ? encrypt(rrn) : null}, ${rrn ? rrn.slice(0, 6) + "-*******" : "1112223334"}, 'completed', 'interpretation', '통역', '2031-10-10', true, ${D},
        ${cat === "individual" ? "domestic_3_3" : null}, ${cat === "individual" ? "domestic_resident" : null}, ${cat === "vendor" ? "tax_invoice" : null}, true, ${cost}, ${cost}, ${cost}, 'unpaid', '통번역사')`);
    await mkPa(1, "individual", T1, null, "가나다", "8001011000001", 100000);
    await mkPa(2, "individual", M, null, "라마바", "8102022000002", 200000);
    await mkPa(3, "vendor", null, Number(vendor.id), "(주)사아자", null, 300000);
    const c = await call("POST", "/admin/payout-rounds", { paymentDate: D, periodStart: D, periodEnd: D });
    const rid = Number(c.data?.round?.id);
    const cf = await call("PATCH", `/admin/payout-rounds/${rid}/confirm`, {});
    await call("POST", `/admin/payout-rounds/${rid}/transfers/generate`);
    const tr = await q(sql`SELECT payee_key, payee_name, bank_name_snapshot, amount FROM payout_transfers WHERE payout_round_id = ${rid} ORDER BY payee_key`);
    const f = await call("POST", `/admin/payout-rounds/${rid}/transfers/ibk-file`);
    check("회차 확정 · 송금건 3 · 파일 200", c.status === 201 && cf.status === 200 && tr.length === 3 && f.status === 200, { c: c.status, cf: cf.status, tr: tr.length, f: f.status, e: f.data?.error });
    const rows = f.buf ? (XLSX.utils.sheet_to_json(XLSX.read(f.buf).Sheets[XLSX.read(f.buf).SheetNames[0]], { header: 1 }) as any[][]) : [];
    const header = rows[0] ?? [], data = rows.slice(1);
    const byAcct = new Map(data.map(r => [String(r[1]), r]));
    check("헤더(양식) 불변", JSON.stringify(header) === JSON.stringify(["입금은행", "입금계좌번호", "이체금액", "내통장인쇄내용", "받는분통장인쇄내용", "CMS코드"]), header);
    check("통번역사: 학력 '통번역대학원' + 특징 서울외대통대 → '가나다영어서울외대'", byAcct.get("11100022233")?.[3] === "가나다영어서울외대", byAcct.get("11100022233"));
    check("통합 통번역사: 대표 명부(러시아어·외대통대) 기준 → '라마바노어외대통대'", byAcct.get("22200033344")?.[3] === "라마바노어외대통대", byAcct.get("22200033344"));
    check("외주업체: 업체명(괄호 제거) → '사아자'", byAcct.get("33300044455")?.[3] === "사아자", byAcct.get("33300044455"));
    const amt = new Map(tr.map(t => [t.payee_name, Math.round(Number(t.amount))]));
    check("인쇄내용 외 열 불변: 은행·금액(송금건 스냅샷)·받는분 '(주)베리타스'·CMS 공란", data.length === 3 && data.every(r => r[0] === "기업은행" && r[4] === "(주)베리타스" && (r[5] ?? "") === "")
      && byAcct.get("11100022233")?.[2] === amt.get("가나다") && byAcct.get("22200033344")?.[2] === amt.get("라마바") && byAcct.get("33300044455")?.[2] === amt.get("(주)사아자"), { data, amt: [...amt] });
    check("지급대상 이름(송금건 스냅샷) 불변 · 인쇄내용은 저장하지 않음", tr.map(t => t.payee_name).sort().join() === ["(주)사아자", "가나다", "라마바"].sort().join(), tr);
  } finally {
    await cleanup(); await cleanupTestSessions(db);
    const left = await one(sql`SELECT (SELECT count(*) FROM users WHERE email LIKE ${MAIL})::int u, (SELECT count(*) FROM payout_rounds WHERE payment_date = ${D})::int r`);
    console.log(`  정리 완료 — 남은 테스트 데이터: 통번역사 ${left.u} · 회차 ${left.r}`);
  }
}

(async () => {
  try { partA(); await partB(); } catch (e) { fail++; console.error(e); }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`); process.exit(fail ? 1 : 0);
})();
