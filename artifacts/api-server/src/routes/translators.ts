import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import multer from "multer";
import * as XLSX from "xlsx";
import {
  db, usersTable, translatorProfilesTable, translatorRatesTable,
  translatorProductsTable, productsTable, translatorSensitiveTable,
  tasksTable, settlementsTable, logsTable, translatorEmailsTable,
  notesTable, invitationsTable, companiesTable,
} from "@workspace/db";
import { eq, and, ilike, or, sql, desc, gte, lte, inArray, isNotNull } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { getPermissionsForRole } from "../lib/rbac";
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
    const { search, languagePair, specialization, status, minRating, grade, includeInactive, svc } = req.query as {
      search?: string; languagePair?: string; specialization?: string;
      status?: string; minRating?: string; grade?: string; includeInactive?: string; svc?: string;
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
        affiliatedCompanyId: translatorProfilesTable.affiliatedCompanyId,
        settlementType: translatorProfilesTable.settlementType,
        affiliatedCompanyName: sql<string | null>`(SELECT c.name FROM companies c WHERE c.id = ${translatorProfilesTable.affiliatedCompanyId})`,
        profileWorkTypes: translatorProfilesTable.profileWorkTypes,
        profileSubTypes: translatorProfilesTable.profileSubTypes,
        operationalStatus: translatorProfilesTable.operationalStatus,
        reassignmentAllowed: translatorProfilesTable.reassignmentAllowed,
      })
      .from(usersTable)
      .leftJoin(translatorProfilesTable, eq(translatorProfilesTable.userId, usersTable.id))
      .where(
        includeInactive === "true"
          ? eq(usersTable.role, "translator")
          : and(eq(usersTable.role, "translator"), eq(usersTable.isActive, true))
      )
      .orderBy(desc(usersTable.createdAt));

    const translatorIds = rows.map(r => r.id);

    // ── 업무유형/세부유형 수집 (svc 필터 겸용) ─────────────────────────────
    const serviceMap: Record<number, { workTypes: string[]; subTypes: string[] }> = {};
    if (translatorIds.length > 0) {
      const allRates = await db
        .select({
          translatorId: translatorRatesTable.translatorId,
          serviceType: translatorRatesTable.serviceType,
          subType: translatorRatesTable.subType,
        })
        .from(translatorRatesTable)
        .where(inArray(translatorRatesTable.translatorId, translatorIds));

      for (const r of allRates) {
        if (!serviceMap[r.translatorId]) serviceMap[r.translatorId] = { workTypes: [], subTypes: [] };
        if (r.serviceType && !serviceMap[r.translatorId].workTypes.includes(r.serviceType))
          serviceMap[r.translatorId].workTypes.push(r.serviceType);
        if (r.subType && !serviceMap[r.translatorId].subTypes.includes(r.subType))
          serviceMap[r.translatorId].subTypes.push(r.subType);
      }
    }

    // ── 주민번호 — 역할별 서버사이드 마스킹 ───────────────────────────────
    // admin: 전체 노출 (900101-1234567), staff: 생년월일만 (900101-*******)
    const isAdminRole = req.user!.role === "admin";
    const sensitiveMap: Record<number, string | null> = {};
    if (translatorIds.length > 0) {
      const sensitiveRows = await db
        .select({
          translatorId: translatorSensitiveTable.translatorId,
          residentNumber: translatorSensitiveTable.residentNumber,
        })
        .from(translatorSensitiveTable)
        .where(inArray(translatorSensitiveTable.translatorId, translatorIds));

      for (const s of sensitiveRows) {
        if (!s.residentNumber) { sensitiveMap[s.translatorId] = null; continue; }
        try {
          const raw = decrypt(s.residentNumber).replace(/[^0-9]/g, "");
          if (raw.length === 13) {
            sensitiveMap[s.translatorId] = isAdminRole
              ? `${raw.slice(0, 6)}-${raw.slice(6)}`   // 전체
              : `${raw.slice(0, 6)}-*******`;            // 생년월일만
          } else {
            sensitiveMap[s.translatorId] = null;
          }
        } catch {
          sensitiveMap[s.translatorId] = null;
        }
      }
    }

    let result = rows.map(r => ({
      ...r,
      workTypes: serviceMap[r.id]?.workTypes ?? [],
      subTypes: serviceMap[r.id]?.subTypes ?? [],
      profileWorkTypes: r.profileWorkTypes ?? null,
      profileSubTypes: r.profileSubTypes ?? null,
      residentNumber: sensitiveMap[r.id] ?? null,
    }));

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
    // 업무유형 필터: 프로필 업무유형 또는 단가 기반 업무유형 포함 여부 확인
    if (svc?.trim()) {
      const svcTrim = svc.trim();
      result = result.filter(t =>
        t.workTypes.includes(svcTrim) ||
        (t.profileWorkTypes ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(svcTrim)
      );
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
    affiliatedCompanyId, settlementType,
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
      affiliatedCompanyId: (affiliatedCompanyId != null && Number(affiliatedCompanyId) > 0)
        ? Number(affiliatedCompanyId) : null,
      settlementType: settlementType?.trim() || null,
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
  // ■ 최신 표준 컬럼 순서 (21열)
  const headers = [
    "이름", "이메일", "휴대폰",
    "주민번호", "상세정보", "가능언어",
    "학력", "전공", "졸업년도",
    "업무유형", "세부유형",
    "전문분야", "경력", "평점", "상태", "가용상태",
    "지역", "등급",
    "은행명", "계좌번호", "예금주",
  ];

  const row1 = [
    "홍길동", "hong@example.com", "010-1234-5678",
    "", "", "한국어, 영어",
    "서울대학교", "영어영문학", "2005",
    "번역", "일반번역",
    "법률, 금융", "번역 경력 10년", "4.5", "Y", "available",
    "서울", "A",
    "국민은행", "", "홍길동",
  ];
  const row2 = [
    "김영희", "kim@example.com", "010-9876-5432",
    "", "", "영어, 한국어, 일본어",
    "연세대학교", "영어통번역학", "2003",
    "통역", "동시통역",
    "의료, 제약", "동시통역사 5년", "4.0", "Y", "available",
    "부산", "B",
    "", "", "",
  ];
  const row3 = [
    "박철수", "park@example.com", "010-5555-1234",
    "", "", "한국어, 영어, 일본어",
    "", "", "",
    "미디어", "자막작업",
    "영상번역", "자막 경력 5년", "", "Y", "available",
    "대구", "C",
    "", "", "",
  ];
  const row4 = [
    "이영수", "lee@example.com", "010-7777-8888",
    "", "", "한국어, 중국어(간체), 중국어(번체)",
    "", "", "",
    "", "",
    "IT, 기술", "번역 3년", "", "Y", "available",
    "광주", "B",
    "", "", "",
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, row1, row2, row3, row4]);
  ws["!cols"] = headers.map((h) => ({ wch: h === "이메일" ? 24 : 16 }));
  // 헤더 행 굵게 (스타일은 xlsx 기본 지원 안 하나, 참고용으로 남김)
  XLSX.utils.book_append_sheet(wb, ws, "통번역사");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", 'attachment; filename="translators_sample.xlsx"');
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ─── 엑셀 파싱(미리보기) ──────────────────────────────────────────────────────
// 컬럼명 → 내부 키 매핑 (최종 표준 + 하위 호환)
const EXCEL_COL_MAP: Record<string, string> = {
  // 기본정보
  "이름": "name", "이메일": "email", "이메일(필수)": "email",
  "휴대폰": "phone", "전화번호": "phone",
  "지역": "region", "등급": "grade", "전문분야": "specializations",
  "경력": "career", "상태": "status",
  "학력": "education", "전공": "major", "졸업년도": "graduationYear",
  "평점": "rating", "가용상태": "availabilityStatus",
  "상세정보": "bio",
  "주민번호": "residentNumber", "은행명": "bankName",
  "계좌번호": "bankAccount", "예금주": "accountHolder",
  // 가능언어 (신규 표준) + 하위 호환
  "가능언어": "languages", "언어": "languages",
  // 업무유형/세부유형
  "업무유형": "workType", "세부유형": "subType",
  // 구형 단가 컬럼 — 현재 import에서 무시되나 파싱 오류 방지용으로 유지
  "출발언어": "sourceLang", "도착언어": "targetLang",
  "단가단위": "unit", "단가": "rate", "기본단가": "rate",
  "통화": "currency",
  "VAT포함여부": "vatIncluded", "VAT포함(Y/N)": "vatIncluded",
  "최소금액": "minPrice", "기본시간": "baseHours",
  "추가시간단가": "overtimeRate",
  "기본단가여부": "isDefault", "단가활성여부": "rateActive",
  "단가메모": "rateMemo",
  // 구형 컬럼 하위 호환
  "등급(1~5)": "grade",
};

router.post("/admin/translators/upload-excel", ...adminGuard, excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일이 없습니다." }); return; }
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as string[][];
    if (rows.length < 2) { res.status(400).json({ error: "데이터 행이 없습니다. (1행 헤더, 2행~ 데이터)" }); return; }

    const colMap: Record<string, number> = {};
    const headerRow = rows[0].map(h => String(h ?? "").trim());
    headerRow.forEach((h, i) => { if (EXCEL_COL_MAP[h]) colMap[EXCEL_COL_MAP[h]] = i; });

    if (colMap["name"] == null && colMap["email"] == null && colMap["phone"] == null) {
      res.status(400).json({ error: "이름/이메일/휴대폰 열을 찾을 수 없습니다. 샘플 형식을 확인하세요." }); return;
    }

    const normalizePhone = (v: string) => v.replace(/[^0-9]/g, "");
    const normalizeSSN   = (v: string) => v.replace(/[^0-9]/g, "");

    // ── 주민번호 표시 권한 확인 (서버사이드 마스킹) ─────────────────────────
    const isSuperAdmin = req.user!.role === "admin" && !req.user!.roleId;
    let canSeeSensitive = isSuperAdmin;
    if (!canSeeSensitive && req.user!.roleId) {
      const perms = await getPermissionsForRole(req.user!.roleId);
      canSeeSensitive = perms.has("translator.sensitive");
    }

    type ParsedRow = {
      rowNum: number; email: string; name: string; phone: string;
      region: string; grade: string;
      specializations: string; career: string; status: string;
      education: string; major: string; graduationYear: string;
      rating: string; availabilityStatus: string; bio: string;
      residentNumber: string; bankName: string; bankAccount: string; accountHolder: string;
      workType: string; subType: string; languages: string;
      rowStatus: "ok" | "duplicate" | "review" | "error";
      validationErrors: string[];
      reviewWarnings: string[];
      duplicateReasons: string[];
    };
    const parsed: ParsedRow[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const cell = (key: string) => String(r[colMap[key] ?? -1] ?? "").trim();
      const name  = cell("name");
      const email = cell("email");
      const phone = cell("phone");
      if (!name && !email && !phone) continue; // 빈 행 스킵

      const validationErrors: string[] = [];
      const reviewWarnings:   string[] = [];

      // 1. 이름 필수
      if (!name) validationErrors.push("이름 필수");
      // 2. 이메일 또는 휴대폰 중 하나 필수
      if (!email && !phone) validationErrors.push("이메일 또는 휴대폰 중 하나 필수");
      // 3. 이메일 형식 검증
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) validationErrors.push("이메일 형식 오류");
      // 4. 휴대폰 형식 검증 (입력된 경우만)
      if (phone) {
        const digits = normalizePhone(phone);
        if (!/^01[0-9]{8,9}$/.test(digits)) validationErrors.push("휴대폰 형식 오류");
      }
      // 5. 주민번호 형식 검증 (입력된 경우만)
      const residentNumber = cell("residentNumber");
      if (residentNumber && normalizeSSN(residentNumber).length !== 13) validationErrors.push("주민번호 형식 오류 (13자리)");
      // 평점 숫자 여부
      const ratingVal = cell("rating");
      if (ratingVal && isNaN(Number(ratingVal))) validationErrors.push("평점은 숫자여야 합니다");

      const workTypeVal = cell("workType");
      const subTypeVal  = cell("subType");
      const languagesRaw = cell("languages");
      const languagesVal = languagesRaw
        ? languagesRaw.split(",").map(l => l.trim()).filter(Boolean).join(", ")
        : "";

      // 미디어 세부유형 검증
      if (workTypeVal === "미디어") {
        const MEDIA_SUBS = ["자막작업", "더빙"];
        if (subTypeVal && !MEDIA_SUBS.includes(subTypeVal))
          validationErrors.push(`미디어 세부유형은 '자막작업' 또는 '더빙'만 허용됩니다 (입력: "${subTypeVal}")`);
      }

      // 6. 가능언어 확인 (검토필요)
      if (!languagesVal) reviewWarnings.push("가능언어 미입력");
      // 7. 업무유형 확인 (검토필요)
      if (!workTypeVal) reviewWarnings.push("업무유형 미입력");

      parsed.push({
        rowNum: i + 1, email, name, phone,
        region: cell("region"), grade: cell("grade"),
        specializations: cell("specializations"), career: cell("career"),
        status: cell("status"),
        education: cell("education"), major: cell("major"), graduationYear: cell("graduationYear"),
        rating: ratingVal, availabilityStatus: cell("availabilityStatus"), bio: cell("bio"),
        residentNumber: residentNumber
          ? (canSeeSensitive ? residentNumber : maskResidentNumber(normalizeSSN(residentNumber).padEnd(13, "0")))
          : "",
        bankName: cell("bankName"),
        bankAccount: cell("bankAccount"), accountHolder: cell("accountHolder"),
        workType: workTypeVal, subType: subTypeVal, languages: languagesVal,
        rowStatus: validationErrors.length > 0 ? "error" : reviewWarnings.length > 0 ? "review" : "ok",
        validationErrors,
        reviewWarnings,
        duplicateReasons: [],
      });
    }

    // ── 중복 검사 (오류 행 제외) ──────────────────────────────────────────────
    const checkableRows = parsed.filter(p => p.rowStatus !== "error");

    // 1. 이메일 중복 (usersTable)
    const emailsToCheck = [...new Set(checkableRows.filter(p => p.email).map(p => p.email.toLowerCase()))];
    const existingEmails = emailsToCheck.length > 0
      ? await db.select({ email: usersTable.email }).from(usersTable).where(inArray(usersTable.email, emailsToCheck))
      : [];
    const existingEmailSet = new Set(existingEmails.map(u => u.email.toLowerCase()));

    // 2. 휴대폰 중복 (translatorProfilesTable — 전체 조회 후 정규화 비교)
    const phonesToCheck = checkableRows.filter(p => p.phone).map(p => normalizePhone(p.phone));
    let existingPhoneSet = new Set<string>();
    if (phonesToCheck.length > 0) {
      const allPhones = await db
        .select({ phone: translatorProfilesTable.phone })
        .from(translatorProfilesTable)
        .where(isNotNull(translatorProfilesTable.phone));
      existingPhoneSet = new Set(allPhones.map(p => normalizePhone(p.phone ?? "")).filter(Boolean));
    }

    // 3. 주민번호 중복 (translatorSensitiveTable — 복호화 비교)
    const rowsWithSSN = checkableRows.filter(p => p.residentNumber);
    let existingSSNSet = new Set<string>();
    if (rowsWithSSN.length > 0) {
      const allSensitive = await db
        .select({ residentNumber: translatorSensitiveTable.residentNumber })
        .from(translatorSensitiveTable)
        .where(isNotNull(translatorSensitiveTable.residentNumber));
      for (const s of allSensitive) {
        if (!s.residentNumber) continue;
        try {
          const raw = normalizeSSN(decrypt(s.residentNumber));
          if (raw.length === 13) existingSSNSet.add(raw);
        } catch { /* 복호화 실패 무시 */ }
      }
    }

    // 중복 상태 적용
    for (const p of checkableRows) {
      const dups: string[] = [];
      if (p.email && existingEmailSet.has(p.email.toLowerCase())) dups.push("이메일 일치");
      if (p.phone && existingPhoneSet.has(normalizePhone(p.phone)))  dups.push("휴대폰 일치");
      if (p.residentNumber && existingSSNSet.has(normalizeSSN(p.residentNumber))) dups.push("주민번호 일치");
      if (dups.length > 0) {
        p.duplicateReasons = dups;
        p.rowStatus = "duplicate";
      }
    }

    // ── 요약 통계 ──────────────────────────────────────────────────────────────
    const summary = {
      total:          parsed.length,
      ok:             parsed.filter(p => p.rowStatus === "ok").length,
      duplicate:      parsed.filter(p => p.rowStatus === "duplicate").length,
      review:         parsed.filter(p => p.rowStatus === "review").length,
      error:          parsed.filter(p => p.rowStatus === "error").length,
      missingRequired: parsed.filter(p => p.validationErrors.some(e => e.includes("필수"))).length,
      formatError:    parsed.filter(p => p.validationErrors.some(e => e.includes("형식") || e.includes("숫자"))).length,
    };

    res.json({ rows: parsed, summary });
  } catch (err) {
    req.log.error({ err }, "Excel upload parse error");
    res.status(500).json({ error: "엑셀 파싱 중 오류가 발생했습니다." });
  }
});

// ─── 엑셀 대량 등록 ──────────────────────────────────────────────────────────
router.post("/admin/translators/bulk-create", ...adminGuard, async (req, res) => {
  type BulkRow = {
    email: string; name?: string; phone?: string;
    region?: string; grade?: string;
    specializations?: string; career?: string; status?: string;
    education?: string; major?: string; graduationYear?: string; rating?: string;
    availabilityStatus?: string; bio?: string;
    residentNumber?: string; bankName?: string; bankAccount?: string; accountHolder?: string;
    languages?: string; workType?: string; subType?: string;
  };
  const { rows } = req.body as { rows: BulkRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "등록할 데이터가 없습니다." }); return;
  }

  // Y/N → boolean 헬퍼
  const yesNo = (v?: string, defaultVal = true) => {
    if (!v?.trim()) return defaultVal;
    return v.trim().toUpperCase() === "Y";
  };
  // 가용상태 정규화
  const normalizeAvailability = (v?: string) => {
    const val = v?.trim().toLowerCase();
    if (val === "busy" || val === "바쁨") return "busy";
    if (val === "unavailable" || val === "불가") return "unavailable";
    return "available";
  };

  const results: { email: string; status: "created" | "error"; error?: string }[] = [];

  for (const row of rows) {
    const email = row.email?.trim().toLowerCase();
    if (!email) { results.push({ email: "?", status: "error", error: "이메일 없음" }); continue; }
    try {
      const tempPw = randomBytes(8).toString("hex");
      const hashed = await bcrypt.hash(tempPw, 10);
      // 상태 처리 (Y=활성, N=비활성, 기본=활성)
      const isActive = yesNo(row.status, true);

      // name은 usersTable에 저장
      const [newUser] = await db.insert(usersTable).values({
        email, password: hashed, role: "translator", isActive,
        name: row.name?.trim() || null,
      }).returning({ id: usersTable.id });

      // ── 프로필 구성 ──────────────────────────────────────────────────────
      const bioText = [row.career?.trim(), row.bio?.trim()].filter(Boolean).join(" | ") || null;
      // 가능언어: 쉼표 구분 trim 후 저장 (languagePairs 필드 재활용)
      const langVal = row.languages?.trim()
        ? row.languages.split(",").map(l => l.trim()).filter(Boolean).join(", ")
        : null;
      await db.insert(translatorProfilesTable).values({
        userId: newUser.id,
        phone: row.phone?.trim() || null,
        languagePairs: langVal,
        region: row.region?.trim() || null,
        grade: row.grade?.trim() || null,
        specializations: row.specializations?.trim() || null,
        education: row.education?.trim() || null,
        major: row.major?.trim() || null,
        graduationYear: row.graduationYear?.trim() && !isNaN(Number(row.graduationYear)) ? Number(row.graduationYear) : null,
        rating: row.rating?.trim() && !isNaN(Number(row.rating)) ? Number(row.rating) : null,
        availabilityStatus: normalizeAvailability(row.availabilityStatus),
        bio: bioText || null,
      });

      // ── 이메일 등록 ──────────────────────────────────────────────────────
      await db.insert(translatorEmailsTable).values({ translatorId: newUser.id, email, isPrimary: true });

      // ── 민감정보 (주민번호/계좌 등 입력된 경우만) ─────────────────────
      const hasSensitive = row.residentNumber?.trim() || row.bankName?.trim() || row.bankAccount?.trim() || row.accountHolder?.trim();
      if (hasSensitive) {
        const encRn = row.residentNumber?.trim()
          ? encrypt(row.residentNumber.trim().replace(/-/g, "")) : null;
        const encAcc = row.bankAccount?.trim()
          ? encrypt(row.bankAccount.trim()) : null;
        await db.insert(translatorSensitiveTable).values({
          translatorId: newUser.id,
          residentNumber: encRn,
          bankName: row.bankName?.trim() || null,
          bankAccount: encAcc,
          accountHolder: row.accountHolder?.trim() || null,
          paymentMethod: "domestic_withholding",
        });
      }

      // ── 업무유형 등록 (업무유형 있으면 placeholder 레코드 생성) ──────────
      // rate=0, isActive=false 로 저장 → 2차에서 실제 단가 설정 예정
      const workTypeVal = row.workType?.trim();
      if (workTypeVal) {
        await db.insert(translatorRatesTable).values({
          translatorId: newUser.id,
          serviceType: workTypeVal,
          subType: row.subType?.trim() || null,
          unit: "word",
          rate: 0,
          currency: "KRW",
          isActive: false,
          isDefault: false,
          memo: "단가 미설정 (1차 등록)",
        });
      }

      await db.insert(logsTable).values({
        entityType: "translator", entityId: newUser.id,
        action: "bulk_created", performedBy: req.user?.id ?? null,
        performedByEmail: req.user?.email ?? null,
        metadata: JSON.stringify({ email, name: row.name?.trim() }),
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
    const affiliatedCompany = profile?.affiliatedCompanyId
      ? await db.select({ id: companiesTable.id, name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, profile.affiliatedCompanyId)).limit(1)
      : [];
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
      profile: profile ? {
        ...profile,
        affiliatedCompanyName: affiliatedCompany[0]?.name ?? null,
      } : null,
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
    affiliatedCompanyId, settlementType,
    profileWorkTypes, profileSubTypes,
    operationalStatus, operationalNote, reassignmentAllowed,
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
      affiliatedCompanyId: (affiliatedCompanyId != null && affiliatedCompanyId !== "" && Number(affiliatedCompanyId) > 0)
        ? Number(affiliatedCompanyId) : null,
      settlementType: settlementType?.trim() || null,
      profileWorkTypes: profileWorkTypes !== undefined ? (profileWorkTypes?.trim() || null) : undefined,
      profileSubTypes: profileSubTypes !== undefined ? (profileSubTypes?.trim() || null) : undefined,
      operationalStatus: (operationalStatus && ["normal","warning","hold","excluded"].includes(operationalStatus))
        ? operationalStatus : undefined,
      operationalNote: operationalNote !== undefined ? (operationalNote?.trim() || null) : undefined,
      reassignmentAllowed: reassignmentAllowed !== undefined ? Boolean(reassignmentAllowed) : undefined,
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
      const label = [resolvedServiceType, resolvedSubType, resolvedLanguage ? `${resolvedLanguage}-${resolvedLangPair}` : resolvedLangPair, resolvedUnit].filter(Boolean).join(" / ");
      res.status(409).json({ error: `이미 동일한 단가 항목이 존재합니다. (${label})` });
      return;
    }
    const willBeDefault = isDefault === true;
    // 기본단가 설정 시 동일 서비스조건(serviceType+subType+언어쌍, unit 무관)의 기존 기본단가 자동 해제
    if (willBeDefault) {
      const clearConditions = [
        eq(translatorRatesTable.translatorId, userId),
        eq(translatorRatesTable.serviceType, resolvedServiceType),
        eq(translatorRatesTable.isDefault, true),
        resolvedSubType ? eq(translatorRatesTable.subType, resolvedSubType) : sql`${translatorRatesTable.subType} IS NULL`,
        resolvedLanguage ? eq(translatorRatesTable.language, resolvedLanguage) : sql`${translatorRatesTable.language} IS NULL`,
        resolvedLangPair ? eq(translatorRatesTable.languagePair, resolvedLangPair) : sql`${translatorRatesTable.languagePair} IS NULL`,
      ];
      await db.update(translatorRatesTable)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(...clearConditions));
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
        vatIncluded: vatIncluded === true,          // 기본값 false
        isDefault: willBeDefault,                   // 기본값 false
        isActive: isActive !== false,               // 기본값 true
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
