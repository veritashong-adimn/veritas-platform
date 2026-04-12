import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import {
  db, usersTable, translatorProfilesTable, translatorRatesTable,
  translatorProductsTable, productsTable, translatorSensitiveTable,
} from "@workspace/db";
import { eq, and, ilike, or, sql, desc, gte, lte, inArray } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { encrypt, decrypt, maskResidentNumber } from "../lib/encrypt";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 번역사 목록 (검색/필터) ──────────────────────────────────────────────────
router.get("/admin/translators", ...adminGuard, async (req, res) => {
  try {
    const { search, languagePair, specialization, status, minRating, grade } = req.query as {
      search?: string; languagePair?: string; specialization?: string;
      status?: string; minRating?: string; grade?: string;
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
        languageLevel: translatorProfilesTable.languageLevel,
        specializations: translatorProfilesTable.specializations,
        phone: translatorProfilesTable.phone,
        region: translatorProfilesTable.region,
        grade: translatorProfilesTable.grade,
        rating: translatorProfilesTable.rating,
        availabilityStatus: translatorProfilesTable.availabilityStatus,
        bio: translatorProfilesTable.bio,
        ratePerWord: translatorProfilesTable.ratePerWord,
        ratePerPage: translatorProfilesTable.ratePerPage,
        unitType: translatorProfilesTable.unitType,
        unitPrice: translatorProfilesTable.unitPrice,
        education: translatorProfilesTable.education,
        major: translatorProfilesTable.major,
        graduationYear: translatorProfilesTable.graduationYear,
        resumeUrl: translatorProfilesTable.resumeUrl,
        portfolioUrl: translatorProfilesTable.portfolioUrl,
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
        (t.phone ?? "").toLowerCase().includes(s) ||
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
    if (grade?.trim()) {
      result = result.filter(t => t.grade === grade.trim());
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Translators: failed to list");
    res.status(500).json({ error: "번역사 조회 실패." });
  }
});

// ─── 통번역사 등록 ─────────────────────────────────────────────────────────────
router.post("/admin/translators", ...adminGuard, async (req, res) => {
  const {
    email, password, name, phone, region,
    languagePairs, languageLevel, specializations,
    grade, bio, ratePerWord, ratePerPage, unitType, unitPrice,
    resumeUrl, portfolioUrl, availabilityStatus,
  } = req.body;

  if (!email?.trim()) { res.status(400).json({ error: "이메일은 필수입니다." }); return; }
  if (!password?.trim()) { res.status(400).json({ error: "비밀번호는 필수입니다." }); return; }

  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.trim())).limit(1);
    if (existing.length > 0) { res.status(409).json({ error: "이미 등록된 이메일입니다." }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const [newUser] = await db.insert(usersTable).values({
      email: email.trim(), password: passwordHash,
      name: name?.trim() || null, role: "translator", isActive: true,
    }).returning();

    const [profile] = await db.insert(translatorProfilesTable).values({
      userId: newUser.id,
      phone: phone?.trim() || null, region: region?.trim() || null,
      languagePairs: languagePairs?.trim() || null, languageLevel: languageLevel || null,
      specializations: specializations?.trim() || null,
      grade: grade || null, bio: bio?.trim() || null,
      ratePerWord: ratePerWord ? Number(ratePerWord) : null,
      ratePerPage: ratePerPage ? Number(ratePerPage) : null,
      unitType: unitType ?? "eojeol",
      unitPrice: unitPrice ? Number(unitPrice) : null,
      resumeUrl: resumeUrl?.trim() || null, portfolioUrl: portfolioUrl?.trim() || null,
      availabilityStatus: availabilityStatus ?? "available",
    }).returning();

    res.status(201).json({
      id: newUser.id, email: newUser.email, name: newUser.name,
      isActive: newUser.isActive, createdAt: newUser.createdAt,
      profileId: profile.id,
      languagePairs: profile.languagePairs, languageLevel: profile.languageLevel,
      specializations: profile.specializations,
      phone: profile.phone, region: profile.region,
      grade: profile.grade, rating: profile.rating,
      availabilityStatus: profile.availabilityStatus,
      bio: profile.bio,
      ratePerWord: profile.ratePerWord, ratePerPage: profile.ratePerPage,
      unitType: profile.unitType, unitPrice: profile.unitPrice,
      resumeUrl: profile.resumeUrl, portfolioUrl: profile.portfolioUrl,
      education: profile.education, major: profile.major, graduationYear: profile.graduationYear,
    });
  } catch (err) {
    req.log.error({ err }, "Translators: failed to create");
    res.status(500).json({ error: "통번역사 등록 실패." });
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

    const translatorProducts = await db
      .select({
        id: translatorProductsTable.id,
        translatorId: translatorProductsTable.translatorId,
        productId: translatorProductsTable.productId,
        productName: productsTable.name,
        productCode: productsTable.code,
        mainCategory: productsTable.mainCategory,
        subCategory: productsTable.subCategory,
        productUnit: productsTable.unit,
        productBasePrice: productsTable.basePrice,
        unitPrice: translatorProductsTable.unitPrice,
        note: translatorProductsTable.note,
        createdAt: translatorProductsTable.createdAt,
      })
      .from(translatorProductsTable)
      .leftJoin(productsTable, eq(translatorProductsTable.productId, productsTable.id))
      .where(eq(translatorProductsTable.translatorId, userId))
      .orderBy(translatorProductsTable.createdAt);

    res.json({
      user: { id: user.id, email: user.email, isActive: user.isActive, createdAt: user.createdAt },
      profile: profile ?? null,
      rates,
      translatorProducts,
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
    languagePairs, languageLevel, specializations, education, major,
    graduationYear, phone, region, grade, rating, availabilityStatus, bio,
    ratePerWord, ratePerPage, unitType, unitPrice, resumeUrl, portfolioUrl,
  } = req.body;

  try {
    const [user] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!user) { res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return; }

    const profileData = {
      languagePairs, languageLevel, specializations, education, major,
      graduationYear: graduationYear ? Number(graduationYear) : undefined,
      phone: phone ?? null, region, grade: grade ?? null,
      rating: rating ? Number(rating) : undefined,
      availabilityStatus: availabilityStatus ?? "available",
      bio, ratePerWord: ratePerWord ? Number(ratePerWord) : undefined,
      ratePerPage: ratePerPage ? Number(ratePerPage) : undefined,
      unitType: unitType ?? undefined,
      unitPrice: unitPrice != null ? Number(unitPrice) : undefined,
      resumeUrl: resumeUrl ?? null, portfolioUrl: portfolioUrl ?? null,
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

// ─── 수행 상품 목록 ────────────────────────────────────────────────────────────
router.get("/admin/translators/:id/products", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  try {
    const items = await db
      .select({
        id: translatorProductsTable.id,
        translatorId: translatorProductsTable.translatorId,
        productId: translatorProductsTable.productId,
        productName: productsTable.name,
        productCode: productsTable.code,
        mainCategory: productsTable.mainCategory,
        subCategory: productsTable.subCategory,
        productUnit: productsTable.unit,
        productBasePrice: productsTable.basePrice,
        unitPrice: translatorProductsTable.unitPrice,
        note: translatorProductsTable.note,
        createdAt: translatorProductsTable.createdAt,
      })
      .from(translatorProductsTable)
      .leftJoin(productsTable, eq(translatorProductsTable.productId, productsTable.id))
      .where(eq(translatorProductsTable.translatorId, userId))
      .orderBy(translatorProductsTable.createdAt);
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "TranslatorProducts: failed to list");
    res.status(500).json({ error: "수행 상품 조회 실패." });
  }
});

// ─── 수행 상품 추가 ────────────────────────────────────────────────────────────
router.post("/admin/translators/:id/products", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  const { productId, unitPrice, note } = req.body as {
    productId?: number; unitPrice?: number; note?: string;
  };
  if (!productId) {
    res.status(400).json({ error: "productId는 필수입니다." }); return;
  }
  try {
    const [existing] = await db.select({ id: translatorProductsTable.id })
      .from(translatorProductsTable)
      .where(and(eq(translatorProductsTable.translatorId, userId), eq(translatorProductsTable.productId, productId)));
    if (existing) {
      res.status(409).json({ error: "이미 등록된 상품입니다." }); return;
    }

    const [row] = await db.insert(translatorProductsTable)
      .values({ translatorId: userId, productId, unitPrice: unitPrice ?? null, note: note ?? null })
      .returning();

    const [withProduct] = await db
      .select({
        id: translatorProductsTable.id,
        translatorId: translatorProductsTable.translatorId,
        productId: translatorProductsTable.productId,
        productName: productsTable.name,
        productCode: productsTable.code,
        mainCategory: productsTable.mainCategory,
        subCategory: productsTable.subCategory,
        productUnit: productsTable.unit,
        productBasePrice: productsTable.basePrice,
        unitPrice: translatorProductsTable.unitPrice,
        note: translatorProductsTable.note,
        createdAt: translatorProductsTable.createdAt,
      })
      .from(translatorProductsTable)
      .leftJoin(productsTable, eq(translatorProductsTable.productId, productsTable.id))
      .where(eq(translatorProductsTable.id, row.id));

    res.status(201).json(withProduct);
  } catch (err) {
    req.log.error({ err }, "TranslatorProducts: failed to add");
    res.status(500).json({ error: "수행 상품 추가 실패." });
  }
});

// ─── 수행 상품 단가 수정 ──────────────────────────────────────────────────────
router.patch("/admin/translators/:id/products/:tpId", ...adminGuard, async (req, res) => {
  const tpId = Number(req.params.tpId);
  if (isNaN(tpId) || tpId <= 0) {
    res.status(400).json({ error: "유효하지 않은 id." }); return;
  }
  const { unitPrice, note } = req.body as { unitPrice?: number | null; note?: string | null };
  try {
    const [row] = await db.update(translatorProductsTable)
      .set({ unitPrice: unitPrice ?? null, note: note ?? null })
      .where(eq(translatorProductsTable.id, tpId))
      .returning();
    if (!row) { res.status(404).json({ error: "수행 상품을 찾을 수 없습니다." }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "TranslatorProducts: failed to update");
    res.status(500).json({ error: "수행 상품 수정 실패." });
  }
});

// ─── 수행 상품 삭제 ────────────────────────────────────────────────────────────
router.delete("/admin/translators/:id/products/:tpId", ...adminGuard, async (req, res) => {
  const tpId = Number(req.params.tpId);
  if (isNaN(tpId) || tpId <= 0) {
    res.status(400).json({ error: "유효하지 않은 id." }); return;
  }
  try {
    await db.delete(translatorProductsTable).where(eq(translatorProductsTable.id, tpId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "TranslatorProducts: failed to delete");
    res.status(500).json({ error: "수행 상품 삭제 실패." });
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
  if (req.user!.role !== "admin" && req.user!.role !== "staff" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 프로필만 조회할 수 있습니다." }); return;
  }
  try {
    const [profile] = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, targetId));
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
  if (req.user!.role !== "admin" && req.user!.role !== "staff" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 프로필만 수정할 수 있습니다." }); return;
  }

  const {
    languagePairs, languageLevel, specializations, education, major, graduationYear,
    region, availabilityStatus, bio, ratePerWord, ratePerPage, resumeUrl, portfolioUrl,
  } = req.body as {
    languagePairs?: string; languageLevel?: string; specializations?: string;
    education?: string; major?: string; graduationYear?: number;
    region?: string; availabilityStatus?: string;
    bio?: string; ratePerWord?: number; ratePerPage?: number;
    resumeUrl?: string; portfolioUrl?: string;
  };

  try {
    const existing = await db
      .select({ id: translatorProfilesTable.id })
      .from(translatorProfilesTable)
      .where(eq(translatorProfilesTable.userId, targetId));

    const vals = {
      userId: targetId,
      languagePairs: languagePairs ?? null,
      languageLevel: languageLevel ?? null,
      specializations: specializations ?? null,
      education: education ?? null,
      major: major ?? null,
      graduationYear: graduationYear ?? null,
      region: region ?? null,
      availabilityStatus: availabilityStatus ?? "available",
      bio: bio ?? null,
      ratePerWord: ratePerWord ?? null,
      ratePerPage: ratePerPage ?? null,
      resumeUrl: resumeUrl ?? null,
      portfolioUrl: portfolioUrl ?? null,
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
  if (req.user!.role !== "admin" && req.user!.role !== "staff" && req.user!.id !== targetId) {
    res.status(403).json({ error: "본인 단가만 조회할 수 있습니다." }); return;
  }
  try {
    const ratesList = await db.select().from(translatorRatesTable).where(eq(translatorRatesTable.translatorId, targetId));
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
  if (req.user!.role !== "admin" && req.user!.role !== "staff" && req.user!.id !== targetId) {
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
      translatorId: targetId, serviceType, languagePair, unit: unit ?? "word", rate,
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
  if (req.user!.role !== "admin" && req.user!.role !== "staff" && req.user!.id !== targetId) {
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

// ─── 민감정보 조회 (마스킹) ──────────────────────────────────────────────────
router.get("/admin/translators/:id/sensitive", ...adminGuard, requirePermission("translator.sensitive"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  try {
    const [row] = await db
      .select()
      .from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, userId));

    // 접근 로그
    req.log.info({
      actor: req.user!.email,
      actorId: req.user!.id,
      targetUserId: userId,
      action: "sensitive.view",
    }, "민감정보 조회");

    if (!row) {
      res.json({ exists: false, residentNumberMasked: null });
      return;
    }

    const residentNumberMasked = row.residentNumber
      ? maskResidentNumber(decrypt(row.residentNumber))
      : null;

    res.json({
      exists: true,
      paymentMethod: row.paymentMethod,
      residentNumberMasked,
      bankName: row.bankName,
      bankAccount: row.bankAccount,
      accountHolder: row.accountHolder,
      businessNumber: row.businessNumber,
      businessName: row.businessName,
      businessOwner: row.businessOwner,
      taxInvoiceEmail: row.taxInvoiceEmail,
      paypalEmail: row.paypalEmail,
      englishName: row.englishName,
      country: row.country,
      currency: row.currency,
      remittanceMemo: row.remittanceMemo,
      addressEn: row.addressEn,
      bankNameEn: row.bankNameEn,
      swiftCode: row.swiftCode,
      routingNumber: row.routingNumber,
      iban: row.iban,
      baseCurrency: row.baseCurrency,
      remittanceFeePayer: row.remittanceFeePayer,
      paymentHold: row.paymentHold,
      settlementMemo: row.settlementMemo,
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    req.log.error({ err }, "Sensitive: failed to read");
    res.status(500).json({ error: "민감정보 조회 실패." });
  }
});

// ─── 민감정보 등록/수정 ────────────────────────────────────────────────────
router.post("/admin/translators/:id/sensitive", ...adminGuard, requirePermission("translator.sensitive"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  const {
    residentNumber,
    paymentMethod,
    bankName, bankAccount, accountHolder,
    businessNumber, businessName, businessOwner, taxInvoiceEmail,
    paypalEmail, englishName, country, currency, remittanceMemo,
    addressEn, bankNameEn, swiftCode, routingNumber, iban,
    baseCurrency, remittanceFeePayer, paymentHold, settlementMemo,
  } = req.body;

  try {
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.role, "translator")));
    if (!user) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }

    const [existing] = await db
      .select()
      .from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, userId));

    // 주민번호: 제공된 경우에만 암호화 처리, 미제공 시 기존값 유지
    const encryptedRn = residentNumber?.trim()
      ? encrypt(residentNumber.trim().replace(/-/g, ""))
      : (residentNumber === "" ? null : existing?.residentNumber ?? null);

    const payload = {
      residentNumber: encryptedRn,
      paymentMethod: paymentMethod?.trim() || null,
      bankName: bankName?.trim() || null,
      bankAccount: bankAccount?.trim() || null,
      accountHolder: accountHolder?.trim() || null,
      businessNumber: businessNumber?.trim() || null,
      businessName: businessName?.trim() || null,
      businessOwner: businessOwner?.trim() || null,
      taxInvoiceEmail: taxInvoiceEmail?.trim() || null,
      paypalEmail: paypalEmail?.trim() || null,
      englishName: englishName?.trim() || null,
      country: country?.trim() || null,
      currency: currency?.trim() || null,
      remittanceMemo: remittanceMemo?.trim() || null,
      addressEn: addressEn?.trim() || null,
      bankNameEn: bankNameEn?.trim() || null,
      swiftCode: swiftCode?.trim() || null,
      routingNumber: routingNumber?.trim() || null,
      iban: iban?.trim() || null,
      baseCurrency: baseCurrency?.trim() || null,
      remittanceFeePayer: remittanceFeePayer?.trim() || null,
      paymentHold: paymentHold === true || paymentHold === "true" ? true : false,
      settlementMemo: settlementMemo?.trim() || null,
      updatedAt: new Date(),
    };

    let result;
    if (!existing) {
      [result] = await db.insert(translatorSensitiveTable)
        .values({ translatorId: userId, ...payload })
        .returning();
    } else {
      [result] = await db.update(translatorSensitiveTable)
        .set(payload)
        .where(eq(translatorSensitiveTable.translatorId, userId))
        .returning();
    }

    req.log.info({
      actor: req.user!.email,
      actorId: req.user!.id,
      targetUserId: userId,
      action: "sensitive.update",
      changedFields: Object.keys(req.body).filter(k => req.body[k] != null),
    }, "민감정보 수정");

    const residentNumberMasked = result.residentNumber
      ? maskResidentNumber(decrypt(result.residentNumber))
      : null;

    res.json({
      exists: true,
      paymentMethod: result.paymentMethod,
      residentNumberMasked,
      bankName: result.bankName,
      bankAccount: result.bankAccount,
      accountHolder: result.accountHolder,
      businessNumber: result.businessNumber,
      businessName: result.businessName,
      businessOwner: result.businessOwner,
      taxInvoiceEmail: result.taxInvoiceEmail,
      paypalEmail: result.paypalEmail,
      englishName: result.englishName,
      country: result.country,
      currency: result.currency,
      remittanceMemo: result.remittanceMemo,
      addressEn: result.addressEn,
      bankNameEn: result.bankNameEn,
      swiftCode: result.swiftCode,
      routingNumber: result.routingNumber,
      iban: result.iban,
      baseCurrency: result.baseCurrency,
      remittanceFeePayer: result.remittanceFeePayer,
      paymentHold: result.paymentHold,
      settlementMemo: result.settlementMemo,
      updatedAt: result.updatedAt,
    });
  } catch (err) {
    req.log.error({ err }, "Sensitive: failed to save");
    res.status(500).json({ error: "민감정보 저장 실패." });
  }
});

export default router;
