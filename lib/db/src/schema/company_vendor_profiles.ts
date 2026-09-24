import { pgTable, serial, integer, text, timestamp, varchar, boolean } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";

// ─────────────────────────────────────────────────────────────────────────────
// 외주업체 Profile(company_vendor_profiles) — 회사(company)에 연결되는 "외주업체 역할" 정보.
//  · [SSOT] 회사 identity 는 companies 가 단일 원천(§12). 동일 사업자번호 회사를 복제 생성하지 않고,
//    이 테이블은 해당 company 에 "외주업체로서의 부가정보"만 1:1 로 연결한다.
//  · [1:1] company 당 최대 1개(companyId UNIQUE). company 가 고객+외주 양쪽 역할을 가져도
//    companies 는 하나이며, 외주 역할 여부는 companies.isVendor, 외주 부가정보는 이 테이블이 담당한다.
//  · [지급계좌] 은행/계좌/예금주 지급정보는 이 테이블에 두지 않고 기존 company_sensitive(암호화)를
//    그대로 재사용한다. 개인 통번역사(translator_sensitive)와 세무·지급 정책을 섞지 않는다(§6).
//  · [additive] companies 컬럼을 건드리지 않는 별도 테이블. 기존 company 조회 API 에 영향 없음.
//  · [soft-delete] companies/quotes 와 동일한 삭제 패턴 재사용(물리 삭제 금지).
// ─────────────────────────────────────────────────────────────────────────────
export const companyVendorProfilesTable = pgTable("company_vendor_profiles", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .unique()
    .references(() => companiesTable.id, { onDelete: "cascade" }),

  // 외주분야: translation(번역) | interpretation(통역) | equipment(장비) | etc(기타)
  // 향후 확장 가능하도록 varchar 로 둔다(pgEnum 미사용) — §4 "과도한 구조 금지".
  outsourcingField: varchar("outsourcing_field", { length: 30 }),
  mainWork: text("main_work"), // 주요 업무(자유입력)

  // 세금계산서 발행 여부(§5 지급정보). 부가세/공급가액 등 건별 계산은 기존 수행정보
  // (performance_assignments 의 purchaseEvidenceType/supplyAmount/vatAmount)에서 처리하므로
  // 여기서는 업체 단위의 기본 발행 여부만 관리한다.
  issuesTaxInvoice: boolean("issues_tax_invoice").notNull().default(false),

  memo: text("memo"),

  // active | inactive — 기존 거래처 활성/비활성 규칙과 동일한 관점(§4).
  status: varchar("status", { length: 20 }).notNull().default("active"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),

  // ── Soft Delete (휴지통) ────────────────────────────────
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by"),
  deletionReason: text("deletion_reason"),
});

export type CompanyVendorProfile = typeof companyVendorProfilesTable.$inferSelect;
export type InsertCompanyVendorProfile = typeof companyVendorProfilesTable.$inferInsert;
