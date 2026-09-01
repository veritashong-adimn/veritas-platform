// ─── 누적 견적서(accumulated_batch) 마감 → 실제 billing_batch 생성 ───────────────
// 설계
//  · 누적마감 = quote.batch_closed_at 기록 + 이 견적으로 청구할 실제 billing_batch 1건 생성(상태 'billable'=청구가능).
//  · billing_batch 는 오직 마감에서만, quote 당 최초 1회 생성. 새 project/판매/매출을 만들지 않는다(기존 판매건 재사용).
//  · 멱등/동시성: 호출부에서 quote 행 FOR UPDATE 로 직렬화 → 같은 quote 로 billing_batch 가 2개 이상 생기지 않는다.
//  · 금액 SSOT = quote.price. 청구처 = 판매건 project.companyId. 기존 billing_batches 모델(테이블)만 재사용.
import { eq } from "drizzle-orm";
import {
  quotesTable,
  projectsTable,
  billingBatchesTable,
  billingBatchItemsTable,
} from "@workspace/db";

type Db = any;
export type CloseBatchResult = { http: number; body: Record<string, unknown> };

// 반드시 트랜잭션(tx) 안에서 호출한다. 성공/실패를 http+body 로 반환(라우트가 그대로 응답).
export async function closeAccumulatedBatchQuote(tx: Db, quoteId: number): Promise<CloseBatchResult> {
  // 마감 직렬화 락 — 동시/중복 요청에도 billing_batch 1건만 생성되게 한다.
  const [q] = await tx.select({
    id: quotesTable.id, quoteType: quotesTable.quoteType, isCurrent: quotesTable.isCurrent,
    deletedAt: quotesTable.deletedAt, projectId: quotesTable.projectId, price: quotesTable.price,
    title: quotesTable.title, batchClosedAt: quotesTable.batchClosedAt,
    batchPeriodStart: quotesTable.batchPeriodStart, batchPeriodEnd: quotesTable.batchPeriodEnd,
  }).from(quotesTable).where(eq(quotesTable.id, quoteId)).for("update");

  if (!q) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (q.quoteType !== "accumulated_batch") return { http: 400, body: { error: "누적 견적서만 마감할 수 있습니다." } };
  if (q.deletedAt != null) return { http: 400, body: { error: "삭제된 견적서입니다." } };
  if (q.projectId == null) return { http: 400, body: { error: "판매전환된 누적 견적서만 마감할 수 있습니다." } };

  const [p] = await tx.select({ id: projectsTable.id, status: projectsTable.status, companyId: projectsTable.companyId })
    .from(projectsTable).where(eq(projectsTable.id, q.projectId));
  if (!p || p.status !== "approved") return { http: 400, body: { error: "유효한 판매전환 판매건이 아닙니다." } };
  if (p.companyId == null) return { http: 400, body: { error: "판매건에 청구처(거래처) 정보가 없습니다." } };
  const companyId: number = p.companyId;

  // 이 quote 로 생성된 실제 billing_batch 존재 여부(멱등 기준)
  const [existingBatch] = await tx.select({ id: billingBatchesTable.id })
    .from(billingBatchesTable).where(eq(billingBatchesTable.quoteId, quoteId)).limit(1);

  // batch_closed_at 설정(없을 때만)
  let closedAt = q.batchClosedAt as Date | null;
  if (closedAt == null) {
    const [u] = await tx.update(quotesTable).set({ batchClosedAt: new Date() })
      .where(eq(quotesTable.id, quoteId)).returning({ batchClosedAt: quotesTable.batchClosedAt });
    closedAt = u.batchClosedAt as Date | null;
  }

  // 이미 배치가 있으면 재사용(신규 생성 금지) — 멱등 성공
  if (existingBatch) {
    return { http: 200, body: { id: quoteId, batchClosedAt: closedAt, batchStatus: "billable", billingBatchId: existingBatch.id, created: false, alreadyExisted: true } };
  }

  // billing_batch 1건 생성 (SSOT=quote.price, 기간=견적 배치기간 or 마감일)
  const total = String(q.price);
  const closedDate: Date = closedAt ?? new Date();
  const periodStart: Date = (q.batchPeriodStart as unknown as Date | null) ?? closedDate;
  const periodEnd: Date = (q.batchPeriodEnd as unknown as Date | null) ?? closedDate;
  const [batch] = await tx.insert(billingBatchesTable).values({
    companyId, periodStart, periodEnd, status: "billable",
    totalAmount: total, quoteId, note: "누적 견적 마감 자동 생성(청구가능)",
  }).returning({ id: billingBatchesTable.id });
  // billing_batch_items: 기존 판매건(project) 1건만 연결 — 새 project/판매 생성하지 않음.
  await tx.insert(billingBatchItemsTable).values({
    batchId: batch.id, projectId: p.id, quoteId, amount: total, serviceName: q.title ?? null,
  });
  return { http: 200, body: { id: quoteId, batchClosedAt: closedAt, batchStatus: "billable", billingBatchId: batch.id, created: true } };
}
