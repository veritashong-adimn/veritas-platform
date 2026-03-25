import { Router, type IRouter } from "express";
import {
  db, projectsTable, quotesTable, paymentsTable, settlementsTable,
  usersTable, companiesTable, contactsTable, notesTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { buildQuoteHtml, buildStatementHtml } from "../services/document.service";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

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

  return { project, quote: quotes[0] ?? null, payment: payments[0] ?? null, settlement: settlements[0] ?? null, company, contact, notes };
}

// ─── 견적서 HTML 출력 ──────────────────────────────────────────────────────
router.get("/admin/projects/:id/pdf/quote", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const data = await loadProjectData(projectId);
    if (!data) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }

    const { project, quote, company, contact, notes } = data;

    const html = buildQuoteHtml({
      projectId: project.id,
      projectTitle: project.title,
      projectStatus: project.status,
      issuedAt: new Date().toISOString(),
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
      quoteAmount: quote?.price != null ? Number(quote.price) : null,
      quoteStatus: quote?.status ?? null,
      quoteCreatedAt: quote?.createdAt?.toISOString() ?? null,
      notes,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(html);
  } catch (err) {
    req.log.error({ err }, "Documents: failed to build quote PDF");
    res.status(500).json({ error: "견적서 생성 실패." });
  }
});

// ─── 거래명세서 HTML 출력 ──────────────────────────────────────────────────
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

    const html = buildStatementHtml({
      projectId: project.id,
      projectTitle: project.title,
      projectStatus: project.status,
      issuedAt: new Date().toISOString(),
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
      totalAmount: settlement?.totalAmount != null ? Number(settlement.totalAmount) : (payment?.amount != null ? Number(payment.amount) : null),
      translatorAmount: settlement?.translatorAmount != null ? Number(settlement.translatorAmount) : null,
      platformFee: settlement?.platformFee != null ? Number(settlement.platformFee) : null,
      notes,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.send(html);
  } catch (err) {
    req.log.error({ err }, "Documents: failed to build statement PDF");
    res.status(500).json({ error: "거래명세서 생성 실패." });
  }
});

export default router;
