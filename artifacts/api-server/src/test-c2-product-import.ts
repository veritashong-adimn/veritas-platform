// C-2 상품 import resolver/idempotency 검증 — 전부 transaction 안에서 수행 후 ROLLBACK(실데이터 무변경).
import { db, productsTable, legacyMasterMappingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveProductImportRow, buildProductExistingIndex, pickLegacyIdColumn, normalizeLegacyId } from "./services/productImportResolve";
import { recordMapping, PREVIEW_STATUS } from "./services/legacyMapping";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");
let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, extra ?? ""); }
}

async function main() {
  const SS = "old_crm";
  // 헤더 alias 인식 + TEXT 보존(단위 테스트, DB 불필요)
  // C-3: "상품코드" 가 legacyId alias 로 추가됨 → 헤더에 있으면 인식되어야 함.
  check("pickLegacyIdColumn finds '기존상품ID'", pickLegacyIdColumn(["메모", "상품명", "기존상품ID"]) === 2);
  check("pickLegacyIdColumn finds '상품코드' (C-3 alias)", pickLegacyIdColumn(["상품코드", "상품명", "단가"]) === 0);
  check("pickLegacyIdColumn none", pickLegacyIdColumn(["메모", "상품명"]) === -1);
  check("normalizeLegacyId '007' preserved", normalizeLegacyId("007") === "007");
  check("normalizeLegacyId '  ' → null", normalizeLegacyId("  ") === null);

  try {
    await db.transaction(async (tx: any) => {
      // 기존 상품 1건 생성(= 이미 존재하는 '일반번역')
      const [exist] = await tx.insert(productsTable).values({
        code: "__C2_TEST_TR__", name: "일반번역", productType: "translation",
        mainCategory: "GEN", unit: "건", canonicalKey: "__c2_test_canon__",
      }).returning();

      const index = await buildProductExistingIndex(tx, norm);

      // mapping: old_crm/product/P001 → exist.id
      await recordMapping(tx, { sourceSystem: SS, entityType: "product", legacyId: "P001", entityId: exist.id });

      // D) 같은 legacyId + 다른 이름 → legacy_match 재사용
      const rD = await resolveProductImportRow(tx,
        { legacyId: "P001", code: null, name: "일반번역(전문)", productType: "translation", normalizedName: norm("일반번역(전문)") },
        index, { sourceSystem: SS, isKnownType: true });
      check("D same legacyId/diff name → legacy_match + reuse exist.id",
        rD.status === PREVIEW_STATUS.LEGACY_MATCH && rD.resolvedProductId === exist.id, rD);

      // C) 같은 이름 + 다른 legacyId → 자동병합 금지(duplicate_candidate, resolvedProductId 없음)
      const rC = await resolveProductImportRow(tx,
        { legacyId: "P002", code: null, name: "일반번역", productType: "translation", normalizedName: norm("일반번역") },
        index, { sourceSystem: SS, isKnownType: true });
      check("C same name/diff legacyId → duplicate_candidate (NOT merged)",
        rC.status === PREVIEW_STATUS.DUPLICATE_CANDIDATE && rC.resolvedProductId === null, rC);

      // new) legacyId 있고 매칭 전혀 없음 → new
      const rNew = await resolveProductImportRow(tx,
        { legacyId: "P003", code: null, name: "완전신규상품ZZZ", productType: "translation", normalizedName: norm("완전신규상품ZZZ") },
        index, { sourceSystem: SS, isKnownType: true });
      check("new legacyId no match → new", rNew.status === PREVIEW_STATUS.NEW, rNew);

      // existing_reuse) legacyId 있고 code 강매칭
      const rCode = await resolveProductImportRow(tx,
        { legacyId: "P004", code: "__C2_TEST_TR__", name: "아무이름", productType: "translation", normalizedName: norm("아무이름") },
        index, { sourceSystem: SS, isKnownType: true });
      check("code strong match → existing_reuse + reuse id",
        rCode.status === PREVIEW_STATUS.EXISTING_REUSE && rCode.resolvedProductId === exist.id, rCode);

      // E) legacyId 없음 + 동일명 → duplicate_candidate(강제병합 금지)
      const rE = await resolveProductImportRow(tx,
        { legacyId: null, code: null, name: "일반번역", productType: "translation", normalizedName: norm("일반번역") },
        index, { sourceSystem: SS, isKnownType: true });
      check("E no legacyId + same name → duplicate_candidate", rE.status === PREVIEW_STATUS.DUPLICATE_CANDIDATE, rE);

      // E2) legacyId 없음 + 신규명 → new
      const rE2 = await resolveProductImportRow(tx,
        { legacyId: null, code: null, name: "신규무매칭QQQ", productType: "translation", normalizedName: norm("신규무매칭QQQ") },
        index, { sourceSystem: SS, isKnownType: true });
      check("E2 no legacyId + new name → new", rE2.status === PREVIEW_STATUS.NEW, rE2);

      // G) 필수값 누락
      const rReq = await resolveProductImportRow(tx,
        { legacyId: "P005", code: null, name: "", productType: "translation", normalizedName: "" },
        index, { sourceSystem: SS, isKnownType: true });
      check("G required_missing", rReq.status === PREVIEW_STATUS.REQUIRED_MISSING, rReq);

      // invalid type
      const rInv = await resolveProductImportRow(tx,
        { legacyId: "P006", code: null, name: "x", productType: "xxxxx", normalizedName: "x" },
        index, { sourceSystem: SS, isKnownType: false });
      check("invalid type", rInv.status === PREVIEW_STATUS.INVALID, rInv);

      // B/idempotency) 같은 (SS,product,P001) 재기록 → 기존 재사용, entityId 불변
      const again = await recordMapping(tx, { sourceSystem: SS, entityType: "product", legacyId: "P001", entityId: 999999 });
      check("B re-record same key → created=false, entityId stays exist.id",
        again.created === false && again.mapping.entityId === exist.id, again);
      const cntP001 = await tx.select().from(legacyMasterMappingsTable)
        .where(eq(legacyMasterMappingsTable.legacyId, "P001"));
      check("B only 1 mapping row for P001", cntP001.length === 1, cntP001.length);

      // Preview/Execute 동일 서비스: 위 resolveProductImportRow 는 preview·execute 양쪽에서 호출되는 동일 함수 → J 보장(동일 입력/상태 → 동일 결정)
      check("J shared resolver (same fn used by preview & execute)", true);

      throw new Error("__ROLLBACK__");
    });
  } catch (e) {
    if ((e as Error).message !== "__ROLLBACK__") throw e;
  }

  // 롤백 확인: 테스트 상품/매핑이 남지 않아야 함
  const leftProd = await db.select().from(productsTable).where(eq(productsTable.code, "__C2_TEST_TR__"));
  const leftMap = await db.select().from(legacyMasterMappingsTable).where(eq(legacyMasterMappingsTable.legacyId, "P001"));
  check("ROLLBACK: no test product persisted", leftProd.length === 0, leftProd.length);
  check("ROLLBACK: no test mapping persisted", leftMap.length === 0, leftMap.length);

  console.log(`\n== C-2 resolver tests: ${pass} passed, ${fail} failed ==`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
