import { Router, type IRouter } from "express";
import {
  db,
  quotesTable,
  comparisonQuotesTable,
  comparisonQuoteItemsTable,
  comparisonQuoteVendorsTable,
  projectsTable,
  companiesTable,
  contactsTable,
} from "@workspace/db";
import { eq, asc, desc, inArray } from "drizzle-orm";
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth";

// ─────────────────────────────────────────────────────────────────────────────
// 비교견적 API — 고객 제출용 보조 문서(다른 상호 명의). VERITAS 실제 영업/매출 아님.
//  · comparison_quotes / comparison_quote_items 두 테이블만 다룬다.
//  · quotes/quote_items/projects/청구/수금/정산 을 절대 수정하지 않는다(원본 존재 확인용 SELECT 만).
//  · projectId·status·판매전환 개념이 없다 → downstream 금융 흐름에 구조적으로 도달 불가.
// ─────────────────────────────────────────────────────────────────────────────

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

type ItemInput = {
  sourceQuoteItemId?: number | null;
  description?: unknown;
  languagePair?: unknown;
  quantity?: unknown;
  unit?: unknown;
  unitPrice?: unknown;
  amount?: unknown;
  memo?: unknown;
  sortOrder?: unknown;
};

const numStr = (v: unknown, fallback = "0"): string => {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : fallback;
};
const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const normVat = (v: unknown): "vat_10" | "none" => (v === "none" ? "none" : "vat_10");

// 표시용 합계(공급가액/부가세/합계) — 항목 amount 합산 기준. 부가세는 vatMode 로만 결정.
function computeTotals(items: { amount: string | number | null }[], vatMode: "vat_10" | "none") {
  const supply = items.reduce((a, it) => a + (Number(it.amount) || 0), 0);
  const tax = vatMode === "vat_10" ? Math.round(supply * 0.1) : 0;
  return { supply, tax, total: supply + tax };
}

function mapItemRows(comparisonQuoteId: number, items: ItemInput[]) {
  return items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => str(it.description) != null)
    .map(({ it, i }) => ({
      comparisonQuoteId,
      sourceQuoteItemId:
        typeof it.sourceQuoteItemId === "number" ? it.sourceQuoteItemId : null,
      description: String(it.description).trim(),
      languagePair: str(it.languagePair),
      quantity: numStr(it.quantity, "1"),
      unit: str(it.unit) ?? "건",
      unitPrice: numStr(it.unitPrice, "0"),
      amount: numStr(it.amount, "0"),
      memo: str(it.memo),
      sortOrder: Number.isFinite(Number(it.sortOrder)) ? Number(it.sortOrder) : i,
    }));
}

// 비교업체/문서 헤더 필드 정리 — VERITAS 정보를 절대 기본값으로 넣지 않는다(빈 값은 null).
function headerFields(body: Record<string, unknown>) {
  return {
    companyName: String(body.companyName ?? "").trim(),
    representativeName: str(body.representativeName),
    businessNumber: str(body.businessNumber),
    address: str(body.address),
    phone: str(body.phone),
    email: str(body.email),
    website: str(body.website),
    logoUrl: str(body.logoUrl),
    contactName: str(body.contactName),
    displayNumber: str(body.displayNumber),
    quoteDate: str(body.quoteDate), // 'YYYY-MM-DD' | null
    vatMode: normVat(body.vatMode),
    memo: str(body.memo),
  };
}

// 고객(수신처) 스냅샷 필드 — 클라이언트가 보낸 값(사용자 수정분)만 반영. 미전달 키는 undefined 로 남겨
//  POST 는 원본 견적에서 해결한 값으로, PUT 은 기존 스냅샷으로 유지하도록 상위에서 병합한다.
type CustomerSnapshot = {
  customerCompanyName: string | null;
  customerRepresentativeName: string | null;
  customerContactName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
};
function customerFieldsFromBody(body: Record<string, unknown>): Partial<CustomerSnapshot> {
  const out: Partial<CustomerSnapshot> = {};
  if ("customerCompanyName" in body) out.customerCompanyName = str(body.customerCompanyName);
  if ("customerRepresentativeName" in body) out.customerRepresentativeName = str(body.customerRepresentativeName);
  if ("customerContactName" in body) out.customerContactName = str(body.customerContactName);
  if ("customerPhone" in body) out.customerPhone = str(body.customerPhone);
  if ("customerEmail" in body) out.customerEmail = str(body.customerEmail);
  return out;
}

// 원본 견적 → 고객(수신자) 정보 해결(READ ONLY). 원본 데이터를 절대 수정하지 않는다.
//  ⚠ SSOT: 원본 VERITAS 견적 PDF(GET /admin/quotes/:id, admin.ts)가 수신자 정보를 만드는 경로를 그대로 미러링한다.
//   companyId = COALESCE(quote.derivedCompanyId, project.companyId)
//   contactId = COALESCE(quote.derivedContactId, project.contactId)
//   상호/대표자      ← companies.name / companies.representative_name
//   담당자/연락처/이메일 ← contacts.name / COALESCE(phone, mobile, office_phone) / contacts.email
//  (연락처·이메일은 담당자(contacts) 기준만 사용 — 회사 phone/email 로 대체하지 않는다: 원본 PDF와 동일 값 보장.)
async function resolveQuoteCustomer(quoteId: number): Promise<CustomerSnapshot> {
  const empty: CustomerSnapshot = {
    customerCompanyName: null, customerRepresentativeName: null,
    customerContactName: null, customerPhone: null, customerEmail: null,
  };
  const [q] = await db
    .select({
      projectId: quotesTable.projectId,
      derivedCompanyId: quotesTable.derivedCompanyId,
      derivedContactId: quotesTable.derivedContactId,
    })
    .from(quotesTable)
    .where(eq(quotesTable.id, quoteId));
  if (!q) return empty;

  let companyId: number | null = q.derivedCompanyId ?? null;
  let contactId: number | null = q.derivedContactId ?? null;
  if ((companyId == null || contactId == null) && q.projectId != null) {
    const [proj] = await db
      .select({ companyId: projectsTable.companyId, contactId: projectsTable.contactId })
      .from(projectsTable)
      .where(eq(projectsTable.id, q.projectId));
    if (proj) {
      companyId = companyId ?? proj.companyId ?? null;
      contactId = contactId ?? proj.contactId ?? null;
    }
  }

  const out: CustomerSnapshot = { ...empty };
  if (companyId != null) {
    const [co] = await db
      .select({ name: companiesTable.name, representativeName: companiesTable.representativeName })
      .from(companiesTable)
      .where(eq(companiesTable.id, companyId));
    if (co) {
      out.customerCompanyName = str(co.name);
      out.customerRepresentativeName = str(co.representativeName);
    }
  }
  if (contactId != null) {
    const [ct] = await db
      .select({
        name: contactsTable.name, email: contactsTable.email,
        phone: contactsTable.phone, mobile: contactsTable.mobile, officePhone: contactsTable.officePhone,
      })
      .from(contactsTable)
      .where(eq(contactsTable.id, contactId));
    if (ct) {
      out.customerContactName = str(ct.name);
      out.customerPhone = str(ct.phone) ?? str(ct.mobile) ?? str(ct.officePhone);
      out.customerEmail = str(ct.email);
    }
  }
  return out;
}

// ── 원본 견적의 고객(수신처) 정보 — 비교견적 폼 자동 채움/시드용(READ ONLY) ──────
router.get(
  "/admin/quotes/:quoteId/customer-info",
  ...adminGuard,
  requirePermission("quote.view"),
  async (req, res) => {
    const quoteId = Number(req.params.quoteId);
    if (!Number.isInteger(quoteId) || quoteId <= 0) {
      res.status(400).json({ error: "quoteId는 양의 정수여야 합니다." });
      return;
    }
    try {
      const c = await resolveQuoteCustomer(quoteId);
      res.json(c);
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: customer-info failed");
      res.status(500).json({ error: "고객 정보 조회 실패." });
    }
  },
);

// ── 목록: 특정 원본 견적의 비교견적들 ────────────────────────────────────────
router.get(
  "/admin/quotes/:quoteId/comparison-quotes",
  ...adminGuard,
  requirePermission("quote.view"),
  async (req, res) => {
    const quoteId = Number(req.params.quoteId);
    if (!Number.isInteger(quoteId) || quoteId <= 0) {
      res.status(400).json({ error: "quoteId는 양의 정수여야 합니다." });
      return;
    }
    try {
      const rows = await db
        .select()
        .from(comparisonQuotesTable)
        .where(eq(comparisonQuotesTable.sourceQuoteId, quoteId))
        .orderBy(desc(comparisonQuotesTable.createdAt), desc(comparisonQuotesTable.id));
      const ids = rows.map((r) => r.id);
      const items = ids.length
        ? await db
            .select()
            .from(comparisonQuoteItemsTable)
            .where(inArray(comparisonQuoteItemsTable.comparisonQuoteId, ids))
        : [];
      const byCq = new Map<number, typeof items>();
      for (const it of items) {
        const arr = byCq.get(it.comparisonQuoteId) ?? [];
        arr.push(it);
        byCq.set(it.comparisonQuoteId, arr);
      }
      const result = rows.map((r) => {
        const its = byCq.get(r.id) ?? [];
        const totals = computeTotals(its, r.vatMode as "vat_10" | "none");
        return { ...r, itemCount: its.length, ...totals };
      });
      res.json(result);
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: list failed");
      res.status(500).json({ error: "비교견적 조회 실패." });
    }
  },
);

// ── 단건 조회 (항목 포함) ────────────────────────────────────────────────────
router.get(
  "/admin/comparison-quotes/:id",
  ...adminGuard,
  requirePermission("quote.view"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id는 양의 정수여야 합니다." });
      return;
    }
    try {
      const [cq] = await db
        .select()
        .from(comparisonQuotesTable)
        .where(eq(comparisonQuotesTable.id, id));
      if (!cq) {
        res.status(404).json({ error: "비교견적을 찾을 수 없습니다." });
        return;
      }
      const items = await db
        .select()
        .from(comparisonQuoteItemsTable)
        .where(eq(comparisonQuoteItemsTable.comparisonQuoteId, id))
        .orderBy(asc(comparisonQuoteItemsTable.sortOrder), asc(comparisonQuoteItemsTable.id));
      res.json({ ...cq, items, ...computeTotals(items, cq.vatMode as "vat_10" | "none") });
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: get failed");
      res.status(500).json({ error: "비교견적 조회 실패." });
    }
  },
);

// ── 생성 (원본 견적 기준 스냅샷) ─────────────────────────────────────────────
router.post(
  "/admin/quotes/:quoteId/comparison-quotes",
  ...adminGuard,
  requirePermission("quote.create"),
  async (req, res) => {
    const quoteId = Number(req.params.quoteId);
    if (!Number.isInteger(quoteId) || quoteId <= 0) {
      res.status(400).json({ error: "quoteId는 양의 정수여야 합니다." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const header = headerFields(body);
    if (!header.companyName) {
      res.status(400).json({ error: "상호명은 필수입니다." });
      return;
    }
    const items = Array.isArray(body.items) ? (body.items as ItemInput[]) : [];
    try {
      // 원본 견적 존재 확인 (읽기 전용 — 원본은 절대 수정하지 않음).
      const [srcQuote] = await db
        .select({ id: quotesTable.id })
        .from(quotesTable)
        .where(eq(quotesTable.id, quoteId));
      if (!srcQuote) {
        res.status(404).json({ error: `원본 견적 ${quoteId}을(를) 찾을 수 없습니다.` });
        return;
      }
      // 고객(수신처) 스냅샷 — 원본 견적에서 해결한 값을 기본으로, 클라이언트가 보낸 수정분이 있으면 우선.
      const resolvedCustomer = await resolveQuoteCustomer(quoteId);
      const customer: CustomerSnapshot = { ...resolvedCustomer, ...customerFieldsFromBody(body) };
      const created = await db.transaction(async (tx) => {
        const [cq] = await tx
          .insert(comparisonQuotesTable)
          .values({ sourceQuoteId: quoteId, ...header, ...customer })
          .returning();
        const rows = mapItemRows(cq.id, items);
        if (rows.length) await tx.insert(comparisonQuoteItemsTable).values(rows);
        return cq;
      });
      res.status(201).json({ id: created.id });
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: create failed");
      res.status(500).json({ error: "비교견적 생성 실패." });
    }
  },
);

// ── 수정 (헤더 + 항목 전체 교체) ─────────────────────────────────────────────
router.put(
  "/admin/comparison-quotes/:id",
  ...adminGuard,
  requirePermission("quote.create"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id는 양의 정수여야 합니다." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const header = headerFields(body);
    if (!header.companyName) {
      res.status(400).json({ error: "상호명은 필수입니다." });
      return;
    }
    const items = Array.isArray(body.items) ? (body.items as ItemInput[]) : [];
    try {
      const [existing] = await db
        .select({ id: comparisonQuotesTable.id })
        .from(comparisonQuotesTable)
        .where(eq(comparisonQuotesTable.id, id));
      if (!existing) {
        res.status(404).json({ error: "비교견적을 찾을 수 없습니다." });
        return;
      }
      // 고객 스냅샷은 '생성 시점 유지'가 기본 — 클라이언트가 보낸 키만 갱신(미전달 키는 기존값 보존).
      const customerEdits = customerFieldsFromBody(body);
      await db.transaction(async (tx) => {
        await tx
          .update(comparisonQuotesTable)
          .set({ ...header, ...customerEdits, updatedAt: new Date() })
          .where(eq(comparisonQuotesTable.id, id));
        await tx
          .delete(comparisonQuoteItemsTable)
          .where(eq(comparisonQuoteItemsTable.comparisonQuoteId, id));
        const rows = mapItemRows(id, items);
        if (rows.length) await tx.insert(comparisonQuoteItemsTable).values(rows);
      });
      res.json({ id });
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: update failed");
      res.status(500).json({ error: "비교견적 수정 실패." });
    }
  },
);

// ── 복사 (동일 원본 견적 하위로 사본 생성) ───────────────────────────────────
router.post(
  "/admin/comparison-quotes/:id/duplicate",
  ...adminGuard,
  requirePermission("quote.create"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id는 양의 정수여야 합니다." });
      return;
    }
    try {
      const [cq] = await db
        .select()
        .from(comparisonQuotesTable)
        .where(eq(comparisonQuotesTable.id, id));
      if (!cq) {
        res.status(404).json({ error: "비교견적을 찾을 수 없습니다." });
        return;
      }
      const items = await db
        .select()
        .from(comparisonQuoteItemsTable)
        .where(eq(comparisonQuoteItemsTable.comparisonQuoteId, id));
      const created = await db.transaction(async (tx) => {
        const [copy] = await tx
          .insert(comparisonQuotesTable)
          .values({
            sourceQuoteId: cq.sourceQuoteId,
            companyName: `${cq.companyName} (사본)`,
            representativeName: cq.representativeName,
            businessNumber: cq.businessNumber,
            address: cq.address,
            phone: cq.phone,
            email: cq.email,
            website: cq.website,
            logoUrl: cq.logoUrl,
            contactName: cq.contactName,
            displayNumber: cq.displayNumber,
            quoteDate: cq.quoteDate,
            vatMode: cq.vatMode,
            memo: cq.memo,
            // 고객(수신처) 스냅샷도 그대로 복사(생성 시점 정보 유지).
            customerCompanyName: cq.customerCompanyName,
            customerRepresentativeName: cq.customerRepresentativeName,
            customerContactName: cq.customerContactName,
            customerPhone: cq.customerPhone,
            customerEmail: cq.customerEmail,
          })
          .returning();
        if (items.length) {
          await tx.insert(comparisonQuoteItemsTable).values(
            items.map((it) => ({
              comparisonQuoteId: copy.id,
              sourceQuoteItemId: it.sourceQuoteItemId,
              description: it.description,
              languagePair: it.languagePair,
              quantity: it.quantity,
              unit: it.unit,
              unitPrice: it.unitPrice,
              amount: it.amount,
              memo: it.memo,
              sortOrder: it.sortOrder,
            })),
          );
        }
        return copy;
      });
      res.status(201).json({ id: created.id });
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: duplicate failed");
      res.status(500).json({ error: "비교견적 복사 실패." });
    }
  },
);

// ── 삭제 (비교견적만 삭제 — 원본 견적 무영향) ────────────────────────────────
router.delete(
  "/admin/comparison-quotes/:id",
  ...adminGuard,
  requirePermission("quote.create"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id는 양의 정수여야 합니다." });
      return;
    }
    try {
      const deleted = await db
        .delete(comparisonQuotesTable)
        .where(eq(comparisonQuotesTable.id, id))
        .returning({ id: comparisonQuotesTable.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: "비교견적을 찾을 수 없습니다." });
        return;
      }
      res.json({ ok: true, id });
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: delete failed");
      res.status(500).json({ error: "비교견적 삭제 실패." });
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 비교견적 공급자(업체) Master — 저장해 두고 비교견적 생성 시 선택 → 스냅샷 복사.
//  · Master 는 comparison_quote_vendors 한 테이블만 사용. 비교견적(comparison_quotes)과 분리.
//  · 여기서 quotes/quote_items/companies/contacts 등 원본 도메인을 절대 건드리지 않는다.
// ═══════════════════════════════════════════════════════════════════════════

// 공급자 Master 입력 정리 — 상호만 필수, 나머지는 빈 값이면 null.
function vendorFields(body: Record<string, unknown>) {
  return {
    companyName: String(body.companyName ?? "").trim(),
    representativeName: str(body.representativeName),
    businessNumber: str(body.businessNumber),
    address: str(body.address),
    phone: str(body.phone),
    email: str(body.email),
    website: str(body.website),
    isActive: body.isActive === undefined ? true : Boolean(body.isActive),
  };
}

// ── 목록 (기본 활성만, ?includeInactive=1 이면 전체) ─────────────────────────
router.get(
  "/admin/comparison-quote-vendors",
  ...adminGuard,
  requirePermission("quote.view"),
  async (req, res) => {
    try {
      const includeInactive = String(req.query.includeInactive ?? "") === "1";
      const rows = await db
        .select()
        .from(comparisonQuoteVendorsTable)
        .orderBy(asc(comparisonQuoteVendorsTable.companyName), asc(comparisonQuoteVendorsTable.id));
      res.json(includeInactive ? rows : rows.filter((r) => r.isActive));
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: vendor list failed");
      res.status(500).json({ error: "비교견적 업체 조회 실패." });
    }
  },
);

// ── 생성 ─────────────────────────────────────────────────────────────────────
router.post(
  "/admin/comparison-quote-vendors",
  ...adminGuard,
  requirePermission("quote.create"),
  async (req, res) => {
    const v = vendorFields((req.body ?? {}) as Record<string, unknown>);
    if (!v.companyName) {
      res.status(400).json({ error: "상호명은 필수입니다." });
      return;
    }
    try {
      const [created] = await db.insert(comparisonQuoteVendorsTable).values(v).returning();
      res.status(201).json(created);
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: vendor create failed");
      res.status(500).json({ error: "비교견적 업체 저장 실패." });
    }
  },
);

// ── 수정 (Master 갱신 — 이미 생성된 비교견적 스냅샷에는 영향 없음) ────────────
router.put(
  "/admin/comparison-quote-vendors/:id",
  ...adminGuard,
  requirePermission("quote.create"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id는 양의 정수여야 합니다." });
      return;
    }
    const v = vendorFields((req.body ?? {}) as Record<string, unknown>);
    if (!v.companyName) {
      res.status(400).json({ error: "상호명은 필수입니다." });
      return;
    }
    try {
      const [updated] = await db
        .update(comparisonQuoteVendorsTable)
        .set({ ...v, updatedAt: new Date() })
        .where(eq(comparisonQuoteVendorsTable.id, id))
        .returning();
      if (!updated) {
        res.status(404).json({ error: "비교견적 업체를 찾을 수 없습니다." });
        return;
      }
      res.json(updated);
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: vendor update failed");
      res.status(500).json({ error: "비교견적 업체 수정 실패." });
    }
  },
);

// ── 삭제 (Master 만 삭제 — 생성된 비교견적 스냅샷 무영향) ─────────────────────
router.delete(
  "/admin/comparison-quote-vendors/:id",
  ...adminGuard,
  requirePermission("quote.create"),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id는 양의 정수여야 합니다." });
      return;
    }
    try {
      const deleted = await db
        .delete(comparisonQuoteVendorsTable)
        .where(eq(comparisonQuoteVendorsTable.id, id))
        .returning({ id: comparisonQuoteVendorsTable.id });
      if (deleted.length === 0) {
        res.status(404).json({ error: "비교견적 업체를 찾을 수 없습니다." });
        return;
      }
      res.json({ ok: true, id });
    } catch (err) {
      req.log.error({ err }, "ComparisonQuotes: vendor delete failed");
      res.status(500).json({ error: "비교견적 업체 삭제 실패." });
    }
  },
);

export default router;
