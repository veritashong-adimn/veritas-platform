import {
  pgTable, serial, integer, numeric, timestamp, text, boolean,
  pgEnum, date, jsonb,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { quotesTable } from "./quotes";
import { usersTable } from "./users";
import { companiesTable } from "./companies";

// ─────────────────────────────────────────────────────────────────────────────
// 수행정보 (Performance Assignment)
//
// 판매 확정 이후 실제 업무를 수행하는 대상(개인 통번역사 / 외주업체)을 판매상품행에
// 1:N 으로 연결하고, 개인 원천세·외주 매입 정산 정보를 관리하는 원가(cost) 도메인.
//
// 설계 원칙(0단계 설계보고서 기준):
//  · 판매(매출) 금액과 완전 분리 — 이 테이블 저장이 quote/견적서/거래명세서 금액에 영향 없음.
//  · quote_items.id 는 판매정보 저장 시마다 재생성되므로 saleItemId 는 FK 제약 없이
//    "참고값"으로만 저장(soft-link). 안정 루트는 projectId. 스냅샷+sequence 로 유지·재연결.
//  · 기존 tasks/settlements 는 비파괴 — 본 테이블은 신규 병행 구조.
// ─────────────────────────────────────────────────────────────────────────────

// 수행자 구분: 개인 통번역사 / 외주업체
export const performancePerformerCategoryEnum = pgEnum("performance_performer_category", [
  "individual",
  "vendor",
]);

// 수행 상태 (미배정→배정완료→수행중→수행완료→지급대기→지급완료 / 취소)
export const performanceStatusEnum = pgEnum("performance_assignment_status", [
  "unassigned",
  "assigned",
  "in_progress",
  "completed",
  "payout_pending",
  "paid",
  "cancelled",
]);

// 거주구분 (국내 거주자 / 해외 거주자·비거주자)
export const performanceResidencyTypeEnum = pgEnum("performance_residency_type", [
  "domestic_resident",
  "overseas_or_nonresident",
]);

// 원천징수 처리구분
export const performanceWithholdingTreatmentEnum = pgEnum("performance_withholding_treatment", [
  "domestic_3_3",                   // 국내 거주자 3.3%
  "exempt",                         // 원천징수 제외
  "nonresident_custom",             // 비거주자 별도 원천징수 (세율 수동)
  "treaty_reduction_or_exemption",  // 조세조약 감면·면제 (세율 수동, 0% 허용)
  "tax_review_required",            // 세무 확인 필요 (세율 미확정)
]);

// 생성 출처 (장기 확장 — 원가/감사 추적용)
export const performanceSourceEnum = pgEnum("performance_source", [
  "sale_import",   // 판매정보 불러오기
  "manual",        // 수동 추가
  "ai_generated",  // AI 생성 (향후)
]);

// 비용 유형 (장기 확장 — 프로젝트 손익/원가분석용). performerCategory(individual|vendor)보다 넓은 분류.
export const performanceCostTypeEnum = pgEnum("performance_cost_type", [
  "individual",  // 개인 통번역사 (인건비성)
  "vendor",      // 외주업체 매입
  "internal",    // 내부비용
  "other",       // 기타
]);

// 외주업체 매입증빙 유형
export const performancePurchaseEvidenceEnum = pgEnum("performance_purchase_evidence", [
  "tax_invoice",            // 세금계산서 (VAT 10%)
  "invoice",                // 계산서 (VAT 0)
  "zero_rate_tax_invoice",  // 영세율 세금계산서 (VAT 0)
  "other",                  // 기타 증빙
  "none",                   // 미발행
]);

export const performanceAssignmentsTable = pgTable("performance_assignments", {
  id: serial("id").primaryKey(),

  // ── 연결 정보 (안정 루트 = projectId, saleItemId 는 soft-link 참고값) ─────────
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id),
  quoteId: integer("quote_id")
    .references(() => quotesTable.id),
  saleItemId: integer("sale_item_id"),          // FK 제약 없음 — 재저장 시 stale 가능
  saleItemSequence: integer("sale_item_sequence"),
  sequence: integer("sequence").notNull().default(0),

  // 생성 출처 / 비용 유형 (장기 확장 — 원가분석·손익·감사)
  sourceType: performanceSourceEnum("source_type").notNull().default("manual"),
  costType: performanceCostTypeEnum("cost_type"),

  // ── 수행자 구분 / 식별 ─────────────────────────────────────────────────────
  performerCategory: performancePerformerCategoryEnum("performer_category")
    .notNull().default("individual"),
  individualUserId: integer("individual_user_id").references(() => usersTable.id),
  vendorCompanyId: integer("vendor_company_id").references(() => companiesTable.id),

  // ── 수행업무 스냅샷 (판매행에서 복사, 금액 미포함) ──────────────────────────
  serviceType: text("service_type"),                        // canonical 서비스유형
  productNameSnapshot: text("product_name_snapshot"),
  serviceDetailSnapshot: jsonb("service_detail_snapshot"),  // 유형별 상세(파일/기간/장소 등)
  languageOrServiceSnapshot: text("language_or_service_snapshot"),
  performanceStartDate: date("performance_start_date"),
  performanceEndDate: date("performance_end_date"),
  deliveryDate: date("delivery_date"),

  // ── 수행자 스냅샷 (선택 시점 동결 · 민감식별자는 암호화) ─────────────────────
  performerNameSnapshot: text("performer_name_snapshot"),
  identifierSnapshotEnc: text("identifier_snapshot_enc"),       // encrypt() 암호문
  identifierSnapshotMasked: text("identifier_snapshot_masked"), // 표시용 마스킹값
  nationalitySnapshot: text("nationality_snapshot"),
  residenceCountrySnapshot: text("residence_country_snapshot"),
  vendorTypeSnapshot: text("vendor_type_snapshot"),

  // ── 상태 및 지급일 ─────────────────────────────────────────────────────────
  status: performanceStatusEnum("status").notNull().default("unassigned"),
  expectedPaymentDate: date("expected_payment_date"),
  actualPaymentDate: date("actual_payment_date"),

  // ── 개인 통번역사 정산 (vendor 인 경우 null) ────────────────────────────────
  residencyType: performanceResidencyTypeEnum("residency_type"),
  serviceCountry: text("service_country"),           // 용역 수행국가
  serviceLocationType: text("service_location_type"), // "domestic" | "overseas" (국내/국외 수행)
  baseFee: numeric("base_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  transportationFee: numeric("transportation_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  businessTripFee: numeric("business_trip_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  copyrightFee: numeric("copyright_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  travelDayCompensation: numeric("travel_day_compensation", { precision: 14, scale: 2 }).notNull().default("0"),
  cancellationCompensation: numeric("cancellation_compensation", { precision: 14, scale: 2 }).notNull().default("0"),
  grossPayment: numeric("gross_payment", { precision: 14, scale: 2 }).notNull().default("0"),
  withholdingTreatment: performanceWithholdingTreatmentEnum("withholding_treatment"),
  withholdingRate: numeric("withholding_rate", { precision: 7, scale: 4 }),
  withholdingTax: numeric("withholding_tax", { precision: 14, scale: 2 }).notNull().default("0"),
  netPayment: numeric("net_payment", { precision: 14, scale: 2 }).notNull().default("0"),
  taxReviewReason: text("tax_review_reason"),
  nonResidentConfirmedAt: timestamp("non_resident_confirmed_at"),
  taxTreatyApplicable: boolean("tax_treaty_applicable").notNull().default(false),
  overseasEvidenceExists: boolean("overseas_evidence_exists").notNull().default(false),

  // ── 외주업체 매입 (individual 인 경우 null) ─────────────────────────────────
  purchaseEvidenceType: performancePurchaseEvidenceEnum("purchase_evidence_type"),
  purchaseInvoiceDate: date("purchase_invoice_date"),
  supplyAmount: numeric("supply_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  totalPurchaseAmount: numeric("total_purchase_amount", { precision: 14, scale: 2 }).notNull().default("0"),

  // ── 공통 ───────────────────────────────────────────────────────────────────
  memo: text("memo"),
  createdBy: integer("created_by").references(() => usersTable.id),
  updatedBy: integer("updated_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),

  // ── Soft Delete (휴지통 / 회계자료 보호) ────────────────────────────────────
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),
  deletionReason: text("deletion_reason"),
});

export type PerformanceAssignment = typeof performanceAssignmentsTable.$inferSelect;
export type InsertPerformanceAssignment = typeof performanceAssignmentsTable.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// 계산 유틸 (순수함수) — 서버 재검증 + 프론트 미리보기가 동일 규칙을 쓰도록 공용화(§37).
// 반올림은 기존 정산(tasks.ts calcTax)과 동일한 2소수 반올림 정책을 따른다(§23).
//   ※ 재무팀이 원단위(정수) 반올림을 원하면 round2 만 교체하면 된다 — 보고서에 명시.
// ─────────────────────────────────────────────────────────────────────────────
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export type WithholdingTreatment =
  | "domestic_3_3" | "exempt" | "nonresident_custom"
  | "treaty_reduction_or_exemption" | "tax_review_required";

export interface IndividualFeeInput {
  baseFee?: number;
  transportationFee?: number;
  businessTripFee?: number;
  copyrightFee?: number;
  travelDayCompensation?: number;
  cancellationCompensation?: number;
}

/**
 * 개인 통번역사 지급액 계산.
 *  · gross(세전) = Σ 지급항목
 *  · 원천징수 대상금액 = 기본 세전 전체(taxableBaseOverride 로 항목별 과세분리 확장 가능)
 *  · treatment 별 세율: domestic_3_3=3.3, exempt=0, nonresident/treaty=수동, tax_review_required=미확정
 *  · tax_review_required 는 세율 미확정 → 원천세를 임시 0 으로 두되 rateConfirmed=false (확정값 아님)
 */
export function calcIndividualPayout(
  fees: IndividualFeeInput,
  treatment: WithholdingTreatment | null | undefined,
  manualRate?: number | null,
  taxableBaseOverride?: number | null,
): { gross: number; rate: number; withholdingTax: number; net: number; rateConfirmed: boolean } {
  const gross = round2(
    (fees.baseFee ?? 0) + (fees.transportationFee ?? 0) + (fees.businessTripFee ?? 0) +
    (fees.copyrightFee ?? 0) + (fees.travelDayCompensation ?? 0) + (fees.cancellationCompensation ?? 0),
  );
  const taxable = taxableBaseOverride != null ? taxableBaseOverride : gross;
  let rate = 0;
  let rateConfirmed = true;
  switch (treatment) {
    case "domestic_3_3": rate = 3.3; break;
    case "exempt": rate = 0; break;
    case "nonresident_custom":
    case "treaty_reduction_or_exemption": rate = Number(manualRate) || 0; break;
    case "tax_review_required":
    default: rate = 0; rateConfirmed = false; break; // 세율 미확정
  }
  const withholdingTax = rateConfirmed ? round2(taxable * (rate / 100)) : 0;
  const net = round2(gross - withholdingTax);
  return { gross, rate, withholdingTax, net, rateConfirmed };
}

export type PurchaseEvidenceType =
  | "tax_invoice" | "invoice" | "zero_rate_tax_invoice" | "other" | "none";

/**
 * 외주업체 매입 계산.
 *  · tax_invoice(세금계산서): vat = supply × 10%, total = supply + vat
 *  · invoice(계산서) / zero_rate_tax_invoice(영세율): vat = 0, total = supply
 *  · other(기타) / none(미발행): vat = 수동(기본 0), total = supply + vat
 */
export function calcVendorPurchase(
  supplyAmount: number,
  evidenceType: PurchaseEvidenceType | null | undefined,
  manualVat?: number | null,
): { supply: number; vat: number; total: number } {
  const supply = round2(supplyAmount);
  let vat = 0;
  switch (evidenceType) {
    case "tax_invoice": vat = round2(supply * 0.1); break;
    case "invoice":
    case "zero_rate_tax_invoice": vat = 0; break;
    case "other":
    case "none":
    default: vat = round2(manualVat ?? 0); break;
  }
  return { supply, vat, total: round2(supply + vat) };
}
