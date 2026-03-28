import { Router, type IRouter } from "express";
import {
  db, projectsTable, paymentsTable, tasksTable, usersTable,
  logsTable, quotesTable, settlementsTable, notesTable,
  customersTable, communicationsTable, translatorProfilesTable,
  contactsTable, companiesTable, translatorRatesTable, divisionsTable,
  quoteItemsTable, calcQuoteItemAmounts,
  billingBatchesTable, billingBatchItemsTable, billingBatchWorkItemsTable,
  prepaidAccountsTable, prepaidLedgerTable,
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, and, ne, ilike, or, gte, lte, inArray, sql, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

// ─── 프로젝트 목록 (검색/필터) ────────────────────────────────────────────
router.get("/admin/projects", ...adminGuard, async (req, res) => {
  try {
    const {
      search, status, financialStatus: financialStatusFilter, dateFrom, dateTo, assignedAdminId, companyName, contactName,
      companyId: companyIdFilter, contactId: contactIdFilter,
      quoteType: quoteTypeFilter, billingType: billingTypeFilter,
      paymentDueDateFrom, paymentDueDateTo, quickFilter,
    } = req.query as {
      search?: string; status?: string; financialStatus?: string; dateFrom?: string; dateTo?: string;
      assignedAdminId?: string; companyName?: string; contactName?: string;
      companyId?: string; contactId?: string;
      quoteType?: string; billingType?: string;
      paymentDueDateFrom?: string; paymentDueDateTo?: string;
      quickFilter?: string;
    };

    const contactAlias = db
      .select({ id: contactsTable.id, name: contactsTable.name, companyId: contactsTable.companyId })
      .from(contactsTable).as("proj_contact");
    const companyAlias = db
      .select({ id: companiesTable.id, name: companiesTable.name })
      .from(companiesTable).as("proj_company");

    // 메인 프로젝트 쿼리
    const rows = await db
      .select({
        id: projectsTable.id, title: projectsTable.title, status: projectsTable.status,
        financialStatus: projectsTable.financialStatus,
        fileUrl: projectsTable.fileUrl, createdAt: projectsTable.createdAt,
        customerEmail: usersTable.email, customerId: usersTable.id,
        projectCustomerId: projectsTable.customerId, adminId: projectsTable.adminId,
        contactId: projectsTable.contactId, companyId: projectsTable.companyId,
        requestingCompanyId: projectsTable.requestingCompanyId,
        requestingDivisionId: projectsTable.requestingDivisionId,
        billingCompanyId: projectsTable.billingCompanyId,
        payerCompanyId: projectsTable.payerCompanyId,
        contactName: contactAlias.name, companyName: companyAlias.name,
        divisionName: sql<string | null>`(SELECT name FROM divisions WHERE id = ${projectsTable.requestingDivisionId})`,
        billingCompanyName: sql<string | null>`(SELECT name FROM companies WHERE id = ${projectsTable.billingCompanyId})`,
        payerCompanyName: sql<string | null>`(SELECT name FROM companies WHERE id = ${projectsTable.payerCompanyId})`,
        requestingCompanyName: sql<string | null>`(SELECT name FROM companies WHERE id = ${projectsTable.requestingCompanyId})`,
      })
      .from(projectsTable)
      .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
      .leftJoin(contactAlias, eq(projectsTable.contactId, contactAlias.id))
      .leftJoin(companyAlias, eq(projectsTable.companyId, companyAlias.id))
      .orderBy(projectsTable.createdAt);

    // 프로젝트별 최신 견적 매핑
    const quoteRows = await db
      .select({
        projectId: quotesTable.projectId, id: quotesTable.id,
        quoteType: quotesTable.quoteType, billingType: quotesTable.billingType,
        paymentDueDate: quotesTable.paymentDueDate, price: quotesTable.price, status: quotesTable.status,
      })
      .from(quotesTable).orderBy(desc(quotesTable.id));
    const latestQuoteByProject = new Map<number, typeof quoteRows[0]>();
    for (const q of quoteRows) {
      if (q.projectId != null && !latestQuoteByProject.has(q.projectId)) {
        latestQuoteByProject.set(q.projectId, q);
      }
    }

    // 결제 완료 프로젝트 ID 세트
    const paidRows = await db.select({ projectId: paymentsTable.projectId })
      .from(paymentsTable).where(eq(paymentsTable.status, "paid"));
    const paidProjectIds = new Set(paidRows.map(p => p.projectId));

    // 프로젝트 + 견적 + 결제 데이터 병합
    let result = rows.reverse().map(p => ({
      ...p,
      quoteType: latestQuoteByProject.get(p.id)?.quoteType ?? null,
      billingType: latestQuoteByProject.get(p.id)?.billingType ?? null,
      paymentDueDate: latestQuoteByProject.get(p.id)?.paymentDueDate ?? null,
      quotePrice: latestQuoteByProject.get(p.id)?.price ?? null,
      quoteStatus: latestQuoteByProject.get(p.id)?.status ?? null,
      hasQuote: latestQuoteByProject.has(p.id),
      hasPaid: paidProjectIds.has(p.id),
    }));

    // ── 기존 필터 ──
    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(p =>
        p.title.toLowerCase().includes(s) ||
        (p.customerEmail ?? "").toLowerCase().includes(s) ||
        (p.contactName ?? "").toLowerCase().includes(s) ||
        (p.companyName ?? "").toLowerCase().includes(s)
      );
    }
    if (companyName?.trim()) {
      const cn = companyName.trim().toLowerCase();
      result = result.filter(p => (p.companyName ?? "").toLowerCase().includes(cn));
    }
    if (contactName?.trim()) {
      const ct = contactName.trim().toLowerCase();
      result = result.filter(p => (p.contactName ?? "").toLowerCase().includes(ct));
    }
    if (status?.trim()) {
      const statuses = status.split(",").map(s => s.trim()).filter(Boolean);
      if (statuses.length > 0) result = result.filter(p => statuses.includes(p.status));
    }
    if (financialStatusFilter?.trim() && financialStatusFilter !== "all") {
      result = result.filter(p => p.financialStatus === financialStatusFilter);
    }
    if (dateFrom?.trim()) {
      const from = new Date(dateFrom);
      if (!isNaN(from.getTime())) result = result.filter(p => new Date(p.createdAt) >= from);
    }
    if (dateTo?.trim()) {
      const to = new Date(dateTo);
      if (!isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        result = result.filter(p => new Date(p.createdAt) <= to);
      }
    }
    if (assignedAdminId?.trim()) {
      const adminIdNum = Number(assignedAdminId);
      if (!isNaN(adminIdNum)) result = result.filter(p => p.adminId === adminIdNum);
    }

    // ── 신규 필터 ──
    if (companyIdFilter?.trim()) {
      const cid = Number(companyIdFilter);
      if (!isNaN(cid)) result = result.filter(p => p.companyId === cid);
    }
    if (contactIdFilter?.trim()) {
      const ctid = Number(contactIdFilter);
      if (!isNaN(ctid)) result = result.filter(p => p.contactId === ctid);
    }
    if (quoteTypeFilter?.trim() && quoteTypeFilter !== "all") {
      result = result.filter(p => p.quoteType === quoteTypeFilter);
    }
    if (billingTypeFilter?.trim() && billingTypeFilter !== "all") {
      result = result.filter(p => p.billingType === billingTypeFilter);
    }
    if (paymentDueDateFrom?.trim()) {
      const from = new Date(paymentDueDateFrom);
      if (!isNaN(from.getTime()))
        result = result.filter(p => p.paymentDueDate != null && new Date(p.paymentDueDate as string) >= from);
    }
    if (paymentDueDateTo?.trim()) {
      const to = new Date(paymentDueDateTo);
      if (!isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        result = result.filter(p => p.paymentDueDate != null && new Date(p.paymentDueDate as string) <= to);
      }
    }

    // ── 빠른 필터 ──
    if (quickFilter === "prepaid_deduction") {
      result = result.filter(p => p.quoteType === "prepaid_deduction");
    } else if (quickFilter === "accumulated_in_progress") {
      result = result.filter(p => p.quoteType === "accumulated_batch" && !p.hasPaid);
    } else if (quickFilter === "unbilled") {
      result = result.filter(p => !p.hasQuote);
    } else if (quickFilter === "unpaid") {
      result = result.filter(p => p.hasQuote && !p.hasPaid && !["cancelled", "created"].includes(p.status));
    } else if (quickFilter === "has_prepaid_balance") {
      // 거래처별 선입금 잔액 계산
      const prepaidQ = await db.select({
        projectId: quotesTable.projectId, prepaidBalanceAfter: quotesTable.prepaidBalanceAfter,
      }).from(quotesTable)
        .where(inArray(quotesTable.quoteType as any, ["b2c_prepaid", "prepaid_deduction"]))
        .orderBy(desc(quotesTable.id));
      const projMap = new Map(result.map(p => [p.id, p.companyId]));
      const compBalanceMap = new Map<number, number>();
      for (const q of prepaidQ) {
        if (q.projectId == null || q.prepaidBalanceAfter == null) continue;
        const cid = projMap.get(q.projectId);
        if (cid == null || compBalanceMap.has(cid)) continue;
        compBalanceMap.set(cid, Number(q.prepaidBalanceAfter));
      }
      result = result.filter(p => p.companyId != null && (compBalanceMap.get(p.companyId!) ?? 0) > 0);
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch projects");
    res.status(500).json({ error: "프로젝트 조회 실패." });
  }
});

// ─── 프로젝트 상세 ─────────────────────────────────────────────────────────
router.get("/admin/projects/:id", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const translatorUserAlias = db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .as("trans_user");

    const [project] = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        financialStatus: projectsTable.financialStatus,
        fileUrl: projectsTable.fileUrl,
        createdAt: projectsTable.createdAt,
        customerEmail: usersTable.email,
        customerId: usersTable.id,
        contactId: projectsTable.contactId,
        companyId: projectsTable.companyId,
        adminId: projectsTable.adminId,
        requestingCompanyId: projectsTable.requestingCompanyId,
        requestingDivisionId: projectsTable.requestingDivisionId,
        billingCompanyId: projectsTable.billingCompanyId,
        payerCompanyId: projectsTable.payerCompanyId,
        divisionName: sql<string | null>`(SELECT name FROM divisions WHERE id = ${projectsTable.requestingDivisionId})`,
        billingCompanyName: sql<string | null>`(SELECT name FROM companies WHERE id = ${projectsTable.billingCompanyId})`,
        payerCompanyName: sql<string | null>`(SELECT name FROM companies WHERE id = ${projectsTable.payerCompanyId})`,
        requestingCompanyName: sql<string | null>`(SELECT name FROM companies WHERE id = ${projectsTable.requestingCompanyId})`,
      })
      .from(projectsTable)
      .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    const [quotes, payments, rawTasks, settlements, logs, notes, communications] = await Promise.all([
      db.select().from(quotesTable).where(eq(quotesTable.projectId, projectId)),
      db.select().from(paymentsTable).where(eq(paymentsTable.projectId, projectId)),
      db
        .select({
          id: tasksTable.id,
          translatorId: tasksTable.translatorId,
          status: tasksTable.status,
          createdAt: tasksTable.createdAt,
          translatorEmail: translatorUserAlias.email,
        })
        .from(tasksTable)
        .leftJoin(translatorUserAlias, eq(tasksTable.translatorId, translatorUserAlias.id))
        .where(eq(tasksTable.projectId, projectId)),
      db.select().from(settlementsTable).where(eq(settlementsTable.projectId, projectId)),
      db.select().from(logsTable).where(eq(logsTable.entityId, projectId)).orderBy(logsTable.createdAt),
      db
        .select({
          id: notesTable.id,
          content: notesTable.content,
          createdAt: notesTable.createdAt,
          adminEmail: usersTable.email,
        })
        .from(notesTable)
        .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
        .where(and(eq(notesTable.entityType, "project"), eq(notesTable.entityId, projectId)))
        .orderBy(notesTable.createdAt),
      db
        .select()
        .from(communicationsTable)
        .where(eq(communicationsTable.projectId, projectId))
        .orderBy(communicationsTable.createdAt),
    ]);

    // 거래처 + 담당자
    let company: (typeof companiesTable.$inferSelect & { prepaidBalance: number | null; prepaidTotalDeposited: number; prepaidTotalUsed: number }) | null = null;
    let contact = null;
    if (project.companyId) {
      const [c] = await db.select().from(companiesTable).where(eq(companiesTable.id, project.companyId));
      if (c) {
        // 해당 거래처 전체 프로젝트 ID
        const companyProjects = await db
          .select({ id: projectsTable.id })
          .from(projectsTable)
          .where(eq(projectsTable.companyId, project.companyId));
        const companyProjectIds = companyProjects.map(p => p.id);

        // 최신 선입금 잔액 (prepaid_balance_after 기준)
        const [lastPrepaidQuote] = await db
          .select({ prepaidBalanceAfter: quotesTable.prepaidBalanceAfter })
          .from(quotesTable)
          .innerJoin(projectsTable, eq(quotesTable.projectId, projectsTable.id))
          .where(and(
            eq(projectsTable.companyId, project.companyId),
            sql`${quotesTable.quoteType} IN ('prepaid_deduction', 'b2c_prepaid')`
          ))
          .orderBy(desc(quotesTable.id))
          .limit(1);
        const prepaidBalance = lastPrepaidQuote?.prepaidBalanceAfter != null
          ? Number(lastPrepaidQuote.prepaidBalanceAfter)
          : null;

        // 총 입금액 (b2c_prepaid 견적 price 합산)
        let prepaidTotalDeposited = 0;
        let prepaidTotalUsed = 0;
        if (companyProjectIds.length > 0) {
          const [depRow] = await db
            .select({ total: sql<number>`COALESCE(SUM(${quotesTable.price}), 0)::int` })
            .from(quotesTable)
            .where(and(
              inArray(quotesTable.projectId, companyProjectIds),
              sql`${quotesTable.quoteType} = 'b2c_prepaid'`
            ));
          prepaidTotalDeposited = depRow?.total ?? 0;

          // 누적 사용액 (prepaid_deduction 견적의 usage_amount 합산)
          const [usedRow] = await db
            .select({ total: sql<number>`COALESCE(SUM(${quotesTable.prepaidUsageAmount}), 0)::int` })
            .from(quotesTable)
            .where(and(
              inArray(quotesTable.projectId, companyProjectIds),
              sql`${quotesTable.quoteType} = 'prepaid_deduction'`
            ));
          prepaidTotalUsed = usedRow?.total ?? 0;
        }

        company = { ...c, prepaidBalance, prepaidTotalDeposited, prepaidTotalUsed };
      }
    }
    if (project.contactId) {
      const [ct] = await db.select().from(contactsTable).where(eq(contactsTable.id, project.contactId));
      contact = ct ?? null;
    }

    // 번역사 프로필 + 단가표
    const tasks = await Promise.all(
      rawTasks.map(async (t) => {
        if (!t.translatorId) return t;
        const [profile] = await db
          .select()
          .from(translatorProfilesTable)
          .where(eq(translatorProfilesTable.userId, t.translatorId));
        const rates = await db
          .select()
          .from(translatorRatesTable)
          .where(eq(translatorRatesTable.translatorId, t.translatorId));
        return { ...t, translatorProfile: profile ?? null, translatorRates: rates };
      }),
    );

    res.json({
      ...project, quotes, payments, tasks, settlements, logs, notes, communications,
      company, contact,
    });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch project detail");
    res.status(500).json({ error: "프로젝트 상세 조회 실패." });
  }
});

// ─── 번역사 매칭 후보 추천 (top-3) ─────────────────────────────────────────
router.get("/admin/projects/:id/match-candidates", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const [project] = await db
      .select({
        companyId: projectsTable.companyId,
        contactId: projectsTable.contactId,
        title: projectsTable.title,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    const translators = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        isActive: usersTable.isActive,
      })
      .from(usersTable)
      .where(and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true)));

    if (translators.length === 0) {
      res.json([]);
      return;
    }

    const translatorIds = translators.map(t => t.id);

    const [profiles, ratesList] = await Promise.all([
      db
        .select()
        .from(translatorProfilesTable)
        .where(inArray(translatorProfilesTable.userId, translatorIds)),
      db
        .select()
        .from(translatorRatesTable)
        .where(inArray(translatorRatesTable.translatorId, translatorIds)),
    ]);

    const profileMap = new Map(profiles.map(p => [p.userId, p]));
    const ratesMap = new Map<number, typeof ratesList>();
    for (const r of ratesList) {
      if (!ratesMap.has(r.translatorId)) ratesMap.set(r.translatorId, []);
      ratesMap.get(r.translatorId)!.push(r);
    }

    const { lp, field } = req.query as { lp?: string; field?: string };

    const scored = translators.map(t => {
      const profile = profileMap.get(t.id) ?? null;
      const rates = ratesMap.get(t.id) ?? [];
      let score = 0;

      if (profile?.availabilityStatus === "available") score += 30;
      else if (profile?.availabilityStatus === "busy") score += 5;

      if (profile?.rating) score += (profile.rating / 5) * 20;

      if (lp && profile?.languagePairs?.toLowerCase().includes(lp.toLowerCase())) score += 25;
      if (field && profile?.specializations?.toLowerCase().includes(field.toLowerCase())) score += 25;
      if (rates.length > 0) score += 5;

      return { id: t.id, email: t.email, profile, rates, score };
    });

    scored.sort((a, b) => b.score - a.score);
    res.json(scored.slice(0, 3));
  } catch (err) {
    req.log.error({ err }, "Admin: failed to get match candidates");
    res.status(500).json({ error: "후보 조회 실패." });
  }
});

// ─── 번역사 직접 배정 ───────────────────────────────────────────────────────
router.post("/admin/projects/:id/assign-translator", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  const { translatorId } = req.body as { translatorId?: number };

  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }
  if (!translatorId || isNaN(translatorId)) {
    res.status(400).json({ error: "translatorId는 필수입니다." });
    return;
  }

  try {
    const [translator] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.id, translatorId), eq(usersTable.role, "translator"), eq(usersTable.isActive, true)));

    if (!translator) {
      res.status(404).json({ error: "해당 번역사를 찾을 수 없습니다." });
      return;
    }

    const newTask = await db.transaction(async (tx) => {
      await tx.delete(tasksTable).where(eq(tasksTable.projectId, projectId));
      const [task] = await tx
        .insert(tasksTable)
        .values({ projectId, translatorId })
        .returning();
      await tx.update(projectsTable).set({ status: "matched" }).where(eq(projectsTable.id, projectId));
      return task;
    });

    await logEvent("project", projectId, `admin_assigned_translator_${translatorId}`, req.log, req.user ?? undefined);
    res.status(201).json({ task: newTask, translatorEmail: translator.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to assign translator");
    res.status(500).json({ error: "번역사 배정 실패." });
  }
});

// ─── 상태 전이 허용 맵 (관리자 포함 전체 시스템 공통) ──────────────────
export const PROJECT_STATUS_TRANSITIONS: Record<string, string[]> = {
  created:     ["quoted", "cancelled"],
  quoted:      ["approved", "cancelled"],
  approved:    ["matched", "cancelled"],
  matched:     ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed:   [],
  cancelled:   [],
  paid:        ["matched", "cancelled"],  // 레거시 호환용
};

// ─── 재무 상태 변경 ──────────────────────────────────────────────────────
router.patch("/admin/projects/:id/financial-status", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  const { financialStatus } = req.body as { financialStatus?: string };
  const VALID = ["unbilled", "billed", "receivable", "paid"] as const;
  type FinancialStatus = typeof VALID[number];
  if (!financialStatus || !VALID.includes(financialStatus as FinancialStatus)) {
    res.status(400).json({ error: `financialStatus는 ${VALID.join(", ")} 중 하나여야 합니다.` });
    return;
  }
  try {
    const [updated] = await db
      .update(projectsTable)
      .set({ financialStatus: financialStatus as FinancialStatus })
      .where(eq(projectsTable.id, projectId))
      .returning();
    if (!updated) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }
    await logEvent("project", projectId, `admin_financial_status_to_${financialStatus}`, req.log, req.user ?? undefined);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update financial status");
    res.status(500).json({ error: "재무 상태 변경 실패." });
  }
});

// ─── 프로젝트 상태 수동 변경 ──────────────────────────────────────────────
router.patch("/admin/projects/:id/status", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  const { status, force } = req.body as { status?: string; force?: boolean };

  const ALL_STATUSES = ["created", "quoted", "approved", "matched", "in_progress", "completed", "cancelled"] as const;
  type AllowedStatus = typeof ALL_STATUSES[number];

  if (!status || !ALL_STATUSES.includes(status as AllowedStatus)) {
    res.status(400).json({ error: `status는 ${ALL_STATUSES.join(", ")} 중 하나여야 합니다.` });
    return;
  }

  const [project] = await db.select({ status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) {
    res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
    return;
  }

  const allowed = PROJECT_STATUS_TRANSITIONS[project.status] ?? [];
  if (!force && !allowed.includes(status)) {
    res.status(400).json({
      error: `"${project.status}" 상태에서 "${status}"로 직접 변경할 수 없습니다. 허용 전이: [${allowed.join(", ") || "없음"}]. force:true로 강제 변경 가능합니다.`,
      allowedTransitions: allowed,
      currentStatus: project.status,
    });
    return;
  }

  try {
    const [updated] = await db
      .update(projectsTable)
      .set({ status: status as AllowedStatus })
      .where(eq(projectsTable.id, projectId))
      .returning();

    const logAction = force ? `admin_forced_status_to_${status}` : `admin_status_changed_to_${status}`;
    await logEvent("project", projectId, logAction, req.log, req.user ?? undefined);

    // 완료 상태 전환 시: 정산이 없으면 자동 생성
    if (status === "completed") {
      const [existingSettlement] = await db.select({ id: settlementsTable.id }).from(settlementsTable).where(eq(settlementsTable.projectId, projectId));
      if (!existingSettlement) {
        const [payment] = await db.select().from(paymentsTable).where(and(eq(paymentsTable.projectId, projectId), eq(paymentsTable.status, "paid")));
        const [task] = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
        if (payment && task?.translatorId) {
          const total = Number(payment.amount);
          const fee = Math.round(total * 0.2);
          await db.insert(settlementsTable).values({
            projectId, translatorId: task.translatorId, paymentId: payment.id,
            totalAmount: String(total), translatorAmount: String(total - fee), platformFee: String(fee),
            status: "ready",
          });
          await logEvent("project", projectId, "settlement_created", req.log, req.user ?? undefined);
          req.log.info({ projectId }, "Settlement auto-created on admin status→completed");
        }
      }
    }

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update project status");
    res.status(500).json({ error: "상태 변경 실패." });
  }
});

// ─── 프로젝트 빠른 취소 ────────────────────────────────────────────────────
router.patch("/admin/projects/:id/cancel", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }
  const [project] = await db.select({ status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }
  if (project.status === "cancelled") { res.status(400).json({ error: "이미 취소된 프로젝트입니다." }); return; }
  if (project.status === "completed") { res.status(400).json({ error: "완료된 프로젝트는 취소할 수 없습니다." }); return; }

  try {
    const [updated] = await db.update(projectsTable).set({ status: "cancelled" }).where(eq(projectsTable.id, projectId)).returning();
    await logEvent("project", projectId, "project_cancelled", req.log, req.user ?? undefined);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to cancel project");
    res.status(500).json({ error: "프로젝트 취소 실패." });
  }
});

// ─── 번역사 재매칭 ─────────────────────────────────────────────────────────
router.post("/admin/projects/:id/rematch", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    const translators = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true)));

    if (translators.length === 0) {
      res.status(404).json({ error: "활성 상태의 번역사가 없습니다." });
      return;
    }

    const randomTranslator = translators[Math.floor(Math.random() * translators.length)];

    const newTask = await db.transaction(async (tx) => {
      await tx.delete(tasksTable).where(eq(tasksTable.projectId, projectId));
      const [task] = await tx
        .insert(tasksTable)
        .values({ projectId, translatorId: randomTranslator.id })
        .returning();
      await tx.update(projectsTable).set({ status: "matched" }).where(eq(projectsTable.id, projectId));
      return task;
    });

    await logEvent("project", projectId, "admin_rematch", req.log, req.user ?? undefined);
    res.status(201).json({ task: newTask, translatorEmail: randomTranslator.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to rematch project");
    res.status(500).json({ error: "재매칭 실패." });
  }
});

// ─── 관리자 직접 프로젝트 생성 ────────────────────────────────────────────
router.post("/admin/projects", ...adminGuard, async (req, res) => {
  const { title, customerId, companyId, contactId,
    requestingCompanyId, requestingDivisionId, billingCompanyId, payerCompanyId,
  } = req.body as {
    title?: string; customerId?: number; companyId?: number; contactId?: number;
    requestingCompanyId?: number; requestingDivisionId?: number;
    billingCompanyId?: number; payerCompanyId?: number;
  };
  if (!title?.trim()) {
    res.status(400).json({ error: "프로젝트 제목은 필수입니다." });
    return;
  }

  if (customerId) {
    const [customer] = await db.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, customerId));
    if (!customer) { res.status(400).json({ error: "존재하지 않는 고객입니다." }); return; }
  }

  const adminUser = (req as any).user as { id: number };

  // 기본값: 별도 지정 없으면 companyId를 청구/입금 주체로 자동 설정
  const effectiveBillingId = billingCompanyId ?? companyId ?? null;
  const effectivePayerId = payerCompanyId ?? companyId ?? null;
  const effectiveRequestingId = requestingCompanyId ?? companyId ?? null;

  try {
    const [project] = await db.insert(projectsTable).values({
      userId: adminUser.id,
      customerId: customerId ? Number(customerId) : null,
      companyId: companyId ? Number(companyId) : null,
      contactId: contactId ? Number(contactId) : null,
      requestingCompanyId: effectiveRequestingId ? Number(effectiveRequestingId) : null,
      requestingDivisionId: requestingDivisionId ? Number(requestingDivisionId) : null,
      billingCompanyId: effectiveBillingId ? Number(effectiveBillingId) : null,
      payerCompanyId: effectivePayerId ? Number(effectivePayerId) : null,
      title: title.trim(),
      adminId: adminUser.id,
    }).returning();

    req.log.info({ projectId: project.id, customerId, companyId, contactId }, "Admin: project created");
    await logEvent("project", project.id, "project_created", req.log, req.user ?? undefined);
    res.status(201).json(project);
  } catch (err: any) {
    req.log.error({ err: err?.message, stack: err?.stack, body: { title, customerId, companyId, contactId } }, "Admin: failed to create project");
    res.status(500).json({ error: `프로젝트 생성 실패: ${err?.message ?? "알 수 없는 오류"}` });
  }
});

// ─── 프로젝트 기본정보 수정 ────────────────────────────────────────────────
router.patch("/admin/projects/:id/info", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 project id." }); return; }

  const { title, companyId, contactId,
    requestingCompanyId, requestingDivisionId, billingCompanyId, payerCompanyId,
  } = req.body as {
    title?: string; companyId?: number | null; contactId?: number | null;
    requestingCompanyId?: number | null; requestingDivisionId?: number | null;
    billingCompanyId?: number | null; payerCompanyId?: number | null;
  };
  const updates: Record<string, any> = {};
  if (title !== undefined) { if (!title.trim()) { res.status(400).json({ error: "제목은 빈 값일 수 없습니다." }); return; } updates.title = title.trim(); }
  if (companyId !== undefined) updates.companyId = companyId;
  if (contactId !== undefined) updates.contactId = contactId;
  if (requestingCompanyId !== undefined) updates.requestingCompanyId = requestingCompanyId;
  if (requestingDivisionId !== undefined) updates.requestingDivisionId = requestingDivisionId;
  if (billingCompanyId !== undefined) updates.billingCompanyId = billingCompanyId;
  if (payerCompanyId !== undefined) updates.payerCompanyId = payerCompanyId;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "변경할 항목이 없습니다." }); return; }

  try {
    const [project] = await db
      .select({ id: projectsTable.id, billingCompanyId: projectsTable.billingCompanyId, payerCompanyId: projectsTable.payerCompanyId })
      .from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }
    const [updated] = await db.update(projectsTable).set(updates).where(eq(projectsTable.id, projectId)).returning();
    await logEvent("project", projectId, "admin_info_updated", req.log, req.user ?? undefined);
    if (billingCompanyId !== undefined && billingCompanyId !== project.billingCompanyId) {
      await logEvent("project", projectId, "billing_company_changed", req.log, req.user ?? undefined,
        JSON.stringify({ from: project.billingCompanyId, to: billingCompanyId }));
    }
    if (payerCompanyId !== undefined && payerCompanyId !== project.payerCompanyId) {
      await logEvent("project", projectId, "payer_company_changed", req.log, req.user ?? undefined,
        JSON.stringify({ from: project.payerCompanyId, to: payerCompanyId }));
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update project info");
    res.status(500).json({ error: "기본정보 수정 실패." });
  }
});

// ─── 청구/납부 정정 절차 ────────────────────────────────────────────────────
router.post("/admin/projects/:id/billing-correction", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 project id." }); return; }

  const { billingCompanyId, payerCompanyId, reason, memo } = req.body as {
    billingCompanyId?: number | null;
    payerCompanyId?: number | null;
    reason: string;
    memo: string;
  };

  if (!reason || !reason.trim()) { res.status(400).json({ error: "정정 사유를 선택해주세요." }); return; }
  if (!memo || !memo.trim()) { res.status(400).json({ error: "상세 메모를 입력해주세요." }); return; }
  if (billingCompanyId === undefined && payerCompanyId === undefined) {
    res.status(400).json({ error: "변경할 항목이 없습니다." }); return;
  }

  try {
    const [project] = await db
      .select({ id: projectsTable.id, billingCompanyId: projectsTable.billingCompanyId, payerCompanyId: projectsTable.payerCompanyId })
      .from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }

    // 완전 잠금 여부 확인 (정산 paid 상태)
    const paidSettlements = await db.select({ id: settlementsTable.id })
      .from(settlementsTable)
      .where(and(eq(settlementsTable.projectId, projectId), eq(settlementsTable.status, "paid")));
    if (paidSettlements.length > 0) {
      res.status(403).json({ error: "정산이 완료된 프로젝트입니다. 청구/납부 정보를 변경할 수 없습니다." }); return;
    }

    const updates: Record<string, any> = {};
    if (billingCompanyId !== undefined) updates.billingCompanyId = billingCompanyId;
    if (payerCompanyId !== undefined) updates.payerCompanyId = payerCompanyId;
    await db.update(projectsTable).set(updates).where(eq(projectsTable.id, projectId));

    if (billingCompanyId !== undefined && billingCompanyId !== project.billingCompanyId) {
      await logEvent("project", projectId, "billing_company_corrected", req.log, req.user ?? undefined,
        JSON.stringify({ from: project.billingCompanyId, to: billingCompanyId, reason: reason.trim(), memo: memo.trim() }));
    }
    if (payerCompanyId !== undefined && payerCompanyId !== project.payerCompanyId) {
      await logEvent("project", projectId, "payer_company_corrected", req.log, req.user ?? undefined,
        JSON.stringify({ from: project.payerCompanyId, to: payerCompanyId, reason: reason.trim(), memo: memo.trim() }));
    }
    await logEvent("project", projectId, "billing_correction_submitted", req.log, req.user ?? undefined,
      JSON.stringify({ reason: reason.trim(), memo: memo.trim() }));

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Admin: billing correction failed");
    res.status(500).json({ error: "정정 처리 실패." });
  }
});

// ─── 관리자 견적 생성 ──────────────────────────────────────────────────────
router.post("/admin/projects/:id/quote", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 project id." }); return; }

  type ItemInput = { productName: string; languagePair?: string; unit?: string; quantity?: number; unitPrice: number; taxRate?: 0 | 0.1; productId?: number; memo?: string };
  const {
    amount, items, note,
    taxDocumentType, taxCategory,
    quoteType, billingType,
    validUntil, issueDate, invoiceDueDate, paymentDueDate,
    prepaidBalanceBefore, prepaidUsageAmount, prepaidBalanceAfter,
    prepaidAccountId,
    batchPeriodStart, batchPeriodEnd,
  } = req.body as {
    amount?: number; items?: ItemInput[]; note?: string;
    taxDocumentType?: string; taxCategory?: string;
    quoteType?: string; billingType?: string;
    validUntil?: string; issueDate?: string;
    invoiceDueDate?: string; paymentDueDate?: string;
    prepaidBalanceBefore?: number; prepaidUsageAmount?: number; prepaidBalanceAfter?: number;
    prepaidAccountId?: number;
    batchPeriodStart?: string; batchPeriodEnd?: string;
  };
  const selectedProjectIds: number[] = Array.isArray(req.body.selectedProjectIds)
    ? (req.body.selectedProjectIds as unknown[]).map(Number).filter(n => !isNaN(n) && n > 0)
    : [];

  const hasItems = Array.isArray(items) && items.length > 0;
  const isPrepaidDeduction = quoteType === "prepaid_deduction";
  const isAccumulatedBatch = quoteType === "accumulated_batch";
  const hasSelectedProjects = selectedProjectIds.length > 0;

  if (!isPrepaidDeduction && !(isAccumulatedBatch && hasSelectedProjects) && !hasItems && (!amount || isNaN(Number(amount)) || Number(amount) <= 0)) {
    res.status(400).json({ error: "견적 금액 또는 품목 목록이 필요합니다." }); return;
  }
  if (isPrepaidDeduction && !hasItems && (!prepaidUsageAmount || Number(prepaidUsageAmount) <= 0)) {
    res.status(400).json({ error: "선입금 차감 견적서에는 이번 사용 금액 또는 품목 목록이 필요합니다." }); return;
  }

  try {
    const [project] = await db.select({ id: projectsTable.id, status: projectsTable.status, companyId: projectsTable.companyId }).from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }
    if (!["created", "quoted"].includes(project.status)) {
      res.status(400).json({ error: `견적은 '접수됨' 또는 '견적 발송' 상태에서만 생성 가능합니다. (현재: ${project.status})` }); return;
    }

    // 선입금 차감: 잔액 자동 조회 및 검증 (신 방식: prepaid_accounts 우선, 구 방식 fallback)
    let computedPrepaidBefore: number | null = null;
    let computedPrepaidAfter: number | null = null;
    let computedAmount: number | null = null;
    if (isPrepaidDeduction) {
      // items가 있으면 items 합계를 사용 금액으로 사용, 없으면 prepaidUsageAmount 사용
      const usageAmt = hasItems
        ? items!.reduce((s, it) => {
            const qty = Number(it.quantity ?? 1);
            const up = Number(it.unitPrice);
            const tax = Math.round(Math.round(qty * up) * (it.taxRate ?? 0));
            return s + Math.round(qty * up) + tax;
          }, 0)
        : Number(prepaidUsageAmount);
      let currentBalance = 0;

      if (prepaidAccountId) {
        // ── 신 방식: prepaid_accounts 테이블에서 잔액 조회 ─────────────────────
        const [acct] = await db
          .select({ currentBalance: prepaidAccountsTable.currentBalance, status: prepaidAccountsTable.status })
          .from(prepaidAccountsTable)
          .where(eq(prepaidAccountsTable.id, prepaidAccountId));
        if (!acct || acct.status !== "active") {
          res.status(400).json({ error: "유효하지 않은 선입금 계정입니다." }); return;
        }
        currentBalance = Number(acct.currentBalance);
      } else if (project.companyId) {
        // ── 구 방식 fallback: quotes 테이블의 prepaidBalanceAfter ─────────────
        const [lastQ] = await db
          .select({ prepaidBalanceAfter: quotesTable.prepaidBalanceAfter })
          .from(quotesTable)
          .innerJoin(projectsTable, eq(quotesTable.projectId, projectsTable.id))
          .where(and(
            eq(projectsTable.companyId, project.companyId),
            sql`${quotesTable.quoteType} IN ('prepaid_deduction', 'b2c_prepaid')`
          ))
          .orderBy(desc(quotesTable.id))
          .limit(1);
        currentBalance = lastQ?.prepaidBalanceAfter != null ? Number(lastQ.prepaidBalanceAfter) : 0;
      }

      if (usageAmt > currentBalance) {
        res.status(400).json({
          error: `잔액 부족: 현재 잔액 ${currentBalance.toLocaleString()}원, 사용 요청 ${usageAmt.toLocaleString()}원`,
          currentBalance,
        });
        return;
      }
      computedPrepaidBefore = currentBalance;
      computedPrepaidAfter = currentBalance - usageAmt;
      computedAmount = usageAmt;
    }

    // 누적 견적: 선택된 프로젝트들의 견적에서 품목 자동 생성 (DB 삭제 전에 조회)
    type BatchProjectItem = { projectId: number; title: string; quoteId: number; quotePrice: number; serviceName: string };
    let batchProjectItems: BatchProjectItem[] = [];
    if (isAccumulatedBatch && hasSelectedProjects) {
      // 현재 프로젝트 자신은 제외 (트랜잭션 내에서 기존 견적이 삭제되어 FK 충돌 방지)
      const filteredPids = selectedProjectIds.filter(pid => pid !== projectId);
      const projRows = await db.select({ id: projectsTable.id, title: projectsTable.title })
        .from(projectsTable).where(inArray(projectsTable.id, filteredPids));
      const projMap = new Map(projRows.map(p => [p.id, p.title]));
      for (const pid of filteredPids) {
        const [q] = await db.select().from(quotesTable).where(eq(quotesTable.projectId, pid)).orderBy(desc(quotesTable.id)).limit(1);
        if (q) {
          const qItems = await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, q.id));
          batchProjectItems.push({
            projectId: pid,
            title: projMap.get(pid) ?? `프로젝트 #${pid}`,
            quoteId: q.id,
            quotePrice: Number(q.price),
            serviceName: qItems[0]?.productName ?? "",
          });
        }
      }
    }

    // 기존 견적 삭제 (재생성)
    await db.delete(quotesTable).where(eq(quotesTable.projectId, projectId));

    // 품목 기반 합계 계산
    let totalPrice = isPrepaidDeduction ? (computedAmount ?? 0) : Number(amount ?? 0);
    type CalcItem = ItemInput & { supplyAmount: number; taxAmount: number; totalAmount: number };
    let calcItems: CalcItem[] = [];

    // 선입금 차감 + items 있을 때도 아이템 처리 허용
    const shouldProcessItems = hasItems && (!isPrepaidDeduction || hasItems);

    if (isAccumulatedBatch && batchProjectItems.length > 0) {
      // 누적 견적: 각 선택 프로젝트 → 품목 1건 자동 생성
      calcItems = batchProjectItems.map(bp => {
        const { supplyAmount, taxAmount, totalAmount } = calcQuoteItemAmounts(1, bp.quotePrice, 0);
        return {
          productName: bp.title,
          unit: "건",
          quantity: 1,
          unitPrice: bp.quotePrice,
          supplyAmount,
          taxAmount,
          totalAmount,
          memo: bp.serviceName || null,
        } as CalcItem;
      });
      totalPrice = calcItems.reduce((s, it) => s + it.totalAmount, 0);
    } else if (shouldProcessItems) {
      calcItems = items!.map(it => {
        const qty = Number(it.quantity ?? 1);
        const up = Number(it.unitPrice);
        const { supplyAmount, taxAmount, totalAmount } = calcQuoteItemAmounts(qty, up, it.taxRate ?? 0);
        return { ...it, supplyAmount, taxAmount, totalAmount };
      });
      // 선입금 차감은 서버 계산값(computedAmount) 우선, items 합계는 이미 일치함
      if (!isPrepaidDeduction) {
        totalPrice = calcItems.reduce((s, it) => s + it.totalAmount, 0);
      }
    }

    const computedBatchItemCount = isAccumulatedBatch && batchProjectItems.length > 0
      ? batchProjectItems.length
      : (calcItems.length > 0 ? calcItems.length : undefined);

    const result = await db.transaction(async tx => {
      const [quote] = await tx.insert(quotesTable).values({
        projectId, price: String(totalPrice), status: "sent",
        note: note?.trim() || null,
        taxDocumentType: taxDocumentType || "tax_invoice",
        taxCategory: taxCategory || "normal",
        quoteType: quoteType || "b2b_standard",
        billingType: billingType || "postpaid_per_project",
        validUntil: validUntil || null,
        issueDate: issueDate || null,
        invoiceDueDate: invoiceDueDate || null,
        paymentDueDate: paymentDueDate || null,
        // 선입금 차감은 서버 계산값 우선, 나머지 유형은 프론트 전달값
        prepaidBalanceBefore: isPrepaidDeduction
          ? (computedPrepaidBefore != null ? String(computedPrepaidBefore) : null)
          : (prepaidBalanceBefore != null ? String(prepaidBalanceBefore) : null),
        prepaidUsageAmount: isPrepaidDeduction && computedAmount != null ? String(computedAmount) : (prepaidUsageAmount != null ? String(prepaidUsageAmount) : null),
        prepaidBalanceAfter: isPrepaidDeduction
          ? (computedPrepaidAfter != null ? String(computedPrepaidAfter) : null)
          : (prepaidBalanceAfter != null ? String(prepaidBalanceAfter) : null),
        batchPeriodStart: batchPeriodStart || null,
        batchPeriodEnd: batchPeriodEnd || null,
        batchItemCount: computedBatchItemCount ?? null,
      }).returning();

      if (calcItems.length > 0) {
        await tx.insert(quoteItemsTable).values(calcItems.map(it => ({
          quoteId: quote.id,
          productId: (it as any).productId ?? null,
          productName: it.productName,
          languagePair: (it as any).languagePair ?? null,
          unit: it.unit ?? "건",
          quantity: String(it.quantity ?? 1),
          unitPrice: String(it.unitPrice),
          supplyAmount: String(it.supplyAmount),
          taxAmount: String(it.taxAmount),
          totalAmount: String(it.totalAmount),
          memo: (it as any).memo ?? null,
        })));
      }

      // 누적 견적 배치 레코드 생성 (월말 청구/세금계산서 연계용)
      if (isAccumulatedBatch && batchProjectItems.length > 0 && project.companyId && batchPeriodStart && batchPeriodEnd) {
        const [batch] = await tx.insert(billingBatchesTable).values({
          companyId: project.companyId,
          periodStart: new Date(batchPeriodStart),
          periodEnd: new Date(batchPeriodEnd),
          status: "draft",
          totalAmount: String(totalPrice),
          quoteId: quote.id,
        }).returning();
        await tx.insert(billingBatchItemsTable).values(batchProjectItems.map(bp => ({
          batchId: batch.id,
          projectId: bp.projectId,
          quoteId: bp.quoteId,
          amount: String(bp.quotePrice),
          serviceName: bp.serviceName || null,
        })));
      }

      await tx.update(projectsTable).set({ status: "quoted" }).where(eq(projectsTable.id, projectId));
      return quote;
    });
    await logEvent("project", projectId, "quote_created", req.log, req.user ?? undefined);
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to create quote");
    res.status(500).json({ error: "견적 생성 실패." });
  }
});

// ─── 선입금 현황 조회 ─────────────────────────────────────────────────────────
router.get("/admin/prepaid-summary", ...adminGuard, async (req, res) => {
  try {
    const prepaidQuotes = await db.select({
      projectId: quotesTable.projectId, quoteType: quotesTable.quoteType,
      price: quotesTable.price, prepaidBalanceAfter: quotesTable.prepaidBalanceAfter,
      prepaidUsageAmount: quotesTable.prepaidUsageAmount, createdAt: quotesTable.createdAt,
    }).from(quotesTable)
      .where(inArray(quotesTable.quoteType as any, ["b2c_prepaid", "prepaid_deduction"]))
      .orderBy(desc(quotesTable.id));

    const pids = [...new Set(prepaidQuotes.map(q => q.projectId).filter(Boolean))] as number[];
    let projCompanyMap = new Map<number, number | null>();
    if (pids.length > 0) {
      const projRows = await db.select({ id: projectsTable.id, companyId: projectsTable.companyId })
        .from(projectsTable).where(inArray(projectsTable.id, pids));
      projCompanyMap = new Map(projRows.map(p => [p.id, p.companyId]));
    }
    const companies = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable);
    const companyNameMap = new Map(companies.map(c => [c.id, c.name]));

    type Summary = { companyId: number; companyName: string; currentBalance: number; totalDeposited: number; totalUsed: number; lastUsedAt: Date | null; lastDepositAt: Date | null };
    const summaryMap = new Map<number, Summary>();
    const compBalanceSeen = new Set<number>();

    for (const q of prepaidQuotes) {
      if (q.projectId == null) continue;
      const cid = projCompanyMap.get(q.projectId);
      if (cid == null) continue;
      if (!summaryMap.has(cid)) {
        summaryMap.set(cid, { companyId: cid, companyName: companyNameMap.get(cid) ?? `거래처 #${cid}`, currentBalance: 0, totalDeposited: 0, totalUsed: 0, lastUsedAt: null, lastDepositAt: null });
      }
      const s = summaryMap.get(cid)!;
      if (!compBalanceSeen.has(cid) && q.prepaidBalanceAfter != null) {
        s.currentBalance = Number(q.prepaidBalanceAfter);
        compBalanceSeen.add(cid);
      }
      if (q.quoteType === "b2c_prepaid") {
        s.totalDeposited += Number(q.price ?? 0);
        const d = new Date(q.createdAt);
        if (!s.lastDepositAt || d > s.lastDepositAt) s.lastDepositAt = d;
      } else if (q.quoteType === "prepaid_deduction") {
        s.totalUsed += Number(q.prepaidUsageAmount ?? 0);
        const d = new Date(q.createdAt);
        if (!s.lastUsedAt || d > s.lastUsedAt) s.lastUsedAt = d;
      }
    }
    res.json(Array.from(summaryMap.values()).sort((a, b) => b.currentBalance - a.currentBalance));
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch prepaid summary");
    res.status(500).json({ error: "선입금 현황 조회 실패." });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 선입금 계정 (Prepaid Account Ledger) API
// ════════════════════════════════════════════════════════════════════════════

// ─── 거래처의 선입금 계정 목록 + 잔액 ────────────────────────────────────────
router.get("/admin/prepaid-accounts", ...adminGuard, async (req, res) => {
  const { companyId } = req.query as { companyId?: string };
  const cid = companyId ? Number(companyId) : null;
  try {
    const where = cid ? eq(prepaidAccountsTable.companyId, cid) : undefined;
    const accounts = await db.select().from(prepaidAccountsTable)
      .where(where)
      .orderBy(desc(prepaidAccountsTable.createdAt));

    const cids = [...new Set(accounts.map(a => a.companyId))];
    let companyMap = new Map<number, string>();
    if (cids.length > 0) {
      const cs = await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(inArray(companiesTable.id, cids));
      companyMap = new Map(cs.map(c => [c.id, c.name]));
    }
    res.json(accounts.map(a => ({
      ...a,
      initialAmount: Number(a.initialAmount),
      currentBalance: Number(a.currentBalance),
      companyName: companyMap.get(a.companyId) ?? `거래처 #${a.companyId}`,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch prepaid accounts");
    res.status(500).json({ error: "선입금 계정 조회 실패" });
  }
});

// ─── 선입금 계정 신규 생성 (최초 입금) ─────────────────────────────────────
router.post("/admin/prepaid-accounts", ...adminGuard, async (req, res) => {
  const { companyId, initialAmount, note, depositDate } = req.body as {
    companyId: number; initialAmount: number; note?: string; depositDate?: string;
  };
  if (!companyId || !initialAmount || initialAmount <= 0) {
    res.status(400).json({ error: "companyId와 initialAmount(>0)가 필요합니다." }); return;
  }
  try {
    const result = await db.transaction(async tx => {
      const [account] = await tx.insert(prepaidAccountsTable).values({
        companyId,
        initialAmount: String(initialAmount),
        currentBalance: String(initialAmount),
        status: "active",
        note: note ?? null,
        depositDate: depositDate ?? new Date().toISOString().slice(0, 10),
      }).returning();
      const [entry] = await tx.insert(prepaidLedgerTable).values({
        accountId: account.id,
        projectId: null,
        type: "deposit",
        amount: String(initialAmount),
        balanceAfter: String(initialAmount),
        description: note ?? "선입금 입금",
        transactionDate: depositDate ?? new Date().toISOString().slice(0, 10),
      }).returning();
      return { account, entry };
    });
    res.status(201).json({
      ...result.account,
      initialAmount: Number(result.account.initialAmount),
      currentBalance: Number(result.account.currentBalance),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create prepaid account");
    res.status(500).json({ error: "선입금 계정 생성 실패" });
  }
});

// ─── 선입금 계정 상세 + 원장 전체 ──────────────────────────────────────────
router.get("/admin/prepaid-accounts/:id", ...adminGuard, async (req, res) => {
  const accountId = Number(req.params.id);
  if (!accountId) { res.status(400).json({ error: "유효하지 않은 계정 ID" }); return; }
  try {
    const [account] = await db.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, accountId));
    if (!account) { res.status(404).json({ error: "계정을 찾을 수 없습니다." }); return; }

    const ledger = await db.select().from(prepaidLedgerTable)
      .where(eq(prepaidLedgerTable.accountId, accountId))
      .orderBy(prepaidLedgerTable.transactionDate, prepaidLedgerTable.createdAt);

    const pids = ledger.filter(e => e.projectId).map(e => e.projectId as number);
    let projectMap = new Map<number, string>();
    if (pids.length > 0) {
      const ps = await db.select({ id: projectsTable.id, title: projectsTable.title }).from(projectsTable).where(inArray(projectsTable.id, pids));
      projectMap = new Map(ps.map(p => [p.id, p.title]));
    }

    // 차감 건에 대해 quote_items 에서 공급가·부가세 합계 계산
    const deductPids = ledger.filter(e => e.type === "deduction" && e.projectId).map(e => e.projectId as number);
    type TaxSummary = { supplyAmount: number; taxAmount: number };
    const taxByProjectId = new Map<number, TaxSummary>();
    if (deductPids.length > 0) {
      const quotes = await db.select({ id: quotesTable.id, projectId: quotesTable.projectId })
        .from(quotesTable).where(inArray(quotesTable.projectId, deductPids));
      const quoteIds = quotes.map(q => q.id);
      if (quoteIds.length > 0) {
        const items = await db.select({
          quoteId: quoteItemsTable.quoteId,
          supplyAmount: quoteItemsTable.supplyAmount,
          taxAmount: quoteItemsTable.taxAmount,
        }).from(quoteItemsTable).where(inArray(quoteItemsTable.quoteId, quoteIds));
        const quoteToProject = new Map(quotes.map(q => [q.id, q.projectId as number]));
        for (const it of items) {
          const pid = quoteToProject.get(it.quoteId);
          if (!pid) continue;
          const prev = taxByProjectId.get(pid) ?? { supplyAmount: 0, taxAmount: 0 };
          taxByProjectId.set(pid, {
            supplyAmount: prev.supplyAmount + Number(it.supplyAmount),
            taxAmount: prev.taxAmount + Number(it.taxAmount),
          });
        }
      }
    }

    const [company] = await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, account.companyId));

    res.json({
      ...account,
      initialAmount: Number(account.initialAmount),
      currentBalance: Number(account.currentBalance),
      companyName: company?.name ?? `거래처 #${account.companyId}`,
      ledger: ledger.map(e => {
        const tax = e.type === "deduction" && e.projectId ? (taxByProjectId.get(e.projectId) ?? null) : null;
        return {
          ...e,
          amount: Number(e.amount),
          balanceAfter: Number(e.balanceAfter),
          projectTitle: e.projectId ? (projectMap.get(e.projectId) ?? `프로젝트 #${e.projectId}`) : null,
          supplyAmount: tax?.supplyAmount ?? null,
          taxAmount: tax?.taxAmount ?? null,
        };
      }),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch prepaid account detail");
    res.status(500).json({ error: "선입금 계정 상세 조회 실패" });
  }
});

// ─── 선입금 계정에 거래 추가 (차감 / 추가입금 / 조정) ──────────────────────
router.post("/admin/prepaid-accounts/:id/transactions", ...adminGuard, async (req, res) => {
  const accountId = Number(req.params.id);
  const { type, amount, description, projectId, transactionDate } = req.body as {
    type: "deduction" | "deposit" | "adjustment";
    amount: number;
    description?: string;
    projectId?: number;
    transactionDate?: string;
  };
  if (!type || !amount || amount <= 0) {
    res.status(400).json({ error: "type과 amount(>0)가 필요합니다." }); return;
  }
  try {
    const [account] = await db.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, accountId));
    if (!account || account.status !== "active") {
      res.status(400).json({ error: "유효하지 않은 계정입니다." }); return;
    }
    const currentBal = Number(account.currentBalance);
    if (type === "deduction" && amount > currentBal) {
      res.status(400).json({ error: `잔액 부족: 현재 잔액 ${currentBal.toLocaleString()}원, 차감 요청 ${amount.toLocaleString()}원` }); return;
    }
    const newBalance = type === "deduction"
      ? currentBal - amount
      : currentBal + amount;

    const result = await db.transaction(async tx => {
      await tx.update(prepaidAccountsTable).set({ currentBalance: String(newBalance) }).where(eq(prepaidAccountsTable.id, accountId));
      const [entry] = await tx.insert(prepaidLedgerTable).values({
        accountId,
        projectId: projectId ?? null,
        type,
        amount: String(amount),
        balanceAfter: String(newBalance),
        description: description ?? (type === "deduction" ? "서비스 차감" : type === "deposit" ? "추가 입금" : "잔액 조정"),
        transactionDate: transactionDate ?? new Date().toISOString().slice(0, 10),
      }).returning();
      return entry;
    });
    res.status(201).json({ ...result, amount: Number(result.amount), balanceAfter: Number(result.balanceAfter), currentBalance: newBalance });
  } catch (err) {
    req.log.error({ err }, "Failed to add prepaid transaction");
    res.status(500).json({ error: "거래 추가 실패" });
  }
});

// ─── 선입금 원장 항목 삭제 (잔액 재계산) ────────────────────────────────────
router.delete("/admin/prepaid-ledger/:entryId", ...adminGuard, async (req, res) => {
  const entryId = Number(req.params.entryId);
  try {
    const [entry] = await db.select().from(prepaidLedgerTable).where(eq(prepaidLedgerTable.id, entryId));
    if (!entry) { res.status(404).json({ error: "항목을 찾을 수 없습니다." }); return; }
    const [account] = await db.select().from(prepaidAccountsTable).where(eq(prepaidAccountsTable.id, entry.accountId));
    if (!account) { res.status(404).json({ error: "계정을 찾을 수 없습니다." }); return; }

    await db.transaction(async tx => {
      await tx.delete(prepaidLedgerTable).where(eq(prepaidLedgerTable.id, entryId));
      // 잔액 재계산: 모든 남은 항목 기반
      const remaining = await tx.select().from(prepaidLedgerTable)
        .where(eq(prepaidLedgerTable.accountId, entry.accountId))
        .orderBy(prepaidLedgerTable.transactionDate, prepaidLedgerTable.createdAt);
      let bal = 0;
      for (const e of remaining) {
        bal = e.type === "deduction" ? bal - Number(e.amount) : bal + Number(e.amount);
        await tx.update(prepaidLedgerTable).set({ balanceAfter: String(bal) }).where(eq(prepaidLedgerTable.id, e.id));
      }
      await tx.update(prepaidAccountsTable).set({ currentBalance: String(bal) }).where(eq(prepaidAccountsTable.id, entry.accountId));
    });
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete prepaid ledger entry");
    res.status(500).json({ error: "원장 항목 삭제 실패" });
  }
});

// ─── 누적 청구 배치 목록 ───────────────────────────────────────────────────────
router.get("/admin/billing-batches", ...adminGuard, async (req, res) => {
  try {
    const { status: statusFilter, companyId: companyIdFilter } = req.query as { status?: string; companyId?: string };
    const companyAlias2 = db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).as("bb_company");

    const batches = await db.select({
      id: billingBatchesTable.id, companyId: billingBatchesTable.companyId,
      companyName: companyAlias2.name, periodStart: billingBatchesTable.periodStart,
      periodEnd: billingBatchesTable.periodEnd, status: billingBatchesTable.status,
      totalAmount: billingBatchesTable.totalAmount, quoteId: billingBatchesTable.quoteId,
      createdAt: billingBatchesTable.createdAt,
    }).from(billingBatchesTable)
      .leftJoin(companyAlias2, eq(billingBatchesTable.companyId, companyAlias2.id))
      .orderBy(desc(billingBatchesTable.id));

    let result = batches;
    if (statusFilter?.trim() && statusFilter !== "all") result = result.filter(b => b.status === statusFilter);
    if (companyIdFilter?.trim()) {
      const cid = Number(companyIdFilter);
      if (!isNaN(cid)) result = result.filter(b => b.companyId === cid);
    }

    const batchIds = result.map(b => b.id);
    let itemCountMap = new Map<number, number>();
    if (batchIds.length > 0) {
      const countRows = await db.select({
        batchId: billingBatchItemsTable.batchId,
        count: sql<number>`count(*)::int`,
      }).from(billingBatchItemsTable)
        .where(inArray(billingBatchItemsTable.batchId, batchIds))
        .groupBy(billingBatchItemsTable.batchId);
      itemCountMap = new Map(countRows.map(r => [r.batchId, r.count]));
    }

    const quoteIds = result.map(b => b.quoteId).filter(Boolean) as number[];
    let quoteStatusMap = new Map<number, string>();
    if (quoteIds.length > 0) {
      const qRows = await db.select({ id: quotesTable.id, status: quotesTable.status })
        .from(quotesTable).where(inArray(quotesTable.id, quoteIds));
      quoteStatusMap = new Map(qRows.map(q => [q.id, q.status]));
    }

    res.json(result.map(b => ({
      ...b,
      totalAmount: Number(b.totalAmount),
      itemCount: itemCountMap.get(b.id) ?? 0,
      quoteStatus: b.quoteId ? (quoteStatusMap.get(b.quoteId) ?? null) : null,
    })));
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch billing batches");
    res.status(500).json({ error: "누적 청구 목록 조회 실패." });
  }
});

// ─── 거래처의 현재 활성(draft) 누적 배치 조회 ────────────────────────────────
router.get("/admin/billing-batches/active", ...adminGuard, async (req, res) => {
  const cid = Number((req.query as { companyId?: string }).companyId);
  if (!cid || isNaN(cid)) { res.status(400).json({ error: "companyId 필요" }); return; }
  try {
    const [batch] = await db.select().from(billingBatchesTable)
      .where(and(eq(billingBatchesTable.companyId, cid), eq(billingBatchesTable.status, "draft")))
      .orderBy(desc(billingBatchesTable.id)).limit(1);
    if (!batch) { res.json(null); return; }
    const items = await db.select().from(billingBatchItemsTable).where(eq(billingBatchItemsTable.batchId, batch.id));
    const pids = items.map(i => i.projectId);
    let projectMap = new Map<number, string>();
    if (pids.length > 0) {
      const ps = await db.select({ id: projectsTable.id, title: projectsTable.title }).from(projectsTable).where(inArray(projectsTable.id, pids));
      projectMap = new Map(ps.map(p => [p.id, p.title]));
    }
    const enriched = items.map(i => ({ ...i, amount: Number(i.amount), projectTitle: projectMap.get(i.projectId) ?? `프로젝트 #${i.projectId}` }));
    // 작업 항목도 함께 반환
    const workItems = await db.select().from(billingBatchWorkItemsTable)
      .where(eq(billingBatchWorkItemsTable.batchId, batch.id))
      .orderBy(billingBatchWorkItemsTable.sortOrder, billingBatchWorkItemsTable.createdAt);
    const workItemsEnriched = workItems.map(w => ({
      ...w, quantity: Number(w.quantity), unitPrice: Number(w.unitPrice), amount: Number(w.amount),
    }));
    const workTotal = workItemsEnriched.reduce((s, w) => s + w.amount, 0);
    res.json({ ...batch, totalAmount: workTotal > 0 ? workTotal : Number(batch.totalAmount), items: enriched, workItems: workItemsEnriched });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch active batch");
    res.status(500).json({ error: "활성 배치 조회 실패" });
  }
});

// ─── 새 누적 배치 생성 ──────────────────────────────────────────────────────
router.post("/admin/billing-batches", ...adminGuard, async (req, res) => {
  const { companyId, note, periodStart, periodEnd } = req.body as { companyId?: number; note?: string; periodStart?: string; periodEnd?: string };
  if (!companyId) { res.status(400).json({ error: "companyId 필요" }); return; }
  const [existing] = await db.select({ id: billingBatchesTable.id }).from(billingBatchesTable)
    .where(and(eq(billingBatchesTable.companyId, companyId), eq(billingBatchesTable.status, "draft")));
  if (existing) { res.status(409).json({ error: "이미 진행 중인 누적 배치가 있습니다.", batchId: existing.id }); return; }
  try {
    const now = new Date();
    const start = periodStart ? new Date(periodStart) : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = periodEnd ? new Date(periodEnd) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const [batch] = await db.insert(billingBatchesTable).values({ companyId, periodStart: start, periodEnd: end, status: "draft", totalAmount: "0", note: note ?? null }).returning();
    res.status(201).json({ ...batch, totalAmount: 0, items: [] });
  } catch (err) {
    req.log.error({ err }, "Failed to create batch");
    res.status(500).json({ error: "배치 생성 실패" });
  }
});

// ─── 누적 배치에 프로젝트 항목 추가 ──────────────────────────────────────────
router.post("/admin/billing-batches/:batchId/items", ...adminGuard, async (req, res) => {
  const batchId = Number(req.params.batchId);
  const { projectId } = req.body as { projectId: number };
  if (!projectId) { res.status(400).json({ error: "projectId 필요" }); return; }
  try {
    const [batch] = await db.select().from(billingBatchesTable).where(eq(billingBatchesTable.id, batchId));
    if (!batch || batch.status !== "draft") { res.status(400).json({ error: "유효하지 않은 배치" }); return; }
    const [existingItem] = await db.select({ id: billingBatchItemsTable.id }).from(billingBatchItemsTable)
      .where(and(eq(billingBatchItemsTable.batchId, batchId), eq(billingBatchItemsTable.projectId, projectId)));
    if (existingItem) { res.status(409).json({ error: "이미 배치에 포함된 프로젝트입니다." }); return; }
    const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.projectId, projectId)).orderBy(desc(quotesTable.id)).limit(1);
    const quotePrice = quote ? Number(quote.price) : 0;
    const qItems = quote ? await db.select({ productName: quoteItemsTable.productName }).from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).limit(1) : [];
    const serviceName = qItems[0]?.productName ?? "";
    const [item] = await db.insert(billingBatchItemsTable).values({ batchId, projectId, quoteId: quote?.id ?? null, amount: String(quotePrice), serviceName }).returning();
    const allItems = await db.select({ amount: billingBatchItemsTable.amount }).from(billingBatchItemsTable).where(eq(billingBatchItemsTable.batchId, batchId));
    const newTotal = allItems.reduce((s, i) => s + Number(i.amount), 0);
    await db.update(billingBatchesTable).set({ totalAmount: String(newTotal) }).where(eq(billingBatchesTable.id, batchId));
    const [proj] = await db.select({ title: projectsTable.title }).from(projectsTable).where(eq(projectsTable.id, projectId));
    res.status(201).json({ ...item, amount: Number(item.amount), projectTitle: proj?.title ?? `프로젝트 #${projectId}` });
  } catch (err) {
    req.log.error({ err }, "Failed to add batch item");
    res.status(500).json({ error: "배치 항목 추가 실패" });
  }
});

// ─── 누적 배치 항목 제거 ─────────────────────────────────────────────────────
router.delete("/admin/billing-batches/:batchId/items/:itemId", ...adminGuard, async (req, res) => {
  const batchId = Number(req.params.batchId), itemId = Number(req.params.itemId);
  try {
    await db.delete(billingBatchItemsTable).where(and(eq(billingBatchItemsTable.id, itemId), eq(billingBatchItemsTable.batchId, batchId)));
    const allItems = await db.select({ amount: billingBatchItemsTable.amount }).from(billingBatchItemsTable).where(eq(billingBatchItemsTable.batchId, batchId));
    const newTotal = allItems.reduce((s, i) => s + Number(i.amount), 0);
    await db.update(billingBatchesTable).set({ totalAmount: String(newTotal) }).where(eq(billingBatchesTable.id, batchId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to remove batch item");
    res.status(500).json({ error: "배치 항목 제거 실패" });
  }
});

// ─── 누적 배치 작업 항목(work items) CRUD ───────────────────────────────────

router.post("/admin/billing-batches/:batchId/work-items", ...adminGuard, async (req, res) => {
  const batchId = Number(req.params.batchId);
  const { workDate, projectName, language, description, quantity, unitPrice, amount, sortOrder } = req.body as {
    workDate?: string; projectName?: string; language?: string; description?: string;
    quantity?: number; unitPrice?: number; amount?: number; sortOrder?: number;
  };
  try {
    const [batch] = await db.select({ id: billingBatchesTable.id, status: billingBatchesTable.status }).from(billingBatchesTable).where(eq(billingBatchesTable.id, batchId));
    if (!batch || batch.status !== "draft") { res.status(400).json({ error: "유효하지 않은 배치입니다." }); return; }
    const qty = Number(quantity ?? 1);
    const price = Number(unitPrice ?? 0);
    const amt = amount != null ? Number(amount) : qty * price;
    const [item] = await db.insert(billingBatchWorkItemsTable).values({
      batchId, workDate: workDate ?? null, projectName: projectName ?? null,
      language: language ?? null, description: description ?? null,
      quantity: String(qty), unitPrice: String(price), amount: String(amt),
      sortOrder: sortOrder ?? 0,
    }).returning();
    res.status(201).json({ ...item, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice), amount: Number(item.amount) });
  } catch (err) {
    req.log.error({ err }, "Failed to add work item");
    res.status(500).json({ error: "작업 항목 추가 실패" });
  }
});

router.put("/admin/billing-batches/:batchId/work-items/:itemId", ...adminGuard, async (req, res) => {
  const batchId = Number(req.params.batchId);
  const itemId = Number(req.params.itemId);
  const { workDate, projectName, language, description, quantity, unitPrice, amount, sortOrder } = req.body as {
    workDate?: string; projectName?: string; language?: string; description?: string;
    quantity?: number; unitPrice?: number; amount?: number; sortOrder?: number;
  };
  try {
    const [batch] = await db.select({ status: billingBatchesTable.status }).from(billingBatchesTable).where(eq(billingBatchesTable.id, batchId));
    if (!batch || batch.status !== "draft") { res.status(400).json({ error: "유효하지 않은 배치입니다." }); return; }
    const qty = quantity != null ? Number(quantity) : undefined;
    const price = unitPrice != null ? Number(unitPrice) : undefined;
    const amt = amount != null ? Number(amount) : (qty != null && price != null ? qty * price : undefined);
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (workDate !== undefined) updateData.workDate = workDate;
    if (projectName !== undefined) updateData.projectName = projectName;
    if (language !== undefined) updateData.language = language;
    if (description !== undefined) updateData.description = description;
    if (qty !== undefined) updateData.quantity = String(qty);
    if (price !== undefined) updateData.unitPrice = String(price);
    if (amt !== undefined) updateData.amount = String(amt);
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;
    const [updated] = await db.update(billingBatchWorkItemsTable)
      .set(updateData as Partial<typeof billingBatchWorkItemsTable.$inferInsert>)
      .where(and(eq(billingBatchWorkItemsTable.id, itemId), eq(billingBatchWorkItemsTable.batchId, batchId)))
      .returning();
    if (!updated) { res.status(404).json({ error: "항목을 찾을 수 없습니다." }); return; }
    res.json({ ...updated, quantity: Number(updated.quantity), unitPrice: Number(updated.unitPrice), amount: Number(updated.amount) });
  } catch (err) {
    req.log.error({ err }, "Failed to update work item");
    res.status(500).json({ error: "작업 항목 수정 실패" });
  }
});

router.delete("/admin/billing-batches/:batchId/work-items/:itemId", ...adminGuard, async (req, res) => {
  const batchId = Number(req.params.batchId);
  const itemId = Number(req.params.itemId);
  try {
    await db.delete(billingBatchWorkItemsTable)
      .where(and(eq(billingBatchWorkItemsTable.id, itemId), eq(billingBatchWorkItemsTable.batchId, batchId)));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete work item");
    res.status(500).json({ error: "작업 항목 삭제 실패" });
  }
});

// ─── 누적 배치 확정 발행 (견적서 생성) ──────────────────────────────────────
router.post("/admin/billing-batches/:batchId/issue", ...adminGuard, async (req, res) => {
  const batchId = Number(req.params.batchId);
  const { projectId, issueDate, paymentDueDate, taxDocumentType } = req.body as { projectId: number; issueDate?: string; paymentDueDate?: string; taxDocumentType?: string };
  if (!projectId) { res.status(400).json({ error: "projectId 필요" }); return; }
  try {
    const [batch] = await db.select().from(billingBatchesTable).where(eq(billingBatchesTable.id, batchId));
    if (!batch || batch.status !== "draft") { res.status(400).json({ error: "배치가 유효하지 않거나 이미 발행되었습니다." }); return; }

    // 작업 항목(work items) 우선, 없으면 기존 project items fallback
    const workItems = await db.select().from(billingBatchWorkItemsTable)
      .where(eq(billingBatchWorkItemsTable.batchId, batchId))
      .orderBy(billingBatchWorkItemsTable.sortOrder, billingBatchWorkItemsTable.createdAt);

    const legacyItems = await db.select().from(billingBatchItemsTable).where(eq(billingBatchItemsTable.batchId, batchId));

    if (workItems.length === 0 && legacyItems.length === 0) {
      res.status(400).json({ error: "배치에 작업 항목이 없습니다. 항목을 먼저 추가하세요." }); return;
    }

    let totalAmount = 0;
    let quoteItemValues: Parameters<typeof db.insert>[0] extends never ? never : { quoteId: number; sortOrder: number; productName: string; unit: string | null; quantity: string; unitPrice: string; supplyAmount: string; taxAmount: string; totalAmount: string; memo: string | null }[] = [];

    if (workItems.length > 0) {
      // 작업 항목 기반 발행
      totalAmount = workItems.reduce((s, w) => s + Number(w.amount), 0);
      quoteItemValues = workItems.map((w, idx) => {
        const label = [w.projectName, w.language, w.description].filter(Boolean).join(" / ");
        return {
          quoteId: 0, sortOrder: idx + 1,
          productName: label || `작업항목 #${idx + 1}`,
          unit: "식",
          quantity: String(Number(w.quantity)),
          unitPrice: String(Number(w.unitPrice)),
          supplyAmount: String(Number(w.amount)),
          taxAmount: "0",
          totalAmount: String(Number(w.amount)),
          memo: w.workDate ?? null,
        };
      });
    } else {
      // 기존 project items fallback
      const pids = legacyItems.map(i => i.projectId);
      const projects = await db.select({ id: projectsTable.id, title: projectsTable.title }).from(projectsTable).where(inArray(projectsTable.id, pids));
      const projectMap = new Map(projects.map(p => [p.id, p.title]));
      totalAmount = legacyItems.reduce((s, i) => s + Number(i.amount), 0);
      quoteItemValues = legacyItems.map((item, idx) => ({
        quoteId: 0, sortOrder: idx + 1,
        productName: projectMap.get(item.projectId) ?? `프로젝트 #${item.projectId}`,
        unit: "건", quantity: "1",
        unitPrice: String(Number(item.amount)), supplyAmount: String(Number(item.amount)),
        taxAmount: "0", totalAmount: String(Number(item.amount)),
        memo: item.serviceName || null,
      }));
    }

    const quote = await db.transaction(async tx => {
      await tx.delete(quotesTable).where(eq(quotesTable.projectId, projectId));
      const [q] = await tx.insert(quotesTable).values({
        projectId,
        price: String(totalAmount),
        status: "pending",
        quoteType: "accumulated_batch" as string,
        billingType: "monthly_billing" as string,
        batchItemCount: workItems.length > 0 ? workItems.length : legacyItems.length,
        batchPeriodStart: batch.periodStart,
        batchPeriodEnd: batch.periodEnd,
        issueDate: issueDate ? new Date(issueDate) : new Date(),
        paymentDueDate: paymentDueDate ? new Date(paymentDueDate) : null,
        taxDocumentType: (taxDocumentType ?? "tax_invoice") as string,
      }).returning();
      await tx.insert(quoteItemsTable).values(quoteItemValues.map(v => ({ ...v, quoteId: q.id })));
      await tx.update(billingBatchesTable).set({ status: "issued", quoteId: q.id, totalAmount: String(totalAmount) }).where(eq(billingBatchesTable.id, batchId));
      await tx.update(projectsTable).set({ status: "quoted" }).where(eq(projectsTable.id, projectId));
      return q;
    });
    res.json(quote);
  } catch (err) {
    req.log.error({ err }, "Failed to issue batch");
    res.status(500).json({ error: "배치 발행 실패" });
  }
});

// ─── 누적 견적 후보 프로젝트 조회 ─────────────────────────────────────────────
router.get("/admin/billing-candidates", ...adminGuard, async (req, res) => {
  const { companyId, start, end } = req.query as { companyId?: string; start?: string; end?: string };
  if (!companyId || !start || !end) {
    res.status(400).json({ error: "companyId, start, end가 필요합니다." }); return;
  }
  const cid = Number(companyId);
  if (isNaN(cid) || cid <= 0) { res.status(400).json({ error: "유효하지 않은 companyId." }); return; }

  const startDate = new Date(start);
  const endDate = new Date(end);
  endDate.setHours(23, 59, 59, 999);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    res.status(400).json({ error: "유효하지 않은 날짜 형식." }); return;
  }

  try {
    const billableStatuses = ["completed", "paid", "approved", "in_progress", "matched", "quoted"] as const;
    const projects = await db
      .select({ id: projectsTable.id, title: projectsTable.title, status: projectsTable.status, createdAt: projectsTable.createdAt })
      .from(projectsTable)
      .where(and(
        eq(projectsTable.companyId, cid),
        inArray(projectsTable.status, billableStatuses as unknown as string[]),
        gte(projectsTable.createdAt, startDate),
        lte(projectsTable.createdAt, endDate),
      ))
      .orderBy(desc(projectsTable.createdAt));

    const result = await Promise.all(projects.map(async (p) => {
      const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.projectId, p.id)).orderBy(desc(quotesTable.id)).limit(1);
      let serviceName = "";
      if (quote) {
        const qItems = await db.select({ productName: quoteItemsTable.productName }).from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).limit(1);
        serviceName = qItems[0]?.productName ?? "";
      }
      return {
        projectId: p.id,
        title: p.title,
        status: p.status,
        createdAt: p.createdAt,
        quoteId: quote?.id ?? null,
        quotePrice: quote ? Number(quote.price) : null,
        quoteStatus: quote?.status ?? null,
        serviceName,
      };
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch billing candidates");
    res.status(500).json({ error: "청구 후보 조회 실패." });
  }
});

// ─── 견적 품목 조회 ──────────────────────────────────────────────────────────
router.get("/admin/projects/:id/quote/items", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 project id." }); return; }
  try {
    const [quote] = await db.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.projectId, projectId)).limit(1);
    if (!quote) { res.json([]); return; }
    const items = await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quote.id)).orderBy(quoteItemsTable.id);
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch quote items");
    res.status(500).json({ error: "품목 조회 실패." });
  }
});

// ─── 관리자 결제 등록 ──────────────────────────────────────────────────────
router.post("/admin/projects/:id/payment", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 project id." }); return; }

  const { amount, paymentDate, paymentMethod, paymentNote } = req.body as {
    amount?: number; paymentDate?: string; paymentMethod?: string; paymentNote?: string;
  };
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    res.status(400).json({ error: "유효한 결제 금액(원)이 필요합니다." }); return;
  }

  try {
    const [project] = await db.select({ id: projectsTable.id, status: projectsTable.status }).from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }
    if (project.status !== "approved") { res.status(400).json({ error: `결제 등록은 '견적 승인' 상태에서만 가능합니다. (현재: ${project.status})` }); return; }

    const existing = await db.select({ id: paymentsTable.id }).from(paymentsTable).where(and(eq(paymentsTable.projectId, projectId), eq(paymentsTable.status, "paid")));
    if (existing.length > 0) { res.status(400).json({ error: "이미 결제 완료된 프로젝트입니다." }); return; }

    const result = await db.transaction(async tx => {
      const [payment] = await tx.insert(paymentsTable).values({
        projectId, amount: String(Number(amount)), status: "paid",
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
        paymentMethod: paymentMethod || null,
        paymentNote: paymentNote || null,
      }).returning();
      await tx.update(projectsTable).set({ status: "paid" }).where(eq(projectsTable.id, projectId));
      await tx.update(quotesTable).set({ status: "approved" }).where(eq(quotesTable.projectId, projectId));
      return payment;
    });
    await logEvent("project", projectId, "payment_received", req.log, req.user ?? undefined);
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to record payment");
    res.status(500).json({ error: "결제 등록 실패." });
  }
});

// ─── 관리자 정산 수동 생성 ─────────────────────────────────────────────────
router.post("/admin/projects/:id/settlement", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) { res.status(400).json({ error: "유효하지 않은 project id." }); return; }

  try {
    const [existingSettlement] = await db.select({ id: settlementsTable.id }).from(settlementsTable).where(eq(settlementsTable.projectId, projectId));
    if (existingSettlement) { res.status(400).json({ error: "이미 정산이 존재합니다." }); return; }

    const [payment] = await db.select().from(paymentsTable).where(and(eq(paymentsTable.projectId, projectId), eq(paymentsTable.status, "paid")));
    if (!payment) { res.status(400).json({ error: "결제 완료 데이터가 없습니다. 먼저 결제를 등록해주세요." }); return; }

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.projectId, projectId));
    if (!task?.translatorId) { res.status(400).json({ error: "배정된 번역사가 없습니다. 번역사를 배정한 후 정산을 생성해주세요." }); return; }

    const total = Number(payment.amount);
    const fee = Math.round(total * 0.2);
    const [settlement] = await db.insert(settlementsTable).values({
      projectId, translatorId: task.translatorId, paymentId: payment.id,
      totalAmount: String(total), translatorAmount: String(total - fee), platformFee: String(fee),
      status: "ready",
    }).returning();
    await logEvent("project", projectId, "settlement_created", req.log, req.user ?? undefined);
    res.status(201).json(settlement);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to create settlement");
    res.status(500).json({ error: "정산 생성 실패." });
  }
});

// ─── 결제 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/payments", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: paymentsTable.id,
        projectId: paymentsTable.projectId,
        amount: paymentsTable.amount,
        status: paymentsTable.status,
        createdAt: paymentsTable.createdAt,
        projectTitle: projectsTable.title,
        projectStatus: projectsTable.status,
      })
      .from(paymentsTable)
      .leftJoin(projectsTable, eq(paymentsTable.projectId, projectsTable.id))
      .orderBy(paymentsTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch payments");
    res.status(500).json({ error: "결제 조회 실패." });
  }
});

// ─── 작업 목록 ─────────────────────────────────────────────────────────────
router.get("/admin/tasks", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: tasksTable.id,
        projectId: tasksTable.projectId,
        translatorId: tasksTable.translatorId,
        status: tasksTable.status,
        createdAt: tasksTable.createdAt,
        projectTitle: projectsTable.title,
        projectStatus: projectsTable.status,
        translatorEmail: usersTable.email,
        translatorName: usersTable.name,
      })
      .from(tasksTable)
      .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
      .leftJoin(usersTable, eq(tasksTable.translatorId, usersTable.id))
      .orderBy(tasksTable.createdAt);

    res.json(rows.reverse());
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch tasks");
    res.status(500).json({ error: "작업 조회 실패." });
  }
});

// ─── 이벤트 로그 ───────────────────────────────────────────────────────────
router.get("/admin/logs/:projectId", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 projectId." });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(logsTable)
      .where(eq(logsTable.entityId, projectId))
      .orderBy(logsTable.createdAt);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch logs");
    res.status(500).json({ error: "로그 조회 실패." });
  }
});

// ─── 관리자 이메일 변경 ────────────────────────────────────────────────────
router.patch("/admin/update-email", ...adminGuard, async (req, res) => {
  const { newEmail } = req.body as { newEmail?: string };

  if (!newEmail || typeof newEmail !== "string" || !newEmail.trim()) {
    res.status(400).json({ error: "newEmail은 필수입니다." });
    return;
  }

  const trimmed = newEmail.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    res.status(400).json({ error: "올바른 이메일 형식을 입력해주세요." });
    return;
  }

  const adminId = req.user!.id;

  try {
    const duplicates = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.email, trimmed), ne(usersTable.id, adminId)))
      .limit(1);

    if (duplicates.length > 0) {
      res.status(409).json({ error: "이미 사용 중인 이메일입니다." });
      return;
    }

    const [updated] = await db
      .update(usersTable)
      .set({ email: trimmed })
      .where(eq(usersTable.id, adminId))
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role });

    if (!updated) {
      res.status(404).json({ error: "계정을 찾을 수 없습니다." });
      return;
    }

    res.json({ message: "이메일이 변경되었습니다.", email: updated.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update email");
    res.status(500).json({ error: "이메일 변경 실패." });
  }
});

// ─── 사용자 목록 ───────────────────────────────────────────────────────────
router.get("/admin/users", ...adminGuard, async (req, res) => {
  try {
    const { search, role } = req.query as { search?: string; role?: string };

    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        isActive: usersTable.isActive,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt);

    let result = rows.reverse();

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(u =>
        u.email.toLowerCase().includes(s) ||
        (u.name ?? "").toLowerCase().includes(s)
      );
    }

    if (role?.trim() && ["customer", "translator", "admin"].includes(role.trim())) {
      result = result.filter(u => u.role === role.trim());
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch users");
    res.status(500).json({ error: "사용자 조회 실패." });
  }
});

// ─── 사용자 역할 변경 ─────────────────────────────────────────────────────
router.patch("/admin/users/:id/name", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  const { name } = req.body as { name?: string };
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  try {
    const [updated] = await db
      .update(usersTable)
      .set({ name: name?.trim() || null })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role });
    if (!updated) { res.status(404).json({ error: "사용자를 찾을 수 없습니다." }); return; }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update user name");
    res.status(500).json({ error: "이름 변경 실패." });
  }
});

router.patch("/admin/users/:id/role", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  const { role } = req.body as { role?: string };

  if (!role || !["customer", "translator"].includes(role)) {
    res.status(400).json({ error: "role은 'customer' 또는 'translator'만 가능합니다." });
    return;
  }

  if (userId === req.user!.id) {
    res.status(400).json({ error: "본인의 역할은 변경할 수 없습니다." });
    return;
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }
    if (user.role === "admin") {
      res.status(400).json({ error: "관리자 계정의 역할은 변경할 수 없습니다." });
      return;
    }

    const [updated] = await db
      .update(usersTable)
      .set({ role: role as "customer" | "translator" })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive, createdAt: usersTable.createdAt });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update user role");
    res.status(500).json({ error: "역할 변경 실패." });
  }
});

// ─── 관리자 비밀번호 재설정 (개발/운영용) ────────────────────────────────
router.patch("/admin/users/:id/reset-password", ...adminGuard, async (req, res) => {
  const targetId = Number(req.params.id);
  const { newPassword } = req.body as { newPassword?: string };

  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." });
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ error: "새 비밀번호는 최소 6자 이상이어야 합니다." });
    return;
  }

  try {
    const [target] = await db.select({ id: usersTable.id, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, targetId));
    if (!target) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }
    if (target.role === "admin" && target.id !== req.user!.id) {
      res.status(403).json({ error: "다른 관리자의 비밀번호는 변경할 수 없습니다." });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable).set({ password: hashed }).where(eq(usersTable.id, targetId));
    req.log.info({ adminId: req.user!.id, targetId }, "Admin reset password for user");
    res.json({ ok: true, message: "비밀번호가 재설정되었습니다." });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to reset password");
    res.status(500).json({ error: "비밀번호 재설정 실패." });
  }
});

// ─── 사용자 활성화/비활성화 ───────────────────────────────────────────────
router.patch("/admin/users/:id/deactivate", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);

  if (userId === req.user!.id) {
    res.status(400).json({ error: "본인 계정은 비활성화할 수 없습니다." });
    return;
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) {
      res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      return;
    }

    const newActive = !user.isActive;
    const [updated] = await db
      .update(usersTable)
      .set({ isActive: newActive })
      .where(eq(usersTable.id, userId))
      .returning({ id: usersTable.id, email: usersTable.email, role: usersTable.role, isActive: usersTable.isActive, createdAt: usersTable.createdAt });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to toggle user active state");
    res.status(500).json({ error: "계정 상태 변경 실패." });
  }
});

// ─── 관리자 메모 ───────────────────────────────────────────────────────────
router.get("/admin/projects/:id/notes", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  try {
    const rows = await db
      .select({
        id: notesTable.id,
        entityType: notesTable.entityType,
        entityId: notesTable.entityId,
        content: notesTable.content,
        createdAt: notesTable.createdAt,
        adminEmail: usersTable.email,
      })
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
      .where(and(eq(notesTable.entityType, "project"), eq(notesTable.entityId, projectId)))
      .orderBy(notesTable.createdAt);

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch notes");
    res.status(500).json({ error: "메모 조회 실패." });
  }
});

router.post("/admin/projects/:id/notes", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  const { content } = req.body as { content?: string };
  if (!content?.trim()) {
    res.status(400).json({ error: "메모 내용을 입력해주세요." });
    return;
  }

  try {
    const [note] = await db
      .insert(notesTable)
      .values({ entityType: "project", entityId: projectId, adminId: req.user!.id, content: content.trim() })
      .returning();

    await logEvent("project", projectId, "note_added", req.log, req.user ?? undefined);

    res.status(201).json({ ...note, adminEmail: req.user!.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to add note");
    res.status(500).json({ error: "메모 추가 실패." });
  }
});

// ─── 범용 메모 API (entityType: project/company/contact/translator) ────────────
router.get("/admin/notes", ...adminGuard, async (req, res) => {
  const { entityType, entityId } = req.query as { entityType?: string; entityId?: string };
  if (!entityType || !entityId) {
    res.status(400).json({ error: "entityType과 entityId는 필수입니다." }); return;
  }

  try {
    const rows = await db
      .select({
        id: notesTable.id,
        entityType: notesTable.entityType,
        entityId: notesTable.entityId,
        content: notesTable.content,
        createdAt: notesTable.createdAt,
        adminEmail: usersTable.email,
        adminId: notesTable.adminId,
      })
      .from(notesTable)
      .leftJoin(usersTable, eq(notesTable.adminId, usersTable.id))
      .where(and(eq(notesTable.entityType, entityType), eq(notesTable.entityId, Number(entityId))))
      .orderBy(desc(notesTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch generic notes");
    res.status(500).json({ error: "메모 조회 실패." });
  }
});

router.post("/admin/notes", ...adminGuard, async (req, res) => {
  const { entityType, entityId, content } = req.body as {
    entityType?: string; entityId?: number; content?: string;
  };

  const validTypes = ["project", "company", "contact", "translator"];
  if (!entityType || !validTypes.includes(entityType)) {
    res.status(400).json({ error: `entityType은 ${validTypes.join("/")} 중 하나여야 합니다.` }); return;
  }
  if (!entityId || isNaN(entityId)) {
    res.status(400).json({ error: "entityId는 필수입니다." }); return;
  }
  if (!content?.trim()) {
    res.status(400).json({ error: "메모 내용을 입력해주세요." }); return;
  }

  try {
    const [note] = await db
      .insert(notesTable)
      .values({ entityType, entityId: Number(entityId), adminId: req.user!.id, content: content.trim() })
      .returning();
    res.status(201).json({ ...note, adminEmail: req.user!.email });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to add generic note");
    res.status(500).json({ error: "메모 추가 실패." });
  }
});

// ─── 담당자 지정 ────────────────────────────────────────────────────────────
router.patch("/admin/projects/:id/assign", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." });
    return;
  }

  const { adminId } = req.body as { adminId: number | null };

  try {
    const [existing] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!existing) { res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." }); return; }

    if (adminId !== null && adminId !== undefined) {
      const [admin] = await db.select().from(usersTable)
        .where(and(eq(usersTable.id, adminId), eq(usersTable.role, "admin")));
      if (!admin) { res.status(400).json({ error: "유효한 관리자가 아닙니다." }); return; }
    }

    const [updated] = await db
      .update(projectsTable)
      .set({ adminId: adminId ?? null })
      .where(eq(projectsTable.id, projectId))
      .returning();

    await logEvent("project", projectId, `담당자 ${adminId ? `지정 (adminId=${adminId})` : "해제"}`, req.log, req.user ?? undefined);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to assign admin");
    res.status(500).json({ error: "담당자 지정 실패." });
  }
});

// ─── 고객 목록 ──────────────────────────────────────────────────────────────
router.get("/admin/customers", ...adminGuard, async (req, res) => {
  try {
    const { search } = req.query as { search?: string };

    const rows = await db
      .select({
        id: customersTable.id,
        companyName: customersTable.companyName,
        contactName: customersTable.contactName,
        email: customersTable.email,
        phone: customersTable.phone,
        createdAt: customersTable.createdAt,
        projectCount: sql<number>`COUNT(DISTINCT ${projectsTable.id})::int`,
        totalPayment: sql<number>`COALESCE(SUM(${paymentsTable.amount}) FILTER (WHERE ${paymentsTable.status} = 'paid'), 0)::int`,
        unpaidAmount: sql<number>`(
          SELECT COALESCE(SUM(q.price), 0)::int
          FROM projects p2
          JOIN quotes q ON q.project_id = p2.id
          WHERE p2.customer_id = ${customersTable.id} AND q.status = 'approved'
        )`,
        lastTransactionAt: sql<string | null>`(
          SELECT MAX(pay.created_at)::text
          FROM projects p2
          JOIN payments pay ON pay.project_id = p2.id
          WHERE p2.customer_id = ${customersTable.id} AND pay.status = 'paid'
        )`,
        inProgressCount: sql<number>`(
          SELECT COUNT(p2.id)::int FROM projects p2
          WHERE p2.customer_id = ${customersTable.id}
            AND p2.status IN ('in_progress','matched','paid','approved')
        )`,
      })
      .from(customersTable)
      .leftJoin(projectsTable, eq(projectsTable.customerId, customersTable.id))
      .leftJoin(paymentsTable, eq(paymentsTable.projectId, projectsTable.id))
      .groupBy(customersTable.id)
      .orderBy(desc(customersTable.createdAt));

    let result = rows;
    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(c =>
        c.companyName.toLowerCase().includes(s) ||
        c.contactName.toLowerCase().includes(s) ||
        c.email.toLowerCase().includes(s)
      );
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch customers");
    res.status(500).json({ error: "고객 조회 실패." });
  }
});

// ─── 고객 생성 ──────────────────────────────────────────────────────────────
router.post("/admin/customers", ...adminGuard, async (req, res) => {
  const { companyName, contactName, email, phone } = req.body as {
    companyName?: string; contactName?: string; email?: string; phone?: string;
  };

  if (!companyName?.trim() || !contactName?.trim() || !email?.trim()) {
    res.status(400).json({ error: "회사명, 담당자명, 이메일은 필수입니다." });
    return;
  }

  try {
    const [customer] = await db
      .insert(customersTable)
      .values({ companyName: companyName.trim(), contactName: contactName.trim(), email: email.trim(), phone: phone?.trim() })
      .returning();
    res.status(201).json(customer);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to create customer");
    res.status(500).json({ error: "고객 생성 실패." });
  }
});

// ─── 고객 상세 ──────────────────────────────────────────────────────────────
router.get("/admin/customers/:id", ...adminGuard, async (req, res) => {
  const customerId = Number(req.params.id);
  if (isNaN(customerId) || customerId <= 0) {
    res.status(400).json({ error: "유효하지 않은 customer id." });
    return;
  }

  try {
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
    if (!customer) { res.status(404).json({ error: "고객을 찾을 수 없습니다." }); return; }

    const projects = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        createdAt: projectsTable.createdAt,
      })
      .from(projectsTable)
      .where(eq(projectsTable.customerId, customerId))
      .orderBy(desc(projectsTable.createdAt));

    const projectIds = projects.map(p => p.id);

    let totalPayment = 0;
    let totalSettlement = 0;

    if (projectIds.length > 0) {
      const [payRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${paymentsTable.amount}), 0)::int` })
        .from(paymentsTable)
        .where(and(inArray(paymentsTable.projectId, projectIds), eq(paymentsTable.status, "paid")));
      totalPayment = payRow?.total ?? 0;

      const [setRow] = await db
        .select({ total: sql<number>`COALESCE(SUM(${settlementsTable.translatorAmount}), 0)::int` })
        .from(settlementsTable)
        .where(inArray(settlementsTable.projectId, projectIds));
      totalSettlement = setRow?.total ?? 0;
    }

    res.json({ ...customer, projects, totalPayment, totalSettlement });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch customer detail");
    res.status(500).json({ error: "고객 상세 조회 실패." });
  }
});

// ─── 고객 수정 ──────────────────────────────────────────────────────────────
router.patch("/admin/customers/:id", ...adminGuard, async (req, res) => {
  const customerId = Number(req.params.id);
  if (isNaN(customerId) || customerId <= 0) {
    res.status(400).json({ error: "유효하지 않은 customer id." }); return;
  }

  const { companyName, contactName, email, phone } = req.body as {
    companyName?: string; contactName?: string; email?: string; phone?: string;
  };

  try {
    const [existing] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
    if (!existing) { res.status(404).json({ error: "고객을 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(customersTable)
      .set({
        companyName: companyName?.trim() ?? existing.companyName,
        contactName: contactName?.trim() ?? existing.contactName,
        email: email?.trim() ?? existing.email,
        phone: phone?.trim() ?? existing.phone,
      })
      .where(eq(customersTable.id, customerId))
      .returning();

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update customer");
    res.status(500).json({ error: "고객 수정 실패." });
  }
});

// ─── 커뮤니케이션 생성 ───────────────────────────────────────────────────────
router.post("/admin/communications", ...adminGuard, async (req, res) => {
  const { customerId, projectId, type, content } = req.body as {
    customerId?: number; projectId?: number; type?: string; content?: string;
  };

  if (!customerId || !content?.trim()) {
    res.status(400).json({ error: "고객 ID와 내용은 필수입니다." }); return;
  }

  const validTypes = ["email", "phone", "message"];
  const commType = validTypes.includes(type ?? "") ? (type as "email" | "phone" | "message") : "message";

  try {
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
    if (!customer) { res.status(404).json({ error: "고객을 찾을 수 없습니다." }); return; }

    const [comm] = await db
      .insert(communicationsTable)
      .values({
        customerId,
        projectId: projectId ?? null,
        type: commType,
        content: content.trim(),
      })
      .returning();

    if (projectId) {
      await logEvent("project", projectId, `communication_added_${commType}`, req.log, req.user ?? undefined);
    }

    res.status(201).json(comm);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to create communication");
    res.status(500).json({ error: "커뮤니케이션 기록 실패." });
  }
});

// ─── 고객별 커뮤니케이션 목록 ─────────────────────────────────────────────
router.get("/admin/customers/:id/communications", ...adminGuard, async (req, res) => {
  const customerId = Number(req.params.id);
  if (isNaN(customerId) || customerId <= 0) {
    res.status(400).json({ error: "유효하지 않은 customer id." }); return;
  }

  try {
    const rows = await db
      .select()
      .from(communicationsTable)
      .where(eq(communicationsTable.customerId, customerId))
      .orderBy(desc(communicationsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch customer communications");
    res.status(500).json({ error: "커뮤니케이션 조회 실패." });
  }
});

// ─── 프로젝트별 커뮤니케이션 목록 ───────────────────────────────────────────
router.get("/admin/projects/:id/communications", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 project id." }); return;
  }

  try {
    const rows = await db
      .select({
        id: communicationsTable.id,
        customerId: communicationsTable.customerId,
        projectId: communicationsTable.projectId,
        type: communicationsTable.type,
        content: communicationsTable.content,
        createdAt: communicationsTable.createdAt,
        companyName: customersTable.companyName,
        contactName: customersTable.contactName,
      })
      .from(communicationsTable)
      .leftJoin(customersTable, eq(communicationsTable.customerId, customersTable.id))
      .where(eq(communicationsTable.projectId, projectId))
      .orderBy(desc(communicationsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to fetch project communications");
    res.status(500).json({ error: "커뮤니케이션 조회 실패." });
  }
});

// ─── 번역사 프로필 조회 ───────────────────────────────────────────────────────
router.get("/admin/translator-profiles/:userId", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.userId);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user || user.role !== "translator") {
      res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return;
    }

    const [profile] = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    res.json({ user: { id: user.id, email: user.email, isActive: user.isActive }, profile: profile ?? null });
  } catch (err) {
    req.log.error({ err }, "Admin: failed to get translator profile");
    res.status(500).json({ error: "번역사 프로필 조회 실패." });
  }
});

// ─── 번역사 프로필 저장/수정 (upsert) ─────────────────────────────────────────
router.patch("/admin/translator-profiles/:userId", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.userId);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  const {
    languagePairs, specializations, education, major,
    graduationYear, region, rating, availabilityStatus, bio,
    ratePerWord, ratePerPage,
  } = req.body;

  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user || user.role !== "translator") {
      res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return;
    }

    const existing = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));

    const profileData = {
      languagePairs, specializations, education, major,
      graduationYear: graduationYear ? Number(graduationYear) : undefined,
      region, rating: rating ? Number(rating) : undefined,
      availabilityStatus: availabilityStatus ?? "available",
      bio, ratePerWord: ratePerWord ? Number(ratePerWord) : undefined,
      ratePerPage: ratePerPage ? Number(ratePerPage) : undefined,
      updatedAt: new Date(),
    };

    let profile;
    if (existing.length === 0) {
      [profile] = await db.insert(translatorProfilesTable).values({ userId, ...profileData }).returning();
    } else {
      [profile] = await db.update(translatorProfilesTable).set(profileData).where(eq(translatorProfilesTable.userId, userId)).returning();
    }
    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to update translator profile");
    res.status(500).json({ error: "번역사 프로필 저장 실패." });
  }
});

// ─── 프로젝트 목록 CSV 내보내기 ───────────────────────────────────────────────
router.get("/admin/export/projects", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        createdAt: projectsTable.createdAt,
        customerEmail: usersTable.email,
      })
      .from(projectsTable)
      .leftJoin(usersTable, eq(projectsTable.userId, usersTable.id))
      .orderBy(desc(projectsTable.createdAt));

    const header = ["ID", "제목", "고객 이메일", "상태", "생성일"].join(",");
    const lines = rows.map(r =>
      [
        r.id,
        `"${(r.title ?? "").replace(/"/g, '""')}"`,
        `"${(r.customerEmail ?? "").replace(/"/g, '""')}"`,
        r.status,
        new Date(r.createdAt).toLocaleDateString("ko-KR"),
      ].join(",")
    );

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="projects_${Date.now()}.csv"`);
    res.send("\uFEFF" + csv);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to export projects");
    res.status(500).json({ error: "내보내기 실패." });
  }
});

// ─── 정산 목록 CSV 내보내기 ───────────────────────────────────────────────────
router.get("/admin/export/settlements", ...adminGuard, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: settlementsTable.id,
        totalAmount: settlementsTable.totalAmount,
        translatorAmount: settlementsTable.translatorAmount,
        platformFee: settlementsTable.platformFee,
        status: settlementsTable.status,
        createdAt: settlementsTable.createdAt,
        projectTitle: projectsTable.title,
        translatorEmail: usersTable.email,
      })
      .from(settlementsTable)
      .leftJoin(projectsTable, eq(settlementsTable.projectId, projectsTable.id))
      .leftJoin(usersTable, eq(settlementsTable.translatorId, usersTable.id))
      .orderBy(desc(settlementsTable.createdAt));

    const header = ["ID", "프로젝트", "번역사 이메일", "총 금액", "번역사 금액", "수수료", "상태", "생성일"].join(",");
    const lines = rows.map(r =>
      [
        r.id,
        `"${(r.projectTitle ?? "").replace(/"/g, '""')}"`,
        `"${(r.translatorEmail ?? "").replace(/"/g, '""')}"`,
        r.totalAmount,
        r.translatorAmount,
        r.platformFee,
        r.status,
        new Date(r.createdAt).toLocaleDateString("ko-KR"),
      ].join(",")
    );

    const csv = [header, ...lines].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="settlements_${Date.now()}.csv"`);
    res.send("\uFEFF" + csv);
  } catch (err) {
    req.log.error({ err }, "Admin: failed to export settlements");
    res.status(500).json({ error: "내보내기 실패." });
  }
});

export default router;
