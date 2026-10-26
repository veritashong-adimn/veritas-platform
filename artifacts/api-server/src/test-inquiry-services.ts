// @ts-nocheck — 격리 테스트(임시 복제 DB veritas_inq_scratch + :8099). 의뢰건 서비스 유형 복수 선택 ①~⑫·⑮.
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

if (!/\/veritas_inq_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB 전용"); process.exit(1); }
const B = "http://localhost:8099/api";
const T = jwt.sign({ id: 10, email: "admin@test", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "20m" });
const call = async (m: string, p: string, b?: any) => { const r = await fetch(B + p, { method: m, headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const one = async (s: any) => ((await db.execute(s)).rows as any[])[0];
let pass = 0, fail = 0; const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const base = { customerCompanyName: "복수선택테스트", contactName: "테스터", subject: "테스트 의뢰" };

async function create(extra: any) {
  const c = await call("POST", "/admin/inquiries", { ...base, ...extra });
  const g = await call("GET", `/admin/inquiries/${c.body.id}`);
  return { status: c.status, id: c.body.id, d: g.body };
}

async function main() {
  const snap = async () => one(sql`SELECT md5(coalesce(string_agg(row(i.*)::text, '' ORDER BY id), '')) inq, (SELECT md5(coalesce(string_agg(row(q.*)::text, '' ORDER BY id), '')) FROM quotes q) quotes,
    (SELECT md5(coalesce(string_agg(row(p.*)::text, '' ORDER BY id), '')) FROM projects p) projects FROM inquiries i WHERE id <= ${Number(process.env.MAX_EXISTING_ID ?? 0)}`);
  const S0 = await snap();

  const c1 = await create({ serviceTypes: ["interpretation"] });
  check("① 통역 단독", c1.status === 201 && c1.d.serviceType === "interpretation" && eq(c1.d.serviceTypes, ["interpretation"]) && c1.d.otherServices === null);
  const c2 = await create({ serviceTypes: ["translation", "interpretation"] });
  check("② 통역+번역 (표시 순서 정렬·대표값=통역)", eq(c2.d.serviceTypes, ["interpretation", "translation"]) && c2.d.serviceType === "interpretation");
  const c3 = await create({ serviceTypes: ["interpretation", "equipment"], equipmentJson: JSON.stringify([{ kind: "수신기", quantity: "50", unit: "대" }]) });
  check("③ 통역+장비 (장비행 보존)", eq(c3.d.serviceTypes, ["interpretation", "equipment"]) && JSON.parse(c3.d.equipmentJson).length === 1);
  const c4 = await create({ serviceTypes: ["equipment", "translation", "interpretation"] });
  check("④ 통역+번역+장비", eq(c4.d.serviceTypes, ["interpretation", "translation", "equipment"]));
  const c5 = await create({ serviceTypes: ["other"], otherServices: ["감수"] });
  check("⑤ 기타→감수 (유형·세부 구분 저장)", eq(c5.d.serviceTypes, ["other"]) && eq(c5.d.otherServices, ["감수"]) && c5.d.serviceType === "other");
  const c6 = await create({ serviceTypes: ["translation", "other"], otherServices: ["감수", "편집", "감수"] });
  check("⑥ 번역+기타→감수+편집 (중복 제거)", eq(c6.d.serviceTypes, ["translation", "other"]) && eq(c6.d.otherServices, ["감수", "편집"]));
  const c7 = await create({ serviceTypes: ["interpretation", "equipment", "other"], otherServices: ["공증", "  자막 제작  ", "", "   "] });
  check("⑦ 기타→직접 입력 (앞뒤 공백 제거·빈 값 제외)", eq(c7.d.otherServices, ["공증", "자막 제작"]));
  const c8 = await create({ serviceTypes: ["translation", "bogus"], otherServices: ["감수"] });
  check("기타 미선택이면 세부 서비스 저장 안 함 · 허용되지 않은 값 제외", eq(c8.d.serviceTypes, ["translation"]) && c8.d.otherServices === null);

  // ⑧ 선택 해제·재선택 / ⑩ 수정 후 재조회
  const u1 = await call("PATCH", `/admin/inquiries/${c7.id}`, { serviceTypes: ["interpretation"], otherServices: ["공증"] });
  const g1 = (await call("GET", `/admin/inquiries/${c7.id}`)).body;
  check("⑧⑩ 기타·장비 해제 → 세부 서비스 제거 · 재조회 반영", u1.status === 200 && eq(g1.serviceTypes, ["interpretation"]) && g1.otherServices === null && g1.serviceType === "interpretation");
  await call("PATCH", `/admin/inquiries/${c7.id}`, { serviceTypes: ["interpretation", "other"], otherServices: ["편집", "자막 제작"] });
  const g2 = (await call("GET", `/admin/inquiries/${c7.id}`)).body;
  check("⑧⑩ 재선택 → 다시 저장", eq(g2.serviceTypes, ["interpretation", "other"]) && eq(g2.otherServices, ["편집", "자막 제작"]));
  await call("PATCH", `/admin/inquiries/${c7.id}`, { requirements: "요구사항만 수정" });
  const g3 = (await call("GET", `/admin/inquiries/${c7.id}`)).body;
  check("서비스 필드 없는 수정 → 기존 선택 유지", eq(g3.serviceTypes, ["interpretation", "other"]) && eq(g3.otherServices, ["편집", "자막 제작"]) && g3.requirements === "요구사항만 수정");

  // ⑪ 기존 단일 선택 의뢰건(신규 컬럼 null) — 조회·부분 수정 호환
  const [legacy] = (await db.execute(sql`INSERT INTO inquiries (inquiry_number, channel, status, service_type, customer_company_name, subject) VALUES ('RTEST-LEGACY', 'phone', 'new', 'translation', '기존단일', '기존 번역 의뢰') RETURNING id`)).rows as any[];
  const lg = (await call("GET", `/admin/inquiries/${legacy.id}`)).body;
  check("⑪ 기존 단일 의뢰건 조회: serviceType 유지 · 신규 컬럼 null", lg.serviceType === "translation" && lg.serviceTypes === null && lg.otherServices === null);
  await call("PATCH", `/admin/inquiries/${legacy.id}`, { subject: "주제만 수정" });
  const lg2 = await one(sql`SELECT service_type, service_types, other_services, subject FROM inquiries WHERE id=${legacy.id}`);
  check("⑪ 기존 단일 의뢰건 부분 수정 → 서비스 값 변경 없음", lg2.service_type === "translation" && lg2.service_types === null && lg2.subject === "주제만 수정");
  const lg3 = await call("PATCH", `/admin/inquiries/${legacy.id}`, { serviceType: "interpretation" });
  check("기존 클라이언트(serviceType 단일 전송) 호환", lg3.status === 200 && lg3.body.serviceType === "interpretation" && eq(lg3.body.serviceTypes, ["interpretation"]));

  // ⑨ 목록 응답에도 복수 필드 포함
  const list = (await call("GET", "/admin/inquiries?scope=all")).body;
  const rows = list.rows ?? list;
  const lr = (Array.isArray(rows) ? rows : []).find(r => r.id === c4.id);
  check("⑨ 목록 응답에 serviceTypes 포함", !lr || eq(lr.serviceTypes, ["interpretation", "translation", "equipment"]), lr ? "목록 행 확인" : "목록 기본 조회 범위 밖(상세로 확인)");

  // ⑫ AI 자동분석 — 복수 서비스 인식(제안 전용, DB 미변경)
  const ai = async (text: string) => {
    const fd = new FormData(); fd.append("text", text);
    const r = await fetch(`${B}/admin/inquiries/ai-analyze`, { method: "POST", headers: { Authorization: `Bearer ${T}` }, body: fd });
    return (await r.json()).fields ?? {};
  };
  const cnt0 = await one(sql`SELECT count(*)::int n FROM inquiries`);
  const a1 = await ai("안녕하세요. 다음 달 국제회의에 영한 동시통역과 통역장비가 필요합니다. 견적 부탁드립니다.");
  check("⑫ AI: '동시통역 + 통역장비' → 통역 + 장비", eq(a1.serviceTypes, ["interpretation", "equipment"]), JSON.stringify(a1.serviceTypes));
  const a2 = await ai("계약서 번역과 감수를 요청합니다. 영문 원어민 감수 포함해 주세요.");
  check("⑫ AI: '번역과 감수' → 번역 + 기타(감수)", eq(a2.serviceTypes, ["translation", "other"]) && eq(a2.otherServices, ["감수"]), JSON.stringify([a2.serviceTypes, a2.otherServices]));
  const a3 = await ai("(주)베리타스 통번역 담당자님께, 증명서 번역 후 공증까지 부탁드립니다.");
  check("⑫ AI: 회사명 '통번역'은 무시 · 번역 + 공증", eq(a3.serviceTypes, ["translation", "other"]) && eq(a3.otherServices, ["공증"]), JSON.stringify([a3.serviceTypes, a3.otherServices]));
  check("⑫ AI 분석은 저장하지 않음(제안 전용)", (await one(sql`SELECT count(*)::int n FROM inquiries`)).n === cnt0.n);

  // ⑮ 기존 의뢰건·견적·판매 데이터 불변
  const S1 = await snap();
  check("⑮ 기존 의뢰건·견적·판매 데이터 불변", eq(S0, S1));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("테스트 오류:", e); process.exit(1); });
