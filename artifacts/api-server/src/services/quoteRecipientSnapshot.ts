// 견적 수신자(고객) 정보 스냅샷 — 견적별 고객정보 고정
//
//   · quotes.customer_* 가 하나라도 있으면 '고정된 견적'이다. 견적서·거래명세서는 고정값만 출력한다(빈 칸은 빈 칸).
//   · 고정값이 없는 견적(기존 자료)은 예전처럼 판매에 연결된 거래처·담당자 Master 를 그대로 출력한다.
//   · 기존 견적의 출력이 Master 연결·수정 때문에 바뀌지 않도록, 연결을 바꾸거나 Master 를 수정하기 직전에
//     영향받는 견적 중 고정값이 없는 것에 '지금 출력되는 값'을 그대로 고정한다(freeze — 출력 불변).
//   · 고정값을 새 값으로 바꾸는 것은 사용자가 견적에서 담당자를 직접 바꿔 저장하거나 '담당자 정보 갱신'을 누른 경우뿐이다.
import { sql } from "drizzle-orm";

type Dbx = { execute: (q: any) => Promise<{ rows: unknown[] }> };

export interface RecipientValues {
  customerCompanyName: string | null; customerContactName: string | null; customerContactPosition: string | null;
  customerContactDepartment: string | null; customerContactPhone: string | null; customerContactMobile: string | null;
  customerContactEmail: string | null;
}

// 지금 출력되는 수신자 값(견적 상세 API·PDF 의 Master 경로와 같은 식).
//  전화: 출력은 phone → mobile → office_phone 순서다. 고정값 출력은 phone → mobile 이므로
//  phone 칸에는 'phone, (mobile 이 없을 때만) office_phone' 을 넣어 같은 번호가 나오게 한다.
// mode
//   display   — 지금 견적서에 출력되는 값 그대로(기존 견적 고정용 — 출력 불변)
//   effective — 새 견적·명시적 갱신용 담당자 이메일 자동 결정: 담당자 Master 이메일 → 거래처 Master 이메일
//               (업무용 이메일 — 공유·대표 이메일도 그대로 사용. 저장된 Master 값은 바꾸지 않고 견적 수신자에만 쓴다)
type Mode = "display" | "effective";
const liveSelect = (mode: Mode) => sql`
  COALESCE(q.derived_company_name_snapshot, p.company_name_snapshot, co.name) AS "customerCompanyName",
  COALESCE(q.derived_contact_name_snapshot, p.contact_name_snapshot, c.name) AS "customerContactName",
  c.position AS "customerContactPosition",
  c.department AS "customerContactDepartment",
  COALESCE(c.phone, CASE WHEN c.mobile IS NULL THEN c.office_phone END) AS "customerContactPhone",
  c.mobile AS "customerContactMobile",
  ${mode === "effective" ? sql`COALESCE(NULLIF(btrim(c.email), ''), NULLIF(btrim(co.email), ''))` : sql`c.email`} AS "customerContactEmail"`;
const LIVE_FROM = sql`FROM quotes q
  LEFT JOIN projects p ON p.id = q.project_id
  LEFT JOIN companies co ON co.id = COALESCE(q.derived_company_id, p.company_id)
  LEFT JOIN contacts c ON c.id = COALESCE(q.derived_contact_id, p.contact_id)`;
const HAS_SNAPSHOT = (a: string) => sql.raw(`(${["customer_company_name", "customer_contact_name", "customer_contact_position", "customer_contact_department",
  "customer_contact_phone", "customer_contact_mobile", "customer_contact_email"].map(c => `${a}.${c} IS NOT NULL`).join(" OR ")})`);

export function hasSnapshot(v: Partial<RecipientValues>): boolean {
  return Object.values(v).some(x => x != null);
}

/** 견적의 현재 Master 기준 수신자 값(고정값과 비교·갱신용) */
export async function liveRecipientOf(dbx: Dbx, quoteId: number): Promise<RecipientValues | null> {
  const r = (await dbx.execute(sql`SELECT ${liveSelect("effective")} ${LIVE_FROM} WHERE q.id = ${quoteId}`)).rows as RecipientValues[];
  return r[0] ?? null;
}

// 대상 견적들에 지금 출력되는 값을 고정. onlyMissing=true 면 고정값이 없는 견적만(기존 고정값은 건드리지 않음).
async function capture(dbx: Dbx, where: any, onlyMissing: boolean, mode: Mode = "display"): Promise<number[]> {
  const r = (await dbx.execute(sql`UPDATE quotes t SET
      customer_company_name = v."customerCompanyName", customer_contact_name = v."customerContactName",
      customer_contact_position = v."customerContactPosition", customer_contact_department = v."customerContactDepartment",
      customer_contact_phone = v."customerContactPhone", customer_contact_mobile = v."customerContactMobile",
      customer_contact_email = v."customerContactEmail"
    FROM (SELECT q.id, ${liveSelect(mode)} ${LIVE_FROM} WHERE ${where}) v
    WHERE t.id = v.id ${onlyMissing ? sql`AND NOT ${HAS_SNAPSHOT("t")}` : sql``}
    RETURNING t.id`)).rows as Array<{ id: number }>;
  return r.map(x => Number(x.id));
}

/** 저장 시점 스냅샷 — 이미 고정된 견적은 유지. 새 견적은 mode='effective'(담당자 이메일 자동 결정), 기존 견적 저장은 'display'(출력 불변) */
export const captureIfMissing = (dbx: Dbx, quoteId: number, mode: Mode = "display") => capture(dbx, sql`q.id = ${quoteId}`, true, mode);
/** 사용자가 명시적으로 갱신(담당자 직접 변경 저장) — 현재 Master 값(담당자 이메일 자동 결정 포함)으로 덮어쓴다 */
export const recaptureRecipient = (dbx: Dbx, quoteId: number) => capture(dbx, sql`q.id = ${quoteId}`, false, "effective");

/** 판매(project)의 거래처·담당자 연결을 바꾸기 직전 — 그 판매의 기존 견적 출력 보존 */
export const freezeProjectQuotes = (dbx: Dbx, projectId: number, exceptQuoteId?: number) =>
  capture(dbx, sql`q.project_id = ${projectId} AND q.deleted_at IS NULL ${exceptQuoteId ? sql`AND q.id <> ${exceptQuoteId}` : sql``}`, true);

/** 담당자 Master 를 수정·통합하기 직전 — 그 담당자를 수신자로 쓰는 기존 견적 출력 보존 */
export async function freezeContactQuotes(dbx: Dbx, contactIds: number[]): Promise<number[]> {
  const ids = contactIds.filter(n => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const list = sql.join(ids.map(i => sql`${i}`), sql`, `);
  return capture(dbx, sql`q.deleted_at IS NULL AND COALESCE(q.derived_contact_id, p.contact_id) IN (${list})`, true);
}
