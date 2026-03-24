import { Router, type IRouter } from "express";
import {
  db, companiesTable, contactsTable, projectsTable,
  paymentsTable, settlementsTable, quotesTable, communicationsTable, usersTable,
} from "@workspace/db";
import { eq, and, ilike, or, inArray, sql, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

// ─── 거래처 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/companies", ...adminGuard, async (req, res) => {
  try {
    const { search } = req.query as { search?: string };

    const rows = await db
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        businessNumber: companiesTable.businessNumber,
        industry: companiesTable.industry,
        address: companiesTable.address,
        website: companiesTable.website,
        createdAt: companiesTable.createdAt,
        contactCount: sql<number>`COUNT(DISTINCT ${contactsTable.id})::int`,
        projectCount: sql<number>`COUNT(DISTINCT ${projectsTable.id})::int`,
        totalPayment: sql<number>`COALESCE(SUM(${paymentsTable.amount}) FILTER (WHERE ${paymentsTable.status} = 'paid'), 0)::int`,
      })
      .from(companiesTable)
      .leftJoin(contactsTable, eq(contactsTable.companyId, companiesTable.id))
      .leftJoin(projectsTable, eq(projectsTable.companyId, companiesTable.id))
      .leftJoin(paymentsTable, eq(paymentsTable.projectId, projectsTable.id))
      .groupBy(companiesTable.id)
      .orderBy(desc(companiesTable.createdAt));

    let result = rows;
    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(s) ||
        (c.businessNumber ?? "").toLowerCase().includes(s) ||
        (c.industry ?? "").toLowerCase().includes(s)
      );
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Companies: failed to list");
    res.status(500).json({ error: "거래처 조회 실패." });
  }
});

// ─── 거래처 생성 ─────────────────────────────────────────────────────────────
router.post("/admin/companies", ...adminGuard, async (req, res) => {
  const { name, businessNumber, representativeName, email, phone, industry, address, website, notes } = req.body as {
    name?: string; businessNumber?: string; representativeName?: string;
    email?: string; phone?: string; industry?: string;
    address?: string; website?: string; notes?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "거래처명은 필수입니다." }); return;
  }

  try {
    const [company] = await db
      .insert(companiesTable)
      .values({ name: name.trim(), businessNumber, representativeName, email, phone, industry, address, website, notes })
      .returning();
    res.status(201).json(company);
  } catch (err) {
    req.log.error({ err }, "Companies: failed to create");
    res.status(500).json({ error: "거래처 생성 실패." });
  }
});

// ─── 거래처 상세 ─────────────────────────────────────────────────────────────
router.get("/admin/companies/:id", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }

  try {
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    const contacts = await db.select().from(contactsTable).where(eq(contactsTable.companyId, companyId));

    const projects = await db
      .select({ id: projectsTable.id, title: projectsTable.title, status: projectsTable.status, createdAt: projectsTable.createdAt })
      .from(projectsTable)
      .where(eq(projectsTable.companyId, companyId))
      .orderBy(desc(projectsTable.createdAt));

    const projectIds = projects.map(p => p.id);
    let totalQuote = 0, totalPayment = 0, totalSettlement = 0;

    if (projectIds.length > 0) {
      const [qRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${quotesTable.amount}), 0)::int` })
        .from(quotesTable)
        .where(and(inArray(quotesTable.projectId, projectIds), eq(quotesTable.status, "approved")));
      totalQuote = qRow?.total ?? 0;

      const [pmRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${paymentsTable.amount}), 0)::int` })
        .from(paymentsTable)
        .where(and(inArray(paymentsTable.projectId, projectIds), eq(paymentsTable.status, "paid")));
      totalPayment = pmRow?.total ?? 0;

      const [sRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${settlementsTable.translatorAmount}), 0)::int` })
        .from(settlementsTable)
        .where(inArray(settlementsTable.projectId, projectIds));
      totalSettlement = sRow?.total ?? 0;
    }

    res.json({ ...company, contacts, projects, totalQuote, totalPayment, totalSettlement });
  } catch (err) {
    req.log.error({ err }, "Companies: failed to get detail");
    res.status(500).json({ error: "거래처 상세 조회 실패." });
  }
});

// ─── 거래처 수정 ─────────────────────────────────────────────────────────────
router.patch("/admin/companies/:id", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }

  const { name, businessNumber, representativeName, email, phone, industry, address, website, notes } = req.body;

  try {
    const [existing] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!existing) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(companiesTable)
      .set({
        name: name?.trim() ?? existing.name,
        businessNumber: businessNumber ?? existing.businessNumber,
        representativeName: representativeName ?? existing.representativeName,
        email: email ?? existing.email,
        phone: phone ?? existing.phone,
        industry: industry ?? existing.industry,
        address: address ?? existing.address,
        website: website ?? existing.website,
        notes: notes ?? existing.notes,
      })
      .where(eq(companiesTable.id, companyId))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Companies: failed to update");
    res.status(500).json({ error: "거래처 수정 실패." });
  }
});

// ─── 거래처 삭제 ─────────────────────────────────────────────────────────────
router.delete("/admin/companies/:id", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }

  try {
    const [existing] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!existing) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Companies: failed to delete");
    res.status(500).json({ error: "거래처 삭제 실패." });
  }
});

// ─── 담당자 목록 (회사별) ────────────────────────────────────────────────────
router.get("/admin/companies/:id/contacts", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }

  try {
    const rows = await db.select().from(contactsTable).where(eq(contactsTable.companyId, companyId)).orderBy(desc(contactsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to list");
    res.status(500).json({ error: "담당자 조회 실패." });
  }
});

// ─── 담당자 목록 (독립, 전체) ────────────────────────────────────────────────
router.get("/admin/contacts", ...adminGuard, async (req, res) => {
  try {
    const { search, companyId: companyIdQ } = req.query as { search?: string; companyId?: string };
    const rows = await db
      .select({
        id: contactsTable.id,
        companyId: contactsTable.companyId,
        name: contactsTable.name,
        department: contactsTable.department,
        position: contactsTable.position,
        email: contactsTable.email,
        phone: contactsTable.phone,
        notes: contactsTable.notes,
        createdAt: contactsTable.createdAt,
        companyName: companiesTable.name,
      })
      .from(contactsTable)
      .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
      .orderBy(desc(contactsTable.createdAt));

    let result = rows;
    if (companyIdQ) result = result.filter(c => c.companyId === Number(companyIdQ));
    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(s) ||
        (c.email ?? "").toLowerCase().includes(s) ||
        (c.companyName ?? "").toLowerCase().includes(s) ||
        (c.department ?? "").toLowerCase().includes(s)
      );
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to list all");
    res.status(500).json({ error: "담당자 조회 실패." });
  }
});

// ─── 담당자 독립 생성 ────────────────────────────────────────────────────────
router.post("/admin/contacts", ...adminGuard, async (req, res) => {
  const { companyId, name, department, position, email, phone, notes } = req.body as {
    companyId?: number; name?: string; department?: string;
    position?: string; email?: string; phone?: string; notes?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "담당자명은 필수입니다." }); return;
  }
  if (!companyId || isNaN(companyId)) {
    res.status(400).json({ error: "거래처 ID는 필수입니다." }); return;
  }

  try {
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    const [contact] = await db
      .insert(contactsTable)
      .values({ companyId, name: name.trim(), department, position, email, phone, notes })
      .returning();
    res.status(201).json(contact);
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to create (standalone)");
    res.status(500).json({ error: "담당자 생성 실패." });
  }
});

// ─── 담당자 상세 ─────────────────────────────────────────────────────────────
router.get("/admin/contacts/:id", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) {
    res.status(400).json({ error: "유효하지 않은 contact id." }); return;
  }

  try {
    const [contact] = await db
      .select({
        id: contactsTable.id,
        companyId: contactsTable.companyId,
        name: contactsTable.name,
        department: contactsTable.department,
        position: contactsTable.position,
        email: contactsTable.email,
        phone: contactsTable.phone,
        notes: contactsTable.notes,
        createdAt: contactsTable.createdAt,
        companyName: companiesTable.name,
      })
      .from(contactsTable)
      .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
      .where(eq(contactsTable.id, contactId));

    if (!contact) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }

    const projects = await db
      .select({ id: projectsTable.id, title: projectsTable.title, status: projectsTable.status, createdAt: projectsTable.createdAt })
      .from(projectsTable)
      .where(eq(projectsTable.contactId, contactId))
      .orderBy(desc(projectsTable.createdAt));

    const projectIds = projects.map(p => p.id);
    const communications = projectIds.length > 0
      ? await db
          .select({
            id: communicationsTable.id,
            type: communicationsTable.type,
            content: communicationsTable.content,
            projectId: communicationsTable.projectId,
            createdAt: communicationsTable.createdAt,
          })
          .from(communicationsTable)
          .where(
            projectIds.length === 1
              ? eq(communicationsTable.projectId, projectIds[0])
              : sql`${communicationsTable.projectId} = ANY(ARRAY[${sql.join(projectIds.map(id => sql`${id}`), sql`, `)}])`
          )
          .orderBy(desc(communicationsTable.createdAt))
      : [];

    res.json({ ...contact, projects, communications });
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to get detail");
    res.status(500).json({ error: "담당자 상세 조회 실패." });
  }
});

// ─── 담당자 생성 (회사별) ─────────────────────────────────────────────────────
router.post("/admin/companies/:id/contacts", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }

  const { name, department, position, email, phone, notes } = req.body as {
    name?: string; department?: string; position?: string; email?: string; phone?: string; notes?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "담당자명은 필수입니다." }); return;
  }

  try {
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    const [contact] = await db
      .insert(contactsTable)
      .values({ companyId, name: name.trim(), department, position, email, phone, notes })
      .returning();
    res.status(201).json(contact);
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to create");
    res.status(500).json({ error: "담당자 생성 실패." });
  }
});

// ─── 담당자 수정 ─────────────────────────────────────────────────────────────
router.patch("/admin/contacts/:id", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) {
    res.status(400).json({ error: "유효하지 않은 contact id." }); return;
  }

  const { name, department, position, email, phone, notes } = req.body;

  try {
    const [existing] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactId));
    if (!existing) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(contactsTable)
      .set({
        name: name?.trim() ?? existing.name,
        department: department ?? existing.department,
        position: position ?? existing.position,
        email: email ?? existing.email,
        phone: phone ?? existing.phone,
        notes: notes ?? existing.notes,
      })
      .where(eq(contactsTable.id, contactId))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to update");
    res.status(500).json({ error: "담당자 수정 실패." });
  }
});

// ─── 담당자 삭제 ─────────────────────────────────────────────────────────────
router.delete("/admin/contacts/:id", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) {
    res.status(400).json({ error: "유효하지 않은 contact id." }); return;
  }

  try {
    await db.delete(contactsTable).where(eq(contactsTable.id, contactId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to delete");
    res.status(500).json({ error: "담당자 삭제 실패." });
  }
});

export default router;
