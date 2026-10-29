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
// 원문서 형태(복수 선택) — 저장은 "Word, HWP" 처럼 쉼표 구분 문자열(기존 text 컬럼 그대로). 구 값 "한글"→HWP, "PowerPoint"→PPT 로 읽는다.
export const DOCUMENT_TYPES = ["Word", "HWP", "PDF", "Excel", "PPT", "이미지", "기타"] as const;

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
  | "channelHint" | "serviceHint"
  | "submittedAt"   // 고객이 의뢰를 제출한 일시(홈페이지 양식의 접수/신청일시) — 접수일시 자동입력의 유일한 근거
  | "scheduleTime"   // 통역(행사) 시간대 — "시간 : 오후 1시30분-오후4시 정도". 날짜(schedule)와 합쳐 시작·종료 일시를 만든다
  | "arrivalTime" | "arrivalPlace"   // 통역사 도착 요청 시간·장소 — 통역 시작시간과 구분(입력란이 없어 요구사항에 보존, 장소는 상세 장소로 사용)
  | "translationContent"   // 번역할 내용(번역 의뢰서) — 번역 단독이면 '번역 내용/주제'(subject), 복합이면 요구사항에 보존
  | "address";   // 고객 주소/지역 — 폼 필드는 없고, 담당자·장소와 섞이지 않게 분리·검증용으로만 추출
export type SourceFields = Partial<Record<SourceKey, SourceField>>;

// ─── 라벨 사전(동의어) ───────────────────────────────────────────────────────
// 자연어 형태로 나열한다. 매칭 시 좌변/사전 모두 normalizeLabel 로 공백·기호를 제거해 비교하므로
// "통역할 언어" 는 "통역할언어" 로 정규화된다. 새 서식이 나오면 여기 동의어만 추가하면 된다.
const LABEL_DICT: Array<{ key: SourceKey; labels: string[] }> = [
  { key: "companyName",     labels: ["company/organization", "회사명", "회사", "거래처", "거래처명", "업체명", "업체", "기관명", "기관", "고객사", "company", "companyname"] },
  { key: "department",      labels: ["부서", "부서명", "소속", "팀", "department"] },
  { key: "contactName",     labels: ["고객사담당자", "고객담당자", "의뢰담당자", "현장담당자", "담당자", "담당자명", "담당", "성명", "이름", "연락담당", "신청자", "personincharge", "contact", "name"] },
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
  { key: "schedule",        labels: ["날짜", "통역날짜", "행사날짜", "통역일", "통역일정및기간", "통역일정", "통역일시", "행사일시", "행사일정", "일정", "기간", "일정및기간", "통역기간", "번역기간", "행사기간", "행사일", "eventdate", "schedule", "date"] },
  { key: "scheduleTime",    labels: ["시간", "통역시간대", "행사시간", "진행시간", "시작시간", "통역시작시간"] },
  { key: "arrivalTime",     labels: ["도착요청시간", "통역사도착요청시간", "도착시간", "통역사도착시간", "도착희망시간", "집결시간"] },
  { key: "arrivalPlace",    labels: ["도착요청장소", "통역사도착요청장소", "도착장소", "통역사도착장소", "집결장소"] },
  { key: "place",           labels: ["통역수행장소", "통역장소", "장소", "행사장", "수행장소", "행사장소", "통역지역", "행사지역", "eventvenue", "venue", "location", "place"] },
  { key: "address",         labels: ["주소", "회사주소", "사업장주소", "소재지", "지역", "지역명", "소재지역", "address"] },
  { key: "subject",         labels: ["통역할주제", "통역주제", "주제", "회의명", "행사명", "번역분야", "분야", "주제및내용", "회의주제", "subject", "topic"] },
  { key: "translationContent", labels: ["번역할내용", "번역내용", "번역할문서내용", "번역할문서의내용"] },
  { key: "requirements",    labels: ["요구및주의사항", "요구및주의", "요구사항", "요청사항", "특이사항", "비고", "기타", "참고사항", "요청내용", "메모", "note", "notes", "requirements", "remarks"] },
  { key: "documentType",    labels: ["원문서형태", "원본문서의형태", "원본문서형태", "원문의형태", "문서형태", "파일형식", "문서형식", "documenttype"] },
  { key: "documentUsage",   labels: ["번역한문서의사용처", "번역할문서의사용처", "문서사용처", "사용처", "사용용도", "용도", "번역용도", "제출처", "usage"] },
  { key: "volume",          labels: ["의뢰한번역의분량", "번역분량", "의뢰분량", "분량", "수량", "페이지", "페이지수", "단어수", "volume", "pages"] },
  { key: "desiredCompletionDate", labels: ["번역완료희망일", "완료희망일", "납기", "희망납기", "완료일", "희망완료일", "마감일", "납품일", "번역제출기한", "번역제출일", "원고제출기한", "납품기한", "duedate", "deadline"] },
  // 견적서 수령 희망일 — "기한"을 뜻하는 라벨만. '견적요청일'(요청한 날짜)·통역일·발송일은 기한이 아니다.
  { key: "quoteDueDate",    labels: ["견적마감", "견적마감일", "견적희망일", "견적요청마감", "견적서수령희망일", "견적수령희망일", "수령희망일", "견적서희망일",
                                     "견적회신기한", "견적회신요청일", "견적서회신요청일", "견적회신일", "회신요청일", "회신희망일",
                                     "견적기한", "견적요청기한", "견적서제출기한", "견적제출기한", "견적서제출일", "견적제출요청일", "제출기한",
                                     "견적서제출희망일", "견적제출희망일", "견적회신희망일"] },
  // 홈페이지 양식에서 고객이 제출한 일시(①). 메일 발송(②)·수신(③)·시스템 등록(④)·통역일(⑤)과 구분한다.
  { key: "submittedAt",     labels: ["접수일시", "접수일", "접수시간", "접수시각", "신청일시", "신청일", "신청시간", "문의일시", "문의일", "문의시간",
                                     "작성일시", "작성일", "제출일시", "제출일", "의뢰접수일", "의뢰접수일시", "의뢰일시", "의뢰일", "submitted", "submitteddate"] },
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
// "출발/도착/시간/날짜" 는 다른 라벨의 일부로 흔하다("통역사 도착요청 시간", "출발일") → 정확히 같을 때만 인정(포함 매칭 제외)
const EXACT_ONLY = new Set(["출발", "도착", "시간", "날짜"]);
const SYNONYMS: Array<{ norm: string; key: SourceKey }> = LABEL_DICT
  .flatMap(({ key, labels }) => labels.map(lb => ({ norm: normalizeLabel(lb), key })))
  .filter(s => s.norm.length >= 2 && !EXACT_ONLY.has(s.norm))
  .sort((a, b) => b.norm.length - a.norm.length);

/**
 * 라벨 문자열 → canonical key. 정확일치 우선, 없으면 "가장 긴 동의어 포함" 매칭.
 * 예: "회사 E-mail" → contactEmail("e-mail" 포함, "회사"보다 길어 우선). 미매칭이면 null.
 */
export function matchLabelKey(label: string): SourceKey | null {
  const key = matchLabelKeyInner(label);
  // 제3자(방문·심사·통역 대상·현지 업체·공장·행사 주최사) 라벨은 고객 회사명/주소/담당자가 아니다 → 매핑하지 않음(요구사항 원문에 남는다)
  if (key && THIRD_PARTY_KEYS.has(key) && THIRD_PARTY_LABEL.test(normalizeLabel(label))) return null;
  return key;
}

const THIRD_PARTY_LABEL = /방문|심사|대상|현지|공장|주최|참석|상대|협력|파트너|host|organizer|factory|supplier/;
const THIRD_PARTY_KEYS = new Set<SourceKey>(["companyName", "address", "department", "contactName", "contactPosition"]);

/** 고객 회사명을 명확히 뜻하는 라벨(1순위). "업체명/업체" 는 제3자 업체에도 쓰이므로 약한 라벨로 본다. */
const STRONG_COMPANY_LABELS = new Set(["회사명", "회사", "고객사", "고객사명", "기관명", "기관", "거래처", "거래처명", "의뢰회사", "신청회사", "company", "companyname"].map(normalizeLabel));
export function isStrongCompanyLabel(label: string): boolean {
  return STRONG_COMPANY_LABELS.has(normalizeLabel(label));
}

/** 표 행 라벨이 사전 라벨과 "정확히" 같은지(접두 "회사/개인/담당자" 허용: "회사 E-mail", "개인 E-mail"). */
function isExactLabel(n: string): boolean {
  if (!n) return false;
  const cands = [n, n.replace(/날짜|일자/g, "일"), n.replace(/^(?:회사|개인|담당자|업무용?|사무실)/, "")];
  return cands.some(c => c && DICT_MAP.has(c));
}

function matchLabelKeyInner(label: string): SourceKey | null {
  const n = normalizeLabel(label);
  if (!n) return null;
  // 내부(당사) 담당자 라벨은 고객담당자가 아니다 — "담당PM", "당사 담당자", "내부 담당" 등은 매핑하지 않는다.
  if (/pm|당사|내부|베리타스|veritas/.test(n)) return null;
  const exact = DICT_MAP.get(n);
  if (exact) return exact;
  for (const s of SYNONYMS) {
    if (n.includes(s.norm)) return s.key;
  }
  // "희망날짜"·"희망일자" 는 "희망일"과 같은 뜻 — 실제 의뢰서 라벨 「견적서 수령 희망날짜」 대응
  const alt = n.replace(/날짜|일자/g, "일");
  if (alt !== n) return matchLabelKeyInner(alt);
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

/**
 * 값 자체가 라벨/기본 안내문구(placeholder)인지 판정. 예: 언어 칸 값이 "언어"·"도착언어"·"선택" 인 경우.
 * 양식의 빈 칸 안내문구나 vision 이 라벨을 값으로 옮긴 경우가 분석 결과로 저장되는 것을 막는다.
 */
export function isPlaceholderValue(value: string): boolean {
  // normalizeLabel 은 앞 숫자/기호(글머리)를 지우므로 전화번호·날짜가 빈 값이 된다 → 공백/꼬리 기호만 제거해 비교.
  // 드롭다운 기호(▼ ⌵ ﹀ 등 OCR마다 다름)·화살표는 placeholder 표시이므로 문자/숫자 외 기호를 모두 지우고 비교.
  // 한글 뒤에 붙은 "v"(▼ 를 v 로 읽은 경우)도 제거.
  const n = String(value ?? "").replace(/([가-힣])\s*[vV]\s*$/, "$1").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  if (!n) return true;
  if (DICT_MAP.has(n)) return true;
  return /^(?:선택|선택하세요|입력|입력하세요|미입력|해당없음|없음|언어선택|출발언어선택|도착언어선택|언어도착언어|출발언어도착언어|언어언어)$/.test(n);
}

/**
 * 필드별 값 정리. 양식의 입력 예시(placeholder)가 실제 값에 섞이지 않게 한다.
 *  · 단일 값 필드 / 주제·일정: 예시 문구 제거("문화 ex) 의학,법률" → "문화")
 *  · 요구사항: 원문 보존이 원칙 — "ex) …" / "예시) …" 꼬리만 제거(본문의 "예: …" 같은 실제 문장은 유지)
 */
function cleanFieldValue(key: SourceKey, raw: string): string {
  if (key === "languages") return cleanLanguageCell(raw);
  if (key === "requirements") return raw.replace(/(?:^|[\s,(])(?:ex|예시)\s*\)[^\n]*/gi, " ").replace(/[ \t]{2,}/g, " ").trim();
  if (key === "subject" || key === "schedule") return raw.split("\n").map(stripHelperText).filter(Boolean).join("\n");
  return stripHelperText(raw);
}

/**
 * 언어 칸 정리 — 홈페이지 양식은 드롭다운 값과 안내문이 한 줄로 섞여 전사된다:
 *   "한국어 1. 출발언어 → 도착언어 ex)한국어 → 영어 말레이시아어 2. 출발언어 → 도착언어"
 *   "일본어 -> 한국어 ex) 출발언어 → 도착언어 한국어 -> 일본어 ex) 출발언어 → 도착언어" — 'ex)' 뒤 안내문·예시 조합은 끝까지 예시(값 아님)
 * 안내문("N. 출발언어 → 도착언어")과 예시 조합("ex)한국어 → 영어")만 지우고, 남은 것이 언어명뿐이면
 * 순서대로 "출발 → 도착" 조합으로 묶는다(값이 안내문 사이에 끼어 있어 줄 끝까지 지우는 일반 예시 제거를 쓰지 않는다).
 */
export function cleanLanguageCell(raw: string): string {
  const src = String(raw ?? "");
  const LANG = "[가-힣]{1,10}어";
  let v = src
    // "ex) 출발언어 → 도착언어 …" — 입력란 뒤 안내문(예시 조합 포함)은 칸 끝까지 예시다(역방향 조합을 추가 언어로 만들지 않음)
    .replace(/(?:ex|예시|예)\s*[)\]:：.]\s*출발\s*언어\s*(?:→|->|>|~)\s*도착\s*언어[\s\S]*$/i, " ")
    .replace(/\d+\s*[.)]?\s*출발\s*언어\s*(?:→|->|>|~)?\s*도착\s*언어/g, " ")
    .replace(new RegExp(`(?:ex|예시|예)\\s*[)\\]:：.]\\s*${LANG}\\s*(?:→|->|>|↔)\\s*${LANG}`, "gi"), " ");
  const hinted = v !== src;
  v = stripHelperText(v).replace(/\s+/g, " ").trim();
  if (!hinted) return v;
  const tokens = v.match(new RegExp(LANG, "g")) ?? [];
  const rest = v.replace(new RegExp(LANG, "g"), "").replace(/[\s,]/g, "");
  if (!rest && tokens.length >= 2 && tokens.length % 2 === 0) {
    const pairs: string[] = [];
    for (let i = 0; i < tokens.length; i += 2) pairs.push(`${tokens[i]} → ${tokens[i + 1]}`);
    return pairs.join(", ");
  }
  return v;
}

/** 값 형식 검사 — 이메일 칸에 "주소 등록" 같은 화면 문구, 전화 칸에 숫자 없는 값이 들어오지 않게 한다. */
function isValidFieldValue(key: SourceKey, v: string): boolean {
  if (key === "contactEmail") return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(v);
  if (key === "contactPhone" || key === "contactMobile") return (v.match(/\d/g) ?? []).length >= 7;
  return true;
}

// ─── Stage 1: 결정론적 라벨-값 추출 ──────────────────────────────────────────

interface LabelMatch { key: SourceKey; sourceLabel: string; value: string; }

/** 표 행 전사문의 한 칸 공백 라벨로 인정하지 않는 일반 단어(문장 첫 단어와 혼동). */
const LOOSE_LABEL_DENY = new Set(["시간", "날짜", "기타", "메모", "회사", "업체", "팀", "담당", "이름", "일정", "기간", "서비스", "채널", "출발", "도착", "분야", "주제",
  "메일", "전화", "소속", "기관", "지역", "사무실", "유선", "모바일", "용도", "수량", "페이지", "비고", "name", "date", "title", "contact", "company",
  "mail", "phone", "tel", "source", "target", "note", "notes", "hp", "cell", "mobile", "email", "language", "place", "location", "venue", "subject", "topic"]);

/**
 * 표 행 전사문("회사명 한국뷰로베리타스", "회사 E-mail a@b.com")처럼 라벨과 값이 한 칸 공백으로 붙은 줄.
 * 앞 단어들이 사전 라벨과 정확히 같을 때만 인정(가장 긴 라벨 우선). 양식 문서(formMode)에서만 호출한다.
 */
function matchLooseLabelLine(trimmed: string): LabelMatch | null {
  const words = trimmed.split(/\s+/);
  for (let k = Math.min(6, words.length - 1); k >= 1; k--) {
    const label = words.slice(0, k).join(" ");
    const n = normalizeLabel(label);
    if (!isExactLabel(n) || LOOSE_LABEL_DENY.has(n)) continue;
    const key = matchLabelKey(label);
    if (!key) return null;   // 제3자 라벨 등 — 라벨이지만 매핑하지 않음
    return { key, sourceLabel: label, value: words.slice(k).join(" ").trim() };
  }
  return null;
}

/** 한 줄에서 "라벨 <구분자> 값"을 파싱. 구분자: : ： | tab, 없으면 2칸+공백(좌변이 사전에 있을 때만). */
function matchLabelLine(line: string, formMode = false): LabelMatch | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 1) 명시 구분자
  const sepMatch = trimmed.match(/^(.*?)\s*[:：|\t│]\s*(.*)$/);
  // 라벨은 짧다 — 콜론 앞이 긴 문장("…번역을 요청드립니다. 회사명")이면 라벨 줄로 보지 않는다
  if (sepMatch && normalizeLabel(sepMatch[1]).length > 24) return null;
  if (sepMatch) {
    const key = matchLabelKey(sepMatch[1]);
    if (key) return { key, sourceLabel: sepMatch[1].trim(), value: sepMatch[2].trim() };
    // 좌변이 사전에 없으면 라벨 줄이 아님(값 안의 콜론 등) → 매칭 실패
    return null;
  }

  // 2) 구분자 없이 2칸 이상 공백 — 좌변이 사전에 있을 때만 라벨로 인정
  const spaceMatch = trimmed.match(/^(.+?)\s{2,}(.+)$/);
  // 양식 문서에서는 좌변이 라벨과 정확히 같을 때만 — "통역할 언어 한국어  1. 출발언어…" 처럼 값 사이 두 칸 공백을 라벨 경계로 오인하지 않게
  if (spaceMatch && !(formMode && !isExactLabel(normalizeLabel(spaceMatch[1])))) {
    const key = matchLabelKey(spaceMatch[1]);
    if (key) return { key, sourceLabel: spaceMatch[1].trim(), value: spaceMatch[2].trim() };
  }
  // 3) 한 칸 공백 + 날짜 값("견적서 수령 희망날짜 2026-10-26") — 이미지 전사문의 표 행 형식.
  //    값이 날짜로 시작할 때만 인정한다(일반 문장을 라벨로 오인하지 않게).
  const dateMatch = trimmed.match(/^([^\d]{2,30}?)\s+((?:\d{4}\s*[.\-/년]\s*)?\d{1,2}\s*[.\-/월]\s*\d{1,2}.*)$/);
  if (dateMatch) {
    const key = matchLabelKey(dateMatch[1]);
    if (key && (DICT_MAP.has(normalizeLabel(dateMatch[1])) || DICT_MAP.has(normalizeLabel(dateMatch[1]).replace(/날짜|일자/g, "일")))) {
      return { key, sourceLabel: dateMatch[1].trim(), value: dateMatch[2].trim() };
    }
  }
  // 4) 양식 문서의 표 행 전사문 — 한 칸 공백 라벨("회사명 한국뷰로베리타스")
  if (formMode) return matchLooseLabelLine(trimmed);
  return null;
}

/** 표 행 형식 양식 문서인지 — 사전 라벨과 정확히 같은 라벨로 시작하는 줄이 서로 다른 항목 4개 이상. */
function isFormDocument(lines: string[]): boolean {
  const keys = new Set<SourceKey>();
  for (const l of lines) {
    const m = matchLooseLabelLine(l.trim());
    if (m && m.value) keys.add(m.key);
  }
  return keys.size >= 4;
}

/** 요구사항 칸 안의 하위 항목으로 볼 라벨 — 이미 값이 있거나, 제3자에게도 쓰이는 약한 라벨(업체명·주소). */
function isRequirementSubItem(m: LabelMatch, sf: SourceFields): boolean {
  if (sf[m.key]?.raw.trim()) return true;
  if (m.key === "companyName") return !isStrongCompanyLabel(m.sourceLabel);
  return m.key === "address";
}

/** "방문 업체: …", "행사 주최사 …" 처럼 제3자 라벨 줄인지 — 고객 정보로 매핑하지 않고 요구사항에 원문으로 남긴다. */
function isThirdPartyLabelLine(line: string, formMode: boolean): boolean {
  const t = line.trim();
  const sep = t.match(/^(.*?)\s*[:：|\t│]\s*(.+)$/);
  const labels = sep && normalizeLabel(sep[1]).length <= 24 ? [sep[1]] : [];
  if (formMode) { const w = t.split(/\s+/); for (let k = Math.min(6, w.length - 1); k >= 1; k--) labels.push(w.slice(0, k).join(" ")); }
  return labels.some(lb => {
    const n = normalizeLabel(lb);
    if (!THIRD_PARTY_LABEL.test(n) || n.length > 12) return false;
    const k = matchLabelKeyInner(lb);
    // 사전 키가 없어도 업체·기관을 뜻하는 라벨("행사 주최사", "방문처", "주최측")이면 제3자 정보
    return (!!k && THIRD_PARTY_KEYS.has(k)) || (n !== "심사" && /(?:업체명?|회사명?|주최사|협력사|파트너사|방문처|주최측|기관명?|공장명?)$/.test(n));
  });
}

/** 표에서 요구사항 칸 다음에 오는 행 라벨(사전 키는 없지만 요구사항 값의 끝을 알린다). */
const ROW_BOUNDARY = /^(?:통역|번역)?\s*자료\s*전송\s*정보|^첨부\s*파일/;

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
    // 앞서 모아 둔 제3자 업체 줄은 실제 요구사항 칸 값 뒤에 붙인다
    if (key === "requirements" && existing?.sourceLabel === "제3자 업체 정보") {
      const cleanedReq = cleanFieldValue(key, raw);
      if (cleanedReq) sourceFields.requirements = { raw: `${cleanedReq}\n${existing.raw}`, sourceLabel, origin: "document" };
      return;
    }
    if (existing && existing.raw.trim()) return;   // 첫 값 보존
    const cleaned = cleanFieldValue(key, raw);
    if (cleaned.trim() && isPlaceholderValue(cleaned)) return;   // "언어"/"도착언어" 같은 안내문구는 값이 아님
    // "Contact 02-6147-5039" — 담당자 라벨에 전화번호만 있으면 연락처로 읽는다(이름으로 넣지 않음)
    if (key === "contactName" && /^[\d\s()+.-]{7,}$/.test(cleaned.trim())) { put(/^01[016789]/.test(cleaned.replace(/\D/g, "")) ? "contactMobile" : "contactPhone", sourceLabel, cleaned); return; }
    if (cleaned.trim() && !isValidFieldValue(key, cleaned)) return;   // 이메일 칸의 "주소 등록" 등 형식이 맞지 않는 값
    sourceFields[key] = { raw: cleaned, sourceLabel, origin: "document" };
  };

  // 표 행 전사문(한 칸 공백 라벨) 양식이면 그 형식의 라벨 줄도 인식한다
  const formMode = isFormDocument(lines);
  const appendRequirement = (line: string) => {
    const f = sourceFields.requirements;
    const add = cleanFieldValue("requirements", line.trim());
    if (f && add) f.raw = f.raw ? `${f.raw}\n${add}` : add;
  };

  // 라벨만 있는 줄(값이 아래 줄에 있는 표/양식) — 다음 줄을 그 라벨의 값으로 본다
  let pendingLabel: { key: SourceKey; label: string } | null = null;
  for (const line of lines) {
    if (formMode && ROW_BOUNDARY.test(line.trim())) { current = null; pendingLabel = null; continue; }
    const m = matchLabelLine(line, formMode);
    // 요구사항 칸 안의 "업체명 : …", "일정 및 시간 : …" 은 방문·심사 대상 등 의뢰 내용이다 — 고객 정보로 쓰지 않고 요구사항에 남긴다
    if (m && current === "requirements" && sourceFields.requirements && isRequirementSubItem(m, sourceFields)) {
      appendRequirement(line);
      continue;
    }
    if (!m && isThirdPartyLabelLine(line, formMode)) {
      if (sourceFields.requirements?.raw.trim()) appendRequirement(line);
      else sourceFields.requirements = { raw: line.trim(), sourceLabel: "제3자 업체 정보", origin: "document" };
      if (current !== "requirements") current = null;
      pendingLabel = null;
      continue;
    }
    if (m) {
      put(m.key, m.sourceLabel, m.value);
      current = m.key;
      pendingLabel = m.value.trim() ? null : { key: m.key, label: m.sourceLabel };
      continue;
    }
    const lineNorm = normalizeLabel(line);
    const labelOnly = lineNorm && (formMode ? isExactLabel(lineNorm) : (DICT_MAP.has(lineNorm) || DICT_MAP.has(lineNorm.replace(/날짜|일자/g, "일")))) ? matchLabelKey(line) : null;
    if (labelOnly) { pendingLabel = { key: labelOnly, label: line.trim() }; current = labelOnly; continue; }
    // 양식의 빈 칸 라벨("개인 E-mail", "팩스번호")은 다음 줄을 끌어오지 않는다
    if (formMode && lineNorm && isExactLabel(lineNorm)) { pendingLabel = null; current = null; continue; }
    if (pendingLabel && line.trim()) {
      const pl = pendingLabel; pendingLabel = null;
      if (!sourceFields[pl.key]?.raw.trim()) { put(pl.key, pl.label, line.trim()); continue; }
    }
    // 빈 줄은 여러 줄 값(주제/일정/요구사항)의 끝 — 이메일 맺음말·서명("감사합니다", "T. 031-…")이 값에 섞이지 않게 한다.
    // 단, 양식 문서의 요구사항 칸은 문단 사이 빈 줄이 있어도 다음 행 라벨까지 한 칸이다.
    if (!line.trim()) { if (!(formMode && current === "requirements")) current = null; continue; }
    // 번호 항목("7. 현장에서는 …", "** 7. 통역자료")은 새 항목 — 주제·일정 값에 이어 붙이지 않는다(요구사항 칸은 원문 보존)
    if (current && current !== "requirements" && /^\s*(?:\*+\s*)?(?:\d{1,2}|[①-⑳])\s*[.)]\s*\S/.test(line)) { current = null; continue; }
    // 라벨 줄이 아님 → 직전 필드가 멀티라인 대상이면 이어붙인다.
    if (current && MULTILINE_KEYS.has(current) && line.trim()) {
      const f = sourceFields[current];
      const add = cleanFieldValue(current, line.trim());
      if (f && add) f.raw = f.raw ? `${f.raw}\n${add}` : add;
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
    const raw = cleanFieldValue(key, rawIn).trim();
    if (!raw || isPlaceholderValue(raw) || !isValidFieldValue(key, raw)) continue;
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

/** 원문에 적힌 언어 조합 한 쌍. context = 그 조합이 나온 원문 줄(근거). */
export interface LanguagePair { from: string; to: string; context: string; }

/**
 * 텍스트에서 "한국어 → 영어" 형태의 언어 조합을 모두 찾는다(등장 순서, 중복 제거).
 * 언어명은 "~어"로 끝나는 한글 표기만 인정한다(국가명·장소와 혼동 방지). 방향 기호 없는 나열은 조합으로 보지 않는다.
 */
export function detectLanguagePairs(text: string): LanguagePair[] {
  const out: LanguagePair[] = [];
  const seen = new Set<string>();
  // "한국어-말레이시아어" 처럼 하이픈으로 이은 표기도 조합으로 본다(언어명 사이에서만)
  const re = /([가-힣]{1,10}어)\s*(?:→|->|=>|⇒|↔|⇄|>|에서|[-–](?=\s*[가-힣]{1,10}어))\s*([가-힣]{1,10}어)/g;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    // 양식의 입력 예시("ex)한국어 → 영어 한국어 → 스페인어")는 실제 요청 언어가 아니다 — 예시를 지우고 찾는다
    for (const m of stripHelperText(line).matchAll(re)) {
      const from = m[1], to = m[2].replace(/(?:으로|로)$/, "");
      if (from === to || isPlaceholderValue(from) || isPlaceholderValue(to)) continue;
      const k = `${from}|${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ from, to, context: line.trim().slice(0, 200) });
    }
  }
  return out;
}

/**
 * 양식의 "출발언어 / 도착언어" 행이 여러 번 나오는 경우(복수 언어 조합)를 순서대로 짝지어 모두 반환한다.
 * 값이 placeholder("언어", "도착언어")인 행은 버린다. 값 안의 "(필수 아님)" 같은 단서는 context 로 남긴다.
 */
export function extractLanguageRowPairs(text: string): LanguagePair[] {
  const out: LanguagePair[] = [];
  const seen = new Set<string>();
  const langOf = (v: string) => {
    const l = v.match(/[가-힣]{1,10}어/)?.[0] ?? (/^[A-Za-z][A-Za-z\s]{1,20}$/.test(v.trim()) ? v.trim() : "");
    return l && !isPlaceholderValue(l) ? l : "";
  };
  let pendingFrom: { lang: string; line: string } | null = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = matchLabelLine(line);
    if (!m) continue;
    const v = stripHelperText(m.value);
    if (m.key === "languageFrom") {
      pendingFrom = v && !isPlaceholderValue(v) && langOf(v) ? { lang: langOf(v), line: line.trim() } : null;
    } else if (m.key === "languageTo") {
      const to = v && !isPlaceholderValue(v) ? langOf(v) : "";
      if (pendingFrom && to && pendingFrom.lang !== to) {
        const k = `${pendingFrom.lang}|${to}`;
        if (!seen.has(k)) { seen.add(k); out.push({ from: pendingFrom.lang, to, context: `${pendingFrom.line} / ${line.trim()}`.slice(0, 200) }); }
      }
      pendingFrom = null;
    }
  }
  return out;
}

/** 대표(공용) 메일함 로컬파트 — 담당자 개인 이메일과 구분 */
const GENERIC_MAILBOX = /^(?:info|admin|administrator|master|webmaster|contact|help|helpdesk|support|office|sales|service|cs|mail|hello|team|biz|business|no-?reply|donotreply|kr|korea|museum|press|pr|marketing)$/i;
export function isGenericMailbox(email: string): boolean { return GENERIC_MAILBOX.test((email.split("@")[0] ?? "").trim()); }

export interface ContactFallback {
  emails: Array<{ email: string; line: string; generic: boolean; sender: boolean; recipient: boolean }>;
  phone?: { value: string; line: string };
  mobile?: { value: string; line: string };
}

/**
 * 라벨-값 형식이 아닌 곳(보낸사람 헤더, 서명 "T. / M. / E.", 라벨 뒤 단일 공백)에서 이메일·전화를 찾는다.
 * 원문에 있는 값만 그대로 꺼낸다(생성 없음). 받는사람/참조 줄의 주소와 팩스 번호는 고객 연락처로 보지 않는다.
 */
export function scanContactFallback(text: string): ContactFallback {
  const out: ContactFallback = { emails: [] };
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
  const PHONE = /(?<!\d)(0\d{1,2})[\s.)-]*(\d{3,4})[\s.-]*(\d{4})(?!\d)/g;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const recipient = /^(?:받는\s*사람|수신(?:자)?|참조|숨은\s*참조|to|cc|bcc)\s*[:：]/i.test(line);
    const sender = /^(?:보낸\s*사람|발신(?:자)?|from)\s*[:：]/i.test(line);
    for (const m of line.matchAll(EMAIL)) {
      const email = m[0].replace(/\.+$/, "");
      if (!out.emails.some(e => e.email.toLowerCase() === email.toLowerCase())) {
        out.emails.push({ email, line: line.slice(0, 200), generic: isGenericMailbox(email), sender, recipient });
      }
    }
    if (recipient) continue;
    // 줄 안의 여러 항목("T. 031-… / M. 010-… / F. 031-…")을 구분해 각각 판정
    for (const seg of line.split(/\s+[\/|│·]\s+|\s{2,}|\t/)) {
      for (const m of seg.matchAll(PHONE)) {
        const before = seg.slice(0, m.index).toLowerCase();
        if (/(?:fax|팩스|f\s*[.:)]?\s*)$/.test(before.trim()) || /fax|팩스/.test(before)) continue;
        const value = `${m[1]}-${m[2]}-${m[3]}`;
        const mobile = /^01[016789]$/.test(m[1]) || /(?:^|[^a-z])(?:m|mobile|hp|h\.p|cell|c)\s*[.:)]?\s*$/.test(before.trim()) || /휴대|핸드폰|모바일/.test(before);
        if (mobile) { if (!out.mobile) out.mobile = { value, line: line.slice(0, 200) }; }
        else if (!out.phone) out.phone = { value, line: line.slice(0, 200) };
      }
    }
  }
  return out;
}

// 담당자 값 검증용 — 지역/행정구역 명칭(대표 도시·도). 담당자 칸에 주소·지역이 들어오는 오류 차단.
const REGION_NAMES = new Set([
  "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주",
  "수원", "성남", "고양", "용인", "부천", "안산", "안양", "남양주", "화성", "평택", "의정부", "시흥", "파주", "김포", "광명", "군포", "하남", "오산", "이천",
  "청주", "천안", "전주", "포항", "창원", "김해", "구미", "진주", "원주", "춘천", "강릉", "목포", "여수", "순천", "익산", "군산", "경주", "거제", "양산",
]);

/**
 * 고객담당자 값이 사람 이름으로 볼 수 있는지 검사. 문제가 있으면 사유 문자열, 정상이면 null.
 * 지역명·주소 조각, 회사명/부서/장소의 일부, 내부 직원(PM) 이름은 고객담당자로 쓰지 않는다.
 */
export function contactNameIssue(name: string, ctx: { address?: string; company?: string; department?: string; place?: string; internalNames?: string[] }): string | null {
  const n = (name || "").replace(/\s+/g, "");
  if (!n) return null;
  const core = n.replace(/(?:님|씨|과장|차장|부장|대리|주임|팀장|실장|주무관|사무관|선생님|교수|대표|매니저)$/, "");
  if (REGION_NAMES.has(core) || (/[시군구도]$/.test(core) && REGION_NAMES.has(core.slice(0, -1))) || /특별시|광역시|특별자치/.test(core)) return "지역명";
  for (const [label, v] of [["주소", ctx.address], ["회사명", ctx.company], ["부서", ctx.department], ["장소", ctx.place]] as const) {
    const sv = (v || "").replace(/\s+/g, "");
    if (sv && core.length >= 2 && sv.includes(core) && sv !== core) return `${label}의 일부`;
  }
  if ((ctx.internalNames ?? []).some(x => x && x.replace(/\s+/g, "") === core)) return "내부 담당자(PM) 이름";
  if (!/^[가-힣]{2,5}$/.test(core) && !/^[A-Za-z][A-Za-z .'-]{1,40}$/.test(core)) return "사람 이름 형식 아님";
  return null;
}

/**
 * 서비스 유형 판정용 텍스트 — 양식의 라벨 문구("번역 분량", "통역의 형태")와 입력 예시를 제거하고
 * 실제로 적힌 값·문장만 남긴다(빈 번역 섹션이 있는 양식을 번역 의뢰로 오인하지 않게).
 */
export function serviceEvidenceText(text: string): string {
  return String(text ?? "").split(/\r?\n/).map(line => {
    const m = matchLabelLine(line);
    const body = m ? (isPlaceholderValue(stripHelperText(m.value)) ? "" : stripHelperText(m.value)) : stripHelperText(line);
    return body;
  }).filter(Boolean).join("\n");
}

/** "1일 6시간", "하루 6시간", "총 6시간" → "6시간". 그 외 표현(예: "오전 3시간, 오후 3시간")은 원문 유지. */
export function normalizeDuration(raw: string): string {
  const s = (raw || "").trim();
  const m = s.match(/^(?:1\s*일|하루|일|총|1\s*일\s*총)?\s*(\d+(?:\.\d+)?)\s*시간(?:\s*(?:내외|정도|가량))?$/);
  return m ? `${m[1]}시간` : s;
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
  return matchDocumentTypes(raw)[0] ?? "";
}

/** 원문 형식 표기를 항목별로 나눠 고정 항목으로 맞추고, 맞지 않는 표기("출력물", "책")는 따로 돌려준다(입력 예시 제외). */
export function splitDocumentTypes(raw: string): { types: string[]; unmatched: string[] } {
  const types: string[] = [], unmatched: string[] = [];
  for (const tok of stripHelperText(raw || "").split(/[,，、/·|+&]|\s(?:및|와|과|or|and)\s/i).map(t => t.trim()).filter(Boolean)) {
    const hit = DOCUMENT_TYPE_ALIASES.find(a => a.re.test(tok));
    if (hit) { if (!types.includes(hit.type)) types.push(hit.type); }
    else unmatched.push(tok);
  }
  return { types, unmatched };
}

// 원문 표기 → 고정 항목. "MS Word"·"doc(x)"→Word, "hwp"·"한글"→HWP, "xls(x)"→Excel, "ppt(x)"·"PowerPoint"→PPT 등.
const DOCUMENT_TYPE_ALIASES: Array<{ type: (typeof DOCUMENT_TYPES)[number]; re: RegExp }> = [
  { type: "Word", re: /word|\bdocx?\b|워드/i },
  { type: "HWP", re: /hwpx?\b|한글|한컴/i },
  { type: "PDF", re: /pdf/i },
  { type: "Excel", re: /excel|\bxlsx?\b|엑셀/i },
  { type: "PPT", re: /powerpoint|\bpptx?\b|파워\s*포인트/i },
  { type: "이미지", re: /이미지|\bjpe?g\b|\bpng\b|스캔|사진/i },
];
/** 원문 문서형태의 모든 항목(원문 순서). 입력 예시("ex) ms word, pdf …")는 제외한다. */
export function matchDocumentTypes(raw: string): string[] {
  const s = stripHelperText(raw || "");
  return DOCUMENT_TYPE_ALIASES
    .map(a => ({ type: a.type, at: s.search(a.re) }))
    .filter(x => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(x => x.type);
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

/** 날짜 표현에 연도가 직접 적혀 있는지("2026-10-28", "2026년 10월 28일") */
export function hasExplicitYear(raw: string): boolean {
  return /\d{4}\s*[.\-/년]\s*\d{1,2}/.test(raw || "");
}

/**
 * 연도가 빠진 날짜("10월 28일(수)까지")의 연도를 문서 근거로 정한다(현재 연도로 단정하지 않음).
 *  · explicit: 날짜에 연도가 적혀 있음
 *  · document: 문서 안의 기준일(접수·수신·발송 일시) 또는 연도가 적힌 다른 날짜에서 연도를 가져옴.
 *              기준일보다 한참 이전이면(12월 문서의 "1월 5일") 다음 해로 본다.
 *  · uncertain: 근거가 없어 확정할 수 없음 → 확인 필요
 */
export function resolveDateYear(raw: string, ctx: { refDate?: string; docText?: string }): { date: string | null; yearBasis: "explicit" | "document" | "uncertain" } {
  const d = parseDate(raw);
  if (!d) return { date: null, yearBasis: "uncertain" };
  if (hasExplicitYear(raw)) return { date: d, yearBasis: "explicit" };
  const md = d.slice(5);
  let year: number | null = null;
  if (ctx.refDate) {
    year = +ctx.refDate.slice(0, 4);
    if (`${year}-${md}` < ctx.refDate.slice(0, 10) && Date.parse(ctx.refDate.slice(0, 10)) - Date.parse(`${year}-${md}`) > 30 * 864e5) year += 1;
  } else {
    const years = [...String(ctx.docText ?? "").matchAll(/(\d{4})\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}/g)].map(m => +m[1]).filter(y => y >= 2000 && y <= 2100);
    if (years.length && years.every(y => y === years[0])) year = years[0];
  }
  return year ? { date: `${year}-${md}`, yearBasis: "document" } : { date: null, yearBasis: "uncertain" };
}

/** 문자열에서 첫 시각을 HH:mm 로 파싱. 실패 시 null. */
export function parseTime(raw: string): string | null {
  const s = (raw || "").trim();
  // 오전/오후 h시 m분
  let m = s.match(/(오전|오후)?\s*(\d{1,2})\s*시(?!간)\s*(?:(\d{1,2})\s*분|반)?/);
  if (m && +m[2] <= 24) {
    let h = +m[2];
    if (m[1] === "오후" && h < 12) h += 12;
    if (m[1] === "오전" && h === 12) h = 0;
    return `${pad2(h)}:${pad2(m[3] ? +m[3] : (/시\s*반/.test(m[0]) ? 30 : 0))}`;
  }
  // [오전|오후|AM|PM] HH:mm — "오후 2:13" 은 14:13
  m = s.match(/(오전|오후|am|pm|a\.m\.|p\.m\.)?\s*(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
  if (m) {
    let h = +m[2];
    const mer = (m[1] ?? m[4] ?? "").toLowerCase();
    if ((mer === "오후" || mer.startsWith("p")) && h < 12) h += 12;
    if ((mer === "오전" || mer.startsWith("a")) && h === 12) h = 0;
    return `${pad2(h)}:${m[3]}`;
  }
  return null;
}

/**
 * 일정 텍스트(단일/범위)를 시작/종료로 파싱. 실패 필드는 "".
 * 원문에 시각이 있으면 "YYYY-MM-DDTHH:mm", 날짜만 있으면 "YYYY-MM-DD"(시간 미정) — 시각을 추정하지 않는다.
 * 단일 날짜는 종료일 = 시작일(날짜만). 종료 시각은 원문에 있을 때만 채운다.
 */
/**
 * 시간대 표현 → 시작·종료 시각. "오후 1시30분-오후4시 정도" → { start:"13:30", end:"16:00", endApprox:true }.
 * 종료 쪽에 오전/오후가 없으면 시작 쪽 오후를 이어받는다("오후 2시~4시"). "정도/경/쯤/가량/예정" 은 예상 시각으로 표시.
 */
export function parseTimeRange(raw: string): { start: string | null; end: string | null; endApprox: boolean } {
  const s = String(raw ?? "").trim();
  const parts = s.split(/\s*(?:~|∼|–|—|-|부터|에서)\s*/).filter(Boolean);
  const start = parts[0] ? parseTime(parts[0]) : null;
  let end: string | null = null;
  let endApprox = false;
  if (parts.length >= 2) {
    const tail = parts.slice(1).join(" ");
    const pm = /오후/.test(parts[0]) && !/오전|오후/.test(tail);
    end = parseTime(pm ? `오후 ${tail}` : tail);
    endApprox = /정도|경|쯤|가량|예정|내외/.test(tail);
  }
  return { start, end, endApprox };
}

/** 언어명 토큰(원문에 적힌 "~어" 표기). 일반 단어(언어·단어·용어)와 안내문구는 제외. */
export function languageTokens(raw: string): string[] {
  const out: string[] = [];
  for (const m of String(raw ?? "").matchAll(/[가-힣]{1,8}어/g)) {
    const t = m[0];
    if (/^(?:언어|단어|용어|출발언어|도착언어|원본언어|목표언어|외국어)$/.test(t) || isPlaceholderValue(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function parseSchedule(raw: string): { from: string; to: string; parsed: boolean } {
  // "9/14-16"(월/일-일, 연도 없음) — 하이픈이 날짜 안 구분자가 아니라 기간 구분자다 → "9/14 ~ 16"
  const s = (raw || "").trim().replace(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*-\s*(\d{1,2})$/, (m, mo, d1, d2) => +d2 > +d1 ? `${mo}/${d1} ~ ${d2}` : m);
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
    const t = parseTime(part);
    return t ? `${d}T${t}` : d;
  };

  if (rangeParts.length >= 2) {
    const from = build(rangeParts[0]);
    // 종료 파트가 "일"만 있으면(예: "9월 1일 ~ 3일", "9/1~3") 시작의 연·월에 그 일자를 붙인다.
    // 날짜 정보가 전혀 없으면(예: "10:00 ~ 16:00") 시작 날짜를 그대로 쓴다.
    let toDate = parseDate(rangeParts[1]);
    const dayOnly = rangeParts[1].match(/^(\d{1,2})\s*일?(?![\d:시])/);
    if (!toDate && dayOnly && from && +dayOnly[1] >= 1 && +dayOnly[1] <= 31) toDate = `${from.slice(0, 8)}${pad2(+dayOnly[1])}`;
    const to = build(rangeParts[1], toDate ?? (from ? from.slice(0, 10) : undefined));
    return { from, to, parsed: !!(from || to) };
  }
  const from = build(s);
  return { from, to: from ? from.slice(0, 10) : "", parsed: !!from };
}

// ─── 접수경로 판정 ─────────────────────────────────────────────────────────────
export type ChannelGuess = { channel: "" | "email" | "homepage" | "phone" | "kakao"; evidence: string; certain: boolean };
const EMAIL_HEADER = /^\s*(?:보낸\s*사람|받는\s*사람|from|to|subject|제목|참조|cc|보낸\s*날짜|받은\s*날짜|sent|date)\s*[:：]/i;
/**
 * 고객이 의뢰를 전달한 방식을 원문 근거로 판정한다. 근거가 없으면 channel="" (미선택·확인 필요).
 *  · 홈페이지: 홈페이지/온라인 문의 양식 알림 문구(메일로 왔어도 양식 접수면 홈페이지)
 *  · 이메일: 메일 헤더(보낸사람/받는사람/From/Subject…)·전달 메일 표시, 또는 본문만 있어도 이메일 형식이 명확하면 확정
 *            (제목 + 인사/자기소개/맺음말, 수신자 지칭 인사 + 발신자 자기소개, 이메일 주소 + 인사 + 맺음말)
 *  · 그 외 출처 불명확 → channel="" (확인 필요)
 *  · 전화: "전화 상담/통화 내용/유선 문의" 같은 상담 기록 표현(전화번호가 있다는 것만으로는 아님)
 *  · 카카오: 카카오톡 문의/상담 표현
 * 붙여넣은 텍스트라는 사실만으로는 이메일로 보지 않는다.
 */
export function detectChannel(text: string): ChannelGuess {
  const t = String(text ?? "");
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const find = (re: RegExp) => lines.find(l => re.test(l));
  const hp = find(/홈페이지\s*(?:문의|견적|접수|상담)|온라인\s*(?:문의|견적|상담)\s*(?:양식|접수|신청)?|문의\s*양식|견적\s*문의\s*양식|웹사이트\s*(?:문의|견적)|website\s*inquiry|\[\s*홈페이지/i);
  if (hp) return { channel: "homepage", evidence: hp.slice(0, 120), certain: true };
  const header = lines.filter(l => EMAIL_HEADER.test(l));
  // 메일앱 화면 캡처 전사문은 "보낸 사람 홍길동 <a@b.com>" 처럼 콜론 없이 적힌다(주소가 함께 있을 때만 인정)
  const headerWithAddr = header.find(l => /@/.test(l) || /^(?:보낸\s*사람|from)\s*[:：]/i.test(l)) ?? find(/^(?:보낸\s*사람|받는\s*사람)\s+.*@/);
  if (headerWithAddr) return { channel: "email", evidence: headerWithAddr.slice(0, 120), certain: true };
  const fwd = find(/-{2,}\s*original message|전달된\s*메시지|forwarded message|원본\s*메시지/i);
  if (fwd) return { channel: "email", evidence: fwd.slice(0, 120), certain: true };
  const kakao = find(/카카오톡\s*(?:문의|상담|채널|으로)|카톡\s*(?:문의|상담|으로)|kakaotalk/i);
  if (kakao) return { channel: "kakao", evidence: kakao.slice(0, 120), certain: true };
  const phone = find(/전화\s*(?:상담|문의\s*내용|통화|접수)|통화\s*(?:내용|메모|기록)|유선\s*(?:상담|문의|접수)|전화로\s*(?:문의|요청|접수|상담)/);
  if (phone) return { channel: "phone", evidence: phone.slice(0, 120), certain: true };
  // 이메일 형식(헤더 주소 없이 본문만 캡처된 경우) — 제목·인사말·발신자/수신자 관계가 명확하면 이메일로 확정
  const head = lines.slice(0, 6);
  const subject = find(/^(?:제목|subject)\s*[:：]\s*\S|^(?:re|fw|fwd|회신|전달)\s*[:：]/i);
  const addr = find(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/);
  const greet = find(/^(?:안녕하세요|안녕하십니까|수고\s*많으십니다|dear\b|hello\b)/i);
  const close = find(/감사합니다|드림$|올림$|best regards|sincerely|kind regards/i);
  // 수신자 지칭 인사("월드엑스포탈 구예나 이사님 안녕하세요?", "Dear Mr. Kim") · 발신자 자기소개("베리타스 이상우입니다.")
  const toGreet = head.find(l => /님\s*[,，]?\s*(?:안녕하세요|안녕하십니까|수고\s*많으십니다|반갑습니다)|^dear\s+\S/i.test(l));
  const fromIntro = head.find(l => l.length <= 40 && !/[:：]/.test(l) && /^[가-힣A-Za-z0-9()&.\s]{2,}(?:입니다|이라고\s*합니다)\s*[.!]?$/.test(l));
  if (subject && (greet || toGreet || fromIntro || close)) return { channel: "email", evidence: subject.slice(0, 120), certain: true };
  if (toGreet && fromIntro) return { channel: "email", evidence: `${toGreet.slice(0, 50)} / ${fromIntro.slice(0, 50)}`, certain: true };
  if (addr && greet && close) return { channel: "email", evidence: `${greet.slice(0, 40)} … ${addr.slice(0, 60)}`, certain: true };
  return { channel: "", evidence: "", certain: false };
}

/**
 * 메일 헤더의 일시. received = 수신일시가 명시된 경우만(받은 날짜/수신일시/Received),
 * sent = 발송일시(보낸 날짜/Date/Sent, 또는 헤더 블록의 라벨 없는 일시 — 메일앱 표시 일시는 발송 기준).
 * 값은 KST 벽시계 "YYYY-MM-DDTHH:mm". 시각이 없는 날짜는 쓰지 않는다(일시가 아님).
 */
export function extractEmailDates(text: string): { received?: { value: string; line: string }; sent?: { value: string; line: string } } {
  const out: { received?: { value: string; line: string }; sent?: { value: string; line: string } } = {};
  const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim());
  // 라벨("보낸 날짜:")이 있으면 라벨을 떼고 시각을 읽는다(라벨 없는 줄은 "2:13"의 콜론을 라벨로 오인하지 않게 그대로)
  const dt = (l: string) => {
    const body = /^[가-힣A-Za-z\s]{1,12}[:：]\s*/.test(l) ? l.replace(/^[가-힣A-Za-z\s]{1,12}[:：]\s*/, "") : l;
    const d = parseDate(body); const t = parseTime(body); return d && t ? `${d}T${t}` : null;
  };
  let headerZone = 0;
  let sinceHeader = 0;   // 마지막 헤더 줄 이후의 비헤더 줄 수 — 헤더 블록이 끝났는지 판단(캡처 전사문은 헤더 사이에 빈 줄이 있다)
  for (const l of lines.slice(0, 40)) {
    if (!l) continue;
    // 메일앱 화면 캡처 전사문은 "보낸 사람 홍길동 <a@b.com>" 처럼 콜론 없이 적힌다
    const isHeader = EMAIL_HEADER.test(l) || /^(?:보낸\s*사람|받는\s*사람)\s+\S/.test(l);
    if (isHeader) { headerZone++; sinceHeader = 0; }
    else if (headerZone > 0 && ++sinceHeader > 3) break;
    if (/^(?:받은\s*날짜|받은\s*시간|수신\s*일시|수신\s*시각|수신일|received)\s*[:：]/i.test(l)) { const v = dt(l); if (v && !out.received) out.received = { value: v, line: l.slice(0, 120) }; continue; }
    if (/^(?:보낸\s*날짜|보낸\s*시간|발송\s*일시|발신\s*일시|sent|date)\s*[:：]/i.test(l)) { const v = dt(l); if (v && !out.sent) out.sent = { value: v, line: l.slice(0, 120) }; continue; }
    // 헤더 블록 안의 라벨 없는 일시(예: Gmail "2026년 10월 20일 (화) 오후 2:13") — 발송 기준으로만 본다
    if (headerZone > 0 && !isHeader && !out.sent && /^\(?\d{4}\s*[년.\-/]/.test(l)) { const v = dt(l); if (v) out.sent = { value: v, line: l.slice(0, 120) }; }
  }
  return out;
}

/**
 * 고객 제출 일시(①) — 라벨("접수일시: …") 또는 "2026-10-20 14:13에 접수된 문의입니다" 같은 알림 문장.
 * 시각까지 있으면 value="YYYY-MM-DDTHH:mm", 날짜만 있으면 dateOnly 에만 담는다(시각을 만들지 않음).
 */
export function extractSubmittedAt(text: string, labeledRaw?: { raw: string; sourceLabel: string }): { value?: string; dateOnly?: string; line: string; raw: string; explicitYear: boolean } | null {
  const read = (body: string, line: string) => {
    const d = parseDate(body); if (!d) return null;
    const t = parseTime(body.replace(/^.*?\d{1,4}\s*[년.\-/]\s*\d{1,2}\s*[월.\-/]?\s*\d{0,2}\s*일?/, ""));
    const base = { line, raw: body.trim(), explicitYear: hasExplicitYear(body) };
    return t ? { ...base, value: `${d}T${t}` } : { ...base, dateOnly: d };
  };
  if (labeledRaw?.raw.trim()) {
    const r = read(labeledRaw.raw, `${labeledRaw.sourceLabel}: ${labeledRaw.raw}`.slice(0, 120));
    if (r) return r;
  }
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const m = l.match(/((?:\d{4}\s*[년.\-/]\s*)?\d{1,2}\s*[월.\-/]\s*\d{1,2}\s*일?[^\n]{0,24}?)\s*(?:에|에\s*)?\s*(?:접수|신청|제출|등록)(?:된|되었|됨|하신)/);
    if (m) { const r = read(m[1], l.trim().slice(0, 120)); if (r) return r; }
  }
  return null;
}

// ─── 복수 서비스 인식(자동 입력 제안 전용) ─────────────────────────────────────
//   원문에 나타난 서비스 키워드를 모두 찾는다. 회사명 등에 흔한 '통번역'은 서비스 근거로 보지 않고,
//   '통역장비'의 '통역'은 통역 서비스로 보지 않는다. 최종 선택·등록은 사용자가 한다.
/**
 * 번역을 "명시적으로 요청"했는지. '번역' 이라는 단어가 있다는 것만으로는 판정하지 않는다.
 *  · 인정: "번역 요청/의뢰/부탁/견적/필요", "번역해 주세요", "번역과 감수 부탁", "통역 및 번역 견적" 처럼
 *          '번역' 뒤 20자 안에 요청 표현이 있고 부정 표현이 없을 때
 *  · 불인정: "통역자료(번역문)는 추후 전달", "번역본은 필요 없습니다", "번역 불필요"
 */
export function hasTranslationRequest(text: string): boolean {
  for (const m of String(text ?? "").matchAll(/번역/g)) {
    const win = text.slice(m.index!, m.index! + 22).split(/[.,\n!?。]/)[0];
    if (/필요\s*(?:없|하지\s*않|치\s*않)|불필요|없습니다|없음|아님|아닙|제외|하지\s*않|안\s*해/.test(win)) continue;
    // 번역문·번역본·번역물 언급은 자료 설명 — 바로 뒤에 요청 표현이 붙은 경우("번역본 작성 요청")만 인정
    if (/^번역(?:문|본|물)/.test(win) && !/^번역(?:문|본|물)\s*(?:을|를)?\s*(?:작성\s*)?(?:요청|의뢰|부탁)/.test(win)) continue;
    if (/요청|의뢰|부탁|문의|견적|진행|필요|해\s*주|해주|드립니다|바랍니다|원합니다|희망/.test(win)) return true;
  }
  return false;
}

/**
 * 통역을 "실제로 요청"했는지 — 번역 의뢰서에 '통역'이 언급만 된 경우("통역 경험이 있는 번역가")와 구분한다.
 *  · 인정: 통역 형태 표기(동시·순차·위스퍼링·수행·회의 통역), '통역' 뒤 24자 안의 요청 표현(부정 제외)
 *  · 불인정: "통역 경험/경력/출신", "통역은 필요 없습니다", 통역장비, 회사명 '통번역'
 */
export function hasInterpretationRequest(text: string): boolean {
  const t = String(text ?? "").replace(/통\s*번역/g, " ");
  if (/(?:동시|순차|위스퍼링|수행|회의|비즈니스|전화|화상)\s*통역(?!\s*(?:장비|경험|경력|출신|이력))/.test(t)) return true;
  for (const m of t.matchAll(/통역(?!\s*장비)/g)) {
    const win = t.slice(m.index!, m.index! + 24).split(/[.,\n!?。]/)[0];
    if (/필요\s*(?:없|하지\s*않|치\s*않)|불필요|없습니다|없음|아님|아닙|제외|하지\s*않|안\s*해/.test(win)) continue;
    if (/^통역(?:사)?\s*(?:의\s*)?(?:경험|경력|출신|이력|자격)/.test(win)) continue;
    if (/요청|의뢰|부탁|문의|견적|진행|필요|해\s*주|해주|드립니다|바랍니다|원합니다|희망/.test(win)) return true;
  }
  return false;
}

export function detectServiceKinds(text: string, opts: { hasEquipmentRows?: boolean } = {}): { serviceTypes: string[]; otherServices: string[] } {
  // 라벨/예시 제거 후 판정. '통번역'(회사명), '통역자료'·'자료 전달'(통역 준비물)은 번역 근거가 아니다.
  const t = serviceEvidenceText(String(text ?? "")).replace(/통\s*번역/g, " ");
  const types = new Set<string>();
  if (/통역(?!\s*장비)/.test(t)) types.add("interpretation");
  if (hasTranslationRequest(t)) types.add("translation");
  if (opts.hasEquipmentRows || /통역\s*장비|장비\s*(대여|임대|렌탈|설치)|수신기|송신기|리시버|통역\s*부스|인포포트|infoport/i.test(t)) types.add("equipment");
  const others: string[] = [];
  if (/감수|원어민\s*검수|proofread/i.test(t)) others.push("감수");
  if (/편집|dtp/i.test(t)) others.push("편집");
  if (/공증|아포스티유|apostille/i.test(t)) others.push("공증");
  if (others.length) types.add("other");
  const order = ["interpretation", "translation", "equipment", "other"];
  return { serviceTypes: order.filter(x => types.has(x)), otherServices: others };
}

// ─── Stage 2: sourceFields → VERITAS 등록폼 필드 매핑(결정론적) ──────────────

export interface MappedFields {
  channel: string; serviceType: string;
  customerCompanyName: string; department: string; contactName: string; contactPosition: string;
  contactPhone: string; contactMobile: string; contactEmail: string;
  languageFrom: string; languageTo: string;
  subject: string; requirements: string; quoteDueDate: string;
  // 고객 접수일시(고객 제출 일시) — date/time 분리, 상태·출처 포함
  customerReceivedDate: string; customerReceivedTime: string; customerReceivedStatus: string; customerReceivedSource: string;
  interpretType: string; scheduleFrom: string; scheduleTo: string; interpretDuration: string; place: string;
  documentType: string; documentUsage: string; volume: string; desiredCompletionDate: string;
  // 복수 서비스(자동 입력 제안) — 등록폼 복수 선택 구조
  serviceTypes: string[]; otherServices: string[];
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
export function mapSourceFieldsToForm(sf: SourceFields, channelDefault = "", opts: { corroborated?: (f: SourceField) => boolean } = {}): MapResult {
  const fields: Partial<MappedFields> = {};
  const warnings: string[] = [];
  const evidence: Record<string, string> = {};
  const inferredLabels: string[] = [];
  // AI 추론값이라도 값이 원문에 그대로 있고 역할 검증을 통과했으면(corroborated) "확인필요" 로 묶지 않는다
  const isInferred = (f: SourceField) => f.origin === "inferred" && !(opts.corroborated?.(f) ?? false);

  // 값이 있으면 그대로 복사하고 근거/추론 표시.
  const take = (key: SourceKey, formKey: Exclude<keyof MappedFields, "serviceTypes" | "otherServices">, label: string): void => {
    const f = sf[key];
    if (!f || !f.raw.trim()) return;
    fields[formKey] = f.raw;
    evidence[formKey] = `${f.sourceLabel}: ${f.raw}`.slice(0, 200);
    if (isInferred(f)) inferredLabels.push(label);
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
  if (fields.interpretDuration) fields.interpretDuration = normalizeDuration(fields.interpretDuration);
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
    // 한 칸에 조합이 여러 개("한국어 → 영어, 한국어 → 스페인어")면 첫 조합만 주 언어로 쓴다(나머지는 추가 언어로 별도 표시).
    const pairs = detectLanguagePairs(sf.languages.raw);
    const split = pairs.length >= 2 ? { from: pairs[0].from, to: pairs[0].to, ambiguous: false } : splitLanguages(sf.languages.raw);
    // 미선택 드롭다운("언어 → 도착언어")의 안내문구는 언어가 아니다 — 각 쪽을 따로 검사해 버린다
    let from = split.from && !isPlaceholderValue(split.from) ? split.from : "";
    let to = split.to && !isPlaceholderValue(split.to) ? split.to : "";
    let ambiguous = split.ambiguous && !!from;
    // 언어가 하나만 적힌 경우("영어동시통역", "영어") — 그 언어만 도착언어로 쓰고 상대(출발) 언어는 임의로 정하지 않는다
    const toks = languageTokens(sf.languages.raw);
    if (split.ambiguous && toks.length === 1) {
      from = ""; to = toks[0]; ambiguous = false;
      warnings.push(`출발(상대) 언어 확인 필요 — 원문에 "${toks[0]}"만 적혀 있어 상대 언어를 정하지 않았습니다. 원문: "${sf.languages.raw}"`);
    }
    if (from) { fields.languageFrom = from; evidence.languageFrom = langEv; }
    if (to) { fields.languageTo = to; evidence.languageTo = langEv; }
    if (!from && !to) warnings.push(`언어 칸이 비어 있음(안내문구만 있음) — 원문: "${sf.languages.raw}"`);
    if (isInferred(sf.languages)) inferredLabels.push("언어");
    if (ambiguous) warnings.push(`언어 방향(출발/도착) 확인필요 — 원문: "${sf.languages.raw}"`);
  }

  // 3) 통역형태 — '통역형태' 라벨 값에서만 결정(장소/요구사항/주제로 추론하지 않음)
  if (sf.interpretType?.raw.trim()) {
    const matched = matchInterpretType(sf.interpretType.raw);
    if (matched) {
      fields.interpretType = matched;
      evidence.interpretType = `${sf.interpretType.sourceLabel}: ${sf.interpretType.raw}`.slice(0, 200);
      if (isInferred(sf.interpretType)) inferredLabels.push("통역형태");
    } else {
      warnings.push(`통역형태 확인필요 — 원문 "${sf.interpretType.raw}" 이(가) 고정 항목과 일치하지 않음`);
    }
  }

  // 4) 문서형태(번역)
  //    복수 선택 — 원문에 적힌 형식을 모두 "Word, HWP" 로. 고정 항목에 없는 표기("출력물", "책")만 원문 그대로 요구사항에 보존(임의로 '기타' 선택 안 함)
  if (sf.documentType?.raw.trim()) {
    const { types, unmatched } = splitDocumentTypes(sf.documentType.raw);
    if (types.length) { fields.documentType = DOCUMENT_TYPES.filter(t => types.includes(t)).join(", "); evidence.documentType = `${sf.documentType.sourceLabel}: ${sf.documentType.raw}`.slice(0, 200); }
    else warnings.push(`문서형태 확인필요 — 원문 "${sf.documentType.raw}"`);
    if (unmatched.length) {
      const note = `원문서 형태(원문): ${stripHelperText(sf.documentType.raw)}`;
      if (!(fields.requirements ?? "").includes(note)) fields.requirements = [fields.requirements, note].filter(Boolean).join("\n");
    }
  }

  // 5) 일정 → scheduleFrom/To (날짜 포맷 변환)
  if (sf.schedule?.raw.trim()) {
    const { from, to, parsed } = parseSchedule(sf.schedule.raw);
    if (from) fields.scheduleFrom = from;
    if (to) fields.scheduleTo = to;
    evidence.schedule = `${sf.schedule.sourceLabel}: ${sf.schedule.raw}`.slice(0, 200);
    // 날짜와 시간대가 따로 적힌 경우("날짜 : 3/25" + "시간 : 오후 1시30분-오후4시") — 날짜에 시작·종료 시각을 붙인다
    const tr = sf.scheduleTime?.raw.trim() ? parseTimeRange(sf.scheduleTime.raw) : null;
    if (tr?.start && fields.scheduleFrom && fields.scheduleFrom.length === 10) {
      fields.scheduleFrom = `${fields.scheduleFrom}T${tr.start}`;
      if (tr.end) fields.scheduleTo = `${(fields.scheduleTo || fields.scheduleFrom).slice(0, 10)}T${tr.end}`;
      evidence.schedule += ` / ${sf.scheduleTime!.sourceLabel}: ${sf.scheduleTime!.raw}`.slice(0, 200);
    }
    if (isInferred(sf.schedule)) inferredLabels.push("통역일정");
    if (!parsed) warnings.push(`통역일정 확인필요(자동 파싱 실패) — 원문: "${sf.schedule.raw}"`);
  }

  // 6) 날짜 필드
  if (sf.desiredCompletionDate?.raw.trim()) {
    const d = parseDate(sf.desiredCompletionDate.raw);
    if (d) { fields.desiredCompletionDate = d; evidence.desiredCompletionDate = `${sf.desiredCompletionDate.sourceLabel}: ${sf.desiredCompletionDate.raw}`.slice(0, 200); }
    else warnings.push(`납기 확인필요 — 원문: "${sf.desiredCompletionDate.raw}"`);
  }
  // 견적서 수령 희망일 — 연도가 적혀 있을 때만 여기서 확정. 연도 없는 표현은 파이프라인이 문서 연도로 판정(resolveDateYear).
  if (sf.quoteDueDate?.raw.trim()) {
    evidence.quoteDueDate = `${sf.quoteDueDate.sourceLabel}: ${sf.quoteDueDate.raw}`.slice(0, 200);
    if (hasExplicitYear(sf.quoteDueDate.raw)) { const d = parseDate(sf.quoteDueDate.raw); if (d) fields.quoteDueDate = d; }
  }

  // 7) serviceType — 어떤 라벨이 존재하는지로만 판정(값 재해석 아님)
  const has = (k: SourceKey) => !!sf[k]?.raw.trim();
  let serviceType = "";
  if (sf.serviceHint?.raw.trim()) {
    const v = sf.serviceHint.raw;
    // "동시통역장비대여"·"통역장비" 의 '통역'은 통역 서비스가 아니다 — 통역장비 표기를 먼저 본다
    if (/통역(?!\s*장비)/.test(v)) serviceType = "interpretation";
    else if (/번역/.test(v)) serviceType = "translation";
    else if (/장비/.test(v)) serviceType = "equipment";
  }
  //    언어쌍은 통역·번역 공통이므로 단독 근거가 아니다 — 언어 라벨 문구("통역할 언어"/"번역할 언어")만 참고한다.
  if (!serviceType) {
    const langLabel = [sf.languages, sf.languageFrom, sf.languageTo].map(f => f?.raw.trim() ? f.sourceLabel : "").join(" ");
    const interpSig = has("interpretType") || has("interpretDuration") || has("place") || /통역/.test(langLabel);
    const transSig = has("documentType") || has("volume") || has("documentUsage") || has("translationContent") || /번역/.test(langLabel);
    if (interpSig) serviceType = "interpretation";
    else if (transSig) serviceType = "translation";
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

// ─── 문서 유형: 베리타스가 발행한 견적서 ─────────────────────────────────────────
//   "발신(베리타스) → 수신(고객)" 구조의 견적서를 의뢰 자료로 올린 경우 — 수신자가 고객이다.
//   발신(공급자) 블록·문서 제목을 분석 텍스트에서 빼고(당사 담당자·전화·주소를 고객정보로 쓰지 않게),
//   표에서 라벨만 위로 몰리고 값이 아래로 이어지는 칸("Service Type / Event Date / Event Venue" → 값 3줄)을 "라벨: 값"으로 다시 묶는다.
//   수신 블록의 "Date"(견적일)는 행사일·접수일시가 아니므로 '견적일' 로 바꿔 둔다(연도 추론 근거로만 사용).
export interface IssuedQuoteInfo { isIssuedQuote: boolean; quoteDate?: string; quoteDateLine?: string; removedSupplierLines: number }
const OUR_MARK = /베리타스|veritas/i;
export function normalizeIssuedQuote(text: string): { text: string; info: IssuedQuoteInfo } {
  const lines = String(text ?? "").split(/\r?\n/);
  const isMark = (l: string, w: string) => new RegExp(`^\\s*${w.split("").join("\\s*")}(?:\\s|$)`).test(l);
  const from = lines.findIndex(l => isMark(l, "발신"));
  const to = lines.findIndex((l, i) => i > from && isMark(l, "수신"));
  if (from < 0 || to < 0 || !lines.slice(from, to).some(l => OUR_MARK.test(l) || /veritasco/i.test(l))) {
    return { text, info: { isIssuedQuote: false, removedSupplierLines: 0 } };
  }
  // 문서 제목(발신 블록 앞, 당사명 + '견적서')도 제외
  const head = lines.slice(0, from).filter(l => !(OUR_MARK.test(l) && /견\s*적\s*서/.test(l)));
  const out: string[] = [...head];
  // 수신 블록 이후 ~ 당사 '안내말씀' 제목 전까지만 — 안내말씀은 베리타스 공통 고지(고객 요청 아님)라 분석에서 뺀다
  let rest = lines.slice(to + 1);
  const notice = rest.findIndex(l => /^\s*안\s*내\s*말\s*씀/.test(l));
  if (notice >= 0) rest = rest.slice(0, notice);
  let quoteDate: string | undefined, quoteDateLine: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const l = rest[i].trim();
    // 쌓인 라벨 줄 묶음 → 같은 수의 값 줄과 짝짓기
    const isLabelOnly = (x: string) => !!x && x.length <= 30 && !/[:：\t]/.test(x) && !!matchLabelKey(x) && isExactLabel(normalizeLabel(x));
    if (isLabelOnly(l)) {
      let k = i; while (k < rest.length && isLabelOnly(rest[k].trim())) k++;
      const n = k - i;
      const vals = rest.slice(k, k + n).map(v => v.trim());
      if (n >= 2 && vals.length === n && vals.every(v => v && !isLabelOnly(v))) {
        for (let j = 0; j < n; j++) out.push(`${rest[i + j].trim()}: ${vals[j]}`);
        i = k + n - 1;
        continue;
      }
    }
    const date = l.match(/^(?:date|견적일(?:자)?|발행일)\s*[:：\t]?\s*(.+)$/i);
    if (date && !quoteDate) {
      const d = parseDate(date[1]);
      if (d) { quoteDate = d; quoteDateLine = l.slice(0, 120); out.push(`견적일: ${date[1].trim()}`); continue; }
    }
    // "Contact 02-…" — 연락처 칸
    const contact = l.match(/^contact\s*[:：\t]?\s*([\d\s()+.-]{7,})$/i);
    if (contact) { out.push(`전화번호: ${contact[1].trim()}`); continue; }
    out.push(rest[i]);
  }
  return { text: out.join("\n"), info: { isIssuedQuote: true, quoteDate, quoteDateLine, removedSupplierLines: to - from + (lines.slice(0, from).length - head.length) } };
}

/** PDF 글꼴 인코딩 문제로 깨진 줄(한글 없이 라틴 확장 문자 위주) — 분석에서 빼고 줄 수를 돌려준다. */
export function stripGarbledLines(text: string): { text: string; removed: number } {
  let removed = 0;
  const kept = String(text ?? "").split(/\r?\n/).filter(l => {
    const t = l.replace(/\s/g, "");
    if (t.length < 8 || /[가-힣]/.test(t)) return true;
    const odd = (t.match(/[\u00A0-\u024F\u0370-\u03FF]/g) ?? []).length;
    if (odd / t.length > 0.3) { removed++; return false; }
    return true;
  });
  return { text: kept.join("\n"), removed };
}
