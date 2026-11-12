// ─── 과거 CRM 전환 판매 보정(청구·담당자) — 원본 근거가 확인되는 값만, 기록·되돌리기 가능 ─────────────────────
//
// 진단(2026-11-12 킨텍스 2026-06-22-0003)으로 확인된 이관 누락을 보정한다. 판매금액·수행·지급·입금·정산은 바꾸지 않는다.
//
// [A] 세금계산서 발행정보(청구정보) — planBillingRestore / applyBillingRestore / rollbackBillingRestore
//   원인: 전환(legacySaleActivation)은 과거 CRM 입금기록이 대조된 판매에만 청구 레코드(project_payments)를 만들었다.
//         발행일만 있고 미입금인 판매는 financial_status='billed' 만 남고 화면의 청구정보는 비어 있었다.
//   복원 조건(모두 충족해야 'restorable'):
//     · 판매목록 '세금계산서발행(예정)일'이 있고, 연결 진행행 '계산서발행일'이 있으면 모두 같은 날짜
//     · 진행행 (공급가액, 부가세) 조합이 1개이고 합계 = 판매 총액, 그리고 = 현재 견적 품목 합계(공급가·세액·총액) — 금액 새로 계산 없음
//     · 프로젝트에 청구 레코드가 없음(중복 회차 금지), 원본 입금일·입금내역 없음(입금정보는 만들지 않음)
//   예외: 청구 1건이 발행일만 비어 있고 금액 = 판매 총액이면 그 행의 발행일만 채운다('fill_issue_date').
//   새 청구행은 직원 입력 형식과 같다: 세금계산서 · 일괄 · 일반결제 · 고객사 · 전체금액 · 입금예정(미확인). 세금계산서를 새로 발행·전송하지 않는다.
//
// [C] 담당자 이메일 — planContactEmailFill / applyContactEmailFill / rollbackContactEmailFill
//   같은 거래처 안에서 같은 사람(이름 비교키 동일)의 다른 담당자 Master 에 이메일이 있으면, 비어 있는 이메일만 채운다.
//   이메일이 여러 개이거나, 전화번호가 서로 다르거나, 다른 거래처에만 있으면 보류(자동 연결·덮어쓰기 금지).
//   전환 견적의 수신자 이메일이 비어 있고 수신자 = 그 담당자면 견적 수신자 이메일도 같은 값으로 채운다.
//
// [R] 판매 거래처·담당자 재연결 — relinkSaleParty / rollbackSaleParty (승인된 개별 건 전용, 일괄 자동 실행 없음)
//   중복 거래처(과거 CRM 자동등록 ↔ 홈택스 등록) 때문에 다른 Master 에 연결된 판매를 확정된 기준 Master 로 옮긴다.
//   거래처·담당자는 병합·삭제하지 않는다. 이전 Master 는 그대로 남는다.
import { sql } from "drizzle-orm";
import { personKey, normPhone } from "./legacyContactRestore";

type Dbx = { execute: (q: any) => Promise<{ rows: unknown[]; rowCount?: number | null }> };
const rows = async (dbx: Dbx, q: any) => (await dbx.execute(q)).rows as any[];
const num = (v: unknown): number | null => { const s = String(v ?? "").replace(/,/g, "").trim(); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
const dateOf = (v: unknown): string | null => { const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const text = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };
const eq2 = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) <= 0.005;

export const REPAIR_MODULE = "legacy_sale_repair";

// ═══ [A] 청구정보(세금계산서 발행정보) ═══════════════════════════════════════════
export type BillingStatus = "restorable" | "fill_issue_date" | "already_billed" | "no_source_date" | "date_conflict"
  | "amount_unclear" | "source_deposit" | "existing_payments";
export const BILLING_STATUS_LABEL: Record<BillingStatus, string> = {
  restorable: "자동 복원 가능(청구행 생성)", fill_issue_date: "자동 복원 가능(기존 청구행 발행일만 채움)", already_billed: "이미 발행정보 있음",
  no_source_date: "원본에 발행일 없음", date_conflict: "원본 발행일 충돌", amount_unclear: "금액 근거 불명확(보류)",
  source_deposit: "원본 입금기록 있음(수동 확인)", existing_payments: "직원 입력 청구 있음 — 발행일·금액 불일치(수동 확인)",
};
export interface BillingRow {
  saleNo: string; projectId: number; quoteId: number | null; quoteNumber: string | null; financialStatus: string | null;
  status: BillingStatus; reason: string | null;
  source: { issueDate: string | null; progressIssueDates: string[]; total: number | null; supply: number | null; vat: number | null; pairs: number; deposit: string | null };
  quote: { supply: number; vat: number; total: number } | null;
  payments: Array<{ id: number; issueDate: string | null; amount: number; depositStatus: string }>;
  after: { paymentId: number | null; issueDate: string; supply: number; vat: number; amount: number } | null;
}

export async function planBillingRestore(dbx: Dbx, opts: { saleNos?: string[] } = {}): Promise<BillingRow[]> {
  const only = opts.saleNos?.length ? sql`AND m.legacy_id IN (${sql.join(opts.saleNos.map(s => sql`${s}`), sql`, `)})` : sql``;
  const sales = await rows(dbx, sql`SELECT m.legacy_id sale_no, p.id project_id, p.financial_status, q.id quote_id, q.quote_number,
      (SELECT s.id FROM legacy_archive_rows s WHERE s.source_type='sales_list' AND s.is_effective AND s.source_raw->>'판매번호' = m.legacy_id ORDER BY s.id DESC LIMIT 1) sale_row_id
    FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id
    LEFT JOIN LATERAL (SELECT * FROM quotes qq WHERE qq.project_id = p.id AND qq.deleted_at IS NULL ORDER BY qq.is_current DESC, qq.id DESC LIMIT 1) q ON true
    WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active' ${only} ORDER BY m.legacy_id`);
  const out: BillingRow[] = [];
  for (const s of sales) {
    const [sale] = s.sale_row_id ? await rows(dbx, sql`SELECT total_amount, source_raw FROM legacy_archive_rows WHERE id = ${s.sale_row_id}`) : [];
    const raw = (sale?.source_raw ?? {}) as Record<string, unknown>;
    const prog = s.sale_row_id ? (await rows(dbx, sql`SELECT p.source_raw FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
      WHERE l.sale_row_id = ${s.sale_row_id} AND l.decision = 'confirmed'`)).map(r => r.source_raw ?? {}) : [];
    const total = num(sale?.total_amount) ?? num(raw["총액"]);
    const progDates = [...new Set(prog.map(r => dateOf(r["계산서발행일"])).filter((x): x is string => !!x))];
    const pairs = [...new Set(prog.map(r => `${num(r["공급가액"])}|${num(r["부가세"])}`))];
    const [ps, pv] = pairs.length === 1 ? pairs[0].split("|").map(x => (x === "null" ? null : Number(x))) : [null, null];
    const deposit = text(raw["입금일"]) ?? text(raw["입금내역"]);
    const source = { issueDate: dateOf(raw["세금계산서발행(예정)일"]), progressIssueDates: progDates, total, supply: ps, vat: pv, pairs: pairs.length, deposit };
    const [qa] = s.quote_id ? await rows(dbx, sql`SELECT count(*) n, coalesce(sum(supply_amount),0) s, coalesce(sum(tax_amount),0) v, coalesce(sum(total_amount),0) t FROM quote_items WHERE quote_id = ${s.quote_id}`) : [];
    const quote = qa && Number(qa.n) > 0 ? { supply: Number(qa.s), vat: Number(qa.v), total: Number(qa.t) } : null;
    const payments = (await rows(dbx, sql`SELECT id, issue_date, amount, deposit_status FROM project_payments WHERE project_id = ${s.project_id} ORDER BY sequence, id`))
      .map(p => ({ id: Number(p.id), issueDate: p.issue_date ? String(p.issue_date).slice(0, 10) : null, amount: Number(p.amount), depositStatus: String(p.deposit_status) }));
    const row: BillingRow = { saleNo: String(s.sale_no), projectId: Number(s.project_id), quoteId: s.quote_id ? Number(s.quote_id) : null, quoteNumber: s.quote_number ?? null,
      financialStatus: s.financial_status ?? null, status: "restorable", reason: null, source, quote, payments, after: null };
    const d = source.issueDate;
    const amountOk = quote != null && total != null && ps != null && pv != null && eq2(ps + pv, total) && eq2(quote.total, total) && eq2(quote.supply, ps) && eq2(quote.vat, pv);
    if (!d) { row.status = "no_source_date"; row.reason = progDates.length ? "판매목록 발행일 없음(진행관리표에만 있음)" : "과거 CRM 원본에 세금계산서 발행일 없음"; }
    else if (progDates.some(x => x !== d)) { row.status = "date_conflict"; row.reason = `판매목록 ${d} ↔ 진행관리표 ${progDates.join(", ")}`; }
    else if (payments.some(p => p.issueDate === d)) { row.status = "already_billed"; row.reason = "같은 발행일의 청구 레코드가 이미 있음"; }
    else if (payments.length) {
      const p = payments[0];
      if (payments.length === 1 && !p.issueDate && total != null && eq2(p.amount, total)) {
        row.status = "fill_issue_date"; row.after = { paymentId: p.id, issueDate: d, supply: 0, vat: 0, amount: p.amount };
      } else { row.status = "existing_payments"; row.reason = `직원 입력 청구 ${payments.length}건(${payments.map(x => `${x.issueDate ?? "발행일 없음"}/${x.amount.toLocaleString()}원`).join(", ")}) — 판매 총액 ${total?.toLocaleString() ?? "-"}원과 대조 필요`; }
    }
    else if (deposit) { row.status = "source_deposit"; row.reason = `원본 입금기록 있음(${deposit}) — 입금정보는 자동으로 만들지 않음`; }
    else if (!amountOk) {
      row.status = "amount_unclear";
      row.reason = pairs.length !== 1 ? `진행관리표 공급가액·부가세 조합 ${pairs.length}개 — 발행금액 확정 불가`
        : !quote ? "현재 견적 품목 없음"
        : `원본 공급가 ${ps?.toLocaleString() ?? "-"}·부가세 ${pv?.toLocaleString() ?? "-"}·총액 ${total?.toLocaleString() ?? "-"} ↔ 견적 ${quote.supply.toLocaleString()}·${quote.vat.toLocaleString()}·${quote.total.toLocaleString()} 불일치`;
    }
    else row.after = { paymentId: null, issueDate: d, supply: ps!, vat: pv!, amount: total! };
    out.push(row);
  }
  return out;
}

export async function applyBillingRestore(tx: Dbx, opts: { userId: number | null; saleNos: string[]; reason?: string; executedVia?: string }) {
  if (!opts.saleNos.length) throw new Error("복원할 판매번호를 지정하세요.");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${REPAIR_MODULE + ":billing"}))`);
  const plan = (await planBillingRestore(tx, { saleNos: opts.saleNos })).filter(r => (r.status === "restorable" || r.status === "fill_issue_date") && r.after);
  const batchId = await newBatch(tx, "billing_restore", opts, plan.length);
  let n = 0;
  for (const r of plan) {
    const a = r.after!;
    let paymentId = a.paymentId;
    if (r.status === "fill_issue_date") {
      const res = await tx.execute(sql`UPDATE project_payments SET issue_date = ${a.issueDate}, updated_by = ${opts.userId}, updated_at = now()
        WHERE id = ${a.paymentId} AND project_id = ${r.projectId} AND issue_date IS NULL`);
      if (!res.rowCount) throw new Error(`발행일 채움 실패(판매 ${r.saleNo}) — 전체 취소`);
    } else {
      const [p] = await rows(tx, sql`SELECT company_id, contact_id, (SELECT name FROM companies WHERE id = company_id) co, (SELECT name FROM contacts WHERE id = contact_id) ct,
          (SELECT coalesce(max(sequence), 0) + 1 FROM project_payments WHERE project_id = ${r.projectId}) seq FROM projects WHERE id = ${r.projectId}`);
      const [ins] = await rows(tx, sql`INSERT INTO project_payments (project_id, sequence, issue_date, payment_type, payment_method, supply_amount, vat_amount, amount,
          deposit_status, deposit_confirmed, payment_category, payer, deposit_item, billing_company_id, billing_contact_id, billing_company_name_snapshot, billing_contact_name_snapshot,
          note, created_by, updated_by)
        VALUES (${r.projectId}, ${Number(p.seq)}, ${a.issueDate}, 'lump_sum', '세금계산서', ${String(a.supply)}, ${String(a.vat)}, ${String(a.amount)},
          'scheduled', false, '일반결제', '고객사', '전체금액', ${p.company_id ?? null}, ${p.contact_id ?? null}, ${p.co ?? null}, ${p.ct ?? null},
          ${`과거 CRM 세금계산서 발행정보 복원(판매번호 ${r.saleNo})`}, ${opts.userId}, ${opts.userId}) RETURNING id`);
      paymentId = Number(ins.id);
    }
    await lineage(tx, batchId, paymentId!, `billing:${r.saleNo}`, r.status === "fill_issue_date" ? "issue_date_filled" : "billing_created", r.saleNo,
      { projectId: r.projectId, quoteNumber: r.quoteNumber, source: r.source, quote: r.quote, paymentsBefore: r.payments, after: { ...a, paymentId }, reason: opts.reason ?? null, executedVia: opts.executedVia ?? null });
    await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, metadata) VALUES ('project', ${r.projectId}, 'legacy_billing_restored', ${opts.userId},
      ${JSON.stringify({ saleNo: r.saleNo, batchId, paymentId, status: r.status, issueDate: a.issueDate, amount: a.amount, reason: opts.reason ?? null })})`);
    n++;
  }
  await finishBatch(tx, batchId, n);
  return { batchId, restored: n, skipped: opts.saleNos.length - n };
}

/** 되돌리기 — 만든 청구행은 그 뒤 바뀌지 않았고 수금거래가 없을 때만 삭제, 채운 발행일은 지금도 그 값일 때만 비운다 */
export async function rollbackBillingRestore(tx: Dbx, batchId: number) {
  const recs = await rows(tx, sql`SELECT entity_id, status, source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${REPAIR_MODULE} AND row_key LIKE 'billing:%'`);
  let reverted = 0; const kept: number[] = [];
  for (const r of recs) {
    const a = r.source_raw.after;
    const res = r.status === "billing_created"
      ? await tx.execute(sql`DELETE FROM project_payments WHERE id = ${r.entity_id} AND issue_date = ${a.issueDate} AND amount = ${String(a.amount)} AND deposit_status = 'scheduled'
          AND NOT deposit_confirmed AND paid_date IS NULL AND NOT EXISTS (SELECT 1 FROM payment_transactions t WHERE t.project_payment_id = ${r.entity_id})`)
      : await tx.execute(sql`UPDATE project_payments SET issue_date = NULL WHERE id = ${r.entity_id} AND issue_date = ${a.issueDate}`);
    if (res.rowCount) reverted++; else kept.push(Number(r.entity_id));
  }
  await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back' WHERE id = ${batchId} AND module = ${REPAIR_MODULE}`);
  return { batchId, reverted, kept };
}

// ═══ [C] 담당자 이메일 ═══════════════════════════════════════════════════════
export type EmailStatus = "fillable" | "duplicate_company" | "other_company_only" | "no_email_anywhere" | "email_conflict" | "phone_conflict";
export interface EmailRow {
  contactId: number; companyId: number; name: string; saleNos: string[]; projectIds: number[];
  status: EmailStatus; reason: string | null; donorIds: number[]; email: string | null;
  quoteFills: Array<{ quoteId: number; quoteNumber: string | null }>;
}

/** 과거 CRM 판매에 연결된(판매-담당자 매핑 또는 전환 판매) 담당자 중 이메일이 빈 담당자 */
export async function planContactEmailFill(dbx: Dbx, opts: { contactIds?: number[] } = {}): Promise<EmailRow[]> {
  const only = opts.contactIds?.length ? sql`AND c.id IN (${sql.join(opts.contactIds.map(i => sql`${i}`), sql`, `)})` : sql``;
  const targets = await rows(dbx, sql`SELECT c.id, c.company_id, c.name, c.phone, c.mobile, c.office_phone,
      array_remove(array_agg(DISTINCT m.legacy_id), NULL) sale_nos, array_remove(array_agg(DISTINCT p.id), NULL) project_ids
    FROM contacts c
    LEFT JOIN legacy_master_mappings m ON m.entity_id = c.id AND m.source_system='old_crm' AND m.entity_type='sale_contact' AND m.status='active'
    LEFT JOIN projects p ON p.contact_id = c.id AND EXISTS (SELECT 1 FROM legacy_master_mappings ms WHERE ms.entity_id = p.id AND ms.source_system='old_crm' AND ms.entity_type='sale' AND ms.status='active')
    WHERE c.deleted_at IS NULL AND coalesce(btrim(c.email), '') = '' AND c.company_id IS NOT NULL ${only}
    GROUP BY c.id HAVING count(m.id) > 0 OR count(p.id) > 0 ORDER BY c.id`);
  if (!targets.length) return [];
  const all = await rows(dbx, sql`SELECT id, company_id, name, lower(btrim(email)) email, phone, mobile, office_phone FROM contacts WHERE deleted_at IS NULL AND coalesce(btrim(email), '') <> ''`);
  const byKey = new Map<string, any[]>();
  for (const c of all) { const k = personKey(c.name); if (k.length >= 2) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(c); }
  const tels = (c: any) => [c.phone, c.mobile, c.office_phone].map(normPhone).filter(t => t.length >= 7);
  // 같은 정규화 거래처명(별칭)을 공유하는 다른 거래처 = 중복 거래처 의심(예: 킨텍스 3183 ↔ (주)킨텍스 3739) — 자동 보완하지 않고 별도 분류
  const aliasPairs = new Set((await rows(dbx, sql`SELECT DISTINCT a.company_id x, b.company_id y FROM company_aliases a JOIN company_aliases b ON b.normalized_alias = a.normalized_alias AND b.company_id <> a.company_id`))
    .map(r => `${r.x}|${r.y}`));
  const out: EmailRow[] = [];
  for (const t of targets) {
    const same = (byKey.get(personKey(t.name)) ?? []).filter(c => Number(c.company_id) === Number(t.company_id) && Number(c.id) !== Number(t.id));
    const other = (byKey.get(personKey(t.name)) ?? []).filter(c => Number(c.company_id) !== Number(t.company_id));
    const row: EmailRow = { contactId: Number(t.id), companyId: Number(t.company_id), name: String(t.name), saleNos: (t.sale_nos ?? []).map(String), projectIds: (t.project_ids ?? []).map(Number),
      status: "fillable", reason: null, donorIds: same.map(c => Number(c.id)), email: null, quoteFills: [] };
    const emails = [...new Set(same.map(c => String(c.email)))];
    if (!same.length) {
      const dup = other.filter(c => aliasPairs.has(`${t.company_id}|${c.company_id}`));
      row.status = dup.length ? "duplicate_company" : other.length ? "other_company_only" : "no_email_anywhere";
      row.donorIds = (dup.length ? dup : other).map(c => Number(c.id));
      row.reason = dup.length ? `같은 거래처명(별칭)의 다른 거래처 Master 담당자에 이메일 있음(${dup.map(c => `#${c.id}@거래처${c.company_id}`).join(", ")}) — 중복 거래처 정리 후 연결(자동 보완 안 함)`
        : other.length ? `다른 거래처 소속 동명 담당자에만 이메일 있음(${other.length}명) — 동명이인 가능, 자동 보완 안 함` : "담당자 Master·원본 모두 이메일 없음";
    } else if (emails.length > 1) { row.status = "email_conflict"; row.reason = `같은 거래처 동명 담당자 이메일이 여러 개(${emails.join(", ")})`; }
    else {
      const mine = tels(t), theirs = same.flatMap(tels);
      if (mine.length && theirs.length && !mine.some(x => theirs.includes(x))) { row.status = "phone_conflict"; row.reason = "같은 이름이지만 연락처가 서로 다름 — 동명이인 가능"; }
      else row.email = emails[0];
    }
    if (row.status === "fillable" && row.projectIds.length) {
      row.quoteFills = (await rows(dbx, sql`SELECT q.id, q.quote_number, q.customer_contact_name FROM quotes q WHERE q.project_id IN (${sql.join(row.projectIds.map(i => sql`${i}`), sql`, `)})
        AND q.deleted_at IS NULL AND q.is_current AND coalesce(btrim(q.customer_contact_email), '') = ''`))
        .filter(q => personKey(q.customer_contact_name) === personKey(t.name)).map(q => ({ quoteId: Number(q.id), quoteNumber: q.quote_number ?? null }));
    }
    out.push(row);
  }
  return out;
}

export async function applyContactEmailFill(tx: Dbx, opts: { userId: number | null; contactIds: number[]; reason?: string; executedVia?: string }) {
  if (!opts.contactIds.length) throw new Error("보완할 담당자를 지정하세요.");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${REPAIR_MODULE + ":email"}))`);
  const plan = (await planContactEmailFill(tx, { contactIds: opts.contactIds })).filter(r => r.status === "fillable" && r.email);
  const batchId = await newBatch(tx, "contact_email_fill", opts, plan.length);
  let n = 0;
  for (const r of plan) {
    const res = await tx.execute(sql`UPDATE contacts SET email = ${r.email}, updated_at = now() WHERE id = ${r.contactId} AND coalesce(btrim(email), '') = ''`);
    if (!res.rowCount) throw new Error(`이메일 보완 실패(담당자 #${r.contactId}) — 전체 취소`);
    const quotes: number[] = [];
    for (const q of r.quoteFills) {
      const u = await tx.execute(sql`UPDATE quotes SET customer_contact_email = ${r.email} WHERE id = ${q.quoteId} AND coalesce(btrim(customer_contact_email), '') = ''`);
      if (u.rowCount) quotes.push(q.quoteId);
    }
    await lineage(tx, batchId, r.contactId, `contact_email:${r.contactId}`, "email_filled", r.saleNos[0] ?? null,
      { contactId: r.contactId, companyId: r.companyId, name: r.name, email: r.email, donorIds: r.donorIds, saleNos: r.saleNos, quoteIds: quotes, reason: opts.reason ?? null, executedVia: opts.executedVia ?? null });
    await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, metadata) VALUES ('company', ${r.companyId}, 'legacy_contact_email_filled', ${opts.userId},
      ${JSON.stringify({ contactId: r.contactId, email: r.email, donorIds: r.donorIds, quoteIds: quotes, batchId })})`);
    n++;
  }
  await finishBatch(tx, batchId, n);
  return { batchId, filled: n, skipped: opts.contactIds.length - n };
}

export async function rollbackContactEmailFill(tx: Dbx, batchId: number) {
  const recs = await rows(tx, sql`SELECT entity_id, source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${REPAIR_MODULE} AND row_key LIKE 'contact_email:%'`);
  let reverted = 0; const kept: number[] = [];
  for (const r of recs) {
    const e = r.source_raw.email;
    const res = await tx.execute(sql`UPDATE contacts SET email = NULL WHERE id = ${r.entity_id} AND email = ${e}`);
    for (const q of r.source_raw.quoteIds ?? []) await tx.execute(sql`UPDATE quotes SET customer_contact_email = NULL WHERE id = ${q} AND customer_contact_email = ${e}`);
    if (res.rowCount) reverted++; else kept.push(Number(r.entity_id));
  }
  await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back' WHERE id = ${batchId} AND module = ${REPAIR_MODULE}`);
  return { batchId, reverted, kept };
}

// ═══ [R] 판매 거래처·담당자 재연결(승인된 개별 건) ═══════════════════════════════
export interface RelinkInput {
  saleNo: string; companyId: number; contactId: number;
  /** 대상 담당자 보정 — name 은 현재 값이 expectName 일 때만, position·phone 은 비어 있을 때만 채운다 */
  contactPatch?: { expectName?: string; name?: string; position?: string; phone?: string };
  fillQuoteEmail?: boolean;
}
export async function relinkSaleParty(tx: Dbx, input: RelinkInput, opts: { userId: number | null; reason?: string; executedVia?: string }) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${REPAIR_MODULE + ":relink"}))`);
  const [p] = await rows(tx, sql`SELECT p.id, p.company_id, p.contact_id FROM legacy_master_mappings m JOIN projects p ON p.id = m.entity_id
    WHERE m.source_system='old_crm' AND m.entity_type='sale' AND m.status='active' AND m.legacy_id = ${input.saleNo} FOR UPDATE OF p`);
  if (!p) throw new Error(`전환된 판매 없음: ${input.saleNo}`);
  const [ct] = await rows(tx, sql`SELECT id, company_id, name, position, phone, email FROM contacts WHERE id = ${input.contactId} AND deleted_at IS NULL FOR UPDATE`);
  if (!ct || Number(ct.company_id) !== input.companyId) throw new Error("대상 담당자가 대상 거래처 소속이 아님 — 중단");
  const [co] = await rows(tx, sql`SELECT id FROM companies WHERE id = ${input.companyId} AND deleted_at IS NULL`);
  if (!co) throw new Error("대상 거래처 없음 — 중단");
  const [map] = await rows(tx, sql`SELECT id, entity_id FROM legacy_master_mappings WHERE source_system='old_crm' AND entity_type='sale_contact' AND status='active' AND legacy_id = ${input.saleNo}`);
  const [q] = await rows(tx, sql`SELECT id, quote_number, customer_contact_email FROM quotes WHERE project_id = ${p.id} AND deleted_at IS NULL AND is_current ORDER BY id DESC LIMIT 1`);
  const before = { project: { companyId: p.company_id, contactId: p.contact_id }, mapping: map ? { id: Number(map.id), entityId: Number(map.entity_id) } : null,
    contact: { name: ct.name, position: ct.position, phone: ct.phone }, quote: q ? { id: Number(q.id), customerContactEmail: q.customer_contact_email ?? null } : null };

  await tx.execute(sql`UPDATE projects SET company_id = ${input.companyId}, contact_id = ${input.contactId} WHERE id = ${p.id}`);
  let mappingId = map ? Number(map.id) : null;
  if (map) await tx.execute(sql`UPDATE legacy_master_mappings SET entity_id = ${input.contactId} WHERE id = ${map.id}`);
  else mappingId = Number((await rows(tx, sql`INSERT INTO legacy_master_mappings (source_system, entity_type, legacy_id, entity_id, match_method, status, created_by)
    VALUES ('old_crm', 'sale_contact', ${input.saleNo}, ${input.contactId}, 'repair_relink', 'active', ${opts.userId}) RETURNING id`))[0].id);
  const cp = input.contactPatch ?? {};
  const after = { name: ct.name, position: ct.position, phone: ct.phone };
  if (cp.name && cp.expectName && ct.name === cp.expectName) after.name = cp.name;
  if (cp.position && !text(ct.position)) after.position = cp.position;
  if (cp.phone && !text(ct.phone)) after.phone = cp.phone;
  await tx.execute(sql`UPDATE contacts SET name = ${after.name}, position = ${after.position}, phone = ${after.phone}, updated_at = now() WHERE id = ${input.contactId}`);
  let quoteEmail: string | null = before.quote?.customerContactEmail ?? null;
  if (input.fillQuoteEmail && q && !text(q.customer_contact_email) && text(ct.email)) {
    quoteEmail = String(ct.email).trim();
    await tx.execute(sql`UPDATE quotes SET customer_contact_email = ${quoteEmail} WHERE id = ${q.id}`);
  }
  const afterRec = { project: { companyId: input.companyId, contactId: input.contactId }, mapping: { id: mappingId, entityId: input.contactId, created: !map }, contact: after,
    quote: q ? { id: Number(q.id), customerContactEmail: quoteEmail } : null };
  const batchId = await newBatch(tx, "sale_party_relink", { userId: opts.userId, reason: opts.reason, saleNos: [input.saleNo] }, 1);
  await lineage(tx, batchId, Number(p.id), `relink:${input.saleNo}`, "party_relinked", input.saleNo,
    { projectId: Number(p.id), contactId: input.contactId, before, after: afterRec, reason: opts.reason ?? null, executedVia: opts.executedVia ?? null });
  await tx.execute(sql`INSERT INTO logs (entity_type, entity_id, action, performed_by, metadata) VALUES ('project', ${p.id}, 'legacy_sale_party_relinked', ${opts.userId},
    ${JSON.stringify({ saleNo: input.saleNo, batchId, before, after: afterRec, reason: opts.reason ?? null })})`);
  await finishBatch(tx, batchId, 1);
  return { batchId, projectId: Number(p.id), before, after: afterRec };
}

/** 되돌리기 — 지금도 재연결 값 그대로인 항목만 이전 값으로 */
export async function rollbackSaleParty(tx: Dbx, batchId: number) {
  const [r] = await rows(tx, sql`SELECT source_raw FROM import_row_sources WHERE batch_id = ${batchId} AND module = ${REPAIR_MODULE} AND row_key LIKE 'relink:%'`);
  if (!r) throw new Error("재연결 기록 없음");
  const { projectId, contactId, before: b, after: a } = r.source_raw;
  const done: string[] = [];
  if ((await tx.execute(sql`UPDATE projects SET company_id = ${b.project.companyId}, contact_id = ${b.project.contactId} WHERE id = ${projectId} AND company_id = ${a.project.companyId} AND contact_id = ${a.project.contactId}`)).rowCount) done.push("project");
  if (a.mapping.created) { if ((await tx.execute(sql`DELETE FROM legacy_master_mappings WHERE id = ${a.mapping.id} AND entity_id = ${a.mapping.entityId}`)).rowCount) done.push("mapping"); }
  else if ((await tx.execute(sql`UPDATE legacy_master_mappings SET entity_id = ${b.mapping.entityId} WHERE id = ${b.mapping.id} AND entity_id = ${a.mapping.entityId}`)).rowCount) done.push("mapping");
  if ((await tx.execute(sql`UPDATE contacts SET name = ${b.contact.name}, position = ${b.contact.position}, phone = ${b.contact.phone} WHERE id = ${contactId}
      AND name = ${a.contact.name} AND position IS NOT DISTINCT FROM ${a.contact.position} AND phone IS NOT DISTINCT FROM ${a.contact.phone}`)).rowCount) done.push("contact");
  if (a.quote && (await tx.execute(sql`UPDATE quotes SET customer_contact_email = ${b.quote.customerContactEmail} WHERE id = ${a.quote.id} AND customer_contact_email IS NOT DISTINCT FROM ${a.quote.customerContactEmail}`)).rowCount) done.push("quote");
  await tx.execute(sql`UPDATE import_batches SET status = 'rolled_back' WHERE id = ${batchId} AND module = ${REPAIR_MODULE}`);
  return { batchId, reverted: done };
}

// ─── 공통: 배치·근거 기록 ──────────────────────────────────────────────
async function newBatch(tx: Dbx, kind: string, opts: { userId: number | null; reason?: string; saleNos?: string[]; contactIds?: number[] }, total: number) {
  const scope = opts.saleNos ? `판매 ${opts.saleNos.length}건 지정` : `담당자 ${opts.contactIds?.length ?? 0}명 지정`;
  const [b] = await rows(tx, sql`INSERT INTO import_batches (module, import_type, original_filename, total_rows, success_rows, status, created_by, source_system, is_current)
    VALUES (${REPAIR_MODULE}, ${kind}, ${opts.reason ? `${opts.reason} (${scope})` : scope}, ${total}, 0, 'running', ${opts.userId}, 'old_crm', false) RETURNING id`);
  return Number(b.id);
}
async function finishBatch(tx: Dbx, batchId: number, n: number) {
  await tx.execute(sql`UPDATE import_batches SET success_rows = ${n}, status = 'completed' WHERE id = ${batchId}`);
}
async function lineage(tx: Dbx, batchId: number, entityId: number, rowKey: string, status: string, legacyId: string | null, raw: unknown) {
  await tx.execute(sql`INSERT INTO import_row_sources (batch_id, module, entity_id, row_key, status, source_system, legacy_id, source_raw)
    VALUES (${batchId}, ${REPAIR_MODULE}, ${entityId}, ${rowKey}, ${status}, 'old_crm', ${legacyId}, ${JSON.stringify(raw)}::jsonb)`);
}
