// ─── 과거 CRM 견적 품목 상세정보 누락 진단(읽기 전용) ─────────────────────────────────
// 실행: DIAG_DB_URL=<env> DIAG_OUT=<폴더> pnpm run diag:crm-quote-items
//   BEGIN TRANSACTION READ ONLY 로만 조회 후 ROLLBACK. 접속 문자열은 출력하지 않는다.
// 모집단: 유효 과거 CRM 판매목록 행 전체. 운영 전환 판매(플랫폼 견적 있음)와 보관 자료(견적 없음)를 구분한다.
//   · 원본 상세 = 확정 연결된 진행관리표 행(수행 단위). 판매목록 원본에는 품목 상세 칸이 없다.
//   · 견적 원본 확인 가능 = decideItemDetail 이 품목 1개 값으로 확정(restorable)한 판매
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";
import { pool as appPool } from "@workspace/db";
import { decideItemDetail, sourceDetailOf, planItemRestore } from "./services/legacyQuoteItemRestore";

const Pool = appPool.constructor as new (o: { connectionString: string }) => typeof appPool;
const url = process.env.DIAG_DB_URL, outDir = process.env.DIAG_OUT;
if (!url || !outDir) { console.error("DIAG_DB_URL, DIAG_OUT 필요"); process.exit(2); }
const num = (v: unknown) => { const s = String(v ?? "").replace(/,/g, "").trim(); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; };

async function main() {
  const pool = new Pool({ connectionString: url! });
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");
  const dbx = drizzle(client as any);
  const q = async (s: any) => (await dbx.execute(s)).rows as any[];
  try {
    if ((await q(sql`SELECT current_setting('transaction_read_only') ro`))[0].ro !== "on") throw new Error("읽기 전용 아님 — 중단");
    const sales = await q(sql`SELECT s.id, s.source_raw->>'판매번호' sale_no, s.company_name, s.product_name, s.total_amount FROM legacy_archive_rows s WHERE s.source_type = 'sales_list' AND s.is_effective`);
    const progBySale = new Map<number, any[]>();
    for (const r of await q(sql`SELECT l.sale_row_id, p.source_raw FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective WHERE l.decision = 'confirmed'`))
      (progBySale.get(Number(r.sale_row_id)) ?? progBySale.set(Number(r.sale_row_id), []).get(Number(r.sale_row_id))!).push(r.source_raw ?? {});
    const converted = new Map((await q(sql`SELECT m.legacy_id, p.id pid FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active'`)).map(r => [String(r.legacy_id), Number(r.pid)]));

    const out: any[] = [];
    for (const s of sales) {
      const prog = progBySale.get(Number(s.id)) ?? [];
      const total = num(s.total_amount);
      // 공급가액: 진행행 (공급가액, 부가세)가 하나이고 합계 = 총액일 때(전환 로직과 같은 기준), 아니면 총액
      const pairs = [...new Set(prog.map(r => `${num(r["공급가액"])}|${num(r["부가세"])}`))];
      let supply = total ?? 0;
      if (pairs.length === 1) { const [a, b] = pairs[0].split("|").map(x => (x === "null" ? null : Number(x))); if (a != null && b != null && total != null && Math.abs(a + b - total) <= 1 && b > 0 && Math.abs(b - a * 0.1) <= 1) supply = a; }
      const dec = decideItemDetail(prog, supply);
      const ds = prog.map(sourceDetailOf);
      const any = (f: (d: ReturnType<typeof sourceDetailOf>) => unknown) => ds.some(d => !!f(d));
      const d = "detail" in dec ? dec.detail : undefined;
      out.push({
        saleNo: s.sale_no, scope: converted.has(String(s.sale_no)) ? "운영전환" : "과거CRM보관", company: s.company_name, product: s.product_name, total, supply,
        progressRows: prog.length, decision: dec.status, reason: "reason" in dec ? dec.reason : null,
        kind: d?.kind ?? ds[0]?.kind ?? null, srcQty: d?.quantity ?? null, srcVolumeBasis: d?.volumeBasis ?? null, srcUnitPrice: d?.unitPrice ?? null,
        srcFileName: d?.fileName ?? null, srcWords: d?.wordCount ?? null, srcChars: d?.charCount ?? null,
        hasFileName: any(x => x.fileName), hasCounts: any(x => x.wordCount || x.charCount), hasMemo: any(x => x.memo),
        // 기존 전환 로직(1 × 공급가액, 건, 비고 없음)으로 만들 때 원본과 달라지는 항목 — 확인 가능한 판매만
        lostQty: dec.status === "restorable" && dec.detail.quantity !== 1,
        lostUnitPrice: dec.status === "restorable" && Math.abs((dec.detail.unitPrice ?? 0) - supply) > 0.005,
        volumeBasis: dec.status === "restorable" ? dec.detail.volumeBasis : null,   // 원본 '단위' = 분량 산정 기준(거래 단위 아님)
        lostFileName: dec.status === "restorable" && !!dec.detail.fileName,
        lostCounts: dec.status === "restorable" && !!(dec.detail.wordCount || dec.detail.charCount),
      });
    }
    const conv = await planItemRestore(dbx as any);
    const convInfo = new Map(conv.map(c => [c.saleNo, c]));
    for (const o of out) { const c = convInfo.get(String(o.saleNo)); if (c) Object.assign(o, { quoteNumber: c.quoteNumber, restoreStatus: c.status, restoreReason: c.reason,
      platformQty: c.before?.quantity ?? null, platformUnit: c.before?.unit ?? null, platformUnitPrice: c.before?.unitPrice ?? null, platformMemo: c.before?.memo ?? null,
      platformSupply: c.before?.supplyAmount ?? null, platformTotal: c.before?.totalAmount ?? null }); }
    const quotePrice = new Map((await q(sql`SELECT m.legacy_id, sum(q.price) price FROM legacy_master_mappings m JOIN quotes q ON q.project_id = m.entity_id AND q.deleted_at IS NULL AND q.is_current
      WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active' GROUP BY 1`)).map(r => [String(r.legacy_id), Number(r.price)]));

    const cnt = (xs: any[], f: (o: any) => boolean) => xs.filter(f).length;
    const by = (xs: any[], k: string) => xs.reduce((a: any, o) => { a[o[k] ?? "-"] = (a[o[k] ?? "-"] ?? 0) + 1; return a; }, {});
    const conv2 = out.filter(o => o.scope === "운영전환");
    const summary = {
      total: out.length, converted: conv2.length, archive: out.length - conv2.length,
      withProgress: cnt(out, o => o.progressRows > 0), withoutProgress: cnt(out, o => o.progressRows === 0),
      singleRow: cnt(out, o => o.progressRows === 1), multiRow: cnt(out, o => o.progressRows > 1),
      decision: by(out, "decision"),
      confirmable: { total: cnt(out, o => o.decision === "restorable"), 번역: cnt(out, o => o.decision === "restorable" && o.kind === "번역") },
      // 확인 가능한 판매 기준 — 기존 전환 로직이면 누락·변형되는 항목
      lossIfConvertedOldLogic: { fileName: cnt(out, o => o.lostFileName), wordOrCharCount: cnt(out, o => o.lostCounts), quantity: cnt(out, o => o.lostQty),
        unitPrice: cnt(out, o => o.lostUnitPrice), fileFormat_sourceHasNoColumn: 0 },
      sourcePresence: { fileName: cnt(out, o => o.hasFileName), wordOrCharCount: cnt(out, o => o.hasCounts), progressMemo: cnt(out, o => o.hasMemo) },
      convertedRestore: by(conv2, "restoreStatus"),
      convertedTotalMismatch: cnt(conv2, o => quotePrice.has(String(o.saleNo)) && o.total != null && Math.abs(quotePrice.get(String(o.saleNo))! - o.total) > 0.5),
    };
    fs.mkdirSync(outDir!, { recursive: true });
    const cols = [...new Set(out.flatMap(o => Object.keys(o)))];
    const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(path.join(outDir!, "crm_quote_items_diag.csv"), "﻿" + [cols.join(","), ...out.map(o => cols.map(c => cell(o[c])).join(","))].join("\n"));
    fs.writeFileSync(path.join(outDir!, "crm_quote_items_converted_plan.json"), JSON.stringify(conv, null, 2));
    fs.writeFileSync(path.join(outDir!, "crm_quote_items_summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release(); await pool.end();
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e?.message ?? e); process.exit(1); });
