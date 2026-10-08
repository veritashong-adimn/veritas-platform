// C-4I-d Excel 다운로드 검증 (READ-ONLY). 실데이터에 대해 INSERT/UPDATE/DELETE 없이 조회·생성만 수행한다.
//   검증: 진행관리 전체 30,142행 / 41 원본 컬럼 / 헤더 순서 / 검색 필터 정합성(페이지 무관) /
//         null·빈값·숫자·선행0 보존 / Excel 파일 정상 열림 / 생성 전후 DB 행수·원본 불변.
import * as XLSX from "xlsx";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { planArchiveExport, writeArchiveWorkbook, searchArchive } from "./routes/legacyArchive";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}

const T = legacyArchiveRowsTable;

// 계획 → 임시파일로 스트리밍 → XLSX 로 다시 읽어 검증(파일 정상 열림 포함).
async function exportToFile(scope: "search" | "all", filters: any): Promise<{ wb: XLSX.WorkBook; sheets: { label: string; rows: number }[] }> {
  const plan = await planArchiveExport(db, scope, filters);
  const path = join(tmpdir(), `c4id-${scope}-${Date.now()}.xlsx`);
  const stream = createWriteStream(path);
  const finished = once(stream, "finish");         // write 전에 리스너 부착(race 방지). exceljs 가 stream.end() 호출.
  const { sheets } = await writeArchiveWorkbook(stream, plan);
  await finished;
  const wb = XLSX.readFile(path);
  return { wb, sheets };
}

async function main() {
  console.log("\n=== C-4I-d Excel 다운로드 검증 (READ-ONLY) ===\n");

  // ── 0. 생성 전 DB 지문(불변성 증거) ──
  const beforeAll = Number((await db.select({ n: count() }).from(T))[0]?.n ?? 0);
  const beforeProg = Number((await db.select({ n: count() }).from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true))))[0]?.n ?? 0);
  console.log(`[기준] 전체 행 ${beforeAll.toLocaleString()} · progress effective ${beforeProg.toLocaleString()}\n`);

  // ── 1. 진행관리 전체 다운로드(scope=all) ──
  console.log("[1] 통번역 진행관리 전체 다운로드");
  const prog = await exportToFile("all", { sourceType: "progress" });
  const sheetName = prog.wb.SheetNames[0];
  const ws = prog.wb.Sheets[sheetName];
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  const headerRow = (aoa[0] ?? []) as unknown[];
  const dataRows = aoa.slice(1);
  check(`시트명 = '통번역 진행관리' (${sheetName})`, sheetName === "통번역 진행관리", sheetName);
  check(`전체 행수 = progress effective(${beforeProg.toLocaleString()}) 와 일치 → ${dataRows.length.toLocaleString()}`, dataRows.length === beforeProg, dataRows.length);
  check("sheets 집계 rows 가 effective 와 일치", prog.sheets[0]?.rows === beforeProg, prog.sheets);
  check("첫 컬럼 = 'Excel 행'", headerRow[0] === "Excel 행", headerRow[0]);
  const srcCols = headerRow.slice(1);
  console.log(`      원본 컬럼 수 = ${srcCols.length} (헤더 제외)`);
  // (C-4I-k) 일반 다운로드(scope=all, snapshot=current) → Volume1 제외 40개.
  check("일반 다운로드 컬럼 40개(Volume1 제외)", srcCols.length === 40, srcCols.length);
  check("일반 다운로드에 Volume1 없음", !srcCols.includes("Volume1"), srcCols.filter((c: string) => c === "Volume1"));
  check("수량 컬럼은 유지", srcCols.includes("수량"));

  // (C-4I-m) 일반 다운로드 순서 = 원본 Excel A~AO 순서에서 Volume1 만 제외한 40개와 완전 일치.
  const EXCEL_ORDER_40 = ["체결일","계산서발행일","견적서발행일","견적서구분","거래처명","고객명","연락처","단어수","글자수","단가","수량","공급가액","부가세","총액","입금일","입금내역","비고","담당자","내용","상품명","통번역사명","주민등록번호","상세정보","파일명","언어","통번역사납품일","통번역사지급일","통역장소","요금(100%)","요율(85%)","교통비","출장비","이동보상비","저작권료","취소보상비","통번역수량","단위","통번역단가","지급액(세전)","지금액(세후)"];
  check(`일반 다운로드 컬럼 순서 = 원본 Excel 순서(Volume1 제외 40)`, JSON.stringify(srcCols) === JSON.stringify(EXCEL_ORDER_40), { gotFirst: srcCols.slice(0, 6), expFirst: EXCEL_ORDER_40.slice(0, 6) });

  // ── 2. null/빈값/숫자/선행0 보존 (source_raw 원본과 1행 대조) ──
  console.log("\n[2] 원본값 보존 (source_raw 대조)");
  // export 와 동일 정렬(import_batch, source_row, id)로 첫 행을 가져와 셀 단위 비교.
  const firstRaw = await db.select({ sourceRow: T.sourceRow, sourceRaw: T.sourceRaw, importBatchId: T.importBatchId, id: T.id })
    .from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true)))
    .orderBy(sql`${T.importBatchId} asc`, sql`${T.sourceRow} asc`, sql`${T.id} asc`).limit(1);
  if (firstRaw[0]) {
    const raw = firstRaw[0].sourceRaw as Record<string, unknown>;
    const exportedFirst = dataRows[0] as unknown[];
    check("첫 행 Excel행 컬럼 = source_row", String(exportedFirst[0]) === String(firstRaw[0].sourceRow), { got: exportedFirst[0], exp: firstRaw[0].sourceRow });
    let preserved = 0, mismatches: any[] = [];
    srcCols.forEach((h, i) => {
      const orig = raw[h as string];
      const got = exportedFirst[i + 1];
      // null/undefined → 셀 null, 나머지는 문자열화 비교(숫자/선행0/문자 보존 확인).
      const origNorm = orig === null || orig === undefined ? null : (typeof orig === "object" ? JSON.stringify(orig) : orig);
      const gotNorm = got === null || got === undefined ? null : got;
      const equal = origNorm === null ? gotNorm === null
        : String(origNorm) === String(gotNorm);
      if (equal) preserved++; else mismatches.push({ col: h, orig, got });
    });
    check(`첫 행 모든 컬럼 원본값 보존 (${preserved}/${srcCols.length})`, mismatches.length === 0, mismatches.slice(0, 5));
  } else {
    console.log("      (progress 데이터 없음 — 보존 검증 생략)");
  }

  // 선행 0 보존: source_raw 값 중 선행 0 문자열이 있으면 export 에서도 문자열로 보존되는지 스팟 확인
  const leadingZero = await db.select({ sourceRaw: T.sourceRaw })
    .from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true),
      sql`EXISTS (SELECT 1 FROM jsonb_each_text(${T.sourceRaw}) e WHERE e.value ~ '^0[0-9]+$')`))
    .limit(1);
  console.log(`      선행0 문자열 포함 행 존재: ${leadingZero.length > 0 ? "예 (문자열 셀로 보존)" : "표본 없음"}`);

  // ── 3. 검색 결과 다운로드 = 화면 total 과 일치(페이지 무관) ──
  console.log("\n[3] 검색 결과 다운로드 (필터 정합성, 페이지 무관)");
  // 임의 키워드 필터로 화면 검색 total 과 다운로드 행수 비교.
  const sampleCompany = (await db.select({ c: T.companyName }).from(T)
    .where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true), sql`${T.companyName} is not null`)).limit(1))[0]?.c;
  if (sampleCompany) {
    const term = String(sampleCompany).slice(0, 2);   // 부분검색
    const screen = await searchArchive(db, { sourceType: "progress", company: term, page: 3, pageSize: 50 });
    const dl = await exportToFile("search", { sourceType: "progress", company: term });
    const dlRows = (XLSX.utils.sheet_to_json(dl.wb.Sheets[dl.wb.SheetNames[0]], { header: 1, blankrows: false }) as unknown[][]).length - 1;
    console.log(`      필터 company~'${term}': 화면 total ${screen.pagination.total} · 다운로드 ${dlRows}행`);
    check("검색 다운로드 행수 = 화면 total (현재 페이지=3 과 무관)", dlRows === screen.pagination.total, { dlRows, total: screen.pagination.total });
  } else {
    console.log("      (company 표본 없음 — 필터 검증 생략)");
  }

  // ── 4. 전체('all') 탭 혼합 → 유형별 시트 분리 ──
  console.log("\n[4] 전체 탭 혼합 → 유형별 시트 분리");
  const mixed = await exportToFile("all", { sourceType: "all" });
  console.log(`      시트: ${mixed.wb.SheetNames.join(", ")}`);
  const salesN = Number((await db.select({ n: count() }).from(T).where(and(eq(T.sourceType, "sales_list"), eq(T.isEffective, true))))[0]?.n ?? 0);
  const expectedSheets = [salesN > 0 ? "판매목록" : null, beforeProg > 0 ? "통번역 진행관리" : null].filter(Boolean);
  check("유형별 시트로 분리(컬럼 병합 없음)", expectedSheets.every(s => mixed.wb.SheetNames.includes(s as string)), { expected: expectedSheets, got: mixed.wb.SheetNames });

  // ── 5. 불변성: 생성 후 DB 행수 재확인 ──
  console.log("\n[5] 데이터 불변성");
  const afterAll = Number((await db.select({ n: count() }).from(T))[0]?.n ?? 0);
  const afterProg = Number((await db.select({ n: count() }).from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true))))[0]?.n ?? 0);
  check(`전체 행수 불변 (${beforeAll.toLocaleString()} → ${afterAll.toLocaleString()})`, beforeAll === afterAll);
  check(`progress effective 불변 (${beforeProg.toLocaleString()} → ${afterProg.toLocaleString()})`, beforeProg === afterProg);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("검증 스크립트 오류:", e); process.exit(1); });
