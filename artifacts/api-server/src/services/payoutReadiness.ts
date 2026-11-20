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
      prog.actual_payment_date, prog.pretax, prog.posttax, (prog.pretax - prog.posttax) AS withholding, prog.legacy_paid, prog.act_user_id
    FROM prog WHERE ${legacyWhere}
    UNION ALL
    SELECT 'current', cur.id, cur.source_key, cur.translator, cur.client, cur.delivery_date, cur.payout_date,
      cur.actual_payment_date, cur.pretax, cur.posttax, cur.withholding_tax, false, NULL::int
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
      (SELECT s.source_raw->>'판매번호' FROM legacy_sales_progress_links l JOIN legacy_archive_rows s ON s.id = l.sale_row_id AND s.is_effective WHERE l.progress_row_id = r.id AND l.decision = 'confirmed' ORDER BY s.id DESC LIMIT 1) AS sale_no
    FROM legacy_archive_rows r WHERE r.id IN (${inList(legacyIds)})`)).map(r => [Number(r.row_id), r]));

  // ③ 플랫폼 수행정보(현재 행 + 전환 행) — 공식 지급회차 자격조건과 같은 항목 + 전환 원본 납품일(불일치 확인)
  const paIds = [...curIds, ...[...lin.values()].map(l => Number(l.pa_id)).filter(Boolean)];
  const pa = new Map((await rows(dbx, sql`
    SELECT pa.id, pa.project_id, p.title AS project_title, pa.performer_category::text AS cat, pa.individual_user_id, pa.vendor_company_id,
      pa.payment_status::text AS payment_status, pa.status::text AS work_status, pa.payout_round_id,
      pa.delivery_date IS NOT NULL AS has_delivery, pa.delivery_confirmed, coalesce(pa.cost_total, 0) AS cost_total,
      pa.withholding_treatment::text AS treatment, pa.vendor_settlement_type,
      (SELECT q.quote_number FROM quotes q WHERE q.id = pa.quote_id) AS quote_number,
      (SELECT m.legacy_id FROM legacy_master_mappings m WHERE m.source_system = 'old_crm' AND m.entity_type = 'sale' AND m.entity_id = pa.project_id AND m.status = 'active' LIMIT 1) AS legacy_sale_no,
      (SELECT substring(r.source_raw->>'통번역사납품일' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}') FROM import_row_sources s JOIN legacy_archive_rows r ON r.id::text = substring(s.row_key from 10)
        WHERE s.module = 'legacy_sale_activation' AND s.entity_id = pa.id AND s.row_key LIKE 'progress:%' ORDER BY s.id DESC LIMIT 1) AS crm_delivery,
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
    const amount = num(b.pretax);
    const paid = p ? p.payment_status === "paid" : b.legacy_paid === true;
    const dd: string | null = b.delivery_date ?? null, pd: string | null = b.payout_date ?? null;

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
    if (kind === "crm_converted" && p?.payment_status === "payment_hold")
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
    if (p?.payout_round_id != null && !paid) add("I", "in_round", `지급회차 #${p.payout_round_id} 배정됨`, "회차에서 처리");

    // ── C: 금액·세금·수행정보·날짜 ──
    if (amount <= 0) add("C", "amount_missing", "지급액 미입력(0원)", "수행정보 지급액 입력(무상이면 사유 기록)");
    if (!dd) add("C", "no_delivery", "납품일 누락", "납품일 입력(원본 확인 — 추정 입력 금지)");
    if (!pd && !paid) add("C", "no_payout_date", amount > 0 ? "지급예정일 누락(지급액 있음)" : "지급예정일 누락", "지급예정일 확인·입력");
    if (dd && pd && pd < dd) add("C", "date_order", `지급일(${pd})이 납품일(${dd})보다 이름`, "날짜 확인");
    if (p?.crm_delivery && dd && p.crm_delivery !== dd) add("C", "date_mismatch", `납품일 불일치(플랫폼 ${dd} ≠ CRM ${p.crm_delivery})`, "실제 납품일 확인");
    if (scope === "date" && candidate === "delivery_window" && pd && pd !== d) add("C", "window_mismatch", `${win!.from}~${win!.to} 납품인데 지급일 ${pd}`, "지급예정일 확인");
    if (kind === "platform" && p && !paid) {
      if (!p.delivery_confirmed) add("C", "no_confirm", "납품확인 미완료", "담당 PM 납품확인");
      if (p.cat === "individual" && p.individual_user_id == null) add("C", "no_payee", "수행자 미연결(통번역사 Master 미지정)", "수행자 지정");
      if (p.cat === "vendor" && p.vendor_company_id == null) add("C", "no_payee", "수행자 미연결(외주업체 미지정)", "외주업체 지정");
      if (p.cat === "individual" && !p.treatment) add("C", "no_tax", "세금처리(원천징수) 미설정", "세금처리 지정");
      if (p.cat === "individual" && p.treatment === "tax_review_required") add("C", "tax_review", "세금처리 '세무 확인 필요' — 원천세 0으로 계산됨", "세율 확정");
      if (p.cat === "vendor" && p.vendor_settlement_type === "overseas") add("C", "overseas", "해외송금 외주 — IBK 대량이체 제외", "별도 해외송금");
      if (p.payout_round_id == null) add("I", "no_round", "지급회차 미배정", "지급회차 생성 시 자격 충족하면 자동 포함");
    }
    if (kind !== "platform" && masterId == null && !paid) add("C", "no_payee", "수행자 미연결(과거 CRM 이름만)", "통번역사 Master 연결 확인");

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

    const roundEligible = kind === "platform" && !!p && p.payment_status === "unpaid" && p.has_delivery && p.delivery_confirmed && num(p.cost_total) > 0
      && ((p.cat === "individual" && p.individual_user_id != null && !!p.treatment) || (p.cat === "vendor" && p.vendor_company_id != null));
    const cats = new Set(bl.filter(x => x.cat !== "I").map(x => x.cat));
    const state: ReadinessState = cats.has("D") ? "D" : cats.has("C") ? "C" : cats.has("B") ? "B" : "A";
    out.push({
      source: b.source, kind, sourceKey: b.source_key, crmRowId: b.source === "legacy" ? Number(b.id) : (p?.crm_row_id ?? null),
      assignmentId: p ? Number(p.id) : null, projectId: p ? Number(p.project_id) : null, projectTitle: p?.project_title ?? null,
      saleNo, quoteNumber: p?.quote_number ?? null, payee: b.translator, masterId, vendorId, client: b.client,
      deliveryDate: dd, payoutDate: pd, actualPaymentDate: b.actual_payment_date ?? null,
      pretax: amount, withholding: Math.round(num(b.withholding) * 100) / 100, posttax: Math.round(num(b.posttax) * 100) / 100,
      paymentStatus: p?.payment_status ?? (b.legacy_paid ? "paid" : "unconfirmed"), payoutRoundId: p?.payout_round_id ?? null,
      hasAccount, roundEligible, conversion, candidate,
      // 합계 이중집계 방지 — 플랫폼 수행과 같은 CRM 원본 행은 합계에서 제외(표시는 유지)
      countedInTotals: !(b.source === "legacy" && dupRows.has(Number(b.id))),
      blockers: bl, actions: [...new Set(bl.filter(x => x.cat !== "I").map(x => x.action))],
      state, stateLabel: READINESS_LABEL[state],
    });
  }
  const order: Record<string, number> = { base: 0, delivery_window: 1, carry_over: 2, no_payout_date: 3, other: 4, all: 0 };
  out.sort((a, b) => (order[a.candidate] - order[b.candidate]) || a.state.localeCompare(b.state) || String(a.payee ?? "").localeCompare(String(b.payee ?? "")));
  const sum = (arr: any[]) => { const c = arr.filter(x => x.countedInTotals); return { count: arr.length, counted: c.length, pretax: c.reduce((s, x) => s + x.pretax, 0), posttax: Math.round(c.reduce((s, x) => s + x.posttax, 0)) }; };
  const by = (f: (x: any) => string) => { const m: Record<string, any> = {}; for (const k of [...new Set(out.map(f))]) m[k] = sum(out.filter(x => f(x) === k)); return m; };
  const issueCounts: Record<string, number> = {};
  for (const o of out) for (const b of o.blockers) issueCounts[b.code] = (issueCounts[b.code] ?? 0) + 1;
  return {
    scope, payoutDate: scope === "date" ? d : null, deliveryWindow: win, today, items: out,
    summary: { total: sum(out), byState: by(x => x.state), byKind: by(x => x.kind), byCandidate: by(x => x.candidate),
      roundEligible: sum(out.filter(x => x.roundEligible)), duplicates: out.filter(x => x.blockers.some((b: Blocker) => b.code.startsWith("dup_"))).length, issueCounts },
  };
}
