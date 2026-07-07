import { Router, type IRouter } from "express";
import { db, quotesTable, projectsTable, productsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import multer from "multer";
import path from "node:path";
import OpenAI from "openai";
import { logEvent } from "../lib/logEvent";
import { requireAuth, requireRole } from "../middlewares/auth";
import { renderPdfFirstPageAsPng, buildImageDataUrl } from "../lib/documentOcr";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── multer — 메모리 저장, 최대 5파일 × 20MB ──────────────────────────────────

const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = [".pdf", ".jpg", ".jpeg", ".png", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"];
    cb(null, allowed.includes(ext));
  },
});

// ─── 언어 페이지 정책 (백엔드 자체 계산용) ─────────────────────────────────────

const CHAR_LANG = ["ko", "ja", "zh-hans", "zh-hant", "th", "mn"];
function calcPages(charCount: number, wordCount: number, sourceLang: string): number {
  const lang = (sourceLang ?? "").toLowerCase();
  if (CHAR_LANG.includes(lang)) {
    return Math.ceil((charCount || 0) / 700);
  }
  return Math.ceil((wordCount || 0) / 250);
}

// ─── OpenAI 분석 프롬프트 ────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are an expert quote analyst for VERITAS, a professional translation and interpretation company in Korea.

Your task is to analyze customer requests and generate structured quote draft rows.

CRITICAL RULES:
1. ONLY use products from the provided product list. Never invent product IDs or names.
2. Match the BEST product from the list based on service type and language pair.
3. If no product matches, set productId to null and add a warning.
4. Extract all dates, times, locations, word counts, character counts from the request.
5. For translation: use the matched product's sourceLanguage and targetLanguage.
6. Unit prices: use the product's basePrice. If 0 or null, set unitPrice to 0 and add "단가 확인 필요" warning.
7. Quantities for translation: calculate pages from char/word count. If unknown, set quantity to 1.
8. Return ONLY valid JSON, no explanation text.

LANGUAGE PAGE POLICIES (for quantity calculation):
- Character-based (ko, ja, zh-hans, zh-hant, th, mn): 700 chars = 1 page, round up
- Word-based (en, fr, de, es, it, pt, ru, etc.): 250 words = 1 page, round up
- If both charCount and wordCount are 0/unknown, set quantity to 1 with warning.

RESPONSE FORMAT (strict JSON only):
{
  "draftRows": [
    {
      "productId": <number|null>,
      "productName": "<string>",
      "productType": "<translation|interpretation|equipment|expense>",
      "quantity": <number>,
      "unit": "<string>",
      "unitPrice": <number>,
      "memo": "<string>",
      "sourceLanguage": "<lang code e.g. ko,en,ja>",
      "targetLanguage": "<lang code>",
      "fileName": "<string>",
      "fileFormat": "<string>",
      "wordCount": <number>,
      "charCount": <number>,
      "interpretDate": "<YYYY-MM-DD or empty>",
      "interpretEndDate": "<YYYY-MM-DD or empty>",
      "startTime": "<HH:MM or empty>",
      "endTime": "<HH:MM or empty>",
      "interpretPlace": "<string>",
      "interpreterCount": <number>,
      "eventStartDate": "<YYYY-MM-DD or empty>",
      "eventEndDate": "<YYYY-MM-DD or empty>",
      "itemLocation": "<string>",
      "usagePeriod": <number>,
      "expenseType": "<string>",
      "warnings": ["<warning strings>"],
      "needsReview": <boolean>
    }
  ],
  "warnings": ["<global warning strings>"],
  "confidence": "<high|medium|low>"
}`;
}

function buildUserMessage(
  requestText: string,
  filesInfo: string,
  products: Array<{
    id: number; name: string; productType: string;
    sourceLanguage: string | null; targetLanguage: string | null;
    unit: string; basePrice: number | null;
  }>,
): string {
  const productList = products.map(p => ({
    id: p.id,
    name: p.name,
    type: p.productType,
    src: p.sourceLanguage,
    tgt: p.targetLanguage,
    unit: p.unit,
    basePrice: p.basePrice ?? 0,
  }));

  return `## 고객 요청내용
${requestText || "(없음)"}

## 업로드 파일 정보
${filesInfo || "(없음)"}

## 사용 가능한 상품 목록 (이 목록에서만 선택할 것)
${JSON.stringify(productList, null, 2)}

위 정보를 분석하여 견적 초안 JSON을 생성하라.`;
}

// ─── 이미지/PDF 파일 → vision content 생성 ───────────────────────────────────

async function buildFileVisionContent(
  buffer: Buffer,
  originalName: string,
): Promise<{ type: "image_url"; image_url: { url: string } } | null> {
  const ext = path.extname(originalName).toLowerCase();
  try {
    let imgBuffer: Buffer;
    let imgExt: string;
    if (ext === ".pdf") {
      imgBuffer = await renderPdfFirstPageAsPng(buffer);
      imgExt = ".png";
    } else if ([".jpg", ".jpeg", ".png"].includes(ext)) {
      imgBuffer = buffer;
      imgExt = ext;
    } else {
      return null;
    }
    const dataUrl = buildImageDataUrl(imgBuffer, imgExt);
    return { type: "image_url", image_url: { url: dataUrl } };
  } catch {
    return null;
  }
}

// ─── POST /api/quotes/ai-draft ────────────────────────────────────────────────

router.post(
  "/quotes/ai-draft",
  ...adminGuard,
  aiUpload.array("files", 5),
  async (req, res) => {
    const requestText = (req.body.requestText as string) ?? "";
    const files = (req.files as Express.Multer.File[]) ?? [];

    if (!requestText.trim() && files.length === 0) {
      res.status(400).json({ error: "요청내용을 입력하거나 파일을 업로드해 주세요." });
      return;
    }

    // API 키 확인
    const openaiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!openaiApiKey) {
      res.status(500).json({ error: "AI 분석 기능을 사용할 수 없습니다. (OpenAI API 키 미설정)" });
      return;
    }

    try {
      // 활성 상품 목록 조회
      const products = await db
        .select({
          id: productsTable.id,
          name: productsTable.name,
          productType: productsTable.productType,
          sourceLanguage: productsTable.sourceLanguage,
          targetLanguage: productsTable.targetLanguage,
          unit: productsTable.unit,
          basePrice: productsTable.basePrice,
        })
        .from(productsTable)
        .where(and(eq(productsTable.active, true), isNull(productsTable.deletedAt)));

      // 파일 정보 텍스트 + vision content 준비
      const filesInfoParts: string[] = [];
      const visionContents: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      const fileWarnings: string[] = [];

      for (const file of files) {
        const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
        const ext = path.extname(originalName).toLowerCase();
        const sizeKb = Math.round(file.size / 1024);
        filesInfoParts.push(`- 파일명: ${originalName}, 형식: ${ext.replace(".", "").toUpperCase()}, 크기: ${sizeKb}KB`);

        if ([".pdf", ".jpg", ".jpeg", ".png"].includes(ext)) {
          const visionContent = await buildFileVisionContent(file.buffer, originalName);
          if (visionContent) {
            visionContents.push(visionContent);
          } else {
            fileWarnings.push(`${originalName}: 이미지 변환 실패 — 파일 정보만 참고합니다.`);
          }
        } else {
          filesInfoParts.push(`  (DOC/DOCX/XLS/XLSX/PPT/PPTX — 내용 분석 불가, 파일명·형식만 참고)`);
        }
      }

      const filesInfo = filesInfoParts.join("\n");

      // OpenAI 호출
      const openai = new OpenAI({
        apiKey: openaiApiKey,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userContent: any[] = [
        { type: "text", text: buildUserMessage(requestText, filesInfo, products) },
        ...visionContents,
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userContent },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      let aiResult: {
        draftRows?: unknown[];
        warnings?: string[];
        confidence?: string;
      } = {};
      try {
        aiResult = JSON.parse(raw);
      } catch {
        res.status(500).json({ error: "AI 응답 파싱에 실패했습니다. 다시 시도해 주세요." });
        return;
      }

      // draftRows 후처리: 수량 재계산 (페이지 정책 적용)
      const rawRows = (aiResult.draftRows ?? []) as Record<string, unknown>[];
      const draftRows = rawRows.map(row => {
        const r = row as {
          productId: number | null;
          productName: string;
          productType: string;
          quantity: number;
          unit: string;
          unitPrice: number;
          memo: string;
          sourceLanguage: string;
          targetLanguage: string;
          fileName: string;
          fileFormat: string;
          wordCount: number;
          charCount: number;
          interpretDate: string;
          interpretEndDate: string;
          startTime: string;
          endTime: string;
          interpretPlace: string;
          interpreterCount: number;
          eventStartDate: string;
          eventEndDate: string;
          itemLocation: string;
          usagePeriod: number;
          expenseType: string;
          warnings: string[];
          needsReview: boolean;
        };

        // 번역: 서버에서도 페이지 수 재계산해서 검증
        if (r.productType === "translation" && r.sourceLanguage) {
          const pages = calcPages(r.charCount ?? 0, r.wordCount ?? 0, r.sourceLanguage);
          if (pages > 0 && r.quantity !== pages) {
            r.quantity = pages;
          }
        }

        // 단가 0이면 경고 추가
        if (!r.unitPrice || r.unitPrice === 0) {
          r.warnings = [...(r.warnings ?? []), "단가 확인 필요"];
          r.needsReview = true;
        }

        // productId 미매칭 시 경고
        if (!r.productId) {
          r.warnings = [...(r.warnings ?? []), "상품 확인 필요"];
          r.needsReview = true;
        }

        return r;
      });

      res.json({
        draftRows,
        warnings: [...(aiResult.warnings ?? []), ...fileWarnings],
        confidence: aiResult.confidence ?? "medium",
      });
    } catch (err) {
      req.log.error({ err }, "AI 견적 분석 실패");
      res.status(500).json({ error: "AI 견적 생성 중 오류가 발생했습니다. 다시 시도해 주세요." });
    }
  },
);

// ─── POST /api/quotes ─────────────────────────────────────────────────────────

router.post("/quotes", requireAuth, async (req, res) => {
  const { projectId, price } = req.body as { projectId: unknown; price: unknown };

  if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId <= 0) {
    res.status(400).json({ error: "projectId는 양의 정수여야 합니다." });
    return;
  }
  if (typeof price !== "number" || price <= 0) {
    res.status(400).json({ error: "price는 양수여야 합니다." });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) {
    res.status(404).json({ error: `Project ${projectId} not found.` });
    return;
  }
  if (project.status !== "created") {
    res.status(400).json({
      error: `견적 생성은 "접수됨(created)" 상태에서만 가능합니다. 현재 상태: "${project.status}"`,
    });
    return;
  }

  const existingQuote = await db.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.projectId, projectId)).limit(1);
  if (existingQuote.length > 0) {
    res.status(400).json({ error: "이 프로젝트에 이미 견적이 존재합니다." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [quote] = await tx
        .insert(quotesTable)
        .values({ projectId, price: String(price) })
        .returning();
      await tx.update(projectsTable).set({ status: "quoted" }).where(eq(projectsTable.id, projectId));
      return quote;
    });
    await logEvent("quote", result.id, "quote_created", req.log);
    res.status(201).json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to create quote");
    res.status(400).json({ error: "견적 생성 실패." });
  }
});

// ─── POST /api/quotes/:id/approve ─────────────────────────────────────────────

router.post("/quotes/:id/approve", async (req, res) => {
  const quoteId = Number(req.params.id);
  if (isNaN(quoteId) || quoteId <= 0) {
    res.status(400).json({ error: "유효하지 않은 quote id." });
    return;
  }

  const [quote] = await db.select().from(quotesTable).where(eq(quotesTable.id, quoteId));
  if (!quote) {
    res.status(404).json({ error: `Quote ${quoteId} not found.` });
    return;
  }
  if (quote.status === "approved") {
    res.status(400).json({ error: "이미 승인된 견적입니다." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(quotesTable)
        .set({ status: "approved" })
        .where(eq(quotesTable.id, quoteId))
        .returning();
      await tx.update(projectsTable).set({ status: "approved" }).where(eq(projectsTable.id, quote.projectId));
      return updated;
    });
    await logEvent("quote", result.id, "quote_approved", req.log);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to approve quote");
    res.status(500).json({ error: "견적 승인 실패." });
  }
});

export default router;
