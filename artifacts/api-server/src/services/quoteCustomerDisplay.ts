// 견적서 수신처(거래처정보) 표시 편집값 — quotes.customer_display(jsonb, NULL = 기존 출력 그대로).
//  해당 견적서에만 저장한다(거래처 Master·다른 견적서 무변경). 형식이 맞지 않는 값은 버린다.
import type { QuoteCustomerDisplay } from "@workspace/db";
import { sql } from "drizzle-orm";

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

// ─── 거래처 상호 변경 반영(조회 시점, READ-ONLY) ───────────────────────────────
//  거래처정보 편집값의 '상호'가 사용자가 직접 고친 값이 아니라 편집 당시 화면에 있던 상호를 그대로 담은 것이면
//  (= 연결된 거래처 Master 의 과거 상호, 또는 '담당자 정보 갱신' 이전 수신자 상호) 그 상호는 적용하지 않는다
//  → 견적서는 수신자 고정값/Master 의 최신 상호를 출력. 저장된 편집값·다른 항목·숨김 설정은 그대로(데이터 무변경).
type Dbx = { execute: (q: any) => Promise<{ rows: unknown[] }> };
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

// 로그 metadata(text) → jsonb — JSON 형태가 아닌 행은 NULL(형변환 오류 방지)
const META = sql.raw(`(CASE WHEN metadata LIKE '{%' THEN metadata::jsonb END)`);

export async function resolveCustomerDisplay(dbx: Dbx, quoteId: number, companyId: number | null, cd: QuoteCustomerDisplay | null): Promise<QuoteCustomerDisplay | null> {
  const name = cd?.fields?.companyName;
  if (!cd || typeof name !== "string" || companyId == null) return cd;
  try {
    const r = (await dbx.execute(sql`SELECT
        (SELECT name FROM companies WHERE id = ${companyId} AND deleted_at IS NULL) AS current_name,
        ARRAY(
          SELECT company_name FROM company_name_history WHERE company_id = ${companyId} AND name_type <> 'current'
          UNION ALL SELECT ${META} ->> 'from' FROM logs
            WHERE entity_type = 'company' AND entity_id = ${companyId} AND action = 'company_name_changed'
          UNION ALL SELECT ${META} -> 'before' ->> 'customerCompanyName' FROM logs
            WHERE entity_type = 'quote' AND entity_id = ${quoteId} AND action = 'quote_recipient_refreshed'
              AND (${META} -> 'before' ->> 'customerCompanyName') IS DISTINCT FROM (${META} -> 'after' ->> 'customerCompanyName')
        ) AS stale_names`)).rows as Array<{ current_name: string | null; stale_names: (string | null)[] | null }>;
    const row = r[0];
    if (!row?.current_name) return cd;                                       // Master 미연결·삭제 → 편집값 그대로
    const n = norm(name);
    if (!n || n === norm(row.current_name)) return cd;
    if (!(row.stale_names ?? []).some(s => s && norm(s) === n)) return cd;   // 직접 입력한 상호 → 유지
    const { companyName: _drop, ...rest } = cd.fields;
    return { ...cd, fields: rest };
  } catch { return cd; }                                                     // 판정 실패 시 기존 출력 그대로
}
