// ─────────────────────────────────────────────────────────────────────────────
// 고객 실적(매출·거래 건수) 통합 집계 + 고객 등급 5단계 — 읽기 전용(원본 수정 없음).
//
//  판매 실적(fact) = 판매·계약 1건. 고객사 마스터(companies.id) 기준.
//   ① 신규 판매: projects(취소 제외) 중 판매전환된 건 = 유효 견적(is_current·미삭제·derived 제외) 중 status='approved' 1건 이상.
//      · 금액(공급가액) = 유효 승인 견적의 quote_items.supply_amount 합. 품목 없는 견적은 price ÷ 1.1(추정 표시).
//      · 기준일 = 유효 승인 견적 발행일(가장 이른 날), 없으면 프로젝트 생성일(KST).
//   ② 과거 CRM 판매: legacy_archive_rows sales_list(is_effective) 판매번호 1건 = 1건.
//      · 진행관리표(progress) 행은 별도 건으로 세지 않는다(판매목록 기준).
//      · 신규 판매로 전환된 판매번호(legacy_master_mappings old_crm/sale, rolled_back 제외)는 제외 → 신규 쪽 1회만 집계.
//      · 원본 총액 0(금액 미확정·취소 가능성)은 매출·건수에서 제외.
//      · 판매목록에는 공급가액 칸이 없다(총액=부가세 포함). 공급가액 산출:
//          (a) 연결된 진행관리표 총액 합 = 판매 총액 → 진행관리표 공급가액 합(원본값)
//          (b) 연결은 있으나 총액 불일치 → 판매 총액 × (진행관리표 공급가액/총액) [추정]
//          (c) 연결 없음 → 판매 총액 ÷ 1.1 [추정]
//      · 거래처 연결 = 기존 규칙(정규화 거래처명·별칭이 정확히 1곳일 때만). 미연결분은 어느 고객에도 넣지 않는다.
//      · 기준일 = 판매번호 앞 날짜(YYYY-MM-DD), 없으면 record_date, 그래도 없으면 '기준일 없음'.
//  매출 집계는 수금·미수금과 완전히 분리(입금 여부와 무관).
// ─────────────────────────────────────────────────────────────────────────────
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { normalizeCompanyName } from "../lib/normalizeCompany";

export type Grade = "VIP" | "우수" | "일반" | "휴면" | "신규";
export const GRADES: Grade[] = ["VIP", "우수", "일반", "휴면", "신규"];
export const GRADE_RULES = {
  vipTotal: 100_000_000, vip12m: 30_000_000,
  goodTotal: 10_000_000, good24mCount: 20,
};

export interface Fact {
  companyId: number;
  date: string | null;          // YYYY-MM-DD (판매·계약 기준일)
  supply: number;               // 공급가액(부가세 제외)
  source: "new" | "legacy";
  basis: "items" | "price_est" | "progress" | "ratio_est" | "vat_est";
  ref: string;                  // 프로젝트 id 또는 과거 판매번호
}
export interface FactIndex {
  at: number;
  byCompany: Map<number, Fact[]>;
  diag: {
    newSales: number; legacySales: number; legacyMatched: number;
    legacyUnmatched: number; legacyUnmatchedSupply: number; legacyConverted: number; legacyZero: number;
    legacyEstimated: number; legacyEstimatedSupply: number; legacyExactSupply: number; newPriceEstimated: number;
  };
}

const rowsOf = async <T = any>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];

let cache: FactIndex | null = null;
let building: Promise<FactIndex> | null = null;
const TTL = 5 * 60 * 1000;

export function invalidateCustomerFacts() { cache = null; }

export async function loadFacts(): Promise<FactIndex> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  if (building) return building;
  building = build().then((r) => { cache = r; building = null; return r; }, (e) => { building = null; throw e; });
  return building;
}

async function build(): Promise<FactIndex> {
  const byCompany = new Map<number, Fact[]>();
  const push = (f: Fact) => { (byCompany.get(f.companyId) ?? byCompany.set(f.companyId, []).get(f.companyId)!).push(f); };
  const diag: FactIndex["diag"] = { newSales: 0, legacySales: 0, legacyMatched: 0, legacyUnmatched: 0, legacyUnmatchedSupply: 0, legacyConverted: 0, legacyZero: 0, legacyEstimated: 0, legacyEstimatedSupply: 0, legacyExactSupply: 0, newPriceEstimated: 0 };

  // ① 신규 판매(판매전환 건)
  const news = await rowsOf(sql`
    WITH eq AS (
      SELECT q.id, q.project_id, q.price, q.issue_date, q.created_at FROM quotes q
      WHERE q.status = 'approved' AND q.is_current = true AND q.deleted_at IS NULL
        AND (q.relation_type IS NULL OR q.relation_type <> 'derived')
    ), it AS (SELECT quote_id, sum(supply_amount) AS sup, count(*) AS n FROM quote_items GROUP BY quote_id)
    SELECT p.id, p.company_id,
           to_char(min(coalesce(eq.issue_date, (eq.created_at + interval '9 hours')::date)), 'YYYY-MM-DD') AS qdate,
           to_char((p.created_at + interval '9 hours')::date, 'YYYY-MM-DD') AS pdate,
           sum(CASE WHEN coalesce(it.n, 0) > 0 THEN coalesce(it.sup, 0) ELSE round(eq.price / 1.1) END) AS supply,
           bool_or(coalesce(it.n, 0) = 0) AS price_est
    FROM projects p JOIN eq ON eq.project_id = p.id LEFT JOIN it ON it.quote_id = eq.id
    WHERE p.status <> 'cancelled' AND p.company_id IS NOT NULL
    GROUP BY p.id`);
  for (const r of news) {
    diag.newSales++;
    if (r.price_est) diag.newPriceEstimated++;
    push({ companyId: Number(r.company_id), date: r.qdate ?? r.pdate ?? null, supply: Number(r.supply) || 0, source: "new", basis: r.price_est ? "price_est" : "items", ref: `P${r.id}` });
  }

  // ② 과거 CRM 판매 — 거래처 Master 연결 인덱스(기존 규칙)
  const coIndex = new Map<string, Set<number>>();
  const add = (k: string, id: number) => { if (k) (coIndex.get(k) ?? coIndex.set(k, new Set()).get(k)!).add(id); };
  for (const c of await rowsOf(sql`SELECT id, name FROM companies WHERE deleted_at IS NULL`)) add(normalizeCompanyName(c.name), Number(c.id));
  for (const a of await rowsOf(sql`SELECT ca.company_id id, ca.normalized_alias k FROM company_aliases ca JOIN companies c ON c.id = ca.company_id AND c.deleted_at IS NULL`)) add(String(a.k ?? ""), Number(a.id));

  const num = (expr: ReturnType<typeof sql>) => sql`nullif(regexp_replace(coalesce(${expr}, ''), '[^0-9.-]', '', 'g'), '')::numeric`;
  const legacy = await rowsOf(sql`
    WITH mapped AS (
      SELECT DISTINCT btrim(legacy_id) AS sale_no FROM legacy_master_mappings
      WHERE source_system = 'old_crm' AND entity_type = 'sale' AND status <> 'rolled_back'
    ), pg AS (
      SELECT k.sale_row_id, sum(${num(sql`p.source_raw->>'공급가액'`)}) AS sup, sum(${num(sql`p.source_raw->>'총액'`)}) AS tot
      FROM legacy_sales_progress_links k JOIN legacy_archive_rows p ON p.id = k.progress_row_id AND p.is_effective
      WHERE k.decision = 'confirmed' GROUP BY k.sale_row_id
    )
    SELECT l.id, nullif(btrim(l.source_raw->>'판매번호'), '') AS sale_no,
           coalesce(nullif(btrim(l.company_name), ''), nullif(btrim(l.source_raw->>'거래처명'), '')) AS company_name,
           coalesce(l.total_amount, ${num(sql`l.source_raw->>'총액'`)}) AS total,
           coalesce(substring(l.source_raw->>'판매번호' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'), to_char(l.record_date, 'YYYY-MM-DD')) AS sale_date,
           pg.sup AS pg_sup, pg.tot AS pg_tot,
           (nullif(btrim(l.source_raw->>'판매번호'), '') IN (SELECT sale_no FROM mapped)) AS converted
    FROM legacy_archive_rows l LEFT JOIN pg ON pg.sale_row_id = l.id
    WHERE l.source_type = 'sales_list' AND l.is_effective = true`);
  for (const r of legacy) {
    diag.legacySales++;
    if (r.converted) { diag.legacyConverted++; continue; }
    const total = Number(r.total ?? 0) || 0;
    if (total <= 0) { diag.legacyZero++; continue; }
    const pgTot = r.pg_tot != null ? Number(r.pg_tot) : 0;
    const pgSup = r.pg_sup != null ? Number(r.pg_sup) : null;
    let supply: number; let basis: Fact["basis"];
    if (pgTot > 0 && pgSup != null && Math.abs(total - pgTot) <= 1) { supply = pgSup; basis = "progress"; }
    else if (pgTot > 0 && pgSup != null && pgSup >= 0) { supply = Math.round(total * pgSup / pgTot); basis = "ratio_est"; }
    else { supply = Math.round(total / 1.1); basis = "vat_est"; }
    const hit = coIndex.get(normalizeCompanyName(r.company_name ?? ""));
    if (!hit || hit.size !== 1) { diag.legacyUnmatched++; diag.legacyUnmatchedSupply += supply; continue; }
    diag.legacyMatched++;
    if (basis === "progress") diag.legacyExactSupply += supply; else { diag.legacyEstimated++; diag.legacyEstimatedSupply += supply; }
    push({ companyId: [...hit][0], date: r.sale_date ?? null, supply, source: "legacy", basis, ref: String(r.sale_no ?? `L${r.id}`) });
  }
  return { at: Date.now(), byCompany, diag };
}

// ── 날짜 유틸(KST) ───────────────────────────────────────────────────────────
export function todayKst(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
export function monthsAgo(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 - months, d));
  return dt.toISOString().slice(0, 10);
}

export interface Perf {
  totalSupply: number; totalCount: number;
  supply12m: number; count24m: number; lastDate: string | null;
  newCount: number; legacyCount: number; estimatedCount: number; undatedCount: number;
}
export function summarize(facts: Fact[] | undefined, today = todayKst()): Perf {
  const c12 = monthsAgo(today, 12), c24 = monthsAgo(today, 24);
  const p: Perf = { totalSupply: 0, totalCount: 0, supply12m: 0, count24m: 0, lastDate: null, newCount: 0, legacyCount: 0, estimatedCount: 0, undatedCount: 0 };
  for (const f of facts ?? []) {
    p.totalSupply += f.supply; p.totalCount++;
    if (f.source === "new") p.newCount++; else p.legacyCount++;
    if (f.basis.endsWith("_est")) p.estimatedCount++;
    if (!f.date) { p.undatedCount++; continue; }
    if (f.date > c12 && f.date <= today) p.supply12m += f.supply;
    if (f.date > c24 && f.date <= today) p.count24m++;
    if (!p.lastDate || f.date > p.lastDate) p.lastDate = f.date;
  }
  return p;
}

// 우선순위: 거래 이력 없음 → 신규 / 최근 24개월 거래 없음 → 휴면 / VIP → 우수 → 일반
export function autoGrade(p: Perf): { grade: Grade; reason: string } {
  const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
  if (p.totalCount === 0) return { grade: "신규", reason: "거래 이력 없음" };
  if (p.count24m === 0) return { grade: "휴면", reason: `최근 24개월 거래 없음(최근 거래 ${p.lastDate ?? "기준일 없음"})` };
  const R = GRADE_RULES;
  if (p.totalSupply >= R.vipTotal) return { grade: "VIP", reason: `누적 매출 ${won(p.totalSupply)} ≥ 1억 원` };
  if (p.supply12m >= R.vip12m) return { grade: "VIP", reason: `최근 12개월 매출 ${won(p.supply12m)} ≥ 3천만 원` };
  if (p.totalSupply >= R.goodTotal) return { grade: "우수", reason: `누적 매출 ${won(p.totalSupply)} ≥ 1천만 원` };
  if (p.count24m >= R.good24mCount) return { grade: "우수", reason: `최근 24개월 거래 ${p.count24m}건 ≥ 20건` };
  return { grade: "일반", reason: `누적 ${won(p.totalSupply)} · 최근 12개월 ${won(p.supply12m)} · 최근 24개월 ${p.count24m}건 — VIP·우수 기준 미달` };
}

// 현재 관리자 지정 등급(거래처 id → 지정 정보)
export async function loadOverrides(ids?: number[]): Promise<Map<number, { grade: Grade; reason: string; setAt: string; setBy: number | null }>> {
  const where = ids ? (ids.length ? sql`AND company_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`AND false`) : sql``;
  const rows = await rowsOf(sql`SELECT company_id, grade, reason, set_at, set_by FROM customer_grade_overrides WHERE released_at IS NULL ${where}`);
  return new Map(rows.map((r) => [Number(r.company_id), { grade: r.grade as Grade, reason: r.reason, setAt: String(r.set_at), setBy: r.set_by ?? null }]));
}

export function gradeInfo(companyId: number, idx: FactIndex, overrides: Map<number, { grade: Grade; reason: string; setAt: string; setBy: number | null }>, today = todayKst()) {
  const perf = summarize(idx.byCompany.get(companyId), today);
  const auto = autoGrade(perf);
  const ov = overrides.get(companyId) ?? null;
  return { grade: ov?.grade ?? auto.grade, autoGrade: auto.grade, autoReason: auto.reason, override: ov, perf };
}
