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

export const ALLOWED_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME.includes(mime);
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
