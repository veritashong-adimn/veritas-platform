// C-4G 스냅샷 세대 모델 — Execute/전환/조회 검증. 전부 transaction 내 수행 후 ROLLBACK(실데이터 무변경).
//   A 최초 snapshot / B 동일내용 다른 행 보존 / C 동일 파일 재업로드 / D 파일명만 변경 /
//   E 업데이트 파일(세대 전환·historical 보존·기본조회=최신) / F 기존 record 수정 이력 /
//   G 실패 rollback / H source_type 독립 / I Current Master 불변.
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable, importBatchesTable, productsTable, companiesTable, contactsTable, usersTable, legacyMasterMappingsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { executeArchiveImport, searchArchive } from "./routes/legacyArchive";
import { computeFileHash } from "./services/legacyArchiveResolve";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
function buildBook(sheetName: string, aoa: unknown[][], extra?: { name: string; aoa: unknown[][] }): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  if (extra) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extra.aoa), extra.name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const PH = ["견적서발행일", "거래처명", "통번역사명", "상품명", "언어", "통번역사납품일", "지급액(세전)"];
const SAME = ["2024-10-25", "UNESCAP", "강원대", "영어 동시통역", "영어", "2024-10-25", "800000"];
async function masterCounts(tx: any) {
  const c = async (t: any) => (await tx.select({ n: count() }).from(t))[0].n as number;
  return { products: await c(productsTable), companies: await c(companiesTable), contacts: await c(contactsTable), users: await c(usersTable), mappings: await c(legacyMasterMappingsTable) };
}
const physRows = async (tx: any, st: string) => Number((await tx.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.sourceType, st)))[0].n);
const currentSnapshotRows = async (tx: any, st: string) => (await searchArchive(tx, { sourceType: st as any, pageSize: 200 })).pagination.total; // 기본 current

async function main() {
  try {
    await db.transaction(async (tx: any) => {
      const before = await masterCounts(tx);

      // A+B: 최초 snapshot — 동일내용 3행 + 1행 = 4행 전부 저장, current
      const s1 = buildBook("진행관리", [PH, SAME, SAME, SAME, ["2024-09-01", "세화", "이대우", "영어통역", "영어", "2024-09-02", "500000"]]);
      const rA = await executeArchiveImport(tx, { buffer: s1, sourceType: "progress", fileName: "s1.xls", performerId: null });
      check("A. 최초 snapshot created=4 / mode=new_snapshot", rA.created === 4 && rA.mode === "new_snapshot", rA);
      check("B. 동일내용 3행 전부 저장(physical=4)", await physRows(tx, "progress") === 4);
      check("A. 기본조회(current)=4", await currentSnapshotRows(tx, "progress") === 4);
      const batch1 = (await tx.select().from(importBatchesTable).where(eq(importBatchesTable.id, rA.snapshotId!)))[0];
      check("A. snapshot1 isCurrent=true", batch1.isCurrent === true, batch1?.isCurrent);

      // C: 동일 파일 재업로드 → 새 snapshot 없음, 추가 저장 0
      const rC = await executeArchiveImport(tx, { buffer: s1, sourceType: "progress", fileName: "s1.xls", performerId: null });
      check("C. 동일 파일 재업로드 mode=duplicate_file / created=0", rC.mode === "duplicate_file" && rC.created === 0, rC);
      check("C. physical 불변(4)", await physRows(tx, "progress") === 4);

      // D: 파일명만 변경(동일 bytes) → 새 snapshot 없음
      const rD = await executeArchiveImport(tx, { buffer: s1, sourceType: "progress", fileName: "s1_backup.xls", performerId: null });
      check("D. 파일명 변경 재업로드 mode=duplicate_file / created=0", rD.mode === "duplicate_file" && rD.created === 0, rD);

      // E: 업데이트 파일(다른 bytes) → 새 snapshot, 세대 전환
      const s2 = buildBook("진행관리", [PH, SAME, SAME, SAME,
        ["2024-09-01", "세화", "이대우", "영어통역", "영어", "2024-09-02", "500000"],
        ["2024-11-01", "한독", "김명화", "러시아어순차통역", "러시아어", "2024-11-02", "700000"]]);  // 5행
      check("E. s2 file_hash 상이", computeFileHash(s2) !== computeFileHash(s1));
      const rE = await executeArchiveImport(tx, { buffer: s2, sourceType: "progress", fileName: "s2.xls", performerId: null });
      check("E. s2 created=5 / mode=new_snapshot", rE.created === 5 && rE.mode === "new_snapshot", rE);
      check("E. s1 superseded(강등 대상에 포함)", rE.supersededSnapshotIds.includes(rA.snapshotId!), rE.supersededSnapshotIds);
      check("E. physical = 4+5 = 9 (s1 보존)", await physRows(tx, "progress") === 9, await physRows(tx, "progress"));
      check("E. 기본조회(current)=5 (s2만)", await currentSnapshotRows(tx, "progress") === 5, await currentSnapshotRows(tx, "progress"));
      check("E. 전체 이력 조회=9", (await searchArchive(tx, { sourceType: "progress", snapshot: "all", pageSize: 200 })).pagination.total === 9);
      const b1after = (await tx.select().from(importBatchesTable).where(eq(importBatchesTable.id, rA.snapshotId!)))[0];
      const b2 = (await tx.select().from(importBatchesTable).where(eq(importBatchesTable.id, rE.snapshotId!)))[0];
      check("E. s1 historical / s2 current", b1after.isCurrent === false && b2.isCurrent === true, { s1: b1after.isCurrent, s2: b2.isCurrent });

      // F: 기존 record 수정 — snapshot3 에서 UNESCAP 금액 변경. 과거 snapshot 원본 유지.
      const s3 = buildBook("진행관리", [PH,
        ["2024-10-25", "UNESCAP", "강원대", "영어 동시통역", "영어", "2024-10-25", "999999"],  // 금액 수정
        ["2024-09-01", "세화", "이대우", "영어통역", "영어", "2024-09-02", "500000"]]);
      const rF = await executeArchiveImport(tx, { buffer: s3, sourceType: "progress", fileName: "s3.xls", performerId: null });
      check("F. s3 created=2 / current 전환", rF.created === 2 && rF.mode === "new_snapshot", rF);
      const curUnescap = await tx.select({ p: legacyArchiveRowsTable.payoutPretax }).from(legacyArchiveRowsTable)
        .where(and(eq(legacyArchiveRowsTable.isCurrent, true), eq(legacyArchiveRowsTable.companyName, "UNESCAP")));
      check("F. 기본조회 UNESCAP 지급액=999999(최신)", curUnescap.length === 1 && Number(curUnescap[0].p) === 999999, curUnescap);
      const histUnescap = await tx.select({ p: legacyArchiveRowsTable.payoutPretax }).from(legacyArchiveRowsTable)
        .where(and(eq(legacyArchiveRowsTable.isCurrent, false), eq(legacyArchiveRowsTable.companyName, "UNESCAP")));
      check("F. 이력에 과거 지급액 800000 보존", histUnescap.some((r: any) => Number(r.p) === 800000), histUnescap.map((r: any) => r.p));

      // G: 실패 rollback — 저장 중 오류 유도(savepoint 내부 try). s4 저장 실패 시 기존 current(s3) 유지.
      const curBefore = await currentSnapshotRows(tx, "progress");
      const s4 = buildBook("진행관리", [PH, ["2025-01-01", "실패테스트", "홍길동", "영어통역", "영어", "2025-01-02", "100"]]);
      let threw = false;
      try {
        await tx.transaction(async (tx2: any) => {
          await executeArchiveImport(tx2, { buffer: s4, sourceType: "progress", fileName: "s4.xls", performerId: null });
          throw new Error("__INJECTED_FAILURE__");  // 저장 후 강제 실패 → savepoint rollback
        });
      } catch (e: any) { threw = e.message === "__INJECTED_FAILURE__"; }
      check("G. 주입 실패 발생", threw);
      check("G. 실패 후 current 불변(s3 유지)", await currentSnapshotRows(tx, "progress") === curBefore, { before: curBefore, after: await currentSnapshotRows(tx, "progress") });
      check("G. 실패 snapshot physical 저장 0(s4 미잔존)", (await tx.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.companyName, "실패테스트")))[0].n === 0);

      // H: source_type 독립 — sales_list snapshot 올려도 progress current 불변
      const progCurBefore = await currentSnapshotRows(tx, "progress");
      const sales = buildBook("판매목록", [["견적서발행일", "거래처명", "고객명", "상품명", "총액", "입금여부"], ["2024-05-01", "ABC", "김", "번역", "100000", "입금"]]);
      const rH = await executeArchiveImport(tx, { buffer: sales, sourceType: "sales_list", fileName: "sl.xls", performerId: null });
      check("H. sales_list snapshot created=1", rH.created === 1, rH);
      check("H. progress current 불변", await currentSnapshotRows(tx, "progress") === progCurBefore, { before: progCurBefore, after: await currentSnapshotRows(tx, "progress") });
      check("H. sales_list current=1", await currentSnapshotRows(tx, "sales_list") === 1);

      // I: Current Master 불변
      const after = await masterCounts(tx);
      check("I. Current Master count 전부 불변",
        JSON.stringify(before) === JSON.stringify(after), { before, after });

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  const left = await db.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.companyName, "UNESCAP"));
  check("ROLLBACK: 테스트 archive row 미잔존", Number(left[0].n) === 0, left[0].n);

  console.log(`\n== C-4G snapshot tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
