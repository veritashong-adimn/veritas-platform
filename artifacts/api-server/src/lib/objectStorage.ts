/**
 * objectStorage.ts — Cloudflare R2 기반 오브젝트 스토리지 서비스
 * Google Cloud Storage 의존성 완전 제거, R2 단일 구현
 */
import { randomUUID } from "node:crypto";
import {
  isR2Configured,
  getR2Client,
  bucketName,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  getR2ObjectStream,
  r2ObjectExists,
  getR2PublicUrl,
  extractKeyFromR2Url,
} from "./r2";

// ── 내부 타입 (GCS File 대체) ─────────────────────────────────────────────────
export type R2Object = { key: string };

// ── 에러 ──────────────────────────────────────────────────────────────────────
export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// ── 서비스 ────────────────────────────────────────────────────────────────────
export class ObjectStorageService {

  /** R2 설정 여부 확인 */
  isConfigured(): boolean {
    return isR2Configured();
  }

  // ── 업로드 URL 생성 ─────────────────────────────────────────────────────────

  /** 클라이언트 직접 업로드용 Presigned PUT URL 반환 */
  async getObjectEntityUploadURL(): Promise<string> {
    if (!isR2Configured()) {
      throw new Error("R2 환경변수가 설정되지 않았습니다. R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME을 설정해주세요.");
    }
    const key = `uploads/${randomUUID()}`;
    return getPresignedUploadUrl(key, undefined, 900);
  }

  // ── 경로 정규화 ─────────────────────────────────────────────────────────────

  /**
   * Presigned URL 또는 R2 public URL을 내부 경로 (/objects/{key})로 변환.
   * 이미 내부 경로이면 그대로 반환.
   */
  normalizeObjectEntityPath(rawPath: string): string {
    if (rawPath.startsWith("/objects/") || rawPath.startsWith("/")) {
      return rawPath;
    }
    // R2 URL에서 키 추출
    const key = extractKeyFromR2Url(rawPath);
    if (key) return `/objects/${key}`;
    return rawPath;
  }

  // ── 공개 오브젝트 검색 ──────────────────────────────────────────────────────

  /**
   * public/{filePath} 키로 R2 오브젝트가 존재하는지 확인.
   * 존재하면 R2Object 반환, 없으면 null.
   */
  async searchPublicObject(filePath: string): Promise<R2Object | null> {
    const key = `public/${filePath}`;
    const exists = await r2ObjectExists(key);
    return exists ? { key } : null;
  }

  // ── 다운로드 ────────────────────────────────────────────────────────────────

  /**
   * R2Object를 스트림으로 다운로드.
   * ttlSec: 이 메서드에서는 사용되지 않음(스트림 직접 반환), 호환성 유지용 파라미터.
   */
  async downloadObject(obj: R2Object, _ttlSec = 3600): Promise<Response> {
    const { body, contentType, contentLength } = await getR2ObjectStream(obj.key);
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    };
    if (contentLength != null) {
      headers["Content-Length"] = String(contentLength);
    }
    return new Response(body, { headers });
  }

  // ── 프라이빗 오브젝트 조회 ──────────────────────────────────────────────────

  /**
   * /objects/{key} 형태의 내부 경로로 R2Object 반환.
   * 존재하지 않으면 ObjectNotFoundError.
   */
  async getObjectEntityFile(objectPath: string): Promise<R2Object> {
    // 경로 형식: /objects/{key} 또는 uploads/{uuid}
    let key: string;
    if (objectPath.startsWith("/objects/")) {
      key = objectPath.slice("/objects/".length);
    } else if (objectPath.startsWith("/")) {
      key = objectPath.slice(1);
    } else {
      key = objectPath;
    }

    if (!key) throw new ObjectNotFoundError();

    const exists = await r2ObjectExists(key);
    if (!exists) throw new ObjectNotFoundError();

    return { key };
  }

  // ── ACL / 다운로드 URL (호환성) ─────────────────────────────────────────────

  /** Presigned GET URL 반환 (직접 다운로드 링크가 필요할 때) */
  async getSignedDownloadUrl(key: string, ttlSec = 3600): Promise<string> {
    return getPresignedDownloadUrl(key, ttlSec);
  }

  /** 공개 URL 반환 */
  getPublicUrl(key: string): string {
    return getR2PublicUrl(key);
  }
}
