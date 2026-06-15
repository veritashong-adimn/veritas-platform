import { Storage } from "@google-cloud/storage";
import { randomUUID } from "node:crypto";
import path from "node:path";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const gcsClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  } as any,
  projectId: "",
});

function parsePrivateDir(): { bucketName: string; dirPrefix: string } {
  const privateDir = process.env.PRIVATE_OBJECT_DIR ?? "";
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR 환경변수가 설정되지 않았습니다.");
  const parts = privateDir.replace(/^\//, "").split("/");
  const bucketName = parts[0];
  const dirPrefix = parts.slice(1).join("/");
  return { bucketName, dirPrefix };
}

// ── 단계별 지원 형식 ──────────────────────────────────────────────────────────
// 1단계 (현재): PDF · DOC · DOCX · TXT
// 2단계 (예정): HWP · HWPX  (MIME 타입이 브라우저/OS마다 상이하므로 ext 검사 병행 필요)
// 3단계 (예정): JPG · PNG · 스캔 PDF OCR

export const STAGE1_EXTS = [".pdf", ".doc", ".docx", ".txt"] as const;
export const STAGE2_EXTS = [".hwp", ".hwpx"] as const;
// export const STAGE3_EXTS = [".jpg", ".jpeg", ".png"] as const;

export const ALLOWED_EXT: ReadonlyArray<string> = [...STAGE1_EXTS, ...STAGE2_EXTS];

export const ALLOWED_MIME = [
  "application/pdf",                                                                    // .pdf
  "application/msword",                                                                 // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",           // .docx
  "text/plain",                                                                         // .txt
  "application/haansofthwp",                                                           // .hwp (한컴 공식)
  "application/x-hwp",                                                                 // .hwp (비공식)
  "application/vnd.hancom.hwp",                                                        // .hwp (IANA 등록)
  "application/vnd.hancom.hwpx",                                                       // .hwpx
] as const;

export function isAllowedMime(mime: string): boolean {
  return (ALLOWED_MIME as readonly string[]).includes(mime);
}

export function isAllowedExt(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return ALLOWED_EXT.includes(ext);
}

export async function uploadResumeToGCS(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<string> {
  const { bucketName, dirPrefix } = parsePrivateDir();
  const ext = path.extname(originalName).toLowerCase() || ".pdf";
  const objectName = [dirPrefix, "resumes", `${randomUUID()}${ext}`]
    .filter(Boolean)
    .join("/");

  const bucket = gcsClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: mimeType, resumable: false });

  return `/${bucketName}/${objectName}`;
}

export async function deleteResumeFromGCS(storedPath: string): Promise<void> {
  const { bucketName } = parsePrivateDir();
  const prefix = `/${bucketName}/`;
  if (!storedPath.startsWith(prefix)) return;
  const objectName = storedPath.slice(prefix.length);
  try {
    const bucket = gcsClient.bucket(bucketName);
    await bucket.file(objectName).delete();
  } catch {
  }
}

export async function getResumeDownloadUrl(storedPath: string): Promise<string> {
  const { bucketName } = parsePrivateDir();
  const prefix = `/${bucketName}/`;
  if (!storedPath.startsWith(prefix)) throw new Error("Invalid object path");
  const objectName = storedPath.slice(prefix.length);

  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: "GET",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw new Error(`Sidecar presign failed: ${response.status}`);
  const { signed_url } = await response.json() as { signed_url: string };
  return signed_url;
}
