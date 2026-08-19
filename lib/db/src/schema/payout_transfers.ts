import {
  pgTable, serial, integer, numeric, text, timestamp, boolean, pgEnum, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { payoutRoundsTable } from "./payout_rounds";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 지급 송금 단위(payout_transfers) — 국내 지급 자동화 Phase 1 (실제 은행 송금 추적 계층).
//  · [원칙] 수행건 단위 paymentStatus(unpaid|payment_hold|paid)와 분리하여, 실제 은행 송금을
//    "1인 1송금" 단위로 별도 추적한다. 한 지급대상(payee)의 여러 수행건 → 1개의 payout_transfer.
//  · [집계 원본] 반드시 지급확정(confirmed) 회차의 payout_round_items(동결 스냅샷)만 사용한다.
//    원본 performance_assignments 를 재계산하여 금액을 바꾸지 않는다(§7).
//  · [1인 1송금 보장] UNIQUE(payout_round_id, payee_key) — 동일 회차에서 동일 지급대상이
//    중복 송금 레코드로 생성될 수 없다(DB 레벨 보장, idempotent 재집계의 기준).
//  · [계좌 보안] 계좌번호는 평문이 아니라 암호화된 snapshot(bank_account_enc_snapshot)만 저장한다.
//    복호화는 향후 IBK 대량이체 파일 생성 시 권한 확인 후 서버 내부에서만 수행한다(§9).
//  · Phase 1은 "생성/동기화 + 계좌 검증"까지. 지급 실행 UI·IBK 파일·지급완료/실패 처리는 Phase 2.
// ─────────────────────────────────────────────────────────────────────────────

// 계좌정보 검증 상태 (§5)
export const payoutTransferVerificationEnum = pgEnum("payout_transfer_verification", [
  "verified", // 은행명·계좌번호·형식·예금주 모두 정상
  "missing",  // 필수 계좌정보 누락
  "invalid",  // 계좌번호 형식 오류
]);

// 송금 상태 (§3) — 수행건 paymentStatus 와 별개
export const payoutTransferStatusEnum = pgEnum("payout_transfer_status", [
  "pending",   // 집계됨(계좌 미검증/정보누락) — IBK 파일 대상 아님
  "ready",     // 계좌 검증 완료 — IBK 파일 생성 대상
  "paid",      // 실제 송금 완료(Phase 2)
  "failed",    // 송금 실패(Phase 2)
  "excluded",  // 담당자 명시적 지급 제외(사유 기록) — 지급 대상에서 일시 제외(해제 가능). ≠ 영구취소.
  "cancelled", // 영구 취소(예약) — 제외(excluded)와 의미 구분. Phase 2에서 사용.
]);

export const payoutTransfersTable = pgTable("payout_transfers", {
  id: serial("id").primaryKey(),
  payoutRoundId: integer("payout_round_id")
    .notNull()
    .references(() => payoutRoundsTable.id, { onDelete: "cascade" }),

  // ── 지급대상(payee) ──
  payeeType: text("payee_type"),            // individual | vendor
  payeeId: integer("payee_id"),             // individual=users.id / vendor=companies.id
  payeeKey: text("payee_key").notNull(),    // "i:{userId}" | "v:{companyId}" — 1인 1송금 유니크 키
  payeeName: text("payee_name"),            // 지급대상명 snapshot

  // ── 계좌정보 snapshot(생성 시점 동결) ──
  bankNameSnapshot: text("bank_name_snapshot"),
  bankAccountEncSnapshot: text("bank_account_enc_snapshot"), // 암호화된 계좌번호 snapshot(평문 저장 금지)
  accountHolderSnapshot: text("account_holder_snapshot"),

  // ── 송금 금액/건수(payout_round_items 합산 snapshot) ──
  amount: numeric("amount", { precision: 16, scale: 2 }).notNull().default("0"), // 실지급 합계(netTotal)
  assignmentCount: integer("assignment_count").notNull().default(0),             // 수행건수

  // ── 상태 ──
  verificationStatus: payoutTransferVerificationEnum("verification_status").notNull().default("missing"),
  status: payoutTransferStatusEnum("status").notNull().default("pending"),
  failureReason: text("failure_reason"),

  // ── 지급 제외 추적(§7·§8) — 삭제하지 않고 사유·주체·시각을 보존. 제외 해제 시 초기화(§9). ──
  excludedAt: timestamp("excluded_at"),
  excludedBy: integer("excluded_by").references(() => usersTable.id),
  exclusionReason: text("exclusion_reason"),

  // ── IBK 대량이체 파일 연동(Phase 2) ──
  ibkFileGenerated: boolean("ibk_file_generated").notNull().default(false),
  ibkFileGeneratedAt: timestamp("ibk_file_generated_at"),
  ibkBatchRef: text("ibk_batch_ref"),

  // ── 실제 지급완료(Phase 2) ──
  paidAt: timestamp("paid_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  // 동일 회차에서 동일 지급대상 중복 송금 방지(§6) — idempotent 재집계의 근거.
  uqRoundPayee: uniqueIndex("uq_payout_transfers_round_payee").on(t.payoutRoundId, t.payeeKey),
  // 지급 실행 요약(지급완료/실패 N명) 조회용.
  idxRoundStatus: index("idx_payout_transfers_round_status").on(t.payoutRoundId, t.status),
  // 지급가능/정보누락 N명 조회용.
  idxRoundVerification: index("idx_payout_transfers_round_verification").on(t.payoutRoundId, t.verificationStatus),
}));

export type PayoutTransfer = typeof payoutTransfersTable.$inferSelect;
export type InsertPayoutTransfer = typeof payoutTransfersTable.$inferInsert;
