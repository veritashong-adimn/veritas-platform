// ─── 파생견적 = "견적서 분할 발행" (견적 엔진 STEP 3, 단순화 모델) ─────────────────
// 목적: 하나의 현재유효 견적금액을 2개 이상 업체에 나누어 견적서를 각각 발행하고,
//       판매전환 시 그 분할정보를 '판매관리 청구정보(project_payments)'에 자동 반영한다.
//  · 파생견적은 별도 project 를 만들지 않는다. quote family 안에서만 관리된다.
//  · 발행/청구 대상 회사·담당자는 quotes.derived_company_id / derived_contact_id 에 보관(파생 전용 필드).
//  · relation_type='derived', is_current=false. 매출 SSOT 에서 항상 제외(계약 총매출 = 현재유효 견적금액).
//  · 1차 정책: 100% 분할(분할합계 = 현재유효 견적금액). 생성/판매전환에서 정확히 검증.
//  · 적용 대상: b2b_standard 일반견적 family 만. 누적/차감 제외.
import { and, eq, inArray, sql } from "drizzle-orm";
import { quotesTable, quoteItemsTable, projectPaymentsTable } from "@workspace/db";
import { generateRelationQuoteNumber, isRelationEngineQuoteType } from "./quoteRelation";

type Db = any;
export type Result = { http: number; body: Record<string, unknown> };

export type DerivedSplitInput = {
  companyId: number;                 // 발행/청구 대상 회사(필수)
  contactId?: number | null;         // 담당자(선택)
  mode: "items" | "amount";
  itemIds?: number[];                // mode='items'
  amount?: number;                   // mode='amount' (총액, VAT 포함)
  label?: string | null;             // mode='amount' 항목명
  taxType?: string | null;           // mode='amount' 과세유형
};

// ── 배분 계산 helper (항상 live 재계산 — 누적 카운터 미사용) ─────────────────────
function currentEffectiveAmount(family: any[]): number {
  const cur = family.find(
    (q) => (q.relationType == null || q.relationType === "revision") && q.isCurrent === true && q.deletedAt == null,
  );
  return cur ? Number(cur.price) : 0;
}
function approvedDerivedTotal(family: any[], excludeId?: number): number {
  return family
    .filter((q) => q.relationType === "derived" && q.status === "approved" && q.deletedAt == null && (excludeId == null || q.id !== excludeId))
    .reduce((s, q) => s + Number(q.price), 0);
}

// 금액 직접 분리: 총액(VAT 포함) → 공급가/부가세 역산(quote.price = Σ totalAmount 불변 유지).
function backCalcAmount(total: number, taxType: string) {
  const taxable = taxType === "taxable";
  const supply = taxable ? Math.round(total / 1.1) : total;
  const tax = total - supply;
  return { supply, tax, total };
}

// ── 파생견적(분할) 생성 — N개 업체로 한 번에 분할 발행 ──────────────────────────
export async function createDerivedSplit(
  tx: Db, sourceQuoteId: number, opts: { splits: DerivedSplitInput[]; reason?: string | null; userId: number },
): Promise<Result> {
  const [src] = await tx.select().from(quotesTable).where(eq(quotesTable.id, sourceQuoteId));
  if (!src) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (!isRelationEngineQuoteType(src.quoteType)) return { http: 400, body: { error: "일반견적(b2b_standard)만 파생견적을 생성할 수 있습니다." } };
  if (src.deletedAt != null) return { http: 400, body: { error: "삭제된 견적입니다." } };
  if (src.isCurrent !== true) return { http: 409, body: { error: "현재유효 견적에서만 파생견적을 생성할 수 있습니다. 현재유효 견적으로 이동해 주세요." } };
  if (src.relationType === "derived") return { http: 400, body: { error: "파생견적에서 다시 파생견적을 생성할 수 없습니다." } };

  const splits = Array.isArray(opts.splits) ? opts.splits : [];
  if (splits.length < 2) return { http: 400, body: { error: "2개 이상 업체로 분할해 주세요." } };

  const rootId: number = src.rootQuoteId ?? src.id;
  await tx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, rootId)).for("update"); // 동시성 직렬화

  // 원 견적 품목(품목 분리 검증용)
  const srcItems = await tx.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, sourceQuoteId)).orderBy(quoteItemsTable.id);
  const srcItemById = new Map<number, any>(srcItems.map((it: any) => [it.id, it]));

  // ── 각 분할의 품목/금액 구성 + 검증 ─────────────────────────────────────────
  const usedItemIds = new Set<number>();
  const prepared: Array<{ companyId: number; contactId: number | null; itemRows: any[]; price: number }> = [];
  for (const [i, sp] of splits.entries()) {
    if (!sp || !Number.isInteger(sp.companyId) || sp.companyId <= 0) return { http: 400, body: { error: `${i + 1}번 업체를 선택해 주세요.` } };
    let itemRows: any[] = [];
    let price = 0;
    if (sp.mode === "items") {
      const ids = Array.from(new Set((sp.itemIds ?? []).filter((n) => Number.isInteger(n) && n > 0)));
      if (ids.length === 0) return { http: 400, body: { error: `${i + 1}번 업체에 분할할 품목을 선택해 주세요.` } };
      for (const id of ids) {
        if (!srcItemById.has(id)) return { http: 400, body: { error: `선택한 품목을 원 견적에서 찾을 수 없습니다.` } };
        if (usedItemIds.has(id)) return { http: 400, body: { error: `같은 품목을 여러 업체에 중복 분할할 수 없습니다.` } };
        usedItemIds.add(id);
      }
      const rows = ids.map((id) => srcItemById.get(id));
      itemRows = rows.map((it: any) => { const { id, quoteId, createdAt, ...rest } = it; void id; void quoteId; void createdAt; return { ...rest }; });
      price = rows.reduce((s: number, it: any) => s + Number(it.totalAmount), 0);
    } else if (sp.mode === "amount") {
      const total = Math.round(Number(sp.amount) || 0);
      if (total <= 0) return { http: 400, body: { error: `${i + 1}번 업체의 분할 금액을 입력해 주세요.` } };
      const taxType = sp.taxType === "exempt" || sp.taxType === "zero_rate" ? sp.taxType : "taxable";
      const { supply, tax } = backCalcAmount(total, taxType);
      itemRows = [{
        productId: null, productName: (sp.label ?? "").trim() || "파생 배분 금액", languagePair: null, unit: "건",
        quantity: "1", unitPrice: String(supply), supplyAmount: String(supply), taxAmount: String(tax), totalAmount: String(total),
        memo: null, itemType: "expense", taxType, isCustomProduct: true,
      }];
      price = total;
    } else {
      return { http: 400, body: { error: `${i + 1}번 업체의 분할 방식이 올바르지 않습니다.` } };
    }
    prepared.push({ companyId: sp.companyId, contactId: sp.contactId ?? null, itemRows, price });
  }

  // ── 100% 분할 invariant (§6/§7): 분할합계 = 현재유효 견적금액 ──────────────────
  const base = Number(src.price);
  const splitTotal = prepared.reduce((s, p) => s + p.price, 0);
  if (splitTotal !== base) {
    return { http: 400, body: {
      error: `분할 합계 ${splitTotal.toLocaleString()}원이 현재유효 견적금액 ${base.toLocaleString()}원과 일치하지 않습니다(차이 ${(splitTotal - base).toLocaleString()}원). 1차 정책상 100% 분할만 허용됩니다.`,
      splitTotal, currentEffectiveAmount: base,
    } };
  }

  // ── N개 파생견적 생성(-01/-02/...) ──────────────────────────────────────────
  const [{ maxv } = { maxv: 1 }] = await tx.select({ maxv: sql<number>`COALESCE(MAX(${quotesTable.version}), 1)` })
    .from(quotesTable).where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootId}`);
  const created: Array<{ id: number; quoteNumber: string; companyId: number; price: number }> = [];
  let v = Number(maxv);
  for (const p of prepared) {
    const quoteNumber = await generateRelationQuoteNumber(tx, rootId, "derived");
    v += 1;
    const [derived] = await tx.insert(quotesTable).values({
      price: String(p.price), title: src.title, note: src.note,
      quoteType: "b2b_standard", billingType: src.billingType, paymentMethod: src.paymentMethod,
      taxDocumentType: src.taxDocumentType, taxCategory: src.taxCategory,
      validUntil: src.validUntil, issueDate: src.issueDate, invoiceDueDate: src.invoiceDueDate, paymentDueDate: src.paymentDueDate,
      equipmentCommon: src.equipmentCommon,
      status: "pending", isCurrent: false, projectId: null,   // 파생은 project 를 만들지 않는다(§2)
      rootQuoteId: rootId, parentVersionId: src.id, relationType: "derived",
      version: v, versionReason: opts.reason ?? null, quoteNumber,
      derivedCompanyId: p.companyId, derivedContactId: p.contactId,   // 발행/청구 대상(§4)
    }).returning();
    if (p.itemRows.length > 0) await tx.insert(quoteItemsTable).values(p.itemRows.map((r) => ({ ...r, quoteId: derived.id })));
    created.push({ id: derived.id, quoteNumber, companyId: p.companyId, price: p.price });
  }

  return { http: 200, body: { created, count: created.length, rootQuoteId: rootId, currentEffectiveAmount: base } };
}

// ── 파생견적 승인(배분 확정 + 과배분 방지, is_current 불변) ────────────────────
export async function approveDerived(tx: Db, derivedId: number): Promise<Result> {
  const [d] = await tx.select().from(quotesTable).where(eq(quotesTable.id, derivedId)).for("update");
  if (!d) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (d.relationType !== "derived") return { http: 400, body: { error: "파생견적이 아닙니다." } };
  if (d.deletedAt != null) return { http: 400, body: { error: "삭제된 견적입니다." } };
  if (d.status === "approved") return { http: 200, body: { id: d.id, alreadyProcessed: true } };
  if (d.status === "rejected") return { http: 409, body: { error: "거절된 파생견적은 승인할 수 없습니다." } };

  const rootId: number = d.rootQuoteId ?? d.id;
  await tx.select({ id: quotesTable.id }).from(quotesTable).where(eq(quotesTable.id, rootId)).for("update");
  const family = await tx.select().from(quotesTable)
    .where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootId} AND ${quotesTable.deletedAt} IS NULL`);
  const base = currentEffectiveAmount(family);
  const newTotal = approvedDerivedTotal(family, d.id) + Number(d.price);
  if (newTotal > base) {
    return { http: 409, body: {
      error: `파생견적 배분 합계 ${newTotal.toLocaleString()}원이 현재유효 견적금액 ${base.toLocaleString()}원을 초과합니다(과배분 ${(newTotal - base).toLocaleString()}원).`,
      currentEffectiveAmount: base, thisAmount: Number(d.price), overAllocated: newTotal - base,
    } };
  }
  await tx.update(quotesTable).set({ status: "approved" }).where(eq(quotesTable.id, d.id));   // is_current 불변(§13)
  return { http: 200, body: { id: d.id, alreadyProcessed: false, approvedDerivedTotal: newTotal, remaining: base - newTotal } };
}

// ── 파생견적 거절 ──────────────────────────────────────────────────────────────
export async function rejectDerived(tx: Db, derivedId: number): Promise<Result> {
  const [d] = await tx.select().from(quotesTable).where(eq(quotesTable.id, derivedId)).for("update");
  if (!d) return { http: 404, body: { error: "견적을 찾을 수 없습니다." } };
  if (d.relationType !== "derived") return { http: 400, body: { error: "파생견적이 아닙니다." } };
  if (d.status === "rejected") return { http: 200, body: { id: d.id, alreadyProcessed: true } };
  await tx.update(quotesTable).set({ status: "rejected" }).where(eq(quotesTable.id, d.id));
  return { http: 200, body: { id: d.id, alreadyProcessed: false } };
}

// ── 판매전환 시 청구정보 자동 생성 (§8/§9/§10) ──────────────────────────────────
// 판매전환된 단일 sale project 에, 승인된 파생견적별로 project_payments 청구행을 생성한다.
//  · 판매전환은 family 전체에서 project 1개만(§5). 이 함수는 매출을 만들지 않고 '청구 배분'만 기록한다(§7).
//  · 승인 파생이 존재하면 그 합계가 현재유효 금액과 정확히 일치해야 한다(§8). 아니면 throw → 판매전환 롤백.
//  · 멱등: 이미 파생 청구행이 있으면 재생성하지 않는다.
export async function generateDerivedBillingRows(
  tx: Db, saleProjectId: number, currentQuote: { id: number; price: any; rootQuoteId: number | null }, userId: number,
): Promise<{ generated: number; skipped?: boolean }> {
  const rootId: number = currentQuote.rootQuoteId ?? currentQuote.id;
  const approved = await tx.select().from(quotesTable)
    .where(sql`COALESCE(${quotesTable.rootQuoteId}, ${quotesTable.id}) = ${rootId} AND ${quotesTable.relationType} = 'derived' AND ${quotesTable.status} = 'approved' AND ${quotesTable.deletedAt} IS NULL`)
    .orderBy(quotesTable.id);
  if (approved.length === 0) return { generated: 0 };

  const base = Number(currentQuote.price);
  const sum = approved.reduce((s: number, q: any) => s + Number(q.price), 0);
  if (sum !== base) {
    throw Object.assign(new Error("DERIVED_ALLOCATION_MISMATCH"), {
      httpBody: { error: `승인된 파생견적 합계 ${sum.toLocaleString()}원이 현재유효 견적금액 ${base.toLocaleString()}원과 일치하지 않아 판매전환할 수 없습니다(§8). 파생견적을 100%로 맞춰 주세요.`, approvedDerivedTotal: sum, currentEffectiveAmount: base },
    });
  }

  // 멱등: 이미 이 판매건에 파생 청구행이 있으면 재생성하지 않는다.
  const [existing] = await tx.select({ id: projectPaymentsTable.id }).from(projectPaymentsTable)
    .where(and(eq(projectPaymentsTable.projectId, saleProjectId), sql`${projectPaymentsTable.note} LIKE '파생 %'`)).limit(1);
  if (existing) return { generated: 0, skipped: true };

  const [{ maxSeq } = { maxSeq: 0 }] = await tx.select({ maxSeq: sql<number>`COALESCE(MAX(${projectPaymentsTable.sequence}), 0)` })
    .from(projectPaymentsTable).where(eq(projectPaymentsTable.projectId, saleProjectId));
  let seq = Number(maxSeq);
  for (const d of approved) {
    const items = await tx.select({ supplyAmount: quoteItemsTable.supplyAmount, taxAmount: quoteItemsTable.taxAmount })
      .from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, d.id));
    const supply = items.reduce((s: number, it: any) => s + Number(it.supplyAmount ?? 0), 0);
    const tax = items.reduce((s: number, it: any) => s + Number(it.taxAmount ?? 0), 0);
    seq += 1;
    await tx.insert(projectPaymentsTable).values({
      projectId: saleProjectId, sequence: seq,
      paymentType: "other", paymentCategory: "일반결제",
      supplyAmount: String(supply), vatAmount: String(tax), amount: String(Number(d.price)),
      depositStatus: "scheduled",
      billingCompanyId: d.derivedCompanyId ?? null, billingContactId: d.derivedContactId ?? null,
      note: `파생 ${d.quoteNumber ?? d.id}`,   // 청구행 → 파생견적 추적(문자 표기, schema 무변경)
      createdBy: userId,
    });
  }
  return { generated: approved.length };
}

// ── 배분 현황(상세/요약 표시용) ───────────────────────────────────────────────
export function calculateAllocation(family: any[]): {
  currentEffectiveAmount: number; approvedDerivedTotal: number; pendingDerivedTotal: number; remaining: number; derivedCount: number;
} {
  const base = currentEffectiveAmount(family);
  const approved = approvedDerivedTotal(family);
  const pending = family.filter((q) => q.relationType === "derived" && q.status === "pending" && q.deletedAt == null).reduce((s, q) => s + Number(q.price), 0);
  const derivedCount = family.filter((q) => q.relationType === "derived" && q.deletedAt == null).length;
  return { currentEffectiveAmount: base, approvedDerivedTotal: approved, pendingDerivedTotal: pending, remaining: base - approved, derivedCount };
}

// revision 승인(§24)에서 재사용: family 의 승인된 파생 합계.
export function approvedDerivedSum(family: any[]): number {
  return approvedDerivedTotal(family);
}
