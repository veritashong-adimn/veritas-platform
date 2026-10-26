// ─── 공통 Legacy Mapping Service (C-1) ───────────────────────────────────────
// 원본 CRM Master ID ↔ VERITAS Master ID 의 영구 추적·멱등 해석을 담당한다.
// 논리키 = (sourceSystem, entityType, legacyId). legacyId 는 원본 그대로(TEXT).
//   · resolveByLegacy        : 기존 매핑 조회(없으면 null)
//   · recordMapping          : 신규 매핑 1건 기록(이미 있으면 기존 반환 — 멱등)
//   · resolveOrCreateMapping : 조회 → 없으면 createEntity() 콜백으로 Master 생성 후 매핑(멱등 보장)
//   · getMappingsForEntity   : 특정 Master 로 들어온 원본 legacy 목록(Merge 후 역추적)
//   · markMappingRolledBack  : rollback 시 매핑 삭제 대신 status 전이(출처 추적 유지)
// 이름/사업자번호/이메일/전화/파일명은 legacy identity 의 최종 식별자로 쓰지 않는다.
// legacyId/PII 를 로그에 평문으로 남기지 않는다(호출부 로깅 주의).
import { and, eq, sql } from "drizzle-orm";
import { db, legacyMasterMappingsTable } from "@workspace/db";

type Dbx = any; // db 또는 tx (services 의 `type Db = any` 관례)

export type LegacyEntityType =
  | "company" | "division" | "contact" | "product" | "translator" | "vendor_profile" | "sale";

export type LegacyMatchMethod =
  | "legacy" | "strong" | "probable" | "duplicate_candidate" | "needs_review" | "unmatched";

// entityType → 대상 Master 테이블(application 레벨 polymorphic 검증용)
export const LEGACY_ENTITY_TARGET: Record<LegacyEntityType, string> = {
  company: "companies.id",
  division: "divisions.id",
  contact: "contacts.id",
  product: "products.id",
  translator: "users.id(role=translator)",
  vendor_profile: "companies.id",
  sale: "projects.id(과거 CRM 판매번호 → 운영 판매건)",
};

export interface LegacyKey {
  sourceSystem: string;
  entityType: LegacyEntityType;
  legacyId: string;
}

// legacyId 가 있는 Master import 의 표준 rowKey. 이름/biz 기반이 아니라 legacy 기반.
export function legacyRowKey(k: LegacyKey): string {
  return `${k.entityType}|${k.sourceSystem}|legacy|${k.legacyId}`;
}

function validKey(k: Partial<LegacyKey>): k is LegacyKey {
  return !!(k.sourceSystem && k.entityType && k.legacyId != null && String(k.legacyId).length > 0);
}

/** (sourceSystem, entityType, legacyId) 로 기존 매핑 조회. active 매핑 우선. */
export async function resolveByLegacy(dbx: Dbx, k: LegacyKey) {
  const rows = await dbx.select().from(legacyMasterMappingsTable)
    .where(and(
      eq(legacyMasterMappingsTable.sourceSystem, k.sourceSystem),
      eq(legacyMasterMappingsTable.entityType, k.entityType),
      eq(legacyMasterMappingsTable.legacyId, String(k.legacyId)),
    ))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 매핑 1건 기록(멱등). 동일 논리키가 이미 있으면 기존 레코드를 반환하고 신규 생성하지 않는다.
 * UNIQUE(sourceSystem, entityType, legacyId) 로 DB 레벨 중복도 방지.
 */
export async function recordMapping(dbx: Dbx, params: LegacyKey & {
  entityId: number;
  importBatchId?: number | null;
  sourceRow?: number | null;
  matchMethod?: LegacyMatchMethod;
  createdBy?: number | null;
}) {
  if (!validKey(params)) throw new Error("recordMapping: invalid legacy key");
  const existing = await resolveByLegacy(dbx, params);
  if (existing) return { mapping: existing, created: false };

  // 동시성/재실행 안전: 충돌 시 무시하고 재조회(멱등).
  const inserted = await dbx.insert(legacyMasterMappingsTable).values({
    sourceSystem: params.sourceSystem,
    entityType: params.entityType,
    legacyId: String(params.legacyId),
    entityId: params.entityId,
    importBatchId: params.importBatchId ?? null,
    sourceRow: params.sourceRow ?? null,
    matchMethod: params.matchMethod ?? "legacy",
    createdBy: params.createdBy ?? null,
  }).onConflictDoNothing({
    target: [legacyMasterMappingsTable.sourceSystem, legacyMasterMappingsTable.entityType, legacyMasterMappingsTable.legacyId],
  }).returning();

  if (inserted[0]) return { mapping: inserted[0], created: true };
  // onConflict 로 비어있으면 동시 삽입 → 재조회
  const again = await resolveByLegacy(dbx, params);
  return { mapping: again!, created: false };
}

/**
 * 멱등 해석 + 생성. 매핑이 있으면 기존 entityId 재사용(신규 Master 생성 금지).
 * 없으면 createEntity() 로 Master 를 만들고 매핑을 남긴다. createEntity 는 생성된 Master id 를 반환.
 */
export async function resolveOrCreateMapping(dbx: Dbx, k: LegacyKey, opts: {
  createEntity: () => Promise<number>;
  importBatchId?: number | null;
  sourceRow?: number | null;
  matchMethod?: LegacyMatchMethod;
  createdBy?: number | null;
}): Promise<{ entityId: number; created: boolean; mapping: any }> {
  const existing = await resolveByLegacy(dbx, k);
  if (existing) return { entityId: existing.entityId, created: false, mapping: existing };
  const newEntityId = await opts.createEntity();
  const { mapping } = await recordMapping(dbx, {
    ...k, entityId: newEntityId,
    importBatchId: opts.importBatchId, sourceRow: opts.sourceRow,
    matchMethod: opts.matchMethod ?? "legacy", createdBy: opts.createdBy,
  });
  return { entityId: mapping.entityId, created: true, mapping };
}

/** 특정 Master(entityType, entityId)로 들어온 원본 legacy 매핑 목록(Merge 후 여러 legacyId → 한 master 역추적). */
export async function getMappingsForEntity(dbx: Dbx, entityType: LegacyEntityType, entityId: number) {
  return dbx.select().from(legacyMasterMappingsTable)
    .where(and(
      eq(legacyMasterMappingsTable.entityType, entityType),
      eq(legacyMasterMappingsTable.entityId, entityId),
    ));
}

/** rollback 시 매핑을 삭제하지 않고 status 전이(출처 추적 영구 보존). 특정 batch 범위로 한정 가능. */
export async function markMappingRolledBack(dbx: Dbx, opts: { importBatchId: number }) {
  return dbx.update(legacyMasterMappingsTable)
    .set({ status: "rolled_back" })
    .where(and(
      eq(legacyMasterMappingsTable.importBatchId, opts.importBatchId),
      eq(legacyMasterMappingsTable.status, "active"),
    ))
    .returning({ id: legacyMasterMappingsTable.id, entityId: legacyMasterMappingsTable.entityId, entityType: legacyMasterMappingsTable.entityType });
}

// 재-import 시 rolled_back 매핑 정책:
//  · resolveByLegacy 는 status 무관하게 "원본 identity 가 이미 어떤 Master 로 연결됐었는지"를 반환한다.
//  · 호출부(importer)는 mapping.status === 'rolled_back' 이면 "이전에 회수된 매핑"으로 보고
//    Preview 에서 needs_review(관리자 확인) 로 노출한다. 자동 재사용/자동 신규생성 모두 하지 않는다.
export function isRolledBack(mapping: { status?: string } | null): boolean {
  return !!mapping && mapping.status === "rolled_back";
}

// Preview 표준 상태(이름 기반보다 legacy_match 우선). 자동 병합 금지.
export const PREVIEW_STATUS = {
  NEW: "new",
  LEGACY_MATCH: "legacy_match",
  EXISTING_REUSE: "existing_reuse",
  DUPLICATE_CANDIDATE: "duplicate_candidate",
  NEEDS_REVIEW: "needs_review",
  UNMATCHED: "unmatched",
  INVALID: "invalid",
  REQUIRED_MISSING: "required_missing",
  BUSINESS_NUMBER_CONFLICT: "business_number_conflict",
} as const;
export type PreviewStatus = typeof PREVIEW_STATUS[keyof typeof PREVIEW_STATUS];

// db 재노출(호출부가 tx 없이 쓸 때)
export { db as legacyMappingDb };
