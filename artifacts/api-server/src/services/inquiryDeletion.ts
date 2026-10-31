/**
 * 의뢰건 삭제(논리 삭제)·복원·완전삭제 — inquiries.deleted_at/deleted_by/deletion_reason(기존 컬럼).
 *
 *  · 삭제 가능: 유효(삭제되지 않은) 견적서가 연결되어 있지 않고, 이 의뢰건에 연결됐던 모든 견적(삭제된 견적 포함)에
 *    발송·승인·배정·작업·결제·정산·청구 증빙·선입금 차감 이력이 없을 때. 견적 삭제와 같은 기준(services/quoteDeletion)을 쓴다.
 *  · 고객·거래처·담당자·프로젝트·견적은 그대로 둔다(프로젝트 물리 삭제·재사용 없음). 첨부·AI 분석 이력은 의뢰건 행에 그대로 보존.
 *  · 한 트랜잭션(의뢰건 행 잠금 → 재검증 → 삭제 표시). 감사로그는 커밋 후(원래 프로젝트·견적 ID 포함).
 */
import { db, inquiriesTable, quotesTable, logsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
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

// ─── 휴지통 복원·완전삭제 ───────────────────────────────────────────────────────

/** 복원 — 삭제 표시만 해제한다(새 행 없음). 의뢰번호·거래처·담당자·첨부·견적 연결은 행에 그대로 보존돼 있다. */
export async function restoreInquiry(inquiryId: number) {
  return db.transaction(async tx => {
    const [inq] = await tx.select({
      inquiryNumber: inquiriesTable.inquiryNumber, deletedAt: inquiriesTable.deletedAt, deletedBy: inquiriesTable.deletedBy, deletionReason: inquiriesTable.deletionReason,
      quoteId: inquiriesTable.quoteId, companyId: inquiriesTable.companyId, contactId: inquiriesTable.contactId,
    }).from(inquiriesTable).where(eq(inquiriesTable.id, inquiryId)).for("update");
    if (!inq) throw new InquiryDeleteError(404, "의뢰건을 찾을 수 없습니다.");
    if (!inq.deletedAt) throw new InquiryDeleteError(409, "휴지통에 있는 의뢰건이 아닙니다.");
    await tx.update(inquiriesTable).set({ deletedAt: null, deletedBy: null, deletionReason: null, updatedAt: new Date() })
      .where(eq(inquiriesTable.id, inquiryId));
    return inq;
  });
}

/**
 * 완전삭제 가능 여부(읽기 전용) — 휴지통에 있고, 연결됐던 견적이 하나도 남아 있지 않을 때만.
 * 되돌릴 수 없는 작업이므로 휴지통의 견적도 차단한다. 판매·청구·수행·정산은 모두 견적·프로젝트를 거쳐 연결되므로 견적이 남아 있으면 함께 막힌다.
 */
export async function checkInquiryPurgeable(inquiryId: number): Promise<{ reasons: string[]; found: boolean }> {
  const [inq] = await db.select({ quoteId: inquiriesTable.quoteId, deletedAt: inquiriesTable.deletedAt })
    .from(inquiriesTable).where(eq(inquiriesTable.id, inquiryId));
  if (!inq) return { reasons: ["의뢰건을 찾을 수 없습니다."], found: false };
  if (!inq.deletedAt) return { reasons: ["휴지통에 있는 의뢰건만 완전삭제할 수 있습니다."], found: true };
  const qids = await linkedQuoteIds(inquiryId, inq.quoteId);
  const quotes = qids.length
    ? await db.select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, deletedAt: quotesTable.deletedAt }).from(quotesTable).where(inArray(quotesTable.id, qids))
    : [];
  return { found: true, reasons: quotes.map(q => q.deletedAt
    ? `휴지통의 견적서(${q.quoteNumber ?? `#${q.id}`})가 연결되어 있습니다 — 견적서를 먼저 정리해 주세요.`
    : `유효한 견적서(${q.quoteNumber ?? `#${q.id}`})가 연결되어 있습니다.`) };
}

/** 완전삭제 — 의뢰건 행만 지운다(연결 데이터 연쇄 삭제 없음, 감사로그 보존). 삭제한 행의 식별정보를 돌려줘 감사로그에 남긴다. */
export async function purgeInquiry(inquiryId: number) {
  const pre = await checkInquiryPurgeable(inquiryId);
  if (!pre.found) throw new InquiryDeleteError(404, pre.reasons[0]);
  if (pre.reasons.length) throw new InquiryDeleteError(409, pre.reasons[0], pre.reasons);
  return db.transaction(async tx => {
    const [inq] = await tx.select({ quoteId: inquiriesTable.quoteId }).from(inquiriesTable).where(eq(inquiriesTable.id, inquiryId)).for("update");
    if (!inq) throw new InquiryDeleteError(409, "이미 완전삭제된 의뢰건입니다.");
    // 검사 후 견적 복원으로 다시 연결됐을 수 있다
    if (inq.quoteId) {
      const [q] = await tx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, inq.quoteId));
      if (q) throw new InquiryDeleteError(409, "견적서가 연결되어 있습니다 — 화면을 새로고침한 뒤 다시 확인해 주세요.");
    }
    const [gone] = await tx.delete(inquiriesTable).where(and(eq(inquiriesTable.id, inquiryId), isNotNull(inquiriesTable.deletedAt)))
      .returning({ inquiryNumber: inquiriesTable.inquiryNumber, customerCompanyName: inquiriesTable.customerCompanyName, companyId: inquiriesTable.companyId, contactId: inquiriesTable.contactId, subject: inquiriesTable.subject, deletedAt: inquiriesTable.deletedAt, deletionReason: inquiriesTable.deletionReason });
    if (!gone) throw new InquiryDeleteError(409, "휴지통에 있는 의뢰건만 완전삭제할 수 있습니다.");
    return gone;
  });
}
