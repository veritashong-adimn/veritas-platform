// 판매 상세 전용 조회 — GET /admin/projects/:id?view=sale (SalesDetailPage 전용)
//
// 기존 범용 상세(GET /admin/projects/:id, 프로젝트 상세 모달 등)는 그대로 두고, 판매 상세화면이 실제로 쓰는 자료만
// 같은 규칙·같은 계산 함수로 조회한다. 차이는 아래뿐이다.
//   · 제외: quoteVersions · payments · tasks(번역사 프로필·단가표) · settlements · logs · notes · communications
//           (판매 상세화면 미사용 — 응답에 키를 넣지 않는다)
//   · 병렬: 판매 id 만 필요한 조회(견적·품목·수신자·수행정보·결제정보)는 판매 기본행과 같은 단계에서,
//           거래처·담당자·선입금은 기본행 직후 한 단계에서 실행
//   · 중복 제거: 선입금 원장 잔액(getCompanyBalances)을 1회만 조회해 company.prepaidBalance 와 prepaidAccount 에 함께 사용
//           (기존은 같은 계산을 2회), 거래처 선입 누계·사용 누계는 같은 조건의 합계 1회 조회
//   · 추가: 각 견적에 recipient(견적서 수신자 — 견적 상세 API 와 같은 값) — 견적 상세 API 를 따로 부르지 않게 함
import { db, quotesTable, quoteItemsTable, companiesTable, contactsTable, projectsTable } from "@workspace/db";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { getCompanyBalances } from "./prepaidLedger";
import { loadPerformanceAnnotations } from "./legacyPayoutStatus";
import { loadRemittanceSummaries } from "./performanceRemittance";
import { hasSnapshot, recipientInfoOfProjectQuotes } from "./quoteRecipientSnapshot";
import { loadPerformanceRows } from "../routes/performances";
import { loadPaymentRecords } from "../routes/projectPayments";

const currentQuotesOf = (projectId: number) => and(eq(quotesTable.projectId, projectId), eq(quotesTable.isCurrent, true));

/** projectQ: 범용 상세와 같은 판매 기본행 조회(같은 select). 없으면 null. */
export async function loadSaleDetailView(projectId: number, projectQ: PromiseLike<any[]>): Promise<Record<string, unknown> | null> {
  // ① 판매 id 만 필요한 조회 — 기본행과 같은 단계에서 시작
  //  (drizzle 조회는 then 이 호출될 때 실행되므로 .then 으로 즉시 시작시킨다)
  const quotesP = db.select().from(quotesTable).where(currentQuotesOf(projectId)).then(r => r);
  const itemsP = db.select().from(quoteItemsTable)
    .where(inArray(quoteItemsTable.quoteId, db.select({ id: quotesTable.id }).from(quotesTable).where(currentQuotesOf(projectId))))
    .orderBy(quoteItemsTable.id).then(r => r);
  const recipientP = recipientInfoOfProjectQuotes(db, projectId);
  // 수행정보(원가) — 범용 상세와 같은 함수·같은 합성(추가비용·차감 하위행, 지급확인 표시, 해외 송금 요약)
  const perfP = Promise.all([
    loadPerformanceAnnotations(db, projectId),
    loadPerformanceRows(projectId).then(async rows => [rows, await loadRemittanceSummaries(db, rows as any[])] as const),
  ]).then(([perfNotes, [perfRows, remitByRow]]) => (perfRows as any[]).map((p: any) => ({
    ...p, ...(perfNotes.get(Number(p.id)) ?? { legacyPayout: null, quantityFromSale: false }),
    ...(remitByRow.has(Number(p.id)) ? { remittanceSummary: remitByRow.get(Number(p.id)) } : {}),
  })));
  const payP = loadPaymentRecords(projectId);
  const early: Promise<unknown>[] = [quotesP, itemsP, recipientP, perfP, payP];
  for (const p of early) p.catch(() => {});   // 기본행 대기 중 먼저 실패해도 처리되지 않은 거부로 남지 않게(오류는 아래 Promise.all 에서 그대로 전달)

  const [project] = await projectQ.then(r => r, async e => { await Promise.allSettled(early); throw e; });
  if (!project) { await Promise.allSettled(early); return null; }

  // ② 기본행(거래처·담당자 id) 필요 조회 — 한 단계
  const companyId: number | null = project.companyId ?? null;
  const contactP = project.contactId
    ? db.select().from(contactsTable).where(eq(contactsTable.id, project.contactId)).then(r => r[0] ?? null)
    : Promise.resolve(null);
  const companyP = companyId ? Promise.all([
    db.select().from(companiesTable).where(eq(companiesTable.id, companyId)).then(r => r[0] ?? null),
    // 최신 선입금 잔액 스냅샷(원장 없을 때 대체값) — 범용 상세와 같은 조건
    db.select({ prepaidBalanceAfter: quotesTable.prepaidBalanceAfter }).from(quotesTable)
      .innerJoin(projectsTable, eq(quotesTable.projectId, projectsTable.id))
      .where(and(eq(projectsTable.companyId, companyId), sql`${quotesTable.quoteType} IN ('prepaid_deduction', 'b2c_prepaid')`, eq(quotesTable.isCurrent, true)))
      .orderBy(desc(quotesTable.id)).limit(1).then(r => r[0]),
    getCompanyBalances(db, [companyId]).then(m => m.get(companyId)),
    // 총 입금액(b2c_prepaid 견적 price 합) · 누적 사용액(prepaid_deduction usage 합) — 거래처 전체 판매의 현재 견적. 범용 상세의 두 합계와 같은 조건
    db.execute(sql`SELECT
        COALESCE(SUM(q.price) FILTER (WHERE q.quote_type = 'b2c_prepaid'), 0)::int AS dep,
        COALESCE(SUM(q.prepaid_usage_amount) FILTER (WHERE q.quote_type = 'prepaid_deduction'), 0)::int AS used
      FROM quotes q JOIN projects p ON p.id = q.project_id WHERE p.company_id = ${companyId} AND q.is_current = true`)
      .then(r => (r.rows as any[])[0]),
  ]) : Promise.resolve(null);

  const [contact, companyRes, quotes, items, recipients, performances, paymentRecords] =
    await Promise.all([contactP, companyP, quotesP, itemsP, recipientP, perfP, payP]);

  let company: Record<string, unknown> | null = null;
  let prepaidAccount: { totalDeposited: number; available: number } | null = null;
  if (companyRes) {
    const [c, lastPrepaidQuote, ledgerBal, sums] = companyRes;
    if (c) {
      const prepaidBalance = ledgerBal ? ledgerBal.balance
        : lastPrepaidQuote?.prepaidBalanceAfter != null ? Number(lastPrepaidQuote.prepaidBalanceAfter) : null;
      company = { ...c, prepaidBalance, prepaidTotalDeposited: Number(sums?.dep ?? 0), prepaidTotalUsed: Number(sums?.used ?? 0) };
    }
    if (ledgerBal) prepaidAccount = { totalDeposited: ledgerBal.deposit + Math.max(0, ledgerBal.opening), available: ledgerBal.balance };
  }

  const itemsByQuote = new Map<number, any[]>();
  for (const it of items) { const a = itemsByQuote.get(it.quoteId) ?? []; a.push(it); itemsByQuote.set(it.quoteId, a); }
  const quotesOut = quotes.map(q => {
    const r = recipients.get(q.id);
    // 견적 상세 API 는 삭제된 견적이면 404 — 수신자 정보 없음(null)으로 같게 둔다
    const recipient = q.deletedAt || !r ? null : {
      customerSnapshotFixed: hasSnapshot({
        customerCompanyName: q.customerCompanyName, customerContactName: q.customerContactName, customerContactPosition: q.customerContactPosition,
        customerContactDepartment: q.customerContactDepartment, customerContactPhone: q.customerContactPhone, customerContactMobile: q.customerContactMobile,
        customerContactEmail: q.customerContactEmail,
      }),
      contactPhone: r.contactPhone, contactEmail: r.contactEmail, liveRecipient: r.live,
    };
    return { ...q, items: itemsByQuote.get(q.id) ?? [], recipient };
  });

  return { ...project, view: "sale", quotes: quotesOut, company, contact, performances, paymentRecords, prepaidAccount };
}
