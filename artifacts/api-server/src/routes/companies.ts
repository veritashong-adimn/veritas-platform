import { Router, type IRouter } from "express";
import {
  db, companiesTable, contactsTable, projectsTable,
  paymentsTable, settlementsTable, quotesTable, communicationsTable, usersTable,
  billingBatchesTable, divisionsTable, companyNameHistoryTable,
} from "@workspace/db";
import { eq, and, ilike, or, inArray, sql, desc, ne } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 거래처 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/companies", ...adminGuard, async (req, res) => {
  try {
    const { search, companyType, vendorType } = req.query as { search?: string; companyType?: string; vendorType?: string };

    const rows = await db
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        businessNumber: companiesTable.businessNumber,
        industry: companiesTable.industry,
        businessCategory: companiesTable.businessCategory,
        address: companiesTable.address,
        website: companiesTable.website,
        registeredAt: companiesTable.registeredAt,
        createdAt: companiesTable.createdAt,
        companyType: companiesTable.companyType,
        vendorType: companiesTable.vendorType,
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
      const historyMatches = await db
        .select({ companyId: companyNameHistoryTable.companyId })
        .from(companyNameHistoryTable)
        .where(ilike(companyNameHistoryTable.companyName, `%${s}%`));
      const historyIds = new Set(historyMatches.map(h => h.companyId));

      result = result.filter(c =>
        c.name.toLowerCase().includes(s) ||
        (c.businessNumber ?? "").toLowerCase().includes(s) ||
        (c.industry ?? "").toLowerCase().includes(s) ||
        historyIds.has(c.id)
      );
    }
    if (companyType === "client" || companyType === "vendor") {
      result = result.filter(c => c.companyType === companyType);
    }
    if (vendorType) {
      result = result.filter(c => c.vendorType === vendorType);
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Companies: failed to list");
    res.status(500).json({ error: "거래처 조회 실패." });
  }
});

// ─── 거래처 생성 ─────────────────────────────────────────────────────────────
router.post("/admin/companies", ...adminGuard, requirePermission("company.create"), async (req, res) => {
  const { name, businessNumber, representativeName, email, phone, industry, businessCategory, address, website, notes, registeredAt, companyType, vendorType } = req.body as {
    name?: string; businessNumber?: string; representativeName?: string;
    email?: string; phone?: string; industry?: string; businessCategory?: string;
    address?: string; website?: string; notes?: string; registeredAt?: string;
    companyType?: string; vendorType?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "거래처명은 필수입니다." }); return;
  }

  const resolvedCompanyType = companyType === "vendor" ? "vendor" : "client";
  const resolvedVendorType = resolvedCompanyType === "vendor" ? (vendorType || null) : null;

  // 오늘 날짜를 기본 등록일로
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [company] = await db
      .insert(companiesTable)
      .values({ name: name.trim(), businessNumber, representativeName, email, phone, industry, businessCategory, address, website, notes, registeredAt: registeredAt ?? today, companyType: resolvedCompanyType, vendorType: resolvedVendorType })
      .returning();

    // 최초 상호를 이력으로 기록
    await db.insert(companyNameHistoryTable).values({
      companyId: company.id,
      companyName: company.name,
      nameType: "current",
      validFrom: today,
      changedBy: (req as any).user?.id ?? null,
      changedByEmail: (req as any).user?.email ?? null,
      reason: "최초 등록",
    });

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
        email: contactsTable.email, phone: contactsTable.phone, mobile: contactsTable.mobile,
        officePhone: contactsTable.officePhone, notes: contactsTable.notes, memo: contactsTable.memo,
        isPrimary: contactsTable.isPrimary, isQuoteContact: contactsTable.isQuoteContact,
        isBillingContact: contactsTable.isBillingContact, isActive: contactsTable.isActive,
        createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
      })
      .from(contactsTable)
      .where(eq(contactsTable.companyId, companyId))
      .orderBy(desc(contactsTable.isPrimary), contactsTable.name);

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

    // 상호 변경 이력
    const nameHistory = await db
      .select()
      .from(companyNameHistoryTable)
      .where(eq(companyNameHistoryTable.companyId, companyId))
      .orderBy(desc(companyNameHistoryTable.changedAt));

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

    res.json({ ...company, contacts, divisions: divisionsWithStats, projects, totalQuote, totalPayment, totalSettlement, prepaidBalance, activeAccumulatedCount, unpaidAmount, lastProjectDate, lastPaymentDate, nameHistory });
  } catch (err) {
    req.log.error({ err }, "Companies: failed to get detail");
    res.status(500).json({ error: "거래처 상세 조회 실패." });
  }
});

// ─── 거래처 수정 ─────────────────────────────────────────────────────────────
router.patch("/admin/companies/:id", ...adminGuard, requirePermission("company.update"), async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }

  const { name, businessNumber, representativeName, email, phone, industry, businessCategory, address, website, notes, registeredAt, nameChangeReason, companyType, vendorType } = req.body;

  try {
    const [existing] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!existing) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    const newName = name?.trim() ?? existing.name;
    const today = new Date().toISOString().slice(0, 10);
    const performer = (req as any).user as { id: number; email: string } | undefined;

    const resolvedCompanyType = companyType === "vendor" ? "vendor" : companyType === "client" ? "client" : existing.companyType;
    const resolvedVendorType = resolvedCompanyType === "vendor" ? (vendorType !== undefined ? (vendorType || null) : existing.vendorType) : null;

    const [updated] = await db
      .update(companiesTable)
      .set({
        name: newName,
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
        companyType: resolvedCompanyType,
        vendorType: resolvedVendorType,
      })
      .where(eq(companiesTable.id, companyId))
      .returning();

    // 상호 변경 이력 기록
    if (newName !== existing.name) {
      // 이전 상호: 기존 current 레코드의 valid_to 종료 처리
      await db
        .update(companyNameHistoryTable)
        .set({ validTo: today, nameType: "previous" })
        .where(and(
          eq(companyNameHistoryTable.companyId, companyId),
          eq(companyNameHistoryTable.nameType, "current"),
        ));

      // 새 상호: current 이력 추가
      await db.insert(companyNameHistoryTable).values({
        companyId,
        companyName: newName,
        nameType: "current",
        validFrom: today,
        changedBy: performer?.id ?? null,
        changedByEmail: performer?.email ?? null,
        reason: nameChangeReason?.trim() || "상호 변경",
      });

      // logEvent 기록
      await logEvent("company", companyId, "company_name_changed", req.log, performer,
        JSON.stringify({ from: existing.name, to: newName, reason: nameChangeReason?.trim() || "상호 변경" }));
    }

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
  const { isActive } = req.query as { isActive?: string };
  try {
    const conds = [eq(contactsTable.companyId, companyId)];
    if (isActive === "true") conds.push(eq(contactsTable.isActive, true));
    if (isActive === "false") conds.push(eq(contactsTable.isActive, false));
    const rows = await db.select().from(contactsTable)
      .where(and(...conds))
      .orderBy(desc(contactsTable.isPrimary), contactsTable.name);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to list");
    res.status(500).json({ error: "담당자 조회 실패." });
  }
});

// ─── 공통: 전체 담당자 목록 (GET /admin/contacts  &  GET /admin/company-contacts) ─
async function listContacts(req: any, res: any) {
  try {
    const { keyword, companyId: companyIdQ, isActive } = req.query as {
      keyword?: string; companyId?: string; isActive?: string;
    };

    const conds: ReturnType<typeof eq>[] = [];
    if (companyIdQ) conds.push(eq(contactsTable.companyId, Number(companyIdQ)));
    if (isActive === "true") conds.push(eq(contactsTable.isActive, true));
    if (isActive === "false") conds.push(eq(contactsTable.isActive, false));

    const rows = await db
      .select({
        id: contactsTable.id, companyId: contactsTable.companyId, divisionId: contactsTable.divisionId,
        name: contactsTable.name, department: contactsTable.department, position: contactsTable.position,
        email: contactsTable.email, phone: contactsTable.phone, mobile: contactsTable.mobile,
        officePhone: contactsTable.officePhone, notes: contactsTable.notes, memo: contactsTable.memo,
        isPrimary: contactsTable.isPrimary, isQuoteContact: contactsTable.isQuoteContact,
        isBillingContact: contactsTable.isBillingContact, isActive: contactsTable.isActive,
        createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
        companyName: companiesTable.name,
      })
      .from(contactsTable)
      .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(contactsTable.isPrimary), contactsTable.name);

    let result = rows;
    if (keyword?.trim()) {
      const s = keyword.trim().toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(s) ||
        (c.email ?? "").toLowerCase().includes(s) ||
        (c.mobile ?? "").toLowerCase().includes(s) ||
        (c.phone ?? "").toLowerCase().includes(s) ||
        (c.companyName ?? "").toLowerCase().includes(s)
      );
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to list");
    res.status(500).json({ error: "담당자 조회 실패." });
  }
}

router.get("/admin/contacts", ...adminGuard, listContacts);
router.get("/admin/company-contacts", ...adminGuard, listContacts);

// ─── 공통: 담당자 생성 헬퍼 ──────────────────────────────────────────────────
async function createContact(req: any, res: any, targetCompanyId: number) {
  const {
    name, department, position, email, phone, mobile, officePhone, notes, memo,
    isPrimary, isQuoteContact, isBillingContact, isActive, divisionId,
  } = req.body as {
    name?: string; department?: string; position?: string; email?: string; phone?: string;
    mobile?: string; officePhone?: string; notes?: string; memo?: string;
    isPrimary?: boolean; isQuoteContact?: boolean; isBillingContact?: boolean; isActive?: boolean;
    divisionId?: number | null;
  };

  if (!name?.trim()) { res.status(400).json({ error: "담당자명은 필수입니다." }); return; }
  if (!mobile?.trim() && !email?.trim()) {
    res.status(400).json({ error: "휴대폰 또는 이메일 중 하나 이상 입력해주세요." }); return;
  }
  if (email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." }); return;
  }

  const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, targetCompanyId));
  if (!company) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

  // isPrimary = true 이면 기존 기본 담당자 해제
  if (isPrimary) {
    await db.update(contactsTable)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(and(eq(contactsTable.companyId, targetCompanyId), eq(contactsTable.isPrimary, true)));
  }

  const [contact] = await db
    .insert(contactsTable)
    .values({
      companyId: targetCompanyId, name: name.trim(),
      department: department ?? null, position: position ?? null,
      email: email?.trim() ?? null, phone: phone?.trim() ?? null,
      mobile: mobile?.trim() ?? null, officePhone: officePhone?.trim() ?? null,
      notes: notes ?? null, memo: memo ?? null,
      isPrimary: isPrimary ?? false,
      isQuoteContact: isQuoteContact ?? false,
      isBillingContact: isBillingContact ?? false,
      isActive: isActive !== false,
      divisionId: divisionId ? Number(divisionId) : null,
    })
    .returning();

  await logEvent("company", targetCompanyId, "company_contact_created", undefined, (req as any).user?.id,
    JSON.stringify({ contactId: contact.id, name: contact.name, isPrimary: contact.isPrimary }));

  res.status(201).json(contact);
}

// ─── 담당자 독립 생성 ────────────────────────────────────────────────────────
router.post("/admin/contacts", ...adminGuard, requirePermission("contact.create"), async (req, res) => {
  const companyId = Number(req.body.companyId);
  if (!companyId || isNaN(companyId)) { res.status(400).json({ error: "거래처 ID는 필수입니다." }); return; }
  try { await createContact(req, res, companyId); }
  catch (err) { req.log.error({ err }, "Contacts: failed to create"); res.status(500).json({ error: "담당자 생성 실패." }); }
});

router.post("/admin/company-contacts", ...adminGuard, requirePermission("contact.create"), async (req, res) => {
  const companyId = Number(req.body.companyId);
  if (!companyId || isNaN(companyId)) { res.status(400).json({ error: "거래처 ID는 필수입니다." }); return; }
  try { await createContact(req, res, companyId); }
  catch (err) { req.log.error({ err }, "Contacts: failed to create"); res.status(500).json({ error: "담당자 생성 실패." }); }
});

// ─── 담당자 상세 ─────────────────────────────────────────────────────────────
router.get("/admin/contacts/:id", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) { res.status(400).json({ error: "유효하지 않은 contact id." }); return; }

  try {
    const [contact] = await db
      .select({
        id: contactsTable.id, companyId: contactsTable.companyId, divisionId: contactsTable.divisionId,
        name: contactsTable.name, department: contactsTable.department, position: contactsTable.position,
        email: contactsTable.email, phone: contactsTable.phone, mobile: contactsTable.mobile,
        officePhone: contactsTable.officePhone, notes: contactsTable.notes, memo: contactsTable.memo,
        isPrimary: contactsTable.isPrimary, isQuoteContact: contactsTable.isQuoteContact,
        isBillingContact: contactsTable.isBillingContact, isActive: contactsTable.isActive,
        createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
        companyName: companiesTable.name,
      })
      .from(contactsTable)
      .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
      .where(eq(contactsTable.id, contactId));

    if (!contact) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }

    const projects = await db
      .select({ id: projectsTable.id, title: projectsTable.title, status: projectsTable.status, createdAt: projectsTable.createdAt })
      .from(projectsTable).where(eq(projectsTable.contactId, contactId)).orderBy(desc(projectsTable.createdAt));

    const projectIds = projects.map(p => p.id);
    const communications = projectIds.length > 0
      ? await db.select({
          id: communicationsTable.id, type: communicationsTable.type,
          content: communicationsTable.content, projectId: communicationsTable.projectId,
          createdAt: communicationsTable.createdAt,
        }).from(communicationsTable)
          .where(inArray(communicationsTable.projectId, projectIds))
          .orderBy(desc(communicationsTable.createdAt))
      : [];

    res.json({ ...contact, projects, communications });
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to get detail");
    res.status(500).json({ error: "담당자 상세 조회 실패." });
  }
});

router.get("/admin/company-contacts/:id", ...adminGuard, async (req, res) => {
  req.params.id = req.params.id;
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) { res.status(400).json({ error: "유효하지 않은 contact id." }); return; }
  try {
    const [contact] = await db.select().from(contactsTable)
      .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
      .where(eq(contactsTable.id, contactId));
    if (!contact) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }
    res.json({ ...contact.contacts, companyName: contact.companies?.name ?? null });
  } catch (err) { res.status(500).json({ error: "담당자 조회 실패." }); }
});

// ─── 담당자 생성 (회사별) ─────────────────────────────────────────────────────
router.post("/admin/companies/:id/contacts", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 company id." }); return; }
  try { await createContact(req, res, companyId); }
  catch (err) { req.log.error({ err }, "Contacts: failed to create"); res.status(500).json({ error: "담당자 생성 실패." }); }
});

// ─── 담당자 수정 ─────────────────────────────────────────────────────────────
async function patchContact(req: any, res: any, contactId: number) {
  const {
    name, department, position, email, phone, mobile, officePhone, notes, memo,
    isPrimary, isQuoteContact, isBillingContact, isActive, divisionId,
  } = req.body;

  const [existing] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactId));
  if (!existing) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }

  if (email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." }); return;
  }

  const prevPrimary = existing.isPrimary;

  // isPrimary 변경 → 기존 기본 담당자 자동 해제
  if (isPrimary === true && !existing.isPrimary) {
    await db.update(contactsTable)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(and(eq(contactsTable.companyId, existing.companyId), eq(contactsTable.isPrimary, true), ne(contactsTable.id, contactId)));
  }

  const [updated] = await db
    .update(contactsTable)
    .set({
      name: name?.trim() ?? existing.name,
      department: department !== undefined ? department : existing.department,
      position: position !== undefined ? position : existing.position,
      email: email !== undefined ? (email?.trim() || null) : existing.email,
      phone: phone !== undefined ? (phone?.trim() || null) : existing.phone,
      mobile: mobile !== undefined ? (mobile?.trim() || null) : existing.mobile,
      officePhone: officePhone !== undefined ? (officePhone?.trim() || null) : existing.officePhone,
      notes: notes !== undefined ? notes : existing.notes,
      memo: memo !== undefined ? memo : existing.memo,
      isPrimary: isPrimary !== undefined ? isPrimary : existing.isPrimary,
      isQuoteContact: isQuoteContact !== undefined ? isQuoteContact : existing.isQuoteContact,
      isBillingContact: isBillingContact !== undefined ? isBillingContact : existing.isBillingContact,
      isActive: isActive !== undefined ? isActive : existing.isActive,
      divisionId: divisionId !== undefined ? (divisionId ? Number(divisionId) : null) : existing.divisionId,
      updatedAt: new Date(),
    })
    .where(eq(contactsTable.id, contactId))
    .returning();

  const performer = (req as any).user?.id;
  await logEvent("company", existing.companyId, "company_contact_updated", undefined, performer,
    JSON.stringify({ contactId, name: updated.name, isPrimary: updated.isPrimary, prevPrimary }));
  if (isPrimary === true && !prevPrimary) {
    await logEvent("company", existing.companyId, "company_contact_primary_changed", undefined, performer,
      JSON.stringify({ contactId, name: updated.name }));
  }

  res.json(updated);
}

router.patch("/admin/contacts/:id", ...adminGuard, requirePermission("contact.update"), async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) { res.status(400).json({ error: "유효하지 않은 contact id." }); return; }
  try { await patchContact(req, res, contactId); }
  catch (err) { req.log.error({ err }, "Contacts: failed to update"); res.status(500).json({ error: "담당자 수정 실패." }); }
});

router.patch("/admin/company-contacts/:id", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) { res.status(400).json({ error: "유효하지 않은 contact id." }); return; }
  try { await patchContact(req, res, contactId); }
  catch (err) { req.log.error({ err }, "Contacts: failed to update"); res.status(500).json({ error: "담당자 수정 실패." }); }
});

// ─── 담당자 삭제 (soft delete) ───────────────────────────────────────────────
async function deleteContact(req: any, res: any, contactId: number) {
  const [existing] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactId));
  if (!existing) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }

  const hasProjects = await db.select({ id: projectsTable.id }).from(projectsTable)
    .where(eq(projectsTable.contactId, contactId)).limit(1);

  if (hasProjects.length > 0) {
    // 프로젝트 연결 이력 있으면 비활성 처리
    await db.update(contactsTable).set({ isActive: false, updatedAt: new Date() })
      .where(eq(contactsTable.id, contactId));
    await logEvent("company", existing.companyId, "company_contact_deleted", undefined, (req as any).user?.id,
      JSON.stringify({ contactId, name: existing.name, reason: "soft_delete_has_projects" }));
    res.json({ ok: true, softDeleted: true });
  } else {
    await db.delete(contactsTable).where(eq(contactsTable.id, contactId));
    await logEvent("company", existing.companyId, "company_contact_deleted", undefined, (req as any).user?.id,
      JSON.stringify({ contactId, name: existing.name, reason: "hard_delete" }));
    res.json({ ok: true, softDeleted: false });
  }
}

router.delete("/admin/contacts/:id", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) { res.status(400).json({ error: "유효하지 않은 contact id." }); return; }
  try { await deleteContact(req, res, contactId); }
  catch (err) { req.log.error({ err }, "Contacts: failed to delete"); res.status(500).json({ error: "담당자 삭제 실패." }); }
});

router.delete("/admin/company-contacts/:id", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) { res.status(400).json({ error: "유효하지 않은 contact id." }); return; }
  try { await deleteContact(req, res, contactId); }
  catch (err) { req.log.error({ err }, "Contacts: failed to delete"); res.status(500).json({ error: "담당자 삭제 실패." }); }
});

export default router;
