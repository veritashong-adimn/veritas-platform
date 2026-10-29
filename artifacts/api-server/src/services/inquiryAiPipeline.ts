/**
 * inquiryAiPipeline — 의뢰건 AI 분석 오케스트레이션 (원문추출 → 필드매핑)
 *
 * 라우트(inquiryAiAnalyze.ts)와 오프라인 검증 하니스가 "동일한 실제 파이프라인"을 공유하도록 여기로 추출한다.
 * (라우트/스크립트에 로직을 중복 구현하면 "테스트는 통과하나 실제는 실패"하는 드리프트가 생긴다 → 방지)
 *
 * 단계:
 *   Stage 0(이미지 → 원문): 이미지는 먼저 원문 텍스트로 "전사"만 한다(transcribeInquiryImage). 전사문은 사용자에게도 보여준다.
 *   Stage 1(원문 → sourceFields):
 *     · 붙여넣은 텍스트 / 이미지 전사문 → 동일한 코드 파서(결정론적) 라벨-값 추출 — 이미지와 텍스트에 같은 기준 적용
 *     · 이미지 → vision "라벨-값 행"은 빈 항목 보강용으로만 사용. 값이 전사문에 실제로 있는 행만 인정(지어낸 행 차단)
 *     · 병합 우선순위(뒤가 우선): semantic(추론) < vision행 < 전사문 < 붙여넣은 텍스트
 *     · 회사명·부서·요구사항 등 라벨 없이 서술된 항목이 비어 있으면 semantic 추출로 빈 칸만 보강 → 전부 "확인필요"
 *   Stage 2(sourceFields → VERITAS 폼): 코드가 결정론적으로 매핑(값 재해석 없음).
 */
import {
  detectLanguagePairs,
  extractLanguageRowPairs,
  contactNameIssue,
  scanContactFallback,
  detectChannel,
  extractEmailDates,
  extractSubmittedAt,
  resolveDateYear,
  isGenericMailbox,
  isPlaceholderValue,
  type LanguagePair,
  extractSourceFieldsDeterministic,
  sourceFieldsFromLabelValueRows,
  mergeSourceFields,
  mapSourceFieldsToForm,
  INTERPRET_TYPES,
  type SourceFields,
  type SourceKey,
  type MappedFields,
  detectServiceKinds,
  hasInterpretationRequest,
  normalizeIssuedQuote,
  stripGarbledLines,
  hasExplicitYear,
  stripHelperText,
  serviceEvidenceText,
  isStrongCompanyLabel,
  parseTimeRange,
} from "../lib/inquirySourceFields";
import { parseQuoteTable, eventDays, namedCount, matchEquipmentKind, mapEquipmentUnit, defaultUnitForKind, type QuoteTableRow } from "./inquiryEquipment";
import { detectEmailRoles, aiAnalyzeEmailContext, applyEmailContext, splitPersonValue, OUR_EMAIL_DOMAINS, type EmailContextResult } from "./inquiryEmailContext";

export type VisionImg = { type: "image_url"; image_url: { url: string; detail?: "high" | "low" | "auto" } };
export interface LabelValueRow { label: string; value: string; }
export interface AnalyzedEquipment {
  kind: string; quantity: string; unit: string; location: string; note: string;
  /** 대여일수(원문에 적힌 일수 또는 해석값 — inferred 에 'days' 가 있으면 해석값) */
  days?: string;
  /** 원문 장비명·원문 표의 Quantity / Hr/Day 칸 값 그대로 · 원본 단가·공급가액(원문 표기) — 의뢰 참고정보(견적 금액으로 쓰지 않음) */
  sourceName?: string; sourceQuantity?: string; sourceHrDay?: string; unitPrice?: string; amount?: string;
  /** 원문에 없고 문맥으로 해석한 항목(quantity·unit·days) — 확인 필요 */
  inferred?: string[];
  /** 장비 종류 매칭 근거: exact(목록과 같은 이름) / synonym(정의된 동의어) / none(기타 직접입력) · 단위 근거 */
  kindBasis?: "exact" | "synonym" | "none"; unitBasis?: "source" | "name" | "default" | "none";
}

export interface AnalyzeOutput {
  fields:      Partial<MappedFields>;
  equipment:   AnalyzedEquipment[];
  confidence:  "high" | "medium" | "low";
  warnings:    string[];
  evidence:    Record<string, string>;
  sourceFields: SourceFields;
  /** 주 언어(languageFrom/To) 외에 원문에 적힌 추가 언어 조합 — 필수 여부 확인 대상 */
  additionalLanguagePairs: Array<LanguagePair & { note: string }>;
  /** ③ 원문 대조 결과(필드별) — verified: 원문에서 확인 · inferred: AI 추론이나 원문에 근거 있음(확인필요) */
  verification: Record<string, { value: string; status: "verified" | "inferred"; evidence: string }>;
  /** 단계별 추적(개발환경 응답/로그용) */
  trace: AnalyzeTrace;
  /** 접수경로 판정 근거(없으면 channel 미입력 = 확인 필요) */
  channelGuess: { channel: string; evidence: string; certain: boolean };
  /** 메일 헤더 일시(②발송·③수신) — 둘 다 자동입력하지 않고 확인용 후보로만 제공 */
  emailDates: { received?: { value: string; line: string }; sent?: { value: string; line: string } };
  /**
   * 고객 접수일시 판정 — fields.customerReceived{Date,Time,Status,Source} 로 반환.
   *  status: confirmed(원문 고객 제출 일시 확인) | needs_review(후보는 있으나 불명확) | not_provided(근거 없음)
   *  candidates: 직원이 적용 버튼으로 반영할 후보(메일 수신·발송 일시, 연도 불명 제출일 등) — 자동입력하지 않음
   */
  receivedAtInfo: {
    status: "confirmed" | "needs_review" | "not_provided"; evidence?: string;
    candidates: Array<{ kind: "received" | "sent" | "submitted-uncertain"; label: string; date: string; time: string | null; line: string }>;
  };
  /** 날짜 항목의 원문·정규화·연도 근거(원문 대조용) */
  dateFields: Record<string, { label: string; raw: string; normalized: string | null; yearBasis: "explicit" | "document" | "uncertain"; status: "confirmed" | "needs_review" }>;
  /** 이메일 업무 맥락 — 업무 유형·메일 방향·고객사/담당자 판단 근거·베리타스 내부 담당자·회사별 역할 */
  emailContext: EmailContextResult;
  /** 핵심 항목별 신뢰도 — high: 원문 확인 · medium: 문맥 추론 · low: 없음/충돌(확인 필요) */
  fieldConfidence: Record<string, "high" | "medium" | "low">;
  debug:       { structured: boolean; matchedCount: number; visionRows: LabelValueRow[]; rejectedVisionRows: LabelValueRow[] };
}

export interface AnalyzeTrace {
  /** ② 항목 분류 — 레이어별 sourceFields(raw) */
  classify: { pasted: Record<string, string>; ocr: Record<string, string>; vision: Record<string, string>; semantic: Record<string, string>; merged: Record<string, string> };
  /** ③ 원문 대조 — 제외된 값과 사유 */
  dropped: Array<{ field: string; value: string; reason: string }>;
  /** 이미지 이중 판독(전사 vs 표 판독) 불일치 */
  readConflicts: Array<{ field: string; transcript: string; vision: string }>;
  /** ④ 입력폼 매핑 결과 */
  mapped: Record<string, unknown>;
}

const norm = (v: string) => v.replace(/\s+/g, "").toLowerCase();
const rawOf = (sf: SourceFields): Record<string, string> =>
  Object.fromEntries(Object.entries(sf).filter(([, v]) => v?.raw.trim()).map(([k, v]) => [k, v!.raw]));

/** 라벨 없이 서술되기 쉬운 항목 — 비어 있으면 semantic 추출로 빈 칸만 보강한다. */
const GAP_FILL_KEYS: SourceKey[] = ["companyName", "department", "contactName", "contactPosition", "requirements", "languages", "schedule", "interpretType", "place"];

/** 공백·기호를 지운 비교용 문자열(전사문에 값이 실제로 있는지 확인). */
function squash(s: string): string {
  return String(s ?? "").replace(/[\s　·•,.:：()（）\[\]"'`~\-–—→>]/g, "").toLowerCase();
}

/**
 * Stage 0(이미지) — 의뢰 이메일/문서 캡처를 "보이는 그대로" 원문 텍스트로 전사한다.
 * 항목 분석은 하지 않는다(분석은 붙여넣은 텍스트와 동일한 코드 경로가 담당). 결과는 사용자에게 원문으로 보여준다.
 */
/**
 * 이미지를 세로 조각(겹침 포함)으로 나누고 확대해 vision 입력으로 만든다.
 * 전체 이미지를 한 장으로 보내면 모델 입력 해상도로 축소되어 작은 한글을 오독한다(예: 최보윤→최보문, 교류→교육).
 * 조각·확대하면 글자 해상도가 유지된다. 실패 시 원본 한 장으로 대체.
 */
export async function buildImageStrips(buf: Buffer, ext: string): Promise<VisionImg[]> {
  const { buildImageDataUrl } = await import("../lib/documentOcr");
  const whole: VisionImg[] = [{ type: "image_url", image_url: { url: buildImageDataUrl(buf, ext), detail: "high" } }];
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(buf);
    const scale = Math.max(1, Math.min(2, 1600 / img.width));
    const stripH = Math.round(720 / scale), overlap = Math.round(40 / scale);
    const out: VisionImg[] = [];
    for (let y = 0; y < img.height && out.length < 16; y += stripH - overlap) {
      const h = Math.min(stripH, img.height - y);
      if (h < 24 && out.length > 0) break;
      const c = createCanvas(Math.round(img.width * scale), Math.round(h * scale));
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, y, img.width, h, 0, 0, c.width, c.height);
      out.push({ type: "image_url", image_url: { url: `data:image/png;base64,${c.toBuffer("image/png").toString("base64")}`, detail: "high" } });
    }
    return out.length ? out : whole;
  } catch (e) {
    console.error("[INQUIRY-AI] 이미지 조각 생성 실패(원본 사용):", e);
    return whole;
  }
}

export async function transcribeInquiryImage(params: { images: VisionImg[]; apiKey: string; baseURL?: string }): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: params.apiKey, baseURL: params.baseURL });
  const systemPrompt = `당신은 이미지 속 글자를 그대로 옮기는 전사(OCR) 도구입니다.
- 이미지에 보이는 텍스트를 위에서 아래로, 줄바꿈과 "라벨: 값" 형태를 유지하며 그대로 옮깁니다.
- 고치거나 요약·번역·보완·추측하지 않습니다. 라벨 문구(예: "통역 형태", "1일")와 값(예: "순차통역", "6시간")을 바꾸지 않습니다.
- 표는 한 행을 한 줄로 "라벨: 값" 형태로 옮깁니다. 빈 칸에 회색 안내문구(예시)만 있으면 옮기지 않습니다.
- 읽을 수 없는 글자는 [판독불가] 로 표시합니다. 시간·날짜·이름은 보이는 그대로만 적습니다.
- 메일 앱 메뉴·버튼 같은 화면 장식은 제외하고, 보낸사람/받는사람/날짜/제목/본문/서명은 포함합니다.
- 이미지가 여러 장이면 위에서 아래로 이어지는 한 문서의 조각입니다. 조각 경계에서 겹쳐 보이는 줄은 한 번만 적습니다.
- 전사한 텍스트만 출력합니다(설명 금지).`;
  const completion = await openai.chat.completions.create({
    model:       "gpt-4o",
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: "user",   content: [{ type: "text", text: "이 이미지의 텍스트를 규칙대로 전사하세요." }, ...params.images] as any },
    ],
  });
  return (completion.choices[0]?.message?.content ?? "").replace(/^```[a-z]*\n?|```$/g, "").trim();
}

const STRUCTURE_THRESHOLD = 3;

/** 분석 엔진 버전 — 응답 meta 와 화면에 표시해 어떤 코드로 분석했는지 확인한다(배포 전/후 혼동 방지) */
export const INQUIRY_AI_ENGINE = "inquiry-ai 2026-10-28.2";

/** KST 기준 오늘 날짜(YYYY-MM-DD). */
function kstTodayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * Stage 1(이미지) — 양식 이미지에서 "라벨 - 실제 입력값" 행만 구조적으로 추출.
 * 의미해석·필드결정은 하지 않는다(그건 코드가 한다). 예시/placeholder·주변 셀 혼입 차단이 목적.
 */
export async function visionExtractRows(params: {
  ocrText: string;
  visionContents: VisionImg[];
  apiKey: string;
  baseURL?: string;
}): Promise<LabelValueRow[]> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: params.apiKey, baseURL: params.baseURL });

  const systemPrompt = `당신은 의뢰서 양식 이미지를 읽어 "라벨 - 값 칸에 보이는 텍스트" 쌍을 정확히 옮기는 OCR 도우미입니다.
의미 해석·추론·번역·요약·정규화·필드 분류는 하지 않습니다. 오직 이미지에 보이는 그대로 라벨과 값을 짝지어 옮깁니다.

## 표/양식 읽기 규칙
- 양식은 보통 라벨 칸과 그에 대응하는 값 칸으로 구성된다. 각 라벨과 "같은 행(또는 바로 옆/아래 짝이 되는 칸)"의 값만 읽는다. 다른 행/다른 라벨의 값을 절대 끌어오지 않는다.
- "실제 입력된 값이 있는가"를 먼저 판단한다.
  · 값 칸에 사용자가 입력한 값이 있으면, 그 칸에 보이는 텍스트를 그대로 value 로 옮긴다(뒤에 'ex) …' 같은 예시 표기가 함께 보이면 그것까지 포함해 그대로 옮긴다 — 예시 제거는 후처리에서 한다).
  · 값 칸이 비어 있고 회색/흐린 예시·안내문(placeholder: "ex) …", "예) …", "예: …", "(예시)")만 있으면 value 는 "" 로 둔다(예시를 값으로 착각 금지).
- 값은 보이는 글자 그대로(verbatim). 회사명·사람이름·언어·장소 등 고유명사를 아는 표현으로 바꾸거나 축약하지 않는다(예: "한국뷰로베리타스"를 "한국베리타스"로 줄이지 말 것, 이름을 다른 이름으로 바꾸지 말 것).
- 국가명과 언어명을 구분한다(말레이시아=국가/장소, 말레이시아어=언어). '언어' 라벨의 값 칸에서는 언어를, '장소' 라벨의 값 칸에서는 장소를 각각 그 칸에서만 읽는다.
- 한 칸에 값이 여러 개면(예: "영어, 말레이시아어") 그대로 유지한다.
- '통역할 주제', '요구 및 주의사항' 등 서술형 칸은 줄바꿈 포함 칸의 텍스트 전체를 그대로 value 에 담는다(요약·발췌·재작성 금지).
- label 은 이미지에 실제로 인쇄된 라벨 문구 그대로 적는다(예: "회사명", "담당자", "통역 형태", "접수일시", "견적서 수령 희망일").
- 날짜·시각 값은 보이는 그대로 옮긴다(형식 변환·연도 추정 금지). 이미지에 없는 라벨을 만들거나 다른 라벨명으로 바꾸지 않는다.
- 이메일처럼 라벨 없이 서술된 문장은 행으로 만들지 않는다(서술 내용은 별도 전사 단계가 처리한다).

## 출력(JSON)
{ "rows": [ { "label": "회사명", "value": "한국뷰로베리타스" }, { "label": "통역의 형태", "value": "동시통역 ex) 동시통역, 순차통역" } ] }
- 값 칸이 비어 있으면 그 라벨은 생략하거나 value:"" 로 둔다.
- 첨부 이미지를 최우선 근거로 삼고, 아래 OCR 자동추출 텍스트는 글자 확인 참고용으로만 쓴다.`;

  const userText = `[OCR 자동추출 텍스트 — 표가 뭉개졌을 수 있으니 글자 참고용]
${params.ocrText || "(없음)"}

첨부 이미지를 보고 라벨-값 행을 규칙대로 추출해 JSON 으로만 응답하세요.`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [{ type: "text", text: userText }, ...params.visionContents];
  const completion = await openai.chat.completions.create({
    model:           "gpt-4o",
    response_format: { type: "json_object" },
    temperature:     0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw) as { rows?: Array<{ label?: unknown; value?: unknown }> };
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    return rows
      .map(r => ({ label: String(r?.label ?? "").trim(), value: String(r?.value ?? "") }))
      .filter(r => r.label);
  } catch { return []; }
}

/**
 * Stage 1(비정형) — 이메일/메신저 텍스트에서 "실제로 적힌" 값만 sourceFields 후보로 추출.
 * 결정론 파서가 라벨을 거의 못 찾은 경우에만 호출. 결과는 전부 origin:"inferred"(확인필요).
 */
export async function aiSemanticExtractSourceFields(params: { text: string; apiKey: string; baseURL?: string }): Promise<SourceFields> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: params.apiKey, baseURL: params.baseURL });

  const keys: SourceKey[] = [
    "companyName", "department", "contactName", "contactPosition", "contactPhone", "contactMobile", "contactEmail",
    "languages", "languageFrom", "languageTo", "interpretType", "interpretDuration", "schedule", "place", "subject",
    "requirements", "documentType", "documentUsage", "volume", "desiredCompletionDate", "quoteDueDate", "serviceHint", "translationContent",   // channelHint 는 원문 근거 판정(detectChannel)만 사용
  ];

  const systemPrompt = `당신은 비정형 의뢰 텍스트(이메일/메신저)에서 "실제로 적혀 있는" 값만 뽑아내는 추출기입니다.
문장을 해석해 새 값을 만들지 말고, 텍스트에 등장한 표현을 그대로 raw 로 옮깁니다. 명시되지 않은 키는 생략합니다.
- raw: 원문에 나온 값 그대로(요약·번역·정정 금지). requirements 는 관련 문장 전체를 그대로 옮긴다.
- sourceLabel: 그 값을 유추한 근거 문구(짧게).
- 오늘은 ${kstTodayStr()}(KST). 상대 날짜가 있으면 raw 에는 원문 그대로 두고 해석하지 않는다.
- 언어/장소/통역형태를 서로 추론으로 바꾸지 않는다. 통역형태는 원문에 실제 언급된 경우에만: ${INTERPRET_TYPES.join(", ")}.
- 고객(의뢰자) 정보만 추출한다. 받는 쪽(통번역 회사·당사·담당PM·info@ 수신 주소)의 이름/연락처는 고객담당자가 아니다.
- 서명/인사말("OO기관 OO팀 홍길동입니다")에서 회사명·부서·담당자·직함을 각각 분리한다. 회사명에 부서를, 담당자에 직함을 붙이지 않는다.
- companyName 은 "의뢰하는 고객(메일을 보낸 사람)의 회사"다. 근거 우선순위: '회사명' 라벨 > 서명·인사말의 발신자 소속 > 발신자 이메일 도메인으로 드러난 회사 > 본문의 의뢰 주체.
- 다음은 고객 회사명이 아니다(companyName 에 넣지 않고, 관련 문장은 requirements 에 원문 그대로 둔다):
  심사 대상 업체, 방문 업체·방문처, 통역 대상 업체, 현지 업체, 행사 주최사·주최측, 공장명·공장주소, 요구사항 안에 '업체명:'으로 적힌 업체.
  예) "한국뷰로베리타스 CER팀 조예리입니다 … 업체명: ABC SDN BHD(말레이시아 공장) 심사 통역" → companyName = 한국뷰로베리타스 (ABC SDN BHD 아님).
  고객 회사를 원문에서 확인할 수 없으면 companyName 을 생략한다(제3자 업체로 채우지 않는다).
- languages: 주 언어 조합을 "출발어 → 도착어" 로. 추가 언어 조합이 있으면 그 문장도 requirements 에 포함한다.
- schedule: 원문에 적힌 날짜·시각 표현 그대로. 원문에 시각이 없으면 시각을 만들지 않는다.
- requirements: 언어 우선순위, 필수 여부, 준비물 등 요청·조건 문장을 원문 그대로 옮긴다.
- subject 는 통역 주제·행사명·회의명이다. translationContent 는 번역할 문서의 내용(예: "학술 연구 발표문")이다. 메일 제목(Subject/제목 줄)은 둘 다 아니다.
- quoteDueDate: "견적서 수령 희망일/견적 회신 요청일/견적 마감일"처럼 견적서를 받을 기한이 원문에 명시된 경우에만 그 날짜 표현을 그대로. 견적 요청일·통역 일정·메일 발송일·접수일을 넣지 않는다.
- 추출 가능한 키: ${keys.join(", ")}`;

  const userMsg = `아래 텍스트에서 실제로 적힌 값만 sourceFields 로 추출하세요.

===== 원문 =====
${params.text || "(없음)"}
================

JSON 형식: { "sourceFields": { "<key>": { "raw": "...", "sourceLabel": "..." } } }
값이 명시되지 않은 키는 넣지 마세요.`;

  const completion = await openai.chat.completions.create({
    model:           "gpt-4o",
    response_format: { type: "json_object" },
    temperature:     0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMsg },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { sourceFields?: Record<string, { raw?: unknown; sourceLabel?: unknown }> };
  try { parsed = JSON.parse(raw); } catch { return {}; }

  const out: SourceFields = {};
  const allow = new Set<string>(keys);
  for (const [k, v] of Object.entries(parsed.sourceFields ?? {})) {
    if (!allow.has(k) || !v || typeof v !== "object") continue;
    const rv = typeof v.raw === "string" ? v.raw.trim() : "";
    if (!rv || isPlaceholderValue(rv)) continue;
    out[k as SourceKey] = {
      raw:         rv,
      sourceLabel: typeof v.sourceLabel === "string" && v.sourceLabel.trim() ? v.sourceLabel.trim() : "(AI 추론)",
      origin:      "inferred",
    };
  }
  return out;
}

/** 통역장비 행 추출 — 라벨-값 파서로는 어려운 표형 데이터. 장비 키워드가 있을 때만 호출. */
export async function aiExtractEquipment(params: { text: string; apiKey: string; baseURL?: string }): Promise<AnalyzedEquipment[]> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: params.apiKey, baseURL: params.baseURL });
  const systemPrompt = `전사된 의뢰서·견적서에서 통역장비/장비 항목만 행 단위로 추출합니다. 원문에 없는 장비를 지어내지 않습니다.
각 행: kind(원문 장비명 그대로 — "통역장비 1 set" 처럼 이름에 붙은 표기도 지우지 않음), quantity(수량 숫자만 — 표의 '수량/Quantity' 칸 값, 장비명 안의 숫자로 바꾸지 않음),
unit(수량 옆에 원문에 적힌 단위만 — "250대"→대, "4EA"→EA, 없으면 빈 값), days(원문에 그 장비의 대여·사용 일수가 "× 3일", "2일간"처럼 적힌 경우에만 숫자, 없으면 빈 값 — 행사 기간으로 계산하지 않음), location(사용장소), note(비고 칸 원문), unitPrice(단가 칸 원문, 없으면 빈 값), amount(금액/공급가액 칸 원문, 없으면 빈 값).
사용일수·시간 칸(Hr/Day 등)이 비어 있으면 수량에 일수를 넣지 않는다. 장비 언급이 없으면 빈 배열.`;
  const userMsg = `===== 원문 =====\n${params.text || "(없음)"}\n================\nJSON: { "equipment": [ { "kind": "", "quantity": "", "unit": "", "days": "", "location": "", "note": "", "unitPrice": "", "amount": "" } ] }`;
  const completion = await openai.chat.completions.create({
    model:           "gpt-4o",
    response_format: { type: "json_object" },
    temperature:     0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMsg },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(raw) as { equipment?: Array<Record<string, unknown>> };
    const eq = Array.isArray(parsed.equipment) ? parsed.equipment : [];
    return eq.map(r => ({
      kind: String(r?.kind ?? ""), quantity: String(r?.quantity ?? "").replace(/^(\d+)\.0+$/, "$1"),
      unit: String(r?.unit ?? ""), location: String(r?.location ?? ""), note: String(r?.note ?? ""),
      sourceName: String(r?.kind ?? ""), unitPrice: String(r?.unitPrice ?? ""), amount: String(r?.amount ?? ""),
      days: String(r?.days ?? "").replace(/[^\d.]/g, ""),
    })).filter(r => r.kind.trim());
  } catch { return []; }
}

/**
 * 전체 분석 오케스트레이션. 입력 준비(파일→원문 전사/vision 조각)는 호출측이 담당하고, 여기서는 ②분류 ③대조 ④매핑을 한다.
 * (①원문 추출은 라우트, ⑤저장·견적 연동은 등록 API/프론트가 담당 — 검증은 오프라인 하니스로 한다.)
 * OpenAI 키가 없으면 vision/semantic 없이 텍스트 기반 결정론 추출만 수행한다.
 */
export async function analyzeInquiry(params: {
  pastedText: string;
  ocrText: string;
  visionContents: VisionImg[];
  apiKey?: string;
  baseURL?: string;
  /** 내부 직원(PM) 이름 — 고객담당자로 오인 방지 */
  internalNames?: string[];
  /** 내부 직원 이메일 — 그 도메인 주소는 고객 이메일로 쓰지 않는다 */
  internalEmails?: string[];
  /** 기존 CRM 거래처 여부(읽기 전용) — 고객사 후보가 여럿일 때 판단 근거 */
  isKnownCompany?: (name: string) => Promise<boolean>;
}): Promise<AnalyzeOutput> {
  const { visionContents, apiKey, baseURL, internalNames = [], internalEmails = [], isKnownCompany } = params;
  // 문서 정리 — ①글꼴 인코딩이 깨진 줄 제외(PDF 안내문 등) ②베리타스 발행 견적서면 발신(공급자) 블록을 빼고 수신자를 고객으로 읽는다
  const gO = stripGarbledLines(params.ocrText), gP = stripGarbledLines(params.pastedText);
  const qO = normalizeIssuedQuote(gO.text), qP = normalizeIssuedQuote(gP.text);
  const ocrText = qO.text, pastedText = qP.text;
  const issuedQuote = qO.info.isIssuedQuote ? qO.info : qP.info;
  const docNotes: string[] = [];
  if (gO.removed + gP.removed > 0) docNotes.push(`판독 불가 텍스트 ${gO.removed + gP.removed}줄 제외 — PDF 글꼴 인코딩 문제로 깨진 줄입니다(원본에서 직접 확인).`);
  if (issuedQuote.isIssuedQuote) docNotes.push("문서 유형: 베리타스 발행 견적서 — 수신자를 고객으로, 발신(베리타스) 정보는 고객정보에서 제외했습니다.");
  const hasImages = visionContents.length > 0;
  const sourceText = [pastedText, ocrText].filter(t => t && t.trim()).join("\n\n");
  const sourceSq = squash(sourceText);
  const dropped: AnalyzeTrace["dropped"] = [];
  const readConflicts: AnalyzeTrace["readConflicts"] = [];

  // ── ② 항목 분류 ── 붙여넣은 텍스트와 이미지 전사문에 같은 결정론 파서를 적용
  const sfFromPasted = extractSourceFieldsDeterministic(pastedText).sourceFields;
  const sfFromOcr    = extractSourceFieldsDeterministic(ocrText).sourceFields;

  // vision 행은 빈 항목 보강 + 전사문과의 이중 판독 비교용. 값이 전사문에 실제로 있는 행만 인정한다(지어낸 행 차단).
  let visionRows: LabelValueRow[] = [];
  const rejectedVisionRows: LabelValueRow[] = [];
  let sfFromVision: SourceFields = {};
  if (hasImages && apiKey) {
    try {
      visionRows = await visionExtractRows({ ocrText, visionContents, apiKey, baseURL });
      // 발행 견적서의 수신 블록 "Date"는 견적일 — 행사 일정으로 읽지 않는다
      if (issuedQuote.isIssuedQuote) visionRows = visionRows.filter(r => !/^\s*(?:date|견적일(?:자)?|발행일)\s*$/i.test(r.label));
      const ocrSq = squash(ocrText);
      const all = sourceFieldsFromLabelValueRows(visionRows, "document");
      const verified = ocrSq
        ? visionRows.filter(r => {
            const ok = !r.value.trim() || ocrSq.includes(squash(r.value));
            if (!ok) rejectedVisionRows.push(r);
            return ok;
          })
        : visionRows;
      sfFromVision = sourceFieldsFromLabelValueRows(verified, ocrSq ? "document" : "inferred");
      // 이중 판독 불일치: 같은 항목을 전사문과 표 판독이 다르게 읽음 → 전사값 유지 + 확인필요
      for (const [k, v] of Object.entries(all)) {
        const t = sfFromOcr[k as SourceKey]?.raw;
        if (k !== "requirements" && v && t && squash(t) !== squash(v.raw)) readConflicts.push({ field: k, transcript: t, vision: v.raw });
      }
    } catch (e) { console.error("[INQUIRY-AI] vision 행추출 실패:", e); }
  }

  let sourceFields = mergeSourceFields(sfFromVision, sfFromOcr, sfFromPasted);

  // 라벨-값이 아닌 곳(보낸사람 헤더·서명 "T./M./E."·단일 공백 라벨)의 연락처 — 빈 칸만 채운다(원문 값 그대로)
  const contactScan = scanContactFallback(sourceText);
  // 당사 도메인 — 직원이 쓰는 공용 메일(gmail/naver 등)은 고객도 쓰므로 제외한다
  const PUBLIC_MAIL = /^(?:gmail\.com|naver\.com|daum\.net|hanmail\.net|kakao\.com|nate\.com|outlook\.com|hotmail\.com|live\.com|yahoo\.com|yahoo\.co\.kr|icloud\.com|me\.com|korea\.com)$/;
  const internalDomains = new Set(internalEmails.map(e => e.split("@")[1]?.toLowerCase()).filter(d => d && !PUBLIC_MAIL.test(d)) as string[]);
  for (const d of OUR_EMAIL_DOMAINS) internalDomains.add(d);
  const isOurs = (email: string) => internalDomains.has(email.split("@")[1]?.toLowerCase() ?? "");
  if (!sourceFields.contactPhone?.raw.trim() && contactScan.phone) sourceFields.contactPhone = { raw: contactScan.phone.value, sourceLabel: contactScan.phone.line, origin: "document" };
  if (!sourceFields.contactMobile?.raw.trim() && contactScan.mobile) sourceFields.contactMobile = { raw: contactScan.mobile.value, sourceLabel: contactScan.mobile.line, origin: "document" };

  let matchedCount = Object.values(sourceFields).filter(f => f && f.raw.trim()).length;
  let structured = matchedCount >= STRUCTURE_THRESHOLD;

  // 이메일 업무 맥락(작성자·수신자·고객사 역할) — 구조화된 '회사명' 라벨이 있는 정형 의뢰서는 기존 우선 정책 유지(역할 분석으로 회사명을 바꾸지 않음)
  const isForm = [sfFromPasted, sfFromOcr, sfFromVision].some(l => l.companyName?.origin === "document" && isStrongCompanyLabel(l.companyName.sourceLabel));
  const roles = detectEmailRoles(sourceText, { internalNames, internalDomains });
  const ctxPromise = apiKey && !isForm && sourceText.trim()
    ? aiAnalyzeEmailContext({ text: sourceText, apiKey, baseURL, authorHint: roles.authorInternal && roles.author ? `작성자 ${roles.author.name}은(는) 베리타스 직원입니다(${roles.authorInternalBasis}).` : undefined })
        .catch(e => { console.error("[INQUIRY-AI] 업무 맥락 분석 실패:", e); return null; })
    : Promise.resolve(null);

  // 라벨 없이 서술된 항목(서명의 회사명·부서, 요청 문장 등)이 비어 있으면 semantic 추출로 빈 칸만 보강(결정론 값은 유지).
  let sfSemantic: SourceFields = {};
  const missing = GAP_FILL_KEYS.filter(k => !sourceFields[k]?.raw.trim());
  if (apiKey && (!structured || missing.length > 0) && sourceText.trim()) {
    try {
      sfSemantic = await aiSemanticExtractSourceFields({ text: sourceText, apiKey, baseURL });
      // ③ 원문 대조(추론값): 원문에 근거가 없는 추론값은 버린다 — 추측 입력 금지
      for (const [k, v] of Object.entries(sfSemantic)) {
        if (v && !evidenceInSource(v.raw, sourceSq)) {
          dropped.push({ field: k, value: v.raw, reason: "AI 추론값이 원문에 없음" });
          delete sfSemantic[k as SourceKey];
        }
      }
      sourceFields = mergeSourceFields(sfSemantic, sourceFields); // 결정론(document)이 추론(inferred)을 덮어씀
      matchedCount = Object.values(sourceFields).filter(f => f && f.raw.trim()).length;
      structured = structured || matchedCount >= STRUCTURE_THRESHOLD;
    } catch (e) { console.error("[INQUIRY-AI] semantic 추출 실패:", e); }
  }

  // ③ 고객 회사명 — '회사명/고객사/기관명' 같은 명확한 라벨 값(1순위)이 어느 판독 결과에든 있으면 그 값을 쓴다.
  //    '업체명' 같은 약한 라벨이나 AI 추론값은 방문·심사 대상 등 제3자 업체일 수 있으므로 덮어쓰지 못한다.
  {
    const cur = sourceFields.companyName;
    if (cur && !(cur.origin === "document" && isStrongCompanyLabel(cur.sourceLabel))) {
      const strong = [sfFromPasted, sfFromOcr, sfFromVision]
        .map(l => l.companyName)
        .find(f => f && f.origin === "document" && f.raw.trim() && isStrongCompanyLabel(f.sourceLabel));
      if (strong && squash(strong.raw) !== squash(cur.raw)) {
        dropped.push({ field: "companyName", value: cur.raw, reason: `회사명 라벨 값 우선(${strong.sourceLabel}: ${strong.raw})` });
        sourceFields.companyName = strong;
      } else if (!strong && cur.origin === "inferred" && isThirdPartyMention(cur.raw, sourceText)) {
        dropped.push({ field: "companyName", value: cur.raw, reason: "방문·심사 대상/현지 업체/주최사 등 제3자 업체" });
        delete sourceFields.companyName;
      }
    }
  }

  // ③ 이메일 업무 맥락 — 역할로 고객사·고객 담당자·베리타스 내부 담당자를 구분하고 통역 세부정보 빈 칸을 보강
  // 담당자 칸에 회사·부서·이름·직함이 함께 적힌 경우("한빛제약 품질팀 박준영 차장") — 이름만 담당자로, 나머지는 빈 칸만 보강
  {
    const cnf = sourceFields.contactName;
    const sp = cnf ? splitPersonValue(cnf.raw) : null;
    if (cnf && sp) {
      sourceFields.contactName = { ...cnf, raw: sp.name };
      if (sp.title && !sourceFields.contactPosition?.raw.trim()) sourceFields.contactPosition = { ...cnf, raw: sp.title };
      if (sp.department && !sourceFields.department?.raw.trim()) sourceFields.department = { ...cnf, raw: sp.department };
      if (sp.org && !sourceFields.companyName?.raw.trim()) sourceFields.companyName = { ...cnf, raw: sp.org, origin: "inferred" };
    }
  }
  const emailContext = await applyEmailContext(sourceFields, { text: sourceText, roles, ai: await ctxPromise, isForm, isKnownCompany });
  // 당사 직원이 쓴 메일의 서명·본문 전화번호는 당사 연락처일 수 있다 — 원문 라벨 없이 찾은 번호는 고객 연락처로 쓰지 않는다
  if (roles.authorInternal) {
    for (const k of ["contactPhone", "contactMobile"] as const) {
      const f = sourceFields[k];
      const custName = sourceFields.contactName?.raw ?? "";
      const unlabeled = !!f && (f.origin === "inferred" || f.sourceLabel === contactScan.phone?.line || f.sourceLabel === contactScan.mobile?.line);
      if (f && unlabeled && !(custName && f.sourceLabel.includes(custName))) {
        dropped.push({ field: k, value: f.raw, reason: "당사 직원 작성 메일의 연락처(고객 연락처 아님)" });
        delete sourceFields[k];
      }
    }
  }

  // ③ 고객담당자 검증 — 지역명·주소 조각·회사/부서/장소 일부·내부 PM 이름이면 제외(확인필요)
  const cn = sourceFields.contactName?.raw;
  if (cn) {
    const issue = contactNameIssue(cn, {
      address: sourceFields.address?.raw, company: sourceFields.companyName?.raw,
      department: sourceFields.department?.raw, place: sourceFields.place?.raw, internalNames,
    });
    if (issue) {
      dropped.push({ field: "contactName", value: cn, reason: issue });
      delete sourceFields.contactName;
    }
  }

  // ③ 고객담당자 이메일 — 받는사람/참조·당사 도메인 주소 제외, 대표 메일함(info@ 등)보다 담당자 개인 주소 우선.
  //    개인 주소 우선순위: 담당자 이름과 같은 줄 > 보낸사람 헤더 > 첫 번째 개인 주소. 원문에 없는 주소는 만들지 않는다.
  const emailNotes: string[] = [];
  {
    // 당사 직원이 고객에게 보낸 메일이면 고객 주소는 받는사람/참조 쪽에 있다
    const cands = contactScan.emails.filter(e => (roles.authorInternal ? !e.sender : !e.recipient) && !isOurs(e.email));
    const personal = cands.filter(e => !e.generic);
    const name = sourceFields.contactName?.raw.replace(/\s+/g, "");
    const best = (name && personal.find(e => e.line.replace(/\s+/g, "").includes(name))) || personal.find(e => e.sender) || personal[0];
    const cur = sourceFields.contactEmail?.raw.trim();
    const curInfo = cur ? contactScan.emails.find(e => e.email.toLowerCase() === cur.toLowerCase()) : undefined;
    if (cur && (isOurs(cur) || (curInfo?.recipient && !roles.authorInternal))) {
      dropped.push({ field: "contactEmail", value: cur, reason: "수신자/당사 주소" });
      delete sourceFields.contactEmail;
    }
    const now = sourceFields.contactEmail?.raw.trim();
    // AI 추론값이 원문 서명/헤더의 주소와 같으면 원문 확인값으로 올린다(확인필요 표시 해제)
    if (now && sourceFields.contactEmail?.origin === "inferred") {
      const hit = cands.find(e => e.email.toLowerCase() === now.toLowerCase());
      if (hit) sourceFields.contactEmail = { raw: hit.email, sourceLabel: hit.line, origin: "document" };
    }
    if (!now && best) {
      sourceFields.contactEmail = { raw: best.email, sourceLabel: best.line, origin: "document" };
    } else if (now && isGenericMailbox(now) && best && best.email.toLowerCase() !== now.toLowerCase()) {
      emailNotes.push(`대표 이메일 ${now} 대신 담당자 개인 이메일 ${best.email}을(를) 입력했습니다.`);
      sourceFields.contactEmail = { raw: best.email, sourceLabel: best.line, origin: "document" };
    }
    if (!sourceFields.contactEmail?.raw.trim()) {
      const generic = cands.find(e => e.generic);
      if (generic) emailNotes.push(`대표 이메일 ${generic.email}만 확인됨 — 담당자 이메일로 입력하지 않았습니다(확인 필요).`);
    }
  }

  // ── ④ 입력폼 매핑 ──
  // 메일 제목(Subject/제목 헤더)은 접수 자료의 제목 — 통역 주제·번역 내용으로 쓰지 않는다(본문의 주제·행사명 라벨만 사용)
  const mailSubject = sourceText.match(/^\s*(?:subject|제목)\s*[:：]\s*(.+)$/im)?.[1]?.trim();
  if (mailSubject && sourceFields.subject?.raw.trim() && squash(sourceFields.subject.raw) === squash(mailSubject)) {
    dropped.push({ field: "subject", value: sourceFields.subject.raw, reason: "메일 제목(접수 자료 제목)" });
    delete sourceFields.subject;
  }

  // 접수경로 — 원문 근거(메일 헤더·홈페이지 양식 문구·전화 상담 표현)로만 판정. 근거 없으면 미입력(확인 필요).
  const channelGuess = detectChannel(sourceText);
  // 추론값이라도 원문에 그대로 있으면(회사명·담당자는 역할 분석이 결정론 단서와 일치할 때만) 일반 "AI 추론" 경고로 묶지 않는다
  const roleChecked = new Set(emailContext.customer?.status === "verified" ? emailContext.resolvedKeys : []);
  const corroborated = (f: { raw: string; sourceLabel: string }) => {
    const key = (Object.entries(sourceFields).find(([, v]) => v === f)?.[0] ?? "") as string;
    if (["companyName", "contactName", "contactPosition"].includes(key) && !roleChecked.has(key)) return false;
    return evidenceInSource(f.raw, sourceSq);
  };
  const mapped = mapSourceFieldsToForm(sourceFields, channelGuess.channel, { corroborated });
  mapped.warnings.unshift(...docNotes);
  // 발행 견적서의 행사일("9/14-16")에 연도가 없으면 견적일 기준으로 연도를 정하고 근거를 남긴다(시각은 만들지 않음)
  const schedRaw = sourceFields.schedule?.raw ?? "";
  if (issuedQuote.quoteDate && schedRaw && mapped.fields.scheduleFrom && !hasExplicitYear(schedRaw)) {
    const y = resolveDateYear(schedRaw, { refDate: issuedQuote.quoteDate }).date?.slice(0, 4);
    if (y) {
      const fix = (v?: string) => v ? `${y}${v.slice(4)}` : v;
      mapped.fields.scheduleFrom = fix(mapped.fields.scheduleFrom)!;
      if (mapped.fields.scheduleTo) mapped.fields.scheduleTo = fix(mapped.fields.scheduleTo)!;
      mapped.warnings.push(`행사 연도 추론 — 원문 "${schedRaw}"에 연도가 없어 견적일(${issuedQuote.quoteDate})을 근거로 ${y}년으로 입력했습니다. 확인 필요.`);
    }
  }
  if (mapped.fields.channel && channelGuess.channel && mapped.fields.channel === channelGuess.channel) {
    mapped.evidence.channel = channelGuess.evidence;
    if (!channelGuess.certain) mapped.warnings.push(`접수경로 "이메일"은 편지 형식으로 추정했습니다(메일 헤더 없음) — 확인 필요. 근거: "${channelGuess.evidence}"`);
  }
  if (!mapped.fields.channel) mapped.warnings.push("접수경로 확인 필요 — 원문에서 이메일 헤더·홈페이지 양식·전화 상담 근거를 찾지 못했습니다.");

  // ── 고객 접수일시(고객이 실제 의뢰를 제출한 일시) ──
  //   ①고객 제출 일시(홈페이지 양식 "접수일시/신청일시…", "…에 접수된 문의")만 자동입력(date/time 분리, 시각 없으면 time 공란).
  //   ③메일 수신·②발송 일시는 제출 시각과 같다고 단정하지 않는다 → 후보(확인 필요). 근거가 없으면 미기재.
  //   시스템 등록일시는 저장 시 created_at 으로 별도 기록된다(여기서 만들지 않음).
  const emailDates = extractEmailDates(sourceText);
  const submitted = extractSubmittedAt(sourceText, sourceFields.submittedAt);
  const refDate = emailDates.received?.value ?? emailDates.sent?.value;   // 연도 판정 기준(메일 헤더 일시)
  const receivedAtInfo: AnalyzeOutput["receivedAtInfo"] = { status: "not_provided", candidates: [] };
  const F = mapped.fields as Record<string, unknown>;
  if (submitted) {
    const yr = submitted.explicitYear
      ? { date: (submitted.value ?? submitted.dateOnly)!.slice(0, 10), yearBasis: "explicit" as const }
      : resolveDateYear(submitted.raw, { refDate, docText: sourceText });
    const time = submitted.value ? submitted.value.slice(11, 16) : null;
    if (yr.date) {
      F.customerReceivedDate = yr.date;
      if (time) F.customerReceivedTime = time;
      F.customerReceivedStatus = "confirmed";
      F.customerReceivedSource = channelGuess.channel === "homepage" ? "homepage" : "unknown";
      mapped.evidence.customerReceivedDate = submitted.line;
      receivedAtInfo.status = "confirmed";
      receivedAtInfo.evidence = submitted.line + (yr.yearBasis === "document" ? " (연도는 문서 날짜 기준)" : "") + (time ? "" : " (시각 미기재)");
    } else {
      receivedAtInfo.candidates.push({ kind: "submitted-uncertain", label: "고객 제출일(연도 불명)", date: parseDateLoose(submitted.raw), time, line: submitted.line });
    }
  }
  // 확정 기준(2026-10-28): 원문에 고객 제출 일시가 없을 때
  //   · 홈페이지 자동 의뢰 알림 메일 → 메일 발송 시각(알림은 양식 제출 시 자동 발송된다)
  //   · 일반 이메일 의뢰 → 메일 수신 시각(수신 일시 표기가 없으면 메일앱 헤더 일시)
  //   정상 추출되면 확정(confirmed) — 확인 필요 경고를 내지 않는다. 그 외 경로(전화·카카오·미상)는 기존대로 후보만 제시.
  if (receivedAtInfo.status !== "confirmed" && (channelGuess.channel === "homepage" || channelGuess.channel === "email")) {
    const pick = channelGuess.channel === "homepage"
      ? (emailDates.sent ? { d: emailDates.sent, src: "email_sent", label: "메일 발송일시" } : emailDates.received ? { d: emailDates.received, src: "email_received", label: "메일 수신일시" } : null)
      : (emailDates.received ? { d: emailDates.received, src: "email_received", label: "메일 수신일시" } : emailDates.sent ? { d: emailDates.sent, src: "email_sent", label: "메일 헤더 일시" } : null);
    if (pick) {
      F.customerReceivedDate = pick.d.value.slice(0, 10);
      F.customerReceivedTime = pick.d.value.slice(11, 16);
      F.customerReceivedStatus = "confirmed";
      F.customerReceivedSource = pick.src;
      mapped.evidence.customerReceivedDate = pick.d.line;
      receivedAtInfo.status = "confirmed";
      receivedAtInfo.evidence = `${pick.d.line} (${channelGuess.channel === "homepage" ? "홈페이지 의뢰 알림" : "이메일 의뢰"} — ${pick.label} 기준)`;
      receivedAtInfo.candidates = [];
    }
  }
  if (receivedAtInfo.status !== "confirmed") {
    if (emailDates.received) receivedAtInfo.candidates.push({ kind: "received", label: "메일 수신일시", date: emailDates.received.value.slice(0, 10), time: emailDates.received.value.slice(11, 16), line: emailDates.received.line });
    if (emailDates.sent) receivedAtInfo.candidates.push({ kind: "sent", label: "메일 발송일시", date: emailDates.sent.value.slice(0, 10), time: emailDates.sent.value.slice(11, 16), line: emailDates.sent.line });
    receivedAtInfo.status = receivedAtInfo.candidates.length ? "needs_review" : "not_provided";
    F.customerReceivedStatus = receivedAtInfo.status;
    F.customerReceivedSource = "unknown";
    mapped.warnings.push(receivedAtInfo.candidates.length
      ? `고객 접수일시 확인 필요 — 원문에서 고객 제출 일시를 확정할 수 없습니다. 후보: ${receivedAtInfo.candidates.map(c => `${c.label} ${c.date}${c.time ? " " + c.time : ""}`).join(", ")} (제출 시각과 같다고 단정하지 않음)`
      : "고객 접수일시 미기재 — 원문에 고객 제출·메일 수신 일시가 없습니다.");
  }

  // ── 견적서 수령 희망일 — 원문 표현과 정규화 값을 함께 보존, 연도 불명이면 확정하지 않음 ──
  const dateFields: AnalyzeOutput["dateFields"] = {};
  if (sourceFields.quoteDueDate?.raw.trim()) {
    const q = sourceFields.quoteDueDate;
    const yr = resolveDateYear(q.raw, { refDate: (F.customerReceivedDate as string | undefined) ?? refDate, docText: sourceText });
    dateFields.quoteDueDate = { label: q.sourceLabel, raw: q.raw, normalized: yr.date, yearBasis: yr.yearBasis, status: yr.date ? "confirmed" : "needs_review" };
    if (yr.date) F.quoteDueDate = yr.date;
    else { delete F.quoteDueDate; mapped.warnings.push(`견적서 수령 희망일 확인 필요 — 원문 "${q.raw}"의 연도를 문서에서 확인할 수 없어 입력하지 않았습니다.`); }
  }
  mapped.warnings.push(...emailNotes);
  for (const d of dropped.filter(x => x.field === "companyName" && x.reason.startsWith("방문"))) {
    mapped.warnings.push(`고객 회사명 확인 필요 — "${d.value}"은(는) ${d.reason}(으)로 보여 고객 회사명으로 입력하지 않았습니다.`);
  }
  for (const d of dropped.filter(x => x.field === "contactName")) {
    mapped.warnings.push(`고객담당자 확인 필요 — "${d.value}"은(는) ${d.reason}(으)로 판단되어 입력하지 않았습니다.`);
  }

  const eqSource = [ocrText, pastedText, ...visionRows.map(r => `${r.label}: ${r.value}`)].join("\n");
  let equipment: AnalyzedEquipment[] = [];
  if (apiKey && /장비|수신기|송신기|부스|헤드셋|리시버|마이크|infoport|인포포트/i.test(eqSource)) {
    try { equipment = await aiExtractEquipment({ text: eqSource, apiKey, baseURL }); }
    catch (e) { console.error("[INQUIRY-AI] 장비 추출 실패:", e); }
  }

  // 장비 행 정리 — 수량·대여일수 구분, 장비 종류·단위를 화면 목록에 맞춤, 공통 행사 장소 반영(services/inquiryEquipment)
  //   원문 값은 그대로, 문맥으로 해석한 값은 inferred(확인 필요). 원본 단가·금액은 원문에 있는 표기만 참고정보로.
  const digits = (v: string) => v.replace(/[^\d]/g, "");
  const srcDigits = digits(sourceText);
  const table = parseQuoteTable(sourceText);
  const evDays = eventDays(mapped.fields.scheduleFrom, mapped.fields.scheduleTo);
  const defaultUnits: string[] = [];
  for (const r of equipment) {
    const name = (r.sourceName || r.kind).trim();
    r.sourceName = name;
    r.inferred = [];
    // "250대"·"4EA" — 수량에 단위가 붙어 오면 숫자와 단위로 나눈다(단위는 원문 표기 그대로)
    const qu = r.quantity.match(/^\s*(\d[\d,]*(?:\.\d+)?)\s*([^\d\s][^\s]*)\s*$/);
    if (qu) { r.quantity = qu[1]; if (!r.unit.trim()) r.unit = qu[2]; }
    r.quantity = r.quantity.replace(/,/g, "").replace(/\.0+$/, "");
    let unitRaw = r.unit.trim(), unitBasis: AnalyzedEquipment["unitBasis"] = unitRaw ? "source" : "none";
    // 대여일수 — 자유 서술은 원문에 "N일"로 적힌 값만 인정
    if (r.days && !new RegExp(`${r.days}\\s*일`).test(sourceText)) r.days = "";
    const named = namedCount(name);
    const row = table?.rows.find(t => norm(t.name) === norm(name)) ?? table?.rows.find(t => norm(t.name).startsWith(norm(name)) || norm(name).startsWith(norm(t.name)));
    if (row) {
      // 원본 견적 표 — Quantity 칸을 무조건 장비 수량으로 보지 않는다(Hr/Day·장비명·행사 기간·단가×수량=금액을 함께 본다)
      r.sourceQuantity = row.qty; r.sourceHrDay = row.hrDay; r.unitPrice = row.unitPrice; r.amount = row.amount;
      if (row.note && row.note.length >= (r.note ?? "").length) r.note = row.note;
      r.quantity = row.qty; r.days = "";
      if (row.hrDay) {
        if ((evDays && +row.hrDay === evDays) || new RegExp(`${row.hrDay}\\s*일`).test(row.note)) r.days = row.hrDay;
        else mapped.warnings.push(`장비 Hr/Day 확인 필요 — 「${name}」 Hr/Day ${row.hrDay}: 시간인지 일수인지 원문에서 확인되지 않아 대여일수에 넣지 않았습니다.`);
      } else if (named && +row.qty !== +named.qty) {
        const priceOk = +digits(row.unitPrice) * +row.qty === +digits(row.amount);
        if (evDays && +row.qty === evDays && priceOk) {
          r.quantity = named.qty; r.days = row.qty; unitRaw = named.unit; unitBasis = "name";
          r.inferred.push("quantity", "days");
          mapped.warnings.push(`장비 수량·대여일수 해석(확인 필요) — 「${name}」 원문 Quantity ${row.qty}를 ${named.qty}${mapEquipmentUnit(named.unit) || named.unit} × ${row.qty}일로 입력했습니다. 근거: 장비명 '${named.qty} ${named.unit}', 행사 기간 ${evDays}일, 단가×${row.qty}=공급가액. Hr/Day 칸이 비어 있어 원문만으로는 확정되지 않습니다.`);
        } else {
          // 장비명에서 온 단위("1 set")를 원문 수량에 붙이면 "${row.qty}세트"로 단정하게 된다 — 확인 전까지 단위는 비워 둔다
          if (unitRaw.toLowerCase() === named.unit.toLowerCase()) { unitRaw = ""; unitBasis = "none"; r.unit = ""; }
          mapped.warnings.push(`장비 수량 확인 필요 — 「${name}」 Quantity ${row.qty}: 대여일수(${row.qty}일)인지 ${row.qty}${named.unit}인지 원문에서 확인되지 않아 원문 수량 그대로 입력했습니다.`);
        }
      }
    } else if (named && !unitRaw && +named.qty === +r.quantity) { unitRaw = named.unit; unitBasis = "name"; }
    for (const k of ["unitPrice", "amount"] as const) if (r[k] && (!digits(r[k]!) || !srcDigits.includes(digits(r[k]!)))) r[k] = "";
    // 장비 종류 — 목록·동의어로만 매칭, 없으면 기타 직접입력(원문 장비명은 sourceName·비고로 보존)
    const km = matchEquipmentKind(name, sourceText);
    r.kind = km.kind; r.kindBasis = km.basis;
    // 단위 — 원문 단위 > 장비명의 단위 > 장비 종류 기본 단위(상품 Master 기준). 목록에 없는 원문 단위는 비우고 비고에 원문 표기
    let unit = mapEquipmentUnit(unitRaw);
    if (unitRaw && !unit) r.note = [`단위: ${unitRaw}`, r.note].filter(Boolean).join(" / ");
    const ambiguous = !!row && !row.hrDay && !!named && +row.qty !== +named.qty && !r.inferred.length;
    if (!unit && !unitRaw && !ambiguous && defaultUnitForKind(r.kind)) { unit = defaultUnitForKind(r.kind); unitBasis = "default"; defaultUnits.push(`${r.kind} → ${unit}`); }
    r.unit = unit; r.unitBasis = unit ? unitBasis : "none";
    // 사용 장소 — 장비별 장소가 없으면 공통 행사 장소
    if (!r.location?.trim() && mapped.fields.place) r.location = mapped.fields.place;
  }
  if (defaultUnits.length) mapped.warnings.push(`장비 단위 기본값 적용(원문에 단위 없음 — 상품 Master 단위 기준): ${defaultUnits.join(", ")}`);
  // 원본 견적 금액 — 단가·공급가액·합계만 참고정보로 요구사항에 보존(신규 견적 금액 아님). 장비명·수량·비고는 장비 목록에 있으므로 반복하지 않는다.
  //   장비 목록에 없는 표 행(인건비 등)은 원문 그대로 모두 남긴다.
  if (issuedQuote.isIssuedQuote && table) {
    // AI가 요구사항에 옮긴 품목 표 원문(머리글·품목 행)·서비스 유형 줄은 장비 목록·참고정보와 중복 — 빼고 참고정보 한 번만 남긴다
    const isTableLine = (l: string) => {
      const t = l.replace(/\t+/g, " ").trim();
      if (/(?:unit\s*price|단가)/i.test(t) && /(?:amount|금액)/i.test(t)) return true;
      if (/^service\s*type\b/i.test(t)) return true;
      return table.rows.some(r => norm(t).startsWith(norm(r.name)) && digits(t).includes(digits(r.amount)));
    };
    if (mapped.fields.requirements) mapped.fields.requirements = mapped.fields.requirements.split("\n").filter(l => !isTableLine(l)).join("\n").trim();
    const won = (v?: string) => v ? `${v.replace(/[￦₩원\s]/g, "")}원` : "";
    const inList = (t: QuoteTableRow) => equipment.some(r => r.sourceName && (norm(t.name) === norm(r.sourceName) || norm(t.name).startsWith(norm(r.sourceName))));
    const ref = [
      `[원본 견적 참고정보${issuedQuote.quoteDate ? ` — 견적일 ${issuedQuote.quoteDate}` : ""} · 신규 견적 금액 아님]`,
      ...table.rows.map(t => inList(t)
        ? `- ${t.name}: 단가 ${won(t.unitPrice)} · 공급가액 ${won(t.amount)} (원문 ${t.hrDay ? `Hr/Day ${t.hrDay} · ` : ""}Quantity ${t.qty})`
        : `- ${t.name}: ${t.hrDay ? `Hr/Day ${t.hrDay} · ` : ""}Quantity ${t.qty} · 단가 ${won(t.unitPrice)} · 공급가액 ${won(t.amount)}${t.note ? ` · 비고 ${t.note}` : ""} (장비 목록 외 항목)`),
      ...(table.subTotal || table.vat || table.total ? [`- ${[table.subTotal && `공급가액 ${won(table.subTotal)}`, table.vat && `부가세 ${won(table.vat)}`, table.total && `총액 ${won(table.total)}`].filter(Boolean).join(" / ")}`] : []),
    ].join("\n");
    mapped.fields.requirements = [mapped.fields.requirements, ref].filter(Boolean).join("\n");
  }

  // 복수 서비스 — 실제로 적힌 값·문장에서만 판정(양식 라벨/예시 제외: detectServiceKinds 내부 처리)
  const svcText = [sourceFields.serviceHint?.raw, sourceFields.subject?.raw, sourceFields.requirements?.raw, pastedText, ocrText].filter(Boolean).join("\n");
  const svc = detectServiceKinds(svcText, { hasEquipmentRows: equipment.length > 0 });
  if (mapped.fields.serviceType && !svc.serviceTypes.includes(mapped.fields.serviceType)) svc.serviceTypes.unshift(mapped.fields.serviceType);
  // 번역·장비 의뢰에 '통역'이 언급만 된 경우("통역 경험이 있는 번역가", "통역사는 자체 섭외") 통역을 함께 선택하지 않는다.
  //   통역 근거: 서비스 유형 라벨의 '통역', 통역 형태·1일 통역시간, "통역할 언어" 라벨, 통역 요청 문장.
  //   번역과 함께일 때는 일정·장소도 통역 근거로 본다(장비는 일정·장소를 함께 쓰므로 제외).
  const has = (k: SourceKey) => !!sourceFields[k]?.raw.trim();
  // '통역'이 '통역장비'(·회사명 '통번역') 안에만 있으면 통역 근거가 아니다 — "동시통역장비대여"에서 뽑힌 통역 형태·언어는 버린다
  if (!/통역(?!\s*장비)/.test(serviceEvidenceText(svcText).replace(/통\s*번역/g, " "))) {
    for (const k of ["interpretType", "interpretDuration"] as const) {
      if (sourceFields[k]) { dropped.push({ field: k, value: sourceFields[k]!.raw, reason: "'통역장비' 표기(통역 서비스 아님)" }); delete sourceFields[k]; delete (mapped.fields as Record<string, unknown>)[k]; }
    }
    for (const k of ["languageFrom", "languageTo"] as const) {
      const v = mapped.fields[k];
      if (v && /장비/.test(v)) { dropped.push({ field: k, value: v, reason: "언어가 아님(서비스 유형 표기)" }); delete mapped.fields[k]; }
    }
    mapped.warnings = mapped.warnings.filter(w => !/언어 방향.*장비|원문: "[^"]*장비/.test(w));
  }
  const langLabel = [sourceFields.languages, sourceFields.languageFrom, sourceFields.languageTo].map(f => f?.raw.trim() ? f.sourceLabel : "").join(" ");
  const interpLabeled = /통역(?!\s*장비)/.test(sourceFields.serviceHint?.raw ?? "") || has("interpretType") || has("interpretDuration") || /통역/.test(langLabel);
  const interpShared = has("schedule") || has("scheduleTime") || has("place");
  if (svc.serviceTypes.includes("interpretation") && !interpLabeled && !hasInterpretationRequest(serviceEvidenceText(svcText))
      && ((svc.serviceTypes.includes("translation") && !interpShared) || svc.serviceTypes.includes("equipment"))) {
    svc.serviceTypes = svc.serviceTypes.filter(t => t !== "interpretation");
    if (mapped.fields.serviceType === "interpretation" || !mapped.fields.serviceType) mapped.fields.serviceType = svc.serviceTypes[0];
  }
  if (svc.serviceTypes.length) {
    mapped.fields.serviceTypes = ["interpretation", "translation", "equipment", "other"].filter(x => svc.serviceTypes.includes(x));
    mapped.fields.serviceType = mapped.fields.serviceType || mapped.fields.serviceTypes[0];
  }
  if (svc.otherServices.length) mapped.fields.otherServices = svc.otherServices;
  // 번역할 내용 — 번역 단독이면 '번역 내용/주제' 입력란(subject), 통역과 함께면 통역 주제와 섞이지 않게 요구사항에 보존
  const tc = sourceFields.translationContent?.raw.trim();
  if (tc && (mapped.fields.serviceTypes ?? []).includes("translation")) {
    if (!(mapped.fields.serviceTypes ?? []).includes("interpretation") && !mapped.fields.subject) {
      mapped.fields.subject = tc;
      mapped.evidence.subject = `${sourceFields.translationContent!.sourceLabel}: ${tc}`.slice(0, 200);
    } else if (!(mapped.fields.requirements ?? "").includes(tc)) {
      mapped.fields.requirements = [mapped.fields.requirements, `번역할 내용: ${tc}`].filter(Boolean).join("\n");
    }
  }

  // 언어 조합 — 양식의 반복 "출발언어/도착언어" 행 + 본문의 "한국어 → 영어" 표기를 모두 모은다(이미지·텍스트 동일 기준).
  // 저장 구조가 단일 언어쌍이므로 첫 조합 = 주 언어, 나머지 = 추가 언어(요구사항에 기록, 필수 여부 확인).
  const allPairs: LanguagePair[] = [];
  for (const p of [
    ...extractLanguageRowPairs(pastedText), ...extractLanguageRowPairs(ocrText),
    // 원문 전체에서 찾을 때도 양식 안내문·예시("ex) 출발언어 → 도착언어 한국어 -> 일본어")는 제외 — 원본에 없는 조합을 추가 언어로 만들지 않는다
    ...detectLanguagePairs([sourceFields.languages?.raw, ...[pastedText, ocrText].map(t => (t ?? "").split(/\r?\n/).map(stripHelperText).join("\n"))].filter(Boolean).join("\n")),
  ]) {
    if (!allPairs.some(x => x.from === p.from && x.to === p.to)) allPairs.push(p);
  }
  // 최종 방어: 안내문구("언어", "도착언어")가 출발/도착 언어로 남아 있으면 버리고 원문 조합으로 다시 채운다
  for (const k of ["languageFrom", "languageTo"] as const) {
    const v = mapped.fields[k];
    if (v && isPlaceholderValue(v)) { dropped.push({ field: k, value: v, reason: "안내문구(placeholder)" }); delete mapped.fields[k]; }
  }
  if ((!mapped.fields.languageFrom || !mapped.fields.languageTo) && allPairs.length > 0) {
    mapped.fields.languageFrom = allPairs[0].from;
    mapped.fields.languageTo = allPairs[0].to;
    mapped.evidence.languageFrom = mapped.evidence.languageTo = allPairs[0].context;
  }
  // 도착언어 칸 값에 붙은 단서("스페인어 (필수 아님)")는 언어명만 남긴다
  const langToken = (v?: string) => v?.match(/[가-힣]{1,10}어/)?.[0];
  if (mapped.fields.languageTo && langToken(mapped.fields.languageTo) && mapped.fields.languageTo !== langToken(mapped.fields.languageTo)) {
    mapped.fields.languageTo = langToken(mapped.fields.languageTo)!;
  }
  const additionalLanguagePairs = allPairs
    .filter(p => !(p.from === mapped.fields.languageFrom && p.to === mapped.fields.languageTo))
    // 원문에 "필수 아님/선택 사항/가능하시면" 이 있으면 선택 사항, 아무 표현이 없으면 필수 여부 확인 필요
    // 언어 칸 줄 + 같은 조합(출발·도착 언어 모두)이 언급된 본문 문장("한국어 → 스페인어는 반드시 필요한 사항은 아닙니다")을 함께 본다
    .map(p => {
      const ctx = [p.context, ...sourceText.split(/\r?\n/).filter(l => l.includes(p.from) && l.includes(p.to) && l.trim() !== p.context)].join(" ");
      return { ...p, note: /필수\s*(?:가|는|은|사항)?\s*아|불필요|선택|가능하시면|가능하다면|가능할\s*경우|희망|필요(?:한)?\s*(?:사항|것)?(?:은|는)?\s*아닙|필요\s*없|필요하지\s*않/.test(ctx) ? "선택 사항" : /필수/.test(ctx) ? "필수" : "필수 여부 확인" };
    });
  if (additionalLanguagePairs.length > 0) {
    const line = `추가 언어: ${additionalLanguagePairs.map(p => `${p.from} → ${p.to} (${p.note})`).join(", ")}`;
    mapped.fields.requirements = mapped.fields.requirements ? `${mapped.fields.requirements}\n${line}` : line;
    mapped.warnings.push(`${line} — 원문: "${additionalLanguagePairs[0].context}"`);
  }

  // 이미지 이중 판독 불일치 → 확인필요 경고
  for (const c of readConflicts) {
    mapped.warnings.push(`이미지 판독 확인 필요 — ${c.field}: 전사 "${c.transcript.slice(0, 40)}" / 표 판독 "${c.vision.slice(0, 40)}" (전사값 입력)`);
  }

  // 입력란이 없는 통역 정보(예상 종료·도착 요청 시간/장소·지역·베리타스 담당자)는 요구사항에 원문 그대로 보존
  const tr = sourceFields.scheduleTime?.raw ? parseTimeRange(sourceFields.scheduleTime.raw) : null;
  const keep = [
    ...(tr?.end && tr.endApprox ? [`통역 종료: ${tr.end}경(예상) — 원문 「${sourceFields.scheduleTime!.raw}」`] : []),
    ...emailContext.summaryLines,
  ].filter(l => !(mapped.fields.requirements ?? "").includes(l));
  if (keep.length) mapped.fields.requirements = [mapped.fields.requirements, ...keep].filter(Boolean).join("\n");
  mapped.warnings.push(...emailContext.warnings);

  // ── ③ 원문 대조(최종) ── 입력폼에 들어가는 문자열 값마다 근거(원문 라벨·값)가 원문에 있는지 확인
  const verification: AnalyzeOutput["verification"] = {};
  const FIELD_SOURCE: Record<string, SourceKey> = {
    customerCompanyName: "companyName", department: "department", contactName: "contactName", contactPosition: "contactPosition",
    contactPhone: "contactPhone", contactMobile: "contactMobile", contactEmail: "contactEmail", place: "place", subject: "subject",
    interpretDuration: "interpretDuration", interpretType: "interpretType", scheduleFrom: "schedule", scheduleTo: "schedule",
    documentUsage: "documentUsage", volume: "volume", documentType: "documentType",
    // 날짜 필드는 변환값(YYYY-MM-DD)이 원문에 그대로 없을 수 있으므로 원문 raw("10월 28일(수)까지")로 대조
    quoteDueDate: "quoteDueDate", desiredCompletionDate: "desiredCompletionDate",
  };
  for (const [field, val] of Object.entries(mapped.fields)) {
    if (typeof val !== "string" || !val.trim() || field === "channel" || field === "serviceType") continue;
    // 상태·출처 코드는 원문 값이 아니다
    if (field === "customerReceivedStatus" || field === "customerReceivedSource") continue;
    // 고객 접수일시는 정규화 값(YYYY-MM-DD / HH:mm)이라 원문에 그대로 없다 — 근거 줄이 원문에 있으면 확인값
    if (field === "customerReceivedDate" || field === "customerReceivedTime") {
      const ev = mapped.evidence.customerReceivedDate ?? "";
      if (ev && evidenceInSource(ev, sourceSq)) verification[field] = { value: val, status: "verified", evidence: ev };
      else { dropped.push({ field, value: val, reason: "원문 대조 실패" }); delete (mapped.fields as Record<string, unknown>)[field]; }
      continue;
    }
    const sk = FIELD_SOURCE[field];
    const sfv = sk ? sourceFields[sk] : undefined;
    const ev = mapped.evidence[field] ?? (sfv ? `${sfv.sourceLabel}: ${sfv.raw}` : "");
    const raw = sfv?.raw ?? (field === "requirements" ? sourceFields.requirements?.raw ?? "" : val);
    const found = !sourceSq || evidenceInSource(raw, sourceSq) || (field.startsWith("language") && evidenceInSource(val, sourceSq));
    if (!found && field !== "requirements") {
      dropped.push({ field, value: val, reason: "원문 대조 실패" });
      delete (mapped.fields as Record<string, unknown>)[field];
      mapped.warnings.push(`확인 필요 — ${field} 값 "${val.slice(0, 40)}"을(를) 원문에서 찾지 못해 입력하지 않았습니다.`);
      continue;
    }
    verification[field] = { value: val, status: sfv?.origin === "inferred" ? "inferred" : "verified", evidence: ev.slice(0, 200) };
  }

  // 예상 통역시간 — 원문에 시간 칸이 없고 시작·종료 시각이 모두 있으면 계산값을 넣는다(추정 표시)
  const MF = mapped.fields as Record<string, string | undefined>;
  if (!MF.interpretDuration && MF.scheduleFrom?.length === 16 && MF.scheduleTo?.length === 16 && MF.scheduleFrom.slice(0, 10) === MF.scheduleTo.slice(0, 10)) {
    const mins = (Date.parse(`${MF.scheduleTo}:00Z`) - Date.parse(`${MF.scheduleFrom}:00Z`)) / 60000;
    if (mins > 0 && mins <= 16 * 60) {
      const text = `${tr?.endApprox ? "약 " : ""}${Math.floor(mins / 60) ? `${Math.floor(mins / 60)}시간` : ""}${mins % 60 ? ` ${mins % 60}분` : ""}`.replace(/\s+/g, " ").trim();
      MF.interpretDuration = text;
      verification.interpretDuration = { value: text, status: "inferred", evidence: `시작 ${MF.scheduleFrom.slice(11)} ~ 종료 ${MF.scheduleTo.slice(11)}${tr?.endApprox ? "(예상)" : ""} 기준 계산` };
    }
  }

  // 핵심 항목별 신뢰도 — 원문 확인(high) / 문맥 추론(medium) / 없음(low)
  const fieldConfidence: AnalyzeOutput["fieldConfidence"] = {};
  const KEY_FIELDS: Record<string, string[]> = {
    customerCompanyName: ["customerCompanyName"], contactName: ["contactName"], schedule: ["scheduleFrom"],
    language: ["languageTo", "languageFrom"], place: ["place"], interpretType: ["interpretType"],
  };
  const isInterp = (mapped.fields.serviceTypes ?? [mapped.fields.serviceType]).includes("interpretation");
  for (const [k, fs] of Object.entries(KEY_FIELDS)) {
    if (!isInterp && ["schedule", "language", "place", "interpretType"].includes(k)) continue;
    const v = fs.map(f => verification[f]).filter(Boolean);
    const roleOk = k === "customerCompanyName" || k === "contactName" ? emailContext.customer?.status === "verified" : false;
    fieldConfidence[k] = !v.length ? "low"
      : v.every(x => x.status === "verified") || roleOk || v.every(x => evidenceInSource(sourceFields[FIELD_SOURCE[fs[0]]]?.raw ?? x.value, sourceSq)) ? "high" : "medium";
    if (k === "language" && !MF.languageFrom && MF.languageTo) fieldConfidence[k] = "medium";
  }

  // 원문 근거 없는 AI 추론을 버린 것은 정상 동작 — 판독 불일치·담당자 제외·원문 대조 실패만 신뢰도를 낮춘다
  const benign = (r: string) => r === "AI 추론값이 원문에 없음" || r.startsWith("회사명 라벨 값 우선") || r.startsWith("당사 직원 작성 메일");
  let confidence: AnalyzeOutput["confidence"] = readConflicts.length || dropped.some(d => !benign(d.reason))
    ? (structured ? "medium" : "low")
    : structured ? "high" : (matchedCount > 0 ? "medium" : "low");
  // 전체 신뢰도는 핵심 항목 상태를 반영 — 고객사가 없거나 고객사 후보가 충돌하면 high 로 두지 않는다
  if (confidence === "high" && (fieldConfidence.customerCompanyName === "low" || emailContext.warnings.length)) confidence = "medium";

  const trace: AnalyzeTrace = {
    classify: { pasted: rawOf(sfFromPasted), ocr: rawOf(sfFromOcr), vision: rawOf(sfFromVision), semantic: rawOf(sfSemantic), merged: rawOf(sourceFields) },
    dropped, readConflicts, mapped: { ...mapped.fields },
  };
  console.log(`[INQUIRY-AI] trace dropped=${JSON.stringify(dropped).slice(0, 400)} conflicts=${readConflicts.length} rejectedVision=${rejectedVisionRows.length}`);

  return {
    fields:      mapped.fields,
    equipment,
    confidence,
    warnings:    mapped.warnings,
    evidence:    mapped.evidence,
    sourceFields,
    additionalLanguagePairs,
    verification,
    trace,
    channelGuess,
    emailDates,
    receivedAtInfo,
    dateFields,
    emailContext,
    fieldConfidence,
    debug:       { structured, matchedCount, visionRows, rejectedVisionRows },
  };
}

/** 연도와 무관하게 월·일만 확인(연도 불명 후보 표시용) — "MM-DD" 또는 원문 */
function parseDateLoose(raw: string): string {
  const m = raw.match(/(\d{1,2})\s*[월./-]\s*(\d{1,2})/);
  return m ? `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : raw;
}

/** 회사명 후보가 원문에서 제3자(방문·심사·통역 대상, 현지 업체, 공장, 행사 주최사) 문맥으로만 등장하는지. */
const THIRD_PARTY_CONTEXT = /방문|심사|대상\s*업체|현지|공장|주최|참석\s*업체|업체\s*명|업체\s*[:：]|협력사|파트너사|host|organi[sz]er|factory|supplier|audit/i;
function isThirdPartyMention(company: string, sourceText: string): boolean {
  const c = squash(company);
  if (!c) return false;
  const lines = sourceText.split(/\r?\n/).filter(l => squash(l).includes(c));
  return lines.length > 0 && lines.every(l => THIRD_PARTY_CONTEXT.test(l));
}

/** 값(또는 그 근거)이 원문에 있는지 — 짧은 값은 포함 여부, 긴 서술은 어절 80% 이상 일치. */
function evidenceInSource(raw: string, sourceSq: string): boolean {
  const r = squash(raw);
  if (!r) return true;
  if (sourceSq.includes(r)) return true;
  const words = String(raw).split(/\s+/).map(squash).filter(w => w.length >= 2);
  if (words.length < 4) return false;
  return words.filter(w => sourceSq.includes(w)).length / words.length >= 0.8;
}
