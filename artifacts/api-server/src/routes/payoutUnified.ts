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
//   · 과거 '지급완료' 판정은 원본 입금일/입금내역 증빙 기준(지급일만으로 단정하지 않음 §7).
//     입금증빙 없고 지급 여부 불명 → '확인 필요'.
//
// 엔드포인트(GET, 읽기 전용):
//   GET /admin/payout-unified/rounds    지급일별 통합 회차 목록(과거+신규, 필터·페이지네이션)
//   GET /admin/payout-unified/payees    특정 지급일 회차의 건별 상세 + 통번역사(Master)별 통합 집계
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import { db, calcPayoutWithholding } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getPermissionsForRole } from "../lib/rbac";
import { isLegacyPlaceholderEmail } from "../lib/mailer";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const REFERENCE_TREATMENT = "domestic_3_3" as const;

// ── 과거 CRM 지급완료 정정 기준(대표 확인) ──────────────────────────────────────
//   대표가 2026-10-07 다운로드한 기존 CRM 진행관리표를 대조한 결과, 납품일 2026-09-15까지
//   납품 완료된 과거 CRM 건은 입금증빙 유무와 무관하게 실제 지급이 완료된 자료임을 확인.
//   → 과거(legacy) 건의 지급완료 판정 = (납품일 ≤ 2026-09-15) OR (입금일/입금내역 증빙 존재).
//   · 원본(legacy_archive_rows) 불변 — 조회/표시 전용 판정. 신규 지급거래·지급회차 생성 없음(§5).
//   · 납품일 2026-09-16 이후 건은 기존 증빙 기준 유지. 납품일 누락/무효 건은 자동 지급완료 처리하지 않음(별도 보고).
//   · 신규 플랫폼(current) 건에는 이 기준을 적용하지 않는다(payment_status 그대로).
const LEGACY_PAID_DELIVERY_CUTOFF = "2026-09-15";
const LEGACY_PAID_BASIS = "대표 확인 · 2026-10-07 CRM 자료 기준(납품일 ≤ 2026-09-15)";

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

// 과거 진행관리(progress) 정규화 — 원본 불변. 입금일/입금내역 → 지급완료 증빙(§7).
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
      -- 입금증빙(검증상태): 입금일 또는 입금내역 존재. 지급완료 판정의 보조 근거.
      (nullif(btrim(source_raw->>'입금일'),'') IS NOT NULL OR nullif(btrim(source_raw->>'입금내역'),'') IS NOT NULL) AS has_deposit,
      -- 지급완료 판정(과거 CRM 공통 규칙): 납품일 ≤ 2026-09-15(대표 확인) 또는 입금증빙 존재.
      --   납품일 누락/무효 && 증빙 없음 → false(지급확인 필요, 자동 지급완료 안 함).
      (coalesce(substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') <= ${LEGACY_PAID_DELIVERY_CUTOFF}, false)
        OR nullif(btrim(source_raw->>'입금일'),'') IS NOT NULL
        OR nullif(btrim(source_raw->>'입금내역'),'') IS NOT NULL) AS legacy_paid,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지급액(세전)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS pretax,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지금액(세후)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS posttax
    FROM legacy_archive_rows WHERE source_type = 'progress' AND is_effective = true
  )`;

// 신규 수행정보(performance_assignments) 정규화 — 지급일 = 지급예정일(자동/수동). 거래처 = 프로젝트 거래처 스냅샷.
const CUR = sql`
  cur AS (
    SELECT
      pa.id,
      'current:' || pa.id AS source_key,
      coalesce(nullif(btrim(pa.performer_name_snapshot), ''), cu.name) AS translator,
      p.company_name_snapshot AS client,
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
      coalesce(pa.net_payment, pa.cost_total - pa.withholding_tax, 0) AS posttax
    FROM performance_assignments pa
    LEFT JOIN projects p ON p.id = pa.project_id
    LEFT JOIN users cu ON cu.id = pa.individual_user_id
    LEFT JOIN translator_profiles tp ON tp.user_id = pa.individual_user_id
    WHERE pa.deleted_at IS NULL
  )`;

// 지급상태 코드 — 실제 '지급' 여부만 나타낸다(검증상태와 분리).
//   paid 지급완료(과거 입금증빙 有 / 신규 paid) · deposit_unconfirmed 지급확인 필요(과거 지급일은 있으나 입금일/입금내역 미기재 → 원본으로 지급완료 확인 불가)
//   · pending 지급대기(신규 미지급) · excluded 지급 제외(신규 보류) · dup_suspect 중복 의심.
//   ※ Master 연결·입금증빙(hasDeposit)·금액 검증은 '검증상태'이며 지급상태에 섞지 않는다(§3).
//     입금증빙 유무는 응답의 hasDeposit(검증상태)로 별도 제공하며, 지급상태 명칭에 '입금확인'을 쓰지 않는다.
type PayStatus = "paid" | "deposit_unconfirmed" | "pending" | "excluded" | "dup_suspect";
const STATUS_LABEL: Record<PayStatus, string> = {
  paid: "지급완료", deposit_unconfirmed: "지급확인 필요", pending: "지급대기", excluded: "지급 제외", dup_suspect: "중복 의심",
};

// 날짜 범위 필터(선택 기준 컬럼에 적용). 그룹핑은 항상 실제 지급일(payout_date).
function rangeCond(basis: "payout" | "delivery", dFrom: string | null, dTo: string | null) {
  const col = basis === "delivery" ? sql`delivery_date` : sql`payout_date`;
  return sql`${dFrom ? sql` AND ${col} >= ${dFrom}` : sql``}${dTo ? sql` AND ${col} <= ${dTo}` : sql``}`;
}

// ── GET 통합 회차 목록 ─────────────────────────────────────────────────────────
router.get("/admin/payout-unified/rounds", ...adminGuard, async (req, res) => {
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

    // 과거 집계 — 지급완료(입금증빙)/확인필요 구분.
    const legacyRows = source === "current" ? [] : (await db.execute(sql`WITH ${PROG}
      SELECT payout_date,
        count(*)::int AS cnt,
        count(DISTINCT translator) FILTER (WHERE translator IS NOT NULL)::int AS payees,
        coalesce(sum(pretax),0) AS pretax_total, coalesce(sum(posttax),0) AS posttax_total,
        coalesce(sum(pretax) FILTER (WHERE legacy_paid),0) AS paid_total,
        count(*) FILTER (WHERE NOT legacy_paid)::int AS need_review_cnt
      FROM prog ${filters} GROUP BY payout_date`)).rows as any[];

    // 신규 집계 — paid/unpaid/hold.
    const curRows = source === "legacy" ? [] : (await db.execute(sql`WITH ${CUR}
      SELECT payout_date,
        count(*)::int AS cnt,
        count(DISTINCT translator) FILTER (WHERE translator IS NOT NULL)::int AS payees,
        coalesce(sum(pretax),0) AS pretax_total, coalesce(sum(posttax),0) AS posttax_total,
        coalesce(sum(pretax) FILTER (WHERE payment_status='paid'),0) AS paid_total,
        coalesce(sum(pretax) FILTER (WHERE payment_status='unpaid'),0) AS unpaid_total,
        count(*) FILTER (WHERE payment_status='payment_hold')::int AS excluded_cnt
      FROM cur ${filters} GROUP BY payout_date`)).rows as any[];

    // 지급일별 병합(과거+신규). 지급일 null → '지급일 미확인'.
    const map = new Map<string, any>();
    const key = (d: any) => d ?? "__none__";
    for (const r of legacyRows) {
      const k = key(r.payout_date); const g = map.get(k) ?? { payoutDate: r.payout_date ?? null, cnt: 0, payees: new Set<string>(), pretax: 0, posttax: 0, paid: 0, unpaid: 0, needReview: 0, excluded: 0, legacyCnt: 0, currentCnt: 0 };
      g.cnt += num(r.cnt); g.pretax += num(r.pretax_total); g.posttax += num(r.posttax_total);
      g.paid += num(r.paid_total); g.needReview += num(r.need_review_cnt); g.legacyCnt += num(r.cnt);
      map.set(k, g);
    }
    for (const r of curRows) {
      const k = key(r.payout_date); const g = map.get(k) ?? { payoutDate: r.payout_date ?? null, cnt: 0, payees: new Set<string>(), pretax: 0, posttax: 0, paid: 0, unpaid: 0, needReview: 0, excluded: 0, legacyCnt: 0, currentCnt: 0 };
      g.cnt += num(r.cnt); g.pretax += num(r.pretax_total); g.posttax += num(r.posttax_total);
      g.paid += num(r.paid_total); g.unpaid += num(r.unpaid_total); g.excluded += num(r.excluded_cnt); g.currentCnt += num(r.cnt);
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
      };
    });
    res.json({ rounds, basis, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }, referenceRate: 3.3 });
  } catch (err) { (req as any).log?.error?.({ err }, "payout-unified rounds failed"); res.status(500).json({ error: "통합 회차 조회 실패" }); }
});

// ── GET 건별 상세 + 통번역사(Master)별 통합 집계 ───────────────────────────────
router.get("/admin/payout-unified/payees", ...adminGuard, async (req, res) => {
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

    const payoutCond = date === "none" ? sql` AND payout_date IS NULL`
      : (/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? sql` AND payout_date = ${date}` : sql``);
    const deliveryCond = basis === "delivery" ? rangeCond("delivery", dFrom, dTo) : sql``;
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
      WHERE 1=1 ${common}
      ORDER BY prog.delivery_date NULLS LAST, prog.translator NULLS LAST, prog.id LIMIT 5000`)).rows as any[];

    const curItems = source === "legacy" ? [] : (await db.execute(sql`WITH ${CUR}
      SELECT cur.* FROM cur WHERE 1=1 ${common} ORDER BY delivery_date NULLS LAST, translator NULLS LAST, id LIMIT 5000`)).rows as any[];

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
        // 지급완료 판정(과거 CRM 공통 규칙, PROG.legacy_paid와 동일) — 납품일 ≤ cutoff(대표 확인) 또는 입금증빙.
        const status: PayStatus = r.legacy_paid ? "paid" : "deposit_unconfirmed";
        const deliveryLeCutoff = r.delivery_date != null && r.delivery_date <= LEGACY_PAID_DELIVERY_CUTOFF;
        const paidBasis: string | null = r.legacy_paid ? (deliveryLeCutoff ? LEGACY_PAID_BASIS : "입금증빙(입금일/입금내역)") : null;
        return {
          source: "legacy", sourceKey: r.source_key, id: num(r.id),
          deliveryDate: r.delivery_date ?? null, payoutDate: r.payout_date ?? null,
          client: r.client ?? null, translator: r.translator ?? null,
          residentMasked: r.rrn_masked ?? null, language, languageSource,
          masterEmail, masterPhone, originalPhone: canViewFullContact ? phoneFull(r.orig_phone) : maskPhone(r.orig_phone),
          matchStatus, matchedUserId, matchedUserName, masterKey, confirmed: matchStatus === "confirmed",
          isPayroll: r.is_payroll === true, content, filename: r.filename ?? null,
          pretax, posttax, withholdingImplied: Math.round((pretax - posttax) * 100) / 100,
          status, statusLabel: STATUS_LABEL[status], hasDeposit: r.has_deposit === true, paidBasis,
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
          masterEmail: canViewFullContact ? emailFull(r.master_email) : maskEmail(r.master_email),
          masterPhone: canViewFullContact ? phoneFull(r.master_phone) : maskPhone(r.master_phone), originalPhone: null,
          matchStatus: confirmed ? "confirmed" : (r.vendor_company_id != null ? "vendor" : "unmatched"),
          matchedUserId: r.master_user_id != null ? num(r.master_user_id) : null, matchedUserName: r.translator ?? null,
          masterKey: r.master_user_id != null ? `m:${r.master_user_id}` : (r.vendor_company_id != null ? `v:${r.vendor_company_id}` : `n:${r.translator ?? "?"}`),
          confirmed, isPayroll: false, content, filename: null,
          pretax, posttax, withholdingImplied: Math.round((pretax - posttax) * 100) / 100,
          status, statusLabel: STATUS_LABEL[status], hasDeposit: ps === "paid", paidBasis: null,
        };
      }),
    ];

    // ── 중복 의심(§9) — 과거↔신규 교차. 동일 (Master, 납품일, 세전반올림, 거래처) → 양쪽 dup_suspect. 자동 삭제/제외 없음.
    const dupIndex = new Map<string, { legacy: number[]; current: number[] }>();
    items.forEach((it, idx) => {
      if (it.matchedUserId == null || !it.deliveryDate) return;
      const k = `${it.matchedUserId}|${it.deliveryDate}|${Math.round(it.pretax)}|${(it.client ?? "").trim()}`;
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

    // 상태 필터(조회 후 적용 — 집계는 전체 기준, 표시만 필터).
    const shown = statusFilter === "all" ? items : items.filter(i => (i as any).status === statusFilter);

    // ── 통번역사(Master)별 통합 집계(§8) — 확정 연결 기준 masterKey. 미확정은 이름키로 분리.
    const groups = new Map<string, any>();
    for (const it of items) {
      const g = groups.get(it.masterKey) ?? { masterKey: it.masterKey, name: it.translator ?? "(이름 미상)", confirmed: it.confirmed, matchStatus: it.matchStatus, matchedUserId: it.matchedUserId, email: it.masterEmail ?? null, phone: it.masterPhone ?? it.originalPhone ?? null, count: 0, pretax: 0, posttax: 0, paidPretax: 0, unpaidPretax: 0, paidCount: 0, unpaidCount: 0, needReview: 0, dupSuspect: 0, sources: new Set<string>(), languages: new Set<string>() };
      g.count++; g.pretax += it.pretax; g.posttax += it.posttax; g.sources.add(it.source); if (it.language) g.languages.add(it.language);
      if ((it as any).status === "paid") { g.paidPretax += it.pretax; g.paidCount++; }
      else if ((it as any).status === "pending") { g.unpaidPretax += it.pretax; g.unpaidCount++; }
      else if ((it as any).status === "deposit_unconfirmed") g.needReview++;
      if ((it as any).status === "dup_suspect") g.dupSuspect++;
      if (!g.email && it.masterEmail) g.email = it.masterEmail; if (!g.phone && (it.masterPhone || it.originalPhone)) g.phone = it.masterPhone ?? it.originalPhone;
      groups.set(it.masterKey, g);
    }
    const payees = [...groups.values()].map(g => ({
      masterKey: g.masterKey, name: g.name, confirmed: g.confirmed, matchStatus: g.matchStatus, matchedUserId: g.matchedUserId,
      email: g.email, phone: g.phone, count: g.count,
      pretaxTotal: g.pretax, posttaxTotal: g.posttax, withholdingImplied: Math.round((g.pretax - g.posttax) * 100) / 100,
      paidPretax: g.paidPretax, unpaidPretax: g.unpaidPretax, paidCount: g.paidCount, unpaidCount: g.unpaidCount, needReviewCount: g.needReview, dupSuspectCount: g.dupSuspect,
      sources: [...g.sources], languages: [...g.languages],   // 해당 회차 수행 언어(중복 제거). 없으면 빈 배열.
    })).sort((a, b) => a.name.localeCompare(b.name, "ko"));

    // 회차 요약(§4) — 선택 회차 기준.
    const totals = items.reduce((t, p) => {
      t.assignmentCount++; t.pretaxTotal += p.pretax; t.posttaxTotal += p.posttax;
      t.withholdingImpliedTotal += p.withholdingImplied;
      const st = (p as any).status;
      if (st === "paid") t.paidTotal += p.pretax; else if (st === "pending") t.unpaidTotal += p.pretax;
      if (st === "deposit_unconfirmed") t.needReviewCount++; if (st === "dup_suspect") t.dupSuspectCount++; if (st === "excluded") t.excludedCount++;
      return t;
    }, { assignmentCount: 0, pretaxTotal: 0, posttaxTotal: 0, withholdingImpliedTotal: 0, paidTotal: 0, unpaidTotal: 0, needReviewCount: 0, dupSuspectCount: 0, excludedCount: 0 });
    (totals as any).payeeCount = new Set(items.map(i => i.masterKey)).size;

    res.json({ items: shown, allCount: items.length, payees, totals, basis, contactFull: canViewFullContact, referenceRate: 3.3 });
  } catch (err) { (req as any).log?.error?.({ err }, "payout-unified payees failed"); res.status(500).json({ error: "통합 상세 조회 실패" }); }
});

export default router;
