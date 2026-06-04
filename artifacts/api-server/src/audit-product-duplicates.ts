/**
 * 상품 중복 감사 (Dry-run) — canonicalKey 확정 기준 재점검
 *
 * 확정 기준:
 *   번역:    TR:{mainCategory}:{normSrc}:{normTgt}   예: TR:전문번역:ko:en
 *   통역:    IN:{mainCategory}:{normSrc}:{normTgt}   예: IN:동시통역:ko:en
 *   비언어:  {typeCode}:::{normName}                 예: EQ:::동시통역장비
 *   대분류 없음: mainCategory 자리 = "none"          예: TR:none:ko:en
 *
 * 실행:
 *   DATABASE_URL=... pnpm run audit:products
 */
import { db, pool, productsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";

// ─── 상수 ─────────────────────────────────────────────────────────────────────
const TYPE_CODES: Record<string, string> = {
  translation: "TR", interpretation: "IN", combined: "CO",
  proofreading: "PR", media: "MD", equipment: "EQ",
  editing: "ED", operations: "OP", project: "PJ",
  transport: "TX", meal: "ML", accommodation: "AC",
  other_cost: "OT", expense: "EX",
};
const LANG_TYPES = new Set(["translation", "interpretation", "combined", "proofreading", "media"]);

// ─── 정규화 헬퍼 ──────────────────────────────────────────────────────────────
function normLang(code: string | null): string {
  if (!code) return "";
  const c = code.toLowerCase().trim();
  if (c === "zh") return "zh-hans"; // getOrCreateProduct의 normalizeLangCode와 동일
  if (c === "yue") return "yue";    // 광동어는 별도 유지
  return c;
}

function normName(s: string): string {
  return s.toLowerCase()
    .replace(/[\s\-_·•\/]/g, "")
    .replace(/[()（）\[\]【】]/g, "")
    .replace(/간체|번체/g, "");
}

// ─── canonicalKey 계산 (확정 기준) ────────────────────────────────────────────
// mainCategory를 포함하므로 일반번역 ≠ 전문번역
function buildCanonicalKey(p: typeof productsTable.$inferSelect): string {
  const typeCode = TYPE_CODES[p.productType] ?? p.productType.toUpperCase();
  const hasLang  = LANG_TYPES.has(p.productType);
  const src      = normLang(p.sourceLanguage);
  const tgt      = normLang(p.targetLanguage);
  const mainCat  = p.mainCategory?.trim() || "none";

  return hasLang && (src || tgt)
    ? `${typeCode}:${mainCat}:${src}:${tgt}`
    : `${typeCode}:::${normName(p.name)}`;
}

// Lazy 기준 (mainCategory 제외) — 비교용
function buildLazyCanonicalKey(p: typeof productsTable.$inferSelect): string {
  const typeCode = TYPE_CODES[p.productType] ?? p.productType.toUpperCase();
  const hasLang  = LANG_TYPES.has(p.productType);
  const src      = normLang(p.sourceLanguage);
  const tgt      = normLang(p.targetLanguage);
  return hasLang && (src || tgt)
    ? `${typeCode}:${src}:${tgt}`
    : `${typeCode}:::${normName(p.name)}`;
}

async function main() {
  console.log("\n🔍 상품 중복 감사 v2 — 확정 canonicalKey 기준 (Dry-run)\n" + "─".repeat(72));
  console.log("📌 기준: {typeCode}:{mainCategory}:{normSrc}:{normTgt}\n");

  const products = await db.select().from(productsTable).where(isNull(productsTable.deletedAt));
  console.log(`총 활성 상품: ${products.length}건\n`);

  // ── 1. 확정 기준 중복 점검 ─────────────────────────────────────────────────
  const byKey = new Map<string, typeof products>();
  for (const p of products) {
    const k = buildCanonicalKey(p);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(p);
  }

  const dupes = [...byKey.entries()].filter(([, ps]) => ps.length > 1);
  console.log("1️⃣  확정 기준 중복 (mainCategory 포함):");
  if (dupes.length === 0) {
    console.log("   ✅ 중복 0건 — unique index 추가 조건 충족\n");
  } else {
    for (const [key, ps] of dupes) {
      console.log(`   ⚠️  [${key}]  ${ps.length}건:`);
      for (const p of ps) {
        console.log(`      ID ${String(p.id).padEnd(4)}  ${p.code.padEnd(24)}  ${p.name}`);
      }
    }
    console.log();
  }

  // ── 2. 전체 canonicalKey 목록 ──────────────────────────────────────────────
  console.log("2️⃣  전체 canonicalKey 목록:\n");
  const langProducts = products.filter(p => LANG_TYPES.has(p.productType) && (p.sourceLanguage || p.targetLanguage));
  const nonLangProducts = products.filter(p => !LANG_TYPES.has(p.productType) || (!p.sourceLanguage && !p.targetLanguage));

  console.log("  ── 언어형 상품 ──");
  for (const p of langProducts) {
    const key = buildCanonicalKey(p);
    console.log(`  ${key.padEnd(40)}  ID ${p.id}  ${p.name}`);
  }
  console.log(`\n  ── 비언어형 상품 (${nonLangProducts.length}건) ──`);
  for (const p of nonLangProducts) {
    const key = buildCanonicalKey(p);
    console.log(`  ${key.padEnd(40)}  ID ${p.id}  ${p.name}`);
  }

  // ── 3. Lazy 기준 비교 (mainCategory 제외 시 중복 발생 확인) ──────────────
  const byLazyKey = new Map<string, typeof products>();
  for (const p of products) {
    const k = buildLazyCanonicalKey(p);
    if (!byLazyKey.has(k)) byLazyKey.set(k, []);
    byLazyKey.get(k)!.push(p);
  }
  const lazyDupes = [...byLazyKey.entries()].filter(([, ps]) => ps.length > 1);
  console.log(`\n3️⃣  비교: Lazy 기준 (mainCategory 제외 시) 중복:`);
  if (lazyDupes.length === 0) {
    console.log("   ✅ 없음\n");
  } else {
    for (const [key, ps] of lazyDupes) {
      console.log(`   ⚠️  [${key}]  ${ps.length}건 — mainCategory가 다르므로 의도적 분리:`);
      for (const p of ps) {
        console.log(`      ID ${p.id}  mainCat: ${(p.mainCategory ?? "(없음)").padEnd(12)}  ${p.name}`);
      }
    }
    console.log("   → mainCategory 포함 기준을 사용해야 하는 이유 확인됨\n");
  }

  // ── 4. 방향 반전 쌍 (ko:en ≠ en:ko — 별도 상품 정상 유지) ───────────────
  const langPs = products.filter(p => LANG_TYPES.has(p.productType) && p.sourceLanguage && p.targetLanguage);
  const revPairs: { a: typeof products[number]; b: typeof products[number] }[] = [];
  const seen = new Set<string>();
  for (const a of langPs) {
    for (const b of langPs) {
      if (a.id === b.id) continue;
      const pairKey = [Math.min(a.id, b.id), Math.max(a.id, b.id)].join(":");
      if (seen.has(pairKey)) continue;
      if (normLang(a.sourceLanguage) === normLang(b.targetLanguage) &&
          normLang(a.targetLanguage) === normLang(b.sourceLanguage) &&
          a.productType === b.productType && a.mainCategory === b.mainCategory) {
        revPairs.push({ a, b });
        seen.add(pairKey);
      }
    }
  }
  console.log("4️⃣  방향 반전 쌍 (별도 상품으로 정상 유지):");
  if (revPairs.length === 0) {
    console.log("   (해당 없음)\n");
  } else {
    for (const { a, b } of revPairs) {
      console.log(`   ✓  ${a.sourceLanguage}→${a.targetLanguage}  [${a.name}]`);
      console.log(`      ${b.sourceLanguage}→${b.targetLanguage}  [${b.name}]  — 별도 상품 ✓`);
    }
    console.log();
  }

  // ── 5. 중국어 계열 분리 확인 ─────────────────────────────────────────────
  const zhPs = products.filter(p =>
    p.sourceLanguage?.startsWith("zh") || p.targetLanguage?.startsWith("zh") ||
    p.sourceLanguage === "yue" || p.targetLanguage === "yue"
  );
  console.log("5️⃣  중국어 계열 상품:");
  if (zhPs.length === 0) {
    console.log("   (현재 없음)\n");
  } else {
    for (const p of zhPs) {
      const icon = (p.sourceLanguage === "yue" || p.targetLanguage === "yue") ? "🔵 광동어" : "📋 중국어";
      console.log(`   ${icon}  ID ${p.id}  src:${p.sourceLanguage ?? ""}  tgt:${p.targetLanguage ?? ""}  ${p.name}`);
    }
    console.log();
  }

  // ── 6. Migration 계획 보고 ────────────────────────────────────────────────
  console.log("─".repeat(72));
  console.log("6️⃣  canonical_key 컬럼 추가 — Migration 계획 (미실행)\n");
  console.log("  ▸ Schema 변경 (lib/db/src/schema/products.ts):");
  console.log("    추가: canonicalKey: text(\"canonical_key\"),\n");
  console.log("  ▸ 실행 방법:");
  console.log("    cd lib/db && pnpm run push\n");
  console.log("  ▸ 실행 SQL (참고):");
  console.log("    ALTER TABLE products ADD COLUMN canonical_key TEXT;\n");
  console.log("  ▸ 컬럼 추가 후 기존 상품 backfill 쿼리 (참고):");
  console.log(`    -- 언어형 상품
    UPDATE products SET canonical_key =
      CONCAT(
        CASE product_type
          WHEN 'translation'    THEN 'TR'
          WHEN 'interpretation' THEN 'IN'
          WHEN 'combined'       THEN 'CO'
          WHEN 'proofreading'   THEN 'PR'
          WHEN 'media'          THEN 'MD'
          ELSE UPPER(product_type)
        END,
        ':',
        COALESCE(NULLIF(main_category,''), 'none'),
        ':',
        LOWER(COALESCE(source_language,'')),
        ':',
        LOWER(COALESCE(target_language,''))
      )
    WHERE product_type IN ('translation','interpretation','combined','proofreading','media')
      AND (source_language IS NOT NULL OR target_language IS NOT NULL)
      AND deleted_at IS NULL;\n`);
  console.log("  ▸ Unique index 추가 (backfill 완료 후):");
  console.log("    CREATE UNIQUE INDEX products_canonical_key_unique");
  console.log("      ON products(canonical_key)");
  console.log("      WHERE canonical_key IS NOT NULL AND deleted_at IS NULL;\n");
  console.log("  ▸ Rollback:");
  console.log("    ALTER TABLE products DROP COLUMN canonical_key;\n");
  console.log("  ⚠️  실행 전 확인 사항:");
  console.log("    1. 중복 0건 확인 (위 1️⃣ 결과)");
  console.log("    2. 위 backfill 쿼리로 생성되는 값이 코드의 getOrCreateProduct와 동일한지 검증");
  console.log("    3. unique index는 backfill 후 별도 실행 (nullable → not null 전환 시점 협의)\n");

  await pool.end();
}

main().catch(err => {
  console.error("오류:", err);
  pool.end();
  process.exit(1);
});
