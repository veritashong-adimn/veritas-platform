/**
 * canonical_key backfill + 통역 zh script variant 정규화
 *
 * 기존 interpretation 상품의 sourceLanguage/targetLanguage에 zh-hans/zh-hant가
 * 저장된 경우 zh로 정규화하고, canonical_key도 재계산한다.
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

// ─── products.ts의 normalizeLangCodeForInterp와 동일 ─────────────────────────
// 통역 계열: zh-hans/zh-hant → zh (spoken language 기준, script variant 제거)
function normalizeLangCodeForInterp(code: string | null): string {
  const c = normalizeLangCode(code);
  if (c === "zh-hans" || c === "zh-hant") return "zh";
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
  const typeInfo  = PRODUCT_TYPES[p.productType];
  const typeCode  = typeInfo?.code ?? p.productType.toUpperCase();
  const hasLang   = typeInfo?.hasLanguage ?? false;
  const isInterp  = p.productType === "interpretation";
  const src       = isInterp ? normalizeLangCodeForInterp(p.sourceLanguage) : normalizeLangCode(p.sourceLanguage);
  const tgt       = isInterp ? normalizeLangCodeForInterp(p.targetLanguage) : normalizeLangCode(p.targetLanguage);
  const mainCat   = p.mainCategory ?? "";

  return hasLang && (src || tgt)
    ? `${typeCode}:${mainCat}:${src}:${tgt}`
    : `${typeCode}:::${normalizeProdName(p.name)}`;
}

// 통역 상품의 저장 언어 코드 정규화 여부 확인
function normalizedLangForStorage(code: string | null, productType: string): string | null {
  if (!code) return null;
  if (productType === "interpretation") return normalizeLangCodeForInterp(code) || null;
  return code;
}

async function main() {
  console.log("\n🚀 canonical_key backfill + 통역 zh 언어코드 정규화\n" + "─".repeat(60));

  // 1. 전체 활성 상품 조회
  const products = await db.select().from(productsTable).where(isNull(productsTable.deletedAt));
  console.log(`총 활성 상품: ${products.length}건`);

  // 2. 각 상품에 canonical_key 계산 및 업데이트
  //    통역 상품은 sourceLanguage/targetLanguage의 zh script variant도 정규화
  let updated = 0;
  let langNormCount = 0;
  const results: { id: number; code: string; name: string; canonicalKey: string }[] = [];

  for (const p of products) {
    const key     = buildCanonicalKey(p);
    const newSrc  = normalizedLangForStorage(p.sourceLanguage, p.productType);
    const newTgt  = normalizedLangForStorage(p.targetLanguage, p.productType);
    const srcChanged = newSrc !== p.sourceLanguage;
    const tgtChanged = newTgt !== p.targetLanguage;

    results.push({ id: p.id, code: p.code, name: p.name, canonicalKey: key });

    if (srcChanged || tgtChanged) {
      console.log(`  [${p.id}] ${p.name}`);
      if (srcChanged) console.log(`    sourceLanguage: "${p.sourceLanguage}" → "${newSrc}"`);
      if (tgtChanged) console.log(`    targetLanguage: "${p.targetLanguage}" → "${newTgt}"`);
      langNormCount++;
    }

    await db.execute(
      sql`UPDATE products SET canonical_key = ${key}, source_language = ${newSrc}, target_language = ${newTgt} WHERE id = ${p.id}`,
    );
    updated++;
  }

  if (langNormCount > 0) {
    console.log(`\n  언어코드 정규화: ${langNormCount}건 (zh-hans/zh-hant → zh for interpretation)\n`);
  }

  console.log(`\n✅ 업데이트 완료: ${updated}건\n`);

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
