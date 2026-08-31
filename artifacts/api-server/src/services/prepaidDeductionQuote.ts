// ─── 차감 견적서(b2c_prepaid) 전용 선입금/차감 잔액 파이프라인 ────────────────
// 설계 원칙
//  1) 견적 저장 시 실제 잔액(current_balance)을 건드리지 않는다.
//     선입/이월 라인과 차감액을 prepaid_ledger 에 status='reserved'(차감예정)로만 기록한다.
//     → 가용잔액만 점유하여 동시 차감 견적의 중복 사용을 막는다.
//  2) 판매전환(approved) 시 reserved → confirmed 로 승격하면서 실제 잔액에 반영한다.
//     (선입/이월 = 입금(+), 차감 = 출금(-)) 순서로 계정 잠금(FOR UPDATE) 후 적용.
//  3) 미체결/취소 시 되돌린다.
//     - project 취소: 재판매전환 가능하도록 confirmed→reserved 로 반전(잔액 원복)만 한다.
//     - 거절/삭제: confirmed 반전 후 reserved/confirmed 모두 released 로 종료한다.
//  4) 기존 일반/누적 견적서와 수동 입출금(항상 confirmed)에는 어떤 영향도 주지 않는다.
//     본 모듈은 오직 quoteType ∈ (b2c_prepaid, prepaid_deduction) 에서만 호출된다.

import { and, eq, inArray, desc, sql } from "drizzle-orm";
import {
  prepaidAccountsTable,
  prepaidLedgerTable,
  projectsTable,
  quotesTable,
} from "@workspace/db";

// drizzle 트랜잭션/DB 핸들은 구조가 동일하므로 느슨하게 받는다.
type Db = any;

export const PREPAID_DEDUCTION_QUOTE_TYPES = ["b2c_prepaid", "prepaid_deduction"] as const;
export function isPrepaidDeductionQuoteType(t: string | null | undefined): boolean {
  return t === "b2c_prepaid" || t === "prepaid_deduction";
}

// 선입 유입 유형: deposit(선입금 — 발생일로 복수 구분) / carryover(기존 진행건 잔액 이월)
const INFLOW_TYPES = ["deposit", "carryover"] as const;
type InflowType = (typeof INFLOW_TYPES)[number];
function isInflowType(t: string): t is InflowType {
  return (INFLOW_TYPES as readonly string[]).includes(t);
}

// 선입/이월 입력 라인 (프론트 → 저장 payload)
export type PrepaidLineInput = {
  type: InflowType;               // 선입금(deposit) | 기존 진행건 잔액 이월(carryover)
  amount: number;                 // 금액(양수)
  transactionDate?: string | null; // 발생/입금일 (YYYY-MM-DD)
  sourceRef?: string | null;      // 원천정보(자유 텍스트: 원 견적/판매/프로젝트 번호 등)
  sourceProjectId?: number | null;
  sourceQuoteId?: number | null;
  note?: string | null;           // 비고
};

const today = () => new Date().toISOString().slice(0, 10);

// ─── 거래처의 대표(단일) 선입금 계정 조회 or 생성 ────────────────────────────
// 차감 견적 흐름은 거래처당 하나의 지갑 계정으로 관리한다(없으면 0원 계정 생성).
async function getOrCreatePrimaryAccount(tx: Db, companyId: number, lock = false): Promise<{ id: number; currentBalance: number }> {
  const base = tx
    .select({ id: prepaidAccountsTable.id, currentBalance: prepaidAccountsTable.currentBalance })
    .from(prepaidAccountsTable)
    .where(and(eq(prepaidAccountsTable.companyId, companyId), eq(prepaidAccountsTable.status, "active")))
    .orderBy(desc(prepaidAccountsTable.createdAt))
    .limit(1);
  const rows = lock ? await base.for("update") : await base;
  if (rows[0]) return { id: rows[0].id, currentBalance: Number(rows[0].currentBalance) };
  const [created] = await tx
    .insert(prepaidAccountsTable)
    .values({ companyId, initialAmount: "0", currentBalance: "0", note: "차감 견적 자동 생성 계정" })
    .returning();
  return { id: created.id, currentBalance: 0 };
}

// 거래처의 모든 active 계정 id
async function getCompanyAccountIds(dbh: Db, companyId: number): Promise<number[]> {
  const rows = await dbh
    .select({ id: prepaidAccountsTable.id })
    .from(prepaidAccountsTable)
    .where(and(eq(prepaidAccountsTable.companyId, companyId), eq(prepaidAccountsTable.status, "active")));
  return rows.map((r: any) => r.id);
}

// ─── 거래처 가용잔액 상태 조회 (차감 요약 계산용) ─────────────────────────────
//  confirmedBalance = Σ active 계정 current_balance (실제 확정 잔액)
//  reservedDeduction = Σ 다른 차감 견적의 reserved 차감액 (중복 사용 방지)
//  available = confirmedBalance − reservedDeduction  (이번 견적의 '이전 가용잔액')
export async function getCompanyPrepaidState(
  dbh: Db,
  companyId: number,
  excludeQuoteId?: number | null,
): Promise<{ accountId: number | null; confirmedBalance: number; reservedDeduction: number; available: number }> {
  const accountIds = await getCompanyAccountIds(dbh, companyId);
  if (accountIds.length === 0) {
    return { accountId: null, confirmedBalance: 0, reservedDeduction: 0, available: 0 };
  }
  const accounts = await dbh
    .select({ id: prepaidAccountsTable.id, currentBalance: prepaidAccountsTable.currentBalance, createdAt: prepaidAccountsTable.createdAt })
    .from(prepaidAccountsTable)
    .where(inArray(prepaidAccountsTable.id, accountIds))
    .orderBy(desc(prepaidAccountsTable.createdAt));
  const confirmedBalance = accounts.reduce((s: number, a: any) => s + Number(a.currentBalance), 0);

  const conds = [
    inArray(prepaidLedgerTable.accountId, accountIds),
    eq(prepaidLedgerTable.type, "deduction"),
    eq(prepaidLedgerTable.status, "reserved"),
  ];
  if (excludeQuoteId != null) conds.push(sql`${prepaidLedgerTable.quoteId} IS DISTINCT FROM ${excludeQuoteId}`);
  const [{ total } = { total: 0 }] = await dbh
    .select({ total: sql<number>`COALESCE(SUM(${prepaidLedgerTable.amount}), 0)` })
    .from(prepaidLedgerTable)
    .where(and(...conds));
  const reservedDeduction = Number(total ?? 0);

  return {
    accountId: accounts[0]?.id ?? null,
    confirmedBalance,
    reservedDeduction,
    available: confirmedBalance - reservedDeduction,
  };
}

// ─── 차감 요약 계산 (프론트/백엔드 공용 순수 함수) ───────────────────────────
// 잔액보다 견적금액이 크면 차감적용액 = 가용, 추가청구액 = 차액, 차감후잔액 = 0.
export function computeDeductionSummary(input: {
  previousAvailable: number;   // 이전 가용잔액
  incomingPrepaid: number;     // 이번 선입/이월 합
  quoteTotal: number;          // 이번 견적금액
}): { totalAvailable: number; appliedDeduction: number; additionalCharge: number; remainingAfter: number } {
  const previousAvailable = Math.max(0, Math.round(input.previousAvailable));
  const incomingPrepaid = Math.max(0, Math.round(input.incomingPrepaid));
  const quoteTotal = Math.max(0, Math.round(input.quoteTotal));
  const totalAvailable = previousAvailable + incomingPrepaid;
  const appliedDeduction = Math.min(totalAvailable, quoteTotal);
  const additionalCharge = quoteTotal - appliedDeduction;
  const remainingAfter = totalAvailable - appliedDeduction;
  return { totalAvailable, appliedDeduction, additionalCharge, remainingAfter };
}

// ─── 견적 저장 시 예약 동기화 (reserved 라인 재작성) ─────────────────────────
// 기존 reserved 라인을 지우고 선입/이월 + 차감(reserved)을 다시 기록한다.
// confirmed/released 라인은 절대 건드리지 않는다(이미 전환/종료된 이력 보존).
// 반환: 이번 견적의 차감 요약 + 계정 스냅샷(quote 스칼라 갱신용).
export async function syncQuoteReservations(
  tx: Db,
  args: {
    quoteId: number;
    companyId: number | null;
    projectId: number | null;
    prepaidLines: PrepaidLineInput[];
    quoteTotal: number;       // 견적금액(항목 합)
    quoteSupply: number;      // 항목 공급가 합
    quoteTax: number;         // 항목 부가세 합
    transactionDate?: string | null;
  },
): Promise<{ previousAvailable: number; incomingPrepaid: number; summary: ReturnType<typeof computeDeductionSummary> } | null> {
  const { quoteId, companyId, projectId, prepaidLines, quoteTotal, quoteSupply, quoteTax } = args;

  // 멱등성: 이미 판매전환(confirmed)된 견적은 재예약하지 않는다.
  //  판매전환 후 '수정 저장(PUT)'이 다시 들어와도 confirmed 이력 위에 reserved 를 중복 생성하지 않게 skip.
  //  (확정 차감은 원장의 확정 기록으로 유지된다. 재차감이 필요하면 판매취소로 reserved 복귀 후 처리)
  const confirmed = await tx
    .select({ id: prepaidLedgerTable.id })
    .from(prepaidLedgerTable)
    .where(and(eq(prepaidLedgerTable.quoteId, quoteId), eq(prepaidLedgerTable.status, "confirmed")))
    .limit(1);
  if (confirmed.length > 0) return null;

  // 이전 reserved 라인 정리(이 견적 한정) — confirmed/released 는 제외.
  await tx.delete(prepaidLedgerTable).where(
    and(eq(prepaidLedgerTable.quoteId, quoteId), eq(prepaidLedgerTable.status, "reserved")),
  );

  // 거래처 미지정 시 계정을 만들 수 없으므로 예약 생략(전환 시점에 거래처 확정되면 재저장 필요).
  if (!companyId) return null;

  const account = await getOrCreatePrimaryAccount(tx, companyId, false);
  const txDate = args.transactionDate || today();

  // 이전 가용잔액(이 견적 제외)
  const state = await getCompanyPrepaidState(tx, companyId, quoteId);
  const incomingPrepaid = prepaidLines.reduce((s, l) => s + Math.max(0, Number(l.amount) || 0), 0);
  const summary = computeDeductionSummary({
    previousAvailable: state.available,
    incomingPrepaid,
    quoteTotal,
  });

  // 선입/이월 라인 → reserved inflow (잔액 미반영: balance placeholder 0)
  for (const line of prepaidLines) {
    const amt = Math.max(0, Number(line.amount) || 0);
    if (amt <= 0) continue;
    const type: InflowType = isInflowType(line.type) ? line.type : "deposit";
    const label = type === "carryover" ? "이월(예약)" : "선입(예약)";
    const src =
      type === "carryover"
        ? `원천: ${[line.sourceRef, line.sourceProjectId ? `P#${line.sourceProjectId}` : null, line.sourceQuoteId ? `Q#${line.sourceQuoteId}` : null].filter(Boolean).join(" ") || "-"}`
        : line.sourceRef
          ? `원천: ${line.sourceRef}`
          : "";
    await tx.insert(prepaidLedgerTable).values({
      accountId: account.id,
      projectId: projectId ?? null,
      quoteId,
      type,
      status: "reserved",
      amount: String(amt),
      balanceBefore: null,
      balanceAfter: "0",
      description: [label, src, line.note].filter(Boolean).join(" · "),
      transactionDate: line.transactionDate || txDate,
    });
  }

  // 차감(reserved) — 실제 차감 적용액만 예약(추가청구액은 차감 아님)
  if (summary.appliedDeduction > 0) {
    const ratio = quoteTotal > 0 ? summary.appliedDeduction / quoteTotal : 0;
    const supply = Math.round(quoteSupply * ratio);
    const tax = summary.appliedDeduction - supply;
    await tx.insert(prepaidLedgerTable).values({
      accountId: account.id,
      projectId: projectId ?? null,
      quoteId,
      type: "deduction",
      status: "reserved",
      amount: String(summary.appliedDeduction),
      balanceBefore: null,
      balanceAfter: "0",
      supplyAmount: String(supply),
      taxAmount: String(tax),
      description: "서비스 차감(예약)",
      transactionDate: txDate,
    });
  }

  return { previousAvailable: state.available, incomingPrepaid, summary };
}

// ─── 판매전환 시 예약 확정 (reserved → confirmed, 실제 잔액 반영) ────────────
// 반환: quote 스칼라 갱신용 스냅샷.
export async function confirmQuoteReservations(
  tx: Db,
  quoteId: number,
): Promise<{ balanceBefore: number; usageAmount: number; balanceAfter: number } | null> {
  const reserved = await tx
    .select()
    .from(prepaidLedgerTable)
    .where(and(eq(prepaidLedgerTable.quoteId, quoteId), eq(prepaidLedgerTable.status, "reserved")))
    .orderBy(prepaidLedgerTable.id);
  if (reserved.length === 0) return null;

  const accountId: number = reserved[0].accountId;
  // 계정 잠금 후 현재 잔액·입금누계 확보 (동시 전환 직렬화)
  const [locked] = await tx
    .select({ id: prepaidAccountsTable.id, currentBalance: prepaidAccountsTable.currentBalance, initialAmount: prepaidAccountsTable.initialAmount })
    .from(prepaidAccountsTable)
    .where(eq(prepaidAccountsTable.id, accountId))
    .for("update");
  let balance = Number(locked?.currentBalance ?? 0);
  const balanceBefore = balance;
  // 총 입금 누계(initial_amount): 수금관리의 '총 입금 누계 = Σ initialAmount' 기준.
  // 입금(선입/이월) 확정 시에만 증가하고, 차감은 잔액만 줄인다.
  let initialTotal = Number(locked?.initialAmount ?? 0);

  // 1) 입금(선입/이월) 먼저 확정 — 잔액 + 입금누계 동시 증가
  for (const row of reserved.filter((r: any) => isInflowType(r.type))) {
    const amt = Number(row.amount);
    const before = balance;
    balance += amt;
    initialTotal += amt;
    await tx.update(prepaidLedgerTable)
      .set({ status: "confirmed", balanceBefore: String(before), balanceAfter: String(balance), transactionDate: row.transactionDate || today() })
      .where(eq(prepaidLedgerTable.id, row.id));
  }

  // 2) 차감 확정 (가용 = 확정 후 잔액 기준으로 재캡 — 동시 전환/잔액 변동 이중 방어)
  let usageAmount = 0;
  const deductionRow = reserved.find((r: any) => r.type === "deduction");
  if (deductionRow) {
    const requested = Number(deductionRow.amount);
    const applied = Math.min(balance, requested);
    const before = balance;
    balance -= applied;
    usageAmount = applied;
    const ratio = requested > 0 ? applied / requested : 0;
    const supply = deductionRow.supplyAmount != null ? Math.round(Number(deductionRow.supplyAmount) * ratio) : null;
    const tax = supply != null ? applied - supply : null;
    await tx.update(prepaidLedgerTable)
      .set({
        status: "confirmed",
        amount: String(applied),
        supplyAmount: supply != null ? String(supply) : null,
        taxAmount: tax != null ? String(tax) : null,
        balanceBefore: String(before),
        balanceAfter: String(balance),
        description: "서비스 차감",
        transactionDate: deductionRow.transactionDate || today(),
      })
      .where(eq(prepaidLedgerTable.id, deductionRow.id));
  }

  await tx.update(prepaidAccountsTable)
    .set({ currentBalance: String(balance), initialAmount: String(initialTotal) })
    .where(eq(prepaidAccountsTable.id, accountId));
  return { balanceBefore, usageAmount, balanceAfter: balance };
}

// ─── confirmed 라인의 잔액 영향을 되돌린다(계정 잠금) ─────────────────────────
async function reverseConfirmed(tx: Db, quoteIds: number[]): Promise<void> {
  const rows = await tx
    .select()
    .from(prepaidLedgerTable)
    .where(and(inArray(prepaidLedgerTable.quoteId, quoteIds), eq(prepaidLedgerTable.status, "confirmed")))
    .orderBy(desc(prepaidLedgerTable.id));
  const byAccount = new Map<number, any[]>();
  for (const r of rows) {
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, []);
    byAccount.get(r.accountId)!.push(r);
  }
  for (const [accountId, accRows] of byAccount) {
    const [locked] = await tx
      .select({ currentBalance: prepaidAccountsTable.currentBalance, initialAmount: prepaidAccountsTable.initialAmount })
      .from(prepaidAccountsTable)
      .where(eq(prepaidAccountsTable.id, accountId))
      .for("update");
    let balance = Number(locked?.currentBalance ?? 0);
    let initialTotal = Number(locked?.initialAmount ?? 0);
    for (const r of accRows) {
      if (r.type === "deduction") {
        balance += Number(r.amount);                 // 차감 되돌림: 잔액 복원(입금누계 불변)
      } else {
        balance -= Number(r.amount);                 // 입금 되돌림: 잔액 감소
        initialTotal -= Number(r.amount);            //  + 총 입금 누계도 감소
      }
    }
    await tx.update(prepaidAccountsTable)
      .set({ currentBalance: String(balance), initialAmount: String(initialTotal) })
      .where(eq(prepaidAccountsTable.id, accountId));
  }
}

// ─── 판매취소: confirmed 반전 후 reserved 로 복귀 (재판매전환 대비) ───────────
export async function revertQuoteReservationsToReserved(tx: Db, quoteIds: number[]): Promise<void> {
  if (quoteIds.length === 0) return;
  await reverseConfirmed(tx, quoteIds);
  await tx.update(prepaidLedgerTable)
    .set({ status: "reserved", balanceBefore: null, balanceAfter: "0" })
    .where(and(inArray(prepaidLedgerTable.quoteId, quoteIds), eq(prepaidLedgerTable.status, "confirmed")));
}

// ─── 거절/삭제: confirmed 반전 후 모든 라인 released 로 종료 ──────────────────
export async function releaseQuoteReservations(tx: Db, quoteIds: number[]): Promise<void> {
  if (quoteIds.length === 0) return;
  await reverseConfirmed(tx, quoteIds);
  await tx.update(prepaidLedgerTable)
    .set({ status: "released" })
    .where(and(inArray(prepaidLedgerTable.quoteId, quoteIds), inArray(prepaidLedgerTable.status, ["reserved", "confirmed"])));
}

// ─── 견적 상세 조회 시 예약/확정 라인 반환 (프론트 재현용) ────────────────────
export async function getQuotePrepaidLines(dbh: Db, quoteId: number): Promise<Array<{
  id: number; type: string; status: string; amount: number;
  supplyAmount: number | null; taxAmount: number | null;
  description: string | null; transactionDate: string | null;
}>> {
  const rows = await dbh
    .select({
      id: prepaidLedgerTable.id,
      type: prepaidLedgerTable.type,
      status: prepaidLedgerTable.status,
      amount: prepaidLedgerTable.amount,
      supplyAmount: prepaidLedgerTable.supplyAmount,
      taxAmount: prepaidLedgerTable.taxAmount,
      description: prepaidLedgerTable.description,
      transactionDate: prepaidLedgerTable.transactionDate,
    })
    .from(prepaidLedgerTable)
    .where(and(eq(prepaidLedgerTable.quoteId, quoteId), inArray(prepaidLedgerTable.status, ["reserved", "confirmed"])))
    .orderBy(prepaidLedgerTable.id);
  return rows.map((r: any) => ({
    ...r,
    amount: Number(r.amount),
    supplyAmount: r.supplyAmount != null ? Number(r.supplyAmount) : null,
    taxAmount: r.taxAmount != null ? Number(r.taxAmount) : null,
  }));
}
