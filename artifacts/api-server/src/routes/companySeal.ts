/**
 * 회사 직인 관리(환경설정 > 공급자 정보) + 문서 출력용 직인 조회.
 *
 *  GET    /admin/company-seal           상태(등록 여부·견적서 표시 여부·관리 권한) — 관리자는 미리보기 포함
 *  GET    /admin/company-seal/document  견적서 출력용 직인(data URI) — 관리자·직원(견적서 작성 권한 범위)
 *  POST   /admin/company-seal           등록·교체(multipart "file", PNG 우선·JPEG 허용, 2MB) — 관리자만
 *  PATCH  /admin/company-seal           견적서 직인 표시 여부 { showOnQuote } — 관리자만
 *  DELETE /admin/company-seal           삭제 — 관리자만
 *
 *  R2 비공개 경로에만 저장하고 원본 URL·키는 응답에 넣지 않는다. 등록·교체·삭제·표시 변경은 감사로그(entity company #0 = 자사).
 */
import { Router, type IRouter, type Request } from "express";
import multer from "multer";
import { randomUUID, createHash } from "node:crypto";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { isR2Configured, uploadToR2, deleteFromR2 } from "../lib/r2";
import {
  SEAL_MAX_BYTES, parseSealRef, formatSealRef, isSealRef, detectSealImageType, loadSealDataUrl, forgetSealCache,
} from "../services/companySeal";

const router: IRouter = Router();
const staffGuard = [requireAuth, requireRole("admin", "staff")];
const adminOnly  = [requireAuth, requireRole("admin")];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SEAL_MAX_BYTES } });
const SELF_COMPANY_ID = 0;   // 감사로그 대상 — 자사(공급자). 거래처 id 와 겹치지 않음

async function currentSettings() {
  const [row] = await db.select({ id: settingsTable.id, signatureImageUrl: settingsTable.signatureImageUrl }).from(settingsTable).limit(1);
  return row ?? null;
}
async function saveSignatureValue(value: string | null) {
  const row = await currentSettings();
  if (row) await db.update(settingsTable).set({ signatureImageUrl: value, updatedAt: new Date() }).where(eq(settingsTable.id, row.id));
  else await db.insert(settingsTable).values({ signatureImageUrl: value });
}
const audit = (req: Request, action: string, meta: Record<string, unknown>) =>
  logEvent("company", SELF_COMPANY_ID, action, req.log, req.user ?? undefined, JSON.stringify({ event: action.toUpperCase(), ...meta }));

router.get("/admin/company-seal", ...staffGuard, async (req, res) => {
  try {
    const row = await currentSettings();
    const ref = parseSealRef(row?.signatureImageUrl);
    const canManage = req.user?.role === "admin";
    let preview: string | null = null;
    if (ref && canManage) { try { preview = await loadSealDataUrl(ref); } catch { preview = null; } }
    res.json({
      registered: !!ref, showOnQuote: ref?.showOnQuote ?? false, contentType: ref?.contentType ?? null,
      canManage, storageReady: isR2Configured(), previewDataUrl: preview,
      // 레거시: 예전에 URL 을 직접 입력한 서명 이미지가 있으면 알림용
      legacyUrl: row?.signatureImageUrl && !isSealRef(row.signatureImageUrl) ? true : false,
    });
  } catch (e) { req.log.error({ err: e }, "직인 상태 조회 실패"); res.status(500).json({ error: "직인 정보를 불러오지 못했습니다." }); }
});

router.get("/admin/company-seal/document", ...staffGuard, async (req, res) => {
  try {
    const row = await currentSettings();
    const v = row?.signatureImageUrl ?? null;
    const ref = parseSealRef(v);
    if (ref) {
      if (!ref.showOnQuote) { res.json({ dataUrl: null }); return; }
      try { res.json({ dataUrl: await loadSealDataUrl(ref) }); }
      catch (e) {   // 깨진 이미지 대신 직인 없이 출력 — 미리보기 화면에 안내(error)
        req.log.error({ err: e }, "직인 이미지 읽기 실패");
        res.json({ dataUrl: null, error: "직인 이미지를 불러오지 못했습니다." });
      }
      return;
    }
    // 레거시 URL(직접 입력) — 기존 동작대로 그 주소를 사용
    res.json({ dataUrl: v && /^https?:\/\//.test(v) ? v : null });
  } catch (e) { req.log.error({ err: e }, "직인 조회 실패"); res.status(500).json({ error: "직인 정보를 불러오지 못했습니다." }); }
});

router.post("/admin/company-seal", ...adminOnly, (req, res, next) => {
  if (!isR2Configured()) { res.status(503).json({ error: "파일 저장소(R2)가 설정되지 않아 직인을 등록할 수 없습니다." }); return; }
  upload.single("file")(req, res, err => {
    if (err) { res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "직인 이미지는 2MB 이하만 등록할 수 있습니다." : "파일을 읽지 못했습니다." }); return; }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "직인 이미지 파일을 선택해 주세요." }); return; }
  const type = detectSealImageType(file.buffer);
  if (!type) { res.status(400).json({ error: "PNG 또는 JPG 이미지만 등록할 수 있습니다(투명 배경 PNG 권장)." }); return; }
  try {
    const row = await currentSettings();
    const prev = parseSealRef(row?.signatureImageUrl);
    const key = `private/company-seal/${randomUUID()}.${type === "image/png" ? "png" : "jpg"}`;
    await uploadToR2(key, file.buffer, type);   // 반환되는 공개 URL 은 사용·저장하지 않는다
    // 교체 시 기존 표시 설정 유지(최초 등록은 표시)
    await saveSignatureValue(formatSealRef({ key, contentType: type, showOnQuote: prev ? prev.showOnQuote : true }));
    if (prev) { forgetSealCache(prev.key); try { await deleteFromR2(prev.key); } catch (e) { req.log.warn({ err: e }, "이전 직인 파일 삭제 실패(참조는 해제됨)"); } }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    await audit(req, prev ? "company_seal_replaced" : "company_seal_uploaded", { contentType: type, size: file.size, sha256, fileName: file.originalname });
    res.status(201).json({ registered: true, message: prev ? "직인 이미지를 교체했습니다." : "직인 이미지를 등록했습니다." });
  } catch (e) { req.log.error({ err: e }, "직인 등록 실패"); res.status(500).json({ error: "직인 이미지를 저장하지 못했습니다." }); }
});

router.patch("/admin/company-seal", ...adminOnly, async (req, res) => {
  const show = (req.body as { showOnQuote?: unknown })?.showOnQuote;
  if (typeof show !== "boolean") { res.status(400).json({ error: "showOnQuote(boolean)가 필요합니다." }); return; }
  try {
    const ref = parseSealRef((await currentSettings())?.signatureImageUrl);
    if (!ref) { res.status(404).json({ error: "등록된 직인이 없습니다." }); return; }
    if (ref.showOnQuote !== show) {
      await saveSignatureValue(formatSealRef({ ...ref, showOnQuote: show }));
      await audit(req, "company_seal_display_changed", { showOnQuote: show });
    }
    res.json({ showOnQuote: show });
  } catch (e) { req.log.error({ err: e }, "직인 표시 설정 실패"); res.status(500).json({ error: "설정을 저장하지 못했습니다." }); }
});

router.delete("/admin/company-seal", ...adminOnly, async (req, res) => {
  try {
    const ref = parseSealRef((await currentSettings())?.signatureImageUrl);
    if (!ref) { res.status(404).json({ error: "등록된 직인이 없습니다." }); return; }
    await saveSignatureValue(null);
    forgetSealCache(ref.key);
    try { await deleteFromR2(ref.key); } catch (e) { req.log.warn({ err: e }, "직인 파일 삭제 실패(참조는 해제됨)"); }
    await audit(req, "company_seal_deleted", { contentType: ref.contentType });
    res.json({ registered: false, message: "직인 이미지를 삭제했습니다." });
  } catch (e) { req.log.error({ err: e }, "직인 삭제 실패"); res.status(500).json({ error: "직인 이미지를 삭제하지 못했습니다." }); }
});

export default router;
