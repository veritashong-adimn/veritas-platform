/**
 * POST /api/quotes/ai-draft
 *
 * AI 견적 초안 생성 — DB 저장 없음, 관리자 검토 후 Workspace에 반영하는 구조.
 *
 * 동작 모드:
 *   A. OpenAI API 키 설정됨 → GPT-4o 실제 분석
 *   B. API 키 미설정 또는 분석 실패 → Mock 응답 (파일명 기반)
 *
 * 이 파일은 quotes.ts 와 완전히 분리되어 있어
 * 기존 견적 라우트에 영향을 주지 않는다.
 */
import { Router, type IRouter } from "express";
import { db, productsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import multer from "multer";
import path from "node:path";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── 언어 페이지 정책 ────────────────────────────────────────────────────────

const CHAR_LANG = ["ko", "ja", "zh-hans", "zh-hant", "th", "mn"];
function calcPages(charCount: number, wordCount: number, sourceLang: string): number {
  const lang = (sourceLang ?? "").toLowerCase();
  if (CHAR_LANG.includes(lang)) return Math.ceil((charCount || 0) / 700);
  return Math.ceil((wordCount || 0) / 250);
}

// ─── multer ─────────────────────────────────────────────────────────────────

const REQUEST_EXTS = [".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".txt", ".ppt", ".pptx"];
const SOURCE_EXTS  = [".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".txt", ".ppt", ".pptx", ".xls", ".xlsx"];

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

// ─── Mock 초안 생성 (파일명 기반) ────────────────────────────────────────────
// OpenAI 없이도 동작. 파일 하나당 번역 Row 1건 생성.

function buildMockRows(
  requestText: string,
  sourceFileNames: string[],
): DraftRow[] {
  const rows: DraftRow[] = [];

  // 번역 원문 파일 → 번역 Row
  for (const name of sourceFileNames) {
    const ext = path.extname(name).replace(".", "").toUpperCase();
    rows.push({
      productId:        null,
      productName:      "번역",
      productType:      "translation",
      quantity:         1,
      unit:             "페이지",
      unitPrice:        0,
      memo:             "AI 분석 준비 중",
      sourceLanguage:   "",
      targetLanguage:   "",
      fileName:         name,
      fileFormat:       ext,
      wordCount:        0,
      charCount:        0,
      interpretDate:    "", interpretEndDate: "",
      startTime:        "", endTime: "",
      interpretPlace:   "", interpreterCount: 0,
      eventStartDate:   "", eventEndDate: "",
      itemLocation:     "", usagePeriod: 0,
      expenseType:      "",
      warnings:         ["상품 확인 필요", "단가 확인 필요", "수량 확인 필요"],
      needsReview:      true,
    });
  }

  // 파일 없이 텍스트만 있는 경우 → 단일 행 생성
  if (rows.length === 0 && requestText.trim()) {
    rows.push({
      productId:        null,
      productName:      "서비스",
      productType:      "expense",
      quantity:         1,
      unit:             "건",
      unitPrice:        0,
      memo:             requestText.slice(0, 80),
      sourceLanguage:   "", targetLanguage:   "",
      fileName:         "", fileFormat:       "",
      wordCount:        0,  charCount:        0,
      interpretDate:    "", interpretEndDate: "",
      startTime:        "", endTime: "",
      interpretPlace:   "", interpreterCount: 0,
      eventStartDate:   "", eventEndDate: "",
      itemLocation:     "", usagePeriod: 0,
      expenseType:      "",
      warnings:         ["상품 확인 필요", "단가 확인 필요"],
      needsReview:      true,
    });
  }

  return rows;
}

// ─── OpenAI 분석 (동적 로드 — 키 없으면 스킵) ───────────────────────────────

async function analyzeWithAI(params: {
  requestText:      string;
  requestFilesInfo: string;
  sourceFilesInfo:  string;
  visionContents:   Array<{ type: "image_url"; image_url: { url: string } }>;
  products: Array<{
    id: number; name: string; productType: string;
    sourceLanguage: string | null; targetLanguage: string | null;
    unit: string; basePrice: number | null;
  }>;
  apiKey: string;
  baseURL?: string;
}): Promise<{ draftRows: DraftRow[]; warnings: string[]; confidence: string }> {
  // OpenAI는 동적 import — 모듈 로드 실패가 라우터 전체에 영향 주지 않도록
  const { default: OpenAI } = await import("openai");
  const { renderPdfFirstPageAsPng, buildImageDataUrl } = await import("../lib/documentOcr");
  void renderPdfFirstPageAsPng; void buildImageDataUrl; // 사용 선언 (vision은 호출 전 변환됨)

  const openai = new OpenAI({ apiKey: params.apiKey, baseURL: params.baseURL });

  const systemPrompt = `You are an expert quote analyst for VERITAS, a professional translation and interpretation company in Korea.

CRITICAL RULES:
1. ONLY use products from the provided product list. Never invent product IDs or names.
2. Match the BEST product from the list based on service type and language pair.
3. If no product matches, set productId to null and add "상품 확인 필요" warning.
4. Unit prices: use the product's basePrice. If 0 or null, set unitPrice to 0 and add "단가 확인 필요" warning.
5. For translation: one source file = one translation Row.
6. Return ONLY valid JSON, no explanation text.

LANGUAGE PAGE POLICIES:
- Character-based (ko, ja, zh-hans, zh-hant, th, mn): 700 chars = 1 page (round up)
- Word-based (en, fr, de, es, it, pt, ru, etc.): 250 words = 1 page (round up)

RESPONSE FORMAT (strict JSON):
{
  "draftRows": [{
    "productId": <number|null>, "productName": "<string>",
    "productType": "<translation|interpretation|equipment|expense>",
    "quantity": <number>, "unit": "<string>", "unitPrice": <number>,
    "memo": "<string>", "sourceLanguage": "<lang code>", "targetLanguage": "<lang code>",
    "fileName": "<string>", "fileFormat": "<string>",
    "wordCount": <number>, "charCount": <number>,
    "interpretDate": "<YYYY-MM-DD>", "interpretEndDate": "<YYYY-MM-DD>",
    "startTime": "<HH:MM>", "endTime": "<HH:MM>",
    "interpretPlace": "<string>", "interpreterCount": <number>,
    "eventStartDate": "<YYYY-MM-DD>", "eventEndDate": "<YYYY-MM-DD>",
    "itemLocation": "<string>", "usagePeriod": <number>,
    "expenseType": "<string>",
    "warnings": ["<string>"], "needsReview": <boolean>
  }],
  "warnings": ["<string>"],
  "confidence": "<high|medium|low>"
}`;

  const productList = params.products.map(p => ({
    id: p.id, name: p.name, type: p.productType,
    src: p.sourceLanguage, tgt: p.targetLanguage,
    unit: p.unit, basePrice: p.basePrice ?? 0,
  }));

  const userText = `## 고객 요청내용
${params.requestText || "(없음)"}

## 고객 요청자료 (서비스 의도 파악용 — 글자수 계산 금지)
${params.requestFilesInfo || "(없음)"}

## 번역 원문 (파일 하나당 번역 Row 1건 생성, 글자수·단어수 추출)
${params.sourceFilesInfo || "(없음)"}

## 상품 목록 (이 목록에서만 선택)
${JSON.stringify(productList, null, 2)}

위 정보를 분석하여 견적 초안 JSON을 생성하라.`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userContent: any[] = [{ type: "text", text: userText }, ...params.visionContents];

  const completion = await openai.chat.completions.create({
    model:           "gpt-4o",
    response_format: { type: "json_object" },
    temperature:     0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userContent  },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as {
    draftRows?: DraftRow[];
    warnings?:  string[];
    confidence?: string;
  };

  // 서버 사이드 페이지 재계산
  const draftRows = (parsed.draftRows ?? []).map(r => {
    if (r.productType === "translation" && r.sourceLanguage) {
      const pages = calcPages(r.charCount ?? 0, r.wordCount ?? 0, r.sourceLanguage);
      if (pages > 0) r.quantity = pages;
    }
    if (!r.unitPrice || r.unitPrice === 0) {
      r.warnings = [...(r.warnings ?? []), "단가 확인 필요"];
      r.needsReview = true;
    }
    if (!r.productId) {
      r.warnings = [...(r.warnings ?? []), "상품 확인 필요"];
      r.needsReview = true;
    }
    return r;
  });

  return {
    draftRows,
    warnings:   parsed.warnings   ?? [],
    confidence: parsed.confidence ?? "medium",
  };
}

// ─── POST /api/quotes/ai-draft ───────────────────────────────────────────────

router.post(
  "/quotes/ai-draft",
  ...adminGuard,
  (req, res, next) => {
    aiUpload.fields([
      { name: "requestFiles", maxCount: 10 },
      { name: "sourceFiles",  maxCount: 10 },
    ])(req, res, (err) => {
      if (err) {
        console.error("[AI-DRAFT] multer error:", err);
        // multer 오류 무시하고 계속 진행 (파일 없이도 텍스트만으로 분석 가능)
      }
      next();
    });
  },
  async (req, res) => {
    console.log("[AI-DRAFT] HIT method=POST url=/api/quotes/ai-draft");

    const requestText  = (req.body?.requestText as string) ?? "";
    const allFiles     = (req.files  ?? {}) as Record<string, Express.Multer.File[]>;
    const requestFiles = allFiles["requestFiles"] ?? [];
    const sourceFiles  = allFiles["sourceFiles"]  ?? [];

    console.log(`[AI-DRAFT] requestText.len=${requestText.length} reqFiles=${requestFiles.length} srcFiles=${sourceFiles.length}`);

    if (!requestText.trim() && requestFiles.length === 0 && sourceFiles.length === 0) {
      res.status(400).json({ error: "요청내용을 입력하거나 파일을 업로드해 주세요." });
      return;
    }

    // 파일명 추출 (UTF-8 복원)
    const decodeName = (f: Express.Multer.File) =>
      Buffer.from(f.originalname, "latin1").toString("utf8");
    const sourceFileNames  = sourceFiles.map(decodeName);
    const requestFileNames = requestFiles.map(decodeName);

    const openaiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

    // ── OpenAI 없을 때: Mock 응답 즉시 반환 ──────────────────────────────────
    if (!openaiApiKey) {
      console.log("[AI-DRAFT] No OpenAI key — returning mock response");
      const mockRows = buildMockRows(requestText, sourceFileNames);
      res.json({
        draftRows:  mockRows,
        warnings:   [
          "현재는 Mock 응답입니다. 실제 문서 분석과 GPT 분석은 OpenAI API 키 설정 후 활성화됩니다.",
          ...requestFileNames.map(n => `고객 요청자료: ${n}`),
          ...sourceFileNames.map(n => `번역 원문: ${n}`),
        ],
        confidence: "low",
      });
      return;
    }

    // ── OpenAI 있을 때: 실제 분석 ────────────────────────────────────────────
    try {
      // 상품 목록 조회
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

      // 이미지/PDF → vision content (동적 import)
      const { renderPdfFirstPageAsPng, buildImageDataUrl } = await import("../lib/documentOcr");
      type VisionImg = { type: "image_url"; image_url: { url: string } };
      const visionContents: VisionImg[] = [];
      const fileWarnings:   string[]    = [];
      const reqInfoParts:   string[]    = [];
      const srcInfoParts:   string[]    = [];

      for (const file of requestFiles) {
        const name = decodeName(file);
        const ext  = path.extname(name).toLowerCase();
        const kb   = Math.round(file.size / 1024);
        reqInfoParts.push(`- 파일명: ${name}, 형식: ${ext.replace(".", "").toUpperCase()}, 크기: ${kb}KB`);
        if ([".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) {
          try {
            let buf = file.buffer;
            let imgExt = ext;
            if (ext === ".pdf") { buf = await renderPdfFirstPageAsPng(buf); imgExt = ".png"; }
            visionContents.push({ type: "image_url", image_url: { url: buildImageDataUrl(buf, imgExt) } });
          } catch { fileWarnings.push(`${name}: 요청자료 변환 실패`); }
        }
      }

      for (const file of sourceFiles) {
        const name = decodeName(file);
        const ext  = path.extname(name).toLowerCase();
        const kb   = Math.round(file.size / 1024);
        srcInfoParts.push(`- 파일명: ${name}, 형식: ${ext.replace(".", "").toUpperCase()}, 크기: ${kb}KB`);
        if ([".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) {
          try {
            let buf = file.buffer;
            let imgExt = ext;
            if (ext === ".pdf") { buf = await renderPdfFirstPageAsPng(buf); imgExt = ".png"; }
            visionContents.push({ type: "image_url", image_url: { url: buildImageDataUrl(buf, imgExt) } });
            srcInfoParts.push(`  → 이미지 첨부됨: 글자수·단어수·언어를 직접 분석할 것`);
          } catch { fileWarnings.push(`${name}: 원문 변환 실패`); }
        } else {
          srcInfoParts.push(`  → 내용 직접 분석 불가. 번역 Row 1건, 수량=1, 글자수/단어수=0으로 처리.`);
        }
      }

      const result = await analyzeWithAI({
        requestText,
        requestFilesInfo: reqInfoParts.join("\n"),
        sourceFilesInfo:  srcInfoParts.join("\n"),
        visionContents,
        products,
        apiKey:  openaiApiKey,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      res.json({
        draftRows:  result.draftRows,
        warnings:   [...result.warnings, ...fileWarnings],
        confidence: result.confidence,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[AI-DRAFT] analysis failed:", reason);

      // AI 분석 실패 시 Mock 폴백
      const mockRows = buildMockRows(requestText, sourceFileNames);
      res.json({
        draftRows:  mockRows,
        warnings:   [`AI 분석 중 오류가 발생했습니다: ${reason}`, "아래 항목을 직접 확인해 주세요."],
        confidence: "low",
      });
    }
  },
);

export default router;
