/**
 * 통역 상품 중국어 script variant 이름 정규화 스크립트
 *
 * 문제: "중국어(간체) 동시통역", "한국어-중국어(번체) 순차통역" 등
 *       spoken language 기반 통역 상품에 문자체계 qualifier가 포함된 상태
 *
 * 수정: (간체), (번체) 제거 → "중국어 동시통역", "한국어-중국어 순차통역"
 * 예외: 광동어(広東語) 상품은 구어 언어이므로 변경하지 않음
 *
 * 실행:
 *   pnpm run fix:zh-interp          # dry-run (변경 예정 목록만 출력)
 *   pnpm run fix:zh-interp -- --apply  # 실제 DB 적용
 */
import { db, pool, productsTable } from "@workspace/db";
import { eq, or, ilike, and } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");

function normalizeInterpName(name: string): string {
  return name
    .replace(/\(간체\)/g, "")
    .replace(/\(번체\)/g, "")
    .replace(/\(zh-hans\)/gi, "")
    .replace(/\(zh-hant\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function main() {
  console.log(`\n🔍 통역 상품 중국어 script variant 정규화`);
  console.log(`   모드: ${APPLY ? "✅ 실제 적용 (--apply)" : "🔎 Dry-run (변경 없음)"}\n`);

  // 통역 상품 중 (간체) 또는 (번체) 포함된 것 조회
  const candidates = await db
    .select()
    .from(productsTable)
    .where(
      and(
        eq(productsTable.productType, "interpretation"),
        or(
          ilike(productsTable.name, "%(간체)%"),
          ilike(productsTable.name, "%(번체)%"),
          ilike(productsTable.name, "%(zh-hans)%"),
          ilike(productsTable.name, "%(zh-hant)%"),
        ),
      ),
    );

  // 광동어 상품 제외 (구어 언어 — script variant가 아님)
  const targets = candidates.filter(p => !p.name.includes("광동어"));
  const skippedCantonese = candidates.filter(p => p.name.includes("광동어"));

  if (skippedCantonese.length > 0) {
    console.log(`⚠️  광동어 상품 ${skippedCantonese.length}건 — 변경 제외 (구어 언어):`);
    skippedCantonese.forEach(p => console.log(`     [${p.id}] ${p.name}`));
    console.log();
  }

  if (targets.length === 0) {
    console.log("✅ 변경 대상 없음 — 이미 정규화된 상태입니다.\n");
    await pool.end();
    return;
  }

  console.log(`📋 변경 대상 ${targets.length}건:\n`);
  console.log(
    `  ${"ID".padEnd(6)} ${"현재 이름".padEnd(45)} ${"→ 변경 후".padEnd(40)} 상태`,
  );
  console.log("  " + "─".repeat(100));

  const changes: { id: number; before: string; after: string }[] = [];

  for (const p of targets) {
    const after = normalizeInterpName(p.name);
    const isSame = after === p.name;
    const status = isSame ? "  (변경 없음)" : "";
    console.log(
      `  ${String(p.id).padEnd(6)} ${p.name.padEnd(45)} → ${after.padEnd(40)}${status}`,
    );
    if (!isSame) changes.push({ id: p.id, before: p.name, after });
  }

  console.log(`\n  실제 변경: ${changes.length}건 / 조회: ${targets.length}건`);

  if (changes.length === 0) {
    console.log("✅ 실제 변경 대상 없음.\n");
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log(`\n  ℹ️  적용하려면: pnpm run fix:zh-interp -- --apply\n`);
    await pool.end();
    return;
  }

  // ── 실제 적용 ───────────────────────────────────────────────────────────
  console.log(`\n🔧 DB 적용 중...\n`);
  let successCount = 0;
  let failCount = 0;

  for (const { id, before, after } of changes) {
    try {
      await db
        .update(productsTable)
        .set({ name: after })
        .where(eq(productsTable.id, id));
      console.log(`  ✅ [${id}] "${before}" → "${after}"`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ [${id}] 업데이트 실패:`, err);
      failCount++;
    }
  }

  console.log(`\n완료: 성공 ${successCount}건 / 실패 ${failCount}건\n`);
  await pool.end();
}

main().catch(err => {
  console.error("오류:", err);
  pool.end();
  process.exit(1);
});
