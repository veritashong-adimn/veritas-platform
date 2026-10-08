// C-3 Pilot 20건 runner — 실제 endpoint 와 동일한 함수(resolveProductImportRow / getOrCreateProduct /
// recordMapping / import_batches·import_row_sources)를 사용. mode=preview(쓰기없음) | execute(생성).
import fs from "node:fs";
import { db, productsTable, legacyMasterMappingsTable, importBatchesTable, importRowSourcesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateProduct, createLegacyImportedProduct, normalizeProdName, PRODUCT_TYPES, UNITS_BY_TYPE } from "./routes/products";
import { buildProductExistingIndex, resolveProductImportRow, normalizeLegacyId } from "./services/productImportResolve";
import { recordMapping, resolveByLegacy, legacyRowKey, PREVIEW_STATUS } from "./services/legacyMapping";

const SS = "old_crm";
const CAT_MAP: Record<string, string> = { "번역": "translation", "통역": "interpretation", "통역장비": "equipment" };

// 대표 20건(상품코드). 원문 행(이름/구분/단위/단가)은 파일에서 직접 로드.
const PILOT_CODES = [
  "1-84","1-21","2-38","2-2","3-4","3-5","0-81","2-002","10-04","영어일본어순차통역","2-175","2-666", // CREATE 기대
  "0-88","2-115",                                                                                   // duplicate_candidate 기대
  "701","3","센터수수료","1-555","1-017","1-1",                                                      // invalid 기대
];

function loadRows() {
  const raw = fs.readFileSync("/tmp/c3_products.txt", "utf8").replace(/\r/g, "");
  const map = new Map<string, any>();
  raw.split("\n").filter(Boolean).forEach((l, i) => {
    const f = l.split("\t");
    const code = (f[0] ?? "").trim();
    if (!map.has(code)) map.set(code, { srcRow: i + 1, code, name: (f[1] ?? "").trim(), cat: (f[2] ?? "").trim(), spec: (f[3] ?? "").trim(), unit: (f[4] ?? "").trim(), price: (f[5] ?? "").trim() });
  });
  return PILOT_CODES.map(c => map.get(c));
}

function mapUnit(pType: string, unit: string): string {
  const valid = (UNITS_BY_TYPE as any)[pType] ?? ["건"];
  return unit && valid.includes(unit) ? unit : valid[0];
}
function parsePrice(p: string): number | null {
  const s = (p ?? "").replace(/,/g, "").trim();  // 쉼표 제거
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const mode = process.argv[2] === "execute" ? "execute" : "preview";
  const rows = loadRows();
  const index = await buildProductExistingIndex(db, normalizeProdName);

  let batchId: number | null = null;
  if (mode === "execute") {
    const [b] = await db.insert(importBatchesTable).values({
      module: "product", importType: "legacy_migration", originalFilename: "C3_PILOT_20", sheetName: null,
      totalRows: rows.length, status: "analyzed", createdBy: null, sourceSystem: SS,
    }).returning({ id: importBatchesTable.id });
    batchId = b.id;
  }

  const stat = { create: 0, legacyMatch: 0, existingReuse: 0, dupCand: 0, invalid: 0, reqMissing: 0, needsReview: 0 };
  console.log(`\n=== C-3 Pilot ${mode.toUpperCase()} (${rows.length}건, sourceSystem=${SS}) ===`);
  console.log("row\tlegacyId\t보존\t유형(CRM→VERITAS)\tstatus\t동작\t단위\t단가\t상품명");

  for (const r of rows) {
    const legacyId = normalizeLegacyId(r.code);
    const pType = CAT_MAP[r.cat] ?? "";           // 매핑 불가(빈값/상품/컨벤션) → "" → invalid
    const isKnownType = !!(PRODUCT_TYPES as any)[pType];
    const decision = await resolveProductImportRow(db,
      { legacyId, code: null, name: r.name, productType: pType, normalizedName: normalizeProdName(r.name) },
      index, { sourceSystem: SS, isKnownType });

    const unit = isKnownType ? mapUnit(pType, r.unit) : r.unit;
    const price = parsePrice(r.price);
    const preserved = legacyId === r.code ? "OK" : `CHANGED(${r.code}->${legacyId})`;
    let action = "SKIP";
    let entityId: number | null = decision.resolvedProductId ?? null;

    if (decision.status === PREVIEW_STATUS.LEGACY_MATCH) { stat.legacyMatch++; action = "REUSE(legacy)"; }
    else if (decision.status === PREVIEW_STATUS.EXISTING_REUSE) { stat.existingReuse++; action = "REUSE(code)"; }
    else if (decision.status === PREVIEW_STATUS.DUPLICATE_CANDIDATE) { stat.dupCand++; action = "SKIP(dup_candidate)"; }
    else if (decision.status === PREVIEW_STATUS.INVALID) { stat.invalid++; action = "SKIP(invalid)"; }
    else if (decision.status === PREVIEW_STATUS.REQUIRED_MISSING) { stat.reqMissing++; action = "SKIP(required_missing)"; }
    else if (decision.status === PREVIEW_STATUS.NEEDS_REVIEW) { stat.needsReview++; action = "SKIP(needs_review)"; }
    else if (decision.status === PREVIEW_STATUS.NEW) {
      stat.create++; action = "CREATE";
      if (mode === "execute") {
        // C-3 FIX: legacy 전용 생성(legacyId 당 독립 Product). 유형-only 병합 회피.
        const made = await createLegacyImportedProduct(db, {
          sourceSystem: SS, legacyId: legacyId!, productType: pType, name: r.name, unit,
          basePrice: price, mainCategory: null,
        });
        entityId = made.product?.id ?? null;
      }
    }

    // execute: lineage + mapping 기록(legacyId 있고 entityId 확보된 생성/재사용행)
    if (mode === "execute" && batchId) {
      await db.insert(importRowSourcesTable).values({
        batchId, module: "product", entityId,
        sourceFile: "C3_PILOT_20", sourceRow: r.srcRow,
        rowKey: legacyId ? legacyRowKey({ sourceSystem: SS, entityType: "product", legacyId }) : null,
        status: decision.status, sourceSystem: SS, legacyId,
        sourceRaw: { 상품코드: r.code, 상품명: r.name, 상품구분: r.cat, 규격: r.spec, 단위: r.unit, 단가: r.price },
      });
      if (legacyId && entityId != null && (decision.status === PREVIEW_STATUS.NEW || decision.status === PREVIEW_STATUS.EXISTING_REUSE)) {
        await recordMapping(db, { sourceSystem: SS, entityType: "product", legacyId, entityId, importBatchId: batchId, sourceRow: r.srcRow, matchMethod: "legacy" });
      }
    }

    console.log(`${r.srcRow}\t${legacyId}\t${preserved}\t${r.cat || "(빈값)"}→${pType || "(미매핑)"}\t${decision.status}\t${action}\t${isKnownType ? unit : "-"}\t${price ?? "-"}\t${r.name}`);
  }

  console.log("\n집계:", JSON.stringify(stat));
  console.log(`CREATE=${stat.create}  duplicate_candidate=${stat.dupCand}  invalid=${stat.invalid}  legacy_match=${stat.legacyMatch}  existing_reuse=${stat.existingReuse}  needs_review=${stat.needsReview}  required_missing=${stat.reqMissing}`);
  if (mode === "execute") console.log("batchId:", batchId);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
