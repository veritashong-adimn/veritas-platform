/**
 * 상품 중복 감사 스크립트 (Dry-run)
 *
 * DB 변경 없이 현재 상품 마스터에서 canonicalKey 기준 중복 후보를 조회한다.
 *
 * 확인 항목:
 * 1. canonicalKey 기준 중복 (productType + mainCategory + src + tgt)
 * 2. 방향만 다른 쌍 (ko:en vs en:ko) — 정상, 별도 상품으로 유지 확인
 * 3. zh variant 정규화 영향 (zh-hans vs zh — 동일 취급되는지)
 * 4. 광동어 별도 유지 확인
 *
 * 실행:
 *   DATABASE_URL=... pnpm run audit:products
 */
import { db, pool, productsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";

// ─── canonicalKey 계산 (products.ts의 getOrCreateProduct와 동일 로직) ────────
const PRODUCT_TYPE_CODES: Record<string, string> = {
  translation: "TR", interpretation: "IN", combined: "CO",
  proofreading: "PR", media: "MD", equipment: "EQ",
  editing: "ED", operations: "OP", project: "PJ",
  transport: "TX", meal: "ML", accommodation: "AC",
  other_cost: "OT", expense: "EX",
};

const LANG_TYPES = new Set(["translation", "interpretation", "combined", "proofreading", "media"]);

function normLang(code: string | null): string {
  if (!code) return "";
  const c = code.toLowerCase().trim();
  // zh → zh-hans 통합 (normalizeLangCode와 동일)
  if (c === "zh") return "zh-hans";
  if (c === "yue") return "zh-hant"; // 광동어 fallback 확인용
  return c;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[\s\-_·•]/g, "").replace(/[()（）\[\]【】]/g, "").replace(/간체|번체/g, "");
}

function buildCanonicalKey(p: typeof productsTable.$inferSelect): string {
  const typeCode = PRODUCT_TYPE_CODES[p.productType] ?? p.productType.toUpperCase();
  const hasLang  = LANG_TYPES.has(p.productType);
  const src = normLang(p.sourceLanguage);
  const tgt = normLang(p.targetLanguage);
  return hasLang && (src || tgt)
    ? `${typeCode}:${p.mainCategory ?? ""}:${src}:${tgt}`
    : `${typeCode}:::${normName(p.name)}`;
}

function buildLazyCanonicalKey(p: typeof productsTable.$inferSelect): string {
  // Lazy Product Generation style: mainCategory 포함하지 않음 (TR:ko:en)
  const typeCode = PRODUCT_TYPE_CODES[p.productType] ?? p.productType.toUpperCase();
  const hasLang  = LANG_TYPES.has(p.productType);
  const src = normLang(p.sourceLanguage);
  const tgt = normLang(p.targetLanguage);
  return hasLang && (src || tgt)
    ? `${typeCode}:${src}:${tgt}`
    : `${typeCode}:::${normName(p.name)}`;
}

async function main() {
  console.log("\n🔍 상품 중복 감사 (Dry-run — DB 변경 없음)");
  console.log("─".repeat(70));

  const products = await db.select().from(productsTable).where(isNull(productsTable.deletedAt));
  console.log(`\n총 활성 상품: ${products.length}건\n`);

  // ── 1. canonicalKey 기준 중복 (현재 getOrCreateProduct와 동일 기준) ──────
  const byCanonicalKey = new Map<string, typeof products>();
  for (const p of products) {
    const key = buildCanonicalKey(p);
    if (!byCanonicalKey.has(key)) byCanonicalKey.set(key, []);
    byCanonicalKey.get(key)!.push(p);
  }

  const duplicates = [...byCanonicalKey.entries()].filter(([, ps]) => ps.length > 1);
  console.log(`1️⃣  현재 중복 방지 기준 (productType+mainCategory+src+tgt) 중복:`);
  if (duplicates.length === 0) {
    console.log("   ✅ 중복 없음\n");
  } else {
    for (const [key, ps] of duplicates) {
      console.log(`   ⚠️  [${key}] — ${ps.length}건:`);
      for (const p of ps) {
        console.log(`      ID ${String(p.id).padEnd(4)} | ${p.code.padEnd(24)} | ${p.name}`);
      }
    }
    console.log();
  }

  // ── 2. Lazy canonicalKey 기준 (mainCategory 제외) ─────────────────────────
  const byLazyKey = new Map<string, typeof products>();
  for (const p of products) {
    const key = buildLazyCanonicalKey(p);
    if (!byLazyKey.has(key)) byLazyKey.set(key, []);
    byLazyKey.get(key)!.push(p);
  }

  const lazyDupes = [...byLazyKey.entries()].filter(([, ps]) => ps.length > 1);
  console.log(`2️⃣  Lazy 기준 중복 (productType+src+tgt, mainCategory 무시):`);
  if (lazyDupes.length === 0) {
    console.log("   ✅ 중복 없음\n");
  } else {
    for (const [key, ps] of lazyDupes) {
      console.log(`   ℹ️  [${key}] — ${ps.length}건 (mainCategory가 달라 의도적 분리일 수 있음):`);
      for (const p of ps) {
        console.log(`      ID ${String(p.id).padEnd(4)} | mainCat: ${(p.mainCategory ?? "").padEnd(12)} | ${p.name}`);
      }
    }
    console.log();
  }

  // ── 3. 방향 쌍 확인 (ko:en ↔ en:ko — 별도 상품 유지 확인) ─────────────
  const langPairProducts = products.filter(p => LANG_TYPES.has(p.productType) && p.sourceLanguage && p.targetLanguage);
  const directionPairs: { a: typeof products[number]; b: typeof products[number] }[] = [];
  for (let i = 0; i < langPairProducts.length; i++) {
    for (let j = i + 1; j < langPairProducts.length; j++) {
      const a = langPairProducts[i], b = langPairProducts[j];
      if (a.productType === b.productType &&
          normLang(a.sourceLanguage) === normLang(b.targetLanguage) &&
          normLang(a.targetLanguage) === normLang(b.sourceLanguage)) {
        directionPairs.push({ a, b });
      }
    }
  }

  console.log(`3️⃣  방향 반전 쌍 확인 (예: ko↔en — 별도 상품으로 정상 유지):`);
  if (directionPairs.length === 0) {
    console.log("   (해당 없음)\n");
  } else {
    for (const { a, b } of directionPairs) {
      console.log(`   ✓  ${a.sourceLanguage}→${a.targetLanguage} [${a.name}]`);
      console.log(`      ${b.sourceLanguage}→${b.targetLanguage} [${b.name}] — 별도 상품 ✓`);
    }
    console.log();
  }

  // ── 4. 중국어 variant 확인 ────────────────────────────────────────────────
  const zhProducts = products.filter(p =>
    p.sourceLanguage?.startsWith("zh") || p.targetLanguage?.startsWith("zh") ||
    p.sourceLanguage === "yue" || p.targetLanguage === "yue"
  );
  console.log(`4️⃣  중국어 계열 상품 현황 (zh-hans/zh-hant/yue 분리 확인):`);
  if (zhProducts.length === 0) {
    console.log("   (해당 없음)\n");
  } else {
    for (const p of zhProducts) {
      const src = p.sourceLanguage ?? "";
      const tgt = p.targetLanguage ?? "";
      const isCantonese = src === "yue" || tgt === "yue";
      const icon = isCantonese ? "🔵 광동어(별도 유지)" : "📋 중국어 계열";
      console.log(`   ${icon} ID ${p.id} | src:${src} tgt:${tgt} | ${p.name}`);
    }
    console.log();
  }

  // ── 5. DB schema 현황 보고 ─────────────────────────────────────────────────
  console.log(`5️⃣  DB Schema 현황:`);
  console.log(`   ❌ canonical_key 컬럼 없음 — DB level unique index 미적용 상태`);
  console.log(`   ℹ️  현재 중복 방지: 코드 레벨 (getOrCreateProduct → findDuplicate)`);
  console.log(`   📌 canonical_key 컬럼 추가 시 drizzle-kit push 필요 (별도 승인 후 진행)`);
  console.log(`   📌 unique index는 기존 중복 없음 확인 후 적용 권장\n`);

  await pool.end();
}

main().catch(err => {
  console.error("오류:", err);
  pool.end();
  process.exit(1);
});
