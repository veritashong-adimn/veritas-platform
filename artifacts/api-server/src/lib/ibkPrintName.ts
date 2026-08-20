// ─────────────────────────────────────────────────────────────────────────────
// IBK 대량이체 「내통장인쇄내용」 자동 생성 — 동명이인 구분·거래내역 추적용.
//  · 단일 원천: 통번역사 관리(translator_profiles + translator_sensitive). 판매/수행 데이터는 쓰지 않는다.
//  · 판정 우선순위(§3): 1) 해외인력 → 이름+언어+국가  2) 국내·통대 → 이름+언어+학교  3) 그 외 국내 → 이름+언어
//  · 거래처(vendor) → 거래처명 그대로(언어/학교/국가 미부착).
//  · 부가정보 누락은 IBK 생성을 막지 않는다(§4). 누락 항목은 자동 탈락하고 최소 이름은 항상 남는다.
//  · IBK 「내통장인쇄내용」 최대 허용 글자수는 공식 샘플 부재로 확인 불가(§7) → 임의 절단하지 않는다.
//    (추후 제한 확인 시 truncateByPriority 로 이름>언어>학교/국가 순 보존을 적용)
// ─────────────────────────────────────────────────────────────────────────────

export type PrintNameInput = {
  payeeType: string | null;                 // "individual" | "vendor" | ...
  name: string | null;                      // 지급대상자명(통번역사 관리 기준)
  languagePairs?: string | null;            // translator_profiles.language_pairs (예: "한국어, 영어")
  education?: string | null;                // translator_profiles.education (학력/통번역대학원)
  major?: string | null;                    // translator_profiles.major (전공)
  paymentMethod?: string | null;            // translator_sensitive.payment_method ("overseas_*" → 해외)
  country?: string | null;                  // translator_sensitive.country (해외인력 국가)
};

// 한국어(=자국어)로 간주해 주언어 추출 시 제외할 토큰.
const KOREAN_TOKENS = /^(한국어|한국|국어|korean|kr|ko)$/i;

// 주언어 추출 — 등록 언어정보(language_pairs)에서 한국어를 제외한 첫 외국어를 사용한다(§2).
export function extractMainLanguage(languagePairs: string | null | undefined): string {
  if (!languagePairs) return "";
  const parts = String(languagePairs)
    .split(/[,/·|↔~\-\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const foreign = parts.find((p) => !KOREAN_TOKENS.test(p));
  return foreign || parts[0] || "";
}

// 통번역대학원(통대) 출신 판정 — education/major 의 실제 저장값 기준(임의 추정 금지, §3·§5).
//  · education 에 "통번역대학원/통역번역대학원" 이 있으면 통대.
//  · 그 외 대학원이면서 전공/학력에 통번역·통역·번역 이 있으면 통대(예: 중앙대 국제대학원 · 전문통번역학).
export function isTongbeonyeokGraduate(education: string | null | undefined, major: string | null | undefined): boolean {
  const e = String(education ?? "");
  const m = String(major ?? "");
  if (/통번역대학원|통역번역대학원/.test(e)) return true;
  if (/대학원/.test(e) && /(통번역|통역|번역)/.test(e + m)) return true;
  return false;
}

// 학교 축약명(§5) — 실제 DB 저장값에 대한 명시적 매핑 우선. 미매핑은 결정적 규칙(대학교→대)으로 축약.
//  · 매핑은 통번역사 관리에 실제로 존재하는 학력 문자열에 한정한다(새 학교명을 임의 생성하지 않음).
const SCHOOL_ABBR: Record<string, string> = {
  "서울외국어대학원대학교 통번역대학원": "서울외대",
  "한국외국어대학교 통번역대학원": "한국외대",
  "이화여자대학교 통역번역대학원": "이화여대",
  "중앙대학교 국제대학원": "중앙대",
};

export function abbreviateSchool(education: string | null | undefined): string {
  const key = String(education ?? "").trim();
  if (!key) return "";
  if (SCHOOL_ABBR[key]) return SCHOOL_ABBR[key];
  // 결정적 축약: 대학원/대학원대학교 접미 제거 → "○○대학교"→"○○대". (임의 추정 아님)
  const uni = key.split(/\s+/)[0] || key;
  return uni
    .replace(/대학원대학교$/, "대")
    .replace(/여자대학교$/, "여대")
    .replace(/대학교$/, "대")
    .replace(/대학원$/, "");
}

// 국가명 표준 표시(§6) — 영문/약어 저장값을 VERITAS 표준 한글 국가명으로. 이미 한글이면 그대로.
//  · 새 매핑체계를 임의 생성하지 않고, 흔한 표기만 최소 매핑. 미매핑은 저장값 원문 유지.
const COUNTRY_KO: Record<string, string> = {
  "united states": "미국", "united states of america": "미국", usa: "미국", us: "미국", "u.s.": "미국", "u.s.a.": "미국", america: "미국",
  japan: "일본", jp: "일본",
  china: "중국", cn: "중국",
  "united kingdom": "영국", uk: "영국", "u.k.": "영국", england: "영국", britain: "영국",
  france: "프랑스", fr: "프랑스",
  germany: "독일", de: "독일",
  canada: "캐나다", australia: "호주",
};

export function normalizeCountry(country: string | null | undefined): string {
  const raw = String(country ?? "").trim();
  if (!raw) return "";
  return COUNTRY_KO[raw.toLowerCase()] ?? raw;
}

// 해외인력 판정 — 통번역사 관리의 지급방식(payment_method)이 "overseas_*" 이면 해외(§3 우선판정).
export function isOverseasPayee(paymentMethod: string | null | undefined): boolean {
  return typeof paymentMethod === "string" && paymentMethod.trim().toLowerCase().startsWith("overseas");
}

// IBK 「내통장인쇄내용」 통장 표시용 최대 글자수. 규칙 문자열 생성 후 출력 단계에서만 적용한다(DB 원본 불변).
export const MAX_BANK_PRINT_LEN = 10;

/**
 * 통장 표시용으로 「내통장인쇄내용」을 최대 max 자로 제한한다.
 *  · 영문 병기 괄호(예: 코리아미디어(KOREA MEDIA))는 제거 → "코리아미디어".
 *  · 한글이 깨지지 않도록 코드포인트(문자) 단위로 절단(NFC 정규화 후 [...s]).
 *  · 이름→언어→학교/국가 순으로 이어붙였으므로 좌측 우선 절단이 곧 식별정보 우선 보존(§7)이다.
 */
export function truncateForBankPrint(raw: string | null | undefined, max = MAX_BANK_PRINT_LEN): string {
  const base = String(raw ?? "");
  // 전각/반각 괄호주석 제거 후 공백 정리.
  let s = base.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, " ").trim().normalize("NFC");
  if (!s) s = base.replace(/\s+/g, " ").trim().normalize("NFC"); // 괄호 제거로 비면 원문 사용
  return [...s].slice(0, max).join("");
}

/**
 * 「내통장인쇄내용」 최종 문자열을 생성한다(§1·§3·§4).
 *  · 구성요소는 공백 없이 이어붙인다(예: 오수정영어서울외대).
 *  · 누락 요소는 자동 탈락(§4) — filter(Boolean) 로 이름만 남아도 안전.
 */
export function buildPayeePrintName(input: PrintNameInput): string {
  const name = String(input.name ?? "").trim();
  // 거래처(§1.D): 거래처명 그대로.
  if (input.payeeType === "vendor") return name;

  const lang = extractMainLanguage(input.languagePairs);

  // 1) 해외인력 우선(§3): 이름+언어+국가.
  if (isOverseasPayee(input.paymentMethod)) {
    const country = normalizeCountry(input.country);
    return [name, lang, country].filter(Boolean).join("");
  }
  // 2) 국내·통대(§3): 이름+언어+학교.
  if (isTongbeonyeokGraduate(input.education, input.major)) {
    const school = abbreviateSchool(input.education);
    return [name, lang, school].filter(Boolean).join("");
  }
  // 3) 그 외 국내: 이름+언어.
  return [name, lang].filter(Boolean).join("");
}
