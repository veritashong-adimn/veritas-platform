// ─── Master(기준정보) Hard Delete Dependency Guard — 통번역사/담당자/상품 (K-2) ───
// K-1 companyDependency.ts 와 동일한 원칙:
//   · 과거 거래/수행/정산/지급/수금 자료가 1건이라도 연결되어 있으면 Hard Delete 전면 차단.
//   · Master 종속정보(profile/rates 등)의 존재 자체는 차단 사유가 아니다 — "과거 이력"만 차단 기준.
//   · Snapshot(이름 보존)은 표시용일 뿐, 원본 수행/정산/지급 레코드 삭제 허용 근거가 아니다.
//   · 삭제 "이전"에 호출하여, cascade 시작 후 오류가 아니라 사전 차단한다.
// K-1 을 건드리지 않기 위해 companyDependency.ts 와 분리하고, 공통 인터페이스/유틸만 자체 정의한다.
import { eq, sql } from "drizzle-orm";
import {
  tasksTable, settlementsTable, performanceAssignmentsTable,
  payoutRoundItemsTable, payoutTransfersTable,
  projectsTable, quotesTable, projectPaymentsTable,
  quoteItemsTable, productRequestsTable,
  contactsTable, inquiriesTable,
} from "@workspace/db";

type Dbx = any; // db 또는 tx

export interface MasterDependencyResult {
  blocked: boolean;      // true → 과거 거래/수행/정산/지급 자료 연결 → Hard Delete 금지
  categories: string[];  // 내부 로깅/감사용(사용자 메시지엔 비노출)
}

async function hasRow(dbx: Dbx, query: any): Promise<boolean> {
  const rows = await query.limit(1);
  return rows.length > 0;
}

// ① 통번역사(users, role=translator) — users.id 참조 과거 수행/정산/지급.
//    translator_profiles/rates/products/emails/sensitive/documents(종속정보)는 차단 대상 아님.
export async function evaluateTranslatorHardDeleteDependencies(dbx: Dbx, userId: number): Promise<MasterDependencyResult> {
  const categories: string[] = [];
  // 작업/수행 — tasks.translatorId
  if (await hasRow(dbx, dbx.select({ id: tasksTable.id }).from(tasksTable).where(eq(tasksTable.translatorId, userId)))) categories.push("task");
  // 정산 — settlements.translatorId (translatorName 스냅샷이 있어도 원본 보존)
  if (await hasRow(dbx, dbx.select({ id: settlementsTable.id }).from(settlementsTable).where(eq(settlementsTable.translatorId, userId)))) categories.push("settlement");
  // 수행(원가) — performance_assignments.individualUserId (수행비용/공제 하위자료는 이 assignment 에 종속되어 함께 커버됨)
  if (await hasRow(dbx, dbx.select({ id: performanceAssignmentsTable.id }).from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.individualUserId, userId)))) categories.push("performance");
  // 지급(지급회차·송금) — payeeType='individual' AND payeeId=userId (FK 없는 soft-link)
  if (await hasRow(dbx, dbx.select({ id: payoutRoundItemsTable.id }).from(payoutRoundItemsTable).where(sql`${payoutRoundItemsTable.payeeType} = 'individual' AND ${payoutRoundItemsTable.payeeId} = ${userId}`))) categories.push("payout_round_item");
  if (await hasRow(dbx, dbx.select({ id: payoutTransfersTable.id }).from(payoutTransfersTable).where(sql`${payoutTransfersTable.payeeType} = 'individual' AND ${payoutTransfersTable.payeeId} = ${userId}`))) categories.push("payout_transfer");
  return { blocked: categories.length > 0, categories };
}

// ② 담당자(contacts) — 견적/판매/프로젝트/수금에서 참조.
export async function evaluateContactHardDeleteDependencies(dbx: Dbx, contactId: number): Promise<MasterDependencyResult> {
  const categories: string[] = [];
  if (await hasRow(dbx, dbx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.contactId, contactId)))) categories.push("project");
  if (await hasRow(dbx, dbx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.derivedContactId, contactId)))) categories.push("quote");
  if (await hasRow(dbx, dbx.select({ id: projectPaymentsTable.id }).from(projectPaymentsTable).where(eq(projectPaymentsTable.billingContactId, contactId)))) categories.push("project_payment");
  return { blocked: categories.length > 0, categories };
}

// ③ 상품(products) — 견적/판매/상품요청/수행에서 참조.
//    주의: performance_assignments 는 productId FK 가 없고 productNameSnapshot(이름)만 보유하므로
//    이름 기반 보조 검사만 가능(기존 purge 동작 유지). 이름 일치는 과차단(보수적)일 수 있으나
//    "과거 사용 상품은 삭제 대신 사용중지" 목표상 안전한 방향이다.
export async function evaluateProductHardDeleteDependencies(dbx: Dbx, productId: number, productName: string | null): Promise<MasterDependencyResult> {
  const categories: string[] = [];
  // 견적/판매 — quote_items.productId (productId 는 set null 이지만, 연결된 동안은 과거 사용 이력)
  if (await hasRow(dbx, dbx.select({ id: quoteItemsTable.id }).from(quoteItemsTable).where(eq(quoteItemsTable.productId, productId)))) categories.push("quote_item");
  // 상품요청 승인 — product_requests.approvedProductId
  if (await hasRow(dbx, dbx.select({ id: productRequestsTable.id }).from(productRequestsTable).where(eq(productRequestsTable.approvedProductId, productId)))) categories.push("product_request");
  // 수행 — 이름 스냅샷 기반(ID 참조 없음)
  if (productName && await hasRow(dbx, dbx.select({ id: performanceAssignmentsTable.id }).from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.productNameSnapshot, productName)))) categories.push("performance_name_match");
  return { blocked: categories.length > 0, categories };
}

// ④ 부서(divisions) — 담당자/프로젝트/문의에서 divisionId 로 참조(모두 FK 없는 느슨한 참조).
//    물리삭제는 연결자료 0건일 때만 허용. 기본 삭제는 사용중지(isActive=false)이므로 이 가드는 ?hard 경로에서만 사용.
export async function evaluateDivisionHardDeleteDependencies(dbx: Dbx, divisionId: number): Promise<MasterDependencyResult> {
  const categories: string[] = [];
  if (await hasRow(dbx, dbx.select({ id: contactsTable.id }).from(contactsTable).where(eq(contactsTable.divisionId, divisionId)))) categories.push("contact");
  if (await hasRow(dbx, dbx.select({ id: projectsTable.id }).from(projectsTable).where(sql`${projectsTable.requestingDivisionId} = ${divisionId} OR ${projectsTable.billingDivisionId} = ${divisionId} OR ${projectsTable.payerDivisionId} = ${divisionId}`))) categories.push("project");
  if (await hasRow(dbx, dbx.select({ id: inquiriesTable.id }).from(inquiriesTable).where(eq(inquiriesTable.divisionId, divisionId)))) categories.push("inquiry");
  return { blocked: categories.length > 0, categories };
}
