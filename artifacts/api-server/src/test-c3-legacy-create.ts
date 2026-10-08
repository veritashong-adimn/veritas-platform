// C-3 FIX regression — Legacy 전용 생성 경로. 전부 transaction 내 수행 후 ROLLBACK(실데이터 무변경).
import { db, productsTable, legacyMasterMappingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createLegacyImportedProduct, legacyProductCanonicalKey, legacyProductCode, normalizeProdName } from "./routes/products";
import { resolveProductImportRow, buildProductExistingIndex } from "./services/productImportResolve";
import { resolveByLegacy, recordMapping, PREVIEW_STATUS } from "./services/legacyMapping";

const SS = "old_crm_test";
let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}

async function main() {
  try {
    await db.transaction(async (tx: any) => {
      // TEST1: 언어쌍 없는 통역 2개, 다른 legacyId + 다른 이름 → Product 2개(독립)
      const a = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "T1", productType: "interpretation", name: "영어통역", unit: "1시간" });
      const b = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "T2", productType: "interpretation", name: "영어순차통역", unit: "1시간" });
      check("TEST1 통역 2건(다른 legacyId/이름) → 독립 Product 2개", a.product.id !== b.product.id && a.product.canonicalKey !== b.product.canonicalKey, { a: a.product.id, b: b.product.id });

      // TEST2: 번역 2개
      const c = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "T3", productType: "translation", name: "영한번역", unit: "어절" });
      const d = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "T4", productType: "translation", name: "한영번역", unit: "어절" });
      check("TEST2 번역 2건 → 독립 Product 2개", c.product.id !== d.product.id);

      // 매핑 기록(T1~T4)
      for (const [lid, pid] of [["T1", a.product.id], ["T2", b.product.id], ["T3", c.product.id], ["T4", d.product.id]] as const)
        await recordMapping(tx, { sourceSystem: SS, entityType: "product", legacyId: lid as string, entityId: pid as number });

      // TEST9: 서로 다른 new legacyId → 서로 다른 entityId (1:1)
      const ids = [a.product.id, b.product.id, c.product.id, d.product.id];
      check("TEST9 서로 다른 new → 서로 다른 entityId(1:1)", new Set(ids).size === ids.length, ids);

      // index(활성 상품 + 방금 생성분). 방금 생성분을 index 에 반영.
      const index = await buildProductExistingIndex(tx, normalizeProdName);
      for (const p of [a, b, c, d]) {
        const nk = normalizeProdName(p.product.name);
        (index.byName.get(nk) ?? index.byName.set(nk, []).get(nk)!).push({ id: p.product.id, code: p.product.code, name: p.product.name });
      }

      // TEST3/TEST7: 동일 상품명(영어통역) + 다른 legacyId → duplicate_candidate(병합/생성 안 함)
      const r3 = await resolveProductImportRow(tx, { legacyId: "T5", code: null, name: "영어통역", productType: "interpretation", normalizedName: normalizeProdName("영어통역") }, index, { sourceSystem: SS, isKnownType: true });
      check("TEST3/7 동일명+다른 legacyId → duplicate_candidate(생성 0)", r3.status === PREVIEW_STATUS.DUPLICATE_CANDIDATE && r3.resolvedProductId === null, r3);

      // TEST4: 동일 (SS,product,T1) 재해석 → legacy_match, 동일 entityId 재사용(신규 0)
      const r4 = await resolveByLegacy(tx, { sourceSystem: SS, entityType: "product", legacyId: "T1" });
      check("TEST4 재실행 → legacy_match 동일 entityId 재사용", !!r4 && r4.entityId === a.product.id, r4);

      // TEST5: 앞자리 0 legacyId 원문 보존 + deterministic code/canonicalKey
      const z1 = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "0-81", productType: "interpretation", name: "행사보조", unit: "1시간" });
      const z2 = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "2-002", productType: "interpretation", name: "프로젝트코디네이터", unit: "1시간" });
      const z3 = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "10-04", productType: "interpretation", name: "미얀마관광가이드통역", unit: "1시간" });
      await recordMapping(tx, { sourceSystem: SS, entityType: "product", legacyId: "0-81", entityId: z1.product.id });
      await recordMapping(tx, { sourceSystem: SS, entityType: "product", legacyId: "2-002", entityId: z2.product.id });
      await recordMapping(tx, { sourceSystem: SS, entityType: "product", legacyId: "10-04", entityId: z3.product.id });
      const m = await tx.select().from(legacyMasterMappingsTable).where(eq(legacyMasterMappingsTable.sourceSystem, SS));
      const lids = new Set(m.map((x: any) => x.legacyId));
      check("TEST5 앞자리0 legacyId 원문보존(0-81,2-002,10-04)", lids.has("0-81") && lids.has("2-002") && lids.has("10-04"));
      check("TEST5 code/canonicalKey deterministic", z1.product.canonicalKey === legacyProductCanonicalKey(SS, "0-81") && z1.product.code === legacyProductCode(SS, "0-81"), { ck: z1.product.canonicalKey, code: z1.product.code });

      // TEST6: 문자형 legacyId 원문 보존
      const t6 = await createLegacyImportedProduct(tx, { sourceSystem: SS, legacyId: "영어일본어순차통역", productType: "interpretation", name: "영어일본어순차통역", unit: "1시간" });
      await recordMapping(tx, { sourceSystem: SS, entityType: "product", legacyId: "영어일본어순차통역", entityId: t6.product.id });
      const t6m = await resolveByLegacy(tx, { sourceSystem: SS, entityType: "product", legacyId: "영어일본어순차통역" });
      check("TEST6 문자형 legacyId 원문보존", !!t6m && t6m.legacyId === "영어일본어순차통역", t6m);

      // TEST8: invalid(미매핑 유형) → 생성 0
      const r8 = await resolveProductImportRow(tx, { legacyId: "T8", code: null, name: "장비", productType: "", normalizedName: normalizeProdName("장비") }, index, { sourceSystem: SS, isKnownType: false });
      check("TEST8 invalid → 생성 0(SKIP)", r8.status === PREVIEW_STATUS.INVALID && r8.resolvedProductId === null, r8);

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  // 롤백 확인: 테스트 생성물 미잔존
  const left = await db.select().from(legacyMasterMappingsTable).where(eq(legacyMasterMappingsTable.sourceSystem, SS));
  check("ROLLBACK: 테스트 mapping 미잔존", left.length === 0, left.length);
  const leftP = await db.select().from(productsTable).where(eq(productsTable.canonicalKey, legacyProductCanonicalKey(SS, "T1")));
  check("ROLLBACK: 테스트 product 미잔존", leftP.length === 0, leftP.length);

  console.log(`\n== C-3 legacy-create tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
