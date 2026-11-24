import {
  db, payoutRoundsTable, payoutRoundItemsTable, payoutTransfersTable, translatorSensitiveTable,
  companySensitiveTable,
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
  // 확정취소 → 수정 → 재확정 후 재동기화(2026-11): 미송금·송금파일 미생성 송금건의 금액·건수를 새 확정 스냅샷으로 갱신한 수.
  refreshed?: number;
  // 금액이 달라졌지만 송금파일이 이미 생성됐거나 지급완료/실패 상태라 자동 갱신하지 않은 송금건(수동 확인 필요).
  staleLocked?: { payeeKey: string; payeeName: string | null; amount: number; expected: number; status: string }[];
  // 새 확정 스냅샷에 더 이상 없는 지급대상의 미송금 송금건(수동 확인 필요 — 자동 삭제·취소하지 않음).
  orphaned?: { payeeKey: string; payeeName: string | null; amount: number; status: string }[];
};

// payout_round_items 를 payeeKey 기준으로 합산한 중간 집계 단위.
type PayeeAgg = {
  payeeKey: string;
  payeeType: "individual" | "vendor" | "none";
  payeeId: number | null;
  payeeName: string | null;
  amount: number;         // 송금액 = Σ netAmount(실지급액)의 원 단위 반올림
  amountExact?: number;   // Σ netAmount 소수 2자리(원 단위 처리 전) — 기존 방식 송금건 대조용
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
  // 수취인별 송금액 = 원 단위 반올림(2026-11-25 — 지급회차 화면·지급명세서 최종 지급액·IBK 파일과 같은 값).
  //   건별 실지급(소수 2자리) 합계를 먼저 정리한 뒤 반올림. amountExact 는 기존 방식(소수 2자리) 송금건 대조용.
  for (const g of groups.values()) { g.amountExact = Math.round(g.amount * 100) / 100; g.amount = Math.round(g.amountExact); }
  return [...groups.values()];
}

// 계좌정보 검증(§8). 원천 분기(§7): 개인=translator_sensitive, 거래처(vendor)=company_sensitive.
//  · 개인/거래처 모두 동일 필드(은행명·계좌번호·형식·예금주)를 검증한다.
//  · 거래처가 외주업체인지 고객사인지는 검증 가능 여부의 조건으로 쓰지 않는다(companyId 기준 조회만).
export function verifyAccount(
  payeeType: string,
  bankName: string | null,
  accountPlain: string | null,
  accountHolder: string | null,
): { verificationStatus: Verification; status: TransferStatus; failureReason: string | null } {
  if (payeeType !== "individual" && payeeType !== "vendor") {
    // 지급대상 유형이 개인/거래처 어느 쪽에도 매칭되지 않으면 검증 원천이 없다 → fail-safe 미검증.
    return {
      verificationStatus: "missing",
      status: "pending",
      failureReason: "지급대상 유형에 대응하는 계좌정보 원천이 없습니다 — 지급 실행 단계에서 계좌 확인 필요",
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
 * 송금건이 이미 있는 회차만 재동기화(2026-11) — 재확정·지급완료 직전 호출.
 *  · 송금건이 하나도 없으면 아무 것도 하지 않는다(null) — 송금건 없이 운영하는 기존 회차 흐름 불변.
 *  · 있으면 generatePayoutTransfers 로 미송금·파일 미생성 건 금액을 확정 스냅샷에 맞추고, 바꿀 수 없는 불일치는 staleLocked 로 보고.
 */
export async function resyncTransfersIfAny(round: PayoutRound, log?: Logger): Promise<GenerateTransfersResult | null> {
  if (round.status !== "confirmed") return null;
  const [one] = await db.select({ id: payoutTransfersTable.id }).from(payoutTransfersTable)
    .where(eq(payoutTransfersTable.payoutRoundId, round.id)).limit(1);
  if (!one) return null;
  return generatePayoutTransfers(round, log);
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

  // 2) 계좌정보 원천 조회(§7) — 개인=translator_sensitive(translatorId=users.id), 거래처=company_sensitive(companyId).
  const indivIds = [...new Set(aggs.filter((a) => a.payeeType === "individual" && a.payeeId != null).map((a) => a.payeeId as number))];
  const sensMap = new Map<number, typeof translatorSensitiveTable.$inferSelect>();
  if (indivIds.length) {
    const sensRows = await db.select().from(translatorSensitiveTable)
      .where(inArray(translatorSensitiveTable.translatorId, indivIds));
    for (const s of sensRows) sensMap.set(s.translatorId, s);
  }
  const vendorIds = [...new Set(aggs.filter((a) => a.payeeType === "vendor" && a.payeeId != null).map((a) => a.payeeId as number))];
  const compMap = new Map<number, typeof companySensitiveTable.$inferSelect>();
  if (vendorIds.length) {
    const compRows = await db.select().from(companySensitiveTable)
      .where(inArray(companySensitiveTable.companyId, vendorIds));
    for (const c of compRows) compMap.set(c.companyId, c);
  }

  // 3) 삽입 후보 구성 — 계좌정보 snapshot(암호문) + 검증결과.
  const values: InsertPayoutTransfer[] = aggs.map((a) => {
    const sens = a.payeeType === "individual" && a.payeeId != null ? sensMap.get(a.payeeId) : undefined;
    const comp = a.payeeType === "vendor" && a.payeeId != null ? compMap.get(a.payeeId) : undefined;
    const bankName = sens?.bankName ?? comp?.bankName ?? null;
    const accountHolder = sens?.accountHolder ?? comp?.accountHolder ?? null;
    // 암호화 snapshot(평문 저장 금지). 개인은 레거시 평문/암호문 혼재, 거래처는 항상 암호문.
    const bankAccountEncSnapshot = sens
      ? toEncryptedAccount(sens.bankAccountEnc, sens.bankAccount)
      : comp
        ? toEncryptedAccount(comp.bankAccountEnc, null)
        : null;
    // 검증은 평문 형식으로 판단(메모리 내부 전용, 저장·로그 금지).
    const accountPlain = sens
      ? readAccountPlain(sens.bankAccountEnc, sens.bankAccount)
      : comp
        ? readAccountPlain(comp.bankAccountEnc, null)
        : null;
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

  // 4-1) 기존 송금건 재동기화(2026-11) — 확정취소 후 금액이 정정되어 재확정된 경우, 기존 송금건이 옛 금액으로 남지 않도록 한다.
  //   · 갱신 대상: 지급완료(paid)·실패(failed)·취소(cancelled)가 아니고, 송금파일 미생성·paidAt 없음(실제 송금 전).
  //   · 그 외 금액 불일치는 덮어쓰지 않고 staleLocked 로 보고(실제 지급기록·송금파일 보존).
  //   · 스냅샷에 없는 지급대상의 미송금 건은 orphaned 로 보고만 한다(삭제·취소 없음).
  let refreshed = 0;
  const staleLocked: NonNullable<GenerateTransfersResult["staleLocked"]> = [];
  const orphaned: NonNullable<GenerateTransfersResult["orphaned"]> = [];
  {
    const existing = await db.select().from(payoutTransfersTable).where(eq(payoutTransfersTable.payoutRoundId, round.id));
    const aggByKey = new Map(aggs.map((a) => [a.payeeKey, a]));
    for (const t of existing) {
      const a = aggByKey.get(t.payeeKey);
      if (!a) {
        if (t.status !== "paid" && t.status !== "cancelled" && num(t.amount) !== 0) orphaned.push({ payeeKey: t.payeeKey, payeeName: t.payeeName, amount: num(t.amount), status: t.status });
        continue;
      }
      const expected = a.amount;
      // 기존 방식(소수 2자리 합계)으로 만들어진 송금건도 같은 금액으로 인정 — 확정 회차·송금파일 생성 건을 바꾸지 않는다.
      const sameAmount = Math.abs(num(t.amount) - expected) < 0.005 || (a.amountExact != null && Math.abs(num(t.amount) - a.amountExact) < 0.005);
      if (sameAmount && t.assignmentCount === a.assignmentCount) continue;
      const mutable = t.status !== "paid" && t.status !== "failed" && t.status !== "cancelled" && !t.ibkFileGenerated && t.paidAt == null;
      if (mutable) {
        await db.update(payoutTransfersTable)
          .set({ amount: expected.toFixed(2), assignmentCount: a.assignmentCount, updatedAt: new Date() })
          .where(eq(payoutTransfersTable.id, t.id));
        refreshed++;
        log?.info({ payoutRoundId: round.id, transferId: t.id, before: num(t.amount), after: expected }, "payout_transfer amount re-synced to confirmed snapshot");
      } else {
        staleLocked.push({ payeeKey: t.payeeKey, payeeName: t.payeeName, amount: num(t.amount), expected, status: t.status });
      }
    }
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
    refreshed,
    ...(staleLocked.length ? { staleLocked } : {}),
    ...(orphaned.length ? { orphaned } : {}),
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
  // 원천 분기(§7): 개인=translator_sensitive(translatorId), 거래처=company_sensitive(companyId=payeeId).
  let sens: typeof translatorSensitiveTable.$inferSelect | undefined;
  let comp: typeof companySensitiveTable.$inferSelect | undefined;
  let bankName: string | null = transfer.bankNameSnapshot;
  let accountHolder: string | null = transfer.accountHolderSnapshot;
  let accountPlain: string | null = null;
  let freshEnc: string | null = transfer.bankAccountEncSnapshot;
  if (transfer.payeeType === "individual" && transfer.payeeId != null) {
    [sens] = await db.select().from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, transfer.payeeId));
    bankName = sens?.bankName ?? null;
    accountHolder = sens?.accountHolder ?? null;
    accountPlain = sens ? readAccountPlain(sens.bankAccountEnc, sens.bankAccount) : null;
    freshEnc = sens ? toEncryptedAccount(sens.bankAccountEnc, sens.bankAccount) : transfer.bankAccountEncSnapshot;
  } else if (transfer.payeeType === "vendor" && transfer.payeeId != null) {
    [comp] = await db.select().from(companySensitiveTable)
      .where(eq(companySensitiveTable.companyId, transfer.payeeId));
    bankName = comp?.bankName ?? null;
    accountHolder = comp?.accountHolder ?? null;
    accountPlain = comp ? readAccountPlain(comp.bankAccountEnc, null) : null;
    freshEnc = comp ? toEncryptedAccount(comp.bankAccountEnc, null) : transfer.bankAccountEncSnapshot;
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
    // 검증 성공 시에만 최신 계좌정보로 snapshot 갱신(§9). amount·assignmentCount 는 절대 미변경.
    patch.bankNameSnapshot = bankName;
    patch.accountHolderSnapshot = accountHolder;
    patch.bankAccountEncSnapshot = freshEnc;
  }
  await db.update(payoutTransfersTable).set(patch).where(eq(payoutTransfersTable.id, transfer.id));
  return { transferId: transfer.id, verificationStatus: v.verificationStatus, status: v.status, failureReason: v.failureReason, snapshotUpdated };
}
