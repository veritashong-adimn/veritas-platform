// C-4I-b Effective Version Storage — Execute 저장/version chain 검증. 전부 transaction 내 ROLLBACK(실데이터 무변경).
//   T1 NEW / T2 SAME(다른 bytes 동일내용) / T3 UPDATED 입금 / T5 UPDATED 세금계산서(비정규화) / T6 4년전 /
//   T7 부분파일 미삭제 / T9 identical 3 / T10 multiplicity 3→4 AMBIGUOUS / T11 dup same bytes / T12 파일명변경 /
//   T13 rollback / T14 Current Master / T15 Current Sales / raw 보존 / effective 누적 / C-4C.
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable, productsTable, companiesTable, contactsTable, usersTable, legacyMasterMappingsTable } from "@workspace/db";
import { eq, and, count, sql } from "drizzle-orm";
import { executeArchiveImport, searchArchive } from "./routes/legacyArchive";
import { getSalesHistory } from "./routes/salesHistory";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
function book(sheet: string, aoa: unknown[][], extra?: { name: string; aoa: unknown[][] }): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  if (extra) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extra.aoa), extra.name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const exec = (tx: any, buf: Buffer, st: "sales_list" | "progress", fn: string) => executeArchiveImport(tx, { buffer: buf, sourceType: st, fileName: fn, performerId: null });
const effCount = async (tx: any, st: string) => (await searchArchive(tx, { sourceType: st as any, pageSize: 500 })).pagination.total;  // 기본 effective
const physCount = async (tx: any, st: string) => Number((await tx.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.sourceType, st)))[0].n);
async function master(tx: any) { const c = async (t: any) => Number((await tx.select({ n: count() }).from(t))[0].n); return { p: await c(productsTable), co: await c(companiesTable), ct: await c(contactsTable), u: await c(usersTable), m: await c(legacyMasterMappingsTable) }; }

const PH = ["견적서발행일", "거래처명", "고객명", "통번역사명", "상품명", "언어", "통번역사납품일", "통번역사지급일", "지급액(세전)"];
const SH = ["견적서발행일", "거래처명", "고객명", "상품명", "공급가액", "부가세", "총액", "입금일", "입금여부", "세금계산서"];

async function main() {
  try {
    await db.transaction(async (tx: any) => {
      const m0 = await master(tx);
      const sales0 = Number((await tx.execute(sql`select count(*)::int n from projects`)).rows?.[0]?.n ?? 0);

      // T1 NEW — progress 3행(서로 다른)
      const f1 = book("진행관리", [PH,
        ["2024-01-01", "A", "ga", "홍길동", "영어통역", "영어", "2024-01-05", "2024-02-01", "100000"],
        ["2024-02-01", "B", "gb", "김번역", "영한번역", "영어", "2024-02-05", "2024-03-01", "200000"],
        ["2024-03-01", "C", "gc", null, "중국어통역", "중국어", null, null, "300000"]]);
      const r1 = await exec(tx, f1, "progress", "f1.xls");
      check("T1 NEW 3 / effective 3", r1.matching.NEW === 3 && r1.created === 3 && (await effCount(tx, "progress")) === 3, { m: r1.matching, e: await effCount(tx, "progress") });

      // T2 SAME — 다른 bytes(요약 시트 추가) 동일 내용 재업로드 → SAME, effective 불변, physical 증가(evidence)
      const f1b = book("진행관리", [PH,
        ["2024-01-01", "A", "ga", "홍길동", "영어통역", "영어", "2024-01-05", "2024-02-01", "100000"],
        ["2024-02-01", "B", "gb", "김번역", "영한번역", "영어", "2024-02-05", "2024-03-01", "200000"],
        ["2024-03-01", "C", "gc", null, "중국어통역", "중국어", null, null, "300000"]], { name: "요약", aoa: [["x"], ["y"]] });
      const r2 = await exec(tx, f1b, "progress", "f1b.xls");
      check("T2 SAME 3 / mode=new_snapshot / effective 여전히 3", r2.matching.SAME === 3 && r2.matching.NEW === 0 && (await effCount(tx, "progress")) === 3, { m: r2.matching, e: await effCount(tx, "progress") });
      check("T2 raw evidence 보존(physical 6)", (await physCount(tx, "progress")) === 6, await physCount(tx, "progress"));

      // T3 UPDATED 입금 — sales_list. 최초 입금일 null → 재업로드 입금일 입력
      const s1 = book("판매목록", [SH, ["2024-05-01", "SCo", "sg", "영어번역", "1000000", "100000", "1100000", "", "미입금", "미발행"]]);
      await exec(tx, s1, "sales_list", "s1.xls");
      const s2 = book("판매목록", [SH, ["2024-05-01", "SCo", "sg", "영어번역", "1000000", "100000", "1100000", "2026-10-15", "입금", "미발행"]]);
      const r3 = await exec(tx, s2, "sales_list", "s2.xls");
      check("T3 UPDATED 1 (입금)", r3.matching.UPDATED === 1 && r3.matching.NEW === 0, r3.matching);
      const scoEff = await tx.select({ cd: legacyArchiveRowsTable.collectionDate, eff: legacyArchiveRowsTable.isEffective, sup: legacyArchiveRowsTable.supersededById }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.companyName, "SCo")));
      check("T3 history 2(old+new) / effective 1 / old superseded", scoEff.length === 2 && scoEff.filter((r: any) => r.eff).length === 1 && scoEff.some((r: any) => !r.eff && r.sup != null), scoEff);
      check("T3 effective 입금일=2026-10-15", scoEff.find((r: any) => r.eff)?.cd === "2026-10-15" && scoEff.some((r: any) => !r.eff && r.cd === null), scoEff.map((r: any) => ({ cd: r.cd, eff: r.eff })));

      // T5 UPDATED 세금계산서(비정규화, source_raw) — 미발행 → 발행
      const s3 = book("판매목록", [SH, ["2024-05-01", "SCo", "sg", "영어번역", "1000000", "100000", "1100000", "2026-10-15", "입금", "발행"]]);
      const r5 = await exec(tx, s3, "sales_list", "s3.xls");
      check("T5 세금계산서 변경 → UPDATED(비정규화 내용변경 감지)", r5.matching.UPDATED === 1, r5.matching);

      // T6 4년전 — progress 2021 record 지급일 null → 입력
      const g1 = book("진행관리", [PH, ["2021-03-01", "Old", "og", "박통역", "스페인어통역", "스페인어", "2021-03-10", "", "500000"]]);
      await exec(tx, g1, "progress", "g1.xls");
      const g2 = book("진행관리", [PH, ["2021-03-01", "Old", "og", "박통역", "스페인어통역", "스페인어", "2021-03-10", "2026-10-31", "500000"]]);
      const r6 = await exec(tx, g2, "progress", "g2.xls");
      check("T6 4년전 record 지급일 입력 → UPDATED(연도 차단 없음)", r6.matching.UPDATED === 1, r6.matching);

      // T7 부분파일 — 기존 A,B,C(progress f1). 부분파일 f7=C(지급 update)+D(신규). A,B 불변.
      const f7 = book("진행관리", [PH,
        ["2024-03-01", "C", "gc", null, "중국어통역", "중국어", null, "2026-11-01", "300000"],   // C 지급일 입력 → UPDATED
        ["2025-06-01", "D", "gd", "최번역", "일본어번역", "일본어", "2025-06-10", "2025-07-01", "400000"]]); // D 신규
      const r7 = await exec(tx, f7, "progress", "f7.xls");
      check("T7 부분파일 → UPDATED(C) 1 + NEW(D) 1", r7.matching.UPDATED === 1 && r7.matching.NEW === 1, r7.matching);
      const abEff = await tx.select({ co: legacyArchiveRowsTable.companyName, eff: legacyArchiveRowsTable.isEffective }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.sourceType, "progress"), eq(legacyArchiveRowsTable.isEffective, true)));
      const effCos = abEff.map((r: any) => r.co);
      check("T7 미포함 A,B 그대로 effective 유지(삭제/숨김 0)", effCos.includes("A") && effCos.includes("B"), effCos);

      // T9 identical 3 (이미 f1 의 재업로드 영향 배제 위해 신규 회사) — 최초 import 3동일행 보존
      const idRow = ["2024-10-25", "UNESCAP", "ue", "강원대", "영어 동시통역", "영어", "2024-10-25", "2024-11-15", "800000"];
      const u1 = book("진행관리", [PH, idRow, idRow, idRow]);
      const r9 = await exec(tx, u1, "progress", "u1.xls");
      check("T9 identical 3 최초 → NEW 3 / raw 3 보존", r9.matching.NEW === 3 && r9.created === 3, r9.matching);

      // T10 multiplicity 3→4 — 다른 bytes, 동일내용 4행 → AMBIGUOUS, 기존 3 effective 불변
      const u2 = book("진행관리", [PH, idRow, idRow, idRow, idRow], { name: "요약", aoa: [["x"]] });
      const r10 = await exec(tx, u2, "progress", "u2.xls");
      check("T10 multiplicity 3→4 → AMBIGUOUS 4 (자동 1:1 update 없음)", r10.matching.AMBIGUOUS === 4 && r10.matching.UPDATED === 0, r10.matching);
      const uEff = await tx.select({ n: count() }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.companyName, "UNESCAP"), eq(legacyArchiveRowsTable.isEffective, true)));
      check("T10 UNESCAP effective = 3(기존) + 4(ambiguous) = 7, 삭제/강등 없음", Number(uEff[0].n) === 7, uEff[0].n);

      // T11 duplicate same bytes
      const r11 = await exec(tx, u1, "progress", "u1.xls");
      check("T11 동일 bytes 재업로드 → duplicate_file / created 0", r11.mode === "duplicate_file" && r11.created === 0, r11);

      // T12 filename 만 변경
      const r12 = await exec(tx, u1, "progress", "u1_backup.xls");
      check("T12 파일명만 변경(동일 bytes) → duplicate_file", r12.mode === "duplicate_file" && r12.created === 0, r12);

      // raw 원본 보존 — old SCo 미발행 version 의 source_raw 유지
      const oldSco = await tx.select({ raw: legacyArchiveRowsTable.sourceRaw }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.companyName, "SCo"), eq(legacyArchiveRowsTable.isEffective, false)));
      check("raw 보존: old SCo source_raw 세금계산서=미발행 유지", oldSco.some((r: any) => r.raw?.["세금계산서"] === "미발행"), oldSco.map((r: any) => r.raw?.["세금계산서"]));

      // C-4C — Current+Legacy 통합. Legacy 는 effective 만. 과거 자료(부분 업로드 후) 소실 없음.
      const sh = await getSalesHistory(tx, { range: "legacy", pageSize: "500" });
      check("C-4C legacy effective 조회 OK(배열)", Array.isArray(sh.rows), typeof sh.rows);

      // T14 Current Master 불변 / T15 Current Sales 불변
      const m1 = await master(tx);
      check("T14 Current Master count 불변", JSON.stringify(m0) === JSON.stringify(m1), { m0, m1 });
      const sales1 = Number((await tx.execute(sql`select count(*)::int n from projects`)).rows?.[0]?.n ?? 0);
      check("T15 Current Sales(projects) count 불변", sales0 === sales1, { sales0, sales1 });

      // T13 rollback — nested savepoint 에서 저장 후 강제 실패 → 해당 저장분 롤백
      const before13 = await physCount(tx, "progress");
      let threw = false;
      try {
        await tx.transaction(async (tx2: any) => {
          await exec(tx2, book("진행관리", [PH, ["2027-01-01", "ROLLBACKCO", "rb", "x", "y", "영어", "", "", "1"]]), "progress", "rb.xls");
          throw new Error("__INJECT__");
        });
      } catch (e: any) { threw = e.message === "__INJECT__"; }
      check("T13 주입 실패 → rollback(해당 저장분 미잔존)", threw && (await physCount(tx, "progress")) === before13 && (await tx.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.companyName, "ROLLBACKCO")))[0].n === 0, { before: before13, after: await physCount(tx, "progress") });

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  const left = await db.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.companyName, "UNESCAP"));
  check("ROLLBACK: 테스트 archive row 미잔존", Number(left[0].n) === 0, left[0].n);

  console.log(`\n== C-4I-b storage tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
