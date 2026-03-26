import { Router, type IRouter } from "express";
import {
  db, projectsTable, quotesTable, paymentsTable, settlementsTable,
  usersTable, companiesTable, contactsTable, notesTable, quoteItemsTable,
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

/**
 * 플랫폼(발신기관) 정보
 * 향후: DB settings 테이블 또는 환경변수로 교체
 */
const PLATFORM: PlatformInfo = {
  name: process.env.PLATFORM_NAME ?? "통번역 플랫폼",
  representativeName: process.env.PLATFORM_REPRESENTATIVE ?? "대표자명",
  businessNumber: process.env.PLATFORM_BIZ_NUMBER ?? "000-00-00000",
  address: process.env.PLATFORM_ADDRESS ?? "서울특별시 강남구 테헤란로 000, 00층",
  phone: process.env.PLATFORM_PHONE ?? "02-000-0000",
  email: process.env.PLATFORM_EMAIL ?? "contact@platform.com",
  website: process.env.PLATFORM_WEBSITE,
};

/**
 * 계좌 정보 (선택적)
 * 향후: DB settings 테이블에서 로드
 */
const BANK: BankInfo | null =
  process.env.BANK_NAME && process.env.BANK_ACCOUNT
    ? {
        bankName: process.env.BANK_NAME,
        accountNumber: process.env.BANK_ACCOUNT,
        accountHolder: process.env.BANK_HOLDER ?? PLATFORM.name,
      }
    : null;

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
    const issuedAt = new Date();
    const docNumber = quoteDocNumber(quote?.id ?? projectId, issuedAt);
    const totalAmount = quote?.price != null ? Number(quote.price) : null;

    // quote_items가 있으면 품목 배열로 렌더링, 없으면 단일 요약 행
    const hasQuoteItems = quoteItems.length > 0;

    const html = buildQuoteHtml({
      docNumber,
      projectId: project.id,
      projectTitle: project.title,
      projectStatus: project.status,
      issuedAt: issuedAt.toISOString(),
      validDays: 30,
      platform: PLATFORM,
      bank: BANK,
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
    const issuedAt = new Date();
    const docNumber = statementDocNumber(projectId, issuedAt);

    const html = buildStatementHtml({
      docNumber,
      projectId: project.id,
      projectTitle: project.title,
      projectStatus: project.status,
      issuedAt: issuedAt.toISOString(),
      platform: PLATFORM,
      bank: BANK,
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
