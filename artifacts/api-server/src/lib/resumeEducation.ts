// ─── 이력서 AI 분석 — 학력 후처리 ────────────────────────────────────────────
// AI가 반환한 educationHistory(학력 이력 배열)를 정제하고, 최종 학력(가장 높은 학위)을
// 기존 프로필 필드(education / major / graduationYear / graduationStatus)로 매핑한다.
//
// 원칙
//  - 원문에 명시된 명칭만 사용한다. 학교명만으로 대학원 종류(통번역대학원 등)를 추측하지 않는다.
//  - 학부 전공과 대학원 전공, 주전공과 제2전공을 섞지 않는다.
//  - 원문에 없는 학력·전공·학위는 생성하지 않는다(빈 값은 그대로 null).

/** 통번역대학원 표준 명칭 목록 (기존 프로필 드롭다운 값과 동일하게 유지) */
export const RESUME_EDUCATION_LIST = [
  "한국외국어대학교 통번역대학원",
  "이화여자대학교 통역번역대학원",
  "서울외국어대학원대학교 통번역대학원",
  "중앙대학교 국제대학원",
  "부산외국어대학교 통번역대학원",
  "제주대학교 통번역대학원",
  "선문대학교 통번역대학원",
  "계명대학교 통번역대학원",
  "Macquarie University - Translation & Interpreting",
  "Middlebury Institute of International Studies at Monterey",
  "University of Bath",
  "University of Westminster",
  "University of Leeds",
  "Université Paris Cité ESIT",
  "University of Geneva FTI",
  "University of Ottawa",
];

export interface EducationEntry {
  school: string | null;          // 학교명 (예: 한국외국어대학교)
  graduateSchool: string | null;  // 대학원명 원문 (예: 경영정보대학원, 통번역대학원, 대학원)
  // 대학원명에서만 도출 (추측 없음): 통번역대학원 | 일반대학원 | 특수·전문대학원 | null(대학원명 미기재)
  graduateSchoolType: "통번역대학원" | "일반대학원" | "특수·전문대학원" | null;
  department: string | null;      // 학과/전공 (예: 경영정보학과, 스페인어과)
  majorDetail: string | null;     // 세부 전공·분야 (예: 미국희곡)
  degree: "박사" | "석사" | "학사" | "전문학사" | null;
  degreeName: string | null;      // 원문 학위명 (예: 경영학 석사)
  majorType: "주전공" | "복수전공" | "제2전공" | "부전공" | null;
  status: "졸업" | "졸업예정" | "재학중" | "수료" | "중퇴" | null;
  admissionYear: number | null;
  graduationYear: number | null;
  sourceText: string | null;      // 근거가 된 이력서 원문 발췌 (AI 추출 원문과의 연결)
}

function graduateSchoolTypeOf(name: string | null): EducationEntry["graduateSchoolType"] {
  if (!name) return null;
  if (/통번역|통역번역|interpret|translat/i.test(name)) return "통번역대학원";
  // "대학원", "일반대학원", "이화여자대학교 대학원" → 일반대학원 / 그 외 "OO대학원" → 특수·전문대학원
  if (/^(\S*대학교\s*)?(일반\s*)?대학원$/.test(name.trim())) return "일반대학원";
  return "특수·전문대학원";
}

const DEGREE_RANK: Record<string, number> = { 박사: 4, 석사: 3, 학사: 2, 전문학사: 1 };
const STATUS_SET = new Set(["졸업", "졸업예정", "재학중", "수료", "중퇴"]);
const MAJOR_TYPE_SET = new Set(["주전공", "복수전공", "제2전공", "부전공"]);

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" ? t : null;
}

function year(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim().slice(0, 4)) : NaN;
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}

function normDegree(v: unknown, degreeName: string | null): EducationEntry["degree"] {
  const s = `${str(v) ?? ""} ${degreeName ?? ""}`.toLowerCase();
  if (/박사|ph\.?\s?d|doctor/.test(s)) return "박사";
  if (/석사|master|m\.a\b|m\.s\b|mba/.test(s)) return "석사";
  if (/전문학사|associate/.test(s)) return "전문학사";
  if (/학사|bachelor|b\.a\b|b\.s\b/.test(s)) return "학사";
  return null;
}

function normStatus(v: unknown): EducationEntry["status"] {
  const s = str(v);
  if (!s) return null;
  if (STATUS_SET.has(s)) return s as EducationEntry["status"];
  if (s === "재학") return "재학중";
  if (/졸업\s*예정|expected/i.test(s)) return "졸업예정";
  if (/중퇴|withdr|drop/i.test(s)) return "중퇴";
  if (/수료/.test(s)) return "수료";
  if (/재학|enrolled|current/i.test(s)) return "재학중";
  if (/졸업|graduated|completed/i.test(s)) return "졸업";
  return null;
}

function normMajorType(v: unknown): EducationEntry["majorType"] {
  const s = str(v);
  if (!s) return null;
  if (MAJOR_TYPE_SET.has(s)) return s as EducationEntry["majorType"];
  if (/이중|double|dual/i.test(s)) return "복수전공";
  if (/제\s*2|second/i.test(s)) return "제2전공";
  if (/부전공|minor/i.test(s)) return "부전공";
  if (/주전공|major|primary/i.test(s)) return "주전공";
  return null;
}

/** AI 응답의 educationHistory를 안전한 배열로 정제 (정보가 전혀 없는 항목은 버린다) */
export function sanitizeEducationHistory(raw: unknown): EducationEntry[] {
  let arr: unknown = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out: EducationEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    // 원문 학위명에 붙은 상태 표기(예: "통번역학 석사 졸업")는 status로만 관리
    const degreeName = str(str(o.degreeName)?.replace(/\s*(졸업\s*예정|졸업|수료|재학중?|중퇴)\s*$/, "") ?? null);
    const graduateSchool = str(o.graduateSchool);
    const e: EducationEntry = {
      school: str(o.school),
      graduateSchool,
      graduateSchoolType: graduateSchoolTypeOf(graduateSchool),
      // 계열·단과대 접두어(예: "어문학계열 영문학")는 학과명에서 제외
      department: str(str(o.department)?.replace(/^\S+계열\s+(?=\S)/, "") ?? null),
      majorDetail: str(o.majorDetail),
      degree: normDegree(o.degree, degreeName),
      degreeName,
      majorType: normMajorType(o.majorType),
      status: normStatus(o.status),
      admissionYear: year(o.admissionYear),
      graduationYear: year(o.graduationYear),
      sourceText: str(o.sourceText)?.slice(0, 300) ?? null,
    };
    // 대학원명이 있는데 학위가 비어 있으면 학위를 추측하지 않는다(그대로 null).
    if (!e.school && !e.graduateSchool && !e.department) continue;
    out.push(e);
    // 같은 과정의 복수·제2·부전공(secondaryMajors) → 같은 학교·학위·상태의 별도 학력 항목으로 보존
    if (Array.isArray(o.secondaryMajors)) {
      for (const sm of o.secondaryMajors) {
        if (!sm || typeof sm !== "object") continue;
        const smo = sm as Record<string, unknown>;
        const dept = str(smo.department ?? smo.name);
        const mt = normMajorType(smo.majorType ?? smo.type);
        if (!dept || !mt || mt === "주전공" || dept === e.department) continue;
        out.push({ ...e, department: dept, majorDetail: null, degreeName: null, majorType: mt, sourceText: e.sourceText });
      }
    }
  }
  // 중복 제거 (AI가 secondaryMajors와 별도 요소로 동시에 기재한 경우 등)
  const seen = new Set<string>();
  return out.filter(e => {
    const k = [e.school, e.graduateSchool, e.department, e.degree, e.majorType ?? "주전공"].join("|").replace(/\s/g, "");
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

/**
 * 저장용 직렬화: 배열 또는 JSON 문자열을 정제 후 JSON 문자열로. 빈 값/빈 배열 → null.
 * (원문에 없는 항목을 만들지 않으며, 정보가 전혀 없는 항목만 제거)
 */
export function serializeEducationHistory(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const entries = sanitizeEducationHistory(raw);
  return entries.length > 0 ? JSON.stringify(entries) : null;
}

function rankOf(e: EducationEntry): number {
  if (e.degree) return DEGREE_RANK[e.degree] ?? 0;
  // 학위 미기재지만 대학원 소속이 명시되면 석사 이상 과정으로 간주해 정렬만 우선한다(값은 생성하지 않음)
  return e.graduateSchool ? 2.5 : 0;
}

/** 최종 학력: 가장 높은 학위 → 주전공 우선 → 최근 졸업연도 */
export function pickFinalEducation(entries: EducationEntry[]): EducationEntry | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    const r = rankOf(b) - rankOf(a);
    if (r !== 0) return r;
    const ma = a.majorType && a.majorType !== "주전공" ? 1 : 0;
    const mb = b.majorType && b.majorType !== "주전공" ? 1 : 0;
    if (ma !== mb) return ma - mb;
    return (b.graduationYear ?? b.admissionYear ?? 0) - (a.graduationYear ?? a.admissionYear ?? 0);
  });
  return sorted[0];
}

/** 학교명 + 대학원명(원문). 대학원명이 학교명을 이미 포함하면 중복하지 않는다. */
export function formatEducationName(e: EducationEntry): string | null {
  const school = e.school;
  const grad = e.graduateSchool;
  if (school && grad) return grad.includes(school) ? grad : `${school} ${grad}`;
  return school ?? grad ?? null;
}

/** 같은 학교·같은 학위 단계의 복수/제2/부전공 항목 */
function secondaryMajorsOf(final: EducationEntry, all: EducationEntry[]): EducationEntry[] {
  return all.filter(e =>
    e !== final && e.department && e.majorType && e.majorType !== "주전공" &&
    e.school === final.school && rankOf(e) === rankOf(final) && e.department !== final.department,
  );
}

/**
 * 전공 표시 문자열 (학위 단계는 학력 표시에 있으므로 중복하지 않음):
 *   최종 학력 전공(세부 전공 / 학과와 다른 학위명) → 같은 과정의 제2·복수·부전공 → 다른 학력의 전공
 *   예) "경영정보학과(경영학 석사) / 학부 영어과", "스페인어과 / 제2전공 영어통번역학", "영문학(미국희곡) / 학부 영어영문학"
 */
export function formatMajor(final: EducationEntry, all: EducationEntry[], normalizeDept: (s: string) => string | null): string | null {
  const one = (e: EducationEntry): string | null => {
    const d = e.department ? (normalizeDept(e.department) ?? e.department) : null;
    const paren: string[] = [];
    if (e.majorDetail) paren.push(e.majorDetail);
    const field = (e.degreeName ?? "").replace(/(전문학사|학사|석사|박사)/g, " ").trim();
    if (field && d && !d.replace(/\s/g, "").startsWith(field.replace(/\s/g, ""))) paren.push(e.degreeName!);
    if (!d) return paren.length ? paren.join(", ") : null;
    return paren.length ? `${d}(${paren.join(", ")})` : d;
  };
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (prefix: string, core: string | null) => {
    const key = (core ?? "").replace(/\s/g, "");
    if (!core || seen.has(key)) return;
    seen.add(key); parts.push(`${prefix}${core}`);
  };
  push("", one(final));
  for (const s of secondaryMajorsOf(final, all)) push(`${s.majorType} `, one(s));
  // 다른 학력의 주전공: 높은 학위 순 (같은 단계는 접두어 없음, 낮은 단계는 "석사 "/"학부 ")
  const finalRank = rankOf(final);
  const others = all
    .filter(e => e !== final && !(e.majorType && e.majorType !== "주전공") && e.department)
    .sort((a, b) => rankOf(b) - rankOf(a));
  for (const e of others) {
    const r = rankOf(e);
    const prefix = r >= finalRank ? "" : e.degree === "학사" || e.degree === "전문학사" || (!e.degree && !e.graduateSchool) ? "학부 " : e.degree ? `${e.degree} ` : "";
    push(prefix, one(e));
  }
  return parts.join(" / ") || null;
}

/**
 * 학력 표시 문자열 (AI 분석 팝업 '학력' 값 = 승인 후 저장·목록 표시 값).
 * web-app/src/lib/educationDisplay.ts 의 formatEducationSummary와 동일 규칙 (test-resume-education에서 일치 검증):
 *   특수·통번역대학원: "학교 대학원명 [핵심전공] 학위" / 학부·일반대학원: "학교 학과 학위"
 *   같은 대학원 석사·박사는 "석사·박사", 졸업 외 상태는 "학사(졸업예정)"·"석사(수료)", 학위 미기재 시 생성하지 않음
 */
export function formatEducationSummary(entries: EducationEntry[], normalizeBase: (s: string) => string = s => s): string | null {
  const SECONDARY = new Set(["복수전공", "제2전공", "부전공"]);
  const core = entries.filter(e => !(e.majorType && SECONDARY.has(e.majorType)));
  if (core.length === 0) return null;
  const top = Math.max(...core.map(rankOf));
  const picked = top >= 2.5 ? core.filter(e => rankOf(e) >= 2.5) : core.filter(e => rankOf(e) === top).slice(0, 1);
  const baseOf = (e: EducationEntry) => {
    const school = (e.school ?? "").trim();
    let grad = (e.graduateSchool ?? "").trim();
    if (grad && school && grad.startsWith(school)) grad = grad.slice(school.length).trim();
    const special = !!grad && !/^(일반\s*)?대학원$/.test(grad);
    return { base: [school, special ? grad : ""].filter(Boolean).join(" "), special };
  };
  const fieldOf = (e: EducationEntry) => (e.degreeName ?? "").replace(/(전문학사|학사|석사|박사)/g, " ").replace(/\s+/g, " ").trim() || null;
  const tokenOf = (e: EducationEntry) => `${e.degree ?? ""}${e.status && e.status !== "졸업" ? `(${e.status === "재학중" ? "재학" : e.status})` : ""}`;

  const groups = new Map<string, EducationEntry[]>();
  for (const e of picked) {
    const { base, special } = baseOf(e);
    const key = (special ? base : `${base}|${e.department ?? ""}`).replace(/\s+/g, "");
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const parts = [...groups.values()]
    .sort((a, b) => Math.max(...b.map(rankOf)) - Math.max(...a.map(rankOf)))
    .map(g => {
      const sorted = [...g].sort((a, b) => rankOf(a) - rankOf(b));
      const { base, special } = baseOf(g[0]);
      const head = normalizeBase(base || (g[0].graduateSchool ?? ""));
      const major = special
        ? (new Set(sorted.map(e => e.degree ?? "")).size === 1 ? (fieldOf(sorted[0]) ?? sorted[0].department ?? "") : "")
        : (g[0].department ?? "");
      const tokens: string[] = [];
      for (const e of sorted) { const t = tokenOf(e); if (t && !tokens.includes(t)) tokens.push(t); }
      return [head, major, tokens.join("·")].filter(Boolean).join(" ");
    });
  return parts.join(" / ") || null;
}

/** AI 메모에 덧붙일 전체 학력 이력 요약 (기존 notes 필드 재사용, UI 변경 없음) */
export function summarizeEducationHistory(entries: EducationEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((e, i) => {
    const parts = [
      formatEducationName(e),
      e.department,
      e.majorDetail ? `(세부: ${e.majorDetail})` : null,
      e.majorType && e.majorType !== "주전공" ? `[${e.majorType}]` : null,
      e.degreeName ?? e.degree,
      e.status,
    ].filter(Boolean);
    const yrs = e.admissionYear || e.graduationYear ? ` (${e.admissionYear ?? ""}~${e.graduationYear ?? ""})` : "";
    return `${i + 1}) ${parts.join(" ")}${yrs}`;
  });
  return `[학력 이력] ${lines.join(" / ")}`;
}

/**
 * 학교/대학원명 정규화. 원문에 통번역(통역번역) 과정이 명시된 경우에만 표준 명칭으로 맞춘다.
 * 학교명만 일치한다고 통번역대학원으로 바꾸지 않는다 (예: 한국외국어대학교 경영정보대학원 → 그대로).
 */
export function normalizeEducationName(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (RESUME_EDUCATION_LIST.includes(t)) return t;
  const tl = t.toLowerCase();
  const isTI = /통번역|통역번역|interpret|translat|t&i/i.test(t);

  if (isTI && /대학원/.test(t)) {
    const KO: Array<[RegExp, string]> = [
      [/한국외대|한국외국어대학교/, "한국외국어대학교 통번역대학원"],
      [/이화여대|이화여자대학교/, "이화여자대학교 통역번역대학원"],
      [/서울외대|서울외국어대학원대학교/, "서울외국어대학원대학교 통번역대학원"],
      [/부산외대|부산외국어대학교/, "부산외국어대학교 통번역대학원"],
      [/계명대/, "계명대학교 통번역대학원"],
      [/제주대/, "제주대학교 통번역대학원"],
      [/선문대/, "선문대학교 통번역대학원"],
    ];
    for (const [re, val] of KO) if (re.test(t)) return val;
  }
  if (/중앙대/.test(t) && /국제대학원/.test(t)) return "중앙대학교 국제대학원";

  // 해외 기관: 통번역 전문기관(ESIT/FTI/MIIS)은 기관명만으로, 그 외 대학은 통번역 과정 명시 시에만 표준화
  if (tl.includes("esit")) return "Université Paris Cité ESIT";
  if (tl.includes("geneva") && (tl.includes("fti") || isTI)) return "University of Geneva FTI";
  if (tl.includes("middlebury") || tl.includes("monterey")) return "Middlebury Institute of International Studies at Monterey";
  if (isTI) {
    const EN: Array<[string, string]> = [
      ["macquarie", "Macquarie University - Translation & Interpreting"],
      ["bath", "University of Bath"],
      ["westminster", "University of Westminster"],
      ["leeds", "University of Leeds"],
      ["ottawa", "University of Ottawa"],
    ];
    for (const [k, v] of EN) if (tl.includes(k)) return v;
  }
  return t;
}
