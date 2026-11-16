import { pgTable, serial, integer, numeric, timestamp, date, pgEnum, text, boolean, varchar } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { usersTable } from "./users";
import { companiesTable } from "./companies";
import { contactsTable } from "./contacts";

// 고객 결제(수금) 기록 — 프로젝트별 "언제·어떤 방식으로·얼마를 받았는지". 통번역사 지급(settlements)과는 별개.
//  · 기존 payments 테이블은 변경하지 않고 신규 테이블로 분리(수금 상세/채권관리 확장 대비).
//  · 미수금은 저장하지 않고 화면에서 계산(총 판매금액 − 총 입금액).

// 결제구분: 선금 · 중도금 · 잔금 · 일괄결제 · 기타
export const projectPaymentTypeEnum = pgEnum("project_payment_type", [
  "advance", "interim", "balance", "lump_sum", "other",
]);
// 결제방법: text(자유 입력·확장 대비). 기본 4개(세금계산서·카드·외화송금·현금) + '기타' 직접입력.
//  · enum이 아닌 text — 향후 결제방법이 계속 추가/커스텀될 수 있어 UI 라벨/사용자 문자열을 그대로 저장.
// 입금상태: 입금예정 · 부분입금 · 입금완료 · 미수
export const projectPaymentDepositStatusEnum = pgEnum("project_payment_deposit_status", [
  "scheduled", "partial", "completed", "unpaid",
]);

export const projectPaymentsTable = pgTable("project_payments", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id),
  sequence: integer("sequence").notNull().default(1), // 회차 — 프로젝트별 자동번호
  issueDate: date("issue_date"),                       // 발행일 — 세금계산서 발행일(결제방법=세금계산서일 때만 사용)
  expectedDate: date("expected_date"),                 // 입금예정일 — 모든 결제방법 공통(채권관리)
  paidDate: date("paid_date"),                         // 입금일 — 실제 입금된 날짜(입력 시 입금상태 자동 입금완료)
  paymentType: projectPaymentTypeEnum("payment_type"), // 결제구분
  paymentMethod: text("payment_method"),               // 결제방법(자유 입력)
  supplyAmount: numeric("supply_amount", { precision: 14, scale: 2 }).notNull().default("0"), // 공급가액
  vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),        // 부가세
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),               // 결제금액
  depositStatus: projectPaymentDepositStatusEnum("deposit_status").notNull().default("scheduled"), // 입금상태
  // 입금확인 — 실제 입금 확인 체크(수행정보 납품확인과 동일 개념). 체크 시 입금일=입금예정일·상태 입금완료로 자동 반영.
  //  · 미확인(false)이면 입금예정일을 붉은색으로 표시(입금 미확인). 확인(true) 시 검정색.
  depositConfirmed: boolean("deposit_confirmed").notNull().default(false),
  // 복수 지급주체 사업(수출바우처·혁신바우처·정부지원 등) 대응 — 모두 text(자유 확장).
  paymentCategory: text("payment_category").notNull().default("일반결제"), // 결제유형: 일반결제 · 수출바우처
  payer: text("payer"),                                // 입금주체: 고객사 · 수출바우처 운영기관
  depositItem: text("deposit_item"),                   // 입금항목: 공급가액 · 부가세 · 전체금액
  // 청구정보(Phase 1) — 청구 = 입금 관리 단위. 청구업체·담당자.
  billingCompanyId: integer("billing_company_id").references(() => companiesTable.id), // 청구업체
  billingContactId: integer("billing_contact_id").references(() => contactsTable.id),  // 담당자
  // 청구 당시 표시명 Snapshot — Master 개명·통합에도 수금 과거기록은 당시 청구처/담당자명 유지. 조회는 COALESCE fallback.
  billingCompanyNameSnapshot: text("billing_company_name_snapshot"),
  billingContactNameSnapshot: text("billing_contact_name_snapshot"),
  note: text("note"),                                  // 비고
  // 외화 청구(2026-11 추가, 모두 NULL 허용) — NULL·'KRW' = 원화 청구(기존 동작 그대로). amount/supply/vat 는 계속 원화 기준.
  //  · foreign_amount = 외화 청구금액(인보이스, billing_currency 단위) · invoice_fx_rate = 인보이스 적용환율(외화 1단위당 원화)
  //  · 외화 청구회차의 미수금·입금상태는 외화 금액 기준(services/fxBilling). 판매금액·원화 청구금액은 환율로 바꾸지 않는다.
  billingCurrency: varchar("billing_currency", { length: 3 }),
  foreignAmount: numeric("foreign_amount", { precision: 14, scale: 2 }),
  invoiceFxRate: numeric("invoice_fx_rate", { precision: 18, scale: 6 }),
  invoiceFxDate: date("invoice_fx_date"),
  createdBy: integer("created_by").references(() => usersTable.id),
  updatedBy: integer("updated_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProjectPayment = typeof projectPaymentsTable.$inferSelect;
