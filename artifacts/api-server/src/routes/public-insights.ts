import { Router } from "express";
import { db } from "@workspace/db";
import { contentInsightsTable, insightEventsTable } from "@workspace/db/schema";
import { eq, and, desc, or, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

const router = Router();

function buildPublicSlug(row: { question: string; serviceType: string; languagePair?: string | null; domain?: string | null; id: number }): string {
  if (row.question?.trim()) {
    const s = row.question
      .replace(/[?？]/g, "")
      .trim()
      .replace(/[^\w\uAC00-\uD7A3\uAC00-\uD7A30-9 -]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60)
      .replace(/^-|-$/g, "");
    if (s) return s + "-" + row.id;
  }
  const typeMap: Record<string, string> = {
    translation: "translation", interpretation: "interpretation", equipment: "equipment",
  };
  const parts: string[] = [typeMap[row.serviceType] || row.serviceType];
  if (row.domain) parts.push(row.domain);
  if (row.languagePair) parts.push(row.languagePair.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase());
  parts.push(String(row.id));
  return parts.join("-").replace(/--+/g, "-").replace(/^-|-$/g, "");
}

// GET /api/public/insights
router.get("/public/insights", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: contentInsightsTable.id,
        serviceType: contentInsightsTable.serviceType,
        question: contentInsightsTable.question,
        shortAnswer: contentInsightsTable.shortAnswer,
        slug: contentInsightsTable.slug,
        avgPrice: contentInsightsTable.avgPrice,
        minPrice: contentInsightsTable.minPrice,
        maxPrice: contentInsightsTable.maxPrice,
        sourceCount: contentInsightsTable.sourceCount,
        confidenceScore: contentInsightsTable.confidenceScore,
        sourceWeight: contentInsightsTable.sourceWeight,
        filterScore: contentInsightsTable.filterScore,
        domain: contentInsightsTable.domain,
        languagePair: contentInsightsTable.languagePair,
        createdAt: contentInsightsTable.createdAt,
        updatedAt: contentInsightsTable.updatedAt,
      })
      .from(contentInsightsTable)
      .where(
        and(
          eq(contentInsightsTable.status, "published"),
          eq(contentInsightsTable.visibilityLevel, "public_insight"),
        ),
      )
      .orderBy(
        desc(sql`COALESCE(${contentInsightsTable.sourceWeight}, 0)`),
        desc(sql`COALESCE(${contentInsightsTable.filterScore}, 0)`),
      );

    const data = rows.map(r => ({
      ...r,
      slug: r.slug ?? buildPublicSlug(r),
    }));

    res.json({ data, total: data.length });
  } catch (err) {
    res.status(500).json({ error: "인사이트 목록 조회 실패" });
  }
});

// GET /api/public/insights/:slug
router.get("/public/insights/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const rows = await db
      .select()
      .from(contentInsightsTable)
      .where(
        and(
          eq(contentInsightsTable.status, "published"),
          eq(contentInsightsTable.visibilityLevel, "public_insight"),
        ),
      )
      .orderBy(
        desc(sql`COALESCE(${contentInsightsTable.sourceWeight}, 0)`),
        desc(sql`COALESCE(${contentInsightsTable.filterScore}, 0)`),
      );

    let row = rows.find(r => r.slug === slug);

    if (!row) {
      row = rows.find(r =>
        buildPublicSlug({ question: r.question, serviceType: r.serviceType, languagePair: r.languagePair, domain: r.domain, id: r.id }) === slug,
      );
    }

    if (!row) {
      return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });
    }

    const effectiveSlug = row.slug ?? buildPublicSlug({
      question: row.question, serviceType: row.serviceType,
      languagePair: row.languagePair, domain: row.domain, id: row.id,
    });

    // 관련 인사이트: relatedIds 우선, 없으면 service_type 기준 최대 5개
    let relatedRows: typeof rows = [];
    if (row.relatedIds?.length) {
      relatedRows = rows.filter(r => r.id !== row!.id && row!.relatedIds!.includes(r.id)).slice(0, 5);
    }
    if (relatedRows.length < 5) {
      const more = rows
        .filter(r => r.id !== row!.id && !relatedRows.some(rr => rr.id === r.id))
        .filter(r => r.serviceType === row!.serviceType || r.domain === row!.domain)
        .slice(0, 5 - relatedRows.length);
      relatedRows = [...relatedRows, ...more];
    }

    const related = relatedRows.map(r => ({
      id: r.id,
      question: r.question,
      shortAnswer: r.shortAnswer,
      slug: r.slug ?? buildPublicSlug({ question: r.question, serviceType: r.serviceType, languagePair: r.languagePair, domain: r.domain, id: r.id }),
    }));

    const faqJson = Array.isArray(row.faqJson)
      ? (row.faqJson as { question: string; answer: string }[]).filter(f => f?.question && f?.answer)
      : null;

    res.json({
      id: row.id,
      serviceType: row.serviceType,
      question: row.question,
      shortAnswer: row.shortAnswer ? row.shortAnswer.slice(0, 200) : null,
      longAnswer: row.longAnswer,
      questionType: row.questionType,
      domain: row.domain,
      languagePair: row.languagePair,
      industry: row.industry,
      useCase: row.useCase,
      avgPrice: row.avgPrice,
      minPrice: row.minPrice,
      maxPrice: row.maxPrice,
      sourceCount: row.sourceCount,
      confidenceScore: row.confidenceScore,
      aeoTitle: row.aeoTitle,
      aeoDescription: row.aeoDescription,
      faqJson: faqJson?.length ? faqJson : null,
      sourceWeight: row.sourceWeight,
      filterScore: row.filterScore,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      slug: effectiveSlug,
      related,
    });
  } catch (err) {
    res.status(500).json({ error: "인사이트 상세 조회 실패" });
  }
});

// POST /api/insight-events  (이벤트 수집 — 인증 불필요)
router.post("/insight-events", async (req, res) => {
  try {
    const { insightId, eventType, sessionId, referrer, device } = req.body as {
      insightId?: number;
      eventType?: string;
      sessionId?: string;
      referrer?: string;
      device?: string;
    };

    if (!insightId || !eventType || !sessionId) {
      return res.status(400).json({ error: "insightId, eventType, sessionId 필수" });
    }
    if (!["view", "click", "conversion"].includes(eventType)) {
      return res.status(400).json({ error: "eventType은 view|click|conversion 중 하나" });
    }

    // view 이벤트 중복 방지: 같은 sessionId + insightId 조합으로 이미 view 기록됐으면 skip
    if (eventType === "view") {
      const [existing] = await db.select({ id: insightEventsTable.id })
        .from(insightEventsTable)
        .where(and(
          eq(insightEventsTable.insightId, insightId),
          eq(insightEventsTable.sessionId, sessionId),
          eq(insightEventsTable.eventType, "view"),
        ))
        .limit(1);
      if (existing) {
        return res.status(200).json({ skipped: true, reason: "duplicate_view" });
      }
    }

    // insightId 유효성 확인 (published 여부도 확인)
    const [insight] = await db.select({ id: contentInsightsTable.id })
      .from(contentInsightsTable)
      .where(and(eq(contentInsightsTable.id, insightId), eq(contentInsightsTable.status, "published")));
    if (!insight) {
      return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });
    }

    await db.insert(insightEventsTable).values({
      insightId,
      eventType,
      sessionId: sessionId.slice(0, 128), // 최대 128자
      referrer: referrer?.slice(0, 512) ?? null,
      device: device ?? null,
      userId: (req as any).user?.id ?? null,
    });

    res.status(201).json({ recorded: true });
  } catch (err) {
    res.status(500).json({ error: "이벤트 기록 실패" });
  }
});

export default router;
