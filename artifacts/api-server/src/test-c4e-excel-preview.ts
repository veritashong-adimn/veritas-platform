// C-4E Excel 원본 미리보기(buildExcelPreviewPage) — 순수함수 테스트(DB 미접근).
//   A header 순서 보존 / B sourceRow=실제 Excel 행 / C normalized 에 없는 원본 컬럼 투영 /
//   D null·빈문자 보존(미통합) / E trailing space 보존(no trim) / F pagination / G pageSize clamp.
import * as XLSX from "xlsx";
import { buildArchivePreview, buildExcelPreviewPage, clampPreviewPageSize } from "./services/legacyArchiveResolve";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
function buildBook(sheetName: string, aoa: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// 원본 header: normalized 에 없는 컬럼(상세정보/교통비/단위)을 포함. 순서를 섞어 보존 검증.
const HEADERS = ["견적서발행일", "거래처명", "통번역사명", "상세정보", "상품명", "언어", "교통비", "단위", "통번역사납품일", "지급액(세전)"];
function dataRow(i: number): unknown[] {
  return ["2024-10-25", "거래처" + i, "통역사" + i, "상세-" + i, "영어 동시통역 ", "영어", 10000 + i, "건", "2024-10-26", 800000 + i];
}
// 50행 초과 → pagination. 특수행(2행)에 null/빈문자/trailing space 포함.
const AOA: unknown[][] = [HEADERS];
AOA.push(["2024-01-01", "", null, "상세-특수", "영어 동시통역 ", "영어", 0, "건 ", "2024-01-02", 100]); // 빈문자/null/trailing space
for (let i = 1; i <= 129; i++) AOA.push(dataRow(i));  // 총 130 데이터행

function main() {
  const sheets = buildArchivePreview(buildBook("진행관리", AOA), "progress");
  const p1 = buildExcelPreviewPage(sheets, 1, 50);

  // A header 보존
  check("A. header 순서/전체 원본 그대로", JSON.stringify(p1.headers) === JSON.stringify(HEADERS), p1.headers);

  // B sourceRow — headerRowIndex=0 → 첫 데이터행 Excel 행번호 2
  check("B. 첫 행 sourceRow=2(실제 Excel 행)", p1.rows[0].sourceRow === 2, p1.rows[0].sourceRow);
  check("B. sourceRow 연속(2,3,4...)", p1.rows[1].sourceRow === 3 && p1.rows[2].sourceRow === 4, p1.rows.slice(0, 3).map(r => r.sourceRow));

  // C full column projection — normalized 에 없는 '상세정보'/'교통비'/'단위' 컬럼이 preview 에 존재
  for (const col of ["상세정보", "교통비", "단위"]) check(`C. 원본 컬럼 '${col}' 투영됨`, p1.headers.includes(col), p1.headers);
  check("C. values 길이 = headers 길이", p1.rows.every(r => r.values.length === p1.headers.length));

  // D null/빈문자 보존 — 특수행(sourceRow 2): 거래처명="" , 통번역사명=null
  const special = p1.rows.find(r => r.sourceRow === 2)!;
  const idxCompany = HEADERS.indexOf("거래처명"), idxTrans = HEADERS.indexOf("통번역사명");
  check("D. 빈 문자열 '' 보존(null 로 통합 안 함)", special.values[idxCompany] === "", JSON.stringify(special.values[idxCompany]));
  check("D. null(빈 셀) 보존", special.values[idxTrans] === null, JSON.stringify(special.values[idxTrans]));
  check("D. '' 과 null 구분됨", special.values[idxCompany] !== special.values[idxTrans]);

  // E trailing space 보존 — 상품명 '영어 동시통역 '
  const idxProd = HEADERS.indexOf("상품명");
  check("E. trailing space 보존(no trim)", special.values[idxProd] === "영어 동시통역 ", JSON.stringify(special.values[idxProd]));

  // F pagination — total 130, page1=50, page2=50, page3=30
  check("F. totalRows=130", p1.totalRows === 130, p1.totalRows);
  check("F. page1 rows=50", p1.rows.length === 50, p1.rows.length);
  const p2 = buildExcelPreviewPage(sheets, 2, 50);
  check("F. page2 rows=50, 첫 sourceRow=52", p2.rows.length === 50 && p2.rows[0].sourceRow === 52, { n: p2.rows.length, r: p2.rows[0]?.sourceRow });
  const p3 = buildExcelPreviewPage(sheets, 3, 50);
  check("F. page3(마지막) rows=30", p3.rows.length === 30, p3.rows.length);
  check("F. page1/page2 행 겹침 없음", p1.rows.at(-1)!.sourceRow + 1 === p2.rows[0].sourceRow, { last1: p1.rows.at(-1)?.sourceRow, first2: p2.rows[0]?.sourceRow });

  // G pageSize clamp — 최대 200, 기본 50
  check("G. 200 초과 → 200 clamp", clampPreviewPageSize(500) === 200, clampPreviewPageSize(500));
  check("G. 0/음수/NaN → 기본 50", clampPreviewPageSize(0) === 50 && clampPreviewPageSize(-3) === 50 && clampPreviewPageSize("abc") === 50);
  check("G. 100 허용", clampPreviewPageSize(100) === 100);
  check("G. buildExcelPreviewPage pageSize=999 → 200 반영", buildExcelPreviewPage(sheets, 1, 999).pageSize === 200);

  console.log(`\n== C-4E excel-preview tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
