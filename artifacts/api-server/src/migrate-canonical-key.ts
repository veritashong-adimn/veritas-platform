/**
 * canonical_key backfill — 기존 products 40건에 canonical_key 값 채우기
 * getOrCreateProduct와 동일한 로직을 사용해야 unique index와 일치함.
 *
 * 실행: DATABASE_URL=... pnpm run migrate:canonical-key
 */
import { db, pool, productsTable } from "@workspace/db";
import { isNull, sql } from "drizzle-orm";

// ─── 상수 (products.ts의 PRODUCT_TYPES와 동일) ────────────────────────────────
const PRODUCT_TYPES: Record<string, { code: string; hasLanguage: boolean }> = {
  translation:    { code: "TR", hasLanguage: true },
  interpretation: { code: "IN", hasLanguage: true },
  combined:       { code: "CO", hasLanguage: true },
  proofreading:   { code: "PR", hasLanguage: true },
  media:          { code: "MD", hasLanguage: true },
  equipment:      { code: "EQ", hasLanguage: false },
  editing:        { code: "ED", hasLanguage: false },
  operations:     { code: "OP", hasLanguage: false },
  project:        { code: "PJ", hasLanguage: false },
  transport:      { code: "TX", hasLanguage: false },
  meal:           { code: "ML", hasLanguage: false },
  accommodation:  { code: "AC", hasLanguage: false },
  other_cost:     { code: "OT", hasLanguage: false },
  expense:        { code: "EX", hasLanguage: false },
};

// ─── products.ts의 normalizeLangCode와 동일 ───────────────────────────────────
function normalizeLangCode(code: string | null): string {
  if (!code) return "";
  const c = code.toLowerCase().trim();
  if (c === "zh") return "zh-hans";
  if (c === "yue") return "zh-hant";
  return c;
}

// ─── products.ts의 normalizeProdName과 동일 ──────────────────────────────────
function normalizeProdName(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[\s\-_·•]/g, "")
    .replace(/[()（）\[\]【】]/g, "")
    .replace(/간체|번체/g, "")
    .normalize("NFC");
}

// ─── getOrCreateProduct의 canonicalKey 계산 로직과 동일 ──────────────────────
function buildCanonicalKey(p: typeof productsTable.$inferSelect): string {
  const typeInfo = PRODUCT_TYPES[p.productType];
  const typeCode = typeInfo?.code ?? p.productType.toUpperCase();
  const hasLang  = typeInfo?.hasLanguage ?? false;
  const src      = normalizeLangCode(p.sourceLanguage);
  const tgt      = normalizeLangCode(p.targetLanguage);
  const mainCat  = p.mainCategory ?? "";

  return hasLang && (src || tgt)
    ? `${typeCode}:${mainCat}:${src}:${tgt}`
    : `${typeCode}:::${normalizeProdName(p.name)}`;
}

async function main() {
  console.log("\n🚀 canonical_key backfill 시작\n" + "─".repeat(60));

  // 1. 전체 활성 상품 조회
  const products = await db.select().from(productsTable).where(isNull(productsTable.deletedAt));
  console.log(`총 활성 상품: ${products.length}건`);

  // 2. 각 상품에 canonical_key 계산 및 업데이트
  let updated = 0;
  let skipped = 0;
  const results: { id: number; code: string; name: string; canonicalKey: string }[] = [];

  for (const p of products) {
    const key = buildCanonicalKey(p);
    results.push({ id: p.id, code: p.code, name: p.name, canonicalKey: key });

    await db.execute(
      sql`UPDATE products SET canonical_key = ${key} WHERE id = ${p.id}`,
    );
    updated++;
  }

  console.log(`\n✅ 업데이트 완료: ${updated}건  스킵: ${skipped}건\n`);

  // 3. 결과 검증 — DB에서 다시 읽어 확인
  const verify = await db
    .select({
      id:           productsTable.id,
      code:         productsTable.code,
      name:         productsTable.name,
      canonicalKey: productsTable.canonicalKey,
    })
    .from(productsTable)
    .where(isNull(productsTable.deletedAt));

  const nullKeys = verify.filter(v => !v.canonicalKey);
  const keys     = verify.map(v => v.canonicalKey).filter(Boolean) as string[];
  const uniqueKeys = new Set(keys);

  console.log("─".repeat(60));
  console.log("검증 결과:");
  console.log(`  총 활성 상품: ${verify.length}건`);
  console.log(`  canonical_key 채워진 건수: ${verify.length - nullKeys.length}건`);
  console.log(`  canonical_key NULL 건수:   ${nullKeys.length}건`);
  console.log(`  고유 key 수:               ${uniqueKeys.size}건`);
  console.log(`  중복 key 여부:             ${uniqueKeys.size === keys.length ? "✅ 없음" : "⚠️  있음!"}`);

  if (nullKeys.length > 0) {
    console.log("\n⚠️  NULL canonical_key 상품:");
    for (const v of nullKeys) console.log(`   ID ${v.id}  ${v.code}  ${v.name}`);
  }

  // 4. 전체 key 목록 출력 (감사)
  console.log("\n📋 전체 canonical_key 목록:");
  for (const v of verify.sort((a, b) => a.id - b.id)) {
    console.log(`  ID ${String(v.id).padEnd(4)} ${(v.canonicalKey ?? "NULL").padEnd(45)}  ${v.name}`);
  }

  // 5. 중복 확인
  const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupKeys.length > 0) {
    console.log("\n❌ 중복 canonical_key 발견!");
    for (const dk of [...new Set(dupKeys)]) {
      const dups = verify.filter(v => v.canonicalKey === dk);
      console.log(`  [${dk}]:`);
      for (const d of dups) console.log(`    ID ${d.id}  ${d.name}`);
    }
    await pool.end();
    process.exit(1);
  }

  console.log("\n✅ 중복 0건 — unique index 생성 가능\n");
  await pool.end();
}

main().catch(err => {
  console.error("오류:", err);
  pool.end().then(() => process.exit(1));
});
