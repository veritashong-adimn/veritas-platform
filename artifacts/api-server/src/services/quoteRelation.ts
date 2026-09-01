// ─── 견적 관계 엔진 (STEP 1: 관계 기반 + 매출 SSOT 안전장치) ────────────────────
// 목적: 변경(revision)/추가(additional)/파생(derived) 견적을 안전하게 만들 수 있는 '기반'만 구축한다.
//  · 이 STEP 에서는 실제 관계견적을 생성하지 않는다(번호 계산/조회/매출규칙 helper 제공).
//  · 적용 대상은 일반견적(b2b_standard)뿐. 누적(accumulated_batch)·차감(b2c_prepaid/prepaid_deduction) 제외.
//  · 기존 필드 재사용: parent_version_id(직전 부모) · version(리비전 순서) · is_current(유효본).
//    신규 필드: root_quote_id(family root) · relation_type.
import { eq, ne, or, isNull, sql } from "drizzle-orm";
import { quotesTable } from "@workspace/db";

type Db = any;

// ── relation_type ────────────────────────────────────────────────────────────
export const RELATION_TYPES = ["revision", "additional", "derived"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
// NULL = 원견적. 그 외 유효값만 허용(잘못된 값 거부용).
export function isValidRelationType(t: unknown): t is RelationType {
  return typeof t === "string" && (RELATION_TYPES as readonly string[]).includes(t);
}
// 관계 엔진 적용 대상 견적유형(일반견적만). 누적/차감은 제외.
export function isRelationEngineQuoteType(t: string | null | undefined): boolean {
  return t === "b2b_standard";
}

// ── family root ──────────────────────────────────────────────────────────────
// 원견적은 root_quote_id=NULL 이므로 자기 자신이 root. 관계견적은 root_quote_id 가 root.
export function familyRootId(q: { id: number; rootQuoteId: number | null }): number {
  return q.rootQuoteId ?? q.id;
}

// ── 매출/유효본 SSOT 조건 (여러 화면이 동일 규칙을 공유) ─────────────────────────
// 유효 견적(화면 대표 견적): is_current=true, 미삭제, 파생 아님(파생은 대표 견적이 아님).
export function effectiveQuoteConditions() {
  return [
    eq(quotesTable.isCurrent, true),
    isNull(quotesTable.deletedAt),
    or(isNull(quotesTable.relationType), ne(quotesTable.relationType, "derived")),
  ];
}
// 견적 기준 매출 집계: 위 조건 + 판매전환(approved). revision 이전본(is_current=false) 자동 제외,
//  additional 은 is_current=true 라 합산에 포함(원견적을 대체하지 않고 더해짐), derived 는 제외(별도 정책 전까지).
export function effectiveRevenueConditions() {
  return [eq(quotesTable.status, "approved"), ...effectiveQuoteConditions()];
}
// customers.ts 등 raw SQL 에서 동일 규칙을 쓰기 위한 SQL 조각(테이블 별칭 q 기준).
//  견적 엔진 도입 시 revision/derived 이중집계를 막는 공통 술어.
export const EFFECTIVE_REVENUE_SQL = sql`q.status = 'approved' AND q.is_current = true AND q.deleted_at IS NULL AND (q.relation_type IS NULL OR q.relation_type <> 'derived')`;

// ── family 조회 ───────────────────────────────────────────────────────────────
// root 기준 전체 family(원견적 + revision + additional + derived)를 관계·버전 순으로 반환.
export async function getQuoteFamily(dbh: Db, rootOrQuoteId: number): Promise<any[]> {
  return dbh
    .select()
    .from(quotesTable)
    .where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootOrQuoteId} AND ${quotesTable.deletedAt} IS NULL`)
    .orderBy(quotesTable.version, quotesTable.id);
}

// 리비전 체인의 현재 유효본(원견적/변경 계열 중 is_current=true, 파생/추가 제외).
export function getCurrentRevision(family: any[]): any | null {
  const chain = family.filter(q => q.relationType == null || q.relationType === "revision");
  return chain.find(q => q.isCurrent) ?? null;
}

// ── 관계견적 번호 생성 (동시성 안전) ──────────────────────────────────────────
// COUNT(*)+1 단순계산이 아니라, root 행을 FOR UPDATE 로 잠근 뒤 family 내 같은 relation 개수로 산출한다.
//  → 동일 family 동시 생성 시 직렬화되어 R1/R1, A1/A1, -01/-01 중복이 발생하지 않는다.
//  반드시 트랜잭션(tx) 안에서 호출. (STEP 1: 계산 helper 제공 — 실제 견적 INSERT 는 하지 않음)
export async function generateRelationQuoteNumber(
  tx: Db,
  rootQuoteId: number,
  relationType: RelationType,
): Promise<string> {
  // root 행 잠금(직렬화 기준점)
  const [root] = await tx
    .select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber })
    .from(quotesTable)
    .where(eq(quotesTable.id, rootQuoteId))
    .for("update");
  if (!root) throw new Error(`root quote ${rootQuoteId} not found`);
  const base = root.quoteNumber ?? `Q${String(rootQuoteId).padStart(6, "0")}`;

  // family 내 동일 relation 개수(삭제 포함 — 번호 재사용 방지)
  const [{ cnt } = { cnt: 0 }] = await tx
    .select({ cnt: sql<number>`count(*)::int` })
    .from(quotesTable)
    .where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootQuoteId} AND ${quotesTable.relationType} = ${relationType}`);
  const index = Number(cnt ?? 0) + 1;

  switch (relationType) {
    case "revision":   return `${base}-R${index}`;
    case "additional": return `${base}-A${index}`;
    case "derived":    return `${base}-${String(index).padStart(2, "0")}`;
  }
}

// ── family 매출 계산(SSOT 규칙 순수 함수) ──────────────────────────────────────
// revision: 현재 유효본 1개만 / additional: 유효(approved,is_current) 건 합산 / derived: 단순합산 제외(0).
// 반환: { effectiveRevenue, currentRevisionAmount, additionalTotal, derivedExcludedTotal }
export function calculateFamilyRevenue(family: any[]): {
  effectiveRevenue: number;
  currentRevisionAmount: number;
  additionalTotal: number;
  derivedExcludedTotal: number;
} {
  const live = (q: any) => q.status === "approved" && q.isCurrent === true && q.deletedAt == null;
  const cur = family.find(q => (q.relationType == null || q.relationType === "revision") && live(q));
  const currentRevisionAmount = cur ? Number(cur.price) : 0;
  const additionalTotal = family
    .filter(q => q.relationType === "additional" && live(q))
    .reduce((s, q) => s + Number(q.price), 0);
  const derivedExcludedTotal = family
    .filter(q => q.relationType === "derived")
    .reduce((s, q) => s + Number(q.price), 0);
  return {
    currentRevisionAmount,
    additionalTotal,
    derivedExcludedTotal,
    effectiveRevenue: currentRevisionAmount + additionalTotal, // derived 는 별도 정책 전까지 제외
  };
}
