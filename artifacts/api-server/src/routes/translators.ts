import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import multer from "multer";
import * as XLSX from "xlsx";
import {
  db, usersTable, translatorProfilesTable, translatorRatesTable,
  translatorProductsTable, productsTable, translatorSensitiveTable,
  tasksTable, settlementsTable, logsTable, translatorEmailsTable,
  notesTable, invitationsTable,
} from "@workspace/db";
import { eq, and, ilike, or, sql, desc, gte, lte, inArray } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { encrypt, decrypt, maskResidentNumber } from "../lib/encrypt";
import {
  uploadResumeToGCS, deleteResumeFromGCS, getResumeDownloadUrl, isAllowedMime,
} from "../lib/gcsResume";

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedMime(file.mimetype)) cb(null, true);
    else cb(new Error("PDF, DOC, DOCX 파일만 업로드 가능합니다."));
  },
});

function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 번역사 목록 (검색/필터) ──────────────────────────────────────────────────
router.get("/admin/translators", ...adminGuard, async (req, res) => {
  try {
    const { search, languagePair, specialization, status, minRating, grade, includeInactive } = req.query as {
      search?: string; languagePair?: string; specialization?: string;
      status?: string; minRating?: string; grade?: string; includeInactive?: string;
    };

    const rows = await db
      .select({
        id: usersTable.id,
        email: sql<string>`COALESCE(
          (SELECT te.email FROM translator_emails te
           WHERE te.translator_id = ${usersTable.id} AND te.is_primary = true
           LIMIT 1),
          ${usersTable.email}
        )`,
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
        education: translatorProfilesTable.education,
        major: translatorProfilesTable.major,
        graduationYear: translatorProfilesTable.graduationYear,
        resumeUrl: translatorProfilesTable.resumeUrl,
        portfolioUrl: translatorProfilesTable.portfolioUrl,
      })
      .from(usersTable)
      .leftJoin(translatorProfilesTable, eq(translatorProfilesTable.userId, usersTable.id))
      .where(
        includeInactive === "true"
          ? eq(usersTable.role, "translator")
          : and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true))
      )
      .orderBy(desc(usersTable.createdAt));

    // 단가 관리(translator_rates)에서 대표단가 계산
    const translatorIds = rows.map(r => r.id);
    const ratesMap: Record<number, { repRate: number; repUnit: string } | null> = {};
    if (translatorIds.length > 0) {
      const allRates = await db
        .select({
          translatorId: translatorRatesTable.translatorId,
          rate: translatorRatesTable.rate,
          unit: translatorRatesTable.unit,
          serviceType: translatorRatesTable.serviceType,
          subType: translatorRatesTable.subType,
          language: translatorRatesTable.language,
          languagePair: translatorRatesTable.languagePair,
          id: translatorRatesTable.id,
        })
        .from(translatorRatesTable)
        .where(inArray(translatorRatesTable.translatorId, translatorIds))
        .orderBy(translatorRatesTable.id);

      const grouped: Record<number, typeof allRates> = {};
      for (const r of allRates) {
        if (!grouped[r.translatorId]) grouped[r.translatorId] = [];
        grouped[r.translatorId].push(r);
      }
      for (const [tid, rates] of Object.entries(grouped)) {
        // language=출발언어, languagePair=도착언어로 저장됨
        const find = (svc: string, sub: string | null, srcLang: string | null, tgtLang: string | null, unit: string) =>
          rates.find(r =>
            r.serviceType === svc &&
            (sub === null || r.subType === sub) &&
            (srcLang === null || r.language === srcLang) &&
            (tgtLang === null || r.languagePair === tgtLang) &&
            r.unit === unit,
          );
        const rep =
          find("번역", "일반번역", "한국어", "영어", "eojeol") ||
          find("번역", "일반번역", "영어", "한국어", "eojeol") ||
          find("통역", "순차통역", null, null, "4h") ||
          find("통역", "동시통역", null, null, "4h") ||
          rates[rates.length - 1]; // 가장 최근 등록된 단가
        ratesMap[Number(tid)] = rep ? { repRate: rep.rate, repUnit: rep.unit } : null;
      }
    }

    let result = rows.map(r => ({ ...r, ...(ratesMap[r.id] ?? { repRate: null, repUnit: null }) }));

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      result = result.filter(t =>
        t.email.toLowerCase().includes(s) ||
        (t.name ?? "").toLowerCase().includes(s) ||
        (t.phone ?? "").toLowerCase().includes(s) ||
        (t.languagePairs ?? "").toLowerCase().includes(s) ||
        (t.education ?? "").toLowerCase().includes(s) ||
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

// ─── 통번역사 등록 (초대 기반) ────────────────────────────────────────────────
router.post("/admin/translators", ...adminGuard, async (req, res) => {
  const {
    email, name, phone, region,
    languagePairs, languageLevel, specializations,
    education, major, graduationYear, rating,
    grade, bio, ratePerWord, ratePerPage, unitType, unitPrice,
    resumeUrl, portfolioUrl, availabilityStatus,
  } = req.body;

  if (!email?.trim()) { res.status(400).json({ error: "이메일은 필수입니다." }); return; }

  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.trim())).limit(1);
    if (existing.length > 0) { res.status(409).json({ error: "이미 등록된 이메일입니다." }); return; }

    const inviteToken = generateInviteToken();
    const [newUser] = await db.insert(usersTable).values({
      email: email.trim(), password: null,
      name: name?.trim() || null, role: "translator",
      isActive: false, inviteToken,
    }).returning();

    const [profile] = await db.insert(translatorProfilesTable).values({
      userId: newUser.id,
      phone: phone?.trim() || null, region: region?.trim() || null,
      languagePairs: languagePairs?.trim() || null, languageLevel: languageLevel || null,
      specializations: specializations?.trim() || null,
      education: education?.trim() || null, major: major?.trim() || null,
      graduationYear: graduationYear ? Number(graduationYear) : null,
      rating: rating ? Number(rating) : null,
      grade: grade || null, bio: bio?.trim() || null,
      ratePerWord: ratePerWord ? Number(ratePerWord) : null,
      ratePerPage: ratePerPage ? Number(ratePerPage) : null,
      unitType: unitType ?? "eojeol",
      unitPrice: unitPrice ? Number(unitPrice) : null,
      resumeUrl: resumeUrl?.trim() || null, portfolioUrl: portfolioUrl?.trim() || null,
      availabilityStatus: availabilityStatus ?? "available",
    }).returning();

    // 대표 이메일을 translator_emails에 시딩
    await db.insert(translatorEmailsTable).values({
      translatorId: newUser.id, email: newUser.email, isPrimary: true,
    });

    res.status(201).json({
      id: newUser.id, email: newUser.email, name: newUser.name,
      isActive: newUser.isActive, inviteToken: newUser.inviteToken,
      inviteStatus: "pending",
      createdAt: newUser.createdAt,
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

// ─── 엑셀 업로드용 multer ─────────────────────────────────────────────────────
const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.match(/\.(xlsx|xls)$/i) || file.mimetype.includes("spreadsheet") || file.mimetype.includes("excel");
    if (ok) cb(null, true); else cb(new Error("Excel(.xlsx/.xls) 파일만 가능합니다."));
  },
});

// ─── 샘플 엑셀 다운로드 ─────────────────────────────────────────────────────
router.get("/admin/translators/sample-excel", ...adminGuard, (_req, res) => {
  const headers = [
    "이메일(필수)", "이름", "전화번호",
    "출발언어", "도착언어",
    "업무유형", "세부유형", "단가단위", "기본단가", "통화", "VAT포함(Y/N)",
    "전문분야", "등급(1~5)", "지역",
  ];
  const sample = [
    "translator@example.com", "홍길동", "010-1234-5678",
    "한국어", "영어",
    "번역", "일반번역", "eojeol", "45", "KRW", "N",
    "법률,금융", "2", "서울",
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
  // 열 너비 설정
  ws["!cols"] = headers.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, "통번역사");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="translators_sample.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ─── 엑셀 파싱(미리보기) ──────────────────────────────────────────────────────
router.post("/admin/translators/upload-excel", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일이 없습니다." }); return; }
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as string[][];
    if (rows.length < 2) { res.status(400).json({ error: "데이터 행이 없습니다. (1행 헤더, 2행~ 데이터)" }); return; }

    const colMap: Record<string, number> = {};
    const COLUMN_NAMES: Record<string, string> = {
      "이메일(필수)": "email", "이메일": "email",
      "이름": "name", "전화번호": "phone",
      "출발언어": "sourceLang", "도착언어": "targetLang",
      "업무유형": "workType", "세부유형": "subType",
      "단가단위": "unit", "기본단가": "rate", "통화": "currency", "VAT포함(Y/N)": "vatIncluded",
      "전문분야": "specializations", "등급(1~5)": "grade", "등급": "grade", "지역": "region",
    };
    const headerRow = rows[0].map(h => String(h ?? "").trim());
    headerRow.forEach((h, i) => { if (COLUMN_NAMES[h]) colMap[COLUMN_NAMES[h]] = i; });

    if (colMap["email"] == null) {
      res.status(400).json({ error: "엑셀에 '이메일(필수)' 열이 없습니다." }); return;
    }

    const parsed: { row: number; email: string; name: string; phone: string; sourceLang: string; targetLang: string; workType: string; subType: string; unit: string; rate: string; currency: string; vatIncluded: string; specializations: string; grade: string; region: string; error: string }[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const cell = (key: string) => String(r[colMap[key] ?? -1] ?? "").trim();
      const email = cell("email");
      if (!email) continue; // 빈 행 스킵
      const errors: string[] = [];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("이메일 형식 오류");
      const rateVal = cell("rate");
      if (rateVal && isNaN(Number(rateVal))) errors.push("기본단가는 숫자여야 합니다");
      parsed.push({
        row: i + 1,
        email,
        name: cell("name"),
        phone: cell("phone"),
        sourceLang: cell("sourceLang"),
        targetLang: cell("targetLang"),
        workType: cell("workType"),
        subType: cell("subType"),
        unit: cell("unit") || "eojeol",
        rate: rateVal,
        currency: cell("currency") || "KRW",
        vatIncluded: cell("vatIncluded"),
        specializations: cell("specializations"),
        grade: cell("grade"),
        region: cell("region"),
        error: errors.join("; "),
      });
    }

    const valid = parsed.filter(p => !p.error);
    const invalid = parsed.filter(p => p.error);

    // 이메일 중복 검사 (DB)
    const emails = valid.map(p => p.email.toLowerCase());
    const existingUsers = emails.length > 0
      ? await db.select({ email: usersTable.email }).from(usersTable).where(inArray(usersTable.email, emails))
      : [];
    const existingSet = new Set(existingUsers.map(u => u.email));
    const duplicateRows = valid.filter(p => existingSet.has(p.email.toLowerCase()));
    duplicateRows.forEach(p => { p.error = "이미 등록된 이메일"; invalid.push(p); });
    const finalValid = valid.filter(p => !existingSet.has(p.email.toLowerCase()));

    res.json({ valid: finalValid, invalid, totalRows: parsed.length });
  } catch (err) {
    req.log.error({ err }, "Excel upload parse error");
    res.status(500).json({ error: "엑셀 파싱 중 오류가 발생했습니다." });
  }
});

// ─── 엑셀 대량 등록 ──────────────────────────────────────────────────────────
router.post("/admin/translators/bulk-create", ...adminGuard, async (req, res) => {
  const { rows } = req.body as { rows: { email: string; name?: string; phone?: string; sourceLang?: string; targetLang?: string; workType?: string; subType?: string; unit?: string; rate?: string; currency?: string; vatIncluded?: string; specializations?: string; grade?: string; region?: string }[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "등록할 데이터가 없습니다." }); return;
  }
  const results: { email: string; status: "created" | "error"; error?: string }[] = [];
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase();
    if (!email) { results.push({ email: "?", status: "error", error: "이메일 없음" }); continue; }
    try {
      const tempPw = randomBytes(8).toString("hex");
      const hashed = await bcrypt.hash(tempPw, 10);
      const [newUser] = await db.insert(usersTable).values({
        email, password: hashed, role: "translator", isActive: true,
      }).returning({ id: usersTable.id });
      const profileData: Record<string, unknown> = { userId: newUser.id };
      if (row.name) profileData.name = row.name.trim();
      if (row.phone) profileData.phone = row.phone.trim();
      if (row.specializations) profileData.specializations = row.specializations.trim();
      if (row.grade) profileData.grade = row.grade.trim();
      if (row.region) profileData.region = row.region.trim();
      if (row.sourceLang || row.targetLang) {
        const src = row.sourceLang?.trim(); const tgt = row.targetLang?.trim();
        if (src && tgt) profileData.languagePairs = `${src}→${tgt}`;
        else if (src) profileData.languagePairs = src;
      }
      await db.insert(translatorProfilesTable).values(profileData as never);
      await db.insert(translatorEmailsTable).values({ userId: newUser.id, email, isPrimary: true });
      // 단가 등록
      if (row.workType?.trim() && row.rate?.trim() && !isNaN(Number(row.rate))) {
        const src = row.sourceLang?.trim() || null;
        const tgt = row.targetLang?.trim() || null;
        await db.insert(translatorRatesTable).values({
          translatorId: newUser.id,
          serviceType: row.workType.trim(),
          subType: row.subType?.trim() || null,
          language: src, languagePair: tgt,
          unit: row.unit?.trim() || "eojeol",
          rate: Number(row.rate),
          currency: row.currency?.trim() || "KRW",
          vatIncluded: row.vatIncluded?.toUpperCase() === "Y",
          isDefault: true, isActive: true,
        });
      }
      await db.insert(logsTable).values({
        entityType: "translator", entityId: newUser.id,
        action: "bulk_created", performedBy: req.user?.id ?? null,
        performedByEmail: req.user?.email ?? null,
        metadata: JSON.stringify({ email }),
      });
      results.push({ email, status: "created" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ email, status: "error", error: msg });
    }
  }
  const created = results.filter(r => r.status === "created").length;
  const failed = results.filter(r => r.status === "error").length;
  res.status(201).json({ created, failed, results });
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

    const emailRows = await db
      .select({ id: translatorEmailsTable.id, email: translatorEmailsTable.email, isPrimary: translatorEmailsTable.isPrimary })
      .from(translatorEmailsTable)
      .where(eq(translatorEmailsTable.translatorId, userId))
      .orderBy(translatorEmailsTable.createdAt);

    const inviteStatus = !user.password ? "pending" : "active";
    res.json({
      user: {
        id: user.id, email: user.email, name: user.name,
        isActive: user.isActive, inviteToken: user.inviteToken,
        inviteStatus, createdAt: user.createdAt,
      },
      profile: profile ?? null,
      rates,
      translatorProducts,
      emails: emailRows,
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
    name,
    languagePairs, languageLevel, specializations, education, major,
    graduationYear, phone, region, grade, rating, availabilityStatus, bio,
    emails,
  } = req.body;

  try {
    const [user] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!user) { res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return; }

    // 이름 업데이트 (변경된 경우)
    const trimmedName = typeof name === "string" ? name.trim() : null;
    if (trimmedName && trimmedName !== user.name) {
      await db.update(usersTable).set({ name: trimmedName, updatedAt: new Date() }).where(eq(usersTable.id, userId));
    }

    const profileData = {
      languagePairs: languagePairs?.trim() || null,
      languageLevel: languageLevel?.trim() || null,
      specializations: specializations?.trim() || null,
      education: education?.trim() || null,
      major: major?.trim() || null,
      graduationYear: (graduationYear != null && graduationYear !== "") ? Number(graduationYear) : null,
      phone: phone?.trim() || null,
      region: region?.trim() || null,
      grade: grade || null,
      rating: (rating != null && rating !== "") ? Number(rating) : null,
      availabilityStatus: availabilityStatus ?? "available",
      bio: bio?.trim() || null,
      updatedAt: new Date(),
    };

    const existing = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    let profile;
    if (existing.length === 0) {
      [profile] = await db.insert(translatorProfilesTable).values({ userId, ...profileData }).returning();
    } else {
      [profile] = await db.update(translatorProfilesTable).set(profileData).where(eq(translatorProfilesTable.userId, userId)).returning();
    }

    // 이메일 목록 동기화
    if (Array.isArray(emails) && emails.length > 0) {
      // 정규화
      const entries: Array<{ email: string; isPrimary: boolean }> = emails
        .map((e: { email: string; isPrimary: boolean }) => ({
          email: (e.email ?? "").trim().toLowerCase(),
          isPrimary: !!e.isPrimary,
        }))
        .filter(e => e.email);

      // 중복 검사
      const uniqueEmails = new Set(entries.map(e => e.email));
      if (uniqueEmails.size !== entries.length) {
        res.status(400).json({ error: "중복된 이메일이 있습니다." }); return;
      }

      // 대표 이메일 수 검증
      const primaryEntries = entries.filter(e => e.isPrimary);
      if (primaryEntries.length !== 1) {
        res.status(400).json({ error: "대표 이메일은 반드시 1개여야 합니다." }); return;
      }

      const newPrimaryEmail = primaryEntries[0].email;

      // 전체 교체
      await db.delete(translatorEmailsTable).where(eq(translatorEmailsTable.translatorId, userId));
      await db.insert(translatorEmailsTable).values(
        entries.map(e => ({ translatorId: userId, email: e.email, isPrimary: e.isPrimary }))
      );

      // users.email을 대표 이메일로 동기화 (변경된 경우만)
      if (newPrimaryEmail !== user.email) {
        const conflict = await db.select({ id: usersTable.id }).from(usersTable)
          .where(and(eq(usersTable.email, newPrimaryEmail), sql`${usersTable.id} != ${userId}`)).limit(1);
        if (conflict.length > 0) {
          res.status(409).json({ error: "이미 사용 중인 이메일입니다." }); return;
        }
        await db.update(usersTable).set({ email: newPrimaryEmail }).where(eq(usersTable.id, userId));
      }
    }

    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "Translators: failed to update profile");
    res.status(500).json({ error: "번역사 프로필 저장 실패." });
  }
});

// ─── 이력서 파일 업로드 ───────────────────────────────────────────────────────
router.post(
  "/admin/translators/:id/resume-upload",
  ...adminGuard,
  resumeUpload.single("file"),
  async (req, res) => {
    const userId = Number(req.params.id);
    if (isNaN(userId) || userId <= 0) {
      res.status(400).json({ error: "유효하지 않은 user id." }); return;
    }
    if (!req.file) {
      res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return;
    }

    try {
      const [existing] = await db
        .select({ resumeUrl: translatorProfilesTable.resumeUrl })
        .from(translatorProfilesTable)
        .where(eq(translatorProfilesTable.userId, userId));

      if (existing?.resumeUrl) {
        await deleteResumeFromGCS(existing.resumeUrl).catch(() => {});
      }

      const storedPath = await uploadResumeToGCS(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );

      const existingProfile = await db
        .select({ id: translatorProfilesTable.id })
        .from(translatorProfilesTable)
        .where(eq(translatorProfilesTable.userId, userId));

      let profile;
      if (existingProfile.length === 0) {
        [profile] = await db.insert(translatorProfilesTable)
          .values({ userId, resumeUrl: storedPath })
          .returning();
      } else {
        [profile] = await db.update(translatorProfilesTable)
          .set({ resumeUrl: storedPath, updatedAt: new Date() })
          .where(eq(translatorProfilesTable.userId, userId))
          .returning();
      }

      req.log.info({ userId, storedPath }, "Resume uploaded");
      res.json({ resumeUrl: storedPath, fileName: req.file.originalname });
    } catch (err) {
      req.log.error({ err }, "Resume upload failed");
      res.status(500).json({ error: "이력서 업로드에 실패했습니다." });
    }
  },
);

// ─── 이력서 다운로드 URL 발급 ─────────────────────────────────────────────────
router.get("/admin/translators/:id/resume-url", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  try {
    const [profile] = await db
      .select({ resumeUrl: translatorProfilesTable.resumeUrl })
      .from(translatorProfilesTable)
      .where(eq(translatorProfilesTable.userId, userId));
    if (!profile?.resumeUrl) {
      res.status(404).json({ error: "이력서가 없습니다." }); return;
    }
    const downloadUrl = await getResumeDownloadUrl(profile.resumeUrl);
    res.json({ downloadUrl });
  } catch (err) {
    req.log.error({ err }, "Resume URL generation failed");
    res.status(500).json({ error: "이력서 다운로드 URL 생성 실패." });
  }
});

// ─── 이력서 삭제 ──────────────────────────────────────────────────────────────
router.delete("/admin/translators/:id/resume", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  try {
    const [profile] = await db
      .select({ resumeUrl: translatorProfilesTable.resumeUrl })
      .from(translatorProfilesTable)
      .where(eq(translatorProfilesTable.userId, userId));
    if (profile?.resumeUrl) {
      await deleteResumeFromGCS(profile.resumeUrl).catch(() => {});
      await db.update(translatorProfilesTable)
        .set({ resumeUrl: null, updatedAt: new Date() })
        .where(eq(translatorProfilesTable.userId, userId));
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Resume delete failed");
    res.status(500).json({ error: "이력서 삭제 실패." });
  }
});

// ─── 초대 링크 재생성 ──────────────────────────────────────────────────────────
router.post("/admin/translators/:id/reinvite", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  try {
    const [user] = await db.select({ id: usersTable.id, password: usersTable.password })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.role, "translator")));
    if (!user) { res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return; }
    if (user.password) {
      res.status(400).json({ error: "이미 비밀번호를 설정한 계정입니다." }); return;
    }
    const inviteToken = generateInviteToken();
    await db.update(usersTable).set({ inviteToken, isActive: false }).where(eq(usersTable.id, userId));
    res.json({ inviteToken });
  } catch (err) {
    req.log.error({ err }, "Translators: failed to reinvite");
    res.status(500).json({ error: "초대 링크 재생성 실패." });
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
  const {
    serviceType, workType, subType, language, languagePair, unit, rate,
    currency, vatIncluded, isDefault, isActive, minPrice, baseHours, overtimeRate, memo
  } = req.body as {
    serviceType?: string; workType?: string; subType?: string; language?: string; languagePair?: string;
    unit?: string; rate?: number; currency?: string; vatIncluded?: boolean;
    isDefault?: boolean; isActive?: boolean;
    minPrice?: number; baseHours?: number; overtimeRate?: number; memo?: string;
  };
  const resolvedServiceType = (workType ?? serviceType)?.trim();
  if (!resolvedServiceType || rate == null) {
    res.status(400).json({ error: "업무유형과 단가는 필수입니다." }); return;
  }
  const resolvedUnit = unit?.trim() || "word";
  const resolvedSubType = subType?.trim() || null;
  const resolvedLanguage = language?.trim() || null;
  const resolvedLangPair = languagePair?.trim() || null;
  try {
    // 중복 차단: 업무유형 + 세부유형 + 언어 + 언어방향 + 단가단위
    const dupConditions = [
      eq(translatorRatesTable.translatorId, userId),
      eq(translatorRatesTable.serviceType, resolvedServiceType),
      eq(translatorRatesTable.unit, resolvedUnit),
      resolvedSubType ? eq(translatorRatesTable.subType, resolvedSubType) : sql`${translatorRatesTable.subType} IS NULL`,
      resolvedLanguage ? eq(translatorRatesTable.language, resolvedLanguage) : sql`${translatorRatesTable.language} IS NULL`,
      resolvedLangPair ? eq(translatorRatesTable.languagePair, resolvedLangPair) : sql`${translatorRatesTable.languagePair} IS NULL`,
    ];
    const [dup] = await db.select({ id: translatorRatesTable.id })
      .from(translatorRatesTable)
      .where(and(...dupConditions));
    if (dup) {
      const label = [resolvedServiceType, resolvedSubType, resolvedLanguage ? `${resolvedLanguage}→${resolvedLangPair}` : resolvedLangPair, resolvedUnit].filter(Boolean).join(" / ");
      res.status(409).json({ error: `이미 동일한 단가 항목이 존재합니다. (${label})` });
      return;
    }
    const [newRate] = await db
      .insert(translatorRatesTable)
      .values({
        translatorId: userId,
        serviceType: resolvedServiceType,
        subType: resolvedSubType,
        language: resolvedLanguage,
        languagePair: resolvedLangPair,
        unit: resolvedUnit,
        rate: Number(rate),
        currency: (currency?.trim() || "KRW") as string,
        vatIncluded: vatIncluded === true,
        isDefault: isDefault === true,
        isActive: isActive !== false,
        minPrice: minPrice != null ? Number(minPrice) : null,
        baseHours: baseHours != null ? Number(baseHours) : null,
        overtimeRate: overtimeRate != null ? Number(overtimeRate) : null,
        memo: memo?.trim() || null,
      })
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

// ─── 통번역사 활성화 (복구) ───────────────────────────────────────────────────
router.patch("/admin/translators/:id/activate", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 사용자 id." }); return;
  }

  try {
    const [existing] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!existing) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }

    if (existing.isActive) {
      res.status(400).json({ error: "이미 활성 상태인 통번역사입니다." }); return;
    }

    await db.update(usersTable)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));

    await db.insert(logsTable).values({
      entityType: "translator",
      entityId: userId,
      action: "activated",
      performedBy: req.user?.id ?? null,
      performedByEmail: req.user?.email ?? null,
      metadata: JSON.stringify({ name: existing.name, email: existing.email }),
    });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Translators: failed to activate");
    res.status(500).json({ error: "활성화 중 오류가 발생했습니다. 관리자에게 문의하세요." });
  }
});

// ─── 통번역사 완전삭제 (Permanent Delete) ────────────────────────────────────
router.delete("/admin/translators/:id/permanent", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 사용자 id." }); return;
  }

  try {
    // 1. 통번역사 존재 여부 확인
    const [existing] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!existing) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }

    // 2. 연결된 작업 존재 여부 확인
    const [taskCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(eq(tasksTable.translatorId, userId));
    if ((taskCount?.count ?? 0) > 0) {
      res.status(409).json({
        error: "이 통번역사는 프로젝트/작업 이력이 있어 완전삭제할 수 없습니다. 비활성 처리만 가능합니다.",
        reason: "tasks",
        count: taskCount.count,
      }); return;
    }

    // 3. 연결된 정산 존재 여부 확인
    const [settlementCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(settlementsTable)
      .where(eq(settlementsTable.translatorId, userId));
    if ((settlementCount?.count ?? 0) > 0) {
      res.status(409).json({
        error: "이 통번역사는 정산 이력이 있어 완전삭제할 수 없습니다. 비활성 처리만 가능합니다.",
        reason: "settlements",
        count: settlementCount.count,
      }); return;
    }

    // 4. 이력서 파일 삭제 (GCS)
    const [profile] = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    if (profile?.resumeFileName) {
      try { await deleteResumeFromGCS(profile.resumeFileName); } catch { /* 파일 없어도 계속 */ }
    }

    // 5. 종속 데이터 삭제 (순서 중요: FK 참조 먼저)
    await db.delete(translatorRatesTable).where(eq(translatorRatesTable.translatorId, userId));
    await db.delete(translatorEmailsTable).where(eq(translatorEmailsTable.translatorId, userId));
    await db.delete(translatorSensitiveTable).where(eq(translatorSensitiveTable.translatorId, userId));
    await db.delete(translatorProductsTable).where(eq(translatorProductsTable.translatorId, userId));
    await db.delete(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    await db.delete(notesTable).where(
      and(eq(notesTable.entityType, "translator"), eq(notesTable.entityId, userId))
    );
    await db.delete(invitationsTable).where(eq(invitationsTable.userId, userId));

    // 6. 본 레코드 삭제
    await db.delete(usersTable).where(eq(usersTable.id, userId));

    // 7. 감사 로그 (users 삭제 후이므로 참조 없이 기록)
    await db.insert(logsTable).values({
      entityType: "translator",
      entityId: userId,
      action: "permanent_deleted",
      performedBy: req.user?.id ?? null,
      performedByEmail: req.user?.email ?? null,
      metadata: JSON.stringify({ name: existing.name, email: existing.email }),
    });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Translators: failed to permanent delete");
    res.status(500).json({ error: "완전삭제 중 오류가 발생했습니다. 관리자에게 문의하세요." });
  }
});

// ─── 통번역사 비활성 처리 (Soft Delete) ──────────────────────────────────────
router.delete("/admin/translators/:id", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 사용자 id." }); return;
  }

  try {
    const [existing] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!existing) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }

    if (!existing.isActive) {
      res.status(400).json({ error: "이미 비활성 처리된 통번역사입니다." }); return;
    }

    // Soft delete: 물리 삭제 없이 비활성 처리 (기존 단가/정산/작업 데이터 보존)
    await db.update(usersTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));

    await db.insert(logsTable).values({
      entityType: "translator",
      entityId: userId,
      action: "deactivated",
      performedBy: req.user?.id ?? null,
      performedByEmail: req.user?.email ?? null,
      metadata: JSON.stringify({ name: existing.name, email: existing.email }),
    });

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Translators: failed to deactivate");
    res.status(500).json({ error: "비활성 처리 중 오류가 발생했습니다. 관리자에게 문의하세요." });
  }
});

export default router;
