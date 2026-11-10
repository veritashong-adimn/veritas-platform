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
//  · ?include=legacy — 과거 CRM 판매목록(legacy_archive_rows sales_list, is_effective) 판매번호 1건 = 1행 통합(읽기 전용).
//      - 수금 판정은 과거 판매 전환과 같은 기준(parseDepositAmounts): 입금일 + 입금내역 금액합계 = 총액 → 입금완료,
//        입금일·입금내역 모두 없음 → 입금예정(미수), 그 외 → '확인 필요'(review: 입금액·미수금 미확정, 상단 집계 제외).
//      - 신규 판매로 전환된 판매번호(legacy_master_mappings old_crm/sale, rolled_back 제외)는 신규 청구행으로 집계되므로 제외(중복 방지).
//      - 원본에 없는 입금예정일·결제방법·입금은행은 null(추정 없음). 원본 수정·청구회차 생성 없음.
//    파라미터가 없으면 기존 응답(신규 청구행만) 그대로.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, paymentTransactionsTable } from "@workspace/db";
import { inArray, asc, sql } from "drizzle-orm";
import { requireAuth, requireRole, requireStaffPermission } from "../middlewares/auth";
import { parseDepositAmounts } from "../services/legacySaleActivation";

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

router.get("/admin/collections", ...adminGuard, requireStaffPermission(["payment.view", "menu.payment"], { allowStaffWithoutRole: true }), async (req, res) => {
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

    const includeLegacy = String(req.query.include ?? "") === "legacy";
    const legacy = includeLegacy ? await loadLegacyCollections() : null;
    const all: any[] = includeLegacy
      ? [...out.map((r) => ({ ...r, source: "current", rowKey: `current:${r.id}`, legacyRowId: null })), ...legacy!.rows]
      : out;
    // 집계 대상 = 금액이 확정된 행(신규 전체 + 과거 입금완료·입금예정). '확인 필요'는 별도 집계.
    const counted = all.filter((r) => r.status !== "review");

    // ── 상단 요약 — 조회 대상(선입/차감 제외) 청구행 합계. 매출 중복집계 없음(청구행별 1회). ──
    const summary: Record<string, unknown> = {
      count: counted.length,
      totalBilled: counted.reduce((s, r) => s + r.amount, 0),
      totalPaid: counted.reduce((s, r) => s + r.paidAmount, 0),
      totalReceivable: counted.reduce((s, r) => s + r.receivable, 0),
      completedCount: counted.filter((r) => r.status === "completed").length,
      partialCount: counted.filter((r) => r.status === "partial").length,
      scheduledCount: counted.filter((r) => r.status === "scheduled").length,
      receivableCount: counted.filter((r) => r.receivable > 0).length,
      overdueCount: counted.filter((r) => r.overdue).length,
    };
    if (legacy) {
      const review = all.filter((r) => r.status === "review");
      summary.review = { count: review.length, totalAmount: review.reduce((s, r) => s + r.amount, 0) };
      summary.sources = { current: out.length, legacy: legacy.rows.length, legacyLinkedExcluded: legacy.linkedExcluded };
    }

    res.json({ summary, rows: all });
  } catch (err) {
    req.log.error({ err }, "수금 현황 조회 실패");
    res.status(500).json({ error: "수금 현황 조회 중 오류가 발생했습니다." });
  }
});

// ── 과거 CRM 판매목록 → 수금 현황 행(읽기 전용) ─────────────────────────────────
type LegacySaleRow = {
  id: number; sale_no: string | null; total: string | null; deposit_date: string | null; deposit_memo: string | null;
  invoice_date: string | null; client: string | null; product: string | null; opportunity: string | null; sales_rep: string | null;
  sale_date: string | null;
};
async function loadLegacyCollections() {
  const r = await db.execute<LegacySaleRow>(sql`
    WITH linked AS (
      SELECT DISTINCT btrim(legacy_id) AS sale_no FROM legacy_master_mappings
      WHERE source_system = 'old_crm' AND entity_type = 'sale' AND status <> 'rolled_back'
    ), src AS (
      SELECT l.id,
        nullif(btrim(l.source_raw->>'판매번호'), '') AS sale_no,
        coalesce(l.total_amount::text, nullif(regexp_replace(coalesce(l.source_raw->>'총액',''), '[^0-9.-]', '', 'g'), '')) AS total,
        coalesce(to_char(l.collection_date, 'YYYY-MM-DD'), substring(l.source_raw->>'입금일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')) AS deposit_date,
        nullif(btrim(l.source_raw->>'입금내역'), '') AS deposit_memo,
        substring(l.source_raw->>'세금계산서발행(예정)일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS invoice_date,
        nullif(btrim(l.source_raw->>'거래처명'), '') AS client,
        nullif(btrim(l.source_raw->>'상품명'), '') AS product,
        nullif(btrim(l.source_raw->>'영업기회명'), '') AS opportunity,
        nullif(btrim(l.source_raw->>'영업담당자'), '') AS sales_rep,
        coalesce(substring(l.source_raw->>'판매번호' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'), to_char(l.record_date, 'YYYY-MM-DD')) AS sale_date
      FROM legacy_archive_rows l
      WHERE l.source_type = 'sales_list' AND l.is_effective = true
    )
    SELECT src.*, (src.sale_no IN (SELECT sale_no FROM linked)) AS linked FROM src`);
  const all = r.rows as (LegacySaleRow & { linked: boolean })[];
  const rows = all.filter((x) => !x.linked).map((x) => {
    const amount = Number(x.total ?? 0) || 0;
    const amounts = parseDepositAmounts(x.deposit_memo);
    const parsedSum = amounts.reduce((s, n) => s + n, 0);
    // 과거 판매 전환(legacySaleActivation)과 같은 수금 판정 — 새 해석 규칙 없음.
    let status: "scheduled" | "completed" | "review"; let reviewReason: string | null = null;
    if (amount <= 0) { status = "review"; reviewReason = "판매 총액 0 또는 없음"; }
    else if (!x.deposit_date && !x.deposit_memo) status = "scheduled";                   // 원본 입금기록 없음(미수금)
    else if (!x.deposit_date) { status = "review"; reviewReason = "입금일 없음"; }
    else if (!amounts.length) { status = "review"; reviewReason = "입금내역에서 금액을 확인할 수 없음"; }
    else if (parsedSum !== amount) { status = "review"; reviewReason = parsedSum < amount ? "입금합계 < 판매금액(부분입금 가능성)" : "입금합계 > 판매금액(일괄입금 등)"; }
    else status = "completed";
    const confirmed = status !== "review";
    const paidAmount = status === "completed" ? amount : status === "scheduled" ? 0 : null;
    return {
      id: -x.id,                         // 신규 청구행 id 와 충돌 방지(음수) — 식별은 rowKey/legacyRowId 사용
      rowKey: `legacy:${x.id}`, legacyRowId: x.id, source: "legacy",
      projectId: null, sequence: 1,
      quoteNumber: x.sale_no,            // 과거 CRM 판매번호
      projectTitle: x.opportunity ?? x.product,
      billingCompanyId: null, billingCompanyName: x.client,
      paymentMethod: null,
      issueDate: x.invoice_date,         // 원본 '세금계산서발행(예정)일'
      expectedDate: null,                // 원본에 입금예정일 없음(추정 금지)
      lastPaidDate: x.deposit_date,
      amount,
      paidAmount,                        // review → null(미확정)
      receivable: confirmed ? Math.max(amount - (paidAmount ?? 0), 0) : null,
      status, reviewReason, parsedDepositAmount: amounts.length ? parsedSum : null,
      overdue: false,                    // 입금예정일 없음 → 기한경과 판정 불가
      depositStatus: null, isLegacyFallback: false,
      bankAccount: null, foreign: [],
      pmName: x.sales_rep,
      note: x.deposit_memo,              // 원본 입금내역(원문 그대로)
      saleDate: x.sale_date,
    };
  });
  return { rows, linkedExcluded: all.length - rows.length };
}

export default router;
