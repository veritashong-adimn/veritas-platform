// ─── 변경견적(Revision) workflow (견적 엔진 STEP 2) ────────────────────────────
// 원견적을 overwrite 하지 않고 새 quote(relation_type='revision')를 생성한다.
//  · 생성: 원견적 업무필드 + quote_items 복제, status=pending, is_current=false(아직 유효본 아님).
//  · 승인: 트랜잭션에서 이전 유효본 is_current=false, 이 revision is_current=true+approved,
//          판매전환된 family면 기존 project 재사용(신규 판매/매출 이중집계 없음), 미전환이면 project 생성.
//  · 거절: status=rejected, is_current=false, 이전 유효본 유지.
//  · 적용 대상: b2b_standard 만. 누적/차감 제외.
import { and, eq, sql } from "drizzle-orm";
import {
  quotesTable, quoteItemsTable, projectsTable, projectPaymentsTable, paymentsTable,
} from "@workspace/db";
import { generateRelationQuoteNumber, isRelationEngineQuoteType } from "./quoteRelation";
import { approvedDerivedSum } from "./quoteDerived";

type Db = any;
export type Result = { http: number; body: Record<string, unknown> };

// ── 변경견적 생성 ──────────────────────────────────────────────────────────────
export async function createRevision(
  tx: Db, sourceQuoteId: number, opts: { versionReason?: string | null; userId?: number } = {},
): Promise<Result> {
  const [src] = await tx.select().from(quotesTable).where(eq(quotesTable.id, sourceQuoteId));
  if (!src) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (!isRelationEngineQuoteType(src.quoteType)) return { http: 400, body: { error: "일반견적(b2b_standard)만 변경견적을 생성할 수 있습니다." } };
  if (src.deletedAt != null) return { http: 400, body: { error: "삭제된 견적입니다." } };

  const rootId: number = src.rootQuoteId ?? src.id;
  // root 락 — 동일 family 동시 생성 직렬화(번호 중복/이중 pending 방지)
  await tx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, rootId)).for("update");

  // 미확정(pending) 변경견적이 이미 있으면 차단(§32) — current/승인 관계 단순화
  const [pend] = await tx.select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber })
    .from(quotesTable)
    .where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootId} AND ${quotesTable.relationType} = 'revision' AND ${quotesTable.status} = 'pending' AND ${quotesTable.deletedAt} IS NULL`)
    .limit(1);
  if (pend) return { http: 409, body: { error: "미확정 변경견적이 이미 존재합니다. 먼저 승인 또는 거절해 주세요.", pendingRevisionId: pend.id, pendingRevisionNumber: pend.quoteNumber } };

  const quoteNumber = await generateRelationQuoteNumber(tx, rootId, "revision");
  const [{ maxv } = { maxv: 1 }] = await tx.select({ maxv: sql<number>`COALESCE(MAX(${quotesTable.version}), 1)` })
    .from(quotesTable).where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootId}`);

  // 업무필드만 복제 — 식별/판매/삭제/유형전용(prepaid·batch) 필드는 복제하지 않음.
  const [rev] = await tx.insert(quotesTable).values({
    price: src.price, title: src.title, note: src.note,
    quoteType: "b2b_standard", billingType: src.billingType, paymentMethod: src.paymentMethod,
    taxDocumentType: src.taxDocumentType, taxCategory: src.taxCategory,
    validUntil: src.validUntil, issueDate: src.issueDate, invoiceDueDate: src.invoiceDueDate, paymentDueDate: src.paymentDueDate,
    equipmentCommon: src.equipmentCommon,
    status: "pending", isCurrent: false, projectId: null,   // 생성 직후 유효본 아님(§10), project 미연결
    rootQuoteId: rootId, parentVersionId: src.id, relationType: "revision",
    version: Number(maxv) + 1, versionReason: opts.versionReason ?? null,
    quoteNumber,
  }).returning();

  // quote_items 별도 row 로 복제(원견적 품목과 공유 금지 §6)
  const items = await tx.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, sourceQuoteId)).orderBy(quoteItemsTable.id);
  if (items.length > 0) {
    await tx.insert(quoteItemsTable).values(items.map((it: any) => {
      const { id, quoteId, createdAt, ...rest } = it;   // 식별/시각 필드 제외
      void id; void quoteId; void createdAt;
      return { ...rest, quoteId: rev.id };
    }));
  }

  // 거래처/담당자/담당PM 등 기본 관계정보 승계 — 거래처·담당자·PM 은 quote 가 아니라 project 에 저장된다.
  //  원견적 project 를 '복제한 전용 project'(status='created', 판매 아님)를 만들어 revision 에 연결한다.
  //  → R1 이 즉시 동일 거래처/담당자/PM 을 표시하고, R1 에서 변경해도 원견적 project 는 그대로 유지(§7 독립).
  //  (원견적에 project 가 없으면 승계할 값이 없으므로 복제하지 않는다 — 원견적도 공란이던 경우와 동일.)
  let revProjectId: number | null = null;
  if (src.projectId != null) {
    const [srcProj] = await tx.select().from(projectsTable).where(eq(projectsTable.id, src.projectId));
    if (srcProj) {
      const [revProj] = await tx.insert(projectsTable).values({
        userId:               opts.userId ?? srcProj.userId,
        adminId:              srcProj.adminId,               // 담당 PM
        companyId:            srcProj.companyId,             // 거래처
        contactId:            srcProj.contactId,             // 담당자
        customerId:           srcProj.customerId,
        customerUserId:       srcProj.customerUserId,
        requestingCompanyId:  srcProj.requestingCompanyId,   // 요청회사
        requestingDivisionId: srcProj.requestingDivisionId,  // 사업부(브랜드)
        billingCompanyId:     srcProj.billingCompanyId,      // 청구회사
        billingDivisionId:    srcProj.billingDivisionId,
        payerCompanyId:       srcProj.payerCompanyId,        // 결제회사
        payerDivisionId:      srcProj.payerDivisionId,
        title:                rev.title?.trim() || `견적 #${rev.id}`,
        status:               "created",                     // 판매(approved) 아님 — 승인 시 STEP2 로직이 판매건 승계/재사용
      }).returning({ id: projectsTable.id });
      revProjectId = revProj.id;
      await tx.update(quotesTable).set({ projectId: revProjectId }).where(eq(quotesTable.id, rev.id));
    }
  }

  return { http: 200, body: { id: rev.id, quoteNumber, rootQuoteId: rootId, parentVersionId: src.id, relationType: "revision", version: rev.version, projectId: revProjectId } };
}

// ── 판매건에 청구/입금이 이미 있으면 승인 차단(§22 B/C) ─────────────────────────
async function hasBillingOrPayment(tx: Db, projectId: number): Promise<boolean> {
  const [bill] = await tx.select({ id: projectPaymentsTable.id }).from(projectPaymentsTable).where(eq(projectPaymentsTable.projectId, projectId)).limit(1);
  if (bill) return true;
  const [pay] = await tx.select({ id: paymentsTable.id }).from(paymentsTable)
    .where(and(eq(paymentsTable.projectId, projectId), eq(paymentsTable.status, "paid"))).limit(1);
  return !!pay;
}

// ── 변경견적 승인(유효본 전환 + 판매연결) ──────────────────────────────────────
export async function approveRevision(tx: Db, revisionId: number, userId: number): Promise<Result> {
  const [rev] = await tx.select().from(quotesTable).where(eq(quotesTable.id, revisionId)).for("update");
  if (!rev) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (rev.relationType !== "revision") return { http: 400, body: { error: "변경견적이 아닙니다." } };
  if (rev.deletedAt != null) return { http: 400, body: { error: "삭제된 견적입니다." } };

  // 멱등: 이미 승인+유효본이면 그대로 반환(중복 project/매출 반영 방지 §34)
  if (rev.status === "approved" && rev.isCurrent === true) {
    return { http: 200, body: { id: rev.id, projectId: rev.projectId, projectCreated: false, alreadyProcessed: true } };
  }
  if (rev.status === "rejected") return { http: 409, body: { error: "거절된 변경견적은 승인할 수 없습니다." } };

  const rootId: number = rev.rootQuoteId ?? rev.id;
  await tx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, rootId)).for("update"); // 직렬화

  const family = await tx.select().from(quotesTable)
    .where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootId} AND ${quotesTable.deletedAt} IS NULL`);

  // §24: 파생견적 배분 안전검증 — 새 현재유효 금액이 기존 승인 파생 합계보다 작으면 배분 불변식이 깨진다.
  //  (예: 승인 파생 8m 인데 변경견적 7m → 7m < 8m 이므로 승인 차단. 파생을 먼저 조정해야 함.)
  const derivedApproved = approvedDerivedSum(family);
  if (Number(rev.price) < derivedApproved) {
    return { http: 409, body: {
      error: `현재 승인된 파생견적 합계 ${derivedApproved.toLocaleString()}원이 변경견적 금액 ${Number(rev.price).toLocaleString()}원을 초과합니다. 파생견적을 먼저 조정해야 합니다.`,
      approvedDerivedTotal: derivedApproved, revisionAmount: Number(rev.price),
    } };
  }

  const priorCurrent = family.find((q: any) => q.isCurrent === true && q.id !== rev.id) ?? null;
  // family 의 기존 판매 project(있으면 재사용) — 현재 유효본 우선, 없으면 아무 연결된 quote
  let projectId: number | null = priorCurrent?.projectId ?? (family.find((q: any) => q.projectId != null)?.projectId ?? null);

  // 이미 청구/입금이 있는 판매건은 자동 갱신 금지(§22) — 명확히 차단
  if (projectId != null && await hasBillingOrPayment(tx, projectId)) {
    return { http: 409, body: { error: "이미 청구 또는 입금이 진행된 판매건입니다. 변경견적 승인 전 청구정보 확인이 필요합니다.", projectId } };
  }

  let projectCreated = false;
  if (projectId == null) {
    // 미전환 family → 승인 시 판매전환(신규 project 1건 생성) §37-A
    const [proj] = await tx.insert(projectsTable).values({
      userId, adminId: userId, title: rev.title?.trim() || `견적서 #${rev.id}`, status: "approved",
    }).returning();
    projectId = proj.id; projectCreated = true;
  } else {
    await tx.update(projectsTable).set({ status: "approved" }).where(eq(projectsTable.id, projectId));
  }

  // 유효본 전환: family 내 다른 is_current 전부 false → 이 revision 만 true (invariant: 체인당 1개)
  await tx.update(quotesTable).set({ isCurrent: false })
    .where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootId} AND ${quotesTable.isCurrent} = true AND ${quotesTable.id} <> ${rev.id}`);
  await tx.update(quotesTable).set({ status: "approved", isCurrent: true, projectId })
    .where(eq(quotesTable.id, rev.id));

  return { http: 200, body: { id: rev.id, projectId, projectCreated, priorCurrentId: priorCurrent?.id ?? null, alreadyProcessed: false } };
}

// ── 변경견적 거절 ──────────────────────────────────────────────────────────────
export async function rejectRevision(tx: Db, revisionId: number): Promise<Result> {
  const [rev] = await tx.select().from(quotesTable).where(eq(quotesTable.id, revisionId)).for("update");
  if (!rev) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (rev.relationType !== "revision") return { http: 400, body: { error: "변경견적이 아닙니다." } };
  if (rev.status === "rejected") return { http: 200, body: { id: rev.id, alreadyProcessed: true } };  // 멱등
  if (rev.status === "approved" && rev.isCurrent === true) return { http: 409, body: { error: "이미 승인된 변경견적은 거절할 수 없습니다." } };
  await tx.update(quotesTable).set({ status: "rejected", isCurrent: false }).where(eq(quotesTable.id, rev.id));
  // 이전 유효본은 건드리지 않는다(그대로 유지). §15/§16
  return { http: 200, body: { id: rev.id, alreadyProcessed: false } };
}
