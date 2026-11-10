// ─────────────────────────────────────────────────────────────────────────────
// 통합 지급회차관리 조회 (Phase 1, READ-ONLY) — VERITAS OS
//
// 목적: 과거 CRM(legacy_archive_rows, source_type='progress')과 신규 플랫폼
//       (performance_assignments)의 지급내역을 "지급일별 통합 회차"로 함께 조회·집계한다.
//       각 수행 건은 출처 고유키(legacy:원본ID / current:수행정보ID)로 보존한다.
//
// 안전(절대 규칙 · §2·§12):
//   · DB write 전혀 없음(순수 SELECT 집계). 운영 payout_rounds/items/transfers·지급확정·IBK 미접촉.
//   · 과거 CRM 원본/신규 수행정보 원본 수정·삭제·복사 없음. Master 연결정보 변경 없음.
//   · 지급상태 분류는 "조회 표시"일 뿐 — 지급확정/송금을 발생시키지 않는다.
//   · 과거 '지급완료' 판정 = 납품일 ≤ 2026-09-15(대표 확인) 또는 지급회차 지급일 경과(지급일 < 오늘 KST, 2026-11-08 대표 확정).
//     입금일/입금내역(고객 수금)은 근거 아님. 지급일 당일·미래 → 지급예정 / 지급일 미상 → 지급확인 필요.
//
// 엔드포인트(GET, 읽기 전용):
//   GET /admin/payout-unified/rounds    지급일별 통합 회차 목록(과거+신규, 필터·페이지네이션)
//   GET /admin/payout-unified/payees    특정 지급일 회차의 건별 상세 + 통번역사(Master)별 통합 집계
//        (지급명세서 메뉴 공용) date 미지정 + basis=payout 이면 지급일 기간(dateFrom~dateTo)으로 조회,
//        q = 통합 검색(통번역사명·거래처·지급일, 연락처 열람 권한자는 이메일·연락처 포함). 기존 호출(date 지정)은 결과 불변.
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, calcPayoutWithholding } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole, requireStaffPermission } from "../middlewares/auth";
import { getPermissionsForRole } from "../lib/rbac";
import { isLegacyPlaceholderEmail } from "../lib/mailer";
import { LEGACY_PAID_DELIVERY_CUTOFF, LEGACY_PAID_BASIS, LEGACY_PAID_BY_ROUND_BASIS } from "../lib/legacyPayoutRule";
import { conversionsByRow } from "../services/legacyPayoutConversion";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const REFERENCE_TREATMENT = "domestic_3_3" as const;

// ── 과거 CRM 지급완료 판정 기준 — lib/legacyPayoutRule.ts(SSOT) 참조 ───────────────
//   · 지급완료 = 납품일 ≤ 2026-09-15(대표 확인) 또는 지급일 < 오늘(KST) — 과거 CRM 은 별도 지급파일로 송금(대표 확정).
//     입금일/입금내역은 '고객 수금' 기록이므로 지급 증빙이 아니다.
//   · 그 외: 지급일 ≥ 오늘(KST, 당일 포함) → 지급예정 · 지급일 미상 → 지급확인 필요.
//   · 최신 CRM 파일 기준 동기화로 삭제(비활성)된 행은 is_effective=false → 지급대상·회차 집계에서 자동 제외.
//   · 원본(legacy_archive_rows) 불변 — 조회/표시 전용 판정. 신규 지급거래·지급회차 생성 없음(§5).
//   · 신규 플랫폼(current) 건에는 이 기준을 적용하지 않는다(payment_status 그대로 — 지급회차 [지급완료]로만 paid).

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function parseBasis(v: unknown): "payout" | "delivery" { return v === "payout" ? "payout" : "delivery"; } // 기본값 = 납품일(§5)
function recalcDeduction(pretax: number): number { return calcPayoutWithholding(pretax, "individual", REFERENCE_TREATMENT, null).deduction; }

// ── 마스킹(응답엔 마스킹본만, 권한자만 전체값) ──────────────────────────────────
function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null; let d = String(raw).replace(/[^0-9]/g, "");
  if (d.startsWith("82")) d = "0" + d.slice(2);
  if (d.length < 7) return d ? "*".repeat(d.length) : null;
  return d.slice(0, 3) + "-****-" + d.slice(-4);
}
function maskEmail(raw: string | null | undefined): string | null {
  if (isLegacyPlaceholderEmail(raw)) return null;
  const e = (raw ?? "").trim(); if (!e || !e.includes("@")) return e ? "***" : null;
  const [local, domain] = e.split("@");
  return `${(local.slice(0, 1) || "*")}***@${domain}`;
}
function phoneFull(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim(); if (!t) return null;
  let d = t.replace(/[^0-9]/g, ""); if (d.startsWith("82")) d = "0" + d.slice(2);
  if (/^01[016789]\d{7,8}$/.test(d)) return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (/^02\d{7,8}$/.test(d)) return `02-${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  return t;
}
function emailFull(raw: string | null | undefined): string | null { if (isLegacyPlaceholderEmail(raw)) return null; const e = (raw ?? "").trim(); return e || null; }

// 과거 진행관리(progress) 정규화 — 원본 불변. 입금일/입금내역 = 고객 수금 기록(지급 증빙 아님).
const PROG = sql`
  prog AS (
    SELECT
      id,
      'legacy:' || id AS source_key,
      nullif(btrim(source_raw->>'통번역사명'), '') AS translator,
      nullif(btrim(source_raw->>'거래처명'), '') AS client,
      substring(source_raw->>'통번역사지급일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS payout_date,
      substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS delivery_date,
      nullif(btrim(source_raw->>'상품명'), '') AS product_name,
      nullif(btrim(source_raw->>'언어'), '') AS language,
      nullif(btrim(source_raw->>'파일명'), '') AS filename,
      nullif(btrim(source_raw->>'연락처'), '') AS orig_phone,
      CASE WHEN regexp_replace(coalesce(source_raw->>'주민등록번호',''), '[^0-9]', '', 'g') ~ '^[0-9]{6}'
           THEN substring(regexp_replace(source_raw->>'주민등록번호','[^0-9]','','g') from 1 for 6) || '-*******' ELSE NULL END AS rrn_masked,
      (source_raw->>'파일명' ILIKE '%급여%' OR source_raw->>'파일명' ILIKE '%근로소득%') AS is_payroll,
      -- 고객 수금 기록(입금일 또는 입금내역) 존재 — 검증 참고 정보. ※ 통번역사 지급 증빙이 아니다(지급완료 판정에 사용 금지).
      (nullif(btrim(source_raw->>'입금일'),'') IS NOT NULL OR nullif(btrim(source_raw->>'입금내역'),'') IS NOT NULL) AS has_deposit,
      -- 지급완료 판정(과거 CRM): 납품일 ≤ 2026-09-15(대표 확인)만. 납품일 누락/무효 → false(자동 지급완료 안 함).
      --   + (2026-11-08) 지급회차 지급일 경과(지급일 < 오늘 KST) — 과거 CRM 지급건 한정(별도 지급파일 처리분). 지급일 당일은 지급예정.
      (coalesce(substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') <= ${LEGACY_PAID_DELIVERY_CUTOFF}, false)
        OR coalesce(substring(source_raw->>'통번역사지급일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') < to_char((now() AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD'), false)) AS legacy_paid,
      coalesce(substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') <= ${LEGACY_PAID_DELIVERY_CUTOFF}, false) AS legacy_paid_cutoff,
      -- 지급예정: 지급일이 오늘(KST) 당일 또는 이후. 지급일 미상은 지급확인 필요(지급일 경과는 위 legacy_paid).
      coalesce(substring(source_raw->>'통번역사지급일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') >= to_char((now() AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD'), false) AS payout_future,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지급액(세전)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS pretax,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지금액(세후)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS posttax
    FROM legacy_archive_rows WHERE source_type = 'progress' AND is_effective = true
      -- 운영 지급으로 넘어간 과거 수행행 제외(중복 집계 방지): 과거 판매 운영 전환 후 '과거 지급 확인 → 미지급'으로 처리된 건
      --   (과거 CRM 지급 전환 승인 포함)은 운영 수행정보(cur)로만 집계한다. 원본 행은 그대로 보존.
      AND NOT EXISTS (SELECT 1 FROM import_row_sources s JOIN performance_assignments xpa ON xpa.id = s.entity_id AND xpa.deleted_at IS NULL
        WHERE s.module = 'legacy_sale_activation' AND s.row_key = 'progress:' || legacy_archive_rows.id AND s.status = 'payout_review_unpaid')
  )`;

// 신규 수행정보(performance_assignments) 정규화 — 지급일 = 지급예정일(자동/수동). 거래처 = 프로젝트 거래처 스냅샷.
const CUR = sql`
  cur AS (
    SELECT
      pa.id,
      'current:' || pa.id AS source_key,
      coalesce(nullif(btrim(pa.performer_name_snapshot), ''), cu.name) AS translator,
      -- 거래처 = 수행정보가 속한 판매건(프로젝트)의 거래처. 공식 지급회차(payoutRounds)와 같은 기준:
      --   ① 프로젝트 거래처명 스냅샷 → ② 프로젝트 거래처 Master(company_id) → ③ 이 수행건에 연결된 견적서의 거래처(파생·고객사명).
      --   (의뢰접수→견적→판매전환 경로는 스냅샷이 비어 있는 경우가 있어 ①만 보면 '거래처 확인 필요'로 표시되던 오류 수정)
      --   이름·통번역사·납품일 유사성으로 다른 판매건을 추정 연결하지 않는다(모두 ID 관계만 사용).
      coalesce(nullif(btrim(p.company_name_snapshot), ''), nullif(btrim(pco.name), ''),
        nullif(btrim(q.derived_company_name_snapshot), ''), nullif(btrim(q.customer_company_name), '')) AS client,
      to_char(coalesce(pa.expected_payment_date, pa.expected_payment_date_auto), 'YYYY-MM-DD') AS payout_date,
      to_char(coalesce(pa.delivery_date, pa.delivery_date_auto), 'YYYY-MM-DD') AS delivery_date,
      pa.product_name_snapshot AS product_name,
      pa.language_or_service_snapshot AS language,
      pa.individual_user_id AS master_user_id,
      pa.vendor_company_id AS vendor_company_id,
      cu.email AS master_email, tp.phone AS master_phone, tp.language_pairs AS master_langpairs,
      pa.payment_status::text AS payment_status,
      pa.payout_round_id,
      coalesce(pa.cost_total, 0) AS pretax,
      coalesce(pa.net_payment, pa.cost_total - pa.withholding_tax, 0) AS posttax,
      pa.withholding_tax AS withholding_tax   -- 저장된 원천세(세전−세후 중 원천세 부분, 나머지는 기타 공제)
    FROM performance_assignments pa
    LEFT JOIN projects p ON p.id = pa.project_id
    LEFT JOIN companies pco ON pco.id = p.company_id
    LEFT JOIN quotes q ON q.id = pa.quote_id
    LEFT JOIN users cu ON cu.id = pa.individual_user_id
    LEFT JOIN translator_profiles tp ON tp.user_id = pa.individual_user_id
    WHERE pa.deleted_at IS NULL
      -- 과거 판매 운영 전환으로 만들어진 수행정보 중 운영 지급으로 넘어오지 않은 건(과거 지급완료·지급 확인 필요 등)은 제외 —
      --   같은 거래가 과거 CRM 행(prog)으로 이미 집계되므로 중복 집계 방지. '미지급' 확인된 건(지급 전환 승인 포함)만 운영 건으로 집계.
      AND NOT EXISTS (SELECT 1 FROM import_row_sources s WHERE s.module = 'legacy_sale_activation' AND s.entity_id = pa.id
        AND s.row_key LIKE 'progress:%' AND s.status <> 'payout_review_unpaid')
  )`;

// 지급상태 코드 — 실제 '지급' 여부만 나타낸다(검증상태와 분리).
//   paid 지급완료(과거: 납품일 ≤ cutoff 대표 확인 / 신규: 지급회차 [지급완료] 처리된 payment_status=paid)
//   · scheduled 지급예정(과거: 지급일이 미래, 지급확정 기록 없음)
//   · deposit_unconfirmed 지급확인 필요(과거: 지급일 경과·미상인데 지급확정 기록 없음) — 코드값은 호환 위해 유지
//   · pending 지급대기(신규 미지급) · excluded 지급 제외(신규 보류) · dup_suspect 중복 의심.
//   ※ hasDeposit = 고객 수금 기록 유무(검증 참고). 통번역사 지급 여부와 무관하며 지급상태에 섞지 않는다.
type PayStatus = "paid" | "scheduled" | "deposit_unconfirmed" | "pending" | "excluded" | "dup_suspect";
const STATUS_LABEL: Record<PayStatus, string> = {
  paid: "지급완료", scheduled: "지급예정", deposit_unconfirmed: "지급확인 필요",
  pending: "지급대기", excluded: "지급 제외", dup_suspect: "중복 의심",
};
function legacyStatus(r: { legacy_paid?: unknown; payout_future?: unknown }): PayStatus {
  if (r.legacy_paid === true) return "paid";
  return r.payout_future === true ? "scheduled" : "deposit_unconfirmed";
}

// ── 지급상태 4분류(지급회차관리 건수 집계 · 지급명세서와 같은 지급완료 판정) ───────────────────────
//   수행건 1건 = 1분류. paid(지급완료) | unpaid(미지급: 신규 지급예정일 경과·미지급) | scheduled(지급예정: 지급일 도래 전 미완료)
//   | review(확인필요: 과거 지급일 없음·신규 지급보류·지급일 없음·중복 의심). 지급완료 판정은 status(기존 PROG/CUR 규칙) 그대로.
//   표시용 집계일 뿐 — 지급상태·금액·기록을 바꾸지 않는다. 보류·확인필요 건을 미지급으로 보지 않는다.
export type PayBucket = "paid" | "unpaid" | "scheduled" | "review";
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
function payBucket(it: { source: string; status: string; payoutDate: string | null }, today: string): PayBucket {
  if (it.status === "paid") return "paid";
  if (it.status === "scheduled") return "scheduled";
  if (it.status === "pending" && it.payoutDate) return it.payoutDate < today ? "unpaid" : "scheduled";
  return "review";   // deposit_unconfirmed · excluded(지급보류) · dup_suspect · 지급일 없는 신규 미지급
}

// 날짜 범위 필터(선택 기준 컬럼에 적용). 그룹핑은 항상 실제 지급일(payout_date).
function rangeCond(basis: "payout" | "delivery", dFrom: string | null, dTo: string | null) {
  const col = basis === "delivery" ? sql`delivery_date` : sql`payout_date`;
  return sql`${dFrom ? sql` AND ${col} >= ${dFrom}` : sql``}${dTo ? sql` AND ${col} <= ${dTo}` : sql``}`;
}

// ── GET 통합 회차 목록 ─────────────────────────────────────────────────────────
router.get("/admin/payout-unified/rounds", ...adminGuard, requireStaffPermission(["payout.view", "payout.statement"], { allowStaffWithoutRole: true }), async (req, res) => {
  try {
    const qp = req.query as Record<string, string | undefined>;
    const basis = parseBasis(qp.basis);
    const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateFrom ?? "") ? qp.dateFrom! : null;
    const dTo = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateTo ?? "") ? qp.dateTo! : null;
    const translator = (qp.translator ?? "").trim();
    const client = (qp.client ?? "").trim();
    const source = (qp.source ?? "all").trim(); // all | legacy | current
    const page = Math.max(1, parseInt(String(qp.page ?? "1"), 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(String(qp.pageSize ?? "50"), 10) || 50));

    const filters = sql`WHERE 1=1
      ${rangeCond(basis, dFrom, dTo)}
      ${translator ? sql` AND translator ILIKE ${"%" + translator + "%"}` : sql``}
      ${client ? sql` AND client ILIKE ${"%" + client + "%"}` : sql``}`;

    // 과거 집계 — 지급완료(대표 확인 cutoff)/지급예정/확인필요 구분.
    const legacyRows = source === "current" ? [] : (await db.execute(sql`WITH ${PROG}
      SELECT payout_date,
        count(*)::int AS cnt,
        count(DISTINCT translator) FILTER (WHERE translator IS NOT NULL)::int AS payees,
        coalesce(sum(pretax),0) AS pretax_total, coalesce(sum(posttax),0) AS posttax_total,
        coalesce(sum(pretax) FILTER (WHERE legacy_paid),0) AS paid_total,
        count(*) FILTER (WHERE NOT legacy_paid AND NOT payout_future)::int AS need_review_cnt,
        count(*) FILTER (WHERE NOT legacy_paid AND payout_future)::int AS scheduled_cnt,
        coalesce(sum(pretax) FILTER (WHERE NOT legacy_paid AND payout_future),0) AS scheduled_total,
        count(*) FILTER (WHERE legacy_paid)::int AS paid_cnt
      FROM prog ${filters} GROUP BY payout_date`)).rows as any[];

    // 신규 집계 — paid/unpaid/hold.
    const curRows = source === "legacy" ? [] : (await db.execute(sql`WITH ${CUR}
      SELECT payout_date,
        count(*)::int AS cnt,
        count(DISTINCT translator) FILTER (WHERE translator IS NOT NULL)::int AS payees,
        coalesce(sum(pretax),0) AS pretax_total, coalesce(sum(posttax),0) AS posttax_total,
        coalesce(sum(pretax) FILTER (WHERE payment_status='paid'),0) AS paid_total,
        coalesce(sum(pretax) FILTER (WHERE payment_status='unpaid'),0) AS unpaid_total,
        count(*) FILTER (WHERE payment_status='payment_hold')::int AS excluded_cnt,
        count(*) FILTER (WHERE payment_status='paid')::int AS paid_cnt,
        count(*) FILTER (WHERE payment_status='unpaid' AND payout_date < ${kstToday()})::int AS overdue_cnt,
        count(*) FILTER (WHERE payment_status='unpaid' AND payout_date >= ${kstToday()})::int AS future_cnt
      FROM cur ${filters} GROUP BY payout_date`)).rows as any[];

    // 지급일별 병합(과거+신규). 지급일 null → '지급일 미확인'.
    const map = new Map<string, any>();
    const key = (d: any) => d ?? "__none__";
    for (const r of legacyRows) {
      const k = key(r.payout_date); const g = map.get(k) ?? { payoutDate: r.payout_date ?? null, cnt: 0, payees: new Set<string>(), pretax: 0, posttax: 0, paid: 0, unpaid: 0, needReview: 0, excluded: 0, scheduled: 0, scheduledTotal: 0, legacyCnt: 0, currentCnt: 0, sc: { paid: 0, unpaid: 0, scheduled: 0, review: 0 } };
      g.cnt += num(r.cnt); g.pretax += num(r.pretax_total); g.posttax += num(r.posttax_total);
      g.paid += num(r.paid_total); g.needReview += num(r.need_review_cnt); g.legacyCnt += num(r.cnt);
      g.scheduled += num(r.scheduled_cnt); g.scheduledTotal += num(r.scheduled_total);
      g.sc.paid += num(r.paid_cnt); g.sc.scheduled += num(r.scheduled_cnt); g.sc.review += num(r.need_review_cnt);
      map.set(k, g);
    }
    for (const r of curRows) {
      const k = key(r.payout_date); const g = map.get(k) ?? { payoutDate: r.payout_date ?? null, cnt: 0, payees: new Set<string>(), pretax: 0, posttax: 0, paid: 0, unpaid: 0, needReview: 0, excluded: 0, scheduled: 0, scheduledTotal: 0, legacyCnt: 0, currentCnt: 0, sc: { paid: 0, unpaid: 0, scheduled: 0, review: 0 } };
      g.cnt += num(r.cnt); g.pretax += num(r.pretax_total); g.posttax += num(r.posttax_total);
      g.paid += num(r.paid_total); g.unpaid += num(r.unpaid_total); g.excluded += num(r.excluded_cnt); g.currentCnt += num(r.cnt);
      g.sc.paid += num(r.paid_cnt); g.sc.unpaid += num(r.overdue_cnt); g.sc.scheduled += num(r.future_cnt);
      g.sc.review += num(r.cnt) - num(r.paid_cnt) - num(r.overdue_cnt) - num(r.future_cnt);   // 지급보류·지급일 없음 등
      map.set(k, g);
    }
    // payees(인원)는 과거/신규가 같은 Master면 중복 셈 방지를 위해 상세에서 정확 계산 → 여기선 이름기준 근사치(표시용).
    const all = [...map.values()].sort((a, b) => (b.payoutDate ?? "").localeCompare(a.payoutDate ?? "") || (a.payoutDate ? 0 : 1));
    const total = all.length;
    const paged = all.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    const rounds = paged.map(g => {
      const withholdingImplied = Math.round((g.pretax - g.posttax) * 100) / 100;
      return {
        payoutDate: g.payoutDate,
        label: g.payoutDate ? `${g.payoutDate} 지급` : "지급일 미확인",
        payeeCount: 0, // 상세 집계에서 Master 기준 정확값 제공(목록은 건수·금액 중심)
        assignmentCount: g.cnt,
        legacyCount: g.legacyCnt, currentCount: g.currentCnt,
        pretaxTotal: g.pretax, posttaxTotal: g.posttax,
        withholdingImplied,
        withholdingRecalc: recalcDeduction(g.pretax),
        paidTotal: g.paid, unpaidTotal: g.unpaid, needReviewCount: g.needReview, excludedCount: g.excluded,
        scheduledCount: g.scheduled, scheduledTotal: g.scheduledTotal,
        statusCounts: g.sc,   // 지급상태 4분류 건수(합계 = assignmentCount)
      };
    });
    res.json({ rounds, basis, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }, referenceRate: 3.3 });
  } catch (err) { (req as any).log?.error?.({ err }, "payout-unified rounds failed"); res.status(500).json({ error: "통합 회차 조회 실패" }); }
});

// ── 통합 지급자료 수집(과거 CRM + 신규) — /payees(지급회차 관리·지급명세서)와 세무자료(/admin/tax-report)가 공유하는 단일 판정 ──
//   · 지급상태(paid/scheduled/…)·Master 연결·중복 의심 판정은 모두 여기서만 수행한다(화면별 재판정 금지).
//   · 순수 SELECT — 쓰기 없음.
export type UnifiedItem = Record<string, any> & {
  source: "legacy" | "current"; sourceKey: string; id: number; payoutDate: string | null; deliveryDate: string | null;
  translator: string | null; matchStatus: string; matchedUserId: number | null; masterKey: string; confirmed: boolean;
  pretax: number; posttax: number; withholdingImplied: number; status: string; residentMasked: string | null;
};
export async function collectUnifiedItems(opts: {
  basis: "payout" | "delivery"; date?: string; translator?: string; client?: string; source?: string;
  dFrom: string | null; dTo: string | null; q?: string; canViewFullContact: boolean; limit?: number;
}): Promise<{ items: UnifiedItem[]; legacyCount: number; currentCount: number }> {
  const { basis, date, dFrom, dTo, canViewFullContact } = opts;
  const translator = (opts.translator ?? "").trim(), client = (opts.client ?? "").trim(), source = (opts.source ?? "all").trim();
  const q = (opts.q ?? "").trim().slice(0, 100);
  const limit = Math.max(1, Math.min(100000, opts.limit ?? 5000));
  const payoutCond = date === "none" ? sql` AND payout_date IS NULL`
    : (/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? sql` AND payout_date = ${date}` : sql``);
  const deliveryCond = basis === "delivery" ? rangeCond("delivery", dFrom, dTo)
    // 지급명세서 메뉴: 회차(date) 미지정 + 지급일 기준이면 지급일 기간 적용(지급회차 관리는 항상 date 지정 → 영향 없음)
    : (date == null || date === "" ? rangeCond("payout", dFrom, dTo) : sql``);
  // 통합 검색(q) — 이름·거래처·지급일. 이메일·연락처 검색은 연락처 전체 열람 권한자만(마스킹 우회 방지).
  const qLike = "%" + q + "%";
  // 연락처 검색은 검색어가 전화번호 형태(숫자·공백·하이픈·괄호·+ 만, 숫자 4자리 이상)일 때만 — 이메일 등에 섞인 숫자로 오검색 방지
  const qDigits = /^[0-9\s\-()+.]+$/.test(q) ? q.replace(/[^0-9]/g, "") : "";
  const digitsLike = (col: ReturnType<typeof sql>) => sql` OR regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g') LIKE ${"%" + qDigits + "%"}`;
  const legacyQ = !q ? sql`` : sql` AND (prog.translator ILIKE ${qLike} OR prog.client ILIKE ${qLike} OR prog.payout_date LIKE ${q + "%"}
    ${canViewFullContact ? sql` OR mu.email ILIKE ${qLike} OR nu.email ILIKE ${qLike}` : sql``}
    ${canViewFullContact && qDigits.length >= 4 ? sql`${digitsLike(sql`prog.orig_phone`)}${digitsLike(sql`mtp.phone`)}${digitsLike(sql`ntp.phone`)}` : sql``})`;
  const curQ = !q ? sql`` : sql` AND (translator ILIKE ${qLike} OR client ILIKE ${qLike} OR payout_date LIKE ${q + "%"}
    ${canViewFullContact ? sql` OR master_email ILIKE ${qLike}` : sql``}
    ${canViewFullContact && qDigits.length >= 4 ? digitsLike(sql`master_phone`) : sql``})`;

  const common = sql`${payoutCond} ${deliveryCond}
    ${translator ? sql` AND translator ILIKE ${"%" + translator + "%"}` : sql``}
    ${client ? sql` AND client ILIKE ${"%" + client + "%"}` : sql``}`;

  // 과거 상세 — Master 연결(확정매핑>이름유일후보) + 거래처/파일명/연락처/입금증빙.
  const legacyItems = source === "current" ? [] : (await db.execute(sql`WITH ${PROG},
    umatch AS (SELECT btrim(name) AS nm, min(id) AS uid, count(*)::int AS c FROM users WHERE role IN ('translator','linguist') AND btrim(name) <> '' GROUP BY btrim(name)),
    -- 연결 판정(§1): 롤백되지 않은 모든 Master 매핑(active/confirmed)을 '연결됨'으로 인정.
    --   active 는 import/재구축으로 명시 기록된 유효 매핑(기본상태)이며, 다른 모듈(merge/dedup/delete)도 status<>'rolled_back'을 유효 연결로 취급한다.
    --   ※ '이름만 일치'는 여기 포함되지 않는다(아래 umatch 후보로만) → 자동 연결·병합 아님.
    lmm AS (SELECT legacy_id, entity_id FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='translator' AND status <> 'rolled_back'),
    comp AS (SELECT btrim(name) AS nm, bool_or(is_vendor) AS is_vendor FROM companies WHERE btrim(name) <> '' GROUP BY btrim(name))
    SELECT prog.*, lmm.entity_id AS mapped_user_id, mu.name AS mapped_user_name, mu.email AS mapped_email, mtp.phone AS mapped_phone, mtp.language_pairs AS mapped_langpairs,
      CASE WHEN um.c=1 THEN um.uid ELSE NULL END AS name_user_id, nu.name AS name_user_name, nu.email AS name_email, ntp.phone AS name_phone,
      comp.is_vendor AS comp_vendor, (comp.nm IS NOT NULL) AS is_company
    FROM prog
    LEFT JOIN lmm ON lmm.legacy_id = prog.translator
    LEFT JOIN users mu ON mu.id = lmm.entity_id
    LEFT JOIN translator_profiles mtp ON mtp.user_id = lmm.entity_id
    LEFT JOIN umatch um ON um.nm = prog.translator
    LEFT JOIN users nu ON nu.id = (CASE WHEN um.c=1 THEN um.uid ELSE NULL END)
    LEFT JOIN translator_profiles ntp ON ntp.user_id = (CASE WHEN um.c=1 THEN um.uid ELSE NULL END)
    LEFT JOIN comp ON comp.nm = prog.translator
    WHERE 1=1 ${common} ${legacyQ}
    ORDER BY prog.delivery_date NULLS LAST, prog.translator NULLS LAST, prog.id LIMIT ${limit}`)).rows as any[];

  const curItems = source === "legacy" ? [] : (await db.execute(sql`WITH ${CUR}
    SELECT cur.* FROM cur WHERE 1=1 ${common} ${curQ} ORDER BY delivery_date NULLS LAST, translator NULLS LAST, id LIMIT ${limit}`)).rows as any[];

  // 통합 매핑 → 공통 아이템 형태.
  const items = [
    ...legacyItems.map((r) => {
      const pretax = num(r.pretax), posttax = num(r.posttax);
      const content = [r.product_name, r.language].filter(Boolean).join(" · ") || null;
      let language: string | null = r.language ?? null; let languageSource: "original" | "master" | null = r.language ? "original" : null;
      if (!language && r.mapped_user_id != null && r.mapped_langpairs) { language = r.mapped_langpairs; languageSource = "master"; }
      let matchStatus: string, matchedUserId: number | null = null, matchedUserName: string | null = null, masterEmail: string | null = null, masterPhone: string | null = null;
      if (r.mapped_user_id != null) { matchStatus = "confirmed"; matchedUserId = num(r.mapped_user_id); matchedUserName = r.mapped_user_name ?? null; masterEmail = canViewFullContact ? emailFull(r.mapped_email) : maskEmail(r.mapped_email); masterPhone = canViewFullContact ? phoneFull(r.mapped_phone) : maskPhone(r.mapped_phone); }
      else if (r.name_user_id != null) { matchStatus = "candidate"; matchedUserId = num(r.name_user_id); matchedUserName = r.name_user_name ?? null; masterEmail = canViewFullContact ? emailFull(r.name_email) : maskEmail(r.name_email); masterPhone = canViewFullContact ? phoneFull(r.name_phone) : maskPhone(r.name_phone); }
      else if (r.comp_vendor === true) matchStatus = "vendor";
      else if (r.is_company === true) matchStatus = "client";
      else matchStatus = "unmatched";
      // Master 키: 연결된 건(active/confirmed 매핑)만 Master 기준 합산. 미연결은 이름키로 별도(자동병합 아님).
      const masterKey = r.mapped_user_id != null ? `m:${r.mapped_user_id}` : `n:${r.translator ?? "?"}`;
      // 지급상태(과거 CRM, PROG 판정과 동일) — 지급완료는 납품일 ≤ cutoff(대표 확인)만. 입금내역(고객 수금)은 근거 아님.
      const status: PayStatus = legacyStatus(r);
      const paidBasis: string | null = !r.legacy_paid ? null : r.legacy_paid_cutoff ? LEGACY_PAID_BASIS : LEGACY_PAID_BY_ROUND_BASIS;
      return {
        source: "legacy", sourceKey: r.source_key, id: num(r.id),
        deliveryDate: r.delivery_date ?? null, payoutDate: r.payout_date ?? null,
        client: r.client ?? null, translator: r.translator ?? null,
        residentMasked: r.rrn_masked ?? null, language, languageSource,
        masterEmail, masterPhone, originalPhone: canViewFullContact ? phoneFull(r.orig_phone) : maskPhone(r.orig_phone),
        matchStatus, matchedUserId, matchedUserName, masterKey, confirmed: matchStatus === "confirmed",
        isPayroll: r.is_payroll === true, content, filename: r.filename ?? null,
        pretax, posttax, withholdingImplied: Math.round((pretax - posttax) * 100) / 100,
        withholdingTax: null,   // 과거 CRM: 원천세·기타공제 분리 정보 없음(세전−세후만 존재) — 추정 분리 금지
        status, statusLabel: STATUS_LABEL[status], hasDeposit: r.has_deposit === true, paidBasis,
        // 통번역사 Master 가능언어(확정 연결 건만, 원문 그대로) — 지급명세서 상단 언어 표시용. 이름만 같은 후보는 사용하지 않음.
        masterLanguages: r.mapped_user_id != null ? (r.mapped_langpairs ?? null) : null,
      };
    }),
    ...curItems.map((r) => {
      const pretax = num(r.pretax), posttax = num(r.posttax);
      const content = [r.product_name, r.language].filter(Boolean).join(" · ") || null;
      const ps = String(r.payment_status);
      const status: PayStatus = ps === "paid" ? "paid" : ps === "payment_hold" ? "excluded" : "pending";
      const confirmed = r.master_user_id != null; // 신규는 배정 시점에 Master 직접 연결(확정)
      return {
        source: "current", sourceKey: r.source_key, id: num(r.id),
        deliveryDate: r.delivery_date ?? null, payoutDate: r.payout_date ?? null,
        client: r.client ?? null, translator: r.translator ?? null,
        residentMasked: null, language: r.language ?? null, languageSource: r.language ? "original" : null,
        masterLanguages: r.master_langpairs ?? null,   // 통번역사 Master 가능언어(지급명세서 상단 표시용)
        masterEmail: canViewFullContact ? emailFull(r.master_email) : maskEmail(r.master_email),
        masterPhone: canViewFullContact ? phoneFull(r.master_phone) : maskPhone(r.master_phone), originalPhone: null,
        matchStatus: confirmed ? "confirmed" : (r.vendor_company_id != null ? "vendor" : "unmatched"),
        matchedUserId: r.master_user_id != null ? num(r.master_user_id) : null, matchedUserName: r.translator ?? null,
        masterKey: r.master_user_id != null ? `m:${r.master_user_id}` : (r.vendor_company_id != null ? `v:${r.vendor_company_id}` : `n:${r.translator ?? "?"}`),
        confirmed, isPayroll: false, content, filename: null,
        pretax, posttax, withholdingImplied: Math.round((pretax - posttax) * 100) / 100,
        withholdingTax: r.withholding_tax == null ? null : num(r.withholding_tax),   // 저장 원천세(기타 공제 = 세전−세후−원천세)
        status, statusLabel: STATUS_LABEL[status], hasDeposit: ps === "paid", paidBasis: ps === "paid" ? "지급회차 지급완료 처리" : null,
      };
    }),
  ];

  // ── 중복 의심(§9) — 과거↔신규 교차. 동일 (Master, 납품일, 세전반올림, 거래처) → 양쪽 dup_suspect. 자동 삭제/제외 없음.
  const dupIndex = new Map<string, { legacy: number[]; current: number[] }>();
  items.forEach((it, idx) => {
    if (it.matchedUserId == null || !it.deliveryDate) return;
    // 회차(date) 미지정 조회(지급명세서 기간 조회)는 지급일까지 키에 포함 → 지급일별 회차 상세와 동일한 판정 범위 유지.
    const k = `${it.matchedUserId}|${it.deliveryDate}|${Math.round(it.pretax)}|${(it.client ?? "").trim()}${date ? "" : `|${it.payoutDate ?? ""}`}`;
    const b = dupIndex.get(k) ?? { legacy: [], current: [] };
    (it.source === "legacy" ? b.legacy : b.current).push(idx); dupIndex.set(k, b);
  });
  let dupSuspectCount = 0;
  for (const b of dupIndex.values()) {
    if (b.legacy.length > 0 && b.current.length > 0) { // 교차 출처에 동일 건 → 중복 의심
      for (const i of [...b.legacy, ...b.current]) { (items[i] as any).dupSuspect = true; (items[i] as any).status = "dup_suspect"; (items[i] as any).statusLabel = STATUS_LABEL.dup_suspect; dupSuspectCount++; }
    }
  }
  items.forEach((it) => { if ((it as any).dupSuspect == null) (it as any).dupSuspect = false; });
  const today = kstToday();
  for (const it of items as any[]) it.payBucket = payBucket(it, today);
  // 과거 CRM 지급 전환(은행이체) — 수행행별 최근 요청·승인·반려 상태 + 요청 가능 여부(지급일 없음·지급확인 필요·지급액>0).
  //   판매건 연결 등 세부 조건은 요청 시 서버에서 다시 확인한다. 표시 전용(지급상태·금액 불변).
  const conv = await conversionsByRow(db, items.filter((it) => it.source === "legacy").map((it) => it.id));
  for (const it of items as any[]) {
    if (it.source !== "legacy") continue;
    it.conversion = conv.get(it.id) ?? null;
    it.conversionEligible = it.status === "deposit_unconfirmed" && !it.payoutDate && it.pretax > 0
      && !(it.conversion && (it.conversion.status === "requested" || it.conversion.status === "approved"));
  }
  return { items: items as UnifiedItem[], legacyCount: legacyItems.length, currentCount: curItems.length };
}

// ── GET 건별 상세 + 통번역사(Master)별 통합 집계 ───────────────────────────────
router.get("/admin/payout-unified/payees", ...adminGuard, requireStaffPermission(["payout.view", "payout.statement"], { allowStaffWithoutRole: true }), async (req, res) => {
  try {
    const qp = req.query as Record<string, string | undefined>;
    const basis = parseBasis(qp.basis);
    const date = qp.date; // 'YYYY-MM-DD' | 'none' | undefined
    const translator = (qp.translator ?? "").trim();
    const client = (qp.client ?? "").trim();
    const source = (qp.source ?? "all").trim();
    const statusFilter = (qp.status ?? "all").trim();
    const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateFrom ?? "") ? qp.dateFrom! : null;
    const dTo = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateTo ?? "") ? qp.dateTo! : null;

    const user = req.user!;
    let canViewFullContact = user.role === "admin" && !user.roleId;
    if (!canViewFullContact && user.roleId) { try { canViewFullContact = (await getPermissionsForRole(user.roleId)).has("translator.sensitive"); } catch { canViewFullContact = false; } }

    const { items, legacyCount, currentCount } = await collectUnifiedItems({
      basis, date, translator, client, source, dFrom, dTo, q: (qp.q ?? "").trim().slice(0, 100), canViewFullContact,
    });

    // 상태 필터(조회 후 적용 — 집계는 전체 기준, 표시만 필터).
    const shown = statusFilter === "all" ? items : items.filter(i => (i as any).status === statusFilter);

    // ── 통번역사(Master)별 통합 집계(§8) — 확정 연결 기준 masterKey. 미확정은 이름키로 분리.
    const groups = new Map<string, any>();
    for (const it of items) {
      const g = groups.get(it.masterKey) ?? { masterKey: it.masterKey, name: it.translator ?? "(이름 미상)", confirmed: it.confirmed, matchStatus: it.matchStatus, matchedUserId: it.matchedUserId, email: it.masterEmail ?? null, phone: it.masterPhone ?? it.originalPhone ?? null, count: 0, pretax: 0, posttax: 0, paidPretax: 0, unpaidPretax: 0, paidCount: 0, unpaidCount: 0, needReview: 0, dupSuspect: 0, scheduled: 0, sources: new Set<string>(), languages: new Set<string>() };
      g.count++; g.pretax += it.pretax; g.posttax += it.posttax; g.sources.add(it.source); if (it.language) g.languages.add(it.language);
      if ((it as any).status === "paid") { g.paidPretax += it.pretax; g.paidCount++; }
      else if ((it as any).status === "pending") { g.unpaidPretax += it.pretax; g.unpaidCount++; }
      else if ((it as any).status === "deposit_unconfirmed") g.needReview++;
      else if ((it as any).status === "scheduled") g.scheduled++;
      if ((it as any).status === "dup_suspect") g.dupSuspect++;
      if (!g.email && it.masterEmail) g.email = it.masterEmail; if (!g.phone && (it.masterPhone || it.originalPhone)) g.phone = it.masterPhone ?? it.originalPhone;
      groups.set(it.masterKey, g);
    }
    const payees = [...groups.values()].map(g => ({
      masterKey: g.masterKey, name: g.name, confirmed: g.confirmed, matchStatus: g.matchStatus, matchedUserId: g.matchedUserId,
      email: g.email, phone: g.phone, count: g.count,
      pretaxTotal: g.pretax, posttaxTotal: g.posttax, withholdingImplied: Math.round((g.pretax - g.posttax) * 100) / 100,
      paidPretax: g.paidPretax, unpaidPretax: g.unpaidPretax, paidCount: g.paidCount, unpaidCount: g.unpaidCount, needReviewCount: g.needReview, dupSuspectCount: g.dupSuspect,
      scheduledCount: g.scheduled,
      sources: [...g.sources], languages: [...g.languages],   // 해당 회차 수행 언어(중복 제거). 없으면 빈 배열.
    })).sort((a, b) => a.name.localeCompare(b.name, "ko"));

    // 회차 요약(§4) — 선택 회차 기준.
    const totals = items.reduce((t, p) => {
      t.assignmentCount++; t.pretaxTotal += p.pretax; t.posttaxTotal += p.posttax;
      t.withholdingImpliedTotal += p.withholdingImplied;
      const st = (p as any).status;
      if (st === "paid") t.paidTotal += p.pretax; else if (st === "pending") t.unpaidTotal += p.pretax;
      if (st === "deposit_unconfirmed") t.needReviewCount++; if (st === "dup_suspect") t.dupSuspectCount++; if (st === "excluded") t.excludedCount++;
      if (st === "scheduled") { t.scheduledCount++; t.scheduledTotal += p.pretax; }
      return t;
    }, { assignmentCount: 0, pretaxTotal: 0, posttaxTotal: 0, withholdingImpliedTotal: 0, paidTotal: 0, unpaidTotal: 0, needReviewCount: 0, dupSuspectCount: 0, excludedCount: 0, scheduledCount: 0, scheduledTotal: 0 });
    (totals as any).payeeCount = new Set(items.map(i => i.masterKey)).size;
    (totals as any).statusCounts = items.reduce((c: Record<PayBucket, number>, i: any) => { c[i.payBucket as PayBucket]++; return c; }, { paid: 0, unpaid: 0, scheduled: 0, review: 0 });

    const truncated = legacyCount >= 5000 || currentCount >= 5000;   // 조회 상한 도달 — 화면에서 조건 축소 안내
    res.json({ items: shown, allCount: items.length, payees, totals, basis, contactFull: canViewFullContact, referenceRate: 3.3, truncated });
  } catch (err) { (req as any).log?.error?.({ err }, "payout-unified payees failed"); res.status(500).json({ error: "통합 상세 조회 실패" }); }
});

export default router;
