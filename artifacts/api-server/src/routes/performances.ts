// ─────────────────────────────────────────────────────────────────────────────
// 수행정보 (Performance Assignment) API — 1단계(기반)
//
//  · GET 프로젝트 상세는 admin.ts 에서 performances[] 로 함께 반환(별도 조회 엔드포인트 불필요).
//  · 판매정보 불러오기 / 배치 저장 / 복제 / 삭제만 여기서 제공.
//  · 개인 원천세·외주 매입 금액은 서버에서 재계산(프론트 값 불신뢰, §31).
//  · 판매(매출) 금액과 완전 분리 — quote/견적서/거래명세서에 영향 없음(§35).
// ─────────────────────────────────────────────────────────────────────────────
import { Router, type IRouter } from "express";
import {
  db, performanceAssignmentsTable, quotesTable, quoteItemsTable,
  translatorSensitiveTable, usersTable, companiesTable,
  calcIndividualPayout, calcVendorPurchase,
} from "@workspace/db";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import { decrypt, maskResidentNumber } from "../lib/encrypt";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// 판매정보 불러오기에서 수행자 배정이 필요 없는 항목(할인·조정)은 제외
const NON_PERFORMABLE_ITEM_TYPES = new Set(["discount"]);

const CATEGORY = ["individual", "vendor"] as const;
const STATUS = ["unassigned", "assigned", "in_progress", "completed", "payout_pending", "paid", "cancelled"] as const;
const RESIDENCY = ["domestic_resident", "overseas_or_nonresident"] as const;
const TREATMENT = ["domestic_3_3", "exempt", "nonresident_custom", "treaty_reduction_or_exemption", "tax_review_required"] as const;
const EVIDENCE = ["tax_invoice", "invoice", "zero_rate_tax_invoice", "other", "none"] as const;

const money = z.coerce.number().min(0).finite();       // 음수 금지(§20)
const dateStr = z.string().min(1).nullable().optional();

const rowSchema = z.object({
  id: z.number().int().positive().optional(),          // 있으면 수정, 없으면 신규
  saleItemId: z.number().int().nullable().optional(),
  saleItemSequence: z.number().int().nullable().optional(),
  quoteId: z.number().int().nullable().optional(),
  sequence: z.number().int().optional(),
  sourceType: z.enum(["sale_import", "manual", "ai_generated"]).optional(),
  costType: z.enum(["individual", "vendor", "internal", "other"]).nullable().optional(),
  performerCategory: z.enum(CATEGORY).optional(),
  individualUserId: z.number().int().nullable().optional(),
  vendorCompanyId: z.number().int().nullable().optional(),
  status: z.enum(STATUS).optional(),
  serviceType: z.string().nullable().optional(),
  productNameSnapshot: z.string().nullable().optional(),
  serviceDetailSnapshot: z.any().nullable().optional(),
  languageOrServiceSnapshot: z.string().nullable().optional(),
  performanceStartDate: dateStr,
  performanceEndDate: dateStr,
  deliveryDate: dateStr,
  expectedPaymentDate: dateStr,
  actualPaymentDate: dateStr,
  memo: z.string().nullable().optional(),
  // 개인 정산 입력
  residencyType: z.enum(RESIDENCY).nullable().optional(),
  serviceCountry: z.string().nullable().optional(),
  serviceLocationType: z.string().nullable().optional(),
  baseFee: money.optional(),
  transportationFee: money.optional(),
  businessTripFee: money.optional(),
  copyrightFee: money.optional(),
  travelDayCompensation: money.optional(),
  cancellationCompensation: money.optional(),
  withholdingTreatment: z.enum(TREATMENT).nullable().optional(),
  withholdingRate: z.coerce.number().min(0).max(100).nullable().optional(),
  taxReviewReason: z.string().nullable().optional(),
  taxTreatyApplicable: z.boolean().optional(),
  overseasEvidenceExists: z.boolean().optional(),
  // 외주 매입 입력
  purchaseEvidenceType: z.enum(EVIDENCE).nullable().optional(),
  purchaseInvoiceDate: dateStr,
  supplyAmount: money.optional(),
  vatAmountManual: money.optional(),                   // 기타·미발행 시 수동 부가세
});

type RowInput = z.infer<typeof rowSchema>;

// 서버 재계산 — performerCategory 에 따라 개인/업체 금액을 산출하고 반대편 필드는 정리(§11·§31)
function computeRowValues(r: RowInput) {
  const category = r.performerCategory ?? "individual";
  if (category === "vendor") {
    const { supply, vat, total } = calcVendorPurchase(
      r.supplyAmount ?? 0, r.purchaseEvidenceType ?? null, r.vatAmountManual ?? 0,
    );
    return {
      performerCategory: "vendor" as const,
      costType: r.costType ?? "vendor",
      // 개인 정산 필드 초기화(잘못된 값이 남지 않도록)
      residencyType: null, serviceCountry: null, serviceLocationType: null,
      baseFee: "0", transportationFee: "0", businessTripFee: "0", copyrightFee: "0",
      travelDayCompensation: "0", cancellationCompensation: "0",
      grossPayment: "0", withholdingTreatment: null, withholdingRate: null,
      withholdingTax: "0", netPayment: "0", taxReviewReason: null,
      taxTreatyApplicable: false, overseasEvidenceExists: false,
      individualUserId: null,
      // 업체 매입
      vendorCompanyId: r.vendorCompanyId ?? null,
      purchaseEvidenceType: r.purchaseEvidenceType ?? null,
      purchaseInvoiceDate: r.purchaseInvoiceDate ?? null,
      supplyAmount: String(supply), vatAmount: String(vat), totalPurchaseAmount: String(total),
    };
  }
  // individual
  const payout = calcIndividualPayout(
    {
      baseFee: r.baseFee, transportationFee: r.transportationFee, businessTripFee: r.businessTripFee,
      copyrightFee: r.copyrightFee, travelDayCompensation: r.travelDayCompensation,
      cancellationCompensation: r.cancellationCompensation,
    },
    r.withholdingTreatment ?? null,
    r.withholdingRate ?? null,
  );
  return {
    performerCategory: "individual" as const,
    costType: r.costType ?? "individual",
    vendorCompanyId: null,
    // 업체 필드 초기화
    purchaseEvidenceType: null, purchaseInvoiceDate: null,
    supplyAmount: "0", vatAmount: "0", totalPurchaseAmount: "0",
    // 개인
    individualUserId: r.individualUserId ?? null,
    residencyType: r.residencyType ?? null,
    serviceCountry: r.serviceCountry ?? null,
    serviceLocationType: r.serviceLocationType ?? null,
    baseFee: String(r.baseFee ?? 0), transportationFee: String(r.transportationFee ?? 0),
    businessTripFee: String(r.businessTripFee ?? 0), copyrightFee: String(r.copyrightFee ?? 0),
    travelDayCompensation: String(r.travelDayCompensation ?? 0),
    cancellationCompensation: String(r.cancellationCompensation ?? 0),
    grossPayment: String(payout.gross),
    withholdingTreatment: r.withholdingTreatment ?? null,
    // 세무확인 필요(미확정)면 세율을 확정값으로 저장하지 않음
    withholdingRate: payout.rateConfirmed ? String(payout.rate) : null,
    withholdingTax: String(payout.withholdingTax),
    netPayment: String(payout.net),
    taxReviewReason: r.taxReviewReason ?? null,
    taxTreatyApplicable: r.taxTreatyApplicable ?? false,
    overseasEvidenceExists: r.overseasEvidenceExists ?? false,
  };
}

// 공통 스칼라 필드(카테고리 무관)
function commonFields(r: RowInput) {
  return {
    // 소스·연결값(sourceType/saleItemId/saleItemSequence/quoteId)은 "제공된 경우만" 반영.
    //   수정 시 클라이언트가 생략하면 기존 연결(소프트링크)을 그대로 보존한다(중복방지 키 유지).
    ...(r.sourceType !== undefined ? { sourceType: r.sourceType } : {}),
    ...(r.saleItemId !== undefined ? { saleItemId: r.saleItemId } : {}),
    ...(r.saleItemSequence !== undefined ? { saleItemSequence: r.saleItemSequence } : {}),
    ...(r.quoteId !== undefined ? { quoteId: r.quoteId } : {}),
    sequence: r.sequence ?? 0,
    status: r.status ?? "unassigned",
    serviceType: r.serviceType ?? null,
    productNameSnapshot: r.productNameSnapshot ?? null,
    serviceDetailSnapshot: r.serviceDetailSnapshot ?? null,
    languageOrServiceSnapshot: r.languageOrServiceSnapshot ?? null,
    performanceStartDate: r.performanceStartDate ?? null,
    performanceEndDate: r.performanceEndDate ?? null,
    deliveryDate: r.deliveryDate ?? null,
    expectedPaymentDate: r.expectedPaymentDate ?? null,
    actualPaymentDate: r.actualPaymentDate ?? null,
    memo: r.memo ?? null,
  };
}

const stripEnc = <T extends { identifierSnapshotEnc?: unknown }>(row: T) => {
  const { identifierSnapshotEnc, ...rest } = row;
  return rest;
};

// ── 판매정보 불러오기 — 현재 견적 상품행을 수행정보로 복사(할인 제외, 금액 미복사, 중복방지) ─────
router.post("/admin/projects/:id/performances/import-from-sale", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  try {
    const [quote] = await db.select().from(quotesTable)
      .where(and(eq(quotesTable.projectId, projectId), eq(quotesTable.isCurrent, true), isNull(quotesTable.deletedAt)));
    if (!quote) { res.status(404).json({ error: "현재 견적을 찾을 수 없습니다." }); return; }

    const items = await db.select().from(quoteItemsTable)
      .where(eq(quoteItemsTable.quoteId, quote.id)).orderBy(quoteItemsTable.id);

    const existing = await db.select().from(performanceAssignmentsTable)
      .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));

    // 중복 기준(§9): 동일 판매항목에 수행정보가 하나라도 있으면 건너뜀.
    //   재저장으로 saleItemId 가 바뀌었을 수 있어 (sequence + 상품명) 스냅샷도 함께 확인.
    const hasByItemId = new Set(existing.map(e => e.saleItemId).filter(v => v != null));
    const hasBySnap = new Set(existing.map(e => `${e.saleItemSequence}::${e.productNameSnapshot ?? ""}`));

    let maxSeq = existing.reduce((m, e) => Math.max(m, e.sequence ?? 0), -1);
    const toInsert: (typeof performanceAssignmentsTable.$inferInsert)[] = [];
    let skipped = 0;

    items.forEach((it, idx) => {
      if (NON_PERFORMABLE_ITEM_TYPES.has(it.itemType ?? "")) return; // 할인·조정 제외(§8)
      if (hasByItemId.has(it.id) || hasBySnap.has(`${idx}::${it.productName ?? ""}`)) { skipped++; return; }
      maxSeq += 1;
      toInsert.push({
        projectId, quoteId: quote.id, saleItemId: it.id, saleItemSequence: idx, sequence: maxSeq,
        sourceType: "sale_import", costType: "individual",   // 생성 출처·비용 유형(원가분석용)
        performerCategory: "individual", status: "unassigned",
        serviceType: it.itemType ?? null,
        productNameSnapshot: it.productName ?? null,
        // 유형별 상세 스냅샷(금액 제외 §8)
        serviceDetailSnapshot: {
          interpretDate: it.interpretDate, interpretPlace: it.interpretPlace, interpretType: it.interpretType,
          interpretDuration: it.interpretDuration, usagePeriod: it.usagePeriod, itemLocation: it.itemLocation,
          eventStartDate: it.eventStartDate, eventEndDate: it.eventEndDate, unit: it.unit, quantity: it.quantity,
        },
        languageOrServiceSnapshot: it.languagePair ?? null,
        performanceStartDate: it.interpretDate ?? it.eventStartDate ?? null,
        performanceEndDate: it.eventEndDate ?? null,
        createdBy: req.user?.id ?? null,
        updatedBy: req.user?.id ?? null,
      });
    });

    let created: typeof performanceAssignmentsTable.$inferSelect[] = [];
    if (toInsert.length) {
      created = await db.insert(performanceAssignmentsTable).values(toInsert).returning();
    }
    res.json({
      created: created.length,
      skipped,
      message: `신규 수행정보 ${created.length}건을 추가했습니다.` +
        (skipped ? ` 이미 연결된 판매항목 ${skipped}건은 제외했습니다.` : ""),
      rows: created.map(stripEnc),
    });
  } catch (err) {
    req.log.error({ err }, "수행정보 불러오기 실패");
    res.status(500).json({ error: "판매정보 불러오기에 실패했습니다." });
  }
});

// ── 배치 저장 — 신규/수정 + 삭제를 하나의 트랜잭션으로 처리(§30). 금액 서버 재계산(§31). ───────
const batchSchema = z.object({
  rows: z.array(rowSchema).default([]),
  deletedIds: z.array(z.number().int().positive()).default([]),
});

router.put("/admin/projects/:id/performances", ...adminGuard, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) { res.status(400).json({ error: "잘못된 프로젝트 ID" }); return; }
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "유효성 검증 실패", detail: parsed.error.flatten() }); return; }
  const { rows, deletedIds } = parsed.data;
  const userId = req.user?.id ?? null;

  try {
    await db.transaction(async (tx) => {
      // 1) 삭제 — 지급완료(paid) 행은 차단(§29). 소유 프로젝트 검증.
      if (deletedIds.length) {
        const targets = await tx.select().from(performanceAssignmentsTable)
          .where(and(eq(performanceAssignmentsTable.projectId, projectId), inArray(performanceAssignmentsTable.id, deletedIds)));
        const paid = targets.filter(t => t.status === "paid");
        if (paid.length) throw new Error(`지급완료된 수행정보는 삭제할 수 없습니다 (id: ${paid.map(p => p.id).join(", ")}).`);
        await tx.update(performanceAssignmentsTable)
          .set({ deletedAt: new Date(), deletedBy: userId, updatedBy: userId, updatedAt: new Date() })
          .where(and(eq(performanceAssignmentsTable.projectId, projectId), inArray(performanceAssignmentsTable.id, deletedIds)));
      }
      // 2) upsert
      for (const r of rows) {
        const values = { ...commonFields(r), ...computeRowValues(r), updatedBy: userId, updatedAt: new Date() };
        if (r.id) {
          await tx.update(performanceAssignmentsTable).set(values)
            .where(and(eq(performanceAssignmentsTable.id, r.id), eq(performanceAssignmentsTable.projectId, projectId)));
        } else {
          await tx.insert(performanceAssignmentsTable).values({ projectId, createdBy: userId, ...values });
        }
      }
    });

    const rowsOut = await db.select().from(performanceAssignmentsTable)
      .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)))
      .orderBy(performanceAssignmentsTable.sequence, performanceAssignmentsTable.id);
    res.json({ ok: true, rows: rowsOut.map(stripEnc) });
  } catch (err: any) {
    req.log.error({ err }, "수행정보 저장 실패");
    res.status(400).json({ error: err?.message ?? "수행정보 저장에 실패했습니다." });
  }
});

// ── 행 복제 — 업무정보 유지, 수행자·금액·지급일·세무결과 초기화(status=unassigned §28) ────────
router.post("/admin/performances/:id/duplicate", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "잘못된 ID" }); return; }
  try {
    const [src] = await db.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, id));
    if (!src || src.deletedAt) { res.status(404).json({ error: "원본 수행정보를 찾을 수 없습니다." }); return; }
    const userId = req.user?.id ?? null;
    const [dup] = await db.insert(performanceAssignmentsTable).values({
      projectId: src.projectId, quoteId: src.quoteId, saleItemId: src.saleItemId,
      saleItemSequence: src.saleItemSequence, sequence: (src.sequence ?? 0) + 1,
      sourceType: src.sourceType, costType: src.costType,   // 출처·비용유형 계승
      // 업무정보 유지
      performerCategory: src.performerCategory, serviceType: src.serviceType,
      productNameSnapshot: src.productNameSnapshot, serviceDetailSnapshot: src.serviceDetailSnapshot,
      languageOrServiceSnapshot: src.languageOrServiceSnapshot,
      performanceStartDate: src.performanceStartDate, performanceEndDate: src.performanceEndDate,
      deliveryDate: src.deliveryDate,
      // 초기화(§28)
      status: "unassigned",
      individualUserId: null, vendorCompanyId: null,
      performerNameSnapshot: null, identifierSnapshotEnc: null, identifierSnapshotMasked: null,
      nationalitySnapshot: null, residenceCountrySnapshot: null, vendorTypeSnapshot: null,
      expectedPaymentDate: null, actualPaymentDate: null,
      createdBy: userId, updatedBy: userId,
    }).returning();
    res.json({ ok: true, row: stripEnc(dup) });
  } catch (err) {
    req.log.error({ err }, "수행정보 복제 실패");
    res.status(500).json({ error: "수행정보 복제에 실패했습니다." });
  }
});

// ── 행 삭제(soft) — 지급완료는 차단(§29) ───────────────────────────────────────────────────
router.delete("/admin/performances/:id", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "잘못된 ID" }); return; }
  try {
    const [row] = await db.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, id));
    if (!row || row.deletedAt) { res.status(404).json({ error: "수행정보를 찾을 수 없습니다." }); return; }
    if (row.status === "paid") { res.status(400).json({ error: "지급완료된 수행정보는 삭제할 수 없습니다." }); return; }
    await db.update(performanceAssignmentsTable)
      .set({ deletedAt: new Date(), deletedBy: req.user?.id ?? null, updatedBy: req.user?.id ?? null, updatedAt: new Date() })
      .where(eq(performanceAssignmentsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "수행정보 삭제 실패");
    res.status(500).json({ error: "수행정보 삭제에 실패했습니다." });
  }
});

// ── 개인 통번역사 선택 — CRM(users+profile+sensitive)에서 스냅샷을 동결하고 세무 기본값을 설정 ─────
//   · 식별번호는 translator_sensitive 의 암호문을 그대로 스냅샷(identifierSnapshotEnc)하고,
//     화면 표시는 마스킹값만 저장(§13·§36). 응답에도 암호문은 제외.
//   · 거주구분/원천징수 처리구분은 paymentMethod 로 "추정 기본값"만 설정 — 해외/비거주는
//     자동 0% 확정 금지, tax_review_required(세무확인 필요)로 둔다(§17·§19·§40).
const selectIndividualSchema = z.object({ translatorId: z.number().int().positive() });

router.post("/admin/performances/:id/select-individual", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "잘못된 ID" }); return; }
  const parsed = selectIndividualSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "translatorId 가 필요합니다." }); return; }
  const { translatorId } = parsed.data;
  try {
    const [row] = await db.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, id));
    if (!row || row.deletedAt) { res.status(404).json({ error: "수행정보를 찾을 수 없습니다." }); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, translatorId));
    if (!user) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }
    const [sensitive] = await db.select().from(translatorSensitiveTable).where(eq(translatorSensitiveTable.translatorId, translatorId));

    // 식별번호 스냅샷: 암호문 그대로 보존 + 마스킹값 생성(복호화 실패 시 마스킹 생략)
    let identifierEnc: string | null = null;
    let identifierMasked: string | null = null;
    if (sensitive?.residentNumber) {
      identifierEnc = sensitive.residentNumber; // 이미 AES 암호문
      try { identifierMasked = maskResidentNumber(decrypt(sensitive.residentNumber)); } catch { identifierMasked = null; }
    }

    // paymentMethod → 거주구분/원천징수 처리구분 추정 기본값
    const pm = sensitive?.paymentMethod ?? null;
    let residencyType: string | null = null;
    let withholdingTreatment: string = "tax_review_required";
    if (pm === "domestic_withholding") { residencyType = "domestic_resident"; withholdingTreatment = "domestic_3_3"; }
    else if (pm === "domestic_business") { residencyType = "domestic_resident"; withholdingTreatment = "tax_review_required"; }
    else if (pm === "overseas_paypal" || pm === "overseas_bank") { residencyType = "overseas_or_nonresident"; withholdingTreatment = "tax_review_required"; }

    const [updated] = await db.update(performanceAssignmentsTable).set({
      performerCategory: "individual",
      costType: "individual",
      individualUserId: translatorId,
      vendorCompanyId: null,
      performerNameSnapshot: user.name ?? user.email ?? null,
      identifierSnapshotEnc: identifierEnc,
      identifierSnapshotMasked: identifierMasked,
      residenceCountrySnapshot: sensitive?.country ?? null,
      // 국적은 CRM 에 명시 컬럼이 없어 사용자가 확인·입력(자동 확정 금지 §17)
      residencyType: (residencyType as any),
      withholdingTreatment: (withholdingTreatment as any),
      updatedBy: req.user?.id ?? null,
      updatedAt: new Date(),
    }).where(eq(performanceAssignmentsTable.id, id)).returning();

    res.json({ ok: true, row: stripEnc(updated) });
  } catch (err) {
    req.log.error({ err }, "개인 통번역사 선택 실패");
    res.status(500).json({ error: "통번역사 선택에 실패했습니다." });
  }
});

// ── 외주업체 선택 — 거래처(companyType='vendor') 스냅샷 동결(§14·§6) ──────────────────────────
//   상호·사업자등록번호·업체유형을 동결. 사업자번호는 민감 PII(주민번호)와 달리 마스킹표시 필드에 저장.
const selectVendorSchema = z.object({ companyId: z.number().int().positive() });

router.post("/admin/performances/:id/select-vendor", ...adminGuard, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "잘못된 ID" }); return; }
  const parsed = selectVendorSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "companyId 가 필요합니다." }); return; }
  const { companyId } = parsed.data;
  try {
    const [row] = await db.select().from(performanceAssignmentsTable).where(eq(performanceAssignmentsTable.id, id));
    if (!row || row.deletedAt) { res.status(404).json({ error: "수행정보를 찾을 수 없습니다." }); return; }
    const [company] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
    if (!company) { res.status(404).json({ error: "업체를 찾을 수 없습니다." }); return; }
    if (company.companyType !== "vendor") { res.status(400).json({ error: "외주업체(vendor)만 선택할 수 있습니다." }); return; }

    const [updated] = await db.update(performanceAssignmentsTable).set({
      performerCategory: "vendor",
      costType: "vendor",
      vendorCompanyId: companyId,
      individualUserId: null,
      performerNameSnapshot: company.name ?? null,
      identifierSnapshotEnc: null,                              // 개인 식별자 없음
      identifierSnapshotMasked: company.businessNumber ?? null, // 사업자등록번호(표시)
      vendorTypeSnapshot: company.vendorType ?? null,
      // 개인 세무 필드 정리(§11)
      residencyType: null, withholdingTreatment: null, withholdingRate: null,
      updatedBy: req.user?.id ?? null,
      updatedAt: new Date(),
    }).where(eq(performanceAssignmentsTable.id, id)).returning();

    res.json({ ok: true, row: stripEnc(updated) });
  } catch (err) {
    req.log.error({ err }, "외주업체 선택 실패");
    res.status(500).json({ error: "업체 선택에 실패했습니다." });
  }
});

export default router;
