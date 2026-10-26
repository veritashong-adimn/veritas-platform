// @ts-nocheck 임시 읽기전용 재현(실행 후 삭제) — 미리보기는 DB 를 변경하지 않는다.
import ExcelJS from "exceljs";
import { db } from "@workspace/db"; import { sql } from "drizzle-orm";
import { buildSyncPreview, summarizePreview } from "./services/legacyArchiveSync";
import { buildArchivePreview } from "./services/legacyArchiveResolve";
const fp = async () => JSON.stringify((await db.execute(sql`SELECT (SELECT count(*) FROM legacy_archive_rows)::int, (SELECT count(*) FROM import_batches)::int, (SELECT count(*) FROM import_row_sources)::int`)).rows[0]);
const F0 = await fp();
const rows = (await db.execute(sql`SELECT source_sheet, source_raw FROM legacy_archive_rows WHERE source_type='progress' AND is_effective ORDER BY source_sheet, source_row, id`)).rows as any[];
const headers = []; for (const r of rows) for (const k of Object.keys(r.source_raw)) if (!headers.includes(k)) headers.push(k);
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sheet1"); ws.addRow(headers);
for (const r of rows) ws.addRow(headers.map(h => r.source_raw[h] == null || r.source_raw[h] === "" ? null : String(r.source_raw[h])));
const buf = Buffer.from(await wb.xlsx.writeBuffer());
for (const st of ["sales_list", "progress"]) {
  const s = summarizePreview(await buildSyncPreview(db, { buffer: buf, sourceType: st, scope: "full" }));
  const sh = buildArchivePreview(buf, st)[0];
  console.log(st, JSON.stringify({ counts: s.counts, saleNo: s.saleNoValidation.usable, recognized: Object.fromEntries(Object.entries(sh?.recognizedColumns ?? {}).filter(([, v]) => v)) }));
}
console.log("dbUnchanged", F0 === await fp()); process.exit(0);
