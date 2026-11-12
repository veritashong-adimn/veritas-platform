// 과거 CRM 판매 중 거래처 Master 미등록(H) 거래처명 분석(읽기 전용) — 기존 판정 재사용:
//   planPartyLinks(H 판정) + planCompanyLinks(기존 거래처 복원 판정: 관리자 확인·표기 차이·과거 상호·담당자 근거·신규·검토).
//   보조 확인: 원본 연락처가 기존 거래처 대표번호·담당자 번호와 일치하면 '신규 등록'으로 두지 않고 검토(중복 등록 방지).
// 분류: A 표기 차이(기존 Master 존재) · B 고유 식별정보(사업자번호) 확인 · C 신규 등록 필요 · D 개인고객 표기 · E 수동 검토
// 실행: DIAG_DB_URL=<env> DIAG_OUT=<폴더> pnpm run diag:crm-unregistered-companies
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { normalizeCompanyName as N } from "./lib/normalizeCompany";
import { planPartyLinks, individualNameOf } from "./services/legacyPartyLink";
import { planCompanyLinks, COMPANY_REVIEW_LABEL, LINK_BASIS_LABEL, CREATE_KIND_LABEL } from "./services/legacyCompanyRestore";
import { normPhone } from "./services/legacyContactRestore";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL, outDir = process.env.DIAG_OUT;
if (!url || !outDir) { console.error("DIAG_DB_URL, DIAG_OUT 필요"); process.exit(2); }

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  try {
    if ((await q(sql`SELECT current_setting('transaction_read_only') ro`))[0].ro !== "on") throw new Error("읽기 전용 아님 — 중단");
    const party = await planPartyLinks(dbx as any);
    const H = party.filter(r => r.category === "H");
    const groupsH = new Map<string, { key: string; raws: Map<string, number>; saleNos: string[]; saleRowIds: number[] }>();
    for (const r of H) {
      const k = N(r.rawCompany ?? "") || "(빈 거래처명)";
      const g = groupsH.get(k) ?? groupsH.set(k, { key: k, raws: new Map(), saleNos: [], saleRowIds: [] }).get(k)!;
      g.raws.set(String(r.rawCompany ?? ""), (g.raws.get(String(r.rawCompany ?? "")) ?? 0) + 1); g.saleNos.push(String(r.saleNo)); g.saleRowIds.push(r.saleRowId);
    }
    const cg = new Map((await planCompanyLinks(dbx as any)).map(g => [g.key, g]));
    // 보조 근거: 원본 연락처 ↔ 기존 거래처 대표번호·담당자 번호
    const coName = new Map((await q(sql`SELECT id, name FROM companies WHERE deleted_at IS NULL`)).map(c => [Number(c.id), String(c.name)]));
    const telCo = new Map<string, Set<number>>();
    const addT = (t: string, id: number) => { if (t.length >= 9) (telCo.get(t) ?? telCo.set(t, new Set()).get(t)!).add(id); };
    for (const c of await q(sql`SELECT id, phone, mobile FROM companies WHERE deleted_at IS NULL`)) for (const t of [c.phone, c.mobile]) addT(normPhone(t), Number(c.id));
    for (const c of await q(sql`SELECT company_id, phone, mobile, office_phone FROM contacts WHERE deleted_at IS NULL AND company_id IS NOT NULL`)) for (const t of [c.phone, c.mobile, c.office_phone]) addT(normPhone(t), Number(c.company_id));
    const allIds = [...groupsH.values()].flatMap(g => g.saleRowIds);
    const telsBySale = new Map<number, string[]>();
    if (allIds.length) for (const r of await q(sql`SELECT l.sale_row_id, p.source_raw->>'연락처' tel FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
        WHERE l.decision = 'confirmed' AND l.sale_row_id IN (${sql.join(allIds.map(i => sql`${i}`), sql`, `)})`))
      (telsBySale.get(Number(r.sale_row_id)) ?? telsBySale.set(Number(r.sale_row_id), []).get(Number(r.sale_row_id))!).push(normPhone(r.tel));

    const out: any[] = [];
    for (const g of groupsH.values()) {
      const raw = [...g.raws.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const c = cg.get(g.key);
      const tels = [...new Set(g.saleRowIds.flatMap(id => telsBySale.get(id) ?? []))].filter(t => t.length >= 9);
      const telHits = [...new Set(tels.flatMap(t => [...(telCo.get(t) ?? [])]))];
      const ind = individualNameOf(raw); const bare = /^(개인|개인고객|개인 고객)$/.test(raw.trim());
      let type: "A" | "B" | "C" | "D" | "E"; let cause = ""; let action = ""; let auto = false; let master: { id: number; name: string } | null = null;
      if (ind || bare || c?.kind === "individual" || (c?.decision === "review" && c.reason === "generic")) {
        type = "D";
        cause = bare ? "이름 없는 '개인고객' 묶음 표기 — 고객 특정 불가" : `개인고객${ind ? ` '${ind}'` : ""} — 같은 이름의 개인고객 Master 없음`;
        action = bare ? "판매별 고객명(진행관리표)으로 개인고객 확인 후 개별 처리" : "개인고객 Master 신규 등록 후 연결(동명 확인)";
      } else if (c?.decision === "link" && c.companyId) {
        master = { id: c.companyId, name: c.companyName ?? coName.get(c.companyId) ?? "" };
        type = c.basis === "confirmed" ? "B" : "A";
        cause = `${LINK_BASIS_LABEL[c.basis!] ?? c.basis}${c.detail ? ` — ${c.detail}` : ""}`;
        action = "기존 Master 에 별칭으로 연결"; auto = true;
      } else if (c?.decision === "create") {
        if (telHits.length) { type = "E"; cause = `신규 후보이나 원본 연락처가 기존 거래처와 일치: ${telHits.map(id => `${coName.get(id)}(#${id})`).join(", ")}`; action = "기존 거래처와 동일 여부 확인"; }
        else { type = "C"; cause = `기존 Master 후보 없음(${CREATE_KIND_LABEL[c.kind!] ?? c.kind})`; action = "신규 거래처 등록 후 연결"; }
      } else if (c?.decision === "review") {
        type = "E"; cause = `${COMPANY_REVIEW_LABEL[c.reason!] ?? c.reason}${c.candidates?.length ? ` — 후보 ${c.candidates.slice(0, 3).map(x => `${x.name}(#${x.id})`).join(", ")}` : ""}`;
        action = "관리자 확인"; if (c.candidates?.length === 1) master = { id: c.candidates[0].id, name: c.candidates[0].name };
      } else {
        type = telHits.length ? "E" : "C";
        cause = telHits.length ? `원본 연락처가 기존 거래처와 일치: ${telHits.map(id => `${coName.get(id)}(#${id})`).join(", ")}` : "기존 Master 후보 없음";
        action = telHits.length ? "기존 거래처와 동일 여부 확인" : "신규 거래처 등록 후 연결";
      }
      out.push({ crmName: raw, variants: [...g.raws.keys()].join(" | "), sales: g.saleNos.length, type, masterExists: !!master || (type === "E" && telHits.length > 0),
        masterId: master?.id ?? null, masterName: master?.name ?? null, brnMatch: type === "B" ? "관리자 확인 대상(사업자번호로 Master 확정)" : "원본에 사업자번호 없음",
        cause, action, autoLinkable: auto, manualReview: type === "E" || (type === "D" && bare), telHits: telHits.join("/"), saleNos: g.saleNos.join(" ") });
    }
    out.sort((a, b) => a.type.localeCompare(b.type) || b.sales - a.sales);
    const sum: any = { names: out.length, sales: out.reduce((n, o) => n + o.sales, 0), hSalesNow: H.length, byType: {} };
    for (const t of ["A", "B", "C", "D", "E"]) sum.byType[t] = { names: out.filter(o => o.type === t).length, sales: out.filter(o => o.type === t).reduce((n, o) => n + o.sales, 0) };
    sum.autoLinkable = { names: out.filter(o => o.autoLinkable).length, sales: out.filter(o => o.autoLinkable).reduce((n, o) => n + o.sales, 0) };
    sum.newRegistration = { corporate: out.filter(o => o.type === "C").length, individualNamed: out.filter(o => o.type === "D" && !/^(개인|개인고객|개인 고객)$/.test(o.crmName.trim())).length };
    sum.manualReview = { names: out.filter(o => o.manualReview).length, sales: out.filter(o => o.manualReview).reduce((n, o) => n + o.sales, 0) };
    fs.mkdirSync(outDir!, { recursive: true });
    const cols = Object.keys(out[0] ?? {});
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(path.join(outDir!, "crm_unregistered_companies.csv"), "﻿" + [cols.join(","), ...out.map(o => cols.map(c => cell(o[c])).join(","))].join("\n"));
    fs.writeFileSync(path.join(outDir!, "crm_unregistered_companies.json"), JSON.stringify({ summary: sum, rows: out }, null, 2));
    console.log(JSON.stringify(sum, null, 2));
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); await pool.end(); }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
