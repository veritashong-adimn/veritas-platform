// ─── 거래명세서 거래일자(2026-11) ──────────────────────────────────────────────
//  · 거래명세서 = 견적당 1건(transaction_statements.quote_id UNIQUE). 번호는 견적에서 파생 — 날짜 변경으로 재생성하지 않는다.
//  · 거래일자 기본값: 저장값 > 세금계산서 발행일 1개(그 날짜) > 여러 개(회차 선택) > 없음(오늘, KST).
//  · 청구정보·견적·판매·납품 날짜는 읽기만 한다(변경 금지). 변경 이력은 감사로그(logs, entity 'quote').
//  · 거래명세서 출력 경로(판매 상세·견적 상세)는 같은 모달 → 같은 API 를 사용한다.
import { Router, type IRouter } from "express";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db, quotesTable, projectPaymentsTable, transactionStatementsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// 화면 formatDocNumber('T', quoteNumber, issueDate) 와 동일 규칙(T + 견적발행일 YYMMDD + '-' + 순번 3자리)
export function statementNoOf(quoteNumber: string | null | undefined, issueDate: string | null | undefined): string {
  const seqDigits = String(quoteNumber ?? "").replace(/\D/g, "");
  const ymd = String(issueDate ?? "").replace(/\D/g, "").slice(2, 8);
  if (!seqDigits || ymd.length < 6) return String(quoteNumber ?? "");
  return `T${ymd}-${String(Number(seqDigits)).padStart(3, "0")}`;
}
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const isTaxInvoiceMethod = (m: string | null | undefined) => /계산서/.test(m ?? "");

async function loadState(quoteId: number) {
  const [q] = await db.select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, issueDate: quotesTable.issueDate, projectId: quotesTable.projectId, deletedAt: quotesTable.deletedAt })
    .from(quotesTable).where(eq(quotesTable.id, quoteId));
  if (!q || q.deletedAt) return null;
  const statementNo = statementNoOf(q.quoteNumber, q.issueDate);
  const [saved] = await db.select().from(transactionStatementsTable).where(eq(transactionStatementsTable.quoteId, quoteId));
  // 세금계산서 발행 회차 — 발행일이 있고 결제방법이 (세금)계산서인 청구 회차만(발행되지 않은 회차는 후보로 내지 않음)
  const rounds = q.projectId == null ? [] : await db.select({
    id: projectPaymentsTable.id, sequence: projectPaymentsTable.sequence, issueDate: projectPaymentsTable.issueDate,
    paymentMethod: projectPaymentsTable.paymentMethod, supplyAmount: projectPaymentsTable.supplyAmount,
    vatAmount: projectPaymentsTable.vatAmount, amount: projectPaymentsTable.amount,
  }).from(projectPaymentsTable)
    .where(and(eq(projectPaymentsTable.projectId, q.projectId), isNotNull(projectPaymentsTable.issueDate)))
    .orderBy(asc(projectPaymentsTable.sequence), asc(projectPaymentsTable.id));
  const taxRounds = rounds.filter(r => isTaxInvoiceMethod(r.paymentMethod));
  const suggestion = saved
    ? { transactionDate: saved.transactionDate, dateSource: saved.dateSource, linkedPaymentId: saved.linkedPaymentId, needsRoundSelection: false, basis: "saved" as const }
    : taxRounds.length === 1
      ? { transactionDate: taxRounds[0].issueDate!, dateSource: "tax_invoice", linkedPaymentId: taxRounds[0].id, needsRoundSelection: false, basis: "tax_invoice" as const }
      : taxRounds.length > 1
        ? { transactionDate: todayKst(), dateSource: "tax_invoice", linkedPaymentId: null, needsRoundSelection: true, basis: "multiple_rounds" as const }
        : { transactionDate: todayKst(), dateSource: "manual", linkedPaymentId: null, needsRoundSelection: false, basis: "today" as const };
  return { quote: q, statementNo, saved: saved ?? null, taxRounds, suggestion };
}
const view = (s: NonNullable<Awaited<ReturnType<typeof loadState>>>) => ({
  quoteId: s.quote.id, statementNo: s.statementNo, saved: s.saved, taxInvoiceRounds: s.taxRounds, suggestion: s.suggestion,
});

router.get("/admin/quotes/:id/statement", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "잘못된 견적 ID" }); return; }
  const s = await loadState(id);
  if (!s) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
  res.json(view(s));
});

const putSchema = z.object({
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateSource: z.enum(["tax_invoice", "manual"]),
  linkedPaymentId: z.number().int().positive().nullable().optional(),
  reason: z.string().max(300).nullable().optional(),
});

// 저장 — 견적당 1건 upsert(번호 불변, 중복 문서 없음). 청구정보·견적 날짜는 변경하지 않는다.
router.put("/admin/quotes/:id/statement", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const s = await loadState(id);
  if (!s) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
  const b = parsed.data;
  let date = b.transactionDate; let paymentId: number | null = null;
  if (b.dateSource === "tax_invoice") {
    const r = s.taxRounds.find(x => x.id === b.linkedPaymentId);
    if (!r) { res.status(400).json({ error: "적용할 세금계산서 발행 회차를 선택해 주세요." }); return; }
    date = r.issueDate!; paymentId = r.id;   // 발행일과 동일 — 서버가 회차 발행일로 확정
  }
  const userId = req.user?.id ?? null;
  const before = s.saved;
  const changed = !before || before.transactionDate !== date || before.dateSource !== b.dateSource || (before.linkedPaymentId ?? null) !== paymentId;
  if (changed) {
    await db.insert(transactionStatementsTable).values({
      quoteId: id, statementNo: s.statementNo, transactionDate: date, dateSource: b.dateSource, linkedPaymentId: paymentId,
      createdBy: userId, updatedBy: userId,
    }).onConflictDoUpdate({
      target: transactionStatementsTable.quoteId,
      set: { transactionDate: date, dateSource: b.dateSource, linkedPaymentId: paymentId, updatedBy: userId, updatedAt: new Date() },
    });
    await logEvent("quote", id, before ? "transaction_statement_date_changed" : "transaction_statement_created", req.log,
      req.user ? { id: req.user.id, email: req.user.email } : undefined,
      JSON.stringify({ statementNo: before?.statementNo ?? s.statementNo, before: before?.transactionDate ?? null, after: date,
        dateSource: b.dateSource, linkedPaymentId: paymentId, reason: b.reason?.trim() || null }));
  }
  const after = await loadState(id);
  res.json({ ...view(after!), changed });
});

export default router;
