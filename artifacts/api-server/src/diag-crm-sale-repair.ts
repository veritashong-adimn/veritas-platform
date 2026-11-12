// ─── 과거 CRM 판매·청구·담당자 보정 — 변경 예정 목록 산출(읽기 전용) ─────────────────────────────
// 실행: DIAG_DB_URL=<env> DIAG_OUT=<폴더> pnpm run diag:crm-sale-repair
//   BEGIN TRANSACTION READ ONLY 로만 조회 후 ROLLBACK. 접속 문자열은 출력하지 않는다.
//   · 견적 품목(수량·단가): planItemRestore(전환 판매) + decideItemDetail(미전환 판매 — 앞으로 전환 시 적용될 결과)
//   · 청구정보: planBillingRestore / 담당자 이메일: planContactEmailFill / 담당자 연결: planPartyLinks(기존 공통 규칙)
//   · 킨텍스(2026-06-22-0003) 변경 전후 미리보기
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { planItemRestore, decideItemDetail } from "./services/legacyQuoteItemRestore";
import { planBillingRestore, planContactEmailFill, BILLING_STATUS_LABEL } from "./services/legacySaleRepair";
import { planPartyLinks, summarizePartyLinks } from "./services/legacyPartyLink";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL, outDir = process.env.DIAG_OUT;
if (!url || !outDir) { console.error("DIAG_DB_URL, DIAG_OUT 필요"); process.exit(2); }
const num = (v: unknown) => { const s = String(v ?? "").replace(/,/g, "").trim(); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
const by = <T,>(xs: T[], f: (x: T) => string) => xs.reduce((a: Record<string, number>, x) => { const k = f(x); a[k] = (a[k] ?? 0) + 1; return a; }, {});
const KINTEX = "2026-06-22-0003";

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  try {
    if ((await q(sql`SELECT current_setting('transaction_read_only') ro`))[0].ro !== "on") throw new Error("읽기 전용 아님 — 중단");

    // 1) 견적 품목 — 전환 판매
    const items = await planItemRestore(dbx as any);
    const itemCheck = items.filter(r => r.after).map(r => ({ saleNo: r.saleNo, quoteNumber: r.quoteNumber, before: r.before, after: r.after,
      qtyTimesPriceEqSupply: Math.abs(r.after!.quantity * r.after!.unitPrice - r.before!.supplyAmount) <= 1, unitCheck: r.unitCheck }));
    // 1b) 미전환 판매 — 새 규칙으로 전환 시 복원될 수 있는 수(참고)
    const sales = await q(sql`SELECT s.id, s.total_amount, s.source_raw->>'판매번호' sale_no FROM legacy_archive_rows s WHERE s.source_type='sales_list' AND s.is_effective`);
    const progBySale = new Map<number, any[]>();
    for (const r of await q(sql`SELECT l.sale_row_id, p.source_raw FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective WHERE l.decision = 'confirmed'`))
      (progBySale.get(Number(r.sale_row_id)) ?? progBySale.set(Number(r.sale_row_id), []).get(Number(r.sale_row_id))!).push(r.source_raw ?? {});
    const converted = new Set(items.map(i => i.saleNo));
    const archive = sales.filter(s => !converted.has(String(s.sale_no))).map(s => {
      const prog = progBySale.get(Number(s.id)) ?? [];
      const total = num(s.total_amount) ?? 0;
      const pairs = [...new Set(prog.map(r => `${num(r["공급가액"])}|${num(r["부가세"])}`))];
      let supply = total;
      if (pairs.length === 1) { const [a, b] = pairs[0].split("|").map(x => (x === "null" ? null : Number(x))); if (a != null && b != null && Math.abs(a + b - total) <= 1 && b > 0 && Math.abs(b - a * 0.1) <= 1) supply = a; }
      const d = decideItemDetail(prog, supply);
      return { status: d.status, kind: ("detail" in d && d.detail?.kind) || (prog[0]?.["내용"] ?? "-"), qtyNot1: d.status === "restorable" && d.detail.quantity !== 1 };
    });

    // 2) 청구정보
    const billing = await planBillingRestore(dbx as any);
    // 3) 담당자 이메일
    const emails = await planContactEmailFill(dbx as any);
    // 4) 담당자 연결 — 기존 공통 규칙(이름+이메일 / 이름+연락처)
    const party = await planPartyLinks(dbx as any);
    const partySum = summarizePartyLinks(party);

    // 5) 중복 거래처(과거 CRM 자동등록 · 사업자번호 없음 ↔ 같은 이름 사업자번호 있음)
    const dupCompanies = await q(sql`SELECT a.normalized_alias, json_agg(json_build_object('id', c.id, 'name', c.name, 'brn', c.business_number, 'created', c.created_at::date,
        'contacts', (SELECT count(*) FROM contacts x WHERE x.company_id = c.id AND x.deleted_at IS NULL),
        'saleLinks', (SELECT count(*) FROM legacy_master_mappings mm JOIN contacts x ON x.id = mm.entity_id WHERE mm.entity_type='sale_contact' AND mm.status='active' AND x.company_id = c.id),
        'projects', (SELECT count(*) FROM projects pr WHERE pr.company_id = c.id)) ORDER BY c.id) cos
      FROM company_aliases a JOIN companies c ON c.id = a.company_id AND c.deleted_at IS NULL GROUP BY 1
      HAVING count(DISTINCT c.id) > 1 AND bool_or(coalesce(c.business_number,'') = '') AND bool_or(coalesce(c.business_number,'') <> '')`);

    // 6) 킨텍스 미리보기
    const kItem = items.find(i => i.saleNo === KINTEX), kBill = billing.find(b => b.saleNo === KINTEX);
    const [kProj] = await q(sql`SELECT p.id, p.company_id, p.contact_id, p.financial_status FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id WHERE m.entity_type='sale' AND m.status='active' AND m.legacy_id = ${KINTEX}`);
    const kContacts = await q(sql`SELECT c.id, c.company_id, co.name company, co.business_number brn, c.name, c.position, c.phone, c.email FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id IN (5161, 7253) ORDER BY c.id`);
    const [kQuote] = await q(sql`SELECT id, quote_number, customer_company_name, customer_contact_name, customer_contact_phone, customer_contact_email FROM quotes WHERE project_id = ${kProj?.id ?? 0} AND is_current AND deleted_at IS NULL`);
    const kPerf = await q(sql`SELECT count(*) n FROM performance_assignments WHERE project_id = ${kProj?.id ?? 0}`);

    const summary = {
      items: { converted: items.length, byStatus: by(items, r => r.status), restorable: itemCheck.length, allQtyTimesPriceEqSupply: itemCheck.every(c => c.qtyTimesPriceEqSupply),
        archiveFuture: { total: archive.length, byStatusKind: by(archive, a => `${a.status}:${a.kind}`), restorableQtyNot1ByKind: by(archive.filter(a => a.qtyNot1), a => String(a.kind)) } },
      billing: { converted: billing.length, byStatus: by(billing, b => `${b.status} (${BILLING_STATUS_LABEL[b.status]})`) },
      email: { candidates: emails.length, byStatus: by(emails, e => e.status) },
      partyLinks: partySum,
      duplicateCompanyGroups: dupCompanies.length,
    };
    const out = {
      summary,
      kintex: { project: kProj, item: kItem, billing: kBill, contacts: kContacts, quote: kQuote, performances: kPerf[0] },
      itemRestorable: itemCheck, itemOthers: items.filter(r => !r.after).map(r => ({ saleNo: r.saleNo, quoteNumber: r.quoteNumber, status: r.status, reason: r.reason })),
      billing: billing.map(b => ({ saleNo: b.saleNo, projectId: b.projectId, quoteNumber: b.quoteNumber, status: b.status, reason: b.reason, source: b.source, quote: b.quote, payments: b.payments, after: b.after })),
      emails, duplicateCompanies: dupCompanies,
    };
    fs.mkdirSync(outDir!, { recursive: true });
    fs.writeFileSync(path.join(outDir!, "sale-repair-plan.json"), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
