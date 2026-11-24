// ─── 판매목록 날짜별 검색 (READ-ONLY) ───────────────────────────────────────────
//   query: dateBasis = sale(판매날짜) | invoice(계산서 발행일) | deposit(입금일), periodFrom / periodTo = YYYY-MM-DD(양끝 포함).
//   · 날짜 미선택(시작·종료 모두 없음) → 필터 없음(기존 전체조회 유지). 한쪽만 있으면 그 방향만 제한.
//   · 판매 1건에 청구회차가 여럿이면 하나라도 기간에 해당할 때 일치(판매 단위 판정 → 행 중복 없음).
//   · 판매날짜 = 판매목록 날짜와 같은 기준(과거 CRM 전환 판매는 원본 판매번호 날짜, 그 외 대표 유효 견적의 견적일).
//   · 계산서 발행일 = 청구회차 발행일(issue_date). 입금일 = 실제 입금기록(입금거래 입금일, 거래가 없으면 입금완료 확정 회차의 입금일).
//     입금예정일(expected_date)·상계(offset)는 사용하지 않는다.
//   · 과거 CRM 전환 판매에 플랫폼 청구정보(발행일 / 입금기록)가 없으면 원본(sales_list) 값으로 판정 — 목록 표시 규칙(fillBillingInfo)과 동일.
import { sql, type SQL } from "drizzle-orm";

export type SaleDateBasis = "sale" | "invoice" | "deposit";
export interface SaleDateFilter { basis: SaleDateBasis; from: string | null; to: string | null }

const vd = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime()) ? s : null);

export function parseSaleDateFilter(q: Record<string, string | undefined>): SaleDateFilter | null {
  let from = vd(q.periodFrom?.trim()), to = vd(q.periodTo?.trim());
  if (!from && !to) return null;
  if (from && to && from > to) [from, to] = [to, from];
  const b = q.dateBasis;
  return { basis: b === "invoice" || b === "deposit" ? b : "sale", from, to };
}

// 날짜 문자열(YYYY-MM-DD) 식이 기간 안인지 — 문자열 비교(형식 고정, 시간대 변환 없음)
export function periodCond(expr: SQL, f: SaleDateFilter): SQL {
  const c: SQL[] = [sql`${expr} IS NOT NULL`];
  if (f.from) c.push(sql`${expr} >= ${f.from}`);
  if (f.to) c.push(sql`${expr} <= ${f.to}`);
  return sql.join(c, sql` AND `);
}

const DATE_RE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}";

// 운영 판매(project) 중 기간에 해당하는 id 집합
export async function projectIdsInPeriod(dbx: any, ids: number[], f: SaleDateFilter): Promise<Set<number>> {
  const uniq = [...new Set(ids.filter((v) => Number.isFinite(v)))];
  if (!uniq.length) return new Set();
  const idList = sql.join(uniq.map((i) => sql`${i}`), sql`, `);
  const legacyRaw = (key: string) => sql`(SELECT substring(l.source_raw ->> ${key} from ${DATE_RE}) FROM legacy_archive_rows l
      WHERE m.legacy_id IS NOT NULL AND l.source_type = 'sales_list' AND l.is_effective AND l.source_raw ->> '판매번호' = m.legacy_id
      ORDER BY l.id DESC LIMIT 1)`;
  // 플랫폼 실제 입금일 목록(회차별): 입금거래가 있으면 거래 입금일(상계·0원 제외), 없으면 입금완료 확정 회차의 입금일
  const depositDates = sql`(
      SELECT t.paid_date::text AS d FROM payment_transactions t JOIN project_payments pp ON pp.id = t.project_payment_id
        WHERE pp.project_id = p.id AND coalesce(t.txn_type, 'deposit') <> 'offset' AND t.paid_date IS NOT NULL
          AND (coalesce(t.customer_paid_amount, 0) > 0 OR coalesce(t.foreign_amount, 0) > 0)
      UNION ALL
      SELECT pp.paid_date::text FROM project_payments pp
        WHERE pp.project_id = p.id AND pp.paid_date IS NOT NULL AND pp.deposit_status = 'completed' AND pp.deposit_confirmed = true
          AND coalesce(pp.amount, 0) > 0 AND NOT EXISTS (SELECT 1 FROM payment_transactions t2 WHERE t2.project_payment_id = pp.id))`;
  let cond: SQL;
  if (f.basis === "sale") {
    const d = sql`coalesce(substring(m.legacy_id from ${DATE_RE}), (SELECT q1.issue_date::text FROM quotes q1
        WHERE q1.project_id = p.id AND q1.is_current = true AND q1.deleted_at IS NULL
        ORDER BY (q1.relation_type IS NULL) DESC, q1.id ASC LIMIT 1))`;
    cond = periodCond(d, f);
  } else if (f.basis === "invoice") {
    const hasPlatform = sql`EXISTS (SELECT 1 FROM project_payments pp WHERE pp.project_id = p.id AND pp.issue_date IS NOT NULL)`;
    const raw = legacyRaw("세금계산서발행(예정)일");
    cond = sql`(EXISTS (SELECT 1 FROM project_payments pp WHERE pp.project_id = p.id AND ${periodCond(sql`pp.issue_date::text`, f)})
      OR (NOT ${hasPlatform} AND ${periodCond(raw, f)}))`;
  } else {
    const raw = legacyRaw("입금일");
    cond = sql`(EXISTS (SELECT 1 FROM ${depositDates} dd WHERE ${periodCond(sql`dd.d`, f)})
      OR (NOT EXISTS (SELECT 1 FROM ${depositDates} dz) AND ${periodCond(raw, f)}))`;
  }
  const rows = (await dbx.execute(sql`SELECT p.id FROM projects p
    LEFT JOIN LATERAL (
      SELECT btrim(m1.legacy_id) AS legacy_id FROM legacy_master_mappings m1
      WHERE m1.source_system = 'old_crm' AND m1.entity_type = 'sale' AND m1.status = 'active' AND m1.entity_id = p.id
      ORDER BY m1.id DESC LIMIT 1
    ) m ON true
    WHERE p.id IN (${idList}) AND ${cond}`)).rows as any[];
  return new Set(rows.map((r) => Number(r.id)));
}

// 과거 CRM(sales_list) 행 조건 — saleDateExpr = 목록 판매일 식(LEGACY_SALE_DATE), rawCol = source_raw 컬럼 식
export function legacyPeriodCond(saleDateExpr: SQL, rawCol: SQL, f: SaleDateFilter): SQL {
  if (f.basis === "sale") return periodCond(saleDateExpr, f);
  const key = f.basis === "invoice" ? "세금계산서발행(예정)일" : "입금일";
  return periodCond(sql`substring(${rawCol} ->> ${key} from ${DATE_RE})`, f);
}
