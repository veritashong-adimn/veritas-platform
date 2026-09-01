import { Router, type IRouter } from "express";
import {
  db, customersTable, projectsTable, paymentsTable,
  settlementsTable, communicationsTable,
} from "@workspace/db";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { logEvent } from "../../lib/logEvent";
import { EFFECTIVE_REVENUE_SQL } from "../../services/quoteRelation";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

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
        // 견적 엔진 SSOT: 유효 견적만 합산(is_current·미삭제·파생 아님·approved).
        //  revision 이전본/파생 이중집계 방지. 현행 데이터(relation NULL·전부 is_current)는 동작 불변.
        unpaidAmount: sql<number>`(
          SELECT COALESCE(SUM(q.price), 0)::int
          FROM projects p2
          JOIN quotes q ON q.project_id = p2.id
          WHERE p2.customer_id = ${customersTable.id} AND ${EFFECTIVE_REVENUE_SQL}
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

export default router;
