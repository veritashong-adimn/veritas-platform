// 과거 CRM 거래처·담당자 공통 연결 규칙 검증 — 개발 DB 전용. 임시 fixture 를 만들고 끝나면 모두 삭제한다.
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { planPartyLinks, applyPartyLinks, rollbackPartyLinks, individualNameOf } from "./services/legacyPartyLink";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } };
const rows = async (q: any) => (await db.execute(q)).rows as any[];
const one = async (q: any) => (await rows(q))[0];

async function main() {
  if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) throw new Error("운영 DB 로 보이는 연결에서는 실행하지 않습니다.");
  const tag = `__TPL${Date.now() % 1e8}`;
  const made = { companies: [] as number[], legacy: [] as number[], saleNos: [] as string[], batches: [] as number[] };
  const T = (s: string) => `${tag}${s}`;
  const dom = `t${tag.replace(/\D/g, "")}.kr`;   // 이메일 도메인(밑줄 없는 형식)

  console.log("\n[0] 개인고객 표기 해석");
  check("'고제이슨(개인고객)' → 고제이슨", individualNameOf("고제이슨(개인고객)") === "고제이슨");
  check("'개인고객(오은숙)' → 오은숙", individualNameOf("개인고객(오은숙)") === "오은숙");
  check("'개인 (이동일고객님)' → 이동일", individualNameOf("개인 (이동일고객님)") === "이동일");
  check("'개인고객' 단독·'개인정보연구원' → 해석 안 함", individualNameOf("개인고객") === null && individualNameOf("개인정보연구원") === null);

  const company = async (name: string, o: { type?: string; phone?: string; email?: string; mobile?: string } = {}) => {
    const [c] = await rows(sql`INSERT INTO companies (name, customer_type, phone, mobile, email) VALUES (${name}, ${o.type ?? "CORPORATE"}, ${o.phone ?? null}, ${o.mobile ?? null}, ${o.email ?? null}) RETURNING id`);
    made.companies.push(Number(c.id)); return Number(c.id);
  };
  const contact = async (companyId: number, name: string, o: { phone?: string; mobile?: string; office?: string; email?: string } = {}) =>
    Number((await one(sql`INSERT INTO contacts (company_id, name, phone, mobile, office_phone, email) VALUES (${companyId}, ${name}, ${o.phone ?? null}, ${o.mobile ?? null}, ${o.office ?? null}, ${o.email ?? null}) RETURNING id`)).id);
  let seq = 0;
  // 과거 CRM 판매 1건 + 진행행 1건(고객명·연락처·비고) + 확정 연결
  const sale = async (key: string, companyName: string, cust: string, tel: string | null, memo: string | null = null) => {
    const saleNo = `${tag}-${key}`; const fh = `${tag}_${++seq}`;
    const total = 110000 + seq;   // 연결키가 판매마다 달라지도록
    const [s] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
      VALUES ('sales_list', ${fh}, 'S', 1, ${companyName}, '한영번역', ${total}, ${JSON.stringify({ "판매번호": saleNo, "거래처명": companyName, "상품명": "한영번역", "총액": String(total), "영업담당자": "테스트PM" })}::jsonb, ${fh}) RETURNING id`);
    const [p] = await rows(sql`INSERT INTO legacy_archive_rows (source_type, file_hash, source_sheet, source_row, company_name, product_name, total_amount, source_raw, row_hash)
      VALUES ('progress', ${fh}, 'P', 1, ${companyName}, '한영번역', ${total}, ${JSON.stringify({ "거래처명": companyName, "상품명": "한영번역", "총액": String(total), "고객명": cust, "연락처": tel, "비고": memo, "내용": "번역", "체결일": "2026-11-09" })}::jsonb, ${fh + "p"}) RETURNING id`);
    made.legacy.push(Number(s.id), Number(p.id)); made.saleNos.push(saleNo);
    await db.execute(sql`INSERT INTO legacy_sales_progress_links (sale_row_id, progress_row_id, sale_no, match_key, match_method, decision) VALUES (${s.id}, ${p.id}, ${saleNo}, 'test', 'test', 'confirmed')`);
    return saleNo;
  };

  const globalSnap = async () => JSON.stringify(await one(sql`SELECT (SELECT count(*) FROM projects) p, (SELECT count(*) FROM quotes) q, (SELECT count(*) FROM quote_items) qi,
    (SELECT count(*) FROM performance_assignments) pa, (SELECT count(*) FROM project_payments) pp, (SELECT count(*) FROM payment_transactions) pt, (SELECT count(*) FROM settlements) st,
    (SELECT count(*) FROM payout_round_items) pri, (SELECT md5(string_agg(id||':'||coalesce(email,'')||coalesce(phone,'')||coalesce(mobile,'')||coalesce(office_phone,'')||company_id, ',' ORDER BY id)) FROM contacts) ct,
    (SELECT md5(string_agg(id||':'||name||coalesce(customer_type,''), ',' ORDER BY id)) FROM companies WHERE NOT (id = ANY(${`{${made.companies.join(",") || 0}}`}::int[]))) co`));
  try {
    // ── fixture ──
    const cA = await company(T("한국보건복지인재원"));
    const kimA = await contact(cA, "김하나", { office: "0437109332" });
    const cOther = await company(T("다른회사"));
    const kimOther = await contact(cOther, "김하나", { mobile: "01099998888" });              // 다른 거래처 동명이인
    const cInd = await company(T("고제이슨"), { type: "INDIVIDUAL", mobile: "01029310697" });
    const cMix = await company(T("혼합상사"), { phone: "025550000", email: `info@${dom}` });
    await contact(cMix, "이민호", { mobile: "01011111111" });                                 // 같은 회사·같은 이름·다른 연락처
    const jung = await contact(cMix, "정해인", { office: "025550000" });                        // 대표번호만 있는 담당자
    const yoona = await contact(cMix, "윤아");                                                  // 이메일·전화 없음
    await contact(cMix, "수지", { email: `suzy@${dom}` });                      // 기존 이메일
    const hong = await contact(cMix, "홍길동", { email: `info@${dom}` });       // 공용 이메일만
    const okC = await contact(cMix, "아이유", { mobile: "01077776666" });
    const cInd2 = await company(T("최유리"), { type: "INDIVIDUAL" });
    const cAlone = await company(T("박서준상사"));                                              // 담당자 없음

    const S = {
      kim: await sale("KIM", T("한국보건복지인재원"), "김하나", "043-710-9332"),
      jason: await sale("JASON", `${T("고제이슨")}(개인고객)`, "고제이슨", "010-2931-0697"),
      jasonBad: await sale("JASONX", `${T("최유리")}(개인고객)`, "최유리", null),
      otherCo: await sale("OTHERCO", T("박서준상사"), "김하나", "010-9999-8888"),
      diffTel: await sale("DIFFTEL", T("혼합상사"), "이민호", "010-2222-2222"),
      repTel: await sale("REPTEL", T("혼합상사"), "정해인", "02-555-0000"),
      sharedMail: await sale("SHMAIL", T("혼합상사"), "홍길동", null, `홍길동 info@${dom} 로 발송`),
      newMail: await sale("NEWMAIL", T("혼합상사"), "윤아", null, `윤아 yoona@${dom}`),
      mailConflict: await sale("MAILX", T("혼합상사"), "수지", null, `수지 suzy2@${dom}`),
      ok: await sale("OK", T("혼합상사"), "아이유", "010-7777-6666"),
    };
    // 이미 정상 연결된 판매
    await db.execute(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status) VALUES ('old_crm', 'sale_contact', ${S.ok}, ${okC}, 'manual', 'active')`);
    const g0 = await globalSnap();

    console.log("\n[1] 연결 계획(읽기 전용)");
    const plan = new Map((await planPartyLinks(db, { saleNos: Object.values(S) })).map(r => [r.saleNo, r]));
    const P = (k: keyof typeof S) => plan.get(S[k])!;
    check("김하나: 같은 거래처 이름+연락처 일치 → B(name_phone), 다른 거래처 김하나 아님", P("kim").category === "B" && P("kim").proposal?.basis === "name_phone" && P("kim").proposal?.contactId === kimA, P("kim"));
    check("고제이슨(개인고객) → 개인고객 Master 고제이슨 연결 가능(F), 별칭 제안", P("jason").category === "F" && P("jason").company.id === cInd && P("jason").alias?.companyId === cInd, P("jason"));
    check("동일 이름·다른 거래처 → 연결 안 함(담당자 Master 미등록 I)", P("otherCo").category === "C" && P("otherCo").issues.includes("I") && !P("otherCo").proposal, P("otherCo"));
    check("동일 회사·동일 이름·다른 연락처 → 충돌(G), 연결 안 함", P("diffTel").category === "G" && !P("diffTel").proposal, P("diffTel"));
    check("공용(대표) 전화 → 개인 식별에 안 씀(name_phone 아님, 이름 유일 연결 후보)", P("repTel").proposal?.basis === "name_unique" && P("repTel").proposal?.contactId === jung, P("repTel"));
    check("공용 이메일 → 개인 식별에 안 씀(name_email 아님)", P("sharedMail").proposal?.basis === "name_unique" && P("sharedMail").proposal?.contactId === hong, P("sharedMail"));
    check("원본 이메일 있음·Master 이메일 없음 → 연결 후보 + 이메일 보완 후보(E)", P("newMail").proposal?.contactId === yoona && P("newMail").supplement?.field === "email" && P("newMail").issues.includes("E"), P("newMail"));
    check("Master 이메일과 원본 이메일 충돌 → G, 연결 안 함", P("mailConflict").category === "G" && !P("mailConflict").proposal, P("mailConflict"));
    check("개인고객 표기 차이 + Master 연락처 없음 → F", P("jasonBad").category === "F" && P("jasonBad").company.id === cInd2, P("jasonBad"));
    check("이미 정상 연결 → A(verified), 변경 제안 없음", P("ok").category === "A" && P("ok").linked?.check === "verified" && !P("ok").proposal, P("ok"));

    console.log("\n[2] 적용(확실한 연결 — 기본: 이메일·연락처 일치) · 되돌리기");
    const r1 = await db.transaction(tx => applyPartyLinks(tx as any, { userId: null, saleNos: Object.values(S) }));
    made.batches.push(r1.batchId);
    check("별칭 2건(고제이슨·최유리) + 담당자 연결 1건(김하나 name_phone)", r1.aliases === 2 && r1.links === 1, r1);
    const kimMap = await one(sql`SELECT entity_id, match_method FROM legacy_master_mappings WHERE entity_type='sale_contact' AND legacy_id = ${S.kim}`);
    check("김하나 판매 → 한국보건복지인재원 김하나 Master", Number(kimMap?.entity_id) === kimA && kimMap.match_method === "party_name_phone", kimMap);
    check("다른 거래처 김하나 연결 없음", !(await one(sql`SELECT 1 x FROM legacy_master_mappings WHERE entity_type='sale_contact' AND entity_id = ${kimOther}`)));
    check("이름 유일 후보(정해인·홍길동·윤아)는 기본 적용에서 제외", !(await one(sql`SELECT 1 x FROM legacy_master_mappings WHERE entity_type='sale_contact' AND legacy_id IN (${S.repTel}, ${S.sharedMail}, ${S.newMail})`)));
    const afterJ = new Map((await planPartyLinks(db, { saleNos: [S.jason, S.kim] })).map(r => [r.saleNo, r]));
    check("적용 후 고제이슨 판매 → 기존 개인고객 Master 로 인식(새 거래처 없음)", afterJ.get(S.jason)?.company.id === cInd && afterJ.get(S.jason)?.company.via === "existing"
      && Number((await one(sql`SELECT count(*) n FROM companies WHERE name LIKE ${"%" + tag + "고제이슨%"}`)).n) === 1);
    check("적용 후 김하나 판매 → A(verified)", afterJ.get(S.kim)?.category === "A" && afterJ.get(S.kim)?.linked?.check === "verified");
    check("윤아 Master 이메일 덮어쓰지 않음", (await one(sql`SELECT email FROM contacts WHERE id = ${yoona}`)).email == null);
    check("이미 정상 연결 유지", Number((await one(sql`SELECT entity_id FROM legacy_master_mappings WHERE entity_type='sale_contact' AND legacy_id = ${S.ok}`)).entity_id) === okC);
    const r2 = await db.transaction(tx => applyPartyLinks(tx as any, { userId: null, saleNos: Object.values(S) }));
    made.batches.push(r2.batchId);
    check("재실행 시 추가 0건(중복 없음)", r2.aliases === 0 && r2.links === 0, r2);
    const r3 = await db.transaction(tx => applyPartyLinks(tx as any, { userId: null, saleNos: [S.newMail], bases: ["name_unique"] }));
    made.batches.push(r3.batchId);
    check("이름 유일 연결은 명시 선택 시에만(윤아 1건)", r3.links === 1, r3);
    check("판매·견적·수행·청구·입금·정산·지급·담당자 Master·기존 거래처 불변", (await globalSnap()) === g0);
    const rb = await db.transaction(tx => rollbackPartyLinks(tx as any, r1.batchId));
    check("되돌리기 — 별칭 2·연결 1 삭제", rb.aliasesRemoved === 2 && rb.linksRemoved === 1, rb);
    check("되돌린 뒤 고제이슨 판매 다시 F", (await planPartyLinks(db, { saleNos: [S.jason] }))[0]?.category === "F");
  } finally {
    const ms = made.saleNos;
    if (ms.length) await db.execute(sql`DELETE FROM legacy_master_mappings WHERE entity_type='sale_contact' AND legacy_id IN (${sql.join(ms.map(s => sql`${s}`), sql`, `)})`);
    if (made.batches.length) {
      const bl = sql.join(made.batches.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM import_row_sources WHERE batch_id IN (${bl})`);
      await db.execute(sql`DELETE FROM import_batches WHERE id IN (${bl})`);
    }
    if (made.legacy.length) {
      const ll = sql.join(made.legacy.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM legacy_sales_progress_links WHERE sale_row_id IN (${ll}) OR progress_row_id IN (${ll})`);
      await db.execute(sql`DELETE FROM legacy_archive_rows WHERE id IN (${ll})`);
    }
    if (made.companies.length) {
      const cl = sql.join(made.companies.map(i => sql`${i}`), sql`, `);
      await db.execute(sql`DELETE FROM company_aliases WHERE company_id IN (${cl})`);
      await db.execute(sql`DELETE FROM contacts WHERE company_id IN (${cl})`);
      await db.execute(sql`DELETE FROM companies WHERE id IN (${cl})`);
    }
    const left = await one(sql`SELECT (SELECT count(*) FROM companies WHERE name LIKE ${tag + "%"}) a, (SELECT count(*) FROM legacy_archive_rows WHERE file_hash LIKE ${tag + "%"}) b`);
    check("fixture 정리 완료", Number(left.a) === 0 && Number(left.b) === 0, left);
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
