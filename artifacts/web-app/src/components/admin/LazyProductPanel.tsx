import React, { useState, useCallback } from 'react';
import { api, LANGUAGE_CODES, SUB_CATEGORIES_BY_MAIN, MAIN_CATEGORIES_BY_TYPE } from '../../lib/constants';
import { Card, PrimaryBtn, GhostBtn } from '../ui';
import { getZhExcludeCodes, normalizeZhForType } from '../../lib/zhLangPolicy';
import { LanguageSearchSelect, LangCustomInput } from './LanguageSearchSelect';

// ─── 상품유형 정의 (표시 순서 통일) ───────────────────────────────────────────

const QUICK_TYPES = [
  "번역", "통역", "통번역", "감수",
  "통역장비", "편집/DTP", "미디어", "운영/실비", "프로젝트",
] as const;
type QuickType = typeof QUICK_TYPES[number];
type LangPairType = "번역" | "통역" | "통번역" | "감수";

const LANG_PAIR_SET = new Set<QuickType>(["번역", "통역", "통번역", "감수"]);

const QUICK_TO_PRODUCT_TYPE: Record<QuickType, string> = {
  "번역": "translation",  "통역": "interpretation",
  "통번역": "combined",   "감수": "proofreading",
  "통역장비": "equipment", "편집/DTP": "editing",
  "미디어": "media",       "운영/실비": "operations",
  "프로젝트": "project",
};

// ─── 하위유형 설정 ─────────────────────────────────────────────────────────────

type LangSubtypeEntry = {
  label: string;
  lazyService: string | null; // null = 기타 직접입력 → direct POST
  mainCategory: string;
  isCustom?: boolean;
};

const LANG_SUBTYPES: Record<LangPairType, LangSubtypeEntry[]> = {
  "번역": [
    { label: "번역",      lazyService: "번역",      mainCategory: "번역" },
    { label: "출판번역",  lazyService: "출판번역",  mainCategory: "출판번역" },
    { label: "번역공증",  lazyService: "번역공증",  mainCategory: "번역공증" },
    { label: "영상번역",  lazyService: "영상번역",  mainCategory: "영상번역" },
    { label: "자막번역",  lazyService: "자막번역",  mainCategory: "자막번역" },
    { label: "SW번역",    lazyService: "SW번역",    mainCategory: "SW번역" },
    { label: "기타번역",  lazyService: null,        mainCategory: "기타번역", isCustom: true },
  ],
  "통역": [
    { label: "동시통역",    lazyService: "동시통역",    mainCategory: "동시통역" },
    { label: "위스퍼링통역", lazyService: "위스퍼링통역", mainCategory: "위스퍼링통역" },
    { label: "순차통역",    lazyService: "순차통역",    mainCategory: "순차통역" },
    { label: "수행통역",    lazyService: "수행통역",    mainCategory: "수행통역" },
    { label: "상담회통역",  lazyService: "상담회통역",  mainCategory: "미팅통역" },
    { label: "다국어릴레이", lazyService: "다국어릴레이", mainCategory: "다국어릴레이" },
    { label: "기타통역",    lazyService: null,          mainCategory: "기타통역", isCustom: true },
    // 기타비용 — 통역 수행에 직접 연결되는 부대비용 상품(언어쌍 없음). 상품명=비용 항목명 자유입력.
    { label: "기타비용",    lazyService: null,          mainCategory: "기타비용", isCustom: true },
  ],
  "통번역": [
    { label: "일반통번역",  lazyService: "통번역",      mainCategory: "번역" },
    { label: "출장통번역",  lazyService: "출장통번역",  mainCategory: "출장통번역" },
    { label: "전시회통번역", lazyService: "전시회통번역", mainCategory: "전시회통번역" },
    { label: "상담회통번역", lazyService: "상담회통번역", mainCategory: "상담회통번역" },
    { label: "IR통번역",   lazyService: "IR통번역",    mainCategory: "IR통번역" },
    { label: "기타통번역",  lazyService: null,          mainCategory: "기타통번역", isCustom: true },
  ],
  "감수": [
    { label: "일반감수",   lazyService: "감수",      mainCategory: "감수" },
    { label: "원어민감수", lazyService: "원어민감수", mainCategory: "원어민감수" },
    { label: "원문대조감수", lazyService: "원문대조감수", mainCategory: "원문대조감수" },
    { label: "AI감수",    lazyService: "AI감수",    mainCategory: "AI감수" },
    { label: "기타감수",   lazyService: null,        mainCategory: "기타감수", isCustom: true },
  ],
};

// 각 언어쌍 타입의 기본 하위유형
const DEFAULT_LANG_SUBTYPE: Record<LangPairType, string> = {
  "번역": "번역", "통역": "동시통역", "통번역": "일반통번역", "감수": "일반감수",
};

// ─── 비언어 타입 항목 설정 ─────────────────────────────────────────────────────

type NonLangItem = { label: string; mainCategory: string; subCategory: string; isCustom?: boolean };

const EQUIP_ITEMS: NonLangItem[] = [
  { label: "동시통역장비", mainCategory: "동시통역장비", subCategory: ""           },
  { label: "FM장비",       mainCategory: "동시통역장비", subCategory: "FM장비"     },
  { label: "적외선장비",   mainCategory: "동시통역장비", subCategory: "적외선장비" },
  { label: "수신기",       mainCategory: "동시통역장비", subCategory: "리시버"     },
  { label: "송신기",       mainCategory: "동시통역장비", subCategory: "송신기"     },
  { label: "부스",         mainCategory: "부스장비",     subCategory: "통역부스"   },
  { label: "마이크",       mainCategory: "마이크장비",   subCategory: ""           },
  { label: "기타장비",     mainCategory: "기타장비",     subCategory: "", isCustom: true },
];

const EDITING_ITEMS: NonLangItem[] = [
  { label: "편집",    mainCategory: "편집/DTP", subCategory: "편집"     },
  { label: "DTP",     mainCategory: "편집/DTP", subCategory: "DTP"      },
  { label: "인쇄",    mainCategory: "편집/DTP", subCategory: "인쇄"     },
  { label: "디자인",  mainCategory: "편집/DTP", subCategory: "디자인"   },
  { label: "PPT작업", mainCategory: "편집/DTP", subCategory: "PPT작업"  },
  { label: "기타편집", mainCategory: "편집/DTP", subCategory: "기타편집", isCustom: true },
];

const MEDIA_ITEMS: NonLangItem[] = [
  { label: "STT",      mainCategory: "미디어", subCategory: "STT"       },
  { label: "TTS",      mainCategory: "미디어", subCategory: "TTS"       },
  { label: "자막",     mainCategory: "미디어", subCategory: "자막작업"   },
  { label: "녹취록",   mainCategory: "미디어", subCategory: "녹취록"    },
  { label: "영상편집", mainCategory: "미디어", subCategory: "영상편집"  },
  { label: "기타미디어", mainCategory: "미디어", subCategory: "기타미디어", isCustom: true },
];

// 운영/실비 — 대분류별 "기타*" subcat 레이블
const OPS_CUSTOM_SUBCAT: Record<string, string> = {
  "교통비": "기타교통", "식대": "기타식대", "숙박": "기타숙박", "기타실비": "기타실비",
};

// ─── 타입별 색상/아이콘 ────────────────────────────────────────────────────────

const TYPE_COLOR: Record<QuickType, { bg: string; color: string; border: string; icon: string }> = {
  "번역":     { bg: "#eff6ff", color: "#2563eb", border: "#bfdbfe", icon: "📄" },
  "통역":     { bg: "#f5f3ff", color: "#7c3aed", border: "#ddd6fe", icon: "🎧" },
  "통번역":   { bg: "#fdf4ff", color: "#9333ea", border: "#e9d5ff", icon: "🌐" },
  "감수":     { bg: "#f0fdfa", color: "#0f766e", border: "#99f6e4", icon: "✏️" },
  "통역장비": { bg: "#fff7ed", color: "#c2410c", border: "#fed7aa", icon: "🎛️" },
  "편집/DTP": { bg: "#fef3c7", color: "#92400e", border: "#fde68a", icon: "🖨️" },
  "미디어":   { bg: "#fdf2f8", color: "#db2777", border: "#fbcfe8", icon: "🎬" },
  "운영/실비":{ bg: "#f0fdf4", color: "#059669", border: "#bbf7d0", icon: "🏃" },
  "프로젝트": { bg: "#f8fafc", color: "#334155", border: "#e2e8f0", icon: "📋" },
};

// ─── 타입 ─────────────────────────────────────────────────────────────────────

type ExistingProduct = { id: number; code: string; name: string; active: boolean };

type QuickCandidate = {
  name: string;
  productType: string;
  mainCategory: string;
  subCategory: string;
  isLangPair: boolean;
  isLazy: boolean;       // true = lazy API, false = direct POST
  lazyServiceType?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  targetLanguages?: string[]; // 다국어릴레이 대상언어(정렬본)
  reviewLanguageMode?: "single" | "pair"; // 원어민감수 언어 방식
  reviewLanguage?: string;                 // 원어민감수 단일언어 감수언어
  unit?: string;
  canonicalKey?: string;
};

type QuickResult =
  | { found: true;  product: ExistingProduct }
  | { found: false; candidate: QuickCandidate };

// ─── 언어 레이블 맵 ───────────────────────────────────────────────────────────

const LANG_LABEL: Record<string, string> = Object.fromEntries(
  LANGUAGE_CODES.map(l => [l.code, l.label])
);

// ─── 스타일 헬퍼 ──────────────────────────────────────────────────────────────

function chipStyle(active: boolean, col: { bg: string; color: string; border: string }): React.CSSProperties {
  return {
    fontSize: 12, padding: "5px 10px", borderRadius: 6, cursor: "pointer",
    fontWeight: active ? 700 : 500, whiteSpace: "nowrap",
    border: `1px solid ${active ? col.border : "#e5e7eb"}`,
    background: active ? col.bg : "#fff",
    color: active ? col.color : "#6b7280",
  };
}

function inlineInput(placeholder: string): React.CSSProperties {
  return {
    padding: "6px 10px", fontSize: 12, borderRadius: 6,
    border: "1px solid #d1d5db", color: "#111827",
    background: "#fff", minWidth: 160,
  };
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  token: string;
  authHeaders: Record<string, string>;
  setToast: (msg: string) => void;
  onProductCreated: () => void;
}

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────

export function LazyProductPanel({ authHeaders, setToast, onProductCreated }: Props) {

  // ── 공통 상태 ──────────────────────────────────────────────────────────────
  const [quickType, setQuickType]   = useState<QuickType>("번역");
  const [result, setResult]         = useState<QuickResult | null>(null);
  const [loading, setLoading]       = useState(false);
  const [creating, setCreating]     = useState(false);
  const [created, setCreated]       = useState<ExistingProduct | null>(null);

  // ── 언어쌍 공통 ────────────────────────────────────────────────────────────
  const [srcLang, setSrcLang]       = useState("ko");
  const [tgtLang, setTgtLang]       = useState("en");
  const [srcLangCustom, setSrcLangCustom] = useState("");
  const [tgtLangCustom, setTgtLangCustom] = useState("");
  const [langSubtype, setLangSubtype]     = useState<string>("번역");
  const [langSubtypeCustom, setLangSubtypeCustom] = useState(""); // 기타* 직접입력
  const [relayTargets, setRelayTargets]   = useState<string[]>([]); // 다국어릴레이 대상언어(복수)
  const [reviewMode, setReviewMode]       = useState<"single" | "pair">("single"); // 원어민감수 언어 방식
  const [reviewLang, setReviewLang]       = useState("en");    // 원어민감수 단일언어 감수언어
  const [reviewLangCustom, setReviewLangCustom] = useState("");

  // ── 비언어 공통 ────────────────────────────────────────────────────────────
  const [nlItem, setNlItem]           = useState("");  // 통역장비/편집/미디어
  const [nlItemCustom, setNlItemCustom] = useState(""); // 기타* item
  const [nlMainCat, setNlMainCat]     = useState(() =>
    MAIN_CATEGORIES_BY_TYPE["operations"]?.[0]?.label ?? "교통비"
  );
  const [nlSubCat, setNlSubCat]       = useState(""); // 운영/실비 subcat
  const [nlSubCatCustom, setNlSubCatCustom] = useState(""); // 기타* subcat
  const [nlProjectCat, setNlProjectCat] = useState(() =>
    MAIN_CATEGORIES_BY_TYPE["project"]?.[0]?.label ?? "번역프로젝트"
  );
  const [nlProjectName, setNlProjectName] = useState("");

  // ── 편의 파생 ──────────────────────────────────────────────────────────────
  const tc = TYPE_COLOR[quickType];
  const isLangPair  = LANG_PAIR_SET.has(quickType);
  const productType = QUICK_TO_PRODUCT_TYPE[quickType];

  const currentProductType = isLangPair ? productType : "";
  const zhExclude = getZhExcludeCodes(currentProductType);
  const langExclude = ["other", ...zhExclude];

  const currentSubtypes = isLangPair ? LANG_SUBTYPES[quickType as LangPairType] : [];
  const currentSubtypeCfg = currentSubtypes.find(s => s.label === langSubtype);

  // 기타비용: 통역 부대비용 상품(언어쌍 없음). 언어선택 UI를 숨기고 비용 항목명만 자유입력받는다.
  const isCostItem = quickType === "통역" && langSubtype === "기타비용";

  // 다국어 릴레이: 출발언어 → 기준언어(Pivot) → 대상언어(복수) 3단 입력
  const isRelay = quickType === "통역" && langSubtype === "다국어릴레이";

  // 원어민감수: 단일언어(감수언어 1개) / 언어쌍(출발·도착) 방식 선택
  const isNativeReview = quickType === "감수" && langSubtype === "원어민감수";
  const isNativeSingle = isNativeReview && reviewMode === "single";
  const reviewLabel = reviewLang === "custom"
    ? (reviewLangCustom.trim() || "기타언어")
    : (LANG_LABEL[reviewLang] ?? reviewLang);

  const resolveLang = (code: string, custom: string) =>
    code === "custom" ? custom.trim() : code;

  const srcLabel = srcLang === "custom"
    ? (srcLangCustom.trim() || "기타언어")
    : (LANG_LABEL[srcLang] ?? srcLang);
  const tgtLabel = tgtLang === "custom"
    ? (tgtLangCustom.trim() || "기타언어")
    : (LANG_LABEL[tgtLang] ?? tgtLang);

  // ── 리셋 ───────────────────────────────────────────────────────────────────
  const resetResult = useCallback(() => { setResult(null); setCreated(null); }, []);

  const handleTypeChange = (qt: QuickType) => {
    resetResult();
    setLangSubtypeCustom("");
    setRelayTargets([]);
    setReviewMode("single");
    setNlItemCustom("");
    setNlSubCatCustom("");
    if (LANG_PAIR_SET.has(qt)) {
      // 타입 전환 시 zh 정규화
      const newPt = QUICK_TO_PRODUCT_TYPE[qt];
      setSrcLang(prev => normalizeZhForType(prev, newPt));
      setTgtLang(prev => normalizeZhForType(prev, newPt));
      setLangSubtype(DEFAULT_LANG_SUBTYPE[qt as LangPairType]);
    } else {
      setNlItem("");
      if (qt === "운영/실비") {
        setNlMainCat(MAIN_CATEGORIES_BY_TYPE["operations"]?.[0]?.label ?? "교통비");
        setNlSubCat("");
      }
      if (qt === "프로젝트") {
        setNlProjectCat(MAIN_CATEGORIES_BY_TYPE["project"]?.[0]?.label ?? "번역프로젝트");
        setNlProjectName("");
      }
    }
    setQuickType(qt);
  };

  // ── 비언어 항목 목록 ────────────────────────────────────────────────────────
  const getNlItems = (): NonLangItem[] => {
    if (quickType === "통역장비") return EQUIP_ITEMS;
    if (quickType === "편집/DTP") return EDITING_ITEMS;
    if (quickType === "미디어")   return MEDIA_ITEMS;
    return [];
  };
  const nlItems = getNlItems();
  const nlItemCfg = nlItems.find(i => i.label === nlItem);

  // 운영/실비 subcats (현재 mainCat 기준)
  const opsSubcats = SUB_CATEGORIES_BY_MAIN[nlMainCat] ?? [];
  const opsCustomLabel = OPS_CUSTOM_SUBCAT[nlMainCat] ?? "기타";
  const isOpsSubCatCustom = nlSubCat === opsCustomLabel;

  // ── 미리보기 이름 ──────────────────────────────────────────────────────────
  const previewName = (() => {
    if (isCostItem) return langSubtypeCustom.trim() || "비용 항목명";
    if (isNativeReview) {
      return isNativeSingle
        ? `${reviewLabel} 원어민감수`
        : `${srcLabel}→${tgtLabel} 원어민감수`;
    }
    if (isRelay) {
      const tgtLabels = relayTargets.map(c => LANG_LABEL[c] ?? c);
      const tail = tgtLabels.length ? tgtLabels.join("·") : "대상언어";
      return `${srcLabel} → ${tgtLabel} → ${tail} 다국어릴레이`;
    }
    if (isLangPair) {
      const subtypeLabel = currentSubtypeCfg?.isCustom
        ? (langSubtypeCustom.trim() || "직접입력")
        : (langSubtype || quickType);
      return `${srcLabel}-${tgtLabel} ${subtypeLabel}`;
    }
    if (quickType === "운영/실비") {
      if (isOpsSubCatCustom) return nlSubCatCustom.trim() || opsCustomLabel;
      return nlSubCat || nlMainCat;
    }
    if (quickType === "프로젝트") {
      return nlProjectName.trim() || nlProjectCat;
    }
    if (nlItemCfg?.isCustom) return nlItemCustom.trim() || "직접입력";
    return nlItem || "—";
  })();

  // ── 원어민감수 단일언어 조회 (감수언어 1개, 출발/도착 없음) ──────────────────
  const handleNativeSingleLookup = async () => {
    const resolvedReview = resolveLang(reviewLang, reviewLangCustom);
    if (!resolvedReview) { setToast("감수언어를 선택하세요."); return; }
    setLoading(true); resetResult();
    try {
      const res = await fetch(api("/api/admin/products/lazy-lookup"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ serviceType: "원어민감수", reviewLanguageMode: "single", reviewLanguage: resolvedReview }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(data.error ?? "조회 실패"); return; }
      if (data.found) {
        setResult({ found: true, product: data.product });
      } else {
        const c = data.candidate;
        setResult({ found: false, candidate: {
          name: c.displayName, productType: c.productType,
          mainCategory: c.mainCategory, subCategory: "",
          isLangPair: true, isLazy: true,
          lazyServiceType: "원어민감수",
          reviewLanguageMode: "single", reviewLanguage: c.reviewLanguage ?? resolvedReview,
          canonicalKey: c.canonicalKey, unit: c.unit,
        }});
      }
    } catch { setToast("네트워크 오류"); }
    finally { setLoading(false); }
  };

  // ── 언어쌍 조회 ────────────────────────────────────────────────────────────
  const handleLangLookup = async () => {
    // 원어민감수 단일언어는 별도 흐름
    if (isNativeSingle) { await handleNativeSingleLookup(); return; }

    // 기타비용: 언어쌍 없이 비용 항목명(자유입력)으로 조회·생성. productType=interpretation 유지.
    //   중복판정은 이름 기준 — 이미 동일 비용명이 있으면 기존 상품을 보여주고, 없으면 신규 생성 후보로 제시.
    if (isCostItem) {
      const costName = langSubtypeCustom.trim();
      if (!costName) { setToast("비용 항목명을 입력해주세요."); return; }
      setLoading(true); resetResult();
      try {
        const params = new URLSearchParams({ productType, mainCategory: "기타비용" });
        const res = await fetch(api(`/api/admin/products?${params}`), { headers: authHeaders });
        if (!res.ok) { setToast("조회 실패"); return; }
        const products = await res.json();
        const match = products.find((p: any) => (p.name ?? "").toLowerCase() === costName.toLowerCase());
        if (match) {
          setResult({ found: true, product: match });
        } else {
          // 유형=통역(interpretation) / 세부분류=기타비용 / 이름=비용명(중복판정 키는 subCategory=비용명). 언어 없음.
          setResult({ found: false, candidate: {
            name: costName, productType,
            mainCategory: "기타비용", subCategory: costName,
            isLangPair: false, isLazy: false,
          }});
        }
      } catch { setToast("네트워크 오류"); }
      finally { setLoading(false); }
      return;
    }

    const resolvedSrc = resolveLang(srcLang, srcLangCustom);
    const resolvedTgt = resolveLang(tgtLang, tgtLangCustom);
    if (srcLang === "custom" && !resolvedSrc) { setToast("출발언어 직접 입력값을 입력해주세요."); return; }
    if (tgtLang === "custom" && !resolvedTgt) { setToast("도착언어 직접 입력값을 입력해주세요."); return; }
    if (!resolvedSrc || !resolvedTgt)         { setToast("출발언어와 도착언어를 선택하세요."); return; }
    if (resolvedSrc.toLowerCase() === resolvedTgt.toLowerCase()) { setToast("출발언어와 도착언어가 같습니다."); return; }

    if (!currentSubtypeCfg) { setToast("하위유형을 선택해주세요."); return; }

    // 다국어 릴레이: 대상언어(복수) 검증
    if (isRelay) {
      if (relayTargets.length === 0) { setToast("대상언어를 1개 이상 선택해주세요."); return; }
      if (relayTargets.some(c => c.toLowerCase() === resolvedTgt.toLowerCase())) {
        setToast("기준언어와 대상언어가 중복됩니다."); return;
      }
    }

    // 기타* 직접입력 케이스 → direct POST
    if (currentSubtypeCfg.isCustom) {
      if (!langSubtypeCustom.trim()) { setToast("하위유형 직접 입력값을 입력해주세요."); return; }
      const customName = `${srcLabel}-${tgtLabel} ${langSubtypeCustom.trim()}`;
      setLoading(true); resetResult();
      try {
        const params = new URLSearchParams({ productType });
        const res = await fetch(api(`/api/admin/products?${params}`), { headers: authHeaders });
        if (!res.ok) { setToast("조회 실패"); return; }
        const products = await res.json();
        const match = products.find((p: any) =>
          (p.name ?? "").toLowerCase() === customName.toLowerCase()
        );
        if (match) {
          setResult({ found: true, product: match });
        } else {
          setResult({ found: false, candidate: {
            name: customName, productType,
            mainCategory: currentSubtypeCfg.mainCategory, subCategory: "",
            isLangPair: true, isLazy: false,
            sourceLanguage: resolvedSrc, targetLanguage: resolvedTgt,
          }});
        }
      } catch { setToast("네트워크 오류"); }
      finally { setLoading(false); }
      return;
    }

    // 표준 lazy API (릴레이 포함 — 릴레이는 targetLanguages 추가 전송)
    const serviceType = currentSubtypeCfg.lazyService!;
    setLoading(true); resetResult();
    try {
      const res = await fetch(api("/api/admin/products/lazy-lookup"), {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceType, sourceLanguage: resolvedSrc, targetLanguage: resolvedTgt,
          ...(isRelay ? { targetLanguages: relayTargets } : {}),
          ...(isNativeReview ? { reviewLanguageMode: "pair" } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setToast(data.error ?? "조회 실패"); return; }
      if (data.found) {
        setResult({ found: true, product: data.product });
      } else {
        const c = data.candidate;
        setResult({ found: false, candidate: {
          name: c.displayName, productType: c.productType,
          mainCategory: c.mainCategory, subCategory: "",
          isLangPair: true, isLazy: true,
          lazyServiceType: serviceType,
          sourceLanguage: resolvedSrc, targetLanguage: resolvedTgt,
          ...(isRelay ? { targetLanguages: c.relayLanguages?.targetLanguages ?? relayTargets } : {}),
          ...(isNativeReview ? { reviewLanguageMode: "pair" as const } : {}),
          canonicalKey: c.canonicalKey, unit: c.unit,
        }});
      }
    } catch { setToast("네트워크 오류"); }
    finally { setLoading(false); }
  };

  // ── 비언어 조회 ────────────────────────────────────────────────────────────
  const handleNonLangLookup = async () => {
    let mainCat = "", subCat = "", searchName = "", displayName = "";

    if (quickType === "운영/실비") {
      mainCat = nlMainCat;
      if (isOpsSubCatCustom) {
        if (!nlSubCatCustom.trim()) { setToast("직접 입력값을 입력해주세요."); return; }
        subCat = opsCustomLabel;
        searchName = displayName = nlSubCatCustom.trim();
      } else {
        subCat = nlSubCat;
        displayName = searchName = nlSubCat || nlMainCat;
      }
    } else if (quickType === "프로젝트") {
      mainCat = nlProjectCat;
      displayName = searchName = nlProjectName.trim() || nlProjectCat;
    } else {
      // 통역장비 / 편집/DTP / 미디어
      if (!nlItemCfg) { setToast("항목을 선택해주세요."); return; }
      mainCat = nlItemCfg.mainCategory;
      subCat  = nlItemCfg.subCategory;
      if (nlItemCfg.isCustom) {
        if (!nlItemCustom.trim()) { setToast("직접 입력값을 입력해주세요."); return; }
        displayName = searchName = nlItemCustom.trim();
      } else {
        displayName = searchName = nlItemCfg.label;
      }
    }

    setLoading(true); resetResult();
    try {
      const params = new URLSearchParams({ productType });
      if (mainCat) params.set("mainCategory", mainCat);
      const res = await fetch(api(`/api/admin/products?${params}`), { headers: authHeaders });
      if (!res.ok) { setToast("조회 실패"); return; }
      const products = await res.json();

      const match = products.find((p: any) => {
        if (nlItemCfg?.isCustom || quickType === "프로젝트" || isOpsSubCatCustom) {
          return (p.name ?? "").toLowerCase() === searchName.toLowerCase();
        }
        if (subCat) return p.subCategory === subCat;
        return (p.name ?? "").toLowerCase() === searchName.toLowerCase() ||
               p.mainCategory === mainCat;
      });

      if (match) {
        setResult({ found: true, product: match });
      } else {
        setResult({ found: false, candidate: {
          name: displayName, productType,
          mainCategory: mainCat, subCategory: subCat,
          isLangPair: false, isLazy: false,
        }});
      }
    } catch { setToast("네트워크 오류"); }
    finally { setLoading(false); }
  };

  const handleLookup = () =>
    isLangPair ? handleLangLookup() : handleNonLangLookup();

  // ── 생성 ───────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!result || result.found) return;
    const c = result.candidate;
    setCreating(true);
    try {
      let res: Response;
      if (c.isLazy) {
        res = await fetch(api("/api/admin/products/lazy-create"), {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceType: c.lazyServiceType,
            sourceLanguage: c.sourceLanguage,
            targetLanguage: c.targetLanguage,
            ...(c.targetLanguages?.length ? { targetLanguages: c.targetLanguages } : {}),
            ...(c.reviewLanguageMode ? { reviewLanguageMode: c.reviewLanguageMode } : {}),
            ...(c.reviewLanguage ? { reviewLanguage: c.reviewLanguage } : {}),
            createdBy: "admin",
          }),
        });
      } else {
        res = await fetch(api("/api/admin/products"), {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            productType: c.productType,
            sourceLanguage: c.sourceLanguage ?? null,
            targetLanguage: c.targetLanguage ?? null,
            mainCategory: c.mainCategory,
            subCategory: c.subCategory || null,
            name: c.name,
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        if (data.isDuplicate && data.existing?.length > 0) {
          setResult({ found: true, product: data.existing[0] });
          setToast("ℹ 이미 존재하는 상품입니다.");
        } else {
          setToast(`오류: ${data.error ?? "생성 실패"}`);
        }
        return;
      }
      const product: ExistingProduct = c.isLazy ? data.product : data;
      setCreated(product);
      setResult({ found: true, product });
      setToast(`✅ 상품 생성 완료: ${product.name} (${product.code})`);
      onProductCreated();
    } catch { setToast("네트워크 오류"); }
    finally { setCreating(false); }
  };

  // ── 렌더 ───────────────────────────────────────────────────────────────────
  return (
    <Card style={{ marginBottom: 16, padding: "18px 22px" }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>⚡ 빠른 상품 조회/생성</span>
        <span style={{ fontSize: 11, color: "#6b7280", background: "#f3f4f6", borderRadius: 4, padding: "2px 7px" }}>
          Quick Product Generation
        </span>
      </div>

      {/* ── 상품유형 탭 ── */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 14 }}>
        {QUICK_TYPES.map(qt => (
          <button key={qt} onClick={() => handleTypeChange(qt)}
            style={chipStyle(quickType === qt, TYPE_COLOR[qt])}
            aria-label={`${qt} 선택`}
          >
            {TYPE_COLOR[qt].icon} {qt}
          </button>
        ))}
      </div>

      {/* ── 입력 폼 ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>

        {/* ─── 언어쌍 타입 (번역/통역/통번역/감수) ─── */}
        {isLangPair && (
          <>
            {/* 하위유형 선택 */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>
                {quickType} 유형
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {currentSubtypes.map(s => (
                  <button key={s.label}
                    onClick={() => { setLangSubtype(s.label); setLangSubtypeCustom(""); setRelayTargets([]); setReviewMode("single"); resetResult(); }}
                    style={chipStyle(langSubtype === s.label, tc)}
                    aria-label={s.label}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {/* 기타* 직접입력 / 기타비용 항목명 입력 */}
              {currentSubtypeCfg?.isCustom && (
                isCostItem ? (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>비용 항목명</div>
                    <input
                      value={langSubtypeCustom}
                      onChange={e => { setLangSubtypeCustom(e.target.value); resetResult(); }}
                      placeholder="예: 통역사 교통비, 통역사 출장비"
                      style={{ ...inlineInput(""), width: 260 }}
                      aria-label="비용 항목명"
                    />
                  </div>
                ) : (
                  <input
                    value={langSubtypeCustom}
                    onChange={e => { setLangSubtypeCustom(e.target.value); resetResult(); }}
                    placeholder={`예: IR${quickType}, VIP${quickType}`}
                    style={{ ...inlineInput(""), marginTop: 6, width: 220 }}
                    aria-label="하위유형 직접 입력"
                  />
                )
              )}
            </div>

            {/* ─── 원어민감수: 감수 언어 방식 (단일언어/언어쌍) ─── */}
            {isNativeReview && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>감수 언어 방식</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {([["single", "단일언어"], ["pair", "언어쌍"]] as const).map(([m, label]) => (
                    <button key={m}
                      onClick={() => { setReviewMode(m); resetResult(); }}
                      style={chipStyle(reviewMode === m, tc)}
                      aria-label={`감수 언어 방식 ${label}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ─── 원어민감수 단일언어: 감수언어 1개 ─── */}
            {isNativeSingle && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 200 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af" }}>감수언어</div>
                <LanguageSearchSelect
                  value={reviewLang}
                  onChange={v => { setReviewLang(v); resetResult(); }}
                  excludeCodes={langExclude}
                  customLabel="기타언어"
                  style={{ minWidth: 130 }}
                  triggerStyle={{ fontSize: 13, padding: "7px 10px" }}
                />
                {reviewLang === "custom" && (
                  <LangCustomInput value={reviewLangCustom}
                    onChange={v => { setReviewLangCustom(v); resetResult(); }}
                    placeholder="예: 카자흐어" label="언어명 직접 입력" />
                )}
              </div>
            )}

            {/* 언어 선택 (출발→도착) — 단일언어 방식/기타비용이 아닐 때만 (기타비용은 언어쌍 없음) */}
            {!isNativeSingle && !isCostItem && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af" }}>출발언어</div>
                <LanguageSearchSelect
                  value={srcLang}
                  onChange={v => { setSrcLang(v); resetResult(); }}
                  excludeCodes={langExclude}
                  customLabel="기타언어"
                  style={{ minWidth: 130 }}
                  triggerStyle={{ fontSize: 13, padding: "7px 10px" }}
                />
                {srcLang === "custom" && (
                  <LangCustomInput value={srcLangCustom}
                    onChange={v => { setSrcLangCustom(v); resetResult(); }}
                    placeholder="예: 카자흐어" label="언어명 직접 입력" />
                )}
              </div>

              <span style={{ fontSize: 16, color: "#9ca3af", paddingTop: 20 }}>→</span>

              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af" }}>
                  {isRelay ? "기준언어(중계)" : "도착언어"}
                </div>
                <LanguageSearchSelect
                  value={tgtLang}
                  onChange={v => { setTgtLang(v); resetResult(); }}
                  excludeCodes={langExclude}
                  customLabel="기타언어"
                  style={{ minWidth: 130 }}
                  triggerStyle={{ fontSize: 13, padding: "7px 10px" }}
                />
                {tgtLang === "custom" && (
                  <LangCustomInput value={tgtLangCustom}
                    onChange={v => { setTgtLangCustom(v); resetResult(); }}
                    placeholder="예: 카자흐어" label="언어명 직접 입력" />
                )}
              </div>

              {/* ─── 다국어 릴레이: 대상언어(복수선택) ─── */}
              {isRelay && (
                <>
                  <span style={{ fontSize: 16, color: "#9ca3af", paddingTop: 20 }}>→</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af" }}>
                      대상언어 <span style={{ fontWeight: 400, color: "#c084fc" }}>(복수선택)</span>
                    </div>
                    <LanguageSearchSelect
                      value=""
                      onChange={v => {
                        if (!v || v === "custom") return;
                        setRelayTargets(prev => prev.includes(v) ? prev : [...prev, v]);
                        resetResult();
                      }}
                      excludeCodes={[...langExclude, ...relayTargets, tgtLang, srcLang]}
                      placeholder="대상언어 추가..."
                      style={{ minWidth: 160 }}
                      triggerStyle={{ fontSize: 13, padding: "7px 10px" }}
                    />
                    {relayTargets.length > 0 && (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                        {relayTargets.map(code => (
                          <span key={code}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              fontSize: 12, fontWeight: 600, padding: "3px 8px", borderRadius: 6,
                              background: tc.bg, color: tc.color, border: `1px solid ${tc.border}`,
                            }}
                          >
                            {LANG_LABEL[code] ?? code}
                            <button
                              onClick={() => { setRelayTargets(prev => prev.filter(c => c !== code)); resetResult(); }}
                              aria-label={`${LANG_LABEL[code] ?? code} 제거`}
                              style={{ background: "none", border: "none", cursor: "pointer", color: tc.color, fontSize: 13, lineHeight: 1, padding: 0 }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
            )}
          </>
        )}

        {/* ─── 통역장비 / 편집/DTP / 미디어 ─── */}
        {(quickType === "통역장비" || quickType === "편집/DTP" || quickType === "미디어") && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>항목 선택</div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {nlItems.map(item => (
                <button key={item.label}
                  onClick={() => { setNlItem(item.label); setNlItemCustom(""); resetResult(); }}
                  style={chipStyle(nlItem === item.label, tc)}
                  aria-label={item.label}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {nlItemCfg?.isCustom && (
              <input
                value={nlItemCustom}
                onChange={e => { setNlItemCustom(e.target.value); resetResult(); }}
                placeholder="직접 입력..."
                style={{ ...inlineInput(""), marginTop: 6, width: 200 }}
                aria-label="항목 직접 입력"
              />
            )}
          </div>
        )}

        {/* ─── 운영/실비 ─── */}
        {quickType === "운영/실비" && (
          <>
            {/* 대분류 */}
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>실비 대분류</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(MAIN_CATEGORIES_BY_TYPE["operations"] ?? []).map(c => (
                  <button key={c.label}
                    onClick={() => { setNlMainCat(c.label); setNlSubCat(""); setNlSubCatCustom(""); resetResult(); }}
                    style={chipStyle(nlMainCat === c.label, tc)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            {/* 세부항목 */}
            {opsSubcats.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>
                  세부 항목 <span style={{ fontWeight: 400, color: "#d1d5db" }}>(선택)</span>
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {opsSubcats.map(s => (
                    <button key={s.label}
                      onClick={() => { setNlSubCat(s.label === nlSubCat ? "" : s.label); setNlSubCatCustom(""); resetResult(); }}
                      style={chipStyle(nlSubCat === s.label, tc)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {isOpsSubCatCustom && (
                  <input
                    value={nlSubCatCustom}
                    onChange={e => { setNlSubCatCustom(e.target.value); resetResult(); }}
                    placeholder={`예: 공증서류 발송비`}
                    style={{ ...inlineInput(""), marginTop: 6, width: 220 }}
                    aria-label="기타 항목 직접 입력"
                  />
                )}
              </div>
            )}
          </>
        )}

        {/* ─── 프로젝트 ─── */}
        {quickType === "프로젝트" && (
          <>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>프로젝트 유형</div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {(MAIN_CATEGORIES_BY_TYPE["project"] ?? []).map(c => (
                  <button key={c.label}
                    onClick={() => { setNlProjectCat(c.label); resetResult(); }}
                    style={chipStyle(nlProjectCat === c.label, tc)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>프로젝트명</div>
              <input
                value={nlProjectName}
                onChange={e => { setNlProjectName(e.target.value); resetResult(); }}
                placeholder="예: ABC법률 IR 통역 프로젝트"
                style={{ ...inlineInput(""), width: 280 }}
                aria-label="프로젝트명 입력"
              />
            </div>
          </>
        )}

        {/* 조회 버튼 */}
        <div>
          <PrimaryBtn onClick={handleLookup} disabled={loading}
            style={{ fontSize: 13, padding: "8px 20px" }}
            data-testid="quick-lookup-btn">
            {loading ? "조회 중..." : "조회"}
          </PrimaryBtn>
        </div>
      </div>

      {/* ── 미리보기 ── */}
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
        조회 대상:&nbsp;
        <span style={{
          fontWeight: 700, color: tc.color, background: tc.bg,
          border: `1px solid ${tc.border}`, borderRadius: 4, padding: "1px 8px",
        }}>
          {tc.icon} {previewName}
        </span>
      </div>

      {/* ── 결과 ── */}
      {result && (
        <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
          {result.found ? (
            <div style={{ padding: "10px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 15 }}>✅</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#059669" }}>이미 등록된 상품</span>
                {created && (
                  <span style={{ fontSize: 11, color: "#059669", background: "#ecfdf5", border: "1px solid #6ee7b7", borderRadius: 4, padding: "1px 6px" }}>
                    방금 생성됨
                  </span>
                )}
              </div>
              <div style={{ background: "#fff", border: "1px solid #bbf7d0", borderRadius: 7, padding: "10px 14px" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 4 }}>
                  {result.product.name}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "#6b7280" }}>ID #{result.product.id}</span>
                  <span style={{ fontSize: 11, fontFamily: "monospace", background: "#e5e7eb", padding: "1px 6px", borderRadius: 4, color: "#374151" }}>
                    {result.product.code}
                  </span>
                  {!result.product.active && (
                    <span style={{ fontSize: 11, color: "#dc2626", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 4, padding: "1px 6px" }}>
                      비활성
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 15 }}>✨</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>미등록 상품</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#d97706", background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 4, padding: "1px 8px" }}>
                  자동 생성 가능
                </span>
              </div>
              <div style={{ background: "#fff", border: "1px solid #fcd34d", borderRadius: 7, padding: "10px 14px", marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 6 }}>
                  {result.candidate.name}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
                  <span style={{ background: tc.bg, color: tc.color, border: `1px solid ${tc.border}`, padding: "1px 7px", borderRadius: 4, fontWeight: 600 }}>
                    {tc.icon} {quickType}
                  </span>
                  {result.candidate.mainCategory && (
                    <span style={{ background: "#f3f4f6", padding: "1px 7px", borderRadius: 4, color: "#374151" }}>
                      {result.candidate.mainCategory}
                    </span>
                  )}
                  {result.candidate.subCategory && (
                    <span style={{ background: "#f3f4f6", padding: "1px 7px", borderRadius: 4, color: "#374151" }}>
                      {result.candidate.subCategory}
                    </span>
                  )}
                  {result.candidate.unit && (
                    <span style={{ background: "#f3f4f6", padding: "1px 7px", borderRadius: 4, color: "#374151" }}>
                      단위: {result.candidate.unit}
                    </span>
                  )}
                  {result.candidate.canonicalKey && (
                    <span style={{ fontFamily: "monospace", background: "#fef3c7", padding: "1px 7px", borderRadius: 4, color: "#92400e" }}>
                      {result.candidate.canonicalKey}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <PrimaryBtn onClick={handleCreate} disabled={creating}
                  style={{ fontSize: 13, padding: "8px 20px", background: "#d97706" }}
                  data-testid="quick-create-btn">
                  {creating ? "생성 중..." : "+ 상품 생성"}
                </PrimaryBtn>
                <GhostBtn onClick={resetResult} style={{ fontSize: 13 }}>취소</GhostBtn>
                <span style={{ fontSize: 11, color: "#9ca3af" }}>"조회"만으로는 저장되지 않습니다</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
