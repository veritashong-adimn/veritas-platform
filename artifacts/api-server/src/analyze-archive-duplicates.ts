// READ-ONLY 중복 분석 — Preview 와 "동일한" buildArchivePreview/computeRowHash 로 파일 내부 중복을 진단한다.
// DB 접근 전혀 없음. INSERT/UPDATE/DELETE/migration 없음. 파일 읽기 + 메모리 분석만.
// 사용: node dist/analyze-archive-duplicates.mjs <파일경로> [sourceType=progress]
import fs from "node:fs";
import { buildArchivePreview, type ArchiveSourceType, type ArchivePreviewRow } from "./services/legacyArchiveResolve";

function deepEqualJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  const path = process.argv[2];
  const sourceType = (process.argv[3] as ArchiveSourceType) || "progress";
  if (!path || !fs.existsSync(path)) { console.error("파일경로 필요. 예: node dist/analyze-archive-duplicates.mjs /tmp/TranSchedule.xls progress"); process.exit(1); }

  const buf = fs.readFileSync(path);
  const sheets = buildArchivePreview(buf, sourceType);
  const rows: ArchivePreviewRow[] = sheets.flatMap(s => s.rows);
  console.log(`파일: ${path}`);
  console.log(`source_type: ${sourceType}`);
  console.log(`시트: ${sheets.map(s => `${s.sheetName}(${s.rows.length})`).join(", ")}`);
  console.log(`총 데이터 행(blank 제외): ${rows.length}`);

  // hash 별 group
  const byHash = new Map<string, ArchivePreviewRow[]>();
  for (const r of rows) { (byHash.get(r.rowHash) ?? byHash.set(r.rowHash, []).get(r.rowHash)!).push(r); }
  const dupGroups = [...byHash.values()].filter(g => g.length > 1);

  const distinctHashes = byHash.size;
  const dupRowCount = rows.length - distinctHashes;  // Preview '중복' 과 동일 정의(2번째 이후 출현)

  // 각 dup group 에서 source_raw 전체 동일 여부
  let groupsAllIdentical = 0, groupsDiffer = 0;
  const collisionSamples: any[] = [];
  let consecutivePairs = 0, nonConsecutivePairs = 0;
  for (const g of dupGroups) {
    const base = g[0].sourceRaw;
    const allSame = g.every(m => deepEqualJSON(m.sourceRaw, base));
    if (allSame) groupsAllIdentical++; else { groupsDiffer++; if (collisionSamples.length < 20) collisionSamples.push({ hash: g[0].rowHash.slice(0, 12), rows: g.map(m => m.sourceRow), raws: g.map(m => m.sourceRaw) }); }
    // 연속/비연속(정렬된 sourceRow 인접 여부)
    const sorted = g.map(m => m.sourceRow).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) { if (sorted[i] - sorted[i - 1] === 1) consecutivePairs++; else nonConsecutivePairs++; }
  }

  console.log(`\n── 집계 ──`);
  console.log(`distinct row_hash: ${distinctHashes}`);
  console.log(`duplicate row 수(2번째+ 출현): ${dupRowCount}`);
  console.log(`duplicate group 수: ${dupGroups.length}`);
  console.log(`source_raw 전체 동일 group: ${groupsAllIdentical}`);
  console.log(`source_raw 다른데 같은 hash(충돌) group: ${groupsDiffer}`);
  console.log(`연속(인접 행) 중복쌍: ${consecutivePairs}`);
  console.log(`비연속(떨어진 행) 중복쌍: ${nonConsecutivePairs}`);

  if (groupsDiffer > 0) {
    console.log(`\n🚨 HASH COLLISION / SERIALIZATION ISSUE — 서로 다른 원본인데 같은 hash:`);
    for (const c of collisionSamples) { console.log(JSON.stringify(c, null, 2)); }
    console.log(`\n결론: DUPLICATE LOGIC NEEDS FIX`);
    process.exit(2);
  }

  // 대표 10개 group sample(원본 전체 동일 확인 포함)
  console.log(`\n── 대표 duplicate group sample (최대 10) ──`);
  const pick = (r: ArchivePreviewRow, k: string) => (r.sourceRaw as any)[k] ?? "-";
  for (const g of dupGroups.slice(0, 10)) {
    const r = g[0];
    console.log(JSON.stringify({
      excelRows: g.map(m => m.sourceRow),
      count: g.length,
      거래처: r.companyName ?? pick(r, "거래처명"),
      고객: r.contactName,
      상품: r.productName,
      통번역사: r.translatorName,
      언어: r.language,
      납품일: r.deliveryDate,
      지급일: r.payoutDate,
      지급액: r.payoutPretax,
      source_raw_전체동일: g.every(m => deepEqualJSON(m.sourceRaw, r.sourceRaw)),
    }));
  }

  console.log(`\n결론: ${groupsDiffer === 0 && dupRowCount >= 0 ? "SAFE TO SKIP EXACT DUPLICATES (모든 중복이 원본 전체 동일)" : "NEEDS MANUAL REVIEW"}`);
}
main();
