import { Router, type IRouter } from "express";
import {
  db, usersTable, translatorProfilesTable, translatorRatesTable,
} from "@workspace/db";
import { eq, and, ilike, or, sql, desc, gte, lte } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin")];

// ─── 번역사 목록 (검색/필터) ──────────────────────────────────────────────────
router.get("/admin/translators", ...adminGuard, async (req, res) => {
  try {
    const { search, languagePair, specialization, status, minRating } = req.query as {
      search?: string; languagePair?: string; specialization?: string;
      status?: string; minRating?: string;
    };

    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        isActive: usersTable.isActive,
        createdAt: usersTable.createdAt,
        profileId: translatorProfilesTable.id,
        languagePairs: translatorProfilesTable.languagePairs,
        specializations: translatorProfilesTable.specializations,
        region: translatorProfilesTable.region,
        rating: translatorProfilesTable.rating,
        availabilityStatus: translatorProfilesTable.availabilityStatus,
        bio: translatorProfilesTable.bio,
        ratePerWord: translatorProfilesTable.ratePerWord,
        ratePerPage: translatorProfilesTable.ratePerPage,
        education: translatorProfilesTable.education,
        major: translatorProfilesTable.major,
        graduationYear: translatorProfilesTable.graduationYear,
      })
      .from(usersTable)
      .leftJoin(translatorProfilesTable, eq(translatorProfilesTable.userId, usersTable.id))
      .where(eq(usersTable.role, "translator"))
      .orderBy(desc(usersTable.createdAt));

    let result = rows;

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(t =>
        t.email.toLowerCase().includes(s) ||
        (t.languagePairs ?? "").toLowerCase().includes(s) ||
        (t.region ?? "").toLowerCase().includes(s)
      );
    }
    if (languagePair?.trim()) {
      const lp = languagePair.trim().toLowerCase();
      result = result.filter(t => (t.languagePairs ?? "").toLowerCase().includes(lp));
    }
    if (specialization?.trim()) {
      const sp = specialization.trim().toLowerCase();
      result = result.filter(t => (t.specializations ?? "").toLowerCase().includes(sp));
    }
    if (status?.trim()) {
      result = result.filter(t => (t.availabilityStatus ?? "available") === status);
    }
    if (minRating) {
      const mr = Number(minRating);
      result = result.filter(t => t.rating !== null && (t.rating ?? 0) >= mr);
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Translators: failed to list");
    res.status(500).json({ error: "번역사 조회 실패." });
  }
});

// ─── 번역사 상세 ──────────────────────────────────────────────────────────────
router.get("/admin/translators/:id", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  try {
    const [user] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!user) { res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return; }

    const [profile] = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    const rates = await db.select().from(translatorRatesTable).where(eq(translatorRatesTable.translatorId, userId)).orderBy(desc(translatorRatesTable.createdAt));

    res.json({
      user: { id: user.id, email: user.email, isActive: user.isActive, createdAt: user.createdAt },
      profile: profile ?? null,
      rates,
    });
  } catch (err) {
    req.log.error({ err }, "Translators: failed to get detail");
    res.status(500).json({ error: "번역사 상세 조회 실패." });
  }
});

// ─── 번역사 프로필 업서트 ─────────────────────────────────────────────────────
router.patch("/admin/translators/:id", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  const {
    languagePairs, specializations, education, major,
    graduationYear, region, rating, availabilityStatus, bio,
    ratePerWord, ratePerPage,
  } = req.body;

  try {
    const [user] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!user) { res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return; }

    const profileData = {
      languagePairs, specializations, education, major,
      graduationYear: graduationYear ? Number(graduationYear) : undefined,
      region, rating: rating ? Number(rating) : undefined,
      availabilityStatus: availabilityStatus ?? "available",
      bio, ratePerWord: ratePerWord ? Number(ratePerWord) : undefined,
      ratePerPage: ratePerPage ? Number(ratePerPage) : undefined,
      updatedAt: new Date(),
    };

    const existing = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    let profile;
    if (existing.length === 0) {
      [profile] = await db.insert(translatorProfilesTable).values({ userId, ...profileData }).returning();
    } else {
      [profile] = await db.update(translatorProfilesTable).set(profileData).where(eq(translatorProfilesTable.userId, userId)).returning();
    }

    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "Translators: failed to update profile");
    res.status(500).json({ error: "번역사 프로필 저장 실패." });
  }
});

// ─── 단가 목록 ────────────────────────────────────────────────────────────────
router.get("/admin/translators/:id/rates", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  try {
    const rates = await db.select().from(translatorRatesTable).where(eq(translatorRatesTable.translatorId, userId)).orderBy(desc(translatorRatesTable.createdAt));
    res.json(rates);
  } catch (err) {
    req.log.error({ err }, "TranslatorRates: failed to list");
    res.status(500).json({ error: "단가 조회 실패." });
  }
});

// ─── 단가 추가 ────────────────────────────────────────────────────────────────
router.post("/admin/translators/:id/rates", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  const { serviceType, languagePair, unit, rate } = req.body as {
    serviceType?: string; languagePair?: string; unit?: string; rate?: number;
  };

  if (!serviceType?.trim() || !languagePair?.trim() || !rate) {
    res.status(400).json({ error: "서비스 유형, 언어조합, 단가는 필수입니다." }); return;
  }

  try {
    const [newRate] = await db
      .insert(translatorRatesTable)
      .values({ translatorId: userId, serviceType: serviceType.trim(), languagePair: languagePair.trim(), unit: unit ?? "word", rate: Number(rate) })
      .returning();
    res.status(201).json(newRate);
  } catch (err) {
    req.log.error({ err }, "TranslatorRates: failed to create");
    res.status(500).json({ error: "단가 추가 실패." });
  }
});

// ─── 단가 삭제 ────────────────────────────────────────────────────────────────
router.delete("/admin/translators/:id/rates/:rateId", ...adminGuard, async (req, res) => {
  const rateId = Number(req.params.rateId);
  if (isNaN(rateId) || rateId <= 0) {
    res.status(400).json({ error: "유효하지 않은 rate id." }); return;
  }

  try {
    await db.delete(translatorRatesTable).where(eq(translatorRatesTable.id, rateId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "TranslatorRates: failed to delete");
    res.status(500).json({ error: "단가 삭제 실패." });
  }
});

export default router;
