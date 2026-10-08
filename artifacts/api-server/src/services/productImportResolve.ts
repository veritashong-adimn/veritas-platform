// ─── 상품(product) Import 공통 Resolution (C-2) ───────────────────────────────
// Preview 와 Execute 가 "이 행을 어떻게 처리할지"를 단 하나의 함수로 판단하게 한다(로직 복제 금지).
// 우선순위(§4):
//   1) legacy mapping (sourceSystem, 'product', legacyId) 존재 → legacy_match (기존 VERITAS product 재사용)
//   2) legacyId 있으나 mapping 없음 → code 강식별자 단일매칭 → existing_reuse / 복수·애매 → duplicate_candidate
//      (+ 이름 후보만 있으면 duplicate_candidate, 없으면 new)
//   3) legacyId 없음 → 기존 import 보조매칭(이름 후보 → duplicate_candidate, 없으면 new). 이름만으로 강제병합 금지.
// 실제 상품 생성/정규식 dedup(canonicalKey)은 기존 getOrCreateProduct 가 담당하고, 본 resolver 는 "결정"만 한다.
import { and, eq, isNull } from "drizzle-orm";
import { db, productsTable, legacyMasterMappingsTable } from "@workspace/db";
import { PREVIEW_STATUS, type PreviewStatus } from "./legacyMapping";

type Dbx = any;

// §2: 기존 CRM 원본 상품 ID 컬럼 alias(헤더명). 소문자/공백제거 비교.
//  · "상품코드"(C-3): 기존 CRM Excel 의 상품코드를 legacyId 로 사용(TEXT 원문 보존).
//    주의 — legacyId(원본 CRM 식별자)와 VERITAS products.code 는 별개 개념이며, 자동 덮어쓰기/병합하지 않는다.
export const PRODUCT_LEGACY_ID_ALIASES = [
  "legacyid", "legacy_id", "productid", "product_id", "기존상품id", "상품id", "원본상품id", "crmid", "crm_id",
  "상품코드",
];

/** 헤더 행에서 legacyId 컬럼 index 를 찾는다(없으면 -1). VERITAS 내부 products.id 와 혼동 방지: 반드시 alias 로만 인식. */
export function pickLegacyIdColumn(headerRow: (string | number | undefined)[]): number {
  for (let c = 0; c < headerRow.length; c++) {
    const key = String(headerRow[c] ?? "").trim().toLowerCase().replace(/\s+/g, "");
    if (PRODUCT_LEGACY_ID_ALIASES.includes(key)) return c;
  }
  return -1;
}

/** legacyId 원본 보존 normalize: 앞자리 0/하이픈/문자 유지. 숫자 변환 금지. 빈값 → null. */
export function normalizeLegacyId(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

export interface ProductResolveInput {
  legacyId: string | null;
  code?: string | null;          // Excel 원본 상품코드(있으면 강식별자 보조)
  name: string;
  productType: string;           // 이미 내부 코드로 normalize 된 값
  normalizedName: string;        // normalizeProdName 결과
}

export interface ProductExistingIndex {
  byCode: Map<string, { id: number; code: string; name: string }>;
  byName: Map<string, { id: number; code: string; name: string }[]>;
}

/** 활성 상품을 code/정규화명 인덱스로 적재(Preview/Execute 공통). */
export async function buildProductExistingIndex(dbx: Dbx, normalizeProdName: (s: string) => string): Promise<ProductExistingIndex> {
  const rows = await dbx.select({ id: productsTable.id, code: productsTable.code, name: productsTable.name })
    .from(productsTable).where(isNull(productsTable.deletedAt));
  const byCode = new Map<string, { id: number; code: string; name: string }>();
  const byName = new Map<string, { id: number; code: string; name: string }[]>();
  for (const r of rows as { id: number; code: string; name: string }[]) {
    if (r.code) byCode.set(r.code, r);
    const nk = normalizeProdName(r.name);
    const arr = byName.get(nk); if (arr) arr.push(r); else byName.set(nk, [r]);
  }
  return { byCode, byName };
}

export interface ProductResolveResult {
  status: PreviewStatus;              // new|legacy_match|existing_reuse|duplicate_candidate|needs_review|invalid|required_missing|unmatched
  resolvedProductId: number | null;   // 재사용 대상 VERITAS product id
  matchMethod: "legacy" | "strong" | "probable" | "duplicate_candidate" | "needs_review" | "unmatched";
  mappingExisted: boolean;            // 이미 legacy mapping 이 있었는가
  issues: string[];
}

/**
 * 한 상품 행의 처리 결정. DB 조회만 수행(쓰기 없음) → Preview/Execute 양쪽에서 동일하게 호출.
 */
export async function resolveProductImportRow(
  dbx: Dbx,
  input: ProductResolveInput,
  index: ProductExistingIndex,
  opts: { sourceSystem?: string | null; isKnownType: boolean },
): Promise<ProductResolveResult> {
  const issues: string[] = [];

  // 필수/유효성
  if (!input.name || input.name.trim().length === 0) {
    return { status: PREVIEW_STATUS.REQUIRED_MISSING, resolvedProductId: null, matchMethod: "unmatched", mappingExisted: false, issues: ["상품명 없음"] };
  }
  if (!opts.isKnownType) {
    return { status: PREVIEW_STATUS.INVALID, resolvedProductId: null, matchMethod: "unmatched", mappingExisted: false, issues: [`상품유형 인식 불가: '${input.productType}'`] };
  }

  const sourceSystem = opts.sourceSystem ?? null;

  // 1순위: legacy mapping
  if (sourceSystem && input.legacyId) {
    const [m] = await dbx.select().from(legacyMasterMappingsTable).where(and(
      eq(legacyMasterMappingsTable.sourceSystem, sourceSystem),
      eq(legacyMasterMappingsTable.entityType, "product"),
      eq(legacyMasterMappingsTable.legacyId, input.legacyId),
    )).limit(1);
    if (m) {
      if (m.status === "rolled_back") {
        return { status: PREVIEW_STATUS.NEEDS_REVIEW, resolvedProductId: m.entityId, matchMethod: "needs_review", mappingExisted: true, issues: ["이전에 회수(rolled_back)된 매핑 — 관리자 확인 필요"] };
      }
      return { status: PREVIEW_STATUS.LEGACY_MATCH, resolvedProductId: m.entityId, matchMethod: "legacy", mappingExisted: true, issues: [] };
    }

    // 2순위: legacyId 있으나 mapping 없음 → code 강식별자
    if (input.code) {
      const byCode = index.byCode.get(input.code);
      if (byCode) {
        return { status: PREVIEW_STATUS.EXISTING_REUSE, resolvedProductId: byCode.id, matchMethod: "strong", mappingExisted: false, issues: [`코드 일치 기존 상품: ${byCode.code}`] };
      }
    }
    // 이름 후보만 있으면 자동병합 금지 → duplicate_candidate
    const nameCands = index.byName.get(input.normalizedName) ?? [];
    if (nameCands.length > 0) {
      return { status: PREVIEW_STATUS.DUPLICATE_CANDIDATE, resolvedProductId: null, matchMethod: "duplicate_candidate", mappingExisted: false,
        issues: [`동일명 기존 상품 ${nameCands.length}건 — 자동 병합 안 함(검토)`] };
    }
    // 신규 후보(legacyId 보유 → 생성 후 mapping 기록)
    return { status: PREVIEW_STATUS.NEW, resolvedProductId: null, matchMethod: "legacy", mappingExisted: false, issues };
  }

  // 3순위: legacyId 없음 — 이름 후보는 경고만(강제병합 금지). 실제 생성/정규식 dedup 은 getOrCreateProduct 가 결정.
  const nameCands = index.byName.get(input.normalizedName) ?? [];
  if (nameCands.length > 0) {
    issues.push(`동일명 기존 상품 ${nameCands.length}건`);
    return { status: PREVIEW_STATUS.DUPLICATE_CANDIDATE, resolvedProductId: null, matchMethod: "duplicate_candidate", mappingExisted: false, issues };
  }
  return { status: PREVIEW_STATUS.NEW, resolvedProductId: null, matchMethod: "unmatched", mappingExisted: false, issues };
}
