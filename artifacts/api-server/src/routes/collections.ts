// ─────────────────────────────────────────────────────────────────────────────
// 수금 현황 (통합 수금 조회) API — 회사 전체 기준 청구/입금/미수 통합 조회.
//  · SSOT: project_payments(청구) + payment_transactions(실입금). 레거시 payments 테이블은 사용하지 않는다.
//  · 조회 기본 단위 = project_payments 1행(청구행). 분할청구면 판매 1건이 여러 행으로 표시된다.
//  · READ-ONLY. 입력/수정은 '판매상세 > 청구정보'(projectPayments.ts)가 담당한다.
//  · 미수금 계산 SSOT(§4/§5):
//      - payment_transactions 1건 이상  → 실입금 = SUM(customer_paid_amount)  (신규 거래 기준)
//      - payment_transactions 0건        → legacy fallback: deposit_status='completed' 이면 실입금 = amount, 그 외 0
//      - 두 경로 금액을 절대 합산하지 않는다(한 청구행은 둘 중 하나의 기준만 사용).
//  · 선입금/차감(b2c_prepaid·prepaid_deduction) 견적은 prepaid_ledger 별도 SSOT → 수금 현황에서 제외(§6).
//    → 기존 재무 집계와 동일 기준(isPrepaidDeductionQuoteType / PREPAID_DEDUCTION_QUOTE_TYPES).
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, paymentTransactionsTable } from "@workspace/db";
import { inArray, asc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// KST(UTC+9) 기준 오늘 날짜 문자열 — 기한경과(overdue) 판정용(예정일 < 오늘 AND 미수금>0).
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

type MainRow = {
  id: number;
  project_id: number;
  sequence: number;
  amount: string | null;
  supply_amount: string | null;
  vat_amount: string | null;
  issue_date: string | null;
  expected_date: string | null;
  paid_date: string | null;
  payment_method: string | null;
  deposit_status: string | null;
  deposit_confirmed: boolean | null;
  note: string | null;
  billing_company_id: number | null;
  billing_company_name: string | null;
  project_title: string | null;
  admin_id: number | null;
  pm_name: string | null;
  quote_number: string | null;
  tx_cnt: string | null;
  tx_paid: string | null;
  last_paid_date: string | null;
};

router.get("/admin/collections", ...adminGuard, async (req, res) => {
  try {
    // ── 메인 쿼리(1회): 청구행 + 청구업체 + 프로젝트/담당PM + 현재견적번호 + 거래 집계(cnt/sum/최근입금일) ──
    //  · 선입/차감 견적행 제외: 현재견적(is_current) quote_type ∈ (b2c_prepaid, prepaid_deduction) → NOT EXISTS.
    const main = await db.execute<MainRow>(sql`
      SELECT
        pp.id, pp.project_id, pp.sequence,
        pp.amount, pp.supply_amount, pp.vat_amount,
        pp.issue_date, pp.expected_date, pp.paid_date,
        pp.payment_method, pp.deposit_status, pp.deposit_confirmed,
        pp.note, pp.billing_company_id,
        c.name AS billing_company_name,
        p.title AS project_title,
        p.admin_id,
        (SELECT u.name FROM users u WHERE u.id = p.admin_id) AS pm_name,
        (SELECT q.quote_number FROM quotes q
           WHERE q.project_id = pp.project_id AND q.is_current = true AND q.deleted_at IS NULL
           ORDER BY q.id DESC LIMIT 1) AS quote_number,
        COALESCE(tx.tx_cnt, 0)  AS tx_cnt,
        COALESCE(tx.tx_paid, 0) AS tx_paid,
        tx.last_paid_date       AS last_paid_date
      FROM project_payments pp
      JOIN projects p ON p.id = pp.project_id
      LEFT JOIN companies c ON c.id = pp.billing_company_id
      LEFT JOIN (
        SELECT project_payment_id,
               COUNT(*)                          AS tx_cnt,
               COALESCE(SUM(customer_paid_amount), 0) AS tx_paid,
               MAX(paid_date)                    AS last_paid_date
        FROM payment_transactions
        GROUP BY project_payment_id
      ) tx ON tx.project_payment_id = pp.id
      WHERE NOT EXISTS (
        SELECT 1 FROM quotes q2
        WHERE q2.project_id = pp.project_id
          AND q2.is_current = true AND q2.deleted_at IS NULL
          AND q2.quote_type IN ('b2c_prepaid', 'prepaid_deduction')
      )
      ORDER BY pp.project_id DESC, pp.sequence ASC
    `);

    const rows = main.rows;
    const ids = rows.map((r) => r.id);

    // ── 보조 쿼리(1회): 통화/외화입금·입금은행 — 반환 청구행에 속한 거래만 조회 후 JS 집계(N+1 회피). ──
    const txns = ids.length
      ? await db
          .select({
            projectPaymentId: paymentTransactionsTable.projectPaymentId,
            id: paymentTransactionsTable.id,
            paidDate: paymentTransactionsTable.paidDate,
            currency: paymentTransactionsTable.currency,
            foreignAmount: paymentTransactionsTable.foreignAmount,
            bankAccount: paymentTransactionsTable.bankAccount,
          })
          .from(paymentTransactionsTable)
          .where(inArray(paymentTransactionsTable.projectPaymentId, ids))
          .orderBy(asc(paymentTransactionsTable.projectPaymentId), asc(paymentTransactionsTable.paidDate), asc(paymentTransactionsTable.id))
      : [];

    // 청구행별: 최근 입금은행(마지막 non-null bankAccount) + 외화 통화별 합계(KRW 제외).
    const bankByPay = new Map<number, string>();
    const fxByPay = new Map<number, Map<string, number>>();
    for (const t of txns) {
      if (t.bankAccount) bankByPay.set(t.projectPaymentId, t.bankAccount);
      const cur = (t.currency ?? "KRW").toUpperCase();
      const fa = t.foreignAmount != null ? Number(t.foreignAmount) : 0;
      if (cur !== "KRW" && fa > 0) {
        const m = fxByPay.get(t.projectPaymentId) ?? new Map<string, number>();
        m.set(cur, (m.get(cur) ?? 0) + fa);
        fxByPay.set(t.projectPaymentId, m);
      }
    }

    const today = todayKst();

    const out = rows.map((r) => {
      const amount = Number(r.amount ?? 0);
      const txCnt = Number(r.tx_cnt ?? 0);
      const isLegacyFallback = txCnt === 0;

      // 실입금액: 거래 존재 시 SUM(customer_paid_amount), 없으면 legacy fallback(completed → 전액, 그 외 0).
      let paidAmount: number;
      if (txCnt > 0) {
        paidAmount = Number(r.tx_paid ?? 0);
      } else {
        paidAmount = r.deposit_status === "completed" ? amount : 0;
      }
      const receivable = Math.max(amount - paidAmount, 0);

      // 입금상태(신규 거래 기준 재계산) — legacy completed 라도 거래가 있으면 거래 기준을 우선(§13).
      let status: "scheduled" | "partial" | "completed";
      if (paidAmount <= 0) status = "scheduled";
      else if (paidAmount < amount) status = "partial";
      else status = "completed";

      const lastPaidDate = r.last_paid_date ?? (isLegacyFallback ? r.paid_date : null);
      const overdue = receivable > 0 && !!r.expected_date && r.expected_date < today;

      const fx = fxByPay.get(r.id);
      const foreign = fx ? Array.from(fx.entries()).map(([currency, foreignAmount]) => ({ currency, foreignAmount })) : [];

      return {
        id: r.id,
        projectId: r.project_id,
        sequence: r.sequence,
        quoteNumber: r.quote_number,
        projectTitle: r.project_title,
        billingCompanyId: r.billing_company_id,
        billingCompanyName: r.billing_company_name,
        paymentMethod: r.payment_method,
        issueDate: r.issue_date,
        expectedDate: r.expected_date,
        lastPaidDate,
        amount,
        paidAmount,
        receivable,
        status,          // 입금예정(scheduled) · 부분입금(partial) · 입금완료(completed)
        overdue,         // 기한경과(예정일 경과 + 미수금 존재) — 저장하지 않는 파생값
        depositStatus: r.deposit_status,   // 원본 청구행 상태(참고용)
        isLegacyFallback,                  // 거래 0건 → legacy 청구행 기준으로 계산됨
        bankAccount: bankByPay.get(r.id) ?? null,
        foreign,         // 외화입금 [{ currency, foreignAmount }] (KRW 제외)
        pmName: r.pm_name,
        note: r.note,
      };
    });

    // ── 상단 요약 — 조회 대상(선입/차감 제외) 청구행 합계. 매출 중복집계 없음(청구행별 1회). ──
    const summary = {
      count: out.length,
      totalBilled: out.reduce((s, r) => s + r.amount, 0),
      totalPaid: out.reduce((s, r) => s + r.paidAmount, 0),
      totalReceivable: out.reduce((s, r) => s + r.receivable, 0),
      completedCount: out.filter((r) => r.status === "completed").length,
      partialCount: out.filter((r) => r.status === "partial").length,
      scheduledCount: out.filter((r) => r.status === "scheduled").length,
      receivableCount: out.filter((r) => r.receivable > 0).length,
      overdueCount: out.filter((r) => r.overdue).length,
    };

    res.json({ summary, rows: out });
  } catch (err) {
    req.log.error({ err }, "수금 현황 조회 실패");
    res.status(500).json({ error: "수금 현황 조회 중 오류가 발생했습니다." });
  }
});

export default router;
