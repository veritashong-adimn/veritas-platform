// C-4A Legacy Archive 검증 — 합성 Excel fixture. 전부 transaction 내 수행 후 ROLLBACK(실데이터 무변경).
// §20 A~J: Master 미등록 저장 / Master count 불변 / source_raw 원본보존 / normalized 분리 /
//          중복 skip / 파일명만 변경한 동일자료 중복 / source_type 독립 / 날짜·금액 실패해도 저장 / mapping 없음.
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable, productsTable, companiesTable, contactsTable, usersTable, legacyMasterMappingsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { executeArchiveImport } from "./routes/legacyArchive";

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

// 판매목록 합성: R2 는 상품명 trailing space + 날짜/금액 파싱실패 유도.
const SALES_AOA: unknown[][] = [
  ["견적서발행일", "거래처명", "고객명", "상품명", "공급가액", "부가세", "총액", "입금일", "입금여부"],
  ["2021-03-15", "ABC제약(미등록)", "박담당", "영어-쿠르드어통역", "1000000", "100000", "1100000", "2021-04-01", "입금"],
  ["날짜아님",   "XYZ무역",        "김고객", "인디자인편집 ",      "공급가없음", "",      "2,200,000", "",          "미입금"],
  ["2021-05-20", "ABC제약(미등록)", "이고객", "한영번역",          "500000",  "50000", "550000",   "",          "입금완료"],
];

async function masterCounts(tx: any) {
  const c = async (t: any) => (await tx.select({ n: count() }).from(t))[0].n as number;
  return { products: await c(productsTable), companies: await c(companiesTable), contacts: await c(contactsTable), users: await c(usersTable), mappings: await c(legacyMasterMappingsTable) };
}

async function main() {
  try {
    await db.transaction(async (tx: any) => {
      const before = await masterCounts(tx);

      const salesBuf = buildBook("판매목록", SALES_AOA);
      // 1차 저장
      const r1 = await executeArchiveImport(tx, { buffer: salesBuf, sourceType: "sales_list", fileName: "crm.xlsx", performerId: null });
      check("A/§9 Master 미등록 문자열 3건 저장(created=3)", r1.created === 3, r1);

      const rows = await tx.select().from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.sourceType, "sales_list"));
      check("저장 row 수 = 3", rows.length === 3, rows.length);

      const r2 = rows.find((r: any) => (r.sourceRaw?.["상품명"] ?? "").toString().includes("인디자인편집"));
      check("C/§5 source_raw 상품명 trailing space 원문 보존", r2 && r2.sourceRaw["상품명"] === "인디자인편집 ", r2?.sourceRaw?.["상품명"]);
      check("D/§5 normalized product_name 은 trim(원문과 분리)", r2 && r2.productName === "인디자인편집", r2?.productName);
      check("H/§6 날짜 파싱 실패 → record_date null, 원문 보존, row 저장됨", r2 && r2.recordDate === null && r2.sourceRaw["견적서발행일"] === "날짜아님", { d: r2?.recordDate, raw: r2?.sourceRaw?.["견적서발행일"] });
      check("I/§6 금액 파싱 실패 → supply_amount null, 원문 보존", r2 && r2.supplyAmount === null && r2.sourceRaw["공급가액"] === "공급가없음", { a: r2?.supplyAmount, raw: r2?.sourceRaw?.["공급가액"] });
      check("I/§6 쉼표 금액 '2,200,000' → total_amount 2200000, 원문 보존", r2 && Number(r2.totalAmount) === 2200000 && r2.sourceRaw["총액"] === "2,200,000", { t: r2?.totalAmount, raw: r2?.sourceRaw?.["총액"] });

      const abc = rows.find((r: any) => r.companyName === "ABC제약(미등록)");
      check("normalized company_name 추출(ABC제약(미등록))", !!abc, abc?.companyName);
      check("collection_status 명시값 → paid(입금)", !!abc && abc.collectionStatus === "paid", abc?.collectionStatus);

      // B/J: Master count 불변
      const after = await masterCounts(tx);
      check("B/§9 Product/Company/Contact/User count 불변", before.products === after.products && before.companies === after.companies && before.contacts === after.contacts && before.users === after.users, { before, after });
      check("J Legacy master mapping 생성 없음", before.mappings === after.mappings, { before: before.mappings, after: after.mappings });

      // E: 동일 재실행 → 중복 skip
      const r3 = await executeArchiveImport(tx, { buffer: salesBuf, sourceType: "sales_list", fileName: "crm.xlsx", performerId: null });
      check("E/§10 동일 재실행 → created 0", r3.created === 0 && r3.skippedDuplicate === 3, r3);

      // F: 파일명만 변경 → 여전히 중복
      const r4 = await executeArchiveImport(tx, { buffer: salesBuf, sourceType: "sales_list", fileName: "crm-copy.xlsx", performerId: null });
      check("F/§10 파일명만 변경한 동일자료 → created 0(중복)", r4.created === 0, r4);

      // G: 동일 내용 but source_type=progress → 독립
      const progBuf = buildBook("판매목록", SALES_AOA);
      const r5 = await executeArchiveImport(tx, { buffer: progBuf, sourceType: "progress", fileName: "crm.xlsx", performerId: null });
      check("G/§10 동일 내용 + 다른 source_type(progress) → 독립 저장(created>0)", r5.created > 0, r5);
      const progCount = (await tx.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.sourceType, "progress")))[0].n;
      check("progress row 는 sales_list 와 분리 저장", Number(progCount) === r5.created, { progCount, created: r5.created });

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  // 롤백 확인: archive row 미잔존(이 테스트가 만든 것)
  const left = await db.select({ n: count() }).from(legacyArchiveRowsTable).where(and(eq(legacyArchiveRowsTable.sourceSystem, "old_crm"), eq(legacyArchiveRowsTable.sourceType, "sales_list")));
  check("ROLLBACK: 테스트 archive row 미잔존(sales_list)", Number(left[0].n) === 0, left[0].n);

  console.log(`\n== C-4A legacy-archive tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
