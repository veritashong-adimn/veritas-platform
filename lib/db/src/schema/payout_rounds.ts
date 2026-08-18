import { pgTable, serial, integer, numeric, text, date, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ─────────────────────────────────────────────────────────────────────────────
// 지급회차(payout_rounds) — 정산 1단계.
//  · 매월 15일·말일 지급정책에 따라 수행정보(performance_assignments)의 미지급 건을
//    지급대상(개인 통번역사 / 외주업체)별로 묶어 집계하는 "상위 회차".
//  · 세금·순지급액은 행별 costTotal + 세금처리(withholdingTreatment)로 회차 API에서 산출·합산.
//    기존 수행정보 계산·저장에는 영향 없음(상위 집계 레이어).
//  · performance_assignments.payoutRoundId(기존 예약 소프트링크)로 연결. FK는 두지 않음(기존 방침 유지).
//  · Phase 1은 draft→confirmed(지급확정)까지. 실제 지급완료(paid)·이체파일·명세서는 Phase 2.
// ─────────────────────────────────────────────────────────────────────────────

// 지급회차 상태 (§3)
export const payoutRoundStatusEnum = pgEnum("payout_round_status", [
  "draft",       // 작성 중
  "reviewing",   // 검토 중
  "confirmed",   // 지급 확정
  "paid",        // 지급 완료 (Phase 2)
  "cancelled",   // 취소
]);

export const payoutRoundsTable = pgTable("payout_rounds", {
  id: serial("id").primaryKey(),
  batchNumber: text("batch_number"),                 // 표시용 회차번호 (예: "2026-08-15 지급회차")
  paymentDate: date("payment_date").notNull(),       // 지급예정일
  periodStart: date("period_start"),                 // 대상기간 시작일
  periodEnd: date("period_end"),                     // 대상기간 종료일
  status: payoutRoundStatusEnum("status").notNull().default("draft"),
  // 수집기준(§7): expected_payment_date(기본) | delivery_date(레거시 보조)
  collectionBasis: text("collection_basis").notNull().default("expected_payment_date"),
  // 집계 스냅샷(§14) — 저장 시 갱신, 목록 표시용. 상세는 API에서 실시간 재계산.
  totalAssignments: integer("total_assignments").notNull().default(0),   // 대상 건수
  totalPayees: integer("total_payees").notNull().default(0),             // 지급대상 수
  grossAmount: numeric("gross_amount", { precision: 16, scale: 2 }).notNull().default("0"),        // 총 세전 지급액
  deductionAmount: numeric("deduction_amount", { precision: 16, scale: 2 }).notNull().default("0"), // 총 원천징수(공제)액
  netAmount: numeric("net_amount", { precision: 16, scale: 2 }).notNull().default("0"),            // 총 실지급액
  note: text("note"),
  createdBy: integer("created_by").references(() => usersTable.id),
  completedBy: integer("completed_by").references(() => usersTable.id),   // 지급확정자
  completedAt: timestamp("completed_at"),                                 // 지급확정 시각
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PayoutRound = typeof payoutRoundsTable.$inferSelect;
export type InsertPayoutRound = typeof payoutRoundsTable.$inferInsert;

// ── 지급회차 원천징수/실지급 계산 (§11) ──────────────────────────────────────
//  · 세전 지급액(gross) = costTotal(기본수행료 + 추가비용 − 차감) — 수행정보 원가와 동일.
//    ※ 외주업체는 이 gross 가 곧 "최종 공급가액"이다(추가비용·차감 반영 후 금액).
//  · 개인 통번역사: 공제(원천징수) = 세전 × 세율. 세율은 기존 세금처리(withholdingTreatment) 규칙 그대로 재사용.
//     domestic_3_3=3.3% · domestic_2_2=2.2% · exempt=0 · nonresident_custom/treaty=수동세율 · tax_review_required=미확정(공제 0·경고).
//     실지급 = 세전 − 공제. (VAT 없음 — 개인 계산 로직 불변)
//  · 외주업체(vendor): 원천징수 없음. 증빙유형이 세금계산서(tax_invoice)인 경우에만
//     VAT(공급가액 × 10%)를 실지급액에 포함한다. 그 외(계산서·영세율·기타·미발행/미선택)는 VAT 미적용.
//     - tax_invoice           → vat = gross × 10%, 실지급 = gross + vat, isVatIncluded = true
//     - 그 외 전부(none 포함)  → vat = 0,           실지급 = gross,       isVatIncluded = false
//     ※ none(미발행·미선택)은 증빙 미확정 상태이므로 VAT를 자동 적용하지 않는다.
//  · 원 단위 처리(round2)는 서버 계산과 동일.
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
export type PayoutTaxResult = {
  gross: number; rate: number; deduction: number; vat: number; net: number;
  isVatIncluded: boolean; rateConfirmed: boolean;
};
// 외주 VAT 적용 판정 — 세금계산서(tax_invoice)인 경우에만 VAT 포함(§9). 화면은 이 판정을 다시 하지 말고
//  calcPayoutWithholding().isVatIncluded 를 사용해 (VAT별도) 표시 여부를 결정한다.
export function vendorVatApplies(
  payeeType: string | null | undefined,
  purchaseEvidenceType: string | null | undefined,
): boolean {
  return payeeType === "vendor" && purchaseEvidenceType === "tax_invoice";
}
export function calcPayoutWithholding(
  costTotal: number,
  payeeType: string | null | undefined,          // "individual" | "vendor" | "none"
  withholdingTreatment: string | null | undefined,
  withholdingRate?: number | null,
  purchaseEvidenceType?: string | null,          // 외주 VAT 판정용(세금계산서 여부)
): PayoutTaxResult {
  const gross = round2(costTotal);
  // 외주업체·경비: 원천징수 미적용(공제 0). 세금계산서(tax_invoice)만 VAT 포함.
  if (payeeType !== "individual") {
    const isVatIncluded = vendorVatApplies(payeeType, purchaseEvidenceType);
    const vat = isVatIncluded ? round2(gross * 0.1) : 0;
    return { gross, rate: 0, deduction: 0, vat, net: round2(gross + vat), isVatIncluded, rateConfirmed: true };
  }
  let rate = 0;
  let rateConfirmed = true;
  switch (withholdingTreatment) {
    case "domestic_3_3": rate = 3.3; break;
    case "domestic_2_2": rate = 2.2; break;
    case "exempt": rate = 0; break;
    case "nonresident_custom":
    case "treaty_reduction_or_exemption": rate = Number(withholdingRate) || 0; break;
    case "tax_review_required":
    default: rate = 0; rateConfirmed = false; break;   // 세율 미확정(세무확인 필요)
  }
  const deduction = rateConfirmed ? round2(gross * (rate / 100)) : 0;
  const net = round2(gross - deduction);
  return { gross, rate, deduction, vat: 0, net, isVatIncluded: false, rateConfirmed };
}
