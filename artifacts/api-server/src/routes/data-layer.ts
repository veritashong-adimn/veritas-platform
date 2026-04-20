import { Router, type IRouter } from "express";
import { db, translationUnitsTable, translationUnitLogsTable, languageServiceDataTable, contentInsightsTable } from "@workspace/db";
import { eq, and, or, ilike, sql, desc } from "drizzle-orm";
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

// GET /api/admin/content-insights
router.get("/admin/content-insights", ...staffPlus, async (req, res) => {
  try {
    const {
      serviceType, status, visibilityLevel, domain, languagePair,
      page = "1", limit = "50",
    } = req.query as Record<string, string | undefined>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    if (serviceType) conditions.push(eq(contentInsightsTable.serviceType, serviceType as "translation" | "interpretation" | "equipment"));
    if (status) conditions.push(eq(contentInsightsTable.status, status));
    if (visibilityLevel) conditions.push(eq(contentInsightsTable.visibilityLevel, visibilityLevel));
    if (domain) conditions.push(eq(contentInsightsTable.domain, domain));
    if (languagePair) conditions.push(eq(contentInsightsTable.languagePair, languagePair));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, countResult] = await Promise.all([
      db.select().from(contentInsightsTable).where(where)
        .orderBy(desc(contentInsightsTable.createdAt))
        .limit(limitNum).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(contentInsightsTable).where(where),
    ]);
    res.json({ data: rows, total: countResult[0].count, page: pageNum, limit: limitNum });
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
        updatedCount++;
      } else {
        await db.insert(contentInsightsTable).values(payload);
        insertedCount++;
      }
    }

    req.log.info({ insertedCount, updatedCount }, "CI: generate complete");
    res.status(201).json({ generated: insertedCount, updated: updatedCount, total: insertedCount + updatedCount });
  } catch (err) {
    req.log.error({ err }, "CI: failed to generate insights");
    res.status(500).json({ error: "인사이트 자동 생성 실패" });
  }
});

export default router;
