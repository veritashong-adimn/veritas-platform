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

// 수행자 구분: 개인 통번역사 / 외주업체 / 경비(지급대상 없는 직접 원가)
//  · individual : 개인 통번역사·개인사업자·내부인력 → 지급항목(수행료) 블록 적용
//  · vendor     : 외주업체·장비업체·DTP·미디어업체 → 매입(공급가+VAT) 블록 적용
//  · expense    : 교통비·숙박비·출장비 등 특정 지급대상자 없는 프로젝트 직접원가 → 직접금액
export const performancePerformerCategoryEnum = pgEnum("performance_performer_category", [
  "individual",
  "vendor",
  "expense",
]);

// 지급상태 (§12-2) — 수행정보 상태는 지급상태 하나로 통합 관리(정산상태 제거)
export const performancePaymentStatusEnum = pgEnum("performance_payment_status", [
  "unpaid",             // 미지급
  "payment_waiting",    // 지급대기
  "payment_scheduled",  // 지급예정
  "partial",            // 일부지급
  "paid",               // 지급완료
  "payment_hold",       // 지급보류
]);

// 지급명세서 상태 (§12-3)
export const performancePayStatementStatusEnum = pgEnum("performance_pay_statement_status", [
  "not_created",  // 미생성
  "created",      // 생성완료
  "sent",         // 발송완료
  "revised",      // 수정본 발행
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
  // 납품일 + 서비스 종료일 기준 자동값 + 담당 PM 확인(§납품확인)
  deliveryDateAuto: date("delivery_date_auto"),                            // 서비스 종료일 기준 자동 납품일
  deliveryDateManual: boolean("delivery_date_manual").notNull().default(false), // 사용자 수동 지정 여부
  deliveryConfirmed: boolean("delivery_confirmed").notNull().default(false),    // 담당 PM 납품확인 완료
  deliveryConfirmedBy: integer("delivery_confirmed_by").references(() => usersTable.id),
  deliveryConfirmedAt: timestamp("delivery_confirmed_at"),
  expectedPaymentDate: date("expected_payment_date"),
  actualPaymentDate: date("actual_payment_date"),

  // ── 세부 구분 라벨 (§5-3 화면 구분값) ───────────────────────────────────────
  //  개인 통번역사/개인사업자/외주업체/장비업체/DTP업체/미디어업체/내부인력/경비/기타
  //  performerCategory(individual|vendor|expense)는 계산 블록을, lineCategory는 표시·필터를 담당.
  lineCategory: text("line_category"),

  // ── 계약단가·수량·원가합계 (전 구분 공통, §7·§9·§10) ────────────────────────
  //  기본수행료 = isDirectAmount ? baseFee(직접입력) : contractUnitPrice × quantity
  //  원가합계  = 기본수행료 + Σ지급대상 추가비용(expenseTotal) − Σ차감액(deductionTotal)
  //  ※ 기존 grossPayment/withholding(정산 예정값)과 별개 — 손익·정산관리의 원천 원가값.
  contractUnitPrice: numeric("contract_unit_price", { precision: 14, scale: 2 }),
  quantity: numeric("quantity", { precision: 12, scale: 2 }),
  unit: text("unit"),
  isDirectAmount: boolean("is_direct_amount").notNull().default(false),
  basePerformanceFee: numeric("base_performance_fee", { precision: 14, scale: 2 }).notNull().default("0"),
  expenseTotal: numeric("expense_total", { precision: 14, scale: 2 }).notNull().default("0"),
  deductionTotal: numeric("deduction_total", { precision: 14, scale: 2 }).notNull().default("0"),
  costTotal: numeric("cost_total", { precision: 14, scale: 2 }).notNull().default("0"),

  // ── 지급·명세서 상태 (§12) — status(수행상태)와 별개로 분리 관리. 상태는 지급상태로 단일화 ─────
  paymentStatus: performancePaymentStatusEnum("payment_status").notNull().default("unpaid"),
  payStatementStatus: performancePayStatementStatusEnum("pay_statement_status").notNull().default("not_created"),

  // ── 지급예정일 자동계산 + 수동변경 이력 (§8-2) ──────────────────────────────
  expectedPaymentDateAuto: date("expected_payment_date_auto"),  // 최초 자동 계산값(공휴일 조정 포함)
  payDateManual: boolean("pay_date_manual").notNull().default(false), // true=사용자가 지급일 직접 지정
  payDateChangeReason: text("pay_date_change_reason"),
  payDateChangedBy: integer("pay_date_changed_by").references(() => usersTable.id),
  payDateChangedAt: timestamp("pay_date_changed_at"),

  // ── 정산관리·지급명세서 연계 (§18) — 소프트링크(FK 없음, 향후 테이블 생성 시 연결) ─
  payeeType: text("payee_type"),                 // "individual" | "vendor" | "none"(경비)
  payoutRoundId: integer("payout_round_id"),      // 지급회차 ID (향후)
  payStatementId: integer("pay_statement_id"),    // 지급명세서 ID (향후)
  actualPaymentAmount: numeric("actual_payment_amount", { precision: 14, scale: 2 }),

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

// ─────────────────────────────────────────────────────────────────────────────
// 원가 합계 계산 (§9·§10) — 손익·정산관리의 원천 원가값.
//   기본수행료 = isDirectAmount ? baseAmount(직접입력) : contractUnitPrice × quantity
//   원가합계   = 기본수행료 + Σ지급대상 추가비용 − Σ차감액
// expenseItems / deductionItems 는 하위 다건(performance_expenses / performance_deductions).
//   · 지급대상 추가비용만 합산(includedInPayout=true) — 참고용 비용은 원가 제외.
//   · 계산식 대신 직접금액을 쓰는 항목(경비 등)은 isDirectAmount=true 로 baseAmount 사용.
// ─────────────────────────────────────────────────────────────────────────────
export function calcBasePerformanceFee(
  isDirectAmount: boolean,
  directAmount: number | null | undefined,
  contractUnitPrice: number | null | undefined,
  quantity: number | null | undefined,
): number {
  if (isDirectAmount) return round2(directAmount ?? 0);
  return round2((Number(contractUnitPrice) || 0) * (Number(quantity) || 0));
}

/**
 * 지급예정일 자동계산 (§8-2) — 납품완료일 기준(KST, 날짜문자열 연산).
 *  · 완료일 1~15일  → 해당 월 말일
 *  · 완료일 16~말일 → 익월 15일
 * 기존 정산 자동생성(tasks.ts calcPayoutDueDate)과 동일 규칙을 공용화(§37).
 * 반환: "YYYY-MM-DD" 또는 null(입력 없음/형식오류).
 */
export function calcExpectedPaymentDate(deliveryDate: string | null | undefined): string | null {
  if (!deliveryDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(deliveryDate);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]); // month: 1-based
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (day <= 15) {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // 해당 월 말일
    return `${year}-${p2(month)}-${p2(lastDay)}`;
  }
  let ny = year, nm = month + 1;
  if (nm > 12) { nm = 1; ny += 1; }
  return `${ny}-${p2(nm)}-15`; // 익월 15일
}

// ─────────────────────────────────────────────────────────────────────────────
// 영업일(주말·공휴일) 조정 유틸 — 지급일 자동계산의 "직전 영업일" 처리(§3·§4·§5).
//  · 날짜는 "YYYY-MM-DD" 문자열로만 다룬다(시간값 없음). 요일 계산은 UTC 기준 순수연산이라
//    타임존 변환으로 날짜가 전일/익일로 밀리지 않는다(§15 KST 안전).
//  · 공휴일 판별은 주입식 predicate(isHoliday) — 특정 연도 배열을 코드에 고정하지 않는다(§6).
// ─────────────────────────────────────────────────────────────────────────────
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

// 0=일 ~ 6=토 (UTC 순수연산). 형식오류 시 -1.
export function dayOfWeekKST(dateStr: string): number {
  const m = DATE_RE.exec(dateStr);
  if (!m) return -1;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

// "YYYY-MM-DD" 에 delta 일을 더한 문자열 반환.
export function addDaysStr(dateStr: string, delta: number): string {
  const m = DATE_RE.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export function isWeekend(dateStr: string): boolean {
  const w = dayOfWeekKST(dateStr);
  return w === 0 || w === 6; // 일·토
}

// 주어진 날짜 이전(포함)의 가장 가까운 영업일. 주말·공휴일이면 영업일이 나올 때까지 하루씩 이전으로.
//   연속 연휴(공휴일+주말)도 계속 거슬러 올라간다. guard 로 무한루프 방지.
export function previousBusinessDay(
  dateStr: string | null | undefined,
  isHoliday: (d: string) => boolean = () => false,
): string | null {
  if (!dateStr) return null;
  let d = String(dateStr).slice(0, 10);
  let guard = 0;
  while ((isWeekend(d) || isHoliday(d)) && guard < 60) {
    d = addDaysStr(d, -1);
    guard += 1;
  }
  return d;
}

// 납품일 → 최종 지급일(기준일 = calcExpectedPaymentDate, 그 후 직전 영업일 조정).
//   프론트 미리보기·서버 검증이 공유하는 단일 규칙(§7).
export function calcPaymentDate(
  deliveryDate: string | null | undefined,
  isHoliday: (d: string) => boolean = () => false,
): string | null {
  const base = calcExpectedPaymentDate(deliveryDate);
  if (!base) return null;
  return previousBusinessDay(base, isHoliday);
}

export function calcCostTotal(
  basePerformanceFee: number,
  expenseItems: Array<{ amount?: number | null; includedInPayout?: boolean | null }>,
  deductionItems: Array<{ amount?: number | null }>,
): { basePerformanceFee: number; expenseTotal: number; deductionTotal: number; costTotal: number } {
  const base = round2(basePerformanceFee);
  const expenseTotal = round2(
    (expenseItems ?? [])
      .filter((e) => e.includedInPayout !== false) // 기본 지급대상 포함
      .reduce((s, e) => s + (Number(e.amount) || 0), 0),
  );
  const deductionTotal = round2(
    (deductionItems ?? []).reduce((s, d) => s + (Number(d.amount) || 0), 0),
  );
  const costTotal = round2(base + expenseTotal - deductionTotal);
  return { basePerformanceFee: base, expenseTotal, deductionTotal, costTotal };
}
