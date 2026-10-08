// C-4H-2 Excel Identity 진단(analyzeExcelIdentity) — 순수함수 테스트(DB 미접근).
//   A unique ID / B null 포함 ID / C duplicate ID / D 판매ID+수행순번 composite unique /
//   E content 동일·ID 다름 / F content 동일·ID 동일 / G mutable 분리 / H 1:N / I payload에 raw rows 없음.
import * as XLSX from "xlsx";
import { buildArchivePreview, analyzeExcelIdentity } from "./services/legacyArchiveResolve";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}
function sheets(aoa: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "진행관리");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buildArchivePreview(buf, "progress");
}
const cand = (r: any, h: string) => r.candidateColumns.find((c: any) => c.originalHeader === h);

// 헤더: 수행번호(per-row unique), 판매번호(1:N), 수행순번(배정), 통번역사명(mutable), 지급액(세전)(mutable) + content 컬럼
const H = ["견적서발행일", "거래처명", "통번역사명", "상품명", "언어", "통번역사납품일", "지급액(세전)", "판매번호", "수행순번", "수행번호"];
// UNESCAP 3행: content(앞 7컬럼) 완전 동일, 판매번호 동일, 수행순번·수행번호는 다름(서로 다른 실제 수행건)
function unescap(seq: number, perf: number): unknown[] {
  return ["2024-10-25", "UNESCAP", "강원대", "영어 동시통역", "영어", "2024-10-25", "800000", "S1001", seq, perf];
}
function main() {
  // 기본 데이터셋: UNESCAP 3행(content 동일, ID 다름) + 일반 2행
  const base = [H,
    unescap(1, 9001), unescap(2, 9002), unescap(3, 9003),
    ["2024-09-01", "세화", "이대우", "영어통역", "영어", "2024-09-02", "500000", "S1002", 1, 9004],
    ["2024-11-01", "한독", "김명화", "러시아어", "러시아어", "2024-11-02", "700000", "S1002", 2, 9005],
  ];
  const a = analyzeExcelIdentity(sheets(base));
  check("analyzed=true / totalRows=5 / totalColumns=10", a.analyzed && a.totalRows === 5 && a.totalColumns === 10, { r: a.totalRows, c: a.totalColumns });

  // A. 수행번호 완전 unique
  const perf = cand(a, "수행번호");
  check("A. 수행번호 ID 후보 인식 + UNIQUE", !!perf && perf.classification === "UNIQUE", perf?.classification);
  check("A. 수행번호 uniquenessRatio=1 / distinct=5", perf.uniquenessRatio === 1 && perf.distinctCount === 5, perf);

  // C. 판매번호 duplicate(NON_UNIQUE) — S1001 x3, S1002 x2
  const sale = cand(a, "판매번호");
  check("C. 판매번호 NON_UNIQUE(중복 존재)", sale && sale.classification === "NON_UNIQUE" && sale.duplicateValueCount > 0, sale);

  // G. mutable 분리 — 통번역사명/지급액(세전) mutableColumns 에 포함, ID 후보 아님
  check("G. mutableColumns 에 통번역사명·지급액(세전)", a.mutableColumns.includes("통번역사명") && a.mutableColumns.includes("지급액(세전)"), a.mutableColumns);
  check("G. 통번역사명은 ID 후보 아님", !cand(a, "통번역사명"));

  // E/F + 153류: content 동일 그룹 = UNESCAP 3행. ID(수행번호) 다름 → DIFFERENT
  check("E. identicalGroups=1 / identicalRows=3", a.identicalRowAnalysis.identicalGroups === 1 && a.identicalRowAnalysis.identicalRows === 3, a.identicalRowAnalysis);
  check("E. ID로 구분가능(distinguishable) 3행", a.identicalRowAnalysis.distinguishableByIdRows === 3, a.identicalRowAnalysis);
  check("E. 대표 sample classification=ID_DIFFERENT", a.representativeSamples[0]?.classification === "CONTENT_IDENTICAL_ID_DIFFERENT", a.representativeSamples[0]);
  check("E. sample 멤버 sourceRow 3개 + idValues 포함", a.representativeSamples[0]?.members.length === 3 && "수행번호" in (a.representativeSamples[0]?.members[0]?.idValues ?? {}), a.representativeSamples[0]?.members);

  // D. composite — 판매번호 + 수행순번 이 unique (각 판매 내 수행순번 유일)
  const comp = a.compositeCandidates.find(c => c.columns.includes("판매번호") && c.columns.includes("수행순번"));
  check("D. composite(판매번호+수행순번) UNIQUE", !!comp && comp.classification === "UNIQUE", comp);

  // H. 1:N 관계 — 판매번호 기준 S1001=3행/수행 3, S1002=2행
  check("H. relation available / saleColumn=판매번호", a.relationAnalysis.available && a.relationAnalysis.saleColumn === "판매번호", a.relationAnalysis);
  check("H. maxRowsPerSale=3 / multiRowSales=2", a.relationAnalysis.maxRowsPerSale === 3 && a.relationAnalysis.multiRowSales === 2, a.relationAnalysis);
  const s1001 = a.relationAnalysis.samples?.find(s => s.saleId === "S1001");
  check("H. S1001 rowCount=3 / assignmentCount=3", s1001?.rowCount === 3 && s1001?.assignmentCount === 3, s1001);

  // 결론 — 단일 수행번호 UNIQUE → stableRowIdFound
  check("결론 stableRowIdFound=true / high", a.conclusion.stableRowIdFound === true && a.conclusion.confidence === "high", a.conclusion);

  // B. null 포함 ID → MOSTLY_NULL/NEAR... 판정 (수행번호 일부 null)
  const withNull = [H,
    unescap(1, 9001), ["2024-10-25", "UNESCAP", "강원대", "영어 동시통역", "영어", "2024-10-25", "800000", "S1001", 2, null],
    ["2024-09-01", "세화", "이대우", "영어통역", "영어", "2024-09-02", "500000", "S1002", 1, null],
  ];
  const b = analyzeExcelIdentity(sheets(withNull));
  const perfB = cand(b, "수행번호");
  check("B. null 포함 → 수행번호 nullCount>0 / classification != UNIQUE", perfB.nullCount > 0 && perfB.classification !== "UNIQUE", perfB);

  // F. content 동일 + ID 동일 → SAME. ID 컬럼이 파일 전체에선 usable(다양)하되, 동일쌍 내에서는 같게 구성.
  const row = (co: string, seq: number, perf: number): unknown[] => ["2024-09-01", co, "이대우", "영어통역", "영어", "2024-09-02", "500000", "S9", seq, perf];
  const sameId = [H, row("A", 1, 9001), row("B", 2, 9002), row("C", 3, 9003), row("C", 3, 9003)];  // C 2행 완전 동일(ID 포함)
  const f = analyzeExcelIdentity(sheets(sameId));
  check("F. content 동일+ID 동일 → sameIdGroups=1 / distinguishable=0", f.identicalRowAnalysis.sameIdGroups === 1 && f.identicalRowAnalysis.distinguishableByIdGroups === 0, f.identicalRowAnalysis);
  check("F. fullRowIdentical 참고치=2행/1그룹", f.identicalRowAnalysis.fullRowIdenticalRows === 2 && f.identicalRowAnalysis.fullRowIdenticalGroups === 1, f.identicalRowAnalysis);

  // ID 없음 케이스 → missing + stableRowIdFound=false
  const noId = [["견적서발행일", "거래처명", "상품명"], ["2024-01-01", "A", "번역"], ["2024-01-01", "A", "번역"]];
  const n = analyzeExcelIdentity(sheets(noId));
  check("ID 없음 → candidateColumns=0 / stableRowIdFound=false", n.candidateColumns.length === 0 && n.conclusion.stableRowIdFound === false, n.conclusion);
  check("ID 없음 → identical 그룹 MISSING", n.identicalRowAnalysis.missingIdGroups === 1 && n.identicalRowAnalysis.idColumnUsed === null, n.identicalRowAnalysis);

  // I. payload 에 raw rows 미포함 — 응답 JSON 어디에도 rawRow/전체행 배열이 없어야 함
  const json = JSON.stringify(a);
  check("I. 응답에 rawRow 키 없음", !json.includes("rawRow"));
  // representativeSamples 멤버는 sourceRow+idValues 만(원본 전체 행 아님). 전체 행수(5)보다 큰 행 배열 없음.
  check("I. headers 통계만(값 배열 아님) / sampleValues ≤10", a.headers.every((h: any) => !Array.isArray((h as any).values)) && cand(a, "수행번호").sampleValues.length <= 10);

  console.log(`\n== C-4H identity-diagnostic tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
