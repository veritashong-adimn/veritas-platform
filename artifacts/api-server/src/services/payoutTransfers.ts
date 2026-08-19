import {
  db, payoutRoundsTable, payoutRoundItemsTable, payoutTransfersTable, translatorSensitiveTable,
  type InsertPayoutTransfer, type PayoutRound,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { toEncryptedAccount, readAccountPlain, isValidBankAccountFormat } from "../lib/encrypt";

// ─────────────────────────────────────────────────────────────────────────────
// 1인 1송금 집계 서비스 — confirmed 지급회차의 payout_round_items(동결 스냅샷)를
// 지급대상(payee)별로 합산하여 payout_transfers 를 생성/동기화한다.
//  · 원본 performance_assignments 재계산 금지 — 오직 payout_round_items 만 읽는다(§7).
//  · idempotent: UNIQUE(payoutRoundId, payeeKey) 기준 onConflictDoNothing.
//    이미 존재하는 송금건(특히 paid)은 절대 수정/삭제하지 않는다(§6).
//  · 계좌번호는 암호화 snapshot 만 저장. 평문은 검증(형식/존재)용으로만 메모리에서 사용(§9).
// ─────────────────────────────────────────────────────────────────────────────

type Verification = "verified" | "missing" | "invalid";
type TransferStatus = "pending" | "ready" | "paid" | "failed" | "excluded" | "cancelled";

const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

// 재검증 대상 상태(§5·§6) — paid/excluded/cancelled 는 재검증·snapshot 변경 금지.
export const REVERIFIABLE_STATUSES: TransferStatus[] = ["pending", "ready", "failed"];

export type GenerateTransfersResult = {
  roundId: number;
  roundStatus: string;
  created: number;              // 이번 실행에서 신규 생성된 송금건 수
  skippedExisting: number;      // 이미 존재하여 건너뛴 payee 수(중복 미생성)
  totalTransfers: number;       // 회차의 전체 송금건 수(=지급대상 N명)
  totalAmount: number;          // 총 실지급액
  byStatus: Record<TransferStatus, number>;
  byVerification: Record<Verification, number>;
};

// payout_round_items 를 payeeKey 기준으로 합산한 중간 집계 단위.
type PayeeAgg = {
  payeeKey: string;
  payeeType: "individual" | "vendor" | "none";
  payeeId: number | null;
  payeeName: string | null;
  amount: number;         // Σ netAmount(실지급액)
  assignmentCount: number;
};

// 확정 스냅샷을 지급대상별로 합산(§3). 개인 i:{userId} / 외주 v:{companyId}.
function aggregateByPayee(rows: (typeof payoutRoundItemsTable.$inferSelect)[]): PayeeAgg[] {
  const groups = new Map<string, PayeeAgg>();
  for (const r of rows) {
    const isIndiv = r.payeeType === "individual";
    const isVendor = r.payeeType === "vendor";
    const prefix = isIndiv ? "i" : isVendor ? "v" : "n";
    const key = `${prefix}:${r.payeeId ?? "none"}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        payeeKey: key,
        payeeType: isIndiv ? "individual" : isVendor ? "vendor" : "none",
        payeeId: r.payeeId ?? null,
        payeeName: r.payeeName ?? null,
        amount: 0,
        assignmentCount: 0,
      };
      groups.set(key, g);
    }
    g.amount += num(r.netAmount);
    g.assignmentCount += 1;
    if (!g.payeeName && r.payeeName) g.payeeName = r.payeeName;
  }
  // 부동소수 누적 오차 정리(원 단위 2소수).
  for (const g of groups.values()) g.amount = Math.round(g.amount * 100) / 100;
  return [...groups.values()];
}

// 계좌정보 검증(§5). 개인: 은행명·계좌번호·형식·예금주. 외주: 계좌 원천 미연결 → missing.
export function verifyAccount(
  payeeType: string,
  bankName: string | null,
  accountPlain: string | null,
  accountHolder: string | null,
): { verificationStatus: Verification; status: TransferStatus; failureReason: string | null } {
  if (payeeType !== "individual") {
    // 외주업체는 통번역사 계좌 원천(translator_sensitive)에 대응되지 않는다 → 자동 검증 불가.
    // fail-safe: 미검증(pending) 상태로 두고, 지급 실행 단계에서 계좌 입력/검증을 연결한다.
    return {
      verificationStatus: "missing",
      status: "pending",
      failureReason: "외주 지급대상 계좌정보 원천 미연결 — 지급 실행 단계에서 계좌 입력·검증 필요",
    };
  }
  const hasBankName = !!bankName?.trim();
  const hasAccount = !!accountPlain?.trim();
  const hasHolder = !!accountHolder?.trim();
  if (!hasBankName || !hasAccount || !hasHolder) {
    const miss: string[] = [];
    if (!hasBankName) miss.push("은행명");
    if (!hasAccount) miss.push("계좌번호");
    if (!hasHolder) miss.push("예금주");
    return { verificationStatus: "missing", status: "pending", failureReason: `계좌정보 누락: ${miss.join("·")}` };
  }
  if (!isValidBankAccountFormat(accountPlain)) {
    return { verificationStatus: "invalid", status: "pending", failureReason: "계좌번호 형식 오류(숫자 10~16자리 아님)" };
  }
  return { verificationStatus: "verified", status: "ready", failureReason: null };
}

/**
 * confirmed 지급회차 → payout_transfers 생성/동기화.
 *  · round.status !== "confirmed" 이면 생성하지 않는다(호출측에서 이미 검증하지만 방어적으로 재확인).
 *  · 신규 payee 만 삽입(onConflictDoNothing). 기존 송금건(특히 paid)은 건드리지 않는다.
 */
export async function generatePayoutTransfers(
  round: PayoutRound,
  log?: Logger,
): Promise<GenerateTransfersResult> {
  if (round.status !== "confirmed") {
    throw new Error("payout_transfers 는 지급확정(confirmed) 회차에서만 생성할 수 있습니다.");
  }

  // 1) 확정 스냅샷 로드(원본 재계산 금지) → payee 별 합산.
  const items = await db.select().from(payoutRoundItemsTable)
    .where(eq(payoutRoundItemsTable.payoutRoundId, round.id));
  const aggs = aggregateByPayee(items);

  // 2) 개인 지급대상 계좌정보 조회(translator_sensitive.translatorId = users.id = payeeId).
  const indivIds = [...new Set(aggs.filter((a) => a.payeeType === "individual" && a.payeeId != null).map((a) => a.payeeId as number))];
  const sensMap = new Map<number, typeof translatorSensitiveTable.$inferSelect>();
  if (indivIds.length) {
    const sensRows = await db.select().from(translatorSensitiveTable)
      .where(inArray(translatorSensitiveTable.translatorId, indivIds));
    for (const s of sensRows) sensMap.set(s.translatorId, s);
  }

  // 3) 삽입 후보 구성 — 계좌정보 snapshot(암호문) + 검증결과.
  const values: InsertPayoutTransfer[] = aggs.map((a) => {
    const sens = a.payeeType === "individual" && a.payeeId != null ? sensMap.get(a.payeeId) : undefined;
    const bankName = sens?.bankName ?? null;
    const accountHolder = sens?.accountHolder ?? null;
    // 암호화 snapshot(평문 저장 금지). 레거시 평문/암호문 모두 안전 처리.
    const bankAccountEncSnapshot = sens ? toEncryptedAccount(sens.bankAccountEnc, sens.bankAccount) : null;
    // 검증은 평문 형식으로 판단(메모리 내부 전용, 저장·로그 금지).
    const accountPlain = sens ? readAccountPlain(sens.bankAccountEnc, sens.bankAccount) : null;
    const v = verifyAccount(a.payeeType, bankName, accountPlain, accountHolder);
    return {
      payoutRoundId: round.id,
      payeeType: a.payeeType,
      payeeId: a.payeeId,
      payeeKey: a.payeeKey,
      payeeName: a.payeeName,
      bankNameSnapshot: bankName,
      bankAccountEncSnapshot,
      accountHolderSnapshot: accountHolder,
      amount: a.amount.toFixed(2),
      assignmentCount: a.assignmentCount,
      verificationStatus: v.verificationStatus,
      status: v.status,
      failureReason: v.failureReason,
    };
  });

  // 4) idempotent 삽입 — 동일 회차+payee 중복 방지, 기존건(특히 paid) 불변.
  let created = 0;
  if (values.length) {
    const inserted = await db.insert(payoutTransfersTable)
      .values(values)
      .onConflictDoNothing({ target: [payoutTransfersTable.payoutRoundId, payoutTransfersTable.payeeKey] })
      .returning({ id: payoutTransfersTable.id });
    created = inserted.length;
  }

  // 5) 결과 집계(현재 회차 전체 송금건 기준).
  const all = await db.select().from(payoutTransfersTable)
    .where(eq(payoutTransfersTable.payoutRoundId, round.id));
  const byStatus: Record<TransferStatus, number> = { pending: 0, ready: 0, paid: 0, failed: 0, excluded: 0, cancelled: 0 };
  const byVerification: Record<Verification, number> = { verified: 0, missing: 0, invalid: 0 };
  let totalAmount = 0;
  for (const t of all) {
    byStatus[t.status as TransferStatus] = (byStatus[t.status as TransferStatus] ?? 0) + 1;
    byVerification[t.verificationStatus as Verification] = (byVerification[t.verificationStatus as Verification] ?? 0) + 1;
    totalAmount += num(t.amount);
  }

  const result: GenerateTransfersResult = {
    roundId: round.id,
    roundStatus: round.status,
    created,
    skippedExisting: values.length - created,
    totalTransfers: all.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    byStatus,
    byVerification,
  };
  // 계좌번호 평문·암호문은 로그에 남기지 않는다(§9) — 집계 카운트만 기록.
  log?.info({ payoutRoundId: round.id, ...result, byStatus: undefined, byVerification: undefined }, "payout_transfers generated/synced");
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 계좌 재검증(§5·§6) — 현재 통번역사 계좌정보를 다시 조회하여 검증한다.
//  · amount(확정 금액)는 절대 변경하지 않는다. 계좌정보·verificationStatus·status 만 갱신.
//  · 정상(verified)일 경우에만 계좌 snapshot(은행/계좌/예금주)을 최신값으로 갱신한다(§5).
//    누락·오류면 status/verification/failureReason 만 갱신하고 기존 snapshot 은 보존한다.
//  · paid/excluded/cancelled 는 재검증·snapshot 변경 금지(호출측에서 차단, 여기서도 방어).
// ─────────────────────────────────────────────────────────────────────────────
export type ReverifyResult = {
  transferId: number;
  verificationStatus: Verification;
  status: TransferStatus;
  failureReason: string | null;
  snapshotUpdated: boolean;
};

export async function reverifyTransfer(
  transfer: typeof payoutTransfersTable.$inferSelect,
): Promise<ReverifyResult> {
  if (!REVERIFIABLE_STATUSES.includes(transfer.status as TransferStatus)) {
    throw new Error(`재검증할 수 없는 상태입니다(${transfer.status}).`);
  }
  // 개인: 최신 원천(translator_sensitive) 조회. 외주: 원천 미연결 → verifyAccount 가 missing 처리.
  let sens: typeof translatorSensitiveTable.$inferSelect | undefined;
  let bankName: string | null = transfer.bankNameSnapshot;
  let accountHolder: string | null = transfer.accountHolderSnapshot;
  let accountPlain: string | null = null;
  if (transfer.payeeType === "individual" && transfer.payeeId != null) {
    [sens] = await db.select().from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, transfer.payeeId));
    bankName = sens?.bankName ?? null;
    accountHolder = sens?.accountHolder ?? null;
    accountPlain = sens ? readAccountPlain(sens.bankAccountEnc, sens.bankAccount) : null;
  }
  const v = verifyAccount(transfer.payeeType ?? "", bankName, accountPlain, accountHolder);
  const patch: Partial<typeof payoutTransfersTable.$inferInsert> = {
    verificationStatus: v.verificationStatus,
    status: v.status,
    failureReason: v.failureReason,
    updatedAt: new Date(),
  };
  const snapshotUpdated = v.verificationStatus === "verified";
  if (snapshotUpdated) {
    patch.bankNameSnapshot = bankName;
    patch.accountHolderSnapshot = accountHolder;
    patch.bankAccountEncSnapshot = sens ? toEncryptedAccount(sens.bankAccountEnc, sens.bankAccount) : transfer.bankAccountEncSnapshot;
  }
  await db.update(payoutTransfersTable).set(patch).where(eq(payoutTransfersTable.id, transfer.id));
  return { transferId: transfer.id, verificationStatus: v.verificationStatus, status: v.status, failureReason: v.failureReason, snapshotUpdated };
}
