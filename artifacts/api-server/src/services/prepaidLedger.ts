// ─── 선입금 목록형 원장 — 거래처별 현황 · 상세 원장 · 거래별 수정 · 수정 이력 ─────────────────────
// 원칙
//  · 사용자가 저장한 값이 곧 DB 값이고, 재조회 시 그대로 나온다(부분 저장 없음 — 한 트랜잭션).
//  · 잔액은 원장으로부터 다시 계산한다: 확정 행(날짜·ID 순) 누적 = 확정 잔액, 이어서 예정 행 누적 = 예상 잔액.
//    원장에 없는 기초 잔액(계정 잔액 − Σ확정 원장)은 '기초 잔액'으로 보존·표시한다(임의 보정하지 않음).
//  · 수정 전·후 값/사유/수정자/시각은 prepaid_ledger_history 에 남긴다(확정 거래 정정 이력 보존).
//  · 차감 견적서가 관리하는 값(차감액·견적/판매 연결·예정 차감의 날짜)은 견적서에서 수정한다
//    — 원장에서 바꾸면 다음 견적 저장 때 견적 값으로 되돌아가므로(덮어쓰기) 견적을 단일 원본으로 둔다.
//  · 수정이 이미 확정된 다른 거래의 금액·배분이나 판매확정 견적 스냅샷을 바꾸면 영향 범위를 돌려주고
//    명시적 확인(confirmImpact) 후에만 저장한다. 단순 수정은 추가 확인 없이 저장한다.
import { and, eq, sql } from "drizzle-orm";
import { prepaidAccountsTable, prepaidLedgerTable, prepaidLedgerHistoryTable, quotesTable, quoteItemsTable, projectsTable } from "@workspace/db";
import { isPrepaidDeductionQuoteType, syncQuoteReservations } from "./prepaidDeductionQuote";

type Db = any;

const OUTFLOW = new Set(["deduction", "refund"]);
const INFLOW_EDIT_TYPES = ["deposit", "carryover", "adjustment"] as const;
export const isOutflow = (t: string) => OUTFLOW.has(t);
const signed = (type: string, amount: number) => (isOutflow(type) ? -amount : amount);
const n = (v: unknown) => (v == null ? null : Number(v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const same = (a: unknown, b: unknown) => {
  if (a == null || a === "") return b == null || b === "";
  if (typeof a === "number" || typeof b === "number") return b != null && b !== "" && Math.abs(Number(a) - Number(b)) < 0.005;
  return String(a) === String(b);
};
// 신규 입금 누계(initial_amount)에 포함되는 행 — 확정 선입/이월 중 기존 입금 연결이 아닌 것(confirmQuoteReservations 와 동일 규칙)
const countsToInitial = (row: any) => row.status === "confirmed" && (row.type === "deposit" || row.type === "carryover") && row.linkedPaymentId == null;

export type LedgerSnapshot = {
  id: number; accountId: number; projectId: number | null; quoteId: number | null; type: string; status: string;
  amount: number; supplyAmount: number | null; taxAmount: number | null; description: string | null; memo: string | null;
  transactionDate: string; linkedPaymentId: number | null; balanceBefore: number | null; balanceAfter: number | null;
};
export function snap(row: any): LedgerSnapshot {
  return {
    id: row.id, accountId: row.accountId, projectId: row.projectId ?? null, quoteId: row.quoteId ?? null, type: row.type, status: row.status,
    amount: Number(row.amount), supplyAmount: n(row.supplyAmount), taxAmount: n(row.taxAmount), description: row.description ?? null,
    memo: row.memo ?? null, transactionDate: String(row.transactionDate), linkedPaymentId: row.linkedPaymentId ?? null,
    balanceBefore: n(row.balanceBefore), balanceAfter: n(row.balanceAfter),
  };
}
const FIN_KEYS: Array<keyof LedgerSnapshot> = ["amount", "supplyAmount", "taxAmount", "type", "status", "quoteId", "projectId", "linkedPaymentId", "accountId"];

export async function writeHistory(tx: Db, e: { ledgerId: number; accountId: number; action: string; before: unknown; after: unknown; reason?: string | null; actor?: { id?: number | null; email?: string | null } | null }) {
  await tx.insert(prepaidLedgerHistoryTable).values({
    ledgerId: e.ledgerId, accountId: e.accountId, action: e.action,
    before: (e.before ?? null) as any, after: (e.after ?? null) as any,
    reason: e.reason?.trim() || null, changedBy: e.actor?.id ?? null, changedByEmail: e.actor?.email ?? null,
  });
}

// ─── 계정의 확정 행 잔액(balance_before/after)을 날짜·ID 순으로 다시 기록 ─────────────────────
//  opening = 원장에 없는 기초 잔액(보존). 반환: 최종 잔액(= opening + Σ확정 순효과)
export async function rewriteRunningBalances(tx: Db, accountId: number, opening: number): Promise<number> {
  const rows = await tx.select().from(prepaidLedgerTable)
    .where(and(eq(prepaidLedgerTable.accountId, accountId), eq(prepaidLedgerTable.status, "confirmed")))
    .orderBy(prepaidLedgerTable.transactionDate, prepaidLedgerTable.id);
  let bal = opening;
  for (const e of rows) {
    const before = bal;
    bal = r2(bal + signed(e.type, Number(e.amount)));
    if (!same(e.balanceBefore, before) || !same(e.balanceAfter, bal)) {
      await tx.update(prepaidLedgerTable).set({ balanceBefore: String(before), balanceAfter: String(bal) }).where(eq(prepaidLedgerTable.id, e.id));
    }
  }
  return bal;
}
async function confirmedNet(tx: Db, accountId: number): Promise<number> {
  const [r] = (await tx.execute(sql`SELECT COALESCE(SUM(CASE WHEN type IN ('deduction','refund') THEN -amount ELSE amount END), 0)::text AS s
    FROM prepaid_ledger WHERE account_id = ${accountId} AND status = 'confirmed'`)).rows as any[];
  return Number(r?.s ?? 0);
}

// ─── 차감 견적서 재동기화(DB 기준) — 원장에서 견적 선입/이월을 고친 뒤 차감·견적 스냅샷을 견적 규칙으로 다시 계산 ──
//  견적 저장(PUT)과 같은 함수(syncQuoteReservations)·같은 금액 원천(quote_items 합)을 쓴다. 선입/이월 행은 그대로 둔다.
export async function resyncQuotePrepaidFromDb(tx: Db, quoteId: number): Promise<void> {
  const [q] = await tx.select({ id: quotesTable.id, quoteType: quotesTable.quoteType, projectId: quotesTable.projectId, issueDate: quotesTable.issueDate })
    .from(quotesTable).where(eq(quotesTable.id, quoteId));
  if (!q || !isPrepaidDeductionQuoteType(q.quoteType)) return;
  let companyId: number | null = null;
  if (q.projectId != null) {
    const [p] = await tx.select({ companyId: projectsTable.companyId }).from(projectsTable).where(eq(projectsTable.id, q.projectId));
    companyId = p?.companyId ?? null;
  }
  if (companyId == null) {
    const [l] = (await tx.execute(sql`SELECT a.company_id FROM prepaid_ledger l JOIN prepaid_accounts a ON a.id = l.account_id
      WHERE l.quote_id = ${quoteId} AND l.status IN ('reserved','confirmed') LIMIT 1`)).rows as any[];
    companyId = l?.company_id ?? null;
  }
  const items = await tx.select({ s: quoteItemsTable.supplyAmount, t: quoteItemsTable.taxAmount, a: quoteItemsTable.totalAmount }).from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quoteId));
  const quoteTotal = items.reduce((s: number, i: any) => s + Number(i.a ?? 0), 0);
  const quoteSupply = items.reduce((s: number, i: any) => s + Number(i.s ?? 0), 0);
  const quoteTax = items.reduce((s: number, i: any) => s + Number(i.t ?? 0), 0);
  const res = await syncQuoteReservations(tx, {
    quoteId, companyId, projectId: q.projectId ?? null, prepaidLines: null,
    quoteTotal, quoteSupply, quoteTax, transactionDate: q.issueDate ? String(q.issueDate) : null,
  });
  if (res) {
    await tx.update(quotesTable).set({
      prepaidBalanceBefore: String(res.previousAvailable),
      prepaidUsageAmount: String(res.summary.appliedDeduction),
      prepaidBalanceAfter: String(res.summary.remainingAfter),
    }).where(eq(quotesTable.id, quoteId));
  }
}

// ═══ 잔액 공식(전 화면 공통) ════════════════════════════════════════════════════════════
//  잔액 = 누적 입금 − 누적 차감. 해제(released, 취소·거절 견적) 행만 제외하고 모든 원장 행을 계산한다.
//  status(reserved/confirmed)는 견적 수명주기용 내부 표시일 뿐, 잔액·화면 구분에 쓰지 않는다.
//  계정 잔액 = 저장 잔액(current_balance) + Σ(아직 confirmed 로 바뀌지 않은 행의 순효과)
//            = 기초 잔액(원장 밖 이관분) + Σ활성 원장 순효과
export type BalanceTotals = { deposit: number; deduction: number; balance: number; opening: number };
export async function getAccountBalances(dbh: Db, accountIds: number[]): Promise<Map<number, BalanceTotals>> {
  const out = new Map<number, BalanceTotals>();
  if (accountIds.length === 0) return out;
  const rows = (await dbh.execute(sql`
    SELECT a.id, a.current_balance::text AS stored,
      COALESCE(SUM(l.amount) FILTER (WHERE l.status IN ('reserved','confirmed') AND l.type NOT IN ('deduction','refund')), 0)::text AS dep,
      COALESCE(SUM(l.amount) FILTER (WHERE l.status IN ('reserved','confirmed') AND l.type IN ('deduction','refund')), 0)::text AS ded,
      COALESCE(SUM(CASE WHEN l.type IN ('deduction','refund') THEN -l.amount ELSE l.amount END) FILTER (WHERE l.status = 'confirmed'), 0)::text AS conf_net
      FROM prepaid_accounts a LEFT JOIN prepaid_ledger l ON l.account_id = a.id
     WHERE a.id IN (${sql.join(accountIds.map(i => sql`${i}`), sql`, `)}) GROUP BY a.id`)).rows as any[];
  for (const r of rows) {
    const dep = Number(r.dep), ded = Number(r.ded), opening = r2(Number(r.stored) - Number(r.conf_net));
    out.set(r.id, { deposit: dep, deduction: ded, opening: Math.abs(opening) < 0.005 ? 0 : opening, balance: r2((Math.abs(opening) < 0.005 ? 0 : opening) + dep - ded) });
  }
  return out;
}
/** 거래처 합계(활성 계정) — 판매 상세·거래처 상세·견적 가용잔액 등 다른 화면 공용 */
export async function getCompanyBalances(dbh: Db, companyIds: number[], opts: { activeOnly?: boolean } = { activeOnly: true }): Promise<Map<number, BalanceTotals>> {
  const out = new Map<number, BalanceTotals>();
  if (companyIds.length === 0) return out;
  const accs = (await dbh.execute(sql`SELECT id, company_id FROM prepaid_accounts WHERE company_id IN (${sql.join(companyIds.map(i => sql`${i}`), sql`, `)})
    ${opts.activeOnly ? sql`AND status = 'active'` : sql``}`)).rows as any[];
  const per = await getAccountBalances(dbh, accs.map(a => a.id));
  for (const a of accs) {
    const b = per.get(a.id); if (!b) continue;
    const t = out.get(a.company_id) ?? { deposit: 0, deduction: 0, balance: 0, opening: 0 };
    out.set(a.company_id, { deposit: t.deposit + b.deposit, deduction: t.deduction + b.deduction, balance: r2(t.balance + b.balance), opening: r2(t.opening + b.opening) });
  }
  return out;
}

// ═══ 거래처별 선입금 현황 ═════════════════════════════════════════════════════════════════
export type CompanyOverview = { companyId: number; companyName: string; totalDeposit: number; totalDeduction: number; balance: number; lastTxDate: string | null };
export async function getCompanyOverview(dbh: Db, opts: { from?: string | null; to?: string | null } = {}): Promise<CompanyOverview[]> {
  const from = opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : null;
  const to = opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : null;
  const comps = (await dbh.execute(sql`
    SELECT a.company_id, c.name, MAX(l.transaction_date) FILTER (WHERE l.status IN ('reserved','confirmed'))::text AS last_date
      FROM prepaid_accounts a LEFT JOIN companies c ON c.id = a.company_id LEFT JOIN prepaid_ledger l ON l.account_id = a.id
     GROUP BY a.company_id, c.name
    ${from || to ? sql`HAVING bool_or(l.status IN ('reserved','confirmed') ${from ? sql`AND l.transaction_date >= ${from}::date` : sql``} ${to ? sql`AND l.transaction_date <= ${to}::date` : sql``})` : sql``}
     ORDER BY c.name NULLS LAST, a.company_id`)).rows as any[];
  const bal = await getCompanyBalances(dbh, comps.map(c => c.company_id), { activeOnly: false });
  return comps.map(c => {
    const b = bal.get(c.company_id) ?? { deposit: 0, deduction: 0, balance: 0, opening: 0 };
    return { companyId: c.company_id, companyName: c.name ?? `거래처 #${c.company_id}`, totalDeposit: b.deposit + Math.max(0, b.opening), totalDeduction: b.deduction + Math.max(0, -b.opening), balance: b.balance, lastTxDate: c.last_date ?? null };
  });
}

// ═══ 거래처 상세 원장 — 하나의 표(거래일·등록순), 행별 누적 잔액 ═══════════════════════════════════════
const ITEM_LABEL: Record<string, string> = { translation: "번역", interpretation: "통역", equipment: "장비", expense: "경비" };
export function rowLabel(r: { type: string; linkedPaymentId?: number | null; itemType?: string | null; quoteManaged?: boolean }): string {
  if (r.type === "deduction") return r.quoteManaged && r.itemType && ITEM_LABEL[r.itemType] ? `${ITEM_LABEL[r.itemType]} 차감` : "차감";
  return ({ deposit: "선입금", carryover: "이월", adjustment: "조정", refund: "환불" } as Record<string, string>)[r.type] ?? r.type;
}
export async function getCompanyLedger(dbh: Db, companyId: number) {
  const accounts = await dbh.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.companyId, companyId)).orderBy(prepaidAccountsTable.id);
  if (accounts.length === 0) return null;
  const ids: number[] = accounts.map((a: any) => a.id);
  const rows = (await dbh.execute(sql`
    SELECT l.id, l.account_id, l.type, l.amount::text AS amount, l.transaction_date::text AS tx_date, l.description, l.memo, l.quote_id, l.project_id, l.linked_payment_id,
           q.quote_type, (SELECT qi.item_type FROM quote_items qi WHERE qi.quote_id = l.quote_id ORDER BY qi.id LIMIT 1) AS item_type
      FROM prepaid_ledger l LEFT JOIN quotes q ON q.id = l.quote_id
     WHERE l.account_id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)}) AND l.status IN ('reserved','confirmed')
     ORDER BY l.transaction_date NULLS LAST, l.id`)).rows as any[];
  const per = await getAccountBalances(dbh, ids);
  const opening = r2([...per.values()].reduce((s, b) => s + b.opening, 0));
  let running = opening;
  const ledger = rows.map(r => {
    const amount = Number(r.amount), out = isOutflow(r.type);
    running = r2(running + (out ? -amount : amount));
    const quoteManaged = r.quote_id != null && isPrepaidDeductionQuoteType(r.quote_type);
    return {
      id: r.id, accountId: r.account_id, type: r.type, label: rowLabel({ type: r.type, itemType: r.item_type, quoteManaged }),
      transactionDate: r.tx_date ?? null, inflow: out ? 0 : amount, outflow: out ? amount : 0, balance: running,
      description: r.description ?? null, memo: r.memo ?? null, quoteId: r.quote_id ?? null, projectId: r.project_id ?? null, linkedPaymentId: r.linked_payment_id ?? null,
    };
  });
  const [company] = (await dbh.execute(sql`SELECT name FROM companies WHERE id = ${companyId}`)).rows as any[];
  return {
    companyId, companyName: company?.name ?? `거래처 #${companyId}`,
    accounts: accounts.map((a: any) => ({ id: a.id, status: a.status })),
    openingBalance: opening, ledger,
    totals: { totalDeposit: ledger.reduce((s, l) => s + l.inflow, 0), totalDeduction: ledger.reduce((s, l) => s + l.outflow, 0), balance: running },
  };
}

// ═══ 원장 행 상세 + 수정 가능 범위 ═══════════════════════════════════════════════════════
export type EditRules = { editable: boolean; fields: Record<string, { editable: boolean; reason?: string }>; quoteManaged: boolean; notice: string | null };
function editRules(row: any, quote: any | null): EditRules {
  const quoteManaged = row.quoteId != null && quote != null && isPrepaidDeductionQuoteType(quote.quoteType);
  const isDed = isOutflow(row.type);
  const ok = { editable: true }, lock = (reason: string) => ({ editable: false, reason });
  const qLabel = quote?.quoteNumber ?? (row.quoteId ? `#${row.quoteId}` : "");
  if (row.status !== "confirmed" && row.status !== "reserved") {
    const off = lock("취소된 견적의 거래라 수정할 수 없습니다.");
    return { editable: false, quoteManaged, notice: off.reason, fields: { transactionDate: off, type: off, amount: off, supplyAmount: off, taxAmount: off, description: off, memo: off, quoteId: off, projectId: off, linkedPaymentId: off } };
  }
  const link = isDed ? lock("입금 행에만 해당") : ok;
  if (!quoteManaged) {
    return { editable: true, quoteManaged, notice: null, fields: {
      transactionDate: ok, type: ok, amount: ok, supplyAmount: isDed ? ok : lock("차감 거래에만 해당"), taxAmount: isDed ? ok : lock("차감 거래에만 해당"),
      description: ok, memo: ok, quoteId: ok, projectId: ok, linkedPaymentId: link,
    } };
  }
  const q = `견적서 ${qLabel}의 값입니다 — 견적서에서 수정하면 이 원장에 그대로 반영됩니다.`;
  if (isDed) {
    return { editable: true, quoteManaged, notice: `차감액(수량·단가)은 견적서 ${qLabel}에서 수정합니다. 견적서를 저장하면 이 행의 차감액과 잔액이 같이 바뀝니다.`, fields: {
      transactionDate: ok, type: lock(q), amount: lock(q), supplyAmount: lock(q), taxAmount: lock(q), description: ok, memo: ok, quoteId: lock(q), projectId: lock(q), linkedPaymentId: link,
    } };
  }
  return { editable: true, quoteManaged, notice: `견적서 ${qLabel}의 선입금 행입니다. 여기서 고치면 견적서와 차감 계산에 같이 반영됩니다.`, fields: {
    transactionDate: ok, type: ok, amount: ok, supplyAmount: lock("차감 거래에만 해당"), taxAmount: lock("차감 거래에만 해당"), description: ok, memo: ok, quoteId: lock(q), projectId: lock(q), linkedPaymentId: link,
  } };
}

export async function getLedgerEntryDetail(dbh: Db, id: number) {
  const [row] = await dbh.select().from(prepaidLedgerTable).where(eq(prepaidLedgerTable.id, id));
  if (!row) return null;
  const [acc] = await dbh.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, row.accountId));
  const quote = row.quoteId != null ? (await dbh.select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, quoteType: quotesTable.quoteType, status: quotesTable.status, title: quotesTable.title, projectId: quotesTable.projectId })
    .from(quotesTable).where(eq(quotesTable.id, row.quoteId)))[0] ?? null : null;
  const ctx = (await dbh.execute(sql`
    SELECT c.name AS company_name, p.title AS project_title, cu.name AS created_by_name, cu.email AS created_by_email,
           fu.name AS confirmed_by_name, fu.email AS confirmed_by_email,
           (SELECT m.legacy_id FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.entity_id = ${row.projectId ?? -1} LIMIT 1) AS sale_no,
           (SELECT string_agg(DISTINCT qi.product_name, ', ') FROM quote_items qi WHERE qi.quote_id = ${row.quoteId ?? -1}) AS service_names
      FROM companies c
      LEFT JOIN projects p ON p.id = ${row.projectId ?? -1}
      LEFT JOIN users cu ON cu.id = ${row.createdBy ?? -1}
      LEFT JOIN users fu ON fu.id = ${row.confirmedBy ?? -1}
     WHERE c.id = ${acc?.companyId ?? -1}`)).rows[0] as any ?? {};
  let linkedPayment: any = null;
  if (row.linkedPaymentId != null) {
    const [lp] = (await dbh.execute(sql`SELECT pp.id, pp.project_id, pp.sequence, pp.amount::text AS amount, pp.paid_date::text AS paid_date, pr.title,
        (SELECT m.legacy_id FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.entity_id = pp.project_id LIMIT 1) AS sale_no
      FROM project_payments pp JOIN projects pr ON pr.id = pp.project_id WHERE pp.id = ${row.linkedPaymentId}`)).rows as any[];
    if (lp) linkedPayment = { paymentId: lp.id, projectId: lp.project_id, projectTitle: lp.title, saleNo: lp.sale_no ?? null, sequence: lp.sequence, amount: Number(lp.amount), paidDate: lp.paid_date ?? null };
  }
  const [last] = (await dbh.execute(sql`SELECT h.changed_at, h.changed_by_email, u.name FROM prepaid_ledger_history h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.ledger_id = ${id} ORDER BY h.changed_at DESC, h.id DESC LIMIT 1`)).rows as any[];
  return {
    entry: { ...snap(row), createdAt: row.createdAt, createdBy: row.createdBy ?? null, confirmedAt: row.confirmedAt ?? null },
    companyId: acc?.companyId ?? null, companyName: ctx.company_name ?? null, accountStatus: acc?.status ?? null,
    projectTitle: ctx.project_title ?? null, saleNo: ctx.sale_no ?? null, serviceNames: ctx.service_names ?? null,
    quote: quote ? { id: quote.id, quoteNumber: quote.quoteNumber ?? null, quoteType: quote.quoteType, status: quote.status, title: quote.title ?? null, projectId: quote.projectId ?? null } : null,
    linkedPayment,
    createdByName: ctx.created_by_name ?? ctx.created_by_email ?? null,
    confirmedByName: ctx.confirmed_by_name ?? ctx.confirmed_by_email ?? null,
    modifiedAt: last?.changed_at ?? null, modifiedByName: last?.name ?? last?.changed_by_email ?? null,
    label: rowLabel({ type: row.type, quoteManaged: row.quoteId != null && quote != null && isPrepaidDeductionQuoteType(quote.quoteType),
      itemType: row.quoteId != null ? ((await dbh.execute(sql`SELECT item_type FROM quote_items WHERE quote_id = ${row.quoteId} ORDER BY id LIMIT 1`)).rows[0] as any)?.item_type ?? null : null }),
    rules: editRules(row, quote),
  };
}

// 원장 행의 기존 입금 연결 후보 — 같은 거래처의 입금완료 원화 청구회차(다른 원장 행 연결 여부 표시). 금액이 같다고 자동 연결하지 않는다.
export async function getLedgerLinkCandidates(dbh: Db, id: number) {
  const [row] = (await dbh.execute(sql`SELECT l.id, l.project_id, a.company_id FROM prepaid_ledger l JOIN prepaid_accounts a ON a.id = l.account_id WHERE l.id = ${id}`)).rows as any[];
  if (!row) return null;
  const rows = (await dbh.execute(sql`
    SELECT pp.id, pp.project_id, pr.title, pp.sequence, pp.amount::text AS amount, pp.paid_date::text AS paid_date,
           (SELECT m.legacy_id FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.status = 'active' AND m.entity_id = pp.project_id LIMIT 1) AS sale_no,
           (SELECT l.id FROM prepaid_ledger l WHERE l.linked_payment_id = pp.id AND l.status IN ('reserved','confirmed') AND l.id <> ${id} LIMIT 1) AS linked_row
      FROM project_payments pp JOIN projects pr ON pr.id = pp.project_id
     WHERE (pr.company_id = ${row.company_id} OR pp.billing_company_id = ${row.company_id})
       AND (pp.deposit_confirmed = true OR pp.deposit_status = 'completed') AND (pp.billing_currency IS NULL OR upper(pp.billing_currency) = 'KRW')
     ORDER BY (pp.project_id = ${row.project_id ?? -1}) DESC, pp.paid_date DESC NULLS LAST, pp.id DESC LIMIT 50`)).rows as any[];
  return rows.map(r => ({ paymentId: r.id, projectId: r.project_id, projectTitle: r.title ?? null, saleNo: r.sale_no ?? null, sequence: r.sequence ?? null,
    amount: Number(r.amount), paidDate: r.paid_date ?? null, linkedRow: r.linked_row ?? null }));
}

export async function getLedgerHistory(dbh: Db, id: number) {
  const [row] = await dbh.select({ quoteId: prepaidLedgerTable.quoteId }).from(prepaidLedgerTable).where(eq(prepaidLedgerTable.id, id));
  const quoteId = row?.quoteId ?? null;
  // 이 행의 이력 + (견적 행이면) 같은 견적의 다른 원장 행 이력(견적 저장으로 행이 다시 만들어진 경우 포함)
  const rows = (await dbh.execute(sql`
    SELECT h.id, h.ledger_id, h.action, h.before, h.after, h.reason, h.changed_at, h.changed_by_email, u.name AS changed_by_name
      FROM prepaid_ledger_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.ledger_id = ${id}
        ${quoteId != null ? sql`OR ((h.before ->> 'quoteId')::int = ${quoteId} OR (h.after ->> 'quoteId')::int = ${quoteId})` : sql``}
     ORDER BY h.changed_at DESC, h.id DESC LIMIT 200`)).rows as any[];
  return rows.map(r => ({
    id: r.id, ledgerId: r.ledger_id, related: r.ledger_id !== id, action: r.action, before: r.before ?? null, after: r.after ?? null,
    reason: r.reason ?? null, changedAt: r.changed_at, changedByName: r.changed_by_name ?? r.changed_by_email ?? null,
  }));
}

// ═══ 원장 행 수정 ═════════════════════════════════════════════════════════════════════════
export type LedgerChanges = Partial<{
  transactionDate: string; type: string; amount: number; supplyAmount: number | null; taxAmount: number | null;
  description: string | null; memo: string | null; quoteId: number | null; projectId: number | null; linkedPaymentId: number | null;
}>;
export type EditImpact = {
  target: { before: LedgerSnapshot; after: LedgerSnapshot };
  balance: { before: number; after: number }; initialAmount: { before: number; after: number };
  otherFinancialChanges: Array<{ id: number; status: string; type: string; field: string; before: unknown; after: unknown; removed?: boolean; added?: boolean }>;
  balanceOnlyRows: number;
  quote: { id: number; quoteNumber: string | null; status: string | null; before: Record<string, number | null>; after: Record<string, number | null> } | null;
  warnings: string[]; needsConfirm: boolean;
};
export type EditResult =
  | { result: "saved"; entry: LedgerSnapshot; impact: EditImpact }
  | { result: "unchanged"; entry: LedgerSnapshot }
  | { result: "conflict"; current: LedgerSnapshot }
  | { result: "invalid"; code: string; errors: string[] }
  | { result: "not_found" };
class Rollback extends Error { constructor(public payload: any) { super("rollback"); } }

const EDIT_KEYS = ["transactionDate", "type", "amount", "supplyAmount", "taxAmount", "description", "memo", "quoteId", "projectId", "linkedPaymentId"] as const;

export async function editLedgerEntry(
  dbh: Db, id: number,
  input: { base?: Partial<LedgerSnapshot> | null; changes: LedgerChanges; reason?: string | null; confirmImpact?: boolean; dryRun?: boolean },
  actor: { id?: number | null; email?: string | null } | null,
): Promise<EditResult | { result: "preview" | "confirm_required"; impact: EditImpact }> {
  try {
    return await dbh.transaction(async (tx: Db) => {
      const [row] = (await tx.select().from(prepaidLedgerTable).where(eq(prepaidLedgerTable.id, id)).for("update"));
      if (!row) return { result: "not_found" } as const;
      const [acc] = await tx.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, row.accountId)).for("update");
      const quote = row.quoteId != null ? (await tx.select({ id: quotesTable.id, quoteNumber: quotesTable.quoteNumber, quoteType: quotesTable.quoteType, status: quotesTable.status,
        prepaidBalanceBefore: quotesTable.prepaidBalanceBefore, prepaidUsageAmount: quotesTable.prepaidUsageAmount, prepaidBalanceAfter: quotesTable.prepaidBalanceAfter })
        .from(quotesTable).where(eq(quotesTable.id, row.quoteId)))[0] ?? null : null;
      const rules = editRules(row, quote);
      const cur = snap(row);

      // ── 다음 값 구성 + 검증(전 필드 검증 후에만 쓰기 — 부분 저장 없음) ──
      const ch = input.changes ?? {};
      const next: LedgerSnapshot = { ...cur };
      const errors: string[] = [];
      for (const k of EDIT_KEYS) {
        if (!(k in ch)) continue;
        const v: any = (ch as any)[k];
        if (k === "transactionDate") {
          if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) { errors.push("거래일 형식이 올바르지 않습니다(YYYY-MM-DD)."); continue; }
          next.transactionDate = v;
        } else if (k === "amount" || k === "supplyAmount" || k === "taxAmount") {
          if (v == null || v === "") { if (k === "amount") errors.push("금액을 입력하세요."); else (next as any)[k] = null; continue; }
          const num = Number(v);
          if (!Number.isFinite(num)) { errors.push("금액이 숫자가 아닙니다."); continue; }
          if (k === "amount" && num <= 0) { errors.push("금액은 0보다 커야 합니다."); continue; }
          if (k !== "amount" && num < 0) { errors.push("공급가/부가세는 0 이상이어야 합니다."); continue; }
          (next as any)[k] = r2(num);
        } else if (k === "type") {
          next.type = String(v);
        } else if (k === "description" || k === "memo") {
          (next as any)[k] = v == null ? null : String(v).slice(0, 2000);
        } else if (k === "quoteId" || k === "projectId" || k === "linkedPaymentId") {
          if (v == null || v === "") { (next as any)[k] = null; continue; }
          const num = Number(v);
          if (!Number.isInteger(num) || num <= 0) { errors.push(`${k === "quoteId" ? "연결 견적" : k === "projectId" ? "연결 판매" : "기존 입금"} 번호가 올바르지 않습니다.`); continue; }
          (next as any)[k] = num;
        }
      }
      if (errors.length) return { result: "invalid", code: "VALIDATION", errors } as const;

      const changed = EDIT_KEYS.filter(k => !same((cur as any)[k], (next as any)[k]));
      if (changed.length === 0) return { result: "unchanged", entry: cur } as const;   // 반복 클릭·재전송 — 변경 없음(멱등)

      // 동시 수정: 화면이 불러온 값(base)과 현재 DB 값이 다르면 덮어쓰지 않는다
      if (input.base) {
        const stale = EDIT_KEYS.some(k => k in (input.base as any) && !same((input.base as any)[k], (cur as any)[k]))
          || ("status" in input.base && input.base.status !== cur.status);
        if (stale) return { result: "conflict", current: cur } as const;
      }

      // 수정 범위 규칙
      for (const k of changed) {
        const f = rules.fields[k];
        if (!f?.editable) errors.push(f?.reason ?? `${k} 은(는) 수정할 수 없습니다.`);
      }
      if (changed.includes("type")) {
        if (isOutflow(cur.type) !== isOutflow(next.type)) errors.push("입금 ↔ 차감 유형은 서로 바꿀 수 없습니다(해당 행을 삭제 후 다시 등록하세요).");
        else if (!isOutflow(next.type)) {
          const allowed: readonly string[] = (rules.quoteManaged || cur.linkedPaymentId != null) ? ["deposit", "carryover"] : INFLOW_EDIT_TYPES;
          if (!allowed.includes(next.type)) errors.push(`입금 유형은 ${allowed.map(t => ({ deposit: "선입금", carryover: "이월", adjustment: "조정" } as any)[t]).join("/")}만 선택할 수 있습니다.`);
        } else if (next.type !== cur.type) errors.push("차감 유형은 바꿀 수 없습니다.");
      }
      // 차감액만 바꾸고 공급가/부가세를 주지 않은 경우: 기존 비율로 다시 나눈다(합계 = 차감액 유지)
      if (isOutflow(next.type) && changed.includes("amount") && !("supplyAmount" in ch) && !("taxAmount" in ch) && cur.supplyAmount != null && cur.amount > 0) {
        next.supplyAmount = Math.round(cur.supplyAmount * (next.amount / cur.amount));
        next.taxAmount = r2(next.amount - next.supplyAmount);
      }
      if (isOutflow(next.type) && next.supplyAmount != null && next.taxAmount != null && Math.abs(next.supplyAmount + next.taxAmount - next.amount) >= 1)
        errors.push(`공급가(${next.supplyAmount.toLocaleString("ko-KR")}) + 부가세(${next.taxAmount.toLocaleString("ko-KR")}) 가 차감액(${next.amount.toLocaleString("ko-KR")})과 다릅니다.`);
      // 기존 입금 연결(판매관리·수금관리에 이미 기록된 입금 참조) — 같은 거래처의 입금완료 원화 청구회차, 다른 원장 행에 미연결, 금액 이내
      if (next.linkedPaymentId != null && (changed.includes("linkedPaymentId") || changed.includes("amount"))) {
        if (isOutflow(next.type)) errors.push("기존 입금 연결은 입금 행에만 할 수 있습니다.");
        const [pp] = (await tx.execute(sql`SELECT pp.amount::text AS amount, pp.deposit_status, pp.deposit_confirmed, pp.billing_currency, pp.billing_company_id, pr.company_id,
            (SELECT l.id FROM prepaid_ledger l WHERE l.linked_payment_id = pp.id AND l.status IN ('reserved','confirmed') AND l.id <> ${id} LIMIT 1) AS other_row
          FROM project_payments pp JOIN projects pr ON pr.id = pp.project_id WHERE pp.id = ${next.linkedPaymentId}`)).rows as any[];
        if (!pp) errors.push(`청구회차 #${next.linkedPaymentId} 를 찾을 수 없습니다.`);
        else {
          if (pp.company_id !== acc.companyId && pp.billing_company_id !== acc.companyId) errors.push("다른 거래처의 입금 기록은 연결할 수 없습니다.");
          if (!(pp.deposit_confirmed || pp.deposit_status === "completed")) errors.push("입금완료되지 않은 청구회차는 연결할 수 없습니다.");
          if (pp.billing_currency && String(pp.billing_currency).toUpperCase() !== "KRW") errors.push("외화 청구회차는 연결할 수 없습니다.");
          if (pp.other_row) errors.push(`이 입금은 이미 다른 원장 행(#${pp.other_row})에 연결돼 있습니다 — 같은 입금을 두 번 쓸 수 없습니다.`);
          if (next.amount - Number(pp.amount) >= 0.005)
            errors.push(`연결된 입금액(${Math.round(Number(pp.amount)).toLocaleString("ko-KR")}원)보다 큰 금액은 입력할 수 없습니다 — 같은 입금의 이중 배분 방지.`);
        }
      }
      if (changed.includes("quoteId") && next.quoteId != null) {
        const [qx] = await tx.select({ id: quotesTable.id, quoteType: quotesTable.quoteType, deletedAt: quotesTable.deletedAt }).from(quotesTable).where(eq(quotesTable.id, next.quoteId));
        if (!qx) errors.push(`견적 #${next.quoteId} 를 찾을 수 없습니다.`);
        else if (isPrepaidDeductionQuoteType(qx.quoteType)) errors.push("차감 견적서는 견적서 저장으로 원장에 연결됩니다 — 직접 연결하면 같은 차감이 두 번 잡힐 수 있습니다.");
      }
      if (changed.includes("projectId") && next.projectId != null) {
        const [px] = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, next.projectId));
        if (!px) errors.push(`판매(프로젝트) #${next.projectId} 를 찾을 수 없습니다.`);
      }
      const finChange = changed.some(k => k === "amount" || k === "type" || k === "supplyAmount" || k === "taxAmount" || k === "linkedPaymentId");
      if (errors.length) return { result: "invalid", code: errors.some(e => e.includes("견적서")) ? "QUOTE_MANAGED" : "VALIDATION", errors } as const;

      // ── 영향 계산용 수정 전 상태 ──
      const beforeRows: LedgerSnapshot[] = (await tx.select().from(prepaidLedgerTable).where(eq(prepaidLedgerTable.accountId, cur.accountId))).map(snap);
      const balBefore = Number(acc.currentBalance), initBefore = Number(acc.initialAmount);
      const opening = r2(balBefore - (await confirmedNet(tx, cur.accountId)));

      // ── 쓰기 ──
      await tx.update(prepaidLedgerTable).set({
        transactionDate: next.transactionDate, type: next.type, amount: String(next.amount),
        supplyAmount: next.supplyAmount != null ? String(next.supplyAmount) : null, taxAmount: next.taxAmount != null ? String(next.taxAmount) : null,
        description: next.description, memo: next.memo, quoteId: next.quoteId, projectId: next.projectId, linkedPaymentId: next.linkedPaymentId,
      }).where(eq(prepaidLedgerTable.id, id));
      // 신규 입금 누계: 이 행의 포함 여부·금액 변화분만 반영
      const initDelta = (countsToInitial({ ...next, status: cur.status }) ? next.amount : 0) - (countsToInitial(cur) ? cur.amount : 0);
      if (Math.abs(initDelta) >= 0.005) await tx.update(prepaidAccountsTable).set({ initialAmount: String(r2(initBefore + initDelta)) }).where(eq(prepaidAccountsTable.id, cur.accountId));
      // 확정 행이면 계정 잔액에 변화분 반영(견적 재동기화가 이 잔액을 기준으로 계산하므로 먼저)
      if (cur.status === "confirmed") {
        const delta = signed(next.type, next.amount) - signed(cur.type, cur.amount);
        if (Math.abs(delta) >= 0.005) await tx.update(prepaidAccountsTable).set({ currentBalance: String(r2(balBefore + delta)) }).where(eq(prepaidAccountsTable.id, cur.accountId));
      }
      // 견적 선입/이월을 고친 경우: 견적 규칙으로 차감·견적 스냅샷 재계산(견적서와 원장 동일 유지)
      if (rules.quoteManaged && !isOutflow(cur.type) && (finChange || changed.includes("transactionDate"))) await resyncQuotePrepaidFromDb(tx, cur.quoteId!);
      // 확정 행 잔액 재기록 + 계정 잔액 = 기초 잔액 + Σ확정(불일치 시 저장 중단)
      const [accNow] = await tx.select({ currentBalance: prepaidAccountsTable.currentBalance, initialAmount: prepaidAccountsTable.initialAmount }).from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, cur.accountId));
      const finalBal = await rewriteRunningBalances(tx, cur.accountId, opening);
      if (Math.abs(finalBal - Number(accNow.currentBalance)) >= 0.005) throw new Error(`잔액 재계산 불일치(원장 ${finalBal} · 계정 ${accNow.currentBalance}) — 저장하지 않았습니다.`);

      // ── 영향 범위 ──
      const afterRows: LedgerSnapshot[] = (await tx.select().from(prepaidLedgerTable).where(eq(prepaidLedgerTable.accountId, cur.accountId))).map(snap);
      const bMap = new Map<number, LedgerSnapshot>(beforeRows.map(r => [r.id, r])), aMap = new Map<number, LedgerSnapshot>(afterRows.map(r => [r.id, r]));
      const other: EditImpact["otherFinancialChanges"] = [];
      let balanceOnly = 0;
      for (const [rid, b] of bMap) {
        if (rid === id) continue;
        const a = aMap.get(rid);
        if (!a) { other.push({ id: rid, status: b.status, type: b.type, field: "row", before: b.amount, after: null, removed: true }); continue; }
        let fin = false;
        for (const k of FIN_KEYS) if (!same(b[k], a[k])) { other.push({ id: rid, status: b.status, type: b.type, field: k, before: b[k], after: a[k] }); fin = true; }
        if (!fin && (!same(b.balanceBefore, a.balanceBefore) || !same(b.balanceAfter, a.balanceAfter))) balanceOnly++;
      }
      for (const [rid, a] of aMap) if (!bMap.has(rid)) other.push({ id: rid, status: a.status, type: a.type, field: "row", before: null, after: a.amount, added: true });
      let quoteImpact: EditImpact["quote"] = null;
      if (quote) {
        const [qa] = await tx.select({ b: quotesTable.prepaidBalanceBefore, u: quotesTable.prepaidUsageAmount, a: quotesTable.prepaidBalanceAfter }).from(quotesTable).where(eq(quotesTable.id, quote.id));
        const qb = { balanceBefore: n(quote.prepaidBalanceBefore), usageAmount: n(quote.prepaidUsageAmount), balanceAfter: n(quote.prepaidBalanceAfter) };
        const qn = { balanceBefore: n(qa?.b), usageAmount: n(qa?.u), balanceAfter: n(qa?.a) };
        if (!same(qb.balanceBefore, qn.balanceBefore) || !same(qb.usageAmount, qn.usageAmount) || !same(qb.balanceAfter, qn.balanceAfter))
          quoteImpact = { id: quote.id, quoteNumber: quote.quoteNumber ?? null, status: quote.status ?? null, before: qb, after: qn };
      }
      const warnings: string[] = [];
      const otherConfirmed = other.filter(o => o.status === "confirmed" || (o.added && aMap.get(o.id)?.status === "confirmed"));
      if (otherConfirmed.length) warnings.push(`이미 확정된 다른 거래 ${new Set(otherConfirmed.map(o => o.id)).size}건의 금액/배분이 함께 바뀝니다.`);
      if (quoteImpact && quote?.status === "approved") warnings.push(`판매확정 견적 ${quote.quoteNumber ?? "#" + quote.id}의 차감 스냅샷(견적서 PDF 금액)이 바뀝니다.`);
      const impact: EditImpact = {
        target: { before: cur, after: aMap.get(id)! }, balance: { before: balBefore, after: finalBal },
        initialAmount: { before: initBefore, after: Number(accNow.initialAmount) },
        otherFinancialChanges: other, balanceOnlyRows: balanceOnly, quote: quoteImpact, warnings,
        // 추가 확인 절차 없음 — 연동 변경(견적 차감·스냅샷)도 저장과 함께 반영하고 변경 전·후는 이력에 남긴다
        needsConfirm: false,
      };
      if (input.dryRun) throw new Rollback({ result: "preview", impact });
      if (impact.needsConfirm && !input.confirmImpact) throw new Rollback({ result: "confirm_required", impact });

      // ── 이력 ──
      await writeHistory(tx, { ledgerId: id, accountId: cur.accountId, action: "update", before: cur, after: aMap.get(id), reason: input.reason, actor });
      const touched = new Set(other.map(o => o.id));
      for (const rid of touched) {
        await writeHistory(tx, { ledgerId: rid, accountId: cur.accountId, action: "quote_sync", before: bMap.get(rid) ?? null, after: aMap.get(rid) ?? null,
          reason: `원장 #${id} 수정에 따른 견적 연동 재계산${input.reason?.trim() ? ` — ${input.reason.trim()}` : ""}`, actor });
      }
      return { result: "saved", entry: aMap.get(id)!, impact } as const;
    });
  } catch (e) {
    if (e instanceof Rollback) return e.payload;
    throw e;
  }
}

// ═══ 원장 행 삭제(관리자) — 이력 보존 + 기초 잔액 보존 재계산 ═══════════════════════════════════
export async function deleteLedgerEntry(dbh: Db, id: number, actor: { id?: number | null; email?: string | null } | null, reason?: string | null) {
  return dbh.transaction(async (tx: Db) => {
    const [row] = await tx.select().from(prepaidLedgerTable).where(eq(prepaidLedgerTable.id, id)).for("update");
    if (!row) return { result: "not_found" as const };
    const [acc] = await tx.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, row.accountId)).for("update");
    if (!acc) return { result: "not_found" as const };
    const opening = r2(Number(acc.currentBalance) - (await confirmedNet(tx, row.accountId)));
    const cur = snap(row);
    await tx.delete(prepaidLedgerTable).where(eq(prepaidLedgerTable.id, id));
    const bal = await rewriteRunningBalances(tx, row.accountId, opening);
    const init = Number(acc.initialAmount) - (countsToInitial(row) ? cur.amount : 0);
    await tx.update(prepaidAccountsTable).set({ currentBalance: String(bal), initialAmount: String(r2(init)) }).where(eq(prepaidAccountsTable.id, row.accountId));
    await writeHistory(tx, { ledgerId: id, accountId: row.accountId, action: "delete", before: cur, after: null, reason, actor });
    return { result: "deleted" as const, balance: bal };
  });
}

