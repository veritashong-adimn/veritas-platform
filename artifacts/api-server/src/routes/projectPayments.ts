// ─────────────────────────────────────────────────────────────────────────────
// 결제정보 (고객 수금) API — 프로젝트별 고객 결제 현황.
//  · 고객→우리 수금 기록(통번역사 지급 settlements 와는 별개).
//  · GET 프로젝트 상세(admin.ts)에서 paymentRecords[] 로 함께 반환 → 별도 조회 엔드포인트 불필요.
//  · 배치 저장(rows + deletedIds)만 제공. 회차(sequence)는 서버에서 순서대로 자동번호.
//  · 미수금은 저장하지 않고 화면에서 계산(총 판매금액 − 총 입금액).
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, projectPaymentsTable, paymentTransactionsTable, companiesTable, contactsTable } from "@workspace/db";
import { eq, and, inArray, asc, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// 프로젝트 상세 응답에 포함 — 회차 오름차순. 청구업체·담당자 이름 조인 + 청구행별 수금거래(transactions[]) 첨부.
export async function loadPaymentRecords(projectId: number) {
  const records = await db
    .select({
      ...getTableColumns(projectPaymentsTable),
      billingCompanyName: companiesTable.name,
      billingContactName: contactsTable.name,
    })
    .from(projectPaymentsTable)
    .leftJoin(companiesTable, eq(projectPaymentsTable.billingCompanyId, companiesTable.id))
    .leftJoin(contactsTable, eq(projectPaymentsTable.billingContactId, contactsTable.id))
    .where(eq(projectPaymentsTable.projectId, projectId))
    .orderBy(projectPaymentsTable.sequence);

  // 청구행별 수금거래 첨부 — 기존 응답 shape 확장(transactions[] 추가만). 기존 소비자는 무영향.
  const ids = records.map((r) => r.id);
  const txns = ids.length
    ? await db.select().from(paymentTransactionsTable)
        .where(inArray(paymentTransactionsTable.projectPaymentId, ids))
        .orderBy(asc(paymentTransactionsTable.paidDate), asc(paymentTransactionsTable.id))
    : [];
  const byPayment = new Map<number, typeof txns>();
  for (const t of txns) { const arr = byPayment.get(t.projectPaymentId) ?? []; arr.push(t); byPayment.set(t.projectPaymentId, arr); }
  return records.map((r) => ({ ...r, transactions: byPayment.get(r.id) ?? [] }));
}

const PAYMENT_TYPE = ["advance", "interim", "balance", "lump_sum", "other"] as const;
const DEPOSIT_STATUS = ["scheduled", "partial", "completed", "unpaid"] as const;

const rowSchema = z.object({
  id: z.number().int().optional(),
  issueDate: z.string().nullable().optional(),      // 발행일 — 세금계산서 발행일(세금계산서일 때만)
  expectedDate: z.string().nullable().optional(),   // 입금예정일
  paidDate: z.string().nullable().optional(),       // 입금일
  paymentType: z.enum(PAYMENT_TYPE).nullable().optional(),
  paymentMethod: z.string().max(100).nullable().optional(),   // 결제방법 — 자유 입력(text). 기본 4개 라벨 또는 사용자 직접입력.
  supplyAmount: z.coerce.number().min(0).nullable().optional(),
  vatAmount: z.coerce.number().min(0).nullable().optional(),
  amount: z.coerce.number().min(0).nullable().optional(),
  depositStatus: z.enum(DEPOSIT_STATUS).nullable().optional(),
  depositConfirmed: z.boolean().nullable().optional(),         // 입금확인 — 체크 시 입금일=입금예정일·상태 입금완료
  paymentCategory: z.string().max(50).nullable().optional(),   // 결제유형: 일반결제 · 수출바우처(자유 확장)
  payer: z.string().max(100).nullable().optional(),            // 입금주체: 고객사 · 수출바우처 운영기관
  depositItem: z.string().max(50).nullable().optional(),       // 입금항목: 공급가액 · 부가세 · 전체금액
  billingCompanyId: z.number().int().nullable().optional(),    // 청구업체
  billingContactId: z.number().int().nullable().optional(),    // 담당자
  note: z.string().nullable().optional(),
});
const batchSchema = z.object({
  rows: z.array(rowSchema),
  deletedIds: z.array(z.number().int()).default([]),
});

// 배치 저장 — 삭제 후 upsert. 회차는 전송된 순서대로 1..N 재부여(자동번호).
router.put("/admin/projects/:id/payment-records", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const { rows, deletedIds } = parsed.data;
  const userId = req.user?.id ?? null;

  try {
    await db.transaction(async (tx) => {
      if (deletedIds.length) {
        await tx.delete(projectPaymentsTable)
          .where(and(eq(projectPaymentsTable.projectId, projectId), inArray(projectPaymentsTable.id, deletedIds)));
      }
      let seq = 1;
      for (const r of rows) {
        // ── 입금완료 상태 정합화(§TOP3) — project_payments 를 입금상태의 Source of Truth 로 유지 ──
        //  · "입금완료"는 세 신호가 모두 있을 때만 성립: depositStatus=completed · depositConfirmed=true · paidDate 존재.
        //  · 하나라도 없으면 미입금으로 정규화하여, 모순 조합(예: completed+confirmed=false, completed+paidDate=null,
        //    confirmed=true+status≠completed, paidDate만 존재+미입금)이 DB에 저장되지 않도록 한다.
        //  · 미입금으로 정규화 시 completed 는 scheduled 로 강등하고, 그 외 상태(scheduled/partial/unpaid)는 유지한다.
        const paidDateVal = r.paidDate || null;
        const isPaid = r.depositConfirmed === true && r.depositStatus === "completed" && paidDateVal !== null;
        const reconciledStatus: (typeof DEPOSIT_STATUS)[number] = isPaid
          ? "completed"
          : (r.depositStatus === "completed" ? "scheduled" : (r.depositStatus ?? "scheduled"));
        const values = {
          sequence: seq++,                         // 회차 자동번호(프로젝트별, 순서 기준)
          issueDate: r.issueDate || null,
          expectedDate: r.expectedDate || null,
          paidDate: isPaid ? paidDateVal : null,
          paymentType: r.paymentType ?? null,
          paymentMethod: r.paymentMethod ?? null,
          supplyAmount: String(r.supplyAmount ?? 0),
          vatAmount: String(r.vatAmount ?? 0),
          amount: String(r.amount ?? 0),
          depositStatus: reconciledStatus,
          depositConfirmed: isPaid,
          paymentCategory: r.paymentCategory ?? "일반결제",
          payer: r.payer ?? null,
          depositItem: r.depositItem ?? null,
          billingCompanyId: r.billingCompanyId ?? null,
          billingContactId: r.billingContactId ?? null,
          note: r.note ?? null,
          updatedBy: userId,
          updatedAt: new Date(),
        };
        if (r.id) {
          await tx.update(projectPaymentsTable).set(values)
            .where(and(eq(projectPaymentsTable.id, r.id), eq(projectPaymentsTable.projectId, projectId)));
        } else {
          await tx.insert(projectPaymentsTable).values({ projectId, createdBy: userId, ...values });
        }
      }
    });
    res.json({ rows: await loadPaymentRecords(projectId) });
  } catch (err) {
    req.log.error({ err }, "결제정보 저장 실패");
    res.status(500).json({ error: "결제정보 저장 중 오류가 발생했습니다." });
  }
});

// ── 수금거래(payment_transactions) 배치 저장 — 청구행 1건에 대한 입금/결제 내역 N건 ──
//  · 청구행(project_payments) 1 : 수금거래 N. 청구행 복제 없이 부분입금(1차/2차…)을 거래 row 로 관리.
//  · 금액 3개념 분리(§E): customer_paid_amount(고객결제) 만 미수금 계산에 사용, settled/fee 는 회계용.
// 빈 문자열·콤마 포함 숫자를 안전하게 number|null 로 정규화(§13 — 유효 입력이 검증 실패하지 않도록).
const money = z.preprocess((v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'string') { const n = Number(v.replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
  return v;
}, z.number().nullable().optional());
const txnRowSchema = z.object({
  id: z.number().int().optional(),
  paidDate: z.string().nullable().optional(),
  method: z.string().max(50).nullable().optional(),
  customerPaidAmount: money,
  settledAmount: money,
  feeAmount: money,
  currency: z.string().max(3).nullable().optional(),
  fxRate: money,
  foreignAmount: money,
  krwAmount: money,
  bankAccount: z.string().nullable().optional(),
  payerName: z.string().nullable().optional(),
  approvalNo: z.string().nullable().optional(),
  cardPgType: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
}).superRefine((r, ctx) => {
  // 필수/조건부 필수(§3/§4) — 결제방법별로 성립 조건이 다르다:
  //  · 외화송금: 통화 + 외화입금액(>0) 이 필수. 원화 고객결제액(customerPaidAmount)은 환산 확정 전이면 0/미확정 허용.
  //    (외화 원장 정보만으로 거래를 저장하되, 원화 미수금은 감소시키지 않는다 — §18 미수금은 customer_paid 기준.)
  //  · 그 외(국내이체·세금계산서·카드·현금·기타): 고객결제금액은 필수(>0).
  if (r.method === '외화송금') {
    if (!r.currency) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currency'], message: '외화송금은 통화가 필요합니다.' });
    if (!(typeof r.foreignAmount === 'number' && r.foreignAmount > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['foreignAmount'], message: '외화송금은 외화입금액이 필요합니다.' });
  } else if (!(typeof r.customerPaidAmount === 'number' && r.customerPaidAmount > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customerPaidAmount'], message: '고객결제금액은 0보다 커야 합니다.' });
  }
});
const txnBatchSchema = z.object({ rows: z.array(txnRowSchema), deletedIds: z.array(z.number().int()).default([]) });

router.put("/admin/project-payments/:paymentId/transactions", ...adminGuard, async (req, res) => {
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(paymentId) || paymentId <= 0) { res.status(400).json({ error: "잘못된 청구행 ID" }); return; }
  const parsed = txnBatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const { rows, deletedIds } = parsed.data;
  const userId = req.user?.id ?? null;

  // 청구행 존재 확인 + projectId 확보(수금거래 denormalized projectId 세팅용).
  const [pay] = await db.select({ id: projectPaymentsTable.id, projectId: projectPaymentsTable.projectId })
    .from(projectPaymentsTable).where(eq(projectPaymentsTable.id, paymentId));
  if (!pay) { res.status(404).json({ error: "청구행을 찾을 수 없습니다." }); return; }

  try {
    await db.transaction(async (tx) => {
      if (deletedIds.length) {
        await tx.delete(paymentTransactionsTable)
          .where(and(eq(paymentTransactionsTable.projectPaymentId, paymentId), inArray(paymentTransactionsTable.id, deletedIds)));
      }
      for (const r of rows) {
        const num = (v: number | null | undefined) => (v == null ? null : String(v));
        const values = {
          paidDate: r.paidDate || null,
          method: r.method ?? null,
          customerPaidAmount: String(r.customerPaidAmount ?? 0),
          settledAmount: num(r.settledAmount),
          feeAmount: num(r.feeAmount),
          currency: r.currency || "KRW",
          fxRate: num(r.fxRate),
          foreignAmount: num(r.foreignAmount),
          krwAmount: num(r.krwAmount),
          bankAccount: r.bankAccount ?? null,
          payerName: r.payerName ?? null,
          approvalNo: r.approvalNo ?? null,
          cardPgType: r.cardPgType ?? null,
          note: r.note ?? null,
          updatedBy: userId,
          updatedAt: new Date(),
        };
        if (r.id) {
          await tx.update(paymentTransactionsTable).set(values)
            .where(and(eq(paymentTransactionsTable.id, r.id), eq(paymentTransactionsTable.projectPaymentId, paymentId)));
        } else {
          await tx.insert(paymentTransactionsTable).values({ projectPaymentId: paymentId, projectId: pay.projectId, createdBy: userId, ...values });
        }
      }
    });
    // 갱신된 프로젝트 전체 청구정보(청구행 + 거래) 반환 → 화면이 미수금/입금상태를 재계산.
    res.json({ rows: await loadPaymentRecords(pay.projectId) });
  } catch (err) {
    req.log.error({ err }, "수금거래 저장 실패");
    res.status(500).json({ error: "수금거래 저장 중 오류가 발생했습니다." });
  }
});

export default router;
