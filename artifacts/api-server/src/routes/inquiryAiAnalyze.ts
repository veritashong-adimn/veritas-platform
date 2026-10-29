/**
 * POST /api/admin/inquiries/ai-analyze
 *
 * 의뢰건 AI 분석 및 자동입력 파이프라인 (등록 전용 — DB 저장 없음):
 *   1. 자료 입력: 파일 업로드(복수) + 텍스트 붙여넣기
 *   2. 텍스트 추출 (이미지: 의뢰건 전용 전사 transcribeInquiryImage(detail:high) / 그 외: extractText 재사용)
 *      → 추출 원문은 응답 extractedText 로 돌려줘 사용자가 확인할 수 있게 한다.
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
import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { requireAuth, requireRole } from "../middlewares/auth";
import { extractText, type TextStats } from "../lib/textExtractor";
import { inArray } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { analyzeInquiry, transcribeInquiryImage, buildImageStrips, INQUIRY_AI_ENGINE, type VisionImg } from "../services/inquiryAiPipeline";
import { lookupExistingRecords, makeKnownCompanyChecker } from "../services/inquiryAnalysisLookup";

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

// ─── 개발환경 진단 저장 ─────────────────────────────────────────────────────
// 실제 업로드 이미지로만 재현되는 오류를 확인하기 위해, 개발환경(NODE_ENV≠production)에서만
// 분석에 사용한 원본 파일·붙여넣은 텍스트·전체 분석 결과(단계별 추적 포함)를 로컬 폴더에 남긴다.
// git 제외(.gitignore) · 최근 20건만 보관(KEEP 파일이 있는 폴더는 정리하지 않음) · 운영에서는 동작하지 않는다.
// 저장 위치는 INQUIRY_AI_DIAG_DIR 로 바꿀 수 있다(테스트 서버가 실제 진단 자료를 밀어내지 않도록). 저장 실패는 분석 응답에 영향 없음.
const DIAG_DIR = path.resolve(process.env.INQUIRY_AI_DIAG_DIR || path.join(process.cwd(), ".inquiry-ai-diagnostics"));
async function saveDiagnostics(files: Express.Multer.File[], pastedText: string, body: unknown): Promise<string | null> {
  if (process.env.NODE_ENV === "production") return null;
  try {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(DIAG_DIR, id);
    await mkdir(dir, { recursive: true });
    for (const [i, f] of files.entries()) {
      const safe = decodeName(f).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80);
      await writeFile(path.join(dir, `${i + 1}_${safe}`), f.buffer);
    }
    if (pastedText.trim()) await writeFile(path.join(dir, "pasted.txt"), pastedText, "utf8");
    await writeFile(path.join(dir, "result.json"), JSON.stringify(body, null, 2), "utf8");
    const all = (await readdir(DIAG_DIR)).sort();
    const prunable: string[] = [];
    for (const d of all) { try { await readdir(path.join(DIAG_DIR, d)).then(fs => { if (!fs.includes("KEEP")) prunable.push(d); }); } catch { /* 파일 등 무시 */ } }
    for (const old of prunable.slice(0, Math.max(0, prunable.length - 20))) await rm(path.join(DIAG_DIR, old), { recursive: true, force: true });
    console.log(`[INQUIRY-AI] 진단 저장: ${dir}`);
    return id;
  } catch (e) {
    console.error("[INQUIRY-AI] 진단 저장 실패(분석에는 영향 없음):", e);
    return null;
  }
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

    const IMAGE_EXTS = [".jpg", ".jpeg", ".png"];
    const stripsByFile = new Map<string, VisionImg[]>();   // 이미지 → 확대 조각(전사·표 판독 공용)
    for (const file of files) {
      const name = decodeName(file);
      try {
        // 이미지: 의뢰건 전용 전사(줄·라벨 보존, 추측 금지, detail:high). 붙여넣은 텍스트와 같은 분석 경로로 들어간다.
        const ext = path.extname(name).toLowerCase();
        let st: TextStats;
        if (IMAGE_EXTS.includes(ext) && openaiApiKey) {
          const strips = await buildImageStrips(file.buffer, ext);
          stripsByFile.set(name, strips);
          const text = await transcribeInquiryImage({ images: strips, apiKey: openaiApiKey, baseURL: openaiBaseURL });
          st = { ...(await extractText(Buffer.from(text, "utf8"), "transcript.txt")), method: "gpt4o-inquiry-transcribe" };
          if (!text.trim()) st.warning = "이미지에서 텍스트를 읽지 못했습니다.";
        } else {
          st = await extractText(file.buffer, name, openaiApiKey, openaiBaseURL);
          // 이미지(스캔) PDF — 텍스트 레이어가 없으면 1페이지를 이미지로 렌더링해 이미지 파일과 같은 전사 경로로 읽는다(추측 금지 전사)
          if (ext === ".pdf" && !st.text.trim() && openaiApiKey) {
            const { renderPdfFirstPageAsPng } = await import("../lib/documentOcr");
            const strips = await buildImageStrips(await renderPdfFirstPageAsPng(file.buffer), ".png");
            stripsByFile.set(name, strips);
            const text = await transcribeInquiryImage({ images: strips, apiKey: openaiApiKey, baseURL: openaiBaseURL });
            const multi = st.warning?.match(/총 (\d+)페이지/);
            st = { ...(await extractText(Buffer.from(text, "utf8"), "transcript.txt")), method: "pdf-image-transcribe",
              warning: `이미지(스캔) PDF — 텍스트 레이어가 없어 1페이지 이미지를 판독했습니다${multi ? `(2~${multi[1]}페이지는 판독하지 않음 — 필요하면 이미지로 올려 주세요)` : ""}.` };
            if (!text.trim()) st.warning = "이미지(스캔) PDF — 1페이지 이미지에서도 텍스트를 읽지 못했습니다. 원본을 확인해 주세요.";
          }
        }
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
            const strips = stripsByFile.get(name);
            if (strips) { visionContents.push(...strips); continue; }
            let buf = file.buffer;
            let imgExt = ext;
            if (ext === ".pdf") { buf = await renderPdfFirstPageAsPng(buf); imgExt = ".png"; }
            visionContents.push({ type: "image_url", image_url: { url: buildImageDataUrl(buf, imgExt), detail: "high" } });
          } catch { extractWarnings.push(`${name}: 이미지 변환 실패(텍스트만 사용)`); }
        }
      }
    } catch (e) { console.error("[INQUIRY-AI] documentOcr 로드 실패:", e); }

    // 내부 직원(관리자/스태프) 이름 — 고객담당자로 오인하지 않도록 대조용(읽기 전용)
    let internalNames: string[] = [];
    let internalEmails: string[] = [];
    try {
      const rows = await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(inArray(usersTable.role, ["admin", "staff"]));
      internalNames = rows.map(r => (r.name ?? "").trim()).filter(Boolean);
      internalEmails = rows.map(r => (r.email ?? "").trim()).filter(Boolean);
    } catch (e) { console.error("[INQUIRY-AI] 내부 직원 이름 조회 실패:", e); }

    // ── Step 3: ②분류 → ③원문 대조 → ④매핑 (services/inquiryAiPipeline) ─────────
    try {
      const out = await analyzeInquiry({
        pastedText, ocrText, visionContents, internalNames, internalEmails,
        apiKey: openaiApiKey, baseURL: openaiBaseURL, isKnownCompany: makeKnownCompanyChecker(),
      });
      // 기존 CRM 거래처·담당자(기존 연결 규칙) + 기존 의뢰건·프로젝트 후보 — 조회만, 생성·연결하지 않음
      const existing = await lookupExistingRecords(out.fields as Record<string, unknown>, out.emailContext.subjectLine);

      const warnings = [...out.warnings, ...extractWarnings];
      if (!openaiApiKey) {
        warnings.unshift("OpenAI 키 미설정 — 이미지 인식은 생략하고 텍스트에서만 자동추출했습니다. 결과를 확인하세요.");
      }

      console.log(`[INQUIRY-AI] done — structured=${out.debug.structured} matched=${out.debug.matchedCount} conf=${out.confidence} eq=${out.equipment.length}`);
      if (Object.keys(out.evidence).length > 0) {
        console.log("[INQUIRY-AI] evidence(필드별 근거):");
        for (const [k, v] of Object.entries(out.evidence)) console.log(`  ${k} ← "${String(v).slice(0, 120)}"`);
      }

      const body = {
        fields:      out.fields,
        equipment:   out.equipment,
        confidence:  out.confidence,
        warnings,
        // 추가 필드(기존 응답 키는 유지): 이미지/파일에서 추출한 원문, 주 언어 외 추가 언어 조합
        extractedText: fileStats.map(f => ({ name: f.name, method: f.stats.method, text: f.stats.text.slice(0, 8000) })),
        additionalLanguagePairs: out.additionalLanguagePairs,
        verification: out.verification,      // ③ 필드별 원문 대조 결과
        channelGuess: out.channelGuess,      // 접수경로 판정 근거
        emailDates:   out.emailDates,        // 메일 수신/발송 일시(자동입력 안 함 — 후보)
        receivedAtInfo: out.receivedAtInfo,  // 고객 접수일시 판정(확정/확인 필요/미기재) + 적용 후보
        dateFields:   out.dateFields,        // 날짜 항목 원문·정규화·연도 근거
        emailContext: out.emailContext,      // 업무 유형·메일 방향·고객사/담당자 판단 근거·베리타스 내부 담당자·회사 역할
        fieldConfidence: out.fieldConfidence, // 핵심 항목별 신뢰도
        crmMatch:     existing.crmMatch,     // 기존 CRM 거래처·담당자 연결 판정(읽기 전용, 기존 규칙)
        projectCandidates: existing.projectCandidates, // 기존 의뢰건·프로젝트 연결 후보(자동 연결 없음)
        // 단계별 추적(②분류 레이어·③제외 사유·이중 판독 불일치·④매핑) — 개발환경에서만 응답에 포함
        ...(process.env.NODE_ENV === "production" ? {} : { trace: out.trace }),
        evidence:    out.evidence,           // 필드별 근거(원문 라벨:값)
        sourceFields: out.sourceFields,      // Stage 1 원문 추출 결과(rawValue+sourceLabel, 검증/디버그용)
        debug: {
          structured:   out.debug.structured,
          matchedCount: out.debug.matchedCount,
          visionRows:   out.debug.visionRows,  // vision 이 이미지에서 읽은 라벨-값 행(원문 추적용)
          ocr: fileStats.map(f => ({ name: f.name, method: f.stats.method, text: f.stats.text.slice(0, 4000) })),
        },
        meta: { fileCount: files.length, perFile: perFileMeta, engine: INQUIRY_AI_ENGINE },
      };
      const diagnosticsId = await saveDiagnostics(files, pastedText, body);
      res.json(diagnosticsId ? { ...body, diagnosticsId } : body);
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
