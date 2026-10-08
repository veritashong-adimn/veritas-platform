// C-4D Execute — source identity 기반 저장/멱등 검증. 전부 transaction 내 수행 후 ROLLBACK(실데이터 무변경).
//   A 파일 내부 동일행 보존 / B 동일 파일 재업로드 0 / C 파일명 변경 0 / D 다른 bytes 동일내용 보존 /
//   E source identity 충돌 → STOP(throw) / F Current Master 불변.
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable, productsTable, companiesTable, contactsTable, usersTable, legacyMasterMappingsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { executeArchiveImport } from "./routes/legacyArchive";
import { computeFileHash, buildArchivePreview } from "./services/legacyArchiveResolve";

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
const H = ["견적서발행일", "거래처명", "통번역사명", "상품명", "언어", "통번역사납품일", "통번역사지급일", "지급액(세전)"];
const SAME = ["2024-10-25", "UNESCAP 동북아지역사무소", "강원대", "영어 동시통역", "영어", "2024-10-25", "2024-11-15", "800000"];
const PROG_AOA: unknown[][] = [H, SAME, SAME, SAME, ["2024-09-01", "(주)세화", "이대우", "영어통역", "영어", "2024-09-02", "2024-10-15", "500000"]];

async function masterCounts(tx: any) {
  const c = async (t: any) => (await tx.select({ n: count() }).from(t))[0].n as number;
  return { products: await c(productsTable), companies: await c(companiesTable), contacts: await c(contactsTable), users: await c(usersTable), mappings: await c(legacyMasterMappingsTable) };
}
async function countByFile(tx: any, fileHash: string) {
  return Number((await tx.select({ n: count() }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.fileHash, fileHash), eq(legacyArchiveRowsTable.sourceType, "progress"))))[0].n);
}

async function main() {
  try {
    await db.transaction(async (tx: any) => {
      const before = await masterCounts(tx);

      const buf1 = buildBook("진행관리", PROG_AOA);
      const h1 = computeFileHash(buf1);

      // A: 파일 내부 동일 3행 + 1행 → 4건 모두 저장(원본 보존)
      const rA = await executeArchiveImport(tx, { buffer: buf1, sourceType: "progress", fileName: "TranSchedule.xls", performerId: null });
      check("A. 파일 내부 동일행 포함 created=4(보존)", rA.created === 4 && rA.skippedDuplicate === 0, rA);
      check("A. DB 저장 4건", await countByFile(tx, h1) === 4);
      const stored = await tx.select().from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.fileHash, h1), eq(legacyArchiveRowsTable.sourceType, "progress")));
      const dupRows = stored.filter((r: any) => r.companyName === "UNESCAP 동북아지역사무소");
      check("A. 동일내용 3행 저장됨(같은 row_hash, 다른 source_row)",
        dupRows.length === 3 && new Set(dupRows.map((r: any) => r.rowHash)).size === 1 && new Set(dupRows.map((r: any) => r.sourceRow)).size === 3,
        dupRows.map((r: any) => ({ h: r.rowHash?.slice(0, 8), row: r.sourceRow })));

      // B: 동일 파일 재업로드 → created 0, skipped 4, count 불변
      const rB = await executeArchiveImport(tx, { buffer: buf1, sourceType: "progress", fileName: "TranSchedule.xls", performerId: null });
      check("B. 재업로드 created=0 / skipped=4", rB.created === 0 && rB.skippedDuplicate === 4, rB);
      check("B. DB count 불변(4)", await countByFile(tx, h1) === 4);

      // C: 파일명만 변경(동일 bytes) → created 0
      const rC = await executeArchiveImport(tx, { buffer: buf1, sourceType: "progress", fileName: "TranSchedule_backup.xls", performerId: null });
      check("C. 파일명 변경 재업로드 created=0", rC.created === 0, rC);
      check("C. DB count 불변(4)", await countByFile(tx, h1) === 4);

      // D: 다른 bytes(추가 시트) 동일 데이터 → 다른 파일로 보존(created 4)
      const bufD = buildBook("진행관리", PROG_AOA, { name: "요약", aoa: [["제목"], ["값"]] });
      const hD = computeFileHash(bufD);
      check("D. file_hash 상이", hD !== h1);
      const rD = await executeArchiveImport(tx, { buffer: bufD, sourceType: "progress", fileName: "다른자료.xls", performerId: null });
      check("D. 다른 파일 → created=4(보존)", rD.created === 4, rD);
      check("D. 파일별 독립 저장(h1=4, hD=4)", (await countByFile(tx, h1)) === 4 && (await countByFile(tx, hD)) === 4);

      // E: source identity 충돌 → throw(자동 overwrite/skip 금지)
      const bufE = buildBook("진행관리", [H, ["2023-01-01", "충돌테스트사", "홍길동", "영어통역", "영어", "2023-01-02", "2023-02-15", "100000"]]);
      const hE = computeFileHash(bufE);
      const eRows = buildArchivePreview(bufE, "progress").flatMap(s => s.rows);
      await tx.insert(legacyArchiveRowsTable).values({
        sourceType: "progress", sourceSystem: "old_crm", fileHash: hE,
        sourceSheet: eRows[0].sourceSheet, sourceRow: eRows[0].sourceRow,
        sourceRaw: { 변조: true }, rowHash: "TAMPERED_CONTENT_HASH",
      });
      let threw = false, code = "";
      try { await executeArchiveImport(tx, { buffer: bufE, sourceType: "progress", fileName: "충돌.xls", performerId: null }); }
      catch (e: any) { threw = true; code = e?.code; }
      check("E. 충돌 → throw", threw === true);
      check("E. code=ARCHIVE_IDENTITY_CONFLICT", code === "ARCHIVE_IDENTITY_CONFLICT", code);
      check("E. 충돌 파일 신규 저장 없음(기존 1건=변조행만)", (await countByFile(tx, hE)) === 1);

      // F: Current Master 불변
      const after = await masterCounts(tx);
      check("F. Product/Company/Contact/User/Mapping count 불변",
        before.products === after.products && before.companies === after.companies &&
        before.contacts === after.contacts && before.users === after.users && before.mappings === after.mappings,
        { before, after });

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  const left = await db.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.companyName, "UNESCAP 동북아지역사무소"));
  check("ROLLBACK: 테스트 archive row 미잔존", Number(left[0].n) === 0, left[0].n);

  console.log(`\n== C-4D execute tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
