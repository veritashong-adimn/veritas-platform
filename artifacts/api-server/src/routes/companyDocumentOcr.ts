// ─── 거래처 증빙서류(사업자등록증/통장사본) OCR/AI 분석 — 등록화면 전용 ──────────
// 거래처 등록 시 문서를 직접 업로드해 AI로 분석하고 폼에 자동 반영하는 엔드포인트.
// DB 저장 없음; 분석 결과는 프론트 onApplied 콜백으로만 처리된다.
import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import path from "node:path";
import OpenAI from "openai";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  isOcrSupportedExt, buildImageDataUrl, buildOcrPromptMessages,
  renderPdfFirstPageAsPng, normalizeBankAccount, matchBankName, normalizeAccountHolder,
} from "../lib/documentOcr";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

type CompanyDocType = "business_license" | "bankbook";

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (isOcrSupportedExt(ext) || ["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("JPG, PNG, PDF 형식만 분석할 수 있습니다."));
    }
  },
});

function parseCompanyDocType(q: unknown): CompanyDocType | null {
  return q === "business_license" || q === "bankbook" ? q : null;
}

function sendError(res: Response, status: number, error: string, debug?: Record<string, unknown>) {
  res.status(status).json({ error, message: error, ...(debug ? { debug } : {}) });
}

// POST /api/admin/companies/document-analyze-upload?type=business_license|bankbook
router.post(
  "/admin/companies/document-analyze-upload",
  ...adminGuard,
  docUpload.single("file"),
  async (req, res) => {
    const docType = parseCompanyDocType(req.query.type);
    if (!docType) {
      sendError(res, 400, "type 파라미터는 business_license 또는 bankbook 이어야 합니다.");
      return;
    }
    const label = docType === "business_license" ? "사업자등록증" : "통장사본";

    if (!req.file) { sendError(res, 400, "파일이 없습니다. (필드명: file)"); return; }

    const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const ext = path.extname(originalName).toLowerCase();
    if (!isOcrSupportedExt(ext)) {
      sendError(res, 422, "OCR 분석은 JPG, PNG, PDF 형식만 지원합니다.", { ext });
      return;
    }

    try {
      const rawBuffer = req.file.buffer;
      let buffer: Buffer;
      let ocrExt: string;
      if (ext === ".pdf") {
        buffer = await renderPdfFirstPageAsPng(rawBuffer);
        ocrExt = ".png";
      } else {
        buffer = rawBuffer;
        ocrExt = ext;
      }

      const imageDataUrl = buildImageDataUrl(buffer, ocrExt);

      const openaiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
      if (!openaiApiKey) {
        req.log.error({ docType }, "AI_INTEGRATIONS_OPENAI_API_KEY 미설정");
        sendError(res, 500, `${label} AI 분석을 사용할 수 없습니다. (OpenAI API 키 미설정)`);
        return;
      }

      const openaiClient = new OpenAI({ apiKey: openaiApiKey, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: buildOcrPromptMessages(docType, imageDataUrl),
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      let result: Record<string, unknown> = {};
      let jsonParseFailed = false;
      try { result = JSON.parse(raw); } catch { result = {}; jsonParseFailed = true; }

      const confidence = (result.confidence as "high" | "medium" | "low") ?? "low";
      const notes = (result.notes as string) ?? null;

      let extracted: Record<string, unknown>;
      let current: Record<string, null>;
      let validations: Record<string, unknown>;

      if (docType === "business_license") {
        extracted = {
          name: (result.name as string) ?? null,
          businessNumber: (result.businessNumber as string) ?? null,
          representativeName: (result.representativeName as string) ?? null,
          registeredAt: (result.registeredAt as string) ?? null,
          industry: (result.industry as string) ?? null,
          businessCategory: (result.businessCategory as string) ?? null,
          address: (result.address as string) ?? null,
          vendorType: (result.vendorType as string) ?? null,
        };
        current = { name: null, businessNumber: null, representativeName: null, registeredAt: null, industry: null, businessCategory: null, address: null, vendorType: null };
        validations = {};
      } else {
        const { matched: matchedBankName, bankNameMatched } = matchBankName((result.bankName as string) ?? null);
        extracted = {
          bankName: matchedBankName,
          accountHolder: normalizeAccountHolder((result.accountHolder as string) ?? null),
          bankAccount: normalizeBankAccount((result.bankAccount as string) ?? null),
        };
        current = { bankName: null, accountHolder: null, bankAccount: null };
        validations = { bankNameMatched };
      }

      res.json({
        extracted, current, validations, confidence, notes,
        _debug: { fileName: originalName, sourceExt: ext, ocrExt, pdfConverted: ext === ".pdf", aiCalled: true, jsonParseFailed },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      req.log.error({ err, docType }, `${label} OCR 분석 실패`);
      sendError(res, 500, `${label} AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.`, { reason });
    }
  },
);

export default router;
