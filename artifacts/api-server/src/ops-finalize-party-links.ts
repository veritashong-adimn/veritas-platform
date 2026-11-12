// ─── [운영 작업] 과거 CRM 거래처·담당자 연결 마무리(1회성, 관리자 승인 2026-11-12) ───────────────────────────
// 한 트랜잭션: 대상 확정·최종 중복 확인 → 변경 전 스냅샷 → 변경 → 범위 검증 → 감사기록. 하나라도 어긋나면 전체 ROLLBACK.
//   1) 확정 거래처 연결(별칭): 법무법인YK→#2993 · 한국전파진흥협회→#1450(법인표기 차이). 서울시청은 근거 부족으로 보류
//   2) 신규 거래처 8곳(최종 중복 확인 후): 원본에 있는 값만 저장(사업자번호·대표자·주소·이메일 생성 없음). 개인고객은 원본 연락처만.
//   3) 신규 담당자: 신규 거래처의 원본 고객명+개인번호가 있고 그 번호가 다른 담당자에 없을 때만
//   4) 판매 연결: 미전환 판매 = sale_contact 매핑 / 운영 전환 판매(엔도메디텍 #91) = projects.company_id·contact_id 만(기존 견적 출력 고정)
//   5) 공통 규칙(applyPartyLinks: 이름+이메일 / 이름+연락처 일치만)을 미연결 판매 전체에 적용
// 금지 범위(검증): 금액·수량·단가·부가세, 견적·판매·수행·청구·입금·지급·정산의 금액·상태, 과거 CRM 원본, 기존 거래처·담당자 값, 기존 연결.
// 실행: OPS_DB_URL=<env> OPS_OUT=<폴더> [OPS_COMMIT=1] pnpm run ops:finalize-party-links
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { normalizeCompanyName as N } from "./lib/normalizeCompany";
import { planPartyLinks, applyPartyLinks, PARTY_LINK_MODULE } from "./services/legacyPartyLink";
import { personKey, normPhone, phoneType } from "./services/legacyContactRestore";
import { freezeProjectQuotes } from "./services/quoteRecipientSnapshot";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.OPS_DB_URL, outDir = process.env.OPS_OUT, commit = process.env.OPS_COMMIT === "1";
if (!url || !outDir) { console.error("OPS_DB_URL, OPS_OUT 필요"); process.exit(2); }
const REASON = "과거 CRM 거래처·담당자 연결 마무리(관리자 승인 2026-11-12)";

const LINKS: Array<{ raw: string; companyId: number; companyName: string; basis: string; minCustomerHits?: number; expectSales?: number }> = [
  { raw: "법무법인YK (법무법인 와이케이)", companyId: 2993, companyName: "법무법인 와이케이", basis: "원본 표기 괄호 안 공식명 = Master 명, YK = 와이케이 영문 표기", expectSales: 10 },
  { raw: "한국전파진흥협회", companyId: 1450, companyName: "(특수법인)한국전파진흥협회", basis: "법인 형태 표기 '(특수법인)'만 다름" },
  // 서울시청→#276 서울특별시: 사전 점검에서 원본 고객 중 #276 담당자와 일치하는 사람이 1명뿐(기준 2명 이상 미달) → 보류
];
const CREATES: Array<{ raw: string; name: string; type: "CORPORATE" | "INDIVIDUAL"; saleNos: string[] }> = [
  { raw: "스피언스", name: "스피언스", type: "CORPORATE", saleNos: ["2026-11-06-0003", "2026-11-06-0002"] },
  { raw: "정보통신정책연구원", name: "정보통신정책연구원", type: "CORPORATE", saleNos: ["2026-11-05-0007"] },
  { raw: "뉴라테온", name: "뉴라테온", type: "CORPORATE", saleNos: ["2026-11-03-0005"] },
  { raw: "엔도메디텍", name: "엔도메디텍", type: "CORPORATE", saleNos: ["2026-10-26-0002"] },
  { raw: "한국산림복지진흥원", name: "한국산림복지진흥원", type: "CORPORATE", saleNos: ["2026-11-10-0004"] },
  { raw: "한국보건복지인재원", name: "한국보건복지인재원", type: "CORPORATE", saleNos: ["2026-11-09-0005"] },
  { raw: "이현정 (개인)", name: "이현정", type: "INDIVIDUAL", saleNos: ["2018-10-12-0003", "2018-09-13-0005"] },
  { raw: "고제이슨(개인고객)", name: "고제이슨", type: "INDIVIDUAL", saleNos: ["2026-11-09-0001"] },
];
class Abort extends Error {}

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  const report: any = { mode: commit ? "COMMIT" : "DRY_RUN(ROLLBACK)", reason: REASON, startedAt: new Date().toISOString(), checks: [], aliases: [], companies: [], contacts: [], saleLinks: [], projectUpdates: [], skipped: [] };
  const check = (label: string, ok: boolean, extra?: unknown) => { report.checks.push({ label, ok, ...(extra !== undefined ? { extra } : {}) }); if (!ok) throw new Abort(`검증 실패: ${label} ${extra !== undefined ? JSON.stringify(extra) : ""}`); };
  const L = (xs: Array<number | string>) => sql.join(xs.map(x => sql`${x}`), sql`, `);
  await client.query("BEGIN");
  try {
    await dbx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${PARTY_LINK_MODULE}))`);
    // ── 금지 범위 스냅샷(금액·상태·원본·기존 Master·기존 연결) ──
    const guard = async () => (await q(sql`SELECT
      (SELECT md5(string_agg(id||':'||price||status||coalesce(issue_date::text,'')||coalesce(deleted_at::text,''), ',' ORDER BY id)) FROM quotes) quotes,
      (SELECT md5(string_agg(id||':'||quantity||unit||unit_price||supply_amount||tax_amount||total_amount, ',' ORDER BY id)) FROM quote_items) items,
      (SELECT md5(string_agg(id||':'||status||financial_status||title||coalesce(admin_id::text,''), ',' ORDER BY id)) FROM projects) projects_state,
      (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM project_payments t) pp, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM payment_transactions t) pt,
      (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM settlements t) st, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM payout_round_items t) pri,
      (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM performance_assignments t) perf, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM payments t) pay,
      (SELECT md5(string_agg(id||':'||row_hash||is_effective, ',' ORDER BY id)) FROM legacy_archive_rows) legacy,
      (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM companies t) companies, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM contacts t) contacts,
      (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM company_aliases t) aliases, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM legacy_master_mappings t) mappings,
      (SELECT max(id) FROM companies) max_co, (SELECT max(id) FROM contacts) max_ct, (SELECT max(id) FROM company_aliases) max_al, (SELECT max(id) FROM legacy_master_mappings) max_mp`))[0];
    const g0 = await guard();
    const [batch] = await q(sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
      VALUES (${PARTY_LINK_MODULE}, 'finalize', ${REASON}, 0, 0, 'running', null, 'old_crm', false) RETURNING id`);
    const batchId = Number(batch.id);
    const lineage: any[] = [];
    const plan0 = new Map((await planPartyLinks(dbx as any)).map(r => [String(r.saleNo), r]));
    const salesOf = (raw: string) => [...plan0.values()].filter(r => String(r.rawCompany ?? "") === raw);

    // ── 1) 확정 거래처 연결(별칭) ──
    for (const l of LINKS) {
      const [co] = await q(sql`SELECT id, name, deleted_at FROM companies WHERE id = ${l.companyId}`);
      check(`#${l.companyId} '${l.companyName}' 살아 있음·이름 일치`, !!co && co.name === l.companyName && co.deleted_at == null, co);
      const ss = salesOf(l.raw);
      check(`'${l.raw}' 판매 모두 거래처 미등록(H)·미전환`, ss.length > 0 && ss.every(r => r.category === "H" && !r.converted), ss.map(r => [r.saleNo, r.category]));
      if (l.expectSales) check(`'${l.raw}' 판매 ${l.expectSales}건`, ss.length === l.expectSales, ss.length);
      if (l.minCustomerHits) {
        // 원본 고객(이름+개인번호)이 가리키는 거래처 — 대상 거래처만, 2명 이상
        const prog = await q(sql`SELECT btrim(p.source_raw->>'고객명') cust, p.source_raw->>'연락처' tel FROM legacy_sales_progress_links k
          JOIN legacy_archive_rows p ON p.id = k.progress_row_id AND p.is_effective WHERE k.decision='confirmed' AND k.sale_row_id IN (${L(ss.map(r => r.saleRowId))})`);
        const cts = await q(sql`SELECT id, company_id, name, phone, mobile, office_phone FROM contacts WHERE deleted_at IS NULL`);
        const pointed = new Map<number, Set<string>>();
        for (const p of prog) for (const c of cts) if (personKey(c.name) === personKey(p.cust) && [c.phone, c.mobile, c.office_phone].map(normPhone).includes(normPhone(p.tel)) && normPhone(p.tel).length >= 9)
          (pointed.get(Number(c.company_id)) ?? pointed.set(Number(c.company_id), new Set()).get(Number(c.company_id))!).add(personKey(p.cust));
        check(`'${l.raw}' 원본 고객이 #${l.companyId} 만 가리키고 ${l.minCustomerHits}명 이상`, pointed.size === 1 && pointed.has(l.companyId) && pointed.get(l.companyId)!.size >= l.minCustomerHits, [...pointed.entries()].map(([k, v]) => [k, [...v]]));
      }
      const [a] = await q(sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary) VALUES (${l.companyId}, ${l.raw}, ${N(l.raw)}, false)
        ON CONFLICT (company_id, normalized_alias) DO NOTHING RETURNING id`);
      if (a) { report.aliases.push({ aliasId: Number(a.id), companyId: l.companyId, alias: l.raw, sales: ss.map(r => r.saleNo) });
        lineage.push({ entityId: Number(a.id), rowKey: `alias:${a.id}`, status: "alias_added", legacyId: ss[0].saleNo, sourceRaw: { companyId: l.companyId, alias: l.raw, basis: l.basis, saleNos: ss.map(r => r.saleNo), before: { companyId: null }, after: { companyId: l.companyId } } }); }
    }

    // ── 2) 신규 거래처 + 3) 신규 담당자 + 4) 판매 연결 ──
    const allCos = await q(sql`SELECT id, name, deleted_at, phone, mobile FROM companies`);
    const allAliases = await q(sql`SELECT company_id, normalized_alias FROM company_aliases`);
    const allContacts = await q(sql`SELECT id, company_id, name, phone, mobile, office_phone FROM contacts WHERE deleted_at IS NULL`);
    for (const c of CREATES) {
      const ss = c.saleNos.map(s => plan0.get(s));
      check(`'${c.raw}' 판매 ${c.saleNos.length}건 존재·원본 표기 일치·거래처 미등록`, ss.every(r => !!r && r.rawCompany === c.raw && r.category === "H"), ss.map(r => r && [r.saleNo, r.rawCompany, r.category]));
      // 최종 중복 확인 — 정규화 이름(현재·삭제)·별칭·원본 연락처
      const keys = new Set([N(c.name), N(c.raw)]);
      const dupName = allCos.filter(x => keys.has(N(x.name)));
      const dupAlias = allAliases.filter(x => keys.has(String(x.normalized_alias)));
      const prog = await q(sql`SELECT btrim(p.source_raw->>'고객명') cust, p.source_raw->>'연락처' tel, p.source_raw->>'비고' memo FROM legacy_sales_progress_links k
        JOIN legacy_archive_rows p ON p.id = k.progress_row_id AND p.is_effective WHERE k.decision='confirmed' AND k.sale_row_id IN (${L(ss.map(r => r!.saleRowId))})`);
      const custs = [...new Map(prog.filter(p => p.cust && /[가-힣A-Za-z]/.test(p.cust)).map(p => [personKey(p.cust), p])).values()];
      const tels = [...new Set(prog.map(p => normPhone(p.tel)).filter(t => t.length >= 9))];
      const telDup = [...allCos.filter(x => [x.phone, x.mobile].map(normPhone).some(t => tels.includes(t))).map(x => `거래처#${x.id}`),
        ...allContacts.filter(x => [x.phone, x.mobile, x.office_phone].map(normPhone).some(t => tels.includes(t))).map(x => `담당자#${x.id}(${x.name})`)];
      if (dupName.length || dupAlias.length || telDup.length) { report.skipped.push({ raw: c.raw, reason: "최종 중복 확인에서 기존 정보 발견 — 신규 등록 보류", dupName: dupName.map(x => x.id), dupAlias: dupAlias.map(x => x.company_id), telDup }); continue; }
      const indTel = c.type === "INDIVIDUAL" && tels.length === 1 ? tels[0] : null;
      const notes = `과거 CRM 판매 거래처 등록(판매 ${c.saleNos.join(", ")} · 배치 ${batchId}) — 원본에 사업자번호·대표자·주소 없음${c.type === "INDIVIDUAL" ? " · 개인고객" : ""}`;
      const [co] = await q(sql`INSERT INTO companies (name, notes, is_customer, customer_type, mobile) VALUES (${c.name}, ${notes}, true, ${c.type}, ${indTel && phoneType(indTel) === "mobile" ? indTel : null}) RETURNING id`);
      const coId = Number(co.id);
      await dbx.execute(sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary) VALUES (${coId}, ${c.name}, ${N(c.name)}, true) ON CONFLICT DO NOTHING`);
      if (N(c.raw) !== N(c.name)) await dbx.execute(sql`INSERT INTO company_aliases (company_id, alias_name, normalized_alias, is_primary) VALUES (${coId}, ${c.raw}, ${N(c.raw)}, false) ON CONFLICT DO NOTHING`);
      report.companies.push({ companyId: coId, name: c.name, type: c.type, raw: c.raw, mobile: indTel, sales: c.saleNos });
      lineage.push({ entityId: coId, rowKey: `company:${coId}`, status: "company_created", legacyId: c.saleNos[0], sourceRaw: { name: c.name, raw: c.raw, type: c.type, mobile: indTel, saleNos: c.saleNos, basis: "기존 Master·별칭·삭제 거래처·원본 연락처 중복 없음" } });
      // 담당자(법인만): 원본 고객 1명 + 개인번호 1개일 때만
      let contactId: number | null = null;
      if (c.type === "CORPORATE" && custs.length === 1) {
        const p = custs[0]; const t = normPhone(p.tel); const ty = phoneType(t);
        if (t.length >= 9 && (ty === "mobile" || ty === "landline")) {
          const [ct] = await q(sql`INSERT INTO contacts (company_id, name, mobile, phone, memo) VALUES (${coId}, ${String(p.cust).trim()}, ${ty === "mobile" ? t : null}, ${ty === "landline" ? t : null},
            ${`과거 CRM 원본 고객(판매 ${c.saleNos.join(", ")}) — 이름·연락처 원본 그대로`}) RETURNING id`);
          contactId = Number(ct.id);
          report.contacts.push({ contactId, companyId: coId, name: String(p.cust).trim(), phone: t, type: ty });
          lineage.push({ entityId: contactId, rowKey: `contact:${contactId}`, status: "contact_created", legacyId: c.saleNos[0], sourceRaw: { companyId: coId, name: p.cust, phone: t, phoneType: ty, saleNos: c.saleNos } });
        } else report.skipped.push({ raw: c.raw, reason: "담당자 신규 등록 보류 — 원본 개인번호 없음", customer: p.cust ?? null });
      } else if (c.type === "CORPORATE") report.skipped.push({ raw: c.raw, reason: custs.length ? "담당자 보류 — 원본 고객명 복수" : "담당자 보류 — 원본 고객명 없음" });
      for (const r of ss) {
        if (r!.converted) {
          // 운영 전환 판매 — 참조 ID 만(기존 견적 수신자 출력은 바꾸기 전 값으로 고정)
          const [pj] = await q(sql`SELECT p.id, p.company_id, p.contact_id FROM projects p JOIN legacy_master_mappings m ON m.entity_id = p.id AND m.entity_type='sale' AND m.status='active' WHERE m.legacy_id = ${r!.saleNo} FOR UPDATE OF p`);
          check(`${r!.saleNo}: 운영 판매 거래처·담당자 비어 있음(기존 연결 덮어쓰기 없음)`, !!pj && pj.company_id == null && pj.contact_id == null, pj);
          const frozen = await freezeProjectQuotes(dbx as any, Number(pj.id));
          await dbx.execute(sql`UPDATE projects SET company_id = ${coId}, contact_id = ${contactId} WHERE id = ${pj.id}`);
          report.projectUpdates.push({ projectId: Number(pj.id), saleNo: r!.saleNo, before: { companyId: null, contactId: null }, after: { companyId: coId, contactId }, frozenQuotes: frozen });
          lineage.push({ entityId: Number(pj.id), rowKey: `project:${pj.id}`, status: "project_linked", legacyId: r!.saleNo, sourceRaw: { before: { companyId: null, contactId: null }, after: { companyId: coId, contactId }, frozenQuotes: frozen } });
          await dbx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, metadata) VALUES ('project', ${pj.id}, 'legacy_sale_party_linked', null,
            ${JSON.stringify({ saleNo: r!.saleNo, reason: REASON, batchId, before: { companyId: null, contactId: null }, after: { companyId: coId, contactId }, frozenQuotes: frozen })})`);
        } else if (contactId) {
          const [m] = await q(sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, import_batch_id, match_method, status)
            VALUES ('old_crm', 'sale_contact', ${r!.saleNo}, ${contactId}, ${batchId}, 'party_new_contact', 'active') ON CONFLICT (source_system, entity_type, legacy_id) DO NOTHING RETURNING id`);
          if (m) { report.saleLinks.push({ saleNo: r!.saleNo, contactId, via: "new_contact" });
            lineage.push({ entityId: Number(m.id), rowKey: `sale_contact:${r!.saleNo}`, status: "contact_linked", legacyId: r!.saleNo, sourceRaw: { before: null, after: { contactId }, basis: "신규 담당자(원본 고객명+연락처)" } }); }
        }
      }
    }
    for (let i = 0; i < lineage.length; i += 200)
      await dbx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw) VALUES
        ${sql.join(lineage.slice(i, i + 200).map(x => sql`(${batchId}, ${PARTY_LINK_MODULE}, ${x.entityId}, ${x.rowKey}, ${x.status}, 'old_crm', ${x.legacyId ?? null}, ${JSON.stringify({ ...x.sourceRaw, reason: REASON })}::jsonb)`), sql`, `)}`);
    await dbx.execute(sql`UPDATE import_batches SET success_rows = ${lineage.length}, status = 'completed', headers_json = ${JSON.stringify({ aliases: report.aliases.length, companies: report.companies.length, contacts: report.contacts.length, saleLinks: report.saleLinks.length, projectUpdates: report.projectUpdates.length })}::jsonb WHERE id = ${batchId}`);

    // ── 5) 공통 규칙 — 미연결 판매 전체(이름+이메일 / 이름+연락처 일치만) ──
    const gen = await applyPartyLinks(dbx as any, { userId: null, reason: `${REASON} — 공통 규칙` });
    report.general = gen;

    // ── 범위 검증 ──
    const g1 = await guard();
    for (const k of ["quotes", "items", "projects_state", "pp", "pt", "st", "pri", "perf", "pay", "legacy"]) check(`불변: ${k}`, g0[k] === g1[k]);
    const prevCo = await q(sql`SELECT md5(string_agg(t::text, ',' ORDER BY id)) h FROM companies t WHERE id <= ${g0.max_co}`);
    const prevCt = await q(sql`SELECT md5(string_agg(t::text, ',' ORDER BY id)) h FROM contacts t WHERE id <= ${g0.max_ct}`);
    const prevAl = await q(sql`SELECT md5(string_agg(t::text, ',' ORDER BY id)) h FROM company_aliases t WHERE id <= ${g0.max_al}`);
    const prevMp = await q(sql`SELECT md5(string_agg(t::text, ',' ORDER BY id)) h FROM legacy_master_mappings t WHERE id <= ${g0.max_mp}`);
    check("기존 거래처 값 불변", prevCo[0].h === g0.companies); check("기존 담당자 값 불변", prevCt[0].h === g0.contacts);
    check("기존 별칭 불변", prevAl[0].h === g0.aliases); check("기존 연결 불변", prevMp[0].h === g0.mappings);
    const plan1 = await planPartyLinks(dbx as any);
    const by = (f: (r: any) => boolean) => plan1.filter(f).length;
    report.after = { total: plan1.length, byCategory: plan1.reduce((a: any, r) => { a[r.category] = (a[r.category] ?? 0) + 1; return a; }, {}),
      contactLinked: by(r => !!r.linked && r.linked.check !== "conflict"), individualCompanyOnly: by(r => r.category === "A" && !r.linked) };
    report.before = { byCategory: [...plan0.values()].reduce((a: any, r) => { a[r.category] = (a[r.category] ?? 0) + 1; return a; }, {}) };
    report.batchId = batchId;
    if (commit) { await client.query("COMMIT"); report.committed = true; } else { await client.query("ROLLBACK"); report.committed = false; }
  } catch (e: any) {
    await client.query("ROLLBACK").catch(() => {}); report.committed = false; report.error = e?.message ?? String(e);
  } finally {
    client.release(); await pool.end();
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, `finalize_report_${commit ? "commit" : "dryrun"}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ mode: report.mode, committed: report.committed, error: report.error ?? null, failed: report.checks.filter((c: any) => !c.ok), checks: report.checks.length,
      batchId: report.batchId, aliases: report.aliases.map((a: any) => `${a.alias}→#${a.companyId}(${a.sales.length}건)`), companies: report.companies.map((c: any) => `#${c.companyId} ${c.name}(${c.type})`),
      contacts: report.contacts.map((c: any) => `#${c.contactId} ${c.name}@#${c.companyId}`), saleLinks: report.saleLinks.length, projectUpdates: report.projectUpdates, skipped: report.skipped,
      general: report.general, before: report.before, after: report.after }, null, 2));
  }
  process.exit(report.error ? 1 : 0);
}
main();
