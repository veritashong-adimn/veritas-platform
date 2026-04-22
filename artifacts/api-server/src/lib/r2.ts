import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

// ── 환경변수 ──────────────────────────────────────────────────────────────────
export const R2_ACCOUNT_ID      = process.env.R2_ACCOUNT_ID ?? "";
export const R2_ACCESS_KEY_ID   = process.env.R2_ACCESS_KEY_ID ?? "";
export const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
export const bucketName         = process.env.R2_BUCKET_NAME ?? "";
// 퍼블릭 커스텀 도메인 (e.g. https://cdn.example.com) - 설정 시 공개 URL에 사용
export const R2_PUBLIC_DOMAIN   = (process.env.R2_PUBLIC_DOMAIN ?? "").replace(/\/$/, "");

export function isR2Configured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && bucketName);
}

// ── 클라이언트 (Lazy singleton) ───────────────────────────────────────────────
let _client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (!_client) {
    if (!isR2Configured()) {
      throw new Error(
        "R2 환경변수가 설정되지 않았습니다. R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME을 설정해주세요.",
      );
    }
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

// ── 업로드 ────────────────────────────────────────────────────────────────────

/** Buffer를 R2에 직접 업로드하고 공개 URL을 반환 */
export async function uploadToR2(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({ Bucket: bucketName, Key: key, Body: body, ContentType: contentType }),
  );
  return getR2PublicUrl(key);
}

/** 클라이언트 직접 업로드용 Presigned PUT URL 생성 */
export async function getPresignedUploadUrl(
  key: string,
  contentType?: string,
  ttlSec = 900,
): Promise<string> {
  const client = getR2Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucketName, Key: key, ContentType: contentType }),
    { expiresIn: ttlSec },
  );
}

/** 새 업로드용 UUID 기반 키 생성 후 Presigned PUT URL 반환 */
export async function createUploadPresignedUrl(ttlSec = 900): Promise<{ key: string; uploadUrl: string }> {
  const key = `uploads/${randomUUID()}`;
  const uploadUrl = await getPresignedUploadUrl(key, undefined, ttlSec);
  return { key, uploadUrl };
}

// ── 다운로드 ──────────────────────────────────────────────────────────────────

/** Presigned GET URL 생성 (비공개 파일용) */
export async function getPresignedDownloadUrl(key: string, ttlSec = 3600): Promise<string> {
  const client = getR2Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucketName, Key: key }),
    { expiresIn: ttlSec },
  );
}

/** R2에서 객체를 스트림으로 가져오기 */
export async function getR2ObjectStream(key: string): Promise<{
  body: ReadableStream;
  contentType: string;
  contentLength?: number;
}> {
  const client = getR2Client();
  const res = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  if (!res.Body) throw new Error("R2 응답 본문이 비어있습니다");
  return {
    body: res.Body.transformToWebStream(),
    contentType: res.ContentType ?? "application/octet-stream",
    contentLength: res.ContentLength,
  };
}

// ── 존재 확인 ─────────────────────────────────────────────────────────────────

export async function r2ObjectExists(key: string): Promise<boolean> {
  try {
    const client = getR2Client();
    await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// ── URL 헬퍼 ──────────────────────────────────────────────────────────────────

/** 공개 URL 반환 (커스텀 도메인 우선, 없으면 R2 기본 URL) */
export function getR2PublicUrl(key: string): string {
  if (R2_PUBLIC_DOMAIN) return `${R2_PUBLIC_DOMAIN}/${key}`;
  return `https://${bucketName}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;
}

/** Presigned URL 또는 R2 기본 URL에서 키 추출 */
export function extractKeyFromR2Url(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    // Presigned URL: /{bucketName}/{key} 또는 /{key}
    const withBucket = `/${bucketName}/`;
    if (pathname.startsWith(withBucket)) {
      return pathname.slice(withBucket.length);
    }
    return pathname.slice(1) || null;
  } catch {
    return null;
  }
}
