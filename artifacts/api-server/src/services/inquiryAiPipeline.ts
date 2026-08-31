/**
 * inquiryAiPipeline — 의뢰건 AI 분석 오케스트레이션 (원문추출 → 필드매핑)
 *
 * 라우트(inquiryAiAnalyze.ts)와 오프라인 검증 하니스가 "동일한 실제 파이프라인"을 공유하도록 여기로 추출한다.
 * (라우트/스크립트에 로직을 중복 구현하면 "테스트는 통과하나 실제는 실패"하는 드리프트가 생긴다 → 방지)
 *
 * 단계:
 *   Stage 1(원문 → sourceFields):
 *     · 붙여넣은 텍스트 / OCR 텍스트 → 코드 파서(결정론적) 라벨-값 추출
 *     · 이미지 → vision 이 "라벨-값 행"만 공간적으로 읽고(예시/placeholder 제외, verbatim), 코드가 결정론적 키잉
 *     · 병합 우선순위(뒤가 우선): OCR텍스트 < 이미지 vision행 < 붙여넣은 텍스트
 *     · 라벨-값을 거의 못 찾은 비정형(이메일)만 semantic 추출로 보강 → 전부 "확인필요"
 *   Stage 2(sourceFields → VERITAS 폼): 코드가 결정론적으로 매핑(값 재해석 없음).
 */
import {
  extractSourceFieldsDeterministic,
  sourceFieldsFromLabelValueRows,
  mergeSourceFields,
  mapSourceFieldsToForm,
  INTERPRET_TYPES,
  type SourceFields,
  type SourceKey,
  type MappedFields,
} from "../lib/inquirySourceFields";

export type VisionImg = { type: "image_url"; image_url: { url: string; detail?: "high" | "low" | "auto" } };
export interface LabelValueRow { label: string; value: string; }
export interface AnalyzedEquipment { kind: string; quantity: string; unit: string; location: string; note: string; }

export interface AnalyzeOutput {
  fields:      Partial<MappedFields>;
  equipment:   AnalyzedEquipment[];
  confidence:  "high" | "medium" | "low";
  warnings:    string[];
  evidence:    Record<string, string>;
  sourceFields: SourceFields;
  debug:       { structured: boolean; matchedCount: number; visionRows: LabelValueRow[] };
}

const STRUCTURE_THRESHOLD = 3;

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
- label 은 양식에 인쇄된 라벨 문구 그대로 적는다(예: "회사명", "부서", "담당자", "직함", "전화번호", "휴대폰", "회사 E-mail", "출발언어", "도착언어", "통역의 형태", "1일 통역시간", "통역 일정", "통역 수행 장소", "통역할 주제", "요구 및 주의사항").

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
    "requirements", "documentType", "documentUsage", "volume", "desiredCompletionDate", "quoteDueDate", "channelHint", "serviceHint",
  ];

  const systemPrompt = `당신은 비정형 의뢰 텍스트(이메일/메신저)에서 "실제로 적혀 있는" 값만 뽑아내는 추출기입니다.
문장을 해석해 새 값을 만들지 말고, 텍스트에 등장한 표현을 그대로 raw 로 옮깁니다. 명시되지 않은 키는 생략합니다.
- raw: 원문에 나온 값 그대로(요약·번역·정정 금지). requirements 는 관련 문장 전체를 그대로 옮긴다.
- sourceLabel: 그 값을 유추한 근거 문구(짧게).
- 오늘은 ${kstTodayStr()}(KST). 상대 날짜가 있으면 raw 에는 원문 그대로 두고 해석하지 않는다.
- 언어/장소/통역형태를 서로 추론으로 바꾸지 않는다. 통역형태는 원문에 실제 언급된 경우에만: ${INTERPRET_TYPES.join(", ")}.
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
    if (!rv) continue;
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
  const systemPrompt = `전사된 의뢰서에서 통역장비/장비 항목만 행 단위로 추출합니다. 원문에 없는 장비를 지어내지 않습니다.
각 행: kind(장비명), quantity(수량 숫자만), unit(단위), location(사용장소), note(비고). 장비 언급이 없으면 빈 배열.`;
  const userMsg = `===== 원문 =====\n${params.text || "(없음)"}\n================\nJSON: { "equipment": [ { "kind": "", "quantity": "", "unit": "", "location": "", "note": "" } ] }`;
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
      kind: String(r?.kind ?? ""), quantity: String(r?.quantity ?? ""),
      unit: String(r?.unit ?? ""), location: String(r?.location ?? ""), note: String(r?.note ?? ""),
    })).filter(r => r.kind.trim());
  } catch { return []; }
}

/**
 * 전체 분석 오케스트레이션. 입력 준비(파일→OCR/vision)는 호출측이 담당하고, 여기서는 추출·병합·매핑만 한다.
 * OpenAI 키가 없으면 vision/semantic 없이 텍스트 기반 결정론 추출만 수행한다.
 */
export async function analyzeInquiry(params: {
  pastedText: string;
  ocrText: string;
  visionContents: VisionImg[];
  apiKey?: string;
  baseURL?: string;
}): Promise<AnalyzeOutput> {
  const { pastedText, ocrText, visionContents, apiKey, baseURL } = params;
  const hasImages = visionContents.length > 0;

  const sfFromPasted = extractSourceFieldsDeterministic(pastedText).sourceFields;
  const sfFromOcr    = extractSourceFieldsDeterministic(ocrText).sourceFields;

  let visionRows: LabelValueRow[] = [];
  let sfFromVision: SourceFields = {};
  if (hasImages && apiKey) {
    try {
      visionRows   = await visionExtractRows({ ocrText, visionContents, apiKey, baseURL });
      sfFromVision = sourceFieldsFromLabelValueRows(visionRows, "document");
    } catch (e) { console.error("[INQUIRY-AI] vision 행추출 실패:", e); }
  }

  let sourceFields = mergeSourceFields(sfFromOcr, sfFromVision, sfFromPasted);
  let matchedCount = Object.values(sourceFields).filter(f => f && f.raw.trim()).length;
  let structured = matchedCount >= STRUCTURE_THRESHOLD;

  if (!structured && apiKey) {
    const semanticSource = [pastedText, ocrText].filter(s => s && s.trim()).join("\n\n");
    if (semanticSource.trim()) {
      try {
        const ai = await aiSemanticExtractSourceFields({ text: semanticSource, apiKey, baseURL });
        sourceFields = mergeSourceFields(ai, sourceFields); // 결정론(document)이 추론(inferred)을 덮어씀
        matchedCount = Object.values(sourceFields).filter(f => f && f.raw.trim()).length;
        structured = matchedCount >= STRUCTURE_THRESHOLD;
      } catch (e) { console.error("[INQUIRY-AI] semantic 추출 실패:", e); }
    }
  }

  const channelDefault = (!hasImages && !!pastedText.trim() && !structured) ? "email" : "";
  const mapped = mapSourceFieldsToForm(sourceFields, channelDefault);

  const eqSource = [ocrText, pastedText, ...visionRows.map(r => `${r.label}: ${r.value}`)].join("\n");
  let equipment: AnalyzedEquipment[] = [];
  if (apiKey && /장비|수신기|송신기|부스|헤드셋|리시버|마이크|infoport|인포포트/i.test(eqSource)) {
    try { equipment = await aiExtractEquipment({ text: eqSource, apiKey, baseURL }); }
    catch (e) { console.error("[INQUIRY-AI] 장비 추출 실패:", e); }
  }

  const confidence: AnalyzeOutput["confidence"] = structured ? "high" : (matchedCount > 0 ? "medium" : "low");

  return {
    fields:      mapped.fields,
    equipment,
    confidence,
    warnings:    mapped.warnings,
    evidence:    mapped.evidence,
    sourceFields,
    debug:       { structured, matchedCount, visionRows },
  };
}
