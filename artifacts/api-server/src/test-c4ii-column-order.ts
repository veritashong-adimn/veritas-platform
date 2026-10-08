// C-4I-i 과거 CRM Excel 원본 컬럼 순서 일치 — 진단/검증 (완전 READ-ONLY).
//   INSERT/UPDATE/DELETE/Execute 없음. 원본 데이터·headers_json 미변경.
//   목적: batch #178(진행관리) · sales_list 스냅샷의 headers_json 복원 상태를 실제 DB 에서 확인하고,
//         full 뷰/다운로드가 산출하는 컬럼 순서(진행관리 41 / 판매목록 9)를 원본 header 와 대조한다.
import { db, legacyArchiveRowsTable, importBatchesTable } from "@workspace/db";
import { eq, and, count, desc, sql } from "drizzle-orm";
import { searchArchiveFull, progressCanonicalHeaders, planArchiveExport } from "./routes/legacyArchive";

// 다운로드 경로가 실제로 산출하는 헤더(planArchiveExport.entries[].headers). route export 와 동일 코드.
async function exportHeaders(sourceType: "progress" | "sales_list"): Promise<string[]> {
  const plan = await planArchiveExport(db, "search", { sourceType });
  const entry = plan.entries.find(e => e.type === sourceType);
  return entry?.headers ?? [];
}

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
const T = legacyArchiveRowsTable;
const B = importBatchesTable;

// 판매목록 원본 9컬럼(C-4I-g 확정 기준).
const SALES_EXPECTED = ["판매번호", "영업기회명", "세금계산서발행(예정)일", "거래처명", "상품명", "총액", "입금일", "입금내역", "영업담당자"];

// 라우트 GET /admin/legacy-archive(full 뷰)의 컬럼 산출을 그대로 재현.
async function routeFullHeaders(sourceType: "progress" | "sales_list") {
  const { headers, resolved } = await progressCanonicalHeaders(db, sourceType);
  const full = await searchArchiveFull(db, { sourceType, page: 1, pageSize: 50 }, sourceType);
  let cols = headers.slice();
  if (!resolved) {
    const seen = new Set<string>(); const union: string[] = [];
    for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); union.push(k); }
    cols = union;
  } else {
    const seen = new Set(cols);
    for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  }
  return { cols, resolved, canonical: headers, full };
}

async function main() {
  console.log("\n=== C-4I-i 원본 컬럼 순서 일치 — 진단/검증 (READ-ONLY) ===\n");

  // ── 0. legacy_archive 스냅샷(import_batches) 전수 — headers_json 상태 ──
  console.log("[0] legacy_archive 스냅샷 headers_json 상태");
  const batches = await db.select({
    id: B.id, sourceType: B.sourceType, isCurrent: B.isCurrent, status: B.status,
    totalRows: B.totalRows, successRows: B.successRows, originalFilename: B.originalFilename,
    fileHash: B.fileHash, headersJson: B.headersJson, createdAt: B.createdAt,
  }).from(B).where(eq(B.module, "legacy_archive")).orderBy(desc(B.id));
  for (const b of batches as any[]) {
    const hj = b.headersJson;
    const hlen = Array.isArray(hj) ? hj.length : (hj == null ? "null" : "non-array");
    console.log(`      #${b.id} ${b.sourceType ?? "-"} current=${b.isCurrent ? "Y" : "n"} status=${b.status} rows=${b.successRows}/${b.totalRows} headers_json=${hlen} file="${b.originalFilename ?? "-"}" hash=${b.fileHash ? String(b.fileHash).slice(0, 12) : "-"}`);
  }

  // ── 1. batch #178 (진행관리) headers_json 상태 ──
  console.log("\n[1] batch #178 진행관리 headers_json");
  const b178 = (batches as any[]).find(b => b.id === 178) ?? null;
  if (!b178) {
    check("batch #178 존재", false, "batch #178 을 찾을 수 없습니다.");
  } else {
    const hj = b178.headersJson;
    const isArr = Array.isArray(hj);
    console.log(`      #178 sourceType=${b178.sourceType} current=${b178.isCurrent} headers_json=${isArr ? `${hj.length}개` : (hj == null ? "null" : typeof hj)}`);
    if (isArr) console.log(`      헤더: ${(hj as string[]).join(" | ")}`);
    check("batch #178 은 progress(진행관리) 스냅샷", b178.sourceType === "progress", b178.sourceType);
    check("batch #178 headers_json 복원됨(배열)", isArr, { type: typeof hj, value: hj == null ? "null" : "(set)" });
    if (isArr) check("batch #178 headers_json 41개 컬럼", (hj as string[]).length === 41, (hj as string[]).length);
  }

  // ── 2. progress full 뷰 — canonical(headers_json) 해결 여부 + 41컬럼 ──
  console.log("\n[2] 진행관리 full 뷰 컬럼(41)");
  const prog = await routeFullHeaders("progress");
  console.log(`      progressCanonicalHeaders resolved=${prog.resolved}, canonical=${prog.canonical.length}개, full컬럼=${prog.cols.length}개`);
  check("진행관리 headers_json 복원(resolved=true)", prog.resolved, { resolved: prog.resolved });
  check("진행관리 full 컬럼 41개", prog.cols.length === 41, prog.cols.length);
  if (prog.resolved) {
    check("full 컬럼 순서 = headers_json(원본 A~AO) 순서", JSON.stringify(prog.cols.slice(0, prog.canonical.length)) === JSON.stringify(prog.canonical), { canonicalHead: prog.canonical.slice(0, 3), colsHead: prog.cols.slice(0, 3) });
    console.log(`      A~AO: ${prog.cols.map((c, i) => `${i + 1}.${c}`).join("  ")}`);
  } else {
    console.log("      ⚠ resolved=false → source_raw 키 union 폴백(원본 A~AO 순서 아님). 원인 보고 대상.");
  }

  // ── 3. 다운로드 헤더(resolveExportHeaders) = 화면 헤더와 동일 ──
  console.log("\n[3] 진행관리 다운로드 헤더 = 화면 헤더");
  const progWhere = and(eq(T.sourceType, "progress"), eq(T.isEffective, true));
  const progDl = await exportHeaders("progress");
  check("다운로드 헤더 41개", progDl.length === 41, progDl.length);
  check("다운로드 헤더 순서 = 화면 full 헤더 순서", JSON.stringify(progDl) === JSON.stringify(prog.cols), { dlHead: progDl.slice(0, 3), colsHead: prog.cols.slice(0, 3) });

  // ── 4. 판매목록 full 뷰 — 9컬럼/순서 ──
  console.log("\n[4] 판매목록 full 뷰 컬럼(9)");
  const sales = await routeFullHeaders("sales_list");
  console.log(`      progressCanonicalHeaders resolved=${sales.resolved}, canonical=${sales.canonical.length}개, full컬럼=${sales.cols.length}개`);
  console.log(`      컬럼: ${sales.cols.map((c, i) => `${String.fromCharCode(65 + i)}.${c}`).join("  ")}`);
  check("판매목록 headers_json 복원(resolved=true)", sales.resolved, { resolved: sales.resolved });
  check("판매목록 full 컬럼 9개", sales.cols.length === 9, sales.cols.length);
  check("판매목록 9컬럼 = 원본 A~I 명칭", SALES_EXPECTED.every(h => sales.cols.includes(h)), { got: sales.cols, missing: SALES_EXPECTED.filter(h => !sales.cols.includes(h)) });
  if (sales.resolved) check("판매목록 컬럼 순서 = headers_json 순서", JSON.stringify(sales.cols.slice(0, sales.canonical.length)) === JSON.stringify(sales.canonical), { canonical: sales.canonical, cols: sales.cols });
  check("'입금/지급일' 통합 컬럼명 미사용 + '입금일' 사용", !sales.cols.includes("입금/지급일") && sales.cols.includes("입금일"));

  // ── 5. 판매목록 다운로드 헤더 = 화면 ──
  console.log("\n[5] 판매목록 다운로드 헤더 = 화면");
  const salesWhere = and(eq(T.sourceType, "sales_list"), eq(T.isEffective, true));
  const salesDl = await exportHeaders("sales_list");
  check("판매목록 다운로드 헤더 9개", salesDl.length === 9, salesDl.length);
  check("판매목록 다운로드 순서 = 화면 full 순서", JSON.stringify(salesDl) === JSON.stringify(sales.cols), { dl: salesDl, cols: sales.cols });

  // ── 6. 판매번호 전체 문자열(원본 값 불변 표본) ──
  console.log("\n[6] 판매번호 전체 문자열(원본값)");
  const r0: any = sales.full.rows[0];
  const sn = r0?.sourceRaw?.["판매번호"];
  check(`판매번호 전체 문자열(YYYY-MM-DD-NNNN) 유지: ${JSON.stringify(sn)}`, typeof sn === "string" && /^\d{4}-\d{2}-\d{2}-\d+$/.test(sn), sn);

  // ── 7. 데이터 불변성(행 수) ──
  console.log("\n[7] 데이터 불변성(effective 행 수)");
  const nProg = Number((await db.select({ n: count() }).from(T).where(progWhere))[0]?.n ?? 0);
  const nSales = Number((await db.select({ n: count() }).from(T).where(salesWhere))[0]?.n ?? 0);
  check(`진행관리 30,142행 (${nProg.toLocaleString()})`, nProg === 30142, nProg);
  check(`판매목록 13,549행 (${nSales.toLocaleString()})`, nSales === 13549, nSales);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("진단 오류:", e); process.exit(1); });
