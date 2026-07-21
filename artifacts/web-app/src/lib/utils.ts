import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 전화번호 표시 포맷(플랫폼 공통 Utility). DB 값은 변경하지 않고 화면 표시·입력 보조용으로만 사용한다.
 * 국내 번호 규칙과 맞는 경우에만 하이픈을 자동 삽입한다.
 *   01012345678 → 010-1234-5678 · 0101234567 → 010-123-4567
 *   0212345678  → 02-1234-5678   · 021234567  → 02-123-4567
 *   0325552491  → 032-555-2491   · 15881234   → 1588-1234
 * 국제번호(+..)나 내선/문자가 섞인 값은 원래 의미를 유지하기 위해 원문 그대로 반환한다(§7).
 */
export function formatPhoneNumber(value: string | null | undefined): string {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";

  // 국제번호(+82 …) 또는 내선/문자 포함(02-123-4567 내선123 등) → 원문 유지
  if (raw.startsWith("+")) return raw;
  if (/[A-Za-z가-힣]/.test(raw)) return raw;

  const d = raw.replace(/\D/g, "");
  if (!d) return raw;

  // 대표번호(1로 시작하는 8자리: 1588/1600/1877 등) → 4-4
  if (d.length === 8 && d.startsWith("1")) return `${d.slice(0, 4)}-${d.slice(4)}`;

  // 서울 지역번호(02): 02-XXX(X)-XXXX
  if (d.startsWith("02")) {
    if (d.length <= 2) return d;
    if (d.length <= 6) return `${d.slice(0, 2)}-${d.slice(2)}`;
    if (d.length <= 9) return `${d.slice(0, 2)}-${d.slice(2, d.length - 4)}-${d.slice(d.length - 4)}`;
    return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}`;
  }

  // 그 외 지역번호·이동전화(3자리 국번): 3-3(4)-4
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(d.length - 4)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 11)}`;
}

/** 입력창 보조 포맷(하이픈 유무와 무관하게 동일 처리). 공통 Utility 로 위임. */
export function formatPhone(value: string): string {
  return formatPhoneNumber(value);
}

/** 저장된 전화번호를 표시용으로 포맷. null/빈 값/"-" → "-" 반환 */
export function formatPhoneDisplay(value: string | null | undefined): string {
  if (!value || value.trim() === "" || value.trim() === "-") return "-";
  return formatPhoneNumber(value) || value;
}
