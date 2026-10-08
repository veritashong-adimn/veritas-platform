// C-4D Source Identity — 순수함수 테스트(DB 미접근).
//   row_hash = CONTENT HASH(identity 아님) / source identity = file_hash+type+sheet+row.
//   TEST A  파일 내부 동일행(내용 동일·source_row 상이) → 전부 저장 대상, identity 서로 다름.
//   file_hash  동일 bytes→동일 / 다른 bytes→상이 (파일명 무관: buffer 만 해시).
//   재업로드   동일 identity+동일 내용 → alreadyStored.
//   TEST E  동일 identity + 내용 상이 → conflict / safeToExecute=false.
import * as XLSX from "xlsx";
import {
  buildArchivePreview, computeFileHash, planArchiveImport, sourceIdentityKey, type ArchivePreviewRow,
} from "./services/legacyArchiveResolve";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
function buildBook(sheetName: string, aoa: unknown[][], extraSheet?: { name: string; aoa: unknown[][] }): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  if (extraSheet) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extraSheet.aoa), extraSheet.name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
function identityMap(rows: ArchivePreviewRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) m.set(sourceIdentityKey(r.sourceSheet, r.sourceRow), r.rowHash);
  return m;
}

const H = ["견적서발행일", "거래처명", "통번역사명", "상품명", "언어", "통번역사납품일", "통번역사지급일", "지급액(세전)"];
const SAME = ["2024-10-25", "UNESCAP 동북아지역사무소", "강원대", "영어 동시통역", "영어", "2024-10-25", "2024-11-15", "800000"];
// 파일 내부 동일행 3개(모든 셀 동일) + 서로 다른 1행.
const PROG_AOA: unknown[][] = [H, SAME, SAME, SAME, ["2024-09-01", "(주)세화", "이대우", "영어통역", "영어", "2024-09-02", "2024-10-15", "500000"]];

function main() {
  const buf = buildBook("진행관리", PROG_AOA);
  const rows = buildArchivePreview(buf, "progress").flatMap(s => s.rows);
  check("행 4건 파싱", rows.length === 4, rows.length);

  // TEST A — 동일 3행: row_hash(content) 동일, source_row(identity) 상이
  const dupRows = rows.slice(0, 3);
  check("A. 동일 3행 row_hash 모두 동일(CONTENT HASH)", dupRows.every(r => r.rowHash === dupRows[0].rowHash), dupRows.map(r => r.rowHash));
  check("A. 동일 3행 source_row 모두 상이", new Set(dupRows.map(r => r.sourceRow)).size === 3, dupRows.map(r => r.sourceRow));
  check("A. identity key 3개 모두 상이", new Set(dupRows.map(r => sourceIdentityKey(r.sourceSheet, r.sourceRow))).size === 3);

  // 첫 업로드 계획: existing 없음 → 전부 저장 대상(동일행 포함 보존)
  const plan1 = planArchiveImport(rows, new Map());
  check("A. 첫 업로드 → toSaveRows=4(동일행 전부 보존)", plan1.toSaveRows.length === 4, plan1.toSaveRows.length);
  check("A. alreadyStored=0 / conflicts=0 / safeToExecute", plan1.alreadyStoredCount === 0 && plan1.conflicts.length === 0 && plan1.safeToExecute, plan1);

  // file_hash — 동일 bytes/다른 bytes
  const buf2same = buildBook("진행관리", PROG_AOA); // 동일 AOA 재작성
  const bufDiff = buildBook("진행관리", PROG_AOA, { name: "요약", aoa: [["제목"], ["값"]] }); // 파서가 스킵하는 추가 시트 → bytes 상이
  check("file_hash: 동일 buffer → 동일", computeFileHash(buf) === computeFileHash(buf));
  check("file_hash: 재작성 동일내용 → (대개)동일", computeFileHash(buf) === computeFileHash(buf2same), "deterministic write");
  check("D. file_hash: 추가시트로 bytes 상이 → file_hash 상이", computeFileHash(buf) !== computeFileHash(bufDiff));
  const rowsDiff = buildArchivePreview(bufDiff, "progress").flatMap(s => s.rows);
  check("D. 추가시트 파일도 데이터행은 동일하게 4건(요약 시트 스킵)", rowsDiff.length === 4, rowsDiff.length);

  // 재업로드(B/C): 동일 identity+동일 내용 → alreadyStored
  const existing = identityMap(rows);
  const plan2 = planArchiveImport(rows, existing);
  check("B/C. 재업로드 → toSaveRows=0", plan2.toSaveRows.length === 0, plan2.toSaveRows.length);
  check("B/C. alreadyStored=4 / isReupload / safeToExecute", plan2.alreadyStoredCount === 4 && plan2.isReupload && plan2.safeToExecute, plan2);

  // TEST E — 동일 identity + 내용 상이 → conflict
  const tampered = new Map(existing);
  const firstKey = sourceIdentityKey(rows[0].sourceSheet, rows[0].sourceRow);
  tampered.set(firstKey, "TAMPERED_CONTENT_HASH");
  const plan3 = planArchiveImport(rows, tampered);
  check("E. conflict=1", plan3.conflicts.length === 1, plan3.conflicts);
  check("E. safeToExecute=false", plan3.safeToExecute === false, plan3.safeToExecute);
  check("E. 나머지 3건은 alreadyStored", plan3.alreadyStoredCount === 3, plan3.alreadyStoredCount);

  console.log(`\n== C-4D identity(pure) tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
