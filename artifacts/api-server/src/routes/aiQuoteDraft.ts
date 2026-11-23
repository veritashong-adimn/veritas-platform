/**
 * POST /api/quotes/ai-draft
 *
 * AI 견적 초안 생성 파이프라인:
 *   1. 파일 업로드 (multer)
 *   2. 텍스트 추출 (mammoth / pdf-parse / word-extractor / xlsx / unzipper / GPT-4o OCR)
 *   3. 글자수 / 단어수 / 언어 감지
 *   4. GPT-4o 상품 추천 + 견적 초안 생성
 *   5. 서버 사이드 페이지 계산
 *   6. Preview 반환 (DB 저장 없음)
 */
import express, { Router, type IRouter } from "express";
import { db, productsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import multer from "multer";
import path from "node:path";
import { requireAuth, requireRole } from "../middlewares/auth";
import { extractText, type TextStats } from "../lib/textExtractor";
import { randomUUID } from "node:crypto";
import {
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  HeadObjectCommand, GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getR2Client, bucketName, isR2Configured, deleteFromR2 } from "../lib/r2";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 언어별 페이지 계산 정책 ─────────────────────────────────────────────────

const CHAR_BASED_LANGS = ["ko", "ja", "zh-hans", "zh-hant", "th", "mn"];

function calcPages(st: { wordCount: number; charCountNoSpace: number; detectedLanguage: string }, sourceLang: string): number {
  const lang = (sourceLang || st.detectedLanguage || "en").toLowerCase();
  if (CHAR_BASED_LANGS.includes(lang)) {
    return Math.max(1, Math.ceil(st.charCountNoSpace / 700));
  }
  return Math.max(1, Math.ceil(st.wordCount / 250));
}

// ─── multer ─────────────────────────────────────────────────────────────────

const REQUEST_EXTS = [".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".txt", ".ppt", ".pptx"];
const SOURCE_EXTS  = [...REQUEST_EXTS, ".xls", ".xlsx", ".hwp", ".hwpx"];

const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === "requestFiles") { cb(null, REQUEST_EXTS.includes(ext)); return; }
    if (file.fieldname === "sourceFiles")  { cb(null, SOURCE_EXTS.includes(ext));  return; }
    cb(null, false);
  },
});

// ─── 타입 ───────────────────────────────────────────────────────────────────

interface DraftRow {
  sourceFileId?:    string;   // 서버가 할당한 파일 고유 ID (source-0, source-1, …)
  productId:        number | null;
  productName:      string;
  productType:      string;
  quantity:         number;
  unit:             string;
  unitPrice:        number;
  memo:             string;
  sourceLanguage:   string;
  targetLanguage:   string;
  fileName:         string;
  fileFormat:       string;
  wordCount:        number;
  charCount:        number;
  countBasis:       string;   // 분석 기준 레이블 ("Word 공식 통계" 등)
  interpretDate:    string;
  interpretEndDate: string;
  startTime:        string;
  endTime:          string;
  interpretPlace:   string;
  interpreterCount: number;
  eventStartDate:   string;
  eventEndDate:     string;
  itemLocation:     string;
  usagePeriod:      number;
  expenseType:      string;
  warnings:         string[];
  needsReview:      boolean;
}

// 파일별 추출 결과 + 서버 할당 ID
interface SourceFileStat {
  fileId: string;   // "source-0", "source-1", …
  name:   string;
  stats:  TextStats;
}

// ─── 파일명 UTF-8 복원 ───────────────────────────────────────────────────────

function decodeName(f: Express.Multer.File): string {
  try { return Buffer.from(f.originalname, "latin1").toString("utf8"); }
  catch { return f.originalname; }
}

// ─── 대용량·다중 파일 업로드(R2 분할 업로드) ─────────────────────────────────
// 여러 파일을 한 요청 본문(multipart)으로 보내면 운영(autoscale) 요청 본문 한도(32MiB)를 넘어 HTTP 413 이 난다.
// → 파일마다 8MB 조각으로 나눠 API 를 거쳐 기존 R2 버킷(임시 접두어 ai-draft-tmp/)에 S3 멀티파트로 올리고,
//   파일별로 텍스트를 추출(기존 extractText 그대로)한 뒤 임시 객체는 즉시 삭제한다. AI 요청에는 수치·샘플만 보낸다.
//   (R2 버킷에 브라우저 직접 업로드용 CORS 가 없어 presigned PUT 은 쓰지 않는다.)
export const AI_FILE_MAX_BYTES = 50 * 1024 * 1024;   // 파일당 상한(무제한 아님)
const AI_PART_BYTES = 8 * 1024 * 1024;                // 조각 크기(S3 멀티파트 최소 5MB 이상, 한 요청 ≪ 32MiB)
const TMP_KEY_RE = /^ai-draft-tmp\/[0-9a-f-]{36}\.(pdf|jpe?g|png|docx?|txt|pptx?|xlsx?|hwpx?)$/;
const ALL_EXTS = new Set(SOURCE_EXTS);

async function readTmpObject(key: string): Promise<Buffer> {
  if (!TMP_KEY_RE.test(key)) throw Object.assign(new Error("잘못된 파일 키입니다."), { status: 400 });
  const client = getR2Client() as any;
  const head = await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
  if ((head.ContentLength ?? 0) > AI_FILE_MAX_BYTES) throw Object.assign(new Error(`파일 용량이 ${AI_FILE_MAX_BYTES / 1024 / 1024}MB 를 초과합니다.`), { status: 413 });
  const obj = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  return Buffer.from(await obj.Body!.transformToByteArray());
}
const r2Guard = (_req: any, res: any, next: any) => {
  if (!isR2Configured()) { res.status(503).json({ error: "파일 저장소(R2)가 설정되지 않았습니다." }); return; }
  next();
};

// ─── Mock 초안 생성 (OpenAI 미설정 시) ──────────────────────────────────────

function buildMockRows(
  requestText: string,
  sourceFiles: SourceFileStat[],
): DraftRow[] {
  const rows: DraftRow[] = [];

  for (const { fileId, name, stats } of sourceFiles) {
    const ext   = path.extname(name).replace(".", "").toUpperCase();
    const pages = stats.pageCount ?? calcPages(stats, stats.detectedLanguage);
    rows.push({
      sourceFileId:     fileId,
      productId:        null,
      productName:      "번역",
      productType:      "translation",
      quantity:         pages,
      unit:             "페이지",
      unitPrice:        0,
      memo:             "AI 분석 준비 중 — 상품 및 단가 확인 필요",
      sourceLanguage:   stats.detectedLanguage !== "unknown" ? stats.detectedLanguage : "",
      targetLanguage:   "",
      fileName:         name,
      fileFormat:       ext,
      wordCount:        stats.wordCount,
      charCount:        stats.charCountNoSpace,
      countBasis:       stats.countBasis ?? "Text Extraction",
      interpretDate:    "", interpretEndDate: "",
      startTime:        "", endTime: "",
      interpretPlace:   "", interpreterCount: 0,
      eventStartDate:   "", eventEndDate: "",
      itemLocation:     "", usagePeriod: 0,
      expenseType:      "",
      warnings:         [
        ...(stats.warning ? [stats.warning] : []),
        "상품 확인 필요",
        "단가 확인 필요",
        "Mock 응답 — OpenAI API 키 설정 후 실제 분석 활성화",
      ],
      needsReview: true,
    });
  }

  if (rows.length === 0 && requestText.trim()) {
    rows.push({
      productId: null, productName: "서비스", productType: "expense",
      quantity: 1, unit: "건", unitPrice: 0,
      memo:         requestText.slice(0, 80),
      sourceLanguage: "", targetLanguage: "",
      fileName: "", fileFormat: "",
      wordCount: 0, charCount: 0,
      countBasis: "Text Extraction",
      interpretDate: "", interpretEndDate: "",
      startTime: "", endTime: "",
      interpretPlace: "", interpreterCount: 0,
      eventStartDate: "", eventEndDate: "",
      itemLocation: "", usagePeriod: 0,
      expenseType: "",
      warnings: ["상품 확인 필요", "단가 확인 필요"],
      needsReview: true,
    });
  }

  return rows;
}

// ─── GPT-4o 분석 ─────────────────────────────────────────────────────────────

async function analyzeWithGPT(params: {
  requestText:     string;
  requestFilesCtx: string;
  sourceFilesCtx:  string;
  visionContents:  Array<{ type: "image_url"; image_url: { url: string } }>;
  products: Array<{
    id: number; name: string; productType: string;
    sourceLanguage: string | null; targetLanguage: string | null;
    unit: string; basePrice: number | null;
  }>;
  apiKey:   string;
  baseURL?: string;
}): Promise<{ draftRows: DraftRow[]; warnings: string[]; confidence: string }> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: params.apiKey, baseURL: params.baseURL });

  const systemPrompt = `당신은 VERITAS(한국 전문 번역·통역 회사) 견적 분석 전문가입니다.

## 절대 규칙
1. productId/productName은 반드시 제공된 상품 목록에서만 선택. 없으면 null.
2. 단가는 상품의 basePrice를 사용. 0이면 unitPrice=0, warnings에 "단가 확인 필요" 추가.
3. 번역 원문 파일은 파일 하나당 번역 Row 1건 생성.
4. wordCount/charCount는 "번역 원문 분석 결과"의 값을 그대로 사용. 절대 추측 금지.
5. quantity는 0으로 설정 (서버가 언어 정책으로 자동 계산).
6. 반드시 유효한 JSON만 반환. 설명 텍스트 없음.
7. sourceFileId는 "번역 원문 분석 결과"의 [source-N] 식별자를 그대로 복사. 절대 변경 금지.

## 응답 형식 (JSON)
{
  "draftRows": [{
    "sourceFileId": "<분석 결과의 [source-N] 값, 예: source-0>",
    "productId": <number|null>, "productName": "<string>",
    "productType": "<translation|interpretation|equipment|expense>",
    "quantity": 0, "unit": "<string>", "unitPrice": <number>,
    "memo": "<string>", "sourceLanguage": "<lang>", "targetLanguage": "<lang>",
    "fileName": "<string>", "fileFormat": "<string>",
    "wordCount": <number>, "charCount": <number>,
    "interpretDate": "", "interpretEndDate": "",
    "startTime": "", "endTime": "",
    "interpretPlace": "", "interpreterCount": 0,
    "eventStartDate": "", "eventEndDate": "",
    "itemLocation": "", "usagePeriod": 0, "expenseType": "",
    "warnings": [], "needsReview": <boolean>
  }],
  "warnings": [], "confidence": "<high|medium|low>"
}`;

  const productList = params.products.map(p => ({
    id: p.id, name: p.name, type: p.productType,
    src: p.sourceLanguage, tgt: p.targetLanguage,
    unit: p.unit, basePrice: p.basePrice ?? 0,
  }));

  const userMsg = `## 고객 요청내용
${params.requestText || "(없음)"}

## 고객 요청자료 (의도 파악용)
${params.requestFilesCtx || "(없음)"}

## 번역 원문 분석 결과 (이 수치를 그대로 사용)
${params.sourceFilesCtx || "(없음)"}

## 상품 목록
${JSON.stringify(productList, null, 2)}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [{ type: "text", text: userMsg }, ...params.visionContents];

  const completion = await openai.chat.completions.create({
    model:           "gpt-4o",
    response_format: { type: "json_object" },
    temperature:     0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content },
    ],
  });

  const raw    = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as {
    draftRows?:  DraftRow[];
    warnings?:   string[];
    confidence?: string;
  };

  return {
    draftRows:  parsed.draftRows  ?? [],
    warnings:   parsed.warnings   ?? [],
    confidence: parsed.confidence ?? "medium",
  };
}

// ─── 분할 업로드: 시작 → 조각 → 완료 → 파일별 추출 ─────────────────────────────
router.post("/quotes/ai-draft/uploads", ...adminGuard, r2Guard, async (req, res) => {
  const name = String(req.body?.name ?? ""); const size = Number(req.body?.size ?? 0);
  const ext = path.extname(name).toLowerCase();
  if (!ALL_EXTS.has(ext)) { res.status(400).json({ error: `지원하지 않는 형식: ${ext || "(없음)"}` }); return; }
  if (!(size > 0)) { res.status(400).json({ error: "빈 파일입니다." }); return; }
  if (size > AI_FILE_MAX_BYTES) { res.status(413).json({ error: `파일 용량이 ${AI_FILE_MAX_BYTES / 1024 / 1024}MB 를 초과합니다.` }); return; }
  try {
    const key = `ai-draft-tmp/${randomUUID()}${ext}`;
    const r = await (getR2Client() as any).send(new CreateMultipartUploadCommand({ Bucket: bucketName, Key: key }));
    res.json({ key, uploadId: r.UploadId, partSize: AI_PART_BYTES });
  } catch (err) { req.log.error({ err }, "AI-DRAFT 업로드 시작 실패"); res.status(500).json({ error: "업로드 시작 실패" }); }
});

router.put("/quotes/ai-draft/uploads/part", ...adminGuard, r2Guard,
  express.raw({ type: "application/octet-stream", limit: AI_PART_BYTES + 1024 }),
  async (req, res) => {
    const key = String(req.query.key ?? ""), uploadId = String(req.query.uploadId ?? ""), partNumber = Number(req.query.partNumber);
    const maxParts = Math.ceil(AI_FILE_MAX_BYTES / AI_PART_BYTES);
    if (!TMP_KEY_RE.test(key) || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxParts) { res.status(400).json({ error: "잘못된 조각 요청입니다." }); return; }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) { res.status(400).json({ error: "조각 데이터가 없습니다." }); return; }
    try {
      const r = await (getR2Client() as any).send(new UploadPartCommand({ Bucket: bucketName, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body }));
      res.json({ partNumber, etag: r.ETag });
    } catch (err) { req.log.error({ err }, "AI-DRAFT 조각 업로드 실패"); res.status(500).json({ error: "조각 업로드 실패" }); }
  });

router.post("/quotes/ai-draft/uploads/complete", ...adminGuard, r2Guard, async (req, res) => {
  const key = String(req.body?.key ?? ""), uploadId = String(req.body?.uploadId ?? "");
  const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
  if (!TMP_KEY_RE.test(key) || !uploadId || !parts.length) { res.status(400).json({ error: "잘못된 완료 요청입니다." }); return; }
  const client = getR2Client() as any;
  try {
    await client.send(new CompleteMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p: any) => ({ PartNumber: Number(p.partNumber), ETag: String(p.etag) })).sort((a: any, b: any) => a.PartNumber - b.PartNumber) } }));
    res.json({ key });
  } catch (err) {
    req.log.error({ err }, "AI-DRAFT 업로드 완료 실패");
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: uploadId })).catch(() => undefined);
    res.status(500).json({ error: "업로드 완료 실패" });
  }
});

// 번역 원문 1개 → 기존 extractText 로 단어수·글자수 산정. 응답 text 는 AI 컨텍스트용 앞 500자만. 임시 객체는 항상 삭제.
router.post("/quotes/ai-draft/extract", ...adminGuard, r2Guard, async (req, res) => {
  const key = String(req.body?.key ?? ""); const name = String(req.body?.name ?? "").slice(0, 255);
  try {
    const buf = await readTmpObject(key);
    const st = await extractText(buf, name || key, process.env.AI_INTEGRATIONS_OPENAI_API_KEY, process.env.AI_INTEGRATIONS_OPENAI_BASE_URL);
    console.log(`[AI-DRAFT] extract ${name} (${buf.length} bytes) → ${st.method} words=${st.wordCount} chars=${st.charCountNoSpace}`);
    res.json({ name, stats: { ...st, text: st.text.slice(0, 500) } });
  } catch (err: any) {
    req.log.error({ err: err?.message }, "AI-DRAFT 파일 추출 실패");
    res.status(err?.status ?? 500).json({ error: err?.status ? err.message : "파일 분석 실패" });
  } finally {
    if (TMP_KEY_RE.test(key)) await deleteFromR2(key).catch(() => undefined);
  }
});

// 클라이언트가 보낸 파일별 추출 수치 정리(숫자·문자열만, 텍스트는 샘플 500자)
function sanitizeStats(raw: any): TextStats {
  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.round(x) : 0; };
  const s = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    text: s(raw?.text, 500), wordCount: n(raw?.wordCount), charCountWithSpace: n(raw?.charCountWithSpace), charCountNoSpace: n(raw?.charCountNoSpace),
    detectedLanguage: s(raw?.detectedLanguage, 20) || "unknown", method: s(raw?.method, 60), countBasis: s(raw?.countBasis, 60) || "Text Extraction",
    ...(raw?.pageCount != null && n(raw.pageCount) > 0 ? { pageCount: n(raw.pageCount) } : {}),
    ...(raw?.warning ? { warning: s(raw.warning, 300) } : {}),
  };
}

// ─── POST /api/quotes/ai-draft ───────────────────────────────────────────────
// 두 가지 입력: ① 기존 multipart(파일 본문 포함 — 하위 호환)  ② JSON(파일은 위 분할 업로드로 처리 완료):
//   { requestText, sourceStats: [{ name, stats }], requestObjects: [{ key, name, size }] }

router.post(
  "/quotes/ai-draft",
  ...adminGuard,
  (req, res, next) => {
    aiUpload.fields([
      { name: "requestFiles", maxCount: 10 },
      { name: "sourceFiles",  maxCount: 10 },
    ])(req, res, (err) => {
      if (err) console.error("[AI-DRAFT] multer error:", err);
      next();
    });
  },
  async (req, res) => {
    console.log("[AI-DRAFT] POST /api/quotes/ai-draft");

    const jsonMode     = !!req.is("application/json");
    const requestText  = (req.body?.requestText as string) ?? "";
    const allFiles     = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const sourceFiles  = allFiles["sourceFiles"]  ?? [];
    // 고객 요청자료 — multipart 파일 또는 R2 임시 객체(필요할 때 1개씩 읽고 처리 후 삭제)
    type ReqInput = { name: string; size: number; load: () => Promise<Buffer> };
    const requestObjects = jsonMode && Array.isArray(req.body?.requestObjects)
      ? (req.body.requestObjects as any[]).filter(o => TMP_KEY_RE.test(String(o?.key ?? ""))).slice(0, 10) : [];
    const requestFiles: ReqInput[] = jsonMode
      ? requestObjects.map(o => ({ name: String(o.name ?? "").slice(0, 255), size: Number(o.size) || 0, load: () => readTmpObject(String(o.key)) }))
      : (allFiles["requestFiles"] ?? []).map(f => ({ name: decodeName(f), size: f.size, load: async () => f.buffer }));
    const preStats: Array<{ name: string; stats: TextStats }> = jsonMode && Array.isArray(req.body?.sourceStats)
      ? (req.body.sourceStats as any[]).slice(0, 50).map(x => ({ name: String(x?.name ?? "").slice(0, 255), stats: sanitizeStats(x?.stats) })) : [];
    res.on("finish", () => { for (const o of requestObjects) deleteFromR2(String(o.key)).catch(() => undefined); });

    console.log(`[AI-DRAFT] mode=${jsonMode ? "json" : "multipart"} text=${requestText.length}ch reqFiles=${requestFiles.length} srcFiles=${sourceFiles.length + preStats.length}`);

    if (!requestText.trim() && requestFiles.length === 0 && sourceFiles.length === 0 && preStats.length === 0) {
      res.status(400).json({ error: "요청내용을 입력하거나 파일을 업로드해 주세요." });
      return;
    }

    const openaiApiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const openaiBaseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

    // ── Step 1: 번역 원문 텍스트 추출 ─────────────────────────────────────────
    // 각 파일에 서버 할당 고유 ID(source-0, source-1, …) 부여.
    // 이 ID는 GPT 컨텍스트에 포함되고 GPT 응답에 그대로 반환되어 파일명 불일치 없이 매핑된다.
    const sourceFileStats: SourceFileStat[] = preStats.map((p, idx) => ({ fileId: `source-${idx}`, name: p.name, stats: p.stats }));
    const extractWarnings: string[] = preStats.filter(p => p.stats.warning).map(p => `${p.name}: ${p.stats.warning}`);

    // 진단용: 업로드된 소스 파일을 /tmp/에 저장 (분석 후 삭제 가능)
    for (const file of sourceFiles) {
      try {
        const safeName = decodeName(file).replace(/[^\w.-]/g, "_");
        const savePath = `/tmp/ai-draft-upload-${safeName}`;
        await import("node:fs").then(fs => fs.promises.writeFile(savePath, file.buffer));
        console.log(`[AI-DRAFT] 진단용 파일 저장: ${savePath} (${file.buffer.length} bytes)`);
      } catch (e) {
        console.warn("[AI-DRAFT] 진단용 파일 저장 실패:", e);
      }
    }

    for (let idx = 0; idx < sourceFiles.length; idx++) {
      const file   = sourceFiles[idx];
      const fileId = `source-${idx}`;
      const name   = decodeName(file);
      console.log(`[AI-DRAFT] extracting [${fileId}]: ${name} (${file.size} bytes)`);
      const st    = await extractText(file.buffer, name, openaiApiKey, openaiBaseURL);
      const pages = calcPages(st, st.detectedLanguage);
      console.log(`[AI-DRAFT] [${fileId}] ${name}`);
      console.log(`  countSource: ${st.method}`);
      console.log(`  countBasis:  ${st.countBasis}`);
      console.log(`  wordCount:   ${st.wordCount}`);
      console.log(`  charCount:   ${st.charCountNoSpace}`);
      console.log(`  pageCount:   ${pages}`);
      sourceFileStats.push({ fileId, name, stats: st });
      if (st.warning) extractWarnings.push(`${name}: ${st.warning}`);
    }

    // 추출 완료 — 각 파일의 공식 단어수 소스 명시 출력 (요구사항 7)
    console.log("[AI-DRAFT] ─── Extraction Results ───");
    for (const { fileId, name, stats } of sourceFileStats) {
      console.log(`[AI-DRAFT]   [${fileId}] ${name}`);
      console.log(`[AI-DRAFT]     stats.wordCount = ${stats.wordCount}  (countBasis: ${stats.countBasis})`);
      console.log(`[AI-DRAFT]     stats.charCount = ${stats.charCountNoSpace}`);
      console.log(`[AI-DRAFT]     stats.pageCount = ${stats.pageCount ?? "N/A (text 기반 계산 예정)"}`);
    }
    console.log("[AI-DRAFT] ─────────────────────────");

    // ── OpenAI 없을 때: Mock (추출 수치는 정확) ──────────────────────────────
    if (!openaiApiKey) {
      console.log("[AI-DRAFT] No OpenAI key — returning mock with extracted stats");
      const mockRows = buildMockRows(requestText, sourceFileStats);
      console.log("[AI-DRAFT] ═══ FINAL SEND (mock) ═══");
      for (const row of mockRows) {
        console.log(`[AI-DRAFT]   [${row.sourceFileId ?? "(no-id)"} / ${row.fileName}] type=${row.productType} wordCount=${row.wordCount} charCount=${row.charCount} countBasis=${row.countBasis} quantity=${row.quantity}`);
      }
      console.log("[AI-DRAFT] ════════════════════════");
      res.json({
        draftRows:  mockRows,
        warnings:   ["OpenAI API 키 미설정 — 상품 추천은 비활성화, 수치 데이터는 실제 추출값입니다.", ...extractWarnings],
        confidence: "low",
      });
      return;
    }

    // ── Step 2: GPT-4o 분석 ───────────────────────────────────────────────────
    try {
      const products = await db
        .select({
          id: productsTable.id, name: productsTable.name,
          productType: productsTable.productType,
          sourceLanguage: productsTable.sourceLanguage,
          targetLanguage: productsTable.targetLanguage,
          unit: productsTable.unit, basePrice: productsTable.basePrice,
        })
        .from(productsTable)
        .where(and(eq(productsTable.active, true), isNull(productsTable.deletedAt)));

      // 고객 요청자료 컨텍스트 + vision
      const { renderPdfFirstPageAsPng, buildImageDataUrl } = await import("../lib/documentOcr");
      type VisionImg = { type: "image_url"; image_url: { url: string } };
      const visionContents: VisionImg[] = [];
      const reqCtxParts:    string[]    = [];

      for (const file of requestFiles) {
        const name = file.name;
        const ext  = path.extname(name).toLowerCase();
        reqCtxParts.push(`- ${name} (${ext.toUpperCase().replace(".", "")}, ${Math.round(file.size / 1024)}KB)`);
        if ([".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) {
          try {
            let buf = await file.load();
            let imgExt = ext;
            if (ext === ".pdf") { buf = await renderPdfFirstPageAsPng(buf); imgExt = ".png"; }
            // AI 요청 본문 보호 — 이미지가 20MB 를 넘으면 시각 참고에서 제외(기존 업로드 상한과 동일 기준)
            if (buf.length > 20 * 1024 * 1024) { extractWarnings.push(`${name}: 이미지가 커서 AI 시각 참고에서 제외했습니다.`); continue; }
            visionContents.push({ type: "image_url", image_url: { url: buildImageDataUrl(buf, imgExt) } });
          } catch { extractWarnings.push(`${name}: 이미지 변환 실패`); }
        }
      }

      // 번역 원문 컨텍스트 (파일 ID + 추출된 수치 + 분석 기준 + 텍스트 샘플)
      // [source-N] ID는 GPT가 응답 시 sourceFileId 필드에 그대로 복사해야 한다.
      const srcCtxParts: string[] = [];
      for (const { fileId, name, stats } of sourceFileStats) {
        const fmt   = path.extname(name).replace(".", "").toUpperCase();
        const pages = stats.pageCount ?? calcPages(stats, stats.detectedLanguage);
        srcCtxParts.push(
          `### [${fileId}] 원본 파일명: ${name}\n` +
          `fileId: ${fileId}\n` +
          `형식: ${fmt}\n` +
          `분석 기준: ${stats.countBasis}\n` +
          `단어수(Word Count): ${stats.wordCount.toLocaleString()}\n` +
          `글자수(공백 포함): ${stats.charCountWithSpace.toLocaleString()}\n` +
          `글자수(공백 제외): ${stats.charCountNoSpace.toLocaleString()}\n` +
          `페이지수: ${pages}\n` +
          `감지된 언어: ${stats.detectedLanguage}\n` +
          (stats.text.length > 0
            ? `텍스트 샘플(첫 500자):\n"""\n${stats.text.slice(0, 500)}\n"""`
            : "(텍스트 추출 불가)")
        );
      }

      const gptResult = await analyzeWithGPT({
        requestText,
        requestFilesCtx: reqCtxParts.join("\n"),
        sourceFilesCtx:  srcCtxParts.join("\n\n---\n\n"),
        visionContents,
        products,
        apiKey:  openaiApiKey,
        baseURL: openaiBaseURL,
      });

      // ── Step 3: 서버 사이드 후처리 ────────────────────────────────────────
      // 조회 맵 (4단계 우선순위)
      const fileIdMap   = new Map(sourceFileStats.map(f => [f.fileId, f.stats]));
      const fileNameMap = new Map(sourceFileStats.map(f => [f.name, f.stats]));
      const lowerMap    = new Map(sourceFileStats.map(f => [f.name.toLowerCase(), f.stats]));

      /**
       * 공식 통계 우선순위:
       *   1순위: sourceFileId (서버 할당 ID — 파일명 불일치에도 항상 정확)
       *   2순위: 정확한 파일명 일치
       *   3순위: 소문자 정규화 파일명
       *   4순위: 파일 1개 업로드 시 무조건 적용
       */
      function resolveStats(row: DraftRow): TextStats | undefined {
        if (row.sourceFileId) {
          const st = fileIdMap.get(row.sourceFileId);
          if (st) return st;
        }
        return fileNameMap.get(row.fileName)
          ?? lowerMap.get((row.fileName ?? "").toLowerCase())
          ?? (sourceFileStats.length === 1 ? sourceFileStats[0].stats : undefined);
      }

      // GPT 응답 진단 로그
      console.log("[AI-DRAFT] GPT draftRows field-map check:");
      for (const row of gptResult.draftRows) {
        console.log(`  sourceFileId="${row.sourceFileId ?? "(none)"}" fileName="${row.fileName}" wordCount=${row.wordCount} countBasis=${row.countBasis ?? "(gpt-none)"}`);
      }

      const draftRows = gptResult.draftRows.map((row) => {
        const st  = resolveStats(row);
        const via = row.sourceFileId && fileIdMap.has(row.sourceFileId)
          ? `fileId=${row.sourceFileId}`
          : `fileName="${row.fileName}"`;

        const gptWordCount   = row.wordCount;
        const serverWordCount = st?.wordCount ?? null;

        // GPT 응답 wordCount는 무조건 무시 — 서버 추출값만 사용
        if (st) {
          row.wordCount  = st.wordCount;
          row.charCount  = st.charCountNoSpace;
          row.countBasis = st.countBasis ?? "Text Extraction";
          if (!row.sourceLanguage && st.detectedLanguage !== "unknown") {
            row.sourceLanguage = st.detectedLanguage;
          }
        } else {
          row.countBasis = row.countBasis ?? "Text Extraction";
        }

        // ── 요구사항 7: 단어수 결정 근거 로그 ─────────────────────────────
        console.log("[AI-DRAFT] ─── Word Count Resolution ───");
        console.log(`[AI-DRAFT]   sourceFileId            : ${row.sourceFileId ?? "(none)"}`);
        console.log(`[AI-DRAFT]   sourceFile.name         : ${row.fileName}`);
        console.log(`[AI-DRAFT]   sourceFile.stats.wordCount : ${serverWordCount ?? "(no match)"}${st ? ` [${st.countBasis}]` : ""}`);
        console.log(`[AI-DRAFT]   gptRow.wordCount         : ${gptWordCount} (GPT — IGNORED)`);
        console.log(`[AI-DRAFT]   finalAppliedWordCount    : ${row.wordCount}  (via ${via})`);
        console.log(`[AI-DRAFT]   finalAppliedCharCount    : ${row.charCount}  (st.charCountNoSpace=${st?.charCountNoSpace ?? "(no match)"})`);
        console.log(`[AI-DRAFT]   countBasis               : ${row.countBasis}`);
        if (!st) {
          console.warn(`[AI-DRAFT]   ⚠ WARNING: sourceFile stats NOT resolved — GPT fallback used`);
        }
        console.log("[AI-DRAFT] ─────────────────────────────");

        // 페이지 계산: 공식 pageCount 우선, 없으면 언어 정책 계산
        if (row.productType === "translation") {
          if (st?.pageCount) {
            row.quantity = st.pageCount;
          } else {
            const ps = st ?? { wordCount: row.wordCount, charCountNoSpace: row.charCount, detectedLanguage: row.sourceLanguage };
            row.quantity = calcPages(ps as TextStats, row.sourceLanguage);
          }
        }

        // 경고 추가
        const warns = [...(row.warnings ?? [])];
        if ((!row.unitPrice || row.unitPrice === 0) && !warns.includes("단가 확인 필요")) warns.push("단가 확인 필요");
        if (!row.productId && !warns.includes("상품 확인 필요")) warns.push("상품 확인 필요");
        row.warnings = warns;
        if (warns.length > 0) row.needsReview = true;
        return row;
      });

      console.log("[AI-DRAFT] ═══ FINAL SEND (gpt) ═══");
      for (const row of draftRows) {
        console.log(`[AI-DRAFT]   [${row.sourceFileId ?? "(no-id)"} / ${row.fileName}] type=${row.productType} wordCount=${row.wordCount} charCount=${row.charCount} countBasis=${row.countBasis} quantity=${row.quantity}`);
      }
      console.log("[AI-DRAFT] ═══════════════════════");
      res.json({
        draftRows,
        warnings:   [...gptResult.warnings, ...extractWarnings],
        confidence: gptResult.confidence,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[AI-DRAFT] GPT failed:", reason);
      const mockRows = buildMockRows(requestText, sourceFileStats);
      console.log("[AI-DRAFT] ═══ FINAL SEND (error fallback) ═══");
      for (const row of mockRows) {
        console.log(`[AI-DRAFT]   [${row.sourceFileId ?? "(no-id)"} / ${row.fileName}] type=${row.productType} wordCount=${row.wordCount} charCount=${row.charCount} countBasis=${row.countBasis} quantity=${row.quantity}`);
      }
      console.log("[AI-DRAFT] ═══════════════════════════════════");
      res.json({
        draftRows:  mockRows,
        warnings:   [`AI 분석 오류: ${reason.slice(0, 120)}`, ...extractWarnings],
        confidence: "low",
      });
    }
  },
);

export default router;
