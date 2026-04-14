import { Router, type IRouter } from "express";
import { db, translationUnitsTable, translationUnitLogsTable } from "@workspace/db";
import { eq, and, or, ilike, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  anonymizeTranslationUnit,
  bulkAnonymizeByProject,
  excludeTranslationUnit,
  buildTranslationUnitsFromPairs,
  rebuildTranslationUnitsForProject,
  segmentTranslationPair,
  type TextPair,
} from "../services/translationUnitService";
import { logEvent } from "../lib/logEvent";

const router: IRouter = Router();

const adminOnly = [requireAuth, requireRole("admin")];
const staffPlus = [requireAuth, requireRole("admin", "staff")];

// ─── GET /api/admin/translation-units/stats ──────────────────────────────────
router.get("/admin/translation-units/stats", ...staffPlus, async (req, res) => {
  try {
    const total = await db.select({ count: sql<number>`count(*)::int` }).from(translationUnitsTable);
    const byStatus = await db.select({
      status: translationUnitsTable.status,
      count: sql<number>`count(*)::int`,
    }).from(translationUnitsTable).groupBy(translationUnitsTable.status);

    const byDomain = await db.select({
      domain: translationUnitsTable.domain,
      count: sql<number>`count(*)::int`,
    }).from(translationUnitsTable)
      .where(eq(translationUnitsTable.status, "active"))
      .groupBy(translationUnitsTable.domain);

    const byLang = await db.select({
      sourceLang: translationUnitsTable.sourceLang,
      targetLang: translationUnitsTable.targetLang,
      count: sql<number>`count(*)::int`,
    }).from(translationUnitsTable)
      .where(eq(translationUnitsTable.status, "active"))
      .groupBy(translationUnitsTable.sourceLang, translationUnitsTable.targetLang);

    res.json({ total: total[0].count, byStatus, byDomain, byLang });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to get stats");
    res.status(500).json({ error: "통계 조회 실패" });
  }
});

// ─── GET /api/admin/translation-units ────────────────────────────────────────
router.get("/admin/translation-units", ...staffPlus, async (req, res) => {
  try {
    const {
      projectId, translatorId, sourceLang, targetLang,
      domain, qualityLevel, securityLevel, status,
      q, page = "1", limit = "50",
    } = req.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));
    const offset = (pageNum - 1) * limitNum;

    const conditions: ReturnType<typeof eq>[] = [];

    if (projectId) conditions.push(eq(translationUnitsTable.projectId, Number(projectId)));
    if (translatorId) conditions.push(eq(translationUnitsTable.translatorId, Number(translatorId)));
    if (sourceLang) conditions.push(eq(translationUnitsTable.sourceLang, sourceLang));
    if (targetLang) conditions.push(eq(translationUnitsTable.targetLang, targetLang));
    if (domain) conditions.push(eq(translationUnitsTable.domain, domain));
    if (qualityLevel) conditions.push(eq(translationUnitsTable.qualityLevel, qualityLevel));
    if (securityLevel) conditions.push(eq(translationUnitsTable.securityLevel, securityLevel));
    if (status) conditions.push(eq(translationUnitsTable.status, status));

    const baseWhere = conditions.length > 0 ? and(...conditions) : undefined;

    let totalQuery = db
      .select({ count: sql<number>`count(*)::int` })
      .from(translationUnitsTable)
      .$dynamic();

    let dataQuery = db
      .select()
      .from(translationUnitsTable)
      .$dynamic();

    if (q?.trim()) {
      const search = `%${q.trim()}%`;
      const textFilter = or(
        ilike(translationUnitsTable.sourceText, search),
        ilike(translationUnitsTable.targetText, search),
      );
      const combinedWhere = baseWhere ? and(baseWhere, textFilter) : textFilter;
      totalQuery = totalQuery.where(combinedWhere);
      dataQuery = dataQuery.where(combinedWhere);
    } else if (baseWhere) {
      totalQuery = totalQuery.where(baseWhere);
      dataQuery = dataQuery.where(baseWhere);
    }

    const [{ count }] = await totalQuery;
    const rows = await dataQuery
      .orderBy(translationUnitsTable.projectId, translationUnitsTable.segmentIndex)
      .limit(limitNum)
      .offset(offset);

    res.json({ total: count, page: pageNum, limit: limitNum, data: rows });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to list translation units");
    res.status(500).json({ error: "조회 실패" });
  }
});

// ─── GET /api/admin/translation-units/:id ────────────────────────────────────
router.get("/admin/translation-units/:id", ...staffPlus, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "유효하지 않은 id" }); return; }

  try {
    const [unit] = await db.select().from(translationUnitsTable).where(eq(translationUnitsTable.id, id));
    if (!unit) { res.status(404).json({ error: "찾을 수 없습니다." }); return; }

    const logs = await db
      .select()
      .from(translationUnitLogsTable)
      .where(eq(translationUnitLogsTable.translationUnitId, id))
      .orderBy(translationUnitLogsTable.createdAt);

    res.json({ ...unit, logs });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to get translation unit");
    res.status(500).json({ error: "조회 실패" });
  }
});

// ─── POST /api/admin/projects/:id/translation-units ──────────────────────────
// 새 pair 직접 추가
router.post("/admin/projects/:id/translation-units", ...adminOnly, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId)) { res.status(400).json({ error: "유효하지 않은 project id" }); return; }

  const { sourceText, targetText, sourceLang, targetLang, domain } = req.body as {
    sourceText?: string; targetText?: string;
    sourceLang?: string; targetLang?: string; domain?: string;
  };

  if (!sourceText?.trim() || !targetText?.trim()) {
    res.status(400).json({ error: "sourceText와 targetText는 필수입니다." }); return;
  }

  try {
    const pair: TextPair = { sourceText, targetText, sourceLang, targetLang, domain };
    const { count } = await buildTranslationUnitsFromPairs(
      projectId, [pair], req.user?.id ?? null, req.log,
    );

    await logEvent("project", projectId, "translation_unit_created", req.log, req.user ?? undefined,
      JSON.stringify({ count }));

    res.status(201).json({ count });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to add translation units");
    res.status(500).json({ error: "저장 실패" });
  }
});

// ─── POST /api/admin/projects/:id/translation-units/rebuild ──────────────────
router.post("/admin/projects/:id/translation-units/rebuild", ...adminOnly, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId)) { res.status(400).json({ error: "유효하지 않은 project id" }); return; }

  const { pairs } = req.body as { pairs?: TextPair[] };

  if (!Array.isArray(pairs) || pairs.length === 0) {
    res.status(400).json({ error: "pairs 배열이 필요합니다." }); return;
  }

  try {
    const { count } = await rebuildTranslationUnitsForProject(
      projectId, pairs, req.user?.id ?? null, req.log,
    );

    await logEvent("project", projectId, "translation_units_rebuilt", req.log, req.user ?? undefined,
      JSON.stringify({ count }));

    res.json({ count });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to rebuild translation units");
    res.status(500).json({ error: "재생성 실패" });
  }
});

// ─── POST /api/admin/translation-units/:id/anonymize ─────────────────────────
router.post("/admin/translation-units/:id/anonymize", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "유효하지 않은 id" }); return; }

  try {
    const result = await anonymizeTranslationUnit(id, req.user?.id ?? null);
    if (!result.ok) {
      if (result.error === "not_found") { res.status(404).json({ error: "찾을 수 없습니다." }); return; }
      res.status(500).json({ error: result.error }); return;
    }

    await logEvent("translation_unit", id, "translation_unit_anonymized", req.log, req.user ?? undefined);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to anonymize");
    res.status(500).json({ error: "익명화 실패" });
  }
});

// ─── POST /api/admin/projects/:id/translation-units/anonymize ────────────────
router.post("/admin/projects/:id/translation-units/anonymize", ...adminOnly, async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId)) { res.status(400).json({ error: "유효하지 않은 project id" }); return; }

  try {
    const { count } = await bulkAnonymizeByProject(projectId, req.user?.id ?? null);

    await logEvent("project", projectId, "translation_units_anonymized", req.log, req.user ?? undefined,
      JSON.stringify({ count }));

    res.json({ count });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to bulk anonymize");
    res.status(500).json({ error: "일괄 익명화 실패" });
  }
});

// ─── PATCH /api/admin/translation-units/:id/exclude ──────────────────────────
router.patch("/admin/translation-units/:id/exclude", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "유효하지 않은 id" }); return; }

  try {
    const result = await excludeTranslationUnit(id, req.user?.id ?? null);
    if (!result.ok) {
      if (result.error === "not_found") { res.status(404).json({ error: "찾을 수 없습니다." }); return; }
      res.status(500).json({ error: result.error }); return;
    }

    await logEvent("translation_unit", id, "translation_unit_excluded", req.log, req.user ?? undefined);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to exclude");
    res.status(500).json({ error: "제외 처리 실패" });
  }
});

// ─── PATCH /api/admin/translation-units/:id ──────────────────────────────────
// 메타데이터 수정 (domain, qualityLevel, securityLevel)
router.patch("/admin/translation-units/:id", ...adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "유효하지 않은 id" }); return; }

  const { domain, qualityLevel, securityLevel } = req.body as {
    domain?: string; qualityLevel?: string; securityLevel?: string;
  };

  try {
    const [existing] = await db.select().from(translationUnitsTable).where(eq(translationUnitsTable.id, id));
    if (!existing) { res.status(404).json({ error: "찾을 수 없습니다." }); return; }

    const [updated] = await db.update(translationUnitsTable)
      .set({
        domain: domain ?? existing.domain,
        qualityLevel: qualityLevel ?? existing.qualityLevel,
        securityLevel: securityLevel ?? existing.securityLevel,
        updatedAt: new Date(),
      })
      .where(eq(translationUnitsTable.id, id))
      .returning();

    await db.insert(translationUnitLogsTable).values({
      translationUnitId: id,
      action: "updated",
      actorUserId: req.user?.id ?? null,
      oldValue: JSON.stringify({ domain: existing.domain, qualityLevel: existing.qualityLevel, securityLevel: existing.securityLevel }),
      newValue: JSON.stringify({ domain: updated.domain, qualityLevel: updated.qualityLevel, securityLevel: updated.securityLevel }),
    });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "DataLayer: failed to update translation unit");
    res.status(500).json({ error: "수정 실패" });
  }
});

export default router;
