// 견적서 수신처(거래처정보) 표시 편집값 — quotes.customer_display(jsonb, NULL = 기존 출력 그대로).
//  해당 견적서에만 저장한다(거래처 Master·다른 견적서 무변경). 형식이 맞지 않는 값은 버린다.
import type { QuoteCustomerDisplay } from "@workspace/db";

const KEYS = ["companyName", "businessNumber", "representativeName", "contactName", "phone", "email", "address"] as const;

/** undefined = 미전달(기존값 보존), null = 편집 해제, 객체 = 정리된 편집값 */
export function sanitizeCustomerDisplay(v: unknown): QuoteCustomerDisplay | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return null;
  const src = v as { fields?: Record<string, unknown>; hidden?: unknown };
  const fields: QuoteCustomerDisplay["fields"] = {};
  for (const k of KEYS) {
    const x = src.fields?.[k];
    if (typeof x === "string") fields[k] = x.trim().slice(0, 300);
  }
  const hidden = Array.isArray(src.hidden) ? [...new Set(src.hidden.filter((h): h is typeof KEYS[number] => (KEYS as readonly string[]).includes(h as string)))] : [];
  return { fields, hidden };
}
