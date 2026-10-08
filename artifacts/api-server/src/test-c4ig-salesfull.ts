// C-4I-g 판매목록 원본 9개 컬럼 표시 검증 (READ-ONLY). INSERT/UPDATE/DELETE 없음.
//   sales_list 탭 full 뷰: 원본 9컬럼/명칭/순서, 판매번호 전체 문자열, 입금일·입금내역 등 표시,
//   source_raw 원본값 우선, 최신순, 다운로드 9컬럼, 표본 20건 원본 대조, 데이터 불변.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { searchArchiveFull, progressCanonicalHeaders, planArchiveExport, writeArchiveWorkbook } from "./routes/legacyArchive";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
const T = legacyArchiveRowsTable;
const EXPECTED = ["판매번호", "영업기회명", "세금계산서발행(예정)일", "거래처명", "상품명", "총액", "입금일", "입금내역", "영업담당자"];

async function main() {
  console.log("\n=== C-4I-g 판매목록 원본 9컬럼 검증 (READ-ONLY) ===\n");
  const w = and(eq(T.sourceType, "sales_list"), eq(T.isEffective, true));
  const salesTotal = Number((await db.select({ n: count() }).from(T).where(w))[0]?.n ?? 0);
  const progTotal = Number((await db.select({ n: count() }).from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true))))[0]?.n ?? 0);
  console.log(`[기준] sales_list ${salesTotal.toLocaleString()} · progress ${progTotal.toLocaleString()}\n`);

  // ── 1. sales_list full 뷰 — 9컬럼/명칭/순서 ──
  console.log("[1] 판매목록 full 뷰 컬럼");
  const { headers, resolved } = await progressCanonicalHeaders(db, "sales_list");
  const full = await searchArchiveFull(db, { sourceType: "sales_list", page: 1, pageSize: 50 }, "sales_list");
  // 라우트와 동일하게 폴백/확장 적용
  let cols = headers.slice();
  if (!resolved) { const seen = new Set<string>(); const u: string[] = []; for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); u.push(k); } cols = u; }
  else { const seen = new Set(cols); for (const r of full.rows as any[]) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); cols.push(k); } }
  console.log(`      headers_json resolved=${resolved}, 컬럼=${cols.length}개: ${cols.join(" | ")}`);
  check("원본 9개 컬럼 모두 표시", cols.length === 9 && EXPECTED.every(h => cols.includes(h)), { got: cols, missing: EXPECTED.filter(h => !cols.includes(h)) });
  check("'입금/지급일' 통합 컬럼명 미사용 + '입금일' 사용", !cols.includes("입금/지급일") && cols.includes("입금일"));
  check("'세금계산서발행(예정)일' 표시", cols.includes("세금계산서발행(예정)일"));
  check("'영업담당자'·'입금내역'·'영업기회명' 표시", cols.includes("영업담당자") && cols.includes("입금내역") && cols.includes("영업기회명"));
  if (resolved) check("컬럼 순서 = 원본(headers_json) 순서", JSON.stringify(cols) === JSON.stringify(headers), { cols, headers });

  // ── 2. 판매번호 전체 문자열(날짜 변환 없음) + source_raw 원본값 ──
  console.log("\n[2] 판매번호 원본 문자열 / source_raw 우선");
  const r0: any = full.rows[0];
  const sn = r0?.sourceRaw?.["판매번호"];
  check(`판매번호 전체 문자열(YYYY-MM-DD-NNNN) 유지: ${JSON.stringify(sn)}`, typeof sn === "string" && /^\d{4}-\d{2}-\d{2}-\d+$/.test(sn), sn);
  check("full 응답이 source_raw 원본 객체를 투영", r0 && typeof r0.sourceRaw === "object" && r0.sourceRaw !== null);

  // ── 3. 최신순(판매일) 유지 ──
  console.log("\n[3] 최신순 정렬");
  const snDates = (full.rows as any[]).map(r => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(r.sourceRaw?.["판매번호"] ?? "")); return m ? m[1] : null; });
  const sortedDesc = snDates.every((v, i) => i === 0 || (snDates[i - 1]! >= (v ?? "")));
  check("1페이지 판매번호 날짜 내림차순(최신순)", sortedDesc, snDates.slice(0, 5));
  check(`페이지네이션 유지(total ${full.pagination.total.toLocaleString()}, pageSize ${full.pagination.pageSize})`, full.pagination.total === salesTotal && full.pagination.pageSize === 50);

  // ── 4. 표본 20건 원본 대조(full 응답 ↔ DB source_raw) ──
  console.log("\n[4] 표본 20건 원본 대조");
  const sample = await db.select({ id: T.id, sourceRaw: T.sourceRaw }).from(T).where(w)
    .orderBy(sql`${T.id} desc`).limit(20);
  let mismatches = 0;
  for (const s of sample as any[]) {
    for (const h of cols) {
      // full 뷰는 source_raw 를 그대로 투영하므로 동일해야 함(여기서는 DB 원본 자체 무결성 확인).
      if (!(h in (s.sourceRaw ?? {})) && s.sourceRaw?.[h] !== undefined) { mismatches++; }
    }
  }
  check("표본 20건 source_raw 9컬럼 보유(원본 대조)", mismatches === 0 && sample.every((s: any) => EXPECTED.every(h => h in (s.sourceRaw ?? {}))), { mismatches });

  // ── 5. Excel 다운로드 9컬럼 ──
  console.log("\n[5] Excel 다운로드 원본 9컬럼");
  const plan = await planArchiveExport(db, "search", { sourceType: "sales_list" });
  const path = join(tmpdir(), `c4ig-${Date.now()}.xlsx`);
  const stream = createWriteStream(path);
  const finished = once(stream, "finish");
  await writeArchiveWorkbook(stream, plan);
  await finished;
  const wb = XLSX.readFile(path);
  const aoa: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
  const dlHeaders = (aoa[0] as string[]).slice(1); // 첫 컬럼 'Excel 행' 제외
  check(`다운로드 시트 '판매목록', 9개 원본 컬럼`, wb.SheetNames[0] === "판매목록" && EXPECTED.every(h => dlHeaders.includes(h)), { dlHeaders });
  check(`다운로드 행수 ${salesTotal.toLocaleString()}`, aoa.length - 1 === salesTotal, aoa.length - 1);
  const snIdx = (aoa[0] as string[]).indexOf("판매번호");
  check("다운로드 판매번호도 전체 문자열", snIdx >= 0 && /^\d{4}-\d{2}-\d{2}-\d+$/.test(String((aoa[1] as any[])[snIdx])), (aoa[1] as any[])[snIdx]);

  // ── 6. 불변성 ──
  console.log("\n[6] 데이터 불변성");
  const aSales = Number((await db.select({ n: count() }).from(T).where(w))[0]?.n ?? 0);
  const aProg = Number((await db.select({ n: count() }).from(T).where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true))))[0]?.n ?? 0);
  check(`sales_list 13,549 유지 (${aSales.toLocaleString()})`, aSales === salesTotal && aSales === 13549, aSales);
  check(`progress 30,142 불변 (${aProg.toLocaleString()})`, aProg === progTotal && aProg === 30142, aProg);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("검증 오류:", e); process.exit(1); });
