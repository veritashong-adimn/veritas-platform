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
  db, performanceAssignmentsTable, performanceExpensesTable, performanceDeductionsTable,
  quotesTable, quoteItemsTable, quoteItemFilesTable, productsTable, holidaysTable, projectsTable,
  translatorSensitiveTable, translatorProfilesTable, usersTable, companiesTable,
  calcIndividualPayout, calcVendorPurchase,
  calcBasePerformanceFee, calcCostTotal, calcPaymentDate,
} from "@workspace/db";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getPermissionsForRole } from "../lib/rbac";
import { decrypt, maskResidentNumber } from "../lib/encrypt";
import { autoAssignByPaymentDate } from "./payoutRounds";

// 납품확인 권한(§9) — 관리자(super) OR 프로젝트 담당(admin_id) OR project.update 권한 보유자.
async function canConfirmDelivery(user: { id: number; role?: string; roleId?: number | null } | undefined, projectAdminId: number | null): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin" && !user.roleId) return true;      // super-admin
  if (projectAdminId != null && projectAdminId === user.id) return true; // 담당 PM
  if (user.roleId) {
    try { return (await getPermissionsForRole(user.roleId)).has("project.update"); } catch { return false; }
  }
  return false;
}

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];

// ── 공휴일 조회 헬퍼 — 지급일 "직전 영업일" 판정용(§4·§6). 활성 KR 공휴일 날짜 집합. ─────────
async function loadKrHolidaySet(): Promise<Set<string>> {
  const rows = await db.select({ d: holidaysTable.holidayDate })
    .from(holidaysTable)
    .where(and(eq(holidaysTable.countryCode, "KR"), eq(holidaysTable.active, true)));
  return new Set(rows.map(r => String(r.d).slice(0, 10)));
}

// 프론트 미리보기용 — 활성 KR 공휴일 날짜·명칭 목록(§6·§7). 하드코딩 대신 서버 단일 출처.
router.get("/admin/holidays", ...adminGuard, async (req, res) => {
  try {
    const yearParam = req.query.year != null ? Number(req.query.year) : null;
    const rows = await db.select().from(holidaysTable)
      .where(and(eq(holidaysTable.countryCode, "KR"), eq(holidaysTable.active, true)))
      .orderBy(holidaysTable.holidayDate);
    const filtered = yearParam && Number.isInteger(yearParam) ? rows.filter(r => r.year === yearParam) : rows;
    res.json({
      dates: filtered.map(r => String(r.holidayDate).slice(0, 10)),
      holidays: filtered.map(r => ({ date: String(r.holidayDate).slice(0, 10), name: r.holidayName, type: r.holidayType })),
    });
  } catch (err) {
    req.log.error({ err }, "공휴일 조회 실패");
    res.status(500).json({ error: "공휴일 조회에 실패했습니다." });
  }
});

// 판매정보 불러오기에서 수행자 배정이 필요 없는 항목(할인·조정)은 제외
const NON_PERFORMABLE_ITEM_TYPES = new Set(["discount"]);

// ── 판매상품 유형 → 수행정보 구분 자동분류 ────────────────────────────────────
//  · 상품유형·canonicalKey 우선, 상품명은 최후. 미인식은 안전한 '경비'(개인 강제 금지).
//  · 초기 구분값 결정 전용 — 이후 사용자가 변경한 값은 재불러오기로 덮어쓰지 않는다(중복방지).
type PerfClass = {
  category: "individual" | "vendor" | "expense";
  lineCategory: string;
  costType: "individual" | "vendor" | "other";
};
function classifyToken(raw?: string | null): PerfClass | null {
  const t = (raw ?? "").toLowerCase();
  if (!t) return null;
  // 개인 (통역·번역·감수·교정·전사·자막번역) — 지급대상=개인 통번역사
  if (/interpret|통역/.test(t)) return { category: "individual", lineCategory: "통번역사", costType: "individual" };
  if (/translat|번역/.test(t)) return { category: "individual", lineCategory: "통번역사", costType: "individual" };
  if (/proofread|review|감수|교정|검수/.test(t)) return { category: "individual", lineCategory: "통번역사", costType: "individual" };
  if (/transcri|전사|받아쓰기|subtitle|자막번역/.test(t)) return { category: "individual", lineCategory: "통번역사", costType: "individual" };
  // 외주업체 (장비·렌탈·음향기기·DTP·미디어·영상) — 지급대상=업체(공급가+VAT)
  //  · §5 필수 판별: FM장비/장비/렌탈/음향/수신기/송신기/부스/헤드셋/마이크 등은 반드시 외주업체.
  if (/equip|rental|장비|렌탈|렌털|음향|수신기|송신기|부스|헤드셋|헤드폰|이어폰|마이크|스피커|앰프/.test(t))
    return { category: "vendor", lineCategory: "장비업체", costType: "vendor" };
  if (/\bdtp\b|dtp|조판|편집/.test(t)) return { category: "vendor", lineCategory: "DTP업체", costType: "vendor" };
  if (/media|미디어|영상|자막|녹음|더빙|recording|external_service|vendor_service/.test(t))
    return { category: "vendor", lineCategory: "미디어업체", costType: "vendor" };
  // 경비 (운영실비·교통·출장·숙박·식비·배송·기타) — 지급대상 없는 직접원가
  if (/operat|운영|실비/.test(t)) return { category: "expense", lineCategory: "경비", costType: "other" };
  if (/travel|transport|교통|출장/.test(t)) return { category: "expense", lineCategory: "경비", costType: "other" };
  if (/accommodation|lodging|숙박/.test(t)) return { category: "expense", lineCategory: "경비", costType: "other" };
  if (/meal|식비/.test(t)) return { category: "expense", lineCategory: "경비", costType: "other" };
  if (/delivery|배송|우편|택배/.test(t)) return { category: "expense", lineCategory: "경비", costType: "other" };
  if (/expense|경비|기타비용|잡비/.test(t)) return { category: "expense", lineCategory: "경비", costType: "other" };
  return null;
}
function classifyPerformer(o: {
  itemType?: string | null; canonicalKey?: string | null; productType?: string | null;
  subCategory?: string | null; productName?: string | null;
}): PerfClass {
  return classifyToken(o.canonicalKey)   // 상품 유형값·식별키 우선
    ?? classifyToken(o.productType)
    ?? classifyToken(o.subCategory)
    ?? classifyToken(o.itemType)
    ?? classifyToken(o.productName)       // 상품명은 최후
    ?? { category: "expense", lineCategory: "경비", costType: "other" }; // 미인식 → 안전한 경비
}

// performerCategory → payeeType(정산관리 소프트링크 §18)
function payeeTypeOf(category: "individual" | "vendor" | "expense"): string {
  return category === "vendor" ? "vendor" : category === "expense" ? "none" : "individual";
}

// §8·§9 기존 행 자동 교정 대상 판정 — "판매불러오기로 생성됐고 아직 사용자가 손대지 않은" 행만.
//   수행자·업체 미지정 / 원가 0 / 미정산 / 미지급 / 지급회차·명세서 없음 / 실지급 없음.
//   하나라도 진행되었으면 사용자 확정값으로 보고 자동 교정하지 않는다(§8·§10).
function isCorrectableRow(e: typeof performanceAssignmentsTable.$inferSelect): boolean {
  return (
    e.sourceType === "sale_import" &&
    e.individualUserId == null &&
    e.vendorCompanyId == null &&
    (e.performerNameSnapshot == null || e.performerNameSnapshot === "") &&
    Number(e.costTotal ?? 0) === 0 &&
    (e.paymentStatus ?? "unpaid") === "unpaid" &&
    (e.payStatementStatus ?? "not_created") === "not_created" &&
    e.payoutRoundId == null &&
    e.payStatementId == null &&
    Number(e.actualPaymentAmount ?? 0) === 0 &&
    e.status === "unassigned"
  );
}

// 번역 상세 memo 파싱(§6) — 판매 저장 규약과 동일 형식:
//   "[사용자메모] / 파일: … | 형식: … | 단어수: … | 글자수: …" (프론트 parseMemoInfo와 동일 기준).
//   ' / '·' | ' 로 분리 후 "키: 값" 추출. 형식이 다르거나 값이 누락돼도 안전(키 미존재 → 해당 필드 없음).
function parseTranslationMemo(memo: string | null | undefined): { fileName?: string; fileFormat?: string; wordCount?: string; charCount?: string } {
  const out: { fileName?: string; fileFormat?: string; wordCount?: string; charCount?: string } = {};
  if (!memo) return out;
  const KEY_MAP: Record<string, keyof typeof out> = { "파일": "fileName", "형식": "fileFormat", "단어수": "wordCount", "글자수": "charCount" };
  for (const seg of memo.split(" / ")) {
    for (const p of seg.split(" | ")) {
      const ci = p.indexOf(": ");
      if (ci > 0) {
        const field = KEY_MAP[p.slice(0, ci).trim()];
        const v = p.slice(ci + 2).trim();
        if (field && v) out[field] = v;
      }
    }
  }
  return out;
}

// ── 판매항목 → 서비스별 상세 스냅샷(§3·§6·§10) ────────────────────────────────
//  · 서비스 유형별로 필요한 실제 판매 상세값 + 판매 참조값(단위·수량·단가)을 함께 동결.
//  · 계약단가는 절대 복사하지 않는다(§10) — saleUnitPrice 는 "참고값"으로만 보관.
//  · 번역 상세(파일명·형식·단어수·글자수)는 판매 memo 인코딩값을 파싱해 스냅샷으로 승격 저장(§6).
//    파일명 우선순위: 직접입력(memo) → 첨부파일명(fileName 인자) → null. 새 DB 컬럼 없이 JSON만 확장.
function buildDetailSnapshot(it: typeof quoteItemsTable.$inferSelect, prod: any, fileName: string | null) {
  const mem = parseTranslationMemo(it.memo);
  // 페이지수 — 판매가 페이지 기준일 때 quantity 가 곧 페이지수(단어/글자→페이지 자동환산 결과). 그 외 null.
  const pageCount = it.unit === "페이지" && it.quantity != null ? String(it.quantity) : null;
  return {
    itemType: it.itemType ?? null,
    canonicalKey: prod?.canonicalKey ?? null,
    productType: prod?.productType ?? null,
    languagePair: it.languagePair ?? null,
    // 판매 참조값(§10) — 표시 전용, 계약단가 자동복사 금지
    saleUnit: it.unit ?? null,
    saleQuantity: it.quantity != null ? String(it.quantity) : null,
    saleUnitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
    saleSupplyAmount: it.supplyAmount != null ? String(it.supplyAmount) : null,
    // 통역 상세(§5)
    interpretDate: it.interpretDate ?? null,
    interpretPlace: it.interpretPlace ?? null,
    interpretType: it.interpretType ?? null,
    interpretDuration: it.interpretDuration ?? null,
    interpreterCount: it.interpreterCount ?? null,
    operationHours: it.operationHours ?? null,
    interpretationDirection: it.interpretationDirection ?? null,
    // 장비·기간 상세(§8)
    eventStartDate: it.eventStartDate ?? null,
    eventEndDate: it.eventEndDate ?? null,
    usagePeriod: it.usagePeriod ?? null,
    itemLocation: it.itemLocation ?? null,
    hasEquipment: it.hasEquipment ?? null,
    quantityUnit: it.quantityUnit ?? null,
    // 번역·DTP·감수 파일·상세(§6·§9) — 직접입력 파일명(1순위) → 첨부파일명(2순위) → null(3순위)
    fileName: mem.fileName || fileName || null,
    fileFormat: mem.fileFormat ?? null,
    wordCount: mem.wordCount ?? null,
    charCount: mem.charCount ?? null,
    pageCount,
  };
}

// 번역 계열 판별(§작업량통일) — web-app svcKind 'translation' 미러(번역·감수·교정·DTP·영상/자막).
//   번역 수행원가는 페이지수가 아닌 작업량(단어/글자) 기준으로 계산하므로, 그 대상 행을 이 술어로 판정한다.
function isTranslationSnap(snap: any, serviceType?: string | null): boolean {
  const t = String(serviceType || snap?.itemType || "").toLowerCase();
  const ck = String(snap?.canonicalKey || "").toLowerCase();
  const pt = String(snap?.productType || "").toLowerCase();
  return /translat|번역|proofread|감수|교정|dtp|media|영상|미디어|subtitle|자막/.test(t)
    || ck.startsWith("tr:") || ck.startsWith("dt:") || /translat/.test(pt);
}

// 통역 계열 판별(§계약단가통일) — web-app svcKind 'interpretation' 미러.
//   통역 수행원가 = 계약단가(1인·1일) × 수행일수(quantity) × 인원(interpreterCount).
function isInterpretationSnap(snap: any, serviceType?: string | null): boolean {
  const t = String(serviceType || snap?.itemType || "").toLowerCase();
  const ck = String(snap?.canonicalKey || "").toLowerCase();
  const pt = String(snap?.productType || "").toLowerCase();
  return /interpret|통역/.test(t) || ck.startsWith("in:") || ck.startsWith("co:") || /interpret/.test(pt);
}

// 통역 수행인원 — 미지정 시 1명.
function interpreterHeadcount(snap: any): number {
  const n = Number(snap?.interpreterCount);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// 장비 계열 판별(§계약단가통일) — web-app isEquipmentKind 미러(classifyPerformer 장비 토큰과 동일).
//   장비는 외주(vendor)지만 공급가액을 계약단가 × 수량으로 산정한다(부가세는 그 공급가액 기준으로 별도 계산 — 불변).
function isEquipmentSnap(snap: any, serviceType?: string | null): boolean {
  const t = String(serviceType || snap?.itemType || "").toLowerCase();
  const ck = String(snap?.canonicalKey || "").toLowerCase();
  const pt = String(snap?.productType || "").toLowerCase();
  return /equip|장비|rental|렌탈|렌털|음향|수신기|송신기|부스|헤드셋|헤드폰|이어폰|마이크|스피커|앰프/.test(t)
    || ck.startsWith("eq:") || /equip/.test(pt);
}

// 번역 원가·정산 작업량(§작업량통일) — wordCount 우선, 없으면 charCount, 둘 다 없으면 null(계산 불가).
//   페이지수(pageCount·판매 quantity)는 번역 원가에 사용하지 않는다(판매정보 참고값으로만 유지).
function translationWorkAmount(snap: any): number | null {
  if (!snap) return null;
  const w = Number(snap.wordCount);
  if (Number.isFinite(w) && w > 0) return w;
  const c = Number(snap.charCount);
  if (Number.isFinite(c) && c > 0) return c;
  return null;
}

// 판매항목 → 수행정보 초기 기간·수량·단위·납품일(§10·§12). 계약단가는 복사하지 않는다.
function initialFieldsFromSale(it: typeof quoteItemsTable.$inferSelect) {
  const start = it.interpretDate ?? it.eventStartDate ?? null;
  const end = it.eventEndDate ?? null;
  const isPeriodBased = !!(it.interpretDate || it.eventStartDate || it.eventEndDate); // 통역·장비
  // §12: 기간형(통역·장비)은 종료일을 납품일 기본값으로. 번역 등 비기간형은 임의 생성 금지(null 유지).
  const deliveryDate = isPeriodBased ? (end ?? start ?? null) : null;
  return {
    performanceStartDate: start,
    performanceEndDate: end,
    // 납품일 자동값 = 서비스 종료일(§2). 자동 생성 직후 미확인(§6).
    deliveryDate,
    deliveryDateAuto: deliveryDate,
    deliveryDateManual: false,
    deliveryConfirmed: false,
    deliveryConfirmedBy: null,
    deliveryConfirmedAt: null,
    quantity: it.quantity != null ? String(it.quantity) : null,
    unit: it.unit ?? null,
  };
}

const CATEGORY = ["individual", "vendor", "expense"] as const;
const STATUS = ["unassigned", "assigned", "in_progress", "completed", "payout_pending", "paid", "cancelled"] as const;
const RESIDENCY = ["domestic_resident", "overseas_or_nonresident"] as const;
const TREATMENT = ["domestic_3_3", "exempt", "nonresident_custom", "treaty_reduction_or_exemption", "tax_review_required"] as const;
const EVIDENCE = ["tax_invoice", "invoice", "zero_rate_tax_invoice", "other", "none"] as const;
const PAYMENT_STATUS = ["unpaid", "payment_hold", "paid"] as const;

const money = z.coerce.number().min(0).finite();       // 음수 금지(§20)
const dateStr = z.string().min(1).nullable().optional();

// 추가비용 다건(§10) — includedInPayout=true 건만 원가합계 반영
const expenseSchema = z.object({
  id: z.number().int().positive().optional(),
  expenseType: z.string().min(1),
  amount: money.default(0),
  incurredDate: dateStr,
  includedInPayout: z.boolean().optional(),
  evidenceUrl: z.string().nullable().optional(),
  evidenceFileName: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
});
// 차감 다건(§10)
const deductionSchema = z.object({
  id: z.number().int().positive().optional(),
  deductionType: z.string().min(1),
  amount: money.default(0),
  reason: z.string().nullable().optional(),
});

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
  lineCategory: z.string().nullable().optional(),        // 세부 구분 라벨(§5-3)
  performerNameSnapshot: z.string().nullable().optional(), // 인라인 선택·직접입력 지급대상명
  serviceType: z.string().nullable().optional(),
  productNameSnapshot: z.string().nullable().optional(),
  serviceDetailSnapshot: z.any().nullable().optional(),
  languageOrServiceSnapshot: z.string().nullable().optional(),
  performanceStartDate: dateStr,
  performanceEndDate: dateStr,
  deliveryDate: dateStr,
  deliveryDateManual: z.boolean().optional(),        // 납품일 수동 지정 여부
  deliveryConfirmed: z.boolean().optional(),         // 담당 PM 납품확인(권한 서버검증)
  expectedPaymentDate: dateStr,
  actualPaymentDate: dateStr,
  memo: z.string().nullable().optional(),
  remark: z.string().nullable().optional(),   // 비고 — 사용자 자유입력 운영 메모(계산 미반영)
  // 계약단가·수량·직접금액(§7·§9)
  contractUnitPrice: money.nullable().optional(),
  quantity: z.coerce.number().min(0).finite().nullable().optional(),
  unit: z.string().nullable().optional(),
  isDirectAmount: z.boolean().optional(),
  directAmount: money.nullable().optional(),             // 직접금액 입력(경비 등) → 기본수행료
  // 지급예정일 수동변경(§8-2)
  payDateManual: z.boolean().optional(),
  payDateChangeReason: z.string().nullable().optional(),
  // 지급 상태(§12) — 상태는 지급상태로 단일화(정산상태·지급명세서 상태 제거, 지급명세서는 향후 지급관리 모듈)
  paymentStatus: z.enum(PAYMENT_STATUS).optional(),
  actualPaymentAmount: money.nullable().optional(),
  // 추가비용·차감 다건(§10) — 제공 시 전체 교체, 생략 시 기존 유지
  expenses: z.array(expenseSchema).optional(),
  deductions: z.array(deductionSchema).optional(),
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

// 서버 재계산 — performerCategory 에 따라 개인/업체/경비 금액을 산출하고 반대편 필드는 정리(§11·§31)
function computeRowValues(r: RowInput) {
  const category = r.performerCategory ?? "individual";
  if (category === "expense") {
    // 경비 — 지급대상자 없는 직접원가. 개인/업체 정산필드는 모두 초기화.
    return {
      performerCategory: "expense" as const,
      costType: r.costType ?? "other",
      payeeType: "none",
      individualUserId: null, vendorCompanyId: null,
      residencyType: null, serviceCountry: null, serviceLocationType: null,
      baseFee: "0", transportationFee: "0", businessTripFee: "0", copyrightFee: "0",
      travelDayCompensation: "0", cancellationCompensation: "0",
      grossPayment: "0", withholdingTreatment: null, withholdingRate: null,
      withholdingTax: "0", netPayment: "0", taxReviewReason: null,
      taxTreatyApplicable: false, overseasEvidenceExists: false,
      purchaseEvidenceType: null, purchaseInvoiceDate: null,
      supplyAmount: "0", vatAmount: "0", totalPurchaseAmount: "0",
    };
  }
  if (category === "vendor") {
    // 장비(§계약단가통일): 공급가액 = 계약단가 × 수량. 계약단가가 없으면 입력 공급가액 사용(폴백).
    //   그 외 업체(DTP·미디어)는 기존대로 입력 공급가액. 부가세는 산정된 공급가액 기준으로 동일하게 계산(불변).
    const snap = (r.serviceDetailSnapshot ?? {}) as any;
    const supplyInput = (isEquipmentSnap(snap, r.serviceType) && r.contractUnitPrice != null && r.quantity != null)
      ? Number(r.contractUnitPrice) * Number(r.quantity)
      : (r.supplyAmount ?? 0);
    // §1 외주 세금처리 → 매입증빙유형 자동 연동 (팝업 이중입력 제거).
    //   · 세금처리=세금계산서(tax_review_required, 외주 기본값) → tax_invoice (VAT 10% 대상)
    //   · 팝업에서 회계 세분류(계산서·영세율·기타·미발행)를 직접 지정한 경우는 그 값을 존중
    //     — 세금처리 드롭다운엔 없는 값이므로 덮어쓰지 않는다.
    //   · 그 외 세금처리(3.3%·원천징수 예외 등)는 증빙유형을 자동 지정하지 않고 기존 값 유지.
    const vendorTreatment = r.withholdingTreatment ?? "tax_review_required";
    const clientEvidence = r.purchaseEvidenceType ?? null;
    const linkedEvidence =
      (clientEvidence && clientEvidence !== "tax_invoice")
        ? clientEvidence
        : (vendorTreatment === "tax_review_required" ? "tax_invoice" : clientEvidence);
    const { supply, vat, total } = calcVendorPurchase(
      supplyInput, linkedEvidence, r.vatAmountManual ?? 0,
    );
    return {
      performerCategory: "vendor" as const,
      costType: r.costType ?? "vendor",
      payeeType: "vendor",
      // 개인 정산 필드 초기화(잘못된 값이 남지 않도록)
      residencyType: null, serviceCountry: null, serviceLocationType: null,
      baseFee: "0", transportationFee: "0", businessTripFee: "0", copyrightFee: "0",
      travelDayCompensation: "0", cancellationCompensation: "0",
      grossPayment: "0",
      // 방안 A: 세금처리는 외주업체 '기록용' — 값은 저장하되 원천세는 미적용(지급액 계산 불변). 기본값 세금계산서(tax_review_required).
      withholdingTreatment: r.withholdingTreatment ?? "tax_review_required", withholdingRate: null,
      withholdingTax: "0", netPayment: "0", taxReviewReason: null,
      taxTreatyApplicable: false, overseasEvidenceExists: false,
      individualUserId: null,
      // 업체 매입
      vendorCompanyId: r.vendorCompanyId ?? null,
      purchaseEvidenceType: linkedEvidence,           // §1 세금처리에서 자동 연동된 증빙유형 저장
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
    payeeType: "individual",
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
    // 수행자·업체명 스냅샷 — 인라인 선택(신규행 로컬 set)·경비 직접입력 시 클라이언트 값을 영속.
    //   ※ select-individual/select-vendor 로 서버가 설정한 값과 동일하게 라운드트립(회귀 없음).
    performerNameSnapshot: r.performerNameSnapshot ?? null,
    serviceType: r.serviceType ?? null,
    productNameSnapshot: r.productNameSnapshot ?? null,
    // 서비스별 상세 스냅샷 — 제공된 경우만 반영, 생략 시 기존값 보존(저장 시 유실 방지 §16)
    ...(r.serviceDetailSnapshot !== undefined ? { serviceDetailSnapshot: r.serviceDetailSnapshot } : {}),
    languageOrServiceSnapshot: r.languageOrServiceSnapshot ?? null,
    performanceStartDate: r.performanceStartDate ?? null,
    performanceEndDate: r.performanceEndDate ?? null,
    deliveryDate: r.deliveryDate ?? null,
    expectedPaymentDate: r.expectedPaymentDate ?? null,
    actualPaymentDate: r.actualPaymentDate ?? null,
    memo: r.memo ?? null,
    remark: r.remark ?? null,
  };
}

const stripEnc = <T extends { identifierSnapshotEnc?: unknown }>(row: T) => {
  const { identifierSnapshotEnc, ...rest } = row;
  return rest;
};

// 프로젝트 수행정보 행 + 추가비용·차감 하위행을 함께 로드(암호문 제외). 저장 응답·상세 조회 공용.
export async function loadPerformanceRows(projectId: number) {
  const rows = await db.select().from(performanceAssignmentsTable)
    .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)))
    .orderBy(performanceAssignmentsTable.sequence, performanceAssignmentsTable.id);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const [expenses, deductions] = await Promise.all([
    db.select().from(performanceExpensesTable).where(inArray(performanceExpensesTable.assignmentId, ids)).orderBy(performanceExpensesTable.id),
    db.select().from(performanceDeductionsTable).where(inArray(performanceDeductionsTable.assignmentId, ids)).orderBy(performanceDeductionsTable.id),
  ]);
  const expByRow = new Map<number, typeof expenses>();
  for (const e of expenses) { (expByRow.get(e.assignmentId) ?? expByRow.set(e.assignmentId, []).get(e.assignmentId)!).push(e); }
  const dedByRow = new Map<number, typeof deductions>();
  for (const d of deductions) { (dedByRow.get(d.assignmentId) ?? dedByRow.set(d.assignmentId, []).get(d.assignmentId)!).push(d); }
  return rows.map(r => ({ ...stripEnc(r), expenses: expByRow.get(r.id) ?? [], deductions: dedByRow.get(r.id) ?? [] }));
}

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

    // 지급일 즉시 자동계산(§10) — 납품일 생성 시 직전 영업일 조정된 지급예정일도 함께 채운다.
    const importHolidaySet = await loadKrHolidaySet();
    const importIsHoliday = (d: string) => importHolidaySet.has(d);

    // 구분 자동분류용 상품 메타(상품유형·canonicalKey) 조회
    const productIds = Array.from(new Set(items.map(it => it.productId).filter((v): v is number => v != null)));
    const products = productIds.length
      ? await db.select().from(productsTable).where(inArray(productsTable.id, productIds))
      : [];
    const prodMap = new Map(products.map(p => [p.id, p]));

    // 번역·DTP 첨부파일명 조회(§6) — 판매항목 ID 기준, 항목당 첫 파일명 사용.
    const itemIds = items.map(it => it.id);
    const files = itemIds.length
      ? await db.select().from(quoteItemFilesTable).where(inArray(quoteItemFilesTable.quoteItemId, itemIds)).orderBy(quoteItemFilesTable.id)
      : [];
    const fileByItem = new Map<number, string>();
    for (const f of files) { if (!fileByItem.has(f.quoteItemId)) fileByItem.set(f.quoteItemId, f.fileName); }

    const existing = await db.select().from(performanceAssignmentsTable)
      .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));

    // 동일 판매항목에 연결된 기존 수행정보 찾기(§9). saleItemId 는 재저장으로 stale 가능 →
    //   (sequence + 상품명 스냅샷) 폴백으로도 매칭한다.
    const findExisting = (it: typeof items[number], idx: number) =>
      existing.find(e => (it.id != null && e.saleItemId === it.id) ||
        `${e.saleItemSequence}::${e.productNameSnapshot ?? ""}` === `${idx}::${it.productName ?? ""}`);

    let maxSeq = existing.reduce((m, e) => Math.max(m, e.sequence ?? 0), -1);
    const toInsert: (typeof performanceAssignmentsTable.$inferInsert)[] = [];
    const toCorrect: { id: number; it: typeof items[number]; idx: number; cls: PerfClass; prior: typeof existing[number] }[] = [];
    // 보호 대상 행(수행자 배정·원가 입력 등): 삭제/재생성 금지. 단, 판매 연결이 유지되면
    //   서비스별 상세 스냅샷(표시용 판매참조값·번역 상세)만 부분 갱신한다(§16-2).
    const toRefreshSnapshot: { id: number; it: typeof items[number]; prod: any; fileName: string | null }[] = [];
    let skipped = 0;

    items.forEach((it, idx) => {
      if (NON_PERFORMABLE_ITEM_TYPES.has(it.itemType ?? "")) return; // 할인·조정 제외(§8)
      const prod = it.productId != null ? prodMap.get(it.productId) : undefined;
      const cls = classifyPerformer({
        itemType: it.itemType, canonicalKey: prod?.canonicalKey, productType: prod?.productType,
        subCategory: prod?.subCategory, productName: it.productName,
      });
      const fileName = fileByItem.get(it.id) ?? null;

      // 이미 연결된 판매항목: 중복 생성 금지(§9). 미배정·원가0 등 교정대상이면
      //   구분값 + 서비스별 상세 스냅샷 + 판매연결(saleItemId) + 초기 기간·수량을 재동기화(§16).
      const prior = findExisting(it, idx);
      if (prior) {
        if (isCorrectableRow(prior)) {
          toCorrect.push({ id: prior.id, it, idx, cls, prior });
        } else {
          // 보호 행: 수행·원가·정산·날짜 정보는 보존하고, 서비스별 상세 스냅샷만 최신화 대상에 등록(§16-2).
          skipped++;
          toRefreshSnapshot.push({ id: prior.id, it, prod, fileName });
        }
        return;
      }

      maxSeq += 1;
      const detailSnap = buildDetailSnapshot(it, prod, fileName);
      // §5: 판매 공급단가(it.unitPrice)를 계약단가 초기값으로 복사(사용자가 이후 자유 수정). 판매금액은 불변.
      //   번역은 제외 — 번역 계약단가는 단어/글자 기준이라 페이지 기준 공급단가와 단위가 달라 초기복사 시 오계산.
      const seedUnitPrice = !isTranslationSnap(detailSnap, it.itemType) && it.unitPrice != null
        ? String(it.unitPrice) : null;
      toInsert.push({
        projectId, quoteId: quote.id, saleItemId: it.id, saleItemSequence: idx, sequence: maxSeq,
        sourceType: "sale_import", costType: cls.costType,   // 생성 출처·비용 유형(원가분석용)
        performerCategory: cls.category, lineCategory: cls.lineCategory,
        payeeType: payeeTypeOf(cls.category), status: "unassigned",
        serviceType: it.itemType ?? null,
        productNameSnapshot: it.productName ?? null,
        // 서비스 유형별 상세 스냅샷(금액 제외, 판매 참조값 포함 §3·§6·§8·§10)
        serviceDetailSnapshot: detailSnap,
        languageOrServiceSnapshot: it.languagePair ?? null,
        // 초기 기간·수량·단위·납품일(§10·§12)
        ...initialFieldsFromSale(it),
        // §5 계약단가 초기값 = 판매 공급단가(번역 제외). 이후 수행정보에서 자유 수정.
        ...(seedUnitPrice != null ? { contractUnitPrice: seedUnitPrice } : {}),
        // 지급일 자동계산(납품일 기준·직전 영업일 §10)
        expectedPaymentDate: calcPaymentDate(initialFieldsFromSale(it).deliveryDate, importIsHoliday),
        expectedPaymentDateAuto: calcPaymentDate(initialFieldsFromSale(it).deliveryDate, importIsHoliday),
        createdBy: req.user?.id ?? null,
        updatedBy: req.user?.id ?? null,
      });
    });

    let created: typeof performanceAssignmentsTable.$inferSelect[] = [];
    if (toInsert.length) {
      created = await db.insert(performanceAssignmentsTable).values(toInsert).returning();
    }
    // §8·§9·§16 기존 행 교정 — 미배정·원가0·미정산·미지급 행에 한해 구분·상세·판매연결·초기값 재동기화.
    //   수행자·계약단가·정산정보 등 사용자 확정값은 건드리지 않는다(isCorrectableRow 로 이미 필터).
    const correctedIds: number[] = [];
    for (const c of toCorrect) {
      const prod = c.it.productId != null ? prodMap.get(c.it.productId) : undefined;
      const fileName = fileByItem.get(c.it.id) ?? null;
      const init = initialFieldsFromSale(c.it);
      // §15: 이미 납품일이 입력됐거나 수동/확인완료 행은 납품일·확인상태를 덮어쓰지 않는다.
      const keepDelivery = c.prior.deliveryConfirmed || c.prior.deliveryDateManual || c.prior.deliveryDate != null;
      const {
        deliveryDate, deliveryDateAuto, deliveryDateManual, deliveryConfirmed, deliveryConfirmedBy, deliveryConfirmedAt,
        ...initRest
      } = init;
      await db.update(performanceAssignmentsTable).set({
        // 구분(변경 시에만 의미 있음)
        performerCategory: c.cls.category,
        lineCategory: c.cls.lineCategory,
        costType: c.cls.costType,
        payeeType: payeeTypeOf(c.cls.category),
        // 판매연결 재설정(saleItemId stale 복구) + 서비스별 상세 재동기화(§16)
        saleItemId: c.it.id,
        saleItemSequence: c.idx,
        serviceType: c.it.itemType ?? null,
        productNameSnapshot: c.it.productName ?? null,
        languageOrServiceSnapshot: c.it.languagePair ?? null,
        serviceDetailSnapshot: buildDetailSnapshot(c.it, prod, fileName),
        ...initRest,                            // 기간·수량·단위는 재동기화
        // 납품일·확인상태: 미입력 행만 자동 채움(§15). 확인/수동 행은 보존.
        ...(keepDelivery ? {} : { deliveryDate, deliveryDateAuto }),
        // 지급일은 "최종 납품일"(유지값 or 신규값) 기준으로 즉시 재계산(§10) — 파생값이므로 항상 갱신.
        expectedPaymentDate: calcPaymentDate(keepDelivery ? (c.prior.deliveryDate as any) : deliveryDate, importIsHoliday),
        expectedPaymentDateAuto: calcPaymentDate(keepDelivery ? (c.prior.deliveryDate as any) : deliveryDate, importIsHoliday),
        updatedBy: req.user?.id ?? null,
        updatedAt: new Date(),
      }).where(eq(performanceAssignmentsTable.id, c.id));
      correctedIds.push(c.id);
    }
    const correctedRows = correctedIds.length
      ? await db.select().from(performanceAssignmentsTable).where(inArray(performanceAssignmentsTable.id, correctedIds))
      : [];

    // §16-2 보호 행 부분 갱신 — 서비스별 상세 스냅샷(표시용: 파일명·형식·단어수·글자수·페이지수·판매 수량/단위 등)만
    //   최신 판매정보로 덮어쓴다. 수행자·업체·구분·계약단가·기본수행료·추가비용·원천징수·세율·원가합계·
    //   지급상태·납품일·지급일 등 사용자 확정값은 절대 변경하지 않는다(set 대상에 미포함).
    const refreshedIds: number[] = [];
    for (const rf of toRefreshSnapshot) {
      await db.update(performanceAssignmentsTable).set({
        serviceDetailSnapshot: buildDetailSnapshot(rf.it, rf.prod, rf.fileName),
        updatedBy: req.user?.id ?? null,
        updatedAt: new Date(),
      }).where(eq(performanceAssignmentsTable.id, rf.id));
      refreshedIds.push(rf.id);
    }

    res.json({
      created: created.length,
      corrected: correctedRows.length,
      skipped,
      refreshed: refreshedIds.length,
      message: `신규 수행정보 ${created.length}건을 추가했습니다.` +
        (correctedRows.length ? ` 기존 ${correctedRows.length}건을 판매정보(구분·서비스 상세) 기준으로 재동기화했습니다.` : "") +
        (refreshedIds.length ? ` 보호된 ${refreshedIds.length}건은 수행·원가 정보를 보존하고 서비스 상세정보만 최신화했습니다.` : ""),
      rows: created.map(stripEnc),
      correctedRows: correctedRows.map(stripEnc),
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
      // 2) upsert (+ 추가비용·차감 하위행 + 원가합계·지급예정일 재계산)
      //    지급일 "직전 영업일" 조정용 공휴일 집합을 1회 로드(§4·§6).
      const holidaySet = await loadKrHolidaySet();
      const isHoliday = (d: string) => holidaySet.has(d);
      // 납품확인 권한(§9) + 기존 행(변경감지·확인이력 보존)
      const [proj] = await tx.select({ adminId: projectsTable.adminId }).from(projectsTable).where(eq(projectsTable.id, projectId));
      const mayConfirm = await canConfirmDelivery(req.user, proj?.adminId ?? null);
      const priorRows = await tx.select().from(performanceAssignmentsTable)
        .where(and(eq(performanceAssignmentsTable.projectId, projectId), isNull(performanceAssignmentsTable.deletedAt)));
      const priorById = new Map(priorRows.map(p => [p.id, p]));
      for (const r of rows) {
        const category = r.performerCategory ?? "individual";
        const computed = computeRowValues(r);
        const values: Record<string, any> = {
          ...commonFields(r),
          ...computed,
          lineCategory: r.lineCategory ?? null,
          contractUnitPrice: r.contractUnitPrice != null ? String(r.contractUnitPrice) : null,
          quantity: r.quantity != null ? String(r.quantity) : null,
          unit: r.unit ?? null,
          isDirectAmount: category === "expense" ? true : (r.isDirectAmount ?? false),
          actualPaymentAmount: r.actualPaymentAmount != null ? String(r.actualPaymentAmount) : null,
          updatedBy: userId,
          updatedAt: new Date(),
        };

        // 납품일 = 서비스 종료일(performanceEndDate) 자동값(§2) or 사용자 수동값. 확인상태 처리(§6·§7·§9).
        const autoDelivery = r.performanceEndDate ?? null;
        values.deliveryDateAuto = autoDelivery;
        let resolvedDelivery: string | null;
        if (r.deliveryDateManual && r.deliveryDate) {
          resolvedDelivery = r.deliveryDate; values.deliveryDateManual = true;
        } else {
          resolvedDelivery = autoDelivery ?? r.deliveryDate ?? null; values.deliveryDateManual = false;
        }
        values.deliveryDate = resolvedDelivery;
        const priorRow = r.id ? priorById.get(r.id) : undefined;
        const priorDelivery = priorRow?.deliveryDate != null ? String(priorRow.deliveryDate).slice(0, 10) : null;
        const newDelivery = resolvedDelivery ? String(resolvedDelivery).slice(0, 10) : null;
        let confirmed = !!r.deliveryConfirmed;
        if (priorDelivery !== newDelivery) confirmed = false;   // §7 납품일 변경 시 확인 자동 해제
        if (confirmed && !priorRow?.deliveryConfirmed) {
          // 미확인 → 확인 전환: 담당 PM·관리자만 가능(§9). 권한 없으면 확인 안 됨.
          if (mayConfirm) { values.deliveryConfirmed = true; values.deliveryConfirmedBy = userId; values.deliveryConfirmedAt = new Date(); }
          else { values.deliveryConfirmed = false; values.deliveryConfirmedBy = null; values.deliveryConfirmedAt = null; }
        } else if (confirmed) {
          values.deliveryConfirmed = true;                        // 유지 — 확인이력 보존
          values.deliveryConfirmedBy = priorRow?.deliveryConfirmedBy ?? null;
          values.deliveryConfirmedAt = priorRow?.deliveryConfirmedAt ?? null;
        } else {
          values.deliveryConfirmed = false; values.deliveryConfirmedBy = null; values.deliveryConfirmedAt = null;
        }

        // 지급일 자동계산(납품일 기준 월말/익월15 → 직전 영업일) + 수동변경 이력(§4·§8-2·§9·§11)
        const autoDate = calcPaymentDate(resolvedDelivery, isHoliday);
        values.expectedPaymentDateAuto = autoDate;
        if (r.payDateManual && r.expectedPaymentDate) {
          // 사용자가 지급일을 직접 지정한 경우: 자동값으로 덮어쓰지 않는다(§8·§10-2).
          values.payDateManual = true;
          values.expectedPaymentDate = r.expectedPaymentDate;
          if (autoDate && r.expectedPaymentDate !== autoDate) {
            values.payDateChangeReason = r.payDateChangeReason ?? null;
            values.payDateChangedBy = userId;
            values.payDateChangedAt = new Date();
          }
        } else {
          // 자동 모드: 항상 납품일 기준 재계산값을 적용.
          values.payDateManual = false;
          values.expectedPaymentDate = autoDate ?? r.expectedPaymentDate ?? null;
          values.payDateChangeReason = null;
        }

        // 상태(§12) — 지급상태로 단일화. 단, 지급완료(paid)는 수행정보에서 직접 지정·해제할 수 없다.
        //   · 이미 paid 인 건: 되돌리기 불가 → 항상 paid 유지(클라이언트 값 무시).
        //   · paid 로의 신규 전환: 거부 → 정산 > 지급회차 [지급완료] 처리로만 변경된다.
        //   · unpaid ↔ payment_hold 만 사용자 변경 허용.
        const priorPay = priorRow?.paymentStatus ?? "unpaid";
        if (priorPay === "paid") {
          values.paymentStatus = "paid";
        } else if (r.paymentStatus) {
          if (r.paymentStatus === "paid") {
            throw new Error("지급완료는 수행정보에서 직접 지정할 수 없습니다. 정산 > 지급회차 지급완료 처리로만 변경됩니다.");
          }
          values.paymentStatus = r.paymentStatus;
        }

        // 수행자 스냅샷 재도출(§선택-저장 분리) — 인라인 로컬선택은 식별자·거주국·업체유형 스냅샷을 전송하지 않으므로,
        //   individualUserId/vendorCompanyId 가 "신규 배정·변경"된 경우에만 CRM에서 재도출해 영속(PII 암호문 포함).
        //   세율·거주구분은 클라이언트 값(사용자 수정 존중)을 유지하고, 미제공 시에만 서버 기본값으로 보정.
        const priorIndividual = priorRow?.individualUserId ?? null;
        const priorVendor = priorRow?.vendorCompanyId ?? null;
        if (category === "individual" && r.individualUserId != null) {
          if (r.individualUserId !== priorIndividual) {
            const snap = await deriveIndividualSnapshot(tx as any, r.individualUserId);
            if (snap) {
              values.performerNameSnapshot = snap.performerNameSnapshot;
              values.identifierSnapshotEnc = snap.identifierEnc;
              values.identifierSnapshotMasked = snap.identifierMasked;
              values.residenceCountrySnapshot = snap.residenceCountrySnapshot;
              if (r.residencyType == null) values.residencyType = snap.residencyType as any;
              if (r.withholdingTreatment == null) values.withholdingTreatment = snap.withholdingTreatment as any;
              if (r.contractUnitPrice == null && snap.baseRate != null) {
                values.contractUnitPrice = String(snap.baseRate);
                if (r.quantity == null) values.quantity = "1";
              }
            }
          }
        } else if (category === "vendor" && r.vendorCompanyId != null) {
          if (r.vendorCompanyId !== priorVendor) {
            const snap = await deriveVendorSnapshot(tx as any, r.vendorCompanyId);
            if (snap) {
              values.performerNameSnapshot = snap.performerNameSnapshot;
              values.vendorTypeSnapshot = snap.vendorTypeSnapshot;
              values.identifierSnapshotMasked = snap.identifierMasked;
              values.identifierSnapshotEnc = null;
            }
          }
        } else if (r.individualUserId == null && r.vendorCompanyId == null && category !== "expense") {
          // 수행자 해제 — 스테일 PII/스냅샷 정리
          values.identifierSnapshotEnc = null;
          values.identifierSnapshotMasked = null;
          values.residenceCountrySnapshot = null;
          values.vendorTypeSnapshot = null;
        }

        // upsert → assignmentId 확보
        let assignmentId: number;
        if (r.id) {
          await tx.update(performanceAssignmentsTable).set(values)
            .where(and(eq(performanceAssignmentsTable.id, r.id), eq(performanceAssignmentsTable.projectId, projectId)));
          assignmentId = r.id;
        } else {
          const [ins] = await tx.insert(performanceAssignmentsTable)
            .values({ projectId, createdBy: userId, ...values })
            .returning({ id: performanceAssignmentsTable.id });
          assignmentId = ins.id;
        }

        // 추가비용 하위행 — 제공된 경우만 전체 교체(생략 시 기존 유지)
        if (r.expenses !== undefined) {
          await tx.delete(performanceExpensesTable).where(eq(performanceExpensesTable.assignmentId, assignmentId));
          if (r.expenses.length) {
            await tx.insert(performanceExpensesTable).values(r.expenses.map(e => ({
              assignmentId, expenseType: e.expenseType, amount: String(e.amount ?? 0),
              incurredDate: e.incurredDate ?? null, includedInPayout: e.includedInPayout ?? true,
              evidenceUrl: e.evidenceUrl ?? null, evidenceFileName: e.evidenceFileName ?? null,
              memo: e.memo ?? null, createdBy: userId,
            })));
          }
        }
        // 차감 하위행 — 제공된 경우만 전체 교체
        if (r.deductions !== undefined) {
          await tx.delete(performanceDeductionsTable).where(eq(performanceDeductionsTable.assignmentId, assignmentId));
          if (r.deductions.length) {
            await tx.insert(performanceDeductionsTable).values(r.deductions.map(d => ({
              assignmentId, deductionType: d.deductionType, amount: String(d.amount ?? 0),
              reason: d.reason ?? null, createdBy: userId,
            })));
          }
        }

        // 원가합계 재계산 — 유효 하위행 기준(§9·§10). 기본수행료 산출 기준은 구분별로 상이.
        const [exp, ded] = await Promise.all([
          tx.select().from(performanceExpensesTable).where(eq(performanceExpensesTable.assignmentId, assignmentId)),
          tx.select().from(performanceDeductionsTable).where(eq(performanceDeductionsTable.assignmentId, assignmentId)),
        ]);
        // 번역 원가 기준 스냅샷 — 요청값 우선, 없으면 저장된 스냅샷(작업량은 판매 시점 고정값).
        const snapForCost: any = r.serviceDetailSnapshot ?? priorRow?.serviceDetailSnapshot ?? null;
        let base: number;
        if (category === "vendor") base = Number(computed.supplyAmount) || 0;            // 외주 공급가액
        else if (category === "expense") base = calcBasePerformanceFee(true, r.directAmount ?? 0, null, null);
        else if (r.isDirectAmount) base = calcBasePerformanceFee(true, r.directAmount ?? 0, null, null);
        else if (isTranslationSnap(snapForCost, r.serviceType)) {
          // 번역 원가 = 계약단가 × 작업량(단어/글자). 페이지수(quantity) 미사용(§작업량통일).
          //   작업량이 없으면 페이지로 자동계산하지 않고 기존 기본수행료 유지(계산 불가 → 임의 재계산 금지).
          const work = translationWorkAmount(snapForCost);
          base = (r.contractUnitPrice != null && work != null)
            ? calcBasePerformanceFee(false, null, r.contractUnitPrice, work)
            : Number(computed.baseFee) || 0;
        }
        else if (isInterpretationSnap(snapForCost, r.serviceType)) {
          // 통역 원가 = 계약단가(1인·1일) × 수행일수(quantity) × 인원(interpreterCount, 없으면 1)(§계약단가통일).
          const persons = interpreterHeadcount(snapForCost);
          base = (r.contractUnitPrice != null && r.quantity != null)
            ? calcBasePerformanceFee(false, null, r.contractUnitPrice, Number(r.quantity) * persons)
            : Number(computed.baseFee) || 0;
        }
        else if (r.contractUnitPrice != null && r.quantity != null)
          base = calcBasePerformanceFee(false, null, r.contractUnitPrice, r.quantity);   // 계약단가×수량
        else base = Number(computed.baseFee) || 0;                                       // 폴백: 개인 기본료
        const totals = calcCostTotal(
          base,
          exp.map(e => ({ amount: Number(e.amount), includedInPayout: e.includedInPayout })),
          ded.map(d => ({ amount: Number(d.amount) })),
        );
        await tx.update(performanceAssignmentsTable).set({
          basePerformanceFee: String(totals.basePerformanceFee),
          expenseTotal: String(totals.expenseTotal),
          deductionTotal: String(totals.deductionTotal),
          costTotal: String(totals.costTotal),
        }).where(eq(performanceAssignmentsTable.id, assignmentId));
      }
    });

    // 저장 완료 후 — 지급일이 일치하는 지급확정 전 회차로 미배정 건 자동배정(정산 즉시 반영).
    //   best-effort: 자동배정 실패가 수행정보 저장 자체를 막지 않도록 예외를 분리 처리.
    try { await autoAssignByPaymentDate(projectId); }
    catch (e) { req.log.error({ e, projectId }, "지급회차 자동배정 실패(저장은 정상)"); }

    const rowsOut = await loadPerformanceRows(projectId);
    res.json({ ok: true, rows: rowsOut });
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

// ── 수행자 스냅샷 도출(공용) — CRM(users+profile+sensitive / companies)에서 표시·세무 기본값을 계산 ──
//   · 순수 조회+계산만 수행(DB 미변경). resolve 엔드포인트(읽기전용)·배치저장 재도출·select-* 가 공용으로 사용.
//   · 식별번호는 translator_sensitive 암호문 그대로 스냅샷(enc) + 마스킹표시값 생성(§13·§36).
//   · 거주구분/원천징수 처리구분은 paymentMethod 로 "추정 기본값"만 — 해외/비거주는 자동 0% 확정 금지,
//     tax_review_required(세무확인 필요)로 둔다(§17·§19·§40).
async function deriveIndividualSnapshot(dbx: typeof db, translatorId: number) {
  const [user] = await dbx.select().from(usersTable).where(eq(usersTable.id, translatorId));
  if (!user) return null;
  const [sensitive] = await dbx.select().from(translatorSensitiveTable).where(eq(translatorSensitiveTable.translatorId, translatorId));
  const [profile] = await dbx.select().from(translatorProfilesTable).where(eq(translatorProfilesTable.userId, translatorId));

  let identifierEnc: string | null = null;
  let identifierMasked: string | null = null;
  if (sensitive?.residentNumber) {
    identifierEnc = sensitive.residentNumber; // 이미 AES 암호문
    try { identifierMasked = maskResidentNumber(decrypt(sensitive.residentNumber)); } catch { identifierMasked = null; }
  }
  const pm = sensitive?.paymentMethod ?? null;
  let residencyType: string | null = null;
  let withholdingTreatment: string = "tax_review_required";
  if (pm === "domestic_withholding") { residencyType = "domestic_resident"; withholdingTreatment = "domestic_3_3"; }
  else if (pm === "domestic_business") { residencyType = "domestic_resident"; withholdingTreatment = "tax_review_required"; }
  else if (pm === "overseas_paypal" || pm === "overseas_bank") { residencyType = "overseas_or_nonresident"; withholdingTreatment = "tax_review_required"; }
  const rate = profile?.unitPrice != null ? Number(profile.unitPrice) : null;
  return {
    performerNameSnapshot: user.name ?? user.email ?? null,
    identifierEnc, identifierMasked,
    residenceCountrySnapshot: sensitive?.country ?? null,
    residencyType, withholdingTreatment,
    baseRate: (rate != null && rate > 0) ? rate : null,   // 프로필 기본단가(있을 때만)
  };
}
async function deriveVendorSnapshot(dbx: typeof db, companyId: number) {
  const [company] = await dbx.select().from(companiesTable).where(eq(companiesTable.id, companyId));
  if (!company || company.companyType !== "vendor") return null;
  return {
    performerNameSnapshot: company.name ?? null,
    vendorTypeSnapshot: company.vendorType ?? null,
    identifierMasked: company.businessNumber ?? null,   // 사업자등록번호(표시)
  };
}

// ── 읽기전용 도출(§선택-저장 분리) — 수행자 선택 시 DB 저장 없이 표시·세무 기본값만 반환. 암호문(enc) 제외. ──
router.get("/admin/performances/resolve-individual", ...adminGuard, async (req, res) => {
  const translatorId = Number(req.query.translatorId);
  if (!Number.isInteger(translatorId) || translatorId <= 0) { res.status(400).json({ error: "translatorId 가 필요합니다." }); return; }
  try {
    const snap = await deriveIndividualSnapshot(db, translatorId);
    if (!snap) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }
    const { identifierEnc, ...safe } = snap;   // 암호문은 응답에서 제외(클라이언트는 마스킹값만)
    res.json({ ok: true, snapshot: safe });
  } catch (err) {
    req.log.error({ err }, "통번역사 도출 실패");
    res.status(500).json({ error: "통번역사 정보를 불러오지 못했습니다." });
  }
});

// ── 개인 통번역사 선택(즉시 저장) — 하위호환용. 신규 UX는 로컬선택 + 배치저장을 사용. ─────────────────
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
    const snap = await deriveIndividualSnapshot(db, translatorId);
    if (!snap) { res.status(404).json({ error: "통번역사를 찾을 수 없습니다." }); return; }
    // 계약단가 초기 반영(사용자 미입력 시에만) + 수량 기본 1
    const applyRate = row.contractUnitPrice == null && snap.baseRate != null;
    const [updated] = await db.update(performanceAssignmentsTable).set({
      performerCategory: "individual", costType: "individual", payeeType: "individual",
      individualUserId: translatorId, vendorCompanyId: null,
      performerNameSnapshot: snap.performerNameSnapshot,
      identifierSnapshotEnc: snap.identifierEnc, identifierSnapshotMasked: snap.identifierMasked,
      residenceCountrySnapshot: snap.residenceCountrySnapshot,
      residencyType: (snap.residencyType as any), withholdingTreatment: (snap.withholdingTreatment as any),
      ...(applyRate ? { contractUnitPrice: String(snap.baseRate), quantity: row.quantity ?? "1" } : {}),
      updatedBy: req.user?.id ?? null, updatedAt: new Date(),
    }).where(eq(performanceAssignmentsTable.id, id)).returning();
    res.json({ ok: true, row: stripEnc(updated) });
  } catch (err) {
    req.log.error({ err }, "개인 통번역사 선택 실패");
    res.status(500).json({ error: "통번역사 선택에 실패했습니다." });
  }
});

// ── 외주업체 선택(즉시 저장) — 하위호환용. 신규 UX는 로컬선택 + 배치저장을 사용. ────────────────────
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
    const snap = await deriveVendorSnapshot(db, companyId);
    if (!snap) { res.status(400).json({ error: "외주업체(vendor)만 선택할 수 있습니다." }); return; }
    const [updated] = await db.update(performanceAssignmentsTable).set({
      performerCategory: "vendor", costType: "vendor", payeeType: "vendor",
      vendorCompanyId: companyId, individualUserId: null,
      performerNameSnapshot: snap.performerNameSnapshot,
      identifierSnapshotEnc: null, identifierSnapshotMasked: snap.identifierMasked,
      vendorTypeSnapshot: snap.vendorTypeSnapshot,
      residencyType: null, withholdingTreatment: null, withholdingRate: null,
      updatedBy: req.user?.id ?? null, updatedAt: new Date(),
    }).where(eq(performanceAssignmentsTable.id, id)).returning();
    res.json({ ok: true, row: stripEnc(updated) });
  } catch (err) {
    req.log.error({ err }, "외주업체 선택 실패");
    res.status(500).json({ error: "업체 선택에 실패했습니다." });
  }
});

export default router;
