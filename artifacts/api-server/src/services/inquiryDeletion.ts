/**
 * 의뢰건 삭제(논리 삭제) — inquiries.deleted_at/deleted_by/deletion_reason(기존 컬럼).
 *
 *  · 삭제 가능: 유효(삭제되지 않은) 견적서가 연결되어 있지 않고, 이 의뢰건에 연결됐던 모든 견적(삭제된 견적 포함)에
 *    발송·승인·배정·작업·결제·정산·청구 증빙·선입금 차감 이력이 없을 때. 견적 삭제와 같은 기준(services/quoteDeletion)을 쓴다.
 *  · 고객·거래처·담당자·프로젝트·견적은 그대로 둔다(프로젝트 물리 삭제·재사용 없음). 첨부·AI 분석 이력은 의뢰건 행에 그대로 보존.
 *  · 한 트랜잭션(의뢰건 행 잠금 → 재검증 → 삭제 표시). 감사로그는 커밋 후(원래 프로젝트·견적 ID 포함).
 */
import { db, inquiriesTable, quotesTable, logsTable } from "@workspace/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { checkQuoteDeletable } from "./quoteDeletion";

export interface InquiryDeletable {
  ok: boolean;
  reasons: string[];
  inquiry: { id: number; inquiryNumber: string | null; quoteId: number | null } | null;
  /** 이 의뢰건에 연결됐던 견적(현재 + 과거)과 그 프로젝트 — 감사로그용 */
  quoteIds: number[];
  projectIds: number[];
}

/** 이 의뢰건에 연결됐던 견적 ID(현재 연결 + 연결·해제 이력) */
async function linkedQuoteIds(inquiryId: number, current: number | null): Promise<number[]> {
  const logs = await db.select({ metadata: logsTable.metadata }).from(logsTable)
    .where(and(eq(logsTable.entityType, "inquiry"), eq(logsTable.entityId, inquiryId),
      or(eq(logsTable.action, "inquiry_quote_linked"), eq(logsTable.action, "inquiry_quote_unlinked"))));
  const ids = new Set<number>(current ? [current] : []);
  for (const l of logs) { try { const q = Number(JSON.parse(l.metadata ?? "{}").quoteId); if (q > 0) ids.add(q); } catch { /* 메타데이터 없음 */ } }
  return [...ids];
}

export async function checkInquiryDeletable(inquiryId: number): Promise<InquiryDeletable> {
  const [inq] = await db.select({ id: inquiriesTable.id, inquiryNumber: inquiriesTable.inquiryNumber, quoteId: inquiriesTable.quoteId, deletedAt: inquiriesTable.deletedAt })
    .from(inquiriesTable).where(eq(inquiriesTable.id, inquiryId));
  if (!inq) return { ok: false, reasons: ["의뢰건을 찾을 수 없습니다."], inquiry: null, quoteIds: [], projectIds: [] };
  const reasons: string[] = [];
  if (inq.deletedAt) reasons.push("이미 삭제된 의뢰건입니다.");
  const qids = await linkedQuoteIds(inq.id, inq.quoteId);
  const quotes = qids.length
    ? await db.select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, deletedAt: quotesTable.deletedAt, projectId: quotesTable.projectId })
        .from(quotesTable).where(inArray(quotesTable.id, qids))
    : [];
  for (const q of quotes) {
    const label = q.quoteNumber ?? `#${q.id}`;
    if (!q.deletedAt) {
      reasons.push(`유효한 견적서(${label})가 연결되어 있습니다 — 견적서를 먼저 삭제해 주세요.`);
      continue;
    }
    // 삭제된 견적이라도 과거 발송·승인·배정·작업·결제·정산 이력이 있으면 의뢰건을 삭제하지 않는다
    const c = await checkQuoteDeletable(q.id);
    for (const r of c.reasons.filter(r => !/이미 삭제된 견적/.test(r))) reasons.push(`삭제된 견적서 ${label}: ${r}`);
  }
  return {
    ok: reasons.length === 0, reasons: [...new Set(reasons)],
    inquiry: { id: inq.id, inquiryNumber: inq.inquiryNumber, quoteId: inq.quoteId },
    quoteIds: quotes.map(q => q.id), projectIds: [...new Set(quotes.map(q => q.projectId).filter((p): p is number => p != null))],
  };
}

export class InquiryDeleteError extends Error { constructor(public status: number, message: string, public reasons: string[] = []) { super(message); } }

/** 삭제 표시(한 트랜잭션, 서버 재검증). 연결 견적이 그 사이 생기거나 이미 삭제됐으면 409. */
export async function deleteInquiry(inquiryId: number, userId: number | null, reason: string | null): Promise<InquiryDeletable> {
  const pre = await checkInquiryDeletable(inquiryId);
  if (!pre.inquiry) throw new InquiryDeleteError(404, "의뢰건을 찾을 수 없습니다.");
  if (!pre.ok) throw new InquiryDeleteError(409, pre.reasons[0] ?? "삭제할 수 없는 의뢰건입니다.", pre.reasons);
  await db.transaction(async tx => {
    const [inq] = await tx.select({ deletedAt: inquiriesTable.deletedAt, quoteId: inquiriesTable.quoteId })
      .from(inquiriesTable).where(eq(inquiriesTable.id, inquiryId)).for("update");
    if (!inq || inq.deletedAt) throw new InquiryDeleteError(409, "이미 삭제된 의뢰건입니다.");
    if (inq.quoteId) {
      const [q] = await tx.select({ deletedAt: quotesTable.deletedAt }).from(quotesTable).where(eq(quotesTable.id, inq.quoteId));
      if (q && !q.deletedAt) throw new InquiryDeleteError(409, "유효한 견적서가 연결되어 있습니다 — 화면을 새로고침한 뒤 다시 확인해 주세요.");
    }
    const [done] = await tx.update(inquiriesTable)
      .set({ deletedAt: new Date(), deletedBy: userId, deletionReason: reason, updatedAt: new Date() })
      .where(and(eq(inquiriesTable.id, inquiryId), isNull(inquiriesTable.deletedAt)))
      .returning({ id: inquiriesTable.id });
    if (!done) throw new InquiryDeleteError(409, "이미 삭제된 의뢰건입니다.");
  });
  return pre;
}
