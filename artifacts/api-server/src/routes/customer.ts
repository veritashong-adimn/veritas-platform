/**
 * 고객 포털 전용 라우트
 *
 * 조회 권한 규칙 (OR 조건):
 *   A. project.customerUserId = currentUser.id
 *   B. currentUser.companyId IS NOT NULL
 *      AND project.requestingCompanyId = currentUser.companyId
 */
import { Router } from "express";
import { db, projectsTable, usersTable, quotesTable } from "@workspace/db";
import { eq, or, and, isNotNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";

const router = Router();

/** 현재 사용자가 해당 프로젝트에 접근 가능한지 확인 */
function canAccessProject(
  project: { customerUserId: number | null; requestingCompanyId: number | null },
  user: { id: number; companyId: number | null },
): boolean {
  if (project.customerUserId === user.id) return true;
  if (user.companyId && project.requestingCompanyId === user.companyId) return true;
  return false;
}

// ─── 프로젝트 목록 ─────────────────────────────────────────────────────────
router.get("/customer/projects", requireAuth, async (req, res) => {
  const currentUser = req.user!;

  // 고객 계정만 허용
  if (!["customer", "client"].includes(currentUser.role)) {
    res.status(403).json({ error: "고객 계정만 접근 가능합니다." });
    return;
  }

  try {
    // 현재 사용자의 companyId 조회
    const [userRecord] = await db
      .select({ id: usersTable.id, companyId: usersTable.companyId })
      .from(usersTable)
      .where(eq(usersTable.id, currentUser.id));

    const userCompanyId = userRecord?.companyId ?? null;

    // 권한 조건 구성
    const conditions = [eq(projectsTable.customerUserId, currentUser.id)];
    if (userCompanyId) {
      conditions.push(
        and(
          isNotNull(projectsTable.requestingCompanyId),
          eq(projectsTable.requestingCompanyId, userCompanyId),
        ) as any,
      );
    }

    const projects = await db
      .select({
        id: projectsTable.id,
        title: projectsTable.title,
        status: projectsTable.status,
        financialStatus: projectsTable.financialStatus,
        createdAt: projectsTable.createdAt,
        fileUrl: projectsTable.fileUrl,
        customerUserId: projectsTable.customerUserId,
        requestingCompanyId: projectsTable.requestingCompanyId,
      })
      .from(projectsTable)
      .where(or(...conditions))
      .orderBy(projectsTable.createdAt);

    // 가장 최신 순으로 정렬
    const sorted = projects.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    req.log.info(
      { userId: currentUser.id, userCompanyId, count: sorted.length },
      "customer_access_company_projects",
    );

    res.json(sorted);
  } catch (err: any) {
    req.log.error({ err: err?.message }, "Customer: failed to fetch projects");
    res.status(500).json({ error: "프로젝트 목록 조회 실패." });
  }
});

// ─── 프로젝트 상세 ─────────────────────────────────────────────────────────
router.get("/customer/projects/:id", requireAuth, async (req, res) => {
  const currentUser = req.user!;

  if (!["customer", "client"].includes(currentUser.role)) {
    res.status(403).json({ error: "고객 계정만 접근 가능합니다." });
    return;
  }

  const projectId = Number(req.params.id);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: "유효하지 않은 프로젝트 ID입니다." });
    return;
  }

  try {
    // 사용자 companyId 조회
    const [userRecord] = await db
      .select({ companyId: usersTable.companyId })
      .from(usersTable)
      .where(eq(usersTable.id, currentUser.id));

    const userCompanyId = userRecord?.companyId ?? null;

    // 프로젝트 조회
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project) {
      res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
      return;
    }

    // 권한 검증 (백엔드 강제)
    const hasAccess = canAccessProject(
      { customerUserId: project.customerUserId, requestingCompanyId: project.requestingCompanyId },
      { id: currentUser.id, companyId: userCompanyId },
    );

    if (!hasAccess) {
      req.log.warn(
        { userId: currentUser.id, projectId, userCompanyId },
        "customer_access_denied_foreign_company",
      );
      res.status(403).json({ error: "이 프로젝트에 접근할 권한이 없습니다." });
      return;
    }

    // 견적 정보도 함께 조회
    const quotes = await db
      .select()
      .from(quotesTable)
      .where(eq(quotesTable.projectId, projectId))
      .orderBy(quotesTable.createdAt);

    await logEvent("project", projectId, "customer_access_company_projects", req.log, currentUser);

    res.json({ ...project, quotes });
  } catch (err: any) {
    req.log.error({ err: err?.message }, "Customer: failed to fetch project detail");
    res.status(500).json({ error: "프로젝트 상세 조회 실패." });
  }
});

export default router;
