/**
 * inquirySourceFields — 의뢰서 원문 필드 추출 + VERITAS 필드 매핑 (결정론적 코어)
 *
 * ## 왜 이 파일이 존재하는가 (구조적 배경)
 * AI 의뢰분석의 반복 문제는 "원문에 명확히 기재된 값까지 모델이 재해석/추론해서 다른 값으로 바꾸는 것"이다.
 * 프롬프트를 아무리 조여도 단일 LLM 매핑은 이 재해석을 근본적으로 막지 못한다.
 * → 해결: 라벨-값 매핑을 **AI가 아니라 코드가** 처리한다.
 *   - Stage 1(추출): 원문 텍스트를 결정론적으로 파싱해 sourceFields = { key: { raw, sourceLabel } } 를 만든다.
 *   - Stage 2(매핑): sourceFields 의 raw 값을 form 필드에 **그대로 복사(verbatim)** 한다.
 *     방향 분해(언어)·라벨 정규화(통역형태/문서형태)·날짜 포맷 변환처럼 "구조 변환"만 허용하며,
 *     그 변환도 오직 해당 필드 자신의 raw 안에서만 수행한다(다른 라벨 값과 섞지 않음).
 *
 * AI(OpenAI)는 이 파일을 사용하지 않는다. AI 의 역할은 두 가지로 축소된다:
 *   (a) 이미지/스캔본의 "있는 그대로" 전사(transcription) — 그 전사 결과가 이 파일의 입력이 된다.
 *   (b) 라벨-값 구조가 약한 비정형 이메일 본문에서만 sourceFields 후보를 semantic 추출(→ 전부 "확인필요" 표시).
 *
 * 이 파일은 특정 테스트 문서에 하드코딩하지 않는다. 라벨 사전(동의어)만으로 다양한 고객사 서식에 대응한다.
 */

// ─── 고정 라벨(inquiryMeta 와 동기화) ────────────────────────────────────────
export const INTERPRET_TYPES = [
  "동시통역", "순차통역", "위스퍼링통역", "수행통역", "VIP수행통역",
  "가이드통역", "미팅통역", "전시회통역", "화상통역", "전화통역", "기타통역",
] as const;
export const DOCUMENT_TYPES = ["Word", "Excel", "PowerPoint", "PDF", "한글", "이미지", "기타"] as const;

// ─── sourceFields 타입 ───────────────────────────────────────────────────────
/** 원문에서 추출한 한 필드. raw=원문 값(그대로), sourceLabel=원문 라벨, origin=출처. */
export interface SourceField {
  raw: string;
  sourceLabel: string;
  /** document = 원문에 명시된 라벨-값(결정론적 추출) · inferred = 비정형 AI 추론(확인필요) */
  origin: "document" | "inferred";
}
export type SourceKey =
  | "companyName" | "department" | "contactName" | "contactPosition"
  | "contactPhone" | "contactMobile" | "contactEmail"
  | "languages" | "languageFrom" | "languageTo"
  | "interpretType" | "interpretDuration" | "schedule" | "place" | "subject"
  | "requirements" | "documentType" | "documentUsage" | "volume"
  | "desiredCompletionDate" | "quoteDueDate"
  | "channelHint" | "serviceHint";
export type SourceFields = Partial<Record<SourceKey, SourceField>>;

// ─── 라벨 사전(동의어) ───────────────────────────────────────────────────────
// 자연어 형태로 나열한다. 매칭 시 좌변/사전 모두 normalizeLabel 로 공백·기호를 제거해 비교하므로
// "통역할 언어" 는 "통역할언어" 로 정규화된다. 새 서식이 나오면 여기 동의어만 추가하면 된다.
const LABEL_DICT: Array<{ key: SourceKey; labels: string[] }> = [
  { key: "companyName",     labels: ["회사명", "회사", "거래처", "거래처명", "업체명", "업체", "기관명", "기관", "고객사", "company", "companyname"] },
  { key: "department",      labels: ["부서", "부서명", "소속", "팀", "department"] },
  { key: "contactName",     labels: ["담당자", "담당자명", "담당", "성명", "이름", "연락담당", "신청자", "contact", "name"] },
  { key: "contactPosition", labels: ["직함", "직급", "직위", "position", "title"] },
  { key: "contactPhone",    labels: ["전화", "전화번호", "유선", "유선전화", "사무실", "사무실전화", "대표번호", "tel", "phone", "연락처"] },
  { key: "contactMobile",   labels: ["휴대폰", "휴대전화", "핸드폰", "핸드폰번호", "휴대폰번호", "모바일", "mobile", "hp", "cell"] },
  { key: "contactEmail",    labels: ["이메일", "메일", "이메일주소", "e-mail", "email", "mail"] },
  // 통역할 언어(단일 셀) — 이후 방향(출발/도착) 분해. 별도 라벨이면 languageFrom/To 로 직접 매핑.
  { key: "languages",       labels: ["통역할언어", "통역언어", "언어", "번역언어", "언어쌍", "language", "languages", "언어페어"] },
  { key: "languageFrom",    labels: ["출발언어", "원본언어", "출발어", "출발", "원문언어", "source", "sourcelanguage"] },
  { key: "languageTo",      labels: ["도착언어", "목표언어", "도착어", "도착", "target", "targetlanguage"] },
  { key: "interpretType",   labels: ["통역의형태", "통역형태", "통역종류", "통역방식", "통역유형", "interpretationtype"] },
  { key: "interpretDuration", labels: ["1일통역시간", "일통역시간", "통역시간", "소요시간", "통역소요시간", "통역시간대"] },
  { key: "schedule",        labels: ["통역일정및기간", "통역일정", "통역일시", "행사일시", "행사일정", "일정", "기간", "일정및기간", "통역기간", "번역기간", "행사기간", "schedule", "date"] },
  { key: "place",           labels: ["통역수행장소", "통역장소", "장소", "행사장", "수행장소", "행사장소", "venue", "location", "place"] },
  { key: "subject",         labels: ["통역할주제", "통역주제", "주제", "회의명", "행사명", "번역분야", "분야", "주제및내용", "회의주제", "subject", "topic"] },
  { key: "requirements",    labels: ["요구및주의사항", "요구및주의", "요구사항", "요청사항", "특이사항", "비고", "기타", "참고사항", "요청내용", "메모", "note", "notes", "requirements", "remarks"] },
  { key: "documentType",    labels: ["원문서형태", "문서형태", "파일형식", "문서형식", "documenttype"] },
  { key: "documentUsage",   labels: ["사용용도", "용도", "번역용도", "제출처", "usage"] },
  { key: "volume",          labels: ["분량", "수량", "페이지", "페이지수", "단어수", "volume", "pages"] },
  { key: "desiredCompletionDate", labels: ["납기", "희망납기", "완료일", "희망완료일", "마감일", "납품일", "duedate", "deadline"] },
  { key: "quoteDueDate",    labels: ["견적요청일", "견적마감", "견적희망일", "견적요청마감"] },
  { key: "channelHint",     labels: ["접수경로", "접수채널", "문의경로", "채널", "channel"] },
  { key: "serviceHint",     labels: ["서비스유형", "서비스", "의뢰유형", "요청서비스", "servicetype"] },
];

/** 라벨 정규화: 공백·앞뒤 기호·번호글머리 제거 후 소문자화. "· 통역할 언어 *" → "통역할언어". */
function normalizeLabel(s: string): string {
  return s
    .replace(/[\s　]+/g, "")                        // 모든 공백(전각 포함) 제거
    .replace(/^[-*·•▶◆■○◦▪▷»♦※\d.)\]]+/, "")           // 글머리 기호/번호 제거
    .replace(/[:：*)\]\-]+$/, "")                        // 꼬리 기호 제거
    .toLowerCase();
}

const DICT_MAP: Map<string, SourceKey> = (() => {
  const m = new Map<string, SourceKey>();
  for (const { key, labels } of LABEL_DICT) {
    for (const lb of labels) m.set(normalizeLabel(lb), key);
  }
  return m;
})();

// 라벨 매칭용 동의어 목록(정규화, 최장 우선). "회사 E-mail", "휴대폰 번호" 처럼
// 접두/접미·장식이 붙은 라벨도 "포함(contains)" 매칭으로 잡기 위함.
const SYNONYMS: Array<{ norm: string; key: SourceKey }> = LABEL_DICT
  .flatMap(({ key, labels }) => labels.map(lb => ({ norm: normalizeLabel(lb), key })))
  .filter(s => s.norm.length >= 2)
  .sort((a, b) => b.norm.length - a.norm.length);

/**
 * 라벨 문자열 → canonical key. 정확일치 우선, 없으면 "가장 긴 동의어 포함" 매칭.
 * 예: "회사 E-mail" → contactEmail("e-mail" 포함, "회사"보다 길어 우선). 미매칭이면 null.
 */
export function matchLabelKey(label: string): SourceKey | null {
  const n = normalizeLabel(label);
  if (!n) return null;
  const exact = DICT_MAP.get(n);
  if (exact) return exact;
  for (const s of SYNONYMS) {
    if (n.includes(s.norm)) return s.key;
  }
  return null;
}

/** 여러 줄에 걸쳐 값이 이어질 수 있는 필드(다음 라벨 전까지 이어붙임). */
const MULTILINE_KEYS = new Set<SourceKey>(["requirements", "subject", "schedule"]);

/**
 * 예시/도움말(placeholder) 문구 제거. 양식의 회색 예시("ex) 8시간", "예) ...", "예: ...", "(예시 ...)")가
 * 실제 값으로 섞여 들어온 경우를 방어한다. 실제 데이터 손상을 막기 위해 "예/ex 뒤에 구분기호"가 있을 때만 제거한다.
 * requirements 처럼 원문 보존이 중요한 멀티라인 필드에는 적용하지 않는다(호출측에서 제외).
 */
export function stripHelperText(value: string): string {
  if (!value) return "";
  let v = value;
  // (예: ...) / (ex ...) / (예시 ...) 형태의 괄호 도움말 제거
  v = v.replace(/[（(]\s*(?:ex|e\.?g\.?|예시|예|참고|보기)\b[^)）]*[)）]/gi, " ");
  // 괄호 없는 "ex) ...", "예) ...", "예: ..." — 마커부터 "줄 끝까지" 통째로 제거.
  //  (예시에 쉼표가 있어도 "동시통역 ex) 동시통역, 순차통역" → "동시통역" 처럼 전부 제거)
  v = v.replace(/(?:^|[\s,/·|(])(?:ex|예시|예)\s*[)\]:：.][^\n]*/gi, " ");
  return v.replace(/[ \t]{2,}/g, " ").trim();
}

// ─── Stage 1: 결정론적 라벨-값 추출 ──────────────────────────────────────────

interface LabelMatch { key: SourceKey; sourceLabel: string; value: string; }

/** 한 줄에서 "라벨 <구분자> 값"을 파싱. 구분자: : ： | tab, 없으면 2칸+공백(좌변이 사전에 있을 때만). */
function matchLabelLine(line: string): LabelMatch | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 1) 명시 구분자
  const sepMatch = trimmed.match(/^(.*?)\s*[:：|\t│]\s*(.*)$/);
  if (sepMatch) {
    const key = matchLabelKey(sepMatch[1]);
    if (key) return { key, sourceLabel: sepMatch[1].trim(), value: sepMatch[2].trim() };
    // 좌변이 사전에 없으면 라벨 줄이 아님(값 안의 콜론 등) → 매칭 실패
    return null;
  }

  // 2) 구분자 없이 2칸 이상 공백 — 좌변이 사전에 있을 때만 라벨로 인정
  const spaceMatch = trimmed.match(/^(.+?)\s{2,}(.+)$/);
  if (spaceMatch) {
    const key = matchLabelKey(spaceMatch[1]);
    if (key) return { key, sourceLabel: spaceMatch[1].trim(), value: spaceMatch[2].trim() };
  }
  return null;
}

/**
 * 원문 텍스트를 결정론적으로 파싱해 sourceFields 를 만든다.
 * - 라벨 줄을 만나면 새 필드 시작. MULTILINE_KEYS 필드는 다음 라벨 줄 전까지 이어지는 줄을 값에 이어붙인다.
 * - 같은 key 가 여러 번 나오면 먼저 나온(상단) 값을 보존한다(빈 값으로 덮지 않음).
 */
export function extractSourceFieldsDeterministic(text: string): { sourceFields: SourceFields; matchedCount: number } {
  const sourceFields: SourceFields = {};
  const lines = (text || "").split(/\r?\n/);
  let current: SourceKey | null = null;

  const put = (key: SourceKey, sourceLabel: string, raw: string) => {
    const existing = sourceFields[key];
    if (existing && existing.raw.trim()) return;   // 첫 값 보존
    // 단일 값 필드는 예시/도움말 문구 제거. requirements/subject/schedule(멀티라인)은 원문 보존.
    const cleaned = MULTILINE_KEYS.has(key) ? raw : stripHelperText(raw);
    sourceFields[key] = { raw: cleaned, sourceLabel, origin: "document" };
  };

  for (const line of lines) {
    const m = matchLabelLine(line);
    if (m) {
      put(m.key, m.sourceLabel, m.value);
      current = m.key;
      continue;
    }
    // 라벨 줄이 아님 → 직전 필드가 멀티라인 대상이면 이어붙인다.
    if (current && MULTILINE_KEYS.has(current) && line.trim()) {
      const f = sourceFields[current];
      if (f) f.raw = f.raw ? `${f.raw}\n${line.trim()}` : line.trim();
    }
  }

  const matchedCount = Object.values(sourceFields).filter(f => f && f.raw.trim()).length;
  return { sourceFields, matchedCount };
}

/**
 * vision 이 이미지에서 읽어낸 "라벨-값 행" 목록을 sourceFields 로 변환한다.
 * - 라벨→canonical key 매핑은 코드(DICT_MAP)가 결정론적으로 수행한다(모델이 키를 고르지 않음).
 * - 값은 verbatim 보존. 단일 값 필드는 예시/도움말 문구만 제거. 사전에 없는 라벨은 무시.
 * 이렇게 하면 "픽셀 읽기(공간 구조·예시 제외)"는 vision 이, "필드 결정"은 코드가 담당해 값 재해석을 차단한다.
 */
export function sourceFieldsFromLabelValueRows(
  rows: Array<{ label?: unknown; value?: unknown }>,
  origin: "document" | "inferred" = "document",
): SourceFields {
  const sf: SourceFields = {};
  for (const r of rows) {
    const label = typeof r?.label === "string" ? r.label.trim() : "";
    const rawIn = typeof r?.value === "string" ? r.value : "";
    if (!label) continue;
    const key = matchLabelKey(label);
    if (!key) continue;
    if (sf[key]?.raw.trim()) continue; // 첫 값(상단) 보존
    const raw = MULTILINE_KEYS.has(key) ? rawIn.trim() : stripHelperText(rawIn).trim();
    if (!raw) continue;
    sf[key] = { raw, sourceLabel: label, origin };
  }
  return sf;
}

/** 여러 sourceFields 레이어를 병합한다. 뒤 레이어(우선순위 높음)의 비어있지 않은 값이 앞을 덮어쓴다. */
export function mergeSourceFields(...layers: SourceFields[]): SourceFields {
  const out: SourceFields = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v && v.raw.trim()) out[k as SourceKey] = v;
    }
  }
  return out;
}

// ─── Stage 2 보조: 구조 변환기(각 필드 raw 안에서만) ─────────────────────────

/** "한국어 → 영어", "한↔영", "한국어 ... 영어 말레이시아어", "한국어에서 영어로" 등에서 출발/도착 분해. */
export function splitLanguages(raw: string): { from: string; to: string; ambiguous: boolean } {
  const src = (raw || "").trim();
  if (!src) return { from: "", to: "", ambiguous: false };

  // 값 안에 출발/도착 서브라벨이 있는 경우 우선 처리 (예: "출발 한국어 도착 영어")
  const sub = src.match(/출발\s*[:：]?\s*(.+?)\s*(?:도착|→|->)\s*[:：]?\s*(.+)$/);
  if (sub) return { from: sub[1].trim(), to: sub[2].trim(), ambiguous: false };

  // 방향 구분자를 단일 델리미터로 치환 후 분해. (…, ↔, →, ->, -, ~, /, 에서/으로 등)
  const D = "";
  const normalized = src
    .replace(/에서/g, D)
    .replace(/(?:->|=>|~>|→|⇒|↔|⇄|~|∼|>|\/|\||、|,|…|\.{2,}|―|—|-)/g, D);
  const parts = normalized.split(D).map(s => s.replace(/(?:으로|로)\s*$/, "").trim()).filter(Boolean);

  if (parts.length === 0) return { from: src, to: "", ambiguous: true };
  if (parts.length === 1) return { from: parts[0], to: "", ambiguous: true }; // 방향 미상 → 확인필요
  return { from: parts[0], to: parts.slice(1).join(" "), ambiguous: false };
}

/**
 * raw 안에 포함된 고정 통역형태 라벨을 찾는다. "가장 먼저 등장한" 값을 고른다.
 *   실제 선택값은 예시("ex) 동시통역, 순차통역")보다 앞에 오므로, 최장 매칭이 아니라 최초 등장이 정답.
 *   (stripHelperText 로 예시가 이미 제거되지만, 만약 남아 있어도 앞선 실제값을 선택하도록 이중 방어)
 * 없으면 "".
 */
export function matchInterpretType(raw: string): string {
  const s = (raw || "").replace(/\s+/g, "");
  let best = ""; let bestIdx = Infinity;
  for (const t of INTERPRET_TYPES) {
    const idx = s.indexOf(t.replace(/\s+/g, ""));
    if (idx >= 0 && (idx < bestIdx || (idx === bestIdx && t.length > best.length))) {
      best = t; bestIdx = idx;
    }
  }
  return best;
}

/** raw 안에 포함된 고정 문서형태를 찾는다. 없으면 "". */
export function matchDocumentType(raw: string): string {
  const s = (raw || "").toLowerCase();
  const hit = DOCUMENT_TYPES.find(t => s.includes(t.toLowerCase()));
  return hit ?? "";
}

/** 현재 KST 연도 — 연도 미기재 날짜의 기본 연도. */
function kstYear(): number {
  return Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 4));
}
function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** 문자열에서 첫 날짜를 YYYY-MM-DD 로 파싱. 실패 시 null. */
export function parseDate(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  // YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD / YYYY년 M월 D일
  let m = s.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  // M월 D일 (연도 미기재 → KST 연도)
  m = s.match(/(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?/);
  if (m) return `${kstYear()}-${pad2(+m[1])}-${pad2(+m[2])}`;
  return null;
}

/** 문자열에서 첫 시각을 HH:mm 로 파싱. 실패 시 null. */
export function parseTime(raw: string): string | null {
  const s = (raw || "").trim();
  // 오전/오후 h시 m분
  let m = s.match(/(오전|오후)?\s*(\d{1,2})\s*시\s*(\d{1,2})?\s*분?/);
  if (m) {
    let h = +m[2];
    if (m[1] === "오후" && h < 12) h += 12;
    if (m[1] === "오전" && h === 12) h = 0;
    return `${pad2(h)}:${pad2(m[3] ? +m[3] : 0)}`;
  }
  // HH:mm
  m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${pad2(+m[1])}:${m[2]}`;
  return null;
}

/** 일정 텍스트(단일/범위)를 datetime-local(YYYY-MM-DDTHH:mm) 시작/종료로 파싱. 실패 필드는 "". */
export function parseSchedule(raw: string): { from: string; to: string; parsed: boolean } {
  const s = (raw || "").trim();
  if (!s) return { from: "", to: "", parsed: false };

  // 범위 구분자: ~ ∼ — ― · / 공백으로 둘러싸인 하이픈 / to.
  // (날짜 내부 하이픈 "2025-09-01" 은 공백이 없으므로 분리되지 않는다.)
  const rangeParts = s
    .replace(/부터|까지/g, " ")
    .split(/\s*(?:~|∼|—|―|·)\s*|\s+-\s+|\s+to\s+/i)
    .map(p => p.trim())
    .filter(Boolean);

  const build = (part: string, fallbackDate?: string): string => {
    const d = parseDate(part) ?? fallbackDate ?? null;
    if (!d) return "";
    const t = parseTime(part) ?? "09:00";
    return `${d}T${t}`;
  };

  if (rangeParts.length >= 2) {
    const from = build(rangeParts[0]);
    // 종료 파트에 날짜가 없으면(예: "9월 1일 ~ 3일") 시작 날짜를 보완
    const toDate = parseDate(rangeParts[1]);
    const to = build(rangeParts[1], toDate ? undefined : (from ? from.slice(0, 10) : undefined));
    return { from, to, parsed: !!(from || to) };
  }
  const from = build(s);
  return { from, to: "", parsed: !!from };
}

// ─── Stage 2: sourceFields → VERITAS 등록폼 필드 매핑(결정론적) ──────────────

export interface MappedFields {
  channel: string; serviceType: string;
  customerCompanyName: string; department: string; contactName: string; contactPosition: string;
  contactPhone: string; contactMobile: string; contactEmail: string;
  languageFrom: string; languageTo: string;
  subject: string; requirements: string; quoteDueDate: string;
  interpretType: string; scheduleFrom: string; scheduleTo: string; interpretDuration: string; place: string;
  documentType: string; documentUsage: string; volume: string; desiredCompletionDate: string;
}
export interface MapResult {
  fields: Partial<MappedFields>;
  warnings: string[];
  /** 필드별 근거(원문 라벨 + 원문 값). 검증/디버그용. */
  evidence: Record<string, string>;
}

const CHANNEL_WORDS: Record<string, string> = {
  전화: "phone", 유선: "phone",
  이메일: "email", 메일: "email", email: "email",
  홈페이지: "homepage", 웹사이트: "homepage", homepage: "homepage",
  카카오: "kakao", 카톡: "kakao", kakao: "kakao",
};

/**
 * sourceFields 를 form 필드로 결정론적 매핑.
 * @param channelDefault 라우트가 판단한 접수경로 기본값(예: 비정형 이메일 → "email"). channelHint 가 없을 때만 사용.
 */
export function mapSourceFieldsToForm(sf: SourceFields, channelDefault = ""): MapResult {
  const fields: Partial<MappedFields> = {};
  const warnings: string[] = [];
  const evidence: Record<string, string> = {};
  const inferredLabels: string[] = [];

  // 값이 있으면 그대로 복사하고 근거/추론 표시.
  const take = (key: SourceKey, formKey: keyof MappedFields, label: string): void => {
    const f = sf[key];
    if (!f || !f.raw.trim()) return;
    fields[formKey] = f.raw;
    evidence[formKey] = `${f.sourceLabel}: ${f.raw}`.slice(0, 200);
    if (f.origin === "inferred") inferredLabels.push(label);
  };

  // 1) 직접 복사 필드 (verbatim — 재해석 금지)
  take("companyName", "customerCompanyName", "회사명");
  take("department", "department", "부서");
  take("contactName", "contactName", "담당자");
  take("contactPosition", "contactPosition", "직함");
  take("contactPhone", "contactPhone", "전화번호");
  take("contactMobile", "contactMobile", "휴대폰");
  take("contactEmail", "contactEmail", "이메일");
  take("interpretDuration", "interpretDuration", "1일 통역시간");
  take("place", "place", "통역장소");
  take("subject", "subject", "통역주제");
  // 요구사항: 절대 요약/재작성하지 않고 원문 전체 보존
  take("requirements", "requirements", "요구사항");
  take("documentUsage", "documentUsage", "사용용도");
  take("volume", "volume", "분량");

  // 2) 언어(출발/도착) — 해당 라벨 값 안에서만 분해
  if (sf.languageFrom?.raw.trim() || sf.languageTo?.raw.trim()) {
    take("languageFrom", "languageFrom", "출발언어");
    take("languageTo", "languageTo", "도착언어");
  } else if (sf.languages?.raw.trim()) {
    const langEv = `${sf.languages.sourceLabel}: ${sf.languages.raw}`.slice(0, 200);
    const { from, to, ambiguous } = splitLanguages(sf.languages.raw);
    if (from) { fields.languageFrom = from; evidence.languageFrom = langEv; }
    if (to) { fields.languageTo = to; evidence.languageTo = langEv; }
    if (sf.languages.origin === "inferred") inferredLabels.push("언어");
    if (ambiguous) warnings.push(`언어 방향(출발/도착) 확인필요 — 원문: "${sf.languages.raw}"`);
  }

  // 3) 통역형태 — '통역형태' 라벨 값에서만 결정(장소/요구사항/주제로 추론하지 않음)
  if (sf.interpretType?.raw.trim()) {
    const matched = matchInterpretType(sf.interpretType.raw);
    if (matched) {
      fields.interpretType = matched;
      evidence.interpretType = `${sf.interpretType.sourceLabel}: ${sf.interpretType.raw}`.slice(0, 200);
      if (sf.interpretType.origin === "inferred") inferredLabels.push("통역형태");
    } else {
      warnings.push(`통역형태 확인필요 — 원문 "${sf.interpretType.raw}" 이(가) 고정 항목과 일치하지 않음`);
    }
  }

  // 4) 문서형태(번역)
  if (sf.documentType?.raw.trim()) {
    const matched = matchDocumentType(sf.documentType.raw);
    if (matched) { fields.documentType = matched; evidence.documentType = `${sf.documentType.sourceLabel}: ${sf.documentType.raw}`.slice(0, 200); }
    else warnings.push(`문서형태 확인필요 — 원문 "${sf.documentType.raw}"`);
  }

  // 5) 일정 → scheduleFrom/To (날짜 포맷 변환)
  if (sf.schedule?.raw.trim()) {
    const { from, to, parsed } = parseSchedule(sf.schedule.raw);
    if (from) fields.scheduleFrom = from;
    if (to) fields.scheduleTo = to;
    evidence.schedule = `${sf.schedule.sourceLabel}: ${sf.schedule.raw}`.slice(0, 200);
    if (sf.schedule.origin === "inferred") inferredLabels.push("통역일정");
    if (!parsed) warnings.push(`통역일정 확인필요(자동 파싱 실패) — 원문: "${sf.schedule.raw}"`);
  }

  // 6) 날짜 필드
  if (sf.desiredCompletionDate?.raw.trim()) {
    const d = parseDate(sf.desiredCompletionDate.raw);
    if (d) { fields.desiredCompletionDate = d; evidence.desiredCompletionDate = `${sf.desiredCompletionDate.sourceLabel}: ${sf.desiredCompletionDate.raw}`.slice(0, 200); }
    else warnings.push(`납기 확인필요 — 원문: "${sf.desiredCompletionDate.raw}"`);
  }
  if (sf.quoteDueDate?.raw.trim()) {
    const d = parseDate(sf.quoteDueDate.raw);
    if (d) { fields.quoteDueDate = d; evidence.quoteDueDate = `${sf.quoteDueDate.sourceLabel}: ${sf.quoteDueDate.raw}`.slice(0, 200); }
  }

  // 7) serviceType — 어떤 라벨이 존재하는지로만 판정(값 재해석 아님)
  const has = (k: SourceKey) => !!sf[k]?.raw.trim();
  let serviceType = "";
  if (sf.serviceHint?.raw.trim()) {
    const v = sf.serviceHint.raw;
    if (/통역/.test(v)) serviceType = "interpretation";
    else if (/번역/.test(v)) serviceType = "translation";
    else if (/장비/.test(v)) serviceType = "equipment";
  }
  if (!serviceType) {
    if (has("interpretType") || has("interpretDuration") || has("languages") || has("languageFrom") || has("place")) serviceType = "interpretation";
    else if (has("documentType") || has("volume") || has("documentUsage")) serviceType = "translation";
  }
  if (serviceType) fields.serviceType = serviceType;

  // 8) channel — channelHint 우선, 없으면 라우트 기본값
  if (sf.channelHint?.raw.trim()) {
    const v = sf.channelHint.raw.toLowerCase();
    const found = Object.keys(CHANNEL_WORDS).find(w => v.includes(w.toLowerCase()));
    if (found) fields.channel = CHANNEL_WORDS[found];
  }
  if (!fields.channel && channelDefault) fields.channel = channelDefault;

  // 9) 추론(비정형) 필드 일괄 "확인필요" 경고
  if (inferredLabels.length > 0) {
    warnings.push(`AI 추론 값(원문 라벨 없음) — 확인필요: ${[...new Set(inferredLabels)].join(", ")}`);
  }

  return { fields, warnings, evidence };
}
