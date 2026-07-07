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
import { Router, type IRouter } from "express";
import { db, productsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import multer from "multer";
import path from "node:path";
import { requireAuth, requireRole } from "../middlewares/auth";
import { extractText, type TextStats } from "../lib/textExtractor";

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
const SOURCE_EXTS  = [...REQUEST_EXTS, ".xls", ".xlsx"];

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

// ─── 파일명 UTF-8 복원 ───────────────────────────────────────────────────────

function decodeName(f: Express.Multer.File): string {
  try { return Buffer.from(f.originalname, "latin1").toString("utf8"); }
  catch { return f.originalname; }
}

// ─── Mock 초안 생성 (OpenAI 미설정 시) ──────────────────────────────────────

function buildMockRows(
  requestText: string,
  sourceFiles: Array<{ name: string; stats: TextStats }>,
): DraftRow[] {
  const rows: DraftRow[] = [];

  for (const { name, stats } of sourceFiles) {
    const ext  = path.extname(name).replace(".", "").toUpperCase();
    const pages = calcPages(stats, stats.detectedLanguage);
    rows.push({
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

## 응답 형식 (JSON)
{
  "draftRows": [{
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

// ─── POST /api/quotes/ai-draft ───────────────────────────────────────────────

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

    const requestText  = (req.body?.requestText as string) ?? "";
    const allFiles     = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const requestFiles = allFiles["requestFiles"] ?? [];
    const sourceFiles  = allFiles["sourceFiles"]  ?? [];

    console.log(`[AI-DRAFT] text=${requestText.length}ch reqFiles=${requestFiles.length} srcFiles=${sourceFiles.length}`);

    if (!requestText.trim() && requestFiles.length === 0 && sourceFiles.length === 0) {
      res.status(400).json({ error: "요청내용을 입력하거나 파일을 업로드해 주세요." });
      return;
    }

    const openaiApiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const openaiBaseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

    // ── Step 1: 번역 원문 텍스트 추출 ────────────────────────────────────────
    const sourceFileStats: Array<{ name: string; stats: TextStats }> = [];
    const extractWarnings: string[] = [];

    for (const file of sourceFiles) {
      const name = decodeName(file);
      console.log(`[AI-DRAFT] extracting: ${name} (${file.size} bytes)`);
      const st = await extractText(file.buffer, name, openaiApiKey, openaiBaseURL);
      console.log(`[AI-DRAFT] ${name} → words=${st.wordCount} chars=${st.charCountNoSpace} lang=${st.detectedLanguage} via=${st.method}`);
      sourceFileStats.push({ name, stats: st });
      if (st.warning) extractWarnings.push(`${name}: ${st.warning}`);
    }

    // ── OpenAI 없을 때: Mock (추출 수치는 정확) ──────────────────────────────
    if (!openaiApiKey) {
      console.log("[AI-DRAFT] No OpenAI key — returning mock with extracted stats");
      const mockRows = buildMockRows(requestText, sourceFileStats);
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
        const name = decodeName(file);
        const ext  = path.extname(name).toLowerCase();
        reqCtxParts.push(`- ${name} (${ext.toUpperCase().replace(".", "")}, ${Math.round(file.size / 1024)}KB)`);
        if ([".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) {
          try {
            let buf = file.buffer;
            let imgExt = ext;
            if (ext === ".pdf") { buf = await renderPdfFirstPageAsPng(buf); imgExt = ".png"; }
            visionContents.push({ type: "image_url", image_url: { url: buildImageDataUrl(buf, imgExt) } });
          } catch { extractWarnings.push(`${name}: 이미지 변환 실패`); }
        }
      }

      // 번역 원문 컨텍스트 (추출된 수치 + 텍스트 샘플)
      const srcCtxParts: string[] = [];
      for (const { name, stats } of sourceFileStats) {
        const fmt = path.extname(name).replace(".", "").toUpperCase();
        srcCtxParts.push(
          `### ${name}\n` +
          `형식: ${fmt}\n` +
          `단어수(Word Count): ${stats.wordCount.toLocaleString()}\n` +
          `글자수(공백 포함): ${stats.charCountWithSpace.toLocaleString()}\n` +
          `글자수(공백 제외): ${stats.charCountNoSpace.toLocaleString()}\n` +
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
      const fileStatsMap = new Map(sourceFileStats.map(f => [f.name, f.stats]));

      const draftRows = gptResult.draftRows.map((row) => {
        const st = fileStatsMap.get(row.fileName);

        // 추출값으로 항상 보정 — GPT가 틀린 값(공백 포함 등)을 쓸 수 있으므로
        if (st) {
          row.wordCount  = st.wordCount;           // 항상 추출값 사용
          row.charCount  = st.charCountNoSpace;    // 공백 제외 글자수로 통일
          if (!row.sourceLanguage && st.detectedLanguage !== "unknown") {
            row.sourceLanguage = st.detectedLanguage;
          }
        }

        // 페이지 계산 (서버 사이드 덮어쓰기)
        if (row.productType === "translation") {
          const ps = st ?? { wordCount: row.wordCount, charCountNoSpace: row.charCount, detectedLanguage: row.sourceLanguage };
          row.quantity = calcPages(ps as TextStats, row.sourceLanguage);
        }

        // 경고 추가
        const warns = [...(row.warnings ?? [])];
        if ((!row.unitPrice || row.unitPrice === 0) && !warns.includes("단가 확인 필요")) warns.push("단가 확인 필요");
        if (!row.productId && !warns.includes("상품 확인 필요")) warns.push("상품 확인 필요");
        row.warnings = warns;
        if (warns.length > 0) row.needsReview = true;
        return row;
      });

      res.json({
        draftRows,
        warnings:   [...gptResult.warnings, ...extractWarnings],
        confidence: gptResult.confidence,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[AI-DRAFT] GPT failed:", reason);
      const mockRows = buildMockRows(requestText, sourceFileStats);
      res.json({
        draftRows:  mockRows,
        warnings:   [`AI 분석 오류: ${reason.slice(0, 120)}`, ...extractWarnings],
        confidence: "low",
      });
    }
  },
);

export default router;
