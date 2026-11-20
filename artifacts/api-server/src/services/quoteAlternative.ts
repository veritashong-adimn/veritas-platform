// ─── 복수견적(대안 견적안) — A안/B안/C안 … 중 고객이 선택한 1개만 판매전환 ─────────────────
//  · 저장 구조: quotes.quote_group_id = 그룹 기준 견적(A안) id. 각 견적안은 '독립 원견적'(relation_type NULL,
//    root_quote_id NULL)이다 → 변경견적(R1…)·현재유효·매출(SSOT)·판매취소 로직을 그대로 재사용한다.
//  · 번호: 기준 견적번호 + '-P{n}' (Q000094-P1, -P2 …). 변경견적 -R / 추가 -A / 분할 -01 과 겹치지 않는다.
//    견적안의 변경견적은 그 견적안 번호 기준(Q000094-P1-R1).
//  · 생성: 기준 견적의 현재유효 견적을 복사(업무필드 + 품목 + 작성용 project). 원본·판매 데이터는 변경하지 않는다.
//  · 판매 배타성: 그룹 안에서 판매확정(approved) 견적이 있는 견적안(family)은 1개만 — 판매전환·변경견적 승인 경로에서 검증.
//    다른 견적안으로 바꾸려면 기존 판매취소(정산·금융 보호 규칙 그대로) 후 다른 안을 판매전환한다.
import { eq, sql } from "drizzle-orm";
import { quotesTable, quoteItemsTable, projectsTable } from "@workspace/db";
import { getQuoteFamily, resolveChainCurrent, isRelationEngineQuoteType } from "./quoteRelation";
import { remapClonedParentLinks } from "./quoteItemGroup";
import { todayKst } from "../lib/legacyPayoutRule";

type Db = any;
export type Result = { http: number; body: Record<string, unknown> };

// 견적이 속한 family root(원견적/견적안) 행
async function rootOf(dbh: Db, quoteId: number): Promise<any | null> {
  const [q] = await dbh.select({ id: quotesTable.id, rootQuoteId: quotesTable.rootQuoteId }).from(quotesTable).where(eq(quotesTable.id, quoteId));
  if (!q) return null;
  const [root] = await dbh.select().from(quotesTable).where(eq(quotesTable.id, q.rootQuoteId ?? q.id));
  return root ?? null;
}

// 화면 표시용 견적안 라벨: 0→A안, 1→B안 … 25→Z안, 26→AA안
export function alternativeLabel(index: number): string {
  let n = index, s = "";
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `${s}안`;
}

// ── 그룹 내 판매 배타성 검사 ──────────────────────────────────────────────────────
//  quoteId 가 속한 견적안을 제외한 같은 그룹의 다른 견적안 family 중 판매확정(approved, 미삭제) 견적이 있으면 반환.
//  tx 안에서 호출하면 그룹 기준 견적 행을 FOR UPDATE 로 잠가 동시 판매전환을 직렬화한다.
export async function findGroupSaleConflict(dbh: Db, quoteId: number, opts: { lock?: boolean } = {}): Promise<{ quoteId: number; quoteNumber: string | null; projectId: number | null } | null> {
  const root = await rootOf(dbh, quoteId);
  if (!root || root.quoteGroupId == null) return null;
  const groupId: number = root.quoteGroupId;
  if (opts.lock) await dbh.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, groupId)).for("update");
  const rows = (await dbh.execute(sql`
    SELECT q.id, q.quote_number, q.project_id
      FROM quotes q
      JOIN quotes r ON r.id = COALESCE(q.root_quote_id, q.id)
     WHERE r.quote_group_id = ${groupId} AND r.id <> ${root.id}
       AND q.status = 'approved' AND q.deleted_at IS NULL AND r.deleted_at IS NULL
     ORDER BY q.id LIMIT 1`)).rows as any[];
  const c = rows[0];
  return c ? { quoteId: c.id, quoteNumber: c.quote_number, projectId: c.project_id } : null;
}

export function groupConflictMessage(c: { quoteNumber: string | null }): string {
  return `같은 복수견적 그룹의 다른 견적안(${c.quoteNumber ?? "-"})이 이미 판매확정 상태입니다. 고객이 견적안을 바꾼 경우 기존 판매를 판매취소한 뒤 이 견적안을 판매전환해 주세요.`;
}

// ── 복수견적 그룹 조회(목록·상세 표시용) ─────────────────────────────────────────
//  각 견적안: root(견적안 원견적) + 그 체인의 현재유효 견적 + 판매확정 여부.
export async function getAlternativeGroup(dbh: Db, quoteId: number): Promise<{ groupId: number | null; members: any[] }> {
  const root = await rootOf(dbh, quoteId);
  if (!root || root.quoteGroupId == null) return { groupId: null, members: [] };
  const roots = await dbh.select().from(quotesTable)
    .where(sql`${quotesTable.quoteGroupId} = ${root.quoteGroupId} AND ${quotesTable.rootQuoteId} IS NULL AND ${quotesTable.deletedAt} IS NULL`)
    .orderBy(quotesTable.id);
  // 기준(A안) 먼저, 그 뒤 생성 순
  roots.sort((a: any, b: any) => (a.id === root.quoteGroupId ? -1 : b.id === root.quoteGroupId ? 1 : a.id - b.id));
  const members = [];
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    const family = await getQuoteFamily(dbh, r.id);
    const { current } = resolveChainCurrent(family);
    const sold = family.find((q: any) => q.status === "approved" && q.relationType !== "derived" && (q.isCurrent || q.id === current?.id)) ?? null;
    members.push({
      rootId: r.id, rootQuoteNumber: r.quoteNumber, label: alternativeLabel(i), isAnchor: r.id === root.quoteGroupId,
      currentId: current?.id ?? r.id, currentQuoteNumber: current?.quoteNumber ?? r.quoteNumber,
      currentStatus: current?.status ?? r.status, price: Number(current?.price ?? r.price ?? 0),
      title: current?.title ?? r.title, sold: sold != null, projectId: current?.projectId ?? r.projectId,
      hasRevision: family.some((q: any) => q.relationType === "revision"),
    });
  }
  return { groupId: root.quoteGroupId, members };
}

// ── 복수견적 생성 ────────────────────────────────────────────────────────────────
//  sourceQuoteId 는 견적안 체인의 '현재유효' 견적이어야 한다(과거본·거절본·승인대기 변경견적·분할견적 불가).
//  원본 견적·판매·청구 데이터는 일절 변경하지 않는다(기준 견적의 quote_group_id 최초 설정만 예외 — 그룹 표시용 메타).
export async function createAlternative(
  tx: Db, sourceQuoteId: number, opts: { reason?: string | null; userId?: number } = {},
): Promise<Result> {
  const [src] = await tx.select().from(quotesTable).where(eq(quotesTable.id, sourceQuoteId));
  if (!src) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (!isRelationEngineQuoteType(src.quoteType)) return { http: 400, body: { error: "일반견적(b2b_standard)만 복수견적을 생성할 수 있습니다." } };
  if (src.deletedAt != null) return { http: 400, body: { error: "삭제된 견적입니다." } };
  if (src.relationType != null && src.relationType !== "revision") {
    return { http: 400, body: { error: "분할/추가 견적에서는 복수견적을 생성할 수 없습니다. 현재 유효견적에서 생성해 주세요." } };
  }
  const familyRootId: number = src.rootQuoteId ?? src.id;
  const family = await getQuoteFamily(tx, familyRootId);
  const { current } = resolveChainCurrent(family);
  if (!current || current.id !== src.id || (src.relationType === "revision" && src.status === "pending")) {
    return { http: 409, body: {
      error: `현재 유효견적이 아닙니다. 복수견적은 현재 유효견적${current?.quoteNumber ? `(${current.quoteNumber})` : ""}에서 생성해 주세요.`,
      currentQuoteId: current?.id ?? null,
    } };
  }

  const [familyRoot] = await tx.select().from(quotesTable).where(eq(quotesTable.id, familyRootId));
  const groupId: number = familyRoot.quoteGroupId ?? familyRoot.id;
  // 그룹 기준 행 잠금 — 동시 생성 시 번호 중복 방지
  const [anchor] = await tx.select().from(quotesTable).where(eq(quotesTable.id, groupId)).for("update");
  if (!anchor) return { http: 404, body: { error: "복수견적 기준 견적을 찾을 수 없습니다." } };
  if (familyRoot.quoteGroupId == null) {
    await tx.update(quotesTable).set({ quoteGroupId: groupId }).where(eq(quotesTable.id, familyRoot.id));
  }

  // 번호: 기준번호-P{n} — 현존(휴지통 포함)·영구삭제 로그의 최대 번호 + 1 (재사용 금지)
  const base: string = anchor.quoteNumber ?? `Q${String(anchor.id).padStart(6, "0")}`;
  const prefix = `${base}-P`;
  const maxRow = (await tx.execute(sql`
    SELECT COALESCE(MAX(substring(num FROM ${prefix.length + 1}::int)::int), 0)::int AS mx FROM (
      SELECT quote_number AS num FROM quotes WHERE left(quote_number, ${prefix.length}::int) = ${prefix}
      UNION ALL
      SELECT substring(metadata FROM '"quoteNumber":"([^"]*)"') FROM logs WHERE entity_type = 'quote' AND action = 'quote_purged'
    ) t
    WHERE left(num, ${prefix.length}::int) = ${prefix} AND substring(num FROM ${prefix.length + 1}::int) ~ '^[0-9]{1,6}$'`)).rows[0] as { mx: number } | undefined;
  const quoteNumber = `${prefix}${Number(maxRow?.mx ?? 0) + 1}`;

  // 업무필드 복사 — 식별·관계·판매·삭제·유형전용(차감/누적) 필드 제외. 새 견적안은 독립 원견적·대기·현재유효.
  const {
    id: _id, quoteNumber: _qn, projectId: _pid, status: _st, createdAt: _ca,
    version: _v, isCurrent: _ic, versionReason: _vr, parentVersionId: _pv, rootQuoteId: _rq, relationType: _rt,
    deletedAt: _da, deletedBy: _db, deletionReason: _dr, batchClosedAt: _bc, batchPeriodStart: _bs, batchPeriodEnd: _be, batchItemCount: _bi,
    prepaidBalanceBefore: _pb, prepaidUsageAmount: _pu, prepaidBalanceAfter: _pa,
    derivedCompanyId: _dc, derivedContactId: _dct, derivedCompanyNameSnapshot: _dcs, derivedContactNameSnapshot: _dcts,
    quoteGroupId: _g,
    ...business
  } = src as any;
  void [_bs, _be, _bi, _id, _qn, _pid, _st, _ca, _v, _ic, _vr, _pv, _rq, _rt, _da, _db, _dr, _bc, _pb, _pu, _pa, _dc, _dct, _dcs, _dcts, _g];
  const [alt] = await tx.insert(quotesTable).values({
    ...business,
    issueDate: todayKst(),   // 새로 발행하는 견적안 — 발행일은 생성일(KST)
    status: "pending", isCurrent: true, version: 1, projectId: null,
    rootQuoteId: null, relationType: null, parentVersionId: null,
    versionReason: opts.reason ?? null,
    quoteGroupId: groupId, quoteNumber,
  }).returning();

  // 품목 별도 row 로 복사(원본과 공유 금지) + 서비스 그룹 parent 재매핑
  const items = await tx.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, src.id)).orderBy(quoteItemsTable.id);
  if (items.length > 0) {
    const newRows = await tx.insert(quoteItemsTable).values(items.map((it: any) => {
      const { id, quoteId, createdAt, ...rest } = it; void id; void quoteId; void createdAt;
      return { ...rest, quoteId: alt.id, parentItemId: null };
    })).returning({ id: quoteItemsTable.id });
    await remapClonedParentLinks(tx, items as any, newRows.map((r: any) => r.id));
  }

  // 작성용 project(판매 아님) — 거래처·담당자·PM 승계. 이 견적안이 선택(판매전환)되면 이 project 가 판매건이 된다.
  let altProjectId: number | null = null;
  if (src.projectId != null) {
    const [sp] = await tx.select().from(projectsTable).where(eq(projectsTable.id, src.projectId));
    if (sp) {
      const [np] = await tx.insert(projectsTable).values({
        userId: opts.userId ?? sp.userId, adminId: sp.adminId,
        companyId: sp.companyId, contactId: sp.contactId, customerId: sp.customerId, customerUserId: sp.customerUserId,
        requestingCompanyId: sp.requestingCompanyId, requestingDivisionId: sp.requestingDivisionId,
        billingCompanyId: sp.billingCompanyId, billingDivisionId: sp.billingDivisionId,
        payerCompanyId: sp.payerCompanyId, payerDivisionId: sp.payerDivisionId,
        title: alt.title?.trim() || `견적 #${alt.id}`,
        status: "created",
      }).returning({ id: projectsTable.id });
      altProjectId = np.id;
      await tx.update(quotesTable).set({ projectId: altProjectId }).where(eq(quotesTable.id, alt.id));
    }
  }

  return { http: 200, body: { id: alt.id, quoteNumber, quoteGroupId: groupId, sourceQuoteId: src.id, projectId: altProjectId } };
}
