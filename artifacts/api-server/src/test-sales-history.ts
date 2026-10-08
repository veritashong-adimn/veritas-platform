// C-4C sales-history 통합조회 검증 — 합성 fixture. transaction 내 수행 후 ROLLBACK(실데이터 무변경).
// §26 A~T 중 서버로직 검증 가능 항목: range / 통합검색 / progress 제외 / 정렬 / pagination / total /
//   key 충돌없음 / workflow null / workflow filter→current / current-only filter→current /
//   failure isolation / collectionStatus null≠unpaid / projects contract 불변.
import * as XLSX from "xlsx";
import { db, legacyArchiveRowsTable } from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { executeArchiveImport } from "./routes/legacyArchive";
import { getSalesHistory } from "./routes/salesHistory";
import { buildFilteredSalesProjectList } from "./routes/admin";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
function buildBook(sheet: string, aoa: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const SALES_AOA: unknown[][] = [
  ["견적서발행일", "거래처명", "고객명", "상품명", "공급가액", "부가세", "총액", "입금일", "입금여부"],
  ["2019-03-15", "삼성전자(과거)", "박담당", "영어순차통역", "1000000", "100000", "1100000", "2019-04-01", "입금"],
  ["2020-06-20", "엘지화학(과거)", "최담당", "영한번역",     "500000",  "50000",  "550000",  "",          ""],  // 입금여부 공란 → collection_status null
];
const PROGRESS_AOA: unknown[][] = [
  ["견적서발행일", "거래처명", "통번역사명", "상품명", "언어", "통번역사납품일", "통번역사지급일", "지급액(세전)"],
  ["2019-03-15", "삼성전자(과거)", "김통역", "영어순차통역", "영어", "2019-03-20", "2019-04-15", "800000"],
];

async function main() {
  try {
    await db.transaction(async (tx: any) => {
      await executeArchiveImport(tx, { buffer: buildBook("판매목록", SALES_AOA), sourceType: "sales_list", fileName: "s.xlsx", performerId: null });
      await executeArchiveImport(tx, { buffer: buildBook("진행관리", PROGRESS_AOA), sourceType: "progress", fileName: "p.xlsx", performerId: null });

      // 현재 Current 판매 건수(baseline) — getSalesHistory 내부에서 db(실연결) 사용하므로 current count 는 실DB 기준.
      // 테스트는 Legacy 통합/정렬/필터 로직 중심으로 검증(Current 는 실데이터, tx 밖 조회).
      // B: range=legacy → Legacy sales_list 만(progress 제외)
      const legacy = await getSalesHistory(tx, { range: "legacy", pageSize: "100" });
      check("B/E range=legacy → sales_list 2건(progress 제외)", legacy.pagination.total === 2 && legacy.rows.every(r => r.source === "legacy"), { total: legacy.pagination.total });
      check("E progress 는 통합목록에 미포함", legacy.rows.every(r => r.productName !== null ? true : true) && legacy.rows.length === 2, legacy.rows.length);

      // D: 통합검색(legacy 범위) — '삼성' → 1건(삼성전자 sales). progress 삼성은 제외.
      const q = await getSalesHistory(tx, { range: "legacy", search: "삼성", pageSize: "100" });
      check("D 통합검색 '삼성'(legacy) → 1건", q.pagination.total === 1 && q.rows[0]?.companyName === "삼성전자(과거)", q.rows.map(r => r.companyName));

      // F: 정렬 — recordDate DESC
      check("F 정렬 recordDate DESC(2020 먼저)", legacy.rows[0]?.recordDate === "2020-06-20" && legacy.rows[1]?.recordDate === "2019-03-15", legacy.rows.map(r => r.recordDate));

      // I: key prefix 충돌 없음(legacy:)
      check("I key prefix legacy:", legacy.rows.every(r => r.key.startsWith("legacy:")), legacy.rows.map(r => r.key));

      // J: legacy workflowStatus null
      check("J legacy workflowStatus null", legacy.rows.every(r => r.workflowStatus === null), legacy.rows.map(r => r.workflowStatus));

      // S: collectionStatus null ≠ unpaid
      const lg = await getSalesHistory(tx, { range: "legacy", pageSize: "100" });
      const lgChem = lg.rows.find(r => r.companyName === "엘지화학(과거)");
      check("S 엘지화학 collectionStatus null(입금여부 공란)", lgChem?.collectionStatus === null, lgChem?.collectionStatus);
      const samsung = lg.rows.find(r => r.companyName === "삼성전자(과거)");
      check("S 삼성전자 collectionStatus paid", samsung?.collectionStatus === "paid", samsung?.collectionStatus);

      // G/H: pagination + total(legacy)
      const pg = await getSalesHistory(tx, { range: "legacy", page: "1", pageSize: "1" });
      check("G/H pagination pageSize=1 → rows 1, totalPages 2, total 2", pg.rows.length === 1 && pg.pagination.totalPages === 2 && pg.pagination.total === 2, pg.pagination);
      const pg2 = await getSalesHistory(tx, { range: "legacy", page: "2", pageSize: "1" });
      check("G page2 다른 row(누락/중복 없음)", pg2.rows[0]?.key !== pg.rows[0]?.key, { p1: pg.rows[0]?.key, p2: pg2.rows[0]?.key });

      // K: workflow(status) filter → forcedCurrentOnly, effRange=current
      const wf = await getSalesHistory(tx, { range: "all", status: "in_progress", pageSize: "100" });
      check("K workflow filter(status) → forcedCurrentOnly + range=current", wf.forcedCurrentOnly === true && wf.range === "current", { f: wf.forcedCurrentOnly, r: wf.range });
      check("K current 범위 → legacy row 미포함", wf.rows.every(r => r.source === "current"), wf.rows.filter(r => r.source === "legacy").length);

      // L: current-only filter(financialStatus) → current only
      const fin = await getSalesHistory(tx, { range: "all", financialStatus: "paid", pageSize: "100" });
      check("L current-only filter(financialStatus) → forcedCurrentOnly", fin.forcedCurrentOnly === true && fin.range === "current", { f: fin.forcedCurrentOnly, r: fin.range });

      // all 범위 — current + legacy 함께(총계 = current 성공 + legacy 2)
      const all = await getSalesHistory(tx, { range: "all", pageSize: "200" });
      check("A range=all → current + legacy 통합(legacy 2건 포함)", all.sources.legacy.ok && (all.sources.legacy.count ?? 0) === 2 && all.sources.current.ok, all.sources);
      check("A degraded=false(정상)", all.degraded === false, { degraded: all.degraded, truncated: all.sources.legacy.truncated });

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  // P: Legacy 쿼리 실패 격리 — 잘못된 범위에서도 current 는 반환되는지(실DB, 비파괴 read)
  const degradedTest = await getSalesHistory({
    // legacy 쿼리를 강제로 실패시키는 가짜 dbx: select 가 throw. current 는 내부적으로 실제 db 사용(buildFiltered...)이므로 성공.
    select: () => { throw new Error("forced legacy failure"); },
  } as any, { range: "all", pageSize: "50" });
  check("P Legacy 실패 시 current 부분결과 + degraded", degradedTest.sources.legacy.ok === false && degradedTest.degraded === true && degradedTest.sources.current.ok === true, degradedTest.sources);

  // T: 기존 /admin/projects 계약 불변 — buildFilteredSalesProjectList 는 bare array 반환
  const projList = await buildFilteredSalesProjectList({});
  check("T buildFilteredSalesProjectList → 배열(계약 불변)", Array.isArray(projList), typeof projList);

  // rollback 확인
  const left = await db.select({ n: count() }).from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.sourceSystem, "old_crm"));
  check("ROLLBACK: 테스트 archive row 미잔존", Number(left[0].n) === 0, left[0].n);

  console.log(`\n== C-4C sales-history tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
