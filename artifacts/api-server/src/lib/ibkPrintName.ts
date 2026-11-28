// ─────────────────────────────────────────────────────────────────────────────
// IBK 대량이체 「내통장인쇄내용」 자동 생성 — 베리타스 은행이체 통장 인쇄내용 표준 규칙(2026-11-28, CLAUDE.md 참조).
//  · 단일 원천: 통번역사 명부(translator_profiles + translator_sensitive) — 통합된 통번역사는 통합 대표 명부 기준(호출측).
//    판매·수행·과거 CRM 데이터는 쓰지 않는다. 생성 문구는 저장하지 않는다(이체 파일 생성 시마다 명부에서 생성).
//  · 표기(우선순위):
//      외주업체            → 업체명 그대로
//      해외 현지 인력      → 이름 + 언어 약칭 + 국가
//      통대 출신·학교 확인 → 이름 + 언어 약칭 + 학교 약칭
//      통대 출신·학교 미확인(또는 학교가 서로 다름) → 이름 + 언어 약칭(학교 추정 금지)
//      일반 대학·대학원     → 이름 + 언어 약칭 + 일반
//      학력 미확인          → 이름 + 언어 약칭
//  · 통번역·통역사·번역사 같은 공통 문구, 여러 전문 분야 중 임의의 대표 특징(GMP 등)은 붙이지 않는다.
//  · 학교·언어 약칭은 아래 공통 매핑(GRAD_SCHOOLS · LANGUAGE_ABBR)에서만 관리 — 추가·수정은 매핑만 고친다.
//    약칭은 통장 인쇄내용 전용(명부·상품·견적·판매 등 다른 화면 표기는 바꾸지 않는다).
//  · 글자 수: 최대 MAX_BANK_PRINT_LEN(10)자 — 기업은행 공식 제한으로 확인된 값이 아니다(내부 기준, 공식 확인 시 이 상수만 조정).
//    이름 최우선 보존 → 언어 → 부가정보(학교·국가·일반). 초과 시 부가정보를 짧은 약칭으로 줄이거나 생략하고, 단어 중간을 자르지 않는다.
//    이름 자체가 제한을 넘는 경우만 이름을 글자 단위로 자르고 경고(name_over_limit)를 돌려준다(한글 코드포인트 단위 — 깨짐 없음).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_BANK_PRINT_LEN = 10;   // 내부 기준(기업은행 공식 제한 미확인)

// ── 공통 매핑: 통번역대학원 학교 약칭 ──────────────────────────────────────────
//   patterns: 학력·전공·학력이력·특징(bio)의 한글·영문 학교명·기존 약칭 중 '통번역대학원'을 가리키는 표현만(일반 학부·일반대학원 제외).
//   short: 글자 수 초과 시 쓸 더 짧은 약칭(없으면 생략). 순서 = 판정 순서(서울외대를 외대보다 먼저 — '서울외대통대' ⊃ '외대통대').
export type GradSchool = { abbr: string; short?: string; patterns: RegExp[] };
export const GRAD_SCHOOLS: GradSchool[] = [
  { abbr: "서울외대", patterns: [/서울\s*외국어\s*대학원\s*대학교/, /서울\s*외대/] },   // 통번역 전문 대학원대학교 — 언급 자체가 통대
  { abbr: "외대통대", short: "외대", patterns: [
    /(한국\s*외국어\s*대학교|한국\s*외대|(?<!서울\s*)외대)\s*(통번역\s*대학원|통역\s*번역\s*대학원|통대)/,
    /HUFS\s*GSIT/i, /Hankuk\s+University\s+of\s+Foreign\s+Studies.{0,40}Graduate\s+School\s+of\s+(Interpretation|Translation)/i] },
  { abbr: "이대통대", short: "이대", patterns: [
    /(이화\s*여자\s*대학교|이화\s*여대|이대)\s*(통역\s*번역\s*대학원|통번역\s*대학원|통대)/,
    /Ewha.{0,40}Graduate\s+School\s+of\s+(Translation|Interpretation)/i] },
  { abbr: "중앙대", short: "중대", patterns: [/(중앙\s*대학교|중앙대|중대)\s*(통번역\s*대학원|통역\s*번역\s*대학원|통대)/] },
  { abbr: "선문대", patterns: [/선문\s*(대학교|대)\s*(통번역\s*대학원|통역\s*번역\s*대학원|통대)/] },
  { abbr: "몬트레이", patterns: [/몬트레이/, /Monterey/i, /Middlebury\s+Institute/i, /\bMIIS\b/] },   // 통번역 전문 대학원
  { abbr: "맥쿼리", patterns: [/(맥쿼리|Macquarie)[^/|;,\n]{0,40}(통번역|통역|번역|Translat|Interpret)/i, /(통번역|통역|번역|Translat|Interpret)[^/|;,\n]{0,40}(맥쿼리|Macquarie)/i] },
];
// 중앙대 통대(국제대학원 전문통번역) — 학력·전공 '필드 자체'에 국제대학원 + 통번역/통역/번역이 함께 있을 때만(특징의 '전문 통번역사' 같은 일반 문구 제외).
const CAU_GSI = /중앙\s*(대학교|대)\s*국제\s*대학원/;
const TRANSLATION_WORD = /(통번역|통역|번역)(?!사)/;

// 통대 출신 신호(학교 불명 포함) — 학교를 특정하지 못해도 '통대 출신'으로 보고 학교 없이 표기한다.
const GRAD_SIGNAL = /통번역\s*대학원|통역\s*번역\s*대학원|통대|GSIT|Graduate\s+School\s+of\s+(Translation|Interpretation)/i;
// 일반 대학·대학원 학력 신호(통대 신호가 없을 때만 '일반'). 고등학교만 있는 경우는 일반 아님.
const GENERAL_SIGNAL = /(학사|석사|박사|대학교|대학원|대학|대졸|University|College|Bachelor|Master|Ph\.?\s?D)/i;
// 특징(bio)은 자유 문구라 학위·졸업 표현만 인정(예: '대학병원' 같은 단어로 일반 학력 판정하지 않음)
const BIO_GENERAL_SIGNAL = /(학사|석사|박사|대학교|대학원|대졸|[가-힣]{1,8}대\s*(\d{2}\s*)?(학번|졸|졸업|수료)|University|College|Bachelor|Master'?s|Ph\.?\s?D)/i;

// ── 공통 매핑: 통장 인쇄용 언어 약칭(그 외 언어는 등록 표기 그대로) ─────────────
export const LANGUAGE_ABBR: Record<string, string> = {
  "러시아어": "노어", "프랑스어": "불어", "독일어": "독어", "스페인어": "서어", "포르투갈어": "포어",
};
// ── 공통 매핑: 지역 변형 언어 → 기준 언어 — 둘 다 등록돼 있으면 기준 언어로 표기(예: '대만어, 중국어' → 중국어).
//   변형 언어만 등록된 경우는 등록 표기 그대로. 추가 시 이 매핑과 회귀 테스트만 고친다.
export const LANGUAGE_VARIANT_BASE: Record<string, string> = { "대만어": "중국어" };
// 한국어(자국어)·공통 업무 문구 — 주언어 추출에서 제외
const KOREAN_TOKENS = /^(한국어|한국|국어|korean|kr|ko)$/i;
const COMMON_WORDS = /^(통번역|통역|번역|통역사|번역사|통번역사|감수)$/;

export type PrintNameInput = {
  payeeType: string | null;                 // "individual" | "vendor"
  name: string | null;                      // 지급대상자명(확정 스냅샷 이름 — 변경하지 않음)
  languagePairs?: string | null;            // translator_profiles.language_pairs
  education?: string | null;                // translator_profiles.education
  major?: string | null;                    // translator_profiles.major
  educationHistory?: unknown;               // translator_profiles.education_history(JSON 배열)
  bio?: string | null;                      // translator_profiles.bio(특징)
  paymentMethod?: string | null;            // translator_sensitive.payment_method("overseas_*" → 해외)
  country?: string | null;                  // translator_sensitive.country
};
export type PrintNameCategory = "vendor" | "overseas" | "grad_school" | "grad_unknown_school" | "general" | "unknown";
export type PrintNameResult = {
  text: string; category: PrintNameCategory; name: string; language: string; extra: string;
  school: string | null; schoolCandidates: string[];      // 학교가 2곳 이상이면 schoolCandidates 에 모두(추정 안 함)
  shortened: boolean; dropped: string[]; warnings: ("name_over_limit" | "school_conflict")[];
};

// 주언어 — 등록 언어에서 한국어·공통 업무 문구를 뺀 첫 언어(괄호 주석 제거). 첫 언어가 지역 변형이고 기준 언어도 등록돼 있으면 기준 언어.
//   약칭 매핑은 별도(abbreviateLanguage).
export function extractMainLanguage(languagePairs: string | null | undefined): string {
  if (!languagePairs) return "";
  const parts = String(languagePairs).replace(/[（(][^）)]*[）)]/g, " ")
    .split(/[,/·|↔~\-\s]+/).map((s) => s.trim()).filter(Boolean).filter((p) => !COMMON_WORDS.test(p));
  const first = parts.find((p) => !KOREAN_TOKENS.test(p)) || parts[0] || "";
  const base = LANGUAGE_VARIANT_BASE[first];
  return base && parts.includes(base) ? base : first;
}
export function abbreviateLanguage(lang: string): string { return LANGUAGE_ABBR[lang] ?? lang; }

// 국가명 표준 표시 — 영문/약어 저장값을 한글 국가명으로(흔한 표기만), 그 외 원문.
const COUNTRY_KO: Record<string, string> = {
  "united states": "미국", "united states of america": "미국", usa: "미국", us: "미국", "u.s.": "미국", "u.s.a.": "미국", america: "미국",
  japan: "일본", jp: "일본", china: "중국", cn: "중국",
  "united kingdom": "영국", uk: "영국", "u.k.": "영국", england: "영국", britain: "영국",
  france: "프랑스", fr: "프랑스", germany: "독일", de: "독일", canada: "캐나다", australia: "호주",
};
export function normalizeCountry(country: string | null | undefined): string {
  const raw = String(country ?? "").trim();
  if (!raw) return "";
  return COUNTRY_KO[raw.toLowerCase()] ?? raw;
}
export function isOverseasPayee(paymentMethod: string | null | undefined): boolean {
  return typeof paymentMethod === "string" && paymentMethod.trim().toLowerCase().startsWith("overseas");
}

// 학력이력(JSON) → 문장들(학교·대학원·학과·학위·원문). 고등학교 항목은 제외.
function historyTexts(h: unknown): string[] {
  const arr = Array.isArray(h) ? h : (() => { try { const v = typeof h === "string" ? JSON.parse(h) : null; return Array.isArray(v) ? v : []; } catch { return []; } })();
  return arr.filter((e: any) => e && typeof e === "object").map((e: any) =>
    [e.school, e.graduateSchool, e.graduateSchoolType, e.department, e.majorDetail, e.degree, e.degreeName, e.sourceText].filter(Boolean).join(" "))
    .filter((t: string) => !!t && (!/고등\s*학교|High\s+School/i.test(t) || /대학|University|College/i.test(t)));
}

/** 학력·전공·학력이력·특징에서 통대 학교·통대 신호·일반 학력 신호를 판정한다(추정 금지 — 학교 2곳 이상이면 학교 미확인). */
export function classifyEducation(input: Pick<PrintNameInput, "education" | "major" | "educationHistory" | "bio">) {
  const edu = String(input.education ?? ""), major = String(input.major ?? ""), bio = String(input.bio ?? "");
  const hist = historyTexts(input.educationHistory);
  const fields = [edu, major, ...hist, bio].filter(Boolean);
  const schools = new Set<string>();
  for (const f of fields) {
    let rest = f;
    for (const s of GRAD_SCHOOLS) if (s.patterns.some((p) => p.test(rest))) { schools.add(s.abbr); for (const p of s.patterns) rest = rest.replace(new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"), " "); }
  }
  // 중앙대 국제대학원 전문통번역 — 학력·전공·학력이력 필드 안에서만 판정
  for (const f of [edu + " " + major, ...hist]) if (CAU_GSI.test(f) && TRANSLATION_WORD.test(f)) schools.add("중앙대");
  const gradSignal = schools.size > 0 || fields.some((f) => GRAD_SIGNAL.test(f));
  const general = !gradSignal && ([edu, major, ...hist].some((f) => GENERAL_SIGNAL.test(f.replace(/고등\s*학교/g, ""))) || BIO_GENERAL_SIGNAL.test(bio));
  const list = [...schools];
  return { schools: list, school: list.length === 1 ? list[0] : null, gradSignal, general };
}

/** 이름 최우선 → 언어 → 부가정보 순으로 최대 max 자. 부가정보는 짧은 약칭 → 생략, 단어 중간을 자르지 않는다. */
function fitParts(name: string, lang: string, extra: string, extraShort: string | undefined, max: number) {
  const len = (s: string) => [...s].length;
  const dropped: string[] = [];
  if (len(name) > max) return { text: [...name].slice(0, max).join(""), shortened: true, dropped: [lang, extra].filter(Boolean), nameOver: true };
  if (len(name + lang + extra) <= max) return { text: name + lang + extra, shortened: false, dropped, nameOver: false };
  if (extra && extraShort && len(name + lang + extraShort) <= max) return { text: name + lang + extraShort, shortened: true, dropped, nameOver: false };
  if (extra) dropped.push(extra);
  if (len(name + lang) <= max) return { text: name + lang, shortened: true, dropped, nameOver: false };
  if (lang) dropped.push(lang);
  return { text: name, shortened: true, dropped, nameOver: false };
}

/** 「내통장인쇄내용」 생성 + 판정 근거(카테고리·학교 후보·생략 항목·경고). */
export function explainPayeePrintName(input: PrintNameInput, max = MAX_BANK_PRINT_LEN): PrintNameResult {
  const name = String(input.name ?? "").trim();
  if (input.payeeType === "vendor") {   // 외주업체 — 기존 업체명 표기 유지(파일 단계 truncateForBankPrint 그대로)
    return { text: name, category: "vendor", name, language: "", extra: "", school: null, schoolCandidates: [], shortened: false, dropped: [], warnings: [] };
  }
  const lang = abbreviateLanguage(extractMainLanguage(input.languagePairs));
  let category: PrintNameCategory, extra = "", extraShort: string | undefined, school: string | null = null, candidates: string[] = [];
  const warnings: PrintNameResult["warnings"] = [];
  if (isOverseasPayee(input.paymentMethod)) { category = "overseas"; extra = normalizeCountry(input.country); }
  else {
    const c = classifyEducation(input);
    candidates = c.schools;
    if (c.school) { category = "grad_school"; school = c.school; extra = c.school; extraShort = GRAD_SCHOOLS.find((s) => s.abbr === c.school)?.short; }
    else if (c.gradSignal) { category = "grad_unknown_school"; if (c.schools.length > 1) warnings.push("school_conflict"); }
    else if (c.general) { category = "general"; extra = "일반"; }
    else category = "unknown";
  }
  const f = fitParts(name, lang, extra, extraShort, max);
  if (f.nameOver) warnings.push("name_over_limit");
  return { text: f.text, category, name, language: lang, extra, school, schoolCandidates: candidates, shortened: f.shortened, dropped: f.dropped, warnings };
}

/** 「내통장인쇄내용」 최종 문자열(표준 규칙). */
export function buildPayeePrintName(input: PrintNameInput): string {
  return explainPayeePrintName(input).text;
}

/**
 * 파일 출력 단계 최종 안전장치 — 괄호 주석 제거(예: 코리아미디어(KOREA MEDIA) → 코리아미디어) 후 최대 max 자(코드포인트 단위).
 *  · 개인 지급대상은 explainPayeePrintName 이 이미 max 자 이내로 구성한다. 외주업체명은 기존과 같이 여기서 정리한다.
 */
export function truncateForBankPrint(raw: string | null | undefined, max = MAX_BANK_PRINT_LEN): string {
  const base = String(raw ?? "");
  let s = base.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, " ").trim().normalize("NFC");
  if (!s) s = base.replace(/\s+/g, " ").trim().normalize("NFC");
  return [...s].slice(0, max).join("");
}
