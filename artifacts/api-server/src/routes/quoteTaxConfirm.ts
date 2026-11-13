// ─── 견적 세금 유형 확인(확인 필요 → 일반과세·영세율·면세 확정) ─────────────────────────────
//  대상: 세금 유형이 불명확한 견적('확인 필요') — 과세로 저장됐는데 공급가액이 있고 부가세 0원인 품목(과거 CRM 총액 이관 등)
//        또는 품목마다 유형이 섞인 견적. 판정 규칙은 web-app lib/quoteTaxType.deriveVatMode 와 동일.
//  원칙: 원본 총액(quotes.price · 품목 total_amount)은 절대 바꾸지 않는다.
//    · 영세율/면세 확정 — 모든 품목 부가세가 0원일 때만. 품목 tax_type 만 확정(공급가·부가세·총액 그대로).
//    · 일반과세 확정 — '총액에 부가세 포함'으로만 처리: 부가세 0원 품목의 총액을 공급가(총액÷1.1, 원 단위 반올림)+부가세로 분리.
//      총액은 그대로. 부가세를 별도로 더해 총액이 바뀌는 경우는 편집 화면 저장(원본 총액 변경 확인 절차)으로만 가능.
//    · dryRun=true 면 변경 전후 금액만 돌려준다(화면 확인용). 실제 확정은 확인 근거 필수.
//  기록: 확정 유형·근거·확인 담당자·확인일을 기존 감사로그(logs, action=quote_tax_type_confirmed)에 같은 트랜잭션으로 저장.
//  청구정보(project_payments)·입금·정산 데이터는 변경하지 않는다.
import { Router, type IRouter } from "express";
import { db, quotesTable, quoteItemsTable, logsTable, usersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const ACTION = "quote_tax_type_confirmed";
const DOC_BY_KIND: Record<string, string> = { taxable: "tax_invoice", zero_rate: "zero_rate_tax_invoice", exempt: "invoice" };
const n = (v: unknown) => Number(v ?? 0);
const kindOf = (t: string | null) => (t === "zero_rate" || t === "exempt" ? t : "taxable");

type Item = typeof quoteItemsTable.$inferSelect;
/** 견적 세금 유형 판정 — lib/quoteTaxType.deriveVatMode 와 같은 규칙 */
export function quoteVatMode(items: Pick<Item, "taxType" | "supplyAmount" | "taxAmount" | "itemType">[]): string {
  const body = items.filter(it => it.itemType !== "discount");
  if (!body.length) return "taxable";
  if (body.some(it => kindOf(it.taxType) === "taxable" && Math.abs(n(it.supplyAmount)) >= 0.5 && Math.abs(n(it.taxAmount)) < 0.5)) return "unknown";
  const kinds = new Set(body.map(it => kindOf(it.taxType)));
  return kinds.size === 1 ? [...kinds][0] : "unknown";
}

type Plan = { id: number; productName: string; before: { supply: number; tax: number; total: number; taxType: string | null }; after: { supply: number; tax: number; total: number; taxType: string; unitPrice?: number } };
function planConfirm(items: Item[], taxType: string): { plan: Plan[] } | { error: string } {
  const zeroTax = (it: Item) => Math.abs(n(it.taxAmount)) < 0.5;
  if (taxType === "zero_rate" || taxType === "exempt") {
    if (!items.every(zeroTax)) return { error: "부가세가 있는 품목이 있어 금액 변경 없이 영세율·면세로 확정할 수 없습니다. 편집 화면에서 유형을 선택해 저장하세요(금액 변경 확인 절차)." };
    return { plan: items.map(it => ({ id: it.id, productName: it.productName, before: { supply: n(it.supplyAmount), tax: n(it.taxAmount), total: n(it.totalAmount), taxType: it.taxType }, after: { supply: n(it.supplyAmount), tax: 0, total: n(it.totalAmount), taxType } })) };
  }
  // 일반과세 — 총액에 부가세 포함(총액 유지)
  if (items.some(it => it.itemType === "discount")) return { error: "할인 항목이 있는 견적은 편집 화면에서 일반과세를 선택해 처리하세요." };
  const plan: Plan[] = [];
  for (const it of items) {
    const before = { supply: n(it.supplyAmount), tax: n(it.taxAmount), total: n(it.totalAmount), taxType: it.taxType };
    if (!zeroTax(it) || Math.abs(before.supply) < 0.5) { plan.push({ id: it.id, productName: it.productName, before, after: { ...before, taxType: "taxable" } }); continue; }
    // 단가 = 공급가가 되도록 분리 가능한 품목만(수량 1·투입인원 1) — 수량×단가 구조를 깨지 않기 위함
    if (n(it.quantity) !== 1 || (it.interpreterCount != null && it.interpreterCount > 1)) return { error: `'${it.productName}' 품목은 수량·인원이 1이 아니어서 총액 유지 분리를 할 수 없습니다. 편집 화면에서 처리하세요.` };
    const supply = Math.round(before.total / 1.1);
    plan.push({ id: it.id, productName: it.productName, before, after: { supply, tax: before.total - supply, total: before.total, taxType: "taxable", unitPrice: supply } });
  }
  return { plan };
}

// 최근 확인 기록(감사로그) — 견적 편집 화면 표시용
router.get("/admin/quotes/:id/tax-type-confirmation", ...adminGuard, async (req, res) => {
  const quoteId = Number(req.params.id);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 quote id." }); return; }
  const [row] = await db.select({ metadata: logsTable.metadata, createdAt: logsTable.createdAt, name: usersTable.name, email: logsTable.performedByEmail })
    .from(logsTable).leftJoin(usersTable, eq(usersTable.id, logsTable.performedBy))
    .where(and(eq(logsTable.entityType, "quote"), eq(logsTable.entityId, quoteId), eq(logsTable.action, ACTION)))
    .orderBy(desc(logsTable.createdAt)).limit(1);
  if (!row) { res.json(null); return; }
  let m: any = {}; try { m = JSON.parse(row.metadata ?? "{}"); } catch { /* 기록 형식 오류 — 표시만 생략 */ }
  res.json({ taxType: m.taxType ?? null, basis: m.basis ?? null, confirmedAt: m.confirmedAt ?? null, confirmedByName: row.name ?? row.email ?? null });
});

router.post("/admin/quotes/:id/confirm-tax-type", ...adminGuard, requirePermission("quote.create"), async (req, res) => {
  const quoteId = Number(req.params.id);
  if (!Number.isInteger(quoteId) || quoteId <= 0) { res.status(400).json({ error: "유효하지 않은 quote id." }); return; }
  const { taxType, basis, dryRun } = req.body as { taxType?: string; basis?: string; dryRun?: boolean };
  if (!taxType || !DOC_BY_KIND[taxType]) { res.status(400).json({ error: "확정할 세금 유형(일반과세·영세율·면세)을 선택하세요." }); return; }
  const [q] = await db.select().from(quotesTable).where(eq(quotesTable.id, quoteId));
  if (!q || q.deletedAt) { res.status(404).json({ error: "견적을 찾을 수 없습니다." }); return; }
  if (q.quoteType === "accumulated_batch" && q.batchClosedAt != null) { res.status(409).json({ error: "마감완료된 누적 견적서는 수정할 수 없습니다." }); return; }
  if (q.status === "approved" && q.isCurrent === false) { res.status(409).json({ error: "과거(대체된) 견적은 수정할 수 없습니다." }); return; }
  const items = await db.select().from(quoteItemsTable).where(eq(quoteItemsTable.quoteId, quoteId)).orderBy(quoteItemsTable.id);
  if (quoteVatMode(items) !== "unknown") { res.status(409).json({ error: "세금 유형 '확인 필요' 상태의 견적이 아닙니다. 유형 변경은 편집 화면에서 저장하세요." }); return; }
  const r = planConfirm(items, taxType);
  if ("error" in r) { res.status(409).json({ error: r.error, code: "TAX_CONFIRM_NOT_POSSIBLE" }); return; }
  const totalBefore = r.plan.reduce((a, p) => a + p.before.total, 0), totalAfter = r.plan.reduce((a, p) => a + p.after.total, 0);
  const summary = {
    before: { supply: r.plan.reduce((a, p) => a + p.before.supply, 0), tax: r.plan.reduce((a, p) => a + p.before.tax, 0), total: totalBefore },
    after: { supply: r.plan.reduce((a, p) => a + p.after.supply, 0), tax: r.plan.reduce((a, p) => a + p.after.tax, 0), total: totalAfter },
  };
  if (Math.abs(totalAfter - totalBefore) >= 0.005 || Math.abs(totalBefore - n(q.price)) >= 0.5) { res.status(409).json({ error: "총액이 원본과 달라지는 확정은 할 수 없습니다." }); return; }
  if (dryRun) { res.json({ dryRun: true, taxType, items: r.plan, summary }); return; }
  if (!basis?.trim()) { res.status(400).json({ error: "확인 근거(확인 자료)를 입력하세요." }); return; }
  const user = (req as any).user as { id: number; email: string };
  const confirmedAt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
  await db.transaction(async tx => {
    for (const p of r.plan) {
      await tx.update(quoteItemsTable).set({
        taxType: p.after.taxType, supplyAmount: String(p.after.supply), taxAmount: String(p.after.tax),
        ...(p.after.unitPrice != null ? { unitPrice: String(p.after.unitPrice) } : {}),
      }).where(and(eq(quoteItemsTable.id, p.id), eq(quoteItemsTable.quoteId, quoteId)));
    }
    // 발행 문서 유형 연결(quotes.price 는 변경하지 않음)
    await tx.update(quotesTable).set({ taxDocumentType: DOC_BY_KIND[taxType] }).where(eq(quotesTable.id, quoteId));
    await tx.insert(logsTable).values({
      entityType: "quote", entityId: quoteId, action: ACTION, performedBy: user.id, performedByEmail: user.email,
      metadata: JSON.stringify({ taxType, basis: basis.trim(), confirmedAt, confirmedBy: user.id, quoteNumber: q.quoteNumber, projectId: q.projectId, taxDocumentTypeBefore: q.taxDocumentType, summary, items: r.plan }),
    });
  });
  res.json({ ok: true, taxType, summary, confirmedAt });
});

export default router;
