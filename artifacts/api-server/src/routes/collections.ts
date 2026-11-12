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

// ─────────────────────────────────────────────────────────────────────────────
// 판매건별 수금 현황 — GET /admin/collections/sales[?include=legacy]   (READ-ONLY, 저장·수정 없음)
//  · 조회 단위 = 판매건 1건(청구회차가 여러 개여도 판매금액·미수금은 판매건당 1회만 집계).
//  · 판매건 = 판매관리와 같은 기준(projects.status ∉ created·quoted·cancelled), 선입금/차감 견적 판매건 제외(기존 수금현황과 동일).
//  · 총 판매금액 = 현재 견적(is_current·미삭제·derived 제외) price(VAT 포함) — 판매상세 청구정보의 '총 판매금액'과 같은 값.
//  · 실제 누적 입금액 = 청구행별 실입금 합계. 청구행 실입금은 판매상세 청구정보와 같은 규칙:
//      입금거래(payment_transactions) 1건 이상 → SUM(customer_paid_amount),
//      없으면 입금완료 확정(deposit_status=completed AND deposit_confirmed AND paid_date) → 청구액, 그 외 0.
//    입금예정일·세금계산서 발행 여부·청구회차 상태만으로 입금완료 처리하지 않는다.
//  · 수금상태: 입금 0 → unpaid(미입금) / 0 < 입금 < 판매금액 → partial(부분입금) / 입금 ≥ 판매금액 → completed(입금완료),
//    입금 > 판매금액이면 overpaid=true(초과입금 경고).
//  · 세금계산서: 결제방법이 '세금계산서'·'영세율 계산서'·'면세 계산서'인 청구행이 발행 대상, 발행일(issue_date)이 있으면 발행 기록으로 본다(추정 없음).
//      미발행금액 = 발행 대상 청구행 중 발행일 없는 청구액 / 발행 후 입금대기 = 발행된 청구행의 MAX(청구액 − 행 입금, 0)
//      청구 전 금액 = MAX(판매금액 − 청구액 합계, 0)(아직 청구행이 없는 금액 — 발행 대상 여부 미정이라 미발행금액과 분리).
//  · ?include=legacy — 과거 CRM 판매목록 행(판매번호 1건=1행, 위 loadLegacyCollections 판정 그대로)을 함께 반환.
// ─────────────────────────────────────────────────────────────────────────────
export type SaleBaseRow = {
  project_id: number; title: string | null; project_status: string; company_name: string | null;
  quote_number: string | null; price: string | null; pm_name: string | null;
};
export type SalePayRow = {
  id: number; project_id: number; sequence: number; amount: string | null; payment_method: string | null;
  issue_date: string | null; expected_date: string | null; paid_date: string | null;
  deposit_status: string | null; deposit_confirmed: boolean | null; billing_company_name: string | null;
  tx_cnt: string | null; tx_paid: string | null; last_paid_date: string | null;
};
// 발행 대상 — 세금계산서 · 영세율 계산서 · 면세 계산서(청구정보 결제방법, web-app lib/paymentSplit 과 동일 규칙)
const isTaxInvoiceMethod = (m: string | null) => ["세금계산서", "영세율계산서", "면세계산서"].includes((m ?? "").replace(/\s/g, ""));

// 판매건 1건의 수금 집계(순수 함수 — DB 접근 없음). 위 규칙의 단일 구현.
export function summarizeSaleCollection(b: SaleBaseRow, rows: SalePayRow[], today: string) {
  const saleTotal = Number(b.price ?? 0);
  let billed = 0, paidTotal = 0, unissued = 0, issuedAwaiting = 0, invoiceTarget = 0, overdue = false;
  let lastPaidDate: string | null = null, nextExpectedDate: string | null = null;
  const installments = rows.map((r) => {
    const amount = Number(r.amount ?? 0);
    const txCnt = Number(r.tx_cnt ?? 0);
    const paid = txCnt > 0 ? Number(r.tx_paid ?? 0)
      : (r.deposit_status === "completed" && r.deposit_confirmed === true && !!r.paid_date ? amount : 0);
    const rowRecv = Math.max(amount - paid, 0);
    const status: "scheduled" | "partial" | "completed" = paid <= 0 ? "scheduled" : paid < amount ? "partial" : "completed";
    const paidDate = r.last_paid_date ?? (txCnt === 0 && paid > 0 ? r.paid_date : null);
    billed += amount; paidTotal += paid;
    if (paidDate && (!lastPaidDate || paidDate > lastPaidDate)) lastPaidDate = paidDate;
    if (rowRecv > 0 && r.expected_date) {
      if (!nextExpectedDate || r.expected_date < nextExpectedDate) nextExpectedDate = r.expected_date;
      if (r.expected_date < today) overdue = true;
    }
    const invoice = isTaxInvoiceMethod(r.payment_method);
    if (invoice) {
      invoiceTarget += amount;
      if (r.issue_date) issuedAwaiting += rowRecv; else unissued += amount;
    }
    return {
      id: r.id, sequence: r.sequence, amount, paidAmount: paid, receivable: rowRecv, status,
      paymentMethod: r.payment_method, issueDate: r.issue_date, expectedDate: r.expected_date, lastPaidDate: paidDate,
      invoiceTarget: invoice, billingCompanyName: r.billing_company_name,
    };
  });
  const receivable = Math.max(saleTotal - paidTotal, 0);
  const status: "unpaid" | "partial" | "completed" = paidTotal <= 0 && saleTotal > 0 ? "unpaid" : paidTotal < saleTotal ? "partial" : "completed";
  return {
    rowKey: `sale:${b.project_id}`, source: "current" as const, projectId: b.project_id, legacyRowId: null,
    saleNumber: b.quote_number, projectTitle: b.title, projectStatus: b.project_status,
    companyName: b.company_name ?? installments.find((i) => i.billingCompanyName)?.billingCompanyName ?? null,
    saleTotal, paidAmount: paidTotal, receivable,
    paidRate: saleTotal > 0 ? Math.round((paidTotal / saleTotal) * 1000) / 10 : null,
    status, overpaid: paidTotal > saleTotal, overpaidAmount: Math.max(paidTotal - saleTotal, 0),
    billedAmount: billed, unbilledAmount: Math.max(saleTotal - billed, 0),
    invoiceTargetAmount: invoiceTarget, unissuedAmount: unissued, issuedAwaitingAmount: issuedAwaiting,
    installments, lastPaidDate, nextExpectedDate, overdue: overdue && receivable > 0,
    pmName: b.pm_name, reviewReason: null as string | null,
  };
}

router.get("/admin/collections/sales", ...adminGuard, requireStaffPermission(["payment.view", "menu.payment"], { allowStaffWithoutRole: true }), async (req, res) => {
  try {
    const base = await db.execute<SaleBaseRow>(sql`
      SELECT p.id AS project_id, p.title, p.status AS project_status,
        c.name AS company_name, q.quote_number, q.price,
        (SELECT u.name FROM users u WHERE u.id = p.admin_id) AS pm_name
      FROM projects p
      LEFT JOIN companies c ON c.id = p.company_id
      LEFT JOIN LATERAL (
        SELECT q1.quote_number, q1.price FROM quotes q1
        WHERE q1.project_id = p.id AND q1.is_current = true AND q1.deleted_at IS NULL
          AND (q1.relation_type IS NULL OR q1.relation_type <> 'derived')
        ORDER BY q1.id DESC LIMIT 1
      ) q ON true
      WHERE p.status NOT IN ('created', 'quoted', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM quotes q2
          WHERE q2.project_id = p.id AND q2.is_current = true AND q2.deleted_at IS NULL
            AND q2.quote_type IN ('b2c_prepaid', 'prepaid_deduction')
        )
      ORDER BY p.id DESC`);
    const pids = base.rows.map((r) => r.project_id);
    const pays = pids.length ? await db.execute<SalePayRow>(sql`
      SELECT pp.id, pp.project_id, pp.sequence, pp.amount, pp.payment_method, pp.issue_date, pp.expected_date, pp.paid_date,
        pp.deposit_status, pp.deposit_confirmed, c.name AS billing_company_name,
        COALESCE(tx.tx_cnt, 0) AS tx_cnt, COALESCE(tx.tx_paid, 0) AS tx_paid, tx.last_paid_date
      FROM project_payments pp
      LEFT JOIN companies c ON c.id = pp.billing_company_id
      LEFT JOIN (
        SELECT project_payment_id, COUNT(*) AS tx_cnt, COALESCE(SUM(customer_paid_amount), 0) AS tx_paid, MAX(paid_date) AS last_paid_date
        FROM payment_transactions GROUP BY project_payment_id
      ) tx ON tx.project_payment_id = pp.id
      WHERE pp.project_id IN (${sql.join(pids.map((i) => sql`${i}`), sql`, `)})
      ORDER BY pp.project_id, pp.sequence, pp.id`) : { rows: [] as SalePayRow[] };
    const payByProject = new Map<number, SalePayRow[]>();
    for (const r of pays.rows) { const a = payByProject.get(r.project_id) ?? []; a.push(r); payByProject.set(r.project_id, a); }

    const today = todayKst();
    const sales = base.rows.map((b) => summarizeSaleCollection(b, payByProject.get(b.project_id) ?? [], today));

    const includeLegacy = String(req.query.include ?? "") === "legacy";
    const legacy = includeLegacy ? await loadLegacyCollections() : null;
    const legacySales = (legacy?.rows ?? []).map((l) => ({
      rowKey: l.rowKey, source: "legacy" as const, projectId: null, legacyRowId: l.legacyRowId,
      saleNumber: l.quoteNumber, projectTitle: l.projectTitle, projectStatus: null,
      companyName: l.billingCompanyName,
      saleTotal: l.amount, paidAmount: l.paidAmount, receivable: l.receivable,
      paidRate: l.paidAmount != null && l.amount > 0 ? Math.round((l.paidAmount / l.amount) * 1000) / 10 : null,
      // 과거 CRM 판정 그대로: 입금예정(원본 입금기록 없음) → 미입금, 입금완료 → 입금완료, 확인 필요 → review(집계 제외)
      status: (l.status === "scheduled" ? "unpaid" : l.status) as "unpaid" | "completed" | "review",
      overpaid: false, overpaidAmount: 0,
      billedAmount: null, unbilledAmount: null,
      invoiceTargetAmount: null, unissuedAmount: null, issuedAwaitingAmount: null,
      installments: [], lastPaidDate: l.lastPaidDate, nextExpectedDate: null, overdue: false,
      pmName: l.pmName, reviewReason: l.reviewReason, parsedDepositAmount: l.parsedDepositAmount, saleDate: l.saleDate,
    }));
    const all = [...sales, ...legacySales];
    const counted = all.filter((r) => r.status !== "review");
    const sum = (xs: typeof all, f: (r: (typeof all)[number]) => number | null) => xs.reduce((s, r) => s + (f(r) ?? 0), 0);
    const by = (st: string) => counted.filter((r) => r.status === st);
    const summary = {
      count: counted.length,
      totalSales: sum(counted, (r) => r.saleTotal),
      totalPaid: sum(counted, (r) => r.paidAmount),
      totalReceivable: sum(counted, (r) => r.receivable),
      unpaid: { count: by("unpaid").length, amount: sum(by("unpaid"), (r) => r.receivable) },
      partial: { count: by("partial").length, receivable: sum(by("partial"), (r) => r.receivable), paid: sum(by("partial"), (r) => r.paidAmount) },
      completed: { count: by("completed").length, amount: sum(by("completed"), (r) => r.saleTotal) },
      overpaid: { count: counted.filter((r) => r.overpaid).length, amount: sum(counted, (r) => r.overpaidAmount) },
      unbilled: sum(sales, (r) => r.unbilledAmount),
      unissued: sum(sales, (r) => r.unissuedAmount),
      issuedAwaiting: sum(sales, (r) => r.issuedAwaitingAmount),
      overdueCount: counted.filter((r) => r.overdue).length,
      review: legacy ? { count: all.length - counted.length, totalAmount: sum(all.filter((r) => r.status === "review"), (r) => r.saleTotal) } : undefined,
      sources: legacy ? { current: sales.length, legacy: legacySales.length, legacyLinkedExcluded: legacy.linkedExcluded } : undefined,
    };
    res.json({ summary, rows: all });
  } catch (err) {
    req.log.error({ err }, "판매건별 수금 현황 조회 실패");
    res.status(500).json({ error: "판매건별 수금 현황 조회 중 오류가 발생했습니다." });
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
