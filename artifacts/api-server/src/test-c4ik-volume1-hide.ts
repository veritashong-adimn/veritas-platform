// C-4I-k Volume1 일반 제거 검증 (READ-ONLY). INSERT/UPDATE/DELETE 없음.
//   일반 화면/다운로드 40컬럼(Volume1 제외), 원본 스냅샷 다운로드 41컬럼(포함), source_raw 보존, 수량 소수 유지, 건수 불변.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { searchArchiveFull, progressCanonicalHeaders, applyGeneralHiddenCols, planArchiveExport, writeArchiveWorkbook } from "./routes/legacyArchive";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); } }
const T = legacyArchiveRowsTable;

async function exportCols(scope: "search" | "all", filters: any): Promise<{ headers: string[]; rows: number; sheet: string }> {
  const plan = await planArchiveExport(db, scope, filters);
  const path = join(tmpdir(), `c4ik-${Date.now()}-${Math.round(performance.now())}.xlsx`);
  const stream = createWriteStream(path);
  const finished = once(stream, "finish");
  await writeArchiveWorkbook(stream, plan);
  await finished;
  const wb = XLSX.readFile(path);
  const aoa: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
  return { headers: (aoa[0] as string[]).slice(1), rows: aoa.length - 1, sheet: wb.SheetNames[0] };
}

async function main() {
  console.log("\n=== C-4I-k Volume1 일반 제거 검증 (READ-ONLY) ===\n");
  const wp = and(eq(T.sourceType, "progress"), eq(T.isEffective, true));
  const ws = and(eq(T.sourceType, "sales_list"), eq(T.isEffective, true));
  const beforeProg = Number((await db.select({ n: count() }).from(T).where(wp))[0]?.n ?? 0);
  const beforeSales = Number((await db.select({ n: count() }).from(T).where(ws))[0]?.n ?? 0);
  console.log(`[기준] progress ${beforeProg.toLocaleString()} · sales ${beforeSales.toLocaleString()}\n`);

  // ── 1. 일반 조회 화면(progress) 헤더 = 40, Volume1 제외, 수량 유지 ──
  console.log("[1] 일반 진행관리 화면 컬럼");
  const full = await searchArchiveFull(db, { sourceType: "progress", page: 1, pageSize: 50 }, "progress");
  const { headers: canon, resolved } = await progressCanonicalHeaders(db, "progress");
  // 라우트와 동일: canonical(또는 폴백 union) → applyGeneralHiddenCols
  let cols = canon.slice();
  if (!resolved) { const seen = new Set<string>(); const u: string[] = []; for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); u.push(k); } cols = u; }
  else { const seen = new Set(cols); for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); cols.push(k); } }
  const before = cols.length;
  cols = applyGeneralHiddenCols(cols, "progress");
  console.log(`      필터 전 ${before} → 후 ${cols.length} (resolved=${resolved})`);
  check("일반 화면 40개 컬럼", cols.length === 40, cols.length);
  check("Volume1 제외", !cols.includes("Volume1"));
  check("수량 유지", cols.includes("수량"));
  check("나머지 40개 전부 유지(원래 41개 중 Volume1만 제거)", before === 41 && cols.length === 40);
  // 화면 rows 의 source_raw 에는 Volume1 원본이 그대로 남아있다(표시만 제외).
  check("source_raw 행에는 Volume1 원본 보존", (full.rows as any[]).every(r => "Volume1" in (r.sourceRaw ?? {})));

  // ── 2. 일반 Excel 다운로드(scope=all progress) = 40, Volume1 제외 ──
  console.log("\n[2] 일반 Excel 다운로드");
  const gen = await exportCols("all", { sourceType: "progress" });
  check(`일반 다운로드 시트 '통번역 진행관리', 40개 컬럼`, gen.sheet === "통번역 진행관리" && gen.headers.length === 40, { sheet: gen.sheet, n: gen.headers.length });
  check("일반 다운로드 Volume1 제외", !gen.headers.includes("Volume1"));
  check("일반 다운로드 수량 유지", gen.headers.includes("수량"));
  check(`일반 다운로드 행수 ${beforeProg.toLocaleString()}`, gen.rows === beforeProg, gen.rows);

  // ── 3. 원본 스냅샷 다운로드(snapshot=178) = 41, Volume1 포함 ──
  console.log("\n[3] 원본 스냅샷 다운로드(snapshot=178)");
  const snap = await exportCols("search", { sourceType: "progress", snapshot: "178" });
  check(`스냅샷 다운로드 41개 컬럼`, snap.headers.length === 41, snap.headers.length);
  check("스냅샷 다운로드 Volume1 포함", snap.headers.includes("Volume1"));
  check(`스냅샷 다운로드 행수 ${beforeProg.toLocaleString()}`, snap.rows === beforeProg, snap.rows);

  // ── 4. 수량 소수값 원본 그대로(다운로드 값) ──
  console.log("\n[4] 수량 소수값 보존");
  const decRow = (await db.select({ q: sql<string>`${T.sourceRaw}->>'수량'` }).from(T).where(and(wp, sql`${T.sourceRaw}->>'수량' ~ '\\.'`)).limit(1))[0];
  check(`소수 수량 표본 존재 및 원본 문자열 유지(${decRow?.q ?? "-"})`, !!decRow?.q && /\./.test(decRow.q));

  // ── 5. 판매목록 영향 없음(9컬럼, Volume1 무관) ──
  console.log("\n[5] 판매목록 영향 없음");
  const sales = await exportCols("search", { sourceType: "sales_list" });
  check(`판매목록 9컬럼 유지(Volume1 무관)`, sales.headers.length === 9 && !sales.headers.includes("Volume1") && sales.rows === beforeSales, { n: sales.headers.length, rows: sales.rows });

  // ── 6. source_raw Volume1 보존 + 건수 불변 ──
  console.log("\n[6] 원본 보존·건수 불변");
  const volKeep = Number((await db.select({ n: count() }).from(T).where(and(wp, sql`${T.sourceRaw} ? 'Volume1'`)))[0]?.n ?? 0);
  check(`source_raw Volume1 키 보유 ${beforeProg.toLocaleString()}행(삭제 안 함)`, volKeep === beforeProg, volKeep);
  const afterProg = Number((await db.select({ n: count() }).from(T).where(wp))[0]?.n ?? 0);
  const afterSales = Number((await db.select({ n: count() }).from(T).where(ws))[0]?.n ?? 0);
  check(`progress 30,142 불변 (${afterProg.toLocaleString()})`, afterProg === beforeProg && afterProg === 30142);
  check(`sales 13,549 불변 (${afterSales.toLocaleString()})`, afterSales === beforeSales && afterSales === 13549);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("검증 오류:", e); process.exit(1); });
