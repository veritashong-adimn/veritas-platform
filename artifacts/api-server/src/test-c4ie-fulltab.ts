// C-4I-e 전체 탭 전체컬럼 표시 검증 (READ-ONLY). INSERT/UPDATE/DELETE 없음.
//   검증: '전체' 탭 단일 progress → full(41컬럼). '전체' 탭 결과 = '진행관리' 탭 결과(헤더·행·순서·건수) 일치.
//         필터 적용 후에도 일치. 데이터 30,142행 불변.
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { searchArchive, searchArchiveFull, progressCanonicalHeaders, type ArchiveSearchFilters } from "./routes/legacyArchive";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
const T = legacyArchiveRowsTable;

// 라우트의 serveFull 판정을 그대로 재현: '전체' 탭 필터 결과의 distinct source_type.
async function distinctTypes(f: ArchiveSearchFilters): Promise<string[]> {
  const where = f.sourceType && f.sourceType !== "all" ? and(eq(T.sourceType, f.sourceType), eq(T.isEffective, true)) : eq(T.isEffective, true);
  const rows = await db.selectDistinct({ t: T.sourceType }).from(T).where(where);
  return rows.map((r: any) => r.t).filter(Boolean);
}

// full 응답 헤더 계산(라우트와 동일 규칙): canonical(progress) + 폴백 union.
async function fullHeaders(rows: any[]): Promise<{ cols: string[]; resolved: boolean }> {
  const { headers, resolved } = await progressCanonicalHeaders(db, "progress");
  let cols = headers;
  if (!resolved) {
    const seen = new Set<string>(); const union: string[] = [];
    for (const r of rows) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); union.push(k); }
    cols = union;
  } else {
    const seen = new Set(cols); for (const r of rows) for (const k of Object.keys(r.sourceRaw ?? {})) if (!seen.has(k)) { seen.add(k); cols = [...cols, k]; }
  }
  return { cols, resolved };
}

async function main() {
  console.log("\n=== C-4I-e 전체 탭 전체컬럼 표시 검증 (READ-ONLY) ===\n");
  const before = Number((await db.select({ n: count() }).from(T))[0]?.n ?? 0);

  // ── 1. '전체' 탭(필터 없음) → 단일 progress 판정 → full ──
  console.log("[1] '전체' 탭 필터 없음");
  const allTypes = await distinctTypes({ sourceType: "all" });
  console.log(`      distinct source_type = [${allTypes.join(", ")}]`);
  const serveFull = allTypes.length === 1 && allTypes[0] === "progress";
  check("단일 progress → full 뷰 판정", serveFull, allTypes);

  const allFull = await searchArchiveFull(db, { sourceType: "all", page: 1, pageSize: 50 });
  const progFull = await searchArchiveFull(db, { sourceType: "progress", page: 1, pageSize: 50 });
  check(`'전체' 탭 total 30,142`, allFull.pagination.total === 30142, allFull.pagination.total);
  check(`'진행관리' 탭 total 30,142`, progFull.pagination.total === 30142, progFull.pagination.total);
  check("두 탭 total 일치", allFull.pagination.total === progFull.pagination.total);
  check("두 탭 페이지당 50행", allFull.pagination.pageSize === 50 && allFull.rows.length === Math.min(50, allFull.pagination.total));

  // 헤더(41컬럼) 일치
  const allH = await fullHeaders(allFull.rows as any[]);
  const progH = await fullHeaders(progFull.rows as any[]);
  check("'전체' 탭 원본 컬럼 41개", allH.cols.length === 41, allH.cols.length);
  check("두 탭 헤더(이름·순서) 완전 일치", JSON.stringify(allH.cols) === JSON.stringify(progH.cols), { all: allH.cols.slice(0, 3), prog: progH.cols.slice(0, 3) });

  // 1페이지 행(id·순서) 일치
  const allIds = (allFull.rows as any[]).map(r => r.id);
  const progIds = (progFull.rows as any[]).map(r => r.id);
  check("두 탭 1페이지 행 id·순서 일치", JSON.stringify(allIds) === JSON.stringify(progIds), { all: allIds.slice(0, 3), prog: progIds.slice(0, 3) });
  // 값 일치(1행 source_raw 전체)
  if (allFull.rows[0] && progFull.rows[0]) {
    check("1행 source_raw 값 일치", JSON.stringify((allFull.rows as any[])[0].sourceRaw) === JSON.stringify((progFull.rows as any[])[0].sourceRaw));
    check("1행 Excel 행번호(source_row) 일치", (allFull.rows as any[])[0].sourceRow === (progFull.rows as any[])[0].sourceRow);
  }

  // ── 2. 검색어 필터 적용 후 두 탭 일치 ──
  console.log("\n[2] 검색어 필터 적용 후 두 탭 일치");
  const sample = (await db.select({ c: T.companyName }).from(T)
    .where(and(eq(T.sourceType, "progress"), eq(T.isEffective, true), sql`${T.companyName} is not null`)).limit(1))[0]?.c;
  if (sample) {
    const term = String(sample).slice(0, 2);
    const a = await searchArchiveFull(db, { sourceType: "all", company: term, page: 1, pageSize: 50 });
    const b = await searchArchiveFull(db, { sourceType: "progress", company: term, page: 1, pageSize: 50 });
    console.log(`      filter company~'${term}': 전체 ${a.pagination.total} · 진행관리 ${b.pagination.total}`);
    check("필터 후 total 일치", a.pagination.total === b.pagination.total, { a: a.pagination.total, b: b.pagination.total });
    check("필터 후 1페이지 행 일치", JSON.stringify((a.rows as any[]).map(r => r.id)) === JSON.stringify((b.rows as any[]).map(r => r.id)));
    // 요약 목록(searchArchive)과도 건수 일치(검색 조건·결과 건수 불변 — 요구 5)
    const summ = await searchArchive(db, { sourceType: "all", company: term, page: 1, pageSize: 50 });
    check("요약 total 과도 일치(건수 규칙 불변)", summ.pagination.total === a.pagination.total, { summ: summ.pagination.total, full: a.pagination.total });
  } else {
    console.log("      (company 표본 없음 — 필터 검증 생략)");
  }

  // ── 3. 불변성 ──
  console.log("\n[3] 데이터 불변성");
  const after = Number((await db.select({ n: count() }).from(T))[0]?.n ?? 0);
  check(`전체 행수 불변 (${before.toLocaleString()} → ${after.toLocaleString()})`, before === after);

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 ===\n`);
  process.exit(fail > 0 ? 1 : 0);   // 파일 리다이렉트는 동기 flush → 출력 보존.
}

main().catch((e) => { console.error("검증 스크립트 오류:", e); process.exit(1); });
