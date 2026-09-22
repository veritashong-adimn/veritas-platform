// 과거자료 일괄등록 Grouping/금액 regression test.
// 검증: ① 원본 거래처명 기준 grouping(Master resolution 무관) ② 동일 견적 금액 중복합산 없음(차액 0)
//       ③ 번역/통역 분리 ④ 수행비는 행별 합산. DB read만(loadMasters), INSERT 없음.
import * as XLSX from "xlsx";
import { analyzeWithGroupingDiff } from "./routes/pastWorkImport";

const H = ["거래처명","고객명","견적서발행일","견적서구분","체결일","상품명","공급가액","부가세","총액","통번역사명","언어","통번역사납품일","통번역사지급일","요금(100%)","교통비","지급액(세전)"];
// 미등록 합성 거래처(매칭 무관하게 grouping 검증). 회사명은 유니크 접미사로 실제 Master 충돌 회피.
const CO = "regtest통번역주식회사zz";
const rows: any[][] = [
  // 견적A(번역): 동일 거래처+금액 3행 → 1견적, 총액 1,100,000 "1회"만. 수행비 3행 각각.
  [CO,"고객1","2026-09-01","정식","2026-09-05","영한번역",1000000,100000,1100000,"김번역A","영어","2026-09-10","2026-09-15",300000,0,300000],
  [CO,"고객2","2026-09-02","수정","2026-09-05","한영번역",1000000,100000,1100000,"이번역A","영어","2026-09-11","2026-09-15",400000,20000,420000],
  [CO,"고객3","2026-09-02","정식","2026-09-06","일한번역",1000000,100000,1100000,"박번역A","일본어","2026-09-12","2026-09-03",350000,0,350000],
  // 견적B(번역): 동일 거래처, 다른 금액 → 별개 견적.
  [CO,"고객1","2026-09-01","정식","2026-09-05","감수",500000,50000,550000,"김번역A","영어","2026-09-10","2026-09-15",200000,0,200000],
  // 견적C(통역): 통역 상품 2행 → 통역 견적 1건.
  [CO+"통역","고객9","2026-09-03","정식","2026-09-06","통역",2000000,0,2000000,"최통역A","중국어","2026-09-14","2026-09-15",800000,50000,850000],
  [CO+"통역","고객9","2026-09-03","정식","2026-09-06","통역",2000000,0,2000000,"정통역A","중국어","2026-09-14","2026-09-15",700000,0,700000],
];
const ws = XLSX.utils.aoa_to_sheet([H, ...rows]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

let failed = 0;
const check = (name: string, actual: any, expected: any) => {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${actual}${ok ? "" : ` (기대 ${expected})`}`);
  if (!ok) failed++;
};

async function main() {
  const rep = await analyzeWithGroupingDiff(buf);
  const s = rep.summary;
  // 우리 합성 거래처(CO*) 그룹만 필터(다른 마스터 오염 방지).
  const mine = rep.allGroups.filter(g => (g.rawCompanyNames[0] || "").startsWith("regtest"));
  const coA = mine.filter(g => g.rawCompanyNames[0] === CO);
  const coC = mine.filter(g => g.rawCompanyNames[0] === CO + "통역");

  check("원본 6행", s.rawRows >= 6, true);
  check("CO(번역) 그룹 수 = 2 (금액 1,100,000 / 550,000)", coA.length, 2);
  check("CO통역 그룹 수 = 1", coC.length, 1);
  const gA = coA.find(g => g.total === 1100000);
  check("견적A 총액 1,100,000 1회(중복합산 없음)", gA?.total, 1100000);
  check("견적A 수행행 3개 보존", gA?.rowCount, 3);
  check("견적A 견적금액 차액 0", rep.perQuote.find(q => q.total === 1100000 && q.rawCompany === CO)?.totalDiff, 0);
  // 견적A 세전(원본) = 300k+420k+350k = 1,070,000 (행별 합산)
  check("견적A 세전(원본) 1,070,000", rep.perQuote.find(q => q.total === 1100000 && q.rawCompany === CO)?.preTaxOriginal, 1070000);
  // 9/15 대상: 견적A 중 지급일 9/15 인 2행(300k,420k) + 견적B 1행(200k) + 통역 2행(850k+700k... 원본세전 800k,700k? 컬럼은 지급액세전)
  // 지급일 09-03 인 견적A 3번째 행(350k)은 9/15 제외 확인
  check("9/15 아닌 행 존재(≥1)", (s.nonPay0915Rows ?? 0) >= 1, true);

  console.log(failed === 0 ? "\n✅ 모든 regression 통과" : `\n❌ ${failed}건 실패`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
