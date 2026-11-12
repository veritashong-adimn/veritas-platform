// 과거 CRM 미등록 거래처 2차 검증(읽기 전용) — diag:crm-company-verify 결과의 C(추가 확인)·D(충돌)·B(신규)를 재분석.
//   추가 객관 근거: ① 원본 이름의 괄호·병기 부분이 Master 공식명과 정확히 일치(표기 병기) ② 영문 약어 한글 읽기 일치
//   ③ 원본 이메일의 조직 도메인(개인메일·korea.kr 등 공용 도메인 제외) = 후보 거래처·담당자 도메인 ④ 후보 거래처의 같은 이름 담당자(보조)
//   충돌·제외: 원본 식별정보가 다른 거래처를 가리킴, 지점·본사·법인/단체 유형 차이, 법인/개인 혼재.
//   D: 후보와 '가리키는 거래처'의 사업자번호가 같으면 같은 법인(Master 중복) — 다르면 서로 다른 거래처.
// 결과: A 연결 확정 가능 · B 신규 등록 필요 · C 추가 정보 확인 · D 서로 다른 거래처/식별정보 충돌
// 실행: DIAG_DB_URL=<env> DIAG_IN=<verify json> DIAG_OUT=<폴더> pnpm run diag:crm-company-verify2
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { normalizeCompanyName as N } from "./lib/normalizeCompany";
import { transliterateAcronyms } from "./services/legacyCompanyRestore";
import { personKey, normPhone, sourceEmailOf } from "./services/legacyContactRestore";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL, inFile = process.env.DIAG_IN, outDir = process.env.DIAG_OUT;
if (!url || !inFile || !outDir) { console.error("DIAG_DB_URL, DIAG_IN, DIAG_OUT 필요"); process.exit(2); }
const emailKey = (v: unknown) => { const s = String(v ?? "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };
const PUBLIC_DOMAIN = /^(naver\.com|gmail\.com|daum\.net|hanmail\.net|nate\.com|hotmail\.com|kakao\.com|yahoo\.(com|co\.kr)|outlook\.com|icloud\.com|korea\.kr|hanmir\.com|empal\.com|paran\.com|live\.com|me\.com)$/;
const domainOf = (e: string | null) => { const d = e?.split("@")[1] ?? null; return d && !PUBLIC_DOMAIN.test(d) ? d : null; };
const LEGAL_FRAGMENT = /^(주|유|사|재|합|복지|의|학|사단|재단|주식회사|유한회사|사단법인|재단법인)$/;
const parts = (s: string) => s.split(/[\/()（）\[\],]+/).map(p => p.trim()).filter(p => p && !LEGAL_FRAGMENT.test(p));
const ANNOT = /^[A-Za-z0-9&.,'\s-]+$/;
const BRANCH_ANY = /(지점|지사|본사|본점|분원|분점|사업부|사업본부|사업장|캠퍼스|공장|지회|지부|사무소|출장소|영업소)/;
const ENTITY_WORDS = ["노동조합", "노조", "산학협력단", "재단", "협회", "학회", "조합", "연구소", "연구원", "병원", "의원", "대학원", "대학교", "학교", "위원회", "의료원"];
const entityDiff = (a: string, b: string) => ENTITY_WORDS.filter(w => a.includes(w) !== b.includes(w));
const brnKey = (v: unknown) => String(v ?? "").replace(/\D/g, "") || null;

async function main() {
  const input = JSON.parse(fs.readFileSync(inFile!, "utf8")) as { rows: any[] };
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  try {
    if ((await q(sql`SELECT current_setting('transaction_read_only') ro`))[0].ro !== "on") throw new Error("읽기 전용 아님 — 중단");
    const cos = await q(sql`SELECT id, name, customer_type, business_number brn, representative_name rep, address, phone, mobile, email, deleted_at FROM companies`);
    const coById = new Map(cos.map(c => [Number(c.id), c]));
    const contacts = await q(sql`SELECT id, company_id, name, phone, mobile, office_phone, email FROM contacts WHERE deleted_at IS NULL AND is_active`);
    const ctByCo = new Map<number, any[]>(); for (const c of contacts) (ctByCo.get(Number(c.company_id)) ?? ctByCo.set(Number(c.company_id), []).get(Number(c.company_id))!).push(c);
    const domainsOf = (id: number) => new Set([emailKey(coById.get(id)?.email), ...(ctByCo.get(id) ?? []).map(c => emailKey(c.email))].map(domainOf).filter(Boolean) as string[]);
    // 판매에 연결된 담당자(다른 판매 표기에서 이미 이 담당자를 쓰는지 — 잘못된 연결 확인용)
    const linkCount = new Map((await q(sql`SELECT entity_id, count(*) n, string_agg(DISTINCT s.company_name, ' | ') cos FROM legacy_master_mappings m
      JOIN legacy_archive_rows s ON s.source_type='sales_list' AND s.is_effective AND s.source_raw->>'판매번호' = m.legacy_id
      WHERE m.entity_type='sale_contact' AND m.status='active' GROUP BY 1`)).map(r => [Number(r.entity_id), r]));

    const out: any[] = [];
    for (const t of input.rows.filter(r => ["B", "C", "D"].includes(r.result))) {
      const saleNos: string[] = String(t.saleNos).split(" ").filter(Boolean);
      const prog = await q(sql`SELECT btrim(p.source_raw->>'고객명') cust, p.source_raw->>'연락처' tel, p.source_raw->>'비고' memo
        FROM legacy_archive_rows s JOIN legacy_sales_progress_links l ON l.sale_row_id = s.id AND l.decision='confirmed'
        JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
        WHERE s.source_type='sales_list' AND s.is_effective AND s.source_raw->>'판매번호' IN (${sql.join(saleNos.map(x => sql`${x}`), sql`, `)})`);
      const names = [...new Set(prog.map(p => personKey(p.cust)).filter(Boolean))];
      const emails = [...new Set(names.flatMap(n => sourceEmailOf(prog.map(p => ({ cust: p.cust, memo: p.memo })), prog.find(p => personKey(p.cust) === n)?.cust)))];
      const crmDomains = new Set(emails.map(domainOf).filter(Boolean) as string[]);
      const tels = new Set(prog.map(p => normPhone(p.tel)).filter(n => n.length >= 9));
      const row: any = { crmName: t.crmName, sales: t.sales, prevResult: t.result, candidateId: t.candidateId, candidateName: t.candidateName,
        candidateBrn: t.candidateBrn, crmCustomers: t.crmCustomers, crmEmails: emails.join(", "), match: "", mismatch: "", result: "", action: "", contactLink: "", saleNos: t.saleNos };
      if (t.result === "B") { Object.assign(row, { result: "B", match: t.evidence, action: t.action, contactLink: t.crmName.includes("개인") ? "개인고객 — 담당자 불필요" : (names.length ? `담당자 Master 없음 → 신규 등록 후보(${prog.filter(p => p.cust).map(p => `${p.cust}/${p.tel ?? "-"}`)[0]})` : "원본 고객명 없음") }); out.push(row); continue; }
      const cid = Number(t.candidateId); const co = coById.get(cid);
      if (t.result === "D") {
        // 원본 고객이 가리키는 거래처
        const pointed = new Map<number, string[]>();
        for (const c of contacts) { if (!names.includes(personKey(c.name))) continue; const ct = [c.phone, c.mobile, c.office_phone].map(normPhone); const hit = [...tels].filter(x => ct.includes(x));
          if (hit.length && Number(c.company_id) !== cid) (pointed.get(Number(c.company_id)) ?? pointed.set(Number(c.company_id), []).get(Number(c.company_id))!).push(`${c.name}(#${c.id})·${hit[0]}${linkCount.get(Number(c.id)) ? ` — 기존 판매 ${linkCount.get(Number(c.id)).n}건 연결(표기: ${String(linkCount.get(Number(c.id)).cos).slice(0, 60)})` : ""}`); }
        const pts = [...pointed.entries()].map(([id, ev]) => { const x = coById.get(id); const sameBrn = brnKey(x?.brn) && brnKey(x?.brn) === brnKey(co?.brn);
          return `${x?.name}(#${id}, 사업자 ${x?.brn ?? "없음"}${sameBrn ? " = 후보와 같은 사업자" : ""}): ${ev.join("; ")}`; });
        const sameEntity = [...pointed.keys()].some(id => brnKey(coById.get(id)?.brn) && brnKey(coById.get(id)?.brn) === brnKey(co?.brn));
        Object.assign(row, { mismatch: `후보 ${co?.name}(#${cid}, 사업자 ${co?.brn ?? "없음"})에는 원본 고객 정보 없음`, match: pts.join(" / "),
          result: sameEntity ? "C" : "D",
          action: sameEntity ? "후보와 가리키는 거래처가 같은 사업자 — Master 중복 정리 검토 후 연결" : `후보(#${cid})와 연결하지 않음. 원본 고객이 속한 거래처(${[...pointed.keys()].map(id => `#${id}`).join(", ")})가 같은 거래처인지 직원 확인 — 담당자 이직·계열사·지점 가능성`,
          contactLink: "거래처 확정 후 판단" });
        out.push(row); continue;
      }
      // ── C 재분석 ──
      const ev: string[] = []; const bad: string[] = [];
      const crmParts = parts(String(t.crmName)); const coKey = N(co?.name ?? "");
      const exactPart = crmParts.find(p => N(p) === coKey && N(p) !== N(t.crmName));
      const others = crmParts.filter(p => p !== exactPart);
      if (exactPart) {
        // 나머지 표기는 영문 병기(예: YK, KDI)이거나, Master 명과 같거나, 약어 한글 읽기가 Master 명에 포함될 때만 허용
        const rest = others.map(p => ({ p, ok: ANNOT.test(p) || N(p) === coKey || (!!transliterateAcronyms(p) && coKey.includes(N(transliterateAcronyms(p)!))) }));
        ev.push(`원본 표기 안의 '${exactPart}' = Master 공식명`);
        const non = rest.filter(r => !r.ok).map(r => r.p);
        if (non.length) bad.push(`나머지 표기 '${non.join(", ")}'는 Master 명과 다름`);
      }
      const tl = transliterateAcronyms(String(t.crmName)); if (tl && N(tl) === coKey) ev.push(`영문 약어 한글 읽기 '${tl}' = Master 명`);
      const domHit = [...crmDomains].filter(d => domainsOf(cid).has(d)); if (domHit.length) ev.push(`조직 이메일 도메인 ${domHit.join(", ")} 일치`);
      const nameHit = (ctByCo.get(cid) ?? []).filter(c => names.includes(personKey(c.name)));
      const phoneConflict = nameHit.filter(c => { const ct = [c.phone, c.mobile, c.office_phone].map(normPhone).filter(x => x.length >= 9); return ct.length && tels.size && !ct.some(x => tels.has(x)); });
      if (nameHit.length && !phoneConflict.length) ev.push(`후보 거래처에 같은 이름 담당자 ${nameHit.map(c => c.name).join(", ")}(보조 근거)`);
      if (phoneConflict.length) bad.push(`같은 이름 담당자 연락처 불일치(${phoneConflict.map(c => c.name).join(", ")})`);
      if (String(t.reason).includes("다른 거래처도 가리킴")) bad.push(String(t.reason));
      if (String(t.reason).includes("법인·단체 유형")) bad.push(String(t.reason));
      const eDiff = entityDiff(String(t.crmName), String(co?.name ?? "")); if (eDiff.length) bad.push(`법인·단체 유형 차이(${eDiff.join("·")})`);
      if (BRANCH_ANY.test(String(t.crmName)) !== BRANCH_ANY.test(String(co?.name ?? ""))) bad.push("지점·본사·사무소 구분 차이");
      if (co?.customer_type === "INDIVIDUAL") bad.push("후보가 개인고객 유형");
      // 1차 검증에서 후보 거래처와 담당자(이름+연락처)·이메일·대표번호가 실제로 일치한 근거
      const verified = /담당자 .*일치|이메일 .*일치|대표번호 .*일치/.test(String(t.evidence ?? "")) && !String(t.evidence).includes("공용번호");
      if (verified) ev.unshift(`1차 확인: ${String(t.evidence).slice(0, 120)}`);
      const strong = !!exactPart || verified || ev.some(e => e.startsWith("영문 약어") || e.startsWith("조직 이메일"));
      row.match = ev.join(" / ") || "이름 유사만"; row.mismatch = bad.join(" / ");
      if (strong && !bad.length) { row.result = "A"; row.action = "기존 Master 에 별칭으로 연결(승인 후)"; }
      else if (bad.some(b => b.includes("연락처 불일치") || b.includes("다른 거래처도 가리킴")) && !strong) {
        row.result = "D"; row.action = bad.some(b => b.includes("연락처 불일치")) ? "연결하지 않음 — 같은 이름 담당자의 번호가 달라 다른 사람이거나 번호 변경 가능성, 직원 확인" : "연결하지 않음 — 원본 고객이 다른 거래처 소속일 가능성 확인"; }
      else { row.result = "C"; row.action = strong ? "근거 있으나 구분 확인 필요(지점·유형 등) — 직원 확인 후 연결" : "사업자번호·주소·견적서 등 추가 정보로 확인"; }
      // 담당자 연결 가능성(거래처 확정 가능한 경우만 의미) — 같은 거래처 소속만
      if (row.result === "A") {
        const per = names.map(n => { const raw = prog.find(p => personKey(p.cust) === n)!; const same = (ctByCo.get(cid) ?? []).filter(c => personKey(c.name) === n);
          const telHit = same.filter(c => [c.phone, c.mobile, c.office_phone].map(normPhone).some(x => tels.has(x)));
          return telHit.length === 1 ? `${raw.cust}: 연결 가능(이름+연락처)` : same.length === 1 ? `${raw.cust}: 이름 유일(확인 필요)` : same.length > 1 ? `${raw.cust}: 동명 ${same.length}명(검토)` : `${raw.cust}: 담당자 Master 없음(신규 등록 후보)`; });
        row.contactLink = per.join(" / ") || "원본 고객명 없음";
      }
      out.push(row);
    }
    out.sort((a, b) => a.result.localeCompare(b.result) || b.sales - a.sales);
    const grp = (f: (o: any) => boolean) => ({ names: out.filter(f).length, sales: out.filter(f).reduce((n, o) => n + o.sales, 0) });
    const sum = { byResult: Object.fromEntries(["A", "B", "C", "D"].map(r => [r, grp(o => o.result === r)])),
      fromPrevC: Object.fromEntries(["A", "B", "C", "D"].map(r => [r, grp(o => o.prevResult === "C" && o.result === r)])),
      fromPrevD: Object.fromEntries(["A", "B", "C", "D"].map(r => [r, grp(o => o.prevResult === "D" && o.result === r)])) };
    fs.mkdirSync(outDir!, { recursive: true });
    const cols = Object.keys(out[0] ?? {});
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(path.join(outDir!, "crm_company_verify2.csv"), "﻿" + [cols.join(","), ...out.map(o => cols.map(c => cell(o[c])).join(","))].join("\n"));
    fs.writeFileSync(path.join(outDir!, "crm_company_verify2.json"), JSON.stringify({ summary: sum, rows: out }, null, 2));
    console.log(JSON.stringify(sum, null, 2));
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
