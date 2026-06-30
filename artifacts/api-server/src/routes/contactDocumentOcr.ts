// ─── 담당자 명함/이메일서명 AI 분석 — 등록화면 전용 ───────────────────────────
// 명함, 이메일 서명, PDF를 업로드해 담당자 정보를 자동 추출하는 엔드포인트.
// DB 저장 없음; 분석 결과는 프론트 onApplied 콜백으로만 처리된다.
import { Router, type IRouter, type Response } from "express";
import multer from "multer";
import path from "node:path";
import OpenAI from "openai";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  isOcrSupportedExt, buildImageDataUrl, renderPdfFirstPageAsPng,
} from "../lib/documentOcr";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

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

function sendError(res: Response, status: number, error: string) {
  res.status(status).json({ error, message: error });
}

const CONTACT_CARD_SYSTEM_PROMPT = `당신은 명함, 이메일 서명, 연락처 이미지에서 담당자 정보를 추출하는 AI 도우미입니다.
이미지에서 명확하게 식별 가능한 정보만 추출하고, 추측하거나 임의로 생성하지 마세요.
다음 JSON 스키마로만 응답하세요:
{"name": string|null, "companyName": string|null, "department": string|null, "position": string|null, "email": string|null, "mobile": string|null, "officePhone": string|null, "memo": string|null, "confidence": "high"|"medium"|"low", "notes": string|null}
- name: 담당자 이름 (한글 또는 영문)
- companyName: 회사명/브랜드명 (명함에 표시된 그대로)
- department: 부서명 (팀, 본부, 사업부 포함)
- position: 직책/직위 (예: 과장, Manager, 팀장, 대리)
- email: 이메일 주소
- mobile: 휴대폰 번호 (숫자와 하이픈만. 예: "010-1234-5678"). Cell, Mobile, HP 등 표시 우선
- officePhone: 직장 전화번호 (숫자와 하이픈만. 예: "02-1234-5678"). Tel, 대표번호, 직통번호 포함
- memo: 위 항목 외 추가 정보 (SNS, 웹사이트, 기타 메모). 없으면 null
- confidence: 이미지 품질과 추출 확신도 ("high"=명확, "medium"=일부 불명확, "low"=대부분 불명확)
- notes: 흐릿함, 일부 가려짐 등 특이사항. 없으면 null
명함/서명이 아니거나 정보를 읽을 수 없으면 모든 필드를 null로, confidence는 "low"로 응답하세요.`;

// POST /api/admin/contacts/document-analyze-upload
router.post(
  "/admin/contacts/document-analyze-upload",
  ...adminGuard,
  docUpload.single("file"),
  async (req, res) => {
    console.log(`[CONTACT-OCR] 요청 수신 file=${req.file?.originalname ?? "없음"} ct="${(req.headers["content-type"] ?? "").slice(0, 80)}"`);
    if (!req.file) { sendError(res, 400, "파일이 없습니다. (필드명: file)"); return; }

    const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const ext = path.extname(originalName).toLowerCase();
    if (!isOcrSupportedExt(ext)) {
      sendError(res, 422, "AI 분석은 JPG, PNG, PDF 형식만 지원합니다.");
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
        req.log.error("AI_INTEGRATIONS_OPENAI_API_KEY 미설정");
        sendError(res, 500, "AI 분석을 사용할 수 없습니다. (OpenAI API 키 미설정)");
        return;
      }

      const openaiClient = new OpenAI({
        apiKey: openaiApiKey,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const completion = await openaiClient.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: [
          { role: "system", content: CONTACT_CARD_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "이 이미지에서 담당자 정보를 추출해 JSON으로 응답하세요." },
              { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
            ],
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      let result: Record<string, unknown> = {};
      let jsonParseFailed = false;
      try { result = JSON.parse(raw); } catch { result = {}; jsonParseFailed = true; }

      const confidence = (result.confidence as "high" | "medium" | "low") ?? "low";
      const notes = (result.notes as string) ?? null;

      const extracted = {
        name:        (result.name as string) ?? null,
        companyName: (result.companyName as string) ?? null,
        department:  (result.department as string) ?? null,
        position:    (result.position as string) ?? null,
        email:       (result.email as string) ?? null,
        mobile:      (result.mobile as string) ?? null,
        officePhone: (result.officePhone as string) ?? null,
        memo:        (result.memo as string) ?? null,
      };

      res.json({
        extracted,
        confidence,
        notes,
        _debug: { fileName: originalName, sourceExt: ext, ocrExt, pdfConverted: ext === ".pdf", aiCalled: true, jsonParseFailed },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "담당자 명함 OCR 분석 실패");
      sendError(res, 500, `담당자 정보 AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.`);
      void reason;
    }
  },
);

export default router;
