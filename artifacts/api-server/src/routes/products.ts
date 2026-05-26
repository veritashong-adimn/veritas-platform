import { Router, type IRouter } from "express";
import { db, productsTable, productOptionsTable, productRequestsTable, quoteItemsTable, translatorProductsTable } from "@workspace/db";
import { eq, desc, sql, and, or, isNull, isNotNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { logEvent } from "../lib/logEvent";
import multer from "multer";
import * as XLSX from "xlsx";
import { expandCompactPattern }    from "../lib/product-parser/compactPatternRules";
import { REVIEW_REASONS, NON_PENALTY_REASONS } from "../lib/product-parser/reviewReasonRules";
import { INTERP_SUBTYPES, EQUIP_CANONICALS } from "../lib/product-parser/displayNamePolicy";

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
  // expense: 프론트엔드 통합 실비 타입 — 운영 호환성 유지
  expense:        { label: "실비",      code: "EX", hasLanguage: false },
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
  expense: [
    { label: "배송/퀵",   code: "DLV"  },
    { label: "교통비",    code: "TX"   },
    { label: "식비",      code: "MEAL" },
    { label: "숙박",      code: "ACC"  },
    { label: "기타 실비", code: "ETC"  },
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
  { code: "ko",      label: "한국어" },
  { code: "en",      label: "영어" },
  { code: "ja",      label: "일본어" },
  { code: "zh-hans", label: "중국어(간체)" },
  { code: "zh-hant", label: "중국어(번체)" },
  { code: "ru",      label: "러시아어" },
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
  expense:        ["건", "인", "박"],
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
  KOCN: { src: "ko", tgt: "zh-hans" },
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

  // zh-hans / zh-hant / zh → 모두 ZH 코드 유지 (기존 운영 코드 체계 backward compatibility)
  // 내부 canonical 분리(zh-hans/zh-hant)는 언어 필드에서 유지, 코드 세그먼트는 ZH 단일 표기
  function langCodeForProductCode(code: string): string {
    if (code === "zh-hans" || code === "zh-hant" || code === "zh") return "ZH";
    return code.toUpperCase();
  }

  let prefix: string;
  if (hasLang && sourceLanguage && targetLanguage) {
    const src = langCodeForProductCode(sourceLanguage);
    const tgt = langCodeForProductCode(targetLanguage);
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

// ─── 언어 코드 정규화 (zh / zh-hans → zh-hans, zh-hant 유지) ──────────────────
// 기존 DB에 zh로 저장된 데이터와 신규 zh-hans 데이터 간 중복 감지를 위해
// zh 단독 입력은 zh-hans로 통합하여 비교
function normalizeLangCode(code: string | null): string {
  if (!code) return "";
  const c = code.toLowerCase().trim();
  if (c === "zh") return "zh-hans";
  if (c === "yue") return "zh-hant";  // 광동어 fallback — yue 정식 지원 전 임시
  return c;
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
  // zh / zh-hans 혼재 방지: normalizeLangCode로 정규화 후 비교
  const normSrc = normalizeLangCode(sourceLanguage);
  const normTgt = normalizeLangCode(targetLanguage);
  const conditions = hasLang
    ? and(
        sql`LOWER(${productsTable.productType}) = LOWER(${productType})`,
        sql`LOWER(COALESCE(${productsTable.mainCategory}, '')) = LOWER(${mainCategory || ""})`,
        sql`LOWER(COALESCE(${productsTable.subCategory}, '')) = LOWER(${subCategory || ""})`,
        normSrc
          ? sql`LOWER(COALESCE(${productsTable.sourceLanguage}, '')) = ANY(ARRAY[${normSrc}, ${normSrc === "zh-hans" ? "zh" : normSrc}])`
          : sql`(${productsTable.sourceLanguage} IS NULL OR ${productsTable.sourceLanguage} = '')`,
        normTgt
          ? sql`LOWER(COALESCE(${productsTable.targetLanguage}, '')) = ANY(ARRAY[${normTgt}, ${normTgt === "zh-hans" ? "zh" : normTgt}])`
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

// ─── 상품명 normalize ─────────────────────────────────────────────────────────
function normalizeProdName(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[\s\-_·•]/g, "")
    .replace(/[()（）\[\]【】]/g, "")
    .normalize("NFC");
}

// ─── Product + Option 구조 분석 ──────────────────────────────────────────────
type ProductAnalysis = {
  productCandidate: string;
  langPair: string;
  direction: string;
  difficulty: string;
  industry: string;
  industry2: string;
  isOptionCandidate: boolean;
  confidenceScore: number;
  reviewReasons: string[];
  displayName: string;
  domain: string;
  langHint: string;
};

const ISO_LABEL: Record<string, string> = {
  ko: "한국어", en: "영어",  ja: "일본어",
  "zh-hans": "중국어(간체)", "zh-hant": "중국어(번체)",
  zh: "중국어",  // 기존 데이터 fallback — displayName 생성 시 사용
  fr: "프랑스어", de: "독일어", es: "스페인어", ru: "러시아어",
  ar: "아랍어",  pt: "포르투갈어", vi: "베트남어", th: "태국어",
  id: "인도네시아어", ms: "말레이어", hi: "힌디어", ph: "필리핀어",
  tr: "터키어",  it: "이탈리아어", mn: "몽골어",
  bn: "벵골어",  ur: "우르두어",   fa: "페르시아어", km: "크메르어",
  lo: "라오스어", sw: "스와힐리어", ne: "네팔어",  ta: "타밀어",
  yue: "광동어", sr: "세르비아어", uk: "우크라이나어", pl: "폴란드어",
  nl: "네덜란드어", cs: "체코어", ro: "루마니아어", hu: "헝가리어",
  da: "덴마크어",  sv: "스웨덴어",  no: "노르웨이어", fi: "핀란드어",
  bg: "불가리아어", hr: "크로아티아어", el: "그리스어",
  ky: "키르기스어", uz: "우즈베크어", tk: "투르크멘어",
  tl: "타갈로그어", my: "미얀마어", si: "싱할라어", he: "히브리어",
};

type LangEntry = { m: string; code: string; label: string; reviewReason?: string };
const LANG_ENTRIES: LangEntry[] = [
  // 장음절 우선 (prefix 충돌 방지)
  { m: "투르크멘어",   code: "tk",  label: "투르크멘어" },
  { m: "우즈베크어",   code: "uz",  label: "우즈베크어" },
  { m: "키르기스어",   code: "ky",  label: "키르기스어" },
  { m: "타갈로그어",   code: "tl",  label: "타갈로그어" },
  { m: "인도네시아어", code: "id",  label: "인도네시아어" },
  { m: "인니어",       code: "id",  label: "인도네시아어" },
  { m: "인니",         code: "id",  label: "인도네시아어" },
  { m: "포르투갈어",   code: "pt",  label: "포르투갈어" },
  { m: "포어",         code: "pt",  label: "포르투갈어" },
  { m: "이탈리아어",   code: "it",  label: "이탈리아어" },
  { m: "이태리어",     code: "it",  label: "이탈리아어" },
  { m: "스와힐리어",   code: "sw",  label: "스와힐리어" },
  { m: "캄보디아어",   code: "km",  label: "크메르어" },
  { m: "크메르어",     code: "km",  label: "크메르어" },
  { m: "캄",           code: "km",  label: "크메르어" },
  { m: "스페인어",     code: "es",  label: "스페인어" },
  { m: "러시아어",     code: "ru",  label: "러시아어" },
  { m: "페르시아어",   code: "fa",  label: "페르시아어" },
  { m: "우크라이나어", code: "uk",  label: "우크라이나어" },
  { m: "네덜란드어",   code: "nl",  label: "네덜란드어" },
  { m: "프랑스어",     code: "fr",  label: "프랑스어" },
  { m: "베트남어",     code: "vi",  label: "베트남어" },
  { m: "세르비아어",   code: "sr",  label: "세르비아어" },
  { m: "우르두어",     code: "ur",  label: "우르두어" },
  { m: "헝가리어",     code: "hu",  label: "헝가리어" },
  { m: "그리스어",     code: "el",  label: "그리스어" },
  { m: "라오스어",     code: "lo",  label: "라오스어" },
  { m: "라오어",       code: "lo",  label: "라오어" },
  { m: "라오스",       code: "lo",  label: "라오어" },
  { m: "루마니아어",   code: "ro",  label: "루마니아어" },
  { m: "노르웨이어",   code: "no",  label: "노르웨이어" },
  { m: "불가리아어",   code: "bg",  label: "불가리아어" },
  { m: "크로아티아어", code: "hr",  label: "크로아티아어" },
  { m: "스웨덴어",     code: "sv",  label: "스웨덴어" },
  { m: "덴마크어",     code: "da",  label: "덴마크어" },
  { m: "핀란드어",     code: "fi",  label: "핀란드어" },
  { m: "한국말",       code: "ko",  label: "한국어" },
  { m: "국문",         code: "ko",  label: "한국어" },
  { m: "한국어",       code: "ko",  label: "한국어" },
  { m: "한글",         code: "ko",  label: "한국어" },
  { m: "영국어",       code: "en",  label: "영어" },
  { m: "필리핀어",     code: "ph",  label: "필리핀어" },
  { m: "말레이시아어", code: "ms",  label: "말레이어" },
  { m: "말레이어",     code: "ms",  label: "말레이어" },
  { m: "체코어",       code: "cs",  label: "체코어" },
  // 광동어: yue 정식 지원 전 zh-hant fallback + CANTONESE_REVIEW 검토 플래그
  { m: "광동어",  code: "zh-hant", label: "중국어(번체)", reviewReason: REVIEW_REASONS.CANTONESE_REVIEW },
  { m: "타밀어",       code: "ta",  label: "타밀어" },
  { m: "네팔어",       code: "ne",  label: "네팔어" },
  { m: "벵골어",       code: "bn",  label: "벵골어" },
  { m: "폴란드어",     code: "pl",  label: "폴란드어" },
  { m: "영어",         code: "en",  label: "영어" },
  { m: "일본어",       code: "ja",  label: "일본어" },
  // 중국어 명시적 간체/번체 표기 — 직접 분류 (검토 불필요)
  { m: "중국어(간체)",   code: "zh-hans", label: "중국어(간체)" },
  { m: "중국어(번체)",   code: "zh-hant", label: "중국어(번체)" },
  { m: "간체중국어",     code: "zh-hans", label: "중국어(간체)" },
  { m: "번체중국어",     code: "zh-hant", label: "중국어(번체)" },
  { m: "대만어",         code: "zh-hant", label: "중국어(번체)" },
  { m: "홍콩어",         code: "zh-hant", label: "중국어(번체)", reviewReason: REVIEW_REASONS.CANTONESE_REVIEW },
  // 모호 표현 — zh-hans 기본값, ZH_AMBIGUOUS 검토 필요
  { m: "중국어",  code: "zh-hans", label: "중국어(간체)", reviewReason: REVIEW_REASONS.ZH_AMBIGUOUS },
  { m: "불어",         code: "fr",  label: "프랑스어" },
  { m: "독일어",       code: "de",  label: "독일어" },
  { m: "아랍어",       code: "ar",  label: "아랍어" },
  { m: "힌디어",       code: "hi",  label: "힌디어" },
  { m: "터키어",       code: "tr",  label: "터키어" },
  { m: "태국어",       code: "th",  label: "태국어" },
  { m: "몽골어",       code: "mn",  label: "몽골어" },
  { m: "미얀마어",     code: "my",  label: "미얀마어" },
  { m: "싱할라어",     code: "si",  label: "싱할라어" },
  { m: "히브리어",     code: "he",  label: "히브리어" },
  // ── 국가명 alias (COUNTRY_LANGUAGE_ALIAS) ─────────────────────────────────
  // 국가명이 언어명으로 통용되는 경우 — 실제 언어코드로 매핑 + 검토 플래그
  { m: "파키스탄어",   code: "ur",      label: "우르두어",   reviewReason: REVIEW_REASONS.COUNTRY_LANGUAGE_ALIAS },
  { m: "이란어",       code: "fa",      label: "페르시아어", reviewReason: REVIEW_REASONS.COUNTRY_LANGUAGE_ALIAS },
  { m: "튀르키예어",   code: "tr",      label: "터키어",     reviewReason: REVIEW_REASONS.COUNTRY_LANGUAGE_ALIAS },
  { m: "이라크어",     code: "ar",      label: "아랍어",     reviewReason: REVIEW_REASONS.COUNTRY_LANGUAGE_ALIAS },
  { m: "이집트어",     code: "ar",      label: "아랍어",     reviewReason: REVIEW_REASONS.COUNTRY_LANGUAGE_ALIAS },
  { m: "브라질어",     code: "pt",      label: "포르투갈어", reviewReason: REVIEW_REASONS.COUNTRY_LANGUAGE_ALIAS },
  // 2음절 alias
  { m: "독어", code: "de", label: "독일어" },   // "독어사용장비" 등에서 "독" 단음절 오파싱 방지
  { m: "스웨", code: "sv", label: "스웨덴어" },
  { m: "세르", code: "sr", label: "세르비아어" },
  { m: "불가", code: "bg", label: "불가리아어" },
  { m: "크로", code: "hr", label: "크로아티아어" },
  // 단음절 (separator 필수 — SEP_RX 가드 적용)
  { m: "한", code: "ko", label: "한국어" },
  { m: "영", code: "en", label: "영어" },
  { m: "일", code: "ja", label: "일본어" },
  { m: "중", code: "zh-hans", label: "중국어(간체)", reviewReason: REVIEW_REASONS.ZH_AMBIGUOUS },
  { m: "불", code: "fr", label: "프랑스어" },
  { m: "독", code: "de", label: "독일어" },
  { m: "스", code: "es", label: "스페인어" },
  { m: "서", code: "es", label: "스페인어" },
  { m: "러", code: "ru", label: "러시아어" },
  { m: "아", code: "ar", label: "아랍어" },
  { m: "포", code: "pt", label: "포르투갈어" },
  { m: "베", code: "vi", label: "베트남어" },
  { m: "태", code: "th", label: "태국어" },
  { m: "몽", code: "mn", label: "몽골어" },
  { m: "말", code: "ms", label: "말레이어" },
  { m: "덴", code: "da", label: "덴마크어" },
  { m: "노", code: "no", label: "노르웨이어" },
  { m: "핀", code: "fi", label: "핀란드어" },
  { m: "헝", code: "hu", label: "헝가리어" },
  { m: "루", code: "ro", label: "루마니아어" },
  { m: "체", code: "cs", label: "체코어" },
  { m: "터", code: "tr", label: "터키어" },
  { m: "인", code: "id", label: "인도네시아어" },
];


const SORTED_LANG_ENTRIES: LangEntry[] = [...LANG_ENTRIES].sort((a, b) => b.m.length - a.m.length);

// Canonical service type dictionary (긴 패턴 우선)
// 중요: 장비 계열을 통역/번역 패턴보다 반드시 먼저 배치해야 "동시통역장비"가 오분류되지 않음
const CANONICAL_PRODUCTS: [RegExp, string][] = [
  // ── 장비 계열 ─────────────────────────────────────────────────────────────
  [/동시통역\s*장비/,               "동시통역장비"],
  [/위스퍼링\s*장비/,               "위스퍼링장비"],
  [/PA\s*장비|PA\s*시스템/i,        "PA장비"],
  [/통역\s*부스/,                   "통역부스"],
  [/통역용?\s*장비|통역\s*장비/,    "통역장비"],
  [/사용\s*장비/,                   "통역장비"],  // "독어사용장비" workName 잔여 처리
  [/수신기/,                        "수신기"],
  [/송신기/,                        "송신기"],
  [/헤드셋/,                        "헤드셋"],
  // ── 번역 계열 ─────────────────────────────────────────────────────────────
  [/원어민감수/,                    "원어민감수"],
  [/공증번역/,                      "공증번역"],
  [/영문화|국문화|한글화|영문작업|영문번역|영어번역/, "번역"],
  [/번역/,                          "번역"],
  [/감수/,                          "감수"],
  // ── 통역 subtype (구체적인 것 먼저, generic fallback 마지막) ───────────────
  [/수행비서통역/,                  "수행비서통역"],
  [/VIP\s*수행통역/i,              "VIP수행통역"],  // VIP수행 (수행통역보다 먼저)
  [/전시회통역/,                    "전시회통역"],
  [/미팅통역/,                      "미팅통역"],
  [/현장통역/,                      "현장통역"],
  [/가이드통역/,                    "가이드통역"],   // 수행통역과 별개 canonical
  [/위스퍼링통역/,                  "위스퍼링통역"],
  [/화상통역/,                      "화상통역"],
  [/전화통역/,                      "전화통역"],
  [/출장통역/,                      "수행통역"],    // 출장통역 = 수행통역 (운영상 동일)
  [/수행통역/,                      "수행통역"],
  [/동시통역/,                      "동시통역"],
  [/일반통역/,                      "순차통역"],    // 일반통역 = 순차통역 (업계 표준)
  [/순차통역/,                      "순차통역"],
  [/통역/,                          "통역"],        // generic fallback — 최후 수단
];

const COUNTRY_KEYWORDS = ["스위스", "벨기에", "유럽", "동남아", "중동", "아프리카"];
// "홍콩어"/"대만어"는 LANG_ENTRIES에서 zh-hant로 직접 분류되므로 여기서 제외
const REGION_LANGUAGE_KEYWORDS: string[] = [];

export function analyzeProductStructure(name: string, productType?: string): ProductAnalysis {
  const none: ProductAnalysis = { productCandidate: "", langPair: "", direction: "", difficulty: "", industry: "", industry2: "", isOptionCandidate: false, confidenceScore: 0, reviewReasons: [], displayName: "", domain: "", langHint: "" };
  if (!name?.trim()) return none;

  let workName = name.trim();
  let srcCode = ""; let tgtCode = ""; let srcLabel = ""; let tgtLabel = "";
  const detectedLangReviewReasons: string[] = [];
  let isCompactExpansion = false;

  // ── Step 0: 국가명·지역어·도메인·다국어 조기 감지
  const hasCountryKw    = COUNTRY_KEYWORDS.some(kw => name.includes(kw));
  const hasRegionLangKw = REGION_LANGUAGE_KEYWORDS.some(kw => name.includes(kw));
  const hasDomainKw     = /할랄|코셔|종교|이슬람/.test(name);
  const hasMultiLangKw  = /다국어/.test(name);
  const skipLangDetect  = hasCountryKw || hasRegionLangKw;

  // ── Step 0.5: Compact Pattern Pre-Expansion
  // 한영번역, 태한번역 등 separator 없는 2-char 약어 쌍 → ISO pair 형식으로 expand
  // 이후 Step 1 ISO pair 감지가 정상 처리하도록 workName을 변환
  if (!skipLangDetect) {
    const compact = expandCompactPattern(workName);
    if (compact) {
      workName = compact.expanded;
      isCompactExpansion = true;
      detectedLangReviewReasons.push(REVIEW_REASONS.COMPACT_DIRECTION_PATTERN);
    }
  }

  if (!skipLangDetect) {
    // ── Step 1: 범용 ISO pair 감지 (미지원 코드 포함 — xx→yy / xx↔yy / xx-yy / xx_yy)
    // zh-hans/zh-hant 복합 코드 우선 처리 (alternation 순서로 2-3자 코드보다 먼저 매칭)
    const anyPairRx = /\b(zh-hans|zh-hant|[a-z]{2,3})[→↔\-_](zh-hans|zh-hant|[a-z]{2,3})\b/i;
    const isoM = workName.match(anyPairRx);
    if (isoM) {
      srcCode  = isoM[1].toLowerCase();
      tgtCode  = isoM[2].toLowerCase();
      srcLabel = ISO_LABEL[srcCode] ?? `미지원(${srcCode})`;
      tgtLabel = ISO_LABEL[tgtCode] ?? `미지원(${tgtCode})`;
      workName = workName.replace(isoM[0], " ").replace(/\s+/g, " ").trim();
    } else {
      // ── Step 2: 한국어 단어 기반 언어 감지 (길이 내림차순 prefix 스캔)
      // 단음절 alias (m.length===1) 는 바로 다음 문자가 구분자일 때만 허용 — 오파싱 방지
      // 예: "일반번역" → "일"(ja) 미매칭, "한-영번역" → "한"(ko)+"-" 매칭
      const SEP_RX = /^[\s\-_·\/→↔]/;
      let rest = workName;
      let lang1: LangEntry | null = null;
      let lang2: LangEntry | null = null;
      for (const l of SORTED_LANG_ENTRIES) {
        if (!rest.startsWith(l.m)) continue;
        if (l.m.length === 1 && rest.length > 1 && !SEP_RX.test(rest[1])) continue;
        lang1 = l; rest = rest.slice(l.m.length).replace(/^[\s\-_·\/→↔]+/, ""); break;
      }
      if (lang1) {
        rest = rest.replace(/^[\s\-_·\/→↔]+/, "");
        for (const l of SORTED_LANG_ENTRIES) {
          if (l.code !== lang1.code && rest.startsWith(l.m)) {
            if (l.m.length === 1 && rest.length > 1 && !SEP_RX.test(rest[1])) continue;
            lang2 = l; rest = rest.slice(l.m.length).replace(/^[\s\-_·\/→↔]+/, ""); break;
          }
        }
        srcCode = lang1.code; srcLabel = lang1.label;
        if (lang1.reviewReason) detectedLangReviewReasons.push(lang1.reviewReason);
        if (lang2) {
          tgtCode = lang2.code; tgtLabel = lang2.label;
          if (lang2.reviewReason) detectedLangReviewReasons.push(lang2.reviewReason);
        }
        workName = rest;
      }
    }
  }

  // ── Step 5: Product 후보 — 잔여 ISO 토큰 제거 후 canonical 서비스명으로 정규화
  let productCandidate = workName
    .replace(/\b(zh-hans|zh-hant|[a-z]{2,3})[→↔\-_](zh-hans|zh-hant|[a-z]{2,3})\b/gi, " ")
    .replace(/\s+/g, "")
    .trim();

  let isCanonical = false;
  for (const [rx, canonical] of CANONICAL_PRODUCTS) {
    if (rx.test(productCandidate)) { productCandidate = canonical; isCanonical = true; break; }
  }

  if (!srcCode && !productCandidate) return none;

  // ── Step 5b: 설명형/프로젝트명/운영성 항목 감지
  // 강한 프로젝트 패턴 — 원본명 기준
  const PROJ_KW   = /프로젝트|구축|프로세스/;
  // 작업명 패턴 — 비canonical일 때만 적용
  const WORK_DESC_KW = /개발|관리|입력|지원|작업|운영|세팅|대응/;
  // 운영성 비용 항목
  const OPS_ITEM_KW = /사후\s*AS|출장비|퀵비|장비사용료|택배비/i;

  const hasProjKw     = PROJ_KW.test(name);
  const hasWorkDescKw = !isCanonical && WORK_DESC_KW.test(name);
  // 비canonical이면서 잔여 텍스트가 길면 설명형으로 판단
  const isLongNonCanonical = !isCanonical && productCandidate.replace(/\s/g, "").length >= 8;
  const isProjDesc = hasProjKw || isLongNonCanonical;
  const isOpsItem  = OPS_ITEM_KW.test(name) || OPS_ITEM_KW.test(productCandidate);

  // ── Step 5c: 감수/원어민감수 패턴 분석
  const isNativeReview     = /원어민감수/.test(name);
  const isAdditionalReview = /감수추가/.test(name);
  const isExpertReview     = /전문가\s*감수/.test(name);

  // (영문)/(일문)/(중문) 등 괄호 언어 힌트 추출
  const LANG_HINT_MAP: Record<string, string> = { 영문: "en", 일문: "ja", 중문: "zh-hans", 국문: "ko", 한문: "ko" };
  const langHintM   = name.match(/[（(]([가-힣A-Za-z]{2,4})[）)]/);
  const langHintRaw = langHintM ? langHintM[1] : "";
  const langHint    = LANG_HINT_MAP[langHintRaw] ?? "";

  // [도메인] + 감수 패턴 추출 (괄호 힌트 제거 후)
  const DOMAIN_RX       = /(SW교육|SW|IT|법률|의료|금융|특허|의학|약학|문학|과학|기술|교육|경제|환경|건축|농업)/;
  const nameClean       = name.replace(/[（(][^）)]*[）)]/g, "").trim();
  const domainM         = nameClean.match(DOMAIN_RX);
  const extractedDomain = domainM ? domainM[1] : "";
  const hasDomainReview = !!(extractedDomain && (productCandidate === "감수" || isExpertReview));

  // ── Step 6: Language Pair (항상 관계형 ↔) + Direction (방향형)
  // EQUIP_CANONICALS / INTERP_SUBTYPES → displayNamePolicy.ts에서 import
  const isEquipCanonical = EQUIP_CANONICALS.has(productCandidate);
  const isInterp = !isEquipCanonical && (productType === "interpretation" || /통역/.test(productCandidate));
  let langPair = ""; let direction = "";

  if (!skipLangDetect) {
    if (srcCode && tgtCode) {
      langPair  = `${srcLabel} ↔ ${tgtLabel}`;
      direction = isInterp ? "bidirectional" : `${srcCode}→${tgtCode}`;
    } else if (srcCode && srcCode !== "ko") {
      langPair  = `한국어 ↔ ${srcLabel}`;
      direction = isInterp ? "bidirectional" : `ko↔${srcCode}`;
    }
  }

  // ── Step 6b: 번역 표시명 (displayName) — 국가명/지역어 상품은 원본 유지
  let displayName = skipLangDetect ? name.trim() : productCandidate;
  if (!skipLangDetect && productCandidate === "번역" && srcCode && tgtCode && ISO_LABEL[srcCode] && ISO_LABEL[tgtCode]) {
    displayName = `${ISO_LABEL[srcCode]}-${ISO_LABEL[tgtCode]} 번역`;
  }

  // ── Step 6b-2: 통역 subtype displayName — 상품명 스타일 (운영자 검색성 강화)
  // 예: "영어-한국어 동시통역", "베트남어-한국어 위스퍼링통역"
  // displayName은 상품명 형식(-), direction 컬럼이 방향 정보(→/↔) 담당
  if (!skipLangDetect && INTERP_SUBTYPES.has(productCandidate)) {
    if (srcCode && tgtCode && ISO_LABEL[srcCode] && ISO_LABEL[tgtCode]) {
      displayName = `${ISO_LABEL[srcCode]}-${ISO_LABEL[tgtCode]} ${productCandidate}`;
    } else if (srcCode && srcCode !== "ko" && ISO_LABEL[srcCode]) {
      displayName = `한국어-${ISO_LABEL[srcCode]} ${productCandidate}`;
    }
  }

  // ── Step 6b-3: 장비 displayName — 언어 포함 (예: "독일어 통역장비")
  if (isEquipCanonical && srcLabel && !srcLabel.startsWith("미지원")) {
    displayName = `${srcLabel} ${productCandidate}`;
  }

  // ── Step 6c: 감수/원어민감수 displayName 자연어 생성 + direction null화
  if (isNativeReview) {
    const prefixM  = name.match(/^(.+?)원어민감수/);
    const rawPrefix = prefixM ? prefixM[1].trim() : "";
    const langLabel = srcLabel || rawPrefix;
    displayName = langLabel ? `${langLabel} 원어민감수` : "원어민감수";
    direction = "";
  } else if (productCandidate === "감수") {
    if (isAdditionalReview) {
      displayName = "감수 추가";
    } else if (extractedDomain && langHintRaw) {
      displayName = `${extractedDomain} ${langHintRaw} 감수`;
    } else if (extractedDomain) {
      displayName = `${extractedDomain} 감수`;
    } else if (langHintRaw) {
      displayName = `${langHintRaw} 감수`;
    } else {
      displayName = "감수";
    }
    direction = "";
  }

  // ── Step 7: 검토 사유 (Review Reasons)
  const reviewReasons: string[] = [];
  if (!productCandidate) reviewReasons.push("서비스 미인식");
  if (productCandidate && !isCanonical) reviewReasons.push("Product 불명확");
  if (srcLabel.startsWith("미지원") || tgtLabel.startsWith("미지원")) reviewReasons.push("UNKNOWN_LANGUAGE");
  if (hasCountryKw)    reviewReasons.push("COUNTRY_NOT_LANGUAGE");
  if (hasRegionLangKw) reviewReasons.push("REGION_LANGUAGE_AMBIGUOUS");
  if (hasDomainKw)     reviewReasons.push("DOMAIN_BASED");
  if (hasMultiLangKw) reviewReasons.push("MULTI_LANGUAGE_AMBIGUOUS");
  if (isProjDesc) reviewReasons.push("프로젝트명/설명형 가능성");
  if (hasWorkDescKw && !isProjDesc) reviewReasons.push("작업명 패턴");
  if (isOpsItem) reviewReasons.push("운영성 항목 (EX계열 가능)");
  if (hasDomainReview) reviewReasons.push("DOMAIN_SPECIALIZED_REVIEW");
  if (productCandidate === "번역" && !direction && !skipLangDetect && !hasDomainKw) reviewReasons.push("MISSING_DIRECTION");
  detectedLangReviewReasons.forEach(r => { if (!reviewReasons.includes(r)) reviewReasons.push(r); });

  // ── Step 8: Confidence Score (0–100)
  let score = 50;
  if (productCandidate && isCanonical) score += 25;
  else if (productCandidate) score += 5;
  if (langPair) score += 15;
  if (direction && direction !== "bidirectional") score += 5;
  // compact pattern은 명확한 언어쌍 신호 — 부스트 (정보성 reviewReason이므로 페널티 없음)
  if (isCompactExpansion) score += 12;
  if (srcLabel.startsWith("미지원") || tgtLabel.startsWith("미지원")) score -= 20;
  if (!productCandidate) score -= 30;
  if (hasCountryKw)    score -= 30;
  if (hasRegionLangKw) score -= 25;
  if (hasDomainKw)     score -= 10;
  if (hasMultiLangKw) score -= 15;
  // 설명형/프로젝트명 패널티 (canonical이면 약하게, 아니면 강하게)
  if (isProjDesc) score -= isCanonical ? 15 : 22;
  if (hasWorkDescKw && !isProjDesc) score -= 10;
  if (isOpsItem) score -= 12;
  // NON_PENALTY_REASONS (정보성 사유)는 페널티 제외 — reviewReasonRules.ts 참조
  const penaltyCount = reviewReasons.filter(r => !NON_PENALTY_REASONS.has(r)).length;
  score -= penaltyCount * 6;
  const confidenceScore = Math.max(0, Math.min(100, score));

  const isOptionCandidate = !!(productCandidate && (tgtCode || (srcCode && srcCode !== "ko")));
  return { productCandidate, langPair, direction, difficulty: "", industry: "", industry2: "", isOptionCandidate, confidenceScore, reviewReasons, displayName, domain: extractedDomain, langHint: langHintRaw };
}

// ─── taxonomy 자동 추천 ──────────────────────────────────────────────────────
// 중요: 장비 패턴을 통역 패턴보다 먼저 검사해야 "동시통역장비"가 equipment로 분류됨
function suggestProductType(name: string, mainCategory?: string): string {
  const text = normalizeProdName((name ?? "") + (mainCategory ?? ""));
  if (/장비|부스|수신기|송신기|헤드셋|리시버|fm|마이크|음향|pa장비/.test(text)) return "equipment";
  if (/동시통역|순차통역|수행통역|위스퍼링|화상통역|전화통역|미팅통역|전시회통역|현장통역|수행비서통역|출장이동|취소보상|할증|연장료|야간|휴일|대기료/.test(text)) return "interpretation";
  if (/배송|퀵|숙박|식비|식대|교통비|출장비|인쇄|우편|택배|실비/.test(text)) return "expense";
  if (/번역|감수|공증|원어민|교정/.test(text)) return "translation";
  return "";
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
    quantityUnit, usagePeriod, interpretationDirection,
  } = req.body as {
    productType?: string; sourceLanguage?: string; targetLanguage?: string;
    mainCategory?: string; subCategory?: string;
    name?: string; unit?: string; basePrice?: number; description?: string;
    interpretationDuration?: string; overtimePrice?: number;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
    quantityUnit?: string; usagePeriod?: string; interpretationDirection?: string;
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
        quantityUnit: quantityUnit?.trim() || null,
        usagePeriod: usagePeriod?.trim() || null,
        interpretationDirection: interpretationDirection?.trim() || null,
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

// ─── Import Preview (Dry-run) ─────────────────────────────────────────────────
router.post("/admin/products/import/preview", ...adminOnly, excelUpload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "파일이 없습니다." }); return; }

  type PreviewStatus = "new" | "duplicate" | "conflict" | "review";
  type PreviewItem = {
    rowNum: number; name: string; productType: string; mainCategory: string;
    subCategory: string; sourceLanguage: string | null; targetLanguage: string | null;
    unit: string; basePrice: number | null; description: string | null;
    status: PreviewStatus; issues: string[]; suggestedType: string;
    duplicateOf: { code: string; name: string }[];
    analysis: ProductAnalysis;
  };

  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: (string | number | undefined)[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    if (rows.length < 2) { res.status(400).json({ error: "데이터 행이 없습니다." }); return; }

    const existingProducts = await db
      .select({ id: productsTable.id, code: productsTable.code, name: productsTable.name, productType: productsTable.productType, mainCategory: productsTable.mainCategory })
      .from(productsTable)
      .where(isNull(productsTable.deletedAt));

    const TYPE_LABEL_REV: Record<string, string> = {};
    for (const [k, v] of Object.entries(PRODUCT_TYPES)) TYPE_LABEL_REV[v.label] = k;

    const items: PreviewItem[] = [];

    for (let i = 1; i < rows.length; i++) {
      const rowNum = i + 1;
      const r = rows[i];
      const typeRaw   = String(r[1] ?? "").trim();
      const srcLang   = String(r[2] ?? "").trim().toLowerCase() || null;
      const tgtLang   = String(r[3] ?? "").trim().toLowerCase() || null;
      const mainCat   = String(r[4] ?? "").trim();
      const subCat    = String(r[5] ?? "").trim() || "";
      const nameRaw   = String(r[6] ?? "").trim();
      const unitRaw   = String(r[7] ?? "").trim();
      const baseRaw   = r[8] !== "" && r[8] != null ? Number(r[8]) : null;
      const desc      = String(r[11] ?? "").trim() || null;

      if (!typeRaw && !mainCat && !nameRaw) continue;

      const issues: string[] = [];
      let status: PreviewStatus = "new";

      const pType = TYPE_LABEL_REV[typeRaw] ?? typeRaw;

      if (!PRODUCT_TYPES[pType]) {
        issues.push(`상품유형 인식 불가: '${typeRaw}'`); status = "review";
      }
      if (!nameRaw) {
        issues.push("상품명 없음"); status = "review";
      } else if (nameRaw.length < 2) {
        issues.push("상품명 너무 짧음"); if (status === "new") status = "review";
      }
      if (!mainCat) {
        issues.push("대분류 없음"); if (status === "new") status = "review";
      }
      if (!unitRaw) {
        issues.push("단위 없음"); if (status === "new") status = "review";
      }
      if (baseRaw !== null && isNaN(baseRaw)) {
        issues.push(`단가 숫자 오류: '${r[8]}'`); if (status === "new") status = "review";
      }

      const validUnits = UNITS_BY_TYPE[pType] ?? ["건"];
      const unit = validUnits.includes(unitRaw) ? unitRaw : (unitRaw || validUnits[0]);
      if (unitRaw && !validUnits.includes(unitRaw)) {
        issues.push(`단위 '${unitRaw}' → '${unit}' 자동 조정`);
      }
      const basePrice = baseRaw !== null && !isNaN(baseRaw) ? Math.round(baseRaw) : null;

      const suggestedType = suggestProductType(nameRaw, mainCat);
      if (suggestedType && PRODUCT_TYPES[pType] && suggestedType !== pType) {
        issues.push(`taxonomy 추천: ${PRODUCT_TYPES[suggestedType]?.label ?? suggestedType}`);
      }

      const nameNorm = normalizeProdName(nameRaw);
      const duplicateOf: { code: string; name: string }[] = [];
      for (const ep of existingProducts) {
        if (normalizeProdName(ep.name) === nameNorm) {
          duplicateOf.push({ code: ep.code, name: ep.name });
          if (!issues.some(s => s.startsWith("유사 중복"))) {
            issues.push(`유사 중복: ${ep.code} (${ep.name})`);
          }
        }
      }
      if (duplicateOf.length > 0) {
        status = duplicateOf.some(d => d.name === nameRaw) ? "conflict" : "duplicate";
      }

      let analysis = analyzeProductStructure(nameRaw, pType);

      // zh-hant 신규 생성 시 기존 ZH 계열 상품 variant 경고
      // 실제 duplicate merge 아님 — 운영자 인지 목적 warning 수준
      if (status !== "duplicate" && status !== "conflict") {
        const normSrcA = normalizeLangCode(srcLang);
        const normTgtA = normalizeLangCode(tgtLang);
        if (normSrcA === "zh-hant" || normTgtA === "zh-hant") {
          const hasZhVariant = existingProducts.some(ep =>
            ep.productType === pType && ep.mainCategory === mainCat && /-ZH-/.test(ep.code)
          );
          if (hasZhVariant) {
            analysis = { ...analysis, reviewReasons: [...analysis.reviewReasons, "POTENTIAL_VARIANT_DUPLICATE"] };
            if (status === "new") status = "review";
          }
        }
      }

      items.push({ rowNum, name: nameRaw, productType: pType, mainCategory: mainCat, subCategory: subCat,
        sourceLanguage: srcLang, targetLanguage: tgtLang, unit, basePrice, description: desc,
        status, issues, suggestedType: suggestedType !== pType ? suggestedType : "", duplicateOf, analysis });
    }

    // 옵션화 가능 탐지: 동일 productCandidate + 다른 langPair 조합이 2개 이상인 항목
    const candidateGroups: Record<string, number> = {};
    for (const item of items) {
      if (item.analysis.isOptionCandidate && item.analysis.productCandidate) {
        candidateGroups[item.analysis.productCandidate] = (candidateGroups[item.analysis.productCandidate] ?? 0) + 1;
      }
    }
    for (const item of items) {
      if (item.analysis.isOptionCandidate && item.analysis.productCandidate &&
          (candidateGroups[item.analysis.productCandidate] ?? 0) > 1) {
        item.analysis = { ...item.analysis, isOptionCandidate: true };
      }
    }

    const summary = {
      total: items.length,
      new: items.filter(x => x.status === "new").length,
      duplicate: items.filter(x => x.status === "duplicate").length,
      conflict: items.filter(x => x.status === "conflict").length,
      review: items.filter(x => x.status === "review").length,
    };

    res.json({ summary, items, fileName: req.file.originalname });
  } catch (err) {
    req.log.error({ err }, "Products import preview failed");
    res.status(500).json({ error: "파일 파싱 실패." });
  }
});

// ─── Import Execute ───────────────────────────────────────────────────────────
router.post("/admin/products/import/execute", ...adminOnly, async (req, res) => {
  type ExecuteRow = {
    rowNum?: number; name: string; productType: string;
    mainCategory: string; subCategory?: string;
    sourceLanguage?: string | null; targetLanguage?: string | null;
    unit?: string; basePrice?: number | null; description?: string | null;
  };
  const { rows, fileName } = req.body as { rows: ExecuteRow[]; fileName?: string };

  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: "등록할 행이 없습니다." }); return;
  }

  const result = { created: 0, skipped: 0, errors: [] as { row: number; message: string }[] };

  try {
    for (const row of rows) {
      const rowNum = row.rowNum ?? 0;
      const pType  = row.productType;
      if (!PRODUCT_TYPES[pType]) {
        result.errors.push({ row: rowNum, message: `상품유형 오류: '${pType}'` }); continue;
      }
      if (!row.name?.trim()) {
        result.errors.push({ row: rowNum, message: "상품명 없음" }); continue;
      }
      const srcLang = row.sourceLanguage ?? null;
      const tgtLang = row.targetLanguage ?? null;
      const mainCat = row.mainCategory ?? "";
      const subCat  = row.subCategory  ?? "";
      const validUnits = UNITS_BY_TYPE[pType] ?? ["건"];
      const unit = row.unit && validUnits.includes(row.unit) ? row.unit : validUnits[0];
      try {
        const code = await generateProductCode(pType, srcLang, tgtLang, mainCat, subCat);
        await db.insert(productsTable).values({
          code, name: row.name.trim(), productType: pType,
          sourceLanguage: srcLang, targetLanguage: tgtLang,
          mainCategory: mainCat || null, subCategory: subCat || null,
          unit, basePrice: row.basePrice ?? null, description: row.description ?? null,
        });
        result.created++;
      } catch (rowErr) {
        result.errors.push({ row: rowNum, message: `저장 오류: ${(rowErr as Error).message}` });
      }
    }

    await logEvent("products", 0, "products_imported", req.log, req.user as any, {
      fileName: fileName ?? "unknown", created: result.created, errors: result.errors.length,
    });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Products import execute failed");
    res.status(500).json({ error: "가져오기 실패." });
  }
});

// ─── 엑셀 업로드 (레거시 direct-import) ──────────────────────────────────────
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

// ─── 상품 등록 요청 삭제 ──────────────────────────────────────────────────────
router.delete("/admin/product-requests/:id", ...adminOnly, async (req, res) => {
  const requestId = Number(req.params.id);
  if (isNaN(requestId) || requestId <= 0) {
    res.status(400).json({ error: "유효하지 않은 요청 id." }); return;
  }
  try {
    const [request] = await db.select().from(productRequestsTable).where(eq(productRequestsTable.id, requestId));
    if (!request) { res.status(404).json({ error: "요청을 찾을 수 없습니다." }); return; }
    const performer = req.user as { id: number; email: string } | undefined;
    await db.delete(productRequestsTable).where(eq(productRequestsTable.id, requestId));
    await logEvent("product_request", requestId, "product_request_deleted", req.log, performer as any,
      JSON.stringify({ name: request.name, status: request.status }));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "ProductRequests: failed to delete");
    res.status(500).json({ error: "상품 요청 삭제 실패." });
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
    quantityUnit, usagePeriod, interpretationDirection,
    sourceLanguage, targetLanguage,
  } = req.body as {
    name?: string; mainCategory?: string; subCategory?: string;
    unit?: string; basePrice?: number; description?: string; active?: boolean;
    interpretationDuration?: string; overtimePrice?: number | null;
    options?: { optionType: string; optionValue: string; sortOrder?: number }[];
    quantityUnit?: string; usagePeriod?: string | null; interpretationDirection?: string;
    sourceLanguage?: string | null; targetLanguage?: string | null;
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
        quantityUnit: quantityUnit !== undefined ? (quantityUnit?.trim() || null) : existing.quantityUnit,
        usagePeriod: usagePeriod !== undefined ? (usagePeriod !== null ? (usagePeriod.trim() || null) : null) : existing.usagePeriod,
        interpretationDirection: interpretationDirection !== undefined ? (interpretationDirection?.trim() || null) : existing.interpretationDirection,
        sourceLanguage: sourceLanguage !== undefined ? (sourceLanguage?.trim() || null) : existing.sourceLanguage,
        targetLanguage: targetLanguage !== undefined ? (targetLanguage?.trim() || null) : existing.targetLanguage,
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
