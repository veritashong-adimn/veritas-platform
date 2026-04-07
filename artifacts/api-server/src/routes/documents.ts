import { Router, type IRouter } from "express";
import {
  db, projectsTable, quotesTable, paymentsTable, settlementsTable,
  usersTable, companiesTable, contactsTable, notesTable, quoteItemsTable,
  prepaidAccountsTable, prepaidLedgerTable, settingsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  buildQuoteHtml, buildStatementHtml,
  type PlatformInfo, type BankInfo, type QuoteItemDoc,
} from "../services/document.service";
import { quoteDocNumber, statementDocNumber } from "../services/doc-number";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

/** settings 테이블에서 플랫폼·계좌 정보를 동적으로 로드 */
async function loadPlatformAndBank(): Promise<{ platform: PlatformInfo; bank: BankInfo | null }> {
  const rows = await db.select().from(settingsTable).limit(1);
  const s = rows[0] ?? {};
  const platform: PlatformInfo = {
    name: s.companyName || process.env.PLATFORM_NAME || "통번역 플랫폼",
    representativeName: s.ceoName || process.env.PLATFORM_REPRESENTATIVE || undefined,
    businessNumber: s.businessNumber || process.env.PLATFORM_BIZ_NUMBER || undefined,
    address: s.address || process.env.PLATFORM_ADDRESS || undefined,
    phone: s.phone || process.env.PLATFORM_PHONE || undefined,
    email: s.email || process.env.PLATFORM_EMAIL || undefined,
    website: process.env.PLATFORM_WEBSITE,
  };
  const bank: BankInfo | null =
    s.bankName && s.accountNumber
      ? { bankName: s.bankName, accountNumber: s.accountNumber, accountHolder: s.accountHolder || platform.name }
      : (process.env.BANK_NAME && process.env.BANK_ACCOUNT
          ? { bankName: process.env.BANK_NAME, accountNumber: process.env.BANK_ACCOUNT, accountHolder: process.env.BANK_HOLDER || platform.name }
          : null);
  return { platform, bank };
}

// ── 공통 데이터 로더 ─────────────────────────────────────────────────────────

async function loadProjectData(projectId: number) {
  const [project] = await db
    .select({
      id: projectsTable.id,
      title: projectsTable.title,
      status: projectsTable.status,
      companyId: projectsTable.companyId,
      contactId: projectsTable.contactId,
      customerEmail: usersTable.email,
    })
    .from(projectsTable)
    .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
    .where(eq(projectsTable.id, projectId));

  if (!project) return null;

  const [quotes, payments, settlements, rawNotes] = await Promise.all([
    db.select().from(quotesTable).where(eq(quotesTable.projectId, projectId)).limit(1),
    db.select().from(paymentsTable)
      .where(and(eq(paymentsTable.projectId, projectId), eq(paymentsTable.status, "paid")))
      .limit(1),
    db.select().from(settlementsTable).where(eq(settlementsTable.projectId, projectId)).limit(1),
    db.select({ content: notesTable.content })
      .from(notesTable)
      .where(and(eq(notesTable.entityType, "project"), eq(notesTable.entityId, projectId)))
      .limit(3),
  ]);

  const quote = quotes[0] ?? null;

  // quote_items 로드
  let quoteItems: QuoteItemDoc[] = [];
  if (quote) {
    const rawItems = await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).orderBy(quoteItemsTable.id);
    quoteItems = rawItems.map(it => ({
      id: it.id,
      productName: it.productName,
      unit: it.unit,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      supplyAmount: it.supplyAmount,
      taxAmount: it.taxAmount,
      totalAmount: it.totalAmount,
      memo: it.memo,
    }));
  }

  let company = null;
  let contact = null;
  if (project.companyId) {
    const [c] = await db.select().from(companiesTable).where(eq(companiesTable.id, project.companyId));
    company = c ?? null;
  }
  if (project.contactId) {
    const [ct] = await db.select().from(contactsTable).where(eq(contactsTable.id, project.contactId));
    contact = ct ?? null;
  }

  const notes = rawNotes.map(n => n.content).join("\n").trim();

  return {
    project,
    quote,
    quoteItems,
    payment: payments[0] ?? null,
    settlement: settlements[0] ?? null,
    company,
    contact,
    notes,
  };
}

// ── 견적서 ───────────────────────────────────────────────────────────────────

router.get("/admin/projects/:id/pdf/quote", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const data = await loadProjectData(projectId);
    if (!data) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }

    const { project, quote, quoteItems, company, contact, notes } = data;
    const { platform, bank } = await loadPlatformAndBank();
    const issuedAt = new Date();
    const docNumber = quoteDocNumber(quote?.id ?? projectId, issuedAt);
    const totalAmount = quote?.price != null ? Number(quote.price) : null;

    // quote_items가 있으면 품목 배열로 렌더링, 없으면 단일 요약 행
    const hasQuoteItems = quoteItems.length > 0;

    // prepaid_deduction 견적서인 경우 해당 계정의 누적 원장 내역 조회
    let ledgerHistory: Array<{
      id: number; type: "deposit" | "deduction" | "adjustment";
      amount: number; balanceAfter: number;
      description?: string | null; projectId?: number | null; projectTitle?: string | null;
      transactionDate: string | null; createdAt: string | null;
    }> | undefined = undefined;

    if (quote?.quoteType === "prepaid_deduction" && project.companyId) {
      // 이 거래처의 활성 선입금 계정 조회
      const [acct] = await db
        .select({ id: prepaidAccountsTable.id })
        .from(prepaidAccountsTable)
        .where(and(eq(prepaidAccountsTable.companyId, project.companyId), eq(prepaidAccountsTable.status, "active")))
        .limit(1);

      if (acct) {
        const ledgerRows = await db
          .select()
          .from(prepaidLedgerTable)
          .where(eq(prepaidLedgerTable.accountId, acct.id))
          .orderBy(prepaidLedgerTable.transactionDate, prepaidLedgerTable.createdAt);

        // 연결된 프로젝트 제목 조회
        const pids = ledgerRows.filter(r => r.projectId).map(r => r.projectId as number);
        let projectTitleMap = new Map<number, string>();
        if (pids.length > 0) {
          const ps = await db.select({ id: projectsTable.id, title: projectsTable.title }).from(projectsTable);
          projectTitleMap = new Map(ps.map(p => [p.id, p.title]));
        }

        ledgerHistory = ledgerRows.map(r => ({
          id: r.id,
          type: r.type as "deposit" | "deduction" | "adjustment",
          amount: Number(r.amount),
          balanceAfter: Number(r.balanceAfter),
          description: r.description,
          projectId: r.projectId,
          projectTitle: r.projectId ? (projectTitleMap.get(r.projectId) ?? null) : null,
          transactionDate: r.transactionDate ? String(r.transactionDate) : null,
          createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        }));
      }
    }

    const html = buildQuoteHtml({
      docNumber,
      projectId: project.id,
      projectTitle: project.title,
      projectStatus: project.status,
      issuedAt: issuedAt.toISOString(),
      validDays: 30,
      platform,
      bank,
      company: company ? {
        name: company.name,
        businessNumber: company.businessNumber,
        representativeName: company.representativeName,
        address: company.address,
        email: company.email,
        phone: company.phone,
        industry: company.industry,
      } : null,
      contact: contact ? {
        name: contact.name,
        department: contact.department,
        position: contact.position,
        email: contact.email,
        phone: contact.phone,
      } : null,
      customerEmail: project.customerEmail,
      quoteId: quote?.id ?? null,
      quoteStatus: quote?.status ?? null,
      quoteCreatedAt: quote?.createdAt?.toISOString() ?? null,
      items: hasQuoteItems ? quoteItems : undefined,
      totalAmount: hasQuoteItems ? null : totalAmount,
      supplyAmount: hasQuoteItems ? null : totalAmount,
      taxAmount: hasQuoteItems ? null : 0,
      taxDocumentType: (quote?.taxDocumentType ?? "tax_invoice") as "tax_invoice" | "bill",
      taxCategory: (quote?.taxCategory ?? "normal") as "normal" | "zero_rated" | "consignment" | "consignment_zero_rated",
      quoteType: (quote?.quoteType ?? "b2b_standard") as "b2c_prepaid" | "b2b_standard" | "prepaid_deduction" | "accumulated_batch",
      billingType: quote?.billingType ?? "postpaid_per_project",
      validUntil: quote?.validUntil ?? null,
      issueDate: quote?.issueDate ?? null,
      invoiceDueDate: quote?.invoiceDueDate ?? null,
      paymentDueDate: quote?.paymentDueDate ?? null,
      prepaidBalanceBefore: quote?.prepaidBalanceBefore != null ? Number(quote.prepaidBalanceBefore) : null,
      prepaidUsageAmount: quote?.prepaidUsageAmount != null ? Number(quote.prepaidUsageAmount) : null,
      prepaidBalanceAfter: quote?.prepaidBalanceAfter != null ? Number(quote.prepaidBalanceAfter) : null,
      ledgerHistory,
      batchPeriodStart: quote?.batchPeriodStart ?? null,
      batchPeriodEnd: quote?.batchPeriodEnd ?? null,
      batchItemCount: quote?.batchItemCount ?? null,
      notes,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    req.log.error({ err }, "Documents: failed to build quote PDF");
    res.status(500).json({ error: "견적서 생성 실패." });
  }
});

// ── 거래명세서 ───────────────────────────────────────────────────────────────

router.get("/admin/projects/:id/pdf/statement", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const data = await loadProjectData(projectId);
    if (!data) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }

    const { project, payment, settlement, company, contact, notes } = data;
    const { platform, bank } = await loadPlatformAndBank();
    const issuedAt = new Date();
    const docNumber = statementDocNumber(projectId, issuedAt);

    const html = buildStatementHtml({
      docNumber,
      projectId: project.id,
      projectTitle: project.title,
      projectStatus: project.status,
      issuedAt: issuedAt.toISOString(),
      platform,
      bank,
      company: company ? {
        name: company.name,
        businessNumber: company.businessNumber,
        representativeName: company.representativeName,
        address: company.address,
        email: company.email,
        phone: company.phone,
      } : null,
      contact: contact ? {
        name: contact.name,
        department: contact.department,
        position: contact.position,
        email: contact.email,
        phone: contact.phone,
      } : null,
      customerEmail: project.customerEmail,
      paymentAmount: payment?.amount != null ? Number(payment.amount) : null,
      paymentDate: payment?.createdAt?.toISOString() ?? null,
      paymentStatus: payment?.status ?? null,
      totalAmount: settlement?.totalAmount != null
        ? Number(settlement.totalAmount)
        : (payment?.amount != null ? Number(payment.amount) : null),
      translatorAmount: settlement?.translatorAmount != null ? Number(settlement.translatorAmount) : null,
      platformFee: settlement?.platformFee != null ? Number(settlement.platformFee) : null,
      notes,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    req.log.error({ err }, "Documents: failed to build statement PDF");
    res.status(500).json({ error: "거래명세서 생성 실패." });
  }
});

export default router;
