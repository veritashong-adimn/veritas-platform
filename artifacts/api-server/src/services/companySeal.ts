/**
 * 회사 직인(공급자 직인) — 견적서 공급자 정보 박스에 넣는 실제 직인 이미지.
 *
 *  · 저장: Cloudflare R2 비공개 경로 private/company-seal/{uuid}.{png|jpg}. 공개 URL 을 만들거나 내려주지 않는다.
 *  · 참조: 기존 settings.signature_image_url 컬럼에 내부 참조 문자열로 보관(DB 스키마 무변경).
 *      "r2seal:{key}?type=image/png&quote=1"  — quote: 견적서 직인 표시 여부(1/0)
 *    예전처럼 URL 이 직접 입력돼 있으면(레거시) 그 값을 그대로 둔다.
 *  · 문서 출력: 서버가 권한 확인 후 R2 에서 읽어 data URI 로 내려준다(미리보기·인쇄 PDF 가 같은 이미지 사용).
 */
import { getR2ObjectBuffer } from "../lib/r2";

const PREFIX = "r2seal:";
export const SEAL_MAX_BYTES = 2 * 1024 * 1024;

export interface SealRef { key: string; contentType: string; showOnQuote: boolean }

export function isSealRef(v: string | null | undefined): boolean {
  return !!v && v.startsWith(PREFIX);
}

export function parseSealRef(v: string | null | undefined): SealRef | null {
  if (!isSealRef(v)) return null;
  const [key, qs = ""] = v!.slice(PREFIX.length).split("?");
  const p = new URLSearchParams(qs);
  if (!key) return null;
  return { key, contentType: p.get("type") || "image/png", showOnQuote: p.get("quote") !== "0" };
}

export function formatSealRef(r: SealRef): string {
  return `${PREFIX}${r.key}?type=${encodeURIComponent(r.contentType)}&quote=${r.showOnQuote ? 1 : 0}`;
}

/** 화면·문서 응답용 — 내부 참조(R2 키)는 내보내지 않는다. 레거시 URL 은 그대로 */
export function publicSignatureValue(v: string | null | undefined): string | null {
  return isSealRef(v) ? null : (v ?? null);
}

/** PNG/JPEG 파일 시그니처 확인(확장자·MIME 만 믿지 않음) */
export function detectSealImageType(buf: Buffer): "image/png" | "image/jpeg" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

// 키별 data URI 캐시 — 교체 시 키가 바뀌므로 무효화가 필요 없다(삭제·교체 시 이전 키만 정리)
const cache = new Map<string, string>();
export function forgetSealCache(key: string): void { cache.delete(key); }

export async function loadSealDataUrl(ref: SealRef): Promise<string> {
  const hit = cache.get(ref.key);
  if (hit) return hit;
  const { body } = await getR2ObjectBuffer(ref.key);
  const type = detectSealImageType(body) ?? ref.contentType;
  const url = `data:${type};base64,${body.toString("base64")}`;
  cache.set(ref.key, url);
  return url;
}
