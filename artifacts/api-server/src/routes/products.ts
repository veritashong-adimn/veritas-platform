import { Router, type IRouter } from "express";
import { db, productsTable, productOptionsTable, productRequestsTable, quoteItemsTable, translatorProductsTable } from "@workspace/db";
import { eq, desc, sql, and, or, isNull, isNotNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import multer from "multer";
import * as XLSX from "xlsx";

const router: IRouter = Router();
const adminGuard = [requireAuth, requireRole("admin", "staff")];
const adminOnly = [requireAuth, requireRole("admin")];

// ─── 상품유형 정의 ─────────────────────────────────────────────────────────────
export const PRODUCT_TYPES: Record<string, { label: string; code: string; hasLanguage: boolean }> = {
  translation:    { label: "번역",      code: "TR", hasLanguage: true },
  interpretation: { label: "통역",      code: "IN", hasLanguage: true },
  combined:       { label: "통번역",    code: "CO", hasLanguage: true },
  proofreading:   { label: "감수",      code: "PR", hasLanguage: true },
  media:          { label: "미디어",    code: "MD", hasLanguage: true },
  equipment:      { label: "통역장비",  code: "EQ", hasLanguage: false },
  editing:        { label: "편집/DTP",  code: "ED", hasLanguage: false },
  operations:     { label: "운영/실비", code: "OP", hasLanguage: false },
  project:        { label: "프로젝트",  code: "PJ", hasLanguage: false },
  transport:      { label: "교통비",    code: "TX", hasLanguage: false },
  meal:           { label: "식대",      code: "ML", hasLanguage: false },
  accommodation:  { label: "숙박",      code: "AC", hasLanguage: false },
  other_cost:     { label: "기타비용",  code: "OT", hasLanguage: false },
};

// ─── 대분류 정의 (productType → mainCategory 목록) ────────────────────────────
export const MAIN_CATEGORIES_BY_TYPE: Record<string, { label: string; code: string }[]> = {
  translation: [
    { label: "일반번역", code: "GEN" },
    { label: "전문번역", code: "SPEC" },
    { label: "출판번역", code: "PUB" },
    { label: "번역공증", code: "CERT" },
    { label: "영상번역", code: "VID" },
    { label: "자막번역", code: "SUB" },
    { label: "SW번역",   code: "SW" },
    { label: "기타번역", code: "ETC" },
  ],
  interpretation: [
    { label: "동시통역",    code: "SIM" },
    { label: "순차통역",    code: "CON" },
    { label: "위스퍼링통역", code: "WHP" },
    { label: "수행통역",    code: "ESC" },
    { label: "VIP수행통역", code: "VIP" },
    { label: "가이드통역",  code: "GID" },
    { label: "미팅통역",    code: "MTG" },
    { label: "전시회통역",  code: "EXH" },
    { label: "화상통역",    code: "VDEO" },
    { label: "전화통역",    code: "TEL" },
    { label: "기타통역",    code: "ETC" },
  ],
  combined: [
    { label: "일반번역", code: "GEN" },
    { label: "전문번역", code: "SPEC" },
    { label: "동시통역", code: "SIM" },
    { label: "순차통역", code: "CON" },
    { label: "기타",     code: "ETC" },
  ],
  proofreading: [
    { label: "감수", code: "PRF" },
  ],
  media: [
    { label: "미디어", code: "MED" },
  ],
  equipment: [
    { label: "동시통역장비", code: "SIM" },
    { label: "가이드장비",   code: "GID" },
    { label: "위스퍼링장비", code: "WHP" },
    { label: "마이크장비",   code: "MIC" },
    { label: "음향장비",     code: "AUD" },
    { label: "부스장비",     code: "BTH" },
    { label: "운영장비",     code: "OPR" },
    { label: "기타장비",     code: "ETC" },
  ],
  editing: [
    { label: "편집/DTP", code: "EDT" },
  ],
  operations: [
    { label: "교통비",    code: "TX" },
    { label: "퀵비용",    code: "QCK" },
    { label: "식대",      code: "MEAL" },
    { label: "숙박",      code: "ACC" },
    { label: "보험료",    code: "INS" },
    { label: "운영관리비", code: "MGT" },
    { label: "기타실비",  code: "ETC" },
  ],
  project: [
    { label: "번역프로젝트",   code: "TR" },
    { label: "통역프로젝트",   code: "IN" },
    { label: "종합언어서비스", code: "COMP" },
    { label: "기타프로젝트",   code: "ETC" },
  ],
  transport: [
    { label: "항공",     code: "AIR" },
    { label: "기차",     code: "RAIL" },
    { label: "버스",     code: "BUS" },
    { label: "택시",     code: "TAXI" },
    { label: "기타교통", code: "ETC" },
  ],
  meal: [
    { label: "식비",     code: "MEAL" },
    { label: "간식비",   code: "SNK" },
    { label: "접대비",   code: "ENT" },
    { label: "기타식대", code: "ETC" },
  ],
  accommodation: [
    { label: "호텔",        code: "HTL" },
    { label: "게스트하우스", code: "GST" },
    { label: "기타숙박",    code: "ETC" },
  ],
  other_cost: [
    { label: "기타", code: "ETC" },
  ],
};

// ─── 중분류 정의 (mainCategory label → subCategory 목록) ─────────────────────
export const SUB_CATEGORIES_BY_MAIN: Record<string, { label: string; code: string }[]> = {
  "전문번역": [
    { label: "법률",   code: "LAW" },
    { label: "의료",   code: "MED" },
    { label: "기술",   code: "TECH" },
    { label: "금융",   code: "FIN" },
    { label: "계약서", code: "CONT" },
    { label: "논문",   code: "ACAD" },
  ],
  "감수": [
    { label: "원어민감수",   code: "NAT" },
    { label: "윤문",         code: "POL" },
    { label: "원문대조감수", code: "CMP" },
  ],
  "미디어": [
    { label: "자막작업",    code: "SUB" },
    { label: "더빙",        code: "DUB" },
    { label: "영상번역",    code: "VTR" },
    { label: "스크립트작성", code: "SCR" },
    { label: "STT",         code: "STT" },
    { label: "TTS",         code: "TTS" },
  ],
  "편집/DTP": [
    { label: "편집",    code: "EDT" },
    { label: "DTP",     code: "DTP" },
    { label: "인쇄",    code: "PRT" },
    { label: "디자인",  code: "DSN" },
    { label: "PPT작업", code: "PPT" },
  ],
  "동시통역장비": [
    { label: "FM방식",    code: "FM" },
    { label: "적외선방식", code: "IR" },
    { label: "리시버",    code: "RCV" },
    { label: "송신기",    code: "TRX" },
  ],
  "가이드장비": [
    { label: "가이드수신기", code: "RCV" },
    { label: "가이드송신기", code: "TRX" },
  ],
  "위스퍼링장비": [
    { label: "위스퍼링수신기", code: "RCV" },
    { label: "위스퍼링송신기", code: "TRX" },
  ],
  "마이크장비": [
    { label: "무선마이크",   code: "WLS" },
    { label: "유선마이크",   code: "WRD" },
    { label: "핀마이크",     code: "PIN" },
    { label: "회의용마이크", code: "CNF" },
  ],
  "음향장비": [
    { label: "오디오인터페이스", code: "AOI" },
    { label: "믹서",            code: "MIX" },
    { label: "음향콘솔",        code: "CON" },
    { label: "분배기",          code: "DST" },
  ],
  "부스장비": [
    { label: "통역부스", code: "BTH" },
    { label: "사전설치", code: "PRE" },
  ],
};

// ─── 언어 코드 정의 ───────────────────────────────────────────────────────────
export const LANGUAGE_CODES: { code: string; label: string }[] = [
  { code: "ko",  label: "한국어" },
  { code: "en",  label: "영어" },
  { code: "ja",  label: "일본어" },
  { code: "zh",  label: "중국어" },
  { code: "ru",  label: "러시아어" },
  { code: "es",  label: "스페인어" },
  { code: "de",  label: "독일어" },
  { code: "fr",  label: "프랑스어" },
  { code: "ar",  label: "아랍어" },
  { code: "it",  label: "이탈리아어" },
  { code: "tr",  label: "터키어" },
  { code: "pt",  label: "포르투갈어" },
  { code: "pl",  label: "폴란드어" },
  { code: "sv",  label: "스웨덴어" },
  { code: "nl",  label: "네덜란드어" },
  { code: "el",  label: "그리스어" },
  { code: "cs",  label: "체코어" },
  { code: "fa",  label: "페르시아어" },
  { code: "he",  label: "히브리어" },
  { code: "vi",  label: "베트남어" },
  { code: "mn",  label: "몽골어" },
  { code: "th",  label: "태국어" },
  { code: "id",  label: "인도네시아어" },
  { code: "ms",  label: "말레이어" },
  { code: "km",  label: "캄보디아어" },
  { code: "hi",  label: "인도어" },
  { code: "ur",  label: "파키스탄어" },
  { code: "si",  label: "스리랑카어" },
  { code: "bn",  label: "방글라데시어" },
  { code: "my",  label: "미얀마어" },
  { code: "lo",  label: "라오스어" },
  { code: "yue", label: "광동어" },
  { code: "uz",  label: "우즈베키스탄어" },
  { code: "uk",  label: "우크라이나어" },
  { code: "other", label: "기타" },
];

// ─── 단위 정의 ────────────────────────────────────────────────────────────────
const UNITS_BY_TYPE: Record<string, string[]> = {
  translation:    ["어절", "단어", "글자", "페이지", "건"],
  interpretation: ["1시간", "반일", "종일", "추가시간"],
  combined:       ["어절", "단어", "글자", "페이지", "건", "1시간", "반일", "종일"],
  proofreading:   ["어절", "단어", "글자", "페이지", "건"],
  media:          ["분", "초", "건"],
  equipment:      ["대", "일", "건"],
  editing:        ["페이지", "건", "시간"],
  operations:     ["건", "인"],
  project:        ["건", "식"],
  transport:      ["건"],
  meal:           ["건", "인"],
  accommodation:  ["박", "건"],
  other_cost:     ["건"],
};

// ─── 헬퍼 함수 ────────────────────────────────────────────────────────────────
function getMainCatCode(productType: string, mainCategoryLabel: string): string {
  const cats = MAIN_CATEGORIES_BY_TYPE[productType] ?? [];
  return cats.find(c => c.label === mainCategoryLabel)?.code ?? "GEN";
}

function getSubCatCode(mainCategoryLabel: string, subCategoryLabel: string): string {
  const subs = SUB_CATEGORIES_BY_MAIN[mainCategoryLabel] ?? [];
  return subs.find(s => s.label === subCategoryLabel)?.code ?? "";
}

// 언어 기반 타입 여부
function isLangType(productType: string): boolean {
  return PRODUCT_TYPES[productType]?.hasLanguage ?? false;
}

// 레거시 languagePair 파싱 (예: KOEN → {src: ko, tgt: en})
const LANG_PAIR_MIGRATION: Record<string, { src: string; tgt: string }> = {
  KOEN: { src: "ko", tgt: "en" },
  ENKO: { src: "en", tgt: "ko" },
  KOCN: { src: "ko", tgt: "zh" },
  KOJA: { src: "ko", tgt: "ja" },
  KORU: { src: "ko", tgt: "ru" },
  KOFR: { src: "ko", tgt: "fr" },
  KODE: { src: "ko", tgt: "de" },
  KOES: { src: "ko", tgt: "es" },
};

// ─── 상품 코드 자동 생성 ──────────────────────────────────────────────────────
// 언어 상품: [TYPE]-[SRC]-[TGT]-[CAT]-[SEQ]  예) TR-KO-EN-LAW-001
// 비언어 상품: [TYPE]-[CAT]-[SEQ]              예) EQ-SIM-001
async function generateProductCode(
  productType: string,
  sourceLanguage: string | null,
  targetLanguage: string | null,
  mainCategoryLabel: string,
  subCategoryLabel?: string,
): Promise<string> {
  const typeCode = PRODUCT_TYPES[productType]?.code ?? "TR";
  const hasLang = isLangType(productType);

  // 카테고리 코드: 중분류가 있으면 중분류, 없으면 대분류
  const catCode = subCategoryLabel
    ? (getSubCatCode(mainCategoryLabel, subCategoryLabel) || getMainCatCode(productType, mainCategoryLabel))
    : getMainCatCode(productType, mainCategoryLabel);

  let prefix: string;
  if (hasLang && sourceLanguage && targetLanguage) {
    const src = sourceLanguage.toUpperCase();
    const tgt = targetLanguage.toUpperCase();
    prefix = `${typeCode}-${src}-${tgt}-${catCode}`;
  } else {
    prefix = `${typeCode}-${catCode}`;
  }

  const existing = await db
    .select({ code: productsTable.code })
    .from(productsTable)
    .where(sql`${productsTable.code} LIKE ${prefix + "-%"}`)
    ;

  const nums = existing
    .map(p => parseInt(p.code.split("-").pop() ?? "0"))
    .filter(n => !isNaN(n));

  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// ─── 중복 체크 ────────────────────────────────────────────────────────────────
async function findDuplicate(
  productType: string,
  sourceLanguage: string | null,
  targetLanguage: string | null,
  mainCategory: string,
  subCategory?: string,
  excludeId?: number,
  name?: string,
) {
  const hasLang = isLangType(productType);
  // 비언어형 상품(통역장비 등): 이름 기반 중복 체크
  // 언어형 상품: 출발언어+도착언어+대분류+중분류 기반 중복 체크
  const conditions = hasLang
    ? and(
        sql`LOWER(${productsTable.productType}) = LOWER(${productType})`,
        sql`LOWER(COALESCE(${productsTable.mainCategory}, '')) = LOWER(${mainCategory || ""})`,
        sql`LOWER(COALESCE(${productsTable.subCategory}, '')) = LOWER(${subCategory || ""})`,
        sourceLanguage
          ? sql`LOWER(COALESCE(${productsTable.sourceLanguage}, '')) = LOWER(${sourceLanguage})`
          : sql`(${productsTable.sourceLanguage} IS NULL OR ${productsTable.sourceLanguage} = '')`,
        targetLanguage
          ? sql`LOWER(COALESCE(${productsTable.targetLanguage}, '')) = LOWER(${targetLanguage})`
          : sql`(${productsTable.targetLanguage} IS NULL OR ${productsTable.targetLanguage} = '')`,
      )
    : and(
        sql`LOWER(${productsTable.productType}) = LOWER(${productType})`,
        name?.trim()
          ? sql`LOWER(COALESCE(${productsTable.name}, '')) = LOWER(${name.trim()})`
          : sql`1=0`,
      );

  const rows = await db
    .select({ id: productsTable.id, code: productsTable.code, name: productsTable.name, active: productsTable.active })
    .from(productsTable)
    .where(and(conditions, isNull(productsTable.deletedAt)));
  return rows.filter(r => r.id !== excludeId);
}

// ─── 엑셀 공통 설정 ──────────────────────────────────────────────────────────
const EXCEL_HEADERS = [
  "상품코드(자동생성)", "상품유형*(번역/통역/통번역/통역장비/프로젝트/교통비/식대/숙박/기타비용)",
  "출발언어(ko/en/ja...)", "도착언어(ko/en/ja...)",
  "대분류*", "중분류", "상품명*", "단위*", "기본단가*",
  "기본진행시간(통역용)", "초과단가(통역용)", "비고",
];
const COL_WIDTHS = [18, 36, 16, 16, 20, 20, 24, 14, 12, 18, 14, 24];
const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const LANG_LABEL: Record<string, string> = Object.fromEntries(LANGUAGE_CODES.map(l => [l.code, l.label]));
const TYPE_LABEL: Record<string, string> = Object.fromEntries(Object.entries(PRODUCT_TYPES).map(([k, v]) => [k, v.label]));

function productToRow(p: typeof productsTable.$inferSelect): (string | number)[] {
  return [
    p.code,
    TYPE_LABEL[p.productType] ?? p.productType,
    p.sourceLanguage ?? "",
    p.targetLanguage ?? "",
    p.mainCategory ?? "",
    p.subCategory ?? "",
    p.name,
    p.unit ?? "건",
    p.basePrice ?? "",
    p.interpretationDuration ?? "",
    p.overtimePrice ?? "",
    p.description ?? "",
  ];
}

// ─── 상품 목록 ────────────────────────────────────────────────────────────────
router.get("/admin/products", ...adminGuard, async (req, res) => {
  try {
    const { search, productType, sourceLanguage, targetLanguage, mainCategory, activeOnly } = req.query as Record<string, string | undefined>;

    let rows = await db.select().from(productsTable)
      .where(isNull(productsTable.deletedAt))
      .orderBy(desc(productsTable.createdAt));

    if (search?.trim()) {
      const s = search.trim().toLowerCase();
      rows = rows.filter(p =>
        p.name.toLowerCase().includes(s) ||
        p.code.toLowerCase().includes(s) ||
        (p.mainCategory ?? "").toLowerCase().includes(s) ||
        (p.subCategory ?? "").toLowerCase().includes(s) ||
        (p.sourceLanguage ?? "").toLowerCase().includes(s) ||
        (p.targetLanguage ?? "").toLowerCase().includes(s)
      );
    }

    if (productType?.trim()) {
      rows = rows.filter(p => p.productType === productType.trim());
    }

    if (sourceLanguage?.trim()) {
      rows = rows.filter(p => (p.sourceLanguage ?? "").toLowerCase() === sourceLanguage.trim().toLowerCase());
    }

    if (targetLanguage?.trim()) {
      rows = rows.filter(p => (p.targetLanguage ?? "").toLowerCase() === targetLanguage.trim().toLowerCase());
    }

    if (mainCategory?.trim()) {
      rows = rows.filter(p => p.mainCategory === mainCategory.trim());
    }

    if (activeOnly === "true") {
      rows = rows.filter(p => p.active);
    } else if (activeOnly === "false") {
      rows = rows.filter(p => !p.active);
    }

    // 활성 상품 먼저
    rows.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

    const allOptions = await db.select().from(productOptionsTable).orderBy(productOptionsTable.sortOrder);
    const result = rows.map(p => ({
      ...p,
      options: allOptions.filter(o => o.productId === p.id),
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Products: failed to list");
    res.status(500).json({ error: "상품 조회 실패." });
  }
});

// ─── 상품 생성 ────────────────────────────────────────────────────────────────
router.post("/admin/products", ...adminOnly, async (req, res) => {
  const {
    productType, sourceLanguage, targetLanguage,
    mainCategory, subCategory,
    name, unit, basePrice, description,
    interpretationDuration, overtimePrice, options,
  } = req.body as {
    productType?: string; sourceLanguage?: string; targetLanguage?: string;
    mainCategory?: string; subCategory?: string;
    name?: string; unit?: string; basePrice?: number; description?: string;
    interpretationDuration?: string; overtimePrice?: number;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
  };

  const pType = productType?.trim() || "translation";
  if (!PRODUCT_TYPES[pType]) {
    res.status(400).json({ error: `productType은 ${Object.keys(PRODUCT_TYPES).join("/")} 중 하나여야 합니다.` }); return;
  }

  const hasLang = isLangType(pType);
  const srcLang = hasLang ? (sourceLanguage?.trim().toLowerCase() || null) : null;
  const tgtLang = hasLang ? (targetLanguage?.trim().toLowerCase() || null) : null;
  const mainCat = mainCategory?.trim() || "";
  const subCat = subCategory?.trim() || "";

  if (!mainCat) {
    res.status(400).json({ error: "대분류는 필수입니다." }); return;
  }
  if (!name?.trim()) {
    res.status(400).json({ error: "상품명은 필수입니다." }); return;
  }

  try {
    const dupes = await findDuplicate(pType, srcLang, tgtLang, mainCat, subCat, undefined, name?.trim());
    if (dupes.length > 0) {
      res.status(409).json({ error: "동일한 상품이 이미 존재합니다.", existing: dupes, isDuplicate: true });
      return;
    }

    const code = await generateProductCode(pType, srcLang, tgtLang, mainCat, subCat);

    const [product] = await db
      .insert(productsTable)
      .values({
        code,
        name: name.trim(),
        productType: pType,
        sourceLanguage: srcLang,
        targetLanguage: tgtLang,
        mainCategory: mainCat || null,
        subCategory: subCat || null,
        unit: unit ?? (UNITS_BY_TYPE[pType]?.[0] ?? "건"),
        basePrice: basePrice != null ? basePrice : null,
        description: description?.trim() || null,
        interpretationDuration: interpretationDuration?.trim() || null,
        overtimePrice: overtimePrice ?? null,
      })
      .returning();

    const optionRows = [];
    if (options && options.length > 0) {
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        if (!o.optionType?.trim() || !o.optionValue?.trim()) continue;
        const [opt] = await db.insert(productOptionsTable).values({
          productId: product.id,
          optionType: o.optionType.trim(),
          optionValue: o.optionValue.trim(),
          sortOrder: o.sortOrder ?? i,
        }).returning();
        optionRows.push(opt);
      }
    }

    await logEvent("product", product.id, "product_created", req.log, req.user as any,
      JSON.stringify({ code, name: product.name, productType: pType, sourceLanguage: srcLang, targetLanguage: tgtLang, mainCategory: mainCat }));

    res.status(201).json({ ...product, options: optionRows });
  } catch (err) {
    req.log.error({ err }, "Products: failed to create");
    res.status(500).json({ error: "상품 생성 실패." });
  }
});

// ─── 엑셀 템플릿 다운로드 ─────────────────────────────────────────────────────
router.get("/admin/products/template", ...adminGuard, (_req, res) => {
  const wb = XLSX.utils.book_new();
  const sampleRows = [
    ["(자동생성)", "번역", "ko", "en", "전문번역", "법률", "한영 법률번역", "어절", 50, "", "", "법률 문서 번역"],
    ["(자동생성)", "통역", "ko", "en", "동시통역", "", "한영 동시통역", "1시간", 200000, "4h", 50000, "컨퍼런스 동시통역"],
    ["(자동생성)", "통역장비", "", "", "동시통역장비", "", "동시통역장비 임대", "일", 150000, "", "", ""],
  ];
  const ws = XLSX.utils.aoa_to_sheet([EXCEL_HEADERS, ...sampleRows]);
  ws["!cols"] = COL_WIDTHS.map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, "상품목록");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''%EC%83%81%ED%92%88_%ED%85%9C%ED%94%8C%EB%A6%BF.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ─── 엑셀 내보내기 ────────────────────────────────────────────────────────────
router.get("/admin/products/export", ...adminGuard, async (req, res) => {
  try {
    const rows = await db.select().from(productsTable)
      .where(isNull(productsTable.deletedAt))
      .orderBy(productsTable.productType, productsTable.mainCategory, productsTable.name);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([EXCEL_HEADERS, ...rows.map(productToRow)]);
    ws["!cols"] = COL_WIDTHS.map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, "상품목록");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''%EC%83%81%ED%92%88%EB%AA%A9%EB%A1%9D_${now}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  } catch (err) {
    req.log.error({ err }, "Products export failed");
    res.status(500).json({ error: "내보내기 실패" });
  }
});

// ─── 엑셀 업로드 ─────────────────────────────────────────────────────────────
router.post("/admin/products/import", ...adminOnly, excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일이 없습니다." }); return; }

  type ImportResult = { created: number; skipped: number; errors: { row: number; message: string }[] };
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  const TYPE_LABEL_REV: Record<string, string> = {};
  for (const [k, v] of Object.entries(PRODUCT_TYPES)) TYPE_LABEL_REV[v.label] = k;

  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    if (rows.length < 2) {
      res.status(400).json({ error: "데이터 행이 없습니다." }); return;
    }

    for (let i = 1; i < rows.length; i++) {
      const rowNum = i + 1;
      const r = rows[i];
      const typeRaw = String(r[1] ?? "").trim();
      const srcLang = String(r[2] ?? "").trim().toLowerCase() || null;
      const tgtLang = String(r[3] ?? "").trim().toLowerCase() || null;
      const mainCat = String(r[4] ?? "").trim();
      const subCat = String(r[5] ?? "").trim() || "";
      const nameRaw = String(r[6] ?? "").trim();
      const unitRaw = String(r[7] ?? "").trim();
      const basePriceRaw = r[8] !== "" && r[8] != null ? Number(r[8]) : null;
      const interpretationDuration = String(r[9] ?? "").trim() || null;
      const overtimePriceRaw = r[10] !== "" ? Number(r[10]) : null;
      const description = String(r[11] ?? "").trim() || null;

      if (!typeRaw && !mainCat && !nameRaw) continue;

      const pType = TYPE_LABEL_REV[typeRaw] ?? typeRaw;
      if (!PRODUCT_TYPES[pType]) {
        result.errors.push({ row: rowNum, message: `상품유형 오류: '${typeRaw}'` }); continue;
      }
      if (!mainCat) {
        result.errors.push({ row: rowNum, message: `대분류가 없습니다` }); continue;
      }
      if (!nameRaw) {
        result.errors.push({ row: rowNum, message: `상품명이 없습니다` }); continue;
      }
      if (basePriceRaw !== null && (isNaN(basePriceRaw) || basePriceRaw < 0)) {
        result.errors.push({ row: rowNum, message: `기본단가 숫자 오류: '${r[8]}'` }); continue;
      }

      const validUnits = UNITS_BY_TYPE[pType] ?? ["건"];
      const unit = validUnits.includes(unitRaw) ? unitRaw : validUnits[0];
      const basePrice = basePriceRaw !== null ? Math.round(basePriceRaw) : null;
      const overtimePrice = overtimePriceRaw !== null && !isNaN(overtimePriceRaw) ? Math.round(overtimePriceRaw) : null;

      const dupes = await findDuplicate(pType, srcLang, tgtLang, mainCat, subCat, undefined, nameRaw);
      if (dupes.length > 0) {
        result.errors.push({ row: rowNum, message: `중복 상품 존재: ${dupes[0].code} (${dupes[0].name})` });
        result.skipped++;
        continue;
      }

      try {
        const code = await generateProductCode(pType, srcLang, tgtLang, mainCat, subCat);
        await db.insert(productsTable).values({
          code, name: nameRaw, productType: pType,
          sourceLanguage: srcLang, targetLanguage: tgtLang,
          mainCategory: mainCat || null, subCategory: subCat || null,
          unit, basePrice, description, interpretationDuration, overtimePrice,
        });
        result.created++;
      } catch (rowErr) {
        result.errors.push({ row: rowNum, message: `DB 저장 오류: ${(rowErr as Error).message}` });
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Products import failed");
    res.status(500).json({ error: "파일 파싱 실패." });
  }
});

// ─── 상품 요청 목록 ────────────────────────────────────────────────────────────
router.get("/admin/product-requests", ...adminGuard, async (req, res) => {
  try {
    const { status } = req.query as { status?: string };
    let rows = await db
      .select()
      .from(productRequestsTable)
      .orderBy(desc(productRequestsTable.createdAt));

    if (status && status !== "all") {
      rows = rows.filter(r => r.status === status);
    }

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to list");
    res.status(500).json({ error: "상품 요청 목록 조회 실패." });
  }
});

// ─── 상품 요청 생성 ────────────────────────────────────────────────────────────
router.post("/admin/product-requests", ...adminGuard, async (req, res) => {
  const { productType, sourceLanguage, targetLanguage, mainCategory, subCategory, name, unit, description } = req.body as {
    productType?: string; sourceLanguage?: string; targetLanguage?: string;
    mainCategory?: string; subCategory?: string;
    name?: string; unit?: string; description?: string;
  };

  const pType = productType?.trim() || "translation";
  if (!PRODUCT_TYPES[pType]) {
    res.status(400).json({ error: "유효하지 않은 상품유형입니다." }); return;
  }
  if (!mainCategory?.trim() || !name?.trim()) {
    res.status(400).json({ error: "대분류와 상품명은 필수입니다." }); return;
  }

  const hasLang = isLangType(pType);
  const srcLang = hasLang ? (sourceLanguage?.trim().toLowerCase() || null) : null;
  const tgtLang = hasLang ? (targetLanguage?.trim().toLowerCase() || null) : null;

  try {
    const dupes = await findDuplicate(pType, srcLang, tgtLang, mainCategory.trim(), subCategory?.trim() || "", undefined, name?.trim());
    const dupeInfo = dupes.length > 0 ? { hasDuplicate: true, existing: dupes } : { hasDuplicate: false };

    const performer = req.user as { id: number; email: string } | undefined;
    const [request] = await db.insert(productRequestsTable).values({
      productType: pType,
      sourceLanguage: srcLang,
      targetLanguage: tgtLang,
      mainCategory: mainCategory.trim(),
      subCategory: subCategory?.trim() || null,
      serviceType: "",
      languagePair: "",
      category: "",
      name: name.trim(),
      unit: unit ?? "건",
      description: description?.trim() || null,
      requestedBy: performer?.id ?? null,
      requestedByEmail: performer?.email ?? null,
      status: "pending",
    }).returning();

    await logEvent("product_request", request.id, "product_requested", req.log, performer as any,
      JSON.stringify({ productType: pType, sourceLanguage: srcLang, targetLanguage: tgtLang, mainCategory: mainCategory.trim(), name: name.trim(), ...dupeInfo }));

    res.status(201).json({ ...request, ...dupeInfo });
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to create");
    res.status(500).json({ error: "상품 요청 생성 실패." });
  }
});

// ─── 상품 요청 승인 ────────────────────────────────────────────────────────────
router.post("/admin/product-requests/:id/approve", ...adminOnly, async (req, res) => {
  const requestId = Number(req.params.id);
  if (isNaN(requestId) || requestId <= 0) {
    res.status(400).json({ error: "유효하지 않은 요청 id." }); return;
  }

  try {
    const [request] = await db.select().from(productRequestsTable).where(eq(productRequestsTable.id, requestId));
    if (!request) { res.status(404).json({ error: "요청을 찾을 수 없습니다." }); return; }
    if (request.status !== "pending") {
      res.status(409).json({ error: `이미 ${request.status === "approved" ? "승인" : "거절"}된 요청입니다.` }); return;
    }

    const pType = request.productType || "translation";
    const srcLang = request.sourceLanguage;
    const tgtLang = request.targetLanguage;
    const mainCat = request.mainCategory || "";
    const subCat = request.subCategory || "";

    const dupes = await findDuplicate(pType, srcLang, tgtLang, mainCat, subCat, undefined, request.name);
    if (dupes.length > 0) {
      res.status(409).json({ error: `동일한 상품이 이미 존재합니다. (${dupes[0].code})`, existing: dupes, isDuplicate: true });
      return;
    }

    const code = await generateProductCode(pType, srcLang, tgtLang, mainCat, subCat);
    const performer = req.user as { id: number; email: string } | undefined;

    const [product] = await db.insert(productsTable).values({
      code,
      name: request.name,
      productType: pType,
      sourceLanguage: srcLang,
      targetLanguage: tgtLang,
      mainCategory: mainCat || null,
      subCategory: subCat || null,
      unit: request.unit ?? "건",
      description: request.description ?? null,
      basePrice: 0,
    }).returning();

    const [updated] = await db.update(productRequestsTable)
      .set({
        status: "approved",
        approvedBy: performer?.id ?? null,
        approvedByEmail: performer?.email ?? null,
        approvedProductId: product.id,
        updatedAt: new Date(),
      })
      .where(eq(productRequestsTable.id, requestId))
      .returning();

    await logEvent("product_request", requestId, "product_approved", req.log, performer as any,
      JSON.stringify({ code, productId: product.id, name: product.name }));
    await logEvent("product", product.id, "product_created", req.log, performer as any,
      JSON.stringify({ code, fromRequestId: requestId }));

    res.json({ request: updated, product });
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to approve");
    res.status(500).json({ error: "상품 요청 승인 실패." });
  }
});

// ─── 상품 요청 거절 ────────────────────────────────────────────────────────────
router.post("/admin/product-requests/:id/reject", ...adminOnly, async (req, res) => {
  const requestId = Number(req.params.id);
  if (isNaN(requestId) || requestId <= 0) {
    res.status(400).json({ error: "유효하지 않은 요청 id." }); return;
  }

  const { reason } = req.body as { reason?: string };

  try {
    const [request] = await db.select().from(productRequestsTable).where(eq(productRequestsTable.id, requestId));
    if (!request) { res.status(404).json({ error: "요청을 찾을 수 없습니다." }); return; }
    if (request.status !== "pending") {
      res.status(409).json({ error: "대기 중인 요청만 거절할 수 있습니다." }); return;
    }

    const performer = req.user as { id: number; email: string } | undefined;
    const [updated] = await db.update(productRequestsTable)
      .set({
        status: "rejected",
        rejectionReason: reason?.trim() || null,
        approvedBy: performer?.id ?? null,
        approvedByEmail: performer?.email ?? null,
        updatedAt: new Date(),
      })
      .where(eq(productRequestsTable.id, requestId))
      .returning();

    await logEvent("product_request", requestId, "product_rejected", req.log, performer as any,
      JSON.stringify({ reason: reason?.trim() }));

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to reject");
    res.status(500).json({ error: "상품 요청 거절 실패." });
  }
});

// ─── 중복 체크 ────────────────────────────────────────────────────────────────
router.get("/admin/products/check-duplicate", ...adminGuard, async (req, res) => {
  const { productType, sourceLanguage, targetLanguage, mainCategory, subCategory, excludeId, name } = req.query as Record<string, string | undefined>;

  if (!productType || !mainCategory) {
    res.status(400).json({ error: "productType, mainCategory 는 필수입니다." }); return;
  }

  try {
    const dupes = await findDuplicate(
      productType,
      sourceLanguage || null,
      targetLanguage || null,
      mainCategory,
      subCategory || "",
      excludeId ? Number(excludeId) : undefined,
      name || undefined,
    );
    res.json({ hasDuplicate: dupes.length > 0, existing: dupes });
  } catch (err) {
    res.status(500).json({ error: "중복 체크 실패." });
  }
});

// ─── 상품 단건 조회 ────────────────────────────────────────────────────────────
router.get("/admin/products/:id", ...adminGuard, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  try {
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!product) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }
    const options = await db.select().from(productOptionsTable)
      .where(eq(productOptionsTable.productId, productId))
      .orderBy(productOptionsTable.sortOrder);
    res.json({ ...product, options });
  } catch (err) {
    req.log.error({ err }, "Products: failed to get");
    res.status(500).json({ error: "상품 조회 실패." });
  }
});

// ─── 상품 수정 (code/productType/sourceLanguage/targetLanguage 변경 불가) ────
router.patch("/admin/products/:id", ...adminOnly, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  const {
    name, mainCategory, subCategory, unit, basePrice, description, active,
    interpretationDuration, overtimePrice, options,
  } = req.body as {
    name?: string; mainCategory?: string; subCategory?: string;
    unit?: string; basePrice?: number; description?: string; active?: boolean;
    interpretationDuration?: string; overtimePrice?: number | null;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
  };

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }
    if (!existing.active && active !== true) {
      res.status(409).json({ error: "비활성 상품은 먼저 활성화 후 수정하세요." }); return;
    }

    const [updated] = await db
      .update(productsTable)
      .set({
        name: name?.trim() ?? existing.name,
        mainCategory: mainCategory !== undefined ? (mainCategory?.trim() || null) : existing.mainCategory,
        subCategory: subCategory !== undefined ? (subCategory?.trim() || null) : existing.subCategory,
        unit: unit ?? existing.unit,
        basePrice: basePrice !== undefined ? (basePrice != null ? basePrice : null) : existing.basePrice,
        description: description !== undefined ? (description?.trim() || null) : existing.description,
        active: active !== undefined ? Boolean(active) : existing.active,
        interpretationDuration: interpretationDuration !== undefined
          ? (interpretationDuration?.trim() || null) : existing.interpretationDuration,
        overtimePrice: overtimePrice !== undefined ? (overtimePrice ?? null) : existing.overtimePrice,
      })
      .where(eq(productsTable.id, productId))
      .returning();

    let optionRows: typeof productOptionsTable.$inferSelect[] = [];
    if (options !== undefined) {
      await db.delete(productOptionsTable).where(eq(productOptionsTable.productId, productId));
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        if (!o.optionType?.trim() || !o.optionValue?.trim()) continue;
        const [opt] = await db.insert(productOptionsTable).values({
          productId,
          optionType: o.optionType.trim(),
          optionValue: o.optionValue.trim(),
          sortOrder: o.sortOrder ?? i,
        }).returning();
        optionRows.push(opt);
      }
    } else {
      optionRows = await db.select().from(productOptionsTable)
        .where(eq(productOptionsTable.productId, productId))
        .orderBy(productOptionsTable.sortOrder);
    }

    await logEvent("product", productId, "product_updated", req.log, req.user as any,
      JSON.stringify({ name: updated.name, active: updated.active }));

    res.json({ ...updated, options: optionRows });
  } catch (err) {
    req.log.error({ err }, "Products: failed to update");
    res.status(500).json({ error: "상품 수정 실패." });
  }
});

// ─── 상품 활성/비활성 토글 ────────────────────────────────────────────────────
router.patch("/admin/products/:id/toggle", ...adminOnly, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  const { reason } = req.body as { reason?: string };

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }

    if (existing.active && !reason?.trim()) {
      res.status(400).json({ error: "비활성화 사유를 입력해주세요." }); return;
    }

    const setData: Partial<typeof productsTable.$inferInsert> = { active: !existing.active };
    if (existing.active) {
      setData.deactivationReason = reason!.trim();
    } else {
      setData.deactivationReason = null;
    }

    const [updated] = await db
      .update(productsTable)
      .set(setData)
      .where(eq(productsTable.id, productId))
      .returning();

    await logEvent("product", productId, existing.active ? "product_deactivated" : "product_activated",
      req.log, req.user as any, existing.active ? JSON.stringify({ reason: reason?.trim() }) : undefined);

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Products: failed to toggle");
    res.status(500).json({ error: "상품 상태 변경 실패." });
  }
});

// ─── 상품 삭제 (소프트: active=false) ────────────────────────────────────────
router.delete("/admin/products/:id", ...adminOnly, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }

    const [updated] = await db
      .update(productsTable)
      .set({ active: false, deactivationReason: "관리자 삭제" })
      .where(eq(productsTable.id, productId))
      .returning();

    await logEvent("product", productId, "product_deleted", req.log, req.user as any);
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Products: failed to delete");
    res.status(500).json({ error: "상품 삭제 실패." });
  }
});

// ─── 상품 완전삭제 (purge) ────────────────────────────────────────────────────
// 미사용 상품만 가능. deleted_at 기반 soft-delete로 코드 재사용 방지.
router.delete("/admin/products/:id/purge", ...adminOnly, async (req, res) => {
  const productId = Number(req.params.id);
  if (isNaN(productId) || productId <= 0) {
    res.status(400).json({ error: "유효하지 않은 product id." }); return;
  }

  try {
    const [existing] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!existing) { res.status(404).json({ error: "상품을 찾을 수 없습니다." }); return; }
    if (existing.deletedAt) { res.status(409).json({ error: "이미 삭제된 상품입니다." }); return; }

    // 사용 여부 확인: 견적 아이템에 연결된 경우
    const usedInQuotes = await db
      .select({ id: quoteItemsTable.id })
      .from(quoteItemsTable)
      .where(eq(quoteItemsTable.productId, productId))
      .limit(1);

    if (usedInQuotes.length > 0) {
      res.status(409).json({
        error: "이미 사용된 상품입니다. 비활성만 가능합니다.",
        reason: "quote_items",
      });
      return;
    }

    // 완전삭제: deleted_at 설정 + translator_products는 cascade로 자동 삭제됨
    const now = new Date();
    const [updated] = await db
      .update(productsTable)
      .set({ deletedAt: now, active: false, deactivationReason: "완전삭제" })
      .where(eq(productsTable.id, productId))
      .returning();

    await logEvent("product", productId, "product_purged", req.log, req.user as any,
      JSON.stringify({ code: existing.code, name: existing.name }));

    res.json({ ...updated, purged: true });
  } catch (err) {
    req.log.error({ err }, "Products: failed to purge");
    res.status(500).json({ error: "상품 완전삭제 실패." });
  }
});

// ─── 메타 정보 (프론트 참조용) ───────────────────────────────────────────────
router.get("/admin/products-meta", ...adminGuard, (_req, res) => {
  res.json({
    productTypes: PRODUCT_TYPES,
    mainCategoriesByType: MAIN_CATEGORIES_BY_TYPE,
    subCategoriesByMain: SUB_CATEGORIES_BY_MAIN,
    languageCodes: LANGUAGE_CODES,
    unitsByType: UNITS_BY_TYPE,
  });
});

export default router;
