// 과거자료 일괄등록 — 실제 파일 analyze/Preview 검증 리포트 (DB 미변경, INSERT/UPDATE 없음)
// 사용: node dist/analyze-pastwork-report.mjs "<xlsx 경로>"
// 항목: ① 29개 그룹 전체 진단  ② Grouping Before/After  ③ 거래처/담당자/통번역사 매칭(alias·관계 포함)
//       ④ 74개 수행행 지급 대사  ⑤ 대표 케이스(롯데백화점/리치몬트-반클리프)  ⑥ item9 요약 15항목
import fs from "node:fs";
import { analyzeWithGroupingDiff, debugResolveCompanies } from "./routes/pastWorkImport";

const won = (n: number | null | undefined) => (Number(n ?? 0)).toLocaleString("ko-KR");
const pad = (s: any, n: number) => String(s ?? "").padEnd(n);
const padL = (s: any, n: number) => String(s ?? "").padStart(n);
const list = (xs: string[], n = 6) => xs.slice(0, n).join(", ") + (xs.length > n ? ` …(+${xs.length - n})` : "");

async function main() {
  const path = process.argv[2];
  if (!path) { console.error('사용법: node dist/analyze-pastwork-report.mjs "<xlsx 경로>"'); process.exit(2); }
  if (!fs.existsSync(path)) { console.error("파일을 찾을 수 없습니다:", path); process.exit(2); }
  const buf = fs.readFileSync(path);
  const rep = await analyzeWithGroupingDiff(buf);
  const s = rep.summary;

  console.log("\n════════ 과거자료 일괄등록 — 실제 파일 검증 리포트 (등록 없음, DB 미변경) ════════");
  console.log("파일:", path);

  // ── item 14 요약 (번역/통역 분리 · 9/15 분리) ──
  console.log("\n── [요약] (번역+통역 전체 · 목표숫자 강제 없음) ────────────");
  console.log("[원본] 전체 수행행:", s.rawRows, "| 번역:", s.rawRowsTranslation, "| 통역:", s.rawRowsInterpretation, "| 장비:", s.rawRowsEquipment);
  console.log("[견적] 전체:", s.quotesTotal, "| 번역:", s.quotesTranslation, "| 통역:", s.quotesInterpretation, "| 혼합:", s.quotesMixed, "| 장비:", s.quotesEquipment);
  console.log("[등록] 등록가능(신규):", s.quotesNew, "| 확인필요:", s.quotesNeedsReview, "| 오류:", s.quotesError, "| 기존/중복:", (s.quotesIdentical + s.quotesDuplicate));
  console.log("[수행배정] 전체:", s.assignmentCount, "| 번역:", s.assignmentsTranslation, "| 통역:", s.assignmentsInterpretation, "| 장비:", s.assignmentsEquipment);
  console.log("[Master] 거래처 exact:", s.companyExact, "| Alias:", s.companyAlias, "| 본점/브랜드:", s.companyRelation, "| normalized:", s.companyNormalized, "| 미매칭:", s.companyUnmatched);
  console.log("        담당자 미매칭:", s.contactUnmatched, "| 통번역사 미매칭:", s.translatorUnmatched);
  console.log("[견적금액] 원본:", won(s.quoteTotalOriginal), "| 시스템:", won(s.quoteTotalSystem), "| 차액:", won(s.quoteTotalDiff));
  console.log("[전체 세전(장비제외)] 원본:", won(s.preTaxOriginal), "| 시스템:", won(s.preTaxSystem), "| 차액:", won(s.preTaxDiff));
  console.log("[9/15 지급대상만] 행수:", (s as any).pay0915Rows, "| 원본:", won((s as any).pay0915PreTaxOriginal), "| 시스템:", won((s as any).pay0915PreTaxSystem), "| 차액:", won((s as any).pay0915PreTaxDiff), "| 9/15아님:", (s as any).nonPay0915Rows, "행");

  // ── ① 29개 그룹 전체 진단 ──
  console.log("\n── [①] 신규 그룹 전체 진단 (" + rep.allGroups.length + "개) ──────────────────");
  for (const g of rep.allGroups) {
    console.log(`\n#${g.groupNo} [${g.companyMatchMethod}] canonical=${g.canonicalCompanyName || "(미매칭)"}${g.canonicalCompanyId != null ? `(#${g.canonicalCompanyId})` : ""}`);
    console.log(`   원본거래처명: ${list(g.rawCompanyNames)}`);
    console.log(`   공급가 ${won(g.supply)} · 부가세 ${won(g.vat)} · 총액 ${won(g.total)} · 행수 ${g.rowCount} · Excel행 [${list(g.rowNumbers.map(String), 12)}]`);
    console.log(`   고객: ${list(g.customers)} | 견적일: ${list(g.quoteDates)} | 체결일: ${list(g.contractDates)}`);
    console.log(`   상품: ${list(g.products)} | 수행자: ${list(g.translators, 10)}`);
  }

  // ── 동일 거래처 다중 그룹 / 잔여 분리 ──
  console.log("\n── [①-b] 동일 canonical 회사에서 2+ 그룹으로 분리된 사례 ──");
  if (rep.sameCompanyMultiGroups.length === 0) console.log("   없음");
  for (const c of rep.sameCompanyMultiGroups) {
    console.log(`   ${c.company}: ${c.groupCount}개 그룹 → ${c.groups.map(g => `#${g.groupNo}(총액 ${won(g.total)},행 ${g.rows})`).join(" / ")}`);
    console.log(`     ↑ 금액 조합이 서로 다르면 실제 별개 견적(정상). 동일하면 확인필요.`);
  }
  console.log("\n── [①-c] 원본거래처명+금액 동일한데 서로 다른 그룹으로 남은 잔여 분리 ──");
  console.log(rep.residualSplits.length === 0 ? "   없음 (정규화/매칭 차이로 인한 잔여 분리 없음)" : JSON.stringify(rep.residualSplits, null, 2));

  // ── ② Before / After (합쳐진 견적) ──
  console.log("\n── [②] Before/After : 구 Grouping 에서 분리됐다가 합쳐진 견적 ──");
  console.log(`합쳐진 견적: ${rep.merged.length}건 (구 ${rep.oldGroupCount} → 신 ${rep.newGroupCount})`);
  rep.merged.forEach((m: any, i: number) => {
    console.log(`\n[${i + 1}] ${m.company}  공급가 ${won(m.supply)} · 부가세 ${won(m.vat)} · 총액 ${won(m.total)}  (수행행 ${m.rowCount}, 구 ${m.oldGroupCount} → 신 1)`);
    console.log(`    원본거래처표기: ${list(m.rawCompanies)}`);
    m.oldGroups.forEach((o: any, j: number) => console.log(`    Before #${j + 1}: 거래처='${o.rawCompany}' 고객='${o.customerName || "-"}' 견적일='${o.quoteIssueDate || "-"}' 구분='${o.quoteKind || "-"}' 체결일='${o.contractDate || "-"}' 상품='${(o.productName || "-").slice(0, 20)}' (행 ${o.rows})`));
  });

  // ── ③ 견적별 상세 ──
  console.log("\n── [③] 견적별 상세 ──────────────────────────────────────");
  console.log(pad("상태", 11), pad("매칭", 10), pad("거래처", 20), padL("행", 3), padL("공급가", 13), padL("부가세", 11), padL("총액", 13), padL("차액", 6), padL("세전(원)", 12), padL("세전(시)", 12));
  for (const q of rep.perQuote) {
    console.log(pad(q.status, 11), pad(q.method, 10), pad((q.company || "-").slice(0, 18), 20), padL(q.sourceRows, 3), padL(won(q.supply), 13), padL(won(q.vat), 11), padL(won(q.total), 13), padL(won(q.totalDiff), 6), padL(won(q.preTaxOriginal), 12), padL(won(q.preTaxSystem), 12));
  }

  // ── ④ 74개 수행행 지급 대사 ──
  console.log("\n── [④] 수행행 지급 대사 (" + rep.assignments.length + "행) ── 시스템 세전=요금/요율·수량·추가비용 기반 ──");
  console.log(pad("행", 4), pad("거래처", 14), pad("수행자", 10), pad("매칭", 5), pad("지급일", 11), padL("요금100", 10), padL("요율85", 9), padL("교통", 7), padL("출장", 7), padL("이동", 7), padL("저작", 7), padL("취소", 7), padL("세전(원)", 11), padL("세전(시)", 11), padL("차액", 10), " 사유");
  let sysSum = 0, origSum = 0;
  for (const a of rep.assignments as any[]) {
    sysSum += a.computedPreTax; origSum += a.originalPreTax ?? 0;
    console.log(pad(a.rowNumber, 4), pad((a.companyName || "-").slice(0, 12), 14), pad((a.translatorName || "-").slice(0, 9), 10), pad(a.matchedTranslatorId ? "O" : "X", 5), pad(a.payDate || "-", 11), padL(won(a.fee100), 10), padL(won(a.fee85), 9), padL(won(a.transportFee), 7), padL(won(a.businessTripFee), 7), padL(won(a.travelDayCompensation), 7), padL(won(a.copyrightFee), 7), padL(won(a.cancellationCompensation), 7), padL(won(a.originalPreTax), 11), padL(won(a.computedPreTax), 11), padL(won(a.preTaxDiff), 10), " " + (a.reason || a.warning || ""));
  }
  console.log(`\n   합계: 원본세전 ${won(origSum)} · 시스템세전 ${won(sysSum)} · 차액 ${won(origSum - sysSum)}`);
  const zeroSys = (rep.assignments as any[]).filter(a => a.computedPreTax === 0 && (a.originalPreTax ?? 0) > 0);
  console.log(`   시스템 세전=0 인데 원본>0 인 행: ${zeroSys.length}건 (원본합 ${won(zeroSys.reduce((s, a) => s + (a.originalPreTax ?? 0), 0))}) → 요금/요율 컬럼 파싱 여부 확인 대상`);
  if (zeroSys.length) console.log("   해당 Excel 행:", list(zeroSys.map(a => String(a.rowNumber)), 30));
  const TARGET = "2026-09-15";
  const non0915 = (rep.assignments as any[]).filter(a => a.category !== "equipment" && a.payDate !== TARGET);
  console.log(`\n   [지급일 ≠ 9/15 행] ${non0915.length}건 (프로젝트 등록 대상이나 9/15 지급회차 제외):`);
  for (const a of non0915) console.log(`     행 ${a.rowNumber} | ${(a.companyName || "-").slice(0, 14)} | ${a.translatorName || "-"} | 지급일 ${a.payDate || "(없음)"} | 원본세전 ${won(a.originalPreTax)}`);

  // ── 미매칭 목록 ──
  console.log("\n── [⑤] 미매칭 목록 ──");
  console.log("거래처 미매칭:", rep.companyUnmatchedList.length, "→", list(rep.companyUnmatchedList.map((c: any) => c.raw), 20));
  console.log("통번역사 미매칭:", rep.translatorUnmatchedList.length, "→", list(rep.translatorUnmatchedList, 30));

  // ── 대표 케이스 검증 ──
  console.log("\n── [⑥] 대표 케이스 resolution 검증 ──");
  const cases = await debugResolveCompanies([{ name: "롯데백화점" }, { name: "(주)리치몬트코리아/반클리프아펠" }, { name: "롯데쇼핑(주)" }]);
  for (const c of cases) console.log(`   '${c.input}' → ${c.method} / ${c.companyName || "(미매칭)"}${c.divisionName ? " / " + c.divisionName : ""}`);

  console.log("\n※ DB 미변경. 실제 등록(execute)은 실행하지 않았습니다.\n");
  process.exit(0);
}
main().catch((e) => { console.error("리포트 실패:", e?.stack || e?.message || e); process.exit(1); });
