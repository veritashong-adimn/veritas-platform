/**
 * 비교견적 업체 로고·직인(서명) 이미지 — 회사 직인(companySeal)과 같은 방식.
 *
 *  · 저장: R2 비공개 경로 private/comparison-vendor/{uuid}.{png|jpg}. 공개 URL 을 만들거나 내려주지 않는다.
 *  · 참조: DB 에는 내부 참조 문자열만 보관 — "r2cq:{key}?type=image/png"
 *      comparison_quote_vendors.logo_ref / stamp_ref (Master)
 *      comparison_quotes.logo_url / stamp_ref         (생성 시점 스냅샷)
 *  · 교체·삭제 시 R2 객체를 지우지 않는다 — 이미 생성된 비교견적 스냅샷이 같은 객체를 참조할 수 있기 때문.
 *  · 출력: 서버가 권한 확인 후 R2 에서 읽어 data URI 로 내려준다(미리보기·인쇄 PDF 가 같은 이미지 사용).
 *  · 실제 등록된 이미지만 사용한다. 이미지를 생성·합성하지 않는다.
 */
import { getR2ObjectBuffer } from "../lib/r2";
import { detectSealImageType } from "./companySeal";

const PREFIX = "r2cq:";
export const CQ_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export { detectSealImageType as detectCqImageType };

export interface CqImageRef { key: string; contentType: string }

export function isCqImageRef(v: string | null | undefined): boolean {
  return !!v && v.startsWith(PREFIX);
}

export function parseCqImageRef(v: string | null | undefined): CqImageRef | null {
  if (!isCqImageRef(v)) return null;
  const [key, qs = ""] = v!.slice(PREFIX.length).split("?");
  if (!key) return null;
  return { key, contentType: new URLSearchParams(qs).get("type") || "image/png" };
}

export function formatCqImageRef(r: CqImageRef): string {
  return `${PREFIX}${r.key}?type=${encodeURIComponent(r.contentType)}`;
}

/** API 응답용 — 내부 참조(R2 키)는 숨기고, 레거시 http(s) URL 만 그대로 노출. */
export function publicImageValue(v: string | null | undefined): string | null {
  if (!v) return null;
  if (isCqImageRef(v)) return null;
  return /^https?:\/\//.test(v) ? v : null;
}

const cache = new Map<string, string>();

/** 참조 → data URI. 레거시 http(s) URL 은 그대로, 참조가 없거나 읽기 실패면 null(이미지 없이 출력). */
export async function loadCqImage(v: string | null | undefined): Promise<{ dataUrl: string | null; error: boolean }> {
  if (!v) return { dataUrl: null, error: false };
  const ref = parseCqImageRef(v);
  if (!ref) return { dataUrl: /^https?:\/\//.test(v) ? v : null, error: false };
  const hit = cache.get(ref.key);
  if (hit) return { dataUrl: hit, error: false };
  try {
    const { body } = await getR2ObjectBuffer(ref.key);
    const type = detectSealImageType(body) ?? ref.contentType;
    const url = `data:${type};base64,${body.toString("base64")}`;
    cache.set(ref.key, url);
    return { dataUrl: url, error: false };
  } catch {
    return { dataUrl: null, error: true };
  }
}
