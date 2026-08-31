/**
 * POST /api/admin/inquiries/ai-analyze
 *
 * 의뢰건 AI 분석 및 자동입력 파이프라인 (등록 전용 — DB 저장 없음):
 *   1. 자료 입력: 파일 업로드(복수) + 텍스트 붙여넣기
 *   2. 텍스트 추출 (extractText 재사용 — pdf/docx/hwp/xlsx/txt/이미지 OCR 등)
 *   3. 이미지·PDF 첫 페이지 vision 컨텍스트 (스캔본/레이아웃 인식 보강)
 *   4. analyzeInquiry(services/inquiryAiPipeline): 원문 → sourceFields → VERITAS 폼 필드 매핑
 *   5. 분석 결과 반환 (프론트가 폼에 자동입력, PM 검토/수정 후 직접 등록)
 *
 * ⚠ 이 엔드포인트는 "분석"만 한다. 의뢰건을 자동으로 등록/저장하지 않는다.
 *    실제 등록은 기존 POST /api/admin/inquiries (PM 수동 트리거)로만 이루어진다.
 *
 * 실제 추출/매핑 로직은 services/inquiryAiPipeline.ts 에 있으며, 오프라인 검증 하니스와 동일 코드를 공유한다.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import path from "node:path";
import { requireAuth, requireRole } from "../middlewares/auth";
import { extractText, type TextStats } from "../lib/textExtractor";
import { analyzeInquiry, type VisionImg } from "../services/inquiryAiPipeline";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ─── multer ─────────────────────────────────────────────────────────────────
// 요구사항: 이미지/PDF/Word/HWP/HWPX/Excel/TXT 및 복수 파일 지원
const ALLOWED_EXTS = [
  ".pdf", ".jpg", ".jpeg", ".png",
  ".doc", ".docx", ".txt", ".ppt", ".pptx",
  ".xls", ".xlsx", ".hwp", ".hwpx",
];

const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ALLOWED_EXTS.includes(ext));
  },
});

interface FileStat { name: string; stats: TextStats; }

// ─── 파일명 UTF-8 복원 ───────────────────────────────────────────────────────
function decodeName(f: Express.Multer.File): string {
  try { return Buffer.from(f.originalname, "latin1").toString("utf8"); }
  catch { return f.originalname; }
}

// ─── POST /admin/inquiries/ai-analyze ────────────────────────────────────────

router.post(
  "/admin/inquiries/ai-analyze",
  ...adminGuard,
  (req, res, next) => {
    aiUpload.array("files", 10)(req, res, (err) => {
      if (err) console.error("[INQUIRY-AI] multer error:", err);
      next();
    });
  },
  async (req, res) => {
    const pastedText = (req.body?.text as string) ?? "";
    const files      = (req.files as Express.Multer.File[] | undefined) ?? [];

    console.log(`[INQUIRY-AI] POST ai-analyze  text=${pastedText.length}ch files=${files.length}`);

    if (!pastedText.trim() && files.length === 0) {
      res.status(400).json({ error: "분석할 텍스트를 입력하거나 파일을 업로드해 주세요." });
      return;
    }

    const openaiApiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    const openaiBaseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

    // ── Step 1: 파일별 텍스트 추출 (extractText 재사용) ────────────────────────
    const fileStats:       FileStat[] = [];
    const extractWarnings: string[]   = [];
    const perFileMeta: Array<{ name: string; chars: number; method: string; warning?: string }> = [];

    for (const file of files) {
      const name = decodeName(file);
      try {
        const st = await extractText(file.buffer, name, openaiApiKey, openaiBaseURL);
        fileStats.push({ name, stats: st });
        perFileMeta.push({ name, chars: st.charCountWithSpace, method: st.method, warning: st.warning });
        if (st.warning) extractWarnings.push(`${name}: ${st.warning}`);
        console.log(`[INQUIRY-AI]   extracted ${name} (${st.method}, ${st.charCountWithSpace}ch)`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        extractWarnings.push(`${name}: 텍스트 추출 실패 (${msg.slice(0, 80)})`);
        perFileMeta.push({ name, chars: 0, method: "error", warning: msg.slice(0, 80) });
      }
    }

    // 결정론적 파싱/semantic 추출에 쓸 "라벨:값" 텍스트 소스(파일별 OCR 텍스트).
    const ocrText = fileStats
      .map(({ name, stats }) => {
        const fmt = path.extname(name).replace(".", "").toUpperCase();
        const body = stats.text.trim().length > 0
          ? stats.text.slice(0, 8000)
          : "(텍스트 추출 불가 — 이미지/스캔본일 수 있음)";
        return `### 파일: ${name} (${fmt})\n${body}`;
      })
      .join("\n\n---\n\n");

    // ── Step 2: vision 컨텍스트(이미지/PDF 첫 페이지). detail:"high" 로 표/작은 글자 판독력 향상 ──
    const visionContents: VisionImg[] = [];
    try {
      const { renderPdfFirstPageAsPng, buildImageDataUrl } = await import("../lib/documentOcr");
      for (const file of files) {
        const name = decodeName(file);
        const ext  = path.extname(name).toLowerCase();
        if ([".jpg", ".jpeg", ".png", ".pdf"].includes(ext)) {
          try {
            let buf = file.buffer;
            let imgExt = ext;
            if (ext === ".pdf") { buf = await renderPdfFirstPageAsPng(buf); imgExt = ".png"; }
            visionContents.push({ type: "image_url", image_url: { url: buildImageDataUrl(buf, imgExt), detail: "high" } });
          } catch { extractWarnings.push(`${name}: 이미지 변환 실패(텍스트만 사용)`); }
        }
      }
    } catch (e) { console.error("[INQUIRY-AI] documentOcr 로드 실패:", e); }

    // ── Step 3: 추출 → 매핑 (services/inquiryAiPipeline) ──────────────────────
    try {
      const out = await analyzeInquiry({
        pastedText, ocrText, visionContents,
        apiKey: openaiApiKey, baseURL: openaiBaseURL,
      });

      const warnings = [...out.warnings, ...extractWarnings];
      if (!openaiApiKey) {
        warnings.unshift("OpenAI 키 미설정 — 이미지 인식은 생략하고 텍스트에서만 자동추출했습니다. 결과를 확인하세요.");
      }

      console.log(`[INQUIRY-AI] done — structured=${out.debug.structured} matched=${out.debug.matchedCount} conf=${out.confidence} eq=${out.equipment.length}`);
      if (Object.keys(out.evidence).length > 0) {
        console.log("[INQUIRY-AI] evidence(필드별 근거):");
        for (const [k, v] of Object.entries(out.evidence)) console.log(`  ${k} ← "${String(v).slice(0, 120)}"`);
      }

      res.json({
        fields:      out.fields,
        equipment:   out.equipment,
        confidence:  out.confidence,
        warnings,
        evidence:    out.evidence,           // 필드별 근거(원문 라벨:값)
        sourceFields: out.sourceFields,      // Stage 1 원문 추출 결과(rawValue+sourceLabel, 검증/디버그용)
        debug: {
          structured:   out.debug.structured,
          matchedCount: out.debug.matchedCount,
          visionRows:   out.debug.visionRows,  // vision 이 이미지에서 읽은 라벨-값 행(원문 추적용)
          ocr: fileStats.map(f => ({ name: f.name, method: f.stats.method, text: f.stats.text.slice(0, 4000) })),
        },
        meta: { fileCount: files.length, perFile: perFileMeta },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[INQUIRY-AI] 분석 실패:", reason);
      // 실패해도 등록 흐름은 유지 — 빈 필드 + 경고만 반환(자동 등록 없음)
      res.json({
        fields:     {},
        equipment:  [],
        confidence: "low",
        warnings:   [`AI 분석 오류: ${reason.slice(0, 120)}`, ...extractWarnings],
        meta:       { fileCount: files.length, perFile: perFileMeta },
      });
    }
  },
);

export default router;
