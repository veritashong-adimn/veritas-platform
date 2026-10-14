// ─────────────────────────────────────────────────────────────────────────────
// 과거 지급회차 재현 (1단계, READ-ONLY) — VERITAS OS
//
// 목적: 과거 CRM 진행관리표(legacy_archive_rows, source_type='progress')의 지급내역을
//       "지급일별·수취인별"로 집계해, 대표 보관 실제 지급자료와 비교할 수 있게 조회만 한다.
//
// 안전(절대 규칙):
//   · DB write 전혀 없음(순수 SELECT 집계). 운영 payout_rounds/items/transfers·
//     performance_assignments 를 일절 건드리지 않는다 → 기존 지급회차 자동수집·지급·IBK와 무관.
//   · 과거 CRM 원본(legacy_archive_rows) 수정/삭제 없음.
//   · 주민번호 등 민감정보는 select/응답에 포함하지 않는다.
//   · 통번역사는 과거 CRM 이름(식별값) 기준. 현재 Master(users)와는 "이름 유일 일치"일 때만 참고 연결,
//     이름만으로 자동 병합/생성하지 않는다(동명이인·미등록은 미연결로 표시).
//   · 세전/세후는 원본값 그대로. 원천세 "재계산"은 현재 기본세율(3.3%) 적용 '참고치'이며,
//     과거 실제 적용 세율로 단정하지 않는다(원본 차액(implied)을 함께 제공).
//
// 엔드포인트(모두 GET, 읽기 전용):
//   GET /admin/payout-reproduction/summary   전체 요약(행수/회차/수취인/세전·세후 합계/미확인)
//   GET /admin/payout-reproduction/rounds     지급일별 재현 회차 목록(필터·페이지네이션)
//   GET /admin/payout-reproduction/payees      특정 지급일(또는 미확인)의 수취인별 상세
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, calcPayoutWithholding } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// 과거 세율 미확정 → 현재 기본 국내 원천세(3.3%)를 '참고 재계산'에만 사용. 단정 금지.
const REFERENCE_TREATMENT = "domestic_3_3" as const;

// 진행관리(progress) 정규화 CTE — 원본 불변. 금액은 숫자만 추출(실패 시 0), 날짜는 YYYY-MM-DD.
//   통번역사명 = 과거 CRM 식별값, 지급일 = 통번역사지급일, 납품일 = 통번역사납품일(원본 확인 완료),
//   세전 = 지급액(세전), 세후 = 지금액(세후)[원본 오타 키]. 수행내용 = 상품명/언어(상세정보는 연락처 등 포함 → 미노출).
//   납품일 원본이 없거나 YYYY-MM-DD 로 파싱 불가한 행은 delivery_date=NULL(임의 추정 금지).
const PROG = sql`
  WITH prog AS (
    SELECT
      id,
      nullif(btrim(source_raw->>'통번역사명'), '') AS translator,
      substring(source_raw->>'통번역사지급일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS payout_date,
      substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS delivery_date,
      nullif(btrim(source_raw->>'상품명'), '') AS product_name,
      nullif(btrim(source_raw->>'언어'), '') AS language,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지급액(세전)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS pretax,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지금액(세후)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS posttax
    FROM legacy_archive_rows
    WHERE source_type = 'progress' AND is_effective = true
  )`;

// 날짜 기준 파싱 — 'delivery' 면 납품일, 그 외(기본) 지급일. 조회 기준 컬럼 1곳으로 집약.
function parseBasis(v: unknown): "payout" | "delivery" { return v === "delivery" ? "delivery" : "payout"; }

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// 현재 세율(3.3%) 참고 재계산 — 기존 지급명세서 계산 함수 재사용(개인 기준).
function recalc(pretax: number) {
  const r = calcPayoutWithholding(pretax, "individual", REFERENCE_TREATMENT, null);
  return { deduction: r.deduction, net: r.net, rate: r.rate };
}

// ── GET 요약 ──────────────────────────────────────────────────────────────────
router.get("/admin/payout-reproduction/summary", ...adminGuard, async (_req, res) => {
  try {
    const q = sql`${PROG}
      SELECT
        count(*)::int AS total_rows,
        count(*) FILTER (WHERE payout_date IS NULL)::int AS no_date_rows,
        count(DISTINCT payout_date)::int AS round_count,
        count(DISTINCT translator) FILTER (WHERE translator IS NOT NULL)::int AS payee_count,
        coalesce(sum(pretax),0) AS pretax_total,
        coalesce(sum(posttax),0) AS posttax_total
      FROM prog`;
    const row = ((await db.execute(q)).rows as any[])[0] ?? {};
    const pretax = num(row.pretax_total), posttax = num(row.posttax_total);
    res.json({
      totalRows: num(row.total_rows),
      noDateRows: num(row.no_date_rows),
      roundCount: num(row.round_count),
      payeeCount: num(row.payee_count),
      pretaxTotal: pretax,
      posttaxTotal: posttax,
      withholdingImplied: Math.round((pretax - posttax) * 100) / 100,
      withholdingRecalc: recalc(pretax).deduction,          // 참고(현재 3.3%)
      referenceRate: 3.3,
    });
  } catch (err) { (_req as any).log?.error?.({ err }, "payout-reproduction summary failed"); res.status(500).json({ error: "재현 요약 조회 실패" }); }
});

// ── GET 지급일별 재현 회차 목록 ───────────────────────────────────────────────
router.get("/admin/payout-reproduction/rounds", ...adminGuard, async (req, res) => {
  try {
    const qp = req.query as Record<string, string | undefined>;
    const basis = parseBasis(qp.basis);
    const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateFrom ?? "") ? qp.dateFrom! : null;
    const dTo = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateTo ?? "") ? qp.dateTo! : null;
    const translator = (qp.translator ?? "").trim();
    const page = Math.max(1, parseInt(String(qp.page ?? "1"), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(qp.pageSize ?? "50"), 10) || 50));

    // 날짜 기준 범위는 선택 컬럼(지급일/납품일)에 적용. 그룹핑은 항상 실제 지급일(payout_date) —
    // 납품일 기준이어도 조회 결과를 '실제 지급일별'로 묶고, 지급일 없는 건은 '지급일 미확인'으로 구분(§3).
    const filterCol = basis === "delivery" ? sql`delivery_date` : sql`payout_date`;
    const filters = sql`WHERE 1=1
      ${dFrom ? sql` AND ${filterCol} >= ${dFrom}` : sql``}
      ${dTo ? sql` AND ${filterCol} <= ${dTo}` : sql``}
      ${translator ? sql` AND translator ILIKE ${"%" + translator + "%"}` : sql``}`;

    const totalRow = ((await db.execute(sql`${PROG}
      SELECT count(*)::int AS n FROM (SELECT payout_date FROM prog ${filters} GROUP BY payout_date) g`)).rows as any[])[0];
    const totalRounds = num(totalRow?.n);

    const rows = (await db.execute(sql`${PROG}
      SELECT
        payout_date,
        count(*)::int AS assignment_count,
        count(DISTINCT translator) FILTER (WHERE translator IS NOT NULL)::int AS payee_count,
        coalesce(sum(pretax),0) AS pretax_total,
        coalesce(sum(posttax),0) AS posttax_total
      FROM prog ${filters}
      GROUP BY payout_date
      ORDER BY payout_date DESC NULLS LAST
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`)).rows as any[];

    const rounds = rows.map(r => {
      const pretax = num(r.pretax_total), posttax = num(r.posttax_total);
      const rc = recalc(pretax);
      return {
        payoutDate: r.payout_date ?? null,
        isUnconfirmed: true,                          // 날짜 기준 재현 그룹(확정 회차 아님)
        label: r.payout_date
          ? (basis === "delivery"
              ? `${r.payout_date} 지급(납품일 필터 적용)`
              : `${r.payout_date} 지급일 기준 재현 그룹`)
          : (basis === "delivery" ? "지급일 미확인(납품일 필터 적용)" : "지급일 미확인 그룹"),
        payeeCount: num(r.payee_count),
        assignmentCount: num(r.assignment_count),
        pretaxTotal: pretax,
        posttaxTotal: posttax,
        withholdingImplied: Math.round((pretax - posttax) * 100) / 100,   // 원본 차액(실제 적용분)
        withholdingRecalc: rc.deduction,                                  // 참고(현재 3.3%)
        withholdingDiff: Math.round((pretax - posttax - rc.deduction) * 100) / 100,
      };
    });
    res.json({ rounds, basis, pagination: { page, pageSize, total: totalRounds, totalPages: Math.max(1, Math.ceil(totalRounds / pageSize)) }, referenceRate: 3.3 });
  } catch (err) { (req as any).log?.error?.({ err }, "payout-reproduction rounds failed"); res.status(500).json({ error: "재현 회차 조회 실패" }); }
});

// ── GET 수행건별 상세(특정 지급일 회차 → 행 단위: 납품일·지급일·통번역사·수행내용·세전·세후·원본공제) ──
//   납품일 기준 조회일 때는 선택 회차(payout_date)에 더해 "동일 납품일 범위" 조건을 그대로 재적용해,
//   화면에 보이는 회차 합계와 상세 합계가 항상 일치하도록 한다(§3·§5). 운영 지급내역 전체가 아님.
router.get("/admin/payout-reproduction/payees", ...adminGuard, async (req, res) => {
  try {
    const qp = req.query as Record<string, string | undefined>;
    const basis = parseBasis(qp.basis);
    const date = qp.date; // 'YYYY-MM-DD' | 'none'(지급일 미확인) | undefined(전체)
    const translator = (qp.translator ?? "").trim();
    const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateFrom ?? "") ? qp.dateFrom! : null;
    const dTo = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateTo ?? "") ? qp.dateTo! : null;

    // 선택 회차 = 실제 지급일 그룹(미확인 포함). 날짜 기준이 납품일이면 납품일 범위도 함께 적용.
    const payoutCond = date === "none" ? sql` AND prog.payout_date IS NULL`
      : (/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? sql` AND prog.payout_date = ${date}` : sql``);
    const deliveryCond = basis === "delivery"
      ? sql`${dFrom ? sql` AND prog.delivery_date >= ${dFrom}` : sql``}${dTo ? sql` AND prog.delivery_date <= ${dTo}` : sql``}`
      : sql``;
    const transCond = translator ? sql` AND prog.translator ILIKE ${"%" + translator + "%"}` : sql``;

    // 행 단위 상세 + 현재 users(translator/linguist) 이름 유일 일치만 참고연결(자동 병합 없음).
    const rows = (await db.execute(sql`${PROG},
      umatch AS (
        SELECT btrim(name) AS nm, min(id) AS uid, count(*)::int AS c
        FROM users WHERE role IN ('translator','linguist') AND btrim(name) <> '' GROUP BY btrim(name)
      )
      SELECT
        prog.id,
        prog.delivery_date,
        prog.payout_date,
        prog.translator,
        prog.product_name,
        prog.language,
        prog.pretax,
        prog.posttax,
        CASE WHEN um.c = 1 THEN um.uid ELSE NULL END AS matched_user_id
      FROM prog
      LEFT JOIN umatch um ON um.nm = prog.translator
      WHERE 1=1 ${payoutCond} ${deliveryCond} ${transCond}
      ORDER BY prog.delivery_date NULLS LAST, prog.payout_date NULLS LAST, prog.translator NULLS LAST, prog.id
      LIMIT 5000`)).rows as any[];

    const items = rows.map(r => {
      const pretax = num(r.pretax), posttax = num(r.posttax);
      const content = [r.product_name, r.language].filter(Boolean).join(" · ") || null;
      return {
        id: num(r.id),
        deliveryDate: r.delivery_date ?? null,
        payoutDate: r.payout_date ?? null,
        translator: r.translator ?? null,
        matchedUserId: r.matched_user_id ?? null,
        matched: r.matched_user_id != null,
        content,
        pretax,
        posttax,
        withholdingImplied: Math.round((pretax - posttax) * 100) / 100,   // 원본 공제액(세전-세후)
      };
    });
    const payeeSet = new Set(items.map(i => i.translator).filter(Boolean));
    const totals = items.reduce((t, p) => ({
      payeeCount: 0,
      assignmentCount: t.assignmentCount + 1,
      pretaxTotal: t.pretaxTotal + p.pretax,
      posttaxTotal: t.posttaxTotal + p.posttax,
      withholdingImpliedTotal: t.withholdingImpliedTotal + p.withholdingImplied,
    }), { payeeCount: 0, assignmentCount: 0, pretaxTotal: 0, posttaxTotal: 0, withholdingImpliedTotal: 0 });
    totals.payeeCount = payeeSet.size;
    res.json({ items, totals, basis, referenceRate: 3.3 });
  } catch (err) { (req as any).log?.error?.({ err }, "payout-reproduction payees failed"); res.status(500).json({ error: "재현 상세 조회 실패" }); }
});

export default router;
