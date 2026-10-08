// ─── 거래처(companies) Hard Delete(물리삭제) Dependency Guard ───────────────────
// 목적: 거래처에 과거 거래/수행/정산/수금 등 "거래성·과거자료"가 하나라도 연결되어 있으면
//       물리삭제(및 어떠한 cascade)도 실행되지 않도록 사전 검사한다.
//  · 동일 companies Master 는 고객(customer)+외주(vendor) 역할을 동시에 가질 수 있으므로
//    고객측(quotes/projects/수금/청구/선불)뿐 아니라 외주측(performance_assignments.vendorCompanyId,
//    payout payeeType='vendor')까지 함께 검사한다(§4).
//  · Snapshot(거래 당시값)은 표시 보존용일 뿐, 원본 거래 레코드 삭제 허용 근거가 아니다(§5).
//  · 회사 "하위 보조데이터"(contacts/divisions/vendor_profile/sensitive/aliases/name_history 등)는
//    그 자체로는 차단 사유가 아니다. 단, 보조데이터(담당자)가 다른 거래에서 참조되면 그 거래가 잡혀 차단된다.
import { eq, or, inArray, sql } from "drizzle-orm";
import {
  db,
  projectsTable, quotesTable, projectPaymentsTable, billingBatchesTable,
  settlementsTable, paymentsTable, prepaidAccountsTable, contactsTable,
  performanceAssignmentsTable, payoutRoundItemsTable, payoutTransfersTable,
  translatorProfilesTable,
} from "@workspace/db";

type Dbx = any; // db 또는 tx (프로젝트 services 의 `type Db = any` 관례와 동일)

export interface CompanyDependencyResult {
  blocked: boolean;        // true 면 과거 거래성 자료가 1건 이상 연결 → Hard Delete 금지
  categories: string[];    // 연결이 확인된 자료 유형(내부 로깅/감사용 — 사용자 메시지엔 노출하지 않음)
}

async function hasRow(dbx: Dbx, query: any): Promise<boolean> {
  const rows = await query.limit(1);
  return rows.length > 0;
}

/**
 * 거래처가 과거 거래/수행/정산/수금 자료와 연결되어 있는지 검사한다.
 * 어떤 데이터도 수정/삭제하지 않는 순수 조회(READ-ONLY).
 */
export async function evaluateCompanyHardDeleteDependencies(dbx: Dbx, companyId: number): Promise<CompanyDependencyResult> {
  const categories: string[] = [];

  // 1) 프로젝트 — 고객/요청/청구/지급 어느 역할로든 참조되면 과거 거래로 간주.
  //    프로젝트가 1건이라도 있으면 그에 딸린 견적·수금·정산·수행·tasks 가 함께 보존되어야 하므로 차단.
  const projectRows = await dbx.select({ id: projectsTable.id }).from(projectsTable).where(or(
    eq(projectsTable.companyId, companyId),
    eq(projectsTable.requestingCompanyId, companyId),
    eq(projectsTable.billingCompanyId, companyId),
    eq(projectsTable.payerCompanyId, companyId),
  ));
  const projectIds: number[] = projectRows.map((p: any) => p.id);
  if (projectIds.length > 0) {
    categories.push("project");
    // 프로젝트에 딸린 정산/수금(레거시)도 명시적으로 확인(이미 project 로 차단되지만 투명한 로깅).
    if (await hasRow(dbx, dbx.select({ id: settlementsTable.id }).from(settlementsTable).where(inArray(settlementsTable.projectId, projectIds)))) categories.push("settlement");
    if (await hasRow(dbx, dbx.select({ id: paymentsTable.id }).from(paymentsTable).where(inArray(paymentsTable.projectId, projectIds)))) categories.push("payment");
  }

  // 2) 견적(파생견적 발행대상) — quotes.derivedCompanyId
  if (await hasRow(dbx, dbx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.derivedCompanyId, companyId)))) categories.push("quote");

  // 3) 수금(청구행) — project_payments.billingCompanyId
  if (await hasRow(dbx, dbx.select({ id: projectPaymentsTable.id }).from(projectPaymentsTable).where(eq(projectPaymentsTable.billingCompanyId, companyId)))) categories.push("project_payment");

  // 4) 누적청구 배치 — billing_batches.companyId
  if (await hasRow(dbx, dbx.select({ id: billingBatchesTable.id }).from(billingBatchesTable).where(eq(billingBatchesTable.companyId, companyId)))) categories.push("billing_batch");

  // 5) 외주 수행(원가) — performance_assignments.vendorCompanyId (§4 vendor 역할)
  if (await hasRow(dbx, dbx.select({ id: performanceAssignmentsTable.id }).from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.vendorCompanyId, companyId)))) categories.push("vendor_performance");

  // 6) 지급(지급회차·송금) — payeeType='vendor' AND payeeId=companyId (FK 없는 soft-link)
  if (await hasRow(dbx, dbx.select({ id: payoutRoundItemsTable.id }).from(payoutRoundItemsTable).where(sql`${payoutRoundItemsTable.payeeType} = 'vendor' AND ${payoutRoundItemsTable.payeeId} = ${companyId}`))) categories.push("payout_round_item");
  if (await hasRow(dbx, dbx.select({ id: payoutTransfersTable.id }).from(payoutTransfersTable).where(sql`${payoutTransfersTable.payeeType} = 'vendor' AND ${payoutTransfersTable.payeeId} = ${companyId}`))) categories.push("payout_transfer");

  // 7) 선불/예치 — prepaid_accounts.companyId (연쇄로 prepaid_ledger 재무원장 보유)
  if (await hasRow(dbx, dbx.select({ id: prepaidAccountsTable.id }).from(prepaidAccountsTable).where(eq(prepaidAccountsTable.companyId, companyId)))) categories.push("prepaid_account");

  // 8) 소속 통번역사 — translator_profiles.affiliatedCompanyId (다른 Master 와의 관계 보존)
  if (await hasRow(dbx, dbx.select({ id: translatorProfilesTable.id }).from(translatorProfilesTable).where(eq(translatorProfilesTable.affiliatedCompanyId, companyId)))) categories.push("affiliated_translator");

  // 9) 담당자(contact) 교차참조 — 이 회사 소속 담당자가 다른 거래(견적/수금/프로젝트)에서 참조되는 경우.
  //    (해당 거래가 다른 회사에 걸려 있어 1~3에서 안 잡힐 수 있는 edge 를 보완)
  const contactRows = await dbx.select({ id: contactsTable.id }).from(contactsTable).where(eq(contactsTable.companyId, companyId));
  const contactIds: number[] = contactRows.map((c: any) => c.id);
  if (contactIds.length > 0) {
    const refByQuote = await hasRow(dbx, dbx.select({ id: quotesTable.id }).from(quotesTable).where(inArray(quotesTable.derivedContactId, contactIds)));
    const refByPay = await hasRow(dbx, dbx.select({ id: projectPaymentsTable.id }).from(projectPaymentsTable).where(inArray(projectPaymentsTable.billingContactId, contactIds)));
    const refByProj = await hasRow(dbx, dbx.select({ id: projectsTable.id }).from(projectsTable).where(inArray(projectsTable.contactId, contactIds)));
    if (refByQuote || refByPay || refByProj) categories.push("contact_in_transaction");
  }

  return { blocked: categories.length > 0, categories };
}
