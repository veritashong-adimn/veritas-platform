/**
 * inquiryHandoff — 의뢰건 → 견적서 작성 화면으로 정보 전달(1회성 sessionStorage).
 *
 * 의뢰건 상세 [견적서 작성] 클릭 시 회사/담당자/제목/메모 + 서비스별 견적항목(items)을 저장하고
 * 견적 등록 화면으로 이동. QuoteEditorWorkspace 가 신규 견적 진입 시 이 값을 읽어 프리필하고,
 * 저장 성공 후 quoteId 를 의뢰건에 역연결(link-quote)한 뒤 값을 소비/삭제한다.
 * 기존 견적 로직/응답 형태는 변경하지 않는다.
 */

/**
 * QuoteEditorWorkspace 의 QuoteItemForm 부분집합(구조적 타입). 신규 견적 항목 시드용.
 * QuoteEditorWorkspace 에서 { ...defaultItem(), ...item } 으로 병합되므로 필요한 필드만 채운다.
 */
export interface QuoteHandoffItem {
  productType: "translation" | "interpretation" | "equipment" | "expense";
  productName?: string;
  quantity?: string;
  unit?: string;
  memo?: string;
  // 통역 전용
  interpretDate?: string;      // 행사 시작일 (YYYY-MM-DD)
  interpretEndDate?: string;   // 행사 종료일
  interpretHours?: string;
  operationHours?: string;     // 통역 운영시간 "HH:mm~HH:mm" — 의뢰건 일정에 시각이 있을 때만(1일 통역시간은 추정하지 않음)
  interpretPlace?: string;
  // 번역 전용
  sourceLanguage?: string;
  fileFormat?: string;
  // 장비 전용
  eventStartDate?: string;     // 사용 시작일 (YYYY-MM-DD)
  eventEndDate?: string;       // 사용 종료일
  itemLocation?: string;
  usagePeriod?: string;        // 장비 사용(대여)일수 — 장비 수량과 별개(견적 계산: 사용일수 × 수량 × 단가, 기존 정책)
  unitPrice?: string;          // 원본 문서에 명시된 단가(있을 때만) — 견적 단가 칸에 바로 입력
  refUnitPrice?: string;       // 원본 견적 단가 — 내부 보존(화면 미표시)
  refAmount?: string;          // 원본 견적 공급가액 — 계산 결과 대조용(다를 때만 행에 확인 안내)
}

/** 견적 행 상품 추천 조건(의뢰건 값 그대로). 견적 화면이 상품 Master 에서 일치 상품을 찾는다. */
export interface QuoteProductHint {
  itemIndex: number;                       // items 배열의 위치
  productType: QuoteHandoffItem["productType"];
  sourceLanguage?: string;                 // 상품 Master 언어 코드(ko, en …). 모르면 비움
  targetLanguage?: string;
  sourceLanguageName?: string;             // 의뢰건 원문(한국어 …) — 표시용
  targetLanguageName?: string;
  interpretType?: string;                  // 순차통역/동시통역 … (상품 대분류와 비교)
  productName?: string;                    // 장비 — 의뢰건 장비 종류(상품 Master 이름과 정확히 같을 때만 자동 선택)
}

/** 견적 화면에 표시할 의뢰건 고객·요청 정보(정식 필드 연동·Master 연결 안내용). */
export interface QuoteInquiryContext {
  customerCompanyName?: string | null;     // 의뢰건 원문 회사명
  companyNameLinked?: string | null;       // 연결된 거래처 Master 명(있으면)
  contact?: { name?: string | null; position?: string | null; department?: string | null; phone?: string | null; mobile?: string | null; email?: string | null };
  contactNameLinked?: string | null;
  additionalLanguages?: string[];          // "한국어 → 스페인어 (선택 사항)" — 상품 행 자동 생성 안 함
  quoteDueDate?: string | null;            // 고객 견적서 수령 희망일(YYYY-MM-DD) — 견적일과 별개
}

export interface QuotePrefillHandoff {
  inquiryId: number;
  inquiryNumber?: string | null;
  companyId?: number | null;
  contactId?: number | null;
  divisionId?: number | null;
  title?: string;
  note?: string;
  items?: QuoteHandoffItem[];
  productHints?: QuoteProductHint[];       // 추가 필드(구버전 견적 화면은 무시)
  inquiryContext?: QuoteInquiryContext;
}

// ─── 언어 ────────────────────────────────────────────────────────────────────
// 의뢰건 언어명(한국어) ↔ 상품 Master 코드(ko) / 견적서명 약칭(한)
const LANGS: Array<{ name: string; code: string; short: string }> = [
  { name: "한국어", code: "ko", short: "한" }, { name: "영어", code: "en", short: "영" }, { name: "중국어", code: "zh", short: "중" },
  { name: "일본어", code: "ja", short: "일" }, { name: "스페인어", code: "es", short: "스" }, { name: "프랑스어", code: "fr", short: "불" },
  { name: "독일어", code: "de", short: "독" }, { name: "러시아어", code: "ru", short: "러" }, { name: "베트남어", code: "vi", short: "베" },
  { name: "태국어", code: "th", short: "태" }, { name: "인도네시아어", code: "id", short: "인니" }, { name: "아랍어", code: "ar", short: "아랍" },
  { name: "포르투갈어", code: "pt", short: "포" }, { name: "이탈리아어", code: "it", short: "이" }, { name: "몽골어", code: "mn", short: "몽" },
  { name: "우즈베크어", code: "uz", short: "우즈벡" }, { name: "우즈벡어", code: "uz", short: "우즈벡" }, { name: "우크라이나어", code: "uk", short: "우크라" },
  { name: "폴란드어", code: "pl", short: "폴" },
];
const findLang = (v?: string | null) => { const n = (v ?? "").replace(/\s+/g, ""); return n ? LANGS.find(l => l.name === n || l.code === n.toLowerCase()) : undefined; };
export const langCode = (v?: string | null): string | undefined => findLang(v)?.code;
/** "6시간", "1일 6시간", "6.5시간" → "6"/"6.5" (견적 행 통역시간 필드). 시각 범위 등 다른 표현은 '' — 임의 변환하지 않음. */
export function interpretHoursOf(v?: string | null): string {
  const m = (v ?? "").trim().match(/^(?:1\s*일|하루)?\s*(\d+(?:\.\d+)?)\s*시간(?:\s*\/\s*일)?$/);
  return m ? m[1] : "";
}

/** 요구사항에 기록된 추가 언어 요청("추가 언어: 한국어 → 스페인어 (선택 사항)")을 꺼낸다. */
export function additionalLanguagesOf(requirements?: string | null): string[] {
  const line = (requirements ?? "").split(/\r?\n/).find(l => /^\s*추가 언어\s*[:(]/.test(l));
  if (!line) return [];
  return line.replace(/^\s*추가 언어\s*(?:\([^)]*\))?\s*:\s*/, "").split(/\s*,\s*(?=[가-힣]+어\s*→)/).map(x => x.trim()).filter(Boolean);
}

const KEY = "veritasQuotePrefill";

export function setQuoteHandoff(h: QuotePrefillHandoff): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(h)); } catch { /* 세션 사용 불가 시 무시 */ }
}

export function readQuoteHandoff(): QuotePrefillHandoff | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? (JSON.parse(s) as QuotePrefillHandoff) : null;
  } catch { return null; }
}

export function clearQuoteHandoff(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* 무시 */ }
}

/** ISO/datetime 문자열 → 'YYYY-MM-DD' (견적 항목 날짜 필드용). 빈 값은 undefined. */
/** KST 시각(HH:mm). 의뢰건 일정은 시각이 없으면 KST 00:00 으로 저장되므로 00:00 은 '시각 없음'으로 본다(임의 시각 생성 금지). */
function toTimeStr(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) return undefined;
  const t = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
  return t === "00:00" ? undefined : t;
}
/** 장비행 비고 중 의뢰건 분석용 메모("원문 장비명: …", "단위: …")는 고객용 견적 행 메모로 넘기지 않는다 */
function customerEquipmentNote(note?: string): string {
  // 구분자는 " / "(앞뒤 공백) — "9/14" 같은 날짜 표기는 나누지 않는다
  return (note ?? "").split(/\s+\/\s+/).filter(s => s && !/^(?:원문\s*장비명|단위)\s*:/.test(s.trim())).join(" / ");
}

function toDateStr(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (isNaN(d.getTime())) return undefined;
  // KST 기준 날짜
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** equipmentJson 문자열 파싱 → 장비행 배열(안전) */
/**
 * 견적 메모에 넣을 고객담당자 정보.
 * 견적에는 담당자 연락처 컬럼이 없고 담당자 Master 연결(contactId)로만 담당자를 가리킨다. 그래서
 *  · 우선순위: 담당자 Master 가 연결돼 있으면 Master 가 견적의 담당자(Master 는 수정하지 않음).
 *              의뢰 입력값(고객이 원문에 적은 값)은 메모로 함께 전달하고, Master 와 다른 항목은 표시한다.
 *  · Master 미연결: 의뢰 입력값을 메모로 전달(신규 담당자 자동 생성 없음 — 중복 담당자 방지).
 */
export function buildContactNoteLines(d: {
  customerCompanyName?: string | null; department?: string | null; contactName?: string | null; contactPosition?: string | null;
  contactPhone?: string | null; contactMobile?: string | null; contactEmail?: string | null;
  contactId?: number | null; contactNameLinked?: string | null;
  contactEmailLinked?: string | null; contactPhoneLinked?: string | null; contactMobileLinked?: string | null;
}): string[] {
  const who = [d.contactName, d.contactPosition].filter(Boolean).join(" ");
  const org = [d.department, d.customerCompanyName].filter(Boolean).join(" · ");
  const contacts = [d.contactPhone ? `T ${d.contactPhone}` : "", d.contactMobile ? `M ${d.contactMobile}` : "", d.contactEmail ? `E ${d.contactEmail}` : ""].filter(Boolean).join(" / ");
  const lines: string[] = [];
  if (who || org) lines.push(`고객담당자(의뢰 입력): ${[who, org].filter(Boolean).join(" · ")}`);
  if (contacts) lines.push(`연락처: ${contacts}`);
  if (d.contactId) {
    const norm = (v?: string | null) => (v ?? "").replace(/[\s-]/g, "").toLowerCase();
    const diffs = ([
      ["이름", d.contactNameLinked, d.contactName],
      ["이메일", d.contactEmailLinked, d.contactEmail],
      ["전화", d.contactPhoneLinked, d.contactPhone],
      ["휴대폰", d.contactMobileLinked, d.contactMobile],
    ] as const).filter(([, m, i]) => i && norm(m) !== norm(i)).map(([k, m, i]) => `${k} Master「${m || "없음"}」/ 의뢰「${i}」`);
    lines.push(diffs.length
      ? `※ 담당자 Master(${d.contactNameLinked ?? "#" + d.contactId})와 다른 항목: ${diffs.join(", ")} — Master는 변경하지 않았습니다.`
      : `담당자 Master 연결: ${d.contactNameLinked ?? "#" + d.contactId} (의뢰 입력값과 일치)`);
  } else if (who || contacts) {
    lines.push("담당자 Master: 미연결 — 견적 담당자 연결이 필요하면 거래처·담당자에서 선택하세요(자동 생성하지 않음).");
  }
  return lines;
}

export function parseEquipmentJson(s: string | null | undefined): Array<{ kind?: string; quantity?: string; unit?: string; location?: string; note?: string; days?: string; refUnitPrice?: string; refAmount?: string }> {
  if (!s) return [];
  try { const arr = JSON.parse(s); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

/**
 * 요구사항의 [원본 견적 참고정보 …] 블록(AI 분석이 원본 견적서에서 남김) → 품목별 단가·공급가액.
 *  "- 통역장비 1 set: 단가 600,000원 · 공급가액 1,800,000원 (원문 Quantity 3)" 형식만 읽는다(장비 목록 외 항목은 제외).
 */
export function parseReferencePrices(requirements: string | null | undefined): Array<{ name: string; unitPrice: string; amount: string }> {
  const text = requirements ?? "";
  const start = text.indexOf("[원본 견적 참고정보");
  if (start < 0) return [];
  const out: Array<{ name: string; unitPrice: string; amount: string }> = [];
  for (const line of text.slice(start).split("\n").slice(1)) {
    if (/^\s*\[/.test(line)) break;   // 다음 블록
    const m = line.match(/^\s*-\s*(.+?):\s*단가\s*([\d,]+)\s*원\s*·\s*공급가액\s*([\d,]+)\s*원(?!.*장비 목록 외)/);
    if (m) out.push({ name: m[1].trim(), unitPrice: m[2].replace(/,/g, ""), amount: m[3].replace(/,/g, "") });
  }
  return out;
}

/**
 * 의뢰건 상세 데이터 → 견적 항목(QuoteHandoffItem[]) 변환.
 *  · 통역: 통역행 1개 · 번역: 번역행 1개 · 장비(또는 통역+「통역장비 필요」): 장비행들 — 복수 선택 시 각각 생성
 *  · 기타(감수·편집·공증 등): 항목 없음(메모로만 전달) — 금액·항목 자동 생성 없음, 사용자가 견적 항목을 직접 추가
 *  · 모든 항목은 금액 없는 초안(단가·금액은 견적 화면에서 사용자가 입력)
 */
export function buildHandoffItems(d: {
  serviceType: string | null;
  serviceTypes?: string[] | null;
  languageFrom: string | null; languageTo: string | null;
  interpretType: string | null; interpretDuration: string | null;
  scheduleFrom: string | null; scheduleTo: string | null; place: string | null;
  documentType: string | null; volume: string | null; subject: string | null;
  equipmentJson: string | null;
  requirements?: string | null;
}): QuoteHandoffItem[] {
  // 서비스별로 전용 필드만 해당 상품 행에 넣는다(번역 분량·장비 수량을 통역 수량으로, 대여일수를 장비 수량으로 넣지 않음).
  //  공통 정보(고객·요청사항·문서 사용처·완료 희망일)는 견적 비고(buildInquiryQuoteNote)로.
  const items: QuoteHandoffItem[] = [];
  const eqRows = parseEquipmentJson(d.equipmentJson);
  // 원본 참고단가 — 장비행에 저장된 값 우선, 없으면(이전 분석 자료) 요구사항 참고정보 블록에서 장비명으로 찾는다.
  //   장비명: 선택된 장비 종류 또는 비고의 「원문 장비명」과 같을 때만(한 품목은 한 행에만 연결, 순서·유사도로 추정하지 않음).
  const refs = parseReferencePrices(d.requirements);
  const usedRef = new Set<number>();
  const nrm = (v: string) => v.replace(/\s+/g, "").toLowerCase();
  const refOf = (r: { kind?: string; note?: string; refUnitPrice?: string; refAmount?: string }): { refUnitPrice?: string; refAmount?: string } => {
    if (r.refUnitPrice) return { refUnitPrice: r.refUnitPrice, ...(r.refAmount ? { refAmount: r.refAmount } : {}) };
    const names = [r.kind ?? "", (r.note ?? "").match(/원문\s*장비명\s*:\s*([^/]+?)(?:\s+\/\s+|$)/)?.[1] ?? ""].map(nrm).filter(Boolean);
    const i = refs.findIndex((x, j) => !usedRef.has(j) && names.includes(nrm(x.name)));
    if (i < 0) return {};
    usedRef.add(i);
    return { refUnitPrice: refs[i].unitPrice, refAmount: refs[i].amount };
  };
  const eqItems = (): QuoteHandoffItem[] => eqRows
    .filter(r => (r.kind && r.kind.trim()) || (r.quantity && r.quantity.trim()))
    .map(r => ({
      productType: "equipment" as const,
      productName: r.kind || "통역장비",
      // 원문에 없는 수량·단위는 채우지 않는다(견적 화면에서 담당자가 입력 — 저장 시 기존 기본값 정책 적용)
      quantity: r.quantity || "",
      unit: r.unit || "",
      // 대여일수 → 견적 행 사용일수(usagePeriod). 장비 수량에는 넣지 않는다(1세트 × 3일 ≠ 3세트).
      ...(r.days ? { usagePeriod: r.days } : {}),
      eventStartDate: toDateStr(d.scheduleFrom),
      eventEndDate: toDateStr(d.scheduleTo),
      itemLocation: r.location || d.place || undefined,
      memo: customerEquipmentNote(r.note) || undefined,
      // 원본 문서에 적힌 단가 → 견적 단가 칸에 바로 입력(상품 Master 기본단가보다 우선, Master 는 변경하지 않음).
      //   원본에 단가가 없으면 비워 둔다(금액 추정·생성 없음 — 기존 상품 단가 정책 유지). refAmount 는 금액 대조용(화면 미표시).
      ...(() => { const ref = refOf(r); return ref.refUnitPrice ? { ...ref, unitPrice: ref.refUnitPrice } : ref; })(),
    }));

  const types = Array.isArray(d.serviceTypes) && d.serviceTypes.length ? d.serviceTypes : (d.serviceType ? [d.serviceType] : []);
  if (types.includes("interpretation")) {
    items.push({
      productType: "interpretation",
      // 상품이 아직 정해지지 않았을 때의 행 이름 — 상품 Master 명명과 같은 「출발어-도착어 형태」(통역 주제는 쓰지 않음)
      productName: [(d.languageFrom && d.languageTo) ? `${d.languageFrom}-${d.languageTo}` : "", d.interpretType || "통역"].filter(Boolean).join(" "),
      interpretDate: toDateStr(d.scheduleFrom),
      interpretEndDate: toDateStr(d.scheduleTo),
      interpretPlace: d.place || undefined,
      // 통역 시작·종료 시각 → 행의 운영시간(시각 없는 일정에 시각을 만들지 않음, 1일 통역시간으로 환산하지 않음)
      ...(toTimeStr(d.scheduleFrom) && toTimeStr(d.scheduleTo) ? { operationHours: `${toTimeStr(d.scheduleFrom)}~${toTimeStr(d.scheduleTo)}` } : {}),
      // 1일 통역시간은 행의 통역시간 필드로(시작·종료 시각으로 변환하지 않음). 숫자로 못 읽는 표현만 메모로 남긴다.
      interpretHours: interpretHoursOf(d.interpretDuration) || undefined,
      // 언어는 상품(언어쌍)으로 정해진다 — 상품이 정해지기 전에도 확인할 수 있게 메모에 남긴다. 주제는 메모로.
      // 언어는 상품(행 이름)으로 표시되므로 메모에 반복하지 않는다. 숫자로 못 읽는 통역시간 표현과 주제만 메모로.
      memo: [d.interpretDuration && !interpretHoursOf(d.interpretDuration) ? `1일 통역시간: ${d.interpretDuration}` : "",
        d.subject ? `주제: ${d.subject}` : ""].filter(Boolean).join(" / ") || undefined,
    });
  }
  if (types.includes("translation")) {
    // 번역 내용 — 번역 단독이면 의뢰건 '번역 내용/주제'(subject). 통역과 함께면 subject 는 통역 주제이므로 쓰지 않고,
    // 요구사항의 "번역할 내용: …" 줄(AI 분석이 복합 의뢰에서 남김)만 사용한다(서비스별 필드 혼합 방지).
    const transContent = types.includes("interpretation")
      ? ((d.requirements ?? "").match(/^\s*번역할\s*내용\s*:\s*(.+)$/m)?.[1]?.trim() ?? "")
      : (d.subject ?? "");
    items.push({
      productType: "translation",
      // 행 이름은 언어쌍(상품 추천 전까지) — 번역 내용(주제)은 상품명이 아니라 메모로
      productName: (d.languageFrom && d.languageTo) ? `${d.languageFrom}-${d.languageTo} 번역` : "번역",
      // 견적 행 sourceLanguage 는 언어 정책 키(ko, en …) — 언어명을 코드로 바꿔 전달, 모르면 견적 화면 기본값 유지
      sourceLanguage: langCode(d.languageFrom),
      // 원문서 형태 — 복수 형식 그대로("Word, HWP")
      fileFormat: d.documentType || undefined,
      // 견적 단위·수량은 상품 단가 기준으로 담당자가 정한다 — 원본 분량(예: 100 page)으로 단위를 확정하거나 통역 단위('일')를 쓰지 않는다
      unit: "",
      quantity: "",
      memo: [transContent ? `번역 내용: ${transContent}` : "", d.volume ? `원본 분량: ${d.volume}` : ""].filter(Boolean).join(" / ") || undefined,
    });
  }
  // 장비행은 의뢰건에 한 번만 저장되므로 통역·장비를 함께 골라도 한 번만 추가(중복 방지)
  if (types.includes("interpretation") || types.includes("equipment")) items.push(...eqItems());
  return items;
}

/** 견적 행별 상품 추천 조건 — 통역·번역 행만(장비·기타는 상품 조건이 원문에 없어 추천하지 않음). */
export function buildProductHints(d: { languageFrom?: string | null; languageTo?: string | null; interpretType?: string | null }, items: QuoteHandoffItem[]): QuoteProductHint[] {
  return items.flatMap((it, itemIndex): QuoteProductHint[] => it.productType === "equipment" && it.productName
    ? [{ itemIndex, productType: "equipment" as const, productName: it.productName }]
    : (it.productType === "interpretation" || it.productType === "translation") ? [{
    itemIndex, productType: it.productType,
    sourceLanguage: langCode(d.languageFrom), targetLanguage: langCode(d.languageTo),
    sourceLanguageName: d.languageFrom ?? undefined, targetLanguageName: d.languageTo ?? undefined,
    interpretType: it.productType === "interpretation" ? (d.interpretType ?? undefined) : undefined,
  }] : []);
}

/** 상품 Master 의 상품(필요 필드만) */
export interface MatchableProduct { id: number; name: string; code?: string; productType: string; sourceLanguage: string | null; targetLanguage: string | null; mainCategory: string | null; active?: boolean }
/**
 * 상품 추천 — 서비스 유형·출발/도착 언어·(통역) 형태가 모두 일치하는 활성 상품.
 *  auto: 일치 상품이 정확히 1개이고 언어·형태 조건이 모두 있을 때만(자동 선택). 그 외에는 후보만 제시(직원 선택).
 *  후보에는 언어만 일치하는 상품(형태 다름)과 방향이 반대인 상품도 넣되 자동 선택하지 않는다.
 */
export function matchProductsForHint(products: MatchableProduct[], h: QuoteProductHint): { auto: MatchableProduct | null; candidates: MatchableProduct[] } {
  const act = products.filter(p => p.active !== false && p.productType === h.productType);
  // 장비 — 상품 Master 이름과 정확히 같은 상품만(유사 이름은 자동 선택하지 않고 후보로만)
  if (h.productType === "equipment") {
    const n = (v: string) => v.replace(/\s+/g, "").toLowerCase();
    const want = n(h.productName ?? "");
    if (!want) return { auto: null, candidates: [] };
    const exact = act.filter(p => n(p.name) === want);
    const similar = act.filter(p => !exact.includes(p) && (n(p.name).includes(want) || want.includes(n(p.name))));
    return { auto: exact.length === 1 ? exact[0] : null, candidates: (exact.length === 1 ? similar : [...exact, ...similar]).slice(0, 8) };
  }
  if (!h.sourceLanguage || !h.targetLanguage) return { auto: null, candidates: [] };
  const sameLang = act.filter(p => p.sourceLanguage === h.sourceLanguage && p.targetLanguage === h.targetLanguage);
  const reversed = act.filter(p => p.sourceLanguage === h.targetLanguage && p.targetLanguage === h.sourceLanguage);
  if (h.productType === "interpretation") {
    const exact = h.interpretType ? sameLang.filter(p => (p.mainCategory ?? "").replace(/\s+/g, "") === h.interpretType!.replace(/\s+/g, "")) : [];
    const rest = [...sameLang.filter(p => !exact.includes(p)), ...reversed];
    return { auto: exact.length === 1 ? exact[0] : null, candidates: exact.length === 1 ? rest.slice(0, 6) : [...exact, ...rest].slice(0, 8) };
  }
  return { auto: sameLang.length === 1 ? sameLang[0] : null, candidates: [...(sameLang.length === 1 ? [] : sameLang), ...reversed].slice(0, 8) };
}

/**
 * 견적 비고(견적서 PDF 에 출력됨) — 고객에게 보이는 문서이므로 내부 정보·시스템 메시지는 넣지 않는다.
 *  · 넣지 않음: 의뢰 번호, Master 연결/등록 상태, 고객 연락처(→ 고객정보 스냅샷), 수행일·장소·통역시간(→ 상품 행),
 *              언어(→ 상품), 주제(→ 상품 행 메모), 고객 접수일시·견적서 수령 희망일(→ 의뢰건)
 *  · 넣음: 고객 요청사항, 추가 언어 요청과 필수 여부, 정식 필드가 없는 추가 정보(호출 측이 extraLines 로 전달)
 * 견적 화면은 신규 견적에서만 이 값을 초기값으로 쓰고, 직원이 고친 비고·저장된 비고는 다시 만들지 않는다.
 */
export function buildInquiryQuoteNote(d: { requirements?: string | null }, extraLines: string[] = []): string {
  const addl = additionalLanguagesOf(d.requirements);
  // 요구사항 원문(자동 기록된 "추가 언어:" 줄은 제외) — 고객 문장을 바꾸지 않고 '요청사항'과 '주요 내용'으로만 묶는다
  // 의뢰건 AI 분석의 내부 참고정보(원본 견적 금액 블록, 원문 표기 메모)는 고객용 견적 비고에 넣지 않는다
  let inRef = false;
  const lines = (d.requirements ?? "").split(/\r?\n/).map(l => l.trim()).filter(l => {
    if (/^\[원본 견적 참고/.test(l)) { inRef = true; return false; }
    if (inRef) { if (/^-\s/.test(l)) return false; inRef = false; }
    return l && !/^추가 언어\s*[:(]/.test(l) && !/^원문서 형태\(원문\)\s*:/.test(l);
  });
  const isContent = (l: string) => /^(?:주된|주요)\s*내용|^행사\s*(?:내용|개요)|^내용은/.test(l);
  const req = lines.filter(l => !isContent(l)), content = lines.filter(isContent);
  // 추가 언어 — 고객 원문에 그 언어가 이미 적혀 있으면(필수 여부 포함) 다시 쓰지 않는다(중복 방지)
  const addlLines = addl.flatMap(a => {
    const m = a.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    const pair = m ? m[1] : a, cond = m ? m[2] : "";
    const target = pair.split("→").pop()?.trim() ?? "";
    if (target && lines.some(l => l.includes(target))) return [];
    return [`추가 언어${cond ? `(${cond})` : ""}: ${pair} — 필요 시 별도 견적`];
  });
  const blocks = [
    req.length ? `요청사항:\n${req.join("\n")}` : "",
    content.length ? `주요 내용:\n${content.join("\n")}` : "",
    [...addlLines, ...extraLines.filter(Boolean)].join("\n"),
  ].filter(Boolean);
  return blocks.join("\n\n");
}

