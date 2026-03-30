import { Router, type IRouter } from "express";
import {
  db, companiesTable, contactsTable, projectsTable,
  paymentsTable, settlementsTable, quotesTable, communicationsTable, usersTable,
  billingBatchesTable, divisionsTable,
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
  const { name, businessNumber, representativeName, email, phone, industry, businessCategory, address, website, notes, registeredAt } = req.body as {
    name?: string; businessNumber?: string; representativeName?: string;
    email?: string; phone?: string; industry?: string; businessCategory?: string;
    address?: string; website?: string; notes?: string; registeredAt?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "거래처명은 필수입니다." }); return;
  }

  // 오늘 날짜를 기본 등록일로
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [company] = await db
      .insert(companiesTable)
      .values({ name: name.trim(), businessNumber, representativeName, email, phone, industry, businessCategory, address, website, notes, registeredAt: registeredAt ?? today })
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

    const contacts = await db
      .select({
        id: contactsTable.id, companyId: contactsTable.companyId, divisionId: contactsTable.divisionId,
        name: contactsTable.name, department: contactsTable.department, position: contactsTable.position,
        email: contactsTable.email, phone: contactsTable.phone, notes: contactsTable.notes,
        createdAt: contactsTable.createdAt,
      })
      .from(contactsTable)
      .where(eq(contactsTable.companyId, companyId));

    const divisions = await db
      .select({
        id: divisionsTable.id, companyId: divisionsTable.companyId,
        name: divisionsTable.name, type: divisionsTable.type, createdAt: divisionsTable.createdAt,
      })
      .from(divisionsTable)
      .where(eq(divisionsTable.companyId, companyId))
      .orderBy(divisionsTable.name);

    const projects = await db
      .select({
        id: projectsTable.id, title: projectsTable.title, status: projectsTable.status,
        createdAt: projectsTable.createdAt,
        requestingDivisionId: sql<number | null>`${projectsTable.requestingDivisionId}`,
      })
      .from(projectsTable)
      .where(eq(projectsTable.companyId, companyId))
      .orderBy(desc(projectsTable.createdAt));

    const projectIds = projects.map(p => p.id);
    let totalQuote = 0, totalPayment = 0, totalSettlement = 0;
    let prepaidBalance: number | null = null;
    let activeAccumulatedCount = 0;
    let lastPaymentDate: string | null = null;

    if (projectIds.length > 0) {
      const [qRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${quotesTable.price}), 0)::int` })
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

      // 선입금 잔액 (최신 선입금/차감 견적의 balance_after)
      const [lastPrepaid] = await db
        .select({ prepaidBalanceAfter: sql<string | null>`${quotesTable.prepaidBalanceAfter}` })
        .from(quotesTable)
        .where(and(
          inArray(quotesTable.projectId, projectIds),
          sql`${quotesTable.quoteType} IN ('b2c_prepaid', 'prepaid_deduction')`,
          sql`${quotesTable.prepaidBalanceAfter} IS NOT NULL`,
        ))
        .orderBy(desc(quotesTable.id))
        .limit(1);
      if (lastPrepaid) prepaidBalance = Number(lastPrepaid.prepaidBalanceAfter);

      // 마지막 결제일
      const [lastPm] = await db
        .select({ paymentDate: paymentsTable.paymentDate })
        .from(paymentsTable)
        .where(and(inArray(paymentsTable.projectId, projectIds), eq(paymentsTable.status, "paid")))
        .orderBy(desc(paymentsTable.id))
        .limit(1);
      lastPaymentDate = lastPm?.paymentDate ? String(lastPm.paymentDate) : null;
    }

    // 누적 청구 진행 중 건수
    const activeBatches = await db
      .select({ id: billingBatchesTable.id })
      .from(billingBatchesTable)
      .where(and(eq(billingBatchesTable.companyId, companyId), sql`${billingBatchesTable.status} != 'paid'`));
    activeAccumulatedCount = activeBatches.length;

    const lastProjectDate = projects.length > 0 ? projects[0].createdAt : null;
    const unpaidAmount = Math.max(0, totalQuote - totalPayment);

    // 브랜드별 프로젝트 수 및 매출 집계
    const divisionStats: Record<number, { projectCount: number; payment: number }> = {};
    for (const p of projects) {
      const did = p.requestingDivisionId;
      if (did != null) {
        if (!divisionStats[did]) divisionStats[did] = { projectCount: 0, payment: 0 };
        divisionStats[did].projectCount++;
      }
    }
    if (projectIds.length > 0) {
      const pmRows = await db
        .select({ projectId: paymentsTable.projectId, amount: paymentsTable.amount })
        .from(paymentsTable)
        .where(and(inArray(paymentsTable.projectId, projectIds), eq(paymentsTable.status, "paid")));
      for (const pm of pmRows) {
        const p = projects.find(pr => pr.id === pm.projectId);
        if (p?.requestingDivisionId != null) {
          if (!divisionStats[p.requestingDivisionId]) divisionStats[p.requestingDivisionId] = { projectCount: 0, payment: 0 };
          divisionStats[p.requestingDivisionId].payment += Number(pm.amount);
        }
      }
    }
    const divisionsWithStats = divisions.map(d => ({
      ...d,
      projectCount: divisionStats[d.id]?.projectCount ?? 0,
      totalPayment: divisionStats[d.id]?.payment ?? 0,
      contactCount: contacts.filter(c => c.divisionId === d.id).length,
    }));

    res.json({ ...company, contacts, divisions: divisionsWithStats, projects, totalQuote, totalPayment, totalSettlement, prepaidBalance, activeAccumulatedCount, unpaidAmount, lastProjectDate, lastPaymentDate });
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

  const { name, businessNumber, representativeName, email, phone, industry, businessCategory, address, website, notes, registeredAt } = req.body;

  try {
    const [existing] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!existing) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(companiesTable)
      .set({
        name: name?.trim() ?? existing.name,
        businessNumber: businessNumber !== undefined ? (businessNumber || null) : existing.businessNumber,
        representativeName: representativeName !== undefined ? (representativeName || null) : existing.representativeName,
        email: email !== undefined ? (email || null) : existing.email,
        phone: phone !== undefined ? (phone || null) : existing.phone,
        industry: industry !== undefined ? (industry || null) : existing.industry,
        businessCategory: businessCategory !== undefined ? (businessCategory || null) : existing.businessCategory,
        address: address !== undefined ? (address || null) : existing.address,
        website: website !== undefined ? (website || null) : existing.website,
        notes: notes !== undefined ? (notes || null) : existing.notes,
        registeredAt: registeredAt !== undefined ? (registeredAt || null) : existing.registeredAt,
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

// ─── 브랜드/부서 목록 ────────────────────────────────────────────────────────
router.get("/admin/companies/:id/divisions", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }
  try {
    const rows = await db.select().from(divisionsTable)
      .where(eq(divisionsTable.companyId, companyId))
      .orderBy(divisionsTable.name);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Divisions: failed to list");
    res.status(500).json({ error: "브랜드/부서 조회 실패." });
  }
});

// ─── 브랜드/부서 생성 ────────────────────────────────────────────────────────
router.post("/admin/companies/:id/divisions", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }
  const { name, type } = req.body as { name?: string; type?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "브랜드/부서명은 필수입니다." }); return;
  }
  try {
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }
    const [div] = await db.insert(divisionsTable)
      .values({ companyId, name: name.trim(), type: type?.trim() || null })
      .returning();
    res.status(201).json(div);
  } catch (err) {
    req.log.error({ err }, "Divisions: failed to create");
    res.status(500).json({ error: "브랜드/부서 생성 실패." });
  }
});

// ─── 브랜드/부서 수정 ────────────────────────────────────────────────────────
router.patch("/admin/divisions/:id", ...adminGuard, async (req, res) => {
  const divId = Number(req.params.id);
  if (isNaN(divId) || divId <= 0) {
    res.status(400).json({ error: "유효하지 않은 division id." }); return;
  }
  const { name, type } = req.body as { name?: string; type?: string };
  try {
    const [existing] = await db.select().from(divisionsTable).where(eq(divisionsTable.id, divId));
    if (!existing) { res.status(404).json({ error: "브랜드/부서를 찾을 수 없습니다." }); return; }
    const [updated] = await db.update(divisionsTable)
      .set({ name: name?.trim() ?? existing.name, type: type ?? existing.type })
      .where(eq(divisionsTable.id, divId))
      .returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Divisions: failed to update");
    res.status(500).json({ error: "브랜드/부서 수정 실패." });
  }
});

// ─── 브랜드/부서 삭제 ────────────────────────────────────────────────────────
router.delete("/admin/divisions/:id", ...adminGuard, async (req, res) => {
  const divId = Number(req.params.id);
  if (isNaN(divId) || divId <= 0) {
    res.status(400).json({ error: "유효하지 않은 division id." }); return;
  }
  try {
    await db.delete(divisionsTable).where(eq(divisionsTable.id, divId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Divisions: failed to delete");
    res.status(500).json({ error: "브랜드/부서 삭제 실패." });
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
          .where(inArray(communicationsTable.projectId, projectIds))
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
