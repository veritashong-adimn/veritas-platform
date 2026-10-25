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
import { getPermissionsForRole } from "../lib/rbac";
import { logEvent } from "../lib/logEvent";
import { isLegacyPlaceholderEmail } from "../lib/mailer";

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
      nullif(btrim(source_raw->>'거래처명'), '') AS client,   -- 과거 CRM 원본 거래처명(1순위). 비어있으면 NULL → 화면/명세서에서 '거래처 확인 필요'.
      nullif(btrim(source_raw->>'연락처'), '') AS orig_phone,  -- 과거 CRM 원본 연락처(해당 수행 건 기록값). Master 휴대폰 없을 때 명세서 연락처 대체 후보.
      substring(source_raw->>'통번역사지급일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS payout_date,
      substring(source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS delivery_date,
      nullif(btrim(source_raw->>'상품명'), '') AS product_name,
      nullif(btrim(source_raw->>'언어'), '') AS language,
      nullif(btrim(source_raw->>'파일명'), '') AS filename,     -- 원본 그대로(금액·특수문자 변환 없음). 지급액에 합산하지 않는 설명/영수증 메모 보존.
      -- 주민번호 기본 마스킹(앞 6자리 + -*******). 전체값은 어떤 응답/로그에도 노출하지 않는다.
      CASE WHEN regexp_replace(coalesce(source_raw->>'주민등록번호',''), '[^0-9]', '', 'g') ~ '^[0-9]{6}'
           THEN substring(regexp_replace(source_raw->>'주민등록번호','[^0-9]','','g') from 1 for 6) || '-*******'
           ELSE NULL END AS rrn_masked,
      (source_raw->>'파일명' ILIKE '%급여%' OR source_raw->>'파일명' ILIKE '%근로소득%') AS is_payroll,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지급액(세전)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS pretax,
      coalesce(nullif(regexp_replace(coalesce(source_raw->>'지금액(세후)',''), '[^0-9.-]', '', 'g'), '')::numeric, 0) AS posttax
    FROM legacy_archive_rows
    WHERE source_type = 'progress' AND is_effective = true
  )`;

// 날짜 기준 파싱 — 'delivery' 면 납품일, 그 외(기본) 지급일. 조회 기준 컬럼 1곳으로 집약.
function parseBasis(v: unknown): "payout" | "delivery" { return v === "delivery" ? "delivery" : "payout"; }

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// ── 연락처 마스킹(서버 내부에서만 전체값 취급, 응답/로그엔 마스킹본만) ──────────────
// 전화: 숫자만 추출 후 +82/82 선두는 0으로 정규화 → 앞 3 + **** + 뒤 4(짧으면 전부 마스킹).
function maskPhone(raw: string | null | undefined): string | null {
  if (!raw) return null; let d = String(raw).replace(/[^0-9]/g, "");
  if (d.startsWith("82")) d = "0" + d.slice(2);
  if (d.length < 7) return d ? "*".repeat(d.length) : null;
  return d.slice(0, 3) + "-****-" + d.slice(-4);
}
// 이메일: 로컬파트 첫 글자만 노출, 나머지 마스킹. 도메인은 유지. 예: kim@ex.com → k***@ex.com
//   과거 CRM 이관 전용 식별 주소(@crm-migrated.invalid)는 실제 이메일이 아니므로 노출하지 않음(null → '이메일 미등록').
function maskEmail(raw: string | null | undefined): string | null {
  if (isLegacyPlaceholderEmail(raw)) return null;
  const e = (raw ?? "").trim(); if (!e || !e.includes("@")) return e ? "***" : null;
  const [local, domain] = e.split("@");
  const head = local.slice(0, 1) || "*";
  return `${head}***@${domain}`;
}
// 권한 보유자용 전화 전체값(국내 010/02 등 보기 좋게 하이픈). +82는 0으로 정규화. 비정형은 원문.
function phoneFull(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim(); if (!t) return null;
  let d = t.replace(/[^0-9]/g, ""); if (d.startsWith("82")) d = "0" + d.slice(2);
  if (/^01[016789]\d{7,8}$/.test(d)) return d.length === 11 ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (/^02\d{7,8}$/.test(d)) return `02-${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  return t;   // 해외/비정형은 원문 그대로(임의 변환 금지)
}
function emailFull(raw: string | null | undefined): string | null { if (isLegacyPlaceholderEmail(raw)) return null; const e = (raw ?? "").trim(); return e || null; }

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

    // 연락처 전체 열람 권한(기존 체계 재사용): super-admin 또는 translator.sensitive 보유자만.
    //   권한 없으면 마스킹본만 전달(전체값은 응답에 포함하지 않음 §1·§6).
    const user = req.user!;
    let canViewFullContact = user.role === "admin" && !user.roleId;
    if (!canViewFullContact && user.roleId) {
      try { canViewFullContact = (await getPermissionsForRole(user.roleId)).has("translator.sensitive"); } catch { canViewFullContact = false; }
    }
    const dFrom = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateFrom ?? "") ? qp.dateFrom! : null;
    const dTo = /^\d{4}-\d{2}-\d{2}$/.test(qp.dateTo ?? "") ? qp.dateTo! : null;

    // 선택 회차 = 실제 지급일 그룹(미확인 포함). 날짜 기준이 납품일이면 납품일 범위도 함께 적용.
    const payoutCond = date === "none" ? sql` AND prog.payout_date IS NULL`
      : (/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? sql` AND prog.payout_date = ${date}` : sql``);
    const deliveryCond = basis === "delivery"
      ? sql`${dFrom ? sql` AND prog.delivery_date >= ${dFrom}` : sql``}${dTo ? sql` AND prog.delivery_date <= ${dTo}` : sql``}`
      : sql``;
    const transCond = translator ? sql` AND prog.translator ILIKE ${"%" + translator + "%"}` : sql``;

    // 연결 판단 우선순위(§5): 1순위 검증·승인된 확정 매핑(legacy_master_mappings, status='confirmed') →
    //   2순위 이름 유일일치 후보(users translator/linguist) → 3순위 외주업체/거래처/직원/미연결.
    //   이름만 일치한다는 이유로 '확정'으로 표시하지 않는다(후보로만).
    const rows = (await db.execute(sql`${PROG},
      umatch AS (
        SELECT btrim(name) AS nm, min(id) AS uid, count(*)::int AS c
        FROM users WHERE role IN ('translator','linguist') AND btrim(name) <> '' GROUP BY btrim(name)
      ),
      lmm AS (
        SELECT legacy_id, entity_id FROM legacy_master_mappings
        WHERE source_system = 'old_crm' AND entity_type = 'translator' AND status = 'confirmed'
      ),
      comp AS (
        SELECT btrim(name) AS nm, bool_or(is_vendor) AS is_vendor FROM companies WHERE btrim(name) <> '' GROUP BY btrim(name)
      )
      SELECT
        prog.id,
        prog.delivery_date,
        prog.payout_date,
        prog.translator,
        prog.client,
        prog.orig_phone,
        prog.product_name,
        prog.language,
        prog.filename,
        prog.rrn_masked,
        prog.is_payroll,
        prog.pretax,
        prog.posttax,
        lmm.entity_id AS mapped_user_id,
        cu.name AS mapped_user_name,
        cu.email AS mapped_email,
        tpc.phone AS mapped_phone,
        tpc.language_pairs AS mapped_langpairs,
        CASE WHEN um.c = 1 THEN um.uid ELSE NULL END AS name_user_id,
        nu.name AS name_user_name,
        nu.email AS name_email,
        tpn.phone AS name_phone,
        comp.is_vendor AS comp_vendor,
        (comp.nm IS NOT NULL) AS is_company
      FROM prog
      LEFT JOIN lmm ON lmm.legacy_id = prog.translator
      LEFT JOIN users cu ON cu.id = lmm.entity_id
      LEFT JOIN translator_profiles tpc ON tpc.user_id = lmm.entity_id
      LEFT JOIN umatch um ON um.nm = prog.translator
      LEFT JOIN users nu ON nu.id = (CASE WHEN um.c = 1 THEN um.uid ELSE NULL END)
      LEFT JOIN translator_profiles tpn ON tpn.user_id = (CASE WHEN um.c = 1 THEN um.uid ELSE NULL END)
      LEFT JOIN comp ON comp.nm = prog.translator
      WHERE 1=1 ${payoutCond} ${deliveryCond} ${transCond}
      ORDER BY prog.delivery_date NULLS LAST, prog.payout_date NULLS LAST, prog.translator NULLS LAST, prog.id
      LIMIT 5000`)).rows as any[];

    const items = rows.map(r => {
      const pretax = num(r.pretax), posttax = num(r.posttax);
      const content = [r.product_name, r.language].filter(Boolean).join(" · ") || null;
      // 언어(§6): 1순위 과거 원본 언어, 2순위 원본 없고 '확정' 연결 시 Master 등록 언어(참고·출처표시), 3순위 null.
      //   원본/ Master 혼합·임의변환 없음(각각 출처 구분).
      let language: string | null = r.language ?? null;
      let languageSource: "original" | "master" | null = r.language ? "original" : null;
      if (!language && r.mapped_user_id != null && r.mapped_langpairs) { language = r.mapped_langpairs; languageSource = "master"; }
      // 우선순위 판정 — 확정매핑 > 이름후보 > 외주업체 > 거래처 > (직원성) > 미연결
      let matchStatus: string, matchedUserId: number | null = null, matchedUserName: string | null = null;
      // Master 연락처(이메일/전화)는 '연결 행'에만, 마스킹하여 노출. 과거 CRM 원본이 아니라 현재 Master 등록값(대표 승인).
      let masterEmail: string | null = null, masterPhone: string | null = null;
      if (r.mapped_user_id != null) { matchStatus = "confirmed"; matchedUserId = num(r.mapped_user_id); matchedUserName = r.mapped_user_name ?? null; masterEmail = canViewFullContact ? emailFull(r.mapped_email) : maskEmail(r.mapped_email); masterPhone = canViewFullContact ? phoneFull(r.mapped_phone) : maskPhone(r.mapped_phone); }
      else if (r.name_user_id != null) { matchStatus = "candidate"; matchedUserId = num(r.name_user_id); matchedUserName = r.name_user_name ?? null; masterEmail = canViewFullContact ? emailFull(r.name_email) : maskEmail(r.name_email); masterPhone = canViewFullContact ? phoneFull(r.name_phone) : maskPhone(r.name_phone); }
      else if (r.comp_vendor === true) matchStatus = "vendor";
      else if (r.is_company === true) matchStatus = "client";
      else matchStatus = "unmatched";
      return {
        id: num(r.id),
        deliveryDate: r.delivery_date ?? null,
        payoutDate: r.payout_date ?? null,
        client: r.client ?? null,                     // 과거 CRM 원본 거래처명(없으면 null → 화면에서 '거래처 확인 필요')
        translator: r.translator ?? null,
        residentMasked: r.rrn_masked ?? null,       // 앞6+마스킹(전체값 미노출)
        language,                                     // 과거 원본 or (확정 연결 시) Master 참고 언어
        languageSource,                               // 'original' | 'master' | null (출처 구분)
        masterEmail,                                  // Master 등록 이메일(마스킹, 연결행만)
        masterPhone,                                  // Master 등록 전화(마스킹, 연결행만)
        originalPhone: canViewFullContact ? phoneFull(r.orig_phone) : maskPhone(r.orig_phone),  // 과거 CRM 원본 연락처(권한 따라 전체/마스킹). 명세서 연락처 대체 후보.
        matchStatus,                                  // confirmed|candidate|vendor|client|unmatched
        matchedUserId,
        matchedUserName,
        isPayroll: r.is_payroll === true,             // 급여/근로소득 파일명 → 직원성 지급 배지
        matched: matchStatus === "confirmed",         // '정상 연결'은 확정매핑만(이름일치는 후보)
        content,
        filename: r.filename ?? null,
        pretax,
        posttax,
        withholdingImplied: Math.round((pretax - posttax) * 100) / 100,
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
    // 연결상태별 행수 집계(화면 상단 배지용) — 금액/건수 집계와 무관.
    const statusCounts = items.reduce((m: Record<string, number>, i) => { m[i.matchStatus] = (m[i.matchStatus] ?? 0) + 1; if (i.isPayroll) m.payroll = (m.payroll ?? 0) + 1; return m; }, {});

    // 개인정보 접근 기록(§1·§6) — 전체 연락처를 '실제 열람'한 경우에만 1건. 값은 기록하지 않고 건수만.
    const fullContactCount = canViewFullContact ? items.filter(i => i.masterEmail || i.masterPhone || i.originalPhone).length : 0;
    if (canViewFullContact && fullContactCount > 0) {
      void logEvent("translator", 0, "payout_reproduction.contact_view_full", (req as any).log, { id: user.id, email: user.email },
        JSON.stringify({ date: date ?? null, basis, rows: fullContactCount }));  // 연락처/주민번호 값은 미기록
    }
    res.json({ items, totals, statusCounts, basis, contactFull: canViewFullContact, referenceRate: 3.3 });
  } catch (err) { (req as any).log?.error?.({ err }, "payout-reproduction payees failed"); res.status(500).json({ error: "재현 상세 조회 실패" }); }
});

export default router;
