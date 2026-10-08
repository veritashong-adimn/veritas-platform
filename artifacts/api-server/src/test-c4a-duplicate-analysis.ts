// C-4A Preview 중복 원본 검증(analyzeArchiveDuplicates) — 순수함수 테스트(DB 미접근).
// 별도 파일/workspace 경로 없이 buildArchivePreview 가 메모리에 보유한 row 만으로 검증한다.
//   §13-1 완전 동일 2행 → duplicate 1 / EXACT / safeToSkip=true
//   §13-2 서로 다른 행   → duplicate 아님
//   §13-3 null vs "" / type 차이 → difference 감지 / safeToSkip=false
//   §13-4 동일 3행       → excludedCount=2
//   불변식: duplicateExcludedRows === Preview duplicate count(= route 의 seen/existing 규칙)
import * as XLSX from "xlsx";
import { buildArchivePreview, analyzeArchiveDuplicates, type ArchivePreviewRow } from "./services/legacyArchiveResolve";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
function buildBook(sheetName: string, aoa: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
// route 의 Preview duplicate 계산을 그대로 재현(불변식 검증용).
function previewDuplicateCount(rows: ArchivePreviewRow[], existing: Set<string>): number {
  const seen = new Set<string>(); let dup = 0;
  for (const r of rows) { if (existing.has(r.rowHash) || seen.has(r.rowHash)) dup++; else seen.add(r.rowHash); }
  return dup;
}
function preview(aoa: unknown[][], sheet = "판매목록"): ArchivePreviewRow[] {
  return buildArchivePreview(buildBook(sheet, aoa), "sales_list").flatMap(s => s.rows);
}

const H = ["견적서발행일", "거래처명", "비고", "고객명", "상품명"]; // 4개 동의어 매칭(비고는 미인식=varying 컬럼)

function main() {
  const NONE = new Set<string>();

  // §13-1 완전 동일 2행
  {
    const rows = preview([H,
      ["2021-03-15", "삼성전자", "메모", "박담당", "영어순차통역"],
      ["2021-03-15", "삼성전자", "메모", "박담당", "영어순차통역"],
    ]);
    const { analysis, groups } = analyzeArchiveDuplicates(rows, NONE);
    check("1. 완전 동일 2행 → duplicateExcludedRows=1", analysis.duplicateExcludedRows === 1, analysis);
    check("1. duplicateGroups=1", analysis.duplicateGroups === 1, analysis.duplicateGroups);
    check("1. EXACT_DUPLICATE", groups[0]?.classification === "EXACT_DUPLICATE", groups[0]?.classification);
    check("1. exactDuplicateRows=1", analysis.exactDuplicateRows === 1, analysis.exactDuplicateRows);
    check("1. safeToSkip=true", analysis.safeToSkip === true, analysis.safeToSkip);
    check("1. 불변식: excludedRows == Preview duplicate", analysis.duplicateExcludedRows === previewDuplicateCount(rows, NONE));
  }

  // §13-2 서로 다른 행 → 중복 아님
  {
    const rows = preview([H,
      ["2021-03-15", "삼성전자", "메모", "박담당", "영어순차통역"],
      ["2021-06-20", "엘지화학", "메모2", "최담당", "영한번역"],
    ]);
    const { analysis } = analyzeArchiveDuplicates(rows, NONE);
    check("2. 서로 다른 행 → duplicateExcludedRows=0", analysis.duplicateExcludedRows === 0, analysis);
    check("2. duplicateGroups=0", analysis.duplicateGroups === 0, analysis.duplicateGroups);
    check("2. safeToSkip=true(위험 없음)", analysis.safeToSkip === true, analysis.safeToSkip);
    check("2. 불변식: excludedRows == Preview duplicate", analysis.duplicateExcludedRows === previewDuplicateCount(rows, NONE));
  }

  // §13-3a type 차이(number 1 vs string "1") — stableRowContent 는 같아 hash 동일, source_raw 는 다름
  {
    const rows = preview([H,
      ["2021-03-15", "삼성전자", 1,   "박담당", "영어순차통역"],
      ["2021-03-15", "삼성전자", "1", "박담당", "영어순차통역"],
    ]);
    const sameHash = rows.length === 2 && rows[0].rowHash === rows[1].rowHash;
    check("3a. type차이 두 행 hash 동일(= 같은 중복 group)", sameHash, rows.map(r => r.rowHash));
    const { analysis, groups } = analyzeArchiveDuplicates(rows, NONE);
    check("3a. SOURCE_RAW_DIFFERENT", groups[0]?.classification === "SOURCE_RAW_DIFFERENT", groups[0]?.classification);
    check("3a. type_diff 감지", groups[0]?.differences.some(d => d.kind === "type_diff") === true, groups[0]?.differences);
    check("3a. safeToSkip=false", analysis.safeToSkip === false, analysis.safeToSkip);
    check("3a. sourceRawDifferentRows=1", analysis.sourceRawDifferentRows === 1, analysis.sourceRawDifferentRows);
  }

  // §13-3b null vs "" — 둘 다 stableRowContent 는 "" 로 접혀 hash 동일, source_raw 는 null vs "" 로 다름
  {
    const rows = preview([H,
      ["2021-03-15", "삼성전자", "",   "박담당", "영어순차통역"],
      ["2021-03-15", "삼성전자", null, "박담당", "영어순차통역"],
    ]);
    const sameHash = rows.length === 2 && rows[0].rowHash === rows[1].rowHash;
    check("3b. null vs \"\" 두 행 hash 동일", sameHash, rows.map(r => ({ h: r.rowHash, raw: r.sourceRaw })));
    if (sameHash) {
      const { analysis, groups } = analyzeArchiveDuplicates(rows, NONE);
      check("3b. null/empty 차이 감지", groups[0]?.nullEmptyDiffs.length ? true : false, groups[0]?.differences);
      check("3b. safeToSkip=false", analysis.safeToSkip === false, analysis.safeToSkip);
      check("3b. nullEmptyDifferenceRows=1", analysis.nullEmptyDifferenceRows === 1, analysis.nullEmptyDifferenceRows);
    } else {
      console.log("  ⚠️ 3b. xlsx 가 ''/null 을 동일 처리하지 않아 hash 가 달라짐 — 3a(type_diff)로 §6 커버됨");
    }
  }

  // §13-4 동일 3행 → excludedCount=2
  {
    const same = ["2021-03-15", "삼성전자", "메모", "박담당", "영어순차통역"];
    const rows = preview([H, same, same, same]);
    const { analysis, groups } = analyzeArchiveDuplicates(rows, NONE);
    check("4. 동일 3행 → duplicateExcludedRows=2", analysis.duplicateExcludedRows === 2, analysis);
    check("4. groupCount=3 / excludedCount=2", groups[0]?.groupCount === 3 && groups[0]?.excludedCount === 2, groups[0]);
    check("4. EXACT / exactDuplicateRows=2", groups[0]?.classification === "EXACT_DUPLICATE" && analysis.exactDuplicateRows === 2, analysis);
    check("4. 불변식: excludedRows == Preview duplicate", analysis.duplicateExcludedRows === previewDuplicateCount(rows, NONE));
  }

  // 추가: 기존 DB 에 이미 존재(existing) 하는 hash 는 파일 내 1건이어도 excluded.
  {
    const rows = preview([H, ["2021-03-15", "삼성전자", "메모", "박담당", "영어순차통역"]]);
    const existing = new Set<string>([rows[0].rowHash]);
    const { analysis } = analyzeArchiveDuplicates(rows, existing);
    check("5. DB 기존 hash 1건 → excludedRows=1 / EXACT", analysis.duplicateExcludedRows === 1 && analysis.exactDuplicateRows === 1, analysis);
    check("5. 불변식: excludedRows == Preview duplicate", analysis.duplicateExcludedRows === previewDuplicateCount(rows, existing));
  }

  console.log(`\n결과: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
