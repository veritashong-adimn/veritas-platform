// ─── 지급 준비 점검 · 지급 누락 방지(READ-ONLY) — 플랫폼 신규 + 과거 CRM 전환 + CRM 원본만 있는 건 통합 ──────────────
//
// 두 범위(scope)
//   ① date : 지급일 기준 지급 후보. 통합 지급회차(payoutUnified PROG/CUR — 지급명세서와 같은 집계)의 그 지급일 건(기본 후보)에
//            누락 방지 교차조회를 더한다 — 해당 지급일의 납품기간(1~15일 납품 → 말일 지급 / 16~말일 → 익월 15일) 납품건,
//            지급예정일 없는 미지급건(납품일 없는 수행완료 포함), 지급일 경과 미지급·확인필요(이월) 건.
//            날짜가 없다는 이유로 빼지 않되, 기본 후보(지급일 일치)가 아닌 건은 '추가 확인 후보'로 구분한다(송금 자동 확정 아님).
//   ② all  : 전체 기간 지급 누락·날짜 공란·확인필요 — 지급완료가 아닌 모든 지급행 + 지급완료인데 실제 지급일 없는 건 + 날짜 공란 건.
//
// 분류: A 지급 준비 완료 / B 계좌정보 확인 필요 / C 금액·세금·수행정보(날짜 포함) 확인 필요 / D 과거 지급 여부·중복 확인 필요.
//   한 건의 모든 사유(차단 B·C·D + 참고 I)와 필요한 조치를 함께 준다. 참고(I: 지급회차 미배정 등)는 상태를 바꾸지 않는다.
//
// 원칙: DB 변경 없음. 날짜·금액·지급상태를 추정해 채우지 않는다. 미지급이 확인되지 않은 과거 CRM 건은 A가 아니다.
//   계좌는 보유 여부만(민감정보 미반환). 동일인 = Master 연결(행 단위 연결 › 전환 수행정보 수행자 › 확정 이름 매핑)만.
//   CRM 원본과 플랫폼에 같은 수행이 있으면 '중복 지급 후보'로 표시하고 합계에서 한 번만 집계한다.
import { sql } from "drizzle-orm";
import { PROG, CUR } from "../routes/payoutUnified";
import { checkEligibility } from "./legacyPayoutConversion";
import { LEGACY_PAID_DELIVERY_CUTOFF, todayKst } from "../lib/legacyPayoutRule";
import { loadSaleIdentities } from "./saleIdentity";
import { computeProjectProfit } from "./projectProfit";
import { masterTreatmentOf } from "./legacyActivationLineage";
import { DATE_DECISIONS } from "../lib/payoutDateDecisions";
import { payStatusOf, isAmountMissing, PAY_STATUS_LABEL, emptyStatusCounts, type PayStatusKey } from "../lib/payDisplayStatus";
import { decrypt } from "../lib/encrypt";
import { splitPayAmount, domesticPayeeKey, wonPayTotals, type PayeeType } from "../lib/payoutAmount";
import { isLegacyPlaceholderEmail } from "../lib/mailer";
import { rawRowFromRecord } from "../routes/pastWorkImport";

// 주민등록번호(통번역사 명부 translator_sensitive, AES-256-GCM) — 수행자 ID(users.id) 기준.
//   full=false: '900101-*******'(생년월일만) / full=true: '900101-1234567'(관리자 전용 경로에서만 호출).
//   번호 없음·복호화 실패·13자리 아님 → 결과에서 제외(엑셀 공란). 평문을 로그에 남기지 않는다.
export async function loadResidentNumbers(dbx: Dbx, ids: number[], full: boolean): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const uniq = [...new Set(ids.filter(n => Number.isInteger(n) && n > 0))];
  if (!uniq.length) return out;
  const rs = await rows(dbx, sql`SELECT translator_id, resident_number FROM translator_sensitive
    WHERE translator_id IN (${sql.join(uniq.map(i => sql`${i}`), sql`, `)}) AND coalesce(resident_number, '') <> ''`);
  for (const r of rs) {
    let digits = "";
    try { digits = decrypt(String(r.resident_number)).replace(/[^0-9]/g, ""); } catch { continue; }
    if (digits.length !== 13) continue;
    out.set(Number(r.translator_id), full ? `${digits.slice(0, 6)}-${digits.slice(6)}` : `${digits.slice(0, 6)}-*******`);
  }
  return out;
}

// 지급상태 표시(2026-11-22) — 화면·엑셀 공통. DB 지급상태(payment_status)·지급보류 안전장치는 바꾸지 않는 표시 전용 판정.
//   paid 지급완료 / review 지급확인 필요(과거 CRM 지급보류·미확인, 지급보류, 중복 지급 후보)
//   prep 지급준비 필요(계좌·수행자·세금·금액·날짜 등 필수 지급정보 미비) / scheduled 지급예정(지급 가능한 미지급)
//   hold 지급보류(플랫폼 수행정보에서 지급보류로 설정 — 과거 CRM 전환 확인용 지급보류(review)와 구분) / excluded 지급 제외(지급일별 대표 확인: 무료 제공 등)
//   no_amount 지급액 없음(무료 제공 등 정상 0원 — 대표 확인 건만, 송금 대상 아님)
export type PayDisplay = "paid" | "review" | "prep" | "scheduled" | "hold" | "excluded" | "no_amount";
export const PAY_DISPLAY_LABEL: Record<PayDisplay, string> = { paid: "지급완료", review: "지급확인 필요", prep: "지급준비 필요", scheduled: "지급예정", hold: "지급보류", excluded: "지급 제외", no_amount: "지급액 없음" };

type Dbx = any;
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export type ReadinessState = "A" | "B" | "C" | "D";
export const READINESS_LABEL: Record<ReadinessState, string> = {
  A: "지급 준비 완료", B: "계좌정보 확인 필요", C: "금액·세금·수행정보 확인 필요", D: "과거 지급 여부·중복 확인 필요",
};
type Blocker = { cat: "B" | "C" | "D" | "I"; code: string; text: string; action: string };

/** 지급일 → 그 지급일의 납품기간(지급일 규칙: 1~15일 납품 → 그달 말일 / 16~말일 납품 → 익월 15일). 영업일 조정 전 기준. */
export function deliveryWindowFor(payoutDate: string): { from: string; to: string } {
  const [y, m, d] = payoutDate.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const last = (yy: number, mm: number) => new Date(yy, mm, 0).getDate();
  if (d <= 15) {   // 15일 지급 → 전월 16일 ~ 전월 말일 (영업일 조정으로 15일 이전 지급일이어도 같은 회차)
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    return { from: `${py}-${pad(pm)}-16`, to: `${py}-${pad(pm)}-${pad(last(py, pm))}` };
  }
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-15` };   // 말일 지급(영업일 조정 포함) → 그달 1~15일
}

// 지급일별 점검 제외 — 고객 선입금 잔액 확인 중인 CRM 원본(거래처명|판매번호 정확 일치). 2026-11-23 대표 지시.
const PREPAID_REVIEW_EXCLUSIONS: Record<string, Set<string>> = {
  "2026-11-30": new Set([
    "(주)호현에프앤씨|2024-02-27-0003", "한국사회복지협의회|2023-11-01-0008", "피에스타귀족|2018-12-10-0010",
    "한국사회복지협의회|2018-12-20-0003", "한국사회복지협의회|2018-12-20-0002", "(주)리치몬트코리아/반클리프아펠|2024-02-27-0008",
    "한국전자정보통신산업진흥회(KEA)|2021-03-31-0010", "한국소비자원|2019-12-06-0013", "더엠유|2019-03-21-0006",
    "충북대학교 문화재보존기술지원센터|2020-01-07-0011",
  ]),
};

// 지급일별 대표 확인 결정 — lib/payoutDateDecisions(지급회차 통합 조회와 공용)

// 외화 지급 통화별 합계(원화와 합산하지 않음) — 화면·엑셀 공통
export function foreignTotalsOf(items: any[]): { currency: string; count: number; amount: number; missing: number }[] {
  const m = new Map<string, { currency: string; count: number; amount: number; missing: number }>();
  for (const x of items) {
    if (!x.countedInTotals || !x.payCurrency || x.payCurrency === "KRW") continue;
    const g = m.get(x.payCurrency) ?? { currency: x.payCurrency, count: 0, amount: 0, missing: 0 };
    g.count++; if (x.foreignAmount != null) g.amount = Math.round((g.amount + x.foreignAmount) * 100) / 100; else g.missing++;
    m.set(x.payCurrency, g);
  }
  return [...m.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

// 프로젝트 손익(엑셀 수익금액·수익률 전용) — 판매 상세 '프로젝트 손익 요약'과 같은 공용 계산(services/projectProfit)의 예상이익·예상이익률.
//   화면 조회(computePayoutReadiness)에서는 계산하지 않고, 엑셀 다운로드 시에만 별도 API로 호출한다(조회 속도 영향 없음).
//   프로젝트 전체 원가 기준(이번 지급액만으로 계산하지 않음) → 같은 프로젝트는 같은 값. 계산 실패는 null(공란).
//   supply(손익 기준 공급가액)는 합계 수익률(Σ예상이익 ÷ Σ공급가액) 계산용. 조회 전용, DB 미변경.
export type ReadinessProfit = { amount: number; rate: number | null; supply: number; cost: number; cancelled: boolean };
export async function loadProjectProfits(projectIds: number[]): Promise<Map<number, ReadinessProfit | null>> {
  const ids = [...new Set(projectIds)];
  const out = new Map<number, ReadinessProfit | null>();
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (pid) => {
      try {
        const { profit: pf } = await computeProjectProfit(pid);
        out.set(pid, { amount: pf.estimatedProfit, rate: pf.estimatedMarginRate, supply: pf.saleSupplyAmount, cost: pf.totalCost, cancelled: pf.saleCancelled });
      } catch { out.set(pid, null); }
    }));
  }
  return out;
}

export async function computePayoutReadiness(dbx: Dbx, opts: { scope: "date" | "all"; date?: string }) {
  const today = todayKst();
  const scope = opts.scope;
  const d = opts.date ?? "";
  const win = scope === "date" ? deliveryWindowFor(d) : null;

  // ① 후보 행(통합 집계와 같은 PROG/CUR) — 범위별 조건. candidate: base(지급일 일치) | delivery_window | carry_over | no_payout_date | record_gap
  const legacyWhere = scope === "date"
    ? sql`(prog.payout_date = ${d} OR prog.delivery_date BETWEEN ${win!.from} AND ${win!.to}
          OR (NOT prog.legacy_paid AND (prog.payout_date IS NULL OR prog.payout_date < ${today})))`
    : sql`(NOT prog.legacy_paid OR prog.delivery_date IS NULL OR prog.payout_date IS NULL AND coalesce(prog.delivery_date, '9999') > ${LEGACY_PAID_DELIVERY_CUTOFF}
          -- 전환 수행정보가 지급완료인데 실제 지급일이 없는 건(대표 확인 cutoff 이후 납품) — 지급완료 기록 누락
          OR (prog.act_payment_status = 'paid' AND prog.actual_payment_date IS NULL AND coalesce(prog.delivery_date, '9999') > ${LEGACY_PAID_DELIVERY_CUTOFF}))`;
  const curWhere = scope === "date"
    ? sql`(cur.payout_date = ${d} OR cur.delivery_date BETWEEN ${win!.from} AND ${win!.to}
          OR (cur.payment_status <> 'paid' AND (cur.payout_date IS NULL OR cur.payout_date < ${today})))`
    : sql`(cur.payment_status <> 'paid' OR cur.actual_payment_date IS NULL OR cur.delivery_date IS NULL OR cur.payout_date IS NULL)`;
  const base = await rows(dbx, sql`WITH ${PROG}, ${CUR}
    SELECT 'legacy' AS source, prog.id, prog.source_key, prog.translator, prog.client, prog.delivery_date, prog.payout_date,
      prog.actual_payment_date, prog.pretax, prog.posttax, (prog.pretax - prog.posttax) AS withholding, prog.legacy_paid, prog.act_user_id,
      prog.crm_delivery_date, prog.platform_delivery_date, prog.delivery_mismatch, prog.crm_payout_date, prog.platform_payout_date, prog.payout_mismatch,
      prog.amount_source, prog.crm_pretax, prog.crm_posttax
    FROM prog WHERE ${legacyWhere}
    UNION ALL
    SELECT 'current', cur.id, cur.source_key, cur.translator, cur.client, cur.delivery_date, cur.payout_date,
      cur.actual_payment_date, cur.pretax, cur.posttax, cur.withholding_tax, false, NULL::int,
      NULL, NULL, false, NULL, NULL, false,
      'platform', NULL::numeric, NULL::numeric
    FROM cur WHERE ${curWhere}`);
  const legacyIds = base.filter(b => b.source === "legacy").map(b => Number(b.id));
  const curIds = base.filter(b => b.source === "current").map(b => Number(b.id));
  const inList = (ids: number[]) => sql.join((ids.length ? ids : [-1]).map(i => sql`${i}`), sql`, `);

  // ② 과거 CRM 행 → 전환 수행정보(최신 계보) · 수취인(행 단위 연결 › 확정 이름 매핑) · 판매번호
  const lin = new Map((await rows(dbx, sql`
    SELECT DISTINCT ON (r.id) r.id AS row_id, s.status AS lineage, pa.id AS pa_id
    FROM legacy_archive_rows r
    JOIN import_row_sources s ON s.module = 'legacy_sale_activation' AND s.row_key = 'progress:' || r.id
    LEFT JOIN performance_assignments pa ON pa.id = s.entity_id AND pa.deleted_at IS NULL
    WHERE r.id IN (${inList(legacyIds)}) ORDER BY r.id, s.id DESC`)).map(r => [Number(r.row_id), r]));
  const legacyMaster = new Map((await rows(dbx, sql`
    SELECT r.id AS row_id, coalesce(
      (SELECT rl.entity_id FROM legacy_master_mappings rl WHERE rl.source_system = 'old_crm' AND rl.entity_type = 'translator_row' AND rl.status <> 'rolled_back' AND rl.legacy_id = 'progress:' || r.id LIMIT 1),
      (SELECT m.entity_id FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'translator' AND m.status <> 'rolled_back' AND btrim(m.legacy_id) = btrim(r.source_raw->>'통번역사명') LIMIT 1)) AS master_id,
      (SELECT s.source_raw->>'판매번호' FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id AND s.is_effective WHERE l.progress_row_id = r.id AND l.decision = 'confirmed' ORDER BY s.id DESC LIMIT 1) AS sale_no,
      r.source_raw AS source_raw
    FROM legacy_archive_rows r WHERE r.id IN (${inList(legacyIds)})`)).map(r => [Number(r.row_id), r]));

  // ③ 플랫폼 수행정보(현재 행 + 전환 행) — 공식 지급회차 자격조건과 같은 항목 + 전환 원본 납품일(불일치 확인)
  const paIds = [...curIds, ...[...lin.values()].map(l => Number(l.pa_id)).filter(Boolean)];
  const pa = new Map((await rows(dbx, sql`
    SELECT pa.id, pa.project_id, p.title AS project_title, pa.product_name_snapshot AS product_name, pa.performer_category::text AS cat, pa.individual_user_id, pa.vendor_company_id,
      pa.payment_status::text AS payment_status, pa.status::text AS work_status, pa.payout_round_id,
      pa.delivery_date IS NOT NULL AS has_delivery, pa.delivery_confirmed, coalesce(pa.cost_total, 0) AS cost_total,
      pa.withholding_treatment::text AS treatment, pa.vendor_settlement_type, pa.withholding_rate AS wrate, pa.purchase_evidence_type::text AS evidence,
      -- 지급통화·외화 지급금액(개인 외화 지급 / 외주 해외송금 계약) — 원화 금액과 합산하지 않음
      upper(nullif(btrim(pa.contract_currency), '')) AS pay_currency, pa.contract_amount_foreign AS foreign_amount,
      (SELECT c.name FROM companies c WHERE c.id = pa.vendor_company_id) AS vendor_name,
      (SELECT q.quote_number FROM quotes q WHERE q.id = pa.quote_id) AS quote_number,
      (SELECT m.legacy_id FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.entity_id = pa.project_id AND m.status = 'active' LIMIT 1) AS legacy_sale_no,
      (SELECT substring(r.source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') FROM import_row_sources s JOIN legacy_archive_rows r ON r.id::text = substring(s.row_key from 10)
        WHERE s.module = 'legacy_sale_activation' AND s.entity_id = pa.id AND s.row_key LIKE 'progress:%' ORDER BY s.id DESC LIMIT 1) AS crm_delivery,
      -- 연결 CRM 원본의 통번역사명(외주업체 지급 건의 실제 수행자 표시용 — 표시 전용, 연결·지급 판정에 사용하지 않음)
      (SELECT nullif(btrim(r.source_raw->>'통번역사명'), '') FROM import_row_sources s JOIN legacy_archive_rows r ON r.id::text = substring(s.row_key from 10)
        WHERE s.module = 'legacy_sale_activation' AND s.entity_id = pa.id AND s.row_key LIKE 'progress:%' ORDER BY s.id DESC LIMIT 1) AS crm_translator,
      (SELECT substring(s.row_key from 10)::int FROM import_row_sources s WHERE s.module = 'legacy_sale_activation' AND s.entity_id = pa.id AND s.row_key LIKE 'progress:%' ORDER BY s.id DESC LIMIT 1) AS crm_row_id
    FROM performance_assignments pa LEFT JOIN projects p ON p.id = pa.project_id WHERE pa.id IN (${inList(paIds)})`)).map(r => [Number(r.id), r]));

  // ④ CRM 원본과 플랫폼 수행의 중복 후보 — 같은 수행자명·납품일·세전금액(0원 제외) + 같은 거래처
  //   (전환된 CRM 행: 전환 판매의 거래처 Master = 플랫폼 판매의 거래처 Master / 원본만: 거래처명 정규화 일치).
  //   같은 판매건에서 전환된 CRM 행(전환 수행정보를 담당자가 대체·삭제한 경우)은 같은 판매 안의 정리라 제외.
  const normCo = (e: any) => sql`regexp_replace(lower(coalesce(${e}, '')), '\\(주\\)|주식회사|㈜|\\s|\\.|,', '', 'g')`;
  const dupPairs = await rows(dbx, sql`
    SELECT pa.id AS pa_id, r.id AS row_id FROM performance_assignments pa
    JOIN projects pp ON pp.id = pa.project_id
    LEFT JOIN companies pc ON pc.id = pp.company_id
    JOIN legacy_archive_rows r ON r.source_type = 'progress' AND r.is_effective
      AND btrim(r.source_raw->>'통번역사명') = btrim(coalesce(pa.performer_name_snapshot, ''))
      AND substring(r.source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') = to_char(coalesce(pa.delivery_date, pa.delivery_date_auto), 'YYYY-MM-DD')
      AND coalesce(nullif(regexp_replace(coalesce(r.source_raw->>'지급액(세전)', ''), '[^0-9.-]', '', 'g'), '')::numeric, 0) = coalesce(pa.cost_total, 0)
    LEFT JOIN LATERAL (SELECT xpa.project_id FROM import_row_sources s JOIN performance_assignments xpa ON xpa.id = s.entity_id
      WHERE s.module = 'legacy_sale_activation' AND s.row_key = 'progress:' || r.id ORDER BY s.id DESC LIMIT 1) lx ON true
    WHERE pa.id IN (${inList(curIds)}) AND coalesce(pa.cost_total, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM import_row_sources s WHERE s.module = 'legacy_sale_activation' AND s.entity_id = pa.id AND s.row_key LIKE 'progress:%')
      AND (lx.project_id IS NULL OR lx.project_id <> pa.project_id)
      AND ((lx.project_id IS NOT NULL AND (SELECT xp.company_id FROM projects xp WHERE xp.id = lx.project_id) = pp.company_id)
        OR (${normCo(sql`r.source_raw->>'거래처명'`)} <> '' AND ${normCo(sql`r.source_raw->>'거래처명'`)} IN (${normCo(sql`pp.company_name_snapshot`)}, ${normCo(sql`pc.name`)})))`);
  const dupByPa = new Map<number, number[]>(); const dupRows = new Set<number>();
  for (const x of dupPairs) { const a = dupByPa.get(Number(x.pa_id)) ?? []; a.push(Number(x.row_id)); dupByPa.set(Number(x.pa_id), a); dupRows.add(Number(x.row_id)); }

  // ⑤ 계좌 보유 여부(값 미조회)
  const userIds = new Set<number>(); const vendorIds = new Set<number>();
  for (const p of pa.values()) { if (p.individual_user_id) userIds.add(Number(p.individual_user_id)); if (p.vendor_company_id) vendorIds.add(Number(p.vendor_company_id)); }
  for (const m of legacyMaster.values()) if (m.master_id) userIds.add(Number(m.master_id));
  for (const b of base) if (b.act_user_id) userIds.add(Number(b.act_user_id));
  const uAcct = new Map((await rows(dbx, sql`SELECT u.id, (coalesce(ts.bank_account_enc, ts.bank_account, '') <> '' AND coalesce(ts.bank_name, '') <> '') AS acct,
      coalesce(ts.account_holder, '') <> '' AS holder, coalesce(ts.payment_hold, false) AS hold, u.deleted_at IS NOT NULL AS deleted
    FROM users u LEFT JOIN translator_sensitive ts ON ts.translator_id = u.id WHERE u.id IN (${inList([...userIds])})`)).map(r => [Number(r.id), r]));
  const vAcct = new Map((await rows(dbx, sql`SELECT c.id, (coalesce(cs.bank_account_enc, '') <> '' AND coalesce(cs.bank_name, '') <> '') AS acct
    FROM companies c LEFT JOIN company_sensitive cs ON cs.company_id = c.id WHERE c.id IN (${inList([...vendorIds])})`)).map(r => [Number(r.id), r]));

  // ⑥ 판매금액(판매정보에 저장된 실제 금액) — 판매관리와 같은 대표 견적(saleIdentity)의 판매상품 합계. CRM 원본만 있는 건은 없음(계산 안 함).
  const projIds = [...new Set([...pa.values()].map(p => Number(p.project_id)).filter(Boolean))];
  const idn = projIds.length ? await loadSaleIdentities(dbx, projIds) : new Map();
  const qids = [...new Set([...idn.values()].map((x: any) => x.quoteId).filter((v: any) => v != null))] as number[];
  const amtByQuote = new Map((await rows(dbx, sql`SELECT quote_id, coalesce(sum(supply_amount), 0) AS supply, coalesce(sum(tax_amount), 0) AS vat, coalesce(sum(total_amount), 0) AS total
    FROM quote_items WHERE quote_id IN (${inList(qids)}) GROUP BY quote_id`)).map(r => [Number(r.quote_id), { supply: num(r.supply), vat: num(r.vat), total: num(r.total) }]));
  const saleAmountOf = (projectId: number | null) => {
    if (!projectId) return null;
    const q = (idn.get(projectId) as any)?.quoteId;
    return q != null ? (amtByQuote.get(Number(q)) ?? null) : null;
  };

  // ⑦ 외주업체 Master 이름(정규화) — CRM 원본만 있는 건이 개인 Master 로 연결됐지만 이름이 외주업체와 같으면 '구분 확인 필요'만 표시(자동 연결 안 함)
  const normName = (v: unknown) => String(v ?? "").toLowerCase().replace(/\([^)]*\)|\(주\)|주식회사|㈜|\s|\.|,/g, "");
  const vendorByName = new Map<string, { id: number; name: string }>();
  for (const c of await rows(dbx, sql`SELECT id, name FROM companies WHERE deleted_at IS NULL AND (company_type = 'vendor' OR coalesce(is_vendor, false))`)) {
    const k = normName(c.name); if (k && !vendorByName.has(k)) vendorByName.set(k, { id: Number(c.id), name: String(c.name) });
  }

  // 베리타스 명의 0원 기록(2026-11-25 대표 결정, 조회 복원) — 수행자가 회사 자체(베리타스)이고 지급액 0원인 미지급 개인 건은
  //   목록에 그대로 표시하되 '지급액 없음'(무료 리시버와 같은 정상 0원)으로 두고 누락·확인필요 경고를 만들지 않는다.
  //   실제 지급회차(지급액 > 0 조건)·송금 대상이 아닌 것은 기존과 같다. 지급액이 있는 건·지급완료 기록은 일반 기준 그대로.
  const INTERNAL_PAYEE = "베리타스";
  const internalIds = new Set((await rows(dbx, sql`SELECT id FROM users WHERE btrim(name) = ${INTERNAL_PAYEE}`)).map(r => Number(r.id)));
  // ⑧ 명부 원천징수(통번역사 상세 정산정보관리 지급방식) — 미지급 개인 수행정보 세금처리와 비교(표시만, 자동 변경 없음)
  const regUserIds = [...new Set([...pa.values()].filter(x => x.cat === "individual" && x.individual_user_id != null).map(x => Number(x.individual_user_id)))];
  const regPm = new Map((await rows(dbx, sql`SELECT translator_id, payment_method FROM translator_sensitive WHERE translator_id IN (${inList(regUserIds)})`))
    .map(r => [Number(r.translator_id), (r.payment_method ?? null) as string | null]));
  const TREAT_LABEL: Record<string, string> = { domestic_3_3: "3.3%", domestic_2_2: "2.2%", exempt: "원천징수 제외", tax_review_required: "세금계산서·세무 확인", nonresident_custom: "원천징수 제외", treaty_reduction_or_exemption: "원천징수 제외" };
  // 수행정보 화면과 같은 정규화 — 미사용 레거시(비거주자·조세조약)는 '원천징수 제외'와 같은 것으로 본다
  const normTreat = (t: unknown) => (t === "nonresident_custom" || t === "treaty_reduction_or_exemption" ? "exempt" : String(t ?? ""));
  const out: any[] = [];
  for (const b of base) {
    const bl: Blocker[] = [];
    const add = (cat: Blocker["cat"], code: string, text: string, action: string) => { if (!bl.some(x => x.code === code)) bl.push({ cat, code, text, action }); };
    let kind: "platform" | "crm_converted" | "crm_only";
    let p: any = null, masterId: number | null = null, vendorId: number | null = null, saleNo: string | null = null;
    let conversion: { ok: boolean; reason?: string } | null = null;
    if (b.source === "current") { kind = "platform"; p = pa.get(Number(b.id)); }
    else {
      const l = lin.get(Number(b.id)); const lm = legacyMaster.get(Number(b.id));
      saleNo = lm?.sale_no ?? null;
      masterId = lm?.master_id != null ? Number(lm.master_id) : (b.act_user_id != null ? Number(b.act_user_id) : null);
      if (l?.pa_id) { kind = "crm_converted"; p = pa.get(Number(l.pa_id)); } else kind = "crm_only";
    }
    if (p) {
      saleNo = saleNo ?? p.legacy_sale_no ?? null;
      if (p.cat === "vendor") vendorId = p.vendor_company_id != null ? Number(p.vendor_company_id) : null;
      else masterId = p.individual_user_id != null ? Number(p.individual_user_id) : masterId;
    }
    // 지급금액 출처(통합 집계 PROG 와 같은 기준 — 지급회차 통합조회·지급명세서와 일치):
    //   platform = 플랫폼 수행정보 / platform_fallback = CRM 전환 미지급 건을 현재 수행정보 등록값(외주 공급가+부가세, CRM 0원 건)으로 / crm = CRM 원본
    const amountSource: "platform" | "crm" | "platform_fallback" = b.source === "current" ? "platform" : b.amount_source === "platform" ? "platform_fallback" : "crm";
    const pretaxV = num(b.pretax), posttaxV = num(b.posttax);
    // 원천세: 플랫폼 기준 개인 = 세전−세후, 외주 = 0(부가세는 세후−세전)
    const withholdingV = b.source === "current" ? num(b.withholding) : amountSource === "platform_fallback" ? (p?.cat === "vendor" ? 0 : Math.round((pretaxV - posttaxV) * 100) / 100) : num(b.withholding);
    const amount = pretaxV;
    // 지급완료: 플랫폼 = 수행정보 지급상태 / CRM(전환·원본) = 통합 집계 PROG 판정(legacy_paid) — 전환 수행정보 지급완료 기록 포함,
    //   전환 시 자동으로 붙은 '과거 지급 확인 필요' 보류(확인 전)는 원본 규칙 그대로(고객 입금정보 변경으로 지급완료 판정이 바뀌지 않게, 2026-11-25).
    const paid = kind === "platform" ? p?.payment_status === "paid" : b.legacy_paid === true;
    // 외화 지급(개인 지급통화 외화 / 외주 해외송금 외화 계약) — 외화 금액은 원화 합계와 따로 집계, 원화 송금(IBK) 대상 아님
    const payCurrency: string | null = p && p.pay_currency && p.pay_currency !== "KRW" && (p.cat === "individual" || p.vendor_settlement_type === "overseas") ? String(p.pay_currency) : null;
    const foreignAmount: number | null = payCurrency && p.foreign_amount != null ? num(p.foreign_amount) : null;
    // 지급 대상 구분·지급금액(lib/payoutAmount — 지급명세서와 같은 기준). 현재 수행정보(플랫폼·전환)가 기준, CRM 원본만 있으면 개인(CRM 기록).
    const payeeType: PayeeType = p ? (p.cat === "vendor" ? "vendor" : "individual") : "individual";
    const fromPlatform = amountSource !== "crm";
    const pay = splitPayAmount({ payeeType, source: fromPlatform ? "current" : "legacy", pretax: amount, posttax: posttaxV,
      withholding: fromPlatform ? withholdingV : null,
      current: !fromPlatform && p ? { category: p.cat, treatment: p.treatment, rate: p.wrate, evidence: p.evidence } : null });
    const dd: string | null = b.delivery_date ?? null, pd: string | null = b.payout_date ?? null;

    const freeService = scope === "date" && !!DATE_DECISIONS[d]?.freeService.has(String(b.source_key));
    // 플랫폼 수행정보 지급보류(담당자 설정) — 지급회차·송금 대상 아님(공식 지급회차 수집 조건도 미지급만)
    const manualHold = kind === "platform" && p?.payment_status === "payment_hold";
    // ── 후보 사유(범위 date) ──
    let candidate = "all";
    if (scope === "date") {
      candidate = pd === d ? "base" : (dd && dd >= win!.from && dd <= win!.to) ? "delivery_window" : !pd ? "no_payout_date" : (pd < today ? "carry_over" : "other");
    }

    // ── D: 과거 지급 여부·중복 ──
    if (kind === "crm_only" && !paid) {
      add("D", "crm_unconfirmed", "과거 CRM 지급 여부 미확인(CRM 원본만 있음)", "미지급 확인 후 [지급 전환] 요청·승인");
      if (amount > 0) {
        const elig = await checkEligibility(dbx, Number(b.id));
        conversion = elig.ok ? { ok: true } : { ok: false, reason: (elig as any).reason };
      } else conversion = { ok: false, reason: "지급액이 0원인 건은 전환할 수 없습니다." };
      if (!conversion.ok) add("D", "conversion_blocked", `지급 전환 불가: ${conversion.reason}`, "원본 지급액·지급 여부 확인");
    }
    if (kind === "crm_converted" && p?.payment_status === "payment_hold" && !paid)
      add("D", "legacy_review", "과거 CRM 지급 여부 미확인(전환 수행정보 지급보류)", "[과거 지급 확인]: 미지급이면 미지급 처리 → 지급회차 / 지급했으면 지급완료 기록");
    if (paid && scope === "date" && pd === d) add("D", "already_paid", "이미 지급완료 — 재지급 금지", "송금 대상에서 제외");
    if (p?.payment_status === "paid" && !b.actual_payment_date && !(kind !== "platform" && dd && dd <= LEGACY_PAID_DELIVERY_CUTOFF))
      add("D", "paid_no_actual", "지급완료 상태인데 실제 지급일 누락(지급완료 기록 누락)", "[지급완료 확인]으로 실제 지급일·지급액 기록");
    if (!paid && pd && pd < today)
      add("D", "overdue", `지급일 경과(${pd})·지급완료 확인 없음`, "지급 여부 확인 — 지급했으면 지급완료 기록, 아니면 다음 지급회차 포함");
    if (kind === "platform" && dupByPa.has(Number(b.id)))
      add("D", "dup_crm", `CRM 원본(${dupByPa.get(Number(b.id))!.map(x => "#" + x).join(", ")})과 같은 수행 — 중복 지급 후보`, "한쪽만 지급(중복 건 정리)");
    if (b.source === "legacy" && dupRows.has(Number(b.id)))
      add("D", "dup_platform", "플랫폼 수행정보와 같은 수행 — 중복 지급 후보(합계 1회 집계)", "한쪽만 지급(중복 건 정리)");
    if (manualHold) add("C", "payment_hold", "지급보류 설정(수행정보) — 지급회차·송금 제외", "보류 사유 해소 후 지급보류 해제");
    if (p?.payout_round_id != null && !paid) add("I", "in_round", `지급회차 #${p.payout_round_id} 배정됨`, "회차에서 처리");

    // ── C: 금액·세금·수행정보·날짜 ──
    if (payCurrency) {
      // 외화 지급 — 원화 지급액이 0원이어도 '미입력'이 아니다. 외화 금액이 없을 때만 확인 필요. 환율 미확정이면 원화 원가 미확정.
      if (!(foreignAmount != null && foreignAmount > 0)) add("C", "foreign_amount_missing", `외화 지급(${payCurrency}) 금액 미입력`, "수행정보에 외화 지급금액 입력");
      add("I", "foreign_pay", `외화 지급 ${payCurrency}${foreignAmount != null ? " " + foreignAmount.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : ""} — 원화 합계·국내 원화 송금파일 제외(별도 해외송금)`, "해외송금으로 별도 지급");
      if (!(amount > 0)) add("I", "foreign_krw_unconfirmed", "환율 미확정 — 원화 원가·이익률 미확정", "송금 시 적용환율 확인");
    } else if (amount <= 0) {
      if (freeService) add("I", "free_service", "지급액 없음 — 무료 제공(대표 확인) 정상 0원, 송금 대상 아님", "송금 제외");
      else add("C", "amount_missing", "지급액 미입력(0원)", "수행정보 지급액 입력(무상이면 사유 기록)");
    }
    if (amountSource === "platform_fallback") add("I", "amount_from_platform",
      `현재 수행정보 기준 지급액 반영(${p?.cat === "vendor" ? `공급가 ${Math.round(amount).toLocaleString("ko-KR")}원 + 부가세 → 지급합계 ${Math.round(posttaxV).toLocaleString("ko-KR")}원` : `세전 ${Math.round(amount).toLocaleString("ko-KR")}원`}) · CRM 원본 세전 ${Math.round(num(b.crm_pretax)).toLocaleString("ko-KR")}원/세후 ${Math.round(num(b.crm_posttax)).toLocaleString("ko-KR")}원 보존`, "수행정보 등록값 확인");
    if (kind === "crm_converted" && p && amountSource === "crm" && !paid && num(p.cost_total) > 0 && Math.abs(num(p.cost_total) - amount) >= 1)
      add("C", "amount_mismatch", `CRM 원본 지급액(세전 ${Math.round(amount).toLocaleString("ko-KR")}원) ≠ 현재 수행정보 지급액(${Math.round(num(p.cost_total)).toLocaleString("ko-KR")}원)`, "실제 지급액 확인 후 CRM·수행정보 정리");
    if (!dd) add("C", "no_delivery", "납품일 누락", "납품일 입력(원본 확인 — 추정 입력 금지)");
    if (!pd && !paid) add("C", "no_payout_date", amount > 0 ? "지급예정일 누락(지급액 있음)" : "지급예정일 누락", "지급예정일 확인·입력");
    if (dd && pd && pd < dd) add("I", "date_order", `지급일(${pd})이 납품일(${dd})보다 이름`, "날짜 확인");
    // 날짜 불일치(덮어쓰지 않고 표시): 플랫폼 행 = 연결 CRM 원본 납품일 비교 / CRM 전환 행 = PROG 의 CRM·플랫폼 납품일·지급일 비교(같은 기준)
    if (kind === "platform" && p?.crm_delivery && dd && p.crm_delivery !== dd) add("I", "date_mismatch", `납품일 불일치(플랫폼 ${dd} ≠ CRM ${p.crm_delivery})`, "실제 납품일 확인");
    if (b.source === "legacy" && b.delivery_mismatch) add("I", "date_mismatch", `납품일 불일치(CRM ${b.crm_delivery_date} ≠ 플랫폼 ${b.platform_delivery_date})`, "실제 납품일 확인");
    if (b.source === "legacy" && b.payout_mismatch) add("I", "payout_date_mismatch", `지급예정일 불일치(CRM ${b.crm_payout_date} ≠ 플랫폼 ${b.platform_payout_date})`, "실제 지급예정일 확인");
    if (scope === "date" && candidate === "delivery_window" && pd && pd !== d) add("I", "window_mismatch", `${win!.from}~${win!.to} 납품인데 지급일 ${pd}`, "지급예정일 확인");
    if (kind === "platform" && p && !paid) {
      if (!p.delivery_confirmed) add("C", "no_confirm", "납품확인 미완료", "담당 PM 납품확인");
      if (p.cat === "individual" && p.individual_user_id == null) add("C", "no_payee", "수행자 미연결(통번역사 Master 미지정)", "수행자 지정");
      if (p.cat === "vendor" && p.vendor_company_id == null) add("C", "no_payee", "수행자 미연결(외주업체 미지정)", "외주업체 지정");
      if (p.cat === "individual" && !p.treatment) add("C", "no_tax", "세금처리(원천징수) 미설정", "세금처리 지정");
      if (p.cat === "individual" && p.treatment === "tax_review_required") add("C", "tax_review", "세금처리 '세무 확인 필요' — 원천세 0으로 계산됨", "세율 확정");
      if (p.cat === "vendor" && p.vendor_settlement_type === "overseas") add("I", "overseas", "해외송금 외주 — IBK 대량이체 제외", "별도 해외송금");
      if (p.payout_round_id == null) add("I", "no_round", "지급회차 미배정", "지급회차 생성 시 자격 충족하면 자동 포함");
    }
    if (kind !== "platform" && masterId == null && vendorId == null && !paid) add("C", "no_payee", "수행자 미연결(과거 CRM 이름만)", "통번역사 Master 연결 확인");
    // 명부 원천징수 불일치(2026-11) — 미지급 개인 수행정보만(지급완료·외주업체 제외). 세금처리·원천세·실지급액은 바꾸지 않는다.
    //  · 명부 해외 송금방식(해외 은행·PayPal)은 원천징수 등록값이 아니므로 비교하지 않는다(해외송금이라는 이유만으로 불일치 판정 금지).
    //  · 명부 미등록·미확정(세무 검토)은 참고(I)만. 수행정보 세금처리 미설정은 기존 no_tax 로 표시.
    if (p && p.cat === "individual" && !paid && p.individual_user_id != null && p.treatment) {
      const pm = regPm.get(Number(p.individual_user_id)) ?? null;
      if (!(pm === "overseas_bank" || pm === "overseas_paypal")) {
        const regT = masterTreatmentOf(pm);
        if (regT == null) add("I", "tax_registry_missing", pm === "domestic_bank_transfer" ? "명부 원천징수 미확정(세무 검토)" : "명부 원천징수 미등록",
          "통번역사 상세 정산정보관리에서 원천징수 등록");
        else if (normTreat(p.treatment) !== regT) add("C", "tax_registry_mismatch",
          `명부 원천징수(${TREAT_LABEL[regT] ?? regT}) ≠ 수행정보 세금처리(${TREAT_LABEL[p.treatment] ?? p.treatment})`,
          "명부 확인 후 수행정보 세금처리 정정(자동 변경 없음)");
      }
    }
    // 세금 충돌(CRM 원천세 ↔ 현재 세금 설정, 외주업체인데 원천세 기록 등) — 확인 필요만 표시, 금액·지급상태 불변
    if (pay.taxConflict && !paid) add("C", "tax_conflict", pay.taxConflict, "실제 세금(원천세·부가세) 확인 후 수행정보·지급액 정정");
    if (kind === "crm_only" && !paid) {
      const v = vendorByName.get(normName(b.translator));
      if (v) add("C", "payee_type_check", `개인 통번역사로 연결됐으나 외주업체 '${v.name}'(#${v.id})와 이름 일치 — 개인/외주 구분 확인`, "지급 전환 시 수행자 구분(개인·외주업체) 지정");
    }

    // ── B: 계좌 ──
    let hasAccount = false;
    if (!paid) {
      if (vendorId != null) { hasAccount = !!vAcct.get(vendorId)?.acct; if (!hasAccount) add("B", "no_account", "외주업체 계좌 미등록", "외주업체 계좌 등록"); }
      else if (masterId != null) {
        const a = uAcct.get(masterId); hasAccount = !!a?.acct;
        if (!hasAccount) add("B", "no_account", "통번역사 계좌(은행·계좌번호) 미등록", "통번역사 정산정보에 계좌 등록");
        else if (!a.holder) add("B", "no_holder", "예금주 미등록", "예금주 등록");
        if (a?.hold) add("B", "payee_hold", "통번역사 정산정보 지급보류 설정", "지급보류 해제 여부 확인");
        if (a?.deleted) add("C", "payee_deleted", "수취인 Master 삭제(제외) 상태", "기존 기록 복원 또는 연결 정정");
      }
    } else hasAccount = vendorId != null ? !!vAcct.get(vendorId)?.acct : masterId != null ? !!uAcct.get(masterId)?.acct : false;

    // 베리타스 명의 0원 미지급 기록 — '지급액 없음'(경고 없음). 참고(I) 사유만 남긴다.
    const internalZero = !paid && payeeType === "individual" && !(amount > 0) && !(foreignAmount != null && foreignAmount > 0)
      && (normName(b.translator) === normName(INTERNAL_PAYEE) || (masterId != null && internalIds.has(masterId)));
    if (internalZero) {
      for (let i = bl.length - 1; i >= 0; i--) if (bl[i].cat !== "I") bl.splice(i, 1);
      add("I", "internal_zero", "지급액 없음 — 베리타스 명의 0원 기록(외부 지급·송금 대상 아님)", "송금 제외");
    }
    // 무료 제공 확인 0원(대표 확인) — 정상 0원 수행정보: 과거 지급 여부 확인·지급액 미입력 경고 없음(지급할 금액이 없음)
    if (freeService) for (let i = bl.length - 1; i >= 0; i--) if (["legacy_review", "crm_unconfirmed", "overdue", "amount_missing"].includes(bl[i].code)) bl.splice(i, 1);
    // 플랫폼 지급보류 — '지급보류'만 표시(금액·납품확인 등 부가 확인사항 숨김). 중복·과거 지급 여부(D) 등 지급 위험 검증은 유지.
    if (manualHold) for (let i = bl.length - 1; i >= 0; i--) if ((bl[i].cat === "B" || bl[i].cat === "C") && bl[i].code !== "payment_hold") bl.splice(i, 1);
    const roundEligible = kind === "platform" && !!p && !payCurrency && p.payment_status === "unpaid" && p.has_delivery && p.delivery_confirmed && num(p.cost_total) > 0
      && ((p.cat === "individual" && p.individual_user_id != null && !!p.treatment) || (p.cat === "vendor" && p.vendor_company_id != null));
    const cats = new Set(bl.filter(x => x.cat !== "I").map(x => x.cat));
    // 지급상태 표시는 세금·구분 확인 사유(tax_conflict·payee_type_check)로 바꾸지 않는다(상태 자동 변경 금지) — 점검 분류(state)에만 반영
    const payCats = new Set(bl.filter(x => x.cat !== "I" && x.code !== "tax_conflict" && x.code !== "payee_type_check").map(x => x.cat));
    const payDisplay: PayDisplay = paid ? "paid"
      : (freeService || internalZero) ? "no_amount"
      : manualHold ? "hold"
      : (kind === "crm_only" || p?.payment_status === "payment_hold" || bl.some(x => x.code.startsWith("dup_"))) ? "review"
      : (payCats.has("B") || payCats.has("C")) ? "prep" : "scheduled";
    const state: ReadinessState = cats.has("D") ? "D" : cats.has("C") ? "C" : cats.has("B") ? "B" : "A";
    out.push({
      source: b.source, kind, sourceKey: b.source_key, crmRowId: b.source === "legacy" ? Number(b.id) : (p?.crm_row_id ?? null),
      assignmentId: p ? Number(p.id) : null, projectId: p ? Number(p.project_id) : null, projectTitle: p?.project_title ?? null,
      // 판매번호(표시 전용): 과거 CRM 판매번호 우선 → 없으면 소속 판매의 유효 대표 견적 기준 판매번호(판매관리와 같은 saleIdentity 표시형).
      //   수행정보에 견적 연결값이 없는 행(수행정보 직접 추가 등)도 판매 기준으로 표시. 수행정보 연결값·금액·상태는 바꾸지 않는다.
      saleNo: saleNo ?? (p?.project_id != null ? ((idn.get(Number(p.project_id)) as any)?.saleNumber ?? null) : null),
      quoteNumber: p?.quote_number ?? null, masterId, vendorId, client: b.client,
      // 실제 수행자 통번역사 Master(언어·상세정보 조회용) — 외주업체 지급 건도 수행자 Master 가 연결돼 있으면 사용
      performerMasterId: p?.cat === "vendor" ? (p.individual_user_id != null ? Number(p.individual_user_id) : masterId) : masterId,
      // 지급 대상(payee): 외주업체 지급 건은 외주업체 Master 명으로 통일(판매건·출처 무관). 실제 수행자(performerName)는 따로 표시 —
      //   CRM 전환·원본 = CRM 통번역사명, 플랫폼 = 연결 CRM 원본 통번역사명 › 수행자명 스냅샷. 업체명과 같으면 공란.
      payee: payeeType === "vendor" && p?.vendor_name ? p.vendor_name : b.translator,
      // 상품·업무(엑셀 전용) — 판매상세 C. 수행정보 '상품·업무' 원문 그대로(플랫폼·CRM 전환 = 현재 수행정보).
      //   CRM 원본만 있는 건 = 원본 진행관리 행의 상품명 › 내용(전환 시 수행정보 상품·업무와 같은 기준). 요약·생략 없음, 없으면 null.
      productWork: p ? (p.product_name ?? null) : (() => {
        const raw = legacyMaster.get(Number(b.id))?.source_raw;
        if (!raw || typeof raw !== "object") return null;
        const rr = rawRowFromRecord(raw, "진행관리", 0);
        return rr.productName || rr.content || null;
      })(),
      // 외주업체 건 실제 수행자: 수행정보에 연결된 수행자 Master 만(이름은 아래 명부 조회). CRM 원본 이름만으로 수행자를 판단하지 않는다.
      //   외주업체 담당자(vendorContactName)는 외주업체 명부의 대표 담당자 기준(아래).
      performerName: null, performerUserId: payeeType === "vendor" && p?.individual_user_id != null ? Number(p.individual_user_id) : null,
      deliveryDate: dd, payoutDate: pd, actualPaymentDate: b.actual_payment_date ?? null,
      // 날짜 출처(추가 필드): CRM 원본·플랫폼 값과 불일치 여부 — 화면·엑셀 공통
      dateSource: b.source === "legacy" ? { crmDelivery: b.crm_delivery_date ?? null, platformDelivery: b.platform_delivery_date ?? null,
        crmPayout: b.crm_payout_date ?? null, platformPayout: b.platform_payout_date ?? null } : null,
      dateMismatch: b.delivery_mismatch === true || b.payout_mismatch === true || (kind === "platform" && !!p?.crm_delivery && !!dd && p.crm_delivery !== dd),
      pretax: amount, withholding: Math.round(withholdingV * 100) / 100, posttax: Math.round(posttaxV * 100) / 100, amountSource,
      // CRM 원본 지급액(보존·참고) — 현재 수행정보 기준으로 표시한 전환 건에서 원본과 비교용
      crmPretax: b.source === "legacy" ? num(b.crm_pretax) : null, crmPosttax: b.source === "legacy" ? num(b.crm_posttax) : null,
      // 지급통화(KRW 기본)·외화 지급금액 — 외화 건은 원화 합계와 별도(foreignTotals), 원화 송금파일 제외
      payCurrency: payCurrency ?? "KRW", foreignAmount,
      // 지급금액 구분(2026-11-23): 개인 = 세전/원천세/세후, 외주업체 = 공급가/부가세/지급합계 — 화면·엑셀·지급명세서 공통
      payeeType, payeeTypeLabel: payeeType === "vendor" ? "외주업체" : "개인", vendorName: p?.cat === "vendor" ? (p.vendor_name ?? null) : null,
      payAmount: { withholding: pay.withholding, supply: pay.supply, vat: pay.vat, payTotal: pay.payTotal }, taxConflict: pay.taxConflict,
      paymentStatus: p?.payment_status ?? (b.legacy_paid ? "paid" : "unconfirmed"), payoutRoundId: p?.payout_round_id ?? null,
      payDisplay, payDisplayLabel: PAY_DISPLAY_LABEL[payDisplay],
      // 화면 공통 지급상태(lib/payDisplayStatus — 지급회차 통합 조회와 같은 기준, 표시 전용)
      ...(() => { const k = payStatusOf({ paid, free: freeService || internalZero, hold: manualHold, review: payDisplay === "review",
        amountMissing: isAmountMissing(amount, payCurrency, foreignAmount), payoutDate: pd, today });
        return { payStatus: k, payStatusLabel: PAY_STATUS_LABEL[k] }; })(),
      saleAmount: saleAmountOf(p ? Number(p.project_id) : null),   // { supply, vat, total } | null — 판매건 단위 금액(행마다 같은 값, 합산 시 판매건당 1회)
      hasAccount, roundEligible, conversion, candidate,
      // 합계 이중집계 방지 — 플랫폼 수행과 같은 CRM 원본 행은 합계에서 제외(표시는 유지)
      countedInTotals: !(b.source === "legacy" && dupRows.has(Number(b.id))),
      blockers: bl, actions: [...new Set(bl.filter(x => x.cat !== "I").map(x => x.action))],
      state, stateLabel: READINESS_LABEL[state],
    });
  }
  // 고객 선입금 잔액 확인 중인 CRM 원본(통번역사 지급 건 아님) — 해당 지급일 점검(화면·엑셀)에서만 제외. 데이터·다른 지급일·전체 기간은 유지.
  let excludedPrepaid = 0;
  const excludedByDecision: Record<string, number> = {};
  if (scope === "date") {
    const ex = PREPAID_REVIEW_EXCLUSIONS[d];
    if (ex) for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      if (ex.has(`${String(o.client ?? "").trim()}|${String(o.saleNo ?? "").trim()}`)) { out.splice(i, 1); excludedPrepaid++; }
    }
    // 지급일별 대표 확인 결정 — 지정 건·지급예정일 미기재 건 제외(이 지급일 점검만)
    const dec = DATE_DECISIONS[d];
    if (dec) for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      const why = dec.exclude.get(String(o.sourceKey)) ?? (dec.excludeNoPayoutDate && o.candidate === "no_payout_date" ? "지급예정일 미기재(이 지급일 대상 아님)" : null);
      if (why) { out.splice(i, 1); excludedByDecision[why] = (excludedByDecision[why] ?? 0) + 1; }
    }
  }
  // 주민등록번호(마스킹만) — 개인 수행자(Master 연결)만. 외주업체·미연결은 공란. 전체번호는 별도 관리자 전용 API.
  const rrnMasked = await loadResidentNumbers(dbx, out.filter(o => o.vendorId == null && o.masterId != null).map(o => o.masterId), false);
  for (const o of out) o.residentNumberMasked = o.vendorId == null && o.masterId != null ? (rrnMasked.get(o.masterId) ?? null) : null;
  // 연락처·이메일 — 명부 ID 기준만(이름 매칭 없음).
  //   개인 = 통번역사 프로필 연락처·계정 이메일. 통합(translator_merges active)된 Master 는 대표 Master 의 최신 정보.
  //   외주업체 = 업체 전화(없으면 휴대폰)·이메일, 업체에 없으면 그 업체 담당자(contacts, 대표 담당자 우선)의 휴대폰·전화·이메일.
  //   과거 CRM 이관 임시 이메일(@crm-migrated.invalid)·미등록은 null(공란).
  const uIds = [...new Set(out.filter(o => o.vendorId == null && o.masterId != null).map(o => o.masterId as number))];
  const vIds = [...new Set(out.filter(o => o.vendorId != null).map(o => o.vendorId as number))];
  const uContact = new Map((await rows(dbx, sql`SELECT x.id, nullif(btrim((SELECT tp.phone FROM translator_profiles tp WHERE tp.user_id = u.id LIMIT 1)), '') AS phone, u.email,
      nullif(btrim(u.name), '') AS name, u.deleted_at IS NOT NULL AS deleted
    FROM (SELECT i AS id, coalesce((SELECT m.representative_master_id FROM translator_merges m WHERE m.merged_master_id = i AND m.status = 'active' LIMIT 1), i) AS cid
          FROM unnest(ARRAY[${inList(uIds)}]::int[]) AS i) x JOIN users u ON u.id = x.cid`)).map(r => [Number(r.id), r]));
  const vContact = new Map((await rows(dbx, sql`SELECT c.id,
      coalesce(nullif(btrim(c.phone), ''), nullif(btrim(c.mobile), ''), nullif(btrim(k.mobile), ''), nullif(btrim(k.phone), ''), nullif(btrim(k.office_phone), '')) AS phone,
      coalesce(nullif(btrim(c.email), ''), nullif(btrim(k.email), '')) AS email, nullif(btrim(k.name), '') AS contact_name
    FROM companies c LEFT JOIN LATERAL (SELECT * FROM contacts t WHERE t.company_id = c.id AND t.deleted_at IS NULL
      ORDER BY t.is_primary DESC, (coalesce(btrim(t.email), '') <> '' OR coalesce(btrim(t.mobile), '') <> '' OR coalesce(btrim(t.phone), '') <> '') DESC, t.id LIMIT 1) k ON true
    WHERE c.id IN (${inList(vIds)})`)).map(r => [Number(r.id), r]));
  // 언어·상세정보(엑셀 전용) — 실제 수행자 통번역사 Master 의 최신 명부 가능언어(language_pairs)·상세정보(bio) 원문 그대로.
  //   개인·외주업체 지급 구분 없음: performerMasterId(개인 = 수행자 Master / 외주업체 = 수행정보 수행자 › CRM 확정 Master 연결).
  //   통합(translator_merges active)된 Master 는 대표 Master 정보. Master 없음·미등록은 null(공란). 외주업체 주요업무로 대체하지 않음.
  const pIds = [...new Set(out.map(o => o.performerMasterId).filter((v: unknown) => v != null))] as number[];
  const pRoster = new Map((await rows(dbx, sql`SELECT x.id, nullif(btrim(tp.language_pairs), '') AS langs, nullif(btrim(tp.bio), '') AS detail
    FROM (SELECT i AS id, coalesce((SELECT m.representative_master_id FROM translator_merges m WHERE m.merged_master_id = i AND m.status = 'active' LIMIT 1), i) AS cid
          FROM unnest(ARRAY[${inList(pIds)}]::int[]) AS i) x JOIN translator_profiles tp ON tp.user_id = x.cid`)).map(r => [Number(r.id), r]));
  const perfIds = [...new Set(out.map(o => o.performerUserId).filter((v: unknown) => v != null))] as number[];
  const pName = new Map((await rows(dbx, sql`SELECT x.id, nullif(btrim(u.name), '') AS name
    FROM (SELECT i AS id, coalesce((SELECT m.representative_master_id FROM translator_merges m WHERE m.merged_master_id = i AND m.status = 'active' LIMIT 1), i) AS cid
          FROM unnest(ARRAY[${inList(perfIds)}]::int[]) AS i) x JOIN users u ON u.id = x.cid AND u.deleted_at IS NULL`)).map(r => [Number(r.id), r.name as string | null]));
  const cleanEmail = (e: unknown) => { const s = String(e ?? "").trim(); return s && !isLegacyPlaceholderEmail(s) ? s : null; };
  for (const o of out) {
    const c = o.vendorId != null ? vContact.get(o.vendorId) : o.masterId != null ? uContact.get(o.masterId) : null;
    o.payeePhone = c?.phone ?? null; o.payeeEmail = cleanEmail(c?.email);
    const pr = o.performerMasterId != null ? pRoster.get(o.performerMasterId) : null;
    o.payeeLanguages = pr?.langs ?? null; o.payeeDetail = pr?.detail ?? null;
    // 외주업체 담당자(외주업체 명부 대표 담당자) · 실제 수행자(수행정보 연결 Master 의 현재 명부 이름)
    o.vendorContactName = o.vendorId != null ? (vContact.get(o.vendorId)?.contact_name ?? null) : null;
    if (o.performerUserId != null) o.performerName = pName.get(o.performerUserId) ?? null;
    // 이름: 개인 수행자가 Master(삭제되지 않은, 통합 시 대표)에 연결돼 있으면 현재 명부 이름 우선. CRM 원본·수행정보 스냅샷 이름은 이력(sourcePayeeName)으로 보존.
    o.sourcePayeeName = null;
    if (o.vendorId == null && c?.name && !c.deleted && c.name !== String(o.payee ?? "").trim()) { o.sourcePayeeName = o.payee ?? null; o.payee = c.name; }
  }
  const order: Record<string, number> = { base: 0, delivery_window: 1, carry_over: 2, no_payout_date: 3, other: 4, all: 0 };
  out.sort((a, b) => (order[a.candidate] - order[b.candidate]) || a.state.localeCompare(b.state) || String(a.payee ?? "").localeCompare(String(b.payee ?? "")));
  // 원화 합계 — 외화 지급 건(payCurrency ≠ KRW)은 원화 합계에 넣지 않고 foreignTotals 로 별도 집계
  //   실지급(posttax) = 지급대상자별 원 단위 반올림 후 합산(2026-11-26 — 지급회차·IBK 송금파일과 같은 기준). 건별 합계는 posttaxExact, 차이는 payRoundingAdjustment.
  const domKey = (x: any) => domesticPayeeKey({ source: x.source, payeeType: x.payeeType, payCurrency: x.payCurrency, userId: x.masterId, vendorId: x.vendorId });
  const sum = (arr: any[]) => { const c = arr.filter(x => x.countedInTotals && x.payCurrency === "KRW"); const w = wonPayTotals(c, (x: any) => x.posttax, domKey);
    return { count: arr.length, counted: c.length, pretax: c.reduce((s, x) => s + x.pretax, 0), posttax: w.pay, posttaxExact: w.exact, payRoundingAdjustment: w.roundingAdjustment,
    vendorCount: c.filter(x => x.payeeType === "vendor").length, vat: Math.round(c.reduce((s, x) => s + (x.payAmount.vat ?? 0), 0)) }; };
  const by = (f: (x: any) => string) => { const m: Record<string, any> = {}; for (const k of [...new Set(out.map(f))]) m[k] = sum(out.filter(x => f(x) === k)); return m; };
  const issueCounts: Record<string, number> = {};
  for (const o of out) for (const b of o.blockers) issueCounts[b.code] = (issueCounts[b.code] ?? 0) + 1;
  return {
    scope, payoutDate: scope === "date" ? d : null, deliveryWindow: win, today, items: out, excludedPrepaid, excludedByDecision,
    summary: { total: sum(out), foreignTotals: foreignTotalsOf(out), byState: by(x => x.state), byKind: by(x => x.kind), byCandidate: by(x => x.candidate),
      roundEligible: sum(out.filter(x => x.roundEligible)),
      payStatusCounts: out.reduce((c: Record<PayStatusKey, number>, x: any) => { c[x.payStatus as PayStatusKey]++; return c; }, emptyStatusCounts()),
      duplicates: out.filter(x => x.blockers.some((b: Blocker) => b.code.startsWith("dup_"))).length, issueCounts },
  };
}
