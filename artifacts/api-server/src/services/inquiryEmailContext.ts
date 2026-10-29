/**
 * inquiryEmailContext — 이메일 업무 맥락 해석(작성자·수신자·고객사 역할 구분, 업무 유형, 통역 세부정보)
 *
 * 문제: 자유형식 이메일에서 "어느 위치에 나온 회사명"을 고객사로 단정하면, 당사 직원이 고객에게 보낸 회신
 *       ("월드엑스포탈 구예나 이사님 안녕하세요? 베리타스 이상우입니다.")에서 작성자 소속(당사)을 고객사로 넣는다.
 * 해결: 회사명 자체가 아니라 "업무상 역할"로 판단한다.
 *   1) 결정론: 작성자 자기소개("○○ ○○○입니다")·인사말 수신자("○○ ○○○ 이사님 안녕하세요")·제목줄을 찾고,
 *      작성자가 당사 직원인지(직원 명단·당사 메일 도메인·당사 상호와 정확히 일치)를 판정한다.
 *   2) AI: 등장인물·회사의 역할(고객/당사/통번역사/협력사/행사장/주최기관/방문 대상)과 업무 유형을 분류한다.
 *   3) 코드 검증: 원문에 없는 값은 버리고, 당사 직원이 쓴 메일이면 작성자 소속을 고객사로 쓰지 않는다.
 * 당사 상호는 "제외 목록"이 아니라 작성자의 역할(서비스 제공자)을 판단하는 근거로만 쓴다
 * (예: 「한국뷰로베리타스」처럼 상호에 '베리타스'가 들어간 고객사는 그대로 고객사).
 */
import { languageTokens, matchInterpretType, type SourceFields, type SourceField } from "../lib/inquirySourceFields";

/** 당사 메일 도메인 — 이 도메인 주소의 작성자는 당사 직원(서비스 제공자) */
export const OUR_EMAIL_DOMAINS = ["veritasco.co.kr", "veritas-corp.com"];
/** 당사 상호 표기(정규화 후 "정확히" 같을 때만) — 작성자/서명 소속이 당사인지 판단하는 데만 사용 */
const OUR_ORG_NAMES = ["베리타스", "베리타스통역번역센터", "베리타스통번역센터", "베리타스통번역", "veritas", "veritascorp", "veritas통역번역센터"];

const norm = (s: string) => String(s ?? "").replace(/\(주\)|㈜|주식회사|\s+|[.,·]/g, "").toLowerCase();
/** 공백·기호를 지운 비교용 문자열(원문 포함 여부 확인). */
export function squashText(s: string): string {
  return String(s ?? "").replace(/[\s　·•,.:：()（）\[\]"'`~\-–—→>]/g, "").toLowerCase();
}
export function isOurOrgName(org: string): boolean {
  const n = norm(org);
  return !!n && OUR_ORG_NAMES.includes(n);
}

export const EMAIL_TYPE_LABELS: Record<string, string> = {
  new_request: "신규 고객 의뢰",
  existing_reply: "기존 의뢰 관련 회신",
  quote_request: "견적 요청",
  quote_exchange: "견적 발송 및 회신",
  schedule_change: "일정 조율 및 변경",
  translator_notice: "통번역사 업무 안내",
  material_transfer: "자료 전달",
  progress_report: "업무 진행 보고",
  completion_settlement: "업무 완료 및 정산 관련",
  other: "기타",
};
const PERSON_ROLES = ["customer_contact", "veritas_staff", "interpreter", "partner", "event_staff", "other"] as const;
const COMPANY_ROLES = ["customer", "service_provider", "venue", "organizer", "visit_target", "partner", "other"] as const;
export const COMPANY_ROLE_LABELS: Record<string, string> = {
  customer: "고객사", service_provider: "서비스 제공(당사)", venue: "행사 장소", organizer: "행사 주최기관",
  visit_target: "방문·심사 대상", partner: "협력업체", other: "기타 관계",
};

export interface Person { name: string; org: string; title: string; line: string }
export interface EmailRoles {
  subjectLine: string;
  author: Person | null;
  addressee: Person | null;
  /** 작성자가 당사 직원인지 + 근거 */
  authorInternal: boolean;
  authorInternalBasis: string;
}

/** "진행 예정입니다", "확인 부탁입니다" 처럼 '…입니다' 앞의 일반 명사는 사람 이름이 아니다 */
const NOT_A_NAME = /^(?:예정|가능|필요|사항|내용|일정|부분|상황|문제|자료|진행|예약|확인|요청|문의|해당|정도|기준|계획|결과|관련|감사|부탁|연락|말씀|안내|회신|공유|전달|송부|참고|변경|시간|장소|오늘|내일|금일|다음|이번|저희|당사|회사|담당)$/;
const TITLE = "대표이사|대표|회장|사장|부사장|전무|상무|이사|본부장|부장|차장|과장|대리|주임|사원|팀장|실장|국장|센터장|매니저|책임|선임|수석|연구원|위원|교수|선생|박사|PM|통역사";

/**
 * 결정론적 역할 단서 — 제목줄, 작성자 자기소개, 인사말 수신자. 원문 문장 그대로에서만 뽑는다.
 */
export function detectEmailRoles(text: string, ctx: { internalNames: string[]; internalDomains: Set<string> }): EmailRoles {
  const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const subj = lines.find(l => /^(?:제목|subject)\s*[:：]/i.test(l))?.replace(/^(?:제목|subject)\s*[:：]\s*/i, "")
    ?? lines.find(l => /^\[[^\]]{4,80}\]$/.test(l))?.slice(1, -1) ?? "";
  let author: Person | null = null;
  let addressee: Person | null = null;
  for (const l of lines.slice(0, 15)) {
    // 인사말 수신자: "월드엑스포탈 구예나 이사님 안녕하세요?" / "구예나 이사님께"
    if (!addressee) {
      const m = l.match(new RegExp(`^(?:(.{1,40}?)\\s+)?([가-힣]{2,4}?)\\s*(${TITLE})?\\s*님\\s*(?:[,!.]\\s*)?(?:안녕하세요|안녕하십니까|께|,|$)`));
      if (m && !/^(?:고객|담당자|관계자|선생|여러분|통역사|번역사)$/.test(m[2])) addressee = { org: (m[1] ?? "").trim(), name: m[2], title: m[3] ?? "", line: l.slice(0, 120) };
    }
    // 작성자 자기소개: "베리타스 이상우입니다." / "그린에너지 해외사업팀 박민수 과장입니다."
    if (!author) {
      const m = l.match(new RegExp(`(?:^|[.!?]\\s*)(?:저는\\s*)?(?:(.{1,40}?)\\s+)?([가-힣]{2,4}?)\\s*(${TITLE})?\\s*(?:입니다|이라고\\s*합니다)\\s*[.!]?$`));
      if (m && !NOT_A_NAME.test(m[2])) author = { org: (m[1] ?? "").replace(/^(?:안녕하세요[.!?]?|저는)\s*/, "").trim(), name: m[2], title: m[3] ?? "", line: l.slice(0, 120) };
    }
  }
  // 보낸사람 헤더 주소가 당사 도메인이면 작성자는 당사 직원
  const fromLine = lines.find(l => /^(?:보낸\s*사람|from)\s*[:：]?\s/i.test(l)) ?? "";
  const fromDomain = fromLine.match(/@([A-Za-z0-9.-]+)/)?.[1]?.toLowerCase() ?? "";
  let basis = "";
  if (author && ctx.internalNames.some(n => n.replace(/\s+/g, "") === author!.name)) basis = `직원 명단 일치(${author.name})`;
  else if (fromDomain && ctx.internalDomains.has(fromDomain)) basis = `보낸사람 당사 도메인(${fromDomain})`;
  else if (author?.org && isOurOrgName(author.org)) basis = `작성자 소속 당사(${author.org})`;
  // 홈페이지 양식 알림처럼 "당사 시스템이 보낸" 메일은 작성자가 아니라 전달자다 — 자기소개가 없으면 역할 판단에 쓰지 않는다
  if (basis.startsWith("보낸사람") && !author) basis = "";
  return { subjectLine: subj, author, addressee, authorInternal: !!basis, authorInternalBasis: basis };
}

export interface AiEmailContext {
  emailTypes: string[];
  author?: { name?: string; org?: string; title?: string; role?: string };
  people: Array<{ name: string; org: string; title: string; role: string }>;
  companies: Array<{ name: string; role: string; evidence: string }>;
  customer?: { company?: string; contactName?: string; contactTitle?: string; evidence?: string };
  interpretation: {
    date?: string; timeRange?: string; arrivalTime?: string; arrivalPlace?: string; region?: string; venue?: string;
    eventName?: string; languages?: string[]; interpretType?: string;
  };
}

/** AI — 이메일 업무 맥락(역할·업무 유형·통역 세부정보). 값은 원문 표현 그대로 받고, 검증은 호출측(코드)이 한다. */
export async function aiAnalyzeEmailContext(params: { text: string; apiKey: string; baseURL?: string; authorHint?: string }): Promise<AiEmailContext | null> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: params.apiKey, baseURL: params.baseURL });
  const systemPrompt = `당신은 통번역 회사 "베리타스(Veritas, 메일 도메인 veritasco.co.kr)"의 업무 메일을 해석하는 분석가입니다.
메일 제목·발신자·수신자·본문을 종합해 "누가 누구에게 어떤 업무로 보낸 메일인지"를 판단합니다. 특정 위치의 회사명을 고객사로 단정하지 않습니다.

## 역할 판단 원칙
- 베리타스는 서비스 제공자(통번역 회사)입니다. 베리타스 직원이 쓴 메일이면 작성자 소속은 고객사가 아니며, 인사말의 수신자("OO사 OOO 이사님 안녕하세요")가 고객 담당자일 가능성이 높습니다.
- 고객이 베리타스에 보낸 메일이면 서명·자기소개의 소속이 고객사입니다.
- 베리타스 직원이 통역사·번역사에게 업무를 안내하는 메일이면 수신자는 통번역사이고, 고객사는 제목·본문에 언급된 의뢰 회사입니다.
- 행사 장소(예: 전시장·호텔), 행사 주최기관, 방문·심사 대상 업체, 협력업체는 고객사가 아닙니다.
- 이름에 '베리타스'가 들어간 다른 회사(예: 한국뷰로베리타스)는 베리타스가 아닙니다.
- 원문에 없는 사람·회사·값을 만들지 않습니다. 모든 이름·값은 원문 표기 그대로 적습니다.

## 업무 유형(emailTypes, 해당하는 것 1~2개, 주된 것 먼저)
new_request(신규 고객 의뢰), existing_reply(기존 의뢰 관련 회신), quote_request(견적 요청), quote_exchange(견적 발송 및 회신),
schedule_change(일정 조율 및 변경), translator_notice(통번역사 업무 안내 — 통역 일정·장소 등 업무 내용 안내 포함), material_transfer(자료 전달),
progress_report(업무 진행 보고), completion_settlement(업무 완료 및 정산 관련), other(기타)
- "어제 알려주신 대로", "회신드립니다"처럼 이미 진행 중인 건을 다루면 new_request 가 아닙니다.

## 통역 세부정보(interpretation) — 원문 표현 그대로(형식 변환 금지)
- date: 통역 날짜 표현, timeRange: 통역(행사) 시작~종료 시간 표현 전체(예 "오후 1시30분-오후4시 정도")
- arrivalTime/arrivalPlace: 통역사 도착 요청 시간/장소(통역 시작시간과 다름), region: 지역, venue: 통역 장소, eventName: 행사명·주제
- languages: 원문에 적힌 언어명만(예 "영어동시통역" → ["영어"]). 적히지 않은 상대 언어(한국어 등)를 추가하지 않습니다.
- interpretType: 동시통역·순차통역 등 원문에 적힌 경우만

## 출력(JSON)
{ "emailTypes": ["existing_reply"],
  "author": { "name": "", "org": "", "title": "", "role": "veritas_staff" },
  "people": [ { "name": "", "org": "", "title": "", "role": "customer_contact" } ],
  "companies": [ { "name": "", "role": "customer", "evidence": "원문 근거 문구" } ],
  "customer": { "company": "", "contactName": "", "contactTitle": "", "evidence": "" },
  "interpretation": { "date": "", "timeRange": "", "arrivalTime": "", "arrivalPlace": "", "region": "", "venue": "", "eventName": "", "languages": [], "interpretType": "" } }
- person role: ${PERSON_ROLES.join(" | ")}
- company role: ${COMPANY_ROLES.join(" | ")}
- 알 수 없는 값은 "" 로 둡니다.`;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${params.authorHint ? `[참고] ${params.authorHint}\n\n` : ""}===== 메일 원문 =====\n${params.text}\n====================` },
    ],
  });
  try {
    const p = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return {
      emailTypes: (Array.isArray(p.emailTypes) ? p.emailTypes : []).map(str).filter((t: string) => t in EMAIL_TYPE_LABELS).slice(0, 2),
      author: p.author && typeof p.author === "object" ? { name: str(p.author.name), org: str(p.author.org), title: str(p.author.title), role: str(p.author.role) } : undefined,
      people: (Array.isArray(p.people) ? p.people : []).map((x: Record<string, unknown>) => ({ name: str(x?.name), org: str(x?.org), title: str(x?.title), role: str(x?.role) })).filter((x: { name: string }) => x.name),
      companies: (Array.isArray(p.companies) ? p.companies : []).map((x: Record<string, unknown>) => ({ name: str(x?.name), role: str(x?.role), evidence: str(x?.evidence) }))
        .filter((x: { name: string; role: string }) => x.name && (COMPANY_ROLES as readonly string[]).includes(x.role)),
      customer: p.customer && typeof p.customer === "object" ? { company: str(p.customer.company), contactName: str(p.customer.contactName), contactTitle: str(p.customer.contactTitle), evidence: str(p.customer.evidence) } : undefined,
      interpretation: (() => {
        const i = p.interpretation && typeof p.interpretation === "object" ? p.interpretation : {};
        return {
          date: str(i.date), timeRange: str(i.timeRange), arrivalTime: str(i.arrivalTime), arrivalPlace: str(i.arrivalPlace),
          region: str(i.region), venue: str(i.venue), eventName: str(i.eventName), interpretType: str(i.interpretType),
          languages: (Array.isArray(i.languages) ? i.languages : []).map(str).filter(Boolean),
        };
      })(),
    };
  } catch { return null; }
}

/**
 * 담당자 칸에 "한빛제약 품질팀 박준영 차장"처럼 회사·부서·이름·직함이 한 칸에 적힌 경우 나눈다(원문 토큰 그대로).
 * 이름 형식(한글 2~4자, 끝 또는 직함 앞)이 아니면 null.
 */
export function splitPersonValue(raw: string): { org: string; department: string; name: string; title: string } | null {
  const m = String(raw ?? "").trim().match(new RegExp(`^(.*?)\\s+([가-힣]{2,4})\\s*(${TITLE})?$`));
  if (!m || !m[1].trim() || NOT_A_NAME.test(m[2])) return null;
  const words = m[1].trim().split(/\s+/);
  const dept = words.filter(w => /(?:팀|부|실|본부|센터|과|국|처|사업부)$/.test(w));
  const org = words.filter(w => !dept.includes(w));
  return { org: org.join(" "), department: dept.join(" "), name: m[2], title: m[3] ?? "" };
}

/** 결정론 업무 유형 추정(AI 미사용·실패 시) — 근거 표현이 있을 때만. */
export function guessEmailTypes(text: string, roles: EmailRoles, isForm: boolean): string[] {
  if (isForm) return ["new_request"];
  const t = String(text ?? "");
  const out: string[] = [];
  if (roles.authorInternal) {
    if (/알려\s*주신|말씀\s*하신|회신|답변|공유\s*(?:하였|했|드)|전달\s*(?:하였|했|드)/.test(t)) out.push("existing_reply");
    if (/견적서?\s*(?:를|을)?\s*(?:송부|발송|첨부|보내)/.test(t)) out.push("quote_exchange");
    if (/통역사(?:에게|님)|번역사(?:에게|님)/.test(t)) out.push("translator_notice");
  } else {
    if (/견적/.test(t)) out.push("quote_request");
    if (/의뢰|요청|문의|부탁/.test(t) && !out.length) out.push("new_request");
  }
  if (/일정\s*(?:변경|조율|조정)/.test(t)) out.push("schedule_change");
  return [...new Set(out)].slice(0, 2);
}

// ─── 역할 기반 고객사·담당자 결정 + 통역 세부정보 보강 ──────────────────────────

export interface EmailContextResult {
  emailTypes: string[];
  emailTypeLabels: string[];
  /** outbound: 당사 직원 → 외부 / inbound: 외부(고객 등) → 당사 / unknown */
  direction: "inbound" | "outbound" | "unknown";
  authorInternal: boolean;
  authorInternalBasis: string;
  subjectLine: string;
  customer: { company: string; contactName: string; contactTitle: string; basis: string; status: "verified" | "inferred" } | null;
  /** 베리타스 내부 담당자(메일 작성자 등) — 정보 표시용, 담당 PM 자동 배정은 하지 않는다 */
  internalStaff: Array<{ name: string; title: string; evidence: string }>;
  companies: Array<{ name: string; role: string; roleLabel: string; evidence: string }>;
  people: Array<{ name: string; org: string; title: string; role: string }>;
  /** 입력란이 없어 요구사항에 보존할 정보(도착 요청 시간·장소, 지역, 예상 종료 등) */
  summaryLines: string[];
  /** 실제로 충돌·부족한 경우만 */
  warnings: string[];
  /** 역할 분석으로 고객사·담당자를 정했는지(정했으면 해당 항목의 일반 "AI 추론" 경고를 내지 않는다) */
  resolvedKeys: string[];
}

/** 라벨(근거) 문구가 원문에 실제로 있는지 — semantic 추론의 임의 근거 문구와 원문 라벨을 구분 */
const evidenceLabelInText = (label: string, srcSq: string) => !!squashText(label) && srcSq.includes(squashText(label));
const stripDept = (org: string) => org.split(/\s+/).filter((w, i) => i === 0 || !/(?:팀|부|실|본부|센터|과|국|처|사업부)$/.test(w)).join(" ").trim();

/**
 * 역할 분석 결과를 sourceFields 에 반영한다(빈 칸 보강 + 역할이 틀린 추론값 교정). 원문에 없는 값은 쓰지 않는다.
 * isForm: 구조화된 '회사명' 라벨이 있는 정형 의뢰서 — 이 경우 회사명·담당자는 건드리지 않는다(기존 우선 정책 유지).
 */
export async function applyEmailContext(sf: SourceFields, p: {
  text: string; roles: EmailRoles; ai: AiEmailContext | null; isForm: boolean;
  isKnownCompany?: (name: string) => Promise<boolean>;
}): Promise<EmailContextResult> {
  const { roles, ai, isForm } = p;
  const srcSq = squashText(p.text);
  const inSrc = (v?: string) => !!v && !!squashText(v) && srcSq.includes(squashText(v));
  // 같은 회사 표기 — "(주)아주인센티브" / "아주인센티브 여행사" 처럼 법인 표기·업종 꼬리말 차이는 같은 회사로 본다
  const same = (a: string, b: string) => { const x = squashText(norm(a)), y = squashText(norm(b)); return !!x && !!y && (x.includes(y) || y.includes(x)); };
  const warnings: string[] = [];
  const resolvedKeys: string[] = [];
  const authorOrg = roles.author?.org ?? "";

  // 회사 역할 — AI 분류를 원문으로 검증하고, 당사 직원이 쓴 메일의 작성자 소속은 서비스 제공자로 고정
  const companies = (ai?.companies ?? []).filter(c => inSrc(c.name)).map(c => {
    const role = roles.authorInternal && authorOrg && same(c.name, authorOrg) && norm(c.name).length <= norm(authorOrg).length + 2 ? "service_provider" : c.role;
    return { name: c.name, role, roleLabel: COMPANY_ROLE_LABELS[role] ?? role, evidence: c.evidence };
  });
  const nonCustomer = (name: string) => companies.some(c => c.role !== "customer" && same(c.name, name) && norm(c.name) === norm(name))
    || (roles.authorInternal && !!authorOrg && norm(name) === norm(authorOrg));
  const people = (ai?.people ?? []).filter(x => inSrc(x.name));
  const roleOf = (name: string) => people.find(x => x.name.replace(/\s+/g, "") === name.replace(/\s+/g, ""))?.role ?? "";

  let customer: EmailContextResult["customer"] = null;
  if (!isForm) {
    // 고객 담당자 후보 — 당사 직원이 쓴 메일이면 인사말 수신자(통번역사 제외), 외부인이 쓴 메일이면 작성자
    const addr = roles.addressee;
    const addrIsCustomer = !!addr && addr.title !== "통역사" && !["interpreter", "veritas_staff", "partner"].includes(roleOf(addr.name));
    const detCompany = roles.authorInternal ? (addrIsCustomer ? addr!.org : "") : authorOrg;
    const aiCompany = ai?.customer?.company && inSrc(ai.customer.company) && !nonCustomer(ai.customer.company) ? ai.customer.company : "";
    let company = "";
    let status: "verified" | "inferred" = "inferred";
    let basis = "";
    if (aiCompany && detCompany && same(aiCompany, detCompany)) {
      company = aiCompany; status = "verified";
      basis = roles.authorInternal ? `인사말 수신자(고객): 「${addr!.line}」` : `작성자 소속: 「${roles.author!.line}」`;
    } else if (aiCompany && detCompany && !nonCustomer(stripDept(detCompany))) {
      const [ka, kd] = p.isKnownCompany ? await Promise.all([p.isKnownCompany(aiCompany), p.isKnownCompany(stripDept(detCompany))]) : [false, false];
      company = kd && !ka ? stripDept(detCompany) : aiCompany;
      basis = ka || kd ? "기존 CRM 거래처와 일치" : "AI 업무 맥락 분석";
      if (!(ka || kd)) warnings.push(`고객사 확인 필요 — 후보가 서로 다릅니다: "${aiCompany}"(문맥 분석) / "${stripDept(detCompany)}"(${roles.authorInternal ? "인사말 수신자" : "작성자 소속"})`);
    } else if (aiCompany) {
      company = aiCompany; basis = `AI 업무 맥락 분석${ai?.customer?.evidence ? `: 「${ai.customer.evidence.slice(0, 80)}」` : ""}`;
      // 원문 라벨 줄에서 나온 회사명(예: "고객사 담당자 : 한빛제약 …")과 AI 판단이 같은 회사면 원문으로 확인된 값
      const pre = sf.companyName;
      if (pre && pre.sourceLabel && !/AI/.test(pre.sourceLabel) && same(pre.raw, aiCompany) && evidenceLabelInText(pre.sourceLabel, srcSq)) { status = "verified"; basis = `${pre.sourceLabel}: ${pre.raw}`; }
    } else if (detCompany && roles.authorInternal && !nonCustomer(stripDept(detCompany))) {
      company = stripDept(detCompany); basis = `인사말 수신자(고객): 「${addr!.line}」`;
      // AI 를 쓰지 않은 경우 — 작성자가 당사 직원으로 확인(직원 명단·당사 도메인)되고 인사말에 회사·이름·호칭이 함께 있으면 원문으로 확인된 관계
      if (!ai && /직원 명단|도메인/.test(roles.authorInternalBasis) && addr!.name) status = "verified";
    }
    const cur = sf.companyName;
    // 결정론(원문 라벨) 회사명은 유지. AI 추론값이 없거나, 작성자 소속(당사)·비고객 역할이면 역할 분석 결과로 교체
    if (company && inSrc(company) && (!cur || (cur.origin === "inferred" && (!same(cur.raw, company) || nonCustomer(cur.raw))))) {
      sf.companyName = { raw: company, sourceLabel: basis, origin: "inferred" };
    } else if (!company && cur?.origin === "inferred" && nonCustomer(cur.raw)) {
      delete sf.companyName;
      warnings.push(`고객사 확인 필요 — "${cur.raw}"은(는) 메일 작성자 소속 등 고객사가 아닌 회사로 판단되어 입력하지 않았습니다.`);
    }

    // 고객 담당자·직함
    let contactName = "", contactTitle = "";
    if (roles.authorInternal) {
      if (addrIsCustomer) { contactName = addr!.name; contactTitle = addr!.title; }
      else if (ai?.customer?.contactName && inSrc(ai.customer.contactName)) { contactName = ai.customer.contactName; contactTitle = ai.customer.contactTitle && inSrc(ai.customer.contactTitle) ? ai.customer.contactTitle : ""; }
      const cn = sf.contactName;
      const curIsAuthor = !!cn && !!roles.author && cn.raw.replace(/\s+/g, "") === roles.author.name;
      if (contactName && (!cn || (cn.origin === "inferred" && (curIsAuthor || !same(cn.raw, contactName))))) {
        sf.contactName = { raw: contactName, sourceLabel: addrIsCustomer ? `인사말 수신자: 「${addr!.line}」` : "AI 업무 맥락 분석", origin: "inferred" };
        if (contactTitle) sf.contactPosition = { raw: contactTitle, sourceLabel: sf.contactName.sourceLabel, origin: "inferred" };
        else if (sf.contactPosition?.origin === "inferred") delete sf.contactPosition;
      } else if (curIsAuthor) delete sf.contactName;
      // 작성자(당사 직원) 줄에서 나온 부서·직함은 고객 정보가 아니다
      for (const k of ["department", "contactPosition"] as const) {
        const f = sf[k];
        if (f?.origin === "inferred" && roles.author && roles.author.line.includes(f.raw) && !(k === "contactPosition" && f.raw === contactTitle)) delete sf[k];
      }
    } else if (!sf.contactName && ai?.customer?.contactName && inSrc(ai.customer.contactName)) {
      contactName = ai.customer.contactName;
      sf.contactName = { raw: contactName, sourceLabel: "AI 업무 맥락 분석", origin: "inferred" };
    } else if (sf.contactName && roles.author && sf.contactName.raw.replace(/\s+/g, "") === roles.author.name) {
      // 외부 작성자의 자기소개("대한물산 해외영업팀 정우진 과장입니다")와 일치 — 원문으로 확인된 담당자·직함
      contactName = sf.contactName.raw;
      contactTitle = roles.author.title;
    }
    if (sf.companyName?.raw && sf.companyName.origin === "inferred") resolvedKeys.push("companyName");
    if (contactName) resolvedKeys.push("contactName");
    if (contactName && sf.contactPosition && (!contactTitle || sf.contactPosition.raw === contactTitle)) resolvedKeys.push("contactPosition");
    customer = sf.companyName || sf.contactName ? {
      company: sf.companyName?.raw ?? "", contactName: sf.contactName?.raw ?? "", contactTitle: sf.contactPosition?.raw ?? "",
      basis: sf.companyName?.sourceLabel ?? sf.contactName?.sourceLabel ?? "", status,
    } : null;
    if (customer && sf.companyName?.origin === "document") customer.status = "verified";
  }

  // 베리타스 내부 담당자 — 작성자(당사 직원) + AI 가 당사 직원으로 분류한 인물(원문 확인)
  const internalStaff: EmailContextResult["internalStaff"] = [];
  if (roles.authorInternal && roles.author) internalStaff.push({ name: roles.author.name, title: roles.author.title, evidence: roles.author.line });
  for (const x of people) if (x.role === "veritas_staff" && !internalStaff.some(s => s.name === x.name.replace(/\s+/g, ""))) internalStaff.push({ name: x.name, title: x.title, evidence: "AI 업무 맥락 분석" });

  // ── 통역 세부정보 보강(빈 칸만, 원문 표현 그대로) ──
  const gi = ai?.interpretation ?? {};
  const fill = (k: keyof SourceFields, raw: string | undefined, label: string) => {
    if (raw && !sf[k]?.raw.trim() && inSrc(raw)) sf[k] = { raw, sourceLabel: label, origin: "inferred" } as SourceField;
  };
  if (!isForm) {
    fill("schedule", gi.date, "AI 업무 맥락 분석(통역 날짜)");
    fill("scheduleTime", gi.timeRange, "AI 업무 맥락 분석(통역 시간)");
    fill("arrivalTime", gi.arrivalTime, "AI 업무 맥락 분석(통역사 도착 요청 시간)");
    fill("arrivalPlace", gi.arrivalPlace, "AI 업무 맥락 분석(통역사 도착 요청 장소)");
    fill("subject", gi.eventName, "AI 업무 맥락 분석(행사명)");
    // 통역 형태·언어 — 제목줄("영어동시통역")·AI 분류에서 원문에 적힌 경우만
    if (!sf.interpretType?.raw.trim()) {
      const src = [roles.subjectLine, sf.languages?.raw, gi.interpretType].find(v => v && inSrc(v) && matchInterpretType(v));
      if (src) sf.interpretType = { raw: src, sourceLabel: src === roles.subjectLine ? "제목" : "AI 업무 맥락 분석", origin: src === roles.subjectLine ? "document" : "inferred" };
    }
    if (!sf.languages?.raw.trim() && !sf.languageFrom?.raw.trim() && !sf.languageTo?.raw.trim()) {
      const subjToks = languageTokens(roles.subjectLine);
      const aiToks = (gi.languages ?? []).filter(t => inSrc(t) && languageTokens(t).length === 1);
      const toks = subjToks.length ? subjToks : aiToks;
      if (toks.length) sf.languages = { raw: toks.join(" → "), sourceLabel: subjToks.length ? `제목: ${roles.subjectLine}` : "AI 업무 맥락 분석", origin: subjToks.length ? "document" : "inferred" };
    }
  }
  // 상세 장소 — 통역사 도착 요청 장소(건물·호실)가 있고 장소 칸이 비었거나 지역 수준이면 상세 장소를 쓴다
  const region = sf.address?.sourceLabel && /지역/.test(sf.address.sourceLabel) ? sf.address.raw : (gi.region && inSrc(gi.region) ? gi.region : "");
  if (sf.arrivalPlace?.raw.trim() && (!sf.place?.raw.trim() || (region && same(sf.place.raw, region)) || same(sf.place.raw, sf.address?.raw ?? ""))) {
    sf.place = { ...sf.arrivalPlace };
  } else if (!sf.place?.raw.trim() && !isForm && gi.venue && inSrc(gi.venue)) {
    sf.place = { raw: gi.venue, sourceLabel: "AI 업무 맥락 분석(통역 장소)", origin: "inferred" };
  } else if (!sf.place?.raw.trim() && region) {
    sf.place = { raw: region, sourceLabel: "지역", origin: sf.address?.raw === region ? "document" : "inferred" };
  }

  // 입력란이 없는 정보 — 요구사항에 보존
  const summaryLines: string[] = [];
  if (sf.arrivalTime?.raw) summaryLines.push(`통역사 도착 요청 시간: ${sf.arrivalTime.raw}`);
  if (sf.arrivalPlace?.raw) summaryLines.push(`통역사 도착 요청 장소: ${sf.arrivalPlace.raw}`);
  if (region && !same(sf.place?.raw ?? "", region)) summaryLines.push(`지역: ${region}`);
  if (internalStaff.length) summaryLines.push(`베리타스 담당자: ${internalStaff.map(s => s.name + (s.title ? ` ${s.title}` : "")).join(", ")}`);

  const emailTypes = ai?.emailTypes.length ? ai.emailTypes : guessEmailTypes(p.text, roles, isForm);
  const direction: EmailContextResult["direction"] = roles.authorInternal ? "outbound"
    : (roles.author || ai?.author?.role === "customer_contact" || isForm) ? "inbound" : "unknown";
  return {
    emailTypes, emailTypeLabels: emailTypes.map(t => EMAIL_TYPE_LABELS[t] ?? t), direction,
    authorInternal: roles.authorInternal, authorInternalBasis: roles.authorInternalBasis, subjectLine: roles.subjectLine,
    customer, internalStaff, companies, people: people.map(x => ({ name: x.name, org: x.org, title: x.title, role: x.role })),
    summaryLines, warnings, resolvedKeys,
  };
}
