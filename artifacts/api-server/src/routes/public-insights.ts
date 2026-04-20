import { Router } from "express";
import { db } from "@workspace/db";
import { contentInsightsTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

function generateSlug(row: { serviceType: string; languagePair?: string | null; domain?: string | null; id: number }): string {
  const typeMap: Record<string, string> = {
    translation: "translation",
    interpretation: "interpretation",
    equipment: "equipment",
  };
  const domainMap: Record<string, string> = {
    legal: "legal", finance: "finance", medical: "medical", technical: "technical",
    marketing: "marketing", general: "general", academic: "academic", literary: "literary",
    science: "science", government: "government",
  };
  const parts: string[] = [];
  const st = typeMap[row.serviceType] || row.serviceType;
  parts.push(st);
  if (row.domain && domainMap[row.domain]) parts.push(domainMap[row.domain]);
  if (row.languagePair) {
    parts.push(row.languagePair.replace(/[^a-zA-Z0-9가-힣]/g, "-").replace(/-+/g, "-").toLowerCase());
  }
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
        createdAt: contentInsightsTable.createdAt,
        updatedAt: contentInsightsTable.updatedAt,
      })
      .from(contentInsightsTable)
      .where(
        and(
          eq(contentInsightsTable.status, "published"),
          eq(contentInsightsTable.visibilityLevel, "public_insight"),
        ),
      );

    const data = rows.map(r => ({
      ...r,
      slug: r.slug ?? generateSlug({ serviceType: r.serviceType, id: r.id }),
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
      );

    let row = rows.find(r => r.slug === slug);

    if (!row) {
      row = rows.find(r =>
        generateSlug({ serviceType: r.serviceType, languagePair: r.languagePair, domain: r.domain, id: r.id }) === slug,
      );
    }

    if (!row) {
      return res.status(404).json({ error: "인사이트를 찾을 수 없습니다." });
    }

    const effectiveSlug = row.slug ?? generateSlug({ serviceType: row.serviceType, languagePair: row.languagePair, domain: row.domain, id: row.id });

    const related = rows
      .filter(r => r.id !== row!.id && (r.serviceType === row!.serviceType || r.domain === row!.domain))
      .slice(0, 4)
      .map(r => ({
        id: r.id,
        question: r.question,
        shortAnswer: r.shortAnswer,
        slug: r.slug ?? generateSlug({ serviceType: r.serviceType, languagePair: r.languagePair, domain: r.domain, id: r.id }),
      }));

    res.json({
      id: row.id,
      serviceType: row.serviceType,
      question: row.question,
      shortAnswer: row.shortAnswer,
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      slug: effectiveSlug,
      related,
    });
  } catch (err) {
    res.status(500).json({ error: "인사이트 상세 조회 실패" });
  }
});

export default router;
