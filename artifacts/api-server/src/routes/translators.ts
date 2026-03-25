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
        name: usersTable.name,
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
        (t.name ?? "").toLowerCase().includes(s) ||
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

// ─── 번역사 본인 프로필 조회 ────────────────────────────────────────────────
router.get("/translator-profiles/:id", requireAuth, async (req, res) => {
  const targetId = Number(req.params.id);
  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "유효하지 않은 id." }); return;
  }
  if (req.user!.role !== "admin" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 프로필만 조회할 수 있습니다." }); return;
  }
  try {
    const [profile] = await db
      .select()
      .from(translatorProfilesTable)
      .where(eq(translatorProfilesTable.userId, targetId));
    if (!profile) { res.json(null); return; }
    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "TranslatorProfile: failed to get");
    res.status(500).json({ error: "프로필 조회 실패." });
  }
});

router.put("/translator-profiles/:id", requireAuth, async (req, res) => {
  const targetId = Number(req.params.id);
  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "유효하지 않은 id." }); return;
  }
  if (req.user!.role !== "admin" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 프로필만 수정할 수 있습니다." }); return;
  }

  const {
    languagePairs, specializations, education, major, graduationYear,
    region, availabilityStatus, bio, ratePerWord, ratePerPage,
  } = req.body as {
    languagePairs?: string; specializations?: string;
    education?: string; major?: string; graduationYear?: number;
    region?: string; availabilityStatus?: string;
    bio?: string; ratePerWord?: number; ratePerPage?: number;
  };

  try {
    const existing = await db
      .select({ id: translatorProfilesTable.id })
      .from(translatorProfilesTable)
      .where(eq(translatorProfilesTable.userId, targetId));

    const vals = {
      userId: targetId,
      languagePairs: languagePairs ?? null,
      specializations: specializations ?? null,
      education: education ?? null,
      major: major ?? null,
      graduationYear: graduationYear ?? null,
      region: region ?? null,
      availabilityStatus: availabilityStatus ?? "available",
      bio: bio ?? null,
      ratePerWord: ratePerWord ?? null,
      ratePerPage: ratePerPage ?? null,
    };

    let result;
    if (existing.length === 0) {
      const [row] = await db.insert(translatorProfilesTable).values(vals).returning();
      result = row;
    } else {
      const [row] = await db
        .update(translatorProfilesTable)
        .set(vals)
        .where(eq(translatorProfilesTable.userId, targetId))
        .returning();
      result = row;
    }
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "TranslatorProfile: failed to save");
    res.status(500).json({ error: "프로필 저장 실패." });
  }
});

// ─── 번역사 본인 단가 조회/추가/삭제 ──────────────────────────────────────
router.get("/translator-rates/:id", requireAuth, async (req, res) => {
  const targetId = Number(req.params.id);
  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "유효하지 않은 id." }); return;
  }
  if (req.user!.role !== "admin" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 단가만 조회할 수 있습니다." }); return;
  }
  try {
    const ratesList = await db
      .select()
      .from(translatorRatesTable)
      .where(eq(translatorRatesTable.translatorId, targetId));
    res.json(ratesList);
  } catch (err) {
    req.log.error({ err }, "TranslatorRates: failed to get");
    res.status(500).json({ error: "단가 조회 실패." });
  }
});

router.post("/translator-rates/:id", requireAuth, async (req, res) => {
  const targetId = Number(req.params.id);
  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "유효하지 않은 id." }); return;
  }
  if (req.user!.role !== "admin" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 단가만 추가할 수 있습니다." }); return;
  }

  const { serviceType, languagePair, unit, rate } = req.body as {
    serviceType: string; languagePair: string; unit?: string; rate: number;
  };
  if (!serviceType || !languagePair || rate == null) {
    res.status(400).json({ error: "serviceType, languagePair, rate는 필수입니다." }); return;
  }

  try {
    const [row] = await db.insert(translatorRatesTable).values({
      translatorId: targetId,
      serviceType, languagePair,
      unit: unit ?? "word",
      rate,
    }).returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "TranslatorRates: self add failed");
    res.status(500).json({ error: "단가 추가 실패." });
  }
});

router.delete("/translator-rates/:id/:rateId", requireAuth, async (req, res) => {
  const targetId = Number(req.params.id);
  const rateId = Number(req.params.rateId);
  if (isNaN(targetId) || isNaN(rateId)) {
    res.status(400).json({ error: "유효하지 않은 id." }); return;
  }
  if (req.user!.role !== "admin" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 단가만 삭제할 수 있습니다." }); return;
  }
  try {
    await db.delete(translatorRatesTable).where(
      and(eq(translatorRatesTable.id, rateId), eq(translatorRatesTable.translatorId, targetId))
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "TranslatorRates: self delete failed");
    res.status(500).json({ error: "단가 삭제 실패." });
  }
});

export default router;
