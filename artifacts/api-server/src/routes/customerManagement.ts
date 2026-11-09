// ─────────────────────────────────────────────────────────────────────────────
// 고객관리(거래처 통합) API — 데이터 원본 = companies. 별도 customers(초기 테스트) 테이블은 사용하지 않는다.
//
//  · 대상: 미삭제 거래처 중 company_type = 'client' (is_customer 누락 고객사 포함). 외주업체 유형(vendor) 제외.
//  · [삭제] = customer_list_exclusions 에 제외 기록 추가 → 고객관리 목록에서만 빠진다. 거래처 원본·담당자·
//    프로젝트·판매·청구·수금 이력은 변경하지 않는다. [복원] = 제외 기록에 restored_at 기록(이력 보존).
//  · 금액 기준(읽기 전용, 저장값 변경 없음):
//      - 총매출(신규)  = 판매관리 판매금액과 같은 규칙: 프로젝트(취소 제외)별 유효견적(is_current·미삭제·derived 제외)
//                       quote_items 합계, 품목 없으면 유효견적 price 합. 거래처 = projects.company_id.
//      - 청구·입금·미수금 = 수금관리와 같은 규칙: project_payments 청구행별 실입금(거래 있으면 거래합, 없으면
//                       deposit_status='completed' → 전액) · 선입/차감 견적 제외. 거래처 = 청구업체(없으면 판매 거래처).
//      - 과거 CRM      = 참고 정보만(합산 안 함). 기존 연결 규칙(정규화 거래처명·별칭이 정확히 1곳)으로만 연결,
//                       신규 판매로 전환된 판매번호는 제외. 과거 입금정보로 미수금을 확정하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, customerListExclusionsTable, customerGradeOverridesTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { parseDepositAmounts } from "../services/legacySaleActivation";
import { loadFacts, loadOverrides, gradeInfo, todayKst, GRADES, GRADE_RULES, type Grade, type Fact } from "../services/customerPerformance";

const router: IRouter = Router();
const viewGuard = [requireAuth, requireRole("admin", "staff")];
const adminOnly = [requireAuth, requireRole("admin")];

const rowsOf = async <T = any>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];
const ids = (list: number[]) => sql.join(list.map((id) => sql`${id}`), sql`, `);

// 고객관리 대상 기본 조건(별칭 c = companies)
const BASE_COND = sql`c.deleted_at IS NULL AND c.company_type = 'client'`;
const EXCLUDED = sql`EXISTS (SELECT 1 FROM customer_list_exclusions x WHERE x.company_id = c.id AND x.restored_at IS NULL)`;

// ── 과거 CRM 참고 집계(거래처 id → 건수·총액·최근 판매일) — 5분 캐시 ──────────────
//  · 입금 확인 상태(표시 전용, 금액 합산 없음) — 수금관리 과거 CRM 판정과 같은 규칙(parseDepositAmounts):
//      입금일 + 입금내역 금액합계 = 총액 → 확인(paidConfirmed) / 입금일·입금내역 모두 없음 → 입금 기록 없음(noDeposit) /
//      그 외 → 확인 필요(needsReview). 총액 0 은 판정 제외(수금관리와 같이 '확인 필요'로 분류).
type LegacyRef = { count: number; total: number; lastDate: string | null; paidConfirmed: number; noDeposit: number; needsReview: number };
let legacyCache: { at: number; map: Map<number, LegacyRef> } | null = null;
async function legacyRefIndex(): Promise<Map<number, LegacyRef>> {
  if (legacyCache && Date.now() - legacyCache.at < 5 * 60 * 1000) return legacyCache.map;
  // 거래처 Master 판정 — 과거 자료 연결과 같은 규칙: 정규화 거래처명·별칭이 정확히 1곳일 때만 연결
  const coIndex = new Map<string, Set<number>>();
  const add = (k: string, id: number) => { if (k) (coIndex.get(k) ?? coIndex.set(k, new Set()).get(k)!).add(id); };
  for (const c of await rowsOf(sql`SELECT id, name FROM companies WHERE deleted_at IS NULL`)) add(normalizeCompanyName(c.name), Number(c.id));
  for (const a of await rowsOf(sql`SELECT ca.company_id id, ca.normalized_alias k FROM company_aliases ca JOIN companies c ON c.id = ca.company_id AND c.deleted_at IS NULL`)) add(String(a.k ?? ""), Number(a.id));
  const sales = await rowsOf(sql`
    WITH linked AS (
      SELECT DISTINCT btrim(legacy_id) AS sale_no FROM legacy_master_mappings
      WHERE source_system = 'old_crm' AND entity_type = 'sale' AND status <> 'rolled_back'
    )
    SELECT coalesce(nullif(btrim(l.company_name), ''), nullif(btrim(l.source_raw->>'거래처명'), '')) AS company_name,
      coalesce(l.total_amount::text, nullif(regexp_replace(coalesce(l.source_raw->>'총액',''), '[^0-9.-]', '', 'g'), '')) AS total,
      coalesce(substring(l.source_raw->>'판매번호' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}'), to_char(l.record_date, 'YYYY-MM-DD')) AS sale_date,
      coalesce(to_char(l.collection_date, 'YYYY-MM-DD'), substring(l.source_raw->>'입금일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')) AS deposit_date,
      nullif(btrim(l.source_raw->>'입금내역'), '') AS deposit_memo
    FROM legacy_archive_rows l
    WHERE l.source_type = 'sales_list' AND l.is_effective = true
      AND coalesce(nullif(btrim(l.source_raw->>'판매번호'), ''), '') NOT IN (SELECT sale_no FROM linked)`);
  const map = new Map<number, LegacyRef>();
  for (const s of sales) {
    const hit = coIndex.get(normalizeCompanyName(s.company_name ?? ""));
    if (!hit || hit.size !== 1) continue;
    const id = [...hit][0];
    const r = map.get(id) ?? { count: 0, total: 0, lastDate: null, paidConfirmed: 0, noDeposit: 0, needsReview: 0 };
    r.count += 1;
    const amount = Number(s.total ?? 0) || 0;
    r.total += amount;
    // 수금관리(과거 CRM)와 같은 입금 판정 — 상태 건수만 기록
    const parsed = parseDepositAmounts(s.deposit_memo);
    if (amount <= 0) r.needsReview += 1;
    else if (!s.deposit_date && !s.deposit_memo) r.noDeposit += 1;
    else if (!s.deposit_date || !parsed.length || parsed.reduce((a, n) => a + n, 0) !== amount) r.needsReview += 1;
    else r.paidConfirmed += 1;
    if (s.sale_date && (!r.lastDate || s.sale_date > r.lastDate)) r.lastDate = s.sale_date;
    map.set(id, r);
  }
  legacyCache = { at: Date.now(), map };
  return map;
}

// ─── 목록 ──────────────────────────────────────────────────────────────────
//  ?view=active(기본)|excluded · ?search= · ?page=1 · ?pageSize=20 (최대 100)
router.get("/admin/customer-management", ...viewGuard, async (req, res) => {
  try {
    const view = req.query.view === "excluded" ? "excluded" : "active";
    const search = String(req.query.search ?? "").trim();
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 100);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const like = `%${search}%`;
    const digits = search.replace(/[^0-9]/g, "");
    const searchCond = search
      ? sql`AND (c.name ILIKE ${like} OR c.representative_name ILIKE ${like} OR c.email ILIKE ${like}
              ${digits.length >= 3 ? sql`OR regexp_replace(coalesce(c.business_number,''), '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"}
              OR regexp_replace(coalesce(c.phone,'') || ' ' || coalesce(c.mobile,''), '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"}` : sql``}
              OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND ct.deleted_at IS NULL AND (ct.name ILIKE ${like} OR ct.email ILIKE ${like}))
              OR EXISTS (SELECT 1 FROM company_aliases ca WHERE ca.company_id = c.id AND ca.alias_name ILIKE ${like}))`
      : sql``;
    const viewCond = view === "excluded" ? EXCLUDED : sql`NOT ${EXCLUDED}`;

    const [cnt] = await rowsOf<{ active: number; excluded: number; filtered: number }>(sql`
      SELECT count(*) FILTER (WHERE NOT ${EXCLUDED})::int AS active,
             count(*) FILTER (WHERE ${EXCLUDED})::int AS excluded,
             count(*) FILTER (WHERE ${viewCond} ${searchCond})::int AS filtered
      FROM companies c WHERE ${BASE_COND}`);

    // 정렬: 최근 판매(프로젝트) → 최근 등록 순
    const pageRows = await rowsOf(sql`
      SELECT c.id, c.name, c.representative_name, c.business_number, c.phone, c.mobile, c.email,
             c.is_customer, c.is_vendor, c.customer_type, c.created_at,
             (SELECT max(p.created_at) FROM projects p WHERE p.company_id = c.id) AS last_project_at,
             x.excluded_at, x.reason AS excluded_reason
      FROM companies c
      LEFT JOIN customer_list_exclusions x ON x.company_id = c.id AND x.restored_at IS NULL
      WHERE ${BASE_COND} AND ${viewCond} ${searchCond}
      ORDER BY ${view === "excluded" ? sql`x.excluded_at DESC,` : sql``} last_project_at DESC NULLS LAST, c.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);

    const pageIds = pageRows.map((r) => Number(r.id));
    const contactBy = new Map<number, any>();
    const projBy = new Map<number, any>();
    const saleBy = new Map<number, number>();
    const billBy = new Map<number, any>();
    if (pageIds.length) {
      // 대표 담당자 1명: 기본 담당자 → 활성 → 최근 등록
      for (const r of await rowsOf(sql`
        SELECT DISTINCT ON (ct.company_id) ct.company_id, ct.name, ct.phone, ct.mobile, ct.email
        FROM contacts ct WHERE ct.company_id IN (${ids(pageIds)}) AND ct.deleted_at IS NULL
        ORDER BY ct.company_id, ct.is_primary DESC, ct.is_active DESC, ct.id DESC`)) contactBy.set(Number(r.company_id), r);

      for (const r of await rowsOf(sql`
        SELECT p.company_id, count(*)::int AS total,
               count(*) FILTER (WHERE p.status IN ('approved','paid','matched','in_progress'))::int AS in_progress,
               count(*) FILTER (WHERE p.status = 'completed')::int AS completed,
               count(*) FILTER (WHERE p.status = 'cancelled')::int AS cancelled,
               max(p.created_at)::text AS last_project_at
        FROM projects p WHERE p.company_id IN (${ids(pageIds)}) GROUP BY p.company_id`)) projBy.set(Number(r.company_id), r);

      // 총매출(신규) — 판매관리 판매금액 규칙(프로젝트별 유효견적 품목합, 없으면 견적가 합). 취소 판매 제외.
      for (const r of await rowsOf(sql`
        WITH pj AS (SELECT p.id, p.company_id FROM projects p WHERE p.company_id IN (${ids(pageIds)}) AND p.status <> 'cancelled'),
        eq AS (SELECT q.id, q.project_id, q.price FROM quotes q JOIN pj ON pj.id = q.project_id
               WHERE q.is_current = true AND q.deleted_at IS NULL AND (q.relation_type IS NULL OR q.relation_type <> 'derived')),
        it AS (SELECT eq.project_id, sum(qi.total_amount) AS t FROM quote_items qi JOIN eq ON eq.id = qi.quote_id GROUP BY eq.project_id),
        pr AS (SELECT project_id, sum(price) AS t FROM eq GROUP BY project_id)
        SELECT pj.company_id, coalesce(sum(CASE WHEN coalesce(it.t, 0) > 0 THEN it.t ELSE coalesce(pr.t, 0) END), 0) AS sale
        FROM pj LEFT JOIN it ON it.project_id = pj.id LEFT JOIN pr ON pr.project_id = pj.id
        GROUP BY pj.company_id`)) saleBy.set(Number(r.company_id), Number(r.sale));

      // 청구·입금·미수금 — 수금관리 규칙(청구행별 계산 후 합산). 거래처 = 청구업체, 없으면 판매 거래처.
      for (const r of await rowsOf(sql`
        SELECT r.company_id, count(*)::int AS rows,
               coalesce(sum(r.amount), 0) AS billed, coalesce(sum(r.paid_row), 0) AS paid,
               coalesce(sum(greatest(r.amount - r.paid_row, 0)), 0) AS receivable,
               max(r.last_paid)::text AS last_paid
        FROM (
          SELECT coalesce(pp.billing_company_id, p.company_id) AS company_id, coalesce(pp.amount, 0) AS amount,
            CASE WHEN coalesce(tx.tx_cnt, 0) > 0 THEN coalesce(tx.tx_paid, 0)
                 WHEN pp.deposit_status = 'completed' THEN coalesce(pp.amount, 0) ELSE 0 END AS paid_row,
            coalesce(tx.last_paid, CASE WHEN coalesce(tx.tx_cnt, 0) = 0 THEN pp.paid_date END) AS last_paid
          FROM project_payments pp
          JOIN projects p ON p.id = pp.project_id
          LEFT JOIN (SELECT project_payment_id, count(*) AS tx_cnt, coalesce(sum(customer_paid_amount), 0) AS tx_paid, max(paid_date) AS last_paid
                     FROM payment_transactions GROUP BY project_payment_id) tx ON tx.project_payment_id = pp.id
          WHERE coalesce(pp.billing_company_id, p.company_id) IN (${ids(pageIds)})
            AND NOT EXISTS (SELECT 1 FROM quotes q2 WHERE q2.project_id = pp.project_id AND q2.is_current = true
                              AND q2.deleted_at IS NULL AND q2.quote_type IN ('b2c_prepaid', 'prepaid_deduction'))
        ) r GROUP BY r.company_id`)) billBy.set(Number(r.company_id), r);
    }
    const legacy = await legacyRefIndex();
    const facts = await loadFacts();
    const overrides = await loadOverrides(pageIds);
    const today = todayKst();

    const rows = pageRows.map((c) => {
      const id = Number(c.id);
      const ct = contactBy.get(id);
      const pj = projBy.get(id);
      const bill = billBy.get(id);
      const lg = legacy.get(id) ?? null;
      const dates = [pj?.last_project_at, bill?.last_paid].filter(Boolean).map((d: string) => String(d).slice(0, 10)).sort();
      return {
        id, name: c.name, representativeName: c.representative_name, businessNumber: c.business_number,
        phone: c.phone || c.mobile || null, email: c.email,
        isCustomerFlag: c.is_customer, isVendor: c.is_vendor, customerType: c.customer_type,
        contact: ct ? { name: ct.name, phone: ct.mobile || ct.phone || null, email: ct.email } : null,
        projects: { total: pj?.total ?? 0, inProgress: pj?.in_progress ?? 0, completed: pj?.completed ?? 0, cancelled: pj?.cancelled ?? 0 },
        sales: { total: saleBy.get(id) ?? 0 },
        collection: bill ? { billingRows: bill.rows, billed: Number(bill.billed), paid: Number(bill.paid), receivable: Number(bill.receivable) } : null,
        lastTransaction: dates.length ? dates[dates.length - 1] : null,
        lastProjectAt: pj?.last_project_at ? String(pj.last_project_at).slice(0, 10) : null,
        lastPaidAt: bill?.last_paid ? String(bill.last_paid).slice(0, 10) : null,
        legacyRef: lg,   // 과거 CRM 참고(합산·미수 판단에 사용하지 않음)
        ...(() => { const g = gradeInfo(id, facts, overrides, today); return { grade: g.grade, autoGrade: g.autoGrade, gradeOverridden: !!g.override, gradeReason: g.override ? `관리자 지정: ${g.override.reason}` : g.autoReason }; })(),
        excludedAt: c.excluded_at ?? null, excludedReason: c.excluded_reason ?? null,
        createdAt: c.created_at,
      };
    });

    res.json({ view, page, pageSize, total: cnt.filtered, counts: { active: cnt.active, excluded: cnt.excluded }, rows });
  } catch (err) {
    req.log.error({ err }, "CustomerManagement: list failed");
    res.status(500).json({ error: "고객 목록 조회 실패." });
  }
});

async function loadTarget(companyId: number) {
  const [c] = await rowsOf(sql`SELECT id, name, company_type, deleted_at FROM companies WHERE id = ${companyId}`);
  return c ?? null;
}

// ─── 삭제(고객관리 제외) — 관리자 전용. 거래처 원본·이력 변경 없음 ─────────────────
router.post("/admin/customer-management/:companyId/exclude", ...adminOnly, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 id." }); return; }
  try {
    const c = await loadTarget(companyId);
    if (!c || c.deleted_at) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }
    if (c.company_type !== "client") { res.status(400).json({ error: "고객사 유형이 아닌 거래처입니다." }); return; }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) || null : null;
    const inserted = await db.insert(customerListExclusionsTable)
      .values({ companyId, reason, excludedBy: req.user?.id ?? null })
      .onConflictDoNothing()
      .returning({ id: customerListExclusionsTable.id });
    if (!inserted.length) { res.status(409).json({ error: "이미 고객관리에서 제외된 거래처입니다." }); return; }
    await logEvent("company", companyId, "customer_list_excluded", req.log, req.user ?? undefined, reason ?? undefined);
    res.json({ ok: true, companyId });
  } catch (err) {
    req.log.error({ err }, "CustomerManagement: exclude failed");
    res.status(500).json({ error: "고객 삭제 실패." });
  }
});

// ─── 복원 — 관리자 전용 ──────────────────────────────────────────────────────
router.post("/admin/customer-management/:companyId/restore", ...adminOnly, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 id." }); return; }
  try {
    const updated = await db.update(customerListExclusionsTable)
      .set({ restoredAt: new Date(), restoredBy: req.user?.id ?? null })
      .where(and(eq(customerListExclusionsTable.companyId, companyId), isNull(customerListExclusionsTable.restoredAt)))
      .returning({ id: customerListExclusionsTable.id });
    if (!updated.length) { res.status(404).json({ error: "제외된 고객이 아닙니다." }); return; }
    await logEvent("company", companyId, "customer_list_restored", req.log, req.user ?? undefined);
    res.json({ ok: true, companyId });
  } catch (err) {
    req.log.error({ err }, "CustomerManagement: restore failed");
    res.status(500).json({ error: "고객 복원 실패." });
  }
});

// ─── 고객 순위(매출액·거래 건수) — 서버 집계(고객 실적 캐시) ─────────────────────
//  ?yearFrom=YYYY&yearTo=YYYY (연속 연도 합산, 같으면 단일 연도) · ?year=all|YYYY|undated(호환) · ?from=YYYY-MM-DD · ?to=YYYY-MM-DD · ?metric=sales|count · ?order=desc|asc
//  ?search= (표시 범위만 좁힘 — 순위는 검색 전 기준) · ?grade= (등급 필터 — 순위는 필터 후 기준)
//  ?page · ?pageSize(≤200) · ?export=1 (조건 유지 전체 행, 최대 10,000)
//  대상 = 고객관리 대상(고객사 유형·미삭제·고객관리 제외 아님) 중 조회 기간 거래 1건 이상.
router.get("/admin/customer-management/ranking", ...viewGuard, async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const year = q.year && /^(\d{4}|undated)$/.test(q.year) ? q.year : "all";
    // 연도 구간: yearFrom~yearTo(포함). 한쪽만 주면 그 연도부터/까지. year=YYYY 는 yearFrom=yearTo=YYYY 와 같다.
    let yearFrom = q.yearFrom && /^\d{4}$/.test(q.yearFrom) ? q.yearFrom : (/^\d{4}$/.test(year) ? year : null);
    let yearTo = q.yearTo && /^\d{4}$/.test(q.yearTo) ? q.yearTo : (/^\d{4}$/.test(year) ? year : null);
    if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
    const from = q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : null;
    const to = q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : null;
    const metric = q.metric === "count" ? "count" : "sales";
    const order = q.order === "asc" ? "asc" : "desc";
    const grade = GRADES.includes(q.grade as Grade) ? (q.grade as Grade) : null;
    const search = String(q.search ?? "").trim().toLowerCase();
    const exportAll = q.export === "1";
    const pageSize = exportAll ? 10000 : Math.min(Math.max(Number(q.pageSize) || 20, 1), 200);
    const page = exportAll ? 1 : Math.max(Number(q.page) || 1, 1);

    const universe = await rowsOf(sql`
      SELECT c.id, c.name, coalesce((SELECT string_agg(ca.alias_name, ' ') FROM company_aliases ca WHERE ca.company_id = c.id), '') AS aliases
      FROM companies c WHERE ${BASE_COND} AND NOT ${EXCLUDED}`);
    const facts = await loadFacts();
    const overrides = await loadOverrides();
    const today = todayKst();
    const inRange = (f: Fact) => {
      if (year === "undated") return !f.date;
      if ((yearFrom || yearTo) && !f.date) return false;
      if (yearFrom && f.date!.slice(0, 4) < yearFrom) return false;
      if (yearTo && f.date!.slice(0, 4) > yearTo) return false;
      if ((from || to) && !f.date) return false;
      if (from && f.date! < from) return false;
      if (to && f.date! > to) return false;
      return true;
    };
    const years = new Map<string, number>(); let undated = 0;
    let rows: any[] = [];
    for (const c of universe) {
      const id = Number(c.id);
      const fs = facts.byCompany.get(id);
      if (!fs) continue;
      for (const f of fs) { if (f.date) years.set(f.date.slice(0, 4), (years.get(f.date.slice(0, 4)) ?? 0) + 1); else undated++; }
      let supply = 0, count = 0, last: string | null = null, est = 0;
      for (const f of fs) if (inRange(f)) { supply += f.supply; count++; if (f.basis.endsWith("_est")) est++; if (f.date && (!last || f.date > last)) last = f.date; }
      if (!count) continue;
      const g = gradeInfo(id, facts, overrides, today);
      if (grade && g.grade !== grade) continue;
      rows.push({ id, name: c.name, aliases: c.aliases, grade: g.grade, autoGrade: g.autoGrade, gradeOverridden: !!g.override, sales: supply, count, lastDate: last, estimatedCount: est });
    }
    const key = (r: any) => (metric === "sales" ? r.sales : r.count);
    const key2 = (r: any) => (metric === "sales" ? r.count : r.sales);
    const dir = order === "desc" ? -1 : 1;
    rows.sort((a, b) => (key(a) - key(b)) * dir || (key2(a) - key2(b)) * dir || String(a.name).localeCompare(String(b.name), "ko"));
    // 공동 순위(동일 기준값 = 같은 순위, 다음 순위는 건너뜀: 1,1,3)
    let prev: number | null = null, prevRank = 0;
    rows.forEach((r, i) => { const v = key(r); r.rank = prev !== null && v === prev ? prevRank : i + 1; prev = v; prevRank = r.rank; });
    const summary = { customers: rows.length, sales: rows.reduce((s, r) => s + r.sales, 0), count: rows.reduce((s, r) => s + r.count, 0) };
    if (search) rows = rows.filter((r) => String(r.name).toLowerCase().includes(search) || String(r.aliases).toLowerCase().includes(search));
    const total = rows.length;
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize).map(({ aliases: _a, ...r }) => r);
    res.json({
      filters: { year: year === "undated" ? year : null, yearFrom, yearTo, from, to, metric, order, grade, search }, page, pageSize, total, summary,
      years: [...years.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([y, n]) => ({ year: y, count: n })), undatedCount: undated,
      rows: pageRows,
      diag: facts.diag,   // 집계 근거(신규/과거 건수·추정 공급가액·미연결 과거 판매)
    });
  } catch (err) {
    req.log.error({ err }, "CustomerManagement: ranking failed");
    res.status(500).json({ error: "고객 순위 조회 실패." });
  }
});

// ─── 고객 실적·등급 상세(고객 상세화면 접기 영역) ─────────────────────────────
router.get("/admin/customer-management/:companyId/performance", ...viewGuard, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 id." }); return; }
  try {
    const facts = await loadFacts();
    const overrides = await loadOverrides([companyId]);
    const g = gradeInfo(companyId, facts, overrides);
    const fs = facts.byCompany.get(companyId) ?? [];
    const byYear = new Map<string, { year: string; sales: number; count: number; newCount: number; legacyCount: number; estimatedCount: number }>();
    for (const f of fs) {
      const y = f.date ? f.date.slice(0, 4) : "기준일 없음";
      const r = byYear.get(y) ?? { year: y, sales: 0, count: 0, newCount: 0, legacyCount: 0, estimatedCount: 0 };
      r.sales += f.supply; r.count++; if (f.source === "new") r.newCount++; else r.legacyCount++; if (f.basis.endsWith("_est")) r.estimatedCount++;
      byYear.set(y, r);
    }
    const [hist] = await rowsOf(sql`SELECT count(*)::int AS n FROM customer_grade_overrides WHERE company_id = ${companyId}`);
    res.json({
      companyId, grade: g.grade, autoGrade: g.autoGrade, autoReason: g.autoReason, override: g.override, overrideHistoryCount: hist?.n ?? 0,
      perf: g.perf, rules: GRADE_RULES, asOf: todayKst(),
      years: [...byYear.values()].sort((a, b) => b.year.localeCompare(a.year)),
    });
  } catch (err) {
    req.log.error({ err }, "CustomerManagement: performance failed");
    res.status(500).json({ error: "고객 실적 조회 실패." });
  }
});

// ─── 관리자 등급 지정 / 해제 — 관리자 전용. 지정은 사유 필수, 해제 시 자동 등급 복귀 ──────────
router.put("/admin/customer-management/:companyId/grade", ...adminOnly, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 id." }); return; }
  const grade = req.body?.grade as Grade;
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
  if (!GRADES.includes(grade)) { res.status(400).json({ error: "등급은 VIP·우수·일반·휴면·신규 중 하나여야 합니다." }); return; }
  if (!reason) { res.status(400).json({ error: "지정 사유를 입력해 주세요." }); return; }
  try {
    const c = await loadTarget(companyId);
    if (!c || c.deleted_at) { res.status(404).json({ error: "거래처를 찾을 수 없습니다." }); return; }
    if (c.company_type !== "client") { res.status(400).json({ error: "고객사 유형이 아닌 거래처입니다." }); return; }
    await db.transaction(async (tx) => {
      await tx.update(customerGradeOverridesTable).set({ releasedAt: new Date(), releasedBy: req.user?.id ?? null })
        .where(and(eq(customerGradeOverridesTable.companyId, companyId), isNull(customerGradeOverridesTable.releasedAt)));
      await tx.insert(customerGradeOverridesTable).values({ companyId, grade, reason, setBy: req.user?.id ?? null });
    });
    await logEvent("company", companyId, "customer_grade_set", req.log, req.user ?? undefined, `${grade}: ${reason}`);
    res.json({ ok: true, companyId, grade });
  } catch (err) {
    req.log.error({ err }, "CustomerManagement: grade set failed");
    res.status(500).json({ error: "등급 지정 실패." });
  }
});

router.delete("/admin/customer-management/:companyId/grade", ...adminOnly, async (req, res) => {
  const companyId = Number(req.params.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) { res.status(400).json({ error: "유효하지 않은 거래처 id." }); return; }
  try {
    const updated = await db.update(customerGradeOverridesTable).set({ releasedAt: new Date(), releasedBy: req.user?.id ?? null })
      .where(and(eq(customerGradeOverridesTable.companyId, companyId), isNull(customerGradeOverridesTable.releasedAt)))
      .returning({ id: customerGradeOverridesTable.id });
    if (!updated.length) { res.status(404).json({ error: "지정된 등급이 없습니다." }); return; }
    await logEvent("company", companyId, "customer_grade_released", req.log, req.user ?? undefined);
    res.json({ ok: true, companyId });
  } catch (err) {
    req.log.error({ err }, "CustomerManagement: grade release failed");
    res.status(500).json({ error: "등급 지정 해제 실패." });
  }
});

export default router;
