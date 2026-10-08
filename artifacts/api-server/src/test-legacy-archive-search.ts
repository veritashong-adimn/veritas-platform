// C-4B Legacy Archive 검색/상세 검증 — 합성 fixture. 전부 transaction 내 수행 후 ROLLBACK(실데이터 무변경).
// §27 A~P: source_type 검색 / keyword 부분검색 / translator·product 검색 / date range /
//          collectionStatus(null≠unpaid) / pagination / deterministic sort / detail / source_raw /
//          Master 미등록 조회 / malformed·null / 없는 id / sort·page validation.
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { executeArchiveImport, searchArchive, getArchiveRow } from "./routes/legacyArchive";

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

const SALES_AOA: unknown[][] = [
  ["견적서발행일", "거래처명", "고객명", "상품명", "공급가액", "부가세", "총액", "입금일", "입금여부"],
  ["2021-03-15", "삼성전자(미등록)", "박담당", "영어순차통역", "1000000", "100000", "1100000", "2021-04-01", "입금"],
  ["2021-06-20", "엘지화학",        "최담당", "영한번역",     "500000",  "50000",  "550000",  "",          "미입금"],
  ["날짜아님",   "삼성바이오",      "김고객", "인디자인편집 ", "공급가없음", "",      "2,200,000", "",         ""],  // malformed + 입금여부 공란 → collection_status null
];
const PROGRESS_AOA: unknown[][] = [
  ["견적서발행일", "거래처명", "통번역사명", "상품명", "언어", "통번역사납품일", "통번역사지급일", "지급액(세전)"],
  ["2021-03-15", "삼성전자(미등록)", "김통역", "영어순차통역", "영어", "2021-03-20", "2021-04-15", "800000"],
  ["2021-07-01", "현대모비스",      "이번역", "영한번역",     "영한", "2021-07-10", "2021-08-15", "400000"],
];

async function main() {
  try {
    await db.transaction(async (tx: any) => {
      await executeArchiveImport(tx, { buffer: buildBook("판매목록", SALES_AOA), sourceType: "sales_list", fileName: "sales.xlsx", performerId: null });
      await executeArchiveImport(tx, { buffer: buildBook("진행관리", PROGRESS_AOA), sourceType: "progress", fileName: "prog.xlsx", performerId: null });

      // A/F: source_type filter
      const sales = await searchArchive(tx, { sourceType: "sales_list", pageSize: 100 });
      check("A/F sales_list 검색 = 3건", sales.pagination.total === 3, sales.pagination.total);
      const prog = await searchArchive(tx, { sourceType: "progress", pageSize: 100 });
      check("B/F progress 검색 = 2건", prog.pagination.total === 2, prog.pagination.total);
      const all = await searchArchive(tx, { sourceType: "all", pageSize: 100 });
      check("all = 5건", all.pagination.total === 5, all.pagination.total);

      // C: company keyword 부분검색(통합 q)
      const q삼성 = await searchArchive(tx, { q: "삼성", pageSize: 100 });
      check("C q='삼성' 부분검색 → 3건(전자/바이오 sales 2 + progress 1)", q삼성.pagination.total === 3, q삼성.pagination.total);

      // D: translator 검색
      const t = await searchArchive(tx, { translator: "김통역", pageSize: 100 });
      check("D translator='김통역' → 1건", t.pagination.total === 1, t.pagination.total);

      // E: product 검색
      const p = await searchArchive(tx, { product: "영어순차통역", pageSize: 100 });
      check("E product='영어순차통역' → 2건(sales+progress)", p.pagination.total === 2, p.pagination.total);

      // G: date range (record_date). null 날짜 row(삼성바이오) 는 범위필터시 제외.
      const dr = await searchArchive(tx, { dateFrom: "2021-06-01", dateTo: "2021-12-31", pageSize: 100 });
      check("G date range 2021-06~12 → 엘지화학·현대모비스 2건(null날짜 제외)", dr.pagination.total === 2, dr.rows.map((r: any) => r.companyName));

      // H: collectionStatus — null 을 unpaid 로 오판하지 않음
      const paid = await searchArchive(tx, { collectionStatus: "paid", pageSize: 100 });
      check("H collectionStatus=paid → 1건(삼성전자)", paid.pagination.total === 1, paid.rows.map((r: any) => r.companyName));
      const unpaid = await searchArchive(tx, { collectionStatus: "unpaid", pageSize: 100 });
      check("H collectionStatus=unpaid → 1건(엘지화학)만. null(삼성바이오) 제외", unpaid.pagination.total === 1 && unpaid.rows[0]?.companyName === "엘지화학", unpaid.rows.map((r: any) => r.companyName));

      // I: pagination
      const pg1 = await searchArchive(tx, { sourceType: "all", page: 1, pageSize: 2 });
      check("I pagination pageSize=2 → rows 2, totalPages 3, total 5", pg1.rows.length === 2 && pg1.pagination.totalPages === 3 && pg1.pagination.total === 5, pg1.pagination);
      const pg3 = await searchArchive(tx, { sourceType: "all", page: 3, pageSize: 2 });
      check("I pagination page=3 → rows 1", pg3.rows.length === 1, pg3.rows.length);

      // J: deterministic sort — record_date DESC NULLS LAST, 2차 id DESC
      const sorted = await searchArchive(tx, { sourceType: "sales_list", pageSize: 100 });
      const dates = sorted.rows.map((r: any) => r.recordDate);
      check("J 정렬: 날짜 내림차순 + null 마지막", dates[0] === "2021-06-20" && dates[1] === "2021-03-15" && dates[2] === null, dates);

      // P: sort whitelist 외 값 → 기본 정렬(크래시 없음)
      const badSort = await searchArchive(tx, { sourceType: "sales_list", sort: "source_raw:desc; DROP TABLE", pageSize: 100 });
      check("P 허용외 sort → 무시하고 기본정렬(3건 정상)", badSort.pagination.total === 3, badSort.pagination.total);
      const pClamp = await searchArchive(tx, { sourceType: "all", page: 0 as any, pageSize: 99999 as any });
      check("P page/pageSize bound 보정(page>=1, pageSize<=200)", pClamp.pagination.page === 1 && pClamp.pagination.pageSize <= 200, pClamp.pagination);

      // K/L/M: detail + source_raw + Master 미등록
      const one = sales.rows.find((r: any) => r.companyName === "삼성전자(미등록)");
      const detail = await getArchiveRow(tx, one.id);
      check("K detail 조회 성공", !!detail && detail.id === one.id, detail?.id);
      check("L detail.source_raw 전체 반환(원본 header 보존)", !!detail?.sourceRaw && detail.sourceRaw["거래처명"] === "삼성전자(미등록)", detail?.sourceRaw);
      check("M Current Master 미등록 문자열도 조회 가능", detail?.companyName === "삼성전자(미등록)", detail?.companyName);

      // N: malformed/null normalized — 삼성바이오 row 안전 조회(날짜·금액 null, source_raw 원문)
      const bio = sales.rows.find((r: any) => r.companyName === "삼성바이오");
      const bioDetail = await getArchiveRow(tx, bio.id);
      check("N null normalized(날짜/공급가 null) 안전 조회", bioDetail && bioDetail.recordDate === null && bioDetail.supplyAmount === null, { d: bioDetail?.recordDate, s: bioDetail?.supplyAmount });
      check("N source_raw 원문 보존(trailing space, '공급가없음')", bioDetail?.sourceRaw["상품명"] === "인디자인편집 " && bioDetail?.sourceRaw["공급가액"] === "공급가없음", bioDetail?.sourceRaw?.["상품명"]);
      check("N collection_status null(입금여부 공란 → null, unpaid 아님)", bioDetail?.collectionStatus === null, bioDetail?.collectionStatus);

      // O: 없는 id
      const none = await getArchiveRow(tx, 999999999);
      check("O 없는 id → null(404 대응)", none === null, none);

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  const left = await db.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.sourceSystem, "old_crm"));
  check("ROLLBACK: 테스트 archive row 미잔존", Number(left[0].n) === 0, left[0].n);

  console.log(`\n== C-4B legacy-archive search tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
