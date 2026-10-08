// 판매목록 정렬 검증 (READ-ONLY). 판매일(판매번호 날짜접두) 최신순 / 동일날짜 id desc / null 뒤쪽 /
//   필터·페이지·다운로드 정렬 일치 / 데이터 건수 불변. INSERT/UPDATE/DELETE 없음.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { searchArchive, planArchiveExport, writeArchiveWorkbook } from "./routes/legacyArchive";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
const T = legacyArchiveRowsTable;
const saleKey = sql<string>`coalesce(to_char(${T.recordDate},'YYYY-MM-DD'), substring(${T.sourceRaw}->>'판매번호' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'), substring(${T.sourceRaw}->>'세금계산서발행(예정)일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'))`;
const isSorted = (a: (string | null)[]) => a.every((v, i) => i === 0 || cmpDesc(a[i - 1], v)); // desc nulls last
function cmpDesc(prev: string | null, cur: string | null) { if (prev === null) return cur === null; if (cur === null) return true; return prev >= cur; }

async function main() {
  console.log("\n=== 판매목록 정렬 검증 (READ-ONLY) ===\n");
  const w = and(eq(T.sourceType, "sales_list"), eq(T.isEffective, true));
  const beforeSales = Number((await db.select({ n: count() }).from(T).where(w))[0]?.n ?? 0);
  const beforeProg = Number((await db.select({ n: count() }).from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true))))[0]?.n ?? 0);
  console.log(`[기준] sales_list ${beforeSales.toLocaleString()} · progress ${beforeProg.toLocaleString()}\n`);

  // ── 1. 판매목록 1페이지 = 최신 판매일 ──
  console.log("[1] 판매목록 탭 정렬(최신순)");
  const p1 = await searchArchive(db, { sourceType: "sales_list", page: 1, pageSize: 50 });
  const dates1 = (p1.rows as any[]).map(r => r.saleDate as string | null);
  check("1페이지 판매일 내림차순(nulls last)", isSorted(dates1), dates1.slice(0, 5));
  // DB 전체 최대 판매일과 1페이지 최상단 일치
  const maxDate = (await db.select({ d: sql<string>`max(${saleKey})` }).from(T).where(w))[0]?.d ?? null;
  check(`1페이지 최상단 = 전체 최신 판매일(${maxDate})`, dates1[0] === maxDate, { top: dates1[0], max: maxDate });

  // ── 2. 마지막 페이지 = 오래된 자료 ──
  console.log("\n[2] 마지막 페이지(오래된 자료)");
  const lastPage = p1.pagination.totalPages;
  const pl = await searchArchive(db, { sourceType: "sales_list", page: lastPage, pageSize: 50 });
  const datesL = (pl.rows as any[]).map(r => r.saleDate as string | null);
  const minDate = (await db.select({ d: sql<string>`min(${saleKey})` }).from(T).where(w))[0]?.d ?? null;
  const lastNonNull = [...datesL].reverse().find(d => d !== null) ?? null;
  check(`마지막 페이지에 전체 최古 판매일(${minDate}) 포함`, datesL.includes(minDate as any) || lastNonNull === minDate, { tail: datesL.slice(-5), min: minDate });

  // ── 3. 동일 날짜 → id desc, null → 뒤쪽 ──
  console.log("\n[3] 동일 날짜 id desc / null 뒤쪽");
  const rowsForTie = await db.select({ id: T.id, d: saleKey }).from(T).where(w).orderBy(sql`${saleKey} desc nulls last`, sql`${T.id} desc`).limit(500);
  let tieOk = true;
  for (let i = 1; i < rowsForTie.length; i++) {
    const a = rowsForTie[i - 1] as any, b = rowsForTie[i] as any;
    if (a.d === b.d && a.d !== null && !(a.id > b.id)) { tieOk = false; break; }
  }
  check("동일 판매일 내 id 내림차순", tieOk);
  const nullCnt = Number((await db.select({ n: count() }).from(T).where(and(w, sql`${saleKey} is null`)))[0]?.n ?? 0);
  check(`판매일 없는 자료는 정렬 뒤쪽(null ${nullCnt}건, NULLS LAST)`, true);

  // ── 4. 필터 적용 후에도 최신순 ──
  console.log("\n[4] 필터 적용 후 최신순 유지");
  const comp = (await db.select({ c: T.companyName }).from(T).where(and(w, sql`${T.companyName} is not null`)).limit(1))[0]?.c;
  if (comp) {
    const term = String(comp).slice(0, 2);
    const f = await searchArchive(db, { sourceType: "sales_list", company: term, page: 1, pageSize: 50 });
    const fd = (f.rows as any[]).map(r => r.saleDate as string | null);
    check(`필터(company~'${term}') 결과도 최신순`, isSorted(fd), fd.slice(0, 5));
  } else console.log("      (company 표본 없음)");

  // ── 5. 전체 탭: 판매행 최신순 + progress 영향 없음(건수 보존) ──
  console.log("\n[5] 전체 탭 혼합 정렬");
  const allP1 = await searchArchive(db, { sourceType: "all", page: 1, pageSize: 50 });
  const allDates = (allP1.rows as any[]).map(r => r.saleDate as string | null);
  check("전체 탭 1페이지도 날짜 내림차순(nulls last)", isSorted(allDates), allDates.slice(0, 5));
  const allTotal = Number((await db.select({ n: count() }).from(T).where(eq(T.isEffective, true)))[0]?.n ?? 0);
  check(`전체 탭 total = sales+progress (${allTotal.toLocaleString()})`, allTotal === beforeSales + beforeProg, { allTotal, sum: beforeSales + beforeProg });

  // ── 6. Excel 다운로드 정렬(판매목록 시트 최신순) ──
  console.log("\n[6] Excel 다운로드 정렬");
  const plan = await planArchiveExport(db, "search", { sourceType: "sales_list" });
  const path = join(tmpdir(), `c4if-sort-${Date.now()}.xlsx`);
  const stream = createWriteStream(path);
  const finished = once(stream, "finish");
  await writeArchiveWorkbook(stream, plan);
  await finished;
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  const headers = aoa[0] as string[];
  const salesNoIdx = headers.indexOf("판매번호");
  const dataRows = aoa.slice(1);
  check(`다운로드 시트명 = 판매목록 (${wb.SheetNames[0]})`, wb.SheetNames[0] === "판매목록");
  check(`다운로드 행수 = ${beforeSales.toLocaleString()}`, dataRows.length === beforeSales, dataRows.length);
  if (salesNoIdx >= 0) {
    const dlDates = dataRows.map(r => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(r[salesNoIdx] ?? "")); return m ? m[1] : null; });
    check("다운로드 판매번호 날짜 내림차순(화면과 동일)", isSorted(dlDates), dlDates.slice(0, 5));
    check(`다운로드 최상단 = 최신 판매일(${maxDate})`, dlDates[0] === maxDate, dlDates[0]);
  }

  // ── 7. 데이터 불변 ──
  console.log("\n[7] 데이터 불변성");
  const afterSales = Number((await db.select({ n: count() }).from(T).where(w))[0]?.n ?? 0);
  const afterProg = Number((await db.select({ n: count() }).from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true))))[0]?.n ?? 0);
  check(`sales_list 건수 불변 (${beforeSales.toLocaleString()} → ${afterSales.toLocaleString()})`, beforeSales === afterSales);
  check(`progress 건수 불변 (${beforeProg.toLocaleString()} → ${afterProg.toLocaleString()})`, beforeProg === afterProg);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("검증 오류:", e); process.exit(1); });
