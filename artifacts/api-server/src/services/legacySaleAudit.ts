// ─── 과거 CRM 전환 판매 전체 점검·공통 복원 ────────────────────────────────────────────
//
// 킨텍스(2026-06-22-0003)에서 확인된 이관 오류를 '전환된 판매 전체'에 같은 규칙으로 점검·복원한다.
//   auditConvertedSales: 판매별로 금액·품목·발행정보·입금 연결·거래처·담당자·이메일·수행/통번역사를 원본과 비교(읽기 전용)
//   applyConvertedSaleRepair: 자동 복원 가능 항목만 기존 검증된 apply 로 실행(품목·청구·이메일) — 재실행 안전, 배치별 되돌리기
//
// 자동 복원(원본 근거 확정 + 기존 금액 유지):
//   · 품목 수량·단가 — planItemRestore 'restorable'(원본 단일값, 수량×단가 = 공급가액, 전환 기본값 그대로인 품목)
//   · 세금계산서 발행정보 — planBillingRestore 'restorable' / 'fill_issue_date'
//   · 담당자 이메일 — planContactEmailFill 'fillable'(같은 거래처의 같은 사람 Master 에 이메일 1개)
// 점검만(자동 변경 없음): 금액 불일치, 입금 연결, 거래처·담당자 연결·중복 거래처, 수행/통번역사 — 금액·입금·지급·정산은 바꾸지 않는다.
import { sql } from "drizzle-orm";
import { planItemRestore, applyItemRestore, type ItemRestoreRow } from "./legacyQuoteItemRestore";
import { planBillingRestore, applyBillingRestore, planContactEmailFill, applyContactEmailFill, type BillingRow, type EmailRow } from "./legacySaleRepair";
import { personKey } from "./legacyContactRestore";

type Dbx = { execute: (q: any) => Promise<{ rows: unknown[]; rowCount?: number | null }> };
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];
const num = (v: unknown): number | null => { const s = String(v ?? "").replace(/,/g, "").trim(); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
const text = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };
const eq2 = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= 0.5;

export type Verdict = "ok" | "auto" | "manual" | "impossible";
export interface SaleAudit {
  saleNo: string; projectId: number; quoteNumber: string | null; companyName: string | null;
  amounts: { verdict: Verdict; status: "match" | "staff_edited" | "tax_split_unknown" | "no_quote"; source: { total: number | null; supply: number | null; vat: number | null }; quote: { supply: number; vat: number; total: number } | null; reason: string | null };
  item: { verdict: Verdict; status: string; reason: string | null; after: ItemRestoreRow["after"] };
  billing: { verdict: Verdict; status: BillingRow["status"]; reason: string | null; after: BillingRow["after"] };
  collection: { verdict: Verdict; status: "ok" | "source_paid_platform_open" | "platform_paid_source_none" | "none"; reason: string | null };
  party: { verdict: Verdict; status: "ok" | "no_company" | "no_contact" | "contact_name_differs" | "duplicate_company"; reason: string | null };
  email: { verdict: Verdict; status: "present" | EmailRow["status"] | "no_contact"; reason: string | null; contactId: number | null; email: string | null };
  performance: { verdict: Verdict; status: "ok" | "count_mismatch" | "translator_unlinked"; sourceRows: number; assignments: number; unlinked: number; reason: string | null };
}

const verdictOfItem = (s: string): Verdict => s === "restorable" ? "auto" : (s === "already_restored" ? "ok"
  : s === "amount_mismatch" || s === "edited_after_activation" || s === "multi_item" || s === "multiple_values" ? "manual" : "impossible");
const verdictOfBilling = (s: BillingRow["status"]): Verdict => s === "restorable" || s === "fill_issue_date" ? "auto" : s === "already_billed" ? "ok"
  : s === "no_source_date" ? "impossible" : "manual";

export async function auditConvertedSales(dbx: Dbx, opts: { saleNos?: string[] } = {}): Promise<SaleAudit[]> {
  const items = new Map((await planItemRestore(dbx, opts)).map(r => [r.saleNo, r]));
  const bills = new Map((await planBillingRestore(dbx, opts)).map(r => [r.saleNo, r]));
  const only = opts.saleNos?.length ? sql`AND m.legacy_id IN (${sql.join(opts.saleNos.map(s => sql`${s}`), sql`, `)})` : sql``;
  const sales = await rows(dbx, sql`SELECT m.legacy_id sale_no, p.id pid, p.company_id, p.contact_id, co.name co_name, ct.name ct_name, nullif(btrim(ct.email), '') ct_email,
      (SELECT s.id FROM legacy_archive_rows s WHERE s.source_type='sales_list' AND s.is_effective AND s.source_raw->>'판매번호' = m.legacy_id ORDER BY s.id DESC LIMIT 1) sid
    FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id LEFT JOIN companies co ON co.id = p.company_id LEFT JOIN contacts ct ON ct.id = p.contact_id
    WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active' ${only} ORDER BY m.legacy_id`);
  const contactIds = [...new Set(sales.filter(s => s.contact_id != null && !s.ct_email).map(s => Number(s.contact_id)))];
  const emails = new Map((contactIds.length ? await planContactEmailFill(dbx, { contactIds }) : []).map(r => [r.contactId, r]));
  const aliasPairs = new Set((await rows(dbx, sql`SELECT DISTINCT a.company_id x FROM company_aliases a JOIN company_aliases b ON b.normalized_alias = a.normalized_alias AND b.company_id <> a.company_id
    JOIN companies c ON c.id = b.company_id AND c.deleted_at IS NULL`)).map(r => Number(r.x)));

  const out: SaleAudit[] = [];
  for (const s of sales) {
    const it = items.get(String(s.sale_no)), bl = bills.get(String(s.sale_no));
    const [sale] = s.sid ? await rows(dbx, sql`SELECT total_amount, company_name, source_raw FROM legacy_archive_rows WHERE id = ${s.sid}`) : [];
    const raw = (sale?.source_raw ?? {}) as Record<string, unknown>;
    const prog = s.sid ? await rows(dbx, sql`SELECT p.id, p.source_raw FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
      WHERE l.sale_row_id = ${s.sid} AND l.decision = 'confirmed'`) : [];

    // 금액 — 원본 총액·(공급가, 부가세) ↔ 현재 견적 품목 합계
    const src = { total: num(sale?.total_amount) ?? num(raw["총액"]), supply: bl?.source.supply ?? null, vat: bl?.source.vat ?? null };
    const quote = bl?.quote ?? null;
    let amounts: SaleAudit["amounts"];
    if (!quote) amounts = { verdict: "manual", status: "no_quote", source: src, quote, reason: "현재 견적 품목 없음" };
    else if (!eq2(quote.total, src.total)) amounts = { verdict: "manual", status: "staff_edited", source: src, quote, reason: `견적 총액 ${quote.total.toLocaleString()} ≠ 원본 총액 ${src.total?.toLocaleString() ?? "-"} — 전환 후 직원 수정(자동 변경 안 함)` };
    else if (src.supply != null && src.vat != null && eq2(src.supply + src.vat, src.total) && !(eq2(quote.supply, src.supply) && eq2(quote.vat, src.vat)))
      amounts = { verdict: "manual", status: "tax_split_unknown", source: src, quote, reason: `총액은 같으나 공급가·부가세 구분 다름(원본 ${src.supply.toLocaleString()}/${src.vat.toLocaleString()} ↔ 견적 ${quote.supply.toLocaleString()}/${quote.vat.toLocaleString()}) — 세금 구분 변경은 자동 적용 안 함` };
    else amounts = { verdict: "ok", status: "match", source: src, quote, reason: null };

    // 입금 연결 — 원본 입금기록 ↔ 플랫폼 입금완료(청구행 완료 또는 수금거래)
    const deposit = text(raw["입금일"]) ?? text(raw["입금내역"]);
    const [pay] = await rows(dbx, sql`SELECT count(*) FILTER (WHERE deposit_status = 'completed') done,
      (SELECT count(*) FROM payment_transactions t WHERE t.project_id = ${s.pid}) txn FROM project_payments WHERE project_id = ${s.pid}`);
    const paid = Number(pay.done) > 0 || Number(pay.txn) > 0;
    const collection: SaleAudit["collection"] = deposit && !paid ? { verdict: "manual", status: "source_paid_platform_open", reason: `원본 입금기록(${deposit}) 있으나 플랫폼 입금 미완료 — 입금정보는 자동으로 만들지 않음` }
      : !deposit && paid ? { verdict: "ok", status: "platform_paid_source_none", reason: "원본 입금기록 없음, 플랫폼 입금 입력됨(직원 입력)" }
      : { verdict: "ok", status: deposit ? "ok" : "none", reason: null };

    // 거래처·담당자 — 원본 고객명(진행행 '고객명' 단일)과 연결 담당자 이름 비교
    const custNames = [...new Set(prog.map((p: any) => text(p.source_raw?.["고객명"])).filter(Boolean))] as string[];
    let party: SaleAudit["party"];
    if (!s.company_id) party = { verdict: "manual", status: "no_company", reason: `거래처 미연결(원본 '${sale?.company_name ?? raw["거래처명"] ?? "-"}') — 판매관리 미연결 관리에서 지정` };
    else if (aliasPairs.has(Number(s.company_id))) party = { verdict: "manual", status: "duplicate_company", reason: `연결 거래처 #${s.company_id}와 같은 이름(별칭)의 다른 거래처 Master 있음 — 기준 Master 확인 필요` };
    else if (!s.contact_id) party = { verdict: custNames.length ? "manual" : "impossible", status: "no_contact", reason: custNames.length ? `담당자 미연결(원본 고객명 ${custNames.join(", ")})` : "원본 고객명 없음" };
    else if (custNames.length === 1 && personKey(custNames[0]) !== personKey(s.ct_name)) party = { verdict: "manual", status: "contact_name_differs", reason: `연결 담당자 '${s.ct_name}' ≠ 원본 고객명 '${custNames[0]}'` };
    else party = { verdict: "ok", status: "ok", reason: null };

    // 담당자 이메일
    const er = s.contact_id ? emails.get(Number(s.contact_id)) : undefined;
    const email: SaleAudit["email"] = !s.contact_id ? { verdict: "impossible", status: "no_contact", reason: "담당자 미연결", contactId: null, email: null }
      : s.ct_email ? { verdict: "ok", status: "present", reason: null, contactId: Number(s.contact_id), email: s.ct_email }
      : er ? { verdict: er.status === "fillable" ? "auto" : er.status === "no_email_anywhere" ? "impossible" : "manual", status: er.status, reason: er.reason, contactId: er.contactId, email: er.email }
      : { verdict: "impossible", status: "no_email_anywhere", reason: "담당자 Master·원본 모두 이메일 없음", contactId: Number(s.contact_id), email: null };

    // 수행·통번역사 — 원본 진행행 수 ↔ 수행정보(삭제 제외), 통번역사·업체 미연결
    const [pa] = await rows(dbx, sql`SELECT count(*) n, count(*) FILTER (WHERE individual_user_id IS NULL AND vendor_company_id IS NULL) unlinked FROM performance_assignments WHERE project_id = ${s.pid} AND deleted_at IS NULL`);
    const n = Number(pa.n), un = Number(pa.unlinked);
    const performance: SaleAudit["performance"] = n !== prog.length
      ? { verdict: "manual", status: "count_mismatch", sourceRows: prog.length, assignments: n, unlinked: un, reason: `원본 진행행 ${prog.length}건 ↔ 수행정보 ${n}건 — 자동 추가·삭제 안 함` }
      : un ? { verdict: "manual", status: "translator_unlinked", sourceRows: prog.length, assignments: n, unlinked: un, reason: `통번역사 Master 미연결 ${un}건(원본 이름만 보존)` }
      : { verdict: "ok", status: "ok", sourceRows: prog.length, assignments: n, unlinked: 0, reason: null };

    out.push({ saleNo: String(s.sale_no), projectId: Number(s.pid), quoteNumber: it?.quoteNumber ?? bl?.quoteNumber ?? null, companyName: s.co_name ?? sale?.company_name ?? null,
      amounts, item: { verdict: it ? verdictOfItem(it.status) : "impossible", status: it?.status ?? "no_quote", reason: it?.reason ?? null, after: it?.after ?? null },
      billing: { verdict: bl ? verdictOfBilling(bl.status) : "impossible", status: bl?.status ?? "no_source_date", reason: bl?.reason ?? null, after: bl?.after ?? null },
      collection, party, email, performance });
  }
  return out;
}

export function summarizeAudit(list: SaleAudit[]) {
  const keys = ["amounts", "item", "billing", "collection", "party", "email", "performance"] as const;
  const per: Record<string, { ok: number; auto: number; manual: number; impossible: number; byStatus: Record<string, number> }> = {};
  for (const k of keys) {
    const b = { ok: 0, auto: 0, manual: 0, impossible: 0, byStatus: {} as Record<string, number> };
    for (const a of list) { const x = a[k] as { verdict: Verdict; status: string }; b[x.verdict]++; b.byStatus[x.status] = (b.byStatus[x.status] ?? 0) + 1; }
    per[k] = b;
  }
  const anyOf = (v: Verdict) => list.filter(a => keys.some(k => (a[k] as any).verdict === v)).length;
  return { sales: list.length, perItem: per, salesWithAuto: anyOf("auto"), salesWithManual: anyOf("manual"), salesWithImpossible: anyOf("impossible"),
    salesAllOk: list.filter(a => keys.every(k => (a[k] as any).verdict === "ok")).length };
}

/** 자동 복원 가능 항목만 실행(한 트랜잭션). 각 apply 가 실행 직전 다시 계획해 확인하므로 재실행해도 중복 변경이 없다. */
export async function applyConvertedSaleRepair(tx: Dbx, opts: { userId: number | null; saleNos?: string[]; reason?: string; executedVia?: string }) {
  const audit = await auditConvertedSales(tx, { saleNos: opts.saleNos });
  const itemSales = audit.filter(a => a.item.verdict === "auto").map(a => a.saleNo);
  const billSales = audit.filter(a => a.billing.verdict === "auto").map(a => a.saleNo);
  const emailContacts = [...new Set(audit.filter(a => a.email.verdict === "auto" && a.email.contactId).map(a => a.email.contactId!))];
  const base = { userId: opts.userId, reason: opts.reason, executedVia: opts.executedVia };
  const item = itemSales.length ? await applyItemRestore(tx, { ...base, saleNos: itemSales }) : null;
  const billing = billSales.length ? await applyBillingRestore(tx, { ...base, saleNos: billSales }) : null;
  const email = emailContacts.length ? await applyContactEmailFill(tx, { ...base, contactIds: emailContacts }) : null;
  return { targets: { item: itemSales, billing: billSales, emailContacts }, item, billing, email };
}
