// ─── 증빙서류(신분증/통장사본) OCR/AI 분석 — Preview 전용 + 승인 반영 ──────────
// 처리 흐름: 업로드(translators.ts) → 분석(document-analyze, DB 미반영)
//          → 관리자 검수 → 승인(document-apply, 이때만 DB 반영) → 감사로그 기록
//
// 주민등록번호·계좌번호 원문은 어떤 로그에도 남기지 않는다 (logEvent에는 마스킹된 값만 전달).
// 모든 실패 응답은 { error, message, debug? } 형태의 JSON으로 통일한다 (프론트가 .json()으로
// 파싱하므로, 라우트가 매칭되지 않거나 예외가 던져져도 절대 HTML이 내려가서는 안 됨 — app.ts의
// "/api" 404 핸들러 및 전역 에러 핸들러가 동일한 형태로 한 번 더 방어한다).
import { Router, type IRouter, type Response } from "express";
import {
  db, usersTable, translatorProfilesTable, translatorSensitiveTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import path from "node:path";
import OpenAI from "openai";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";
import { encrypt, decrypt, maskResidentNumber } from "../lib/encrypt";
import { getResumeDownloadUrl } from "../lib/gcsResume";
import { logEvent } from "../lib/logEvent";
import {
  type DocType, isOcrSupportedExt, buildImageDataUrl, buildOcrPromptMessages,
  renderPdfFirstPageAsPng,
  normalizeResidentNumber, normalizeBankAccount, matchBankName, namesMatch, maskForLog,
} from "../lib/documentOcr";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const sensitiveGuard = [...adminGuard, requirePermission("translator.sensitive")];

function docLabel(type: DocType): string {
  return type === "id_card" ? "신분증" : "통장사본";
}

function parseDocType(req: { query: { type?: unknown } }): DocType | null {
  const t = req.query.type;
  return t === "id_card" || t === "bankbook" ? t : null;
}

/** 모든 실패 응답을 { error, message, debug? } 형태로 통일 */
function sendError(res: Response, status: number, error: string, debug?: Record<string, unknown>) {
  res.status(status).json({ error, message: error, ...(debug ? { debug } : {}) });
}

// ─── 분석 (Preview 전용 — DB 저장 없음) ──────────────────────────────────────
router.post("/admin/translators/:id/document-analyze", ...sensitiveGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { sendError(res, 400, "유효하지 않은 user id."); return; }
  const docType = parseDocType(req);
  if (!docType) { sendError(res, 400, "type 파라미터는 id_card 또는 bankbook 이어야 합니다."); return; }
  const label = docLabel(docType);

  try {
    const [user] = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.role, "translator")));
    if (!user) { sendError(res, 404, "통번역사를 찾을 수 없습니다."); return; }

    const [sensitive] = await db
      .select()
      .from(translatorSensitiveTable)
      .where(eq(translatorSensitiveTable.translatorId, userId));

    const storedPath = docType === "id_card" ? sensitive?.idCardUrl : sensitive?.bankbookUrl;
    const fileName = docType === "id_card" ? sensitive?.idCardFileName : sensitive?.bankbookFileName;
    if (!storedPath) { sendError(res, 400, `등록된 ${label}이 없습니다. 먼저 파일을 업로드해 주세요.`); return; }

    const ext = path.extname(storedPath).toLowerCase();
    if (!isOcrSupportedExt(ext)) {
      sendError(res, 422, "OCR 분석은 JPG, PNG, PDF 형식만 지원합니다. 지원하지 않는 파일 형식입니다.", { ext });
      return;
    }

    const signedUrl = await getResumeDownloadUrl(storedPath);
    const fileRes = await fetch(signedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!fileRes.ok) throw new Error(`파일 다운로드 실패: HTTP ${fileRes.status}`);
    const rawBuffer = Buffer.from(await fileRes.arrayBuffer());

    // PDF → PNG 렌더링 (스캔본 신분증/통장사본 대응; 텍스트 추출 방식 사용 안 함)
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
      req.log.error({ userId, docType }, "AI_INTEGRATIONS_OPENAI_API_KEY 미설정");
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
    let current: Record<string, unknown>;
    let validations: Record<string, unknown>;

    if (docType === "id_card") {
      const [profile] = await db
        .select({ region: translatorProfilesTable.region })
        .from(translatorProfilesTable)
        .where(eq(translatorProfilesTable.userId, userId));

      const { normalized: residentNumberNormalized, valid: residentNumberValid } =
        normalizeResidentNumber((result.residentNumber as string) ?? null);
      const extractedName = (result.name as string) ?? null;

      extracted = {
        name: extractedName,
        residentNumber: residentNumberNormalized,
        address: (result.address as string) ?? null,
      };
      current = {
        name: user.name,
        address: profile?.region ?? null,
        residentNumberMasked: sensitive?.residentNumber ? maskResidentNumber(decrypt(sensitive.residentNumber)) : null,
      };
      validations = {
        nameMismatch: !namesMatch(extractedName, user.name),
        residentNumberValid,
      };
    } else {
      const extractedAccountHolder = (result.accountHolder as string) ?? null;
      const { matched: matchedBankName, bankNameMatched } = matchBankName((result.bankName as string) ?? null);

      extracted = {
        bankName: matchedBankName,
        accountHolder: extractedAccountHolder,
        bankAccount: normalizeBankAccount((result.bankAccount as string) ?? null),
      };
      current = {
        bankName: sensitive?.bankName ?? null,
        accountHolder: sensitive?.accountHolder ?? null,
        bankAccount: sensitive?.bankAccount ?? null,
      };
      validations = {
        accountHolderMismatch: !namesMatch(extractedAccountHolder, user.name),
        bankNameMatched,
      };
    }

    // 감사로그 — 추출값 원문은 절대 포함하지 않음
    await logEvent(
      "translator", userId, `document.${docType}.analyzed`, req.log, req.user,
      JSON.stringify({ docType, fileName, confidence }),
    );

    res.json({
      extracted, current, validations, confidence, notes,
      _debug: { fileName, sourceExt: ext, ocrExt, pdfConverted: ext === ".pdf", aiCalled: true, jsonParseFailed },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    req.log.error({ err, userId, docType }, `${label} OCR 분석 실패`);
    sendError(res, 500, `${label} AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.`, { reason });
  }
});

// ─── 승인 반영 (관리자 승인 시점에만 DB 저장 + 감사로그) ─────────────────────
router.post("/admin/translators/:id/document-apply", ...sensitiveGuard, async (req, res) => {
  const userId = Number(req.params.id);
  if (isNaN(userId) || userId <= 0) { sendError(res, 400, "유효하지 않은 user id."); return; }
  const docType = parseDocType(req);
  if (!docType) { sendError(res, 400, "type 파라미터는 id_card 또는 bankbook 이어야 합니다."); return; }
  const label = docLabel(docType);

  try {
    const [user] = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.role, "translator")));
    if (!user) { sendError(res, 404, "통번역사를 찾을 수 없습니다."); return; }

    const changedFields: string[] = [];
    const maskedSummary: Record<string, string | null> = {};
    const responsePayload: Record<string, unknown> = {};

    if (docType === "id_card") {
      const { name, address, residentNumber } = req.body as {
        name?: string; address?: string; residentNumber?: string;
      };

      if (typeof name === "string" && name.trim()) {
        const trimmed = name.trim();
        await db.update(usersTable).set({ name: trimmed }).where(eq(usersTable.id, userId));
        changedFields.push("name");
        maskedSummary.name = maskForLog(trimmed);
        responsePayload.name = trimmed;
      }

      if (typeof address === "string" && address.trim()) {
        const trimmed = address.trim();
        const [existingProfile] = await db
          .select({ id: translatorProfilesTable.id })
          .from(translatorProfilesTable)
          .where(eq(translatorProfilesTable.userId, userId));
        if (!existingProfile) {
          await db.insert(translatorProfilesTable).values({ userId, region: trimmed });
        } else {
          await db.update(translatorProfilesTable)
            .set({ region: trimmed, updatedAt: new Date() })
            .where(eq(translatorProfilesTable.userId, userId));
        }
        changedFields.push("address");
        maskedSummary.address = maskForLog(trimmed);
        responsePayload.address = trimmed;
      }

      if (typeof residentNumber === "string" && residentNumber.trim()) {
        const { normalized, valid } = normalizeResidentNumber(residentNumber);
        if (!valid || !normalized) {
          sendError(res, 400, "주민등록번호 형식이 올바르지 않습니다. (13자리 숫자 필요)"); return;
        }
        const encrypted = encrypt(normalized.replace(/-/g, ""));
        const [existingSensitive] = await db
          .select({ id: translatorSensitiveTable.id })
          .from(translatorSensitiveTable)
          .where(eq(translatorSensitiveTable.translatorId, userId));
        if (!existingSensitive) {
          await db.insert(translatorSensitiveTable).values({ translatorId: userId, residentNumber: encrypted });
        } else {
          await db.update(translatorSensitiveTable)
            .set({ residentNumber: encrypted, updatedAt: new Date() })
            .where(eq(translatorSensitiveTable.translatorId, userId));
        }
        changedFields.push("residentNumber");
        maskedSummary.residentNumber = maskResidentNumber(normalized);
        responsePayload.residentNumberMasked = maskResidentNumber(normalized);
      }
    } else {
      const { bankName, accountHolder, bankAccount } = req.body as {
        bankName?: string; accountHolder?: string; bankAccount?: string;
      };

      const updateFields: Record<string, string> = {};
      if (typeof bankName === "string" && bankName.trim()) updateFields.bankName = bankName.trim();
      if (typeof accountHolder === "string" && accountHolder.trim()) updateFields.accountHolder = accountHolder.trim();
      if (typeof bankAccount === "string" && bankAccount.trim()) {
        const normalized = normalizeBankAccount(bankAccount);
        if (normalized) updateFields.bankAccount = normalized;
      }

      if (Object.keys(updateFields).length > 0) {
        const [existingSensitive] = await db
          .select({ id: translatorSensitiveTable.id })
          .from(translatorSensitiveTable)
          .where(eq(translatorSensitiveTable.translatorId, userId));
        if (!existingSensitive) {
          await db.insert(translatorSensitiveTable).values({ translatorId: userId, ...updateFields });
        } else {
          await db.update(translatorSensitiveTable)
            .set({ ...updateFields, updatedAt: new Date() })
            .where(eq(translatorSensitiveTable.translatorId, userId));
        }
        for (const [k, v] of Object.entries(updateFields)) {
          changedFields.push(k);
          maskedSummary[k] = maskForLog(v);
          responsePayload[k] = v;
        }
      }
    }

    if (changedFields.length === 0) {
      sendError(res, 400, "반영할 항목이 없습니다."); return;
    }

    await logEvent(
      "translator", userId, `document.${docType}.approved`, req.log, req.user,
      JSON.stringify({ docType, fields: changedFields, masked: maskedSummary }),
    );

    res.json({ ok: true, applied: changedFields, ...responsePayload });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    req.log.error({ err, userId, docType }, `${label} 승인 반영 실패`);
    sendError(res, 500, `${label} 승인 반영 중 오류가 발생했습니다.`, { reason });
  }
});

export default router;
