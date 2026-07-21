import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import nodePath from "node:path";
import OpenAI from "openai";
import {
  db, companiesTable, contactsTable, projectsTable,
  paymentsTable, settlementsTable, quotesTable, communicationsTable, usersTable,
  billingBatchesTable, billingBatchItemsTable, billingBatchWorkItemsTable,
  divisionsTable, companyNameHistoryTable, logsTable,
  prepaidAccountsTable, prepaidLedgerTable,
  quoteItemsTable, quoteItemFilesTable,
  projectFilesTable, translatorProfilesTable,
  companyAliasesTable,
} from "@workspace/db";
import { eq, and, ilike, or, inArray, sql, desc, ne } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { buildAliasValues, ensureDefaultAlias } from "../lib/companyAlias";
import {
  isOcrSupportedExt, buildImageDataUrl, renderPdfFirstPageAsPng,
} from "../lib/documentOcr";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 거래처 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/companies", ...adminGuard, async (req, res) => {
  try {
    const { search, companyType, vendorType, customerType } = req.query as { search?: string; companyType?: string; vendorType?: string; customerType?: string };

    // ── opt-in 서버 페이지네이션: page 파라미터가 있을 때만. 없으면 레거시(배열) 응답 유지 ──
    if (req.query.page !== undefined) {
      const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
      const allowedSizes = [20, 30, 50, 100];
      let pageSize = parseInt(String(req.query.pageSize ?? "20"), 10) || 20;
      if (!allowedSizes.includes(pageSize)) pageSize = 20;
      const offset = (page - 1) * pageSize;

      // 검색 조건(SQL). 보조 매칭(상호이력/담당자명/브랜드명)은 회사 id 집합으로 선계산 후 OR.
      const s = search?.trim().toLowerCase();
      let searchCond: ReturnType<typeof or> | undefined;
      if (s) {
        const digits = s.replace(/\D/g, "");
        const ns = normalizeCompanyName(s); // Alias 정규화 매칭용(㈜베리타스↔베리타스)
        const [historyM, contactM, divM, aliasM] = await Promise.all([
          db.select({ companyId: companyNameHistoryTable.companyId }).from(companyNameHistoryTable).where(ilike(companyNameHistoryTable.companyName, `%${s}%`)),
          db.select({ companyId: contactsTable.companyId }).from(contactsTable).where(ilike(contactsTable.name, `%${s}%`)),
          db.select({ companyId: divisionsTable.companyId }).from(divisionsTable).where(ilike(divisionsTable.name, `%${s}%`)),
          db.select({ companyId: companyAliasesTable.companyId }).from(companyAliasesTable).where(
            or(...[ilike(companyAliasesTable.aliasName, `%${s}%`), ns ? ilike(companyAliasesTable.normalizedAlias, `%${ns}%`) : undefined].filter(Boolean) as any),
          ),
        ]);
        const auxIds = [...new Set<number>([
          ...historyM.map(h => h.companyId),
          ...(contactM.map(m => m.companyId).filter(Boolean) as number[]),
          ...divM.map(d => d.companyId),
          ...aliasM.map(a => a.companyId),
        ])];
        const conds = [
          ilike(companiesTable.name, `%${s}%`),
          ilike(companiesTable.representativeName, `%${s}%`),
          ilike(companiesTable.email, `%${s}%`),
          auxIds.length ? inArray(companiesTable.id, auxIds) : undefined,
        ];
        if (digits) {
          conds.push(sql`regexp_replace(coalesce(${companiesTable.businessNumber},''),'[^0-9]','','g') LIKE ${"%" + digits + "%"}`);
          conds.push(sql`regexp_replace(coalesce(${companiesTable.phone},''),'[^0-9]','','g') LIKE ${"%" + digits + "%"}`);
          conds.push(sql`regexp_replace(coalesce(${companiesTable.mobile},''),'[^0-9]','','g') LIKE ${"%" + digits + "%"}`);
        }
        searchCond = or(...conds.filter(Boolean) as any);
      }

      const filterConds = [];
      if (companyType === "client" || companyType === "vendor") filterConds.push(eq(companiesTable.companyType, companyType));
      if (vendorType) filterConds.push(eq(companiesTable.vendorType, vendorType));
      if (customerType === "CORPORATE" || customerType === "PUBLIC" || customerType === "INDIVIDUAL") {
        filterConds.push(sql`coalesce(${companiesTable.customerType},'CORPORATE') = ${customerType}`);
      }
      const whereAll = and(...[searchCond, ...filterConds].filter(Boolean) as any);

      // 전체 매칭 건수(검색+필터)
      const [{ cnt: total }] = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(companiesTable)
        .where(whereAll);

      // 필터탭 배지용 그룹 카운트(검색 반영, 유형/외주/고객분류 필터 제외)
      const grouped = await db
        .select({
          companyType: companiesTable.companyType,
          customerType: sql<string>`coalesce(${companiesTable.customerType},'CORPORATE')`,
          cnt: sql<number>`count(*)::int`,
        })
        .from(companiesTable)
        .where(searchCond)
        .groupBy(companiesTable.companyType, sql`coalesce(${companiesTable.customerType},'CORPORATE')`);
      const counts = { all: 0, client: 0, vendor: 0, customer: { CORPORATE: 0, PUBLIC: 0, INDIVIDUAL: 0 } as Record<string, number> };
      for (const g of grouped) {
        counts.all += g.cnt;
        if (g.companyType === "client") { counts.client += g.cnt; counts.customer[g.customerType] = (counts.customer[g.customerType] ?? 0) + g.cnt; }
        else counts.vendor += g.cnt;
      }

      // 현재 페이지 행(집계 포함)
      const pageRows = await db
        .select({
          id: companiesTable.id,
          name: companiesTable.name,
          businessNumber: companiesTable.businessNumber,
          representativeName: companiesTable.representativeName,
          email: companiesTable.email,
          phone: companiesTable.phone,
          mobile: companiesTable.mobile,
          industry: companiesTable.industry,
          businessCategory: companiesTable.businessCategory,
          address: companiesTable.address,
          website: companiesTable.website,
          notes: companiesTable.notes,
          registeredAt: companiesTable.registeredAt,
          createdAt: companiesTable.createdAt,
          companyType: companiesTable.companyType,
          vendorType: companiesTable.vendorType,
          customerType: companiesTable.customerType,
          contactCount: sql<number>`COUNT(DISTINCT ${contactsTable.id})::int`,
          projectCount: sql<number>`COUNT(DISTINCT ${projectsTable.id})::int`,
          totalPayment: sql<number>`COALESCE(SUM(${paymentsTable.amount}) FILTER (WHERE ${paymentsTable.status} = 'paid'), 0)::int`,
        })
        .from(companiesTable)
        .leftJoin(contactsTable, eq(contactsTable.companyId, companiesTable.id))
        .leftJoin(projectsTable, eq(projectsTable.companyId, companiesTable.id))
        .leftJoin(paymentsTable, eq(paymentsTable.projectId, projectsTable.id))
        .where(whereAll)
        .groupBy(companiesTable.id)
        .orderBy(desc(companiesTable.createdAt), desc(companiesTable.id))
        .limit(pageSize)
        .offset(offset);

      // 페이지 회사들의 브랜드/부서명만 조회
      const pageIds = pageRows.map(r => r.id);
      const divs = pageIds.length
        ? await db.select({ companyId: divisionsTable.companyId, name: divisionsTable.name }).from(divisionsTable).where(inArray(divisionsTable.companyId, pageIds))
        : [];
      const divMap = new Map<number, string[]>();
      for (const d of divs) { if (!divMap.has(d.companyId)) divMap.set(d.companyId, []); divMap.get(d.companyId)!.push(d.name); }

      const rowsOut = pageRows.map(c => ({
        ...c,
        divisionNames: divMap.get(c.id) ?? [],
        matchedDivisionName: s ? ((divMap.get(c.id) ?? []).find(n => n.toLowerCase().includes(s)) ?? null) : null,
      }));

      res.json({ rows: rowsOut, total, page, pageSize, counts });
      return;
    }

    const rows = await db
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        businessNumber: companiesTable.businessNumber,
        representativeName: companiesTable.representativeName,
        email: companiesTable.email,
        phone: companiesTable.phone,
        mobile: companiesTable.mobile,
        industry: companiesTable.industry,
        businessCategory: companiesTable.businessCategory,
        address: companiesTable.address,
        website: companiesTable.website,
        notes: companiesTable.notes,
        registeredAt: companiesTable.registeredAt,
        createdAt: companiesTable.createdAt,
        companyType: companiesTable.companyType,
        vendorType: companiesTable.vendorType,
        customerType: companiesTable.customerType,
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

    // divisions 전체 로드 (companyId → name[] 맵)
    const allDivisions = await db
      .select({ id: divisionsTable.id, companyId: divisionsTable.companyId, name: divisionsTable.name })
      .from(divisionsTable);
    const divisionsByCompany = new Map<number, { id: number; name: string }[]>();
    for (const d of allDivisions) {
      if (!divisionsByCompany.has(d.companyId)) divisionsByCompany.set(d.companyId, []);
      divisionsByCompany.get(d.companyId)!.push({ id: d.id, name: d.name });
    }

    // 기본 응답에 divisionNames 추가
    type ResultRow = typeof rows[number] & { divisionNames: string[]; matchedDivisionName: string | null };
    let result: ResultRow[] = rows.map(c => ({
      ...c,
      divisionNames: (divisionsByCompany.get(c.id) ?? []).map(d => d.name),
      matchedDivisionName: null as string | null,
    }));

    if (search?.trim()) {
      const s = search.trim().toLowerCase();

      // 상호 변경 이력 매칭
      const historyMatches = await db
        .select({ companyId: companyNameHistoryTable.companyId })
        .from(companyNameHistoryTable)
        .where(ilike(companyNameHistoryTable.companyName, `%${s}%`));
      const historyIds = new Set(historyMatches.map(h => h.companyId));

      // 담당자 이름 매칭
      const contactMatches = await db
        .select({ companyId: contactsTable.companyId })
        .from(contactsTable)
        .where(ilike(contactsTable.name, `%${s}%`));
      const contactMatchIds = new Set(contactMatches.map(m => m.companyId).filter(Boolean) as number[]);

      // 기업명 Alias 매칭(§9): 원문 부분일치 또는 정규화 일치(㈜베리타스↔베리타스)
      const ns = normalizeCompanyName(s);
      const aliasMatches = await db
        .select({ companyId: companyAliasesTable.companyId })
        .from(companyAliasesTable)
        .where(or(...[ilike(companyAliasesTable.aliasName, `%${s}%`), ns ? ilike(companyAliasesTable.normalizedAlias, `%${ns}%`) : undefined].filter(Boolean) as any));
      const aliasMatchIds = new Set(aliasMatches.map(a => a.companyId));

      result = result
        .map(c => {
          const divs = divisionsByCompany.get(c.id) ?? [];
          const matchedDiv = divs.find(d => d.name.toLowerCase().includes(s));
          return { ...c, matchedDivisionName: matchedDiv?.name ?? null };
        })
        .filter(c =>
          c.name.toLowerCase().includes(s) ||
          (c.businessNumber ?? "").replace(/-/g, "").includes(s.replace(/-/g, "")) ||
          (c.phone ?? "").replace(/-/g, "").includes(s.replace(/-/g, "")) ||
          (c.mobile ?? "").replace(/-/g, "").includes(s.replace(/-/g, "")) ||
          (c.email ?? "").toLowerCase().includes(s) ||
          (c.representativeName ?? "").toLowerCase().includes(s) ||
          c.matchedDivisionName !== null ||
          historyIds.has(c.id) ||
          contactMatchIds.has(c.id) ||
          aliasMatchIds.has(c.id)
        );
    }

    if (companyType === "client" || companyType === "vendor") {
      result = result.filter(c => c.companyType === companyType);
    }
    if (vendorType) {
      result = result.filter(c => c.vendorType === vendorType);
    }
    if (customerType === "CORPORATE" || customerType === "PUBLIC" || customerType === "INDIVIDUAL") {
      result = result.filter(c => (c.customerType ?? "CORPORATE") === customerType);
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Companies: failed to list");
    res.status(500).json({ error: "거래처 조회 실패." });
  }
});

// ─── 거래처 생성 ─────────────────────────────────────────────────────────────
router.post("/admin/companies", ...adminGuard, requirePermission("company.create"), async (req, res) => {
  const { name, businessNumber, representativeName, email, phone, mobile, industry, businessCategory, address, website, notes, registeredAt, companyType, vendorType, customerType } = req.body as {
    name?: string; businessNumber?: string; representativeName?: string;
    email?: string; phone?: string; mobile?: string; industry?: string; businessCategory?: string;
    address?: string; website?: string; notes?: string; registeredAt?: string;
    companyType?: string; vendorType?: string; customerType?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "거래처명은 필수입니다." }); return;
  }

  const resolvedCompanyType = companyType === "vendor" ? "vendor" : "client";
  const resolvedVendorType = resolvedCompanyType === "vendor" ? (vendorType || null) : null;
  const resolvedCustomerType = resolvedCompanyType === "client"
    ? (customerType === "INDIVIDUAL" ? "INDIVIDUAL" : customerType === "PUBLIC" ? "PUBLIC" : "CORPORATE")
    : null;

  // 오늘 날짜를 기본 등록일로
  const today = new Date().toISOString().slice(0, 10);

  try {
    const [company] = await db
      .insert(companiesTable)
      .values({ name: name.trim(), businessNumber, representativeName, email, phone, mobile, industry, businessCategory, address, website, notes, registeredAt: registeredAt ?? today, companyType: resolvedCompanyType, vendorType: resolvedVendorType, customerType: resolvedCustomerType })
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

    // 공식명 기반 기본 Alias 자동 생성(§8)
    await ensureDefaultAlias(db, company.id, company.name);

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
        registeredAt: contactsTable.registeredAt,
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

  const { name, businessNumber, representativeName, email, phone, mobile, industry, businessCategory, address, website, notes, registeredAt, nameChangeReason, companyType, vendorType, customerType } = req.body;

  try {
    const [existing] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!existing) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    const newName = name?.trim() ?? existing.name;
    const today = new Date().toISOString().slice(0, 10);
    const performer = (req as any).user as { id: number; email: string } | undefined;

    const resolvedCompanyType = companyType === "vendor" ? "vendor" : companyType === "client" ? "client" : existing.companyType;
    const resolvedVendorType = resolvedCompanyType === "vendor" ? (vendorType !== undefined ? (vendorType || null) : existing.vendorType) : null;
    const resolvedCustomerType = resolvedCompanyType === "client"
      ? (customerType !== undefined ? (customerType === "INDIVIDUAL" ? "INDIVIDUAL" : customerType === "PUBLIC" ? "PUBLIC" : "CORPORATE") : (existing.customerType ?? "CORPORATE"))
      : null;

    const [updated] = await db
      .update(companiesTable)
      .set({
        name: newName,
        businessNumber: businessNumber !== undefined ? (businessNumber || null) : existing.businessNumber,
        representativeName: representativeName !== undefined ? (representativeName || null) : existing.representativeName,
        email: email !== undefined ? (email || null) : existing.email,
        phone: phone !== undefined ? (phone || null) : existing.phone,
        mobile: mobile !== undefined ? (mobile || null) : existing.mobile,
        industry: industry !== undefined ? (industry || null) : existing.industry,
        businessCategory: businessCategory !== undefined ? (businessCategory || null) : existing.businessCategory,
        address: address !== undefined ? (address || null) : existing.address,
        website: website !== undefined ? (website || null) : existing.website,
        notes: notes !== undefined ? (notes || null) : existing.notes,
        registeredAt: registeredAt !== undefined ? (registeredAt || null) : existing.registeredAt,
        companyType: resolvedCompanyType,
        vendorType: resolvedVendorType,
        customerType: resolvedCustomerType,
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

// ─── 중복 인물 후보 검색 (차단 아닌 안내용) ────────────────────────────────────
router.get("/admin/people/duplicate-candidates", ...adminGuard, async (req, res) => {
  const { name, email, mobile } = req.query as { name?: string; email?: string; mobile?: string };

  const normalizedName   = name?.trim() || null;
  const normalizedEmail  = email?.trim().toLowerCase() || null;
  const normalizedMobile = mobile?.trim().replace(/\D/g, "") || null;

  if (!normalizedEmail && !normalizedMobile) {
    res.json({ candidates: [] }); return;
  }

  type MatchReason = "name_mobile" | "name_email" | "mobile" | "email";
  type RawCandidate = {
    source: "contact" | "individual_customer" | "translator";
    id: number; name: string; companyId?: number; companyName?: string;
    email?: string; mobile?: string; roleLabel: string;
    matchReason: MatchReason; priority: number;
  };
  const PRIORITY: Record<MatchReason, number> = { name_mobile: 1, name_email: 2, mobile: 3, email: 4 };
  const allMatches: RawCandidate[] = [];

  const pushContact = (r: { id: number; name: string; email: string | null; mobile: string | null; companyId: number | null; companyName: string | null }, reason: MatchReason) =>
    allMatches.push({ source: "contact", id: r.id, name: r.name, companyId: r.companyId ?? undefined, companyName: r.companyName ?? undefined, email: r.email ?? undefined, mobile: r.mobile ?? undefined, roleLabel: "담당자", matchReason: reason, priority: PRIORITY[reason] });
  const pushIndiv = (r: { id: number; name: string; email: string | null; mobile: string | null }, reason: MatchReason) =>
    allMatches.push({ source: "individual_customer", id: r.id, name: r.name, email: r.email ?? undefined, mobile: r.mobile ?? undefined, roleLabel: "개인고객", matchReason: reason, priority: PRIORITY[reason] });
  const pushTranslator = (r: { id: number; name: string | null; email: string; phone: string | null }, reason: MatchReason) =>
    allMatches.push({ source: "translator", id: r.id, name: r.name ?? "(이름 없음)", email: r.email, mobile: r.phone ?? undefined, roleLabel: "통번역사", matchReason: reason, priority: PRIORITY[reason] });

  try {
    const nameSql    = (col: any) => sql`lower(${col}) = ${normalizedName!.toLowerCase()}`;
    const mobileSql  = (col: any) => sql`regexp_replace(${col}, '[^0-9]', '', 'g') = ${normalizedMobile}`;
    const emailSql   = (col: any) => sql`lower(${col}) = ${normalizedEmail}`;

    // ── contacts ─────────────────────────────────────────────────────────────
    const cSel = { id: contactsTable.id, name: contactsTable.name, email: contactsTable.email, mobile: contactsTable.mobile, companyId: contactsTable.companyId, companyName: companiesTable.name };
    const cFrom = () => db.select(cSel).from(contactsTable).innerJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id));
    const cActive = eq(contactsTable.isActive, true);

    if (normalizedName && normalizedMobile) { (await cFrom().where(and(cActive, nameSql(contactsTable.name), mobileSql(contactsTable.mobile)))).forEach(r => pushContact(r, "name_mobile")); }
    if (normalizedName && normalizedEmail)  { (await cFrom().where(and(cActive, nameSql(contactsTable.name), emailSql(contactsTable.email)))).forEach(r => pushContact(r, "name_email")); }
    if (normalizedMobile)                   { (await cFrom().where(and(cActive, mobileSql(contactsTable.mobile)))).forEach(r => pushContact(r, "mobile")); }
    if (normalizedEmail)                    { (await cFrom().where(and(cActive, emailSql(contactsTable.email)))).forEach(r => pushContact(r, "email")); }

    // ── companies(INDIVIDUAL) ─────────────────────────────────────────────────
    const iSel  = { id: companiesTable.id, name: companiesTable.name, email: companiesTable.email, mobile: companiesTable.mobile };
    const iBase = eq(companiesTable.customerType, "INDIVIDUAL");
    const iFrom = () => db.select(iSel).from(companiesTable);

    if (normalizedName && normalizedMobile) { (await iFrom().where(and(iBase, nameSql(companiesTable.name), mobileSql(companiesTable.mobile)))).forEach(r => pushIndiv(r, "name_mobile")); }
    if (normalizedName && normalizedEmail)  { (await iFrom().where(and(iBase, nameSql(companiesTable.name), emailSql(companiesTable.email)))).forEach(r => pushIndiv(r, "name_email")); }
    if (normalizedMobile)                   { (await iFrom().where(and(iBase, mobileSql(companiesTable.mobile)))).forEach(r => pushIndiv(r, "mobile")); }
    if (normalizedEmail)                    { (await iFrom().where(and(iBase, emailSql(companiesTable.email)))).forEach(r => pushIndiv(r, "email")); }

    // ── translators (email uses leftJoin to catch no-profile users) ───────────
    const tSel  = { id: usersTable.id, name: usersTable.name, email: usersTable.email, phone: translatorProfilesTable.phone };
    const tBase = and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true));
    const tInner = () => db.select(tSel).from(usersTable).innerJoin(translatorProfilesTable, eq(translatorProfilesTable.userId, usersTable.id));
    const tLeft  = () => db.select(tSel).from(usersTable).leftJoin(translatorProfilesTable, eq(translatorProfilesTable.userId, usersTable.id));

    if (normalizedName && normalizedMobile) { (await tInner().where(and(tBase, nameSql(usersTable.name), mobileSql(translatorProfilesTable.phone)))).forEach(r => pushTranslator(r as any, "name_mobile")); }
    if (normalizedName && normalizedEmail)  { (await tLeft().where(and(tBase, nameSql(usersTable.name), emailSql(usersTable.email)))).forEach(r => pushTranslator(r as any, "name_email")); }
    if (normalizedMobile)                   { (await tInner().where(and(tBase, mobileSql(translatorProfilesTable.phone)))).forEach(r => pushTranslator(r as any, "mobile")); }
    if (normalizedEmail)                    { (await tLeft().where(and(tBase, emailSql(usersTable.email)))).forEach(r => pushTranslator(r as any, "email")); }

    // ── dedup: keep highest-priority match per (source:id), then sort ─────────
    const best = new Map<string, RawCandidate>();
    for (const m of allMatches) {
      const key = `${m.source}:${m.id}`;
      if (!best.has(key) || best.get(key)!.priority > m.priority) best.set(key, m);
    }
    const candidates = [...best.values()]
      .sort((a, b) => a.priority - b.priority)
      .map(({ priority, ...c }) => c);

    res.json({ candidates });
  } catch (err) {
    req.log.error({ err }, "People: failed to find duplicate candidates");
    res.status(500).json({ error: "후보 검색 실패." });
  }
});

// ─── 거래처 삭제 사전 검사 ───────────────────────────────────────────────────
router.get("/admin/companies/:id/delete-check", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }
  try {
    const [existing] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!existing) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    // 프로젝트 ID 목록 먼저 수집
    const projectRows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(or(
        eq(projectsTable.companyId, companyId),
        eq(projectsTable.requestingCompanyId, companyId),
        eq(projectsTable.billingCompanyId, companyId),
        eq(projectsTable.payerCompanyId, companyId),
      ));
    const projectIds = projectRows.map(p => p.id);

    // 병렬 카운트 조회
    const [
      [contacts],
      [divisions],
      [prepaidAccounts],
      [billingCycles],
    ] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(eq(contactsTable.companyId, companyId)),
      db.select({ count: sql<number>`count(*)::int` }).from(divisionsTable).where(eq(divisionsTable.companyId, companyId)),
      db.select({ count: sql<number>`count(*)::int` }).from(prepaidAccountsTable).where(eq(prepaidAccountsTable.companyId, companyId)),
      db.select({ count: sql<number>`count(*)::int` }).from(billingBatchesTable).where(eq(billingBatchesTable.companyId, companyId)),
    ]);

    let quotesCount = 0, paymentsCount = 0, settlementsCount = 0;
    if (projectIds.length > 0) {
      const [[qRow], [pmRow], [sRow]] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(quotesTable).where(inArray(quotesTable.projectId, projectIds)),
        db.select({ count: sql<number>`count(*)::int` }).from(paymentsTable).where(inArray(paymentsTable.projectId, projectIds)),
        db.select({ count: sql<number>`count(*)::int` }).from(settlementsTable).where(inArray(settlementsTable.projectId, projectIds)),
      ]);
      quotesCount = qRow?.count ?? 0;
      paymentsCount = pmRow?.count ?? 0;
      settlementsCount = sRow?.count ?? 0;
    }

    type Reason = { type: string; label: string; count: number };
    const reasons: Reason[] = [];

    if ((contacts?.count ?? 0) > 0) reasons.push({ type: "contacts", label: "담당자", count: contacts.count });
    if ((divisions?.count ?? 0) > 0) reasons.push({ type: "divisions", label: "브랜드/부서", count: divisions.count });
    if (projectIds.length > 0) reasons.push({ type: "projects", label: "프로젝트", count: projectIds.length });
    if (quotesCount > 0) reasons.push({ type: "quotes", label: "견적서", count: quotesCount });
    if (paymentsCount > 0) reasons.push({ type: "payments", label: "결제", count: paymentsCount });
    if (settlementsCount > 0) reasons.push({ type: "settlements", label: "정산", count: settlementsCount });
    if ((prepaidAccounts?.count ?? 0) > 0) reasons.push({ type: "prepaid_accounts", label: "선입금 계정", count: prepaidAccounts.count });
    if ((billingCycles?.count ?? 0) > 0) reasons.push({ type: "billing_cycles", label: "누적 청구", count: billingCycles.count });

    res.json({ canDelete: reasons.length === 0, reasons });
  } catch (err) {
    req.log.error({ err }, "Companies: failed to delete-check");
    res.status(500).json({ error: "삭제 가능 여부 확인 실패." });
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

    // 연결 데이터 검사
    const projectRows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(or(
        eq(projectsTable.companyId, companyId),
        eq(projectsTable.requestingCompanyId, companyId),
        eq(projectsTable.billingCompanyId, companyId),
        eq(projectsTable.payerCompanyId, companyId),
      ));
    const projectIds = projectRows.map(p => p.id);

    const [[contacts], [prepaidAccounts], [billingCycles]] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(contactsTable)
        .where(and(eq(contactsTable.companyId, companyId), eq(contactsTable.isActive, true))),
      db.select({ count: sql<number>`count(*)::int` }).from(prepaidAccountsTable).where(eq(prepaidAccountsTable.companyId, companyId)),
      db.select({ count: sql<number>`count(*)::int` }).from(billingBatchesTable).where(eq(billingBatchesTable.companyId, companyId)),
    ]);

    const blockingReasons: string[] = [];
    if ((contacts?.count ?? 0) > 0) blockingReasons.push(`담당자 ${contacts.count}건 존재`);
    if (projectIds.length > 0) blockingReasons.push(`프로젝트 ${projectIds.length}건 존재`);
    if ((prepaidAccounts?.count ?? 0) > 0) blockingReasons.push(`선입금 계정 ${prepaidAccounts.count}건 존재`);
    if ((billingCycles?.count ?? 0) > 0) blockingReasons.push(`누적 청구 ${billingCycles.count}건 존재`);

    if (blockingReasons.length > 0) {
      res.status(409).json({
        error: "삭제할 수 없습니다.",
        reasons: blockingReasons,
        canHardDelete: true,
      });
      return;
    }

    // 비활성 담당자, 부서, 상호이력 정리 후 삭제
    await db.delete(contactsTable).where(eq(contactsTable.companyId, companyId));
    await db.delete(divisionsTable).where(eq(divisionsTable.companyId, companyId));
    await db.delete(companyNameHistoryTable).where(eq(companyNameHistoryTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));

    await db.insert(logsTable).values({
      entityType: "company",
      entityId: companyId,
      action: "deleted",
      performedBy: req.user?.id ?? null,
      performedByEmail: req.user?.email ?? null,
      metadata: JSON.stringify({ name: existing.name }),
    });

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Companies: failed to delete");
    res.status(500).json({ error: "거래처 삭제 실패." });
  }
});

// ─── 거래처 완전삭제 (Hard Delete, 개발환경 전용) ─────────────────────────────
router.delete("/admin/companies/:id/hard", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) {
    res.status(400).json({ error: "유효하지 않은 company id." }); return;
  }

  // 운영 안전장치: ALLOW_HARD_DELETE=true 환경변수 없으면 차단
  if (process.env.ALLOW_HARD_DELETE !== "true") {
    req.log.warn({ companyId, user: req.user?.email }, "[HARD_DELETE_BLOCKED] ALLOW_HARD_DELETE not enabled");
    res.status(403).json({ error: "완전삭제는 개발 환경에서만 사용 가능합니다. (ALLOW_HARD_DELETE=true 설정 필요)" });
    return;
  }

  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "완전삭제는 관리자만 가능합니다." }); return;
  }

  try {
    const [existing] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!existing) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }

    req.log.warn({ companyId, companyName: existing.name, deletedBy: req.user?.email },
      "[HARD_DELETE_COMPANY] 완전삭제 시작");

    // 프로젝트 ID 수집
    const projectRows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(or(
        eq(projectsTable.companyId, companyId),
        eq(projectsTable.requestingCompanyId, companyId),
        eq(projectsTable.billingCompanyId, companyId),
        eq(projectsTable.payerCompanyId, companyId),
      ));
    const projectIds = projectRows.map(p => p.id);

    // 견적서 ID 수집 (quote_items 삭제용)
    let quoteIds: number[] = [];
    if (projectIds.length > 0) {
      const quoteRows = await db.select({ id: quotesTable.id }).from(quotesTable)
        .where(inArray(quotesTable.projectId, projectIds));
      quoteIds = quoteRows.map(q => q.id);
    }

    // 선입금 계정 ID 수집 (prepaid_ledger 삭제용)
    const prepaidRows = await db.select({ id: prepaidAccountsTable.id }).from(prepaidAccountsTable)
      .where(eq(prepaidAccountsTable.companyId, companyId));
    const prepaidIds = prepaidRows.map(p => p.id);

    // 누적 청구 ID 수집 (billing_batch_items 삭제용)
    const batchRows = await db.select({ id: billingBatchesTable.id }).from(billingBatchesTable)
      .where(eq(billingBatchesTable.companyId, companyId));
    const batchIds = batchRows.map(b => b.id);

    // 트랜잭션으로 FK 순서에 맞게 전체 삭제
    await db.transaction(async (tx) => {
      // 1. billing_batch_work_items, billing_batch_items (둘 다 billing_batches cascade)
      if (batchIds.length > 0) {
        await tx.delete(billingBatchWorkItemsTable).where(inArray(billingBatchWorkItemsTable.batchId, batchIds));
        await tx.delete(billingBatchItemsTable).where(inArray(billingBatchItemsTable.batchId, batchIds));
      }
      // 2. billing_batches
      await tx.delete(billingBatchesTable).where(eq(billingBatchesTable.companyId, companyId));

      // 4. prepaid_ledger (FK → prepaid_accounts, cascade이지만 명시적 삭제)
      if (prepaidIds.length > 0) {
        await tx.delete(prepaidLedgerTable).where(inArray(prepaidLedgerTable.accountId, prepaidIds));
      }
      // 5. prepaid_accounts
      await tx.delete(prepaidAccountsTable).where(eq(prepaidAccountsTable.companyId, companyId));

      if (projectIds.length > 0) {
        // 6. quote_item_files (FK → quote_items)
        if (quoteIds.length > 0) {
          const quoteItemRows = await tx.select({ id: quoteItemsTable.id }).from(quoteItemsTable)
            .where(inArray(quoteItemsTable.quoteId, quoteIds));
          const quoteItemIds = quoteItemRows.map(q => q.id);
          if (quoteItemIds.length > 0) {
            await tx.delete(quoteItemFilesTable).where(inArray(quoteItemFilesTable.quoteItemId, quoteItemIds));
          }
          // 7. quote_items
          await tx.delete(quoteItemsTable).where(inArray(quoteItemsTable.quoteId, quoteIds));
        }
        // 8. project_files
        await tx.delete(projectFilesTable).where(inArray(projectFilesTable.projectId, projectIds));
        // 9. settlements
        await tx.delete(settlementsTable).where(inArray(settlementsTable.projectId, projectIds));
        // 10. payments
        await tx.delete(paymentsTable).where(inArray(paymentsTable.projectId, projectIds));
        // 11. quotes
        await tx.delete(quotesTable).where(inArray(quotesTable.projectId, projectIds));
      }
      // 12. projects
      await tx.delete(projectsTable).where(or(
        eq(projectsTable.companyId, companyId),
        eq(projectsTable.requestingCompanyId, companyId),
        eq(projectsTable.billingCompanyId, companyId),
        eq(projectsTable.payerCompanyId, companyId),
      ));

      // 13. contacts
      await tx.delete(contactsTable).where(eq(contactsTable.companyId, companyId));
      // 14. divisions
      await tx.delete(divisionsTable).where(eq(divisionsTable.companyId, companyId));
      // 15. company_name_history
      await tx.delete(companyNameHistoryTable).where(eq(companyNameHistoryTable.companyId, companyId));
      // 16. company
      await tx.delete(companiesTable).where(eq(companiesTable.id, companyId));

      // 감사 로그
      await tx.insert(logsTable).values({
        entityType: "company",
        entityId: companyId,
        action: "hard_deleted",
        performedBy: req.user?.id ?? null,
        performedByEmail: req.user?.email ?? null,
        metadata: JSON.stringify({
          name: existing.name,
          projectCount: projectIds.length,
          quoteCount: quoteIds.length,
          prepaidCount: prepaidIds.length,
          batchCount: batchIds.length,
        }),
      });
    });

    req.log.warn({ companyId, companyName: existing.name, deletedBy: req.user?.email },
      "[HARD_DELETE_COMPANY] 완전삭제 완료");

    res.json({ ok: true, hardDelete: true, companyName: existing.name });
  } catch (err) {
    req.log.error({ err }, "Companies: hard delete failed");
    res.status(500).json({ error: "완전삭제 실패. 트랜잭션이 롤백되었습니다." });
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

// ─── 거래처 기업명 Alias(별칭) CRUD ──────────────────────────────────────────
// 1:N. 중복판정·검색은 normalizedAlias 기준. 기존 거래처 API 는 변경하지 않는다.

// 목록
router.get("/admin/companies/:id/aliases", ...adminGuard, async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 company id." }); return; }
  try {
    const rows = await db.select().from(companyAliasesTable)
      .where(eq(companyAliasesTable.companyId, companyId))
      .orderBy(desc(companyAliasesTable.isPrimary), companyAliasesTable.id);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Aliases: failed to list");
    res.status(500).json({ error: "별칭 조회 실패." });
  }
});

// 등록
router.post("/admin/companies/:id/aliases", ...adminGuard, requirePermission("company.create"), async (req, res) => {
  const companyId = Number(req.params.id);
  if (isNaN(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 company id." }); return; }
  const aliasName = ((req.body as any)?.aliasName ?? "").toString().trim();
  if (!aliasName) { res.status(400).json({ error: "별칭을 입력해주세요." }); return; }
  const normalizedAlias = normalizeCompanyName(aliasName);
  if (!normalizedAlias) { res.status(400).json({ error: "유효한 별칭이 아닙니다." }); return; }
  try {
    // 거래처 존재 확인
    const [company] = await db.select({ id: companiesTable.id }).from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }
    // 동일 거래처 내 normalizedAlias 중복 방지(§7)
    const [dup] = await db.select({ id: companyAliasesTable.id }).from(companyAliasesTable)
      .where(and(eq(companyAliasesTable.companyId, companyId), eq(companyAliasesTable.normalizedAlias, normalizedAlias)));
    if (dup) { res.status(409).json({ error: "이미 등록된 별칭입니다." }); return; }
    const [created] = await db.insert(companyAliasesTable)
      .values(buildAliasValues(companyId, aliasName, false)).returning();
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Aliases: failed to create");
    res.status(500).json({ error: "별칭 등록 실패." });
  }
});

// 수정
router.put("/admin/companies/:id/aliases/:aliasId", ...adminGuard, requirePermission("company.create"), async (req, res) => {
  const companyId = Number(req.params.id);
  const aliasId = Number(req.params.aliasId);
  if (isNaN(companyId) || companyId <= 0 || isNaN(aliasId) || aliasId <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  const aliasName = ((req.body as any)?.aliasName ?? "").toString().trim();
  if (!aliasName) { res.status(400).json({ error: "별칭을 입력해주세요." }); return; }
  const normalizedAlias = normalizeCompanyName(aliasName);
  if (!normalizedAlias) { res.status(400).json({ error: "유효한 별칭이 아닙니다." }); return; }
  try {
    const [existing] = await db.select().from(companyAliasesTable)
      .where(and(eq(companyAliasesTable.id, aliasId), eq(companyAliasesTable.companyId, companyId)));
    if (!existing) { res.status(404).json({ error: "별칭을 찾을 수 없습니다." }); return; }
    // 자기 자신을 제외한 동일 거래처 내 중복 방지(§7)
    const [dup] = await db.select({ id: companyAliasesTable.id }).from(companyAliasesTable)
      .where(and(
        eq(companyAliasesTable.companyId, companyId),
        eq(companyAliasesTable.normalizedAlias, normalizedAlias),
        ne(companyAliasesTable.id, aliasId),
      ));
    if (dup) { res.status(409).json({ error: "이미 등록된 별칭입니다." }); return; }
    const [updated] = await db.update(companyAliasesTable)
      .set({ aliasName, normalizedAlias, updatedAt: new Date() })
      .where(eq(companyAliasesTable.id, aliasId)).returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Aliases: failed to update");
    res.status(500).json({ error: "별칭 수정 실패." });
  }
});

// 삭제
router.delete("/admin/companies/:id/aliases/:aliasId", ...adminGuard, requirePermission("company.create"), async (req, res) => {
  const companyId = Number(req.params.id);
  const aliasId = Number(req.params.aliasId);
  if (isNaN(companyId) || companyId <= 0 || isNaN(aliasId) || aliasId <= 0) { res.status(400).json({ error: "유효하지 않은 id." }); return; }
  try {
    const [existing] = await db.select({ id: companyAliasesTable.id }).from(companyAliasesTable)
      .where(and(eq(companyAliasesTable.id, aliasId), eq(companyAliasesTable.companyId, companyId)));
    if (!existing) { res.status(404).json({ error: "별칭을 찾을 수 없습니다." }); return; }
    await db.delete(companyAliasesTable).where(eq(companyAliasesTable.id, aliasId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Aliases: failed to delete");
    res.status(500).json({ error: "별칭 삭제 실패." });
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
    const { keyword, companyId: companyIdQ, includeInactive } = req.query as {
      keyword?: string; companyId?: string; includeInactive?: string;
    };

    const conds: ReturnType<typeof eq>[] = [];
    if (companyIdQ) conds.push(eq(contactsTable.companyId, Number(companyIdQ)));
    // 기본: 활성 담당자만 표시. includeInactive=true 시 전체 표시.
    if (includeInactive !== "true") conds.push(eq(contactsTable.isActive, true));

    // ── opt-in 서버 페이지네이션: page 파라미터가 있을 때만. 없으면 레거시(배열) 응답 유지 ──
    if (req.query.page !== undefined) {
      const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
      const allowedSizes = [20, 30, 50, 100];
      let pageSize = parseInt(String(req.query.pageSize ?? "20"), 10) || 20;
      if (!allowedSizes.includes(pageSize)) pageSize = 20;
      const offset = (page - 1) * pageSize;

      const s = keyword?.trim().toLowerCase();
      const allConds: any[] = [...conds];
      if (s) {
        const digits = s.replace(/\D/g, "");
        const kc: any[] = [
          ilike(contactsTable.name, `%${s}%`),
          ilike(contactsTable.email, `%${s}%`),
          ilike(contactsTable.mobile, `%${s}%`),
          ilike(contactsTable.officePhone, `%${s}%`),
          ilike(contactsTable.phone, `%${s}%`),
          ilike(companiesTable.name, `%${s}%`),
        ];
        if (digits) {
          kc.push(sql`regexp_replace(coalesce(${contactsTable.mobile},''),'[^0-9]','','g') LIKE ${"%" + digits + "%"}`);
          kc.push(sql`regexp_replace(coalesce(${contactsTable.officePhone},''),'[^0-9]','','g') LIKE ${"%" + digits + "%"}`);
          kc.push(sql`regexp_replace(coalesce(${contactsTable.phone},''),'[^0-9]','','g') LIKE ${"%" + digits + "%"}`);
        }
        allConds.push(or(...kc));
      }
      const whereAll = allConds.length ? and(...allConds) : undefined;

      const [{ cnt: total }] = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(contactsTable)
        .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
        .where(whereAll);

      const pageRows = await db
        .select({
          id: contactsTable.id, companyId: contactsTable.companyId, divisionId: contactsTable.divisionId,
          name: contactsTable.name, department: contactsTable.department, position: contactsTable.position,
          email: contactsTable.email, phone: contactsTable.phone, mobile: contactsTable.mobile,
          officePhone: contactsTable.officePhone, notes: contactsTable.notes, memo: contactsTable.memo,
          isPrimary: contactsTable.isPrimary, isQuoteContact: contactsTable.isQuoteContact,
          isBillingContact: contactsTable.isBillingContact, isActive: contactsTable.isActive,
          registeredAt: contactsTable.registeredAt,
          createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
          companyName: companiesTable.name,
          divisionName: divisionsTable.name,
        })
        .from(contactsTable)
        .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
        .leftJoin(divisionsTable, eq(contactsTable.divisionId, divisionsTable.id))
        .where(whereAll)
        .orderBy(desc(contactsTable.isPrimary), contactsTable.name, desc(contactsTable.id))
        .limit(pageSize)
        .offset(offset);

      res.json({ rows: pageRows, total, page, pageSize });
      return;
    }

    const rows = await db
      .select({
        id: contactsTable.id, companyId: contactsTable.companyId, divisionId: contactsTable.divisionId,
        name: contactsTable.name, department: contactsTable.department, position: contactsTable.position,
        email: contactsTable.email, phone: contactsTable.phone, mobile: contactsTable.mobile,
        officePhone: contactsTable.officePhone, notes: contactsTable.notes, memo: contactsTable.memo,
        isPrimary: contactsTable.isPrimary, isQuoteContact: contactsTable.isQuoteContact,
        isBillingContact: contactsTable.isBillingContact, isActive: contactsTable.isActive,
        registeredAt: contactsTable.registeredAt,
        createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
        companyName: companiesTable.name,
        divisionName: divisionsTable.name,
      })
      .from(contactsTable)
      .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
      .leftJoin(divisionsTable, eq(contactsTable.divisionId, divisionsTable.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(contactsTable.isPrimary), contactsTable.name);

    let result = rows;
    if (keyword?.trim()) {
      const s = keyword.trim().toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(s) ||
        (c.email ?? "").toLowerCase().includes(s) ||
        (c.mobile ?? "").replace(/-/g, "").includes(s.replace(/-/g, "")) ||
        (c.mobile ?? "").toLowerCase().includes(s) ||
        (c.officePhone ?? "").replace(/-/g, "").includes(s.replace(/-/g, "")) ||
        (c.officePhone ?? "").toLowerCase().includes(s) ||
        (c.phone ?? "").replace(/-/g, "").includes(s.replace(/-/g, "")) ||
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
    force,
  } = req.body as {
    name?: string; department?: string; position?: string; email?: string; phone?: string;
    mobile?: string; officePhone?: string; notes?: string; memo?: string;
    isPrimary?: boolean; isQuoteContact?: boolean; isBillingContact?: boolean; isActive?: boolean;
    divisionId?: number | null; force?: boolean;
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

  // divisionId가 있을 경우 해당 거래처 소속인지 검증
  if (divisionId) {
    const [div] = await db.select({ id: divisionsTable.id }).from(divisionsTable)
      .where(and(eq(divisionsTable.id, Number(divisionId)), eq(divisionsTable.companyId, targetCompanyId)));
    if (!div) { res.status(400).json({ error: "선택한 브랜드/부서가 해당 거래처에 속하지 않습니다." }); return; }
  }

  // ── 정규화 ────────────────────────────────────────────────────────────────
  const normalizedMobile = mobile?.trim() ? mobile.replace(/\D/g, "") : null;
  const normalizedEmail  = email?.trim()  ? email.trim().toLowerCase()  : null;

  // ① 휴대폰 중복 검사 (강제 차단 — force 플래그 무시)
  if (normalizedMobile) {
    const activeMobiles = await db
      .select({ id: contactsTable.id, name: contactsTable.name, mobile: contactsTable.mobile })
      .from(contactsTable)
      .where(and(eq(contactsTable.companyId, targetCompanyId), eq(contactsTable.isActive, true)));

    const mobileConflict = activeMobiles.find(
      c => c.mobile && c.mobile.replace(/\D/g, "") === normalizedMobile,
    );
    if (mobileConflict) {
      res.status(409).json({
        error: `이미 동일한 휴대폰 번호의 담당자가 존재합니다. (${mobileConflict.name})`,
        duplicateContact: { id: mobileConflict.id, name: mobileConflict.name },
      });
      return;
    }
  }

  // ② 이메일 / ③ 이름 중복 경고 (force=true 이면 건너뜀)
  if (!force) {
    const warnings: string[] = [];
    let duplicateContact: { id: number; name: string } | null = null;

    if (normalizedEmail) {
      const [emailDup] = await db
        .select({ id: contactsTable.id, name: contactsTable.name })
        .from(contactsTable)
        .where(and(
          eq(contactsTable.companyId, targetCompanyId),
          sql`lower(${contactsTable.email}) = ${normalizedEmail}`,
          eq(contactsTable.isActive, true),
        ));
      if (emailDup) {
        warnings.push(`동일한 이메일을 사용하는 담당자가 이미 존재합니다. (${emailDup.name})`);
        duplicateContact = emailDup;
      }
    }

    const [nameDup] = await db
      .select({ id: contactsTable.id, name: contactsTable.name })
      .from(contactsTable)
      .where(and(
        eq(contactsTable.companyId, targetCompanyId),
        eq(contactsTable.name, name.trim()),
        eq(contactsTable.isActive, true),
      ));
    if (nameDup) {
      warnings.push(`동일한 이름의 담당자가 이미 존재합니다. (${nameDup.name}) 동명이인 여부를 확인하세요.`);
      if (!duplicateContact) duplicateContact = nameDup;
    }

    if (warnings.length > 0) {
      res.status(200).json({ warning: true, message: warnings.join(" / "), warnings, duplicateContact });
      return;
    }

    // ④ 다른 거래처 동일 휴대폰/이메일 검사 (cross-company)
    if (normalizedMobile || normalizedEmail) {
      const orParts: ReturnType<typeof sql>[] = [];
      if (normalizedMobile) {
        orParts.push(sql`regexp_replace(${contactsTable.mobile}, '[^0-9]', '', 'g') = ${normalizedMobile}`);
      }
      if (normalizedEmail) {
        orParts.push(sql`lower(${contactsTable.email}) = ${normalizedEmail}`);
      }
      const crossDups = await db
        .select({
          id: contactsTable.id,
          name: contactsTable.name,
          mobile: contactsTable.mobile,
          email: contactsTable.email,
          companyName: companiesTable.name,
        })
        .from(contactsTable)
        .innerJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
        .where(and(
          ne(contactsTable.companyId, targetCompanyId),
          eq(contactsTable.isActive, true),
          orParts.length === 1 ? orParts[0] : or(...orParts),
        ));
      if (crossDups.length > 0) {
        res.status(200).json({
          warning: true,
          type: "cross_company_duplicate",
          message: "다른 거래처에 동일한 휴대폰 또는 이메일을 가진 담당자가 존재합니다.",
          duplicates: crossDups.map(c => ({
            id: c.id, name: c.name, companyName: c.companyName,
            mobile: c.mobile, email: c.email,
          })),
        });
        return;
      }
    }
  }

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
      email: normalizedEmail,
      phone: phone?.trim() || null,
      mobile: normalizedMobile,
      officePhone: officePhone?.trim() || null,
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
        registeredAt: contactsTable.registeredAt,
        createdAt: contactsTable.createdAt, updatedAt: contactsTable.updatedAt,
        companyName: companiesTable.name,
        divisionName: divisionsTable.name,
      })
      .from(contactsTable)
      .leftJoin(companiesTable, eq(contactsTable.companyId, companiesTable.id))
      .leftJoin(divisionsTable, eq(contactsTable.divisionId, divisionsTable.id))
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

  // divisionId가 있을 경우 해당 거래처 소속인지 검증
  if (divisionId) {
    const [div] = await db.select({ id: divisionsTable.id }).from(divisionsTable)
      .where(and(eq(divisionsTable.id, Number(divisionId)), eq(divisionsTable.companyId, existing.companyId)));
    if (!div) { res.status(400).json({ error: "선택한 브랜드/부서가 해당 거래처에 속하지 않습니다." }); return; }
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

// ─── 담당자 삭제 (항상 soft delete) ─────────────────────────────────────────
async function deleteContact(req: any, res: any, contactId: number) {
  const [existing] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactId));
  if (!existing) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }

  await db.update(contactsTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(contactsTable.id, contactId));

  await logEvent("company", existing.companyId, "company_contact_deleted", undefined, (req as any).user?.id,
    JSON.stringify({ contactId, name: existing.name, companyId: existing.companyId }));

  res.json({ ok: true, softDeleted: true });
}

// ─── 담당자 완전삭제 (Permanent Delete) ──────────────────────────────────────
router.delete("/admin/contacts/:id/permanent", ...adminGuard, async (req, res) => {
  const contactId = Number(req.params.id);
  if (isNaN(contactId) || contactId <= 0) {
    res.status(400).json({ error: "유효하지 않은 contact id." }); return;
  }
  try {
    const [existing] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactId));
    if (!existing) { res.status(404).json({ error: "담당자를 찾을 수 없습니다." }); return; }

    // 연결된 프로젝트 확인
    const [projectCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectsTable)
      .where(eq(projectsTable.contactId, contactId));
    if ((projectCount?.count ?? 0) > 0) {
      res.status(409).json({
        error: "이 담당자는 프로젝트/견적/청구 이력이 있어 완전삭제할 수 없습니다. 비활성 처리만 가능합니다.",
        reason: "projects",
        count: projectCount.count,
      }); return;
    }

    // 완전삭제 실행
    await db.delete(contactsTable).where(eq(contactsTable.id, contactId));

    await logEvent("company", existing.companyId, "company_contact_permanent_deleted",
      undefined, (req as any).user?.id,
      JSON.stringify({ contactId, name: existing.name, companyId: existing.companyId }));

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Contacts: failed to permanent delete");
    res.status(500).json({ error: "담당자 완전삭제 중 오류가 발생했습니다." });
  }
});

// ─── 담당자 통합 ──────────────────────────────────────────────────────────────
router.post("/admin/contacts/merge", ...adminGuard, requirePermission("contact.update"), async (req, res) => {
  const { primaryContactId, mergeContactIds } = req.body as {
    primaryContactId?: number;
    mergeContactIds?: number[];
  };

  if (!primaryContactId || !Array.isArray(mergeContactIds) || mergeContactIds.length === 0) {
    res.status(400).json({ error: "primaryContactId와 mergeContactIds(배열)가 필요합니다." });
    return;
  }
  if (mergeContactIds.includes(primaryContactId)) {
    res.status(400).json({ error: "대표 담당자가 통합 대상에 포함될 수 없습니다." });
    return;
  }

  try {
    const allIds = [primaryContactId, ...mergeContactIds];
    const rows = await db
      .select({ id: contactsTable.id, companyId: contactsTable.companyId, name: contactsTable.name })
      .from(contactsTable)
      .where(inArray(contactsTable.id, allIds));

    if (rows.length !== allIds.length) {
      res.status(404).json({ error: "존재하지 않는 담당자가 포함되어 있습니다." });
      return;
    }

    const companyIds = [...new Set(rows.map(r => r.companyId))];
    if (companyIds.length > 1) {
      res.status(400).json({ error: "통합할 담당자들이 같은 거래처에 속해야 합니다." });
      return;
    }

    const primaryRow = rows.find(r => r.id === primaryContactId)!;
    const companyId = primaryRow.companyId;

    await db.transaction(async (tx) => {
      // 연결 테이블(projects.contactId) → primaryContactId로 변경
      if (mergeContactIds.length > 0) {
        await tx.update(projectsTable)
          .set({ contactId: primaryContactId })
          .where(inArray(projectsTable.contactId, mergeContactIds));
      }

      // 통합 대상 담당자 비활성화
      await tx.update(contactsTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(inArray(contactsTable.id, mergeContactIds));
    });

    const mergedNames = rows.filter(r => mergeContactIds.includes(r.id)).map(r => r.name);

    await logEvent("company", companyId, "company_contact_merged", undefined, (req as any).user?.id,
      JSON.stringify({
        primaryContactId,
        mergedContactIds: mergeContactIds,
        mergedNames,
        primaryName: primaryRow.name,
        companyId,
        reason: "duplicate_contact_merge",
      }));

    res.json({ ok: true, primaryContactId, mergedContactIds: mergeContactIds, mergedNames });
  } catch (err: any) {
    console.error("[Admin] 담당자 통합 실패:", err);
    res.status(500).json({ error: "담당자 통합에 실패했습니다.", detail: err?.message });
  }
});

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

// ─── 담당자 명함/이메일서명 AI 분석 (companies.ts 에 직접 등록 — 별도 라우터 파일 불필요) ──
console.log("[CONTACT-OCR-REGISTERED] POST /api/admin/contacts/document-analyze-upload ready ✓");

const _contactOcrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = nodePath.extname(file.originalname).toLowerCase();
    if (isOcrSupportedExt(ext) || ["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("JPG, PNG, PDF 형식만 분석할 수 있습니다."));
    }
  },
});

function _sendContactOcrError(res: Response, status: number, error: string) {
  res.status(status).json({ error, message: error });
}

const CONTACT_CARD_SYSTEM_PROMPT = `당신은 명함, 이메일 서명, 연락처 이미지에서 담당자 정보를 추출하는 AI 도우미입니다.
이미지에서 명확하게 식별 가능한 정보만 추출하고, 추측하거나 임의로 생성하지 마세요.
다음 JSON 스키마로만 응답하세요:
{"name": string|null, "companyName": string|null, "department": string|null, "position": string|null, "email": string|null, "mobile": string|null, "officePhone": string|null, "memo": string|null, "confidence": "high"|"medium"|"low", "notes": string|null}
- name: 담당자 이름 (한글 또는 영문)
- companyName: 회사명/브랜드명 (명함에 표시된 그대로)
- department: 부서명 (팀, 본부, 사업부 포함)
- position: 직책/직위 (예: 과장, Manager, 팀장, 대리)
- email: 이메일 주소
- mobile: 휴대폰 번호 (숫자와 하이픈만. 예: "010-1234-5678"). Cell, Mobile, HP 등 표시 우선
- officePhone: 직장 전화번호 (숫자와 하이픈만. 예: "02-1234-5678"). Tel, 대표번호, 직통번호 포함
- memo: 위 항목 외 추가 정보 (SNS, 웹사이트, 기타 메모). 없으면 null
- confidence: 이미지 품질과 추출 확신도 ("high"=명확, "medium"=일부 불명확, "low"=대부분 불명확)
- notes: 흐릿함, 일부 가려짐 등 특이사항. 없으면 null
명함/서명이 아니거나 정보를 읽을 수 없으면 모든 필드를 null로, confidence는 "low"로 응답하세요.`;

// POST /api/admin/contacts/document-analyze-upload
router.post(
  "/admin/contacts/document-analyze-upload",
  ...adminGuard,
  _contactOcrUpload.single("file"),
  async (req, res) => {
    console.log(`[CONTACT-OCR] HIT method=${req.method} originalUrl=${req.originalUrl} file=${req.file?.originalname ?? "없음"} ct="${(req.headers["content-type"] ?? "").slice(0, 80)}"`);
    if (!req.file) { _sendContactOcrError(res, 400, "파일이 없습니다. (필드명: file)"); return; }

    const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const ext = nodePath.extname(originalName).toLowerCase();
    if (!isOcrSupportedExt(ext)) {
      _sendContactOcrError(res, 422, "AI 분석은 JPG, PNG, PDF 형식만 지원합니다.");
      return;
    }

    try {
      const rawBuffer = req.file.buffer;
      let buffer: Buffer;
      let ocrExt: string;
      if (ext === ".pdf") {
        buffer = await renderPdfFirstPageAsPng(rawBuffer);
        ocrExt = ".png";
      } else {
        buffer = rawBuffer;
        ocrExt = ext;
      }

      const imageDataUrl = buildImageDataUrl(buffer, ocrExt);

      const openaiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
      if (!openaiApiKey) {
        req.log.error("AI_INTEGRATIONS_OPENAI_API_KEY 미설정");
        _sendContactOcrError(res, 500, "AI 분석을 사용할 수 없습니다. (OpenAI API 키 미설정)");
        return;
      }

      const openaiClient = new OpenAI({
        apiKey: openaiApiKey,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: [
          { role: "system", content: CONTACT_CARD_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "이 이미지에서 담당자 정보를 추출해 JSON으로 응답하세요." },
              { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
            ],
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      let result: Record<string, unknown> = {};
      let jsonParseFailed = false;
      try { result = JSON.parse(raw); } catch { result = {}; jsonParseFailed = true; }

      res.json({
        extracted: {
          name:        (result.name as string) ?? null,
          companyName: (result.companyName as string) ?? null,
          department:  (result.department as string) ?? null,
          position:    (result.position as string) ?? null,
          email:       (result.email as string) ?? null,
          mobile:      (result.mobile as string) ?? null,
          officePhone: (result.officePhone as string) ?? null,
          memo:        (result.memo as string) ?? null,
        },
        confidence: (result.confidence as "high" | "medium" | "low") ?? "low",
        notes: (result.notes as string) ?? null,
        _debug: { fileName: originalName, sourceExt: ext, ocrExt, pdfConverted: ext === ".pdf", aiCalled: true, jsonParseFailed },
      });
    } catch (err) {
      req.log.error({ err }, "담당자 명함 OCR 분석 실패");
      _sendContactOcrError(res, 500, "담당자 정보 AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    }
  },
);

export default router;
