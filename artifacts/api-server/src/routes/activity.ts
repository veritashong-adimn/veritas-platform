import { Router, type IRouter } from "express";
import { db, usersTable, userSessionsTable } from "@workspace/db";
import { desc, gte, lte, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminOnly = [requireAuth, requireRole("admin")];

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

function dateRange(period: string): { start: Date; end: Date } {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffset);

  const todayStart = new Date(
    Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - kstOffset
  );
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  switch (period) {
    case "today":
      return { start: todayStart, end: todayEnd };
    case "week": {
      const day = kstNow.getUTCDay();
      const weekStart = new Date(todayStart.getTime() - day * 86400000);
      return { start: weekStart, end: todayEnd };
    }
    case "month": {
      const monthStart = new Date(
        Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), 1) - kstOffset
      );
      return { start: monthStart, end: todayEnd };
    }
    case "year": {
      const yearStart = new Date(
        Date.UTC(kstNow.getUTCFullYear(), 0, 1) - kstOffset
      );
      return { start: yearStart, end: todayEnd };
    }
    default:
      return { start: todayStart, end: todayEnd };
  }
}

/** GET /api/admin/activity/online  - 현재 온라인 사용자 목록 (5분 이내 활동) */
router.get("/admin/activity/online", adminOnly, async (req, res) => {
  const threshold = new Date(Date.now() - ONLINE_THRESHOLD_MS);

  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      lastActivityAt: usersTable.lastActivityAt,
      lastLoginAt: usersTable.lastLoginAt,
    })
    .from(usersTable)
    .where(gte(usersTable.lastActivityAt, threshold))
    .orderBy(desc(usersTable.lastActivityAt));

  res.json(rows);
});

/** GET /api/admin/activity/stats?period=today|week|month|year  - 기간별 접속 통계 */
router.get("/admin/activity/stats", adminOnly, async (req, res) => {
  const period = (req.query.period as string) || "today";
  const { start, end } = dateRange(period);

  const [loginCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userSessionsTable)
    .where(and(gte(userSessionsTable.loginAt, start), lte(userSessionsTable.loginAt, end)));

  const [uniqueUsers] = await db
    .select({ count: sql<number>`count(distinct user_id)::int` })
    .from(userSessionsTable)
    .where(and(gte(userSessionsTable.loginAt, start), lte(userSessionsTable.loginAt, end)));

  const byRole = await db
    .select({
      roleType: userSessionsTable.roleType,
      count: sql<number>`count(distinct user_id)::int`,
    })
    .from(userSessionsTable)
    .where(and(gte(userSessionsTable.loginAt, start), lte(userSessionsTable.loginAt, end)))
    .groupBy(userSessionsTable.roleType);

  const onlineThreshold = new Date(Date.now() - ONLINE_THRESHOLD_MS);
  const [onlineCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(gte(usersTable.lastActivityAt, onlineThreshold));

  // 오늘/이번주/이번달/올해 고유 접속자 요약
  const summary = {
    today: 0, week: 0, month: 0, year: 0, currentlyOnline: onlineCount?.count ?? 0,
  };
  for (const p of ["today", "week", "month", "year"] as const) {
    const r = dateRange(p);
    const [row] = await db
      .select({ count: sql<number>`count(distinct user_id)::int` })
      .from(userSessionsTable)
      .where(and(gte(userSessionsTable.loginAt, r.start), lte(userSessionsTable.loginAt, r.end)));
    summary[p] = row?.count ?? 0;
  }

  res.json({
    period,
    range: { start, end },
    loginCount: loginCount?.count ?? 0,
    uniqueUsers: uniqueUsers?.count ?? 0,
    byRole,
    summary,
  });
});

/** GET /api/admin/activity/chart?period=today|week|month|year  - 차트용 일별/기간별 로그인 수 */
router.get("/admin/activity/chart", adminOnly, async (req, res) => {
  const period = (req.query.period as string) || "week";
  const { start } = dateRange(period);

  const rows = await db
    .select({
      dateKey: userSessionsTable.dateKey,
      count: sql<number>`count(*)::int`,
      uniqueUsers: sql<number>`count(distinct user_id)::int`,
    })
    .from(userSessionsTable)
    .where(gte(userSessionsTable.loginAt, start))
    .groupBy(userSessionsTable.dateKey)
    .orderBy(userSessionsTable.dateKey);

  res.json(rows);
});

/** GET /api/admin/activity/user-stats  - 사용자별 누적 로그인 횟수 + 이용시간 (어드민 전용) */
router.get("/admin/activity/user-stats", adminOnly, async (req, res) => {
  const limit = parseInt((req.query.limit as string) || "50");

  const rows = await db
    .select({
      userId: userSessionsTable.userId,
      loginCount: sql<number>`count(*)::int`,
      totalActiveSeconds: sql<number>`
        coalesce(
          sum(
            extract(epoch from (coalesce(logout_at, last_activity_at) - login_at))
          )::int, 0
        )
      `,
      lastLoginAt: sql<string>`max(login_at)::text`,
      lastActivityAt: sql<string>`max(last_activity_at)::text`,
    })
    .from(userSessionsTable)
    .groupBy(userSessionsTable.userId)
    .orderBy(sql`count(*) desc`)
    .limit(limit);

  // 사용자명 조인
  const userIds = rows.map(r => r.userId);
  if (userIds.length === 0) {
    res.json([]);
    return;
  }

  const users = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
    .from(usersTable);

  const userMap = new Map(users.map(u => [u.id, u]));

  const result = rows.map(r => ({
    ...r,
    user: userMap.get(r.userId) ?? null,
    totalActiveMinutes: Math.round((r.totalActiveSeconds ?? 0) / 60),
  }));

  res.json(result);
});

export default router;
