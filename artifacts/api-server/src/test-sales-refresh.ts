// @ts-nocheck — 격리 테스트 전용 하네스. 판매목록 최신화 핵심 검증(임시 복제 DB 전용).
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { buildSyncPreview, summarizePreview, executeArchiveSync, executeBatchRollback, cachePreview } from "./services/legacyArchiveSync";

if (!/\/veritas_sync_scratch(\?|$)/.test(process.env.DATABASE_URL ?? "")) { console.error("임시 복제 DB(veritas_sync_scratch)에서만 실행합니다."); process.exit(1); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const one = async (s: any) => ((await db.execute(s)).rows as any[])[0];
const state = () => one(sql`SELECT (SELECT count(*) FROM legacy_archive_rows)::int rows,
  (SELECT count(*) FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective)::int sales,
  (SELECT coalesce(sum(total_amount),0)::text FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective) total,
  (SELECT count(*) FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id=l.sale_row_id JOIN legacy_archive_rows p ON p.id=l.progress_row_id WHERE l.decision='confirmed' AND s.is_effective AND p.is_effective)::int links`);

async function main() {
  const rows = (await db.execute(sql`SELECT id, source_sheet, source_raw FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective ORDER BY source_sheet, source_row, id`)).rows as any[];
  const headers: string[] = []; for (const r of rows) for (const k of Object.keys(r.source_raw)) if (!headers.includes(k)) headers.push(k);
  const build = async (list: any[]) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sheet1"); ws.addRow(headers); for (const r of list) ws.addRow(headers.map(h => r.source_raw[h] == null || r.source_raw[h] === "" ? null : String(r.source_raw[h]))); return Buffer.from(await wb.xlsx.writeBuffer()); };
  const S0 = await state();
  console.log("기준:", JSON.stringify(S0));

  // 유형 판별: 판매목록 파일을 진행관리표로 선택 → 차단
  let code = ""; try { await buildSyncPreview(db, { buffer: await build(rows), sourceType: "progress", scope: "full" }); } catch (e) { code = e.code; }
  check("판매목록 파일을 진행관리표로 선택 → 비교 차단", code === "SOURCE_TYPE_MISMATCH");

  // 변경 파일: 연결 있는 판매 2건 금액 수정 + 신규 2건(① 미연결 진행 행과 연결키 일치 ② 진행 행 없음)
  const work = rows.map(r => ({ ...r, source_raw: { ...r.source_raw } }));
  const linked = (await db.execute(sql`SELECT DISTINCT sale_row_id id FROM legacy_sales_progress_links WHERE decision='confirmed' ORDER BY 1 LIMIT 2`)).rows.map(r => Number(r.id));
  for (const id of linked) { const x = work.find(w => Number(w.id) === id); x.source_raw["총액"] = String(Number(String(x.source_raw["총액"]).replace(/,/g, "")) + 1000); }
  // 실데이터에는 '판매건 없는 미연결 진행 행'이 없어 임시 DB 에만 합성 진행 행 1건을 넣어 신규 연결 경로를 검증
  const freeProg = { c: "테스트연결거래처", pr: "영한번역", a: "330000", d: "2026-10-20" };
  await db.execute(sql`INSERT INTO legacy_archive_rows (source_type, source_system, source_raw, row_hash, company_name, product_name, translator_name, is_current, is_effective, match_status, effective_version)
    VALUES ('progress', 'test', ${JSON.stringify({ "거래처명": freeProg.c, "상품명": freeProg.pr, "총액": freeProg.a, "체결일": freeProg.d, "통번역사명": "테스트수행자" })}::jsonb, 'tsales-hash', ${freeProg.c}, ${freeProg.pr}, '테스트수행자', false, true, 'new', 1)`);
  const S0b = await state();
  const tpl = rows[0].source_raw;
  const newA = { source_sheet: "Sheet1", source_raw: { ...tpl, "판매번호": `${freeProg.d.slice(0, 10)}-9901`, "거래처명": freeProg.c, "상품명": freeProg.pr, "총액": freeProg.a } };
  const newB = { source_sheet: "Sheet1", source_raw: { ...tpl, "판매번호": "2026-10-26-9902", "거래처명": "연결없는신규거래처", "상품명": "영한번역", "총액": "110000" } };
  const buf = await build([...work, newA, newB]);
  const p = await buildSyncPreview(db, { buffer: buf, sourceType: "sales_list", scope: "full" });
  const s = summarizePreview(p);
  check("미리보기: 신규 2·수정 2·변경 없음 13,547·중복의심 0·삭제의심 0", s.counts.NEW === 2 && s.counts.UPDATED === 2 && s.counts.SAME === rows.length - 2 && s.counts.AMBIGUOUS === 0 && s.counts.DELETION_SUSPECT === 0, JSON.stringify(s.counts));
  check("미리보기: 비교 대상 = 기존 판매목록 유효 13,549 · 판매번호 기준 사용", s.comparedWith.sourceType === "sales_list" && s.comparedWith.effectiveRows === rows.length && s.saleNoValidation.usable);
  check("신규 판매건 연결 계획: 연결 1(기존 규칙 일치)·미연결 1", s.impact.newSaleLink?.link === 1 && s.impact.newSaleLink?.none === 1, JSON.stringify(s.impact.newSaleLink));
  check("미리보기 DB 미변경", JSON.stringify(await state()) === JSON.stringify(S0b));

  cachePreview(p, null);
  const r = await db.transaction(async (tx) => executeArchiveSync(tx, { buffer: buf, sourceType: "sales_list", fileName: "sales-latest.xls", performerId: null, scope: "full", planToken: s.planToken, approvedAmbiguous: new Set() }));
  const S1 = await state();
  check("반영: 신규 2·수정 2만 저장(행 +4)", r.applied.created === 2 && r.applied.updated === 2 && S1.rows === S0b.rows + 4 && S1.sales === S0.sales + 2, JSON.stringify(r.applied));
  check("반영: 수정 판매건 연결 이관·신규 판매건 연결 생성 → 유효 연결 = 기존 + 신규 연결", r.linksCarried >= 2 && r.newLinks === 1 && S1.links === S0.links + 1, JSON.stringify({ carried: r.linksCarried, newLinks: r.newLinks, links: S1.links }));
  check("반영: 금액 합계 = 기준 + 수정분(2,000) + 신규 총액", BigInt(S1.total) === BigInt(S0.total) + 2000n + BigInt(Math.round(Number(String(freeProg.a).replace(/,/g, "")))) + 110000n, `${S0.total}→${S1.total}`);

  const p2 = await buildSyncPreview(db, { buffer: buf, sourceType: "sales_list", scope: "full" });
  const r2 = await db.transaction(async (tx) => executeArchiveSync(tx, { buffer: buf, sourceType: "sales_list", fileName: "sales-latest.xls", performerId: null, scope: "full", planToken: p2.planToken, approvedAmbiguous: new Set() }));
  check("같은 파일 재업로드: 변경 없음·중복 생성 없음", r2.mode === "no_change" && JSON.stringify(await state()) === JSON.stringify(S1));

  await db.transaction(async (tx) => executeBatchRollback(tx, r.batchId, null));
  const S2 = await state();
  check("되돌리기: 유효 판매·금액·유효 연결 = 기준", S2.sales === S0.sales && S2.total === S0.total && S2.links === S0.links, JSON.stringify(S2));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("테스트 오류:", e); process.exit(1); });
