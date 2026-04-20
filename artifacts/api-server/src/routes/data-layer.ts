import { Router, type IRouter } from "express";
import { db, translationUnitsTable, translationUnitLogsTable, languageServiceDataTable, contentInsightsTable, insightAutoSuggestionsTable, insightEventsTable, settingsTable, logsTable } from "@workspace/db";
import { eq, and, or, ilike, sql, desc, inArray } from "drizzle-orm";
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

// ─── Language Service Data ───────────────────────────────────────────────────

// GET /api/admin/language-service-data
router.get("/admin/language-service-data", ...staffPlus, async (req, res) => {
  try {
    const { serviceType, domain, languagePair, isPublic, page = "1", limit = "50" } = req.query as Record<string, string | undefined>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    if (serviceType) conditions.push(eq(languageServiceDataTable.serviceType, serviceType as "translation" | "interpretation" | "equipment"));
    if (domain) conditions.push(eq(languageServiceDataTable.domain, domain));
    if (languagePair) conditions.push(eq(languageServiceDataTable.languagePair, languagePair));
    if (isPublic !== undefined) conditions.push(eq(languageServiceDataTable.isPublic, isPublic === "true"));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, countResult] = await Promise.all([
      db.select().from(languageServiceDataTable).where(where).orderBy(desc(languageServiceDataTable.createdAt)).limit(limitNum).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(languageServiceDataTable).where(where),
    ]);
    res.json({ data: rows, total: countResult[0].count, page: pageNum, limit: limitNum });
  } catch (err) {
    req.log.error({ err }, "LSD: failed to list");
    res.status(500).json({ error: "조회 실패" });
  }
});

// POST /api/admin/language-service-data
router.post("/admin/language-service-data", ...adminOnly, async (req, res) => {
  try {
    const { serviceType, languagePair, domain, industry, useCase, unitPrice, totalPrice,
      turnaroundTime, isPublic, interpretationType, durationHours, numInterpreters,
      locationType, equipmentType, quantity, rentalDuration, notes } = req.body;
    if (!serviceType) return res.status(400).json({ error: "serviceType 필수" });
    const [row] = await db.insert(languageServiceDataTable).values({
      serviceType, languagePair, domain, industry, useCase,
      unitPrice: unitPrice !== undefined ? Number(unitPrice) : undefined,
      totalPrice: totalPrice !== undefined ? Number(totalPrice) : undefined,
      turnaroundTime, isPublic: Boolean(isPublic ?? true),
      interpretationType,
      durationHours: durationHours !== undefined ? String(durationHours) : undefined,
      numInterpreters: numInterpreters !== undefined ? Number(numInterpreters) : undefined,
      locationType, equipmentType,
      quantity: quantity !== undefined ? Number(quantity) : undefined,
      rentalDuration, notes,
    }).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "LSD: failed to create");
    res.status(500).json({ error: "생성 실패" });
  }
});

// PATCH /api/admin/language-service-data/:id
router.patch("/admin/language-service-data/:id", ...adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { serviceType, languagePair, domain, industry, useCase, unitPrice, totalPrice,
      turnaroundTime, isPublic, interpretationType, durationHours, numInterpreters,
      locationType, equipmentType, quantity, rentalDuration, notes } = req.body;
    const existing = await db.select().from(languageServiceDataTable).where(eq(languageServiceDataTable.id, id)).limit(1);
    if (!existing.length) return res.status(404).json({ error: "항목 없음" });
    const [updated] = await db.update(languageServiceDataTable).set({
      ...(serviceType !== undefined && { serviceType }),
      ...(languagePair !== undefined && { languagePair }),
      ...(domain !== undefined && { domain }),
      ...(industry !== undefined && { industry }),
      ...(useCase !== undefined && { useCase }),
      ...(unitPrice !== undefined && { unitPrice: Number(unitPrice) }),
      ...(totalPrice !== undefined && { totalPrice: Number(totalPrice) }),
      ...(turnaroundTime !== undefined && { turnaroundTime }),
      ...(isPublic !== undefined && { isPublic: Boolean(isPublic) }),
      ...(interpretationType !== undefined && { interpretationType }),
      ...(durationHours !== undefined && { durationHours: String(durationHours) }),
      ...(numInterpreters !== undefined && { numInterpreters: Number(numInterpreters) }),
      ...(locationType !== undefined && { locationType }),
      ...(equipmentType !== undefined && { equipmentType }),
      ...(quantity !== undefined && { quantity: Number(quantity) }),
      ...(rentalDuration !== undefined && { rentalDuration }),
      ...(notes !== undefined && { notes }),
      updatedAt: new Date(),
    }).where(eq(languageServiceDataTable.id, id)).returning();
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "LSD: failed to update");
    res.status(500).json({ error: "수정 실패" });
  }
});

// DELETE /api/admin/language-service-data/:id
router.delete("/admin/language-service-data/:id", ...adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(languageServiceDataTable).where(eq(languageServiceDataTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "LSD: failed to delete");
    res.status(500).json({ error: "삭제 실패" });
  }
});

// GET /api/admin/language-service-data/:id/insights
router.get("/admin/language-service-data/:id/insights", ...staffPlus, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = await db.select().from(contentInsightsTable)
      .where(eq(contentInsightsTable.languageServiceDataId, id))
      .orderBy(desc(contentInsightsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "LSD: failed to list insights");
    res.status(500).json({ error: "인사이트 조회 실패" });
  }
});

// POST /api/admin/language-service-data/:id/insights
router.post("/admin/language-service-data/:id/insights", ...adminOnly, async (req, res) => {
  try {
    const languageServiceDataId = parseInt(req.params.id);
    const { question, answer, domain, languagePair, isPublic } = req.body;
    if (!question || !answer) return res.status(400).json({ error: "question, answer 필수" });
    const parent = await db.select().from(languageServiceDataTable).where(eq(languageServiceDataTable.id, languageServiceDataId)).limit(1);
    if (!parent.length) return res.status(404).json({ error: "부모 항목 없음" });
    const [row] = await db.insert(contentInsightsTable).values({
      serviceType: parent[0].serviceType,
      languageServiceDataId, question, answer,
      domain: domain ?? parent[0].domain,
      languagePair: languagePair ?? parent[0].languagePair,
      isPublic: Boolean(isPublic ?? true),
    }).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "LSD: failed to create insight");
    res.status(500).json({ error: "인사이트 생성 실패" });
  }
});

function buildSlug(serviceType: string, languagePair: string | null, domain: string | null, id: number, question?: string | null): string {
  if (question?.trim()) {
    const slugFromQuestion = question
      .replace(/[?？]/g, "")
      .trim()
      .replace(/[^\w\uAC00-\uD7A3\uAC00-\uD7A30-9 -]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60)
      .replace(/^-|-$/g, "");
    if (slugFromQuestion) return slugFromQuestion + "-" + id;
  }
  const typeMap: Record<string, string> = {
    translation: "translation", interpretation: "interpretation", equipment: "equipment",
  };
  const domainMap: Record<string, string> = {
    legal: "legal", finance: "finance", medical: "medical", technical: "technical",
    marketing: "marketing", general: "general", academic: "academic", literary: "literary",
    science: "science", government: "government",
  };
  const parts: string[] = [];
  parts.push(typeMap[serviceType] || serviceType);
  if (domain && domainMap[domain]) parts.push(domainMap[domain]);
  if (languagePair) {
    parts.push(languagePair.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").toLowerCase());
  }
  parts.push(String(id));
  return parts.join("-").replace(/--+/g, "-").replace(/^-|-$/g, "");
}

// PATCH /api/admin/content-insights/:id/status
router.patch("/admin/content-insights/:id/status", ...adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "유효하지 않은 id" });

    const { status } = req.body as { status?: string };
    const VALID = ["draft", "approved", "published", "archived"];
    if (!status || !VALID.includes(status)) {
      return res.status(400).json({ error: `status는 ${VALID.join(" | ")} 중 하나여야 합니다.` });
    }

    const [existing] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    if (!existing) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });

    const setPayload: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === "published" && !existing.slug) {
      setPayload.slug = buildSlug(existing.serviceType, existing.languagePair, existing.domain, id, existing.question);
    }

    const [updated] = await db.update(contentInsightsTable)
      .set(setPayload)
      .where(eq(contentInsightsTable.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });
    req.log.info({ id, status }, "CI: status updated");
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "CI: failed to update status");
    res.status(500).json({ error: "상태 변경 실패" });
  }
});

// PATCH /api/admin/content-insights/:id  (필드 수정)
router.patch("/admin/content-insights/:id", ...adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "유효하지 않은 id" });

    const ALLOWED = [
      "question", "shortAnswer", "longAnswer", "serviceType", "questionType",
      "domain", "languagePair", "industry", "useCase",
      "avgPrice", "minPrice", "maxPrice", "confidenceScore",
    ];
    const body = req.body as Record<string, unknown>;

    const updateData: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updateData[key] = body[key] !== "" ? body[key] : null;
      }
    }
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "수정할 필드가 없습니다." });
    }
    updateData.updatedAt = new Date();

    const [existing] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    if (!existing) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });

    const [updated] = await db.update(contentInsightsTable)
      .set(updateData)
      .where(eq(contentInsightsTable.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });

    if (existing.status === "published") {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of Object.keys(updateData)) {
        if (key !== "updatedAt") {
          before[key] = (existing as Record<string, unknown>)[key];
          after[key] = updateData[key];
        }
      }
      await logEvent(
        "insight", id, "insight_updated", req.log,
        req.user ? { id: req.user.id, email: req.user.email } : undefined,
        JSON.stringify({ before, after }),
      );
    }

    req.log.info({ id, status: existing.status }, "CI: insight updated");
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "CI: failed to update insight");
    res.status(500).json({ error: "인사이트 수정 실패" });
  }
});

// DELETE /api/admin/content-insights/:id
router.delete("/admin/content-insights/:id", ...adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.delete(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "LSD: failed to delete insight");
    res.status(500).json({ error: "인사이트 삭제 실패" });
  }
});

// ─── Content Insights: 조회 + 자동 생성 ──────────────────────────────────────

// POST /api/admin/content-insights  (수동 생성)
router.post("/admin/content-insights", ...adminOnly, async (req, res) => {
  try {
    const {
      question, shortAnswer, longAnswer, serviceType,
      domain, languagePair, industry, useCase,
      avgPrice, minPrice, maxPrice, confidenceScore,
      questionType, visibilityLevel,
    } = req.body as Record<string, string | undefined>;

    if (!question?.trim()) {
      return res.status(400).json({ error: "질문(question)은 필수입니다." });
    }

    const payload = {
      question: question.trim(),
      answer: shortAnswer?.trim() || question.trim(),
      shortAnswer: shortAnswer?.trim() || null,
      longAnswer: longAnswer?.trim() || null,
      serviceType: (serviceType ?? "translation") as "translation" | "interpretation" | "equipment",
      questionType: questionType?.trim() || "price",
      domain: domain?.trim() || null,
      languagePair: languagePair?.trim() || null,
      industry: industry?.trim() || null,
      useCase: useCase?.trim() || null,
      avgPrice: avgPrice ? String(avgPrice) : null,
      minPrice: minPrice ? String(minPrice) : null,
      maxPrice: maxPrice ? String(maxPrice) : null,
      confidenceScore: confidenceScore ? String(confidenceScore) : null,
      status: "draft",
      visibilityLevel: visibilityLevel ?? "internal_summary",
      isPublic: false,
      updatedAt: new Date(),
    };

    const [inserted] = await db.insert(contentInsightsTable).values(payload).returning();
    req.log.info({ id: inserted.id }, "CI: manual insight created");
    res.status(201).json(inserted);
  } catch (err) {
    req.log.error({ err }, "CI: failed to create manual insight");
    res.status(500).json({ error: "인사이트 생성 실패" });
  }
});

// GET /api/admin/content-insights
// ─── AEO helpers ──────────────────────────────────────────────────────────────

function computeAeoFields(row: typeof contentInsightsTable.$inferSelect) {
  const faqArr = (() => {
    if (!row.faqJson) return [];
    if (Array.isArray(row.faqJson)) return row.faqJson as { question: string; answer: string }[];
    try { const p = JSON.parse(row.faqJson as unknown as string); return Array.isArray(p) ? p : []; }
    catch { return []; }
  })();
  const relArr = (() => {
    if (!row.relatedIds) return [];
    if (Array.isArray(row.relatedIds)) return row.relatedIds as number[];
    return [];
  })();

  const faqCount = faqArr.length;
  const relatedCount = relArr.length;
  const hasAeoTitle = !!row.aeoTitle?.trim();
  const hasAeoDescription = !!row.aeoDescription?.trim();
  const hasShortAnswer = !!row.shortAnswer?.trim();

  let aeoScore = 0;
  if (hasShortAnswer) aeoScore += 30;
  if (faqCount >= 3) aeoScore += 30;
  else if (faqCount >= 1) aeoScore += 15;
  if (relatedCount >= 1) aeoScore += 20;
  if (hasAeoTitle) aeoScore += 10;
  if (hasAeoDescription) aeoScore += 10;

  const hasAny = hasShortAnswer || faqCount > 0 || relatedCount > 0;
  const isReady = hasShortAnswer && faqCount >= 3 && relatedCount >= 1 && hasAeoTitle && hasAeoDescription;
  const aeoStatus: "READY" | "PARTIAL" | "NONE" = isReady ? "READY" : hasAny ? "PARTIAL" : "NONE";

  return { faqCount, relatedCount, hasAeoTitle, hasAeoDescription, hasShortAnswer, aeoScore, aeoStatus };
}

router.get("/admin/content-insights", ...staffPlus, async (req, res) => {
  try {
    const {
      serviceType, status, visibilityLevel, domain, languagePair,
      filterDecision, showArchived,
      aeoStatus: aeoStatusFilter,
      sortBy,
      page = "1", limit = "100",
    } = req.query as Record<string, string | undefined>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    if (serviceType) conditions.push(eq(contentInsightsTable.serviceType, serviceType as "translation" | "interpretation" | "equipment"));
    if (status) conditions.push(eq(contentInsightsTable.status, status));
    if (visibilityLevel) conditions.push(eq(contentInsightsTable.visibilityLevel, visibilityLevel));
    if (domain) conditions.push(eq(contentInsightsTable.domain, domain));
    if (languagePair) conditions.push(eq(contentInsightsTable.languagePair, languagePair));
    if (filterDecision) conditions.push(eq(contentInsightsTable.filterDecision, filterDecision));
    if (showArchived !== "true") conditions.push(eq(contentInsightsTable.isArchived, false));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // aeoStatus 필터는 파생 컬럼이므로 전체 조회 후 in-memory 필터링
    const fetchAll = !!aeoStatusFilter;
    const rows = await db.select().from(contentInsightsTable).where(where)
      .orderBy(desc(contentInsightsTable.createdAt))
      .limit(fetchAll ? 5000 : limitNum)
      .offset(fetchAll ? 0 : offset);

    // 파생 필드 계산
    let enriched = rows.map(r => ({ ...r, ...computeAeoFields(r) }));

    // aeoStatus 필터
    if (aeoStatusFilter && ["READY", "PARTIAL", "NONE"].includes(aeoStatusFilter)) {
      enriched = enriched.filter(r => r.aeoStatus === aeoStatusFilter);
    }

    // 정렬
    if (sortBy === "aeoScore") {
      enriched.sort((a, b) => b.aeoScore - a.aeoScore);
    } else if (sortBy === "faqCount") {
      enriched.sort((a, b) => b.faqCount - a.faqCount);
    } else if (sortBy === "relatedCount") {
      enriched.sort((a, b) => b.relatedCount - a.relatedCount);
    }

    const total = enriched.length;
    const data = fetchAll ? enriched.slice(offset, offset + limitNum) : enriched;

    res.json({ data, total: fetchAll ? total : (await db.select({ count: sql<number>`count(*)::int` }).from(contentInsightsTable).where(where))[0].count, page: pageNum, limit: limitNum });
  } catch (err) {
    req.log.error({ err }, "CI: failed to list insights");
    res.status(500).json({ error: "인사이트 조회 실패" });
  }
});

// ─── Label mapping helpers ────────────────────────────────────────────────────

const LANG_PAIR_LABEL: Record<string, string> = {
  "ko-en": "한영",
  "en-ko": "영한",
  "ko-ja": "한일",
  "ja-ko": "일한",
  "ko-zh": "한중",
  "zh-ko": "중한",
  "ko-de": "한독",
  "ko-fr": "한불",
  "ko-es": "한서",
  "ko-ru": "한러",
};

const DOMAIN_LABEL: Record<string, string> = {
  legal: "법률",
  finance: "금융",
  medical: "의료",
  it: "IT",
  technical: "기술",
  patent: "특허",
  academic: "학술",
  marketing: "마케팅",
  government: "정부·공공",
  business: "비즈니스",
};

const INTERP_TYPE_LABEL: Record<string, string> = {
  simultaneous: "동시통역",
  consecutive: "순차통역",
  meeting: "미팅통역",
  exhibition: "전시통역",
  whisper: "위스퍼통역",
};

const EQUIP_TYPE_LABEL: Record<string, string> = {
  booth: "통역 부스",
  receiver: "수신기",
  transmitter: "송신기",
  headset: "헤드셋",
  console: "통역 콘솔",
};

const LOCATION_LABEL: Record<string, string> = {
  onsite: "현장",
  remote: "원격",
  hybrid: "하이브리드",
};

function labelOf(map: Record<string, string>, code: string | null | undefined): string | null {
  if (!code) return null;
  return map[code] ?? code;
}

// ─── Text builders ────────────────────────────────────────────────────────────

function fmt(n: number | null): string {
  if (n === null) return "미정";
  return Math.round(n).toLocaleString("ko-KR");
}

type GenGroup = {
  serviceType: string;
  languagePair: string | null;
  domain: string | null;
  industry: string | null;
  useCase: string | null;
  interpretationType: string | null;
  equipmentType: string | null;
  locationType: string | null;
};

function buildQuestion(g: GenGroup): string {
  if (g.serviceType === "translation") {
    const domPart = labelOf(DOMAIN_LABEL, g.domain) ? `${labelOf(DOMAIN_LABEL, g.domain)} ` : "";
    const langPart = labelOf(LANG_PAIR_LABEL, g.languagePair) ? `${labelOf(LANG_PAIR_LABEL, g.languagePair)} ` : "";
    return `${domPart}${langPart}번역 비용은 얼마인가요?`;
  }
  if (g.serviceType === "interpretation") {
    const typeLabel = labelOf(INTERP_TYPE_LABEL, g.interpretationType);
    return typeLabel ? `${typeLabel} 비용은 얼마인가요?` : "통역 비용은 얼마인가요?";
  }
  const eqLabel = labelOf(EQUIP_TYPE_LABEL, g.equipmentType);
  return eqLabel ? `${eqLabel} 대여 비용은 얼마인가요?` : "통역 장비 대여 비용은 얼마인가요?";
}

function buildShortAnswer(serviceType: string, avgPrice: number | null, minPrice: number | null, maxPrice: number | null): string {
  const prefixMap: Record<string, string> = {
    translation: "번역 비용은",
    interpretation: "통역 비용은",
    equipment: "장비 대여 비용은",
  };
  const prefix = prefixMap[serviceType] ?? "비용은";
  return `${prefix} 평균 ${fmt(avgPrice)}원 수준이며, 보통 ${fmt(minPrice)}~${fmt(maxPrice)}원 범위입니다.`;
}

function buildLongAnswer(g: GenGroup, stats: { sourceCount: number; avgPrice: number | null; minPrice: number | null; maxPrice: number | null; avgDuration: number | null }): string {
  const { serviceType } = g;
  const { sourceCount, avgPrice, minPrice, maxPrice, avgDuration } = stats;

  const typeKo = serviceType === "translation" ? "번역" : serviceType === "interpretation" ? "통역" : "장비";
  const lines: string[] = [];

  lines.push(`## ${typeKo} 서비스 비용 안내`);
  lines.push("");

  if (sourceCount >= 3) {
    lines.push(`총 ${sourceCount}건의 실제 데이터를 기반으로 산출한 평균값입니다.`);
  } else {
    lines.push(`총 ${sourceCount}건의 데이터를 기반으로 산출한 정보입니다.`);
  }
  lines.push("");

  lines.push("### 비용 범위");
  lines.push(`- 평균 단가: ${fmt(avgPrice)}원`);
  lines.push(`- 최저 단가: ${fmt(minPrice)}원`);
  lines.push(`- 최고 단가: ${fmt(maxPrice)}원`);
  lines.push("");

  const condLines: string[] = [];
  const langLabel = labelOf(LANG_PAIR_LABEL, g.languagePair);
  const domLabel = labelOf(DOMAIN_LABEL, g.domain);
  const interpLabel = labelOf(INTERP_TYPE_LABEL, g.interpretationType);
  const equipLabel = labelOf(EQUIP_TYPE_LABEL, g.equipmentType);
  const locLabel = labelOf(LOCATION_LABEL, g.locationType);

  if (langLabel) condLines.push(`- 언어쌍: ${langLabel}`);
  if (domLabel) condLines.push(`- 도메인: ${domLabel}`);
  if (g.industry) condLines.push(`- 산업: ${g.industry}`);
  if (g.useCase) condLines.push(`- 사용 목적: ${g.useCase}`);
  if (serviceType === "interpretation") {
    if (interpLabel) condLines.push(`- 통역 유형: ${interpLabel}`);
    if (locLabel) condLines.push(`- 장소: ${locLabel}`);
    if (avgDuration) condLines.push(`- 평균 시간: ${avgDuration.toFixed(1)}시간`);
  }
  if (serviceType === "equipment") {
    if (equipLabel) condLines.push(`- 장비 유형: ${equipLabel}`);
  }

  if (condLines.length > 0) {
    lines.push("### 세부 조건");
    lines.push(...condLines);
    lines.push("");
  }

  lines.push("### 비용에 영향을 주는 요소");
  if (serviceType === "translation") {
    lines.push("- 언어쌍 희소성 (희귀 언어일수록 단가 상승)");
    lines.push("- 전문 분야 난이도 (법률·의료·금융 분야 할증)");
    lines.push("- 분량 및 납기 (긴급 처리 시 할증)");
    lines.push("- 번역사 경력 및 전문성");
  } else if (serviceType === "interpretation") {
    lines.push("- 통역 유형 (동시통역이 순차통역보다 높음)");
    lines.push("- 진행 시간 및 투입 통역사 수");
    lines.push("- 현장 vs 원격 (현장 통역 시 이동비 별도)");
    lines.push("- 주제 전문성 요구 수준");
  } else {
    lines.push("- 장비 규격 및 수량");
    lines.push("- 렌탈 기간");
    lines.push("- 설치·철거·운반 비용 포함 여부");
  }
  lines.push("");

  if (sourceCount === 1) {
    lines.push("※ 본 데이터는 표본 수가 적어 참고용으로 활용하시기 바랍니다.");
    lines.push("");
  }

  lines.push("*본 데이터는 실제 거래 기반으로 산출되었으며, 개별 프로젝트 조건에 따라 달라질 수 있습니다.*");

  return lines.join("\n");
}

// ─── 그룹 키 생성 ──────────────────────────────────────────────────────────────

function groupKey(serviceType: string, languagePair: string | null, domain: string | null, industry: string | null, useCase: string | null): string {
  return [serviceType, languagePair ?? "", domain ?? "", industry ?? "", useCase ?? ""].join("|");
}

// ─── 인사이트 필터링 유틸리티 ──────────────────────────────────────────────────

const PRICE_KEYWORDS = ["비용", "가격", "단가", "견적", "얼마", "요금", "금액"];
const COMMERCIAL_KEYWORDS = ["견적", "요청", "비용", "준비", "문의", "신청", "계약"];
const NUMERIC_PATTERN = /\d[\d,./~]*[원시간%]/;
const RANGE_PATTERN = /\d+\s*[~–-]\s*\d+/;
const CONDITIONAL_PATTERN = /상황에\s*따라|경우에\s*따라|다를\s*수\s*있|달라질\s*수/;

function calcSearchIntent(question: string): number {
  let score = 0;
  if (PRICE_KEYWORDS.some(k => question.includes(k))) score += 20;
  if (question.trim().endsWith("?") || question.trim().endsWith("나요?") || question.trim().endsWith("까요?")) score += 5;
  return Math.min(score, 25);
}

function calcCommercialIntent(question: string, shortAnswer: string | null): number {
  const text = question + " " + (shortAnswer ?? "");
  if (COMMERCIAL_KEYWORDS.some(k => text.includes(k))) return 22;
  if (PRICE_KEYWORDS.some(k => text.includes(k))) return 15;
  return 8;
}

function calcSpecificity(shortAnswer: string | null, longAnswer: string | null): number {
  const text = (shortAnswer ?? "") + " " + (longAnswer ?? "");
  if (NUMERIC_PATTERN.test(text) || RANGE_PATTERN.test(text)) return 18;
  if (CONDITIONAL_PATTERN.test(text)) return 5;
  if (text.length > 100) return 10;
  return 5;
}

function calcSourceWeight(sourceType: string | null, languageServiceDataId: number | null): number {
  if (languageServiceDataId !== null) return 10;
  if (sourceType === "manual") return 7;
  if (sourceType === "blog") return 5;
  return 7;
}

function normalize(s: string): string {
  return s.replace(/[^\uAC00-\uD7A3a-zA-Z0-9]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(normalize(a).split(" ").filter(Boolean));
  const tb = new Set(normalize(b).split(" ").filter(Boolean));
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

// POST /api/admin/content-insights/:id/approve  (REVIEW → KEEP 승격)
router.post("/admin/content-insights/:id/approve", ...adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    if (!row) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });
    if (row.status === "published") return res.status(400).json({ error: "게시된 인사이트는 조작할 수 없습니다." });

    const [updated] = await db.update(contentInsightsTable)
      .set({ filterDecision: "keep", updatedAt: new Date() })
      .where(eq(contentInsightsTable.id, id))
      .returning();
    return res.json(updated);
  } catch (err) {
    console.error("[approve]", err);
    return res.status(500).json({ error: "승격 처리 중 오류가 발생했습니다." });
  }
});

// POST /api/admin/content-insights/:id/drop  (→ soft delete)
router.post("/admin/content-insights/:id/drop", ...adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    if (!row) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });
    if (row.status === "published") return res.status(400).json({ error: "게시된 인사이트는 삭제할 수 없습니다." });

    const now = new Date();
    const [updated] = await db.update(contentInsightsTable)
      .set({ filterDecision: "drop", isArchived: true, deletedAt: now, updatedAt: now })
      .where(eq(contentInsightsTable.id, id))
      .returning();
    return res.json(updated);
  } catch (err) {
    console.error("[drop]", err);
    return res.status(500).json({ error: "삭제 처리 중 오류가 발생했습니다." });
  }
});

// POST /api/admin/content-insights/:id/restore  (보관 해제)
router.post("/admin/content-insights/:id/restore", ...adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    if (!row) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });

    const [updated] = await db.update(contentInsightsTable)
      .set({ isArchived: false, deletedAt: null, mergedIntoId: null, filterDecision: "review", updatedAt: new Date() })
      .where(eq(contentInsightsTable.id, id))
      .returning();
    return res.json(updated);
  } catch (err) {
    console.error("[restore]", err);
    return res.status(500).json({ error: "복구 처리 중 오류가 발생했습니다." });
  }
});

// POST /api/admin/content-insights/merge  (병합 실행)
router.post("/admin/content-insights/merge", ...adminOnly, async (req, res) => {
  try {
    const { sourceId, targetId } = req.body as { sourceId?: number; targetId?: number };
    if (!sourceId || !targetId) return res.status(400).json({ error: "sourceId, targetId가 필요합니다." });
    if (sourceId === targetId) return res.status(400).json({ error: "자기 자신과 병합할 수 없습니다." });

    const [source] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, sourceId));
    const [target] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, targetId));
    if (!source) return res.status(404).json({ error: `인사이트 #${sourceId}를 찾을 수 없습니다.` });
    if (!target) return res.status(404).json({ error: `인사이트 #${targetId}를 찾을 수 없습니다.` });
    if (source.isArchived) return res.status(400).json({ error: "이미 보관된 인사이트는 병합할 수 없습니다." });
    if (source.status === "published") return res.status(400).json({ error: "게시된 인사이트는 병합할 수 없습니다." });
    if (target.status === "published" || target.status === "archived") {
      return res.status(400).json({ error: "대상은 keep 또는 review 상태여야 합니다." });
    }

    const now = new Date();
    // source 보관
    await db.update(contentInsightsTable)
      .set({ isArchived: true, mergedIntoId: targetId, filterDecision: "merge", deletedAt: now, updatedAt: now })
      .where(eq(contentInsightsTable.id, sourceId));

    // target longAnswer 보강 (source에 없으면 스킵)
    const patchTarget: Partial<typeof contentInsightsTable.$inferInsert> = { updatedAt: now };
    if (!target.longAnswer && source.longAnswer) {
      patchTarget.longAnswer = source.longAnswer;
    }
    const [updatedTarget] = await db.update(contentInsightsTable)
      .set(patchTarget)
      .where(eq(contentInsightsTable.id, targetId))
      .returning();

    return res.json({ merged: true, sourceId, targetId, target: updatedTarget });
  } catch (err) {
    console.error("[merge]", err);
    return res.status(500).json({ error: "병합 처리 중 오류가 발생했습니다." });
  }
});

// POST /api/admin/content-insights/filter  (품질 필터 실행)
router.post("/admin/content-insights/filter", ...adminOnly, async (req, res) => {
  try {
    const { ids } = req.body as { ids?: number[] };

    let targets;
    if (ids && ids.length > 0) {
      targets = await db.select().from(contentInsightsTable)
        .where(and(
          eq(contentInsightsTable.status, "draft"),
          inArray(contentInsightsTable.id, ids)
        ));
    } else {
      targets = await db.select().from(contentInsightsTable)
        .where(eq(contentInsightsTable.status, "draft"));
    }

    if (targets.length === 0) {
      return res.json({ processed: 0, result: [] });
    }

    // 기존 비초안 인사이트 로드 (중복 비교용)
    const existing = await db.select().from(contentInsightsTable)
      .where(sql`status != 'draft'`);

    const resultList: { id: number; decision: string; score: number; duplicateOfId?: number; reason: string }[] = [];
    const processedThisRun: { id: number; question: string }[] = [];

    for (const insight of targets) {
      // 점수 계산
      const si = calcSearchIntent(insight.question);
      const ci = calcCommercialIntent(insight.question, insight.shortAnswer);
      const sp = calcSpecificity(insight.shortAnswer, insight.longAnswer);
      const sw = calcSourceWeight(insight.sourceType, insight.languageServiceDataId);

      // 중복 검사: 기존 비초안 + 같은 배치에서 앞에 처리된 항목
      let dup = 0;
      let duplicateOfId: number | undefined = undefined;
      let similarity = 0;

      const compareCandidates = [
        ...existing.map(e => ({ id: e.id, question: e.question })),
        ...processedThisRun,
      ].filter(c => c.id !== insight.id);

      for (const cand of compareCandidates) {
        const sim = tokenSimilarity(insight.question, cand.question);
        if (sim > similarity) {
          similarity = sim;
          if (sim >= 0.85) duplicateOfId = cand.id;
        }
      }

      if (similarity >= 0.85) dup = 0;
      else if (similarity >= 0.7) dup = 5;
      else dup = 15;

      const total = si + ci + sp + dup + sw;

      // 판정
      let decision: string;
      let reason: string;

      if (similarity >= 0.85) {
        decision = "merge";
        reason = `기존 인사이트 #${duplicateOfId}와 유사도 ${(similarity * 100).toFixed(0)}%로 중복 판정`;
      } else if (total >= 80) {
        decision = "keep";
        const parts = [];
        if (si >= 20) parts.push("검색 의도 높음");
        if (ci >= 20) parts.push("상업적 의도 높음");
        if (sp >= 15) parts.push("구체성 우수");
        if (dup >= 15) parts.push("중복 없음");
        reason = parts.join(" / ") || "종합 점수 우수";
      } else if (total >= 60) {
        decision = "review";
        const parts = [];
        if (si < 10) parts.push("검색 의도 낮음");
        if (sp < 10) parts.push("구체성 부족");
        if (dup < 10) parts.push("유사 질문 존재");
        reason = parts.length > 0 ? parts.join(" / ") : "보통 수준 — 검토 필요";
      } else {
        decision = "drop";
        const parts = [];
        if (si < 10) parts.push("검색 의도 낮음");
        if (ci < 10) parts.push("상업적 가치 낮음");
        if (sp < 10) parts.push("구체성 부족");
        reason = parts.join(" / ") || "종합 점수 미달";
      }

      await db.update(contentInsightsTable)
        .set({
          filterScore: total,
          filterDecision: decision,
          filterReason: reason,
          duplicateOfId: duplicateOfId ?? null,
          searchIntentScore: si,
          commercialIntentScore: ci,
          specificityScore: sp,
          duplicationScore: dup,
          sourceWeight: sw,
          updatedAt: new Date(),
        })
        .where(eq(contentInsightsTable.id, insight.id));

      resultList.push({ id: insight.id, decision, score: total, duplicateOfId, reason });
      processedThisRun.push({ id: insight.id, question: insight.question });
    }

    return res.json({ processed: targets.length, result: resultList });
  } catch (err) {
    console.error("[filter] error:", err);
    return res.status(500).json({ error: "필터 실행 중 오류가 발생했습니다." });
  }
});

// POST /api/admin/content-insights/from-blog  (블로그 글 → 인사이트 변환)
router.post("/admin/content-insights/from-blog", ...adminOnly, async (req, res) => {
  try {
    const { title, content, sourceUrl, count = 3 } = req.body as {
      title?: string;
      content?: string;
      sourceUrl?: string;
      count?: number;
    };

    if (!content || typeof content !== "string" || content.trim().length < 300) {
      return res.status(400).json({ error: "본문이 너무 짧아 인사이트 생성이 어렵습니다. (최소 300자)" });
    }

    const safeCount = Math.min(Math.max(Number(count) || 3, 1), 5);

    const OpenAI = (await import("openai")).default;
    const openaiClient = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });

    const systemPrompt = `당신은 언어 서비스(번역/통역/장비) 분야의 AEO/GEO 인사이트 전문가입니다.
블로그 글을 분석해서 사용자의 검색 의도에 답하는 FAQ형 인사이트를 생성합니다.

규칙:
- 블로그 본문에 명확한 숫자 근거가 없으면 avgPrice/minPrice/maxPrice를 절대 생성하지 말 것 (null 유지)
- 추측·과장 금지. 블로그 내용에 근거한 답변만 생성
- confidenceScore는 0.4~0.5 수준 (블로그 기반이므로 낮게 설정)
- status: "draft", visibilityLevel: "internal_summary" 고정
- serviceType: translation | interpretation | equipment 중 하나
- questionType: price | definition | comparison | process | faq 중 하나
- 응답은 반드시 JSON 배열만 반환 (마크다운 코드블록 없이)`;

    const userPrompt = `블로그 제목: ${title ?? "(제목 없음)"}
블로그 본문:
${content.substring(0, 8000)}

위 블로그 글을 분석하여 ${safeCount}개의 인사이트를 JSON 배열로 생성하세요.
각 항목 형식:
{
  "question": "사용자가 검색할 법한 질문",
  "shortAnswer": "1~2문장 핵심 답변 (200자 이내)",
  "longAnswer": "마크다운 형식 상세 답변 (소제목/불릿 사용 가능)",
  "serviceType": "translation|interpretation|equipment",
  "questionType": "price|definition|comparison|process|faq",
  "domain": "legal|finance|medical|general|etc",
  "languagePair": "ko-en|en-ko|null",
  "industry": "산업명 또는 null",
  "useCase": "사용 목적 또는 null",
  "confidenceScore": 0.4,
  "aeoTitle": "검색엔진/AI용 짧은 제목 (60자 이내)",
  "aeoDescription": "AI 답변 구조에 최적화된 설명문 (160자 이내)",
  "faqJson": [
    { "question": "유사 질문 다른 표현 1", "answer": "간단한 답변" },
    { "question": "유사 질문 다른 표현 2", "answer": "간단한 답변" },
    { "question": "유사 질문 다른 표현 3", "answer": "간단한 답변" }
  ]
}

faqJson은 main question과 다른 표현의 유사 질문 3~5개를 생성하세요.
반드시 JSON 배열만 반환 ([ ... ]). 다른 텍스트 없이.`;

    const completion = await openaiClient.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 8192,
    });

    const raw = completion.choices[0]?.message?.content ?? "[]";
    let parsed: any[] = [];
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) parsed = [];
    } catch {
      return res.status(500).json({ error: "AI 응답 파싱 실패. 다시 시도해 주세요." });
    }

    const inserted = [];
    for (const item of parsed.slice(0, safeCount)) {
      const rawShort = item.shortAnswer ?? null;
      const trimmedShort = rawShort ? rawShort.slice(0, 200) : null;
      const faqItems = Array.isArray(item.faqJson)
        ? item.faqJson.filter((f: any) => f?.question && f?.answer).slice(0, 5) as { question: string; answer: string }[]
        : null;
      const [row] = await db.insert(contentInsightsTable).values({
        question: item.question ?? "질문 없음",
        answer: trimmedShort ?? "",
        shortAnswer: trimmedShort,
        longAnswer: item.longAnswer ?? null,
        serviceType: (["translation", "interpretation", "equipment"].includes(item.serviceType)
          ? item.serviceType : "translation") as any,
        questionType: item.questionType ?? null,
        domain: item.domain ?? null,
        languagePair: (item.languagePair && item.languagePair !== "null") ? item.languagePair : null,
        industry: (item.industry && item.industry !== "null") ? item.industry : null,
        useCase: (item.useCase && item.useCase !== "null") ? item.useCase : null,
        confidenceScore: String(item.confidenceScore ?? "0.45"),
        aeoTitle: item.aeoTitle?.slice(0, 60) ?? null,
        aeoDescription: item.aeoDescription?.slice(0, 160) ?? null,
        faqJson: faqItems?.length ? faqItems : null,
        status: "draft",
        visibilityLevel: "internal_summary",
        sourceType: "blog",
        sourceTitle: title ?? null,
        sourceUrl: sourceUrl ?? null,
      }).returning();
      inserted.push(row);
    }

    return res.status(201).json({ created: inserted.length, items: inserted });
  } catch (err) {
    console.error("[from-blog] error:", err);
    return res.status(500).json({ error: "인사이트 생성 중 오류가 발생했습니다." });
  }
});

// POST /api/admin/content-insights/generate
router.post("/admin/content-insights/generate", ...adminOnly, async (req, res) => {
  try {
    const clearPrevious = req.query.clearPrevious === "true";

    if (clearPrevious) {
      await db.delete(contentInsightsTable).where(eq(contentInsightsTable.status, "draft"));
    }

    const publicRecords = await db.select().from(languageServiceDataTable)
      .where(eq(languageServiceDataTable.isPublic, true));

    if (publicRecords.length === 0) {
      return res.json({ generated: 0, updated: 0, message: "공개 데이터가 없습니다." });
    }

    // 그룹핑: serviceType + languagePair + domain + industry + useCase
    type LsdRow = typeof publicRecords[number];
    const groupMap = new Map<string, LsdRow[]>();
    for (const r of publicRecords) {
      const key = groupKey(r.serviceType, r.languagePair, r.domain, r.industry, r.useCase);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(r);
    }

    // clearPrevious=false 일 때 기존 draft 조회 (upsert 판단용)
    let existingDraftsByKey = new Map<string, number>();
    if (!clearPrevious) {
      const existingDrafts = await db.select({
        id: contentInsightsTable.id,
        serviceType: contentInsightsTable.serviceType,
        languagePair: contentInsightsTable.languagePair,
        domain: contentInsightsTable.domain,
        industry: contentInsightsTable.industry,
        useCase: contentInsightsTable.useCase,
      }).from(contentInsightsTable).where(eq(contentInsightsTable.status, "draft"));

      for (const d of existingDrafts) {
        const k = groupKey(d.serviceType, d.languagePair, d.domain, d.industry, d.useCase);
        if (!existingDraftsByKey.has(k)) existingDraftsByKey.set(k, d.id);
      }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    const resultIds: number[] = [];

    for (const [key, records] of groupMap.entries()) {
      const first = records[0];
      const prices = records.map(r => r.unitPrice).filter((p): p is number => p !== null);
      const durations = records
        .map(r => r.durationHours)
        .filter((d): d is string => d !== null)
        .map(d => parseFloat(d));

      const sourceCount = records.length;
      const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
      const minPrice = prices.length > 0 ? Math.min(...prices) : null;
      const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
      const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

      const g: GenGroup = {
        serviceType: first.serviceType,
        languagePair: first.languagePair,
        domain: first.domain,
        industry: first.industry,
        useCase: first.useCase,
        interpretationType: records.find(r => r.interpretationType)?.interpretationType ?? null,
        equipmentType: records.find(r => r.equipmentType)?.equipmentType ?? null,
        locationType: records.find(r => r.locationType)?.locationType ?? null,
      };

      const question = buildQuestion(g);
      const shortAnswer = buildShortAnswer(first.serviceType, avgPrice, minPrice, maxPrice);
      const longAnswer = buildLongAnswer(g, { sourceCount, avgPrice, minPrice, maxPrice, avgDuration });
      const confidenceRaw = sourceCount >= 5 ? 0.9 : sourceCount >= 3 ? 0.7 : 0.5;

      const payload = {
        serviceType: first.serviceType as "translation" | "interpretation" | "equipment",
        languageServiceDataId: null,
        question,
        answer: shortAnswer,
        shortAnswer,
        longAnswer,
        questionType: "price",
        domain: first.domain,
        languagePair: first.languagePair,
        industry: first.industry,
        useCase: first.useCase,
        sourceCount,
        avgPrice: avgPrice !== null ? String(avgPrice) : null,
        minPrice: minPrice !== null ? String(minPrice) : null,
        maxPrice: maxPrice !== null ? String(maxPrice) : null,
        avgDuration: avgDuration !== null ? String(avgDuration) : null,
        status: "draft",
        visibilityLevel: "internal_summary",
        confidenceScore: String(confidenceRaw),
        isPublic: false,
        updatedAt: new Date(),
      };

      const existingId = existingDraftsByKey.get(key);
      if (!clearPrevious && existingId !== undefined) {
        await db.update(contentInsightsTable)
          .set(payload)
          .where(eq(contentInsightsTable.id, existingId));
        resultIds.push(existingId);
        updatedCount++;
      } else {
        const [inserted] = await db.insert(contentInsightsTable).values(payload).returning({ id: contentInsightsTable.id });
        resultIds.push(inserted.id);
        insertedCount++;
      }
    }

    req.log.info({ insertedCount, updatedCount }, "CI: generate complete");
    res.status(201).json({ generated: insertedCount, updated: updatedCount, total: insertedCount + updatedCount, ids: resultIds });
  } catch (err) {
    req.log.error({ err }, "CI: failed to generate insights");
    res.status(500).json({ error: "인사이트 자동 생성 실패" });
  }
});

// ─── AEO 자동 보완 API ───────────────────────────────────────────────────────

// 텍스트 유사도: 단어 overlap 기반 (벡터 DB 없이 간단 매칭)
function wordSimilarity(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().replace(/[^\w\uAC00-\uD7A3 ]/g, " ").split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().replace(/[^\w\uAC00-\uD7A3 ]/g, " ").split(/\s+/).filter(Boolean));
  const intersection = [...tokA].filter(t => tokB.has(t)).length;
  if (!intersection) return 0;
  return intersection / Math.sqrt(tokA.size * tokB.size);
}

async function runAutoEnhance(insight: typeof contentInsightsTable.$inferSelect, allInsights: typeof contentInsightsTable.$inferSelect[]) {
  const aeo = computeAeoFields(insight);
  const needs = {
    faq: aeo.faqCount < 3,
    related: aeo.relatedCount === 0,
    meta: !aeo.hasAeoTitle || !aeo.hasAeoDescription,
  };
  if (!needs.faq && !needs.related && !needs.meta) return { skipped: true };

  const OpenAI = (await import("openai")).default;
  const openaiClient = new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });

  const requestedItems: string[] = [];
  if (needs.faq) requestedItems.push(`"faqSuggestions": [{question, answer}]×3~5개 (기존과 다른 관점)`);
  if (needs.related) requestedItems.push(`"relatedQuestions": [텍스트] ×3개 (관련 다른 질문)`);
  if (needs.meta) {
    if (!aeo.hasAeoTitle) requestedItems.push(`"aeoTitle": 검색최적화 제목 (60자 이내)`);
    if (!aeo.hasAeoDescription) requestedItems.push(`"aeoDescription": AI답변구조 설명문 (160자 이내)`);
  }

  const existingFaqText = insight.faqJson
    ? (insight.faqJson as { question: string }[]).map(f => f.question).join(", ")
    : "없음";

  const systemPrompt = `당신은 통번역 분야 SEO/AEO 전문가입니다. 주어진 인사이트에 대해 JSON 형식으로만 응답하세요.`;
  const userPrompt = `인사이트 정보:
- 질문: ${insight.question}
- 요약 답변: ${insight.shortAnswer ?? "(없음)"}
- 도메인: ${insight.domain ?? "(없음)"}
- 언어쌍: ${insight.languagePair ?? "(없음)"}
- 기존 FAQ 질문: ${existingFaqText}

아래 항목들을 생성해주세요:
${requestedItems.join("\n")}

반드시 JSON만 반환 (예: {"faqSuggestions": [...], "relatedQuestions": [...], "aeoTitle": "...", "aeoDescription": "..."})`;

  const completion = await openaiClient.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 2048,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(raw); } catch { return { error: "AI 응답 파싱 실패" }; }

  const suggestions: { type: string; payload: Record<string, unknown> }[] = [];

  // FAQ 제안
  if (needs.faq && Array.isArray(parsed.faqSuggestions)) {
    const faqs = (parsed.faqSuggestions as { question: string; answer: string }[])
      .filter(f => f?.question && f?.answer)
      .slice(0, 5);
    if (faqs.length > 0) {
      suggestions.push({ type: "faq", payload: { items: faqs, currentCount: aeo.faqCount } });
    }
  }

  // Related 제안: 텍스트 기반 → 기존 인사이트와 유사도 매칭
  if (needs.related && Array.isArray(parsed.relatedQuestions)) {
    const relQs = parsed.relatedQuestions as string[];
    const candidates = allInsights.filter(r => r.id !== insight.id && r.status !== "archived" && !r.isArchived);
    const scored: { id: number; question: string; score: number }[] = [];
    for (const rq of relQs) {
      for (const c of candidates) {
        const s = wordSimilarity(rq, c.question);
        if (s > 0.05) scored.push({ id: c.id, question: c.question, score: s });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<number>();
    const top: { id: number; question: string }[] = [];
    for (const s of scored) {
      if (!seen.has(s.id)) { seen.add(s.id); top.push({ id: s.id, question: s.question }); }
      if (top.length >= 3) break;
    }
    if (top.length > 0) {
      suggestions.push({ type: "related", payload: { items: top, suggestedTexts: relQs } });
    }
  }

  // Meta 제안
  if (needs.meta) {
    const metaPayload: Record<string, string> = {};
    if (!aeo.hasAeoTitle && typeof parsed.aeoTitle === "string") metaPayload.aeoTitle = (parsed.aeoTitle as string).slice(0, 60);
    if (!aeo.hasAeoDescription && typeof parsed.aeoDescription === "string") metaPayload.aeoDescription = (parsed.aeoDescription as string).slice(0, 160);
    if (Object.keys(metaPayload).length > 0) {
      suggestions.push({ type: "meta", payload: metaPayload });
    }
  }

  return { suggestions };
}

// ── 자동 적용 + 상태 설정 헬퍼 ─────────────────────────────────────────────────
// AUTO-APPLY 품질 조건 (보완 후 재계산 기준)
const AUTO_PUBLISH_READY_CONDITIONS = {
  minAeoScore: 80,
  minFaqCount: 3,
  minRelatedCount: 2,
};

/** 인사이트 질문 기반 한글 허용 slug 생성 (최대 60자 + id suffix) */
function generateInsightSlug(question: string, id: number): string {
  const base = question
    .trim()
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, "")   // 한글·영숫자·공백만 허용
    .replace(/\s+/g, "-")            // 공백 → 하이픈
    .replace(/-+/g, "-")             // 연속 하이픈 정리
    .replace(/^-+|-+$/g, "")         // 앞뒤 하이픈 제거
    .slice(0, 60);
  return base ? `${base}-${id}` : `insight-${id}`;
}

async function autoApplyAndSetStatus(
  insightId: number,
  suggestions: typeof insightAutoSuggestionsTable.$inferSelect[],
  logger?: { info: (obj: unknown, msg: string) => void; error?: (obj: unknown, msg: string) => void },
): Promise<{
  status: "publish_ready" | "review_ready" | "published";
  appliedCount: number;
  insight: typeof contentInsightsTable.$inferSelect;
  autoPublished: boolean;
  dryRun: boolean;
}> {
  // suggestions 자동 적용 (faq/related/meta 순서로)
  const ordered = [...suggestions].sort(a => a.type === "faq" ? -1 : a.type === "related" ? 0 : 1);

  let appliedCount = 0;
  for (const sug of ordered) {
    const [current] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, insightId));
    if (!current) continue;

    const setPayload: Record<string, unknown> = { updatedAt: new Date() };
    const payload = sug.payload as Record<string, unknown>;

    if (sug.type === "faq") {
      const newFaqs = payload.items as { question: string; answer: string }[];
      const existing = Array.isArray(current.faqJson) ? current.faqJson as { question: string; answer: string }[] : [];
      const existingQs = new Set(existing.map(f => f.question));
      const merged = [...existing, ...newFaqs.filter(f => !existingQs.has(f.question))].slice(0, 5);
      setPayload.faqJson = merged;
    } else if (sug.type === "related") {
      const items = payload.items as { id: number }[];
      const newIds = items.map(i => i.id);
      const existing = Array.isArray(current.relatedIds) ? current.relatedIds as number[] : [];
      const merged = [...new Set([...existing, ...newIds])].slice(0, 10);
      setPayload.relatedIds = merged;
    } else if (sug.type === "meta") {
      if (payload.aeoTitle && !current.aeoTitle) setPayload.aeoTitle = payload.aeoTitle;
      if (payload.aeoDescription && !current.aeoDescription) setPayload.aeoDescription = payload.aeoDescription;
    }

    await db.update(contentInsightsTable).set(setPayload).where(eq(contentInsightsTable.id, insightId));
    await db.update(insightAutoSuggestionsTable)
      .set({ status: "applied", updatedAt: new Date() })
      .where(eq(insightAutoSuggestionsTable.id, sug.id));
    appliedCount++;
  }

  // 업데이트된 인사이트 재조회 후 AEO 재계산
  const [updatedInsight] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, insightId));
  const aeo = computeAeoFields(updatedInsight);

  // 이미 published면 건드리지 않음
  if (updatedInsight.status === "published") {
    return { status: "published", appliedCount, insight: updatedInsight, autoPublished: false, dryRun: false };
  }

  // 품질 조건 체크 → publish_ready / review_ready
  const cond = AUTO_PUBLISH_READY_CONDITIONS;
  const qualityMet =
    aeo.aeoScore >= cond.minAeoScore &&
    aeo.faqCount >= cond.minFaqCount &&
    aeo.relatedCount >= cond.minRelatedCount &&
    updatedInsight.filterDecision !== "drop";

  const newStatus: "publish_ready" | "review_ready" = qualityMet ? "publish_ready" : "review_ready";

  await db.update(contentInsightsTable)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(contentInsightsTable.id, insightId));

  logger?.info({ insightId, newStatus, aeoScore: aeo.aeoScore, appliedCount }, "CI: auto-apply + status set");

  // ── 자동 게시 시도 ──────────────────────────────────────────────────────────
  let autoPublished = false;
  let dryRun = false;

  if (newStatus === "publish_ready") {
    try {
      const [settings] = await db.select({
        autoPublishEnabled:   settingsTable.autoPublishEnabled,
        autoPublishThreshold: settingsTable.autoPublishThreshold,
        autoPublishDryRun:    settingsTable.autoPublishDryRun,
      }).from(settingsTable).limit(1);

      const enabled   = settings?.autoPublishEnabled   ?? false;
      const threshold = settings?.autoPublishThreshold ?? 80;
      const isDryRun  = settings?.autoPublishDryRun    ?? false;
      dryRun = isDryRun;

      if (enabled) {
        // 자동 게시 세부 조건 체크
        const shortAnswerOk    = !!updatedInsight.shortAnswer?.trim();
        const classificationOk = updatedInsight.filterDecision !== "drop";
        const scoreOk          = aeo.aeoScore >= threshold;
        const faqOk            = aeo.faqCount >= cond.minFaqCount;
        const relatedOk        = aeo.relatedCount >= cond.minRelatedCount;
        const conditionsMet    = shortAnswerOk && classificationOk && scoreOk && faqOk && relatedOk;

        if (conditionsMet) {
          // slug 생성 (없을 경우)
          let slug = updatedInsight.slug;
          if (!slug) {
            const candidateSlug = generateInsightSlug(updatedInsight.question, insightId);
            // 충돌 방지: 동일 slug 존재 여부 확인
            const [conflict] = await db.select({ id: contentInsightsTable.id })
              .from(contentInsightsTable)
              .where(eq(contentInsightsTable.slug, candidateSlug));
            slug = conflict ? `${candidateSlug}-${Date.now()}` : candidateSlug;
          }

          if (!isDryRun) {
            const now = new Date();
            await db.update(contentInsightsTable)
              .set({ status: "published", publishedAt: now, slug, isPublic: true, updatedAt: now })
              .where(eq(contentInsightsTable.id, insightId));

            await db.insert(logsTable).values({
              entityType: "insight",
              entityId: insightId,
              action: "auto_published",
              metadata: JSON.stringify({ aeoScore: aeo.aeoScore, faqCount: aeo.faqCount, relatedCount: aeo.relatedCount, slug }),
            });
            autoPublished = true;
            logger?.info({ insightId, slug, aeoScore: aeo.aeoScore }, "CI: auto-published");
          } else {
            // 드라이런: 로그만 기록
            await db.insert(logsTable).values({
              entityType: "insight",
              entityId: insightId,
              action: "auto_published",
              metadata: JSON.stringify({ dryRun: true, aeoScore: aeo.aeoScore, faqCount: aeo.faqCount, relatedCount: aeo.relatedCount, slug }),
            });
            logger?.info({ insightId, dryRun: true, aeoScore: aeo.aeoScore }, "CI: auto-publish dry-run");
          }
        } else {
          // 조건 미달: 스킵 로그
          const reason = !shortAnswerOk ? "shortAnswer 없음"
            : !classificationOk ? "classification=drop"
            : !scoreOk ? `aeoScore ${aeo.aeoScore} < ${threshold}`
            : !faqOk ? `faqCount ${aeo.faqCount} < ${cond.minFaqCount}`
            : `relatedCount ${aeo.relatedCount} < ${cond.minRelatedCount}`;

          await db.insert(logsTable).values({
            entityType: "insight",
            entityId: insightId,
            action: "auto_publish_skipped",
            metadata: JSON.stringify({ reason, aeoScore: aeo.aeoScore }),
          });
          logger?.info({ insightId, reason }, "CI: auto-publish skipped");
        }
      }
    } catch (err) {
      logger?.error?.({ err }, "CI: auto-publish check failed (non-fatal)");
    }
  }

  const [finalInsight] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, insightId));
  const finalStatus = finalInsight.status === "published" ? "published" : newStatus;
  return { status: finalStatus as "publish_ready" | "review_ready" | "published", appliedCount, insight: finalInsight, autoPublished, dryRun };
}

// GET /api/admin/content-insights/:id/suggestions
router.get("/admin/content-insights/:id/suggestions", ...staffPlus, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "유효하지 않은 id" });
    const rows = await db.select().from(insightAutoSuggestionsTable)
      .where(eq(insightAutoSuggestionsTable.insightId, id))
      .orderBy(desc(insightAutoSuggestionsTable.createdAt));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "제안 목록 조회 실패" });
  }
});

// POST /api/admin/content-insights/:id/auto-enhance  (단건 자동 보완 실행)
router.post("/admin/content-insights/:id/auto-enhance", ...adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "유효하지 않은 id" });

    const [insight] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    if (!insight) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });

    // drop/archived 상태 제외
    if (insight.filterDecision === "drop" || insight.isArchived) {
      return res.status(400).json({ error: "DROP 또는 보관 상태의 인사이트는 자동 보완 대상이 아닙니다." });
    }

    // 기존 pending 제안 삭제 (재생성)
    await db.delete(insightAutoSuggestionsTable)
      .where(and(
        eq(insightAutoSuggestionsTable.insightId, id),
        eq(insightAutoSuggestionsTable.status, "pending"),
      ));

    // 유사도 매칭용 전체 인사이트 조회
    const allInsights = await db.select({
      id: contentInsightsTable.id,
      question: contentInsightsTable.question,
      status: contentInsightsTable.status,
      isArchived: contentInsightsTable.isArchived,
    }).from(contentInsightsTable);

    const result = await runAutoEnhance(insight, allInsights as any);
    if ("skipped" in result && result.skipped) {
      return res.json({ message: "이미 AEO READY 상태입니다. 보완이 필요하지 않습니다.", created: 0 });
    }
    if ("error" in result) {
      return res.status(500).json({ error: result.error });
    }

    const created: typeof insightAutoSuggestionsTable.$inferSelect[] = [];
    for (const sug of result.suggestions ?? []) {
      const [row] = await db.insert(insightAutoSuggestionsTable).values({
        insightId: id,
        type: sug.type,
        payload: sug.payload,
        status: "pending",
      }).returning();
      created.push(row);
    }

    // 자동 적용 + 상태 설정 (+ 자동 게시 시도)
    const { status: newStatus, appliedCount, insight: finalInsight, autoPublished, dryRun } = await autoApplyAndSetStatus(id, created, req.log);

    req.log.info({ id, created: created.length, appliedCount, newStatus, autoPublished }, "CI: auto-enhance complete");
    res.status(201).json({
      created: created.length,
      appliedCount,
      newStatus,
      autoApplied: true,
      autoPublished,
      dryRun,
      insight: { ...finalInsight, ...computeAeoFields(finalInsight) },
    });
  } catch (err) {
    req.log.error({ err }, "CI: auto-enhance failed");
    res.status(500).json({ error: "자동 보완 실행 실패" });
  }
});

// POST /api/admin/content-insights/batch-auto-enhance  (배치 자동 보완)
router.post("/admin/content-insights/batch-auto-enhance", ...adminOnly, async (req, res) => {
  try {
    const { ids: reqIds } = req.body as { ids?: number[] };

    // 대상: PARTIAL or NONE, filterDecision != drop, !isArchived
    let targets = await db.select().from(contentInsightsTable)
      .where(and(
        eq(contentInsightsTable.isArchived, false),
      ));

    if (reqIds?.length) {
      targets = targets.filter(r => reqIds.includes(r.id));
    } else {
      targets = targets.filter(r => {
        if (r.filterDecision === "drop") return false;
        const aeo = computeAeoFields(r);
        return aeo.aeoStatus !== "READY";
      }).slice(0, 20); // 최대 20개
    }

    if (targets.length === 0) {
      return res.json({ processed: 0, created: 0, message: "보완 대상 인사이트가 없습니다." });
    }

    const allInsights = await db.select({
      id: contentInsightsTable.id,
      question: contentInsightsTable.question,
      status: contentInsightsTable.status,
      isArchived: contentInsightsTable.isArchived,
    }).from(contentInsightsTable);

    let totalCreated = 0;
    let totalApplied = 0;
    const results: { id: number; created: number; newStatus?: string }[] = [];

    for (const insight of targets) {
      try {
        await db.delete(insightAutoSuggestionsTable)
          .where(and(
            eq(insightAutoSuggestionsTable.insightId, insight.id),
            eq(insightAutoSuggestionsTable.status, "pending"),
          ));

        const result = await runAutoEnhance(insight, allInsights as any);
        if ("skipped" in result || "error" in result) { results.push({ id: insight.id, created: 0 }); continue; }

        const created: typeof insightAutoSuggestionsTable.$inferSelect[] = [];
        for (const sug of result.suggestions ?? []) {
          const [row] = await db.insert(insightAutoSuggestionsTable).values({
            insightId: insight.id, type: sug.type, payload: sug.payload, status: "pending",
          }).returning();
          created.push(row);
        }

        // 자동 적용 + 상태 설정 (+ 자동 게시 시도)
        const { status: newStatus, appliedCount, autoPublished } = await autoApplyAndSetStatus(insight.id, created);
        totalCreated += created.length;
        totalApplied += appliedCount;
        results.push({ id: insight.id, created: created.length, newStatus, autoPublished });
      } catch {
        results.push({ id: insight.id, created: 0 });
      }
    }

    const publishReadyCount = results.filter(r => r.newStatus === "publish_ready").length;
    const autoPublishedCount = results.filter(r => (r as any).autoPublished === true).length;
    req.log.info({ processed: targets.length, totalCreated, totalApplied, publishReadyCount, autoPublishedCount }, "CI: batch auto-enhance complete");
    res.json({ processed: targets.length, created: totalCreated, applied: totalApplied, publishReadyCount, autoPublishedCount, results });
  } catch (err) {
    req.log.error({ err }, "CI: batch auto-enhance failed");
    res.status(500).json({ error: "배치 자동 보완 실패" });
  }
});

// POST /api/admin/suggestions/:sugId/apply  (제안 적용)
router.post("/admin/suggestions/:sugId/apply", ...adminOnly, async (req, res) => {
  try {
    const sugId = parseInt(req.params.sugId);
    if (isNaN(sugId)) return res.status(400).json({ error: "유효하지 않은 sugId" });

    const [sug] = await db.select().from(insightAutoSuggestionsTable)
      .where(eq(insightAutoSuggestionsTable.id, sugId));
    if (!sug) return res.status(404).json({ error: "제안을 찾을 수 없습니다." });
    if (sug.status !== "pending") return res.status(400).json({ error: `이미 ${sug.status} 상태입니다.` });

    const [insight] = await db.select().from(contentInsightsTable)
      .where(eq(contentInsightsTable.id, sug.insightId));
    if (!insight) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });

    const setPayload: Record<string, unknown> = { updatedAt: new Date() };
    const payload = sug.payload as Record<string, unknown>;

    if (sug.type === "faq") {
      const newFaqs = payload.items as { question: string; answer: string }[];
      const existing = Array.isArray(insight.faqJson) ? insight.faqJson as { question: string; answer: string }[] : [];
      // 기존 + 새 항목 병합 (중복 질문 제외)
      const existingQs = new Set(existing.map(f => f.question));
      const merged = [...existing, ...newFaqs.filter(f => !existingQs.has(f.question))].slice(0, 5);
      setPayload.faqJson = merged;
    } else if (sug.type === "related") {
      const items = payload.items as { id: number }[];
      const newIds = items.map(i => i.id);
      const existing = Array.isArray(insight.relatedIds) ? insight.relatedIds as number[] : [];
      const merged = [...new Set([...existing, ...newIds])].slice(0, 10);
      setPayload.relatedIds = merged;
    } else if (sug.type === "meta") {
      if (payload.aeoTitle && !insight.aeoTitle) setPayload.aeoTitle = payload.aeoTitle;
      if (payload.aeoDescription && !insight.aeoDescription) setPayload.aeoDescription = payload.aeoDescription;
    }

    const [updated] = await db.update(contentInsightsTable)
      .set(setPayload)
      .where(eq(contentInsightsTable.id, insight.id))
      .returning();

    await db.update(insightAutoSuggestionsTable)
      .set({ status: "applied", updatedAt: new Date() })
      .where(eq(insightAutoSuggestionsTable.id, sugId));

    const updatedWithAeo = { ...updated, ...computeAeoFields(updated) };
    res.json({ suggestion: { ...sug, status: "applied" }, insight: updatedWithAeo });
  } catch (err) {
    req.log.error({ err }, "CI: apply suggestion failed");
    res.status(500).json({ error: "제안 적용 실패" });
  }
});

// POST /api/admin/suggestions/:sugId/reject  (제안 무시)
router.post("/admin/suggestions/:sugId/reject", ...adminOnly, async (req, res) => {
  try {
    const sugId = parseInt(req.params.sugId);
    if (isNaN(sugId)) return res.status(400).json({ error: "유효하지 않은 sugId" });

    const [sug] = await db.select().from(insightAutoSuggestionsTable)
      .where(eq(insightAutoSuggestionsTable.id, sugId));
    if (!sug) return res.status(404).json({ error: "제안을 찾을 수 없습니다." });

    await db.update(insightAutoSuggestionsTable)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(insightAutoSuggestionsTable.id, sugId));

    res.json({ id: sugId, status: "rejected" });
  } catch (err) {
    res.status(500).json({ error: "제안 무시 실패" });
  }
});

// ─── 인사이트 성과 분석 ────────────────────────────────────────────────────────

// GET /api/admin/insight-analytics  (전체 성과 목록)
router.get("/admin/insight-analytics", ...staffPlus, async (req, res) => {
  try {
    const { period = "all", sortBy = "views" } = req.query as { period?: string; sortBy?: string };

    // 기간 필터
    const periodFilter = (() => {
      if (period === "7d") return sql`created_at >= NOW() - INTERVAL '7 days'`;
      if (period === "30d") return sql`created_at >= NOW() - INTERVAL '30 days'`;
      return sql`1=1`;
    })();

    const rows = await db.execute<{
      insight_id: number;
      question: string;
      slug: string | null;
      views: string;
      clicks: string;
      conversions: string;
    }>(sql`
      SELECT
        ci.id AS insight_id,
        ci.question,
        ci.slug,
        COALESCE(SUM(CASE WHEN ie.event_type = 'view'       AND ${periodFilter} THEN 1 ELSE 0 END), 0) AS views,
        COALESCE(SUM(CASE WHEN ie.event_type = 'click'      AND ${periodFilter} THEN 1 ELSE 0 END), 0) AS clicks,
        COALESCE(SUM(CASE WHEN ie.event_type = 'conversion' AND ${periodFilter} THEN 1 ELSE 0 END), 0) AS conversions
      FROM content_insights ci
      LEFT JOIN insight_events ie ON ie.insight_id = ci.id
      WHERE ci.status = 'published' AND ci.is_archived = false
      GROUP BY ci.id, ci.question, ci.slug
    `);

    const data = rows.rows.map(r => {
      const views = Number(r.views);
      const clicks = Number(r.clicks);
      const conversions = Number(r.conversions);
      return {
        insightId: r.insight_id,
        question: r.question,
        slug: r.slug,
        views,
        clicks,
        conversions,
        ctr: views > 0 ? Math.round((clicks / views) * 1000) / 10 : 0,
        conversionRate: clicks > 0 ? Math.round((conversions / clicks) * 1000) / 10 : 0,
        viewConversionRate: views > 0 ? Math.round((conversions / views) * 1000) / 10 : 0,
      };
    });

    // 정렬
    if (sortBy === "clicks") data.sort((a, b) => b.clicks - a.clicks);
    else if (sortBy === "conversions") data.sort((a, b) => b.conversions - a.conversions);
    else if (sortBy === "ctr") data.sort((a, b) => b.ctr - a.ctr);
    else data.sort((a, b) => b.views - a.views); // default: views

    res.json({ data, period, sortBy });
  } catch (err) {
    req.log.error({ err }, "insight-analytics: query failed");
    res.status(500).json({ error: "성과 분석 조회 실패" });
  }
});

// GET /api/admin/insight-analytics/:id  (단일 인사이트 성과)
router.get("/admin/insight-analytics/:id", ...staffPlus, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "유효하지 않은 id" });

    const result = await db.execute<{ event_type: string; cnt: string }>(sql`
      SELECT event_type, COUNT(*) AS cnt
      FROM insight_events
      WHERE insight_id = ${id}
      GROUP BY event_type
    `);

    const stats: Record<string, number> = { view: 0, click: 0, conversion: 0 };
    for (const r of result.rows) {
      stats[r.event_type] = Number(r.cnt);
    }

    const views = stats.view;
    const clicks = stats.click;
    const conversions = stats.conversion;

    res.json({
      insightId: id,
      views,
      clicks,
      conversions,
      ctr: views > 0 ? Math.round((clicks / views) * 1000) / 10 : 0,
      conversionRate: clicks > 0 ? Math.round((conversions / clicks) * 1000) / 10 : 0,
      viewConversionRate: views > 0 ? Math.round((conversions / views) * 1000) / 10 : 0,
    });
  } catch (err) {
    res.status(500).json({ error: "단일 인사이트 성과 조회 실패" });
  }
});

// POST /api/admin/content-insights/:id/publish  (게시 대기 → 게시)
router.post("/admin/content-insights/:id/publish", ...adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "유효하지 않은 id" });

    const [insight] = await db.select().from(contentInsightsTable).where(eq(contentInsightsTable.id, id));
    if (!insight) return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });
    if (insight.status === "published") return res.status(400).json({ error: "이미 게시된 인사이트입니다." });
    if (insight.isArchived) return res.status(400).json({ error: "보관된 인사이트는 게시할 수 없습니다." });

    // slug 없으면 생성
    let slug = insight.slug;
    if (!slug) {
      slug = insight.question
        .toLowerCase()
        .replace(/[^가-힣a-z0-9\s]/g, " ")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80);
      // 중복 slug 방지
      const existingSlugs = await db.select({ slug: contentInsightsTable.slug })
        .from(contentInsightsTable)
        .where(eq(contentInsightsTable.isArchived, false));
      const slugSet = new Set(existingSlugs.map(r => r.slug));
      if (slugSet.has(slug)) slug = `${slug}-${id}`;
    }

    const now = new Date();
    const [updated] = await db.update(contentInsightsTable)
      .set({ status: "published", publishedAt: now, slug, updatedAt: now })
      .where(eq(contentInsightsTable.id, id))
      .returning();

    req.log.info({ id, slug }, "CI: published via publish queue");
    res.json({ ...updated, ...computeAeoFields(updated) });
  } catch (err) {
    req.log.error({ err }, "CI: publish failed");
    res.status(500).json({ error: "게시 실패" });
  }
});

// GET /api/admin/content-insights/publish-queue  (게시 대기 목록)
router.get("/admin/content-insights/publish-queue", ...staffPlus, async (req, res) => {
  try {
    const rows = await db.select().from(contentInsightsTable)
      .where(and(
        eq(contentInsightsTable.status, "publish_ready"),
        eq(contentInsightsTable.isArchived, false),
      ))
      .orderBy(desc(contentInsightsTable.updatedAt));
    const withAeo = rows.map(r => ({ ...r, ...computeAeoFields(r) }));
    res.json({ data: withAeo, total: withAeo.length });
  } catch (err) {
    res.status(500).json({ error: "게시 대기 목록 조회 실패" });
  }
});

export default router;
