// ─────────────────────────────────────────────────────────────────────────────
// 과거 CRM 판매건 → 운영 판매건 전환(건별, 대표 승인 2026-10-26)
//
// 원칙
//   · 일괄 전환 없음 — 사용자가 [수정]을 누른 판매건 1건만, 미리보기 확인 후 전환한다.
//   · 과거 CRM 원본(legacy_archive_rows·연결)은 수정하지 않는다. 운영 데이터는 기존 판매 구조
//     (projects/quotes/quote_items/performance_assignments/project_payments)에 새로 만든다.
//   · 원본↔운영 매핑: legacy_master_mappings(old_crm, 'sale', 판매번호 → projects.id). 고유키로 중복 전환 차단.
//     판매번호는 재업로드로 원본 행 버전이 바뀌어도 유지되는 식별키다.
//   · 계보: import_batches(module=legacy_sale_activation) + import_row_sources(생성 레코드별 출처·분류).
//   · 금액·상품: 원본 그대로(분할·추정 금지). 과거 판매목록은 총액만 있어 공급가·VAT 를 나누지 않는다.
//   · 수행: 원본 수행행 1건 = 수행정보 1건(기존 저장 SSOT applyPerformanceRow 재사용).
//       - 통번역사지급일 있음 → 과거 지급완료(paid, 지급회차·송금기록 생성 없음)
//       - 지급일 없음 + 지급액/수행비 있음 → 과거 지급 확인 필요(payment_hold, 관리자 확인 전 지급대상 제외)
//       - 금액 없음 → 미지급(지급대상 아님: 금액 0)
//   · 수금: 입금일 + 입금내역 금액합계 = 판매총액일 때만 과거 수금완료 1건. 그 외는 '수금 확인 대상'(자동 수금완료 금지).
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import {
  db, legacyArchiveRowsTable, legacyMasterMappingsTable, importBatchesTable, importRowSourcesTable,
  projectsTable, quotesTable, quoteItemsTable, projectPaymentsTable, performanceAssignmentsTable,
} from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { normalizeCompanyName } from "../lib/normalizeCompany";
import { getSettings } from "../lib/getSettings";
import { generateQuoteNumber } from "../routes/admin";
import { applyPerformanceRow, loadKrHolidaySet, type ApplyRowCtx } from "../routes/performances";
import { rawRowFromRecord, buildAssignPayload, computeAssignPreview } from "../routes/pastWorkImport";
import { maskSourceRawForRead } from "./legacyArchiveResolve";

import { ACTIVATION_MODULE, activatedSaleExists } from "./legacyActivationLineage";
export { ACTIVATION_MODULE, activatedSaleExists };
const SRC = "old_crm";
const ENTITY = "sale";

type Dbx = typeof db | any;
const rows = async (dbx: Dbx, q: any) => ((await dbx.execute(q)).rows as any[]);

export class ActivationError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra?: Record<string, unknown>) { super(message); }
}

const dateOf = (v: unknown): string | null => (typeof v === "string" ? (v.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null) : null);
const num = (v: unknown): number | null => { if (v == null || v === "") return null; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const nameKey = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

// 입금내역 원문에서 금액 추출(예: "국민 880,000", "하나 100,000 / 국민 68,750"). 3자리 콤마 숫자 또는 4자리 이상 숫자만 금액으로 본다.
export function parseDepositAmounts(memo: unknown): number[] {
  const s = String(memo ?? "");
  const out: number[] = [];
  for (const m of s.matchAll(/(?<![\d.-])(\d{1,3}(?:,\d{3})+|\d{4,})(?![\d,])/g)) {
    const t = m[1];
    if (/^(19|20)\d{2}$/.test(t) && !t.includes(",")) continue;   // 연도 표기 제외
    out.push(Number(t.replace(/,/g, "")));
  }
  return out;
}

function itemTypeOf(productName: string): "translation" | "interpretation" | "equipment" {
  if (/장비|부스|리시버|수신기/.test(productName)) return "equipment";
  if (/통역/.test(productName) && !/번역/.test(productName)) return "interpretation";
  return /통역/.test(productName) ? "interpretation" : "translation";
}

async function loadTranslatorIndex(dbx: Dbx) {
  const maps = await rows(dbx, sql`SELECT btrim(m.legacy_id) nm, m.entity_id id FROM legacy_master_mappings m
    JOIN users u ON u.id = m.entity_id AND u.deleted_at IS NULL AND u.role = 'translator'
    WHERE m.entity_type = 'translator' AND m.status <> 'rolled_back' AND btrim(m.legacy_id) <> ''`);
  const exact = new Map<string, Set<number>>(), norm = new Map<string, Set<number>>();
  const add = (mp: Map<string, Set<number>>, k: string, id: number) => { if (!k) return; const s = mp.get(k) ?? new Set(); s.add(id); mp.set(k, s); };
  for (const r of maps) { add(exact, String(r.nm), Number(r.id)); add(norm, normalizeCompanyName(r.nm), Number(r.id)); }
  return (name: string): { id: number | null; method: "mapping" | "mapping_normalized" | "ambiguous" | "unmapped" | "none" } => {
    const n = String(name ?? "").trim();
    if (!n) return { id: null, method: "none" };
    const e = exact.get(n);
    if (e?.size === 1) return { id: [...e][0], method: "mapping" };
    if (e && e.size > 1) return { id: null, method: "ambiguous" };
    const z = norm.get(normalizeCompanyName(n));
    if (z?.size === 1) return { id: [...z][0], method: "mapping_normalized" };
    if (z && z.size > 1) return { id: null, method: "ambiguous" };
    return { id: null, method: "unmapped" };
  };
}

async function matchCompany(dbx: Dbx, name: string | null) {
  const key = normalizeCompanyName(name ?? "");
  if (!key) return { matchedId: null as number | null, matchedName: null as string | null, method: "unmatched", candidates: 0 };
  // 앱 공용 정규화(normalizeCompanyName)로 거래처명·별칭을 정확 비교. 후보 1곳일 때만 연결.
  const alias = await rows(dbx, sql`SELECT ca.company_id id, c.name FROM company_aliases ca JOIN companies c ON c.id = ca.company_id AND c.deleted_at IS NULL WHERE ca.normalized_alias = ${key}`);
  const all = await rows(dbx, sql`SELECT id, name FROM companies WHERE deleted_at IS NULL`);
  const hits = new Map<number, string>();
  for (const c of [...alias, ...all.filter(c => normalizeCompanyName(c.name) === key)]) hits.set(Number(c.id), c.name);
  if (hits.size === 1) { const [id, nm] = [...hits.entries()][0]; return { matchedId: id, matchedName: nm, method: "name_or_alias", candidates: 1 }; }
  return { matchedId: null, matchedName: null, method: hits.size > 1 ? "ambiguous" : "unmatched", candidates: hits.size };
}

async function matchContact(dbx: Dbx, companyId: number | null, name: string | null) {
  if (!companyId || !nameKey(name)) return { matchedId: null as number | null, method: companyId ? "unmatched" : "no_company" };
  const cs = await rows(dbx, sql`SELECT id, name FROM contacts WHERE company_id = ${companyId} AND deleted_at IS NULL AND is_active`);
  const hit = cs.filter(c => nameKey(c.name) === nameKey(name));
  return hit.length === 1 ? { matchedId: Number(hit[0].id), method: "name" } : { matchedId: null, method: hit.length > 1 ? "ambiguous" : "unmatched" };
}

async function matchStaff(dbx: Dbx, name: string | null) {
  if (!nameKey(name)) return null;
  const us = await rows(dbx, sql`SELECT id, name FROM users WHERE role IN ('admin','staff') AND deleted_at IS NULL`);
  const hit = us.filter(u => nameKey(u.name) === nameKey(name));
  return hit.length === 1 ? Number(hit[0].id) : null;
}

// 원본 수행행 → 수행정보 payload. 원본의 빈 수행비 칸은 0 으로 저장돼 있어 0 은 '값 없음'으로 본다.
//   수행비 항목으로 계산한 세전액이 원본 지급액(세전)과 다르면, 원본 지급액을 그대로 원가로 보존한다(금액 추정·변경 금지).
export function buildLegacyPayload(rr: ReturnType<typeof rawRowFromRecord>, translatorId: number | null) {
  const z = (v: number | null) => (v == null || v === 0 ? null : v);
  const clean = { ...rr, fee100: z(rr.fee100), fee85: z(rr.fee85), perfUnitPrice: z(rr.perfUnitPrice), perfQuantity: z(rr.perfQuantity), quantity: z(rr.quantity) };
  let payload: any = buildAssignPayload(clean, translatorId);
  let gross = computeAssignPreview(payload).gross;
  const original = rr.preTaxPayout != null && rr.preTaxPayout > 0 ? rr.preTaxPayout : null;
  let basis: "breakdown" | "original" = "breakdown";
  if (original != null && Math.abs(original - gross) >= 1) {
    payload = { ...payload, isDirectAmount: false, directAmount: null, contractUnitPrice: original, quantity: 1, expenses: [], deductions: [] };
    gross = computeAssignPreview(payload).gross;
    basis = "original";
  }
  return { payload, gross, original, basis };
}

export async function findActivationBySaleNo(dbx: Dbx, saleNo: string) {
  const [m] = await rows(dbx, sql`SELECT m.entity_id project_id, p.status FROM legacy_master_mappings m LEFT JOIN projects p ON p.id = m.entity_id
    WHERE m.source_system = ${SRC} AND m.entity_type = ${ENTITY} AND m.legacy_id = ${saleNo} AND m.status = 'active' LIMIT 1`);
  return m ? { projectId: Number(m.project_id), status: m.status as string | null } : null;
}

export type PlannedPayStatus = "legacy_paid" | "payout_review" | "unpaid";

// ── 미리보기(DB 미변경) ─────────────────────────────────────────────────────
export async function buildActivationPlan(dbx: Dbx, legacyRowId: number) {
  const [sale] = await dbx.select().from(legacyArchiveRowsTable).where(eq(legacyArchiveRowsTable.id, legacyRowId));
  if (!sale || sale.sourceType !== "sales_list") throw new ActivationError(404, "과거 CRM 판매건을 찾을 수 없습니다.");
  const raw = (sale.sourceRaw ?? {}) as Record<string, unknown>;
  const saleNo = String(raw["판매번호"] ?? "").trim();
  if (!saleNo) throw new ActivationError(422, "판매번호가 없는 판매건은 전환할 수 없습니다(원본 식별키 없음).");
  const existing = await findActivationBySaleNo(dbx, saleNo);
  if (!sale.isEffective) {
    const [cur] = await rows(dbx, sql`SELECT id FROM legacy_archive_rows WHERE source_type='sales_list' AND is_effective AND source_raw->>'판매번호' = ${saleNo} LIMIT 1`);
    throw new ActivationError(409, "이 행은 이전 버전입니다. 최신 판매건에서 전환하세요.", "NOT_EFFECTIVE", { currentRowId: cur?.id ?? null, existing });
  }

  const saleDate = dateOf(sale.recordDate) ?? dateOf(raw["판매번호"]) ?? dateOf(raw["세금계산서발행(예정)일"]);
  const total = num(sale.totalAmount) ?? num(raw["총액"]) ?? 0;
  const productName = String(sale.productName ?? raw["상품명"] ?? "").trim() || "과거 CRM 판매";
  const opportunity = String(raw["영업기회명"] ?? "").trim();
  const companyName = (sale.companyName ?? String(raw["거래처명"] ?? "")).trim() || null;
  // 담당PM = 원본 '영업담당자'(베리타스 내부 직원). 판매목록 원본에는 고객담당자 칸이 없고, 적재 정규화 contact_name 은
  //   '영업담당자'가 들어가 있어 고객담당자로 쓰지 않는다.
  const pmName = String(raw["영업담당자"] ?? "").trim() || null;
  const pmId = await matchStaff(dbx, pmName);
  const taxInvoiceDate = dateOf(raw["세금계산서발행(예정)일"]);

  // 연결된 원본 수행행(확정 연결 · 유효 행) — 원본 그대로 1:1
  const prog = await rows(dbx, sql`SELECT p.id, p.source_raw, p.row_hash, p.source_row FROM legacy_sales_progress_links l
    JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
    WHERE l.sale_row_id = ${sale.id} AND l.decision = 'confirmed' ORDER BY p.source_row NULLS LAST, p.id`);
  // 고객담당자 = 연결 진행행 '고객명'이 단일일 때만(판매관리 목록과 동일 규칙). 내부 담당PM 이름은 고객담당자로 쓰지 않는다.
  const custNames = [...new Set(prog.map((p: any) => String(p.source_raw?.["고객명"] ?? "").trim()).filter(Boolean))];
  const contactName = custNames.length === 1 && nameKey(custNames[0]) !== nameKey(pmName) ? custNames[0] : null;
  const company = await matchCompany(dbx, companyName);
  const contact = await matchContact(dbx, company.matchedId, contactName);   // 해당 거래처 소속 담당자 중 동명 1명일 때만 연결
  const matchTr = await loadTranslatorIndex(dbx);
  const performances = prog.map((p: any, i: number) => {
    const rr = rawRowFromRecord(p.source_raw ?? {}, "진행관리", Number(p.source_row ?? i + 1));
    const tm = matchTr(rr.translatorName);
    const lp = buildLegacyPayload(rr, tm.id);
    const pv = { gross: lp.gross };
    const original = lp.original;
    const hasAmount = (original ?? 0) > 0 || pv.gross > 0;
    const planned: PlannedPayStatus = rr.payDate ? "legacy_paid" : hasAmount ? "payout_review" : "unpaid";
    return {
      progressRowId: Number(p.id), rowHash: p.row_hash as string,
      translatorName: rr.translatorName || null, translatorId: tm.id, translatorMatch: tm.method,
      category: rr.category, productName: rr.productName || rr.content || null, language: rr.language || null,
      deliveryDate: rr.deliveryDate || null, payDate: rr.payDate || null,
      originalPreTax: original, computedPreTax: pv.gross, amountDiff: original != null ? Math.round((original - pv.gross) * 100) / 100 : null,
      amountBasis: lp.basis,
      plannedStatus: planned,
    };
  });

  // 수금 대조 — 원본 입금일·입금내역
  const depositDate = dateOf(sale.collectionDate) ?? dateOf(raw["입금일"]);
  const depositMemo = String(raw["입금내역"] ?? "").trim() || null;
  const amounts = parseDepositAmounts(depositMemo);
  const parsedSum = amounts.reduce((s, n) => s + n, 0);
  let collection: { status: "matched" | "review" | "none"; reason: string | null; parsedAmount: number | null };
  if (!depositDate && !depositMemo) collection = { status: "none", reason: "원본 입금기록 없음(미수금)", parsedAmount: null };
  else if (!depositDate) collection = { status: "review", reason: "입금일 없음", parsedAmount: amounts.length ? parsedSum : null };
  else if (!amounts.length) collection = { status: "review", reason: "입금내역에서 금액을 확인할 수 없음", parsedAmount: null };
  else if (parsedSum !== total) collection = { status: "review", reason: parsedSum < total ? "입금합계 < 판매금액(부분입금 가능성)" : "입금합계 > 판매금액", parsedAmount: parsedSum };
  else collection = { status: "matched", reason: null, parsedAmount: parsedSum };

  const warnings: string[] = ["과거 CRM 판매목록에는 총액만 있어 공급가·부가세를 구분하지 않고 총액 그대로 1개 항목으로 만듭니다."];
  if (!company.matchedId) warnings.push(company.method === "ambiguous" ? "거래처 후보가 여러 곳이라 연결하지 않습니다(전환 후 판매 상세에서 지정)." : "일치하는 거래처 Master 가 없어 원본 거래처명만 보존합니다.");
  const unm = performances.filter(p => !p.translatorId).length;
  if (unm) warnings.push(`통번역사 Master 미연결 ${unm}건 — 수행정보는 원본 이름으로 만들고 연결은 전환 후 지정합니다.`);
  const origN = performances.filter(p => p.amountBasis === "original").length;
  if (origN) warnings.push(`수행비 항목 계산액이 원본 지급액(세전)과 다른 수행 ${origN}건 — 원본 지급액(세전)을 그대로 원가로 보존합니다.`);

  const perfSummary = {
    total: performances.length,
    legacyPaid: performances.filter(p => p.plannedStatus === "legacy_paid").length,
    payoutReview: performances.filter(p => p.plannedStatus === "payout_review").length,
    unpaid: performances.filter(p => p.plannedStatus === "unpaid").length,
    translatorUnmapped: unm,
  };
  const tokenBasis = JSON.stringify({ id: sale.id, h: sale.rowHash, p: performances.map(p => [p.progressRowId, p.rowHash, p.translatorId]), c: company.matchedId, k: contact.matchedId, e: existing?.projectId ?? null });
  const planToken = crypto.createHash("sha256").update(tokenBasis).digest("hex").slice(0, 32);

  return {
    legacyRowId: sale.id, saleNo, saleDate, existing,
    title: opportunity || productName, productName, total,
    company: { name: companyName, ...company }, contact: { name: contactName, ...contact },
    pm: { name: pmName, matchedId: pmId }, taxInvoiceDate,
    performances, perfSummary,
    collection: { depositDate, depositMemo, ...collection },
    warnings, planToken,
    _sale: { rowHash: sale.rowHash as string, sourceRow: sale.sourceRow as number | null },
  };
}
export type ActivationPlan = Awaited<ReturnType<typeof buildActivationPlan>>;

export function publicPlan(p: ActivationPlan) { const { _sale, ...rest } = p; return rest; }

// ── 전환 실행(하나의 트랜잭션) ──────────────────────────────────────────────
export async function executeActivation(legacyRowId: number, planToken: string, performer: { id: number | null }) {
  const pre = await buildActivationPlan(db, legacyRowId);
  if (pre.existing) throw new ActivationError(409, "이미 운영 판매건으로 전환된 판매입니다.", "ALREADY_ACTIVATED", { projectId: pre.existing.projectId });
  if (!planToken || planToken !== pre.planToken) throw new ActivationError(409, "미리보기 이후 원본·연결 정보가 바뀌었습니다. 미리보기를 다시 확인하세요.", "STALE_PLAN");
  const quoteNumber = await generateQuoteNumber();   // 발번은 트랜잭션 밖(롤백 시 번호 gap 허용 — 기존 등록 패턴과 동일)
  const stg = await getSettings();
  const holidaySet = await loadKrHolidaySet();

  return db.transaction(async (tx: any) => {
    const plan = await buildActivationPlan(tx, legacyRowId);   // 트랜잭션 안에서 재검증
    if (plan.existing || plan.planToken !== planToken) throw new ActivationError(409, "동시에 다른 전환이 진행되었거나 원본이 바뀌었습니다.", "STALE_PLAN");
    const userId = performer.id ?? null;

    const [batch] = await tx.insert(importBatchesTable).values({
      module: ACTIVATION_MODULE, importType: "legacy_sale", originalFilename: `과거CRM 판매 ${plan.saleNo}`,
      totalRows: 1 + plan.performances.length, successRows: 0, status: "running", createdBy: userId,
      sourceSystem: SRC, sourceType: "sales_list", isCurrent: false,
    }).returning({ id: importBatchesTable.id });

    const financialStatus = plan.collection.status === "matched" ? "paid" : plan.taxInvoiceDate ? "billed" : "unbilled";
    const [project] = await tx.insert(projectsTable).values({
      userId, adminId: plan.pm.matchedId ?? userId,
      companyId: plan.company.matchedId, contactId: plan.contact.matchedId,
      companyNameSnapshot: plan.company.name, contactNameSnapshot: plan.contact.name,
      title: plan.title, status: "approved", financialStatus,
    }).returning({ id: projectsTable.id });

    // 원본↔운영 매핑(고유키) — 동시 전환은 여기서 고유 제약으로 차단된다.
    await tx.insert(legacyMasterMappingsTable).values({
      sourceSystem: SRC, entityType: ENTITY, legacyId: plan.saleNo, entityId: project.id,
      importBatchId: batch.id, sourceRow: plan._sale.sourceRow ?? null, matchMethod: "activation", status: "active", createdBy: userId,
    });

    const [quote] = await tx.insert(quotesTable).values({
      projectId: project.id, quoteNumber, title: plan.title, price: String(plan.total), status: "approved",
      note: `과거 CRM 판매 전환 (판매번호 ${plan.saleNo})`,
      taxDocumentType: "tax_invoice", taxCategory: "normal", quoteType: "b2b_standard", billingType: stg.defaultBillingType, paymentMethod: null,
      issueDate: plan.saleDate ?? new Date().toISOString().slice(0, 10), validUntil: plan.saleDate ?? new Date().toISOString().slice(0, 10),
      batchItemCount: 1,
    }).returning({ id: quotesTable.id });
    const [item] = await tx.insert(quoteItemsTable).values({
      quoteId: quote.id, productId: null, productName: plan.productName, unit: "건", quantity: "1",
      unitPrice: String(plan.total), supplyAmount: String(plan.total), taxAmount: "0", totalAmount: String(plan.total),
      itemType: itemTypeOf(plan.productName), taxType: "taxable", isCustomProduct: true,
      memo: "과거 CRM 원본 상품명·총액 그대로(원본에 공급가·부가세 구분 없음)",
    }).returning({ id: quoteItemsTable.id });

    const lineage: any[] = [{
      batchId: batch.id, module: ACTIVATION_MODULE, entityId: project.id, rowKey: `sale:${plan.saleNo}`, status: "activated",
      sourceSystem: SRC, legacyId: String(plan.legacyRowId), sourceRow: plan._sale.sourceRow ?? null,
      sourceRaw: { legacyRowId: plan.legacyRowId, rowHash: plan._sale.rowHash, quoteId: quote.id, itemId: item.id, progressRowIds: plan.performances.map(p => p.progressRowId) },
    }];

    const ctx: ApplyRowCtx = { userId, isHoliday: (d: string) => holidaySet.has(d), mayConfirm: true, priorById: new Map() };
    const progRaw = new Map<number, any>((await rows(tx, sql`SELECT id, source_raw, source_row FROM legacy_archive_rows WHERE id IN (${sql.join(plan.performances.map(p => sql`${p.progressRowId}`).concat([sql`0`]), sql`, `)})`)).map((r: any) => [Number(r.id), r]));
    let seq = 0;
    const created: { assignmentId: number; progressRowId: number; planned: PlannedPayStatus }[] = [];
    for (const p of plan.performances) {
      const src = progRaw.get(p.progressRowId);
      const rr = rawRowFromRecord(src?.source_raw ?? {}, "진행관리", Number(src?.source_row ?? seq + 1));
      const { payload } = buildLegacyPayload(rr, p.translatorId) as { payload: any };
      payload.quoteId = quote.id; payload.saleItemId = item.id; payload.sequence = seq++;
      payload.withholdingTreatment = undefined;   // 세금처리는 연결된 통번역사 정산정보에서 도출(미연결·미설정은 세무확인 필요)
      if (!p.translatorId) { payload.status = "unassigned"; payload.performerNameSnapshot = rr.translatorName || null; }
      const tag = p.plannedStatus === "legacy_paid" ? `과거 지급완료(지급일 ${p.payDate})` : p.plannedStatus === "payout_review" ? "과거 지급 확인 필요" : "과거 CRM";
      payload.remark = `[과거 CRM] ${tag}${!p.translatorId && rr.translatorName ? ` · 수행자 ${rr.translatorName}(Master 미연결)` : ""}${payload.remark ? ` · ${payload.remark}` : ""}`;
      payload.payDateChangeReason = rr.payDate ? "과거 CRM 원본 지급일 보존" : null;
      const assignmentId = await applyPerformanceRow(tx, project.id, payload, ctx);
      // 과거 수행 = 이미 납품 완료(원본 납품일 보존) → 납품확인 상태로 둔다(신규 행은 저장 시 확인이 해제되므로 명시 설정).
      if (rr.deliveryDate) {
        await tx.update(performanceAssignmentsTable).set({ deliveryConfirmed: true, deliveryConfirmedBy: userId, deliveryConfirmedAt: new Date() }).where(eq(performanceAssignmentsTable.id, assignmentId));
      }
      if (p.plannedStatus === "legacy_paid") {
        await tx.update(performanceAssignmentsTable).set({ paymentStatus: "paid", status: "paid", updatedAt: new Date() }).where(eq(performanceAssignmentsTable.id, assignmentId));
      } else if (p.plannedStatus === "payout_review") {
        await tx.update(performanceAssignmentsTable).set({ paymentStatus: "payment_hold", updatedAt: new Date() }).where(eq(performanceAssignmentsTable.id, assignmentId));
      }
      created.push({ assignmentId, progressRowId: p.progressRowId, planned: p.plannedStatus });
      lineage.push({
        batchId: batch.id, module: ACTIVATION_MODULE, entityId: assignmentId, rowKey: `progress:${p.progressRowId}`, status: p.plannedStatus,
        sourceSystem: SRC, legacyId: String(p.progressRowId), sourceRow: src?.source_row ?? null,
        sourceRaw: { projectId: project.id, payDate: p.payDate, originalPreTax: p.originalPreTax, computedPreTax: p.computedPreTax, translatorMatch: p.translatorMatch },
      });
    }

    let paymentRecordId: number | null = null;
    if (plan.collection.status === "matched") {
      const [pr] = await tx.insert(projectPaymentsTable).values({
        projectId: project.id, sequence: 1, issueDate: plan.taxInvoiceDate, expectedDate: plan.collection.depositDate, paidDate: plan.collection.depositDate,
        paymentType: "lump_sum", paymentMethod: "계좌이체", supplyAmount: String(plan.total), vatAmount: "0", amount: String(plan.total),
        depositStatus: "completed", depositConfirmed: true, paymentCategory: "일반결제", depositItem: "전체금액",
        billingCompanyId: plan.company.matchedId, billingCompanyNameSnapshot: plan.company.name,
        note: `과거 CRM 입금기록 연결 — 입금내역: ${plan.collection.depositMemo ?? ""}`, createdBy: userId, updatedBy: userId,
      }).returning({ id: projectPaymentsTable.id });
      paymentRecordId = pr.id;
    }
    lineage.push({
      batchId: batch.id, module: ACTIVATION_MODULE, entityId: paymentRecordId ?? project.id, rowKey: `collection:${plan.saleNo}`,
      status: plan.collection.status === "matched" ? "legacy_collected" : plan.collection.status === "review" ? "collection_review" : "collection_none",
      sourceSystem: SRC, legacyId: String(plan.legacyRowId),
      sourceRaw: { projectId: project.id, depositDate: plan.collection.depositDate, parsedAmount: plan.collection.parsedAmount, total: plan.total, reason: plan.collection.reason },
    });
    await tx.insert(importRowSourcesTable).values(lineage);
    await tx.update(importBatchesTable).set({ successRows: lineage.length, status: "completed" }).where(eq(importBatchesTable.id, batch.id));

    return { projectId: project.id, quoteId: quote.id, itemId: item.id, batchId: batch.id, paymentRecordId, performances: created, plan: publicPlan(plan) };
  });
}

// ── 운영 판매건의 과거 CRM 출처(판매 상세 표시용) ────────────────────────────
export async function getLegacyOrigin(dbx: Dbx, projectId: number) {
  const [m] = await rows(dbx, sql`SELECT legacy_id, import_batch_id, created_at FROM legacy_master_mappings
    WHERE source_system = ${SRC} AND entity_type = ${ENTITY} AND entity_id = ${projectId} AND status = 'active' LIMIT 1`);
  if (!m) return null;
  const saleNo = String(m.legacy_id);
  const lin = await rows(dbx, sql`SELECT row_key, status, entity_id, legacy_id, source_raw FROM import_row_sources WHERE module = ${ACTIVATION_MODULE} AND batch_id = ${m.import_batch_id}`);
  const saleLin = lin.find(l => String(l.row_key).startsWith("sale:"));
  const [cur] = await rows(dbx, sql`SELECT id, row_hash, source_raw, company_name, product_name, total_amount FROM legacy_archive_rows
    WHERE source_type = 'sales_list' AND is_effective AND source_raw->>'판매번호' = ${saleNo} ORDER BY id DESC LIMIT 1`);
  const curProg = cur ? (await rows(dbx, sql`SELECT l.progress_row_id id FROM legacy_sales_progress_links l JOIN legacy_archive_rows p ON p.id = l.progress_row_id AND p.is_effective
    WHERE l.sale_row_id = ${cur.id} AND l.decision = 'confirmed' ORDER BY 1`)).map(r => Number(r.id)) : [];
  const origProg: number[] = (saleLin?.source_raw?.progressRowIds ?? []).map(Number).sort((a: number, b: number) => a - b);
  const sourceChanged = !cur || Number(cur.id) !== Number(saleLin?.source_raw?.legacyRowId) || cur.row_hash !== saleLin?.source_raw?.rowHash
    || JSON.stringify(curProg) !== JSON.stringify(origProg);
  const perfIds = lin.filter(l => String(l.row_key).startsWith("progress:")).map(l => Number(l.entity_id));
  const perfNow = perfIds.length ? await rows(dbx, sql`SELECT id, performer_name_snapshot, individual_user_id, cost_total, payment_status, payout_round_id, deleted_at, remark
    FROM performance_assignments WHERE id IN (${sql.join(perfIds.map(i => sql`${i}`), sql`, `)})`) : [];
  const byId = new Map(perfNow.map(r => [Number(r.id), r]));
  const payoutItems = lin.filter(l => String(l.row_key).startsWith("progress:")).map(l => {
    const a = byId.get(Number(l.entity_id));
    return {
      assignmentId: Number(l.entity_id), progressRowId: Number(l.legacy_id), legacyStatus: l.status as string,
      payDate: l.source_raw?.payDate ?? null, originalPreTax: l.source_raw?.originalPreTax ?? null,
      performerName: a?.performer_name_snapshot ?? null, translatorId: a?.individual_user_id ?? null,
      costTotal: a ? Number(a.cost_total) : null, paymentStatus: a?.payment_status ?? null, deleted: !!a?.deleted_at,
    };
  });
  const colLin = lin.find(l => String(l.row_key).startsWith("collection:"));
  return {
    saleNo, activatedAt: m.created_at, batchId: Number(m.import_batch_id),
    legacyRowId: cur ? Number(cur.id) : null, originalLegacyRowId: saleLin?.source_raw?.legacyRowId ?? null,
    sourceChanged,
    sourceRaw: cur ? maskSourceRawForRead("sales_list", cur.source_raw) : null,
    payoutItems,
    payoutSummary: {
      legacyPaid: payoutItems.filter(p => p.legacyStatus === "legacy_paid").length,
      reviewPending: payoutItems.filter(p => p.legacyStatus === "payout_review").length,
      reviewResolved: payoutItems.filter(p => p.legacyStatus.startsWith("payout_review_")).length,
    },
    collection: colLin ? { status: colLin.status as string, ...(colLin.source_raw ?? {}) } : null,
  };
}

// ── 과거 지급 확인 필요 건 처리(관리자 승인) ─────────────────────────────────
//   decision=paid   → 과거에 이미 지급됨 확인: 지급완료(paid) 고정(지급회차·송금기록 생성 없음 → 중복 지급 차단)
//   decision=unpaid → 미지급 확인: 지급보류 해제(unpaid) → 기존 지급회차 자동수집 대상
export async function resolvePayoutReview(assignmentId: number, decision: "paid" | "unpaid", reason: string, performer: { id: number | null }) {
  return db.transaction(async (tx: any) => {
    const [lin] = await rows(tx, sql`SELECT id, status FROM import_row_sources WHERE module = ${ACTIVATION_MODULE} AND row_key LIKE 'progress:%' AND entity_id = ${assignmentId} FOR UPDATE`);
    if (!lin) throw new ActivationError(404, "과거 CRM 전환 수행정보가 아닙니다.");
    if (lin.status !== "payout_review") throw new ActivationError(409, "이미 확인 처리된 수행정보입니다.");
    const [a] = await tx.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, assignmentId));
    if (!a || a.deletedAt) throw new ActivationError(404, "수행정보를 찾을 수 없습니다.");
    if (a.paymentStatus !== "payment_hold" || a.payoutRoundId != null) throw new ActivationError(409, "지급보류 상태(지급회차 미배정)인 건만 처리할 수 있습니다.");
    await tx.update(performanceAssignmentsTable).set({
      paymentStatus: decision === "paid" ? "paid" : "unpaid", ...(decision === "paid" ? { status: "paid" } : {}),
      remark: `${a.remark ?? ""} · 과거 지급 확인: ${decision === "paid" ? "지급완료 확인" : "미지급 확인"}(${reason})`.slice(0, 1000),
      updatedBy: performer.id ?? null, updatedAt: new Date(),
    }).where(eq(performanceAssignmentsTable.id, assignmentId));
    await tx.update(importRowSourcesTable).set({ status: decision === "paid" ? "payout_review_paid" : "payout_review_unpaid" }).where(eq(importRowSourcesTable.id, lin.id));
    return { projectId: a.projectId as number, before: { paymentStatus: a.paymentStatus, costTotal: a.costTotal } };
  });
}
