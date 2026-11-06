// ─── 통번역사 학력 표시 — educationHistory(구조화 학력 이력) 기반 ──────────────
// 목록 '학력' 컬럼과 상세 프로필 학력 이력에서 공통 사용한다.
// educationHistory가 없거나(기존 등록자) 현재 학력값과 맞지 않으면(수동 수정) 기존 education 값으로 대체 표시한다.
// 표시 전용 — 저장 데이터는 바꾸지 않는다.

export interface EducationHistoryEntry {
  school?: string | null;
  graduateSchool?: string | null;
  graduateSchoolType?: string | null;
  department?: string | null;
  majorDetail?: string | null;
  degree?: string | null;
  degreeName?: string | null;
  majorType?: string | null;
  status?: string | null;
  admissionYear?: number | null;
  graduationYear?: number | null;
  sourceText?: string | null;
}

const DEGREE_RANK: Record<string, number> = { 박사: 4, 석사: 3, 학사: 2, 전문학사: 1 };
const SECONDARY_MAJOR = new Set(["복수전공", "제2전공", "부전공"]);

export function parseEducationHistory(raw: unknown): EducationHistoryEntry[] {
  let v: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    try { v = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is EducationHistoryEntry => !!e && typeof e === "object" && !!((e as EducationHistoryEntry).school || (e as EducationHistoryEntry).graduateSchool || (e as EducationHistoryEntry).department));
}

/** 학교명 약칭: 한국외국어대학교→한국외대, 이화여자대학교→이화여대, 고려대학교→고려대 */
export function abbreviateSchool(name: string): string {
  const t = name.trim();
  const KNOWN: Record<string, string> = {
    "한국외국어대학교": "한국외대",
    "서울외국어대학원대학교": "서울외대",
    "부산외국어대학교": "부산외대",
    "이화여자대학교": "이화여대",
  };
  if (KNOWN[t]) return KNOWN[t];
  if (/여자대학교$/.test(t)) return t.replace(/여자대학교$/, "여대");
  if (/[가-힣]대학교$/.test(t)) return t.replace(/대학교$/, "대");
  return t;
}

const rank = (e: EducationHistoryEntry) => (e.degree ? DEGREE_RANK[e.degree] ?? 0 : (e.graduateSchool ? 2.5 : 0));
const isGeneralGrad = (g: string | null | undefined) => !g || /^(일반\s*)?대학원$/.test(g.trim());

/**
 * 학력 표시 규칙 (서버 resumeEducation.formatEducationSummary와 동일 — 테스트로 일치 검증):
 *   특수·통번역대학원: "학교 대학원명 [핵심전공] 학위"   (핵심전공 = 학위명의 분야 또는 학과, 학위 1개일 때만)
 *   학부·일반대학원:   "학교 학과 학위"
 *   학위 토큰: 석사·박사 묶음, 졸업 외 상태는 "석사(수료)"처럼 구분. 학위 미기재 시 생성하지 않음
 */
function schoolBase(e: EducationHistoryEntry): { base: string; special: boolean } {
  const school = (e.school ?? "").trim();
  let grad = (e.graduateSchool ?? "").trim();
  if (grad && school && grad.startsWith(school)) grad = grad.slice(school.length).trim();
  const special = !isGeneralGrad(grad);
  return { base: [school, special ? grad : ""].filter(Boolean).join(" "), special };
}

function degreeField(e: EducationHistoryEntry): string | null {
  const f = (e.degreeName ?? "").replace(/(전문학사|학사|석사|박사)/g, " ").replace(/\s+/g, " ").trim();
  return f || null;
}

function degreeToken(e: EducationHistoryEntry): string {
  const st = e.status && e.status !== "졸업" ? `(${e.status === "재학중" ? "재학" : e.status})` : "";
  return `${e.degree ?? ""}${st}`;
}

/**
 * 핵심 학력 표시 문자열.
 * - 석사·박사 과정이 있으면 대학원 학력만, 없으면 최종 학부 학력
 * - 서로 다른 학교·대학원은 " / "로 구분, 같은 대학원의 석사·박사는 "석사·박사"로 묶음
 * - 복수·제2·부전공은 학력이 아닌 전공 정보이므로 제외
 */
export function formatEducationSummary(history: EducationHistoryEntry[], normalizeBase: (s: string) => string = s => s): string | null {
  const core = history.filter(e => !(e.majorType && SECONDARY_MAJOR.has(e.majorType)));
  if (core.length === 0) return null;
  const top = Math.max(...core.map(rank));
  const picked = top >= 2.5 ? core.filter(e => rank(e) >= 2.5) : core.filter(e => rank(e) === top).slice(0, 1);

  const groups = new Map<string, EducationHistoryEntry[]>();
  for (const e of picked) {
    const { base, special } = schoolBase(e);
    const key = (special ? base : `${base}|${e.department ?? ""}`).replace(/\s+/g, "");
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const parts = [...groups.values()]
    .sort((a, b) => Math.max(...b.map(rank)) - Math.max(...a.map(rank)))
    .map(g => {
      const sorted = [...g].sort((a, b) => rank(a) - rank(b));
      const { base, special } = schoolBase(g[0]);
      const head = normalizeBase(base || (g[0].graduateSchool ?? ""));
      const uniqDegrees = new Set(sorted.map(e => e.degree ?? ""));
      const major = special
        ? (uniqDegrees.size === 1 ? (degreeField(sorted[0]) ?? sorted[0].department ?? "") : "")
        : (g[0].department ?? "");
      const tokens: string[] = [];
      for (const e of sorted) {
        const t = degreeToken(e);
        if (t && !tokens.includes(t)) tokens.push(t);
      }
      return [head, major, tokens.join("·")].filter(Boolean).join(" ");
    });
  return parts.join(" / ") || null;
}

/** 상세 프로필용 전체 학력 이력 한 줄씩 */
export function formatEducationLines(history: EducationHistoryEntry[]): string[] {
  return history.map(e => {
    const g = e.graduateSchool ?? "";
    const school = g ? (e.school && !g.startsWith(e.school) ? `${e.school} ${g}` : g) : (e.school ?? "");
    const major = [
      e.majorType && e.majorType !== "주전공" ? `${e.majorType}` : null,
      e.department,
      e.majorDetail ? `(${e.majorDetail})` : null,
    ].filter(Boolean).join(" ");
    const degree = [e.degreeName ?? e.degree, e.status].filter(Boolean).join(" ");
    const yrs = e.admissionYear || e.graduationYear ? `${e.admissionYear ?? ""}~${e.graduationYear ?? ""}` : "";
    return [school, major, degree, yrs].filter(Boolean).join(" · ");
  });
}

/** 저장된 education 값이 학력 이력과 같은 학교를 가리키는지 (수동 수정 여부 판단) */
function historyMatchesEducation(history: EducationHistoryEntry[], education: string | null | undefined): boolean {
  if (!education) return true;
  const ed = education.replace(/\s+/g, "");
  return history.some(e => {
    const s = (e.school ?? "").replace(/\s+/g, "");
    const g = (e.graduateSchool ?? "").replace(/\s+/g, "");
    return (s && (ed.includes(s) || ed.includes(abbreviateSchool(e.school!).replace(/\s+/g, "")))) || (g.length > 3 && ed.includes(g));
  });
}

/**
 * 목록·상세 학력 표시값.
 * 학위가 포함된 저장값 우선 → educationHistory → 없으면 기존 education(표준명 라벨) + 전공 필드에 기재된 학위(석사·박사) 보충 표시.
 */
export function educationDisplay(
  educationHistory: unknown,
  education: string | null | undefined,
  major: string | null | undefined,
  labelOf: (v: string) => string = v => v,
): string | null {
  // 저장된 학력값에 학위가 이미 포함되어 있으면(AI 분석 팝업에서 승인·수정한 값) 그대로 표시
  if (education && /학사|석사|박사/.test(education)) return labelOf(education);
  const history = parseEducationHistory(educationHistory);
  if (history.length > 0 && historyMatchesEducation(history, education)) {
    const s = formatEducationSummary(history);
    if (s) return s;
  }
  if (!education) return null;
  const label = labelOf(education);
  // 전공 원문에 적힌 학위만 보충 (생성 금지). 수료·재학·졸업예정은 구분 표시, "과정"만 있고 상태 불명이면 보충하지 않음
  const m = (major ?? "").match(/(박사|석사)\s*(과정)?\s*(수료|재학중?|졸업\s*예정)?/);
  if (!m || label.includes(m[1])) return label;
  if (m[2] && !m[3]) return label;
  const st = m[3] ? `(${m[3].replace(/\s/g, "").replace("재학중", "재학")})` : "";
  return `${label} ${m[1]}${st}`;
}
