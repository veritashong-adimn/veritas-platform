/**
 * 견적서 삭제(논리 삭제) + 의뢰건·프로젝트 상태 원복.
 *
 *  · 견적만 삭제 표시(quotes.deleted_at/deleted_by/deletion_reason — 기존 컬럼). 견적번호는 재사용하지 않는다.
 *  · 삭제 가능: 저장만 된 견적(status=pending) — 발송·승인·배정·작업·결제·정산·청구 증빙·선입금 차감이 없을 때.
 *  · 원복: 연결된 의뢰건(inquiries.quote_id)은 같은 프로젝트의 다른 유효 견적으로 다시 연결하고, 없으면 연결을 해제한다
 *          (의뢰건 처리상태는 quote_id 로 파생 → '견적 생성 가능'으로 돌아감). 프로젝트는 삭제·신규 생성하지 않고 ID 유지,
 *          다른 유효 견적이 없을 때만 '견적'(quoted) → '접수'(created).
 *  · 한 트랜잭션(견적 행 잠금 → 재검증 → 삭제 → 의뢰건·프로젝트 원복). 감사로그는 커밋 후 기록.
 */
import { db, quotesTable, projectsTable, inquiriesTable, logsTable } from "@workspace/db";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { evaluateQuoteDependencies } from "./saleDependency";

const PROJECT_STATUS_KR: Record<string, string> = {
  created: "접수", quoted: "견적", approved: "견적승인", paid: "입금", matched: "통번역사 배정", in_progress: "진행중", completed: "완료", cancelled: "취소",
};

export interface QuoteDeletable {
  ok: boolean;
  reasons: string[];
  quote: { id: number; quoteNumber: string | null; status: string; projectId: number | null } | null;
  project: { id: number; status: string } | null;
  inquiryIds: number[];
  otherActiveQuotes: Array<{ id: number; quoteNumber: string | null; status: string; isCurrent: boolean }>;
}

const count = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)).rows[0] as { n: string | number } | undefined)?.n ?? 0);

/** 삭제 가능 여부(읽기 전용) — 상태값만이 아니라 발송·배정·결제·정산·청구·선입금 실제 기록을 함께 본다. */
export async function checkQuoteDeletable(quoteId: number): Promise<QuoteDeletable> {
  const [q] = await db.select({
    id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, status: quotesTable.status, projectId: quotesTable.projectId,
    deletedAt: quotesTable.deletedAt, batchClosedAt: quotesTable.batchClosedAt,
  }).from(quotesTable).where(eq(quotesTable.id, quoteId));
  const empty: QuoteDeletable = { ok: false, reasons: ["견적을 찾을 수 없습니다."], quote: null, project: null, inquiryIds: [], otherActiveQuotes: [] };
  if (!q) return empty;
  const reasons: string[] = [];
  if (q.deletedAt) reasons.push("이미 삭제된 견적입니다.");
  if (q.status === "approved") reasons.push("고객 승인(판매전환)된 견적서입니다 — 먼저 판매취소를 진행해 주세요.");
  if (q.status === "sent") reasons.push("고객에게 발송된 견적서입니다 — 삭제 대신 거절 처리 또는 변경견적(정정)으로 처리해 주세요.");
  if (q.status === "rejected") reasons.push("발송 후 거절 처리된 견적서입니다 — 발송 이력 보존을 위해 삭제할 수 없습니다.");
  if (q.batchClosedAt) reasons.push("누적 마감된 견적서입니다 — 청구 단위가 확정되어 삭제할 수 없습니다.");

  // 청구·세금계산서 묶음 / 선입금 차감 / 통번역사 실적·지급 (견적 단위 기록)
  if (await count(sql`SELECT count(*) n FROM billing_batches WHERE quote_id = ${quoteId}`) + await count(sql`SELECT count(*) n FROM billing_batch_items WHERE quote_id = ${quoteId}`) > 0)
    reasons.push("청구(세금계산서) 묶음에 포함된 견적서입니다.");
  const prepaid = await count(sql`SELECT count(*) n FROM prepaid_ledger WHERE quote_id = ${quoteId} AND coalesce(status, '') <> 'released'`);
  if (prepaid > 0) reasons.push(`선입금 차감·예약 내역 ${prepaid}건이 연결되어 있습니다 — 먼저 차감을 해제해 주세요.`);
  const perf = await count(sql`SELECT count(*) n FROM performance_assignments WHERE quote_id = ${quoteId} AND deleted_at IS NULL`)
    + await count(sql`SELECT count(*) n FROM payout_round_items WHERE quote_id = ${quoteId}`);
  if (perf > 0) reasons.push(`통번역사 실적·지급 기록 ${perf}건이 연결되어 있습니다.`);

  let project: QuoteDeletable["project"] = null;
  if (q.projectId != null) {
    const [p] = await db.select({ id: projectsTable.id, status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, q.projectId));
    if (p) {
      project = p;
      if (!["created", "quoted"].includes(p.status)) reasons.push(`프로젝트가 '${PROJECT_STATUS_KR[p.status] ?? p.status}' 단계입니다 — 견적승인·배정·진행 이후에는 삭제할 수 없습니다.`);
      const tasks = await count(sql`SELECT count(*) n FROM tasks WHERE project_id = ${p.id}`);
      if (tasks > 0) reasons.push(`통번역사 배정(작업) 기록 ${tasks}건이 있습니다.`);
      const settle = await count(sql`SELECT count(*) n FROM settlements WHERE project_id = ${p.id}`);
      if (settle > 0) reasons.push(`정산 기록 ${settle}건이 있습니다.`);
      const pays = await count(sql`SELECT count(*) n FROM payments WHERE project_id = ${p.id}`);
      if (pays > 0) reasons.push(`결제 기록 ${pays}건이 있습니다.`);
      // 기존 판매 의존성 가드(입금·지급·지급회차 — 미확정 포함)
      const guard = await evaluateQuoteDependencies(quoteId);
      if (!guard.canDelete) reasons.push(...guard.blockingReasons);
    }
  }
  const otherActiveQuotes = q.projectId != null
    ? await db.select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, status: quotesTable.status, isCurrent: quotesTable.isCurrent })
        .from(quotesTable).where(and(eq(quotesTable.projectId, q.projectId), ne(quotesTable.id, quoteId), isNull(quotesTable.deletedAt)))
    : [];
  const inquiryIds = (await db.select({ id: inquiriesTable.id }).from(inquiriesTable).where(eq(inquiriesTable.quoteId, quoteId))).map(r => r.id);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], quote: { id: q.id, quoteNumber: q.quoteNumber, status: q.status, projectId: q.projectId }, project, inquiryIds, otherActiveQuotes };
}

export interface QuoteDeleteResult {
  quoteId: number; quoteNumber: string | null; projectId: number | null;
  projectStatusBefore: string | null; projectStatusAfter: string | null;
  inquiries: Array<{ id: number; relinkedQuoteId: number | null }>;
  otherActiveQuoteIds: number[];
}

export class QuoteDeleteError extends Error { constructor(public status: number, message: string, public reasons: string[] = []) { super(message); } }

/** 삭제 + 원복(한 트랜잭션). 서버에서 조건을 다시 검증한다(화면 검사와 무관). */
export async function deleteQuoteAndRevert(quoteId: number, userId: number | null, reason: string | null): Promise<QuoteDeleteResult> {
  const pre = await checkQuoteDeletable(quoteId);
  if (!pre.quote) throw new QuoteDeleteError(404, "견적을 찾을 수 없습니다.");
  if (!pre.ok) throw new QuoteDeleteError(409, pre.reasons[0] ?? "삭제할 수 없는 견적입니다.", pre.reasons);

  return db.transaction(async tx => {
    // 같은 견적에 대한 동시 삭제·승인·수정 직렬화 — 행 잠금 후 상태 재확인
    const [q] = await tx.select({ id: quotesTable.id, status: quotesTable.status, deletedAt: quotesTable.deletedAt, projectId: quotesTable.projectId, quoteNumber: quotesTable.quoteNumber })
      .from(quotesTable).where(eq(quotesTable.id, quoteId)).for("update");
    if (!q || q.deletedAt) throw new QuoteDeleteError(409, "이미 삭제된 견적입니다.");
    if (q.status !== "pending") throw new QuoteDeleteError(409, "견적 상태가 변경되었습니다(발송·승인 등) — 화면을 새로고침한 뒤 다시 확인해 주세요.");

    const [del] = await tx.update(quotesTable)
      .set({ deletedAt: new Date(), deletedBy: userId, deletionReason: reason })
      .where(and(eq(quotesTable.id, quoteId), isNull(quotesTable.deletedAt)))
      .returning({ id: quotesTable.id });
    if (!del) throw new QuoteDeleteError(409, "이미 삭제된 견적입니다.");

    // 같은 프로젝트의 다른 유효 견적(현재유효 우선)
    const others = q.projectId != null
      ? await tx.select({ id: quotesTable.id, isCurrent: quotesTable.isCurrent }).from(quotesTable)
          .where(and(eq(quotesTable.projectId, q.projectId), ne(quotesTable.id, quoteId), isNull(quotesTable.deletedAt)))
          .orderBy(desc(quotesTable.isCurrent), desc(quotesTable.id))
      : [];
    const relinkTo = others[0]?.id ?? null;

    // 의뢰건 — 다른 유효 견적이 있으면 그 견적으로, 없으면 연결 해제(견적 생성 가능 상태). 고객·의뢰 내용은 그대로.
    const linked = await tx.select({ id: inquiriesTable.id }).from(inquiriesTable).where(eq(inquiriesTable.quoteId, quoteId)).for("update");
    for (const inq of linked) {
      await tx.update(inquiriesTable).set({ quoteId: relinkTo, updatedAt: new Date() }).where(eq(inquiriesTable.id, inq.id));
    }

    // 프로젝트 — 삭제·신규 생성 없이 ID 유지. 다른 유효 견적이 없을 때만 '견적'(quoted) → '접수'(created).
    let before: string | null = null, after: string | null = null;
    if (q.projectId != null) {
      const [p] = await tx.select({ status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, q.projectId)).for("update");
      before = p?.status ?? null; after = before;
      if (p && others.length === 0 && p.status === "quoted") {
        await tx.update(projectsTable).set({ status: "created" }).where(eq(projectsTable.id, q.projectId));
        after = "created";
      }
      if (p && !["created", "quoted"].includes(p.status)) throw new QuoteDeleteError(409, `프로젝트가 '${PROJECT_STATUS_KR[p.status] ?? p.status}' 단계로 변경되어 삭제할 수 없습니다.`);
    }
    return {
      quoteId, quoteNumber: q.quoteNumber, projectId: q.projectId,
      projectStatusBefore: before, projectStatusAfter: after,
      inquiries: linked.map(l => ({ id: l.id, relinkedQuoteId: relinkTo })),
      otherActiveQuoteIds: others.map(o => o.id),
    };
  });
}

/**
 * 의뢰건에서 견적을 다시 만들 때 재사용할 프로젝트 — 이 의뢰건에서 삭제로 연결 해제된 견적의 프로젝트가
 * 아직 '접수'(created)이고 유효 견적이 하나도 없으면 그 프로젝트 ID 를 다시 쓴다(빈 프로젝트가 남지 않게).
 */
export async function findReusableProjectForInquiry(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], inquiryId: number): Promise<number | null> {
  const logs = await tx.select({ metadata: logsTable.metadata }).from(logsTable)
    .where(and(eq(logsTable.entityType, "inquiry"), eq(logsTable.entityId, inquiryId), eq(logsTable.action, "inquiry_quote_unlinked")))
    .orderBy(desc(logsTable.id)).limit(5);
  for (const l of logs) {
    let pid: number | null = null;
    try { pid = Number(JSON.parse(l.metadata ?? "{}").projectId) || null; } catch { pid = null; }
    if (!pid) continue;
    const [p] = await tx.select({ id: projectsTable.id, status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, pid)).for("update");
    if (!p || p.status !== "created") continue;
    const [{ n }] = (await tx.execute(sql`SELECT count(*)::int n FROM quotes WHERE project_id = ${pid} AND deleted_at IS NULL`)).rows as Array<{ n: number }>;
    if (Number(n) === 0) return pid;
  }
  return null;
}
