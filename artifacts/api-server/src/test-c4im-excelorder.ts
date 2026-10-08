// C-4I-m 진행관리 원본 Excel 순서 검증 (READ-ONLY). INSERT/UPDATE/DELETE 없음.
//   원본 Excel 41개 재대조 / 일반 화면·다운로드 = Excel 순서 - Volume1 (40) / 원본 스냅샷 41 / headers_json 상태 / 건수 불변.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable, importBatchesTable } from "@workspace/db";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { searchArchiveFull, progressCanonicalHeaders, applyGeneralHiddenCols, resolveProgressExcelOrder, planArchiveExport, writeArchiveWorkbook } from "./routes/legacyArchive";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } }
const T = legacyArchiveRowsTable;

// 과제 1번 원본 Excel A~AO 41개(권위 기준).
const EXCEL_41 = ["체결일","계산서발행일","견적서발행일","견적서구분","거래처명","고객명","연락처","단어수","글자수","단가","수량","Volume1","공급가액","부가세","총액","입금일","입금내역","비고","담당자","내용","상품명","통번역사명","주민등록번호","상세정보","파일명","언어","통번역사납품일","통번역사지급일","통역장소","요금(100%)","요율(85%)","교통비","출장비","이동보상비","저작권료","취소보상비","통번역수량","단위","통번역단가","지급액(세전)","지금액(세후)"];
const EXCEL_40 = EXCEL_41.filter(c => c !== "Volume1");

async function exportHeaders(scope: "search" | "all", filters: any): Promise<string[]> {
  const plan = await planArchiveExport(db, scope, filters);
  const path = join(tmpdir(), `c4im-${Date.now()}-${Math.round(performance.now())}.xlsx`);
  const stream = createWriteStream(path);
  const finished = once(stream, "finish");
  await writeArchiveWorkbook(stream, plan);
  await finished;
  const aoa: any[][] = XLSX.utils.sheet_to_json(XLSX.readFile(path).Sheets[XLSX.readFile(path).SheetNames[0]], { header: 1, blankrows: false });
  return (aoa[0] as string[]).slice(1);
}

async function main() {
  console.log("\n=== C-4I-m 진행관리 원본 Excel 순서 검증 (READ-ONLY) ===\n");
  const wp = and(eq(T.sourceType, "progress"), eq(T.isEffective, true));
  const ws = and(eq(T.sourceType, "sales_list"), eq(T.isEffective, true));
  const beforeProg = Number((await db.select({ n: count() }).from(T).where(wp))[0]?.n ?? 0);
  const beforeSales = Number((await db.select({ n: count() }).from(T).where(ws))[0]?.n ?? 0);

  // ── 1. 실제 Excel 헤더 41개 재대조(차이 있으면 원본 우선·보고) ──
  console.log("[1] 원본 Excel 41개 재대조");
  const keyRows = await db.selectDistinct({ k: sql<string>`jsonb_object_keys(${T.sourceRaw})` }).from(T).where(wp);
  const keys = keyRows.map((r: any) => r.k).filter(Boolean) as string[];
  const keySet = new Set(keys);
  const missing = EXCEL_41.filter(c => !keySet.has(c));   // 과제목록엔 있으나 DB에 없음
  const extra = keys.filter(c => !EXCEL_41.includes(c));  // DB엔 있으나 과제목록에 없음
  check(`source_raw 키 41개`, keys.length === 41, keys.length);
  check(`과제 Excel 41개 == 실제 source_raw 키 (집합 일치)`, missing.length === 0 && extra.length === 0, { missing, extra });

  // ── 2. 일반 화면 = Excel 순서 - Volume1 (40) ──
  console.log("\n[2] 일반 화면 컬럼 순서");
  const full = await searchArchiveFull(db, { sourceType: "progress", page: 1, pageSize: 50 }, "progress");
  const { headers: canon, resolved } = await progressCanonicalHeaders(db, "progress");
  const kset = new Set<string>(resolved ? canon : []); const kunion: string[] = resolved ? [...canon] : [];
  for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!kset.has(k)) { kset.add(k); kunion.push(k); }
  const screenCols = applyGeneralHiddenCols(resolveProgressExcelOrder(kunion, resolved ? canon : null, "progress"), "progress");
  console.log(`      화면 앞 6 = ${screenCols.slice(0, 6).join(", ")}`);
  check("화면 40개", screenCols.length === 40);
  check("화면 순서 == 원본 Excel 순서(Volume1 제외)", JSON.stringify(screenCols) === JSON.stringify(EXCEL_40), { got: screenCols.slice(0, 6) });
  check("화면 Volume1 제외", !screenCols.includes("Volume1"));

  // ── 3. 일반 다운로드 = 화면과 동일 ──
  console.log("\n[3] 일반 다운로드 순서");
  const dlAll = await exportHeaders("all", { sourceType: "progress" });
  const dlSearch = await exportHeaders("search", { sourceType: "progress", q: "" });
  check("일반 다운로드(전체) == 원본 Excel 40", JSON.stringify(dlAll) === JSON.stringify(EXCEL_40), { got: dlAll.slice(0, 6) });
  check("일반 다운로드(검색) == 원본 Excel 40", JSON.stringify(dlSearch) === JSON.stringify(EXCEL_40));
  check("화면 순서 == 일반 다운로드 순서", JSON.stringify(screenCols) === JSON.stringify(dlAll));

  // ── 4. 원본 스냅샷 = 41(Volume1 포함), Excel 순서 ──
  console.log("\n[4] 원본 스냅샷 다운로드(snapshot=178)");
  const snap = await exportHeaders("search", { sourceType: "progress", snapshot: "178" });
  check("스냅샷 41개 + Volume1 포함", snap.length === 41 && snap.includes("Volume1"), { n: snap.length });
  check("스냅샷 순서 == 원본 Excel 41(권위 순서)", JSON.stringify(snap) === JSON.stringify(EXCEL_41), { got: snap.slice(10, 14) });
  // headers_json 상태 보고(복원 기능 유지 확인 — 임의 jsonb 순서 미사용)
  const hj = (await db.select({ hj: importBatchesTable.headersJson }).from(importBatchesTable)
    .where(and(eq(importBatchesTable.module, "legacy_archive"), eq(importBatchesTable.sourceType, "progress"), eq(importBatchesTable.isCurrent, true)))
    .orderBy(desc(importBatchesTable.id)).limit(1))[0]?.hj;
  console.log(`      batch headers_json: ${Array.isArray(hj) ? `배열(${(hj as any[]).length})` : hj === null ? "NULL(미복원→권위 상수 사용)" : "기타"}`);

  // ── 5. 판매목록 영향 없음 ──
  console.log("\n[5] 판매목록 영향 없음");
  const sales = await exportHeaders("search", { sourceType: "sales_list" });
  check("판매목록 9개(Volume1 무관, 재정렬 없음)", sales.length === 9 && !sales.includes("Volume1"));

  // ── 6. 원본 보존·건수 ──
  console.log("\n[6] 원본 보존·건수");
  const volKeep = Number((await db.select({ n: count() }).from(T).where(and(wp, sql`${T.sourceRaw} ? 'Volume1'`)))[0]?.n ?? 0);
  check(`source_raw Volume1 ${beforeProg.toLocaleString()}행 보존`, volKeep === beforeProg);
  const afterProg = Number((await db.select({ n: count() }).from(T).where(wp))[0]?.n ?? 0);
  const afterSales = Number((await db.select({ n: count() }).from(T).where(ws))[0]?.n ?? 0);
  check(`progress 30,142 불변 (${afterProg.toLocaleString()})`, afterProg === beforeProg && afterProg === 30142);
  check(`sales 13,549 불변 (${afterSales.toLocaleString()})`, afterSales === beforeSales && afterSales === 13549);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("검증 오류:", e); process.exit(1); });
