// ─────────────────────────────────────────────────────────────────────────────
// 결제정보 (고객 수금) API — 프로젝트별 고객 결제 현황.
//  · 고객→우리 수금 기록(통번역사 지급 settlements 와는 별개).
//  · GET 프로젝트 상세(admin.ts)에서 paymentRecords[] 로 함께 반환 → 별도 조회 엔드포인트 불필요.
//  · 배치 저장(rows + deletedIds)만 제공. 회차(sequence)는 서버에서 순서대로 자동번호.
//  · 미수금은 저장하지 않고 화면에서 계산(총 판매금액 − 총 입금액).
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, projectPaymentsTable, paymentTransactionsTable, companiesTable, contactsTable } from "@workspace/db";
import { eq, and, inArray, asc, getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole, requireRolePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { fetchCompanyName, fetchContactName } from "../lib/nameSnapshot";
import { summarizeFxRow, isForeignCurrency, toScaled, fromScaled, krwOf, FX_CURRENCIES, loadFxSummaries } from "../services/fxBilling";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// 프로젝트 상세 응답에 포함 — 회차 오름차순. 청구업체·담당자 이름 조인 + 청구행별 수금거래(transactions[]) 첨부.
export async function loadPaymentRecords(projectId: number) {
  const records = await db
    .select({
      ...getTableColumns(projectPaymentsTable),
      // 표시명 = 청구 당시 Snapshot 우선 → 없으면 현재 Master명 fallback(§Phase3)
      billingCompanyName: sql<string | null>`COALESCE(${projectPaymentsTable.billingCompanyNameSnapshot}, ${companiesTable.name})`,
      billingContactName: sql<string | null>`COALESCE(${projectPaymentsTable.billingContactNameSnapshot}, ${contactsTable.name})`,
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
  // 외화 청구회차 — 외화 기준 수금 요약(fx) 첨부(additive). 이 회차를 원천으로 다른 회차에 상계한 거래(offsetsOut)도 반영.
  const fxIds = records.filter((r) => isForeignCurrency(r.billingCurrency)).map((r) => r.id);
  const outs = fxIds.length ? await db.select().from(paymentTransactionsTable).where(inArray(paymentTransactionsTable.offsetSourcePaymentId, fxIds)) : [];
  return records.map((r) => {
    const own = byPayment.get(r.id) ?? [];
    const fx = isForeignCurrency(r.billingCurrency) ? summarizeFxRow(fxBill(r), own.map(fxTxn), outs.filter((o) => o.offsetSourcePaymentId === r.id).map(fxTxn)) : null;
    return { ...r, transactions: own, fx };
  });
}
// drizzle(camelCase) → fxBilling 입력(snake)
export const fxBill = (r: any) => ({ id: r.id, amount: r.amount, billing_currency: r.billingCurrency, foreign_amount: r.foreignAmount, invoice_fx_rate: r.invoiceFxRate, invoice_fx_date: r.invoiceFxDate });
const isCardMethod = (m?: string | null) => ["카드", "신용카드", "card"].includes(String(m ?? "").trim());
export const fxTxn = (t: any) => ({ txn_type: t.txnType, currency: t.currency, foreign_amount: t.foreignAmount, fx_rate: t.fxRate, krw_amount: t.krwAmount, fee_amount: t.feeAmount, offset_source_payment_id: t.offsetSourcePaymentId, paid_date: t.paidDate });

// 청구업체 표시명 결정(회차 1건) — 사용자가 저장한 청구업체를 판매 거래처/Master 이름으로 덮어쓰지 않는다.
//  ① 같은 거래처 연결 + 이름 미변경(또는 이름 미전송) → 기존 Snapshot 유지(과거 CRM 원본명·당시 이름 보존)
//  ② 거래처 Master 선택(id) → 입력 이름(없으면 Master 이름)
//  ③ Master 미연결(id 없음) → 입력한 업체명 그대로(직접입력). 비어 있으면 null.
type PrevPay = typeof projectPaymentsTable.$inferSelect;
async function resolveBillingCompanyName(tx: any, r: { billingCompanyId?: number | null; billingCompanyName?: string | null }, prev?: PrevPay): Promise<string | null> {
  const id = r.billingCompanyId ?? null;
  const typed = r.billingCompanyName === undefined ? undefined : ((r.billingCompanyName ?? "").trim() || null);
  if (prev && (prev.billingCompanyId ?? null) === id) {
    const prevDisplay = prev.billingCompanyNameSnapshot ?? await fetchCompanyName(tx, prev.billingCompanyId ?? null);
    if (typed === undefined || typed === prevDisplay) return prev.billingCompanyNameSnapshot ?? prevDisplay;
  }
  if (id != null) return typed ?? await fetchCompanyName(tx, id);
  return typed ?? null;
}

// 외화 청구 필드 저장값 — 원화 청구(NULL/KRW)면 외화 필드 모두 NULL. 요청에 없으면(구버전) 기존 값 유지.
function fxBillingValues(r: { billingCurrency?: string | null; foreignAmount?: unknown; invoiceFxRate?: unknown; invoiceFxDate?: string | null }, prev?: PrevPay) {
  if (r.billingCurrency === undefined) {
    return prev ? {} : { billingCurrency: null, foreignAmount: null, invoiceFxRate: null, invoiceFxDate: null };
  }
  const cur = (r.billingCurrency ?? "").trim().toUpperCase();
  if (!cur || cur === "KRW") return { billingCurrency: null, foreignAmount: null, invoiceFxRate: null, invoiceFxDate: null };
  const fa = toScaled(r.foreignAmount, 2), rate = toScaled(r.invoiceFxRate, 6);
  return { billingCurrency: cur, foreignAmount: fa != null ? fromScaled(fa, 2) : null, invoiceFxRate: rate != null ? fromScaled(rate, 6) : null, invoiceFxDate: r.invoiceFxDate || null };
}
function fxBillingError(r: { billingCurrency?: string | null; foreignAmount?: unknown; invoiceFxRate?: unknown }): string | null {
  const cur = (r.billingCurrency ?? "").trim().toUpperCase();
  if (!cur || cur === "KRW") return null;
  if (!(FX_CURRENCIES as readonly string[]).includes(cur)) return `지원하지 않는 청구통화(${cur})`;
  const fa = toScaled(r.foreignAmount, 2);
  if (r.foreignAmount != null && r.foreignAmount !== "" && (fa == null || fa < 0n)) return "외화 청구금액 형식 오류";
  const rate = toScaled(r.invoiceFxRate, 6);
  if (r.invoiceFxRate != null && r.invoiceFxRate !== "" && (rate == null || rate <= 0n)) return "인보이스 환율 형식 오류";
  return null;
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
  billingCompanyId: z.number().int().nullable().optional(),    // 청구업체(거래처 Master 연결, 선택)
  // 청구업체 표시명(회차별) — 화면에서 입력·선택한 이름. 거래처 Master 에 없는 업체는 id 없이 이름만 저장(Master 생성·수정 없음).
  //  생략(undefined) 시 기존 동작(Master 이름) 유지 — 구버전 호출 호환.
  billingCompanyName: z.string().max(200).nullable().optional(),
  billingContactId: z.number().int().nullable().optional(),    // 담당자
  note: z.string().nullable().optional(),
  // 입금은행(청구 회차 단위)·은행 확인 — 생략(undefined) 시 기존 값 유지(구버전 화면 호환).
  depositBank: z.string().max(100).nullable().optional(),
  depositBankConfirmed: z.boolean().nullable().optional(),
  // 외화 청구(선택) — 생략 시 기존 값 유지. NULL/'KRW' = 원화 청구. 금액·환율은 문자열로 받아 정밀도 보존.
  billingCurrency: z.string().max(3).nullable().optional(),
  foreignAmount: z.union([z.string(), z.number()]).nullable().optional(),
  invoiceFxRate: z.union([z.string(), z.number()]).nullable().optional(),
  invoiceFxDate: z.string().nullable().optional(),
});
const batchSchema = z.object({
  rows: z.array(rowSchema),
  deletedIds: z.array(z.number().int()).default([]),
});

// 배치 저장 — 삭제 후 upsert. 회차는 전송된 순서대로 1..N 재부여(자동번호).
router.put("/admin/projects/:id/payment-records", ...adminGuard, requireRolePermission("payment.update"), async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const { rows, deletedIds } = parsed.data;
  const userId = req.user?.id ?? null;

  // 입금확인(확정) 수금기록 보호 — 삭제·금액·입금일·확인해제는 일반 저장으로 불가(비고·청구정보 등은 수정 가능).
  const before = await db.select().from(projectPaymentsTable).where(eq(projectPaymentsTable.projectId, projectId));
  // 전액 환불된 회차(입금거래가 있고 순입금액 ≤ 0) — 입금확인 보호에서 제외: 청구금액·결제유형 수정 가능(입금·환불 거래 이력은 그대로 보존)
  const txAgg = before.length ? (await db.select({ pid: paymentTransactionsTable.projectPaymentId,
      net: sql<string>`coalesce(sum(${paymentTransactionsTable.customerPaidAmount}), 0)`,
      refunds: sql<number>`count(*) filter (where ${paymentTransactionsTable.txnType} = 'refund')::int` })
    .from(paymentTransactionsTable).where(inArray(paymentTransactionsTable.projectPaymentId, before.map(b => b.id)))
    .groupBy(paymentTransactionsTable.projectPaymentId)) : [];
  const fullyRefunded = new Set(txAgg.filter(a => Number(a.refunds) > 0 && Number(a.net) <= 0.005).map(a => a.pid));
  const hasRefundHistory = new Set(txAgg.filter(a => Number(a.refunds) > 0).map(a => a.pid));
  const confirmedById = new Map(before.filter(b => b.depositConfirmed && !fullyRefunded.has(b.id)).map(b => [b.id, b]));
  const beforeById = new Map(before.map(b => [b.id, b]));
  const delLocked = deletedIds.filter(id => confirmedById.has(id));
  if (delLocked.length) { res.status(409).json({ error: `입금확인된 수금기록은 삭제할 수 없습니다 (id: ${delLocked.join(", ")}).` }); return; }
  // 환불 이력이 있는 회차는 삭제 금지(삭제 시 입금·환불 거래가 함께 지워짐) — 금액·결제유형 수정으로 정리
  const refundDel = deletedIds.filter(id => hasRefundHistory.has(id));
  if (refundDel.length) { res.status(409).json({ error: `입금·환불 이력이 있는 청구회차는 삭제할 수 없습니다 (id: ${refundDel.join(", ")}). 청구금액·결제유형을 수정하세요.` }); return; }
  const n2 = (v: unknown) => Number(v ?? 0).toFixed(2);
  for (const r of rows) {
    const b = r.id ? confirmedById.get(r.id) : undefined;
    if (!b) continue;
    const confirmedNow = r.depositConfirmed === true && r.depositStatus === "completed" && !!r.paidDate;
    if (!confirmedNow || (r.paidDate || null) !== (b.paidDate ? String(b.paidDate).slice(0, 10) : null)
        || n2(r.amount) !== n2(b.amount) || n2(r.supplyAmount) !== n2(b.supplyAmount) || n2(r.vatAmount) !== n2(b.vatAmount)) {
      res.status(409).json({ error: `입금확인된 수금기록(id ${b.id})의 금액·입금일·확인상태는 변경할 수 없습니다.` }); return;
    }
  }

  for (const [i, r] of rows.entries()) {
    const e = fxBillingError(r);
    if (e) { res.status(400).json({ error: `${i + 1}회차: ${e}` }); return; }
  }
  // 입금·상계 거래가 있는 회차의 청구통화 변경 금지(기존 입금기록의 통화 의미 보호)
  const txOwners = before.length ? new Set((await db.select({ pid: paymentTransactionsTable.projectPaymentId }).from(paymentTransactionsTable)
    .where(inArray(paymentTransactionsTable.projectPaymentId, before.map(b => b.id)))).map(t => t.pid)) : new Set<number>();
  for (const [i, r] of rows.entries()) {
    const b = r.id ? beforeById.get(r.id) : undefined;
    if (!b || r.billingCurrency === undefined || !txOwners.has(b.id)) continue;
    const norm = (c?: string | null) => { const v = (c ?? "").trim().toUpperCase(); return v && v !== "KRW" ? v : null; };
    if (norm(r.billingCurrency) !== norm(b.billingCurrency)) {
      res.status(409).json({ error: `${i + 1}회차: 입금기록이 있는 청구회차의 청구통화는 변경할 수 없습니다(${norm(b.billingCurrency) ?? "KRW"} → ${norm(r.billingCurrency) ?? "KRW"}).` }); return;
    }
  }
  // 다른 회차의 상계 원천으로 사용된 청구회차는 삭제 금지(상계 근거 보존)
  if (deletedIds.length) {
    const used = await db.select({ id: paymentTransactionsTable.id, src: paymentTransactionsTable.offsetSourcePaymentId }).from(paymentTransactionsTable)
      .where(inArray(paymentTransactionsTable.offsetSourcePaymentId, deletedIds));
    if (used.length) { res.status(409).json({ error: `상계 원천으로 사용된 청구회차는 삭제할 수 없습니다 (id: ${[...new Set(used.map(u => u.src))].join(", ")}).` }); return; }
  }

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
        // 청구업체·담당자 표시명 Snapshot — 회차별 저장값 우선(§청구업체 독립 저장).
        const prev = r.id ? beforeById.get(r.id) : undefined;
        const billingCompanyNameSnapshot = await resolveBillingCompanyName(tx, r, prev);
        //  담당자: 같은 담당자면 기존 Snapshot 유지(과거 CRM 원본명 보존), 바뀌면 Master 이름으로 고정(§Phase2).
        const billingContactNameSnapshot = prev && (prev.billingContactId ?? null) === (r.billingContactId ?? null) && prev.billingContactNameSnapshot != null
          ? prev.billingContactNameSnapshot
          : await fetchContactName(tx, r.billingContactId ?? null);
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
          billingCompanyNameSnapshot,
          billingContactNameSnapshot,
          ...fxBillingValues(r, prev),
          note: r.note ?? null,
          // 입금은행·확인 — 전달된 경우만 반영(생략 시 기존 값 유지). 은행이 비면 확인도 해제.
          ...(r.depositBank !== undefined ? { depositBank: (r.depositBank ?? "").trim() || null } : {}),
          ...(r.depositBankConfirmed !== undefined || r.depositBank !== undefined
            ? { depositBankConfirmed: !!r.depositBankConfirmed && !!((r.depositBank !== undefined ? r.depositBank : prev?.depositBank) ?? "").trim() }
            : {}),
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
    const saved = await loadPaymentRecords(projectId);
    const pick = (r: any) => ({ id: r.id, expectedDate: r.expectedDate ?? null, paidDate: r.paidDate ?? null, amount: n2(r.amount), supplyAmount: n2(r.supplyAmount), vatAmount: n2(r.vatAmount), depositStatus: r.depositStatus, depositConfirmed: !!r.depositConfirmed });
    await logEvent("project", projectId, "payment_records_saved", req.log, req.user ? { id: req.user.id, email: req.user.email } : undefined,
      JSON.stringify({ before: before.map(pick), after: saved.map(pick), deletedIds }));
    res.json({ rows: saved });
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
  // 거래유형 — 'deposit'(기본, 실제 입금) · 'offset'(선입금·초과입금 상계 — 실제 은행 입금 아님)
  //   · 'refund'(입금 환불 — 원화 청구회차만. 환불액은 음수 고객결제액으로 저장 → 순입금액·미수금 자동 반영. 실제 송금 기능 아님)
  txnType: z.enum(["deposit", "offset", "refund"]).nullable().optional(),
  offsetSourcePaymentId: z.number().int().nullable().optional(),   // 상계 원천 청구회차(초과입금 발생 회차)
  // 입금내역별 결제구분·입금예정(2026-11) — 생략(undefined) 시 기존 값 유지(구버전 화면·첫 입금 인라인 저장 호환).
  paymentType: z.enum(["lump_sum", "advance", "interim", "balance"]).nullable().optional(),
  expectedDate: z.string().nullable().optional(),
  expectedAmount: money,
  // 입금상태(저장 안 함, 검증·정규화용) — 'scheduled' 입금예정: 실제 입금액 0·입금일 없음으로 저장(예정액만). 'completed'·생략: 기존 실제 입금 규칙.
  depositStatus: z.enum(["scheduled", "completed"]).nullable().optional(),
}).superRefine((r, ctx) => {
  if (r.depositStatus === "scheduled") {
    if (r.txnType === "offset" || r.txnType === "refund" || r.method === "외화송금") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['depositStatus'], message: '입금예정은 원화 입금내역만 등록할 수 있습니다.' });
    if (!(typeof r.expectedAmount === 'number' && r.expectedAmount > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedAmount'], message: '입금예정액은 0보다 커야 합니다.' });
    return;
  }
  if (r.depositStatus === "completed" && !r.paidDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paidDate'], message: '입금완료는 입금일이 필요합니다.' });
  if (r.txnType === "offset") {
    if (!r.currency) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currency'], message: '상계는 통화가 필요합니다.' });
    if (!(typeof r.foreignAmount === 'number' && r.foreignAmount > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['foreignAmount'], message: '상계금액은 0보다 커야 합니다.' });
    if (!r.offsetSourcePaymentId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['offsetSourcePaymentId'], message: '상계 원천 청구회차가 필요합니다.' });
    return;
  }
  if (r.txnType === "refund") {
    // 환불일·환불액은 사용자가 직접 입력(임의 지정 금지). 금액은 부호와 무관하게 절댓값으로 받아 음수로 저장한다.
    if (!r.paidDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paidDate'], message: '환불일을 입력하세요.' });
    if (!(typeof r.customerPaidAmount === 'number' && Math.abs(r.customerPaidAmount) > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customerPaidAmount'], message: '환불금액은 0보다 커야 합니다.' });
    return;
  }
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
// carryLegacyDeposit — 입금거래 없이 기존 방식으로 입금완료 확정된 회차에 '+ 입금 추가'로 내역을 더할 때, 기존 입금(입금일·청구금액)을
//  입금거래 1건으로 먼저 이관한다(서버가 조건 재검증). 이관 없이 거래를 추가하면 수금 집계가 거래 합계 기준으로 바뀌어 기존 입금이 누락된다.
const txnBatchSchema = z.object({ rows: z.array(txnRowSchema), deletedIds: z.array(z.number().int()).default([]), carryLegacyDeposit: z.boolean().optional() });

router.put("/admin/project-payments/:paymentId/transactions", ...adminGuard, requireRolePermission("payment.update"), async (req, res) => {
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(paymentId) || paymentId <= 0) { res.status(400).json({ error: "잘못된 청구행 ID" }); return; }
  const parsed = txnBatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const { rows, deletedIds, carryLegacyDeposit } = parsed.data;
  const userId = req.user?.id ?? null;

  // 청구행 존재 확인 + projectId 확보(수금거래 denormalized projectId 세팅용).
  const [pay] = await db.select().from(projectPaymentsTable).where(eq(projectPaymentsTable.id, paymentId));
  if (!pay) { res.status(404).json({ error: "청구행을 찾을 수 없습니다." }); return; }
  const txBefore = await db.select().from(paymentTransactionsTable).where(eq(paymentTransactionsTable.projectPaymentId, paymentId));

  // ── 입금 환불(txnType='refund') — 원화 청구회차만. 순입금액(입금 − 환불)을 넘는 환불은 차단 ──
  //  · 입금거래 없이 기존 방식으로 입금완료 확정된 회차(과거 CRM 전환 입금 등)는 환불 시 그 입금(입금일·금액)을 입금거래 1건으로
  //    먼저 이관한 뒤 환불을 기록한다(거래가 하나도 없을 때만 — 중복 생성 없음). 회차의 원래 입금일·금액 값은 바꾸지 않는다.
  const hasRefund = rows.some(r => r.txnType === "refund");
  // 환불 이력이 있는 회차에서 입금 거래를 삭제·수정할 때도 순입금액이 음수가 되지 않게 같은 검증을 적용
  const refundHistory = txBefore.some(t => t.txnType === "refund");
  let legacyDeposit: typeof paymentTransactionsTable.$inferInsert | null = null;
  if (hasRefund || refundHistory) {
    if (hasRefund && isForeignCurrency(pay.billingCurrency)) { res.status(400).json({ error: "외화 청구회차의 환불은 지원하지 않습니다(원화 청구회차만)." }); return; }
    if (hasRefund && txBefore.length === 0 && pay.depositStatus === "completed" && pay.depositConfirmed && pay.paidDate && Number(pay.amount) > 0) {
      legacyDeposit = { projectPaymentId: paymentId, projectId: pay.projectId, paidDate: pay.paidDate, method: pay.paymentMethod ?? null,
        customerPaidAmount: String(pay.amount), currency: "KRW", bankAccount: (pay.depositBank ?? "").trim() || null,
        note: "기존 입금확인 회차의 입금 — 환불 처리 시 입금거래로 이관(입금일·금액 그대로)", createdBy: userId, updatedBy: userId };
    }
    // 저장 후 거래 집합의 순입금액(원화 고객결제액 합) ≥ 0 이어야 한다.
    const signed = (r: typeof rows[number]) => r.depositStatus === "scheduled" ? 0 : r.txnType === "refund" ? -Math.abs(Number(r.customerPaidAmount ?? 0)) : Number(r.customerPaidAmount ?? 0);
    const upd = new Map(rows.filter(r => r.id).map(r => [r.id!, r]));
    const net = txBefore.filter(t => !deletedIds.includes(t.id)).reduce((s, t) => s + (upd.has(t.id) ? signed(upd.get(t.id)!) : Number(t.customerPaidAmount ?? 0)), 0)
      + rows.filter(r => !r.id).reduce((s, r) => s + signed(r), 0)
      + (legacyDeposit ? Number(legacyDeposit.customerPaidAmount) : 0);
    if (net < -0.005) { res.status(400).json({ error: `환불금액이 순입금액을 초과합니다(초과 ${Math.round(-net).toLocaleString("ko-KR")}원).` }); return; }
  }

  // ── 기존 확정 입금 이관(입금내역 추가) — 요청(carryLegacyDeposit) + 서버 조건 모두 충족할 때만. 환불 이관과 같은 형식(중복 생성 없음) ──
  const legacyPaidRow = txBefore.length === 0 && pay.depositStatus === "completed" && pay.depositConfirmed && !!pay.paidDate && Number(pay.amount) > 0;
  if (!legacyDeposit && carryLegacyDeposit && legacyPaidRow && rows.some(r => !r.id) && !isForeignCurrency(pay.billingCurrency)) {
    legacyDeposit = { projectPaymentId: paymentId, projectId: pay.projectId, paidDate: pay.paidDate, method: pay.paymentMethod ?? null,
      customerPaidAmount: String(pay.amount), currency: "KRW", bankAccount: (pay.depositBank ?? "").trim() || null,
      paymentType: pay.paymentType && ["lump_sum", "advance", "interim", "balance"].includes(pay.paymentType) ? pay.paymentType : null,
      note: "기존 입금확인 회차의 입금 — 입금내역 추가 시 입금거래로 이관(입금일·금액 그대로)", createdBy: userId, updatedBy: userId };
  }
  // 입금거래 없이 확정된 회차에 이관 없이 새 내역을 더하면 기존 입금이 집계에서 빠진다 — 차단(화면은 carryLegacyDeposit 으로 이관 요청).
  if (!legacyDeposit && legacyPaidRow && rows.some(r => !r.id)) {
    res.status(409).json({ error: "입금완료로 확정된 회차입니다. 기존 입금을 입금내역으로 이관한 뒤 추가해야 합니다(화면을 새로고침한 뒤 다시 시도하세요)." }); return;
  }

  // ── 외화 청구회차 검증·환산(원화 청구회차는 기존 동작 그대로) ──
  const billCur = isForeignCurrency(pay.billingCurrency) ? String(pay.billingCurrency).toUpperCase() : null;
  const fxCalc = new Map<number, { krw: number | null; paid: number }>();   // rows index → 확정 원화 환산·고객결제(원화)
  for (const [i, r] of rows.entries()) {
    const label = `${i + 1}번째 거래`;
    if (billCur && r.depositStatus === "scheduled") { res.status(400).json({ error: `${label}: 외화 청구회차는 입금예정 내역을 지원하지 않습니다.` }); return; }
    if (!billCur) {
      if (r.txnType === "offset") { res.status(400).json({ error: `${label}: 원화 청구회차의 상계는 선입금 관리에서 처리합니다.` }); return; }
      continue;
    }
    const cur = String(r.currency ?? "").toUpperCase();
    if (cur !== billCur) { res.status(400).json({ error: `${label}: 입금통화(${cur || "없음"})가 청구통화(${billCur})와 다릅니다.` }); return; }
    if (!(typeof r.foreignAmount === "number" && r.foreignAmount > 0)) { res.status(400).json({ error: `${label}: 외화 금액(${billCur})이 필요합니다.` }); return; }
    const fa = String(r.foreignAmount);
    const rate = r.fxRate != null ? String(r.fxRate) : null;
    if (rate != null && (toScaled(rate, 6) ?? 0n) <= 0n) { res.status(400).json({ error: `${label}: 적용환율 형식 오류` }); return; }
    // 원화 환산액: 은행 확인 원화액(krwAmount) 직접 입력이 있으면 우선, 없으면 외화 × 환율(원 단위 반올림). 환율 없으면 미확정(null).
    const krw = rate == null ? null : (r.krwAmount != null ? Math.round(r.krwAmount) : krwOf(fa, rate));
    if (r.txnType === "offset") {
      const src = r.offsetSourcePaymentId!;
      if (src === paymentId) { res.status(400).json({ error: `${label}: 같은 회차를 상계 원천으로 지정할 수 없습니다.` }); return; }
      const [sp] = await db.select().from(projectPaymentsTable).where(eq(projectPaymentsTable.id, src));
      if (!sp || String(sp.billingCurrency ?? "").toUpperCase() !== billCur) { res.status(400).json({ error: `${label}: 상계 원천은 같은 통화(${billCur})의 외화 청구회차여야 합니다.` }); return; }
      const sIn = await db.select().from(paymentTransactionsTable).where(eq(paymentTransactionsTable.projectPaymentId, src));
      const sOut = (await db.select().from(paymentTransactionsTable).where(eq(paymentTransactionsTable.offsetSourcePaymentId, src))).filter((t) => t.id !== r.id);
      const avail = toScaled(summarizeFxRow(fxBill(sp), sIn.map(fxTxn), sOut.map(fxTxn)).overpaidForeign, 2) ?? 0n;
      if ((toScaled(fa, 2) ?? 0n) > avail) { res.status(400).json({ error: `${label}: 상계금액이 원천 회차의 남은 초과입금(${billCur} ${fromScaled(avail, 2)})보다 큽니다.` }); return; }
      fxCalc.set(i, { krw, paid: 0 });   // 상계는 실제 은행 입금이 아니므로 원화 고객결제액 0(원화 집계 중복 방지)
    } else {
      fxCalc.set(i, { krw, paid: krw ?? 0 });   // 확정 환산액만 원화 집계에 반영(미확정 0 — 외화 기준 판정은 fx 요약)
    }
  }

  try {
    await db.transaction(async (tx) => {
      if (deletedIds.length) {
        await tx.delete(paymentTransactionsTable)
          .where(and(eq(paymentTransactionsTable.projectPaymentId, paymentId), inArray(paymentTransactionsTable.id, deletedIds)));
      }
      if (legacyDeposit) await tx.insert(paymentTransactionsTable).values(legacyDeposit);   // 기존 확정 입금 → 입금거래 이관(환불 전 입금 이력 보존)
      for (const [i, r] of rows.entries()) {
        const num = (v: number | null | undefined) => (v == null ? null : String(v));
        const fx = fxCalc.get(i);
        const scheduled = r.depositStatus === "scheduled";   // 입금예정 — 실제 입금액 0·입금일 없음(예정액·예정일만)
        const values = {
          paidDate: scheduled ? null : (r.paidDate || null),
          method: fx ? (r.txnType === "offset" ? "상계" : (r.method || "외화송금")) : (r.method ?? null),
          // 카드결제(실제 입금액 + 카드사 수수료가 함께 입력된 거래): 고객결제액 = 실제 입금액 + 수수료(원 단위).
          //  → 미수금 = 청구금액 − 실제 입금액 − 수수료. 수수료는 fee_amount 로 별도 보관(매출·할인 아님). 그 외 결제방법은 기존 그대로.
          customerPaidAmount: fx ? String(fx.paid)
            : scheduled ? "0"
            : r.txnType === "refund" ? String(-Math.abs(Number(r.customerPaidAmount ?? 0)))   // 환불 = 음수 거래
            : (isCardMethod(r.method) && r.settledAmount != null && r.feeAmount != null
                ? String(Math.round(Number(r.settledAmount)) + Math.round(Number(r.feeAmount)))
                : String(r.customerPaidAmount ?? 0)),
          settledAmount: scheduled ? null : num(r.settledAmount),
          feeAmount: scheduled ? null : num(r.feeAmount),
          currency: r.currency || "KRW",
          fxRate: num(r.fxRate),
          foreignAmount: num(r.foreignAmount),
          krwAmount: fx ? (fx.krw != null ? String(fx.krw) : null) : num(r.krwAmount),
          bankAccount: r.bankAccount ?? null,
          payerName: r.payerName ?? null,
          approvalNo: r.approvalNo ?? null,
          cardPgType: r.cardPgType ?? null,
          note: r.note ?? null,
          txnType: r.txnType === "offset" ? "offset" : r.txnType === "refund" ? "refund" : (fx ? "deposit" : null),
          offsetSourcePaymentId: r.txnType === "offset" ? (r.offsetSourcePaymentId ?? null) : null,
          // 결제구분·입금예정일·입금예정액 — 전달된 경우만 반영(생략 시 기존 값 유지)
          ...(r.paymentType !== undefined ? { paymentType: r.paymentType ?? null } : {}),
          ...(r.expectedDate !== undefined ? { expectedDate: r.expectedDate || null } : {}),
          ...(r.expectedAmount !== undefined ? { expectedAmount: num(r.expectedAmount) } : {}),
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
    await logEvent("project", pay.projectId, "payment_transactions_saved", req.log, req.user ? { id: req.user.id, email: req.user.email } : undefined,
      JSON.stringify({ paymentId, carriedLegacyDeposit: !!legacyDeposit, beforeTx: txBefore.map(t => ({ id: t.id, paidDate: t.paidDate, customerPaidAmount: t.customerPaidAmount, paymentType: t.paymentType, expectedDate: t.expectedDate, expectedAmount: t.expectedAmount, currency: t.currency, foreignAmount: t.foreignAmount, fxRate: t.fxRate, krwAmount: t.krwAmount, feeAmount: t.feeAmount, txnType: t.txnType, offsetSourcePaymentId: t.offsetSourcePaymentId })),
        saved: rows.map((r, i) => ({ id: r.id ?? null, depositStatus: r.depositStatus ?? null, paymentType: r.paymentType ?? null, expectedDate: r.expectedDate ?? null, expectedAmount: r.expectedAmount ?? null, paidDate: r.depositStatus === "scheduled" ? null : (r.paidDate ?? null), customerPaidAmount: fxCalc.get(i)?.paid ?? r.customerPaidAmount ?? null, currency: r.currency ?? null, foreignAmount: r.foreignAmount ?? null, fxRate: r.fxRate ?? null, krwAmount: fxCalc.get(i)?.krw ?? r.krwAmount ?? null, feeAmount: r.feeAmount ?? null, txnType: r.txnType ?? null, offsetSourcePaymentId: r.offsetSourcePaymentId ?? null })), deletedIds }));
    res.json({ rows: await loadPaymentRecords(pay.projectId) });
  } catch (err) {
    req.log.error({ err }, "수금거래 저장 실패");
    res.status(500).json({ error: "수금거래 저장 중 오류가 발생했습니다." });
  }
});

// ── 상계 원천 후보 — 같은 통화 외화 청구회차 중 남은 초과입금(상계 가능 잔액)이 있는 회차(같은 청구업체 또는 같은 판매 거래처). READ-ONLY ──
router.get("/admin/project-payments/:paymentId/offset-sources", ...adminGuard, async (req, res) => {
  const paymentId = Number(req.params.paymentId);
  if (!Number.isInteger(paymentId) || paymentId <= 0) { res.status(400).json({ error: "잘못된 청구행 ID" }); return; }
  try {
    const [t] = (await db.execute(sql`SELECT pp.id, pp.billing_currency, pp.billing_company_id, p.company_id FROM project_payments pp JOIN projects p ON p.id = pp.project_id WHERE pp.id = ${paymentId}`)).rows as any[];
    if (!t) { res.status(404).json({ error: "청구행을 찾을 수 없습니다." }); return; }
    if (!isForeignCurrency(t.billing_currency)) { res.json({ rows: [] }); return; }
    const cands = (await db.execute(sql`SELECT pp.id, pp.project_id, pp.sequence, p.title, COALESCE(pp.billing_company_name_snapshot, c.name) AS billing_company_name
      FROM project_payments pp JOIN projects p ON p.id = pp.project_id LEFT JOIN companies c ON c.id = pp.billing_company_id
      WHERE pp.id <> ${paymentId} AND upper(pp.billing_currency) = upper(${t.billing_currency})
        AND ((${t.billing_company_id}::int IS NOT NULL AND pp.billing_company_id = ${t.billing_company_id}) OR (${t.company_id}::int IS NOT NULL AND p.company_id = ${t.company_id}))
      ORDER BY pp.project_id DESC, pp.sequence`)).rows as any[];
    const fx = await loadFxSummaries(db, cands.map((c) => Number(c.id)));
    res.json({ rows: cands.map((c) => ({ id: Number(c.id), projectId: Number(c.project_id), sequence: c.sequence, saleTitle: c.title, billingCompanyName: c.billing_company_name,
      currency: fx.get(Number(c.id))?.currency ?? null, overpaidForeign: fx.get(Number(c.id))?.overpaidForeign ?? "0.00" }))
      .filter((c) => (toScaled(c.overpaidForeign, 2) ?? 0n) > 0n) });
  } catch (err) {
    req.log.error({ err }, "상계 원천 조회 실패");
    res.status(500).json({ error: "상계 원천 조회 중 오류가 발생했습니다." });
  }
});

export default router;
