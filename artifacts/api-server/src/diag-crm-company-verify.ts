// 과거 CRM 미등록 거래처 중 '신규 등록 후보(8)'·'Master 후보 1곳(130)' 동일 거래처 검증(읽기 전용)
// 입력: diag:crm-unregistered-companies 결과 JSON(DIAG_IN). 대상 DB 는 READ ONLY 트랜잭션으로만 조회 후 ROLLBACK.
// 판정 근거 우선순위
//   1) 사업자등록번호 — 과거 CRM 판매목록·진행관리표에 칸이 없어 비교 불가(모든 건 '원본 없음')
//   2) CRM 식별정보 ↔ Master 식별정보: 진행관리표 고객명+개인번호가 후보 거래처 담당자와 일치 / 원본 이메일이 후보 거래처·담당자 이메일과 일치 /
//      원본 번호가 후보 거래처 대표번호와 일치(다른 거래처에서 쓰지 않는 번호만)
//   3) 거래처명 정규화 + 2)의 추가 근거
// 결과: A 동일 거래처 확인(연결 가능) · B 신규 등록 필요 · C 추가 확인 필요 · D 식별정보 충돌(연결 불가)
//   지점/본사·법인/개인 혼재·공용번호·다른 거래처를 가리키는 증거가 있으면 A 로 두지 않는다.
// 실행: DIAG_DB_URL=<env> DIAG_IN=<json> DIAG_OUT=<폴더> pnpm run diag:crm-company-verify
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { normalizeCompanyName as N } from "./lib/normalizeCompany";
import { individualNameOf } from "./services/legacyPartyLink";
import { personKey, normPhone, phoneType, sourceEmailOf } from "./services/legacyContactRestore";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL, inFile = process.env.DIAG_IN, outDir = process.env.DIAG_OUT;
if (!url || !inFile || !outDir) { console.error("DIAG_DB_URL, DIAG_IN, DIAG_OUT 필요"); process.exit(2); }
const emailKey = (v: unknown) => { const s = String(v ?? "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };
const GENERIC_MAILBOX = /^(info|admin|office|contact|help|support|sales|master|webmaster|hr|biz|mail|service|cs|team|account|tax|invoice|billing)[.\-_]?\d*@/i;
const BRANCH = /(지점|지사|본사|본점|분원|분점|사업부|사업본부|사업장|센터|캠퍼스|공장|연구소|지회|지부|본부|점)$/;
const BRANCH_ANY = /(지점|지사|본사|본점|분원|분점|사업부|사업본부|사업장|캠퍼스|공장|지회|지부)/;
// 한쪽 이름에만 있으면 다른 주체일 수 있는 법인·단체 유형(회사 ↔ 노동조합·산학협력단·재단 등)
const ENTITY_WORDS = ["노동조합", "노조", "산학협력단", "재단", "협회", "학회", "조합", "연구소", "연구원", "병원", "의원", "대학원", "대학교", "학교", "법인", "지회", "위원회"];
const entityDiff = (a: string, b: string) => ENTITY_WORDS.filter(w => a.includes(w) !== b.includes(w));

async function main() {
  const input = JSON.parse(fs.readFileSync(inFile!, "utf8")) as { rows: any[] };
  const targets = input.rows.filter((r: any) => r.type === "C" || (r.type === "D" && !/^(개인|개인고객|개인 고객)$/.test(String(r.crmName).trim())) || (r.type === "E" && r.masterId));
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  try {
    if ((await q(sql`SELECT current_setting('transaction_read_only') ro`))[0].ro !== "on") throw new Error("읽기 전용 아님 — 중단");
    const cos = await q(sql`SELECT id, name, customer_type, business_number brn, representative_name rep, address, phone, mobile, email, deleted_at FROM companies`);
    const coById = new Map(cos.map(c => [Number(c.id), c]));
    const live = cos.filter(c => !c.deleted_at);
    const contacts = await q(sql`SELECT id, company_id, name, phone, mobile, office_phone, email FROM contacts WHERE deleted_at IS NULL`);
    // 번호 → 거래처(대표번호·담당자 번호) / 이메일 → 거래처
    const telCos = new Map<string, Set<number>>(); const mailCos = new Map<string, Set<number>>();
    const add = (m: Map<string, Set<number>>, k: string | null, id: number) => { if (k) (m.get(k) ?? m.set(k, new Set()).get(k)!).add(id); };
    for (const c of live) { for (const t of [c.phone, c.mobile].map(normPhone)) if (t.length >= 9) add(telCos, t, Number(c.id)); add(mailCos, emailKey(c.email), Number(c.id)); }
    for (const c of contacts) { for (const t of [c.phone, c.mobile, c.office_phone].map(normPhone)) if (t.length >= 9) add(telCos, t, Number(c.company_id)); add(mailCos, emailKey(c.email), Number(c.company_id)); }
    const ctByCo = new Map<number, any[]>(); for (const c of contacts) (ctByCo.get(Number(c.company_id)) ?? ctByCo.set(Number(c.company_id), []).get(Number(c.company_id))!).push(c);
    const history = await q(sql`SELECT company_id, company_name FROM company_name_history`);
    const aliases = await q(sql`SELECT company_id, alias_name FROM company_aliases`);

    const out: any[] = [];
    for (const t of targets) {
      const saleNos: string[] = String(t.saleNos).split(" ").filter(Boolean);
      const prog = await q(sql`SELECT btrim(p.source_raw->>'고객명') cust, p.source_raw->>'연락처' tel, p.source_raw->>'비고' memo
        FROM legacy_archive_rows s JOIN legacy_sales_progress_links l ON l.sale_row_id = s.id AND l.decision = 'confirmed'
        JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
        WHERE s.source_type = 'sales_list' AND s.is_effective AND s.source_raw->>'판매번호' IN (${sql.join(saleNos.map(x => sql`${x}`), sql`, `)})`);
      const people = new Map<string, { name: string; tels: Set<string> }>();
      for (const p of prog) { const k = personKey(p.cust); if (!k) continue; const e = people.get(k) ?? { name: String(p.cust), tels: new Set<string>() }; const n = normPhone(p.tel); if (n.length >= 9) e.tels.add(n); people.set(k, e); }
      const tels = [...new Set(prog.map(p => normPhone(p.tel)).filter(n => n.length >= 9))];
      const emails = [...new Set([...people.values()].flatMap(pp => sourceEmailOf(prog.map(p => ({ cust: p.cust, memo: p.memo })), pp.name)))].filter(e => !GENERIC_MAILBOX.test(e));
      // 같은 번호를 이 그룹의 여러 고객이 쓰면 공용번호(대표번호 등)로 본다
      const telPeople = new Map<string, Set<string>>(); for (const p of prog) { const n = normPhone(p.tel); if (n.length >= 9) (telPeople.get(n) ?? telPeople.set(n, new Set()).get(n)!).add(personKey(p.cust)); }
      const personalTel = (n: string) => (telPeople.get(n)?.size ?? 0) <= 1 && phoneType(n) !== "rep";
      // 원본 고객(이름+개인번호)·이메일이 가리키는 거래처
      const contactHits = new Map<number, string[]>();   // companyId → 근거
      for (const c of contacts) {
        const pp = people.get(personKey(c.name)); if (!pp) continue;
        const ct = [c.phone, c.mobile, c.office_phone].map(normPhone);
        const hit = [...pp.tels].filter(n => personalTel(n) && ct.includes(n));
        if (hit.length) (contactHits.get(Number(c.company_id)) ?? contactHits.set(Number(c.company_id), []).get(Number(c.company_id))!).push(`담당자 ${c.name}·${hit[0]} 일치(#${c.id})`);
      }
      const mailHits = new Map<number, string[]>(); for (const e of emails) for (const id of mailCos.get(e) ?? []) (mailHits.get(id) ?? mailHits.set(id, []).get(id)!).push(`이메일 ${e} 일치`);
      const repTelHits = new Map<number, string[]>();
      for (const n of tels) { const s = telCos.get(n); if (!s) continue; for (const id of s) { const co = coById.get(id); if (co && [co.phone, co.mobile].map(normPhone).includes(n)) (repTelHits.get(id) ?? repTelHits.set(id, []).get(id)!).push(`거래처 대표번호 ${n} 일치${s.size > 1 ? `(다른 거래처 ${s.size - 1}곳도 사용 — 공용번호)` : ""}`); } }
      const evidenceFor = (id: number) => [...(contactHits.get(id) ?? []), ...(mailHits.get(id) ?? []), ...(repTelHits.get(id) ?? [])];
      const strongFor = (id: number) => (contactHits.get(id)?.length ?? 0) > 0 || (mailHits.get(id)?.length ?? 0) > 0 || (repTelHits.get(id) ?? []).some(x => !x.includes("공용번호"));
      const pointedOthers = (exclude: number | null) => [...new Set([...contactHits.keys(), ...mailHits.keys(), ...repTelHits.keys()])].filter(id => id !== exclude && !coById.get(id)?.deleted_at && strongFor(id));

      const row: any = { crmName: t.crmName, variants: t.variants, sales: t.sales, prevType: t.type, candidateId: null, candidateName: null, candidateBrn: null, candidateRep: null,
        candidateAddress: null, candidatePhone: null, candidateEmail: null, candidateType: null, brnMatch: "비교 불가(과거 CRM 원본에 사업자등록번호 없음)",
        crmCustomers: [...people.values()].map(pp => `${pp.name}${pp.tels.size ? "/" + [...pp.tels].join("·") : ""}`).join(", "), crmEmails: emails.join(", "),
        evidence: "", result: "", reason: "", action: "", saleNos: t.saleNos };
      const ind = individualNameOf(t.crmName);
      if (t.type === "E" && t.masterId) {
        const cid = Number(t.masterId); const co = coById.get(cid);
        Object.assign(row, { candidateId: cid, candidateName: co?.name ?? t.masterName, candidateBrn: co?.brn ?? null, candidateRep: co?.rep ?? null, candidateAddress: co?.address ?? null,
          candidatePhone: [co?.phone, co?.mobile].filter(Boolean).join(" · ") || null, candidateEmail: co?.email ?? null, candidateType: co?.customer_type ?? null });
        const ev = evidenceFor(cid); const others = pointedOthers(cid);
        const crmIsIndividual = !!ind; const coIsIndividual = co?.customer_type === "INDIVIDUAL";
        const nameA = N(t.crmName), nameB = N(co?.name ?? "");
        const branchDiff = BRANCH_ANY.test(String(t.crmName)) !== BRANCH_ANY.test(String(co?.name ?? "")) || (nameA !== nameB && (BRANCH.test(nameA.replace(nameB, "")) || BRANCH.test(nameB.replace(nameA, ""))));
        row.evidence = ev.join(" / ") || "이름 유사만(식별정보 일치 없음)";
        if (!co || co.deleted_at) { row.result = "D"; row.reason = "후보 거래처가 삭제됨"; row.action = "연결 불가 — 다른 후보 확인"; }
        else if (others.length && !strongFor(cid)) { row.result = "D"; row.reason = `원본 식별정보가 다른 거래처를 가리킴: ${others.map(id => `${coById.get(id)?.name}(#${id})`).join(", ")}`; row.action = "후보와 연결하지 않음 — 가리키는 거래처 확인"; }
        else if (crmIsIndividual !== coIsIndividual) { row.result = "C"; row.reason = "법인/개인 유형 혼재"; row.action = "고객 유형 확인"; }
        else if (strongFor(cid) && others.length) { row.result = "C"; row.reason = `후보 근거 있으나 다른 거래처도 가리킴: ${others.map(id => `${coById.get(id)?.name}(#${id})`).join(", ")}`; row.action = "어느 거래처인지 확인"; }
        else if (strongFor(cid) && entityDiff(String(t.crmName), String(co?.name ?? "")).length) { row.result = "C"; row.reason = `식별정보 일치하나 법인·단체 유형 표기 차이(${entityDiff(String(t.crmName), String(co?.name ?? "")).join("·")})`; row.action = "같은 주체인지 확인(회사·조합·재단 등 구분)"; }
        else if (strongFor(cid) && branchDiff) { row.result = "C"; row.reason = "식별정보 일치하나 지점·본사·사업부 표기 차이"; row.action = "본사/지점 구분 확인 후 연결"; }
        else if (strongFor(cid)) { row.result = "A"; row.reason = "CRM 식별정보가 후보 거래처와 일치(이름 정규화 + 담당자·이메일·대표번호)"; row.action = "기존 Master 에 별칭으로 연결"; }
        else if ((repTelHits.get(cid) ?? []).length) { row.result = "C"; row.reason = "공용번호만 일치"; row.action = "추가 식별정보 확인"; }
        else { row.result = "C"; row.reason = "이름 유사만 — 동일성 근거 없음"; row.action = "사업자등록번호·주소 등 확인 후 결정"; }
      } else {
        // 신규 등록 후보 — 기존 Master 에 같은 거래처가 있는지(이름 변형·과거 상호·별칭·삭제 거래처·식별정보) 재확인
        const key = N(ind ?? t.crmName);
        const byName = live.filter(c => N(c.name) === key).map(c => Number(c.id));
        const byHist = history.filter(h => N(h.company_name) === key).map(h => Number(h.company_id));
        const byAlias = aliases.filter(a => N(a.alias_name) === key || N(individualNameOf(a.alias_name) ?? "") === key).map(a => Number(a.company_id));
        const dead = cos.filter(c => c.deleted_at && N(c.name) === key).map(c => Number(c.id));
        const others = pointedOthers(null);
        const nameHits = [...new Set([...byName, ...byHist, ...byAlias])];
        row.evidence = [nameHits.length ? `이름·별칭·과거상호 일치: ${nameHits.map(id => `${coById.get(id)?.name}(#${id}, ${coById.get(id)?.customer_type})`).join(", ")}` : "",
          dead.length ? `삭제된 거래처와 이름 일치: ${dead.map(id => `#${id}`).join(", ")}` : "",
          others.length ? `원본 식별정보가 기존 거래처를 가리킴: ${others.map(id => `${coById.get(id)?.name}(#${id}) — ${evidenceFor(id).join("; ")}`).join(", ")}` : ""].filter(Boolean).join(" / ") || "기존 Master·개인고객·별칭·과거상호·삭제 거래처·연락처·이메일 어디에도 없음";
        if (others.length) { row.result = "C"; row.reason = "원본 식별정보가 기존 거래처와 일치 — 같은 거래처일 가능성"; row.action = "기존 거래처와 동일 여부 확인(신규 등록 보류)"; row.candidateId = others[0]; row.candidateName = coById.get(others[0])?.name; }
        else if (nameHits.length || dead.length) { row.result = "C"; row.reason = "이름이 같은 기존·삭제 거래처 있음(식별정보 확인 안 됨)"; row.action = "동일 여부 확인"; }
        else { row.result = "B"; row.reason = ind ? `개인고객 '${ind}' — 같은 이름·연락처의 개인고객 Master 없음` : "기존 Master 에 같은 거래처 없음(이름·별칭·과거상호·연락처·이메일)"; row.action = ind ? "개인고객 신규 등록 후 연결" : "거래처 신규 등록(사업자정보 확인) 후 연결"; }
      }
      out.push(row);
    }
    out.sort((a, b) => a.result.localeCompare(b.result) || b.sales - a.sales);
    const sum: any = { total: out.length, sales: out.reduce((n, o) => n + o.sales, 0), byResult: {} };
    for (const r of ["A", "B", "C", "D"]) sum.byResult[r] = { names: out.filter(o => o.result === r).length, sales: out.filter(o => o.result === r).reduce((n, o) => n + o.sales, 0) };
    sum.cReasons = out.filter(o => o.result === "C").reduce((a: any, o) => { const k = o.reason.split(":")[0].split("—")[0].trim(); a[k] = (a[k] ?? 0) + 1; return a; }, {});
    fs.mkdirSync(outDir!, { recursive: true });
    const cols = Object.keys(out[0] ?? {});
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(path.join(outDir!, "crm_company_verify_138.csv"), "﻿" + [cols.join(","), ...out.map(o => cols.map(c => cell(o[c])).join(","))].join("\n"));
    fs.writeFileSync(path.join(outDir!, "crm_company_verify_138.json"), JSON.stringify({ summary: sum, rows: out }, null, 2));
    console.log(JSON.stringify(sum, null, 2));
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
