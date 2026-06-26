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
import { logEvent } from "../lib/logEvent";
import {
  uploadResumeToGCS, deleteResumeFromGCS, getResumeDownloadUrl, isAllowedMime, isAllowedExt,
  uploadDocumentToGCS, isAllowedDocumentMime, isAllowedDocumentExt,
} from "../lib/gcsResume";
import OpenAI from "openai";
import { createRequire } from "node:module";
import path from "node:path";
import { execFile } from "node:child_process";
import { writeFile, readFile, unlink, access, stat, constants as fsConstants } from "node:fs/promises";
import { tmpdir } from "node:os";

const _require = createRequire(import.meta.url);
// pdf-parse v2.x and mammoth are CJS-only modules; must use createRequire in ESM context
// pdf-parse v2.x changed API: no longer a callable function; now exports { PDFParse } class
const { PDFParse: PdfParseClass } = _require("pdf-parse") as {
  PDFParse: new(opts: { data: Buffer }) => { getText(): Promise<{ text: string }>; destroy(): Promise<void> };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mammoth = _require("mammoth") as typeof import("mammoth");
// word-extractor: pure-JS .doc (OLE2) parser — no system binary required
const WordExtractorCls = _require("word-extractor") as new () => {
  extract(source: Buffer | string): Promise<{ getBody(): string }>;
};
// kordoc: HWP/HWPX parser (CJS)
const kordoc = _require("kordoc") as {
  parse: (input: Buffer | string, options?: { filePath?: string }) => Promise<{
    success: boolean; markdown?: string; fileType?: string; warnings?: string[];
  }>;
};

async function extractWithPdftotext(buffer: Buffer): Promise<string> {
  const tag = `pdf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpIn = path.join(tmpdir(), `${tag}.pdf`);
  const tmpOut = path.join(tmpdir(), `${tag}.txt`);
  try {
    await writeFile(tmpIn, buffer);
    const pdfTotextBin = await new Promise<string>((resolve, reject) => {
      execFile("which", ["pdftotext"], (err, out) => {
        if (err || !out.trim()) reject(new Error("pdftotext not found in PATH"));
        else resolve(out.trim());
      });
    });
    console.log(`[POPPLER-REAL] bin=${pdfTotextBin}`);
    await new Promise<void>((resolve, reject) => {
      execFile(pdfTotextBin, ["-enc", "UTF-8", tmpIn, tmpOut], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return await readFile(tmpOut, "utf-8");
  } finally {
    await Promise.all([unlink(tmpIn).catch(() => {}), unlink(tmpOut).catch(() => {})]);
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // [PDF-REAL] VER=1 — 이 마커가 Railway Logs에 보이면 신규 PDF 코드 실행 중
  console.log(`[PDF-REAL] VER=1 bytes=${buffer.byteLength} ts=${Date.now()}`);

  // 경로 1: pdf-parse (PDFParse class)
  console.log(`[PDF-PARSE] start — bytes=${buffer.byteLength}`);
  const parser = new PdfParseClass({ data: buffer });
  let pdfParseErr: unknown;
  try {
    const result = await parser.getText();
    const text = result.text ?? "";
    console.log(`[PDF-PARSE] OK — textLen=${text.length} preview="${text.slice(0, 100).replace(/\n/g, "\\n")}"`);
    return text;
  } catch (err) {
    pdfParseErr = err;
    const e = err instanceof Error ? err : new Error(String(err));
    console.log(`[PDF-PARSE] FAILED — ${e.message}`);
    console.log(`[PDF-ERROR] pdf-parse threw: name=${e.name} msg=${e.message}`);
    console.log(`[PDF-ERROR] stack=${e.stack ?? "(no stack)"}`);
  } finally {
    await parser.destroy().catch(() => {});
  }

  // 경로 2: pdftotext (Poppler) — pdf-parse 실패 시 fallback
  console.log(`[POPPLER-REAL] fallback start — bytes=${buffer.byteLength}`);
  try {
    const text = await extractWithPdftotext(buffer);
    console.log(`[POPPLER-REAL] OK — textLen=${text.length} preview="${text.slice(0, 100).replace(/\n/g, "\\n")}"`);
    return text;
  } catch (popErr) {
    const e2 = popErr instanceof Error ? popErr : new Error(String(popErr));
    console.log(`[POPPLER-REAL] FAILED — ${e2.message}`);
    console.log(`[PDF-ERROR] pdftotext also threw: name=${e2.name} msg=${e2.message}`);
    console.log(`[PDF-ERROR] stack=${e2.stack ?? "(no stack)"}`);
    throw pdfParseErr; // 원본 에러를 상위로 던짐
  }
}

async function extractHwpText(buffer: Buffer): Promise<string> {
  const result = await kordoc.parse(buffer);
  if (!result.success) {
    console.log(`[422][L67] extractHwpText: kordoc.parse failed — success=false fileType=${result.fileType ?? "unknown"}`);
    throw new Error(`kordoc parse 실패 (fileType: ${result.fileType ?? "unknown"})`);
  }
  return result.markdown ?? "";
}

/**
 * 파일 magic byte로 실제 포맷 판별 (확장자는 신뢰하지 않음).
 * - "ole2" : OLE2 Compound Document (Word 97-2003 binary .doc)
 * - "zip"  : ZIP 기반 (DOCX / XLSX — mammoth로 처리 가능)
 * - "pdf"  : PDF
 * - "hwp5" : HWP5 (한글 2.x~)
 * - "unknown"
 */
function detectDocFormat(buf: Buffer): "ole2" | "zip" | "pdf" | "hwp5" | "unknown" {
  if (buf.length < 4) return "unknown";
  if (buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) return "ole2";
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) return "zip";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "pdf";
  if (buf[0] === 0x48 && buf[1] === 0x57 && buf[2] === 0x50 && buf[3] === 0x20) return "hwp5";
  return "unknown";
}

/**
 * antiword 실행 파일 경로를 찾는다.
 * Railway/Nixpacks 환경에서는 PATH가 Node.js 프로세스에 온전히 전달되지 않을 수 있어
 * which 외에 알려진 고정 경로도 탐색한다.
 */
async function findAntiword(): Promise<string | null> {
  // 1) which로 먼저 시도
  const fromWhich = await new Promise<string | null>(resolve => {
    execFile("which", ["antiword"], (e, out) => resolve(e ? null : (out.trim() || null)));
  });
  if (fromWhich) return fromWhich;

  // 2) nixpkgs/Railway가 symlink를 생성하는 알려진 경로들
  const candidates = [
    "/usr/bin/antiword",
    "/usr/local/bin/antiword",
    "/opt/homebrew/bin/antiword",
    "/nix/var/nix/profiles/default/bin/antiword",
  ];
  for (const p of candidates) {
    try { await access(p, fsConstants.X_OK); return p; } catch { /* not found */ }
  }
  return null;
}

/**
 * .doc / .docx 파일에서 텍스트를 추출한다.
 * 우선순위: mammoth(ZIP/DOCX) → word-extractor(OLE2, 순수 JS) → antiword(시스템 바이너리 fallback)
 * word-extractor는 시스템 의존성 없이 OLE2 .doc를 파싱하므로 Railway/Docker 환경에서도 작동한다.
 */
async function extractDocText(buffer: Buffer, label: string): Promise<{ text: string; method: string }> {
  // [DOC-REAL] VER=6 — 이 마커가 Railway Logs에 보이면 신규 코드 실행 중
  console.log(`[DOC-REAL] VER=6 label=${label} bytes=${buffer.byteLength} ts=${Date.now()}`);
  const fmt = detectDocFormat(buffer);
  console.log(`[DOC-EXTRACT][${label}] start — fmt=${fmt} bytes=${buffer.byteLength}`);

  // ZIP 서명 → 실제 DOCX (확장자가 .doc여도 mammoth로 처리)
  if (fmt === "zip") {
    try {
      const result = await mammoth.extractRawText({ buffer });
      console.log(`[DOC-EXTRACT][${label}] mammoth(zip-docx) OK — textLen=${result.value.length}`);
      return { text: result.value, method: "mammoth(zip-docx)" };
    } catch (mammothErr) {
      const e = mammothErr instanceof Error ? mammothErr : new Error(String(mammothErr));
      console.log(`[DOC-EXTRACT][${label}] mammoth(zip-docx) FAILED — ${e.message}`);
      throw mammothErr;
    }
  }

  // OLE2 또는 unknown → word-extractor 우선 시도 (순수 JS, 시스템 의존성 없음)
  console.log(`[DOC-EXTRACT][${label}] word-extractor: calling extract(buffer) — bufferBytes=${buffer.byteLength}`);
  try {
    const extractor = new WordExtractorCls();
    const doc = await extractor.extract(buffer);
    const text = doc.getBody();
    // 반환값 상세 로그: null/undefined/빈 문자열/공백만 있는 경우를 모두 구분
    const textType = text === null ? "null" : text === undefined ? "undefined" : typeof text;
    const textLen = text?.length ?? -1;
    const trimmedLen = text?.trim()?.length ?? -1;
    const textPreview = JSON.stringify((text ?? "").slice(0, 100));
    console.log(`[DOC-EXTRACT][${label}] word-extractor getBody() — type=${textType} len=${textLen} trimmedLen=${trimmedLen} preview=${textPreview}`);
    if (text?.trim()) {
      console.log(`[DOC-EXTRACT][${label}] word-extractor OK — textLen=${text.length} — RETURNING`);
      return { text, method: "word-extractor" };
    }
    console.log(`[DOC-EXTRACT][${label}] word-extractor: trim() falsy (len=${textLen} trimmedLen=${trimmedLen}) — NOT returning, falling through to antiword`);
  } catch (weErr) {
    const e = weErr instanceof Error ? weErr : new Error(String(weErr));
    console.log("[WE-ERROR] word-extractor threw:"); console.log(weErr); console.log("[WE-ERROR] message:", e.message); console.log("[WE-ERROR] stack:", e.stack);
    console.log(`[DOC-EXTRACT][${label}] word-extractor THREW — name=${e.name} message="${e.message}" stack="${(e.stack ?? "").slice(0, 300)}" — falling through to antiword`);
  }

  // antiword fallback (시스템 바이너리)
  console.log(`[DOC-EXTRACT][${label}] ENTERING antiword fallback`);
  const antiwordBin = await findAntiword();
  console.log(`[ANTIWORD] path ${antiwordBin ?? "NOT_FOUND"}`);

  if (antiwordBin) {
    const tmpPath = path.join(tmpdir(), `doc_${label}_${Date.now()}.doc`);
    console.log("[REAL-ANTIWORD]");
    // [ANTIWORD-REAL] VER=6 — 이 마커가 보이면 antiword 실행 분기에 진입한 것
    console.log(`[ANTIWORD-REAL] VER=6 bin=${antiwordBin} tmp=${tmpPath} ts=${Date.now()}`);
    console.log(`[ANTIWORD] exec ${antiwordBin} ${tmpPath}`);
    console.log(`[ANTIWORD] HOME="${process.env.HOME ?? "(unset)"}" tmpdir="${tmpdir()}"`);

    await writeFile(tmpPath, buffer);
    try {
      const fileStat = await stat(tmpPath);
      console.log(`[ANTIWORD] tmpFile exists=true size=${fileStat.size}`);
    } catch (statErr) {
      console.log(`[ANTIWORD] tmpFile exists=false — ${String(statErr)}`);
    }

    try {
      const text = await new Promise<string>((resolve, reject) => {
        execFile(
          antiwordBin,
          ["-w", "0", tmpPath],
          {
            timeout: 30_000,
            maxBuffer: 5 * 1024 * 1024,
            env: { ...process.env, HOME: process.env.HOME ?? "/root" },
          },
          (err, stdout, stderr) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const e = err as any;
            console.log(`[ANTIWORD] stdout.length=${stdout?.length ?? 0}`);
            console.log(`[ANTIWORD] stderr="${(stderr ?? "").slice(0, 500)}"`);
            if (err) {
              console.log(`[ANTIWORD] error.message=${err.message}`);
              console.log(`[ANTIWORD] error.code=${e?.code ?? "(none)"}`);
              console.log(`[ANTIWORD] error.errno=${e?.errno ?? "(none)"}`);
              console.log(`[ANTIWORD] error.signal=${e?.signal ?? "(none)"}`);
              console.log(`[ANTIWORD] error.killed=${e?.killed}`);
              console.log(`[ANTIWORD] error.stderr="${(e?.stderr ?? "").toString().slice(0, 300)}"`);
              console.log(`[ANTIWORD] error.stdout="${(e?.stdout ?? "").toString().slice(0, 300)}"`);
              // 실제 에러를 그대로 reject (고정 메시지 사용 안 함)
              const detail = stderr?.trim() || stdout?.trim() || err.message || "empty output";
              return reject(new Error(`antiword 실행 실패: ${detail} (code=${e?.code ?? "N/A"})`));
            }
            if (stdout?.trim()) resolve(stdout);
            else {
              console.log(`[ANTIWORD] stdout empty — rejecting`);
              reject(new Error(`antiword: stdout가 비어있습니다. stderr="${(stderr ?? "").slice(0, 200)}"`));
            }
          },
        );
      });
      console.log(`[ANTIWORD] OK textLen=${text.length}`);
      return { text, method: `antiword(${antiwordBin})` };
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  // findAntiword()가 null 반환 — 고정 경로 탐색 실패.
  // PATH를 통해 직접 execFile("antiword", ...) 시도하여 실제 OS 오류를 반환한다.
  // (execvp는 PATH를 사용하므로 nix 환경에서도 동작 가능)
  console.log(`[ANTIWORD] findAntiword=null — trying execFile("antiword") via PATH`);
  const tmpPathFallback = path.join(tmpdir(), `doc_${label}_fallback_${Date.now()}.doc`);
  await writeFile(tmpPathFallback, buffer);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        "antiword",
        ["-w", "0", tmpPathFallback],
        {
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, HOME: process.env.HOME ?? "/root" },
        },
        (err, stdout, stderr) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = err as any;
          console.log(`[ANTIWORD-PATH] stdout.length=${stdout?.length ?? 0} stderr="${(stderr ?? "").slice(0, 300)}"`);
          if (err) {
            console.log(`[ANTIWORD-PATH] error: ${err.message} code=${e?.code}`);
            const detail = stderr?.trim() || stdout?.trim() || err.message || "empty output";
            return reject(new Error(`antiword(PATH) 실행 실패: ${detail} (code=${e?.code ?? "N/A"})`));
          }
          if (stdout?.trim()) resolve(stdout);
          else reject(new Error(`antiword(PATH): stdout 비어있음 stderr="${(stderr ?? "").slice(0, 200)}"`));
        },
      );
    });
    console.log(`[ANTIWORD-PATH] OK textLen=${text.length}`);
    return { text, method: "antiword(PATH)" };
  } finally {
    await unlink(tmpPathFallback).catch(() => {});
  }
}

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // MIME 타입 또는 확장자 중 하나를 통과하면 허용 (HWP 등 MIME 불안정 형식 대비)
    if (isAllowedMime(file.mimetype) || isAllowedExt(file.originalname)) cb(null, true);
    else cb(new Error("PDF, HWP, HWPX, DOCX, DOC, TXT 형식만 업로드할 수 있습니다."));
  },
});

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedDocumentMime(file.mimetype) || isAllowedDocumentExt(file.originalname)) cb(null, true);
    else cb(new Error("JPG, PNG, PDF 형식만 업로드할 수 있습니다."));
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
        languageExperiences: translatorProfilesTable.languageExperiences,
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
      languageExperiences: r.languageExperiences ?? null,
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
    education, major, graduationYear, graduationStatus, rating,
    grade, bio, ratePerWord, ratePerPage, unitType, unitPrice,
    resumeUrl, portfolioUrl, availabilityStatus,
    affiliatedCompanyId, settlementType,
    profileWorkTypes, profileSubTypes,
    languageExperiences: langExpsCreate,
  } = req.body;

  if (!email?.trim()) { res.status(400).json({ error: "이메일은 필수입니다." }); return; }

  try {
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email.trim())).limit(1);
    if (existing.length > 0) { res.status(409).json({ error: "이미 등록된 이메일입니다." }); return; }

    const inviteToken = generateInviteToken();
    const [newUser] = await db.insert(usersTable).values({
      email: email.trim(), password: null,
      name: normalizeExtractedName(name?.trim() || null), role: "translator",
      isActive: true, inviteToken,
    }).returning();

    const [profile] = await db.insert(translatorProfilesTable).values({
      userId: newUser.id,
      phone: phone?.trim() || null, region: region?.trim() || null,
      languagePairs: languagePairs?.trim() || null, languageLevel: languageLevel || null,
      specializations: normalizeSpecializationsString(specializations?.trim() || null),
      education: education?.trim() || null, major: major?.trim() || null,
      graduationYear: graduationYear ? Number(graduationYear) : null,
      graduationStatus: graduationStatus?.trim() || null,
      rating: rating ? Number(rating) : null,
      grade: grade || null, bio: stripLangNamesFromBio(bio?.trim() || null),
      ratePerWord: ratePerWord ? Number(ratePerWord) : null,
      ratePerPage: ratePerPage ? Number(ratePerPage) : null,
      unitType: unitType ?? "eojeol",
      unitPrice: unitPrice ? Number(unitPrice) : null,
      resumeUrl: resumeUrl?.trim() || null, portfolioUrl: portfolioUrl?.trim() || null,
      availabilityStatus: availabilityStatus ?? "available",
      affiliatedCompanyId: (affiliatedCompanyId != null && Number(affiliatedCompanyId) > 0)
        ? Number(affiliatedCompanyId) : null,
      settlementType: settlementType?.trim() || null,
      profileWorkTypes: profileWorkTypes?.trim() || null,
      profileSubTypes: profileSubTypes?.trim() || null,
      languageExperiences: (typeof langExpsCreate === "string" && langExpsCreate) ? langExpsCreate : null,
    }).returning();

    // 대표 이메일을 translator_emails에 시딩
    await db.insert(translatorEmailsTable).values({
      translatorId: newUser.id, email: newUser.email, isPrimary: true,
    });

    // 소속 회사명 조회 (설정된 경우에만)
    const affiliatedCompanyName = profile.affiliatedCompanyId
      ? (await db.select({ name: companiesTable.name })
          .from(companiesTable)
          .where(eq(companiesTable.id, profile.affiliatedCompanyId))
          .limit(1))[0]?.name ?? null
      : null;

    // 목록 조회(GET /admin/translators)와 동일한 shape으로 응답
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
      operationalStatus: profile.operationalStatus,
      bio: profile.bio,
      ratePerWord: profile.ratePerWord, ratePerPage: profile.ratePerPage,
      unitType: profile.unitType, unitPrice: profile.unitPrice,
      resumeUrl: profile.resumeUrl, portfolioUrl: profile.portfolioUrl,
      education: profile.education, major: profile.major, graduationYear: profile.graduationYear,
      profileWorkTypes: profile.profileWorkTypes ?? null,
      profileSubTypes: profile.profileSubTypes ?? null,
      affiliatedCompanyId: profile.affiliatedCompanyId ?? null,
      affiliatedCompanyName,
      settlementType: profile.settlementType ?? null,
      reassignmentAllowed: profile.reassignmentAllowed ?? true,
      languageExperiences: profile.languageExperiences ?? null,
      workTypes: [],   // 등록 직후 단가 없음 — 단가 추가 후 목록 새로고침 시 반영
      subTypes: [],
      residentNumber: null,
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
        name: normalizeExtractedName(row.name?.trim() || null),
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
        specializations: normalizeSpecializationsString(row.specializations?.trim() || null),
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

// ─── 정산유형만 업데이트 (SensitiveInfoModal에서 호출) ───────────────────────
router.patch("/admin/translators/:id/settlement-type", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }
  const { settlementType } = req.body;
  try {
    const existing = await db.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, userId));
    const value = typeof settlementType === "string" ? settlementType.trim() || null : null;
    if (existing.length === 0) {
      await db.insert(translatorProfilesTable).values({ userId, settlementType: value, updatedAt: new Date() });
    } else {
      await db.update(translatorProfilesTable).set({ settlementType: value, updatedAt: new Date() }).where(eq(translatorProfilesTable.userId, userId));
    }
    res.json({ settlementType: value });
  } catch (err) {
    console.error("[PATCH settlement-type]", err);
    res.status(500).json({ error: "저장 실패" });
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
    graduationYear, graduationStatus, phone, region, grade, rating, availabilityStatus, bio,
    affiliatedCompanyId, settlementType,
    profileWorkTypes, profileSubTypes,
    operationalStatus, operationalNote, reassignmentAllowed,
    languageExperiences,
    emails,
  } = req.body;

  try {
    const [user] = await db.select().from(usersTable).where(
      and(eq(usersTable.id, userId), eq(usersTable.role, "translator"))
    );
    if (!user) { res.status(404).json({ error: "번역사를 찾을 수 없습니다." }); return; }

    // 이름 업데이트 — 한글 전용 이름은 내부 공백 제거 후 저장
    const normalizedName = normalizeExtractedName(typeof name === "string" ? name.trim() : null);
    // ⑤ 서버 PATCH 수신 name  ⑥ normalize 후 DB 저장 직전
    console.log(`[NAME-TRACE][5] PATCH received userId=${userId} nameFromReq="${name ?? "null"}" normalizedName="${normalizedName ?? "null"}" currentDbName="${user.name ?? "null"}" willUpdate=${!!(normalizedName && normalizedName !== user.name)}`);
    if (normalizedName && normalizedName !== user.name) {
      await db.update(usersTable).set({ name: normalizedName, updatedAt: new Date() }).where(eq(usersTable.id, userId));
      const [savedUser] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, userId));
      // ⑦ DB 저장 후 조회
      console.log(`[NAME-TRACE][7] after DB save userId=${userId} savedName="${savedUser?.name ?? "null"}"`);
    } else {
      console.log(`[NAME-TRACE][5b] name NOT updated userId=${userId} reason="${normalizedName ? "same as current" : "no name in request"}"`);
    }

    const profileData = {
      languagePairs: languagePairs?.trim() || null,
      languageLevel: languageLevel?.trim() || null,
      specializations: normalizeSpecializationsString(specializations?.trim() || null),
      education: education?.trim() || null,
      major: major?.trim() || null,
      graduationYear: (graduationYear != null && graduationYear !== "") ? Number(graduationYear) : null,
      graduationStatus: graduationStatus?.trim() || null,
      phone: phone?.trim() || null,
      region: region?.trim() || null,
      grade: grade || null,
      rating: (rating != null && rating !== "") ? Number(rating) : null,
      availabilityStatus: availabilityStatus ?? "available",
      bio: (() => {
        const rawBio = bio?.trim() || null;
        const strippedBio = stripLangNamesFromBio(rawBio);
        req.log.info({ bioOriginal: rawBio, bioStripped: strippedBio }, "[bio] AI Original → After strip → Saving");
        return strippedBio;
      })(),
      affiliatedCompanyId: (affiliatedCompanyId != null && affiliatedCompanyId !== "" && Number(affiliatedCompanyId) > 0)
        ? Number(affiliatedCompanyId) : null,
      settlementType: settlementType?.trim() || null,
      profileWorkTypes: profileWorkTypes !== undefined ? (profileWorkTypes?.trim() || null) : undefined,
      profileSubTypes: profileSubTypes !== undefined ? (profileSubTypes?.trim() || null) : undefined,
      operationalStatus: (operationalStatus && ["normal","warning","hold","excluded"].includes(operationalStatus))
        ? operationalStatus : undefined,
      operationalNote: operationalNote !== undefined ? (operationalNote?.trim() || null) : undefined,
      reassignmentAllowed: reassignmentAllowed !== undefined ? Boolean(reassignmentAllowed) : undefined,
      languageExperiences: languageExperiences !== undefined
        ? (typeof languageExperiences === "string" ? languageExperiences || null : null)
        : undefined,
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

      // multer은 multipart filename 헤더를 latin1로 파싱하므로 UTF-8로 재디코딩
      const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      req.log.info({ userId, storedPath, fileName }, "Resume uploaded");
      res.json({ resumeUrl: storedPath, fileName });
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

// ─── 이력서 강제 다운로드 (Content-Disposition: attachment 프록시) ────────────
router.get("/admin/translators/:id/resume-download", ...adminGuard, async (req, res) => {
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
    const signedUrl = await getResumeDownloadUrl(profile.resumeUrl);
    const fileRes = await fetch(signedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) throw new Error(`파일 로드 실패: ${fileRes.status}`);

    const ext = path.extname(profile.resumeUrl).toLowerCase() || ".pdf";
    const contentType = fileRes.headers.get("Content-Type") ?? "application/octet-stream";
    const filename = encodeURIComponent(`이력서${ext}`);
    const inline = req.query.inline === "true";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Type", contentType);

    const buf = Buffer.from(await fileRes.arrayBuffer());
    res.send(buf);
  } catch (err) {
    req.log.error({ err }, "Resume download proxy failed");
    if (!res.headersSent) res.status(500).json({ error: "이력서 다운로드 실패." });
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

// ─── 증빙서류(신분증/통장사본) 업로드 ─────────────────────────────────────────
type DocType = "id_card" | "bankbook";

function docLabel(type: DocType): string {
  return type === "id_card" ? "신분증" : "통장사본";
}

router.post(
  "/admin/translators/:id/document-upload",
  ...adminGuard,
  requirePermission("translator.sensitive"),
  documentUpload.single("file"),
  async (req, res) => {
    const userId = Number(req.params.id);
    if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
    const docType = req.query.type as DocType | undefined;
    if (docType !== "id_card" && docType !== "bankbook") {
      res.status(400).json({ error: "type 파라미터는 id_card 또는 bankbook 이어야 합니다." }); return;
    }
    if (!req.file) { res.status(400).json({ error: "파일을 첨부해주세요. (필드명: file)" }); return; }
    const label = docLabel(docType);
    try {
      const [existing] = await db
        .select({ idCardUrl: translatorSensitiveTable.idCardUrl, bankbookUrl: translatorSensitiveTable.bankbookUrl })
        .from(translatorSensitiveTable)
        .where(eq(translatorSensitiveTable.translatorId, userId));

      const prevUrl = docType === "id_card" ? existing?.idCardUrl : existing?.bankbookUrl;
      if (prevUrl) await deleteResumeFromGCS(prevUrl).catch(() => {});

      const subFolder = docType === "id_card" ? "id-cards" as const : "bankbooks" as const;
      const storedPath = await uploadDocumentToGCS(req.file.buffer, req.file.originalname, req.file.mimetype, subFolder);
      const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");

      if (!existing) {
        if (docType === "id_card") {
          await db.insert(translatorSensitiveTable).values({ translatorId: userId, idCardUrl: storedPath, idCardFileName: fileName });
        } else {
          await db.insert(translatorSensitiveTable).values({ translatorId: userId, bankbookUrl: storedPath, bankbookFileName: fileName });
        }
      } else {
        if (docType === "id_card") {
          await db.update(translatorSensitiveTable)
            .set({ idCardUrl: storedPath, idCardFileName: fileName, updatedAt: new Date() })
            .where(eq(translatorSensitiveTable.translatorId, userId));
        } else {
          await db.update(translatorSensitiveTable)
            .set({ bankbookUrl: storedPath, bankbookFileName: fileName, updatedAt: new Date() })
            .where(eq(translatorSensitiveTable.translatorId, userId));
        }
      }

      req.log.info({ userId, docType, storedPath, fileName }, `${label} uploaded`);
      res.json({ url: storedPath, fileName });
    } catch (err) {
      req.log.error({ err }, `${label} upload failed`);
      res.status(500).json({ error: `${label} 업로드에 실패했습니다.` });
    }
  },
);

router.get("/admin/translators/:id/document-url", ...adminGuard, requirePermission("translator.sensitive"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  const docType = req.query.type as DocType | undefined;
  if (docType !== "id_card" && docType !== "bankbook") {
    res.status(400).json({ error: "type 파라미터는 id_card 또는 bankbook 이어야 합니다." }); return;
  }
  const label = docLabel(docType);
  try {
    const [row] = await db
      .select({ idCardUrl: translatorSensitiveTable.idCardUrl, bankbookUrl: translatorSensitiveTable.bankbookUrl })
      .from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, userId));
    const storedPath = docType === "id_card" ? row?.idCardUrl : row?.bankbookUrl;
    if (!storedPath) { res.status(404).json({ error: `${label}가 없습니다.` }); return; }
    const downloadUrl = await getResumeDownloadUrl(storedPath);
    res.json({ downloadUrl });
  } catch (err) {
    req.log.error({ err }, `${label} URL generation failed`);
    res.status(500).json({ error: `${label} 다운로드 URL 생성 실패.` });
  }
});

router.get("/admin/translators/:id/document-download", ...adminGuard, requirePermission("translator.sensitive"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  const docType = req.query.type as DocType | undefined;
  if (docType !== "id_card" && docType !== "bankbook") {
    res.status(400).json({ error: "type 파라미터는 id_card 또는 bankbook 이어야 합니다." }); return;
  }
  const label = docLabel(docType);
  try {
    const [row] = await db
      .select({
        idCardUrl: translatorSensitiveTable.idCardUrl,
        idCardFileName: translatorSensitiveTable.idCardFileName,
        bankbookUrl: translatorSensitiveTable.bankbookUrl,
        bankbookFileName: translatorSensitiveTable.bankbookFileName,
      })
      .from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, userId));
    const storedPath = docType === "id_card" ? row?.idCardUrl : row?.bankbookUrl;
    const origFileName = docType === "id_card" ? row?.idCardFileName : row?.bankbookFileName;
    if (!storedPath) { res.status(404).json({ error: `${label}가 없습니다.` }); return; }
    const signedUrl = await getResumeDownloadUrl(storedPath);
    const fileRes = await fetch(signedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) throw new Error(`파일 로드 실패: ${fileRes.status}`);
    const ext = path.extname(storedPath).toLowerCase() || ".pdf";
    const contentType = fileRes.headers.get("Content-Type") ?? "application/octet-stream";
    const baseName = origFileName ?? `${label}${ext}`;
    const filename = encodeURIComponent(baseName);
    const inline = req.query.inline === "true";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Type", contentType);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    res.send(buf);
  } catch (err) {
    req.log.error({ err }, `${label} download proxy failed`);
    if (!res.headersSent) res.status(500).json({ error: `${label} 다운로드 실패.` });
  }
});

router.delete("/admin/translators/:id/document", ...adminGuard, requirePermission("translator.sensitive"), async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  const docType = req.query.type as DocType | undefined;
  if (docType !== "id_card" && docType !== "bankbook") {
    res.status(400).json({ error: "type 파라미터는 id_card 또는 bankbook 이어야 합니다." }); return;
  }
  const label = docLabel(docType);
  try {
    const [row] = await db
      .select({ idCardUrl: translatorSensitiveTable.idCardUrl, bankbookUrl: translatorSensitiveTable.bankbookUrl })
      .from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, userId));
    const storedPath = docType === "id_card" ? row?.idCardUrl : row?.bankbookUrl;
    if (storedPath) await deleteResumeFromGCS(storedPath).catch(() => {});
    if (docType === "id_card") {
      await db.update(translatorSensitiveTable)
        .set({ idCardUrl: null, idCardFileName: null, updatedAt: new Date() })
        .where(eq(translatorSensitiveTable.translatorId, userId));
    } else {
      await db.update(translatorSensitiveTable)
        .set({ bankbookUrl: null, bankbookFileName: null, updatedAt: new Date() })
        .where(eq(translatorSensitiveTable.translatorId, userId));
    }
    req.log.info({ userId, docType }, `${label} deleted`);
    await logEvent("translator", userId, `document.${docType}.deleted`, req.log, req.user, JSON.stringify({ docType }));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, `${label} delete failed`);
    res.status(500).json({ error: `${label} 삭제 실패.` });
  }
});

router.get("/admin/translators/:id/document-meta", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { res.status(400).json({ error: "유효하지 않은 user id." }); return; }
  try {
    const [row] = await db
      .select({
        idCardUrl: translatorSensitiveTable.idCardUrl,
        idCardFileName: translatorSensitiveTable.idCardFileName,
        bankbookUrl: translatorSensitiveTable.bankbookUrl,
        bankbookFileName: translatorSensitiveTable.bankbookFileName,
      })
      .from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, userId));
    res.json({
      idCardExists: !!row?.idCardUrl,
      idCardFileName: row?.idCardFileName ?? null,
      bankbookExists: !!row?.bankbookUrl,
      bankbookFileName: row?.bankbookFileName ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Document meta failed");
    res.status(500).json({ error: "문서 메타 조회 실패." });
  }
});

// ─── 이력서 AI 분석 공통 상수 & 정규화 헬퍼 ────────────────────────────────────
const RESUME_WORK_TYPES = ["번역", "통역", "감수", "편집", "미디어", "DTP", "행사운영"];
const RESUME_SUB_TYPES = [
  "일반번역", "전문번역", "긴급번역", "공증번역",
  "동시통역", "위스퍼링통역", "순차통역", "수행통역", "미팅통역", "전시회통역", "화상통역", "전화통역",
  "교정", "윤문", "원어민감수", "원문대조감수",
  "문서편집", "리라이팅",
  "자막작업", "더빙",
  "행사스태프", "행사보조", "등록데스크", "안내요원", "VIP 의전", "현장운영",
  "바이어 상담보조", "전시회 운영지원", "해외 바이어 응대", "행사 MC", "행사 사회자", "기타 행사운영",
];
const RESUME_EDUCATION_LIST = [
  "한국외국어대학교 통번역대학원",
  "이화여자대학교 통역번역대학원",
  "서울외국어대학원대학교 통번역대학원",
  "중앙대학교 국제대학원",
  "부산외국어대학교 통번역대학원",
  "제주대학교 통번역대학원",
  "선문대학교 통번역대학원",
  "계명대학교 통번역대학원",
  "Macquarie University - Translation & Interpreting",
  "Middlebury Institute of International Studies at Monterey",
  "University of Bath",
  "University of Westminster",
  "University of Leeds",
  "Université Paris Cité ESIT",
  "University of Geneva FTI",
  "University of Ottawa",
];
const RESUME_MAJOR_LIST = [
  "한영과", "한중과", "한일과", "한불과", "한독과", "한서과", "한노과", "한아과",
  "한영통번역", "한중통번역", "한일통번역",
  "통번역학", "전문통번역학",
  "국제회의통역", "국제회의전공", "통역전공", "번역전공", "통번역전공",
  "의료통역전공", "법률통번역전공", "영상번역전공", "AI번역전공",
];
const RESUME_SPECIALIZATION_LIST = [
  "다분야 가능",
  "의료·의학", "제약·바이오", "GMP", "ERP", "자동차",
  "반도체", "전자·전기", "기계·제조",
  "법률", "금융", "특허",
  "국방·방산", "조선·해양", "에너지·플랜트", "무역·물류", "정부·공공",
  "IT·SW", "AI·데이터",
  "화장품", "마케팅",
];

// 전문분야 alias → 표준값 맵
// 구버전 레이블("범용 대응 가능"), 영문 별칭, 축약형을 모두 "다분야 가능"으로 정규화
const SPECIALIZATION_ALIAS_MAP: Record<string, string> = {
  "범용 대응 가능": "다분야 가능",
  "범용대응가능": "다분야 가능",
  "generalist": "다분야 가능",
  "multi-domain": "다분야 가능",
  "multidomain": "다분야 가능",
  "general": "다분야 가능",
};

/**
 * 쉼표 구분 전문분야 문자열에서 alias를 표준값으로 치환한다.
 * 저장 직전 모든 경로에서 호출한다.
 */
function normalizeSpecializationsString(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(/[,，;]/).map(p => p.trim()).filter(Boolean);
  const normalized = parts.map(p => SPECIALIZATION_ALIAS_MAP[p] ?? SPECIALIZATION_ALIAS_MAP[p.toLowerCase()] ?? p);
  return normalized.join(", ");
}

// AI 분석 결과 이름 정규화 — 한글 전용 이름에서 내부 공백 제거
// "양 지 연" → "양지연", "Hong Gil Dong" → 유지, 혼합("홍 Gil") → 유지
function normalizeExtractedName(raw: string | null): string | null {
  if (!raw) {
    console.log("[NAME-NORMALIZE] input=null → output=null");
    return null;
  }
  const trimmed = raw.trim();
  // 공백 제거 후 전체가 한글(가-힣)로만 구성된 경우에만 공백 제거
  if (/^[가-힣\s]+$/.test(trimmed) && /\s/.test(trimmed)) {
    const result = trimmed.replace(/\s+/g, "");
    console.log(`[NAME-NORMALIZE] koreanOnly=true input="${raw}" trimmed="${trimmed}" output="${result}"`);
    return result;
  }
  console.log(`[NAME-NORMALIZE] koreanOnly=false input="${raw}" trimmed="${trimmed}" output="${trimmed}"`);
  return trimmed;
}

// 서버사이드 후처리 정규화 — AI가 지시를 따르지 않은 경우의 안전망
function normalizeExtractedMajor(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  // 강사/교수 직함으로 끝나는 경우 전공이 아닌 직책 → null 반환 (예: "한영과 강사")
  if (/\s*(강사|교수|교원|lecturer|professor|instructor)\s*$/i.test(t)) return null;
  const MAJOR_EN_MAP: Record<string, string> = {
    "translation and interpretation": "통번역전공",
    "conference interpretation": "국제회의통역",
    "simultaneous interpretation": "통역전공",
    "interpretation": "통역전공",
    "translation": "번역전공",
    "t&i": "통번역전공",
    "interpretation and translation": "통번역전공",
  };
  const mapped = MAJOR_EN_MAP[t.toLowerCase()];
  if (mapped) return mapped;
  // 리스트에 있으면 그대로 반환 (한영통번역, 전문통번역학 등 포함)
  if (RESUME_MAJOR_LIST.includes(t)) return t;
  // 한영과 패턴: 언어쌍 prefix만 있는 경우 "과" 추가 (목록 직접 매칭 실패 시)
  const langPairMatch = t.match(/^(한영|한중|한일|한불|한독|한서|한노|한아)/);
  if (langPairMatch) {
    const candidate = langPairMatch[1] + "과";
    if (RESUME_MAJOR_LIST.includes(candidate)) return candidate;
  }
  return t;
}

function normalizeExtractedEducation(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (RESUME_EDUCATION_LIST.includes(t)) return t;
  // 부분 일치 퍼지 매칭 (학교명 포함 여부)
  const ALIASES: Record<string, string> = {
    "한국외대": "한국외국어대학교 통번역대학원",
    "통역번역대학원": "한국외국어대학교 통번역대학원",
    "중앙대": "중앙대학교 국제대학원",
    "중앙대학교 대학원": "중앙대학교 국제대학원",
    "이화여대": "이화여자대학교 통역번역대학원",
    "서울외대": "서울외국어대학원대학교 통번역대학원",
    "부산외대": "부산외국어대학교 통번역대학원",
    "계명대": "계명대학교 통번역대학원",
    "맥쿼리": "Macquarie University - Translation & Interpreting",
    "macquarie": "Macquarie University - Translation & Interpreting",
    "master of translation and interpreting": "Macquarie University - Translation & Interpreting",
    "master of conference interpreting": "Macquarie University - Translation & Interpreting",
    "middlebury": "Middlebury Institute of International Studies at Monterey",
    "monterey": "Middlebury Institute of International Studies at Monterey",
    "bath": "University of Bath",
    "westminster": "University of Westminster",
    "leeds": "University of Leeds",
    "esit": "Université Paris Cité ESIT",
    "geneva": "University of Geneva FTI",
    "ottawa": "University of Ottawa",
  };
  const tl = t.toLowerCase();
  for (const [key, val] of Object.entries(ALIASES)) {
    if (tl.includes(key.toLowerCase())) return val;
  }
  return t;
}

function normalizeExtractedSpecializations(raw: string | null): string | null {
  if (!raw) return null;
  const SPEC_EN_MAP: Record<string, string> = {
    "business": "무역·물류",
    "trade": "무역·물류",
    "logistics": "무역·물류",
    "finance": "금융",
    "financial": "금융",
    "economics": "금융",
    "banking": "금융",
    "legal": "법률",
    "law": "법률",
    "legal affairs": "법률",
    "it": "IT·SW",
    "software": "IT·SW",
    "tech": "IT·SW",
    "technology": "IT·SW",
    "medical": "의료·의학",
    "healthcare": "의료·의학",
    "health": "의료·의학",
    "pharmaceutical": "제약·바이오",
    "pharma": "제약·바이오",
    "biotech": "제약·바이오",
    "patent": "특허",
    "intellectual property": "특허",
    "defense": "국방·방산",
    "military": "국방·방산",
    "energy": "에너지·플랜트",
    "oil": "에너지·플랜트",
    "government": "정부·공공",
    "public": "정부·공공",
    "marketing": "마케팅",
    "cosmetics": "화장품",
    "beauty": "화장품",
    "automotive": "자동차",
    "automobile": "자동차",
    "semiconductor": "반도체",
    "electronics": "전자·전기",
    "machinery": "기계·제조",
    "manufacturing": "기계·제조",
    "marine": "조선·해양",
    "ai": "AI·데이터",
    "data": "AI·데이터",
    "tourism": "마케팅",
    "general": "다분야 가능",
    "generalist": "다분야 가능",
    "multi-domain": "다분야 가능",
    "multidomain": "다분야 가능",
  };
  const parts = raw.split(/[,，;]/).map(p => p.trim()).filter(Boolean);
  const result = new Set<string>();
  for (const part of parts) {
    // 한국어 alias 우선 처리 (구버전 레이블 포함)
    const aliasMatch = SPECIALIZATION_ALIAS_MAP[part] ?? SPECIALIZATION_ALIAS_MAP[part.toLowerCase()];
    if (aliasMatch) { result.add(aliasMatch); continue; }

    const pl = part.toLowerCase();
    const mapped = SPEC_EN_MAP[pl];
    if (mapped) {
      result.add(mapped);
    } else if (RESUME_SPECIALIZATION_LIST.includes(part)) {
      result.add(part);
    } else {
      // 부분 일치
      let found = false;
      for (const [key, val] of Object.entries(SPEC_EN_MAP)) {
        if (pl.includes(key)) { result.add(val); found = true; break; }
      }
      if (!found) result.add(part); // 알 수 없으면 원문 유지
    }
  }
  return result.size > 0 ? [...result].join(", ") : null;
}

function isGraduateInterpreterEducation(education: string | null): boolean {
  if (!education) return false;
  const edu = education.trim();
  if (RESUME_EDUCATION_LIST.includes(edu)) return true;
  const lower = edu.toLowerCase();
  return lower.includes("통번역대학원") || lower.includes("통역번역대학원");
}

function filterSubTypesForGraduate(profileSubTypes: string | null, education: string | null): string | null {
  if (!profileSubTypes || !isGraduateInterpreterEducation(education)) return profileSubTypes;
  const filtered = profileSubTypes.split(",").map(s => s.trim()).filter(s => s && s !== "일반번역");
  return filtered.length > 0 ? filtered.join(", ") : null;
}

function buildResumePromptMessages(resumeText: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: `당신은 통번역사 이력서를 분석하는 전문가입니다. 이력서에서 정보를 추출하여 정확한 JSON만 반환합니다.

【최우선 추출 — 이름 / 휴대폰 / 이메일 / 주소】
이력서 최상단(헤더·연락처 섹션)을 가장 먼저 탐색하세요. 다음 순서로 반드시 추출합니다:
1. name: 성명·氏名·Full Name 등 — 이력서 상단에 가장 크게 표시됨. 한글 또는 영문 이름.
2. phone: 010-, +82-10-, Mobile, Cell, Tel, 연락처 등 모든 형식의 전화번호.
3. email: @ 포함 이메일 주소.
4. address: 거주지·주소·Address·Location 등. 추출 실패 시 이력서 전체에서 재탐색.
이 4가지는 불확실해도 최대한 추출하며 null로 남기지 마세요.

【가능언어(languagePairs) — 엄격 기준 적용】
반드시 실제 통역·번역 업무 수행이 가능한 언어만 포함합니다.

✅ 포함 조건 (하나 이상 해당 시):
- 통역·번역 실무 경력에 직접 사용된 언어
- 통번역 대학원 전공 언어
- 해외 초·중·고·대학·대학원을 해당 언어권에서 수학 (강력한 실무 근거)
- 해외 거주 3년 이상이며 해당 언어 사용 환경
- 고급·전문 수준으로 명시된 언어 (native, fluent, professional, 원어민, 고급 등)
- 통번역 관련 공인 자격증 또는 공인 시험 성적(JLPT N1, HSK 5이상, DELF B2이상 등)으로 실무 가능성 확인

❌ 제외 조건 (이 경우만 언급된 언어는 languagePairs 제외, referenceLangs로 분류):
- 고등학교 제2외국어 수업만 이수
- 대학 교양 수업 또는 단기 어학 과목만 수강
- 취미·기초 회화·여행 회화 수준
- "배운 적 있음", "수강한 적 있음" 수준
- 실무 경력 또는 전문 교육과 연결되지 않은 언어

반환 형식: 한국어 이름으로 쉼표 구분 (예: "한국어, 영어")
방향성(한→영, 영→한, Korean-English)은 제거하고 언어 이름만 추출.
영어 언어명 → 한국어: English→영어, Japanese→일본어, Chinese→중국어, French→프랑스어, German→독일어, Spanish→스페인어, Russian→러시아어, Arabic→아랍어, Vietnamese→베트남어, Thai→태국어, Indonesian→인도네시아어, Portuguese→포르투갈어, Italian→이탈리아어, Dutch→네덜란드어, Swedish→스웨덴어, Polish→폴란드어, Turkish→터키어, Hindi→힌디어

【참고언어(referenceLangs) — 학습 이력만 있는 언어】
languagePairs에서 제외된 언어 중 이력서에 언급된 언어.
예: 고등학교 프랑스어 수강, 대학 일본어 교양, 기초 중국어 수강, 단기 어학원 수강
반환 형식: 한국어 이름으로 쉼표 구분 (없으면 null)

【언어·국제경험(languageExperiences) — JSON 배열】
이력서에 언급된 모든 언어에 대해 배열 요소를 생성합니다. languagePairs + referenceLangs 언어 모두 포함.

해외 수학·거주 탐지 키워드 (적극 탐색):
- 해외 초등학교·중학교·고등학교·국제학교 이수 → abroadElementary/abroadMiddle/abroadHigh/internationalSchool = true
- 해외 대학교·대학원 졸업 → abroadUniversity/abroadGraduate = true
- 교환학생 → exchangeStudent = true
- 어학연수 → languageStudyAbroad = true
- 해외 거주 기간 언급 → residenceCountry, residenceCity, residencePeriod 추출

canWork 결정:
- languagePairs에 포함된 언어 → canWork: true
- referenceLangs에만 있는 언어 → canWork: false
- 해외 초·중·고·대학 졸업 언어이지만 실무 경력 없을 때도 canWork: true (강력한 실무 근거)

level 결정:
- 해외 초·중·고·대학 모두 해당 언어권 수학 + 거주 5년 이상 → "원어민"
- 해외 대학·대학원 졸업 또는 거주 3년 이상 → "고급"
- 어학연수·교환학생 경험 → "중급"
- 교양수업·단기강좌만 → "초급"

acquisitionBg 결정:
- 해외 거주·유학 경험 → "해외거주" 또는 "해외유학"
- 이중언어 가정환경 언급 → "이중언어(가정환경)"
- 국내 대학 전공 → "국내교육"
- 독학·자기학습 → "자기학습"

배열 구조 (각 언어별 하나의 요소):
{"language":"한국어언어명","canWork":boolean,"level":"원어민"|"고급"|"중급"|"초급"|"","acquisitionBg":"해외거주"|"해외유학"|"국내교육"|"자기학습"|"이중언어(가정환경)"|"기타"|"","residenceCountry":"","residenceCity":"","residencePeriod":"","abroadElementary":false,"abroadMiddle":false,"abroadHigh":false,"abroadUniversity":false,"abroadGraduate":false,"internationalSchool":false,"exchangeStudent":false,"languageStudyAbroad":false,"notes":""}

【학력(education)】
다음 목록 중 가장 가까운 학교명으로 반환하세요:
${RESUME_EDUCATION_LIST.join(", ")}
유사한 경우 목록에서 선택. 없으면 원문 그대로.

【전공(major)】
다음 목록 중 하나로 반환:
${RESUME_MAJOR_LIST.join(", ")}
주의: 학위(석사/학사 등)의 전공명을 추출하세요. 경력·직책(강사, 교수, 교원 등)은 전공이 아닙니다. 예) "전문통번역학 석사 / 한영과 강사" → "전문통번역학" (강사 직책은 무시).
영문 전공명 변환: "Translation and Interpretation"→"통번역전공", "Conference Interpretation"→"국제회의통역", "Interpretation"→"통역전공", "Translation"→"번역전공", "T&I"→"통번역전공"

【전문분야(specializations)】
반드시 다음 목록에서만 선택(쉼표 구분):
${RESUME_SPECIALIZATION_LIST.join(", ")}
영문 매핑: Business/Trade→"무역·물류", Finance/Economics→"금융", Legal/Law→"법률", IT/Software/Tech→"IT·SW", Medical/Healthcare→"의료·의학", Pharmaceutical/Medicine Device→"제약·바이오", Patent/IP→"특허", Defense/Military→"국방·방산", Energy/Oil→"에너지·플랜트", Government/Public→"정부·공공", Marketing/Advertisement→"마케팅", Cosmetics/Beauty→"화장품", Automotive/Car→"자동차", Semiconductor→"반도체", Electronics→"전자·전기", AI/Data/ML→"AI·데이터", General/Generalist/Multi-domain→"다분야 가능"
주의: 특정 산업 전문분야가 명확하지 않거나 다양한 산업군 수행 경험이 있으면 "다분야 가능"을 사용. "전문분야 없음"과는 다른 개념임.

【업무유형(profileWorkTypes)】
반드시 다음에서만 선택(쉼표 구분): ${RESUME_WORK_TYPES.join(", ")}
행사운영 키워드: 행사 스태프, 행사 운영, 행사 진행, 운영요원, 등록데스크, 안내데스크, VIP 의전, 수행비서, 행사 진행요원, 전시회 운영, 박람회 운영, 컨퍼런스 운영, 행사 코디네이터 → "행사운영" 추가

【세부유형(profileSubTypes)】
반드시 다음에서만 선택(쉼표 구분): ${RESUME_SUB_TYPES.join(", ")}
영문 매핑: "Simultaneous Interpretation"→"동시통역", "Consecutive Interpretation"→"순차통역", "Escort Interpretation"→"수행통역", "Whispering"→"위스퍼링통역", "Conference Interpretation"→"동시통역", "Phone Interpretation"→"전화통역", "Video Interpretation"→"화상통역"
행사운영 세부유형 매핑: 등록데스크·안내데스크→"등록데스크", VIP 의전·수행비서→"VIP 의전", 행사 스태프·진행요원→"행사스태프", 전시회·박람회 운영→"전시회 운영지원", 해외 바이어 응대→"해외 바이어 응대", 행사 MC·사회자→"행사 MC"
⚠️ 통번역대학원 출신 규칙: education 필드가 통번역대학원/통역번역대학원에 해당하면 "일반번역"을 세부유형에 포함하지 마세요. 대신 "전문번역"을 사용하세요.

【지역(region)】
⚠️ 엄격한 규칙: 이력서에 현재 거주지를 명시한 경우에만 입력합니다. 반드시 아래 키워드가 명시적으로 존재해야만 추출:
  - 한국어: 주소, 현주소, 거주지, 현재 거주, 현재 주소, 거주 국가, 거주지역
  - 영어: Address, Residence, Current Location, Lives in, Residing in

⛔ 다음은 절대 region으로 추출하지 마세요 (null 반환):
  - 학교 소재지 (예: 한국외대→서울, 이화여대→서울, Macquarie University→시드니)
  - 회사/기관 소재지 (예: "도쿄 소재 무역회사 근무" → null)
  - 프로젝트/행사/출장 장소 (예: "뉴욕 컨퍼런스 통역", "파리 출장" → null)
  - 해외 유학/체류 기간 (예: "호주에서 3년 유학" → null, languageExperiences에만 기록)
  - 출신 지역/고향 (예: "부산 출신" → null)
  - 과거 거주 이력 (현재 거주지임이 명확하지 않으면 null)

반환 형식: "국가 / 도시" (예: "대한민국 / 서울", "미국 / 뉴욕"). 도시 불명이면 국가만. 명시된 거주지 없으면 null.
영문 국가명 → 한국어: South Korea→대한민국, USA/United States→미국, Japan→일본, China→중국, UK→영국, Australia→호주, Canada→캐나다, France→프랑스, Germany→독일.
영문 도시명 → 한국어: Seoul→서울, Busan→부산, Incheon→인천, Tokyo→도쿄, New York→뉴욕, Los Angeles→로스앤젤레스, Sydney→시드니, London→런던, Paris→파리, Singapore→싱가포르.

【상세정보(bio) — 핵심 경쟁력 요약】
원문을 그대로 복사하지 말고 이력서 내용을 바탕으로 2~4줄 한국어 요약을 생성합니다.

⚠️ 금지 사항:
- 언어명(한국어, 영어, 일본어, 중국어, 프랑스어 등)을 문장 앞이나 중간에 반복하지 마세요
  (언어 정보는 별도 컬럼에 표시되므로 bio에서 제외)
- 업무유형(번역, 통역, 동시통역 등) 나열만으로 채우지 마세요
  (업무유형은 별도 컬럼에 표시됨)
- "한국어·영어 전문 통번역사", "영어 번역가" 같은 표현 금지

✅ 포함할 내용 (우선순위 순):
- 총 경력 연수 (예: "20년 경력", "15년 이상 번역 경력")
- 핵심 산업 또는 전문분야 (예: "의료·제약 GMP", "법률·금융·IT")
- 대표 프로젝트 또는 주요 실적
- 국제기구·대형 클라이언트 경험
- 통번역대학원 출신 여부 (해당 시)
- 자격증 또는 공인 시험 성적 (해당 시)

예시:
"전문 통번역사 (경력 20년 이상). 의료·법률 분야 동시통역 다수 수행."
"15년 이상 번역 경력. ERP·제조·IT 프로젝트 전문."
"의료·제약 GMP 프로젝트 전문. 국제회의 통역 다수. 한국외대 통번역대학원 졸업."

각 줄은 \\n으로 구분, 전체 100자 내외로 간결하게

【졸업상태(graduationStatus)】
다음 중 하나: 졸업, 졸업예정, 재학중, 수료, 중퇴

【언어레벨(languageLevel)】
주요 업무 언어의 레벨. 다음 중 하나: 원어민, 고급, 중급, 초급

【주민번호 및 개인 식별 번호는 절대 추출하지 마세요.】
확실하지 않은 항목은 null로 표시하고 confidence를 낮추세요.`,
    },
    {
      role: "user",
      content: `다음 이력서에서 정보를 추출해주세요:\n\n${resumeText.slice(0, 12000)}\n\n아래 JSON 스키마로만 응답하세요 (모든 필드 포함):\n{"name":string|null,"phone":string|null,"email":string|null,"address":string|null,"languagePairs":string|null,"referenceLangs":string|null,"languageLevel":"원어민"|"고급"|"중급"|"초급"|null,"education":string|null,"major":string|null,"graduationYear":number|null,"graduationStatus":"졸업"|"졸업예정"|"재학중"|"수료"|"중퇴"|null,"specializations":string|null,"profileWorkTypes":string|null,"profileSubTypes":string|null,"region":string|null,"careerYears":string|null,"certifications":string|null,"bio":string|null,"languageExperiences":array,"confidence":"high"|"medium"|"low","notes":string|null}`,
    },
  ];
}

function normalizePhoneNumber(phone: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  if (d.length === 11 && /^01[016789]/.test(d)) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  if (d.startsWith("02") && d.length === 9) return `${d.slice(0,2)}-${d.slice(2,5)}-${d.slice(5)}`;
  if (d.startsWith("02") && d.length === 10) return `${d.slice(0,2)}-${d.slice(2,6)}-${d.slice(6)}`;
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  return phone;
}

// 언어명 목록 (bio 후처리에서 제거 대상)
const LANG_NAMES_KO = [
  "한국어", "영어", "일본어", "중국어", "프랑스어", "독일어", "스페인어",
  "러시아어", "아랍어", "베트남어", "태국어", "인도네시아어", "포르투갈어",
  "이탈리아어", "네덜란드어", "스웨덴어", "폴란드어", "터키어", "힌디어",
  "말레이어", "몽골어", "페르시아어", "우크라이나어", "체코어", "헝가리어",
  "루마니아어", "그리스어", "핀란드어", "덴마크어", "노르웨이어",
];

/**
 * AI가 생성한 bio에서 언어명 반복 패턴을 제거한다.
 * - "영어·한국어 전문 통번역사" → "전문 통번역사"
 * - "한국어, 영어, 일본어 번역가" → "번역가"
 * - 문장 앞 언어명 나열(·/,/및 구분) 제거
 */
function stripLangNamesFromBio(bio: string | null): string | null {
  if (!bio) return null;

  // 언어명 OR 패턴
  const langOr = LANG_NAMES_KO.join("|");
  // 패턴 1: 문장 앞 "언어A·언어B·..." 또는 "언어A, 언어B" 나열 (뒤에 공백/조사/전문 등)
  const leadingLangPattern = new RegExp(
    `^(?:(?:${langOr})(?:[·,、\\s/·&]+(?:${langOr}))*)[\\s]*`,
    "u",
  );
  // 패턴 2: 줄 앞 동일 패턴 (멀티라인)
  const lineLeadingPattern = new RegExp(
    `(?:^|\\n)(?:(?:${langOr})(?:[·,、\\s/·&]+(?:${langOr}))*)[\\s]*`,
    "gu",
  );

  let cleaned = bio;

  // 각 줄에서 앞머리 언어명 제거
  cleaned = cleaned
    .split("\n")
    .map(line => line.replace(leadingLangPattern, "").trim())
    .filter(line => line.length > 0)
    .join("\n");

  // 남은 "언어A·언어B" 연속 패턴 (·로만 연결된 것) 을 제거
  const midPattern = new RegExp(
    `(?:${langOr})(?:·(?:${langOr}))+`,
    "gu",
  );
  cleaned = cleaned.replace(midPattern, "").replace(/\s{2,}/g, " ").trim();

  return cleaned || null;
}

function buildResumeDto(result: Record<string, unknown>) {
  const normalizedEducation = normalizeExtractedEducation((result.education as string) ?? null);
  const aiRawName = (result.name as string) ?? null;
  const normalizedName = normalizeExtractedName(aiRawName);
  console.log(`[NAME-TRACE][2] buildResumeDto aiRaw="${aiRawName}" afterNormalize="${normalizedName}"`);
  return {
    name: normalizedName,
    phone: normalizePhoneNumber((result.phone as string) ?? null),
    email: (result.email as string) ?? null,
    address: (result.address as string) ?? null,
    languagePairs: (result.languagePairs as string) ?? null,
    referenceLangs: (result.referenceLangs as string) ?? null,
    languageLevel: (result.languageLevel as string) ?? null,
    education: normalizedEducation,
    major: normalizeExtractedMajor((result.major as string) ?? null),
    graduationYear: typeof result.graduationYear === "number" ? result.graduationYear : null,
    graduationStatus: (result.graduationStatus as string) ?? null,
    specializations: normalizeExtractedSpecializations((result.specializations as string) ?? null),
    profileWorkTypes: (result.profileWorkTypes as string) ?? null,
    profileSubTypes: filterSubTypesForGraduate((result.profileSubTypes as string) ?? null, normalizedEducation),
    region: (result.region as string) ?? null,
    careerYears: (result.careerYears as string) ?? null,
    certifications: (result.certifications as string) ?? null,
    bio: stripLangNamesFromBio((result.bio as string) ?? null),
    languageExperiences: (() => {
      const raw = result.languageExperiences;
      if (!raw) return null;
      try {
        const arr = Array.isArray(raw) ? raw : JSON.parse(raw as string);
        return Array.isArray(arr) && arr.length > 0 ? JSON.stringify(arr) : null;
      } catch { return null; }
    })(),
    confidence: (result.confidence as "high" | "medium" | "low") ?? "low",
    notes: (result.notes as string) ?? null,
  };
}

// ─── 이력서 AI 분석 — 파일 직접 업로드 (userId 없이, 등록 단계용) ────────────
router.post(
  "/admin/translators/resume-analyze-upload",
  // [ROUTE-REAL] 이 코드가 실제로 실행되고 있음을 증명하는 마커 (VERITAS-BUILD-VER=6)
  (req, _res, next) => {
    console.log(`[ROUTE-REAL] VER=6 method=${req.method} ct="${(req.headers["content-type"] ?? "").slice(0, 80)}" ts=${Date.now()}`);
    next();
  },
  // [D1] 라우트 매칭 확인 — adminGuard 이전
  (req, _res, next) => {
    console.log(`[D1-ROUTE-MATCHED] method=${req.method} ct="${(req.headers["content-type"] ?? "").slice(0, 80)}" auth=${req.headers.authorization ? "present" : "MISSING"}`);
    next();
  },
  ...adminGuard,
  // [D2] adminGuard 통과 확인 — multer 이전
  (req, _res, next) => {
    console.log(`[D2-AFTER-GUARD] user=${JSON.stringify(req.user ?? null)}`);
    next();
  },
  // [D3] multer를 래핑해 에러·성공 모두 로그
  (req, res, next) => {
    resumeUpload.single("file")(req, res, (err) => {
      if (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const me = err as any;
        console.log(`[D3-MULTER-ERROR] code=${me.code ?? "N/A"} message="${me.message}" field="${me.field ?? "N/A"}"`);
        return next(err);
      }
      const f = req.file;
      console.log(`[D3-MULTER-OK] file=${f ? `"${f.originalname}" mime="${f.mimetype}" size=${f.size}` : "NOT_ATTACHED (no file field in request)"}`);
      next();
    });
  },
  async (req, res) => {
    console.log("[REAL-HANDLER] entered");
    console.log("[ENTER] resume-analyze-upload");
    const file = req.file;
    if (!file) {
      console.log("[422] resume-analyze-upload: file is null/undefined (multer did not attach file)");
      res.status(400).json({ error: "파일이 없습니다." }); return;
    }

    // multer은 latin1로 파싱하므로 UTF-8 재디코딩 (ext 검출은 ASCII이므로 영향 없음)
    const originalNameUtf8 = Buffer.from(file.originalname, "latin1").toString("utf8");
    const ext = path.extname(originalNameUtf8).toLowerCase();
    const mime = file.mimetype;
    const buffer = file.buffer;
    console.log(`[TRACE] resume-analyze-upload: originalName="${originalNameUtf8}" ext="${ext}" mime="${mime}" bytes=${buffer.byteLength}`);
    req.log.info(
      { ext, mime, bytes: buffer.byteLength, originalName: originalNameUtf8 },
      "[ANALYZE-UPLOAD] file received"
    );

    let resumeText = "";
    let extractStep = "not_started";
    try {
      if (ext === ".pdf") {
        console.log("[TRACE] resume-analyze-upload: branch=PDF");
        extractStep = "pdf_parser_start";
        resumeText = await extractPdfText(buffer);
        extractStep = "pdf_parser_done";
        req.log.info(
          { bytes: buffer.byteLength, textLen: resumeText.length, textPreview: resumeText.slice(0, 80).replace(/\n/g, " ") },
          "[ANALYZE-UPLOAD] PDF text extracted"
        );
      } else if (ext === ".docx" || ext === ".doc") {
        console.log(`[TRACE] resume-analyze-upload: branch=DOC ext="${ext}"`);
        extractStep = ext === ".docx" ? "docx_parser_start" : "doc_parser_start";
        const docFmt = detectDocFormat(buffer);
        console.log(`[TRACE] resume-analyze-upload: docFmt=${docFmt} — calling extractDocText`);
        console.log("[REAL-DOC]");
        const { text: docText, method: docMethod } = await extractDocText(buffer, "analyze-upload");
        resumeText = docText;
        extractStep = ext === ".docx" ? "docx_parser_done" : "doc_parser_done";
        req.log.info({ ext, docFmt, docMethod, textLen: resumeText.length }, "[ANALYZE-UPLOAD] DOC/DOCX text extracted");
      } else if (ext === ".txt") {
        console.log("[TRACE] resume-analyze-upload: branch=TXT");
        extractStep = "txt_parser_start";
        resumeText = buffer.toString("utf-8");
        extractStep = "txt_parser_done";
        req.log.info({ textLen: resumeText.length }, "[ANALYZE-UPLOAD] TXT text extracted");
      } else if (ext === ".hwp" || ext === ".hwpx") {
        console.log(`[TRACE] resume-analyze-upload: branch=HWP ext="${ext}"`);
        extractStep = "hwp_parser_start";
        resumeText = await extractHwpText(buffer);
        extractStep = "hwp_parser_done";
        req.log.info({ ext, textLen: resumeText.length, textPreview: resumeText.slice(0, 80).replace(/\n/g, " ") }, "[ANALYZE-UPLOAD] HWP text extracted");
      } else {
        console.log(`[422] resume-analyze-upload: unsupported extension="${ext}" mime="${mime}"`);
        req.log.warn({ ext, mime, originalName: originalNameUtf8 }, "[ANALYZE-UPLOAD] unsupported extension");
        res.status(422).json({ error: `지원하지 않는 파일 형식 (${ext}). PDF, HWP, HWPX, DOCX, DOC, TXT를 사용해 주세요.` }); return;
      }
    } catch (extractErr) {
      console.log("[EXTRACT-ERROR] raw error object:"); console.log(extractErr); console.log("[EXTRACT-ERROR] message:", extractErr instanceof Error ? extractErr.message : String(extractErr)); console.log("[EXTRACT-ERROR] stack:", extractErr instanceof Error ? extractErr.stack : "(no stack)");
      const errMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
      const errName = extractErr instanceof Error ? extractErr.constructor.name : typeof extractErr;
      console.log(`[422] resume-analyze-upload: extraction threw — extractStep="${extractStep}" errName="${errName}" errMsg="${errMsg}"`);
      console.log("[REAL-422]", {
        extractStep,
        testMarker: "REAL_422_FOUND",
        resumeTextLen: resumeText.length,
        errName,
        errMsg,
      });
      req.log.error(
        { extractStep, ext, mime, bytes: buffer.byteLength, errName, errMsg, errStack: extractErr instanceof Error ? extractErr.stack : undefined },
        "[ANALYZE-UPLOAD] text extraction failed"
      );
      res.status(422).json({
        error: errMsg,
        _debug: { testMarker: "REAL_422_FOUND", extractStep, ext, mime, bytes: buffer.byteLength, errName, errMsg, errStack: extractErr instanceof Error ? extractErr.stack : undefined },
      }); return;
    }

    if (!resumeText.trim()) {
      console.log(`[422] resume-analyze-upload: empty text after extraction — ext="${ext}" extractStep="${extractStep}"`);
      req.log.warn({ ext, bytes: buffer.byteLength }, "[ANALYZE-UPLOAD] empty text after extraction");
      res.status(422).json({
        error: "이력서에서 텍스트를 추출할 수 없습니다. 이미지 기반 PDF이거나 빈 파일일 수 있습니다.",
        _debug: { extractStep, ext, mime, bytes: buffer.byteLength, resumeTextLen: resumeText.length },
      }); return;
    }
    req.log.info({ textLen: resumeText.trim().length }, "[ANALYZE-UPLOAD] text OK → calling OpenAI");

    try {
      const openaiClient = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });
      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: buildResumePromptMessages(resumeText),
      });

      const raw = completion.choices[0].message.content ?? "{}";
      let result: Record<string, unknown> = {};
      let jsonParseFailed = false;
      try { result = JSON.parse(raw); } catch { result = {}; jsonParseFailed = true; }
      delete result.residentNumber; delete result.ssn; delete result.jumin;

      // ① AI 원본 name (정규화 전)
      console.log(`[NAME-TRACE][1] analyze-upload ext="${ext}" AI_RAW_NAME="${result.name ?? "null"}"`);

      const uploadDto = buildResumeDto(result);
      req.log.info({
        bioOriginal: (result.bio as string) ?? null,
        bioStripped: uploadDto.bio,
      }, "[bio] AI Original → After strip (analyze-upload, preview only — not saved to DB yet)");
      res.json({
        ...uploadDto,
        _debug: {
          sourceType: "file_upload",
          fileName: file.originalname,
          extractedTextLength: resumeText.length,
          extractedTextPreview: resumeText.slice(0, 120).replace(/\n/g, " "),
          aiCalled: true,
          currentValuesUsed: false,
          jsonParseFailed,
        },
      });
    } catch (err) {
      req.log.error({ err }, "[ANALYZE-UPLOAD] OpenAI call failed");
      res.status(500).json({ error: "AI 분석 실패: OpenAI 호출 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
    }
  }
);

// ─── 이력서 AI 분석 (Preview 전용 — DB 저장 없음) ────────────────────────────
router.post("/admin/translators/:id/resume-analyze", ...adminGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    res.status(400).json({ error: "유효하지 않은 user id." }); return;
  }

  // ── STEP 로그 헬퍼 ──
  const STEP = (n: number, msg: string, extra?: Record<string, unknown>) =>
    req.log.info({ step: n, userId, ...extra }, `[ANALYZE-STEP-${n}] ${msg}`);
  const FAIL = (n: number, msg: string, err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    req.log.error({
      step: n, userId,
      errType: e.constructor?.name ?? typeof err,
      errMsg: e.message,
      errStack: e.stack,
      errCause: (e as NodeJS.ErrnoException).cause,
      errCode: (e as NodeJS.ErrnoException).code,
      errFull: JSON.stringify(err, Object.getOwnPropertyNames(err instanceof Error ? err : {})),
    }, `[ANALYZE-FAIL-${n}] ${msg}`);
  };

  STEP(0, "route entered");

  try {
    // ── STEP 1: DB에서 이력서 경로 조회 ──
    STEP(1, "querying resume_url from DB");
    const [profile] = await db
      .select({ resumeUrl: translatorProfilesTable.resumeUrl })
      .from(translatorProfilesTable)
      .where(eq(translatorProfilesTable.userId, userId));

    STEP(2, "DB query complete", { hasProfile: !!profile, resumeUrl: profile?.resumeUrl ?? null });
    if (!profile?.resumeUrl) {
      res.status(400).json({ error: "등록된 이력서가 없습니다." }); return;
    }

    // ── STEP 3: GCS signed URL 발급 ──
    STEP(3, "generating signed URL", { resumeUrl: profile.resumeUrl });
    const signedUrl = await getResumeDownloadUrl(profile.resumeUrl);
    STEP(4, "signed URL obtained", { signedUrlPrefix: signedUrl.slice(0, 60) });

    // ── STEP 5: 파일 다운로드 ──
    STEP(5, "downloading file from GCS");
    const fileRes = await fetch(signedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) {
      FAIL(5, `GCS download failed HTTP ${fileRes.status}`, new Error(`HTTP ${fileRes.status} ${fileRes.statusText}`));
      throw new Error(`파일 다운로드 실패: ${fileRes.status}`);
    }
    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const ext = path.extname(profile.resumeUrl).toLowerCase();
    STEP(6, "file downloaded", { ext, bufferBytes: buffer.byteLength });

    // ── STEP 7: 텍스트 추출 ──
    STEP(7, "extracting text", { ext });
    let resumeText = "";
    if (ext === ".pdf") {
      resumeText = await extractPdfText(buffer);
      STEP(8, "PDF text extracted", { textLen: resumeText.length, preview: resumeText.slice(0, 100) });
    } else if (ext === ".docx" || ext === ".doc") {
      const docFmt = detectDocFormat(buffer);
      STEP(8, "DOC/DOCX: magic byte detection", { ext, docFmt });
      try {
        const { text: docText, method: docMethod } = await extractDocText(buffer, "analyze");
        resumeText = docText;
        STEP(8, "DOC/DOCX text extracted", { ext, docFmt, docMethod, textLen: resumeText.length, preview: resumeText.slice(0, 100) });
      } catch (docErr) {
        FAIL(8, "DOC/DOCX extraction failed", docErr);
        const errMsg = docErr instanceof Error ? docErr.message : String(docErr);
        const errStack = docErr instanceof Error ? docErr.stack : undefined;
        console.log(`[422][L2072] resume-analyze: DOC/DOCX extraction threw — ext="${ext}" errMsg="${errMsg}"`);
        console.log("[EXTRACT-ERROR] message:", errMsg); console.log("[EXTRACT-ERROR] stack:", errStack);
        res.status(422).json({ error: errMsg, _debug: { ext, errMsg, errStack } }); return;
      }
    } else if (ext === ".txt") {
      resumeText = buffer.toString("utf-8");
      STEP(8, "TXT text extracted", { textLen: resumeText.length, preview: resumeText.slice(0, 100) });
    } else if (ext === ".hwp" || ext === ".hwpx") {
      resumeText = await extractHwpText(buffer);
      STEP(8, "HWP text extracted", { ext, textLen: resumeText.length, preview: resumeText.slice(0, 100) });
    } else {
      console.log(`[422][L2081] resume-analyze: unsupported ext="${ext}" userId=${userId}`);
      res.status(422).json({ error: `지원하지 않는 파일 형식입니다 (${ext}). PDF, HWP, HWPX, DOCX, TXT를 사용해 주세요.` }); return;
    }

    if (!resumeText.trim()) {
      console.log(`[422][L2086] resume-analyze: empty text after extraction — ext="${ext}" userId=${userId} textLen=${resumeText.length}`);
      req.log.warn({ userId, ext }, "[ANALYZE] empty text after extraction");
      res.status(422).json({ error: "이력서에서 텍스트를 추출할 수 없습니다. 이미지 기반 PDF이거나 빈 파일일 수 있습니다." }); return;
    }

    // ── STEP 9: OpenAI 설정 확인 ──
    const openaiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const openaiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    STEP(9, "OpenAI env check", {
      hasApiKey: !!openaiApiKey,
      apiKeyMask: openaiApiKey ? openaiApiKey.slice(0, 8) + "***" : null,
      baseUrl: openaiBaseUrl ?? "(none — will use api.openai.com)",
      textLenToSend: Math.min(resumeText.length, 10000),
    });

    const openaiClient = new OpenAI({
      apiKey: openaiApiKey,
      baseURL: openaiBaseUrl,
    });
    // ── STEP 10: OpenAI 호출 ──
    STEP(10, "calling OpenAI chat.completions.create");
    let completion: Awaited<ReturnType<typeof openaiClient.chat.completions.create>>;
    try {
      completion = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: buildResumePromptMessages(resumeText),
      });
    } catch (openaiErr) {
      FAIL(10, "OpenAI API call failed", openaiErr);
      throw openaiErr;
    }

    // ── STEP 11: OpenAI 응답 파싱 ──
    STEP(11, "OpenAI response received", {
      model: completion.model,
      finishReason: completion.choices[0]?.finish_reason,
      rawContentLen: completion.choices[0]?.message?.content?.length ?? 0,
      rawContentPreview: completion.choices[0]?.message?.content?.slice(0, 200) ?? null,
      usage: completion.usage,
    });

    const raw = completion.choices[0].message.content ?? "{}";
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(raw);
      STEP(12, "JSON.parse succeeded", { keys: Object.keys(result), confidence: result.confidence });
    } catch (parseErr) {
      FAIL(12, "JSON.parse failed", parseErr);
      req.log.error({ rawContent: raw }, "[ANALYZE] raw content that failed JSON.parse");
      result = {};
    }

    // ── STEP 13: 민감 필드 제거 및 최종 DTO ──
    delete result.residentNumber;
    delete result.ssn;
    delete result.jumin;

    // ① AI 원본 name (정규화 전)
    console.log(`[NAME-TRACE][1] resume-analyze userId=${userId} ext="${ext}" AI_RAW_NAME="${result.name ?? "null"}"`);

    let jsonParseFailed = false;
    // result was already parsed above; check if it was an empty fallback
    if (!result.name && !result.languagePairs && !result.education) jsonParseFailed = Object.keys(result).length === 0;

    const dto = {
      ...buildResumeDto(result),
      _debug: {
        sourceType: "stored_file" as const,
        fileName: path.basename(profile.resumeUrl),
        extractedTextLength: resumeText.length,
        extractedTextPreview: resumeText.slice(0, 120).replace(/\n/g, " "),
        aiCalled: true,
        currentValuesUsed: false,
        jsonParseFailed,
      },
    };

    STEP(13, "DTO built — about to send 200", {
      dtoKeys: Object.keys(dto),
      confidence: dto.confidence,
      hasName: !!dto.name,
      hasLanguagePairs: !!dto.languagePairs,
      extractedTextLength: resumeText.length,
      bioOriginal: (result.bio as string) ?? null,
      bioStripped: dto.bio,
    });

    res.json(dto);
    STEP(14, "res.json() called — response sent");

  } catch (err) {
    FAIL(99, "unhandled exception in resume-analyze", err);
    if (!res.headersSent) {
      const msg = err instanceof Error ? err.message : String(err);
      const category =
        msg.includes("파일 다운로드") ? "파일을 찾을 수 없음: GCS 다운로드 실패" :
        msg.includes("추출") ? "텍스트 추출 실패" :
        msg.includes("OpenAI") || msg.includes("openai") ? "AI 분석 실패: OpenAI 호출 오류" :
        "이력서 분석 실패 (서버 오류)";
      res.status(500).json({ error: category, detail: msg });
    }
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
      specializations: normalizeSpecializationsString(specializations ?? null),
      education: education ?? null,
      major: major ?? null,
      graduationYear: graduationYear ?? null,
      region: region ?? null,
      availabilityStatus: availabilityStatus ?? "available",
      bio: stripLangNamesFromBio(bio ?? null),
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
    await db.update(translatorProfilesTable)
      .set({ availabilityStatus: "available", updatedAt: new Date() })
      .where(eq(translatorProfilesTable.userId, userId));

    await db.insert(logsTable).values({
      entityType: "translator",
      entityId: userId,
      action: "activated",
      performedBy: req.user?.id ?? null,
      performedByEmail: req.user?.email ?? null,
      metadata: JSON.stringify({ name: existing.name, email: existing.email }),
    });

    res.json({ success: true, availabilityStatus: "available" });
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
    await db.update(translatorProfilesTable)
      .set({ availabilityStatus: "unavailable", updatedAt: new Date() })
      .where(eq(translatorProfilesTable.userId, userId));

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
